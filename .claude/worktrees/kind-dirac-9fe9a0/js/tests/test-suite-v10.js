    // ============================================================================
    // [Test Suite v10] - v1.9 機能追加の回帰テスト
    //   商用DB(Oracle / SQL Server / PostgreSQL)で頻用のスカラー関数群
    //     V10Cond : DECODE / NVL2 / ISNULL / ZEROIFNULL / NULLIFZERO / CHOOSE
    //     V10Str  : STARTS_WITH / ENDS_WITH / CHARINDEX / LEN / STUFF / REGEXP_INSTR
    //     V10Num  : SQUARE / POW / GCD / LCM / FACTORIAL / WIDTH_BUCKET
    //     V10Date : ADD_MONTHS / MONTHS_BETWEEN / DATE_PART / GETDATE
    //   test-suite.js の tests 配列へ getV10Tests() のスプレッドで合流する
    // ============================================================================
    function getV10Tests() {
      return [
        // ---- 条件・NULL処理 (V10Cond) ----
        { name: "V10Cond: Decode Match", sql: "SELECT DECODE(2, 1, 'a', 2, 'b', 3, 'c', 'z') AS r", check: r => r.data[0].r === 'b' },
        { name: "V10Cond: Decode Default", sql: "SELECT DECODE(9, 1, 'a', 2, 'b', 'z') AS r", check: r => r.data[0].r === 'z' },
        { name: "V10Cond: Decode No Default No Match", sql: "SELECT DECODE(9, 1, 'a', 2, 'b') AS r", check: r => r.data[0].r === null },
        { name: "V10Cond: Decode Null Matches Null", sql: "SELECT DECODE(NULL, NULL, 'isnull', 'other') AS r", check: r => r.data[0].r === 'isnull' },
        { name: "V10Cond: Decode Over Column", sql: "SELECT id, DECODE(age, 25, 'Q', 30, 'M', 'O') AS g FROM users ORDER BY id LIMIT 1", check: r => typeof r.data[0].g === 'string' },
        { name: "V10Cond: Nvl2 NotNull", sql: "SELECT NVL2('x', 'yes', 'no') AS r", check: r => r.data[0].r === 'yes' },
        { name: "V10Cond: Nvl2 Null", sql: "SELECT NVL2(NULL, 'yes', 'no') AS r", check: r => r.data[0].r === 'no' },
        { name: "V10Cond: IsNull Replaces", sql: "SELECT ISNULL(NULL, 'def') AS a, ISNULL('v', 'def') AS b", check: r => r.data[0].a === 'def' && r.data[0].b === 'v' },
        { name: "V10Cond: ZeroIfNull", sql: "SELECT ZEROIFNULL(NULL) AS a, ZEROIFNULL(5) AS b", check: r => r.data[0].a === 0 && r.data[0].b === 5 },
        { name: "V10Cond: NullIfZero", sql: "SELECT NULLIFZERO(0) AS a, NULLIFZERO(7) AS b", check: r => r.data[0].a === null && r.data[0].b === 7 },
        { name: "V10Cond: Choose In Range", sql: "SELECT CHOOSE(3, 'a', 'b', 'c', 'd') AS r", check: r => r.data[0].r === 'c' },
        { name: "V10Cond: Choose Out Of Range", sql: "SELECT CHOOSE(9, 'a', 'b') AS r", check: r => r.data[0].r === null },

        // ---- 文字列 (V10Str) ----
        { name: "V10Str: Starts With", sql: "SELECT STARTS_WITH('hello', 'he') AS a, STARTS_WITH('hello', 'xy') AS b", check: r => r.data[0].a === true && r.data[0].b === false },
        { name: "V10Str: Ends With", sql: "SELECT ENDS_WITH('hello', 'lo') AS a, ENDS_WITH('hello', 'x') AS b", check: r => r.data[0].a === true && r.data[0].b === false },
        { name: "V10Str: Starts With In Where", sql: "SELECT COUNT(*) AS c FROM users WHERE STARTS_WITH(name, name)", check: r => r.data[0].c === 10 },
        { name: "V10Str: CharIndex Basic", sql: "SELECT CHARINDEX('l', 'hello') AS a, CHARINDEX('z', 'hello') AS b", check: r => r.data[0].a === 3 && r.data[0].b === 0 },
        { name: "V10Str: CharIndex With Start", sql: "SELECT CHARINDEX('l', 'hello', 4) AS a", check: r => r.data[0].a === 4 },
        { name: "V10Str: Len Ignores Trailing Space", sql: "SELECT LEN('abc   ') AS a, LEN('hello') AS b", check: r => r.data[0].a === 3 && r.data[0].b === 5 },
        { name: "V10Str: Stuff Replace", sql: "SELECT STUFF('abcdef', 2, 3, 'XY') AS r", check: r => r.data[0].r === 'aXYef' },
        { name: "V10Str: Stuff Invalid Start", sql: "SELECT STUFF('abc', 0, 1, 'X') AS r", check: r => r.data[0].r === null },
        { name: "V10Str: Regexp Instr", sql: "SELECT REGEXP_INSTR('order#123', '[0-9]+') AS r", check: r => r.data[0].r === 7 },
        { name: "V10Str: Regexp Instr No Match", sql: "SELECT REGEXP_INSTR('abcdef', '[0-9]+') AS r", check: r => r.data[0].r === 0 },

        // ---- 数値 (V10Num) ----
        { name: "V10Num: Square", sql: "SELECT SQUARE(7) AS r", check: r => r.data[0].r === 49 },
        { name: "V10Num: Pow", sql: "SELECT POW(2, 10) AS r", check: r => r.data[0].r === 1024 },
        { name: "V10Num: Gcd", sql: "SELECT GCD(12, 18) AS r", check: r => r.data[0].r === 6 },
        { name: "V10Num: Lcm", sql: "SELECT LCM(4, 6) AS r", check: r => r.data[0].r === 12 },
        { name: "V10Num: Factorial", sql: "SELECT FACTORIAL(5) AS r", check: r => r.data[0].r === 120 },
        { name: "V10Num: Factorial Zero", sql: "SELECT FACTORIAL(0) AS r", check: r => r.data[0].r === 1 },
        { name: "V10Num: Width Bucket Middle", sql: "SELECT WIDTH_BUCKET(25, 20, 40, 4) AS r", check: r => r.data[0].r === 2 },
        { name: "V10Num: Width Bucket Below", sql: "SELECT WIDTH_BUCKET(10, 20, 40, 4) AS r", check: r => r.data[0].r === 0 },
        { name: "V10Num: Width Bucket Above", sql: "SELECT WIDTH_BUCKET(50, 20, 40, 4) AS r", check: r => r.data[0].r === 5 },

        // ---- 日付 (V10Date) ----
        { name: "V10Date: Add Months Clamps EOM", sql: "SELECT ADD_MONTHS('2026-01-31', 1) AS r", check: r => r.data[0].r === '2026-02-28 00:00:00' },
        { name: "V10Date: Add Months Simple", sql: "SELECT ADD_MONTHS('2026-01-15', 2) AS r", check: r => r.data[0].r === '2026-03-15 00:00:00' },
        { name: "V10Date: Add Months Negative", sql: "SELECT ADD_MONTHS('2026-03-15', -2) AS r", check: r => r.data[0].r === '2026-01-15 00:00:00' },
        { name: "V10Date: Months Between", sql: "SELECT MONTHS_BETWEEN('2026-03-15', '2026-01-15') AS r", check: r => r.data[0].r === 2 },
        { name: "V10Date: Date Part Year", sql: "SELECT DATE_PART('year', '2026-07-23 10:20:30') AS r", check: r => r.data[0].r === 2026 },
        { name: "V10Date: Date Part Month", sql: "SELECT DATE_PART('month', '2026-07-23') AS r", check: r => r.data[0].r === 7 },
        { name: "V10Date: Date Part Dow", sql: "SELECT DATE_PART('dow', '2026-07-23') AS r", check: r => r.data[0].r === 4 },
        { name: "V10Date: GetDate Returns String", sql: "SELECT GETDATE() AS r", check: r => typeof r.data[0].r === 'string' && r.data[0].r.length >= 10 },

        // ---- SHOW FUNCTIONS への登録確認 ----
        { name: "V10Meta: Show Functions Lists New", sql: "SHOW FUNCTIONS LIKE 'DECODE'", check: r => r.data.length >= 1 },
        { name: "V10Meta: Show Functions Add Months", sql: "SHOW FUNCTIONS LIKE 'ADD_MONTHS'", check: r => r.data.length >= 1 },

        // ---- コンソール (V10Console): 画面左下の実行ログパネル ----
        { name: "V10Console: Launcher Opens Panel", fn: () => {
            const panel = document.getElementById('consolePanel');
            document.getElementById('consoleLauncher').click();
            const shown = !panel.classList.contains('hidden');
            document.getElementById('consoleCloseBtn').click();
            const hidden = panel.classList.contains('hidden');
            return shown && hidden;
        }},
        { name: "V10Console: logConsole Records Entry", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            logConsole('success', 'TESTMSG_ABC', 'detail_xyz');
            const body = document.getElementById('consoleBody');
            const ok = body.textContent.includes('TESTMSG_ABC') && body.textContent.includes('detail_xyz')
                       && document.getElementById('consoleCount').textContent === '1';
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }},
        { name: "V10Console: Clear Empties Log", fn: () => {
            document.getElementById('consoleLauncher').click();
            logConsole('info', 'x'); logConsole('info', 'y');
            clearConsole();
            const ok = document.getElementById('consoleCount').textContent === '0';
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }},
        { name: "V10Console: runQuery Logs Query", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            const bku = els.query.value;
            els.query.value = 'SELECT 1 AS x';
            runQuery();
            els.query.value = bku;
            const body = document.getElementById('consoleBody');
            const ok = body.textContent.includes('SELECT 1 AS x') && /件取得/.test(body.textContent);
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }},
        { name: "V10Console: runQuery Logs Error", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            const bku = els.query.value;
            els.query.value = 'SELECT * FROM __no_such_table__';
            runQuery();
            els.query.value = bku;
            const body = document.getElementById('consoleBody');
            const ok = /\[ERR\]/.test(body.textContent);
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }}
      ];
    }
