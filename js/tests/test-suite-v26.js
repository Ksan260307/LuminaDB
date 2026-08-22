    // ============================================================================
    // [Test Suite v26] - v1.21 で追加した商用DB互換機能のテスト
    //
    //   バックエンド:
    //     - GROUP BY 結果に対するウィンドウ関数（構成比・グループ内順位・累計）
    //     - 列レベル COLLATE の実効化（比較 / IN / BETWEEN / ORDER BY /
    //       GROUP BY / DISTINCT / UNIQUE・PK / 索引経路の回避）
    //     - ORDER BY ALL、GROUPING_ID
    //     - ALTER COLUMN ... SET DATA TYPE / TYPE ... USING、RENAME CONSTRAINT
    //     - INSERT ... OVERRIDING { SYSTEM | USER } VALUE
    //     - JOIN LATERAL ... ON TRUE（LEFT / INNER / CROSS）
    //     - 配列・文字列・JSON の添字とスライス（SQL 準拠の 1 始まり）
    //     - 文単位の警告と SHOW WARNINGS
    //   フロントエンド:
    //     - エディタタブ（追加・切替・閉じる・自動命名・永続化）
    //     - 警告のコンソール出力
    //
    //   test-suite.js の tests 配列へ getV26Tests() のスプレッドで合流する
    // ============================================================================
    function getV26Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one, colSafe: col } = makeTestKit('V26');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V26Fx tables', () => {
        db.executeQuery("CREATE TABLE v26_s (id INTEGER PRIMARY KEY, reg TEXT, prod TEXT, amt INTEGER)");
        db.executeQuery("INSERT INTO v26_s VALUES (1,'East','x',10),(2,'East','y',30),(3,'West','x',20),(4,'West','y',40)");
        db.executeQuery("CREATE TABLE v26_ci (id INTEGER PRIMARY KEY, nm TEXT COLLATE NOCASE, tag TEXT)");
        db.executeQuery("INSERT INTO v26_ci VALUES (1,'Apple','p'),(2,'apple','q'),(3,'Banana','r')");
        return db.tables.v26_s !== undefined && db.tables.v26_ci !== undefined;
      });

      // ============================================================
      // 1. GROUP BY 結果に対するウィンドウ関数
      // ============================================================
      push('V26Win percent of total', "SELECT reg, SUM(amt) AS s, ROUND(SUM(amt) * 100.0 / SUM(SUM(amt)) OVER (), 1) AS pct FROM v26_s GROUP BY reg ORDER BY reg",
        r => r.data.length === 2 && r.data[0].pct === 40 && r.data[1].pct === 60);
      push('V26Win rank over groups', "SELECT reg, SUM(amt) AS s, RANK() OVER (ORDER BY SUM(amt) DESC) AS rk FROM v26_s GROUP BY reg ORDER BY rk",
        r => r.data[0].reg === 'West' && r.data[0].rk === 1 && r.data[1].rk === 2);
      push('V26Win row_number over groups', "SELECT reg, ROW_NUMBER() OVER (ORDER BY reg) AS rn FROM v26_s GROUP BY reg ORDER BY rn",
        r => r.data[0].rn === 1 && r.data[1].rn === 2);
      push('V26Win running total over groups', "SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg) AS run FROM v26_s GROUP BY reg ORDER BY reg",
        r => r.data[0].run === 40 && r.data[1].run === 100);
      push('V26Win partition over groups', "SELECT reg, prod, SUM(amt) AS s, RANK() OVER (PARTITION BY reg ORDER BY SUM(amt) DESC) AS rk FROM v26_s GROUP BY reg, prod ORDER BY reg, rk",
        r => r.data.length === 4 && r.data[0].prod === 'y' && r.data[0].rk === 1 && r.data[1].rk === 2);
      push('V26Win lag over groups', "SELECT reg, SUM(amt) AS s, LAG(SUM(amt)) OVER (ORDER BY reg) AS prev FROM v26_s GROUP BY reg ORDER BY reg",
        r => r.data[0].prev === null && r.data[1].prev === 40);
      push('V26Win count over groups', "SELECT reg, COUNT(*) OVER () AS groups FROM v26_s GROUP BY reg", r => r.data[0].groups === 2);
      // グループ化しない集計クエリでも OVER () は 1 行として扱える
      push('V26Win over plain aggregate', "SELECT SUM(amt) AS s, SUM(SUM(amt)) OVER () AS t FROM v26_s", r => r.data[0].s === 100 && r.data[0].t === 100);
      // SQL の評価順は GROUP BY → HAVING → ウィンドウ。除外された行は順位に数えない
      push('V26Win having applies before the window', "SELECT reg, SUM(amt) AS s, RANK() OVER (ORDER BY SUM(amt)) AS rk FROM v26_s GROUP BY reg HAVING SUM(amt) > 50",
        r => r.data.length === 1 && r.data[0].reg === 'West' && r.data[0].rk === 1);
      push('V26Win having narrows the percent base', "SELECT reg, ROUND(SUM(amt) * 100.0 / SUM(SUM(amt)) OVER (), 1) AS pct FROM v26_s GROUP BY reg HAVING SUM(amt) > 50",
        r => r.data.length === 1 && r.data[0].pct === 100);
      push('V26Win having without window unaffected', "SELECT reg, SUM(amt) AS s FROM v26_s GROUP BY reg HAVING COUNT(*) > 1 ORDER BY reg",
        r => r.data.length === 2 && r.data[0].s === 40);
      push('V26Win non-agg window still works', "SELECT amt, SUM(amt) OVER (ORDER BY id) AS run FROM v26_s ORDER BY id",
        r => r.data[3].run === 100);
      // v1.29: ROWS フレームは集計後の行にも使える（RANGE / GROUPS は引き続き不可）
      push('V26Win rows frame over groups works', "SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS r FROM v26_s GROUP BY reg ORDER BY reg",
        r => !r.error && r.data.length === 2 && r.data[0].r === 40 && r.data[1].r === 100);
      err('V26Win range frame over groups rejected', "SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS r FROM v26_s GROUP BY reg", "not supported over GROUP BY results");
      err('V26Win nested aggregate rejected', "SELECT MAX(SUM(amt)) AS m FROM v26_s GROUP BY reg", "cannot be nested");

      // ============================================================
      // 2. 列レベル COLLATE
      // ============================================================
      push('V26Col equality is case-insensitive', "SELECT COUNT(*) AS c FROM v26_ci WHERE nm = 'APPLE'", r => r.data[0].c === 2);
      push('V26Col inequality follows collation', "SELECT COUNT(*) AS c FROM v26_ci WHERE nm <> 'APPLE'", r => r.data[0].c === 1);
      push('V26Col in list follows collation', "SELECT COUNT(*) AS c FROM v26_ci WHERE nm IN ('APPLE', 'zzz')", r => r.data[0].c === 2);
      push('V26Col not in follows collation', "SELECT COUNT(*) AS c FROM v26_ci WHERE nm NOT IN ('APPLE')", r => r.data[0].c === 1);
      push('V26Col between follows collation', "SELECT COUNT(*) AS c FROM v26_ci WHERE nm BETWEEN 'A' AND 'B'", r => r.data[0].c === 2);
      push('V26Col order by folds case', "SELECT nm FROM v26_ci ORDER BY nm, id",
        r => r.data.map(x => x.nm).join(',') === 'Apple,apple,Banana');
      push('V26Col distinct folds case', "SELECT COUNT(*) AS c FROM (SELECT DISTINCT nm FROM v26_ci) q", r => r.data[0].c === 2);
      push('V26Col group by folds case', "SELECT COUNT(*) AS c FROM (SELECT nm, COUNT(*) AS n FROM v26_ci GROUP BY nm) q", r => r.data[0].c === 2);
      push('V26Col group by counts folded rows', "SELECT nm, COUNT(*) AS n FROM v26_ci GROUP BY nm ORDER BY n DESC",
        r => r.data[0].n === 2 && r.data[1].n === 1);
      push('V26Col group by ordinal folds too', "SELECT COUNT(*) AS c FROM (SELECT nm FROM v26_ci GROUP BY 1) q", r => r.data[0].c === 2);
      push('V26Col non-collated column unaffected', "SELECT COUNT(*) AS c FROM v26_ci WHERE tag = 'P'", r => r.data[0].c === 0);
      push('V26Col describe reports collation', "DESCRIBE v26_ci",
        r => r.data.find(x => x.Column === 'nm').Collation === 'NOCASE' && r.data.find(x => x.Column === 'tag').Collation === '');
      push('V26Col show create keeps collate', "SHOW CREATE TABLE v26_ci", r => /nm TEXT COLLATE NOCASE/.test(r.data[0].CreateTable));
      push('V26Col information_schema reports collation',
        "SELECT COLLATION_NAME AS c FROM information_schema.columns WHERE TABLE_NAME = 'v26_ci' AND COLUMN_NAME = 'nm'",
        r => r.data[0].c === 'NOCASE');
      err('V26Col unknown collation rejected', "CREATE TABLE v26_bad (v TEXT COLLATE BOGUS)", "Unknown collation");
      fn('V26Col unique honours collation', () => {
        db.executeQuery("CREATE TABLE v26_uc (id INTEGER PRIMARY KEY, nm TEXT COLLATE NOCASE UNIQUE)");
        db.executeQuery("INSERT INTO v26_uc VALUES (1, 'Apple')");
        const dup = db.executeQuery("INSERT INTO v26_uc VALUES (2, 'APPLE')");
        const ok = db.executeQuery("INSERT INTO v26_uc VALUES (3, 'Banana')");
        return !!dup.error && dup.error.includes('UNIQUE') && !ok.error;
      });
      fn('V26Col update honours collation', () => {
        const r = db.executeQuery("UPDATE v26_uc SET nm = 'banana' WHERE id = 1");
        return !!r.error && r.error.includes('UNIQUE');
      });
      fn('V26Col index is bypassed for collated columns', () => {
        db.executeQuery("CREATE TABLE v26_ix (id INTEGER, nm TEXT COLLATE NOCASE)");
        db.executeQuery("INSERT INTO v26_ix VALUES (1,'Alpha'),(2,'BETA')");
        db.executeQuery("CREATE INDEX v26_ix_nm ON v26_ix (nm)");
        // 索引は生値で作られるため、経路を外していないと 0 件になる
        const hit = db.executeQuery("SELECT COUNT(*) AS c FROM v26_ix WHERE nm = 'alpha'").data[0].c;
        const plan = db.executeQuery("EXPLAIN SELECT * FROM v26_ix WHERE nm = 'alpha'");
        const usesIndex = JSON.stringify(plan.data).includes('INDEX');
        return hit === 1 && !usesIndex;
      });
      fn('V26Col join honours collation', () => {
        db.executeQuery("CREATE TABLE v26_j1 (k TEXT COLLATE NOCASE, v INTEGER)");
        db.executeQuery("CREATE TABLE v26_j2 (k TEXT, w INTEGER)");
        db.executeQuery("INSERT INTO v26_j1 VALUES ('Apple', 1)");
        db.executeQuery("INSERT INTO v26_j2 VALUES ('APPLE', 2)");
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v26_j1 a JOIN v26_j2 b ON a.k = b.k");
        return !r.error && r.data[0].c === 1;
      });
      fn('V26Col noaccent collation', () => {
        db.executeQuery("CREATE TABLE v26_na (id INTEGER, v TEXT COLLATE NOACCENT)");
        db.executeQuery("INSERT INTO v26_na VALUES (1, 'カーテン'), (2, 'ガーテン')");
        return db.executeQuery("SELECT COUNT(*) AS c FROM v26_na WHERE v = 'カーテン'").data[0].c === 2;
      });
      fn('V26Col numeric collation sorts naturally', () => {
        db.executeQuery("CREATE TABLE v26_nu (id INTEGER, v TEXT COLLATE NUMERIC)");
        db.executeQuery("INSERT INTO v26_nu VALUES (1,'item10'),(2,'item9'),(3,'item100')");
        return col("SELECT v FROM v26_nu ORDER BY v", 'v').join(',') === 'item9,item10,item100';
      });
      fn('V26Col explicit collate still overrides', () => {
        // 明示指定は列の既定より優先される（BINARY で大文字小文字を区別）
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v26_ci WHERE nm COLLATE BINARY = 'APPLE'");
        return !r.error && r.data[0].c === 0;
      });
      fn('V26Col survives save and load', () => {
        const dump = db.exportForIDB ? db.exportForIDB() : null;
        if (!dump) return true;
        const clone = new DatabaseEngine();
        clone.importFromIDB(dump);
        return clone.tables.v26_ci.collations.nm === 'NOCASE'
            && clone.executeQuery("SELECT COUNT(*) AS c FROM v26_ci WHERE nm = 'APPLE'").data[0].c === 2;
      });

      // ============================================================
      // 3. ORDER BY ALL / GROUPING_ID
      // ============================================================
      push('V26Ord order by all', "SELECT reg, prod FROM v26_s ORDER BY ALL",
        r => r.data.map(x => x.reg + x.prod).join(',') === 'Eastx,Easty,Westx,Westy');
      push('V26Ord order by all desc', "SELECT reg, prod FROM v26_s ORDER BY ALL DESC",
        r => r.data.map(x => x.reg + x.prod).join(',') === 'Westy,Westx,Easty,Eastx');
      push('V26Ord order by all single column', "SELECT amt FROM v26_s ORDER BY ALL", r => r.data[0].amt === 10 && r.data[3].amt === 40);
      err('V26Ord order by all with star rejected', "SELECT * FROM v26_s ORDER BY ALL", "explicit select list");
      err('V26Ord order by all bad suffix rejected', "SELECT reg FROM v26_s ORDER BY ALL FOO", "ORDER BY ALL");
      push('V26Ord column named all still resolvable', "SELECT reg AS all_reg FROM v26_s ORDER BY all_reg LIMIT 1", r => r.data[0].all_reg === 'East');
      push('V26Grp grouping_id single arg', "SELECT reg, GROUPING_ID(reg) AS g FROM v26_s GROUP BY ROLLUP(reg) ORDER BY g, reg",
        r => r.data.length === 3 && r.data[0].g === 0 && r.data[2].g === 1);
      push('V26Grp grouping_id two args', "SELECT reg, prod, GROUPING_ID(reg, prod) AS g FROM v26_s GROUP BY CUBE(reg, prod) ORDER BY g",
        r => {
          const gs = r.data.map(x => x.g).sort((a, b) => a - b);
          return gs[0] === 0 && gs[gs.length - 1] === 3 && gs.includes(1) && gs.includes(2);
        });
      // 左端の引数が最上位ビット: (reg) の集合では prod だけが畳まれるので 1、(prod) では reg が畳まれ 2
      push('V26Grp grouping_id bit order', "SELECT GROUPING_ID(reg, prod) AS g FROM v26_s GROUP BY GROUPING SETS ((reg), (prod))",
        r => { const gs = r.data.map(x => x.g); return gs.filter(g => g === 1).length === 2 && gs.filter(g => g === 2).length === 2; });
      err('V26Grp grouping_id arg outside the sets', "SELECT GROUPING_ID(reg, prod) AS g FROM v26_s GROUP BY GROUPING SETS ((reg))", "must be a GROUP BY expression");
      push('V26Grp grouping still works', "SELECT reg, GROUPING(reg) AS g FROM v26_s GROUP BY ROLLUP(reg) ORDER BY g",
        r => r.data[r.data.length - 1].g === 1);
      err('V26Grp grouping_id needs a group by item', "SELECT GROUPING_ID(prod) AS g FROM v26_s GROUP BY ROLLUP(reg)", "must be a GROUP BY expression");

      // ============================================================
      // 4. ALTER COLUMN の標準綴りと RENAME CONSTRAINT
      // ============================================================
      fn('V26Alt set data type', () => {
        db.executeQuery("CREATE TABLE v26_at (id INTEGER, amt INTEGER, s TEXT)");
        db.executeQuery("INSERT INTO v26_at VALUES (1, 10, 'ab'), (2, 20, 'cde')");
        const r = db.executeQuery("ALTER TABLE v26_at ALTER COLUMN amt SET DATA TYPE FLOAT");
        return !r.error && db.tables.v26_at.colTypes.amt === 'FLOAT';
      });
      fn('V26Alt type keyword still works', () => {
        const r = db.executeQuery("ALTER TABLE v26_at ALTER COLUMN amt TYPE INTEGER");
        return !r.error && db.tables.v26_at.colTypes.amt === 'INTEGER';
      });
      err('V26Alt cast failure without using', "ALTER TABLE v26_at ALTER COLUMN s TYPE INTEGER", "Cannot cast");
      fn('V26Alt type using expression', () => {
        const r = db.executeQuery("ALTER TABLE v26_at ALTER COLUMN s TYPE INTEGER USING LENGTH(s)");
        const vals = col("SELECT s FROM v26_at ORDER BY id", 's');
        return !r.error && vals[0] === 2 && vals[1] === 3;
      });
      fn('V26Alt rename constraint unique', () => {
        db.executeQuery("ALTER TABLE v26_at ADD CONSTRAINT v26_uq UNIQUE (id)");
        const r = db.executeQuery("ALTER TABLE v26_at RENAME CONSTRAINT v26_uq TO v26_uq2");
        const dropped = db.executeQuery("ALTER TABLE v26_at DROP CONSTRAINT v26_uq2");
        return !r.error && !dropped.error;
      });
      fn('V26Alt rename constraint check', () => {
        db.executeQuery("ALTER TABLE v26_at ADD CONSTRAINT v26_ck CHECK (id > 0)");
        const r = db.executeQuery("ALTER TABLE v26_at RENAME CONSTRAINT v26_ck TO v26_ck2");
        const shown = db.executeQuery("SHOW CREATE TABLE v26_at").data[0].CreateTable;
        return !r.error && shown.includes('v26_ck2') && !shown.includes('v26_ck ');
      });
      err('V26Alt rename unknown constraint', "ALTER TABLE v26_at RENAME CONSTRAINT nope TO x", "not found");
      fn('V26Alt rename onto an existing name rejected', () => {
        db.executeQuery("ALTER TABLE v26_at ADD CONSTRAINT v26_ck3 CHECK (id < 1000)");
        const r = db.executeQuery("ALTER TABLE v26_at RENAME CONSTRAINT v26_ck3 TO v26_ck2");
        return !!r.error && r.error.includes('already exists');
      });

      // ============================================================
      // 5. INSERT ... OVERRIDING { SYSTEM | USER } VALUE
      // ============================================================
      fn('V26Ovr system value keeps the given id', () => {
        db.executeQuery("CREATE TABLE v26_ov (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, nm TEXT)");
        const r = db.executeQuery("INSERT INTO v26_ov (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, 'a')");
        return !r.error && db.executeQuery("SELECT id FROM v26_ov WHERE nm = 'a'").data[0].id === 99;
      });
      fn('V26Ovr user value discards the given id', () => {
        const r = db.executeQuery("INSERT INTO v26_ov (id, nm) OVERRIDING USER VALUE VALUES (5, 'b')");
        return !r.error && db.executeQuery("SELECT id FROM v26_ov WHERE nm = 'b'").data[0].id === 100;
      });
      fn('V26Ovr works with insert select', () => {
        const r = db.executeQuery("INSERT INTO v26_ov (id, nm) OVERRIDING USER VALUE SELECT 7 AS id, 'c' AS nm");
        return !r.error && db.executeQuery("SELECT id FROM v26_ov WHERE nm = 'c'").data[0].id === 101;
      });
      fn('V26Ovr plain insert unaffected', () => {
        const r = db.executeQuery("INSERT INTO v26_ov (nm) VALUES ('d')");
        return !r.error && db.executeQuery("SELECT id FROM v26_ov WHERE nm = 'd'").data[0].id === 102;
      });

      // ============================================================
      // 6. JOIN LATERAL
      // ============================================================
      push('V26Lat join lateral on true', "SELECT s.reg AS reg, x.c AS c FROM v26_s s JOIN LATERAL (SELECT COUNT(*) AS c FROM v26_s t WHERE t.reg = s.reg) x ON TRUE ORDER BY reg, c",
        r => r.data.length === 4 && r.data[0].c === 2);
      push('V26Lat inner join lateral', "SELECT s.id AS id, x.d AS d FROM v26_s s INNER JOIN LATERAL (SELECT s.amt * 2 AS d) x ON TRUE ORDER BY id",
        r => r.data[0].d === 20 && r.data[3].d === 80);
      push('V26Lat left join lateral', "SELECT s.id AS id, x.d AS d FROM v26_s s LEFT JOIN LATERAL (SELECT s.amt + 1 AS d) x ON TRUE ORDER BY id",
        r => r.data.length === 4 && r.data[0].d === 11);
      push('V26Lat cross join lateral', "SELECT s.id AS id, x.d AS d FROM v26_s s CROSS JOIN LATERAL (SELECT s.amt AS d) x WHERE x.d > 25 ORDER BY id",
        r => r.data.length === 2 && r.data[0].d === 30);
      push('V26Lat on condition filters', "SELECT s.id AS id, x.d AS d FROM v26_s s JOIN LATERAL (SELECT s.amt AS d) x ON x.d > 25 ORDER BY id",
        r => r.data.length === 2);
      push('V26Lat comma form still works', "SELECT s.id AS id, x.d AS d FROM v26_s s, LATERAL (SELECT s.amt * 3 AS d) x ORDER BY id",
        r => r.data[0].d === 30);
      push('V26Lat cross apply still works', "SELECT s.id AS id, x.c AS c FROM v26_s s CROSS APPLY (SELECT COUNT(*) AS c FROM v26_s) x ORDER BY id",
        r => r.data[0].c === 4);
      err('V26Lat right join lateral rejected', "SELECT s.id FROM v26_s s RIGHT JOIN LATERAL (SELECT 1 AS z) x ON TRUE", "not supported");
      err('V26Lat left join lateral with condition rejected', "SELECT s.id FROM v26_s s LEFT JOIN LATERAL (SELECT s.amt AS d) x ON x.d > 5", "only ON TRUE");

      // ============================================================
      // 7. 添字とスライス（SQL は 1 始まり）
      // ============================================================
      push('V26Sub array subscript is 1-based', "SELECT ARRAY[10,20,30,40][2] AS v", r => r.data[0].v === 20);
      push('V26Sub parenthesised subscript', "SELECT (ARRAY[10,20,30])[1] AS v", r => r.data[0].v === 10);
      push('V26Sub array slice', "SELECT ARRAY_TO_STRING(ARRAY[10,20,30,40][2:3], '-') AS v", r => r.data[0].v === '20-30');
      push('V26Sub slice open start', "SELECT ARRAY_TO_STRING(ARRAY[10,20,30,40][:2], '-') AS v", r => r.data[0].v === '10-20');
      push('V26Sub slice open end', "SELECT ARRAY_TO_STRING(ARRAY[10,20,30,40][3:], '-') AS v", r => r.data[0].v === '30-40');
      push('V26Sub out of range is null', "SELECT ARRAY[1,2,3][9] AS v", r => r.data[0].v === null);
      push('V26Sub zero index is null', "SELECT ARRAY[1,2,3][0] AS v", r => r.data[0].v === null);
      push('V26Sub null array is null', "SELECT NULL[1] AS v", r => r.data[0].v === null);
      push('V26Sub string subscript', "SELECT ('hello')[2] AS v", r => r.data[0].v === 'e');
      push('V26Sub string slice', "SELECT ('hello')[2:4] AS v", r => r.data[0].v === 'ell');
      push('V26Sub expression subscript', "SELECT ARRAY[10,20,30][1 + 1] AS v", r => r.data[0].v === 20);
      fn('V26Sub json array column subscript', () => {
        db.executeQuery("CREATE TABLE v26_js (id INTEGER, d TEXT)");
        db.executeQuery("INSERT INTO v26_js VALUES (1, '[5,6,7]'), (2, '{\"a\":9}')");
        return one("SELECT d[2] AS v FROM v26_js WHERE id = 1") === 6
            && one("SELECT d['a'] AS v FROM v26_js WHERE id = 2") === 9;
      });
      push('V26Sub array constructor still works', "SELECT ARRAY_LENGTH(ARRAY[1,2,3]) AS n", r => r.data[0].n === 3);
      push('V26Sub any array still works', "SELECT COUNT(*) AS c FROM v26_s WHERE id = ANY(ARRAY[1,2])", r => r.data[0].c === 2);
      err('V26Sub dangling subscript rejected', "SELECT [1] AS v", "subscript must follow");
      err('V26Sub empty subscript rejected', "SELECT ARRAY[1,2][] AS v", "empty subscript");

      // ============================================================
      // 8. 文単位の警告と SHOW WARNINGS
      // ============================================================
      fn('V26Wrn ddl no-op warns', () => {
        const r = db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        return !r.error && Array.isArray(r.warnings) && r.warnings.length === 1 && r.warnings[0].Code === 'DDL_NOOP';
      });
      fn('V26Wrn show warnings reads the previous statement', () => {
        db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        const r = db.executeQuery("SHOW WARNINGS");
        return r.data.length === 1 && r.data[0].Level === 'Warning' && r.data[0].Message.includes('Skipped');
      });
      fn('V26Wrn show count warnings', () => {
        db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        return db.executeQuery("SHOW COUNT(*) WARNINGS").data[0].Warnings === 1;
      });
      fn('V26Wrn show warnings is repeatable', () => {
        db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        const a = db.executeQuery("SHOW WARNINGS").data.length;
        const b = db.executeQuery("SHOW WARNINGS").data.length;
        return a === 1 && b === 1;
      });
      fn('V26Wrn cleared by the next statement', () => {
        db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        db.executeQuery("SELECT 1 AS a");
        return db.executeQuery("SHOW WARNINGS").data.length === 0;
      });
      fn('V26Wrn update without where warns', () => {
        db.executeQuery("CREATE TABLE v26_w (id INTEGER, v INTEGER)");
        db.executeQuery("INSERT INTO v26_w VALUES (1,1),(2,2)");
        const r = db.executeQuery("UPDATE v26_w SET v = 9");
        return !r.error && (r.warnings || []).some(w => w.Code === 'NO_WHERE');
      });
      fn('V26Wrn update with where does not warn', () => {
        const r = db.executeQuery("UPDATE v26_w SET v = 8 WHERE id = 1");
        return !r.error && r.warnings === undefined;
      });
      fn('V26Wrn delete without where warns', () => {
        const r = db.executeQuery("DELETE FROM v26_w");
        return !r.error && (r.warnings || []).some(w => w.Code === 'NO_WHERE');
      });
      fn('V26Wrn lossy type change warns', () => {
        db.executeQuery("CREATE TABLE v26_tc (id INTEGER, v TEXT)");
        db.executeQuery("INSERT INTO v26_tc VALUES (1, '1.50'), (2, '2.0')");
        const r = db.executeQuery("ALTER TABLE v26_tc ALTER COLUMN v TYPE FLOAT");
        return !r.error && (r.warnings || []).some(w => w.Code === 'TYPE_CONVERSION');
      });
      fn('V26Wrn clean statement carries no warnings', () => {
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v26_s");
        return !r.error && r.warnings === undefined;
      });
      fn('V26Wrn duplicates are collapsed', () => {
        // 同じ警告が複数回出ても 1 件にまとめる
        db.executeQuery("DROP TABLE IF EXISTS v26_missing");
        return db.executeQuery("SHOW WARNINGS").data.length === 1;
      });
      fn('V26Wrn api surfaces warnings', () => {
        const r = LuminaDB.query("DROP TABLE IF EXISTS v26_missing");
        return Array.isArray(r.warnings) && r.warnings[0].Code === 'DDL_NOOP';
      });

      // ============================================================
      // 9. フロントエンド: エディタタブ
      // ============================================================
      const tabEls = () => document.querySelectorAll('#editorTabs [data-tab-id]');
      const tabNames = () => [...tabEls()].map(e => e.querySelector('span').textContent);
      // タブ本文の反映は入力デバウンス後なので、テストからは同期関数を直接叩く
      const typeIntoEditor = (v) => { els.query.value = v; touchActiveTab(); };

      fn('V26Tab starts with one tab', () => {
        // 前段のテストが残した状態を消してから作り直す
        try { localStorage.removeItem('luminadb_editor_tabs'); } catch (e) { /* 無効環境 */ }
        while (tabEls().length > 1) tabEls()[tabEls().length - 1].querySelector('[data-close-id]').click();
        typeIntoEditor('');
        return tabEls().length === 1;
      });
      fn('V26Tab add creates a tab', () => {
        typeIntoEditor('SELECT * FROM v26_s');
        document.getElementById('tabAddBtn').click();
        return tabEls().length === 2 && els.query.value === '';
      });
      fn('V26Tab name derives from sql', () => {
        typeIntoEditor('UPDATE v26_s SET amt = 1');
        return tabNames()[0] === 'SELECT v26_s' && tabNames()[1] === 'UPDATE v26_s';
      });
      fn('V26Tab switching restores content', () => {
        tabEls()[0].click();
        const first = els.query.value;
        tabEls()[1].click();
        const second = els.query.value;
        return first === 'SELECT * FROM v26_s' && second === 'UPDATE v26_s SET amt = 1';
      });
      fn('V26Tab active tab is highlighted', () => {
        const active = [...tabEls()].filter(e => e.className.includes('border-blue-500'));
        return active.length === 1 && active[0] === tabEls()[1];
      });
      fn('V26Tab close removes a tab', () => {
        tabEls()[1].querySelector('[data-close-id]').click();
        return tabEls().length === 1 && els.query.value === 'SELECT * FROM v26_s';
      });
      fn('V26Tab last tab has no close button', () => {
        return tabEls()[0].querySelector('[data-close-id]') === null;
      });
      fn('V26Tab state is persisted', () => {
        document.getElementById('tabAddBtn').click();
        typeIntoEditor('DELETE FROM v26_s WHERE id = 0');
        // isTesting 中は localStorage への書き込みを抑制しているので、ここだけ解除して保存経路を通す
        isTesting = false;
        try { persistTabs(); } finally { isTesting = true; }
        const saved = JSON.parse(localStorage.getItem('luminadb_editor_tabs') || 'null');
        return saved && saved.tabs.length === 2 && saved.tabs[1].name === 'DELETE v26_s'
            && saved.tabs[1].sql === 'DELETE FROM v26_s WHERE id = 0';
      });
      fn('V26Tab untitled for empty sql', () => {
        typeIntoEditor('');
        return tabNames()[1] === 'Untitled';
      });
      fn('V26Tab alt number switches tabs', () => {
        els.query.dispatchEvent(new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true, cancelable: true }));
        return els.query.value === 'SELECT * FROM v26_s';
      });
      fn('V26Tab ctrl alt t adds a tab', () => {
        const before = tabEls().length;
        els.query.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
        return tabEls().length === before + 1;
      });
      fn('V26Tab ctrl alt w closes a tab', () => {
        const before = tabEls().length;
        els.query.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
        return tabEls().length === before - 1;
      });
      fn('V26Tab setQueryValue updates the active tab', () => {
        setQueryValue('SELECT 1 AS one');
        const act = tabs.find(t => t.id === activeTabId);
        return act.sql === 'SELECT 1 AS one' && act.name === 'SELECT';
      });

      // ============================================================
      // 10. フロントエンド: 警告のコンソール出力
      // ============================================================
      fn('V26Wui warning appears in the console', () => {
        // コンソールは開いている間だけ DOM を描画するので先に開く
        document.getElementById('consoleLauncher').click();
        window.clearConsole();
        setQueryValue('DROP TABLE IF EXISTS v26_missing');
        document.getElementById('executeBtn').click();
        const body = document.getElementById('consoleBody');
        return body.textContent.includes('DDL_NOOP') && body.textContent.includes('Skipped');
      });
      fn('V26Wui clean query logs no warning', () => {
        window.clearConsole();
        setQueryValue('SELECT 1 AS a');
        document.getElementById('executeBtn').click();
        const body = document.getElementById('consoleBody');
        const ok = !body.textContent.includes('[WRN]');
        window.clearConsole();
        document.getElementById('consoleCloseBtn').click();
        return ok;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V26Cl drop objects', () => {
        ['v26_tc', 'v26_w', 'v26_js', 'v26_ov', 'v26_at', 'v26_nu', 'v26_na', 'v26_j2', 'v26_j1',
         'v26_ix', 'v26_uc', 'v26_ci', 'v26_s']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        try { localStorage.removeItem('luminadb_editor_tabs'); } catch (e) { /* 無効環境 */ }
        while (tabEls().length > 1) tabEls()[tabEls().length - 1].querySelector('[data-close-id]').click();
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
