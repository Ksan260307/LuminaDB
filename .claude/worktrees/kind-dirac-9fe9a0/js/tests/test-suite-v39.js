    // ============================================================================
    // [Test Suite v39] - CTE・サブクエリ・集合演算の網羅
    //
    //   入れ子の深さ / CTE の本数 / 再帰の段数 / 相関の形 / 集合演算の連結長を
    //   段階的に増やし、同じ意味の書き換え同士が一致することまで見る。
    //
    //     A. フィクスチャ            F. 集合演算の連結
    //     B. 派生表の入れ子          G. INTERSECT / EXCEPT
    //     C. CTE                     H. 括弧・混在・後段の句
    //     D. 再帰 CTE                I. VALUES / 派生表の列リスト
    //     E. 相関・スカラーサブクエリ J. 述語 x 書き方の総当たり
    //
    //   test-suite.js の tests 配列へ getV39Tests() のスプレッドで合流する
    // ============================================================================
    function getV39Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, rowsOf: rows, oneOf: one, numEq: same, expect, expectDeep, val, sum, cnt, uniq,
              byKey } = makeTestKit('V39');

      // ----------------------------------------------------------------
      // 模型
      // ----------------------------------------------------------------
      const A = [];
      for (let n = 1; n <= 1500; n++) {
        A.push({ id: n, g: 'G' + (n % 8), v: n % 60, w: 1 + (n % 25), txt: 'x' + (n % 15),
                 nv: (n % 7 === 0) ? null : (n % 40) });
      }
      const B = [];
      for (let n = 1; n <= 300; n++) B.push({ id: n, k: n % 20, s: 's' + (n % 6) });
      const C = [];
      for (let n = 1; n <= 60; n++) C.push({ id: n, code: 'C' + (n % 12) });
      const B_K = new Set(B.map(r => r.k));

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V39A build the tables', () => {
        ['v39_a', 'v39_b', 'v39_c'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        let r = q("CREATE TABLE v39_a (id INT PRIMARY KEY, g TEXT, v INT, w INT, txt TEXT, nv INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v39_a (id, g, v, w, txt, nv) SELECT n, 'G' || (n % 8), n % 60, 1 + (n % 25), " +
              "'x' || (n % 15), CASE WHEN n % 7 = 0 THEN NULL ELSE n % 40 END FROM GENERATE_SERIES(1, 1500) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v39_b (id INT PRIMARY KEY, k INT, s TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v39_b (id, k, s) SELECT n, n % 20, 's' || (n % 6) FROM GENERATE_SERIES(1, 300) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v39_c (id INT PRIMARY KEY, code TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v39_c (id, code) SELECT n, 'C' || (n % 12) FROM GENERATE_SERIES(1, 60) AS g(n)");
        if (r.error) throw new Error(r.error);
        return db.tables['v39_a'].rowCount === 1500 && db.tables['v39_b'].rowCount === 300 &&
               db.tables['v39_c'].rowCount === 60;
      });
      val('V39A a row count', "SELECT COUNT(*) FROM v39_a", A.length);
      val('V39A a SUM(v)', "SELECT SUM(v) FROM v39_a", sum(A, r => r.v));
      val('V39A b row count', "SELECT COUNT(*) FROM v39_b", B.length);
      val('V39A c row count', "SELECT COUNT(*) FROM v39_c", C.length);

      // ============================================================
      // B. 派生表の入れ子
      // ============================================================
      for (let depth = 1; depth <= 40; depth++) {
        let sql = "SELECT id, v FROM v39_a WHERE id <= 300";
        for (let i = 1; i <= depth; i++) sql = "SELECT id, v FROM (" + sql + ") n" + i + " WHERE id > " + i;
        val('V39B derived tables nested ' + depth + ' deep', "SELECT COUNT(*) FROM (" + sql + ") z", 300 - depth);
        val('V39B derived tables nested ' + depth + ' deep keep SUM(v)', "SELECT SUM(v) FROM (" + sql + ") z",
            sum(A.filter(r => r.id > depth && r.id <= 300), r => r.v));
      }
      val('V39B a derived table over a grouped query',
          "SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM v39_a GROUP BY g) z", uniq(A, r => r.g));
      val('V39B a derived table filtered on an aggregate',
          "SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM v39_a GROUP BY g) z WHERE n > 180",
          [...byKey(A, r => r.g).values()].filter(b => b.length > 180).length);
      val('V39B three derived tables joined together',
          "SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM v39_a GROUP BY g) x " +
          "JOIN (SELECT g, SUM(v) AS s FROM v39_a GROUP BY g) y ON x.g = y.g " +
          "JOIN (SELECT g, MAX(v) AS mx FROM v39_a GROUP BY g) z ON y.g = z.g", uniq(A, r => r.g));

      // ============================================================
      // C. CTE
      // ============================================================
      for (let n = 1; n <= 25; n++) {
        const parts = ['c1 AS (SELECT 1 AS k)'];
        for (let i = 2; i <= n; i++) parts.push('c' + i + ' AS (SELECT k + 1 AS k FROM c' + (i - 1) + ')');
        val('V39C a chain of ' + n + ' CTEs', "WITH " + parts.join(', ') + " SELECT k FROM c" + n, n);
      }
      [1, 2, 4, 6, 8, 10, 14, 18, 22, 26, 30, 35, 40].forEach(n => {
        const parts = [], sels = [];
        for (let i = 0; i < n; i++) { parts.push('d' + i + ' AS (SELECT ' + i + ' AS k)'); sels.push('SELECT k FROM d' + i); }
        const body = "(" + sels.join(' UNION ALL ') + ")";
        val('V39C ' + n + ' independent CTEs unioned', "WITH " + parts.join(', ') + " SELECT COUNT(*) FROM " + body + " u", n);
        val('V39C ' + n + ' independent CTEs summed', "WITH " + parts.join(', ') + " SELECT SUM(k) FROM " + body + " u",
            n * (n - 1) / 2);
      });
      val('V39C a CTE used twice',
          "WITH base AS (SELECT id, v FROM v39_a WHERE v > 30) SELECT (SELECT COUNT(*) FROM base) + (SELECT COUNT(*) FROM base)",
          cnt(A, r => r.v > 30) * 2);
      val('V39C a CTE joined to itself',
          "WITH base AS (SELECT id, v FROM v39_a WHERE id <= 120) SELECT COUNT(*) FROM base x JOIN base y ON x.v = y.v",
          (() => { const s = A.filter(r => r.id <= 120); let n = 0; for (const p of s) for (const r of s) if (p.v === r.v) n++; return n; })());
      val('V39C a CTE feeding a grouped query',
          "WITH base AS (SELECT g, v FROM v39_a WHERE v < 30) SELECT COUNT(*) FROM (SELECT g, SUM(v) AS s FROM base GROUP BY g) z",
          uniq(A.filter(r => r.v < 30), r => r.g));
      val('V39C two CTEs joined to each other',
          "WITH x AS (SELECT id, v FROM v39_a WHERE id <= 300), y AS (SELECT id, k FROM v39_b) " +
          "SELECT COUNT(*) FROM x JOIN y ON x.id = y.id", 300);
      val('V39C a CTE with an explicit column list',
          "WITH x(p, r) AS (SELECT id, v FROM v39_a WHERE id <= 50) SELECT SUM(r) FROM x",
          sum(A.filter(r => r.id <= 50), r => r.v));
      val('V39C MATERIALIZED is accepted', "WITH x AS MATERIALIZED (SELECT COUNT(*) AS k FROM v39_a) SELECT k FROM x", A.length);
      val('V39C NOT MATERIALIZED is accepted', "WITH x AS NOT MATERIALIZED (SELECT COUNT(*) AS k FROM v39_a) SELECT k FROM x",
          A.length);
      val('V39C a CTE pipeline of three stages',
          "WITH s1 AS (SELECT id, g, v FROM v39_a WHERE v > 10), " +
          "s2 AS (SELECT g, SUM(v) AS s FROM s1 GROUP BY g), " +
          "s3 AS (SELECT g, s FROM s2 WHERE s > 5000) SELECT COUNT(*) FROM s3",
          (() => { const m = byKey(A.filter(r => r.v > 10), r => r.g);
                   return [...m.values()].filter(b => sum(b, r => r.v) > 5000).length; })());
      val('V39C a CTE feeding a window function',
          "WITH base AS (SELECT id, g, v FROM v39_a WHERE id <= 400) " +
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) AS rn FROM base) z WHERE rn = 1",
          uniq(A.filter(r => r.id <= 400), r => r.g));

      // ============================================================
      // D. 再帰 CTE
      // ============================================================
      [5, 10, 25, 50, 100, 200, 300, 400, 499].forEach(n => {
        val('V39D a recursive counter up to ' + n,
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < " + n + ") SELECT COUNT(*) FROM r", n);
        val('V39D a recursive counter up to ' + n + ' sums correctly',
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < " + n + ") SELECT SUM(n) FROM r",
            n * (n + 1) / 2);
      });
      [2, 3, 5, 7, 11].forEach(step => {
        // 0 から step 刻みで「300 未満のあいだ」進むので、最後に 1 つだけ 300 以上の値が入る
        const count = Math.floor(299 / step) + 2;
        val('V39D a recursive counter stepping by ' + step,
            "WITH RECURSIVE r(n) AS (SELECT 0 UNION ALL SELECT n + " + step + " FROM r WHERE n < 300) SELECT COUNT(*) FROM r",
            count);
        val('V39D a recursive counter stepping by ' + step + ' reaches its last value',
            "WITH RECURSIVE r(n) AS (SELECT 0 UNION ALL SELECT n + " + step + " FROM r WHERE n < 300) SELECT MAX(n) FROM r",
            (count - 1) * step);
      });
      val('V39D a recursive countdown', "WITH RECURSIVE r(n) AS (SELECT 200 UNION ALL SELECT n - 1 FROM r WHERE n > 1) " +
          "SELECT MIN(n) FROM r", 1);
      val('V39D a recursive doubling sequence',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n * 2 FROM r WHERE n < 4096) SELECT COUNT(*) FROM r", 13);
      val('V39D a recursive running total',
          "WITH RECURSIVE r(n, s) AS (SELECT 1, 1 UNION ALL SELECT n + 1, s + n + 1 FROM r WHERE n < 200) " +
          "SELECT s FROM r WHERE n = 200", 200 * 201 / 2);
      val('V39D a recursive Fibonacci sequence',
          "WITH RECURSIVE f(i, a, b) AS (SELECT 1, 0, 1 UNION ALL SELECT i + 1, b, a + b FROM f WHERE i < 40) " +
          "SELECT a FROM f WHERE i = 40", 63245986);
      val('V39D a recursive factorial',
          "WITH RECURSIVE f(i, v) AS (SELECT 1, 1 UNION ALL SELECT i + 1, v * (i + 1) FROM f WHERE i < 12) " +
          "SELECT v FROM f WHERE i = 12", 479001600);
      val('V39D a recursive string builder',
          "WITH RECURSIVE s(i, txt) AS (SELECT 1, 'x' UNION ALL SELECT i + 1, txt || 'x' FROM s WHERE i < 120) " +
          "SELECT LENGTH(txt) FROM s WHERE i = 120", 120);
      val('V39D a recursive path accumulator',
          "WITH RECURSIVE p(n, path) AS (SELECT 1, '1' UNION ALL SELECT n + 1, path || '>' || (n + 1) FROM p WHERE n < 8) " +
          "SELECT path FROM p WHERE n = 8", '1>2>3>4>5>6>7>8');
      val('V39D a recursive CTE with two seed rows',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT n + 10 FROM r WHERE n < 100) " +
          "SELECT COUNT(*) FROM r", 22);
      val('V39D UNION in a recursive CTE removes duplicates',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT (n % 7) + 1 FROM r) SELECT COUNT(*) FROM r", 7);
      val('V39D a recursive CTE joined to a table',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 300) " +
          "SELECT COUNT(*) FROM r JOIN v39_b b ON b.id = r.n", 300);
      val('V39D a recursive CTE filtered afterwards',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 400) SELECT COUNT(*) FROM r WHERE n % 5 = 0",
          80);
      val('V39D a recursive CTE grouped afterwards',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 400) " +
          "SELECT COUNT(*) FROM (SELECT n % 8 AS k, COUNT(*) AS c FROM r GROUP BY n % 8) z", 8);
      val('V39D a recursive CTE feeding a window function',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 250) " +
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY n) AS rn FROM r) z WHERE rn <= 30", 30);
      val('V39D a recursive CTE next to a plain CTE',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 60), " +
          "base AS (SELECT COUNT(*) AS c FROM v39_c) SELECT (SELECT c FROM base) + (SELECT COUNT(*) FROM r)",
          C.length + 60);
      val('V39D two recursive CTEs in one statement',
          "WITH RECURSIVE p(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM p WHERE n < 40), " +
          "r(n) AS (SELECT 1 UNION ALL SELECT n + 2 FROM r WHERE n < 40) " +
          "SELECT (SELECT COUNT(*) FROM p) + (SELECT COUNT(*) FROM r)", 40 + 21);
      val('V39D a recursive CTE used inside a bigger query',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) " +
          "SELECT COUNT(*) FROM v39_a a WHERE a.id IN (SELECT n FROM r)", 200);
      t('V39D running past 500 iterations is refused', () => {
        const r = q("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 9000) SELECT COUNT(*) FROM r");
        return !!r.error && /500 iterations/i.test(r.error);
      });

      // ============================================================
      // E. 相関・スカラーサブクエリ
      // ============================================================
      const E_CORR = [
        ['COUNT(*)', "SELECT COUNT(*) FROM v39_a a WHERE a.v = b.k", b => cnt(A, a => a.v === b.k)],
        ['SUM(v)', "SELECT SUM(a.v) FROM v39_a a WHERE a.v = b.k", b => sum(A.filter(a => a.v === b.k), a => a.v)],
        ['MAX(id)', "SELECT MAX(a.id) FROM v39_a a WHERE a.v = b.k",
          b => { const s = A.filter(a => a.v === b.k); return s.length ? Math.max.apply(null, s.map(a => a.id)) : null; }],
        ['MIN(id)', "SELECT MIN(a.id) FROM v39_a a WHERE a.v = b.k",
          b => { const s = A.filter(a => a.v === b.k); return s.length ? Math.min.apply(null, s.map(a => a.id)) : null; }],
        ['COUNT(DISTINCT g)', "SELECT COUNT(DISTINCT a.g) FROM v39_a a WHERE a.v = b.k",
          b => uniq(A.filter(a => a.v === b.k), a => a.g)]
      ];
      E_CORR.forEach((c, i) => {
        t('V39E correlated#' + (i + 1) + ' ' + c[0], () => {
          const got = rows("SELECT (" + c[1] + ") AS k FROM v39_b b ORDER BY b.id").map(r => r.k);
          const want = B.slice().sort((p, r) => p.id - r.id).map(c[2]);
          return expectDeep(got, want);
        });
        val('V39E correlated#' + (i + 1) + ' ' + c[0] + ' totalled',
            "SELECT SUM(k) FROM (SELECT (" + c[1] + ") AS k FROM v39_b b) z",
            sum(B, b => { const v = c[2](b); return v === null ? 0 : v; }));
      });
      val('V39E a correlated subquery in WHERE against the group average',
          "SELECT COUNT(*) FROM v39_a a WHERE a.v > (SELECT AVG(x.v) FROM v39_a x WHERE x.g = a.g)",
          (() => { const m = byKey(A, r => r.g); return cnt(A, a => a.v > sum(m.get(a.g), r => r.v) / m.get(a.g).length); })());
      val('V39E a correlated subquery in WHERE against the group maximum',
          "SELECT COUNT(*) FROM v39_a a WHERE a.v = (SELECT MAX(x.v) FROM v39_a x WHERE x.g = a.g)",
          (() => { const m = byKey(A, r => r.g); return cnt(A, a => a.v === Math.max.apply(null, m.get(a.g).map(r => r.v))); })());
      val('V39E a correlated subquery inside HAVING',
          "SELECT COUNT(*) FROM (SELECT g FROM v39_a a GROUP BY g HAVING COUNT(*) > (SELECT COUNT(*) / 10 FROM v39_a)) z",
          (() => { const m = byKey(A, r => r.g); const th = A.length / 10;
                   return [...m.values()].filter(b => b.length > th).length; })());
      val('V39E an uncorrelated scalar subquery in the select list',
          "SELECT (SELECT COUNT(*) FROM v39_a) + (SELECT COUNT(*) FROM v39_b)", A.length + B.length);
      val('V39E a scalar subquery compared in WHERE',
          "SELECT COUNT(*) FROM v39_a WHERE v > (SELECT AVG(v) FROM v39_a)",
          cnt(A, r => r.v > sum(A, x => x.v) / A.length));
      val('V39E a scalar subquery as a constant column',
          "SELECT COUNT(*) FROM (SELECT id, (SELECT MAX(v) FROM v39_a) AS mx FROM v39_a) z WHERE mx = " +
          Math.max.apply(null, A.map(r => r.v)), A.length);
      val('V39E a correlated EXISTS inside CASE',
          "SELECT SUM(k) FROM (SELECT CASE WHEN EXISTS (SELECT 1 FROM v39_a a WHERE a.v = b.k) THEN 1 ELSE 0 END AS k " +
          "FROM v39_b b) z", cnt(B, b => A.some(a => a.v === b.k)));
      val('V39E a correlated subquery inside COALESCE',
          "SELECT SUM(k) FROM (SELECT COALESCE((SELECT MAX(a.id) FROM v39_a a WHERE a.v = b.k AND a.id < 0), -1) AS k " +
          "FROM v39_b b) z", -B.length);
      val('V39E an EXISTS wrapping an uncorrelated IN subquery',
          "SELECT COUNT(*) FROM v39_c c WHERE EXISTS (SELECT 1 FROM v39_b b WHERE b.id = c.id AND b.k IN " +
          "(SELECT v FROM v39_a WHERE v < 10))",
          (() => { const vs = new Set(A.filter(r => r.v < 10).map(r => r.v));
                   return cnt(C, c => B.some(b => b.id === c.id && vs.has(b.k))); })());

      // ============================================================
      // F. 集合演算の連結
      // ============================================================
      const LENS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 45, 50, 55, 60];
      LENS.forEach(len => {
        const chain = Array.from({ length: len }, (_, i) => 'SELECT ' + (i + 1) + ' AS v').join(' UNION ALL ');
        val('V39F a UNION ALL chain of ' + len + ' branches', "SELECT COUNT(*) FROM (" + chain + ") t", len);
        val('V39F a UNION ALL chain of ' + len + ' branches sums', "SELECT SUM(v) FROM (" + chain + ") t",
            len * (len + 1) / 2);
      });
      [2, 5, 10, 20, 40].forEach(len => {
        const chain = Array.from({ length: len }, () => 'SELECT 7 AS v').join(' UNION ');
        val('V39F a UNION chain of ' + len + ' identical branches collapses', "SELECT COUNT(*) FROM (" + chain + ") t", 1);
      });
      val('V39F a UNION ALL of table scans',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_b UNION ALL SELECT id FROM v39_b UNION ALL SELECT id FROM v39_b) t",
          B.length * 3);
      val('V39F a UNION ALL of complementary slices covers the table',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a WHERE id <= 500 UNION ALL SELECT id FROM v39_a WHERE id BETWEEN 501 AND 1000 " +
          "UNION ALL SELECT id FROM v39_a WHERE id > 1000) t", A.length);
      val('V39F UNION removes the duplicated rows',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_b UNION SELECT id FROM v39_b) t", B.length);
      val('V39F UNION over overlapping ranges',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a WHERE id <= 900 UNION SELECT id FROM v39_a WHERE id > 600) t", A.length);
      val('V39F UNION over two columns dedupes on the pair',
          "SELECT COUNT(*) FROM (SELECT g, txt FROM v39_a UNION SELECT g, txt FROM v39_a) t", uniq(A, r => r.g + '|' + r.txt));

      // ============================================================
      // G. INTERSECT / EXCEPT
      // ============================================================
      const G_MODS = [2, 3, 4, 5, 6, 8, 10];
      G_MODS.forEach(m => {
        const hit = cnt(A, r => r.id % m === 0);
        val('V39G INTERSECT with the multiples of ' + m,
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a INTERSECT SELECT id FROM v39_a WHERE id % " + m + " = 0) t", hit);
        val('V39G EXCEPT the multiples of ' + m,
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a EXCEPT SELECT id FROM v39_a WHERE id % " + m + " = 0) t",
            A.length - hit);
        val('V39G MINUS the multiples of ' + m + ' matches EXCEPT',
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a MINUS SELECT id FROM v39_a WHERE id % " + m + " = 0) t",
            A.length - hit);
        val('V39G INTERSECT and EXCEPT of the multiples of ' + m + ' partition the rows',
            "SELECT (SELECT COUNT(*) FROM (SELECT id FROM v39_a INTERSECT SELECT id FROM v39_a WHERE id % " + m + " = 0) x) + " +
            "(SELECT COUNT(*) FROM (SELECT id FROM v39_a EXCEPT SELECT id FROM v39_a WHERE id % " + m + " = 0) y)", A.length);
        val('V39G INTERSECT ALL with the multiples of ' + m,
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a INTERSECT ALL SELECT id FROM v39_a WHERE id % " + m + " = 0) t", hit);
      });
      val('V39G INTERSECT of disjoint sets is empty',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a WHERE id <= 700 INTERSECT SELECT id FROM v39_a WHERE id > 700) t", 0);
      val('V39G EXCEPT of a set with itself is empty',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a EXCEPT SELECT id FROM v39_a) t", 0);
      val('V39G EXCEPT between two tables',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a EXCEPT SELECT id FROM v39_b) t", A.length - B.length);
      val('V39G INTERSECT between two tables',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a INTERSECT SELECT id FROM v39_b) t", B.length);
      val('V39G a chain of two EXCEPTs',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a EXCEPT SELECT id FROM v39_a WHERE id % 2 = 0 " +
          "EXCEPT SELECT id FROM v39_a WHERE id % 3 = 0) t", cnt(A, r => r.id % 2 !== 0 && r.id % 3 !== 0));
      val('V39G a chain of two INTERSECTs',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a INTERSECT SELECT id FROM v39_a WHERE id % 2 = 0 " +
          "INTERSECT SELECT id FROM v39_a WHERE id % 3 = 0) t", cnt(A, r => r.id % 6 === 0));
      val('V39G EXCEPT over two columns',
          "SELECT COUNT(*) FROM (SELECT g, txt FROM v39_a EXCEPT SELECT g, txt FROM v39_a WHERE txt = 'x1') t",
          uniq(A, r => r.g + '|' + r.txt) - uniq(A.filter(r => r.txt === 'x1'), r => r.g + '|' + r.txt));

      // ============================================================
      // H. 括弧・混在・後段の句
      // ============================================================
      t('V39H a parenthesised UNION ALL then INTERSECT at the top level', () =>
        expect(rows("(SELECT id FROM v39_a WHERE id <= 400 UNION ALL SELECT id FROM v39_a WHERE id > 1100) " +
                    "INTERSECT (SELECT id FROM v39_a WHERE id % 2 = 0)").length,
               cnt(A, r => (r.id <= 400 || r.id > 1100) && r.id % 2 === 0)));
      val('V39H a parenthesised UNION as a derived table',
          "SELECT COUNT(*) FROM ((SELECT 1 AS v) UNION (SELECT 2)) t", 2);
      val('V39H a parenthesised INTERSECT as a derived table',
          "SELECT COUNT(*) FROM ((SELECT id FROM v39_b) INTERSECT (SELECT id FROM v39_b WHERE id % 2 = 0)) t",
          cnt(B, r => r.id % 2 === 0));
      val('V39H a parenthesised EXCEPT as a derived table',
          "SELECT COUNT(*) FROM ((SELECT id FROM v39_b) EXCEPT (SELECT id FROM v39_b WHERE id % 2 = 0)) t",
          cnt(B, r => r.id % 2 !== 0));
      val('V39H ORDER BY over a set operation',
          "SELECT v FROM (SELECT 3 AS v UNION SELECT 1 UNION SELECT 2) t ORDER BY v LIMIT 1", 1);
      val('V39H LIMIT over a UNION ALL chain',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_b UNION ALL SELECT id FROM v39_b LIMIT 400) t", 400);
      val('V39H a set operation feeding a GROUP BY',
          "SELECT COUNT(*) FROM (SELECT g, COUNT(*) AS n FROM (SELECT g FROM v39_a UNION ALL SELECT g FROM v39_a) u " +
          "GROUP BY g) z", uniq(A, r => r.g));
      val('V39H a set operation feeding a window function',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM " +
          "(SELECT id FROM v39_b UNION ALL SELECT id + 1000 FROM v39_b) u) z", B.length * 2);
      val('V39H a set operation inside a CTE',
          "WITH u AS (SELECT id FROM v39_b UNION ALL SELECT id FROM v39_b) SELECT COUNT(*) FROM u", B.length * 2);
      val('V39H a set operation joined to a table',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_b UNION SELECT id FROM v39_b) u JOIN v39_a a ON a.id = u.id", B.length);
      val('V39H a set operation of two grouped queries',
          "SELECT COUNT(*) FROM (SELECT g, SUM(v) AS s FROM v39_a GROUP BY g UNION ALL SELECT g, SUM(v) FROM v39_a GROUP BY g) t",
          uniq(A, r => r.g) * 2);
      t('V39H mismatched column counts are refused', () => {
        const r = q("SELECT id, v FROM v39_a UNION SELECT id FROM v39_b");
        return !!r.error;
      });
      val('V39H a set operation with an outer WHERE',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a UNION ALL SELECT id FROM v39_b) t WHERE id <= 100", 200);

      // ============================================================
      // I. VALUES / 派生表の列リスト
      // ============================================================
      [3, 10, 30, 60, 100, 200].forEach(n => {
        const vals = Array.from({ length: n }, (_, i) => '(' + (i + 1) + ')').join(', ');
        val('V39I a VALUES list of ' + n + ' rows', "SELECT COUNT(*) FROM (VALUES " + vals + ") AS t(k)", n);
        val('V39I a VALUES list of ' + n + ' rows summed', "SELECT SUM(k) FROM (VALUES " + vals + ") AS t(k)",
            n * (n + 1) / 2);
      });
      val('V39I a VALUES list of pairs', "SELECT SUM(a) FROM (VALUES (1, 'x'), (2, 'y'), (3, 'z')) AS t(a, b)", 6);
      val('V39I a VALUES list joined to a table',
          "SELECT COUNT(*) FROM (VALUES ('G0'), ('G1')) AS t(code) JOIN v39_a a ON a.g = t.code",
          cnt(A, r => r.g === 'G0' || r.g === 'G1'));
      val('V39I a derived table with an explicit column list',
          "SELECT SUM(y) FROM (SELECT id, v FROM v39_a WHERE id <= 40) AS t(x, y)",
          sum(A.filter(r => r.id <= 40), r => r.v));
      val('V39I a derived table renaming every column',
          "SELECT COUNT(*) FROM (SELECT id, g, v FROM v39_a) AS t(p, r, s) WHERE s > 30", cnt(A, r => r.v > 30));
      val('V39I GENERATE_SERIES as a derived table',
          "SELECT COUNT(*) FROM (SELECT n FROM GENERATE_SERIES(1, 700) AS g(n)) z", 700);
      val('V39I GENERATE_SERIES joined to a table',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 300) AS g(n) JOIN v39_b b ON b.id = g.n", 300);
      val('V39I a derived table over a UNION',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_b UNION ALL SELECT id FROM v39_b) AS t(x)", B.length * 2);
      val('V39I a derived table with DISTINCT inside',
          "SELECT COUNT(*) FROM (SELECT DISTINCT g, txt FROM v39_a) z", uniq(A, r => r.g + '|' + r.txt));
      val('V39I a derived table ordered and limited',
          "SELECT COUNT(*) FROM (SELECT id FROM v39_a ORDER BY v DESC, id LIMIT 77) z", 77);

      // ============================================================
      // J. 述語 x 書き方の総当たり
      //    同じ絞り込みを 6 通りに書いて、どれも同じ答えになることを見る
      // ============================================================
      const J_PREDS = [];
      [['v', r => r.v, [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]],
       ['w', r => r.w, [3, 6, 9, 12, 15, 18, 21, 24]],
       ['id', r => r.id, [100, 300, 600, 900, 1200, 1450]],
       ['nv', r => r.nv, [5, 10, 20, 30, 39]]].forEach(spec => {
        [['>', (a, b) => a > b], ['<', (a, b) => a < b], ['=', (a, b) => a === b],
         ['<>', (a, b) => a !== b], ['>=', (a, b) => a >= b]].forEach(op => {
          spec[2].forEach(lit => J_PREDS.push([
            spec[0] + ' ' + op[0] + ' ' + lit,
            r => { const x = spec[1](r); return x === null || x === undefined ? false : op[1](x, lit); }
          ]));
        });
      });
      [['g', r => r.g, ["'G0'", "'G3'", "'G7'"]], ['txt', r => r.txt, ["'x0'", "'x7'", "'x14'"]]].forEach(spec => {
        [['=', (a, b) => a === b], ['<>', (a, b) => a !== b], ['>', (a, b) => a > b]].forEach(op => {
          spec[2].forEach(lit => J_PREDS.push([
            spec[0] + ' ' + op[0] + ' ' + lit,
            r => op[1](spec[1](r), lit.slice(1, -1))
          ]));
        });
      });
      J_PREDS.forEach((p, i) => {
        const want = cnt(A, p[1]);
        const wantSum = sum(A.filter(p[1]), r => r.v);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] plain WHERE', "SELECT COUNT(*) FROM v39_a WHERE " + p[0], want);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] derived table',
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a WHERE " + p[0] + ") z", want);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] CTE',
            "WITH base AS (SELECT id FROM v39_a WHERE " + p[0] + ") SELECT COUNT(*) FROM base", want);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] IN over a subquery',
            "SELECT COUNT(*) FROM v39_a WHERE id IN (SELECT id FROM v39_a WHERE " + p[0] + ")", want);
        // 相関 EXISTS は外側 x 内側の総当たりになるので、外側は 60 行の表に留める
        val('V39J#' + (i + 1) + ' [' + p[0] + '] correlated EXISTS',
            "SELECT COUNT(*) FROM v39_c c WHERE EXISTS (SELECT 1 FROM v39_a y WHERE y.id = c.id AND " +
            p[0].replace(/\b(v|w|id|nv)\b/g, 'y.$1') + ")",
            cnt(C, c => p[1](A[c.id - 1])));
        val('V39J#' + (i + 1) + ' [' + p[0] + '] SUM through a derived table',
            "SELECT SUM(v) FROM (SELECT v FROM v39_a WHERE " + p[0] + ") z", wantSum);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] UNION of the same slice',
            "SELECT COUNT(*) FROM (SELECT id FROM v39_a WHERE " + p[0] + " UNION SELECT id FROM v39_a WHERE " + p[0] + ") z",
            want);
        val('V39J#' + (i + 1) + ' [' + p[0] + '] two nested derived tables',
            "SELECT COUNT(*) FROM (SELECT id FROM (SELECT id FROM v39_a WHERE " + p[0] + ") t) z", want);
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V39Zz cleanup', () => {
        ['v39_a', 'v39_b', 'v39_c'].forEach(n => q("DROP TABLE IF EXISTS " + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v39_') === 0).length === 0;
      });

      return T;
    }
