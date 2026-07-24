    // ============================================================================
    // [Test Suite v11] - v1.10 機能追加の回帰テスト
    //   1. 追加の商用DBスカラー関数（変換 / 文字列 / ビット演算 / 日付ビルダー）
    //   2. LISTAGG（Oracle 集計 = GROUP_CONCAT 別名）
    //   3. コンソールの「実行結果件数」表示・クリックでエディタ再読込
    //   test-suite.js の tests 配列へ getV11Tests() のスプレッドで合流する
    // ============================================================================
    function getV11Tests() {
      return [
        // ---- 変換関数 (V11Conv) ----
        { name: "V11Conv: To Number", sql: "SELECT TO_NUMBER('1,234.5') AS a, TO_NUMBER('42') AS b", check: r => r.data[0].a === 1234.5 && r.data[0].b === 42 },
        { name: "V11Conv: To Number Invalid", sql: "SELECT TO_NUMBER('abc') AS a", check: r => r.data[0].a === null },
        { name: "V11Conv: To Date", sql: "SELECT TO_DATE('2026-07-23 10:00:00') AS a", check: r => r.data[0].a === '2026-07-23' },
        { name: "V11Conv: To Timestamp", sql: "SELECT TO_TIMESTAMP('2026-07-23') AS a", check: r => r.data[0].a === '2026-07-23 00:00:00' },

        // ---- 文字列 (V11Str) ----
        { name: "V11Str: QuoteName Default", sql: "SELECT QUOTENAME('col name') AS a", check: r => r.data[0].a === '[col name]' },
        { name: "V11Str: QuoteName Escapes Bracket", sql: "SELECT QUOTENAME('a]b') AS a", check: r => r.data[0].a === '[a]]b]' },
        { name: "V11Str: QuoteName Quote Delim", sql: "SELECT QUOTENAME('abc', '\"') AS a", check: r => r.data[0].a === '\"abc\"' },
        { name: "V11Str: PatIndex Found", sql: "SELECT PATINDEX('%[0-9]%', 'abc123') AS a", check: r => r.data[0].a === 4 },
        { name: "V11Str: PatIndex Not Found", sql: "SELECT PATINDEX('%xyz%', 'abc') AS a", check: r => r.data[0].a === 0 },
        { name: "V11Str: Chr", sql: "SELECT CHR(65) AS a, CHR(97) AS b", check: r => r.data[0].a === 'A' && r.data[0].b === 'a' },
        { name: "V11Str: Strpos", sql: "SELECT STRPOS('hello', 'll') AS a, STRPOS('hello', 'z') AS b", check: r => r.data[0].a === 3 && r.data[0].b === 0 },
        { name: "V11Str: Replicate", sql: "SELECT REPLICATE('ab', 3) AS a", check: r => r.data[0].a === 'ababab' },

        // ---- ビット演算 (V11Bit) ----
        { name: "V11Bit: BitAnd/Or/Xor", sql: "SELECT BITAND(12, 10) AS a, BITOR(12, 10) AS o, BITXOR(12, 10) AS x", check: r => r.data[0].a === 8 && r.data[0].o === 14 && r.data[0].x === 6 },
        { name: "V11Bit: BitNot", sql: "SELECT BITNOT(0) AS a", check: r => r.data[0].a === -1 },
        { name: "V11Bit: IsNumeric", sql: "SELECT ISNUMERIC('123') AS a, ISNUMERIC('12.5') AS b, ISNUMERIC('abc') AS c, ISNUMERIC('') AS d", check: r => r.data[0].a === 1 && r.data[0].b === 1 && r.data[0].c === 0 && r.data[0].d === 0 },

        // ---- 日付ビルダー (V11Date) ----
        { name: "V11Date: Eomonth", sql: "SELECT EOMONTH('2026-02-10') AS a", check: r => r.data[0].a === '2026-02-28' },
        { name: "V11Date: Eomonth Offset", sql: "SELECT EOMONTH('2026-02-10', 1) AS a", check: r => r.data[0].a === '2026-03-31' },
        { name: "V11Date: Eomonth Leap", sql: "SELECT EOMONTH('2024-02-10') AS a", check: r => r.data[0].a === '2024-02-29' },
        { name: "V11Date: Make Date", sql: "SELECT MAKE_DATE(2026, 7, 23) AS a", check: r => r.data[0].a === '2026-07-23' },
        { name: "V11Date: Make Timestamp", sql: "SELECT MAKE_TIMESTAMP(2026, 7, 23, 14, 30, 0) AS a", check: r => r.data[0].a === '2026-07-23 14:30:00' },

        // ---- LISTAGG（Oracle 集計） (V11Agg) ----
        { name: "V11Agg: Listagg Default Sep", sql: "SELECT LISTAGG(name) AS a FROM users", check: r => r.data[0].a.startsWith('Alice,Bob') && r.data[0].a.includes('Judy') },
        { name: "V11Agg: Listagg Custom Sep", sql: "SELECT LISTAGG(name, ' | ') AS a FROM users", check: r => r.data[0].a.includes('Alice | Bob') && r.data[0].a.split(' | ').length === 10 },
        { name: "V11Agg: Listagg Grouped", sql: "SELECT user_id, LISTAGG(product_id, '-') AS ps FROM orders GROUP BY user_id ORDER BY user_id", check: r => r.data[0].user_id === 1 && r.data[0].ps === '101-105' },
        { name: "V11Agg: Show Functions Listagg", sql: "SHOW FUNCTIONS LIKE 'LISTAGG'", check: r => r.data.length >= 1 },
        { name: "V11Agg: Show Functions New Scalars", sql: "SHOW FUNCTIONS LIKE 'EOMONTH'", check: r => r.data.length >= 1 },

        // ---- コンソール: 結果件数表示・クリック再読込 (V11Console) ----
        { name: "V11Console: Result Count Displayed", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            const bku = els.query.value;
            els.query.value = 'SELECT * FROM users';
            runQuery();
            els.query.value = bku;
            const body = document.getElementById('consoleBody');
            const ok = body.textContent.includes('10 件取得');
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }},
        { name: "V11Console: DML Rows Processed", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            db.executeQuery("DROP TABLE IF EXISTS v11c");
            db.executeQuery("CREATE TABLE v11c (id INTEGER)");
            db.executeQuery("INSERT INTO v11c (id) VALUES (1), (2), (3)");
            const bku = els.query.value;
            els.query.value = 'UPDATE v11c SET id = id + 1';
            runQuery();
            els.query.value = bku;
            const body = document.getElementById('consoleBody');
            const ok = body.textContent.includes('3 行処理');
            db.executeQuery("DROP TABLE IF EXISTS v11c");
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }},
        { name: "V11Console: Click Reloads Query Into Editor", fn: () => {
            document.getElementById('consoleLauncher').click();
            clearConsole();
            const bku = els.query.value;
            els.query.value = 'SELECT 42 AS answer';
            runQuery();
            els.query.value = '';
            const line = document.querySelector('#consoleBody [data-cidx]');
            if (line) line.click();
            const ok = els.query.value === 'SELECT 42 AS answer';
            els.query.value = bku;
            updateHighlight();
            document.getElementById('consoleCloseBtn').click();
            return ok;
        }}
      ];
    }
