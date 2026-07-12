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

      // サブクエリ内で定義されていないテーブル修飾参照 (alias.col) を検出する。
      // 検出時は外側の行を参照する相関サブクエリとみなす。本エンジンはサブクエリを
      // 1回だけ実行して定数へ畳み込む方式のため相関は評価できず、誤った結果を
      // 返す代わりに明示的なエラーとして拒否する。
      _findOuterReference(subSql) {
          const keywords = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'on', 'as',
              'join', 'left', 'right', 'inner', 'cross', 'union', 'intersect', 'except',
              'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'is', 'null', 'true', 'false',
              'case', 'when', 'then', 'else', 'end', 'distinct', 'by', 'asc', 'desc', 'over', 'partition']);
          const defined = new Set();
          const fromRe = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
          let m;
          while ((m = fromRe.exec(subSql))) {
              defined.add(m[1].toLowerCase());
              if (m[2] && !keywords.has(m[2].toLowerCase())) defined.add(m[2].toLowerCase());
          }
          const qualRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*[a-zA-Z_]/g;
          while ((m = qualRe.exec(subSql))) {
              if (!defined.has(m[1].toLowerCase())) return m[1];
          }
          // 非修飾の同一識別子同士の比較 (col = col) は、外側の同名列を参照する意図の
          // 相関サブクエリか常に真のトートロジーのどちらかであり、正しく評価できないため拒否する
          const selfCmp = subSql.match(/(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<=|>=|<>|!=|=|<|>)\s*\1(?![\w.(])/);
          if (selfCmp && !keywords.has(selfCmp[1].toLowerCase()) && !selfCmp[1].startsWith('__')) return selfCmp[1];
          return null;
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

              const outerRef = this._findOuterReference(match.query);
              if (outerRef) {
                  throw new Error(`Correlated subqueries are not supported (outer reference '${outerRef}' in subquery).`);
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
                  const t = new Table();
                  if (subResult.data && subResult.data.length > 0) {
                      const keys = Object.keys(subResult.data[0]);
                      keys.forEach(k => t.addColumn(k));
                      while(t.capacity < subResult.data.length) t.grow();
                      subResult.data.forEach((row, i) => {
                          keys.forEach(k => t.setValue(k, i, row[k]));
                      });
                      t.rowCount = subResult.data.length;
                  }
                  this.tables[tmpName] = t;
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

      // WITH name AS (SELECT ...), ... <本体>: CTE を一時テーブルへ実体化し、
      // 本体クエリ中の参照を一時テーブル名に置換して返す
      _expandCTEs(sql, strMap) {
          let rest = sql.replace(/^with\s+/i, '');
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
              const m = rest.match(/^([a-zA-Z0-9_]+)\s+as\s*\(/i);
              if (!m) throw new Error("Syntax Error in WITH clause. Use WITH name AS (SELECT ...).");
              const name = m[1].toLowerCase();
              // 対応する閉じ括弧を探す
              let depth = 0, start = m[0].length - 1, end = -1;
              for (let i = start; i < rest.length; i++) {
                  if (rest[i] === '(') depth++;
                  else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
              }
              if (end === -1) throw new Error("Syntax Error in WITH clause: unbalanced parentheses.");

              // 先行して定義された CTE の参照を解決してから実行する
              let body = replaceRefs(rest.slice(start + 1, end).trim());
              body = this.expandSubqueries(this.expandViews(body, strMap), strMap);
              const res = this.executeQuery(body, true, strMap);
              if (res.error) throw new Error(`CTE '${name}': ${res.error}`);

              const tmpName = '__tmp_cte_' + name;
              const t = new Table();
              if (res.data && res.data.length > 0) {
                  const keys = Object.keys(res.data[0]);
                  keys.forEach(k => t.addColumn(k));
                  while (t.capacity < res.data.length) t.grow();
                  res.data.forEach((row, i) => keys.forEach(k => t.setValue(k, i, row[k])));
                  t.rowCount = res.data.length;
              }
              this.tables[tmpName] = t;
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
                  const m = sql.slice(i).match(/^(UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/i);
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
          let limitVal = null, offsetVal = null, orderByStr = null;
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
          const restoreOver = (s) => s === null ? null : s.replace(/__OVER_(\d+)__/g, (mm, i) => overMap[i]);
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
              const orderCols = orderByStr.split(',').map(s => {
                  const parts = s.trim().split(/\s+/);
                  let colName = parts[0].replace(/^[a-zA-Z0-9_]+\./, '');
                  const desc = parts[1] && parts[1].toLowerCase() === 'desc';
                  // 序数指定 (ORDER BY 1) は出力の n 番目の列を指す
                  if (/^\d+$/.test(colName)) {
                      const keys = Object.keys(combined[0]);
                      const ord = parseInt(colName, 10);
                      if (ord < 1 || ord > keys.length) throw new Error(`ORDER BY position ${ord} is out of range.`);
                      return { col: keys[ord - 1], desc };
                  }
                  let actualKey = Object.keys(combined[0]).find(k => k.toLowerCase() === colName.toLowerCase());
                  if (!actualKey) throw new Error(`Column '${colName}' not found.`);
                  return { col: actualKey, desc };
              });
              combined.sort((a, b) => {
                  for (let oc of orderCols) {
                      let valA = a[oc.col]; let valB = b[oc.col];
                      if (valA === valB) continue;
                      if (valA === null || valA === undefined) return oc.desc ? 1 : -1;
                      if (valB === null || valB === undefined) return oc.desc ? -1 : 1;
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
