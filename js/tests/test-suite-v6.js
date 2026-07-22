    // ============================================================================
    // [Test Suite v6] - v1.5 機能追加の回帰テスト
    //   1. V6Hash: MD5 / CRC32 / TO_BASE64 / FROM_BASE64 / INET_ATON / INET_NTOA
    //   2. V6Str : SOUNDEX / TRANSLATE / INSERT(文字列関数)
    //   3. V6Num : COSH / TANH / TRUNC / RANDOM / NVL / FORMAT_BYTES
    //   4. V6Date: TO_DAYS / FROM_DAYS / TIMESTAMPADD / MAKETIME / CURTIME / UTC_DATE
    //   5. V6Json: JSON_PRETTY / QUOTE / UNQUOTE / ARRAY_APPEND / MERGE_PATCH / DEPTH
    //   6. V6Agg : MIN_BY / MAX_BY / COUNT_IF / PERCENTILE_CONT / PERCENTILE_DISC
    //   7. V6Roll: GROUP BY ... WITH ROLLUP / GROUP BY ROLLUP(...)
    //   8. V6Stmt: VALUES 文 / TABLE 拡張 / FROM DUAL / CTE 列リスト / CTAS の AS 省略
    //   9. V6Show: SHOW FUNCTIONS / SHOW TRIGGERS FROM / CHECK TABLE / ANALYZE TABLE
    //  10. V6Api : rows / row / value / get / pluck / csv / schema / where 拡張 / 排他制御
    //   test-suite.js の tests 配列へ getV6Tests() のスプレッドで合流する
    // ============================================================================
    function getV6Tests() {
      return [
        // ============================================================
        // 1. ハッシュ / エンコード (V6Hash)
        // ============================================================
        { name: "V6Hash: MD5 Known Vector", sql: "SELECT MD5('abc') AS h", check: r => r.data[0].h === '900150983cd24fb0d6963f7d28e17f72' },
        { name: "V6Hash: MD5 Empty String", sql: "SELECT MD5('') AS h", check: r => r.data[0].h === 'd41d8cd98f00b204e9800998ecf8427e' },
        { name: "V6Hash: MD5 Long Input (Multi Block)", sql: "SELECT MD5(REPEAT('a', 100)) AS h", check: r => r.data[0].h === '36a92cc94a9e0fa21f625f8bfb007adf' },
        { name: "V6Hash: MD5 NULL Passthrough", sql: "SELECT MD5(NULL) AS h", check: r => r.data[0].h === null },
        { name: "V6Hash: CRC32 Known Vector", sql: "SELECT CRC32('abc') AS c", check: r => r.data[0].c === 891568578 },
        { name: "V6Hash: CRC32 Of Column", fn: () => {
            db.executeQuery("CREATE TABLE v6hash (s TEXT)");
            db.executeQuery("INSERT INTO v6hash (s) VALUES ('abc'), ('abc')");
            const r = db.executeQuery("SELECT COUNT(DISTINCT CRC32(s)) AS c FROM v6hash");
            db.executeQuery("DROP TABLE v6hash");
            return r.data[0].c === 1;
        }},
        { name: "V6Hash: TO_BASE64 Basic", sql: "SELECT TO_BASE64('Hello') AS b", check: r => r.data[0].b === 'SGVsbG8=' },
        { name: "V6Hash: FROM_BASE64 Basic", sql: "SELECT FROM_BASE64('SGVsbG8=') AS s", check: r => r.data[0].s === 'Hello' },
        { name: "V6Hash: Base64 Roundtrip Unicode", sql: "SELECT FROM_BASE64(TO_BASE64('こんにちは🍣')) AS s", check: r => r.data[0].s === 'こんにちは🍣' },
        { name: "V6Hash: FROM_BASE64 Invalid Returns NULL", sql: "SELECT FROM_BASE64('@@@@') AS s", check: r => r.data[0].s === null },
        { name: "V6Hash: INET_ATON", sql: "SELECT INET_ATON('192.168.1.1') AS n", check: r => r.data[0].n === 3232235777 },
        { name: "V6Hash: INET_NTOA", sql: "SELECT INET_NTOA(3232235777) AS ip", check: r => r.data[0].ip === '192.168.1.1' },
        { name: "V6Hash: INET_ATON Invalid Returns NULL", sql: "SELECT INET_ATON('999.1.1.1') AS n, INET_ATON('abc') AS m", check: r => r.data[0].n === null && r.data[0].m === null },
        { name: "V6Hash: INET Roundtrip Boundary", sql: "SELECT INET_NTOA(INET_ATON('0.0.0.0')) AS a, INET_NTOA(INET_ATON('255.255.255.255')) AS b", check: r => r.data[0].a === '0.0.0.0' && r.data[0].b === '255.255.255.255' },

        // ============================================================
        // 2. 文字列関数 (V6Str)
        // ============================================================
        { name: "V6Str: SOUNDEX Classic", sql: "SELECT SOUNDEX('Robert') AS a, SOUNDEX('Rupert') AS b", check: r => r.data[0].a === 'R163' && r.data[0].a === r.data[0].b },
        { name: "V6Str: SOUNDEX Padding", sql: "SELECT SOUNDEX('Lee') AS s", check: r => r.data[0].s === 'L000' },
        { name: "V6Str: TRANSLATE Maps Chars", sql: "SELECT TRANSLATE('abc-def-ghi', '-', '_') AS s", check: r => r.data[0].s === 'abc_def_ghi' },
        { name: "V6Str: TRANSLATE Deletes Extra", sql: "SELECT TRANSLATE('a1b2c3', '123', 'x') AS s", check: r => r.data[0].s === 'axbc' },
        { name: "V6Str: INSERT Replaces Middle", sql: "SELECT INSERT('Quadratic', 3, 4, 'What') AS s", check: r => r.data[0].s === 'QuWhattic' },
        { name: "V6Str: INSERT Out Of Range Keeps Original", sql: "SELECT INSERT('abc', 99, 1, 'x') AS s, INSERT('abc', 0, 1, 'x') AS t", check: r => r.data[0].s === 'abc' && r.data[0].t === 'abc' },
        { name: "V6Str: INSERT Long Len Replaces Rest", sql: "SELECT INSERT('Quadratic', 3, 100, 'What') AS s", check: r => r.data[0].s === 'QuWhat' },
        { name: "V6Str: INSERT In Where Clause", fn: () => {
            const r = db.executeQuery("SELECT name FROM users WHERE INSERT(name, 1, 1, 'X') = 'Xlice'");
            return !r.error && r.data.length === 1 && r.data[0].name === 'Alice';
        }},

        // ============================================================
        // 3. 数値関数 (V6Num)
        // ============================================================
        { name: "V6Num: COSH TANH At Zero", sql: "SELECT COSH(0) AS c, TANH(0) AS t", check: r => r.data[0].c === 1 && r.data[0].t === 0 },
        { name: "V6Num: TRUNC Alias Of TRUNCATE", sql: "SELECT TRUNC(3.987, 2) AS a, TRUNC(-3.987, 1) AS b", check: r => r.data[0].a === 3.98 && r.data[0].b === -3.9 },
        { name: "V6Num: RANDOM Range", sql: "SELECT RANDOM() AS r", check: r => typeof r.data[0].r === 'number' && r.data[0].r >= 0 && r.data[0].r < 1 },
        { name: "V6Num: NVL Alias Of IFNULL", sql: "SELECT NVL(NULL, 'fb') AS a, NVL('x', 'fb') AS b", check: r => r.data[0].a === 'fb' && r.data[0].b === 'x' },
        { name: "V6Num: FORMAT_BYTES Scales", sql: "SELECT FORMAT_BYTES(512) AS a, FORMAT_BYTES(1536) AS b, FORMAT_BYTES(1073741824) AS c", check: r =>
            r.data[0].a === '512 bytes' && r.data[0].b === '1.50 KB' && r.data[0].c === '1.00 GB' },
        { name: "V6Num: FORMAT_BYTES Negative", sql: "SELECT FORMAT_BYTES(-2048) AS a", check: r => r.data[0].a === '-2.00 KB' },

        // ============================================================
        // 4. 日付関数 (V6Date)
        // ============================================================
        { name: "V6Date: TO_DAYS Epoch", sql: "SELECT TO_DAYS('1970-01-01') AS d", check: r => r.data[0].d === 719528 },
        { name: "V6Date: FROM_DAYS Inverse", sql: "SELECT FROM_DAYS(TO_DAYS('2026-07-17')) AS d", check: r => r.data[0].d === '2026-07-17' },
        { name: "V6Date: TO_DAYS Difference Is Days", sql: "SELECT TO_DAYS('2026-01-10') - TO_DAYS('2026-01-01') AS d", check: r => r.data[0].d === 9 },
        { name: "V6Date: TIMESTAMPADD Month End Clamp", sql: "SELECT TIMESTAMPADD(MONTH, 1, '2026-01-31') AS d", check: r => String(r.data[0].d).startsWith('2026-02-28') },
        { name: "V6Date: TIMESTAMPADD Negative Hours", sql: "SELECT TIMESTAMPADD(HOUR, -2, '2026-01-01 10:00:00') AS d", check: r => r.data[0].d === '2026-01-01 08:00:00' },
        { name: "V6Date: TIMESTAMPADD Then DIFF Roundtrip", sql: "SELECT TIMESTAMPDIFF(DAY, '2026-01-01', TIMESTAMPADD(DAY, 45, '2026-01-01')) AS d", check: r => r.data[0].d === 45 },
        { name: "V6Date: MAKETIME Pads", sql: "SELECT MAKETIME(9, 5, 3) AS t", check: r => r.data[0].t === '09:05:03' },
        { name: "V6Date: MAKETIME Rejects Bad Minutes", sql: "SELECT MAKETIME(1, 99, 0) AS t", check: r => r.data[0].t === null },
        { name: "V6Date: CURTIME Format", sql: "SELECT CURTIME() AS t", check: r => /^\d{2}:\d{2}:\d{2}$/.test(String(r.data[0].t)) },
        { name: "V6Date: CURRENT_TIME Keyword", sql: "SELECT CURRENT_TIME AS t", check: r => /^\d{2}:\d{2}:\d{2}$/.test(String(r.data[0].t)) },
        { name: "V6Date: UTC_DATE Format", sql: "SELECT UTC_DATE AS d, UTC_DATE() AS e", check: r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.data[0].d)) && r.data[0].d === r.data[0].e },
        { name: "V6Date: DAYOFMONTH Alias", sql: "SELECT DAYOFMONTH('2026-07-17') AS d", check: r => r.data[0].d === 17 },

        // ============================================================
        // 5. JSON 関数 (V6Json)
        // ============================================================
        { name: "V6Json: JSON_PRETTY Indents", sql: `SELECT JSON_PRETTY('{"a":1}') AS p`, check: r => r.data[0].p === '{\n  "a": 1\n}' },
        { name: "V6Json: JSON_QUOTE Escapes", sql: `SELECT JSON_QUOTE('ab"c') AS q`, check: r => r.data[0].q === '"ab\\"c"' },
        { name: "V6Json: JSON_UNQUOTE Unwraps", sql: `SELECT JSON_UNQUOTE('"hello"') AS u`, check: r => r.data[0].u === 'hello' },
        { name: "V6Json: JSON_UNQUOTE Passthrough", sql: "SELECT JSON_UNQUOTE('plain') AS u", check: r => r.data[0].u === 'plain' },
        { name: "V6Json: Quote Unquote Roundtrip", sql: `SELECT JSON_UNQUOTE(JSON_QUOTE('a"b\\\\c')) AS u`, check: r => r.data[0].u === 'a"b\\c' },
        { name: "V6Json: JSON_DEPTH Scalar And Nested", sql: `SELECT JSON_DEPTH('5') AS a, JSON_DEPTH('[1, 2]') AS b, JSON_DEPTH('{"a": {"b": [1]}}') AS c`, check: r =>
            r.data[0].a === 1 && r.data[0].b === 2 && r.data[0].c === 4 },
        { name: "V6Json: JSON_DEPTH Empty Containers", sql: "SELECT JSON_DEPTH('[]') AS a, JSON_DEPTH('{}') AS b", check: r => r.data[0].a === 1 && r.data[0].b === 1 },
        { name: "V6Json: JSON_ARRAY_APPEND To Path", sql: `SELECT JSON_ARRAY_APPEND('{"tags": [1, 2]}', '$.tags', 3) AS j`, check: r => r.data[0].j === '{"tags":[1,2,3]}' },
        { name: "V6Json: JSON_ARRAY_APPEND Root", sql: "SELECT JSON_ARRAY_APPEND('[1, 2]', '$', 3) AS j", check: r => r.data[0].j === '[1,2,3]' },
        { name: "V6Json: JSON_ARRAY_APPEND Wraps Scalar", sql: `SELECT JSON_ARRAY_APPEND('{"a": 1}', '$.a', 2) AS j`, check: r => r.data[0].j === '{"a":[1,2]}' },
        { name: "V6Json: JSON_MERGE_PATCH Merge And Delete", sql: `SELECT JSON_MERGE_PATCH('{"a": 1, "b": 2}', '{"b": null, "c": 3}') AS j`, check: r => r.data[0].j === '{"a":1,"c":3}' },
        { name: "V6Json: JSON_MERGE_PATCH Nested", sql: `SELECT JSON_MERGE_PATCH('{"o": {"x": 1, "y": 2}}', '{"o": {"y": 9}}') AS j`, check: r => r.data[0].j === '{"o":{"x":1,"y":9}}' },
        { name: "V6Json: JSON_MERGE_PATCH Scalar Replaces", sql: `SELECT JSON_MERGE_PATCH('{"a": 1}', '[9]') AS j`, check: r => r.data[0].j === '[9]' },

        // ============================================================
        // 6. 新集計関数 (V6Agg)
        // ============================================================
        { name: "V6Agg: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v6agg (grp TEXT, item TEXT, score INTEGER)");
            db.executeQuery("INSERT INTO v6agg (grp, item, score) VALUES " +
                "('a', 'a1', 10), ('a', 'a2', 30), ('a', 'a3', 20), " +
                "('b', 'b1', 5), ('b', 'b2', 15), ('b', 'b3', NULL)");
            return true;
        }},
        { name: "V6Agg: MAX_BY Whole Table", sql: "SELECT MAX_BY(item, score) AS top FROM v6agg", check: r => r.data[0].top === 'a2' },
        { name: "V6Agg: MIN_BY Whole Table", sql: "SELECT MIN_BY(item, score) AS low FROM v6agg", check: r => r.data[0].low === 'b1' },
        { name: "V6Agg: MIN_BY MAX_BY Group By", sql: "SELECT grp, MAX_BY(item, score) AS top, MIN_BY(item, score) AS low FROM v6agg GROUP BY grp ORDER BY grp", check: r =>
            r.data.length === 2 && r.data[0].top === 'a2' && r.data[0].low === 'a1' && r.data[1].top === 'b2' && r.data[1].low === 'b1' },
        { name: "V6Agg: MAX_BY Skips NULL Keys", sql: "SELECT MAX_BY(item, score) AS top FROM v6agg WHERE grp = 'b'", check: r => r.data[0].top === 'b2' },
        { name: "V6Agg: MIN_BY Empty Group Is NULL", sql: "SELECT MIN_BY(item, score) AS v FROM v6agg WHERE grp = 'zzz'", check: r => r.data[0].v === null },
        // NULL は既存エンジンの比較セマンティクス（JS 準拠: NULL < 15 は真）に従うため、
        // 下限側は IS NOT NULL で明示的に除外する
        { name: "V6Agg: COUNT_IF Basic", sql: "SELECT COUNT_IF(score >= 15) AS hi, COUNT_IF(score < 15 AND score IS NOT NULL) AS lo FROM v6agg", check: r => r.data[0].hi === 3 && r.data[0].lo === 2 },
        { name: "V6Agg: COUNT_IF IS NULL Condition", sql: "SELECT COUNT_IF(score IS NULL) AS n FROM v6agg", check: r => r.data[0].n === 1 },
        { name: "V6Agg: COUNT_IF Group By", sql: "SELECT grp, COUNT_IF(score > 10) AS c FROM v6agg GROUP BY grp ORDER BY grp", check: r =>
            r.data[0].c === 2 && r.data[1].c === 1 },
        { name: "V6Agg: COUNT_IF In HAVING", sql: "SELECT grp FROM v6agg GROUP BY grp HAVING COUNT_IF(score > 10) >= 2", check: r =>
            r.data.length === 1 && r.data[0].grp === 'a' },
        { name: "V6Agg: PERCENTILE_CONT Median", sql: "SELECT PERCENTILE_CONT(score, 0.5) AS p FROM v6agg WHERE grp = 'a'", check: r => r.data[0].p === 20 },
        { name: "V6Agg: PERCENTILE_CONT Interpolates", sql: "SELECT PERCENTILE_CONT(score, 0.25) AS p FROM v6agg WHERE grp = 'a'", check: r => r.data[0].p === 15 },
        { name: "V6Agg: PERCENTILE_DISC Picks Existing", sql: "SELECT PERCENTILE_DISC(score, 0.5) AS p FROM v6agg WHERE grp = 'a'", check: r => r.data[0].p === 20 },
        { name: "V6Agg: PERCENTILE_CONT Matches MEDIAN", fn: () => {
            const a = db.executeQuery("SELECT PERCENTILE_CONT(age, 0.5) AS p FROM users").data[0].p;
            const b = db.executeQuery("SELECT MEDIAN(age) AS m FROM users").data[0].m;
            return a === b;
        }},
        { name: "V6Agg: PERCENTILE Bad Fraction Rejected", sql: "SELECT PERCENTILE_CONT(score, 1.5) AS p FROM v6agg", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('between 0 and 1') },
        { name: "V6Agg: PERCENTILE Empty Group Is NULL", sql: "SELECT PERCENTILE_CONT(score, 0.5) AS p FROM v6agg WHERE grp = 'zzz'", check: r => r.data[0].p === null },
        { name: "V6Agg: MAX_BY Requires 2 Args", sql: "SELECT MAX_BY(item) FROM v6agg", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('2 arguments') },
        { name: "V6Agg: ORDER BY COUNT_IF Rewrite", sql: "SELECT grp FROM v6agg GROUP BY grp ORDER BY COUNT_IF(score > 10) DESC", check: r =>
            r.data.length === 2 && r.data[0].grp === 'a' },

        // ============================================================
        // 7. ROLLUP (V6Roll)
        // ============================================================
        { name: "V6Roll: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v6roll (dept TEXT, team TEXT, val INTEGER)");
            db.executeQuery("INSERT INTO v6roll (dept, team, val) VALUES ('A', 'x', 10), ('A', 'y', 20), ('B', 'x', 30)");
            return true;
        }},
        { name: "V6Roll: WITH ROLLUP Adds Subtotals", fn: () => {
            const r = db.executeQuery("SELECT dept, team, SUM(val) AS s FROM v6roll GROUP BY dept, team WITH ROLLUP");
            if (r.error || r.data.length !== 6) return false;
            const grand = r.data.find(x => x.dept === null && x.team === null);
            const subA = r.data.find(x => x.dept === 'A' && x.team === null);
            const subB = r.data.find(x => x.dept === 'B' && x.team === null);
            return grand && grand.s === 60 && subA && subA.s === 30 && subB && subB.s === 30;
        }},
        { name: "V6Roll: ROLLUP() Function Form", fn: () => {
            const r = db.executeQuery("SELECT dept, SUM(val) AS s FROM v6roll GROUP BY ROLLUP(dept)");
            if (r.error || r.data.length !== 3) return false;
            const grand = r.data.find(x => x.dept === null);
            return grand && grand.s === 60;
        }},
        { name: "V6Roll: Grand Total Is Last", fn: () => {
            const r = db.executeQuery("SELECT dept, team, COUNT(*) AS c FROM v6roll GROUP BY dept, team WITH ROLLUP");
            const last = r.data[r.data.length - 1];
            return last.dept === null && last.team === null && last.c === 3;
        }},
        { name: "V6Roll: Expression Group Nulled", fn: () => {
            const r = db.executeQuery("SELECT UPPER(dept) AS d, SUM(val) AS s FROM v6roll GROUP BY UPPER(dept) WITH ROLLUP");
            if (r.error || r.data.length !== 3) return false;
            const grand = r.data.find(x => x.d === null);
            return grand && grand.s === 60;
        }},
        { name: "V6Roll: Ordinal Group Nulled", fn: () => {
            const r = db.executeQuery("SELECT dept, SUM(val) AS s FROM v6roll GROUP BY 1 WITH ROLLUP");
            if (r.error || r.data.length !== 3) return false;
            const grand = r.data.find(x => x.dept === null);
            return grand && grand.s === 60;
        }},
        { name: "V6Roll: HAVING Filters Subtotals Too", fn: () => {
            const r = db.executeQuery("SELECT dept, SUM(val) AS s FROM v6roll GROUP BY dept WITH ROLLUP HAVING s >= 60");
            return !r.error && r.data.length === 1 && r.data[0].dept === null && r.data[0].s === 60;
        }},
        { name: "V6Roll: ORDER BY Applies After Rollup", fn: () => {
            const r = db.executeQuery("SELECT dept, SUM(val) AS s FROM v6roll GROUP BY dept WITH ROLLUP ORDER BY s DESC NULLS LAST");
            return !r.error && r.data.length === 3 && r.data[0].s === 60;
        }},
        { name: "V6Roll: Empty Table No Rollup Rows", fn: () => {
            db.executeQuery("CREATE TABLE v6roll_e (a TEXT, v INTEGER)");
            const r = db.executeQuery("SELECT a, SUM(v) AS s FROM v6roll_e GROUP BY a WITH ROLLUP");
            db.executeQuery("DROP TABLE v6roll_e");
            return !r.error && r.data.length === 0;
        }},
        { name: "V6Roll: Cleanup", sql: "DROP TABLE v6roll, v6agg", check: r => r.data[0].Message.includes('dropped') },

        // ============================================================
        // 8. 新しい文 (V6Stmt)
        // ============================================================
        { name: "V6Stmt: VALUES Statement Basic", sql: "VALUES (1, 'one'), (2, 'two')", check: r =>
            r.data.length === 2 && r.data[0].column1 === 1 && r.data[0].column2 === 'one' && r.data[1].column1 === 2 },
        { name: "V6Stmt: VALUES With Expressions", sql: "VALUES (1 + 1, UPPER('ab'), NULL)", check: r =>
            r.data[0].column1 === 2 && r.data[0].column2 === 'AB' && r.data[0].column3 === null },
        { name: "V6Stmt: VALUES With Scalar Subquery", fn: () => {
            const r = db.executeQuery("VALUES ((SELECT COUNT(*) FROM users))");
            const n = db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c;
            return !r.error && r.data[0].column1 === n;
        }},
        { name: "V6Stmt: VALUES Width Mismatch Rejected", sql: "VALUES (1), (1, 2)", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('same number of columns') },
        { name: "V6Stmt: VALUES Garbage Rejected", sql: "VALUES (1) garbage", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "V6Stmt: TABLE With Order Limit", fn: () => {
            db.executeQuery("CREATE TABLE v6tbl (id INTEGER)");
            db.executeQuery("INSERT INTO v6tbl (id) VALUES (1), (2), (3), (4)");
            const r = db.executeQuery("TABLE v6tbl ORDER BY id DESC LIMIT 2");
            db.executeQuery("DROP TABLE v6tbl");
            return !r.error && r.data.length === 2 && r.data[0].id === 4 && r.data[1].id === 3;
        }},
        { name: "V6Stmt: FROM DUAL Constant Select", sql: "SELECT 1 + 1 AS x FROM DUAL", check: r => r.data.length === 1 && r.data[0].x === 2 },
        { name: "V6Stmt: FROM DUAL With Where", sql: "SELECT 'y' AS v FROM dual WHERE 1 = 0", check: r => r.data.length === 0 },
        { name: "V6Stmt: Real Table Named dual Wins", fn: () => {
            db.executeQuery("CREATE TABLE dual (x INTEGER)");
            db.executeQuery("INSERT INTO dual (x) VALUES (7), (8)");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM dual");
            db.executeQuery("DROP TABLE dual");
            return !r.error && r.data[0].c === 2;
        }},
        { name: "V6Stmt: CTE Column List", sql: "WITH t(a, b) AS (SELECT 1 AS x, 2 AS y) SELECT a + b AS s FROM t", check: r => r.data[0].s === 3 },
        { name: "V6Stmt: CTE Column List Qualified Ref", sql: "WITH t(a) AS (SELECT 5 AS x) SELECT t.a FROM t", check: r => r.data[0].a === 5 },
        { name: "V6Stmt: Recursive CTE Column List", sql: "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT COUNT(*) AS c, MAX(n) AS m FROM seq", check: r =>
            r.data[0].c === 5 && r.data[0].m === 5 },
        { name: "V6Stmt: CTE Column List Width Mismatch", sql: "WITH t(a, b) AS (SELECT 1 AS x) SELECT * FROM t", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes('column list') },
        { name: "V6Stmt: CTE Without List Still Works", sql: "WITH t AS (SELECT 1 AS a) SELECT a FROM t", check: r => r.data[0].a === 1 },
        { name: "V6Stmt: CTAS Without AS Keyword", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS v6ctas");
            const c = db.executeQuery("CREATE TABLE v6ctas SELECT 1 AS a, 'x' AS b");
            const r = db.executeQuery("SELECT * FROM v6ctas");
            db.executeQuery("DROP TABLE v6ctas");
            return !c.error && r.data.length === 1 && r.data[0].a === 1 && r.data[0].b === 'x';
        }},

        // ============================================================
        // 9. 新しい SHOW / メンテナンスコマンド (V6Show)
        // ============================================================
        { name: "V6Show: SHOW FUNCTIONS Lists Many", fn: () => {
            const r = db.executeQuery("SHOW FUNCTIONS");
            return !r.error && r.data.length > 150 && r.data.every(x => x.Function && x.Category);
        }},
        { name: "V6Show: SHOW FUNCTIONS Sorted", fn: () => {
            const r = db.executeQuery("SHOW FUNCTIONS");
            const names = r.data.map(x => x.Function);
            return names.every((n, i) => i === 0 || names[i - 1] <= n);
        }},
        { name: "V6Show: SHOW FUNCTIONS LIKE Filter", fn: () => {
            const r = db.executeQuery("SHOW FUNCTIONS LIKE 'JSON%'");
            return !r.error && r.data.length >= 15 && r.data.every(x => x.Function.startsWith('JSON'))
                && r.data.some(x => x.Function === 'JSON_MERGE_PATCH');
        }},
        { name: "V6Show: SHOW FUNCTIONS Includes New Aggregates", fn: () => {
            const r = db.executeQuery("SHOW FUNCTIONS LIKE '%_BY'");
            const names = r.data.map(x => x.Function);
            return names.includes('MIN_BY') && names.includes('MAX_BY');
        }},
        { name: "V6Show: SHOW TRIGGERS FROM Filters", fn: () => {
            db.executeQuery("CREATE TABLE v6trg_a (id INTEGER)");
            db.executeQuery("CREATE TABLE v6trg_b (id INTEGER)");
            db.executeQuery("CREATE TRIGGER v6t1 AFTER INSERT ON v6trg_a FOR EACH ROW SELECT 1");
            db.executeQuery("CREATE TRIGGER v6t2 AFTER INSERT ON v6trg_b FOR EACH ROW SELECT 1");
            const all = db.executeQuery("SHOW TRIGGERS");
            const onlyA = db.executeQuery("SHOW TRIGGERS FROM v6trg_a");
            const bad = db.executeQuery("SHOW TRIGGERS FROM v6_no_such");
            db.executeQuery("DROP TRIGGER v6t1");
            db.executeQuery("DROP TRIGGER v6t2");
            db.executeQuery("DROP TABLE v6trg_a, v6trg_b");
            return all.data.length >= 2 && onlyA.data.length === 1 && onlyA.data[0].Trigger === 'v6t1' && bad.error !== undefined;
        }},
        { name: "V6Show: SHOW TABLES LIKE Has Temp Flag", fn: () => {
            db.executeQuery("CREATE TEMPORARY TABLE v6tmp_like (id INTEGER)");
            const r = db.executeQuery("SHOW TABLES LIKE 'v6tmp_like'");
            db.executeQuery("DROP TABLE v6tmp_like");
            return !r.error && r.data.length === 1 && r.data[0].Temp === true;
        }},
        { name: "V6Show: CHECK TABLE Clean Is OK", fn: () => {
            db.executeQuery("CREATE TABLE v6chk (id INTEGER PRIMARY KEY, age INTEGER NOT NULL, CHECK (age >= 0))");
            db.executeQuery("INSERT INTO v6chk (id, age) VALUES (1, 10), (2, 20)");
            const r = db.executeQuery("CHECK TABLE v6chk");
            return !r.error && r.data.length === 3 && r.data.every(x => x.Status === 'OK' && x.Problems === 0);
        }},
        { name: "V6Show: CHECK TABLE Detects Violations", fn: () => {
            // 制約を後付けで直接注入し、既存データが違反している状態を作る
            db.executeQuery("CREATE TABLE v6bad (id INTEGER, age INTEGER)");
            db.executeQuery("INSERT INTO v6bad (id, age) VALUES (1, 10), (1, 200), (2, NULL)");
            const t = db.tables['v6bad'];
            t.primaryKey = 'id';
            t.notNullCols = ['age'];
            t.checks = [{ name: 'age_max', expr: 'age < 100' }];
            const r = db.executeQuery("CHECK TABLE v6bad");
            db.executeQuery("DROP TABLE v6bad");
            if (r.error) return false;
            const pk = r.data.find(x => x.Constraint.includes('PRIMARY KEY'));
            const nn = r.data.find(x => x.Constraint.includes('NOT NULL'));
            const ck = r.data.find(x => x.Constraint.includes('CHECK'));
            return pk && pk.Status === 'FAIL' && pk.Problems === 1
                && nn && nn.Status === 'FAIL' && nn.Problems === 1
                && ck && ck.Status === 'FAIL' && ck.Problems >= 1;
        }},
        { name: "V6Show: CHECK TABLE Detects Orphan FK", fn: () => {
            db.executeQuery("CREATE TABLE v6par (id INTEGER PRIMARY KEY)");
            db.executeQuery("INSERT INTO v6par (id) VALUES (1)");
            db.executeQuery("CREATE TABLE v6cld (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v6par(id))");
            db.executeQuery("INSERT INTO v6cld (id, pid) VALUES (1, 1)");
            // 親行を直接消して孤児を作る（DELETE は RESTRICT で防がれるため直接操作）
            db.tables['v6par'].rowCount = 0;
            db.tables['v6par'].rebuildIndices();
            const r = db.executeQuery("CHECK TABLE v6cld");
            db.executeQuery("DROP TABLE v6cld");
            db.executeQuery("DROP TABLE v6par");
            const fk = r.data.find(x => x.Constraint.includes('FOREIGN KEY'));
            return fk && fk.Status === 'FAIL' && fk.Problems === 1;
        }},
        { name: "V6Show: CHECK TABLE No Constraints", fn: () => {
            db.executeQuery("CREATE TABLE v6plain (a TEXT)");
            const r = db.executeQuery("CHECK TABLE v6plain");
            db.executeQuery("DROP TABLE v6plain");
            return !r.error && r.data.length === 1 && r.data[0].Status === 'OK' && r.data[0].Constraint === '(no constraints)';
        }},
        { name: "V6Show: CHECK TABLE Missing Table Suggests", sql: "CHECK TABLE usres", isErrorExpected: true, check: r =>
            r.error !== undefined && r.error.includes("Did you mean 'users'") },
        { name: "V6Show: ANALYZE TABLE Stats", fn: () => {
            db.executeQuery("CREATE TABLE v6ana (id INTEGER, v TEXT)");
            db.executeQuery("INSERT INTO v6ana (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'a'), (4, NULL)");
            const r = db.executeQuery("ANALYZE TABLE v6ana");
            db.executeQuery("DROP TABLE v6ana");
            if (r.error || r.data.length !== 2) return false;
            const idRow = r.data.find(x => x.Column === 'id');
            const vRow = r.data.find(x => x.Column === 'v');
            return idRow.Rows === 4 && idRow.Nulls === 0 && idRow.Distinct === 4 && idRow.Min === 1 && idRow.Max === 4
                && vRow.Nulls === 1 && vRow.Distinct === 2 && vRow.Min === 'a' && vRow.Max === 'b';
        }},
        { name: "V6Show: ANALYZE Is Read Only Via API", fn: () => {
            db.executeQuery("BEGIN");
            const r = LuminaDB.query("ANALYZE TABLE users");
            db.executeQuery("ROLLBACK");
            return !r.error && r.data.length > 0;
        }},

        // ============================================================
        // 10. 外部 API 拡張 (V6Api)
        // ============================================================
        { name: "V6Api: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v6api (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
            db.executeQuery("INSERT INTO v6api (id, name, age) VALUES (1, 'Alice', 25), (2, 'Bob', 30), (3, 'Ann', 35), (4, 'Cara', NULL)");
            return true;
        }},
        { name: "V6Api: rows Returns Data", fn: () => {
            const rows = LuminaDB.rows('SELECT * FROM v6api WHERE age > ?', [26]);
            return Array.isArray(rows) && rows.length === 2;
        }},
        { name: "V6Api: rows Throws On Error", fn: () => {
            try { LuminaDB.rows('SELECT * FROM v6_no_such_table'); return false; }
            catch (e) { return e.message.includes('not found'); }
        }},
        { name: "V6Api: row And value", fn: () => {
            const one = LuminaDB.row('SELECT name FROM v6api WHERE id = ?', [2]);
            const none = LuminaDB.row('SELECT name FROM v6api WHERE id = 999');
            const v = LuminaDB.value('SELECT COUNT(*) FROM v6api');
            return one.name === 'Bob' && none === null && v === 4;
        }},
        { name: "V6Api: get By Primary Key Scalar", fn: () => {
            const r = LuminaDB.get('v6api', 3);
            return !r.error && r.rowData && r.rowData.name === 'Ann';
        }},
        { name: "V6Api: get By Where Object", fn: () => {
            const r = LuminaDB.get('v6api', { name: 'Bob' });
            const miss = LuminaDB.get('v6api', { name: 'Nobody' });
            return r.rowData.id === 2 && miss.rowData === null;
        }},
        { name: "V6Api: get Without PK Rejects Scalar", fn: () => {
            db.executeQuery("CREATE TABLE v6nopk (x INTEGER)");
            const r = LuminaDB.get('v6nopk', 1);
            db.executeQuery("DROP TABLE v6nopk");
            return r.error !== undefined && r.error.includes('no PRIMARY KEY');
        }},
        { name: "V6Api: pluck Column Values", fn: () => {
            const names = LuminaDB.pluck('v6api', 'name', { orderBy: 'id DESC', limit: 2 });
            return names.length === 2 && names[0] === 'Cara' && names[1] === 'Ann';
        }},
        { name: "V6Api: csv Escapes Properly", fn: () => {
            db.executeQuery("CREATE TABLE v6csv (id INTEGER, memo TEXT)");
            LuminaDB.insert('v6csv', { id: 1, memo: 'a,"b' });
            const csv = LuminaDB.csv('SELECT * FROM v6csv');
            db.executeQuery("DROP TABLE v6csv");
            return csv === 'id,memo\n1,"a,""b"';
        }},
        { name: "V6Api: csv Empty Result", fn: () => {
            return LuminaDB.csv('SELECT * FROM v6api WHERE id = 999') === '';
        }},
        { name: "V6Api: schema Describes Table", fn: () => {
            const s = LuminaDB.schema('v6api');
            const idCol = s.find(c => c.Column === 'id');
            return s.length === 3 && idCol.Key === 'PRIMARY';
        }},
        { name: "V6Api: where Array Becomes IN", fn: () => {
            const r = LuminaDB.select('v6api', { where: { id: [1, 3] } });
            return !r.error && r.data.length === 2;
        }},
        { name: "V6Api: where Empty Array Matches Nothing", fn: () => {
            const r = LuminaDB.select('v6api', { where: { id: [] } });
            return !r.error && r.data.length === 0;
        }},
        { name: "V6Api: where Operator Object", fn: () => {
            const r = LuminaDB.select('v6api', { where: { age: { gte: 25, lt: 35 } } });
            return !r.error && r.data.length === 2;
        }},
        { name: "V6Api: where like Operator", fn: () => {
            const r = LuminaDB.select('v6api', { where: { name: { like: 'A%' } } });
            return !r.error && r.data.length === 2;
        }},
        { name: "V6Api: where ne And in Operators", fn: () => {
            const r = LuminaDB.select('v6api', { where: { id: { in: [1, 2, 3] }, name: { ne: 'Bob' } } });
            return !r.error && r.data.length === 2;
        }},
        { name: "V6Api: where Unknown Operator Rejected", fn: () => {
            const r = LuminaDB.select('v6api', { where: { age: { foo: 1 } } });
            return r.error !== undefined && r.error.includes("Unknown operator");
        }},
        { name: "V6Api: count With Operator Where", fn: () => {
            const r = LuminaDB.count('v6api', { age: { gt: 20 } });
            return !r.error && r.count === 3;
        }},
        { name: "V6Api: update With Array Where", fn: () => {
            const r = LuminaDB.update('v6api', { age: 99 }, { id: [1, 2] });
            const back = LuminaDB.value('SELECT COUNT(*) FROM v6api WHERE age = 99');
            LuminaDB.update('v6api', { age: 25 }, { id: 1 });
            LuminaDB.update('v6api', { age: 30 }, { id: 2 });
            return !r.error && back === 2;
        }},
        { name: "V6Api: CTE Select Allowed During UI Transaction", fn: () => {
            db.executeQuery("BEGIN");
            const sel = LuminaDB.query("WITH w AS (SELECT COUNT(*) AS c FROM v6api) SELECT c FROM w");
            const ins = LuminaDB.query("INSERT INTO v6api (id, name, age) VALUES (99, 'X', 1)");
            const val = LuminaDB.query("VALUES (1, 2)");
            db.executeQuery("ROLLBACK");
            return !sel.error && sel.data[0].c === 4
                && ins.error !== undefined && ins.error.includes('Transaction in progress')
                && !val.error;
        }},
        { name: "V6Api: WITH Wrapped Write Still Blocked In Tx", fn: () => {
            db.executeQuery("BEGIN");
            const r = LuminaDB.query("WITH w AS (SELECT 1 AS a) DELETE FROM v6api WHERE id = 1");
            db.executeQuery("ROLLBACK");
            const still = LuminaDB.value('SELECT COUNT(*) FROM v6api WHERE id = 1');
            return r.error !== undefined && r.error.includes('Transaction in progress') && still === 1;
        }},
        { name: "V6Api: exec Inside Own Transaction", fn: () => {
            const r = LuminaDB.transaction(api => {
                const ex = api.exec("INSERT INTO v6api (id, name, age) VALUES (50, 'T1', 1); INSERT INTO v6api (id, name, age) VALUES (51, 'T2', 2);");
                if (ex.error || ex.failed > 0) throw new Error('exec failed: ' + (ex.error || ex.failed));
                return ex.succeeded;
            });
            const n = LuminaDB.value('SELECT COUNT(*) FROM v6api WHERE id IN (50, 51)');
            LuminaDB.remove('v6api', { id: [50, 51] });
            return !r.error && r.value === 2 && n === 2;
        }},
        { name: "V6Api: Bind Trailing Backslash Literal", fn: () => {
            // 文字列リテラル末尾の \\ （エスケープ済みバックスラッシュ）の直後で文字列が閉じること
            const r = LuminaDB.query("SELECT 'a\\\\' AS v, ? AS w", [7]);
            return !r.error && r.data[0].v === 'a\\' && r.data[0].w === 7;
        }},
        { name: "V6Api: version Is Semver", fn: () => {
            return /^\d+\.\d+\.\d+$/.test(String(LuminaDB.version)) && String(LuminaDB.version) === LUMINA_VERSION;
        }},
        { name: "V6Api: Cleanup", sql: "DROP TABLE v6api", check: r => r.data[0].Result === "Success" }
      ];
    }
