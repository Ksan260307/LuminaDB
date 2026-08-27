    // ============================================================================
    // [Test Suite v66] - WHERE に連言があるときの索引選択
    //
    //   索引経路の判定は WHERE 全体に先頭末尾を固定した正規表現だったので、
    //   `WHERE id = 4242 AND g = 42` のように主キー 1 本で 1 行に絞れる問い合わせが
    //   20 万行を舐めていた（実測 23.9ms → 2.3ms）。
    //
    //   この層が見張るのは 2 点:
    //     1. 索引を使ったせいで答えが変わっていないこと。索引は候補を絞る網としてだけ
    //        使い、WHERE は元の形のまま候補に対して評価する（residualWhere を残す）。
    //        括弧で包んだ WHERE（`(id = 1) AND (g = 10)`）は判定の正規表現に当たらず
    //        全表走査へ落ちるので、これを基準の書き方として使う。
    //     2. 実際に索引が選ばれていること（全表走査への逆戻りを検出する）。
    //
    //     A. 索引経路と全表走査経路が同じ答えを返す
    //     B. どの索引が選ばれるか（主キー / UNIQUE 優先、次に相異なりキー数）
    //     C. 型寄せ（BOOLEAN 列への `ok = 1`、INTEGER 列への文字列）
    //     D. NULL と三値論理
    //     E. 索引に載せない WHERE（OR・式・列同士の比較・照合順序付き）
    //     F. 索引を張った後・消した後で答えが変わらない
    //     G. 綴りだけが違う値（' 2 ' と 2 / '2026-01-01' と '2026-01-01 00:00:00'）でも
    //        索引の有無で答えが変わらない。索引の鍵は比較（__eq）と同じ同値類で張る
    //
    //   test-suite.js の tests 配列へ getV66Tests() のスプレッドで合流する
    // ============================================================================
    function getV66Tests() {
      const { T, q, t, err, same, valsOf, eq, lit, insertRows, drop, cleanup } = makeTestKit('V66');

      // ------------------------------------------------------------
      // 0. フィクスチャ（60 行。g は 6 通り・k は 20 通り・NULL とゼロを混ぜる）
      // ------------------------------------------------------------
      const ROWS = [];
      for (let i = 1; i <= 60; i++) {
        ROWS.push([
          i,                                  // id (PK)
          i % 6,                              // g  … 粗い索引
          i % 20,                             // k  … 細かい索引
          (i % 7 === 0) ? null : 's' + (i % 9),
          (i % 2 === 0),                      // ok BOOLEAN
          (i % 5 === 0) ? 0 : i * 3
        ]);
      }
      t('V66 fixture', () => {
        drop('v66_t', 'v66_c');
        q("CREATE TABLE v66_t (id INT PRIMARY KEY, g INT, k INT, s TEXT, ok BOOLEAN, v INT)");
        insertRows('v66_t', ROWS);
        q("CREATE INDEX v66_ix_g ON v66_t(g)");
        q("CREATE INDEX v66_ix_k ON v66_t(k)");
        q("CREATE INDEX v66_ix_s ON v66_t(s)");
        q("CREATE INDEX v66_ix_ok ON v66_t(ok)");
        return db.tables['v66_t'].rowCount === 60;
      });

      // ============================================================
      // A. 索引経路と全表走査経路が同じ答えを返す
      //    括弧を付けるだけで経路が変わり、答えは変わらない——が守るべき性質
      // ============================================================
      // [ラベル, 索引に載る WHERE, 括弧で全表走査へ落とした同じ意味の WHERE]
      const WHERES = [
        ['主キー + 別の等価',      'id = 42 AND g = 0',          '(id = 42) AND (g = 0)'],
        ['主キー + 不一致',        'id = 42 AND g = 5',          '(id = 42) AND (g = 5)'],
        ['粗い索引 + 文字列等価',  'g = 2 AND s = \'s2\'',       '(g = 2) AND (s = \'s2\')'],
        ['細かい索引 + 範囲',      'k = 3 AND v > 50',           '(k = 3) AND (v > 50)'],
        ['索引 + LIKE',            'g = 1 AND s LIKE \'s%\'',    '(g = 1) AND (s LIKE \'s%\')'],
        ['索引 + IS NULL',         'g = 1 AND s IS NULL',        '(g = 1) AND (s IS NULL)'],
        ['索引 + IS NOT NULL',     'g = 1 AND s IS NOT NULL',    '(g = 1) AND (s IS NOT NULL)'],
        ['3 つの連言',             'g = 2 AND v > 20 AND id < 50', '(g = 2) AND (v > 20) AND (id < 50)'],
        ['索引 + BETWEEN',         'g = 3 AND v BETWEEN 10 AND 100', '(g = 3) AND (v BETWEEN 10 AND 100)'],
        ['索引 + IN',              'g = 3 AND id IN (3, 9, 15, 21)', '(g = 3) AND (id IN (3, 9, 15, 21))'],
        ['索引 + 内側の OR',       'g = 4 AND (id < 10 OR id > 50)', '(g = 4) AND (id < 10 OR id > 50)'],
        ['索引 2 つが候補',        'g = 2 AND k = 8',            '(g = 2) AND (k = 8)'],
        ['BOOLEAN の等価',         'ok = TRUE AND g = 2',        '(ok = TRUE) AND (g = 2)'],
        ['ゼロ という値',          'v = 0 AND g = 3',            '(v = 0) AND (g = 3)'],
        ['一致が 0 件',            'g = 2 AND v = 999999',       '(g = 2) AND (v = 999999)'],
        ['NULL 等価は真にならない', 's = NULL AND g = 1',        '(s = NULL) AND (g = 1)']
      ];

      WHERES.forEach(([label, idx, scan]) => {
        same(`A ${label}`,
          `SELECT id, g, k, s, v FROM v66_t WHERE ${scan} ORDER BY id`,
          `SELECT id, g, k, s, v FROM v66_t WHERE ${idx} ORDER BY id`);
      });

      // 索引経路でも集計・並べ替え・LIMIT が正しく効くこと
      same('A 索引経路 + 集計',
        'SELECT COUNT(*), SUM(v) FROM v66_t WHERE (g = 2) AND (v > 10)',
        'SELECT COUNT(*), SUM(v) FROM v66_t WHERE g = 2 AND v > 10');
      same('A 索引経路 + GROUP BY',
        'SELECT k, COUNT(*) FROM v66_t WHERE (g = 2) AND (v > 0) GROUP BY k ORDER BY k',
        'SELECT k, COUNT(*) FROM v66_t WHERE g = 2 AND v > 0 GROUP BY k ORDER BY k');
      same('A 索引経路 + ORDER BY / LIMIT',
        'SELECT id FROM v66_t WHERE (g = 2) AND (v > 0) ORDER BY v DESC LIMIT 3',
        'SELECT id FROM v66_t WHERE g = 2 AND v > 0 ORDER BY v DESC LIMIT 3');
      same('A 索引経路 + 結合',
        'SELECT a.id, b.id FROM v66_t a JOIN v66_t b ON a.k = b.k WHERE (a.g = 2) AND (a.v > 20) ORDER BY a.id, b.id',
        'SELECT a.id, b.id FROM v66_t a JOIN v66_t b ON a.k = b.k WHERE a.g = 2 AND a.v > 20 ORDER BY a.id, b.id');
      same('A 索引経路 + DELETE 相当の副問い合わせ',
        'SELECT id FROM v66_t WHERE id IN (SELECT id FROM v66_t WHERE (g = 2) AND (v > 30)) ORDER BY id',
        'SELECT id FROM v66_t WHERE id IN (SELECT id FROM v66_t WHERE g = 2 AND v > 30) ORDER BY id');
      // 表別名で修飾した列でも索引に載る
      same('A 別名で修飾した列',
        'SELECT x.id FROM v66_t x WHERE (x.g = 2) AND (x.v > 20) ORDER BY x.id',
        'SELECT x.id FROM v66_t x WHERE x.g = 2 AND x.v > 20 ORDER BY x.id');

      // ============================================================
      // B. どの索引が選ばれるか
      // ============================================================
      const planOf = (sql) => q(sql).data.map(r => r.Operation);
      const detailOf = (sql, op) => {
        const row = q(sql).data.find(r => r.Operation === op);
        return row ? row.Details : null;
      };

      t('B 連言があっても索引を使う', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE id = 42 AND g = 0").includes('INDEX SCAN'), true, '計画'));

      t('B 主キーを優先する（粗い索引より）', () => {
        const d = detailOf("EXPLAIN SELECT * FROM v66_t WHERE id = 42 AND g = 0", 'INDEX SCAN');
        if (!d) throw new Error('INDEX SCAN の段が無い');
        return eq(/\(id\)/.test(d), true, '選ばれた索引: ' + d);
      });

      t('B 主キーが無ければ相異なりキー数の多い方を選ぶ', () => {
        // k は 20 通り / g は 6 通り → k の方が細かい
        const d = detailOf("EXPLAIN SELECT * FROM v66_t WHERE g = 2 AND k = 8", 'INDEX SCAN');
        if (!d) throw new Error('INDEX SCAN の段が無い');
        return eq(/\(k\)/.test(d), true, '選ばれた索引: ' + d);
      });

      t('B 索引の無い列の等価は経路にしない', () => {
        // v には索引が無いので、索引に載るのは g の方
        const d = detailOf("EXPLAIN SELECT * FROM v66_t WHERE v = 9 AND g = 3", 'INDEX SCAN');
        if (!d) throw new Error('INDEX SCAN の段が無い');
        return eq(/\(g\)/.test(d), true, '選ばれた索引: ' + d);
      });

      t('B WHERE は捨てずに検算へ回す', () => {
        // FILTER の段が残っていること（索引で引いた等価も含めて再評価される）
        const ops = planOf("EXPLAIN SELECT * FROM v66_t WHERE id = 42 AND g = 0");
        return eq(ops.includes('FILTER'), true, '計画: ' + ops.join(' / '));
      });

      // ============================================================
      // C. 型寄せ — 宣言型どおりの綴りで引く（綴りが違う場合は G 章）
      // ============================================================
      same('C BOOLEAN 列へ 1 で引く',
        "SELECT id FROM v66_t WHERE (ok = 1) AND (g = 2) ORDER BY id",
        "SELECT id FROM v66_t WHERE ok = 1 AND g = 2 ORDER BY id");
      same('C BOOLEAN 列へ 0 で引く',
        "SELECT id FROM v66_t WHERE (ok = 0) AND (g = 2) ORDER BY id",
        "SELECT id FROM v66_t WHERE ok = 0 AND g = 2 ORDER BY id");
      same('C BOOLEAN 列へ TRUE で引く',
        "SELECT id FROM v66_t WHERE (ok = TRUE) AND (g = 2) ORDER BY id",
        "SELECT id FROM v66_t WHERE ok = TRUE AND g = 2 ORDER BY id");
      same('C INTEGER 列へ数値らしい文字列で引く',
        "SELECT id FROM v66_t WHERE (g = '2') AND (v > 20) ORDER BY id",
        "SELECT id FROM v66_t WHERE g = '2' AND v > 20 ORDER BY id");
      same('C TEXT 列へ数値で引く',
        "SELECT id FROM v66_t WHERE (s = 2) AND (g = 2) ORDER BY id",
        "SELECT id FROM v66_t WHERE s = 2 AND g = 2 ORDER BY id");

      // ============================================================
      // D. NULL と三値論理
      // ============================================================
      t('D = NULL は 1 行も返さない', () =>
        eq(q("SELECT id FROM v66_t WHERE s = NULL AND g = 1").data.length, 0, '件数'));

      same('D IS NULL は索引経路でも拾える',
        "SELECT id FROM v66_t WHERE (g = 1) AND (s IS NULL) ORDER BY id",
        "SELECT id FROM v66_t WHERE g = 1 AND s IS NULL ORDER BY id");

      same('D NOT で包んでも一致する',
        "SELECT id FROM v66_t WHERE (g = 1) AND NOT (v > 100) ORDER BY id",
        "SELECT id FROM v66_t WHERE g = 1 AND NOT (v > 100) ORDER BY id");

      // ============================================================
      // E. 索引に載せない WHERE
      // ============================================================
      t('E 深さ 0 の OR は索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE id = 1 OR id = 2").includes('TABLE SCAN'), true, '計画'));

      t('E 列同士の比較は索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE g = k AND v > 10").includes('TABLE SCAN'), true, '計画'));

      t('E 右辺が式なら索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE g = 1 + 1 AND v > 10").includes('TABLE SCAN'), true, '計画'));

      t('E 右辺が関数なら索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE s = UPPER('s2') AND v > 10").includes('TABLE SCAN'), true, '計画'));

      t('E 左辺が式なら索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_t WHERE g + 0 = 1 AND v > 10").includes('TABLE SCAN'), true, '計画'));

      // 照合順序付きの列は索引が生値で作られているので載せない（答えは照合順序どおり）
      t('E fixture（照合順序付き）', () => {
        drop('v66_c');
        q("CREATE TABLE v66_c (id INT PRIMARY KEY, n TEXT COLLATE NOCASE, g INT)");
        insertRows('v66_c', [[1, 'Alice', 1], [2, 'alice', 1], [3, 'BOB', 2], [4, 'bob', 2]]);
        q("CREATE INDEX v66_ix_n ON v66_c(n)");
        return db.tables['v66_c'].rowCount === 4;
      });

      t('E COLLATE NOCASE の列は索引経路にしない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v66_c WHERE n = 'ALICE' AND g = 1").includes('TABLE SCAN'), true, '計画'));

      t('E COLLATE NOCASE は大小を無視して 2 行拾う', () => {
        const d = q("SELECT id FROM v66_c WHERE n = 'ALICE' AND g = 1").data;
        return eq(d.map(x => x.id), [1, 2], '照合順序どおりの一致');
      });

      // ============================================================
      // F. 索引を張った / 消した で答えが変わらない
      //    （索引の有無で結果が動くのが、この手の最適化でいちばん怖い壊れ方）
      // ============================================================
      const PROBES = [
        "SELECT id FROM v66_t WHERE g = 2 AND v > 20 ORDER BY id",
        "SELECT id FROM v66_t WHERE k = 8 AND s IS NOT NULL ORDER BY id",
        "SELECT COUNT(*) FROM v66_t WHERE ok = 1 AND g = 2",
        "SELECT id FROM v66_t WHERE s = 's2' AND v > 30 ORDER BY id",
        "SELECT id FROM v66_t WHERE g = '2' AND k = 8 ORDER BY id"
      ];
      t('F 索引を消しても答えが変わらない', () => {
        const withIdx = PROBES.map(valsOf);
        q("DROP INDEX v66_ix_g");
        q("DROP INDEX v66_ix_k");
        q("DROP INDEX v66_ix_s");
        q("DROP INDEX v66_ix_ok");
        const without = PROBES.map(valsOf);
        // 張り直して後続に影響を残さない
        q("CREATE INDEX v66_ix_g ON v66_t(g)");
        q("CREATE INDEX v66_ix_k ON v66_t(k)");
        q("CREATE INDEX v66_ix_s ON v66_t(s)");
        q("CREATE INDEX v66_ix_ok ON v66_t(ok)");
        for (let i = 0; i < PROBES.length; i++) {
          if (withIdx[i] !== without[i]) {
            throw new Error('索引の有無で答えが変わった :: ' + PROBES[i]
              + ' :: with=' + withIdx[i].slice(0, 120) + ' without=' + without[i].slice(0, 120));
          }
        }
        return true;
      });

      t('F 更新した行が索引経路でも見える', () => {
        q("UPDATE v66_t SET g = 2 WHERE id = 59");
        const a = valsOf("SELECT id FROM v66_t WHERE g = 2 AND id > 55 ORDER BY id");
        const b = valsOf("SELECT id FROM v66_t WHERE (g = 2) AND (id > 55) ORDER BY id");
        q("UPDATE v66_t SET g = 59 % 6 WHERE id = 59");
        return eq(a, b, 'UPDATE 後の索引経路');
      });

      t('F 削除した行が索引経路から消える', () => {
        q("DELETE FROM v66_t WHERE id = 60");
        const a = valsOf("SELECT id FROM v66_t WHERE g = 0 AND id > 50 ORDER BY id");
        const b = valsOf("SELECT id FROM v66_t WHERE (g = 0) AND (id > 50) ORDER BY id");
        insertRows('v66_t', [ROWS[59]]);
        return eq(a, b, 'DELETE 後の索引経路');
      });

      // ============================================================
      // G. 綴りだけが違う値 — 索引の鍵は比較（__eq）と同じ同値類で張る
      //
      //    索引が生値を鍵にしていた頃、型寄せの効く値は索引の有無で答えが変わった:
      //      ' 2 ' の入った列に `= 2` … 索引ありで 0 件 / 索引なしで 1 件
      //      '2026-01-01' の入った列に `= '2026-01-01 00:00:00'` … 同上
      //    C 章は「宣言型どおりの綴り」しか見ておらず、ここが抜けていた。
      //
      //    見張るのは 3 点:
      //      1. 索引の有無で答えが変わらないこと（綴り違いを含めて）
      //      2. 結合も同じであること（単一等価のハッシュ結合は右表の索引を借りる）
      //      3. Table.valueEq が SQL の `=` とずれていないこと。索引で拾った候補は
      //         これで検算するので、ずれると 1. が静かに壊れる
      // ============================================================
      // [値, その値が入る行の id]。綴りだけが違うもの・数値にも日付にも読めるものを混ぜる
      const XS = [' 2 ', '2', '02', '2.0', ' 2', '2 ', '0', '', 'abc', 'true', '2026-01-01',
                  '2026-01-01 00:00:00', '2026-01-01T00:00:00Z', '2026-01-02', '2026-01-01 12:00:00'];
      const XROWS = XS.map((s, i) => [i + 1, s, (i % 3) - 1, (i % 2 === 0)]);

      t('G fixture', () => {
        drop('v66_x', 'v66_y');
        q("CREATE TABLE v66_x (id INT PRIMARY KEY, s TEXT, n INT, b BOOLEAN)");
        insertRows('v66_x', XROWS);
        // 結合の右辺。左の s（TEXT）と数として一致する行を持たせる
        q("CREATE TABLE v66_y (yid INT PRIMARY KEY, k TEXT)");
        insertRows('v66_y', [[1, '2'], [2, ' 2 '], [3, '0'], [4, 'abc'], [5, '2026-01-01 00:00:00']]);
        return db.tables['v66_x'].rowCount === XS.length && db.tables['v66_y'].rowCount === 5;
      });

      // 索引を張った状態と外した状態で、同じ問い合わせが同じ答えを返すこと
      const G_INDEXED = ["CREATE INDEX v66_ix_xs ON v66_x(s)", "CREATE INDEX v66_ix_xn ON v66_x(n)",
                         "CREATE INDEX v66_ix_xb ON v66_x(b)", "CREATE INDEX v66_ix_yk ON v66_y(k)"];
      const G_DROP = ["DROP INDEX v66_ix_xs", "DROP INDEX v66_ix_xn",
                      "DROP INDEX v66_ix_xb", "DROP INDEX v66_ix_yk"];
      // 索引の有無で答えが変わらないことを確かめる（張って測り、外して測り、張り直す）
      const bothWays = (label, sqls) => t(`G ${label} 索引の有無で同じ`, () => {
        G_INDEXED.forEach(q);
        const withIdx = sqls.map(valsOf);
        G_DROP.forEach(q);
        const without = sqls.map(valsOf);
        G_INDEXED.forEach(q);                       // 後続のために張り直す
        for (let i = 0; i < sqls.length; i++) {
          if (withIdx[i] !== without[i]) {
            throw new Error('索引の有無で答えが変わった :: ' + sqls[i]
              + ' :: with=' + withIdx[i].slice(0, 160) + ' without=' + without[i].slice(0, 160));
          }
        }
        return true;
      });

      bothWays('綴り違いの数値', [
        "SELECT id FROM v66_x WHERE s = 2 ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = ' 2 ' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = 2.0 ORDER BY id",
        "SELECT id FROM v66_x WHERE s = 0 ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = 'abc' ORDER BY id"
      ]);
      bothWays('綴り違いの日付', [
        "SELECT id FROM v66_x WHERE s = '2026-01-01' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2026-01-01 00:00:00' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2026-01-01T00:00:00Z' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2026-01-01 12:00:00' ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2026-01-02' ORDER BY id"
      ]);
      bothWays('真偽と数の混在', [
        "SELECT id FROM v66_x WHERE b = 1 ORDER BY id",
        "SELECT id FROM v66_x WHERE b = 0 ORDER BY id",
        "SELECT id FROM v66_x WHERE b = TRUE ORDER BY id",
        "SELECT id FROM v66_x WHERE b = 'true' ORDER BY id",
        "SELECT id FROM v66_x WHERE n = '1' ORDER BY id",
        "SELECT id FROM v66_x WHERE n = -1 ORDER BY id",
        "SELECT id FROM v66_x WHERE n = 0 ORDER BY id"
      ]);
      bothWays('IN と連言', [
        "SELECT id FROM v66_x WHERE s IN ('2', ' 2 ') ORDER BY id",
        "SELECT id FROM v66_x WHERE s IN (2, 0) ORDER BY id",
        "SELECT id FROM v66_x WHERE s = 2 AND n = 1 ORDER BY id",
        "SELECT id FROM v66_x WHERE s = '2026-01-01' AND id > 0 ORDER BY id"
      ]);
      // 単一等価のハッシュ結合は右表の索引を組み上がりのハッシュ表として借りるので、
      // 鍵の張り方が比較とずれていると結合だけが取り落とす
      bothWays('結合', [
        "SELECT x.id, y.yid FROM v66_x x JOIN v66_y y ON x.s = y.k ORDER BY x.id, y.yid",
        "SELECT x.id, y.yid FROM v66_x x LEFT JOIN v66_y y ON x.s = y.k ORDER BY x.id, y.yid",
        "SELECT x.id, y.yid FROM v66_x x RIGHT JOIN v66_y y ON x.s = y.k ORDER BY x.id, y.yid",
        "SELECT x.id, y.yid FROM v66_x x JOIN v66_y y ON x.s = y.k AND x.id > 1 ORDER BY x.id, y.yid",
        "SELECT COUNT(*) FROM v66_x x JOIN v66_y y ON x.s = y.k"
      ]);
      bothWays('副問い合わせ', [
        "SELECT id FROM v66_x WHERE EXISTS (SELECT 1 FROM v66_y y WHERE y.k = v66_x.s) ORDER BY id",
        "SELECT id FROM v66_x WHERE s IN (SELECT k FROM v66_y) ORDER BY id"
      ]);

      // 索引で拾った候補の検算に使う Table.valueEq が、SQL の `=` とずれていないこと。
      // ここがずれると「索引の有無で答えが変わる」に静かに戻るので、
      // 格納値 x 引く値の総当たりで突き合わせる
      t('G valueEq が SQL の = と一致する（総当たり）', () => {
        const PROBES = [2, 0, 1, -1, 2.0, true, false, '2', ' 2 ', '02', '2.0', '0', '', 'abc',
                        'true', '2026-01-01', '2026-01-01 00:00:00', '2026-01-01T00:00:00Z',
                        '2026-01-02', '2026-01-01 12:00:00'];
        const bad = [];
        PROBES.forEach(p => {
          // 括弧で包むと索引経路に載らない（= 全表走査の答え）
          const scan = valsOf(`SELECT id FROM v66_x WHERE (s = ${lit(p)}) ORDER BY id`);
          const want = JSON.stringify(XROWS.filter(r => Table.valueEq(r[1], p)).map(r => [r[0]]));
          if (scan !== want) bad.push(`${lit(p)}: SQL=${scan} valueEq=${want}`);
        });
        if (bad.length) throw new Error('valueEq が SQL の = とずれている :: ' + bad.join(' / '));
        return true;
      });

      // 索引の鍵は同値類なので '2' と ' 2 ' が同じバケットに同居する。
      // 制約の判定はあくまで生値の一致で、そこは寄せない
      t('G UNIQUE は綴りが違えば別の値のまま', () => {
        drop('v66_u');
        q("CREATE TABLE v66_u (v TEXT UNIQUE)");
        const ok1 = q("INSERT INTO v66_u VALUES ('2')");
        const ok2 = q("INSERT INTO v66_u VALUES (' 2 ')");     // 同じバケットだが別の値
        const ng  = q("INSERT INTO v66_u VALUES ('2')");        // これは重複
        drop('v66_u');
        return eq([!ok1.error, !ok2.error, /UNIQUE/i.test(ng.error || '')], [true, true, true], 'UNIQUE の判定');
      });

      // 索引を張ったあとの更新・削除でも同値類が保たれること（差分更新の取りこぼし検出）
      t('G 更新と削除のあとも索引の有無で同じ', () => {
        G_INDEXED.forEach(q);
        q("UPDATE v66_x SET s = ' 2 ' WHERE id = 9");           // 'abc' -> ' 2 '
        q("DELETE FROM v66_x WHERE id = 3");                    // '02' の行を消す
        const probe = "SELECT id FROM v66_x WHERE s = 2 ORDER BY id";
        const withIdx = valsOf(probe);
        G_DROP.forEach(q);
        const without = valsOf(probe);
        // 元へ戻す
        q("UPDATE v66_x SET s = 'abc' WHERE id = 9");
        insertRows('v66_x', [XROWS[2]]);
        return eq(withIdx, without, 'UPDATE / DELETE 後の同値類');
      });

      cleanup('v66_t', 'v66_c', 'v66_x', 'v66_y');
      return T;
    }
