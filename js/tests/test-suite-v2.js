    // ============================================================================
    // [Test Suite v2] - v1.1 機能追加・修正の回帰テスト
    //   1. V2Fn  : 追加SQL関数（数値 / 文字列 / 日付）と ROUND 精度修正
    //   2. V2Js  : JSON 関数群 (JSON_EXTRACT / SET / REMOVE / CONTAINS ほか)
    //   3. V2Meta: UUID / VERSION / DATABASE / LAST_INSERT_ID
    //   4. V2Agg : 標本分散系 / ビット集計 / ANY_VALUE
    //   5. V2Win : PERCENT_RANK / CUME_DIST / NTH_VALUE、GROUP BY 併用エラー
    //   6. V2Ord : ORDER BY NULLS FIRST / LAST
    //   7. V2Ret : INSERT / UPDATE / DELETE ... RETURNING
    //   8. V2Dml : UPDATE / DELETE の ORDER BY + LIMIT、INSERT 残余検証
    //   9. V2Ddl : DROP 複数指定 / ADD COLUMN FIRST・AFTER / IF EXISTS 系 / SHOW STATUS
    //  10. V2Api : 名前付きバインド / exec / insert / executeScript
    //  11. V2Grd : 定数式 LHS / 文字列プール上限ガード
    //  12. V2Tx  : 新 DDL のトランザクションロールバック
    //   test-suite.js の tests 配列へ getV2Tests() のスプレッドで合流する
    // ============================================================================
    function getV2Tests() {
      return [
        // ============================================================
        // 1. 追加SQL関数: 数値 (V2Fn)
        // ============================================================
        { name: "V2Fn: ROUND With Precision", sql: "SELECT ROUND(3.14159, 2) AS r", check: r => r.data[0].r === 3.14 },
        { name: "V2Fn: ROUND Negative Half Away From Zero", sql: "SELECT ROUND(-2.5) AS a, ROUND(2.5) AS b", check: r => r.data[0].a === -3 && r.data[0].b === 3 },
        { name: "V2Fn: ROUND Negative Precision", sql: "SELECT ROUND(1234.5678, -2) AS r", check: r => r.data[0].r === 1200 },
        { name: "V2Fn: ROUND Single Arg Compat", sql: "SELECT ROUND(4.4) AS a, ROUND(4.6) AS b", check: r => r.data[0].a === 4 && r.data[0].b === 5 },
        { name: "V2Fn: POW Alias", sql: "SELECT POW(2, 10) AS p", check: r => r.data[0].p === 1024 },
        { name: "V2Fn: LOG2", sql: "SELECT LOG2(8) AS l", check: r => r.data[0].l === 3 },
        { name: "V2Fn: LOG2 Of Zero Is Null", sql: "SELECT LOG2(0) AS l", check: r => r.data[0].l === null },
        { name: "V2Fn: COT", sql: "SELECT ROUND(COT(1), 4) AS c", check: r => r.data[0].c === 0.6421 },
        { name: "V2Fn: FORMAT Thousands", sql: "SELECT FORMAT(1234567.891, 2) AS f", check: r => r.data[0].f === '1,234,567.89' },
        { name: "V2Fn: FORMAT Zero Digits Rounds", sql: "SELECT FORMAT(1234.567, 0) AS f", check: r => r.data[0].f === '1,235' },
        { name: "V2Fn: HEX Number", sql: "SELECT HEX(255) AS h", check: r => r.data[0].h === 'FF' },
        { name: "V2Fn: HEX String", sql: "SELECT HEX('AB') AS h", check: r => r.data[0].h === '4142' },
        { name: "V2Fn: BIN", sql: "SELECT BIN(5) AS b", check: r => r.data[0].b === '101' },
        { name: "V2Fn: OCT", sql: "SELECT OCT(8) AS o", check: r => r.data[0].o === '10' },
        { name: "V2Fn: CONV Hex To Dec", sql: "SELECT CONV('ff', 16, 10) AS c", check: r => r.data[0].c === '255' },
        { name: "V2Fn: CONV Dec To Hex", sql: "SELECT CONV(255, 10, 16) AS c", check: r => r.data[0].c === 'FF' },

        // ============================================================
        // 1. 追加SQL関数: 文字列 (V2Fn)
        // ============================================================
        { name: "V2Fn: SPACE", sql: "SELECT LENGTH(SPACE(3)) AS l", check: r => r.data[0].l === 3 },
        { name: "V2Fn: STRCMP", sql: "SELECT STRCMP('a', 'b') AS x, STRCMP('b', 'a') AS y, STRCMP('a', 'a') AS z", check: r => r.data[0].x === -1 && r.data[0].y === 1 && r.data[0].z === 0 },
        { name: "V2Fn: ELT", sql: "SELECT ELT(2, 'a', 'b', 'c') AS e", check: r => r.data[0].e === 'b' },
        { name: "V2Fn: ELT Out Of Range Is Null", sql: "SELECT ELT(9, 'a', 'b') AS e", check: r => r.data[0].e === null },
        { name: "V2Fn: FIELD", sql: "SELECT FIELD('b', 'a', 'b', 'c') AS f, FIELD('z', 'a', 'b') AS nf", check: r => r.data[0].f === 2 && r.data[0].nf === 0 },
        { name: "V2Fn: MID Alias Of Substring", sql: "SELECT MID('abcdef', 2, 3) AS m", check: r => r.data[0].m === 'bcd' },
        { name: "V2Fn: UCASE / LCASE", sql: "SELECT UCASE('mix') AS u, LCASE('MIX') AS l", check: r => r.data[0].u === 'MIX' && r.data[0].l === 'mix' },
        { name: "V2Fn: INITCAP", sql: "SELECT INITCAP('hello world') AS c", check: r => r.data[0].c === 'Hello World' },
        { name: "V2Fn: LOCATE With Start Position", sql: "SELECT LOCATE('l', 'hello', 4) AS p", check: r => r.data[0].p === 4 },
        { name: "V2Fn: POSITION In Syntax", sql: "SELECT POSITION('ll' IN 'hello') AS p", check: r => r.data[0].p === 3 },
        { name: "V2Fn: CHAR Multi Arg", sql: "SELECT CHAR(72, 73) AS c", check: r => r.data[0].c === 'HI' },

        // ============================================================
        // 1. 追加SQL関数: 日付 (V2Fn)
        // ============================================================
        { name: "V2Fn: MONTHNAME / DAYNAME", sql: "SELECT MONTHNAME('2026-07-16') AS m, DAYNAME('2026-07-16') AS d", check: r => r.data[0].m === 'July' && r.data[0].d === 'Thursday' },
        { name: "V2Fn: WEEKDAY Monday Based", sql: "SELECT WEEKDAY('2026-07-16') AS w", check: r => r.data[0].w === 3 },
        { name: "V2Fn: WEEK Mode0", sql: "SELECT WEEK('2026-07-16') AS w, WEEK('2026-01-03') AS w0", check: r => r.data[0].w === 28 && r.data[0].w0 === 0 },
        { name: "V2Fn: WEEKOFYEAR ISO", sql: "SELECT WEEKOFYEAR('2026-07-16') AS w, WEEKOFYEAR('2026-01-01') AS w1", check: r => r.data[0].w === 29 && r.data[0].w1 === 1 },
        { name: "V2Fn: UNIX_TIMESTAMP Of Date", sql: "SELECT UNIX_TIMESTAMP('1970-01-02') AS t", check: r => r.data[0].t === 86400 },
        { name: "V2Fn: UNIX_TIMESTAMP Now", sql: "SELECT UNIX_TIMESTAMP() AS t", check: r => typeof r.data[0].t === 'number' && r.data[0].t > 1500000000 },
        { name: "V2Fn: FROM_UNIXTIME", sql: "SELECT FROM_UNIXTIME(86400) AS d", check: r => r.data[0].d === '1970-01-02 00:00:00' },
        { name: "V2Fn: DATE_FORMAT Basic", sql: "SELECT DATE_FORMAT('2026-07-16 09:05:03', '%Y/%m/%d %H:%i:%s') AS f", check: r => r.data[0].f === '2026/07/16 09:05:03' },
        { name: "V2Fn: DATE_FORMAT Names", sql: "SELECT DATE_FORMAT('2026-07-16', '%W, %M %D') AS f", check: r => r.data[0].f === 'Thursday, July 16th' },
        { name: "V2Fn: DATE_FORMAT AmPm And Escape", sql: "SELECT DATE_FORMAT('2026-07-16 15:00:00', '%h %p 100%%') AS f", check: r => r.data[0].f === '03 PM 100%' },
        { name: "V2Fn: EXTRACT In Where", sql: "SELECT COUNT(*) AS c FROM users WHERE EXTRACT(YEAR FROM '2026-07-16') = 2026", check: r => r.data[0].c === 10 },
        { name: "V2Fn: EXTRACT In Select Clause", sql: "SELECT EXTRACT(MONTH FROM '2026-07-16') AS m, EXTRACT(HOUR FROM '2026-07-16 09:30:00') AS h", check: r => r.data[0].m === 7 && r.data[0].h === 9 },
        { name: "V2Fn: TIMESTAMPDIFF Days", sql: "SELECT TIMESTAMPDIFF(DAY, '2026-01-01', '2026-01-31') AS d", check: r => r.data[0].d === 30 },
        { name: "V2Fn: TIMESTAMPDIFF Month Clamps", sql: "SELECT TIMESTAMPDIFF(MONTH, '2024-01-31', '2024-02-29') AS m", check: r => r.data[0].m === 0 },
        { name: "V2Fn: TIMESTAMPDIFF Year Partial", sql: "SELECT TIMESTAMPDIFF(YEAR, '2020-06-15', '2023-06-14') AS y", check: r => r.data[0].y === 2 },
        { name: "V2Fn: DATE_ADD INTERVAL MONTH Clamps", sql: "SELECT DATE_ADD('2026-01-31', INTERVAL 1 MONTH) AS d", check: r => String(r.data[0].d).slice(0, 10) === '2026-02-28' },
        { name: "V2Fn: DATE_ADD INTERVAL YEAR Leap Clamps", sql: "SELECT DATE_ADD('2024-02-29', INTERVAL 1 YEAR) AS d", check: r => String(r.data[0].d).slice(0, 10) === '2025-02-28' },
        { name: "V2Fn: DATE_ADD INTERVAL WEEK", sql: "SELECT DATE_ADD('2026-07-16', INTERVAL 2 WEEK) AS d", check: r => String(r.data[0].d).slice(0, 10) === '2026-07-30' },
        { name: "V2Fn: DATE_SUB INTERVAL HOUR", sql: "SELECT DATE_SUB('2026-07-16 10:00:00', INTERVAL 3 HOUR) AS d", check: r => r.data[0].d === '2026-07-16 07:00:00' },
        { name: "V2Fn: DATE_ADD Numeric Days Compat", sql: "SELECT DATE_ADD('2026-07-16', 5) AS d", check: r => String(r.data[0].d).slice(0, 10) === '2026-07-21' },
        { name: "V2Fn: ADDDATE / SUBDATE Aliases", sql: "SELECT ADDDATE('2026-07-16', INTERVAL 1 DAY) AS a, SUBDATE('2026-07-16', INTERVAL 1 DAY) AS s", check: r => String(r.data[0].a).slice(0, 10) === '2026-07-17' && String(r.data[0].s).slice(0, 10) === '2026-07-15' },

        // ============================================================
        // 2. JSON 関数群 (V2Js)
        // ============================================================
        { name: "V2Js: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v2js (id INTEGER, j TEXT)");
            const r = db.executeQuery(`INSERT INTO v2js (id, j) VALUES (1, '{"a": 1, "b": {"c": [10, 20]}, "s": "txt"}'), (2, '[1, 2, 3]'), (3, 'broken{')`);
            return !r.error && r.data[0].Message.includes('3');
        }},
        { name: "V2Js: JSON_EXTRACT Scalar", sql: "SELECT JSON_EXTRACT(j, '$.a') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === 1 },
        { name: "V2Js: JSON_EXTRACT Nested Array", sql: "SELECT JSON_EXTRACT(j, '$.b.c[1]') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === 20 },
        { name: "V2Js: JSON_EXTRACT Object As String", sql: "SELECT JSON_EXTRACT(j, '$.b.c') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === '[10,20]' },
        { name: "V2Js: JSON_EXTRACT Missing Path Is Null", sql: "SELECT JSON_EXTRACT(j, '$.zzz') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === null },
        { name: "V2Js: JSON_EXTRACT Root Array Index", sql: "SELECT JSON_EXTRACT(j, '$[0]') AS v FROM v2js WHERE id = 2", check: r => r.data[0].v === 1 },
        { name: "V2Js: JSON_VALUE Alias", sql: "SELECT JSON_VALUE(j, '$.s') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === 'txt' },
        { name: "V2Js: JSON_LENGTH Object And Array", sql: "SELECT JSON_LENGTH(j) AS lo, JSON_LENGTH(j, '$.b.c') AS la FROM v2js WHERE id = 1", check: r => r.data[0].lo === 3 && r.data[0].la === 2 },
        { name: "V2Js: JSON_KEYS", sql: "SELECT JSON_KEYS(j) AS k FROM v2js WHERE id = 1", check: r => r.data[0].k === '["a","b","s"]' },
        { name: "V2Js: JSON_VALID", sql: "SELECT id, JSON_VALID(j) AS v FROM v2js ORDER BY id ASC", check: r => r.data[0].v === 1 && r.data[1].v === 1 && r.data[2].v === 0 },
        { name: "V2Js: JSON_TYPE", sql: "SELECT JSON_TYPE(j) AS t, JSON_TYPE(j, '$.a') AS ti, JSON_TYPE(j, '$.s') AS ts FROM v2js WHERE id = 1", check: r => r.data[0].t === 'OBJECT' && r.data[0].ti === 'INTEGER' && r.data[0].ts === 'STRING' },
        { name: "V2Js: JSON_CONTAINS Object", sql: `SELECT JSON_CONTAINS(j, '{"a": 1}') AS y, JSON_CONTAINS(j, '{"a": 9}') AS n FROM v2js WHERE id = 1`, check: r => r.data[0].y === 1 && r.data[0].n === 0 },
        { name: "V2Js: JSON_CONTAINS Array Element", sql: "SELECT JSON_CONTAINS(j, '2') AS y FROM v2js WHERE id = 2", check: r => r.data[0].y === 1 },
        { name: "V2Js: JSON_SET Overwrites", sql: "SELECT JSON_EXTRACT(JSON_SET(j, '$.a', 99), '$.a') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === 99 },
        { name: "V2Js: JSON_SET Creates Key", sql: "SELECT JSON_EXTRACT(JSON_SET(j, '$.newkey', 'nv'), '$.newkey') AS v FROM v2js WHERE id = 1", check: r => r.data[0].v === 'nv' },
        { name: "V2Js: JSON_REMOVE", sql: "SELECT JSON_KEYS(JSON_REMOVE(j, '$.a')) AS k FROM v2js WHERE id = 1", check: r => r.data[0].k === '["b","s"]' },
        { name: "V2Js: JSON_ARRAY Builder", sql: "SELECT JSON_ARRAY(1, 'a', TRUE) AS j", check: r => r.data[0].j === '[1,"a",true]' },
        { name: "V2Js: JSON_OBJECT Builder", sql: "SELECT JSON_OBJECT('k', 1, 'm', 'x') AS j", check: r => r.data[0].j === '{"k":1,"m":"x"}' },
        { name: "V2Js: JSON_OBJECT Odd Args Is Null", sql: "SELECT JSON_OBJECT('k') AS j", check: r => r.data[0].j === null },
        { name: "V2Js: JSON Filter In Where", sql: "SELECT COUNT(*) AS c FROM v2js WHERE JSON_VALID(j) = 1", check: r => r.data[0].c === 2 },
        { name: "V2Js: Cleanup", sql: "DROP TABLE v2js", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 3. メタ情報関数 (V2Meta)
        // ============================================================
        { name: "V2Meta: UUID Format And Uniqueness", fn: () => {
            const r = db.executeQuery("SELECT UUID() AS a, UUID() AS b");
            const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            return !r.error && re.test(r.data[0].a) && re.test(r.data[0].b) && r.data[0].a !== r.data[0].b;
        }},
        { name: "V2Meta: VERSION", sql: "SELECT VERSION() AS v", check: r => /^LuminaDB \d+\.\d+\.\d+$/.test(r.data[0].v) },
        { name: "V2Meta: DATABASE", sql: "SELECT DATABASE() AS d", check: r => r.data[0].d === 'lumina' },
        { name: "V2Meta: LAST_INSERT_ID Tracks AI", fn: () => {
            db.executeQuery("CREATE TABLE v2ai (id INTEGER PRIMARY KEY AUTO_INCREMENT, nm TEXT)");
            db.executeQuery("INSERT INTO v2ai (nm) VALUES ('a')");
            const r1 = db.executeQuery("SELECT LAST_INSERT_ID() AS lid");
            db.executeQuery("INSERT INTO v2ai (nm) VALUES ('b'), ('c')");
            const r2 = db.executeQuery("SELECT LAST_INSERT_ID() AS lid");
            db.executeQuery("DROP TABLE v2ai");
            return r1.data[0].lid === 1 && r2.data[0].lid === 3;
        }},

        // ============================================================
        // 4. 集計関数拡張 (V2Agg)
        // ============================================================
        { name: "V2Agg: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v2agg (g TEXT, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v2agg (g, v) VALUES ('A', 2), ('A', 4), ('A', 6), ('B', 5)");
            return !r.error && r.data[0].Message.includes('4');
        }},
        { name: "V2Agg: STDDEV_POP Equals STDDEV", sql: "SELECT STDDEV(v) AS s, STDDEV_POP(v) AS sp FROM v2agg WHERE g = 'A'", check: r => r.data[0].s === 1.633 && r.data[0].sp === 1.633 },
        { name: "V2Agg: STDDEV_SAMP N Minus 1", sql: "SELECT STDDEV_SAMP(v) AS s FROM v2agg WHERE g = 'A'", check: r => r.data[0].s === 2 },
        { name: "V2Agg: VAR_SAMP And VAR_POP", sql: "SELECT VAR_SAMP(v) AS vs, VAR_POP(v) AS vp FROM v2agg WHERE g = 'A'", check: r => r.data[0].vs === 4 && r.data[0].vp === 2.6667 },
        { name: "V2Agg: STDDEV_SAMP Single Row Is Null", sql: "SELECT STDDEV_SAMP(v) AS s, VARIANCE(v) AS vp FROM v2agg WHERE g = 'B'", check: r => r.data[0].s === null && r.data[0].vp === 0 },
        { name: "V2Agg: BIT Aggregates", fn: () => {
            db.executeQuery("CREATE TABLE v2bit (v INTEGER)");
            db.executeQuery("INSERT INTO v2bit (v) VALUES (6), (12)");
            const r = db.executeQuery("SELECT BIT_AND(v) AS a, BIT_OR(v) AS o, BIT_XOR(v) AS x FROM v2bit");
            db.executeQuery("DROP TABLE v2bit");
            return !r.error && r.data[0].a === 4 && r.data[0].o === 14 && r.data[0].x === 10;
        }},
        { name: "V2Agg: BIT_AND Empty Is Null", sql: "SELECT BIT_AND(v) AS a FROM v2agg WHERE v > 999", check: r => r.data[0].a === null },
        { name: "V2Agg: ANY_VALUE With Group By", sql: "SELECT g, ANY_VALUE(v) AS av, COUNT(*) AS c FROM v2agg GROUP BY g ORDER BY g ASC", check: r => r.data.length === 2 && r.data[0].av === 2 && r.data[1].av === 5 },
        { name: "V2Agg: New Aggregates In Having", sql: "SELECT g FROM v2agg GROUP BY g HAVING VAR_SAMP(v) > 1", check: r => r.data.length === 1 && r.data[0].g === 'A' },
        { name: "V2Agg: Cleanup", sql: "DROP TABLE v2agg", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 5. ウィンドウ関数拡張 (V2Win)
        // ============================================================
        { name: "V2Win: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v2win (id INTEGER, grp TEXT, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v2win (id, grp, v) VALUES (1, 'X', 10), (2, 'X', 20), (3, 'X', 20), (4, 'X', 40), (5, 'Y', 5)");
            return !r.error && r.data[0].Message.includes('5');
        }},
        { name: "V2Win: PERCENT_RANK", sql: "SELECT id, PERCENT_RANK() OVER(PARTITION BY grp ORDER BY v ASC) AS pr FROM v2win ORDER BY id ASC", check: r =>
            r.data[0].pr === 0 && Math.abs(r.data[1].pr - 1 / 3) < 1e-9 && Math.abs(r.data[2].pr - 1 / 3) < 1e-9 && r.data[3].pr === 1 && r.data[4].pr === 0 },
        { name: "V2Win: CUME_DIST", sql: "SELECT id, CUME_DIST() OVER(PARTITION BY grp ORDER BY v ASC) AS cd FROM v2win ORDER BY id ASC", check: r =>
            r.data[0].cd === 0.25 && r.data[1].cd === 0.75 && r.data[2].cd === 0.75 && r.data[3].cd === 1 && r.data[4].cd === 1 },
        { name: "V2Win: NTH_VALUE", sql: "SELECT id, NTH_VALUE(v, 2) OVER(PARTITION BY grp ORDER BY v ASC) AS nv FROM v2win ORDER BY id ASC", check: r =>
            r.data[0].nv === 20 && r.data[3].nv === 20 && r.data[4].nv === null },
        // v1.21: ウィンドウ関数は集計後の行に対して評価されるようになった（旧: 明示エラー）
        { name: "V2Win: Window Over Group By", sql: "SELECT grp, ROW_NUMBER() OVER(ORDER BY grp) AS rn FROM v2win GROUP BY grp ORDER BY rn",
          check: r => !r.error && r.data.length >= 1 && r.data[0].rn === 1 },
        { name: "V2Win: Window Over Bare Aggregate", sql: "SELECT COUNT(*) AS c, ROW_NUMBER() OVER() AS rn FROM v2win",
          check: r => !r.error && r.data.length === 1 && r.data[0].rn === 1 },
        // 集計後のウィンドウに明示フレームは付けられない（サブクエリを案内する）
        { name: "V2Win: Explicit Frame Over Group By Rejected", sql: "SELECT grp, SUM(SUM(id)) OVER (ROWS UNBOUNDED PRECEDING) AS s FROM v2win GROUP BY grp",
          isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Explicit window frames') },
        { name: "V2Win: Cleanup", sql: "DROP TABLE v2win", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 6. ORDER BY NULLS FIRST / LAST (V2Ord)
        // ============================================================
        { name: "V2Ord: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v2ord (id INTEGER, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v2ord (id, v) VALUES (1, 10), (2, NULL), (3, 5)");
            return !r.error;
        }},
        { name: "V2Ord: Default ASC Nulls First", sql: "SELECT id FROM v2ord ORDER BY v ASC", check: r => r.data[0].id === 2 && r.data[1].id === 3 && r.data[2].id === 1 },
        { name: "V2Ord: ASC NULLS LAST", sql: "SELECT id FROM v2ord ORDER BY v ASC NULLS LAST", check: r => r.data[0].id === 3 && r.data[1].id === 1 && r.data[2].id === 2 },
        { name: "V2Ord: DESC NULLS FIRST", sql: "SELECT id FROM v2ord ORDER BY v DESC NULLS FIRST", check: r => r.data[0].id === 2 && r.data[1].id === 1 && r.data[2].id === 3 },
        { name: "V2Ord: Default DESC Nulls Last", sql: "SELECT id FROM v2ord ORDER BY v DESC", check: r => r.data[0].id === 1 && r.data[1].id === 3 && r.data[2].id === 2 },
        { name: "V2Ord: Ordinal With NULLS LAST", sql: "SELECT id, v FROM v2ord ORDER BY 2 NULLS LAST", check: r => r.data[2].id === 2 },
        { name: "V2Ord: Union NULLS LAST", sql: "SELECT v FROM v2ord UNION ALL SELECT 99 AS v ORDER BY v NULLS LAST", check: r => r.data.length === 4 && r.data[3].v === null && r.data[0].v === 5 },
        { name: "V2Ord: Cleanup", sql: "DROP TABLE v2ord", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 7. RETURNING 句 (V2Ret)
        // ============================================================
        { name: "V2Ret: Setup", sql: "CREATE TABLE v2ret (id INTEGER PRIMARY KEY, name TEXT, v INTEGER)", check: r => r.data[0].Result === "Success" },
        { name: "V2Ret: INSERT RETURNING Star", sql: "INSERT INTO v2ret (id, name, v) VALUES (1, 'a', 10), (2, 'b', 20) RETURNING *", check: r =>
            r.data.length === 2 && r.data[0].id === 1 && r.data[1].name === 'b' && r.data[1].v === 20 },
        { name: "V2Ret: INSERT RETURNING Expression", sql: "INSERT INTO v2ret (id, name, v) VALUES (3, 'c', 30) RETURNING id AS key, UPPER(name) AS nm, v * 2 AS dbl", check: r =>
            r.data.length === 1 && r.data[0].key === 3 && r.data[0].nm === 'C' && r.data[0].dbl === 60 },
        { name: "V2Ret: INSERT SET RETURNING", sql: "INSERT INTO v2ret SET id = 4, name = 'd', v = 40 RETURNING id, v", check: r => r.data.length === 1 && r.data[0].id === 4 && r.data[0].v === 40 },
        { name: "V2Ret: INSERT SELECT RETURNING", fn: () => {
            db.executeQuery("CREATE TABLE v2ret2 (id INTEGER, name TEXT, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v2ret2 (id, name, v) SELECT id, name, v FROM v2ret WHERE id <= 2 RETURNING *");
            db.executeQuery("DROP TABLE v2ret2");
            return !r.error && r.data.length === 2 && r.data[0].id === 1 && r.data[1].id === 2;
        }},
        { name: "V2Ret: DEFAULT VALUES RETURNING AI", fn: () => {
            db.executeQuery("CREATE TABLE v2rai (id INTEGER PRIMARY KEY AUTO_INCREMENT, st TEXT DEFAULT 'new')");
            const r = db.executeQuery("INSERT INTO v2rai DEFAULT VALUES RETURNING id, st");
            db.executeQuery("DROP TABLE v2rai");
            return !r.error && r.data.length === 1 && r.data[0].id === 1 && r.data[0].st === 'new';
        }},
        { name: "V2Ret: UPDATE RETURNING Post Values", sql: "UPDATE v2ret SET v = v + 100 WHERE id <= 2 RETURNING id, v", check: r =>
            r.data.length === 2 && r.data[0].v === 110 && r.data[1].v === 120 },
        { name: "V2Ret: DELETE RETURNING Pre Values", sql: "DELETE FROM v2ret WHERE id = 4 RETURNING id, name, v", check: r =>
            r.data.length === 1 && r.data[0].id === 4 && r.data[0].name === 'd' && r.data[0].v === 40 },
        { name: "V2Ret: DELETE RETURNING Actually Deleted", sql: "SELECT COUNT(*) AS c FROM v2ret", check: r => r.data[0].c === 3 },
        { name: "V2Ret: REPLACE RETURNING Rejected", sql: "REPLACE INTO v2ret (id, name, v) VALUES (1, 'z', 0) RETURNING *", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('RETURNING is not supported') },
        // v1.22: IGNORE / ON CONFLICT の RETURNING は「実際に書き込んだ行だけ」を返すようになった
        // （PostgreSQL と同じ。REPLACE は削除で索引がずれるため引き続き非対応）
        { name: "V2Ret: IGNORE RETURNING Skips Conflicts", sql: "INSERT IGNORE INTO v2ret (id, name, v) VALUES (1, 'z', 0) RETURNING *", check: r =>
            !r.error && r.data.length === 0 },
        { name: "V2Ret: IGNORE RETURNING Returns Inserted", sql: "INSERT IGNORE INTO v2ret (id, name, v) VALUES (91, 'ign', 7) RETURNING id, v", check: r =>
            !r.error && r.data.length === 1 && r.data[0].id === 91 && r.data[0].v === 7 },
        { name: "V2Ret: ODKU RETURNING Updated Row", sql: "INSERT INTO v2ret (id, name, v) VALUES (1, 'z', 0) ON DUPLICATE KEY UPDATE v = 1 RETURNING id, v", check: r =>
            !r.error && r.data.length === 1 && r.data[0].id === 1 && r.data[0].v === 1 },
        { name: "V2Ret: Upsert RETURNING Cleanup", fn: () => {
            db.executeQuery("DELETE FROM v2ret WHERE id = 91");
            db.executeQuery("UPDATE v2ret SET v = 110 WHERE id = 1");
            return db.executeQuery("SELECT v FROM v2ret WHERE id = 1").data[0].v === 110;
        }},
        { name: "V2Ret: Returning Named Column Assignment Unaffected", fn: () => {
            db.executeQuery("CREATE TABLE v2retc (id INTEGER, returning INTEGER)");
            db.executeQuery("INSERT INTO v2retc (id, returning) VALUES (1, 0)");
            const r = db.executeQuery("UPDATE v2retc SET returning = 5 WHERE id = 1");
            const v = db.executeQuery("SELECT returning FROM v2retc WHERE id = 1");
            db.executeQuery("DROP TABLE v2retc");
            return !r.error && v.data[0].returning === 5;
        }},
        { name: "V2Ret: Cleanup", sql: "DROP TABLE v2ret", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 8. DML の ORDER BY + LIMIT / INSERT 残余検証 (V2Dml)
        // ============================================================
        { name: "V2Dml: Setup", fn: () => {
            db.executeQuery("CREATE TABLE v2dml (id INTEGER, v INTEGER)");
            const r = db.executeQuery("INSERT INTO v2dml (id, v) VALUES (1, 50), (2, 40), (3, 30), (4, 20), (5, 10)");
            return !r.error && r.data[0].Message.includes('5');
        }},
        { name: "V2Dml: UPDATE ORDER BY ASC LIMIT", sql: "UPDATE v2dml SET v = 0 ORDER BY v ASC LIMIT 2", check: r => r.data[0].Message.includes('2 rows') },
        { name: "V2Dml: UPDATE Targeted Smallest Values", sql: "SELECT id FROM v2dml WHERE v = 0 ORDER BY id ASC", check: r => r.data.length === 2 && r.data[0].id === 4 && r.data[1].id === 5 },
        { name: "V2Dml: DELETE ORDER BY DESC LIMIT", sql: "DELETE FROM v2dml ORDER BY id DESC LIMIT 2", check: r => r.data[0].Message.includes('2 rows') },
        { name: "V2Dml: DELETE Removed Largest Ids", sql: "SELECT MAX(id) AS m, COUNT(*) AS c FROM v2dml", check: r => r.data[0].m === 3 && r.data[0].c === 3 },
        { name: "V2Dml: UPDATE ORDER BY Expression LIMIT RETURNING", sql: "UPDATE v2dml SET v = -1 ORDER BY v DESC LIMIT 1 RETURNING id, v", check: r => r.data.length === 1 && r.data[0].id === 1 && r.data[0].v === -1 },
        { name: "V2Dml: INSERT VALUES Residual Garbage Rejected", sql: "INSERT INTO v2dml (id, v) VALUES (10, 1) junk (11, 2)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Syntax Error in INSERT VALUES') },
        { name: "V2Dml: INSERT Garbage Inserted Nothing", sql: "SELECT COUNT(*) AS c FROM v2dml WHERE id >= 10", check: r => r.data[0].c === 0 },
        { name: "V2Dml: Cleanup", sql: "DROP TABLE v2dml", check: r => r.data[0].Result === "Success" },

        // ============================================================
        // 9. DDL 拡張 (V2Ddl)
        // ============================================================
        { name: "V2Ddl: DROP TABLE Multi", fn: () => {
            db.executeQuery("CREATE TABLE v2d_a (id INTEGER)");
            db.executeQuery("CREATE TABLE v2d_b (id INTEGER)");
            db.executeQuery("CREATE TABLE v2d_c (id INTEGER)");
            const r = db.executeQuery("DROP TABLE v2d_a, v2d_b");
            return !r.error && r.data[0].Message.includes('2 tables dropped') && !db.tables['v2d_a'] && !db.tables['v2d_b'] && !!db.tables['v2d_c'];
        }},
        { name: "V2Ddl: DROP TABLE Multi Atomic On Missing", fn: () => {
            const r = db.executeQuery("DROP TABLE v2d_c, v2d_nope");
            return r.error !== undefined && r.error.includes('not found') && !!db.tables['v2d_c'];
        }},
        { name: "V2Ddl: DROP TABLE IF EXISTS Multi Partial", fn: () => {
            const r = db.executeQuery("DROP TABLE IF EXISTS v2d_c, v2d_nope");
            return !r.error && r.data[0].Message.includes('1 tables dropped') && r.data[0].Message.includes('skipped') && !db.tables['v2d_c'];
        }},
        { name: "V2Ddl: DROP VIEW Multi", fn: () => {
            db.executeQuery("CREATE VIEW v2v_a AS SELECT id FROM users");
            db.executeQuery("CREATE VIEW v2v_b AS SELECT name FROM users");
            const r = db.executeQuery("DROP VIEW v2v_a, v2v_b");
            return !r.error && r.data[0].Message.includes('2 views dropped') && !db.views['v2v_a'] && !db.views['v2v_b'];
        }},
        { name: "V2Ddl: ADD COLUMN AFTER", fn: () => {
            db.executeQuery("CREATE TABLE v2col (a INTEGER, b INTEGER)");
            db.executeQuery("INSERT INTO v2col (a, b) VALUES (1, 2)");
            const r = db.executeQuery("ALTER TABLE v2col ADD COLUMN c INTEGER DEFAULT 9 AFTER a");
            const order = db.tables['v2col'].getColumnNames().join(',');
            const v = db.executeQuery("SELECT c FROM v2col");
            return !r.error && order === 'a,c,b' && v.data[0].c === 9;
        }},
        { name: "V2Ddl: ADD COLUMN FIRST", fn: () => {
            const r = db.executeQuery("ALTER TABLE v2col ADD COLUMN z INTEGER FIRST");
            return !r.error && db.tables['v2col'].getColumnNames().join(',') === 'z,a,c,b';
        }},
        { name: "V2Ddl: ADD COLUMN AFTER Missing Rejected", fn: () => {
            const before = db.tables['v2col'].getColumnNames().length;
            const r = db.executeQuery("ALTER TABLE v2col ADD COLUMN w INTEGER AFTER no_such");
            return r.error !== undefined && r.error.includes('not found') && db.tables['v2col'].getColumnNames().length === before;
        }},
        { name: "V2Ddl: ADD COLUMN Cleanup", sql: "DROP TABLE v2col", check: r => r.data[0].Result === "Success" },
        { name: "V2Ddl: CREATE INDEX IF NOT EXISTS", fn: () => {
            db.executeQuery("CREATE TABLE v2idx (id INTEGER)");
            const r1 = db.executeQuery("CREATE INDEX IF NOT EXISTS ix_1 ON v2idx (id)");
            const r2 = db.executeQuery("CREATE INDEX IF NOT EXISTS ix_1 ON v2idx (id)");
            return !r1.error && r1.data[0].Message.includes('created') && !r2.error && r2.data[0].Message.includes('Skipped');
        }},
        { name: "V2Ddl: DROP INDEX IF EXISTS", fn: () => {
            const r1 = db.executeQuery("DROP INDEX IF EXISTS ON v2idx (id)");
            const r2 = db.executeQuery("DROP INDEX IF EXISTS ON v2idx (id)");
            db.executeQuery("DROP TABLE v2idx");
            return !r1.error && r1.data[0].Message.includes('dropped') && !r2.error && r2.data[0].Message.includes('Skipped');
        }},
        { name: "V2Ddl: SHOW CREATE PROCEDURE", fn: () => {
            db.executeQuery("CREATE PROCEDURE v2proc AS SELECT 1 AS a; SELECT 2 AS b");
            const r = db.executeQuery("SHOW CREATE PROCEDURE v2proc");
            db.executeQuery("DROP PROCEDURE v2proc");
            return !r.error && r.data[0].Procedure === 'v2proc' && r.data[0].CreateProcedure.includes('CREATE PROCEDURE v2proc AS BEGIN');
        }},
        { name: "V2Ddl: SHOW STATUS Items", fn: () => {
            const r = db.executeQuery("SHOW STATUS");
            if (r.error) return false;
            const get = (k) => { const row = r.data.find(d => d.Item === k); return row ? row.Value : undefined; };
            return String(get('version')).startsWith('LuminaDB') && get('tables') >= 3 && get('total_rows') >= 20
                && typeof get('est_memory_kb') === 'number' && get('in_transaction') === false;
        }},

        // ============================================================
        // 10. 外部 API / スクリプト実行 (V2Api)
        // ============================================================
        { name: "V2Api: Named Params Colon And At", fn: () => {
            const r = LuminaDB.query("SELECT COUNT(*) AS c FROM users WHERE age > :min AND age < @max", { min: 24, max: 31 });
            return !r.error && r.data[0].c === 5;
        }},
        { name: "V2Api: Named Param Missing Key Rejected", fn: () => {
            const r = LuminaDB.query("SELECT * FROM users WHERE age > :missing", {});
            return r.error !== undefined && r.error.includes("no value for named parameter ':missing'");
        }},
        { name: "V2Api: Named Token Inside String Literal Untouched", fn: () => {
            const r = LuminaDB.query("SELECT ':nope' AS s", { nope: 'X' });
            return !r.error && r.data[0].s === ':nope';
        }},
        { name: "V2Api: Named Param String Escaped", fn: () => {
            const r = LuminaDB.query("SELECT :val AS v", { val: "O'Reilly" });
            return !r.error && r.data[0].v === "O'Reilly";
        }},
        { name: "V2Api: Positional Params Still Work", fn: () => {
            const r = LuminaDB.query("SELECT ? AS a, ? AS b", [1, 'two']);
            return !r.error && r.data[0].a === 1 && r.data[0].b === 'two';
        }},
        { name: "V2Api: insert Single Object", fn: () => {
            db.executeQuery("CREATE TABLE v2api (id INTEGER PRIMARY KEY, nm TEXT)");
            const r = LuminaDB.insert('v2api', { id: 1, nm: "O'Reilly" });
            const v = db.executeQuery("SELECT nm FROM v2api WHERE id = 1");
            return !r.error && v.data[0].nm === "O'Reilly";
        }},
        { name: "V2Api: insert Array Of Objects", fn: () => {
            const r = LuminaDB.insert('v2api', [{ id: 2, nm: 'b' }, { id: 3, nm: 'c' }]);
            const v = db.executeQuery("SELECT COUNT(*) AS c FROM v2api");
            return !r.error && v.data[0].c === 3;
        }},
        { name: "V2Api: insert Missing Key Becomes Null", fn: () => {
            const r = LuminaDB.insert('v2api', [{ id: 4, nm: 'd' }, { id: 5 }]);
            const v = db.executeQuery("SELECT nm FROM v2api WHERE id = 5");
            return !r.error && v.data[0].nm === null;
        }},
        { name: "V2Api: insert Invalid Table Name Rejected", fn: () => {
            const r = LuminaDB.insert('v2api; DROP TABLE users', { id: 9 });
            return r.error !== undefined && r.error.includes('Invalid table name');
        }},
        { name: "V2Api: insert PK Violation Reported", fn: () => {
            const r = LuminaDB.insert('v2api', { id: 1, nm: 'dup' });
            db.executeQuery("DROP TABLE v2api");
            return r.error !== undefined && r.error.includes('PRIMARY KEY');
        }},
        { name: "V2Api: exec Runs Script And Continues On Error", fn: () => {
            const r = LuminaDB.exec("CREATE TABLE v2scr (id INTEGER); INSERT INTO v2scr (id) VALUES (1); SELECT * FROM no_such_table; INSERT INTO v2scr (id) VALUES (2);");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v2scr");
            db.executeQuery("DROP TABLE v2scr");
            return !r.error && r.total === 4 && r.succeeded === 3 && r.failed === 1 && c.data[0].c === 2;
        }},
        { name: "V2Api: exec Rejected During Transaction", fn: () => {
            db.executeQuery("BEGIN");
            const r = LuminaDB.exec("SELECT 1 AS x");
            db.executeQuery("ROLLBACK");
            return r.error !== undefined && r.error.includes('Transaction in progress');
        }},
        { name: "V2Api: executeScript Protects Semicolons In Strings And Comments", fn: () => {
            const eng = new DatabaseEngine();
            eng.executeQuery("CREATE TABLE s_t (id INTEGER, s TEXT)");
            const r = eng.executeScript("INSERT INTO s_t (id, s) VALUES (1, 'a;b'); -- comment; not a statement\nSELECT s FROM s_t WHERE id = 1;");
            return r.total === 2 && r.succeeded === 2 && r.results[1].data[0].s === 'a;b';
        }},
        { name: "V2Api: executeScript Result Shape", fn: () => {
            const eng = new DatabaseEngine();
            const r = eng.executeScript("SELECT 1 AS x; SELECT 2 AS y");
            return r.results.length === 2 && r.results[0].sql === 'SELECT 1 AS x' && r.results[0].data[0].x === 1 && r.results[1].data[0].y === 2;
        }},

        // ============================================================
        // 11. 定数式 LHS / ガード (V2Grd)
        // ============================================================
        { name: "V2Grd: Numeric Literal BETWEEN", sql: "SELECT 1 AS x WHERE 5 BETWEEN 1 AND 10", check: r => r.data.length === 1 },
        { name: "V2Grd: Numeric Literal NOT BETWEEN", sql: "SELECT 1 AS x WHERE 15 NOT BETWEEN 1 AND 10", check: r => r.data.length === 1 },
        { name: "V2Grd: String Literal LIKE", sql: "SELECT 1 AS x WHERE 'abc' LIKE 'a%'", check: r => r.data.length === 1 },
        { name: "V2Grd: String Literal LIKE No Match", sql: "SELECT COUNT(*) AS c FROM users WHERE 'x' LIKE 'y%'", check: r => r.data[0].c === 0 },
        { name: "V2Grd: String Literal IN List", sql: "SELECT 1 AS x WHERE 'b' IN ('a', 'b')", check: r => r.data.length === 1 },
        { name: "V2Grd: String Pool Overflow Guarded", fn: () => {
            db.executeQuery("CREATE TABLE v2ovf (v TEXT)");
            db.executeQuery("INSERT INTO v2ovf (v) VALUES ('a')");
            const t = db.tables['v2ovf'];
            // 実際に1600万件を積む代わりにプール長を上限超過状態へ偽装する
            t.strPools['v'].length = 0xFFFFFF + 1;
            let threw = false;
            try { t.setValue('v', 1, 'brand_new_string'); } catch (e) { threw = /overflow/i.test(e.message); }
            db.executeQuery("DROP TABLE v2ovf");
            return threw;
        }},

        // ============================================================
        // 12. トランザクションとの整合 (V2Tx)
        // ============================================================
        { name: "V2Tx: Multi DROP TABLE Rollback Restores All", fn: () => {
            db.executeQuery("CREATE TABLE v2tx_a (id INTEGER)");
            db.executeQuery("CREATE TABLE v2tx_b (id INTEGER)");
            db.executeQuery("INSERT INTO v2tx_a (id) VALUES (1)");
            db.executeQuery("BEGIN");
            db.executeQuery("DROP TABLE v2tx_a, v2tx_b");
            const gone = !db.tables['v2tx_a'] && !db.tables['v2tx_b'];
            db.executeQuery("ROLLBACK");
            const restored = !!db.tables['v2tx_a'] && !!db.tables['v2tx_b'] && db.tables['v2tx_a'].rowCount === 1;
            db.executeQuery("DROP TABLE v2tx_a, v2tx_b");
            return gone && restored;
        }},
        { name: "V2Tx: ADD COLUMN AFTER Rollback Restores Order", fn: () => {
            db.executeQuery("CREATE TABLE v2tx_c (a INTEGER, b INTEGER)");
            db.executeQuery("BEGIN");
            db.executeQuery("ALTER TABLE v2tx_c ADD COLUMN c INTEGER AFTER a");
            const during = db.tables['v2tx_c'].getColumnNames().join(',') === 'a,c,b';
            db.executeQuery("ROLLBACK");
            const after = db.tables['v2tx_c'].getColumnNames().join(',') === 'a,b';
            db.executeQuery("DROP TABLE v2tx_c");
            return during && after;
        }},
        { name: "V2Tx: UPDATE RETURNING Rollback Restores Values", fn: () => {
            db.executeQuery("CREATE TABLE v2tx_d (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO v2tx_d (id, v) VALUES (1, 100)");
            db.executeQuery("BEGIN");
            const r = db.executeQuery("UPDATE v2tx_d SET v = 999 WHERE id = 1 RETURNING v");
            db.executeQuery("ROLLBACK");
            const v = db.executeQuery("SELECT v FROM v2tx_d WHERE id = 1");
            db.executeQuery("DROP TABLE v2tx_d");
            return !r.error && r.data[0].v === 999 && v.data[0].v === 100;
        }},
        { name: "V2Tx: DELETE RETURNING Rollback Restores Rows", fn: () => {
            db.executeQuery("CREATE TABLE v2tx_e (id INTEGER)");
            db.executeQuery("INSERT INTO v2tx_e (id) VALUES (1), (2)");
            db.executeQuery("BEGIN");
            const r = db.executeQuery("DELETE FROM v2tx_e WHERE id = 2 RETURNING id");
            db.executeQuery("ROLLBACK");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM v2tx_e");
            db.executeQuery("DROP TABLE v2tx_e");
            return !r.error && r.data[0].id === 2 && c.data[0].c === 2;
        }}
      ];
    }
