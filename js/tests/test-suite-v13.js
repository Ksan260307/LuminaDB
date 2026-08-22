    // ============================================================================
    // [Test Suite v13] - 網羅性拡大（商用DB頻用の関数/演算子/クエリ機能の総当たり）
    //   期待値はシード配列や独立した JS 参照から算出し、エンジン結果と突き合わせる。
    //   これにより SQL 経路（構文解析→式コンパイル→実行）を端から端まで検証する。
    //   test-suite.js の tests 配列へ getV13Tests() のスプレッドで合流する
    // ============================================================================
    function getV13Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, approx, mround } = makeTestKit('V13');
      // MySQL 互換 ROUND（ゼロから遠い方向）の JS 参照
      const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };
      const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };

      // ---- シード（engine-core の _initDefaultData と一致）----
      const U_ages = [25, 30, 22, 35, 28, 40, 29, 31, 24, 27];
      const U_names = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"];
      const P_prices = [1500, 800, 120, 250, 400];
      const P_stock = [45, 12, 100, 80, 0];
      const O_user = [1, 2, 1, 3, 4];

      // ============================================================
      // 1. 数値スカラー関数（多様な入力で総当たり、期待値は JS で算出）
      // ============================================================
      for (let x = -6; x <= 6; x++) {
        push(`V13Abs(${x})`, `SELECT ABS(${x}) AS a`, r => r.data[0].a === Math.abs(x));
        push(`V13Sign(${x})`, `SELECT SIGN(${x}) AS a`, r => r.data[0].a === Math.sign(x));
        push(`V13Square(${x})`, `SELECT SQUARE(${x}) AS a`, r => r.data[0].a === x * x);
      }
      [-3.7, -2.5, -1.2, -0.5, 0.5, 1.2, 2.5, 3.5, 4.49, 5.5].forEach((x, i) => {
        push(`V13Ceil ${i}`, `SELECT CEIL(${x}) AS a`, r => r.data[0].a === Math.ceil(x));
        push(`V13Floor ${i}`, `SELECT FLOOR(${x}) AS a`, r => r.data[0].a === Math.floor(x));
        push(`V13Round0 ${i}`, `SELECT ROUND(${x}) AS a`, r => r.data[0].a === mround(x, 0));
        push(`V13Trunc0 ${i}`, `SELECT TRUNCATE(${x}, 0) AS a`, r => r.data[0].a === Math.trunc(x));
      });
      [[3.14159, 2], [2.7182, 3], [123.456, 1], [-9.876, 2], [0.005, 2]].forEach(([x, d], i) => {
        push(`V13RoundD ${i}`, `SELECT ROUND(${x}, ${d}) AS a`, r => approx(r.data[0].a, mround(x, d)));
        push(`V13TruncD ${i}`, `SELECT TRUNCATE(${x}, ${d}) AS a`, r => approx(r.data[0].a, Math.trunc(x * Math.pow(10, d)) / Math.pow(10, d)));
      });
      [[10, 3], [10, -3], [-10, 3], [17, 5], [100, 7], [8, 4]].forEach(([a, b], i) => {
        push(`V13Mod ${i}`, `SELECT MOD(${a}, ${b}) AS a`, r => r.data[0].a === a % b);
        push(`V13Gcd ${i}`, `SELECT GCD(${a}, ${b}) AS a`, r => r.data[0].a === gcd(a, b));
      });
      [[2, 10], [3, 4], [5, 3], [10, 0], [2, -2], [7, 2]].forEach(([a, b], i) => {
        push(`V13Power ${i}`, `SELECT POWER(${a}, ${b}) AS a`, r => approx(r.data[0].a, Math.pow(a, b)));
      });
      [0, 1, 4, 9, 16, 25, 100, 2, 3, 10].forEach((x, i) => {
        push(`V13Sqrt ${i}`, `SELECT SQRT(${x}) AS a`, r => approx(r.data[0].a, Math.sqrt(x)));
      });
      for (let n = 0; n <= 10; n++) push(`V13Fact(${n})`, `SELECT FACTORIAL(${n}) AS a`, r => r.data[0].a === fact(n));
      [[3, 7, 2, 9], [10, 5, 8], [-1, -5, -3], [100, 50]].forEach((args, i) => {
        push(`V13Greatest ${i}`, `SELECT GREATEST(${args.join(', ')}) AS a`, r => r.data[0].a === Math.max(...args));
        push(`V13Least ${i}`, `SELECT LEAST(${args.join(', ')}) AS a`, r => r.data[0].a === Math.min(...args));
      });
      [1, 2, 5, 10, 100].forEach((x, i) => push(`V13Exp ${i}`, `SELECT ROUND(EXP(${x}), 4) AS a`, r => approx(r.data[0].a, mround(Math.exp(x), 4))));
      push('V13Pi', 'SELECT ROUND(PI(), 5) AS a', r => approx(r.data[0].a, 3.14159));

      // ============================================================
      // 2. 文字列スカラー関数
      // ============================================================
      const strCases = [
        ["UPPER('abcDEF')", 'ABCDEF'], ["LOWER('abcDEF')", 'abcdef'],
        ["LENGTH('hello')", 5], ["LENGTH('')", 0],
        ["LEFT('abcdef', 3)", 'abc'], ["LEFT('abc', 10)", 'abc'], ["LEFT('abcdef', 0)", ''],
        ["RIGHT('abcdef', 2)", 'ef'], ["RIGHT('abc', 10)", 'abc'],
        ["REVERSE('abc')", 'cba'], ["REVERSE('LuminaDB')", 'BDanimuL'],
        ["TRIM('  hi  ')", 'hi'], ["LTRIM('  hi')", 'hi'], ["RTRIM('hi  ')", 'hi'],
        ["REPLACE('a-b-c', '-', '+')", 'a+b+c'], ["REPLACE('aaa', 'a', 'bb')", 'bbbbbb'],
        ["SUBSTRING('abcdef', 2, 3)", 'bcd'], ["SUBSTRING('abcdef', 4)", 'def'],
        ["SUBSTR('hello', 2, 2)", 'el'],
        ["LPAD('5', 3, '0')", '005'], ["RPAD('5', 3, '0')", '500'], ["LPAD('abc', 2, 'x')", 'ab'],
        ["REPEAT('ab', 3)", 'ababab'], ["REPEAT('x', 0)", ''],
        ["INSTR('hello', 'll')", 3], ["INSTR('hello', 'z')", 0],
        ["LOCATE('lo', 'hello')", 4], ["LOCATE('z', 'hello')", 0],
        ["INITCAP('hello world')", 'Hello World'],
        ["ASCII('A')", 65], ["ASCII('a')", 97],
        ["CHAR(65)", 'A'], ["CHAR(97)", 'a'],
        ["SPACE(3)", '   '],
        ["CONCAT('a', 'b', 'c')", 'abc'], ["CONCAT('x', 1, 'y')", 'x1y'],
        ["CONCAT_WS('-', 'a', 'b', 'c')", 'a-b-c'],
        ["SUBSTRING_INDEX('a.b.c.d', '.', 2)", 'a.b'], ["SUBSTRING_INDEX('a.b.c.d', '.', -2)", 'c.d'],
        ["SPLIT_PART('a,b,c', ',', 2)", 'b'], ["SPLIT_PART('a,b,c', ',', 9)", ''],
        ["TRANSLATE('abc', 'ac', 'AC')", 'AbC'],
        ["CONCAT(UPPER('ab'), LOWER('CD'))", 'ABcd'],
        ["LEFT(RIGHT('abcdef', 3), 2)", 'de'],
        ["LENGTH(TRIM('  padded  '))", 6],
        ["REPLACE(UPPER('a-b'), '-', '_')", 'A_B'],
        ["QUOTENAME('col')", '[col]'],
        ["STUFF('abcdef', 2, 3, 'XY')", 'aXYef'],
        ["LEN('  trailing   ')", 10]
      ];
      strCases.forEach(([expr, exp], i) => push(`V13Str ${i}: ${expr}`, `SELECT ${expr} AS a`, r => r.data[0].a === exp));

      // ============================================================
      // 3. NULL / 条件分岐
      // ============================================================
      const flowCases = [
        ["COALESCE(NULL, NULL, 3)", 3], ["COALESCE(1, 2)", 1], ["COALESCE(NULL, 'x')", 'x'],
        ["IFNULL(NULL, 5)", 5], ["IFNULL(7, 5)", 7],
        ["ISNULL(NULL, 'd')", 'd'], ["ISNULL('v', 'd')", 'v'],
        ["NVL(NULL, 9)", 9], ["NVL(2, 9)", 2],
        ["NVL2(1, 'a', 'b')", 'a'], ["NVL2(NULL, 'a', 'b')", 'b'],
        ["NULLIF(5, 5)", null], ["NULLIF(5, 6)", 5],
        ["ZEROIFNULL(NULL)", 0], ["ZEROIFNULL(4)", 4],
        ["NULLIFZERO(0)", null], ["NULLIFZERO(4)", 4],
        ["DECODE(2, 1, 'a', 2, 'b', 'c')", 'b'], ["DECODE(9, 1, 'a', 2, 'b', 'c')", 'c'],
        ["CHOOSE(2, 'x', 'y', 'z')", 'y'], ["CHOOSE(9, 'x', 'y')", null],
        ["IIF(1 = 1, 'yes', 'no')", 'yes'], ["IIF(1 = 2, 'yes', 'no')", 'no'],
        ["IF(5 > 3, 'a', 'b')", 'a'],
        ["CASE WHEN 1 = 1 THEN 'one' ELSE 'x' END", 'one'],
        ["CASE 3 WHEN 1 THEN 'a' WHEN 3 THEN 'c' ELSE 'x' END", 'c'],
        ["COALESCE(NULLIF('', ''), 'empty')", 'empty'],
        ["GREATEST(1, NULL, 3)", null], ["LEAST(1, NULL, 3)", null]
      ];
      flowCases.forEach(([expr, exp], i) => push(`V13Flow ${i}: ${expr}`, `SELECT ${expr} AS a`, r => r.data[0].a === exp));

      // ============================================================
      // 4. 日付・時刻関数（固定日付で総当たり）
      // ============================================================
      const dateCases = [
        ["YEAR(DATE('2026-07-23'))", 2026], ["MONTH(DATE('2026-07-23'))", 7], ["DAY(DATE('2026-07-23'))", 23],
        ["QUARTER(DATE('2026-07-23'))", 3], ["QUARTER(DATE('2026-01-15'))", 1], ["QUARTER(DATE('2026-12-01'))", 4],
        ["DAYOFWEEK(DATE('2026-07-23'))", 5], ["DAYOFYEAR(DATE('2026-01-10'))", 10],
        ["MONTHNAME(DATE('2026-07-23'))", 'July'], ["DAYNAME(DATE('2026-07-23'))", 'Thursday'],
        ["LAST_DAY(DATE('2026-02-10'))", '2026-02-28'], ["LAST_DAY(DATE('2024-02-10'))", '2024-02-29'],
        ["EOMONTH(DATE('2026-02-10'))", '2026-02-28'],
        ["DATEDIFF(DATE('2026-01-10'), DATE('2026-01-01'))", 9],
        ["DATEDIFF(DATE('2026-01-01'), DATE('2026-01-10'))", -9],
        ["ADD_MONTHS(DATE('2026-01-31'), 1)", '2026-02-28 00:00:00'], ["ADD_MONTHS(DATE('2026-01-15'), 2)", '2026-03-15 00:00:00'],
        ["EXTRACT(YEAR FROM DATE('2026-07-23'))", 2026], ["EXTRACT(MONTH FROM DATE('2026-07-23'))", 7],
        ["EXTRACT(DAY FROM DATE('2026-07-23'))", 23],
        ["DATEPART(YEAR, DATE('2026-07-23'))", 2026], ["DATEPART(DAY, DATE('2026-07-23'))", 23],
        ["DATENAME(MONTH, DATE('2026-03-01'))", 'March'],
        ["MONTHS_BETWEEN(DATE('2026-03-15'), DATE('2026-01-15'))", 2]
      ];
      dateCases.forEach(([expr, exp], i) => push(`V13Date ${i}: ${expr}`, `SELECT ${expr} AS a`, r => r.data[0].a === exp));
      // DATE_ADD / DATE_SUB with INTERVAL（日付部分のみ比較）
      const daCases = [
        ["DATE_ADD(DATE('2026-01-01'), INTERVAL 5 DAY)", '2026-01-06'],
        ["DATE_ADD(DATE('2026-01-01'), INTERVAL 1 MONTH)", '2026-02-01'],
        ["DATE_ADD(DATE('2026-01-01'), INTERVAL 1 YEAR)", '2027-01-01'],
        ["DATE_SUB(DATE('2026-01-10'), INTERVAL 5 DAY)", '2026-01-05'],
        ["DATE_ADD(DATE('2026-01-31'), INTERVAL 1 MONTH)", '2026-02-28'],
        ["DATEADD(DAY, 10, DATE('2026-01-01'))", '2026-01-11'],
        ["DATEADD(WEEK, 1, DATE('2026-01-01'))", '2026-01-08']
      ];
      daCases.forEach(([expr, exp], i) => push(`V13DateAdd ${i}: ${expr}`, `SELECT ${expr} AS a`, r => String(r.data[0].a).startsWith(exp)));

      // ============================================================
      // 5. 述語（WHERE）: シード配列から件数/合計を算出して照合
      // ============================================================
      const thresholds = [22, 24, 25, 27, 28, 29, 30, 31, 35, 40];
      thresholds.forEach(t => {
        push(`V13W gt ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age > ${t}`, r => r.data[0].c === U_ages.filter(a => a > t).length);
        push(`V13W ge ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age >= ${t}`, r => r.data[0].c === U_ages.filter(a => a >= t).length);
        push(`V13W lt ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age < ${t}`, r => r.data[0].c === U_ages.filter(a => a < t).length);
        push(`V13W le ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age <= ${t}`, r => r.data[0].c === U_ages.filter(a => a <= t).length);
        push(`V13W eq ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age = ${t}`, r => r.data[0].c === U_ages.filter(a => a === t).length);
        push(`V13W ne ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age <> ${t}`, r => r.data[0].c === U_ages.filter(a => a !== t).length);
        push(`V13W sum gt ${t}`, `SELECT SUM(age) AS s FROM users WHERE age > ${t}`, r => (r.data[0].s || 0) === U_ages.filter(a => a > t).reduce((x, y) => x + y, 0));
      });
      [[25, 30], [22, 28], [30, 40], [24, 31]].forEach(([lo, hi], i) => {
        push(`V13W between ${i}`, `SELECT COUNT(*) AS c FROM users WHERE age BETWEEN ${lo} AND ${hi}`, r => r.data[0].c === U_ages.filter(a => a >= lo && a <= hi).length);
        push(`V13W notbetween ${i}`, `SELECT COUNT(*) AS c FROM users WHERE age NOT BETWEEN ${lo} AND ${hi}`, r => r.data[0].c === U_ages.filter(a => !(a >= lo && a <= hi)).length);
      });
      [[25, 30, 40], [22, 24], [28, 29, 31, 35]].forEach((set, i) => {
        push(`V13W in ${i}`, `SELECT COUNT(*) AS c FROM users WHERE age IN (${set.join(', ')})`, r => r.data[0].c === U_ages.filter(a => set.includes(a)).length);
        push(`V13W notin ${i}`, `SELECT COUNT(*) AS c FROM users WHERE age NOT IN (${set.join(', ')})`, r => r.data[0].c === U_ages.filter(a => !set.includes(a)).length);
      });
      // LIKE パターン（名前）
      // LIKE はこのエンジンでは大文字小文字を無視するため、参照側も小文字化して比較する
      const likeCases = [
        ["A%", n => n.toLowerCase().startsWith('a')], ["%e", n => n.toLowerCase().endsWith('e')], ["%a%", n => n.toLowerCase().includes('a')],
        ["_ob", n => /^.ob$/i.test(n)], ["%i%", n => n.toLowerCase().includes('i')], ["J%", n => n.toLowerCase().startsWith('j')],
        ["____", n => n.length === 4], ["%", () => true]
      ];
      likeCases.forEach(([pat, fn], i) => push(`V13Like ${i}: ${pat}`, `SELECT COUNT(*) AS c FROM users WHERE name LIKE '${pat}'`, r => r.data[0].c === U_names.filter(fn).length));
      // AND / OR / NOT の組み合わせ
      push('V13Bool and', "SELECT COUNT(*) AS c FROM users WHERE age > 25 AND age < 35", r => r.data[0].c === U_ages.filter(a => a > 25 && a < 35).length);
      push('V13Bool or', "SELECT COUNT(*) AS c FROM users WHERE age < 25 OR age > 35", r => r.data[0].c === U_ages.filter(a => a < 25 || a > 35).length);
      push('V13Bool not', "SELECT COUNT(*) AS c FROM users WHERE NOT (age > 30)", r => r.data[0].c === U_ages.filter(a => !(a > 30)).length);
      push('V13Bool mixed', "SELECT COUNT(*) AS c FROM users WHERE (age > 25 AND age < 30) OR age = 40", r => r.data[0].c === U_ages.filter(a => (a > 25 && a < 30) || a === 40).length);

      // ============================================================
      // 6. 集計関数（シードから算出）
      // ============================================================
      push('V13Agg count users', 'SELECT COUNT(*) AS c FROM users', r => r.data[0].c === U_ages.length);
      push('V13Agg sum age', 'SELECT SUM(age) AS s FROM users', r => r.data[0].s === U_ages.reduce((a, b) => a + b, 0));
      push('V13Agg avg age', 'SELECT AVG(age) AS a FROM users', r => approx(r.data[0].a, U_ages.reduce((a, b) => a + b, 0) / U_ages.length));
      push('V13Agg min age', 'SELECT MIN(age) AS a FROM users', r => r.data[0].a === Math.min(...U_ages));
      push('V13Agg max age', 'SELECT MAX(age) AS a FROM users', r => r.data[0].a === Math.max(...U_ages));
      push('V13Agg sum price', 'SELECT SUM(price) AS s FROM products', r => r.data[0].s === P_prices.reduce((a, b) => a + b, 0));
      push('V13Agg max price', 'SELECT MAX(price) AS a FROM products', r => r.data[0].a === Math.max(...P_prices));
      push('V13Agg min stock', 'SELECT MIN(stock) AS a FROM products', r => r.data[0].a === Math.min(...P_stock));
      push('V13Agg sum amount', 'SELECT SUM(amount) AS s FROM orders', r => r.data[0].s === 10);
      push('V13Agg count distinct user', 'SELECT COUNT(DISTINCT user_id) AS c FROM orders', r => r.data[0].c === new Set(O_user).size);
      push('V13Agg empty sum', 'SELECT SUM(age) AS s FROM users WHERE age > 1000', r => r.data[0].s === 0);
      push('V13Agg empty count', 'SELECT COUNT(*) AS c FROM users WHERE age > 1000', r => r.data[0].c === 0);
      // GROUP BY orders.user_id
      const grpCounts = {}; O_user.forEach(u => grpCounts[u] = (grpCounts[u] || 0) + 1);
      push('V13Grp orders by user', 'SELECT user_id, COUNT(*) AS c FROM orders GROUP BY user_id ORDER BY user_id', r => {
        return r.data.length === Object.keys(grpCounts).length && r.data.every(row => row.c === grpCounts[row.user_id]);
      });
      push('V13Grp having', 'SELECT user_id, COUNT(*) AS c FROM orders GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY user_id', r => {
        const exp = Object.keys(grpCounts).filter(u => grpCounts[u] > 1);
        return r.data.length === exp.length && r.data[0].user_id === 1;
      });

      // ============================================================
      // 7. ORDER BY / LIMIT / OFFSET / DISTINCT
      // ============================================================
      push('V13Ord asc', 'SELECT age FROM users ORDER BY age ASC', r => r.data.map(x => x.age).join(',') === [...U_ages].sort((a, b) => a - b).join(','));
      push('V13Ord desc', 'SELECT age FROM users ORDER BY age DESC', r => r.data.map(x => x.age).join(',') === [...U_ages].sort((a, b) => b - a).join(','));
      [1, 2, 3, 5, 7, 10].forEach(n => push(`V13Limit ${n}`, `SELECT id FROM users ORDER BY id LIMIT ${n}`, r => r.data.length === Math.min(n, 10) && r.data[0].id === 1));
      [0, 2, 5, 8].forEach(o => push(`V13Offset ${o}`, `SELECT id FROM users ORDER BY id LIMIT 3 OFFSET ${o}`, r => r.data.length === Math.min(3, Math.max(0, 10 - o)) && (r.data[0] ? r.data[0].id === o + 1 : true)));
      push('V13Distinct user', 'SELECT DISTINCT user_id FROM orders ORDER BY user_id', r => r.data.length === new Set(O_user).size);
      push('V13Fetch first', 'SELECT id FROM users ORDER BY id FETCH FIRST 4 ROWS ONLY', r => r.data.length === 4);
      push('V13Limit comma', 'SELECT id FROM users ORDER BY id LIMIT 2, 3', r => r.data.length === 3 && r.data[0].id === 3);

      // ============================================================
      // 8. JOIN / サブクエリ / CASE / UNION
      // ============================================================
      push('V13Join inner', 'SELECT u.name, o.order_id FROM users u JOIN orders o ON u.id = o.user_id ORDER BY o.order_id', r => r.data.length === 5 && r.data[0].name === 'Alice');
      push('V13Join left', 'SELECT u.id FROM users u LEFT JOIN orders o ON u.id = o.user_id', r => r.data.length >= 10);
      push('V13Sub in', 'SELECT COUNT(*) AS c FROM users WHERE id IN (SELECT user_id FROM orders)', r => r.data[0].c === new Set(O_user).size);
      push('V13Sub scalar', 'SELECT (SELECT MAX(age) FROM users) AS m', r => r.data[0].m === 40);
      push('V13Sub exists', 'SELECT COUNT(*) AS c FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)', r => r.data[0].c === new Set(O_user).size);
      push('V13Case select', "SELECT id, CASE WHEN age >= 30 THEN 'senior' ELSE 'junior' END AS grp FROM users ORDER BY id", r => r.data[0].grp === (U_ages[0] >= 30 ? 'senior' : 'junior') && r.data[5].grp === 'senior');
      push('V13Union', 'SELECT id FROM users WHERE id <= 3 UNION SELECT id FROM users WHERE id >= 9 ORDER BY id', r => r.data.length === 5);
      push('V13Union all', 'SELECT id FROM users WHERE id <= 3 UNION ALL SELECT id FROM users WHERE id <= 2', r => r.data.length === 5);
      push('V13Cte', 'WITH young AS (SELECT * FROM users WHERE age < 28) SELECT COUNT(*) AS c FROM young', r => r.data[0].c === U_ages.filter(a => a < 28).length);
      push('V13Window rownum', 'SELECT id, ROW_NUMBER() OVER (ORDER BY age DESC) AS rn FROM users', r => r.data.length === 10 && r.data.some(x => x.rn === 1));
      push('V13Window rank', 'SELECT name, RANK() OVER (ORDER BY age DESC) AS rk FROM users ORDER BY rk', r => r.data[0].rk === 1);

      // ============================================================
      // 9. DML ラウンドトリップ（CREATE/INSERT/UPDATE/DELETE を検証）
      // ============================================================
      for (let k = 0; k < 12; k++) {
        push(`V13Dml roundtrip ${k}`, null, undefined);
      }
      // 上のプレースホルダを実処理へ差し替え（fn 形式）
      T.splice(T.findIndex(t => t.name === 'V13Dml roundtrip 0'), 12,
        ...Array.from({ length: 12 }, (_, k) => ({
          name: `V13Dml roundtrip ${k}`,
          fn: () => {
            const tn = `v13dml_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER PRIMARY KEY, v INTEGER, s TEXT)`);
            const base = (k + 1) * 10;
            db.executeQuery(`INSERT INTO ${tn} (id, v, s) VALUES (1, ${base}, 'a'), (2, ${base + 1}, 'b'), (3, ${base + 2}, 'c')`);
            db.executeQuery(`UPDATE ${tn} SET v = v + 100 WHERE id = 2`);
            db.executeQuery(`DELETE FROM ${tn} WHERE id = 3`);
            const cnt = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`);
            const row2 = db.executeQuery(`SELECT v FROM ${tn} WHERE id = 2`);
            const sum = db.executeQuery(`SELECT SUM(v) AS s FROM ${tn}`);
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return cnt.data[0].c === 2 && row2.data[0].v === base + 1 + 100 && sum.data[0].s === base + (base + 1 + 100);
          }
        }))
      );

      // ============================================================
      // 10. 追加の商用関数の総当たり（v1.11 群を多様な入力で）
      // ============================================================
      const commCases = [
        ["TO_CHAR(1234567, '9,999,999')", '1,234,567'], ["TO_CHAR(0, '000')", '000'],
        ["TO_CHAR(42)", '42'], ["TO_HEX(4095)", 'fff'], ["TO_HEX(1)", '1'],
        ["TRY_CAST('100' AS INTEGER)", 100], ["TRY_CAST('bad' AS INTEGER)", null],
        ["OVERLAY('123456', 'ab', 3)", '12ab56'],
        ["PARSENAME('a.b.c', 1)", 'c'], ["PARSENAME('a.b.c', 3)", 'a'],
        ["REMAINDER(7, 3)", 1], ["REMAINDER(-7, 3)", -1],
        ["SHIFTLEFT(3, 2)", 12], ["SHIFTRIGHT(64, 3)", 8],
        ["NANVL(5, 0)", 5], ["LOG(2, 16)", 4], ["LOG(10, 100)", 2],
        ["BITAND(12, 10)", 8], ["BITOR(12, 10)", 14], ["BITXOR(12, 10)", 6],
        ["CHARINDEX('lo', 'hello')", 4], ["STARTS_WITH('hello', 'he')", true], ["ENDS_WITH('hello', 'lo')", true]
      ];
      commCases.forEach(([expr, exp], i) => push(`V13Comm ${i}: ${expr}`, `SELECT ${expr} AS a`, r => (typeof exp === 'number' ? approx(r.data[0].a, exp) || r.data[0].a === exp : r.data[0].a === exp)));

      // ============================================================
      // 11. 追加の数値総当たり（広い入力範囲）
      // ============================================================
      for (let x = -10; x <= 10; x++) {
        push(`V13Neg abs(${x})`, `SELECT ABS(${x}) AS a`, r => r.data[0].a === Math.abs(x));
        push(`V13Ceil int(${x})`, `SELECT CEIL(${x}) AS a`, r => r.data[0].a === x);
        push(`V13Mod5(${x})`, `SELECT MOD(${x}, 5) AS a`, r => r.data[0].a === x % 5);
      }
      for (let b = 0; b <= 12; b++) push(`V13Pow2(${b})`, `SELECT POWER(2, ${b}) AS a`, r => r.data[0].a === Math.pow(2, b));
      for (let n = 1; n <= 10; n++) push(`V13Gcd12(${n})`, `SELECT GCD(12, ${n}) AS a`, r => r.data[0].a === gcd(12, n));
      [[0.1, 0.2], [1.5, 2.5], [3.33, 6.67], [10.01, 0.99]].forEach(([a, b], i) => {
        push(`V13Add ${i}`, `SELECT ROUND(${a} + ${b}, 2) AS a`, r => approx(r.data[0].a, mround(a + b, 2)));
        push(`V13Mul ${i}`, `SELECT ROUND(${a} * ${b}, 4) AS a`, r => approx(r.data[0].a, mround(a * b, 4)));
      });

      // ============================================================
      // 12. 文字列パラメトリック（LPAD/RPAD/REPEAT/LEFT/RIGHT/SUBSTRING）
      // ============================================================
      for (let n = 1; n <= 8; n++) {
        push(`V13Lpad ${n}`, `SELECT LPAD('x', ${n}, '-') AS a`, r => r.data[0].a === (n === 1 ? 'x' : '-'.repeat(n - 1) + 'x'));
        push(`V13Rpad ${n}`, `SELECT RPAD('x', ${n}, '-') AS a`, r => r.data[0].a === (n === 1 ? 'x' : 'x' + '-'.repeat(n - 1)));
        push(`V13Left ${n}`, `SELECT LEFT('abcdefgh', ${n}) AS a`, r => r.data[0].a === 'abcdefgh'.slice(0, n));
        push(`V13Right ${n}`, `SELECT RIGHT('abcdefgh', ${n}) AS a`, r => r.data[0].a === 'abcdefgh'.slice(-n));
      }
      for (let n = 0; n <= 6; n++) push(`V13Repeat ${n}`, `SELECT REPEAT('ab', ${n}) AS a`, r => r.data[0].a === 'ab'.repeat(n));
      for (let s = 1; s <= 6; s++) push(`V13Substr ${s}`, `SELECT SUBSTRING('abcdefgh', ${s}, 2) AS a`, r => r.data[0].a === 'abcdefgh'.substr(s - 1, 2));
      // UPPER/LOWER/LENGTH/REVERSE を seed 名で総当たり
      U_names.forEach((nm, i) => {
        push(`V13Uname upper ${i}`, `SELECT UPPER(name) AS a FROM users WHERE id = ${i + 1}`, r => r.data[0].a === nm.toUpperCase());
        push(`V13Uname len ${i}`, `SELECT LENGTH(name) AS a FROM users WHERE id = ${i + 1}`, r => r.data[0].a === nm.length);
        push(`V13Uname rev ${i}`, `SELECT REVERSE(name) AS a FROM users WHERE id = ${i + 1}`, r => r.data[0].a === nm.split('').reverse().join(''));
      });

      // ============================================================
      // 13. products の述語（price / stock をシード配列から算出）
      // ============================================================
      [120, 250, 400, 800, 1500].forEach(t => {
        push(`V13P price gt ${t}`, `SELECT COUNT(*) AS c FROM products WHERE price > ${t}`, r => r.data[0].c === P_prices.filter(p => p > t).length);
        push(`V13P price ge ${t}`, `SELECT COUNT(*) AS c FROM products WHERE price >= ${t}`, r => r.data[0].c === P_prices.filter(p => p >= t).length);
        push(`V13P price lt ${t}`, `SELECT COUNT(*) AS c FROM products WHERE price < ${t}`, r => r.data[0].c === P_prices.filter(p => p < t).length);
        push(`V13P price sum le ${t}`, `SELECT SUM(price) AS s FROM products WHERE price <= ${t}`, r => (r.data[0].s || 0) === P_prices.filter(p => p <= t).reduce((a, b) => a + b, 0));
      });
      [0, 12, 45, 80, 100].forEach(t => {
        push(`V13P stock gt ${t}`, `SELECT COUNT(*) AS c FROM products WHERE stock > ${t}`, r => r.data[0].c === P_stock.filter(s => s > t).length);
        push(`V13P stock le ${t}`, `SELECT COUNT(*) AS c FROM products WHERE stock <= ${t}`, r => r.data[0].c === P_stock.filter(s => s <= t).length);
        push(`V13P stock eq ${t}`, `SELECT COUNT(*) AS c FROM products WHERE stock = ${t}`, r => r.data[0].c === P_stock.filter(s => s === t).length);
      });

      // ============================================================
      // 14. users の2条件組み合わせ述語（総当たり）
      // ============================================================
      const los = [24, 27, 30];
      const his = [30, 35, 40];
      los.forEach(lo => his.forEach(hi => {
        push(`V13W2 (${lo},${hi}) and`, `SELECT COUNT(*) AS c FROM users WHERE age > ${lo} AND age < ${hi}`, r => r.data[0].c === U_ages.filter(a => a > lo && a < hi).length);
        push(`V13W2 (${lo},${hi}) or`, `SELECT COUNT(*) AS c FROM users WHERE age <= ${lo} OR age >= ${hi}`, r => r.data[0].c === U_ages.filter(a => a <= lo || a >= hi).length);
      }));
      // AVG/MIN/MAX を各しきい値のフィルタで
      [22, 25, 28, 31].forEach(t => {
        const f = U_ages.filter(a => a >= t);
        // v1.27 から AVG は倍精度のまま返す（以前は小数2桁へ丸めていた）
        push(`V13Aggf avg ge ${t}`, `SELECT AVG(age) AS a FROM users WHERE age >= ${t}`, r => approx(r.data[0].a, f.length ? (f.reduce((x, y) => x + y, 0) / f.length) : 0));
        push(`V13Aggf max ge ${t}`, `SELECT MAX(age) AS a FROM users WHERE age >= ${t}`, r => r.data[0].a === (f.length ? Math.max(...f) : null));
        push(`V13Aggf min ge ${t}`, `SELECT MIN(age) AS a FROM users WHERE age >= ${t}`, r => r.data[0].a === (f.length ? Math.min(...f) : null));
        push(`V13Aggf cnt ge ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age >= ${t}`, r => r.data[0].c === f.length);
      });

      // ============================================================
      // 15. 演算子・式の評価（定数式）
      // ============================================================
      const exprCases = [
        ["1 + 2 * 3", 7], ["(1 + 2) * 3", 9], ["10 - 4 - 3", 3], ["2 * 3 + 4 * 5", 26],
        ["10 / 4", 2.5], ["7 % 3", 1], ["-5 + 3", -2], ["2 * (3 + 4) - 1", 13],
        ["100 / 10 / 2", 5], ["3 + 4 * 2 - 1", 10], ["ABS(-3) + ABS(4)", 7],
        ["POWER(2, 3) + 1", 9], ["GREATEST(1, 2) * LEAST(3, 4)", 6],
        ["CASE WHEN 2 > 1 THEN 10 ELSE 20 END + 5", 15]
      ];
      exprCases.forEach(([expr, exp], i) => push(`V13Expr ${i}: ${expr}`, `SELECT ${expr} AS a`, r => approx(r.data[0].a, exp) || r.data[0].a === exp));

      // ============================================================
      // 16. さらなる総当たり（3000件到達のための網羅追加。すべて独立参照で検証）
      // ============================================================
      const P_names = ["Laptop", "Monitor", "Mouse", "Keyboard", "Router"];
      P_names.forEach((nm, i) => {
        push(`V13Pname upper ${i}`, `SELECT UPPER(name) AS a FROM products WHERE id = ${101 + i}`, r => r.data[0].a === nm.toUpperCase());
        push(`V13Pname lower ${i}`, `SELECT LOWER(name) AS a FROM products WHERE id = ${101 + i}`, r => r.data[0].a === nm.toLowerCase());
        push(`V13Pname len ${i}`, `SELECT LENGTH(name) AS a FROM products WHERE id = ${101 + i}`, r => r.data[0].a === nm.length);
      });
      // 固定日付リストの YEAR/MONTH/DAY
      const dates = ['2020-01-01', '2021-06-15', '2022-12-31', '2023-02-28', '2024-02-29', '2025-07-04', '2026-11-30', '2019-03-17', '2018-09-09', '2027-05-21'];
      dates.forEach((d, i) => {
        const [Y, M, D] = d.split('-').map(Number);
        push(`V13DY year ${i}`, `SELECT YEAR(DATE('${d}')) AS a`, r => r.data[0].a === Y);
        push(`V13DY month ${i}`, `SELECT MONTH(DATE('${d}')) AS a`, r => r.data[0].a === M);
        push(`V13DY day ${i}`, `SELECT DAY(DATE('${d}')) AS a`, r => r.data[0].a === D);
      });
      // SQRT(x^2) = x (x>=0)
      for (let x = 0; x <= 10; x++) push(`V13SqrtSq ${x}`, `SELECT SQRT(${x * x}) AS a`, r => approx(r.data[0].a, x));
      // ROUND(x/3, 2)
      for (let x = -10; x <= 10; x++) push(`V13Div3 ${x}`, `SELECT ROUND(${x} / 3.0, 2) AS a`, r => approx(r.data[0].a, mround(x / 3, 2)));
      // MOD a%4
      for (let a = 0; a <= 9; a++) push(`V13Mod4 ${a}`, `SELECT MOD(${a}, 4) AS a`, r => r.data[0].a === a % 4);
      // INSTR マトリクス
      [['a', 'banana', 2], ['na', 'banana', 3], ['z', 'banana', 0], ['ban', 'banana', 1], ['ana', 'banana', 2]].forEach(([sub, s, exp], i) => {
        push(`V13Instr ${i}`, `SELECT INSTR('${s}', '${sub}') AS a`, r => r.data[0].a === exp);
      });
      // IN sets（追加）
      [[1, 2, 3], [4, 5, 6, 7], [8, 9, 10], [1, 10], [2, 4, 6, 8, 10]].forEach((set, i) => {
        push(`V13InId ${i}`, `SELECT COUNT(*) AS c FROM users WHERE id IN (${set.join(', ')})`, r => r.data[0].c === set.filter(x => x >= 1 && x <= 10).length);
      });
      // BETWEEN on price
      [[100, 300], [200, 900], [400, 1500], [0, 150], [800, 2000]].forEach(([lo, hi], i) => {
        push(`V13PBtw ${i}`, `SELECT COUNT(*) AS c FROM products WHERE price BETWEEN ${lo} AND ${hi}`, r => r.data[0].c === P_prices.filter(p => p >= lo && p <= hi).length);
      });
      // COALESCE ネスト
      const coCases = [
        ["COALESCE(NULL, NULL, NULL, 4)", 4], ["COALESCE(NULL, 2, 3)", 2],
        ["COALESCE(NULLIF(5,5), NULLIF(6,6), 7)", 7], ["COALESCE(IFNULL(NULL, NULL), 9)", 9],
        ["NVL(NULLIF(3,3), 8)", 8]
      ];
      coCases.forEach(([expr, exp], i) => push(`V13Co ${i}: ${expr}`, `SELECT ${expr} AS a`, r => r.data[0].a === exp));
      // TRUNCATE(x, 1)
      [3.14, 2.78, -1.55, 9.99, 0.05, 12.34, -7.89].forEach((x, i) => push(`V13Trunc1 ${i}`, `SELECT TRUNCATE(${x}, 1) AS a`, r => approx(r.data[0].a, Math.trunc(x * 10) / 10)));
      // SIGN over decimals
      [-2.5, -0.1, 0, 0.1, 5.5].forEach((x, i) => push(`V13SignD ${i}`, `SELECT SIGN(${x}) AS a`, r => r.data[0].a === Math.sign(x)));
      // CONCAT of columns
      push('V13ConcatCols', "SELECT CONCAT(name, ':', age) AS a FROM users WHERE id = 1", r => r.data[0].a === 'Alice:25');
      push('V13ConcatWsCols', "SELECT CONCAT_WS('/', name, age) AS a FROM users WHERE id = 2", r => r.data[0].a === 'Bob/30');
      // ROW_NUMBER partition
      push('V13WinPart', "SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY order_id) AS rn FROM orders ORDER BY user_id, rn", r => r.data.some(x => x.user_id === 1 && x.rn === 2));
      // 集計 + GROUP BY on products stock buckets
      push('V13GrpStockPos', "SELECT COUNT(*) AS c FROM products WHERE stock > 0", r => r.data[0].c === P_stock.filter(s => s > 0).length);

      return T;
    }
