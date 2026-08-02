    // ============================================================================
    // [Test Suite v24] - v1.19 で追加した商用DB互換機能のテスト
    //
    //   バックエンド:
    //     - 複合列 FOREIGN KEY（従来は明示エラー）
    //     - シーケンスのオプション（MINVALUE / MAXVALUE / CYCLE / CACHE）と ALTER SEQUENCE
    //     - DEFAULT に式を書ける（NEXTVAL / UUID() / (1+2)）— 行ごとに評価する
    //     - MERGE の条件付き WHEN と WHEN NOT MATCHED BY SOURCE
    //     - VALUES(col) / ON CONFLICT ... DO UPDATE ... WHERE
    //     - CREATE VIEW v (c1, c2) AS ... の列リスト
    //     - ALTER INDEX RENAME / SHOW TABLE STATUS / WITH [NO] DATA / GLOBAL TEMPORARY
    //     - 集計の入れ子に対する判りやすいエラー
    //   フロントエンド:
    //     - 結果グリッドの直接編集（編集可否の判定・コミット・取消・制約違反）
    //     - Markdown / INSERT 形式のコピー
    //     - キーボードショートカット一覧
    //
    //   test-suite.js の tests 配列へ getV24Tests() のスプレッドで合流する
    // ============================================================================
    function getV24Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      const one = (sql) => { const r = db.executeQuery(sql); return r.error ? { __err: r.error } : Object.values(r.data[0])[0]; };

      // ============================================================
      // 1. 複合列 FOREIGN KEY
      // ============================================================
      fn('V24Cfk fixture', () => {
        db.executeQuery("CREATE TABLE v24_p (a INTEGER, b INTEGER, nm TEXT, PRIMARY KEY (a, b))");
        db.executeQuery("INSERT INTO v24_p VALUES (1,1,'x'),(1,2,'y'),(2,1,'z')");
        return !db.executeQuery("CREATE TABLE v24_c (id INTEGER, pa INTEGER, pb INTEGER, FOREIGN KEY (pa, pb) REFERENCES v24_p(a, b) ON DELETE CASCADE)").error;
      });
      push('V24Cfk shown in DDL', "SHOW CREATE TABLE v24_c",
        r => r.data[0].CreateTable.includes('FOREIGN KEY (pa, pb) REFERENCES v24_p(a, b) ON DELETE CASCADE'));
      push('V24Cfk valid tuple accepted', "INSERT INTO v24_c VALUES (1, 1, 1)", r => !r.error);
      err('V24Cfk invalid tuple rejected', "INSERT INTO v24_c VALUES (2, 9, 9)", "Foreign key");
      // タプルの一部が NULL なら制約は満たされたものとする（SQL標準の MATCH SIMPLE）
      push('V24Cfk null part skips check', "INSERT INTO v24_c VALUES (3, 1, NULL)", r => !r.error);
      push('V24Cfk row count', "SELECT COUNT(*) AS c FROM v24_c", r => r.data[0].c === 2);
      err('V24Cfk update breaking tuple rejected', "UPDATE v24_c SET pb = 9 WHERE id = 1", "Foreign key");
      push('V24Cfk update to valid tuple', "UPDATE v24_c SET pb = 2 WHERE id = 1", r => !r.error);
      push('V24Cfk update applied', "SELECT pb FROM v24_c WHERE id = 1", r => r.data[0].pb === 2);
      fn('V24Cfk cascade delete on tuple', () => {
        db.executeQuery("DELETE FROM v24_p WHERE a = 1 AND b = 2");
        return db.executeQuery("SELECT COUNT(*) AS c FROM v24_c").data[0].c === 1;
      });
      fn('V24Cfk restrict blocks parent delete', () => {
        db.executeQuery("CREATE TABLE v24_c2 (id INTEGER, pa INTEGER, pb INTEGER, FOREIGN KEY (pa, pb) REFERENCES v24_p(a, b))");
        db.executeQuery("INSERT INTO v24_c2 VALUES (1, 2, 1)");
        const r = db.executeQuery("DELETE FROM v24_p WHERE a = 2");
        return r.error !== undefined && r.error.includes('v24_c2(pa, pb)');
      });
      fn('V24Cfk on update cascade', () => {
        db.executeQuery("CREATE TABLE v24_pu (a INTEGER, b INTEGER, PRIMARY KEY (a, b))");
        db.executeQuery("INSERT INTO v24_pu VALUES (5, 6)");
        db.executeQuery("CREATE TABLE v24_cu (id INTEGER, pa INTEGER, pb INTEGER, FOREIGN KEY (pa, pb) REFERENCES v24_pu(a, b) ON UPDATE CASCADE)");
        db.executeQuery("INSERT INTO v24_cu VALUES (1, 5, 6)");
        db.executeQuery("UPDATE v24_pu SET a = 50 WHERE a = 5");
        const got = db.executeQuery("SELECT pa, pb FROM v24_cu").data[0];
        return got.pa === 50 && got.pb === 6;
      });
      err('V24Cfk arity mismatch rejected', "CREATE TABLE v24_bad (a INTEGER, b INTEGER, FOREIGN KEY (a, b) REFERENCES v24_p(a))", "has 2 columns but references 1");
      err('V24Cfk unknown ref column rejected', "CREATE TABLE v24_bad2 (a INTEGER, b INTEGER, FOREIGN KEY (a, b) REFERENCES v24_p(a, zz))", "not found");
      fn('V24Cfk alter add and drop', () => {
        db.executeQuery("CREATE TABLE v24_c3 (id INTEGER, pa INTEGER, pb INTEGER)");
        const a = db.executeQuery("ALTER TABLE v24_c3 ADD CONSTRAINT v24_mfk FOREIGN KEY (pa, pb) REFERENCES v24_p(a, b)");
        const bad = db.executeQuery("INSERT INTO v24_c3 VALUES (1, 9, 9)");
        const d = db.executeQuery("ALTER TABLE v24_c3 DROP FOREIGN KEY (pa, pb)");
        const ok = db.executeQuery("INSERT INTO v24_c3 VALUES (1, 9, 9)");
        return !a.error && bad.error !== undefined && !d.error && !ok.error;
      });
      fn('V24Cfk describe maps each column', () => {
        const r = db.executeQuery("DESCRIBE v24_c");
        const pa = r.data.find(d => d.Column === 'pa'), pb = r.data.find(d => d.Column === 'pb');
        return pa.ForeignKey === 'v24_p(a)' && pb.ForeignKey === 'v24_p(b)';
      });
      fn('V24Cfk pragma lists one row per column', () => {
        const r = db.executeQuery("PRAGMA foreign_key_list(v24_c)");
        return r.data.length === 2 && r.data[0].seq === 0 && r.data[1].seq === 1
            && r.data[0].from === 'pa' && r.data[1].to === 'b';
      });
      fn('V24Cfk key_column_usage lists both columns', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.key_column_usage WHERE table_name = 'v24_c'");
        return r.data.length === 2 && r.data[0].ordinal_position === 1 && r.data[1].ordinal_position === 2;
      });
      fn('V24Cfk survives IDB round trip', () => {
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        const fk = e2.tables.v24_c.foreignKeys[0];
        return fk.cols.join(',') === 'pa,pb' && fk.refCols.join(',') === 'a,b' && fk.onDelete === 'CASCADE';
      });
      // 列名の変更・削除で FK が取り残されないこと（従来は放置されていた）
      fn('V24Cfk follows column rename', () => {
        db.executeQuery("CREATE TABLE v24_rn (id INTEGER, pa INTEGER, pb INTEGER, FOREIGN KEY (pa, pb) REFERENCES v24_p(a, b))");
        db.executeQuery("ALTER TABLE v24_rn RENAME COLUMN pa TO qa");
        const fk = db.tables.v24_rn.foreignKeys[0];
        const bad = db.executeQuery("INSERT INTO v24_rn (id, qa, pb) VALUES (1, 9, 9)");
        return fk.cols.join(',') === 'qa,pb' && bad.error !== undefined;
      });
      fn('V24Cfk dropped with its column', () => {
        db.executeQuery("ALTER TABLE v24_rn DROP COLUMN qa");
        const ok = db.tables.v24_rn.foreignKeys.length === 0;
        db.executeQuery("DROP TABLE v24_rn");
        return ok;
      });
      fn('V24Cfk single column form unchanged', () => {
        db.executeQuery("CREATE TABLE v24_s1 (id INTEGER PRIMARY KEY)");
        db.executeQuery("CREATE TABLE v24_s2 (id INTEGER, pid INTEGER REFERENCES v24_s1(id))");
        const fk = db.tables.v24_s2.foreignKeys[0];
        return fk.col === 'pid' && fk.refCol === 'id' && fk.cols === undefined;
      });

      // ============================================================
      // 2. シーケンスのオプションと ALTER SEQUENCE
      // ============================================================
      push('V24Seq full options', "CREATE SEQUENCE v24_s START WITH 5 INCREMENT BY 2 MINVALUE 1 MAXVALUE 9 CYCLE",
        r => !r.error && r.data[0].Message.includes('MAXVALUE 9'));
      push('V24Seq cycles at max', "SELECT NEXTVAL('v24_s') AS a, NEXTVAL('v24_s') AS b, NEXTVAL('v24_s') AS c, NEXTVAL('v24_s') AS d",
        r => r.data[0].a === 5 && r.data[0].b === 7 && r.data[0].c === 9 && r.data[0].d === 1);
      fn('V24Seq exhausts without cycle', () => {
        db.executeQuery("CREATE SEQUENCE v24_s2 MAXVALUE 2");
        const a = one("SELECT NEXTVAL('v24_s2') AS v"), b = one("SELECT NEXTVAL('v24_s2') AS v");
        // 上限超過は式評価中の例外になるため、式の文脈では NULL として現れる
        const c = one("SELECT NEXTVAL('v24_s2') AS v");
        let direct = null;
        try { db._seqNext('v24_s2'); } catch (e) { direct = e.message; }
        return a === 1 && b === 2 && c === null && direct !== null && direct.includes('MAXVALUE');
      });
      push('V24Seq cache accepted', "CREATE SEQUENCE v24_s3 CACHE 20", r => !r.error);
      push('V24Seq descending default start', "CREATE SEQUENCE v24_s4 INCREMENT BY -1 MAXVALUE 10 MINVALUE 1",
        r => !r.error && r.data[0].Message.includes('START WITH 10'));
      err('V24Seq start outside range', "CREATE SEQUENCE v24_sbad START WITH 50 MAXVALUE 10", "outside the sequence range");
      err('V24Seq min above max', "CREATE SEQUENCE v24_sbad2 MINVALUE 9 MAXVALUE 1", "MINVALUE must not exceed MAXVALUE");
      err('V24Seq unknown option', "CREATE SEQUENCE v24_sbad3 GARBAGE 3", "Syntax Error in CREATE SEQUENCE");
      err('V24Seq zero increment', "CREATE SEQUENCE v24_sbad4 INCREMENT BY 0", "must not be 0");
      fn('V24Seq alter restart with', () => {
        db.executeQuery("CREATE SEQUENCE v24_s5");
        one("SELECT NEXTVAL('v24_s5') AS v");
        const a = db.executeQuery("ALTER SEQUENCE v24_s5 RESTART WITH 100");
        return !a.error && one("SELECT NEXTVAL('v24_s5') AS v") === 100;
      });
      fn('V24Seq alter increment', () => {
        db.executeQuery("ALTER SEQUENCE v24_s5 INCREMENT BY 10");
        return one("SELECT NEXTVAL('v24_s5') AS v") === 110;
      });
      fn('V24Seq alter bare restart reuses start', () => {
        db.executeQuery("ALTER SEQUENCE v24_s5 RESTART");
        return one("SELECT NEXTVAL('v24_s5') AS v") === 100;
      });
      err('V24Seq alter unknown', "ALTER SEQUENCE v24_nope RESTART", "not found");
      push('V24Seq alter if exists skips', "ALTER SEQUENCE IF EXISTS v24_nope RESTART", r => !r.error && r.data[0].Message.includes('Skipped'));
      fn('V24Seq show reports range', () => {
        const r = db.executeQuery("SHOW SEQUENCES");
        const row = r.data.find(d => d.Sequence === 'v24_s');
        return row.MaxValue === 9 && row.MinValue === 1 && row.Cycle === true;
      });
      fn('V24Seq metadata view', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.sequences WHERE sequence_name = 'v24_s'");
        return r.data[0].maximum_value === 9 && r.data[0].cycle_option === 'YES';
      });
      fn('V24Seq options survive IDB round trip', () => {
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        const s = e2.sequences.v24_s;
        return s.maxValue === 9 && s.cycle === true;
      });

      // ============================================================
      // 3. DEFAULT に式を書く
      // ============================================================
      fn('V24Def nextval per row', () => {
        db.executeQuery("CREATE SEQUENCE v24_idseq");
        db.executeQuery("CREATE TABLE v24_d1 (id INTEGER DEFAULT NEXTVAL('v24_idseq'), v TEXT)");
        db.executeQuery("INSERT INTO v24_d1 (v) VALUES ('a'),('b')");
        const r = db.executeQuery("SELECT id, v FROM v24_d1 ORDER BY id");
        return r.data.length === 2 && r.data[0].id === 1 && r.data[1].id === 2;
      });
      push('V24Def nextval shown in DDL', "SHOW CREATE TABLE v24_d1",
        r => r.data[0].CreateTable.includes("DEFAULT NEXTVAL('v24_idseq')"));
      fn('V24Def uuid differs per row', () => {
        db.executeQuery("CREATE TABLE v24_d2 (a INTEGER, u TEXT DEFAULT UUID())");
        db.executeQuery("INSERT INTO v24_d2 (a) VALUES (1),(2)");
        return db.executeQuery("SELECT COUNT(DISTINCT u) AS n FROM v24_d2").data[0].n === 2;
      });
      fn('V24Def arithmetic expression', () => {
        db.executeQuery("CREATE TABLE v24_d3 (a INTEGER, b INTEGER DEFAULT (1 + 2))");
        db.executeQuery("INSERT INTO v24_d3 (a) VALUES (9)");
        return db.executeQuery("SELECT b FROM v24_d3").data[0].b === 3;
      });
      err('V24Def unknown function rejected', "CREATE TABLE v24_dbad (a INTEGER DEFAULT NOPEFN())", "Unknown function");
      fn('V24Def add column with expression', () => {
        db.executeQuery("CREATE TABLE v24_d4 (a INTEGER)");
        db.executeQuery("INSERT INTO v24_d4 VALUES (1)");
        db.executeQuery("ALTER TABLE v24_d4 ADD COLUMN w INTEGER DEFAULT (3 + 4)");
        const filled = db.executeQuery("SELECT w FROM v24_d4").data[0].w;
        db.executeQuery("INSERT INTO v24_d4 (a) VALUES (2)");
        const inserted = db.executeQuery("SELECT w FROM v24_d4 WHERE a = 2").data[0].w;
        return filled === 7 && inserted === 7;
      });
      fn('V24Def set default expression', () => {
        db.executeQuery("ALTER TABLE v24_d4 ALTER COLUMN w SET DEFAULT (9)");
        db.executeQuery("INSERT INTO v24_d4 (a) VALUES (3)");
        return db.executeQuery("SELECT w FROM v24_d4 WHERE a = 3").data[0].w === 9;
      });
      fn('V24Def explicit value wins over default', () => {
        db.executeQuery("INSERT INTO v24_d3 (a, b) VALUES (10, 77)");
        return db.executeQuery("SELECT b FROM v24_d3 WHERE a = 10").data[0].b === 77;
      });
      fn('V24Def DEFAULT keyword resolves the expression', () => {
        db.executeQuery("INSERT INTO v24_d3 (a, b) VALUES (11, DEFAULT)");
        return db.executeQuery("SELECT b FROM v24_d3 WHERE a = 11").data[0].b === 3;
      });
      fn('V24Def literal defaults still literal', () => {
        db.executeQuery("CREATE TABLE v24_d5 (a INTEGER, s TEXT DEFAULT 'x', n INTEGER DEFAULT 7)");
        db.executeQuery("INSERT INTO v24_d5 (a) VALUES (1)");
        const r = db.executeQuery("SELECT s, n FROM v24_d5").data[0];
        const ddl = db.executeQuery("SHOW CREATE TABLE v24_d5").data[0].CreateTable;
        return r.s === 'x' && r.n === 7 && ddl.includes("DEFAULT 'x'") && ddl.includes('DEFAULT 7');
      });
      fn('V24Def expression survives IDB round trip', () => {
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        const dv = e2.tables.v24_d3.defaults.b;
        return dv && dv.__expr === '(1 + 2)';
      });
      fn('V24Def metadata shows the expression', () => {
        const r = db.executeQuery("SELECT column_default FROM information_schema.columns WHERE table_name = 'v24_d1' AND column_name = 'id'");
        return r.data[0].column_default === "NEXTVAL('v24_idseq')";
      });

      // ============================================================
      // 4. MERGE の条件付き WHEN
      // ============================================================
      fn('V24Mg fixture', () => {
        db.executeQuery("CREATE TABLE v24_tg (id INTEGER PRIMARY KEY, nm TEXT, qty INTEGER)");
        db.executeQuery("CREATE TABLE v24_sr (id INTEGER, nm TEXT, qty INTEGER)");
        db.executeQuery("INSERT INTO v24_tg VALUES (1,'a',10),(2,'b',20),(3,'c',30)");
        db.executeQuery("INSERT INTO v24_sr VALUES (1,'A',10),(2,'B',99),(4,'D',40)");
        return true;
      });
      fn('V24Mg matched AND filters updates', () => {
        const r = db.executeQuery("MERGE INTO v24_tg t USING v24_sr s ON t.id = s.id "
            + "WHEN MATCHED AND t.qty <> s.qty THEN UPDATE SET nm = s.nm, qty = s.qty "
            + "WHEN NOT MATCHED THEN INSERT (id, nm, qty) VALUES (s.id, s.nm, s.qty)");
        const rows = db.executeQuery("SELECT id, nm, qty FROM v24_tg ORDER BY id").data;
        // id=1 は qty が同じなので更新されない / id=2 は更新 / id=4 は挿入
        return !r.error && rows.length === 4 && rows[0].nm === 'a' && rows[1].nm === 'B' && rows[3].id === 4;
      });
      fn('V24Mg first matching clause wins', () => {
        const r = db.executeQuery("MERGE INTO v24_tg t USING v24_sr s ON t.id = s.id "
            + "WHEN MATCHED AND s.qty > 50 THEN DELETE "
            + "WHEN MATCHED THEN UPDATE SET nm = 'kept'");
        const rows = db.executeQuery("SELECT id, nm FROM v24_tg ORDER BY id").data;
        // s.qty=99 の id=2 は削除、他の一致行は 'kept'
        return !r.error && rows.every(x => x.nm === 'kept' || x.id === 3) && !rows.some(x => x.id === 2);
      });
      fn('V24Mg not matched by source deletes', () => {
        const r = db.executeQuery("MERGE INTO v24_tg t USING v24_sr s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE");
        const ids = db.executeQuery("SELECT id FROM v24_tg ORDER BY id").data.map(x => x.id);
        return !r.error && ids.indexOf(3) === -1;
      });
      fn('V24Mg not matched by source updates with condition', () => {
        db.executeQuery("CREATE TABLE v24_bs (id INTEGER PRIMARY KEY, f INTEGER)");
        db.executeQuery("INSERT INTO v24_bs VALUES (1,1),(2,2),(3,3)");
        const r = db.executeQuery("MERGE INTO v24_bs t USING (SELECT 1 AS id) s ON t.id = s.id "
            + "WHEN NOT MATCHED BY SOURCE AND t.f > 2 THEN UPDATE SET f = 0");
        const rows = db.executeQuery("SELECT id, f FROM v24_bs ORDER BY id").data;
        return !r.error && rows[0].f === 1 && rows[1].f === 2 && rows[2].f === 0;
      });
      fn('V24Mg not matched AND skips insert', () => {
        const before = db.executeQuery("SELECT COUNT(*) AS c FROM v24_bs").data[0].c;
        db.executeQuery("MERGE INTO v24_bs t USING (SELECT 9 AS id, 5 AS f) s ON t.id = s.id "
            + "WHEN NOT MATCHED AND s.f > 10 THEN INSERT (id, f) VALUES (s.id, s.f)");
        const after = db.executeQuery("SELECT COUNT(*) AS c FROM v24_bs").data[0].c;
        return before === after;
      });
      fn('V24Mg not matched AND allows insert', () => {
        const r = db.executeQuery("MERGE INTO v24_bs t USING (SELECT 9 AS id, 5 AS f) s ON t.id = s.id "
            + "WHEN NOT MATCHED AND s.f > 1 THEN INSERT (id, f) VALUES (s.id, s.f)");
        return !r.error && db.executeQuery("SELECT f FROM v24_bs WHERE id = 9").data[0].f === 5;
      });
      err('V24Mg insert only in not matched', "MERGE INTO v24_bs t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN INSERT (id) VALUES (1)", "only allowed in WHEN NOT MATCHED");
      err('V24Mg update not allowed in not matched', "MERGE INTO v24_bs t USING (SELECT 1 AS id) s ON t.id = s.id WHEN NOT MATCHED THEN UPDATE SET f = 1", "supports INSERT only");
      err('V24Mg unknown action', "MERGE INTO v24_bs t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN NOPE", "Unsupported MERGE WHEN clause");
      fn('V24Mg plain matched still works', () => {
        const r = db.executeQuery("MERGE INTO v24_bs t USING (SELECT 1 AS id, 42 AS f) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET f = s.f");
        return !r.error && db.executeQuery("SELECT f FROM v24_bs WHERE id = 1").data[0].f === 42;
      });

      // ============================================================
      // 5. VALUES(col) / ON CONFLICT ... WHERE
      // ============================================================
      fn('V24Up fixture', () => {
        db.executeQuery("CREATE TABLE v24_k (id INTEGER PRIMARY KEY, nm TEXT, hits INTEGER)");
        db.executeQuery("INSERT INTO v24_k VALUES (1,'a',5),(2,'b',1)");
        return true;
      });
      fn('V24Up VALUES() refers to the incoming row', () => {
        const r = db.executeQuery("INSERT INTO v24_k (id, nm, hits) VALUES (1, 'A', 9) "
            + "ON DUPLICATE KEY UPDATE nm = VALUES(nm), hits = hits + VALUES(hits)");
        const row = db.executeQuery("SELECT nm, hits FROM v24_k WHERE id = 1").data[0];
        return !r.error && row.nm === 'A' && row.hits === 14;
      });
      fn('V24Up conflict where blocks update', () => {
        const r = db.executeQuery("INSERT INTO v24_k (id, nm, hits) VALUES (2, 'B', 3) "
            + "ON CONFLICT (id) DO UPDATE SET nm = EXCLUDED.nm WHERE v24_k.hits > 100");
        return !r.error && db.executeQuery("SELECT nm FROM v24_k WHERE id = 2").data[0].nm === 'b';
      });
      fn('V24Up conflict where allows update', () => {
        const r = db.executeQuery("INSERT INTO v24_k (id, nm, hits) VALUES (2, 'B', 3) "
            + "ON CONFLICT (id) DO UPDATE SET nm = EXCLUDED.nm WHERE v24_k.hits < 100");
        return !r.error && db.executeQuery("SELECT nm FROM v24_k WHERE id = 2").data[0].nm === 'B';
      });
      fn('V24Up conflict where can read EXCLUDED', () => {
        const r = db.executeQuery("INSERT INTO v24_k (id, nm, hits) VALUES (2, 'C', 3) "
            + "ON CONFLICT (id) DO UPDATE SET nm = EXCLUDED.nm WHERE EXCLUDED.hits > 2");
        return !r.error && db.executeQuery("SELECT nm FROM v24_k WHERE id = 2").data[0].nm === 'C';
      });
      fn('V24Up conflict where does not block insert', () => {
        const r = db.executeQuery("INSERT INTO v24_k (id, nm, hits) VALUES (30, 'new', 1) "
            + "ON CONFLICT (id) DO UPDATE SET nm = EXCLUDED.nm WHERE v24_k.hits > 0");
        return !r.error && db.executeQuery("SELECT COUNT(*) AS c FROM v24_k WHERE id = 30").data[0].c === 1;
      });

      // ============================================================
      // 6. CREATE VIEW の列リスト
      // ============================================================
      fn('V24Vcl renames output columns', () => {
        db.executeQuery("CREATE TABLE v24_v (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("INSERT INTO v24_v VALUES (1,'x'),(2,'y')");
        const c = db.executeQuery("CREATE VIEW v24_vcl (uid, uname) AS SELECT id, nm FROM v24_v");
        const r = db.executeQuery("SELECT uid, uname FROM v24_vcl WHERE uid = 2");
        return !c.error && r.data[0].uid === 2 && r.data[0].uname === 'y';
      });
      push('V24Vcl stored definition carries the aliases', "SHOW CREATE VIEW v24_vcl",
        r => r.data[0].CreateView.includes('id AS uid') && r.data[0].CreateView.includes('nm AS uname'));
      fn('V24Vcl stays updatable', () => {
        const u = db.executeQuery("UPDATE v24_vcl SET uname = 'Z' WHERE uid = 2");
        return !u.error && db.executeQuery("SELECT nm FROM v24_v WHERE id = 2").data[0].nm === 'Z';
      });
      fn('V24Vcl works on expressions', () => {
        db.executeQuery("CREATE VIEW v24_vexp (dbl) AS SELECT id * 2 FROM v24_v");
        const r = db.executeQuery("SELECT dbl FROM v24_vexp WHERE dbl = 4");
        db.executeQuery("DROP VIEW v24_vexp");
        return r.data.length === 1 && r.data[0].dbl === 4;
      });
      err('V24Vcl arity mismatch rejected', "CREATE VIEW v24_vbad (a) AS SELECT id, nm FROM v24_v", "1 names but the query returns 2");
      err('V24Vcl star rejected', "CREATE VIEW v24_vbad2 (a, b) AS SELECT * FROM v24_v", "cannot be combined with SELECT *");
      fn('V24Vcl replaces an existing view', () => {
        const r = db.executeQuery("CREATE OR REPLACE VIEW v24_vcl (a, b) AS SELECT id, nm FROM v24_v");
        const q = db.executeQuery("SELECT a, b FROM v24_vcl WHERE a = 1");
        return !r.error && q.data[0].b === 'x';
      });

      // ============================================================
      // 7. DDL とメタデータの追加分
      // ============================================================
      fn('V24Ddl alter index rename', () => {
        db.executeQuery("CREATE INDEX v24_ix ON v24_v (nm)");
        const r = db.executeQuery("ALTER INDEX v24_ix RENAME TO v24_ix2");
        const shown = db.executeQuery("SHOW INDEXES FROM v24_v").data.some(d => d.Name === 'v24_ix2');
        return !r.error && shown;
      });
      err('V24Ddl alter index unknown', "ALTER INDEX v24_nope RENAME TO x", "not found");
      push('V24Ddl alter index if exists skips', "ALTER INDEX IF EXISTS v24_nope RENAME TO x", r => !r.error && r.data[0].Message.includes('Skipped'));
      fn('V24Ddl alter index name collision', () => {
        db.executeQuery("CREATE INDEX v24_ix3 ON v24_v (id)");
        const r = db.executeQuery("ALTER INDEX v24_ix3 RENAME TO v24_ix2");
        return r.error !== undefined && r.error.includes('already exists');
      });
      fn('V24Ddl show table status', () => {
        const r = db.executeQuery("SHOW TABLE STATUS");
        const row = r.data.find(d => d.Name === 'v24_v');
        return row && row.Rows === 2 && row.Columns === 2 && row.PrimaryKey === 'id';
      });
      fn('V24Ddl show table status like', () => {
        const r = db.executeQuery("SHOW TABLE STATUS LIKE 'v24\\_v'".replace('\\_', '_'));
        return r.data.length === 1 && r.data[0].Name === 'v24_v';
      });
      fn('V24Ddl show table status composite pk', () => {
        const r = db.executeQuery("SHOW TABLE STATUS LIKE 'v24_p'");
        return r.data[0].PrimaryKey === 'a, b';
      });
      fn('V24Ddl ctas with no data', () => {
        const r = db.executeQuery("CREATE TABLE v24_nd AS SELECT * FROM v24_v WITH NO DATA");
        const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM v24_nd").data[0].c;
        const cols = db.executeQuery("DESCRIBE v24_nd").data.length;
        return !r.error && cnt === 0 && cols === 2;
      });
      fn('V24Ddl ctas with data', () => {
        const r = db.executeQuery("CREATE TABLE v24_wd AS SELECT * FROM v24_v WITH DATA");
        return !r.error && db.executeQuery("SELECT COUNT(*) AS c FROM v24_wd").data[0].c === 2;
      });
      push('V24Ddl global temporary', "CREATE GLOBAL TEMPORARY TABLE v24_gt (a INTEGER)", r => !r.error);
      push('V24Ddl temp abbreviation', "CREATE TEMP TABLE v24_tt (a INTEGER)", r => !r.error);
      fn('V24Ddl temporary tables are not persisted', () => {
        const dump = db.exportForIDB();
        return dump.v24_gt === undefined && dump.v24_tt === undefined;
      });

      // ============================================================
      // 8. 集計の入れ子に対する診断
      // ============================================================
      err('V24Agg nested rejected', "SELECT MAX(SUM(age)) AS m FROM users GROUP BY id", "cannot be nested");
      err('V24Agg nested count rejected', "SELECT SUM(COUNT(*)) AS m FROM users GROUP BY id", "cannot be nested");
      push('V24Agg scalar around aggregate is fine', "SELECT ROUND(AVG(age), 1) AS a FROM users", r => Math.abs(r.data[0].a - 29.1) < 0.001);
      push('V24Agg aggregate arithmetic is fine', "SELECT SUM(age) / COUNT(*) AS a FROM users", r => Math.abs(r.data[0].a - 29.1) < 0.001);
      push('V24Agg case inside aggregate is fine', "SELECT SUM(CASE WHEN age > 25 THEN 1 ELSE 0 END) AS c FROM users", r => r.data[0].c === 7);
      push('V24Agg subquery rewrite works', "SELECT MAX(x) AS m FROM (SELECT SUM(age) AS x FROM users GROUP BY id) t", r => r.data[0].m === 40);

      // ============================================================
      // 9. フロントエンド: 結果グリッドの編集可否
      // ============================================================
      fn('V24Ed fixture', () => {
        db.executeQuery("CREATE TABLE v24_ui (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, salary INTEGER, dept TEXT)");
        db.executeQuery("INSERT INTO v24_ui (name, salary, dept) VALUES ('Alice',9200,'Eng'),('Bob',7100,'Eng'),('Carol',6800,'Sales')");
        renderTree();
        return true;
      });
      fn('V24Ed simple select is editable', () => {
        const c = db.analyzeEditableSelect("SELECT id, name, salary FROM v24_ui");
        return c.editable === true && c.table === 'v24_ui' && c.keyCols.join(',') === 'id';
      });
      fn('V24Ed order by and limit stay editable', () => {
        const c = db.analyzeEditableSelect("SELECT id, name FROM v24_ui ORDER BY name DESC LIMIT 2");
        return c.editable === true;
      });
      fn('V24Ed select star is editable', () => db.analyzeEditableSelect("SELECT * FROM v24_ui").editable === true);
      fn('V24Ed aliased columns map back', () => {
        const c = db.analyzeEditableSelect("SELECT id AS k, name AS n FROM v24_ui");
        return c.editable === true && c.keyCols.join(',') === 'k' && c.colMap.n === 'name';
      });
      fn('V24Ed group by is read-only', () => {
        const c = db.analyzeEditableSelect("SELECT dept, COUNT(*) AS n FROM v24_ui GROUP BY dept");
        return c.editable === false && c.reason.includes('GROUP BY');
      });
      fn('V24Ed join is read-only', () => {
        const c = db.analyzeEditableSelect("SELECT a.id FROM v24_ui a JOIN v24_ui b ON a.id = b.id");
        return c.editable === false && c.reason.includes('JOIN');
      });
      fn('V24Ed missing key is read-only', () => {
        const c = db.analyzeEditableSelect("SELECT name, salary FROM v24_ui");
        return c.editable === false && c.reason.includes('include id');
      });
      fn('V24Ed expression column is read-only', () => {
        const c = db.analyzeEditableSelect("SELECT id, salary * 2 AS dbl FROM v24_ui");
        return c.editable === false;
      });
      fn('V24Ed non select is read-only', () => db.analyzeEditableSelect("UPDATE v24_ui SET salary = 1").editable === false);
      fn('V24Ed keyless table is read-only', () => {
        db.executeQuery("CREATE TABLE v24_nokey (a INTEGER, b TEXT)");
        const c = db.analyzeEditableSelect("SELECT a, b FROM v24_nokey");
        db.executeQuery("DROP TABLE v24_nokey");
        return c.editable === false && c.reason.includes('no PRIMARY KEY');
      });
      fn('V24Ed composite pk needs all key columns', () => {
        const partial = db.analyzeEditableSelect("SELECT a FROM v24_p");
        const full = db.analyzeEditableSelect("SELECT a, b, nm FROM v24_p");
        return partial.editable === false && full.editable === true && full.keyCols.join(',') === 'a,b';
      });

      // ============================================================
      // 10. フロントエンド: セル編集の実挙動
      // ============================================================
      // 実際のグリッド操作を通す（dblclick -> 入力 -> Enter）
      const editCell = (r, c, value, key) => {
        const td = els.resArea.querySelector(`#resultsTbody td[data-r="${r}"][data-c="${c}"]`);
        if (!td) return { ok: false, why: 'cell not found' };
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = td.querySelector('input');
        if (!input) return { ok: false, why: 'editor did not open' };
        input.value = value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: key || 'Enter', bubbles: true }));
        return { ok: true };
      };
      const runGrid = (sql) => { setQueryValue(sql); document.getElementById('executeBtn').click(); };

      fn('V24Ce badge reflects editability', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        const editable = document.getElementById('editBadgeText').textContent;
        runGrid("SELECT dept, COUNT(*) AS n FROM v24_ui GROUP BY dept");
        const ro = document.getElementById('editBadgeText').textContent;
        return editable === 'Editable: v24_ui' && ro === 'Read-only';
      });
      fn('V24Ce commit writes to the base table', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        const e = editCell(0, 2, '9999');
        const dbVal = db.executeQuery("SELECT salary FROM v24_ui WHERE id = 1").data[0].salary;
        return e.ok && dbVal === 9999;
      });
      fn('V24Ce commit refreshes the grid', () => {
        const td = els.resArea.querySelector('#resultsTbody td[data-r="0"][data-c="2"]');
        return td.textContent === '9999';
      });
      fn('V24Ce escape cancels', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        editCell(1, 1, 'ZZZ', 'Escape');
        return db.executeQuery("SELECT name FROM v24_ui WHERE id = 2").data[0].name === 'Bob';
      });
      fn('V24Ce key column is not editable', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        const e = editCell(0, 0, '77');
        return e.ok === false && db.executeQuery("SELECT COUNT(*) AS c FROM v24_ui WHERE id = 1").data[0].c === 1;
      });
      fn('V24Ce constraint violation reverts', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        editCell(0, 1, '');   // name は NOT NULL
        return db.executeQuery("SELECT name FROM v24_ui WHERE id = 1").data[0].name === 'Alice';
      });
      // 入力値は必ずプレースホルダでバインドする。引用符やセミコロンを含む値が
      // SQL として解釈されないこと（結果グリッドは新しい書き込み経路なので必須）
      fn('V24Ce input is bound not concatenated', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        const payload = "O'Brien'; DROP TABLE v24_ui; --";
        editCell(2, 1, payload);
        const stored = db.executeQuery("SELECT name FROM v24_ui WHERE id = 3").data[0].name;
        return stored === payload && db.tables.v24_ui !== undefined;
      });
      fn('V24Ce numeric column keeps its type', () => {
        runGrid("SELECT id, name, salary FROM v24_ui ORDER BY id");
        editCell(1, 2, '1234');
        return db.executeQuery("SELECT salary FROM v24_ui WHERE id = 2").data[0].salary === 1234;
      });
      fn('V24Ce read-only grid ignores double click', () => {
        runGrid("SELECT dept, COUNT(*) AS n FROM v24_ui GROUP BY dept");
        const td = els.resArea.querySelector('#resultsTbody td[data-r="0"][data-c="0"]');
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return td.querySelector('input') === null;
      });

      // ============================================================
      // 11. フロントエンド: コピー書式とショートカット
      // ============================================================
      fn('V24Ex markdown table format', () => {
        const bku = currentResultData;
        currentResultData = [{ id: 1, nm: 'a|b' }, { id: 2, nm: null }];
        const md = resultToMarkdown(currentResultData);
        currentResultData = bku; renderDisplay(true);
        const lines = md.split('\n');
        return lines[0] === '| id | nm |' && lines[1] === '| --- | --- |'
            && lines[2] === '| 1 | a\\|b |' && lines[3] === '| 2 |  |';
      });
      fn('V24Ex markdown escapes newlines', () => {
        const md = resultToMarkdown([{ v: 'a\nb' }]);
        return md.split('\n')[2] === '| a<br>b |';
      });
      fn('V24Ex insert statements escape quotes', () => {
        const sqlText = resultToInserts([{ id: 1, nm: "O'Brien" }], 't');
        return sqlText === "INSERT INTO t (id, nm) VALUES (1, 'O''Brien');";
      });
      fn('V24Ex insert statements render types', () => {
        const sqlText = resultToInserts([{ a: null, b: true, c: 3.5 }], 't');
        return sqlText === "INSERT INTO t (a, b, c) VALUES (NULL, TRUE, 3.5);";
      });
      fn('V24Ex generated inserts round trip', () => {
        db.executeQuery("CREATE TABLE v24_rt (id INTEGER, nm TEXT)");
        const rows = [{ id: 1, nm: "quote ' and ; semi" }];
        const script = resultToInserts(rows, 'v24_rt');
        const res = db.executeScript(script);
        const got = db.executeQuery("SELECT nm FROM v24_rt").data[0].nm;
        db.executeQuery("DROP TABLE v24_rt");
        return res.succeeded === 1 && got === rows[0].nm;
      });
      fn('V24Ex copy buttons follow the result set', () => {
        setQueryValue("SELECT id FROM v24_ui");
        document.getElementById('executeBtn').click();
        const on = !document.getElementById('copyMdBtn').disabled && !document.getElementById('copyInsertBtn').disabled;
        setQueryValue("UPDATE v24_ui SET salary = salary WHERE 1 = 0");
        document.getElementById('executeBtn').click();
        const off = document.getElementById('copyMdBtn').disabled && document.getElementById('copyInsertBtn').disabled;
        return on && off;
      });
      fn('V24Ex shortcut modal opens and closes', () => {
        document.getElementById('openShortcutsBtn').click();
        const opened = !document.getElementById('shortcutModal').classList.contains('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const closed = document.getElementById('shortcutModal').classList.contains('hidden');
        return opened && closed;
      });
      fn('V24Ex question mark opens the shortcut modal', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
        const opened = !document.getElementById('shortcutModal').classList.contains('hidden');
        document.querySelector('#shortcutModal .closeModalBtn').click();
        return opened;
      });
      fn('V24Ex question mark ignored while typing', () => {
        els.query.focus();
        const ev = new KeyboardEvent('keydown', { key: '?', bubbles: true });
        els.query.dispatchEvent(ev);
        const stillClosed = document.getElementById('shortcutModal').classList.contains('hidden');
        return stillClosed;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V24Cl drop objects', () => {
        ['v24_vcl'].forEach(v => db.executeQuery(`DROP VIEW IF EXISTS ${v}`));
        ['v24_s', 'v24_s2', 'v24_s3', 'v24_s4', 'v24_s5', 'v24_idseq'].forEach(s => db.executeQuery(`DROP SEQUENCE IF EXISTS ${s}`));
        ['v24_ui', 'v24_wd', 'v24_nd', 'v24_gt', 'v24_tt', 'v24_v', 'v24_k', 'v24_bs', 'v24_sr', 'v24_tg',
         'v24_d5', 'v24_d4', 'v24_d3', 'v24_d2', 'v24_d1', 'v24_s2', 'v24_s1', 'v24_c3', 'v24_cu', 'v24_pu',
         'v24_c2', 'v24_c', 'v24_p'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
