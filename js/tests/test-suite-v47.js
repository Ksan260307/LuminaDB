    // ============================================================================
    // [Test Suite v47] - コマンド全網羅 (5/6): DML・トランザクション・手続き型・セッション
    //
    //     A. INSERT の全形式 × 列指定 × 値の作り方
    //     B. UPDATE の代入 × 絞り込み の総当たり
    //     C. DELETE の全形式
    //     D. MERGE / UPSERT の分岐
    //     E. RETURNING
    //     F. トランザクション・セーブポイント・巻き戻し
    //     G. プリペアドステートメント
    //     H. 変数・セッション設定
    //     I. スナップショット
    //     J. プロシージャの手続き型構文
    //     K. VALUES 文・TABLE 文
    //     L. セッション制御・権限系（受理のみ）
    //     M. DML の誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV47Tests() のスプレッドで合流する
    // ============================================================================
    function getV47Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, ok, rowsOf: rows, oneOf: one, eq, val } = makeTestKit('V47');

      // 作業表を毎回作り直す（200 行）。模型と同じ規則で作る
      const WORK = [];
      const mkWork = () => {
        q('DROP TABLE IF EXISTS v47_w');
        q('CREATE TABLE v47_w (id INT PRIMARY KEY, g TEXT, v INT, w DECIMAL(18,4), s TEXT)');
        WORK.length = 0;
        const gs = ['A', 'B', 'C', 'D', 'E'];
        const vals = [];
        // 200 行。UPDATE の総当たりで毎回作り直すので、模型と突き合わせる意味を
        // 保てる最小限の大きさにしている（600 行だと 1 スイートで 95 秒かかった）
        for (let i = 0; i < 200; i++) {
          const v = (i % 19 === 18) ? null : ((i * 11) % 61) - 25;
          const w = (i % 23 === 22) ? null : ((i % 41) - 20) * 0.5;
          const s = (i % 13 === 12) ? null : 'r' + (i % 9);
          WORK.push({ id: i, g: gs[i % 5], v, w, s });
          vals.push(`(${i}, '${gs[i % 5]}', ${v === null ? 'NULL' : v}, ${w === null ? 'NULL' : w}, ` +
                    `${s === null ? 'NULL' : "'" + s + "'"})`);
        }
        q('INSERT INTO v47_w VALUES ' + vals.join(','));
        return WORK.map(r => Object.assign({}, r));
      };
      const snapshotRows = () => rows('SELECT id, g, v, w, s FROM v47_w ORDER BY id');

      t('V47 fixture', () => {
        mkWork();
        q('DROP TABLE IF EXISTS v47_src');
        q('CREATE TABLE v47_src (id INT, v INT, tag TEXT)');
        q("INSERT INTO v47_src VALUES (1, 100, 'x'), (2, 200, 'y'), (3, 300, 'z'), (900, 999, 'new')");
        return db.tables['v47_w'].rowCount === 200 && db.tables['v47_src'].rowCount === 4;
      });

      // ============================================================
      // A. INSERT の全形式
      // ============================================================
      const ins = (name, body) => t(name, () => {
        q('DROP TABLE IF EXISTS v47_i');
        q('CREATE TABLE v47_i (id INT, a TEXT, b INT DEFAULT 7)');
        try { return body(); } finally { q('DROP TABLE IF EXISTS v47_i'); }
      });
      ins('V47A INSERT with a column list', () => {
        q("INSERT INTO v47_i (id, a, b) VALUES (1, 'x', 2)");
        return eq(rows('SELECT id, a, b FROM v47_i'), [{ id: 1, a: 'x', b: 2 }]);
      });
      ins('V47A INSERT without a column list', () => {
        q("INSERT INTO v47_i VALUES (1, 'x', 2)");
        return eq(rows('SELECT id, a, b FROM v47_i'), [{ id: 1, a: 'x', b: 2 }]);
      });
      ins('V47A INSERT with a partial column list applies the default', () => {
        q("INSERT INTO v47_i (id, a) VALUES (1, 'x')");
        return eq(one('SELECT b FROM v47_i'), 7);
      });
      ins('V47A INSERT with the columns in a different order', () => {
        q("INSERT INTO v47_i (b, a, id) VALUES (2, 'x', 1)");
        return eq(rows('SELECT id, a, b FROM v47_i'), [{ id: 1, a: 'x', b: 2 }]);
      });
      ins('V47A INSERT with several value rows', () => {
        q("INSERT INTO v47_i (id, a) VALUES (1, 'x'), (2, 'y'), (3, 'z')");
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 3);
      });
      ins('V47A INSERT with fifty value rows', () => {
        const vs = [];
        for (let i = 0; i < 50; i++) vs.push(`(${i}, 'r${i}')`);
        q(`INSERT INTO v47_i (id, a) VALUES ${vs.join(',')}`);
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 50);
      });
      ins('V47A INSERT SELECT', () => {
        q('INSERT INTO v47_i (id, a) SELECT id, tag FROM v47_src');
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 4);
      });
      ins('V47A INSERT SELECT with a filter', () => {
        q('INSERT INTO v47_i (id, a) SELECT id, tag FROM v47_src WHERE v > 150');
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 3);
      });
      ins('V47A INSERT SELECT with an ORDER BY and LIMIT', () => {
        q('INSERT INTO v47_i (id, a) SELECT id, tag FROM v47_src ORDER BY id DESC LIMIT 2');
        return eq(rows('SELECT id FROM v47_i ORDER BY id').map(r => r.id), [3, 900]);
      });
      ins('V47A INSERT SELECT from a CTE', () => {
        q('INSERT INTO v47_i (id, a) WITH c AS (SELECT id, tag FROM v47_src) SELECT * FROM c');
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 4);
      });
      ins('V47A INSERT SELECT with a UNION', () => {
        q('INSERT INTO v47_i (id, a) SELECT id, tag FROM v47_src UNION SELECT id, tag FROM v47_src');
        return eq(one('SELECT COUNT(*) AS c FROM v47_i'), 4);
      });
      ins('V47A INSERT with an expression value', () => {
        q("INSERT INTO v47_i (id, a) VALUES (1 + 1, UPPER('x'))");
        return eq(rows('SELECT id, a FROM v47_i'), [{ id: 2, a: 'X' }]);
      });
      ins('V47A INSERT with a scalar subquery value', () => {
        q("INSERT INTO v47_i (id, a) VALUES ((SELECT MAX(id) FROM v47_src), 'q')");
        return eq(one('SELECT id FROM v47_i'), 900);
      });
      ins('V47A INSERT ... SET', () => {
        q("INSERT INTO v47_i SET id = 1, a = 'x'");
        return eq(rows('SELECT id, a, b FROM v47_i'), [{ id: 1, a: 'x', b: 7 }]);
      });
      ins('V47A INSERT with DEFAULT VALUES', () => {
        q('INSERT INTO v47_i DEFAULT VALUES');
        return eq(one('SELECT b FROM v47_i'), 7);
      });
      ins('V47A INSERT with an explicit DEFAULT keyword', () => {
        q("INSERT INTO v47_i (id, a, b) VALUES (1, 'x', DEFAULT)");
        return eq(one('SELECT b FROM v47_i'), 7);
      });
      ins('V47A INSERT with NULL values', () => {
        q('INSERT INTO v47_i (id, a, b) VALUES (NULL, NULL, NULL)');
        return eq(rows('SELECT id, a, b FROM v47_i'), [{ id: null, a: null, b: null }]);
      });
      // 競合の扱い
      const insU = (name, body) => t(name, () => {
        q('DROP TABLE IF EXISTS v47_u');
        q('CREATE TABLE v47_u (id INT PRIMARY KEY, a TEXT, n INT)');
        q("INSERT INTO v47_u VALUES (1, 'one', 10)");
        try { return body(); } finally { q('DROP TABLE IF EXISTS v47_u'); }
      });
      insU('V47A a duplicate key is rejected', () => {
        const r = q("INSERT INTO v47_u VALUES (1, 'dup', 0)");
        return eq([!!r.error, one('SELECT a FROM v47_u WHERE id = 1')], [true, 'one']);
      });
      insU('V47A ON DUPLICATE KEY UPDATE', () => {
        q("INSERT INTO v47_u VALUES (1, 'two', 20) ON DUPLICATE KEY UPDATE n = 99");
        return eq(rows('SELECT id, a, n FROM v47_u'), [{ id: 1, a: 'one', n: 99 }]);
      });
      insU('V47A ON CONFLICT DO UPDATE', () => {
        q("INSERT INTO v47_u VALUES (1, 'two', 20) ON CONFLICT (id) DO UPDATE SET n = 88");
        return eq(one('SELECT n FROM v47_u'), 88);
      });
      insU('V47A ON CONFLICT DO NOTHING', () => {
        q("INSERT INTO v47_u VALUES (1, 'two', 20) ON CONFLICT DO NOTHING");
        return eq(rows('SELECT id, a, n FROM v47_u'), [{ id: 1, a: 'one', n: 10 }]);
      });
      insU('V47A INSERT OR IGNORE', () => {
        q("INSERT OR IGNORE INTO v47_u VALUES (1, 'two', 20)");
        return eq(one('SELECT a FROM v47_u'), 'one');
      });
      insU('V47A INSERT OR REPLACE', () => {
        q("INSERT OR REPLACE INTO v47_u VALUES (1, 'two', 20)");
        return eq(rows('SELECT id, a, n FROM v47_u'), [{ id: 1, a: 'two', n: 20 }]);
      });
      insU('V47A REPLACE INTO', () => {
        q("REPLACE INTO v47_u VALUES (1, 'three', 30)");
        return eq(rows('SELECT id, a, n FROM v47_u'), [{ id: 1, a: 'three', n: 30 }]);
      });
      insU('V47A ON DUPLICATE KEY UPDATE on a new row still inserts', () => {
        q("INSERT INTO v47_u VALUES (2, 'two', 20) ON DUPLICATE KEY UPDATE n = 99");
        return eq(one('SELECT n FROM v47_u WHERE id = 2'), 20);
      });
      insU('V47A ON CONFLICT DO UPDATE referencing EXCLUDED', () => {
        q("INSERT INTO v47_u VALUES (1, 'two', 20) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n");
        return eq(one('SELECT n FROM v47_u'), 20);
      });

      // ============================================================
      // B. UPDATE の代入 × 絞り込み の総当たり
      // ============================================================
      const ASSIGNS = [
        ['v = 0', r => ({ v: 0 })],
        ['v = v + 1', r => ({ v: r.v === null ? null : r.v + 1 })],
        ['v = v * 2', r => ({ v: r.v === null ? null : r.v * 2 })],
        ['v = NULL', r => ({ v: null })],
        ['v = ABS(v)', r => ({ v: r.v === null ? null : Math.abs(r.v) })],
        ["g = 'Z'", r => ({ g: 'Z' })],
        ["g = LOWER(g)", r => ({ g: r.g.toLowerCase() })],
        ["s = COALESCE(s, 'none')", r => ({ s: r.s === null ? 'none' : r.s })],
        ['v = id', r => ({ v: r.id })],
        ['v = CASE WHEN v > 0 THEN 1 ELSE -1 END',
         r => ({ v: r.v === null ? -1 : (r.v > 0 ? 1 : -1) })],
        ["v = 1, g = 'Y'", r => ({ v: 1, g: 'Y' })],
        ["v = v + 1, s = 'up'", r => ({ v: r.v === null ? null : r.v + 1, s: 'up' })],
        ['w = ROUND(w, 0)', r => ({ w: r.w === null ? null : Math.sign(r.w) * Math.round(Math.abs(r.w)) })],
      ];
      const FILTERS = [
        ['', () => true],
        [' WHERE id < 100', r => r.id < 100],
        [' WHERE g = \'A\'', r => r.g === 'A'],
        [' WHERE v IS NULL', r => r.v === null],
        [' WHERE v IS NOT NULL', r => r.v !== null],
        [' WHERE v > 0', r => r.v !== null && r.v > 0],
        [' WHERE id % 7 = 0', r => r.id % 7 === 0],
        [" WHERE g IN ('A', 'C')", r => r.g === 'A' || r.g === 'C'],
        [' WHERE id BETWEEN 100 AND 200', r => r.id >= 100 && r.id <= 200],
        [' WHERE s IS NULL AND v > 0', r => r.s === null && r.v !== null && r.v > 0],
      ];
      ASSIGNS.forEach(([aSql, aFn]) => FILTERS.forEach(([fSql, fFn]) => {
        t(`V47B UPDATE SET ${aSql}${fSql}`, () => {
          const model = mkWork();
          q(`UPDATE v47_w SET ${aSql}${fSql}`);
          model.forEach(r => { if (fFn(r)) Object.assign(r, aFn(r)); });
          const want = model.map(r => ({
            id: r.id, g: r.g, v: r.v,
            w: r.w === null ? null : Math.round(r.w * 10000) / 10000, s: r.s }));
          return eq(snapshotRows(), want);
        });
      }));
      // 特殊な UPDATE
      t('V47B UPDATE with ORDER BY and LIMIT', () => {
        mkWork();
        q('UPDATE v47_w SET v = -1 ORDER BY id LIMIT 5');
        return eq(rows('SELECT COUNT(*) AS c FROM v47_w WHERE v = -1')[0].c >= 5, true);
      });
      t('V47B UPDATE from another table', () => {
        mkWork();
        q('UPDATE v47_w SET v = s2.v FROM v47_src s2 WHERE v47_w.id = s2.id');
        const got = rows('SELECT id, v FROM v47_w WHERE id IN (1, 2, 3) ORDER BY id');
        return eq(got, [{ id: 1, v: 100 }, { id: 2, v: 200 }, { id: 3, v: 300 }]);
      });
      t('V47B UPDATE with a correlated subquery', () => {
        mkWork();
        q('UPDATE v47_w SET v = (SELECT v FROM v47_src WHERE v47_src.id = v47_w.id) WHERE id IN (1, 2)');
        return eq(rows('SELECT id, v FROM v47_w WHERE id IN (1, 2) ORDER BY id'),
                  [{ id: 1, v: 100 }, { id: 2, v: 200 }]);
      });
      t('V47B UPDATE with an IN subquery filter', () => {
        const model = mkWork();
        q('UPDATE v47_w SET v = -777 WHERE id IN (SELECT id FROM v47_src)');
        const ids = new Set([1, 2, 3, 900]);
        model.forEach(r => { if (ids.has(r.id)) r.v = -777; });
        return eq(rows('SELECT id, v FROM v47_w ORDER BY id').map(r => r.v), model.map(r => r.v));
      });
      t('V47B UPDATE with EXISTS', () => {
        const model = mkWork();
        q('UPDATE v47_w SET v = -777 WHERE EXISTS (SELECT 1 FROM v47_src WHERE v47_src.id = v47_w.id)');
        const ids = new Set([1, 2, 3, 900]);
        model.forEach(r => { if (ids.has(r.id)) r.v = -777; });
        return eq(rows('SELECT id, v FROM v47_w ORDER BY id').map(r => r.v), model.map(r => r.v));
      });
      t('V47B UPDATE affecting no rows reports zero', () => {
        mkWork();
        const r = q('UPDATE v47_w SET v = 0 WHERE id > 99999');
        return eq([!!r.error, one('SELECT COUNT(*) AS c FROM v47_w WHERE v = 0') >= 0], [false, true]);
      });
      t('V47B UPDATE respects a CHECK constraint', () => {
        q('DROP TABLE IF EXISTS v47_ck');
        q('CREATE TABLE v47_ck (a INT CHECK (a >= 0))');
        q('INSERT INTO v47_ck VALUES (5)');
        const r = q('UPDATE v47_ck SET a = -1');
        const kept = one('SELECT a FROM v47_ck');
        q('DROP TABLE IF EXISTS v47_ck');
        return eq([!!r.error, kept], [true, 5]);
      });

      // ============================================================
      // C. DELETE の全形式
      // ============================================================
      FILTERS.forEach(([fSql, fFn]) => {
        t(`V47C DELETE FROM v47_w${fSql}`, () => {
          const model = mkWork();
          q(`DELETE FROM v47_w${fSql}`);
          const want = model.filter(r => !fFn(r)).map(r => r.id);
          return eq(rows('SELECT id FROM v47_w ORDER BY id').map(r => r.id), want);
        });
      });
      t('V47C DELETE with ORDER BY and LIMIT', () => {
        mkWork();
        q('DELETE FROM v47_w ORDER BY id LIMIT 10');
        return eq(one('SELECT COUNT(*) AS c FROM v47_w'), 190);
      });
      t('V47C DELETE with an IN subquery', () => {
        mkWork();
        q('DELETE FROM v47_w WHERE id IN (SELECT id FROM v47_src)');
        return eq(one('SELECT COUNT(*) AS c FROM v47_w'), 197);
      });
      t('V47C DELETE with NOT EXISTS keeps everything unmatched', () => {
        mkWork();
        q('DELETE FROM v47_w WHERE NOT EXISTS (SELECT 1 FROM v47_src WHERE v47_src.id = v47_w.id)');
        return eq(one('SELECT COUNT(*) AS c FROM v47_w'), 3);
      });
      t('V47C DELETE using another table', () => {
        mkWork();
        q('DELETE FROM v47_w USING v47_src WHERE v47_w.id = v47_src.id');
        return eq(one('SELECT COUNT(*) AS c FROM v47_w'), 197);
      });
      t('V47C DELETE everything', () => {
        mkWork();
        q('DELETE FROM v47_w');
        return eq(one('SELECT COUNT(*) AS c FROM v47_w'), 0);
      });
      t('V47C DELETE then INSERT reuses the table', () => {
        mkWork();
        q('DELETE FROM v47_w');
        q("INSERT INTO v47_w VALUES (1, 'A', 1, 1, 'x')");
        return eq(rows('SELECT id, g, v FROM v47_w'), [{ id: 1, g: 'A', v: 1 }]);
      });

      // ============================================================
      // D. MERGE / UPSERT
      // ============================================================
      const mrg = (name, body) => t(name, () => {
        q('DROP TABLE IF EXISTS v47_tgt');
        q('CREATE TABLE v47_tgt (id INT PRIMARY KEY, v INT, tag TEXT)');
        q("INSERT INTO v47_tgt VALUES (1, 1, 'a'), (2, 2, 'b'), (5, 5, 'e')");
        try { return body(); } finally { q('DROP TABLE IF EXISTS v47_tgt'); }
      });
      mrg('V47D MERGE updates the matched rows', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id ' +
          'WHEN MATCHED THEN UPDATE SET v = s.v');
        return eq(rows('SELECT id, v FROM v47_tgt ORDER BY id'),
                  [{ id: 1, v: 100 }, { id: 2, v: 200 }, { id: 5, v: 5 }]);
      });
      mrg('V47D MERGE inserts the unmatched rows', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id ' +
          'WHEN NOT MATCHED THEN INSERT (id, v, tag) VALUES (s.id, s.v, s.tag)');
        return eq(rows('SELECT id FROM v47_tgt ORDER BY id').map(r => r.id), [1, 2, 3, 5, 900]);
      });
      mrg('V47D MERGE with both branches', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id ' +
          'WHEN MATCHED THEN UPDATE SET v = s.v ' +
          'WHEN NOT MATCHED THEN INSERT (id, v, tag) VALUES (s.id, s.v, s.tag)');
        return eq(rows('SELECT id, v FROM v47_tgt ORDER BY id'),
                  [{ id: 1, v: 100 }, { id: 2, v: 200 }, { id: 3, v: 300 },
                   { id: 5, v: 5 }, { id: 900, v: 999 }]);
      });
      mrg('V47D MERGE with DELETE on match', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id WHEN MATCHED THEN DELETE');
        return eq(rows('SELECT id FROM v47_tgt ORDER BY id').map(r => r.id), [5]);
      });
      mrg('V47D MERGE with a condition on the matched branch', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id ' +
          'WHEN MATCHED AND s.v > 150 THEN UPDATE SET v = s.v');
        return eq(rows('SELECT id, v FROM v47_tgt ORDER BY id'),
                  [{ id: 1, v: 1 }, { id: 2, v: 200 }, { id: 5, v: 5 }]);
      });
      mrg('V47D MERGE from a subquery source', () => {
        q('MERGE INTO v47_tgt t USING (SELECT id, v FROM v47_src WHERE v > 150) s ON t.id = s.id ' +
          'WHEN MATCHED THEN UPDATE SET v = s.v');
        return eq(one('SELECT v FROM v47_tgt WHERE id = 2'), 200);
      });
      mrg('V47D MERGE leaves the untouched rows alone', () => {
        q('MERGE INTO v47_tgt t USING v47_src s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = 0');
        return eq(one('SELECT v FROM v47_tgt WHERE id = 5'), 5);
      });

      // ============================================================
      // E. RETURNING
      // ============================================================
      const ret = (name, body) => t(name, () => {
        q('DROP TABLE IF EXISTS v47_r');
        q('CREATE TABLE v47_r (id INT PRIMARY KEY AUTO_INCREMENT, a TEXT, n INT)');
        q("INSERT INTO v47_r (a, n) VALUES ('x', 1), ('y', 2), ('z', 3)");
        try { return body(); } finally { q('DROP TABLE IF EXISTS v47_r'); }
      });
      ret('V47E INSERT RETURNING', () =>
        eq(rows("INSERT INTO v47_r (a, n) VALUES ('w', 4) RETURNING id, a"), [{ id: 4, a: 'w' }]));
      ret('V47E INSERT RETURNING star', () =>
        eq(rows("INSERT INTO v47_r (a, n) VALUES ('w', 4) RETURNING *").length, 1));
      ret('V47E INSERT RETURNING an expression', () =>
        eq(rows("INSERT INTO v47_r (a, n) VALUES ('w', 4) RETURNING n * 10 AS ten"), [{ ten: 40 }]));
      ret('V47E multi-row INSERT RETURNING', () =>
        eq(rows("INSERT INTO v47_r (a, n) VALUES ('p', 5), ('q', 6) RETURNING a").map(r => r.a), ['p', 'q']));
      ret('V47E UPDATE RETURNING', () =>
        eq(rows('UPDATE v47_r SET n = n + 10 WHERE id = 1 RETURNING id, n'), [{ id: 1, n: 11 }]));
      ret('V47E UPDATE RETURNING several rows', () =>
        eq(rows('UPDATE v47_r SET n = 0 RETURNING id').map(r => r.id), [1, 2, 3]));
      ret('V47E DELETE RETURNING', () =>
        eq(rows('DELETE FROM v47_r WHERE id = 2 RETURNING id, a'), [{ id: 2, a: 'y' }]));
      ret('V47E DELETE RETURNING several rows', () =>
        eq(rows('DELETE FROM v47_r RETURNING id').map(r => r.id), [1, 2, 3]));
      ret('V47E RETURNING does not change what is stored', () => {
        rows('UPDATE v47_r SET n = 99 WHERE id = 1 RETURNING id');
        return eq(one('SELECT n FROM v47_r WHERE id = 1'), 99);
      });

      // ============================================================
      // F. トランザクション
      // ============================================================
      const tx = (name, body) => t(name, () => {
        q('DROP TABLE IF EXISTS v47_t');
        q('CREATE TABLE v47_t (id INT, v INT)');
        q('INSERT INTO v47_t VALUES (1, 10), (2, 20)');
        try { return body(); } finally { q('ROLLBACK'); q('DROP TABLE IF EXISTS v47_t'); }
      });
      ['BEGIN', 'BEGIN TRANSACTION', 'START TRANSACTION', 'BEGIN WORK'].forEach(kw => {
        tx(`V47F ${kw} then ROLLBACK undoes the change`, () => {
          q(kw);
          q('UPDATE v47_t SET v = 999');
          q('ROLLBACK');
          return eq(rows('SELECT v FROM v47_t ORDER BY id').map(r => r.v), [10, 20]);
        });
      });
      ['COMMIT', 'COMMIT WORK', 'COMMIT TRANSACTION'].forEach(kw => {
        tx(`V47F ${kw} keeps the change`, () => {
          q('BEGIN');
          q('UPDATE v47_t SET v = 999');
          q(kw);
          return eq(rows('SELECT v FROM v47_t ORDER BY id').map(r => r.v), [999, 999]);
        });
      });
      tx('V47F ROLLBACK undoes an INSERT', () => {
        q('BEGIN'); q('INSERT INTO v47_t VALUES (3, 30)'); q('ROLLBACK');
        return eq(one('SELECT COUNT(*) AS c FROM v47_t'), 2);
      });
      tx('V47F ROLLBACK undoes a DELETE', () => {
        q('BEGIN'); q('DELETE FROM v47_t'); q('ROLLBACK');
        return eq(one('SELECT COUNT(*) AS c FROM v47_t'), 2);
      });
      tx('V47F ROLLBACK undoes a CREATE TABLE', () => {
        q('BEGIN'); q('CREATE TABLE v47_inner (a INT)'); q('ROLLBACK');
        return eq(!!db.tables['v47_inner'], false);
      });
      tx('V47F ROLLBACK undoes a DROP TABLE', () => {
        q('BEGIN'); q('DROP TABLE v47_t'); q('ROLLBACK');
        return eq(one('SELECT COUNT(*) AS c FROM v47_t'), 2);
      });
      tx('V47F ROLLBACK undoes an ALTER TABLE', () => {
        q('BEGIN'); q('ALTER TABLE v47_t ADD COLUMN z INT'); q('ROLLBACK');
        return eq(!!db.tables['v47_t'].cols['z'], false);
      });
      tx('V47F SAVEPOINT and ROLLBACK TO', () => {
        q('BEGIN');
        q('UPDATE v47_t SET v = 100 WHERE id = 1');
        q('SAVEPOINT sp1');
        q('UPDATE v47_t SET v = 200 WHERE id = 2');
        q('ROLLBACK TO SAVEPOINT sp1');
        const got = rows('SELECT v FROM v47_t ORDER BY id').map(r => r.v);
        q('ROLLBACK');
        return eq(got, [100, 20]);
      });
      tx('V47F RELEASE SAVEPOINT keeps the work', () => {
        q('BEGIN');
        q('SAVEPOINT sp1');
        q('UPDATE v47_t SET v = 200');
        q('RELEASE SAVEPOINT sp1');
        const got = rows('SELECT v FROM v47_t ORDER BY id').map(r => r.v);
        q('ROLLBACK');
        return eq(got, [200, 200]);
      });
      tx('V47F nested savepoints roll back independently', () => {
        q('BEGIN');
        q('UPDATE v47_t SET v = 1 WHERE id = 1');
        q('SAVEPOINT a');
        q('UPDATE v47_t SET v = 2 WHERE id = 1');
        q('SAVEPOINT b');
        q('UPDATE v47_t SET v = 3 WHERE id = 1');
        q('ROLLBACK TO SAVEPOINT b');
        const v1 = one('SELECT v FROM v47_t WHERE id = 1');
        q('ROLLBACK TO SAVEPOINT a');
        const v2 = one('SELECT v FROM v47_t WHERE id = 1');
        q('ROLLBACK');
        return eq([v1, v2], [2, 1]);
      });
      tx('V47F an error inside a transaction leaves earlier work pending', () => {
        q('BEGIN');
        q('UPDATE v47_t SET v = 50 WHERE id = 1');
        q('UPDATE v47_t SET nosuchcol = 1');
        const v = one('SELECT v FROM v47_t WHERE id = 1');
        q('ROLLBACK');
        return eq(v, 50);
      });
      tx('V47F a transaction wraps many statements', () => {
        q('BEGIN');
        for (let i = 0; i < 50; i++) q(`INSERT INTO v47_t VALUES (${100 + i}, ${i})`);
        const during = one('SELECT COUNT(*) AS c FROM v47_t');
        q('ROLLBACK');
        const after = one('SELECT COUNT(*) AS c FROM v47_t');
        return eq([during, after], [52, 2]);
      });
      ok('V47F SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
         'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      ok('V47F SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
         'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      ok('V47F SHOW TRANSACTION ISOLATION LEVEL', 'SHOW TRANSACTION ISOLATION LEVEL');

      // ============================================================
      // G. プリペアドステートメント
      // ============================================================
      t('V47G PREPARE and EXECUTE with one parameter', () => {
        q('DEALLOCATE PREPARE v47_ps');
        q("PREPARE v47_ps FROM 'SELECT ? + 1 AS r'");
        const a = rows('EXECUTE v47_ps USING 41')[0].r;
        const b = rows('EXECUTE v47_ps USING 1')[0].r;
        q('DEALLOCATE PREPARE v47_ps');
        return eq([a, b], [42, 2]);
      });
      t('V47G PREPARE with two parameters', () => {
        q('DEALLOCATE PREPARE v47_ps2');
        q("PREPARE v47_ps2 FROM 'SELECT ? + ? AS r'");
        const a = rows('EXECUTE v47_ps2 USING 20, 22')[0].r;
        q('DEALLOCATE PREPARE v47_ps2');
        return eq(a, 42);
      });
      t('V47G PREPARE over a table', () => {
        mkWork();
        q('DEALLOCATE PREPARE v47_ps3');
        q("PREPARE v47_ps3 FROM 'SELECT COUNT(*) AS c FROM v47_w WHERE g = ?'");
        const a = rows("EXECUTE v47_ps3 USING 'A'")[0].c;
        q('DEALLOCATE PREPARE v47_ps3');
        return eq(a, WORK.filter(r => r.g === 'A').length);
      });
      t('V47G SHOW PREPARED lists the statement', () => {
        q('DEALLOCATE PREPARE v47_ps4');
        q("PREPARE v47_ps4 FROM 'SELECT 1 AS r'");
        const n = rows('SHOW PREPARED').length;
        q('DEALLOCATE PREPARE v47_ps4');
        return eq(n >= 1, true);
      });
      t('V47G DEALLOCATE removes the statement', () => {
        q("PREPARE v47_ps5 FROM 'SELECT 1 AS r'");
        q('DEALLOCATE PREPARE v47_ps5');
        const r = q('EXECUTE v47_ps5');
        return eq(!!r.error, true);
      });
      ok('V47G DEALLOCATE ALL', 'DEALLOCATE ALL');

      // ============================================================
      // H. 変数・セッション設定
      // ============================================================
      t('V47H SET and read a user variable', () => {
        q('SET @v47a = 5');
        return eq(one('SELECT @v47a AS r'), 5);
      });
      t('V47H a user variable holds text', () => {
        q("SET @v47b = 'hello'");
        return eq(one('SELECT @v47b AS r'), 'hello');
      });
      t('V47H a user variable holds an expression result', () => {
        q('SET @v47c = 20 + 22');
        return eq(one('SELECT @v47c AS r'), 42);
      });
      t('V47H a user variable can be used in WHERE', () => {
        mkWork();
        q("SET @v47g = 'A'");
        return eq(one('SELECT COUNT(*) AS c FROM v47_w WHERE g = @v47g'),
                  WORK.filter(r => r.g === 'A').length);
      });
      t('V47H DECLARE with an initial value', () => {
        q('DECLARE @v47d INT = 7');
        return eq(one('SELECT @v47d AS r'), 7);
      });
      t('V47H DECLARE without a value is NULL', () => {
        q('DECLARE @v47e INT');
        return eq(one('SELECT @v47e AS r'), null);
      });
      t('V47H an unset variable is NULL', () => eq(one('SELECT @v47_never_set AS r'), null));
      t('V47H SHOW VARIABLES lists user variables', () => {
        q('SET @v47f = 1');
        return eq(rows('SHOW VARIABLES').length >= 1, true);
      });
      [['statement_timeout = 0', true], ['statement_timeout = 5000', true],
       ['read_only = OFF', true], ['SESSION statement_timeout = 0', true],
       ['LOCAL statement_timeout = 0', true]].forEach(([s]) => {
        ok(`V47H SET ${s}`, `SET ${s}`);
      });
      ok('V47H SHOW SETTINGS', 'SHOW SETTINGS');
      ok('V47H SHOW STATUS', 'SHOW STATUS');
      t('V47H read_only rejects a write while on', () => {
        mkWork();
        q('SET read_only = ON');
        const r = q('DELETE FROM v47_w');
        q('SET read_only = OFF');
        return eq([!!r.error, one('SELECT COUNT(*) AS c FROM v47_w')], [true, 200]);
      });
      t('V47H read_only still allows reads', () => {
        mkWork();
        q('SET read_only = ON');
        const r = q('SELECT COUNT(*) AS c FROM v47_w');
        q('SET read_only = OFF');
        return eq([!!r.error, r.data[0].c], [false, 200]);
      });

      // ============================================================
      // I. スナップショット
      // ============================================================
      t('V47I a snapshot restores the earlier state', () => {
        mkWork();
        q('DROP SNAPSHOT IF EXISTS v47_snap');
        q('CREATE SNAPSHOT v47_snap');
        q('DELETE FROM v47_w WHERE id < 100');
        const after = one('SELECT COUNT(*) AS c FROM v47_w');
        q('RESTORE SNAPSHOT v47_snap');
        const back = one('SELECT COUNT(*) AS c FROM v47_w');
        q('DROP SNAPSHOT IF EXISTS v47_snap');
        return eq([after, back], [100, 200]);
      });
      t('V47I SHOW SNAPSHOTS lists it', () => {
        q('DROP SNAPSHOT IF EXISTS v47_snap2');
        q('CREATE SNAPSHOT v47_snap2');
        const n = rows('SHOW SNAPSHOTS').length;
        q('DROP SNAPSHOT IF EXISTS v47_snap2');
        return eq(n >= 1, true);
      });
      t('V47I a snapshot captures a dropped table', () => {
        mkWork();
        q('DROP SNAPSHOT IF EXISTS v47_snap3');
        q('CREATE SNAPSHOT v47_snap3');
        q('DROP TABLE v47_w');
        const gone = !db.tables['v47_w'];
        q('RESTORE SNAPSHOT v47_snap3');
        const back = !!db.tables['v47_w'];
        q('DROP SNAPSHOT IF EXISTS v47_snap3');
        return eq([gone, back], [true, true]);
      });

      // ============================================================
      // J. プロシージャの手続き型構文
      // ============================================================
      const proc = (name, body, call, verify) => t(name, () => {
        q('DROP PROCEDURE IF EXISTS v47_pr');
        q('DROP TABLE IF EXISTS v47_pt');
        q('CREATE TABLE v47_pt (n INT)');
        const c = q(`CREATE PROCEDURE v47_pr() BEGIN ${body} END`);
        if (c.error) { q('DROP PROCEDURE IF EXISTS v47_pr'); q('DROP TABLE IF EXISTS v47_pt'); throw new Error(c.error); }
        const r = q(call || 'CALL v47_pr()');
        if (r.error) { q('DROP PROCEDURE IF EXISTS v47_pr'); q('DROP TABLE IF EXISTS v47_pt'); throw new Error(r.error); }
        try { return verify(r); } finally {
          q('DROP PROCEDURE IF EXISTS v47_pr'); q('DROP TABLE IF EXISTS v47_pt');
        }
      });
      proc('V47J a procedure with several statements',
           "INSERT INTO v47_pt VALUES (1); INSERT INTO v47_pt VALUES (2);", null,
           () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 2));
      proc('V47J a procedure with an IF branch',
           "IF 1 = 1 THEN INSERT INTO v47_pt VALUES (1); END IF;", null,
           () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 1));
      proc('V47J a procedure with an IF that does not fire',
           "IF 1 = 0 THEN INSERT INTO v47_pt VALUES (1); END IF;", null,
           () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 0));
      proc('V47J a procedure with IF ELSE',
           "IF 1 = 0 THEN INSERT INTO v47_pt VALUES (1); ELSE INSERT INTO v47_pt VALUES (2); END IF;", null,
           () => eq(one('SELECT n FROM v47_pt'), 2));
      // プロシージャ内のローカル変数は @ を付けない綴り（MySQL のルーチン構文）
      proc('V47J a procedure with a WHILE loop',
           "DECLARE i INT DEFAULT 0; WHILE i < 5 DO INSERT INTO v47_pt VALUES (i); SET i = i + 1; END WHILE;",
           null, () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 5));
      proc('V47J a WHILE loop that never runs',
           "DECLARE i INT DEFAULT 9; WHILE i < 5 DO INSERT INTO v47_pt VALUES (i); SET i = i + 1; END WHILE;",
           null, () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 0));
      proc('V47J a procedure with a local variable in an expression',
           "DECLARE i INT DEFAULT 4; INSERT INTO v47_pt VALUES (i * 10);",
           null, () => eq(one('SELECT n FROM v47_pt'), 40));
      proc('V47J a procedure with nested IF branches',
           "IF 1 = 1 THEN IF 2 = 2 THEN INSERT INTO v47_pt VALUES (1); END IF; END IF;",
           null, () => eq(one('SELECT COUNT(*) AS c FROM v47_pt'), 1));
      proc('V47J a procedure returning a result set',
           "SELECT 42 AS answer;", null, (r) => eq(r.data[0].answer, 42));
      t('V47J a procedure with a parameter used in a filter', () => {
        mkWork();
        q('DROP PROCEDURE IF EXISTS v47_pr2');
        q('CREATE PROCEDURE v47_pr2(gg TEXT) BEGIN SELECT COUNT(*) AS c FROM v47_w WHERE g = gg; END');
        const got = rows("CALL v47_pr2('A')")[0].c;
        q('DROP PROCEDURE IF EXISTS v47_pr2');
        return eq(got, WORK.filter(r => r.g === 'A').length);
      });
      t('V47J a procedure with two parameters', () => {
        q('DROP PROCEDURE IF EXISTS v47_pr3');
        q('CREATE PROCEDURE v47_pr3(a INT, b INT) BEGIN SELECT a + b AS s; END');
        const got = rows('CALL v47_pr3(20, 22)')[0].s;
        q('DROP PROCEDURE IF EXISTS v47_pr3');
        return eq(got, 42);
      });

      // ============================================================
      // K. VALUES 文・TABLE 文
      // ============================================================
      t('V47K a VALUES statement returns its rows', () =>
        eq(rows("VALUES (1, 'a'), (2, 'b')").length, 2));
      t('V47K a VALUES statement names its columns', () => {
        const d = rows("VALUES (1, 'a')");
        return eq(Object.keys(d[0]).length, 2);
      });
      t('V47K a one-row VALUES statement', () => eq(rows('VALUES (1)').length, 1));
      t('V47K a twenty-row VALUES statement', () => {
        const vs = [];
        for (let i = 0; i < 20; i++) vs.push(`(${i})`);
        return eq(rows('VALUES ' + vs.join(',')).length, 20);
      });
      t('V47K a TABLE statement returns every row', () => {
        mkWork();
        return eq(rows('TABLE v47_w').length, 200);
      });
      t('V47K TABLE with ORDER BY and LIMIT', () => {
        mkWork();
        return eq(rows('TABLE v47_w ORDER BY id LIMIT 5').map(r => r.id), [0, 1, 2, 3, 4]);
      });
      t('V47K TABLE with OFFSET', () => {
        mkWork();
        return eq(rows('TABLE v47_w ORDER BY id LIMIT 3 OFFSET 2').map(r => r.id), [2, 3, 4]);
      });

      // ============================================================
      // L. セッション制御・権限系
      // ============================================================
      ['LOCK TABLES v47_src READ', 'LOCK TABLES v47_src WRITE', 'UNLOCK TABLES',
       'GRANT SELECT ON v47_src TO PUBLIC', 'REVOKE SELECT ON v47_src FROM PUBLIC',
       "COMMENT ON TABLE v47_src IS 'a source table'",
       "COMMENT ON COLUMN v47_src.v IS 'a value'"].forEach(cmd => {
        ok(`V47L ${cmd}`, cmd);
      });
      ok('V47L SHOW COMMENTS', 'SHOW COMMENTS');
      ok('V47L SHOW WARNINGS', 'SHOW WARNINGS');
      ok('V47L SHOW COUNT(*) WARNINGS', 'SHOW COUNT(*) WARNINGS');
      ok('V47L SHOW PROFILE', 'SHOW PROFILE');
      ok('V47L SHOW SLOW QUERIES', 'SHOW SLOW QUERIES');
      ok('V47L SHOW STORAGE', 'SHOW STORAGE');

      // ============================================================
      // M. DML の誤りは拒否される
      // ============================================================
      err('V47M INSERT into a missing table', "INSERT INTO v47_nosuch VALUES (1)");
      err('V47M INSERT with a missing column', "INSERT INTO v47_src (nosuch) VALUES (1)");
      err('V47M INSERT with too many values', "INSERT INTO v47_src (id) VALUES (1, 2)");
      err('V47M INSERT with too few values', "INSERT INTO v47_src (id, v, tag) VALUES (1)");
      err('V47M UPDATE a missing table', 'UPDATE v47_nosuch SET a = 1');
      err('V47M UPDATE a missing column', 'UPDATE v47_src SET nosuch = 1');
      err('V47M UPDATE with a missing column in WHERE', 'UPDATE v47_src SET v = 1 WHERE nosuch = 1');
      err('V47M DELETE from a missing table', 'DELETE FROM v47_nosuch');
      err('V47M DELETE with a missing column in WHERE', 'DELETE FROM v47_src WHERE nosuch = 1');
      err('V47M MERGE without ON', 'MERGE INTO v47_src t USING v47_src s WHEN MATCHED THEN DELETE');
      err('V47M EXECUTE a missing prepared statement', 'EXECUTE v47_nosuch');
      err('V47M ROLLBACK TO a missing savepoint', 'ROLLBACK TO SAVEPOINT v47_nosuch');
      err('V47M RESTORE a missing snapshot', 'RESTORE SNAPSHOT v47_nosuch');
      err('V47M CALL a missing procedure', 'CALL v47_nosuch()');
      err('V47M an unsupported statement', 'FROBNICATE THE DATABASE');
      t('V47M INSERT violating NOT NULL is rejected', () => {
        q('DROP TABLE IF EXISTS v47_nn');
        q('CREATE TABLE v47_nn (a INT NOT NULL)');
        const r = q('INSERT INTO v47_nn VALUES (NULL)');
        q('DROP TABLE IF EXISTS v47_nn');
        return eq(!!r.error, true);
      });

      // ============================================================
      // N. INSERT する値 × 受け側の列型 の行列
      // ============================================================
      const CELLTY = ['INT', 'BIGINT', 'DECIMAL(18,4)', 'FLOAT', 'TEXT', 'VARCHAR(50)', 'BOOLEAN', 'DATE'];
      const CELLVALS = [
        ['NULL', { INT: null, BIGINT: null, 'DECIMAL(18,4)': null, FLOAT: null,
                   TEXT: null, 'VARCHAR(50)': null, BOOLEAN: null, DATE: null }],
        ['0', { INT: 0, BIGINT: 0, 'DECIMAL(18,4)': 0, FLOAT: 0,
                TEXT: '0', 'VARCHAR(50)': '0', BOOLEAN: false, DATE: '__ERR__' }],
        ['1', { INT: 1, BIGINT: 1, 'DECIMAL(18,4)': 1, FLOAT: 1,
                TEXT: '1', 'VARCHAR(50)': '1', BOOLEAN: true, DATE: '__ERR__' }],
        ['-7', { INT: -7, BIGINT: -7, 'DECIMAL(18,4)': -7, FLOAT: -7,
                 TEXT: '-7', 'VARCHAR(50)': '-7', BOOLEAN: '__ERR__', DATE: '__ERR__' }],
        ['2.5', { INT: '__ERR__', BIGINT: '__ERR__', 'DECIMAL(18,4)': 2.5, FLOAT: 2.5,
                  TEXT: '2.5', 'VARCHAR(50)': '2.5', BOOLEAN: '__ERR__', DATE: '__ERR__' }],
        ["'abc'", { INT: '__ERR__', BIGINT: '__ERR__', 'DECIMAL(18,4)': '__ERR__', FLOAT: '__ERR__',
                    TEXT: 'abc', 'VARCHAR(50)': 'abc', BOOLEAN: '__ERR__', DATE: '__ERR__' }],
        ["'2024-03-15'", { INT: '__ERR__', BIGINT: '__ERR__', 'DECIMAL(18,4)': '__ERR__',
                           FLOAT: '__ERR__', TEXT: '2024-03-15', 'VARCHAR(50)': '2024-03-15',
                           BOOLEAN: '__ERR__', DATE: '2024-03-15' }],
        ['TRUE', { INT: '__ERR__', BIGINT: '__ERR__', 'DECIMAL(18,4)': '__ERR__', FLOAT: '__ERR__',
                   TEXT: 'true', 'VARCHAR(50)': 'true', BOOLEAN: true, DATE: '__ERR__' }],
      ];
      CELLTY.forEach(ty => CELLVALS.forEach(([lit, wants]) => {
        const want = wants[ty];
        t(`V47N INSERT ${lit} into a ${ty} column`, () => {
          q('DROP TABLE IF EXISTS v47_cell');
          q(`CREATE TABLE v47_cell (x ${ty})`);
          const r = q(`INSERT INTO v47_cell VALUES (${lit})`);
          let got;
          if (!r.error) got = one('SELECT x FROM v47_cell');
          q('DROP TABLE IF EXISTS v47_cell');
          if (want === '__ERR__') return eq(!!r.error, true);
          if (r.error) throw new Error(r.error);
          return eq(got, want);
        });
      }));

      // ============================================================
      // O. トランザクション × 操作種別 × 結末
      // ============================================================
      const TXOPS = [
        ['INSERT', "INSERT INTO v47_o VALUES (9, 90)", 3, 2],
        ['UPDATE', 'UPDATE v47_o SET v = 999', 2, 2],
        ['DELETE', 'DELETE FROM v47_o', 0, 2],
        ['INSERT twice', "INSERT INTO v47_o VALUES (9, 90); INSERT INTO v47_o VALUES (10, 100)", 4, 2],
        ['TRUNCATE', 'TRUNCATE TABLE v47_o', 0, 2],
        ['ALTER ADD COLUMN', 'ALTER TABLE v47_o ADD COLUMN z INT', 2, 2],
        ['CREATE INDEX', 'CREATE INDEX v47_oix ON v47_o (v)', 2, 2],
        ['INSERT then DELETE', "INSERT INTO v47_o VALUES (9, 90); DELETE FROM v47_o WHERE id = 1", 2, 2],
      ];
      TXOPS.forEach(([label, sql, afterCommit, afterRollback]) => {
        [['COMMIT', afterCommit], ['ROLLBACK', afterRollback]].forEach(([end, want]) => {
          t(`V47O ${label} inside a transaction ending in ${end}`, () => {
            q('DROP TABLE IF EXISTS v47_o');
            q('CREATE TABLE v47_o (id INT, v INT)');
            q('INSERT INTO v47_o VALUES (1, 10), (2, 20)');
            q('BEGIN');
            sql.split('; ').forEach(s => q(s));
            q(end);
            const c = one('SELECT COUNT(*) AS c FROM v47_o');
            q('DROP INDEX IF EXISTS v47_oix ON v47_o');
            q('DROP TABLE IF EXISTS v47_o');
            return eq(c, want);
          });
        });
      });

      // ============================================================
      // P. セッション変数 × 値の型
      // ============================================================
      const VARVALS = [['1', 1], ['-1', -1], ['2.5', 2.5], ["'abc'", 'abc'], ["''", ''],
                       ['NULL', null], ['TRUE', true], ['FALSE', false],
                       ['1 + 1', 2], ["UPPER('x')", 'X'], ['ABS(-3)', 3], ["LENGTH('abcd')", 4]];
      VARVALS.forEach(([lit, want], i) => {
        t(`V47P a user variable holds ${lit}`, () => {
          q(`SET @v47p${i} = ${lit}`);
          return eq(one(`SELECT @v47p${i} AS r`), want);
        });
        t(`V47P DECLARE holds ${lit}`, () => {
          q(`DECLARE @v47q${i} INT = ${lit}`);
          return eq(one(`SELECT @v47q${i} AS r`), want);
        });
      });
      t('V47P a user variable survives across statements', () => {
        q('SET @v47keep = 11');
        q('SELECT 1 AS ignored');
        return eq(one('SELECT @v47keep AS r'), 11);
      });
      t('V47P a user variable can be reassigned', () => {
        q('SET @v47re = 1'); q('SET @v47re = 2');
        return eq(one('SELECT @v47re AS r'), 2);
      });
      t('V47P a user variable can be used in an expression', () => {
        q('SET @v47x = 10');
        return eq(one('SELECT @v47x * 4 + 2 AS r'), 42);
      });

      // ============================================================
      // Q. 制約違反は変更を残さない
      // ============================================================
      const VIOLATIONS = [
        ['NOT NULL', 'a INT NOT NULL, b INT', "INSERT INTO v47_v VALUES (NULL, 1)"],
        ['CHECK', 'a INT CHECK (a >= 0), b INT', 'INSERT INTO v47_v VALUES (-1, 1)'],
        ['UNIQUE', 'a INT UNIQUE, b INT', 'INSERT INTO v47_v VALUES (1, 1)'],
        ['PRIMARY KEY', 'a INT PRIMARY KEY, b INT', 'INSERT INTO v47_v VALUES (1, 1)'],
        ['type', 'a INT, b INT', "INSERT INTO v47_v VALUES ('abc', 1)"],
      ];
      VIOLATIONS.forEach(([label, def, bad]) => {
        t(`V47Q a ${label} violation leaves the table unchanged`, () => {
          q('DROP TABLE IF EXISTS v47_v');
          q(`CREATE TABLE v47_v (${def})`);
          q('INSERT INTO v47_v VALUES (1, 1)');
          const before = one('SELECT COUNT(*) AS c FROM v47_v');
          const r = q(bad);
          const after = one('SELECT COUNT(*) AS c FROM v47_v');
          q('DROP TABLE IF EXISTS v47_v');
          return eq([!!r.error, before, after], [true, 1, 1]);
        });
        t(`V47Q a ${label} violation in a multi-row INSERT inserts nothing`, () => {
          q('DROP TABLE IF EXISTS v47_v');
          q(`CREATE TABLE v47_v (${def})`);
          q('INSERT INTO v47_v VALUES (1, 1)');
          const multi = bad.replace(/VALUES\s*(\([^)]*\))/i, 'VALUES (7, 7), $1, (8, 8)');
          const r = q(multi);
          const after = one('SELECT COUNT(*) AS c FROM v47_v');
          q('DROP TABLE IF EXISTS v47_v');
          return eq([!!r.error, after], [true, 1]);
        });
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V47Zz cleanup', () => {
        ['v47_cell', 'v47_o', 'v47_v', 'v47_nn'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        ['v47_w', 'v47_src', 'v47_i', 'v47_u', 'v47_tgt', 'v47_r', 'v47_t', 'v47_ck',
         'v47_pt', 'v47_inner'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        ['v47_pr', 'v47_pr2', 'v47_pr3'].forEach(n => q('DROP PROCEDURE IF EXISTS ' + n));
        ['v47_snap', 'v47_snap2', 'v47_snap3'].forEach(n => q('DROP SNAPSHOT IF EXISTS ' + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v47_') === 0).length === 0;
      });

      return T;
    }
