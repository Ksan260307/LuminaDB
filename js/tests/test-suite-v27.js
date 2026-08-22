    // ============================================================================
    // [Test Suite v27] - v1.22 で追加した商用DB互換機能のテスト
    //
    //   バックエンド:
    //     - 日付演算（日付 ± 数値 / 日付 - 日付）。従来は文字列連結・NULL だった
    //     - Oracle の階層問い合わせ（START WITH / CONNECT BY PRIOR / LEVEL /
    //       SYS_CONNECT_BY_PATH / CONNECT_BY_ROOT / CONNECT_BY_ISLEAF）と ROWNUM
    //     - 分析関数（RATIO_TO_REPORT / PERCENTILE_* OVER / NTH_VALUE FROM LAST /
    //       KEEP (DENSE_RANK FIRST|LAST ORDER BY)）
    //     - TRUNCATE の複数表指定（先頭 1 表しか空にしていなかった）
    //     - CREATE INDEX の INCLUDE / CONCURRENTLY、ALTER TABLE ADD COLUMN の生成列、
    //       SET CONSTRAINTS、SHOW SCHEMAS / TRANSACTION ISOLATION LEVEL
    //     - INSERT ... ON CONFLICT / IGNORE の RETURNING
    //     - PostgreSQL の照合演算子 ~ ~* !~ !~* ~~ ~~* !~~ !~~* と CURRENT_CATALOG
    //   フロントエンド:
    //     - 列プロファイル（行数 / NULL / 相異なり数 / 最小最大 / 上位の値）
    //     - ER 図（外部キーの親子関係）
    //
    //   test-suite.js の tests 配列へ getV27Tests() のスプレッドで合流する
    // ============================================================================
    function getV27Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one, colSafe: col } = makeTestKit('V27');
      const day = (v) => String(v).slice(0, 10);

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V27Fx tables', () => {
        db.executeQuery("CREATE TABLE v27_emp (id INTEGER PRIMARY KEY, mgr INTEGER, nm TEXT, dept TEXT, sal INTEGER, hire DATE)");
        db.executeQuery("INSERT INTO v27_emp VALUES (1,NULL,'king','HQ',100,'2020-01-10')," +
                        "(2,1,'bob','Eng',80,'2021-03-05'),(3,1,'ann','Eng',90,'2021-06-20')," +
                        "(4,2,'joe','Eng',70,'2022-11-01'),(5,2,'zoe','Sales',60,'2023-02-14')");
        return db.tables.v27_emp !== undefined && db.tables.v27_emp.rowCount === 5;
      });

      // ============================================================
      // 1. 日付演算
      // ============================================================
      push('V27Dt literal plus days', "SELECT DATE '2026-01-01' + 1 AS d", r => day(r.data[0].d) === '2026-01-02');
      push('V27Dt literal minus days', "SELECT DATE '2026-01-01' - 1 AS d", r => day(r.data[0].d) === '2025-12-31');
      push('V27Dt days plus literal', "SELECT 1 + DATE '2026-01-01' AS d", r => day(r.data[0].d) === '2026-01-02');
      push('V27Dt date minus date', "SELECT DATE '2026-01-05' - DATE '2026-01-01' AS n", r => r.data[0].n === 4);
      push('V27Dt date minus date negative', "SELECT DATE '2026-01-01' - DATE '2026-01-05' AS n", r => r.data[0].n === -4);
      push('V27Dt cast plus days', "SELECT CAST('2026-01-01' AS DATE) + 30 AS d", r => day(r.data[0].d) === '2026-01-31');
      push('V27Dt month boundary', "SELECT DATE '2026-02-27' + 3 AS d", r => day(r.data[0].d) === '2026-03-02');
      push('V27Dt column plus days', "SELECT nm, hire + 5 AS d FROM v27_emp WHERE id = 1", r => day(r.data[0].d) === '2020-01-15');
      push('V27Dt column minus days', "SELECT hire - 10 AS d FROM v27_emp WHERE id = 1", r => day(r.data[0].d) === '2019-12-31');
      push('V27Dt literal minus column', "SELECT DATE '2020-02-10' - hire AS n FROM v27_emp WHERE id = 1", r => r.data[0].n === 31);
      // 2022-11-01 と 2023-02-14 の 2 件だけが 1 年後に 2023-01-01 を越える
      push('V27Dt in where clause', "SELECT COUNT(*) AS c FROM v27_emp WHERE hire + 365 > DATE '2023-01-01'", r => r.data[0].c === 2);
      push('V27Dt chained', "SELECT hire + 5 - 2 AS d FROM v27_emp WHERE id = 1", r => day(r.data[0].d) === '2020-01-13');
      push('V27Dt max of date column', "SELECT MAX(hire) + 1 AS d FROM v27_emp", r => day(r.data[0].d) === '2023-02-15');
      push('V27Dt interval still works', "SELECT DATE '2026-01-31' + INTERVAL 1 MONTH AS d", r => day(r.data[0].d) === '2026-02-28');
      push('V27Dt date_add still works', "SELECT DATE_ADD(DATE '2026-01-01', 5) AS d", r => day(r.data[0].d) === '2026-01-06');
      push('V27Dt datediff still works', "SELECT DATEDIFF(DATE '2026-01-05', DATE '2026-01-01') AS n", r => r.data[0].n === 4);
      // 数値・文字列の演算は今までどおり
      push('V27Dt numbers unaffected', "SELECT 1 + 2 AS a, 5 - 3 AS b, -4 + 1 AS c", r => r.data[0].a === 3 && r.data[0].b === 2 && r.data[0].c === -3);
      push('V27Dt concat unaffected', "SELECT 'a' || 'b' AS s", r => r.data[0].s === 'ab');
      push('V27Dt function result unaffected', "SELECT LENGTH('abc') + 1 AS n", r => r.data[0].n === 4);
      push('V27Dt integer column unaffected', "SELECT sal + 1 AS n FROM v27_emp WHERE id = 1", r => r.data[0].n === 101);

      // ============================================================
      // 2. 階層問い合わせ（CONNECT BY）と ROWNUM
      // ============================================================
      push('V27Hier level', "SELECT nm, LEVEL AS lv FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr",
        r => r.data.length === 5 && r.data[0].nm === 'king' && r.data[0].lv === 1);
      push('V27Hier depth first order', "SELECT nm FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr",
        r => r.data.map(x => x.nm).join(',') === 'king,bob,joe,zoe,ann');
      push('V27Hier prior on the right', "SELECT COUNT(*) AS c FROM v27_emp START WITH mgr IS NULL CONNECT BY mgr = PRIOR id", r => r.data[0].c === 5);
      push('V27Hier order siblings by', "SELECT nm, LEVEL AS lv FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr ORDER SIBLINGS BY nm",
        r => r.data.map(x => x.nm).join(',') === 'king,ann,bob,joe,zoe');
      push('V27Hier subtree start', "SELECT nm FROM v27_emp START WITH id = 2 CONNECT BY PRIOR id = mgr",
        r => r.data.map(x => x.nm).join(',') === 'bob,joe,zoe');
      push('V27Hier isleaf', "SELECT nm, CONNECT_BY_ISLEAF AS leaf FROM v27_emp START WITH id = 2 CONNECT BY PRIOR id = mgr",
        r => r.data[0].leaf === 0 && r.data[1].leaf === 1 && r.data[2].leaf === 1);
      push('V27Hier path', "SELECT SYS_CONNECT_BY_PATH(nm, '/') AS p FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr",
        r => r.data[0].p === '/king' && r.data[2].p === '/king/bob/joe');
      push('V27Hier path separator', "SELECT SYS_CONNECT_BY_PATH(nm, ' > ') AS p FROM v27_emp START WITH id = 2 CONNECT BY PRIOR id = mgr",
        r => r.data[1].p === ' > bob > joe');
      push('V27Hier root', "SELECT nm, CONNECT_BY_ROOT nm AS root FROM v27_emp START WITH id > 1 AND mgr = 1 CONNECT BY PRIOR id = mgr",
        r => r.data.every(x => x.root === 'bob' || x.root === 'ann'));
      push('V27Hier extra condition', "SELECT COUNT(*) AS c FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr AND sal > 65", r => r.data[0].c === 4);
      push('V27Hier where after walk', "SELECT nm FROM v27_emp WHERE sal >= 80 START WITH mgr IS NULL CONNECT BY PRIOR id = mgr",
        r => r.data.map(x => x.nm).sort().join(',') === 'ann,bob,king');
      push('V27Hier table alias', "SELECT nm, LEVEL AS lv FROM v27_emp e START WITH e.mgr IS NULL CONNECT BY PRIOR e.id = e.mgr", r => r.data.length === 5);
      push('V27Hier aggregate over result', "SELECT COUNT(*) AS c FROM v27_emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr", r => r.data[0].c === 5);
      fn('V27Hier loop detected', () => {
        db.executeQuery("CREATE TABLE v27_cyc (id INTEGER, pid INTEGER)");
        db.executeQuery("INSERT INTO v27_cyc VALUES (1,2),(2,1)");
        const bad = db.executeQuery("SELECT id FROM v27_cyc START WITH id = 1 CONNECT BY PRIOR id = pid");
        const ok = db.executeQuery("SELECT id, LEVEL AS lv FROM v27_cyc START WITH id = 1 CONNECT BY NOCYCLE PRIOR id = pid");
        return !!bad.error && /loop/i.test(bad.error) && !ok.error && ok.data.length === 2;
      });
      err('V27Hier two prior links rejected', "SELECT nm FROM v27_emp CONNECT BY PRIOR id = mgr AND PRIOR sal > sal", "one 'PRIOR");
      err('V27Hier missing link rejected', "SELECT nm FROM v27_emp CONNECT BY sal > 0", "PRIOR");
      push('V27Rn where limit', "SELECT nm FROM v27_emp WHERE ROWNUM <= 2", r => r.data.length === 2 && r.data[0].nm === 'king');
      push('V27Rn strict less than', "SELECT nm FROM v27_emp WHERE ROWNUM < 3", r => r.data.length === 2);
      push('V27Rn select list', "SELECT ROWNUM AS rn, nm FROM v27_emp", r => r.data.length === 5 && r.data[0].rn === 1 && r.data[4].rn === 5);
      push('V27Rn with other predicate', "SELECT nm FROM v27_emp WHERE sal >= 70 AND ROWNUM <= 2", r => r.data.length === 2);
      push('V27Rn top n after sort', "SELECT nm FROM (SELECT nm FROM v27_emp ORDER BY sal DESC) WHERE ROWNUM <= 2",
        r => r.data.map(x => x.nm).join(',') === 'king,ann');

      // ============================================================
      // 3. 分析関数
      // ============================================================
      push('V27An ratio_to_report', "SELECT id, RATIO_TO_REPORT(sal) OVER () AS r FROM v27_emp WHERE id <= 2 ORDER BY id",
        r => Math.abs(r.data[0].r - 100 / 180) < 1e-9 && Math.abs(r.data[1].r - 80 / 180) < 1e-9);
      push('V27An ratio partitioned', "SELECT dept, RATIO_TO_REPORT(sal) OVER (PARTITION BY dept) AS r FROM v27_emp WHERE dept = 'HQ'",
        r => r.data[0].r === 1);
      push('V27An ratio sums to one', "SELECT SUM(r) AS s FROM (SELECT RATIO_TO_REPORT(sal) OVER () AS r FROM v27_emp) q",
        r => Math.abs(r.data[0].s - 1) < 1e-9);
      push('V27An percentile_cont over', "SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sal) OVER () AS m FROM v27_emp",
        r => r.data.length === 1 && r.data[0].m === 80);
      push('V27An percentile_disc over', "SELECT DISTINCT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY sal) OVER () AS m FROM v27_emp",
        r => r.data[0].m === 80);
      push('V27An percentile partitioned', "SELECT DISTINCT dept, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sal) OVER (PARTITION BY dept) AS m FROM v27_emp WHERE dept = 'Eng' ",
        r => r.data[0].m === 80);
      push('V27An percentile aggregate still works', "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sal) AS m FROM v27_emp", r => r.data[0].m === 80);
      push('V27An nth_value from last', "SELECT NTH_VALUE(nm, 1) FROM LAST OVER (ORDER BY id) AS v FROM v27_emp LIMIT 1", r => r.data[0].v === 'zoe');
      push('V27An nth_value from last second', "SELECT NTH_VALUE(nm, 2) FROM LAST OVER (ORDER BY id) AS v FROM v27_emp LIMIT 1", r => r.data[0].v === 'joe');
      push('V27An nth_value from first explicit', "SELECT NTH_VALUE(nm, 2) FROM FIRST OVER (ORDER BY id) AS v FROM v27_emp LIMIT 1", r => r.data[0].v === 'bob');
      push('V27An nth_value default unaffected', "SELECT NTH_VALUE(nm, 2) OVER (ORDER BY id) AS v FROM v27_emp LIMIT 1", r => r.data[0].v === 'bob');
      push('V27An keep first', "SELECT dept, MAX(sal) KEEP (DENSE_RANK FIRST ORDER BY hire) AS k FROM v27_emp GROUP BY dept ORDER BY dept",
        r => r.data.length === 3 && r.data.find(x => x.dept === 'Eng').k === 80);
      push('V27An keep last', "SELECT dept, MAX(sal) KEEP (DENSE_RANK LAST ORDER BY hire) AS k FROM v27_emp GROUP BY dept ORDER BY dept",
        r => r.data.find(x => x.dept === 'Eng').k === 70);
      push('V27An keep whole table', "SELECT MIN(nm) KEEP (DENSE_RANK FIRST ORDER BY sal) AS k FROM v27_emp", r => r.data[0].k === 'zoe');
      push('V27An keep desc order', "SELECT MAX(nm) KEEP (DENSE_RANK FIRST ORDER BY sal DESC) AS k FROM v27_emp", r => r.data[0].k === 'king');
      fn('V27An keep ties are all kept', () => {
        db.executeQuery("CREATE TABLE v27_tie (g TEXT, v INTEGER, h INTEGER)");
        db.executeQuery("INSERT INTO v27_tie VALUES ('a',10,1),('a',30,1),('a',99,2)");
        // h の最小値 1 は 2 行あるので、その両方から MAX を取る
        return one("SELECT MAX(v) KEEP (DENSE_RANK FIRST ORDER BY h) AS k FROM v27_tie") === 30;
      });
      // v1.28: ウィンドウ呼び出しを隠し列へ切り出すようにしたので、関数の中に入れた形も
      // 式の途中に書いた形も評価できる（以前はどちらもエラーだった）
      push('V27An window nested in a function', "SELECT ROUND(SUM(sal) OVER (), 2) AS r FROM v27_emp",
        r => r.data.length === 5 && r.data.every(x => x.r === 400));
      push('V27An window inside an expression', "SELECT ROUND(RATIO_TO_REPORT(sal) OVER () * 100, 1) AS r FROM v27_emp",
        r => r.data.length === 5 && r.data[0].r === 25);
      push('V27An window through a subquery works', "SELECT ROUND(r * 100, 1) AS pct FROM (SELECT RATIO_TO_REPORT(sal) OVER () AS r FROM v27_emp) q ORDER BY pct DESC LIMIT 1",
        r => r.data[0].pct === 25);
      err('V27An unknown window fn still rejected', "SELECT NOPE_FN(sal) OVER () AS v FROM v27_emp", "not supported as a window function");

      // ============================================================
      // 4. DDL の取りこぼし修正
      // ============================================================
      fn('V27Ddl truncate empties every table', () => {
        db.executeQuery("CREATE TABLE v27_t1 (id INTEGER)");
        db.executeQuery("CREATE TABLE v27_t2 (id INTEGER)");
        db.executeQuery("INSERT INTO v27_t1 VALUES (1),(2)");
        db.executeQuery("INSERT INTO v27_t2 VALUES (1),(2),(3)");
        const r = db.executeQuery("TRUNCATE TABLE v27_t1, v27_t2");
        return !r.error && r.data[0].Message === '5 rows truncated.'
            && one("SELECT COUNT(*) AS c FROM v27_t1") === 0
            && one("SELECT COUNT(*) AS c FROM v27_t2") === 0;
      });
      err('V27Ddl truncate unknown table rejected', "TRUNCATE TABLE v27_t1, v27_nope", "not found");
      err('V27Ddl truncate duplicate rejected', "TRUNCATE TABLE v27_t1, v27_t1", "more than once");
      err('V27Ddl truncate junk rejected', "TRUNCATE TABLE v27_t1 GARBAGE", "Syntax Error in TRUNCATE");
      push('V27Ddl truncate single still works', "TRUNCATE TABLE v27_t1", r => !r.error);
      fn('V27Ddl add generated column', () => {
        db.executeQuery("CREATE TABLE v27_g (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("INSERT INTO v27_g VALUES (1,'ab')");
        const r = db.executeQuery("ALTER TABLE v27_g ADD COLUMN n2 INTEGER GENERATED ALWAYS AS (LENGTH(nm)) STORED");
        return !r.error && one("SELECT n2 FROM v27_g WHERE id = 1") === 2;
      });
      fn('V27Ddl generated column fills new rows', () => {
        db.executeQuery("INSERT INTO v27_g (id, nm) VALUES (2,'xyz')");
        return one("SELECT n2 FROM v27_g WHERE id = 2") === 3;
      });
      push('V27Ddl generated column shown in describe', "DESCRIBE v27_g",
        r => /GENERATED AS/.test(r.data.find(x => x.Column === 'n2').Extra));
      err('V27Ddl generated column cannot be assigned', "INSERT INTO v27_g (id, nm, n2) VALUES (3,'q',9)", "generated column");
      fn('V27Ddl index include is recorded and warned', () => {
        db.executeQuery("CREATE TABLE v27_ix (id INTEGER, nm TEXT, v INTEGER)");
        db.executeQuery("INSERT INTO v27_ix VALUES (1,'a',10)");
        const r = db.executeQuery("CREATE INDEX v27_ix_nm ON v27_ix (nm) INCLUDE (v)");
        return !r.error && /INCLUDE \(v\)/.test(r.data[0].Message)
            && (r.warnings || []).some(w => w.Code === 'INDEX_INCLUDE');
      });
      err('V27Ddl index include unknown column', "CREATE INDEX v27_ix_bad ON v27_ix (nm) INCLUDE (nope)", "not found");
      fn('V27Ddl index concurrently accepted', () => {
        const r = db.executeQuery("CREATE INDEX CONCURRENTLY v27_ix_v ON v27_ix (v)");
        return !r.error && (r.warnings || []).some(w => w.Code === 'INDEX_CONCURRENTLY');
      });
      fn('V27Ddl set constraints deferred warns', () => {
        const r = db.executeQuery("SET CONSTRAINTS ALL DEFERRED");
        return !r.error && (r.warnings || []).some(w => w.Code === 'CONSTRAINTS_IMMEDIATE');
      });
      fn('V27Ddl set constraints immediate is quiet', () => {
        const r = db.executeQuery("SET CONSTRAINTS ALL IMMEDIATE");
        return !r.error && r.warnings === undefined;
      });
      push('V27Ddl show schemas', "SHOW SCHEMAS", r => r.data.length >= 1 && r.data[0].Schema === 'main');
      push('V27Ddl show isolation level', "SHOW TRANSACTION ISOLATION LEVEL", r => r.data[0].transaction_isolation === 'SERIALIZABLE');
      fn('V27Ddl system versioning warns', () => {
        const r = db.executeQuery("CREATE TABLE v27_ver (id INTEGER PRIMARY KEY, v INTEGER) WITH SYSTEM VERSIONING");
        return !r.error && (r.warnings || []).some(w => w.Code === 'NO_SYSTEM_VERSIONING');
      });
      err('V27Ddl for system_time rejected', "SELECT * FROM v27_ver FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP", "not supported");
      fn('V27Ddl table options warn', () => {
        const r = db.executeQuery("CREATE TABLE v27_opt (id INTEGER) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        return !r.error && (r.warnings || []).some(w => w.Code === 'TABLE_OPTIONS_IGNORED');
      });
      fn('V27Ddl plain create table has no warning', () => {
        const r = db.executeQuery("CREATE TABLE v27_plain (id INTEGER)");
        return !r.error && r.warnings === undefined;
      });

      // ============================================================
      // 5. upsert の RETURNING
      // ============================================================
      fn('V27Up on conflict do nothing returns inserted', () => {
        db.executeQuery("CREATE TABLE v27_up (id INTEGER PRIMARY KEY, nm TEXT, n INTEGER)");
        db.executeQuery("INSERT INTO v27_up VALUES (1,'a',1)");
        const r = db.executeQuery("INSERT INTO v27_up (id, nm, n) VALUES (2,'b',1) ON CONFLICT (id) DO NOTHING RETURNING id, nm");
        return !r.error && r.data.length === 1 && r.data[0].id === 2 && r.data[0].nm === 'b';
      });
      fn('V27Up on conflict do nothing skips conflicts', () => {
        const r = db.executeQuery("INSERT INTO v27_up (id, nm, n) VALUES (1,'zz',9) ON CONFLICT (id) DO NOTHING RETURNING id");
        return !r.error && r.data.length === 0 && one("SELECT nm FROM v27_up WHERE id = 1") === 'a';
      });
      fn('V27Up on conflict do update returns updated', () => {
        const r = db.executeQuery("INSERT INTO v27_up (id, nm, n) VALUES (1,'zz',9) ON CONFLICT (id) DO UPDATE SET n = 5 RETURNING id, n");
        return !r.error && r.data.length === 1 && r.data[0].id === 1 && r.data[0].n === 5;
      });
      fn('V27Up insert ignore returns inserted', () => {
        const r = db.executeQuery("INSERT IGNORE INTO v27_up (id, nm, n) VALUES (3,'c',1) RETURNING id");
        return !r.error && r.data.length === 1 && r.data[0].id === 3;
      });
      fn('V27Up mixed batch returns only written rows', () => {
        const r = db.executeQuery("INSERT INTO v27_up (id, nm, n) VALUES (3,'dup',0), (4,'d',1) ON CONFLICT (id) DO NOTHING RETURNING id");
        return !r.error && r.data.length === 1 && r.data[0].id === 4;
      });
      err('V27Up replace returning still rejected', "REPLACE INTO v27_up (id, nm, n) VALUES (1,'q',1) RETURNING id", "not supported with REPLACE");
      fn('V27Up upsert without returning unaffected', () => {
        const r = db.executeQuery("INSERT INTO v27_up (id, nm, n) VALUES (9,'i',1) ON CONFLICT (id) DO NOTHING");
        return !r.error && r.data[0].Result === 'Success';
      });

      // ============================================================
      // 6. 照合演算子とセッション関数
      // ============================================================
      fn('V27Op fixture', () => {
        db.executeQuery("CREATE TABLE v27_rx (id INTEGER, nm TEXT)");
        db.executeQuery("INSERT INTO v27_rx VALUES (1,'Apple'),(2,'banana'),(3,'Cherry'),(4,NULL)");
        return db.tables.v27_rx.rowCount === 4;
      });
      push('V27Op regex match', "SELECT nm FROM v27_rx WHERE nm ~ 'an'", r => r.data.length === 1 && r.data[0].nm === 'banana');
      push('V27Op regex anchored', "SELECT nm FROM v27_rx WHERE nm ~ '^C'", r => r.data.length === 1 && r.data[0].nm === 'Cherry');
      push('V27Op regex case-insensitive', "SELECT nm FROM v27_rx WHERE nm ~* 'AN'", r => r.data.length === 1 && r.data[0].nm === 'banana');
      push('V27Op regex negated', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm !~ 'an'", r => r.data[0].c === 2);
      push('V27Op regex negated ci', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm !~* 'AN'", r => r.data[0].c === 2);
      push('V27Op like operator', "SELECT nm FROM v27_rx WHERE nm ~~ 'App%'", r => r.data.length === 1 && r.data[0].nm === 'Apple');
      push('V27Op ilike operator', "SELECT nm FROM v27_rx WHERE nm ~~* 'app%'", r => r.data.length === 1 && r.data[0].nm === 'Apple');
      push('V27Op not like operator', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm !~~ 'App%'", r => r.data[0].c === 2);
      push('V27Op not ilike operator', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm !~~* 'app%'", r => r.data[0].c === 2);
      // NULL は真とも偽ともならない（3値論理）ので、どちらの向きでも行は残らない
      push('V27Op null is excluded both ways', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm ~ 'x' OR nm !~ 'x'", r => r.data[0].c === 3);
      push('V27Op function on the left', "SELECT nm FROM v27_rx WHERE UPPER(nm) ~ '^A'", r => r.data.length === 1);
      push('V27Op in select list', "SELECT nm, (nm ~ 'an') AS m FROM v27_rx WHERE id = 2", r => r.data[0].m === 1);
      push('V27Op current_catalog', "SELECT CURRENT_CATALOG AS c, CURRENT_DATABASE() AS d, DATABASE() AS e",
        r => r.data[0].c === r.data[0].e && r.data[0].d === r.data[0].e);
      push('V27Op like keyword unaffected', "SELECT COUNT(*) AS c FROM v27_rx WHERE nm LIKE 'A%'", r => r.data[0].c === 1);

      // ============================================================
      // 7. フロントエンド: 列プロファイル
      // ============================================================
      fn('V27Pf fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v27_pf");
        db.executeQuery("CREATE TABLE v27_pf (id INTEGER PRIMARY KEY, nm TEXT, dept TEXT, sal FLOAT)");
        db.executeQuery("INSERT INTO v27_pf VALUES (1,'Alice','Eng',520.5),(2,'Bob','Eng',480),(3,'Cara','Sales',NULL),(4,'Dan','Sales',480)");
        renderTree();
        return db.tables.v27_pf.rowCount === 4;
      });
      fn('V27Pf opens from the tree', () => {
        document.querySelector('.profile-btn[data-table="v27_pf"]').click();
        return !document.getElementById('profileModal').classList.contains('hidden')
            && document.getElementById('profileTable').textContent === 'v27_pf';
      });
      fn('V27Pf header counts rows and columns', () => {
        return document.getElementById('profileRows').textContent === '(4 rows × 4 columns)';
      });
      fn('V27Pf one row per column', () => {
        return document.querySelectorAll('#profileBody tbody tr').length === 4;
      });
      fn('V27Pf reports nulls', () => {
        const cells = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(tr => tr.children[0].textContent.startsWith('sal'));
        return cells.children[2].textContent === '1 (25%)';
      });
      fn('V27Pf reports distinct and extremes', () => {
        const tr = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(x => x.children[0].textContent.startsWith('dept'));
        return tr.children[3].textContent === '2' && tr.children[4].textContent === 'Eng' && tr.children[5].textContent === 'Sales';
      });
      fn('V27Pf marks unique columns', () => {
        const idRow = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(x => x.children[0].textContent.startsWith('id'));
        const deptRow = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(x => x.children[0].textContent.startsWith('dept'));
        return idRow.children[0].textContent.includes('UQ') && !deptRow.children[0].textContent.includes('UQ');
      });
      fn('V27Pf top values are ranked', () => {
        const tr = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(x => x.children[0].textContent.startsWith('sal'));
        return tr.children[8].textContent.startsWith('480 ×2');
      });
      fn('V27Pf averages numeric columns', () => {
        const tr = [...document.querySelectorAll('#profileBody tbody tr')]
            .find(x => x.children[0].textContent.startsWith('sal'));
        return tr.children[6].textContent === '493.5';
      });
      fn('V27Pf column click loads a distribution query', () => {
        const bk = els.query.value;
        document.querySelector('#profileBody .profile-col-btn[data-column="dept"]').click();
        const loaded = els.query.value;
        const closed = document.getElementById('profileModal').classList.contains('hidden');
        setQueryValue(bk);
        return closed && loaded === 'SELECT dept, COUNT(*) AS n FROM v27_pf GROUP BY dept ORDER BY n DESC';
      });
      fn('V27Pf empty table is handled', () => {
        db.executeQuery("CREATE TABLE v27_empty (a INTEGER, b TEXT)");
        renderTree();
        document.querySelector('.profile-btn[data-table="v27_empty"]').click();
        const rows = document.querySelectorAll('#profileBody tbody tr').length;
        const note = document.getElementById('profileNote').textContent;
        const dash = document.querySelectorAll('#profileBody tbody tr')[0].children[4].textContent;
        document.querySelector('#profileModal .closeModalBtn').click();
        return rows === 2 && note !== '' && dash === '—';
      });

      // ============================================================
      // 8. フロントエンド: ER 図
      // ============================================================
      fn('V27Er fixture with foreign keys', () => {
        db.executeQuery("CREATE TABLE v27_par (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("CREATE TABLE v27_chi (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES v27_par(id), v INTEGER)");
        db.executeQuery("INSERT INTO v27_par VALUES (1,'p')");
        db.executeQuery("INSERT INTO v27_chi VALUES (1,1,10)");
        renderTree();
        return (db.tables.v27_chi.foreignKeys || []).length === 1;
      });
      fn('V27Er opens and draws every table', () => {
        document.getElementById('openErBtn').click();
        const open = !document.getElementById('erModal').classList.contains('hidden');
        const boxes = document.querySelectorAll('#erBody .er-table').length;
        const tables = Object.keys(db.tables).filter(n => !n.startsWith('__tmp_')).length;
        return open && boxes === tables;
      });
      fn('V27Er draws one edge per foreign key', () => {
        const fkCount = Object.keys(db.tables).filter(n => !n.startsWith('__tmp_'))
            .reduce((a, n) => a + (db.tables[n].foreignKeys || []).length, 0);
        return document.querySelectorAll('#erBody path[marker-end]').length === fkCount
            && document.getElementById('erCount').textContent.includes(`${fkCount} foreign keys`);
      });
      fn('V27Er child sits below its parent', () => {
        const boxOf = (n) => document.querySelector(`#erBody .er-table[data-table="${n}"] rect`);
        return Number(boxOf('v27_chi').getAttribute('y')) > Number(boxOf('v27_par').getAttribute('y'));
      });
      fn('V27Er labels the key column', () => {
        return [...document.querySelectorAll('#erBody text')].some(t => t.textContent === 'pid');
      });
      fn('V27Er table click loads a select', () => {
        const bk = els.query.value;
        document.querySelector('#erBody .er-table[data-table="v27_par"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const loaded = els.query.value;
        const closed = document.getElementById('erModal').classList.contains('hidden');
        setQueryValue(bk);
        return closed && loaded === 'SELECT * FROM v27_par' ;
      });
      fn('V27Er self reference does not loop', () => {
        db.executeQuery("CREATE TABLE v27_self (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES v27_self(id))");
        renderTree();
        document.getElementById('openErBtn').click();
        const drawn = document.querySelectorAll('#erBody .er-table').length > 0;
        document.querySelector('#erModal .closeModalBtn').click();
        return drawn;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V27Cl drop objects', () => {
        ['v27_self', 'v27_chi', 'v27_par', 'v27_empty', 'v27_pf', 'v27_rx', 'v27_up', 'v27_plain',
         'v27_opt', 'v27_ver', 'v27_ix', 'v27_g', 'v27_t2', 'v27_t1', 'v27_tie', 'v27_cyc', 'v27_emp']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
