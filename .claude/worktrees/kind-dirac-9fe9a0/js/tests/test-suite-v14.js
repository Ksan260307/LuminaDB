    // ============================================================================
    // [Test Suite v14] - v1.12 機能追加の回帰テスト
    //   1. FULL OUTER JOIN / OUTER キーワード
    //   2. GROUPING SETS / CUBE
    //   3. PIVOT / UNPIVOT
    //   4. CROSS APPLY / OUTER APPLY / LATERAL
    //   5. IS [NOT] DISTINCT FROM / <=> / 量化比較 ANY・SOME・ALL
    //   6. WITHIN GROUP (ORDER BY) / RANGE・GROUPS ウィンドウフレーム
    //   7. SELECT INTO / MATERIALIZED VIEW / COMMENT ON / IDENTITY / セッション文
    //   8. ブラウザDB運用: SHOW STORAGE / ストレージAPI / マルチタブ同期
    //   test-suite.js の tests 配列へ getV14Tests() のスプレッドで合流する
    // ============================================================================
    function getV14Tests() {
      return [
        // ---- 準備 ----
        { name: "V14Setup: Drop Old", fn: () => {
            ['fj_l', 'fj_r', 'gs_t', 'pv_t', 'up_t', 'ap_t', 'nd_t', 'wg_t', 'mv_src', 'idn_t'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
            return true;
        }},

        // ============================================================
        // 1. FULL OUTER JOIN
        // ============================================================
        successCase("V14Join: Create L", "CREATE TABLE fj_l (id INTEGER, lv TEXT)"),
        successCase("V14Join: Create R", "CREATE TABLE fj_r (id INTEGER, rv TEXT)"),
        { name: "V14Join: Seed L", sql: "INSERT INTO fj_l (id, lv) VALUES (1, 'a'), (2, 'b'), (3, 'c')", check: r => r.data[0].Message.includes('3') },
        { name: "V14Join: Seed R", sql: "INSERT INTO fj_r (id, rv) VALUES (2, 'B'), (3, 'C'), (4, 'D')", check: r => r.data[0].Message.includes('3') },
        { name: "V14Join: Inner Baseline", sql: "SELECT COUNT(*) AS c FROM fj_l l JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 2 },
        { name: "V14Join: Left Baseline", sql: "SELECT COUNT(*) AS c FROM fj_l l LEFT JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 3 },
        { name: "V14Join: Right Baseline", sql: "SELECT COUNT(*) AS c FROM fj_l l RIGHT JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 3 },
        { name: "V14Join: Full Outer Count", sql: "SELECT COUNT(*) AS c FROM fj_l l FULL OUTER JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 4 },
        { name: "V14Join: Full Join No Outer Kw", sql: "SELECT COUNT(*) AS c FROM fj_l l FULL JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 4 },
        { name: "V14Join: Full Outer Left-only Row", sql: "SELECT COUNT(*) AS c FROM fj_l l FULL OUTER JOIN fj_r r ON l.id = r.id WHERE r.id IS NULL", check: r => r.data[0].c === 1 },
        { name: "V14Join: Full Outer Right-only Row", sql: "SELECT COUNT(*) AS c FROM fj_l l FULL OUTER JOIN fj_r r ON l.id = r.id WHERE l.id IS NULL", check: r => r.data[0].c === 1 },
        { name: "V14Join: Full Outer Values", sql: "SELECT l.lv AS lv, r.rv AS rv FROM fj_l l FULL OUTER JOIN fj_r r ON l.id = r.id ORDER BY lv", check: r => {
            const pairs = r.data.map(x => `${x.lv === null ? '-' : x.lv}/${x.rv === null ? '-' : x.rv}`).sort().join(',');
            return pairs === '-/D,a/-,b/B,c/C';
        }},
        { name: "V14Join: Left Outer Keyword", sql: "SELECT COUNT(*) AS c FROM fj_l l LEFT OUTER JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 3 },
        { name: "V14Join: Right Outer Keyword", sql: "SELECT COUNT(*) AS c FROM fj_l l RIGHT OUTER JOIN fj_r r ON l.id = r.id", check: r => r.data[0].c === 3 },
        { name: "V14Join: Full Outer Non-Equi", sql: "SELECT COUNT(*) AS c FROM fj_l l FULL OUTER JOIN fj_r r ON l.id > r.id", check: r => r.data.length === 1 && r.data[0].c >= 3 },

        // ============================================================
        // 2. GROUPING SETS / CUBE
        // ============================================================
        successCase("V14Grp: Create", "CREATE TABLE gs_t (reg TEXT, prod TEXT, amt INTEGER)"),
        { name: "V14Grp: Seed", sql: "INSERT INTO gs_t (reg, prod, amt) VALUES ('E', 'x', 10), ('E', 'y', 20), ('W', 'x', 30), ('W', 'y', 40)", check: r => r.data[0].Message.includes('4') },
        { name: "V14Grp: Rollup Baseline", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY ROLLUP(reg, prod)", check: r => r.data.length === 7 },
        { name: "V14Grp: Cube Row Count", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg, prod)", check: r => r.data.length === 9 },
        { name: "V14Grp: Cube Grand Total", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg, prod)", check: r => r.data.some(x => x.reg === null && x.prod === null && x.s === 100) },
        { name: "V14Grp: Cube Prod Subtotal", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg, prod)", check: r => r.data.some(x => x.reg === null && x.prod === 'x' && x.s === 40) },
        { name: "V14Grp: Cube Reg Subtotal", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg, prod)", check: r => r.data.some(x => x.reg === 'E' && x.prod === null && x.s === 30) },
        { name: "V14Grp: Grouping Sets Count", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY GROUPING SETS ((reg), (prod), ())", check: r => r.data.length === 5 },
        { name: "V14Grp: Grouping Sets Reg", sql: "SELECT reg, SUM(amt) AS s FROM gs_t GROUP BY GROUPING SETS ((reg), ())", check: r => r.data.length === 3 && r.data.some(x => x.reg === null && x.s === 100) },
        { name: "V14Grp: Grouping Sets Pair", sql: "SELECT reg, prod, SUM(amt) AS s FROM gs_t GROUP BY GROUPING SETS ((reg, prod))", check: r => r.data.length === 4 },
        { name: "V14Grp: Grouping Fn With Cube", sql: "SELECT reg, GROUPING(reg) AS g, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg)", check: r => r.data.some(x => x.g === 1 && x.s === 100) && r.data.some(x => x.g === 0) },
        { name: "V14Grp: Cube Single Col", sql: "SELECT reg, SUM(amt) AS s FROM gs_t GROUP BY CUBE(reg)", check: r => r.data.length === 3 },
        { name: "V14Grp: Grouping Sets Empty Only", sql: "SELECT SUM(amt) AS s FROM gs_t GROUP BY GROUPING SETS ((reg), ())", check: r => r.data.length === 3 },

        // ============================================================
        // 3. PIVOT / UNPIVOT
        // ============================================================
        successCase("V14Pv: Create", "CREATE TABLE pv_t (reg TEXT, q TEXT, amt INTEGER)"),
        { name: "V14Pv: Seed", sql: "INSERT INTO pv_t (reg, q, amt) VALUES ('E', 'Q1', 10), ('E', 'Q2', 20), ('W', 'Q1', 30), ('W', 'Q2', 40)", check: r => r.data[0].Message.includes('4') },
        { name: "V14Pv: Pivot Rows", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1', 'Q2')) p ORDER BY reg", check: r => r.data.length === 2 },
        { name: "V14Pv: Pivot Values", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1', 'Q2')) p ORDER BY reg", check: r => r.data[0].reg === 'E' && r.data[0].q1 === 10 && r.data[0].q2 === 20 },
        { name: "V14Pv: Pivot Second Row", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1', 'Q2')) p ORDER BY reg", check: r => r.data[1].reg === 'W' && r.data[1].q1 === 30 && r.data[1].q2 === 40 },
        { name: "V14Pv: Pivot Alias Names", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1' AS first_q, 'Q2' AS second_q)) p ORDER BY reg", check: r => r.data[0].first_q === 10 && r.data[0].second_q === 20 },
        { name: "V14Pv: Pivot Count Agg", sql: "SELECT * FROM pv_t PIVOT (COUNT(amt) FOR q IN ('Q1')) p ORDER BY reg", check: r => r.data[0].q1 === 1 },
        // 該当行が無い列は空集合の SUM となり、本エンジンでは 0 を返す（MySQL は NULL）
        { name: "V14Pv: Pivot Missing Value Empty Sum", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1', 'Q9')) p ORDER BY reg", check: r => r.data[0].q9 === 0 && r.data[0].q1 === 10 },
        { name: "V14Pv: Pivot Then Where", sql: "SELECT * FROM pv_t PIVOT (SUM(amt) FOR q IN ('Q1', 'Q2')) p WHERE reg = 'W'", check: r => r.data.length === 1 && r.data[0].q1 === 30 },
        successCase("V14Pv: Unpivot Create", "CREATE TABLE up_t (reg TEXT, q1 INTEGER, q2 INTEGER)"),
        { name: "V14Pv: Unpivot Seed", sql: "INSERT INTO up_t (reg, q1, q2) VALUES ('E', 10, 20), ('W', 30, NULL)", check: r => r.data[0].Message.includes('2') },
        { name: "V14Pv: Unpivot Rows", sql: "SELECT * FROM up_t UNPIVOT (amt FOR q IN (q1, q2)) u", check: r => r.data.length === 3 },
        { name: "V14Pv: Unpivot Values", sql: "SELECT * FROM up_t UNPIVOT (amt FOR q IN (q1, q2)) u ORDER BY reg, q", check: r => r.data[0].reg === 'E' && r.data[0].q === 'q1' && r.data[0].amt === 10 },
        { name: "V14Pv: Unpivot Skips Null", sql: "SELECT COUNT(*) AS c FROM up_t UNPIVOT (amt FOR q IN (q1, q2)) u WHERE reg = 'W'", check: r => r.data[0].c === 1 },
        { name: "V14Pv: Unpivot Sum", sql: "SELECT SUM(amt) AS s FROM up_t UNPIVOT (amt FOR q IN (q1, q2)) u", check: r => r.data[0].s === 60 },
        // UNPIVOT の IN は「列名」、PIVOT の IN は「列 q に入る値」なので後者は文字列リテラル
        { name: "V14Pv: Pivot Roundtrip", sql: "SELECT * FROM (SELECT * FROM up_t UNPIVOT (amt FOR q IN (q1, q2)) u) s PIVOT (SUM(amt) FOR q IN ('q1', 'q2')) p ORDER BY reg", check: r => r.data.length === 2 && r.data[0].q1 === 10 && r.data[0].q2 === 20 },

        // ============================================================
        // 4. CROSS APPLY / OUTER APPLY / LATERAL
        // ============================================================
        { name: "V14Ap: Cross Apply Count", sql: "SELECT u.name AS name, x.c AS c FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x ORDER BY name", check: r => r.data.length === 10 },
        { name: "V14Ap: Cross Apply Value", sql: "SELECT u.name AS name, x.c AS c FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x WHERE name = 'Alice'", check: r => r.data[0].c === 2 },
        { name: "V14Ap: Cross Apply Drops Empty", sql: "SELECT u.name AS name, x.oid AS oid FROM users u CROSS APPLY (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id) x", check: r => r.data.length === 5 },
        { name: "V14Ap: Outer Apply Keeps Empty", sql: "SELECT u.name AS name, x.oid AS oid FROM users u OUTER APPLY (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id) x", check: r => r.data.length === 11 },
        { name: "V14Ap: Outer Apply Null Fill", sql: "SELECT u.name AS name, x.oid AS oid FROM users u OUTER APPLY (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id) x WHERE oid IS NULL", check: r => r.data.length === 6 },
        { name: "V14Ap: Lateral Basic", sql: "SELECT u.name AS name, x.dbl AS dbl FROM users u, LATERAL (SELECT u.age * 2 AS dbl) x WHERE name = 'Bob'", check: r => r.data[0].dbl === 60 },
        { name: "V14Ap: Apply With Order Limit", sql: "SELECT u.name AS name, x.c AS c FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x ORDER BY c DESC LIMIT 1", check: r => r.data[0].c === 2 },
        { name: "V14Ap: Apply Aggregate Over Result", sql: "SELECT SUM(x.c) AS total FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x", check: r => r.data[0].total === 5 },

        // ============================================================
        // 5. IS DISTINCT FROM / <=> / 量化比較
        // ============================================================
        successCase("V14Nd: Create", "CREATE TABLE nd_t (a INTEGER, b INTEGER)"),
        { name: "V14Nd: Seed", sql: "INSERT INTO nd_t (a, b) VALUES (1, 1), (1, 2), (NULL, 1), (NULL, NULL)", check: r => r.data[0].Message.includes('4') },
        { name: "V14Nd: Distinct From Count", sql: "SELECT COUNT(*) AS c FROM nd_t WHERE a IS DISTINCT FROM b", check: r => r.data[0].c === 2 },
        { name: "V14Nd: Not Distinct From Count", sql: "SELECT COUNT(*) AS c FROM nd_t WHERE a IS NOT DISTINCT FROM b", check: r => r.data[0].c === 2 },
        { name: "V14Nd: Distinct From Literal Null", sql: "SELECT COUNT(*) AS c FROM nd_t WHERE a IS NOT DISTINCT FROM NULL", check: r => r.data[0].c === 2 },
        { name: "V14Nd: Null Safe Equal Op", sql: "SELECT COUNT(*) AS c FROM nd_t WHERE a <=> b", check: r => r.data[0].c === 2 },
        { name: "V14Nd: Const Distinct True", sql: "SELECT 1 IS DISTINCT FROM 2 AS a", check: r => r.data[0].a === true },
        { name: "V14Nd: Const Distinct False", sql: "SELECT 1 IS DISTINCT FROM 1 AS a", check: r => r.data[0].a === false },
        { name: "V14Nd: Const Null Not Distinct", sql: "SELECT NULL IS NOT DISTINCT FROM NULL AS a", check: r => r.data[0].a === true },
        // ages=[25,30,...] の最小 25 より大きい行数 = 7（> ANY は最小値との比較と等価）
        { name: "V14Qt: Gt Any", sql: "SELECT COUNT(*) AS c FROM users WHERE age > ANY (SELECT age FROM users WHERE id <= 2)", check: r => r.data[0].c === 7 },
        { name: "V14Qt: Gt All", sql: "SELECT COUNT(*) AS c FROM users WHERE age > ALL (SELECT age FROM users WHERE id <= 2)", check: r => r.data[0].c === 3 },
        { name: "V14Qt: Eq Any Literal", sql: "SELECT COUNT(*) AS c FROM users WHERE age = ANY (25, 30, 40)", check: r => r.data[0].c === 3 },
        { name: "V14Qt: Eq Some Literal", sql: "SELECT COUNT(*) AS c FROM users WHERE age = SOME (25, 30)", check: r => r.data[0].c === 2 },
        { name: "V14Qt: Lt All Literal", sql: "SELECT COUNT(*) AS c FROM users WHERE age < ALL (23, 24)", check: r => r.data[0].c === 1 },
        { name: "V14Qt: Ne All Literal", sql: "SELECT COUNT(*) AS c FROM users WHERE age <> ALL (25, 30)", check: r => r.data[0].c === 8 },
        // stock=0 は Router(400) のみ。price >= 400 は 1500/800/400 の 3 件
        { name: "V14Qt: Ge Any Subquery", sql: "SELECT COUNT(*) AS c FROM products WHERE price >= ANY (SELECT price FROM products WHERE stock = 0)", check: r => r.data[0].c === 3 },

        // ============================================================
        // 6. WITHIN GROUP / RANGE・GROUPS フレーム
        // ============================================================
        successCase("V14Wg: Create", "CREATE TABLE wg_t (g TEXT, v INTEGER)"),
        { name: "V14Wg: Seed", sql: "INSERT INTO wg_t (g, v) VALUES ('a', 1), ('a', 2), ('a', 3), ('a', 4), ('b', 10), ('b', 20)", check: r => r.data[0].Message.includes('6') },
        { name: "V14Wg: Percentile Cont Median", sql: "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v) AS p FROM wg_t WHERE g = 'a'", check: r => Math.abs(r.data[0].p - 2.5) < 1e-9 },
        { name: "V14Wg: Percentile Disc", sql: "SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY v) AS p FROM wg_t WHERE g = 'a'", check: r => r.data[0].p === 2 || r.data[0].p === 3 },
        { name: "V14Wg: Percentile Grouped", sql: "SELECT g, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v) AS p FROM wg_t GROUP BY g ORDER BY g", check: r => r.data.length === 2 && Math.abs(r.data[1].p - 15) < 1e-9 },
        { name: "V14Wg: Listagg Within Group", sql: "SELECT LISTAGG(v, '-') WITHIN GROUP (ORDER BY v DESC) AS s FROM wg_t WHERE g = 'a'", check: r => r.data[0].s === '4-3-2-1' },
        { name: "V14Wg: Listagg Within Group Asc", sql: "SELECT LISTAGG(v, ',') WITHIN GROUP (ORDER BY v) AS s FROM wg_t WHERE g = 'a'", check: r => r.data[0].s === '1,2,3,4' },
        { name: "V14Fr: Rows Frame Baseline", sql: "SELECT v, SUM(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM wg_t WHERE g = 'a' ORDER BY v", check: r => r.data[3].s === 10 },
        { name: "V14Fr: Range Unbounded Current", sql: "SELECT v, SUM(v) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM wg_t WHERE g = 'a' ORDER BY v", check: r => r.data[3].s === 10 },
        { name: "V14Fr: Range Peer Semantics", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS fr_p");
            db.executeQuery("CREATE TABLE fr_p (v INTEGER)");
            db.executeQuery("INSERT INTO fr_p (v) VALUES (1), (1), (2)");
            // RANGE の CURRENT ROW は同値ピア全体を含むので、v=1 の行は両方 1+1=2 になる
            const r = db.executeQuery("SELECT v, SUM(v) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM fr_p ORDER BY v");
            const ok = r.data[0].s === 2 && r.data[1].s === 2 && r.data[2].s === 4;
            db.executeQuery("DROP TABLE IF EXISTS fr_p");
            return ok;
        }},
        { name: "V14Fr: Rows Differs From Range On Peers", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS fr_p2");
            db.executeQuery("CREATE TABLE fr_p2 (v INTEGER)");
            db.executeQuery("INSERT INTO fr_p2 (v) VALUES (1), (1), (2)");
            // ROWS は物理行なので 1 行目は 1、2 行目は 2
            const r = db.executeQuery("SELECT v, SUM(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM fr_p2 ORDER BY v");
            const ok = r.data[0].s === 1 && r.data[1].s === 2;
            db.executeQuery("DROP TABLE IF EXISTS fr_p2");
            return ok;
        }},
        { name: "V14Fr: Range Numeric Offset", sql: "SELECT v, SUM(v) OVER (ORDER BY v RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS s FROM wg_t WHERE g = 'a' ORDER BY v", check: r => r.data[0].s === 3 && r.data[1].s === 6 },
        { name: "V14Fr: Groups Frame", sql: "SELECT v, SUM(v) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM wg_t WHERE g = 'a' ORDER BY v", check: r => r.data[0].s === 1 && r.data[1].s === 3 && r.data[2].s === 5 },
        errCase("V14Fr: Range Requires Order By", "SELECT SUM(v) OVER (RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM wg_t", 'RANGE'),
        errCase("V14Fr: Range Offset Single Order Col", "SELECT SUM(v) OVER (ORDER BY g, v RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM wg_t", 'exactly one ORDER BY'),
        { name: "V14Fr: Groups With Partition", sql: "SELECT g, v, SUM(v) OVER (PARTITION BY g ORDER BY v GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM wg_t ORDER BY g, v", check: r => r.data[0].s === 1 && r.data[4].s === 10 },

        // ============================================================
        // 7. SELECT INTO / MATERIALIZED VIEW / COMMENT ON / IDENTITY / セッション文
        // ============================================================
        successCase("V14Into: Select Into", "SELECT id, name INTO si_t FROM users WHERE age >= 30"),
        { name: "V14Into: Verify Rows", sql: "SELECT COUNT(*) AS c FROM si_t", check: r => r.data[0].c === 4 },
        { name: "V14Into: Verify Cols", sql: "SELECT * FROM si_t LIMIT 1", check: r => Object.keys(r.data[0]).length === 2 && 'name' in r.data[0] },
        errCase("V14Into: Duplicate Rejected", "SELECT id INTO si_t FROM users", 'already exists'),
        { name: "V14Into: Cleanup", sql: "DROP TABLE si_t", check: r => true },

        successCase("V14Mv: Source", "CREATE TABLE mv_src (id INTEGER, v INTEGER)"),
        { name: "V14Mv: Seed", sql: "INSERT INTO mv_src (id, v) VALUES (1, 10), (2, 20)", check: r => r.data[0].Message.includes('2') },
        successCase("V14Mv: Create MatView", "CREATE MATERIALIZED VIEW mv_a AS SELECT id, v * 2 AS dbl FROM mv_src"),
        { name: "V14Mv: Query MatView", sql: "SELECT SUM(dbl) AS s FROM mv_a", check: r => r.data[0].s === 60 },
        { name: "V14Mv: Stale After Insert", fn: () => {
            db.executeQuery("INSERT INTO mv_src (id, v) VALUES (3, 30)");
            const r = db.executeQuery("SELECT SUM(dbl) AS s FROM mv_a");
            return r.data[0].s === 60; // 自動更新されない（マテビューの本質）
        }},
        { name: "V14Mv: Refresh Updates", fn: () => {
            db.executeQuery("REFRESH MATERIALIZED VIEW mv_a");
            const r = db.executeQuery("SELECT SUM(dbl) AS s FROM mv_a");
            return r.data[0].s === 120;
        }},
        { name: "V14Mv: Show Materialized Views", sql: "SHOW MATERIALIZED VIEWS", check: r => r.data.some(x => x.View === 'mv_a' && x.Rows === 3) },
        errCase("V14Mv: Duplicate Rejected", "CREATE MATERIALIZED VIEW mv_a AS SELECT 1 AS x", 'already exists'),
        { name: "V14Mv: If Not Exists", sql: "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_a AS SELECT 1 AS x", check: r => r.data[0].Message.includes('Skipped') },
        errCase("V14Mv: Refresh Unknown", "REFRESH MATERIALIZED VIEW mv_zzz", 'not found'),
        successCase("V14Mv: Drop", "DROP MATERIALIZED VIEW mv_a"),
        errCase("V14Mv: Gone After Drop", "SELECT * FROM mv_a"),
        { name: "V14Mv: Drop If Exists", sql: "DROP MATERIALIZED VIEW IF EXISTS mv_a", check: r => r.data[0].Message.includes('Skipped') },

        successCase("V14Cm: Comment On Table", "COMMENT ON TABLE mv_src IS 'source table'"),
        successCase("V14Cm: Comment On Column", "COMMENT ON COLUMN mv_src.v IS 'the value'"),
        { name: "V14Cm: Show Comments", sql: "SHOW COMMENTS", check: r => r.data.some(x => x.Object === 'mv_src' && x.Comment === 'source table') && r.data.some(x => x.Object === 'mv_src.v') },
        errCase("V14Cm: Comment Unknown Table", "COMMENT ON TABLE nope_zzz IS 'x'"),
        errCase("V14Cm: Comment Unknown Column", "COMMENT ON COLUMN mv_src.nope IS 'x'", 'not found'),
        { name: "V14Cm: Remove Comment", fn: () => {
            db.executeQuery("COMMENT ON TABLE mv_src IS NULL");
            const r = db.executeQuery("SHOW COMMENTS");
            return !r.data.some(x => x.Object === 'mv_src' && x.Kind === 'TABLE');
        }},

        successCase("V14Id: Identity Column", "CREATE TABLE idn_t (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nm TEXT)"),
        { name: "V14Id: Identity Autonumbers", fn: () => {
            db.executeQuery("INSERT INTO idn_t (nm) VALUES ('a'), ('b')");
            const r = db.executeQuery("SELECT id FROM idn_t ORDER BY id");
            return r.data.length === 2 && r.data[0].id === 1 && r.data[1].id === 2;
        }},
        { name: "V14Id: Identity By Default", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS idn2");
            db.executeQuery("CREATE TABLE idn2 (id INTEGER GENERATED BY DEFAULT AS IDENTITY, v TEXT)");
            db.executeQuery("INSERT INTO idn2 (v) VALUES ('x')");
            const r = db.executeQuery("SELECT id FROM idn2");
            db.executeQuery("DROP TABLE IF EXISTS idn2");
            return r.data[0].id === 1;
        }},
        { name: "V14Id: SQL Server IDENTITY(1,1)", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS idn3");
            db.executeQuery("CREATE TABLE idn3 (id INTEGER IDENTITY(1,1), v TEXT)");
            db.executeQuery("INSERT INTO idn3 (v) VALUES ('x'), ('y')");
            const r = db.executeQuery("SELECT id FROM idn3 ORDER BY id");
            db.executeQuery("DROP TABLE IF EXISTS idn3");
            return r.data.length === 2 && r.data[1].id === 2;
        }},
        errCase("V14Id: Non-default Seed Rejected", "CREATE TABLE idn4 (id INTEGER GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 1))", 'non-default seed'),
        { name: "V14Id: Truncate Restart Identity", fn: () => {
            db.executeQuery("TRUNCATE TABLE idn_t RESTART IDENTITY");
            db.executeQuery("INSERT INTO idn_t (nm) VALUES ('c')");
            const r = db.executeQuery("SELECT id FROM idn_t");
            return r.data.length === 1 && r.data[0].id === 1;
        }},
        // v1.20: CONTINUE IDENTITY は採番下限を覚えて継続するようになった（旧: 明示エラー）
        { name: "V14Id: Truncate Continue Identity Keeps Numbering", fn: () => {
            db.executeQuery("CREATE TABLE v14_ci (id INTEGER AUTO_INCREMENT, v TEXT)");
            db.executeQuery("INSERT INTO v14_ci (v) VALUES ('a'), ('b'), ('c')");
            const t = db.executeQuery("TRUNCATE TABLE v14_ci CONTINUE IDENTITY");
            db.executeQuery("INSERT INTO v14_ci (v) VALUES ('z')");
            const kept = db.executeQuery("SELECT id FROM v14_ci").data[0].id;
            db.executeQuery("TRUNCATE TABLE v14_ci RESTART IDENTITY");
            db.executeQuery("INSERT INTO v14_ci (v) VALUES ('y')");
            const reset = db.executeQuery("SELECT id FROM v14_ci").data[0].id;
            db.executeQuery("DROP TABLE v14_ci");
            return !t.error && t.data[0].Message.includes('identity continues at 4') && kept === 4 && reset === 1;
        }},

        successCase("V14Se: Set Isolation Level", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"),
        { name: "V14Se: Show Settings", sql: "SHOW SETTINGS", check: r => r.data.some(x => x.Setting === 'isolation_level' && x.Value === 'READ COMMITTED') && r.data.some(x => x.Setting === 'effective_isolation') },
        successCase("V14Se: Set Serializable", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"),
        successCase("V14Se: Lock Table No-op", "LOCK TABLES users READ"),
        successCase("V14Se: Unlock Tables", "UNLOCK TABLES"),
        successCase("V14Se: Grant No-op", "GRANT SELECT ON users TO someone"),
        successCase("V14Se: Revoke No-op", "REVOKE SELECT ON users FROM someone"),
        successCase("V14Se: Analyze No-op", "ANALYZE"),
        { name: "V14Se: Analyze Table Still Works", sql: "ANALYZE TABLE users", check: r => r.data.length >= 1 },
        { name: "V14Se: Discard Clears Vars", fn: () => {
            db.executeQuery("SET @tmpvar = 5");
            db.executeQuery("DISCARD ALL");
            return Object.keys(db.userVars).length === 0;
        }},

        // ============================================================
        // 8. ブラウザDB運用: SHOW STORAGE / ストレージAPI
        // ============================================================
        { name: "V14Br: Show Storage Metrics", sql: "SHOW STORAGE", check: r => {
            const m = {}; r.data.forEach(x => m[x.Metric] = x.Value);
            return m.tables !== undefined && Number(m.rows) > 0 && Number(m.estimated_bytes) > 0;
        }},
        { name: "V14Br: Show Storage Has MB", sql: "SHOW STORAGE", check: r => r.data.some(x => x.Metric === 'estimated_mb' && Number(x.Value) >= 0) },
        { name: "V14Br: Show Storage Counts Objects", sql: "SHOW STORAGE", check: r => r.data.some(x => x.Metric === 'materialized_views') && r.data.some(x => x.Metric === 'sequences') },
        { name: "V14Br: Storage API", fn: async () => {
            const s = await LuminaDB.storage();
            return typeof s === 'object' && typeof s.supported === 'boolean' && typeof s.estimatedBytes === 'number' && s.estimatedBytes > 0;
        }},
        { name: "V14Br: Storage API Reports Quota", fn: async () => {
            const s = await LuminaDB.storage();
            // 実ブラウザでは estimate() が使える。未対応環境では supported:false で null
            return s.supported ? (typeof s.usage === 'number' && typeof s.quota === 'number' && s.quota > 0) : (s.usage === null);
        }},
        { name: "V14Br: Persist API Shape", fn: async () => {
            const p = await LuminaDB.persist();
            return typeof p === 'object' && typeof p.granted === 'boolean';
        }},
        { name: "V14Br: Broadcast Channel Wired", fn: () => {
            // マルチタブ同期のチャンネルが張られていること（未対応環境では機能を無効化）
            return typeof BroadcastChannel === 'undefined' || typeof broadcastSaved === 'function';
        }},
        { name: "V14Br: Quota Error Message Mapped", fn: () => {
            // saveDB がクォータ超過を分かる文言へ変換していること（実装の存在確認）
            // v1.15 で保存本体は saveDBLocked へ切り出された（Web Locks で直列化するため）
            const src = saveDB.toString() + (typeof saveDBLocked === 'function' ? saveDBLocked.toString() : '');
            return /QuotaExceededError/.test(src) && /ストレージ上限/.test(src);
        }},
        { name: "V14Br: Storage Info Helper", fn: async () => {
            const i = await getStorageInfo();
            return typeof i.supported === 'boolean' && ('usage' in i) && ('quota' in i) && ('persisted' in i);
        }},

        // ---- クリーンアップ ----
        { name: "V14Cleanup", fn: () => {
            ['fj_l', 'fj_r', 'gs_t', 'pv_t', 'up_t', 'nd_t', 'wg_t', 'mv_src', 'idn_t'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
            return true;
        }}
      ];
    }
