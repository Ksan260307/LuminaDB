    // ============================================================================
    // [DatabaseEngine Select] - SELECT の解析 / 最適化 / 実行
    // ============================================================================

    // 集計関数名の一覧（先頭一致判定・式中判定・書き換えで共用）
    const LUMINA_AGG_NAMES = 'COUNT_IF|COUNT|SUM|AVG|MAX_BY|MIN_BY|MAX|MIN|GROUP_CONCAT|STRING_AGG|LISTAGG|ARRAY_AGG|STDDEV_SAMP|STDDEV_POP|STDDEV|VARIANCE|VAR_SAMP|VAR_POP|MEDIAN|PERCENTILE_CONT|PERCENTILE_DISC|BIT_AND|BIT_OR|BIT_XOR|BOOL_AND|BOOL_OR|CORR|COVAR_POP|COVAR_SAMP|REGR_SLOPE|REGR_INTERCEPT|REGR_COUNT|REGR_R2|REGR_AVGX|REGR_AVGY|REGR_SXX|REGR_SYY|REGR_SXY|MODE|ANY_VALUE|GROUPING|JSON_ARRAYAGG|JSON_OBJECTAGG';
    // 式の「途中」に集計呼び出しが現れるか（ROUND(AVG(x),2) や a/SUM(b) を拾う）。
    // 直前が識別子文字だと my_sum( のような列名を誤検出するため、境界を明示する。
    const AGG_ANYWHERE = new RegExp('(^|[^A-Za-z0-9_.])(' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i');

    Object.assign(DatabaseEngine.prototype, {

      // 集計関数呼び出し 1 件を compiledSelects 用の記述子へ変換する
      // （SELECT 句 / HAVING / ORDER BY の集計書き換えで共用）
      _compileAggSelect(func, argExpr, strMap, alias, filterExpr) {
          argExpr = (argExpr || '').trim();
          // ARRAY_AGG は JSON_ARRAYAGG の別名（PostgreSQL/標準SQL 互換）
          if (func === 'ARRAY_AGG') func = 'JSON_ARRAYAGG';
          // FILTER (WHERE cond): 集計対象をこの条件が真の行に限定する（SQL標準）
          const filterFunc = filterExpr ? this.compileCondition(filterExpr, strMap) : null;
          // GROUPING(col): ROLLUP の小計行で 1、通常行で 0 を返す。引数は GROUP BY 項目との
          // テキスト照合に使うため、コンパイルせず原文のまま保持する
          if (func === 'GROUPING') {
              return { type: 'agg', func, argFunc: null, groupingExpr: argExpr, alias };
          }
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
          // GROUP_CONCAT / JSON_ARRAYAGG の集計内 ORDER BY（SEPARATOR より前に書く）
          let orderSpecs = null;
          const obM = argExpr.match(/^([\s\S]+?)\s+ORDER\s+BY\s+([\s\S]+)$/i);
          if (obM && (func === 'GROUP_CONCAT' || func === 'JSON_ARRAYAGG')) {
              argExpr = obM[1].trim();
              orderSpecs = this.splitSelectClause(obM[2]).map(s => {
                  let e = s.trim();
                  let desc = false;
                  const dm = e.match(/\s+(asc|desc)$/i);
                  if (dm) { desc = dm[1].toLowerCase() === 'desc'; e = e.slice(0, dm.index).trim(); }
                  return { fn: this.compileCondition(e, strMap), desc };
              });
          }
          let argFunc = null, argFunc2 = null, argFuncs = null;
          if (argExpr && argExpr !== '*') {
              if (func === 'LISTAGG') {
                  // Oracle LISTAGG(expr [, 'sep']): GROUP_CONCAT の別名（WITHIN GROUP は非対応、既定はカンマ）
                  const pp = this.splitSelectClause(argExpr);
                  if (pp.length < 1 || pp.length > 2) throw new Error("LISTAGG requires 1 or 2 arguments (expr [, separator]).");
                  argFunc = this.compileCondition(pp[0], strMap);
                  if (pp.length === 2) {
                      const sepTok = pp[1].trim().match(/^__STR_(\d+)__$/);
                      separator = sepTok
                          ? this._unquoteLiteral(strMap[Number(sepTok[1])])
                          : String(this.compileCondition(pp[1], strMap)({}, {}, {}));
                  }
                  func = 'GROUP_CONCAT';
              } else if (func === 'STRING_AGG') {
                  // STRING_AGG(expr, 'sep'): 区切り文字を第2引数で受ける GROUP_CONCAT の別名
                  const pp = this.splitSelectClause(argExpr);
                  if (pp.length !== 2) throw new Error("STRING_AGG requires exactly 2 arguments (expr, separator).");
                  argFunc = this.compileCondition(pp[0], strMap);
                  const sepTok = pp[1].trim().match(/^__STR_(\d+)__$/);
                  separator = sepTok
                      ? this._unquoteLiteral(strMap[Number(sepTok[1])])
                      : String(this.compileCondition(pp[1], strMap)({}, {}, {}));
                  func = 'GROUP_CONCAT';
              } else if (func === 'JSON_OBJECTAGG' || func === 'MIN_BY' || func === 'MAX_BY' || func === 'PERCENTILE_CONT' || func === 'PERCENTILE_DISC'
                         || func === 'CORR' || func === 'COVAR_POP' || func === 'COVAR_SAMP' || func.indexOf('REGR_') === 0) {
                  // 2引数集計: JSON_OBJECTAGG(key, value) / MIN_BY・MAX_BY(戻り値, 比較キー) /
                  //            PERCENTILE_CONT・DISC(値, 分位 0〜1) / CORR・COVAR_*(x, y)
                  const pp = this.splitSelectClause(argExpr);
                  if (pp.length !== 2) throw new Error(`${func} requires exactly 2 arguments.`);
                  argFunc = this.compileCondition(pp[0], strMap);
                  argFunc2 = this.compileCondition(pp[1], strMap);
              } else if (func === 'COUNT' && isDistinctAgg) {
                  // COUNT(DISTINCT a, b): 複数列の組で重複判定
                  argFuncs = this.splitSelectClause(argExpr).map(p => this.compileCondition(p, strMap));
                  argFunc = argFuncs[0];
              } else {
                  argFunc = this.compileCondition(argExpr, strMap);
              }
          }
          return { type: 'agg', func, argFunc, argFunc2, argFuncs, distinct: isDistinctAgg, separator, orderSpecs, alias, filterFunc };
      },

      // 集計内 ORDER BY 用: {v, ord:[...]} ペア配列を並べ替える
      _sortAggPairs(pairs, orderSpecs) {
          pairs.sort((x, y) => {
              for (let i = 0; i < orderSpecs.length; i++) {
                  const a = x.ord[i], b = y.ord[i];
                  if (a === b) continue;
                  if (a === null || a === undefined) return orderSpecs[i].desc ? 1 : -1;
                  if (b === null || b === undefined) return orderSpecs[i].desc ? -1 : 1;
                  if (a < b) return orderSpecs[i].desc ? 1 : -1;
                  return orderSpecs[i].desc ? -1 : 1;
              }
              return 0;
          });
      },

      // 式の「途中」に集計呼び出しが現れるかの判定（先頭一致ではない）。
      // 例: ROUND(AVG(x), 2) / 100.0 * SUM(a) / SUM(b) / CONCAT('n=', COUNT(*))
      // 直前が識別子文字・'_' でないこと（列名 my_sum( 等の誤検出を防ぐ）を条件にする。

      // 式文字列中の集計関数呼び出しを隠し集計列（prefix + 連番）への参照に書き換え、
      // 対応する集計記述子を compiledSelects へ追加する。
      // HAVING COUNT(*) > 1 / ORDER BY SUM(x) DESC のような直接集計参照を可能にする
      _rewriteAggCalls(str, compiledSelects, strMap, prefix) {
          // 引数は2段の括弧ネストまで対応（HAVING SUM(ROUND(ABS(x), 2)) 等）
          return str.replace(/\b(COUNT_IF|COUNT|SUM|AVG|MAX_BY|MIN_BY|MAX|MIN|GROUP_CONCAT|STRING_AGG|LISTAGG|ARRAY_AGG|STDDEV_SAMP|STDDEV_POP|STDDEV|VARIANCE|VAR_SAMP|VAR_POP|MEDIAN|PERCENTILE_CONT|PERCENTILE_DISC|BIT_AND|BIT_OR|BIT_XOR|BOOL_AND|BOOL_OR|CORR|COVAR_POP|COVAR_SAMP|REGR_SLOPE|REGR_INTERCEPT|REGR_COUNT|REGR_R2|REGR_AVGX|REGR_AVGY|REGR_SXX|REGR_SYY|REGR_SXY|MODE|ANY_VALUE|GROUPING|JSON_ARRAYAGG|JSON_OBJECTAGG)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi, (m, fn, arg) => {
              const alias = `${prefix}${compiledSelects.length}`;
              compiledSelects.push(this._compileAggSelect(fn.toUpperCase(), arg, strMap, alias));
              return ` ${alias} `;
          });
      },

      _parseSelect(sql) {
          let tempSql = sql;
          let limitVal = null, offsetVal = null, orderByStr = null, havingStr = null, groupByStr = null, whereStr = null, qualifyStr = null;

          // SQL Server TOP: SELECT [ALL|DISTINCT] TOP (n) [PERCENT] ... を LIMIT へ正規化する。
          // PERCENT は limitVal を "n%" で表現し適用側(_executeSelectPlan)で全体件数に対して解釈する。
          // WITH TIES は受理するが通常の TOP n として扱う（同値タイの追加取得は非対応）。
          {
              const topM = tempSql.match(/^(\s*select\s+(?:all\s+|distinct\s+)?)top\s+(?:\(\s*(\d+(?:\.\d+)?)\s*\)|(\d+(?:\.\d+)?))\s*(percent\b)?\s*(?:with\s+ties\b)?\s+/i);
              if (topM) {
                  const nRaw = topM[2] !== undefined ? topM[2] : topM[3];
                  limitVal = topM[4] ? (nRaw + '%') : String(Math.trunc(Number(nRaw)));
                  tempSql = topM[1] + tempSql.slice(topM[0].length);
              }
          }

          // 順序集合集計 WITHIN GROUP (ORDER BY ...) を既存の2引数形へ正規化する。
          //   PERCENTILE_CONT(p) WITHIN GROUP (ORDER BY e)      -> PERCENTILE_CONT(e, p)
          //   PERCENTILE_DISC(p) WITHIN GROUP (ORDER BY e DESC) -> PERCENTILE_DISC(e, 1 - (p))
          //   LISTAGG(x, sep)    WITHIN GROUP (ORDER BY y)      -> GROUP_CONCAT(x ORDER BY y SEPARATOR sep)
          // ORDER BY 句抽出・集計呼び出しの退避より前に消す必要がある（括弧内 ORDER BY の誤検出防止）
          if (/within\s+group/i.test(tempSql)) {
              tempSql = tempSql.replace(
                  /\b(PERCENTILE_CONT|PERCENTILE_DISC|LISTAGG|MODE)\s*\(((?:[^()]|\([^()]*\))*)\)\s+WITHIN\s+GROUP\s*\(\s*ORDER\s+BY\s+((?:[^()]|\([^()]*\))*?)\s*\)/gi,
                  (m, fn, args, ord) => {
                      const F = fn.toUpperCase();
                    // MODE() WITHIN GROUP (ORDER BY e) は引数なし集計なので e を引数に据えるだけ
                    if (F === 'MODE') return `MODE(${ord.replace(/\s+(asc|desc)\s*$/i, '').trim()})`;
                      const dm = ord.match(/\s+(asc|desc)\s*$/i);
                      const isDesc = !!(dm && dm[1].toLowerCase() === 'desc');
                      const ordExpr = (dm ? ord.slice(0, dm.index) : ord).trim();
                      if (F === 'LISTAGG') {
                          const parts = this.splitSelectClause(args);
                          const expr = (parts[0] || '').trim();
                          const sep = parts.length > 1 ? parts[1].trim() : null;
                          return `GROUP_CONCAT(${expr} ORDER BY ${ordExpr}${isDesc ? ' DESC' : ''}${sep ? ' SEPARATOR ' + sep : ''})`;
                      }
                      // 分位は昇順定義。DESC 指定は 1 - p と等価なので式ごと反転させる
                      const p = args.trim();
                      return `${F}(${ordExpr}, ${isDesc ? `1 - (${p})` : p})`;
                  }
              );
          }

          // named window (WINDOW w AS (...)): 定義を集めて OVER w を OVER (定義) へ展開する。
          // OVER 退避より前に処理する（展開後の OVER (...) を通常のウィンドウ処理へ載せる）
          {
              let depth = 0, winPos = -1;
              for (let i = 0; i < tempSql.length && winPos === -1; i++) {
                  const ch = tempSql[i];
                  if (ch === '(') depth++;
                  else if (ch === ')') depth--;
                  else if (depth === 0 && (ch === 'w' || ch === 'W')
                      && (i === 0 || /\s/.test(tempSql[i - 1])) && /^window\s/i.test(tempSql.slice(i))) {
                      winPos = i;
                  }
              }
              if (winPos !== -1) {
                  const windows = Object.create(null);
                  let rest = tempSql.slice(winPos).replace(/^window\s+/i, '');
                  while (true) {
                      const nm = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/i);
                      if (!nm) throw new Error("Syntax Error in WINDOW clause. Use WINDOW name AS (...).");
                      let d = 0, open = nm[0].length - 1, end = -1;
                      for (let i = open; i < rest.length; i++) {
                          if (rest[i] === '(') d++;
                          else if (rest[i] === ')') { d--; if (d === 0) { end = i; break; } }
                      }
                      if (end === -1) throw new Error("Syntax Error in WINDOW clause: unbalanced parentheses.");
                      windows[nm[1].toLowerCase()] = rest.slice(open + 1, end).trim();
                      rest = rest.slice(end + 1);
                      const comma = rest.match(/^\s*,\s*/);
                      if (comma) { rest = rest.slice(comma[0].length); continue; }
                      break;
                  }
                  tempSql = tempSql.slice(0, winPos) + ' ' + rest;
                  tempSql = tempSql.replace(/\bOVER\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi, (m, wn) => {
                      const def = windows[wn.toLowerCase()];
                      if (def === undefined) throw new Error(`Window '${wn}' is not defined in the WINDOW clause.`);
                      return `OVER (${def})`;
                  });
              }
          }

          let overMap = [];
          tempSql = tempSql.replace(/\bOVER\s*\((?:[^)(]+|\([^)(]*\))*\)/gi, (m) => {
              overMap.push(m);
              return `__OVER_${overMap.length - 1}__`;
          });

          // 集計関数内の ORDER BY（GROUP_CONCAT(x ORDER BY y) 等）が文全体の ORDER BY
          // 抽出に誤マッチしないよう、呼び出し全体を退避する（2段の括弧ネストまで）
          let aggMap = [];
          tempSql = tempSql.replace(/\b(GROUP_CONCAT|JSON_ARRAYAGG|ARRAY_AGG|STRING_AGG)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi, (m) => {
              aggMap.push(m);
              return `__AGGFN_${aggMap.length - 1}__`;
          });

          // IS [NOT] DISTINCT FROM の FROM が FROM 句と誤認される（SELECT 1 IS DISTINCT FROM 2 で
          // '2' がテーブル名扱いになる）ため、句の切り出し中はトークンへ退避し、最後に復元する
          tempSql = tempSql.replace(/\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/gi, (m, not) => not ? '__ISNDF__' : '__ISDF__');
          const restoreAgg = (x) => x == null ? x
              : x.replace(/__AGGFN_(\d+)__/g, (mm, i) => aggMap[i])
                 .replace(/__ISNDF__/g, ' IS NOT DISTINCT FROM ')
                 .replace(/__ISDF__/g, ' IS DISTINCT FROM ');

          // EXTRACT(unit FROM expr) / TRIM(... FROM s) / SUBSTRING(s FROM n) の FROM が
          // FROM 句と誤認されるため、カンマ形式へ正規化する
          // （compileCondition は FROM / カンマの両形式を受理する）
          tempSql = tempSql.replace(/\bEXTRACT\s*\(\s*(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND|EPOCH|DOW|DOY)\s+FROM\b/gi, 'EXTRACT($1,');
          tempSql = tempSql.replace(/\b(TRIM|SUBSTRING)\s*\(((?:[^()]|\([^()]*\))*?)\s+FROM\s+/gi, (m, fn, pre) => `${fn}(${pre}, `);
          // OVERLAY(s PLACING r FROM n [FOR len]) の FROM/FOR が FROM 句と誤認されるためカンマ形式へ正規化
          tempSql = tempSql.replace(/\bOVERLAY\s*\(([^()]*?)\s+PLACING\s+([^()]*?)\s+FROM\s+([^()]*?)\s+FOR\s+([^()]*?)\)/gi, (m, a, b, c, d) => `OVERLAY(${a}, ${b}, ${c}, ${d})`);
          tempSql = tempSql.replace(/\bOVERLAY\s*\(([^()]*?)\s+PLACING\s+([^()]*?)\s+FROM\s+([^()]*?)\)/gi, (m, a, b, c) => `OVERLAY(${a}, ${b}, ${c})`);

          // SQL標準の OFFSET n ROWS / FETCH FIRST n ROWS ONLY を LIMIT / OFFSET へ正規化。
          // WITH TIES は「境界行と ORDER BY キーが同値の行も含めて返す」指定（SQL標準 / SQL Server）
          tempSql = tempSql.replace(/\bOFFSET\s+(\d+)\s+ROWS?\b/gi, 'OFFSET $1');
          let withTies = false;
          tempSql = tempSql.replace(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+(ONLY|WITH\s+TIES)\b/gi, (m, n, mode) => {
              if (/with/i.test(mode)) withTies = true;
              return `LIMIT ${n}`;
          });
          tempSql = tempSql.replace(/\bLIMIT\s+(\d+)\s+WITH\s+TIES\b/gi, (m, n) => { withTies = true; return `LIMIT ${n}`; });

          // MySQL 形式 LIMIT offset, count を先に判定する（単独 LIMIT の誤マッチを防ぐ）
          // 小数は切り捨て、負の OFFSET は 0 扱い（適用側で解釈。FROM 句の残余判定を汚さないようここで消費する）
          // TOP で limitVal が確定済みの場合は LIMIT 解析を行わない（TOP を優先）。
          if (limitVal === null) {
              const limitCommaMatch = tempSql.match(/\s+limit\s+(\d+)\s*,\s*(\d+)/i);
              if (limitCommaMatch) {
                  offsetVal = limitCommaMatch[1];
                  limitVal = limitCommaMatch[2];
                  tempSql = tempSql.replace(limitCommaMatch[0], '');
              } else {
                  const limitMatch = tempSql.match(/\s+limit\s+(\d+(?:\.\d+)?|all)/i);
                  if(limitMatch) { limitVal = limitMatch[1]; tempSql = tempSql.replace(limitMatch[0], ''); }
              }
          }
          const offsetMatch = tempSql.match(/\s+offset\s+(-?\d+(?:\.\d+)?)/i);
          if(offsetMatch) { offsetVal = offsetMatch[1]; tempSql = tempSql.replace(offsetMatch[0], ''); }

          const oMatch = tempSql.match(/\s+order\s+by\s+([\s\S]+)$/i);
          if(oMatch) { orderByStr = oMatch[1]; tempSql = tempSql.substring(0, oMatch.index); }

          // QUALIFY (Snowflake/DuckDB 互換): ウィンドウ関数の結果（SELECT 別名）で行を絞り込む。
          // 文中の位置は HAVING の後・ORDER BY の前
          const qfMatch = tempSql.match(/\s+qualify\s+([\s\S]+)$/i);
          if (qfMatch) { qualifyStr = qfMatch[1]; tempSql = tempSql.substring(0, qfMatch.index); }

          const hMatch = tempSql.match(/\s+having\s+([\s\S]+)$/i);
          if(hMatch) { havingStr = hMatch[1]; tempSql = tempSql.substring(0, hMatch.index); }

          const gMatch = tempSql.match(/\s+group\s+by\s+([\s\S]+)$/i);
          if(gMatch) { groupByStr = gMatch[1]; tempSql = tempSql.substring(0, gMatch.index); }

          const wMatch = tempSql.match(/\s+where\s+([\s\S]+)$/i);
          if(wMatch) { whereStr = wMatch[1]; tempSql = tempSql.substring(0, wMatch.index); }

          // CROSS JOIN は常に真となる ON 条件付きの JOIN へ正規化する（直積）
          tempSql = tempSql.replace(/\bCROSS\s+JOIN\s+([a-zA-Z0-9_]+)((?:\s+(?:AS\s+)?(?!LEFT\b|INNER\b|RIGHT\b|CROSS\b|JOIN\b|ON\b)[a-zA-Z0-9_]+)?)/gi, 'JOIN $1$2 ON 1 = 1');

          // OUTER は省略可能な飾り語なので先に落とす（LEFT/RIGHT/FULL OUTER JOIN → LEFT/RIGHT/FULL JOIN）
          tempSql = tempSql.replace(/\b(LEFT|RIGHT|FULL)\s+OUTER\s+JOIN\b/gi, '$1 JOIN');
          // FULL JOIN（OUTER なし）も FULL OUTER JOIN と同義
          const joins = [];
          // 結合条件は ON <式> / USING (col, ...) / NATURAL（共通列で自動結合）の3形式。
          // USING / NATURAL の等価条件への解決はスキーマが必要なため _optimizeSelect で行う
          const joinRegex = /\b(NATURAL\s+)?(LEFT\s+|INNER\s+|RIGHT\s+|FULL\s+)?JOIN\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?(?!ON\b|USING\b|NATURAL\b|LEFT\b|INNER\b|RIGHT\b|FULL\b|JOIN\b)([a-zA-Z0-9_]+))?\s*(?:ON\s+([\s\S]+?)|USING\s*\(\s*([a-zA-Z0-9_\s,]+?)\s*\))?(?=\s*\b(?:NATURAL\s+)?(?:LEFT|INNER|RIGHT|FULL)?\s*JOIN\b|$)/gi;
          let jMatch;
          let firstJoinIdx = -1;
          while ((jMatch = joinRegex.exec(tempSql)) !== null) {
              if (firstJoinIdx === -1) firstJoinIdx = jMatch.index;
              const natural = !!jMatch[1];
              const onCond = jMatch[5] ? restoreAgg(jMatch[5].trim()) : null;
              const usingCols = jMatch[6] ? jMatch[6].split(',').map(c => c.trim().toLowerCase()).filter(Boolean) : null;
              if (natural && (onCond || usingCols)) throw new Error("NATURAL JOIN cannot be combined with ON / USING.");
              if (!natural && !onCond && !usingCols) throw new Error("JOIN requires an ON or USING clause (use CROSS JOIN for a cartesian product).");
              joins.push({
                  type: jMatch[2] ? jMatch[2].trim().toUpperCase() : 'INNER',
                  table: jMatch[3].toLowerCase(),
                  alias: (jMatch[4] || jMatch[3]).toLowerCase(),
                  onCond, usingCols, natural
              });
          }
          if (joins.length > 0) tempSql = tempSql.substring(0, firstJoinIdx);

          // DISTINCT ON (expr, ...) — PostgreSQL: 指定式ごとに（ORDER BY 順で）先頭の1行だけを返す。
          // 全列一致で潰す通常の DISTINCT とは別処理なので、ここで切り出して素の SELECT へ戻す
          let distinctOn = null;
          {
              const dm = tempSql.match(/^(\s*select\s+)distinct\s+on\s*\(/i);
              if (dm) {
                  const open = dm[0].length - 1;
                  const close = this._scanBalanced(tempSql, open);
                  if (close === -1) throw new Error("Syntax Error in DISTINCT ON: unbalanced parentheses.");
                  distinctOn = this.splitSelectClause(tempSql.slice(open + 1, close)).map(x => x.trim()).filter(x => x !== '');
                  if (distinctOn.length === 0) throw new Error("DISTINCT ON requires at least one expression.");
                  tempSql = dm[1] + tempSql.slice(close + 1).replace(/^\s*/, '');
              }
          }

          const fMatch = tempSql.match(/^select\s+(distinct\s+)?([\s\S]+?)\s+from\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/i);
          if(!fMatch) {
              // FROM 句なしの定数 SELECT (例: SELECT 1+1): 1行のダミーテーブル上で評価する
              const nfMatch = tempSql.match(/^select\s+(distinct\s+)?([\s\S]+)$/i);
              if (nfMatch && !/\bfrom\b/i.test(tempSql)) {
                  const selectClause = restoreAgg(nfMatch[2].trim().replace(/__OVER_(\d+)__/g, (m, idx) => overMap[idx]));
                  return {
                      isDistinct: !!nfMatch[1], selectClause, fromTable: '__tmp_dual', baseAlias: '__tmp_dual',
                      joins: [],
                      whereStr: restoreAgg(whereStr), groupByStr: restoreAgg(groupByStr),
                      havingStr: restoreAgg(havingStr), qualifyStr: restoreAgg(qualifyStr),
                      orderByStr: restoreAgg(orderByStr),
                      limitVal, offsetVal
                  };
              }
              throw new Error("Syntax error in SELECT statement.");
          }

          const isDistinct = !!fMatch[1];
          let selectClause = fMatch[2].trim();

          // QUALIFY にウィンドウ関数を直書きした形（QUALIFY ROW_NUMBER() OVER (...) <= 2）を
          // 「隠し列 __ql_N を SELECT へ追加し、QUALIFY はその別名を参照する」形へ書き換える。
          // QUALIFY の評価は出力行ベース（別名参照）なので、この正規化で標準的な用法を受理できる。
          // ここでは OVER (...) はまだ __OVER_n__ トークンのままである点に注意。
          if (qualifyStr && /__OVER_\d+__/.test(qualifyStr)) {
              let qi = 0;
              qualifyStr = qualifyStr.replace(
                  /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(__OVER_\d+__)/g,
                  (m, fn, args, over) => {
                      const hidden = `__ql_${qi++}`;
                      selectClause += `, ${fn}(${args}) ${over} AS ${hidden}`;
                      return hidden;
                  }
              );
          }

          selectClause = restoreAgg(selectClause.replace(/__OVER_(\d+)__/g, (m, idx) => overMap[idx]));
          let fromTable = fMatch[3].trim().toLowerCase();
          let baseAlias = (fMatch[4] ? fMatch[4].trim() : fromTable).toLowerCase();
          // MySQL 互換: FROM DUAL は FROM 句なしの定数 SELECT と同義（実在する dual テーブルが優先）
          if (fromTable === 'dual' && !this.tables['dual']) {
              fromTable = '__tmp_dual';
              if (baseAlias === 'dual') baseAlias = '__tmp_dual';
          }

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

          // GROUP BY ALL (DuckDB / Snowflake / BigQuery): SELECT 句の非集計項目すべてでグループ化する
          if (groupByStr !== null && /^\s*all\s*$/i.test(groupByStr)) {
              groupByStr = this._groupByAllItems(selectClause);
          }

          return {
              isDistinct, distinctOn, withTies, selectClause, fromTable, baseAlias, joins,
              whereStr: restoreAgg(whereStr), groupByStr: restoreAgg(groupByStr),
              havingStr: restoreAgg(havingStr), qualifyStr: restoreAgg(qualifyStr),
              orderByStr: restoreAgg(orderByStr),
              limitVal, offsetVal
          };
      },

      // GROUP BY ALL / ORDER BY ALL の展開元: SELECT 句から非集計・非ウィンドウの項目を集める
      _groupByAllItems(selectClause) {
          const aggRe = new RegExp('\\b(?:' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i');
          const items = this.splitSelectClause(selectClause).map(p => {
              const am = p.match(/^([\s\S]+?)\s+AS\s+[a-zA-Z0-9_]+$/i);
              return (am ? am[1] : p).trim();
          }).filter(e => e !== '' && e !== '*' && !aggRe.test(e) && !/\bOVER\s*\(/i.test(e));
          if (items.length === 0) throw new Error("GROUP BY ALL requires at least one non-aggregate item in the SELECT list.");
          return items.join(', ');
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
          if (!this.tables[fromTable]) throw this._tableNotFound(fromTable);

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

          // USING / NATURAL の左辺解決用: これまでに現れたエイリアスの順序付きリスト
          const priorOrder = [baseAlias];
          const joinPlans = joins.map(join => {
              if (!this.tables[join.table]) throw this._tableNotFound(join.table, 'Join Table');
              aliases[join.table] = join.table;
              aliases[join.alias] = join.table;

              let jTbl = this.tables[join.table];

              // USING (col, ...) / NATURAL JOIN を等価 ON 条件へ解決する
              if (join.usingCols || join.natural) {
                  const findLeftAlias = (col) => {
                      for (const pa of priorOrder) {
                          const pt = this.tables[aliases[pa]];
                          if (pt && pt.cols[col]) return pa;
                      }
                      return null;
                  };
                  let cols;
                  if (join.natural) {
                      cols = jTbl.getColumnNames().filter(c => findLeftAlias(c) !== null);
                  } else {
                      cols = join.usingCols;
                      cols.forEach(c => {
                          if (!jTbl.cols[c]) throw new Error(`Column '${c}' not found in table '${join.table}' (USING).`);
                          if (findLeftAlias(c) === null) throw new Error(`Column '${c}' not found on the left side of the join (USING).`);
                      });
                  }
                  // NATURAL JOIN で共通列が無い場合は直積（MySQL互換）
                  join.onCond = cols.length === 0 ? '1 = 1'
                      : cols.map(c => `${findLeftAlias(c)}.${c} = ${join.alias}.${c}`).join(' AND ');
              }
              priorOrder.push(join.alias);

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
              if (parsed.qualifyStr) explainPlan.push({ Step: explainPlan.length + 1, Operation: 'QUALIFY', Details: `Filter by ${parsed.qualifyStr}` });
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
          const { isDistinct, distinctOn, withTies, selectClause, fromTable, baseAlias, groupByStr, havingStr, qualifyStr, orderByStr, limitVal, offsetVal } = parsed;

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
              // RIGHT / FULL JOIN: マッチした右テーブル行を追跡し、未マッチ行を後段で補完する
              const matchedRight = (join.type === 'RIGHT' || join.type === 'FULL') ? new Set() : null;
              // LEFT / FULL JOIN: 右にマッチしない左行を NULL 補完で残す
              const keepUnmatchedLeft = (join.type === 'LEFT' || join.type === 'FULL');
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
                      } else if (keepUnmatchedLeft) {
                          newPtrs.push({ ...ptr, [join.table]: -1, [join.alias]: -1 });
                      }
                  });
              } else {
                  let onFunc = this.compileCondition(join.onCond, strMap);
                  // 入れ子ループ結合は最も暴走しやすいので、内側ループで期限を見る
                  const tickJ = this._mkTick();
                  rowPtrs.forEach(ptr => {
                      let matched = false;
                      for(let j=0; j<jTbl.rowCount; j++) {
                          tickJ();
                          let combPtr = { ...ptr, [join.table]: j, [join.alias]: j };
                          if (onFunc(combPtr, this.tables, aliases)) {
                              newPtrs.push(combPtr);
                              matched = true;
                              if (matchedRight) matchedRight.add(j);
                          }
                      }
                      if (!matched && keepUnmatchedLeft) {
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
              const tickW = this._mkTick();
              rowPtrs = rowPtrs.filter(ptr => { tickW(); return whereFunc(ptr, this.tables, aliases); });
          }

          let selectParts = this.splitSelectClause(selectClause);
          let windowFuncs = [];

          let compiledSelects = selectParts.map((part, partIdx) => {
              const asMatch = part.match(/(.+?)\s+AS\s+([a-zA-Z0-9_]+)$/i);
              let expr = asMatch ? asMatch[1].trim() : part.trim();
              let alias = asMatch ? asMatch[2] : expr.replace(/^[a-zA-Z0-9_]+\./, '');
              if (expr === '*') return { type: 'star' };
              // SELECT * EXCLUDE (col, ...) / * REPLACE (expr AS col, ...) — DuckDB / Snowflake。
              // 列が多い表から「ほぼ全部」を選ぶときに列挙を避けられる
              // EXCEPT は集合演算子として先に文が分割されてしまうため EXCLUDE のみ受理する
              const starM = expr.match(/^\*\s*(EXCLUDE|REPLACE)\s*\(([\s\S]*)\)$/i);
              if (starM) {
                  const kind = starM[1].toUpperCase();
                  const inner = this.splitSelectClause(starM[2]).map(x => x.trim()).filter(x => x !== '');
                  if (inner.length === 0) throw new Error(`SELECT * ${kind} requires at least one item.`);
                  if (kind === 'REPLACE') {
                      const repl = inner.map(it => {
                          const rm = it.match(/^([\s\S]+?)\s+AS\s+([a-zA-Z0-9_]+)$/i);
                          if (!rm) throw new Error("SELECT * REPLACE requires '<expression> AS column'.");
                          return { col: rm[2].toLowerCase(), evalFunc: this.compileCondition(rm[1].trim(), strMap) };
                      });
                      return { type: 'star', replace: repl };
                  }
                  return { type: 'star', exclude: new Set(inner.map(c => c.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase())) };
              }

              // ウィンドウ関数の FILTER: AGG(x) FILTER (WHERE cond) OVER (...)。
              // 条件に合わない行を NULL 扱いにすれば、既存のウィンドウ集計がそのまま使える
              // （SUM/AVG/MIN/MAX/COUNT はいずれも NULL を無視する実装のため）。
              // 集計側の FILTER 抽出（末尾一致）より先に消すこと — 貪欲マッチで
              // 'age > 25) OVER (' まで飲み込まれてしまうため
              let wfFilterExpr = null;
              const wfFilterM = expr.match(/^([\s\S]+?)\s+FILTER\s*\(\s*WHERE\s+([\s\S]+?)\)\s+(OVER\s*\([\s\S]*)$/i);
              if (wfFilterM) {
                  wfFilterExpr = wfFilterM[2].trim();
                  expr = `${wfFilterM[1].trim()} ${wfFilterM[3]}`;
              }

              // 集計の FILTER (WHERE cond) 句を切り出す（末尾）
              let filterExpr = null;
              const filterM = wfFilterExpr ? null : expr.match(/\s+FILTER\s*\(\s*WHERE\s+([\s\S]+)\)\s*$/i);
              if (filterM) { filterExpr = filterM[1].trim(); expr = expr.slice(0, filterM.index).trim(); }

              // IGNORE NULLS / RESPECT NULLS（SQL標準・Oracle・BigQuery）:
              // LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE で NULL 行を読み飛ばす
              let wfIgnoreNulls = false;
              let wfMatch = expr.match(/^([a-zA-Z_]+)\s*\((.*?)\)\s+(IGNORE|RESPECT)\s+NULLS\s+OVER\s*\((.*?)\)$/i);
              if (wfMatch) {
                  wfIgnoreNulls = wfMatch[3].toUpperCase() === 'IGNORE';
                  wfMatch = [wfMatch[0], wfMatch[1], wfMatch[2], wfMatch[4]];
              } else {
                  wfMatch = expr.match(/^([a-zA-Z_]+)\s*\((.*?)\)\s+OVER\s*\((.*?)\)$/i);
              }
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

                  // ウィンドウフレーム句 (ROWS/RANGE/GROUPS BETWEEN a AND b、または単独境界) を先に切り出す。
                  //   ROWS   … 物理行数で数える
                  //   RANGE  … ORDER BY 値のオフセットで数える（CURRENT ROW は同値ピア全体）
                  //   GROUPS … ピアグループ（同順位のまとまり）の個数で数える
                  let frame = null;
                  const fM = overStr.match(/\b(ROWS|RANGE|GROUPS)\s+([\s\S]+)$/i);
                  if (fM) {
                      const frameUnit = fM[1].toUpperCase();
                      const parseBound = (txt) => {
                          txt = txt.trim().toUpperCase().replace(/\s+/g, ' ');
                          if (txt === 'UNBOUNDED PRECEDING') return { t: 'up' };
                          if (txt === 'UNBOUNDED FOLLOWING') return { t: 'uf' };
                          if (txt === 'CURRENT ROW') return { t: 'cur' };
                          let bm = txt.match(/^(\d+) PRECEDING$/);
                          if (bm) return { t: 'pre', n: parseInt(bm[1], 10) };
                          bm = txt.match(/^(\d+) FOLLOWING$/);
                          if (bm) return { t: 'fol', n: parseInt(bm[1], 10) };
                          throw new Error(`Unsupported window frame bound: '${txt}'. Use UNBOUNDED|n PRECEDING / CURRENT ROW / n|UNBOUNDED FOLLOWING.`);
                      };
                      let spec = fM[2].trim();
                      // EXCLUDE 句（SQL標準）: フレームから現在行/同順位行を外す
                      let exclude = 'NO OTHERS';
                      const xm = spec.match(/\s+EXCLUDE\s+(CURRENT\s+ROW|GROUP|TIES|NO\s+OTHERS)\s*$/i);
                      if (xm) {
                          exclude = xm[1].toUpperCase().replace(/\s+/g, ' ');
                          spec = spec.slice(0, xm.index).trim();
                      }
                      const bm = spec.match(/^BETWEEN\s+([\s\S]+?)\s+AND\s+([\s\S]+)$/i);
                      frame = bm
                          ? { unit: frameUnit, start: parseBound(bm[1]), end: parseBound(bm[2]), exclude }
                          : { unit: frameUnit, start: parseBound(spec), end: { t: 'cur' }, exclude };
                      overStr = overStr.slice(0, fM.index).trim();
                  }

                  let pMatch = overStr.match(/PARTITION\s+BY\s+(.+?)(?:\s+ORDER\s+BY\s+(.+))?$/i);
                  let partitionCols = [], orderCols = [];
                  // 分割は括弧内カンマを保護する（PARTITION BY CONCAT(a, b) 等）
                  if (pMatch) {
                      partitionCols = this.splitSelectClause(pMatch[1]).map(s=>s.trim());
                      if (pMatch[2]) orderCols = this.splitSelectClause(pMatch[2]).map(s=>s.trim());
                  } else {
                      let oMatch = overStr.match(/ORDER\s+BY\s+(.+)$/i);
                      if (oMatch) orderCols = this.splitSelectClause(oMatch[1]).map(s=>s.trim());
                  }

                  let pFuncs = partitionCols.map(c => this.compileCondition(c, strMap));
                  let oFuncs = orderCols.map(s => {
                      let p = s.trim().split(/\s+/);
                      return { eval: this.compileCondition(p[0], strMap), desc: p[1] && p[1].toUpperCase() === 'DESC' };
                  });

                  // RANGE / GROUPS はピア判定に ORDER BY を要する。数値オフセット指定は
                  // 対象値が一意に決まる必要があるため ORDER BY 式ちょうど1つを要求する（SQL標準）。
                  if (frame && frame.unit !== 'ROWS') {
                      if (oFuncs.length === 0) {
                          throw new Error(`${frame.unit} frames require an ORDER BY clause in the OVER clause.`);
                      }
                      const hasOffset = [frame.start, frame.end].some(b => b.t === 'pre' || b.t === 'fol');
                      if (frame.unit === 'RANGE' && hasOffset && oFuncs.length !== 1) {
                          throw new Error("RANGE frames with an offset require exactly one ORDER BY expression in the OVER clause.");
                      }
                  }

                  let wfId = `__wf_${partIdx}`;
                  if (wfIgnoreNulls && !['LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE'].includes(funcName)) {
                      throw new Error(`IGNORE NULLS is not supported for ${funcName}(). Use it with LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE.`);
                  }
                  // FILTER (WHERE ...) は集計系ウィンドウ関数のみ。条件外の行を NULL にして渡す
                  if (wfFilterExpr) {
                      if (!['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(funcName)) {
                          throw new Error(`FILTER (WHERE ...) is not supported for ${funcName}() OVER (). Use it with SUM / AVG / MIN / MAX / COUNT.`);
                      }
                      const cond = this.compileCondition(wfFilterExpr, strMap);
                      const inner = argFunc;
                      argFunc = (ptr, tabs, als) => (cond(ptr, tabs, als) ? (inner ? inner(ptr, tabs, als) : 1) : null);
                  }
                  windowFuncs.push({ wfId, funcName, argFunc, argOffset, pFuncs, oFuncs, frame, ignoreNulls: wfIgnoreNulls });

                  return { type: 'window', wfId, alias };
              }

              // 「式全体がちょうど 1 つの集計呼び出し」かを括弧の対応で厳密に判定する。
              // 先頭一致だけで判断すると SUM(a) / COUNT(*) や MAX(a) * MIN(a) を
              // 単一の集計と誤認し、引数が 'a) / COUNT(*' のように壊れる。
              const aggHead = expr.match(new RegExp('^(' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i'));
              if (aggHead) {
                  const open = aggHead[0].length - 1;
                  let d = 0, close = -1;
                  for (let i = open; i < expr.length; i++) {
                      if (expr[i] === '(') d++;
                      else if (expr[i] === ')') { d--; if (d === 0) { close = i; break; } }
                  }
                  if (close === expr.length - 1) {
                      return this._compileAggSelect(aggHead[1].toUpperCase(), expr.slice(open + 1, close).trim(), strMap, alias, filterExpr);
                  }
              }
              if (filterExpr) throw new Error("FILTER (WHERE ...) is only supported on aggregate functions.");
              // 集計を内包した式（ROUND(AVG(x), 2) / 100.0 * SUM(a) / SUM(b) 等）は
              // 「集計そのもの」ではないので、集計を隠し列へ切り出したうえで
              // 集計後の行に対して式を評価する（type: 'aggexpr'）。
              // compiledSelects への push はこの map の完了後でないと行えないため、
              // ここでは検出だけしてマークを返す。
              if (AGG_ANYWHERE.test(expr)) {
                  return { type: 'aggexpr', alias, rawExpr: expr };
              }
              let evalFunc = this.compileCondition(expr, strMap);
              return { type: 'expr', evalFunc, alias, rawExpr: expr };
          });

          // 集計内包式: 集計呼び出しを隠し列 __se_N へ書き換え、残った式を
          // 集計後の行（__se_N を列として持つ）に対して評価する文字列として保持する
          compiledSelects.filter(s => s.type === 'aggexpr').forEach(sel => {
              sel.evalStr = this._rewriteAggCalls(sel.rawExpr, compiledSelects, strMap, '__se_');
              sel.evalFunc = this.compileCondition(sel.evalStr, strMap);
          });

          // HAVING 句に直接書かれた集計呼び出し（HAVING COUNT(*) > 1 等）を
          // 隠し集計列 __hv_N へ書き換え、集計ループで値を算出できるようにする
          let havingStrEff = havingStr;
          if (havingStrEff) {
              havingStrEff = this._rewriteAggCalls(havingStrEff, compiledSelects, strMap, '__hv_');
          }

          let isAgg = compiledSelects.some(sel => sel.type === 'agg' || sel.type === 'aggexpr');

          // ウィンドウ関数と GROUP BY / 集計の併用は未対応。
          // （従来は無言で出力列が欠落していたため、明示的なエラーとして拒否する）
          if (windowFuncs.length > 0 && (isAgg || groupByStr)) {
              throw new Error("Window functions cannot be combined with GROUP BY or aggregate functions.");
          }

          // ORDER BY の前処理: 括弧内カンマを保護して分割し、方向指定を切り出す
          let orderItems = null;
          if (orderByStr) {
              orderItems = this.splitSelectClause(orderByStr).map(s => {
                  let e = s.trim();
                  // NULLS FIRST / LAST（方向指定の後ろに書く: col DESC NULLS LAST）
                  let nulls = null;
                  const nm = e.match(/\s+nulls\s+(first|last)$/i);
                  if (nm) { nulls = nm[1].toLowerCase(); e = e.slice(0, nm.index).trim(); }
                  let desc = false;
                  const dm = e.match(/\s+(asc|desc)$/i);
                  if (dm) { desc = dm[1].toLowerCase() === 'desc'; e = e.slice(0, dm.index).trim(); }
                  return { expr: e, desc, nulls, isOrdinal: /^\d+$/.test(e), attachKey: null, attachFailed: false };
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

                      // CUME_DIST 用: 同一 ORDER BY キーのグループ末尾位置から累積分布を事前計算
                      let cumeDist = null;
                      if (wf.funcName === 'CUME_DIST') {
                          const keys = pRows.map(p => wf.oFuncs.map(f => f.eval(p, this.tables, aliases)).join('|||'));
                          cumeDist = new Array(pRows.length);
                          let i2 = 0;
                          while (i2 < pRows.length) {
                              let j2 = i2;
                              while (j2 + 1 < pRows.length && keys[j2 + 1] === keys[i2]) j2++;
                              for (let k2 = i2; k2 <= j2; k2++) cumeDist[k2] = (j2 + 1) / pRows.length;
                              i2 = j2 + 1;
                          }
                      }

                      // RANGE / GROUPS 用のピア情報をパーティション単位で1度だけ用意する。
                      // peerGrp[i]=ピアグループ番号 / grpLo,grpHi=各グループの行索引範囲 / ordNum[i]=単一ORDER BY値
                      // EXCLUDE GROUP / TIES も同順位のまとまりを要るので、ROWS フレームでも用意する
                      let peerGrp = null, grpLo = null, grpHi = null, ordNum = null, ordDesc = false;
                      const needPeers = wf.frame && wf.oFuncs.length > 0
                          && (wf.frame.unit !== 'ROWS' || wf.frame.exclude === 'GROUP' || wf.frame.exclude === 'TIES');
                      if (needPeers) {
                          peerGrp = new Array(pRows.length);
                          grpLo = []; grpHi = [];
                          let prevKey = null, g = -1;
                          pRows.forEach((p, i) => {
                              const k = wf.oFuncs.map(f => f.eval(p, this.tables, aliases)).join('|||');
                              if (i === 0 || k !== prevKey) { g++; grpLo[g] = i; prevKey = k; }
                              peerGrp[i] = g;
                              grpHi[g] = i;
                          });
                          ordDesc = !!wf.oFuncs[0].desc;
                          ordNum = pRows.map(p => wf.oFuncs[0].eval(p, this.tables, aliases));
                      }

                      pRows.forEach((ptr, idx) => {
                          let val = null;
                          if (wf.frame && ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE'].includes(wf.funcName)) {
                              // 明示フレーム: 各行ごとに [lo..hi] のスライスに対して集計する
                              const unit = wf.frame.unit || 'ROWS';
                              let lo, hi;
                              if (unit === 'ROWS' || !peerGrp) {
                                  const bound = (b) => b.t === 'up' ? 0
                                      : b.t === 'uf' ? pRows.length - 1
                                      : b.t === 'cur' ? idx
                                      : b.t === 'pre' ? idx - b.n
                                      : idx + b.n;
                                  lo = bound(wf.frame.start);
                                  hi = bound(wf.frame.end);
                              } else if (unit === 'GROUPS') {
                                  const g = peerGrp[idx], gMax = grpLo.length - 1;
                                  // 開始境界はグループ先頭、終了境界はグループ末尾を採る
                                  const gAt = (b) => b.t === 'pre' ? g - b.n : b.t === 'fol' ? g + b.n : g;
                                  lo = wf.frame.start.t === 'up' ? 0
                                      : wf.frame.start.t === 'uf' ? pRows.length
                                      : grpLo[Math.min(gMax, Math.max(0, gAt(wf.frame.start)))];
                                  hi = wf.frame.end.t === 'uf' ? pRows.length - 1
                                      : wf.frame.end.t === 'up' ? -1
                                      : grpHi[Math.min(gMax, Math.max(0, gAt(wf.frame.end)))];
                                  // 範囲外を指した境界は空フレームになるよう補正する
                                  if (wf.frame.start.t === 'pre' && g - wf.frame.start.n < 0) lo = 0;
                                  if (wf.frame.start.t === 'fol' && g + wf.frame.start.n > gMax) lo = pRows.length;
                                  if (wf.frame.end.t === 'pre' && g - wf.frame.end.n < 0) hi = -1;
                                  if (wf.frame.end.t === 'fol' && g + wf.frame.end.n > gMax) hi = pRows.length - 1;
                              } else {
                                  // RANGE: ORDER BY 値のオフセットで判定（CURRENT ROW は同値ピア全体）
                                  const cur = ordNum[idx];
                                  const sgn = ordDesc ? -1 : 1;
                                  const inLo = (b) => {
                                      if (b.t === 'up') return 0;
                                      if (b.t === 'uf') return pRows.length;
                                      if (b.t === 'cur') return grpLo[peerGrp[idx]];
                                      const target = b.t === 'pre' ? cur - sgn * b.n : cur + sgn * b.n;
                                      for (let i = 0; i < pRows.length; i++) {
                                          const v = ordNum[i];
                                          if (v === null || v === undefined) continue;
                                          if (ordDesc ? v <= target : v >= target) return i;
                                      }
                                      return pRows.length;
                                  };
                                  const inHi = (b) => {
                                      if (b.t === 'uf') return pRows.length - 1;
                                      if (b.t === 'up') return -1;
                                      if (b.t === 'cur') return grpHi[peerGrp[idx]];
                                      const target = b.t === 'pre' ? cur - sgn * b.n : cur + sgn * b.n;
                                      for (let i = pRows.length - 1; i >= 0; i--) {
                                          const v = ordNum[i];
                                          if (v === null || v === undefined) continue;
                                          if (ordDesc ? v >= target : v <= target) return i;
                                      }
                                      return -1;
                                  };
                                  lo = inLo(wf.frame.start);
                                  hi = inHi(wf.frame.end);
                              }
                              lo = Math.max(0, lo);
                              hi = Math.min(pRows.length - 1, hi);
                              // EXCLUDE: フレームから外す行の集合（現在行 / 同順位グループ / 同順位の他行）
                              let skip = null;
                              const exMode = wf.frame.exclude || 'NO OTHERS';
                              if (exMode !== 'NO OTHERS') {
                                  skip = new Set();
                                  if (exMode === 'CURRENT ROW') skip.add(idx);
                                  else {
                                      // 同じピアグループ（ORDER BY 値が等しい行）をまとめて外す
                                      const g = peerGrp ? peerGrp[idx] : idx;
                                      for (let i2 = 0; i2 < pRows.length; i2++) {
                                          if ((peerGrp ? peerGrp[i2] : i2) === g) skip.add(i2);
                                      }
                                      if (exMode === 'TIES') skip.delete(idx);   // 自分自身は残す
                                  }
                              }
                              const inFrame = (i2) => i2 >= lo && i2 <= hi && !(skip && skip.has(i2));
                              const framed = [];
                              for (let i2 = lo; i2 <= hi; i2++) if (inFrame(i2)) framed.push(i2);
                              if (framed.length === 0) {
                                  val = wf.funcName === 'COUNT' ? 0 : null;
                              } else if (wf.funcName === 'FIRST_VALUE') {
                                  val = wf.argFunc ? wf.argFunc(pRows[framed[0]], this.tables, aliases) : null;
                              } else if (wf.funcName === 'LAST_VALUE') {
                                  val = wf.argFunc ? wf.argFunc(pRows[framed[framed.length - 1]], this.tables, aliases) : null;
                              } else {
                                  let fsum = 0, fcnt = 0, fbest = null, fnRows = 0;
                                  for (const fi of framed) {
                                      fnRows++;
                                      const av = wf.argFunc ? wf.argFunc(pRows[fi], this.tables, aliases) : null;
                                      if (av === null || av === undefined) continue;
                                      if (typeof av === 'number') fsum += av;
                                      fcnt++;
                                      if (fbest === null || (wf.funcName === 'MIN' ? av < fbest : av > fbest)) fbest = av;
                                  }
                                  if (wf.funcName === 'COUNT') val = wf.argFunc ? fcnt : fnRows;
                                  else if (wf.funcName === 'SUM') val = fcnt > 0 ? fsum : null;
                                  else if (wf.funcName === 'AVG') val = fcnt > 0 ? Number((fsum / fcnt).toFixed(2)) : null;
                                  else val = fbest;
                              }
                          } else if (wf.funcName === 'ROW_NUMBER') {
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
                              const back = wf.funcName === 'LAG';
                              if (wf.ignoreNulls && wf.argFunc) {
                                  // NULL 行を数えずに argOffset 件ぶん遡る / 進む
                                  let need = wf.argOffset, i2 = idx;
                                  val = null;
                                  while (need > 0) {
                                      i2 = back ? i2 - 1 : i2 + 1;
                                      if (i2 < 0 || i2 >= pRows.length) { val = null; break; }
                                      const cand = wf.argFunc(pRows[i2], this.tables, aliases);
                                      if (cand === null || cand === undefined) continue;
                                      need--;
                                      if (need === 0) val = cand;
                                  }
                              } else {
                                  const tIdx = back ? idx - wf.argOffset : idx + wf.argOffset;
                                  val = (tIdx >= 0 && tIdx < pRows.length && wf.argFunc)
                                      ? wf.argFunc(pRows[tIdx], this.tables, aliases)
                                      : null;
                              }
                          } else if (wf.funcName === 'NTILE') {
                              // NTILE(n): パーティションを n 個のバケットへ等分割（先頭側を大きく）
                              const n = Math.max(1, Math.floor(wf.argFunc ? Number(wf.argFunc(ptr, this.tables, aliases)) : 1));
                              const size = pRows.length;
                              const per = Math.floor(size / n), rem = size % n;
                              val = idx < rem * (per + 1)
                                  ? Math.floor(idx / (per + 1)) + 1
                                  : rem + Math.floor((idx - rem * (per + 1)) / Math.max(1, per)) + 1;
                          } else if (wf.funcName === 'FIRST_VALUE' || wf.funcName === 'LAST_VALUE' || wf.funcName === 'NTH_VALUE') {
                              // IGNORE NULLS 指定時は NULL 行を除いた並びで数える
                              const nth = wf.funcName === 'NTH_VALUE' ? wf.argOffset : (wf.funcName === 'FIRST_VALUE' ? 1 : -1);
                              val = null;
                              if (wf.argFunc) {
                                  if (wf.ignoreNulls) {
                                      const vals = [];
                                      for (let i2 = 0; i2 < pRows.length; i2++) {
                                          const cand = wf.argFunc(pRows[i2], this.tables, aliases);
                                          if (cand !== null && cand !== undefined) vals.push(cand);
                                      }
                                      val = nth === -1 ? (vals.length ? vals[vals.length - 1] : null)
                                                       : (nth >= 1 && nth <= vals.length ? vals[nth - 1] : null);
                                  } else {
                                      const t = nth === -1 ? pRows.length - 1 : nth - 1;
                                      val = (t >= 0 && t < pRows.length) ? wf.argFunc(pRows[t], this.tables, aliases) : null;
                                  }
                              }
                          } else if (wf.funcName === 'PERCENT_RANK') {
                              // (rank - 1) / (行数 - 1)。1行のみのパーティションは 0
                              let rankValStr = wf.oFuncs.map(f => f.eval(ptr, this.tables, aliases)).join('|||');
                              if (rankValStr !== currentRankValStr) { rank = idx + 1; currentRankValStr = rankValStr; }
                              val = pRows.length > 1 ? (rank - 1) / (pRows.length - 1) : 0;
                          } else if (wf.funcName === 'CUME_DIST') {
                              val = cumeDist ? cumeDist[idx] : null;
                          }
                          ptr[wf.wfId] = val;
                      });

                      // ORDER BY なしの集計系ウィンドウ関数はパーティション全体の値を全行へ適用
                      // （明示フレーム指定時はフレームの計算結果をそのまま使う）
                      if (!wf.frame && wf.oFuncs.length === 0 && ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].includes(wf.funcName)) {
                          const lastVal = pRows.length > 0 ? pRows[pRows.length - 1][wf.wfId] : null;
                          pRows.forEach(ptr => ptr[wf.wfId] = lastVal);
                      }
                  }
              });
          }

          // 小計行を生成する拡張 GROUP BY:
          //   GROUP BY ... WITH ROLLUP / ROLLUP(...) — 接頭辞階層の小計＋総計
          //   GROUP BY CUBE(...)                     — 全部分集合の小計＋総計
          //   GROUP BY GROUPING SETS ((a,b),(a),())  — 明示した集合ごとの集計
          // いずれも「GROUP BY 項目の索引集合」へ正規化し、buildAggRow の nulledSet で表現する。
          let rollupMode = false;      // ROLLUP / CUBE / GROUPING SETS のいずれかが有効
          let groupingSetsSpec = null; // Array<Set<number>>（各出力集合の「有効な」索引集合）
          let groupByEff = groupByStr;
          if (groupByEff) {
              const wrM = groupByEff.match(/^([\s\S]+?)\s+with\s+rollup\s*$/i);
              if (wrM) { rollupMode = true; groupByEff = wrM[1]; }
              else {
                  const trimmed = groupByEff.trim();
                  const rpM = trimmed.match(/^rollup\s*\(([\s\S]+)\)$/i);
                  const cbM = trimmed.match(/^cube\s*\(([\s\S]+)\)$/i);
                  const gsM = trimmed.match(/^grouping\s+sets\s*\(([\s\S]+)\)$/i);
                  if (rpM) { rollupMode = true; groupByEff = rpM[1]; }
                  else if (cbM) {
                      rollupMode = true;
                      groupByEff = cbM[1];
                      // CUBE: 全部分集合。項目数 n の 2^n 通り（全項目有効 → ... → 総計）
                      const items = this.splitSelectClause(cbM[1]).map(s => s.trim());
                      if (items.length > 12) throw new Error("CUBE supports up to 12 grouping items.");
                      groupingSetsSpec = [];
                      for (let mask = (1 << items.length) - 1; mask >= 0; mask--) {
                          const act = new Set();
                          for (let i = 0; i < items.length; i++) if (mask & (1 << i)) act.add(i);
                          groupingSetsSpec.push(act);
                      }
                  } else if (gsM) {
                      rollupMode = true;
                      // GROUPING SETS: 括弧で列挙された各集合を解析し、和集合を GROUP BY 項目とする
                      const sets = [];
                      const allItems = [];
                      const idxOf = (txt) => {
                          const norm = (x) => String(x).toLowerCase().replace(/\s+/g, '');
                          for (let i = 0; i < allItems.length; i++) if (norm(allItems[i]) === norm(txt)) return i;
                          allItems.push(txt);
                          return allItems.length - 1;
                      };
                      this.splitSelectClause(gsM[1]).forEach(part => {
                          const p = part.trim();
                          const inner = p.match(/^\(([\s\S]*)\)$/);
                          if (inner) {
                              const body = inner[1].trim();
                              const act = new Set();
                              if (body !== '') this.splitSelectClause(body).forEach(c => act.add(idxOf(c.trim())));
                              sets.push(act);
                          } else {
                              // 括弧なしの単項目も 1 要素集合として受理する
                              sets.push(new Set([idxOf(p)]));
                          }
                      });
                      if (allItems.length === 0) throw new Error("GROUPING SETS requires at least one grouping item.");
                      groupByEff = allItems.join(', ');
                      groupingSetsSpec = sets;
                  }
              }
          }

          // キーはデータ値由来のため null プロトタイプ（'__proto__' 等の値による汚染防止）
          let groups = Object.create(null);
          let groupFuncs = null;
          let groupItems = null;
          if (groupByEff) {
              // GROUP BY は 序数 (GROUP BY 1) / SELECT 別名 / 式 を受け付ける。
              // 分割は括弧内カンマを保護する（GROUP BY CONCAT(a, b) 等）
              groupItems = this.splitSelectClause(groupByEff).map(s => s.trim());
              groupFuncs = groupItems.map(s => {
                  const g = s.trim();
                  if (/^\d+$/.test(g)) {
                      const ord = parseInt(g, 10);
                      if (ord < 1 || ord > compiledSelects.length) throw new Error(`GROUP BY position ${ord} is out of range.`);
                      const cs = compiledSelects[ord - 1];
                      if (cs.type !== 'expr') throw new Error(`GROUP BY position ${ord} must reference a plain (non-aggregate) select expression.`);
                      return cs.evalFunc;
                  }
                  // 実列に存在しない単純名は SELECT 別名として解決する（実列があれば列を優先）
                  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(g)) {
                      const lower = g.toLowerCase();
                      let isRealCol = false;
                      for (const a in aliases) {
                          const t = this.tables[aliases[a]];
                          if (t && t.cols[lower]) { isRealCol = true; break; }
                      }
                      if (!isRealCol) {
                          const byAlias = compiledSelects.find(cs => cs.type === 'expr' && cs.alias && String(cs.alias).toLowerCase() === lower);
                          if (byAlias) return byAlias.evalFunc;
                      }
                  }
                  return this.compileCondition(g, strMap);
              });
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
              // ROLLUP / GROUPING(): SELECT 式が GROUP BY のどの項目に対応するかを事前に対応付ける
              // （小計行で、まとめられた階層の列を NULL 表示・GROUPING()=1 にするため。
              //   式テキスト / 別名 / 序数で照合する）
              if (groupItems) {
                  const norm = (x) => String(x).toLowerCase().replace(/\s+/g, '');
                  compiledSelects.forEach((sel, si) => {
                      const target = sel.type === 'expr' ? (rollupMode ? (sel.rawExpr || '') : null)
                          : (sel.type === 'agg' && sel.func === 'GROUPING' ? sel.groupingExpr : null);
                      if (target === null) return;
                      sel._gi = -1;
                      for (let gi = 0; gi < groupItems.length; gi++) {
                          const g = groupItems[gi];
                          if (/^\d+$/.test(g)) {
                              if (sel.type === 'expr' && parseInt(g, 10) - 1 === si) { sel._gi = gi; break; }
                          } else if (norm(target) === norm(g) || (sel.type === 'expr' && sel.alias && norm(sel.alias) === norm(g))) {
                              sel._gi = gi;
                              break;
                          }
                      }
                  });
              }
              // 1 グループ分の出力行を組み立てる。nulledSet が非 null の場合は小計行であり、
              // そこに含まれる GROUP BY 項目の索引を NULL 表示・GROUPING()=1 とする。
              // （ROLLUP は接頭辞集合、CUBE は全部分集合、GROUPING SETS は明示集合を渡す）
              const buildAggRow = (groupPtrsAll, nulledSet) => {
                  let aggRow = {};
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'agg') {
                          // FILTER (WHERE cond) 付き集計は対象行を条件で絞る（無ければ全行）
                          const groupPtrs = sel.filterFunc
                              ? groupPtrsAll.filter(p => { try { return !!sel.filterFunc(p, this.tables, aliases); } catch (e) { return false; } })
                              : groupPtrsAll;
                          if (sel.func === 'COUNT') {
                              if (!sel.argFunc) {
                                  aggRow[sel.alias] = groupPtrs.length;
                              } else if (sel.distinct) {
                                  const seen = new Set();
                                  groupPtrs.forEach(ptr => {
                                      // COUNT(DISTINCT a, b): 複数列はどれかが NULL の行を除外し、組で重複判定
                                      if (sel.argFuncs && sel.argFuncs.length > 1) {
                                          const tup = sel.argFuncs.map(f => f(ptr, this.tables, aliases));
                                          if (tup.some(v => v === null || v === undefined)) return;
                                          seen.add(JSON.stringify(tup));
                                          return;
                                      }
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
                              let pairs = [];
                              const seen = sel.distinct ? new Set() : null;
                              groupPtrs.forEach(ptr => {
                                  let v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (v === null || v === undefined) return;
                                  if (seen) {
                                      if (seen.has(v)) return;
                                      seen.add(v);
                                  }
                                  pairs.push({ v: String(v), ord: sel.orderSpecs ? sel.orderSpecs.map(os => os.fn(ptr, this.tables, aliases)) : null });
                              });
                              if (sel.orderSpecs) this._sortAggPairs(pairs, sel.orderSpecs);
                              aggRow[sel.alias] = pairs.length > 0 ? pairs.map(p => p.v).join(sel.separator || ',') : null;
                          } else if (sel.func === 'JSON_ARRAYAGG') {
                              const pairs = [];
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  pairs.push({ v: v === undefined ? null : v, ord: sel.orderSpecs ? sel.orderSpecs.map(os => os.fn(ptr, this.tables, aliases)) : null });
                              });
                              if (sel.orderSpecs) this._sortAggPairs(pairs, sel.orderSpecs);
                              aggRow[sel.alias] = pairs.length > 0 ? JSON.stringify(pairs.map(p => p.v)) : null;
                          } else if (sel.func === 'JSON_OBJECTAGG') {
                              const obj = {};
                              let any = false;
                              groupPtrs.forEach(ptr => {
                                  const k2 = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (k2 === null || k2 === undefined) return;
                                  const v2 = sel.argFunc2 ? sel.argFunc2(ptr, this.tables, aliases) : null;
                                  obj[String(k2)] = v2 === undefined ? null : v2;
                                  any = true;
                              });
                              aggRow[sel.alias] = any ? JSON.stringify(obj) : null;
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
                          } else if (['STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'MEDIAN'].includes(sel.func)) {
                              let vals = [];
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (typeof v === 'number') vals.push(v);
                              });
                              if (sel.distinct) vals = [...new Set(vals)];
                              const isSamp = sel.func === 'STDDEV_SAMP' || sel.func === 'VAR_SAMP';
                              if (vals.length === 0 || (isSamp && vals.length < 2)) {
                                  // 標本分散/標本標準偏差は要素1件では未定義（NULL）
                                  aggRow[sel.alias] = null;
                              } else if (sel.func === 'MEDIAN') {
                                  vals.sort((a, b) => a - b);
                                  const mid = Math.floor(vals.length / 2);
                                  aggRow[sel.alias] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
                              } else {
                                  // STDDEV / VARIANCE / *_POP は母集団定義（MySQL 互換）、*_SAMP は n-1 の標本定義
                                  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                                  const sq = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0);
                                  const variance = sq / (isSamp ? vals.length - 1 : vals.length);
                                  const isVar = sel.func === 'VARIANCE' || sel.func === 'VAR_POP' || sel.func === 'VAR_SAMP';
                                  aggRow[sel.alias] = Number((isVar ? variance : Math.sqrt(variance)).toFixed(4));
                              }
                          } else if (sel.func === 'BIT_AND' || sel.func === 'BIT_OR' || sel.func === 'BIT_XOR') {
                              let acc = null;
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (typeof v !== 'number' || isNaN(v)) return;
                                  const n = Math.trunc(v);
                                  if (acc === null) acc = n;
                                  else acc = sel.func === 'BIT_AND' ? (acc & n) : (sel.func === 'BIT_OR' ? (acc | n) : (acc ^ n));
                              });
                              aggRow[sel.alias] = acc;
                          } else if (sel.func === 'ANY_VALUE') {
                              aggRow[sel.alias] = (groupPtrs.length > 0 && sel.argFunc) ? sel.argFunc(groupPtrs[0], this.tables, aliases) : null;
                          } else if (sel.func === 'MIN_BY' || sel.func === 'MAX_BY') {
                              // MIN_BY(ret, key) / MAX_BY(ret, key): key が最小/最大の行の ret 値。
                              // key が NULL の行は対象外。同値の場合は先に現れた行を採用する
                              let bestKey = null, bestVal = null;
                              groupPtrs.forEach(ptr => {
                                  const k = sel.argFunc2 ? sel.argFunc2(ptr, this.tables, aliases) : null;
                                  if (k === null || k === undefined) return;
                                  if (bestKey === null || (sel.func === 'MIN_BY' ? k < bestKey : k > bestKey)) {
                                      bestKey = k;
                                      bestVal = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  }
                              });
                              aggRow[sel.alias] = bestVal;
                          } else if (sel.func === 'COUNT_IF') {
                              // COUNT_IF(条件): 条件が真の行数
                              let cnt = 0;
                              groupPtrs.forEach(ptr => {
                                  if (sel.argFunc && sel.argFunc(ptr, this.tables, aliases)) cnt++;
                              });
                              aggRow[sel.alias] = cnt;
                          } else if (sel.func === 'GROUPING') {
                              // ROLLUP の小計行で「まとめられた」GROUP BY 列なら 1、それ以外は 0
                              aggRow[sel.alias] = (nulledSet !== null && sel._gi !== undefined && sel._gi !== -1 && nulledSet.has(sel._gi)) ? 1 : 0;
                          } else if (sel.func === 'BOOL_AND' || sel.func === 'BOOL_OR') {
                              // 非NULL値の真偽の全称/存在。非NULL値が無ければ NULL
                              let acc = null;
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (v === null || v === undefined) return;
                                  const b = !!v;
                                  if (acc === null) acc = b;
                                  else acc = sel.func === 'BOOL_AND' ? (acc && b) : (acc || b);
                              });
                              aggRow[sel.alias] = acc;
                          } else if (sel.func === 'REGR_COUNT') {
                              // 両方が非 NULL の行数
                              let rc = 0;
                              groupPtrs.forEach(ptr => {
                                  const x = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  const y = sel.argFunc2 ? sel.argFunc2(ptr, this.tables, aliases) : null;
                                  if (typeof x === 'number' && typeof y === 'number') rc++;
                              });
                              aggRow[sel.alias] = rc;
                          } else if (sel.func === 'MODE') {
                              // MODE() WITHIN GROUP (ORDER BY x): 最頻値（同数なら小さい方）
                              const freq = new Map();
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (v === null || v === undefined) return;
                                  freq.set(v, (freq.get(v) || 0) + 1);
                              });
                              let best = null, bestN = -1;
                              [...freq.keys()].sort().forEach(k => { if (freq.get(k) > bestN) { bestN = freq.get(k); best = k; } });
                              aggRow[sel.alias] = best;
                          } else if (sel.func === 'CORR' || sel.func === 'COVAR_POP' || sel.func === 'COVAR_SAMP' || sel.func.indexOf('REGR_') === 0) {
                              // 両方が数値の行のみ対象。CORR は母集団相関係数（小数4桁へ丸め）
                              const xs = [], ys = [];
                              groupPtrs.forEach(ptr => {
                                  const x = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  const y = sel.argFunc2 ? sel.argFunc2(ptr, this.tables, aliases) : null;
                                  if (typeof x === 'number' && typeof y === 'number') { xs.push(x); ys.push(y); }
                              });
                              const n = xs.length;
                              if (n === 0 || (sel.func !== 'COVAR_POP' && n < 2)) {
                                  aggRow[sel.alias] = null;
                              } else {
                                  const mx = xs.reduce((a, b) => a + b, 0) / n;
                                  const my = ys.reduce((a, b) => a + b, 0) / n;
                                  let sxy = 0, sxx = 0, syy = 0;
                                  for (let i = 0; i < n; i++) {
                                      sxy += (xs[i] - mx) * (ys[i] - my);
                                      sxx += (xs[i] - mx) * (xs[i] - mx);
                                      syy += (ys[i] - my) * (ys[i] - my);
                                  }
                                  const r4 = (x) => (x === null || !isFinite(x)) ? null : Number(x.toFixed(4));
                                  if (sel.func === 'COVAR_POP') aggRow[sel.alias] = r4(sxy / n);
                                  else if (sel.func === 'COVAR_SAMP') aggRow[sel.alias] = r4(sxy / (n - 1));
                                  // REGR_*: SQL標準の引数順は REGR_f(Y, X)。ここでの収集は
                                  // xs = 第1引数 = Y、ys = 第2引数 = X なので読み替える
                                  // （CORR / COVAR_* は対称なので影響しない）
                                  else if (sel.func.indexOf('REGR_') === 0) {
                                      const mY = mx, mX = my, sYY = sxx, sXX = syy;
                                      const slope = sXX === 0 ? null : sxy / sXX;
                                      if (sel.func === 'REGR_SLOPE') aggRow[sel.alias] = slope === null ? null : r4(slope);
                                      else if (sel.func === 'REGR_INTERCEPT') aggRow[sel.alias] = slope === null ? null : r4(mY - slope * mX);
                                      else if (sel.func === 'REGR_R2') aggRow[sel.alias] = (sXX === 0 || sYY === 0) ? null : r4((sxy * sxy) / (sXX * sYY));
                                      else if (sel.func === 'REGR_AVGX') aggRow[sel.alias] = r4(mX);
                                      else if (sel.func === 'REGR_AVGY') aggRow[sel.alias] = r4(mY);
                                      else if (sel.func === 'REGR_SXX') aggRow[sel.alias] = r4(sXX);
                                      else if (sel.func === 'REGR_SYY') aggRow[sel.alias] = r4(sYY);
                                      else aggRow[sel.alias] = r4(sxy);
                                  }
                                  else aggRow[sel.alias] = (sxx === 0 || syy === 0) ? null : r4(sxy / Math.sqrt(sxx * syy));
                              }
                          } else if (sel.func === 'PERCENTILE_CONT' || sel.func === 'PERCENTILE_DISC') {
                              // PERCENTILE_CONT(値, p): 線形補間の分位値 / PERCENTILE_DISC: 実在値から選択
                              const vals = [];
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (typeof v === 'number') vals.push(v);
                              });
                              if (vals.length === 0) {
                                  aggRow[sel.alias] = null;
                              } else {
                                  const p = sel.argFunc2 ? Number(sel.argFunc2(groupPtrs[0], this.tables, aliases)) : NaN;
                                  if (isNaN(p) || p < 0 || p > 1) throw new Error(`${sel.func} fraction must be a number between 0 and 1.`);
                                  vals.sort((a, b) => a - b);
                                  if (sel.func === 'PERCENTILE_DISC') {
                                      aggRow[sel.alias] = vals[Math.max(0, Math.ceil(p * vals.length) - 1)];
                                  } else {
                                      const rank = p * (vals.length - 1);
                                      const lo = Math.floor(rank), hi = Math.ceil(rank);
                                      aggRow[sel.alias] = lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (rank - lo);
                                  }
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
                          // 非集計列は FILTER の対象外（グループ全行を代表）
                          const groupPtrs = groupPtrsAll;
                          if (nulledSet !== null && sel._gi !== undefined && sel._gi !== -1 && nulledSet.has(sel._gi)) {
                              aggRow[sel.alias] = null;
                          } else {
                              aggRow[sel.alias] = groupPtrs.length > 0 ? sel.evalFunc(groupPtrs[0], this.tables, aliases) : null;
                          }
                      }
                  });
                  // 集計内包式（ROUND(AVG(x), 2) 等）は、すべての集計値が aggRow へ
                  // 揃った後に「aggRow を1行のテーブルに見立てて」評価する。
                  // （HAVING / QUALIFY と同じ出力行ベースの評価方式）
                  const aggExprs = compiledSelects.filter(s => s.type === 'aggexpr');
                  if (aggExprs.length > 0) {
                      const cols = {};
                      Object.keys(aggRow).forEach(k => cols[k.toLowerCase()] = true);
                      const getVal = (c) => {
                          const ak = Object.keys(aggRow).find(k => k.toLowerCase() === c.toLowerCase());
                          return ak !== undefined ? aggRow[ak] : null;
                      };
                      const pseudo = { dummy: { cols, getValue: getVal } };
                      aggExprs.forEach(sel => {
                          aggRow[sel.alias] = sel.evalFunc({ dummy: 0 }, pseudo, { dummy: 'dummy' });
                      });
                      // 集計内包式のために作った隠し列は出力へ含めない
                      for (const k in aggRow) if (k.startsWith('__se_')) delete aggRow[k];
                  }
                  return aggRow;
              };

              let aggResults = [];
              // 「有効な索引集合」で行をグループ化し、その集合の出力行を積む共通処理。
              // active に含まれない索引が nulledSet（NULL 表示・GROUPING()=1）となる。
              const emitForSet = (active) => {
                  const nulled = new Set();
                  for (let i = 0; i < groupFuncs.length; i++) if (!active.has(i)) nulled.add(i);
                  const superGroups = Object.create(null);
                  const orderKeys = [];
                  rowPtrs.forEach(ptr => {
                      const key = groupFuncs.map((f, i) => active.has(i) ? f(ptr, this.tables, aliases) : ' ').join('|||');
                      if (!superGroups[key]) { superGroups[key] = []; orderKeys.push(key); }
                      superGroups[key].push(ptr);
                  });
                  orderKeys.forEach(key => aggResults.push(buildAggRow(superGroups[key], nulled)));
              };

              if (groupingSetsSpec && groupFuncs) {
                  // CUBE / GROUPING SETS: 指定された各集合ごとに集計する（通常グループ行は作らない）
                  if (rowPtrs.length > 0) {
                      groupingSetsSpec.forEach(active => emitForSet(active));
                  } else {
                      // 空集合入力: 総計だけを持つ集合（空の active）があれば 1 行返す（COUNT(*)=0 等）
                      const hasTotal = groupingSetsSpec.some(s => s.size === 0);
                      if (hasTotal) aggResults.push(buildAggRow([], new Set(groupFuncs.map((_, i) => i))));
                  }
              } else {
                  Object.keys(groups).forEach(key => {
                      aggResults.push(buildAggRow(groups[key], null));
                  });
                  // ROLLUP: 階層 n-1 → 0 の小計行を通常グループの後ろへ追加する（階層 0 は総計行）
                  if (rollupMode && groupFuncs && rowPtrs.length > 0) {
                      for (let L = groupFuncs.length - 1; L >= 0; L--) {
                          const active = new Set();
                          for (let i = 0; i < L; i++) active.add(i);
                          emitForSet(active);
                      }
                  }
              }
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
              const tickO = this._mkTick();
              resultSet = rowPtrs.map(ptr => {
                  tickO();
                  let outRow = {};
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'star') {
                          for (let alias in ptr) {
                              let actualTbl = aliases[alias];
                              if (actualTbl && this.tables[actualTbl] && ptr[alias] !== -1) {
                                  const t = this.tables[actualTbl];
                                  t.getColumnNames().forEach(c => {
                                      if (sel.exclude && sel.exclude.has(c.toLowerCase())) return;
                                      outRow[c] = t.getValue(c, ptr[alias]);
                                  });
                              }
                          }
                          // * REPLACE: 同名列を差し替える（列順は元のまま）
                          if (sel.replace) {
                              sel.replace.forEach(r => {
                                  const key = Object.keys(outRow).find(k => k.toLowerCase() === r.col) || r.col;
                                  outRow[key] = r.evalFunc(ptr, this.tables, aliases);
                              });
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

          // QUALIFY: 出力行（ウィンドウ関数の別名を含む）に対するフィルタ。
          // HAVING と同じく出力行ベースで評価する（QUALIFY rn = 1 のように別名で参照する）
          if (qualifyStr && resultSet.length > 0) {
              const qFunc = this.compileCondition(qualifyStr, strMap);
              const qCols = {};
              Object.keys(resultSet[0]).forEach(k => qCols[k.toLowerCase()] = true);
              resultSet = resultSet.filter(row => {
                  const getVal = (c) => {
                      const ak = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
                      return ak !== undefined ? row[ak] : null;
                  };
                  return qFunc({ dummy: 0 }, { dummy: { cols: qCols, getValue: getVal } }, { dummy: 'dummy' });
              });
              // QUALIFY のために追加した隠しウィンドウ列は出力へ含めない
              resultSet.forEach(row => {
                  for (const k in row) if (k.startsWith('__ql_')) delete row[k];
              });
          }

          if (isDistinct && !distinctOn && resultSet.length > 0) {
              const seen = new Set();
              resultSet = resultSet.filter(row => {
                  const str = JSON.stringify(row, Object.keys(row).sort());
                  if (seen.has(str)) return false;
                  seen.add(str);
                  return true;
              });
          }

          // WITH TIES / DISTINCT ON は ORDER BY 適用後の順序に依存するため、
          // 並べ替えで使った列を後段で参照できるよう保持しておく
          let sortCols = null;
          if (orderItems && resultSet.length > 0) {
              // 隠しキー（__ob_/__oba_/__obv_/__hv_）は序数解決の対象から除外する
              const visibleKeys = Object.keys(resultSet[0]).filter(k => !/^__(ob|oba|obv|hv)_/.test(k));
              const orderCols = orderItems.map((item, i) => {
                  // 序数指定 (ORDER BY 1) は SELECT 出力の n 番目の列を指す
                  if (item.isOrdinal) {
                      const ord = parseInt(item.expr, 10);
                      if (ord < 1 || ord > visibleKeys.length) throw new Error(`ORDER BY position ${ord} is out of range.`);
                      return { col: visibleKeys[ord - 1], desc: item.desc, nulls: item.nulls };
                  }
                  // 単純な列名・別名は出力キーで解決する（別名が実列と重複する場合は別名優先）
                  if (/^[a-zA-Z0-9_.]+$/.test(item.expr)) {
                      const colName = item.expr.replace(/^[a-zA-Z0-9_]+\./, '');
                      const actualKey = Object.keys(resultSet[0]).find(k => k.toLowerCase() === colName.toLowerCase());
                      if (actualKey) return { col: actualKey, desc: item.desc, nulls: item.nulls };
                  }
                  // 行ポインタ段階で評価済みの式（未選択列を含む）
                  if (item.attachKey) return { col: item.attachKey, desc: item.desc, nulls: item.nulls };
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
                  return { col: key, desc: item.desc, nulls: item.nulls };
              });

              resultSet.sort((a, b) => {
                  for (let oc of orderCols) {
                      let valA = a[oc.col]; let valB = b[oc.col];
                      if (valA === valB) continue;
                      // NULL の並び順: 既定は ASC で先頭 / DESC で末尾。NULLS FIRST/LAST 指定時はそちらを優先
                      if (valA === null || valA === undefined) return oc.nulls ? (oc.nulls === 'first' ? -1 : 1) : (oc.desc ? 1 : -1);
                      if (valB === null || valB === undefined) return oc.nulls ? (oc.nulls === 'first' ? 1 : -1) : (oc.desc ? -1 : 1);
                      if (valA < valB) return oc.desc ? 1 : -1;
                      return oc.desc ? -1 : 1;
                  }
                  return 0;
              });
              sortCols = orderCols;
          }

          // DISTINCT ON (expr, ...): 並べ替え後の順序で、各キーの最初の行だけを残す
          if (distinctOn && resultSet.length > 0) {
              const keyOf = (row, expr) => {
                  const nm = expr.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase();
                  const k = Object.keys(row).find(x => x.toLowerCase() === nm);
                  if (k === undefined) throw new Error(`DISTINCT ON expression '${expr}' must appear in the SELECT list.`);
                  return row[k];
              };
              const seenOn = new Set();
              resultSet = resultSet.filter(row => {
                  const sig = JSON.stringify(distinctOn.map(e => keyOf(row, e)));
                  if (seenOn.has(sig)) return false;
                  seenOn.add(sig);
                  return true;
              });
          }

          // WITH TIES: 境界行と ORDER BY キーが等しい行を打ち切り位置の後ろに含める
          let tieExtra = 0;
          if (withTies && limitVal !== null && resultSet.length > 0) {
              if (!sortCols || sortCols.length === 0) throw new Error("WITH TIES requires an ORDER BY clause.");
              const off = offsetVal !== null ? Math.max(0, parseInt(offsetVal, 10)) : 0;
              const lim = /%$/.test(String(limitVal))
                  ? Math.max(1, Math.ceil(resultSet.length * parseFloat(limitVal) / 100))
                  : parseInt(limitVal, 10);
              const lastIdx = off + lim - 1;
              if (lastIdx >= 0 && lastIdx < resultSet.length - 1) {
                  const same = (a, b) => sortCols.every(oc => a[oc.col] === b[oc.col]);
                  let j = lastIdx + 1;
                  while (j < resultSet.length && same(resultSet[lastIdx], resultSet[j])) j++;
                  tieExtra = j - (lastIdx + 1);
              }
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
              let limit;
              if (limitVal !== null && /%$/.test(limitVal)) {
                  // TOP n PERCENT: 全体件数に対する割合（切り上げ、最低1件）
                  const pct = parseFloat(limitVal);
                  limit = resultSet.length === 0 ? 0 : Math.max(1, Math.ceil(resultSet.length * pct / 100));
              } else {
                  limit = (limitVal !== null && limitVal.toLowerCase() !== 'all') ? parseInt(limitVal, 10) : resultSet.length;
              }
              if (offset >= resultSet.length) {
                  resultSet = [];
              } else {
                  resultSet = resultSet.slice(offset, offset + limit + tieExtra);
              }
          }

          return { data: resultSet, affectedRows: resultSet.length };
      }
    });
