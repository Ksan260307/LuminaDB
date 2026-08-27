    // ============================================================================
    // [Test Suite v8] - v1.7 機能追加の回帰テスト
    //   1. V8Filter: 集計の FILTER (WHERE ...) 句
    //   2. V8Gen   : GENERATE_SERIES() テーブル関数
    //   3. V8Win   : named window（WINDOW w AS (...) / OVER w）
    //   4. V8GenCol: 生成列（GENERATED ALWAYS AS (expr) STORED）
    //   5. V8Api   : LuminaDB.explain / each
    //   6. V8Fmt   : formatSql（SQL整形の純粋関数）
    //   test-suite.js の tests 配列へ getV8Tests() のスプレッドで合流する
    // ============================================================================
    function getV8Tests() {
      return [
        // ============================================================
        // 1. FILTER (WHERE) 集計句 (V8Filter)
        // ============================================================
        { name: "V8Filter: Count Filter", sql: "SELECT COUNT(*) FILTER (WHERE age > 30) AS c FROM users", check: r => r.data[0].c === 3 },
        { name: "V8Filter: Sum Filter", sql: "SELECT SUM(age) FILTER (WHERE age < 25) AS s FROM users", check: r => r.data[0].s === 46 },
        { name: "V8Filter: Avg Filter", sql: "SELECT AVG(age) FILTER (WHERE age >= 35) AS a FROM users", check: r => r.data[0].a === 37.5 },
        { name: "V8Filter: Two Filters One Row", sql: "SELECT COUNT(*) FILTER (WHERE age >= 30) AS old, COUNT(*) FILTER (WHERE age < 30) AS young FROM users", check: r =>
            r.data[0].old === 4 && r.data[0].young === 6 },
        { name: "V8Filter: Filter Vs Unfiltered", sql: "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE age > 30) AS hi FROM users", check: r =>
            r.data[0].total === 10 && r.data[0].hi === 3 },
        { name: "V8Filter: Setup Group", fn: () => {
            db.executeQuery("CREATE TABLE v8f (g TEXT, v INTEGER)");
            db.executeQuery("INSERT INTO v8f (g, v) VALUES ('a', 10), ('a', 30), ('b', 5), ('b', 40)");
            return true;
        }},
        { name: "V8Filter: Group By With Filter", sql: "SELECT g, COUNT(*) FILTER (WHERE v > 10) AS c, SUM(v) AS total FROM v8f GROUP BY g ORDER BY g", check: r =>
            r.data.length === 2 && r.data[0].c === 1 && r.data[0].total === 40 && r.data[1].c === 1 && r.data[1].total === 45 },
        { name: "V8Filter: Filtered Sum Per Group", sql: "SELECT g, SUM(v) FILTER (WHERE v >= 30) AS s FROM v8f GROUP BY g ORDER BY g", check: r =>
            r.data[0].s === 30 && r.data[1].s === 40 },
        { name: "V8Filter: Filter Excludes All Is Null Or Zero", sql: "SELECT SUM(v) FILTER (WHERE v > 999) AS s, COUNT(*) FILTER (WHERE v > 999) AS c FROM v8f", check: r =>
            r.data[0].c === 0 && (r.data[0].s === null || r.data[0].s === 0) },
        { name: "V8Filter: Distinct With Filter", fn: () => {
            db.executeQuery("CREATE TABLE v8fd (v INTEGER)");
            db.executeQuery("INSERT INTO v8fd (v) VALUES (1), (1), (2), (3), (3)");
            const r = db.executeQuery("SELECT COUNT(DISTINCT v) FILTER (WHERE v > 1) AS c FROM v8fd");
            db.executeQuery("DROP TABLE v8fd");
            return !r.error && r.data[0].c === 2;
        }},
        errCase("V8Filter: On Non Aggregate Rejected", "SELECT age FILTER (WHERE age > 0) FROM users", 'FILTER'),
        { name: "V8Filter: Cleanup", sql: "DROP TABLE v8f", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 2. GENERATE_SERIES (V8Gen)
        // ============================================================
        { name: "V8Gen: Basic Range", sql: "SELECT COUNT(*) AS c, SUM(value) AS s FROM GENERATE_SERIES(1, 5)", check: r => r.data[0].c === 5 && r.data[0].s === 15 },
        { name: "V8Gen: Value Column", sql: "SELECT value AS v FROM GENERATE_SERIES(1, 3) ORDER BY value", check: r =>
            r.data.length === 3 && r.data[0].v === 1 && r.data[2].v === 3 },
        { name: "V8Gen: With Step", sql: "SELECT value AS v FROM GENERATE_SERIES(1, 10, 2) ORDER BY value", check: r =>
            r.data.length === 5 && r.data[0].v === 1 && r.data[4].v === 9 },
        { name: "V8Gen: Descending Step", sql: "SELECT value AS v FROM GENERATE_SERIES(10, 1, -2) ORDER BY value DESC", check: r =>
            r.data.length === 5 && r.data[0].v === 10 && r.data[4].v === 2 },
        { name: "V8Gen: Column Alias List", sql: "SELECT n FROM GENERATE_SERIES(1, 3) AS s(n) ORDER BY n DESC", check: r =>
            r.data.length === 3 && r.data[0].n === 3 && r.data[2].n === 1 },
        { name: "V8Gen: Expression Args", sql: "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, ABS(-5))", check: r => r.data[0].c === 5 },
        { name: "V8Gen: In CTE", sql: "WITH s AS (SELECT value FROM GENERATE_SERIES(1, 100)) SELECT COUNT(*) AS c, SUM(value) AS sm FROM s", check: r =>
            r.data[0].c === 100 && r.data[0].sm === 5050 },
        { name: "V8Gen: Join Two Series", sql: "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 3) a JOIN GENERATE_SERIES(1, 4) b ON 1 = 1", check: r => r.data[0].c === 12 },
        { name: "V8Gen: Filter On Series", sql: "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10) WHERE value % 2 = 0", check: r => r.data[0].c === 5 },
        errCase("V8Gen: Zero Step Rejected", "SELECT * FROM GENERATE_SERIES(1, 5, 0)", 'step'),
        errCase("V8Gen: Too Few Args Rejected", "SELECT * FROM GENERATE_SERIES(5)", '2 or 3 arguments'),
        { name: "V8Gen: Empty Range", sql: "SELECT COUNT(*) AS c FROM GENERATE_SERIES(5, 1)", check: r => r.data[0].c === 0 },
        { name: "V8Gen: Insert Select From Series", fn: () => {
            db.executeQuery("CREATE TABLE v8nums (n INTEGER)");
            db.executeQuery("INSERT INTO v8nums (n) SELECT value FROM GENERATE_SERIES(1, 50)");
            const r = db.executeQuery("SELECT COUNT(*) AS c, MAX(n) AS m FROM v8nums");
            db.executeQuery("DROP TABLE v8nums");
            return r.data[0].c === 50 && r.data[0].m === 50;
        }},

        // ============================================================
        // 3. named window (V8Win)
        // ============================================================
        { name: "V8Win: Basic OVER w", sql: "SELECT name, ROW_NUMBER() OVER w AS rn FROM users WINDOW w AS (ORDER BY age DESC) ORDER BY rn LIMIT 1", check: r =>
            r.data.length === 1 && r.data[0].name === 'Frank' && r.data[0].rn === 1 },
        { name: "V8Win: Shared Window Two Funcs", sql: "SELECT id, ROW_NUMBER() OVER w AS rn, RANK() OVER w AS rk FROM users WINDOW w AS (ORDER BY age) ORDER BY rn LIMIT 1", check: r =>
            r.data[0].rn === 1 && r.data[0].rk === 1 },
        { name: "V8Win: Named Equals Inline", fn: () => {
            const a = db.executeQuery("SELECT id, ROW_NUMBER() OVER w AS rn FROM users WINDOW w AS (PARTITION BY age ORDER BY id) ORDER BY id").data.map(x => x.rn);
            const b = db.executeQuery("SELECT id, ROW_NUMBER() OVER (PARTITION BY age ORDER BY id) AS rn FROM users ORDER BY id").data.map(x => x.rn);
            return JSON.stringify(a) === JSON.stringify(b);
        }},
        { name: "V8Win: Multiple Definitions", sql: "SELECT id, ROW_NUMBER() OVER w1 AS a, ROW_NUMBER() OVER w2 AS b FROM users WINDOW w1 AS (ORDER BY age), w2 AS (ORDER BY id DESC) ORDER BY id LIMIT 1", check: r =>
            r.data.length === 1 && typeof r.data[0].a === 'number' && typeof r.data[0].b === 'number' },
        errCase("V8Win: Undefined Window Rejected", "SELECT ROW_NUMBER() OVER wx AS rn FROM users WINDOW w AS (ORDER BY age)", "Window 'wx' is not defined"),
        { name: "V8Win: Frame In Named Window", sql: "SELECT id, SUM(age) OVER w AS running FROM users WINDOW w AS (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) ORDER BY id LIMIT 2", check: r =>
            r.data.length === 2 && r.data[1].running === r.data[0].running + db.executeQuery("SELECT age FROM users WHERE id = 2").data[0].age },

        // ============================================================
        // 4. 生成列 (V8GenCol)
        // ============================================================
        { name: "V8GenCol: Create And Compute", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS v8gc");
            db.executeQuery("CREATE TABLE v8gc (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED)");
            db.executeQuery("INSERT INTO v8gc (a) VALUES (5), (10)");
            const r = db.executeQuery("SELECT * FROM v8gc ORDER BY a");
            return r.data.length === 2 && r.data[0].b === 10 && r.data[1].b === 20;
        }},
        { name: "V8GenCol: Short Form AS", fn: () => {
            db.executeQuery("CREATE TABLE v8gc2 (a INTEGER, doubled AS (a + a))");
            db.executeQuery("INSERT INTO v8gc2 (a) VALUES (7)");
            const r = db.executeQuery("SELECT doubled FROM v8gc2");
            db.executeQuery("DROP TABLE v8gc2");
            return r.data[0].doubled === 14;
        }},
        { name: "V8GenCol: Chained Reference", fn: () => {
            db.executeQuery("CREATE TABLE v8gc3 (a INTEGER, b AS (a * 2) STORED, c AS (a + b))");
            db.executeQuery("INSERT INTO v8gc3 (a) VALUES (5)");
            const r = db.executeQuery("SELECT * FROM v8gc3");
            db.executeQuery("DROP TABLE v8gc3");
            return r.data[0].b === 10 && r.data[0].c === 15;
        }},
        { name: "V8GenCol: String Expression", fn: () => {
            db.executeQuery("CREATE TABLE v8gc4 (first TEXT, last TEXT, full AS (CONCAT(first, ' ', last)))");
            db.executeQuery("INSERT INTO v8gc4 (first, last) VALUES ('Ada', 'Lovelace')");
            const r = db.executeQuery("SELECT full FROM v8gc4");
            db.executeQuery("DROP TABLE v8gc4");
            return r.data[0].full === 'Ada Lovelace';
        }},
        { name: "V8GenCol: Recomputed On Update", fn: () => {
            db.executeQuery("UPDATE v8gc SET a = 100 WHERE a = 5");
            const r = db.executeQuery("SELECT b FROM v8gc WHERE a = 100");
            return r.data[0].b === 200;
        }},
        errCase("V8GenCol: Insert Into Generated Rejected", "INSERT INTO v8gc (a, b) VALUES (1, 99)", "generated column"),
        errCase("V8GenCol: Update Generated Rejected", "UPDATE v8gc SET b = 99 WHERE a = 100", "generated column"),
        { name: "V8GenCol: DESCRIBE Shows Extra", fn: () => {
            const r = db.executeQuery("DESCRIBE v8gc");
            const row = r.data.find(x => x.Column === 'b');
            return row.Extra.includes('GENERATED');
        }},
        { name: "V8GenCol: SHOW CREATE Includes Expr", fn: () => {
            const r = db.executeQuery("SHOW CREATE TABLE v8gc");
            return r.data[0].CreateTable.includes('GENERATED ALWAYS AS') && r.data[0].CreateTable.includes('a * 2');
        }},
        { name: "V8GenCol: IDB Roundtrip Recomputes", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(db.exportForIDB());
            eng2.executeQuery("INSERT INTO v8gc (a) VALUES (7)");
            const r = eng2.executeQuery("SELECT b FROM v8gc WHERE a = 7");
            return r.data[0].b === 14;
        }},
        { name: "V8GenCol: SQL Export Reimport", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.executeScript(db.exportSQL());
            eng2.executeQuery("INSERT INTO v8gc (a) VALUES (9)");
            const r = eng2.executeQuery("SELECT b FROM v8gc WHERE a = 9");
            return r.data[0].b === 18;
        }},
        errCase("V8GenCol: Generated With Default Rejected", "CREATE TABLE v8bad (a INTEGER, b AS (a) DEFAULT 5)", 'DEFAULT'),
        { name: "V8GenCol: Cleanup", sql: "DROP TABLE v8gc", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 5. API explain / each (V8Api)
        // ============================================================
        { name: "V8Api: explain Returns Plan", fn: () => {
            const plan = LuminaDB.explain('SELECT * FROM users WHERE id = 1');
            return Array.isArray(plan) && plan.length > 0 && plan.every(p => p.Operation);
        }},
        { name: "V8Api: explain With Params", fn: () => {
            const plan = LuminaDB.explain('SELECT * FROM users WHERE age > ?', [25]);
            return Array.isArray(plan) && plan.some(p => p.Operation === 'TABLE SCAN');
        }},
        { name: "V8Api: explain Throws On Error", fn: () => {
            try { LuminaDB.explain('SELECT * FROM no_such_v8'); return false; }
            catch (e) { return e.message.includes('not found'); }
        }},
        { name: "V8Api: each Iterates All", fn: () => {
            let count = 0, sumAge = 0;
            const n = LuminaDB.each('SELECT age FROM users', row => { count++; sumAge += row.age; });
            return n === 10 && count === 10 && sumAge === 291;
        }},
        { name: "V8Api: each With Params", fn: () => {
            const names = [];
            const n = LuminaDB.each('SELECT name FROM users WHERE age > ?', [35], row => names.push(row.name));
            return n === 1 && names[0] === 'Frank';
        }},
        { name: "V8Api: each Index Argument", fn: () => {
            const idxs = [];
            LuminaDB.each('SELECT id FROM users LIMIT 3', (row, i) => idxs.push(i));
            return JSON.stringify(idxs) === '[0,1,2]';
        }},
        { name: "V8Api: each Requires Callback", fn: () => {
            try { LuminaDB.each('SELECT 1'); return false; }
            catch (e) { return e.message.includes('callback'); }
        }},

        // ============================================================
        // 6. SQL 整形 formatSql (V8Fmt) — editor.js の純粋関数
        // ============================================================
        { name: "V8Fmt: Function Available", fn: () => typeof formatSql === 'function' },
        { name: "V8Fmt: Empty Returns Empty", fn: () => formatSql('') === '' && formatSql('   ') === '' },
        { name: "V8Fmt: Breaks Major Clauses", fn: () => {
            const out = formatSql('select id, name from users where age > 30 order by id');
            return /\nFROM\b/i.test(out) && /\nWHERE\b/i.test(out) && /\nORDER BY\b/i.test(out);
        }},
        { name: "V8Fmt: Columns On New Lines", fn: () => {
            const out = formatSql('SELECT a, b, c FROM t');
            // SELECT 行のカラムがカンマ後に改行される
            return out.split('\n').length >= 4;
        }},
        { name: "V8Fmt: Preserves String Literals", fn: () => {
            const out = formatSql("SELECT id FROM t WHERE note = 'from where order'");
            return out.includes("'from where order'");
        }},
        { name: "V8Fmt: Does Not Break Inside Parens", fn: () => {
            // サブクエリ内の FROM/WHERE はトップレベル改行しない（括弧深さで抑制）
            const out = formatSql('SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE x = 1)');
            return out.includes('(SELECT id FROM u WHERE x = 1)');
        }},
        { name: "V8Fmt: Idempotent Enough", fn: () => {
            const once = formatSql('SELECT a FROM t WHERE x = 1');
            const twice = formatSql(once);
            return once === twice;
        }},
        { name: "V8Fmt: Join Breaks", fn: () => {
            const out = formatSql('SELECT * FROM a JOIN b ON a.id = b.id');
            return /\nJOIN\b/i.test(out);
        }}
      ];
    }
