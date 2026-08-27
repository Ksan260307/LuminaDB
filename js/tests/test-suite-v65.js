    // ============================================================================
    // [Test Suite v65] - 複合キーのハッシュ結合が入れ子ループと同じ答えを返すか
    //
    //   ON が「ちょうど 1 個の a.x = b.y」でないとき、従来は例外なく入れ子ループへ
    //   落ちていた（複合主キーの結合が 30,000 x 3,000 行で 16 秒）。深さ 0 の AND で
    //   分解して等価な連言をハッシュキーに載せたので、この層は「速くなったこと」ではなく
    //   **答えが変わっていないこと**を確かめる。
    //
    //   要点: ハッシュは候補を絞る網にすぎず、拾った候補は ON 式そのもので検算される。
    //   だから「入れ子ループで書いた同じ意味の問い合わせ」と一致しなければならない。
    //   括弧で包んだ ON（`(a = b) AND (c = d)`）はキー判定の正規表現に当たらないので
    //   入れ子ループへ落ちる — これを基準の書き方として使う。
    //
    //     A. 結合種別 x ON の形（複合 2 列・3 列・等価 + 不等号・等価 + 関数）
    //     B. 型寄せ（__eq と同じ規則で一致するか: 数値らしい文字列・真偽値・日付の綴り違い）
    //     C. NULL を含むキー（等価結合に参加しない / 外部結合では行が残る）
    //     D. 多対多・重複キー・行の並び
    //     E. 計画が実際にハッシュ結合になっているか（入れ子ループへの逆戻りを検出する）
    //     F. キーに出来ない ON はハッシュへ載せない（OR・照合順序付き列）
    //
    //   test-suite.js の tests 配列へ getV65Tests() のスプレッドで合流する
    // ============================================================================
    function getV65Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V65');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      //    左 14 行 / 右 12 行。NULL・重複キー・型混在・日付の綴り違いを混ぜる
      // ------------------------------------------------------------
      t('V65 fixture', () => {
        drop('v65_l', 'v65_r', 'v65_m', 'v65_c');
        q("CREATE TABLE v65_l (id INT PRIMARY KEY, k1 INT, k2 TEXT, d TEXT, v INT)");
        q("CREATE TABLE v65_r (rid INT PRIMARY KEY, k1 INT, k2 TEXT, d TEXT, w INT)");
        insertRows('v65_l', [
          [1, 1, 'a', '2026-01-01', 10],
          [2, 1, 'a', '2026-01-01 00:00:00', 20],   // 同じキーが 2 行（多対多の左側）
          [3, 2, 'b', '2026-01-02', 30],
          [4, 3, null, '2026-01-03', 40],           // キーに NULL
          [5, null, 'c', '2026-01-04', 50],
          [6, 4, 'd', null, 60],
          [7, 5, 'e', '2026-01-05', 70],
          [8, 6, 'f', '2026-01-06', 80],            // 右に相手が居ない
          [9, 7, 'g', '2026-01-07', 90],
          [10, 2, 'b', '2026-01-02 12:34:56', 100],
          [11, 8, '9', '2026-01-08', 110],          // 数値らしい文字列
          [12, 9, 'h', '2026-01-09', 120],
          [13, 10, 'i', '2026-01-10', 130],
          [14, 2, 'z', '2026-01-02', 140]           // k1 は一致 / k2 は不一致
        ]);
        insertRows('v65_r', [
          [101, 1, 'a', '2026-01-01', 1],
          [102, 1, 'a', '2026-01-01', 2],           // 同じキーが 2 行（多対多の右側）
          [103, 2, 'b', '2026-01-02 00:00:00', 3],
          [104, 3, null, '2026-01-03', 4],
          [105, null, 'c', '2026-01-04', 5],
          [106, 4, 'd', '2026-01-04', 6],
          [107, 5, 'e', '2026-01-05', 7],
          [108, 11, 'x', '2026-01-11', 8],          // 左に相手が居ない
          [109, 7, 'g', '2026-01-07 00:00:00', 9],
          [110, 9, 'h', '2026-01-09', 10],
          [111, 10, 'i', '2026-01-10', 11],
          [112, 8, 9, '2026-01-08', 12]             // 数値（左は文字列 '9'）
        ]);
        return db.tables['v65_l'].rowCount === 14 && db.tables['v65_r'].rowCount === 12;
      });

      // ============================================================
      // A. 結合種別 x ON の形
      //    ハッシュに載る書き方と、括弧で入れ子ループへ落とした同じ意味の書き方を比べる
      // ============================================================
      const JOINS = ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN'];

      // [ラベル, ハッシュに載る ON, 同じ意味で入れ子ループへ落ちる ON]
      const ONS = [
        ['複合 2 列',
         'l.k1 = r.k1 AND l.k2 = r.k2',
         '(l.k1 = r.k1) AND (l.k2 = r.k2)'],
        ['複合 2 列（左右を入れ替えて書く）',
         'r.k1 = l.k1 AND r.k2 = l.k2',
         '(r.k1 = l.k1) AND (r.k2 = l.k2)'],
        ['複合 3 列',
         'l.k1 = r.k1 AND l.k2 = r.k2 AND l.d = r.d',
         '(l.k1 = r.k1) AND (l.k2 = r.k2) AND (l.d = r.d)'],
        ['等価 + 不等号',
         'l.k1 = r.k1 AND l.v < r.w * 100',
         '(l.k1 = r.k1) AND (l.v < r.w * 100)'],
        ['等価 + 不一致',
         'l.k1 = r.k1 AND l.k2 <> r.k2',
         '(l.k1 = r.k1) AND (l.k2 <> r.k2)'],
        ['等価 + 関数',
         'l.k1 = r.k1 AND UPPER(l.k2) = UPPER(r.k2)',
         '(l.k1 = r.k1) AND (UPPER(l.k2) = UPPER(r.k2))'],
        ['等価 + 定数条件',
         'l.k1 = r.k1 AND r.w > 2',
         '(l.k1 = r.k1) AND (r.w > 2)'],
        ['等価 + 右表内の比較',
         'l.k1 = r.k1 AND r.k1 <> r.w',
         '(l.k1 = r.k1) AND (r.k1 <> r.w)'],
        ['等価 + IS NULL',
         'l.k1 = r.k1 AND l.k2 IS NOT NULL',
         '(l.k1 = r.k1) AND (l.k2 IS NOT NULL)'],
        ['等価 + BETWEEN（AND を含む述語）',
         'l.k1 = r.k1 AND l.v BETWEEN 10 AND 90',
         '(l.k1 = r.k1) AND (l.v BETWEEN 10 AND 90)'],
        ['日付列の複合キー',
         'l.k1 = r.k1 AND l.d = r.d',
         '(l.k1 = r.k1) AND (l.d = r.d)']
      ];

      JOINS.forEach(jt => {
        ONS.forEach(([label, hashOn, loopOn]) => {
          const sel = 'SELECT l.id, r.rid FROM v65_l l ' + jt + ' v65_r r ON ';
          const tail = ' ORDER BY l.id, r.rid';
          same(`A ${jt} / ${label}`, sel + loopOn + tail, sel + hashOn + tail);
        });
      });

      // USING も内部で AND 連結の ON へ展開されるので、同じ経路に乗る
      same('A USING (k1, k2) は ON の複合キーと一致',
        'SELECT l.id, r.rid FROM v65_l l JOIN v65_r r ON (l.k1 = r.k1) AND (l.k2 = r.k2) ORDER BY l.id, r.rid',
        'SELECT v65_l.id, v65_r.rid FROM v65_l JOIN v65_r USING (k1, k2) ORDER BY id, rid');

      // 3 表以上つないでも段ごとに独立して効く
      same('A 3 表を複合キーで数珠つなぎ',
        'SELECT a.id, b.rid, c.id FROM v65_l a JOIN v65_r b ON (a.k1 = b.k1) AND (a.k2 = b.k2)'
        + ' JOIN v65_l c ON (b.k1 = c.k1) AND (b.k2 = c.k2) ORDER BY a.id, b.rid, c.id',
        'SELECT a.id, b.rid, c.id FROM v65_l a JOIN v65_r b ON a.k1 = b.k1 AND a.k2 = b.k2'
        + ' JOIN v65_l c ON b.k1 = c.k1 AND b.k2 = c.k2 ORDER BY a.id, b.rid, c.id');

      // 自己結合（同じ表を別名で 2 回）— 不等号を残余条件に回す形
      same('A 自己結合 + 不等号の残余',
        'SELECT x.id, y.id FROM v65_l x JOIN v65_l y ON (x.k1 = y.k1) AND (x.id < y.id) ORDER BY x.id, y.id',
        'SELECT x.id, y.id FROM v65_l x JOIN v65_l y ON x.k1 = y.k1 AND x.id < y.id ORDER BY x.id, y.id');

      // ============================================================
      // B. 型寄せ — キーは __eq と同じ規則で一致しなければならない
      //    ここを取り落とすと「索引の有無で答えが変わる」類の黙った差になる
      // ============================================================
      t('B fixture（型混在）', () => {
        drop('v65_m');
        q("CREATE TABLE v65_m (id INT PRIMARY KEY, a ANY, b ANY, g INT)");
        insertRows('v65_m', [
          [1, 5, '5', 1],          // 数値 と 数値らしい文字列
          [2, '7', 7, 1],
          [3, 1, true, 1],         // 1 と TRUE
          [4, 0, false, 1],
          [5, 'x', 'x', 1],        // ただの文字列どうし
          [6, '', 0, 1],           // 空文字は数値へ寄らない
          [7, 'abc', 'ABC', 1],    // 大小違いは一致しない
          [8, '2026-01-01', '2026-01-01 00:00:00', 1],  // 日付の綴り違い
          [9, '1e3', 1000, 1],     // 指数表記
          [10, ' 42 ', 42, 1],     // 前後の空白
          [11, null, null, 1]
        ]);
        return db.tables['v65_m'].rowCount === 11;
      });

      // p.a = q.b を複合キー経路（+ g の等価）で引いた結果が、入れ子ループと一致すること
      same('B 型寄せ: a = b を複合キーで',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON (p.a = r.b) AND (p.g = r.g) ORDER BY p.id, r.id',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON p.a = r.b AND p.g = r.g ORDER BY p.id, r.id');

      same('B 型寄せ: 逆向き b = a',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON (p.b = r.a) AND (p.g = r.g) ORDER BY p.id, r.id',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON p.b = r.a AND p.g = r.g ORDER BY p.id, r.id');

      same('B 型寄せ: 2 列とも型混在',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON (p.a = r.b) AND (p.b = r.a) ORDER BY p.id, r.id',
        'SELECT p.id, r.id FROM v65_m p JOIN v65_m r ON p.a = r.b AND p.b = r.a ORDER BY p.id, r.id');

      // 日付の綴り違いが確かに結合すること（'2026-01-01' と '2026-01-01 00:00:00'）。
      // UTC 解釈と現地解釈のどちらで読まれても取り落とさない、という保証の直接確認
      t('B 日付の綴り違いが複合キーでも結合する', () => {
        const r = q("SELECT COUNT(*) AS c FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.d = r.d");
        const loop = q("SELECT COUNT(*) AS c FROM v65_l l JOIN v65_r r ON (l.k1 = r.k1) AND (l.d = r.d)");
        return eq(r.data[0].c, loop.data[0].c, '日付複合キーの件数') && r.data[0].c > 0;
      });

      // ============================================================
      // C. NULL を含むキー
      // ============================================================
      t('C NULL キーは等価結合に参加しない', () => {
        // 左 id=4 は k2 が NULL、右 rid=104 も k2 が NULL。NULL = NULL は真ではない
        const d = q("SELECT l.id FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2 WHERE l.id = 4").data;
        return eq(d.length, 0, 'NULL キーの内部結合');
      });

      t('C NULL キーの行は LEFT JOIN では残る', () => {
        const d = q("SELECT l.id, r.rid FROM v65_l l LEFT JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2 WHERE l.id = 4").data;
        return eq(d.length, 1, '行数') && eq(d[0].rid, null, '右は NULL 補完');
      });

      same('C NULL 混在でも FULL OUTER が一致',
        'SELECT l.id, r.rid FROM v65_l l FULL OUTER JOIN v65_r r ON (l.k1 = r.k1) AND (l.k2 = r.k2) ORDER BY l.id, r.rid',
        'SELECT l.id, r.rid FROM v65_l l FULL OUTER JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2 ORDER BY l.id, r.rid');

      // ============================================================
      // D. 多対多・行の並び
      // ============================================================
      t('D 多対多は左右の掛け算になる', () => {
        // 左 id=1,2 が (k1,k2)=(1,'a')、右 rid=101,102 も (1,'a') → 2 x 2 = 4 行
        const d = q("SELECT l.id, r.rid FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2"
                  + " WHERE l.k1 = 1 ORDER BY l.id, r.rid").data;
        return eq(d.length, 4, '行数')
          && eq(d.map(x => [x.id, x.rid]), [[1, 101], [1, 102], [2, 101], [2, 102]], '組み合わせ');
      });

      t('D ORDER BY 無しでも右表の物理順を保つ', () => {
        // 候補キーが複数出る場合も並びが入れ子ループと変わらないこと
        const h = valsOf("SELECT l.id, r.rid FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.d = r.d");
        const n = valsOf("SELECT l.id, r.rid FROM v65_l l JOIN v65_r r ON (l.k1 = r.k1) AND (l.d = r.d)");
        return eq(h, n, '行の並び');
      });

      // ============================================================
      // E. 計画が実際にハッシュ結合になっているか
      //    （入れ子ループへ逆戻りしたら速度が 200 倍変わるので、計画そのものを見張る）
      // ============================================================
      const planOf = (sql) => q(sql).data.map(r => r.Operation);

      t('E 複合 2 列は HASH JOIN', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2")
            .includes('HASH JOIN'), true, '計画'));

      t('E 複合 3 列は HASH JOIN', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.k2 = r.k2 AND l.d = r.d")
            .includes('HASH JOIN'), true, '計画'));

      t('E 等価 + 不等号も HASH JOIN（不等号は検算へ回る）', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.v < r.w")
            .includes('HASH JOIN'), true, '計画'));

      t('E USING (k1, k2) も HASH JOIN', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l JOIN v65_r USING (k1, k2)")
            .includes('HASH JOIN'), true, '計画'));

      t('E 単一等価は従来どおり HASH JOIN', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1")
            .includes('HASH JOIN'), true, '計画'));

      t('E EXPLAIN の Details に鍵と検算条件が出る', () => {
        const d = q("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.v < r.w").data;
        const row = d.find(x => x.Operation === 'HASH JOIN');
        if (!row) throw new Error('HASH JOIN の段が無い');
        if (!/k1/.test(row.Details)) throw new Error('鍵が出ていない: ' + row.Details);
        if (!/verify/.test(row.Details)) throw new Error('検算条件が出ていない: ' + row.Details);
        return true;
      });

      // ============================================================
      // F. キーに出来ない ON はハッシュへ載せない
      // ============================================================
      t('F 深さ 0 の OR はハッシュに載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 OR l.k2 = r.k2")
            .includes('NESTED LOOP JOIN'), true, '計画'));

      t('F 等価が 1 つも無ければ入れ子ループ', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON l.v < r.w AND l.k1 > r.k1")
            .includes('NESTED LOOP JOIN'), true, '計画'));

      t('F 右表内の等価だけならキーにならない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v65_l l JOIN v65_r r ON r.k1 = r.w AND l.v < r.w")
            .includes('NESTED LOOP JOIN'), true, '計画'));

      // 照合順序付きの列は生値では一致を拾えないので、その連言はキーにしない。
      // 答えは照合順序どおりでなければならない（速さより正しさを採る）
      t('F fixture（照合順序付き）', () => {
        drop('v65_c');
        q("CREATE TABLE v65_c (id INT PRIMARY KEY, n TEXT COLLATE NOCASE, g INT)");
        insertRows('v65_c', [[1, 'Alice', 1], [2, 'alice', 1], [3, 'BOB', 1], [4, 'bob', 1]]);
        return db.tables['v65_c'].rowCount === 4;
      });

      same('F COLLATE NOCASE 付きの複合キーでも答えは照合順序どおり',
        'SELECT a.id, b.id FROM v65_c a JOIN v65_c b ON (a.n = b.n) AND (a.g = b.g) ORDER BY a.id, b.id',
        'SELECT a.id, b.id FROM v65_c a JOIN v65_c b ON a.n = b.n AND a.g = b.g ORDER BY a.id, b.id');

      t('F COLLATE 付きの列は大小を無視して結合する（4 行 x 2 = 8 組）', () => {
        const d = q("SELECT a.id, b.id FROM v65_c a JOIN v65_c b ON a.n = b.n AND a.g = b.g").data;
        return eq(d.length, 8, '照合順序を効かせた組み合わせ数');
      });

      // 存在しない列は、単一等価のときと同じようにエラーにする
      err('F 存在しない列を複合キーに書いたらエラー',
        "SELECT * FROM v65_l l JOIN v65_r r ON l.k1 = r.k1 AND l.nope = r.k2", 'nope');

      cleanup('v65_l', 'v65_r', 'v65_m', 'v65_c');
      return T;
    }
