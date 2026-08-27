    // ============================================================================
    // [Test Suite Fixes] - バグ修正・機能追加の回帰テスト
    //   1. XIdx : インデックススキャンをリテラル右辺に限定（式/列/真偽値の誤 0 件を修正）
    //   2. XCmj : FROM 句カンマ結合（暗黙の直積。従来は 2 つ目以降が無視されていた）
    //   3. XHav : HAVING の直接集計 / 非集計クエリでの HAVING フィルタ
    //   4. XOrd : ORDER BY の式・集計・未選択列対応
    //   5. XLim : UPDATE / DELETE ... LIMIT n
    //   6. XDefV: INSERT INTO t DEFAULT VALUES
    //   7. XAdd : ALTER TABLE ADD COLUMN の DEFAULT / NOT NULL
    //   8. XTx2 : 構造 ALTER / INDEX / VIEW / PROCEDURE のロールバック
    //   9. XDat : 制約検証の数値文字列正規化 / 削除領域の残留データ復活防止 / LIKE '*'
    //   test-suite.js の tests 配列へ getFixTests() のスプレッドで合流する
    // ============================================================================
    function getFixTests() {
      return [
        // ============================================================
        // 1. インデックススキャンのリテラル限定 (XIdx)
        // ============================================================
        { name: "XIdx: Setup", fn: () => {
            db.executeQuery("CREATE TABLE fxi (id INTEGER, flag BOOLEAN, pair INTEGER)");
            db.executeQuery("INSERT INTO fxi (id, flag, pair) VALUES (1, true, 1), (2, false, 99), (3, true, 3)");
            db.executeQuery("CREATE INDEX ix_fxi_id ON fxi (id)");
            db.executeQuery("CREATE INDEX ix_fxi_flag ON fxi (flag)");
            return true;
        }},
        { name: "XIdx: Literal Still Uses Index Scan", sql: "EXPLAIN SELECT * FROM fxi WHERE id = 1", check: r => r.data[0].Operation === 'INDEX SCAN' },
        { name: "XIdx: Literal Result Correct", sql: "SELECT * FROM fxi WHERE id = 1", check: r => r.data.length === 1 && r.data[0].pair === 1 },
        { name: "XIdx: Boolean TRUE On Indexed Col", sql: "SELECT COUNT(*) AS c FROM fxi WHERE flag = TRUE", check: r => r.data[0].c === 2 },
        { name: "XIdx: Boolean FALSE On Indexed Col", sql: "SELECT COUNT(*) AS c FROM fxi WHERE flag = FALSE", check: r => r.data[0].c === 1 },
        { name: "XIdx: Expression RHS Evaluated", sql: "SELECT COUNT(*) AS c FROM fxi WHERE id = 1 + 1", check: r => r.data[0].c === 1 },
        { name: "XIdx: Expression RHS Uses Table Scan", sql: "EXPLAIN SELECT * FROM fxi WHERE id = 1 + 1", check: r => r.data[0].Operation === 'TABLE SCAN' },
        { name: "XIdx: Column RHS Compared Per Row", sql: "SELECT COUNT(*) AS c FROM fxi WHERE id = pair", check: r => r.data[0].c === 2 },
        { name: "XIdx: Cleanup", sql: "DROP TABLE fxi", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 2. カンマ結合 (XCmj)
        // ============================================================
        { name: "XCmj: Comma Join Equals Explicit Join", fn: () => {
            const a = db.executeQuery("SELECT COUNT(*) AS c FROM users u, orders o WHERE u.id = o.user_id").data[0].c;
            const b = db.executeQuery("SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id").data[0].c;
            return a === b && a > 0;
        }},
        { name: "XCmj: Comma Join Cartesian Count", fn: () => {
            const u = db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c;
            const p = db.executeQuery("SELECT COUNT(*) AS c FROM products").data[0].c;
            const x = db.executeQuery("SELECT COUNT(*) AS c FROM users, products").data[0].c;
            return x === u * p && x > 0;
        }},
        { name: "XCmj: Three Tables With Where", fn: () => {
            const a = db.executeQuery("SELECT COUNT(*) AS c FROM users u, orders o, products p WHERE u.id = o.user_id AND o.product_id = p.id").data[0].c;
            const b = db.executeQuery("SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id").data[0].c;
            return a === b && a > 0;
        }},
        { name: "XCmj: Comma Then Explicit Join Mix", fn: () => {
            const a = db.executeQuery("SELECT COUNT(*) AS c FROM users u, orders o JOIN products p ON o.product_id = p.id WHERE u.id = o.user_id").data[0].c;
            const b = db.executeQuery("SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id").data[0].c;
            return a === b;
        }},
        { name: "XCmj: Column Values Joined Correctly", sql: "SELECT u.name, o.amount FROM users u, orders o WHERE u.id = o.user_id ORDER BY o.order_id LIMIT 1", check: r => r.data.length === 1 && r.data[0].name === 'Alice' && r.data[0].amount === 1 },
        errCase("XCmj: FROM Clause Garbage Errors", "SELECT * FROM users !!bad!!"),

        // ============================================================
        // 3. HAVING の直接集計 / 非集計 HAVING (XHav)
        // ============================================================
        { name: "XHav: Direct COUNT(*) In Having", sql: "SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1", check: r => r.data.length === 1 && r.data[0].user_id === 1 },
        { name: "XHav: Direct SUM In Having", sql: "SELECT user_id FROM orders GROUP BY user_id HAVING SUM(amount) >= 2 ORDER BY user_id", check: r => r.data.length === 3 && r.data[0].user_id === 1 && r.data[2].user_id === 3 },
        { name: "XHav: COUNT DISTINCT In Having", sql: "SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(DISTINCT product_id) = 2", check: r => r.data.length === 1 && r.data[0].user_id === 1 },
        { name: "XHav: Mixed Alias And Aggregate", sql: "SELECT user_id, COUNT(*) AS c FROM orders GROUP BY user_id HAVING c = 1 AND SUM(amount) > 1 ORDER BY user_id", check: r => r.data.length === 2 && r.data[0].user_id === 2 && r.data[1].user_id === 3 },
        { name: "XHav: Hidden Agg Cols Not Leaked", fn: () => {
            const r = db.executeQuery("SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 1");
            return r.data.length === 1 && Object.keys(r.data[0]).length === 1 && Object.keys(r.data[0])[0] === 'user_id';
        }},
        { name: "XHav: Non-Grouped Having Filters Rows", sql: "SELECT id, age FROM users HAVING age > 30 ORDER BY id", check: r => r.data.length === 3 && r.data[0].id === 4 },
        { name: "XHav: Non-Grouped Having On Alias", sql: "SELECT id, age * 2 AS dbl FROM users HAVING dbl >= 70 ORDER BY id", check: r => r.data.length === 2 && r.data[0].id === 4 && r.data[1].id === 6 },
        { name: "XHav: Implicit Single Group Via Agg", sql: "SELECT COUNT(*) AS c FROM users HAVING COUNT(*) > 5", check: r => r.data.length === 1 && r.data[0].c === 10 },
        { name: "XHav: Implicit Group Filtered Out", sql: "SELECT COUNT(*) AS c FROM users HAVING COUNT(*) > 100", check: r => r.data.length === 0 },
        errCase("XHav: Unknown Column Still Errors", "SELECT age, COUNT(*) AS c FROM users GROUP BY age HAVING zz_ghost > 1"),

        // ============================================================
        // 4. ORDER BY 式・集計・未選択列 (XOrd)
        // ============================================================
        { name: "XOrd: Order By COUNT(*) Desc", sql: "SELECT user_id FROM orders GROUP BY user_id ORDER BY COUNT(*) DESC, user_id ASC", check: r => r.data[0].user_id === 1 && Object.keys(r.data[0]).length === 1 },
        { name: "XOrd: Order By SUM Desc Limit", sql: "SELECT user_id FROM orders GROUP BY user_id ORDER BY SUM(amount) DESC, user_id ASC LIMIT 2", check: r => r.data.length === 2 && r.data[0].user_id === 3 && r.data[1].user_id === 1 },
        { name: "XOrd: Order By Arithmetic Expression", sql: "SELECT id, name FROM products ORDER BY price * stock DESC LIMIT 2", check: r => r.data[0].id === 101 && r.data[1].id === 104 },
        { name: "XOrd: Order By Non-Selected Column", fn: () => {
            const r = db.executeQuery("SELECT name FROM products ORDER BY price ASC LIMIT 2");
            return r.data[0].name === 'Mouse' && r.data[1].name === 'Keyboard' && Object.keys(r.data[0]).length === 1;
        }},
        { name: "XOrd: Order By Function Of Column", sql: "SELECT name FROM users ORDER BY LENGTH(name) DESC, name ASC LIMIT 1", check: r => r.data[0].name === 'Charlie' },
        { name: "XOrd: Order By Expression Over Alias", sql: "SELECT id, age AS a FROM users ORDER BY a + id DESC LIMIT 1", check: r => r.data[0].id === 6 },
        { name: "XOrd: Order By Function With Comma Args", fn: () => {
            db.executeQuery("CREATE TABLE fxo (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO fxo (id, v) VALUES (1, null), (2, 5), (3, 1)");
            const r = db.executeQuery("SELECT id FROM fxo ORDER BY COALESCE(v, 99) ASC");
            db.executeQuery("DROP TABLE fxo");
            return r.data.length === 3 && r.data[0].id === 3 && r.data[1].id === 2 && r.data[2].id === 1;
        }},
        { name: "XOrd: Distinct Order By Selected Expr", sql: "SELECT DISTINCT name FROM products ORDER BY LENGTH(name) ASC, name ASC LIMIT 1", check: r => r.data[0].name === 'Mouse' },
        errCase("XOrd: Distinct Order By Hidden Col Errors", "SELECT DISTINCT name FROM products ORDER BY price"),
        errCase("XOrd: Missing Column Still Errors", "SELECT id FROM users ORDER BY nope_col"),
        { name: "XOrd: Ordinal Still Works", sql: "SELECT name, age FROM users ORDER BY 2 DESC LIMIT 1", check: r => r.data[0].age === 40 },
        { name: "XOrd: Qualified Non-Selected Column", sql: "SELECT u.name FROM users u ORDER BY u.age DESC LIMIT 1", check: r => r.data[0].name === 'Frank' },
        { name: "XOrd: Window Alias In Order By Intact", sql: "SELECT id, ROW_NUMBER() OVER(ORDER BY age DESC) AS rn FROM users ORDER BY rn ASC LIMIT 1", check: r => r.data[0].id === 6 && r.data[0].rn === 1 },

        // ============================================================
        // 5. UPDATE / DELETE ... LIMIT (XLim)
        // ============================================================
        { name: "XLim: Setup", fn: () => {
            db.executeQuery("CREATE TABLE fxl (id INTEGER, flg INTEGER)");
            db.executeQuery("INSERT INTO fxl (id, flg) VALUES (1, 0), (2, 0), (3, 0), (4, 0)");
            return db.tables['fxl'].rowCount === 4;
        }},
        { name: "XLim: Update With Limit", sql: "UPDATE fxl SET flg = 1 WHERE flg = 0 LIMIT 2", check: r => r.data[0].Message.includes('2 rows') },
        { name: "XLim: Update Limit Affected Only 2", sql: "SELECT COUNT(*) AS c FROM fxl WHERE flg = 1", check: r => r.data[0].c === 2 },
        { name: "XLim: Delete With Limit", sql: "DELETE FROM fxl LIMIT 3", check: r => r.data[0].Message.includes('3 rows') },
        { name: "XLim: Delete Limit Left 1", sql: "SELECT COUNT(*) AS c FROM fxl", check: r => r.data[0].c === 1 },
        { name: "XLim: Cleanup", sql: "DROP TABLE fxl", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 6. INSERT DEFAULT VALUES (XDefV)
        // ============================================================
        { name: "XDefV: Insert Default Values Twice", fn: () => {
            db.executeQuery("CREATE TABLE fxd (id INTEGER PRIMARY KEY AUTO_INCREMENT, status TEXT DEFAULT 'new', note TEXT)");
            const r1 = db.executeQuery("INSERT INTO fxd DEFAULT VALUES");
            const r2 = db.executeQuery("INSERT INTO fxd DEFAULT VALUES");
            const rows = db.executeQuery("SELECT id, status, note FROM fxd ORDER BY id").data;
            db.executeQuery("DROP TABLE fxd");
            return !r1.error && !r2.error && rows.length === 2 && rows[0].id === 1 && rows[1].id === 2
                && rows[0].status === 'new' && rows[0].note === null;
        }},
        { name: "XDefV: Not Null Without Default Fails", fn: () => {
            db.executeQuery("CREATE TABLE fxd2 (id INTEGER NOT NULL)");
            const r = db.executeQuery("INSERT INTO fxd2 DEFAULT VALUES");
            db.executeQuery("DROP TABLE fxd2");
            return r.error !== undefined && r.error.includes('NOT NULL');
        }},

        // ============================================================
        // 7. ADD COLUMN の DEFAULT / NOT NULL (XAdd)
        // ============================================================
        { name: "XAdd: Default Fills Existing Rows", fn: () => {
            db.executeQuery("CREATE TABLE fxa (id INTEGER)");
            db.executeQuery("INSERT INTO fxa (id) VALUES (1), (2)");
            const r = db.executeQuery("ALTER TABLE fxa ADD COLUMN status TEXT DEFAULT 'active' NOT NULL");
            const rows = db.executeQuery("SELECT status FROM fxa").data;
            return !r.error && rows.length === 2 && rows.every(x => x.status === 'active');
        }},
        { name: "XAdd: New Insert Gets Default", fn: () => {
            const ins = db.executeQuery("INSERT INTO fxa (id) VALUES (3)");
            const v = db.executeQuery("SELECT status FROM fxa WHERE id = 3").data[0].status;
            return !ins.error && v === 'active';
        }},
        errCase("XAdd: Not Null Enforced On New Column", "INSERT INTO fxa (id, status) VALUES (4, null)", 'NOT NULL'),
        { name: "XAdd: Describe Shows Default And NotNull", fn: () => {
            const r = db.executeQuery("DESCRIBE fxa");
            const col = r.data.find(c => c.Column === 'status');
            db.executeQuery("DROP TABLE fxa");
            return col && col.NotNull === true && col.Default === 'active';
        }},
        { name: "XAdd: NotNull Without Default On Data Fails", fn: () => {
            db.executeQuery("CREATE TABLE fxa2 (id INTEGER)");
            db.executeQuery("INSERT INTO fxa2 (id) VALUES (1)");
            const r = db.executeQuery("ALTER TABLE fxa2 ADD COLUMN req TEXT NOT NULL");
            const cols = db.tables['fxa2'].getColumnNames();
            db.executeQuery("DROP TABLE fxa2");
            return r.error !== undefined && !cols.includes('req');
        }},
        { name: "XAdd: Plain Add Column Still Works", fn: () => {
            db.executeQuery("CREATE TABLE fxa3 (id INTEGER)");
            const r1 = db.executeQuery("ALTER TABLE fxa3 ADD COLUMN note TEXT");
            const r2 = db.executeQuery("ALTER TABLE fxa3 ADD plain_col");
            const cols = db.tables['fxa3'].getColumnNames();
            db.executeQuery("DROP TABLE fxa3");
            return !r1.error && !r2.error && cols.includes('note') && cols.includes('plain_col');
        }},
        { name: "XAdd: Default Survives SQL Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE fxe (id INTEGER)");
            eng.executeQuery("ALTER TABLE fxe ADD COLUMN st TEXT DEFAULT 'd1'");
            const dump = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng2.tables[t]);
            for (const st of splitSqlStatements(dump)) { if (eng2.executeQuery(st).error) return false; }
            eng2.executeQuery("INSERT INTO fxe (id) VALUES (1)");
            return eng2.executeQuery("SELECT st FROM fxe").data[0].st === 'd1';
        }},

        // ============================================================
        // 8. 構造 ALTER / INDEX / VIEW / PROCEDURE のロールバック (XTx2)
        // ============================================================
        { name: "XTx2: Drop Column Rollback Restores Data", fn: () => {
            db.executeQuery("CREATE TABLE fxt1 (id INTEGER, val TEXT)");
            db.executeQuery("INSERT INTO fxt1 (id, val) VALUES (1, 'keep'), (2, 'safe')");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE fxt1 DROP COLUMN val");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT val FROM fxt1 ORDER BY id");
            db.executeQuery("DROP TABLE fxt1");
            return !r.error && r.data.length === 2 && r.data[0].val === 'keep' && r.data[1].val === 'safe';
        }},
        { name: "XTx2: Rename Column Rollback", fn: () => {
            db.executeQuery("CREATE TABLE fxt2 (id INTEGER, val TEXT)");
            db.executeQuery("INSERT INTO fxt2 (id, val) VALUES (1, 'x')");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE fxt2 RENAME COLUMN val TO renamed");
            db.executeQuery("ROLLBACK");
            const cols = db.tables['fxt2'].getColumnNames();
            const r = db.executeQuery("SELECT val FROM fxt2");
            db.executeQuery("DROP TABLE fxt2");
            return cols.includes('val') && !cols.includes('renamed') && r.data[0].val === 'x';
        }},
        { name: "XTx2: Add Column Rollback Removes It", fn: () => {
            db.executeQuery("CREATE TABLE fxt3 (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE fxt3 ADD COLUMN extra TEXT");
            db.executeQuery("ROLLBACK");
            const cols = db.tables['fxt3'].getColumnNames();
            db.executeQuery("DROP TABLE fxt3");
            return !cols.includes('extra');
        }},
        { name: "XTx2: Modify Type Rollback Preserves Strings", fn: () => {
            db.executeQuery("CREATE TABLE fxt4 (id INTEGER, n TEXT)");
            db.executeQuery("INSERT INTO fxt4 (id, n) VALUES (1, '42'), (2, '7')");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE fxt4 MODIFY COLUMN n INTEGER");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT n FROM fxt4 ORDER BY id");
            const typeOk = db.tables['fxt4'].colTypes['n'] === 'TEXT';
            db.executeQuery("DROP TABLE fxt4");
            return typeOk && r.data[0].n === '42' && r.data[1].n === '7';
        }},
        { name: "XTx2: Create Index Rollback", fn: () => {
            db.executeQuery("CREATE TABLE fxt5 (id INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE INDEX ixt5 ON fxt5 (id)");
            db.executeQuery("ROLLBACK");
            const has = !!db.tables['fxt5'].indices['id'];
            db.executeQuery("DROP TABLE fxt5");
            return !has;
        }},
        { name: "XTx2: Drop Index Rollback Restores", fn: () => {
            db.executeQuery("CREATE TABLE fxt6 (id INTEGER)");
            db.executeQuery("INSERT INTO fxt6 (id) VALUES (1), (2)");
            db.executeQuery("CREATE INDEX ixt6 ON fxt6 (id)");
            db.executeQuery("BEGIN");
            db.executeQuery("DROP INDEX ixt6 ON fxt6 (id)");
            db.executeQuery("ROLLBACK");
            // 索引の鍵は生値ではなく照合候補キー（Table.indexKeysOf）なので、
            // Map を直に引かず「索引が在ること」と「その索引で値が引けること」を見る
            const idx = db.tables['fxt6'].indices['id'];
            const ok = !!idx && db.tables['fxt6'].findValueRows('id', 1).length === 1;
            db.executeQuery("DROP TABLE fxt6");
            return ok;
        }},
        { name: "XTx2: Create View Rollback", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE VIEW fxv1 AS SELECT * FROM users LIMIT 1");
            db.executeQuery("ROLLBACK");
            return db.views['fxv1'] === undefined;
        }},
        { name: "XTx2: Drop View Rollback", fn: () => {
            db.executeQuery("CREATE VIEW fxv2 AS SELECT * FROM users LIMIT 1");
            db.executeQuery("BEGIN");
            db.executeQuery("DROP VIEW fxv2");
            db.executeQuery("ROLLBACK");
            const ok = db.views['fxv2'] !== undefined && !db.executeQuery("SELECT * FROM fxv2").error;
            db.executeQuery("DROP VIEW fxv2");
            return ok;
        }},
        { name: "XTx2: Replace View Rollback Restores Old", fn: () => {
            db.executeQuery("CREATE VIEW fxv3 AS SELECT id FROM users WHERE id = 1");
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE OR REPLACE VIEW fxv3 AS SELECT id FROM users WHERE id = 2");
            db.executeQuery("ROLLBACK");
            const r = db.executeQuery("SELECT * FROM fxv3");
            db.executeQuery("DROP VIEW fxv3");
            return r.data.length === 1 && r.data[0].id === 1;
        }},
        { name: "XTx2: Create Procedure Rollback", fn: () => {
            db.executeQuery("BEGIN");
            db.executeQuery("CREATE PROCEDURE fxp1 AS SELECT 1");
            db.executeQuery("ROLLBACK");
            return db.procedures['fxp1'] === undefined;
        }},
        { name: "XTx2: Drop Procedure Rollback", fn: () => {
            db.executeQuery("CREATE PROCEDURE fxp2 AS SELECT 1");
            db.executeQuery("BEGIN");
            db.executeQuery("DROP PROCEDURE fxp2");
            db.executeQuery("ROLLBACK");
            const ok = db.procedures['fxp2'] !== undefined;
            db.executeQuery("DROP PROCEDURE fxp2");
            return ok;
        }},
        { name: "XTx2: Savepoint + Structural Partial Rollback", fn: () => {
            db.executeQuery("CREATE TABLE fxsp (id INTEGER, val TEXT)");
            db.executeQuery("INSERT INTO fxsp (id, val) VALUES (1, 'a')");
            db.executeQuery("BEGIN");
            db.executeQuery("UPDATE fxsp SET val = 'b' WHERE id = 1");
            db.executeQuery("SAVEPOINT s1");
            db.executeQuery("ALTER TABLE fxsp DROP COLUMN val");
            db.executeQuery("ROLLBACK TO SAVEPOINT s1");
            const afterSp = db.executeQuery("SELECT val FROM fxsp").data[0].val;
            db.executeQuery("ROLLBACK");
            const afterAll = db.executeQuery("SELECT val FROM fxsp").data[0].val;
            db.executeQuery("DROP TABLE fxsp");
            return afterSp === 'b' && afterAll === 'a';
        }},

        // ============================================================
        // 9. データ整合性: 数値文字列 / 残留データ / LIKE / SET NULL×NOT NULL (XDat)
        // ============================================================
        { name: "XDat: Update PK To Numeric String Blocked", fn: () => {
            db.executeQuery("CREATE TABLE fxq (id INTEGER PRIMARY KEY)");
            db.executeQuery("INSERT INTO fxq (id) VALUES (1), (2)");
            const r = db.executeQuery("UPDATE fxq SET id = '2' WHERE id = 1");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM fxq WHERE id = 2").data[0].c;
            db.executeQuery("DROP TABLE fxq");
            return r.error !== undefined && r.error.includes('PRIMARY KEY') && cnt === 1;
        }},
        { name: "XDat: FK Accepts Numeric String", fn: () => {
            db.executeQuery("CREATE TABLE fxfp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fxfc (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES fxfp(id))");
            db.executeQuery("INSERT INTO fxfp (id) VALUES (1)");
            const ins = db.executeQuery("INSERT INTO fxfc (id, p_id) VALUES (10, '1')");
            const upd = db.executeQuery("UPDATE fxfc SET p_id = '1' WHERE id = 10");
            db.executeQuery("DROP TABLE fxfc"); db.executeQuery("DROP TABLE fxfp");
            return !ins.error && !upd.error;
        }},
        { name: "XDat: No Stale Data After Delete", fn: () => {
            db.executeQuery("CREATE TABLE fxs1 (a, b)");
            db.executeQuery("INSERT INTO fxs1 (a, b) VALUES (1, 'ghost')");
            db.executeQuery("DELETE FROM fxs1");
            db.executeQuery("INSERT INTO fxs1 (a) VALUES (9)");
            const r = db.executeQuery("SELECT b FROM fxs1");
            db.executeQuery("DROP TABLE fxs1");
            return r.data.length === 1 && r.data[0].b === null;
        }},
        { name: "XDat: No Stale Data After Truncate", fn: () => {
            db.executeQuery("CREATE TABLE fxs2 (a, b)");
            db.executeQuery("INSERT INTO fxs2 (a, b) VALUES (1, 'ghost')");
            db.executeQuery("TRUNCATE TABLE fxs2");
            db.executeQuery("INSERT INTO fxs2 (b) VALUES ('only-b')");
            const r = db.executeQuery("SELECT a, b FROM fxs2");
            db.executeQuery("DROP TABLE fxs2");
            return r.data.length === 1 && r.data[0].a === null && r.data[0].b === 'only-b';
        }},
        { name: "XDat: LIKE Star Is Literal", fn: () => {
            db.executeQuery("CREATE TABLE fxlk (s TEXT)");
            db.executeQuery("INSERT INTO fxlk (s) VALUES ('*star'), ('star'), ('a*b')");
            const r1 = db.executeQuery("SELECT COUNT(*) AS c FROM fxlk WHERE s LIKE '*%'");
            const r2 = db.executeQuery("SELECT COUNT(*) AS c FROM fxlk WHERE s LIKE '%*%'");
            db.executeQuery("DROP TABLE fxlk");
            return r1.data[0].c === 1 && r2.data[0].c === 2;
        }},
        { name: "XDat: SetNull NotNull Conflict Blocked Atomically", fn: () => {
            db.executeQuery("CREATE TABLE fxsn_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE fxsn_c (id INTEGER, p_id INTEGER NOT NULL, FOREIGN KEY (p_id) REFERENCES fxsn_p(id) ON DELETE SET NULL)");
            db.executeQuery("INSERT INTO fxsn_p (id) VALUES (1)");
            db.executeQuery("INSERT INTO fxsn_c (id, p_id) VALUES (10, 1)");
            const del = db.executeQuery("DELETE FROM fxsn_p WHERE id = 1");
            const intact = db.executeQuery("SELECT COUNT(*) AS c FROM fxsn_p").data[0].c === 1
                && db.executeQuery("SELECT p_id FROM fxsn_c WHERE id = 10").data[0].p_id === 1;
            db.executeQuery("DROP TABLE fxsn_c"); db.executeQuery("DROP TABLE fxsn_p");
            return del.error !== undefined && del.error.includes('SET NULL conflicts') && intact;
        }},

        // ============================================================
        // 後始末: fx 系オブジェクトの残骸が無いことを確認
        // ============================================================
        { name: "XFix: No Leftover Fix Tables", fn: () => {
            const pat = /^fx/;
            Object.keys(db.tables).filter(t => pat.test(t)).forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            Object.keys(db.views).filter(v => pat.test(v)).forEach(v => db.executeQuery(`DROP VIEW ${v}`));
            Object.keys(db.procedures).filter(p => pat.test(p)).forEach(p => db.executeQuery(`DROP PROCEDURE ${p}`));
            return !Object.keys(db.tables).some(t => pat.test(t))
                && !Object.keys(db.views).some(v => pat.test(v))
                && !Object.keys(db.procedures).some(p => pat.test(p));
        }},
        { name: "XFix: Default Tables Intact", fn: () => {
            return db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c === 10
                && db.executeQuery("SELECT COUNT(*) AS c FROM orders").data[0].c === 5
                && db.executeQuery("SELECT COUNT(*) AS c FROM products").data[0].c === 5;
        }},
      ];
    }
