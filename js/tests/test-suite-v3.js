    // ============================================================================
    // [Test Suite v3] - v1.2 機能追加・修正の回帰テスト
    //   1. V3Corr: 相関サブクエリ (EXISTS / NOT EXISTS / IN / スカラ、UPDATE/DELETE)
    //   2. V3Rec : WITH RECURSIVE（数列 / 木構造 / 循環 / 反復キャップ）
    //   3. V3Val : VALUES 句の式評価と DEFAULT キーワード
    //   4. V3Grp : GROUP BY 序数 / 別名 / 括弧内カンマ
    //   5. V3Agg : GROUP_CONCAT ORDER BY / JSON_ARRAYAGG / JSON_OBJECTAGG / COUNT(DISTINCT a,b)
    //   6. V3Fn  : REGEXP_* / SPLIT_PART / QUOTE / BIT_COUNT / 時刻変換 / STR_TO_DATE /
    //              TRIM拡張構文 / SUBSTRING FROM FOR / DATEリテラル / FETCH FIRST
    //   7. V3Fix : ネストCASE / IN内関数呼び出し
    //   8. V3Cmp : 複合 UNIQUE / PRIMARY KEY（DDL・DML・永続化・ロールバック）
    //   9. V3Tmp : CREATE TEMPORARY TABLE
    //  10. V3Api : LuminaDB.select / count / update / remove
    //  11. V3Show: SHOW CHECKS
    //   test-suite.js の tests 配列へ getV3Tests() のスプレッドで合流する
    // ============================================================================
    function getV3Tests() {
      return [
        // ============================================================
        // 1. 相関サブクエリ (V3Corr)
        // ============================================================
        { name: "V3Corr: EXISTS Correlated", sql: "SELECT COUNT(*) AS c FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)", check: r => r.data[0].c === 4 },
        { name: "V3Corr: NOT EXISTS Correlated", sql: "SELECT COUNT(*) AS c FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)", check: r => r.data[0].c === 6 },
        { name: "V3Corr: Scalar In Select Clause", sql: "SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS cnt FROM users u ORDER BY u.id ASC LIMIT 4", check: r =>
            r.data.length === 4 && r.data[0].cnt === 2 && r.data[1].cnt === 1 && r.data[2].cnt === 1 && r.data[3].cnt === 1 },
        { name: "V3Corr: Scalar In Where", sql: "SELECT COUNT(*) AS c FROM users u WHERE (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) >= 2", check: r => r.data[0].c === 1 },
        { name: "V3Corr: Scalar No Rows Is Null", sql: "SELECT COUNT(*) AS c FROM users u WHERE (SELECT o.amount FROM orders o WHERE o.user_id = u.id AND o.amount > 99) IS NULL", check: r => r.data[0].c === 10 },
        { name: "V3Corr: IN Correlated", sql: "SELECT COUNT(*) AS c FROM products p WHERE p.id IN (SELECT o.product_id FROM orders o WHERE o.amount >= p.stock)", check: r => r.data[0].c === 1 },
        { name: "V3Corr: NOT IN Correlated", sql: "SELECT COUNT(*) AS c FROM products p WHERE p.id NOT IN (SELECT o.product_id FROM orders o WHERE o.amount >= p.stock)", check: r => r.data[0].c === 4 },
        // u3 (Charlie) の注文は order 1004 (amount 5) のみ → SUM = 5
        { name: "V3Corr: Correlated With Expression Compare", sql: "SELECT name FROM users u WHERE (SELECT SUM(o.amount) FROM orders o WHERE o.user_id = u.id) = 5 ORDER BY id", check: r => r.data.length === 1 && r.data[0].name === 'Charlie' },
        { name: "V3Corr: Update With Correlated Where", fn: () => {
            db.executeQuery("CREATE TABLE v3c_p (id INTEGER, cnt INTEGER)");
            db.executeQuery("CREATE TABLE v3c_c (pid INTEGER)");
            db.executeQuery("INSERT INTO v3c_p (id, cnt) VALUES (1, 0), (2, 0), (3, 0)");
            db.executeQuery("INSERT INTO v3c_c (pid) VALUES (1), (1), (3)");
            const r = db.executeQuery("UPDATE v3c_p SET cnt = 99 WHERE EXISTS (SELECT 1 FROM v3c_c WHERE v3c_c.pid = v3c_p.id)");
            const v = db.executeQuery("SELECT id FROM v3c_p WHERE cnt = 99 ORDER BY id");
            return !r.error && v.data.length === 2 && v.data[0].id === 1 && v.data[1].id === 3;
        }},
        { name: "V3Corr: Delete With Correlated Where", fn: () => {
            const r = db.executeQuery("DELETE FROM v3c_p WHERE NOT EXISTS (SELECT 1 FROM v3c_c WHERE v3c_c.pid = v3c_p.id)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v3c_p");
            db.executeQuery("DROP TABLE v3c_c, v3c_p");
            return !r.error && r.data[0].Message.includes('1 row deleted') && c.data[0].c === 2;
        }},
        { name: "V3Corr: Scalar Update Set Value", fn: () => {
            db.executeQuery("CREATE TABLE v3c_agg (uid INTEGER, total INTEGER)");
            db.executeQuery("INSERT INTO v3c_agg (uid, total) VALUES (1, 0), (2, 0), (5, 0)");
            const r = db.executeQuery("UPDATE v3c_agg SET total = (SELECT SUM(o.amount) FROM orders o WHERE o.user_id = v3c_agg.uid)");
            const v = db.executeQuery("SELECT uid, total FROM v3c_agg ORDER BY uid");
            db.executeQuery("DROP TABLE v3c_agg");
            // u1: amount 1+1=2 / u2: 2 / u5: 注文なし → 本エンジンの SUM は空集合で 0 を返す
            return !r.error && v.data[0].total === 2 && v.data[1].total === 2 && v.data[2].total === 0;
        }},
        errCase("V3Corr: Correlated In From Rejected", "SELECT * FROM (SELECT o.user_id FROM orders o WHERE o.user_id = users.id) t", 'not supported in FROM/JOIN'),
        errCase("V3Corr: Nested Correlated Rejected", "SELECT COUNT(*) AS c FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND EXISTS (SELECT 1 FROM products p WHERE p.id = o.product_id))", 'Nested correlated'),
        errCase("V3Corr: Ambiguous Self Compare Still Rejected", "SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM users WHERE id = id)", 'ambiguous'),
        errCase("V3Corr: Correlated In Having Rejected", "SELECT age, COUNT(*) AS c FROM users GROUP BY age HAVING (SELECT MAX(o.amount) FROM orders o WHERE o.user_id = age) > 0"),
        { name: "V3Corr: Comma Join Inside Subquery Not Correlated", sql: "SELECT COUNT(*) AS c FROM users WHERE id IN (SELECT o.user_id FROM orders o, products p WHERE o.product_id = p.id)", check: r => r.data[0].c === 4 },
        { name: "V3Corr: Multiple Refs Same Row", sql: "SELECT COUNT(*) AS c FROM orders o1 WHERE EXISTS (SELECT 1 FROM orders o2 WHERE o2.user_id = o1.user_id AND o2.order_id <> o1.order_id)", check: r => r.data[0].c === 2 },

        // ============================================================
        // 2. WITH RECURSIVE (V3Rec)
        // ============================================================
        { name: "V3Rec: Number Sequence", sql: "WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT COUNT(*) AS c, MAX(n) AS m FROM seq", check: r => r.data[0].c === 5 && r.data[0].m === 5 },
        { name: "V3Rec: Tree Descendants", fn: () => {
            db.executeQuery("CREATE TABLE v3tree (id INTEGER, parent_id INTEGER)");
            db.executeQuery("INSERT INTO v3tree (id, parent_id) VALUES (1, NULL), (2, 1), (3, 1), (4, 2), (5, 99)");
            const r = db.executeQuery("WITH RECURSIVE d AS (SELECT id FROM v3tree WHERE id = 1 UNION ALL SELECT t.id FROM v3tree t JOIN d ON t.parent_id = d.id) SELECT COUNT(*) AS c FROM d");
            return !r.error && r.data[0].c === 4;
        }},
        { name: "V3Rec: Depth Tracking Column", sql: "WITH RECURSIVE d AS (SELECT id, 0 AS depth FROM v3tree WHERE id = 1 UNION ALL SELECT t.id, d.depth + 1 AS depth FROM v3tree t JOIN d ON t.parent_id = d.id) SELECT MAX(depth) AS md FROM d", check: r => r.data[0].md === 2 },
        { name: "V3Rec: Tree Cleanup", sql: "DROP TABLE v3tree", check: r => r.data[0].Result === "Success" },
        { name: "V3Rec: Union Dedup Terminates On Cycle", fn: () => {
            db.executeQuery("CREATE TABLE v3edge (a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v3edge (a, b) VALUES (1, 2), (2, 1)");
            const r = db.executeQuery("WITH RECURSIVE r AS (SELECT 1 AS node UNION SELECT e.b AS node FROM v3edge e JOIN r ON e.a = r.node) SELECT COUNT(*) AS c FROM r");
            db.executeQuery("DROP TABLE v3edge");
            return !r.error && r.data[0].c === 2;
        }},
        errCase("V3Rec: Union All Runaway Capped", "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n FROM r) SELECT COUNT(*) AS c FROM r", 'exceeded 500 iterations'),
        { name: "V3Rec: Column Realignment", sql: "WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT seq.n + 1 AS other FROM seq WHERE seq.n < 3) SELECT MAX(n) AS m FROM seq", check: r => r.data[0].m === 3 },
        { name: "V3Rec: Anchor Only No Self Ref", sql: "WITH RECURSIVE x AS (SELECT 42 AS v) SELECT v FROM x", check: r => r.data[0].v === 42 },
        errCase("V3Rec: Missing Anchor Rejected", "WITH RECURSIVE r AS (SELECT n + 1 AS n FROM r) SELECT * FROM r", 'anchor'),
        { name: "V3Rec: Join With Main Query", sql: "WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 3) SELECT COUNT(*) AS c FROM users u JOIN seq s ON u.id = s.n", check: r => r.data[0].c === 3 },
        { name: "V3Rec: Non-Recursive WITH Unaffected", sql: "WITH a AS (SELECT id FROM users WHERE id <= 3) SELECT COUNT(*) AS c FROM a", check: r => r.data[0].c === 3 },

        // ============================================================
        // 3. VALUES 句の式評価 / DEFAULT (V3Val)
        // ============================================================
        { name: "V3Val: Setup", sql: "CREATE TABLE v3val (a, b)", check: r => r.data[0].Result === "Success" },
        { name: "V3Val: Arithmetic Expression", sql: "INSERT INTO v3val (a, b) VALUES (1 + 1, 3 * 3)", check: r => r.data[0].Message.includes('1') },
        { name: "V3Val: Function Call With Comma Args", sql: "INSERT INTO v3val (a, b) VALUES (CONCAT('x', 'y'), UPPER('ab'))", check: r => r.data[0].Message.includes('1') },
        { name: "V3Val: Values Verified", sql: "SELECT a, b FROM v3val ORDER BY a", check: r =>
            r.data.length === 2 && r.data[0].a === 2 && r.data[0].b === 9 && r.data[1].a === 'xy' && r.data[1].b === 'AB' },
        { name: "V3Val: Bare Word Stays String", fn: () => {
            db.executeQuery("INSERT INTO v3val (a, b) VALUES (hello, world)");
            const r = db.executeQuery("SELECT a, b FROM v3val WHERE a = 'hello'");
            return r.data.length === 1 && r.data[0].b === 'world';
        }},
        { name: "V3Val: Nested Function Expression", sql: "INSERT INTO v3val (a, b) VALUES (ROUND(ABS(-2.7)), LENGTH(CONCAT('ab', 'c')))", check: r => r.data[0].Message.includes('1') },
        { name: "V3Val: Nested Values Verified", sql: "SELECT COUNT(*) AS c FROM v3val WHERE a = 3 AND b = 3", check: r => r.data[0].c === 1 },
        { name: "V3Val: Cleanup", sql: "DROP TABLE v3val", check: r => r.data[0].Result === "Success" },
        { name: "V3Val: DEFAULT Keyword", fn: () => {
            db.executeQuery("CREATE TABLE v3def (id INTEGER PRIMARY KEY AUTO_INCREMENT, st TEXT DEFAULT 'act', v INTEGER)");
            const r = db.executeQuery("INSERT INTO v3def (id, st, v) VALUES (DEFAULT, DEFAULT, 5)");
            const q = db.executeQuery("SELECT id, st, v FROM v3def");
            db.executeQuery("DROP TABLE v3def");
            return !r.error && q.data[0].id === 1 && q.data[0].st === 'act' && q.data[0].v === 5;
        }},
        { name: "V3Val: DEFAULT Without Definition Is Null", fn: () => {
            db.executeQuery("CREATE TABLE v3def2 (a INTEGER, b TEXT)");
            db.executeQuery("INSERT INTO v3def2 (a, b) VALUES (1, DEFAULT)");
            const q = db.executeQuery("SELECT b FROM v3def2 WHERE a = 1");
            db.executeQuery("DROP TABLE v3def2");
            return q.data[0].b === null;
        }},

        // ============================================================
        // 4. GROUP BY 序数 / 別名 / カンマ分割 (V3Grp)
        // ============================================================
        { name: "V3Grp: Group By Ordinal", sql: "SELECT user_id, COUNT(*) AS c FROM orders GROUP BY 1 ORDER BY user_id ASC", check: r =>
            r.data.length === 4 && r.data[0].user_id === 1 && r.data[0].c === 2 },
        { name: "V3Grp: Group By Alias", sql: "SELECT age >= 30 AS senior, COUNT(*) AS c FROM users GROUP BY senior ORDER BY senior ASC", check: r =>
            r.data.length === 2 && r.data[0].c === 6 && r.data[1].c === 4 },
        { name: "V3Grp: Group By Expression With Comma", fn: () => {
            db.executeQuery("CREATE TABLE v3gb (a TEXT, b TEXT)");
            db.executeQuery("INSERT INTO v3gb (a, b) VALUES ('x', '1'), ('x', '1'), ('y', '2')");
            const r = db.executeQuery("SELECT CONCAT(a, b) AS k, COUNT(*) AS c FROM v3gb GROUP BY CONCAT(a, b) ORDER BY k ASC");
            db.executeQuery("DROP TABLE v3gb");
            return !r.error && r.data.length === 2 && r.data[0].k === 'x1' && r.data[0].c === 2 && r.data[1].k === 'y2' && r.data[1].c === 1;
        }},
        errCase("V3Grp: Ordinal Out Of Range Rejected", "SELECT age FROM users GROUP BY 5", 'out of range'),
        { name: "V3Grp: Real Column Preferred Over Alias", sql: "SELECT age AS name, COUNT(*) AS c FROM users GROUP BY name", check: r => r.data.length === 10 },

        // ============================================================
        // 5. 集計拡張 (V3Agg)
        // ============================================================
        { name: "V3Agg: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v3gc (g TEXT, v TEXT, o INTEGER)");
            const r = db.executeQuery("INSERT INTO v3gc (g, v, o) VALUES ('A', 'b', 2), ('A', 'a', 1), ('A', 'c', 3)");
            return !r.error && r.data[0].Message.includes('3');
        }},
        { name: "V3Agg: GROUP_CONCAT ORDER BY DESC With Separator", sql: "SELECT GROUP_CONCAT(v ORDER BY o DESC SEPARATOR '-') AS s FROM v3gc", check: r => r.data[0].s === 'c-b-a' },
        { name: "V3Agg: GROUP_CONCAT ORDER BY ASC Default Sep", sql: "SELECT GROUP_CONCAT(v ORDER BY o ASC) AS s FROM v3gc", check: r => r.data[0].s === 'a,b,c' },
        { name: "V3Agg: JSON_ARRAYAGG Ordered", sql: "SELECT JSON_ARRAYAGG(v ORDER BY o ASC) AS j FROM v3gc", check: r => r.data[0].j === '["a","b","c"]' },
        { name: "V3Agg: JSON_ARRAYAGG Numbers", sql: "SELECT JSON_ARRAYAGG(o ORDER BY o DESC) AS j FROM v3gc", check: r => r.data[0].j === '[3,2,1]' },
        { name: "V3Agg: JSON_OBJECTAGG", sql: "SELECT JSON_OBJECTAGG(v, o) AS j FROM v3gc", check: r => r.data[0].j === '{"b":2,"a":1,"c":3}' },
        { name: "V3Agg: JSON_OBJECTAGG Empty Group Is Null", sql: "SELECT JSON_OBJECTAGG(v, o) AS j FROM v3gc WHERE o > 99", check: r => r.data[0].j === null },
        { name: "V3Agg: JSON Agg With Group By", sql: "SELECT g, JSON_ARRAYAGG(v ORDER BY v ASC) AS j FROM v3gc GROUP BY g", check: r => r.data.length === 1 && r.data[0].j === '["a","b","c"]' },
        { name: "V3Agg: Cleanup", sql: "DROP TABLE v3gc", check: r => r.data[0].Result === "Success" },
        { name: "V3Agg: COUNT DISTINCT Multi Column", fn: () => {
            db.executeQuery("CREATE TABLE v3cd (a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v3cd (a, b) VALUES (1, 1), (1, 1), (1, 2), (NULL, 1)");
            const r = db.executeQuery("SELECT COUNT(DISTINCT a, b) AS c, COUNT(*) AS total FROM v3cd");
            db.executeQuery("DROP TABLE v3cd");
            return !r.error && r.data[0].c === 2 && r.data[0].total === 4;
        }},
        { name: "V3Agg: COUNT DISTINCT Multi In Having", fn: () => {
            db.executeQuery("CREATE TABLE v3cd2 (g TEXT, a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v3cd2 (g, a, b) VALUES ('x', 1, 1), ('x', 1, 2), ('y', 1, 1), ('y', 1, 1)");
            const r = db.executeQuery("SELECT g FROM v3cd2 GROUP BY g HAVING COUNT(DISTINCT a, b) >= 2");
            db.executeQuery("DROP TABLE v3cd2");
            return !r.error && r.data.length === 1 && r.data[0].g === 'x';
        }},

        // ============================================================
        // 6. 新関数 / 構文 (V3Fn)
        // ============================================================
        { name: "V3Fn: REGEXP_REPLACE", sql: "SELECT REGEXP_REPLACE('abc123def456', '[0-9]+', '#') AS r", check: r => r.data[0].r === 'abc#def#' },
        { name: "V3Fn: REGEXP_SUBSTR", sql: "SELECT REGEXP_SUBSTR('abc123def', '[0-9]+') AS r, REGEXP_SUBSTR('abc', '[0-9]+') AS n", check: r => r.data[0].r === '123' && r.data[0].n === null },
        { name: "V3Fn: REGEXP_LIKE", sql: "SELECT REGEXP_LIKE('hello', '^h') AS y, REGEXP_LIKE('hello', '^z') AS n", check: r => r.data[0].y === 1 && r.data[0].n === 0 },
        { name: "V3Fn: SPLIT_PART", sql: "SELECT SPLIT_PART('a,b,c', ',', 2) AS p, SPLIT_PART('a,b,c', ',', -1) AS l, SPLIT_PART('a,b,c', ',', 9) AS e", check: r => r.data[0].p === 'b' && r.data[0].l === 'c' && r.data[0].e === '' },
        { name: "V3Fn: QUOTE", sql: "SELECT QUOTE('ab') AS q, QUOTE(NULL) AS n", check: r => r.data[0].q === "'ab'" && r.data[0].n === 'NULL' },
        { name: "V3Fn: QUOTE Escapes Quotes", sql: "SELECT QUOTE('a''b') AS q", check: r => r.data[0].q === "'a\\'b'" },
        { name: "V3Fn: BIT_COUNT", sql: "SELECT BIT_COUNT(7) AS a, BIT_COUNT(0) AS b, BIT_COUNT(255) AS c", check: r => r.data[0].a === 3 && r.data[0].b === 0 && r.data[0].c === 8 },
        { name: "V3Fn: SEC_TO_TIME / TIME_TO_SEC", sql: "SELECT SEC_TO_TIME(3661) AS t, TIME_TO_SEC('01:01:01') AS s, TIME_TO_SEC(SEC_TO_TIME(7325)) AS rt", check: r => r.data[0].t === '01:01:01' && r.data[0].s === 3661 && r.data[0].rt === 7325 },
        { name: "V3Fn: MAKEDATE", sql: "SELECT MAKEDATE(2026, 32) AS d, MAKEDATE(2026, 1) AS f", check: r => r.data[0].d === '2026-02-01' && r.data[0].f === '2026-01-01' },
        { name: "V3Fn: STR_TO_DATE Date Only", sql: "SELECT STR_TO_DATE('16/07/2026', '%d/%m/%Y') AS d", check: r => r.data[0].d === '2026-07-16' },
        { name: "V3Fn: STR_TO_DATE With Time", sql: "SELECT STR_TO_DATE('2026-07-16 09:05', '%Y-%m-%d %H:%i') AS d", check: r => r.data[0].d === '2026-07-16 09:05:00' },
        { name: "V3Fn: STR_TO_DATE Month Name", sql: "SELECT STR_TO_DATE('July 16, 2026', '%M %d, %Y') AS d", check: r => r.data[0].d === '2026-07-16' },
        { name: "V3Fn: STR_TO_DATE Mismatch Is Null", sql: "SELECT STR_TO_DATE('2026/07/16', '%Y-%m-%d') AS d", check: r => r.data[0].d === null },
        { name: "V3Fn: STR_TO_DATE Roundtrip With DATE_FORMAT", sql: "SELECT STR_TO_DATE(DATE_FORMAT('2026-07-16', '%d/%m/%Y'), '%d/%m/%Y') AS d", check: r => r.data[0].d === '2026-07-16' },
        { name: "V3Fn: TRIM LEADING", sql: "SELECT TRIM(LEADING 'x' FROM 'xxay') AS t", check: r => r.data[0].t === 'ay' },
        { name: "V3Fn: TRIM TRAILING", sql: "SELECT TRIM(TRAILING 'x' FROM 'ayxx') AS t", check: r => r.data[0].t === 'ay' },
        { name: "V3Fn: TRIM BOTH Multi Char", sql: "SELECT TRIM(BOTH 'ab' FROM 'ababXab') AS t", check: r => r.data[0].t === 'X' },
        { name: "V3Fn: TRIM Remstr Form", sql: "SELECT TRIM('x' FROM 'xxyx') AS t", check: r => r.data[0].t === 'y' },
        { name: "V3Fn: TRIM LEADING Default Space", sql: "SELECT TRIM(LEADING FROM '  hi ') AS t", check: r => r.data[0].t === 'hi ' },
        { name: "V3Fn: TRIM Single Arg Compat", sql: "SELECT TRIM('  hi  ') AS t", check: r => r.data[0].t === 'hi' },
        { name: "V3Fn: TRIM With FROM In Real Table Query", sql: "SELECT TRIM(BOTH 'A' FROM name) AS t FROM users WHERE id = 1", check: r => r.data[0].t === 'lice' },
        { name: "V3Fn: SUBSTRING FROM FOR", sql: "SELECT SUBSTRING('abcdef' FROM 2 FOR 3) AS s", check: r => r.data[0].s === 'bcd' },
        { name: "V3Fn: SUBSTRING FROM Only", sql: "SELECT SUBSTRING('abcdef' FROM 4) AS s", check: r => r.data[0].s === 'def' },
        { name: "V3Fn: SUBSTRING FROM On Table Column", sql: "SELECT SUBSTRING(name FROM 1 FOR 3) AS s FROM users WHERE id = 2", check: r => r.data[0].s === 'Bob' },
        { name: "V3Fn: DATE Literal Comparison", fn: () => {
            db.executeQuery("CREATE TABLE v3dt (id INTEGER, d DATE)");
            db.executeQuery("INSERT INTO v3dt (id, d) VALUES (1, '2026-01-02'), (2, '2026-01-03')");
            const r = db.executeQuery("SELECT id FROM v3dt WHERE d = DATE '2026-01-02'");
            const r2 = db.executeQuery("SELECT COUNT(*) AS c FROM v3dt WHERE d >= TIMESTAMP '2026-01-03 00:00:00'");
            db.executeQuery("DROP TABLE v3dt");
            return !r.error && r.data.length === 1 && r.data[0].id === 1 && r2.data[0].c === 1;
        }},
        { name: "V3Fn: FETCH FIRST ROWS ONLY", sql: "SELECT id FROM users ORDER BY id ASC FETCH FIRST 3 ROWS ONLY", check: r => r.data.length === 3 && r.data[2].id === 3 },
        { name: "V3Fn: OFFSET ROWS FETCH NEXT", sql: "SELECT id FROM users ORDER BY id ASC OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY", check: r => r.data.length === 2 && r.data[0].id === 3 && r.data[1].id === 4 },
        { name: "V3Fn: FETCH FIRST In Union", sql: "SELECT id FROM users WHERE id <= 2 UNION ALL SELECT id FROM users WHERE id >= 9 ORDER BY id ASC FETCH FIRST 3 ROWS ONLY", check: r => r.data.length === 3 && r.data[2].id === 9 },

        // ============================================================
        // 7. パーサ修正 (V3Fix)
        // ============================================================
        { name: "V3Fix: Nested CASE", sql: "SELECT CASE WHEN 1 = 1 THEN CASE WHEN 2 = 3 THEN 'x' ELSE 'inner' END ELSE 'outer' END AS v", check: r => r.data[0].v === 'inner' },
        { name: "V3Fix: Nested CASE Outer Else", sql: "SELECT CASE WHEN 1 = 2 THEN CASE WHEN 1 = 1 THEN 'x' END ELSE 'outer' END AS v", check: r => r.data[0].v === 'outer' },
        { name: "V3Fix: Nested Simple CASE", sql: "SELECT CASE 1 WHEN 1 THEN CASE 2 WHEN 2 THEN 'both' ELSE 'no' END ELSE 'neither' END AS v", check: r => r.data[0].v === 'both' },
        { name: "V3Fix: IN List With Function Call", sql: "SELECT COUNT(*) AS c FROM users WHERE id IN (ROUND(1.4), 2)", check: r => r.data[0].c === 2 },
        { name: "V3Fix: NOT IN List With Function Call", sql: "SELECT COUNT(*) AS c FROM users WHERE id NOT IN (ROUND(1.4), 2)", check: r => r.data[0].c === 8 },
        { name: "V3Fix: Union Order By Multi Col", sql: "SELECT id, name FROM users WHERE id <= 2 UNION SELECT id, name FROM users WHERE id BETWEEN 2 AND 3 ORDER BY name DESC, id ASC", check: r => r.data.length === 3 && r.data[0].name === 'Charlie' },

        // ============================================================
        // 8. 複合 UNIQUE / PRIMARY KEY (V3Cmp)
        // ============================================================
        { name: "V3Cmp: Create With Composite PK", sql: "CREATE TABLE v3cmp (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b))", check: r => r.data[0].Result === "Success" },
        { name: "V3Cmp: Distinct Tuples Insert OK", sql: "INSERT INTO v3cmp (a, b, v) VALUES (1, 1, 'x'), (1, 2, 'y'), (2, 1, 'z')", check: r => r.data[0].Message.includes('3') },
        errCase("V3Cmp: Duplicate Tuple Rejected", "INSERT INTO v3cmp (a, b, v) VALUES (1, 2, 'dup')", 'PRIMARY KEY constraint failed'),
        errCase("V3Cmp: NULL In Composite PK Rejected", "INSERT INTO v3cmp (a, b, v) VALUES (3, NULL, 'n')", 'NOT NULL'),
        errCase("V3Cmp: Batch Internal Duplicate Rejected", "INSERT INTO v3cmp (a, b, v) VALUES (5, 5, 'p'), (5, 5, 'q')", 'constraint failed'),
        errCase("V3Cmp: Update Into Conflict Rejected", "UPDATE v3cmp SET b = 2 WHERE a = 1 AND b = 1", 'PRIMARY KEY constraint failed'),
        { name: "V3Cmp: Update To Free Slot OK", sql: "UPDATE v3cmp SET b = 9 WHERE a = 2 AND b = 1", check: r => r.data[0].Message.includes('1 row updated') },
        { name: "V3Cmp: REPLACE On Composite Conflict", fn: () => {
            const r = db.executeQuery("REPLACE INTO v3cmp (a, b, v) VALUES (1, 2, 'replaced')");
            const q = db.executeQuery("SELECT v FROM v3cmp WHERE a = 1 AND b = 2");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v3cmp");
            return !r.error && q.data[0].v === 'replaced' && c.data[0].c === 3;
        }},
        { name: "V3Cmp: SHOW CREATE TABLE Includes Composite", fn: () => {
            const r = db.executeQuery("SHOW CREATE TABLE v3cmp");
            return !r.error && r.data[0].CreateTable.includes('PRIMARY KEY (a, b)');
        }},
        { name: "V3Cmp: IDB Roundtrip Keeps Composite", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(db.exportForIDB());
            const dup = eng2.executeQuery("INSERT INTO v3cmp (a, b, v) VALUES (1, 2, 'dup2')");
            const ok = eng2.executeQuery("INSERT INTO v3cmp (a, b, v) VALUES (8, 8, 'ok')");
            return dup.error !== undefined && dup.error.includes('PRIMARY KEY') && !ok.error;
        }},
        { name: "V3Cmp: DROP PRIMARY KEY Composite", fn: () => {
            const r = db.executeQuery("ALTER TABLE v3cmp DROP PRIMARY KEY");
            const dup = db.executeQuery("INSERT INTO v3cmp (a, b, v) VALUES (1, 2, 'now_ok')");
            return !r.error && r.data[0].Message.includes('dropped') && !dup.error;
        }},
        { name: "V3Cmp: Cleanup", sql: "DROP TABLE v3cmp", check: r => r.data[0].Result === "Success" },
        { name: "V3Cmp: Composite UNIQUE Allows NULLs", fn: () => {
            db.executeQuery("CREATE TABLE v3uq (a INTEGER, b INTEGER, UNIQUE (a, b))");
            const r1 = db.executeQuery("INSERT INTO v3uq (a, b) VALUES (1, 1), (1, NULL), (1, NULL)");
            const r2 = db.executeQuery("INSERT INTO v3uq (a, b) VALUES (1, 1)");
            return !r1.error && r2.error !== undefined && r2.error.includes('UNIQUE constraint failed');
        }},
        { name: "V3Cmp: ALTER ADD UNIQUE Composite Validates Data", fn: () => {
            db.executeQuery("CREATE TABLE v3uq2 (a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v3uq2 (a, b) VALUES (1, 1), (1, 1)");
            const bad = db.executeQuery("ALTER TABLE v3uq2 ADD UNIQUE (a, b)");
            db.executeQuery("DELETE FROM v3uq2 WHERE a = 1 LIMIT 1");
            const ok = db.executeQuery("ALTER TABLE v3uq2 ADD UNIQUE (a, b)");
            const dup = db.executeQuery("INSERT INTO v3uq2 (a, b) VALUES (1, 1)");
            return bad.error !== undefined && !ok.error && dup.error !== undefined;
        }},
        { name: "V3Cmp: DROP UNIQUE Composite", fn: () => {
            const r = db.executeQuery("ALTER TABLE v3uq2 DROP UNIQUE (a, b)");
            const ins = db.executeQuery("INSERT INTO v3uq2 (a, b) VALUES (1, 1)");
            db.executeQuery("DROP TABLE v3uq2, v3uq");
            return !r.error && !ins.error;
        }},
        { name: "V3Cmp: ALTER ADD Composite PK And Rollback", fn: () => {
            db.executeQuery("CREATE TABLE v3pk2 (a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v3pk2 (a, b) VALUES (1, 1)");
            db.executeQuery("BEGIN");
            const add = db.executeQuery("ALTER TABLE v3pk2 ADD PRIMARY KEY (a, b)");
            const during = db.executeQuery("INSERT INTO v3pk2 (a, b) VALUES (1, 1)"); // 違反
            db.executeQuery("ROLLBACK");
            const after = db.executeQuery("INSERT INTO v3pk2 (a, b) VALUES (1, 1)"); // 制約は消えている
            db.executeQuery("DROP TABLE v3pk2");
            return !add.error && during.error !== undefined && !after.error;
        }},

        // ============================================================
        // 9. CREATE TEMPORARY TABLE (V3Tmp)
        // ============================================================
        { name: "V3Tmp: Create And Persist Across Queries", fn: () => {
            const r = db.executeQuery("CREATE TEMPORARY TABLE v3tmp (id INTEGER)");
            db.executeQuery("INSERT INTO v3tmp (id) VALUES (1), (2)");
            const q = db.executeQuery("SELECT COUNT(*) AS c FROM v3tmp");
            return !r.error && q.data[0].c === 2;
        }},
        { name: "V3Tmp: SHOW TABLES Marks Temp", fn: () => {
            const r = db.executeQuery("SHOW TABLES");
            const row = r.data.find(d => d.Table === 'v3tmp');
            const usersRow = r.data.find(d => d.Table === 'users');
            return !!row && row.Temp === true && usersRow.Temp === false;
        }},
        { name: "V3Tmp: Excluded From IDB Dump", fn: () => {
            const dump = db.exportForIDB();
            return dump.v3tmp === undefined && dump.users !== undefined;
        }},
        { name: "V3Tmp: Excluded From SQL Export", fn: () => {
            const sqlText = db.exportSQL();
            return !sqlText.includes('v3tmp') && sqlText.includes('CREATE TABLE users');
        }},
        { name: "V3Tmp: SHOW CREATE Includes TEMPORARY", fn: () => {
            const r = db.executeQuery("SHOW CREATE TABLE v3tmp");
            return !r.error && r.data[0].CreateTable.startsWith('CREATE TEMPORARY TABLE');
        }},
        { name: "V3Tmp: Temporary CTAS", fn: () => {
            const r = db.executeQuery("CREATE TEMPORARY TABLE v3tmp2 AS SELECT id FROM users WHERE id <= 3");
            const q = db.executeQuery("SELECT COUNT(*) AS c FROM v3tmp2");
            const dump = db.exportForIDB();
            db.executeQuery("DROP TABLE v3tmp2");
            return !r.error && q.data[0].c === 3 && dump.v3tmp2 === undefined;
        }},
        { name: "V3Tmp: Cleanup", sql: "DROP TABLE v3tmp", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 10. API CRUD ヘルパー (V3Api)
        // ============================================================
        { name: "V3Api: select With Where And Columns", fn: () => {
            const r = LuminaDB.select('users', { columns: ['id', 'name'], where: { age: 25 } });
            return !r.error && r.data.length === 1 && r.data[0].id === 1 && r.data[0].name === 'Alice' && r.data[0].age === undefined;
        }},
        { name: "V3Api: select With OrderBy And Limit", fn: () => {
            const r = LuminaDB.select('users', { orderBy: 'age DESC', limit: 2 });
            return !r.error && r.data.length === 2 && r.data[0].name === 'Frank';
        }},
        { name: "V3Api: select Invalid OrderBy Rejected", fn: () => {
            const r = LuminaDB.select('users', { orderBy: 'age; DROP TABLE users' });
            const still = db.executeQuery("SELECT COUNT(*) AS c FROM users");
            return r.error !== undefined && r.error.includes('Invalid orderBy') && still.data[0].c === 10;
        }},
        { name: "V3Api: select Where Null Matches IS NULL", fn: () => {
            db.executeQuery("CREATE TABLE v3api (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO v3api (id, v) VALUES (1, 10), (2, NULL)");
            const r = LuminaDB.select('v3api', { where: { v: null } });
            return !r.error && r.data.length === 1 && r.data[0].id === 2;
        }},
        { name: "V3Api: count", fn: () => {
            const all = LuminaDB.count('v3api');
            const some = LuminaDB.count('v3api', { id: 1 });
            return !all.error && all.count === 2 && !some.error && some.count === 1;
        }},
        { name: "V3Api: update Requires Where", fn: () => {
            const r = LuminaDB.update('v3api', { v: 0 });
            return r.error !== undefined && r.error.includes('requires a where');
        }},
        { name: "V3Api: update With Where", fn: () => {
            const r = LuminaDB.update('v3api', { v: 99 }, { id: 1 });
            const q = db.executeQuery("SELECT v FROM v3api WHERE id = 1");
            return !r.error && q.data[0].v === 99;
        }},
        { name: "V3Api: update All With Explicit Null", fn: () => {
            const r = LuminaDB.update('v3api', { v: 5 }, null);
            const q = db.executeQuery("SELECT COUNT(*) AS c FROM v3api WHERE v = 5");
            return !r.error && q.data[0].c === 2;
        }},
        { name: "V3Api: remove And Delete Alias", fn: () => {
            const r1 = LuminaDB.remove('v3api', { id: 1 });
            const r2 = LuminaDB.delete('v3api', { id: 2 });
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v3api");
            db.executeQuery("DROP TABLE v3api");
            return !r1.error && !r2.error && c.data[0].c === 0;
        }},
        { name: "V3Api: remove Requires Where", fn: () => {
            const r = LuminaDB.remove('users');
            const still = db.executeQuery("SELECT COUNT(*) AS c FROM users");
            return r.error !== undefined && r.error.includes('requires a where') && still.data[0].c === 10;
        }},
        { name: "V3Api: Invalid Column In Where Rejected", fn: () => {
            const r = LuminaDB.select('users', { where: { 'id; --': 1 } });
            return r.error !== undefined && r.error.includes('Invalid column name');
        }},

        // ============================================================
        // 11. SHOW CHECKS (V3Show)
        // ============================================================
        { name: "V3Show: SHOW CHECKS Lists Constraints", fn: () => {
            db.executeQuery("CREATE TABLE v3chk (age INTEGER, CONSTRAINT age_pos CHECK (age > 0))");
            const r = db.executeQuery("SHOW CHECKS FROM v3chk");
            const all = db.executeQuery("SHOW CHECKS");
            db.executeQuery("DROP TABLE v3chk");
            return !r.error && r.data.length === 1 && r.data[0].Name === 'age_pos' && r.data[0].Expression.includes('age > 0')
                && !all.error && all.data.some(d => d.Table === 'v3chk');
        }}
      ];
    }
