    // ============================================================================
    // [Test Suite v35] - v1.28: v34（大型クエリ）で見つかった取りこぼしの修正
    //
    //   大型クエリを書いていて当たった「黙って誤る」3 件と、「実 DB では書けるのに
    //   断られる」10 件を直した。その回帰テスト。
    //
    //     A. LAG / LEAD の第 3 引数（既定値）が無視されていた
    //     B. GROUP_CONCAT(x, 'sep')（SQLite 形）が区切り文字を値として連結していた
    //        ＋ 1 引数しか取らない集計に余分な引数を渡すと黙って最後の値だけ使われていた
    //     C. DATE(x) + n が NULL に落ちていた（DATE '...' + n は正しかった）
    //     D. GROUP BY 付きで別名を付けた列を ORDER BY / OVER(ORDER BY) に
    //        元の名前で書けなかった
    //     E. ウィンドウ関数を式の一部に書けなかった
    //     F. FILTER (WHERE ...) を式の一部・HAVING に書けなかった／
    //        ウィンドウ付き FILTER が AS 省略の別名で壊れた
    //     G. CTE 付きの CREATE TABLE AS が通らなかった
    //     H. GROUPING SETS (()) 単独が拒否されていた
    //     I. IS JSON の左辺に関数呼び出しを置けなかった
    //     J. APPLY / LATERAL: 連続した 2 つ目が外側の列を見られない／
    //        派生表の中・派生表を左側にした形が構文エラーになる
    //     K. 括弧付きの集合演算を FROM の派生表に置けなかった
    //
    //   test-suite.js の tests 配列へ getV35Tests() のスプレッドで合流する
    // ============================================================================
    function getV35Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      const q = (sql) => db.executeQuery(sql);
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };
      const col = (sql, k) => rows(sql).map(x => x[k]);
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V35 fixture', () => {
        ['v35_w', 'v35_z', 'v35_d', 'v35_reg', 'v35_fact', 'v35_cust'].forEach(t => q('DROP TABLE IF EXISTS ' + t));
        q("CREATE TABLE v35_w (id INT, g TEXT, v INT, nv INT)");
        q("INSERT INTO v35_w VALUES (1,'a',10,NULL),(2,'a',20,5),(3,'a',40,NULL),(4,'b',5,7),(5,'b',15,1)");
        q("CREATE TABLE v35_z (g TEXT, v INT)");
        q("INSERT INTO v35_z VALUES ('a',1),('a',2),('a',3),('b',10),('b',20)");
        q("CREATE TABLE v35_d (id INT, ts DATE)");
        q("INSERT INTO v35_d VALUES (1,'2024-01-01'),(2,'2024-06-15')");
        q("CREATE TABLE v35_reg (code TEXT, zone TEXT)");
        q("INSERT INTO v35_reg VALUES ('R0','west'),('R1','west'),('R2','east')");
        q("CREATE TABLE v35_cust (id INT, region TEXT)");
        q("INSERT INTO v35_cust VALUES (1,'R0'),(2,'R0'),(3,'R1'),(4,'R2')");
        q("CREATE TABLE v35_fact (id INT, region TEXT, qty INT)");
        q("INSERT INTO v35_fact VALUES (1,'R0',1),(2,'R0',2),(3,'R1',3),(4,'R1',4),(5,'R2',5)");
        return db.tables['v35_w'].rowCount === 5 && db.tables['v35_fact'].rowCount === 5;
      });

      // ============================================================
      // A. LAG / LEAD の既定値
      // ============================================================
      fn('V35A LAG uses the third argument outside the partition', () =>
        eq(col("SELECT id, LAG(v, 1, -1) OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [-1, 10, 20, 40, 5]));
      fn('V35A LEAD uses the third argument outside the partition', () =>
        eq(col("SELECT id, LEAD(v, 1, -1) OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [20, 40, 5, 15, -1]));
      fn('V35A LAG with an offset of two', () =>
        eq(col("SELECT id, LAG(v, 2, -9) OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [-9, -9, 10, 20, 40]));
      fn('V35A LAG per partition still uses the default', () =>
        eq(col("SELECT id, LAG(v, 1, 0) OVER (PARTITION BY g ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [0, 10, 20, 0, 5]));
      fn('V35A the default can be an expression of the current row', () =>
        eq(col("SELECT id, LAG(v, 1, v * 100) OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [1000, 10, 20, 40, 5]));
      fn('V35A the default can be a string', () =>
        eq(one("SELECT a FROM (SELECT id, LAG(v, 1, 'none') OVER (ORDER BY id) AS a FROM v35_w) z WHERE id = 1"), 'none'));
      fn('V35A without a third argument the value stays NULL', () =>
        eq(col("SELECT id, LAG(v) OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [null, 10, 20, 40, 5]));
      fn('V35A IGNORE NULLS also honours the default', () =>
        eq(col("SELECT id, LAG(nv, 1, -5) IGNORE NULLS OVER (ORDER BY id) AS a FROM v35_w ORDER BY id", 'a'),
           [-5, -5, 5, 5, 7]));
      fn('V35A LAG over GROUP BY results honours the default', () =>
        eq(rows("SELECT g, SUM(v) AS s, LAG(SUM(v), 1, -1) OVER (ORDER BY g) AS p FROM v35_w GROUP BY g ORDER BY g"),
           [{ g: 'a', s: 70, p: -1 }, { g: 'b', s: 20, p: 70 }]));
      fn('V35A LEAD over GROUP BY results honours the default', () =>
        eq(col("SELECT g, LEAD(SUM(v), 1, -1) OVER (ORDER BY g) AS p FROM v35_w GROUP BY g ORDER BY g", 'p'),
           [20, -1]));

      // ============================================================
      // B. GROUP_CONCAT の区切り文字と集計の引数個数
      // ============================================================
      push('V35B GROUP_CONCAT with a second argument uses it as the separator',
        "SELECT GROUP_CONCAT(v, '|') AS a FROM v35_z", r => r.data[0].a === '1|2|3|10|20');
      push('V35B GROUP_CONCAT without a separator still uses a comma',
        "SELECT GROUP_CONCAT(v) AS a FROM v35_z", r => r.data[0].a === '1,2,3,10,20');
      push('V35B the SEPARATOR keyword still works',
        "SELECT GROUP_CONCAT(v SEPARATOR '-') AS a FROM v35_z", r => r.data[0].a === '1-2-3-10-20');
      push('V35B DISTINCT combines with the second argument',
        "SELECT GROUP_CONCAT(DISTINCT v, '|') AS a FROM v35_z", r => r.data[0].a === '1|2|3|10|20');
      push('V35B ORDER BY combines with the second argument',
        "SELECT GROUP_CONCAT(v, '|' ORDER BY v DESC) AS a FROM v35_z", r => r.data[0].a === '20|3|2|1|10'
          || r.data[0].a === '20|10|3|2|1');
      push('V35B the second argument works per group',
        "SELECT g, GROUP_CONCAT(v, '+') AS a FROM v35_z GROUP BY g ORDER BY g",
        r => r.data[0].a === '1+2+3' && r.data[1].a === '10+20');
      push('V35B STRING_AGG is unchanged',
        "SELECT STRING_AGG(v, '-') AS a FROM v35_z", r => r.data[0].a === '1-2-3-10-20');
      err('V35B SUM refuses a second argument', "SELECT SUM(v, v) AS a FROM v35_z", 'exactly 1 argument');
      err('V35B AVG refuses a second argument', "SELECT AVG(v, v) AS a FROM v35_z", 'exactly 1 argument');
      err('V35B MIN refuses a second argument', "SELECT MIN(v, v) AS a FROM v35_z", 'exactly 1 argument');
      err('V35B STDDEV_POP refuses a second argument', "SELECT STDDEV_POP(v, v) AS a FROM v35_z", 'exactly 1 argument');
      push('V35B a nested function argument is still one argument',
        "SELECT SUM(ROUND(v * 1.5, 2)) AS a FROM v35_z", r => r.data[0].a === 54);
      push('V35B COUNT(DISTINCT a, b) still takes two columns',
        "SELECT COUNT(DISTINCT g, v) AS a FROM v35_z", r => r.data[0].a === 5);

      // ============================================================
      // C. DATE(x) の算術
      // ============================================================
      const day = (v) => String(v).slice(0, 10);
      push('V35C DATE() plus a number moves the date', "SELECT DATE('2024-01-01') + 5 AS a",
        r => day(r.data[0].a) === '2024-01-06');
      push('V35C DATE() minus a number moves the date back', "SELECT DATE('2024-03-01') - 1 AS a",
        r => day(r.data[0].a) === '2024-02-29');
      push('V35C a number plus DATE() is the same', "SELECT 5 + DATE('2024-01-01') AS a",
        r => day(r.data[0].a) === '2024-01-06');
      push('V35C DATE() minus DATE() is a day count', "SELECT DATE('2024-03-01') - DATE('2024-01-01') AS a",
        r => r.data[0].a === 60);
      push('V35C the typed literal form still works', "SELECT DATE '2024-01-01' + 5 AS a",
        r => day(r.data[0].a) === '2024-01-06');
      push('V35C DATE() over a column', "SELECT id, DATE(ts) + 10 AS a FROM v35_d ORDER BY id",
        r => day(r.data[0].a) === '2024-01-11' && day(r.data[1].a) === '2024-06-25');
      push('V35C DATE() keeps returning just the date part', "SELECT DATE('2024-01-01 13:45:00') AS a",
        r => String(r.data[0].a) === '2024-01-01');
      push('V35C STR_TO_DATE plus a number', "SELECT STR_TO_DATE('2024-05-06', '%Y-%m-%d') + 2 AS a",
        r => day(r.data[0].a) === '2024-05-08');
      push('V35C DATE() with INTERVAL still works', "SELECT DATE('2024-01-01') + INTERVAL 3 DAY AS a",
        r => day(r.data[0].a) === '2024-01-04');
      push('V35C DATE() arithmetic inside WHERE',
        "SELECT COUNT(*) AS c FROM v35_d WHERE DATE(ts) + 1 > DATE('2024-01-01')", r => r.data[0].c === 2);

      // ============================================================
      // D. 別名を付けた列を元の名前で並べ替える
      // ============================================================
      push('V35D ORDER BY the original column name after GROUP BY',
        "SELECT g AS k, COUNT(*) AS n FROM v35_z GROUP BY g ORDER BY g",
        r => r.data.length === 2 && r.data[0].k === 'a' && r.data[1].k === 'b');
      push('V35D ORDER BY the original column name descending',
        "SELECT g AS k, COUNT(*) AS n FROM v35_z GROUP BY g ORDER BY g DESC",
        r => r.data[0].k === 'b' && r.data[1].k === 'a');
      push('V35D ORDER BY the alias still works',
        "SELECT g AS k, COUNT(*) AS n FROM v35_z GROUP BY g ORDER BY k",
        r => r.data[0].k === 'a');
      push('V35D a qualified original name resolves too',
        "SELECT v35_z.g AS k, COUNT(*) AS n FROM v35_z GROUP BY v35_z.g ORDER BY v35_z.g",
        r => r.data[0].k === 'a');
      push('V35D an alias that shadows another column prefers the output column',
        "SELECT g AS v, COUNT(*) AS n FROM v35_z GROUP BY g ORDER BY v",
        r => r.data[0].v === 'a' && r.data[1].v === 'b');
      err('V35D an unknown name is still refused', "SELECT g AS k FROM v35_z ORDER BY nosuch", 'not found');
      fn('V35D the original column name inside OVER (ORDER BY ...)', () =>
        eq(rows("SELECT g AS k, SUM(v) AS s, ROW_NUMBER() OVER (ORDER BY SUM(v) DESC, g) AS rn " +
                "FROM v35_z GROUP BY g ORDER BY rn"),
           [{ k: 'b', s: 30, rn: 1 }, { k: 'a', s: 6, rn: 2 }]));
      fn('V35D the original column name inside OVER (PARTITION BY ...)', () =>
        eq(col("SELECT g AS k, COUNT(*) AS n, ROW_NUMBER() OVER (PARTITION BY g ORDER BY g) AS rn " +
               "FROM v35_z GROUP BY g ORDER BY k", 'rn'), [1, 1]));

      // ============================================================
      // E. 式の一部に書いたウィンドウ関数
      // ============================================================
      fn('V35E subtracting the previous row', () =>
        eq(col("SELECT id, v - LAG(v) OVER (ORDER BY id) AS d FROM v35_w ORDER BY id", 'd'),
           [null, 10, 20, -35, 10]));
      fn('V35E a share of the whole', () =>
        eq(col("SELECT id, ROUND(v * 100.0 / SUM(v) OVER (), 2) AS p FROM v35_w ORDER BY id", 'p'),
           [11.11, 22.22, 44.44, 5.56, 16.67]));
      fn('V35E a share inside each partition', () =>
        eq(col("SELECT id, ROUND(v * 100.0 / SUM(v) OVER (PARTITION BY g), 1) AS p FROM v35_w ORDER BY id", 'p'),
           [14.3, 28.6, 57.1, 25, 75]));
      fn('V35E a window inside COALESCE', () =>
        eq(col("SELECT id, COALESCE(LAG(v) OVER (ORDER BY id), 0) AS p FROM v35_w ORDER BY id", 'p'),
           [0, 10, 20, 40, 5]));
      fn('V35E two windows added together', () =>
        eq(col("SELECT id, LAG(v) OVER (ORDER BY id) + LEAD(v) OVER (ORDER BY id) AS s FROM v35_w ORDER BY id", 's'),
           [null, 50, 25, 55, null]));
      fn('V35E a window inside CASE', () =>
        eq(col("SELECT id, CASE WHEN v > AVG(v) OVER () THEN 'hi' ELSE 'lo' END AS f FROM v35_w ORDER BY id", 'f'),
           ['lo', 'hi', 'hi', 'lo', 'lo']));
      fn('V35E a window multiplied by a constant', () =>
        eq(col("SELECT id, ROW_NUMBER() OVER (ORDER BY id) * 10 AS r FROM v35_w ORDER BY id", 'r'),
           [10, 20, 30, 40, 50]));
      fn('V35E a framed window minus the current value', () =>
        eq(col("SELECT id, SUM(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) - v AS x " +
               "FROM v35_w ORDER BY id", 'x'), [0, 10, 20, 40, 5]));
      fn('V35E a window nested inside ROUND', () =>
        eq(col("SELECT id, ROUND(SUM(v) OVER (), 1) AS t FROM v35_w ORDER BY id", 't'), [90, 90, 90, 90, 90]));
      fn('V35E a plain window item is unchanged', () =>
        eq(col("SELECT id, LAG(v) OVER (ORDER BY id) AS p FROM v35_w ORDER BY id", 'p'),
           [null, 10, 20, 40, 5]));
      push('V35E the result can be filtered in an outer query',
        "SELECT COUNT(*) AS c FROM (SELECT v - LAG(v) OVER (ORDER BY id) AS d FROM v35_w) z WHERE d > 0",
        r => r.data[0].c === 3);
      // 集計と混ざった形は従来からの別経路（隠し列 __wx_N）で処理される
      push('V35E a window added to a grouped aggregate',
        "SELECT g, SUM(v) + ROW_NUMBER() OVER (ORDER BY g) AS x FROM v35_w GROUP BY g ORDER BY g",
        r => r.data.length === 2 && r.data[0].x === 71 && r.data[1].x === 22);
      push('V35E a share of the grand total after GROUP BY',
        "SELECT g, ROUND(100.0 * SUM(v) / SUM(SUM(v)) OVER (), 2) AS pct FROM v35_w GROUP BY g ORDER BY g",
        r => r.data[0].pct === 77.78 && r.data[1].pct === 22.22);

      // ============================================================
      // F. FILTER を式の中に書く
      // ============================================================
      push('V35F FILTER inside COALESCE',
        "SELECT COALESCE(SUM(v) FILTER (WHERE g = 'nope'), -1) AS s FROM v35_z", r => r.data[0].s === 0);
      push('V35F FILTER inside ROUND',
        "SELECT ROUND(AVG(v) FILTER (WHERE g = 'a'), 3) AS a FROM v35_z", r => r.data[0].a === 2);
      push('V35F two FILTER aggregates added',
        "SELECT COUNT(*) FILTER (WHERE g = 'a') + COUNT(*) FILTER (WHERE g = 'b') AS n FROM v35_z",
        r => r.data[0].n === 5);
      push('V35F two FILTER aggregates divided',
        "SELECT SUM(v) FILTER (WHERE g = 'a') * 1.0 / SUM(v) FILTER (WHERE g = 'b') AS r FROM v35_z",
        r => Math.abs(r.data[0].r - 0.2) < 1e-9);
      push('V35F a FILTER aggregate multiplied by a constant',
        "SELECT COUNT(*) FILTER (WHERE v > 2) * 2 AS n FROM v35_z", r => r.data[0].n === 6);
      push('V35F a FILTER aggregate after a leading term',
        "SELECT 1 + COUNT(*) FILTER (WHERE g = 'a') AS n FROM v35_z", r => r.data[0].n === 4);
      push('V35F a FILTER aggregate mixed with a plain one',
        "SELECT COUNT(*) FILTER (WHERE g = 'a') + COUNT(*) AS n FROM v35_z", r => r.data[0].n === 8);
      push('V35F FILTER inside a percentage',
        "SELECT ROUND(SUM(v) FILTER (WHERE g = 'a') * 100.0 / SUM(v), 2) AS pct FROM v35_z",
        r => r.data[0].pct === 16.67);
      push('V35F FILTER inside HAVING',
        "SELECT g FROM v35_z GROUP BY g HAVING COUNT(*) FILTER (WHERE v > 2) > 0 ORDER BY g",
        r => r.data.length === 2);
      push('V35F FILTER inside HAVING can exclude a group',
        "SELECT g FROM v35_z GROUP BY g HAVING COUNT(*) FILTER (WHERE v > 5) > 0 ORDER BY g",
        r => r.data.length === 1 && r.data[0].g === 'b');
      push('V35F a plain FILTER item is unchanged',
        "SELECT COUNT(*) FILTER (WHERE v > 2) AS c FROM v35_z", r => r.data[0].c === 3);
      push('V35F FILTER per group is unchanged',
        "SELECT g, COUNT(*) FILTER (WHERE v > 2) AS c FROM v35_z GROUP BY g ORDER BY g",
        r => r.data[0].c === 1 && r.data[1].c === 2);
      fn('V35F a windowed FILTER without AS on the alias', () =>
        eq(col("SELECT id, SUM(v) FILTER (WHERE v > 10) OVER (PARTITION BY g) s FROM v35_w ORDER BY id", 's'),
           [60, 60, 60, 15, 15]));
      fn('V35F a windowed FILTER inside an expression', () =>
        eq(col("SELECT id, SUM(v) FILTER (WHERE v > 10) OVER (PARTITION BY g) * 2 AS d FROM v35_w ORDER BY id", 'd'),
           [120, 120, 120, 30, 30]));
      fn('V35F a windowed FILTER with AS is unchanged', () =>
        eq(col("SELECT id, COUNT(*) FILTER (WHERE v > 10) OVER () AS c FROM v35_w ORDER BY id", 'c'),
           [3, 3, 3, 3, 3]));

      // ============================================================
      // G. CTE 付きの CREATE TABLE AS
      // ============================================================
      fn('V35G CTAS over a CTE', () => {
        q("DROP TABLE IF EXISTS v35_t1");
        const c = q("CREATE TABLE v35_t1 AS WITH base AS (SELECT id, v FROM v35_w WHERE v > 15) SELECT * FROM base");
        if (c.error) throw new Error(c.error);
        return eq(one("SELECT COUNT(*) FROM v35_t1"), 2);
      });
      fn('V35G CTAS over a CTE keeps the values', () =>
        eq(one("SELECT SUM(v) FROM v35_t1"), 60));
      fn('V35G CTAS over a grouped CTE', () => {
        q("DROP TABLE IF EXISTS v35_t2");
        const c = q("CREATE TABLE v35_t2 AS WITH a AS (SELECT g, SUM(v) AS s FROM v35_z GROUP BY g) " +
                    "SELECT g, s FROM a WHERE s > 25");
        if (c.error) throw new Error(c.error);
        return eq(rows("SELECT g, s FROM v35_t2"), [{ g: 'b', s: 30 }]);
      });
      fn('V35G CTAS over a recursive CTE', () => {
        q("DROP TABLE IF EXISTS v35_t3");
        const c = q("CREATE TABLE v35_t3 AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 10) " +
                    "SELECT n FROM r");
        if (c.error) throw new Error(c.error);
        return eq(one("SELECT SUM(n) FROM v35_t3"), 55);
      });
      fn('V35G CTAS over a CTE with WITH NO DATA', () => {
        q("DROP TABLE IF EXISTS v35_t5");
        const c = q("CREATE TABLE v35_t5 AS WITH b AS (SELECT 1 AS k) SELECT k FROM b WITH NO DATA");
        if (c.error) throw new Error(c.error);
        return eq(one("SELECT COUNT(*) FROM v35_t5"), 0);
      });
      fn('V35G a plain CTAS is unchanged', () => {
        q("DROP TABLE IF EXISTS v35_t4");
        const c = q("CREATE TABLE v35_t4 AS SELECT id, v FROM v35_w WHERE v > 100");
        if (c.error) throw new Error(c.error);
        return eq(one("SELECT COUNT(*) FROM v35_t4"), 0);
      });
      err('V35G a subquery in CHECK is still refused',
        "CREATE TABLE v35_bad (a INT CHECK (a IN (SELECT v FROM v35_z)))", 'cannot contain a subquery');

      // ============================================================
      // H. GROUPING SETS (())
      // ============================================================
      push('V35H an empty grouping set yields one row',
        "SELECT COUNT(*) AS c FROM v35_z GROUP BY GROUPING SETS (())", r => r.data.length === 1 && r.data[0].c === 5);
      push('V35H an empty grouping set totals every row',
        "SELECT SUM(v) AS s FROM v35_z GROUP BY GROUPING SETS (())", r => r.data[0].s === 36);
      push('V35H the empty set combined with a column still works',
        "SELECT g, COUNT(*) AS c FROM v35_z GROUP BY GROUPING SETS ((g), ())", r => r.data.length === 3);
      err('V35H an empty ROLLUP is still refused',
        "SELECT g, SUM(v) AS s FROM v35_z GROUP BY GROUPING SETS (ROLLUP())", 'requires at least one');
      err('V35H an empty CUBE is still refused',
        "SELECT g, SUM(v) AS s FROM v35_z GROUP BY GROUPING SETS (CUBE())", 'requires at least one');

      // ============================================================
      // I. IS JSON の左辺
      // ============================================================
      push('V35I IS JSON over a function call',
        "SELECT COUNT(*) AS c FROM v35_z WHERE JSON_OBJECT('a', v) IS JSON", r => r.data[0].c === 5);
      push('V35I IS JSON OBJECT over a function call',
        "SELECT COUNT(*) AS c FROM v35_z WHERE JSON_OBJECT('a', v) IS JSON OBJECT", r => r.data[0].c === 5);
      push('V35I IS JSON ARRAY over a function call',
        "SELECT COUNT(*) AS c FROM v35_z WHERE JSON_ARRAY(1, 2) IS JSON ARRAY", r => r.data[0].c === 5);
      push('V35I IS NOT JSON over a function call',
        "SELECT COUNT(*) AS c FROM v35_z WHERE UPPER(g) IS NOT JSON", r => r.data[0].c === 5);
      push('V35I IS JSON over a column is unchanged',
        "SELECT COUNT(*) AS c FROM v35_z WHERE g IS NOT JSON", r => r.data[0].c === 5);
      push('V35I IS JSON over a literal is unchanged',
        "SELECT COUNT(*) AS c FROM v35_z WHERE '{\"a\":1}' IS JSON", r => r.data[0].c === 5);

      // ============================================================
      // J. APPLY / LATERAL
      // ============================================================
      push('V35J two CROSS APPLY clauses in a row see the outer row',
        "SELECT SUM(x.k + y.k) AS s FROM v35_reg g " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_cust c WHERE c.region = g.code) y",
        r => r.data[0].s === 9);
      push('V35J three CROSS APPLY clauses keep their own columns',
        "SELECT SUM(x.k + y.k + z.k) AS s FROM v35_reg g CROSS APPLY (SELECT 1 AS k) x " +
        "CROSS APPLY (SELECT 2 AS k) y CROSS APPLY (SELECT 3 AS k) z", r => r.data[0].s === 18);
      push('V35J a single APPLY is unchanged',
        "SELECT SUM(x.k) AS s FROM v35_reg g CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x",
        r => r.data[0].s === 5);
      push('V35J APPLY inside a derived table',
        "SELECT SUM(z.k) AS s FROM (SELECT x.k AS k FROM v35_reg g " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x) z", r => r.data[0].s === 5);
      push('V35J LATERAL inside a grouped derived table',
        "SELECT COUNT(*) AS c FROM (SELECT g.zone AS zone, SUM(x.k) AS k FROM v35_reg g, " +
        "LATERAL (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x GROUP BY g.zone) z",
        r => r.data[0].c === 2);
      push('V35J APPLY with a derived table on the left',
        "SELECT COUNT(*) AS c FROM (SELECT code, zone FROM v35_reg) z " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = z.code) x", r => r.data[0].c === 3);
      push('V35J APPLY with a derived table on the left totals correctly',
        "SELECT SUM(x.k) AS s FROM (SELECT code FROM v35_reg) z " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = z.code) x", r => r.data[0].s === 5);
      push('V35J an APPLY result can be ordered and limited inside a derived table',
        "SELECT COUNT(*) AS c FROM (SELECT x.k FROM v35_reg g " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x ORDER BY x.k DESC LIMIT 2) z",
        r => r.data[0].c === 2);
      push('V35J OUTER APPLY keeps rows whose inner query is empty',
        "SELECT COUNT(*) AS c FROM v35_reg g OUTER APPLY (SELECT f.id FROM v35_fact f WHERE f.region = g.code AND f.qty > 4) x",
        r => r.data[0].c === 3);
      push('V35J APPLY grouped afterwards',
        "SELECT g.zone AS zone, SUM(x.k) AS s FROM v35_reg g " +
        "CROSS APPLY (SELECT COUNT(*) AS k FROM v35_fact f WHERE f.region = g.code) x GROUP BY g.zone ORDER BY zone",
        r => r.data.length === 2 && r.data[0].s === 1 && r.data[1].s === 4);

      // ============================================================
      // K. 括弧付きの集合演算を FROM に置く
      // ============================================================
      push('V35K a parenthesised UNION as a derived table',
        "SELECT COUNT(*) AS c FROM ((SELECT 1 AS v) UNION (SELECT 2)) t", r => r.data[0].c === 2);
      push('V35K a parenthesised UNION ALL chain as a derived table',
        "SELECT SUM(v) AS s FROM ((SELECT 1 AS v) UNION ALL (SELECT 2) UNION ALL (SELECT 3)) t", r => r.data[0].s === 6);
      push('V35K a parenthesised INTERSECT as a derived table',
        "SELECT COUNT(*) AS c FROM ((SELECT id FROM v35_fact) INTERSECT (SELECT id FROM v35_fact WHERE id % 2 = 0)) t",
        r => r.data[0].c === 2);
      push('V35K a parenthesised EXCEPT as a derived table',
        "SELECT COUNT(*) AS c FROM ((SELECT id FROM v35_fact) EXCEPT (SELECT id FROM v35_fact WHERE id % 2 = 0)) t",
        r => r.data[0].c === 3);
      push('V35K a mixed parenthesised set operation as a derived table',
        "SELECT COUNT(*) AS c FROM ((SELECT id FROM v35_fact WHERE id <= 2 UNION ALL SELECT id FROM v35_fact WHERE id >= 4) " +
        "INTERSECT (SELECT id FROM v35_fact WHERE id % 2 = 0)) t", r => r.data[0].c === 2);
      push('V35K the top-level form is unchanged',
        "(SELECT id FROM v35_fact WHERE id <= 2) UNION (SELECT id FROM v35_fact WHERE id >= 4)",
        r => r.data.length === 4);
      push('V35K a plain derived table is unchanged',
        "SELECT COUNT(*) AS c FROM (SELECT 1 AS v UNION SELECT 2) t", r => r.data[0].c === 2);

      // ============================================================
      // 片付け
      // ============================================================
      fn('V35Zz cleanup', () => {
        ['v35_w', 'v35_z', 'v35_d', 'v35_reg', 'v35_fact', 'v35_cust',
         'v35_t1', 'v35_t2', 'v35_t3', 'v35_t4', 'v35_t5', 'v35_bad']
          .forEach(t => q('DROP TABLE IF EXISTS ' + t));
        return true;
      });

      return T;
    }
