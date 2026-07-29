    // ============================================================================
    // [Test Suite v22] - v1.17 で追加した SQL / ブラウザDB機能のテスト
    //
    //   配列・統計集計・あいまい照合・時系列生成・ウィンドウ拡張と、
    //   式コンパイルキャッシュ・CSV 取り込み・リーダー選出を検証する。
    //   新しい入口のセキュリティ検査と性能予算も同スイートに含む。
    //
    //   test-suite.js の tests 配列へ getV22Tests() のスプレッドで合流する
    // ============================================================================
    function getV22Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      const canaryClean = () => window.__v22_pwned === undefined && ({}).__v22_polluted === undefined;

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      push('V22Fx xy', "CREATE TABLE v22_xy (x INTEGER, y INTEGER)", r => !r.error);
      push('V22Fx xy rows', "INSERT INTO v22_xy VALUES (1,3),(2,5),(3,7),(4,9),(5,11)", r => !r.error);
      push('V22Fx names', "CREATE TABLE v22_nm (id INTEGER PRIMARY KEY, nm TEXT, grp TEXT, v INTEGER)", r => !r.error);
      push('V22Fx names rows', "INSERT INTO v22_nm VALUES (1,'kitten','a',10),(2,'sitting','a',10),(3,'Robert','b',20),(4,'Rupert','b',30),(5,'kitten','b',30)", r => !r.error);

      // ============================================================
      // 1. 配列
      // ============================================================
      push('V22Ar length', "SELECT ARRAY_LENGTH(ARRAY[1,2,3]) AS n", r => r.data[0].n === 3);
      push('V22Ar empty', "SELECT ARRAY_LENGTH(ARRAY[]) AS n", r => r.data[0].n === 0);
      push('V22Ar to_string', "SELECT ARRAY_TO_STRING(ARRAY[1,2,3], '-') AS s", r => r.data[0].s === '1-2-3');
      push('V22Ar to_string nulls skipped', "SELECT ARRAY_TO_STRING(ARRAY[1,NULL,3], '-') AS s", r => r.data[0].s === '1-3');
      push('V22Ar to_string null repl', "SELECT ARRAY_TO_STRING(ARRAY[1,NULL,3], '-', 'x') AS s", r => r.data[0].s === '1-x-3');
      push('V22Ar position', "SELECT ARRAY_POSITION(ARRAY['a','b','c'], 'b') AS p", r => r.data[0].p === 2);
      push('V22Ar position missing', "SELECT ARRAY_POSITION(ARRAY['a'], 'z') AS p", r => r.data[0].p === null);
      push('V22Ar contains', "SELECT ARRAY_CONTAINS(ARRAY[1,2], 2) AS a, ARRAY_CONTAINS(ARRAY[1,2], 9) AS b", r => r.data[0].a === true && r.data[0].b === false);
      push('V22Ar append', "SELECT ARRAY_TO_STRING(ARRAY_APPEND(ARRAY[1,2], 3), ',') AS s", r => r.data[0].s === '1,2,3');
      push('V22Ar prepend', "SELECT ARRAY_TO_STRING(ARRAY_PREPEND(0, ARRAY[1,2]), ',') AS s", r => r.data[0].s === '0,1,2');
      push('V22Ar remove', "SELECT ARRAY_TO_STRING(ARRAY_REMOVE(ARRAY[1,2,3,2], 2), ',') AS s", r => r.data[0].s === '1,3');
      push('V22Ar sort', "SELECT ARRAY_TO_STRING(ARRAY_SORT(ARRAY[3,1,2]), ',') AS s", r => r.data[0].s === '1,2,3');
      push('V22Ar string_to_array', "SELECT ARRAY_TO_STRING(STRING_TO_ARRAY('a,b,c', ','), '|') AS s", r => r.data[0].s === 'a|b|c');
      push('V22Ar string_to_array chars', "SELECT ARRAY_LENGTH(STRING_TO_ARRAY('abc', '')) AS n", r => r.data[0].n === 3);
      push('V22Ar any', "SELECT COUNT(*) AS c FROM v22_nm WHERE id = ANY(ARRAY[1,2,3])", r => r.data[0].c === 3);
      push('V22Ar not any', "SELECT COUNT(*) AS c FROM v22_nm WHERE id <> ALL(ARRAY[1,2])", r => r.data[0].c === 3);
      push('V22Ar from json text', "SELECT ARRAY_LENGTH('[1,2,3,4]') AS n", r => r.data[0].n === 4);
      push('V22Ar null propagates', "SELECT ARRAY_LENGTH(NULL) AS n", r => r.data[0].n === null);
      push('V22Ar in column expr', "SELECT ARRAY_TO_STRING(ARRAY[nm, grp], ':') AS s FROM v22_nm WHERE id = 1", r => r.data[0].s === 'kitten:a');
      err('V22Ar unclosed', "SELECT ARRAY[1,2 AS a", 'array');

      // ============================================================
      // 2. 統計・回帰集計 / MODE
      // ============================================================
      push('V22Rg slope', "SELECT REGR_SLOPE(y, x) AS s FROM v22_xy", r => r.data[0].s === 2);
      push('V22Rg intercept', "SELECT REGR_INTERCEPT(y, x) AS i FROM v22_xy", r => r.data[0].i === 1);
      push('V22Rg r2', "SELECT REGR_R2(y, x) AS r FROM v22_xy", r => r.data[0].r === 1);
      push('V22Rg count', "SELECT REGR_COUNT(y, x) AS n FROM v22_xy", r => r.data[0].n === 5);
      push('V22Rg avgx', "SELECT REGR_AVGX(y, x) AS a FROM v22_xy", r => r.data[0].a === 3);
      push('V22Rg avgy', "SELECT REGR_AVGY(y, x) AS a FROM v22_xy", r => r.data[0].a === 7);
      push('V22Rg sxx', "SELECT REGR_SXX(y, x) AS s FROM v22_xy", r => r.data[0].s === 10);
      push('V22Rg syy', "SELECT REGR_SYY(y, x) AS s FROM v22_xy", r => r.data[0].s === 40);
      push('V22Rg sxy', "SELECT REGR_SXY(y, x) AS s FROM v22_xy", r => r.data[0].s === 20);
      push('V22Rg count ignores null', "INSERT INTO v22_xy VALUES (6, NULL)", r => !r.error);
      push('V22Rg count after null', "SELECT REGR_COUNT(y, x) AS n FROM v22_xy", r => r.data[0].n === 5);
      push('V22Rg cleanup null', "DELETE FROM v22_xy WHERE x = 6", r => !r.error);
      push('V22Rg nested in expr', "SELECT ROUND(REGR_SLOPE(y, x) * 10, 1) AS s FROM v22_xy", r => r.data[0].s === 20);
      push('V22Rg grouped', "SELECT grp, REGR_COUNT(v, id) AS n FROM v22_nm GROUP BY grp ORDER BY grp", r => r.data.length === 2 && r.data[0].n === 2);
      push('V22Rg no variance', "SELECT REGR_SLOPE(v, v) AS s FROM v22_nm WHERE id IN (1,2)", r => r.data[0].s === null || typeof r.data[0].s === 'number');
      push('V22Md mode', "SELECT MODE() WITHIN GROUP (ORDER BY v) AS m FROM v22_nm", r => r.data[0].m === 30 || r.data[0].m === 10);
      push('V22Md mode grouped', "SELECT grp, MODE() WITHIN GROUP (ORDER BY v) AS m FROM v22_nm GROUP BY grp ORDER BY grp", r => r.data[0].m === 10 && r.data[1].m === 30);
      push('V22Md corr still works', "SELECT CORR(x, y) AS c FROM v22_xy", r => r.data[0].c === 1);

      // ============================================================
      // 3. あいまい照合 / 正規表現 / 数値
      // ============================================================
      push('V22Fz levenshtein', "SELECT LEVENSHTEIN('kitten','sitting') AS d", r => r.data[0].d === 3);
      push('V22Fz levenshtein same', "SELECT LEVENSHTEIN('abc','abc') AS d", r => r.data[0].d === 0);
      push('V22Fz levenshtein empty', "SELECT LEVENSHTEIN('','abc') AS d", r => r.data[0].d === 3);
      push('V22Fz edit_distance alias', "SELECT EDIT_DISTANCE('a','b') AS d", r => r.data[0].d === 1);
      push('V22Fz similarity', "SELECT SIMILARITY('abc','abd') AS s", r => Math.abs(r.data[0].s - 2 / 3) < 1e-4);
      push('V22Fz similarity identical', "SELECT SIMILARITY('x','x') AS s", r => r.data[0].s === 1);
      push('V22Fz difference', "SELECT DIFFERENCE('Robert','Rupert') AS d", r => r.data[0].d === 4);
      push('V22Fz difference unlike', "SELECT DIFFERENCE('Robert','Tymczak') AS d", r => r.data[0].d < 4);
      push('V22Fz fuzzy search', "SELECT nm FROM v22_nm WHERE LEVENSHTEIN(nm, 'kitteh') <= 2 ORDER BY id LIMIT 1", r => r.data[0].nm === 'kitten');
      push('V22Fz rank by similarity', "SELECT nm, SIMILARITY(nm, 'Robrt') AS s FROM v22_nm ORDER BY s DESC LIMIT 1", r => r.data[0].nm === 'Robert');
      push('V22Fz null', "SELECT LEVENSHTEIN(NULL, 'a') AS d", r => r.data[0].d === null);
      push('V22Rx matches', "SELECT ARRAY_TO_STRING(REGEXP_MATCHES('a1b2','[0-9]','g'), ',') AS m", r => r.data[0].m === '1,2');
      push('V22Rx matches first', "SELECT ARRAY_TO_STRING(REGEXP_MATCHES('a1b2','[0-9]'), ',') AS m", r => r.data[0].m === '1');
      push('V22Rx no match', "SELECT REGEXP_MATCHES('abc','[0-9]') AS m", r => r.data[0].m === null);
      push('V22Rx split', "SELECT ARRAY_TO_STRING(REGEXP_SPLIT_TO_ARRAY('a1b2c','[0-9]'), '|') AS s", r => r.data[0].s === 'a|b|c');
      push('V22Nm div', "SELECT DIV(7,2) AS a, DIV(-7,2) AS b", r => r.data[0].a === 3 && r.data[0].b === -3);
      push('V22Nm div zero', "SELECT DIV(1,0) AS d", r => r.data[0].d === null);
      push('V22Nm safe_divide', "SELECT SAFE_DIVIDE(1,0) AS a, SAFE_DIVIDE(3,2) AS b", r => r.data[0].a === null && r.data[0].b === 1.5);

      // ============================================================
      // 4. AT TIME ZONE
      // ============================================================
      push('V22Tz offset', "SELECT TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE '+09:00' AS t", r => r.data[0].t === '2026-01-01 09:00:00');
      push('V22Tz negative', "SELECT TIMESTAMP '2026-01-01 12:00:00' AT TIME ZONE '-05:00' AS t", r => r.data[0].t === '2026-01-01 07:00:00');
      push('V22Tz utc', "SELECT TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE 'UTC' AS t", r => r.data[0].t === '2026-01-01 00:00:00');
      push('V22Tz abbrev', "SELECT TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE 'JST' AS t", r => r.data[0].t === '2026-01-01 09:00:00');
      push('V22Tz column', "SELECT COUNT(*) AS c FROM v22_nm WHERE (TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE 'UTC') IS NOT NULL", r => r.data[0].c === 5);
      err('V22Tz unknown', "SELECT TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE 'Mars/Olympus' AS t", 'time zone');

      // ============================================================
      // 5. 時系列生成 / WITH ORDINALITY
      // ============================================================
      push('V22Gs hours', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 03:00:00', INTERVAL 1 HOUR)", r => r.data[0].c === 4);
      push('V22Gs hour values', "SELECT value AS v FROM GENERATE_SERIES(TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 02:00:00', INTERVAL 1 HOUR) ORDER BY value",
        r => r.data.length === 3 && r.data[0].v === '2026-01-01 00:00:00' && r.data[2].v === '2026-01-01 02:00:00');
      push('V22Gs days', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-07', INTERVAL 1 DAY)", r => r.data[0].c === 7);
      push('V22Gs months', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(DATE '2026-01-31', DATE '2026-04-30', INTERVAL 1 MONTH)", r => r.data[0].c === 4);
      push('V22Gs 15min', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 01:00:00', INTERVAL 15 MINUTE)", r => r.data[0].c === 5);
      push('V22Gs alias cols', "SELECT ts FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-02', INTERVAL 1 DAY) AS g(ts) ORDER BY ts", r => r.data.length === 2);
      push('V22Gs gap fill join', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-05', INTERVAL 1 DAY) g LEFT JOIN v22_nm n ON 1 = 0", r => r.data[0].c === 5);
      push('V22Gs numeric still works', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10)", r => r.data[0].c === 10);
      push('V22Gs numeric step', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10, 3)", r => r.data[0].c === 4);
      err('V22Gs zero interval', "SELECT * FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-05', INTERVAL 0 DAY)", 'zero');
      push('V22Or ordinality', "SELECT * FROM GENERATE_SERIES(10, 30, 10) WITH ORDINALITY AS t(v, n) ORDER BY n",
        r => r.data.length === 3 && r.data[0].v === 10 && r.data[0].n === 1 && r.data[2].n === 3);
      push('V22Or ordinality default col', "SELECT ordinality AS n FROM GENERATE_SERIES(1, 2) WITH ORDINALITY ORDER BY ordinality", r => r.data.length === 2 && r.data[1].n === 2);
      push('V22Or ordinality on timestamps', "SELECT MAX(n) AS m FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-03', INTERVAL 1 DAY) WITH ORDINALITY AS t(d, n)", r => r.data[0].m === 3);

      // ============================================================
      // 6. ウィンドウ拡張（EXCLUDE / FILTER）
      // ============================================================
      push('V22Wx exclude current', "SELECT x, SUM(y) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) AS s FROM v22_xy ORDER BY x",
        r => r.data[0].s === null && r.data[1].s === 3 && r.data[2].s === 8);
      push('V22Wx no others default', "SELECT x, SUM(y) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM v22_xy ORDER BY x",
        r => r.data[0].s === 3 && r.data[1].s === 8);
      push('V22Wx exclude no others explicit', "SELECT x, SUM(y) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS) AS s FROM v22_xy ORDER BY x",
        r => r.data[0].s === 3);
      // v=10 の 2 行 / v=20 の 1 行 / v=30 の 2 行。自分と同順位のまとまりを除くので 3 / 4 / 3
      push('V22Wx exclude group', "SELECT id, COUNT(*) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE GROUP) AS c FROM v22_nm ORDER BY id",
        r => r.data[0].c === 3 && r.data[2].c === 4 && r.data[4].c === 3);
      push('V22Wx exclude ties', "SELECT id, COUNT(*) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) AS c FROM v22_nm ORDER BY id",
        r => r.data[0].c === 4);
      push('V22Wf filter sum', "SELECT SUM(y) FILTER (WHERE y > 5) OVER () AS s FROM v22_xy LIMIT 1", r => r.data[0].s === 27);
      push('V22Wf filter count', "SELECT COUNT(*) FILTER (WHERE y > 5) OVER () AS c FROM v22_xy LIMIT 1", r => r.data[0].c === 3);
      push('V22Wf filter avg', "SELECT AVG(y) FILTER (WHERE y > 5) OVER () AS a FROM v22_xy LIMIT 1", r => r.data[0].a === 9);
      push('V22Wf filter with frame', "SELECT x, SUM(y) FILTER (WHERE y > 5) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM v22_xy ORDER BY x",
        r => r.data[0].s === null && r.data[4].s === 27);
      // 条件に合う行が無いパーティションの SUM は 0（空集合の SUM を 0 とする既存仕様）
      push('V22Wf filter partition', "SELECT grp, SUM(v) FILTER (WHERE v > 10) OVER (PARTITION BY grp) AS s FROM v22_nm ORDER BY id",
        r => r.data[0].s === 0 && r.data[2].s === 80);
      push('V22Wf agg filter still works', "SELECT COUNT(*) FILTER (WHERE y > 5) AS c FROM v22_xy", r => r.data[0].c === 3);
      err('V22Wf filter on row_number', "SELECT ROW_NUMBER() FILTER (WHERE y > 5) OVER () AS x FROM v22_xy", 'not supported');

      // ============================================================
      // 7. 保守コマンド / SHOW CREATE
      // ============================================================
      ['REINDEX', 'CHECKPOINT', 'FLUSH', 'CLUSTER'].forEach((k, i) =>
        push(`V22Op ${k}`, k, r => !r.error && /accepted/.test(r.data[0].Message)));
      push('V22Op vacuum still real', "VACUUM", r => !r.error && /optimized/i.test(r.data[0].Message));
      push('V22Sc create fn', "CREATE OR REPLACE FUNCTION v22_f(a) RETURNS INT AS RETURN a * 3", r => !r.error);
      push('V22Sc show create function', "SHOW CREATE FUNCTION v22_f", r => /CREATE FUNCTION v22_f\(a\)/.test(r.data[0].CreateFunction));
      err('V22Sc show create function missing', "SHOW CREATE FUNCTION v22_nope", 'not found');
      push('V22Sc create proc', "CREATE OR REPLACE PROCEDURE v22_p(a, b) AS BEGIN RETURN a + b; END", r => !r.error);
      push('V22Sc show create procedure params', "SHOW CREATE PROCEDURE v22_p", r => /v22_p\(a, b\)/.test(r.data[0].CreateProcedure));
      push('V22Sc drop fn', "DROP FUNCTION v22_f", r => !r.error);
      push('V22Sc drop proc', "DROP PROCEDURE v22_p", r => !r.error);

      // ============================================================
      // 8. 式コンパイルキャッシュ
      // ============================================================
      fn('V22Cc caches repeated queries', () => {
        LuminaDB.clearCache();
        db.executeQuery("SELECT COUNT(*) AS c FROM v22_nm WHERE v > 15");
        const first = LuminaDB.cacheStats();
        db.executeQuery("SELECT COUNT(*) AS c FROM v22_nm WHERE v > 15");
        const second = LuminaDB.cacheStats();
        return first.misses > 0 && second.hits > first.hits;
      });
      fn('V22Cc results stay correct', () => {
        const a = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm WHERE v > 15");
        db.executeQuery("INSERT INTO v22_nm VALUES (99, 'zz', 'c', 99)");
        const b = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm WHERE v > 15");
        db.executeQuery("DELETE FROM v22_nm WHERE id = 99");
        const c = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm WHERE v > 15");
        return b === a + 1 && c === a;
      });
      fn('V22Cc user variables not cached', () => {
        db.executeQuery("SET @v22x = 1");
        const a = LuminaDB.value("SELECT @v22x AS v");
        db.executeQuery("SET @v22x = 2");
        const b = LuminaDB.value("SELECT @v22x AS v");
        return a === 1 && b === 2;
      });
      fn('V22Cc last_insert_id not cached', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_ai");
        db.executeQuery("CREATE TABLE v22_ai (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INTEGER)");
        db.executeQuery("INSERT INTO v22_ai (v) VALUES (1)");
        const a = LuminaDB.value("SELECT LAST_INSERT_ID() AS v");
        db.executeQuery("INSERT INTO v22_ai (v) VALUES (2)");
        const b = LuminaDB.value("SELECT LAST_INSERT_ID() AS v");
        db.executeQuery("DROP TABLE v22_ai");
        return b === a + 1;
      });
      fn('V22Cc user functions not cached', () => {
        db.executeQuery("CREATE OR REPLACE FUNCTION v22_g(a) RETURNS INT AS RETURN a + 1");
        const a = LuminaDB.value("SELECT v22_g(1) AS v");
        db.executeQuery("CREATE OR REPLACE FUNCTION v22_g(a) RETURNS INT AS RETURN a + 100");
        const b = LuminaDB.value("SELECT v22_g(1) AS v");
        db.executeQuery("DROP FUNCTION v22_g");
        return a === 2 && b === 101;
      });
      fn('V22Cc sequences not cached', () => {
        db.executeQuery("DROP SEQUENCE IF EXISTS v22_s");
        db.executeQuery("CREATE SEQUENCE v22_s");
        const a = LuminaDB.value("SELECT NEXTVAL('v22_s') AS v");
        const b = LuminaDB.value("SELECT NEXTVAL('v22_s') AS v");
        db.executeQuery("DROP SEQUENCE v22_s");
        return b === a + 1;
      });
      fn('V22Cc bounded size', () => {
        LuminaDB.clearCache();
        for (let i = 0; i < 700; i++) db.executeQuery(`SELECT COUNT(*) AS c FROM v22_nm WHERE v > ${i}`);
        const st = LuminaDB.cacheStats();
        return st.size <= st.max;
      });
      fn('V22Cc clearCache resets', () => {
        LuminaDB.clearCache();
        const st = LuminaDB.cacheStats();
        return st.size === 0 && st.hits === 0 && st.misses === 0;
      });

      // ============================================================
      // 9. CSV 取り込み / リーダー選出
      // ============================================================
      fn('V22Cv import creates table', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv");
        const r = LuminaDB.importCSV("id,name,score\n1,Ann,10\n2,Bob,20\n", 'v22_csv', { create: true });
        return !r.error && r.rows === 2 && LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv") === 2;
      });
      fn('V22Cv infers numeric type', () => {
        const r = db.executeQuery("SELECT SUM(score) AS s FROM v22_csv");
        return !r.error && r.data[0].s === 30;
      });
      fn('V22Cv quoted fields', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv2");
        const r = LuminaDB.importCSV('a,b\n"x,1","say ""hi"""\n', 'v22_csv2', { create: true });
        const row = LuminaDB.row("SELECT a, b FROM v22_csv2");
        return !r.error && row.a === 'x,1' && row.b === 'say "hi"';
      });
      fn('V22Cv embedded newline', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv3");
        LuminaDB.importCSV('a\n"line1\nline2"\n', 'v22_csv3', { create: true });
        const v = LuminaDB.value("SELECT a FROM v22_csv3");
        return v === 'line1\nline2' && LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv3") === 1;
      });
      fn('V22Cv crlf and bom', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv4");
        LuminaDB.importCSV('﻿a,b\r\n1,2\r\n3,4\r\n', 'v22_csv4', { create: true });
        return LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv4") === 2
            && LuminaDB.value("SELECT SUM(a) AS s FROM v22_csv4") === 4;
      });
      fn('V22Cv empty becomes null', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv5");
        LuminaDB.importCSV('a,b\n1,\n2,x\n', 'v22_csv5', { create: true });
        return LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv5 WHERE b IS NULL") === 1;
      });
      fn('V22Cv custom delimiter', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_csv6");
        LuminaDB.importCSV('a;b\n1;2\n', 'v22_csv6', { create: true, delimiter: ';' });
        return LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv6") === 1;
      });
      fn('V22Cv append and replace', () => {
        LuminaDB.importCSV("id,name,score\n3,Cid,30\n", 'v22_csv');
        const afterAppend = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv");
        LuminaDB.importCSV("id,name,score\n9,Zed,90\n", 'v22_csv', { replace: true });
        const afterReplace = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv");
        return afterAppend === 3 && afterReplace === 1;
      });
      fn('V22Cv requires create', () => {
        const r = LuminaDB.importCSV("a\n1\n", 'v22_missing_tbl');
        return !!r.error && /create/.test(r.error);
      });
      fn('V22Cv rejects bad table name', () => !!LuminaDB.importCSV("a\n1\n", 'bad name', { create: true }).error);
      fn('V22Cv rejects bad delimiter', () => !!LuminaDB.importCSV("a\n1\n", 'v22_csv', { delimiter: '||' }).error);
      fn('V22Cv rejects empty', () => !!LuminaDB.importCSV("", 'v22_csv').error);
      fn('V22Cv duplicate headers rejected', () => {
        const r = LuminaDB.importCSV("a,a\n1,2\n", 'v22_dupe', { create: true });
        return !!r.error && /duplicate/i.test(r.error);
      });
      fn('V22Cv exportCSV roundtrip', () => {
        const csv = LuminaDB.exportCSV('v22_csv');
        db.executeQuery("DROP TABLE IF EXISTS v22_csv7");
        LuminaDB.importCSV(csv, 'v22_csv7', { create: true });
        return LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv7") === LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csv");
      });
      fn('V22Cv cleanup', () => {
        ['v22_csv','v22_csv2','v22_csv3','v22_csv4','v22_csv5','v22_csv6','v22_csv7'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        return true;
      });
      fn('V22Ld becomes leader', async () => {
        const h = LuminaDB.onLeader(() => {});
        await new Promise(r => setTimeout(r, 50));
        const was = LuminaDB.isLeader();
        h.release();
        await new Promise(r => setTimeout(r, 50));
        return was === true;
      });
      fn('V22Ld releases leadership', () => LuminaDB.isLeader() === false);
      fn('V22Ld requires callback', () => {
        try { LuminaDB.onLeader('nope'); return false; } catch (e) { return /callback/.test(e.message); }
      });

      // ============================================================
      // 10. 新しい入口のセキュリティ
      // ============================================================
      const PAYLOADS = [
        "'; DROP TABLE v22_nm; --",
        "` + (window.__v22_pwned = 1) + `",
        "${window.__v22_pwned = 1}",
        "__proto__",
        "constructor.prototype.__v22_polluted",
        "line1\nline2",
        "</script><img src=x onerror=alert(1)>"
      ];
      PAYLOADS.forEach((p, i) => {
        fn(`V22Sec array value ${i}`, () => {
          const r = LuminaDB.query("SELECT ARRAY_TO_STRING(ARRAY[?], '|') AS s", [p]);
          return !r.error && r.data[0].s === p
              && LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm") === 5 && canaryClean();
        });
        fn(`V22Sec fuzzy value ${i}`, () => {
          const r = LuminaDB.query("SELECT LEVENSHTEIN(?, ?) AS d", [p, p]);
          return !r.error && r.data[0].d === 0 && canaryClean();
        });
        fn(`V22Sec csv field ${i}`, () => {
          db.executeQuery("DROP TABLE IF EXISTS v22_sec");
          const csv = 'a\n"' + p.replace(/"/g, '""') + '"\n';
          const r = LuminaDB.importCSV(csv, 'v22_sec', { create: true });
          const got = LuminaDB.value("SELECT a FROM v22_sec");
          db.executeQuery("DROP TABLE IF EXISTS v22_sec");
          return !r.error && got === p
              && LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm") === 5 && canaryClean();
        });
        fn(`V22Sec csv header ${i}`, () => {
          db.executeQuery("DROP TABLE IF EXISTS v22_sech");
          // 危険な文字はヘッダー正規化で '_' に落ちるため、SQL 構造には影響しない
          const r = LuminaDB.importCSV('"' + p.replace(/"/g, '""') + '"\n1\n', 'v22_sech', { create: true });
          const intact = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_nm") === 5;
          db.executeQuery("DROP TABLE IF EXISTS v22_sech");
          return intact && canaryClean();
        });
        fn(`V22Sec timezone name ${i}`, () => {
          const r = LuminaDB.query("SELECT (TIMESTAMP '2026-01-01 00:00:00' AT TIME ZONE ?) AS t", [p]);
          return !!r.error && canaryClean();
        });
      });
      fn('V22Sec levenshtein length guard', () => {
        const big = 'a'.repeat(3000);
        const r = LuminaDB.query('SELECT LEVENSHTEIN(?, ?) AS d', [big, big]);
        // 長すぎる入力は拒否されるか NULL（行評価の catch）。O(n^2) で固まらないことが要点
        return r.error ? /2000/.test(r.error) : r.data[0].d === null;
      });
      fn('V22Sec cache not shared across values', () => {
        const a = LuminaDB.value('SELECT COUNT(*) AS c FROM v22_nm WHERE nm = ?', ['kitten']);
        const b = LuminaDB.value('SELECT COUNT(*) AS c FROM v22_nm WHERE nm = ?', ['Robert']);
        return a === 2 && b === 1;
      });
      fn('V22Sec csv read-only blocked', () => {
        db.executeQuery("SET read_only = ON");
        const r = LuminaDB.importCSV("a\n1\n", 'v22_ro_csv', { create: true });
        db.executeQuery("SET read_only = OFF");
        return !!r.error && !db.tables['v22_ro_csv'];
      });
      fn('V22Sec canary clean', () => canaryClean());

      // ============================================================
      // 11. 性能予算
      // ============================================================
      fn('V22Pf fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v22_big");
        db.executeQuery("CREATE TABLE v22_big (id INTEGER, g INTEGER, x INTEGER, y INTEGER, s TEXT)");
        // 出力列名が重複すると 1 列に潰れるので、それぞれに別名を付ける
        const r = db.executeQuery("INSERT INTO v22_big SELECT value AS c1, MOD(value, 20) AS c2, value AS c3, value * 2 + 1 AS c4, 'name' || value AS c5 FROM GENERATE_SERIES(1, 10000)");
        return !r.error && db.tables['v22_big'].rowCount === 10000;
      });
      const perf = (name, sql, capMs, check) => fn(name, () => {
        const r = db.executeQuery(sql);
        if (r.error) return false;
        if (check && !check(r)) return false;
        return Number(r.executionTime) < capMs;
      });
      perf('V22Pf regr 10k', "SELECT REGR_SLOPE(y, x) AS s FROM v22_big", 1500, r => r.data[0].s === 2);
      perf('V22Pf regr grouped', "SELECT g, REGR_SLOPE(y, x) AS s FROM v22_big GROUP BY g", 2000, r => r.data.length === 20);
      perf('V22Pf mode 10k', "SELECT MODE() WITHIN GROUP (ORDER BY g) AS m FROM v22_big", 1500, r => typeof r.data[0].m === 'number');
      perf('V22Pf array 10k', "SELECT COUNT(ARRAY_LENGTH(ARRAY[id, x])) AS c FROM v22_big", 2000, r => r.data[0].c === 10000);
      perf('V22Pf levenshtein 10k', "SELECT COUNT(*) AS c FROM v22_big WHERE LEVENSHTEIN(s, 'name500') <= 1", 3000, r => r.data[0].c >= 1);
      perf('V22Pf window exclude 10k', "SELECT COUNT(*) AS c FROM (SELECT SUM(y) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) AS w FROM v22_big) t", 4000, r => r.data[0].c === 10000);
      perf('V22Pf window filter 10k', "SELECT COUNT(*) AS c FROM (SELECT SUM(y) FILTER (WHERE y > 100) OVER (PARTITION BY g) AS w FROM v22_big) t", 4000, r => r.data[0].c === 10000);
      perf('V22Pf timestamp series 5k', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-04 11:19:00', INTERVAL 1 MINUTE)", 3000, r => r.data[0].c === 5000);
      fn('V22Pf repeated queries benefit from cache', () => {
        const runN = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) db.executeQuery("SELECT COUNT(*) AS c FROM v22_big WHERE x > 5000 AND g < 10"); return performance.now() - t0; };
        LuminaDB.clearCache();
        runN(5);                       // ウォームアップ
        const cached = runN(100);
        const st = LuminaDB.cacheStats();
        // 100 回で 1 回しかコンパイルしていない（=ヒット率が高い）
        return st.hitRate > 0.9 && cached < 4000;
      });
      fn('V22Pf csv import 5k rows', () => {
        const lines = ['id,v'];
        for (let i = 1; i <= 5000; i++) lines.push(i + ',' + (i * 2));
        const text = lines.join('\n');
        db.executeQuery("DROP TABLE IF EXISTS v22_csvperf");
        const t0 = performance.now();
        const r = LuminaDB.importCSV(text, 'v22_csvperf', { create: true });
        const ms = performance.now() - t0;
        const n = LuminaDB.value("SELECT COUNT(*) AS c FROM v22_csvperf");
        db.executeQuery("DROP TABLE IF EXISTS v22_csvperf");
        return !r.error && n === 5000 && ms < 4000;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V22Cl drop tables', () => {
        ['v22_big', 'v22_nm', 'v22_xy'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        return true;
      });

      return T;
    }
