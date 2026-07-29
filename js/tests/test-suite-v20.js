    // ============================================================================
    // [Test Suite v20] - v1.15 で追加した SQL コマンド / ブラウザDB必須機能のテスト
    //
    //   機能回帰に加えて、新しく増えた入口（プロシージャのローカル変数・JSON_TABLE の
    //   パス・MATCH の検索語・バックアップの取り込み・ワーカーのメッセージ）に対する
    //   セキュリティ検査と、代表的な操作の性能予算も同じ場所で押さえる。
    //
    //   test-suite.js の tests 配列へ getV20Tests() のスプレッドで合流する
    // ============================================================================
    function getV20Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      const canaryClean = () => window.__v20_pwned === undefined && ({}).__v20_polluted === undefined;

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      push('V20Fx create doc', "CREATE TABLE v20_doc (id INTEGER PRIMARY KEY, title TEXT, body TEXT, n INTEGER)", r => r.data[0].Result === 'Success');
      push('V20Fx insert doc', "INSERT INTO v20_doc VALUES " +
        "(1,'Release notes','the quick brown fox jumps over the lazy dog',10)," +
        "(2,'Setup guide','install the browser database and run a query',20)," +
        "(3,'FAQ','how to back up the database in a browser',30)," +
        "(4,'Changelog','fox and dog release notes for the database',40)", r => r.data[0].Result === 'Success');
      push('V20Fx create gaps', "CREATE TABLE v20_gaps (id INTEGER, v INTEGER)", r => r.data[0].Result === 'Success');
      push('V20Fx insert gaps', "INSERT INTO v20_gaps VALUES (1,10),(2,NULL),(3,NULL),(4,40),(5,NULL),(6,60)", r => r.data[0].Result === 'Success');

      // ============================================================
      // 1. 日付 ± INTERVAL（v1.14 では [object Object] になっていた）
      // ============================================================
      const IV = [
        ["DATE '2020-01-05' + INTERVAL 1 DAY", '2020-01-06 00:00:00'],
        ["DATE '2020-01-05' - INTERVAL 1 DAY", '2020-01-04 00:00:00'],
        ["DATE '2020-01-05' + INTERVAL 10 DAY", '2020-01-15 00:00:00'],
        ["DATE '2020-01-31' + INTERVAL 1 MONTH", '2020-02-29 00:00:00'],
        ["DATE '2020-01-05' + INTERVAL 1 YEAR", '2021-01-05 00:00:00'],
        ["DATE '2020-01-05' - INTERVAL 1 WEEK", '2019-12-29 00:00:00'],
        ["TIMESTAMP '2020-01-05 10:00:00' + INTERVAL 90 MINUTE", '2020-01-05 11:30:00'],
        ["TIMESTAMP '2020-01-05 10:00:00' - INTERVAL 2 HOUR", '2020-01-05 08:00:00'],
        ["TIMESTAMP '2020-01-05 10:00:00' + INTERVAL 30 SECOND", '2020-01-05 10:00:30'],
        ["INTERVAL 1 DAY + DATE '2020-01-05'", '2020-01-06 00:00:00'],
        ["DATE '2020-01-05' + INTERVAL '1 day'", '2020-01-06 00:00:00'],
        ["DATE '2020-01-05' + INTERVAL '2 months'", '2020-03-05 00:00:00'],
        ["DATE '2020-01-05' - INTERVAL '1 week'", '2019-12-29 00:00:00'],
        ["DATE_ADD(DATE '2020-01-05', INTERVAL 1 DAY)", '2020-01-06 00:00:00'],
        ["DATE_SUB(DATE '2020-01-05', INTERVAL 1 DAY)", '2020-01-04 00:00:00']
      ];
      IV.forEach(([expr, want], i) => push(`V20Iv ${i}`, `SELECT ${expr} AS d`, r => r.data[0].d === want));
      push('V20Iv chained', "SELECT DATE '2020-01-05' + INTERVAL 1 DAY + INTERVAL 1 DAY AS d", r => r.data[0].d === '2020-01-07 00:00:00');
      push('V20Iv in where', "SELECT COUNT(*) AS c FROM v20_doc WHERE DATE '2020-01-01' + INTERVAL 1 DAY > DATE '2020-01-01'", r => r.data[0].c === 4);
      push('V20Iv null date', "SELECT NULL + INTERVAL 1 DAY AS d", r => r.data[0].d === null);
      err('V20Iv bad literal', "SELECT DATE '2020-01-05' + INTERVAL 'tomorrow' AS d", 'invalid interval');

      // ============================================================
      // 2. COLLATE
      // ============================================================
      push('V20Col nocase eq', "SELECT ('ABC' COLLATE NOCASE = 'abc') AS x", r => r.data[0].x === true);
      push('V20Col binary neq', "SELECT ('ABC' COLLATE BINARY = 'abc') AS x", r => r.data[0].x === false);
      push('V20Col order', "SELECT title FROM v20_doc ORDER BY title COLLATE NOCASE LIMIT 1", r => r.data[0].title === 'Changelog');
      push('V20Col order desc', "SELECT title FROM v20_doc ORDER BY title COLLATE NOCASE DESC LIMIT 1", r => r.data[0].title === 'Setup guide');
      push('V20Col natural', "SELECT ('a10' COLLATE NUMERIC > 'a9' COLLATE NUMERIC) AS x", r => r.data[0].x === true);
      push('V20Col natural default', "SELECT ('a10' > 'a9') AS x", r => r.data[0].x === false);
      push('V20Col noaccent', "SELECT ('がぎ' COLLATE NOACCENT = 'かき') AS x", r => r.data[0].x === true);
      push('V20Col group', "SELECT COUNT(DISTINCT UPPER(title) COLLATE NOCASE) AS c FROM v20_doc", r => r.data[0].c === 4);
      push('V20Col null safe', "SELECT (NULL COLLATE NOCASE) AS x", r => r.data[0].x === null);
      push('V20Col fn operand', "SELECT (UPPER('ab') COLLATE NOCASE = 'AB') AS x", r => r.data[0].x === true);
      err('V20Col unknown', "SELECT 'a' COLLATE WEIRD AS x", 'unknown collation');

      // ============================================================
      // 3. 全文検索 MATCH ... AGAINST
      // ============================================================
      push('V20Ft single word', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('fox')", r => r.data[0].c === 2);
      push('V20Ft case insensitive', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('FOX')", r => r.data[0].c === 2);
      push('V20Ft two columns', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(title, body) AGAINST('changelog')", r => r.data[0].c === 1);
      push('V20Ft score', "SELECT id, MATCH(body) AGAINST('fox dog') AS s FROM v20_doc ORDER BY s DESC, id LIMIT 1", r => r.data[0].s === 2);
      push('V20Ft no match', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('unicorn')", r => r.data[0].c === 0);
      push('V20Ft phrase', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('\"quick brown\"')", r => r.data[0].c === 1);
      push('V20Ft boolean plus', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('+fox +dog' IN BOOLEAN MODE)", r => r.data[0].c === 2);
      push('V20Ft boolean minus', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('+dog -fox' IN BOOLEAN MODE)", r => r.data[0].c === 0);
      push('V20Ft boolean missing', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('+fox +unicorn' IN BOOLEAN MODE)", r => r.data[0].c === 0);
      push('V20Ft natural mode kw', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('database' IN NATURAL LANGUAGE MODE)", r => r.data[0].c === 3);
      push('V20Ft partial word not matched', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('data')", r => r.data[0].c === 0);
      push('V20Ft prefix star', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('datab*' IN BOOLEAN MODE)", r => r.data[0].c === 3);
      push('V20Ft empty query', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST('')", r => r.data[0].c === 0);
      push('V20Ft null column', "SELECT MATCH(body) AGAINST('x') AS s FROM v20_doc LIMIT 1", r => r.data[0].s === 0);
      err('V20Ft no column', "SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH() AGAINST('x')", 'at least one column');

      // ============================================================
      // 4. LIKE ANY / ALL
      // ============================================================
      push('V20La any', "SELECT COUNT(*) AS c FROM v20_doc WHERE title LIKE ANY ('R%','S%')", r => r.data[0].c === 2);
      push('V20La all', "SELECT COUNT(*) AS c FROM v20_doc WHERE title LIKE ALL ('%e%','%a%')", r => r.data[0].c === 2);
      push('V20La not any', "SELECT COUNT(*) AS c FROM v20_doc WHERE title NOT LIKE ANY ('R%','S%')", r => r.data[0].c === 2);
      push('V20La ilike any', "SELECT COUNT(*) AS c FROM v20_doc WHERE title ILIKE ANY ('r%','s%')", r => r.data[0].c === 2);
      push('V20La some', "SELECT COUNT(*) AS c FROM v20_doc WHERE title LIKE SOME ('FAQ')", r => r.data[0].c === 1);
      push('V20La empty any', "SELECT COUNT(*) AS c FROM v20_doc WHERE title LIKE ANY ()", r => r.data[0].c === 0);

      // ============================================================
      // 5. IGNORE NULLS / RESPECT NULLS
      // ============================================================
      push('V20In lag ignore', "SELECT id, LAG(v) IGNORE NULLS OVER (ORDER BY id) AS p FROM v20_gaps ORDER BY id",
        r => r.data[3].p === 10 && r.data[5].p === 40);
      push('V20In lag respect', "SELECT id, LAG(v) RESPECT NULLS OVER (ORDER BY id) AS p FROM v20_gaps ORDER BY id",
        r => r.data[3].p === null);
      push('V20In lag default', "SELECT id, LAG(v) OVER (ORDER BY id) AS p FROM v20_gaps ORDER BY id", r => r.data[3].p === null);
      push('V20In lead ignore', "SELECT id, LEAD(v) IGNORE NULLS OVER (ORDER BY id) AS n FROM v20_gaps ORDER BY id",
        r => r.data[0].n === 40 && r.data[3].n === 60);
      push('V20In lag offset2', "SELECT id, LAG(v, 2) IGNORE NULLS OVER (ORDER BY id) AS p FROM v20_gaps ORDER BY id",
        r => r.data[5].p === 10);
      push('V20In first ignore', "SELECT FIRST_VALUE(v) IGNORE NULLS OVER (ORDER BY id) AS f FROM v20_gaps LIMIT 1", r => r.data[0].f === 10);
      push('V20In last ignore', "SELECT LAST_VALUE(v) IGNORE NULLS OVER (ORDER BY id) AS l FROM v20_gaps LIMIT 1", r => r.data[0].l === 60);
      push('V20In nth ignore', "SELECT NTH_VALUE(v, 2) IGNORE NULLS OVER (ORDER BY id) AS x FROM v20_gaps LIMIT 1", r => r.data[0].x === 40);
      push('V20In nth respect', "SELECT NTH_VALUE(v, 2) OVER (ORDER BY id) AS x FROM v20_gaps LIMIT 1", r => r.data[0].x === null);
      err('V20In on sum', "SELECT SUM(v) IGNORE NULLS OVER () AS x FROM v20_gaps", 'not supported');

      // ============================================================
      // 6. JSON_TABLE
      // ============================================================
      push('V20Jt array', "SELECT * FROM JSON_TABLE('[{\"a\":1,\"b\":\"x\"},{\"a\":2,\"b\":\"y\"}]', '$[*]' COLUMNS (a INT PATH '$.a', b TEXT PATH '$.b')) t",
        r => r.data.length === 2 && r.data[0].a === 1 && r.data[1].b === 'y');
      push('V20Jt agg', "SELECT SUM(a) AS s FROM JSON_TABLE('[{\"a\":1},{\"a\":2},{\"a\":3}]', '$[*]' COLUMNS (a INT PATH '$.a')) t", r => r.data[0].s === 6);
      push('V20Jt nested path', "SELECT v FROM JSON_TABLE('[{\"a\":{\"b\":5}}]', '$[*]' COLUMNS (v INT PATH '$.a.b')) t", r => r.data[0].v === 5);
      push('V20Jt key row path', "SELECT n FROM JSON_TABLE('{\"items\":[{\"n\":\"p\"},{\"n\":\"q\"}]}', '$.items[*]' COLUMNS (n TEXT PATH '$.n')) t",
        r => r.data.length === 2 && r.data[1].n === 'q');
      push('V20Jt single object', "SELECT a FROM JSON_TABLE('{\"a\":7}', '$' COLUMNS (a INT PATH '$.a')) t", r => r.data[0].a === 7);
      push('V20Jt implicit path', "SELECT a FROM JSON_TABLE('[{\"a\":9}]', '$[*]' COLUMNS (a INT)) t", r => r.data[0].a === 9);
      push('V20Jt missing key null', "SELECT z FROM JSON_TABLE('[{\"a\":1}]', '$[*]' COLUMNS (z TEXT PATH '$.z')) t", r => r.data[0].z === null);
      push('V20Jt nested object stringified', "SELECT o FROM JSON_TABLE('[{\"o\":{\"k\":1}}]', '$[*]' COLUMNS (o TEXT PATH '$.o')) t", r => r.data[0].o === '{"k":1}');
      push('V20Jt array index', "SELECT x FROM JSON_TABLE('[{\"a\":[7,8]}]', '$[*]' COLUMNS (x INT PATH '$.a[1]')) t", r => r.data[0].x === 8);
      push('V20Jt bool coerce', "SELECT b FROM JSON_TABLE('[{\"b\":true}]', '$[*]' COLUMNS (b BOOLEAN PATH '$.b')) t", r => r.data[0].b === true);
      push('V20Jt join', "SELECT COUNT(*) AS c FROM v20_doc d JOIN JSON_TABLE('[{\"i\":1},{\"i\":3}]', '$[*]' COLUMNS (i INT PATH '$.i')) j ON d.id = j.i", r => r.data[0].c === 2);
      push('V20Jt empty array', "SELECT COUNT(*) AS c FROM JSON_TABLE('[]', '$[*]' COLUMNS (a INT PATH '$.a')) t", r => r.data[0].c === 0);
      err('V20Jt bad json', "SELECT * FROM JSON_TABLE('not json', '$[*]' COLUMNS (a INT PATH '$.a')) t", 'not valid json');
      err('V20Jt no columns', "SELECT * FROM JSON_TABLE('[]', '$[*]') t", 'json_table');
      err('V20Jt bad row path', "SELECT * FROM JSON_TABLE('[]', '$.a.b.c' COLUMNS (a INT PATH '$.a')) t", 'row path');

      // ============================================================
      // 7. TABLESAMPLE
      // ============================================================
      push('V20Ts full', "SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE (100 PERCENT)", r => r.data[0].c === 4);
      push('V20Ts none', "SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE (0 PERCENT)", r => r.data[0].c === 0);
      push('V20Ts rows', "SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE (2 ROWS)", r => r.data[0].c === 2);
      push('V20Ts bernoulli', "SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE BERNOULLI (100)", r => r.data[0].c === 4);
      push('V20Ts system', "SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE SYSTEM (100)", r => r.data[0].c === 4);
      push('V20Ts alias', "SELECT COUNT(*) AS c FROM v20_doc d TABLESAMPLE (100 PERCENT) WHERE d.id > 0", r => r.data[0].c === 4);
      push('V20Ts join', "SELECT COUNT(*) AS c FROM v20_gaps g JOIN v20_doc TABLESAMPLE (100 PERCENT) ON 1=1", r => r.data[0].c === 24);
      fn('V20Ts repeatable deterministic', () => {
        const a = db.executeQuery("SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE (50 PERCENT) REPEATABLE (42)");
        const b = db.executeQuery("SELECT COUNT(*) AS c FROM v20_doc TABLESAMPLE (50 PERCENT) REPEATABLE (42)");
        return !a.error && !b.error && a.data[0].c === b.data[0].c;
      });
      err('V20Ts out of range', "SELECT * FROM v20_doc TABLESAMPLE (150 PERCENT)", 'between 0 and 100');

      // ============================================================
      // 8. ストアドプロシージャの制御構造
      // ============================================================
      push('V20Pr sink', "CREATE TABLE v20_out (k TEXT, v INTEGER)", r => r.data[0].Result === 'Success');
      push('V20Pr if', "CREATE PROCEDURE v20_if AS BEGIN DECLARE x INT DEFAULT 5; IF x > 3 THEN INSERT INTO v20_out VALUES ('if', 1); ELSE INSERT INTO v20_out VALUES ('if', 2); END IF; END", r => !r.error);
      push('V20Pr if run', "CALL v20_if", r => !r.error);
      push('V20Pr if check', "SELECT v FROM v20_out WHERE k = 'if'", r => r.data.length === 1 && r.data[0].v === 1);
      push('V20Pr elseif', "CREATE PROCEDURE v20_grade(s) AS BEGIN DECLARE g TEXT; IF s >= 90 THEN SET g = 'A'; ELSEIF s >= 70 THEN SET g = 'B'; ELSE SET g = 'C'; END IF; RETURN g; END", r => !r.error);
      push('V20Pr elseif A', "CALL v20_grade(95)", r => r.data[0].Result === 'A');
      push('V20Pr elseif B', "CALL v20_grade(75)", r => r.data[0].Result === 'B');
      push('V20Pr elseif C', "CALL v20_grade(10)", r => r.data[0].Result === 'C');
      push('V20Pr while', "CREATE PROCEDURE v20_sum(n) AS BEGIN DECLARE i INT DEFAULT 1; DECLARE s INT DEFAULT 0; WHILE i <= n DO SET s = s + i; SET i = i + 1; END WHILE; RETURN s; END", r => !r.error);
      push('V20Pr while run', "CALL v20_sum(10)", r => r.data[0].Result === 55);
      push('V20Pr while zero', "CALL v20_sum(0)", r => r.data[0].Result === 0);
      push('V20Pr repeat', "CREATE PROCEDURE v20_rep AS BEGIN DECLARE i INT DEFAULT 0; REPEAT SET i = i + 2; UNTIL i >= 6 END REPEAT; RETURN i; END", r => !r.error);
      push('V20Pr repeat run', "CALL v20_rep", r => r.data[0].Result === 6);
      push('V20Pr loop leave', "CREATE PROCEDURE v20_loop AS BEGIN DECLARE i INT DEFAULT 0; lp: LOOP SET i = i + 1; IF i >= 4 THEN LEAVE lp; END IF; END LOOP; RETURN i; END", r => !r.error);
      push('V20Pr loop run', "CALL v20_loop", r => r.data[0].Result === 4);
      push('V20Pr nested if', "CREATE PROCEDURE v20_nest(a, b) AS BEGIN DECLARE r TEXT DEFAULT 'none'; IF a > 0 THEN IF b > 0 THEN SET r = 'both'; ELSE SET r = 'a'; END IF; END IF; RETURN r; END", r => !r.error);
      push('V20Pr nested both', "CALL v20_nest(1, 1)", r => r.data[0].Result === 'both');
      push('V20Pr nested a', "CALL v20_nest(1, -1)", r => r.data[0].Result === 'a');
      push('V20Pr nested none', "CALL v20_nest(-1, 1)", r => r.data[0].Result === 'none');
      push('V20Pr sql loop', "CREATE PROCEDURE v20_fill(n) AS BEGIN DECLARE i INT DEFAULT 0; WHILE i < n DO INSERT INTO v20_out VALUES ('fill', i); SET i = i + 1; END WHILE; END", r => !r.error);
      push('V20Pr sql loop run', "CALL v20_fill(5)", r => !r.error);
      push('V20Pr sql loop check', "SELECT COUNT(*) AS c, SUM(v) AS s FROM v20_out WHERE k = 'fill'", r => r.data[0].c === 5 && r.data[0].s === 10);
      push('V20Pr local in where', "CREATE PROCEDURE v20_find(minv) AS BEGIN SELECT COUNT(*) AS c FROM v20_out WHERE v >= minv; END", r => !r.error);
      push('V20Pr local in where run', "CALL v20_find(3)", r => r.data[0].c === 2);
      push('V20Pr string local', "CREATE PROCEDURE v20_str AS BEGIN DECLARE s TEXT DEFAULT 'hi'; RETURN s || '!' ; END", r => !r.error);
      push('V20Pr string local run', "CALL v20_str", r => r.data[0].Result === 'hi!');
      push('V20Pr case expr inside', "CREATE PROCEDURE v20_case(n) AS BEGIN RETURN CASE WHEN n > 0 THEN 'pos' ELSE 'neg' END; END", r => !r.error);
      push('V20Pr case run', "CALL v20_case(3)", r => r.data[0].Result === 'pos');
      push('V20Pr in params', "CREATE PROCEDURE v20_inout(IN a INT, IN b INT) AS BEGIN RETURN a * b; END", r => !r.error);
      push('V20Pr in params run', "CALL v20_inout(6, 7)", r => r.data[0].Result === 42);
      err('V20Pr wrong arity', "CALL v20_sum(1, 2)", 'expects 1');
      err('V20Pr missing arg', "CALL v20_sum", 'expects 1');
      err('V20Pr unknown proc', "CALL v20_nope", 'not found');
      err('V20Pr empty body', "CREATE PROCEDURE v20_empty AS", 'empty');
      err('V20Pr bad if', "CREATE PROCEDURE v20_badif AS BEGIN IF 1 = 1 SELECT 1; END IF; END", 'syntax');
      fn('V20Pr infinite loop guarded', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v20_inf AS BEGIN DECLARE i INT DEFAULT 0; WHILE 1 = 1 DO SET i = i + 1; END WHILE; END");
        db.statementTimeoutMs = 120;
        const r = db.executeQuery("CALL v20_inf");
        db.statementTimeoutMs = 0;
        db.executeQuery("DROP PROCEDURE IF EXISTS v20_inf");
        return !!r.error && /timeout|iterations/i.test(r.error);
      });
      fn('V20Pr rollback on error', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v20_fail AS BEGIN INSERT INTO v20_out VALUES ('bad', 1); SELECT * FROM v20_no_such_table; END");
        const before = db.executeQuery("SELECT COUNT(*) AS c FROM v20_out").data[0].c;
        const r = db.executeQuery("CALL v20_fail");
        const after = db.executeQuery("SELECT COUNT(*) AS c FROM v20_out").data[0].c;
        db.executeQuery("DROP PROCEDURE IF EXISTS v20_fail");
        db.executeQuery("DELETE FROM v20_out WHERE k = 'bad'");
        // 手続きは自動ロールバックしない（実 DB と同じ）。エラーは伝播すること
        return !!r.error && after === before + 1;
      });
      push('V20Pr show procedures', "SHOW PROCEDURES", r => r.data.some(x => x.Procedure === 'v20_sum'));

      // スクリプト分割: ルーチン本体の ';' で文を切らないこと（エディタ・Import SQL・exec 共通）
      const SPLIT = [
        ["BEGIN; INSERT INTO v20_out VALUES ('s',1); ROLLBACK;", 3],
        ["SELECT 1; SELECT 2", 2],
        ["SELECT 'a;b'; SELECT 2", 2],
        ["CREATE PROCEDURE zz AS BEGIN SELECT 1; SELECT 2; END", 1],
        ["CREATE PROCEDURE zz AS BEGIN DECLARE x INT DEFAULT 1; IF x = 1 THEN SELECT 1; END IF; END; SELECT 9", 2],
        ["CREATE TRIGGER zz AFTER INSERT ON v20_out FOR EACH ROW BEGIN SELECT 1; END; SELECT 8", 2],
        ["CREATE FUNCTION zz(a) RETURNS INT AS BEGIN RETURN a + 1; END", 1],
        ["CREATE PROCEDURE zz(n) AS BEGIN DECLARE i INT DEFAULT 0; WHILE i < n DO SET i = i + 1; END WHILE; RETURN i; END; CALL zz(3)", 2]
      ];
      SPLIT.forEach(([sql, want], i) => fn(`V20Sp split ${i}`, () => db.splitStatements(sql).length === want));
      fn('V20Sp exec routine script', () => {
        const r = db.executeScript("CREATE OR REPLACE PROCEDURE v20_sc(s) AS BEGIN DECLARE r TEXT; IF s > 1 THEN SET r = 'hi'; ELSE SET r = 'lo'; END IF; RETURN r; END; CALL v20_sc(5);");
        db.executeQuery('DROP PROCEDURE IF EXISTS v20_sc');
        return r.total === 2 && r.failed === 0 && r.results[1].data[0].Result === 'hi';
      });
      fn('V20Sp transaction script intact', () => {
        const before = LuminaDB.value("SELECT COUNT(*) AS c FROM v20_out");
        const r = db.executeScript("BEGIN; INSERT INTO v20_out VALUES ('tx', 1); ROLLBACK;");
        const after = LuminaDB.value("SELECT COUNT(*) AS c FROM v20_out");
        return r.total === 3 && r.failed === 0 && after === before;
      });

      // ============================================================
      // 9. ON UPDATE CURRENT_TIMESTAMP
      // ============================================================
      push('V20Ou create', "CREATE TABLE v20_ts (id INTEGER PRIMARY KEY, v INTEGER, upd TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)", r => !r.error);
      push('V20Ou insert', "INSERT INTO v20_ts (id, v) VALUES (1, 1)", r => !r.error);
      push('V20Ou backdate', "UPDATE v20_ts SET upd = '2000-01-01 00:00:00' WHERE id = 1", r => !r.error);
      push('V20Ou explicit kept', "SELECT upd FROM v20_ts WHERE id = 1", r => r.data[0].upd === '2000-01-01 00:00:00');
      push('V20Ou touch', "UPDATE v20_ts SET v = 2 WHERE id = 1", r => !r.error);
      push('V20Ou refreshed', "SELECT (upd > '2020-01-01') AS fresh FROM v20_ts WHERE id = 1", r => r.data[0].fresh === true);
      push('V20Ou no touch on other row', "INSERT INTO v20_ts (id, v) VALUES (2, 1)", r => !r.error);
      push('V20Ou fk on update unaffected', "CREATE TABLE v20_fkp (id INTEGER PRIMARY KEY)", r => !r.error);
      push('V20Ou fk child', "CREATE TABLE v20_fkc (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v20_fkp(id) ON UPDATE CASCADE)", r => !r.error);
      push('V20Ou fk no phantom col', "SELECT COUNT(*) AS c FROM information_schema.columns WHERE TABLE_NAME = 'v20_fkc'", r => r.data[0].c === 2);
      push('V20Ou cleanup fkc', "DROP TABLE v20_fkc", r => !r.error);
      push('V20Ou cleanup fkp', "DROP TABLE v20_fkp", r => !r.error);

      // ============================================================
      // 10. PRAGMA / sqlite_master / DECLARE @x / EXPLAIN FORMAT / DROP CASCADE
      // ============================================================
      push('V20Pg table_info', "PRAGMA table_info(v20_doc)", r => r.data.length === 4 && r.data[0].name === 'id' && r.data[0].pk === 1);
      push('V20Pg table_info notnull', "PRAGMA table_info(v20_doc)", r => r.data[0].notnull === 1);
      push('V20Pg table_list', "PRAGMA table_list", r => r.data.some(x => x.name === 'v20_doc' && x.type === 'table'));
      push('V20Pg index_list', "PRAGMA index_list(v20_doc)", r => Array.isArray(r.data));
      push('V20Pg fk list', "PRAGMA foreign_key_list(v20_doc)", r => r.data.length === 0);
      push('V20Pg user_version get', "PRAGMA user_version", r => typeof r.data[0].user_version === 'number');
      push('V20Pg user_version set', "PRAGMA user_version = 12", r => !r.error);
      push('V20Pg user_version check', "PRAGMA user_version", r => r.data[0].user_version === 12);
      push('V20Pg user_version reset', "PRAGMA user_version = 0", r => !r.error);
      err('V20Pg unknown', "PRAGMA nonsense", 'unsupported pragma');
      err('V20Pg missing table', "PRAGMA table_info(v20_nope)", 'not found');
      push('V20Sm tables', "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'v20_doc'", r => r.data[0].c === 1);
      push('V20Sm sql column', "SELECT sql FROM sqlite_master WHERE name = 'v20_doc'", r => /CREATE TABLE/i.test(r.data[0].sql));
      push('V20Sm view', "CREATE VIEW v20_v AS SELECT id FROM v20_doc", r => !r.error);
      push('V20Sm view listed', "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'view' AND name = 'v20_v'", r => r.data[0].c === 1);
      push('V20Sm drop view', "DROP VIEW v20_v", r => !r.error);
      push('V20Dc declare', "DECLARE @v20x INT = 5", r => !r.error);
      push('V20Dc use', "SELECT @v20x * 2 AS v", r => r.data[0].v === 10);
      push('V20Dc no init', "DECLARE @v20y INT", r => !r.error);
      push('V20Dc null default', "SELECT (@v20y IS NULL) AS x", r => r.data[0].x === true);
      err('V20Dc bad', "DECLARE @ INT", 'syntax');
      push('V20Ex json', "EXPLAIN (FORMAT JSON) SELECT * FROM v20_doc", r => r.data.length === 1 && JSON.parse(r.data[0].QUERY_PLAN)[0].Operation === 'TABLE SCAN');
      push('V20Ex text', "EXPLAIN (FORMAT TEXT) SELECT * FROM v20_doc", r => r.data[0].Operation === 'TABLE SCAN');
      push('V20Ex plain', "EXPLAIN SELECT * FROM v20_doc", r => r.data[0].Operation === 'TABLE SCAN');
      err('V20Ex bad format', "EXPLAIN (FORMAT XML) SELECT * FROM v20_doc", 'unsupported explain format');
      push('V20Dr parent', "CREATE TABLE v20_p (id INTEGER PRIMARY KEY)", r => !r.error);
      push('V20Dr child', "CREATE TABLE v20_c (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v20_p(id))", r => !r.error);
      err('V20Dr restrict', "DROP TABLE v20_p", 'referenced by a foreign key');
      push('V20Dr explicit restrict ok', "DROP TABLE v20_c RESTRICT", r => !r.error);
      push('V20Dr recreate child', "CREATE TABLE v20_c (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v20_p(id))", r => !r.error);
      push('V20Dr cascade', "DROP TABLE v20_p CASCADE", r => !r.error);
      push('V20Dr child usable', "INSERT INTO v20_c VALUES (1, 99)", r => !r.error);
      push('V20Dr cleanup', "DROP TABLE v20_c", r => !r.error);

      // ============================================================
      // 11. ブラウザDB必須機能: マイグレーション / バックアップ / ワーカー
      // ============================================================
      fn('V20Mg applies in order', () => {
        db.executeQuery('PRAGMA user_version = 0');
        db.executeQuery('DROP TABLE IF EXISTS v20_m');
        const r = LuminaDB.migrate([
          { version: 2, up: 'ALTER TABLE v20_m ADD COLUMN tag TEXT' },
          { version: 1, up: 'CREATE TABLE v20_m (id INTEGER PRIMARY KEY, body TEXT)' }
        ]);
        const cols = db.executeQuery("SELECT COUNT(*) AS c FROM information_schema.columns WHERE TABLE_NAME='v20_m'").data[0].c;
        return !r.error && r.applied.join(',') === '1,2' && r.to === 2 && cols === 3;
      });
      fn('V20Mg idempotent', () => {
        const r = LuminaDB.migrate([{ version: 1, up: 'SELECT 1' }, { version: 2, up: 'SELECT 1' }]);
        return !r.error && r.applied.length === 0 && r.to === 2;
      });
      fn('V20Mg only pending', () => {
        const r = LuminaDB.migrate([
          { version: 1, up: 'SELECT 1' }, { version: 2, up: 'SELECT 1' },
          { version: 3, up: 'ALTER TABLE v20_m ADD COLUMN extra INTEGER' }
        ]);
        return !r.error && r.applied.join(',') === '3' && LuminaDB.schemaVersion() === 3;
      });
      fn('V20Mg function step', () => {
        const r = LuminaDB.migrate([{ version: 4, up: (api) => api.exec("INSERT INTO v20_m (id, body) VALUES (1, 'seed')") }]);
        const n = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_m');
        return !r.error && n === 1 && LuminaDB.schemaVersion() === 4;
      });
      fn('V20Mg rolls back on failure', () => {
        const before = LuminaDB.schemaVersion();
        const rows = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_m');
        const r = LuminaDB.migrate([
          { version: 5, up: "INSERT INTO v20_m (id, body) VALUES (2, 'ok')" },
          { version: 6, up: 'THIS IS NOT SQL' }
        ]);
        const after = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_m');
        return !!r.error && /rolled back/i.test(r.error) && LuminaDB.schemaVersion() === before && after === rows;
      });
      fn('V20Mg rejects bad steps', () => {
        return !!LuminaDB.migrate([]).error
            && !!LuminaDB.migrate([{ version: 0, up: 'SELECT 1' }]).error
            && !!LuminaDB.migrate([{ version: 1 }]).error
            && !!LuminaDB.migrate([{ version: 1, up: 'SELECT 1' }, { version: 1, up: 'SELECT 1' }]).error;
      });
      fn('V20Mg cleanup', () => {
        db.executeQuery('DROP TABLE IF EXISTS v20_m');
        db.executeQuery('PRAGMA user_version = 0');
        return true;
      });

      fn('V20Bk roundtrip', () => {
        const text = LuminaDB.backup();
        const before = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_doc');
        db.executeQuery('DELETE FROM v20_doc');
        db.executeQuery('DROP TABLE v20_out');
        const r = LuminaDB.restoreBackup(text);
        const after = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_doc');
        return !r.error && after === before && !!db.tables['v20_out'];
      });
      fn('V20Bk keeps schema objects', () => {
        db.executeQuery("CREATE OR REPLACE FUNCTION v20_f(x) RETURNS INT AS RETURN x + 1");
        db.executeQuery("PRAGMA user_version = 3");
        const text = LuminaDB.backup();
        db.executeQuery("DROP FUNCTION v20_f");
        db.executeQuery("PRAGMA user_version = 0");
        LuminaDB.restoreBackup(text);
        const v = db.executeQuery("SELECT v20_f(1) AS x");
        const uv = db.executeQuery("PRAGMA user_version").data[0].user_version;
        db.executeQuery("DROP FUNCTION IF EXISTS v20_f");
        db.executeQuery("PRAGMA user_version = 0");
        return !v.error && v.data[0].x === 2 && uv === 3;
      });
      fn('V20Bk format is json', () => {
        const o = JSON.parse(LuminaDB.backup());
        return o.__format__ === 'luminadb-backup' && !!o.payload && typeof o.__created_at__ === 'string';
      });
      fn('V20Bk rejects garbage', () => !!LuminaDB.restoreBackup('{"nope":1}').error && !!LuminaDB.restoreBackup('not json').error);
      fn('V20Bk rejects during tx', () => {
        const text = LuminaDB.backup();
        db.executeQuery('BEGIN');
        const r = LuminaDB.restoreBackup(text);
        db.executeQuery('ROLLBACK');
        return !!r.error && /transaction/i.test(r.error);
      });
      fn('V20Bk download helper exists', () => typeof LuminaDB.download === 'function' && typeof downloadBackup === 'function');
      fn('V20Bk web locks used for save', () => /luminadb-write/.test(withWriteLock.toString()));

      fn('V20Wk supported', () => LuminaDB.worker.supported() === (typeof Worker !== 'undefined'));
      fn('V20Wk start and ping', async () => {
        const r = await LuminaDB.worker.start();
        return r.started === true && LuminaDB.worker.running();
      });
      fn('V20Wk sync and query', async () => {
        await LuminaDB.worker.sync();
        const r = await LuminaDB.worker.query('SELECT COUNT(*) AS c FROM v20_doc');
        return !r.error && r.data[0].c === 4;
      });
      fn('V20Wk params bound', async () => {
        const rows = await LuminaDB.worker.rows('SELECT ? AS v', ["'; DROP TABLE v20_doc; --"]);
        const still = await LuminaDB.worker.query('SELECT COUNT(*) AS c FROM v20_doc');
        return rows[0].v === "'; DROP TABLE v20_doc; --" && still.data[0].c === 4;
      });
      fn('V20Wk isolated from main thread', async () => {
        await LuminaDB.worker.exec('CREATE TABLE v20_wonly (id INTEGER); INSERT INTO v20_wonly VALUES (1);');
        const inWorker = await LuminaDB.worker.query('SELECT COUNT(*) AS c FROM v20_wonly');
        const inMain = db.executeQuery('SELECT COUNT(*) AS c FROM v20_wonly');
        return inWorker.data[0].c === 1 && !!inMain.error;
      });
      fn('V20Wk pull writes back', async () => {
        await LuminaDB.worker.pull();
        const inMain = db.executeQuery('SELECT COUNT(*) AS c FROM v20_wonly');
        const ok = !inMain.error && inMain.data[0].c === 1;
        db.executeQuery('DROP TABLE IF EXISTS v20_wonly');
        return ok;
      });
      fn('V20Wk keeps main thread responsive', async () => {
        await LuminaDB.worker.reset();
        let ticks = 0;
        const iv = setInterval(() => ticks++, 4);
        await LuminaDB.worker.exec("CREATE TABLE wbig (id INTEGER, n INTEGER); INSERT INTO wbig SELECT value, MOD(value*7,997) FROM GENERATE_SERIES(1,40000);");
        const agg = await LuminaDB.worker.query('SELECT COUNT(*) AS c FROM wbig');
        clearInterval(iv);
        // ワーカー実行中もメインスレッドのタイマーが進む＝UI が固まっていない
        return agg.data[0].c === 40000 && ticks >= 2;
      });
      fn('V20Wk timeout in worker', async () => {
        await LuminaDB.worker.timeout(50);
        const r = await LuminaDB.worker.query('SELECT COUNT(*) AS c FROM wbig a JOIN wbig b ON a.n <> b.n');
        await LuminaDB.worker.timeout(0);
        return !!r.error && /timeout/i.test(r.error);
      });
      fn('V20Wk read-only in worker', async () => {
        await LuminaDB.worker.readOnly(true);
        const w = await LuminaDB.worker.query('DELETE FROM wbig');
        await LuminaDB.worker.readOnly(false);
        return !!w.error && /read-only/i.test(w.error);
      });
      fn('V20Wk unknown op rejected', async () => {
        try { await LuminaDB.worker._call('evil', {}); return false; }
        catch (e) { return /unknown worker op/i.test(e.message); }
      });
      fn('V20Wk stop', () => {
        const stopped = LuminaDB.worker.stop();
        return stopped && !LuminaDB.worker.running();
      });
      fn('V20Wk call after stop rejects', async () => {
        try { await LuminaDB.worker.query('SELECT 1'); return false; }
        catch (e) { return /not running/i.test(e.message); }
      });

      // ============================================================
      // 12. 新しい入口のセキュリティ
      // ============================================================
      const PAYLOADS = [
        "'; DROP TABLE v20_doc; --",
        "' OR '1'='1",
        "` + (window.__v20_pwned = 1) + `",
        "${window.__v20_pwned = 1}",
        "'); window.__v20_pwned = 1; ('",
        "__proto__",
        "constructor.prototype.__v20_polluted",
        "line1\nline2",
        "</script><img src=x onerror=alert(1)>"
      ];
      PAYLOADS.forEach((p, i) => {
        // プロシージャのローカル変数へ渡しても、SQL 構造は変わらない
        fn(`V20Sec proc arg ${i}`, () => {
          db.executeQuery("CREATE OR REPLACE PROCEDURE v20_echo(s) AS BEGIN RETURN s; END");
          const q = "'" + p.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
          const r = db.executeQuery(`CALL v20_echo(${q})`);
          const rows = db.executeQuery("SELECT COUNT(*) AS c FROM v20_doc");
          return !r.error && r.data[0].Result === p && !rows.error && rows.data[0].c === 4 && canaryClean();
        });
        // プロシージャ内の SQL へ差し込まれても値のまま
        fn(`V20Sec proc sql ${i}`, () => {
          db.executeQuery("CREATE OR REPLACE PROCEDURE v20_store(s) AS BEGIN INSERT INTO v20_out VALUES ('sec', 0); UPDATE v20_out SET k = s WHERE v = 0; END");
          const q = "'" + p.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
          const r = db.executeQuery(`CALL v20_store(${q})`);
          const got = db.executeQuery("SELECT k FROM v20_out WHERE v = 0");
          db.executeQuery("DELETE FROM v20_out WHERE v = 0");
          return !r.error && got.data[0].k === p && canaryClean();
        });
        // MATCH の検索語
        fn(`V20Sec match term ${i}`, () => {
          const r = LuminaDB.query('SELECT COUNT(*) AS c FROM v20_doc WHERE MATCH(body) AGAINST(?)', [p]);
          const rows = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_doc');
          return !r.error && rows === 4 && canaryClean();
        });
        // COLLATE 対象の値
        fn(`V20Sec collate value ${i}`, () => {
          const r = LuminaDB.query('SELECT (? COLLATE NOCASE) AS v', [p]);
          return !r.error && String(r.data[0].v) === p.toLowerCase() && canaryClean();
        });
        // JSON_TABLE のドキュメント本体
        fn(`V20Sec json_table doc ${i}`, () => {
          const doc = JSON.stringify([{ a: p }]);
          const r = LuminaDB.query("SELECT a FROM JSON_TABLE(?, '$[*]' COLUMNS (a TEXT PATH '$.a')) t", [doc]);
          return !r.error && r.data[0].a === p && canaryClean();
        });
        // バックアップの取り込み（壊れた入力でクラッシュしない）
        fn(`V20Sec backup garbage ${i}`, () => {
          const r = LuminaDB.restoreBackup(p);
          const rows = LuminaDB.value('SELECT COUNT(*) AS c FROM v20_doc');
          return !!r.error && rows === 4 && canaryClean();
        });
      });
      fn('V20Sec json_table proto path', () => {
        const r = db.executeQuery("SELECT * FROM JSON_TABLE('[{\"__proto__\":{\"x\":1}}]', '$[*]' COLUMNS (v TEXT PATH '$.__proto__')) t");
        return canaryClean() && ({}).x === undefined;
      });
      fn('V20Sec proc cannot escape via local name', () => {
        // ローカル名がテーブル名と同じでも、SQL 構造は書き換わらない
        db.executeQuery("CREATE OR REPLACE PROCEDURE v20_shadow AS BEGIN DECLARE v20_doc INT DEFAULT 1; RETURN v20_doc; END");
        const r = db.executeQuery("CALL v20_shadow");
        const rows = db.executeQuery("SELECT COUNT(*) AS c FROM v20_doc");
        db.executeQuery("DROP PROCEDURE IF EXISTS v20_shadow");
        return !r.error && r.data[0].Result === 1 && rows.data[0].c === 4;
      });
      fn('V20Sec proc depth guarded', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v20_r1 AS BEGIN CALL v20_r1; END");
        const r = db.executeQuery("CALL v20_r1");
        db.executeQuery("DROP PROCEDURE IF EXISTS v20_r1");
        return !!r.error && /depth limit/i.test(r.error);
      });
      fn('V20Sec pragma read-only blocked', () => {
        db.executeQuery("SET read_only = ON");
        const w = db.executeQuery("PRAGMA user_version = 99");
        const rd = db.executeQuery("PRAGMA table_info(v20_doc)");
        db.executeQuery("SET read_only = OFF");
        return !!w.error && /read-only/i.test(w.error) && !rd.error;
      });
      fn('V20Sec migrate blocked read-only', () => {
        db.executeQuery("SET read_only = ON");
        const r = LuminaDB.migrate([{ version: 99, up: 'CREATE TABLE v20_ro_m (x INTEGER)' }]);
        db.executeQuery("SET read_only = OFF");
        return !!r.error && !db.tables['v20_ro_m'];
      });
      fn('V20Sec canary clean', () => canaryClean());

      // ============================================================
      // 13. 新機能のパフォーマンス予算
      // ============================================================
      fn('V20Pf fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v20_big");
        db.executeQuery("CREATE TABLE v20_big (id INTEGER, g INTEGER, s TEXT, v INTEGER)");
        const r = db.executeQuery("INSERT INTO v20_big SELECT value, MOD(value, 50), 'doc ' || value || ' lorem ipsum', " +
          "CASE WHEN MOD(value, 3) = 0 THEN NULL ELSE value END FROM GENERATE_SERIES(1, 20000)");
        return !r.error && db.tables['v20_big'].rowCount === 20000;
      });
      const perf = (name, sql, capMs, check) => fn(name, () => {
        const r = db.executeQuery(sql);
        if (r.error) return false;
        if (check && !check(r)) return false;
        return Number(r.executionTime) < capMs;
      });
      perf('V20Pf interval math 20k', "SELECT COUNT(*) AS c FROM v20_big WHERE DATE '2020-01-01' + INTERVAL 1 DAY > DATE '2020-01-01'", 900, r => r.data[0].c === 20000);
      perf('V20Pf collate scan 20k', "SELECT COUNT(*) AS c FROM v20_big WHERE s COLLATE NOCASE = 'DOC 5 LOREM IPSUM'", 900, r => r.data[0].c === 1);
      perf('V20Pf collate order 20k', "SELECT id FROM v20_big ORDER BY s COLLATE NOCASE LIMIT 5", 1500, r => r.data.length === 5);
      perf('V20Pf match 20k', "SELECT COUNT(*) AS c FROM v20_big WHERE MATCH(s) AGAINST('lorem')", 1500, r => r.data[0].c === 20000);
      perf('V20Pf match rare 20k', "SELECT COUNT(*) AS c FROM v20_big WHERE MATCH(s) AGAINST('19999')", 1500, r => r.data[0].c === 1);
      perf('V20Pf like any 20k', "SELECT COUNT(*) AS c FROM v20_big WHERE s LIKE ANY ('doc 1 %', 'doc 2 %')", 900, r => r.data[0].c === 2);
      perf('V20Pf ignore nulls 20k', "SELECT COUNT(*) AS c FROM (SELECT LAG(v) IGNORE NULLS OVER (PARTITION BY g ORDER BY id) AS p FROM v20_big) t", 2500, r => r.data[0].c === 20000);
      perf('V20Pf tablesample 20k', "SELECT COUNT(*) AS c FROM v20_big TABLESAMPLE (10 PERCENT) REPEATABLE (1)", 900, r => r.data[0].c > 1000 && r.data[0].c < 3000);
      perf('V20Pf tablesample rows', "SELECT COUNT(*) AS c FROM v20_big TABLESAMPLE (100 ROWS)", 900, r => r.data[0].c === 100);
      fn('V20Pf json_table 5k rows', () => {
        const arr = [];
        for (let i = 0; i < 5000; i++) arr.push({ a: i, b: 'x' + i });
        const doc = JSON.stringify(arr).replace(/'/g, "''");
        const t0 = performance.now();
        const r = db.executeQuery(`SELECT COUNT(*) AS c, SUM(a) AS s FROM JSON_TABLE('${doc}', '$[*]' COLUMNS (a INT PATH '$.a', b TEXT PATH '$.b')) t`);
        const ms = performance.now() - t0;
        return !r.error && r.data[0].c === 5000 && ms < 2000;
      });
      fn('V20Pf procedure loop 2000 iterations', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v20_bench(n) AS BEGIN DECLARE i INT DEFAULT 0; DECLARE s INT DEFAULT 0; WHILE i < n DO SET s = s + i; SET i = i + 1; END WHILE; RETURN s; END");
        const t0 = performance.now();
        const r = db.executeQuery("CALL v20_bench(2000)");
        const ms = performance.now() - t0;
        db.executeQuery("DROP PROCEDURE IF EXISTS v20_bench");
        return !r.error && r.data[0].Result === 1999000 && ms < 4000;
      });
      fn('V20Pf backup 20k rows', () => {
        const t0 = performance.now();
        const text = LuminaDB.backup();
        const ms = performance.now() - t0;
        return text.length > 1000 && ms < 3000;
      });
      fn('V20Pf pragma cheap', () => {
        const r = db.executeQuery("PRAGMA table_info(v20_big)");
        return !r.error && Number(r.executionTime) < 100;
      });
      fn('V20Pf sqlite_master cheap', () => {
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM sqlite_master");
        return !r.error && Number(r.executionTime) < 300;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V20Cl drop procs', () => {
        ['v20_if', 'v20_grade', 'v20_sum', 'v20_rep', 'v20_loop', 'v20_nest', 'v20_fill',
         'v20_find', 'v20_str', 'v20_case', 'v20_inout', 'v20_echo', 'v20_store'].forEach(p =>
          db.executeQuery(`DROP PROCEDURE IF EXISTS ${p}`));
        return true;
      });
      fn('V20Cl drop tables', () => {
        ['v20_big', 'v20_out', 'v20_ts', 'v20_gaps', 'v20_doc'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        db.executeQuery('PRAGMA user_version = 0');
        return true;
      });

      return T;
    }
