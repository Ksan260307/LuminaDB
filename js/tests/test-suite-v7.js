    // ============================================================================
    // [Test Suite v7] - v1.6 機能追加の回帰テスト
    //   1. V7Lhs : LIKE / BETWEEN / IN / REGEXP の式（関数呼び出し）左辺
    //   2. V7Esc : LIKE ... ESCAPE
    //   3. V7Fn  : SHA1 / SUBSTR / OCTET_LENGTH / BIT_LENGTH / UNHEX / DATE_TRUNC /
    //              TYPEOF / IIF / REGEXP_COUNT
    //   4. V7Qual: QUALIFY 句（ウィンドウ関数結果のフィルタ）
    //   5. V7Agg : GROUPING / STRING_AGG / ARRAY_AGG / BOOL_AND / BOOL_OR /
    //              CORR / COVAR_POP / COVAR_SAMP / UNION DISTINCT
    //   6. V7Seq : シーケンス（CREATE/DROP/NEXTVAL/CURRVAL/SETVAL/永続化/トランザクション）
    //   7. V7Prep: PREPARE / EXECUTE / DEALLOCATE / SHOW PREPARED
    //   8. V7Exp : EXPLAIN ANALYZE
    //   9. V7Ddl : ALTER TABLE ADD/DROP COLUMN IF [NOT] EXISTS
    //  10. V7Api : LuminaDB.prepare() / on・off イベント / バージョン
    //   test-suite.js の tests 配列へ getV7Tests() のスプレッドで合流する
    // ============================================================================
    function getV7Tests() {
      return [
        // ============================================================
        // 1. 式左辺の LIKE / BETWEEN / IN / REGEXP (V7Lhs)
        // ============================================================
        { name: "V7Lhs: Function LHS In LIKE", sql: "SELECT COUNT(*) AS c FROM users WHERE UPPER(name) LIKE 'A%'", check: r => r.data[0].c === 1 },
        { name: "V7Lhs: Function LHS In NOT LIKE", sql: "SELECT COUNT(*) AS c FROM users WHERE LOWER(name) NOT LIKE '%e%'", check: r => r.data.length === 1 && r.data[0].c >= 1 },
        { name: "V7Lhs: Function LHS In BETWEEN", sql: "SELECT COUNT(*) AS c FROM users WHERE LENGTH(name) BETWEEN 3 AND 4", check: r => {
            const names = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"];
            const expect = names.filter(n => n.length >= 3 && n.length <= 4).length;
            return r.data[0].c === expect;
        }},
        { name: "V7Lhs: Function LHS In IN", sql: "SELECT COUNT(*) AS c FROM users WHERE LENGTH(name) IN (3, 4)", check: r => {
            const names = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"];
            return r.data[0].c === names.filter(n => n.length === 3 || n.length === 4).length;
        }},
        { name: "V7Lhs: Function LHS In REGEXP", sql: "SELECT name FROM users WHERE UPPER(name) REGEXP '^AL'", check: r => r.data.length === 1 && r.data[0].name === 'Alice' },
        { name: "V7Lhs: Nested Call LHS", sql: "SELECT COUNT(*) AS c FROM users WHERE SUBSTRING(UPPER(name), 1, 1) LIKE 'A'", check: r => r.data[0].c === 1 },
        { name: "V7Lhs: Plain Column Still Works", sql: "SELECT COUNT(*) AS c FROM users WHERE name LIKE 'A%'", check: r => r.data[0].c === 1 },

        // ============================================================
        // 2. LIKE ... ESCAPE (V7Esc)
        // ============================================================
        { name: "V7Esc: Escaped Percent Literal", sql: "SELECT '100%' LIKE '100!%' ESCAPE '!' AS a, '100x' LIKE '100!%' ESCAPE '!' AS b", check: r =>
            r.data[0].a === true && r.data[0].b === false },
        { name: "V7Esc: Escaped Underscore Literal", sql: "SELECT 'a_c' LIKE 'a!_c' ESCAPE '!' AS a, 'abc' LIKE 'a!_c' ESCAPE '!' AS b", check: r =>
            r.data[0].a === true && r.data[0].b === false },
        { name: "V7Esc: Escape Char Itself", sql: "SELECT 'a!b' LIKE 'a!!b' ESCAPE '!' AS a", check: r => r.data[0].a === true },
        { name: "V7Esc: Wildcards Still Work With Escape", sql: "SELECT 'discount 50%' LIKE '%50!%' ESCAPE '!' AS a", check: r => r.data[0].a === true },
        { name: "V7Esc: NOT LIKE With Escape", sql: "SELECT COUNT(*) AS c FROM users WHERE name NOT LIKE '!%%' ESCAPE '!'", check: r => r.data[0].c === 10 },
        { name: "V7Esc: Multi Char Escape Rejected", sql: "SELECT 'a' LIKE 'a' ESCAPE '!!'", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('single character') },

        // ============================================================
        // 3. 新しいスカラー関数 (V7Fn)
        // ============================================================
        { name: "V7Fn: SHA1 Known Vector", sql: "SELECT SHA1('abc') AS h", check: r => r.data[0].h === 'a9993e364706816aba3e25717850c26c9cd0d89d' },
        { name: "V7Fn: SHA1 Empty String", sql: "SELECT SHA1('') AS h", check: r => r.data[0].h === 'da39a3ee5e6b4b0d3255bfef95601890afd80709' },
        { name: "V7Fn: SHA Alias", sql: "SELECT SHA('abc') AS h", check: r => r.data[0].h === 'a9993e364706816aba3e25717850c26c9cd0d89d' },
        { name: "V7Fn: SHA1 Long Multi Block", sql: "SELECT SHA1(REPEAT('a', 100)) AS h", check: r => r.data[0].h === '7f9000257a4918d7072655ea468540cdcbd42e0c' },
        { name: "V7Fn: SUBSTR Alias", sql: "SELECT SUBSTR('abcdef', 2, 3) AS s", check: r => r.data[0].s === 'bcd' },
        { name: "V7Fn: OCTET_LENGTH UTF8", sql: "SELECT OCTET_LENGTH('ab') AS a, OCTET_LENGTH('あ') AS b, OCTET_LENGTH('🍣') AS c", check: r =>
            r.data[0].a === 2 && r.data[0].b === 3 && r.data[0].c === 4 },
        { name: "V7Fn: BIT_LENGTH", sql: "SELECT BIT_LENGTH('ab') AS b", check: r => r.data[0].b === 16 },
        { name: "V7Fn: UNHEX Roundtrip", sql: "SELECT UNHEX(HEX('abc')) AS s, UNHEX('zz') AS bad", check: r => r.data[0].s === 'abc' && r.data[0].bad === null },
        { name: "V7Fn: DATE_TRUNC Month", sql: "SELECT DATE_TRUNC('month', '2026-07-17 10:30:45') AS d", check: r => r.data[0].d === '2026-07-01 00:00:00' },
        { name: "V7Fn: DATE_TRUNC Week Monday", sql: "SELECT DATE_TRUNC('week', '2026-07-17') AS d", check: r => r.data[0].d === '2026-07-13 00:00:00' },
        { name: "V7Fn: DATE_TRUNC Quarter And Hour", sql: "SELECT DATE_TRUNC('quarter', '2026-08-15') AS q, DATE_TRUNC('hour', '2026-07-17 10:30:45') AS h", check: r =>
            r.data[0].q === '2026-07-01 00:00:00' && r.data[0].h === '2026-07-17 10:00:00' },
        { name: "V7Fn: DATE_TRUNC Bad Unit NULL", sql: "SELECT DATE_TRUNC('fortnight', '2026-07-17') AS d", check: r => r.data[0].d === null },
        { name: "V7Fn: TYPEOF All Types", sql: "SELECT TYPEOF(1) AS a, TYPEOF(1.5) AS b, TYPEOF('x') AS c, TYPEOF(NULL) AS d, TYPEOF(TRUE) AS e", check: r =>
            r.data[0].a === 'integer' && r.data[0].b === 'real' && r.data[0].c === 'text' && r.data[0].d === 'null' && r.data[0].e === 'boolean' },
        { name: "V7Fn: IIF Alias Of IF", sql: "SELECT IIF(2 > 1, 'y', 'n') AS a, IIF(1 > 2, 'y', 'n') AS b", check: r => r.data[0].a === 'y' && r.data[0].b === 'n' },
        { name: "V7Fn: REGEXP_COUNT", sql: "SELECT REGEXP_COUNT('a1b22c333', '[0-9]+') AS a, REGEXP_COUNT('abc', 'x') AS b", check: r =>
            r.data[0].a === 3 && r.data[0].b === 0 },

        // ============================================================
        // 4. QUALIFY (V7Qual)
        // ============================================================
        { name: "V7Qual: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v7q (grp TEXT, item TEXT, score INTEGER)");
            db.executeQuery("INSERT INTO v7q (grp, item, score) VALUES ('a', 'a1', 10), ('a', 'a2', 30), ('b', 'b1', 5), ('b', 'b2', 15)");
            return true;
        }},
        { name: "V7Qual: Top 1 Per Group", fn: () => {
            const r = db.executeQuery("SELECT grp, item, ROW_NUMBER() OVER(PARTITION BY grp ORDER BY score DESC) AS rn FROM v7q QUALIFY rn = 1 ORDER BY grp");
            return !r.error && r.data.length === 2 && r.data[0].item === 'a2' && r.data[1].item === 'b2';
        }},
        { name: "V7Qual: Combined With Where", fn: () => {
            const r = db.executeQuery("SELECT item, RANK() OVER(ORDER BY score DESC) AS rk FROM v7q WHERE grp = 'a' QUALIFY rk <= 1");
            return !r.error && r.data.length === 1 && r.data[0].item === 'a2';
        }},
        { name: "V7Qual: With Order By And Limit", fn: () => {
            const r = db.executeQuery("SELECT item, score, ROW_NUMBER() OVER(ORDER BY score DESC) AS rn FROM v7q QUALIFY rn <= 3 ORDER BY score ASC LIMIT 2");
            return !r.error && r.data.length === 2 && r.data[0].score === 10;
        }},
        { name: "V7Qual: Explain Shows Step", fn: () => {
            const r = db.executeQuery("EXPLAIN SELECT item, ROW_NUMBER() OVER(ORDER BY score) AS rn FROM v7q QUALIFY rn = 1");
            return !r.error && r.data.some(x => x.Operation === 'QUALIFY');
        }},

        // ============================================================
        // 5. 新集計 / GROUPING / UNION DISTINCT (V7Agg)
        // ============================================================
        { name: "V7Agg: STRING_AGG With Separator", sql: "SELECT STRING_AGG(item, ' / ') AS s FROM v7q WHERE grp = 'a'", check: r => r.data[0].s === 'a1 / a2' },
        { name: "V7Agg: STRING_AGG Group By", sql: "SELECT grp, STRING_AGG(item, '+') AS s FROM v7q GROUP BY grp ORDER BY grp", check: r =>
            r.data.length === 2 && r.data[0].s === 'a1+a2' && r.data[1].s === 'b1+b2' },
        { name: "V7Agg: STRING_AGG Requires 2 Args", sql: "SELECT STRING_AGG(item) FROM v7q", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('2 arguments') },
        { name: "V7Agg: ARRAY_AGG Alias", sql: "SELECT ARRAY_AGG(item ORDER BY score DESC) AS a FROM v7q WHERE grp = 'a'", check: r =>
            r.data[0].a === '["a2","a1"]' },
        { name: "V7Agg: BOOL_AND BOOL_OR", sql: "SELECT BOOL_AND(score > 0) AS all_pos, BOOL_AND(score > 10) AS all_gt10, BOOL_OR(score > 25) AS any_gt25, BOOL_OR(score > 100) AS any_gt100 FROM v7q", check: r =>
            r.data[0].all_pos === true && r.data[0].all_gt10 === false && r.data[0].any_gt25 === true && r.data[0].any_gt100 === false },
        { name: "V7Agg: BOOL_AND Empty Is NULL", sql: "SELECT BOOL_AND(score > 0) AS v FROM v7q WHERE grp = 'zzz'", check: r => r.data[0].v === null },
        { name: "V7Agg: CORR Perfect Correlation", fn: () => {
            db.executeQuery("CREATE TABLE v7corr (x INTEGER, y INTEGER)");
            db.executeQuery("INSERT INTO v7corr (x, y) VALUES (1, 2), (2, 4), (3, 6), (4, 8)");
            const r = db.executeQuery("SELECT CORR(x, y) AS c FROM v7corr");
            return !r.error && r.data[0].c === 1;
        }},
        { name: "V7Agg: CORR Negative Correlation", fn: () => {
            db.executeQuery("CREATE TABLE v7corr2 (x INTEGER, y INTEGER)");
            db.executeQuery("INSERT INTO v7corr2 (x, y) VALUES (1, 8), (2, 6), (3, 4), (4, 2)");
            const r = db.executeQuery("SELECT CORR(x, y) AS c FROM v7corr2");
            db.executeQuery("DROP TABLE v7corr2");
            return !r.error && r.data[0].c === -1;
        }},
        { name: "V7Agg: COVAR_POP And SAMP", fn: () => {
            // x=[1,2,3,4], y=[2,4,6,8]: 母共分散 = 2.5, 標本共分散 = 10/3
            const r = db.executeQuery("SELECT COVAR_POP(x, y) AS p, COVAR_SAMP(x, y) AS s FROM v7corr");
            return !r.error && r.data[0].p === 2.5 && Math.abs(r.data[0].s - 3.3333) < 0.001;
        }},
        { name: "V7Agg: CORR Zero Variance Is NULL", fn: () => {
            db.executeQuery("CREATE TABLE v7corr3 (x INTEGER, y INTEGER)");
            db.executeQuery("INSERT INTO v7corr3 (x, y) VALUES (1, 5), (2, 5), (3, 5)");
            const r = db.executeQuery("SELECT CORR(x, y) AS c FROM v7corr3");
            db.executeQuery("DROP TABLE v7corr3");
            return !r.error && r.data[0].c === null;
        }},
        { name: "V7Agg: CORR Single Row Is NULL", sql: "SELECT CORR(x, y) AS c FROM v7corr WHERE x = 1", check: r => r.data[0].c === null },
        { name: "V7Agg: CORR Cleanup", sql: "DROP TABLE v7corr", check: r => r.data[0].Result === "Success" },
        { name: "V7Agg: GROUPING In Rollup", fn: () => {
            const r = db.executeQuery("SELECT grp, GROUPING(grp) AS g, SUM(score) AS s FROM v7q GROUP BY grp WITH ROLLUP");
            if (r.error || r.data.length !== 3) return false;
            const normal = r.data.filter(x => x.g === 0);
            const total = r.data.find(x => x.g === 1);
            return normal.length === 2 && total && total.grp === null && total.s === 60;
        }},
        { name: "V7Agg: GROUPING Without Rollup Is Zero", fn: () => {
            const r = db.executeQuery("SELECT grp, GROUPING(grp) AS g FROM v7q GROUP BY grp");
            return !r.error && r.data.every(x => x.g === 0);
        }},
        { name: "V7Agg: GROUPING Two Levels", fn: () => {
            const r = db.executeQuery("SELECT grp, item, GROUPING(grp) AS gg, GROUPING(item) AS gi, COUNT(*) AS c FROM v7q GROUP BY grp, item WITH ROLLUP");
            if (r.error) return false;
            const sub = r.data.find(x => x.gg === 0 && x.gi === 1);
            const total = r.data.find(x => x.gg === 1 && x.gi === 1);
            return sub !== undefined && total !== undefined && total.c === 4;
        }},
        { name: "V7Agg: UNION DISTINCT Keyword", sql: "SELECT 1 AS v UNION DISTINCT SELECT 1 UNION DISTINCT SELECT 2", check: r => r.data.length === 2 },
        { name: "V7Qual: Cleanup", sql: "DROP TABLE v7q", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 6. シーケンス (V7Seq)
        // ============================================================
        { name: "V7Seq: Create And Nextval", fn: () => {
            db.executeQuery("DROP SEQUENCE IF EXISTS v7s");
            const c = db.executeQuery("CREATE SEQUENCE v7s START WITH 100 INCREMENT BY 10");
            const r1 = db.executeQuery("SELECT NEXTVAL('v7s') AS n");
            const r2 = db.executeQuery("SELECT NEXTVAL('v7s') AS n");
            return !c.error && r1.data[0].n === 100 && r2.data[0].n === 110;
        }},
        { name: "V7Seq: Currval Follows", sql: "SELECT CURRVAL('v7s') AS c", check: r => r.data[0].c === 110 },
        { name: "V7Seq: Setval Repositions", fn: () => {
            const s = db.executeQuery("SELECT SETVAL('v7s', 500) AS v");
            const n = db.executeQuery("SELECT NEXTVAL('v7s') AS n");
            return s.data[0].v === 500 && n.data[0].n === 510;
        }},
        { name: "V7Seq: Defaults Start 1 Inc 1", fn: () => {
            db.executeQuery("CREATE SEQUENCE v7s2");
            const a = db.executeQuery("SELECT NEXTVAL('v7s2') AS n").data[0].n;
            const b = db.executeQuery("SELECT NEXTVAL('v7s2') AS n").data[0].n;
            return a === 1 && b === 2;
        }},
        { name: "V7Seq: Currval Before Use Is NULL", fn: () => {
            db.executeQuery("CREATE SEQUENCE v7s3");
            const r = db.executeQuery("SELECT CURRVAL('v7s3') AS c");
            db.executeQuery("DROP SEQUENCE v7s3");
            return !r.error && r.data[0].c === null;
        }},
        { name: "V7Seq: Use In INSERT VALUES", fn: () => {
            db.executeQuery("CREATE TABLE v7st (id INTEGER PRIMARY KEY, v TEXT)");
            db.executeQuery("CREATE SEQUENCE v7sid START WITH 1");
            db.executeQuery("INSERT INTO v7st (id, v) VALUES (NEXTVAL('v7sid'), 'a'), (NEXTVAL('v7sid'), 'b')");
            const r = db.executeQuery("SELECT COUNT(*) AS c, MAX(id) AS m FROM v7st");
            db.executeQuery("DROP TABLE v7st");
            db.executeQuery("DROP SEQUENCE v7sid");
            return r.data[0].c === 2 && r.data[0].m === 2;
        }},
        { name: "V7Seq: Unknown Sequence Errors", sql: "SELECT NEXTVAL('no_such_seq')", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('not found') },
        { name: "V7Seq: Duplicate Create Rejected", sql: "CREATE SEQUENCE v7s", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('already exists') },
        { name: "V7Seq: If Not Exists Skips", sql: "CREATE SEQUENCE IF NOT EXISTS v7s", check: r => r.data[0].Message.includes('Skipped') },
        { name: "V7Seq: SHOW SEQUENCES", fn: () => {
            const r = db.executeQuery("SHOW SEQUENCES");
            const row = r.data.find(x => x.Sequence === 'v7s');
            return row && row.Start === 100 && row.Increment === 10 && row.Value === 510;
        }},
        { name: "V7Seq: IDB Roundtrip Keeps Value", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(db.exportForIDB());
            const n = eng2.executeQuery("SELECT NEXTVAL('v7s') AS n");
            return n.data[0].n === 520;
        }},
        { name: "V7Seq: SQL Export Includes Sequence", fn: () => {
            const script = db.exportSQL();
            const eng2 = new DatabaseEngine();
            eng2.executeScript(script);
            const n = eng2.executeQuery("SELECT NEXTVAL('v7s') AS n");
            return script.includes('CREATE SEQUENCE v7s START WITH 100 INCREMENT BY 10')
                && script.includes("SETVAL('v7s', 510)") && n.data[0].n === 520;
        }},
        { name: "V7Seq: Create Rolls Back In Tx", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE SEQUENCE v7stx");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT NEXTVAL('v7stx')");
            return r.error !== undefined && r.error.includes('not found');
        }},
        { name: "V7Seq: Value Is Non Transactional", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("SELECT NEXTVAL('v7s2') AS n");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT CURRVAL('v7s2') AS c");
            db.executeQuery("DROP SEQUENCE v7s2");
            return r.data[0].c === 3;
        }},
        { name: "V7Seq: Drop And If Exists", fn: () => {
            const d1 = db.executeQuery("DROP SEQUENCE v7s");
            const d2 = db.executeQuery("DROP SEQUENCE IF EXISTS v7s");
            const d3 = db.executeQuery("DROP SEQUENCE v7s");
            return !d1.error && d2.data[0].Message.includes('Skipped') && d3.error !== undefined;
        }},

        // ============================================================
        // 7. プリペアドステートメント (V7Prep)
        // ============================================================
        { name: "V7Prep: Prepare And Execute", fn: () => {
            const p = db.executeQuery("PREPARE v7find FROM 'SELECT name FROM users WHERE id = ?'");
            const r = db.executeQuery("EXECUTE v7find USING 2");
            return !p.error && !r.error && r.data.length === 1 && r.data[0].name === 'Bob';
        }},
        { name: "V7Prep: Execute With Different Value", fn: () => {
            const r = db.executeQuery("EXECUTE v7find USING 3");
            return !r.error && r.data[0].name === 'Charlie';
        }},
        { name: "V7Prep: Execute With User Variable", fn: () => {
            db.executeQuery("SET @v7id = 5");
            const r = db.executeQuery("EXECUTE v7find USING @v7id");
            return !r.error && r.data[0].name === 'Eve';
        }},
        { name: "V7Prep: Multiple Placeholders", fn: () => {
            db.executeQuery("PREPARE v7range FROM 'SELECT COUNT(*) AS c FROM users WHERE age >= ? AND age <= ?'");
            const r = db.executeQuery("EXECUTE v7range USING 25, 30");
            return !r.error && r.data[0].c === 5;
        }},
        { name: "V7Prep: String Value Binding", fn: () => {
            db.executeQuery("PREPARE v7name FROM 'SELECT id FROM users WHERE name = ?'");
            const r = db.executeQuery("EXECUTE v7name USING 'Alice'");
            return !r.error && r.data[0].id === 1;
        }},
        { name: "V7Prep: Question Mark In Literal Preserved", fn: () => {
            db.executeQuery("PREPARE v7q1 FROM 'SELECT ''a?b'' AS s, ? AS v'");
            const r = db.executeQuery("EXECUTE v7q1 USING 9");
            db.executeQuery("DEALLOCATE PREPARE v7q1");
            return !r.error && r.data[0].s === 'a?b' && r.data[0].v === 9;
        }},
        { name: "V7Prep: Missing Value Rejected", sql: "EXECUTE v7range USING 25", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('has no value') },
        { name: "V7Prep: Extra Value Rejected", sql: "EXECUTE v7find USING 1, 2", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('only') },
        { name: "V7Prep: DML Via Prepared", fn: () => {
            db.executeQuery("CREATE TABLE v7pt (id INTEGER, v TEXT)");
            db.executeQuery("PREPARE v7ins FROM 'INSERT INTO v7pt (id, v) VALUES (?, ?)'");
            const r = db.executeQuery("EXECUTE v7ins USING 1, 'x'");
            const n = db.executeQuery("SELECT COUNT(*) AS c FROM v7pt").data[0].c;
            db.executeQuery("DEALLOCATE PREPARE v7ins");
            db.executeQuery("DROP TABLE v7pt");
            return !r.error && n === 1;
        }},
        { name: "V7Prep: SHOW PREPARED Lists", fn: () => {
            const r = db.executeQuery("SHOW PREPARED");
            const names = r.data.map(x => x.Statement);
            return names.includes('v7find') && names.includes('v7range') && names.includes('v7name');
        }},
        { name: "V7Prep: Unknown Statement Suggests", sql: "EXECUTE v7findd USING 1", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes("Did you mean 'v7find'") },
        { name: "V7Prep: Self Recursion Guarded", fn: () => {
            db.executeQuery("PREPARE v7loop FROM 'EXECUTE v7loop'");
            const r = db.executeQuery("EXECUTE v7loop");
            db.executeQuery("DEALLOCATE PREPARE v7loop");
            return r.error !== undefined && r.error.includes('depth');
        }},
        { name: "V7Prep: Deallocate", fn: () => {
            const d = db.executeQuery("DEALLOCATE PREPARE v7find");
            const r = db.executeQuery("EXECUTE v7find USING 1");
            db.executeQuery("DEALLOCATE PREPARE v7range");
            db.executeQuery("DEALLOCATE PREPARE v7name");
            return !d.error && r.error !== undefined && r.error.includes('not found');
        }},

        // ============================================================
        // 8. EXPLAIN ANALYZE (V7Exp)
        // ============================================================
        { name: "V7Exp: Plan Plus Actual", fn: () => {
            const r = db.executeQuery("EXPLAIN ANALYZE SELECT * FROM users WHERE age > 25 ORDER BY age");
            if (r.error) return false;
            const last = r.data[r.data.length - 1];
            return r.data.some(x => x.Operation === 'TABLE SCAN')
                && last.Operation === 'ACTUAL'
                && /\d+ row\(s\) returned in [\d.]+ ms/.test(last.Details);
        }},
        { name: "V7Exp: Actual Row Count Correct", fn: () => {
            const n = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE age > 25").data[0].c;
            const r = db.executeQuery("EXPLAIN ANALYZE SELECT * FROM users WHERE age > 25");
            const last = r.data[r.data.length - 1];
            return last.Details.startsWith(`${n} row(s)`);
        }},
        { name: "V7Exp: Plain EXPLAIN Unchanged", fn: () => {
            // users テーブルはインデックス未定義のため TABLE SCAN（EXPLAIN ANALYZE ではない
            // 通常の EXPLAIN に ACTUAL 行が混ざらないことを確認する）
            const r = db.executeQuery("EXPLAIN SELECT * FROM users WHERE id = 1");
            return !r.error && r.data.some(x => x.Operation === 'TABLE SCAN') && !r.data.some(x => x.Operation === 'ACTUAL');
        }},
        { name: "V7Exp: Non Select Rejected", sql: "EXPLAIN ANALYZE INSERT INTO users (id, name, age) VALUES (999, 'x', 1)", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('SELECT statements only') },
        { name: "V7Exp: Analyze Does Not Mutate", fn: () => {
            const before = db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c;
            db.executeQuery("EXPLAIN ANALYZE SELECT * FROM users");
            const after = db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c;
            return before === after && before === 10;
        }},

        // ============================================================
        // 9. ALTER TABLE IF [NOT] EXISTS (V7Ddl)
        // ============================================================
        { name: "V7Ddl: Add Column If Not Exists", fn: () => {
            db.executeQuery("CREATE TABLE v7alt (id INTEGER)");
            const a1 = db.executeQuery("ALTER TABLE v7alt ADD COLUMN IF NOT EXISTS extra TEXT DEFAULT 'x'");
            const a2 = db.executeQuery("ALTER TABLE v7alt ADD COLUMN IF NOT EXISTS extra TEXT");
            const cols = db.tables['v7alt'].getColumnNames();
            return !a1.error && a2.data[0].Message.includes('Skipped') && cols.includes('extra') && cols.length === 2;
        }},
        { name: "V7Ddl: Drop Column If Exists", fn: () => {
            const d1 = db.executeQuery("ALTER TABLE v7alt DROP COLUMN IF EXISTS extra");
            const d2 = db.executeQuery("ALTER TABLE v7alt DROP COLUMN IF EXISTS extra");
            const cols = db.tables['v7alt'].getColumnNames();
            db.executeQuery("DROP TABLE v7alt");
            return !d1.error && d2.data[0].Message.includes('Skipped') && !cols.includes('extra');
        }},

        // ============================================================
        // 10. API 拡張 (V7Api)
        // ============================================================
        { name: "V7Api: prepare().all And get", fn: () => {
            const stmt = LuminaDB.prepare('SELECT * FROM users WHERE age > ?');
            const rows = stmt.all(30);
            const one = stmt.get(39);
            return Array.isArray(rows) && rows.length === 3 && one && one.name === 'Frank';
        }},
        { name: "V7Api: prepare().value And Array Args", fn: () => {
            const stmt = LuminaDB.prepare('SELECT COUNT(*) FROM users WHERE age BETWEEN ? AND ?');
            return stmt.value(25, 30) === 5 && stmt.value([25, 30]) === 5;
        }},
        { name: "V7Api: prepare().run Returns Changes", fn: () => {
            db.executeQuery("CREATE TABLE v7run (id INTEGER, v TEXT)");
            const stmt = LuminaDB.prepare('INSERT INTO v7run (id, v) VALUES (?, ?)');
            const r1 = stmt.run(1, 'a');
            const r2 = stmt.run(2, 'b');
            const n = LuminaDB.value('SELECT COUNT(*) FROM v7run');
            db.executeQuery("DROP TABLE v7run");
            return r1.changes === 1 && r2.changes === 1 && n === 2;
        }},
        { name: "V7Api: prepare() Named Params", fn: () => {
            const stmt = LuminaDB.prepare('SELECT name FROM users WHERE id = :id');
            const row = stmt.get({ id: 4 });
            return row && row.name === 'Dave';
        }},
        { name: "V7Api: prepare().run Throws On Error", fn: () => {
            const stmt = LuminaDB.prepare('INSERT INTO no_such_v7 (a) VALUES (?)');
            try { stmt.run(1); return false; }
            catch (e) { return e.message.includes('not found'); }
        }},
        { name: "V7Api: change Event Fires On Write", fn: () => {
            db.executeQuery("CREATE TABLE v7ev (id INTEGER)");
            const events = [];
            const handler = (e) => events.push(e);
            LuminaDB.on('change', handler);
            LuminaDB.insert('v7ev', { id: 1 });
            LuminaDB.query('SELECT * FROM v7ev');
            LuminaDB.off('change', handler);
            db.executeQuery("DROP TABLE v7ev");
            return events.length === 1 && /insert into v7ev/i.test(events[0].sql);
        }},
        { name: "V7Api: off Stops Events", fn: () => {
            db.executeQuery("CREATE TABLE v7ev2 (id INTEGER)");
            let count = 0;
            const handler = () => count++;
            LuminaDB.on('change', handler);
            LuminaDB.insert('v7ev2', { id: 1 });
            LuminaDB.off('change', handler);
            LuminaDB.insert('v7ev2', { id: 2 });
            db.executeQuery("DROP TABLE v7ev2");
            return count === 1;
        }},
        { name: "V7Api: Listener Exception Ignored", fn: () => {
            db.executeQuery("CREATE TABLE v7ev3 (id INTEGER)");
            const boom = () => { throw new Error('boom'); };
            let ok = false;
            LuminaDB.on('change', boom);
            LuminaDB.on('change', () => { ok = true; });
            const r = LuminaDB.insert('v7ev3', { id: 1 });
            LuminaDB.off('change');
            db.executeQuery("DROP TABLE v7ev3");
            return !r.error && ok;
        }},
        { name: "V7Api: exec Fires Change Event", fn: () => {
            db.executeQuery("CREATE TABLE v7ev4 (id INTEGER)");
            let got = null;
            const handler = (e) => { got = e; };
            LuminaDB.on('change', handler);
            LuminaDB.exec("INSERT INTO v7ev4 (id) VALUES (1); INSERT INTO v7ev4 (id) VALUES (2);");
            LuminaDB.off('change', handler);
            db.executeQuery("DROP TABLE v7ev4");
            return got !== null && got.succeeded === 2;
        }},
        { name: "V7Api: version Is Semver", fn: () => {
            return /^\d+\.\d+\.\d+$/.test(String(LuminaDB.version)) && String(LuminaDB.version) === LUMINA_VERSION;
        }}
      ];
    }
