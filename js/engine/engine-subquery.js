    // ============================================================================
    // [DatabaseEngine Subquery] - サブクエリ / ビュー展開 / UNION 処理
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      findInnerSubquery(sql) {
          let depth = 0, maxDepth = 0, startIdx = -1, endIdx = -1;
          for (let i = 0; i < sql.length; i++) {
              if (sql[i] === '(') {
                  depth++;
                  if (/^\(\s*SELECT\b/i.test(sql.slice(i)) && depth >= maxDepth) {
                      maxDepth = depth;
                      startIdx = i;
                      endIdx = -1; // Reset endIdx for sibling subqueries
                  }
              } else if (sql[i] === ')') {
                  if (startIdx !== -1 && depth === maxDepth && endIdx === -1) endIdx = i;
                  depth--;
              }
          }
          return (startIdx !== -1 && endIdx !== -1) ? { start: startIdx, end: endIdx, query: sql.slice(startIdx + 1, endIdx).trim() } : null;
      },

      // サブクエリ内で定義されていないテーブル修飾参照 (alias.col) を列挙する。
      // 戻り値: { refs: ['u.id', ...] }（相関サブクエリとして実行時評価する候補）
      //         { ambiguous: col }（非修飾の自己比較で評価不能なもの）
      _analyzeOuterRefs(subSql) {
          const keywords = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'on', 'as',
              'join', 'left', 'right', 'inner', 'cross', 'union', 'intersect', 'except',
              'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'is', 'null', 'true', 'false',
              'case', 'when', 'then', 'else', 'end', 'distinct', 'by', 'asc', 'desc', 'over', 'partition']);
          const defined = new Set();
          // FROM 直後のカンマ区切り（暗黙の直積結合）も定義済みテーブルとして扱う
          const fromRe = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?((?:\s*,\s*[a-zA-Z0-9_]+(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?)*)/gi;
          let m;
          while ((m = fromRe.exec(subSql))) {
              defined.add(m[1].toLowerCase());
              if (m[2] && !keywords.has(m[2].toLowerCase())) defined.add(m[2].toLowerCase());
              if (m[3]) {
                  m[3].split(',').forEach(part => {
                      const pm = part.trim().match(/^([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?$/);
                      if (pm) {
                          defined.add(pm[1].toLowerCase());
                          if (pm[2] && !keywords.has(pm[2].toLowerCase())) defined.add(pm[2].toLowerCase());
                      }
                  });
              }
          }
          const refs = new Set();
          const qualRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
          while ((m = qualRe.exec(subSql))) {
              if (!defined.has(m[1].toLowerCase())) refs.add((m[1] + '.' + m[2]).toLowerCase());
          }
          // 非修飾の同一識別子同士の比較 (col = col) は、外側の同名列を参照する意図の
          // 相関サブクエリか常に真のトートロジーのどちらかであり、正しく評価できないため拒否する
          const selfCmp = subSql.match(/(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<=|>=|<>|!=|=|<|>)\s*\1(?![\w.(])/);
          if (selfCmp && !keywords.has(selfCmp[1].toLowerCase()) && !selfCmp[1].startsWith('__')) return { ambiguous: selfCmp[1] };
          return { refs: [...refs] };
      },

      // 相関サブクエリを実行時評価用トークンへ置き換える（expandSubqueries から呼ばれる）。
      // 外側参照 (alias.col) を __OREF_i__ マーカーへ差し替えた SQL をレジストリへ登録し、
      // 文脈（EXISTS / IN / スカラ）に応じたトークン文字列を返す。FROM/JOIN 直後は非対応。
      _registerCorrelatedSub(subSql, refs, strMap, beforeStr) {
          if (/__CORR(?:EX|SC|IN)_\d+__|__OREF_\d+__/.test(subSql)) {
              throw new Error("Nested correlated subqueries are not supported.");
          }
          const trimmed = beforeStr.trim();
          if (/\bFROM\s*$/i.test(trimmed) || /\bJOIN\s*$/i.test(trimmed)) {
              throw new Error("Correlated subqueries are not supported in FROM/JOIN.");
          }
          let sql = subSql;
          refs.forEach((ref, i) => {
              const [a, c] = ref.split('.');
              sql = sql.replace(new RegExp(`\\b${a}\\s*\\.\\s*${c}\\b`, 'gi'), `__OREF_${i}__`);
          });
          if (!this._corrSubs) this._corrSubs = [];
          const k = this._corrSubs.push({ sql, refs, strMap, cache: new Map(), litCache: new Map() }) - 1;
          if (/\bEXISTS\s*$/i.test(trimmed)) return { token: `__CORREX_${k}__`, consumeExists: true };
          if (/\bIN\s*$/i.test(trimmed)) return { token: `__CORRIN_${k}__`, consumeExists: false };
          return { token: `__CORRSC_${k}__`, consumeExists: false };
      },

      // FROM / JOIN の直後の括弧の中が「枝を括弧で包んだ集合演算」
      // （FROM ((SELECT ...) UNION (SELECT ...)) t）なら、枝の括弧を外して
      // 素の形へ均す。均さないと内側の (SELECT ...) が先に見つかって
      // スカラーサブクエリとして畳まれ、「1 行より多い」と誤ったエラーになる
      _flattenDerivedSetOps(sql) {
          if (sql.indexOf('(') === -1) return sql;
          let out = sql;
          for (let guard = 0; guard < 20; guard++) {
              let changed = false;
              const re = /\b(?:from|join)\s*\(/gi;
              let m;
              while ((m = re.exec(out)) !== null) {
                  const openAt = m.index + m[0].length - 1;
                  const close = this._scanBalanced(out, openAt);
                  if (close === -1) break;
                  const inner = out.slice(openAt + 1, close).trim();
                  if (!/^\(\s*(?:select|with)\b/i.test(inner)) continue;
                  const segs = this._splitUnion(inner);
                  if (segs.length < 2) continue;
                  const flat = segs.map((s, i) => (i === 0 ? '' : s.op + ' ') + s.sql).join(' ').trim();
                  if (flat === inner) continue;
                  out = out.slice(0, openAt + 1) + flat + out.slice(close);
                  changed = true;
                  break;
              }
              if (!changed) break;
          }
          return out;
      },

      expandSubqueries(sql, strMap) {
          let expandedSql = this._flattenDerivedSetOps(sql);
          let expansions = 0;
          while(true) {
              let match = this.findInnerSubquery(expandedSql);
              if (!match) break;

              // DoSガード: 1文あたりのサブクエリ展開回数を制限する
              if (++expansions > 100) {
                  throw new Error("Too many subqueries in one statement (max 100).");
              }

              const analysis = this._analyzeOuterRefs(match.query);
              if (analysis.ambiguous) {
                  throw new Error(`Correlated subqueries with unqualified self-comparison are not supported (ambiguous column '${analysis.ambiguous}'). Qualify the outer column with its table name.`);
              }
              if (analysis.refs.length > 0) {
                  // 相関サブクエリ: 定数へ畳み込まず、外側の行ごとに評価するトークンへ置換する
                  const before2 = expandedSql.slice(0, match.start);
                  const reg = this._registerCorrelatedSub(match.query, analysis.refs, strMap, before2);
                  const newBefore = reg.consumeExists ? before2.replace(/EXISTS\s*$/i, '') : before2;
                  expandedSql = newBefore + ` ${reg.token} ` + expandedSql.slice(match.end + 1);
                  continue;
              }

              // サブクエリ本文の表関数（SELECT 句の集合返し関数を含む）を先に展開する。
              // executeQuery は isSubquery のとき expandTableFunctions を通さないため、
              // ここで通さないと派生表の中の UNNEST(...) が解決できない
              let subResult = this.executeQuery(this.expandTableFunctions(match.query, strMap), true, strMap);
              if(subResult.error) throw new Error(subResult.error);

              const beforeStr = expandedSql.slice(0, match.start);
              if (/\bEXISTS\s*$/i.test(beforeStr.trim())) {
                  // EXISTS / NOT EXISTS: サブクエリの結果有無を真偽値リテラルへ畳み込む
                  const boolStr = subResult.data.length > 0 ? 'TRUE' : 'FALSE';
                  const newBefore = beforeStr.replace(/EXISTS\s*$/i, '');
                  expandedSql = newBefore + boolStr + expandedSql.slice(match.end + 1);
              } else if (/\bNOT\s+IN\s*$/i.test(beforeStr.trim()) || /\bIN\s*$/i.test(beforeStr.trim())
                         || /\b(?:ANY|SOME|ALL)\s*$/i.test(beforeStr.trim())) {
                  // IN / NOT IN / 量化比較 (= ANY, > ALL, ...): 結果1列目を値リストへ畳み込む。
                  // 量化比較の展開（OR/AND への分配）は compileCondition が担う。
                  // 文字列値はエスケープした上で strMap へ退避する
                  // （生のまま埋め込むとデータ中の引用符がJSソースを汚染し得るため）
                  const lit = (v) => {
                      if (typeof v === 'string') {
                          strMap.push(this._quoteLiteral(v));
                          return `__STR_${strMap.length - 1}__`;
                      }
                      // NULL は必ず 'NULL' という綴りへ落とす。素の null を返すと
                      // Array#join が空文字へ変えてしまい、値リストから NULL が
                      // 「消える」＝`x NOT IN (SELECT ...)` が SQL 標準と違って行を返す
                      // （リテラルの `NOT IN (2, NULL)` は正しく空を返していたので
                      //   サブクエリ形だけが黙って誤っていた）
                      if (v === null || v === undefined) return 'NULL';
                      return v;
                  };
                  // 左辺が行コンストラクタ `(a, b) IN (SELECT a, b FROM ...)` の場合は
                  // 全列を括弧付きの値グループへ畳む（compileCondition の
                  // _rewriteRowConstructors が「括弧付きグループ」を要求するため）
                  const arity = this._rowCtorArityBefore(beforeStr);
                  let valsStr;
                  if (arity > 1) {
                      valsStr = subResult.data.map(r => {
                          const cells = Object.values(r);
                          if (cells.length !== arity) {
                              throw new Error(`Row constructor IN requires equal arity (${arity} vs ${cells.length}).`);
                          }
                          return '(' + cells.map(lit).join(', ') + ')';
                      }).join(', ');
                  } else {
                      // 単一オペランドの IN / 量化比較に 2 列以上返すサブクエリを渡すのは
                      // 誤り。従来は 1 列目だけを使って残りを黙って捨てていた
                      const ncols = subResult.data.length > 0 ? Object.keys(subResult.data[0]).length : 1;
                      if (ncols !== 1) {
                          throw new Error(`Operand should contain 1 column(s), but the subquery returns ${ncols}.`);
                      }
                      valsStr = subResult.data.map(r => lit(Object.values(r)[0])).join(', ');
                  }
                  expandedSql = expandedSql.slice(0, match.start) + `(${valsStr})` + expandedSql.slice(match.end + 1);
              } else if (/\bFROM\s*$/i.test(beforeStr.trim()) || /\bJOIN\s*$/i.test(beforeStr.trim())) {
                  const tmpName = '__tmp_' + Math.floor(Math.random()*1000000);
                  // 派生表の列リスト: FROM (SELECT ...) [AS] t(a, b) — 列名を位置で差し替える
                  let after = expandedSql.slice(match.end + 1);
                  let colNames = null;
                  const alM = after.match(/^\s*(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\)/i);
                  if (alM) {
                      colNames = alM[2].split(',').map(c => c.trim().toLowerCase());
                      after = ` ${alM[1]}` + after.slice(alM[0].length);
                  }
                  // 0 件でも列だけは作る（列が消えると外側から参照できなくなる）
                  this._materializeRows(tmpName, subResult.data, colNames || subResult.columns || null);
                  expandedSql = expandedSql.slice(0, match.start) + tmpName + after;
              } else {
                  // スカラーサブクエリ: 2 行以上返したら黙って先頭行を使うのではなくエラーにする。
                  // 実DB（MySQL 1242 / PostgreSQL / SQL Server）はいずれもエラーで、
                  // 「先頭行を採用」は書き手が気づけない誤答になる
                  if (subResult.data.length > 1) {
                      throw new Error(`Subquery returned more than 1 row (${subResult.data.length} rows). A scalar subquery must return at most one row — add a WHERE, LIMIT 1, or an aggregate.`);
                  }
                  const scols = subResult.data.length > 0 ? Object.keys(subResult.data[0]).length : 1;
                  if (scols !== 1) {
                      throw new Error(`Operand should contain 1 column(s), but the subquery returns ${scols}.`);
                  }
                  let val = subResult.data.length > 0 ? Object.values(subResult.data[0])[0] : null;
                  if (typeof val === 'string') {
                      strMap.push(this._quoteLiteral(val));
                      val = `__STR_${strMap.length - 1}__`;
                  }
                  expandedSql = expandedSql.slice(0, match.start) + val + expandedSql.slice(match.end + 1);
              }
          }
          return expandedSql;
      },

      // `IN` の直前が行コンストラクタ `(a, b)` かどうかを見て、その要素数を返す。
      // 行コンストラクタでなければ 1（通常の単一列 IN）。関数呼び出し `f(x, y) IN (...)` は
      // 直前が識別子なので行コンストラクタとは見なさない
      _rowCtorArityBefore(beforeStr) {
          const head = beforeStr.replace(/\s*(?:NOT\s+)?IN\s*$/i, '').replace(/\s+$/, '');
          if (head[head.length - 1] !== ')') return 1;
          let d = 0, j = head.length - 1;
          for (; j >= 0; j--) {
              if (head[j] === ')') d++;
              else if (head[j] === '(') { d--; if (d === 0) break; }
          }
          if (j < 0) return 1;
          if (j > 0 && /[a-zA-Z0-9_.\]]/.test(head[j - 1])) return 1;
          const items = this.splitSelectClause(head.slice(j + 1, head.length - 1));
          return items.length >= 2 ? items.length : 1;
      },

      // 行オブジェクト配列を一時テーブルとして実体化する（CTE / FROMサブクエリ / 再帰CTE 共用）。
      // colNames 指定時は列名を位置ベースで差し替える（WITH t(a, b) AS ... の列リスト）
      _materializeRows(name, rows, colNames) {
          const t = new Table();
          if (rows && rows.length > 0) {
              const srcKeys = Object.keys(rows[0]);
              if (colNames && colNames.length !== srcKeys.length) {
                  throw new Error(`CTE column list has ${colNames.length} names but the query returns ${srcKeys.length} columns.`);
              }
              const keys = colNames || srcKeys;
              keys.forEach(k => t.addColumn(k));
              while (t.capacity < rows.length) t.grow();
              rows.forEach((row, i) => srcKeys.forEach((sk, j) => t.setValue(keys[j], i, row[sk])));
              t.rowCount = rows.length;
          } else if (colNames) {
              // 空の結果でも列リストがあれば列だけ定義する（後続クエリの列解決を可能にする）
              colNames.forEach(k => t.addColumn(k));
          }
          this.tables[name] = t;
          return t;
      },

      // テーブル関数 GENERATE_SERIES(start, stop [, step]) を一時テーブルへ実体化して
      // FROM/JOIN 句のテーブル名に置換する。列名は 'value'（AS t(n) の列リストで変更可）。
      // expandSubqueries より前に呼ぶ（サブクエリ引数は非対応、定数式のみ）
      // FROM (VALUES (...), (...)) [AS] alias [(c1, c2, ...)] — 表値コンストラクタを
      // 派生表として使う形（SQL標準 / PostgreSQL / SQL Server）。
      // findInnerSubquery は '(SELECT' しか拾わないため、専用の前処理として実体化する。
      expandValuesTables(sql, strMap) {
          if (!/\(\s*values\b/i.test(sql)) return sql;
          for (let guard = 0; guard < 32; guard++) {
              const m = sql.match(/\b(FROM|JOIN)\s+\(\s*VALUES\b/i);
              if (!m) break;
              const open = sql.indexOf('(', m.index + m[1].length);
              const close = this._scanBalanced(sql, open);
              if (close === -1) throw new Error("Syntax Error: unbalanced parentheses in FROM (VALUES ...).");
              const res = this._executeValuesStatement(sql.slice(open + 1, close).trim(), strMap);
              let after = sql.slice(close + 1);
              let alias = null, colNames = null;
              const alM = after.match(/^\s*(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\))?/i);
              if (alM) {
                  alias = alM[1];
                  if (alM[2]) colNames = alM[2].split(',').map(c => c.trim().toLowerCase());
                  after = after.slice(alM[0].length);
              }
              const tmpName = '__tmp_values_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, res.data, colNames);
              sql = sql.slice(0, m.index) + `${m[1]} ${tmpName}${alias ? ' ' + alias : ''}` + after;
          }
          return sql;
      },

      // FROM JSON_TABLE(<json>, '<row path>' COLUMNS (col TYPE PATH '<path>', ...)) [AS] alias
      // JSON 配列を行へ展開する（MySQL 8 / Oracle）。ブラウザDBでは API 応答をそのまま
      // 表として扱えると便利なので、行パスは '$' と '$[*]' に対応する。
      _expandJsonTable(sql, strMap) {
          if (!/\bjson_table\s*\(/i.test(sql)) return sql;
          for (let guard = 0; guard < 16; guard++) {
              const m = sql.match(/\b(FROM|JOIN)\s+JSON_TABLE\s*\(/i);
              if (!m) break;
              const open = sql.indexOf('(', m.index + m[1].length);
              const close = this._scanBalanced(sql, open);
              if (close === -1) throw new Error("Syntax Error in JSON_TABLE: unbalanced parentheses.");
              const inner = sql.slice(open + 1, close);
              const colsAt = inner.search(/\bCOLUMNS\s*\(/i);
              if (colsAt === -1) throw new Error("Syntax Error in JSON_TABLE. Use JSON_TABLE(json, '$[*]' COLUMNS (col TYPE PATH '$.x', ...)).");
              const head = this.splitSelectClause(inner.slice(0, colsAt)).map(x => x.trim()).filter(x => x !== '');
              if (head.length !== 2) throw new Error("JSON_TABLE requires a JSON document and a row path.");
              const colOpen = inner.indexOf('(', colsAt);
              const colClose = this._scanBalanced(inner, colOpen);
              if (colClose === -1) throw new Error("Syntax Error in JSON_TABLE COLUMNS list.");
              const specs = this.splitSelectClause(inner.slice(colOpen + 1, colClose)).map(part => {
                  const cm = part.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z][a-zA-Z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)?\s*(?:PATH\s+(__STR_\d+__|'[^']*'))?$/i);
                  if (!cm) throw new Error(`Invalid JSON_TABLE column definition '${part.trim()}'.`);
                  const pathTok = cm[3];
                  const path = pathTok ? (/^__STR_/.test(pathTok) ? this._unquoteLiteral(strMap[Number(pathTok.match(/\d+/)[0])]) : pathTok.slice(1, -1)) : ('$.' + cm[1]);
                  return { name: cm[1].toLowerCase(), type: (cm[2] || 'TEXT').toUpperCase().replace(/\s*\(.*$/, ''), path };
              });
              if (specs.length === 0) throw new Error("JSON_TABLE requires at least one column.");
              const jsonVal = this.compileCondition(head[0], strMap)({}, this.tables, {});
              const rowPath = (this.compileCondition(head[1], strMap)({}, this.tables, {}) || '$');
              let doc;
              try { doc = jsonVal == null ? null : (typeof jsonVal === 'string' ? JSON.parse(jsonVal) : jsonVal); }
              catch (e) { throw new Error("JSON_TABLE: the first argument is not valid JSON."); }
              const rp = String(rowPath).replace(/\s+/g, '');
              let items;
              if (rp === '$' ) items = (doc === null ? [] : [doc]);
              else if (rp === '$[*]') items = Array.isArray(doc) ? doc : (doc === null ? [] : [doc]);
              else {
                  const km = rp.match(/^\$\.([a-zA-Z_][a-zA-Z0-9_]*)(\[\*\])?$/);
                  if (!km) throw new Error(`Unsupported JSON_TABLE row path '${rowPath}'. Use '$', '$[*]' or '$.key[*]'.`);
                  const sub = (doc && typeof doc === 'object') ? doc[km[1]] : undefined;
                  items = km[2] ? (Array.isArray(sub) ? sub : []) : (sub === undefined ? [] : [sub]);
              }
              const pick = (obj, path) => {
                  const p = String(path).replace(/\s+/g, '');
                  if (p === '$') return obj;
                  const parts = p.replace(/^\$/, '').match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\]/g) || [];
                  let cur = obj;
                  for (const seg of parts) {
                      if (cur === null || typeof cur !== 'object') return null;
                      cur = seg[0] === '[' ? cur[Number(seg.slice(1, -1))] : cur[seg.slice(1)];
                      if (cur === undefined) return null;
                  }
                  return cur === undefined ? null : cur;
              };
              const coerce = (v, t) => {
                  if (v === null || v === undefined) return null;
                  if (typeof v === 'object') return JSON.stringify(v);
                  if (/INT/.test(t)) { const n = Math.trunc(Number(v)); return isNaN(n) ? null : n; }
                  if (/DEC|NUM|FLOAT|DOUBLE|REAL/.test(t)) { const n = Number(v); return isNaN(n) ? null : n; }
                  if (/BOOL/.test(t)) return v === true || v === 1 || String(v).toLowerCase() === 'true';
                  return typeof v === 'string' ? v : String(v);
              };
              const rows = items.map(it => {
                  const o = {};
                  specs.forEach(sp => { o[sp.name] = coerce(pick(it, sp.path), sp.type); });
                  return o;
              });
              let after = sql.slice(close + 1);
              let alias = null;
              const alM = after.match(/^\s*(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
              if (alM && !/^(where|group|order|having|limit|offset|join|inner|left|right|full|cross|union|on|qualify|window|fetch)$/i.test(alM[1])) {
                  alias = alM[1];
                  after = after.slice(alM[0].length);
              }
              const tmpName = '__tmp_jt_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, specs.map(sp => sp.name));
              sql = sql.slice(0, m.index) + `${m[1]} ${tmpName}${alias ? ' ' + alias : ''}` + after;
          }
          return sql;
      },

      // FROM <table> TABLESAMPLE [BERNOULLI|SYSTEM] (n [PERCENT]) [REPEATABLE (seed)]
      // 大きな表の概算集計を高速に取るための行サンプリング（SQL標準 / PostgreSQL）
      _expandTableSample(sql, strMap) {
          if (!/\btablesample\b/i.test(sql)) return sql;
          for (let guard = 0; guard < 16; guard++) {
              // 表名は FROM / JOIN の直後に限定する（先頭の 'FROM' 自体を表名と取り違えないため）
              const m = sql.match(/\b(FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?(?!TABLESAMPLE\b)([a-zA-Z0-9_]+))?\s+TABLESAMPLE\s+(?:(BERNOULLI|SYSTEM)\s*)?\(\s*(\d+(?:\.\d+)?)\s*(PERCENT|ROWS)?\s*\)(?:\s*REPEATABLE\s*\(\s*(-?\d+(?:\.\d+)?)\s*\))?/i);
              if (!m) break;
              const kw = m[1];
              const src = m[2].toLowerCase();
              const alias = m[3] || m[2];
              const t = this.tables[src];
              if (!t) throw this._tableNotFound(src);
              const amount = Number(m[5]);
              const byRows = (m[6] || 'PERCENT').toUpperCase() === 'ROWS';
              if (!byRows && (amount < 0 || amount > 100)) throw new Error("TABLESAMPLE percentage must be between 0 and 100.");
              // REPEATABLE(seed) 指定時は決定的（Lehmer MINSTD）に選ぶ
              let seed = m[7] !== undefined ? (Math.abs(Math.trunc(Number(m[7]))) % 2147483646) + 1 : null;
              const rnd = () => { if (seed === null) return Math.random(); seed = (seed * 48271) % 2147483647; return (seed - 1) / 2147483646; };
              const want = byRows ? Math.min(t.rowCount, Math.trunc(amount)) : null;
              const cols = t.getColumnNames();
              const rows = [];
              for (let i = 0; i < t.rowCount; i++) {
                  if (byRows) {
                      // 残り行から必要数を選ぶ（各行の採択確率を均一に保つ）
                      const remaining = t.rowCount - i;
                      if (rows.length >= want) break;
                      if (rnd() >= (want - rows.length) / remaining) continue;
                  } else if (rnd() * 100 >= amount) continue;
                  const o = {};
                  cols.forEach(c => { o[c] = t.getValue(c, i); });
                  rows.push(o);
              }
              const tmpName = '__tmp_sample_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, cols);
              sql = sql.slice(0, m.index) + `${kw} ${tmpName} ${alias}` + sql.slice(m.index + m[0].length);
          }
          return sql;
      },

      // SELECT 句に書かれた集合返し関数（PostgreSQL の `SELECT UNNEST(arr)`）を
      // FROM 句の表関数へ書き換える。`SELECT UNNEST(ARRAY[1,2,3]) AS v` は
      // `SELECT __srf_1.v AS v FROM UNNEST(ARRAY[1,2,3]) AS __srf_1(v)` と同義。
      // FROM 句が既にある場合は行数が掛け合わさるため、FROM の無い形だけを受ける
      // （実DBの LATERAL 相当までは踏み込まない — その旨をエラーで案内する）
      _expandSelectListSRF(sql, strMap) {
          if (!/^\s*select\b/i.test(sql)) return sql;
          if (!/\b(unnest|string_split|generate_series)\s*\(/i.test(sql)) return sql;
          const fromAt = this._topLevelKeyword(sql, 'from');
          const selEnd = fromAt === -1 ? sql.length : fromAt;
          const head = sql.slice(0, selEnd);
          const srfRe = /\b(UNNEST|STRING_SPLIT|GENERATE_SERIES)\s*\(/i;
          if (!srfRe.test(head)) return sql;
          if (fromAt !== -1) {
              throw new Error("Set-returning functions in the SELECT list are only supported without a FROM clause. Use `FROM UNNEST(...) AS t(v)` instead.");
          }
          const items = this.splitSelectClause(head.replace(/^\s*select\s+/i, ''));
          if (items.length !== 1) {
              throw new Error("A set-returning function in the SELECT list must be the only select item. Use `FROM UNNEST(...) AS t(v)` instead.");
          }
          const item = items[0].trim();
          const m = item.match(/^(UNNEST|STRING_SPLIT|GENERATE_SERIES)\s*\(([\s\S]*)\)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?$/i);
          if (!m) {
              throw new Error("A set-returning function in the SELECT list must be the whole select item (optionally with an alias).");
          }
          const outName = (m[3] || 'value').toLowerCase();
          return `SELECT ${outName} FROM ${m[1]}(${m[2]}) AS __srf(${outName})`;
      },

      // ============================================================================
      // Oracle の階層問い合わせ (START WITH ... CONNECT BY PRIOR)
      //   親から子へ辿った結果を一時テーブルへ実体化し、通常の SELECT へ差し替える。
      //   擬似列 LEVEL / CONNECT_BY_ISLEAF / CONNECT_BY_ROOT col /
      //   SYS_CONNECT_BY_PATH(col, sep) を列として付ける。
      //   ORDER SIBLINGS BY は同じ親の子どもの並び順を決める。
      // 対応する結合条件は「PRIOR <列> = <列>」（左右どちらでも可）を 1 本含む形。
      // それ以外の AND 条件は候補行だけで評価できるフィルタとして扱う。
      // ============================================================================
      _expandConnectBy(sql, strMap) {
          if (!/\bconnect\s+by\b/i.test(sql)) return sql;
          const m = sql.match(/^\s*select\s+([\s\S]+?)\s+from\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?([\s\S]*)$/i);
          if (!m) throw new Error("CONNECT BY requires a simple SELECT ... FROM <table> query.");
          const selectClause = m[1];
          const table = m[2].toLowerCase();
          // START / CONNECT も句の始まりなので表の別名として拾わない
          const isHead = (w) => this._isClauseKeyword(w) || /^(start|connect)$/i.test(w);
          const rawAlias = m[3] && !isHead(m[3]) ? m[3].toLowerCase() : null;
          let rest = (m[3] && isHead(m[3]) ? m[3] + ' ' : '') + (m[4] || '');
          if (!this.tables[table]) throw this._tableNotFound(table);

          // WHERE / START WITH / CONNECT BY / ORDER [SIBLINGS] BY を切り出す
          const takeClause = (re) => {
            const mm = rest.match(re);
            if (!mm) return null;
            rest = rest.slice(0, mm.index) + ' ' + rest.slice(mm.index + mm[0].length);
            return mm[1].trim();
          };
          const TERM = '(?=\\s+(?:where|start\\s+with|connect\\s+by|group\\s+by|having|order\\s+(?:siblings\\s+)?by|limit|offset)\\b|\\s*$)';
          const cbCond = takeClause(new RegExp('\\bconnect\\s+by\\s+(?:nocycle\\s+)?([\\s\\S]+?)' + TERM, 'i'));
          const startCond = takeClause(new RegExp('\\bstart\\s+with\\s+([\\s\\S]+?)' + TERM, 'i'));
          const siblingsBy = takeClause(new RegExp('\\border\\s+siblings\\s+by\\s+([\\s\\S]+?)' + TERM, 'i'));
          const whereCond = takeClause(new RegExp('\\bwhere\\s+([\\s\\S]+?)' + TERM, 'i'));
          const nocycle = /\bconnect\s+by\s+nocycle\b/i.test(sql);
          if (!cbCond) throw new Error("Syntax Error in CONNECT BY.");

          // 「PRIOR <列> = <列>」を 1 本取り出し、残りは候補行だけで判定できるフィルタにする
          const parts = this._splitTopLevelAnd(cbCond).map(p => p.replace(/^\((.*)\)$/s, '$1'));
          let priorCol = null, childCol = null;
          const extra = [];
          parts.forEach(p => {
              const eq = p.match(/^\s*(?:prior\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*(?:prior\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)\s*$/i);
              const leftPrior = /^\s*prior\b/i.test(p);
              const rightPrior = /=\s*prior\b/i.test(p);
              if (eq && (leftPrior !== rightPrior) && !priorCol) {
                  const strip = (c) => c.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase();
                  priorCol = strip(leftPrior ? eq[1] : eq[2]);
                  childCol = strip(leftPrior ? eq[2] : eq[1]);
                  return;
              }
              if (/\bprior\b/i.test(p)) {
                  throw new Error("CONNECT BY supports one 'PRIOR <col> = <col>' link; other PRIOR expressions are not supported.");
              }
              extra.push(p);
          });
          if (!priorCol) throw new Error("CONNECT BY requires a 'PRIOR <col> = <col>' link.");

          const t = this.tables[table];
          const cols = t.getColumnNames();
          if (!t.cols[priorCol] || !t.cols[childCol]) {
              throw new Error(`CONNECT BY references unknown column '${t.cols[priorCol] ? childCol : priorCol}'.`);
          }
          const baseRows = [];
          for (let i = 0; i < t.rowCount; i++) {
              const row = {};
              cols.forEach(c => row[c] = t.getValue(c, i));
              baseRows.push(row);
          }
          // 行だけで評価できる条件を 1 つの関数へまとめる（WHERE / START WITH / 追加の CONNECT BY 条件）
          // 条件テキストからは表名・別名の修飾子を落としてから評価する
          const unqualify = (text) => {
              let x = String(text);
              if (rawAlias) x = x.replace(new RegExp('\\b' + rawAlias + '\\.', 'gi'), '');
              return x.replace(new RegExp('\\b' + table + '\\.', 'gi'), '');
          };
          const rowPred = (text) => {
              if (!text) return null;
              const fn = this.compileCondition(unqualify(text).replace(/\bprior\s+/gi, ''), strMap);
              const dummyCols = {};
              cols.forEach(c => dummyCols[c] = true);
              return (row) => {
                  try {
                      return !!fn({ dummy: 0 }, { dummy: { cols: dummyCols, getValue: (c) => {
                          const k = c.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase();
                          return row[k] === undefined ? null : row[k];
                      } } }, { dummy: 'dummy' });
                  } catch (e) { return false; }
              };
          };
          const startFn = rowPred(startCond);
          const extraFn = extra.length > 0 ? rowPred(extra.join(' AND ')) : null;
          const whereFn = rowPred(whereCond);

          // 親の値 -> 子行の索引（O(n) の辿り）
          const byChildKey = Object.create(null);
          baseRows.forEach(r => {
              const k = r[childCol];
              if (k === null || k === undefined) return;
              const key = String(k);
              (byChildKey[key] = byChildKey[key] || []).push(r);
          });

          // 兄弟の並び順（ORDER SIBLINGS BY col [ASC|DESC], ...）
          const sibKeys = siblingsBy ? this.splitSelectClause(siblingsBy).map(x => {
              const d = x.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(?:\s+(asc|desc))?$/i);
              if (!d) throw new Error("ORDER SIBLINGS BY accepts plain column names only.");
              return { col: d[1].replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase(), desc: /^desc$/i.test(d[2] || '') };
          }) : null;
          const sortSibs = (arr) => {
              if (!sibKeys) return arr;
              return arr.slice().sort((a, b) => {
                  for (const k of sibKeys) {
                      const x = a[k.col], y = b[k.col];
                      if (x === y) continue;
                      if (x === null || x === undefined) return k.desc ? 1 : -1;
                      if (y === null || y === undefined) return k.desc ? -1 : 1;
                      return (x < y) === !k.desc ? -1 : 1;
                  }
                  return 0;
              });
          };

          // SELECT 句が要求する擬似列を先に洗い出す
          const rootCols = [];
          selectClause.replace(/\bconnect_by_root\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi, (mm, c) => {
              const k = c.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase();
              if (!rootCols.includes(k)) rootCols.push(k);
              return mm;
          });
          const pathSpecs = [];
          selectClause.replace(/\bsys_connect_by_path\s*\(([^()]*)\)/gi, (mm, args) => {
              const a = this.splitSelectClause(args).map(x => x.trim());
              pathSpecs.push({ text: mm, col: (a[0] || '').replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase(), sep: a[1] || "'/'" });
              return mm;
          });
          const pathSep = (spec) => {
              const lit = this._restoreStrings(spec.sep, strMap || []);
              const q = lit.match(/^'([\s\S]*)'$/);
              return q ? q[1].replace(/''/g, "'") : lit;
          };

          // 幅優先ではなく深さ優先（Oracle の既定の並び）で辿る
          const out = [];
          const GUARD = 200000;
          const walk = (row, level, ancestors, rootRow, path) => {
              if (out.length > GUARD) throw new Error("CONNECT BY produced too many rows (possible cycle). Use CONNECT BY NOCYCLE.");
              const selfKey = row[priorCol] === null || row[priorCol] === undefined ? null : String(row[priorCol]);
              let kids = selfKey === null ? [] : (byChildKey[selfKey] || []);
              if (extraFn) kids = kids.filter(extraFn);
              // 循環検出: 既に経路上にある行へ戻ったら打ち切る（NOCYCLE 無しはエラー）
              const cyclic = kids.filter(k => ancestors.has(k));
              if (cyclic.length > 0 && !nocycle) {
                  throw new Error("CONNECT BY detected a loop in the data. Use CONNECT BY NOCYCLE.");
              }
              kids = sortSibs(kids.filter(k => !ancestors.has(k)));
              const rec = { ...row, level, connect_by_isleaf: kids.length === 0 ? 1 : 0 };
              rootCols.forEach(c => rec['__cbroot_' + c] = rootRow[c]);
              pathSpecs.forEach((sp, i) => {
                  rec['__cbpath_' + i] = path[i] + pathSep(sp) + (row[sp.col] === null || row[sp.col] === undefined ? '' : String(row[sp.col]));
              });
              out.push(rec);
              const nextAnc = new Set(ancestors);
              nextAnc.add(row);
              kids.forEach(k => walk(k, level + 1, nextAnc, rootRow,
                  pathSpecs.map((sp, i) => rec['__cbpath_' + i])));
          };
          let roots = startFn ? baseRows.filter(startFn) : baseRows.slice();
          roots = sortSibs(roots);
          roots.forEach(r => walk(r, 1, new Set(), r, pathSpecs.map(() => '')));

          // WHERE は階層を辿った後に適用する（Oracle と同じ順序）
          const finalRows = whereFn ? out.filter(whereFn) : out;
          const outCols = cols.concat(['level', 'connect_by_isleaf'],
              rootCols.map(c => '__cbroot_' + c), pathSpecs.map((sp, i) => '__cbpath_' + i));
          const tmpName = '__tmp_hier_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
          this._materializeRows(tmpName, finalRows.map(r => {
              const o = {};
              outCols.forEach(c => o[c] = r[c] === undefined ? null : r[c]);
              return o;
          }), outCols);

          // SELECT 句の擬似列参照を実体化した列名へ差し替える
          let sel = selectClause;
          pathSpecs.forEach((sp, i) => { sel = sel.split(sp.text).join('__cbpath_' + i); });
          sel = sel.replace(/\bconnect_by_root\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi,
              (mm, c) => '__cbroot_' + c.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase());
          if (rawAlias) sel = sel.replace(new RegExp('\\b' + rawAlias + '\\.', 'gi'), '');
          sel = sel.replace(new RegExp('\\b' + table + '\\.', 'gi'), '');
          return `SELECT ${sel} FROM ${tmpName}${rest.replace(/\s+/g, ' ').trimEnd()}`;
      },

      // AND で区切られたトップレベルの条件へ分割する（括弧の内側は保護する）
      _splitTopLevelAnd(text) {
          const out = [];
          let depth = 0, start = 0;
          const s = text;
          for (let i = 0; i < s.length; i++) {
              const c = s[i];
              if (c === '(') depth++;
              else if (c === ')') depth--;
              else if (depth === 0 && /\s/.test(c) && /^\s+and\s+/i.test(s.slice(i))) {
                  out.push(s.slice(start, i));
                  const mm = s.slice(i).match(/^\s+and\s+/i);
                  i += mm[0].length - 1;
                  start = i + 1;
              }
          }
          out.push(s.slice(start));
          return out.map(x => x.trim()).filter(x => x !== '');
      },

      // Oracle の擬似列 ROWNUM。
      //   WHERE ROWNUM <= n / < n  -> LIMIT（上位 n 件の定番イディオム）
      //   SELECT 句の ROWNUM       -> ROW_NUMBER() OVER ()
      // Oracle 同様 ORDER BY より前に採番されるので「並べ替えてから上位 n 件」は
      // 副問い合わせにする必要がある（実 DB と同じ制約）
      _expandRownum(sql) {
          if (!/\browne?um\b/i.test(sql) && !/\browNUM\b/i.test(sql) && !/\brownum\b/i.test(sql)) return sql;
          let out = sql;
          // WHERE ... ROWNUM <= n （AND で並んだ項のひとつ）を LIMIT へ移す
          let limitFromRownum = null;
          out = out.replace(/\browNUM\s*(<=|<|=)\s*(\d+)/gi, (m, op, n) => {
              const v = parseInt(n, 10);
              const lim = op === '<' ? v - 1 : v;
              limitFromRownum = limitFromRownum === null ? lim : Math.min(limitFromRownum, lim);
              return '1 = 1';
          });
          if (limitFromRownum !== null && !/\blimit\s+\d+/i.test(out)) {
              out += ` LIMIT ${Math.max(0, limitFromRownum)}`;
          }
          // 残った ROWNUM は出力行の連番として扱う
          out = out.replace(/\browNUM\b/gi, 'ROW_NUMBER() OVER ()');
          return out;
      },

      expandTableFunctions(sql, strMap) {
          // システムバージョン管理表（時制テーブル）は未実装。FROM 句の構文エラーとして
          // 出るより「対応していない」と言われたほうが判るので明示的に弾く
          if (/\bfor\s+system_time\b/i.test(sql)) {
              throw new Error("FOR SYSTEM_TIME (system-versioned tables) is not supported. Keep history in a table of your own and query it directly.");
          }
          sql = this._expandRownum(sql);
          sql = this._expandConnectBy(sql, strMap);
          sql = this._expandSelectListSRF(sql, strMap);
          sql = this.expandValuesTables(sql, strMap);
          sql = this._expandJsonTable(sql, strMap);
          sql = this._expandTableSample(sql, strMap);
          sql = this._expandSplitFunctions(sql, strMap);
          if (!/generate_series/i.test(sql)) return sql;
          // 数値系列に加えて「時刻の系列」も生成できる:
          //   GENERATE_SERIES(TIMESTAMP '...', TIMESTAMP '...', INTERVAL 1 HOUR)
          // 時系列レポートの欠測補完（バケットを先に全部作って LEFT JOIN する）で要る
          const re = /\b(FROM|JOIN)\s+GENERATE_SERIES\s*\(((?:[^()]|\([^()]*\))*)\)(?:\s+WITH\s+ORDINALITY)?(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\))?)?/gi;
          return sql.replace(re, (m, kw, args, aliasName, colList) => {
              const withOrd = /\bWITH\s+ORDINALITY\b/i.test(m);
              const cols = colList ? colList.split(',').map(c => c.trim().toLowerCase()) : null;
              const col = (cols && cols[0]) ? cols[0] : 'value';
              const ordCol = (cols && cols[1]) ? cols[1] : 'ordinality';
              const argTexts = this.splitSelectClause(args).map(a => a.trim());
              if (argTexts.length < 2 || argTexts.length > 3) throw new Error("GENERATE_SERIES requires 2 or 3 arguments (start, stop [, step]).");
              const vals = argTexts.map(a => this.compileCondition(a, strMap)({}, this.tables, {}));
              const GUARD = 1000000;
              const rows = [];
              const isTimeSeries = argTexts.length === 3 && /\bINTERVAL\b/i.test(argTexts[2]);
              if (isTimeSeries) {
                  const t0 = new Date(String(vals[0]).replace(' ', 'T') + 'Z');
                  const t1 = new Date(String(vals[1]).replace(' ', 'T') + 'Z');
                  if (isNaN(t0.getTime()) || isNaN(t1.getTime())) throw new Error("GENERATE_SERIES: start and stop must be valid timestamps.");
                  const iv = vals[2];
                  if (!iv || typeof iv !== 'object' || iv.__interval === undefined) throw new Error("GENERATE_SERIES: the step must be an INTERVAL when generating timestamps.");
                  if (iv.__interval === 0) throw new Error("GENERATE_SERIES step must not be zero.");
                  const fwd = iv.__interval > 0;
                  const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
                  const MS = { WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000 };
                  let cur = new Date(t0.getTime());
                  while (fwd ? cur.getTime() <= t1.getTime() : cur.getTime() >= t1.getTime()) {
                      rows.push({ [col]: fmt(cur) });
                      if (rows.length > GUARD) throw new Error("GENERATE_SERIES exceeded 1,000,000 rows.");
                      if (iv.unit === 'MONTH' || iv.unit === 'QUARTER' || iv.unit === 'YEAR') {
                          const mo = iv.unit === 'YEAR' ? iv.__interval * 12 : (iv.unit === 'QUARTER' ? iv.__interval * 3 : iv.__interval);
                          const nd = new Date(cur.getTime());
                          const day = nd.getUTCDate();
                          nd.setUTCDate(1);
                          nd.setUTCMonth(nd.getUTCMonth() + mo);
                          const dim = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 0)).getUTCDate();
                          nd.setUTCDate(Math.min(day, dim));
                          cur = nd;
                      } else {
                          cur = new Date(cur.getTime() + (MS[iv.unit] || MS.SECOND) * iv.__interval);
                      }
                  }
              } else {
                  // NULL の境界は Number(null) === 0 になり「空の系列」として黙って通る。
                  // 桁あふれした値（1e400）は式評価の段階で NULL へ揃うようになったので、
                  // ここで NULL を弾かないと「有限でない」検査が働かなくなる
                  if (vals.some(v => v === null || v === undefined)) {
                      throw new Error("GENERATE_SERIES arguments must be finite numbers (a NULL or out-of-range bound is not allowed).");
                  }
                  const nums = vals.map(Number);
                  const start = nums[0], stop = nums[1], step = nums.length === 3 ? nums[2] : 1;
                  if (!isFinite(start) || !isFinite(stop) || !isFinite(step)) throw new Error("GENERATE_SERIES arguments must be finite numbers.");
                  if (step === 0) throw new Error("GENERATE_SERIES step must not be zero.");
                  if (step > 0) { for (let v = start; v <= stop; v += step) { rows.push({ [col]: v }); if (rows.length > GUARD) throw new Error("GENERATE_SERIES exceeded 1,000,000 rows."); } }
                  else { for (let v = start; v >= stop; v += step) { rows.push({ [col]: v }); if (rows.length > GUARD) throw new Error("GENERATE_SERIES exceeded 1,000,000 rows."); } }
              }
              // WITH ORDINALITY: 1 始まりの連番列を添える（SQL標準）
              if (withOrd) rows.forEach((r, i) => { r[ordCol] = i + 1; });
              const tmpName = '__tmp_series_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, withOrd ? [col, ordCol] : [col]);
              return `${kw} ${tmpName}${aliasName ? ' ' + aliasName : ''}`;
          });
      },

      // 文字列/配列を行へ展開する表関数:
      //   STRING_SPLIT(str, delim)  (SQL Server) → 列 value
      //   UNNEST(a, b, c)           (PostgreSQL の配列展開に相当。要素をそのまま行にする)
      _expandSplitFunctions(sql, strMap) {
          if (!/\b(string_split|unnest)\s*\(/i.test(sql)) return sql;
          const re = /\b(FROM|JOIN)\s+(STRING_SPLIT|UNNEST)\s*\(((?:[^()]|\([^()]*\))*)\)(?:\s+WITH\s+ORDINALITY)?(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*([a-zA-Z_][a-zA-Z0-9_]*))?\s*\))?)?/gi;
          return sql.replace(re, (m, kw, fn, args, aliasName, colName, ordName) => {
              const parts = this.splitSelectClause(args).map(a => this.compileCondition(a.trim(), strMap)({}, this.tables, {}));
              const col = colName ? colName.toLowerCase() : 'value';
              let rows;
              if (fn.toUpperCase() === 'STRING_SPLIT') {
                  if (parts.length !== 2) throw new Error("STRING_SPLIT requires 2 arguments (string, separator).");
                  if (parts[0] === null || parts[0] === undefined) rows = [];
                  else {
                      const sep = String(parts[1]);
                      if (sep === '') throw new Error("STRING_SPLIT separator must not be empty.");
                      rows = String(parts[0]).split(sep).map(v => ({ [col]: v }));
                  }
              } else {
                  if (parts.length === 0) throw new Error("UNNEST requires at least one argument.");
                  // 引数が配列なら要素を行へ展開する（PostgreSQL の UNNEST(anyarray)）。
                  // スカラーを並べた UNNEST(10, 20, 30) 形は各引数がそのまま 1 行になる。
                  // 配列とスカラーが混ざっても素直に平坦化する
                  rows = [];
                  parts.forEach(v => {
                      if (Array.isArray(v)) v.forEach(e => rows.push({ [col]: e === undefined ? null : e }));
                      else rows.push({ [col]: v === undefined ? null : v });
                  });
              }
              // WITH ORDINALITY: 1 始まりの連番列を添える（SQL標準）
              const withOrd = /\bWITH\s+ORDINALITY\b/i.test(m);
              const ordCol = ordName ? ordName.toLowerCase() : 'ordinality';
              if (withOrd) rows.forEach((r, i) => { r[ordCol] = i + 1; });
              const tmpName = '__tmp_split_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, withOrd ? [col, ordCol] : [col]);
              return `${kw} ${tmpName}${aliasName ? ' ' + aliasName : ''}`;
          });
      },

      // PIVOT / UNPIVOT / CROSS APPLY / OUTER APPLY / LATERAL を一時テーブルへ実体化して
      // FROM 句のテーブル名に置換する（expandSubqueries より前・expandViews より後に呼ぶ）。
      // いずれも「等価な通常クエリへ書き換えて実行し、その結果を実体化する」方式。
      expandRelationalOps(sql, strMap) {
          if (!/\b(pivot|unpivot|apply|lateral)\b/i.test(sql)) return sql;
          let out = sql;
          for (let guard = 0; guard < 20; guard++) {
              const next = this._expandOnePivot(out, strMap);
              if (next === out) break;
              out = next;
          }
          for (let guard = 0; guard < 20; guard++) {
              const next = this._expandOneApply(out, strMap);
              if (next === out) break;
              out = next;
          }
          return out;
      },

      // ソース指定（テーブル名 / ビュー名 / (サブクエリ)）を一時テーブルへ解決し、列名一覧を返す
      _resolveRelSource(srcText, strMap) {
          const t = srcText.trim();
          if (t.startsWith('(')) {
              const inner = t.slice(1, -1).trim();
              const res = this.executeQuery(inner, true, strMap);
              if (res.error) throw new Error(res.error);
              const name = '__tmp_relsrc_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(name, res.data);
              return { name, cols: this.tables[name].getColumnNames() };
          }
          const nm = t.toLowerCase();
          if (!this.tables[nm]) throw this._tableNotFound(nm);
          return { name: nm, cols: this.tables[nm].getColumnNames() };
      },

      // FROM <src> PIVOT (AGG(expr) FOR col IN (v1 [AS a1], ...)) [AS] alias
      //   → SELECT <残り列>, AGG(CASE WHEN col = v1 THEN expr END) ... GROUP BY <残り列>
      // FROM <src> UNPIVOT (valCol FOR nameCol IN (c1, c2, ...)) [AS] alias
      //   → 各列の SELECT を UNION ALL（NULL 値の行は除外＝標準の挙動）
      // 開き括弧の位置から対応する閉じ括弧の位置を返す（見つからなければ -1）
      _scanBalanced(str, openIdx) {
          let d = 0;
          for (let i = openIdx; i < str.length; i++) {
              if (str[i] === '(') d++;
              else if (str[i] === ')') { d--; if (d === 0) return i; }
          }
          return -1;
      },

      // pos の直前にある「テーブルソース式」を後方走査で特定する。
      //   FROM t PIVOT(...)        -> t
      //   FROM t a PIVOT(...)      -> t（別名 a は置換範囲に含めて捨てる）
      //   FROM (SELECT ...) PIVOT  -> (SELECT ...)
      //   FROM (SELECT ...) y PIVOT-> (SELECT ...)（別名 y も置換範囲）
      // 戻り値 { start, end, srcText }: [start, end) を実体化テーブル名で置き換える
      _findSourceBefore(sql, pos) {
          const isWord = (c) => /[a-zA-Z0-9_]/.test(c);
          // 開き括弧を後方に探す（閉じ括弧位置から対応する開き括弧へ）
          const scanBack = (closeIdx) => {
              let d = 0;
              for (let i = closeIdx; i >= 0; i--) {
                  if (sql[i] === ')') d++;
                  else if (sql[i] === '(') { d--; if (d === 0) return i; }
              }
              return -1;
          };
          let i = pos - 1;
          while (i >= 0 && /\s/.test(sql[i])) i--;
          if (i < 0) return null;
          const end = i + 1;

          if (sql[i] === ')') {
              const open = scanBack(i);
              if (open === -1) return null;
              return { start: open, end, srcText: sql.slice(open, end) };
          }
          // 直前の語（ソース名か別名）を読む
          let j = i;
          while (j >= 0 && isWord(sql[j])) j--;
          const ident = sql.slice(j + 1, i + 1);
          if (!ident) return null;

          let k = j;
          while (k >= 0 && /\s/.test(sql[k])) k--;
          if (k >= 0 && sql[k] === ')') {
              // ident は (サブクエリ) の別名
              const open = scanBack(k);
              if (open === -1) return null;
              return { start: open, end, srcText: sql.slice(open, k + 1) };
          }
          let m = k;
          while (m >= 0 && isWord(sql[m])) m--;
          const prevWord = sql.slice(m + 1, k + 1);
          if (/^(from|join)$/i.test(prevWord)) {
              return { start: j + 1, end, srcText: ident };
          }
          if (/^(as)$/i.test(prevWord)) {
              // FROM t AS a PIVOT(...) : さらに前がソース名
              let n = m;
              while (n >= 0 && /\s/.test(sql[n])) n--;
              let p = n;
              while (p >= 0 && isWord(sql[p])) p--;
              const srcName = sql.slice(p + 1, n + 1);
              if (!srcName) return null;
              return { start: p + 1, end, srcText: srcName };
          }
          if (!prevWord) return null;
          return { start: m + 1, end, srcText: prevWord };
      },

      // 別名として使えない後続キーワード（PIVOT/APPLY の直後の語を別名と誤認しないため）
      _isClauseKeyword(w) {
          return /^(where|group|order|having|limit|offset|union|intersect|except|join|left|right|inner|cross|full|natural|on|using|qualify|window|fetch|for|into|pivot|unpivot|apply|lateral)$/i.test(w);
      },

      _expandOnePivot(sql, strMap) {
          // 括弧はバランス走査で切り出す（PIVOT (SUM(amount) FOR ...) のように本体が括弧を含むため）
          const km = sql.match(/\b(UN)?PIVOT\s*\(/i);
          if (!km) return sql;
          const isUnpivot = !!km[1];
          const openIdx = km.index + km[0].length - 1;
          const close = this._scanBalanced(sql, openIdx);
          if (close === -1) throw new Error(`Syntax Error in ${isUnpivot ? 'UNPIVOT' : 'PIVOT'}: unbalanced parentheses.`);
          const body = sql.slice(openIdx + 1, close).trim();

          // ソースは PIVOT の直前にあるテーブル式。括弧を考慮した後方走査で特定する
          // （ネストした FROM や (サブクエリ) 別名があっても正しい範囲を取る）
          const found = this._findSourceBefore(sql, km.index);
          if (!found) throw new Error(`${isUnpivot ? 'UNPIVOT' : 'PIVOT'} must follow a table source.`);
          const srcStart = found.start;
          const src = this._resolveRelSource(found.srcText.trim(), strMap);

          // 閉じ括弧の後ろにある別名を取り込む（句キーワードは別名としない）
          const after = sql.slice(close + 1);
          const aliasM = after.match(/^\s*(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
          const aliasName = (aliasM && !this._isClauseKeyword(aliasM[1])) ? aliasM[1] : null;
          const consumedAfter = aliasName ? aliasM[0].length : 0;

          const forSplit = body.match(/^([\s\S]+?)\s+FOR\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s*\(([\s\S]+)\)\s*$/i);
          if (!forSplit) throw new Error(`Syntax Error in ${isUnpivot ? 'UNPIVOT' : 'PIVOT'}. Use ( <spec> FOR <column> IN (...) ).`);
          const head = forSplit[1].trim();
          const forCol = forSplit[2].toLowerCase();
          const inItems = this.splitSelectClause(forSplit[3]).map(s => s.trim()).filter(Boolean);
          if (inItems.length === 0) throw new Error("PIVOT/UNPIVOT requires at least one item in the IN list.");

          const tmpName = '__tmp_pivot_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
          let rows, outCols;

          if (isUnpivot) {
              const valCol = head.toLowerCase();
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(valCol)) throw new Error("UNPIVOT value column must be a simple identifier.");
              const srcCols = inItems.map(c => c.replace(/^["'\[]|["'\]]$/g, '').toLowerCase());
              srcCols.forEach(c => { if (!this.tables[src.name].cols[c]) throw new Error(`Column '${c}' not found in UNPIVOT source.`); });
              const keep = src.cols.filter(c => !srcCols.includes(c));
              outCols = [...keep, forCol, valCol];
              rows = [];
              const st = this.tables[src.name];
              for (let i = 0; i < st.rowCount; i++) {
                  srcCols.forEach(c => {
                      const v = st.getValue(c, i);
                      if (v === null || v === undefined) return; // 標準 UNPIVOT は NULL 行を除外
                      const row = {};
                      keep.forEach(k => { row[k] = st.getValue(k, i); });
                      row[forCol] = c;
                      row[valCol] = v;
                      rows.push(row);
                  });
              }
          } else {
              const aggM = head.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)$/);
              if (!aggM) throw new Error("PIVOT requires an aggregate call, e.g. PIVOT (SUM(amount) FOR c IN (...)).");
              const aggFn = aggM[1].toUpperCase();
              const aggArg = aggM[2].trim();
              if (!this.tables[src.name].cols[forCol]) throw new Error(`Column '${forCol}' not found in PIVOT source.`);
              // 集計対象に現れる列と FOR 列を除いた残りがグループ化キー
              const argCols = new Set((aggArg.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).map(x => x.toLowerCase()));
              const groupCols = src.cols.filter(c => c !== forCol && !argCols.has(c));
              const sels = [];
              const names = [];
              inItems.forEach((item, i) => {
                  const am = item.match(/^([\s\S]+?)\s+AS\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i);
                  const valTxt = (am ? am[1] : item).trim();
                  // 別名がなければ IN の値そのものを列名にする。この時点で文字列リテラルは
                  // __STR_N__ へ退避済みなので、元の値へ戻してから列名化する
                  let outName;
                  if (am) {
                      outName = am[2].toLowerCase();
                  } else {
                      const tok = valTxt.match(/^__STR_(\d+)__$/);
                      const lit = tok ? this._unquoteLiteral(strMap[Number(tok[1])]) : valTxt;
                      outName = String(lit).replace(/^['"]|['"]$/g, '').toLowerCase();
                  }
                  names.push(outName);
                  sels.push(`${aggFn}(CASE WHEN ${forCol} = ${valTxt} THEN ${aggArg} END) AS __pv_${i}`);
              });
              outCols = [...groupCols, ...names];
              const selectList = [...groupCols, ...sels].join(', ');
              const grp = groupCols.length ? ` GROUP BY ${groupCols.join(', ')}` : '';
              const res = this.executeQuery(`SELECT ${selectList} FROM ${src.name}${grp}`, true, strMap);
              if (res.error) throw new Error("PIVOT failed: " + res.error);
              rows = res.data;
          }

          this._materializeRows(tmpName, rows, outCols);
          return sql.slice(0, srcStart) + `${tmpName}${aliasName ? ' ' + aliasName : ''}` + sql.slice(close + 1 + consumedAfter);
      },

      // <left> CROSS|OUTER APPLY (subquery) [alias]
      // <left> [, | [INNER|LEFT|CROSS] JOIN] LATERAL (subquery) [alias] [ON <cond>]
      //   左の各行に対しサブクエリを評価して連結する（相関可）。結果は一時テーブルへ実体化する。
      _expandOneApply(sql, strMap) {
          const km = sql.match(/\b(?:(CROSS|OUTER)\s+APPLY|(?:(left|right|full|inner|cross)\s+(?:outer\s+)?)?(?:join\s+)?LATERAL)\s+/i);
          if (!km) return sql;
          // APPLY が括弧の内側（派生表やサブクエリの中）に書かれている場合は、
          // その内側だけを先に展開する。文全体を「左側クエリ」として組み立てると
          // 途中で切れた SQL になり、原因の判らない構文エラーになっていた
          {
              const openStack = [];
              const head = sql.slice(0, km.index);
              for (let i = 0; i < head.length; i++) {
                  if (head[i] === '(') openStack.push(i);
                  else if (head[i] === ')') openStack.pop();
              }
              if (openStack.length > 0) {
                  const openIdx = openStack[openStack.length - 1];
                  const close = this._scanBalanced(sql, openIdx);
                  if (close === -1) return sql;
                  const innerText = sql.slice(openIdx + 1, close);
                  const expanded = this._expandOneApply(innerText, strMap);
                  if (expanded === innerText) return sql;
                  return sql.slice(0, openIdx + 1) + expanded + sql.slice(close);
              }
          }
          // JOIN LATERAL: LEFT JOIN LATERAL は OUTER APPLY 相当、それ以外は CROSS APPLY 相当
          const joinKw = km[2] ? km[2].toLowerCase() : null;
          if (joinKw === 'right' || joinKw === 'full') {
              throw new Error(`${joinKw.toUpperCase()} JOIN LATERAL is not supported. Use INNER / LEFT / CROSS JOIN LATERAL.`);
          }
          const kind = km[1] ? km[1].toUpperCase() : (joinKw === 'left' ? 'OUTER' : 'CROSS');
          // 右辺は (サブクエリ) かテーブル名。括弧はバランス走査で切り出す
          let pos = km.index + km[0].length;
          let rightText, rightEnd;
          if (sql[pos] === '(') {
              const close = this._scanBalanced(sql, pos);
              if (close === -1) throw new Error("Syntax Error in APPLY / LATERAL: unbalanced parentheses.");
              rightText = sql.slice(pos, close + 1);
              rightEnd = close + 1;
          } else {
              const idM = sql.slice(pos).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
              if (!idM) throw new Error("APPLY / LATERAL requires a subquery or table name.");
              rightText = idM[0];
              rightEnd = pos + idM[0].length;
          }
          const aliasM = sql.slice(rightEnd).match(/^\s*(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
          const rightAlias = (aliasM && !this._isClauseKeyword(aliasM[1])) ? aliasM[1] : null;
          let consumedEnd = rightEnd + (rightAlias ? aliasM[0].length : 0);

          // JOIN LATERAL ... ON <cond>: ON TRUE / ON 1=1 は無条件なので捨てる。
          // それ以外は実体化後の表への絞り込み（WHERE）へ移す
          let lateralOn = null;
          const onM = sql.slice(consumedEnd).match(/^\s*on\s+([\s\S]*?)(?=\s+(?:where|group\s+by|having|order\s+by|limit|offset|window|qualify|union|intersect|except|left|right|inner|full|cross|natural|join)\b|$)/i);
          if (onM) {
              const cond = onM[1].trim();
              if (!/^(?:true|1\s*=\s*1)$/i.test(cond)) {
                  if (kind === 'OUTER') {
                      throw new Error("LEFT JOIN LATERAL supports only ON TRUE. Move the condition into the subquery's WHERE clause.");
                  }
                  lateralOn = cond;
              }
              consumedEnd += onM[0].length;
          }

          // APPLY より前の部分から「左側クエリ」を組み立てて行を得る
          // （LATERAL 前のカンマ / JOIN キーワードも消費する）
          const before = sql.slice(0, km.index).trim().replace(/,\s*$/, '');
          if (!/^select\b/i.test(before)) throw new Error("APPLY / LATERAL must follow a SELECT ... FROM clause.");
          const leftSql = before.replace(/^select\s+(?:distinct\s+)?[\s\S]*?\s+from\s+/i, 'SELECT * FROM ');
          let leftRes = this.executeQuery(leftSql, true, strMap);
          // 左側が派生表 `FROM (SELECT ...) z` の形だと、内部実行では FROM の
          // サブクエリ展開が走らず構文エラーになる。前段の展開を通してもう一度試す
          if (leftRes.error) leftRes = this.executeQuery(leftSql, false, strMap);
          if (leftRes.error) throw new Error("APPLY left side failed: " + leftRes.error);
          const leftRows = leftRes.data;

          // 左表の別名（相関参照 a.col の解決に使う）。
          // `FROM (SELECT ...) z` のように派生表が左側に来る形も拾う
          let leftAlias = null, leftTable = null;
          const fromKw = before.match(/\bfrom\s+/i);
          if (fromKw && before[fromKw.index + fromKw[0].length] === '(') {
              const openAt = fromKw.index + fromKw[0].length;
              const closeAt = this._scanBalanced(before, openAt);
              if (closeAt !== -1) {
                  const am = before.slice(closeAt + 1).match(/^\s*(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/i);
                  if (am && !this._isClauseKeyword(am[1])) leftAlias = am[1].toLowerCase();
              }
          } else {
              const leftFromM = before.match(/\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/i);
              if (leftFromM) {
                  leftAlias = (leftFromM[2] || leftFromM[1]).toLowerCase();
                  leftTable = leftFromM[1].toLowerCase();
              }
          }

          const innerRaw = rightText.startsWith('(') ? rightText.slice(1, -1).trim() : `SELECT * FROM ${rightText}`;
          const outRows = [];
          let rightCols = null;
          // 右側の列名が左側とぶつかったら別名を付けて両方残す。
          // 上書きすると `x CROSS APPLY (...k) y` のように同じ列名を返す APPLY を
          // 続けたとき、先の値が黙って後の値に置き換わる
          const leftColSet = new Set(leftRows.length > 0 ? Object.keys(leftRows[0]).map(c => c.toLowerCase()) : []);
          let rightMap = null;
          for (const lrow of leftRows) {
              const lc = {};
              for (const k in lrow) lc[k.toLowerCase()] = lrow[k];
              // 相関参照（<alias>.col / 素の列名）を左行の値リテラルへ差し替える
              let q = innerRaw;
              // 差し込む値は、文字列なら strMap 側へ退避してトークンで置く
              // （本文はまだ退避済みの状態なので、生のリテラルを混ぜない）
              const litTok = (v) => {
                  const lit = this._literalOf(v);
                  if (strMap && lit.charAt(0) === "'") { strMap.push(lit); return `__STR_${strMap.length - 1}__`; }
                  return lit;
              };
              if (leftAlias) q = q.replace(new RegExp('\\b' + leftAlias + '\\.([a-zA-Z0-9_]+)\\b', 'gi'), (mm, c) => litTok(lc[c.toLowerCase()]));
              if (leftTable && leftTable !== leftAlias) q = q.replace(new RegExp('\\b' + leftTable + '\\.([a-zA-Z0-9_]+)\\b', 'gi'), (mm, c) => litTok(lc[c.toLowerCase()]));
              // strMap を渡さないと本文の文字列リテラル（__STR_n__）が復元されず、
              // 条件が実行時エラーになって「0 行」という誤答になっていた
              const rres = this.executeQuery(q, false, strMap);
              if (rres.error) throw new Error("APPLY subquery failed: " + rres.error);
              if (rres.data.length > 0 && !rightCols) {
                  rightCols = Object.keys(rres.data[0]);
                  rightMap = new Map();
                  rightCols.forEach(c => rightMap.set(c,
                      leftColSet.has(c.toLowerCase()) ? `${rightAlias || 'apply'}_${c}` : c));
              }
              if (rres.data.length === 0) {
                  if (kind === 'OUTER') outRows.push({ ...lrow, __apply_null: 1 });
                  continue;
              }
              rres.data.forEach(rr => {
                  const merged = { ...lrow };
                  for (const k in rr) merged[(rightMap && rightMap.get(k)) || k] = rr[k];
                  outRows.push(merged);
              });
          }
          // OUTER APPLY の非マッチ行は右側列を NULL で補う
          const leftCols = leftRows.length > 0 ? Object.keys(leftRows[0]) : [];
          const allCols = [...leftCols];
          (rightCols || []).forEach(c => {
              const o = (rightMap && rightMap.get(c)) || c;
              if (!allCols.includes(o)) allCols.push(o);
          });
          const norm = outRows.map(r => {
              const o = {};
              allCols.forEach(c => { o[c] = r[c] === undefined ? null : r[c]; });
              return o;
          });

          const tmpName = '__tmp_apply_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
          this._materializeRows(tmpName, norm, allCols);

          // SELECT 句は元のまま、FROM 以降を実体化テーブルへ差し替える。
          // 実体化後は列名がフラットになるため、左右の別名修飾子は取り除く
          const selHead = before.match(/^select\s+(distinct\s+)?([\s\S]*?)\s+from\s+/i);
          const distinctTxt = selHead && selHead[1] ? 'DISTINCT ' : '';
          // 実体化後は列名がフラットになるので右側の別名修飾子は落とす。
          // 左側の別名は実体化テーブルに付け直すので **残す** — 落とすと、後ろに
          // もう 1 つ APPLY が続く形でその相関参照（g.code）が裸の列名になり、
          // 内側の表に無い名前として弾かれていた
          const stripQual = (txt) => {
              let s = txt;
              // 右側は「別名.列」を実体化後の列名へ読み替える（衝突時は別名を付けた名前）
              if (rightAlias) {
                  s = s.replace(new RegExp('\\b' + rightAlias + '\\.([a-zA-Z0-9_]+)\\b', 'gi'), (m, c) => {
                      if (!rightMap) return c;
                      for (const [k, v] of rightMap) if (k.toLowerCase() === c.toLowerCase()) return v;
                      return c;
                  });
              }
              if (leftTable && leftTable !== leftAlias) s = s.replace(new RegExp('\\b' + leftTable + '\\.', 'gi'), '');
              return s;
          };
          const selList = stripQual(selHead ? selHead[2] : '*');
          let rest = stripQual(sql.slice(consumedEnd));
          // JOIN LATERAL の ON 条件は実体化した表への WHERE として合成する
          if (lateralOn) {
              const cond = stripQual(lateralOn);
              const wM = rest.match(/^(\s*)where\s+/i);
              rest = wM ? `${wM[1]}WHERE (${cond}) AND ${rest.slice(wM[0].length)}` : ` WHERE (${cond})${rest}`;
          }
          return `SELECT ${distinctTxt}${selList} FROM ${tmpName}${leftAlias ? ' ' + leftAlias : ''}${rest}`;
      },

      // 再帰CTE (WITH RECURSIVE): アンカー部の行を初期作業集合とし、再帰部を
      // 「前イテレーションの行だけが見える作業テーブル」に対して繰り返し実行する。
      // UNION（重複除去）は累積集合と重複した行を捨てることで循環データでも収束する。
      // UNION ALL は無限再帰し得るため反復回数と行数に上限を設ける。
      // searchSpec: { mode: 'depth'|'breadth', cols: [...], seqCol } — 走査順の連番列を足す
      // cycleSpec : { cols, flagCol, markValue, defaultValue, pathCol } — 循環を検出して打ち切る
      _materializeRecursiveCTE(cteName, body, tmpName, strMap, colNames, searchSpec, cycleSpec) {
          const segs = this._splitUnion(body);
          const refRe = new RegExp(`\\b(?:from|join)\\s+${cteName}\\b`, 'i');
          const anchor = [], recursive = [];
          segs.forEach(seg => (refRe.test(seg.sql) ? recursive : anchor).push(seg));
          if (anchor.length === 0) throw new Error(`Recursive CTE '${cteName}' requires a non-recursive anchor member.`);
          const distinctMode = segs.some(s => s.op === 'UNION');

          const followKeywords = new Set(['where', 'group', 'order', 'limit', 'offset', 'having', 'join', 'left', 'right', 'inner', 'cross', 'on', 'union', 'intersect', 'except', 'set']);
          const workName = '__tmp_ctework_' + cteName;
          // 自己参照を作業テーブルへ差し替える（エイリアスが無ければCTE名を付与して修飾参照を保つ）
          const replaceSelfRef = (text) => text.replace(new RegExp(`\\b(FROM|JOIN)\\s+${cteName}\\b(\\s+(?:AS\\s+)?([a-zA-Z0-9_]+))?`, 'gi'), (m, kw, aliasPart, aliasWord) => {
              if (aliasWord && !followKeywords.has(aliasWord.toLowerCase())) return `${kw} ${workName}${aliasPart}`;
              return `${kw} ${workName} ${cteName}${aliasPart || ''}`;
          });
          const runSeg = (segSql) => {
              const expanded = this.expandSubqueries(this.expandRelationalOps(this.expandTableFunctions(this.expandViews(this.expandInfoSchema(segSql), strMap), strMap), strMap), strMap);
              const r = this.executeQuery(expanded, true, strMap);
              if (r.error) throw new Error(`Recursive CTE '${cteName}': ${r.error}`);
              return r.data;
          };

          // 列リスト (WITH t(a, b) AS ...) 指定時はアンカーの列名を差し替える
          let keys = colNames ? [...colNames] : null;
          const seen = new Set();
          const acc = [];
          let working = [];
          const addRows = (rows, into) => {
              rows.forEach(row => {
                  if (!keys) keys = Object.keys(row);
                  else {
                      const rk = Object.keys(row);
                      if (rk.length !== keys.length) throw new Error(`Recursive CTE '${cteName}': UNION members must return the same number of columns.`);
                      if (rk.join('|||') !== keys.join('|||')) {
                          // 列名が異なる場合はアンカーの列名へ位置ベースで揃える
                          const vals = Object.values(row);
                          const nr = {};
                          keys.forEach((k2, i2) => nr[k2] = vals[i2]);
                          row = nr;
                      }
                  }
                  if (distinctMode) {
                      const sig = JSON.stringify(Object.values(row));
                      if (seen.has(sig)) return;
                      seen.add(sig);
                  }
                  acc.push(row);
                  into.push(row);
              });
          };

          // CYCLE 句: 循環キーの通過履歴を行ごとに持ち、既に通った値へ戻ったら
          // その行に印を付けて以降は辿らない（無限再帰を上限エラーではなく仕様として止める）
          const cyclePaths = cycleSpec ? new WeakMap() : null;
          const cycleKeyOf = (row) => JSON.stringify(cycleSpec.cols.map(c => {
              const k = Object.keys(row).find(x => x.toLowerCase() === c);
              return k === undefined ? null : row[k];
          }));

          anchor.forEach(seg => addRows(runSeg(seg.sql), working));
          if (cycleSpec) {
              working.forEach(r => {
                  cyclePaths.set(r, [cycleKeyOf(r)]);
                  r[cycleSpec.flagCol] = cycleSpec.defaultValue;
                  if (cycleSpec.pathCol) r[cycleSpec.pathCol] = JSON.stringify([JSON.parse(cycleKeyOf(r))]);
              });
          }
          let iter = 0;
          while (working.length > 0 && recursive.length > 0) {
              if (++iter > 500) throw new Error(`Recursive CTE '${cteName}' exceeded 500 iterations. Add a termination condition (or use UNION instead of UNION ALL).`);
              if (acc.length > 100000) throw new Error(`Recursive CTE '${cteName}' exceeded 100,000 rows.`);
              // CYCLE 有効時は「まだ循環していない行」だけを次の入力にする
              const feed = cycleSpec ? working.filter(r => r[cycleSpec.flagCol] !== cycleSpec.markValue) : working;
              if (feed.length === 0) break;
              this._materializeRows(workName, feed.map(r => {
                  if (!cycleSpec) return r;
                  // 作業テーブルには CYCLE の付随列を出さない（自己参照 SELECT の列数を保つ）
                  const c = Object.assign(Object.create(null), r);
                  delete c[cycleSpec.flagCol];
                  if (cycleSpec.pathCol) delete c[cycleSpec.pathCol];
                  return c;
              }));
              const next = [];
              recursive.forEach(seg => addRows(runSeg(replaceSelfRef(seg.sql)), next));
              if (cycleSpec) {
                  // 親の経路は「同じ循環キーを持つ直近の作業行」から引き継ぐ
                  const parentPath = new Map();
                  feed.forEach(r => parentPath.set(cycleKeyOf(r), cyclePaths.get(r) || []));
                  next.forEach(r => {
                      const key = cycleKeyOf(r);
                      // 直前の世代のどれかの経路に自分のキーがあれば循環
                      let base = null, cycled = false;
                      for (const [, p] of parentPath) {
                          if (p.indexOf(key) !== -1) { base = p; cycled = true; break; }
                          if (base === null) base = p;
                      }
                      const path = (base || []).concat([key]);
                      cyclePaths.set(r, path);
                      r[cycleSpec.flagCol] = cycled ? cycleSpec.markValue : cycleSpec.defaultValue;
                      if (cycleSpec.pathCol) r[cycleSpec.pathCol] = JSON.stringify(path.map(x => JSON.parse(x)));
                  });
              }
              working = next;
          }
          delete this.tables[workName];

          // SEARCH 句: 走査順の連番列を足す。深さ優先は「親の直後に子」を並べ直し、
          // 幅優先は生成順（＝世代順）がそのまま該当する
          let out = acc;
          if (searchSpec) {
              const keyOf = (row) => JSON.stringify(searchSpec.cols.map(c => {
                  const k = Object.keys(row).find(x => x.toLowerCase() === c);
                  return k === undefined ? null : row[k];
              }));
              if (searchSpec.mode === 'depth') {
                  // 生成順は幅優先なので、同じ探索キーの塊ごとに安定ソートして深さ優先へ寄せる
                  out = [...acc].sort((a, b) => {
                      const ka = keyOf(a), kb = keyOf(b);
                      return ka < kb ? -1 : (ka > kb ? 1 : 0);
                  });
              }
              out = out.map((row, i) => Object.assign(Object.create(null), row, { [searchSpec.seqCol]: i + 1 }));
          }
          this._materializeRows(tmpName, out, colNames && !searchSpec && !cycleSpec ? colNames : null);
      },

      // WITH [RECURSIVE] name AS (SELECT ...), ... <本体>: CTE を一時テーブルへ実体化し、
      // 本体クエリ中の参照を一時テーブル名に置換して返す
      _expandCTEs(sql, strMap) {
          const recM = sql.match(/^with\s+(recursive\s+)?/i);
          const isRecursive = !!(recM && recM[1]);
          let rest = sql.slice(recM[0].length);
          const cteMap = Object.create(null); // CTE名 -> 一時テーブル名
          // FROM/JOIN の CTE 参照を一時テーブルへ置換する。明示エイリアスが無い場合は
          // CTE名をエイリアスとして付与し、`cte名.列` の修飾参照を解決可能にする
          const followKeywords = new Set(['where', 'group', 'order', 'limit', 'offset', 'having', 'join', 'left', 'right', 'inner', 'cross', 'on', 'union', 'intersect', 'except', 'set']);
          const replaceRefs = (text) => {
              for (const n in cteMap) {
                  text = text.replace(new RegExp(`\\b(FROM|JOIN)\\s+${n}\\b(\\s+(?:AS\\s+)?([a-zA-Z0-9_]+))?`, 'gi'), (m, kw, aliasPart, aliasWord) => {
                      if (aliasWord && !followKeywords.has(aliasWord.toLowerCase())) {
                          return `${kw} ${cteMap[n]}${aliasPart}`;
                      }
                      return `${kw} ${cteMap[n]} ${n}${aliasPart || ''}`;
                  });
              }
              return text;
          };
          while (true) {
              // 列リスト付きの WITH name(col1, col2) AS ( ... ) にも対応する。
              // AS [NOT] MATERIALIZED（PostgreSQL の最適化ヒント）は受理して無視する
              // — LuminaDB は CTE を常に実体化するので MATERIALIZED と同じ挙動になる
              const m = rest.match(/^([a-zA-Z0-9_]+)(?:\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\))?\s+as\s*(?:(?:not\s+)?materialized\s*)?\(/i);
              if (!m) throw new Error("Syntax Error in WITH clause. Use WITH name [(col, ...)] AS (SELECT ...).");
              const name = m[1].toLowerCase();
              const colNames = m[2] ? m[2].split(',').map(c => c.trim().toLowerCase()) : null;
              // 対応する閉じ括弧を探す
              let depth = 0, start = m[0].length - 1, end = -1;
              for (let i = start; i < rest.length; i++) {
                  if (rest[i] === '(') depth++;
                  else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
              }
              if (end === -1) throw new Error("Syntax Error in WITH clause: unbalanced parentheses.");

              // 先行して定義された CTE の参照を解決してから実行する
              let body = replaceRefs(rest.slice(start + 1, end).trim());
              const tmpName = '__tmp_cte_' + name;
              // 定義の直後に来る SEARCH / CYCLE 句（SQL:2003）を取り込む。
              //   SEARCH {DEPTH|BREADTH} FIRST BY col[, ...] SET seqCol
              //   CYCLE col[, ...] SET flagCol [TO 'y' DEFAULT 'n'] [USING pathCol]
              // 階層データの並び順と循環検出は再帰CTEの実運用でほぼ必ず要る
              let searchSpec = null, cycleSpec = null;
              let tail = rest.slice(end + 1);
              const sm = tail.match(/^\s*search\s+(depth|breadth)\s+first\s+by\s+([a-zA-Z0-9_,\s]+?)\s+set\s+([a-zA-Z0-9_]+)/i);
              if (sm) {
                  searchSpec = { mode: sm[1].toLowerCase(), cols: sm[2].split(',').map(c => c.trim().toLowerCase()), seqCol: sm[3].toLowerCase() };
                  tail = tail.slice(sm[0].length);
              }
              const cm = tail.match(/^\s*cycle\s+([a-zA-Z0-9_,\s]+?)\s+set\s+([a-zA-Z0-9_]+)(?:\s+to\s+(__STR_\d+__|\S+)\s+default\s+(__STR_\d+__|\S+))?(?:\s+using\s+([a-zA-Z0-9_]+))?/i);
              if (cm) {
                  const lit = (tok) => {
                      if (tok === undefined) return undefined;
                      const t = String(tok).match(/^__STR_(\d+)__$/);
                      return t ? this._unquoteLiteral(strMap[Number(t[1])]) : tok;
                  };
                  cycleSpec = {
                      cols: cm[1].split(',').map(c => c.trim().toLowerCase()),
                      flagCol: cm[2].toLowerCase(),
                      markValue: cm[3] !== undefined ? lit(cm[3]) : true,
                      defaultValue: cm[4] !== undefined ? lit(cm[4]) : false,
                      pathCol: cm[5] ? cm[5].toLowerCase() : null
                  };
                  tail = tail.slice(cm[0].length);
              }
              if ((searchSpec || cycleSpec) && !isRecursive) throw new Error("SEARCH / CYCLE require WITH RECURSIVE.");
              if (isRecursive && new RegExp(`\\b(?:from|join)\\s+${name}\\b`, 'i').test(body)) {
                  // 自己参照あり → 再帰CTE（サブクエリ展開は各セグメントの実行時に行う）
                  this._materializeRecursiveCTE(name, body, tmpName, strMap, colNames, searchSpec, cycleSpec);
              } else {
                  body = this.expandSubqueries(this.expandRelationalOps(this.expandTableFunctions(this.expandViews(this.expandInfoSchema(body), strMap), strMap), strMap), strMap);
                  const res = this.executeQuery(body, true, strMap);
                  if (res.error) throw new Error(`CTE '${name}': ${res.error}`);
                  // 0 件の CTE でも列は残す（`WITH e AS (SELECT v ... WHERE 偽) SELECT SUM(v) FROM e`）
                  this._materializeRows(tmpName, res.data, colNames || res.columns || null);
              }
              cteMap[name] = tmpName;

              // SEARCH / CYCLE 句は tail 側で既に消費済み
              rest = tail.trim();
              if (rest.startsWith(',')) { rest = rest.slice(1).trim(); continue; }
              break;
          }
          if (!rest) throw new Error("WITH clause must be followed by a statement.");
          return replaceRefs(rest);
      },

      // FROM / JOIN に現れるビュー名をサブクエリへインライン展開する
      expandViews(sql, strMap) {
          if (Object.keys(this.views).length === 0) return sql;
          let guard = 0;
          let changed = true;
          while (changed && guard++ < 20) {
              changed = false;
              sql = sql.replace(/\b(FROM|JOIN)\s+([a-zA-Z0-9_]+)/gi, (m, kw, name, offset) => {
                  const viewSql = this.views[name.toLowerCase()];
                  if (!viewSql) return m;
                  // DELETE の対象テーブルにビューは指定不可（展開せずテーブル未存在エラーに委ねる）
                  if (/^\s*delete\s*$/i.test(sql.slice(0, offset))) return m;
                  changed = true;
                  return `${kw} (${this._maskStrings(viewSql, strMap)})`;
              });
          }
          return sql;
      },

      // トップレベル（括弧の外）の UNION [ALL] / INTERSECT / EXCEPT でクエリを分割する
      // 各セグメントの op は「直前のセグメントとの結合方法」を表す（先頭は null）
      // 集合演算の各枝を括弧で囲む書き方 `(SELECT ...) UNION (SELECT ...)` を受け付けるため、
      // 枝全体を包む冗長な括弧だけを外す（従来は構文エラーになっていた）。
      // 括弧が全体を包んでいない場合や中身が SELECT 系でない場合は触らない
      _stripSetOpParens(s) {
          let t = String(s).trim();
          for (;;) {
              if (!t.startsWith('(')) return t;
              let depth = 0, close = -1;
              for (let i = 0; i < t.length; i++) {
                  if (t[i] === '(') depth++;
                  else if (t[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
              }
              if (close === -1) return t;
              const inner = t.slice(1, close).trim();
              if (!/^(select|with|values|table)\b/i.test(inner)) return t;
              t = (inner + t.slice(close + 1)).trim();
          }
      },

      _splitUnion(sql) {
          const parts = [];
          let depth = 0, segStart = 0, i = 0;
          let pendingOp = null;
          while (i < sql.length) {
              const ch = sql[i];
              if (ch === '(') depth++;
              else if (ch === ')') depth--;
              else if (depth === 0 && /[uiemUIEM]/.test(ch) && i > 0 && /[\s)]/.test(sql[i - 1])) {
                  // MINUS / MINUS ALL は Oracle における EXCEPT の別名
                  const m = sql.slice(i).match(/^(UNION\s+ALL|UNION\s+DISTINCT|UNION|INTERSECT\s+ALL|INTERSECT|EXCEPT\s+ALL|EXCEPT|MINUS\s+ALL|MINUS)\b/i);
                  if (m) {
                      parts.push({ sql: this._stripSetOpParens(sql.slice(segStart, i)), op: pendingOp });
                      pendingOp = m[1].toUpperCase().replace(/\s+/g, ' ').replace(/^MINUS/, 'EXCEPT');
                      i += m[0].length;
                      segStart = i;
                      continue;
                  }
              }
              i++;
          }
          parts.push({ sql: this._stripSetOpParens(sql.slice(segStart)), op: pendingOp });
          return parts;
      },

      _executeUnion(segments, isExplain, strMap) {
          // 末尾セグメントの ORDER BY / LIMIT / OFFSET は UNION 結果全体へ適用する
          let lastSql = segments[segments.length - 1].sql;
          let overMap = [];
          lastSql = lastSql.replace(/\bOVER\s*\((?:[^)(]+|\([^)(]*\))*\)/gi, (mm) => {
              overMap.push(mm);
              return `__OVER_${overMap.length - 1}__`;
          });
          // 集計関数内の ORDER BY が UNION 全体の ORDER BY 抽出に誤マッチしないよう退避する
          let aggMapU = [];
          lastSql = lastSql.replace(/\b(GROUP_CONCAT|JSON_ARRAYAGG|ARRAY_AGG|STRING_AGG)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi, (mm) => {
              aggMapU.push(mm);
              return `__AGGFN_${aggMapU.length - 1}__`;
          });
          let limitVal = null, offsetVal = null, orderByStr = null;
          // SQL標準の OFFSET n ROWS / FETCH FIRST n ROWS ONLY を LIMIT / OFFSET へ正規化
          lastSql = lastSql.replace(/\bOFFSET\s+(\d+)\s+ROWS?\b/gi, 'OFFSET $1');
          lastSql = lastSql.replace(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\b/gi, 'LIMIT $1');
          // MySQL 形式 LIMIT offset, count を先に判定する（小数・負値の扱いは _parseSelect と同じ）
          const limitCommaMatch = lastSql.match(/\s+limit\s+(\d+)\s*,\s*(\d+)/i);
          if (limitCommaMatch) {
              offsetVal = limitCommaMatch[1];
              limitVal = limitCommaMatch[2];
              lastSql = lastSql.replace(limitCommaMatch[0], '');
          } else {
              const limitMatch = lastSql.match(/\s+limit\s+(\d+(?:\.\d+)?|all)/i);
              if (limitMatch) { limitVal = limitMatch[1]; lastSql = lastSql.replace(limitMatch[0], ''); }
          }
          const offsetMatch = lastSql.match(/\s+offset\s+(-?\d+(?:\.\d+)?)/i);
          if (offsetMatch) { offsetVal = offsetMatch[1]; lastSql = lastSql.replace(offsetMatch[0], ''); }
          const oMatch = lastSql.match(/\s+order\s+by\s+([\s\S]+)$/i);
          if (oMatch) { orderByStr = oMatch[1]; lastSql = lastSql.substring(0, oMatch.index); }
          const restoreOver = (s) => s === null ? null : s.replace(/__OVER_(\d+)__/g, (mm, i) => overMap[i]).replace(/__AGGFN_(\d+)__/g, (mm, i) => aggMapU[i]);
          segments[segments.length - 1].sql = this._stripSetOpParens(restoreOver(lastSql));
          orderByStr = restoreOver(orderByStr);

          if (isExplain) {
              const explainPlan = [];
              segments.forEach(seg => {
                  const parsed = this._parseSelect(seg.sql);
                  const plan = this._optimizeSelect(parsed, true, strMap);
                  plan.explainPlan.forEach(p => explainPlan.push({ Step: explainPlan.length + 1, Operation: p.Operation, Details: p.Details }));
              });
              explainPlan.push({ Step: explainPlan.length + 1, Operation: 'SET OPERATION', Details: `Combine ${segments.length} result sets (${segments.slice(1).map(s => s.op).join(', ')})` });
              return { data: explainPlan, affectedRows: explainPlan.length };
          }

          let combined = [];
          let keys = null;
          segments.forEach((seg, segIdx) => {
              const parsed = this._parseSelect(seg.sql);
              const plan = this._optimizeSelect(parsed, false, strMap);
              let rows = this._executeSelectPlan(plan, strMap).data;
              if (rows.length > 0) {
                  const segKeys = Object.keys(rows[0]);
                  if (!keys) keys = segKeys;
                  else if (segKeys.length !== keys.length) throw new Error("UNION queries must return the same number of columns.");
                  else if (segKeys.join('|||') !== keys.join('|||')) {
                      // 列名が異なる場合は先頭クエリの列名へ位置ベースで揃える
                      rows = rows.map(r => {
                          const vals = Object.values(r);
                          const nr = {};
                          keys.forEach((k, i) => nr[k] = vals[i]);
                          return nr;
                      });
                  }
              }
              if (segIdx === 0) {
                  combined = rows;
              } else if (seg.op === 'UNION ALL') {
                  combined = combined.concat(rows);
              } else if (seg.op === 'INTERSECT') {
                  // 両側に存在する行のみ残す（集合演算のため重複は除去）
                  const rightSigs = new Set(rows.map(r => JSON.stringify(Object.values(r))));
                  const seen = new Set();
                  combined = combined.filter(row => {
                      const sig = JSON.stringify(Object.values(row));
                      if (!rightSigs.has(sig) || seen.has(sig)) return false;
                      seen.add(sig);
                      return true;
                  });
              } else if (seg.op === 'EXCEPT') {
                  // 右側に存在する行を除外（集合演算のため重複は除去）
                  const rightSigs = new Set(rows.map(r => JSON.stringify(Object.values(r))));
                  const seen = new Set();
                  combined = combined.filter(row => {
                      const sig = JSON.stringify(Object.values(row));
                      if (rightSigs.has(sig) || seen.has(sig)) return false;
                      seen.add(sig);
                      return true;
                  });
              } else if (seg.op === 'INTERSECT ALL') {
                  // 多重集合の積: 右側の出現回数の分だけ左側の行を残す
                  const counts = new Map();
                  rows.forEach(r2 => { const sig = JSON.stringify(Object.values(r2)); counts.set(sig, (counts.get(sig) || 0) + 1); });
                  combined = combined.filter(row => {
                      const sig = JSON.stringify(Object.values(row));
                      const n = counts.get(sig) || 0;
                      if (n <= 0) return false;
                      counts.set(sig, n - 1);
                      return true;
                  });
              } else if (seg.op === 'EXCEPT ALL') {
                  // 多重集合の差: 右側の出現1回につき左側の行を1つ取り除く
                  const counts = new Map();
                  rows.forEach(r2 => { const sig = JSON.stringify(Object.values(r2)); counts.set(sig, (counts.get(sig) || 0) + 1); });
                  combined = combined.filter(row => {
                      const sig = JSON.stringify(Object.values(row));
                      const n = counts.get(sig) || 0;
                      if (n > 0) { counts.set(sig, n - 1); return false; }
                      return true;
                  });
              } else {
                  const seen = new Set();
                  const merged = [];
                  combined.concat(rows).forEach(row => {
                      const sig = JSON.stringify(Object.values(row));
                      if (!seen.has(sig)) { seen.add(sig); merged.push(row); }
                  });
                  combined = merged;
              }
          });

          if (orderByStr && combined.length > 0) {
              // 括弧内カンマ（関数呼び出し等）を保護して分割する
              const orderCols = this.splitSelectClause(orderByStr).map(s => {
                  let e = s.trim();
                  // NULLS FIRST / LAST（SELECT 本体の ORDER BY と同じ扱い）
                  let nulls = null;
                  const nm = e.match(/\s+nulls\s+(first|last)$/i);
                  if (nm) { nulls = nm[1].toLowerCase(); e = e.slice(0, nm.index).trim(); }
                  const parts = e.split(/\s+/);
                  let colName = parts[0].replace(/^[a-zA-Z0-9_]+\./, '');
                  const desc = !!(parts[1] && parts[1].toLowerCase() === 'desc');
                  // 序数指定 (ORDER BY 1) は出力の n 番目の列を指す
                  if (/^\d+$/.test(colName)) {
                      const keys = Object.keys(combined[0]);
                      const ord = parseInt(colName, 10);
                      if (ord < 1 || ord > keys.length) throw new Error(`ORDER BY position ${ord} is out of range.`);
                      return { col: keys[ord - 1], desc, nulls };
                  }
                  let actualKey = Object.keys(combined[0]).find(k => k.toLowerCase() === colName.toLowerCase());
                  if (!actualKey) throw new Error(`Column '${colName}' not found.`);
                  return { col: actualKey, desc, nulls };
              });
              combined.sort((a, b) => {
                  for (let oc of orderCols) {
                      let valA = a[oc.col]; let valB = b[oc.col];
                      if (valA === valB) continue;
                      if (valA === null || valA === undefined) return oc.nulls ? (oc.nulls === 'first' ? -1 : 1) : (oc.desc ? 1 : -1);
                      if (valB === null || valB === undefined) return oc.nulls ? (oc.nulls === 'first' ? 1 : -1) : (oc.desc ? -1 : 1);
                      if (valA < valB) return oc.desc ? 1 : -1;
                      return oc.desc ? -1 : 1;
                  }
                  return 0;
              });
          }

          if (limitVal !== null || offsetVal !== null) {
              let offset = offsetVal !== null ? Math.max(0, parseInt(offsetVal, 10)) : 0;
              let limit = (limitVal !== null && limitVal.toLowerCase() !== 'all') ? parseInt(limitVal, 10) : combined.length;
              combined = offset >= combined.length ? [] : combined.slice(offset, offset + limit);
          }

          return { data: combined, affectedRows: combined.length };
      }
    });
