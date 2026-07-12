    // ============================================================================
    // [DatabaseEngine Select] - SELECT の解析 / 最適化 / 実行
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      // 集計関数呼び出し 1 件を compiledSelects 用の記述子へ変換する
      // （SELECT 句 / HAVING / ORDER BY の集計書き換えで共用）
      _compileAggSelect(func, argExpr, strMap, alias) {
          argExpr = (argExpr || '').trim();
          // COUNT(DISTINCT col) / SUM(DISTINCT col) などの重複除外集計
          let isDistinctAgg = false;
          if (/^DISTINCT\s+/i.test(argExpr)) {
              isDistinctAgg = true;
              argExpr = argExpr.replace(/^DISTINCT\s+/i, '');
          }
          // GROUP_CONCAT(col SEPARATOR 'x'): 区切り文字の指定（既定はカンマ）
          let separator = ',';
          const sepMatch = argExpr.match(/^([\s\S]+?)\s+SEPARATOR\s+__STR_(\d+)__$/i);
          if (sepMatch) {
              argExpr = sepMatch[1];
              separator = this._unquoteLiteral(strMap[Number(sepMatch[2])]);
          }
          const argFunc = argExpr && argExpr !== '*' ? this.compileCondition(argExpr, strMap) : null;
          return { type: 'agg', func, argFunc, distinct: isDistinctAgg, separator, alias };
      },

      // 式文字列中の集計関数呼び出しを隠し集計列（prefix + 連番）への参照に書き換え、
      // 対応する集計記述子を compiledSelects へ追加する。
      // HAVING COUNT(*) > 1 / ORDER BY SUM(x) DESC のような直接集計参照を可能にする
      _rewriteAggCalls(str, compiledSelects, strMap, prefix) {
          return str.replace(/\b(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV|VARIANCE|MEDIAN)\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (m, fn, arg) => {
              const alias = `${prefix}${compiledSelects.length}`;
              compiledSelects.push(this._compileAggSelect(fn.toUpperCase(), arg, strMap, alias));
              return ` ${alias} `;
          });
      },

      _parseSelect(sql) {
          let tempSql = sql;
          let limitVal = null, offsetVal = null, orderByStr = null, havingStr = null, groupByStr = null, whereStr = null;

          let overMap = [];
          tempSql = tempSql.replace(/\bOVER\s*\((?:[^)(]+|\([^)(]*\))*\)/gi, (m) => {
              overMap.push(m);
              return `__OVER_${overMap.length - 1}__`;
          });

          // MySQL 形式 LIMIT offset, count を先に判定する（単独 LIMIT の誤マッチを防ぐ）
          // 小数は切り捨て、負の OFFSET は 0 扱い（適用側で解釈。FROM 句の残余判定を汚さないようここで消費する）
          const limitCommaMatch = tempSql.match(/\s+limit\s+(\d+)\s*,\s*(\d+)/i);
          if (limitCommaMatch) {
              offsetVal = limitCommaMatch[1];
              limitVal = limitCommaMatch[2];
              tempSql = tempSql.replace(limitCommaMatch[0], '');
          } else {
              const limitMatch = tempSql.match(/\s+limit\s+(\d+(?:\.\d+)?|all)/i);
              if(limitMatch) { limitVal = limitMatch[1]; tempSql = tempSql.replace(limitMatch[0], ''); }
          }
          const offsetMatch = tempSql.match(/\s+offset\s+(-?\d+(?:\.\d+)?)/i);
          if(offsetMatch) { offsetVal = offsetMatch[1]; tempSql = tempSql.replace(offsetMatch[0], ''); }

          const oMatch = tempSql.match(/\s+order\s+by\s+([\s\S]+)$/i);
          if(oMatch) { orderByStr = oMatch[1]; tempSql = tempSql.substring(0, oMatch.index); }

          const hMatch = tempSql.match(/\s+having\s+([\s\S]+)$/i);
          if(hMatch) { havingStr = hMatch[1]; tempSql = tempSql.substring(0, hMatch.index); }

          const gMatch = tempSql.match(/\s+group\s+by\s+([\s\S]+)$/i);
          if(gMatch) { groupByStr = gMatch[1]; tempSql = tempSql.substring(0, gMatch.index); }

          const wMatch = tempSql.match(/\s+where\s+([\s\S]+)$/i);
          if(wMatch) { whereStr = wMatch[1]; tempSql = tempSql.substring(0, wMatch.index); }

          // CROSS JOIN は常に真となる ON 条件付きの JOIN へ正規化する（直積）
          tempSql = tempSql.replace(/\bCROSS\s+JOIN\s+([a-zA-Z0-9_]+)((?:\s+(?:AS\s+)?(?!LEFT\b|INNER\b|RIGHT\b|CROSS\b|JOIN\b|ON\b)[a-zA-Z0-9_]+)?)/gi, 'JOIN $1$2 ON 1 = 1');

          const joins = [];
          const joinRegex = /\b(LEFT\s+|INNER\s+|RIGHT\s+)?JOIN\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s+ON\s+([\s\S]+?)(?=\b(?:LEFT|INNER|RIGHT)?\s*JOIN\b|$)/gi;
          let jMatch;
          let firstJoinIdx = -1;
          while ((jMatch = joinRegex.exec(tempSql)) !== null) {
              if (firstJoinIdx === -1) firstJoinIdx = jMatch.index;
              joins.push({ type: jMatch[1] ? jMatch[1].trim().toUpperCase() : 'INNER', table: jMatch[2].toLowerCase(), alias: (jMatch[3] || jMatch[2]).toLowerCase(), onCond: jMatch[4].trim() });
          }
          if (joins.length > 0) tempSql = tempSql.substring(0, firstJoinIdx);

          const fMatch = tempSql.match(/^select\s+(distinct\s+)?([\s\S]+?)\s+from\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/i);
          if(!fMatch) {
              // FROM 句なしの定数 SELECT (例: SELECT 1+1): 1行のダミーテーブル上で評価する
              const nfMatch = tempSql.match(/^select\s+(distinct\s+)?([\s\S]+)$/i);
              if (nfMatch && !/\bfrom\b/i.test(tempSql)) {
                  const selectClause = nfMatch[2].trim().replace(/__OVER_(\d+)__/g, (m, idx) => overMap[idx]);
                  return {
                      isDistinct: !!nfMatch[1], selectClause, fromTable: '__tmp_dual', baseAlias: '__tmp_dual',
                      joins: [], whereStr, groupByStr, havingStr, orderByStr, limitVal, offsetVal
                  };
              }
              throw new Error("Syntax error in SELECT statement.");
          }

          const isDistinct = !!fMatch[1];
          let selectClause = fMatch[2].trim();
          selectClause = selectClause.replace(/__OVER_(\d+)__/g, (m, idx) => overMap[idx]);
          const fromTable = fMatch[3].trim().toLowerCase();
          const baseAlias = (fMatch[4] ? fMatch[4].trim() : fromTable).toLowerCase();

          // FROM 句のカンマ区切りテーブル（暗黙の直積結合）を CROSS JOIN 相当へ正規化する。
          // 従来は 2 つ目以降が無言で無視され誤った結果を返していたため、
          // 解釈できない残余があれば構文エラーとして明示する
          let fromRest = tempSql.slice(fMatch.index + fMatch[0].length);
          const commaJoins = [];
          let cjm;
          while ((cjm = fromRest.match(/^\s*,\s*([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/i))) {
              commaJoins.push({ type: 'INNER', table: cjm[1].toLowerCase(), alias: (cjm[2] || cjm[1]).toLowerCase(), onCond: '1 = 1' });
              fromRest = fromRest.slice(cjm[0].length);
          }
          if (fromRest.trim() !== '') {
              throw new Error(`Syntax error in FROM clause near '${fromRest.trim().slice(0, 30)}'.`);
          }
          if (commaJoins.length > 0) joins.unshift(...commaJoins);

          return {
              isDistinct, selectClause, fromTable, baseAlias,
              joins, whereStr, groupByStr, havingStr, orderByStr, limitVal, offsetVal
          };
      },

      _optimizeSelect(parsed, isExplain, strMap) {
          const { fromTable, baseAlias, joins, whereStr, groupByStr, havingStr, orderByStr, limitVal } = parsed;
          // FROM 句なし SELECT 用の 1 行ダミーテーブル（クエリ終了時に __tmp_ 掃除で消える）
          if (fromTable === '__tmp_dual' && !this.tables['__tmp_dual']) {
              const dual = new Table(1);
              dual.addColumn('dummy');
              dual.setValue('dummy', 0, 1);
              dual.rowCount = 1;
              this.tables['__tmp_dual'] = dual;
          }
          if (!this.tables[fromTable]) throw new Error(`Table '${fromTable}' not found.`);

          const baseTbl = this.tables[fromTable];
          let isIndexScan = false;
          let indexScanCol = null;
          let indexValStr = null;
          let residualWhere = whereStr;

          let aliases = { [fromTable]: fromTable, [baseAlias]: fromTable };

          if (whereStr) {
              const wMatch = whereStr.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/) || whereStr.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/);
              let col = wMatch ? (wMatch.length === 4 ? wMatch[2].toLowerCase() : wMatch[1].toLowerCase()) : null;
              let tblAlias = wMatch && wMatch.length === 4 ? wMatch[1].toLowerCase() : null;
              let valStr = wMatch ? (wMatch.length === 4 ? wMatch[3] : wMatch[2]) : null;

              // インデックス直接参照は右辺が単純リテラル（数値 / 文字列トークン / NULL / 真偽値）の
              // 場合のみ。式・列参照・関数を許すと値の評価をせず Map.get することになり
              // 誤って 0 件を返すため、それ以外は通常の WHERE 評価へフォールバックする
              const isLiteralVal = valStr !== null &&
                  /^(?:__STR_\d+__|null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(valStr.trim());
              if (col && (!tblAlias || tblAlias === baseAlias || tblAlias === fromTable) && baseTbl.indices[col] && isLiteralVal) {
                  isIndexScan = true;
                  indexScanCol = col;
                  indexValStr = valStr.trim();
                  residualWhere = null;
              }
          }

          let explainPlan = [];
          if (isExplain) {
              if (isIndexScan) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'INDEX SCAN', Details: `Index scan on '${fromTable}(${indexScanCol})'` });
              else explainPlan.push({ Step: explainPlan.length + 1, Operation: 'TABLE SCAN', Details: `Full scan on '${fromTable}'` });
          }

          const joinPlans = joins.map(join => {
              if (!this.tables[join.table]) throw new Error(`Join Table '${join.table}' not found.`);
              aliases[join.table] = join.table;
              aliases[join.alias] = join.table;

              let jTbl = this.tables[join.table];
              let isHashJoin = false;
              let leftAliasMatch, leftColMatch, rightAliasMatch, rightColMatch;

              const eqMatch = join.onCond.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*$/);
              if (eqMatch) {
                  let a1 = eqMatch[1].toLowerCase(), c1 = eqMatch[2].toLowerCase(), a2 = eqMatch[3].toLowerCase(), c2 = eqMatch[4].toLowerCase();
                  if (aliases[a1] && a2 === join.alias) {
                      leftAliasMatch = a1; leftColMatch = c1; rightAliasMatch = a2; rightColMatch = c2; isHashJoin = true;
                  } else if (aliases[a2] && a1 === join.alias) {
                      leftAliasMatch = a2; leftColMatch = c2; rightAliasMatch = a1; rightColMatch = c1; isHashJoin = true;
                  }
              }

              if (isExplain) {
                  if (isHashJoin) {
                      if (jTbl.indices[rightColMatch]) {
                          explainPlan.push({ Step: explainPlan.length + 1, Operation: 'INDEX HASH JOIN', Details: `Join '${join.table}' using index on '${rightColMatch}'` });
                      } else {
                          explainPlan.push({ Step: explainPlan.length + 1, Operation: 'HASH JOIN', Details: `Build hash on '${join.table}.${rightColMatch}', probe with '${leftAliasMatch}.${leftColMatch}'` });
                      }
                  } else {
                          explainPlan.push({ Step: explainPlan.length + 1, Operation: 'NESTED LOOP JOIN', Details: `Join '${join.table}' ON ${join.onCond}` });
                  }
              }

              return { ...join, isHashJoin, leftAliasMatch, leftColMatch, rightAliasMatch, rightColMatch };
          });

          if (isExplain) {
              if (residualWhere) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'FILTER', Details: `Apply WHERE ${residualWhere}` });
              if (groupByStr) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'GROUP BY', Details: `Group by ${groupByStr}` });
              if (havingStr) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'HAVING', Details: `Filter by ${havingStr}` });
              if (orderByStr) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'ORDER BY', Details: `Order by ${orderByStr}` });
              if (limitVal) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'LIMIT', Details: `Limit ${limitVal}` });
          }

          return { parsed, isIndexScan, indexScanCol, indexValStr, residualWhere, aliases, joinPlans, explainPlan, isExplain };
      },

      _executeSelectPlan(plan, strMap) {
          if (plan.isExplain) {
              return { data: plan.explainPlan, affectedRows: plan.explainPlan.length };
          }

          const { parsed, isIndexScan, indexScanCol, indexValStr, residualWhere, aliases, joinPlans } = plan;
          const { isDistinct, selectClause, fromTable, baseAlias, groupByStr, havingStr, orderByStr, limitVal, offsetVal } = parsed;

          let rowPtrs = [];
          const baseTbl = this.tables[fromTable];

          if (isIndexScan) {
              let val = indexValStr;
              if (val.startsWith('__STR_')) {
                  let strIdx = parseInt(val.replace('__STR_', '').replace('__', ''));
                  val = this._unquoteLiteral(strMap[strIdx]);
              } else if (val.toLowerCase() === 'null') {
                  val = null;
              } else if (val.toLowerCase() === 'true') {
                  val = true;
              } else if (val.toLowerCase() === 'false') {
                  val = false;
              } else if (!isNaN(val)) {
                  val = Number(val);
              }
              let matchedIndices = baseTbl.indices[indexScanCol].get(val);
              if (matchedIndices) {
                  for(let i of matchedIndices) {
                      rowPtrs.push({ [fromTable]: i, [baseAlias]: i });
                  }
              }
          } else {
              for(let i=0; i<baseTbl.rowCount; i++) {
                  rowPtrs.push({ [fromTable]: i, [baseAlias]: i });
              }
          }

          let ptrKeys = [fromTable, baseAlias];
          joinPlans.forEach(join => {
              let jTbl = this.tables[join.table];
              // RIGHT JOIN: マッチした右テーブル行を追跡し、未マッチ行を後段で補完する
              const matchedRight = join.type === 'RIGHT' ? new Set() : null;
              let newPtrs = [];
              if (join.isHashJoin) {
                  let rightMap = new Map();
                  if (jTbl.indices[join.rightColMatch]) {
                      rightMap = jTbl.indices[join.rightColMatch];
                  } else {
                      for(let j=0; j<jTbl.rowCount; j++) {
                          let v = jTbl.getValue(join.rightColMatch, j);
                          if(v !== null && v !== undefined) {
                              let arr = rightMap.get(v);
                              if(!arr) { arr = []; rightMap.set(v, arr); }
                              arr.push(j);
                          }
                      }
                  }

                  rowPtrs.forEach(ptr => {
                      let leftActualTbl = aliases[join.leftAliasMatch];
                      let leftVal = this.tables[leftActualTbl].getValue(join.leftColMatch, ptr[join.leftAliasMatch]);

                      let matchedIndices = (leftVal !== null && leftVal !== undefined) ? rightMap.get(leftVal) : null;
                      if (matchedIndices) {
                          for(let j of matchedIndices) {
                              newPtrs.push({ ...ptr, [join.table]: j, [join.alias]: j });
                              if (matchedRight) matchedRight.add(j);
                          }
                      } else if (join.type === 'LEFT') {
                          newPtrs.push({ ...ptr, [join.table]: -1, [join.alias]: -1 });
                      }
                  });
              } else {
                  let onFunc = this.compileCondition(join.onCond, strMap);
                  rowPtrs.forEach(ptr => {
                      let matched = false;
                      for(let j=0; j<jTbl.rowCount; j++) {
                          let combPtr = { ...ptr, [join.table]: j, [join.alias]: j };
                          if (onFunc(combPtr, this.tables, aliases)) {
                              newPtrs.push(combPtr);
                              matched = true;
                              if (matchedRight) matchedRight.add(j);
                          }
                      }
                      if (!matched && join.type === 'LEFT') {
                          newPtrs.push({ ...ptr, [join.table]: -1, [join.alias]: -1 });
                      }
                  });
              }
              if (matchedRight) {
                  // 未マッチの右テーブル行を、左側の全ポインタを NULL(-1) にして追加
                  for (let j = 0; j < jTbl.rowCount; j++) {
                      if (!matchedRight.has(j)) {
                          const nullPtr = {};
                          ptrKeys.forEach(k => nullPtr[k] = -1);
                          nullPtr[join.table] = j;
                          nullPtr[join.alias] = j;
                          newPtrs.push(nullPtr);
                      }
                  }
              }
              rowPtrs = newPtrs;
              ptrKeys.push(join.table, join.alias);
          });

          if (residualWhere) {
              let whereFunc = this.compileCondition(residualWhere, strMap);
              rowPtrs = rowPtrs.filter(ptr => whereFunc(ptr, this.tables, aliases));
          }

          let selectParts = this.splitSelectClause(selectClause);
          let windowFuncs = [];

          let compiledSelects = selectParts.map((part, partIdx) => {
              const asMatch = part.match(/(.+?)\s+AS\s+([a-zA-Z0-9_]+)$/i);
              let expr = asMatch ? asMatch[1].trim() : part.trim();
              let alias = asMatch ? asMatch[2] : expr.replace(/^[a-zA-Z0-9_]+\./, '');
              if (expr === '*') return { type: 'star' };

              let wfMatch = expr.match(/^([a-zA-Z_]+)\s*\((.*?)\)\s+OVER\s*\((.*?)\)$/i);
              if (wfMatch) {
                  let funcName = wfMatch[1].toUpperCase();
                  let argStr = wfMatch[2].trim();
                  // LAG(expr, offset) / LEAD(expr, offset) のようにカンマ区切り引数を許容
                  let argParts = argStr ? this.splitSelectClause(argStr) : [];
                  let firstArg = argParts[0] && argParts[0] !== '*' ? argParts[0] : null;
                  let argFunc = firstArg ? this.compileCondition(firstArg, strMap) : null;
                  let argOffset = argParts.length > 1 ? parseInt(argParts[1], 10) : 1;
                  if (isNaN(argOffset)) argOffset = 1;
                  let overStr = wfMatch[3].trim();

                  let pMatch = overStr.match(/PARTITION\s+BY\s+(.+?)(?:\s+ORDER\s+BY\s+(.+))?$/i);
                  let partitionCols = [], orderCols = [];
                  if (pMatch) {
                      partitionCols = pMatch[1].split(',').map(s=>s.trim());
                      if (pMatch[2]) orderCols = pMatch[2].split(',').map(s=>s.trim());
                  } else {
                      let oMatch = overStr.match(/ORDER\s+BY\s+(.+)$/i);
                      if (oMatch) orderCols = oMatch[1].split(',').map(s=>s.trim());
                  }

                  let pFuncs = partitionCols.map(c => this.compileCondition(c, strMap));
                  let oFuncs = orderCols.map(s => {
                      let p = s.trim().split(/\s+/);
                      return { eval: this.compileCondition(p[0], strMap), desc: p[1] && p[1].toUpperCase() === 'DESC' };
                  });

                  let wfId = `__wf_${partIdx}`;
                  windowFuncs.push({ wfId, funcName, argFunc, argOffset, pFuncs, oFuncs });

                  return { type: 'window', wfId, alias };
              }

              if (/^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV|VARIANCE|MEDIAN)\(/i.test(expr)) {
                  let m = expr.match(/^(COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STDDEV|VARIANCE|MEDIAN)\(\s*([\s\S]*?)\s*\)$/i);
                  return this._compileAggSelect(m ? m[1].toUpperCase() : 'COUNT', m ? m[2] : '', strMap, alias);
              }
              let evalFunc = this.compileCondition(expr, strMap);
              return { type: 'expr', evalFunc, alias };
          });

          // HAVING 句に直接書かれた集計呼び出し（HAVING COUNT(*) > 1 等）を
          // 隠し集計列 __hv_N へ書き換え、集計ループで値を算出できるようにする
          let havingStrEff = havingStr;
          if (havingStrEff) {
              havingStrEff = this._rewriteAggCalls(havingStrEff, compiledSelects, strMap, '__hv_');
          }

          let isAgg = compiledSelects.some(sel => sel.type === 'agg');

          // ORDER BY の前処理: 括弧内カンマを保護して分割し、方向指定を切り出す
          let orderItems = null;
          if (orderByStr) {
              orderItems = this.splitSelectClause(orderByStr).map(s => {
                  let e = s.trim();
                  let desc = false;
                  const dm = e.match(/\s+(asc|desc)$/i);
                  if (dm) { desc = dm[1].toLowerCase() === 'desc'; e = e.slice(0, dm.index).trim(); }
                  return { expr: e, desc, isOrdinal: /^\d+$/.test(e), attachKey: null, attachFailed: false };
              });
              // 集計クエリでは ORDER BY 内の集計呼び出し（ORDER BY COUNT(*) DESC 等）を
              // 隠し集計列 __oba_N へ書き換える
              if (isAgg || groupByStr) {
                  orderItems.forEach(item => {
                      if (item.isOrdinal || /^[a-zA-Z0-9_.]+$/.test(item.expr)) return;
                      const before = compiledSelects.length;
                      const rewritten = this._rewriteAggCalls(item.expr, compiledSelects, strMap, '__oba_');
                      if (compiledSelects.length > before && isDistinct) {
                          throw new Error("For SELECT DISTINCT, ORDER BY expressions must appear in the select list.");
                      }
                      item.expr = rewritten.trim();
                  });
              }
          }

          if (windowFuncs.length > 0 && !isAgg && !groupByStr) {
              windowFuncs.forEach(wf => {
                  // キーはデータ値由来のため null プロトタイプ（'__proto__' 等の値による汚染防止）
                  let partitions = Object.create(null);
                  if (wf.pFuncs.length > 0) {
                      rowPtrs.forEach(ptr => {
                          let key = wf.pFuncs.map(f => f(ptr, this.tables, aliases)).join('|||');
                          if (!partitions[key]) partitions[key] = [];
                          partitions[key].push(ptr);
                      });
                  } else {
                      partitions['all'] = [...rowPtrs];
                  }

                  for (let key in partitions) {
                      let pRows = partitions[key];
                      if (wf.oFuncs.length > 0) {
                          pRows.sort((a, b) => {
                              for (let ofunc of wf.oFuncs) {
                                  let va = ofunc.eval(a, this.tables, aliases);
                                  let vb = ofunc.eval(b, this.tables, aliases);
                                  if (va === vb) continue;
                                  if (va === null || va === undefined) return ofunc.desc ? 1 : -1;
                                  if (vb === null || vb === undefined) return ofunc.desc ? -1 : 1;
                                  if (va < vb) return ofunc.desc ? 1 : -1;
                                  return ofunc.desc ? -1 : 1;
                              }
                              return 0;
                          });
                      }

                      let sum = 0, cnt = 0, best = null;
                      let rank = 0, denseRank = 0;
                      let currentRankValStr = null;

                      pRows.forEach((ptr, idx) => {
                          let val = null;
                          if (wf.funcName === 'ROW_NUMBER') {
                              val = idx + 1;
                          } else if (wf.funcName === 'RANK' || wf.funcName === 'DENSE_RANK') {
                              let rankValStr = wf.oFuncs.map(f => f.eval(ptr, this.tables, aliases)).join('|||');
                              if (rankValStr !== currentRankValStr) {
                                  rank = idx + 1;
                                  denseRank++;
                                  currentRankValStr = rankValStr;
                              }
                              val = wf.funcName === 'RANK' ? rank : denseRank;
                          } else if (wf.funcName === 'SUM') {
                              let argVal = wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : 0;
                              if (typeof argVal === 'number') sum += argVal;
                              val = sum;
                          } else if (wf.funcName === 'COUNT') {
                              if (!wf.argFunc) cnt++;
                              else {
                                  let argVal = wf.argFunc(ptr, this.tables, aliases);
                                  if (argVal !== null && argVal !== undefined) cnt++;
                              }
                              val = cnt;
                          } else if (wf.funcName === 'AVG') {
                              let argVal = wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : null;
                              if (typeof argVal === 'number') { sum += argVal; cnt++; }
                              val = cnt > 0 ? Number((sum / cnt).toFixed(2)) : null;
                          } else if (wf.funcName === 'MIN' || wf.funcName === 'MAX') {
                              let argVal = wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : null;
                              if (argVal !== null && argVal !== undefined) {
                                  if (best === null) best = argVal;
                                  else if (wf.funcName === 'MIN' ? argVal < best : argVal > best) best = argVal;
                              }
                              val = best;
                          } else if (wf.funcName === 'LAG' || wf.funcName === 'LEAD') {
                              const tIdx = wf.funcName === 'LAG' ? idx - wf.argOffset : idx + wf.argOffset;
                              val = (tIdx >= 0 && tIdx < pRows.length && wf.argFunc)
                                  ? wf.argFunc(pRows[tIdx], this.tables, aliases)
                                  : null;
                          } else if (wf.funcName === 'NTILE') {
                              // NTILE(n): パーティションを n 個のバケットへ等分割（先頭側を大きく）
                              const n = Math.max(1, Math.floor(wf.argFunc ? Number(wf.argFunc(ptr, this.tables, aliases)) : 1));
                              const size = pRows.length;
                              const per = Math.floor(size / n), rem = size % n;
                              val = idx < rem * (per + 1)
                                  ? Math.floor(idx / (per + 1)) + 1
                                  : rem + Math.floor((idx - rem * (per + 1)) / Math.max(1, per)) + 1;
                          } else if (wf.funcName === 'FIRST_VALUE') {
                              val = wf.argFunc ? wf.argFunc(pRows[0], this.tables, aliases) : null;
                          } else if (wf.funcName === 'LAST_VALUE') {
                              // フレーム指定は未対応のためパーティション全体の最終値を返す
                              val = wf.argFunc ? wf.argFunc(pRows[pRows.length - 1], this.tables, aliases) : null;
                          }
                          ptr[wf.wfId] = val;
                      });

                      // ORDER BY なしの集計系ウィンドウ関数はパーティション全体の値を全行へ適用
                      if (wf.oFuncs.length === 0 && ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].includes(wf.funcName)) {
                          const lastVal = pRows.length > 0 ? pRows[pRows.length - 1][wf.wfId] : null;
                          pRows.forEach(ptr => ptr[wf.wfId] = lastVal);
                      }
                  }
              });
          }

          // キーはデータ値由来のため null プロトタイプ（'__proto__' 等の値による汚染防止）
          let groups = Object.create(null);
          if (groupByStr) {
              let groupFuncs = groupByStr.split(',').map(s => this.compileCondition(s.trim(), strMap));
              rowPtrs.forEach(ptr => {
                  let key = groupFuncs.map(f => f(ptr, this.tables, aliases)).join('|||');
                  if(!groups[key]) groups[key] = [];
                  groups[key].push(ptr);
              });
          } else {
              groups['all'] = rowPtrs;
          }

          let resultSet = [];
          if (isAgg || groupByStr) {
              let aggResults = [];
              Object.keys(groups).forEach(key => {
                  let groupPtrs = groups[key];
                  let aggRow = {};
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'agg') {
                          if (sel.func === 'COUNT') {
                              if (!sel.argFunc) {
                                  aggRow[sel.alias] = groupPtrs.length;
                              } else if (sel.distinct) {
                                  const seen = new Set();
                                  groupPtrs.forEach(ptr => {
                                      let v = sel.argFunc(ptr, this.tables, aliases);
                                      if (v !== null && v !== undefined) seen.add(v);
                                  });
                                  aggRow[sel.alias] = seen.size;
                              } else {
                                  let cnt = 0;
                                  groupPtrs.forEach(ptr => {
                                      let v = sel.argFunc(ptr, this.tables, aliases);
                                      if (v !== null && v !== undefined) cnt++;
                                  });
                                  aggRow[sel.alias] = cnt;
                              }
                          } else if (sel.func === 'GROUP_CONCAT') {
                              let vals = [];
                              const seen = sel.distinct ? new Set() : null;
                              groupPtrs.forEach(ptr => {
                                  let v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (v === null || v === undefined) return;
                                  if (seen) {
                                      if (seen.has(v)) return;
                                      seen.add(v);
                                  }
                                  vals.push(String(v));
                              });
                              aggRow[sel.alias] = vals.length > 0 ? vals.join(sel.separator || ',') : null;
                          } else if (sel.func === 'MAX' || sel.func === 'MIN') {
                              let vals = [];
                              groupPtrs.forEach(ptr => {
                                  let v = sel.argFunc(ptr, this.tables, aliases);
                                  if (v !== null && v !== undefined) vals.push(v);
                              });
                              if (vals.length === 0) aggRow[sel.alias] = null;
                              else {
                                  let sorted = vals.sort((a,b) => a<b ? -1 : (a>b ? 1 : 0));
                                  aggRow[sel.alias] = sel.func === 'MAX' ? sorted[sorted.length-1] : sorted[0];
                              }
                          } else if (sel.func === 'STDDEV' || sel.func === 'VARIANCE' || sel.func === 'MEDIAN') {
                              let vals = [];
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (typeof v === 'number') vals.push(v);
                              });
                              if (sel.distinct) vals = [...new Set(vals)];
                              if (vals.length === 0) {
                                  aggRow[sel.alias] = null;
                              } else if (sel.func === 'MEDIAN') {
                                  vals.sort((a, b) => a - b);
                                  const mid = Math.floor(vals.length / 2);
                                  aggRow[sel.alias] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
                              } else {
                                  // 母集団分散 / 母標準偏差（MySQL の VARIANCE / STDDEV と同じ定義）
                                  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                                  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
                                  aggRow[sel.alias] = Number((sel.func === 'VARIANCE' ? variance : Math.sqrt(variance)).toFixed(4));
                              }
                          } else {
                              let sum = 0, cnt = 0;
                              if (sel.distinct) {
                                  // SUM(DISTINCT) / AVG(DISTINCT): 重複値を除外して集計
                                  const seen = new Set();
                                  groupPtrs.forEach(ptr => {
                                      let v = sel.argFunc(ptr, this.tables, aliases);
                                      if (typeof v === 'number') seen.add(v);
                                  });
                                  seen.forEach(v => { sum += v; cnt++; });
                              } else {
                                  groupPtrs.forEach(ptr => {
                                      let v = sel.argFunc(ptr, this.tables, aliases);
                                      if (typeof v === 'number') { sum += v; cnt++; }
                                  });
                              }
                              aggRow[sel.alias] = sel.func === 'SUM' ? sum : (cnt>0 ? Number((sum/cnt).toFixed(2)) : 0);
                          }
                      } else if (sel.type === 'expr') {
                          aggRow[sel.alias] = groupPtrs.length > 0 ? sel.evalFunc(groupPtrs[0], this.tables, aliases) : null;
                      }
                  });
                  aggResults.push(aggRow);
              });
              resultSet = aggResults;
          } else {
              // ORDER BY の式・未選択列をソートで参照できるよう、行ポインタ段階で
              // 隠しキー __ob_N として投機的に評価する（SELECT 別名のみの式は評価に
              // 失敗するため、その場合は出力行ベースの解決へフォールバックする）。
              // DISTINCT では隠しキーが重複除去を壊すため付与しない
              const obAttach = [];
              if (orderItems && !isDistinct) {
                  // 出力キーで解決できる単純な列名・別名は事前評価しない（大量行での無駄を防ぐ）
                  const knownOutputNames = new Set();
                  let hasStar = false;
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'star') hasStar = true;
                      else if (sel.alias) knownOutputNames.add(String(sel.alias).toLowerCase());
                  });
                  if (hasStar) {
                      for (const a in aliases) {
                          const t = this.tables[aliases[a]];
                          if (t) t.getColumnNames().forEach(c => knownOutputNames.add(c));
                      }
                  }
                  orderItems.forEach((item, i) => {
                      if (item.isOrdinal) return;
                      if (/^[a-zA-Z0-9_.]+$/.test(item.expr)) {
                          const nm = item.expr.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase();
                          if (knownOutputNames.has(nm)) return;
                      }
                      try {
                          obAttach.push({ item, key: `__ob_${i}`, fn: this.compileCondition(item.expr, strMap) });
                      } catch (e) { /* 式としてコンパイル不能: 出力キー解決に委ねる */ }
                  });
              }
              resultSet = rowPtrs.map(ptr => {
                  let outRow = {};
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'star') {
                          for (let alias in ptr) {
                              let actualTbl = aliases[alias];
                              if (actualTbl && this.tables[actualTbl] && ptr[alias] !== -1) {
                                  const t = this.tables[actualTbl];
                                  t.getColumnNames().forEach(c => {
                                      outRow[c] = t.getValue(c, ptr[alias]);
                                  });
                              }
                          }
                      } else if (sel.type === 'expr') {
                          outRow[sel.alias] = sel.evalFunc(ptr, this.tables, aliases);
                      } else if (sel.type === 'window') {
                          outRow[sel.alias] = ptr[sel.wfId];
                      }
                  });
                  obAttach.forEach(a => {
                      if (a.item.attachFailed) return;
                      try {
                          outRow[a.key] = a.fn(ptr, this.tables, aliases);
                          a.item.attachKey = a.key;
                      } catch (e) {
                          a.item.attachFailed = true;
                          a.item.attachKey = null;
                      }
                  });
                  return outRow;
              });
          }

          // HAVING は出力行（SELECT 別名・隠し集計列を含む）に対して評価する。
          // 集計なしのクエリでも WHERE 相当のフィルタとして機能する（MySQL 互換。
          // 従来は集計時以外は無言で無視され誤った結果を返していた）
          if (havingStrEff) {
              let hFunc = this.compileCondition(havingStrEff, strMap);
              let dummyCols = {};
              if (resultSet.length > 0) {
                  Object.keys(resultSet[0]).forEach(k => dummyCols[k.toLowerCase()] = true);
              }
              resultSet = resultSet.filter(row => {
                  let getVal = (c) => {
                      let actualKey = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
                      return actualKey ? row[actualKey] : null;
                  };
                  return hFunc({ dummy: 0 }, { dummy: { cols: dummyCols, getValue: getVal } }, { dummy: 'dummy' });
              });
              // 隠し HAVING 集計列は以降（DISTINCT / ORDER BY / 出力）に影響させない
              resultSet.forEach(row => {
                  for (const k in row) if (k.startsWith('__hv_')) delete row[k];
              });
          }

          if (isDistinct && resultSet.length > 0) {
              const seen = new Set();
              resultSet = resultSet.filter(row => {
                  const str = JSON.stringify(row, Object.keys(row).sort());
                  if (seen.has(str)) return false;
                  seen.add(str);
                  return true;
              });
          }

          if (orderItems && resultSet.length > 0) {
              // 隠しキー（__ob_/__oba_/__obv_/__hv_）は序数解決の対象から除外する
              const visibleKeys = Object.keys(resultSet[0]).filter(k => !/^__(ob|oba|obv|hv)_/.test(k));
              const orderCols = orderItems.map((item, i) => {
                  // 序数指定 (ORDER BY 1) は SELECT 出力の n 番目の列を指す
                  if (item.isOrdinal) {
                      const ord = parseInt(item.expr, 10);
                      if (ord < 1 || ord > visibleKeys.length) throw new Error(`ORDER BY position ${ord} is out of range.`);
                      return { col: visibleKeys[ord - 1], desc: item.desc };
                  }
                  // 単純な列名・別名は出力キーで解決する（別名が実列と重複する場合は別名優先）
                  if (/^[a-zA-Z0-9_.]+$/.test(item.expr)) {
                      const colName = item.expr.replace(/^[a-zA-Z0-9_]+\./, '');
                      const actualKey = Object.keys(resultSet[0]).find(k => k.toLowerCase() === colName.toLowerCase());
                      if (actualKey) return { col: actualKey, desc: item.desc };
                  }
                  // 行ポインタ段階で評価済みの式（未選択列を含む）
                  if (item.attachKey) return { col: item.attachKey, desc: item.desc };
                  // 出力行に対する式評価（集計書き換え済みの式・SELECT 別名を使った式など）
                  let fn;
                  try {
                      fn = this.compileCondition(item.expr, strMap);
                  } catch (e) {
                      throw new Error(`Column '${item.expr}' not found.`);
                  }
                  const key = `__obv_${i}`;
                  const dummyColsOb = {};
                  Object.keys(resultSet[0]).forEach(k => dummyColsOb[k.toLowerCase()] = true);
                  try {
                      resultSet.forEach(row => {
                          const getVal = (c) => {
                              const ak = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
                              return ak !== undefined ? row[ak] : null;
                          };
                          row[key] = fn({ dummy: 0 }, { dummy: { cols: dummyColsOb, getValue: getVal } }, { dummy: 'dummy' });
                      });
                  } catch (e) {
                      if (isDistinct) throw new Error("For SELECT DISTINCT, ORDER BY expressions must appear in the select list.");
                      throw e;
                  }
                  return { col: key, desc: item.desc };
              });

              resultSet.sort((a, b) => {
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

          // ソート用の隠しキーを出力から除去する
          if (resultSet.length > 0) {
              const hasHidden = Object.keys(resultSet[0]).some(k => /^__(ob|oba|obv|hv)_/.test(k));
              if (hasHidden) {
                  resultSet.forEach(row => {
                      for (const k in row) if (/^__(ob|oba|obv|hv)_/.test(k)) delete row[k];
                  });
              }
          }

          if (limitVal !== null || offsetVal !== null) {
              // 負の OFFSET は 0 扱い（slice の末尾相対解釈を防ぐ）
              let offset = offsetVal !== null ? Math.max(0, parseInt(offsetVal, 10)) : 0;
              let limit = (limitVal !== null && limitVal.toLowerCase() !== 'all') ? parseInt(limitVal, 10) : resultSet.length;
              if (offset >= resultSet.length) {
                  resultSet = [];
              } else {
                  resultSet = resultSet.slice(offset, offset + limit);
              }
          }

          return { data: resultSet, affectedRows: resultSet.length };
      }
    });
