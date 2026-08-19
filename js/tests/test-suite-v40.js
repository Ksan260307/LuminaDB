    // ============================================================================
    // [Test Suite v40] - 式・関数・並べ替え・ページングの網羅
    //
    //   スカラー関数を「入力を変えながら」総当たりで確かめ、そのうえで
    //   述語 x 並べ替え x ページングの組合せを 1,200 行の表に対して流す。
    //
    //     A. フィクスチャ        E. LIKE / 正規表現
    //     B. 数値関数            F. 並べ替え
    //     C. 文字列関数          G. ページング
    //     D. 条件・NULL・型変換  H. DISTINCT / 巨大な式
    //     I. 述語 x 並べ替え x ページングの総当たり
    //
    //   test-suite.js の tests 配列へ getV40Tests() のスプレッドで合流する
    // ============================================================================
    function getV40Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows returned'); return Object.values(d[0])[0]; };
      const same = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 1e-9 : a === b;
      const expect = (actual, want, label) => {
        if (!same(actual, want)) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + JSON.stringify(want) + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectNear = (actual, want, eps, label) => {
        if (typeof actual !== 'number' || Math.abs(actual - want) > (eps === undefined ? 1e-9 : eps)) {
          throw new Error((label ? label + ' ' : '') + 'expected ~' + want + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectDeep = (actual, want, label) => {
        const a = JSON.stringify(actual), b = JSON.stringify(want);
        if (a !== b) throw new Error((label ? label + ' ' : '') + 'expected ' + b + ' but got ' + a);
        return true;
      };
      const val = (name, sql, want) => t(name, () => expect(one(sql), want));
      const valNear = (name, sql, want, eps) => t(name, () => expectNear(one(sql), want, eps));
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const cnt = (arr, f) => arr.filter(f).length;
      const uniq = (arr, f) => new Set(arr.map(f)).size;

      // ----------------------------------------------------------------
      // 模型
      // ----------------------------------------------------------------
      const R = [];
      for (let n = 1; n <= 1200; n++) {
        R.push({
          id: n, g: 'K' + (n % 6), a: n % 40, b: 1 + (n % 23),
          c: (n * 17) % 500, f: (n % 100) / 4,
          s: 'row' + (n % 30), u: 'AbC' + (n % 7),
          nv: (n % 8 === 0) ? null : (n % 50)
        });
      }

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V40A build the table', () => {
        q('DROP TABLE IF EXISTS v40_t');
        let r = q("CREATE TABLE v40_t (id INT PRIMARY KEY, g TEXT, a INT, b INT, c INT, f FLOAT, " +
                  "s TEXT, u TEXT, nv INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v40_t (id, g, a, b, c, f, s, u, nv) SELECT n, 'K' || (n % 6), n % 40, 1 + (n % 23), " +
              "(n * 17) % 500, (n % 100) / 4.0, 'row' || (n % 30), 'AbC' || (n % 7), " +
              "CASE WHEN n % 8 = 0 THEN NULL ELSE n % 50 END FROM GENERATE_SERIES(1, 1200) AS g(n)");
        if (r.error) throw new Error(r.error);
        return expect(db.tables['v40_t'].rowCount, 1200);
      });
      val('V40A row count', "SELECT COUNT(*) FROM v40_t", R.length);
      val('V40A SUM(a)', "SELECT SUM(a) FROM v40_t", sum(R, r => r.a));
      val('V40A SUM(c)', "SELECT SUM(c) FROM v40_t", sum(R, r => r.c));
      valNear('V40A SUM(f)', "SELECT SUM(f) FROM v40_t", sum(R, r => r.f), 1e-6);

      // ============================================================
      // B. 数値関数
      // ============================================================
      const NUMF = [
        ['ABS(%)', v => Math.abs(v), [-7, 0, 3, 12.5]],
        ['CEIL(%)', v => Math.ceil(v), [-2.5, 0, 3.2, 9.9]],
        ['FLOOR(%)', v => Math.floor(v), [-2.5, 0, 3.7, 9.1]],
        ['ROUND(%)', v => Math.round(v), [-2.4, 0.5, 3.5, 9.49]],
        ['SIGN(%)', v => Math.sign(v), [-9, 0, 4, 100]],
        ['SQRT(%)', v => Math.sqrt(v), [0, 1, 16, 81]],
        ['EXP(%)', v => Math.exp(v), [0, 1, 2, 3]],
        ['LN(%)', v => Math.log(v), [1, 2, 10, 100]],
        ['LOG10(%)', v => Math.log10(v), [1, 10, 100, 1000]],
        ['LOG2(%)', v => Math.log2(v), [1, 2, 8, 1024]],
        ['SIN(%)', v => Math.sin(v), [0, 1, 2, 3]],
        ['COS(%)', v => Math.cos(v), [0, 1, 2, 3]],
        ['TAN(%)', v => Math.tan(v), [0, 0.5, 1, 1.2]],
        ['ASIN(%)', v => Math.asin(v), [-1, 0, 0.5, 1]],
        ['ACOS(%)', v => Math.acos(v), [-1, 0, 0.5, 1]],
        ['ATAN(%)', v => Math.atan(v), [-2, 0, 1, 5]],
        ['SINH(%)', v => Math.sinh(v), [0, 1, 2, 3]],
        ['COSH(%)', v => Math.cosh(v), [0, 1, 2, 3]],
        ['TANH(%)', v => Math.tanh(v), [0, 1, 2, 3]],
        ['CBRT(%)', v => Math.cbrt(v), [0, 1, 8, 27]],
        ['DEGREES(%)', v => v * 180 / Math.PI, [0, 1, 2, 3]],
        ['RADIANS(%)', v => v * Math.PI / 180, [0, 90, 180, 360]],
        ['SQUARE(%)', v => v * v, [-3, 0, 4, 11]],
        ['FACTORIAL(%)', v => { let r = 1; for (let i = 2; i <= v; i++) r *= i; return r; }, [0, 1, 5, 8]],
        ['TRUNCATE(%, 0)', v => Math.trunc(v), [-2.7, 0, 3.9, 12.4]]
      ];
      NUMF.forEach((spec, i) => {
        spec[2].forEach((v, j) => {
          t('V40B#' + (i + 1) + '.' + (j + 1) + ' ' + spec[0].replace('%', String(v)), () =>
            expectNear(one("SELECT " + spec[0].replace('%', String(v)) + " AS x"), spec[1](v), 1e-9));
        });
      });
      const NUMF2 = [
        ['POWER(%1, %2)', (a, b) => Math.pow(a, b), [[2, 10], [3, 4], [5, 0], [7, 2]]],
        ['MOD(%1, %2)', (a, b) => a % b, [[10, 3], [17, 5], [100, 7], [9, 9]]],
        ['GCD(%1, %2)', (a, b) => { let x = Math.abs(a), y = Math.abs(b); while (y) { const z = x % y; x = y; y = z; } return x; },
          [[12, 18], [7, 13], [100, 75], [9, 3]]],
        ['LCM(%1, %2)', (a, b) => { let x = Math.abs(a), y = Math.abs(b); const g = (p, r) => r ? g(r, p % r) : p; return x / g(x, y) * y; },
          [[4, 6], [3, 5], [12, 18], [8, 8]]],
        ['ATAN2(%1, %2)', (a, b) => Math.atan2(a, b), [[1, 1], [0, 1], [-1, 2], [3, 4]]],
        ['LOG(%1, %2)', (a, b) => Math.log(b) / Math.log(a), [[2, 8], [10, 1000], [3, 81], [5, 25]]],
        ['GREATEST(%1, %2)', (a, b) => Math.max(a, b), [[3, 9], [-5, -2], [7, 7], [100, 1]]],
        ['LEAST(%1, %2)', (a, b) => Math.min(a, b), [[3, 9], [-5, -2], [7, 7], [100, 1]]],
        ['ROUND(%1, %2)', (a, b) => Math.round(a * Math.pow(10, b)) / Math.pow(10, b),
          [[3.14159, 2], [2.71828, 3], [123.456, 1], [9.99, 0]]],
        ['SHIFTLEFT(%1, %2)', (a, b) => a << b, [[1, 4], [3, 2], [5, 3], [255, 1]]],
        ['SHIFTRIGHT(%1, %2)', (a, b) => a >> b, [[16, 2], [255, 4], [1024, 5], [7, 1]]],
        ['BITAND(%1, %2)', (a, b) => a & b, [[12, 10], [255, 15], [7, 8], [64, 64]]],
        ['BITOR(%1, %2)', (a, b) => a | b, [[12, 10], [255, 15], [7, 8], [64, 1]]],
        ['BITXOR(%1, %2)', (a, b) => a ^ b, [[12, 10], [255, 15], [7, 8], [64, 64]]]
      ];
      NUMF2.forEach((spec, i) => {
        spec[2].forEach((pair, j) => {
          const sql = spec[0].replace('%1', String(pair[0])).replace('%2', String(pair[1]));
          t('V40B2#' + (i + 1) + '.' + (j + 1) + ' ' + sql, () =>
            expectNear(one("SELECT " + sql + " AS x"), spec[1](pair[0], pair[1]), 1e-9));
        });
      });

      // ============================================================
      // C. 文字列関数
      // ============================================================
      const STRF = [
        ["UPPER('%')", v => v.toUpperCase(), ['abc', 'AbC', 'xyz123', 'a']],
        ["LOWER('%')", v => v.toLowerCase(), ['ABC', 'AbC', 'XYZ123', 'A']],
        ["LENGTH('%')", v => v.length, ['', 'a', 'abcde', 'hello world']],
        ["REVERSE('%')", v => v.split('').reverse().join(''), ['abc', 'a', 'abcd', 'racecar']],
        ["TRIM('%')", v => v.trim(), ['  ab  ', 'ab', ' a', 'b ']],
        ["LTRIM('%')", v => v.replace(/^\s+/, ''), ['  ab  ', 'ab', ' a', 'b ']],
        ["RTRIM('%')", v => v.replace(/\s+$/, ''), ['  ab  ', 'ab', ' a', 'b ']],
        ["INITCAP('%')", v => v.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
          ['hello world', 'ABC def', 'a', 'the quick fox']],
        ["ASCII('%')", v => v.charCodeAt(0), ['A', 'a', 'z', '0']],
        ["HEX('%')", v => Array.from(v).map(ch => ch.charCodeAt(0).toString(16).toUpperCase()).join(''),
          ['A', 'AB', 'abc', '0']],
        ["SOUNDEX('%')", null, ['Robert', 'Rupert', 'Smith', 'Smyth']]
      ];
      STRF.forEach((spec, i) => {
        spec[2].forEach((v, j) => {
          const sql = spec[0].replace('%', v);
          if (!spec[1]) return;
          t('V40C#' + (i + 1) + '.' + (j + 1) + ' ' + sql, () => expect(one("SELECT " + sql + " AS x"), spec[1](v)));
        });
      });
      const STRF2 = [
        ["SUBSTR('%1', %2, 3)", (s, p) => s.substr(p - 1, 3), [['abcdefgh', 1], ['abcdefgh', 3], ['abcdefgh', 6], ['abc', 1]]],
        ["LEFT('%1', %2)", (s, n) => s.slice(0, n), [['abcdefgh', 3], ['abc', 5], ['xyz', 1], ['hello', 0]]],
        ["RIGHT('%1', %2)", (s, n) => n === 0 ? '' : s.slice(-n), [['abcdefgh', 3], ['abc', 5], ['xyz', 1], ['hello', 2]]],
        ["REPEAT('%1', %2)", (s, n) => s.repeat(n), [['ab', 3], ['x', 5], ['abc', 1], ['z', 0]]],
        ["LPAD('%1', %2, '0')", (s, n) => n <= s.length ? s.slice(0, n) : '0'.repeat(n - s.length) + s,
          [['7', 3], ['abc', 5], ['abcdef', 3], ['x', 1]]],
        ["RPAD('%1', %2, '0')", (s, n) => n <= s.length ? s.slice(0, n) : s + '0'.repeat(n - s.length),
          [['7', 3], ['abc', 5], ['abcdef', 3], ['x', 1]]],
        ["INSTR('%1', '%2')", (s, sub) => s.indexOf(sub) + 1,
          [['abcabc', 'b'], ['abcabc', 'ca'], ['abc', 'z'], ['hello', 'lo']]],
        ["STRPOS('%1', '%2')", (s, sub) => s.indexOf(sub) + 1,
          [['abcabc', 'b'], ['abcabc', 'ca'], ['abc', 'z'], ['hello', 'lo']]],
        ["REPLACE('%1', '%2', 'Z')", (s, sub) => s.split(sub).join('Z'),
          [['abcabc', 'b'], ['aaa', 'a'], ['abc', 'z'], ['hello', 'll']]],
        ["CONCAT('%1', '%2')", (a, b) => a + b, [['ab', 'cd'], ['', 'x'], ['1', '2'], ['hello', 'world']]],
        ["STARTS_WITH('%1', '%2')", (s, p) => s.indexOf(p) === 0,
          [['abcdef', 'abc'], ['abcdef', 'bcd'], ['x', 'x'], ['hello', 'he']]],
        ["ENDS_WITH('%1', '%2')", (s, p) => s.slice(s.length - p.length) === p,
          [['abcdef', 'def'], ['abcdef', 'de'], ['x', 'x'], ['hello', 'lo']]],
        ["SPLIT_PART('%1', '%2', 2)", (s, sep) => (s.split(sep)[1] === undefined ? '' : s.split(sep)[1]),
          [['a,b,c', ','], ['x-y-z', '-'], ['one', ','], ['p|q|r', '|']]]
      ];
      STRF2.forEach((spec, i) => {
        spec[2].forEach((pair, j) => {
          const sql = spec[0].replace('%1', String(pair[0])).replace('%2', String(pair[1]));
          t('V40C2#' + (i + 1) + '.' + (j + 1) + ' ' + sql, () => expect(one("SELECT " + sql + " AS x"), spec[1](pair[0], pair[1])));
        });
      });

      // ============================================================
      // D. 条件・NULL・型変換
      // ============================================================
      const CONDF = [
        ["COALESCE(NULL, %)", v => v, [1, 42, -7, 0]],
        ["COALESCE(%, 99)", v => v, [1, 42, -7, 0]],
        ["IFNULL(NULL, %)", v => v, [1, 42, -7, 0]],
        ["NVL(NULL, %)", v => v, [1, 42, -7, 0]],
        ["NULLIF(%, %)", () => null, [1, 42, -7, 0]],
        ["ZEROIFNULL(%)", v => v, [1, 42, -7, 0]],
        ["ABS(NULLIF(%, 12345))", v => Math.abs(v), [1, 42, 7, 0]]
      ];
      CONDF.forEach((spec, i) => {
        spec[2].forEach((v, j) => {
          const sql = spec[0].split('%').join(String(v));
          t('V40D#' + (i + 1) + '.' + (j + 1) + ' ' + sql, () => expect(one("SELECT " + sql + " AS x"), spec[1](v)));
        });
      });
      const IFCASES = [
        ["IIF(1 = 1, 'y', 'n')", 'y'], ["IIF(1 = 2, 'y', 'n')", 'n'],
        ["IF(3 > 2, 10, 20)", 10], ["IF(3 < 2, 10, 20)", 20],
        ["CASE WHEN 1 = 1 THEN 'a' ELSE 'b' END", 'a'],
        ["CASE WHEN 1 = 2 THEN 'a' ELSE 'b' END", 'b'],
        ["CASE 3 WHEN 1 THEN 'x' WHEN 3 THEN 'y' ELSE 'z' END", 'y'],
        ["CASE 9 WHEN 1 THEN 'x' WHEN 3 THEN 'y' ELSE 'z' END", 'z'],
        ["DECODE(2, 1, 'a', 2, 'b', 'c')", 'b'],
        ["DECODE(9, 1, 'a', 2, 'b', 'c')", 'c'],
        ["NVL2(1, 'has', 'none')", 'has'],
        ["NVL2(NULL, 'has', 'none')", 'none'],
        ["CHOOSE(2, 'a', 'b', 'c')", 'b'],
        ["ISNULL(NULL, 5)", 5],
        ["GREATEST(1, 9, 5)", 9],
        ["LEAST(1, 9, 5)", 1]
      ];
      IFCASES.forEach((c, i) => val('V40D2#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " AS x", c[1]));
      const CASTS = [
        ["CAST('123' AS INTEGER)", 123], ["CAST(12.7 AS INTEGER)", 12], ["CAST(123 AS TEXT)", '123'],
        ["CAST('12.5' AS FLOAT)", 12.5], ["CAST('abc' AS INTEGER)", null],
        ["TRY_CAST('abc' AS INTEGER)", null], ["TRY_CAST('42' AS INTEGER)", 42],
        ["'7'::INTEGER", 7], ["7::TEXT", '7'], ["'3.5'::FLOAT", 3.5],
        ["CAST(1 AS BOOLEAN)", true], ["CAST(0 AS BOOLEAN)", false],
        ["TO_NUMBER('45')", 45], ["TO_NUMBER('4.5')", 4.5],
        ["LENGTH(CAST(12345 AS TEXT))", 5],
        ["CAST('2024-01-15' AS DATE)", '2024-01-15'],
        ["TYPEOF(1)", 'integer'], ["TYPEOF('a')", 'text']
      ];
      CASTS.forEach((c, i) => val('V40D3#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " AS x", c[1]));

      // ============================================================
      // E. LIKE / 正規表現
      // ============================================================
      const LIKES = [
        ["s LIKE 'row1%'", r => /^row1/.test(r.s)],
        ["s LIKE '%1'", r => /1$/.test(r.s)],
        ["s LIKE 'row_'", r => /^row.$/.test(r.s)],
        ["s LIKE 'row__'", r => /^row..$/.test(r.s)],
        ["s LIKE '%ow%'", r => r.s.indexOf('ow') >= 0],
        ["s NOT LIKE 'row1%'", r => !/^row1/.test(r.s)],
        ["u LIKE 'AbC%'", r => /^AbC/.test(r.u)],
        ["u ILIKE 'abc%'", r => /^abc/i.test(r.u)],
        ["u ILIKE '%C_'", r => /c.$/i.test(r.u)],
        ["g LIKE 'K_'", r => /^K.$/.test(r.g)],
        ["s REGEXP 'row[0-9]$'", r => /row[0-9]$/.test(r.s)],
        ["s REGEXP '^row1[0-9]$'", r => /^row1[0-9]$/.test(r.s)],
        ["REGEXP_LIKE(s, 'row2')", r => /row2/.test(r.s)],
        ["s SIMILAR TO 'row[0-9]'", r => /^row[0-9]$/.test(r.s)],
        ["u LIKE 'AbC1' OR u LIKE 'AbC2'", r => r.u === 'AbC1' || r.u === 'AbC2'],
        ["s LIKE 'row%' AND s NOT LIKE 'row2%'", r => /^row/.test(r.s) && !/^row2/.test(r.s)],
        ["s LIKE ANY ('row1', 'row2')", r => r.s === 'row1' || r.s === 'row2'],
        ["LENGTH(s) = 4", r => r.s.length === 4],
        ["LENGTH(s) = 5", r => r.s.length === 5],
        ["SUBSTR(s, 1, 3) = 'row'", r => r.s.slice(0, 3) === 'row']
      ];
      LIKES.forEach((c, i) => {
        const hit = R.filter(c[1]);
        val('V40E#' + (i + 1) + ' [' + c[0] + '] row count', "SELECT COUNT(*) FROM v40_t WHERE " + c[0], hit.length);
        val('V40E#' + (i + 1) + ' [' + c[0] + '] SUM(a)', "SELECT SUM(a) FROM v40_t WHERE " + c[0], sum(hit, r => r.a));
        val('V40E#' + (i + 1) + ' [' + c[0] + '] distinct groups',
            "SELECT COUNT(DISTINCT g) FROM v40_t WHERE " + c[0], uniq(hit, r => r.g));
      });
      const REGEXF = [
        ["REGEXP_REPLACE('abc123', '[0-9]+', 'X')", 'abcX'],
        ["REGEXP_REPLACE('a1b2c3', '[0-9]', '')", 'abc'],
        ["REGEXP_SUBSTR('abc123def', '[0-9]+')", '123'],
        ["REGEXP_INSTR('abc123', '[0-9]')", 4],
        ["REGEXP_COUNT('a1b2c3', '[0-9]')", 3],
        ["REGEXP_LIKE('abc', '^a')", 1],
        ["REGEXP_LIKE('abc', '^b')", 0]
      ];
      REGEXF.forEach((c, i) => val('V40E2#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " AS x", c[1]));

      // ============================================================
      // F. 並べ替え
      // ============================================================
      const cmpText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
      const ORDERS = [
        ['id', (a, b) => a.id - b.id],
        ['id DESC', (a, b) => b.id - a.id],
        ['a, id', (a, b) => a.a - b.a || a.id - b.id],
        ['a DESC, id', (a, b) => b.a - a.a || a.id - b.id],
        ['b, id', (a, b) => a.b - b.b || a.id - b.id],
        ['b DESC, id DESC', (a, b) => b.b - a.b || b.id - a.id],
        ['c, id', (a, b) => a.c - b.c || a.id - b.id],
        ['c DESC, id', (a, b) => b.c - a.c || a.id - b.id],
        ['g, id', (a, b) => cmpText(a.g, b.g) || a.id - b.id],
        ['g DESC, a, id', (a, b) => cmpText(b.g, a.g) || a.a - b.a || a.id - b.id],
        ['s, id', (a, b) => cmpText(a.s, b.s) || a.id - b.id],
        ['s DESC, id', (a, b) => cmpText(b.s, a.s) || a.id - b.id],
        ['u, id', (a, b) => cmpText(a.u, b.u) || a.id - b.id],
        ['a, b, id', (a, b) => a.a - b.a || a.b - b.b || a.id - b.id],
        ['a DESC, b DESC, id', (a, b) => b.a - a.a || b.b - a.b || a.id - b.id],
        ['g, a DESC, id', (a, b) => cmpText(a.g, b.g) || b.a - a.a || a.id - b.id],
        ['a % 7, id', (a, b) => (a.a % 7) - (b.a % 7) || a.id - b.id],
        ['c % 10, c, id', (a, b) => (a.c % 10) - (b.c % 10) || a.c - b.c || a.id - b.id],
        ['LENGTH(s), s, id', (a, b) => a.s.length - b.s.length || cmpText(a.s, b.s) || a.id - b.id],
        ['a + b, id', (a, b) => (a.a + a.b) - (b.a + b.b) || a.id - b.id]
      ];
      ORDERS.forEach((od, i) => {
        const sorted = R.slice().sort(od[1]);
        t('V40F#' + (i + 1) + ' ORDER BY ' + od[0] + ' first 30 ids', () =>
          expectDeep(rows("SELECT id AS id FROM v40_t ORDER BY " + od[0] + " LIMIT 30").map(r => r.id),
                     sorted.slice(0, 30).map(r => r.id)));
        t('V40F#' + (i + 1) + ' ORDER BY ' + od[0] + ' last 10 ids', () =>
          expectDeep(rows("SELECT id AS id FROM v40_t ORDER BY " + od[0] + " LIMIT 10 OFFSET " + (R.length - 10))
                       .map(r => r.id), sorted.slice(R.length - 10).map(r => r.id)));
        val('V40F#' + (i + 1) + ' ORDER BY ' + od[0] + ' first id',
            "SELECT id FROM v40_t ORDER BY " + od[0] + " LIMIT 1", sorted[0].id);
        t('V40F#' + (i + 1) + ' ORDER BY ' + od[0] + ' full sequence', () =>
          expectDeep(rows("SELECT id AS id FROM v40_t ORDER BY " + od[0]).map(r => r.id), sorted.map(r => r.id)));
      });
      t('V40F NULLS FIRST puts the NULLs at the top', () => {
        const got = rows("SELECT nv AS nv FROM v40_t ORDER BY nv NULLS FIRST, id").map(r => r.nv);
        return expect(got[0], null) && expect(got.filter(v => v === null).length, cnt(R, r => r.nv === null));
      });
      t('V40F NULLS LAST puts the NULLs at the bottom', () => {
        const got = rows("SELECT nv AS nv FROM v40_t ORDER BY nv NULLS LAST, id").map(r => r.nv);
        return expect(got[got.length - 1], null);
      });
      val('V40F ORDER BY an ordinal', "SELECT id FROM v40_t ORDER BY 1 DESC LIMIT 1", R.length);
      val('V40F ORDER BY an output alias', "SELECT id AS k FROM v40_t ORDER BY k DESC LIMIT 1", R.length);
      val('V40F ORDER BY the original name after aliasing',
          "SELECT id AS k FROM v40_t ORDER BY id DESC LIMIT 1", R.length);
      val('V40F ORDER BY a CASE expression',
          "SELECT id FROM v40_t ORDER BY CASE WHEN g = 'K5' THEN 0 ELSE 1 END, id LIMIT 1",
          R.filter(r => r.g === 'K5')[0].id);

      // ============================================================
      // G. ページング
      // ============================================================
      [10, 25, 50, 100, 200, 400].forEach(page => {
        t('V40G paging ' + page + ' at a time covers every row', () => {
          const seen = [];
          for (let off = 0; off < R.length; off += page) {
            seen.push.apply(seen, rows("SELECT id AS id FROM v40_t ORDER BY id LIMIT " + page + " OFFSET " + off).map(r => r.id));
          }
          return expectDeep(seen, R.map(r => r.id));
        });
      });
      [[0, 5], [5, 5], [50, 20], [200, 50], [600, 100], [1100, 50], [1190, 20], [1200, 10], [1500, 5]].forEach(pr => {
        const off = pr[0], lim = pr[1];
        const want = R.slice(off, off + lim).map(r => r.id);
        t('V40G LIMIT ' + lim + ' OFFSET ' + off, () =>
          expectDeep(rows("SELECT id AS id FROM v40_t ORDER BY id LIMIT " + lim + " OFFSET " + off).map(r => r.id), want));
        val('V40G LIMIT ' + lim + ' OFFSET ' + off + ' row count',
            "SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY id LIMIT " + lim + " OFFSET " + off + ") z", want.length);
      });
      val('V40G LIMIT beyond the table returns everything',
          "SELECT COUNT(*) FROM (SELECT id FROM v40_t LIMIT 99999) z", R.length);
      val('V40G LIMIT 0 returns nothing', "SELECT COUNT(*) FROM (SELECT id FROM v40_t LIMIT 0) z", 0);
      val('V40G OFFSET without LIMIT', "SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY id OFFSET 900) z", 300);
      val('V40G the MySQL two-argument LIMIT',
          "SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY id LIMIT 100, 30) z", 30);
      t('V40G the MySQL two-argument LIMIT starts at the offset', () =>
        expectDeep(rows("SELECT id AS id FROM v40_t ORDER BY id LIMIT 100, 30").map(r => r.id),
                   R.slice(100, 130).map(r => r.id)));
      val('V40G FETCH FIRST n ROWS ONLY',
          "SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY id FETCH FIRST 37 ROWS ONLY) z", 37);
      val('V40G OFFSET with FETCH NEXT',
          "SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY id OFFSET 100 ROWS FETCH NEXT 25 ROWS ONLY) z", 25);
      val('V40G TOP n', "SELECT COUNT(*) FROM (SELECT TOP 42 id FROM v40_t ORDER BY id) z", 42);
      val('V40G TOP n PERCENT', "SELECT COUNT(*) FROM (SELECT TOP 10 PERCENT id FROM v40_t ORDER BY id) z", 120);
      t('V40G FETCH FIRST WITH TIES keeps the peer group', () => {
        const maxA = Math.max.apply(null, R.map(r => r.a));
        return expect(one("SELECT COUNT(*) FROM (SELECT id FROM v40_t ORDER BY a DESC FETCH FIRST 1 ROWS WITH TIES) z"),
                      cnt(R, r => r.a === maxA));
      });

      // ============================================================
      // H. DISTINCT / 巨大な式
      // ============================================================
      val('V40H DISTINCT over one column', "SELECT COUNT(*) FROM (SELECT DISTINCT g FROM v40_t) z", uniq(R, r => r.g));
      val('V40H DISTINCT over two columns', "SELECT COUNT(*) FROM (SELECT DISTINCT g, b FROM v40_t) z",
          uniq(R, r => r.g + '|' + r.b));
      val('V40H DISTINCT over three columns', "SELECT COUNT(*) FROM (SELECT DISTINCT g, b, s FROM v40_t) z",
          uniq(R, r => r.g + '|' + r.b + '|' + r.s));
      val('V40H DISTINCT over an expression', "SELECT COUNT(*) FROM (SELECT DISTINCT a % 7 AS k FROM v40_t) z",
          uniq(R, r => r.a % 7));
      val('V40H DISTINCT ON keeps one row per key',
          "SELECT COUNT(*) FROM (SELECT DISTINCT ON (g) g, id FROM v40_t ORDER BY g, id) z", uniq(R, r => r.g));
      t('V40H DISTINCT ON keeps the first row of each key', () => {
        const seen = new Map();
        R.forEach(r => { if (!seen.has(r.g)) seen.set(r.g, r.id); });
        const want = [...seen.keys()].sort().map(k => ({ g: k, id: seen.get(k) }));
        return expectDeep(rows("SELECT DISTINCT ON (g) g, id FROM v40_t ORDER BY g, id"), want);
      });
      [10, 50, 100, 250, 500, 1000, 1500].forEach(n => {
        const list = Array.from({ length: n }, (_, i) => i + 1).join(', ');
        val('V40H an IN list of ' + n + ' numbers', "SELECT COUNT(*) FROM v40_t WHERE id IN (" + list + ")",
            Math.min(n, R.length));
        val('V40H a NOT IN list of ' + n + ' numbers', "SELECT COUNT(*) FROM v40_t WHERE id NOT IN (" + list + ")",
            R.length - Math.min(n, R.length));
      });
      [5, 20, 50, 100, 200].forEach(n => {
        const branches = Array.from({ length: n }, (_, i) => "WHEN " + i + " THEN " + (i * 3)).join(' ');
        val('V40H a CASE with ' + n + ' branches', "SELECT SUM(CASE a " + branches + " ELSE -1 END) FROM v40_t",
            sum(R, r => r.a < n ? r.a * 3 : -1));
      });
      [10, 50, 100, 250].forEach(n => {
        val('V40H adding ' + n + ' literals', "SELECT " + Array.from({ length: n }, (_, i) => i + 1).join(' + ') + " AS s",
            n * (n + 1) / 2);
        val('V40H concatenating ' + n + ' literals',
            "SELECT LENGTH(" + Array.from({ length: n }, (_, i) => "'" + (i % 10) + "'").join(' || ') + ") AS s", n);
      });
      [10, 25, 50].forEach(n => {
        let e = '5';
        for (let i = 0; i < n; i++) e = 'ABS(' + e + ')';
        val('V40H ABS nested ' + n + ' deep', "SELECT " + e + " AS v", 5);
      });
      [20, 60, 120].forEach(n => {
        const args = Array.from({ length: n }, () => 'NULL').join(', ');
        val('V40H COALESCE with ' + n + ' NULLs', "SELECT COALESCE(" + args + ", 8) AS v", 8);
      });

      // ============================================================
      // I. 述語 x 並べ替え x ページングの総当たり
      // ============================================================
      const I_PREDS = [];
      [['a', r => r.a, [5, 12, 20, 28, 35, 39]], ['b', r => r.b, [4, 8, 12, 16, 20, 22]],
       ['c', r => r.c, [50, 150, 250, 350, 450, 499]], ['id', r => r.id, [200, 500, 900, 1150]]].forEach(spec => {
        [['>', (u, v) => u > v], ['<', (u, v) => u < v], ['>=', (u, v) => u >= v],
         ['<=', (u, v) => u <= v], ['<>', (u, v) => u !== v]].forEach(op => {
          spec[2].forEach(lit => I_PREDS.push([spec[0] + ' ' + op[0] + ' ' + lit, r => op[1](spec[1](r), lit)]));
        });
      });
      [['g', r => r.g, ["'K0'", "'K3'", "'K5'"]], ['s', r => r.s, ["'row1'", "'row10'", "'row29'"]]].forEach(spec => {
        [['=', (u, v) => u === v], ['<>', (u, v) => u !== v], ['>', (u, v) => u > v]].forEach(op => {
          spec[2].forEach(lit => I_PREDS.push([spec[0] + ' ' + op[0] + ' ' + lit,
                                               r => op[1](spec[1](r), lit.slice(1, -1))]));
        });
      });
      const I_ORDERS = [
        ['id', (a, b) => a.id - b.id],
        ['a, id', (a, b) => a.a - b.a || a.id - b.id],
        ['c DESC, id', (a, b) => b.c - a.c || a.id - b.id],
        ['g, id', (a, b) => cmpText(a.g, b.g) || a.id - b.id],
        ['b DESC, a, id', (a, b) => b.b - a.b || a.a - b.a || a.id - b.id]
      ];
      I_PREDS.forEach((p, i) => {
        const hit = R.filter(p[1]);
        val('V40I#' + (i + 1) + ' [' + p[0] + '] row count', "SELECT COUNT(*) FROM v40_t WHERE " + p[0], hit.length);
        I_ORDERS.forEach((od, j) => {
          const sorted = hit.slice().sort(od[1]);
          t('V40I#' + (i + 1) + '.' + (j + 1) + ' [' + p[0] + '] ORDER BY ' + od[0] + ' first 12', () =>
            expectDeep(rows("SELECT id AS id FROM v40_t WHERE " + p[0] + " ORDER BY " + od[0] + " LIMIT 12").map(r => r.id),
                       sorted.slice(0, 12).map(r => r.id)));
          t('V40I#' + (i + 1) + '.' + (j + 1) + ' [' + p[0] + '] ORDER BY ' + od[0] + ' page 3', () =>
            expectDeep(rows("SELECT id AS id FROM v40_t WHERE " + p[0] + " ORDER BY " + od[0] + " LIMIT 12 OFFSET 24")
                         .map(r => r.id), sorted.slice(24, 36).map(r => r.id)));
        });
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V40Zz cleanup', () => {
        q("DROP TABLE IF EXISTS v40_t");
        return !db.tables['v40_t'];
      });

      return T;
    }
