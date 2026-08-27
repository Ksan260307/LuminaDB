    // ============================================================================
    // [DatabaseEngine Select] - SELECT の解析 / 最適化 / 実行
    // ============================================================================

    // 集計関数名の一覧（先頭一致判定・式中判定・書き換えで共用）
    const LUMINA_AGG_NAMES = 'APPROX_COUNT_DISTINCT|COUNT_IF|COUNT|SUM|AVG|EVERY|PRODUCT|MAX_BY|MIN_BY|MAX|MIN|GROUP_CONCAT|STRING_AGG|LISTAGG|ARRAY_AGG|STDDEV_SAMP|STDDEV_POP|STDDEV|VARIANCE|VAR_SAMP|VAR_POP|MEDIAN|PERCENTILE_CONT|PERCENTILE_DISC|BIT_AND|BIT_OR|BIT_XOR|BOOL_AND|BOOL_OR|CORR|COVAR_POP|COVAR_SAMP|REGR_SLOPE|REGR_INTERCEPT|REGR_COUNT|REGR_R2|REGR_AVGX|REGR_AVGY|REGR_SXX|REGR_SYY|REGR_SXY|MODE|ANY_VALUE|GROUPING_ID|GROUPING|JSON_ARRAYAGG|JSON_OBJECTAGG';

    // 引数をちょうど 1 個だけ取る集計。余分な引数はカンマ式として最後の値だけが
    // 使われ「黙って別の答え」になるので、コンパイル時に弾く
    const LUMINA_ONE_ARG_AGGS = new Set([
        'SUM', 'AVG', 'MIN', 'MAX', 'COUNT_IF', 'ARRAY_AGG', 'JSON_ARRAYAGG',
        'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP',
        'MEDIAN', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'BOOL_AND', 'BOOL_OR', 'ANY_VALUE',
        'EVERY', 'PRODUCT', 'APPROX_COUNT_DISTINCT'
    ]);

    // OVER (...) を付けて使える関数。ここに無い名前は評価側の分岐に当たらず
    // 黙って NULL になるため、コンパイル時に弾くための照合表として持つ
    const LUMINA_WINDOW_FN_NAMES = new Set([
        'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE',
        'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE',
        'SUM', 'AVG', 'MIN', 'MAX', 'COUNT',
        // 分析関数（Oracle / SQL Server で常用）
        'RATIO_TO_REPORT', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'MEDIAN'
    ]);
    // パーティション全体を見て 1 つの値を出すウィンドウ関数（フレームは効かない）
    const LUMINA_WINDOW_WHOLE_PARTITION = new Set(['PERCENTILE_CONT', 'PERCENTILE_DISC', 'MEDIAN']);

    // SUM / AVG が足し込める値へ寄せる。集計対象でなければ null を返す。
    // 従来は `typeof v === 'number'` だけを見ていたため、BOOLEAN 列の SUM
    // （「フラグの立った件数」という定番の書き方）と、CSV 取り込み後によくある
    // 数値文字列の列がどちらも黙って 0 になっていた。MySQL / SQLite はどちらも
    // 数値として扱う。NULL・空文字・数値でない文字列は従来どおり集計から外す
    const LUMINA_AGG_NUM = (v) => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string') {
            const t = v.trim();
            if (t === '') return null;
            const n = Number(t);
            return isFinite(n) ? n : null;
        }
        return null;
    };
    // 式の「途中」に集計呼び出しが現れるか（ROUND(AVG(x),2) や a/SUM(b) を拾う）。
    // 直前が識別子文字だと my_sum( のような列名を誤検出するため、境界を明示する。
    const AGG_ANYWHERE = new RegExp('(^|[^A-Za-z0-9_.])(' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i');

    // 十進の値を「桁をずらした整数」で足し合わせる。
    //
    // SUM は倍精度で素朴に足していたため、DECIMAL(10,2) の列に 0.10 と 0.20 を入れて
    // SUM を取ると 0.30000000000000004 になり `SUM(price) = 0.30` が偽になっていた
    // （金額の計算が合わない）。二進小数では 0.1 も 0.2 も表せないのが原因。
    //
    // 値はいずれも「小数点以下 d 桁の十進数」として書ける（DECIMAL 列は格納時に
    // 位取りへ丸めてあり、それ以外も画面や CSV から入る値は有限桁）。そこで
    // いちばん深い桁 d を値から読み取り、10^d を掛けた整数として足して最後に割る。
    // 整数の範囲で収まらない・桁が深すぎる場合は倍精度の素朴な和へ戻す
    // （速さより「答えが変わらないこと」を優先する）。
    // LUMINA_DEC_PLACES は engine-expression.js（先に読まれる）で定義している。
    // 同名の const を 2 度宣言すると再宣言エラーになるため、ここでは持たない
    const LUMINA_EXACT_SUM = (nums) => {
        let plain = 0;
        for (let i = 0; i < nums.length; i++) plain += nums[i];
        let d = 0;
        for (let i = 0; i < nums.length; i++) {
            const p = LUMINA_DEC_PLACES(nums[i]);
            if (p < 0) return plain;                 // Infinity / NaN が混じる
            if (p > d) d = p;
        }
        if (d === 0) return plain;                   // 整数だけなら素朴な和で正確
        if (d > 12) return plain;                    // 桁が深すぎる（10^d が精度を食う）
        const f = Math.pow(10, d);
        let acc = 0;
        for (let i = 0; i < nums.length; i++) {
            const scaled = Math.round(nums[i] * f);
            // 掛けた時点で既に丸めが入っているなら整数化しても正確にならない
            if (!Number.isSafeInteger(scaled)) return plain;
            acc += scaled;
            if (!Number.isSafeInteger(acc)) return plain;
        }
        return acc / f;
    };

    Object.assign(DatabaseEngine.prototype, {

      // ORDER BY ... LIMIT n の上位 n 件だけを選ぶ（全体を並べ替えない）。
      //
      // 従来は必ず全件を sort してから slice していたので、20 万行から 10 行取る
      // `ORDER BY amt DESC, id LIMIT 10` が 20 万件ぶんの比較（約 180ms）を払っていた。
      //
      // 大きさ k の並んだ配列を持ち回り、満杯の後は「最下位より下なら 1 回の比較で捨てる」
      // だけにする。比較回数は最悪でも O(N log k)、実データでは大半が 1 回で終わる。
      //
      // 並びは「安定ソートして先頭 k 件を取ったもの」と一致させる必要がある。
      // 同値は既存要素の**後ろ**へ入れ（upper bound へ挿入）、満杯時に最下位と同値なら
      // 採らない（安定ソートならその行は後ろに回るので上位 k に入らない）
      _topNRows(rows, cmp, k) {
          if (k <= 0) return [];        // LIMIT 0。下の out[k-1] が undefined になるため先に返す
          const out = [];
          const upper = (row, hi) => {
              let lo = 0;
              while (lo < hi) {
                  const mid = (lo + hi) >> 1;
                  if (cmp(row, out[mid]) < 0) hi = mid; else lo = mid + 1;
              }
              return lo;
          };
          for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (out.length < k) {
                  out.splice(upper(row, out.length), 0, row);
              } else if (cmp(row, out[k - 1]) < 0) {
                  out.splice(upper(row, k - 1), 0, row);
                  out.pop();
              }
          }
          return out;
      },

      // 結合キー 1 個ぶんの「照合候補キー」を列挙する（複合キーのハッシュ結合用）。
      //
      // 満たすべき性質はただ一つ: __eq(a, b) が真なら keysOf(a) と keysOf(b) が
      // 必ず 1 個以上のキーを共有すること。これが成り立つ限り、ハッシュは
      // 「候補を絞る網」として使えて真の一致を取り落とさない。逆にキーが衝突して
      // 余計な候補が出るのは構わない（呼び出し側が ON 式そのもので検算するため）。
      //
      // __eq は __cpair で型を寄せる（数値らしい文字列と数値が一致する / 日付らしい
      // 文字列は時刻値で一致する）。だから値が数値にも日付にも読めるとき（'20260101'）は
      // 両方のキーを出す。生値だけを鍵にすると、この手の行が黙って結合から漏れる
      _joinKeysOf(v) {
          if (v === null || v === undefined) return null;   // NULL は等価結合に参加しない
          const keys = ['s:' + String(v)];                  // 同型どうしの生比較用
          // 数値への寄せ（__cpair の numOf と同じ規則）
          let n = NaN;
          if (typeof v === 'number') n = v;
          else if (typeof v === 'boolean') n = v ? 1 : 0;
          else if (typeof v === 'string') {
              const t = v.trim();
              if (t !== '') { const x = Number(t); if (isFinite(x)) n = x; }
          }
          if (!isNaN(n)) keys.push('n:' + n);
          // 日付への寄せ（__cpair の __dnum 経路）。列は日付を文字列で返すので
          // 見るのは文字列だけでよい。
          //
          // ここで Date.parse を頼れないことに注意: '2026-01-01' は UTC 深夜、
          // '2026-01-01 00:00:00' は現地深夜として解釈され、同じ瞬間を指す 2 つの
          // 綴りが別の数になる。__eq 側（__date_parse）がどちらの流儀でも
          // 取り落とさないよう、UTC 解釈と現地解釈の両方をキーに出す
          if (typeof v === 'string') {
              const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z?))?$/);
              if (m) {
                  const y = +m[1], mo = +m[2] - 1, d = +m[3];
                  const hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
                  keys.push('n:' + Date.UTC(y, mo, d, hh, mi, ss));
                  keys.push('n:' + new Date(y, mo, d, hh, mi, ss).getTime());
              }
          }
          return keys.length === 1 ? keys : [...new Set(keys)];
      },

      // 複数列ぶんの候補キーの直積を組む。1 列 1 キーの普通の場合は 1 本しか返らない
      _joinKeyCombos(valueKeys) {
          let combos = [''];
          for (const keys of valueKeys) {
              const next = [];
              for (const c of combos) for (const k of keys) next.push(c + '\0' + k);
              combos = next;
          }
          return combos;
      },

      // 集計関数呼び出し 1 件を compiledSelects 用の記述子へ変換する
      // （SELECT 句 / HAVING / ORDER BY の集計書き換えで共用）
      _compileAggSelect(func, argExpr, strMap, alias, filterExpr, keepSpec) {
          argExpr = (argExpr || '').trim();
          // 集計の入れ子（MAX(SUM(x)) 等）は SQL 標準でも不可。ここで弾かないと内側の
          // 集計名が列参照として解決され "Column 'sum' not found" という判りにくい
          // エラーになるため、意図の伝わる文言で拒否する
          if (/\b(?:COUNT|SUM|AVG|MAX|MIN|GROUP_CONCAT|STRING_AGG|LISTAGG|ARRAY_AGG|STDDEV(?:_POP|_SAMP)?|VARIANCE|VAR_POP|VAR_SAMP|MEDIAN|BIT_AND|BIT_OR|BIT_XOR|BOOL_AND|BOOL_OR|ANY_VALUE|EVERY|PRODUCT|APPROX_COUNT_DISTINCT)\s*\(/i.test(argExpr)) {
              throw new Error(`Aggregate functions cannot be nested: ${func}(${argExpr.slice(0, 40)}). Compute the inner aggregate in a subquery, then aggregate that.`);
          }
          // ARRAY_AGG は JSON_ARRAYAGG の別名（PostgreSQL/標準SQL 互換）
          if (func === 'ARRAY_AGG') func = 'JSON_ARRAYAGG';
          // EVERY は BOOL_AND の別名（SQL標準 / PostgreSQL）
          if (func === 'EVERY') func = 'BOOL_AND';
          // FILTER (WHERE cond): 集計対象をこの条件が真の行に限定する（SQL標準）
          const filterFunc = filterExpr ? this.compileCondition(filterExpr, strMap) : null;
          // GROUPING(col): ROLLUP の小計行で 1、通常行で 0 を返す。引数は GROUP BY 項目との
          // テキスト照合に使うため、コンパイルせず原文のまま保持する
          if (func === 'GROUPING') {
              return { type: 'agg', func, argFunc: null, groupingExpr: argExpr, alias };
          }
          // GROUPING_ID(a, b, ...): 各引数の GROUPING() をビットに詰めた整数（左端が最上位ビット）
          if (func === 'GROUPING_ID') {
              const exprs = this.splitSelectClause(argExpr).map(x => x.trim()).filter(x => x !== '');
              if (exprs.length === 0) throw new Error("GROUPING_ID requires at least one grouping expression.");
              if (exprs.length > 30) throw new Error("GROUPING_ID supports up to 30 grouping expressions.");
              return { type: 'agg', func, argFunc: null, groupingExprs: exprs, alias };
          }
          // COUNT(DISTINCT col) / SUM(DISTINCT col) などの重複除外集計
          let isDistinctAgg = false;
          if (/^DISTINCT\s+/i.test(argExpr)) {
              isDistinctAgg = true;
              argExpr = argExpr.replace(/^DISTINCT\s+/i, '');
          }
          // APPROX_COUNT_DISTINCT(x): 行数が少ない前提のエンジンなので近似せず
          // COUNT(DISTINCT x) と同じ厳密な値を返す（綴りの互換だけを提供する）
          if (func === 'APPROX_COUNT_DISTINCT') { func = 'COUNT'; isDistinctAgg = true; }
          // GROUP_CONCAT(col SEPARATOR 'x'): 区切り文字の指定（既定はカンマ）
          let separator = ',';
          const sepMatch = argExpr.match(/^([\s\S]+?)\s+SEPARATOR\s+__STR_(\d+)__$/i);
          if (sepMatch) {
              argExpr = sepMatch[1];
              separator = this._unquoteLiteral(strMap[Number(sepMatch[2])]);
          }
          // 連結系集計の「引数内 ORDER BY」。PostgreSQL の
          //   STRING_AGG(expr, sep ORDER BY x)  /  ARRAY_AGG(expr ORDER BY x)
          // と MySQL の GROUP_CONCAT(expr ORDER BY x SEPARATOR s) を同じ経路で受ける。
          // 各関数固有の引数分解より前に切り出すこと（切らないと ORDER BY が
          // 第2引数の一部として式コンパイルへ流れてしまう）。
          // 位置の判定は括弧深度を見る _topLevelKeyword で行う（入れ子関数の中の
          // ORDER BY に反応しないため）
          let orderSpecs = null;
          if (['GROUP_CONCAT', 'JSON_ARRAYAGG', 'STRING_AGG', 'LISTAGG'].includes(func)) {
              const obAt = this._topLevelKeyword(argExpr, 'order by');
              if (obAt > 0) {
                  // 'ORDER BY' の語間は空白でも改行でもよいので、実際の長さで切る
                  const ordText = argExpr.slice(obAt + this._keywordLenAt(argExpr, obAt, 'order by')).trim();
                  argExpr = argExpr.slice(0, obAt).trim();
                  orderSpecs = this.splitSelectClause(ordText).map(s => {
                      let e = s.trim();
                      let desc = false;
                      const dm = e.match(/\s+(asc|desc)$/i);
                      if (dm) { desc = dm[1].toLowerCase() === 'desc'; e = e.slice(0, dm.index).trim(); }
                      return { fn: this.compileCondition(e, strMap), desc };
                  });
              }
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
              } else if (func === 'GROUP_CONCAT') {
                  // GROUP_CONCAT(expr [, 'sep']): SQLite 形の第2引数も区切り文字として受ける
                  // （MySQL の SEPARATOR 構文は上で切り出し済み）。素通しすると
                  // 「a, '|'」がカンマ式として評価され、区切り文字そのものが連結されてしまう
                  const pp = this.splitSelectClause(argExpr);
                  if (pp.length > 2) throw new Error("GROUP_CONCAT takes 1 or 2 arguments (expr [, separator]).");
                  argFunc = this.compileCondition(pp[0], strMap);
                  if (pp.length === 2) {
                      const sepTok = pp[1].trim().match(/^__STR_(\d+)__$/);
                      separator = sepTok
                          ? this._unquoteLiteral(strMap[Number(sepTok[1])])
                          : String(this.compileCondition(pp[1], strMap)({}, {}, {}));
                  }
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
                  // 1 引数しか取らない集計に余分な引数を渡したら止める。
                  // 素通しするとカンマ式として最後の値だけが使われ、黙って別の答えになる
                  // COUNT は DISTINCT 付きのときだけ複数列を取れる。DISTINCT 無しの
                  // COUNT(a, b) は余分な引数が黙って捨てられていた
                  if (LUMINA_ONE_ARG_AGGS.has(func) || func === 'COUNT') {
                      const pp = this.splitSelectClause(argExpr);
                      if (pp.length > 1) {
                          throw new Error(`${func} takes exactly 1 argument but ${pp.length} were given.`);
                      }
                  }
                  argFunc = this.compileCondition(argExpr, strMap);
              }
          }
          return { type: 'agg', func, argFunc, argFunc2, argFuncs, distinct: isDistinctAgg, separator, orderSpecs, alias, filterFunc, keep: keepSpec || null };
      },

      // 式全体がちょうど 1 つの集計呼び出しか（括弧の対応で厳密に見る）
      _isWholeAggCall(expr) {
          const h = expr.match(new RegExp('^(' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i'));
          if (!h) return false;
          let d = 0;
          for (let i = h[0].length - 1; i < expr.length; i++) {
              if (expr[i] === '(') d++;
              else if (expr[i] === ')') { d--; if (d === 0) return i === expr.length - 1; }
          }
          return false;
      },

      // 末尾の FILTER (WHERE ...) を切り出す。正規表現の貪欲マッチだと
      // `COUNT(*) FILTER (WHERE g='a') + COUNT(*)` の条件部が
      // "g='a') + COUNT(*" のように壊れるため、括弧の対応で境界を決める
      _splitTrailingFilter(expr) {
          const re = /\bFILTER\s*\(/gi;
          let m;
          while ((m = re.exec(expr)) !== null) {
              const open = m.index + m[0].length - 1;
              let d = 0, close = -1;
              for (let i = open; i < expr.length; i++) {
                  if (expr[i] === '(') d++;
                  else if (expr[i] === ')') { d--; if (d === 0) { close = i; break; } }
              }
              if (close === -1) return null;
              if (expr.slice(close + 1).trim() !== '') continue;   // 末尾に無いなら別の FILTER
              const wm = expr.slice(open + 1, close).trim().match(/^WHERE\s+([\s\S]+)$/i);
              if (!wm) return null;
              return { head: expr.slice(0, m.index).trim(), cond: wm[1].trim() };
          }
          return null;
      },

      // 式の一部に書かれたウィンドウ呼び出しを取り出す。
      //   'val - LAG(val) OVER (ORDER BY id)'
      //     -> { outer: 'val - __WCALL_0__', calls: ['LAG(val) OVER (ORDER BY id)'] }
      // 呼び出しの先頭は OVER から左へ「引数の括弧」を辿って関数名まで戻して決める
      // （FILTER (WHERE ...) / IGNORE NULLS / FROM FIRST|LAST を挟む形も同じ経路）。
      // 取り出せない形は null を返し、呼び出し元が従来どおりのエラーにする
      _extractWindowCalls(expr) {
          const calls = [];
          let s = expr;
          for (let guard = 0; guard < 64; guard++) {
              const om = s.match(/\bOVER\s*\(/i);
              if (!om) break;
              const overAt = om.index;
              // 左へ戻って呼び出しの開始位置を決める
              let j = overAt - 1;
              const skipWs = () => { while (j >= 0 && /\s/.test(s[j])) j--; };
              skipWs();
              const before = () => s.slice(0, j + 1);
              let m = before().match(/(?:IGNORE|RESPECT)\s+NULLS$/i);
              if (m) { j = m.index - 1; skipWs(); }
              m = before().match(/FROM\s+(?:FIRST|LAST)$/i);
              if (m) { j = m.index - 1; skipWs(); }
              let start = -1;
              for (let hop = 0; hop < 4; hop++) {
                  if (s[j] !== ')') return null;
                  let depth = 0, k = j;
                  for (; k >= 0; k--) {
                      if (s[k] === ')') depth++;
                      else if (s[k] === '(') { depth--; if (depth === 0) break; }
                  }
                  if (k < 0) return null;
                  const nm = s.slice(0, k).match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
                  if (!nm) return null;
                  if (nm[1].toUpperCase() === 'FILTER') { j = nm.index - 1; skipWs(); continue; }
                  start = nm.index;
                  break;
              }
              if (start < 0) return null;
              // OVER (...) の閉じ括弧を探す
              const openAt = overAt + om[0].length - 1;
              let depth2 = 0, end = -1;
              for (let k = openAt; k < s.length; k++) {
                  if (s[k] === '(') depth2++;
                  else if (s[k] === ')') { depth2--; if (depth2 === 0) { end = k; break; } }
              }
              if (end < 0) return null;
              const token = `__WCALL_${calls.length}__`;
              calls.push(s.slice(start, end + 1).trim());
              s = s.slice(0, start) + token + s.slice(end + 1);
          }
          if (calls.length === 0) return null;
          if (/\bOVER\s*\(/i.test(s)) return null;
          return { outer: s.trim(), calls };
      },

      // GROUP BY の結果行は「SELECT の別名」でしか列を持たない。集計後に評価する式
      // （OVER (PARTITION BY / ORDER BY ...) の中身）が元の列名で書かれていると
      // 解決できないので、別名へ読み替える。
      //   SELECT grp AS g, ROW_NUMBER() OVER (ORDER BY grp) ... GROUP BY grp
      _aliasBareCols(text, compiledSelects, strMap) {
          if (!text) return text;
          // 別名を付け替えた「素の列」だけを対象にする（式や集計は対象外）
          const map = new Map();
          (compiledSelects || []).forEach(cs => {
              if (!cs || !cs.alias || typeof cs.rawExpr !== 'string') return;
              const src = cs.rawExpr.trim();
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(src)) return;
              const bare = src.replace(/^[a-zA-Z0-9_]+\s*\.\s*/, '').toLowerCase();
              if (bare === String(cs.alias).toLowerCase()) return;   // 読み替え不要
              if (!map.has(bare)) map.set(bare, cs.alias);
          });
          // 出力名（別名）の一覧。集計後の行はこの名前でしか列を持たない
          const outNames = new Set((compiledSelects || [])
              .filter(cs => cs && cs.alias).map(cs => String(cs.alias).toLowerCase()));
          if (map.size === 0 && outNames.size === 0) return text;
          const sm = [];
          let s = this._maskStrings(text, sm);
          s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?/g,
              (m, qual, name, call) => {
                  if (call) return m;                                  // 関数呼び出しは触らない
                  if (/^__/.test(name)) return m;                      // 内部トークン
                  const to = map.get(name.toLowerCase());
                  if (to !== undefined) return to;
                  // 表名で修飾した参照（`PARTITION BY c.tier`）は、集計後の行には
                  // 修飾なしの出力名しか無いので修飾を落とす。落とさないと
                  // 「Column 'c.tier' not found」になっていた
                  if (qual && outNames.has(name.toLowerCase())) return name;
                  return m;
              });
          return this._restoreStrings(s, sm);
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
          // 引数は2段の括弧ネストまで対応（HAVING SUM(ROUND(ABS(x), 2)) 等）。
          // 直後に続く FILTER (WHERE ...) も同じ集計の一部として取り込む。取り込まないと
          // ROUND(AVG(x) FILTER (WHERE c), 2) の FILTER が式の側に取り残されて壊れる
          const NEST = '(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*';
          const re = new RegExp('\\b(' + LUMINA_AGG_NAMES + ')\\s*\\((' + NEST + ')\\)' +
                                '(?:\\s*FILTER\\s*\\(\\s*WHERE\\s+(' + NEST + ')\\))?', 'gi');
          return str.replace(re, (m, fn, arg, filt) => {
              const alias = `${prefix}${compiledSelects.length}`;
              compiledSelects.push(this._compileAggSelect(fn.toUpperCase(), arg, strMap, alias, filt || null));
              return ` ${alias} `;
          });
      },

      // 集計後の行に対してウィンドウ関数を評価する。
      // 基底行に対する通常のウィンドウ処理とは別経路で、対象は「GROUP BY の出力行」。
      // フレーム指定は受け付けない（呼び出し側で拒否済み）ので、既定フレームだけを実装する:
      //   ORDER BY 無し → パーティション全体 / ORDER BY 有り → 先頭から現在行まで（累計）
      // 分位値の共通計算（集計版とウィンドウ版で同じ規則を使う）。
      //   PERCENTILE_DISC … 実在する値から選ぶ / PERCENTILE_CONT・MEDIAN … 線形補間
      _percentileOf(vals, kind, p) {
          const xs = vals.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
          if (xs.length === 0) return null;
          const frac = kind === 'MEDIAN' ? 0.5 : p;
          if (kind === 'PERCENTILE_DISC') return xs[Math.max(0, Math.ceil(frac * xs.length) - 1)];
          const rank = frac * (xs.length - 1);
          const lo = Math.floor(rank), hi = Math.ceil(rank);
          return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
      },

      _applyPostAggWindows(rows, specs, strMap) {
          if (rows.length === 0) {
              specs.forEach(w => { /* 行が無ければ列も作らない（実DBと同じ） */ void w; });
              return;
          }
          // 出力行に対して式を評価する（QUALIFY / ORDER BY と同じダミーテーブル方式）
          const cols = {};
          Object.keys(rows[0]).forEach(k => { cols[k.toLowerCase()] = true; });
          const evalOn = (fn, row) => {
              const getVal = (c) => {
                  const ak = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
                  return ak !== undefined ? row[ak] : null;
              };
              return fn({ dummy: 0 }, { dummy: { cols, getValue: getVal } }, { dummy: 'dummy' });
          };

          specs.forEach(w => {
            const argFn = w.argExpr ? this.compileCondition(w.argExpr, strMap) : null;
            const defFn = w.argDefaultExpr ? this.compileCondition(w.argDefaultExpr, strMap) : null;
            const partFns = w.partExprs.map(e => this.compileCondition(e, strMap));
            const ordFns = w.orderSpecs.map(o => ({ fn: this.compileCondition(o.expr, strMap), desc: o.desc }));

            // パーティションへ分ける（行の元順序は保つ）
            const parts = new Map();
            rows.forEach((row, idx) => {
                const key = partFns.length === 0 ? '' : JSON.stringify(partFns.map(f => evalOn(f, row)));
                if (!parts.has(key)) parts.set(key, []);
                parts.get(key).push({ row, idx });
            });

            parts.forEach(entries => {
                if (ordFns.length > 0) {
                    entries.sort((a, b) => {
                        for (const o of ordFns) {
                            const va = evalOn(o.fn, a.row), vb = evalOn(o.fn, b.row);
                            if (va === vb) continue;
                            if (va === null || va === undefined) return o.desc ? 1 : -1;
                            if (vb === null || vb === undefined) return o.desc ? -1 : 1;
                            return (va < vb) === !o.desc ? -1 : 1;
                        }
                        return a.idx - b.idx;   // 同順位は元の順序で安定させる
                    });
                }
                const n = entries.length;
                const keyOf = (e) => JSON.stringify(ordFns.map(o => evalOn(o.fn, e.row)));
                let sum = 0, cnt = 0, best = null;
                let rank = 1, dense = 0, prevKey = null;
                entries.forEach((e, i) => {
                    const val = argFn ? evalOn(argFn, e.row) : null;
                    const k = ordFns.length > 0 ? keyOf(e) : null;
                    if (k !== prevKey) { rank = i + 1; dense++; prevKey = k; }
                    let out = null;
                    switch (w.funcName) {
                        case 'ROW_NUMBER': out = i + 1; break;
                        case 'RANK': out = rank; break;
                        case 'DENSE_RANK': out = dense; break;
                        case 'PERCENT_RANK': out = n > 1 ? (rank - 1) / (n - 1) : 0; break;
                        case 'CUME_DIST': {
                            let le = 0;
                            entries.forEach(o2 => { if (keyOf(o2) <= k) le++; });
                            out = le / n; break;
                        }
                        case 'NTILE': {
                            const buckets = Math.max(1, Math.floor(Number(val) || 1));
                            const base = Math.floor(n / buckets), rem = n % buckets;
                            let seen = 0, bucket = buckets;
                            for (let b = 0; b < buckets; b++) {
                                seen += base + (b < rem ? 1 : 0);
                                if (i < seen) { bucket = b + 1; break; }
                            }
                            out = bucket; break;
                        }
                        case 'LAG': case 'LEAD': {
                            const t = w.funcName === 'LAG' ? i - w.argOffset : i + w.argOffset;
                            out = (t >= 0 && t < n && argFn) ? evalOn(argFn, entries[t].row)
                                : (defFn ? evalOn(defFn, e.row) : null);
                            break;
                        }
                        case 'FIRST_VALUE': out = argFn ? evalOn(argFn, entries[0].row) : null; break;
                        // ORDER BY 有りの既定フレームは「先頭〜現在行」なので LAST_VALUE は自分自身
                        case 'LAST_VALUE': out = argFn ? evalOn(argFn, entries[ordFns.length > 0 ? i : n - 1].row) : null; break;
                        case 'NTH_VALUE': {
                            const nth = Math.max(1, Math.floor(Number(w.argOffset) || 1));
                            out = (nth <= n && argFn) ? evalOn(argFn, entries[nth - 1].row) : null;
                            break;
                        }
                        case 'SUM': case 'AVG': case 'COUNT': case 'MIN': case 'MAX': {
                            if (w.frame) {
                                // 明示 ROWS フレーム: 現在行からの相対位置で切り出して数える
                                const bnd = (b, dflt) => {
                                    if (!b) return dflt;
                                    if (b.t === 'up') return 0;
                                    if (b.t === 'uf') return n - 1;
                                    if (b.t === 'cur') return i;
                                    if (b.t === 'pre') return i - b.n;
                                    if (b.t === 'fol') return i + b.n;
                                    return dflt;
                                };
                                const lo = Math.max(0, bnd(w.frame.start, 0));
                                const hi = Math.min(n - 1, bnd(w.frame.end, i));
                                let fsum = 0, fcnt = 0, fbest = null;
                                for (let k2 = lo; k2 <= hi; k2++) {
                                    const v2 = argFn ? evalOn(argFn, entries[k2].row) : 1;
                                    if (!argFn) { fcnt++; continue; }
                                    if (v2 === null || v2 === undefined) continue;
                                    fcnt++;
                                    const n2 = LUMINA_AGG_NUM(v2);
                                    if (n2 !== null) fsum += n2;
                                    if (fbest === null) fbest = v2;
                                    else if (w.funcName === 'MIN' ? v2 < fbest : v2 > fbest) fbest = v2;
                                }
                                if (w.funcName === 'COUNT') out = fcnt;
                                else if (w.funcName === 'SUM') out = fcnt > 0 ? fsum : null;
                                else if (w.funcName === 'AVG') out = fcnt > 0 ? fsum / fcnt : null;
                                else out = fbest;
                                break;
                            }
                            if (ordFns.length === 0) {
                                // フレーム無し＝パーティション全体をまとめて評価する
                                if (i === 0) {
                                    sum = 0; cnt = 0; best = null;
                                    entries.forEach(e2 => {
                                        const v2 = argFn ? evalOn(argFn, e2.row) : 1;
                                        if (!argFn) { cnt++; return; }
                                        if (v2 === null || v2 === undefined) return;
                                        cnt++;
                                        const n2 = LUMINA_AGG_NUM(v2);
                                        if (n2 !== null) sum += n2;
                                        if (best === null) best = v2;
                                        else if (w.funcName === 'MIN' ? v2 < best : v2 > best) best = v2;
                                    });
                                }
                            } else {
                                if (i === 0) { sum = 0; cnt = 0; best = null; }
                                if (!argFn) cnt++;
                                else if (val !== null && val !== undefined) {
                                    cnt++;
                                    const nv = LUMINA_AGG_NUM(val);
                                    if (nv !== null) sum += nv;
                                    if (best === null) best = val;
                                    else if (w.funcName === 'MIN' ? val < best : val > best) best = val;
                                }
                            }
                            if (w.funcName === 'COUNT') out = cnt;
                            else if (w.funcName === 'SUM') out = cnt > 0 ? sum : null;
                            else if (w.funcName === 'AVG') out = cnt > 0 ? sum / cnt : null;
                            else out = best;
                            break;
                        }
                        default:
                            throw new Error(`'${w.funcName}' is not supported as a window function over GROUP BY results.`);
                    }
                    e.row[w.alias] = out;
                });
            });
          });

          // 隠しウィンドウ列を本来の別名（あれば）へ移す作業は呼び出し側が行う。
          // ここでは wfId のキーで値だけを置いておく
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

          // OVER (...) の中身を丸ごと退避する。中の ORDER BY が文全体の ORDER BY として
          // 切り出されるのを防ぐため。
          // 正規表現で括弧を数えると入れ子の深さぶんだけ場合分けが要り、
          // 従来の書き方は 1 段までしか数えられなかった。そのため
          // `OVER (PARTITION BY CONCAT(a, CAST(x AS TEXT)) ORDER BY id)` のように
          // 2 段以上入れ子になると途中で切れ、式が壊れたまま先へ流れていた
          let overMap = [];
          {
              let out = '', i = 0;
              const re = /\bOVER\s*\(/gi;
              while (i < tempSql.length) {
                  re.lastIndex = i;
                  const m = re.exec(tempSql);
                  if (!m) { out += tempSql.slice(i); break; }
                  const open = m.index + m[0].length - 1;
                  let d = 0, j = open, close = -1;
                  for (; j < tempSql.length; j++) {
                      const ch = tempSql[j];
                      if (ch === '(') d++;
                      else if (ch === ')') { d--; if (d === 0) { close = j; break; } }
                  }
                  if (close === -1) { out += tempSql.slice(i); break; }
                  out += tempSql.slice(i, m.index);
                  overMap.push(tempSql.slice(m.index, close + 1));
                  out += `__OVER_${overMap.length - 1}__`;
                  i = close + 1;
              }
              tempSql = out;
          }

          // 集計関数内の ORDER BY（GROUP_CONCAT(x ORDER BY y) 等）が文全体の ORDER BY
          // 抽出に誤マッチしないよう、呼び出し全体を退避する（2段の括弧ネストまで）
          let aggMap = [];
          tempSql = tempSql.replace(/\b(GROUP_CONCAT|JSON_ARRAYAGG|ARRAY_AGG|STRING_AGG|LISTAGG)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/gi, (m) => {
              aggMap.push(m);
              return `__AGGFN_${aggMap.length - 1}__`;
          });

          // IS [NOT] DISTINCT FROM の FROM が FROM 句と誤認される（SELECT 1 IS DISTINCT FROM 2 で
          // '2' がテーブル名扱いになる）ため、句の切り出し中はトークンへ退避し、最後に復元する
          tempSql = tempSql.replace(/\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/gi, (m, not) => not ? '__ISNDF__' : '__ISDF__');
          // NTH_VALUE(...) FROM FIRST|LAST の FROM も同じ理由で退避する
          tempSql = tempSql.replace(/\)\s+FROM\s+(FIRST|LAST)\b/gi, (m, w) => ') __NTHFROM' + w.toUpperCase() + '__');
          // KEEP (DENSE_RANK ... ORDER BY ...) の ORDER BY が文の ORDER BY と誤認されるため、
          // 句の切り出し中はまるごとトークンへ退避する
          const keepMap = [];
          tempSql = tempSql.replace(/\s+KEEP\s*\(\s*DENSE_RANK\s+(?:FIRST|LAST)\s+ORDER\s+BY\s+(?:[^()]|\([^()]*\))*\)/gi, (m) => {
              keepMap.push(m);
              return ` __KEEPFN_${keepMap.length - 1}__`;
          });
          const restoreAgg = (x) => x == null ? x
              : x.replace(/__AGGFN_(\d+)__/g, (mm, i) => aggMap[i])
                 .replace(/__KEEPFN_(\d+)__/g, (mm, i) => keepMap[i])
                 .replace(/__NTHFROM(FIRST|LAST)__/g, (mm, w) => 'FROM ' + w)
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

          // 括弧の中の WHERE を文の WHERE と取り違えないよう、深度 0 の最初の WHERE で切る。
          // `COUNT(*) FILTER ( WHERE c)` のように開き括弧の後ろに空白や改行を入れると、
          // 単純な `\s+where\s+` が集計の FILTER 条件へ食い込んで文が壊れていた
          // （派生表はこの時点で実体化済みなので、文の WHERE は必ず深度 0 にある）
          const wAt = this._topLevelKeyword(tempSql, 'where');
          let wMatch = null;
          if (wAt !== -1) {
              let cut = wAt;
              while (cut > 0 && /\s/.test(tempSql[cut - 1])) cut--;
              wMatch = { index: cut, 1: tempSql.slice(wAt + 5) };
          }
          if(wMatch) { whereStr = wMatch[1]; tempSql = tempSql.substring(0, wMatch.index); }
          // 空の WHERE（`SELECT * FROM t WHERE`）は構文エラー。以前は条件が無いものとして
          // 全行を返しており、条件を書き忘れた・削り過ぎたクエリが黙って通っていた
          if (/\swhere\s*$/i.test(tempSql) || (wMatch && whereStr.trim() === '')) {
              throw new Error("Syntax Error: WHERE has no condition.");
          }
          // 集計は WHERE より後に評価されるので WHERE には書けない。以前は識別子解決まで
          // 落ちて「Column 'sum' not found.」になり、存在しない列を探させていた
          if (whereStr) {
              const aggInWhere = whereStr.match(new RegExp('(?:^|[^a-zA-Z0-9_.])(' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i'));
              if (aggInWhere) {
                  throw new Error(`Invalid use of aggregate function '${aggInWhere[1].toUpperCase()}' in WHERE. Filter on aggregates with HAVING instead.`);
              }
          }
          // WHERE / GROUP BY はウィンドウ関数より前に評価されるので、そこに書くことはできない
          // （SQL標準。実DBと同じく QUALIFY かサブクエリを案内する）。
          // この時点で OVER (...) は __OVER_n__ トークンへ退避済み
          if (whereStr && /__OVER_\d+__/.test(whereStr)) {
              throw new Error("Window functions are not allowed in WHERE (it is evaluated before windowing). Use QUALIFY, or wrap the query in a subquery.");
          }
          if (groupByStr && /__OVER_\d+__/.test(groupByStr)) {
              throw new Error("Window functions are not allowed in GROUP BY. Wrap the query in a subquery.");
          }

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

          // ORDER BY にウィンドウ関数を直書きした形（ORDER BY ROW_NUMBER() OVER (...)）も
          // 同じ要領で隠し列へ逃がす。並べ替えは出力行に対して行われるので、
          // 別名参照へ置き換えれば既存の経路でそのまま動く。
          // 隠し列 __ob_N は並べ替え後に出力から取り除く
          if (orderByStr && /__OVER_\d+__/.test(orderByStr)) {
              let oi = 0;
              orderByStr = orderByStr.replace(
                  /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(__OVER_\d+__)/g,
                  (m, fn, args, over) => {
                      const hidden = `__ob_${oi++}`;
                      selectClause += `, ${fn}(${args}) ${over} AS ${hidden}`;
                      return hidden;
                  }
              );
          }

          // 集計と併用されるウィンドウ関数が「式の一部」に埋まっている形
          // （`100.0 * SUM(x) / SUM(SUM(x)) OVER ()` のような全体比の計算）は、
          // ウィンドウ呼び出しだけを隠し列 __wx_N へ切り出して、残りを
          // 「集計後の行に対する式」へ均す。単独のウィンドウ項目はそのまま通す
          if (/__OVER_\d+__/.test(selectClause)
              && (groupByStr || new RegExp('\\b(?:' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i').test(selectClause))) {
              // FILTER (WHERE ...) / IGNORE NULLS の修飾を呼び出しの一部として飲み込む。
              // 飲み込まないと `SUM(x) FILTER (WHERE c) __OVER_0__` の 'FILTER' が
              // ウィンドウ関数名として切り出されてしまう
              const WCALL = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(((?:[^()]|\([^()]*\))*)\)((?:\s+FILTER\s*\(\s*WHERE\s+(?:[^()]|\([^()]*\))*\))?(?:\s+(?:IGNORE|RESPECT)\s+NULLS)?)\s*(__OVER_\d+__)/;
              // 「項目そのものが1つのウィンドウ式」かの判定は実際の検出と同じ形にする
              // （FILTER (WHERE ...) や IGNORE NULLS の修飾を含んだ形も単独項目とみなす）
              const SOLE_WINDOW = /^[A-Za-z_][A-Za-z0-9_]*\s*\((?:[^()]|\([^()]*\))*\)(?:\s+FILTER\s*\(\s*WHERE\s+(?:[^()]|\([^()]*\))*\))?(?:\s+(?:IGNORE|RESPECT)\s+NULLS)?\s*__OVER_\d+__$/i;
              const AGGCALL = new RegExp('\\b(?:' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i');
              const items = this.splitSelectClause(selectClause);
              let wi = 0;
              const extra = [];
              const rebuilt = items.map(raw => {
                  const item = raw.trim();
                  if (!WCALL.test(item)) return item;
                  const am = item.match(/^([\s\S]+?)\s+AS\s+([a-zA-Z0-9_]+)$/i);
                  const body = (am ? am[1] : item).trim();
                  const tailAlias = am ? ` AS ${am[2]}` : '';
                  if (SOLE_WINDOW.test(body)) return item;
                  // ウィンドウ呼び出しを外した残りに集計が無いなら、通常のウィンドウ経路で足りる
                  if (!AGGCALL.test(body.replace(new RegExp(WCALL.source, 'g'), ' '))) return item;
                  const replaced = body.replace(new RegExp(WCALL.source, 'g'), (m, fn, args, mods, over) => {
                      const hidden = `__wx_${wi++}`;
                      extra.push(`${fn}(${args})${mods || ''} ${over} AS ${hidden}`);
                      return hidden;
                  });
                  return replaced + tailAlias;
              });
              if (extra.length > 0) selectClause = rebuilt.concat(extra).join(', ');
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
          // ORDER BY ALL (DuckDB / BigQuery): SELECT 句の全項目を左から順に並べ替えキーにする。
          // 方向・NULLS 指定は全項目へ一括で適用する（ORDER BY ALL DESC 等）
          if (orderByStr !== null && /^\s*all\b/i.test(orderByStr)) {
              const suffix = orderByStr.replace(/^\s*all\b/i, '').trim();
              if (suffix !== '' && !/^(asc|desc)?(\s+nulls\s+(first|last))?$/i.test(suffix)) {
                  throw new Error(`Syntax error near 'ORDER BY ALL ${suffix}'. Only ASC / DESC / NULLS FIRST / NULLS LAST may follow ALL.`);
              }
              const n = this.splitSelectClause(selectClause).filter(p => p.trim() !== '').length;
              if (selectClause.trim() === '*' || /(^|,)\s*[a-zA-Z0-9_]*\s*\*\s*(,|$)/.test(selectClause)) {
                  throw new Error("ORDER BY ALL requires an explicit select list (not '*').");
              }
              orderByStr = Array.from({ length: n }, (_, i) => `${i + 1}${suffix ? ' ' + suffix : ''}`).join(', ');
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
          let indexValList = null;   // col IN (...) を索引で引くときの値リスト
          // 範囲検索を索引で引くときの両端: { lowV, lowInc, highV, highInc }
          let indexRange = null;
          // 全文検索の転置索引で絞り込んだ候補行（null なら使っていない）
          let ftRows = null;
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
              // 照合順序付きの列は索引が生値で作られているため、索引経路では
              // 正規化後の一致を拾えない。全表走査へ落として比較側で解決する
              const collated = (c) => !!(baseTbl.collations && baseTbl.collations[c]);
              if (col && !collated(col) && (!tblAlias || tblAlias === baseAlias || tblAlias === fromTable) && baseTbl.indices[col] && isLiteralVal) {
                  isIndexScan = true;
                  indexScanCol = col;
                  indexValStr = valStr.trim();
                  residualWhere = null;
              }
              // `col IN (v1, v2, ...)` も索引で引ける（等価一致の集合なのでハッシュ索引が効く）。
              // 主キーの複数指定は日常的に書かれる形なので、全表走査に落とさない
              if (!isIndexScan) {
                  const inM = whereStr.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s+IN\s*\(([^()]*)\)\s*$/i);
                  if (inM) {
                      const inCol = inM[2].toLowerCase();
                      const inAlias = inM[1] ? inM[1].toLowerCase() : null;
                      const items = this.splitSelectClause(inM[3]).map(x => x.trim()).filter(x => x !== '');
                      const allLiteral = items.length > 0 && items.every(x =>
                          /^(?:__STR_\d+__|null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(x));
                      if (!collated(inCol) && (!inAlias || inAlias === baseAlias || inAlias === fromTable) && baseTbl.indices[inCol] && allLiteral) {
                          isIndexScan = true;
                          indexScanCol = inCol;
                          indexValStr = null;
                          indexValList = items;
                          residualWhere = null;
                      }
                  }
              }
              // WHERE 全体がちょうど 1 個の等価（または IN）でないと、上の 2 つは
              // どちらも当たらず全表走査に落ちていた。`WHERE id = 4242 AND g = 42` の
              // ように主キー 1 本で 1 行に絞れる問い合わせが 5 万行を舐めていた。
              //
              // 深さ 0 の AND で分解して、索引のある等価の連言を 1 つ選んで索引で引く。
              // ここが上の 2 経路と違うのは residualWhere を null にしない点:
              // 索引は候補を絞る網としてだけ使い、WHERE は元の形のまま候補に対して
              // 評価する。こうすると全表走査と同じ述語が同じように適用されるので、
              // 索引を使ったせいで答えが変わることがない（絞る行数だけが変わる）
              if (!isIndexScan) {
                  const conj = this._splitTopLevelAnd(whereStr);   // 深さ 0 の OR があれば [] が返る
                  // 連言が 1 つだけでもここへ来る（`WHERE id > 100` のような単独の範囲）。
                  // 単独の等価は上の 2 経路で既に決まっているので、ここには落ちてこない
                  if (conj.length >= 1) {
                      const cands = [];
                      for (const c of conj) {
                          const m = c.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/)
                                 || c.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/);
                          if (!m) continue;
                          const cCol = (m.length === 4 ? m[2] : m[1]).toLowerCase();
                          const cAlias = m.length === 4 ? m[1].toLowerCase() : null;
                          const cVal = (m.length === 4 ? m[3] : m[2]).trim();
                          if (!/^(?:__STR_\d+__|null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(cVal)) continue;
                          if (collated(cCol)) continue;
                          if (cAlias && cAlias !== baseAlias && cAlias !== fromTable) continue;
                          if (!baseTbl.indices[cCol]) continue;
                          cands.push({ col: cCol, val: cVal });
                      }
                      // 全文検索を転置索引で引けないか見る。
                      //
                      // MATCH ... AGAINST は行ごとに本文を語へ切って走査する関数なので、
                      // 表が大きいほど正比例して遅くなっていた。CREATE FULLTEXT INDEX が
                      // 張ってあれば、語 -> 行の対応から候補行だけを取り出せる。
                      //
                      // 索引は候補を絞る網としてだけ使い、判定は MATCH 式そのもので行う
                      // （residualWhere を残す）。だから索引側は「取りこぼさない」ことだけ
                      // 満たせばよく、余分に拾うのは構わない:
                      //   - 語句 "a b" は全語を含む行の積（隣接判定は検算側）
                      //   - 前方一致 `語*` はその接頭辞を持つ全語の和
                      //   - 除外 `-語` は候補を狭めない（検算側で落ちる）
                      // 正の語が 1 つも無い問い合わせ（全部 `-`）は候補を作れないので使わない
                      if (cands.length === 0 && !indexRange) {
                          for (const c of conj) {
                              const fm = c.match(/^\s*MATCH\s*\(([^()]+)\)\s*AGAINST\s*\(\s*(__STR_\d+__)\s*(?:IN\s+([A-Za-z ]+?)\s+MODE\s*)?\)\s*$/i);
                              if (!fm) continue;
                              const mCols = fm[1].split(',').map(x => x.trim().replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase());
                              const sm = fm[2].match(/^__STR_(\d+)__$/);
                              if (!sm || !strMap || strMap[Number(sm[1])] === undefined) continue;
                              const qText = this._unquoteLiteral(strMap[Number(sm[1])]);
                              // MATCH の列とちょうど同じ組み合わせの索引だけを使う（MySQL と同じ規則）
                              let ftCols = null;
                              for (const nm in (baseTbl.ftIndexes || {})) {
                                  const ic = baseTbl.ftIndexes[nm].cols;
                                  if (ic.length === mCols.length && ic.every(x => mCols.includes(x))) { ftCols = ic; break; }
                              }
                              if (!ftCols) continue;
                              const parsedFt = LUMINA_FT_PARSE(qText, fm[3] || '');
                              const positive = parsedFt.terms.filter(x => x.sign !== '-');
                              if (positive.length === 0) continue;
                              const postings = baseTbl.ftPostings(ftCols);
                              const cand = new Set();
                              let usable = true;
                              for (const term of positive) {
                                  let rows = null;
                                  const toks = term.toks;
                                  for (let ti = 0; ti < toks.length; ti++) {
                                      const isLast = ti === toks.length - 1;
                                      let got;
                                      if (term.prefix && isLast) {
                                          got = new Set();
                                          for (const k of postings.keys()) {
                                              if (k.startsWith(toks[ti])) for (const r of postings.get(k)) got.add(r);
                                          }
                                      } else {
                                          got = new Set(postings.get(toks[ti]) || []);
                                      }
                                      rows = rows === null ? got : new Set([...rows].filter(r => got.has(r)));
                                      if (rows.size === 0) break;
                                  }
                                  if (rows === null) { usable = false; break; }
                                  for (const r of rows) cand.add(r);
                              }
                              if (!usable) continue;
                              ftRows = [...cand].sort((a, b) => a - b);   // 行順は表の物理順へ戻す
                              residualWhere = whereStr;                   // MATCH 式そのもので検算する
                              break;
                          }
                      }

                      // 等価が無ければ範囲（>, >=, <, <=, BETWEEN）を索引で引けないか見る。
                      // ハッシュ索引に並べたキーを持たせたので、両端を二分探索で求めて
                      // その区間のキーだけを引けば済む（従来はここが全表走査だった）
                      if (cands.length === 0) {
                          let rCol = null, lowV = null, lowInc = false, highV = null, highInc = false;
                          const litOf = (txt) => {
                              const s = txt.trim();
                              if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
                              const sm = s.match(/^__STR_(\d+)__$/);
                              if (sm && strMap && strMap[Number(sm[1])] !== undefined) return this._unquoteLiteral(strMap[Number(sm[1])]);
                              return undefined;
                          };
                          for (const c of conj) {
                              const bm = c.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s+BETWEEN\s+(.+?)\s+AND\s+(.+?)\s*$/i);
                              const cm = bm ? null : c.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s*(>=|<=|>|<)\s*(.+?)\s*$/);
                              const m = bm || cm;
                              if (!m) continue;
                              const cCol = m[2].toLowerCase();
                              const cAlias = m[1] ? m[1].toLowerCase() : null;
                              if (cAlias && cAlias !== baseAlias && cAlias !== fromTable) continue;
                              if (collated(cCol) || !baseTbl.indices[cCol]) continue;
                              if (rCol !== null && rCol !== cCol) continue;
                              if (bm) {
                                  const a = litOf(bm[3]), b = litOf(bm[4]);
                                  if (a === undefined || b === undefined) continue;
                                  rCol = cCol; lowV = a; lowInc = true; highV = b; highInc = true;
                              } else {
                                  const v = litOf(cm[4]);
                                  if (v === undefined) continue;
                                  rCol = cCol;
                                  if (cm[3][0] === '>') { lowV = v; lowInc = cm[3] === '>='; }
                                  else { highV = v; highInc = cm[3] === '<='; }
                              }
                          }
                          if (rCol !== null && (lowV !== null || highV !== null)) {
                              const sorted = baseTbl.sortedIndexKeys(rCol);
                              if (sorted && sorted.length > 0 && typeof sorted[0] === typeof (lowV !== null ? lowV : highV)) {
                                  // 両端の位置をここで確定させる。区間の広さが判るので、
                                  // 「索引で引くほうが高い」ケースを先に弾ける
                                  let from = 0, to = sorted.length;
                                  if (lowV !== null) {
                                      from = Table.lowerBound(sorted, lowV);
                                      if (!lowInc) while (from < sorted.length && sorted[from] === lowV) from++;
                                  }
                                  if (highV !== null) {
                                      to = Table.lowerBound(sorted, highV);
                                      if (highInc) while (to < sorted.length && sorted[to] === highV) to++;
                                  }
                                  if (to < from) to = from;
                                  // 索引経路はキー 1 個ごとに Map を引いて行番号の配列を継ぐので、
                                  // 区間が広いと素直に 1 回走査するほうが速い。実測では表の半分を
                                  // 拾う `id > 100000` が索引 43.7ms / 全表走査 13.6ms だった。
                                  // 相異なりキーの 1/4 を超えたら全表走査に任せる
                                  if ((to - from) <= sorted.length * 0.25) {
                                      isIndexScan = true;
                                      indexScanCol = rCol;
                                      indexValStr = null;
                                      indexRange = { from, to };
                                      residualWhere = whereStr;   // 元の WHERE で検算する
                                  }
                              }
                          }
                      }
                      if (cands.length > 0) {
                          // 索引が複数あるなら、いちばん細かく割れているものを選ぶ。
                          // 統計は持っていないので、主キー / UNIQUE を最優先し、あとは
                          // 相異なりキー数（Map の大きさ）を選択率の代わりに使う
                          const uniq = new Set([
                              ...(baseTbl.primaryKey ? [String(baseTbl.primaryKey).toLowerCase()] : []),
                              ...((baseTbl.uniqueCols || []).map(c => String(c).toLowerCase()))
                          ]);
                          cands.sort((a, b) => {
                              const ua = uniq.has(a.col) ? 1 : 0, ub = uniq.has(b.col) ? 1 : 0;
                              if (ua !== ub) return ub - ua;
                              return (baseTbl.indices[b.col].size || 0) - (baseTbl.indices[a.col].size || 0);
                          });
                          isIndexScan = true;
                          indexScanCol = cands[0].col;
                          indexValStr = cands[0].val;
                          residualWhere = whereStr;      // 元の WHERE で検算する
                      }
                  }
              }
          }

          let explainPlan = [];
          // EXPLAIN の Details には内部トークンや内部表名が漏れていたので、
          // 文字列リテラルを書き戻し、一時表は由来の判る名前に言い換える
          const exDet = (s) => this._restoreStrings(String(s), strMap);
          const exName = (t) => {
              const n = String(t);
              let m2 = n.match(/^__tmp_cte_(.+)$/);
              if (m2) return `CTE '${m2[1]}'`;
              if (/^__tmp_series_\d+$/.test(n)) return 'GENERATE_SERIES';
              if (/^__tmp_\d+$/.test(n)) return '<derived table>';
              if (/^__tmp_/.test(n)) return '<materialised subquery>';
              return `'${n}'`;
          };
          // 行数の見積り。厳密である必要はなく、「どの段で何行に減る想定か」が
          // 判れば計画を読む役に立つ（従来は見積りが一切無かった）
          let exRows = this.tables[fromTable] ? this.tables[fromTable].rowCount : 0;
          const exPush = (op, details, rows) => {
              if (rows !== undefined && rows !== null) exRows = Math.max(0, Math.round(rows));
              explainPlan.push({ Step: explainPlan.length + 1, Operation: op, Details: exDet(details), Rows: exRows });
          };
          // 結合 1 段で行数が何倍になるかの目安。等価結合なら「右表の平均バケット長」、
          // 入れ子ループなら右表の行数（最悪ケース）を掛ける
          const exJoinFanout = (join, rightCol) => {
              const jt = this.tables[join.table];
              if (!jt) return 1;
              if (rightCol && jt.indices[rightCol]) {
                  const b = jt.indices[rightCol].size;
                  return b > 0 ? Math.max(1, jt.rowCount / b) : 1;
              }
              if (rightCol) {
                  // 索引が無い等価結合でも、キーの相異なり数は判らないので 1 対 1 を仮定する
                  return 1;
              }
              return Math.max(1, jt.rowCount);
          };
          if (isExplain) {
              if (isIndexScan) {
                  // 索引で何行に絞れるかを見積る。等価なら「平均バケット長 × 引く値の数」、
                  // 範囲なら「区間に入るキー数 × 平均バケット長」。範囲を等価扱いで
                  // 1 キー分と見積ると、後段の FILTER と掛け合わさって 0 行になっていた
                  const idx = this.tables[fromTable] && this.tables[fromTable].indices[indexScanCol];
                  const buckets = idx ? idx.size : 0;
                  const avg = buckets > 0 ? exRows / buckets : 1;
                  const n = indexRange ? Math.max(0, indexRange.to - indexRange.from)
                          : (indexValList ? indexValList.length : 1);
                  exPush('INDEX SCAN',
                      `Index ${indexRange ? `range over ${n} key(s)` : indexValList ? `lookup of ${indexValList.length} value(s)` : 'scan'} on '${fromTable}(${indexScanCol})'`,
                      Math.min(exRows, Math.max(n > 0 ? 1 : 0, avg * n)));
              } else if (ftRows) {
                  exPush('FULLTEXT INDEX SCAN',
                      `Fulltext index on '${fromTable}' narrowed to ${ftRows.length} candidate row(s)`,
                      ftRows.length);
              } else {
                  exPush('TABLE SCAN', `Full scan on ${exName(fromTable)}`, exRows);
              }
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
              // 複合キーのハッシュ結合。[{leftAlias, leftCol, rightCol}, ...] と、
              // キーに出来なかった残りの条件（`x.id < y.id` など）
              let hashKeys = null, hashResidual = null;

              const eqMatch = join.onCond.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*$/);
              if (eqMatch) {
                  let a1 = eqMatch[1].toLowerCase(), c1 = eqMatch[2].toLowerCase(), a2 = eqMatch[3].toLowerCase(), c2 = eqMatch[4].toLowerCase();
                  // 単純な等値 ON はハッシュ結合へ載せるが、列名は誰も検証していなかった。
                  // 存在しない列だとキーが両側 undefined になり、INNER は 0 件・LEFT は
                  // 右側が全 NULL という「もっともらしい結果」を返していた（実DBは全て
                  // エラー）。USING の分岐（すぐ上）と同じ規則で弾く。別名が未知の場合は
                  // 入れ子ループ側の既存エラーに任せるため素通しする
                  const colAt = (al, c) => {
                      const t = this.tables[aliases[al]];
                      return !!(t && t.cols && t.cols[c]);
                  };
                  if (aliases[a1] && !colAt(a1, c1)) throw new Error(`Column '${a1}.${c1}' not found (ON).`);
                  if (aliases[a2] && !colAt(a2, c2)) throw new Error(`Column '${a2}.${c2}' not found (ON).`);
                  // 照合順序付きの列はハッシュキーを生値で作れないため入れ子ループへ落とす
                  const collAt = (al, c) => {
                      const t = this.tables[aliases[al]];
                      return !!(t && t.collations && t.collations[c]);
                  };
                  if (aliases[a1] && a2 === join.alias) {
                      leftAliasMatch = a1; leftColMatch = c1; rightAliasMatch = a2; rightColMatch = c2; isHashJoin = true;
                  } else if (aliases[a2] && a1 === join.alias) {
                      leftAliasMatch = a2; leftColMatch = c2; rightAliasMatch = a1; rightColMatch = c1; isHashJoin = true;
                  }
                  if (isHashJoin && (collAt(leftAliasMatch, leftColMatch) || collAt(rightAliasMatch, rightColMatch))) isHashJoin = false;
              }

              // ON が「ちょうど 1 個の a.x = b.y」でないとき（複合キー・等価 + 範囲）は
              // 従来すべて入れ子ループへ落ちていた。正規化されたスキーマで最も普通に
              // 書かれる複合主キーの結合が 30,000 x 3,000 行で 16 秒かかっていたのはこれが原因。
              // 深さ 0 の AND で分解し、等価な連言をハッシュキーに、残りを検算条件に回す。
              //
              // 単一等価の場合は上の分岐が既に決めているので触らない（既存の索引利用と
              // エラー文言をそのまま保つため）
              if (!isHashJoin) {
                  const conj = this._splitTopLevelAnd(join.onCond);   // 深さ 0 の OR があれば [] が返る
                  if (conj.length > 1) {
                      const collAt2 = (al, c) => {
                          const t = this.tables[aliases[al]];
                          return !!(t && t.collations && t.collations[c]);
                      };
                      const colAt2 = (al, c) => {
                          const t = this.tables[aliases[al]];
                          return !!(t && t.cols && t.cols[c]);
                      };
                      const keys = [], rest = [];
                      for (const c of conj) {
                          const em = c.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*$/);
                          if (!em) { rest.push(c); continue; }
                          const a1 = em[1].toLowerCase(), c1 = em[2].toLowerCase();
                          const a2 = em[3].toLowerCase(), c2 = em[4].toLowerCase();
                          // 片側がこの結合で加わる表、もう片側が既に出ている表のときだけキーになる。
                          // `y.a = y.b`（右表内の絞り込み）や `x.a = z.b`（既出同士）は検算側へ回す
                          let lA, lC, rC;
                          if (a2 === join.alias && aliases[a1] && a1 !== join.alias) { lA = a1; lC = c1; rC = c2; }
                          else if (a1 === join.alias && aliases[a2] && a2 !== join.alias) { lA = a2; lC = c2; rC = c1; }
                          else { rest.push(c); continue; }
                          // 列が無い / 照合順序付き（生値では一致を拾えない）ものはキーにしない。
                          // 検算は ON 式そのもので行うので、回しても答えは変わらない
                          if (!colAt2(lA, lC) || !colAt2(join.alias, rC)) { rest.push(c); continue; }
                          if (collAt2(lA, lC) || collAt2(join.alias, rC)) { rest.push(c); continue; }
                          keys.push({ leftAlias: lA, leftCol: lC, rightCol: rC });
                      }
                      if (keys.length > 0) {
                          isHashJoin = true;
                          hashKeys = keys;
                          hashResidual = rest.length > 0 ? rest.join(' AND ') : null;
                          // EXPLAIN の見積りと索引判定に使う代表キー
                          leftAliasMatch = keys[0].leftAlias; leftColMatch = keys[0].leftCol;
                          rightAliasMatch = join.alias; rightColMatch = keys[0].rightCol;
                      }
                  }
              }

              if (isExplain) {
                  if (hashKeys) {
                      const on = hashKeys.map(k => `${k.leftAlias}.${k.leftCol} = ${join.alias}.${k.rightCol}`).join(' AND ');
                      exPush('HASH JOIN',
                          `Build hash on '${join.table}(${hashKeys.map(k => k.rightCol).join(', ')})', probe with ${on}`
                          + (hashResidual ? `, then verify ${hashResidual}` : ''),
                          exRows * exJoinFanout(join, rightColMatch));
                  } else if (isHashJoin) {
                      if (jTbl.indices[rightColMatch]) {
                          exPush('INDEX HASH JOIN', `Join '${join.table}' using index on '${rightColMatch}'`, exRows * exJoinFanout(join, rightColMatch));
                      } else {
                          exPush('HASH JOIN', `Build hash on '${join.table}.${rightColMatch}', probe with '${leftAliasMatch}.${leftColMatch}'`, exRows * exJoinFanout(join, rightColMatch));
                      }
                  } else {
                          exPush('NESTED LOOP JOIN', `Join '${join.table}' ON ${join.onCond}`, exRows * exJoinFanout(join, null));
                  }
              }

              return { ...join, isHashJoin, leftAliasMatch, leftColMatch, rightAliasMatch, rightColMatch, hashKeys, hashResidual };
          });

          if (isExplain) {
              // 選択率は MySQL 同様の固定値（等価 0.1 / 範囲 0.33）。荒くても
              // 「ここで大きく減る想定」が読めれば計画の役に立つ
              // 押し下げた分と結合後に残る分を分けて出す（実行と同じ判定を使う）
              const exSplit = this._splitPushdownWhere(residualWhere, fromTable, baseAlias, joinPlans);
              if (residualWhere) {
                  // 索引がある列なら見積りを推測で済ませない。
                  //
                  // 従来は固定の選択率（等価 0.1 / 範囲 0.33）だけだったので、
                  // `id > 49990`（実際 10 行）を 16,500 行と見積るなど、EXPLAIN の
                  // Rows が読む価値のない数字になっていた。索引は相異なりキー数を
                  // 知っているし、範囲は並べたキーの位置で「何キー分か」が判る。
                  // 統計を別に集める（ANALYZE）必要はなく、常に最新の実測値が使える
                  const statSel = (w) => {
                      const m = w.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s*(=|>=|<=|>|<)\s*(.+?)\s*$/)
                             || w.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s+(BETWEEN)\s+(.+?)\s*$/i);
                      if (!m) return null;
                      const al = m[1] ? m[1].toLowerCase() : null;
                      if (al && al !== baseAlias && al !== fromTable) return null;
                      const col = m[2].toLowerCase();
                      const idx = baseTbl.indices[col];
                      if (!idx || idx.size === 0) return null;
                      if (m[3] === '=') {
                          // 等価: 平均バケット長 / 全行 = 1 キー分の割合
                          return 1 / idx.size;
                      }
                      const sorted = baseTbl.sortedIndexKeys(col);
                      if (!sorted || sorted.length === 0) return null;
                      const lit = (txt) => {
                          const t2 = String(txt).trim();
                          if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t2)) return Number(t2);
                          const sm = t2.match(/^__STR_(\d+)__$/);
                          if (sm && strMap && strMap[Number(sm[1])] !== undefined) return this._unquoteLiteral(strMap[Number(sm[1])]);
                          return undefined;
                      };
                      if (/^between$/i.test(m[3])) {
                          const bm = m[4].match(/^(.+?)\s+AND\s+(.+)$/i);
                          if (!bm) return null;
                          const a = lit(bm[1]), b = lit(bm[2]);
                          if (a === undefined || b === undefined || typeof a !== typeof sorted[0]) return null;
                          const from = Table.lowerBound(sorted, a), to = Table.lowerBound(sorted, b);
                          return Math.max(0, to - from + 1) / sorted.length;
                      }
                      const v = lit(m[4]);
                      if (v === undefined || typeof v !== typeof sorted[0]) return null;
                      const at = Table.lowerBound(sorted, v);
                      const frac = m[3][0] === '>' ? (sorted.length - at) / sorted.length : at / sorted.length;
                      return Math.min(1, Math.max(0, frac));
                  };
                  // 索引経路が既に絞った列の条件は、FILTER 段で二重に掛けない。
                  // residualWhere には検算のため元の WHERE がそのまま入っているので、
                  // そのぶんを 1.0 として扱わないと見積りが 0 行に潰れる
                  const servedCol = isIndexScan ? indexScanCol : null;
                  const isServed = (p) => {
                      if (!servedCol) return false;
                      const m = p.match(/^\s*(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s*(?:=|>=|<=|>|<|\s+BETWEEN\s+|\s+IN\s*\()/i);
                      return !!m && m[2].toLowerCase() === servedCol;
                  };
                  const selOf = (w) => {
                      // 連言はそれぞれの選択率を掛ける（独立と仮定する）
                      const parts = this._splitTopLevelAnd(w);
                      if (parts.length > 0) {
                          let acc = 1, used = false;
                          for (const p of parts) {
                              if (isServed(p)) { used = true; continue; }
                              const s2 = statSel(p);
                              if (s2 !== null) { acc *= s2; used = true; }
                              else acc *= (/[<>]|between/i.test(p) ? 0.33 : 0.1);
                          }
                          if (used) return acc;
                      }
                      if (isServed(w)) return 1;
                      return /[<>]|between/i.test(w) ? 0.33 : 0.1;
                  };
                  if (exSplit.pushed) {
                      // 表示位置は結合の後ろになるが、実際には結合の前に効いている
                      exPush('FILTER (pushed down)', `Apply WHERE ${exSplit.pushed} before the join`, exRows * selOf(exSplit.pushed));
                  }
                  if (exSplit.residual) {
                      exPush('FILTER', `Apply WHERE ${exSplit.residual}`, exRows * selOf(exSplit.residual));
                  }
              }
              if (groupByStr) {
                  // グループ数は判らないので「半分に減る」程度の目安に留める
                  exPush('GROUP BY', `Group by ${groupByStr}`, Math.max(1, exRows / 2));
              } else if (parsed.selectClause && AGG_ANYWHERE.test(parsed.selectClause)) {
                  // GROUP BY の無い集計は必ず 1 行になる（従来この段は計画に出ていなかった）
                  exPush('AGGREGATE', 'Aggregate over the whole result (no GROUP BY)', 1);
              }
              if (havingStr) exPush('HAVING', `Filter by ${havingStr}`, Math.max(1, exRows / 2));
              if (parsed.qualifyStr) exPush('QUALIFY', `Filter by ${parsed.qualifyStr}`, Math.max(1, exRows / 2));
              // ウィンドウ関数は行数を変えないが、並べ替えと分割のコストがある段なので出す
              // この時点の selectClause は経路によって OVER が __OVER_n__ トークンの
              // ままの場合と復元済みの場合があるので、どちらでも拾えるようにする
              if (parsed.selectClause && /__OVER_\d+__|\bover\s*\(/i.test(parsed.selectClause)) {
                  exPush('WINDOW', 'Evaluate window functions', exRows);
              }
              if (parsed.isDistinct || parsed.distinctOn) {
                  exPush('DISTINCT', parsed.distinctOn ? `Distinct on (${parsed.distinctOn})` : 'Remove duplicate rows',
                      Math.max(1, exRows / 2));
              }
              if (orderByStr) exPush('ORDER BY', `Order by ${orderByStr}`, exRows);
              if (limitVal) {
                  const lim = String(limitVal).endsWith('%') ? exRows : Number(limitVal);
                  exPush('LIMIT', `Limit ${limitVal}`, isFinite(lim) ? Math.min(exRows, lim) : exRows);
              }
          }

          return { parsed, isIndexScan, indexScanCol, indexValStr, indexValList, indexRange, ftRows, residualWhere, aliases, joinPlans, explainPlan, isExplain };
      },

      // ------------------------------------------------------------------
      // 述語の押し下げ: WHERE のうち「基底表の列だけを見る条件」を切り出す。
      //
      // 従来は WHERE を必ず結合の**後**に評価していたため、
      //   SELECT ... FROM big a JOIN big b ON a.k = b.k WHERE a.id < 200
      // が 20 万行すべてを結合してから 200 行へ絞っていた（実測 5.0 秒）。
      // 同じ意味を派生表で書くと 18ms だったので、書き方だけで 267 倍違っていた。
      //
      // 安全性: 条件が基底表の列しか参照しないなら、結合の前後どちらで適用しても
      // INNER / LEFT の結果は同じ（WHERE は最終結果を絞るので、早く消した左行は
      // 後で消えるのと変わらない）。RIGHT / FULL は未マッチの右行が NULL 補完で
      // 残るため、左行を先に消すと「後段の WHERE で落ちるはずの行」が出てしまう
      // ので押し下げない。深さ 0 に OR がある式も分割しない
      // ------------------------------------------------------------------
      _splitPushdownWhere(residualWhere, fromTable, baseAlias, joinPlans) {
          const none = { pushed: null, residual: residualWhere };
          if (!residualWhere || !joinPlans || joinPlans.length === 0) return none;
          if (joinPlans.some(j => j.type === 'RIGHT' || j.type === 'FULL')) return none;
          const conj = this._splitTopLevelAnd(residualWhere);
          if (conj.length === 0) return none;

          const baseTbl = this.tables[fromTable];
          const baseNames = new Set([String(fromTable).toLowerCase(), String(baseAlias).toLowerCase()]);
          const otherNames = new Set();
          joinPlans.forEach(j => {
              if (j.table) otherNames.add(String(j.table).toLowerCase());
              if (j.alias) otherNames.add(String(j.alias).toLowerCase());
          });
          const keep = [], push = [];
          conj.forEach(c => {
              // 相関サブクエリのトークンは外側の行に依存するので触らない
              if (/__CORR(?:EX|SC|IN)_\d+__/.test(c)) { keep.push(c); return; }
              // 結合先の別名で修飾された参照があれば押し下げられない
              let refsOther = false, mm;
              const qre = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\./g;
              while ((mm = qre.exec(c))) {
                  const nm = mm[1].toLowerCase();
                  if (!baseNames.has(nm) && otherNames.has(nm)) { refsOther = true; break; }
              }
              if (refsOther) { keep.push(c); return; }
              // 修飾なしの列が結合先の表のものなら押し下げられない
              // （両方に在る曖昧な名前は _assertNoAmbiguousColumns が既に弾いている）
              const ure = /(^|[^a-zA-Z0-9_.])([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?/g;
              let onlyBase = true;
              while ((mm = ure.exec(c))) {
                  if (mm[3]) continue;                            // 関数呼び出し
                  const nm = mm[2].toLowerCase();
                  if (nm.startsWith('__')) continue;              // 内部トークン
                  if (baseTbl && baseTbl.cols && baseTbl.cols[nm]) continue;
                  for (const j of joinPlans) {
                      const jt = this.tables[j.table];
                      if (jt && jt.cols && jt.cols[nm]) { onlyBase = false; break; }
                  }
                  if (!onlyBase) break;
              }
              if (onlyBase) push.push(c); else keep.push(c);
          });
          if (push.length === 0) return none;
          return { pushed: push.join(' AND '), residual: keep.length > 0 ? keep.join(' AND ') : null };
      },

      _executeSelectPlan(plan, strMap) {
          if (plan.isExplain) {
              return { data: plan.explainPlan, affectedRows: plan.explainPlan.length };
          }

          const { parsed, isIndexScan, indexScanCol, indexValStr, indexValList, indexRange, ftRows, residualWhere, aliases, joinPlans } = plan;
          const { isDistinct, distinctOn, withTies, selectClause, fromTable, baseAlias, groupByStr, havingStr, qualifyStr, orderByStr, limitVal, offsetVal } = parsed;

          let rowPtrs = [];
          const baseTbl = this.tables[fromTable];

          if (isIndexScan) {
              // 索引キーのリテラルトークンを実値へ戻す
              const toVal = (raw) => {
                  let val = raw;
                  if (val.startsWith('__STR_')) {
                      let strIdx = parseInt(val.replace('__STR_', '').replace('__', ''));
                      return this._unquoteLiteral(strMap[strIdx]);
                  }
                  if (val.toLowerCase() === 'null') return null;
                  if (val.toLowerCase() === 'true') return true;
                  if (val.toLowerCase() === 'false') return false;
                  return isNaN(val) ? val : Number(val);
              };
              // 索引はキーを生値で持つので、比較側の型寄せ（__cpair）と食い違わないよう
              // 列の型に合わせてキーを正規化する。BOOLEAN 列に対する `ok = 1` は
              // 索引経路だと 1 というキーが無く 0 件になり、索引の有無で答えが変わっていた
              const normKey = (v) => {
                  const ct = baseTbl.colTypes ? baseTbl.colTypes[indexScanCol] : null;
                  if (ct === 'BOOLEAN' && v !== null && typeof v !== 'boolean') {
                      if (typeof v === 'number') return v !== 0;
                      if (typeof v === 'string') {
                          const t = v.trim().toLowerCase();
                          if (t === 'true' || t === '1') return true;
                          if (t === 'false' || t === '0') return false;
                      }
                  }
                  if ((ct === 'INTEGER' || ct === 'FLOAT') && typeof v === 'string' && v.trim() !== '') {
                      const n = Number(v);
                      if (isFinite(n)) return n;
                  }
                  return v;
              };
              // IN (...) は各値を索引で引いて和集合を取る（行の重複は除く）。
              //
              // 索引は生値をキーに持つのに比較側（__eq）は型を寄せるので、引く値を
              // 1 個に決めると寄せたぶんを取り落とす。normKey は宣言型の名前を
              // 数え上げて補正していたが 'INTEGER' と 'FLOAT' しか見ておらず、
              // **`INT` と書いた列は素通り**していた:
              //   CREATE TABLE t (g INT); CREATE INDEX ix ON t(g);
              //   SELECT * FROM t WHERE g = '2'    -- 索引経路で 0 件
              //   SELECT * FROM t WHERE (g = '2')  -- 全表走査で 2 件
              // BIGINT / SMALLINT / DECIMAL / REAL なども同じ穴に落ちていた。
              // 型名を足すのではなく、__eq が同値と見る候補値を全部引いて和集合を取る
              // （余分に引いても後段の比較で落ちるだけなので、取り落とさない側に倒す）
              const probeKeys = (v) => {
                  const out = [normKey(v)];
                  const add = (x) => { if (!out.some(y => y === x)) out.push(x); };
                  add(v);
                  if (typeof v === 'number') {
                      add(String(v));
                      if (v === 0) add(false);
                      if (v === 1) add(true);
                  } else if (typeof v === 'boolean') {
                      add(v ? 1 : 0); add(v ? '1' : '0');
                  } else if (typeof v === 'string') {
                      const t = v.trim();
                      if (t !== '') {
                          const n = Number(t);
                          if (isFinite(n)) {
                              add(n);
                              if (n === 0) add(false);
                              if (n === 1) add(true);
                          }
                      }
                  }
                  return out;
              };
              const keys = [];
              if (indexRange) {
                  // 範囲検索: 両端は計画時に二分探索で確定済み。その区間のキーだけを引く
                  const sorted = baseTbl.sortedIndexKeys(indexScanCol) || [];
                  for (let i = indexRange.from; i < indexRange.to && i < sorted.length; i++) keys.push(sorted[i]);
              } else {
                  for (const v of (indexValList ? indexValList.map(toVal) : [toVal(indexValStr)])) {
                      for (const k of probeKeys(v)) keys.push(k);
                  }
              }
              const seenRow = keys.length > 1 ? new Set() : null;
              for (const val of keys) {
                  const matchedIndices = baseTbl.indices[indexScanCol].get(val);
                  if (!matchedIndices) continue;
                  for(let i of matchedIndices) {
                      if (seenRow) { if (seenRow.has(i)) continue; seenRow.add(i); }
                      rowPtrs.push({ [fromTable]: i, [baseAlias]: i });
                  }
              }
              // 索引は挿入順を保つとは限らないので、行順を表の物理順へ戻す
              if (seenRow) rowPtrs.sort((a, b) => a[fromTable] - b[fromTable]);
          } else if (ftRows) {
              // 転置索引が出した候補行だけを並べる（判定は後段の WHERE がやる）
              for (const i of ftRows) rowPtrs.push({ [fromTable]: i, [baseAlias]: i });
          } else {
              for(let i=0; i<baseTbl.rowCount; i++) {
                  rowPtrs.push({ [fromTable]: i, [baseAlias]: i });
              }
          }

          // ------------------------------------------------------------------
          // 述語の押し下げ（WHERE の「基底表だけを見る条件」を結合より前に適用する）
          //
          // 従来は WHERE を必ず結合の**後**に評価していたため、
          //   SELECT ... FROM big a JOIN big b ON a.k = b.k WHERE a.id < 200
          // が 20 万行すべてを結合してから 200 行へ絞っていた（実測 5.0 秒）。
          // 同じ問い合わせを派生表で書くと 18ms なので、書き方だけで 267 倍違っていた。
          //
          // 安全性: 条件が基底表の列しか参照していなければ、結合の前後どちらで
          // 適用しても INNER / LEFT の結果は変わらない（WHERE は最終結果を絞るので、
          // 早く消した左行は後で消えるのと同じ）。ただし RIGHT / FULL では
          // 未マッチの右行が NULL 補完で残るため、左行を先に消すと後段の WHERE で
          // 落ちるはずの行が出てしまう → その場合は押し下げない
          // 曖昧な列名の検査は**押し下げより前**に、全別名を見た状態で行うこと。
          // 押し下げた条件は基底表の別名だけでコンパイルするので、後回しにすると
          // `WHERE amount > 50`（両表に amount がある）が黙って基底表側へ解決されてしまう
          if (residualWhere) this._assertNoAmbiguousColumns(residualWhere, aliases);

          const split = this._splitPushdownWhere(residualWhere, fromTable, baseAlias, joinPlans);
          const pushedWhere = split.pushed;
          const residualAfterJoin = split.residual;
          if (pushedWhere) {
              const baseAliases = { [baseAlias]: fromTable, [fromTable]: fromTable };
              const pf = this.compileCondition(
                  this._applyDateColumns(this._applyColumnCollations(pushedWhere, baseAliases), baseAliases), strMap);
              const tickP = this._mkTick();
              rowPtrs = rowPtrs.filter(ptr => { tickP(); return pf(ptr, this.tables, baseAliases); });
          }

          let ptrKeys = [fromTable, baseAlias];
          joinPlans.forEach(join => {
              let jTbl = this.tables[join.table];
              // RIGHT / FULL JOIN: マッチした右テーブル行を追跡し、未マッチ行を後段で補完する
              const matchedRight = (join.type === 'RIGHT' || join.type === 'FULL') ? new Set() : null;
              // LEFT / FULL JOIN: 右にマッチしない左行を NULL 補完で残す
              const keepUnmatchedLeft = (join.type === 'LEFT' || join.type === 'FULL');
              let newPtrs = [];
              if (join.hashKeys) {
                  // 複合キー（または等価 + 残余条件）のハッシュ結合。
                  //
                  // ハッシュは「候補を絞る網」でしかない。__eq の型寄せをキー側で
                  // 完全に再現するのは難しいので、_joinKeysOf は寄せの候補を多めに
                  // 出しておき（取り落としが無い側に倒す）、拾った候補は ON 式そのもので
                  // 検算する。入れ子ループと同じ onFunc を使うので答えは一致する
                  const onFunc = this.compileCondition(this._applyDateColumns(this._applyColumnCollations(this._assertNoAmbiguousColumns(join.onCond, aliases), aliases), aliases), strMap);
                  const keySpecs = join.hashKeys;
                  const rightMap = new Map();
                  for (let j = 0; j < jTbl.rowCount; j++) {
                      const perCol = [];
                      let hasNull = false;
                      for (const k of keySpecs) {
                          const ks = this._joinKeysOf(jTbl.getValue(k.rightCol, j));
                          if (!ks) { hasNull = true; break; }
                          perCol.push(ks);
                      }
                      if (hasNull) continue;               // NULL を含む行は等価結合に参加しない
                      for (const combo of this._joinKeyCombos(perCol)) {
                          let arr = rightMap.get(combo);
                          if (!arr) { arr = []; rightMap.set(combo, arr); }
                          arr.push(j);
                      }
                  }
                  const tickH = this._mkTick();
                  rowPtrs.forEach(ptr => {
                      const perCol = [];
                      let hasNull = false;
                      for (const k of keySpecs) {
                          const lt = this.tables[aliases[k.leftAlias]];
                          const ks = this._joinKeysOf(lt.getValue(k.leftCol, ptr[k.leftAlias]));
                          if (!ks) { hasNull = true; break; }
                          perCol.push(ks);
                      }
                      let matched = false;
                      if (!hasNull) {
                          const combos = this._joinKeyCombos(perCol);
                          let cand;
                          if (combos.length === 1) {
                              cand = rightMap.get(combos[0]) || [];
                          } else {
                              // 候補キーが複数あると同じ右行を二度拾えるので重複を除き、
                              // 行順を表の物理順へ戻す（入れ子ループと同じ並びを保つため）
                              const set = new Set();
                              for (const combo of combos) {
                                  const c = rightMap.get(combo);
                                  if (c) for (const j of c) set.add(j);
                              }
                              cand = [...set].sort((a, b) => a - b);
                          }
                          for (const j of cand) {
                              tickH();
                              const combPtr = { ...ptr, [join.table]: j, [join.alias]: j };
                              if (onFunc(combPtr, this.tables, aliases)) {
                                  newPtrs.push(combPtr);
                                  matched = true;
                                  if (matchedRight) matchedRight.add(j);
                              }
                          }
                      }
                      if (!matched && keepUnmatchedLeft) {
                          newPtrs.push({ ...ptr, [join.table]: -1, [join.alias]: -1 });
                      }
                  });
              } else if (join.isHashJoin) {
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
                  let onFunc = this.compileCondition(this._applyDateColumns(this._applyColumnCollations(this._assertNoAmbiguousColumns(join.onCond, aliases), aliases), aliases), strMap);
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

          // 押し下げた分は既に適用済みなので、残りだけを結合後に評価する
          if (residualAfterJoin) {
              let whereFunc = this.compileCondition(this._applyDateColumns(this._applyColumnCollations(this._assertNoAmbiguousColumns(residualAfterJoin, aliases), aliases), aliases), strMap);
              const tickW = this._mkTick();
              rowPtrs = rowPtrs.filter(ptr => { tickW(); return whereFunc(ptr, this.tables, aliases); });
          }

          // SELECT 句の出力名（別名）を集める。別名は「出力の名前」であって列参照では
          // ないので、曖昧列の検査からは外す。外さないと
          //   SELECT a.id AS id FROM a JOIN b ... ORDER BY id
          // のように、結合先と同名の別名を付けただけで「曖昧」と言われていた
          const selOutNames = new Set();
          const selExprsOnly = this.splitSelectClause(selectClause).map(p => {
              const item = p.trim();
              const am = item.match(/^([\s\S]+?)\s+AS\s+([a-zA-Z0-9_]+|__STR_\d+__)$/i);
              if (am) { selOutNames.add(am[2].toLowerCase()); return am[1]; }
              const ba = this._trailingAlias(item);
              if (ba) { selOutNames.add(String(ba.alias).toLowerCase()); return ba.expr; }
              return item;
          });

          // HAVING / QUALIFY / ORDER BY の曖昧な列名も、集計の切り出しで別名へ
          // 置き換わる前のこの時点で見る（切り出し後の文面には元の列名が残らない）。
          // これらの句は出力名でも解決できるので、別名は検査対象から外す
          if (havingStr) this._assertNoAmbiguousColumns(havingStr, aliases, selOutNames);
          if (qualifyStr) this._assertNoAmbiguousColumns(qualifyStr, aliases, selOutNames);
          if (orderByStr) this._assertNoAmbiguousColumns(orderByStr, aliases, selOutNames);

          this._assertNoAmbiguousColumns(selExprsOnly.join(', '), aliases);
          // SELECT 句の日付列にも目印を付ける（`hire + 30` を日数加算として畳むため）
          let selectParts = this.splitSelectClause(this._applyDateColumns(selectClause, aliases));
          let windowFuncs = [];

          const compileSelectPart = (part, partIdx) => {
              // 別名の切り出し。3 形態を受け付ける:
              //   1. AS <識別子>                     … SELECT id AS x
              //   2. AS "任意の文字列" / 'x'          … 退避済みトークン __STR_n__ を実文字列へ戻す
              //   3. AS 省略の後置別名                … SELECT id x / SELECT COUNT(*) c
              // 3 は SQL では一般的だが、末尾が裸の語になる構文（IS NULL / INTERVAL 1 DAY /
              // COLLATE NOCASE 等）と紛れるため _trailingAlias で保守的に判定する
              // `.` は改行に一致しないため、項目を複数行で書くと（`sal *\n2 + 1 AS x`）
              // 先頭アンカー無しの `(.+?)` が改行の後ろから一致し、式の前半が黙って捨てられる。
              // 先頭を固定し、任意の文字クラスで受ける
              const asMatch = part.match(/^([\s\S]+?)\s+AS\s+([a-zA-Z0-9_]+|__STR_\d+__)$/i);
              let bareAlias = null;
              if (!asMatch) bareAlias = this._trailingAlias(part.trim());
              let expr = asMatch ? asMatch[1].trim() : (bareAlias ? bareAlias.expr : part.trim());
              let alias = asMatch ? asMatch[2] : (bareAlias ? bareAlias.alias : expr.replace(/^[a-zA-Z0-9_]+\./, ''));
              const named = !!(asMatch || bareAlias);
              // 引用符付き別名（AS "col name"）は文字列として退避されているので実体へ戻す。
              // 戻さないと内部トークン __STR_0__ がそのまま列名として露出する
              const aliasStrM = named && /^__STR_(\d+)__$/.test(alias) ? alias.match(/^__STR_(\d+)__$/) : null;
              if (aliasStrM && strMap && strMap[Number(aliasStrM[1])] !== undefined) {
                  alias = this._unquoteLiteral(strMap[Number(aliasStrM[1])]);
              }
              // 別名の無い定数列は式そのものが列名になるが、`SELECT id, 0` のように
              // 整数に見える名前だと JS オブジェクトのキー順序で先頭へ回り、出力列の順序が
              // SELECT の並びと食い違う。文字列定数は内部トークン __STR_n__ が露出する。
              // どちらも位置ベースの columnN へ寄せる（VALUES 文と同じ命名規則）
              if (!named && (/^-?\d+(?:\.\d+)?$/.test(alias) || /^__STR_\d+__$/.test(alias))) {
                  alias = `column${partIdx + 1}`;
              }
              // 別名の無い「式」の列名は式のテキストそのものになるが、そこに文字列
              // リテラルが含まれると内部トークンが残る（`CONCAT(f, __STR_0__, l)` や
              // `CASE WHEN f=__STR_0__ ...`）。列名は書いたとおりの式であるべきなので
              // リテラルを書き戻す。上の columnN 化（別名が丸ごとトークンの場合）を
              // 通り抜けた「トークンを含むだけ」のケースがここに来る
              if (!named && strMap && /__STR_\d+__/.test(alias)) {
                  alias = this._restoreStrings(alias, strMap);
              }
              if (expr === '*') return { type: 'star' };
              // 修飾スター `u.*` / `users.*`: その別名（表）の列だけを展開する
              const qStarM = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*\*$/);
              if (qStarM) return { type: 'star', only: qStarM[1].toLowerCase() };
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

              // 式の一部にウィンドウ呼び出しが混じっている項目は、ここで切り分ける。
              // 下の wfMatch は「項目全体がちょうど 1 つのウィンドウ呼び出し」を前提とした
              // 正規表現なので、混じった形を渡すと OVER 句の中身を取り違える
              // （`LAG(v) OVER (ORDER BY id) + LEAD(v) OVER (ORDER BY id)` が 1 つの呼び出しに見える）
              if (/\bOVER\s*\(/i.test(expr)) {
                  const wxProbe = this._extractWindowCalls(expr);
                  if (wxProbe && wxProbe.outer !== '__WCALL_0__') return { type: 'winexpr', alias, rawExpr: expr };
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

              // Oracle の FIRST / LAST 集計:
              //   MAX(sal) KEEP (DENSE_RANK FIRST ORDER BY hire)
              //   = hire が最小（LAST なら最大）の行だけに絞ってから MAX(sal) を取る
              let keepSpec = null;
              const keepM = expr.match(/\s+KEEP\s*\(\s*DENSE_RANK\s+(FIRST|LAST)\s+ORDER\s+BY\s+([\s\S]+?)\s*\)\s*$/i);
              if (keepM) {
                  const ordTxt = keepM[2].trim();
                  const dm = ordTxt.match(/\s+(asc|desc)$/i);
                  keepSpec = {
                      last: keepM[1].toUpperCase() === 'LAST',
                      desc: !!(dm && dm[1].toLowerCase() === 'desc'),
                      fn: this.compileCondition(dm ? ordTxt.slice(0, dm.index).trim() : ordTxt, strMap)
                  };
                  expr = expr.slice(0, keepM.index).trim();
              }

              // 集計の FILTER (WHERE cond) 句を切り出す（末尾）。
              // 貪欲マッチなので `COALESCE(SUM(x) FILTER (WHERE c), -1)` のように
              // 式の途中にある FILTER まで飲み込みうる。切り出した前半の括弧が
              // 閉じていなければ「項目そのものの FILTER」ではないので触らない
              // （その形は集計内包式として _rewriteAggCalls が扱う）
              let filterExpr = null;
              const filterM = wfFilterExpr ? null : this._splitTrailingFilter(expr);
              // 前半がちょうど 1 つの集計呼び出しのときだけ「この項目自身の FILTER」。
              // それ以外（ROUND(AVG(x) FILTER (...), 2) や 1 + COUNT(*) FILTER (...)）は
              // 集計内包式として _rewriteAggCalls にまとめて扱わせる
              if (filterM && this._isWholeAggCall(filterM.head)) {
                  filterExpr = filterM.cond;
                  expr = filterM.head;
              }

              // IGNORE NULLS / RESPECT NULLS（SQL標準・Oracle・BigQuery）:
              // LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE で NULL 行を読み飛ばす
              let wfIgnoreNulls = false;
              // NTH_VALUE(x, n) FROM FIRST|LAST（SQL標準・Oracle）: 末尾から数える指定
              let nthFromLast = false;
              const fromEndM = expr.match(/^([\s\S]*?\))\s+FROM\s+(FIRST|LAST)\s+((?:IGNORE|RESPECT)\s+NULLS\s+)?OVER\s*\(([\s\S]*)\)$/i);
              if (fromEndM) {
                  nthFromLast = fromEndM[2].toUpperCase() === 'LAST';
                  expr = `${fromEndM[1]} ${fromEndM[3] || ''}OVER (${fromEndM[4]})`;
              }
              // OVER (...) の中身や引数を複数行で書く形（整形済み SQL では普通）を受けるため、
              // `.` ではなく [\s\S] で受ける（`.` は改行に一致しない）
              let wfMatch = expr.match(/^([a-zA-Z_]+)\s*\(([\s\S]*?)\)\s+(IGNORE|RESPECT)\s+NULLS\s+OVER\s*\(([\s\S]*?)\)$/i);
              if (wfMatch) {
                  wfIgnoreNulls = wfMatch[3].toUpperCase() === 'IGNORE';
                  wfMatch = [wfMatch[0], wfMatch[1], wfMatch[2], wfMatch[4]];
              } else {
                  wfMatch = expr.match(/^([a-zA-Z_]+)\s*\(([\s\S]*?)\)\s+OVER\s*\(([\s\S]*?)\)$/i);
              }
              if (wfMatch) {
                  let funcName = wfMatch[1].toUpperCase();
                  // 未対応のウィンドウ関数名は、評価側の分岐に当たらず黙って NULL になる。
                  // 「書いたのに何も出ない」より「使えないと言われる」ほうが判るので明示的に弾く。
                  // 引数をコンパイルする前に判定すること — `ROUND(SUM(x) OVER (), 2)` のように
                  // 式へ入れ子にした形では、切り出した「引数」が壊れた断片になっているため
                  if (!LUMINA_WINDOW_FN_NAMES.has(funcName)) {
                      const isAggName = new RegExp('^(?:' + LUMINA_AGG_NAMES + ')$', 'i').test(funcName);
                      if (!isAggName && this._isBuiltinFunctionName && this._isBuiltinFunctionName(funcName.toLowerCase())) {
                          throw new Error(`A window function cannot be nested inside ${funcName}(). Compute it in a subquery, then apply ${funcName}() to the result.`);
                      }
                      throw new Error(`'${funcName}' is not supported as a window function. Supported: ${[...LUMINA_WINDOW_FN_NAMES].join(', ')}.`);
                  }
                  let argStr = wfMatch[2].trim();
                  // DISTINCT 付きのウィンドウ集計は PostgreSQL / MySQL / SQL Server いずれも
                  // 受け付けない。素通しすると 'DISTINCT dept' が式として解決できず
                  // 内部的なエラー文になるため、意図の伝わる文言で拒否する
                  if (/^DISTINCT\s+/i.test(argStr)) {
                      throw new Error(`DISTINCT is not supported inside a window function (${funcName}(DISTINCT ...) OVER ()). Aggregate in a subquery first, then apply the window function.`);
                  }
                  // LAG(expr, offset) / LEAD(expr, offset) のようにカンマ区切り引数を許容
                  let argParts = argStr ? this.splitSelectClause(argStr) : [];
                  // 引数が要るウィンドウ関数の引数落ちを弾く。NTILE() は黙って
                  // 「全行が第1バケット」という誤りになり、NTH_VALUE(x) は NULL になっていた
                  const WIN_ARITY = { NTILE: [1, 1], NTH_VALUE: [2, 2], LAG: [1, 3], LEAD: [1, 3],
                                      FIRST_VALUE: [1, 1], LAST_VALUE: [1, 1] };
                  const wa = WIN_ARITY[funcName];
                  if (wa) {
                      const n = argParts.filter(p => String(p).trim() !== '').length;
                      if (n < wa[0] || n > wa[1]) {
                          throw new Error(`${funcName} takes ${wa[0] === wa[1] ? wa[0] : wa[0] + ' to ' + wa[1]} `
                              + `argument(s) but ${n} were given.`);
                      }
                  }
                  let firstArg = argParts[0] && argParts[0] !== '*' ? argParts[0] : null;
                  // 引数に集計呼び出しが入る形（`SUM(SUM(x)) OVER ()`）は集計後に評価するので、
                  // ここでコンパイルしてはいけない（`COUNT(*)` が JS の構文エラーになる）。
                  // 実体は _applyPostAggWindows が srcArg から作り直す
                  const argHasAgg = firstArg && new RegExp('\\b(?:' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i').test(firstArg);
                  let argFunc = (firstArg && !argHasAgg) ? this.compileCondition(firstArg, strMap) : null;
                  let argOffset = argParts.length > 1 ? parseInt(argParts[1], 10) : 1;
                  if (isNaN(argOffset)) argOffset = 1;
                  // LAG/LEAD の第3引数は「行が無かったときに返す既定値」。式として評価する
                  // （書かれていなければ NULL）。無視すると範囲外の行が黙って NULL になる
                  const argDefaultExpr = (funcName === 'LAG' || funcName === 'LEAD') && argParts.length > 2
                      ? argParts[2].trim() : null;
                  const argDefaultFunc = argDefaultExpr ? this.compileCondition(argDefaultExpr, strMap) : null;
                  // PERCENTILE_CONT(e, p) / PERCENTILE_DISC(e, p) は WITHIN GROUP の正規化後の形。
                  // 第2引数が分位点なので、行オフセットではなくそちらとして読む
                  let percentileP = 0.5;
                  if (LUMINA_WINDOW_WHOLE_PARTITION.has(funcName)) {
                      if (funcName !== 'MEDIAN') {
                          if (argParts.length !== 2) {
                              throw new Error(`${funcName} OVER () requires WITHIN GROUP (ORDER BY expr) with a fraction argument.`);
                          }
                          const pv = this.compileCondition(argParts[1].trim(), strMap)({}, this.tables, {});
                          percentileP = Number(pv);
                          if (!isFinite(percentileP) || percentileP < 0 || percentileP > 1) {
                              throw new Error(`${funcName} requires a fraction between 0 and 1.`);
                          }
                      }
                  }
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

                  // OVER 句を複数行で書くと `.` が改行に一致せず、ORDER BY の項目
                  // （`... ORDER BY sal\nDESC`）が丸ごと落ちて並び順が黙って無視されていた
                  let pMatch = overStr.match(/PARTITION\s+BY\s+([\s\S]+?)(?:\s+ORDER\s+BY\s+([\s\S]+))?$/i);
                  let partitionCols = [], orderCols = [];
                  // 分割は括弧内カンマを保護する（PARTITION BY CONCAT(a, b) 等）
                  if (pMatch) {
                      partitionCols = this.splitSelectClause(pMatch[1]).map(s=>s.trim());
                      if (pMatch[2]) orderCols = this.splitSelectClause(pMatch[2]).map(s=>s.trim());
                  } else {
                      let oMatch = overStr.match(/ORDER\s+BY\s+([\s\S]+)$/i);
                      if (oMatch) orderCols = this.splitSelectClause(oMatch[1]).map(s=>s.trim());
                  }

                  // PARTITION BY / ORDER BY にも集計呼び出しが来得るので、同じ理由で先送りする
                  const hasAggIn = (t) => new RegExp('\\b(?:' + LUMINA_AGG_NAMES + ')\\s*\\(', 'i').test(t);
                  let pFuncs = partitionCols.map(c => hasAggIn(c) ? null : this.compileCondition(c, strMap));
                  // OVER (ORDER BY ...) の各項目は「式 [ASC|DESC] [NULLS FIRST|LAST]」。
                  // 空白で切って先頭語を式と見なしていたため、空白を含む式
                  // （CAST(x AS TEXT) / CASE ... END / a + b）が途中で切れて
                  // 「括弧が閉じていない」という的外れなエラーになっていた
                  let oFuncs = orderCols.map(s => {
                      const m = String(s).trim().match(
                          /^([\s\S]+?)(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?$/i);
                      const body = (m ? m[1] : String(s)).trim();
                      const desc = !!(m && m[2] && m[2].toUpperCase() === 'DESC');
                      return { eval: hasAggIn(body) ? null : this.compileCondition(body, strMap), desc };
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

                  // フレームを書かずに ORDER BY だけを書いた OVER 句の既定フレームは
                  // SQL 標準では RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW。
                  // つまり **同じ並び順の値を持つ行（ピア）はまとめて同じ値になる**。
                  // 従来は既定が無く行単位の逐次累算（＝ROWS 相当）へ落ちていたため、
                  // 日次売上の累計などで同日の行に途中経過が出ていた。
                  // ORDER BY が無い場合はパーティション全体が対象（既存の分岐のまま）
                  const FRAMED_FNS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE'];
                  if (!frame && oFuncs.length > 0 && FRAMED_FNS.includes(funcName)) {
                      frame = { unit: 'RANGE', start: { t: 'up' }, end: { t: 'cur' }, exclude: 'NO OTHERS', implicit: true };
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
                  // 集計と併用された場合は「集計後の行」に対して評価し直すため、
                  // 引数・PARTITION BY・ORDER BY の原文も保持しておく
                  windowFuncs.push({ wfId, funcName, argFunc, argOffset, argDefaultFunc, argDefaultExpr,
                      percentileP, nthFromLast, pFuncs, oFuncs, frame, ignoreNulls: wfIgnoreNulls,
                      srcArg: firstArg, srcPartition: partitionCols.slice(),
                      // 末尾の ASC|DESC と NULLS FIRST|LAST を落として式だけを残す。
                      // NULLS 句を見ていなかったため、GROUP BY 結果に対するウィンドウで
                      // `OVER (ORDER BY SUM(x) DESC NULLS LAST)` と書くと式が
                      // `__wa_3  DESC NULLS LAST` のまま残って壊れていた
                      srcOrder: orderCols.map(s => {
                          const p = s.trim();
                          const dm2 = p.match(/^([\s\S]+?)(?:\s+(asc|desc))?(?:\s+nulls\s+(?:first|last))?$/i);
                          return { expr: dm2 ? dm2[1].trim() : p,
                                   desc: !!(dm2 && dm2[2] && dm2[2].toLowerCase() === 'desc') };
                      }) });

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
                      return this._compileAggSelect(aggHead[1].toUpperCase(), expr.slice(open + 1, close).trim(), strMap, alias, filterExpr, keepSpec);
                  }
              }
              if (filterExpr) throw new Error("FILTER (WHERE ...) is only supported on aggregate functions.");
              // ここまで来て OVER が残っているのは「式の途中にウィンドウ関数を書いた」形
              // （val - LAG(val) OVER (ORDER BY id) など）。ウィンドウ呼び出しを隠し列へ
              // 切り出し、外側の式はその値と元の列を使って行ごとに評価する（type: 'winexpr'）。
              // 実際の切り出しは compiledSelects が揃ったあとの後段で行う
              if (/\bOVER\s*\(/i.test(expr) || /__OVER_\d+__/.test(expr)) {
                  return { type: 'winexpr', alias, rawExpr: expr };
              }
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
          };
          let compiledSelects = selectParts.map(compileSelectPart);

          // ウィンドウ内包式: 式の一部に書かれたウィンドウ呼び出しを別の項目として
          // コンパイルし（windowFuncs へ登録され、行ポインタに値が載る）、外側の式は
          // その値を疑似列 __wf_N として参照する形へ書き換える。
          // 集計と混ざった形（SUM(x) - LAG(SUM(x)) OVER ()）は評価の段が違うので従来どおり断る
          const WINEXPR_MSG = "A window function must be the whole select item (optionally with an alias). " +
              "Compute it in a subquery, then apply the surrounding expression to the result.";
          const winExprSels = compiledSelects.filter(s => s.type === 'winexpr');
          if (winExprSels.length > 0) {
              if (groupByStr || compiledSelects.some(s => s.type === 'agg' || s.type === 'aggexpr')) {
                  throw new Error(WINEXPR_MSG);
              }
              let extraIdx = selectParts.length;
              winExprSels.forEach(sel => {
                  const ex = this._extractWindowCalls(sel.rawExpr);
                  if (!ex) throw new Error(WINEXPR_MSG);
                  // ウィンドウ呼び出しを抜いたあとにも集計が残るなら、評価の段が違うので断る
                  if (AGG_ANYWHERE.test(ex.outer)) throw new Error(WINEXPR_MSG);
                  let outer = ex.outer;
                  sel.wfIds = [];
                  ex.calls.forEach((callText, i) => {
                      const idx = extraIdx++;
                      const compiled = compileSelectPart(callText, idx);   // windowFuncs への登録が目的
                      if (!compiled || compiled.type !== 'window') throw new Error(WINEXPR_MSG);
                      sel.wfIds.push(compiled.wfId);
                      outer = outer.split(`__WCALL_${i}__`).join(compiled.wfId);
                  });
                  sel.evalStr = outer;
                  sel.evalFunc = this.compileCondition(outer, strMap);
              });
          }

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

          // 行が 1 つも残っていないときは、式が一度も評価されないため列名の誤りが
          // 検出されない。空の表に対する `SELECT nosuchcol FROM t` が
          // エラーではなく「0 件」を返していた（表にデータがある間だけ気づける＝
          // 新しい DB や絞り込みで空になった時に typo が黙って通る）。
          // 実データ 1 行を使わずに、添字 -1（= NULL 扱い）で一度だけ評価して
          // 名前解決だけを走らせる。__resolve は「列が無ければ throw、
          // あるが添字が -1 なら null」なので、名前の誤りだけが表に出る
          if (rowPtrs.length === 0) {
              const nullPtr = Object.create(null);
              for (const al in aliases) nullPtr[al] = -1;
              const validate = (fn) => {
                  if (typeof fn !== 'function') return;
                  try { fn(nullPtr, this.tables, aliases); }
                  catch (e) {
                      // 名前解決の失敗だけを伝える（型変換など値依存の失敗は無視する）
                      if (e && e.message && /not found|is ambiguous|does not exist/i.test(e.message)) throw e;
                  }
              };
              compiledSelects.forEach(sel => {
                  // 'aggexpr' の外側の式は「集計後の疑似 1 行」（__se_N を列として持つ）に
                  // 対して評価されるものなので、基底表の行では解決できない。
                  // 中の集計呼び出しは別途 type:'agg' として展開されており、
                  // その argFunc をここで検査するので typo は取り逃さない
                  // 'winexpr' の外側の式も疑似列 __wf_N を参照するので同じ理由で外す
                  if (sel.type !== 'aggexpr' && sel.type !== 'winexpr') validate(sel.evalFunc);
                  validate(sel.argFunc);
                  validate(sel.argFunc2);
                  (sel.argFuncs || []).forEach(validate);
              });
          }

          let isAgg = compiledSelects.some(sel => sel.type === 'agg' || sel.type === 'aggexpr');

          // ウィンドウ関数と GROUP BY / 集計の併用（`SUM(SUM(x)) OVER ()` で全体比を出す、
          // `RANK() OVER (ORDER BY SUM(x))` でグループを順位付けする、といったレポートの定番）。
          // ウィンドウはグループ化の「後」に評価されるので、集計結果の行に対して別パスで計算する。
          // 引数・PARTITION BY・ORDER BY に含まれる集計呼び出しは隠し集計列 __wa_N へ逃がし、
          // 集計ループが値を埋めたあとで出力行ベースに評価し直す
          let postAggWindows = null;
          if (windowFuncs.length > 0 && (isAgg || groupByStr)) {
              postAggWindows = windowFuncs.map(wf => {
                  // 既定フレーム（implicit）は「書かれていない」のと同じ扱いにする。
                  // GROUP BY の結果は 1 グループ 1 行なのでピアが生じず、
                  // RANGE ... CURRENT ROW と行単位の累積は一致する。
                  // 明示フレームは ROWS（EXCLUDE 無し）だけ受ける — 行の並びだけで決まるので
                  // 集計後の行に対しても同じ意味になる。RANGE / GROUPS はピア判定が要るので断る
                  if (wf.frame && !wf.frame.implicit &&
                      (wf.frame.unit !== 'ROWS' || (wf.frame.exclude && wf.frame.exclude !== 'NO OTHERS'))) {
                      throw new Error("RANGE / GROUPS window frames are not supported over GROUP BY results " +
                                      "(ROWS frames are). Compute it in a subquery.");
                  }
                  const conv = (text) => this._aliasBareCols(
                      this._rewriteAggCalls(text, compiledSelects, strMap, '__wa_').trim(), compiledSelects, strMap);
                  const outSel = compiledSelects.find(cs => cs.type === 'window' && cs.wfId === wf.wfId);
                  return {
                      wfId: wf.wfId, alias: outSel ? outSel.alias : wf.wfId, funcName: wf.funcName,
                      argExpr: wf.srcArg ? conv(wf.srcArg) : null,
                      argOffset: wf.argOffset,
                      frame: (wf.frame && !wf.frame.implicit) ? wf.frame : null,
                      argDefaultExpr: wf.argDefaultExpr ? conv(wf.argDefaultExpr) : null,
                      ignoreNulls: wf.ignoreNulls,
                      partExprs: (wf.srcPartition || []).map(conv),
                      orderSpecs: (wf.srcOrder || []).map(o => ({ expr: conv(o.expr), desc: o.desc }))
                  };
              });
              // 基底行に対するウィンドウ評価は行わない（後段で出力行から計算する）
              windowFuncs = [];
              isAgg = true;   // 隠し集計列が増えたので集計パスを必ず通す
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
                  // USING < / >（PostgreSQL）: 比較演算子で向きを指定する綴り。
                  // 昇順・降順そのものなので ASC / DESC へ読み替える
                  const um = e.match(/\s+using\s+(<=|>=|<|>)$/i);
                  if (um) {
                      desc = um[1][0] === '>';
                      e = e.slice(0, um.index).trim();
                      return { expr: e, desc, nulls, isOrdinal: /^\d+$/.test(e), attachKey: null, attachFailed: false };
                  }
                  if (/\s+using\s+\S+$/i.test(e)) {
                      throw new Error("ORDER BY ... USING accepts only the comparison operators < <= > >= (LuminaDB has no user-defined operators).");
                  }
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

                      // ------------------------------------------------------------------
                      // フレーム集計の前計算。
                      //
                      // 従来は行ごとに [lo..hi] の配列を作り直し、そのたびに引数式を
                      // フレーム内の全行へ評価していた。既定フレーム
                      // （UNBOUNDED PRECEDING → CURRENT ROW）だと 1 行目は 1 行、
                      // n 行目は n 行を見るので、合計 n^2/2 回。行数を倍にすると
                      // 時間が 4 倍になり、累計や移動平均が実用にならなかった
                      // （32,000 行の SUM(x) OVER (ORDER BY id) で 27 秒）。
                      //
                      // ここで 2 つ用意する:
                      //   1. 引数値を 1 行 1 回だけ評価した配列（式評価が n^2/2 → n 回）
                      //   2. 累積和・累積件数（区間の和が引き算 1 回で出る）
                      // これで [lo..hi] がどれだけ広くても 1 行あたり O(1) になる。
                      // EXCLUDE 指定があるときは飛ばす行があるので前計算を使わない
                      // ------------------------------------------------------------------
                      const FRAMED_AGG = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE'];
                      const useFast = wf.frame && FRAMED_AGG.includes(wf.funcName)
                                      && (wf.frame.exclude || 'NO OTHERS') === 'NO OTHERS';
                      let fArg = null, pfSum = null, pfCnt = null, pfScale = 1, runBest = null;
                      if (useFast) {
                          const n = pRows.length;
                          fArg = new Array(n);
                          for (let i = 0; i < n; i++) {
                              fArg[i] = wf.argFunc ? wf.argFunc(pRows[i], this.tables, aliases) : null;
                          }
                          if (wf.funcName === 'SUM' || wf.funcName === 'AVG' || wf.funcName === 'COUNT') {
                              // 十進の桁を揃えて整数で積む（集計側の LUMINA_EXACT_SUM と同じ考え方）。
                              // 累積和の差で区間和を出すので、途中の丸めが残ると差にも残る
                              let d = 0, scalable = true;
                              for (let i = 0; i < n; i++) {
                                  const x = LUMINA_AGG_NUM(fArg[i]);
                                  if (x === null) continue;
                                  const p = LUMINA_DEC_PLACES(x);
                                  if (p < 0 || p > 12) { scalable = false; break; }
                                  if (p > d) d = p;
                              }
                              pfScale = (scalable && d > 0) ? Math.pow(10, d) : 1;
                              if (pfScale !== 1) {
                                  // 桁をずらすと整数の範囲を出るなら倍精度のまま積む
                                  let acc = 0;
                                  for (let i = 0; i < n && pfScale !== 1; i++) {
                                      const x = LUMINA_AGG_NUM(fArg[i]);
                                      if (x === null) continue;
                                      const s = Math.round(x * pfScale);
                                      acc += s;
                                      if (!Number.isSafeInteger(s) || !Number.isSafeInteger(acc)) pfScale = 1;
                                  }
                              }
                              pfSum = new Float64Array(n + 1);
                              pfCnt = new Int32Array(n + 1);
                              for (let i = 0; i < n; i++) {
                                  const v = fArg[i];
                                  let add = 0, c = 0;
                                  if (v !== null && v !== undefined) {
                                      const x = LUMINA_AGG_NUM(v);
                                      if (x !== null) add = pfScale === 1 ? x : Math.round(x * pfScale);
                                      c = 1;
                                  }
                                  pfSum[i + 1] = pfSum[i] + add;
                                  pfCnt[i + 1] = pfCnt[i] + c;
                              }
                          } else if (wf.funcName === 'MIN' || wf.funcName === 'MAX') {
                              // 下端が 0 に貼り付く（UNBOUNDED PRECEDING）フレームは、
                              // 先頭からの最良値を持ち回れば 1 行あたり O(1) で引ける。
                              // 生値の比較なので、文字列の MIN/MAX も従来と同じ結果になる
                              runBest = new Array(n);
                              let b = null;
                              for (let i = 0; i < n; i++) {
                                  const v = fArg[i];
                                  if (v !== null && v !== undefined) {
                                      if (b === null || (wf.funcName === 'MIN' ? v < b : v > b)) b = v;
                                  }
                                  runBest[i] = b;
                              }
                          }
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
                              // 前計算が使える形なら、フレームの広さに関係なく O(1) で引く
                              if (useFast) {
                                  if (lo > hi) {
                                      val = wf.funcName === 'COUNT' ? 0 : null;
                                  } else if (wf.funcName === 'COUNT') {
                                      val = wf.argFunc ? (pfCnt[hi + 1] - pfCnt[lo]) : (hi - lo + 1);
                                  } else if (wf.funcName === 'SUM' || wf.funcName === 'AVG') {
                                      const c = pfCnt[hi + 1] - pfCnt[lo];
                                      if (c === 0) val = null;
                                      else {
                                          const s = (pfSum[hi + 1] - pfSum[lo]) / pfScale;
                                          val = wf.funcName === 'SUM' ? s : s / c;
                                      }
                                  } else if (wf.funcName === 'FIRST_VALUE') {
                                      val = fArg[lo];
                                  } else if (wf.funcName === 'LAST_VALUE') {
                                      val = fArg[hi];
                                  } else if (lo === 0) {
                                      // MIN / MAX は下端が 0 のときだけ持ち回りで引ける
                                      val = runBest[hi];
                                  } else {
                                      // 両端が動く MIN / MAX は区間を見る。引数式は評価済みなので
                                      // 配列を読むだけで済む（従来は式を毎回評価し直していた）
                                      let b = null;
                                      for (let i2 = lo; i2 <= hi; i2++) {
                                          const v = fArg[i2];
                                          if (v === null || v === undefined) continue;
                                          if (b === null || (wf.funcName === 'MIN' ? v < b : v > b)) b = v;
                                      }
                                      val = b;
                                  }
                                  ptr[wf.wfId] = val;
                                  return;
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
                                      const an = LUMINA_AGG_NUM(av);
                                      if (an !== null) fsum += an;
                                      fcnt++;
                                      if (fbest === null || (wf.funcName === 'MIN' ? av < fbest : av > fbest)) fbest = av;
                                  }
                                  if (wf.funcName === 'COUNT') val = wf.argFunc ? fcnt : fnRows;
                                  else if (wf.funcName === 'SUM') val = fcnt > 0 ? fsum : null;
                                  else if (wf.funcName === 'AVG') val = fcnt > 0 ? fsum / fcnt : null;
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
                              const argN = LUMINA_AGG_NUM(wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : 0);
                              if (argN !== null) sum += argN;
                              val = sum;
                          } else if (wf.funcName === 'COUNT') {
                              if (!wf.argFunc) cnt++;
                              else {
                                  let argVal = wf.argFunc(ptr, this.tables, aliases);
                                  if (argVal !== null && argVal !== undefined) cnt++;
                              }
                              val = cnt;
                          } else if (wf.funcName === 'AVG') {
                              const argN = LUMINA_AGG_NUM(wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : null);
                              if (argN !== null) { sum += argN; cnt++; }
                              val = cnt > 0 ? sum / cnt : null;
                          } else if (wf.funcName === 'MIN' || wf.funcName === 'MAX') {
                              let argVal = wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : null;
                              if (argVal !== null && argVal !== undefined) {
                                  if (best === null) best = argVal;
                                  else if (wf.funcName === 'MIN' ? argVal < best : argVal > best) best = argVal;
                              }
                              val = best;
                          } else if (wf.funcName === 'LAG' || wf.funcName === 'LEAD') {
                              const back = wf.funcName === 'LAG';
                              // 対象行がパーティションの外なら第3引数の既定値（無ければ NULL）
                              const outOfRange = () => wf.argDefaultFunc ? wf.argDefaultFunc(ptr, this.tables, aliases) : null;
                              if (wf.ignoreNulls && wf.argFunc) {
                                  // NULL 行を数えずに argOffset 件ぶん遡る / 進む
                                  let need = wf.argOffset, i2 = idx;
                                  val = outOfRange();
                                  while (need > 0) {
                                      i2 = back ? i2 - 1 : i2 + 1;
                                      if (i2 < 0 || i2 >= pRows.length) { val = outOfRange(); break; }
                                      const cand = wf.argFunc(pRows[i2], this.tables, aliases);
                                      if (cand === null || cand === undefined) continue;
                                      need--;
                                      if (need === 0) val = cand;
                                  }
                              } else {
                                  const tIdx = back ? idx - wf.argOffset : idx + wf.argOffset;
                                  val = (tIdx >= 0 && tIdx < pRows.length && wf.argFunc)
                                      ? wf.argFunc(pRows[tIdx], this.tables, aliases)
                                      : outOfRange();
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
                              // IGNORE NULLS 指定時は NULL 行を除いた並びで数える。
                              // FROM LAST 指定の NTH_VALUE は末尾から数える
                              let nth = wf.funcName === 'NTH_VALUE' ? wf.argOffset : (wf.funcName === 'FIRST_VALUE' ? 1 : -1);
                              if (wf.funcName === 'NTH_VALUE' && wf.nthFromLast) nth = -wf.argOffset;
                              val = null;
                              if (wf.argFunc) {
                                  if (wf.ignoreNulls) {
                                      const vals = [];
                                      for (let i2 = 0; i2 < pRows.length; i2++) {
                                          const cand = wf.argFunc(pRows[i2], this.tables, aliases);
                                          if (cand !== null && cand !== undefined) vals.push(cand);
                                      }
                                      const t = nth < 0 ? vals.length + nth : nth - 1;
                                      val = (t >= 0 && t < vals.length) ? vals[t] : null;
                                  } else {
                                      const t = nth < 0 ? pRows.length + nth : nth - 1;
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
                          } else if (wf.funcName === 'RATIO_TO_REPORT') {
                              // 自分の値 ÷ パーティション合計（Oracle）。合計が 0 / NULL なら NULL
                              let tot = 0, any = false;
                              pRows.forEach(p2 => {
                                  const v2 = wf.argFunc ? wf.argFunc(p2, this.tables, aliases) : null;
                                  if (typeof v2 === 'number') { tot += v2; any = true; }
                              });
                              const self = wf.argFunc ? wf.argFunc(ptr, this.tables, aliases) : null;
                              val = (!any || tot === 0 || typeof self !== 'number') ? null : self / tot;
                          } else if (LUMINA_WINDOW_WHOLE_PARTITION.has(wf.funcName)) {
                              // PERCENTILE_CONT / PERCENTILE_DISC / MEDIAN: パーティション全体の分位点を全行へ配る
                              const vals = [];
                              pRows.forEach(p2 => {
                                  const v2 = wf.argFunc ? wf.argFunc(p2, this.tables, aliases) : null;
                                  if (v2 !== null && v2 !== undefined) vals.push(Number(v2));
                              });
                              val = this._percentileOf(vals, wf.funcName, wf.percentileP);
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
                      // 1 要素（部分集合の 1 つ）を解釈する。GROUPING SETS の中には
                      // ROLLUP / CUBE / 入れ子の GROUPING SETS も書ける（SQL 標準）ので、
                      // それぞれを「集合の並び」へ展開して平らにする。
                      // 従来は式として評価しようとして "Function 'ROLLUP' does not exist." になっていた
                      const expandItem = (p, out) => {
                          const nest = p.match(/^(ROLLUP|CUBE|GROUPING\s+SETS)\s*\(([\s\S]*)\)$/i);
                          if (nest) {
                              const kind = nest[1].toUpperCase().replace(/\s+/g, ' ');
                              if (kind === 'GROUPING SETS') {
                                  this.splitSelectClause(nest[2]).forEach(x => expandItem(x.trim(), out));
                                  return;
                              }
                              // ROLLUP(a, b) の要素は「(a,b) をひとかたまりに見なす」書き方も許す
                              const cols = this.splitSelectClause(nest[2]).map(x => {
                                  const g = x.trim().match(/^\(([\s\S]*)\)$/);
                                  return (g ? this.splitSelectClause(g[1]) : [x]).map(y => y.trim()).filter(y => y !== '');
                              });
                              // ROLLUP() / CUBE() のように中身が空の形は無効（GROUPING SETS (()) とは別）
                              if (cols.length === 0 || cols.every(g => g.length === 0)) {
                                  throw new Error(`${kind} requires at least one grouping item.`);
                              }
                              if (kind === 'ROLLUP') {
                                  // 接頭辞集合: (a,b) -> {a,b}, {a}, {}
                                  for (let n = cols.length; n >= 0; n--) {
                                      const act = new Set();
                                      cols.slice(0, n).forEach(grp => grp.forEach(c => act.add(idxOf(c))));
                                      out.push(act);
                                  }
                              } else {
                                  // CUBE: 2^n 個の全部分集合
                                  for (let mask = (1 << cols.length) - 1; mask >= 0; mask--) {
                                      const act = new Set();
                                      cols.forEach((grp, i) => { if (mask & (1 << i)) grp.forEach(c => act.add(idxOf(c))); });
                                      out.push(act);
                                  }
                              }
                              return;
                          }
                          const inner = p.match(/^\(([\s\S]*)\)$/);
                          if (inner) {
                              const body = inner[1].trim();
                              const act = new Set();
                              if (body !== '') this.splitSelectClause(body).forEach(c => act.add(idxOf(c.trim())));
                              out.push(act);
                          } else {
                              // 括弧なしの単項目も 1 要素集合として受理する
                              out.push(new Set([idxOf(p)]));
                          }
                      };
                      this.splitSelectClause(gsM[1]).forEach(part => expandItem(part.trim(), sets));
                      if (sets.length === 0) throw new Error("GROUPING SETS requires at least one grouping item.");
                      if (allItems.length === 0) {
                          // GROUPING SETS (()) だけ = 空のグループ化キー。
                          // 全行をひとまとめにした 1 行（総計）と同じなので GROUP BY を外す
                          groupByEff = null;
                          groupingSetsSpec = null;
                      } else {
                          groupByEff = allItems.join(', ');
                          groupingSetsSpec = sets;
                      }
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
              // 照合順序付きの列でまとめる場合はキーを正規化する（'Apple' と 'APPLE' を同一視）。
              // 序数・SELECT 別名で指定された場合は元の式テキストまで辿って判定する
              const groupColls = groupItems.map(g => {
                  let src = g.trim();
                  if (/^\d+$/.test(src)) {
                      const cs = compiledSelects[parseInt(src, 10) - 1];
                      src = cs && cs.rawExpr ? cs.rawExpr : src;
                  } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(src) && !this._collationOfExpr(src, aliases)) {
                      const lower = src.toLowerCase();
                      const byAlias = compiledSelects.find(cs => cs.type === 'expr' && cs.alias && String(cs.alias).toLowerCase() === lower);
                      if (byAlias && byAlias.rawExpr) src = byAlias.rawExpr;
                  }
                  return this._collationOfExpr(src, aliases);
              });
              rowPtrs.forEach(ptr => {
                  let key = groupFuncs.map((f, i) => {
                      const v = f(ptr, this.tables, aliases);
                      return groupColls[i] ? this._collateValue(v, groupColls[i]) : v;
                  }).join('|||');
                  if(!groups[key]) groups[key] = [];
                  groups[key].push(ptr);
              });
          } else {
              groups['all'] = rowPtrs;
          }

          // HAVING の絞り込み本体。出力行（SELECT 別名・隠し集計列 __hv_ を含む）に対して評価する
          const applyHaving = (rows) => {
              const hFunc = this.compileCondition(this._applyDateColumns(this._applyColumnCollations(this._assertNoAmbiguousColumns(havingStrEff, aliases), aliases), aliases), strMap);
              const dummyCols = {};
              if (rows.length > 0) Object.keys(rows[0]).forEach(k => dummyCols[k.toLowerCase()] = true);
              const kept = rows.filter(row => {
                  const getVal = (c) => {
                      const actualKey = Object.keys(row).find(k => k.toLowerCase() === c.toLowerCase());
                      return actualKey ? row[actualKey] : null;
                  };
                  return hFunc({ dummy: 0 }, { dummy: { cols: dummyCols, getValue: getVal } }, { dummy: 'dummy' });
              });
              // 隠し HAVING 集計列は以降（ウィンドウ / DISTINCT / ORDER BY / 出力）に影響させない
              kept.forEach(row => {
                  for (const k in row) if (k.startsWith('__hv_')) delete row[k];
              });
              return kept;
          };

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
                  // GROUPING_ID は引数ごとに GROUP BY 項目の索引を引く（ビット位置は引数の順番）
                  compiledSelects.forEach(sel => {
                      if (sel.type !== 'agg' || sel.func !== 'GROUPING_ID') return;
                      sel._gis = sel.groupingExprs.map(e => {
                          const gi = groupItems.findIndex(g => norm(g) === norm(e));
                          if (gi === -1) throw new Error(`GROUPING_ID argument '${e}' must be a GROUP BY expression.`);
                          return gi;
                      });
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
                          let groupPtrs = sel.filterFunc
                              ? groupPtrsAll.filter(p => { try { return !!sel.filterFunc(p, this.tables, aliases); } catch (e) { return false; } })
                              : groupPtrsAll;
                          // KEEP (DENSE_RANK FIRST|LAST ORDER BY y): y が最小（LAST は最大）の
                          // 行だけへ絞ってから集計する。同値の行はすべて残す（DENSE_RANK 1 位の集合）
                          if (sel.keep && groupPtrs.length > 0) {
                              let best = null;
                              const vals = groupPtrs.map(p2 => {
                                  let v = null;
                                  try { v = sel.keep.fn(p2, this.tables, aliases); } catch (e) { v = null; }
                                  return v;
                              });
                              const wantMax = sel.keep.last !== sel.keep.desc;
                              vals.forEach(v => {
                                  if (v === null || v === undefined) return;
                                  if (best === null || (wantMax ? v > best : v < best)) best = v;
                              });
                              groupPtrs = best === null ? [] : groupPtrs.filter((p2, i2) => vals[i2] === best);
                          }
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
                              // 全件を配列に集めて sort し、端の 1 個だけを取っていた
                              // （20 万行で O(n log n) の並べ替え）。1 度なめれば足りる。
                              // 比較は生値のまま（従来の比較子と同じ規則）にして、
                              // 文字列の MIN / MAX が数値へ寄らないようにする
                              const isMax = sel.func === 'MAX';
                              let best = null, seen = false;
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc(ptr, this.tables, aliases);
                                  if (v === null || v === undefined) return;
                                  if (!seen) { best = v; seen = true; return; }
                                  if (isMax ? (v > best) : (v < best)) best = v;
                              });
                              aggRow[sel.alias] = seen ? best : null;
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
                          } else if (sel.func === 'GROUPING_ID') {
                              // 各引数の GROUPING() をビットに詰める（左端の引数が最上位ビット）
                              const gis = sel._gis || [];
                              let bits = 0;
                              gis.forEach((gi, k) => {
                                  const on = nulledSet !== null && gi !== -1 && nulledSet.has(gi);
                                  if (on) bits |= (1 << (gis.length - 1 - k));
                              });
                              aggRow[sel.alias] = bits;
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
                          } else if (sel.func === 'PRODUCT') {
                              // 非NULL値の総乗。非NULL値が無ければ NULL（SUM と違い 0 にはしない）
                              let prod = null;
                              groupPtrs.forEach(ptr => {
                                  const v = sel.argFunc ? sel.argFunc(ptr, this.tables, aliases) : null;
                                  if (v === null || v === undefined) return;
                                  const n = Number(v);
                                  if (!isFinite(n)) return;
                                  prod = prod === null ? n : prod * n;
                              });
                              aggRow[sel.alias] = prod;
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
                              // 値を集めてから足す（十進の桁を読み取って正確に和を出すため）
                              const nums = [];
                              if (sel.distinct) {
                                  // SUM(DISTINCT) / AVG(DISTINCT): 重複値を除外して集計
                                  const seen = new Set();
                                  groupPtrs.forEach(ptr => {
                                      const n = LUMINA_AGG_NUM(sel.argFunc(ptr, this.tables, aliases));
                                      if (n !== null) seen.add(n);
                                  });
                                  seen.forEach(v => nums.push(v));
                              } else {
                                  groupPtrs.forEach(ptr => {
                                      const n = LUMINA_AGG_NUM(sel.argFunc(ptr, this.tables, aliases));
                                      if (n !== null) nums.push(n);
                                  });
                              }
                              const cnt = nums.length;
                              const sum = LUMINA_EXACT_SUM(nums);
                              // AVG は倍精度のまま返す。以前は 2 桁へ丸めていたため
                              // 0.000001 台の平均が 0 になり、率や単価が壊れていた。
                              // 2 桁で欲しい場合は ROUND(AVG(x), 2) と書く
                              aggRow[sel.alias] = sel.func === 'SUM' ? sum : (cnt>0 ? sum/cnt : 0);
                          }
                      } else if (sel.type === 'window') {
                          // 値は集計後の別パス（_applyPostAggWindows）で埋める。
                          // 列の並びを SELECT どおりに保つため、ここで場所だけ確保する
                          aggRow[sel.alias] = null;
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
                  // 集計内包式（ROUND(AVG(x), 2) 等）は列の場所だけ確保しておき、
                  // 値は全行が揃ってから評価する（ウィンドウ列 __wx_N を参照できるように）
                  compiledSelects.forEach(sel => { if (sel.type === 'aggexpr') aggRow[sel.alias] = null; });
                  return aggRow;
              };

              // 集計行が出揃ったあとに「集計内包式」を評価する。
              // ウィンドウ関数より後に走らせる必要がある（全体比の分母がウィンドウ列のため）
              const evalAggExprs = (outRows) => {
                  const aggExprs = compiledSelects.filter(s => s.type === 'aggexpr');
                  if (aggExprs.length === 0) {
                      outRows.forEach(r => { for (const k in r) if (k.startsWith('__se_')) delete r[k]; });
                      return;
                  }
                  outRows.forEach(aggRow => {
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
                  });
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
                      const key = groupFuncs.map((f, i) => active.has(i) ? f(ptr, this.tables, aliases) : '\0').join('|||');
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
              // グループ化の後にウィンドウ関数を評価し（全体比・グループ順位・累計）、
              // その値を参照できる状態で集計内包式を評価する。
              // SQL の評価順は GROUP BY → HAVING → ウィンドウなので、集計後ウィンドウが
              // ある場合は先に HAVING で絞る（残った行だけで構成比・順位を出すため）
              if (postAggWindows) {
                  if (havingStrEff) { resultSet = applyHaving(resultSet); havingStrEff = null; }
                  this._applyPostAggWindows(resultSet, postAggWindows, strMap);
              }
              evalAggExprs(resultSet);
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
              // 修飾スター `u.*` が実在の別名を指しているか（実行前に検証する。
              // 誤記が黙って 0 列になると気づけない）
              compiledSelects.forEach(sel => {
                  if (sel.type === 'star' && sel.only && !aliases[sel.only]) {
                      throw new Error(`Table or alias '${sel.only}' in '${sel.only}.*' is not in the FROM clause.`);
                  }
              });
              // `*` の展開対象は「関係ごとに1つ」。ptr には実表名と別名の両方がキーとして
              // 入っている（`FROM users u` なら users と u）ので、素の for..in で回すと
              // 同じ表を二度展開してしまう。ptrKeys の [表名, 別名] 対から別名側だけを採る
              const starAliases = [];
              {
                  const seenAl = new Set();
                  for (let i = 1; i < ptrKeys.length; i += 2) {
                      const a = ptrKeys[i];
                      if (a === undefined || seenAl.has(a)) continue;
                      seenAl.add(a); starAliases.push(a);
                  }
              }
              // LIMIT が付いているだけの問い合わせは、必要な行数まで組み立てれば足りる。
              //
              // 従来はここで全行を出力オブジェクトへ変換してから最後に slice していたので、
              // `SELECT * FROM t LIMIT 10` が表のサイズに比例していた（40 万行で 164ms。
              // 走査自体は COUNT(*) が 4ms で終わるので、費用はぜんぶ 40 万個の
              // オブジェクトを作って 39 万 9,990 個を捨てるところにあった）。
              // 表の先頭を覗くのは画面でいちばん多い操作なので、ここを打ち切る。
              //
              // 打ち切れるのは「出力が rowPtrs と 1 対 1 で、並びも変わらない」ときだけ。
              // 並べ替え・グループ化・DISTINCT・ウィンドウ・QUALIFY・WITH TIES が
              // 絡むと、後段で行が減ったり順番が変わったりして先頭 k 行では足りない
              if (limitVal !== null && !withTies && !orderByStr && !groupByStr && !havingStr
                  && !qualifyStr && !isDistinct && !distinctOn
                  && !(windowFuncs && windowFuncs.length > 0)
                  && !compiledSelects.some(s => s.type === 'agg' || s.type === 'aggexpr' || s.type === 'window')
                  && !/%$/.test(String(limitVal)) && String(limitVal).toLowerCase() !== 'all') {
                  const lim = parseInt(limitVal, 10);
                  const off = offsetVal !== null ? Math.max(0, parseInt(offsetVal, 10)) : 0;
                  if (isFinite(lim) && lim >= 0 && isFinite(off) && off + lim < rowPtrs.length) {
                      rowPtrs = rowPtrs.slice(0, off + lim);
                  }
              }
              resultSet = rowPtrs.map(ptr => {
                  tickO();
                  let outRow = {};
                  // 出力列名の重複解決。JS オブジェクトのキーは一意なので、
                  // `SELECT u.id, p.id` や 2 表 JOIN の `SELECT *` は後の列が前の列を
                  // 黙って上書きしていた（＝データが消える）。2 つ目以降は _1, _2 … を付ける
                  const put = (name, value) => {
                      let key = name;
                      if (Object.prototype.hasOwnProperty.call(outRow, key)) {
                          let n = 1;
                          while (Object.prototype.hasOwnProperty.call(outRow, `${name}_${n}`)) n++;
                          key = `${name}_${n}`;
                      }
                      outRow[key] = value;
                  };
                  compiledSelects.forEach(sel => {
                      if (sel.type === 'star') {
                          for (let alias of (starAliases.length ? starAliases : Object.keys(ptr))) {
                              if (sel.only && alias.toLowerCase() !== sel.only) continue;
                              let actualTbl = aliases[alias];
                              if (actualTbl && this.tables[actualTbl]) {
                                  const t = this.tables[actualTbl];
                                  // 外部結合の未マッチ側（ptr が -1）は **NULL を並べる**。
                                  // 従来はその表の列をまるごと出力から落としていたため、
                                  // 同じ結果セットの中で行ごとに列が違う（＝グリッドの列が欠ける・
                                  // 書き出した CSV の列数が揃わない）という状態になっていた
                                  const unmatched = ptr[alias] === -1;
                                  t.getColumnNames().forEach(c => {
                                      if (sel.exclude && sel.exclude.has(c.toLowerCase())) return;
                                      put(c, unmatched ? null : t.getValue(c, ptr[alias]));
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
                          put(sel.alias, sel.evalFunc(ptr, this.tables, aliases));
                      } else if (sel.type === 'window') {
                          put(sel.alias, ptr[sel.wfId]);
                      } else if (sel.type === 'winexpr') {
                          // ウィンドウの結果を疑似表 __winvals の列として見せ、
                          // 外側の式が元の列と一緒に参照できるようにする
                          const vals = Object.create(null), cols = Object.create(null);
                          sel.wfIds.forEach(id => { vals[id] = ptr[id]; cols[id] = true; });
                          const ptrs2 = Object.assign(Object.create(null), ptr);
                          ptrs2['__winvals'] = 0;
                          const dbs2 = Object.assign(Object.create(null), this.tables);
                          dbs2['__winvals'] = { cols, getValue: (c) => vals[c] };
                          const als2 = Object.assign(Object.create(null), aliases);
                          als2['__winvals'] = '__winvals';
                          put(sel.alias, sel.evalFunc(ptrs2, dbs2, als2));
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
          if (havingStrEff) resultSet = applyHaving(resultSet);

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

          // 出力キー -> 照合名。SELECT 式が「照合順序付きの実列そのもの」のときだけ対応付ける。
          // DISTINCT の重複判定と ORDER BY の比較で使う
          const outColls = Object.create(null);
          compiledSelects.forEach(cs => {
              if (cs.type !== 'expr' || !cs.alias) return;
              const coll = this._collationOfExpr(cs.rawExpr, aliases);
              if (coll) outColls[String(cs.alias).toLowerCase()] = coll;
          });
          const hasOutColl = Object.keys(outColls).length > 0;

          if (isDistinct && !distinctOn && resultSet.length > 0) {
              const seen = new Set();
              resultSet = resultSet.filter(row => {
                  const keys = Object.keys(row).sort();
                  const str = hasOutColl
                      ? JSON.stringify(keys.map(k => {
                            const c = outColls[k.toLowerCase()];
                            return c ? this._collateValue(row[k], c) : row[k];
                        }))
                      : JSON.stringify(row, keys);
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
                      return { col: visibleKeys[ord - 1], desc: item.desc, nulls: item.nulls, coll: outColls[visibleKeys[ord - 1].toLowerCase()] || null };
                  }
                  // 単純な列名・別名は出力キーで解決する（別名が実列と重複する場合は別名優先）
                  if (/^[a-zA-Z0-9_.]+$/.test(item.expr)) {
                      const colName = item.expr.replace(/^[a-zA-Z0-9_]+\./, '');
                      const actualKey = Object.keys(resultSet[0]).find(k => k.toLowerCase() === colName.toLowerCase());
                      if (actualKey) return { col: actualKey, desc: item.desc, nulls: item.nulls, coll: outColls[actualKey.toLowerCase()] || this._collationOfExpr(item.expr, aliases) };
                      // 出力名が別名で置き換わっている場合（SELECT region AS k ... ORDER BY region）。
                      // GROUP BY 後の行には元の列が残っていないので、SELECT 句の元の式が
                      // 同じ列を指している項目の別名へ読み替える
                      const bySrc = compiledSelects.find(cs => cs.alias && typeof cs.rawExpr === 'string' &&
                          cs.rawExpr.replace(/^[a-zA-Z0-9_]+\./, '').toLowerCase() === colName.toLowerCase());
                      if (bySrc) {
                          const aliasKey = Object.keys(resultSet[0]).find(k => k.toLowerCase() === String(bySrc.alias).toLowerCase());
                          if (aliasKey) return { col: aliasKey, desc: item.desc, nulls: item.nulls, coll: outColls[aliasKey.toLowerCase()] || this._collationOfExpr(item.expr, aliases) };
                      }
                  }
                  // 行ポインタ段階で評価済みの式（未選択列を含む）
                  if (item.attachKey) return { col: item.attachKey, desc: item.desc, nulls: item.nulls, coll: this._collationOfExpr(item.expr, aliases) };
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

              const orderCmp = (a, b) => {
                  for (let oc of orderCols) {
                      let valA = a[oc.col]; let valB = b[oc.col];
                      // 照合順序付きの列は正規化した値どうしで比較する
                      if (oc.coll) { valA = this._collateValue(valA, oc.coll); valB = this._collateValue(valB, oc.coll); }
                      if (valA === valB) continue;
                      // NULL の並び順: 既定は ASC で先頭 / DESC で末尾。NULLS FIRST/LAST 指定時はそちらを優先
                      if (valA === null || valA === undefined) return oc.nulls ? (oc.nulls === 'first' ? -1 : 1) : (oc.desc ? 1 : -1);
                      if (valB === null || valB === undefined) return oc.nulls ? (oc.nulls === 'first' ? 1 : -1) : (oc.desc ? -1 : 1);
                      if (valA < valB) return oc.desc ? 1 : -1;
                      return oc.desc ? -1 : 1;
                  }
                  return 0;
              };
              // LIMIT が付いていて上位数件しか要らないなら、全件を並べ替えずに選ぶ。
              // 使えるのは「並べ替えた後の先頭から数える」場合だけ:
              //   - TOP n PERCENT は全体件数が要る
              //   - WITH TIES は打ち切り位置の次の行と比べる
              //   - DISTINCT ON は並べ替えの後で行を落とすので、k 件では足りない
              let topK = null;
              if (limitVal !== null && !withTies && !distinctOn && !/%$/.test(String(limitVal))
                  && String(limitVal).toLowerCase() !== 'all') {
                  const lim = parseInt(limitVal, 10);
                  const off = offsetVal !== null ? Math.max(0, parseInt(offsetVal, 10)) : 0;
                  if (isFinite(lim) && lim >= 0 && isFinite(off)) {
                      const k = off + lim;
                      // 小さい結果では全件 sort の方が速い（挿入の splice が効いてくる）
                      if (k >= 0 && resultSet.length > Math.max(64, k * 4)) topK = k;
                  }
              }
              if (topK !== null) resultSet = this._topNRows(resultSet, orderCmp, topK);
              else resultSet.sort(orderCmp);
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

          // 並べ替えのために追加した隠し列は出力へ含めない。
          //   __ob_  : ORDER BY へ直書きされたウィンドウ関数の退避先
          //   __obv_ : 出力行に対する ORDER BY 式の評価結果
          //   __oba_ : 行ポインタ段階で評価した ORDER BY 式の評価結果
          if (resultSet.length > 0) {
              const hidden = Object.keys(resultSet[0]).filter(k => /^__(ob|oba|obv|wa|wx)_\d+$/.test(k));
              if (hidden.length > 0) resultSet.forEach(row => hidden.forEach(k => { delete row[k]; }));
          }

          // 0 件でも「どんな列を返す問い合わせだったか」を伝える。派生表として
          // 実体化するとき、行が無いと列まで消えて `SELECT SUM(v) FROM (... WHERE 偽) t` が
          // 「列 v が無い」になっていた
          let outCols = resultSet.length > 0 ? Object.keys(resultSet[0]) : null;
          if (!outCols) {
              outCols = [];
              compiledSelects.forEach(sel => {
                  if (sel.type === 'star') {
                      for (const al of Object.keys(aliases)) {
                          if (sel.only && al.toLowerCase() !== sel.only) continue;
                          const tb = this.tables[aliases[al]];
                          if (!tb) continue;
                          tb.getColumnNames().forEach(c => {
                              if (sel.exclude && sel.exclude.has(c.toLowerCase())) return;
                              if (!outCols.includes(c)) outCols.push(c);
                          });
                      }
                  } else if (sel.alias && !outCols.includes(sel.alias)) {
                      outCols.push(sel.alias);
                  }
              });
          }
          return { data: resultSet, affectedRows: resultSet.length, columns: outCols };
      }
    });
