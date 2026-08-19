    // ============================================================================
    // [Test Suite v12] - v1.11 機能追加の回帰テスト
    //   1. 商用DBスカラー関数（TO_CHAR / TO_HEX / TRY_CAST / DATEADD 系 / NANVL 他）
    //   2. SQL Server TOP (n / PERCENT)
    //   3. MERGE INTO ... USING ... ON ... WHEN MATCHED / NOT MATCHED（UPSERT）
    //   4. PostgreSQL INSERT ... ON CONFLICT DO NOTHING / DO UPDATE SET (EXCLUDED)
    //   test-suite.js の tests 配列へ getV12Tests() のスプレッドで合流する
    // ============================================================================
    function getV12Tests() {
      return [
        // ---- 変換・整形 (V12Conv) ----
        { name: "V12Conv: To Char Number Group", sql: "SELECT TO_CHAR(1234.5, '9,999.99') AS a", check: r => r.data[0].a === '1,234.50' },
        { name: "V12Conv: To Char Zero Pad", sql: "SELECT TO_CHAR(5, '000') AS a", check: r => r.data[0].a === '005' },
        { name: "V12Conv: To Char Plain", sql: "SELECT TO_CHAR(1234.5) AS a", check: r => r.data[0].a === '1234.5' },
        { name: "V12Conv: To Char Negative", sql: "SELECT TO_CHAR(-12, '9999') AS a", check: r => r.data[0].a === '-12' },
        { name: "V12Conv: To Char Dollar", sql: "SELECT TO_CHAR(1000, '$9,999') AS a", check: r => r.data[0].a === '$1,000' },
        { name: "V12Conv: To Char Date YMD", sql: "SELECT TO_CHAR(DATE('2026-07-23'), 'YYYY-MM-DD') AS a", check: r => r.data[0].a === '2026-07-23' },
        { name: "V12Conv: To Char Date Mon", sql: "SELECT TO_CHAR(DATE('2026-07-23'), 'DD MON YYYY') AS a", check: r => r.data[0].a === '23 JUL 2026' },
        { name: "V12Conv: To Char Date Month", sql: "SELECT TO_CHAR(DATE('2026-07-23'), 'Month') AS a", check: r => r.data[0].a === 'JULY' },
        { name: "V12Conv: To Char Column", sql: "SELECT TO_CHAR(price, '9,999') AS a FROM products WHERE id = 101", check: r => r.data[0].a === '1,500' },
        { name: "V12Conv: To Hex", sql: "SELECT TO_HEX(255) AS a, TO_HEX(16) AS b", check: r => r.data[0].a === 'ff' && r.data[0].b === '10' },
        { name: "V12Conv: Try Cast Valid", sql: "SELECT TRY_CAST('42' AS INTEGER) AS a", check: r => r.data[0].a === 42 },
        { name: "V12Conv: Try Cast Invalid Null", sql: "SELECT TRY_CAST('abc' AS INTEGER) AS a", check: r => r.data[0].a === null },
        { name: "V12Conv: Try Cast Float", sql: "SELECT TRY_CAST('3.14' AS FLOAT) AS a", check: r => Math.abs(r.data[0].a - 3.14) < 1e-9 },
        { name: "V12Conv: Try Convert Valid", sql: "SELECT TRY_CONVERT(INTEGER, '7') AS a", check: r => r.data[0].a === 7 },
        { name: "V12Conv: Try Convert Invalid", sql: "SELECT TRY_CONVERT(INTEGER, 'xx') AS a", check: r => r.data[0].a === null },

        // ---- 文字列 (V12Str) ----
        { name: "V12Str: Overlay 4-arg", sql: "SELECT OVERLAY('abcdef', 'XY', 2, 3) AS a", check: r => r.data[0].a === 'aXYef' },
        { name: "V12Str: Overlay 3-arg", sql: "SELECT OVERLAY('abcdef', 'XY', 2) AS a", check: r => r.data[0].a === 'aXYdef' },
        { name: "V12Str: Overlay Placing", sql: "SELECT OVERLAY('abcdef' PLACING 'XY' FROM 2 FOR 3) AS a", check: r => r.data[0].a === 'aXYef' },
        { name: "V12Str: Parsename P1", sql: "SELECT PARSENAME('a.b.c.d', 1) AS a", check: r => r.data[0].a === 'd' },
        { name: "V12Str: Parsename P3", sql: "SELECT PARSENAME('server.db.schema.tbl', 2) AS a", check: r => r.data[0].a === 'schema' },
        { name: "V12Str: Parsename OOR", sql: "SELECT PARSENAME('a.b', 4) AS a", check: r => r.data[0].a === null },
        { name: "V12Str: Quote Ident", sql: "SELECT QUOTE_IDENT('col') AS a", check: r => r.data[0].a === '\"col\"' },
        { name: "V12Str: Quote Literal", sql: "SELECT QUOTE_LITERAL('O''Brien') AS a", check: r => r.data[0].a === "'O''Brien'" },

        // ---- 数値・ビット (V12Num) ----
        { name: "V12Num: Nanvl Number", sql: "SELECT NANVL(5, 0) AS a", check: r => r.data[0].a === 5 },
        // v1.25 で 0 除算が NULL になったため NaN の出どころを CAST に変えた
        // （NANVL は NaN と NULL の両方を第2引数へ倒す Oracle 互換関数）
        // v1.30: 定義域の外の数値関数は NaN ではなく NULL を返すようになった。
        // Oracle の NANVL も NULL は NaN ではないのでそのまま NULL を返す
        { name: "V12Num: Nanvl Passes NULL Through", sql: "SELECT NANVL(SQRT(-1), -1) AS a", check: r => r.data[0].a === null },
        { name: "V12Num: Nanvl Passes A Number Through", sql: "SELECT NANVL(4, -1) AS a", check: r => r.data[0].a === 4 },
        { name: "V12Num: Nanvl Null Passes Through", sql: "SELECT NANVL(0/0, -1) AS a", check: r => r.data[0].a === null },
        { name: "V12Num: Remainder 11/4", sql: "SELECT REMAINDER(11, 4) AS a", check: r => r.data[0].a === -1 },
        { name: "V12Num: Remainder 10/3", sql: "SELECT REMAINDER(10, 3) AS a", check: r => r.data[0].a === 1 },
        { name: "V12Num: ShiftLeft", sql: "SELECT SHIFTLEFT(1, 4) AS a", check: r => r.data[0].a === 16 },
        { name: "V12Num: ShiftRight", sql: "SELECT SHIFTRIGHT(256, 2) AS a", check: r => r.data[0].a === 64 },
        { name: "V12Num: Log Base 2", sql: "SELECT LOG(2, 8) AS a", check: r => r.data[0].a === 3 },
        { name: "V12Num: Log Base 10", sql: "SELECT LOG(10, 1000) AS a", check: r => Math.abs(r.data[0].a - 3) < 1e-9 },
        { name: "V12Num: Log Natural", sql: "SELECT ROUND(LOG(2.718281828), 4) AS a", check: r => Math.abs(r.data[0].a - 1) < 1e-3 },

        // ---- 日付 (V12Date) ----
        { name: "V12Date: DateAdd Day", sql: "SELECT DATEADD(DAY, 5, DATE('2026-01-01')) AS a", check: r => r.data[0].a === '2026-01-06 00:00:00' },
        { name: "V12Date: DateAdd Month EOM", sql: "SELECT DATEADD(MONTH, 1, DATE('2026-01-31')) AS a", check: r => r.data[0].a === '2026-02-28 00:00:00' },
        { name: "V12Date: DateAdd Year", sql: "SELECT DATEADD(YEAR, 2, DATE('2026-07-23')) AS a", check: r => r.data[0].a.startsWith('2028-07-23') },
        { name: "V12Date: DateAdd Abbrev", sql: "SELECT DATEADD(dd, 1, DATE('2026-07-23')) AS a", check: r => r.data[0].a === '2026-07-24 00:00:00' },
        { name: "V12Date: DatePart Year", sql: "SELECT DATEPART(YEAR, DATE('2026-07-23')) AS a", check: r => r.data[0].a === 2026 },
        { name: "V12Date: DatePart Month", sql: "SELECT DATEPART(MONTH, DATE('2026-07-23')) AS a", check: r => r.data[0].a === 7 },
        { name: "V12Date: DatePart Quarter", sql: "SELECT DATEPART(QUARTER, DATE('2026-07-23')) AS a", check: r => r.data[0].a === 3 },
        { name: "V12Date: DateName Month", sql: "SELECT DATENAME(MONTH, DATE('2026-07-23')) AS a", check: r => r.data[0].a === 'July' },
        { name: "V12Date: DateName Weekday", sql: "SELECT DATENAME(WEEKDAY, DATE('2026-07-23')) AS a", check: r => r.data[0].a === 'Thursday' },
        { name: "V12Date: DateDiff 3-arg Day", sql: "SELECT DATEDIFF(DAY, DATE('2026-01-01'), DATE('2026-01-10')) AS a", check: r => r.data[0].a === 9 },
        { name: "V12Date: DateDiff 3-arg Month", sql: "SELECT DATEDIFF(MONTH, DATE('2026-01-15'), DATE('2026-04-15')) AS a", check: r => r.data[0].a === 3 },
        { name: "V12Date: DateDiff 2-arg", sql: "SELECT DATEDIFF(DATE('2026-01-10'), DATE('2026-01-01')) AS a", check: r => r.data[0].a === 9 },
        { name: "V12Date: Next Day", sql: "SELECT NEXT_DAY(DATE('2026-07-23'), 'Monday') AS a", check: r => r.data[0].a === '2026-07-27' },
        { name: "V12Date: Next Day Sunday", sql: "SELECT NEXT_DAY(DATE('2026-07-23'), 'SUN') AS a", check: r => r.data[0].a === '2026-07-26' },

        // ---- メタ / セッション (V12Meta) ----
        { name: "V12Meta: Current User", sql: "SELECT CURRENT_USER AS a", check: r => r.data[0].a === 'lumina' },
        { name: "V12Meta: Session User", sql: "SELECT SESSION_USER AS a", check: r => r.data[0].a === 'lumina' },
        { name: "V12Meta: System User", sql: "SELECT SYSTEM_USER AS a", check: r => r.data[0].a === 'lumina' },
        { name: "V12Meta: User Func", sql: "SELECT USER() AS a", check: r => r.data[0].a === 'lumina' },
        { name: "V12Meta: Current Schema", sql: "SELECT CURRENT_SCHEMA AS a", check: r => r.data[0].a === 'main' },
        { name: "V12Meta: Schema Name", sql: "SELECT SCHEMA_NAME() AS a", check: r => r.data[0].a === 'main' },
        { name: "V12Meta: NewID Format", sql: "SELECT NEWID() AS a", check: r => /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(r.data[0].a) },
        { name: "V12Meta: Sys Guid Format", sql: "SELECT SYS_GUID() AS a", check: r => /^[0-9A-F]{32}$/.test(r.data[0].a) },
        { name: "V12Meta: Show Functions To Char", sql: "SHOW FUNCTIONS LIKE 'TO_CHAR'", check: r => r.data.length >= 1 },
        { name: "V12Meta: Show Functions Merge Fns", sql: "SHOW FUNCTIONS LIKE 'DATEADD'", check: r => r.data.length >= 1 },

        // ---- SQL Server TOP (V12Top) ----
        { name: "V12Top: Top N", sql: "SELECT TOP 3 * FROM users ORDER BY id", check: r => r.data.length === 3 && r.data[0].id === 1 && r.data[2].id === 3 },
        { name: "V12Top: Top N Desc", sql: "SELECT TOP 2 * FROM users ORDER BY id DESC", check: r => r.data.length === 2 && r.data[0].id === 10 },
        { name: "V12Top: Top Paren", sql: "SELECT TOP (4) id FROM users ORDER BY id", check: r => r.data.length === 4 },
        { name: "V12Top: Top Percent", sql: "SELECT TOP 50 PERCENT id FROM users ORDER BY id", check: r => r.data.length === 5 },
        { name: "V12Top: Top Percent Ceil", sql: "SELECT TOP 25 PERCENT id FROM users ORDER BY id", check: r => r.data.length === 3 },
        { name: "V12Top: Top With Distinct", sql: "SELECT DISTINCT TOP 2 user_id FROM orders ORDER BY user_id", check: r => r.data.length === 2 && r.data[0].user_id === 1 },
        { name: "V12Top: Top With Ties Basic", sql: "SELECT TOP 3 WITH TIES id FROM users ORDER BY id", check: r => r.data.length === 3 },
        { name: "V12Top: Top Bigger Than Rows", sql: "SELECT TOP 100 id FROM users", check: r => r.data.length === 10 },
        { name: "V12Top: Top 1 Aggregate", sql: "SELECT TOP 1 user_id, COUNT(*) AS c FROM orders GROUP BY user_id ORDER BY c DESC", check: r => r.data.length === 1 && r.data[0].user_id === 1 },

        // ---- MERGE (V12Merge) ----
        { name: "V12Merge: Setup Target", sql: "CREATE TABLE mg_t (id INTEGER PRIMARY KEY, val INTEGER, note TEXT)", check: r => r.data[0].Result === 'Success' },
        { name: "V12Merge: Seed Target", sql: "INSERT INTO mg_t (id, val, note) VALUES (1, 10, 'a'), (2, 20, 'b')", check: r => r.data[0].Message.includes('2') },
        { name: "V12Merge: Setup Source", sql: "CREATE TABLE mg_s (id INTEGER, val INTEGER, note TEXT)", check: r => r.data[0].Result === 'Success' },
        { name: "V12Merge: Seed Source", sql: "INSERT INTO mg_s (id, val, note) VALUES (2, 200, 'B'), (3, 30, 'c')", check: r => r.data[0].Message.includes('2') },
        { name: "V12Merge: Upsert Both Branches", sql: "MERGE INTO mg_t t USING mg_s s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET val = s.val, note = s.note WHEN NOT MATCHED THEN INSERT (id, val, note) VALUES (s.id, s.val, s.note)", check: r => r.data[0].Result === 'Success' },
        { name: "V12Merge: Verify Updated Row", sql: "SELECT val, note FROM mg_t WHERE id = 2", check: r => r.data[0].val === 200 && r.data[0].note === 'B' },
        { name: "V12Merge: Verify Inserted Row", sql: "SELECT val, note FROM mg_t WHERE id = 3", check: r => r.data[0].val === 30 && r.data[0].note === 'c' },
        { name: "V12Merge: Verify Untouched Row", sql: "SELECT val, note FROM mg_t WHERE id = 1", check: r => r.data[0].val === 10 && r.data[0].note === 'a' },
        { name: "V12Merge: Total Count", sql: "SELECT COUNT(*) AS c FROM mg_t", check: r => r.data[0].c === 3 },
        { name: "V12Merge: Matched Only Update", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS mg2t"); db.executeQuery("DROP TABLE IF EXISTS mg2s");
            db.executeQuery("CREATE TABLE mg2t (id INTEGER PRIMARY KEY, v INTEGER)");
            db.executeQuery("INSERT INTO mg2t (id, v) VALUES (1, 1), (2, 2)");
            db.executeQuery("CREATE TABLE mg2s (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO mg2s (id, v) VALUES (1, 100), (9, 999)");
            db.executeQuery("MERGE INTO mg2t t USING mg2s s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v");
            const r = db.executeQuery("SELECT v FROM mg2t WHERE id = 1");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM mg2t");
            db.executeQuery("DROP TABLE IF EXISTS mg2t"); db.executeQuery("DROP TABLE IF EXISTS mg2s");
            return r.data[0].v === 100 && cnt.data[0].c === 2; // 9 は挿入されない（NOT MATCHED 節なし）
        }},
        { name: "V12Merge: Not Matched Only Insert", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS mg3t"); db.executeQuery("DROP TABLE IF EXISTS mg3s");
            db.executeQuery("CREATE TABLE mg3t (id INTEGER PRIMARY KEY, v INTEGER)");
            db.executeQuery("INSERT INTO mg3t (id, v) VALUES (1, 1)");
            db.executeQuery("CREATE TABLE mg3s (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO mg3s (id, v) VALUES (1, 100), (2, 200)");
            db.executeQuery("MERGE INTO mg3t t USING mg3s s ON (t.id = s.id) WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)");
            const one = db.executeQuery("SELECT v FROM mg3t WHERE id = 1");
            const two = db.executeQuery("SELECT v FROM mg3t WHERE id = 2");
            db.executeQuery("DROP TABLE IF EXISTS mg3t"); db.executeQuery("DROP TABLE IF EXISTS mg3s");
            return one.data[0].v === 1 && two.data[0].v === 200; // id1 は更新されず、id2 が挿入
        }},
        { name: "V12Merge: Matched Delete", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS mg4t"); db.executeQuery("DROP TABLE IF EXISTS mg4s");
            db.executeQuery("CREATE TABLE mg4t (id INTEGER PRIMARY KEY, v INTEGER)");
            db.executeQuery("INSERT INTO mg4t (id, v) VALUES (1, 1), (2, 2), (3, 3)");
            db.executeQuery("CREATE TABLE mg4s (id INTEGER)");
            db.executeQuery("INSERT INTO mg4s (id) VALUES (2)");
            db.executeQuery("MERGE INTO mg4t t USING mg4s s ON (t.id = s.id) WHEN MATCHED THEN DELETE");
            const cnt = db.executeQuery("SELECT COUNT(*) AS c FROM mg4t");
            const gone = db.executeQuery("SELECT COUNT(*) AS c FROM mg4t WHERE id = 2");
            db.executeQuery("DROP TABLE IF EXISTS mg4t"); db.executeQuery("DROP TABLE IF EXISTS mg4s");
            return cnt.data[0].c === 2 && gone.data[0].c === 0;
        }},
        { name: "V12Merge: Subquery Source", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS mg5t");
            db.executeQuery("CREATE TABLE mg5t (uid INTEGER PRIMARY KEY, cnt INTEGER)");
            db.executeQuery("MERGE INTO mg5t t USING (SELECT user_id AS uid, COUNT(*) AS cnt FROM orders GROUP BY user_id) s ON (t.uid = s.uid) WHEN MATCHED THEN UPDATE SET cnt = s.cnt WHEN NOT MATCHED THEN INSERT (uid, cnt) VALUES (s.uid, s.cnt)");
            const rows = db.executeQuery("SELECT COUNT(*) AS c FROM mg5t");
            const u1 = db.executeQuery("SELECT cnt FROM mg5t WHERE uid = 1");
            db.executeQuery("DROP TABLE IF EXISTS mg5t");
            return rows.data[0].c === 4 && u1.data[0].cnt === 2; // user 1 は2件の注文
        }},
        { name: "V12Merge: Expr In Update", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS mg6t"); db.executeQuery("DROP TABLE IF EXISTS mg6s");
            db.executeQuery("CREATE TABLE mg6t (id INTEGER PRIMARY KEY, bal INTEGER)");
            db.executeQuery("INSERT INTO mg6t (id, bal) VALUES (1, 100)");
            db.executeQuery("CREATE TABLE mg6s (id INTEGER, amt INTEGER)");
            db.executeQuery("INSERT INTO mg6s (id, amt) VALUES (1, 50)");
            db.executeQuery("MERGE INTO mg6t t USING mg6s s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET bal = bal + s.amt");
            const r = db.executeQuery("SELECT bal FROM mg6t WHERE id = 1");
            db.executeQuery("DROP TABLE IF EXISTS mg6t"); db.executeQuery("DROP TABLE IF EXISTS mg6s");
            return r.data[0].bal === 150; // 既存 bal(100) + source amt(50)
        }},

        // ---- PostgreSQL ON CONFLICT (V12Conflict) ----
        { name: "V12Conflict: Setup", sql: "CREATE TABLE oc_t (id INTEGER PRIMARY KEY, cnt INTEGER, name TEXT)", check: r => r.data[0].Result === 'Success' },
        { name: "V12Conflict: Seed", sql: "INSERT INTO oc_t (id, cnt, name) VALUES (1, 5, 'x')", check: r => r.data[0].Message.includes('1') },
        { name: "V12Conflict: Do Nothing Skips", sql: "INSERT INTO oc_t (id, cnt, name) VALUES (1, 100, 'y') ON CONFLICT (id) DO NOTHING", check: r => r.data[0].Result === 'Success' },
        { name: "V12Conflict: Do Nothing Verify", sql: "SELECT cnt, name FROM oc_t WHERE id = 1", check: r => r.data[0].cnt === 5 && r.data[0].name === 'x' },
        { name: "V12Conflict: Do Update Excluded", sql: "INSERT INTO oc_t (id, cnt, name) VALUES (1, 100, 'y') ON CONFLICT (id) DO UPDATE SET cnt = EXCLUDED.cnt, name = EXCLUDED.name", check: r => r.data[0].Result === 'Success' },
        { name: "V12Conflict: Do Update Verify", sql: "SELECT cnt, name FROM oc_t WHERE id = 1", check: r => r.data[0].cnt === 100 && r.data[0].name === 'y' },
        { name: "V12Conflict: Do Update Inserts New", sql: "INSERT INTO oc_t (id, cnt, name) VALUES (2, 7, 'z') ON CONFLICT (id) DO UPDATE SET cnt = EXCLUDED.cnt", check: r => r.data[0].Result === 'Success' },
        { name: "V12Conflict: New Row Present", sql: "SELECT cnt FROM oc_t WHERE id = 2", check: r => r.data[0].cnt === 7 },
        { name: "V12Conflict: Do Update Expr Combine", fn: () => {
            db.executeQuery("INSERT INTO oc_t (id, cnt, name) VALUES (1, 3, 'w') ON CONFLICT (id) DO UPDATE SET cnt = oc_t.cnt + EXCLUDED.cnt");
            const r = db.executeQuery("SELECT cnt FROM oc_t WHERE id = 1");
            return r.data[0].cnt === 103; // 既存 100 + 挿入 3
        }},
        { name: "V12Conflict: Do Nothing No Target", sql: "INSERT INTO oc_t (id, cnt, name) VALUES (1, 0, 'q') ON CONFLICT DO NOTHING", check: r => r.data[0].Result === 'Success' },
        { name: "V12Conflict: Cleanup", sql: "DROP TABLE oc_t", check: r => true },

        // ---- MERGE / TOP のクリーンアップ ----
        { name: "V12Merge: Cleanup T", sql: "DROP TABLE mg_t", check: r => true },
        { name: "V12Merge: Cleanup S", sql: "DROP TABLE mg_s", check: r => true }
      ];
    }
