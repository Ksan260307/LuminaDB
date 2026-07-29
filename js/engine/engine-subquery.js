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

      expandSubqueries(sql, strMap) {
          let expandedSql = sql;
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

              let subResult = this.executeQuery(match.query, true, strMap);
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
                  const vals = subResult.data.map(r => Object.values(r)[0]);
                  const valsStr = vals.map(v => {
                      if (typeof v === 'string') {
                          strMap.push(this._quoteLiteral(v));
                          return `__STR_${strMap.length - 1}__`;
                      }
                      return v;
                  }).join(', ');
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
                  this._materializeRows(tmpName, subResult.data, colNames);
                  expandedSql = expandedSql.slice(0, match.start) + tmpName + after;
              } else {
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

      expandTableFunctions(sql, strMap) {
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
          const re = /\b(FROM|JOIN)\s+(STRING_SPLIT|UNNEST)\s*\(((?:[^()]|\([^()]*\))*)\)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\))?)?/gi;
          return sql.replace(re, (m, kw, fn, args, aliasName, colName) => {
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
                  rows = parts.map(v => ({ [col]: v === undefined ? null : v }));
              }
              const tmpName = '__tmp_split_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, [col]);
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

      // <left> CROSS|OUTER APPLY (subquery) [alias]  /  <left> [,|JOIN] LATERAL (subquery) [alias]
      //   左の各行に対しサブクエリを評価して連結する（相関可）。結果は一時テーブルへ実体化する。
      _expandOneApply(sql, strMap) {
          const km = sql.match(/\b(?:(CROSS|OUTER)\s+APPLY|LATERAL)\s+/i);
          if (!km) return sql;
          const kind = km[1] ? km[1].toUpperCase() : 'CROSS'; // LATERAL は CROSS APPLY 相当
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
          const consumedEnd = rightEnd + (rightAlias ? aliasM[0].length : 0);

          // APPLY より前の部分から「左側クエリ」を組み立てて行を得る（LATERAL 前のカンマも消費する）
          const before = sql.slice(0, km.index).trim().replace(/,\s*$/, '');
          if (!/^select\b/i.test(before)) throw new Error("APPLY / LATERAL must follow a SELECT ... FROM clause.");
          const leftSql = before.replace(/^select\s+(?:distinct\s+)?[\s\S]*?\s+from\s+/i, 'SELECT * FROM ');
          const leftRes = this.executeQuery(leftSql, true, strMap);
          if (leftRes.error) throw new Error("APPLY left side failed: " + leftRes.error);
          const leftRows = leftRes.data;

          // 左表の別名（相関参照 a.col の解決に使う）
          const leftFromM = before.match(/\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/i);
          const leftAlias = leftFromM ? (leftFromM[2] || leftFromM[1]).toLowerCase() : null;
          const leftTable = leftFromM ? leftFromM[1].toLowerCase() : null;

          const innerRaw = rightText.startsWith('(') ? rightText.slice(1, -1).trim() : `SELECT * FROM ${rightText}`;
          const outRows = [];
          let rightCols = null;
          for (const lrow of leftRows) {
              const lc = {};
              for (const k in lrow) lc[k.toLowerCase()] = lrow[k];
              // 相関参照（<alias>.col / 素の列名）を左行の値リテラルへ差し替える
              let q = innerRaw;
              if (leftAlias) q = q.replace(new RegExp('\\b' + leftAlias + '\\.([a-zA-Z0-9_]+)\\b', 'gi'), (mm, c) => this._literalOf(lc[c.toLowerCase()]));
              if (leftTable && leftTable !== leftAlias) q = q.replace(new RegExp('\\b' + leftTable + '\\.([a-zA-Z0-9_]+)\\b', 'gi'), (mm, c) => this._literalOf(lc[c.toLowerCase()]));
              const rres = this.executeQuery(q);
              if (rres.error) throw new Error("APPLY subquery failed: " + rres.error);
              if (rres.data.length > 0 && !rightCols) rightCols = Object.keys(rres.data[0]);
              if (rres.data.length === 0) {
                  if (kind === 'OUTER') outRows.push({ ...lrow, __apply_null: 1 });
                  continue;
              }
              rres.data.forEach(rr => {
                  const merged = { ...lrow };
                  for (const k in rr) merged[k] = rr[k];
                  outRows.push(merged);
              });
          }
          // OUTER APPLY の非マッチ行は右側列を NULL で補う
          const leftCols = leftRows.length > 0 ? Object.keys(leftRows[0]) : [];
          const allCols = [...leftCols];
          (rightCols || []).forEach(c => { if (!allCols.includes(c)) allCols.push(c); });
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
          const stripQual = (txt) => {
              let s = txt;
              [leftAlias, leftTable, rightAlias].forEach(a => {
                  if (a) s = s.replace(new RegExp('\\b' + a + '\\.', 'gi'), '');
              });
              return s;
          };
          const selList = stripQual(selHead ? selHead[2] : '*');
          const rest = stripQual(sql.slice(consumedEnd));
          return `SELECT ${distinctTxt}${selList} FROM ${tmpName}${rest}`;
      },

      // 再帰CTE (WITH RECURSIVE): アンカー部の行を初期作業集合とし、再帰部を
      // 「前イテレーションの行だけが見える作業テーブル」に対して繰り返し実行する。
      // UNION（重複除去）は累積集合と重複した行を捨てることで循環データでも収束する。
      // UNION ALL は無限再帰し得るため反復回数と行数に上限を設ける。
      _materializeRecursiveCTE(cteName, body, tmpName, strMap, colNames) {
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

          anchor.forEach(seg => addRows(runSeg(seg.sql), working));
          let iter = 0;
          while (working.length > 0 && recursive.length > 0) {
              if (++iter > 500) throw new Error(`Recursive CTE '${cteName}' exceeded 500 iterations. Add a termination condition (or use UNION instead of UNION ALL).`);
              if (acc.length > 100000) throw new Error(`Recursive CTE '${cteName}' exceeded 100,000 rows.`);
              this._materializeRows(workName, working);
              const next = [];
              recursive.forEach(seg => addRows(runSeg(replaceSelfRef(seg.sql)), next));
              working = next;
          }
          delete this.tables[workName];
          this._materializeRows(tmpName, acc, colNames);
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
              if (isRecursive && new RegExp(`\\b(?:from|join)\\s+${name}\\b`, 'i').test(body)) {
                  // 自己参照あり → 再帰CTE（サブクエリ展開は各セグメントの実行時に行う）
                  this._materializeRecursiveCTE(name, body, tmpName, strMap, colNames);
              } else {
                  body = this.expandSubqueries(this.expandRelationalOps(this.expandTableFunctions(this.expandViews(this.expandInfoSchema(body), strMap), strMap), strMap), strMap);
                  const res = this.executeQuery(body, true, strMap);
                  if (res.error) throw new Error(`CTE '${name}': ${res.error}`);
                  this._materializeRows(tmpName, res.data, colNames);
              }
              cteMap[name] = tmpName;

              rest = rest.slice(end + 1).trim();
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
                      parts.push({ sql: sql.slice(segStart, i).trim(), op: pendingOp });
                      pendingOp = m[1].toUpperCase().replace(/\s+/g, ' ').replace(/^MINUS/, 'EXCEPT');
                      i += m[0].length;
                      segStart = i;
                      continue;
                  }
              }
              i++;
          }
          parts.push({ sql: sql.slice(segStart).trim(), op: pendingOp });
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
          segments[segments.length - 1].sql = restoreOver(lastSql).trim();
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
