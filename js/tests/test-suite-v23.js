    // ============================================================================
    // [Test Suite v23] - v1.18 で追加した商用DB互換機能のテスト
    //
    //   バックエンド:
    //     - CAST / CONVERT の桁指定付き型（DECIMAL(p,s) / VARCHAR(n) など）
    //     - 更新可能ビュー / WITH CHECK OPTION / INSTEAD OF トリガー
    //     - 列レベル REFERENCES（従来は黙って落ちていた外部キー宣言）
    //     - JSON アクセス演算子 (-> ->> #> #>> @> <@) と部分更新関数
    //     - IS [NOT] TRUE|FALSE
    //     - ALTER TABLE の名前付き制約 / DELETE・UPDATE のテーブル別名
    //     - 行コンストラクタ IN (SELECT ...)
    //     - CREATE INDEX の並び順・式キー / メタデータビュー / UNNEST(配列)
    //   フロントエンド:
    //     - 結果グリッドの絞り込み・セル詳細
    //     - スキーマツリーの展開とバッジ
    //     - トランザクション操作バー / カーソル位置の文の実行
    //
    //   test-suite.js の tests 配列へ getV23Tests() のスプレッドで合流する
    // ============================================================================
    function getV23Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      // 単一値を取り出す小さなヘルパ（fn テストの中で使う）
      const val = (sql) => { const r = db.executeQuery(sql); return r.error ? { __err: r.error } : Object.values(r.data[0])[0]; };

      // ============================================================
      // 1. CAST / CONVERT の桁指定付き型
      // ============================================================
      push('V23Cast decimal scale', "SELECT CAST(1.005 AS DECIMAL(10,2)) AS s", r => r.data[0].s === 1.01);
      push('V23Cast decimal half up', "SELECT CAST(2.675 AS DECIMAL(10,2)) AS s", r => r.data[0].s === 2.68);
      push('V23Cast decimal negative', "SELECT CAST(-1.005 AS DECIMAL(10,2)) AS s", r => r.data[0].s === -1.01);
      push('V23Cast decimal round to int', "SELECT CAST(1.9 AS DECIMAL(4)) AS s", r => r.data[0].s === 2);
      push('V23Cast decimal bare keeps value', "SELECT CAST(1.9 AS DECIMAL) AS s", r => r.data[0].s === 1.9);
      // 精度に収まらない値は NULL（式評価中の throw は行単位 catch に飲まれるため NULL で一貫させている）
      push('V23Cast decimal overflow null', "SELECT CAST(999 AS DECIMAL(4,2)) AS s", r => r.data[0].s === null);
      push('V23Cast numeric alias', "SELECT CAST(3.14159 AS NUMERIC(8,3)) AS s", r => r.data[0].s === 3.142);
      push('V23Cast varchar truncates', "SELECT CAST(12345 AS VARCHAR(3)) AS s", r => r.data[0].s === '123');
      push('V23Cast char truncates', "SELECT CAST('abcdef' AS CHAR(3)) AS s", r => r.data[0].s === 'abc');
      push('V23Cast varchar no truncate when short', "SELECT CAST('ab' AS VARCHAR(9)) AS s", r => r.data[0].s === 'ab');
      push('V23Cast bigint alias', "SELECT CAST(3.7 AS BIGINT) AS s", r => r.data[0].s === 3);
      push('V23Cast smallint alias', "SELECT CAST('42' AS SMALLINT) AS s", r => r.data[0].s === 42);
      push('V23Cast double precision', "SELECT CAST('1.25' AS DOUBLE PRECISION) AS s", r => r.data[0].s === 1.25);
      push('V23Cast time from timestamp', "SELECT CAST('2020-05-06 13:14:15' AS TIME) AS s", r => r.data[0].s === '13:14:15');
      push('V23Cast time from hhmm', "SELECT CAST('7:05' AS TIME) AS s", r => r.data[0].s === '07:05:00');
      push('V23Cast timestamp alias', "SELECT CAST('2020-05-06' AS TIMESTAMP) AS s", r => r.data[0].s === '2020-05-06 00:00:00');
      push('V23Cast convert mysql order', "SELECT CONVERT(3.14159, DECIMAL(5,1)) AS s", r => r.data[0].s === 3.1);
      push('V23Cast convert sqlserver order', "SELECT CONVERT(DECIMAL(5,1), 3.14159) AS s", r => r.data[0].s === 3.1);
      push('V23Cast try_cast bad value null', "SELECT TRY_CAST('zz' AS DECIMAL(5,2)) AS s", r => r.data[0].s === null);
      push('V23Cast pg operator with modifier', "SELECT 3.14159::numeric(6,2) AS s", r => r.data[0].s === 3.14);
      push('V23Cast inside aggregate', "SELECT SUM(CAST(age AS DECIMAL(10,2))) AS s FROM users", r => r.data[0].s === 291);
      push('V23Cast null stays null', "SELECT CAST(NULL AS DECIMAL(10,2)) AS s", r => r.data[0].s === null);
      push('V23Cast unknown type passthrough', "SELECT CAST(7 AS WIDGET) AS s", r => r.data[0].s === 7);

      // ============================================================
      // 2. IS [NOT] TRUE / FALSE
      // ============================================================
      push('V23Bool paren true', "SELECT 1 AS x WHERE (1=1) IS TRUE", r => r.data.length === 1);
      push('V23Bool paren false', "SELECT 1 AS x WHERE (1=2) IS FALSE", r => r.data.length === 1);
      push('V23Bool not true', "SELECT 1 AS x WHERE (1=2) IS NOT TRUE", r => r.data.length === 1);
      push('V23Bool not false', "SELECT 1 AS x WHERE (1=1) IS NOT FALSE", r => r.data.length === 1);
      // NULL(UNKNOWN) は TRUE でも FALSE でもない — 3値論理
      push('V23Bool null three valued',
        "SELECT (NULL) IS TRUE AS a, (NULL) IS FALSE AS b, (NULL) IS NOT TRUE AS c, (NULL) IS NOT FALSE AS d",
        r => r.data[0].a === false && r.data[0].b === false && r.data[0].c === true && r.data[0].d === true);
      push('V23Bool on column predicate', "SELECT COUNT(*) AS c FROM users WHERE (age > 30) IS TRUE", r => r.data[0].c === 3);
      push('V23Bool on column predicate negated', "SELECT COUNT(*) AS c FROM users WHERE (age > 30) IS NOT TRUE", r => r.data[0].c === 7);
      push('V23Bool nested parens', "SELECT COUNT(*) AS c FROM users WHERE ((age > 1) AND (age < 1000)) IS TRUE", r => r.data[0].c === 10);
      push('V23Bool combined with AND', "SELECT COUNT(*) AS c FROM users WHERE (age > 30) IS TRUE AND id > 0", r => r.data[0].c === 3);

      // ============================================================
      // 3. JSON アクセス演算子と部分更新
      // ============================================================
      push('V23Json arrow object', `SELECT '{"a":{"b":2}}' -> 'a' AS v`, r => r.data[0].v === '{"b":2}');
      push('V23Json arrow text', `SELECT '{"a":1}' ->> 'a' AS v`, r => r.data[0].v === '1');
      push('V23Json arrow chain', `SELECT '{"a":{"b":7}}' -> 'a' ->> 'b' AS v`, r => r.data[0].v === '7');
      push('V23Json arrow array index', `SELECT '[10,20,30]' ->> 1 AS v`, r => r.data[0].v === '20');
      push('V23Json arrow missing key null', `SELECT '{"a":1}' ->> 'zz' AS v`, r => r.data[0].v === null);
      push('V23Json arrow dollar path', `SELECT '{"a":{"b":5}}' ->> '$.a.b' AS v`, r => r.data[0].v === '5');
      push('V23Json hash arrow', `SELECT '{"a":{"b":2}}' #> '{a,b}' AS v`, r => r.data[0].v === '2');
      push('V23Json hash arrow text', `SELECT '{"a":{"b":"z"}}' #>> '{a,b}' AS v`, r => r.data[0].v === 'z');
      push('V23Json hash arrow json array path', `SELECT '{"a":[9,8]}' #>> '["a",1]' AS v`, r => r.data[0].v === '8');
      push('V23Json contains op', `SELECT ('{"a":1,"b":2}' @> '{"a":1}') AS v`, r => r.data[0].v === true);
      push('V23Json contains op false', `SELECT ('{"a":1}' @> '{"a":9}') AS v`, r => r.data[0].v === false);
      push('V23Json contained op', `SELECT ('{"a":1}' <@ '{"a":1,"b":2}') AS v`, r => r.data[0].v === true);
      push('V23Json arrow in where', `SELECT COUNT(*) AS c FROM users WHERE ('{"k":"x"}' ->> 'k') = 'x' AND id = 1`, r => r.data[0].c === 1);
      push('V23Json insert adds missing', `SELECT JSON_INSERT('{"a":1}', '$.b', 2) AS v`, r => r.data[0].v === '{"a":1,"b":2}');
      push('V23Json insert keeps existing', `SELECT JSON_INSERT('{"a":1}', '$.a', 9) AS v`, r => r.data[0].v === '{"a":1}');
      push('V23Json replace existing', `SELECT JSON_REPLACE('{"a":1}', '$.a', 5) AS v`, r => r.data[0].v === '{"a":5}');
      push('V23Json replace skips missing', `SELECT JSON_REPLACE('{"a":1}', '$.z', 5) AS v`, r => r.data[0].v === '{"a":1}');
      push('V23Json array insert', `SELECT JSON_ARRAY_INSERT('[1,2]', '$[0]', 9) AS v`, r => r.data[0].v === '[9,1,2]');
      push('V23Json array insert past end appends', `SELECT JSON_ARRAY_INSERT('[1,2]', '$[9]', 3) AS v`, r => r.data[0].v === '[1,2,3]');
      push('V23Json contains path one', `SELECT JSON_CONTAINS_PATH('{"a":1}', 'one', '$.a', '$.z') AS v`, r => r.data[0].v === 1);
      push('V23Json contains path all', `SELECT JSON_CONTAINS_PATH('{"a":1}', 'all', '$.a', '$.z') AS v`, r => r.data[0].v === 0);
      // プロトタイプ汚染ガードは部分更新でも効く
      fn('V23Json insert proto guard', () => {
        const r = db.executeQuery(`SELECT JSON_INSERT('{}', '$.__proto__.x', 1) AS v`);
        return (r.error !== undefined || r.data[0].v === null) && ({}).x === undefined;
      });

      // ============================================================
      // 4. 列レベル REFERENCES（従来は黙って外部キーが消えていた）
      // ============================================================
      fn('V23Ref inline references enforced', () => {
        db.executeQuery("CREATE TABLE v23_p (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("INSERT INTO v23_p (id, nm) VALUES (1, 'a')");
        const c = db.executeQuery("CREATE TABLE v23_c (id INTEGER, pid INTEGER REFERENCES v23_p(id))");
        const bad = db.executeQuery("INSERT INTO v23_c (id, pid) VALUES (1, 99)");
        const good = db.executeQuery("INSERT INTO v23_c (id, pid) VALUES (1, 1)");
        return !c.error && bad.error !== undefined && bad.error.includes('Foreign key') && !good.error;
      });
      fn('V23Ref inline shows in DDL', () => {
        const r = db.executeQuery("SHOW CREATE TABLE v23_c");
        return r.data[0].CreateTable.includes('FOREIGN KEY (pid) REFERENCES v23_p(id)');
      });
      fn('V23Ref inline shows in DESCRIBE', () => {
        const r = db.executeQuery("DESCRIBE v23_c");
        return r.data.some(d => d.Column === 'pid' && d.ForeignKey === 'v23_p(id)');
      });
      fn('V23Ref omitted column resolves to PK', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_c2");
        const c = db.executeQuery("CREATE TABLE v23_c2 (id INTEGER, pid INTEGER REFERENCES v23_p)");
        const fk = db.tables.v23_c2.foreignKeys[0];
        return !c.error && fk && fk.refTable === 'v23_p' && fk.refCol === 'id';
      });
      fn('V23Ref inline on delete cascade', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_c3");
        db.executeQuery("CREATE TABLE v23_pp (id INTEGER PRIMARY KEY)");
        db.executeQuery("INSERT INTO v23_pp (id) VALUES (1), (2)");
        db.executeQuery("CREATE TABLE v23_c3 (id INTEGER, pid INTEGER REFERENCES v23_pp(id) ON DELETE CASCADE)");
        db.executeQuery("INSERT INTO v23_c3 (id, pid) VALUES (10, 1), (11, 2)");
        db.executeQuery("DELETE FROM v23_pp WHERE id = 1");
        const left = db.executeQuery("SELECT COUNT(*) AS c FROM v23_c3");
        return left.data[0].c === 1;
      });
      fn('V23Ref inline with NOT NULL both apply', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_c4");
        db.executeQuery("CREATE TABLE v23_c4 (id INTEGER, pid INTEGER NOT NULL REFERENCES v23_p(id))");
        const t = db.tables.v23_c4;
        return t.notNullCols.includes('pid') && t.foreignKeys.length === 1;
      });
      fn('V23Ref deferrable clause accepted and ignored', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_c5");
        const r = db.executeQuery("CREATE TABLE v23_c5 (id INTEGER, pid INTEGER REFERENCES v23_p(id) DEFERRABLE INITIALLY DEFERRED)");
        return !r.error && db.tables.v23_c5.foreignKeys.length === 1;
      });
      fn('V23Ref on update current_timestamp not confused with FK action', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_c6");
        const r = db.executeQuery("CREATE TABLE v23_c6 (t TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, pid INTEGER REFERENCES v23_p(id) ON UPDATE CASCADE)");
        const t = db.tables.v23_c6;
        return !r.error && t.onUpdateNowCols.includes('t') && t.foreignKeys[0].onUpdate === 'CASCADE';
      });
      err('V23Ref unknown ref table rejected', "CREATE TABLE v23_bad (id INTEGER, pid INTEGER REFERENCES v23_nope(id))", "not found");
      err('V23Ref unknown ref column rejected', "CREATE TABLE v23_bad2 (id INTEGER, pid INTEGER REFERENCES v23_p(zzz))", "not found");
      fn('V23Ref self reference still works', () => {
        db.executeQuery("DROP TABLE IF EXISTS v23_self");
        const c = db.executeQuery("CREATE TABLE v23_self (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES v23_self(id))");
        const ok1 = db.executeQuery("INSERT INTO v23_self (id, pid) VALUES (1, NULL)");
        const bad = db.executeQuery("INSERT INTO v23_self (id, pid) VALUES (2, 99)");
        db.executeQuery("DROP TABLE v23_self");
        return !c.error && !ok1.error && bad.error !== undefined;
      });
      fn('V23Ref referential_constraints view', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.referential_constraints WHERE table_name = 'v23_c3'");
        return r.data.length === 1 && r.data[0].delete_rule === 'CASCADE' && r.data[0].referenced_table_name === 'v23_pp';
      });

      // ============================================================
      // 5. 更新可能ビュー
      // ============================================================
      fn('V23Vw fixture', () => {
        db.executeQuery("CREATE TABLE v23_emp (id INTEGER PRIMARY KEY, nm TEXT, sal INTEGER, dept TEXT)");
        db.executeQuery("INSERT INTO v23_emp VALUES (1,'a',100,'X'),(2,'b',200,'X'),(3,'c',300,'Y')");
        return !db.executeQuery("CREATE VIEW v23_vx AS SELECT id, nm, sal FROM v23_emp WHERE dept = 'X'").error;
      });
      push('V23Vw insert through view', "INSERT INTO v23_vx (id, nm, sal) VALUES (10, 'v', 50)", r => !r.error);
      // ビューに無い列は既定値のまま（dept は NULL になるのでこの行はビューから外れる）
      push('V23Vw insert reached base table', "SELECT nm, dept FROM v23_emp WHERE id = 10", r => r.data[0].nm === 'v' && r.data[0].dept === null);
      push('V23Vw insert row outside view', "SELECT COUNT(*) AS c FROM v23_vx WHERE id = 10", r => r.data[0].c === 0);
      push('V23Vw update through view', "UPDATE v23_vx SET sal = 111 WHERE id = 1", r => !r.error && r.data[0].Message.startsWith('1 rows'));
      push('V23Vw update reached base table', "SELECT sal FROM v23_emp WHERE id = 1", r => r.data[0].sal === 111);
      // ビューの WHERE の外にある行は更新対象にならない
      push('V23Vw update skips rows outside view', "UPDATE v23_vx SET sal = 999 WHERE id = 3", r => r.data[0].Message.startsWith('0 rows'));
      push('V23Vw row outside view unchanged', "SELECT sal FROM v23_emp WHERE id = 3", r => r.data[0].sal === 300);
      push('V23Vw delete through view', "DELETE FROM v23_vx WHERE id = 2", r => !r.error && r.data[0].Message.startsWith('1 rows'));
      push('V23Vw delete reached base table', "SELECT COUNT(*) AS c FROM v23_emp WHERE id = 2", r => r.data[0].c === 0);
      push('V23Vw delete skips rows outside view', "DELETE FROM v23_vx WHERE id = 3", r => r.data[0].Message.startsWith('0 rows'));

      fn('V23Vw aliased view columns map to base', () => {
        db.executeQuery("CREATE VIEW v23_va AS SELECT e.id AS eid, e.nm AS ename, e.sal AS pay FROM v23_emp e WHERE e.sal > 50");
        const u = db.executeQuery("UPDATE v23_va SET ename = 'zz' WHERE eid = 1");
        const got = db.executeQuery("SELECT nm FROM v23_emp WHERE id = 1");
        return !u.error && got.data[0].nm === 'zz';
      });
      fn('V23Vw aliased rhs expression maps too', () => {
        const u = db.executeQuery("UPDATE v23_va SET pay = pay + 5 WHERE v23_va.eid = 1");
        const got = db.executeQuery("SELECT sal FROM v23_emp WHERE id = 1");
        return !u.error && got.data[0].sal === 116;
      });
      fn('V23Vw insert with aliased columns', () => {
        const i = db.executeQuery("INSERT INTO v23_va (eid, ename, pay) VALUES (7, 'g', 70)");
        const got = db.executeQuery("SELECT nm, sal FROM v23_emp WHERE id = 7");
        return !i.error && got.data[0].nm === 'g' && got.data[0].sal === 70;
      });
      fn('V23Vw delete with aliased column', () => {
        const d = db.executeQuery("DELETE FROM v23_va WHERE ename = 'g'");
        const got = db.executeQuery("SELECT COUNT(*) AS c FROM v23_emp WHERE id = 7");
        return !d.error && got.data[0].c === 0;
      });
      fn('V23Vw select-star view is updatable', () => {
        db.executeQuery("CREATE VIEW v23_vs AS SELECT * FROM v23_emp WHERE dept = 'Y'");
        const u = db.executeQuery("UPDATE v23_vs SET sal = 301 WHERE id = 3");
        const got = db.executeQuery("SELECT sal FROM v23_emp WHERE id = 3");
        db.executeQuery("DROP VIEW v23_vs");
        return !u.error && got.data[0].sal === 301;
      });
      fn('V23Vw view without where is updatable', () => {
        db.executeQuery("CREATE VIEW v23_vn AS SELECT id, sal FROM v23_emp");
        const u = db.executeQuery("UPDATE v23_vn SET sal = sal WHERE id = 3");
        db.executeQuery("DROP VIEW v23_vn");
        return !u.error && u.data[0].Message.startsWith('1 rows');
      });
      fn('V23Vw order by does not block updatability', () => {
        db.executeQuery("CREATE VIEW v23_vo AS SELECT id, sal FROM v23_emp ORDER BY sal DESC");
        const ok = db.executeQuery("SELECT * FROM information_schema.views WHERE table_name = 'v23_vo'");
        db.executeQuery("DROP VIEW v23_vo");
        return ok.data[0].is_updatable === 'YES';
      });
      // 更新不可な形は理由付きで拒否する
      fn('V23Vw aggregate view rejected', () => {
        db.executeQuery("CREATE VIEW v23_vagg AS SELECT dept, COUNT(*) AS n FROM v23_emp GROUP BY dept");
        const r = db.executeQuery("INSERT INTO v23_vagg (dept, n) VALUES ('Z', 1)");
        return r.error !== undefined && r.error.includes('not updatable') && r.error.includes('GROUP BY');
      });
      fn('V23Vw distinct view rejected', () => {
        db.executeQuery("CREATE VIEW v23_vd AS SELECT DISTINCT dept FROM v23_emp");
        const r = db.executeQuery("UPDATE v23_vd SET dept = 'Q'");
        db.executeQuery("DROP VIEW v23_vd");
        return r.error !== undefined && r.error.includes('DISTINCT');
      });
      fn('V23Vw join view rejected', () => {
        db.executeQuery("CREATE VIEW v23_vj AS SELECT e.id AS a, o.order_id AS b FROM v23_emp e JOIN orders o ON e.id = o.user_id");
        const r = db.executeQuery("DELETE FROM v23_vj WHERE a = 1");
        db.executeQuery("DROP VIEW v23_vj");
        return r.error !== undefined && r.error.includes('JOIN');
      });
      fn('V23Vw expression column rejected', () => {
        db.executeQuery("CREATE VIEW v23_ve AS SELECT id, sal * 2 AS dbl FROM v23_emp");
        const r = db.executeQuery("UPDATE v23_ve SET dbl = 5 WHERE id = 1");
        db.executeQuery("DROP VIEW v23_ve");
        return r.error !== undefined && r.error.includes('not updatable');
      });
      fn('V23Vw nested view rejected', () => {
        db.executeQuery("CREATE VIEW v23_vnest AS SELECT id, sal FROM v23_vx");
        const r = db.executeQuery("UPDATE v23_vnest SET sal = 1 WHERE id = 1");
        db.executeQuery("DROP VIEW v23_vnest");
        return r.error !== undefined && r.error.includes('nested views');
      });
      err('V23Vw unknown view column rejected', "UPDATE v23_vx SET nope = 1", "not found");
      fn('V23Vw is_updatable reported in metadata', () => {
        const r = db.executeQuery("SELECT table_name, is_updatable FROM information_schema.views WHERE table_name IN ('v23_vx', 'v23_vagg')");
        const m = {}; r.data.forEach(d => { m[d.table_name] = d.is_updatable; });
        return m.v23_vx === 'YES' && m.v23_vagg === 'NO';
      });

      // ============================================================
      // 6. WITH CHECK OPTION
      // ============================================================
      fn('V23Chk create with check option', () => {
        const r = db.executeQuery("CREATE VIEW v23_vck AS SELECT id, nm, sal, dept FROM v23_emp WHERE dept = 'X' WITH CHECK OPTION");
        return !r.error && db.viewMeta.v23_vck && db.viewMeta.v23_vck.checkOption === 'CASCADED';
      });
      fn('V23Chk insert inside view allowed', () => {
        const r = db.executeQuery("INSERT INTO v23_vck (id, nm, sal, dept) VALUES (20, 'ok', 1, 'X')");
        const got = db.executeQuery("SELECT COUNT(*) AS c FROM v23_emp WHERE id = 20");
        return !r.error && got.data[0].c === 1;
      });
      fn('V23Chk insert outside view rejected and rolled back', () => {
        const r = db.executeQuery("INSERT INTO v23_vck (id, nm, sal, dept) VALUES (21, 'bad', 1, 'Q')");
        const got = db.executeQuery("SELECT COUNT(*) AS c FROM v23_emp WHERE id = 21");
        return r.error !== undefined && r.error.includes('CHECK OPTION') && got.data[0].c === 0;
      });
      fn('V23Chk update out of view rejected and rolled back', () => {
        const r = db.executeQuery("UPDATE v23_vck SET dept = 'Q' WHERE id = 20");
        const got = db.executeQuery("SELECT dept FROM v23_emp WHERE id = 20");
        return r.error !== undefined && r.error.includes('CHECK OPTION') && got.data[0].dept === 'X';
      });
      fn('V23Chk update inside view allowed', () => {
        const r = db.executeQuery("UPDATE v23_vck SET sal = 42 WHERE id = 20");
        const got = db.executeQuery("SELECT sal FROM v23_emp WHERE id = 20");
        return !r.error && got.data[0].sal === 42;
      });
      fn('V23Chk delete never violates check option', () => {
        const r = db.executeQuery("DELETE FROM v23_vck WHERE id = 20");
        return !r.error && r.data[0].Message.startsWith('1 rows');
      });
      fn('V23Chk local keyword accepted', () => {
        db.executeQuery("CREATE VIEW v23_vckl AS SELECT id FROM v23_emp WHERE id > 0 WITH LOCAL CHECK OPTION");
        const ok = db.viewMeta.v23_vckl.checkOption === 'LOCAL';
        db.executeQuery("DROP VIEW v23_vckl");
        return ok;
      });
      fn('V23Chk shown in SHOW CREATE VIEW', () => {
        const r = db.executeQuery("SHOW CREATE VIEW v23_vck");
        return r.data[0].CreateView.includes('WITH CASCADED CHECK OPTION');
      });
      fn('V23Chk shown in exportSQL', () => db.exportSQL().includes('CREATE VIEW v23_vck AS') && db.exportSQL().includes('CHECK OPTION'));
      fn('V23Chk metadata check_option column', () => {
        const r = db.executeQuery("SELECT check_option FROM information_schema.views WHERE table_name = 'v23_vck'");
        return r.data[0].check_option === 'CASCADED';
      });
      fn('V23Chk dropped with the view', () => {
        db.executeQuery("CREATE VIEW v23_vtmp AS SELECT id FROM v23_emp WHERE id > 0 WITH CHECK OPTION");
        db.executeQuery("DROP VIEW v23_vtmp");
        return db.viewMeta.v23_vtmp === undefined;
      });
      fn('V23Chk survives IDB round trip', () => {
        const dump = db.exportForIDB();
        const e2 = new DatabaseEngine();
        e2.importFromIDB(dump);
        return e2.viewMeta.v23_vck && e2.viewMeta.v23_vck.checkOption === 'CASCADED';
      });

      // ============================================================
      // 7. INSTEAD OF トリガー
      // ============================================================
      fn('V23Io fixture', () => {
        db.executeQuery("CREATE TABLE v23_ord (id INTEGER PRIMARY KEY, qty INTEGER, note TEXT)");
        db.executeQuery("CREATE TABLE v23_audit (act TEXT, oid INTEGER)");
        db.executeQuery("INSERT INTO v23_ord VALUES (1,5,'a'),(2,7,'b')");
        return !db.executeQuery("CREATE VIEW v23_vsum AS SELECT note, SUM(qty) AS total FROM v23_ord GROUP BY note").error;
      });
      err('V23Io aggregate view not writable without trigger', "INSERT INTO v23_vsum (note, total) VALUES ('c', 9)", "not updatable");
      push('V23Io create instead of insert',
        "CREATE TRIGGER v23_tgi INSTEAD OF INSERT ON v23_vsum FOR EACH ROW INSERT INTO v23_ord (id, qty, note) VALUES (99, NEW.total, NEW.note)",
        r => !r.error && r.data[0].Message.includes('INSTEAD OF INSERT'));
      fn('V23Io insert routed to trigger', () => {
        const r = db.executeQuery("INSERT INTO v23_vsum (note, total) VALUES ('c', 9)");
        const got = db.executeQuery("SELECT qty, note FROM v23_ord WHERE id = 99");
        return !r.error && r.data[0].Message.includes('INSTEAD OF') && got.data[0].qty === 9 && got.data[0].note === 'c';
      });
      fn('V23Io update routed with computed NEW', () => {
        db.executeQuery("CREATE TRIGGER v23_tgu INSTEAD OF UPDATE ON v23_vsum FOR EACH ROW INSERT INTO v23_audit (act, oid) VALUES ('upd', NEW.total)");
        const r = db.executeQuery("UPDATE v23_vsum SET total = total * 2 WHERE note = 'a'");
        const got = db.executeQuery("SELECT act, oid FROM v23_audit");
        return !r.error && got.data.length === 1 && got.data[0].act === 'upd' && got.data[0].oid === 10;
      });
      fn('V23Io delete routed with OLD', () => {
        db.executeQuery("CREATE TRIGGER v23_tgd INSTEAD OF DELETE ON v23_vsum FOR EACH ROW DELETE FROM v23_ord WHERE note = OLD.note");
        const r = db.executeQuery("DELETE FROM v23_vsum WHERE note = 'b'");
        const got = db.executeQuery("SELECT COUNT(*) AS c FROM v23_ord WHERE note = 'b'");
        return !r.error && got.data[0].c === 0;
      });
      fn('V23Io no matching rows fires nothing', () => {
        const before = db.executeQuery("SELECT COUNT(*) AS c FROM v23_audit").data[0].c;
        const r = db.executeQuery("UPDATE v23_vsum SET total = 1 WHERE note = 'zzz'");
        const after = db.executeQuery("SELECT COUNT(*) AS c FROM v23_audit").data[0].c;
        return !r.error && r.data[0].Message.startsWith('0 rows') && before === after;
      });
      err('V23Io instead of on table rejected',
        "CREATE TRIGGER v23_tgbad INSTEAD OF INSERT ON v23_ord FOR EACH ROW INSERT INTO v23_audit (act) VALUES ('x')",
        "only be created on views");
      err('V23Io before trigger on view rejected',
        "CREATE TRIGGER v23_tgbad2 BEFORE INSERT ON v23_vsum FOR EACH ROW INSERT INTO v23_audit (act) VALUES ('x')",
        "INSTEAD OF");
      // SHOW の FROM はメタデータの対象指定なので、ビュー展開に巻き込まれてはいけない
      // （以前は SELECT へ書き換わって対象が特定できず、静かに空を返していた）
      fn('V23Io listed in SHOW TRIGGERS', () => {
        const r = db.executeQuery("SHOW TRIGGERS FROM v23_vsum");
        return r.data.length === 3 && r.data.every(d => d.Timing === 'INSTEAD OF');
      });
      // ビュー宛の SHOW COLUMNS は（DESCRIBE と同じく）ビュー定義を返す仕様。
      // 以前はビュー展開で対象名が消え、黙って空を返していた
      fn('V23Io SHOW COLUMNS resolves a view', () => {
        const r = db.executeQuery("SHOW COLUMNS FROM v23_vsum");
        return !r.error && r.data.length === 1 && r.data[0].View === 'v23_vsum'
            && r.data[0].Definition.toLowerCase().includes('sum(qty)');
      });
      err('V23Io SHOW TRIGGERS FROM unknown name', "SHOW TRIGGERS FROM v23_nosuch", "not found");
      fn('V23Io listed in information_schema.triggers', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.triggers WHERE trigger_name = 'v23_tgi'");
        return r.data.length === 1 && r.data[0].action_timing === 'INSTEAD OF' && r.data[0].event_object_table === 'v23_vsum';
      });

      // ============================================================
      // 8. ALTER TABLE の名前付き制約
      // ============================================================
      fn('V23Cn fixture', () => {
        db.executeQuery("CREATE TABLE v23_d (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("CREATE TABLE v23_e (id INTEGER, dept_id INTEGER, em TEXT)");
        db.executeQuery("INSERT INTO v23_d VALUES (1, 'A')");
        db.executeQuery("INSERT INTO v23_e VALUES (1, 1, 'x')");
        return true;
      });
      push('V23Cn add named fk', "ALTER TABLE v23_e ADD CONSTRAINT v23_fk FOREIGN KEY (dept_id) REFERENCES v23_d(id) ON DELETE CASCADE", r => !r.error);
      err('V23Cn named fk enforced', "INSERT INTO v23_e VALUES (2, 99, 'y')", "Foreign key");
      push('V23Cn add named unique', "ALTER TABLE v23_e ADD CONSTRAINT v23_uq UNIQUE (em)", r => !r.error);
      err('V23Cn named unique enforced', "INSERT INTO v23_e VALUES (3, 1, 'x')", "UNIQUE");
      push('V23Cn add named pk', "ALTER TABLE v23_e ADD CONSTRAINT v23_pk PRIMARY KEY (id)", r => !r.error);
      err('V23Cn duplicate constraint name rejected', "ALTER TABLE v23_e ADD CONSTRAINT v23_uq UNIQUE (dept_id)", "already exists");
      // 名前が衝突した ADD は制約本体を残さない（部分適用しない）
      fn('V23Cn rejected add leaves no partial constraint', () => !db.tables.v23_e.uniqueCols.includes('dept_id'));
      fn('V23Cn drop named unique', () => {
        const r = db.executeQuery("ALTER TABLE v23_e DROP CONSTRAINT v23_uq");
        const dup = db.executeQuery("INSERT INTO v23_e VALUES (3, 1, 'x')");
        return !r.error && r.data[0].Message.includes('UNIQUE') && !dup.error;
      });
      fn('V23Cn drop named fk', () => {
        const r = db.executeQuery("ALTER TABLE v23_e DROP CONSTRAINT v23_fk");
        const orphan = db.executeQuery("INSERT INTO v23_e VALUES (4, 99, 'z')");
        return !r.error && r.data[0].Message.includes('FOREIGN KEY') && !orphan.error;
      });
      err('V23Cn drop unknown constraint', "ALTER TABLE v23_e DROP CONSTRAINT v23_nope", "not found");
      fn('V23Cn drop foreign key by name', () => {
        // FK を張り直す前に、参照先に無い値を持つ行（前のテストで入れた dept_id = 99）を消す
        db.executeQuery("DELETE FROM v23_e WHERE dept_id = 99");
        const a = db.executeQuery("ALTER TABLE v23_e ADD CONSTRAINT v23_fk2 FOREIGN KEY (dept_id) REFERENCES v23_d(id)");
        const r = db.executeQuery("ALTER TABLE v23_e DROP FOREIGN KEY v23_fk2");
        return !a.error && !r.error && db.tables.v23_e.foreignKeys.length === 0;
      });
      fn('V23Cn drop check is check-only', () => {
        db.executeQuery("ALTER TABLE v23_e ADD CONSTRAINT v23_uq2 UNIQUE (em)");
        const r = db.executeQuery("ALTER TABLE v23_e DROP CHECK v23_uq2");
        db.executeQuery("ALTER TABLE v23_e DROP CONSTRAINT v23_uq2");
        return r.error !== undefined;
      });
      fn('V23Cn named check still works', () => {
        const a = db.executeQuery("ALTER TABLE v23_e ADD CONSTRAINT v23_ck CHECK (id >= 0)");
        const d = db.executeQuery("ALTER TABLE v23_e DROP CONSTRAINT v23_ck");
        return !a.error && !d.error && d.data[0].Message.includes('CHECK');
      });
      fn('V23Cn names survive IDB round trip', () => {
        // 既存データの重複に左右されないよう専用テーブルで検証する
        db.executeQuery("CREATE TABLE v23_cn (id INTEGER, em TEXT)");
        const a = db.executeQuery("ALTER TABLE v23_cn ADD CONSTRAINT v23_keep UNIQUE (em)");
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        const entry = e2.tables.v23_cn.constraintNames.v23_keep;
        db.executeQuery("DROP TABLE v23_cn");
        return !a.error && entry !== undefined && entry.kind === 'unique' && entry.cols[0] === 'em';
      });

      // ============================================================
      // 9. DELETE / UPDATE のテーブル別名と行コンストラクタ IN
      // ============================================================
      fn('V23Al fixture', () => {
        db.executeQuery("CREATE TABLE v23_al (id INTEGER, dept_id INTEGER, nm TEXT, sal INTEGER)");
        db.executeQuery("INSERT INTO v23_al VALUES (1,1,'x',100),(2,1,'y',200),(3,2,'z',300)");
        return true;
      });
      push('V23Al delete with alias', "DELETE FROM v23_al e WHERE e.id = 3", r => !r.error && r.data[0].Message.startsWith('1 rows'));
      push('V23Al delete with AS alias', "DELETE FROM v23_al AS e WHERE e.sal > 5000", r => !r.error && r.data[0].Message.startsWith('0 rows'));
      push('V23Al delete without alias unaffected', "DELETE FROM v23_al WHERE id = 999", r => !r.error);
      push('V23Al update with alias', "UPDATE v23_al e SET e.sal = e.sal + 1 WHERE e.id = 1", r => !r.error && r.data[0].Message.startsWith('1 rows'));
      push('V23Al update alias applied', "SELECT sal FROM v23_al WHERE id = 1", r => r.data[0].sal === 101);
      push('V23Al update AS alias unqualified set', "UPDATE v23_al AS e SET sal = 999 WHERE e.nm = 'y'", r => !r.error);
      push('V23Al update AS alias applied', "SELECT sal FROM v23_al WHERE id = 2", r => r.data[0].sal === 999);
      err('V23Al unknown qualifier in SET rejected', "UPDATE v23_al e SET zz.sal = 1 WHERE e.id = 1", "qualifier");
      push('V23Al row ctor in subquery', "SELECT COUNT(*) AS c FROM v23_al WHERE (dept_id, sal) IN (SELECT dept_id, sal FROM v23_al)", r => r.data[0].c === 2);
      push('V23Al row ctor in subquery filtered', "SELECT COUNT(*) AS c FROM v23_al WHERE (dept_id, sal) IN (SELECT dept_id, sal FROM v23_al WHERE sal > 500)", r => r.data[0].c === 1);
      push('V23Al row ctor not in subquery', "SELECT COUNT(*) AS c FROM v23_al WHERE (dept_id, nm) NOT IN (SELECT dept_id, nm FROM v23_al WHERE nm = 'x')", r => r.data[0].c === 1);
      push('V23Al single col in subquery unaffected', "SELECT COUNT(*) AS c FROM v23_al WHERE dept_id IN (SELECT dept_id FROM v23_al)", r => r.data[0].c === 2);
      err('V23Al row ctor arity mismatch', "SELECT COUNT(*) AS c FROM v23_al WHERE (dept_id, sal) IN (SELECT dept_id FROM v23_al)", "arity");
      push('V23Al row ctor empty subquery', "SELECT COUNT(*) AS c FROM v23_al WHERE (dept_id, sal) IN (SELECT dept_id, sal FROM v23_al WHERE 1=0)", r => r.data[0].c === 0);

      // ============================================================
      // 10. CREATE INDEX の並び順・式キーとメタデータビュー
      // ============================================================
      fn('V23Ix fixture', () => {
        db.executeQuery("CREATE TABLE v23_ix (id INTEGER PRIMARY KEY, nm TEXT, sal INTEGER)");
        db.executeQuery("INSERT INTO v23_ix VALUES (1,'a',10),(2,'b',20)");
        return true;
      });
      push('V23Ix desc key', "CREATE INDEX v23_ixd ON v23_ix (sal DESC)", r => !r.error && r.data[0].Message.includes('sal DESC'));
      push('V23Ix asc nulls last', "CREATE INDEX v23_ixn ON v23_ix (nm ASC NULLS LAST)", r => !r.error && r.data[0].Message.includes('NULLS LAST'));
      push('V23Ix expression key', "CREATE INDEX v23_ixe ON v23_ix (LOWER(nm))", r => !r.error && r.data[0].Message.includes('metadata only'));
      err('V23Ix expression key validates columns', "CREATE INDEX v23_ixbad ON v23_ix (LOWER(nope))", "not found");
      push('V23Ix multi col with directions', "CREATE INDEX v23_ixm ON v23_ix (sal DESC, nm ASC)", r => !r.error);
      fn('V23Ix show index alias', () => {
        const a = db.executeQuery("SHOW INDEX FROM v23_ix");
        const b = db.executeQuery("SHOW KEYS FROM v23_ix");
        const c = db.executeQuery("SHOW INDEXES FROM v23_ix");
        return !a.error && !b.error && !c.error && a.data.length === c.data.length && b.data.length === c.data.length;
      });
      fn('V23Ix show index reports direction and expression', () => {
        const r = db.executeQuery("SHOW INDEXES FROM v23_ix");
        const hasDesc = r.data.some(d => d.Column === 'sal' && d.Direction === 'DESC');
        const hasExpr = r.data.some(d => d.Expression === 'LOWER(nm)');
        return hasDesc && hasExpr;
      });
      fn('V23Ix statistics view', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.statistics WHERE table_name = 'v23_ix' AND index_name = 'v23_ixm'");
        return r.data.length === 2 && r.data[0].seq_in_index === 1 && r.data[0].collation === 'D' && r.data[1].collation === 'A';
      });
      fn('V23Ix statistics includes implicit pk index', () => {
        const r = db.executeQuery("SELECT * FROM information_schema.statistics WHERE table_name = 'v23_ix' AND index_name = 'PRIMARY'");
        return r.data.length === 1 && r.data[0].non_unique === 0 && r.data[0].column_name === 'id';
      });
      fn('V23Ix check_constraints view', () => {
        db.executeQuery("ALTER TABLE v23_ix ADD CONSTRAINT v23_ixck CHECK (sal >= 0)");
        const r = db.executeQuery("SELECT * FROM information_schema.check_constraints WHERE constraint_name = 'v23_ixck'");
        return r.data.length === 1 && r.data[0].table_name === 'v23_ix' && r.data[0].check_clause.includes('sal');
      });
      fn('V23Ix parameters view', () => {
        db.executeQuery("CREATE PROCEDURE v23_pr(a INTEGER, b INTEGER) AS BEGIN SELECT 1; END");
        const r = db.executeQuery("SELECT * FROM information_schema.parameters WHERE specific_name = 'v23_pr'");
        db.executeQuery("DROP PROCEDURE v23_pr");
        return r.data.length === 2 && r.data[0].ordinal_position === 1 && r.data[0].routine_type === 'PROCEDURE';
      });
      err('V23Ix unknown metadata view still rejected', "SELECT * FROM information_schema.nope", "not available");

      // ============================================================
      // 11. UNNEST と ARRAY リテラルの句分割
      // ============================================================
      // ARRAY[...] を素で SELECT すると角括弧内のカンマで句が割れていた（既存バグ）
      push('V23Un bare array literal', "SELECT ARRAY_TO_STRING(ARRAY[1,2,3], '-') AS s", r => r.data[0].s === '1-2-3');
      push('V23Un array literal in select list', "SELECT ARRAY[1,2] AS a, 5 AS b", r => Array.isArray(r.data[0].a) && r.data[0].a.length === 2 && r.data[0].b === 5);
      push('V23Un unnest array literal', "SELECT COUNT(*) AS c FROM UNNEST(ARRAY[1,2,3]) AS t(v)", r => r.data[0].c === 3);
      push('V23Un unnest sums', "SELECT SUM(v) AS s FROM UNNEST(ARRAY[1,2,3]) AS t(v)", r => r.data[0].s === 6);
      push('V23Un unnest string_to_array', "SELECT COUNT(*) AS c FROM UNNEST(STRING_TO_ARRAY('a,b,c', ',')) AS t(v)", r => r.data[0].c === 3);
      push('V23Un unnest with ordinality', "SELECT v, n FROM UNNEST(ARRAY['x','y']) WITH ORDINALITY AS t(v, n) ORDER BY n",
        r => r.data.length === 2 && r.data[0].v === 'x' && r.data[0].n === 1 && r.data[1].n === 2);
      // スカラーを並べる従来形も維持されている
      push('V23Un unnest scalar list', "SELECT SUM(n) AS s FROM UNNEST(10, 20, 30) AS u(n)", r => r.data[0].s === 60);
      push('V23Un unnest empty array', "SELECT COUNT(*) AS c FROM UNNEST(ARRAY[]) AS t(v)", r => r.data[0].c === 0);
      push('V23Un unnest joined to table', "SELECT COUNT(*) AS c FROM users u JOIN UNNEST(ARRAY[1,2]) AS t(v) ON u.id = t.v", r => r.data[0].c === 2);

      // ============================================================
      // 12. フロントエンド: 結果グリッドの絞り込みとセル詳細
      // ============================================================
      fn('V23Ui filter narrows rows', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ id: 1, nm: 'Alice' }, { id: 2, nm: 'Bob' }, { id: 3, nm: 'Carol' }];
        els.resFilter.value = 'bob';
        els.resFilter.dispatchEvent(new Event('input'));
        const rows = els.resArea.querySelectorAll('#resultsTbody tr').length;
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        const back = els.resArea.querySelectorAll('#resultsTbody tr').length;
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return rows === 1 && back === 3;
      });
      fn('V23Ui filter matches any column', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: 'x', b: 'needle' }, { a: 'y', b: 'z' }];
        els.resFilter.value = 'needle'; els.resFilter.dispatchEvent(new Event('input'));
        const rows = els.resArea.querySelectorAll('#resultsTbody tr').length;
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return rows === 1;
      });
      fn('V23Ui filter matches null keyword', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: null }, { a: 1 }];
        els.resFilter.value = 'null'; els.resFilter.dispatchEvent(new Event('input'));
        const rows = els.resArea.querySelectorAll('#resultsTbody tr').length;
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return rows === 1;
      });
      fn('V23Ui filter no match message', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: 1 }];
        els.resFilter.value = 'zzzz'; els.resFilter.dispatchEvent(new Event('input'));
        const txt = els.resArea.textContent;
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return txt.includes('zzzz') && txt.includes('一致する行がありません');
      });
      fn('V23Ui filter note shows both counts', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: 'keep' }, { a: 'drop' }];
        els.resFilter.value = 'keep'; els.resFilter.dispatchEvent(new Event('input'));
        const note = els.resArea.querySelector('#resultsNote');
        const txt = note ? note.textContent : '';
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return txt.includes('filtered from 2');
      });
      fn('V23Ui filter clear button resets', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: 1 }, { a: 2 }];
        els.resFilter.value = '1'; els.resFilter.dispatchEvent(new Event('input'));
        document.getElementById('resultFilterClear').click();
        const rows = els.resArea.querySelectorAll('#resultsTbody tr').length;
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return rows === 2 && els.resFilter.value === '';
      });
      fn('V23Ui cell modal shows value and type', () => {
        const bku = currentResultData;
        currentResultData = [{ note: 'hello world' }];
        renderDisplay(true);
        els.resArea.querySelector('#resultsTbody td').click();
        const open = !document.getElementById('cellModal').classList.contains('hidden');
        const col = document.getElementById('cellModalCol').textContent;
        const typ = document.getElementById('cellModalType').textContent;
        const len = document.getElementById('cellModalLen').textContent;
        const v = document.getElementById('cellModalValue').textContent;
        document.querySelector('#cellModal .closeModalBtn').click();
        currentResultData = bku; renderDisplay(true);
        return open && col === 'note' && typ === 'string' && len === '11' && v === 'hello world';
      });
      fn('V23Ui cell modal pretty prints json', () => {
        const bku = currentResultData;
        currentResultData = [{ j: '{"a":1,"b":[2,3]}' }];
        renderDisplay(true);
        els.resArea.querySelector('#resultsTbody td').click();
        const btn = document.getElementById('cellModalPretty');
        const visible = !btn.classList.contains('hidden');
        btn.click();
        const pretty = document.getElementById('cellModalValue').textContent;
        document.querySelector('#cellModal .closeModalBtn').click();
        currentResultData = bku; renderDisplay(true);
        return visible && pretty.includes('\n  "a": 1');
      });
      fn('V23Ui cell modal hides pretty for plain text', () => {
        const bku = currentResultData;
        currentResultData = [{ s: 'not json' }];
        renderDisplay(true);
        els.resArea.querySelector('#resultsTbody td').click();
        const hidden = document.getElementById('cellModalPretty').classList.contains('hidden');
        document.querySelector('#cellModal .closeModalBtn').click();
        currentResultData = bku; renderDisplay(true);
        return hidden;
      });
      fn('V23Ui cell modal shows NULL', () => {
        const bku = currentResultData;
        currentResultData = [{ n: null }];
        renderDisplay(true);
        els.resArea.querySelector('#resultsTbody td').click();
        const v = document.getElementById('cellModalValue').textContent;
        const t = document.getElementById('cellModalType').textContent;
        document.querySelector('#cellModal .closeModalBtn').click();
        currentResultData = bku; renderDisplay(true);
        return v === 'NULL' && t === 'null';
      });
      fn('V23Ui cell coordinates survive filtering', () => {
        const bku = currentResultData, bkf = resultFilter;
        currentResultData = [{ a: 'aa' }, { a: 'bb' }, { a: 'cc' }];
        els.resFilter.value = 'cc'; els.resFilter.dispatchEvent(new Event('input'));
        els.resArea.querySelector('#resultsTbody td').click();
        const v = document.getElementById('cellModalValue').textContent;
        document.querySelector('#cellModal .closeModalBtn').click();
        els.resFilter.value = ''; els.resFilter.dispatchEvent(new Event('input'));
        currentResultData = bku; resultFilter = bkf; els.resFilter.value = bkf; renderDisplay(true);
        return v === 'cc';
      });
      // セル値のエスケープは維持される（td に子要素を作らない実装であること）
      fn('V23Ui cell keeps escaping with coords', () => {
        const bku = currentResultData;
        currentResultData = [{ p: '<img src=x onerror=window.__v23x=1>' }];
        renderDisplay(true);
        const td = els.resArea.querySelector('#resultsTbody td');
        const ok = td && td.children.length === 0 && td.dataset.r === '0' && td.dataset.c === '0' && window.__v23x === undefined;
        currentResultData = bku; renderDisplay(true);
        return !!ok;
      });

      // ============================================================
      // 13. フロントエンド: スキーマツリーの展開
      // ============================================================
      fn('V23Tree expands columns with badges', () => {
        db.executeQuery("CREATE TABLE v23_tr (cid INTEGER PRIMARY KEY AUTO_INCREMENT, em TEXT UNIQUE, nn TEXT NOT NULL, g INTEGER GENERATED ALWAYS AS (cid * 2))");
        renderTree();
        const toggle = document.querySelector('.tree-toggle-btn[data-table="v23_tr"]');
        toggle.click();
        const cols = [...document.querySelectorAll('#tableTree .column-insert-btn')].map(b => b.dataset.column);
        const badgeOf = (c) => [...document.querySelector(`.column-insert-btn[data-column="${c}"]`).querySelectorAll('span[class*="border"]')].map(s => s.textContent);
        const ok = cols.join(',') === 'cid,em,nn,g'
            && badgeOf('cid').join('+') === 'PK+AI'
            && badgeOf('em').join('+') === 'UQ'
            && badgeOf('nn').join('+') === 'NN'
            && badgeOf('g').join('+') === 'GEN';
        toggle.click();
        return ok;
      });
      fn('V23Tree fk badge', () => {
        db.executeQuery("CREATE TABLE v23_trc (id INTEGER, pid INTEGER REFERENCES v23_tr(cid))");
        renderTree();
        document.querySelector('.tree-toggle-btn[data-table="v23_trc"]').click();
        const badges = [...document.querySelector('.column-insert-btn[data-column="pid"]').querySelectorAll('span[class*="border"]')].map(s => s.textContent);
        document.querySelector('.tree-toggle-btn[data-table="v23_trc"]').click();
        db.executeQuery("DROP TABLE v23_trc");
        renderTree();
        return badges.includes('FK');
      });
      fn('V23Tree collapse hides columns', () => {
        const toggle = document.querySelector('.tree-toggle-btn[data-table="v23_tr"]');
        toggle.click();
        const openCount = document.querySelectorAll('#tableTree .column-insert-btn').length;
        document.querySelector('.tree-toggle-btn[data-table="v23_tr"]').click();
        const closedCount = document.querySelectorAll('#tableTree .column-insert-btn').length;
        return openCount === 4 && closedCount === 0;
      });
      fn('V23Tree expansion survives re-render', () => {
        document.querySelector('.tree-toggle-btn[data-table="v23_tr"]').click();
        renderTree();
        const stillOpen = document.querySelectorAll('#tableTree .column-insert-btn').length === 4;
        document.querySelector('.tree-toggle-btn[data-table="v23_tr"]').click();
        return stillOpen;
      });
      fn('V23Tree column click inserts at cursor', () => {
        document.querySelector('.tree-toggle-btn[data-table="v23_tr"]').click();
        const bk = els.query.value;
        setQueryValue('SELECT ');
        els.query.selectionStart = els.query.selectionEnd = 7;
        document.querySelector('.column-insert-btn[data-column="em"]').click();
        const got = els.query.value;
        document.querySelector('.tree-toggle-btn[data-table="v23_tr"]').click();
        setQueryValue(bk);
        return got === 'SELECT em';
      });
      fn('V23Tree insert adds separator after identifier', () => {
        const bk = els.query.value;
        setQueryValue('SELECT id');
        els.query.selectionStart = els.query.selectionEnd = 9;
        insertAtCursor('nm');
        const got = els.query.value;
        setQueryValue(bk);
        return got === 'SELECT id nm';
      });
      fn('V23Tree lists index / sequence / procedure / function sections', () => {
        db.executeQuery("CREATE INDEX v23_tix ON v23_tr (em)");
        db.executeQuery("CREATE SEQUENCE v23_tseq");
        db.executeQuery("CREATE PROCEDURE v23_tproc AS BEGIN SELECT 1; END");
        db.executeQuery("CREATE FUNCTION v23_tfn(x INTEGER) RETURNS INTEGER AS RETURN x + 1");
        renderTree();
        const txt = document.getElementById('tableTree').textContent;
        const ok = ['Indexes', 'v23_tix', 'Sequences', 'v23_tseq', 'Procedures', 'v23_tproc', 'Functions', 'v23_tfn'].every(s => txt.includes(s));
        db.executeQuery("DROP FUNCTION v23_tfn");
        db.executeQuery("DROP PROCEDURE v23_tproc");
        db.executeQuery("DROP SEQUENCE v23_tseq");
        renderTree();
        return ok;
      });
      fn('V23Tree view check option marker', () => {
        db.executeQuery("CREATE VIEW v23_tv AS SELECT cid FROM v23_tr WHERE cid > 0 WITH CHECK OPTION");
        renderTree();
        const txt = document.getElementById('tableTree').textContent;
        const ok = txt.includes('v23_tv') && txt.includes('CHECK');
        db.executeQuery("DROP VIEW v23_tv");
        renderTree();
        return ok;
      });

      // ============================================================
      // 14. フロントエンド: トランザクション操作バー
      // ============================================================
      fn('V23Tx idle state', () => {
        renderTxnState();
        return document.getElementById('txnLabel').textContent === 'AUTOCOMMIT'
            && document.getElementById('txnBeginBtn').disabled === false
            && document.getElementById('txnCommitBtn').disabled === true
            && document.getElementById('txnRollbackBtn').disabled === true;
      });
      fn('V23Tx begin flips state and buttons', () => {
        document.getElementById('txnBeginBtn').click();
        const ok = db.inTransaction === true
            && document.getElementById('txnLabel').textContent.includes('IN TRANSACTION')
            && document.getElementById('txnBeginBtn').disabled === true
            && document.getElementById('txnCommitBtn').disabled === false;
        document.getElementById('txnRollbackBtn').click();
        return ok;
      });
      fn('V23Tx label counts pending changes', () => {
        document.getElementById('txnBeginBtn').click();
        db.executeQuery("CREATE TABLE v23_txt (id INTEGER)");
        db.executeQuery("INSERT INTO v23_txt (id) VALUES (1)");
        renderTxnState();
        const ok = /IN TRANSACTION \(\d+ /.test(document.getElementById('txnLabel').textContent);
        document.getElementById('txnRollbackBtn').click();
        return ok;
      });
      fn('V23Tx rollback discards work', () => {
        document.getElementById('txnBeginBtn').click();
        db.executeQuery("CREATE TABLE v23_txr (id INTEGER)");
        document.getElementById('txnRollbackBtn').click();
        return db.tables.v23_txr === undefined
            && db.inTransaction === false
            && document.getElementById('txnLabel').textContent === 'AUTOCOMMIT';
      });
      fn('V23Tx commit keeps work', () => {
        document.getElementById('txnBeginBtn').click();
        db.executeQuery("CREATE TABLE v23_txc (id INTEGER)");
        document.getElementById('txnCommitBtn').click();
        const ok = db.tables.v23_txc !== undefined && db.inTransaction === false;
        db.executeQuery("DROP TABLE v23_txc");
        return ok;
      });
      fn('V23Tx state follows SQL-driven transactions', () => {
        db.executeQuery("BEGIN");
        renderTxnState();
        const inTx = document.getElementById('txnLabel').textContent.includes('IN TRANSACTION');
        db.executeQuery("ROLLBACK");
        renderTxnState();
        return inTx && document.getElementById('txnLabel').textContent === 'AUTOCOMMIT';
      });

      // ============================================================
      // 15. フロントエンド: カーソル位置の文の実行
      // ============================================================
      fn('V23Cur picks statement at caret', () => {
        const text = "SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c";
        return statementAtCursor(text, 0) === 'SELECT 1 AS a'
            && statementAtCursor(text, 20) === 'SELECT 2 AS b'
            && statementAtCursor(text, text.length) === 'SELECT 3 AS c';
      });
      fn('V23Cur ignores semicolons in string literals', () => {
        const text = "SELECT ';' AS s; SELECT 2 AS t";
        return statementAtCursor(text, 5) === "SELECT ';' AS s"
            && statementAtCursor(text, 25) === 'SELECT 2 AS t';
      });
      fn('V23Cur handles doubled quotes', () => {
        const text = "SELECT 'a''b;c' AS s; SELECT 2 AS t";
        return statementAtCursor(text, 5) === "SELECT 'a''b;c' AS s";
      });
      fn('V23Cur empty text returns null', () => statementAtCursor('   ', 1) === null);
      fn('V23Cur trailing semicolon falls back to previous statement', () => {
        const text = "SELECT 9 AS z;";
        return statementAtCursor(text, text.length) === 'SELECT 9 AS z';
      });
      fn('V23Cur runs only the caret statement', () => {
        const bk = els.query.value;
        setQueryValue("SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c");
        els.query.selectionStart = els.query.selectionEnd = 20;
        runQueryAtCursor();
        const cols = Object.keys(currentResultData[0]);
        const v = Object.values(currentResultData[0])[0];
        const unchanged = els.query.value.indexOf('SELECT 3 AS c') !== -1;
        setQueryValue(bk);
        return cols.length === 1 && cols[0] === 'b' && v === 2 && unchanged;
      });
      fn('V23Cur whole script still runnable', () => {
        const bk = els.query.value;
        setQueryValue("SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c");
        runQuery();
        const cols = Object.keys(currentResultData[0]);
        setQueryValue(bk);
        return cols[0] === 'c';
      });
      fn('V23Cur single statement behaves like run', () => {
        const bk = els.query.value;
        setQueryValue("SELECT 42 AS answer");
        els.query.selectionStart = els.query.selectionEnd = 3;
        runQueryAtCursor();
        const v = currentResultData[0].answer;
        setQueryValue(bk);
        return v === 42;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V23Cl drop objects', () => {
        ['v23_tgi', 'v23_tgu', 'v23_tgd'].forEach(t => db.executeQuery(`DROP TRIGGER IF EXISTS ${t}`));
        ['v23_vck', 'v23_vsum', 'v23_vagg', 'v23_va', 'v23_vx'].forEach(v => db.executeQuery(`DROP VIEW IF EXISTS ${v}`));
        ['v23_tr', 'v23_ix', 'v23_al', 'v23_e', 'v23_d', 'v23_audit', 'v23_ord', 'v23_emp',
         'v23_c6', 'v23_c5', 'v23_c4', 'v23_c3', 'v23_c2', 'v23_c', 'v23_pp', 'v23_p']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        renderTree();
        return true;
      });

      return T;
    }
