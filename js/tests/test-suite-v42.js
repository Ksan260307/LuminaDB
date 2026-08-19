    // ============================================================================
    // [Test Suite v42] - v1.29: 総当たりテスト（v36〜v41）で見つかった欠陥の修正
    //
    //     A. APPLY / LATERAL の本体にある文字列リテラルが失われ、条件が常に偽になっていた
    //        （エラーも出ず「0 件」という誤答になる）
    //     B. `SELECT a.id AS id FROM a JOIN b ...` が「曖昧な列」として拒否されていた
    //        （別名は出力名であって列参照ではない）
    //     C. GROUP BY の結果に対する ROWS フレームが使えなかった
    //        （グループごとの累計という定番の書き方が書けない）
    //     D. 0 件になった派生表・CTE が列まで失い、外側から参照できなくなっていた
    //
    //   test-suite.js の tests 配列へ getV42Tests() のスプレッドで合流する
    // ============================================================================
    function getV42Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };
      const val = (name, sql, want) => t(name, () => eq(one(sql), want));

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      t('V42 fixture', () => {
        ['v42_a', 'v42_b', 'v42_g'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        q("CREATE TABLE v42_a (id INT, v INT, st TEXT, g TEXT)");
        q("INSERT INTO v42_a VALUES (1,10,'paid','G0'),(2,20,'pending','G0'),(3,30,'paid','G1'),(4,40,'paid','G1')");
        q("CREATE TABLE v42_b (id INT, w INT)");
        q("INSERT INTO v42_b VALUES (1,100),(2,200),(3,300)");
        q("CREATE TABLE v42_g (code TEXT)");
        q("INSERT INTO v42_g VALUES ('R0'),('R1')");
        return db.tables['v42_a'].rowCount === 4 && db.tables['v42_b'].rowCount === 3;
      });

      // ============================================================
      // A. APPLY / LATERAL の本体の文字列リテラル
      // ============================================================
      val('V42A a string literal inside CROSS APPLY still matches',
          "SELECT SUM(x.k) FROM v42_g CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a WHERE v42_a.st = 'paid') x", 6);
      val('V42A a string literal inside LATERAL still matches',
          "SELECT SUM(x.k) FROM v42_g, LATERAL (SELECT COUNT(*) AS k FROM v42_a WHERE v42_a.st = 'paid') x", 6);
      val('V42A two string literals inside the APPLY body',
          "SELECT SUM(x.k) FROM v42_g CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a " +
          "WHERE v42_a.st = 'paid' AND v42_a.g = 'G1') x", 4);
      val('V42A a string literal combined with a numeric predicate',
          "SELECT SUM(x.k) FROM v42_g CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a " +
          "WHERE v42_a.st = 'paid' AND v42_a.v > 15) x", 4);
      val('V42A a numeric-only APPLY body is unchanged',
          "SELECT SUM(x.k) FROM v42_g CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a WHERE v42_a.v > 15) x", 6);
      val('V42A a correlated APPLY carrying a string literal',
          "SELECT SUM(x.k) FROM v42_a a CROSS APPLY (SELECT COUNT(*) AS k FROM v42_b b " +
          "WHERE b.id = a.id AND a.st = 'paid') x", 2);
      val('V42A a string literal inside OUTER APPLY',
          "SELECT COUNT(*) FROM v42_g OUTER APPLY (SELECT id FROM v42_a WHERE v42_a.st = 'nope') x", 2);
      val('V42A LIKE inside the APPLY body',
          "SELECT SUM(x.k) FROM v42_g CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a WHERE v42_a.st LIKE 'pa%') x", 6);
      val('V42A a string literal in the APPLY select list',
          "SELECT COUNT(*) FROM v42_g CROSS APPLY (SELECT 'x' AS k) x", 2);
      val('V42A a correlated string comparison inside APPLY',
          "SELECT SUM(x.k) FROM v42_a a CROSS APPLY (SELECT COUNT(*) AS k FROM v42_a b WHERE b.g = a.g) x", 8);

      // ============================================================
      // B. 別名が結合先と同名でも曖昧にならない
      // ============================================================
      push('V42B aliasing a qualified column to an ambiguous name',
        "SELECT a.id AS id FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY a.id",
        r => !r.error && r.data.length === 3 && r.data[0].id === 1);
      push('V42B the same with an ORDER BY on the alias',
        "SELECT a.id AS id FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY id DESC",
        r => !r.error && r.data[0].id === 3);
      push('V42B aliasing to an ambiguous name with more columns',
        "SELECT a.id AS id, b.w AS w FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY a.id",
        r => !r.error && r.data.length === 3 && r.data[2].w === 300);
      push('V42B an AS-less alias with an ambiguous name',
        "SELECT a.id id FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY a.id",
        r => !r.error && r.data.length === 3);
      push('V42B aliasing to a different name still works',
        "SELECT a.id AS aid FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY a.id",
        r => !r.error && r.data[0].aid === 1);
      push('V42B an ambiguous name in an expression alias',
        "SELECT a.id + b.w AS id FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY a.id",
        r => !r.error && r.data[0].id === 101);
      push('V42B aliasing inside a grouped query',
        "SELECT a.id AS id, COUNT(*) AS n FROM v42_a a JOIN v42_b b ON a.id = b.id GROUP BY a.id ORDER BY id",
        r => !r.error && r.data.length === 3);
      // 実体のほうの曖昧参照は今までどおり拒否する
      err('V42B a bare ambiguous column is still refused',
        "SELECT id FROM v42_a a JOIN v42_b b ON a.id = b.id", 'ambiguous');
      err('V42B an ambiguous column in WHERE is still refused',
        "SELECT a.v FROM v42_a a JOIN v42_b b ON a.id = b.id WHERE id > 1", 'ambiguous');
      err('V42B an ambiguous column in ORDER BY is still refused',
        "SELECT a.v AS x FROM v42_a a JOIN v42_b b ON a.id = b.id ORDER BY id", 'ambiguous');

      // ============================================================
      // C. GROUP BY 結果への ROWS フレーム
      // ============================================================
      t('V42C a running total over the groups', () =>
        eq(rows("SELECT g AS g, SUM(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS rt " +
                "FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', rt: 30 }, { g: 'G1', rt: 100 }]));
      t('V42C a moving sum over the groups', () =>
        eq(rows("SELECT g AS g, SUM(SUM(v)) OVER (ORDER BY g ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS ms " +
                "FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', ms: 30 }, { g: 'G1', ms: 100 }]));
      t('V42C a whole-partition frame over the groups', () =>
        eq(rows("SELECT g AS g, SUM(SUM(v)) OVER (ORDER BY g ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS tot " +
                "FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', tot: 100 }, { g: 'G1', tot: 100 }]));
      t('V42C COUNT over a frame on grouped rows', () =>
        eq(rows("SELECT g AS g, COUNT(*) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS c " +
                "FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', c: 1 }, { g: 'G1', c: 2 }]));
      t('V42C MIN and MAX over a frame on grouped rows', () =>
        eq(rows("SELECT g AS g, MIN(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS lo, " +
                "MAX(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS hi FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', lo: 30, hi: 30 }, { g: 'G1', lo: 30, hi: 70 }]));
      t('V42C the default frame over grouped rows is unchanged', () =>
        eq(rows("SELECT g AS g, SUM(SUM(v)) OVER (ORDER BY g) AS rt FROM v42_a GROUP BY g ORDER BY g"),
           [{ g: 'G0', rt: 30 }, { g: 'G1', rt: 100 }]));
      err('V42C a RANGE frame over grouped rows is still refused',
        "SELECT g, SUM(SUM(v)) OVER (ORDER BY g RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM v42_a GROUP BY g",
        'not supported over GROUP BY results');
      err('V42C a GROUPS frame over grouped rows is still refused',
        "SELECT g, SUM(SUM(v)) OVER (ORDER BY g GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM v42_a GROUP BY g",
        'not supported over GROUP BY results');

      // ============================================================
      // D. 0 件の派生表・CTE でも列は残る
      // ============================================================
      val('V42D SUM over an empty derived table', "SELECT SUM(v) AS s FROM (SELECT v FROM v42_a WHERE id < 0) t", 0);
      t('V42D MIN over an empty derived table is NULL', () =>
        eq(one("SELECT MIN(v) AS s FROM (SELECT v FROM v42_a WHERE id < 0) t"), null));
      val('V42D COUNT over an empty derived table', "SELECT COUNT(*) AS c FROM (SELECT id FROM v42_a WHERE id < 0) t", 0);
      val('V42D two nested empty derived tables',
          "SELECT COUNT(*) AS c FROM (SELECT id FROM (SELECT id FROM v42_a WHERE id < 0) a) b", 0);
      val('V42D an empty derived table with several columns',
          "SELECT SUM(v) AS s FROM (SELECT v, st FROM v42_a WHERE id < 0) t", 0);
      val('V42D an empty derived table over SELECT *',
          "SELECT COUNT(*) AS c FROM (SELECT * FROM v42_a WHERE id < 0) t", 0);
      val('V42D SUM over an empty SELECT * derived table', "SELECT SUM(v) AS s FROM (SELECT * FROM v42_a WHERE id < 0) t", 0);
      val('V42D an empty CTE keeps its columns', "WITH e AS (SELECT v FROM v42_a WHERE id < 0) SELECT SUM(v) AS s FROM e", 0);
      val('V42D an empty CTE joined to a table',
          "WITH e AS (SELECT id FROM v42_a WHERE id < 0) SELECT COUNT(*) AS c FROM v42_a a LEFT JOIN e ON e.id = a.id", 4);
      val('V42D an empty grouped derived table',
          "SELECT COUNT(*) AS c FROM (SELECT g, COUNT(*) AS n FROM v42_a WHERE id < 0 GROUP BY g) t", 0);
      val('V42D summing a column of an empty grouped derived table',
          "SELECT COALESCE(SUM(n), 0) AS s FROM (SELECT g, COUNT(*) AS n FROM v42_a WHERE id < 0 GROUP BY g) t", 0);
      val('V42D a non-empty derived table is unchanged',
          "SELECT SUM(v) AS s FROM (SELECT v FROM v42_a WHERE id > 0) t", 100);
      val('V42D an empty derived table ordered and limited',
          "SELECT COUNT(*) AS c FROM (SELECT id FROM v42_a WHERE id < 0 ORDER BY id LIMIT 5) t", 0);
      val('V42D an empty derived table with a column list',
          "SELECT COALESCE(SUM(y), 0) AS s FROM (SELECT id, v FROM v42_a WHERE id < 0) AS t(x, y)", 0);

      // ============================================================
      // 片付け
      // ============================================================
      t('V42Zz cleanup', () => {
        ['v42_a', 'v42_b', 'v42_g'].forEach(n => q("DROP TABLE IF EXISTS " + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v42_') === 0).length === 0;
      });

      return T;
    }
