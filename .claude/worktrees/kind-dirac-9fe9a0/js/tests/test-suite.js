    // ============================================================================
    // [Test Suite] - "runtest" で実行される回帰テスト（エンジン / UI / IDB）
    // ============================================================================
    async function runTestSuite() {
      isTesting = true;
      const originalQuery = els.query.value;
      const originalLimit = els.dispLimit.value;

      els.resArea.innerHTML = `<div class="m-auto text-blue-500 text-sm font-mono animate-pulse font-medium">Running test suite (1000+ cases)...</div>`;

      // ユーザーの現在のDB状態をバックアップし、テスト用のクリーンなDBを構築
      const userDbBackup = db.exportForIDB();
      db = new DatabaseEngine();

      const tests = [
        // DDL & Indexing
        { name: "Create Table A", sql: "CREATE TABLE test_a (id, val, category)", check: r => r.data[0].Result === "Success" },
        { name: "Create Table B", sql: "CREATE TABLE test_b (id, a_id, note)", check: r => r.data[0].Result === "Success" },
        { name: "Create Table C", sql: "CREATE TABLE test_c (id, c_val)", check: r => r.data[0].Result === "Success" },
        { name: "Create Table Empty", sql: "CREATE TABLE test_empty (id, none)", check: r => r.data[0].Result === "Success" },
        { name: "Create Table Trunc", sql: "CREATE TABLE test_trunc (id, val, dt, flag)", check: r => r.data[0].Result === "Success" },
        { name: "Create Index", sql: "CREATE INDEX idx_user_id ON orders (user_id)", check: r => r.data[0].Result === "Success" },

        // Explain
        { name: "Explain Select", sql: "EXPLAIN SELECT * FROM users", check: r => r.data[0].Operation === 'TABLE SCAN' },
        { name: "Explain Hash Join", sql: "EXPLAIN SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id", check: r => r.data.some(d => d.Operation.includes('HASH JOIN')) },
        { name: "Explain Index Scan", sql: "EXPLAIN SELECT * FROM orders WHERE user_id = 1", check: r => r.data[0].Operation === 'INDEX SCAN' },
        { name: "Index Join Data Check", sql: "SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = 1", check: r => r.data.length === 2 && r.data[0].name === 'Alice' },

        // DML Insert
        { name: "Insert Bulk A", sql: "INSERT INTO test_a (id, val, category) VALUES (1, 100, 'Cat1'), (2, 200, 'Cat2'), (3, 300, 'Cat1'), (4, 100, 'Cat2'), (5, null, 'Cat1')", check: r => r.data[0].Message.includes('5') },
        { name: "Insert Bulk B", sql: "INSERT INTO test_b (id, a_id, note) VALUES (10, 1, 'X'), (20, 2, 'Y'), (30, 99, 'Z')", check: r => r.data[0].Message.includes('3') },
        { name: "Insert Bulk C", sql: "INSERT INTO test_c (id, c_val) VALUES (1, 'C1'), (2, 'C2')", check: r => r.data[0].Message.includes('2') },
        { name: "Insert Trunc", sql: "INSERT INTO test_trunc (id, val) VALUES (1, 10), (2, 20)", check: r => r.data[0].Message.includes('2') },

        // DML Insert Select
        { name: "Insert Select", sql: "INSERT INTO test_trunc (id, val) SELECT id, val FROM test_a WHERE id IN (1, 2)", check: r => r.data[0].Message.includes('2 rows inserted') },

        // Type: Boolean, Date
        { name: "Date & Bool Insert", sql: "INSERT INTO test_trunc (id, val) VALUES (99, 99)", check: r => r.data[0].Message.includes('1 rows inserted') },
        { name: "Date & Bool Insert 2", sql: "INSERT INTO test_trunc (id, val, dt, flag) VALUES (99, 99, DATE('2024-01-01'), TRUE), (98, 98, DATE('2024-12-31'), FALSE)", check: r => r.data[0].Message.includes('2 rows inserted') },
        { name: "Date & Bool Select", sql: "SELECT dt, flag FROM test_trunc WHERE flag = true", check: r => r.data.length === 1 && r.data[0].dt.includes('2024-01-01') && r.data[0].flag === true },
        { name: "Mega Cplx: Date and Boolean Aggregation", sql: "SELECT flag, COUNT(*) as c, MAX(YEAR(dt)) as max_y FROM test_trunc WHERE flag IS NOT NULL GROUP BY flag ORDER BY flag DESC", check: r => r.data.length === 2 && r.data[0].flag === true && r.data[0].c === 1 && r.data[0].max_y === 2024 },

        // 型・制約に関するテスト
        { name: "Create Typed Table", sql: "CREATE TABLE test_types (i INTEGER, f FLOAT, t TEXT, b BOOLEAN, d DATE)", check: r => r.data[0].Result === "Success" },
        { name: "Insert Valid Types", sql: "INSERT INTO test_types (i, f, t, b, d) VALUES (1, 1.5, 'text', true, '2025-01-01')", check: r => r.data[0].Message.includes('1') },
        errCase("Insert Invalid INTEGER", "INSERT INTO test_types (i) VALUES ('abc')", 'Type mismatch'),
        errCase("Insert Invalid FLOAT", "INSERT INTO test_types (f) VALUES ('abc')", 'Type mismatch'),
        errCase("Insert Invalid BOOLEAN", "INSERT INTO test_types (b) VALUES ('abc')", 'Type mismatch'),
        errCase("Insert Invalid DATE", "INSERT INTO test_types (d) VALUES ('invalid-date')", 'Type mismatch'),
        errCase("Update with Invalid Type", "UPDATE test_types SET i = 'XYZ' WHERE i = 1", 'Type mismatch'),

        errCase("Neg: Insert Float to Integer", "INSERT INTO test_types (i) VALUES (1.5)", 'Type mismatch'),
        errCase("Neg: Insert String to Integer", "INSERT INTO test_types (i) VALUES ('123a')", 'Type mismatch'),
        errCase("Neg: Insert Number to Date", "INSERT INTO test_types (d) VALUES (20250101)", 'Type mismatch'),

        // ALTER TABLE テスト
        { name: "DDL: ALTER ADD COLUMN", sql: "ALTER TABLE test_types ADD COLUMN extra_col TEXT", check: r => db.tables['test_types'].getColumnNames().includes('extra_col') },
        { name: "DDL: ALTER RENAME COLUMN", sql: "ALTER TABLE test_types RENAME COLUMN extra_col TO new_extra", check: r => db.tables['test_types'].getColumnNames().includes('new_extra') && !db.tables['test_types'].getColumnNames().includes('extra_col') },
        { name: "DDL: ALTER DROP COLUMN", sql: "ALTER TABLE test_types DROP COLUMN new_extra", check: r => !db.tables['test_types'].getColumnNames().includes('new_extra') },

        // FOREIGN KEY テスト
        // v1.27: FK の参照先には PRIMARY KEY / UNIQUE が必要（実DBと同じ規則）になったので
        // 親側に PK を付ける。このテスト群が確かめたいのは FK の強制であって PK の不在ではない
        { name: "FK: Create Parent", sql: "CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)", check: r => true },
        { name: "FK: Insert Parent", sql: "INSERT INTO fk_parent (id) VALUES (1), (2)", check: r => true },
        { name: "FK: Create Child", sql: "CREATE TABLE fk_child (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fk_parent(id))", check: r => true },
        { name: "FK: Insert Valid Child", sql: "INSERT INTO fk_child (id, p_id) VALUES (10, 1)", check: r => r.data[0].Message.includes('1') },
        errCase("FK: Insert Invalid Child", "INSERT INTO fk_child (id, p_id) VALUES (20, 99)", 'Foreign key constraint failed'),
        errCase("FK: Delete Parent Blocked", "DELETE FROM fk_parent WHERE id = 1", 'Foreign key constraint failed'),
        errCase("FK: Update Child Invalid", "UPDATE fk_child SET p_id = 99 WHERE id = 10", 'Foreign key constraint failed'),
        errCase("FK: Update Parent Blocked", "UPDATE fk_parent SET id = 99 WHERE id = 1", 'Foreign key constraint failed'),
        { name: "FK: Delete Parent Allowed", sql: "DELETE FROM fk_parent WHERE id = 2", check: r => r.data[0].Message.includes('1') },

        // コア技術動作テスト
        { name: "Core Tech: 32-bit Packing Types Check", sql: "CREATE TABLE core_pack (i INTEGER, f FLOAT, s TEXT, b BOOLEAN, d DATE)", check: r => r.data[0].Result === "Success" },
        { name: "Core Tech: Packing Insert", sql: "INSERT INTO core_pack (i, f, s, b, d) VALUES (12345, 3.1415, 'packed_string', true, '2026-07-02')", check: r => r.data[0].Message.includes('1') },
        { name: "Core Tech: Packing Verify Meta", fn: () => {
            const t = db.tables['core_pack'];
            const iMeta = t.cols['i'].meta[0] >>> 24; // 1
            const fMeta = t.cols['f'].meta[0] >>> 24; // 1
            const sMeta = t.cols['s'].meta[0] >>> 24; // 2
            const bMeta = t.cols['b'].meta[0] >>> 24; // 3
            const dMeta = t.cols['d'].meta[0] >>> 24; // 4
            const sVal = t.getValue('s', 0);
            return iMeta === 1 && fMeta === 1 && sMeta === 2 && bMeta === 3 && dMeta === 4 && sVal === 'packed_string';
        }},
        { name: "Core Tech: Zero Alloc Update", fn: () => {
            db.executeQuery("CREATE TABLE test_alloc (id INTEGER, val INTEGER)");
            db.executeQuery("INSERT INTO test_alloc (id, val) VALUES (1, 100), (2, 200)");
            const capBefore = db.tables['test_alloc'].capacity;
            db.executeQuery("UPDATE test_alloc SET val = val + 1");
            const capAfter = db.tables['test_alloc'].capacity;
            db.executeQuery("DROP TABLE test_alloc");
            return capBefore === capAfter;
        }},
        { name: "Core Tech: Hash Join Correctness", fn: () => {
            const res = db.executeQuery("SELECT a.id, b.note FROM test_a a JOIN test_b b ON a.id = b.a_id WHERE b.note = 'X'");
            const explain = db.executeQuery("EXPLAIN SELECT a.id, b.note FROM test_a a JOIN test_b b ON a.id = b.a_id WHERE b.note = 'X'");
            const isHashJoin = explain.data.some(d => d.Operation.includes('HASH JOIN'));
            return isHashJoin && res.data.length > 0 && res.data[0].note === 'X';
        }},

        // Window Functions
        { name: "Window ROW_NUMBER", sql: "SELECT id, ROW_NUMBER() OVER(PARTITION BY category ORDER BY id ASC) as rn FROM test_a WHERE val IS NOT NULL ORDER BY id ASC", check: r => r.data.length === 4 && r.data[0].id === 1 && r.data[0].rn === 1 && r.data[1].id === 2 && r.data[1].rn === 1 && r.data[2].id === 3 && r.data[2].rn === 2 },
        { name: "Window RANK", sql: "SELECT id, val, RANK() OVER(ORDER BY val DESC) as rnk FROM test_a WHERE val IS NOT NULL ORDER BY rnk ASC, id ASC", check: r => r.data[0].rnk === 1 && r.data[1].rnk === 2 && r.data[2].rnk === 3 && r.data[3].rnk === 3 },
        { name: "Window SUM", sql: "SELECT id, category, SUM(val) OVER(PARTITION BY category ORDER BY id ASC) as cumsum FROM test_a WHERE val IS NOT NULL ORDER BY id ASC", check: r => r.data[0].cumsum === 100 && r.data[2].cumsum === 400 },

        // DML Truncate
        { name: "Truncate Table", sql: "TRUNCATE TABLE test_trunc", check: r => r.data[0].Message.includes('7 rows') },
        { name: "Verify Truncate", sql: "SELECT * FROM test_trunc", check: r => r.data.length === 0 },

        // DML Zero Match
        { name: "Update Zero Match", sql: "UPDATE test_a SET val = 0 WHERE id = -1", check: r => r.data[0].Message.includes('0 rows') },
        { name: "Delete Zero Match", sql: "DELETE FROM test_a WHERE id = -1", check: r => r.data[0].Message.includes('0 rows') },

        // DQL WHERE IS NULL / IS NOT NULL
        { name: "IS NULL", sql: "SELECT * FROM test_a WHERE val IS NULL", check: r => r.data.length === 1 && r.data[0].id === 5 },
        { name: "IS NOT NULL", sql: "SELECT * FROM test_a WHERE val IS NOT NULL", check: r => r.data.length === 4 },

        // DQL Logic & Pattern
        { name: "LIKE %", sql: "SELECT * FROM test_a WHERE category LIKE 'Cat%'", check: r => r.data.length === 5 },
        { name: "LIKE _", sql: "SELECT * FROM test_a WHERE category LIKE 'Cat_'", check: r => r.data.length === 5 },
        { name: "NOT LIKE", sql: "SELECT * FROM test_a WHERE category NOT LIKE 'Cat1'", check: r => r.data.length === 2 },
        { name: "Complex Logic", sql: "SELECT * FROM test_a WHERE (val > 150 AND category = 'Cat2') OR (id = 1)", check: r => r.data.length === 2 },

        // DQL Zero Match
        { name: "Select Zero Match", sql: "SELECT * FROM test_a WHERE id = -1", check: r => r.data.length === 0 },

        // DQL JOIN
        { name: "Inner Join", sql: "SELECT a.id, b.note FROM test_a a JOIN test_b b ON a.id = b.a_id", check: r => r.data.length === 2 && r.data[0].note === 'X' },
        { name: "Left Join", sql: "SELECT a.id, b.note FROM test_a a LEFT JOIN test_b b ON a.id = b.a_id ORDER BY a.id ASC", check: r => r.data.length === 5 && r.data[2].note === null },
        { name: "Self Join", sql: "SELECT a1.id, a2.val FROM test_a a1 JOIN test_a a2 ON a1.id = a2.id WHERE a1.id = 1", check: r => r.data.length === 1 && r.data[0].val === 100 },

        // DQL Multi JOIN & Multi WHERE
        { name: "Multi JOIN & WHERE", sql: "SELECT a.id, b.note, c.c_val FROM test_a a JOIN test_b b ON a.id = b.a_id JOIN test_c c ON a.id = c.id WHERE a.val >= 100 AND b.note = 'X' AND c.c_val = 'C1'", check: r => r.data.length === 1 && r.data[0].c_val === 'C1' },

        // JOIN Edge Cases
        { name: "Join No Match", sql: "SELECT a.id FROM test_a a JOIN test_b b ON a.id = b.a_id WHERE a.id = -1", check: r => r.data.length === 0 },
        { name: "Multi Join Mixed", sql: "SELECT a.id, b.note, c.c_val FROM test_a a JOIN test_b b ON a.id = b.a_id LEFT JOIN test_c c ON a.id = c.id ORDER BY a.id", check: r => r.data.length === 2 && r.data[0].note === 'X' && r.data[0].c_val === 'C1' && r.data[1].note === 'Y' && r.data[1].c_val === 'C2' },

        // DQL WHERE & BETWEEN & IN
        { name: "Where Between", sql: "SELECT * FROM test_a WHERE val BETWEEN 150 AND 350", check: r => r.data.length === 2 },
        { name: "IN", sql: "SELECT * FROM test_a WHERE id IN (2,3)", check: r => r.data.length === 2 },
        { name: "NOT IN", sql: "SELECT * FROM test_a WHERE id NOT IN (1, 2)", check: r => r.data.length === 3 },

        // DQL CASE
        { name: "Case When", sql: "SELECT id, CASE WHEN val > 150 THEN 'High' ELSE 'Low' END AS lvl FROM test_a ORDER BY id ASC", check: r => r.data[0].lvl === 'Low' && r.data[1].lvl === 'High' },
        { name: "Case Else Null", sql: "SELECT id, CASE WHEN val = 100 THEN 'Hundred' END AS c FROM test_a ORDER BY id ASC", check: r => r.data[0].c === 'Hundred' && r.data[1].c === null },

        // DQL DISTINCT
        { name: "Select DISTINCT 1 Col", sql: "SELECT DISTINCT category FROM test_a ORDER BY category", check: r => r.data.length === 2 && r.data[0].category === 'Cat1' },
        { name: "Select DISTINCT Multi", sql: "SELECT DISTINCT val, category FROM test_a WHERE val IS NOT NULL ORDER BY val", check: r => r.data.length === 4 },

        // DQL Advanced String & Math Functions
        { name: "Funcs CONCAT, REPLACE, TRIM", sql: "SELECT CONCAT(category, '-', id) as c, REPLACE(category, 'Cat', 'Dog') as r, TRIM('  abc  ') as t FROM test_a WHERE id = 1", check: r => r.data[0].c === 'Cat1-1' && r.data[0].r === 'Dog1' && r.data[0].t === 'abc' },
        { name: "Funcs Math & Date 1", sql: "SELECT ABS(-5) as a, CEIL(4.2) as c, FLOOR(4.8) as f, NOW() as n FROM test_a WHERE id = 1", check: r => r.data[0].a === 5 && r.data[0].c === 5 && r.data[0].f === 4 && r.data[0].n !== null },
        { name: "Funcs Math & Date 2", sql: "SELECT MOD(val, 3) as m, SIGN(val - 200) as s, ROUND(RAND()) as rnd FROM test_a WHERE id = 1", check: r => r.data[0].m === 1 && r.data[0].s === -1 && typeof r.data[0].rnd === 'number' },
        { name: "Funcs Date", sql: "SELECT YEAR(NOW()) as y, MONTH('2026-06-27') as m, DAY('2026-06-27') as d FROM test_a LIMIT 1", check: r => r.data[0].y === new Date().getFullYear() && r.data[0].m === 6 && r.data[0].d === 27 },
        { name: "Arithmetic", sql: "SELECT (val * 2 + 10) / 2 as calc FROM test_a WHERE id = 1", check: r => r.data[0].calc === 105 },
        { name: "COALESCE & SUBSTR", sql: "SELECT COALESCE(val, 0) as cv, SUBSTRING(category, 1, 3) as sub FROM test_a WHERE id = 5", check: r => r.data[0].cv === 0 && r.data[0].sub === 'Cat' },
        { name: "MAX / MIN", sql: "SELECT MAX(val) as mx, MIN(val) as mn FROM test_a", check: r => r.data[0].mx === 300 && r.data[0].mn === 100 },
        { name: "Funcs LPAD, RPAD", sql: "SELECT LPAD(id, 3, '0') as lp, RPAD(id, 3, '-') as rp FROM test_a WHERE id = 1", check: r => r.data[0].lp === '001' && r.data[0].rp === '1--' },
        { name: "Funcs POWER, SQRT", sql: "SELECT POWER(val, 2) as p, SQRT(val) as s FROM test_a WHERE val = 100 LIMIT 1", check: r => r.data[0].p === 10000 && r.data[0].s === 10 },
        { name: "Funcs NULL inputs", sql: "SELECT UPPER(null) as u, ROUND(null) as r FROM test_a LIMIT 1", check: r => r.data[0].u === null && r.data[0].r === null },

        // DQL Complex Arithmetic & Func Edge
        { name: "Complex Arithmetic", sql: "SELECT ((val + 10) * 2) / 5 as calc FROM test_a WHERE id = 1", check: r => r.data[0].calc === 44 },
        { name: "Func CONCAT null", sql: "SELECT CONCAT('A', null, 'B') as c FROM test_a LIMIT 1", check: r => r.data[0].c === 'AB' },
        { name: "Func REPLACE no-op", sql: "SELECT REPLACE(category, 'XYZ', 'ABC') as r FROM test_a WHERE id = 1", check: r => r.data[0].r === 'Cat1' },

        // DQL Group By & NULL count ignore (COUNT(col))
        { name: "Count NULL Ignore", sql: "SELECT category, COUNT(val) AS val_cnt, COUNT(*) AS total_cnt FROM test_a GROUP BY category ORDER BY category ASC", check: r => r.data[0].val_cnt === 2 && r.data[0].total_cnt === 3 && r.data[1].val_cnt === 2 },

        // DQL Group By Multi-Column
        { name: "Group By Multi", sql: "SELECT category, val, COUNT(*) as c FROM test_a GROUP BY category, val ORDER BY category ASC, val ASC", check: r => r.data.length === 5 && r.data[0].c === 1 },

        // DQL Multi-Column ORDER BY
        { name: "Multi-Col ORDER BY", sql: "SELECT id, val FROM test_a ORDER BY val ASC, id DESC", check: r => r.data[0].id === 5 && r.data[1].id === 4 && r.data[2].id === 1 },
        { name: "Order By NULL ASC", sql: "SELECT id, val FROM test_a ORDER BY val ASC", check: r => r.data[0].id === 5 },
        { name: "Order By NULL DESC", sql: "SELECT id, val FROM test_a ORDER BY val DESC", check: r => r.data[r.data.length - 1].id === 5 },

        // DQL Group By & Having
        { name: "Group By Having", sql: "SELECT note, COUNT(*) as c FROM test_b GROUP BY note HAVING c > 0", check: r => r.data.length === 3 },

        // DQL Subquery
        { name: "Subquery IN", sql: "SELECT * FROM test_a WHERE id IN (SELECT a_id FROM test_b)", check: r => r.data.length === 2 },
        { name: "Subquery NOT IN", sql: "SELECT * FROM test_a WHERE id NOT IN (SELECT a_id FROM test_b)", check: r => r.data.length === 3 },
        { name: "Subquery Empty", sql: "SELECT * FROM test_a WHERE id IN (SELECT id FROM test_empty)", check: r => r.data.length === 0 },

        // Complex Integration Tests (複合クエリ)
        { name: "Cplx: All Clauses", sql: "SELECT a.category, COUNT(b.note) as note_cnt, SUM(a.val) as total_val FROM test_a a LEFT JOIN test_b b ON a.id = b.a_id WHERE a.val > 100 GROUP BY a.category HAVING total_val > 200 ORDER BY note_cnt DESC, a.category ASC LIMIT 5", check: r => r.data.length === 1 && r.data[0].category === 'Cat1' && r.data[0].note_cnt === 0 && r.data[0].total_val === 300 },
        { name: "Cplx: Func+Dist+Ord", sql: "SELECT DISTINCT UPPER(category) as u_cat, ROUND(val/10) as r_val FROM test_a WHERE val IS NOT NULL ORDER BY u_cat DESC, r_val ASC", check: r => r.data.length === 4 && r.data[0].u_cat === 'CAT2' && r.data[0].r_val === 10 && r.data[3].u_cat === 'CAT1' && r.data[3].r_val === 30 },
        { name: "Cplx: From SubQ+Join", sql: "SELECT sub.u_cat, sub.total, c.id FROM (SELECT UPPER(category) as u_cat, SUM(val) as total FROM test_a GROUP BY category) sub LEFT JOIN test_c c ON sub.u_cat = CONCAT('CAT', SUBSTRING(c.c_val, 2, 1)) ORDER BY sub.total DESC", check: r => r.data.length === 2 && r.data[0].u_cat === 'CAT1' && r.data[0].id === 1 && r.data[1].u_cat === 'CAT2' && r.data[1].id === 2 },
        { name: "Cplx: Where SubQ+Math", sql: "SELECT id, ABS(val - 250) as diff FROM test_a WHERE id IN (SELECT a_id FROM test_b WHERE note LIKE 'X%') OR (val IS NOT NULL AND val < 200) ORDER BY diff ASC", check: r => r.data.length === 2 && r.data[0].diff === 150 && r.data[1].diff === 150 },
        { name: "Cplx: M-Join+Case+Str", sql: "SELECT a.id, CONCAT(a.category, ':', COALESCE(b.note, 'NONE')) as info, CASE WHEN c.c_val IS NULL THEN 0 ELSE 1 END as has_c FROM test_a a LEFT JOIN test_b b ON a.id = b.a_id LEFT JOIN test_c c ON a.id = c.id ORDER BY a.id DESC", check: r => r.data.length === 5 && r.data[0].id === 5 && r.data[0].info === 'Cat1:NONE' && r.data[0].has_c === 0 && r.data[4].id === 1 && r.data[4].info === 'Cat1:X' && r.data[4].has_c === 1 },
        { name: "Cplx: Not In + Join", sql: "SELECT a.id, b.note FROM test_a a JOIN test_b b ON a.id = b.a_id WHERE a.id NOT IN (SELECT id FROM test_c WHERE c_val = 'C2') ORDER BY a.id", check: r => r.data.length === 1 && r.data[0].id === 1 && r.data[0].note === 'X' },
        { name: "Cplx: Tx Update", sql: "BEGIN", check: r => true },
        { name: "Cplx: Tx Update Exec", sql: "UPDATE test_a SET val = ROUND(val * 1.5) WHERE id IN (SELECT a_id FROM test_b WHERE note IS NOT NULL) AND val > 150", check: r => r.data[0].Message.includes('1') },
        { name: "Cplx: Tx Verify Update", sql: "SELECT val FROM test_a WHERE id = 2", check: r => r.data[0].val === 300 },
        { name: "Cplx: Tx Rollback", sql: "ROLLBACK", check: r => true },

        // Complex Integration Tests Part 2
        { name: "Cplx2: Nested String Funcs", sql: "SELECT CONCAT(UPPER(category), '-', LPAD(id, 3, '0')) as code FROM test_a WHERE id = 1", check: r => r.data[0].code === 'CAT1-001' },
        { name: "Cplx2: Conditional Sum", sql: "SELECT category, SUM(CASE WHEN val > 150 THEN val ELSE 0 END) as s FROM test_a GROUP BY category ORDER BY category ASC", check: r => r.data[0].s === 300 && r.data[1].s === 200 },
        { name: "Cplx2: Left Join + Coalesce", sql: "SELECT a.id, COALESCE(b.note, 'Missing') as n FROM test_a a LEFT JOIN test_b b ON a.id = b.a_id ORDER BY a.id DESC LIMIT 3", check: r => r.data[0].id === 5 && r.data[0].n === 'Missing' && r.data[2].id === 3 && r.data[2].n === 'Missing' },
        { name: "Cplx2: Deep Subqueries", sql: "SELECT * FROM test_a WHERE id IN (SELECT a_id FROM test_b WHERE a_id IN (SELECT id FROM test_c))", check: r => r.data.length === 2 && r.data[0].id === 1 },
        { name: "Cplx2: Math combination", sql: "SELECT ROUND(POWER(val, 2) / 100) + ABS(-10) as calc FROM test_a WHERE id = 1", check: r => r.data[0].calc === 110 },
        { name: "Cplx2: Multi-Condition Join", sql: "SELECT a.id FROM test_a a JOIN test_b b ON a.id = b.a_id AND a.val > 150", check: r => r.data.length === 1 && r.data[0].id === 2 },
        { name: "Cplx2: SubQ in FROM + Grp", sql: "SELECT sub.c, SUM(sub.val) as s FROM (SELECT category as c, val FROM test_a WHERE val IS NOT NULL) sub GROUP BY sub.c ORDER BY sub.c ASC", check: r => r.data.length === 2 && r.data[0].c === 'Cat1' && r.data[0].s === 400 },
        { name: "Cplx2: SubQ in FROM + Join", sql: "SELECT sub.id, sub.c, b.note FROM (SELECT id, category as c FROM test_a WHERE id < 3) sub JOIN test_b b ON sub.id = b.a_id ORDER BY sub.id ASC", check: r => r.data.length === 2 && r.data[1].note === 'Y' },
        { name: "Cplx2: Complex WHERE Date", sql: "SELECT * FROM test_a WHERE YEAR(NOW()) >= 2024 AND id IN (1, 2) AND category LIKE '%Cat%'", check: r => r.data.length === 2 },
        { name: "Cplx2: Self Join with Math", sql: "SELECT a1.id, a1.val + a2.val as v FROM test_a a1 JOIN test_a a2 ON a1.id = a2.id - 1 WHERE a1.id = 1", check: r => r.data.length === 1 && r.data[0].v === 300 },
        { name: "Cplx2: Triple Join with Agg", sql: "SELECT c.c_val, COUNT(a.id) as cnt FROM test_c c LEFT JOIN test_a a ON c.id = a.id LEFT JOIN test_b b ON a.id = b.a_id GROUP BY c.c_val ORDER BY c.c_val ASC", check: r => r.data.length === 2 && r.data[0].cnt === 1 && r.data[1].cnt === 1 },
        { name: "Cplx2: ORDER BY with Nulls", sql: "SELECT COALESCE(val, 0) as v, id FROM test_a ORDER BY v ASC, id DESC", check: r => r.data[0].v === 0 && r.data[0].id === 5 && r.data[1].v === 100 && r.data[1].id === 4 },
        { name: "Cplx2: HAVING with Math", sql: "SELECT category, AVG(val) as a FROM test_a GROUP BY category HAVING a > 150 ORDER BY category ASC", check: r => r.data.length === 1 && r.data[0].category === 'Cat1' },
        { name: "Cplx2: Update with SubQ", sql: "UPDATE test_a SET val = 500 WHERE id IN (SELECT id FROM test_c WHERE c_val = 'C1')", check: r => r.data[0].Message.includes('1') },
        { name: "Cplx2: Verify Update SubQ", sql: "SELECT val FROM test_a WHERE id = 1", check: r => r.data[0].val === 500 },
        { name: "Cplx2: Delete with SubQ", sql: "DELETE FROM test_a WHERE id IN (SELECT id FROM test_c WHERE c_val = 'C2')", check: r => r.data[0].Message.includes('1') },
        { name: "Cplx2: Verify Delete SubQ", sql: "SELECT * FROM test_a WHERE id = 2", check: r => r.data.length === 0 },
        { name: "Cplx2: Cartesian Product", sql: "SELECT a.id, b.a_id FROM test_a a JOIN test_b b ON 1 = 1 WHERE a.id = 1", check: r => r.data.length === 3 },
        { name: "Cplx2: Multiple Aggregates", sql: "SELECT COUNT(*) as c, SUM(val) as s, MAX(val) as mx, MIN(val) as mn FROM test_a", check: r => r.data[0].c === 4 && r.data[0].s === 900 && r.data[0].mx === 500 && r.data[0].mn === 100 },
        { name: "Cplx2: Eval Math Chain", sql: "SELECT ROUND(SQRT(POWER(val, 2)) + MOD(val, 3)) as calc FROM test_a WHERE id = 4", check: r => r.data[0].calc === 101 },
        { name: "Cplx2: Distinct with Funcs", sql: "SELECT DISTINCT COALESCE(val, -1) as v FROM test_a ORDER BY v ASC", check: r => r.data.length === 4 && r.data[0].v === -1 },

        // Massive Complex Integration Tests (大規模・複雑クエリテスト群 Part 3)
        { name: "Mega Cplx: 4-Table Join Agg", sql: "SELECT u.name, SUM(o.amount * p.price) as total FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id GROUP BY u.name HAVING total > 1000 ORDER BY total DESC", check: r => r.data.length === 2 && r.data[0].name === 'Charlie' && r.data[0].total === 4000 && r.data[1].name === 'Alice' },
        { name: "Mega Cplx: Multi-Level Subquery IN", sql: "SELECT name FROM products WHERE id IN (SELECT product_id FROM orders WHERE user_id IN (SELECT id FROM users WHERE age >= 25)) ORDER BY name ASC", check: r => r.data.length === 4 && r.data[0].name === 'Keyboard' },
        { name: "Mega Cplx: Subquery in FROM + Left Join + Window", sql: "SELECT sub.name, COALESCE(o.amount, 0) as amt, ROW_NUMBER() OVER(PARTITION BY sub.name ORDER BY o.amount DESC) as rn FROM (SELECT id, name FROM users WHERE age > 25) sub LEFT JOIN orders o ON sub.id = o.user_id ORDER BY sub.name ASC, rn ASC LIMIT 3", check: r => r.data.length === 3 && r.data[0].name === 'Bob' && r.data[0].amt === 2 },
        { name: "Mega Cplx: Deep Math & String Chain", sql: "SELECT CONCAT(UPPER(SUBSTRING(name, 1, 3)), '-', LPAD(ROUND(price / 100), 3, '0')) as sku, price FROM products WHERE stock > 0 ORDER BY price DESC LIMIT 1", check: r => r.data[0].sku === 'LAP-015' },
        { name: "Mega Cplx: Complex Logic WHERE", sql: "SELECT COUNT(*) as c FROM users WHERE (age >= 30 AND age < 45) OR (name LIKE 'A%' AND age < 30) AND NOT (id = 99)", check: r => r.data[0].c === 5 },
        { name: "Mega Cplx: Having with Multiple Aggregates", sql: "SELECT category, SUM(val) as s, MAX(val) as m, MIN(val) as mn FROM test_a GROUP BY category HAVING s > 100 AND m = 500 ORDER BY category", check: r => r.data.length === 1 && r.data[0].category === 'Cat1' },
        { name: "Mega Cplx: Multi Window Funcs", sql: "SELECT id, ROW_NUMBER() OVER(ORDER BY age DESC) as rn, RANK() OVER(ORDER BY name ASC) as rnk FROM users WHERE age > 20 ORDER BY rn ASC LIMIT 2", check: r => r.data.length === 2 && r.data[0].rn === 1 && r.data[0].rnk >= 1 },
        { name: "Mega Cplx: Subquery in DELETE", sql: "BEGIN", check: r=>true},
        { name: "Mega Cplx: Subquery in DELETE Exec", sql: "DELETE FROM users WHERE id IN (SELECT user_id FROM orders WHERE amount < 2)", check: r => r.data[0].Message.includes('2')},
        { name: "Mega Cplx: Tx Integrity Check", sql: "SELECT COUNT(*) as c FROM users", check: r => r.data[0].c === 8},
        { name: "Mega Cplx: Tx ROLLBACK", sql: "ROLLBACK", check: r=>true},
        { name: "Cplx3: Self Join 3 Levels", sql: "SELECT u1.name as n1, u2.name as n2, u3.name as n3 FROM users u1 JOIN users u2 ON u1.id = u2.id - 1 JOIN users u3 ON u2.id = u3.id - 1 WHERE u1.id = 1", check: r => r.data[0].n1 === 'Alice' && r.data[0].n2 === 'Bob' && r.data[0].n3 === 'Charlie' },
        { name: "Cplx3: Nested Math + String + Date", sql: "SELECT CONCAT(YEAR(NOW()), '-', LPAD(CEIL(ABS(-9.8)), 3, '0')) as res FROM users LIMIT 1", check: r => r.data[0].res.endsWith('-010') },
        { name: "Cplx3: Join with IS NULL", sql: "SELECT u.id, u.name FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE o.order_id IS NULL ORDER BY u.id ASC LIMIT 3", check: r => r.data.length === 3 && r.data[0].name === 'Eve' },
        { name: "Cplx3: Aggregation on CASE Subquery", sql: "SELECT sub.gen, COUNT(*) as c FROM (SELECT CASE WHEN age < 30 THEN '20s' WHEN age < 40 THEN '30s' ELSE '40s' END as gen FROM users) sub GROUP BY sub.gen ORDER BY sub.gen ASC", check: r => r.data.length === 3 && r.data[0].gen === '20s' && r.data[0].c === 6 },
        { name: "Cplx3: Double Left Join", sql: "SELECT u.name, p.name as p_name FROM users u LEFT JOIN orders o ON u.id = o.user_id LEFT JOIN products p ON o.product_id = p.id WHERE u.id = 5", check: r => r.data[0].name === 'Eve' && r.data[0].p_name === null },
        { name: "Cplx3: Update with Math", sql: "BEGIN", check: r=>true},
        { name: "Cplx3: Update Math Exec", sql: "UPDATE products SET price = ROUND(price * 0.9) WHERE stock >= 50", check: r => r.data[0].Message.includes('2 rows') },
        { name: "Cplx3: Update Math Verify", sql: "SELECT price FROM products WHERE id = 103", check: r => r.data[0].price === 108 },
        { name: "Cplx3: Rollback", sql: "ROLLBACK", check: r=>true},
        { name: "Cplx4: MAX and MIN string", sql: "SELECT MAX(name) as mx, MIN(name) as mn FROM users", check: r => r.data[0].mx === 'Judy' && r.data[0].mn === 'Alice' },
        { name: "Cplx4: Multiple conditions in HAVING", sql: "SELECT user_id, SUM(amount) as s, COUNT(*) as c FROM orders GROUP BY user_id HAVING s > 1 AND c = 2", check: r => r.data.length === 1 && r.data[0].user_id === 1 },
        { name: "Cplx4: COALESCE chain", sql: "SELECT COALESCE(null, null, name, 'Unknown') as stat FROM users WHERE id = 1", check: r => r.data[0].stat === 'Alice' },
        { name: "Cplx4: SUBSTRING extraction", sql: "SELECT SUBSTRING(name, 2, 3) as s FROM users WHERE id = 3", check: r => r.data[0].s === 'har' },
        { name: "Cplx4: TRIM spaces", sql: "SELECT TRIM(CONCAT('  ', name, '  ')) as t FROM users WHERE id = 1", check: r => r.data[0].t === 'Alice' },
        { name: "Cplx4: Power and Mod", sql: "SELECT POWER(MOD(age, 10), 2) as p FROM users WHERE id = 1", check: r => r.data[0].p === 25 },
        { name: "Cplx4: NOT IN large list", sql: "SELECT COUNT(*) as c FROM users WHERE id NOT IN (1,2,3,4,5,6,7,8,9)", check: r => r.data[0].c === 1 },
        { name: "Cplx4: IN single item", sql: "SELECT COUNT(*) as c FROM users WHERE id IN (10)", check: r => r.data[0].c === 1 },
        { name: "Cplx5: Multiple Subqueries", sql: "SELECT a.name, b.amount FROM (SELECT id, name FROM users WHERE age >= 25) a JOIN (SELECT user_id, amount FROM orders WHERE amount >= 2) b ON a.id = b.user_id ORDER BY b.amount DESC", check: r => r.data.length === 1 && r.data[0].amount === 2 },
        { name: "Cplx5: Replace nested", sql: "SELECT REPLACE(REPLACE(name, 'a', '@'), 'e', '3') as r FROM users WHERE id = 4", check: r => r.data[0].r === 'D@v3' },
        { name: "Cplx5: SIGN and ABS", sql: "SELECT SIGN(-50) * ABS(-100) as v FROM test_a LIMIT 1", check: r => r.data[0].v === -100 },
        { name: "Cplx5: FLOOR and CEIL", sql: "SELECT CEIL(1.1) + FLOOR(1.9) as v FROM test_a LIMIT 1", check: r => r.data[0].v === 3 },
        { name: "Cplx5: Count distinct sim", sql: "SELECT COUNT(sub.st) as c FROM (SELECT DISTINCT CASE WHEN age >= 30 THEN 1 ELSE 0 END as st FROM users) sub", check: r => r.data[0].c === 2 },
        { name: "Cplx5: Random generator", sql: "SELECT RAND() >= 0 as r FROM test_a LIMIT 1", check: r => r.data[0].r === true },
        { name: "Cplx6: Window Func Partition", sql: "SELECT id, age, ROW_NUMBER() OVER(PARTITION BY CASE WHEN age >= 30 THEN 1 ELSE 0 END ORDER BY age DESC) as rn FROM users WHERE id IN (3, 7) ORDER BY age DESC", check: r => r.data.length === 2 && r.data[0].rn === 1 && r.data[0].id === 7 && r.data[1].rn === 2 && r.data[1].id === 3 },
        { name: "Cplx6: Window Func No Partition", sql: "SELECT id, age, RANK() OVER(ORDER BY age ASC) as rn FROM users ORDER BY age ASC LIMIT 3", check: r => r.data[0].rn === 1 && r.data[2].rn === 3 },

        // Negative Tests & Extra Boundaries (異常系 Part 2 + ランダムファジング)
        errCase("Neg: Empty Query", "   "),
        errCase("Neg: SELECT without FROM", "SELECT * test_a"),
        errCase("Neg: SELECT missing col", "SELECT no_such_col FROM test_a"),
        errCase("Neg: GROUP BY missing col", "SELECT COUNT(*) FROM test_a GROUP BY no_such_col"),
        errCase("Neg: ORDER BY missing col", "SELECT * FROM test_a ORDER BY no_such_col"),
        errCase("Neg: INSERT without INTO", "INSERT test_a (id) VALUES (1)"),
        errCase("Neg: UPDATE without SET", "UPDATE test_a id = 1"),
        errCase("Neg: DELETE without FROM", "DELETE test_a WHERE id = 1"),
        errCase("Neg: DROP missing table", "DROP TABLE missing_table"),
        errCase("Neg: TRUNCATE missing table", "TRUNCATE TABLE missing_table"),
        errCase("Neg: CREATE INDEX missing tbl", "CREATE INDEX idx1 ON missing_tbl (id)"),
        errCase("Neg: CREATE INDEX missing col", "CREATE INDEX idx1 ON test_a (missing_col)"),
        { name: "Neg: Double BEGIN", fn: () => { db.executeQuery("BEGIN"); let r = db.executeQuery("BEGIN"); db.executeQuery("ROLLBACK"); return r.error !== undefined; }},
        { name: "Neg: Double COMMIT", fn: () => { db.executeQuery("BEGIN"); db.executeQuery("COMMIT"); let r = db.executeQuery("COMMIT"); return r.error !== undefined; }},
        { name: "Neg: Double ROLLBACK", fn: () => { db.executeQuery("BEGIN"); db.executeQuery("ROLLBACK"); let r = db.executeQuery("ROLLBACK"); return r.error !== undefined; }},
        errCase("Neg: SELECT missing table", "SELECT * FROM not_exists"),
        { name: "Neg: WHERE invalid math", sql: "SELECT * FROM test_a WHERE val + 'abc' = 100", check: r => r.data.length === 0 },
        errCase("Neg: INSERT values missing", "INSERT INTO test_a (id, val) VALUES ()"),
        errCase("Neg: UPDATE Syntax Error", "UPDATE test_a SET val = 10 WHERE"),
        errCase("Neg: CREATE TABLE Syntax", "CREATE TABLE"),
        errCase("Neg: CREATE TABLE missing name", "CREATE TABLE ()"),
        errCase("Neg: CREATE TABLE existing name", "CREATE TABLE test_a (id)"),
        errCase("Neg: INSERT missing values", "INSERT INTO test_a (id) VALUES "),
        errCase("Neg: DROP missing table 2", "DROP TABLE not_exists"),
        errCase("Neg: Update Invalid Col", "UPDATE test_a SET invalid_col = 1"),
        errCase("Neg: Update syntax", "UPDATE test_a 1=1"),
        errCase("Neg: Delete syntax", "DELETE test_a"),
        errCase("Neg: Select invalid func", "SELECT NOT_EXISTS_FUNC(val) FROM test_a"),

        { name: "Edge: Multi-Delete Empty", sql: "DELETE FROM test_empty WHERE id = 1", check: r => r.data[0].Message.includes('0 rows') },
        { name: "Edge: Multi-Update Empty", sql: "UPDATE test_empty SET none = 1 WHERE id = 1", check: r => r.data[0].Message.includes('0 rows') },
        { name: "Edge: Huge LIMIT & OFFSET", sql: "SELECT * FROM test_a LIMIT 1000000 OFFSET 1000000", check: r => r.data.length === 0 },
        { name: "Fuzz: Whitespace padding", sql: "   \n\t  SELECT \n\n * \t FROM \t  test_a \n LIMIT 1  \n", check: r => r.data.length === 1 },
        { name: "Fuzz: Mixed Case Query", sql: "sElEcT iD fRoM TESt_a wHeRe Id = 1", check: r => r.data.length === 1 && parseInt(Object.values(r.data[0])[0]) === 1 },
        errCase("Edge: Quote not closed", "SELECT * FROM test_a WHERE category = 'Cat1"),

        // Edge Cases & Boundary Part 2
        { name: "Edge: NULL Math operations", sql: "SELECT val + 10 as v FROM test_a WHERE val IS NULL LIMIT 1", check: r => r.data.length === 0 || isNaN(r.data[0].v) || r.data[0].v === 10 || r.data[0].v === null },
        { name: "Edge: Multi-Col Order By Mixed", sql: "SELECT id, val, category FROM test_a ORDER BY category ASC, val DESC, id ASC LIMIT 5", check: r => r.error === undefined && r.data.length > 0 },
        { name: "Edge: Group By Alias", sql: "SELECT category as c, COUNT(*) as cnt FROM test_a GROUP BY category HAVING cnt > 0", check: r => r.data.length > 0 },
        { name: "Edge: LIMIT ALL", sql: "SELECT * FROM test_a LIMIT ALL", check: r => r.data && r.data.length > 0 },
        { name: "Edge: COALESCE all null", sql: "SELECT COALESCE(null, null, null) as c FROM test_a LIMIT 1", check: r => r.data[0].c === null },
        { name: "Edge: CASE no ELSE no match", sql: "SELECT CASE WHEN 1=2 THEN 'A' END as c FROM test_a LIMIT 1", check: r => r.data[0].c === null },
        { name: "Edge: DIV by ZERO", sql: "SELECT 10 / 0 as c FROM test_a LIMIT 1", check: r => r.data[0].c === Infinity || r.data[0].c === null },
        { name: "Edge: String with quotes", sql: "INSERT INTO test_a (id, val, category) VALUES (777, 7, 'O''Reilly')", check: r => r.data[0].Message.includes('1') },
        { name: "Edge: Select String quotes", sql: "SELECT category FROM test_a WHERE id = 777", check: r => r.data[0].category.includes("O'Reilly") || r.data[0].category.includes("O''Reilly") },
        { name: "Edge: Empty string compare", sql: "SELECT COUNT(*) as c FROM test_a WHERE category = '' OR category IS NULL", check: r => r.data[0].c === 0 },
        { name: "Edge: Very large LIMIT", sql: "SELECT * FROM test_a LIMIT 1000000", check: r => r.data.length === db.tables['test_a'].rowCount },
        { name: "Edge: Negative OFFSET", sql: "SELECT * FROM test_a OFFSET -5", check: r => r.data.length === db.tables['test_a'].rowCount },
        { name: "Edge: LIKE wildcard only", sql: "SELECT COUNT(*) as c FROM test_a WHERE category LIKE '%'", check: r => r.data[0].c === db.tables['test_a'].rowCount },
        { name: "Edge: LIKE empty pattern", sql: "SELECT COUNT(*) as c FROM test_a WHERE category LIKE ''", check: r => r.data[0].c === 0 },
        { name: "Edge: Math MAX on empty", sql: "SELECT MAX(id) as m FROM test_empty", check: r => r.data[0].m === null },
        { name: "Edge: Math MIN on empty", sql: "SELECT MIN(id) as m FROM test_empty", check: r => r.data[0].m === null },
        { name: "Edge: SUM on empty", sql: "SELECT SUM(id) as s FROM test_empty", check: r => r.data[0].s === 0 },
        { name: "Edge: COUNT on empty", sql: "SELECT COUNT(*) as c FROM test_empty", check: r => r.data[0].c === 0 },
        { name: "Edge: Window Func Empty", sql: "SELECT ROW_NUMBER() OVER(ORDER BY id) as rn FROM test_empty", check: r => r.data.length === 0 },
        { name: "Bnd: 0 Limit", sql: "SELECT * FROM test_a LIMIT 0", check: r => r.data.length === 0 },
        { name: "Bnd: Float Limit", sql: "SELECT * FROM test_a LIMIT 2.5", check: r => r.data.length === 2 },
        { name: "Bnd: Group by empty string", sql: "SELECT '' as e, COUNT(*) FROM test_a GROUP BY ''", check: r => r.data.length === 1 },
        { name: "Bnd: Long query string", sql: "SELECT * FROM test_a WHERE category = '" + "A".repeat(1000) + "'", check: r => r.data.length === 0 },
        { name: "Bnd: Insert massive numeric", sql: "INSERT INTO test_a (id, val) VALUES (9999, 1e308)", check: r => r.data[0].Message.includes('1') },

        // Data Types & Functions Stress Tests (大量生成)
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress Funcs: CEIL/FLOOR/ABS ${i}`, sql: `SELECT CEIL(ABS(-${i}.5)) + FLOOR(${i}.9) as v FROM test_a LIMIT 1`, check: r => r.data[0].v === (Math.ceil(Math.abs(-i-0.5)) + Math.floor(i+0.9)) })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress Join: Iteration ${i}`, sql: `SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id WHERE u.id = ${(i%4)+1} LIMIT 1`, check: r => r.data.length >= 0 })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress Math: Modulo & Power ${i}`, sql: `SELECT POWER(MOD(${i+10}, 3), 2) as p FROM test_a LIMIT 1`, check: r => r.data[0].p === Math.pow((i+10)%3, 2) })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress String: Padding ${i}`, sql: `SELECT LPAD('${i}', 5, '0') as p FROM test_a LIMIT 1`, check: r => r.data[0].p === String(i).padStart(5, '0') })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress Where: Nested OR/AND ${i}`, sql: `SELECT COUNT(*) as c FROM users WHERE (age > ${i+20} AND age < 50) OR (age < ${i+30} AND age > 10)`, check: r => r.data[0].c >= 0 })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress SubQ: In clause ${i}`, sql: `SELECT COUNT(*) as c FROM products WHERE id IN (SELECT product_id FROM orders WHERE amount >= ${i%3})`, check: r => r.data[0].c >= 0 })),
        ...Array.from({length: 10}).map((_, i) => ({ name: `Stress Group: Count having ${i}`, sql: `SELECT user_id, SUM(amount) as s FROM orders GROUP BY user_id HAVING s >= ${i}`, check: r => r.data.length >= 0 })),

        // Performance Tests (超巨大データ負荷検証)
        { name: "Perf: Gen 100k Rows", fn: () => {
            const start = performance.now();
            db.generateDummyData('test_a', 100000);
            return (performance.now() - start) < 3000 && db.tables['test_a'].rowCount >= 100000;
        }},
        { name: "Perf: Select 100k + Multi JOIN", sql: "SELECT a.id, b.note FROM test_a a JOIN test_b b ON a.id = b.a_id WHERE a.id < 50", check: r => r.data && r.data.length >= 0 },
        { name: "Perf: Select 100k + ORDER", sql: "SELECT * FROM test_a ORDER BY id DESC LIMIT 10", check: r => r.data && r.data.length === 10 },
        { name: "Perf: Update 100k rows", sql: "UPDATE test_a SET val = val + 1", check: r => parseInt(r.data[0].Message) === db.tables['test_a'].rowCount },
        { name: "Perf: Window Func 50k", sql: "SELECT id, ROW_NUMBER() OVER(PARTITION BY category ORDER BY val DESC) as rn FROM test_a LIMIT 50000", check: r => r.data && r.data.length === 50000 },
        { name: "Perf: String Ops 100k", sql: "SELECT COUNT(CONCAT(category, '-', id)) as c FROM test_a", check: r => r.data[0].c === db.tables['test_a'].rowCount },
        { name: "Perf: Distinct 100k", sql: "SELECT DISTINCT category FROM test_a", check: r => r.data.length > 0 },
        { name: "Perf: Group By Multi 100k", sql: "SELECT category, val, COUNT(*) as c FROM test_a GROUP BY category, val", check: r => r.data && r.data.length > 0 },
        { name: "Perf: Delete 50k rows", sql: "DELETE FROM test_a WHERE id > 50000", check: r => {
            if (!r.data || !r.data[0] || !r.data[0].Message) return false;
            let deletedCount = parseInt(r.data[0].Message);
            return deletedCount >= 50000;
        }},

        // [UI Automation & Local Storage/IDB Tests]
        { name: "UI Test: Clear Editor", fn: () => {
            els.query.value = "SELECT * FROM users";
            document.getElementById('clearBtn').click();
            return els.query.value === "";
        }},
        { name: "UI Test: Help Modal Toggle", fn: () => {
            const modal = document.getElementById('helpModal');
            document.getElementById('openHelpBtn').click();
            const opened = !modal.classList.contains('hidden');
            modal.querySelector('.closeModalBtn').click();
            const closed = modal.classList.contains('hidden');
            return opened && closed;
        }},
        { name: "UI Test: Disp Limit Change", fn: () => {
            const bku = currentResultData;
            currentResultData = Array.from({length: 150}, (_, i) => ({ id: i }));

            els.dispLimit.value = "100";
            renderDisplay(true);
            renderDisplay(false);
            const tr100 = els.resArea.querySelectorAll('tbody tr').length;

            els.dispLimit.value = "all";
            renderDisplay(true);
            renderDisplay(false);
            renderDisplay(false);
            const trAll = els.resArea.querySelectorAll('tbody tr').length;

            els.dispLimit.value = "100";
            currentResultData = bku;

            if (tr100 !== 100) throw new Error(`tr100 exp 100 but ${tr100}`);
            if (trAll !== 150) throw new Error(`trAll exp 150 but ${trAll}`);
            return true;
        }},
        { name: "UI Test: Export Btn Disable", fn: () => {
             els.query.value = "SELECT * FROM test_empty";
             document.getElementById('executeBtn').click();
             return document.getElementById('exportCsvBtn').disabled === true;
        }},
        { name: "UI Test: Export Btn Enable", fn: () => {
             els.query.value = "SELECT * FROM test_a LIMIT 1";
             document.getElementById('executeBtn').click();
             return document.getElementById('exportCsvBtn').disabled === false;
        }},
        { name: "UI Test: Interactive Sort ASC", fn: () => {
             els.query.value = "SELECT id, val FROM test_a ORDER BY id DESC LIMIT 5";
             document.getElementById('executeBtn').click();
             const th = els.resArea.querySelector('th[data-col="id"]');
             if(!th) return false;
             th.click();
             const firstRow = els.resArea.querySelector('tbody tr td');
             return firstRow && parseInt(firstRow.textContent) < 100000;
        }},
        { name: "UI Test: Interactive Sort DESC", fn: () => {
             const th = els.resArea.querySelector('th[data-col="id"]');
             if(!th) return false;
             th.click();
             const firstRow = els.resArea.querySelector('tbody tr td');
             return firstRow && parseInt(firstRow.textContent) > 0;
        }},
        { name: "UI Test: Suggest Box Trigger", fn: () => {
             els.query.value = "SELE";
             els.query.selectionStart = els.query.selectionEnd = 4;
             els.query.dispatchEvent(new Event('input'));
             return !els.suggestBox.classList.contains('hidden');
        }},
        { name: "UI Test: Help Category", fn: () => {
             document.getElementById('openHelpBtn').click();
             const sel = document.getElementById('helpTableSelect');
             sel.value = "test_a";
             sel.dispatchEvent(new Event('change'));
             const cmdStr = document.getElementById('helpContent').innerHTML;
             document.getElementById('helpModal').querySelector('.closeModalBtn').click();
             return cmdStr.includes('test_a');
        }},
        { name: "UI Test: Data Gen Invoke", fn: () => {
             document.getElementById('openGeneratorBtn').click();
             document.getElementById('genTableSelect').value = "test_c";
             document.getElementById('genRowCount').value = "5";
             document.getElementById('generateBtn').click();
             return db.tables['test_c'].rowCount >= 5;
        }},
        { name: "UI Test: Export SQL Invoke", fn: () => {
             const sql = db.exportSQL();
             return sql.includes('CREATE TABLE test_a') && sql.includes('INSERT INTO');
        }},
        { name: "UI Test: Invalid SQL Error Msg", fn: () => {
             els.query.value = "SELEECT * FROM users";
             document.getElementById('executeBtn').click();
             return els.resArea.innerHTML.includes('text-red-600');
        }},
        { name: "UI Test: Explain UI Rendering", fn: () => {
             els.query.value = "EXPLAIN SELECT * FROM users";
             document.getElementById('executeBtn').click();
             return els.resArea.innerHTML.includes('TABLE SCAN');
        }},
        { name: "UI Test: Table Editor Open & Preview", fn: () => {
             db.executeQuery("CREATE TABLE test_ed (a, b)");
             openSchemaEditor('test_ed');
             const isOpen = !document.getElementById('schemaModal').classList.contains('hidden');
             const previewText = document.getElementById('schemaPreviewText').textContent;
             document.getElementById('schemaModal').querySelector('.closeModalBtn').click();
             db.executeQuery("DROP TABLE test_ed");
             return isOpen && previewText.includes('CREATE TABLE') && previewText.includes('test_ed');
        }},
        { name: "UI Test: Table Editor Schema Modification", fn: () => {
             db.executeQuery("CREATE TABLE test_mod (col1 INTEGER, col2, col3 TEXT)");
             openSchemaEditor('test_mod');

             // Rename col1 -> renamed_col
             editingSchema.cols[0].newName = 'renamed_col';
             // Change Type of col1 to FLOAT
             editingSchema.cols[0].type = 'FLOAT';
             // Delete col2
             editingSchema.cols[1].isDeleted = true;
             // Add col4 DATE
             editingSchema.cols.push({ oldName: null, newName: 'col4', type: 'DATE', isNew: true, isDeleted: false });
             // Reorder: Move col3 to top
             const col3 = editingSchema.cols.splice(2, 1)[0];
             editingSchema.cols.unshift(col3);

             document.getElementById('execSchemaSaveBtn').click();

             const tbl = db.tables['test_mod'];
             const cols = tbl.getColumnNames();
             const expected = ['col3', 'renamed_col', 'col4'];
             const isMatch = cols.length === expected.length && cols.every((val, index) => val === expected[index]);
             const isTypeMatch = tbl.colTypes['col3'] === 'TEXT' && tbl.colTypes['renamed_col'] === 'FLOAT' && tbl.colTypes['col4'] === 'DATE';

             db.executeQuery("DROP TABLE test_mod");
             return isMatch && isTypeMatch;
        }},
        { name: "UI Test: Type Cast Validation Success", fn: () => {
             db.executeQuery("CREATE TABLE test_cast (val ANY)");
             db.executeQuery("INSERT INTO test_cast (val) VALUES ('123')");
             openSchemaEditor('test_cast');
             editingSchema.cols[0].type = 'INTEGER';
             document.getElementById('execSchemaSaveBtn').click();

             const tbl = db.tables['test_cast'];
             const typeMatch = tbl.colTypes['val'] === 'INTEGER';
             const valMatch = tbl.getValue('val', 0) === 123;

             db.executeQuery("DROP TABLE test_cast");
             return typeMatch && valMatch;
        }},
        { name: "UI Test: Type Cast Validation Fail", fn: () => {
             db.executeQuery("CREATE TABLE test_cast_fail (val ANY)");
             db.executeQuery("INSERT INTO test_cast_fail (val) VALUES ('abc')");
             openSchemaEditor('test_cast_fail');
             editingSchema.cols[0].type = 'INTEGER';
             document.getElementById('execSchemaSaveBtn').click();

             const tbl = db.tables['test_cast_fail'];
             const typeMatch = tbl.colTypes['val'] === 'ANY'; // 失敗時は元の型のまま

             const errEl = document.getElementById('schemaErrorMsg');
             const isErrorShown = !errEl.classList.contains('hidden') && errEl.textContent.includes('Type mismatch');

             document.getElementById('schemaModal').classList.add('hidden');
             db.executeQuery("DROP TABLE test_cast_fail");
             return typeMatch && isErrorShown;
        }},

        { name: "IDB Test: Save (Create)", fn: async () => {
            window.__testDbBackup = db.exportForIDB();
            const bku = await loadDB();
            if (bku) window.__idb_test_bku = bku;

            db.tables = {};

            const t = new Table(); t.addColumn('id'); t.addColumn('info');
            t.setValue('id', 0, 999); t.setValue('info', 0, 'Created'); t.rowCount = 1;
            db.tables['idb_test_tbl'] = t;

            await saveDB(db.exportForIDB());
            const savedDump = await loadDB();
            return savedDump && savedDump['idb_test_tbl'] && savedDump['idb_test_tbl'].rowCount === 1;
        }},
        { name: "IDB Test: Load (Import)", fn: async () => {
            db.tables = {};
            db.importFromIDB(await loadDB());
            return db.tables['idb_test_tbl'] && db.tables['idb_test_tbl'].getValue('id', 0) === 999;
        }},
        { name: "IDB Test: Update", fn: async () => {
            db.tables['idb_test_tbl'].setValue('info', 0, 'Updated');
            await saveDB(db.exportForIDB());
            db.importFromIDB(await loadDB());
            return db.tables['idb_test_tbl'].getValue('info', 0) === 'Updated';
        }},
        { name: "IDB Test: Delete (Clear)", fn: async () => {
            await clearDB();
            const isEmpty = (await loadDB()) === undefined;

            if (window.__idb_test_bku) {
                await saveDB(window.__idb_test_bku);
                delete window.__idb_test_bku;
            }
            if (window.__testDbBackup) {
                db.importFromIDB(window.__testDbBackup);
                delete window.__testDbBackup;
            }
            return isEmpty;
        }},

        // Core Tech & Types (Boundary & Error)
        { name: "Core Tech: SoA/TypedArray Validation", fn: () => {
             db.executeQuery("CREATE TABLE test_soa (id INTEGER, val FLOAT)");
             db.executeQuery("INSERT INTO test_soa (id, val) VALUES (1, 1.1)");
             const tbl = db.tables['test_soa'];
             const isSoA = tbl.cols['id'] && tbl.cols['val'];
             // TypedArray によるカラムナフォーマットが利用されているか検証
             const isTypedArray = tbl.cols['id'].num instanceof Float64Array && tbl.cols['id'].meta instanceof Uint32Array;
             db.executeQuery("DROP TABLE test_soa");
             return !!(isSoA && isTypedArray);
        }},
        { name: "Type Bounds: BOOLEAN Valid Set", sql: "INSERT INTO test_types (b) VALUES (1), (0), ('true'), ('FALSE')", check: r => r.data[0].Message.includes('4') },
        errCase("Type Bounds: BOOLEAN Invalid Value", "INSERT INTO test_types (b) VALUES ('yes')", 'Type mismatch'),
        { name: "Type Bounds: DATE ISO Format", sql: "INSERT INTO test_types (d) VALUES ('2026-12-31T23:59:59Z')", check: r => r.data[0].Message.includes('1') },
        errCase("Type Bounds: DATE Invalid Format", "INSERT INTO test_types (d) VALUES ('2026/12/31')", 'Type mismatch'),
        { name: "Type Bounds: INTEGER Max Safe", sql: "INSERT INTO test_types (i) VALUES (9007199254740991)", check: r => r.data[0].Message.includes('1') },
        { name: "Type Bounds: FLOAT Extreme", sql: "INSERT INTO test_types (f) VALUES (1e308)", check: r => r.data[0].Message.includes('1') },
        { name: "Neg: Add Column existing name", fn: () => { const r = db.executeQuery("ALTER TABLE test_types ADD COLUMN i TEXT"); return r.error !== undefined; } },
        { name: "Neg: Drop Column missing name", fn: () => { const r = db.executeQuery("ALTER TABLE test_types DROP COLUMN no_such_col"); return r.error !== undefined; } },

        // ============================================================
        // New Features: VIEW / UNIQUE / PRIMARY KEY / UNION / EXISTS / PROCEDURE
        // ============================================================

        // VIEW
        { name: "View: Create", sql: "CREATE VIEW v_adults AS SELECT id, name, age FROM users WHERE age >= 30", check: r => r.data[0].Result === "Success" },
        { name: "View: Select All", sql: "SELECT * FROM v_adults ORDER BY id ASC", check: r => r.data.length === 4 && r.data[0].name === 'Bob' },
        { name: "View: Where on View", sql: "SELECT name, age FROM v_adults WHERE age > 33 ORDER BY age DESC", check: r => r.data.length === 2 && r.data[0].name === 'Frank' },
        { name: "View: Join View with Table", sql: "SELECT v.name, o.amount FROM v_adults v JOIN orders o ON v.id = o.user_id ORDER BY v.name ASC", check: r => r.data.length === 2 && r.data[0].name === 'Bob' && r.data[1].name === 'Dave' },
        { name: "View: Aggregated View Create", sql: "CREATE VIEW v_stats AS SELECT user_id, SUM(amount) as total FROM orders GROUP BY user_id", check: r => r.data[0].Result === "Success" },
        { name: "View: Select Aggregated View", sql: "SELECT * FROM v_stats WHERE total >= 2 ORDER BY user_id ASC", check: r => r.data.length === 3 && r.data[0].user_id === 1 && r.data[0].total === 2 },
        { name: "View: View of View Create", sql: "CREATE VIEW v_seniors AS SELECT * FROM v_adults WHERE age >= 35", check: r => r.data[0].Result === "Success" },
        { name: "View: Select View of View", sql: "SELECT name, age FROM v_seniors ORDER BY age ASC", check: r => r.data.length === 2 && r.data[0].name === 'Dave' && r.data[1].name === 'Frank' },
        { name: "View: Export SQL includes View", fn: () => db.exportSQL().includes('CREATE VIEW v_adults AS') },
        errCase("Neg View: Duplicate Name", "CREATE VIEW v_adults AS SELECT * FROM users"),
        errCase("Neg View: Conflicts with Table", "CREATE VIEW users AS SELECT * FROM orders"),
        // v1.18: 単一表ビューは更新可能になった（旧: 明示エラー）。共有テーブルを汚さないよう
        // 専用のテーブル／ビューを立てて検証する
        { name: "View: Delete Through View", fn: () => {
            db.executeQuery("CREATE TABLE vdel_t (id INTEGER, age INTEGER)");
            db.executeQuery("INSERT INTO vdel_t (id, age) VALUES (1, 20), (2, 40)");
            db.executeQuery("CREATE VIEW vdel_v AS SELECT id, age FROM vdel_t WHERE age >= 30");
            const r = db.executeQuery("DELETE FROM vdel_v WHERE id = 2");
            const left = db.executeQuery("SELECT COUNT(*) AS c FROM vdel_t");
            // ビュー外の行 (id=1) は消えない
            const outside = db.executeQuery("DELETE FROM vdel_v WHERE id = 1");
            const still = db.executeQuery("SELECT COUNT(*) AS c FROM vdel_t");
            db.executeQuery("DROP VIEW vdel_v");
            db.executeQuery("DROP TABLE vdel_t");
            return !r.error && left.data[0].c === 1 && outside.data[0].Message.startsWith('0 rows') && still.data[0].c === 1;
        }},
        { name: "View: Drop", sql: "DROP VIEW v_adults", check: r => r.data[0].Result === "Success" },
        errCase("Neg View: Select After Drop", "SELECT * FROM v_adults"),
        errCase("Neg View: Drop Missing", "DROP VIEW v_missing"),

        // UNIQUE Constraint
        { name: "Unique: Create Table", sql: "CREATE TABLE test_uq (id INTEGER, email TEXT UNIQUE)", check: r => r.data[0].Result === "Success" },
        { name: "Unique: Insert Distinct", sql: "INSERT INTO test_uq (id, email) VALUES (1, 'a@example.com'), (2, 'b@example.com')", check: r => r.data[0].Message.includes('2') },
        errCase("Neg Unique: Insert Duplicate", "INSERT INTO test_uq (id, email) VALUES (3, 'a@example.com')", 'UNIQUE constraint failed'),
        errCase("Neg Unique: Batch Duplicate", "INSERT INTO test_uq (id, email) VALUES (4, 'x@example.com'), (5, 'x@example.com')", 'UNIQUE constraint failed'),
        { name: "Unique: NULLs Allowed", sql: "INSERT INTO test_uq (id, email) VALUES (6, null), (7, null)", check: r => r.data[0].Message.includes('2') },
        errCase("Neg Unique: Update to Duplicate", "UPDATE test_uq SET email = 'a@example.com' WHERE id = 2", 'UNIQUE constraint failed'),
        { name: "Unique: Update to Fresh Value", sql: "UPDATE test_uq SET email = 'c@example.com' WHERE id = 2", check: r => r.data[0].Message.includes('1') },
        { name: "Unique: Update Same Value OK", sql: "UPDATE test_uq SET email = 'c@example.com' WHERE id = 2", check: r => r.data[0].Message.includes('1') },
        { name: "Unique: Auto Index Created", fn: () => !!db.tables['test_uq'].indices['email'] },

        // PRIMARY KEY
        { name: "PK: Create Table (Column Level)", sql: "CREATE TABLE test_pk (id INTEGER PRIMARY KEY, name TEXT)", check: r => r.data[0].Result === "Success" },
        { name: "PK: Insert Valid", sql: "INSERT INTO test_pk (id, name) VALUES (1, 'first'), (2, 'second')", check: r => r.data[0].Message.includes('2') },
        errCase("Neg PK: Insert Duplicate", "INSERT INTO test_pk (id, name) VALUES (1, 'dup')", 'PRIMARY KEY constraint failed'),
        errCase("Neg PK: Insert NULL", "INSERT INTO test_pk (id, name) VALUES (null, 'nopk')", 'PRIMARY KEY constraint failed'),
        errCase("Neg PK: Missing PK Column", "INSERT INTO test_pk (name) VALUES ('nokey')", 'PRIMARY KEY constraint failed'),
        errCase("Neg PK: Update to Duplicate", "UPDATE test_pk SET id = 1 WHERE id = 2", 'PRIMARY KEY constraint failed'),
        { name: "PK: Update to Fresh Key", sql: "UPDATE test_pk SET id = 99 WHERE id = 2", check: r => r.data[0].Message.includes('1') },
        { name: "PK: Auto Index Created", fn: () => !!db.tables['test_pk'].indices['id'] },
        { name: "PK: Table Level Syntax", sql: "CREATE TABLE test_pk2 (a INTEGER, b TEXT, PRIMARY KEY (a))", check: r => r.data[0].Result === "Success" },
        { name: "PK: Table Level Insert", sql: "INSERT INTO test_pk2 (a, b) VALUES (10, 'x')", check: r => r.data[0].Message.includes('1') },
        errCase("Neg PK: Table Level Duplicate", "INSERT INTO test_pk2 (a, b) VALUES (10, 'y')", 'PRIMARY KEY constraint failed'),
        { name: "PK: Export SQL includes Constraints", fn: () => { const s = db.exportSQL(); return s.includes('id INTEGER PRIMARY KEY') && s.includes('email TEXT UNIQUE'); } },
        errCase("Neg PK: Multiple PK Definition", "CREATE TABLE test_pk3 (a INTEGER PRIMARY KEY, b INTEGER PRIMARY KEY)"),

        // UNION
        { name: "Union: Dedup Overlap", sql: "SELECT name FROM users WHERE id <= 2 UNION SELECT name FROM users WHERE id >= 2 ORDER BY name ASC", check: r => r.data.length === 10 && r.data[0].name === 'Alice' },
        { name: "Union: All Keeps Duplicates", sql: "SELECT id FROM users WHERE id <= 2 UNION ALL SELECT id FROM users WHERE id <= 2", check: r => r.data.length === 4 },
        { name: "Union: Identical Rows Dedup", sql: "SELECT id FROM users WHERE id = 1 UNION SELECT id FROM users WHERE id = 1", check: r => r.data.length === 1 && r.data[0].id === 1 },
        { name: "Union: Column Name Remap", sql: "SELECT id, name FROM users WHERE id = 1 UNION SELECT id AS pid, name AS pname FROM products WHERE id = 101", check: r => r.data.length === 2 && r.data[0].name === 'Alice' && r.data[1].id === 101 && r.data[1].name === 'Laptop' },
        { name: "Union: Order & Limit on Result", sql: "SELECT id FROM users WHERE id <= 3 UNION SELECT id FROM users WHERE id >= 8 ORDER BY id DESC LIMIT 2", check: r => r.data.length === 2 && r.data[0].id === 10 && r.data[1].id === 9 },
        { name: "Union: Three Segments Mixed", sql: "SELECT id FROM users WHERE id = 1 UNION SELECT id FROM users WHERE id = 2 UNION ALL SELECT id FROM users WHERE id = 2", check: r => r.data.length === 3 },
        { name: "Union: With Aggregates", sql: "SELECT COUNT(*) as c FROM users UNION ALL SELECT COUNT(*) as c FROM products", check: r => r.data.length === 2 && r.data[0].c === 10 && r.data[1].c === 5 },
        errCase("Neg Union: Column Count Mismatch", "SELECT id, name FROM users UNION SELECT id FROM users"),

        // EXISTS
        { name: "Exists: True Subquery", sql: "SELECT COUNT(*) as c FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE amount > 4)", check: r => r.data[0].c === 10 },
        { name: "Exists: False Subquery", sql: "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE amount > 100)", check: r => r.data.length === 0 },
        { name: "Exists: NOT EXISTS", sql: "SELECT COUNT(*) as c FROM users WHERE NOT EXISTS (SELECT order_id FROM orders WHERE amount > 100)", check: r => r.data[0].c === 10 },
        { name: "Exists: Combined with AND", sql: "SELECT COUNT(*) as c FROM users WHERE age > 28 AND EXISTS (SELECT 1 FROM orders WHERE amount >= 5)", check: r => r.data[0].c === 5 },

        // CREATE PROCEDURE / CALL
        { name: "Proc: Setup Table", sql: "CREATE TABLE test_proc (id INTEGER, val TEXT)", check: r => r.data[0].Result === "Success" },
        { name: "Proc: Create Multi-Statement", sql: "CREATE PROCEDURE proc_seed AS BEGIN INSERT INTO test_proc (id, val) VALUES (1, 'Alpha'); INSERT INTO test_proc (id, val) VALUES (2, 'Beta'); SELECT * FROM test_proc ORDER BY id ASC END", check: r => r.data[0].Result === "Success" },
        { name: "Proc: Call Returns Last Result", sql: "CALL proc_seed", check: r => r.data.length === 2 && r.data[0].val === 'Alpha' && r.data[1].val === 'Beta' },
        { name: "Proc: Side Effects Persisted", sql: "SELECT COUNT(*) as c FROM test_proc", check: r => r.data[0].c === 2 },
        { name: "Proc: Call Twice Accumulates", sql: "CALL proc_seed", check: r => r.data.length === 4 },
        { name: "Proc: Single Statement (No BEGIN)", sql: "CREATE PROCEDURE proc_cnt AS SELECT COUNT(*) as c FROM test_proc", check: r => r.data[0].Result === "Success" },
        { name: "Proc: Call Single Statement", sql: "CALL proc_cnt", check: r => r.data[0].c === 4 },
        errCase("Neg Proc: Duplicate Name", "CREATE PROCEDURE proc_cnt AS SELECT 1 FROM users"),
        errCase("Neg Proc: Call Missing", "CALL proc_nope"),
        { name: "Proc: Drop", sql: "DROP PROCEDURE proc_seed", check: r => r.data[0].Result === "Success" },
        errCase("Neg Proc: Call After Drop", "CALL proc_seed"),
        errCase("Neg Proc: Drop Missing", "DROP PROCEDURE proc_missing"),

        // ============================================================
        // Added Commands: SHOW / DESCRIBE / DROP INDEX / RENAME TO /
        //                 RIGHT JOIN / COUNT(DISTINCT) / INSERT 省略形
        // ============================================================

        // SHOW
        { name: "Show: Tables", sql: "SHOW TABLES", check: r => r.data.length >= 3 && r.data.some(d => d.Table === 'users') },
        { name: "Show: Tables Row Count", sql: "SHOW TABLES", check: r => r.data.find(d => d.Table === 'users').Rows === 10 },
        { name: "Show: Views", fn: () => {
            db.executeQuery("CREATE VIEW v_show AS SELECT id FROM users");
            const r = db.executeQuery("SHOW VIEWS");
            db.executeQuery("DROP VIEW v_show");
            return !r.error && r.data.some(d => d.View === 'v_show');
        }},
        { name: "Show: Procedures", fn: () => {
            db.executeQuery("CREATE PROCEDURE p_show AS SELECT 1 FROM users");
            const r = db.executeQuery("SHOW PROCEDURES");
            db.executeQuery("DROP PROCEDURE p_show");
            return !r.error && r.data.some(d => d.Procedure === 'p_show');
        }},
        errCase("Neg Show: Unknown Target", "SHOW WIDGETS"),

        // DESCRIBE / DESC
        { name: "Describe: Typed Table", sql: "DESCRIBE test_types", check: r => r.data.length === 5 && r.data[0].Column === 'i' && r.data[0].Type === 'INTEGER' },
        { name: "Describe: PK Flag", sql: "DESCRIBE test_pk", check: r => r.data.find(d => d.Column === 'id').Key === 'PRIMARY' && r.data.find(d => d.Column === 'id').Indexed === true },
        { name: "Describe: Unique Flag (DESC alias)", sql: "DESC test_uq", check: r => r.data.find(d => d.Column === 'email').Key === 'UNIQUE' },
        { name: "Describe: FK Info", sql: "DESCRIBE fk_child", check: r => r.data.find(d => d.Column === 'p_id').ForeignKey === 'fk_parent(id)' },
        { name: "Describe: View Definition", fn: () => {
            db.executeQuery("CREATE VIEW v_desc AS SELECT id FROM users");
            const r = db.executeQuery("DESCRIBE v_desc");
            db.executeQuery("DROP VIEW v_desc");
            return !r.error && r.data[0].View === 'v_desc' && r.data[0].Definition.toLowerCase().includes('select');
        }},
        errCase("Neg Describe: Missing Table", "DESCRIBE no_such_table"),

        // DROP INDEX
        { name: "DropIdx: Create Index", sql: "CREATE INDEX idx_age ON users (age)", check: r => r.data[0].Result === "Success" },
        { name: "DropIdx: Explain Uses Index", sql: "EXPLAIN SELECT * FROM users WHERE age = 25", check: r => r.data[0].Operation === 'INDEX SCAN' },
        { name: "DropIdx: Drop", sql: "DROP INDEX idx_age ON users (age)", check: r => r.data[0].Result === "Success" },
        { name: "DropIdx: Explain Back to Table Scan", sql: "EXPLAIN SELECT * FROM users WHERE age = 25", check: r => r.data[0].Operation === 'TABLE SCAN' },
        { name: "DropIdx: Name Omitted Syntax", fn: () => {
            db.executeQuery("CREATE INDEX idx_age2 ON users (age)");
            const r = db.executeQuery("DROP INDEX ON users (age)");
            return !r.error && !db.tables['users'].indices['age'];
        }},
        errCase("Neg DropIdx: Missing Index", "DROP INDEX idx_age ON users (age)"),
        errCase("Neg DropIdx: Missing Table", "DROP INDEX idx_x ON no_such_table (id)"),

        // ALTER TABLE ... RENAME TO
        // PK を付ける: v1.27 から FK の参照先には PRIMARY KEY / UNIQUE が必要
        // （RenameTbl: FK Reference Follows が rn_dst を参照する）
        { name: "RenameTbl: Setup", sql: "CREATE TABLE rn_src (id INTEGER PRIMARY KEY)", check: r => r.data[0].Result === "Success" },
        { name: "RenameTbl: Insert", sql: "INSERT INTO rn_src (id) VALUES (1), (2)", check: r => r.data[0].Message.includes('2') },
        { name: "RenameTbl: Rename", sql: "ALTER TABLE rn_src RENAME TO rn_dst", check: r => r.data[0].Result === "Success" },
        { name: "RenameTbl: Select New Name", sql: "SELECT COUNT(*) as c FROM rn_dst", check: r => r.data[0].c === 2 },
        errCase("Neg RenameTbl: Old Name Gone", "SELECT * FROM rn_src"),
        errCase("Neg RenameTbl: Target Exists", "ALTER TABLE rn_dst RENAME TO users"),
        { name: "RenameTbl: FK Reference Follows", fn: () => {
            db.executeQuery("CREATE TABLE rn_child (id INTEGER, d_id INTEGER, FOREIGN KEY (d_id) REFERENCES rn_dst(id))");
            db.executeQuery("ALTER TABLE rn_dst RENAME TO rn_dst2");
            const bad = db.executeQuery("INSERT INTO rn_child (id, d_id) VALUES (1, 99)");
            const ok = db.executeQuery("INSERT INTO rn_child (id, d_id) VALUES (1, 1)");
            db.executeQuery("DROP TABLE rn_child");
            db.executeQuery("DROP TABLE rn_dst2");
            return bad.error !== undefined && ok.error === undefined;
        }},
        { name: "RenameTbl: Tx Rollback Restores", fn: () => {
            db.executeQuery("CREATE TABLE rn_tx (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE rn_tx RENAME TO rn_tx2");
            db.executeQuery("ROLLBACK");
            const restored = !!db.tables['rn_tx'] && !db.tables['rn_tx2'];
            db.executeQuery("DROP TABLE rn_tx");
            return restored;
        }},

        // RIGHT JOIN
        { name: "Right Join: Hash Join Basic", sql: "SELECT u.name, o.amount FROM orders o RIGHT JOIN users u ON o.user_id = u.id ORDER BY u.name ASC", check: r => r.data.length === 11 && r.data.filter(d => d.amount === null).length === 6 },
        { name: "Right Join: Unmatched Left Is Null", sql: "SELECT o.order_id, u.id FROM orders o RIGHT JOIN users u ON o.user_id = u.id WHERE o.order_id IS NULL", check: r => r.data.length === 6 },
        { name: "Right Join: Nested Loop Path", sql: "SELECT u.id, o.order_id FROM orders o RIGHT JOIN users u ON o.user_id = u.id AND u.age > 25", check: r => r.data.length === 10 && r.data.filter(d => d.order_id === null).length === 8 },
        { name: "Right Join: All Matched Equals Inner", sql: "SELECT o.order_id FROM users u RIGHT JOIN orders o ON u.id = o.user_id", check: r => r.data.length === 5 && r.data.every(d => d.order_id !== null) },

        // INNER JOIN キーワード明示（ベーステーブル別名の解析確認）
        { name: "Inner Join Keyword With Alias", sql: "SELECT u.name, o.amount FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE u.id = 1", check: r => r.data.length === 2 },
        { name: "Inner Join Keyword No Alias", sql: "SELECT users.name FROM users INNER JOIN orders ON users.id = orders.user_id WHERE users.id = 3", check: r => r.data.length === 1 && r.data[0].name === 'Charlie' },

        // COUNT / SUM / AVG (DISTINCT)
        { name: "Agg: COUNT DISTINCT", sql: "SELECT COUNT(DISTINCT user_id) as c FROM orders", check: r => r.data[0].c === 4 },
        { name: "Agg: COUNT DISTINCT vs COUNT", sql: "SELECT COUNT(DISTINCT user_id) as cd, COUNT(user_id) as c FROM orders", check: r => r.data[0].cd === 4 && r.data[0].c === 5 },
        { name: "Agg: SUM DISTINCT", sql: "SELECT SUM(DISTINCT amount) as s FROM orders", check: r => r.data[0].s === 8 },
        // v1.27: AVG は倍精度のまま返す（2 桁で欲しいときは ROUND を明示する）
        { name: "Agg: AVG DISTINCT", sql: "SELECT AVG(DISTINCT amount) as a FROM orders", check: r => Math.abs(r.data[0].a - 8 / 3) < 1e-9 },
        { name: "Agg: AVG DISTINCT Rounded", sql: "SELECT ROUND(AVG(DISTINCT amount), 2) as a FROM orders", check: r => r.data[0].a === 2.67 },
        { name: "Agg: COUNT DISTINCT with Group By", sql: "SELECT user_id, COUNT(DISTINCT product_id) as c FROM orders GROUP BY user_id ORDER BY user_id ASC", check: r => r.data.length === 4 && r.data[0].user_id === 1 && r.data[0].c === 2 },

        // INSERT カラムリスト省略形
        { name: "Insert: No Column List", fn: () => {
            db.executeQuery("CREATE TABLE ins_short (id INTEGER, name TEXT)");
            const r = db.executeQuery("INSERT INTO ins_short VALUES (1, 'a'), (2, 'b')");
            const sel = db.executeQuery("SELECT * FROM ins_short ORDER BY id ASC");
            db.executeQuery("DROP TABLE ins_short");
            return !r.error && sel.data.length === 2 && sel.data[1].name === 'b';
        }},
        { name: "Insert: No Column List + SELECT", fn: () => {
            db.executeQuery("CREATE TABLE ins_sel (id INTEGER, name TEXT)");
            const r = db.executeQuery("INSERT INTO ins_sel SELECT id, name FROM users WHERE id <= 3");
            const cnt = db.executeQuery("SELECT COUNT(*) as c FROM ins_sel");
            db.executeQuery("DROP TABLE ins_sel");
            return !r.error && cnt.data[0].c === 3;
        }},
        { name: "Neg Insert: No Cols Count Mismatch", fn: () => {
            db.executeQuery("CREATE TABLE ins_bad (id INTEGER, name TEXT)");
            const r = db.executeQuery("INSERT INTO ins_bad VALUES (1)");
            db.executeQuery("DROP TABLE ins_bad");
            return r.error !== undefined;
        }},

        // ====== LuminaDB 新機能: ALTER TABLE MODIFY COLUMN ======
        { name: "Modify Column Type", fn: () => {
            db.executeQuery("CREATE TABLE mod_t (id INTEGER, v)");
            db.executeQuery("INSERT INTO mod_t (id, v) VALUES (1, '10'), (2, '20')");
            const r = db.executeQuery("ALTER TABLE mod_t MODIFY COLUMN v INTEGER");
            const sel = db.executeQuery("SELECT SUM(v) AS s FROM mod_t");
            const desc = db.executeQuery("DESCRIBE mod_t");
            db.executeQuery("DROP TABLE mod_t");
            return !r.error && sel.data[0].s === 30 && desc.data.find(d => d.Column === 'v').Type === 'INTEGER';
        }},
        { name: "Alter Column Syntax Variant", fn: () => {
            db.executeQuery("CREATE TABLE mod_t2 (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO mod_t2 (id, v) VALUES (1, '1.5')");
            const r = db.executeQuery("ALTER TABLE mod_t2 ALTER COLUMN v FLOAT");
            const sel = db.executeQuery("SELECT v FROM mod_t2");
            db.executeQuery("DROP TABLE mod_t2");
            return !r.error && sel.data[0].v === 1.5;
        }},
        { name: "Neg Modify: Invalid Type", fn: () => {
            db.executeQuery("CREATE TABLE mod_t3 (id INTEGER)");
            // v1.24: VARCHAR / INT / DECIMAL などの標準別名は受理するようになったので、
            // 本当に存在しない型で「不正な型は拒否する」ことを検査する
            const r = db.executeQuery("ALTER TABLE mod_t3 MODIFY COLUMN id NOSUCHTYPE");
            db.executeQuery("DROP TABLE mod_t3");
            return r.error !== undefined;
        }},
        { name: "Neg Modify: Cast Failure Keeps Data", fn: () => {
            db.executeQuery("CREATE TABLE mod_t4 (id, v)");
            db.executeQuery("INSERT INTO mod_t4 (id, v) VALUES (1, 'abc')");
            const r = db.executeQuery("ALTER TABLE mod_t4 MODIFY COLUMN v INTEGER");
            const sel = db.executeQuery("SELECT v FROM mod_t4");
            db.executeQuery("DROP TABLE mod_t4");
            return r.error !== undefined && sel.data[0].v === 'abc';
        }},

        // ====== LuminaDB 新機能: INTERSECT / EXCEPT ======
        { name: "Intersect", sql: "SELECT id FROM users WHERE id <= 5 INTERSECT SELECT id FROM users WHERE id >= 3", check: r => r.data.length === 3 },
        { name: "Except", sql: "SELECT id FROM users WHERE id <= 5 EXCEPT SELECT id FROM users WHERE id >= 4", check: r => r.data.length === 3 },
        { name: "Except with Order on Result", sql: "SELECT id FROM users EXCEPT SELECT id FROM users WHERE id > 2 ORDER BY id DESC", check: r => r.data.length === 2 && r.data[0].id === 2 },
        { name: "Union then Except Chained", sql: "SELECT id FROM users WHERE id <= 3 UNION SELECT id FROM users WHERE id = 5 EXCEPT SELECT id FROM users WHERE id = 2", check: r => r.data.length === 3 },
        { name: "Intersect Empty Result", sql: "SELECT id FROM users WHERE id <= 2 INTERSECT SELECT id FROM users WHERE id >= 9", check: r => r.data.length === 0 },

        // ====== LuminaDB 新機能: CROSS JOIN ======
        { name: "Cross Join Product Count", sql: "SELECT u.id, p.id AS pid FROM users u CROSS JOIN products p", check: r => r.data.length === 50 },
        { name: "Cross Join No Alias + Where", sql: "SELECT users.id, products.name FROM users CROSS JOIN products WHERE users.id = 1", check: r => r.data.length === 5 },
        { name: "Cross Join Chained", sql: "SELECT u.id FROM users u CROSS JOIN products p CROSS JOIN orders o WHERE u.id = 1 AND p.id = 101", check: r => r.data.length === 5 },

        // ====== LuminaDB 新機能: ウィンドウ関数 ======
        { name: "Window: RANK vs DENSE_RANK", fn: () => {
            db.executeQuery("CREATE TABLE wf_t (id INTEGER, score INTEGER)");
            db.executeQuery("INSERT INTO wf_t (id, score) VALUES (1, 10), (2, 10), (3, 20), (4, 5)");
            const r = db.executeQuery("SELECT id, RANK() OVER(ORDER BY score ASC) AS rk, DENSE_RANK() OVER(ORDER BY score ASC) AS drk FROM wf_t");
            db.executeQuery("DROP TABLE wf_t");
            const d = r.data;
            return !r.error && d[3].rk === 1 && d[0].rk === 2 && d[1].rk === 2 && d[2].rk === 4 && d[2].drk === 3;
        }},
        { name: "Window: LAG & LEAD", fn: () => {
            db.executeQuery("CREATE TABLE wf_l (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO wf_l (id, v) VALUES (1, 100), (2, 200), (3, 300)");
            const r = db.executeQuery("SELECT id, LAG(v) OVER(ORDER BY id ASC) AS pv, LEAD(v) OVER(ORDER BY id ASC) AS nv FROM wf_l");
            db.executeQuery("DROP TABLE wf_l");
            const d = r.data;
            return !r.error && d[0].pv === null && d[0].nv === 200 && d[1].pv === 100 && d[1].nv === 300 && d[2].nv === null;
        }},
        { name: "Window: LAG with Offset 2", fn: () => {
            db.executeQuery("CREATE TABLE wf_l2 (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO wf_l2 (id, v) VALUES (1, 100), (2, 200), (3, 300)");
            const r = db.executeQuery("SELECT id, LAG(v, 2) OVER(ORDER BY id ASC) AS pv FROM wf_l2");
            db.executeQuery("DROP TABLE wf_l2");
            const d = r.data;
            return !r.error && d[0].pv === null && d[1].pv === null && d[2].pv === 100;
        }},
        { name: "Window: Aggregates Over Partition", fn: () => {
            db.executeQuery("CREATE TABLE wf_a (id INTEGER, grp, v INTEGER)");
            db.executeQuery("INSERT INTO wf_a (id, grp, v) VALUES (1, 'x', 10), (2, 'x', 30), (3, 'y', 5)");
            const r = db.executeQuery("SELECT id, COUNT(*) OVER(PARTITION BY grp) AS c, AVG(v) OVER(PARTITION BY grp) AS a, MIN(v) OVER(PARTITION BY grp) AS mn, MAX(v) OVER(PARTITION BY grp) AS mx FROM wf_a");
            db.executeQuery("DROP TABLE wf_a");
            const d = r.data;
            return !r.error && d[0].c === 2 && d[0].a === 20 && d[0].mn === 10 && d[0].mx === 30 && d[2].c === 1 && d[2].a === 5;
        }},
        { name: "Window: Running Count", fn: () => {
            db.executeQuery("CREATE TABLE wf_c (id INTEGER)");
            db.executeQuery("INSERT INTO wf_c (id) VALUES (1), (2), (3)");
            const r = db.executeQuery("SELECT id, COUNT(*) OVER(ORDER BY id ASC) AS rc FROM wf_c");
            db.executeQuery("DROP TABLE wf_c");
            const d = r.data;
            return !r.error && d[0].rc === 1 && d[1].rc === 2 && d[2].rc === 3;
        }},

        // ====== LuminaDB 新機能: CAST / GROUP_CONCAT ======
        { name: "Cast Expressions", sql: "SELECT CAST(id AS TEXT) AS t, CAST(age AS FLOAT) AS f, CAST('123' AS INTEGER) AS i FROM users WHERE id = 1", check: r => r.data[0].t === '1' && r.data[0].f === 25 && r.data[0].i === 123 },
        { name: "Cast in Where", sql: "SELECT id FROM users WHERE CAST(id AS TEXT) = '3'", check: r => r.data.length === 1 && r.data[0].id === 3 },
        { name: "Cast Invalid Returns Null", sql: "SELECT CAST(name AS INTEGER) AS n FROM users WHERE id = 1", check: r => r.data[0].n === null },
        { name: "Group Concat", fn: () => {
            db.executeQuery("CREATE TABLE gc_t (id INTEGER, grp, name)");
            db.executeQuery("INSERT INTO gc_t (id, grp, name) VALUES (1, 'a', 'x'), (2, 'a', 'y'), (3, 'b', 'z'), (4, 'a', 'x')");
            const r1 = db.executeQuery("SELECT grp, GROUP_CONCAT(name) AS names FROM gc_t GROUP BY grp ORDER BY grp ASC");
            const r2 = db.executeQuery("SELECT grp, GROUP_CONCAT(DISTINCT name) AS names FROM gc_t GROUP BY grp ORDER BY grp ASC");
            const r3 = db.executeQuery("SELECT GROUP_CONCAT(name SEPARATOR ' | ') AS names FROM gc_t WHERE grp = 'a'");
            db.executeQuery("DROP TABLE gc_t");
            return !r1.error && r1.data[0].names === 'x,y,x' && r2.data[0].names === 'x,y' && r3.data[0].names === 'x | y | x';
        }},

        // ====== LuminaDB 新機能: NOT NULL / DEFAULT / AUTO_INCREMENT ======
        { name: "Constraint: NOT NULL Violations", fn: () => {
            db.executeQuery("CREATE TABLE nn_t (id INTEGER, name TEXT NOT NULL)");
            const r1 = db.executeQuery("INSERT INTO nn_t (id, name) VALUES (1, null)");
            const r2 = db.executeQuery("INSERT INTO nn_t (id) VALUES (2)");
            const ok = db.executeQuery("INSERT INTO nn_t (id, name) VALUES (3, 'ok')");
            const upd = db.executeQuery("UPDATE nn_t SET name = null WHERE id = 3");
            db.executeQuery("DROP TABLE nn_t");
            return r1.error !== undefined && r2.error !== undefined && !ok.error && upd.error !== undefined;
        }},
        { name: "Constraint: DEFAULT Applied", fn: () => {
            db.executeQuery("CREATE TABLE df_t (id INTEGER, status TEXT DEFAULT 'active', score INTEGER DEFAULT 100)");
            db.executeQuery("INSERT INTO df_t (id) VALUES (1)");
            db.executeQuery("INSERT INTO df_t (id, status) VALUES (2, 'inactive')");
            const r = db.executeQuery("SELECT * FROM df_t ORDER BY id ASC");
            db.executeQuery("DROP TABLE df_t");
            return r.data[0].status === 'active' && r.data[0].score === 100 && r.data[1].status === 'inactive' && r.data[1].score === 100;
        }},
        { name: "Constraint: DEFAULT with Insert Select", fn: () => {
            db.executeQuery("CREATE TABLE dfs_t (id INTEGER, status TEXT DEFAULT 'new')");
            db.executeQuery("INSERT INTO dfs_t (id) SELECT id FROM users WHERE id <= 2");
            const r = db.executeQuery("SELECT * FROM dfs_t ORDER BY id ASC");
            db.executeQuery("DROP TABLE dfs_t");
            return r.data.length === 2 && r.data[0].status === 'new' && r.data[1].status === 'new';
        }},
        { name: "Constraint: AUTO_INCREMENT", fn: () => {
            db.executeQuery("CREATE TABLE ai_t (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT)");
            db.executeQuery("INSERT INTO ai_t (name) VALUES ('a'), ('b')");
            db.executeQuery("INSERT INTO ai_t (id, name) VALUES (10, 'c')");
            db.executeQuery("INSERT INTO ai_t (name) VALUES ('d')");
            const r = db.executeQuery("SELECT id, name FROM ai_t ORDER BY id ASC");
            db.executeQuery("DROP TABLE ai_t");
            return r.data.length === 4 && r.data[0].id === 1 && r.data[1].id === 2 && r.data[2].id === 10 && r.data[3].id === 11;
        }},
        { name: "Describe: Constraint Columns", fn: () => {
            db.executeQuery("CREATE TABLE dsc_t (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL DEFAULT 'anon')");
            const r = db.executeQuery("DESCRIBE dsc_t");
            db.executeQuery("DROP TABLE dsc_t");
            const idRow = r.data.find(d => d.Column === 'id');
            const nameRow = r.data.find(d => d.Column === 'name');
            return idRow.Extra === 'AUTO_INCREMENT' && nameRow.NotNull === true && nameRow.Default === 'anon';
        }},
        { name: "IO: Constraint Metadata Roundtrip", fn: () => {
            db.executeQuery("CREATE TABLE meta_t (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, st TEXT DEFAULT 'x')");
            const dump = db.exportForIDB();
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(dump);
            const t = eng2.tables['meta_t'];
            db.executeQuery("DROP TABLE meta_t");
            return t.autoIncrementCol === 'id' && t.notNullCols.includes('name') && t.defaults.st === 'x';
        }},

        // ====== LuminaDB 新機能: SAVEPOINT ======
        { name: "Savepoint: Partial Rollback", fn: () => {
            db.executeQuery("CREATE TABLE sp_t (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("INSERT INTO sp_t (id) VALUES (1)");
            db.executeQuery("SAVEPOINT sp1");
            db.executeQuery("INSERT INTO sp_t (id) VALUES (2), (3)");
            const r1 = db.executeQuery("ROLLBACK TO SAVEPOINT sp1");
            const mid = db.executeQuery("SELECT COUNT(*) AS c FROM sp_t");
            db.executeQuery("COMMIT");
            const fin = db.executeQuery("SELECT COUNT(*) AS c FROM sp_t");
            db.executeQuery("DROP TABLE sp_t");
            return !r1.error && mid.data[0].c === 1 && fin.data[0].c === 1;
        }},
        { name: "Savepoint: Release & Reuse", fn: () => {
            db.executeQuery("CREATE TABLE sp_r (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("SAVEPOINT s1");
            db.executeQuery("INSERT INTO sp_r (id) VALUES (1)");
            const rel = db.executeQuery("RELEASE SAVEPOINT s1");
            const bad = db.executeQuery("ROLLBACK TO s1");
            db.executeQuery("ROLLBACK");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM sp_r");
            db.executeQuery("DROP TABLE sp_r");
            return !rel.error && bad.error !== undefined && cnt.data[0].c === 0;
        }},
        { name: "Savepoint: Nested Rollback Order", fn: () => {
            db.executeQuery("CREATE TABLE sp_n (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("INSERT INTO sp_n (id) VALUES (1)");
            db.executeQuery("SAVEPOINT a");
            db.executeQuery("INSERT INTO sp_n (id) VALUES (2)");
            db.executeQuery("SAVEPOINT b");
            db.executeQuery("INSERT INTO sp_n (id) VALUES (3)");
            db.executeQuery("ROLLBACK TO a");
            const mid = db.executeQuery("SELECT COUNT(*) AS c FROM sp_n");
            const badB = db.executeQuery("ROLLBACK TO b");
            db.executeQuery("ROLLBACK");
            const fin = db.executeQuery("SELECT COUNT(*) AS c FROM sp_n");
            db.executeQuery("DROP TABLE sp_n");
            return mid.data[0].c === 1 && badB.error !== undefined && fin.data[0].c === 0;
        }},
        errCase("Neg Savepoint: Outside Transaction", "SAVEPOINT nope"),

        // ====== LuminaDB 新機能: 外部クエリ API ======
        { name: "API: window.LuminaDB.query", fn: () => {
            const r = window.LuminaDB.query("SELECT COUNT(*) AS c FROM users");
            return !r.error && r.data[0].c === 10;
        }},
        { name: "API: Param Binding", fn: () => {
            const r = window.LuminaDB.query("SELECT name FROM users WHERE id = ? AND age > ?", [1, 20]);
            return !r.error && r.data.length === 1 && r.data[0].name === 'Alice';
        }},
        { name: "API: Param String Escape", fn: () => {
            db.executeQuery("CREATE TABLE api_t (id INTEGER, txt TEXT)");
            const ins = window.LuminaDB.query("INSERT INTO api_t (id, txt) VALUES (?, ?)", [1, "O'Reilly"]);
            const sel = window.LuminaDB.query("SELECT txt FROM api_t WHERE id = ?", [1]);
            db.executeQuery("DROP TABLE api_t");
            return !ins.error && sel.data.length === 1 && String(sel.data[0].txt).includes('Reilly');
        }},
        { name: "Neg API: Param Count Mismatch", fn: () => {
            const r = window.LuminaDB.query("SELECT * FROM users WHERE id = ?", [1, 2]);
            return r.error !== undefined;
        }},
        { name: "API: fetch GET Query", fn: async () => {
            const res = await fetch('lumina://query?sql=' + encodeURIComponent('SELECT COUNT(*) AS c FROM users'));
            const j = await res.json();
            return res.status === 200 && j.data[0].c === 10;
        }},
        { name: "API: fetch POST with Params", fn: async () => {
            const res = await fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT name FROM users WHERE id = ?', params: [2] }) });
            const j = await res.json();
            return res.status === 200 && j.data[0].name === 'Bob';
        }},
        { name: "Neg API: fetch Error Status 400", fn: async () => {
            const res = await fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM no_such_tbl' }) });
            const j = await res.json();
            return res.status === 400 && j.error !== undefined;
        }},
        { name: "API: fetch Tables Endpoint", fn: async () => {
            const res = await fetch('lumina://tables');
            const j = await res.json();
            return res.status === 200 && j.data.some(t => t.Table === 'users');
        }},
        { name: "Neg API: fetch Unknown Endpoint 404", fn: async () => {
            const res = await fetch('lumina://nope');
            return res.status === 404;
        }},
        { name: "API: postMessage Query", fn: () => new Promise(resolve => {
            const id = 'test_' + Math.random();
            const timer = setTimeout(() => resolve(false), 2000);
            const onMsg = (e) => {
                if (e.data && e.data.type === 'luminadb:result' && e.data.id === id) {
                    clearTimeout(timer);
                    window.removeEventListener('message', onMsg);
                    resolve(!e.data.result.error && e.data.result.data[0].c === 10);
                }
            };
            window.addEventListener('message', onMsg);
            window.postMessage({ type: 'luminadb:query', id, sql: 'SELECT COUNT(*) AS c FROM users' }, '*');
        })},

        // ============================================================
        // Security: XSS対策（結果描画のエスケープ） / postMessage オリジン検証
        // ============================================================
        { name: "Sec: Result Cell HTML Escaped", fn: () => {
            db.executeQuery("CREATE TABLE xss_t (id INTEGER, payload TEXT)");
            db.executeQuery("INSERT INTO xss_t (id, payload) VALUES (1, '<img src=x onerror=window.__xssCell=1>')");
            els.query.value = "SELECT payload FROM xss_t";
            document.getElementById('executeBtn').click();
            const noInjectedEl = !els.resArea.querySelector('img');
            const isEscaped = els.resArea.innerHTML.includes('&lt;img');
            const cell = els.resArea.querySelector('tbody td');
            const textIntact = cell && cell.textContent.includes('<img src=x');
            db.executeQuery("DROP TABLE xss_t");
            return noInjectedEl && isEscaped && !!textIntact && window.__xssCell === undefined;
        }},
        { name: "Sec: Error Message HTML Escaped", fn: () => {
            // Type mismatch エラーはユーザー入力値をそのまま含むため、エスケープ必須
            els.query.value = "INSERT INTO test_types (i) VALUES ('<img src=x onerror=window.__xssErr=1>')";
            document.getElementById('executeBtn').click();
            const noInjectedEl = !els.resArea.querySelector('img');
            const isEscaped = els.resArea.innerHTML.includes('&lt;img');
            return noInjectedEl && isEscaped && window.__xssErr === undefined;
        }},
        { name: "Sec: Header Key HTML Escaped", fn: () => {
            const bku = currentResultData;
            currentResultData = [{ '<b>col</b>': '<i>val</i>' }];
            renderDisplay(true);
            const noInjectedEl = !els.resArea.querySelector('th b, td i');
            const hasHeader = !!els.resArea.querySelector('th[data-col]');
            currentResultData = bku;
            renderDisplay(true);
            return noInjectedEl && hasHeader;
        }},
        { name: "Sec: postMessage Foreign Origin Rejected", fn: () => {
            let called = false;
            const orig = window.LuminaDB.query;
            window.LuminaDB.query = function (...a) { called = true; return orig.apply(window.LuminaDB, a); };
            // dispatchEvent はリスナーを同期実行するため、フラグで即時判定できる
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'luminadb:query', id: 'evil', sql: 'SELECT 1 AS x' },
                origin: 'https://evil.example'
            }));
            window.LuminaDB.query = orig;
            return called === false;
        }},
        { name: "Sec: postMessage Own Origin Accepted", fn: () => {
            let called = false;
            const orig = window.LuminaDB.query;
            window.LuminaDB.query = function (...a) { called = true; return orig.apply(window.LuminaDB, a); };
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'luminadb:query', id: 'own', sql: 'SELECT 1 AS x' },
                origin: window.location.origin
            }));
            window.LuminaDB.query = orig;
            return called === true;
        }},
        { name: "Sec: postMessage Allowlist Extendable", fn: () => {
            let called = false;
            const orig = window.LuminaDB.query;
            window.LuminaDB.query = function (...a) { called = true; return orig.apply(window.LuminaDB, a); };
            window.LuminaDB.allowedOrigins.push('https://partner.example');
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'luminadb:query', id: 'partner', sql: 'SELECT 1 AS x' },
                origin: 'https://partner.example'
            }));
            window.LuminaDB.allowedOrigins.pop();
            window.LuminaDB.query = orig;
            return called === true;
        }},
        { name: "Sec: Expression Backtick Rejected", fn: () => {
            const r = db.executeQuery("SELECT * FROM users WHERE name = `evil`");
            return r.error !== undefined;
        }},
        { name: "Sec: Expression Interpolation Blocked", fn: () => {
            window.__pwn = undefined;
            const r = db.executeQuery("SELECT * FROM users WHERE age = ${(window.__pwn=1)}");
            const safe = window.__pwn === undefined;
            delete window.__pwn;
            return r.error !== undefined && safe;
        }},

        // ============================================================
        // Param Binding: 引用符/バックスラッシュのエスケープ復元（#4）
        // ============================================================
        { name: "Bind: Quote Round-Trip Exact", fn: () => {
            db.executeQuery("CREATE TABLE pq_t (id INTEGER, txt TEXT)");
            window.LuminaDB.query("INSERT INTO pq_t (id, txt) VALUES (?, ?)", [1, "O'Brien"]);
            const stored = db.tables['pq_t'].getValue('txt', 0);
            const sel = window.LuminaDB.query("SELECT id FROM pq_t WHERE txt = ?", ["O'Brien"]);
            db.executeQuery("DROP TABLE pq_t");
            return stored === "O'Brien" && !sel.error && sel.data.length === 1 && sel.data[0].id === 1;
        }},
        { name: "Bind: Backslash Round-Trip", fn: () => {
            db.executeQuery("CREATE TABLE pb_t (id INTEGER, txt TEXT)");
            window.LuminaDB.query("INSERT INTO pb_t (id, txt) VALUES (?, ?)", [1, "a\\b"]);
            const stored = db.tables['pb_t'].getValue('txt', 0);
            db.executeQuery("DROP TABLE pb_t");
            return stored === "a\\b";
        }},

        // ============================================================
        // UPDATE の制約検証を原子的に（#6）
        // ============================================================
        { name: "Constraint: Update Unique Atomic Rollback", fn: () => {
            db.executeQuery("CREATE TABLE uq_up (id INTEGER PRIMARY KEY, code TEXT UNIQUE)");
            db.executeQuery("INSERT INTO uq_up (id, code) VALUES (1, 'A'), (2, 'B'), (3, 'C')");
            // 全行を 'A' に更新 → UNIQUE違反。1行も変更されないこと（部分適用なし）。
            const r = db.executeQuery("UPDATE uq_up SET code = 'A'");
            const rows = db.executeQuery("SELECT id, code FROM uq_up ORDER BY id ASC");
            const unchanged = rows.data[0].code === 'A' && rows.data[1].code === 'B' && rows.data[2].code === 'C';
            db.executeQuery("DROP TABLE uq_up");
            return r.error !== undefined && r.error.includes('UNIQUE') && unchanged;
        }},
        { name: "Constraint: Update Unique Shift No False Positive", fn: () => {
            db.executeQuery("CREATE TABLE uq_sh (id INTEGER PRIMARY KEY, code INTEGER UNIQUE)");
            db.executeQuery("INSERT INTO uq_sh (id, code) VALUES (1, 10), (2, 20)");
            // 10->20, 20->30: 更新後の最終状態では一意なので成功すべき（逐次チェックだと誤検知する）
            const r = db.executeQuery("UPDATE uq_sh SET code = code + 10");
            const rows = db.executeQuery("SELECT id, code FROM uq_sh ORDER BY id ASC");
            db.executeQuery("DROP TABLE uq_sh");
            return !r.error && rows.data[0].code === 20 && rows.data[1].code === 30;
        }},

        // ============================================================
        // insertRows / CSVインポートの制約適用と原子性（#7）
        // ============================================================
        { name: "IO: insertRows Enforces Constraints Atomically", fn: () => {
            db.executeQuery("CREATE TABLE bulk_t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
            db.executeQuery("INSERT INTO bulk_t (id, name) VALUES (1, 'a')");
            let threw = false;
            try {
                db.insertRows('bulk_t', ['id', 'name'], [[2, 'b'], [3, null]]);
            } catch (e) { threw = e.message.includes('NOT NULL'); }
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM bulk_t");
            db.executeQuery("DROP TABLE bulk_t");
            return threw && cnt.data[0].c === 1;
        }},
        { name: "IO: insertRows Type Error Rolls Back", fn: () => {
            db.executeQuery("CREATE TABLE bulk_ty (id INTEGER, n INTEGER)");
            let threw = false;
            try {
                db.insertRows('bulk_ty', ['id', 'n'], [[1, 10], [2, 20], [3, 'notnum']]);
            } catch (e) { threw = e.message.includes('Type mismatch'); }
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM bulk_ty");
            db.executeQuery("DROP TABLE bulk_ty");
            return threw && cnt.data[0].c === 0;
        }},
        { name: "IO: CSV Import Valid Rows", fn: async () => {
            db.executeQuery("CREATE TABLE csv_v (id INTEGER, name TEXT)");
            renderTree();
            const input = document.getElementById('csvFileInput');
            const dt = new DataTransfer();
            dt.items.add(new File(["id,name\n10,x\n20,y"], 't.csv', { type: 'text/csv' }));
            input.files = dt.files;
            const sel = document.getElementById('csvTableSelect');
            sel.value = 'csv_v';
            const selectable = sel.value === 'csv_v';
            document.getElementById('execCsvImportBtn').click();
            await new Promise(r => setTimeout(r, 300));
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM csv_v");
            const val = db.executeQuery("SELECT name FROM csv_v WHERE id = 20");
            db.executeQuery("DROP TABLE csv_v");
            return selectable && cnt.data[0].c === 2 && val.data[0].name === 'y';
        }},
        { name: "IO: CSV Import Atomic on Constraint Fail", fn: async () => {
            db.executeQuery("CREATE TABLE csv_t (id INTEGER PRIMARY KEY, name TEXT)");
            db.executeQuery("INSERT INTO csv_t (id, name) VALUES (1, 'orig')");
            renderTree();
            const input = document.getElementById('csvFileInput');
            const dt = new DataTransfer();
            // 2行目(id=1)が既存PKと重複 → 全体失敗・部分インポートなし
            dt.items.add(new File(["id,name\n2,two\n1,dup\n3,three"], 't.csv', { type: 'text/csv' }));
            input.files = dt.files;
            const sel = document.getElementById('csvTableSelect');
            sel.value = 'csv_t';
            const selectable = sel.value === 'csv_t';
            document.getElementById('execCsvImportBtn').click();
            await new Promise(r => setTimeout(r, 300));
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM csv_t");
            db.executeQuery("DROP TABLE csv_t");
            return selectable && cnt.data[0].c === 1;
        }},

        // ============================================================
        // Added Commands 2: WITH (CTE) / CTAS / IF (NOT) EXISTS /
        //   CREATE OR REPLACE VIEW / SHOW INDEXES / SHOW CREATE TABLE /
        //   FROM句なしSELECT / 新関数 / NTILE / FIRST_VALUE / LAST_VALUE
        // ============================================================

        // WITH (CTE)
        { name: "CTE: Basic Count", sql: "WITH adult AS (SELECT id, name, age FROM users WHERE age >= 30) SELECT COUNT(*) AS c FROM adult", check: r => r.data[0].c === 4 },
        { name: "CTE: Where & Order on CTE", sql: "WITH a AS (SELECT id, age FROM users WHERE age >= 30) SELECT id, age FROM a ORDER BY age DESC LIMIT 1", check: r => r.data[0].id === 6 && r.data[0].age === 40 },
        { name: "CTE: Qualified Reference by CTE Name", sql: "WITH a AS (SELECT id, age FROM users WHERE age >= 30) SELECT a.id FROM a WHERE a.age = 40", check: r => r.data.length === 1 && r.data[0].id === 6 },
        { name: "CTE: Multiple, Chained Reference", sql: "WITH a AS (SELECT id FROM users WHERE id <= 5), b AS (SELECT id FROM a WHERE id >= 4) SELECT COUNT(*) AS c FROM b", check: r => r.data[0].c === 2 },
        { name: "CTE: Join with Real Table", sql: "WITH big AS (SELECT user_id, SUM(amount) AS s FROM orders GROUP BY user_id) SELECT u.name, big.s FROM users u JOIN big ON u.id = big.user_id ORDER BY big.s DESC LIMIT 1", check: r => r.data[0].name === 'Charlie' && r.data[0].s === 5 },
        { name: "CTE: Aggregation over CTE", sql: "WITH t AS (SELECT age FROM users WHERE age < 30) SELECT MAX(age) AS mx, COUNT(*) AS c FROM t", check: r => r.data[0].mx === 29 && r.data[0].c === 6 },
        { name: "CTE: Feeds INSERT", fn: () => {
            db.executeQuery("CREATE TABLE cte_ins (id INTEGER, name TEXT)");
            const r = db.executeQuery("WITH src AS (SELECT id, name FROM users WHERE id <= 2) INSERT INTO cte_ins (id, name) SELECT id, name FROM src");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM cte_ins");
            db.executeQuery("DROP TABLE cte_ins");
            return !r.error && cnt.data[0].c === 2;
        }},
        { name: "CTE: Temp Tables Cleaned Up", fn: () => {
            db.executeQuery("WITH x AS (SELECT id FROM users) SELECT COUNT(*) AS c FROM x");
            return !Object.keys(db.tables).some(t => t.startsWith('__tmp_'));
        }},
        errCase("Neg CTE: Unbalanced Parens", "WITH a AS (SELECT id FROM users SELECT * FROM a"),
        errCase("Neg CTE: Missing Body Table", "WITH a AS (SELECT * FROM no_such_tbl) SELECT * FROM a"),
        errCase("Neg CTE: No Main Statement", "WITH a AS (SELECT id FROM users)"),

        // FROM句なし SELECT
        { name: "Dual: Arithmetic", sql: "SELECT 1 + 1 AS v", check: r => r.data.length === 1 && r.data[0].v === 2 },
        { name: "Dual: String Functions", sql: "SELECT CONCAT('A', 'B') AS s, UPPER('x') AS u", check: r => r.data[0].s === 'AB' && r.data[0].u === 'X' },
        { name: "Dual: Case Expression", sql: "SELECT CASE WHEN 1 = 1 THEN 'yes' ELSE 'no' END AS c", check: r => r.data[0].c === 'yes' },

        // IF NOT EXISTS / IF EXISTS
        { name: "IfNotExists: Existing Table Skipped", fn: () => {
            const r = db.executeQuery("CREATE TABLE IF NOT EXISTS users (id)");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM users");
            return !r.error && r.data[0].Message.includes('Skipped') && cnt.data[0].c === 10;
        }},
        { name: "IfNotExists: New Table Created", fn: () => {
            const r = db.executeQuery("CREATE TABLE IF NOT EXISTS ine_t (id INTEGER)");
            const ok = !r.error && !!db.tables['ine_t'];
            db.executeQuery("DROP TABLE ine_t");
            return ok;
        }},
        { name: "IfExists: Drop Missing Table OK", sql: "DROP TABLE IF EXISTS no_such_tbl", check: r => r.data[0].Result === "Success" },
        { name: "IfExists: Drop Missing View OK", sql: "DROP VIEW IF EXISTS no_such_view", check: r => r.data[0].Result === "Success" },
        { name: "IfExists: Drop Missing Proc OK", sql: "DROP PROCEDURE IF EXISTS no_such_proc", check: r => r.data[0].Result === "Success" },
        { name: "IfExists: Drop Existing Table Works", fn: () => {
            db.executeQuery("CREATE TABLE ie_t (id INTEGER)");
            const r = db.executeQuery("DROP TABLE IF EXISTS ie_t");
            return !r.error && !db.tables['ie_t'];
        }},
        errCase("Neg: Drop Missing Without IF EXISTS", "DROP TABLE definitely_missing"),

        // CREATE OR REPLACE VIEW
        { name: "OrReplace: View Replaced", fn: () => {
            db.executeQuery("CREATE VIEW orv AS SELECT id FROM users");
            const r = db.executeQuery("CREATE OR REPLACE VIEW orv AS SELECT name FROM users WHERE id = 1");
            const sel = db.executeQuery("SELECT * FROM orv");
            db.executeQuery("DROP VIEW orv");
            return !r.error && r.data[0].Message.includes('replaced') && sel.data.length === 1 && sel.data[0].name === 'Alice';
        }},
        { name: "OrReplace: Creates When Missing", fn: () => {
            const r = db.executeQuery("CREATE OR REPLACE VIEW orv2 AS SELECT id FROM users WHERE id <= 3");
            const sel = db.executeQuery("SELECT COUNT(*) AS c FROM orv2");
            db.executeQuery("DROP VIEW orv2");
            return !r.error && sel.data[0].c === 3;
        }},
        errCase("Neg OrReplace: Conflicts with Table", "CREATE OR REPLACE VIEW users AS SELECT * FROM orders"),

        // CREATE TABLE AS SELECT (CTAS)
        { name: "CTAS: Basic", fn: () => {
            const r = db.executeQuery("CREATE TABLE ctas_t AS SELECT id, name FROM users WHERE id <= 3");
            const sel = db.executeQuery("SELECT * FROM ctas_t ORDER BY id ASC");
            db.executeQuery("DROP TABLE ctas_t");
            return !r.error && r.data[0].Message.includes('3 rows') && sel.data.length === 3 && sel.data[0].name === 'Alice';
        }},
        { name: "CTAS: With Aggregation", fn: () => {
            const r = db.executeQuery("CREATE TABLE ctas_agg AS SELECT user_id, SUM(amount) AS total FROM orders GROUP BY user_id");
            const sel = db.executeQuery("SELECT total FROM ctas_agg WHERE user_id = 3");
            db.executeQuery("DROP TABLE ctas_agg");
            return !r.error && sel.data[0].total === 5;
        }},
        { name: "CTAS: Empty Result Makes Empty Table", fn: () => {
            const r = db.executeQuery("CREATE TABLE ctas_empty AS SELECT id FROM users WHERE id = -1");
            const ok = !r.error && !!db.tables['ctas_empty'] && db.tables['ctas_empty'].rowCount === 0;
            db.executeQuery("DROP TABLE ctas_empty");
            return ok;
        }},
        { name: "CTAS: Tx Rollback Removes Table", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE TABLE ctas_tx AS SELECT id FROM users WHERE id <= 2");
            db.executeQuery("ROLLBACK");
            return !db.tables['ctas_tx'];
        }},
        errCase("Neg CTAS: Duplicate Name", "CREATE TABLE users AS SELECT * FROM products"),
        { name: "CTAS: If Not Exists Skips", fn: () => {
            const r = db.executeQuery("CREATE TABLE IF NOT EXISTS users AS SELECT * FROM products");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM users");
            return !r.error && r.data[0].Message.includes('Skipped') && cnt.data[0].c === 10;
        }},

        // SHOW INDEXES / SHOW CREATE TABLE
        { name: "ShowIdx: Lists Index", fn: () => {
            db.executeQuery("CREATE INDEX idx_show ON products (price)");
            const r = db.executeQuery("SHOW INDEXES");
            const ok = !r.error && r.data.some(d => d.Table === 'products' && d.Column === 'price');
            db.executeQuery("DROP INDEX ON products (price)");
            return ok;
        }},
        { name: "ShowIdx: From Specific Table", fn: () => {
            db.executeQuery("CREATE INDEX idx_show2 ON products (stock)");
            const r = db.executeQuery("SHOW INDEXES FROM products");
            const ok = !r.error && r.data.length >= 1 && r.data.every(d => d.Table === 'products');
            db.executeQuery("DROP INDEX ON products (stock)");
            return ok;
        }},
        errCase("Neg ShowIdx: Missing Table", "SHOW INDEXES FROM no_such_tbl"),
        { name: "ShowCreate: Table DDL", sql: "SHOW CREATE TABLE products", check: r => r.data.length === 1 && r.data[0].CreateTable.includes('CREATE TABLE products') && r.data[0].CreateTable.includes('price') },
        { name: "ShowCreate: Includes Constraints", fn: () => {
            db.executeQuery("CREATE TABLE sct_t (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL)");
            const r = db.executeQuery("SHOW CREATE TABLE sct_t");
            db.executeQuery("DROP TABLE sct_t");
            return !r.error && r.data[0].CreateTable.includes('PRIMARY KEY') && r.data[0].CreateTable.includes('AUTO_INCREMENT') && r.data[0].CreateTable.includes('NOT NULL');
        }},
        errCase("Neg ShowCreate: Missing Table", "SHOW CREATE TABLE no_such_tbl"),

        // インデックスの IDB 永続化（ユーザー作成インデックスがリロード後も残る）
        { name: "IO: Index Metadata Roundtrip", fn: () => {
            db.executeQuery("CREATE TABLE idxio_t (id INTEGER, v INTEGER)");
            db.executeQuery("CREATE INDEX idx_io ON idxio_t (v)");
            const dump = db.exportForIDB();
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(dump);
            const restored = !!eng2.tables['idxio_t'] && !!eng2.tables['idxio_t'].indices['v'];
            db.executeQuery("DROP TABLE idxio_t");
            return restored;
        }},

        // 新関数: NULL処理 / 条件
        { name: "Func: IFNULL & NULLIF & IF", sql: "SELECT IFNULL(null, 'x') AS a, NULLIF(5, 5) AS b, NULLIF(5, 3) AS c, IF(1 = 1, 'y', 'n') AS d", check: r => r.data[0].a === 'x' && r.data[0].b === null && r.data[0].c === 5 && r.data[0].d === 'y' },
        { name: "Func: IFNULL on Column", sql: "SELECT IFNULL(o.order_id, -1) AS oid FROM users u LEFT JOIN orders o ON u.id = o.user_id WHERE u.id = 5", check: r => r.data[0].oid === -1 },

        // 新関数: 文字列
        { name: "Func: LEFT/RIGHT/INSTR/REVERSE/REPEAT", sql: "SELECT LEFT(name, 3) AS l, RIGHT(name, 3) AS r, INSTR(name, 'li') AS i, REVERSE(name) AS v, REPEAT('ab', 2) AS p FROM users WHERE id = 1", check: r => r.data[0].l === 'Ali' && r.data[0].r === 'ice' && r.data[0].i === 2 && r.data[0].v === 'ecilA' && r.data[0].p === 'abab' },
        { name: "Func: INSTR Not Found & Null Inputs", sql: "SELECT INSTR('abc', 'z') AS nf, LEFT(null, 2) AS ln, REVERSE(null) AS rn", check: r => r.data[0].nf === 0 && r.data[0].ln === null && r.data[0].rn === null },

        // 新関数: 数値
        { name: "Func: GREATEST & LEAST", sql: "SELECT GREATEST(3, 9, 5) AS g, LEAST(3, 9, 5) AS l, GREATEST(1, null) AS n", check: r => r.data[0].g === 9 && r.data[0].l === 3 && r.data[0].n === null },
        { name: "Func: EXP/LOG/LOG10/PI", sql: "SELECT ROUND(EXP(1) * 1000) AS e, ROUND(LOG(EXP(2))) AS ln2, LOG10(1000) AS lg, ROUND(PI() * 100) AS p", check: r => r.data[0].e === 2718 && r.data[0].ln2 === 2 && r.data[0].lg === 3 && r.data[0].p === 314 },
        { name: "Func: LOG of Non-Positive is Null", sql: "SELECT LOG(0) AS a, LOG10(-5) AS b", check: r => r.data[0].a === null && r.data[0].b === null },
        { name: "Func: GREATEST on Columns", sql: "SELECT GREATEST(age, 30) AS g FROM users WHERE id = 1", check: r => r.data[0].g === 30 },

        // 新関数: 日付・時刻
        { name: "Func: HOUR/MINUTE/SECOND", sql: "SELECT HOUR('2026-07-09 12:34:56') AS h, MINUTE('2026-07-09 12:34:56') AS m, SECOND('2026-07-09 12:34:56') AS s", check: r => r.data[0].h === 12 && r.data[0].m === 34 && r.data[0].s === 56 },
        { name: "Func: DATEDIFF", sql: "SELECT DATEDIFF('2026-07-09', '2026-07-01') AS d, DATEDIFF('2026-07-01', '2026-07-09') AS n, DATEDIFF(null, '2026-07-01') AS z", check: r => r.data[0].d === 8 && r.data[0].n === -8 && r.data[0].z === null },

        // ウィンドウ関数: NTILE / FIRST_VALUE / LAST_VALUE
        { name: "Window: NTILE Even Split", sql: "SELECT id, NTILE(2) OVER(ORDER BY id ASC) AS nt FROM users WHERE id <= 4", check: r => r.data[0].nt === 1 && r.data[1].nt === 1 && r.data[2].nt === 2 && r.data[3].nt === 2 },
        { name: "Window: NTILE Uneven Split", sql: "SELECT id, NTILE(2) OVER(ORDER BY id ASC) AS nt FROM users WHERE id <= 5", check: r => r.data[0].nt === 1 && r.data[2].nt === 1 && r.data[3].nt === 2 && r.data[4].nt === 2 },
        { name: "Window: NTILE More Buckets Than Rows", sql: "SELECT id, NTILE(10) OVER(ORDER BY id ASC) AS nt FROM users WHERE id <= 3", check: r => r.data[0].nt === 1 && r.data[1].nt === 2 && r.data[2].nt === 3 },
        // v1.25: ORDER BY だけを書いた OVER 句の既定フレームは SQL 標準の
        // RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW。したがって LAST_VALUE は
        // 「パーティションの最後」ではなく「現在行（と同順位の行）まで」の最後を返す。
        // パーティション全体の最後が欲しいときはフレームを明示する（実DBと同じ作法）
        { name: "Window: FIRST_VALUE & LAST_VALUE Default Frame", sql: "SELECT id, FIRST_VALUE(name) OVER(ORDER BY id ASC) AS f, LAST_VALUE(name) OVER(ORDER BY id ASC) AS l FROM users WHERE id <= 3", check: r => r.data.length === 3 && r.data.every(d => d.f === 'Alice') && r.data[0].l === 'Alice' && r.data[2].l === 'Charlie' },
        { name: "Window: LAST_VALUE Whole Partition", sql: "SELECT id, LAST_VALUE(name) OVER(ORDER BY id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS l FROM users WHERE id <= 3", check: r => r.data.every(d => d.l === 'Charlie') },
        { name: "Window: FIRST_VALUE with Partition", sql: "SELECT order_id, FIRST_VALUE(order_id) OVER(PARTITION BY user_id ORDER BY order_id ASC) AS f FROM orders WHERE user_id = 1 ORDER BY order_id ASC", check: r => r.data.length === 2 && r.data[0].f === 1001 && r.data[1].f === 1001 },

        // === コードレビュー修正の回帰テスト (Fix #1〜#6) ===

        // Fix#1: インデックス更新時に空配列が残留せず、FK存在チェックが正しく失敗する
        { name: "Fix1: Stale Index Entry Breaks FK Check", fn: () => {
            db.executeQuery("CREATE TABLE fix1_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fix1_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fix1_p(id))");
            db.executeQuery("INSERT INTO fix1_p (id) VALUES (1), (2)");
            db.executeQuery("UPDATE fix1_p SET id = 99 WHERE id = 1");
            // id=1 はもう存在しない → FK違反になるべき
            const r = db.executeQuery("INSERT INTO fix1_c (id, p_id) VALUES (10, 1)");
            const fkBlocked = r.error !== undefined && r.error.includes('Foreign key');
            // インデックスMapに空配列のキーが残っていないこと
            // （鍵は生値ではなく照合候補キーなので Table.indexKeysOf 経由で引く）
            const noStaleKey = Table.indexKeysOf(1).every(k => !db.tables['fix1_p'].indices['id'].has(k));
            db.executeQuery("DROP TABLE fix1_c");
            db.executeQuery("DROP TABLE fix1_p");
            return fkBlocked && noStaleKey;
        }},
        { name: "Fix1: LEFT JOIN After Indexed Update", fn: () => {
            db.executeQuery("CREATE TABLE fix1_l (id INTEGER)");
            db.executeQuery("CREATE TABLE fix1_r (id INTEGER, l_id INTEGER)");
            db.executeQuery("CREATE INDEX idx_fix1r ON fix1_r (l_id)");
            db.executeQuery("INSERT INTO fix1_l (id) VALUES (1)");
            db.executeQuery("INSERT INTO fix1_r (id, l_id) VALUES (10, 1)");
            db.executeQuery("UPDATE fix1_r SET l_id = 2 WHERE id = 10");
            // l_id=1 の行は無い → LEFT JOIN は NULL 補完行を返すべき（行消失しない）
            const r = db.executeQuery("SELECT l.id, r.id AS rid FROM fix1_l l LEFT JOIN fix1_r r ON l.id = r.l_id");
            db.executeQuery("DROP TABLE fix1_r");
            db.executeQuery("DROP TABLE fix1_l");
            return !r.error && r.data.length === 1 && r.data[0].rid === null;
        }},
        { name: "Fix1: FK Delete Not Falsely Blocked", fn: () => {
            db.executeQuery("CREATE TABLE fix1_p2 (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fix1_c2 (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fix1_p2(id))");
            db.executeQuery("CREATE INDEX idx_fix1c2 ON fix1_c2 (p_id)");
            db.executeQuery("INSERT INTO fix1_p2 (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO fix1_c2 (id, p_id) VALUES (10, 1)");
            db.executeQuery("UPDATE fix1_c2 SET p_id = 2 WHERE id = 10");
            // もう id=1 を参照する子は居ない → 親の削除は許可されるべき
            const r = db.executeQuery("DELETE FROM fix1_p2 WHERE id = 1");
            db.executeQuery("DROP TABLE fix1_c2");
            db.executeQuery("DROP TABLE fix1_p2");
            return !r.error && r.data[0].Message.includes('1');
        }},

        // Fix#2: SQL標準の引用符二重化('')の受理と、エクスポートSQLの再インポート往復
        { name: "Fix2: SQL-Standard '' Escape Parse", sql: "SELECT 'O''Brien' AS n", check: r => r.data[0].n === "O'Brien" },
        { name: "Fix2: Export/Import Quote Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE fix2_t (id INTEGER, txt TEXT)");
            const ins = eng.executeQuery("INSERT INTO fix2_t (id, txt) VALUES (1, 'O''Brien'), (2, 'a\\\\b')");
            if (ins.error) return false;
            const sql = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng2.tables[t]);
            for (const stmt of sql.split('\n').filter(s => s.trim() !== '')) {
                const r = eng2.executeQuery(stmt);
                if (r.error) return false;
            }
            const v1 = eng2.executeQuery("SELECT txt FROM fix2_t WHERE id = 1");
            const v2 = eng2.executeQuery("SELECT txt FROM fix2_t WHERE id = 2");
            return v1.data[0].txt === "O'Brien" && v2.data[0].txt === 'a\\b';
        }},
        { name: "Fix2: Quote in WHERE Comparison", fn: () => {
            db.executeQuery("CREATE TABLE fix2_w (id INTEGER, txt TEXT)");
            db.executeQuery("INSERT INTO fix2_w (id, txt) VALUES (1, 'O''Brien')");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM fix2_w WHERE txt = 'O''Brien'");
            db.executeQuery("DROP TABLE fix2_w");
            return !r.error && r.data[0].c === 1;
        }},

        // Fix#3: サブクエリ結果の文字列値がJSソースを汚染しない（引用符入りデータの往復）
        { name: "Fix3: Subquery String Injection Safe", fn: () => {
            db.executeQuery("CREATE TABLE fix3_t (id INTEGER, name TEXT)");
            db.executeQuery("INSERT INTO fix3_t (id, name) VALUES (1, 'safe''); alert(1);//')");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM fix3_t WHERE name IN (SELECT name FROM fix3_t)");
            const scalar = db.executeQuery("SELECT COUNT(*) AS c FROM fix3_t WHERE name = (SELECT name FROM fix3_t WHERE id = 1)");
            db.executeQuery("DROP TABLE fix3_t");
            return !r.error && r.data[0].c === 1 && !scalar.error && scalar.data[0].c === 1;
        }},

        // Fix#4: 大量DELETEの単一パス圧縮（正しさ + 性能）
        { name: "Fix4: Bulk Delete Correct & Fast", fn: () => {
            db.executeQuery("CREATE TABLE fix4_t (id INTEGER, v INTEGER)");
            const vals = [];
            for (let i = 1; i <= 20000; i++) vals.push([i, i % 7]);
            db.insertRows('fix4_t', ['id', 'v'], vals);
            const start = performance.now();
            const r = db.executeQuery("DELETE FROM fix4_t WHERE v <> 0");
            const elapsed = performance.now() - start;
            const rest = db.executeQuery("SELECT COUNT(*) AS c, MIN(id) AS mn, MAX(id) AS mx FROM fix4_t");
            db.executeQuery("DROP TABLE fix4_t");
            // v=0 は id が 7 の倍数の 2857 行。残存行の順序も保たれること
            return !r.error && rest.data[0].c === 2857 && rest.data[0].mn === 7 && rest.data[0].mx === 19999 && elapsed < 2000;
        }},

        // Fix#5: ダミーデータ生成が制約を尊重する
        { name: "Fix5: Dummy Data Respects PK & NOT NULL", fn: () => {
            db.executeQuery("CREATE TABLE fix5_t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
            db.executeQuery("INSERT INTO fix5_t (id, name) VALUES (5, 'seed')");
            db.generateDummyData('fix5_t', 200);
            const t = db.tables['fix5_t'];
            const seen = new Set();
            let dup = false, nullName = false;
            for (let i = 0; i < t.rowCount; i++) {
                const v = t.getValue('id', i);
                if (seen.has(v)) dup = true;
                seen.add(v);
                if (t.getValue('name', i) === null) nullName = true;
            }
            db.executeQuery("DROP TABLE fix5_t");
            return t.rowCount === 201 && !dup && !nullName;
        }},
        { name: "Fix5: Dummy Data Respects FK", fn: () => {
            db.executeQuery("CREATE TABLE fix5_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fix5_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fix5_p(id))");
            db.executeQuery("INSERT INTO fix5_p (id) VALUES (1), (2), (3)");
            db.generateDummyData('fix5_c', 100);
            const t = db.tables['fix5_c'];
            let ok = t.rowCount === 100;
            for (let i = 0; i < t.rowCount && ok; i++) {
                if (![1, 2, 3].includes(t.getValue('p_id', i))) ok = false;
            }
            db.executeQuery("DROP TABLE fix5_c");
            db.executeQuery("DROP TABLE fix5_p");
            return ok;
        }},

        // Fix#6: 相関サブクエリは黙って誤答せず明示的なエラーになる
        // v1.2: 相関サブクエリは行単位評価でサポートされた（旧: 明示エラー）
        { name: "Fix6: Correlated Scalar Subquery Now Works", fn: () => {
            // AVG は空グループで 0 を返すため、注文のないユーザーも age > 0 で全員一致する
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users u WHERE u.age > (SELECT AVG(o.amount) FROM orders o WHERE o.user_id = u.id)");
            return !r.error && r.data[0].c === 10;
        }},
        { name: "Fix6: Correlated EXISTS Now Works", fn: () => {
            const r = db.executeQuery("SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)");
            return !r.error && r.data.length === 4;
        }},
        { name: "Fix6: Non-Correlated Qualified Subquery OK", fn: () => {
            db.executeQuery("CREATE TABLE fix6_a (id INTEGER)");
            db.executeQuery("CREATE TABLE fix6_b (id INTEGER, a_id INTEGER)");
            db.executeQuery("INSERT INTO fix6_a (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO fix6_b (id, a_id) VALUES (10, 1)");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM fix6_a WHERE id IN (SELECT b.a_id FROM fix6_b b WHERE b.id > 0)");
            db.executeQuery("DROP TABLE fix6_b");
            db.executeQuery("DROP TABLE fix6_a");
            return !r.error && r.data[0].c === 1;
        }},

        // === 追加コマンドのテスト (UPSERT / ALTER制約 / 構文互換 / メタデータ) ===

        // REPLACE INTO
        successCase("Cmd: REPLACE Setup", "CREATE TABLE cmd_rep (id INTEGER PRIMARY KEY, v TEXT)"),
        { name: "Cmd: REPLACE Seed", sql: "INSERT INTO cmd_rep (id, v) VALUES (1, 'old'), (2, 'keep')", check: r => r.data[0].Message.includes('2') },
        { name: "Cmd: REPLACE Replaces Conflict", sql: "REPLACE INTO cmd_rep (id, v) VALUES (1, 'new')", check: r => r.data[0].Message.includes('1 replaced') },
        { name: "Cmd: REPLACE Verify", fn: () => {
            const r = db.executeQuery("SELECT v FROM cmd_rep WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM cmd_rep");
            return r.data[0].v === 'new' && c.data[0].c === 2;
        }},
        { name: "Cmd: REPLACE Inserts When New", sql: "REPLACE INTO cmd_rep (id, v) VALUES (3, 'three')", check: r => r.data[0].Message.includes('1 rows inserted') && !r.data[0].Message.includes('replaced') },

        // INSERT IGNORE / INSERT OR IGNORE
        { name: "Cmd: INSERT IGNORE Skips Conflict", sql: "INSERT IGNORE INTO cmd_rep (id, v) VALUES (1, 'dup'), (4, 'four')", check: r => r.data[0].Message.includes('1 rows inserted') && r.data[0].Message.includes('1 ignored') },
        { name: "Cmd: INSERT IGNORE Keeps Original", sql: "SELECT v FROM cmd_rep WHERE id = 1", check: r => r.data[0].v === 'new' },
        { name: "Cmd: INSERT OR IGNORE Syntax", sql: "INSERT OR IGNORE INTO cmd_rep (id, v) VALUES (1, 'dup2')", check: r => r.data[0].Message.includes('1 ignored') },

        // ON DUPLICATE KEY UPDATE
        successCase("Cmd: ODKU Setup", "CREATE TABLE cmd_odku (id INTEGER PRIMARY KEY, cnt INTEGER)"),
        { name: "Cmd: ODKU Seed", sql: "INSERT INTO cmd_odku (id, cnt) VALUES (1, 1)", check: r => r.data[0].Message.includes('1') },
        { name: "Cmd: ODKU Updates on Conflict", sql: "INSERT INTO cmd_odku (id, cnt) VALUES (1, 100) ON DUPLICATE KEY UPDATE cnt = cnt + 1", check: r => r.data[0].Message.includes('1 updated') },
        { name: "Cmd: ODKU Verify Update", sql: "SELECT cnt FROM cmd_odku WHERE id = 1", check: r => r.data[0].cnt === 2 },
        { name: "Cmd: ODKU Inserts When No Conflict", sql: "INSERT INTO cmd_odku (id, cnt) VALUES (2, 10) ON DUPLICATE KEY UPDATE cnt = cnt + 1", check: r => r.data[0].Message.includes('1 rows inserted') },

        // ALTER TABLE ADD/DROP PRIMARY KEY
        successCase("Cmd: ADD PK Setup", "CREATE TABLE cmd_pk (id INTEGER, v TEXT)"),
        { name: "Cmd: ADD PK Seed", sql: "INSERT INTO cmd_pk (id, v) VALUES (1, 'a'), (2, 'b')", check: r => r.data[0].Message.includes('2') },
        successCase("Cmd: ALTER ADD PRIMARY KEY", "ALTER TABLE cmd_pk ADD PRIMARY KEY (id)"),
        errCase("Cmd: ADD PK Enforced", "INSERT INTO cmd_pk (id, v) VALUES (1, 'dup')", 'PRIMARY KEY'),
        { name: "Cmd: ADD PK Shown in DESCRIBE", sql: "DESCRIBE cmd_pk", check: r => r.data.find(d => d.Column === 'id').Key === 'PRIMARY' },
        { name: "Cmd: ADD PK Rejects Duplicate Data", fn: () => {
            db.executeQuery("CREATE TABLE cmd_pk2 (id INTEGER)");
            db.executeQuery("INSERT INTO cmd_pk2 (id) VALUES (1), (1)");
            const r = db.executeQuery("ALTER TABLE cmd_pk2 ADD PRIMARY KEY (id)");
            db.executeQuery("DROP TABLE cmd_pk2");
            return r.error !== undefined && r.error.includes('Duplicate');
        }},
        { name: "Cmd: ALTER DROP PRIMARY KEY", fn: () => {
            const r = db.executeQuery("ALTER TABLE cmd_pk DROP PRIMARY KEY");
            const ins = db.executeQuery("INSERT INTO cmd_pk (id, v) VALUES (1, 'dup-ok')");
            return !r.error && !ins.error;
        }},

        // ALTER TABLE ADD/DROP UNIQUE
        { name: "Cmd: ALTER ADD/DROP UNIQUE", fn: () => {
            db.executeQuery("CREATE TABLE cmd_uq (id INTEGER, email TEXT)");
            db.executeQuery("INSERT INTO cmd_uq (id, email) VALUES (1, 'a@x.com')");
            const add = db.executeQuery("ALTER TABLE cmd_uq ADD UNIQUE (email)");
            const dup = db.executeQuery("INSERT INTO cmd_uq (id, email) VALUES (2, 'a@x.com')");
            const drop = db.executeQuery("ALTER TABLE cmd_uq DROP UNIQUE (email)");
            const ok = db.executeQuery("INSERT INTO cmd_uq (id, email) VALUES (3, 'a@x.com')");
            db.executeQuery("DROP TABLE cmd_uq");
            return !add.error && dup.error !== undefined && dup.error.includes('UNIQUE') && !drop.error && !ok.error;
        }},
        { name: "Cmd: ADD UNIQUE Rejects Duplicate Data", fn: () => {
            db.executeQuery("CREATE TABLE cmd_uq2 (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO cmd_uq2 (id, v) VALUES (1, 'x'), (2, 'x')");
            const r = db.executeQuery("ALTER TABLE cmd_uq2 ADD UNIQUE (v)");
            db.executeQuery("DROP TABLE cmd_uq2");
            return r.error !== undefined && r.error.includes('Duplicate');
        }},

        // ALTER TABLE ADD/DROP FOREIGN KEY
        { name: "Cmd: ALTER ADD FK Validates & Enforces", fn: () => {
            db.executeQuery("CREATE TABLE cmd_fkp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE cmd_fkc (id INTEGER, p_id INTEGER)");
            db.executeQuery("INSERT INTO cmd_fkp (id) VALUES (1)");
            db.executeQuery("INSERT INTO cmd_fkc (id, p_id) VALUES (10, 1)");
            const add = db.executeQuery("ALTER TABLE cmd_fkc ADD FOREIGN KEY (p_id) REFERENCES cmd_fkp (id)");
            const bad = db.executeQuery("INSERT INTO cmd_fkc (id, p_id) VALUES (11, 99)");
            const drop = db.executeQuery("ALTER TABLE cmd_fkc DROP FOREIGN KEY (p_id)");
            const okIns = db.executeQuery("INSERT INTO cmd_fkc (id, p_id) VALUES (12, 99)");
            db.executeQuery("DROP TABLE cmd_fkc");
            db.executeQuery("DROP TABLE cmd_fkp");
            return !add.error && bad.error !== undefined && bad.error.includes('Foreign key') && !drop.error && !okIns.error;
        }},
        { name: "Cmd: ADD FK Rejects Invalid Existing Data", fn: () => {
            db.executeQuery("CREATE TABLE cmd_fkp2 (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE cmd_fkc2 (id INTEGER, p_id INTEGER)");
            db.executeQuery("INSERT INTO cmd_fkp2 (id) VALUES (1)");
            db.executeQuery("INSERT INTO cmd_fkc2 (id, p_id) VALUES (10, 99)");
            const r = db.executeQuery("ALTER TABLE cmd_fkc2 ADD FOREIGN KEY (p_id) REFERENCES cmd_fkp2 (id)");
            db.executeQuery("DROP TABLE cmd_fkc2");
            db.executeQuery("DROP TABLE cmd_fkp2");
            return r.error !== undefined && r.error.includes('Foreign key');
        }},

        // ALTER COLUMN SET/DROP DEFAULT / NOT NULL
        { name: "Cmd: ALTER SET/DROP DEFAULT", fn: () => {
            db.executeQuery("CREATE TABLE cmd_def (id INTEGER, status TEXT)");
            const set = db.executeQuery("ALTER TABLE cmd_def ALTER COLUMN status SET DEFAULT 'active'");
            db.executeQuery("INSERT INTO cmd_def (id) VALUES (1)");
            const v = db.executeQuery("SELECT status FROM cmd_def WHERE id = 1");
            const drop = db.executeQuery("ALTER TABLE cmd_def ALTER COLUMN status DROP DEFAULT");
            db.executeQuery("INSERT INTO cmd_def (id) VALUES (2)");
            const v2 = db.executeQuery("SELECT status FROM cmd_def WHERE id = 2");
            db.executeQuery("DROP TABLE cmd_def");
            return !set.error && v.data[0].status === 'active' && !drop.error && v2.data[0].status === null;
        }},
        { name: "Cmd: ALTER SET/DROP NOT NULL", fn: () => {
            db.executeQuery("CREATE TABLE cmd_nn (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO cmd_nn (id, v) VALUES (1, 'x')");
            const set = db.executeQuery("ALTER TABLE cmd_nn ALTER COLUMN v SET NOT NULL");
            const bad = db.executeQuery("INSERT INTO cmd_nn (id, v) VALUES (2, null)");
            const drop = db.executeQuery("ALTER TABLE cmd_nn ALTER COLUMN v DROP NOT NULL");
            const ok = db.executeQuery("INSERT INTO cmd_nn (id, v) VALUES (3, null)");
            db.executeQuery("DROP TABLE cmd_nn");
            return !set.error && bad.error !== undefined && bad.error.includes('NOT NULL') && !drop.error && !ok.error;
        }},
        { name: "Cmd: SET NOT NULL Rejects Existing NULLs", fn: () => {
            db.executeQuery("CREATE TABLE cmd_nn2 (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO cmd_nn2 (id, v) VALUES (1, null)");
            const r = db.executeQuery("ALTER TABLE cmd_nn2 ALTER COLUMN v SET NOT NULL");
            db.executeQuery("DROP TABLE cmd_nn2");
            return r.error !== undefined && r.error.includes('NULL');
        }},

        // START TRANSACTION / RENAME TABLE / TRUNCATE 省略形
        { name: "Cmd: START TRANSACTION", fn: () => {
            db.executeQuery("CREATE TABLE cmd_tx (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO cmd_tx (id, v) VALUES (1, 10)");
            const st = db.executeQuery("START TRANSACTION");
            db.executeQuery("UPDATE cmd_tx SET v = 999 WHERE id = 1");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT v FROM cmd_tx WHERE id = 1");
            db.executeQuery("DROP TABLE cmd_tx");
            return !st.error && r.data[0].v === 10;
        }},
        { name: "Cmd: RENAME TABLE Statement", fn: () => {
            db.executeQuery("CREATE TABLE cmd_rn1 (id INTEGER)");
            db.executeQuery("INSERT INTO cmd_rn1 (id) VALUES (7)");
            const rn = db.executeQuery("RENAME TABLE cmd_rn1 TO cmd_rn2");
            const r = db.executeQuery("SELECT id FROM cmd_rn2");
            const old = db.executeQuery("SELECT * FROM cmd_rn1");
            db.executeQuery("DROP TABLE cmd_rn2");
            return !rn.error && r.data[0].id === 7 && old.error !== undefined;
        }},
        { name: "Cmd: TRUNCATE Without TABLE Keyword", fn: () => {
            db.executeQuery("CREATE TABLE cmd_tr (id INTEGER)");
            db.executeQuery("INSERT INTO cmd_tr (id) VALUES (1), (2)");
            const r = db.executeQuery("TRUNCATE cmd_tr");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM cmd_tr");
            db.executeQuery("DROP TABLE cmd_tr");
            return !r.error && c.data[0].c === 0;
        }},

        // SHOW COLUMNS / SHOW CREATE VIEW
        { name: "Cmd: SHOW COLUMNS FROM", sql: "SHOW COLUMNS FROM users", check: r => r.data.length >= 3 && r.data.some(d => d.Column === 'name') && r.data.some(d => d.Column === 'id') },
        { name: "Cmd: SHOW CREATE VIEW", fn: () => {
            db.executeQuery("CREATE VIEW cmd_v AS SELECT id FROM users");
            const r = db.executeQuery("SHOW CREATE VIEW cmd_v");
            db.executeQuery("DROP VIEW cmd_v");
            return !r.error && r.data[0].CreateView.includes('CREATE VIEW cmd_v AS SELECT id FROM users');
        }},

        // LIMIT offset, count (MySQL構文)
        { name: "Cmd: LIMIT Offset,Count", sql: "SELECT id FROM users ORDER BY id ASC LIMIT 2, 3", check: r => r.data.length === 3 && r.data[0].id === 3 && r.data[2].id === 5 },
        { name: "Cmd: LIMIT Offset,Count in UNION", sql: "SELECT id FROM users WHERE id <= 3 UNION SELECT id FROM users WHERE id >= 8 ORDER BY id ASC LIMIT 1, 2", check: r => r.data.length === 2 && r.data[0].id === 2 && r.data[1].id === 3 },

        // Cleanup (Cmd)
        { name: "Cmd: Cleanup", fn: () => {
            db.executeQuery("DROP TABLE cmd_rep");
            db.executeQuery("DROP TABLE cmd_odku");
            db.executeQuery("DROP TABLE cmd_pk");
            return true;
        }},

        // === コードレビュー第2弾修正の回帰テスト (Rev #1〜#6) ===

        // Rev#1: SQLスプリッタがバックスラッシュエスケープ・''二重化・コメントを認識する
        { name: "Rev1: Splitter Handles Backslash Escape", fn: () => {
            const stmts = splitSqlStatements("INSERT INTO t (n) VALUES ('O\\'Brien; x'); SELECT 1;");
            return stmts.length === 2 && stmts[0].includes("O\\'Brien; x") && stmts[1] === 'SELECT 1';
        }},
        { name: "Rev1: Splitter Handles Doubled Quotes", fn: () => {
            const stmts = splitSqlStatements("INSERT INTO t VALUES ('a''b;c'); SELECT 2;");
            return stmts.length === 2 && stmts[0].includes("a''b;c");
        }},
        { name: "Rev1: Splitter Ignores Semicolon in Comment", fn: () => {
            const stmts = splitSqlStatements("SELECT 1 -- comment; not a break\n; SELECT 2 /* x; y */;");
            return stmts.length === 2;
        }},
        { name: "Rev1: Export/Import Full Roundtrip via Splitter", fn: () => {
            const eng = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE rt (id INTEGER, s TEXT)");
            eng.executeQuery("INSERT INTO rt (id, s) VALUES (1, 'O''Brien; DROP TABLE x')");
            const dump = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng2.tables[t]);
            for (const st of splitSqlStatements(dump)) {
                const r = eng2.executeQuery(st);
                if (r.error) return false;
            }
            return eng2.executeQuery("SELECT s FROM rt").data[0].s === "O'Brien; DROP TABLE x";
        }},

        // Rev#2: FK列が「id系の名前」でも参照先の実在値から生成される
        { name: "Rev2: Dummy Data FK Column Named *_id", fn: () => {
            db.executeQuery("CREATE TABLE rev2_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE rev2_c (product_id INTEGER, rating INTEGER, FOREIGN KEY (product_id) REFERENCES rev2_p(id))");
            db.executeQuery("INSERT INTO rev2_p (id) VALUES (1), (2), (3)");
            let ok = true;
            try {
                db.generateDummyData('rev2_c', 50);
                const t = db.tables['rev2_c'];
                ok = t.rowCount === 50;
                for (let i = 0; i < t.rowCount && ok; i++) {
                    if (![1, 2, 3].includes(t.getValue('product_id', i))) ok = false;
                }
            } catch (e) { ok = false; }
            db.executeQuery("DROP TABLE rev2_c");
            db.executeQuery("DROP TABLE rev2_p");
            return ok;
        }},

        // Rev#3: ALTER制約操作がROLLBACKで巻き戻る
        { name: "Rev3: ALTER ADD PK / SET NOT NULL Rolls Back", fn: () => {
            db.executeQuery("CREATE TABLE rev3_t (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO rev3_t (id, v) VALUES (1, 'a')");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE rev3_t ADD PRIMARY KEY (id)");
            db.executeQuery("ALTER TABLE rev3_t ALTER COLUMN v SET NOT NULL");
            db.executeQuery("ROLLBACK");
            const t = db.tables['rev3_t'];
            const pkGone = t.primaryKey === null;
            const nnGone = !(t.notNullCols || []).includes('v');
            const idxGone = !t.indices['id'];
            // 巻き戻ったので重複ID + NULL が挿入できるはず
            const ins = db.executeQuery("INSERT INTO rev3_t (id, v) VALUES (1, null)");
            db.executeQuery("DROP TABLE rev3_t");
            return pkGone && nnGone && idxGone && !ins.error;
        }},
        { name: "Rev3: ALTER ADD FK Rolls Back", fn: () => {
            db.executeQuery("CREATE TABLE rev3_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE rev3_c (p_id INTEGER)");
            db.executeQuery("INSERT INTO rev3_p (id) VALUES (1)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE rev3_c ADD FOREIGN KEY (p_id) REFERENCES rev3_p(id)");
            db.executeQuery("ROLLBACK");
            const ins = db.executeQuery("INSERT INTO rev3_c (p_id) VALUES (99)");
            db.executeQuery("DROP TABLE rev3_c");
            db.executeQuery("DROP TABLE rev3_p");
            return !ins.error;
        }},
        { name: "Rev3: ALTER DROP PK Rolls Back", fn: () => {
            db.executeQuery("CREATE TABLE rev3_d (id INTEGER PRIMARY KEY)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE rev3_d DROP PRIMARY KEY");
            db.executeQuery("ROLLBACK");
            const restored = db.tables['rev3_d'].primaryKey === 'id';
            db.executeQuery("DROP TABLE rev3_d");
            return restored;
        }},

        // Rev#4: 不正な制約構文が偽カラムを作らず構文エラーになる
        // v1.2: 複数列の ADD UNIQUE / PRIMARY KEY は複合キーとしてサポートされた（旧: 構文エラー）
        { name: "Rev4: Multi-Column ADD UNIQUE Now Supported", fn: () => {
            db.executeQuery("CREATE TABLE rev4_t (a INTEGER, b INTEGER)");
            const r = db.executeQuery("ALTER TABLE rev4_t ADD UNIQUE (a, b)");
            const noBogusCol = !db.tables['rev4_t'].cols['unique'];
            db.executeQuery("INSERT INTO rev4_t (a, b) VALUES (1, 1)");
            const dup = db.executeQuery("INSERT INTO rev4_t (a, b) VALUES (1, 1)");
            db.executeQuery("DROP TABLE rev4_t");
            return !r.error && noBogusCol && dup.error !== undefined && dup.error.includes('UNIQUE');
        }},
        { name: "Rev4: Multi-Column ADD PRIMARY KEY Now Supported", fn: () => {
            db.executeQuery("CREATE TABLE rev4_u (a INTEGER, b INTEGER)");
            const r = db.executeQuery("ALTER TABLE rev4_u ADD PRIMARY KEY (a, b)");
            const noBogus = !db.tables['rev4_u'].cols['primary'];
            db.executeQuery("INSERT INTO rev4_u (a, b) VALUES (1, 1)");
            const dup = db.executeQuery("INSERT INTO rev4_u (a, b) VALUES (1, 1)");
            db.executeQuery("DROP TABLE rev4_u");
            return !r.error && noBogus && dup.error !== undefined && dup.error.includes('PRIMARY KEY');
        }},

        // Rev#5: サブクエリ内の非修飾同一識別子比較（相関の意図）が明示エラーになる
        { name: "Rev5: Unqualified Self-Compare in Subquery Rejected", fn: () => {
            db.executeQuery("CREATE TABLE rev5_d (dept_code INTEGER, budget INTEGER)");
            db.executeQuery("CREATE TABLE rev5_e (dept_code INTEGER, salary INTEGER)");
            db.executeQuery("INSERT INTO rev5_d (dept_code, budget) VALUES (1, 100)");
            db.executeQuery("INSERT INTO rev5_e (dept_code, salary) VALUES (1, 50)");
            const r = db.executeQuery("SELECT * FROM rev5_d WHERE budget > (SELECT SUM(salary) FROM rev5_e WHERE dept_code = dept_code)");
            db.executeQuery("DROP TABLE rev5_e");
            db.executeQuery("DROP TABLE rev5_d");
            return r.error !== undefined && r.error.includes('Correlated');
        }},
        { name: "Rev5: Normal Subquery Comparison Still Works", fn: () => {
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE id IN (SELECT user_id FROM orders WHERE amount >= 1)");
            return !r.error && r.data[0].c === 4;
        }},

        // Rev#6: UPSERTのバッチ化（正しさ + 性能）
        { name: "Rev6: REPLACE Batch-Internal Duplicate", fn: () => {
            db.executeQuery("CREATE TABLE rev6_b (id INTEGER PRIMARY KEY, v TEXT)");
            const r = db.executeQuery("REPLACE INTO rev6_b (id, v) VALUES (1, 'first'), (1, 'second')");
            const rows = db.executeQuery("SELECT v FROM rev6_b");
            db.executeQuery("DROP TABLE rev6_b");
            return !r.error && rows.data.length === 1 && rows.data[0].v === 'second';
        }},
        { name: "Rev6: IGNORE Batch-Internal Duplicate", fn: () => {
            db.executeQuery("CREATE TABLE rev6_i (id INTEGER PRIMARY KEY, v TEXT)");
            const r = db.executeQuery("INSERT IGNORE INTO rev6_i (id, v) VALUES (1, 'a'), (1, 'b')");
            const rows = db.executeQuery("SELECT v FROM rev6_i");
            db.executeQuery("DROP TABLE rev6_i");
            return !r.error && rows.data.length === 1 && rows.data[0].v === 'a' && r.data[0].Message.includes('1 ignored');
        }},
        { name: "Rev6: ODKU Batch-Internal Duplicate", fn: () => {
            db.executeQuery("CREATE TABLE rev6_o (id INTEGER PRIMARY KEY, cnt INTEGER)");
            const r = db.executeQuery("INSERT INTO rev6_o (id, cnt) VALUES (1, 0), (1, 0) ON DUPLICATE KEY UPDATE cnt = cnt + 1");
            const v = db.executeQuery("SELECT cnt FROM rev6_o WHERE id = 1");
            db.executeQuery("DROP TABLE rev6_o");
            return !r.error && v.data[0].cnt === 1;
        }},
        { name: "Rev6: IGNORE Batch With FK Violation Row", fn: () => {
            db.executeQuery("CREATE TABLE rev6_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE rev6_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES rev6_p(id))");
            db.executeQuery("INSERT INTO rev6_p (id) VALUES (1)");
            const r = db.executeQuery("INSERT IGNORE INTO rev6_c (id, p_id) VALUES (10, 1), (11, 99), (12, 1)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM rev6_c");
            db.executeQuery("DROP TABLE rev6_c");
            db.executeQuery("DROP TABLE rev6_p");
            return !r.error && c.data[0].c === 2 && r.data[0].Message.includes('1 ignored');
        }},
        // 削除で空いた物理位置へ同じ値を再挿入してもインデックスから漏れない
        // （rowCount縮小後の残留データと新値の偶然一致による差分更新スキップの回帰テスト）
        { name: "Rev6: Index Correct After Delete+Reinsert Same Value", fn: () => {
            db.executeQuery("CREATE TABLE rev6_x (id INTEGER)");
            db.executeQuery("CREATE INDEX idx_rev6x ON rev6_x (id)");
            db.executeQuery("INSERT INTO rev6_x (id) VALUES (1), (2)");
            db.executeQuery("DELETE FROM rev6_x WHERE id = 2");
            db.executeQuery("INSERT INTO rev6_x (id) VALUES (2)");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM rev6_x WHERE id = 2"); // INDEX SCAN 経路
            db.executeQuery("DROP TABLE rev6_x");
            return r.data[0].c === 1;
        }},
        { name: "Rev6: Bulk REPLACE INTO Batched Fast", fn: () => {
            db.executeQuery("CREATE TABLE rev6_t (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INTEGER)");
            const seed = [];
            for (let i = 1; i <= 5000; i++) seed.push([i, i]);
            db.insertRows('rev6_t', ['id', 'v'], seed);
            // 5000行の既存テーブルへ2000行REPLACE（1000衝突 + 1000新規）
            const vals = [];
            for (let i = 4001; i <= 6000; i++) vals.push(`(${i}, ${i * 10})`);
            const start = performance.now();
            const r = db.executeQuery(`REPLACE INTO rev6_t (id, v) VALUES ${vals.join(', ')}`);
            const elapsed = performance.now() - start;
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM rev6_t");
            const v1 = db.executeQuery("SELECT v FROM rev6_t WHERE id = 4001");
            db.executeQuery("DROP TABLE rev6_t");
            return !r.error && c.data[0].c === 6000 && v1.data[0].v === 40010 && elapsed < 1500;
        }},

        // === 追加機能テスト (コメント / 簡易CASE / 新関数 / REGEXP) ===
        { name: "Feat: Line Comment", sql: "SELECT 1 + 1 AS v -- trailing comment", check: r => r.data[0].v === 2 },
        { name: "Feat: Block Comment", sql: "SELECT /* inline */ 2 + 2 AS v FROM users LIMIT 1", check: r => r.data[0].v === 4 },
        { name: "Feat: Comment Chars Inside String Preserved", sql: "SELECT 'a -- b /* c */' AS s", check: r => r.data[0].s === 'a -- b /* c */' },
        { name: "Feat: Double Minus Arithmetic Not Comment", sql: "SELECT 5--3 AS v", check: r => r.data[0].v === 8 },
        { name: "Feat: Simple CASE", sql: "SELECT id, CASE age WHEN 25 THEN 'young' WHEN 30 THEN 'mid' ELSE 'other' END AS g FROM users WHERE id <= 2 ORDER BY id ASC", check: r => r.data[0].g === 'young' && r.data[1].g === 'mid' },
        { name: "Feat: Simple CASE No Else", sql: "SELECT CASE 9 WHEN 1 THEN 'one' END AS v", check: r => r.data[0].v === null },
        { name: "Feat: CONCAT_WS", sql: "SELECT CONCAT_WS('-', 'a', null, 'b') AS v", check: r => r.data[0].v === 'a-b' },
        { name: "Feat: SUBSTRING_INDEX", sql: "SELECT SUBSTRING_INDEX('a.b.c', '.', 2) AS p, SUBSTRING_INDEX('a.b.c', '.', -1) AS s", check: r => r.data[0].p === 'a.b' && r.data[0].s === 'c' },
        { name: "Feat: LOCATE / CEILING / TRUNCATE", sql: "SELECT LOCATE('b', 'abc') AS l, CEILING(1.2) AS c, TRUNCATE(3.14159, 2) AS t", check: r => r.data[0].l === 2 && r.data[0].c === 2 && r.data[0].t === 3.14 },
        { name: "Feat: REGEXP", sql: "SELECT COUNT(*) AS c FROM users WHERE name REGEXP '^A'", check: r => r.data[0].c === 1 },
        { name: "Feat: NOT REGEXP", sql: "SELECT COUNT(*) AS c FROM users WHERE name NOT REGEXP '^A'", check: r => r.data[0].c === 9 },

        // === Fix#7: UPDATE / ODKU 検証共通化の回帰テスト ===

        // ODKU の更新値にも FK 制約が効く（旧実装は素通しだった）
        { name: "Fix7: ODKU FK Constraint Enforced", fn: () => {
            db.executeQuery("CREATE TABLE fix7_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fix7_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fix7_p(id))");
            db.executeQuery("INSERT INTO fix7_p (id) VALUES (1)");
            db.executeQuery("INSERT INTO fix7_c (id, p_id) VALUES (10, 1)");
            const r = db.executeQuery("INSERT INTO fix7_c (id, p_id) VALUES (10, 1) ON DUPLICATE KEY UPDATE p_id = 99");
            const v = db.executeQuery("SELECT p_id FROM fix7_c WHERE id = 10");
            db.executeQuery("DROP TABLE fix7_c");
            db.executeQuery("DROP TABLE fix7_p");
            return r.error !== undefined && r.error.includes('Foreign key') && v.data[0].p_id === 1;
        }},
        // UPDATE のバッチ内衝突検出は共通化後も機能する
        { name: "Fix7: UPDATE Batch Collision Still Detected", fn: () => {
            db.executeQuery("CREATE TABLE fix7_u (id INTEGER PRIMARY KEY, v INTEGER)");
            db.executeQuery("INSERT INTO fix7_u (id, v) VALUES (1, 1), (2, 2)");
            const r = db.executeQuery("UPDATE fix7_u SET id = 5");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM fix7_u WHERE id = 5");
            db.executeQuery("DROP TABLE fix7_u");
            return r.error !== undefined && r.error.includes('PRIMARY KEY') && c.data[0].c === 0;
        }},
        // ODKU の更新値が他行の UNIQUE と衝突したら拒否される
        { name: "Fix7: ODKU Unique Collision Detected", fn: () => {
            db.executeQuery("CREATE TABLE fix7_q (id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
            db.executeQuery("INSERT INTO fix7_q (id, email) VALUES (1, 'a@x'), (2, 'b@x')");
            const r = db.executeQuery("INSERT INTO fix7_q (id, email) VALUES (1, 'zz') ON DUPLICATE KEY UPDATE email = 'b@x'");
            db.executeQuery("DROP TABLE fix7_q");
            return r.error !== undefined && r.error.includes('UNIQUE');
        }},
        // UPDATE 時の FK / NOT NULL 検証も共通化後に維持されている
        { name: "Fix7: UPDATE FK & NOT NULL Still Enforced", fn: () => {
            db.executeQuery("CREATE TABLE fix7_p2 (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fix7_c2 (id INTEGER, p_id INTEGER, nm TEXT NOT NULL, FOREIGN KEY (p_id) REFERENCES fix7_p2(id))");
            db.executeQuery("INSERT INTO fix7_p2 (id) VALUES (1)");
            db.executeQuery("INSERT INTO fix7_c2 (id, p_id, nm) VALUES (10, 1, 'x')");
            const fkErr = db.executeQuery("UPDATE fix7_c2 SET p_id = 99 WHERE id = 10");
            const nnErr = db.executeQuery("UPDATE fix7_c2 SET nm = null WHERE id = 10");
            db.executeQuery("DROP TABLE fix7_c2");
            db.executeQuery("DROP TABLE fix7_p2");
            return fkErr.error !== undefined && fkErr.error.includes('Foreign key')
                && nnErr.error !== undefined && nnErr.error.includes('NOT NULL');
        }},

        // === 追加機能テスト第2弾 (統計集計 / NOT BETWEEN / ORDER BY序数 / INSERT SET) ===
        { name: "Feat2: STDDEV & VARIANCE", fn: () => {
            db.executeQuery("CREATE TABLE feat2_s (v INTEGER)");
            db.executeQuery("INSERT INTO feat2_s (v) VALUES (2), (4), (4), (4), (5), (5), (7), (9)");
            const r = db.executeQuery("SELECT STDDEV(v) AS s, VARIANCE(v) AS va FROM feat2_s");
            db.executeQuery("DROP TABLE feat2_s");
            return !r.error && r.data[0].s === 2 && r.data[0].va === 4;
        }},
        { name: "Feat2: MEDIAN Odd & Even", fn: () => {
            db.executeQuery("CREATE TABLE feat2_m (v INTEGER)");
            db.executeQuery("INSERT INTO feat2_m (v) VALUES (1), (3), (5)");
            const odd = db.executeQuery("SELECT MEDIAN(v) AS m FROM feat2_m");
            db.executeQuery("INSERT INTO feat2_m (v) VALUES (100)");
            const even = db.executeQuery("SELECT MEDIAN(v) AS m FROM feat2_m");
            db.executeQuery("DROP TABLE feat2_m");
            return odd.data[0].m === 3 && even.data[0].m === 4;
        }},
        { name: "Feat2: MEDIAN with GROUP BY", fn: () => {
            db.executeQuery("CREATE TABLE feat2_g (grp TEXT, v INTEGER)");
            db.executeQuery("INSERT INTO feat2_g (grp, v) VALUES ('a', 1), ('a', 9), ('a', 5), ('b', 10), ('b', 20)");
            const r = db.executeQuery("SELECT grp, MEDIAN(v) AS m FROM feat2_g GROUP BY grp ORDER BY grp ASC");
            db.executeQuery("DROP TABLE feat2_g");
            return !r.error && r.data[0].m === 5 && r.data[1].m === 15;
        }},
        { name: "Feat2: STDDEV on Empty Table", sql: "SELECT STDDEV(id) AS s FROM test_empty", check: r => r.data[0].s === null },
        { name: "Feat2: NOT BETWEEN", sql: "SELECT COUNT(*) AS c FROM users WHERE age NOT BETWEEN 25 AND 30", check: r => r.data[0].c === 5 },
        { name: "Feat2: BETWEEN Still Works", sql: "SELECT COUNT(*) AS c FROM users WHERE age BETWEEN 25 AND 30", check: r => r.data[0].c === 5 },
        { name: "Feat2: ORDER BY Ordinal", sql: "SELECT name, age FROM users ORDER BY 2 DESC, 1 ASC LIMIT 2", check: r => r.data[0].name === 'Frank' && r.data[1].name === 'Dave' },
        errCase("Feat2: ORDER BY Ordinal Out of Range", "SELECT id FROM users ORDER BY 5", 'out of range'),
        { name: "Feat2: ORDER BY Ordinal in UNION", sql: "SELECT id FROM users WHERE id <= 2 UNION SELECT id FROM users WHERE id >= 9 ORDER BY 1 DESC", check: r => r.data.length === 4 && r.data[0].id === 10 && r.data[3].id === 1 },
        { name: "Feat2: INSERT INTO SET", fn: () => {
            db.executeQuery("CREATE TABLE feat2_i (id INTEGER PRIMARY KEY, name TEXT, flag BOOLEAN)");
            const r = db.executeQuery("INSERT INTO feat2_i SET id = 1, name = 'Alice, Bob', flag = true");
            const v = db.executeQuery("SELECT * FROM feat2_i WHERE id = 1");
            db.executeQuery("DROP TABLE feat2_i");
            return !r.error && v.data[0].name === 'Alice, Bob' && v.data[0].flag === true;
        }},
        { name: "Feat2: REPLACE INTO SET", fn: () => {
            db.executeQuery("CREATE TABLE feat2_r (id INTEGER PRIMARY KEY, v TEXT)");
            db.executeQuery("INSERT INTO feat2_r (id, v) VALUES (1, 'old')");
            const r = db.executeQuery("REPLACE INTO feat2_r SET id = 1, v = 'new'");
            const v = db.executeQuery("SELECT v FROM feat2_r WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM feat2_r");
            db.executeQuery("DROP TABLE feat2_r");
            return !r.error && v.data[0].v === 'new' && c.data[0].c === 1;
        }},
        { name: "Feat2: INSERT SET with ODKU", fn: () => {
            db.executeQuery("CREATE TABLE feat2_o (id INTEGER PRIMARY KEY, cnt INTEGER)");
            db.executeQuery("INSERT INTO feat2_o SET id = 1, cnt = 5");
            const r = db.executeQuery("INSERT INTO feat2_o SET id = 1, cnt = 0 ON DUPLICATE KEY UPDATE cnt = cnt + 10");
            const v = db.executeQuery("SELECT cnt FROM feat2_o WHERE id = 1");
            db.executeQuery("DROP TABLE feat2_o");
            return !r.error && v.data[0].cnt === 15;
        }},

        // === 追加コマンド第3弾 (CREATE TABLE LIKE / OR REPLACE PROCEDURE / SHOW TABLES LIKE / VACUUM) ===
        { name: "Cmd3: CREATE TABLE LIKE Copies Schema", fn: () => {
            db.executeQuery("CREATE TABLE like_src (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, st TEXT DEFAULT 'ok')");
            db.executeQuery("CREATE INDEX idx_like_src ON like_src (name)");
            db.executeQuery("INSERT INTO like_src (name) VALUES ('a')");
            const r = db.executeQuery("CREATE TABLE like_dst LIKE like_src");
            const t = db.tables['like_dst'];
            const emptyRows = t.rowCount === 0;
            const meta = t.primaryKey === 'id' && t.autoIncrementCol === 'id' && t.notNullCols.includes('name') && t.defaults.st === 'ok' && !!t.indices['name'];
            const ins = db.executeQuery("INSERT INTO like_dst (name) VALUES ('x')"); // AI/DEFAULT が機能する
            const v = db.executeQuery("SELECT id, st FROM like_dst");
            db.executeQuery("DROP TABLE like_dst");
            db.executeQuery("DROP TABLE like_src");
            return !r.error && emptyRows && meta && !ins.error && v.data[0].id === 1 && v.data[0].st === 'ok';
        }},
        errCase("Cmd3: CREATE TABLE LIKE Missing Source", "CREATE TABLE like_x LIKE no_such_src", 'not found'),
        { name: "Cmd3: CREATE OR REPLACE PROCEDURE", fn: () => {
            db.executeQuery("CREATE PROCEDURE proc_or AS SELECT 1 AS v");
            const dup = db.executeQuery("CREATE PROCEDURE proc_or AS SELECT 2 AS v");
            const rep = db.executeQuery("CREATE OR REPLACE PROCEDURE proc_or AS SELECT 2 AS v");
            const call = db.executeQuery("CALL proc_or");
            db.executeQuery("DROP PROCEDURE proc_or");
            return dup.error !== undefined && !rep.error && call.data[0].v === 2;
        }},
        { name: "Cmd3: SHOW TABLES LIKE", fn: () => {
            db.executeQuery("CREATE TABLE liketest_one (id INTEGER)");
            db.executeQuery("CREATE TABLE liketest_two (id INTEGER)");
            const r = db.executeQuery("SHOW TABLES LIKE 'liketest%'");
            db.executeQuery("DROP TABLE liketest_one");
            db.executeQuery("DROP TABLE liketest_two");
            return !r.error && r.data.length === 2 && r.data.every(d => d.Table.startsWith('liketest'));
        }},
        { name: "Cmd3: VACUUM Compacts String Pool & Capacity", fn: () => {
            db.executeQuery("CREATE TABLE vac_t (id INTEGER, s TEXT)");
            const vals = [];
            for (let i = 1; i <= 200; i++) vals.push([i, 'str_' + i]);
            db.insertRows('vac_t', ['id', 's'], vals);
            db.executeQuery("DELETE FROM vac_t WHERE id > 10");
            const before = db.tables['vac_t'].strPools['s'].length;
            const r = db.executeQuery("VACUUM");
            const after = db.tables['vac_t'].strPools['s'].length;
            const v = db.executeQuery("SELECT s FROM vac_t WHERE id = 5");
            const capOk = db.tables['vac_t'].capacity <= 1024;
            db.executeQuery("DROP TABLE vac_t");
            return !r.error && before === 200 && after === 10 && v.data[0].s === 'str_5' && capOk;
        }},
        { name: "Cmd3: VACUUM Rejected In Transaction", fn: () => {
            db.executeQuery("BEGIN");
            const r = db.executeQuery("VACUUM");
            db.executeQuery("ROLLBACK");
            return r.error !== undefined && r.error.includes('transaction');
        }},

        // === セキュリティ強化テスト (プロトタイプ汚染 / DoSガード) ===
        { name: "Sec: __proto__ String Value Roundtrip", fn: () => {
            db.executeQuery("CREATE TABLE sec_p (v TEXT)");
            db.executeQuery("INSERT INTO sec_p (v) VALUES ('__proto__'), ('constructor'), ('normal')");
            const r = db.executeQuery("SELECT v FROM sec_p WHERE v = '__proto__'");
            const all = db.executeQuery("SELECT COUNT(*) AS c FROM sec_p");
            db.executeQuery("DROP TABLE sec_p");
            return !r.error && r.data.length === 1 && r.data[0].v === '__proto__' && all.data[0].c === 3;
        }},
        { name: "Sec: __proto__ Value Survives IDB Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            eng.executeQuery("CREATE TABLE sec_r (v TEXT)");
            eng.executeQuery("INSERT INTO sec_r (v) VALUES ('__proto__'), ('x')");
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(eng.exportForIDB());
            const r = eng2.executeQuery("SELECT v FROM sec_r WHERE v = '__proto__'");
            return !r.error && r.data.length === 1 && r.data[0].v === '__proto__';
        }},
        // v1.24: '__' 始まりの表名は予約（保存時に内部カタログと衝突して消えるため）。
        // 「作れるが隔離されている」より強い「作れない」を固定し、拒否後も他の表が無事なことを見る
        { name: "Sec: Table Named __proto__ Is Refused", fn: () => {
            const r1 = db.executeQuery("CREATE TABLE __proto__ (id INTEGER)");
            const others = db.executeQuery("SELECT COUNT(*) AS c FROM users"); // 他テーブルが無事
            return !!r1.error && /reserved/i.test(r1.error)
                && db.tables.__proto__ === undefined
                && !others.error && ({}).id === undefined;
        }},
        { name: "Sec: Column Named constructor Works", fn: () => {
            db.executeQuery("CREATE TABLE sec_c (constructor TEXT)");
            db.executeQuery("INSERT INTO sec_c (constructor) VALUES ('hello')");
            const r = db.executeQuery("SELECT constructor FROM sec_c");
            db.executeQuery("DROP TABLE sec_c");
            return !r.error && r.data[0].constructor === 'hello';
        }},
        { name: "Sec: Builtin Names Not Treated As Tables", fn: () => {
            const r1 = db.executeQuery("SELECT * FROM constructor");
            const r2 = db.executeQuery("SELECT * FROM hasOwnProperty");
            return r1.error !== undefined && r1.error.includes('not found') && r2.error !== undefined && r2.error.includes('not found');
        }},
        { name: "Sec: Query Length Cap", fn: () => {
            const r = db.executeQuery("SELECT '" + "a".repeat(1000001) + "' AS v");
            return r.error !== undefined && r.error.includes('too long');
        }},
        { name: "Sec: Subquery Expansion Cap", fn: () => {
            let deep = "SELECT 1 AS v";
            for (let i = 0; i < 120; i++) deep = "SELECT 1 AS v WHERE EXISTS (" + deep + ")";
            const r = db.executeQuery(deep);
            let ok5 = "SELECT 1 AS v";
            for (let i = 0; i < 5; i++) ok5 = "SELECT 1 AS v WHERE EXISTS (" + ok5 + ")";
            const r2 = db.executeQuery(ok5);
            return r.error !== undefined && r.error.includes('Too many subqueries') && !r2.error && r2.data[0].v === 1;
        }},
        { name: "Sec: REGEXP Pattern Length Cap", fn: () => {
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE name REGEXP '" + "a".repeat(1500) + "'");
            return r.error !== undefined && r.error.includes('too long');
        }},

        // === 排他制御テスト ===
        { name: "Excl: External API Write Blocked During Tx", fn: () => {
            db.executeQuery("CREATE TABLE excl_t (id INTEGER)");
            db.executeQuery("BEGIN");
            const w = LuminaDB.query("INSERT INTO excl_t (id) VALUES (1)");
            const r = LuminaDB.query("SELECT COUNT(*) AS c FROM excl_t"); // 読み取りは許可
            db.executeQuery("ROLLBACK");
            const wOk = LuminaDB.query("INSERT INTO excl_t (id) VALUES (2)"); // 終了後は許可
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM excl_t");
            db.executeQuery("DROP TABLE excl_t");
            return w.error !== undefined && w.error.includes('Transaction in progress')
                && !r.error && r.data[0].c === 0 && !wOk.error && c.data[0].c === 1;
        }},
        { name: "Excl: External BEGIN Blocked During Tx", fn: () => {
            db.executeQuery("BEGIN");
            const b = LuminaDB.query("BEGIN");
            db.executeQuery("ROLLBACK");
            return b.error !== undefined;
        }},
        { name: "Excl: AutoSave Guarded Against Open Tx", fn: () => {
            // 実IDBへ副作用を出さずにガードの存在を検証（isTesting中は早期returnするため実行不可）
            const src = triggerAutoSave.toString();
            return src.includes('inTransaction');
        }},
        { name: "Excl: Optimistic Lock Blocks Stale Save", fn: async () => {
            const original = await loadDB(); // 現在の保存状態を退避（バージョンも同期される）
            try {
                await saveDB(db.exportForIDB());
                const okVer = dbSnapshotVersion;
                dbSnapshotVersion = okVer - 1; // 「別タブが先に保存した」状況を再現
                let blocked = false;
                try { await saveDB(db.exportForIDB()); } catch (e) { blocked = true; }
                dbSnapshotVersion = okVer;
                await saveDB(db.exportForIDB()); // バージョン一致なら保存できる
                return blocked;
            } finally {
                // テストによるIDB汚染を復元
                if (original !== undefined) { await saveDB(original); }
                else { await clearDB(); }
            }
        }},
        { name: "Excl: Sandboxed iframe postMessage Blocked", fn: () => new Promise(resolve => {
            db.executeQuery("CREATE TABLE excl_pm (id INTEGER)");
            // file:// 環境（origin 'null' が許可リスト入り）を再現し、
            // サンドボックスiframe（origin 'null'・source≠window）からの書き込みが遮断されることを確認
            LuminaDB.allowedOrigins.push('null');
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.style.display = 'none';
            iframe.srcdoc = `<script>parent.postMessage({ type: 'luminadb:query', id: 1, sql: "INSERT INTO excl_pm (id) VALUES (99)" }, '*');<\/script>`;
            document.body.appendChild(iframe);
            setTimeout(() => {
                const c = db.executeQuery("SELECT COUNT(*) AS c FROM excl_pm");
                db.executeQuery("DROP TABLE excl_pm");
                iframe.remove();
                const idx = LuminaDB.allowedOrigins.indexOf('null');
                if (idx > -1) LuminaDB.allowedOrigins.splice(idx, 1);
                resolve(c.data[0].c === 0);
            }, 400);
        })},

        // === ローカル保存の暗号化テスト ===
        { name: "Enc: Serialize/Deserialize Preserves TypedArrays", fn: () => {
            const eng = new DatabaseEngine();
            eng.executeQuery("CREATE TABLE ser_t (id INTEGER, s TEXT, f FLOAT)");
            eng.executeQuery("INSERT INTO ser_t (id, s, f) VALUES (1, 'あいう''x', 3.14), (2, null, -0.5)");
            const restored = deserializeDump(serializeDump(eng.exportForIDB()));
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(restored);
            const r = eng2.executeQuery("SELECT id, s, f FROM ser_t ORDER BY id ASC");
            return r.data.length === 2 && r.data[0].s === "あいう'x" && r.data[0].f === 3.14
                && r.data[1].s === null && r.data[1].f === -0.5;
        }},
        { name: "Enc: Snapshot Stored Encrypted & Roundtrips", fn: async () => {
            const original = await loadDB().catch(() => undefined);
            try {
                await saveDB(db.exportForIDB());
                // 生のレコードを直接読み、暗号文ラッパーであること（平文のテーブルキーが無いこと）を確認。
                // v1.16 からはテーブル単位の差分保存なので 'meta' と 'tbl:<name>' の両方を見る
                const idb = await initDB();
                const rawGet = (key) => new Promise((res, rej) => {
                    const tx = idb.transaction('snapshots', 'readonly');
                    const rq = tx.objectStore('snapshots').get(key);
                    rq.onsuccess = () => res(rq.result);
                    rq.onerror = () => rej(rq.error);
                });
                const encOk = (rec) => !!rec && rec.__encrypted__ === true
                    && rec.data instanceof ArrayBuffer
                    && rec.iv instanceof Uint8Array
                    && typeof rec.__version__ === 'number';
                const meta = await rawGet('meta');
                const tbl = await rawGet('tbl:users');
                const isEncrypted = encOk(meta) && encOk(tbl)
                    && meta.tables === undefined && meta.catalog === undefined   // 平文の中身が漏れていない
                    && tbl.cols === undefined
                    && (await rawGet('latest')) === undefined;                   // 旧形式は残っていない
                // 復号ロードで元データへ戻ることを確認
                const loaded = await loadDB();
                const eng = new DatabaseEngine();
                eng.importFromIDB(loaded);
                const roundtrip = eng.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c === db.tables['users'].rowCount;
                return isEncrypted && roundtrip;
            } finally {
                if (original !== undefined) { await saveDB(original); }
                else { await clearDB(); }
            }
        }},
        { name: "Enc: Legacy Plain Snapshot Still Loads", fn: async () => {
            const original = await loadDB().catch(() => undefined);
            try {
                // 旧形式（平文）のスナップショットを直接書き込み、読み込み互換を確認
                const eng = new DatabaseEngine();
                const plain = eng.exportForIDB();
                plain.__version__ = 12345;
                const idb = await initDB();
                await new Promise((res, rej) => {
                    const tx = idb.transaction('snapshots', 'readwrite');
                    tx.objectStore('snapshots').put(plain, 'latest');
                    tx.oncomplete = res;
                    tx.onerror = () => rej(tx.error);
                });
                const loaded = await loadDB();
                return loaded !== undefined && !loaded.__encrypted__ && !!loaded.users && dbSnapshotVersion === 12345;
            } finally {
                if (original !== undefined) { await saveDB(original); }
                else { await clearDB(); }
            }
        }},
        { name: "Enc: AutoSave Flush Exists & Guarded", fn: () => {
            if (typeof flushAutoSave !== 'function') return false;
            // isTesting 中はフラッシュしても保存を開始しない（ガードの検証）
            autoSaveTimer = setTimeout(() => {}, 5000);
            const guarded = flushAutoSave() === false;
            return guarded && autoSaveTimer === null;
        }},

        // ============================================================
        // 追加テスト群（複雑クエリ / 異常系 / 境界値 / 性能 / セキュリティ）
        // 定義は js/tests/test-suite-extra.js の getExtraTests()
        // ============================================================
        ...getExtraTests(),

        // ============================================================
        // 新機能テスト群（FK参照アクション / CHECK制約 / 追加関数）
        // 定義は js/tests/test-suite-features.js の getFeatureTests()
        // ============================================================
        ...getFeatureTests(),

        // ============================================================
        // バグ修正・機能追加テスト群（インデックス最適化 / カンマ結合 /
        // HAVING・ORDER BY 拡張 / DML LIMIT / DDLロールバック ほか）
        // 定義は js/tests/test-suite-fixes.js の getFixTests()
        // ============================================================
        ...getFixTests(),

        // ============================================================
        // v1.1 機能テスト群（追加関数 / JSON / RETURNING / NULLS順序 /
        // 新集計・ウィンドウ関数 / DDL拡張 / 外部API拡張）
        // 定義は js/tests/test-suite-v2.js の getV2Tests()
        // ============================================================
        ...getV2Tests(),

        // ============================================================
        // v1.2 機能テスト群（相関サブクエリ / WITH RECURSIVE / VALUES式 /
        // 複合キー / TEMPORARY TABLE / 集計・関数拡張 / API CRUD）
        // 定義は js/tests/test-suite-v3.js の getV3Tests()
        // ============================================================
        ...getV3Tests(),

        // ============================================================
        // v1.3 機能テスト群（トリガー / ユーザー変数 / ウィンドウフレーム /
        // upsert×SELECT / CHANGE COLUMN / TABLE文 / API拡張）
        // 定義は js/tests/test-suite-v4.js の getV4Tests()
        // ============================================================
        ...getV4Tests(),

        // ============================================================
        // v1.4 機能テスト群（DEFAULT CURRENT_TIMESTAMP / JOIN USING・NATURAL /
        // INTERSECT・EXCEPT ALL / Did-you-mean / UI改善）
        // 定義は js/tests/test-suite-v5.js の getV5Tests()
        // ============================================================
        ...getV5Tests(),

        // ============================================================
        // v1.5 機能テスト群（ハッシュ・エンコード関数 / MIN_BY・PERCENTILE 等の新集計 /
        // ROLLUP / VALUES文 / FROM DUAL / CTE列リスト / CHECK・ANALYZE TABLE /
        // SHOW FUNCTIONS / API拡張）
        // 定義は js/tests/test-suite-v6.js の getV6Tests()
        // ============================================================
        ...getV6Tests(),

        // ============================================================
        // v1.6 機能テスト群（式左辺の関数呼び出し / LIKE ESCAPE / QUALIFY / GROUPING /
        // STRING_AGG・CORR 等の新集計 / シーケンス / PREPARE・EXECUTE / EXPLAIN ANALYZE /
        // ALTER IF EXISTS / API prepare・イベント）
        // 定義は js/tests/test-suite-v7.js の getV7Tests()
        // ============================================================
        ...getV7Tests(),

        // ============================================================
        // v1.7 機能テスト群（FILTER(WHERE)集計 / GENERATE_SERIES / named window /
        // 生成列 / API explain・each / SQL整形 formatSql）
        // 定義は js/tests/test-suite-v8.js の getV8Tests()
        // ============================================================
        ...getV8Tests(),

        // ============================================================
        // v1.8 機能テスト群（Command Reference 検索 / Table Editor 制約編集 /
        // 「編集 ⇔ 実装コマンド(生成DDL)」整合性）
        // 定義は js/tests/test-suite-v9.js の getV9Tests()
        // ============================================================
        ...getV9Tests(),

        // ============================================================
        // v1.9 機能テスト群（商用DB頻用のスカラー関数: DECODE/NVL2/CHOOSE/
        // STARTS_WITH/CHARINDEX/STUFF/GCD/LCM/WIDTH_BUCKET/ADD_MONTHS/DATE_PART ほか）
        // 定義は js/tests/test-suite-v10.js の getV10Tests()
        // ============================================================
        ...getV10Tests(),

        // ============================================================
        // v1.10 機能テスト群（追加の商用スカラー関数 / LISTAGG /
        // コンソールの結果件数表示・クリック再読込）
        // 定義は js/tests/test-suite-v11.js の getV11Tests()
        // ============================================================
        ...getV11Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v12.js の getV12Tests()
        //   v1.11: 商用DBスカラー関数 / TOP / MERGE / ON CONFLICT
        // ============================================================
        ...getV12Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v13.js の getV13Tests()
        //   網羅性拡大（関数/演算子/クエリ機能の総当たり、〜800件）
        // ============================================================
        ...getV13Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v14.js の getV14Tests()
        //   v1.12: FULL OUTER JOIN / GROUPING SETS・CUBE / PIVOT・UNPIVOT /
        //          APPLY・LATERAL / IS DISTINCT FROM / 量化比較 / WITHIN GROUP /
        //          RANGE・GROUPS フレーム / MATERIALIZED VIEW / ブラウザDB運用
        // ============================================================
        ...getV14Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v15.js の getV15Tests()
        //   網羅性拡大 第2弾（新構文＋既存機能の総当たり、〜800件）
        // ============================================================
        ...getV15Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v16.js の getV16Tests()
        //   超複雑・大型クエリ（数千行の受注スキーマに対する多重結合 /
        //   多段CTE / ウィンドウ / 巨大SQL文 / 深いネスト、〜990件）
        // ============================================================
        ...getV16Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v17.js の getV17Tests()
        //   v1.14 で追加した SQL コマンド（|| / :: / ILIKE / SIMILAR TO /
        //   行コンストラクタ / DISTINCT ON / WITH TIES / GROUP BY ALL /
        //   * EXCLUDE・REPLACE / 複数表 DML / CREATE FUNCTION /
        //   INFORMATION_SCHEMA / 表関数）とブラウザDB運用機能
        //   （スナップショット・タイムアウト・読み取り専用・ライブクエリ）の回帰
        // ============================================================
        ...getV17Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v18.js の getV18Tests()
        //   セキュリティ（インジェクション / 識別子検証 / JS脱出 /
        //   プロトタイプ汚染 / DoSガード / 読み取り専用の強制 /
        //   API境界 / 出力エスケープ、〜520件）
        // ============================================================
        ...getV18Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v19.js の getV19Tests()
        //   パフォーマンス（較正付きの時間予算 + 計算量スケーリング、〜500件）
        // ============================================================
        ...getV19Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v20.js の getV20Tests()
        //   v1.15 で追加した SQL（日付±INTERVAL / COLLATE / MATCH AGAINST /
        //   LIKE ANY・ALL / IGNORE NULLS / JSON_TABLE / TABLESAMPLE /
        //   プロシージャの制御構造 / ON UPDATE CURRENT_TIMESTAMP / PRAGMA /
        //   sqlite_master / DECLARE @x / EXPLAIN FORMAT / DROP CASCADE）と、
        //   ブラウザDB必須機能（ワーカー実行・マイグレーション・バックアップ）。
        //   新しい入口のセキュリティ検査と性能予算も同スイートに含む
        // ============================================================
        ...getV20Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v21.js の getV21Tests()
        //   v1.16: 手続き型の完成（カーソル / DECLARE HANDLER / SIGNAL / CASE 文）、
        //   OVERLAPS・IS JSON・JSON_EXISTS/QUERY・BETWEEN SYMMETRIC、
        //   DATE_BIN・TIME_BUCKET・AGE・EXTRACT(EPOCH/DOW/DOY)、
        //   スキーマ修飾・部分インデックス・FOR UPDATE・CTE ヒント、
        //   差分永続化・ストリーミング読み出し・タブ間追従
        // ============================================================
        ...getV21Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v22.js の getV22Tests()
        //   v1.17: 配列（ARRAY[...] と関連関数）、回帰・MODE 集計、あいまい照合、
        //   AT TIME ZONE、時系列 GENERATE_SERIES と WITH ORDINALITY、
        //   ウィンドウの EXCLUDE / FILTER、式コンパイルキャッシュ、
        //   CSV 取り込み、リーダー選出
        // ============================================================
        ...getV22Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v23.js の getV23Tests()
        //   v1.18: 桁指定付き CAST/CONVERT、更新可能ビューと WITH CHECK OPTION、
        //   INSTEAD OF トリガー、列レベル REFERENCES、JSON アクセス演算子、
        //   IS [NOT] TRUE/FALSE、名前付き制約、DELETE/UPDATE の別名、
        //   行コンストラクタ IN (SELECT)、索引の並び順/式キー、メタデータビュー、
        //   UNNEST(配列)、および UI（結果絞り込み・セル詳細・スキーマツリー展開・
        //   トランザクションバー・カーソル位置の文の実行）
        // ============================================================
        ...getV23Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v24.js の getV24Tests()
        //   v1.19: 複合列 FOREIGN KEY、シーケンスのオプションと ALTER SEQUENCE、
        //   DEFAULT 式（NEXTVAL / UUID / 算術）、MERGE の条件付き WHEN と
        //   NOT MATCHED BY SOURCE、VALUES(col) と ON CONFLICT ... WHERE、
        //   CREATE VIEW の列リスト、ALTER INDEX RENAME / SHOW TABLE STATUS /
        //   WITH [NO] DATA、集計入れ子の診断、および UI（結果グリッドの直接編集・
        //   Markdown / INSERT コピー・ショートカット一覧）
        // ============================================================
        ...getV24Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v25.js の getV25Tests()
        //   v1.20: 連結系集計の引数内 ORDER BY、ORDER BY へのウィンドウ関数、
        //   UPDATE/DELETE の派生表ソース、SELECT 句の集合返し関数、DIV 演算子、
        //   CREATE DOMAIN / TYPE AS ENUM、USER/ROLE、TRUNCATE CONTINUE IDENTITY、
        //   再帰CTE の SEARCH / CYCLE、IN のインデックス活用、定数列の命名、
        //   および UI（結果グリッドの行追加・削除、クエリ履歴パネル）
        // ============================================================
        ...getV25Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v26.js の getV26Tests()
        //   v1.21: GROUP BY 結果へのウィンドウ関数、列レベル COLLATE の実効化、
        //   ORDER BY ALL / GROUPING_ID、ALTER COLUMN の標準綴りと USING、
        //   RENAME CONSTRAINT、INSERT ... OVERRIDING VALUE、JOIN LATERAL ... ON TRUE、
        //   1 始まりの添字とスライス、文単位の警告と SHOW WARNINGS、
        //   および UI（エディタタブ、警告のコンソール出力）
        // ============================================================
        ...getV26Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v27.js の getV27Tests()
        //   v1.22: 日付演算（日付 ± 数値 / 日付 - 日付）、Oracle の階層問い合わせ
        //   （CONNECT BY / LEVEL / SYS_CONNECT_BY_PATH）と ROWNUM、分析関数
        //   （RATIO_TO_REPORT / PERCENTILE_* OVER / NTH_VALUE FROM LAST / KEEP）、
        //   TRUNCATE の複数表指定、CREATE INDEX の INCLUDE / CONCURRENTLY、
        //   ADD COLUMN の生成列、SET CONSTRAINTS、upsert の RETURNING、
        //   PostgreSQL の照合演算子、および UI（列プロファイル・ER 図）
        // ============================================================
        ...getV27Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v28.js の getV28Tests()
        //   v1.23: AS を省いた別名 / 引用符付き別名 / 修飾スター / 出力列名の重複解決、
        //   LTRIM・RTRIM の文字集合、SUBSTRING の負の開始位置、LPAD/RPAD の切り詰め、
        //   HEX/UNHEX の UTF-8 化、TO_TIMESTAMP のエポック秒、AGE の符号、
        //   REGEXP_* の position/occurrence/match_type、SHA2/SHA256/SHA224、
        //   列の改名・削除に伴うメタデータ追随（生成列・CHECK・列順・索引名）、
        //   複合 UNIQUE INDEX、INSERT の未知列拒否、INSERT OR <action>、
        //   ALTER TABLE の複数アクション、括弧付き集合演算、エラーメッセージの改善、
        //   および UI（スキーマ検索・スプリッタ・Explain・行選択・書き出し）
        // ============================================================
        ...getV28Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v29.js の getV29Tests()
        //   v1.24: NULL の 3 値論理（比較 / NOT / IN / CHECK / LIKE 系）、
        //   IS [NOT] NULL・UNKNOWN の述語としての据え置き、外部結合の SELECT * の
        //   NULL 埋め、ALTER TABLE の括弧付き型と方言別名、'__' で始まる表名の拒否、
        //   transaction() の async 拒否 / insert() の列は全行の和集合。
        //   UI（Data モーダルへの集約、SQL インポートの失敗レポート、
        //   RFC4180 CSV・新規表作成・置換・ドラッグ&ドロップ）も含む
        // ============================================================
        ...getV29Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v30.js の getV30Tests()
        //   v1.25: 算術の NULL 伝播と 0 除算、DATE と DATETIME / TIMESTAMP の分離
        //   （CAST(x AS DATE) の時刻切り捨て・日付比較の時刻寄せ）、
        //   ウィンドウ関数の既定フレーム（RANGE ... CURRENT ROW）、
        //   FOREIGN KEY の ON DELETE SET DEFAULT、COMMENT ON の ROLLBACK、
        //   および UI（1 文あたりの実行時間の上限）
        // ============================================================
        ...getV30Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v31.js の getV31Tests()
        //   v1.26: バッククォートの区切り識別子（予約語を列名・表名に使える／
        //   識別子として不正な名前は明示エラー／ダブルクォートは文字列のまま案内）、
        //   GROUPING SETS の中の ROLLUP / CUBE / 入れ子、
        //   exportSQL のトリガー・関数・プロシージャ・コメント出力と索引名、
        //   および UI（スキーマツリーの右クリックメニュー）
        // ============================================================
        ...getV31Tests(),
        // 定義は js/tests/test-suite-v32.js の getV32Tests()
        ...getV32Tests(),
        // 定義は js/tests/test-suite-v33.js の getV33Tests()
        //   v1.27 後半: 曖昧な列名の拒否 / 組み込み関数の引数個数 / 16進リテラル /
        //   ADD CHECK の 3 値論理 / EXPLAIN の行数見積りと段の追加
        ...getV33Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v34.js の getV34Tests()
        //   大型クエリの網羅検証。5000 行の fact 表・1000 行の mid 表・81 列の
        //   wide 表などを組み立て、多段 JOIN / 大規模集計 / ウィンドウ関数 /
        //   深い CTE と再帰 / 長い集合演算 / 巨大な IN・CASE・列リスト /
        //   大量行の DML / ページング / 表関数・PIVOT・JSON・配列 /
        //   索引の有無による結果の不変性 / 総合シナリオを、JavaScript 側に
        //   同じ規則で組んだ模型の集計値と突き合わせる（差分テスト）
        // ============================================================
        ...getV34Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v35.js の getV35Tests()
        //   v1.28: v34 で見つかった取りこぼしの修正。LAG/LEAD の既定値、
        //   GROUP_CONCAT(x, 'sep') と集計の引数個数、DATE(x) の算術、
        //   別名を付けた列の ORDER BY / OVER(ORDER BY)、式の一部に書いた
        //   ウィンドウ関数と FILTER、CTE 付き CTAS、GROUPING SETS (())、
        //   IS JSON の左辺、APPLY の連続・入れ子・派生表、括弧付き集合演算の派生表
        // ============================================================
        ...getV35Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v36.js 〜 v41.js
        //   大型クエリの総当たり検証（約 10,000 件）。列 x 演算子 x 定数で
        //   機械的に組んだ述語・まとめ方・並び・フレーム・書き方を、
        //   JavaScript 側に同じ規則で組んだ模型の集計値と突き合わせる。
        //     v36: 多段 JOIN / v37: 大規模な集計 / v38: ウィンドウ関数
        //     v39: CTE・サブクエリ・集合演算 / v40: 式・関数・並べ替え・ページング
        //     v41: 大量行の DML・表関数・索引・総合シナリオ
        // ============================================================
        ...getV36Tests(),
        ...getV37Tests(),
        ...getV38Tests(),
        ...getV39Tests(),
        ...getV40Tests(),
        ...getV41Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v42.js の getV42Tests()
        //   v1.29: 総当たりテストで見つかった欠陥の回帰。APPLY 本体の文字列
        //   リテラル消失 / 別名が結合先と同名でも曖昧としない / GROUP BY 結果への
        //   ROWS フレーム / 0 件の派生表・CTE でも列を残す
        // ============================================================
        ...getV42Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v43.js 〜 test-suite-v50.js
        //   v1.30: 実装済みコマンドの全網羅。
        //   v43 数値 53・文字列 60 関数 / v44 日付時刻 61・変換 9・正規表現 5・
        //   ハッシュ 9 / v45 JSON 21・集約 33・ウィンドウ 11・条件 17・メタ 14・
        //   シーケンス 3 / v46 DDL / v47 DML・トランザクション・手続き型・セッション /
        //   v48 SELECT の句と演算子・メタ照会 / v49 v1.30 の修正の回帰と句をまたぐ
        //   組み合わせ / v50 スカラー式の総当たり
        // ============================================================
        ...getV43Tests(),
        ...getV44Tests(),
        ...getV45Tests(),
        ...getV46Tests(),
        ...getV47Tests(),
        ...getV48Tests(),
        ...getV49Tests(),
        ...getV50Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v51.js 〜 test-suite-v55.js
        //   v1.31: 「書き味」の総当たり。実装済みのクエリを、同じ意味のまま
        //   別の書き方へ機械的に変換して結果が変わらないことを確かめる。
        //   共通の道具立ては js/tests/test-helpers.js の makeTestKit にある。
        //     v51 字句とレイアウト（大小文字・空白・改行・コメント・識別子）
        //     v52 同じ意味の別の書き方（述語・論理・結合・集約・副問い合わせ・集合演算）
        //     v53 句の組み合わせと順序（SELECT の各句の有無を総当たり）
        //     v54 関数呼び出しと式の書き味（同義関数・引数の書き方・入れ子）
        //     v55 DML・DDL・トランザクションの書き味
        //     v56 実務の整形スタイル（先頭カンマ・句ごとの改行）と総合シナリオ
        // ============================================================
        ...getV51Tests(),
        ...getV52Tests(),
        ...getV53Tests(),
        ...getV54Tests(),
        ...getV55Tests(),
        ...getV56Tests(),

        // ============================================================
        // 定義は js/tests/test-suite-v57.js 〜 test-suite-v61.js
        //   v1.32: 特殊なクエリ構成の総当たり。普通は書かないが書ける形を
        //   機械的に組み立てて、素直に書いた同じ意味のクエリと突き合わせる。
        //     v57 深さと幅（派生表・CTE・関数・括弧・CASE の段数 / 句の幅）
        //     v58 縮退したデータと境界（0 行・1 行・全 NULL・重複・LIMIT/OFFSET の格子）
        //     v59 句とスコープの相互作用（副問い合わせの置き場所・名前の衝突・句の同時使用）
        //     v60 極端な値と型（桁あふれ・サロゲートペア・遠い日付・型の混在）
        //     v61 実行条件の不変性（索引・行順・トランザクション・ビュー・キャッシュ）
        // ============================================================
        ...getV57Tests(),
        ...getV58Tests(),
        ...getV59Tests(),
        ...getV60Tests(),
        ...getV61Tests(),

        // ============================================================
        // v1.33 で足した命令・関数の総点検
        //   文（CREATE/DROP DATABASE・USE・ALTER VIEW・TEMPORARY VIEW・
        //   EXECUTE IMMEDIATE・DO・RESET・CHECKSUM/REPAIR TABLE・
        //   ORDER BY ... USING・EXPLAIN VERBOSE・PRAGMA foreign_keys など）と、
        //   集計（EVERY / PRODUCT / APPROX_COUNT_DISTINCT）、
        //   スカラー関数（BTRIM / ENCODE / ORD / UNISTR / CONTAINS / TIMEDIFF /
        //   YEARWEEK / PERIOD_ADD / PERIOD_DIFF / JULIAN_DAY / CONVERT_TZ /
        //   JSON_SEARCH / JSON_MERGE_PRESERVE / ARRAY_* / LOCALTIME(STAMP)）を
        //   値・NULL・書き味・拒否されるべき綴りの 4 面から確かめる
        // ============================================================
        ...getV62Tests(),

        // ============================================================
        // v1.34: データ画面（保存 / 読み込み / 入出力）の再編。
        //   サイドバーの 6 ボタンをモーダルのタブへ移し、1 件ずつ説明を付けた。
        //   入口・置き場所・説明の有無・配線・保存状態の表示を見る（DOM 依存）
        // ============================================================
        ...getV63Tests(),

        // ============================================================
        // v1.35: 画面表示の日本語 / 英語切り替え（既定は日本語）。
        //   既定・切り替え・訳し漏れの有無・原文への往復・訳さない領域を見る（DOM 依存）
        // ============================================================
        ...getV64Tests(),
        ...getV65Tests(),
        ...getV66Tests(),

        // Cleanup (New Features)
        { name: "Drop View Stats", sql: "DROP VIEW v_stats", check: r => true },
        { name: "Drop View Seniors", sql: "DROP VIEW v_seniors", check: r => true },
        { name: "Drop Proc Cnt", sql: "DROP PROCEDURE proc_cnt", check: r => true },
        { name: "Drop Table UQ", sql: "DROP TABLE test_uq", check: r => true },
        { name: "Drop Table PK", sql: "DROP TABLE test_pk", check: r => true },
        { name: "Drop Table PK2", sql: "DROP TABLE test_pk2", check: r => true },
        { name: "Drop Table Proc", sql: "DROP TABLE test_proc", check: r => true },

        // Cleanup
        { name: "Drop Table A", sql: "DROP TABLE test_a", check: r => true },
        { name: "Drop Table B", sql: "DROP TABLE test_b", check: r => true },
        { name: "Drop Table C", sql: "DROP TABLE test_c", check: r => true },
        { name: "Drop Table Empty", sql: "DROP TABLE test_empty", check: r => true },
        { name: "Drop Table Trunc", sql: "DROP TABLE test_trunc", check: r => true },
        { name: "Drop Table Types", sql: "DROP TABLE test_types", check: r => true },
        { name: "Drop Table Core Pack", sql: "DROP TABLE core_pack", check: r => true },
        { name: "Drop Table FK Child", sql: "DROP TABLE fk_child", check: r => true },
        { name: "Drop Table FK Parent", sql: "DROP TABLE fk_parent", check: r => true }
      ];

      let results = [];
      let passed = 0;

      for (const t of tests) {
        let status = "FAIL";
        let errMsg = "";
        let time = 0;
        try {
          const start = performance.now();
          if (t.sql !== undefined && t.sql !== null) {
            // 空クエリは意図的なエラーテストであるため実行を許可する
            const res = db.executeQuery(t.sql);
            time = performance.now() - start;
            if (res.error && !t.isErrorExpected) {
               errMsg = res.error;
            } else {
               if (t.check(res)) {
                   status = "PASS";
                   passed++;
               } else {
                   errMsg = res.error || "Assertion failed or incorrect data returned";
               }
            }
          } else if (t.fn) {
            const res = await t.fn();
            time = performance.now() - start;
            if (res === true) {
               status = "PASS"; passed++;
            } else {
               errMsg = "UI or Local Storage Test Failed";
            }
          }
        } catch (e) {
           errMsg = e.message;
        }
        results.push({ TestName: t.name, Status: status, ExecutionTimeMs: time.toFixed(2), Error: errMsg });
      }

      // テスト終了後にユーザーの元のDB状態を完全に復元
      db.importFromIDB(userDbBackup);

      currentResultData = results;

      // テスト中に変更された可能性のあるUI状態を元に戻す
      els.query.value = originalQuery;
      els.dispLimit.value = originalLimit;
      clearTimeout(saveTimeout);
      updateHighlight();
      hideSuggestions();
      isTesting = false;

      renderDisplay(true); // reset display for tests
      renderTree();
      showToast(`Test Suite Finished: ${passed} / ${tests.length} passed.`);
    }
