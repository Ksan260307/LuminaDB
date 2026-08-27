    // ============================================================================
    // [Test Suite v60] - 特殊なクエリ構成 (4/4): 極端な値と型
    //
    //   桁あふれ・極小・負のゼロ・サロゲートペア・制御文字・遠い日付といった
    //   「端の値」を、演算子・関数・並べ替え・集約へ通して確かめる。
    //   期待値は JavaScript 側の参照実装から求める（非有限は NULL へ揃える取り決め）。
    //
    //     A. 極端な数値 × 演算子
    //     B. 極端な数値 × 数値関数
    //     C. 特殊な文字列 × 文字列関数
    //     D. 遠い日付・境界の日付 × 日付関数
    //     E. 型の混在（比較・並べ替え・集約）
    //     F. 極端な値を列に入れて操作する
    //     G. JSON の特殊な形
    //     H. 丸めと精度
    //
    //   test-suite.js の tests 配列へ getV60Tests() のスプレッドで合流する
    // ============================================================================
    function getV60Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, val, same, valsOf, eq, oneOf, insertRows, drop, cleanup } = makeTestKit('V60');

      // 非有限は NULL へ揃える（engine と同じ取り決め）
      const fin = (x) => (typeof x === 'number' && !isFinite(x)) ? null : x;
      // 浮動小数の下位桁は両側で揃わないことがあるので、比べる前に丸める
      const r9 = (x) => (typeof x === 'number' && !Number.isInteger(x)) ? Math.round(x * 1e9) / 1e9 : x;
      const valN = (name, sql, want) => t(name, () => eq(r9(oneOf(sql)), r9(want), sql));

      // ------------------------------------------------------------
      // 0. フィクスチャ（極端な値を列に入れた表）
      // ------------------------------------------------------------
      const BIG = 9007199254740991;      // JS が整数として正確に持てる上限
      const EXTREME_ROWS = [
        [1, 0, '', '1970-01-01'],
        [2, -0, ' ', '2000-02-29'],
        [3, 1, 'x', '1900-01-01'],
        [4, -1, 'X', '2999-12-31'],
        [5, 2147483647, 'あ', '2024-02-29'],
        [6, -2147483648, '😀', '2024-12-31'],
        [7, BIG, 'a\tb', '2024-01-01'],
        [8, -BIG, "it's", '2023-06-15'],
        [9, 0.5, 'ｱｲｳ', '2024-06-30'],
        [10, -0.5, 'long' + 'x'.repeat(200), '2100-01-01'],
        [11, null, null, null],
        [12, 1e-9, '   ', '2024-07-01'],
      ];
      t('V60 fixture', () => {
        drop('v60_x');
        q("CREATE TABLE v60_x (id INT PRIMARY KEY, n DOUBLE, s TEXT, d DATE)");
        insertRows('v60_x', EXTREME_ROWS);
        return db.tables['v60_x'].rowCount === EXTREME_ROWS.length;
      });

      // ============================================================
      // A. 極端な数値 × 演算子
      // ============================================================
      const NUMS = [
        ['0', 0], ['-0', -0], ['1', 1], ['-1', -1], ['0.5', 0.5], ['-0.5', -0.5],
        ['2147483647', 2147483647], ['-2147483648', -2147483648],
        ['9007199254740991', BIG], ['-9007199254740991', -BIG],
        ['1e15', 1e15], ['1e-15', 1e-15], ['1e308', 1e308], ['-1e308', -1e308],
        ['0.1', 0.1], ['3.141592653589793', Math.PI], ['100000.00001', 100000.00001],
        ['1e-308', 1e-308], ['4503599627370496', 4503599627370496], ['-1e15', -1e15],
        ['NULL', null],
      ];
      const OPS = [
        ['+', (a, b) => a + b],
        ['-', (a, b) => a - b],
        ['*', (a, b) => a * b],
        ['/', (a, b) => (b === 0 ? null : a / b)],
        ['%', (a, b) => (b === 0 ? null : a % b)],
      ];
      // 相手は少数に絞る（総当たりが大きくなりすぎないように）
      const RHS = [['1', 1], ['-1', -1], ['0', 0], ['2', 2], ['0.5', 0.5], ['1e308', 1e308],
                   ['-1e308', -1e308], ['9007199254740991', BIG], ['NULL', null]];
      OPS.forEach(([op, ref]) => NUMS.forEach(([al, a]) => RHS.forEach(([bl, b]) => {
        const want = (a === null || b === null) ? null : fin(ref(a, b));
        valN(`V60A ${al} ${op} ${bl}`, `SELECT ${al} ${op} ${bl} AS r`, want);
      })));
      // 比較演算子（極端値どうし）
      const CMPS = [['=', (a, b) => a === b], ['<>', (a, b) => a !== b], ['<', (a, b) => a < b],
                    ['<=', (a, b) => a <= b], ['>', (a, b) => a > b], ['>=', (a, b) => a >= b]];
      CMPS.forEach(([op, ref]) => NUMS.forEach(([al, a]) => {
        [['0', 0], ['1', 1], ['-1', -1], ['1e308', 1e308], ['NULL', null]].forEach(([bl, b]) => {
          const want = (a === null || b === null) ? null : ref(a, b);
          val(`V60A ${al} ${op} ${bl}`, `SELECT ${al} ${op} ${bl} AS r`, want);
        });
      }));
      // 単項マイナスと絶対値
      NUMS.forEach(([al, a]) => {
        valN(`V60A -(${al})`, `SELECT -(${al}) AS r`, a === null ? null : fin(-a));
        valN(`V60A ABS(${al})`, `SELECT ABS(${al}) AS r`, a === null ? null : fin(Math.abs(a)));
      });

      // ============================================================
      // B. 極端な数値 × 数値関数
      // ============================================================
      const NUMFNS = [
        ['CEIL', x => Math.ceil(x)],
        ['FLOOR', x => Math.floor(x)],
        ['ROUND', x => Math.sign(x) * Math.round(Math.abs(x))],
        ['SIGN', x => Math.sign(x)],
        ['SQRT', x => (x < 0 ? null : Math.sqrt(x))],
        ['EXP', x => Math.exp(x)],
        ['LN', x => (x <= 0 ? null : Math.log(x))],
        ['LOG10', x => (x <= 0 ? null : Math.log10(x))],
        ['SIN', x => Math.sin(x)],
        ['COS', x => Math.cos(x)],
        ['ATAN', x => Math.atan(x)],
        ['CBRT', x => Math.cbrt(x)],
        ['SQUARE', x => x * x],
        ['TAN', x => Math.tan(x)],
        ['ASIN', x => (x < -1 || x > 1 ? null : Math.asin(x))],
        ['ACOS', x => (x < -1 || x > 1 ? null : Math.acos(x))],
        ['LOG2', x => (x <= 0 ? null : Math.log2(x))],
        ['DEGREES', x => x * 180 / Math.PI],
        ['RADIANS', x => x * Math.PI / 180],
        ['SINH', x => Math.sinh(x)],
        ['TANH', x => Math.tanh(x)],
      ];
      NUMFNS.forEach(([fn, ref]) => NUMS.forEach(([al, a]) => {
        const want = a === null ? null : fin(ref(a));
        valN(`V60B ${fn}(${al})`, `SELECT ${fn}(${al}) AS r`, want);
      }));

      // ============================================================
      // C. 特殊な文字列 × 文字列関数
      // ============================================================
      // SQL リテラルと JS の値の対（引用符は '' で重ねる）
      const STRS = [
        ["''", ''],
        ["' '", ' '],
        ["'   '", '   '],
        ["'a'", 'a'],
        ["'A'", 'A'],
        ["'abc'", 'abc'],
        ["'ABC'", 'ABC'],
        ["'it''s'", "it's"],
        ["'あいう'", 'あいう'],
        ["'ｱｲｳ'", 'ｱｲｳ'],
        ["'" + 'x'.repeat(300) + "'", 'x'.repeat(300)],
        ["'a b'", 'a b'],
        ["'123'", '123'],
        ["'0'", '0'],
        ["'-1'", '-1'],
        ["'  pad  '", '  pad  '],
        ["'MiXeD'", 'MiXeD'],
        ["'a,b,c'", 'a,b,c'],
        ["'x''y'", "x'y"],
        ['NULL', null],
      ];
      const STRFNS = [
        ['UPPER', s => s.toUpperCase()],
        ['LOWER', s => s.toLowerCase()],
        ['LENGTH', s => s.length],
        ['CHAR_LENGTH', s => Array.from(s).length],
        ['TRIM', s => s.trim()],
        ['LTRIM', s => s.replace(/^\s+/, '')],
        ['RTRIM', s => s.replace(/\s+$/, '')],
        ['REVERSE', s => Array.from(s).reverse().join('')],
        ['ASCII', s => (s.length ? s.charCodeAt(0) : 0)],
        ['INITCAP', s => s.replace(/[a-zA-Z0-9]+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())],
      ];
      STRFNS.forEach(([fn, ref]) => STRS.forEach(([lit, s]) => {
        const want = s === null ? null : ref(s);
        val(`V60C ${fn}(${lit.slice(0, 18)})`, `SELECT ${fn}(${lit}) AS r`, want);
      }));
      // 2 引数の文字列関数
      STRS.forEach(([lit, s]) => {
        val(`V60C ${lit.slice(0, 18)} || 'z'`, `SELECT ${lit} || 'z' AS r`, s === null ? null : s + 'z');
        val(`V60C SUBSTRING(${lit.slice(0, 18)}, 1, 2)`, `SELECT SUBSTRING(${lit}, 1, 2) AS r`,
            s === null ? null : Array.from(s).slice(0, 2).join(''));
        val(`V60C LEFT(${lit.slice(0, 18)}, 1)`, `SELECT LEFT(${lit}, 1) AS r`,
            s === null ? null : Array.from(s).slice(0, 1).join(''));
        val(`V60C REPLACE(${lit.slice(0, 18)}, 'a', 'Z')`, `SELECT REPLACE(${lit}, 'a', 'Z') AS r`,
            s === null ? null : s.split('a').join('Z'));
        val(`V60C INSTR(${lit.slice(0, 18)}, 'a')`, `SELECT INSTR(${lit}, 'a') AS r`,
            s === null ? null : s.indexOf('a') + 1);
        val(`V60C ${lit.slice(0, 18)} = ''`, `SELECT ${lit} = '' AS r`, s === null ? null : s === '');
        val(`V60C ${lit.slice(0, 18)} IS NULL`, `SELECT ${lit} IS NULL AS r`, s === null);
        val(`V60C LENGTH(TRIM(${lit.slice(0, 18)}))`, `SELECT LENGTH(TRIM(${lit})) AS r`,
            s === null ? null : s.trim().length);
      });
      // サロゲートペアと結合文字（LENGTH は符号単位・CHAR_LENGTH は文字数）
      val('V60C 絵文字の LENGTH', "SELECT LENGTH('😀😀') AS r", 4);
      val('V60C 絵文字の CHAR_LENGTH', "SELECT CHAR_LENGTH('😀😀') AS r", 2);
      val('V60C 絵文字の SUBSTRING', "SELECT SUBSTRING('😀😀', 1, 1) AS r", '😀');
      val('V60C 絵文字の REVERSE', "SELECT REVERSE('😀x') AS r", 'x😀');
      val('V60C 絵文字の LEFT', "SELECT LEFT('😀x', 1) AS r", '😀');
      val('V60C 制御文字を含む長さ', "SELECT LENGTH('a\tb') AS r", 3);
      val('V60C 引用符 2 つ', "SELECT '''' AS r", "'");
      val('V60C 引用符 4 つ', "SELECT '''''' AS r", "''");

      // ============================================================
      // D. 遠い日付・境界の日付
      // ============================================================
      const DATES = ['1900-01-01', '1900-02-28', '1969-12-31', '1970-01-01', '1970-01-02',
                     '1999-12-31', '2000-01-01', '2000-02-29', '2000-03-01', '2004-02-29',
                     '2023-02-28', '2023-03-01', '2024-01-31', '2024-02-29', '2024-06-30',
                     '2024-12-31', '2025-01-01', '2025-12-31', '2100-01-01', '2100-02-28',
                     '2400-02-29', '2999-12-31'];
      const DATEFNS = [
        ['YEAR', d => Number(d.slice(0, 4))],
        ['MONTH', d => Number(d.slice(5, 7))],
        ['DAY', d => Number(d.slice(8, 10))],
        ['QUARTER', d => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1],
        ['DAYOFYEAR', d => {
          const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)), dd = Number(d.slice(8, 10));
          return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 1)) / 86400000) + 1;
        }],
        ['DAYOFWEEK', d => new Date(d + 'T00:00:00Z').getUTCDay() + 1],
      ];
      DATEFNS.forEach(([fn, ref]) => DATES.forEach(d => {
        val(`V60D ${fn}('${d}')`, `SELECT ${fn}(DATE '${d}') AS r`, ref(d));
      }));
      // 日付の差と加減算
      DATES.forEach(d => {
        const days = Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse('2000-01-01T00:00:00Z')) / 86400000);
        val(`V60D DATEDIFF('${d}', '2000-01-01')`, `SELECT DATEDIFF(DATE '${d}', DATE '2000-01-01') AS r`, days);
        val(`V60D '${d}' + 1 日`, `SELECT CAST(DATE_ADD(DATE '${d}', INTERVAL 1 DAY) AS DATE) AS r`,
            new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10));
        val(`V60D '${d}' - 1 日`, `SELECT CAST(DATE_SUB(DATE '${d}', INTERVAL 1 DAY) AS DATE) AS r`,
            new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10));
        val(`V60D '${d}' の月末`, `SELECT CAST(LAST_DAY(DATE '${d}') AS DATE) AS r`, (() => {
          const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
          const last = new Date(Date.UTC(y, m, 0));
          return last.toISOString().slice(0, 10);
        })());
      });
      // うるう年まわり
      val('V60D 2/29 の 1 年後', "SELECT CAST(DATE_ADD(DATE '2024-02-29', INTERVAL 1 YEAR) AS DATE) AS r", '2025-02-28');
      val('V60D 1/31 の 1 か月後', "SELECT CAST(DATE_ADD(DATE '2024-01-31', INTERVAL 1 MONTH) AS DATE) AS r", '2024-02-29');
      val('V60D 3/31 の 1 か月前', "SELECT CAST(DATE_SUB(DATE '2024-03-31', INTERVAL 1 MONTH) AS DATE) AS r", '2024-02-29');
      val('V60D 2100 年はうるう年でない', "SELECT DAY(LAST_DAY(DATE '2100-02-01')) AS r", 28);
      val('V60D 2000 年はうるう年', "SELECT DAY(LAST_DAY(DATE '2000-02-01')) AS r", 29);

      // ============================================================
      // E. 型の混在
      // ============================================================
      const MIXED = [
        ["1 = '1'", true], ["1 = '1.0'", true], ["'1' = '1.0'", false],
        ["1 < '2'", true], ["'10' < '9'", true], ["10 < 9", false],
        ["'abc' = 'abc'", true], ["'abc' < 'abd'", true],
        ["TRUE = 1", true], ["FALSE = 0", true], ["TRUE > FALSE", true],
        ["DATE '2024-01-01' = '2024-01-01'", true],
        ["DATE '2024-01-01' < DATE '2024-01-02'", true],
        ["'2024-01-01' < '2024-01-02'", true],
        ["NULL = NULL", null], ["NULL <> NULL", null], ["NULL IS NULL", true],
        ["'' = 0", false], ["0 = FALSE", true], ["1 = TRUE", true],
      ];
      MIXED.forEach(([expr, want], i) => val(`V60E #${i} ${expr}`, `SELECT ${expr} AS r`, want));
      // 型混在の並べ替え（数値と文字列が混じった列）
      t('V60E 数値と文字列が混じる列の並べ替え', () => {
        drop('v60_m');
        q("CREATE TABLE v60_m (id INT PRIMARY KEY, x TEXT)");
        insertRows('v60_m', [[1, '10'], [2, '9'], [3, 'a'], [4, ''], [5, null], [6, '0']]);
        const got = valsOf("SELECT id FROM v60_m ORDER BY x, id");
        drop('v60_m');
        // 文字列としての昇順（NULL が先）
        return eq(got, JSON.stringify([[5], [4], [6], [1], [2], [3]]));
      });

      // ============================================================
      // F. 極端な値を列に入れて操作する
      // ============================================================
      const model = EXTREME_ROWS.map(([id, n, s, d]) => ({ id, n, s, d }));
      t('V60F 極端な値の列を読み出す', () => eq(
        valsOf("SELECT id, n FROM v60_x ORDER BY id"),
        JSON.stringify(model.map(r => [r.id, r.n === -0 ? 0 : r.n]))));
      t('V60F 極端な値の集約', () => {
        const nums = model.map(r => r.n).filter(x => x !== null);
        const got = JSON.parse(valsOf("SELECT COUNT(n) AS c, MIN(n) AS mn, MAX(n) AS mx FROM v60_x"))[0];
        return eq(got, [nums.length, Math.min(...nums), Math.max(...nums)]);
      });
      t('V60F 極端な値の並べ替え', () => {
        const sorted = model.slice().sort((a, b) => {
          if (a.n === null) return -1;
          if (b.n === null) return 1;
          return a.n - b.n || a.id - b.id;
        });
        return eq(valsOf("SELECT id FROM v60_x ORDER BY n, id"), JSON.stringify(sorted.map(r => [r.id])));
      });
      t('V60F 極端な文字列の長さ', () => eq(
        valsOf("SELECT id, LENGTH(s) AS l FROM v60_x ORDER BY id"),
        JSON.stringify(model.map(r => [r.id, r.s === null ? null : r.s.length]))));
      t('V60F 極端な日付の年', () => eq(
        valsOf("SELECT id, YEAR(d) AS y FROM v60_x ORDER BY id"),
        JSON.stringify(model.map(r => [r.id, r.d === null ? null : Number(r.d.slice(0, 4))]))));
      t('V60F 極端な値でグループ化', () => eq(
        valsOf("SELECT COUNT(*) AS c FROM (SELECT n FROM v60_x GROUP BY n) x"),
        JSON.stringify([[new Set(model.map(r => (r.n === -0 ? 0 : r.n))).size]])));
      t('V60F 極端な値の DISTINCT', () => eq(
        valsOf("SELECT COUNT(DISTINCT s) AS c FROM v60_x"),
        JSON.stringify([[new Set(model.map(r => r.s).filter(x => x !== null)).size]])));
      // 極端な値どうしの結合
      t('V60F 極端な値での自己結合', () => eq(
        valsOf("SELECT COUNT(*) AS c FROM v60_x a JOIN v60_x b ON a.n = b.n"),
        valsOf("SELECT SUM(c * c) AS c FROM (SELECT COUNT(*) AS c FROM v60_x WHERE n IS NOT NULL GROUP BY n) g")));

      // ============================================================
      // G. JSON の特殊な形
      // ============================================================
      const JSONS = [
        ["'{}'", '空のオブジェクト'],
        ["'[]'", '空の配列'],
        ["'null'", 'JSON の null'],
        ["'0'", '数値だけ'],
        ["'\"\"'", '空文字だけ'],
        ["'{\"a\": null}'", '値が null'],
        ["'{\"a\": {\"b\": {\"c\": 1}}}'", '深い入れ子'],
        ["'[[1, 2], [3, 4]]'", '配列の配列'],
        ["'{\"a\": [1, 2, 3]}'", '配列を持つ'],
        ["'{\"\": 1}'", '空のキー'],
      ];
      // JSON_VALID は 1 / 0 を返す（MySQL 流）
      JSONS.forEach(([lit, label]) => {
        t(`V60G ${label}: JSON_VALID`, () => eq(valsOf(`SELECT JSON_VALID(${lit}) AS r`), '[[1]]'));
        t(`V60G ${label}: JSON_TYPE が返る`, () => {
          const got = JSON.parse(valsOf(`SELECT JSON_TYPE(${lit}) AS r`))[0][0];
          if (got === null || got === undefined) throw new Error('型が返らない: ' + got);
          return true;
        });
        // 取り出して入れ直しても JSON として妥当なまま（空白は詰められるので文字列比較はしない）。
        // JSON の null は SQL の NULL へ、JSON の空文字は引用符が外れて素の空文字になるので、
        // その 2 つだけは「妥当な JSON ではなくなる」のが正しい
        const wantValid = lit === "'null'" ? '[[null]]' : (lit === "'\"\"'" ? '[[0]]' : '[[1]]');
        t(`V60G ${label}: 取り出して入れ直しても妥当`, () => eq(
          valsOf(`SELECT JSON_VALID(JSON_UNQUOTE(JSON_EXTRACT(${lit}, '$'))) AS r`), wantValid));
      });
      val('V60G 壊れた JSON は無効', "SELECT JSON_VALID('{oops') AS r", 0);
      val('V60G 深い入れ子から取り出す', "SELECT JSON_EXTRACT('{\"a\": {\"b\": {\"c\": 42}}}', '$.a.b.c') AS r", 42);
      val('V60G 配列の要素を取り出す', "SELECT JSON_EXTRACT('[[1, 2], [3, 4]]', '$[1][0]') AS r", 3);
      val('V60G 無い鍵は NULL', "SELECT JSON_EXTRACT('{\"a\": 1}', '$.zzz') AS r", null);
      val('V60G 空配列の長さ', "SELECT JSON_LENGTH('[]') AS r", 0);
      val('V60G 空オブジェクトの長さ', "SELECT JSON_LENGTH('{}') AS r", 0);

      // ============================================================
      // H. 丸めと精度
      // ============================================================
      // ROUND は「ゼロから遠い方向へ丸める」（MySQL 流）。桁指定は倍精度の上で行うので、
      // 期待値も同じ規則の参照実装から求める（1.005 * 100 が 100.49999… になる類の差を拾わない）
      const mround = (x, d) => { const f = Math.pow(10, d || 0); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; };
      [[0.5, 0], [1.5, 0], [2.5, 0], [-0.5, 0], [-1.5, 0], [1.005, 2], [2.675, 2], [-2.675, 2],
       [1234.5678, -2], [0.30000000000000004, 10], [123.456, 1], [-123.456, 1], [0, 3], [1e15, 2]
      ].forEach(([x, d], i) => {
        valN(`V60H ROUND(${x}, ${d})`, `SELECT ROUND(${x}, ${d}) AS r`, mround(x, d));
      });
      const TRUNCS = [
        ["CEIL(-0.5)", Math.ceil(-0.5)], ["FLOOR(-0.5)", Math.floor(-0.5)],
        ["CEIL(0.5)", Math.ceil(0.5)], ["FLOOR(0.5)", Math.floor(0.5)],
        ["TRUNCATE(1.999, 2)", 1.99], ["TRUNCATE(-1.999, 2)", -1.99],
        ["TRUNCATE(1.999, 0)", 1], ["TRUNCATE(-1.999, 0)", -1],
      ];
      TRUNCS.forEach(([expr, want], i) => valN(`V60H #${i} ${expr}`, `SELECT ${expr} AS r`, want));
      valN('V60H 0.1 + 0.2 は JS と同じ', "SELECT 0.1 + 0.2 AS r", 0.1 + 0.2);
      valN('V60H 1/3 の精度', "SELECT 1.0 / 3 AS r", 1 / 3);
      valN('V60H 大きい数の加算', `SELECT ${BIG} + 1 AS r`, BIG + 1);
      val('V60H 桁あふれは NULL', "SELECT 1e308 * 10 AS r", null);
      val('V60H 0 での割り算は NULL', "SELECT 1 / 0 AS r", null);
      val('V60H 0 での剰余は NULL', "SELECT 1 % 0 AS r", null);
      val('V60H 0 の 0 乗', "SELECT POWER(0, 0) AS r", 1);
      val('V60H 負の平方根は NULL', "SELECT SQRT(-1) AS r", null);
      val('V60H LN(0) は NULL', "SELECT LN(0) AS r", null);

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v60_x', 'v60_m');

      return T;
    }
