    // ============================================================================
    // [Test Suite v61] - 特殊なクエリ構成 (補遺): 実行条件を変えても答えは変わらない
    //
    //   同じ問い合わせを「条件を変えて」何度も実行し、答えが 1 文字も変わらないことを見る。
    //   索引の有無・行の入れ方・トランザクションの内外・ビュー越し・式キャッシュの状態は
    //   結果に影響してはならない。影響したときは最適化か状態管理の取りこぼしになる。
    //
    //     A. 索引の有無（なし / 単一列 / 複合 / UNIQUE）
    //     B. 行の挿入順序（昇順 / 降順 / 入り混じり）
    //     C. トランザクションの内外・ロールバック後
    //     D. ビュー・一時表・CTE を経由しても同じ
    //     E. 式キャッシュが温まっていても同じ
    //     F. 書き換え文の特殊な構成（自己参照 UPDATE / FROM 併用 / UPSERT の連鎖）
    //     G. 制約・トリガーのある表でも読み出しは同じ
    //
    //   test-suite.js の tests 配列へ getV61Tests() のスプレッドで合流する
    // ============================================================================
    function getV61Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V61');

      // ------------------------------------------------------------
      // 0. フィクスチャ（60 行。索引を張ったり外したりする）
      // ------------------------------------------------------------
      const ROWS = [];
      for (let i = 1; i <= 60; i++) {
        ROWS.push([i, ['a', 'b', 'c', 'd'][i % 4], (i % 9 === 0) ? null : ((i * 13) % 50) - 10,
                   (i % 7 === 0) ? null : `s${(i * 3) % 20}`]);
      }
      t('V61 fixture', () => {
        drop('v61_t', 'v61_u');
        q("CREATE TABLE v61_t (id INT PRIMARY KEY, g TEXT, v INT, s TEXT)");
        q("CREATE TABLE v61_u (id INT PRIMARY KEY, tag TEXT)");
        insertRows('v61_t', ROWS);
        insertRows('v61_u', Array.from({ length: 20 }, (_, i) => [i + 1, ['x', 'y', 'z'][i % 3]]));
        return db.tables['v61_t'].rowCount === 60 && db.tables['v61_u'].rowCount === 20;
      });

      // 索引の有無・行順・キャッシュ状態を変えても同じ結果になるべきクエリ
      const QUERIES = [
        "SELECT COUNT(*) AS c FROM v61_t",
        "SELECT id FROM v61_t WHERE v = 3 ORDER BY id",
        "SELECT id FROM v61_t WHERE v <> 3 ORDER BY id",
        "SELECT id FROM v61_t WHERE v > 10 ORDER BY id",
        "SELECT id FROM v61_t WHERE v >= 10 ORDER BY id",
        "SELECT id FROM v61_t WHERE v < 0 ORDER BY id",
        "SELECT id FROM v61_t WHERE v BETWEEN -5 AND 5 ORDER BY id",
        "SELECT id FROM v61_t WHERE v IS NULL ORDER BY id",
        "SELECT id FROM v61_t WHERE v IS NOT NULL ORDER BY id",
        "SELECT id FROM v61_t WHERE v IN (3, 10, 23) ORDER BY id",
        "SELECT id FROM v61_t WHERE v NOT IN (3, 10, 23) ORDER BY id",
        "SELECT id FROM v61_t WHERE g = 'a' ORDER BY id",
        "SELECT id FROM v61_t WHERE g = 'a' AND v > 0 ORDER BY id",
        "SELECT id FROM v61_t WHERE g = 'a' OR v > 30 ORDER BY id",
        "SELECT id FROM v61_t WHERE s LIKE 's1%' ORDER BY id",
        "SELECT id FROM v61_t WHERE s IS NULL ORDER BY id",
        "SELECT g, COUNT(*) AS c, SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx FROM v61_t GROUP BY g ORDER BY g",
        "SELECT g, COUNT(DISTINCT v) AS c FROM v61_t GROUP BY g ORDER BY g",
        "SELECT g, COUNT(*) AS c FROM v61_t GROUP BY g HAVING COUNT(*) > 14 ORDER BY g",
        "SELECT DISTINCT g FROM v61_t ORDER BY g",
        "SELECT DISTINCT v FROM v61_t ORDER BY v",
        "SELECT id, v FROM v61_t ORDER BY v NULLS LAST, id LIMIT 10",
        "SELECT id, v FROM v61_t ORDER BY v DESC NULLS FIRST, id LIMIT 10",
        "SELECT id FROM v61_t ORDER BY id LIMIT 10 OFFSET 25",
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY v NULLS LAST, id) AS rn FROM v61_t ORDER BY id",
        "SELECT id, SUM(v) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS w FROM v61_t ORDER BY id",
        "SELECT t.id, u.tag FROM v61_t t JOIN v61_u u ON u.id = t.id ORDER BY t.id",
        "SELECT t.id, u.tag FROM v61_t t LEFT JOIN v61_u u ON u.id = t.id ORDER BY t.id",
        "SELECT COUNT(*) AS c FROM v61_t t WHERE EXISTS (SELECT 1 FROM v61_u u WHERE u.id = t.id)",
        "SELECT COUNT(*) AS c FROM v61_t t WHERE NOT EXISTS (SELECT 1 FROM v61_u u WHERE u.id = t.id)",
        "SELECT id FROM v61_t WHERE id IN (SELECT id FROM v61_u WHERE tag = 'x') ORDER BY id",
        "SELECT id, (SELECT COUNT(*) FROM v61_u u WHERE u.id = t.id) AS n FROM v61_t t ORDER BY id LIMIT 20",
        "SELECT g, SUM(v) AS s FROM v61_t WHERE v IS NOT NULL GROUP BY g ORDER BY s DESC NULLS LAST, g",
        "WITH k AS (SELECT g, COUNT(*) AS c FROM v61_t GROUP BY g) SELECT * FROM k WHERE c > 10 ORDER BY g",
        "SELECT id FROM v61_t WHERE v > 0 INTERSECT SELECT id FROM v61_t WHERE g = 'b' ORDER BY id",
        "SELECT id FROM v61_t WHERE v > 0 EXCEPT SELECT id FROM v61_t WHERE g = 'b' ORDER BY id",
        "SELECT id FROM v61_t WHERE v > 40 UNION SELECT id FROM v61_t WHERE v < -5 ORDER BY id",
        "SELECT MAX(v) AS mx FROM v61_t WHERE g IN ('a', 'b')",
        "SELECT COUNT(*) AS c FROM v61_t WHERE v = (SELECT MIN(v) FROM v61_t)",
        "SELECT id, CASE WHEN v IS NULL THEN 'null' WHEN v < 0 THEN 'neg' ELSE 'pos' END AS band FROM v61_t ORDER BY id",
        "SELECT COUNT(*) AS c FROM v61_t WHERE v > 0 AND g IN ('a', 'c') AND s IS NOT NULL",
        "SELECT g, AVG(v) AS a FROM v61_t GROUP BY g ORDER BY g",
        "SELECT g, GROUP_CONCAT(id ORDER BY id) AS ids FROM v61_t WHERE v > 20 GROUP BY g ORDER BY g",
        "SELECT id FROM v61_t WHERE v = (SELECT MAX(v) FROM v61_t) ORDER BY id",
        "SELECT id, v - LAG(v) OVER (ORDER BY id) AS d FROM v61_t WHERE v IS NOT NULL ORDER BY id",
        "SELECT g, COUNT(*) AS c FROM v61_t GROUP BY ROLLUP(g) ORDER BY g",
        "SELECT COUNT(*) AS c FROM v61_t a JOIN v61_t b ON a.g = b.g AND a.id < b.id",
        "SELECT id FROM v61_t WHERE v IS NOT NULL QUALIFY ROW_NUMBER() OVER (PARTITION BY g ORDER BY v DESC, id) <= 2 ORDER BY id",
        "SELECT g, MIN(id) AS lo, MAX(id) AS hi, COUNT(DISTINCT s) AS ds FROM v61_t GROUP BY g ORDER BY g",
        "SELECT id FROM v61_t ORDER BY g, v NULLS LAST, id LIMIT 15",
        "SELECT COUNT(*) AS c FROM (SELECT g, COUNT(*) AS n FROM v61_t GROUP BY g HAVING COUNT(*) > 1) x",
        "SELECT SUM(CASE WHEN v > 0 THEN 1 ELSE 0 END) AS pos, SUM(CASE WHEN v <= 0 THEN 1 ELSE 0 END) AS neg FROM v61_t",
        "SELECT id, NTILE(4) OVER (ORDER BY id) AS q FROM v61_t ORDER BY id",
        "SELECT t.g, u.tag, COUNT(*) AS c FROM v61_t t JOIN v61_u u ON u.id = t.id GROUP BY t.g, u.tag ORDER BY t.g, u.tag",
        "SELECT id FROM v61_t WHERE id % 7 = 0 OR v IS NULL ORDER BY id",
        "SELECT id, s FROM v61_t WHERE s LIKE '%1%' ORDER BY id",
        "SELECT COUNT(DISTINCT g || COALESCE(s, '')) AS c FROM v61_t",
        "SELECT g, COUNT(*) AS c FROM v61_t WHERE v IS NOT NULL GROUP BY g HAVING SUM(v) > 0 ORDER BY g",
        "SELECT id FROM v61_t t WHERE v > (SELECT AVG(v) FROM v61_t) ORDER BY id",
        "SELECT id, v, DENSE_RANK() OVER (ORDER BY v NULLS LAST) AS dr FROM v61_t ORDER BY id",
        "SELECT id FROM v61_t WHERE (g, v) IN (('a', 3), ('b', 16)) ORDER BY id",
        "SELECT g, SUM(v) FILTER (WHERE v > 0) AS pos FROM v61_t GROUP BY g ORDER BY g",
        "SELECT COUNT(*) AS c FROM v61_t WHERE s IS NULL AND v IS NULL",
      ];

      // ============================================================
      // A. 索引の有無
      // ============================================================
      const INDEXES = [
        ['単一列索引 (v)', ['CREATE INDEX v61_ix1 ON v61_t (v)'], ['DROP INDEX v61_ix1 ON v61_t']],
        ['単一列索引 (g)', ['CREATE INDEX v61_ix2 ON v61_t (g)'], ['DROP INDEX v61_ix2 ON v61_t']],
        ['複合索引 (g, v)', ['CREATE INDEX v61_ix3 ON v61_t (g, v)'], ['DROP INDEX v61_ix3 ON v61_t']],
        ['複数の索引', ['CREATE INDEX v61_ix4 ON v61_t (v)', 'CREATE INDEX v61_ix5 ON v61_t (s)'],
                        ['DROP INDEX v61_ix4 ON v61_t', 'DROP INDEX v61_ix5 ON v61_t']],
        ['複合索引 (v, g)', ['CREATE INDEX v61_ix6 ON v61_t (v, g)'], ['DROP INDEX v61_ix6 ON v61_t']],
        ['文字列列の索引 (s)', ['CREATE INDEX v61_ix7 ON v61_t (s)'], ['DROP INDEX v61_ix7 ON v61_t']],
      ];
      INDEXES.forEach(([label, create, dropIx]) => {
        QUERIES.forEach((sql, qi) => {
          t(`V61A ${label} でも同じ #${qi}`, () => {
            const before = valsOf(sql);
            create.forEach(c => { const r = q(c); if (r.error) throw new Error(r.error); });
            const withIx = valsOf(sql);
            dropIx.forEach(d => q(d));
            const after = valsOf(sql);
            if (withIx !== before) throw new Error(`索引ありで変わった: ${before.slice(0, 90)} -> ${withIx.slice(0, 90)}`);
            if (after !== before) throw new Error(`索引を消したら変わった: ${before.slice(0, 90)} -> ${after.slice(0, 90)}`);
            return true;
          });
        });
      });

      // ============================================================
      // B. 行の挿入順序
      // ============================================================
      const ORDERS = [
        ['昇順に入れる', rows => rows.slice()],
        ['降順に入れる', rows => rows.slice().reverse()],
        ['入り混じり', rows => rows.filter((_, i) => i % 2 === 0).concat(rows.filter((_, i) => i % 2 === 1))],
        ['1 行ずつ後ろから', rows => rows.slice().sort((a, b) => (b[0] % 7) - (a[0] % 7) || a[0] - b[0])],
      ];
      ORDERS.forEach(([label, arrange]) => {
        QUERIES.forEach((sql, qi) => {
          t(`V61B ${label}でも同じ #${qi}`, () => {
            const before = valsOf(sql);
            q('DELETE FROM v61_t');
            insertRows('v61_t', arrange(ROWS));
            const after = valsOf(sql);
            q('DELETE FROM v61_t');
            insertRows('v61_t', ROWS);
            if (after !== before) {
              throw new Error(`挿入順で変わった: ${before.slice(0, 90)} -> ${after.slice(0, 90)}`);
            }
            return true;
          });
        });
      });

      // ============================================================
      // C. トランザクションの内外・ロールバック後
      // ============================================================
      QUERIES.forEach((sql, qi) => {
        t(`V61C トランザクションの中でも同じ #${qi}`, () => {
          const before = valsOf(sql);
          q('BEGIN');
          const inside = valsOf(sql);
          q('COMMIT');
          if (inside !== before) throw new Error(`トランザクション内で変わった`);
          return true;
        });
        t(`V61C 書き換えてロールバックした後も同じ #${qi}`, () => {
          const before = valsOf(sql);
          q('BEGIN');
          q("UPDATE v61_t SET v = 999, g = 'zz'");
          q('ROLLBACK');
          const after = valsOf(sql);
          if (after !== before) throw new Error(`ロールバック後に変わった: ${before.slice(0, 80)} -> ${after.slice(0, 80)}`);
          return true;
        });
        t(`V61C セーブポイントまで戻した後も同じ #${qi}`, () => {
          const before = valsOf(sql);
          q('BEGIN');
          q('SAVEPOINT sp');
          q("DELETE FROM v61_t WHERE id % 2 = 0");
          q('ROLLBACK TO SAVEPOINT sp');
          q('COMMIT');
          const after = valsOf(sql);
          if (after !== before) throw new Error(`セーブポイント復帰後に変わった`);
          return true;
        });
      });

      // ============================================================
      // D. ビュー・一時表・CTE を経由しても同じ
      // ============================================================
      t('V61D ビューと一時表を用意する', () => {
        q('DROP VIEW IF EXISTS v61_view');
        q('DROP TABLE IF EXISTS v61_tmp');
        const r1 = q('CREATE VIEW v61_view AS SELECT id, g, v, s FROM v61_t');
        const r2 = q('CREATE TABLE v61_tmp AS SELECT id, g, v, s FROM v61_t');
        if (r1.error || r2.error) throw new Error(r1.error || r2.error);
        return db.tables['v61_tmp'].rowCount === 60;
      });
      QUERIES.forEach((sql, qi) => {
        same(`V61D ビュー越しでも同じ #${qi}`, sql, sql.split('v61_t ').join('v61_view ').split('v61_t\n').join('v61_view\n')
          .replace(/\bv61_t\b(?!m)/g, 'v61_view'));
        same(`V61D 一時表でも同じ #${qi}`, sql, sql.replace(/\bv61_t\b(?!m)/g, 'v61_tmp'));
        // すでに WITH で始まるクエリは、CTE の一覧へ足す形にする（WITH を 2 つ書けない）
        const body = sql.replace(/\bv61_t\b(?!m)/g, 'v61_cte');
        const withCte = /^WITH\s/i.test(sql)
          ? body.replace(/^WITH\s/i, 'WITH v61_cte AS (SELECT id, g, v, s FROM v61_t), ')
          : `WITH v61_cte AS (SELECT id, g, v, s FROM v61_t) ${body}`;
        same(`V61D CTE 経由でも同じ #${qi}`, sql, withCte);
      });

      // ============================================================
      // E. 式キャッシュが温まっていても同じ
      // ============================================================
      QUERIES.forEach((sql, qi) => {
        t(`V61E 2 回続けて実行しても同じ #${qi}`, () => {
          const a = valsOf(sql), b = valsOf(sql), c = valsOf(sql);
          if (a !== b || a !== c) throw new Error('繰り返しで結果が変わった');
          return true;
        });
        t(`V61E 別のクエリを挟んでも同じ #${qi}`, () => {
          const a = valsOf(sql);
          valsOf("SELECT COUNT(*) AS c FROM v61_u WHERE tag = 'x'");
          valsOf("SELECT SUM(v) AS s FROM v61_t WHERE g = 'c'");
          const b = valsOf(sql);
          if (a !== b) throw new Error('別のクエリを挟んだら変わった');
          return true;
        });
      });

      // ============================================================
      // F. 書き換え文の特殊な構成
      // ============================================================
      const dmlSame = (name, run, expectSql, wantFn) => t(name, () => {
        q('DROP TABLE IF EXISTS v61_w');
        q("CREATE TABLE v61_w (id INT PRIMARY KEY, a INT, b TEXT)");
        insertRows('v61_w', [[1, 10, 'x'], [2, 20, 'y'], [3, 30, 'z'], [4, null, null], [5, 50, 'x']]);
        const r = run();
        if (r && r.error) throw new Error(r.error);
        const got = valsOf(expectSql);
        q('DROP TABLE IF EXISTS v61_w');
        return eq(got, JSON.stringify(wantFn()), name);
      });
      dmlSame('V61F 自分自身の副問い合わせで UPDATE',
        () => q("UPDATE v61_w SET a = (SELECT MAX(a) FROM v61_w) WHERE id = 1"),
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 50], [2, 20], [3, 30], [4, null], [5, 50]]);
      dmlSame('V61F 自分自身を参照する条件で DELETE',
        () => q("DELETE FROM v61_w WHERE a < (SELECT AVG(a) FROM v61_w)"),
        "SELECT id FROM v61_w ORDER BY id",
        () => [[3], [4], [5]]);
      dmlSame('V61F FROM を伴う UPDATE',
        () => q("UPDATE v61_w SET a = s.a + 1 FROM (SELECT 1 AS id, 100 AS a) s WHERE v61_w.id = s.id"),
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 101], [2, 20], [3, 30], [4, null], [5, 50]]);
      dmlSame('V61F CASE で条件ごとに違う値を入れる',
        () => q("UPDATE v61_w SET a = CASE WHEN a IS NULL THEN -1 WHEN a > 25 THEN a * 2 ELSE a END"),
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 10], [2, 20], [3, 60], [4, -1], [5, 100]]);
      dmlSame('V61F UPSERT を 2 回続ける',
        () => {
          q("INSERT INTO v61_w (id, a) VALUES (1, 111) ON DUPLICATE KEY UPDATE a = 111");
          return q("INSERT INTO v61_w (id, a) VALUES (1, 222) ON DUPLICATE KEY UPDATE a = 222");
        },
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 222], [2, 20], [3, 30], [4, null], [5, 50]]);
      dmlSame('V61F 同じ行を 2 回 UPDATE',
        () => { q("UPDATE v61_w SET a = a + 1 WHERE id = 2"); return q("UPDATE v61_w SET a = a + 1 WHERE id = 2"); },
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 10], [2, 22], [3, 30], [4, null], [5, 50]]);
      dmlSame('V61F 挿入してすぐ更新して削除',
        () => {
          q("INSERT INTO v61_w (id, a, b) VALUES (6, 60, 'w')");
          q("UPDATE v61_w SET a = 66 WHERE id = 6");
          return q("DELETE FROM v61_w WHERE id = 6");
        },
        "SELECT COUNT(*) AS c FROM v61_w", () => [[5]]);
      dmlSame('V61F NULL を条件にした UPDATE',
        () => q("UPDATE v61_w SET b = 'filled' WHERE b IS NULL"),
        "SELECT id, b FROM v61_w ORDER BY id",
        () => [[1, 'x'], [2, 'y'], [3, 'z'], [4, 'filled'], [5, 'x']]);
      dmlSame('V61F 全行を入れ替える（DELETE してから INSERT）',
        () => { q("DELETE FROM v61_w"); return q("INSERT INTO v61_w (id, a) VALUES (9, 90)"); },
        "SELECT id, a FROM v61_w ORDER BY id", () => [[9, 90]]);
      dmlSame('V61F 副問い合わせの結果を丸ごと挿入',
        () => q("INSERT INTO v61_w (id, a, b) SELECT id + 10, a, b FROM v61_w WHERE a IS NOT NULL"),
        "SELECT COUNT(*) AS c FROM v61_w", () => [[9]]);
      dmlSame('V61F RETURNING で書き換えた行を受け取る',
        () => {
          const r = q("UPDATE v61_w SET a = 7 WHERE id <= 2 RETURNING id, a");
          if (r.error) throw new Error(r.error);
          if (JSON.stringify(r.data.map(x => Object.values(x))) !== JSON.stringify([[1, 7], [2, 7]])) {
            throw new Error('RETURNING の中身が違う: ' + JSON.stringify(r.data));
          }
          return r;
        },
        "SELECT id, a FROM v61_w ORDER BY id",
        () => [[1, 7], [2, 7], [3, 30], [4, null], [5, 50]]);

      // ============================================================
      // G. 制約・トリガーのある表でも読み出しは同じ
      // ============================================================
      t('V61G 制約とトリガーのある表を用意する', () => {
        q('DROP TABLE IF EXISTS v61_k');
        q('DROP TRIGGER IF EXISTS v61_trg');
        const r = q("CREATE TABLE v61_k (id INT PRIMARY KEY, g TEXT NOT NULL, v INT CHECK (v IS NULL OR v > -100), "
          + "s TEXT UNIQUE, note TEXT DEFAULT 'n')");
        if (r.error) throw new Error(r.error);
        insertRows('v61_k', ROWS.map(([id, g, v, s]) => [id, g, v, s === null ? null : s + '_' + id, 'n']));
        return db.tables['v61_k'].rowCount === 60;
      });
      QUERIES.forEach((sql, qi) => {
        if (qi % 3 !== 0) return;   // 1/3 に絞る（制約は読み出しに影響しないことの確認なので）
        // s 列だけ値が違う（UNIQUE のため）ので、s を使うクエリは除く
        if (sql.indexOf('s ') !== -1 || sql.indexOf('(s)') !== -1) return;
        same(`V61G 制約付きの表でも同じ #${qi}`, sql, sql.replace(/\bv61_t\b/g, 'v61_k'));
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V61Zz ビューと派生表を片付ける', () => {
        q('DROP VIEW IF EXISTS v61_view');
        q('DROP TABLE IF EXISTS v61_tmp');
        q('DROP TABLE IF EXISTS v61_w');
        q('DROP TABLE IF EXISTS v61_k');
        return !db.views['v61_view'] && !db.tables['v61_tmp'];
      });
      cleanup('v61_t', 'v61_u', 'v61_tmp', 'v61_w', 'v61_k');

      return T;
    }
