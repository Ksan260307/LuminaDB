    // ============================================================================
    // [Test Suite v41] - 大量行の DML・表関数・索引・総合シナリオ
    //
    //   作業表を毎回組み直してから DML を流すので、どの順に走らせても同じ答えになる。
    //   後半は表関数・JSON・配列・PIVOT と、索引の有無で結果が変わらないことの確認、
    //   最後に「実際に書きそうな」レポート系の問い合わせをまとめて置く。
    //
    //     A. フィクスチャ        E. RETURNING / トランザクション
    //     B. UPDATE の総当たり   F. 表関数 / JSON / 配列 / PIVOT
    //     C. DELETE の総当たり   G. 索引の有無による不変性・EXPLAIN・メタデータ
    //     D. INSERT / MERGE / upsert / 複数表 DML / 制約   H. 総合シナリオ
    //
    //   test-suite.js の tests 配列へ getV41Tests() のスプレッドで合流する
    // ============================================================================
    function getV41Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const run = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r; };
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows returned'); return Object.values(d[0])[0]; };
      const same = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 1e-9 : a === b;
      const expect = (actual, want, label) => {
        if (!same(actual, want)) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + JSON.stringify(want) + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectDeep = (actual, want, label) => {
        const a = JSON.stringify(actual), b = JSON.stringify(want);
        if (a !== b) throw new Error((label ? label + ' ' : '') + 'expected ' + b + ' but got ' + a);
        return true;
      };
      const val = (name, sql, want) => t(name, () => expect(one(sql), want));
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const cnt = (arr, f) => arr.filter(f).length;
      const uniq = (arr, f) => new Set(arr.map(f)).size;
      const byKey = (arr, keyf) => {
        const m = new Map();
        for (const x of arr) { const k = keyf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
        return m;
      };

      // ----------------------------------------------------------------
      // 模型（src は読み取り専用の元表、work はその写しを毎回作り直す）
      // ----------------------------------------------------------------
      const SRC = [];
      for (let n = 1; n <= 600; n++) {
        SRC.push({ id: n, g: 'W' + (n % 6), v: n % 45, w: 1 + (n % 19),
                   st: (n % 5 === 0) ? 'off' : 'on', nv: (n % 7 === 0) ? null : (n % 30) });
      }
      const DIM = [];
      for (let n = 1; n <= 120; n++) DIM.push({ id: n, tag: 'T' + (n % 4) });

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V41A build the source tables', () => {
        ['v41_src', 'v41_dim', 'v41_w', 'v41_u'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        let r = q("CREATE TABLE v41_src (id INT PRIMARY KEY, g TEXT, v INT, w INT, st TEXT, nv INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v41_src (id, g, v, w, st, nv) SELECT n, 'W' || (n % 6), n % 45, 1 + (n % 19), " +
              "CASE WHEN n % 5 = 0 THEN 'off' ELSE 'on' END, CASE WHEN n % 7 = 0 THEN NULL ELSE n % 30 END " +
              "FROM GENERATE_SERIES(1, 600) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v41_dim (id INT PRIMARY KEY, tag TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v41_dim (id, tag) SELECT n, 'T' || (n % 4) FROM GENERATE_SERIES(1, 120) AS g(n)");
        if (r.error) throw new Error(r.error);
        return db.tables['v41_src'].rowCount === 600 && db.tables['v41_dim'].rowCount === 120;
      });
      val('V41A src row count', "SELECT COUNT(*) FROM v41_src", SRC.length);
      val('V41A src SUM(v)', "SELECT SUM(v) FROM v41_src", sum(SRC, r => r.v));
      val('V41A src COUNT(nv)', "SELECT COUNT(nv) FROM v41_src", cnt(SRC, r => r.nv !== null));
      val('V41A dim row count', "SELECT COUNT(*) FROM v41_dim", DIM.length);

      // 作業表を元表の写しとして作り直す
      const buildW = () => {
        q("DROP TABLE IF EXISTS v41_w");
        run("CREATE TABLE v41_w AS SELECT id, g, v, w, st, nv FROM v41_src");
      };
      const nW = () => one("SELECT COUNT(*) FROM v41_w");
      const sW = () => one("SELECT SUM(v) FROM v41_w");

      t('V41A the work table is a faithful copy', () => { buildW(); return expect(nW(), SRC.length) && expect(sW(), sum(SRC, r => r.v)); });

      // ============================================================
      // B. UPDATE の総当たり
      // ============================================================
      const B_SETS = [
        ['v = v + 1', r => r.v + 1], ['v = v + 10', r => r.v + 10], ['v = v - 1', r => r.v - 1],
        ['v = v * 2', r => r.v * 2], ['v = v * 3', r => r.v * 3], ['v = 0', () => 0],
        ['v = 100', () => 100], ['v = v % 7', r => r.v % 7], ['v = ABS(v - 20)', r => Math.abs(r.v - 20)],
        ['v = v + w', r => r.v + r.w], ['v = v * w', r => r.v * r.w], ['v = w', r => r.w],
        ['v = CASE WHEN v > 20 THEN 1 ELSE 0 END', r => (r.v > 20 ? 1 : 0)],
        ['v = (SELECT COUNT(*) FROM v41_dim)', () => DIM.length],
        ['v = LENGTH(g) + w', r => r.g.length + r.w]
      ];
      const B_WHERES = [
        ['', () => true],
        ["WHERE g = 'W1'", r => r.g === 'W1'],
        ["WHERE v > 20", r => r.v > 20],
        ["WHERE v <= 10", r => r.v <= 10],
        ["WHERE st = 'off'", r => r.st === 'off'],
        ["WHERE id % 3 = 0", r => r.id % 3 === 0],
        ["WHERE nv IS NULL", r => r.nv === null],
        ["WHERE id BETWEEN 100 AND 300", r => r.id >= 100 && r.id <= 300],
        ["WHERE g IN ('W0', 'W2', 'W4')", r => ['W0', 'W2', 'W4'].indexOf(r.g) >= 0],
        ["WHERE w > 10 AND v < 30", r => r.w > 10 && r.v < 30]
      ];
      B_SETS.forEach((st, si) => {
        B_WHERES.forEach((wh, wi) => {
          void si; void wi;
          const wantSum = sum(SRC, r => wh[1](r) ? st[1](r) : r.v);
          const wantN = cnt(SRC, wh[1]);
          t('V41B SET ' + st[0] + ' ' + wh[0] + ' changes the right count', () => {
            buildW();
            const r = run("UPDATE v41_w SET " + st[0] + " " + wh[0]);
            return expect(Number(String(r.data[0].Message).split(' ')[0]), wantN);
          });
          t('V41B SET ' + st[0] + ' ' + wh[0] + ' leaves the right total', () => {
            buildW();
            run("UPDATE v41_w SET " + st[0] + " " + wh[0]);
            return expect(sW(), wantSum);
          });
          t('V41B SET ' + st[0] + ' ' + wh[0] + ' keeps the row count', () => {
            buildW();
            run("UPDATE v41_w SET " + st[0] + " " + wh[0]);
            return expect(nW(), SRC.length);
          });
        });
      });
      t('V41B updating two columns at once', () => {
        buildW();
        run("UPDATE v41_w SET v = v + 1, w = 0 WHERE g = 'W3'");
        return expect(one("SELECT SUM(v) FROM v41_w WHERE g = 'W3'"), sum(SRC.filter(r => r.g === 'W3'), r => r.v + 1)) &&
               expect(one("SELECT SUM(w) FROM v41_w WHERE g = 'W3'"), 0);
      });
      t('V41B UPDATE with ORDER BY and LIMIT', () => {
        buildW();
        run("UPDATE v41_w SET v = -1 ORDER BY id LIMIT 40");
        return expect(one("SELECT COUNT(*) FROM v41_w WHERE v = -1"), 40);
      });
      t('V41B UPDATE with a correlated subquery in SET', () => {
        buildW();
        run("UPDATE v41_w SET v = (SELECT COUNT(*) FROM v41_dim d WHERE d.id = v41_w.id)");
        return expect(sW(), cnt(SRC, r => r.id <= DIM.length));
      });
      t('V41B UPDATE that matches nothing changes nothing', () => {
        buildW();
        run("UPDATE v41_w SET v = -1 WHERE g = 'NOPE'");
        return expect(sW(), sum(SRC, r => r.v));
      });
      t('V41B two UPDATEs compose', () => {
        buildW();
        run("UPDATE v41_w SET v = v + 1");
        run("UPDATE v41_w SET v = v * 2");
        return expect(sW(), sum(SRC, r => (r.v + 1) * 2));
      });
      t('V41B UPDATE of a NULL-bearing column', () => {
        buildW();
        run("UPDATE v41_w SET nv = COALESCE(nv, 0)");
        return expect(one("SELECT COUNT(*) FROM v41_w WHERE nv IS NULL"), 0);
      });

      // ============================================================
      // C. DELETE の総当たり
      // ============================================================
      const C_WHERES = [
        ['', () => true],
        ["WHERE v > 20", r => r.v > 20],
        ["WHERE v <= 10", r => r.v <= 10],
        ["WHERE g = 'W2'", r => r.g === 'W2'],
        ["WHERE g <> 'W2'", r => r.g !== 'W2'],
        ["WHERE st = 'off'", r => r.st === 'off'],
        ["WHERE nv IS NULL", r => r.nv === null],
        ["WHERE nv IS NOT NULL", r => r.nv !== null],
        ["WHERE id % 2 = 0", r => r.id % 2 === 0],
        ["WHERE id % 5 = 0", r => r.id % 5 === 0],
        ["WHERE id <= 300", r => r.id <= 300],
        ["WHERE id > 500", r => r.id > 500],
        ["WHERE w BETWEEN 5 AND 12", r => r.w >= 5 && r.w <= 12],
        ["WHERE g IN ('W0', 'W3')", r => r.g === 'W0' || r.g === 'W3'],
        ["WHERE v * 2 > 60", r => r.v * 2 > 60],
        ["WHERE id IN (SELECT id FROM v41_dim)", r => r.id <= DIM.length],
        ["WHERE EXISTS (SELECT 1 FROM v41_dim d WHERE d.id = v41_w.id AND d.tag = 'T1')",
          r => DIM.some(d => d.id === r.id && d.tag === 'T1')],
        ["WHERE v > 20 AND st = 'on'", r => r.v > 20 && r.st === 'on'],
        ["WHERE v > 40 OR w > 17", r => r.v > 40 || r.w > 17],
        ["WHERE NOT (v > 20)", r => !(r.v > 20)]
      ];
      C_WHERES.forEach((wh, i) => {
        const gone = cnt(SRC, wh[1]);
        t('V41C DELETE ' + (wh[0] || '(every row)') + ' removes the right count', () => {
          buildW();
          run("DELETE FROM v41_w " + wh[0]);
          return expect(nW(), SRC.length - gone);
        });
        t('V41C DELETE ' + (wh[0] || '(every row)') + ' leaves the right total', () => {
          buildW();
          run("DELETE FROM v41_w " + wh[0]);
          return expect(one("SELECT COALESCE(SUM(v), 0) FROM v41_w"), sum(SRC.filter(r => !wh[1](r)), r => r.v));
        });
        t('V41C DELETE ' + (wh[0] || '(every row)') + ' reports the count', () => {
          buildW();
          const r = run("DELETE FROM v41_w " + wh[0]);
          return expect(String(r.data[0].Message), gone + ' rows deleted.');
        });
      });
      t('V41C DELETE with ORDER BY and LIMIT', () => {
        buildW();
        run("DELETE FROM v41_w ORDER BY id DESC LIMIT 50");
        return expect(nW(), SRC.length - 50) && expect(one("SELECT MAX(id) FROM v41_w"), SRC.length - 50);
      });
      t('V41C TRUNCATE empties the table', () => { buildW(); run("TRUNCATE TABLE v41_w"); return expect(nW(), 0); });
      t('V41C DELETE then re-INSERT restores the table', () => {
        buildW();
        run("DELETE FROM v41_w WHERE id > 200");
        run("INSERT INTO v41_w (id, g, v, w, st, nv) SELECT id, g, v, w, st, nv FROM v41_src WHERE id > 200");
        return expect(nW(), SRC.length) && expect(sW(), sum(SRC, r => r.v));
      });

      // ============================================================
      // D. INSERT / MERGE / upsert / 複数表 DML / 制約
      // ============================================================
      const D_INSERTS = [
        ["INSERT INTO v41_w (id, g, v) SELECT id + 10000, g, v FROM v41_src", SRC.length, sum(SRC, r => r.v)],
        ["INSERT INTO v41_w (id, g, v) SELECT id + 10000, g, v FROM v41_src WHERE v > 20",
          cnt(SRC, r => r.v > 20), sum(SRC.filter(r => r.v > 20), r => r.v)],
        ["INSERT INTO v41_w (id, g, v) SELECT id + 10000, g, v FROM v41_src WHERE st = 'off'",
          cnt(SRC, r => r.st === 'off'), sum(SRC.filter(r => r.st === 'off'), r => r.v)],
        ["INSERT INTO v41_w (id, v) SELECT 20000 + n, n % 10 FROM GENERATE_SERIES(1, 500) AS g(n)",
          500, (() => { let s = 0; for (let n = 1; n <= 500; n++) s += n % 10; return s; })()],
        ["INSERT INTO v41_w (id, v) SELECT 30000 + n, n FROM GENERATE_SERIES(1, 100) AS g(n)", 100, 5050],
        ["INSERT INTO v41_w (id, g, v) SELECT id + 40000, UPPER(g), v * 2 FROM v41_src WHERE id <= 100",
          100, sum(SRC.filter(r => r.id <= 100), r => r.v * 2)]
      ];
      D_INSERTS.forEach((c, i) => {
        t('V41D insert#' + (i + 1) + ' adds the right number of rows', () => {
          buildW(); run(c[0]);
          return expect(nW(), SRC.length + c[1]);
        });
        t('V41D insert#' + (i + 1) + ' adds the right total', () => {
          buildW(); run(c[0]);
          return expect(sW(), sum(SRC, r => r.v) + c[2]);
        });
      });
      t('V41D a 150-row VALUES list', () => {
        buildW();
        const vals = Array.from({ length: 150 }, (_, i) => "(" + (50000 + i) + ", 'WV', " + i + ")").join(', ');
        run("INSERT INTO v41_w (id, g, v) VALUES " + vals);
        return expect(nW(), SRC.length + 150) && expect(sW(), sum(SRC, r => r.v) + 149 * 150 / 2);
      });
      t('V41D INSERT with the SET syntax', () => {
        buildW(); run("INSERT INTO v41_w SET id = 60000, g = 'WS', v = 5");
        return expect(nW(), SRC.length + 1);
      });
      t('V41D SELECT INTO creates a new table', () => {
        q("DROP TABLE IF EXISTS v41_into");
        run("SELECT id, v INTO v41_into FROM v41_src WHERE v < 10");
        const ok = one("SELECT COUNT(*) FROM v41_into") === cnt(SRC, r => r.v < 10);
        q("DROP TABLE IF EXISTS v41_into");
        return ok;
      });
      t('V41D CREATE TABLE AS over a join', () => {
        q("DROP TABLE IF EXISTS v41_ctas");
        run("CREATE TABLE v41_ctas AS SELECT s.id, s.v, d.tag FROM v41_src s JOIN v41_dim d ON d.id = s.id");
        const ok = one("SELECT COUNT(*) FROM v41_ctas") === DIM.length;
        q("DROP TABLE IF EXISTS v41_ctas");
        return ok;
      });
      t('V41D CREATE TABLE AS over a CTE', () => {
        q("DROP TABLE IF EXISTS v41_ctas");
        run("CREATE TABLE v41_ctas AS WITH base AS (SELECT id, v FROM v41_src WHERE v > 30) SELECT * FROM base");
        const ok = one("SELECT COUNT(*) FROM v41_ctas") === cnt(SRC, r => r.v > 30);
        q("DROP TABLE IF EXISTS v41_ctas");
        return ok;
      });
      const D_MERGES = [
        ["WHEN MATCHED THEN UPDATE SET v = s.v", 200, () => sum(SRC, r => r.id <= 200 ? r.v * 2 : r.v)],
        ["WHEN MATCHED THEN UPDATE SET v = 0", 200, () => sum(SRC, r => r.id <= 200 ? 0 : r.v)],
        ["WHEN MATCHED THEN DELETE", 200, () => sum(SRC.filter(r => r.id > 200), r => r.v)]
      ];
      D_MERGES.forEach((c, i) => {
        t('V41D merge#' + (i + 1) + ' ' + c[0], () => {
          buildW();
          run("MERGE INTO v41_w t USING (SELECT id, v * 2 AS v FROM v41_src WHERE id <= 200) s ON (t.id = s.id) " + c[0]);
          return expect(one("SELECT COALESCE(SUM(v), 0) FROM v41_w"), c[2]());
        });
      });
      t('V41D MERGE inserts the rows that do not match', () => {
        buildW();
        run("MERGE INTO v41_w t USING (SELECT id + 5000 AS id, v FROM v41_src WHERE id <= 150) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)");
        return expect(nW(), SRC.length + 150);
      });
      const buildU = () => {
        q("DROP TABLE IF EXISTS v41_u");
        run("CREATE TABLE v41_u (id INT PRIMARY KEY, v INT)");
        run("INSERT INTO v41_u (id, v) SELECT n, n FROM GENERATE_SERIES(1, 400) AS g(n)");
      };
      const D_UPSERTS = [
        ["INSERT INTO v41_u (id, v) VALUES (5, 999) ON DUPLICATE KEY UPDATE v = 999", 5, 999, 400],
        ["INSERT INTO v41_u (id, v) VALUES (5, 999) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v", 5, 999, 400],
        ["INSERT INTO v41_u (id, v) VALUES (5, 999) ON CONFLICT (id) DO NOTHING", 5, 5, 400],
        ["INSERT OR IGNORE INTO v41_u (id, v) VALUES (5, 999)", 5, 5, 400],
        ["INSERT IGNORE INTO v41_u (id, v) VALUES (5, 999)", 5, 5, 400],
        ["INSERT OR REPLACE INTO v41_u (id, v) VALUES (5, 999)", 5, 999, 400],
        ["REPLACE INTO v41_u (id, v) VALUES (5, 888)", 5, 888, 400],
        ["INSERT INTO v41_u (id, v) VALUES (900, 7) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v", 900, 7, 401]
      ];
      D_UPSERTS.forEach((c, i) => {
        t('V41D upsert#' + (i + 1) + ' sets the value', () => { buildU(); run(c[0]); return expect(one("SELECT v FROM v41_u WHERE id = " + c[1]), c[2]); });
        t('V41D upsert#' + (i + 1) + ' keeps the row count', () => { buildU(); run(c[0]); return expect(one("SELECT COUNT(*) FROM v41_u"), c[3]); });
      });
      t('V41D a clashing insert without a conflict clause is refused', () => {
        buildU();
        const r = q("INSERT INTO v41_u (id, v) VALUES (5, 1)");
        return !!r.error && /PRIMARY KEY/i.test(r.error);
      });
      t('V41D UPDATE ... FROM another table', () => {
        buildW();
        run("UPDATE v41_w SET v = d.id FROM v41_dim d WHERE d.id = v41_w.id");
        return expect(one("SELECT SUM(v) FROM v41_w WHERE id <= 120"), sum(DIM, d => d.id));
      });
      t('V41D UPDATE ... FROM leaves the other rows alone', () => {
        buildW();
        run("UPDATE v41_w SET v = 0 FROM v41_dim d WHERE d.id = v41_w.id");
        return expect(one("SELECT SUM(v) FROM v41_w WHERE id > 120"), sum(SRC.filter(r => r.id > 120), r => r.v));
      });
      t('V41D DELETE ... USING another table', () => {
        buildW();
        run("DELETE FROM v41_w USING v41_dim d WHERE d.id = v41_w.id AND d.tag = 'T2'");
        return expect(nW(), SRC.length - cnt(DIM, d => d.tag === 'T2'));
      });
      const D_CONSTRAINTS = [
        ["CREATE TABLE v41_k (id INT PRIMARY KEY, v INT CHECK (v >= 0))", "INSERT INTO v41_k (id, v) VALUES (1, -1)", 'CHECK'],
        ["CREATE TABLE v41_k (id INT PRIMARY KEY, v INT NOT NULL)", "INSERT INTO v41_k (id, v) VALUES (1, NULL)", 'NOT NULL'],
        ["CREATE TABLE v41_k (id INT PRIMARY KEY, v INT UNIQUE)", "INSERT INTO v41_k (id, v) VALUES (1, 1)", 'UNIQUE']
      ];
      D_CONSTRAINTS.forEach((c, i) => {
        t('V41D constraint#' + (i + 1) + ' rejects the bad row', () => {
          q("DROP TABLE IF EXISTS v41_k");
          run(c[0]);
          run("INSERT INTO v41_k (id, v) SELECT n, n FROM GENERATE_SERIES(1, 200) AS g(n)");
          const before = one("SELECT COUNT(*) FROM v41_k");
          const bad = q(c[1].replace('(1, ', '(201, '));
          const after = one("SELECT COUNT(*) FROM v41_k");
          q("DROP TABLE IF EXISTS v41_k");
          return !!bad.error && expect(after, before, 'row count unchanged');
        });
      });
      t('V41D a DEFAULT fills the missing column', () => {
        q("DROP TABLE IF EXISTS v41_k");
        run("CREATE TABLE v41_k (id INT, v INT DEFAULT 9)");
        run("INSERT INTO v41_k (id) SELECT n FROM GENERATE_SERIES(1, 300) AS g(n)");
        const ok = one("SELECT SUM(v) FROM v41_k") === 2700;
        q("DROP TABLE IF EXISTS v41_k");
        return ok;
      });
      t('V41D a generated column is computed for every row', () => {
        q("DROP TABLE IF EXISTS v41_k");
        run("CREATE TABLE v41_k (id INT, v INT, d INT GENERATED ALWAYS AS (v * 3))");
        run("INSERT INTO v41_k (id, v) SELECT n, n FROM GENERATE_SERIES(1, 200) AS g(n)");
        const ok = one("SELECT SUM(d) FROM v41_k") === 3 * 200 * 201 / 2;
        q("DROP TABLE IF EXISTS v41_k");
        return ok;
      });
      t('V41D AUTO_INCREMENT numbers a bulk load', () => {
        q("DROP TABLE IF EXISTS v41_k");
        run("CREATE TABLE v41_k (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INT)");
        run("INSERT INTO v41_k (v) SELECT n FROM GENERATE_SERIES(1, 250) AS g(n)");
        const ok = one("SELECT MAX(id) FROM v41_k") === 250 && one("SELECT COUNT(DISTINCT id) FROM v41_k") === 250;
        q("DROP TABLE IF EXISTS v41_k");
        return ok;
      });

      // ============================================================
      // E. RETURNING / トランザクション
      // ============================================================
      const E_RETURNING = [
        ["UPDATE v41_w SET v = v + 1 WHERE g = 'W1' RETURNING id", cnt(SRC, r => r.g === 'W1')],
        ["UPDATE v41_w SET v = 0 WHERE v > 30 RETURNING id, v", cnt(SRC, r => r.v > 30)],
        ["DELETE FROM v41_w WHERE st = 'off' RETURNING id", cnt(SRC, r => r.st === 'off')],
        ["DELETE FROM v41_w WHERE id % 4 = 0 RETURNING *", cnt(SRC, r => r.id % 4 === 0)],
        ["UPDATE v41_w SET v = v RETURNING id", SRC.length],
        ["INSERT INTO v41_w (id, v) SELECT id + 70000, v FROM v41_src WHERE id <= 90 RETURNING id", 90]
      ];
      E_RETURNING.forEach((c, i) => {
        t('V41E returning#' + (i + 1) + ' gives back the right number of rows', () => {
          buildW();
          const r = run(c[0]);
          return expect(r.data.length, c[1]);
        });
      });
      t('V41E RETURNING shows the new values', () => {
        buildW();
        const r = run("UPDATE v41_w SET v = 42 WHERE id <= 4 RETURNING id, v");
        return expectDeep(r.data.map(x => x.v), [42, 42, 42, 42]);
      });
      const E_TX = [
        ["DELETE FROM v41_w WHERE id > 100", 'ROLLBACK', SRC.length],
        ["DELETE FROM v41_w WHERE id > 100", 'COMMIT', 100],
        ["UPDATE v41_w SET v = 0", 'ROLLBACK', SRC.length],
        ["UPDATE v41_w SET v = 0", 'COMMIT', SRC.length],
        ["INSERT INTO v41_w (id, v) SELECT id + 80000, v FROM v41_src", 'ROLLBACK', SRC.length],
        ["INSERT INTO v41_w (id, v) SELECT id + 80000, v FROM v41_src", 'COMMIT', SRC.length * 2]
      ];
      E_TX.forEach((c, i) => {
        t('V41E transaction#' + (i + 1) + ' ' + c[1] + ' after [' + c[0].slice(0, 30) + ']', () => {
          buildW();
          run("BEGIN"); run(c[0]); run(c[1]);
          return expect(nW(), c[2]);
        });
      });
      t('V41E ROLLBACK restores the totals', () => {
        buildW();
        run("BEGIN"); run("UPDATE v41_w SET v = v * 5"); run("ROLLBACK");
        return expect(sW(), sum(SRC, r => r.v));
      });
      t('V41E ROLLBACK TO a savepoint keeps the earlier work', () => {
        buildW();
        run("BEGIN");
        run("DELETE FROM v41_w WHERE id > 500");
        run("SAVEPOINT sp1");
        run("DELETE FROM v41_w WHERE id > 300");
        run("ROLLBACK TO sp1");
        const mid = nW();
        run("COMMIT");
        return expect(mid, 500) && expect(nW(), 500);
      });
      t('V41E two savepoints in one transaction', () => {
        buildW();
        run("BEGIN");
        run("DELETE FROM v41_w WHERE id > 500"); run("SAVEPOINT a");
        run("DELETE FROM v41_w WHERE id > 400"); run("SAVEPOINT b");
        run("DELETE FROM v41_w WHERE id > 300");
        run("ROLLBACK TO b"); const afterB = nW();
        run("ROLLBACK TO a"); const afterA = nW();
        run("COMMIT");
        return expect(afterB, 400) && expect(afterA, 500);
      });
      t('V41E RELEASE keeps the work of the savepoint', () => {
        buildW();
        run("BEGIN");
        run("DELETE FROM v41_w WHERE id > 500"); run("SAVEPOINT sp1");
        run("DELETE FROM v41_w WHERE id > 200"); run("RELEASE sp1"); run("COMMIT");
        return expect(nW(), 200);
      });
      t('V41E many statements inside one transaction', () => {
        buildW();
        run("BEGIN");
        for (let i = 0; i < 40; i++) run("UPDATE v41_w SET v = v + 1 WHERE id = " + (i + 1));
        run("COMMIT");
        return expect(sW(), sum(SRC, r => r.v) + 40);
      });
      t('V41E rolling back many statements', () => {
        buildW();
        run("BEGIN");
        for (let i = 0; i < 40; i++) run("UPDATE v41_w SET v = v + 1 WHERE id = " + (i + 1));
        run("ROLLBACK");
        return expect(sW(), sum(SRC, r => r.v));
      });

      // ============================================================
      // F. 表関数 / JSON / 配列 / PIVOT
      // ============================================================
      [10, 100, 500, 1000, 2500, 5000].forEach(n => {
        val('V41F GENERATE_SERIES(1, ' + n + ') row count', "SELECT COUNT(*) FROM GENERATE_SERIES(1, " + n + ") AS g(n)", n);
        val('V41F GENERATE_SERIES(1, ' + n + ') sum', "SELECT SUM(n) FROM GENERATE_SERIES(1, " + n + ") AS g(n)",
            n * (n + 1) / 2);
        val('V41F GENERATE_SERIES(1, ' + n + ') filtered', "SELECT COUNT(*) FROM GENERATE_SERIES(1, " + n + ") AS g(n) WHERE n % 3 = 0",
            Math.floor(n / 3));
      });
      [2, 3, 4, 5, 7, 10, 25].forEach(step => {
        val('V41F GENERATE_SERIES with step ' + step,
            "SELECT COUNT(*) FROM GENERATE_SERIES(0, 1000, " + step + ") AS g(n)", Math.floor(1000 / step) + 1);
      });
      val('V41F GENERATE_SERIES counting down', "SELECT COUNT(*) FROM GENERATE_SERIES(500, 1, -1) AS g(n)", 500);
      val('V41F GENERATE_SERIES of an empty range', "SELECT COUNT(*) FROM GENERATE_SERIES(10, 1) AS g(n)", 0);
      val('V41F GENERATE_SERIES joined to a table',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 600) AS g(n) JOIN v41_src s ON s.id = g.n", SRC.length);
      val('V41F GENERATE_SERIES over dates',
          "SELECT COUNT(*) FROM GENERATE_SERIES(DATE '2024-01-01', DATE '2024-03-31', INTERVAL 1 DAY) AS g(d)", 91);
      [2, 5, 10, 40, 100].forEach(n => {
        const strv = Array.from({ length: n }, (_, i) => 'p' + i).join(',');
        val('V41F STRING_SPLIT of ' + n + ' parts', "SELECT COUNT(*) FROM STRING_SPLIT('" + strv + "', ',')", n);
      });
      val('V41F STRING_SPLIT with a multi-character separator', "SELECT COUNT(*) FROM STRING_SPLIT('a--b--c', '--')", 3);
      [3, 10, 50, 200].forEach(n => {
        const arr = Array.from({ length: n }, (_, i) => i).join(', ');
        val('V41F UNNEST of a ' + n + '-element array', "SELECT COUNT(*) FROM UNNEST(ARRAY[" + arr + "]) AS u(v)", n);
        val('V41F UNNEST of a ' + n + '-element array sums', "SELECT SUM(v) FROM UNNEST(ARRAY[" + arr + "]) AS u(v)",
            n * (n - 1) / 2);
        val('V41F ARRAY_LENGTH of a ' + n + '-element array', "SELECT ARRAY_LENGTH(ARRAY[" + arr + "])", n);
      });
      t('V41F UNNEST WITH ORDINALITY numbers the rows', () =>
        expectDeep(rows("SELECT v, i FROM UNNEST(ARRAY[10, 20, 30]) WITH ORDINALITY AS u(v, i) ORDER BY i"),
                   [{ v: 10, i: 1 }, { v: 20, i: 2 }, { v: 30, i: 3 }]));
      const ARRF = [
        ["ARRAY_POSITION(ARRAY[5, 6, 7], 7)", 3], ["ARRAY_CONTAINS(ARRAY[1, 2, 3], 2)", true],
        ["ARRAY_CONTAINS(ARRAY[1, 2, 3], 9)", false], ["ARRAY_LENGTH(ARRAY_APPEND(ARRAY[1, 2], 3))", 3],
        ["ARRAY_LENGTH(ARRAY_PREPEND(0, ARRAY[1, 2]))", 3], ["ARRAY_LENGTH(ARRAY_REMOVE(ARRAY[1, 2, 3], 2))", 2],
        ["ARRAY_TO_STRING(ARRAY_SORT(ARRAY[3, 1, 2]), ',')", '1,2,3'],
        ["ARRAY_TO_STRING(ARRAY[1, 2, 3], '-')", '1-2-3'],
        ["ARRAY_LENGTH(STRING_TO_ARRAY('a,b,c,d', ','))", 4],
        ["ARRAY_TO_STRING(ARRAY_SORT(ARRAY['c', 'a', 'b']), '')", 'abc']
      ];
      ARRF.forEach((c, i) => val('V41F array#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " AS x", c[1]));
      val('V41F = ANY over an array literal', "SELECT COUNT(*) FROM v41_src WHERE g = ANY(ARRAY['W0', 'W3'])",
          cnt(SRC, r => r.g === 'W0' || r.g === 'W3'));
      val('V41F <> ALL over an array literal', "SELECT COUNT(*) FROM v41_src WHERE g <> ALL(ARRAY['W0', 'W3'])",
          cnt(SRC, r => r.g !== 'W0' && r.g !== 'W3'));
      const JSONF = [
        ["JSON_EXTRACT('{\"a\":[10,20,30]}', '$.a[1]')", 20],
        ["JSON_EXTRACT('{\"a\":{\"b\":{\"c\":7}}}', '$.a.b.c')", 7],
        ["JSON_LENGTH('[1,2,3,4,5]')", 5], ["JSON_TYPE('[1,2]')", 'ARRAY'],
        ["JSON_VALID('{\"a\":1}')", 1], ["JSON_VALID('{a:1')", 0],
        ["JSON_KEYS('{\"a\":1,\"b\":2}')", '["a","b"]'],
        ["JSON_EXTRACT(JSON_SET('{\"a\":1}', '$.a', 9), '$.a')", 9],
        ["JSON_LENGTH(JSON_REMOVE('{\"a\":1,\"b\":2}', '$.a'))", 1],
        ["JSON_LENGTH(JSON_ARRAY(1, 2, 3, 4, 5))", 5],
        ["JSON_DEPTH('{\"a\":{\"b\":1}}')", 3]
      ];
      JSONF.forEach((c, i) => val('V41F json#' + (i + 1) + ' ' + c[0].slice(0, 40), "SELECT " + c[0] + " AS x", c[1]));
      val('V41F JSON_TABLE turns an array into rows',
          "SELECT COUNT(*) FROM JSON_TABLE('[{\"a\":1},{\"a\":2},{\"a\":3}]', '$[*]' COLUMNS (a INT PATH '$.a')) jt", 3);
      val('V41F JSON_TABLE sums the extracted column',
          "SELECT SUM(a) FROM JSON_TABLE('[{\"a\":1},{\"a\":2},{\"a\":3}]', '$[*]' COLUMNS (a INT PATH '$.a')) jt", 6);
      val('V41F JSON_OBJECT built per row is always valid',
          "SELECT COUNT(*) FROM v41_src WHERE JSON_VALID(JSON_OBJECT('id', id, 'g', g))", SRC.length);
      val('V41F JSON_ARRAYAGG holds every element',
          "SELECT JSON_LENGTH(JSON_ARRAYAGG(id)) FROM v41_src WHERE id <= 200", 200);
      t('V41F PIVOT turns a column into columns', () => {
        const m = byKey(SRC, r => r.g);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => ({ g: k, on: sum(m.get(k).filter(r => r.st === 'on'), r => r.v),
                                      off: sum(m.get(k).filter(r => r.st === 'off'), r => r.v) }));
        return expectDeep(rows("SELECT * FROM (SELECT g, st, v FROM v41_src) src " +
                               "PIVOT (SUM(v) FOR st IN ('on', 'off')) ORDER BY g"), want);
      });
      t('V41F PIVOT with COUNT', () => {
        const m = byKey(SRC, r => r.g);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => ({ g: k, on: cnt(m.get(k), r => r.st === 'on'), off: cnt(m.get(k), r => r.st === 'off') }));
        return expectDeep(rows("SELECT * FROM (SELECT g, st, v FROM v41_src) src " +
                               "PIVOT (COUNT(v) FOR st IN ('on', 'off')) ORDER BY g"), want);
      });
      val('V41F PIVOT columns add back up to the total',
          "SELECT SUM(on + off) FROM (SELECT * FROM (SELECT g, st, v FROM v41_src) src " +
          "PIVOT (SUM(v) FOR st IN ('on', 'off'))) z", sum(SRC, r => r.v));
      t('V41F UNPIVOT turns columns back into rows', () =>
        expectDeep(rows("SELECT * FROM (SELECT 1 AS id, 10 AS p, 20 AS r, 30 AS s) t UNPIVOT (val FOR col IN (p, r, s))"),
                   [{ id: 1, col: 'p', val: 10 }, { id: 1, col: 'r', val: 20 }, { id: 1, col: 's', val: 30 }]));
      val('V41F UNPIVOT row count over several source rows',
          "SELECT COUNT(*) FROM (SELECT id, v, w FROM v41_src WHERE id <= 50) t UNPIVOT (val FOR col IN (v, w))", 100);
      val('V41F UNPIVOT keeps the totals',
          "SELECT SUM(val) FROM (SELECT id, v, w FROM v41_src WHERE id <= 50) t UNPIVOT (val FOR col IN (v, w))",
          sum(SRC.filter(r => r.id <= 50), r => r.v + r.w));

      // ============================================================
      // G. 索引の有無による不変性 / EXPLAIN / メタデータ
      // ============================================================
      const G_QUERIES = [];
      [['v', r => r.v, [5, 10, 15, 25, 35, 44]], ['w', r => r.w, [4, 9, 14, 18]],
       ['id', r => r.id, [100, 250, 450, 599]]].forEach(spec => {
          [['=', (u, x) => u === x], ['>', (u, x) => u > x], ['<', (u, x) => u < x],
           ['>=', (u, x) => u >= x], ['<>', (u, x) => u !== x]].forEach(op => {
            spec[2].forEach(lit => {
              const p = spec[0] + ' ' + op[0] + ' ' + lit;
              const hit = SRC.filter(r => op[1](spec[1](r), lit));
              G_QUERIES.push(["SELECT COUNT(*) FROM v41_src WHERE " + p, hit.length]);
              G_QUERIES.push(["SELECT COALESCE(SUM(v), 0) FROM v41_src WHERE " + p, sum(hit, r => r.v)]);
            });
          });
        });
      [["SELECT COUNT(*) FROM v41_src WHERE g = 'W2'", cnt(SRC, r => r.g === 'W2')],
       ["SELECT COUNT(*) FROM v41_src WHERE st = 'off'", cnt(SRC, r => r.st === 'off')],
       ["SELECT COUNT(*) FROM v41_src s JOIN v41_dim d ON d.id = s.id", DIM.length],
       ["SELECT COUNT(DISTINCT g) FROM v41_src", uniq(SRC, r => r.g)],
       ["SELECT MAX(v) FROM v41_src", Math.max.apply(null, SRC.map(r => r.v))],
       ["SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM v41_src GROUP BY g) z", uniq(SRC, r => r.g)]]
        .forEach(c => G_QUERIES.push(c));
      G_QUERIES.forEach((c, i) => val('V41G invariant#' + (i + 1) + ' without an index', c[0], c[1]));
      t('V41G build the indexes', () => {
        ['v41_ix_v', 'v41_ix_g', 'v41_ix_sw'].forEach(n => q("DROP INDEX IF EXISTS " + n));
        let r = q("CREATE INDEX v41_ix_v ON v41_src (v)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v41_ix_g ON v41_src (g)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v41_ix_sw ON v41_src (st, w)");
        if (r.error) throw new Error(r.error);
        return true;
      });
      G_QUERIES.forEach((c, i) => val('V41G invariant#' + (i + 1) + ' with the indexes in place', c[0], c[1]));
      t('V41G an index scan is chosen for an indexed column', () => {
        const ops = rows("EXPLAIN SELECT * FROM v41_src WHERE v = 5").map(x => x.Operation);
        if (ops.indexOf('INDEX SCAN') < 0) throw new Error('expected an INDEX SCAN but got ' + JSON.stringify(ops));
        return true;
      });
      t('V41G drop the indexes', () => {
        ['v41_ix_v', 'v41_ix_g', 'v41_ix_sw'].forEach(n => q("DROP INDEX IF EXISTS " + n));
        return expect(one("SELECT COUNT(*) FROM v41_src WHERE v = 5"), cnt(SRC, r => r.v === 5));
      });
      const G_EXPLAIN = [
        ['a plain scan', "SELECT * FROM v41_src", ['TABLE SCAN']],
        ['a filtered scan', "SELECT * FROM v41_src WHERE v > 3", ['TABLE SCAN', 'FILTER']],
        ['a grouped query', "SELECT g, COUNT(*) FROM v41_src GROUP BY g", ['TABLE SCAN', 'GROUP BY']],
        ['an ungrouped aggregate', "SELECT COUNT(*) FROM v41_src", ['TABLE SCAN', 'AGGREGATE']],
        ['a DISTINCT query', "SELECT DISTINCT g FROM v41_src", ['TABLE SCAN', 'DISTINCT']],
        ['a window query', "SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v41_src", ['TABLE SCAN', 'WINDOW']],
        ['a sorted query', "SELECT * FROM v41_src ORDER BY v DESC", ['TABLE SCAN', 'ORDER BY']],
        ['a limited query', "SELECT * FROM v41_src LIMIT 10", ['TABLE SCAN', 'LIMIT']]
      ];
      G_EXPLAIN.forEach((c, i) => {
        t('V41G EXPLAIN of ' + c[0] + ' names the expected steps', () => {
          const ops = rows("EXPLAIN " + c[1]).map(x => x.Operation);
          c[2].forEach(op => { if (ops.indexOf(op) < 0) throw new Error('missing ' + op + ' in ' + JSON.stringify(ops)); });
          return true;
        });
        t('V41G EXPLAIN of ' + c[0] + ' numbers its steps', () => {
          const steps = rows("EXPLAIN " + c[1]).map(x => x.Step);
          return expectDeep(steps, steps.map((_, j) => j + 1));
        });
      });
      t('V41G EXPLAIN estimates the scan row count', () =>
        expect(rows("EXPLAIN SELECT * FROM v41_src")[0].Rows, SRC.length));
      t('V41G EXPLAIN (FORMAT JSON) returns parseable JSON', () => {
        const parsed = JSON.parse(String(one("EXPLAIN (FORMAT JSON) SELECT * FROM v41_src WHERE v > 3")));
        return Array.isArray(parsed) && parsed.length > 0;
      });
      t('V41G EXPLAIN ANALYZE adds an actual-timing row', () =>
        rows("EXPLAIN ANALYZE SELECT COUNT(*) FROM v41_src").map(x => x.Operation).indexOf('ACTUAL') >= 0);
      t('V41G ANALYZE reports one row per column', () => expect(rows("ANALYZE TABLE v41_src").length, 6));
      t('V41G ANALYZE counts the rows', () => expect(rows("ANALYZE TABLE v41_src")[0].Rows, SRC.length));
      t('V41G ANALYZE counts the NULLs', () => {
        const r = rows("ANALYZE TABLE v41_src").filter(x => x.Column === 'nv')[0];
        return expect(r.Nulls, cnt(SRC, x => x.nv === null));
      });
      t('V41G CHECK TABLE reports OK', () => rows("CHECK TABLE v41_src").every(x => x.Status === 'OK'));
      t('V41G DESCRIBE lists every column', () => expect(rows("DESCRIBE v41_src").length, 6));
      t('V41G information_schema knows the table', () =>
        expect(one("SELECT COUNT(*) FROM information_schema.columns WHERE TABLE_NAME = 'v41_src'"), 6));
      t('V41G PRAGMA table_info describes the table', () => expect(rows("PRAGMA table_info(v41_src)").length, 6));

      // ---- 述語 x 集計の総当たり（読み取りのみ） ----
      const G_PREDS = [];
      [['v', r => r.v, [3, 9, 18, 27, 36, 43, 44, 1]], ['w', r => r.w, [2, 6, 10, 14, 18, 19, 1]],
       ['id', r => r.id, [50, 150, 300, 450, 550, 600, 1]]].forEach(spec => {
        [['>', (u, x) => u > x], ['<', (u, x) => u < x], ['>=', (u, x) => u >= x], ['<=', (u, x) => u <= x]].forEach(op => {
          spec[2].forEach(lit => G_PREDS.push([spec[0] + ' ' + op[0] + ' ' + lit, r => op[1](spec[1](r), lit)]));
        });
      });
      [["g = 'W0'", r => r.g === 'W0'], ["g <> 'W0'", r => r.g !== 'W0'],
       ["st = 'on'", r => r.st === 'on'], ["st = 'off'", r => r.st === 'off'],
       ["nv IS NULL", r => r.nv === null], ["nv IS NOT NULL", r => r.nv !== null]].forEach(p => G_PREDS.push(p));
      const G_AGGS = [
        ['COUNT(*)', g => g.length],
        ['COALESCE(SUM(v), 0)', g => sum(g, r => r.v)],
        ['COALESCE(SUM(w), 0)', g => sum(g, r => r.w)],
        ['COUNT(DISTINCT g)', g => uniq(g, r => r.g)],
        ['COUNT(nv)', g => cnt(g, r => r.nv !== null)]
      ];
      G_PREDS.forEach((p, i) => {
        const hit = SRC.filter(p[1]);
        G_AGGS.forEach(ag => {
          val('V41G agg#' + (i + 1) + ' [' + p[0] + '] ' + ag[0],
              "SELECT " + ag[0] + " FROM v41_src WHERE " + p[0], ag[1](hit));
        });
        val('V41G agg#' + (i + 1) + ' [' + p[0] + '] through a derived table',
            "SELECT COUNT(*) FROM (SELECT id FROM v41_src WHERE " + p[0] + ") z", hit.length);
        val('V41G agg#' + (i + 1) + ' [' + p[0] + '] grouped',
            "SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM v41_src WHERE " + p[0] + " GROUP BY g) z",
            uniq(hit, r => r.g));
      });

      // ============================================================
      // H. 総合シナリオ
      // ============================================================
      t('V41H a grouped report with filters and ordering', () => {
        const hit = SRC.filter(r => r.st === 'on' && r.v > 5);
        const m = byKey(hit, r => r.g);
        const want = [...m.entries()].map(e => ({ g: e[0], n: e[1].length, s: sum(e[1], r => r.v) }))
                       .sort((a, b) => b.s - a.s || (a.g < b.g ? -1 : 1));
        return expectDeep(rows("SELECT g AS g, COUNT(*) AS n, SUM(v) AS s FROM v41_src WHERE st = 'on' AND v > 5 " +
                               "GROUP BY g ORDER BY s DESC, g"), want);
      });
      t('V41H a report joining the dimension', () => {
        const joined = SRC.filter(r => r.id <= DIM.length).map(r => ({ r: r, d: DIM[r.id - 1] }));
        const m = byKey(joined, x => x.d.tag);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT d.tag AS tag, COUNT(*) AS n, SUM(s.v) AS sv FROM v41_src s " +
                               "JOIN v41_dim d ON d.id = s.id GROUP BY d.tag ORDER BY tag"),
                          keys.map(k => ({ tag: k, n: m.get(k).length, sv: sum(m.get(k), x => x.r.v) })));
      });
      t('V41H a report with a window ranking inside each group', () => {
        const m = byKey(SRC, r => r.g);
        const want = [];
        [...m.keys()].sort().forEach(g => {
          const top = m.get(g).slice().sort((a, b) => b.v - a.v || a.id - b.id).slice(0, 3);
          top.forEach((r, i) => want.push({ g: g, id: r.id, v: r.v, rn: i + 1 }));
        });
        return expectDeep(rows("SELECT g AS g, id AS id, v AS v, rn AS rn FROM (SELECT g, id, v, " +
                               "ROW_NUMBER() OVER (PARTITION BY g ORDER BY v DESC, id) AS rn FROM v41_src) z " +
                               "WHERE rn <= 3 ORDER BY g, rn"), want);
      });
      t('V41H a report built on a CTE chain', () => {
        const on = SRC.filter(r => r.st === 'on');
        const m = byKey(on, r => r.g);
        return expect(one("WITH act AS (SELECT g, v FROM v41_src WHERE st = 'on'), " +
                          "per_g AS (SELECT g, SUM(v) AS s FROM act GROUP BY g) SELECT COUNT(*) FROM per_g WHERE s > 1000"),
                      [...m.values()].filter(b => sum(b, r => r.v) > 1000).length);
      });
      t('V41H a rollup report', () => {
        const pairs = uniq(SRC, r => r.g + '|' + r.st);
        return expect(one("SELECT COUNT(*) FROM (SELECT g, st, COUNT(*) FROM v41_src GROUP BY ROLLUP(g, st)) z"),
                      pairs + uniq(SRC, r => r.g) + 1);
      });
      t('V41H the running total per group reaches the group total', () => {
        const m = byKey(SRC, r => r.g);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT g AS g, MAX(rt) AS m FROM (SELECT g, SUM(v) OVER (PARTITION BY g ORDER BY id " +
                               "ROWS UNBOUNDED PRECEDING) AS rt FROM v41_src) z GROUP BY g ORDER BY g"),
                          keys.map(k => ({ g: k, m: sum(m.get(k), r => r.v) })));
      });
      t('V41H rows above their group average', () => {
        const m = byKey(SRC, r => r.g);
        return expect(one("SELECT COUNT(*) FROM v41_src s WHERE s.v > (SELECT AVG(x.v) FROM v41_src x WHERE x.g = s.g)"),
                      cnt(SRC, r => r.v > sum(m.get(r.g), x => x.v) / m.get(r.g).length));
      });
      t('V41H a paged report keeps every group exactly once', () => {
        const keys = [...byKey(SRC, r => r.g).keys()].sort();
        const seen = [];
        for (let off = 0; off < keys.length; off += 2) {
          seen.push.apply(seen, rows("SELECT g AS g, COUNT(*) AS n FROM v41_src GROUP BY g ORDER BY g LIMIT 2 OFFSET " + off)
                                 .map(r => r.g));
        }
        return expectDeep(seen, keys);
      });
      t('V41H a deeply nested report still adds up', () =>
        expect(one("SELECT SUM(s) FROM (SELECT SUM(s) AS s FROM (SELECT g, st, SUM(v) AS s FROM v41_src GROUP BY g, st) a " +
                   "GROUP BY g) b"), sum(SRC, r => r.v)));
      t('V41H a report over every table at once', () =>
        expect(one("SELECT COUNT(*) FROM v41_src s LEFT JOIN v41_dim d ON d.id = s.id"), SRC.length));
      t('V41H the six-way report keeps the totals', () =>
        expect(one("SELECT SUM(s.v) FROM v41_src s LEFT JOIN v41_dim d ON d.id = s.id"), sum(SRC, r => r.v)));

      // ============================================================
      // 片付け
      // ============================================================
      t('V41Zz cleanup', () => {
        ['v41_src', 'v41_dim', 'v41_w', 'v41_u', 'v41_k', 'v41_into', 'v41_ctas'].forEach(n => q("DROP TABLE IF EXISTS " + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v41_') === 0).length === 0;
      });

      return T;
    }
