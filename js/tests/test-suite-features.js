    // ============================================================================
    // [Test Suite Features] - 新規追加機能のテスト
    //   1. FK 参照アクション (XRef) : ON DELETE / ON UPDATE CASCADE・SET NULL・RESTRICT
    //   2. CHECK 制約     (XChk)   : 列/テーブル/名前付き、INSERT/UPDATE/ODKU/ALTER
    //   3. 追加組み込み関数 (XFn)  : 三角関数 / LTRIM・RTRIM / DATE 系 など
    //   test-suite.js の tests 配列へ getFeatureTests() のスプレッドで合流する
    // ============================================================================
    function getFeatureTests() {
      return [
        // ============================================================
        // 1. FK 参照アクション (XRef)
        // ============================================================

        // --- ON DELETE CASCADE ---
        { name: "XRef: Cascade Delete Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_p(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_p (id) VALUES (1), (2), (3)");
            const r = db.executeQuery("INSERT INTO ra_c (id, p_id) VALUES (10, 1), (11, 1), (12, 2), (13, 3)");
            return !r.error && r.data[0].Message.includes('4');
        }},
        { name: "XRef: Cascade Delete Removes Children", sql: "DELETE FROM ra_p WHERE id = 1", check: r => r.data[0].Message.includes('1 rows') },
        { name: "XRef: Cascade Child Count After", sql: "SELECT COUNT(*) AS c FROM ra_c", check: r => r.data[0].c === 2 },
        { name: "XRef: Cascade Child Survivors", sql: "SELECT id FROM ra_c ORDER BY id ASC", check: r => r.data.length === 2 && r.data[0].id === 12 && r.data[1].id === 13 },
        { name: "XRef: Cascade Parent Count After", sql: "SELECT COUNT(*) AS c FROM ra_p", check: r => r.data[0].c === 2 },
        { name: "XRef: Cascade SHOW CREATE Includes Action", fn: () => {
            const r = db.executeQuery("SHOW CREATE TABLE ra_c");
            return !r.error && r.data[0].CreateTable.includes('ON DELETE CASCADE');
        }},
        { name: "XRef: Cascade Cleanup", fn: () => { db.executeQuery("DROP TABLE ra_c"); db.executeQuery("DROP TABLE ra_p"); return !db.tables['ra_c']; }},

        // --- ON DELETE SET NULL ---
        { name: "XRef: SetNull Delete Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_sn_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_sn_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_sn_p(id) ON DELETE SET NULL)");
            db.executeQuery("INSERT INTO ra_sn_p (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ra_sn_c (id, p_id) VALUES (10, 1), (11, 1), (12, 2)");
            const del = db.executeQuery("DELETE FROM ra_sn_p WHERE id = 1");
            return !del.error && del.data[0].Message.includes('1');
        }},
        { name: "XRef: SetNull Children Nulled", sql: "SELECT COUNT(*) AS c FROM ra_sn_c WHERE p_id IS NULL", check: r => r.data[0].c === 2 },
        { name: "XRef: SetNull Children All Kept", sql: "SELECT COUNT(*) AS c FROM ra_sn_c", check: r => r.data[0].c === 3 },
        { name: "XRef: SetNull Unaffected Child Intact", sql: "SELECT p_id FROM ra_sn_c WHERE id = 12", check: r => r.data[0].p_id === 2 },
        { name: "XRef: SetNull Cleanup", fn: () => { db.executeQuery("DROP TABLE ra_sn_c"); db.executeQuery("DROP TABLE ra_sn_p"); return true; }},

        // --- ON DELETE RESTRICT (明示 / 既定 / NO ACTION) ---
        { name: "XRef: Restrict Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_r_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_r_def (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_r_p(id))");
            db.executeQuery("CREATE TABLE ra_r_exp (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_r_p(id) ON DELETE RESTRICT)");
            db.executeQuery("CREATE TABLE ra_r_na (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_r_p(id) ON DELETE NO ACTION)");
            db.executeQuery("INSERT INTO ra_r_p (id) VALUES (1), (2), (3)");
            db.executeQuery("INSERT INTO ra_r_def (id, p_id) VALUES (10, 1)");
            db.executeQuery("INSERT INTO ra_r_exp (id, p_id) VALUES (20, 2)");
            db.executeQuery("INSERT INTO ra_r_na (id, p_id) VALUES (30, 3)");
            return true;
        }},
        { name: "XRef: Restrict Default Blocks", sql: "DELETE FROM ra_r_p WHERE id = 1", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key constraint failed') },
        { name: "XRef: Restrict Explicit Blocks", sql: "DELETE FROM ra_r_p WHERE id = 2", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key constraint failed') },
        { name: "XRef: Restrict NoAction Blocks", sql: "DELETE FROM ra_r_p WHERE id = 3", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key constraint failed') },
        { name: "XRef: Restrict Nothing Deleted", sql: "SELECT COUNT(*) AS c FROM ra_r_p", check: r => r.data[0].c === 3 },
        { name: "XRef: Restrict Unreferenced Deletable", fn: () => {
            db.executeQuery("DELETE FROM ra_r_def WHERE id = 10");
            const r = db.executeQuery("DELETE FROM ra_r_p WHERE id = 1");
            return !r.error && r.data[0].Message.includes('1');
        }},
        { name: "XRef: Restrict Cleanup", fn: () => {
            ['ra_r_def','ra_r_exp','ra_r_na','ra_r_p'].forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            return true;
        }},

        // --- 多段 CASCADE 連鎖 ---
        { name: "XRef: Multi-Level Cascade Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_gp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_pa (id INTEGER PRIMARY KEY, gp_id INTEGER, FOREIGN KEY (gp_id) REFERENCES ra_gp(id) ON DELETE CASCADE)");
            db.executeQuery("CREATE TABLE ra_ch (id INTEGER PRIMARY KEY, pa_id INTEGER, FOREIGN KEY (pa_id) REFERENCES ra_pa(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_gp (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ra_pa (id, gp_id) VALUES (10, 1), (11, 1), (12, 2)");
            db.executeQuery("INSERT INTO ra_ch (id, pa_id) VALUES (100, 10), (101, 10), (102, 11), (103, 12)");
            return true;
        }},
        { name: "XRef: Multi-Level Cascade Deletes All Descendants", fn: () => {
            const del = db.executeQuery("DELETE FROM ra_gp WHERE id = 1");
            const pa = db.executeQuery("SELECT COUNT(*) AS c FROM ra_pa").data[0].c;
            const ch = db.executeQuery("SELECT COUNT(*) AS c FROM ra_ch").data[0].c;
            return !del.error && pa === 1 && ch === 1;
        }},
        { name: "XRef: Multi-Level Cascade Survivor", sql: "SELECT id FROM ra_ch", check: r => r.data.length === 1 && r.data[0].id === 103 },
        { name: "XRef: Multi-Level Cleanup", fn: () => {
            ['ra_ch','ra_pa','ra_gp'].forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            return true;
        }},

        // --- 自己参照 CASCADE ---
        { name: "XRef: Self-Ref Cascade Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_tree (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES ra_tree(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_tree (id, parent_id) VALUES (1, null)");
            db.executeQuery("INSERT INTO ra_tree (id, parent_id) VALUES (2, 1), (4, 1)");
            db.executeQuery("INSERT INTO ra_tree (id, parent_id) VALUES (3, 2)");
            return db.tables['ra_tree'].rowCount === 4;
        }},
        { name: "XRef: Self-Ref Cascade Deletes Subtree", fn: () => {
            const del = db.executeQuery("DELETE FROM ra_tree WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM ra_tree").data[0].c;
            db.executeQuery("DROP TABLE ra_tree");
            return !del.error && c === 0;
        }},
        { name: "XRef: Self-Ref Batch Insert Works", fn: () => {
            db.executeQuery("CREATE TABLE ra_tree3 (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES ra_tree3(id) ON DELETE CASCADE)");
            const ins = db.executeQuery("INSERT INTO ra_tree3 (id, parent_id) VALUES (1, null), (2, 1), (3, 2), (4, 1)");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM ra_tree3");
            const bad = db.executeQuery("INSERT INTO ra_tree3 (id, parent_id) VALUES (5, 99)");
            db.executeQuery("DROP TABLE ra_tree3");
            return !ins.error && ins.data[0].Message.includes('4') && cnt.data[0].c === 4 && bad.error !== undefined && bad.error.includes('Foreign key');
        }},
        { name: "XRef: Self-Ref Cascade Partial Subtree", fn: () => {
            db.executeQuery("CREATE TABLE ra_tree2 (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES ra_tree2(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_tree2 (id, parent_id) VALUES (1, null), (2, 1), (3, 2), (4, null)");
            db.executeQuery("DELETE FROM ra_tree2 WHERE id = 2");
            const rows = db.executeQuery("SELECT id FROM ra_tree2 ORDER BY id ASC");
            db.executeQuery("DROP TABLE ra_tree2");
            return rows.data.length === 2 && rows.data[0].id === 1 && rows.data[1].id === 4;
        }},

        // --- 混在: CASCADE 子 と RESTRICT 子 ---
        { name: "XRef: Mixed Actions Setup", fn: () => {
            db.executeQuery("CREATE TABLE ra_mp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_mc_cas (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_mp(id) ON DELETE CASCADE)");
            db.executeQuery("CREATE TABLE ra_mc_res (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_mp(id) ON DELETE RESTRICT)");
            db.executeQuery("INSERT INTO ra_mp (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ra_mc_cas (id, p_id) VALUES (10, 1), (11, 2)");
            db.executeQuery("INSERT INTO ra_mc_res (id, p_id) VALUES (20, 1)");
            return true;
        }},
        { name: "XRef: Mixed Restrict Wins Blocks Delete", sql: "DELETE FROM ra_mp WHERE id = 1", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key') },
        { name: "XRef: Mixed Atomic No Cascade On Block", sql: "SELECT COUNT(*) AS c FROM ra_mc_cas", check: r => r.data[0].c === 2 },
        { name: "XRef: Mixed Cascade-Only Parent Deletable", fn: () => {
            const del = db.executeQuery("DELETE FROM ra_mp WHERE id = 2");
            const cas = db.executeQuery("SELECT COUNT(*) AS c FROM ra_mc_cas").data[0].c;
            return !del.error && cas === 1;
        }},
        { name: "XRef: Mixed Cleanup", fn: () => {
            ['ra_mc_cas','ra_mc_res','ra_mp'].forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            return true;
        }},

        // --- ON UPDATE CASCADE / SET NULL / RESTRICT ---
        { name: "XRef: Update Cascade Setup", fn: () => {
            db.executeQuery("CREATE TABLE ru_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ru_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ru_p(id) ON UPDATE CASCADE)");
            db.executeQuery("INSERT INTO ru_p (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ru_c (id, p_id) VALUES (10, 1), (11, 1), (12, 2)");
            return true;
        }},
        { name: "XRef: Update Cascade Propagates", fn: () => {
            const upd = db.executeQuery("UPDATE ru_p SET id = 100 WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM ru_c WHERE p_id = 100").data[0].c;
            const old = db.executeQuery("SELECT COUNT(*) AS c FROM ru_c WHERE p_id = 1").data[0].c;
            return !upd.error && c === 2 && old === 0;
        }},
        { name: "XRef: Update Cascade Unaffected Kept", sql: "SELECT p_id FROM ru_c WHERE id = 12", check: r => r.data[0].p_id === 2 },
        { name: "XRef: Update Cascade Cleanup", fn: () => { db.executeQuery("DROP TABLE ru_c"); db.executeQuery("DROP TABLE ru_p"); return true; }},
        { name: "XRef: Update SetNull Setup", fn: () => {
            db.executeQuery("CREATE TABLE ru_sn_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ru_sn_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ru_sn_p(id) ON UPDATE SET NULL)");
            db.executeQuery("INSERT INTO ru_sn_p (id) VALUES (1)");
            db.executeQuery("INSERT INTO ru_sn_c (id, p_id) VALUES (10, 1), (11, 1)");
            const upd = db.executeQuery("UPDATE ru_sn_p SET id = 5 WHERE id = 1");
            return !upd.error;
        }},
        { name: "XRef: Update SetNull Children Nulled", sql: "SELECT COUNT(*) AS c FROM ru_sn_c WHERE p_id IS NULL", check: r => r.data[0].c === 2 },
        { name: "XRef: Update SetNull Cleanup", fn: () => { db.executeQuery("DROP TABLE ru_sn_c"); db.executeQuery("DROP TABLE ru_sn_p"); return true; }},
        { name: "XRef: Update Restrict Default Blocks", fn: () => {
            db.executeQuery("CREATE TABLE ru_r_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ru_r_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ru_r_p(id))");
            db.executeQuery("INSERT INTO ru_r_p (id) VALUES (1)");
            db.executeQuery("INSERT INTO ru_r_c (id, p_id) VALUES (10, 1)");
            const upd = db.executeQuery("UPDATE ru_r_p SET id = 9 WHERE id = 1");
            const kept = db.executeQuery("SELECT p_id FROM ru_r_c WHERE id = 10").data[0].p_id;
            db.executeQuery("DROP TABLE ru_r_c"); db.executeQuery("DROP TABLE ru_r_p");
            return upd.error !== undefined && upd.error.includes('Foreign key') && kept === 1;
        }},

        // --- ALTER ADD FK with action ---
        { name: "XRef: Alter Add FK Cascade", fn: () => {
            db.executeQuery("CREATE TABLE ra_ap (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_ac (id INTEGER, p_id INTEGER)");
            db.executeQuery("INSERT INTO ra_ap (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ra_ac (id, p_id) VALUES (10, 1), (11, 2)");
            const add = db.executeQuery("ALTER TABLE ra_ac ADD FOREIGN KEY (p_id) REFERENCES ra_ap(id) ON DELETE CASCADE");
            const del = db.executeQuery("DELETE FROM ra_ap WHERE id = 1");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM ra_ac").data[0].c;
            db.executeQuery("DROP TABLE ra_ac"); db.executeQuery("DROP TABLE ra_ap");
            return !add.error && !del.error && c === 1;
        }},

        // --- トランザクション: CASCADE 削除の ROLLBACK ---
        { name: "XRef: Cascade Rollback Restores All", fn: () => {
            db.executeQuery("CREATE TABLE ra_tx_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_tx_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_tx_p(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_tx_p (id) VALUES (1), (2)");
            db.executeQuery("INSERT INTO ra_tx_c (id, p_id) VALUES (10, 1), (11, 1), (12, 2)");
            db.executeQuery("BEGIN");
            db.executeQuery("DELETE FROM ra_tx_p WHERE id = 1");
            const mid = db.executeQuery("SELECT COUNT(*) AS c FROM ra_tx_c").data[0].c;
            db.executeQuery("ROLLBACK");
            const pAfter = db.executeQuery("SELECT COUNT(*) AS c FROM ra_tx_p").data[0].c;
            const cAfter = db.executeQuery("SELECT COUNT(*) AS c FROM ra_tx_c").data[0].c;
            db.executeQuery("DROP TABLE ra_tx_c"); db.executeQuery("DROP TABLE ra_tx_p");
            return mid === 1 && pAfter === 2 && cAfter === 3;
        }},
        { name: "XRef: Update Cascade Rollback", fn: () => {
            db.executeQuery("CREATE TABLE ru_tx_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ru_tx_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ru_tx_p(id) ON UPDATE CASCADE)");
            db.executeQuery("INSERT INTO ru_tx_p (id) VALUES (1)");
            db.executeQuery("INSERT INTO ru_tx_c (id, p_id) VALUES (10, 1)");
            db.executeQuery("BEGIN");
            db.executeQuery("UPDATE ru_tx_p SET id = 77 WHERE id = 1");
            db.executeQuery("ROLLBACK");
            const p = db.executeQuery("SELECT id FROM ru_tx_p").data[0].id;
            const c = db.executeQuery("SELECT p_id FROM ru_tx_c WHERE id = 10").data[0].p_id;
            db.executeQuery("DROP TABLE ru_tx_c"); db.executeQuery("DROP TABLE ru_tx_p");
            return p === 1 && c === 1;
        }},

        // --- 永続化: 参照アクションが往復で保持される ---
        { name: "XRef: Actions Survive IDB Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            eng.executeQuery("CREATE TABLE rio_p (id INTEGER PRIMARY KEY)");
            eng.executeQuery("CREATE TABLE rio_c (id INTEGER PRIMARY KEY, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES rio_p(id) ON DELETE CASCADE ON UPDATE SET NULL)");
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(eng.exportForIDB());
            const fk = eng2.tables['rio_c'].foreignKeys[0];
            return fk.onDelete === 'CASCADE' && fk.onUpdate === 'SET NULL';
        }},
        { name: "XRef: Actions Survive SQL Export Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE rsx_p (id INTEGER PRIMARY KEY)");
            eng.executeQuery("CREATE TABLE rsx_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES rsx_p(id) ON DELETE CASCADE)");
            eng.executeQuery("INSERT INTO rsx_p (id) VALUES (1)");
            eng.executeQuery("INSERT INTO rsx_c (id, p_id) VALUES (10, 1)");
            const dump = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng2.tables[t]);
            for (const st of splitSqlStatements(dump)) { if (eng2.executeQuery(st).error) return false; }
            eng2.executeQuery("DELETE FROM rsx_p WHERE id = 1");
            return eng2.executeQuery("SELECT COUNT(*) AS c FROM rsx_c").data[0].c === 0;
        }},

        // --- ネガティブ: 参照先が無いFKアクション付き INSERT はやはり弾く ---
        { name: "XRef: Cascade FK Still Enforces Existence", fn: () => {
            db.executeQuery("CREATE TABLE ra_e_p (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE ra_e_c (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES ra_e_p(id) ON DELETE CASCADE)");
            db.executeQuery("INSERT INTO ra_e_p (id) VALUES (1)");
            const bad = db.executeQuery("INSERT INTO ra_e_c (id, p_id) VALUES (10, 99)");
            db.executeQuery("DROP TABLE ra_e_c"); db.executeQuery("DROP TABLE ra_e_p");
            return bad.error !== undefined && bad.error.includes('Foreign key');
        }},

        // ============================================================
        // 2. CHECK 制約 (XChk)
        // ============================================================

        // --- 列レベル CHECK ---
        { name: "XChk: Column Check Create", sql: "CREATE TABLE ck_a (id INTEGER, age INTEGER CHECK (age > 0))", check: r => r.data[0].Result === "Success" },
        { name: "XChk: Column Check Valid Insert", sql: "INSERT INTO ck_a (id, age) VALUES (1, 25)", check: r => r.data[0].Message.includes('1') },
        { name: "XChk: Column Check Boundary Fails", sql: "INSERT INTO ck_a (id, age) VALUES (2, 0)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK constraint failed') },
        { name: "XChk: Column Check Negative Fails", sql: "INSERT INTO ck_a (id, age) VALUES (3, -5)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK constraint failed') },
        { name: "XChk: Column Check Atomic Batch Fail", sql: "INSERT INTO ck_a (id, age) VALUES (4, 10), (5, -1)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK') },
        { name: "XChk: Column Check No Partial Insert", sql: "SELECT COUNT(*) AS c FROM ck_a", check: r => r.data[0].c === 1 },
        { name: "XChk: Column Check Update Fails", sql: "UPDATE ck_a SET age = -3 WHERE id = 1", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK') },
        { name: "XChk: Column Check Update Value Intact", sql: "SELECT age FROM ck_a WHERE id = 1", check: r => r.data[0].age === 25 },
        { name: "XChk: Column Check Update Valid", sql: "UPDATE ck_a SET age = 30 WHERE id = 1", check: r => r.data[0].Message.includes('1') },
        { name: "XChk: Column Check Cleanup", sql: "DROP TABLE ck_a", check: r => r.data[0].Result === "Success" },

        // --- テーブルレベル CHECK ---
        { name: "XChk: Table Check Create", sql: "CREATE TABLE ck_b (lo INTEGER, hi INTEGER, CHECK (lo <= hi))", check: r => r.data[0].Result === "Success" },
        { name: "XChk: Table Check Valid", sql: "INSERT INTO ck_b (lo, hi) VALUES (1, 5)", check: r => r.data[0].Message.includes('1') },
        { name: "XChk: Table Check Equal OK", sql: "INSERT INTO ck_b (lo, hi) VALUES (3, 3)", check: r => r.data[0].Message.includes('1') },
        { name: "XChk: Table Check Violation", sql: "INSERT INTO ck_b (lo, hi) VALUES (5, 1)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK') },
        { name: "XChk: Table Check Cleanup", sql: "DROP TABLE ck_b", check: r => r.data[0].Result === "Success" },

        // --- CHECK with IN list (括弧内カンマ) ---
        { name: "XChk: Check IN List Create", sql: "CREATE TABLE ck_in (id INTEGER, status TEXT CHECK (status IN ('active', 'inactive', 'pending')))", check: r => r.data[0].Result === "Success" },
        { name: "XChk: Check IN List Valid", sql: "INSERT INTO ck_in (id, status) VALUES (1, 'active'), (2, 'pending')", check: r => r.data[0].Message.includes('2') },
        { name: "XChk: Check IN List Invalid", sql: "INSERT INTO ck_in (id, status) VALUES (3, 'deleted')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK') },
        { name: "XChk: Check IN List Cleanup", sql: "DROP TABLE ck_in", check: r => r.data[0].Result === "Success" },

        // --- 複合 CHECK / 関数 / 文字列 ---
        { name: "XChk: Check With Function", fn: () => {
            db.executeQuery("CREATE TABLE ck_fn (code TEXT CHECK (LENGTH(code) >= 3))");
            const ok = db.executeQuery("INSERT INTO ck_fn (code) VALUES ('abc')");
            const bad = db.executeQuery("INSERT INTO ck_fn (code) VALUES ('ab')");
            db.executeQuery("DROP TABLE ck_fn");
            return !ok.error && bad.error !== undefined && bad.error.includes('CHECK');
        }},
        { name: "XChk: Check With AND/OR", fn: () => {
            db.executeQuery("CREATE TABLE ck_lg (n INTEGER CHECK (n >= 0 AND n <= 100))");
            const ok = db.executeQuery("INSERT INTO ck_lg (n) VALUES (50)");
            const bad1 = db.executeQuery("INSERT INTO ck_lg (n) VALUES (150)");
            const bad2 = db.executeQuery("INSERT INTO ck_lg (n) VALUES (-1)");
            db.executeQuery("DROP TABLE ck_lg");
            return !ok.error && bad1.error !== undefined && bad2.error !== undefined;
        }},
        { name: "XChk: Check String Literal With Quote", fn: () => {
            db.executeQuery("CREATE TABLE ck_q (grade TEXT CHECK (grade <> 'F'))");
            const ok = db.executeQuery("INSERT INTO ck_q (grade) VALUES ('A')");
            const bad = db.executeQuery("INSERT INTO ck_q (grade) VALUES ('F')");
            db.executeQuery("DROP TABLE ck_q");
            return !ok.error && bad.error !== undefined && bad.error.includes('CHECK');
        }},
        { name: "XChk: Multiple Checks On Table", fn: () => {
            db.executeQuery("CREATE TABLE ck_multi (a INTEGER CHECK (a > 0), b INTEGER CHECK (b < 100))");
            const ok = db.executeQuery("INSERT INTO ck_multi (a, b) VALUES (5, 50)");
            const badA = db.executeQuery("INSERT INTO ck_multi (a, b) VALUES (0, 50)");
            const badB = db.executeQuery("INSERT INTO ck_multi (a, b) VALUES (5, 150)");
            db.executeQuery("DROP TABLE ck_multi");
            return !ok.error && badA.error !== undefined && badB.error !== undefined;
        }},

        // --- 名前付き CHECK ---
        { name: "XChk: Named Check Create", sql: "CREATE TABLE ck_named (n INTEGER, CONSTRAINT ck_pos CHECK (n > 0))", check: r => r.data[0].Result === "Success" },
        { name: "XChk: Named Check Enforced", sql: "INSERT INTO ck_named (n) VALUES (-1)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('CHECK') },
        { name: "XChk: Named Check Valid", sql: "INSERT INTO ck_named (n) VALUES (5)", check: r => r.data[0].Message.includes('1') },

        // --- ODKU / IGNORE と CHECK ---
        { name: "XChk: ODKU Respects Check", fn: () => {
            db.executeQuery("CREATE TABLE ck_od (id INTEGER PRIMARY KEY, qty INTEGER CHECK (qty >= 0))");
            db.executeQuery("INSERT INTO ck_od (id, qty) VALUES (1, 5)");
            const bad = db.executeQuery("INSERT INTO ck_od (id, qty) VALUES (1, 0) ON DUPLICATE KEY UPDATE qty = qty - 10");
            const v = db.executeQuery("SELECT qty FROM ck_od WHERE id = 1").data[0].qty;
            db.executeQuery("DROP TABLE ck_od");
            return bad.error !== undefined && bad.error.includes('CHECK') && v === 5;
        }},
        { name: "XChk: Insert Ignore Skips Check Violation", fn: () => {
            db.executeQuery("CREATE TABLE ck_ig (id INTEGER, n INTEGER CHECK (n > 0))");
            const r = db.executeQuery("INSERT IGNORE INTO ck_ig (id, n) VALUES (1, 10), (2, -5), (3, 20)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM ck_ig").data[0].c;
            db.executeQuery("DROP TABLE ck_ig");
            return !r.error && c === 2 && r.data[0].Message.includes('1 ignored');
        }},

        // --- ALTER ADD / DROP CHECK ---
        { name: "XChk: Alter Add Check Enforces", fn: () => {
            db.executeQuery("CREATE TABLE ck_alt (n INTEGER)");
            db.executeQuery("INSERT INTO ck_alt (n) VALUES (5)");
            const add = db.executeQuery("ALTER TABLE ck_alt ADD CONSTRAINT ck_n CHECK (n > 0)");
            const bad = db.executeQuery("INSERT INTO ck_alt (n) VALUES (-1)");
            db.executeQuery("DROP TABLE ck_alt");
            return !add.error && bad.error !== undefined && bad.error.includes('CHECK');
        }},
        { name: "XChk: Alter Add Check Rejects Bad Existing Data", fn: () => {
            db.executeQuery("CREATE TABLE ck_alt2 (n INTEGER)");
            db.executeQuery("INSERT INTO ck_alt2 (n) VALUES (5), (-3)");
            const add = db.executeQuery("ALTER TABLE ck_alt2 ADD CHECK (n > 0)");
            db.executeQuery("DROP TABLE ck_alt2");
            return add.error !== undefined && add.error.includes('CHECK');
        }},
        { name: "XChk: Alter Drop Check Removes Enforcement", fn: () => {
            db.executeQuery("CREATE TABLE ck_alt3 (n INTEGER, CONSTRAINT ck_p CHECK (n > 0))");
            const bad1 = db.executeQuery("INSERT INTO ck_alt3 (n) VALUES (-1)");
            const drop = db.executeQuery("ALTER TABLE ck_alt3 DROP CHECK ck_p");
            const ok = db.executeQuery("INSERT INTO ck_alt3 (n) VALUES (-1)");
            db.executeQuery("DROP TABLE ck_alt3");
            return bad1.error !== undefined && !drop.error && !ok.error;
        }},
        { name: "XChk: Alter Drop Missing Check Errors", fn: () => {
            db.executeQuery("CREATE TABLE ck_alt4 (n INTEGER)");
            const r = db.executeQuery("ALTER TABLE ck_alt4 DROP CHECK nope");
            db.executeQuery("DROP TABLE ck_alt4");
            return r.error !== undefined;
        }},

        // --- CHECK ロールバック / 永続化 ---
        { name: "XChk: Alter Add Check Rolls Back", fn: () => {
            db.executeQuery("CREATE TABLE ck_tx (n INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE ck_tx ADD CONSTRAINT ck_r CHECK (n > 0)");
            db.executeQuery("ROLLBACK");
            const ok = db.executeQuery("INSERT INTO ck_tx (n) VALUES (-9)");
            const noChk = (db.tables['ck_tx'].checks || []).length === 0;
            db.executeQuery("DROP TABLE ck_tx");
            return !ok.error && noChk;
        }},
        { name: "XChk: Checks Survive IDB Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            eng.executeQuery("CREATE TABLE cio (n INTEGER CHECK (n >= 10))");
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(eng.exportForIDB());
            const bad = eng2.executeQuery("INSERT INTO cio (n) VALUES (5)");
            const ok = eng2.executeQuery("INSERT INTO cio (n) VALUES (15)");
            return eng2.tables['cio'].checks.length === 1 && bad.error !== undefined && !ok.error;
        }},
        { name: "XChk: Checks Survive SQL Export Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE csx (id INTEGER, status TEXT CHECK (status IN ('x', 'y')))");
            eng.executeQuery("INSERT INTO csx (id, status) VALUES (1, 'x')");
            const dump = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users','products','orders'].forEach(t => delete eng2.tables[t]);
            for (const st of splitSqlStatements(dump)) { if (eng2.executeQuery(st).error) return false; }
            const bad = eng2.executeQuery("INSERT INTO csx (id, status) VALUES (2, 'z')");
            const ok = eng2.executeQuery("INSERT INTO csx (id, status) VALUES (3, 'y')");
            return bad.error !== undefined && bad.error.includes('CHECK') && !ok.error;
        }},
        { name: "XChk: SHOW CREATE Includes Check", fn: () => {
            db.executeQuery("CREATE TABLE csc (n INTEGER CHECK (n > 0))");
            const r = db.executeQuery("SHOW CREATE TABLE csc");
            db.executeQuery("DROP TABLE csc");
            return !r.error && /CHECK\s*\(/.test(r.data[0].CreateTable);
        }},
        { name: "XChk: Named Cleanup", sql: "DROP TABLE ck_named", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 3. 追加組み込み関数 (XFn)
        // ============================================================

        // --- 文字列 ---
        { name: "XFn: LTRIM / RTRIM", sql: "SELECT LTRIM('   abc  ') AS l, RTRIM('  abc   ') AS r", check: r => r.data[0].l === 'abc  ' && r.data[0].r === '  abc' },
        { name: "XFn: ASCII / CHAR", sql: "SELECT ASCII('A') AS a, ASCII('a') AS b, CHAR(65) AS c, CHAR(97) AS d", check: r => r.data[0].a === 65 && r.data[0].b === 97 && r.data[0].c === 'A' && r.data[0].d === 'a' },
        { name: "XFn: ASCII Empty And Null", sql: "SELECT ASCII('') AS a, LTRIM(null) AS b, RTRIM(null) AS c", check: r => r.data[0].a === 0 && r.data[0].b === null && r.data[0].c === null },
        { name: "XFn: LTRIM RTRIM Composed With Length", sql: "SELECT LENGTH(RTRIM(LTRIM('  hi  '))) AS n", check: r => r.data[0].n === 2 },

        // --- 三角関数 ---
        { name: "XFn: SIN COS TAN Zero", sql: "SELECT SIN(0) AS s, COS(0) AS c, TAN(0) AS t", check: r => r.data[0].s === 0 && r.data[0].c === 1 && r.data[0].t === 0 },
        { name: "XFn: ASIN ACOS ATAN Degrees", sql: "SELECT ROUND(DEGREES(ASIN(1))) AS a, ROUND(DEGREES(ACOS(0))) AS b, ROUND(DEGREES(ATAN(1))) AS c", check: r => r.data[0].a === 90 && r.data[0].b === 90 && r.data[0].c === 45 },
        { name: "XFn: ATAN2 Degrees", sql: "SELECT ROUND(DEGREES(ATAN2(1, 1))) AS d", check: r => r.data[0].d === 45 },
        { name: "XFn: DEGREES RADIANS Roundtrip", sql: "SELECT ABS(RADIANS(180) - PI()) < 0.0000001 AS ok, ROUND(DEGREES(PI())) AS d", check: r => r.data[0].ok === true && r.data[0].d === 180 },
        { name: "XFn: SINH Zero And Null", sql: "SELECT SINH(0) AS s, SIN(null) AS n", check: r => r.data[0].s === 0 && r.data[0].n === null },

        // --- 数値 ---
        { name: "XFn: LN Of E", sql: "SELECT ROUND(LN(EXP(1))) AS a, LN(1) AS b, LN(0) AS c, LN(-1) AS d", check: r => r.data[0].a === 1 && r.data[0].b === 0 && r.data[0].c === null && r.data[0].d === null },
        { name: "XFn: CBRT", sql: "SELECT CBRT(27) AS a, CBRT(-8) AS b, CBRT(0) AS c", check: r => r.data[0].a === 3 && r.data[0].b === -2 && r.data[0].c === 0 },

        // --- 日付・時刻 ---
        { name: "XFn: DATE_ADD Days", sql: "SELECT DATE_ADD('2026-01-01', 5) AS v", check: r => r.data[0].v === '2026-01-06 00:00:00' },
        { name: "XFn: DATE_SUB Days", sql: "SELECT DATE_SUB('2026-01-06', 5) AS v", check: r => r.data[0].v === '2026-01-01 00:00:00' },
        { name: "XFn: DATE_ADD Across Month", sql: "SELECT DATE_ADD('2026-01-30', 3) AS v", check: r => r.data[0].v === '2026-02-02 00:00:00' },
        { name: "XFn: DATE_ADD Null", sql: "SELECT DATE_ADD(null, 5) AS a, DATE_SUB('2026-01-01', null) AS b", check: r => r.data[0].a === null && r.data[0].b === null },
        { name: "XFn: DAYOFWEEK", sql: "SELECT DAYOFWEEK('2000-01-01') AS sat, DAYOFWEEK('2000-01-02') AS sun", check: r => r.data[0].sat === 7 && r.data[0].sun === 1 },
        { name: "XFn: DAYOFYEAR", sql: "SELECT DAYOFYEAR('2026-01-01') AS a, DAYOFYEAR('2026-12-31') AS b", check: r => r.data[0].a === 1 && r.data[0].b === 365 },
        { name: "XFn: DAYOFYEAR Leap", sql: "SELECT DAYOFYEAR('2024-12-31') AS b", check: r => r.data[0].b === 366 },
        { name: "XFn: QUARTER", sql: "SELECT QUARTER('2026-01-15') AS a, QUARTER('2026-04-01') AS b, QUARTER('2026-07-01') AS c, QUARTER('2026-12-31') AS d", check: r => r.data[0].a === 1 && r.data[0].b === 2 && r.data[0].c === 3 && r.data[0].d === 4 },
        { name: "XFn: LAST_DAY", sql: "SELECT LAST_DAY('2026-02-15') AS feb, LAST_DAY('2024-02-10') AS leap, LAST_DAY('2026-07-05') AS jul", check: r => r.data[0].feb === '2026-02-28' && r.data[0].leap === '2024-02-29' && r.data[0].jul === '2026-07-31' },
        { name: "XFn: CURDATE Format", sql: "SELECT CURDATE() AS v", check: r => typeof r.data[0].v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.data[0].v) },
        { name: "XFn: CURRENT_DATE Keyword", sql: "SELECT CURRENT_DATE AS v", check: r => typeof r.data[0].v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.data[0].v) },
        { name: "XFn: CURRENT_TIMESTAMP Keyword", sql: "SELECT CURRENT_TIMESTAMP AS v", check: r => typeof r.data[0].v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.data[0].v) },
        { name: "XFn: DateDiff With DATE_ADD", sql: "SELECT DATEDIFF(DATE_ADD('2026-01-01', 10), '2026-01-01') AS d", check: r => r.data[0].d === 10 },

        // --- 実データ上での利用 ---
        { name: "XFn: Functions On Real Columns", sql: "SELECT ASCII(name) AS a, LTRIM(name) AS l FROM users WHERE id = 1", check: r => r.data[0].a === 65 && r.data[0].l === 'Alice' },
        { name: "XFn: Trig In Where", sql: "SELECT COUNT(*) AS c FROM users WHERE SIN(0) = 0", check: r => r.data[0].c === 10 },
        { name: "XFn: Quarter Grouping", fn: () => {
            db.executeQuery("CREATE TABLE fn_dt (id INTEGER, d DATE)");
            db.executeQuery("INSERT INTO fn_dt (id, d) VALUES (1, '2026-02-01'), (2, '2026-03-15'), (3, '2026-08-20')");
            const r = db.executeQuery("SELECT QUARTER(d) AS q, COUNT(*) AS c FROM fn_dt GROUP BY QUARTER(d) ORDER BY q ASC");
            db.executeQuery("DROP TABLE fn_dt");
            return !r.error && r.data.length === 2 && r.data[0].q === 1 && r.data[0].c === 2 && r.data[1].q === 3 && r.data[1].c === 1;
        }},

        // ============================================================
        // 後始末
        // ============================================================
        { name: "XFeat: No Leftover Feature Tables", fn: () => {
            const pat = /^(ra_|ru_|rio_|rsx_|ck_|cio|csx|csc|fn_)/;
            Object.keys(db.tables).filter(t => pat.test(t)).forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            return !Object.keys(db.tables).some(t => pat.test(t));
        }},
        { name: "XFeat: Default Tables Intact", sql: "SELECT COUNT(*) AS c FROM users", check: r => r.data[0].c === 10 },
      ];
    }
