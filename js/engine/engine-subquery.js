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
              } else if (/\bNOT\s+IN\s*$/i.test(beforeStr.trim()) || /\bIN\s*$/i.test(beforeStr.trim())) {
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
                  this._materializeRows(tmpName, subResult.data);
                  expandedSql = expandedSql.slice(0, match.start) + tmpName + expandedSql.slice(match.end + 1);
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
      expandTableFunctions(sql, strMap) {
          if (!/generate_series/i.test(sql)) return sql;
          const re = /\b(FROM|JOIN)\s+GENERATE_SERIES\s*\(((?:[^()]|\([^()]*\))*)\)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\))?)?/gi;
          return sql.replace(re, (m, kw, args, aliasName, colName) => {
              const parts = this.splitSelectClause(args).map(a => {
                  const fn = this.compileCondition(a.trim(), strMap);
                  return Number(fn({}, this.tables, {}));
              });
              if (parts.length < 2 || parts.length > 3) throw new Error("GENERATE_SERIES requires 2 or 3 arguments (start, stop [, step]).");
              const start = parts[0], stop = parts[1], step = parts.length === 3 ? parts[2] : 1;
              if (!isFinite(start) || !isFinite(stop) || !isFinite(step)) throw new Error("GENERATE_SERIES arguments must be finite numbers.");
              if (step === 0) throw new Error("GENERATE_SERIES step must not be zero.");
              const col = colName ? colName.toLowerCase() : 'value';
              const rows = [];
              const GUARD = 1000000;
              if (step > 0) { for (let v = start; v <= stop; v += step) { rows.push({ [col]: v }); if (rows.length > GUARD) throw new Error("GENERATE_SERIES exceeded 1,000,000 rows."); } }
              else { for (let v = start; v >= stop; v += step) { rows.push({ [col]: v }); if (rows.length > GUARD) throw new Error("GENERATE_SERIES exceeded 1,000,000 rows."); } }
              const tmpName = '__tmp_series_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, [col]);
              return `${kw} ${tmpName}${aliasName ? ' ' + aliasName : ''}`;
          });
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
              const expanded = this.expandSubqueries(this.expandTableFunctions(this.expandViews(segSql, strMap), strMap), strMap);
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
              // 列リスト付きの WITH name(col1, col2) AS ( ... ) にも対応する
              const m = rest.match(/^([a-zA-Z0-9_]+)(?:\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\))?\s+as\s*\(/i);
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
                  body = this.expandSubqueries(this.expandTableFunctions(this.expandViews(body, strMap), strMap), strMap);
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
              else if (depth === 0 && /[uieUIE]/.test(ch) && i > 0 && /[\s)]/.test(sql[i - 1])) {
                  const m = sql.slice(i).match(/^(UNION\s+ALL|UNION\s+DISTINCT|UNION|INTERSECT\s+ALL|INTERSECT|EXCEPT\s+ALL|EXCEPT)\b/i);
                  if (m) {
                      parts.push({ sql: sql.slice(segStart, i).trim(), op: pendingOp });
                      pendingOp = m[1].toUpperCase().replace(/\s+/g, ' ');
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
