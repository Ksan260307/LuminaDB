    // ============================================================================
    // [Test Suite v5] - v1.4 機能追加・修正の回帰テスト
    //   1. V5Def : DEFAULT CURRENT_TIMESTAMP（挿入時評価・往復・表示）
    //   2. V5Join: JOIN ... USING (col, ...) / NATURAL JOIN
    //   3. V5Set : INTERSECT ALL / EXCEPT ALL（多重集合演算）
    //   4. V5Sug : テーブル / 列名タイプミスの Did-you-mean 提案
    //   5. V5Ui  : UI改善（複数文実行 / クエリ履歴 / ツリー拡張 / 補完キーワード）
    //              ※ V5Ui は実DOM・localStorage依存のためヘッドレスでは既知失敗
    //   test-suite.js の tests 配列へ getV5Tests() のスプレッドで合流する
    // ============================================================================
    function getV5Tests() {
      const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
      return [
        // ============================================================
        // 1. DEFAULT CURRENT_TIMESTAMP (V5Def)
        // ============================================================
        { name: "V5Def: Create And Auto Fill", fn: () => {
            db.executeQuery("CREATE TABLE v5def (id INTEGER, created DEFAULT CURRENT_TIMESTAMP)");
            db.executeQuery("INSERT INTO v5def (id) VALUES (1)");
            const r = db.executeQuery("SELECT created FROM v5def WHERE id = 1");
            return TS_RE.test(String(r.data[0].created)) && String(r.data[0].created).startsWith('20');
        }},
        { name: "V5Def: NOW() Form Accepted", fn: () => {
            db.executeQuery("CREATE TABLE v5def2 (id INTEGER, ts DEFAULT NOW())");
            db.executeQuery("INSERT INTO v5def2 (id) VALUES (1)");
            const r = db.executeQuery("SELECT ts FROM v5def2");
            db.executeQuery("DROP TABLE v5def2");
            return TS_RE.test(String(r.data[0].ts));
        }},
        { name: "V5Def: DEFAULT Keyword Resolves", fn: () => {
            db.executeQuery("INSERT INTO v5def (id, created) VALUES (2, DEFAULT)");
            const r = db.executeQuery("SELECT created FROM v5def WHERE id = 2");
            return TS_RE.test(String(r.data[0].created));
        }},
        { name: "V5Def: Explicit Value Wins", fn: () => {
            db.executeQuery("INSERT INTO v5def (id, created) VALUES (3, 'manual')");
            const r = db.executeQuery("SELECT created FROM v5def WHERE id = 3");
            return r.data[0].created === 'manual';
        }},
        { name: "V5Def: SHOW CREATE Includes Marker", fn: () => {
            const r = db.executeQuery("SHOW CREATE TABLE v5def");
            return r.data[0].CreateTable.includes('DEFAULT CURRENT_TIMESTAMP');
        }},
        { name: "V5Def: DESCRIBE Shows Marker", fn: () => {
            const r = db.executeQuery("DESCRIBE v5def");
            const row = r.data.find(d => d.Column === 'created');
            return row.Default === 'CURRENT_TIMESTAMP';
        }},
        { name: "V5Def: IDB Roundtrip Keeps Behavior", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(db.exportForIDB());
            eng2.executeQuery("INSERT INTO v5def (id) VALUES (10)");
            const r = eng2.executeQuery("SELECT created FROM v5def WHERE id = 10");
            return TS_RE.test(String(r.data[0].created));
        }},
        { name: "V5Def: SQL Export Reimport Works", fn: () => {
            const eng2 = new DatabaseEngine();
            const script = db.exportSQL();
            eng2.executeScript(script);
            eng2.executeQuery("INSERT INTO v5def (id) VALUES (99)");
            const r = eng2.executeQuery("SELECT created FROM v5def WHERE id = 99");
            return script.includes('DEFAULT CURRENT_TIMESTAMP') && TS_RE.test(String(r.data[0].created));
        }},
        { name: "V5Def: ALTER SET DEFAULT CURRENT_TIMESTAMP", fn: () => {
            db.executeQuery("CREATE TABLE v5def3 (id INTEGER, ts TEXT)");
            const a = db.executeQuery("ALTER TABLE v5def3 ALTER COLUMN ts SET DEFAULT CURRENT_TIMESTAMP");
            db.executeQuery("INSERT INTO v5def3 (id) VALUES (1)");
            const r = db.executeQuery("SELECT ts FROM v5def3");
            db.executeQuery("DROP TABLE v5def3");
            return !a.error && TS_RE.test(String(r.data[0].ts));
        }},
        { name: "V5Def: Cleanup", sql: "DROP TABLE v5def", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 2. JOIN USING / NATURAL JOIN (V5Join)
        // ============================================================
        { name: "V5Join: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v5a (id INTEGER, dept TEXT, x INTEGER)");
            db.executeQuery("CREATE TABLE v5b (id INTEGER, dept TEXT, y INTEGER)");
            db.executeQuery("CREATE TABLE v5c (p INTEGER, q INTEGER)");
            db.executeQuery("INSERT INTO v5a (id, dept, x) VALUES (1, 'd1', 10), (2, 'd2', 20), (3, 'd1', 30)");
            db.executeQuery("INSERT INTO v5b (id, dept, y) VALUES (1, 'd1', 100), (2, 'd9', 200), (4, 'd1', 400)");
            db.executeQuery("INSERT INTO v5c (p, q) VALUES (7, 70), (8, 80)");
            return true;
        }},
        { name: "V5Join: USING Single Column", sql: "SELECT COUNT(*) AS c FROM v5a JOIN v5b USING (id)", check: r => r.data[0].c === 2 },
        { name: "V5Join: USING Equals Explicit ON", fn: () => {
            const a = db.executeQuery("SELECT COUNT(*) AS c FROM v5a JOIN v5b USING (id)").data[0].c;
            const b = db.executeQuery("SELECT COUNT(*) AS c FROM v5a a JOIN v5b b ON a.id = b.id").data[0].c;
            return a === b;
        }},
        { name: "V5Join: USING Multi Column", sql: "SELECT COUNT(*) AS c FROM v5a JOIN v5b USING (id, dept)", check: r => r.data[0].c === 1 },
        { name: "V5Join: LEFT JOIN USING Keeps Unmatched", sql: "SELECT COUNT(*) AS total, COUNT(y) AS matched FROM v5a LEFT JOIN v5b USING (id)", check: r => r.data[0].total === 3 && r.data[0].matched === 2 },
        { name: "V5Join: USING With Alias", sql: "SELECT a.x, b.y FROM v5a a JOIN v5b b USING (id) WHERE a.id = 1", check: r => r.data.length === 1 && r.data[0].x === 10 && r.data[0].y === 100 },
        { name: "V5Join: NATURAL JOIN Common Columns", sql: "SELECT COUNT(*) AS c FROM v5a NATURAL JOIN v5b", check: r => r.data[0].c === 1 },
        { name: "V5Join: NATURAL LEFT JOIN", sql: "SELECT COUNT(*) AS c FROM v5a NATURAL LEFT JOIN v5b", check: r => r.data[0].c === 3 },
        { name: "V5Join: NATURAL Without Common Is Cartesian", sql: "SELECT COUNT(*) AS c FROM v5a NATURAL JOIN v5c", check: r => r.data[0].c === 6 },
        errCase("V5Join: USING Missing Column Rejected", "SELECT * FROM v5a JOIN v5b USING (nope)", 'USING'),
        { name: "V5Join: Chained Join USING Resolves Prior Tables", sql: "SELECT COUNT(*) AS c FROM v5c JOIN v5a ON 1 = 1 JOIN v5b USING (id)", check: r => r.data[0].c === 4 },
        errCase("V5Join: Bare JOIN Without Clause Rejected", "SELECT * FROM v5a JOIN v5b", 'requires an ON or USING'),
        { name: "V5Join: Cleanup", sql: "DROP TABLE v5a, v5b, v5c", check: r => r.data[0].Message.includes('dropped') },

        // ============================================================
        // 3. INTERSECT ALL / EXCEPT ALL (V5Set)
        // ============================================================
        { name: "V5Set: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v5set (v INTEGER)");
            db.executeQuery("CREATE TABLE v5set2 (v INTEGER)");
            // 左: 1×3, 2×1, 3×1 / 右: 1×2, 2×2 — ALL と DISTINCT で結果が変わる構成
            db.executeQuery("INSERT INTO v5set (v) VALUES (1), (1), (1), (2), (3)");
            db.executeQuery("INSERT INTO v5set2 (v) VALUES (1), (1), (2), (2)");
            return true;
        }},
        { name: "V5Set: INTERSECT ALL Multiset", sql: "SELECT v FROM v5set INTERSECT ALL SELECT v FROM v5set2 ORDER BY v", check: r =>
            r.data.length === 3 && r.data[0].v === 1 && r.data[1].v === 1 && r.data[2].v === 2 },
        { name: "V5Set: INTERSECT Distinct Compare", sql: "SELECT v FROM v5set INTERSECT SELECT v FROM v5set2 ORDER BY v", check: r =>
            r.data.length === 2 && r.data[0].v === 1 && r.data[1].v === 2 },
        { name: "V5Set: EXCEPT ALL Multiset", sql: "SELECT v FROM v5set EXCEPT ALL SELECT v FROM v5set2 ORDER BY v", check: r =>
            r.data.length === 2 && r.data[0].v === 1 && r.data[1].v === 3 },
        { name: "V5Set: EXCEPT Distinct Compare", sql: "SELECT v FROM v5set EXCEPT SELECT v FROM v5set2 ORDER BY v", check: r =>
            r.data.length === 1 && r.data[0].v === 3 },
        { name: "V5Set: Cleanup", sql: "DROP TABLE v5set, v5set2", check: r => r.data[0].Message.includes('dropped') },

        // ============================================================
        // 4. Did-you-mean 提案 (V5Sug)
        // ============================================================
        { name: "V5Sug: Table Typo Suggestion", sql: "SELECT * FROM usres", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes("Table 'usres' not found") && r.error.includes("Did you mean 'users'") },
        errCase("V5Sug: Update Table Typo", "UPDATE userz SET age = 1", "Did you mean 'users'"),
        { name: "V5Sug: Join Table Typo", sql: "SELECT * FROM users u JOIN orderz o ON u.id = o.user_id", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes("Join Table 'orderz' not found") && r.error.includes("Did you mean 'orders'") },
        { name: "V5Sug: Column Typo Suggestion", sql: "SELECT nmae FROM users", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes("Column 'nmae' not found") && r.error.includes("Did you mean 'name'") },
        { name: "V5Sug: No Suggestion For Distant Name", sql: "SELECT * FROM zzzzqqqq", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('not found') && !r.error.includes('Did you mean') },
        errCase("V5Sug: Describe Typo", "DESCRIBE prodcuts", "Did you mean 'products'"),

        // ============================================================
        // 5. UI 改善 (V5Ui) — 実DOM・localStorage依存（ヘッドレスでは既知失敗）
        // ============================================================
        { name: "V5Ui: Multi Statement Run Shows Last Result", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS v5ms");
            els.query.value = "CREATE TABLE v5ms (id INTEGER); INSERT INTO v5ms (id) VALUES (1), (2); SELECT COUNT(*) AS c FROM v5ms;";
            runQuery();
            const ok = currentResultData && currentResultData[0] && currentResultData[0].c === 2;
            db.executeQuery("DROP TABLE v5ms");
            return ok;
        }},
        { name: "V5Ui: Multi Statement Error Listed", fn: () => {
            els.query.value = "SELECT 1 AS x; SELECT * FROM no_such_v5; SELECT 2 AS y;";
            runQuery();
            const html = els.resArea.innerHTML;
            return html.includes('エラー') && html.includes('no_such_v5');
        }},
        { name: "V5Ui: Query History Navigate", fn: () => {
            localStorage.setItem('luminadb_query_history', JSON.stringify(['SELECT 1 AS a', 'SELECT 2 AS b']));
            historyIndex = -1;
            els.query.value = 'draft text';
            navigateHistory(-1);
            const got1 = els.query.value === 'SELECT 2 AS b';
            navigateHistory(-1);
            const got2 = els.query.value === 'SELECT 1 AS a';
            navigateHistory(1);
            navigateHistory(1);
            const back = els.query.value === 'draft text';
            els.query.value = '';
            return got1 && got2 && back;
        }},
        { name: "V5Ui: Tree Shows Views And Triggers", fn: () => {
            db.executeQuery("CREATE VIEW v5tv AS SELECT id FROM users");
            db.executeQuery("CREATE TABLE v5tt (id INTEGER)");
            db.executeQuery("CREATE TRIGGER v5trg AFTER INSERT ON v5tt FOR EACH ROW SELECT 1");
            renderTree();
            const html = document.getElementById('tableTree').innerHTML;
            const ok = html.includes('Views') && html.includes('v5tv') && html.includes('Triggers') && html.includes('v5trg');
            db.executeQuery("DROP TRIGGER v5trg");
            db.executeQuery("DROP VIEW v5tv");
            db.executeQuery("DROP TABLE v5tt");
            renderTree();
            return ok;
        }},
        { name: "V5Ui: New Keywords In Autocomplete", fn: () => {
            const kw = getDynamicKeywords();
            return kw.includes('RETURNING') && kw.includes('TRIGGER') && kw.includes('RECURSIVE') && kw.includes('JSON_EXTRACT');
        }}
      ];
    }
