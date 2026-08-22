    // ============================================================================
    // [Test Suite v4] - v1.3 機能追加・修正の回帰テスト
    //   1. V4Trg: トリガー (BEFORE/AFTER × INSERT/UPDATE/DELETE、OLD./NEW.、
    //             再帰ガード、同一テーブル変更ガード、永続化、ロールバック)
    //   2. V4Var: ユーザー変数 (SET @x / 参照 / SHOW VARIABLES)
    //   3. V4Frm: ウィンドウフレーム (ROWS BETWEEN a AND b / ROWS n PRECEDING)
    //   4. V4Ins: INSERT IGNORE / REPLACE / ODKU と SELECT の併用
    //   5. V4Ddl: CHANGE COLUMN / TABLE 文 / DESCRIBE 複合キー表示
    //   6. V4Fn : CONVERT / CHAR_LENGTH / TIME / UTC_TIMESTAMP / SYSDATE
    //   7. V4Api: LuminaDB.upsert / status / transaction
    //   8. V4Fix: REPLACE バッチ内の複合キー衝突
    //   test-suite.js の tests 配列へ getV4Tests() のスプレッドで合流する
    // ============================================================================
    function getV4Tests() {
      return [
        // ============================================================
        // 1. トリガー (V4Trg)
        // ============================================================
        { name: "V4Trg: Create After Insert Trigger", fn: () => {
            db.executeQuery("CREATE TABLE trg_main (id INTEGER PRIMARY KEY, v TEXT)");
            db.executeQuery("CREATE TABLE trg_log (op TEXT, rid INTEGER, detail TEXT)");
            const r = db.executeQuery("CREATE TRIGGER trg_ai AFTER INSERT ON trg_main FOR EACH ROW INSERT INTO trg_log (op, rid, detail) VALUES ('INS', NEW.id, NEW.v)");
            return !r.error && r.data[0].Message.includes('created');
        }},
        { name: "V4Trg: After Insert Fires Per Row", fn: () => {
            db.executeQuery("INSERT INTO trg_main (id, v) VALUES (1, 'a'), (2, 'b')");
            const r = db.executeQuery("SELECT rid, detail FROM trg_log WHERE op = 'INS' ORDER BY rid");
            return r.data.length === 2 && r.data[0].rid === 1 && r.data[0].detail === 'a' && r.data[1].rid === 2 && r.data[1].detail === 'b';
        }},
        { name: "V4Trg: Quoted Value Substitution", fn: () => {
            db.executeQuery("INSERT INTO trg_main (id, v) VALUES (7, 'O''Brien')");
            const r = db.executeQuery("SELECT detail FROM trg_log WHERE rid = 7");
            return r.data.length === 1 && r.data[0].detail === "O'Brien";
        }},
        { name: "V4Trg: After Update Old And New", fn: () => {
            db.executeQuery("CREATE TRIGGER trg_au AFTER UPDATE ON trg_main FOR EACH ROW INSERT INTO trg_log (op, rid, detail) VALUES ('UPD', NEW.id, CONCAT(OLD.v, '->', NEW.v))");
            db.executeQuery("UPDATE trg_main SET v = 'a2' WHERE id = 1");
            const r = db.executeQuery("SELECT detail FROM trg_log WHERE op = 'UPD'");
            return r.data.length === 1 && r.data[0].detail === 'a->a2';
        }},
        { name: "V4Trg: After Delete Old Values", fn: () => {
            db.executeQuery("CREATE TRIGGER trg_ad AFTER DELETE ON trg_main FOR EACH ROW INSERT INTO trg_log (op, rid, detail) VALUES ('DEL', OLD.id, OLD.v)");
            db.executeQuery("DELETE FROM trg_main WHERE id = 2");
            const r = db.executeQuery("SELECT rid, detail FROM trg_log WHERE op = 'DEL'");
            return r.data.length === 1 && r.data[0].rid === 2 && r.data[1] === undefined && r.data[0].detail === 'b';
        }},
        { name: "V4Trg: Persists Through IDB Roundtrip", fn: () => {
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(db.exportForIDB());
            eng2.executeQuery("INSERT INTO trg_main (id, v) VALUES (50, 'z')");
            const r = eng2.executeQuery("SELECT COUNT(*) AS c FROM trg_log WHERE rid = 50");
            return r.data[0].c === 1;
        }},
        { name: "V4Trg: Transaction Rolls Back Trigger Writes", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("INSERT INTO trg_main (id, v) VALUES (60, 'tx')");
            const during = db.executeQuery("SELECT COUNT(*) AS c FROM trg_log WHERE rid = 60").data[0].c === 1;
            db.executeQuery("ROLLBACK");
            const after = db.executeQuery("SELECT COUNT(*) AS c FROM trg_log WHERE rid = 60").data[0].c === 0;
            const mainGone = db.executeQuery("SELECT COUNT(*) AS c FROM trg_main WHERE id = 60").data[0].c === 0;
            return during && after && mainGone;
        }},
        { name: "V4Trg: Create Trigger Rollback", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE TRIGGER trg_tmp AFTER INSERT ON trg_main FOR EACH ROW INSERT INTO trg_log (op) VALUES ('X')");
            const during = !!db.triggers['trg_tmp'];
            db.executeQuery("ROLLBACK");
            return during && !db.triggers['trg_tmp'];
        }},
        { name: "V4Trg: Show / Duplicate / Replace / Drop", fn: () => {
            const show = db.executeQuery("SHOW TRIGGERS");
            const hasAi = show.data.some(d => d.Trigger === 'trg_ai' && d.Event === 'INSERT' && d.Table === 'trg_main');
            const dup = db.executeQuery("CREATE TRIGGER trg_ai AFTER INSERT ON trg_main FOR EACH ROW SELECT 1");
            const rep = db.executeQuery("CREATE OR REPLACE TRIGGER trg_ai AFTER INSERT ON trg_main FOR EACH ROW INSERT INTO trg_log (op, rid, detail) VALUES ('INS', NEW.id, NEW.v)");
            const dropMissing = db.executeQuery("DROP TRIGGER no_such_trg");
            const dropIf = db.executeQuery("DROP TRIGGER IF EXISTS no_such_trg");
            return hasAi && dup.error !== undefined && !rep.error && dropMissing.error !== undefined && !dropIf.error;
        }},
        { name: "V4Trg: API Insert Fires Trigger", fn: () => {
            const r = LuminaDB.insert('trg_main', { id: 70, v: 'api' });
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM trg_log WHERE rid = 70");
            return !r.error && c.data[0].c === 1;
        }},
        { name: "V4Trg: Audit Cleanup", fn: () => {
            ['trg_ai', 'trg_au', 'trg_ad'].forEach(t => db.executeQuery(`DROP TRIGGER ${t}`));
            db.executeQuery("DROP TABLE trg_main, trg_log");
            return !db.triggers['trg_ai'] && !db.tables['trg_main'];
        }},
        { name: "V4Trg: Before Insert Error Aborts", fn: () => {
            db.executeQuery("CREATE TABLE trg_b (id INTEGER)");
            db.executeQuery("CREATE TRIGGER trg_bi BEFORE INSERT ON trg_b FOR EACH ROW INSERT INTO no_such_table_x (id) VALUES (NEW.id)");
            const r = db.executeQuery("INSERT INTO trg_b (id) VALUES (1)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM trg_b");
            db.executeQuery("DROP TRIGGER trg_bi");
            db.executeQuery("DROP TABLE trg_b");
            return r.error !== undefined && r.error.includes("Trigger 'trg_bi'") && c.data[0].c === 0;
        }},
        { name: "V4Trg: Multi Statement Body", fn: () => {
            db.executeQuery("CREATE TABLE trg_m (id INTEGER)");
            db.executeQuery("CREATE TABLE trg_m_log (a INTEGER, b TEXT)");
            db.executeQuery("CREATE TRIGGER trg_mm AFTER INSERT ON trg_m FOR EACH ROW BEGIN INSERT INTO trg_m_log (a, b) VALUES (NEW.id, 'one'); INSERT INTO trg_m_log (a, b) VALUES (NEW.id * 10, 'two') END");
            db.executeQuery("INSERT INTO trg_m (id) VALUES (3)");
            const r = db.executeQuery("SELECT a FROM trg_m_log ORDER BY a");
            db.executeQuery("DROP TRIGGER trg_mm");
            db.executeQuery("DROP TABLE trg_m, trg_m_log");
            return r.data.length === 2 && r.data[0].a === 3 && r.data[1].a === 30;
        }},
        { name: "V4Trg: Recursion Depth Capped", fn: () => {
            db.executeQuery("CREATE TABLE trg_rec (id INTEGER)");
            db.executeQuery("CREATE TRIGGER trg_rr AFTER INSERT ON trg_rec FOR EACH ROW INSERT INTO trg_rec (id) VALUES (NEW.id + 1)");
            const r = db.executeQuery("INSERT INTO trg_rec (id) VALUES (1)");
            db.executeQuery("DROP TRIGGER trg_rr");
            db.executeQuery("DROP TABLE trg_rec");
            return r.error !== undefined && r.error.includes('depth limit');
        }},
        { name: "V4Trg: Delete Trigger Same Table Guarded", fn: () => {
            db.executeQuery("CREATE TABLE trg_g (id INTEGER)");
            db.executeQuery("INSERT INTO trg_g (id) VALUES (1), (2), (3)");
            db.executeQuery("CREATE TRIGGER trg_gg BEFORE DELETE ON trg_g FOR EACH ROW INSERT INTO trg_g (id) VALUES (99)");
            const r = db.executeQuery("DELETE FROM trg_g WHERE id = 1");
            db.executeQuery("DROP TRIGGER trg_gg");
            db.executeQuery("DROP TABLE trg_g");
            return r.error !== undefined && r.error.includes('not supported');
        }},
        { name: "V4Trg: NEW In String Literal Untouched", fn: () => {
            db.executeQuery("CREATE TABLE trg_s (id INTEGER)");
            db.executeQuery("CREATE TABLE trg_s_log (msg TEXT)");
            db.executeQuery("CREATE TRIGGER trg_ss AFTER INSERT ON trg_s FOR EACH ROW INSERT INTO trg_s_log (msg) VALUES ('literal NEW.id here')");
            db.executeQuery("INSERT INTO trg_s (id) VALUES (1)");
            const r = db.executeQuery("SELECT msg FROM trg_s_log");
            db.executeQuery("DROP TRIGGER trg_ss");
            db.executeQuery("DROP TABLE trg_s, trg_s_log");
            return r.data.length === 1 && r.data[0].msg === 'literal NEW.id here';
        }},
        { name: "V4Trg: Unknown NEW Column Rejected", fn: () => {
            db.executeQuery("CREATE TABLE trg_u (id INTEGER)");
            db.executeQuery("CREATE TABLE trg_u_log (v INTEGER)");
            db.executeQuery("CREATE TRIGGER trg_uu AFTER INSERT ON trg_u FOR EACH ROW INSERT INTO trg_u_log (v) VALUES (NEW.nope)");
            const r = db.executeQuery("INSERT INTO trg_u (id) VALUES (1)");
            db.executeQuery("DROP TRIGGER trg_uu");
            db.executeQuery("DROP TABLE trg_u, trg_u_log");
            return r.error !== undefined && r.error.includes('Unknown column');
        }},

        // ============================================================
        // 2. ユーザー変数 (V4Var)
        // ============================================================
        { name: "V4Var: Set And Use", fn: () => {
            const s = db.executeQuery("SET @a = 5");
            const r = db.executeQuery("SELECT @a + 1 AS v");
            return !s.error && r.data[0].v === 6;
        }},
        { name: "V4Var: Undefined Is Null", sql: "SELECT @never_set_var IS NULL AS n", check: r => r.data[0].n === true },
        { name: "V4Var: String With Quote", fn: () => {
            db.executeQuery("SET @s = 'O''Reilly'");
            const r = db.executeQuery("SELECT @s AS v");
            return r.data[0].v === "O'Reilly";
        }},
        { name: "V4Var: Var From Var", fn: () => {
            db.executeQuery("SET @base = 10");
            db.executeQuery("SET @dbl = @base * 2");
            return db.executeQuery("SELECT @dbl AS v").data[0].v === 20;
        }},
        { name: "V4Var: Multiple Assign", fn: () => {
            db.executeQuery("SET @x = 1, @y = 'two'");
            const r = db.executeQuery("SELECT @x AS x, @y AS y");
            return r.data[0].x === 1 && r.data[0].y === 'two';
        }},
        { name: "V4Var: Colon Equals Syntax", fn: () => {
            db.executeQuery("SET @ce := 9");
            return db.executeQuery("SELECT @ce AS v").data[0].v === 9;
        }},
        { name: "V4Var: In Where Clause", fn: () => {
            db.executeQuery("SET @minage = 30");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE age >= @minage");
            return r.data[0].c === 4;
        }},
        { name: "V4Var: In Insert Values", fn: () => {
            db.executeQuery("CREATE TABLE v4var (v INTEGER)");
            db.executeQuery("SET @seed = 42");
            db.executeQuery("INSERT INTO v4var (v) VALUES (@seed)");
            const r = db.executeQuery("SELECT v FROM v4var");
            db.executeQuery("DROP TABLE v4var");
            return r.data[0].v === 42;
        }},
        { name: "V4Var: Set From Subquery", fn: () => {
            db.executeQuery("SET @maxid = (SELECT MAX(id) FROM users)");
            return db.executeQuery("SELECT @maxid AS v").data[0].v === 10;
        }},
        { name: "V4Var: Show Variables", fn: () => {
            db.executeQuery("SET @shown = 7");
            const r = db.executeQuery("SHOW VARIABLES");
            return !r.error && r.data.some(d => d.Variable === '@shown' && d.Value === 7);
        }},
        errCase("V4Var: Set Without At Rejected", "SET NAMES utf8"),

        // ============================================================
        // 3. ウィンドウフレーム (V4Frm)
        // ============================================================
        { name: "V4Frm: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v4frm (id INTEGER, g TEXT, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v4frm (id, g, v) VALUES (1, 'a', 10), (2, 'a', 20), (3, 'a', 30), (4, 'a', 40), (5, 'a', 50)");
            return !r.error;
        }},
        { name: "V4Frm: Moving Sum 1 Preceding", sql: "SELECT id, SUM(v) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM v4frm ORDER BY id", check: r => r.data.map(d => d.s).join(',') === '10,30,50,70,90' },
        { name: "V4Frm: Centered Avg", sql: "SELECT id, AVG(v) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS a FROM v4frm ORDER BY id", check: r => r.data.map(d => d.a).join(',') === '15,20,30,40,45' },
        { name: "V4Frm: Last Value To Partition End", sql: "SELECT id, LAST_VALUE(v) OVER(ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS l FROM v4frm ORDER BY id", check: r => r.data.every(d => d.l === 50) },
        { name: "V4Frm: First Value In Frame", sql: "SELECT id, FIRST_VALUE(v) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS f FROM v4frm ORDER BY id", check: r => r.data.map(d => d.f).join(',') === '10,10,20,30,40' },
        { name: "V4Frm: Rows N Preceding Shorthand", sql: "SELECT id, SUM(v) OVER(ORDER BY id ROWS 2 PRECEDING) AS s FROM v4frm ORDER BY id", check: r => r.data.map(d => d.s).join(',') === '10,30,60,90,120' },
        { name: "V4Frm: Count Star Frame Edges", sql: "SELECT id, COUNT(*) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS c FROM v4frm ORDER BY id", check: r => r.data.map(d => d.c).join(',') === '2,3,3,3,2' },
        { name: "V4Frm: Empty And Ahead Frames", sql: "SELECT id, SUM(v) OVER(ORDER BY id ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING) AS s FROM v4frm ORDER BY id", check: r =>
            r.data[0].s === 70 && r.data[1].s === 90 && r.data[2].s === 50 && r.data[3].s === null && r.data[4].s === null },
        { name: "V4Frm: Partition With Frame", fn: () => {
            db.executeQuery("INSERT INTO v4frm (id, g, v) VALUES (6, 'b', 100), (7, 'b', 200)");
            const r = db.executeQuery("SELECT id, SUM(v) OVER(PARTITION BY g ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM v4frm WHERE g = 'b' ORDER BY id");
            return r.data[0].s === 100 && r.data[1].s === 300;
        }},
        { name: "V4Frm: Running Sum Without Frame Unchanged", sql: "SELECT id, SUM(v) OVER(ORDER BY id) AS s FROM v4frm WHERE g = 'a' ORDER BY id", check: r => r.data.map(d => d.s).join(',') === '10,30,60,100,150' },
        errCase("V4Frm: Invalid Bound Rejected", "SELECT SUM(v) OVER(ORDER BY id ROWS BETWEEN FOO AND CURRENT ROW) AS s FROM v4frm", 'frame bound'),
        { name: "V4Frm: Cleanup", sql: "DROP TABLE v4frm", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 4. INSERT IGNORE / REPLACE / ODKU + SELECT (V4Ins)
        // ============================================================
        { name: "V4Ins: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v4src (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO v4src (id, v) VALUES (1, 'one'), (2, 'two'), (3, 'three')");
            db.executeQuery("CREATE TABLE v4dst (id INTEGER PRIMARY KEY, v TEXT)");
            db.executeQuery("INSERT INTO v4dst (id, v) VALUES (1, 'orig')");
            return true;
        }},
        { name: "V4Ins: Insert Ignore Select", sql: "INSERT IGNORE INTO v4dst (id, v) SELECT id, v FROM v4src", check: r => r.data[0].Message.includes('2 rows inserted') && r.data[0].Message.includes('1 ignored') },
        { name: "V4Ins: Ignore Kept Original", sql: "SELECT v FROM v4dst WHERE id = 1", check: r => r.data[0].v === 'orig' },
        { name: "V4Ins: Replace Select", sql: "REPLACE INTO v4dst (id, v) SELECT id, v FROM v4src WHERE id = 1", check: r => r.data[0].Message.includes('replaced') },
        { name: "V4Ins: Replace Applied", sql: "SELECT v FROM v4dst WHERE id = 1", check: r => r.data[0].v === 'one' },
        { name: "V4Ins: Select With ODKU", fn: () => {
            const r = db.executeQuery("INSERT INTO v4dst (id, v) SELECT id, v FROM v4src WHERE id = 2 ON DUPLICATE KEY UPDATE v = 'dup-upd'");
            const q = db.executeQuery("SELECT v FROM v4dst WHERE id = 2");
            return !r.error && q.data[0].v === 'dup-upd';
        }},
        { name: "V4Ins: Cleanup", sql: "DROP TABLE v4src, v4dst", check: r => r.data[0].Message.includes('dropped') },

        // ============================================================
        // 5. DDL 拡張 (V4Ddl)
        // ============================================================
        { name: "V4Ddl: Change Column Rename And Type", fn: () => {
            db.executeQuery("CREATE TABLE v4chg (a TEXT)");
            db.executeQuery("INSERT INTO v4chg (a) VALUES ('123'), ('456')");
            const r = db.executeQuery("ALTER TABLE v4chg CHANGE COLUMN a b INTEGER");
            const q = db.executeQuery("SELECT b FROM v4chg ORDER BY b");
            const meta = db.tables['v4chg'].colTypes['b'] === 'INTEGER' && !db.tables['v4chg'].cols['a'];
            db.executeQuery("DROP TABLE v4chg");
            return !r.error && q.data[0].b === 123 && q.data[1].b === 456 && meta;
        }},
        { name: "V4Ddl: Change Column Bad Cast Fails Atomically", fn: () => {
            db.executeQuery("CREATE TABLE v4chg2 (a TEXT)");
            db.executeQuery("INSERT INTO v4chg2 (a) VALUES ('abc')");
            const r = db.executeQuery("ALTER TABLE v4chg2 CHANGE a b INTEGER");
            const intact = !!db.tables['v4chg2'].cols['a'] && db.tables['v4chg2'].colTypes['a'] === 'TEXT';
            db.executeQuery("DROP TABLE v4chg2");
            return r.error !== undefined && intact;
        }},
        { name: "V4Ddl: TABLE Statement", sql: "TABLE users", check: r => r.data.length === 10 && r.data[0].name === 'Alice' },
        { name: "V4Ddl: TABLE Statement On View", fn: () => {
            db.executeQuery("CREATE VIEW v4view AS SELECT id FROM users WHERE id <= 3");
            const r = db.executeQuery("TABLE v4view");
            db.executeQuery("DROP VIEW v4view");
            return !r.error && r.data.length === 3;
        }},
        errCase("V4Ddl: TABLE Missing Rejected", "TABLE no_such_tbl", 'not found'),
        { name: "V4Ddl: Describe Composite Marker", fn: () => {
            db.executeQuery("CREATE TABLE v4dsc (a INTEGER, b INTEGER, c INTEGER, PRIMARY KEY (a, b))");
            const r = db.executeQuery("DESCRIBE v4dsc");
            db.executeQuery("DROP TABLE v4dsc");
            return r.data[0].Key === 'PRIMARY (composite)' && r.data[1].Key === 'PRIMARY (composite)' && r.data[2].Key === '';
        }},

        // ============================================================
        // 6. 追加関数 (V4Fn)
        // ============================================================
        { name: "V4Fn: CONVERT", sql: "SELECT CONVERT('42', INTEGER) AS i, CONVERT(7, TEXT) AS t", check: r => r.data[0].i === 42 && r.data[0].t === '7' },
        { name: "V4Fn: CONVERT Nested", sql: "SELECT CONVERT(CONVERT(5, TEXT), INTEGER) AS v", check: r => r.data[0].v === 5 },
        { name: "V4Fn: CHAR_LENGTH Aliases", sql: "SELECT CHAR_LENGTH('hello') AS a, CHARACTER_LENGTH('xy') AS b", check: r => r.data[0].a === 5 && r.data[0].b === 2 },
        { name: "V4Fn: TIME Extract", sql: "SELECT TIME('2026-07-16 09:05:03') AS t, TIME('2026-07-16') AS z", check: r => r.data[0].t === '09:05:03' && r.data[0].z === '00:00:00' },
        { name: "V4Fn: UTC_TIMESTAMP And SYSDATE", sql: "SELECT UTC_TIMESTAMP() AS u, SYSDATE() AS s", check: r =>
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.data[0].u) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.data[0].s) },

        // ============================================================
        // 7. API 拡張 (V4Api)
        // ============================================================
        { name: "V4Api: Upsert Inserts Then Replaces", fn: () => {
            db.executeQuery("CREATE TABLE v4api (id INTEGER PRIMARY KEY, v TEXT)");
            const r1 = LuminaDB.upsert('v4api', { id: 1, v: 'first' });
            const r2 = LuminaDB.upsert('v4api', { id: 1, v: 'second' });
            const q = db.executeQuery("SELECT v FROM v4api WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v4api");
            return !r1.error && !r2.error && q.data[0].v === 'second' && c.data[0].c === 1;
        }},
        { name: "V4Api: Status Object", fn: () => {
            const r = LuminaDB.status();
            return !r.error && typeof r.status === 'object' && String(r.status.version).startsWith('LuminaDB') && r.status.tables >= 3;
        }},
        { name: "V4Api: Transaction Commits", fn: () => {
            const r = LuminaDB.transaction(api => {
                api.insert('v4api', { id: 2, v: 'tx' });
                api.update('v4api', { v: 'tx2' }, { id: 2 });
                return 'done';
            });
            const q = db.executeQuery("SELECT v FROM v4api WHERE id = 2");
            return !r.error && r.value === 'done' && q.data[0].v === 'tx2' && !db.inTransaction;
        }},
        { name: "V4Api: Transaction Rolls Back On Throw", fn: () => {
            const r = LuminaDB.transaction(api => {
                api.insert('v4api', { id: 3, v: 'boom' });
                throw new Error('abort!');
            });
            const q = db.executeQuery("SELECT COUNT(*) AS c FROM v4api WHERE id = 3");
            return r.error !== undefined && r.error.includes('abort!') && q.data[0].c === 0 && !db.inTransaction;
        }},
        { name: "V4Api: Write Inside Own Transaction Allowed", fn: () => {
            const r = LuminaDB.transaction(api => {
                const w = api.query("INSERT INTO v4api (id, v) VALUES (4, 'w')");
                if (w.error) throw new Error(w.error);
            });
            const q = db.executeQuery("SELECT COUNT(*) AS c FROM v4api WHERE id = 4");
            db.executeQuery("DROP TABLE v4api");
            return !r.error && q.data[0].c === 1;
        }},

        // ============================================================
        // 8. 修正 (V4Fix)
        // ============================================================
        { name: "V4Fix: REPLACE Batch Composite In-Batch", fn: () => {
            db.executeQuery("CREATE TABLE v4cmp (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (a, b))");
            const r = db.executeQuery("REPLACE INTO v4cmp (a, b, v) VALUES (1, 1, 'first'), (1, 1, 'second')");
            const q = db.executeQuery("SELECT v FROM v4cmp");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v4cmp");
            db.executeQuery("DROP TABLE v4cmp");
            return !r.error && c.data[0].c === 1 && q.data[0].v === 'second';
        }}
      ];
    }
