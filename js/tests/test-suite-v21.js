    // ============================================================================
    // [Test Suite v21] - v1.16 で追加した SQL / ブラウザDB機能のテスト
    //
    //   手続き型の完成（カーソル・ハンドラ・SIGNAL・CASE 文）、期間/JSON/時系列の述語、
    //   スキーマ操作、および差分永続化・ストリーミング読み出し・タブ間追従を検証する。
    //   新しい入口のセキュリティ検査と性能予算も同スイートに含む。
    //
    //   test-suite.js の tests 配列へ getV21Tests() のスプレッドで合流する
    // ============================================================================
    function getV21Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, canaryClean } = makeTestKit('V21');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      // (id, v) にも UNIQUE を張る: v1.27 から複合 FK の参照先には
      // それに対応する PRIMARY KEY / UNIQUE が必要（V21Fk multi column が参照する）
      push('V21Fx src', "CREATE TABLE v21_src (id INTEGER PRIMARY KEY, nm TEXT, v INTEGER, UNIQUE (id, v))", r => !r.error);
      push('V21Fx src rows', "INSERT INTO v21_src VALUES (1,'a',10),(2,'b',20),(3,'c',30),(4,'d',40)", r => !r.error);
      push('V21Fx out', "CREATE TABLE v21_out (k TEXT, v INTEGER)", r => !r.error);
      push('V21Fx ev', "CREATE TABLE v21_ev (id INTEGER, ts TIMESTAMP, amt INTEGER)", r => !r.error);
      push('V21Fx ev rows', "INSERT INTO v21_ev VALUES " +
        "(1,'2026-03-01 10:05:00',5),(2,'2026-03-01 10:35:00',7),(3,'2026-03-01 11:10:00',9)," +
        "(4,'2026-03-01 11:50:00',2),(5,'2026-03-02 09:15:00',4)", r => !r.error);

      // ============================================================
      // 1. カーソル / ハンドラ / SIGNAL / CASE 文
      // ============================================================
      push('V21Cu declare+loop', "CREATE PROCEDURE v21_copy AS BEGIN " +
        "DECLARE done INT DEFAULT 0; DECLARE x INT; " +
        "DECLARE c CURSOR FOR SELECT v FROM v21_src ORDER BY id; " +
        "DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1; " +
        "OPEN c; rl: LOOP FETCH c INTO x; IF done = 1 THEN LEAVE rl; END IF; " +
        "INSERT INTO v21_out VALUES ('cur', x); END LOOP; CLOSE c; END", r => !r.error);
      push('V21Cu run', "CALL v21_copy", r => !r.error);
      push('V21Cu rows copied', "SELECT COUNT(*) AS c, SUM(v) AS s FROM v21_out WHERE k = 'cur'", r => r.data[0].c === 4 && r.data[0].s === 100);
      push('V21Cu multi column', "CREATE PROCEDURE v21_two AS BEGIN " +
        "DECLARE d INT DEFAULT 0; DECLARE a INT; DECLARE b TEXT; " +
        "DECLARE c2 CURSOR FOR SELECT id, nm FROM v21_src WHERE id <= 2 ORDER BY id; " +
        "DECLARE CONTINUE HANDLER FOR NOT FOUND SET d = 1; " +
        "OPEN c2; L: LOOP FETCH c2 INTO a, b; IF d = 1 THEN LEAVE L; END IF; " +
        "INSERT INTO v21_out VALUES (b, a); END LOOP; CLOSE c2; END", r => !r.error);
      push('V21Cu multi run', "CALL v21_two", r => !r.error);
      push('V21Cu multi check', "SELECT COUNT(*) AS c FROM v21_out WHERE k IN ('a','b')", r => r.data[0].c === 2);
      push('V21Cu reopen', "CREATE PROCEDURE v21_re AS BEGIN " +
        "DECLARE d INT DEFAULT 0; DECLARE x INT; DECLARE n INT DEFAULT 0; " +
        "DECLARE c CURSOR FOR SELECT v FROM v21_src; " +
        "DECLARE CONTINUE HANDLER FOR NOT FOUND SET d = 1; " +
        "OPEN c; L1: LOOP FETCH c INTO x; IF d = 1 THEN LEAVE L1; END IF; SET n = n + 1; END LOOP; CLOSE c; " +
        "SET d = 0; OPEN c; L2: LOOP FETCH c INTO x; IF d = 1 THEN LEAVE L2; END IF; SET n = n + 1; END LOOP; CLOSE c; " +
        "RETURN n; END", r => !r.error);
      push('V21Cu reopen run', "CALL v21_re", r => r.data[0].Result === 8);
      err('V21Cu fetch unopened', "CALL v21_bad_fetch", 'not found');
      push('V21Cu unopened proc', "CREATE PROCEDURE v21_uo AS BEGIN DECLARE x INT; DECLARE c CURSOR FOR SELECT v FROM v21_src; FETCH c INTO x; END", r => !r.error);
      err('V21Cu unopened run', "CALL v21_uo", 'not open');
      push('V21Cu undeclared proc', "CREATE PROCEDURE v21_uc AS BEGIN DECLARE x INT; OPEN nope; END", r => !r.error);
      err('V21Cu undeclared run', "CALL v21_uc", 'not declared');
      push('V21Cu arity proc', "CREATE PROCEDURE v21_ar AS BEGIN DECLARE d INT DEFAULT 0; DECLARE x INT; DECLARE c CURSOR FOR SELECT id, nm FROM v21_src; DECLARE CONTINUE HANDLER FOR NOT FOUND SET d = 1; OPEN c; FETCH c INTO x; CLOSE c; END", r => !r.error);
      err('V21Cu arity run', "CALL v21_ar", '2 column');
      err('V21Cu bad fetch syntax', "CREATE PROCEDURE v21_bf AS BEGIN FETCH INTO x; END", 'fetch');

      push('V21Hd continue sqlexception', "CREATE PROCEDURE v21_h1 AS BEGIN DECLARE s TEXT DEFAULT 'ok'; " +
        "DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET s = 'caught'; SELECT * FROM v21_no_table; RETURN s; END", r => !r.error);
      push('V21Hd continue run', "CALL v21_h1", r => r.data[0].Result === 'caught');
      push('V21Hd exit handler', "CREATE PROCEDURE v21_h2 AS BEGIN " +
        "DECLARE EXIT HANDLER FOR SQLEXCEPTION INSERT INTO v21_out VALUES ('exit', 1); " +
        "SELECT * FROM v21_no_table; INSERT INTO v21_out VALUES ('after', 1); END", r => !r.error);
      push('V21Hd exit run', "CALL v21_h2", r => !r.error);
      push('V21Hd exit stopped', "SELECT COUNT(*) AS c FROM v21_out WHERE k = 'after'", r => r.data[0].c === 0);
      push('V21Hd exit ran', "SELECT COUNT(*) AS c FROM v21_out WHERE k = 'exit'", r => r.data[0].c === 1);
      push('V21Hd sqlstate handler', "CREATE PROCEDURE v21_h3 AS BEGIN DECLARE m TEXT DEFAULT 'none'; " +
        "DECLARE CONTINUE HANDLER FOR SQLSTATE '45000' SET m = 'got'; " +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x'; RETURN m; END", r => !r.error);
      push('V21Hd sqlstate run', "CALL v21_h3", r => r.data[0].Result === 'got');
      push('V21Hd notfound not caught by sqlstate', "CREATE PROCEDURE v21_h4 AS BEGIN DECLARE x INT; " +
        "DECLARE c CURSOR FOR SELECT v FROM v21_src WHERE 1 = 0; " +
        "DECLARE CONTINUE HANDLER FOR SQLSTATE '45000' SET x = 1; OPEN c; FETCH c INTO x; CLOSE c; END", r => !r.error);
      err('V21Hd notfound uncaught', "CALL v21_h4", 'no data');
      err('V21Hd bad handler', "CREATE PROCEDURE v21_hb AS BEGIN DECLARE CONTINUE HANDLER FOR WEIRD SET x = 1; END", 'handler');

      push('V21Sg raise', "CREATE PROCEDURE v21_sig(n) AS BEGIN IF n < 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'negative not allowed'; END IF; RETURN n; END", r => !r.error);
      push('V21Sg ok path', "CALL v21_sig(5)", r => r.data[0].Result === 5);
      err('V21Sg raised', "CALL v21_sig(-1)", 'negative not allowed');
      push('V21Sg default state', "CREATE PROCEDURE v21_sig2 AS BEGIN SIGNAL SET MESSAGE_TEXT = 'plain'; END", r => !r.error);
      err('V21Sg default run', "CALL v21_sig2", 'plain');

      push('V21Cs simple', "CREATE PROCEDURE v21_cs(n) AS BEGIN CASE n WHEN 1 THEN RETURN 'one'; WHEN 2 THEN RETURN 'two'; ELSE RETURN 'many'; END CASE; END", r => !r.error);
      push('V21Cs one', "CALL v21_cs(1)", r => r.data[0].Result === 'one');
      push('V21Cs two', "CALL v21_cs(2)", r => r.data[0].Result === 'two');
      push('V21Cs many', "CALL v21_cs(7)", r => r.data[0].Result === 'many');
      push('V21Cs searched', "CREATE PROCEDURE v21_cs2(n) AS BEGIN CASE WHEN n > 100 THEN RETURN 'big'; WHEN n > 10 THEN RETURN 'mid'; ELSE RETURN 'small'; END CASE; END", r => !r.error);
      push('V21Cs searched big', "CALL v21_cs2(500)", r => r.data[0].Result === 'big');
      push('V21Cs searched mid', "CALL v21_cs2(50)", r => r.data[0].Result === 'mid');
      push('V21Cs searched small', "CALL v21_cs2(1)", r => r.data[0].Result === 'small');
      push('V21Cs no else', "CREATE PROCEDURE v21_cs3(n) AS BEGIN CASE n WHEN 1 THEN RETURN 'one'; END CASE; END", r => !r.error);
      err('V21Cs unmatched', "CALL v21_cs3(9)", 'case not found');
      err('V21Cs missing end', "CREATE PROCEDURE v21_cs4 AS BEGIN CASE WHEN 1 = 1 THEN RETURN 1; END", 'syntax');
      push('V21Cs expr still works', "SELECT CASE WHEN 1 = 1 THEN 'y' ELSE 'n' END AS x", r => r.data[0].x === 'y');

      // ============================================================
      // 2. OVERLAPS / IS JSON / JSON_EXISTS / JSON_QUERY / BETWEEN SYMMETRIC
      // ============================================================
      const OV = [
        ["(DATE '2026-01-01', DATE '2026-06-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01')", true],
        ["(DATE '2026-01-01', DATE '2026-02-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01')", false],
        ["(DATE '2026-03-01', DATE '2026-09-01') OVERLAPS (DATE '2026-01-01', DATE '2026-06-01')", true],
        ["(DATE '2026-01-01', DATE '2026-03-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01')", false],
        ["(DATE '2026-06-01', DATE '2026-01-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01')", true],
        ["(DATE '2026-02-01', DATE '2026-02-01') OVERLAPS (DATE '2026-01-01', DATE '2026-03-01')", true],
        ["(DATE '2026-05-01', DATE '2026-05-01') OVERLAPS (DATE '2026-01-01', DATE '2026-03-01')", false]
      ];
      OV.forEach(([e, want], i) => push(`V21Ov ${i}`, `SELECT ${e} AS x`, r => r.data[0].x === want));
      push('V21Ov null', "SELECT (NULL, DATE '2026-01-01') OVERLAPS (DATE '2026-01-01', DATE '2026-02-01') AS x", r => r.data[0].x === null);
      err('V21Ov arity', "SELECT (DATE '2026-01-01') OVERLAPS (DATE '2026-01-01', DATE '2026-02-01') AS x", 'overlaps');

      push('V21Js valid', "SELECT '{\"a\":1}' IS JSON AS x", r => r.data[0].x === true);
      push('V21Js invalid', "SELECT 'nope' IS JSON AS x", r => r.data[0].x === false);
      push('V21Js not json', "SELECT 'nope' IS NOT JSON AS x", r => r.data[0].x === true);
      push('V21Js object', "SELECT '{\"a\":1}' IS JSON OBJECT AS x, '[1]' IS JSON OBJECT AS y", r => r.data[0].x === true && r.data[0].y === false);
      push('V21Js array', "SELECT '[1,2]' IS JSON ARRAY AS x", r => r.data[0].x === true);
      push('V21Js scalar', "SELECT '5' IS JSON SCALAR AS x, '{}' IS JSON SCALAR AS y", r => r.data[0].x === true && r.data[0].y === false);
      push('V21Js null input', "SELECT (NULL) IS JSON AS x", r => r.data[0].x === null);
      push('V21Js exists', "SELECT JSON_EXISTS('{\"a\":1}', '$.a') AS x, JSON_EXISTS('{\"a\":1}', '$.b') AS y", r => r.data[0].x === true && r.data[0].y === false);
      push('V21Js exists nested', "SELECT JSON_EXISTS('{\"a\":{\"b\":2}}', '$.a.b') AS x", r => r.data[0].x === true);
      push('V21Js query object', "SELECT JSON_QUERY('{\"a\":{\"b\":1}}', '$.a') AS x", r => r.data[0].x === '{"b":1}');
      push('V21Js query scalar null', "SELECT JSON_QUERY('{\"a\":1}', '$.a') AS x", r => r.data[0].x === null);
      push('V21Js query array', "SELECT JSON_QUERY('{\"a\":[1,2]}', '$.a') AS x", r => r.data[0].x === '[1,2]');
      push('V21Js filter rows', "SELECT COUNT(*) AS c FROM v21_src WHERE '{\"k\":1}' IS JSON", r => r.data[0].c === 4);

      push('V21Bs reversed', "SELECT COUNT(*) AS c FROM v21_src WHERE v BETWEEN SYMMETRIC 30 AND 10", r => r.data[0].c === 3);
      push('V21Bs normal order', "SELECT COUNT(*) AS c FROM v21_src WHERE v BETWEEN SYMMETRIC 10 AND 30", r => r.data[0].c === 3);
      push('V21Bs plain unaffected', "SELECT COUNT(*) AS c FROM v21_src WHERE v BETWEEN 30 AND 10", r => r.data[0].c === 0);
      push('V21Bs not', "SELECT COUNT(*) AS c FROM v21_src WHERE v NOT BETWEEN SYMMETRIC 30 AND 10", r => r.data[0].c === 1);

      // ============================================================
      // 3. 時系列 / 期間の関数（DATE_BIN / TIME_BUCKET / AGE / EXTRACT 拡張）
      // ============================================================
      push('V21Tb hour', "SELECT DATE_BIN(INTERVAL 1 HOUR, TIMESTAMP '2026-03-01 10:37:00') AS b", r => r.data[0].b === '2026-03-01 10:00:00');
      push('V21Tb 15min', "SELECT TIME_BUCKET(INTERVAL 15 MINUTE, TIMESTAMP '2026-03-01 10:37:00') AS b", r => r.data[0].b === '2026-03-01 10:30:00');
      push('V21Tb day', "SELECT DATE_BIN(INTERVAL 1 DAY, TIMESTAMP '2026-03-01 10:37:00') AS b", r => r.data[0].b === '2026-03-01 00:00:00');
      push('V21Tb month', "SELECT DATE_BIN(INTERVAL 1 MONTH, TIMESTAMP '2026-05-17 10:37:00') AS b", r => r.data[0].b === '2026-05-01 00:00:00');
      push('V21Tb year', "SELECT DATE_BIN(INTERVAL 1 YEAR, TIMESTAMP '2026-05-17 10:37:00') AS b", r => r.data[0].b === '2026-01-01 00:00:00');
      push('V21Tb origin', "SELECT DATE_BIN(INTERVAL 1 HOUR, TIMESTAMP '2026-03-01 10:37:00', TIMESTAMP '2026-03-01 00:20:00') AS b", r => r.data[0].b === '2026-03-01 10:20:00');
      push('V21Tb null', "SELECT DATE_BIN(INTERVAL 1 HOUR, NULL) AS b", r => r.data[0].b === null);
      push('V21Tb group by bucket', "SELECT DATE_BIN(INTERVAL 1 HOUR, ts) AS b, SUM(amt) AS s FROM v21_ev GROUP BY DATE_BIN(INTERVAL 1 HOUR, ts) ORDER BY b",
        r => r.data.length === 3 && r.data[0].s === 12 && r.data[1].s === 11);
      err('V21Tb zero interval', "SELECT DATE_BIN(INTERVAL 0 HOUR, TIMESTAMP '2026-03-01 10:00:00') AS b", 'positive interval');
      push('V21Ag months', "SELECT AGE(DATE '2026-03-15', DATE '2026-01-01') AS a", r => r.data[0].a === '2 mons 14 days');
      push('V21Ag years', "SELECT AGE(DATE '2028-03-15', DATE '2026-01-20') AS a", r => r.data[0].a === '2 years 1 mon 24 days');
      push('V21Ag days only', "SELECT AGE(DATE '2026-01-10', DATE '2026-01-01') AS a", r => r.data[0].a === '9 days');
      push('V21Ag negative', "SELECT AGE(DATE '2026-01-01', DATE '2026-03-15') AS a", r => String(r.data[0].a).indexOf('-') === 0);
      push('V21Ag null', "SELECT AGE(NULL, DATE '2026-01-01') AS a", r => r.data[0].a === null);
      push('V21Ex epoch', "SELECT EXTRACT(EPOCH FROM TIMESTAMP '2020-01-01 00:00:00') AS e", r => r.data[0].e === 1577836800);
      push('V21Ex dow', "SELECT EXTRACT(DOW FROM DATE '2026-03-01') AS d", r => r.data[0].d === 0);
      push('V21Ex doy', "SELECT EXTRACT(DOY FROM DATE '2026-02-01') AS d", r => r.data[0].d === 32);
      push('V21Ex existing units', "SELECT EXTRACT(YEAR FROM DATE '2026-03-01') AS y, EXTRACT(MONTH FROM DATE '2026-03-01') AS m", r => r.data[0].y === 2026 && r.data[0].m === 3);

      // ============================================================
      // 4. スキーマ操作 / 部分インデックス / 多列FK / ロック句 / CTE ヒント
      // ============================================================
      push('V21Sc create schema', "CREATE SCHEMA v21app", r => !r.error);
      push('V21Sc drop schema', "DROP SCHEMA v21app", r => !r.error);
      push('V21Sc qualified main', "SELECT COUNT(*) AS c FROM main.v21_src", r => r.data[0].c === 4);
      push('V21Sc qualified public', "SELECT COUNT(*) AS c FROM public.v21_src", r => r.data[0].c === 4);
      push('V21Sc qualified alias', "SELECT s.nm FROM main.v21_src s WHERE s.id = 1", r => r.data[0].nm === 'a');
      push('V21Sc qualified join', "SELECT COUNT(*) AS c FROM main.v21_src a JOIN main.v21_src b ON a.id = b.id", r => r.data[0].c === 4);
      err('V21Sc bad schema stmt', "CREATE SCHEMA", 'syntax');
      push('V21Pi partial index', "CREATE INDEX v21_pi ON v21_src (v) WHERE v > 15", r => !r.error && /partial predicate/.test(r.data[0].Message));
      push('V21Pi still correct', "SELECT COUNT(*) AS c FROM v21_src WHERE v = 10", r => r.data[0].c === 1);
      push('V21Pi index used', "EXPLAIN SELECT * FROM v21_src WHERE v = 20", r => r.data[0].Operation === 'INDEX SCAN');
      push('V21Pi drop', "DROP INDEX v21_pi", r => !r.error);
      err('V21Pi bad predicate', "CREATE INDEX v21_pb ON v21_src (v) WHERE nope > 1", 'not found');
      // v1.19: 複合 FOREIGN KEY をサポート（旧: 明示エラー）。列数の不一致は引き続き拒否する
      push('V21Fk multi column', "CREATE TABLE v21_mfk (a INT, b INT, FOREIGN KEY (a, b) REFERENCES v21_src(id, v))", r => !r.error);
      err('V21Fk multi column arity', "CREATE TABLE v21_mfk2 (a INT, b INT, FOREIGN KEY (a, b) REFERENCES v21_src(id))", 'has 2 columns but references 1');
      fn('V21Fk multi column enforced', () => {
          const bad = db.executeQuery("INSERT INTO v21_mfk VALUES (99999, 88888)");
          db.executeQuery("DROP TABLE v21_mfk");
          return bad.error !== undefined && bad.error.includes('Foreign key');
      });
      err('V21Fk malformed', "CREATE TABLE v21_mf2 (a INT, FOREIGN KEY a REFERENCES v21_src)", 'foreign key');
      push('V21Fk single ok', "CREATE TABLE v21_fk (a INT, FOREIGN KEY (a) REFERENCES v21_src(id))", r => !r.error);
      push('V21Fk no phantom column', "SELECT COUNT(*) AS c FROM information_schema.columns WHERE TABLE_NAME = 'v21_fk'", r => r.data[0].c === 1);
      push('V21Fk enforced', "INSERT INTO v21_fk VALUES (1)", r => !r.error);
      err('V21Fk violation', "INSERT INTO v21_fk VALUES (99)", 'foreign key');
      push('V21Fk cleanup', "DROP TABLE v21_fk", r => !r.error);
      push('V21Lk for update', "SELECT COUNT(*) AS c FROM v21_src FOR UPDATE", r => r.data[0].c === 4);
      push('V21Lk for share', "SELECT COUNT(*) AS c FROM v21_src FOR SHARE", r => r.data[0].c === 4);
      push('V21Lk nowait', "SELECT COUNT(*) AS c FROM v21_src FOR UPDATE NOWAIT", r => r.data[0].c === 4);
      push('V21Lk skip locked', "SELECT COUNT(*) AS c FROM v21_src FOR UPDATE SKIP LOCKED", r => r.data[0].c === 4);
      push('V21Ct materialized', "WITH c AS MATERIALIZED (SELECT 1 AS x) SELECT * FROM c", r => r.data[0].x === 1);
      push('V21Ct not materialized', "WITH c AS NOT MATERIALIZED (SELECT 2 AS x) SELECT * FROM c", r => r.data[0].x === 2);
      push('V21Ct with cols', "WITH c (y) AS MATERIALIZED (SELECT 3) SELECT y FROM c", r => r.data[0].y === 3);
      push('V21Ep query plan', "EXPLAIN QUERY PLAN SELECT * FROM v21_src", r => r.data[0].Operation === 'TABLE SCAN');
      push('V21Ep query plan index', "EXPLAIN QUERY PLAN SELECT * FROM v21_src WHERE id = 1", r => r.data[0].Operation === 'INDEX SCAN');

      // ============================================================
      // 5. ブラウザDB: 差分永続化 / ストリーミング / タブ間追従
      // ============================================================
      fn('V21Ps chunked format', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          await saveDB(db.exportForIDB());
          const idb = await initDB();
          const get = (k) => new Promise((res, rej) => {
            const tx = idb.transaction('snapshots', 'readonly');
            const rq = tx.objectStore('snapshots').get(k);
            rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
          });
          const meta = await get('meta');
          const tbl = await get('tbl:v21_src');
          return !!meta && !!tbl && (await get('latest')) === undefined;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps skips unchanged tables', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          await saveDB(db.exportForIDB());
          const first = LuminaDB.saveStats();
          // 何も変えずにもう一度保存 → 1 テーブルも書き直さない
          await saveDB(db.exportForIDB());
          const second = LuminaDB.saveStats();
          return first.written > 0 && second.written === 0 && second.skipped === second.tables;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps writes only the changed table', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          await saveDB(db.exportForIDB());
          db.executeQuery("INSERT INTO v21_out VALUES ('delta', 1)");
          await saveDB(db.exportForIDB());
          const st = LuminaDB.saveStats();
          db.executeQuery("DELETE FROM v21_out WHERE k = 'delta'");
          return st.written === 1 && st.skipped === st.tables - 1;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps in-place update detected', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          await saveDB(db.exportForIDB());
          // 行数が変わらない UPDATE でも指紋（変更世代）で拾えること
          db.executeQuery("UPDATE v21_src SET v = v + 1 WHERE id = 1");
          await saveDB(db.exportForIDB());
          const st = LuminaDB.saveStats();
          db.executeQuery("UPDATE v21_src SET v = v - 1 WHERE id = 1");
          return st.written === 1;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      // --- 列単位の差分保存（chunked-v2） ---------------------------------
      // 1 列を直しただけで全列を暗号化し直していたので、列ごとにレコードを分けた。
      // 見るのは「書いた列数」と「読み直して同じ値が戻るか」の 2 点
      fn('V21Ps 1 列だけ直したら 1 列だけ書く', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          db.executeQuery("DROP TABLE IF EXISTS v21_gran");
          db.executeQuery("CREATE TABLE v21_gran (id INTEGER, a TEXT, b TEXT, c INTEGER)");
          db.executeQuery("INSERT INTO v21_gran VALUES (1,'x','y',10),(2,'z','w',20)");
          await saveDB(db.exportForIDB());
          const full = LuminaDB.saveStats();
          db.executeQuery("UPDATE v21_gran SET a = 'changed' WHERE id = 1");
          await saveDB(db.exportForIDB());
          const one = LuminaDB.saveStats();
          db.executeQuery("DROP TABLE v21_gran");
          // 初回は DB 全体（他の表も含む）を書くので、この表の 4 列以上になる
          if (full.writtenColumns < 4) throw new Error('初回は全列を書くはず: ' + full.writtenColumns);
          // 2 回目は 1 列だけ直したので、書かれる列はちょうど 1 つ
          if (one.writtenColumns !== 1) throw new Error('1 列だけ書くはず: ' + one.writtenColumns);
          return true;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps 何も変えなければ 1 列も書かない', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          db.executeQuery("DROP TABLE IF EXISTS v21_gran2");
          db.executeQuery("CREATE TABLE v21_gran2 (id INTEGER, a TEXT)");
          db.executeQuery("INSERT INTO v21_gran2 VALUES (1,'x')");
          await saveDB(db.exportForIDB());
          await saveDB(db.exportForIDB());
          const st = LuminaDB.saveStats();
          db.executeQuery("DROP TABLE v21_gran2");
          if (st.writtenColumns !== 0) throw new Error('書き直すべきではない: ' + st.writtenColumns);
          return true;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps 取り込み後に直した列が保存される', async () => {
        // 変更世代を保存しないと、取り込みで採番が 0 からやり直しになり、
        // 保存済みの指紋と偶然一致して「変わっていない」と判定されうる
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          db.executeQuery("DROP TABLE IF EXISTS v21_rt");
          db.executeQuery("CREATE TABLE v21_rt (id INTEGER, info TEXT)");
          db.executeQuery("INSERT INTO v21_rt VALUES (1,'Created')");
          await saveDB(db.exportForIDB());
          const eng = new DatabaseEngine();
          eng.importFromIDB(await loadDB());
          eng.tables['v21_rt'].setValue('info', 0, 'Updated');
          await saveDB(eng.exportForIDB());
          const eng2 = new DatabaseEngine();
          eng2.importFromIDB(await loadDB());
          const got = eng2.tables['v21_rt'].getValue('info', 0);
          db.executeQuery("DROP TABLE v21_rt");
          if (got !== 'Updated') throw new Error('取り込み後の変更が保存されていない: ' + got);
          return true;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps roundtrip after incremental save', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          await saveDB(db.exportForIDB());
          db.executeQuery("INSERT INTO v21_out VALUES ('rt', 42)");
          await saveDB(db.exportForIDB());
          const loaded = await loadDB();
          const eng = new DatabaseEngine();
          eng.importFromIDB(loaded);
          const a = eng.executeQuery("SELECT COUNT(*) AS c FROM v21_out WHERE k = 'rt'").data[0].c;
          const b = eng.executeQuery("SELECT COUNT(*) AS c FROM v21_src").data[0].c;
          db.executeQuery("DELETE FROM v21_out WHERE k = 'rt'");
          return a === 1 && b === 4;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps dropped table removed', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          db.executeQuery("CREATE TABLE v21_tmp_drop (x INTEGER)");
          await saveDB(db.exportForIDB());
          db.executeQuery("DROP TABLE v21_tmp_drop");
          await saveDB(db.exportForIDB());
          const st = LuminaDB.saveStats();
          const loaded = await loadDB();
          return st.removed === 1 && loaded.v21_tmp_drop === undefined;
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });
      fn('V21Ps table version bumps', () => {
        const t = db.tables['v21_src'];
        const before = t.version;
        db.executeQuery("UPDATE v21_src SET v = v WHERE id = 1");
        return t.version > before;
      });
      fn('V21Ps unsaved-changes guard exists', () => typeof hasUnsavedChanges === 'function');
      fn('V21Ps auto-reload toggle', () => {
        const before = LuminaDB.autoReload();
        LuminaDB.autoReload(true);
        const on = LuminaDB.autoReload();
        LuminaDB.autoReload(before);
        return on === true && LuminaDB.autoReload() === before;
      });

      fn('V21St fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v21_big");
        db.executeQuery("CREATE TABLE v21_big (id INTEGER, n INTEGER)");
        const r = db.executeQuery("INSERT INTO v21_big SELECT value, MOD(value * 7, 1000) FROM GENERATE_SERIES(1, 5000)");
        return !r.error && db.tables['v21_big'].rowCount === 5000;
      });
      fn('V21St eachBatch covers all rows', () => {
        let rows = 0, batches = 0, maxBatch = 0;
        const res = LuminaDB.eachBatch('SELECT id FROM v21_big ORDER BY id', [], 500, (chunk) => {
          rows += chunk.length; batches++; maxBatch = Math.max(maxBatch, chunk.length);
        });
        return rows === 5000 && batches === 10 && maxBatch === 500 && res.rows === 5000;
      });
      fn('V21St eachBatch order preserved', () => {
        let first = null, lastId = 0, ordered = true;
        LuminaDB.eachBatch('SELECT id FROM v21_big ORDER BY id', [], 1000, (chunk) => {
          if (first === null) first = chunk[0].id;
          chunk.forEach(r => { if (r.id <= lastId) ordered = false; lastId = r.id; });
        });
        return first === 1 && lastId === 5000 && ordered;
      });
      fn('V21St eachBatch early stop', () => {
        let batches = 0;
        const res = LuminaDB.eachBatch('SELECT id FROM v21_big ORDER BY id', [], 100, () => { batches++; return false; });
        return batches === 1 && res.batches === 1;
      });
      fn('V21St eachBatch with params', () => {
        let rows = 0;
        LuminaDB.eachBatch('SELECT id FROM v21_big WHERE n > ? ORDER BY id', [990], 100, c => { rows += c.length; });
        const want = LuminaDB.value('SELECT COUNT(*) AS c FROM v21_big WHERE n > 990');
        return rows === want;
      });
      fn('V21St cursor iterates', () => {
        let n = 0, sum = 0;
        for (const row of LuminaDB.cursor('SELECT id FROM v21_big ORDER BY id', [], 777)) { n++; sum += row.id; }
        return n === 5000 && sum === (5000 * 5001) / 2;
      });
      fn('V21St cursor can break early', () => {
        let n = 0;
        for (const row of LuminaDB.cursor('SELECT id FROM v21_big ORDER BY id', [], 100)) { n++; if (n >= 5) break; }
        return n === 5;
      });
      fn('V21St rejects writes', () => {
        try { LuminaDB.eachBatch('DELETE FROM v21_big', [], 10, () => {}); return false; }
        catch (e) { return /read-only/.test(e.message) && LuminaDB.value('SELECT COUNT(*) AS c FROM v21_big') === 5000; }
      });
      fn('V21St rejects own limit', () => {
        try { LuminaDB.eachBatch('SELECT id FROM v21_big LIMIT 10', [], 10, () => {}); return false; }
        catch (e) { return /LIMIT\/OFFSET/.test(e.message); }
      });
      fn('V21St empty result', () => {
        const res = LuminaDB.eachBatch('SELECT id FROM v21_big WHERE id < 0', [], 100, () => {});
        return res.rows === 0 && res.batches === 0;
      });

      // ============================================================
      // 6. 新しい入口のセキュリティ
      // ============================================================
      const PAYLOADS = [
        "'; DROP TABLE v21_src; --",
        "` + (window.__v21_pwned = 1) + `",
        "${window.__v21_pwned = 1}",
        "'); window.__v21_pwned = 1; ('",
        "__proto__",
        "constructor.prototype.__v21_polluted",
        "line1\nline2",
        "</script><img src=x onerror=alert(1)>"
      ];
      PAYLOADS.forEach((p, i) => {
        // カーソルが返す値はあくまでデータ。ループ内の SQL へ差し込まれても構造は変わらない
        fn(`V21Sec cursor value ${i}`, () => {
          db.executeQuery("DROP TABLE IF EXISTS v21_pay");
          db.executeQuery("CREATE TABLE v21_pay (s TEXT)");
          LuminaDB.insert('v21_pay', { s: p });
          db.executeQuery("CREATE OR REPLACE PROCEDURE v21_scan AS BEGIN " +
            "DECLARE d INT DEFAULT 0; DECLARE val TEXT; DECLARE c CURSOR FOR SELECT s FROM v21_pay; " +
            "DECLARE CONTINUE HANDLER FOR NOT FOUND SET d = 1; OPEN c; " +
            "L: LOOP FETCH c INTO val; IF d = 1 THEN LEAVE L; END IF; INSERT INTO v21_out VALUES (val, 1); END LOOP; CLOSE c; END");
          const r = db.executeQuery("CALL v21_scan");
          const got = LuminaDB.value("SELECT k FROM v21_out WHERE v = 1 ORDER BY k LIMIT 1");
          const intact = LuminaDB.value("SELECT COUNT(*) AS c FROM v21_src") === 4;
          db.executeQuery("DELETE FROM v21_out WHERE v = 1");
          db.executeQuery("DROP TABLE IF EXISTS v21_pay");
          db.executeQuery("DROP PROCEDURE IF EXISTS v21_scan");
          return !r.error && got === p && intact && canaryClean();
        });
        // SIGNAL のメッセージ本文
        fn(`V21Sec signal text ${i}`, () => {
          const q = "'" + p.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
          db.executeQuery(`CREATE OR REPLACE PROCEDURE v21_sg AS BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${q}; END`);
          const r = db.executeQuery("CALL v21_sg");
          db.executeQuery("DROP PROCEDURE IF EXISTS v21_sg");
          const intact = LuminaDB.value("SELECT COUNT(*) AS c FROM v21_src") === 4;
          return !!r.error && intact && canaryClean();
        });
        // IS JSON / JSON_EXISTS へ渡す文書
        fn(`V21Sec json predicate ${i}`, () => {
          const r = LuminaDB.query('SELECT (? IS JSON) AS a, JSON_EXISTS(?, ?) AS b', [p, p, '$.x']);
          return !r.error && r.data[0].a === false && r.data[0].b === false && canaryClean();
        });
        // eachBatch の SQL 断片としては使えない（値としてのみ）
        fn(`V21Sec eachBatch param ${i}`, () => {
          let seen = 0;
          LuminaDB.eachBatch('SELECT id FROM v21_src WHERE nm = ? ORDER BY id', [p], 10, c => { seen += c.length; });
          return seen === 0 && LuminaDB.value('SELECT COUNT(*) AS c FROM v21_src') === 4 && canaryClean();
        });
      });
      fn('V21Sec proc handler cannot swallow timeout', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v21_spin AS BEGIN DECLARE i INT DEFAULT 0; " +
          "DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET i = 0; WHILE 1 = 1 DO SET i = i + 1; END WHILE; END");
        db.statementTimeoutMs = 120;
        const r = db.executeQuery("CALL v21_spin");
        db.statementTimeoutMs = 0;
        db.executeQuery("DROP PROCEDURE IF EXISTS v21_spin");
        return !!r.error && /timeout|iterations/i.test(r.error);
      });
      fn('V21Sec cursor read-only mode', () => {
        db.executeQuery("SET read_only = ON");
        const r = db.executeQuery("CALL v21_copy");
        db.executeQuery("SET read_only = OFF");
        return !!r.error && /read-only/i.test(r.error);
      });
      fn('V21Sec schema stmt read-only', () => {
        db.executeQuery("SET read_only = ON");
        const r = db.executeQuery("CREATE SCHEMA v21_ro");
        db.executeQuery("SET read_only = OFF");
        return !!r.error && /read-only/i.test(r.error);
      });
      fn('V21Sec canary clean', () => canaryClean());

      // ============================================================
      // 7. 性能予算
      // ============================================================
      const perf = (name, sql, capMs, check) => fn(name, () => {
        const r = db.executeQuery(sql);
        if (r.error) return false;
        if (check && !check(r)) return false;
        return Number(r.executionTime) < capMs;
      });
      perf('V21Pf date_bin 5k', "SELECT COUNT(DISTINCT DATE_BIN(INTERVAL 1 HOUR, TIMESTAMP '2026-03-01 10:00:00')) AS c FROM v21_big", 1200, r => r.data[0].c === 1);
      perf('V21Pf is json 5k', "SELECT COUNT(*) AS c FROM v21_big WHERE '{\"a\":1}' IS JSON", 900, r => r.data[0].c === 5000);
      perf('V21Pf overlaps 5k', "SELECT COUNT(*) AS c FROM v21_big WHERE (DATE '2026-01-01', DATE '2026-06-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01')", 1200, r => r.data[0].c === 5000);
      perf('V21Pf between symmetric 5k', "SELECT COUNT(*) AS c FROM v21_big WHERE n BETWEEN SYMMETRIC 800 AND 200", 900, r => r.data[0].c > 0);
      fn('V21Pf cursor loop 1000 rows', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v21_bench AS BEGIN DECLARE d INT DEFAULT 0; DECLARE x INT; DECLARE s INT DEFAULT 0; " +
          "DECLARE c CURSOR FOR SELECT n FROM v21_big WHERE id <= 1000; DECLARE CONTINUE HANDLER FOR NOT FOUND SET d = 1; " +
          "OPEN c; L: LOOP FETCH c INTO x; IF d = 1 THEN LEAVE L; END IF; SET s = s + x; END LOOP; CLOSE c; RETURN s; END");
        const t0 = performance.now();
        const r = db.executeQuery("CALL v21_bench");
        const ms = performance.now() - t0;
        db.executeQuery("DROP PROCEDURE IF EXISTS v21_bench");
        const want = db.executeQuery("SELECT SUM(n) AS s FROM v21_big WHERE id <= 1000").data[0].s;
        return !r.error && r.data[0].Result === want && ms < 5000;
      });
      fn('V21Pf eachBatch 5k under budget', () => {
        const t0 = performance.now();
        let rows = 0;
        LuminaDB.eachBatch('SELECT id, n FROM v21_big ORDER BY id', [], 1000, c => { rows += c.length; });
        return rows === 5000 && (performance.now() - t0) < 3000;
      });
      fn('V21Pf incremental save beats full', async () => {
        const original = await loadDB().catch(() => undefined);
        try {
          await clearDB();
          db.executeQuery("DROP TABLE IF EXISTS v21_bulk");
          db.executeQuery("CREATE TABLE v21_bulk (id INTEGER, n INTEGER)");
          db.executeQuery("INSERT INTO v21_bulk SELECT value, value FROM GENERATE_SERIES(1, 30000)");
          const t0 = performance.now();
          await saveDB(db.exportForIDB());           // 初回＝全書き込み
          const fullMs = performance.now() - t0;
          db.executeQuery("INSERT INTO v21_out VALUES ('tiny', 1)");
          const t1 = performance.now();
          await saveDB(db.exportForIDB());           // 2 回目＝小さい表だけ
          const deltaMs = performance.now() - t1;
          const st = LuminaDB.saveStats();
          db.executeQuery("DELETE FROM v21_out WHERE k = 'tiny'");
          db.executeQuery("DROP TABLE IF EXISTS v21_bulk");
          // 大きい表を書き直していない＝差分保存が効いている
          return st.written === 1 && deltaMs <= Math.max(fullMs * 0.7, 30);
        } finally {
          if (original !== undefined) { await clearDB(); await saveDB(original); } else { await clearDB(); }
        }
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V21Cl drop procs', () => {
        ['v21_copy','v21_two','v21_re','v21_uo','v21_uc','v21_ar','v21_h1','v21_h2','v21_h3','v21_h4',
         'v21_sig','v21_sig2','v21_cs','v21_cs2','v21_cs3'].forEach(p => db.executeQuery(`DROP PROCEDURE IF EXISTS ${p}`));
        return true;
      });
      fn('V21Cl drop tables', () => {
        ['v21_big','v21_ev','v21_out','v21_src'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        return true;
      });

      return T;
    }
