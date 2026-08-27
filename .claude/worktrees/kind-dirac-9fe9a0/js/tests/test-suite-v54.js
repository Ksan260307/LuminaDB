    // ============================================================================
    // [Test Suite v54] - 書き味 (4/5): 関数呼び出しと式の書き方
    //
    //   実装済みの組み込み関数 130 本あまりを土台に、呼び出しの書き方（空白・改行・
    //   コメント・大小文字）を機械的に変えても同じ値を返すことを確かめる。
    //   演算子の優先順位・CASE の書き分け・型変換の綴り・日付式の書き方も併せて見る。
    //
    //     A. 関数呼び出しの書き味（9 通り × 関数）
    //     B. 引数の書き方（リテラル / 式 / 入れ子 / 括弧の重ね掛け）
    //     C. 演算子の優先順位と括弧
    //     D. CASE 式の書き分け
    //     E. 型変換の綴り
    //     F. 日付・時刻の式の書き方
    //     G. JSON の取り出し方
    //     H. 配列・文字列関数の別綴り
    //
    //   A の「関数名と開き括弧の間の空白」は v1.31 で直した欠陥の回帰でもある
    //   （`ABS (x)` が「関数 ABS は存在しません。ABS の間違いでは？」になっていた）。
    //
    //   test-suite.js の tests 配列へ getV54Tests() のスプレッドで合流する
    // ============================================================================
    function getV54Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, val, outside, upper, lower, cleanup } = makeTestKit('V54');
      // 式だけを差し替えて比べる
      const sel = (e) => `SELECT id, ${e} AS v FROM v54_t ORDER BY id`;
      const sameExpr = (name, a, b) => same(name, sel(a), sel(b));

      // ------------------------------------------------------------
      // 0. フィクスチャ（3 行。値・NULL・前後空白・JSON を 1 行ずつ持たせる）
      // ------------------------------------------------------------
      t('V54 fixture', () => {
        q('DROP TABLE IF EXISTS v54_t');
        q("CREATE TABLE v54_t (id INT PRIMARY KEY, name TEXT, sal INT, ratio DECIMAL(18,4), "
          + "hired DATE, ts DATETIME, js TEXT, flag BOOLEAN)");
        q("INSERT INTO v54_t VALUES "
          + "(1, 'Alpha', 300, 1.25, '2020-03-15', '2020-03-15 10:20:30', '{\"a\": 1, \"b\": [2, 3]}', TRUE), "
          + "(2, 'beta', NULL, -2.5, '2021-07-01', '2021-07-01 23:59:59', '{\"a\": 2, \"b\": []}', FALSE), "
          + "(3, '  gamma  ', 450, 0, '2019-12-31', '2019-12-31 00:00:00', '{\"a\": null}', TRUE)");
        return db.tables['v54_t'].rowCount === 3;
      });

      // ============================================================
      // A. 関数呼び出しの書き味
      // ============================================================
      const FNS = [
        "ABS(sal - 350)", "CEIL(ratio)", "FLOOR(ratio)", "ROUND(ratio, 1)", "ROUND(ratio)", "TRUNCATE(ratio, 1)",
        "SIGN(ratio)", "MOD(sal, 7)", "POWER(id, 3)", "SQRT(sal)", "EXP(id)", "LN(sal)", "LOG10(sal)", "LOG(2, sal)",
        "GREATEST(id, 2)", "LEAST(id, 2)", "PI()", "RADIANS(sal)", "DEGREES(id)", "SIN(id)", "COS(id)", "TAN(id)",
        "ATAN2(id, 2)", "CBRT(sal)", "GCD(sal, 12)", "LCM(id, 6)", "FACTORIAL(id)", "SQUARE(id)",
        "WIDTH_BUCKET(sal, 0, 500, 5)",
        "UPPER(name)", "LOWER(name)", "LENGTH(name)", "CHAR_LENGTH(name)", "OCTET_LENGTH(name)", "TRIM(name)",
        "LTRIM(name)", "RTRIM(name)", "LPAD(name, 10, '.')", "RPAD(name, 10, '.')", "SUBSTRING(name, 2, 3)",
        "LEFT(name, 2)", "RIGHT(name, 2)", "REVERSE(name)", "REPLACE(name, 'a', 'A')", "REPEAT(name, 2)",
        "CONCAT(name, '/', id)", "CONCAT_WS('-', name, id)", "INSTR(name, 'a')", "LOCATE('a', name)",
        "POSITION('a' IN name)", "INITCAP(name)", "ASCII(name)", "CHAR(65)", "SPACE(3)", "STRCMP(name, 'beta')",
        "SUBSTRING_INDEX(name, 'a', 1)", "SOUNDEX(name)", "TRANSLATE(name, 'ab', 'xy')", "QUOTE(name)",
        "SPLIT_PART(name, 'a', 1)", "STARTS_WITH(name, 'A')", "ENDS_WITH(name, 'a')", "LEVENSHTEIN(name, 'alpha')",
        "FORMAT(ratio, 2)", "HEX(sal)", "BIN(sal)", "OCT(sal)", "CONV(sal, 10, 2)", "TO_BASE64(name)",
        "MD5(name)", "SHA1(name)", "SHA256(name)", "CRC32(name)",
        "YEAR(hired)", "MONTH(hired)", "DAY(hired)", "QUARTER(hired)", "WEEK(hired)", "DAYOFWEEK(hired)",
        "DAYOFYEAR(hired)", "DAYNAME(hired)", "MONTHNAME(hired)", "LAST_DAY(hired)", "DATE(ts)", "TIME(ts)",
        "HOUR(ts)", "MINUTE(ts)", "SECOND(ts)", "DATEDIFF(hired, '2020-01-01')", "DATE_ADD(hired, INTERVAL 1 MONTH)",
        "DATE_SUB(hired, INTERVAL 7 DAY)", "DATE_FORMAT(hired, '%Y/%m/%d')", "EXTRACT(YEAR FROM hired)",
        "TIMESTAMPDIFF(DAY, hired, '2022-01-01')", "TIMESTAMPADD(MONTH, 2, hired)", "DATE_TRUNC('month', ts)",
        "TO_DAYS(hired)", "UNIX_TIMESTAMP(ts)", "STR_TO_DATE('2020-05-06', '%Y-%m-%d')", "ADD_MONTHS(hired, 3)",
        "MONTHS_BETWEEN(hired, '2020-01-01')", "NEXT_DAY(hired, 'Monday')", "EOMONTH(hired)",
        "CAST(sal AS TEXT)", "CONVERT(sal, CHAR)", "TRY_CAST(name AS INTEGER)", "COALESCE(sal, 0)",
        "IFNULL(sal, 0)", "NULLIF(sal, 300)", "NVL2(sal, 1, 0)", "IF(sal > 300, 'hi', 'lo')",
        "IIF(sal > 300, 'hi', 'lo')", "DECODE(id, 1, 'one', 'other')", "CHOOSE(id, 'a', 'b', 'c')",
        "ZEROIFNULL(sal)", "NULLIFZERO(sal)",
        "JSON_EXTRACT(js, '$.a')", "JSON_VALID(js)", "JSON_TYPE(js)", "JSON_LENGTH(js)", "JSON_KEYS(js)",
        "JSON_OBJECT('k', id)", "JSON_ARRAY(id, name)", "JSON_QUOTE(name)", "JSON_UNQUOTE(JSON_EXTRACT(js, '$.a'))",
        "REGEXP_REPLACE(name, '[aeiou]', '*')", "REGEXP_SUBSTR(name, '[a-z]+')", "REGEXP_LIKE(name, '^a')",
        "REGEXP_COUNT(name, 'a')", "REGEXP_INSTR(name, 'a')",
        "TYPEOF(sal)", "ARRAY_LENGTH(ARRAY[1, 2, 3])", "ARRAY_TO_STRING(ARRAY[1, 2], '-')",
      ];
      const CALL_STYLES = [
        ['関数名と括弧の間に空白', e => outside(e, x => x.replace(/([A-Za-z_])\(/g, '$1 ('))],
        ['カンマの後ろを詰める', e => outside(e, x => x.replace(/,\s+/g, ','))],
        ['括弧の内側に空白を足す', e => outside(e, x => x.replace(/,\s*/g, ' ,  ').replace(/\(/g, '( ').replace(/\)/g, ' )'))],
        ['引数ごとに改行', e => outside(e, x => x.replace(/,\s*/g, ',\n    '))],
        ['括弧の内側で改行', e => outside(e, x => x.replace(/\(/g, '(\n  ').replace(/\)/g, '\n)'))],
        ['引数の間にブロックコメント', e => outside(e, x => x.replace(/,\s*/g, ', /* 次の引数 */ '))],
        ['大文字', upper],
        ['小文字', lower],
        ['空白をタブに', e => outside(e, x => x.replace(/ /g, '\t'))],
      ];
      FNS.forEach((e, i) => CALL_STYLES.forEach(([label, f]) => {
        sameExpr(`V54A #${i} ${e.slice(0, 34)} — ${label}`, e, f(e));
      }));

      // ============================================================
      // B. 引数の書き方
      // ============================================================
      [
        ['定数畳み込み', "ROUND(ratio, 1)", "ROUND(ratio, 0 + 1)"],
        ['定数畳み込み（掛け算）', "SUBSTRING(name, 2, 3)", "SUBSTRING(name, 1 + 1, 6 / 2)"],
        ['括弧の重ね掛け', "ABS(sal - 350)", "ABS(((sal) - (350)))"],
        ['引数を副問い合わせで', "ROUND(ratio, 1)", "ROUND(ratio, (SELECT 1))"],
        ['入れ子の呼び出し', "UPPER(TRIM(name))", "UPPER(LTRIM(RTRIM(name)))"],
        ['三重の入れ子', "LENGTH(UPPER(TRIM(name)))", "LENGTH(UPPER(LTRIM(RTRIM(name))))"],
        ['列の別名を経由しない形', "CONCAT(name, '/', id)", "name || '/' || CAST(id AS TEXT)"],
        ['CASE を引数に', "UPPER(COALESCE(name, 'x'))", "UPPER(CASE WHEN name IS NULL THEN 'x' ELSE name END)"],
        ['演算を引数に', "MOD(sal, 7)", "MOD(sal + 0, 7 * 1)"],
        ['負数の引数', "ROUND(ratio, 0)", "ROUND(ratio, -0)"],
      ].forEach(([label, a, b], i) => sameExpr(`V54B #${i} ${label}`, a, b));

      // ============================================================
      // C. 演算子の優先順位と括弧
      // ============================================================
      const OPX = [
        ['乗除は加減より先', "sal + id * 2", "sal + (id * 2)"],
        ['左結合の引き算', "sal - id - 1", "(sal - id) - 1"],
        ['割り算の左結合', "sal / 2 / 5", "(sal / 2) / 5"],
        ['単項マイナス', "-sal + 10", "(-sal) + 10"],
        ['単項マイナスの空白', "-sal", "- sal"],
        ['剰余と乗算', "sal % 7 * 2", "(sal % 7) * 2"],
        ['連結は左結合', "name || '-' || 'x'", "(name || '-') || 'x'"],
        ['比較より算術が先', "sal - 50 > 200", "(sal - 50) > 200"],
        ['AND は OR より強い', "sal > 200 OR sal < 100 AND id = 1", "sal > 200 OR (sal < 100 AND id = 1)"],
        ['NOT は比較より弱い', "NOT sal = 300", "NOT (sal = 300)"],
        ['NOT と <>', "NOT sal <> 300", "NOT (sal <> 300)"],
        ['NOT と !=', "NOT sal != 300", "NOT (sal != 300)"],
        ['NOT と >', "NOT sal > 300", "NOT (sal > 300)"],
        ['NOT の二重', "NOT NOT sal = 300", "sal = 300"],
        ['括弧の重ね掛け', "sal + 1", "((((sal)) + ((1))))"],
        ['空白の有無', "sal+1", "sal + 1"],
        ['空白を多めに', "sal  +  1", "sal + 1"],
        ['改行を挟む', "sal +\n1", "sal + 1"],
        ['コメントを挟む', "sal /* 足す */ + 1", "sal + 1"],
        ['IS NULL は比較ではない', "sal IS NULL", "NOT (sal IS NOT NULL)"],
      ];
      OPX.forEach(([label, a, b], i) => sameExpr(`V54C #${i} ${label}`, a, b));
      // 論理式は WHERE でも同じ結果になること
      OPX.slice(8, 14).forEach(([label, a, b], i) => same(`V54C WHERE #${i} ${label}`,
        `SELECT id FROM v54_t WHERE ${a} ORDER BY id`,
        `SELECT id FROM v54_t WHERE ${b} ORDER BY id`));

      // ============================================================
      // D. CASE 式の書き分け
      // ============================================================
      const CASE_BASE = "CASE WHEN sal >= 400 THEN 'A' WHEN sal >= 300 THEN 'B' ELSE 'C' END";
      [
        ['WHEN ごとに改行', "CASE\n  WHEN sal >= 400 THEN 'A'\n  WHEN sal >= 300 THEN 'B'\n  ELSE 'C'\nEND"],
        ['THEN の後ろで改行', "CASE WHEN sal >= 400 THEN\n'A' WHEN sal >= 300 THEN\n'B' ELSE\n'C' END"],
        ['ELSE の前で改行', "CASE WHEN sal >= 400 THEN 'A' WHEN sal >= 300 THEN 'B'\nELSE 'C' END"],
        ['END の前で改行', "CASE WHEN sal >= 400 THEN 'A' WHEN sal >= 300 THEN 'B' ELSE 'C'\nEND"],
        ['小文字で書く', "case when sal >= 400 then 'A' when sal >= 300 then 'B' else 'C' end"],
        ['コメントを挟む', "CASE /* 判定 */ WHEN sal >= 400 THEN 'A' -- 高\n WHEN sal >= 300 THEN 'B' ELSE 'C' END"],
        ['タブで区切る', "CASE\tWHEN sal >= 400 THEN 'A'\tWHEN sal >= 300 THEN 'B'\tELSE 'C' END"],
        ['条件を入れ替えて等価に', "CASE WHEN sal < 300 OR sal IS NULL THEN 'C' WHEN sal >= 400 THEN 'A' ELSE 'B' END"],
        ['入れ子の CASE', "CASE WHEN sal >= 300 THEN CASE WHEN sal >= 400 THEN 'A' ELSE 'B' END ELSE 'C' END"],
        ['入れ子の CASE（改行あり）', "CASE\n WHEN sal >= 300 THEN\n  CASE WHEN sal >= 400 THEN 'A'\n  ELSE 'B'\n  END\n ELSE 'C'\nEND"],
        ['括弧で包む', "(CASE WHEN sal >= 400 THEN 'A' WHEN sal >= 300 THEN 'B' ELSE 'C' END)"],
      ].forEach(([label, v], i) => sameExpr(`V54D #${i} ${label}`, CASE_BASE, v));
      const SIMPLE_CASE = "CASE id WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END";
      [
        ['探索形へ書き換え', "CASE WHEN id = 1 THEN 'one' WHEN id = 2 THEN 'two' ELSE 'other' END"],
        ['改行して整形', "CASE id\n  WHEN 1 THEN 'one'\n  WHEN 2 THEN 'two'\n  ELSE 'other'\nEND"],
        ['DECODE で書く', "DECODE(id, 1, 'one', 2, 'two', 'other')"],
        ['小文字', "case id when 1 then 'one' when 2 then 'two' else 'other' end"],
      ].forEach(([label, v], i) => sameExpr(`V54D 簡易形 #${i} ${label}`, SIMPLE_CASE, v));
      // ELSE 無しは NULL
      sameExpr('V54D ELSE を書かないと NULL',
               "CASE WHEN sal >= 400 THEN 'A' END",
               "CASE WHEN sal >= 400 THEN 'A' ELSE NULL END");
      sameExpr('V54D ELSE 無し + 改行',
               "CASE WHEN sal >= 400 THEN 'A' END",
               "CASE WHEN sal >= 400 THEN 'A'\nEND");

      // ============================================================
      // E. 型変換の綴り
      // ============================================================
      [
        ['CAST と CONVERT', "CAST(sal AS TEXT)", "CONVERT(sal, CHAR)"],
        ['CAST と ::', "CAST(sal AS TEXT)", "sal::TEXT"],
        ['CAST の別名（VARCHAR）', "CAST(sal AS TEXT)", "CAST(sal AS VARCHAR)"],
        ['CAST の別名（CHAR）', "CAST(sal AS TEXT)", "CAST(sal AS CHAR)"],
        ['整数への変換', "CAST(ratio AS INTEGER)", "CAST(ratio AS INT)"],
        ['整数への変換（SIGNED）', "CAST(ratio AS INTEGER)", "CONVERT(ratio, SIGNED)"],
        ['入れ子の CAST', "CAST(sal AS TEXT)", "CAST(CAST(sal AS INTEGER) AS TEXT)"],
        ['関数を挟んだ入れ子の CAST', "CAST(LENGTH(CAST(sal AS TEXT)) AS TEXT)", "LENGTH(CAST(sal AS TEXT))::TEXT"],
        ['小数への変換', "CAST(sal AS DECIMAL(18,2))", "CAST(sal AS DECIMAL(18, 2))"],
        ['日付への変換', "CAST(hired AS DATE)", "hired::DATE"],
        ['大小文字', "CAST(sal AS TEXT)", "cast(sal as text)"],
        ['空白と改行', "CAST(sal AS TEXT)", "CAST(\n  sal\n  AS TEXT\n)"],
      ].forEach(([label, a, b], i) => sameExpr(`V54E #${i} ${label}`, a, b));

      // ============================================================
      // F. 日付・時刻の式
      // ============================================================
      [
        ['INTERVAL の数値形と文字列形', "DATE_ADD(hired, INTERVAL 1 MONTH)", "DATE_ADD(hired, INTERVAL '1 month')"],
        ['DATE_ADD と DATE_SUB', "DATE_ADD(hired, INTERVAL 7 DAY)", "DATE_SUB(hired, INTERVAL -7 DAY)"],
        ['DATE_ADD と TIMESTAMPADD', "DATE_ADD(hired, INTERVAL 2 MONTH)", "TIMESTAMPADD(MONTH, 2, hired)"],
        ['DATE_ADD と ADD_MONTHS', "DATE_ADD(hired, INTERVAL 3 MONTH)", "ADD_MONTHS(hired, 3)"],
        ['年の取り出し（4 通り）', "YEAR(hired)", "EXTRACT(YEAR FROM hired)"],
        ['年の取り出し（DATE_PART）', "YEAR(hired)", "DATE_PART('year', hired)"],
        ['年の取り出し（DATEPART）', "YEAR(hired)", "DATEPART(YEAR, hired)"],
        ['年の取り出し（yy 略記）', "YEAR(hired)", "DATEPART(yy, hired)"],
        ['日数差（DATEDIFF）', "DATEDIFF(hired, '2020-01-01')", "TIMESTAMPDIFF(DAY, '2020-01-01', hired)"],
        ['日数差（TO_DAYS）', "DATEDIFF(hired, '2020-01-01')", "TO_DAYS(hired) - TO_DAYS('2020-01-01')"],
        ['月末（LAST_DAY と EOMONTH）', "LAST_DAY(hired)", "EOMONTH(hired)"],
        ['切り捨て（DATE_TRUNC）', "DATE_TRUNC('month', ts)", "DATE_TRUNC('MONTH', ts)"],
        ['日付リテラルの書き方', "DATEDIFF(hired, DATE '2020-01-01')", "DATEDIFF(hired, '2020-01-01')"],
        ['時刻の取り出し', "HOUR(ts)", "EXTRACT(HOUR FROM ts)"],
        ['日付部分の取り出し', "DATE(ts)", "CAST(ts AS DATE)"],
      ].forEach(([label, a, b], i) => sameExpr(`V54F #${i} ${label}`, a, b));

      // ============================================================
      // G. JSON の取り出し方
      // ============================================================
      [
        // `->` は JSON テキストを返す（'1' / '"x"'）。値そのものが要るときは
        // JSON_EXTRACT か `->>` を使う — この差は下の 2 件で明示しておく
        ['JSON_UNQUOTE(JSON_EXTRACT) と ->>', "JSON_UNQUOTE(JSON_EXTRACT(js, '$.a'))", "js ->> '$.a'"],
        ['-> は空白の有無で変わらない', "js -> '$.a'", "js->'$.a'"],
        ['->> は空白の有無で変わらない', "js ->> '$.a'", "js->>'$.a'"],
        ['パスの書き方', "JSON_EXTRACT(js, '$.b')", "JSON_EXTRACT(js, '$.\"b\"')"],
        ['大小文字', "JSON_VALID(js)", "json_valid(js)"],
        ['空白と改行', "JSON_EXTRACT(js, '$.a')", "JSON_EXTRACT(\n  js,\n  '$.a'\n)"],
      ].forEach(([label, a, b], i) => sameExpr(`V54G #${i} ${label}`, a, b));

      // ============================================================
      // H. 文字列関数の別綴り
      // ============================================================
      [
        ['SUBSTRING の 3 綴り', "SUBSTRING(name, 2, 3)", "SUBSTR(name, 2, 3)"],
        ['SUBSTRING の MID 綴り', "SUBSTRING(name, 2, 3)", "MID(name, 2, 3)"],
        ['SUBSTRING の FROM FOR 綴り', "SUBSTRING(name, 2, 3)", "SUBSTRING(name FROM 2 FOR 3)"],
        ['UPPER と UCASE', "UPPER(name)", "UCASE(name)"],
        ['LOWER と LCASE', "LOWER(name)", "LCASE(name)"],
        ['TRIM の綴り', "TRIM(name)", "TRIM(BOTH ' ' FROM name)"],
        ['LTRIM と TRIM(LEADING)', "LTRIM(name)", "TRIM(LEADING ' ' FROM name)"],
        ['RTRIM と TRIM(TRAILING)', "RTRIM(name)", "TRIM(TRAILING ' ' FROM name)"],
        ['LENGTH と CHAR_LENGTH', "LENGTH(name)", "CHAR_LENGTH(name)"],
        ['INSTR と LOCATE と POSITION', "INSTR(name, 'a')", "LOCATE('a', name)"],
        ['POSITION の IN 綴り', "INSTR(name, 'a')", "POSITION('a' IN name)"],
        ['LEFT と SUBSTRING', "LEFT(name, 3)", "SUBSTRING(name, 1, 3)"],
        ['REPEAT と連結', "REPEAT('ab', 2)", "'ab' || 'ab'"],
        ['CONCAT_WS と連結', "CONCAT_WS('-', 'a', 'b')", "'a' || '-' || 'b'"],
        ['CHARINDEX と INSTR', "CHARINDEX('a', name)", "INSTR(name, 'a')"],
        // LEN は SQL Server 流で末尾の空白を数えない。LENGTH と揃えるには先に削る
        ['LEN と LENGTH（末尾空白を削れば同じ）', "LEN(RTRIM(name))", "LENGTH(RTRIM(name))"],
      ].forEach(([label, a, b], i) => sameExpr(`V54H #${i} ${label}`, a, b));

      // 同じに見えて違う綴り（仕様として記録する。val は 1 行 1 列の値を直に見る）
      val('V54H -> は JSON テキストを返す', "SELECT '{\"a\": 1}' -> '$.a' AS r", '1');
      val('V54H -> は文字列を引用符付きで返す', "SELECT '{\"s\": \"x\"}' -> '$.s' AS r", '"x"');
      val('V54H ->> は引用符を外して返す', "SELECT '{\"s\": \"x\"}' ->> '$.s' AS r", 'x');
      val('V54H JSON_EXTRACT は値そのものを返す', "SELECT JSON_EXTRACT('{\"a\": 1}', '$.a') AS r", 1);
      val('V54H LEN は末尾の空白を数えない', "SELECT LEN('  x  ') AS r", 3);
      val('V54H LENGTH は末尾の空白も数える', "SELECT LENGTH('  x  ') AS r", 5);

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v54_t');

      return T;
    }
