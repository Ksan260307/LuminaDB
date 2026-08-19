    // ============================================================================
    // [Test Suite v37] - 大規模な集計の網羅
    //
    //   2,500 行の表に対して「まとめ方 x 集計関数」を総当たりで流す。グループごとの
    //   値は結果セットを丸ごと JavaScript 側の模型と突き合わせるので、1 グループでも
    //   ずれれば落ちる。
    //
    //     A. フィクスチャ                F. 文字列を畳み込む集計
    //     B. まとめ方 x 集計関数         G. 統計集計
    //     C. HAVING                      H. WITHIN GROUP
    //     D. ROLLUP / CUBE / SETS        I. 集計を含む式・比率・順位
    //     E. FILTER / DISTINCT           J. 絞り込み x 集計の総当たり
    //
    //   test-suite.js の tests 配列へ getV37Tests() のスプレッドで合流する
    // ============================================================================
    function getV37Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows returned'); return Object.values(d[0])[0]; };
      const same = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 1e-9 : a === b;
      const expect = (actual, want, label) => {
        if (!same(actual, want)) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + JSON.stringify(want) + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectNear = (actual, want, eps, label) => {
        if (typeof actual !== 'number' || Math.abs(actual - want) > (eps === undefined ? 1e-6 : eps)) {
          throw new Error((label ? label + ' ' : '') + 'expected ~' + want + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectDeep = (actual, want, label) => {
        const a = JSON.stringify(actual), b = JSON.stringify(want);
        if (a !== b) throw new Error((label ? label + ' ' : '') + 'expected ' + b + ' but got ' + a);
        return true;
      };
      const val = (name, sql, want) => t(name, () => expect(one(sql), want));
      const valNear = (name, sql, want, eps) => t(name, () => expectNear(one(sql), want, eps));
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const cnt = (arr, f) => arr.filter(f).length;
      const uniq = (arr, f) => new Set(arr.map(f)).size;
      const mean = (arr, f) => sum(arr, f) / arr.length;
      const byKey = (arr, keyf) => {
        const m = new Map();
        for (const x of arr) { const k = keyf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
        return m;
      };
      const varPop = (arr, f) => { const m = mean(arr, f); return sum(arr, x => (f(x) - m) * (f(x) - m)) / arr.length; };
      const varSamp = (arr, f) => { const m = mean(arr, f); return sum(arr, x => (f(x) - m) * (f(x) - m)) / (arr.length - 1); };
      const covPop = (arr, fx, fy) => { const mx = mean(arr, fx), my = mean(arr, fy);
                                        return sum(arr, x => (fx(x) - mx) * (fy(x) - my)) / arr.length; };
      const pctCont = (sorted, p) => {
        const pos = p * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
        return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      };
      // 統計集計は小数第 4 位で丸めて返るので、相対誤差を許して比べる
      const expectRel = (actual, want, label) => {
        const tol = Math.max(1e-4, Math.abs(want) * 1e-9);
        if (typeof actual !== 'number' || Math.abs(actual - want) > tol) {
          throw new Error((label ? label + ' ' : '') + 'expected ~' + want + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };

      // ----------------------------------------------------------------
      // 模型
      // ----------------------------------------------------------------
      const ROW = [];
      for (let n = 1; n <= 2500; n++) {
        ROW.push({
          id: n,
          g2: 'A' + (n % 2), g3: 'B' + (n % 3), g4: 'C' + (n % 4),
          g5: 'D' + (n % 5), g8: 'E' + (n % 8), g10: 'F' + (n % 10),
          a: n % 50, b: 1 + (n % 17), c: (n * 37) % 1000,
          nv: (n % 11 === 0) ? null : (n % 200),
          txt: 'r' + (n % 40)
        });
      }

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V37A build the table', () => {
        q('DROP TABLE IF EXISTS v37_t');
        let r = q("CREATE TABLE v37_t (id INT PRIMARY KEY, g2 TEXT, g3 TEXT, g4 TEXT, g5 TEXT, g8 TEXT, g10 TEXT, " +
                  "a INT, b INT, c INT, nv INT, txt TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v37_t (id, g2, g3, g4, g5, g8, g10, a, b, c, nv, txt) SELECT n, " +
              "'A' || (n % 2), 'B' || (n % 3), 'C' || (n % 4), 'D' || (n % 5), 'E' || (n % 8), 'F' || (n % 10), " +
              "n % 50, 1 + (n % 17), (n * 37) % 1000, " +
              "CASE WHEN n % 11 = 0 THEN NULL ELSE n % 200 END, 'r' || (n % 40) " +
              "FROM GENERATE_SERIES(1, 2500) AS g(n)");
        if (r.error) throw new Error(r.error);
        return expect(db.tables['v37_t'].rowCount, 2500);
      });
      val('V37A row count', "SELECT COUNT(*) FROM v37_t", ROW.length);
      val('V37A SUM(a)', "SELECT SUM(a) FROM v37_t", sum(ROW, r => r.a));
      val('V37A SUM(b)', "SELECT SUM(b) FROM v37_t", sum(ROW, r => r.b));
      val('V37A SUM(c)', "SELECT SUM(c) FROM v37_t", sum(ROW, r => r.c));
      val('V37A COUNT(nv)', "SELECT COUNT(nv) FROM v37_t", cnt(ROW, r => r.nv !== null));
      val('V37A distinct g10', "SELECT COUNT(DISTINCT g10) FROM v37_t", uniq(ROW, r => r.g10));
      val('V37A distinct txt', "SELECT COUNT(DISTINCT txt) FROM v37_t", uniq(ROW, r => r.txt));

      // ============================================================
      // B. まとめ方 x 集計関数（結果セットを丸ごと突き合わせる）
      // ============================================================
      const GROUPS = [
        ['g2', x => x.g2], ['g3', x => x.g3], ['g4', x => x.g4], ['g5', x => x.g5],
        ['g8', x => x.g8], ['g10', x => x.g10], ['b', x => x.b], ['txt', x => x.txt],
        ['g2, g3', x => x.g2 + '|' + x.g3],
        ['g3, g4', x => x.g3 + '|' + x.g4],
        ['g4, g5', x => x.g4 + '|' + x.g5],
        ['g2, g5', x => x.g2 + '|' + x.g5],
        ['g2, g3, g4', x => x.g2 + '|' + x.g3 + '|' + x.g4],
        ['g5, g8', x => x.g5 + '|' + x.g8],
        ['g3, g5', x => x.g3 + '|' + x.g5],
        ['g4, g10', x => x.g4 + '|' + x.g10],
        ['g2, g4, g5', x => x.g2 + '|' + x.g4 + '|' + x.g5],
        ['g3, g8', x => x.g3 + '|' + x.g8]
      ];
      const AGGS = [
        ['COUNT(*)', g => g.length, true],
        ['SUM(a)', g => sum(g, x => x.a), true],
        ['SUM(b)', g => sum(g, x => x.b), true],
        ['SUM(c)', g => sum(g, x => x.c), true],
        ['MIN(a)', g => Math.min.apply(null, g.map(x => x.a)), true],
        ['MAX(a)', g => Math.max.apply(null, g.map(x => x.a)), true],
        ['MIN(c)', g => Math.min.apply(null, g.map(x => x.c)), true],
        ['MAX(c)', g => Math.max.apply(null, g.map(x => x.c)), true],
        ['COUNT(nv)', g => cnt(g, x => x.nv !== null), true],
        ['COUNT(DISTINCT a)', g => uniq(g, x => x.a), true],
        ['COUNT(DISTINCT b)', g => uniq(g, x => x.b), true],
        ['COUNT(DISTINCT txt)', g => uniq(g, x => x.txt), true],
        ['AVG(a)', g => mean(g, x => x.a), false],
        ['AVG(c)', g => mean(g, x => x.c), false]
      ];
      GROUPS.forEach(grp => {
        const buckets = byKey(ROW, grp[1]);
        const cols = grp[0].split(',').map(s => s.trim());
        const numeric = cols.map(c => c === 'b');
        const keys = [...buckets.keys()].sort((A, B) => {
          const a = String(A).split('|'), b = String(B).split('|');
          for (let i = 0; i < a.length; i++) {
            if (numeric[i]) { const d = Number(a[i]) - Number(b[i]); if (d) return d; }
            else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
          }
          return 0;
        });
        const sel = cols.map((c, i) => c + ' AS k' + i).join(', ');
        const ord = cols.map((c, i) => 'k' + i).join(', ');
        AGGS.forEach(ag => {
          t('V37B GROUP BY ' + grp[0] + ' with ' + ag[0], () => {
            const got = rows("SELECT " + sel + ", " + ag[0] + " AS m FROM v37_t GROUP BY " + grp[0] + " ORDER BY " + ord);
            expect(got.length, keys.length, 'group count');
            keys.forEach((k, i) => {
              const w = ag[1](buckets.get(k));
              if (ag[2]) expect(got[i].m, w, 'row ' + i);
              else expectNear(got[i].m, w, 1e-9, 'row ' + i);
            });
            return true;
          });
        });
      });

      // ============================================================
      // C. HAVING
      // ============================================================
      const H_GROUPS = [['g4', x => x.g4], ['g8', x => x.g8], ['g10', x => x.g10],
                        ['b', x => x.b], ['txt', x => x.txt], ['g2, g5', x => x.g2 + '|' + x.g5],
                        ['g3, g4', x => x.g3 + '|' + x.g4], ['g5, g8', x => x.g5 + '|' + x.g8]];
      const H_CONDS = [
        ['COUNT(*) > 100', g => g.length > 100],
        ['COUNT(*) >= 250', g => g.length >= 250],
        ['COUNT(*) < 200', g => g.length < 200],
        ['COUNT(*) = 250', g => g.length === 250],
        ['SUM(a) > 5000', g => sum(g, x => x.a) > 5000],
        ['SUM(a) < 3000', g => sum(g, x => x.a) < 3000],
        ['SUM(b) > 2000', g => sum(g, x => x.b) > 2000],
        ['SUM(c) > 100000', g => sum(g, x => x.c) > 100000],
        ['MAX(a) = 49', g => Math.max.apply(null, g.map(x => x.a)) === 49],
        ['MIN(a) = 0', g => Math.min.apply(null, g.map(x => x.a)) === 0],
        ['COUNT(DISTINCT a) > 20', g => uniq(g, x => x.a) > 20],
        ['COUNT(nv) > 100', g => cnt(g, x => x.nv !== null) > 100],
        ['COUNT(*) > 100 AND SUM(a) > 4000', g => g.length > 100 && sum(g, x => x.a) > 4000],
        ['COUNT(*) < 100 OR SUM(b) > 3000', g => g.length < 100 || sum(g, x => x.b) > 3000]
      ];
      H_GROUPS.forEach(grp => {
        const buckets = [...byKey(ROW, grp[1]).values()];
        H_CONDS.forEach((c, i) => {
          val('V37C GROUP BY ' + grp[0] + ' HAVING ' + c[0],
              "SELECT COUNT(*) FROM (SELECT " + grp[0] + " FROM v37_t GROUP BY " + grp[0] + " HAVING " + c[0] + ") z",
              buckets.filter(c[1]).length);
        });
      });

      // ============================================================
      // D. ROLLUP / CUBE / GROUPING SETS
      // ============================================================
      const KEYSETS = [
        ['g2', 'g3'], ['g3', 'g4'], ['g4', 'g5'], ['g2', 'g5'], ['g5', 'g8'], ['g2', 'g10']
      ];
      KEYSETS.forEach(ks => {
        const [k1, k2] = ks;
        const n1 = uniq(ROW, x => x[k1]), n2 = uniq(ROW, x => x[k2]);
        const npair = uniq(ROW, x => x[k1] + '|' + x[k2]);
        val('V37D ROLLUP(' + k1 + ', ' + k2 + ') row count',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", " + k2 + ", COUNT(*) FROM v37_t GROUP BY ROLLUP(" + k1 + ", " + k2 + ")) z",
            npair + n1 + 1);
        val('V37D CUBE(' + k1 + ', ' + k2 + ') row count',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", " + k2 + ", COUNT(*) FROM v37_t GROUP BY CUBE(" + k1 + ", " + k2 + ")) z",
            npair + n1 + n2 + 1);
        val('V37D GROUPING SETS ((' + k1 + '), (' + k2 + '), ()) row count',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", " + k2 + ", COUNT(*) FROM v37_t " +
            "GROUP BY GROUPING SETS ((" + k1 + "), (" + k2 + "), ())) z", n1 + n2 + 1);
        val('V37D ROLLUP(' + k1 + ', ' + k2 + ') grand total',
            "SELECT n FROM (SELECT " + k1 + " AS x, " + k2 + " AS y, COUNT(*) AS n FROM v37_t " +
            "GROUP BY ROLLUP(" + k1 + ", " + k2 + ")) z WHERE x IS NULL AND y IS NULL", ROW.length);
        val('V37D ROLLUP(' + k1 + ', ' + k2 + ') detail rows add up',
            "SELECT SUM(n) FROM (SELECT " + k1 + " AS x, " + k2 + " AS y, COUNT(*) AS n FROM v37_t " +
            "GROUP BY ROLLUP(" + k1 + ", " + k2 + ")) z WHERE x IS NOT NULL AND y IS NOT NULL", ROW.length);
        val('V37D CUBE(' + k1 + ', ' + k2 + ') sums stay consistent',
            "SELECT s FROM (SELECT " + k1 + " AS x, " + k2 + " AS y, SUM(a) AS s FROM v37_t " +
            "GROUP BY CUBE(" + k1 + ", " + k2 + ")) z WHERE x IS NULL AND y IS NULL", sum(ROW, r => r.a));
        val('V37D GROUPING() marks the total row of ROLLUP(' + k1 + ')',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", GROUPING(" + k1 + ") AS gflag, COUNT(*) FROM v37_t " +
            "GROUP BY ROLLUP(" + k1 + ")) z WHERE gflag = 1", 1);
        val('V37D WITH ROLLUP over ' + k1 + ' matches ROLLUP()',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", COUNT(*) FROM v37_t GROUP BY " + k1 + " WITH ROLLUP) z", n1 + 1);
        val('V37D GROUPING_ID over (' + k1 + ', ' + k2 + ') in CUBE',
            "SELECT COUNT(DISTINCT gid) FROM (SELECT GROUPING_ID(" + k1 + ", " + k2 + ") AS gid FROM v37_t " +
            "GROUP BY CUBE(" + k1 + ", " + k2 + ")) z", 4);
        val('V37D GROUPING SETS of the pair and the empty set',
            "SELECT COUNT(*) FROM (SELECT " + k1 + ", " + k2 + ", COUNT(*) FROM v37_t " +
            "GROUP BY GROUPING SETS ((" + k1 + ", " + k2 + "), ())) z", npair + 1);
      });
      val('V37D ROLLUP over three columns',
          "SELECT COUNT(*) FROM (SELECT g2, g3, g4, COUNT(*) FROM v37_t GROUP BY ROLLUP(g2, g3, g4)) z",
          uniq(ROW, x => x.g2 + '|' + x.g3 + '|' + x.g4) + uniq(ROW, x => x.g2 + '|' + x.g3) + uniq(ROW, x => x.g2) + 1);
      val('V37D CUBE over three columns',
          "SELECT COUNT(*) FROM (SELECT g2, g3, g4, COUNT(*) FROM v37_t GROUP BY CUBE(g2, g3, g4)) z",
          (() => {
            const k = (fs) => uniq(ROW, x => fs.map(f => x[f]).join('|'));
            return k(['g2', 'g3', 'g4']) + k(['g2', 'g3']) + k(['g2', 'g4']) + k(['g3', 'g4']) +
                   k(['g2']) + k(['g3']) + k(['g4']) + 1;
          })());
      val('V37D GROUPING SETS (()) is the grand total',
          "SELECT COUNT(*) FROM v37_t GROUP BY GROUPING SETS (())", ROW.length);

      // ============================================================
      // E. FILTER / DISTINCT
      // ============================================================
      const E_FILTERS = [
        ["a > 25", x => x.a > 25], ["a <= 10", x => x.a <= 10], ["b = 5", x => x.b === 5],
        ["b > 8", x => x.b > 8], ["c > 500", x => x.c > 500], ["c < 100", x => x.c < 100],
        ["nv IS NULL", x => x.nv === null], ["nv IS NOT NULL", x => x.nv !== null],
        ["g2 = 'A0'", x => x.g2 === 'A0'], ["g3 <> 'B1'", x => x.g3 !== 'B1'],
        ["g5 IN ('D0', 'D2')", x => x.g5 === 'D0' || x.g5 === 'D2'],
        ["txt LIKE 'r1%'", x => /^r1/.test(x.txt)],
        ["a BETWEEN 10 AND 20", x => x.a >= 10 && x.a <= 20],
        ["id % 3 = 0", x => x.id % 3 === 0],
        ["a > 25 AND b > 8", x => x.a > 25 && x.b > 8]
      ];
      E_FILTERS.forEach((f, i) => {
        const hit = ROW.filter(f[1]);
        val('V37E FILTER#' + (i + 1) + ' COUNT(*) FILTER (WHERE ' + f[0] + ')',
            "SELECT COUNT(*) FILTER (WHERE " + f[0] + ") FROM v37_t", hit.length);
        val('V37E FILTER#' + (i + 1) + ' SUM(a) FILTER (WHERE ' + f[0] + ')',
            "SELECT SUM(a) FILTER (WHERE " + f[0] + ") FROM v37_t", sum(hit, x => x.a));
        val('V37E FILTER#' + (i + 1) + ' SUM(c) FILTER (WHERE ' + f[0] + ')',
            "SELECT SUM(c) FILTER (WHERE " + f[0] + ") FROM v37_t", sum(hit, x => x.c));
        val('V37E FILTER#' + (i + 1) + ' COUNT(DISTINCT b) FILTER (WHERE ' + f[0] + ')',
            "SELECT COUNT(DISTINCT b) FILTER (WHERE " + f[0] + ") FROM v37_t", uniq(hit, x => x.b));
      });
      ['g4', 'g5', 'g8'].forEach(gk => {
        t('V37E FILTER per group over ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const keys = [...m.keys()].sort();
          const want = keys.map(k => ({ k: k, n: cnt(m.get(k), x => x.a > 25), s: sum(m.get(k).filter(x => x.b > 8), x => x.a) }));
          return expectDeep(rows("SELECT " + gk + " AS k, COUNT(*) FILTER (WHERE a > 25) AS n, " +
                                 "SUM(a) FILTER (WHERE b > 8) AS s FROM v37_t GROUP BY " + gk + " ORDER BY k"), want);
        });
      });
      const E_DISTINCT = [
        ['COUNT(DISTINCT a)', uniq(ROW, x => x.a)],
        ['COUNT(DISTINCT b)', uniq(ROW, x => x.b)],
        ['COUNT(DISTINCT c)', uniq(ROW, x => x.c)],
        ['COUNT(DISTINCT nv)', uniq(ROW.filter(x => x.nv !== null), x => x.nv)],
        ['COUNT(DISTINCT txt)', uniq(ROW, x => x.txt)],
        ['COUNT(DISTINCT g10)', uniq(ROW, x => x.g10)],
        ['SUM(DISTINCT a)', [...new Set(ROW.map(x => x.a))].reduce((s, v) => s + v, 0)],
        ['SUM(DISTINCT b)', [...new Set(ROW.map(x => x.b))].reduce((s, v) => s + v, 0)],
        ['MIN(DISTINCT c)', Math.min.apply(null, ROW.map(x => x.c))],
        ['MAX(DISTINCT c)', Math.max.apply(null, ROW.map(x => x.c))],
        ['COUNT(DISTINCT a) + COUNT(DISTINCT b)', uniq(ROW, x => x.a) + uniq(ROW, x => x.b)]
      ];
      E_DISTINCT.forEach((c, i) => val('V37E DISTINCT#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " FROM v37_t", c[1]));
      ['g2', 'g4', 'g5', 'g8', 'g10'].forEach(gk => {
        t('V37E COUNT(DISTINCT a) per ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const keys = [...m.keys()].sort();
          return expectDeep(rows("SELECT " + gk + " AS k, COUNT(DISTINCT a) AS n FROM v37_t GROUP BY " + gk + " ORDER BY k"),
                            keys.map(k => ({ k: k, n: uniq(m.get(k), x => x.a) })));
        });
        val('V37E DISTINCT pair with ' + gk,
            "SELECT COUNT(*) FROM (SELECT DISTINCT " + gk + ", b FROM v37_t) z", uniq(ROW, x => x[gk] + '|' + x.b));
      });

      // ============================================================
      // F. 文字列を畳み込む集計
      // ============================================================
      val('V37F GROUP_CONCAT of five ids', "SELECT GROUP_CONCAT(id) FROM v37_t WHERE id <= 5", '1,2,3,4,5');
      val('V37F GROUP_CONCAT with a SEPARATOR', "SELECT GROUP_CONCAT(id SEPARATOR '-') FROM v37_t WHERE id <= 5", '1-2-3-4-5');
      val('V37F GROUP_CONCAT with a second argument', "SELECT GROUP_CONCAT(id, '|') FROM v37_t WHERE id <= 5", '1|2|3|4|5');
      val('V37F GROUP_CONCAT ordered descending',
          "SELECT GROUP_CONCAT(id ORDER BY id DESC) FROM v37_t WHERE id <= 5", '5,4,3,2,1');
      val('V37F GROUP_CONCAT DISTINCT over the groups',
          "SELECT GROUP_CONCAT(DISTINCT g5 ORDER BY g5) FROM v37_t", [...new Set(ROW.map(x => x.g5))].sort().join(','));
      val('V37F STRING_AGG with a separator', "SELECT STRING_AGG(id, '-') FROM v37_t WHERE id <= 5", '1-2-3-4-5');
      val('V37F LISTAGG WITHIN GROUP', "SELECT LISTAGG(id, '/') WITHIN GROUP (ORDER BY id DESC) FROM v37_t WHERE id <= 5",
          '5/4/3/2/1');
      val('V37F GROUP_CONCAT length over the whole table', "SELECT LENGTH(GROUP_CONCAT(id)) FROM v37_t",
          sum(ROW, r => String(r.id).length) + ROW.length - 1);
      val('V37F ARRAY_AGG length', "SELECT ARRAY_LENGTH(ARRAY_AGG(id)) FROM v37_t WHERE id <= 100", 100);
      val('V37F JSON_ARRAYAGG length', "SELECT JSON_LENGTH(JSON_ARRAYAGG(id)) FROM v37_t WHERE id <= 100", 100);
      ['g2', 'g4', 'g5', 'g8', 'g10'].forEach(gk => {
        t('V37F GROUP_CONCAT lengths per ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const keys = [...m.keys()].sort();
          const want = keys.map(k => ({ k: k, l: sum(m.get(k), x => String(x.id).length) + m.get(k).length - 1 }));
          return expectDeep(rows("SELECT " + gk + " AS k, LENGTH(GROUP_CONCAT(id)) AS l FROM v37_t GROUP BY " + gk +
                                 " ORDER BY k"), want);
        });
        t('V37F ARRAY_AGG sizes per ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const keys = [...m.keys()].sort();
          return expectDeep(rows("SELECT " + gk + " AS k, ARRAY_LENGTH(ARRAY_AGG(a)) AS n FROM v37_t GROUP BY " + gk +
                                 " ORDER BY k"), keys.map(k => ({ k: k, n: m.get(k).length })));
        });
      });
      val('V37F GROUP_CONCAT of an empty selection is NULL',
          "SELECT COALESCE(GROUP_CONCAT(id), 'none') FROM v37_t WHERE id > 100000", 'none');
      val('V37F GROUP_CONCAT skips NULLs',
          "SELECT LENGTH(GROUP_CONCAT(nv)) FROM v37_t WHERE id <= 22",
          ROW.filter(r => r.id <= 22 && r.nv !== null).map(r => String(r.nv)).join(',').length);

      // ============================================================
      // G. 統計集計
      // ============================================================
      const A = x => x.a, C = x => x.c;
      const G_STATS = [
        ['STDDEV_POP(a)', Math.sqrt(varPop(ROW, A))],
        ['STDDEV_SAMP(a)', Math.sqrt(varSamp(ROW, A))],
        ['VAR_POP(a)', varPop(ROW, A)],
        ['VAR_SAMP(a)', varSamp(ROW, A)],
        ['STDDEV_POP(c)', Math.sqrt(varPop(ROW, C))],
        ['VAR_POP(c)', varPop(ROW, C)],
        ['COVAR_POP(a, c)', covPop(ROW, A, C)],
        ['CORR(a, c)', covPop(ROW, A, C) / (Math.sqrt(varPop(ROW, A)) * Math.sqrt(varPop(ROW, C)))],
        ['REGR_COUNT(c, a)', ROW.length],
        ['REGR_AVGX(c, a)', mean(ROW, A)],
        ['REGR_AVGY(c, a)', mean(ROW, C)],
        ['REGR_SLOPE(c, a)', covPop(ROW, A, C) / varPop(ROW, A)],
        ['REGR_INTERCEPT(c, a)', mean(ROW, C) - (covPop(ROW, A, C) / varPop(ROW, A)) * mean(ROW, A)],
        ['REGR_SXX(c, a)', varPop(ROW, A) * ROW.length],
        ['REGR_SYY(c, a)', varPop(ROW, C) * ROW.length],
        ['REGR_SXY(c, a)', covPop(ROW, A, C) * ROW.length]
      ];
      G_STATS.forEach((c, i) => t('V37G#' + (i + 1) + ' ' + c[0], () =>
        expectRel(one("SELECT " + c[0] + " FROM v37_t"), c[1], c[0])));
      ['g2', 'g4', 'g5', 'g8'].forEach(gk => {
        [['STDDEV_POP(a)', g => Math.sqrt(varPop(g, A))],
         ['VAR_POP(a)', g => varPop(g, A)],
         ['VAR_SAMP(c)', g => varSamp(g, C)],
         ['CORR(a, c)', g => covPop(g, A, C) / (Math.sqrt(varPop(g, A)) * Math.sqrt(varPop(g, C)))]].forEach(st => {
          t('V37G ' + st[0] + ' per ' + gk, () => {
            const m = byKey(ROW, x => x[gk]);
            const keys = [...m.keys()].sort();
            const got = rows("SELECT " + gk + " AS k, " + st[0] + " AS m FROM v37_t GROUP BY " + gk + " ORDER BY k");
            expect(got.length, keys.length, 'group count');
            got.forEach((r, i) => expectRel(r.m, st[1](m.get(keys[i])), keys[i]));
            return true;
          });
        });
      });

      // ============================================================
      // H. WITHIN GROUP
      // ============================================================
      const A_SORTED = ROW.map(x => x.a).sort((p, r) => p - r);
      const C_SORTED = ROW.map(x => x.c).sort((p, r) => p - r);
      const H_PCTS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
      H_PCTS.forEach(p => {
        t('V37H PERCENTILE_CONT(' + p + ') over a', () =>
          expectRel(one("SELECT PERCENTILE_CONT(" + p + ") WITHIN GROUP (ORDER BY a) FROM v37_t"), pctCont(A_SORTED, p)));
        t('V37H PERCENTILE_CONT(' + p + ') over c', () =>
          expectRel(one("SELECT PERCENTILE_CONT(" + p + ") WITHIN GROUP (ORDER BY c) FROM v37_t"), pctCont(C_SORTED, p)));
      });
      t('V37H MEDIAN(a) equals the 0.5 percentile', () =>
        expectRel(one("SELECT MEDIAN(a) FROM v37_t"), pctCont(A_SORTED, 0.5)));
      t('V37H MEDIAN(c) equals the 0.5 percentile', () =>
        expectRel(one("SELECT MEDIAN(c) FROM v37_t"), pctCont(C_SORTED, 0.5)));
      val('V37H MODE picks the most frequent b',
          "SELECT MODE() WITHIN GROUP (ORDER BY b) FROM v37_t",
          (() => { const m = byKey(ROW, x => x.b); let best = null, bn = -1;
                   [...m.entries()].sort((p, r) => p[0] - r[0]).forEach(e => { if (e[1].length > bn) { bn = e[1].length; best = e[0]; } });
                   return best; })());
      ['g2', 'g4', 'g5', 'g8', 'g10'].forEach(gk => {
        [0.25, 0.5, 0.75].forEach(p => {
          t('V37H PERCENTILE_CONT(' + p + ') per ' + gk, () => {
            const m = byKey(ROW, x => x[gk]);
            const keys = [...m.keys()].sort();
            const got = rows("SELECT " + gk + " AS k, PERCENTILE_CONT(" + p + ") WITHIN GROUP (ORDER BY a) AS m " +
                             "FROM v37_t GROUP BY " + gk + " ORDER BY k");
            got.forEach((r, i) => expectRel(r.m, pctCont(m.get(keys[i]).map(x => x.a).sort((u, v) => u - v), p), keys[i]));
            return true;
          });
        });
        t('V37H MEDIAN per ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const keys = [...m.keys()].sort();
          const got = rows("SELECT " + gk + " AS k, MEDIAN(c) AS m FROM v37_t GROUP BY " + gk + " ORDER BY k");
          got.forEach((r, i) => expectRel(r.m, pctCont(m.get(keys[i]).map(x => x.c).sort((u, v) => u - v), 0.5), keys[i]));
          return true;
        });
      });

      // ============================================================
      // I. 集計を含む式・比率・順位
      // ============================================================
      valNear('V37I the mean as a ratio of two aggregates', "SELECT SUM(a) * 1.0 / COUNT(*) FROM v37_t",
              mean(ROW, A), 1e-9);
      valNear('V37I a rounded ratio', "SELECT ROUND(SUM(c) * 1.0 / SUM(b), 6) FROM v37_t",
              Math.round(sum(ROW, C) / sum(ROW, x => x.b) * 1e6) / 1e6, 1e-9);
      val('V37I an aggregate inside CASE',
          "SELECT CASE WHEN SUM(a) > 1000 THEN 1 ELSE 0 END FROM v37_t", sum(ROW, A) > 1000 ? 1 : 0);
      val('V37I two aggregates added', "SELECT SUM(a) + SUM(b) FROM v37_t", sum(ROW, A) + sum(ROW, x => x.b));
      val('V37I an aggregate multiplied', "SELECT COUNT(*) * 2 FROM v37_t", ROW.length * 2);
      val('V37I an aggregate of an expression', "SELECT SUM(a * 2 + b) FROM v37_t", sum(ROW, x => x.a * 2 + x.b));
      val('V37I an aggregate over a CASE', "SELECT SUM(CASE WHEN a > 25 THEN 1 ELSE 0 END) FROM v37_t",
          cnt(ROW, x => x.a > 25));
      val('V37I COUNT_IF matches the CASE form', "SELECT COUNT_IF(a > 25) FROM v37_t", cnt(ROW, x => x.a > 25));
      ['g4', 'g5', 'g8', 'g10'].forEach(gk => {
        t('V37I group shares over ' + gk + ' add up to one', () => {
          const total = sum(ROW, A);
          const got = rows("SELECT " + gk + " AS k, SUM(a) AS s FROM v37_t GROUP BY " + gk + " ORDER BY k");
          return expectNear(sum(got, r => r.s) / total, 1, 1e-9);
        });
        t('V37I the largest group of ' + gk, () => {
          const m = byKey(ROW, x => x[gk]);
          const best = [...m.entries()].map(e => ({ k: e[0], n: e[1].length }))
                         .sort((p, r) => r.n - p.n || (p.k < r.k ? -1 : 1))[0];
          const got = rows("SELECT " + gk + " AS k, COUNT(*) AS n FROM v37_t GROUP BY " + gk + " ORDER BY n DESC, k LIMIT 1")[0];
          return expect(got.k, best.k, 'key') && expect(got.n, best.n, 'count');
        });
        t('V37I ordering groups of ' + gk + ' by SUM(a)', () => {
          const m = byKey(ROW, x => x[gk]);
          const want = [...m.entries()].map(e => ({ k: e[0], s: sum(e[1], A) }))
                         .sort((p, r) => r.s - p.s || (p.k < r.k ? -1 : 1));
          return expectDeep(rows("SELECT " + gk + " AS k, SUM(a) AS s FROM v37_t GROUP BY " + gk + " ORDER BY s DESC, k"), want);
        });
        val('V37I the number of groups of ' + gk, "SELECT COUNT(*) FROM (SELECT " + gk + " FROM v37_t GROUP BY " + gk + ") z",
            uniq(ROW, x => x[gk]));
      });
      val('V37I an empty selection gives one aggregate row',
          "SELECT COUNT(*) FROM (SELECT COUNT(*) AS n FROM v37_t WHERE id < 0) z", 1);
      val('V37I an empty selection groups to nothing',
          "SELECT COUNT(*) FROM (SELECT g4, COUNT(*) FROM v37_t WHERE id < 0 GROUP BY g4) z", 0);
      val('V37I the empty-set SUM follows the engine rule', "SELECT SUM(a) FROM v37_t WHERE id < 0", 0);
      t('V37I the empty-set MIN is NULL', () => expect(one("SELECT MIN(a) FROM v37_t WHERE id < 0"), null));

      // ============================================================
      // J. 絞り込み x 集計の総当たり
      // ============================================================
      const J_FILTERS = [];
      [['a', x => x.a, [5, 15, 25, 35, 45, 49]], ['b', x => x.b, [3, 6, 9, 12, 15, 17]],
       ['c', x => x.c, [100, 300, 500, 700, 900, 999]], ['id', x => x.id, [500, 1000, 1500, 2000, 2499]]].forEach(spec => {
        [['>', (u, v) => u > v], ['<', (u, v) => u < v], ['=', (u, v) => u === v],
         ['>=', (u, v) => u >= v], ['<=', (u, v) => u <= v], ['<>', (u, v) => u !== v]].forEach(op => {
          spec[2].forEach(lit => J_FILTERS.push([spec[0] + ' ' + op[0] + ' ' + lit, x => op[1](spec[1](x), lit)]));
        });
      });
      [['g3', x => x.g3, ["'B0'", "'B1'", "'B2'"]], ['g5', x => x.g5, ["'D0'", "'D2'", "'D4'"]],
       ['g10', x => x.g10, ["'F1'", "'F5'", "'F9'"]]].forEach(spec => {
        [['=', (u, v) => u === v], ['<>', (u, v) => u !== v], ['>', (u, v) => u > v]].forEach(op => {
          spec[2].forEach(lit => J_FILTERS.push([spec[0] + ' ' + op[0] + ' ' + lit,
                                                 x => op[1](spec[1](x), lit.slice(1, -1))]));
        });
      });
      const J_AGGS = [
        ['COUNT(*)', g => g.length],
        ['SUM(a)', g => sum(g, x => x.a)],
        ['SUM(b)', g => sum(g, x => x.b)],
        ['COUNT(DISTINCT g10)', g => uniq(g, x => x.g10)],
        ['COUNT(nv)', g => cnt(g, x => x.nv !== null)],
        ['MAX(c)', g => g.length ? Math.max.apply(null, g.map(x => x.c)) : null]
      ];
      J_FILTERS.forEach((f, i) => {
        const hit = ROW.filter(f[1]);
        J_AGGS.forEach(ag => {
          if (hit.length === 0 && ag[0] === 'MAX(c)') return;   // 空集合の MAX は NULL（別途 I で確認済み）
          val('V37J#' + (i + 1) + ' [' + f[0] + '] ' + ag[0],
              "SELECT " + ag[0] + " FROM v37_t WHERE " + f[0], ag[1](hit));
        });
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V37Zz cleanup', () => {
        q("DROP TABLE IF EXISTS v37_t");
        return !db.tables['v37_t'];
      });

      return T;
    }
