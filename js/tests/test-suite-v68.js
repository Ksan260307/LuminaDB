    // ============================================================================
    // [Test Suite v68] - 数値と時刻の「黙って誤る」ところ
    //
    //   A. 十進の和が合う       SUM(0.10 + 0.20) が 0.30000000000000004 だった
    //   B. 整数の桁落ちを断る   9007199254740993 が黙って ...992 で格納されていた
    //   C. IANA タイムゾーン    'Asia/Tokyo' が Unknown time zone で落ちていた
    //
    //   いずれも「間違った答えを黙って返す」類なので、直った状態を固定する。
    //
    //   test-suite.js の tests 配列へ getV68Tests() のスプレッドで合流する
    // ============================================================================
    function getV68Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup, expectNear } = makeTestKit('V68');

      // ============================================================
      // A. 十進の和
      //    二進小数では 0.1 も 0.2 も表せないので、素朴に足すと末尾がずれる。
      //    値から小数桁を読み取って整数で足す
      // ============================================================
      t('A fixture', () => {
        drop('v68_m', 'v68_i', 'v68_big');
        q("CREATE TABLE v68_m (id INT PRIMARY KEY, price DECIMAL(10,2), rate FLOAT, qty INT)");
        insertRows('v68_m', [
          [1, 0.10, 0.1, 3],
          [2, 0.20, 0.2, 4],
          [3, 1.15, 1.15, 5],
          [4, 2.05, 2.05, 6],
          [5, 0.05, 0.05, 7]
        ]);
        return db.tables['v68_m'].rowCount === 5;
      });

      t('A SUM(DECIMAL) が十進で一致する', () => {
        const d = q("SELECT SUM(price) AS s FROM v68_m").data[0];
        return eq(d.s, 3.55, 'SUM(price)');
      });

      t('A SUM = リテラル の比較が真になる', () =>
        eq(q("SELECT SUM(price) = 3.55 AS ok FROM v68_m").data[0].ok, true, '等価比較'));

      t('A 0.10 + 0.20 の和がちょうど 0.30', () => {
        const d = q("SELECT SUM(price) AS s FROM v68_m WHERE id IN (1, 2)").data[0];
        return eq(d.s, 0.3, '2 行の和');
      });

      t('A FLOAT 列でも同じように揃う', () => {
        const d = q("SELECT SUM(rate) AS s FROM v68_m WHERE id IN (1, 2)").data[0];
        return eq(d.s, 0.3, 'FLOAT の和');
      });

      t('A 同じ値を千回足しても誤差が出ない', () => {
        drop('v68_c');
        q("CREATE TABLE v68_c (id INT PRIMARY KEY, amt DECIMAL(12,2))");
        q("INSERT INTO v68_c SELECT n, 0.01 FROM GENERATE_SERIES(1, 1000) AS t(n)");
        const d = q("SELECT SUM(amt) AS s FROM v68_c").data[0];
        const okEq = q("SELECT SUM(amt) = 10.00 AS ok FROM v68_c").data[0].ok;
        q("DROP TABLE v68_c");
        return eq(d.s, 10, '1000 x 0.01') && eq(okEq, true, '= 10.00');
      });

      t('A SUM(DISTINCT) も十進で揃う', () =>
        eq(q("SELECT SUM(DISTINCT price) AS s FROM v68_m WHERE id IN (1, 2)").data[0].s, 0.3, 'DISTINCT の和'));

      t('A AVG も十進の和から出す', () =>
        eq(q("SELECT AVG(price) AS a FROM v68_m WHERE id IN (1, 2)").data[0].a, 0.15, 'AVG'));

      t('A GROUP BY ごとに揃う', () => {
        const d = q("SELECT qty % 2 AS g, SUM(price) AS s FROM v68_m GROUP BY qty % 2 ORDER BY g").data;
        // 奇数側: 0.10 + 1.15 + 0.05 = 1.30 / 偶数側: 0.20 + 2.05 = 2.25
        return eq(d.map(r => r.s), [2.25, 1.3], 'グループごとの和');
      });

      t('A 整数だけの和は従来どおり', () =>
        eq(q("SELECT SUM(qty) AS s FROM v68_m").data[0].s, 25, '整数の和'));

      t('A 負の値を混ぜても揃う', () => {
        drop('v68_n');
        q("CREATE TABLE v68_n (id INT PRIMARY KEY, v DECIMAL(10,2))");
        insertRows('v68_n', [[1, 0.30], [2, -0.10], [3, -0.20]]);
        const s = q("SELECT SUM(v) AS s FROM v68_n").data[0].s;
        q("DROP TABLE v68_n");
        return eq(s, 0, '打ち消して 0');
      });

      // 桁が深すぎる / 桁が大きすぎる場合は倍精度の素朴な和へ戻す（落ちない・止まらない）
      t('A 極小の指数表記は倍精度へ戻す', () => {
        const s = q("SELECT SUM(x) AS s FROM (SELECT 1e-13 AS x UNION ALL SELECT 2e-13) t").data[0].s;
        return expectNear(s, 3e-13, 1e-20, '極小の和');
      });

      t('A 巨大な値と小数の混在でも落ちない', () => {
        const s = q("SELECT SUM(x) AS s FROM (SELECT 9007199254740000.5 AS x UNION ALL SELECT 0.25) t").data[0].s;
        return expectNear(s, 9007199254740000.75, 2, '巨大な和');
      });

      t('A NULL は無視される', () => {
        drop('v68_z');
        q("CREATE TABLE v68_z (id INT PRIMARY KEY, v DECIMAL(10,2))");
        insertRows('v68_z', [[1, 0.10], [2, null], [3, 0.20]]);
        const r = q("SELECT SUM(v) AS s, COUNT(v) AS c, AVG(v) AS a FROM v68_z").data[0];
        q("DROP TABLE v68_z");
        return eq(r.s, 0.3, 'NULL を除いた和') && eq(r.c, 2, '件数') && eq(r.a, 0.15, '平均');
      });

      // 空集合の SUM/AVG が 0 を返すのは、このエンジンが意図して保っている仕様
      // （SQL 標準は NULL）。十進の和へ変えても、そこは動かしていないことを固定する
      t('A 空集合の SUM は 0 のまま（維持している仕様）', () =>
        eq(q("SELECT SUM(price) AS s FROM v68_m WHERE id < 0").data[0].s, 0, '空の和'));

      // --- 式の中の加減乗も十進で合う（v1.38） ---------------------------
      // SUM は桁をずらして足していたが、式の中の演算は素の倍精度のままだった
      const DEC_EXPR = [
        ['0.1 + 0.2', 0.3],
        ['0.3 - 0.1', 0.2],
        ['0.1 * 3', 0.3],
        ['0.1 * 0.2', 0.02],
        ['1.005 * 2', 2.01],
        ['0.07 * 100', 7],
        ['1.1 + 2.2', 3.3],
        ['2.675 * 2', 5.35],
        ['0.1 + 0.2 + 0.3', 0.6],
        ['100 + 200', 300],
        ['1234567890.12 + 0.01', 1234567890.13],
        ['-0.1 + -0.2', -0.3],
        ['0.1 - 0.3', -0.2]
      ];
      DEC_EXPR.forEach(([expr, want]) => {
        t(`A 式 ${expr}`, () => eq(q(`SELECT ${expr} AS r`).data[0].r, want, expr));
      });

      t('A 列どうしの計算も十進で合う', () => {
        const d = q("SELECT price * qty AS line FROM v68_m WHERE id IN (1, 2) ORDER BY id").data.map(r => r.line);
        return eq(d, [0.3, 0.8], '単価 x 数量');
      });

      t('A 等価比較が真になる', () =>
        eq(q("SELECT price * 3 = 0.30 AS ok FROM v68_m WHERE id = 1").data[0].ok, true, '式の等価比較'));

      // 丸めが効かない / 効かせてはいけない場合はそのまま返す
      t('A 除算は丸めない', () =>
        eq(q("SELECT 1 / 3 AS r").data[0].r, 1 / 3, '割り切れない値'));

      t('A 桁が深すぎる値は丸めない', () =>
        eq(q("SELECT 0.1 + 1e-15 AS r").data[0].r, 0.1 + 1e-15, '深い桁'));

      t('A 大きすぎる値は丸めない', () => {
        // 桁をずらすと正確な整数の範囲を出るので、触ると逆に壊れる
        const a = q("SELECT 1e15 - 0.5 AS r").data[0].r;
        const b = q("SELECT -1e15 + 0.5 AS r").data[0].r;
        return eq(a, 999999999999999.5, '正') && eq(b, -999999999999999.5, '負');
      });

      t('A 巨大な積は丸めない', () =>
        eq(q("SELECT 1e300 * 10 AS r").data[0].r, 1e301, '指数域'));

      // ============================================================
      // B. 整数の桁落ち
      //    2^53 を超える整数は float64 で表しきれない。丸めた値を黙って入れない
      // ============================================================
      t('B fixture', () => {
        drop('v68_i');
        q("CREATE TABLE v68_i (id INT PRIMARY KEY, b BIGINT, s TEXT)");
        insertRows('v68_i', [[1, 9007199254740991, 'max']]);
        return db.tables['v68_i'].rowCount === 1;
      });

      t('B 安全な上限はそのまま入る', () =>
        eq(q("SELECT b FROM v68_i WHERE id = 1").data[0].b, 9007199254740991, 'MAX_SAFE_INTEGER'));

      err('B 2^53 を超える整数は断る',
        "INSERT INTO v68_i VALUES (2, 9007199254740993, 'x')", 'out of exact range');

      err('B BIGINT の上限も断る',
        "INSERT INTO v68_i VALUES (3, 9223372036854775807, 'x')", 'out of exact range');

      err('B 負の側も断る',
        "INSERT INTO v68_i VALUES (4, -9007199254740993, 'x')", 'out of exact range');

      err('B 文字列で渡しても断る',
        "INSERT INTO v68_i VALUES (5, '9223372036854775807', 'x')", 'out of exact range');

      err('B UPDATE でも断る',
        "UPDATE v68_i SET b = 9223372036854775807 WHERE id = 1", 'out of exact range');

      t('B 断られた行は入っていない', () =>
        eq(q("SELECT COUNT(*) AS c FROM v68_i").data[0].c, 1, '行数は増えていない'));

      t('B 桁を保ちたいときは TEXT に入れる', () => {
        q("INSERT INTO v68_i (id, s) VALUES (9, '9223372036854775807')");
        const v = q("SELECT s FROM v68_i WHERE id = 9").data[0].s;
        return eq(v, '9223372036854775807', '一桁も落ちていない');
      });

      t('B CAST は丸めた数を返さず NULL にする', () =>
        eq(q("SELECT CAST('9223372036854775807' AS BIGINT) AS c").data[0].c, null, 'CAST の結果'));

      t('B 収まる値の CAST は従来どおり', () =>
        eq(q("SELECT CAST('9007199254740991' AS BIGINT) AS c").data[0].c, 9007199254740991, 'CAST の結果'));

      t('B FLOAT 列は桁の制限を受けない', () => {
        drop('v68_f');
        q("CREATE TABLE v68_f (id INT PRIMARY KEY, v FLOAT)");
        q("INSERT INTO v68_f VALUES (1, 1.5e300)");
        const v = q("SELECT v FROM v68_f").data[0].v;
        q("DROP TABLE v68_f");
        return expectNear(v / 1e300, 1.5, 1e-9, 'FLOAT は通す');
      });

      // ============================================================
      // C. IANA タイムゾーン
      //    夏時間があるので「その瞬間のオフセット」でなければならない
      // ============================================================
      t('C Asia/Tokyo は +9 時間', () =>
        eq(q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'Asia/Tokyo' AS z").data[0].z,
           '2026-08-26 09:00:00', '東京'));

      t('C America/New_York は冬に -5 時間', () =>
        eq(q("SELECT TIMESTAMP '2026-01-15 12:00:00' AT TIME ZONE 'America/New_York' AS z").data[0].z,
           '2026-01-15 07:00:00', 'EST'));

      t('C America/New_York は夏に -4 時間（夏時間）', () =>
        eq(q("SELECT TIMESTAMP '2026-07-15 12:00:00' AT TIME ZONE 'America/New_York' AS z").data[0].z,
           '2026-07-15 08:00:00', 'EDT'));

      t('C Europe/London は夏に +1 時間', () =>
        eq(q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'Europe/London' AS z").data[0].z,
           '2026-08-26 01:00:00', 'BST'));

      t('C Europe/London は冬に +0 時間', () =>
        eq(q("SELECT TIMESTAMP '2026-01-15 00:00:00' AT TIME ZONE 'Europe/London' AS z").data[0].z,
           '2026-01-15 00:00:00', 'GMT'));

      t('C 従来の UTC は変わらない', () =>
        eq(q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'UTC' AS z").data[0].z,
           '2026-08-26 00:00:00', 'UTC'));

      t('C 従来のオフセット指定は変わらない', () =>
        eq(q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE '+09:00' AS z").data[0].z,
           '2026-08-26 09:00:00', '+09:00'));

      t('C 従来の略称は固定値のまま', () =>
        eq(q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'JST' AS z").data[0].z,
           '2026-08-26 09:00:00', 'JST'));

      t('C CONVERT_TZ が IANA 名を取る', () =>
        eq(q("SELECT CONVERT_TZ('2026-07-15 12:00:00', 'UTC', 'America/New_York') AS z").data[0].z,
           '2026-07-15 08:00:00', 'UTC → NY（夏）'));

      t('C CONVERT_TZ は両側 IANA でもよい', () =>
        eq(q("SELECT CONVERT_TZ('2026-07-15 12:00:00', 'Asia/Tokyo', 'Europe/Paris') AS z").data[0].z,
           '2026-07-15 05:00:00', '東京 → パリ（夏）'));

      err('C 知らない地名は今も断る',
        "SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'Mars/Olympus' AS z", 'Unknown time zone');

      t('C エラー文が IANA 名を案内する', () => {
        const r = q("SELECT TIMESTAMP '2026-08-26 00:00:00' AT TIME ZONE 'Nowhere/Nothing' AS z");
        if (!r.error) throw new Error('エラーにならなかった');
        return eq(/Asia\/Tokyo/.test(r.error), true, '案内: ' + r.error);
      });

      cleanup('v68_m', 'v68_i');
      return T;
    }
