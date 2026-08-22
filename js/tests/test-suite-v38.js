    // ============================================================================
    // [Test Suite v38] - ウィンドウ関数の網羅
    //
    //   800 行の表に対し、関数 x 区画 x 並び x フレームを総当たりで流す。各テストは
    //   1,200 個ではなく **800 行ぶんの値を丸ごと** JavaScript 側の模型と突き合わせる
    //   ので、1 行でもずれれば落ちる。
    //
    //     A. フィクスチャ            F. RANGE / GROUPS
    //     B. 順位付けの関数          G. QUALIFY / 名前付きウィンドウ
    //     C. フレーム x 集計         H. 式に埋めたウィンドウ / 複数ウィンドウ
    //     D. EXCLUDE                 I. GROUP BY 結果への窓
    //     E. LAG / LEAD / 位置関数   J. 累積・移動平均の検算
    //
    //   test-suite.js の tests 配列へ getV38Tests() のスプレッドで合流する
    // ============================================================================
    function getV38Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, rowsOf: rows, oneOf: one, numEq: same, expect, expectDeep, val, sum, cnt, uniq,
              byKey } = makeTestKit('V38');
      const colOf = (sql, name) => rows(sql).map(r => r[name]);
      const expectArr = (got, want, eps, label) => {
        if (got.length !== want.length) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + want.length + ' rows but got ' + got.length);
        }
        for (let i = 0; i < want.length; i++) {
          const a = got[i], b = want[i];
          if (a === b) continue;
          if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (eps || 0)) continue;
          throw new Error((label ? label + ' ' : '') + 'row ' + i + ': expected ' + JSON.stringify(b) +
                          ' but got ' + JSON.stringify(a));
        }
        return true;
      };

      // ----------------------------------------------------------------
      // 模型
      // ----------------------------------------------------------------
      const W = [];
      for (let n = 1; n <= 800; n++) {
        W.push({
          id: n, g4: 'G' + (n % 4), g6: 'H' + (n % 6), sub: 'S' + (n % 3),
          v: n % 50, w: 1 + (n % 20),
          nv: (n % 9 === 0) ? null : (n % 30),
          txt: 'p' + (n % 12)
        });
      }
      // ウィンドウの模型。calc は「並べ替え済みの区画」を受け取り各行の値を返す
      const winOf = (arr, partf, cmp, calc) => {
        const out = new Map();
        for (const g of byKey(arr, partf).values()) {
          const s = cmp ? g.slice().sort(cmp) : g.slice();
          const v = calc(s);
          s.forEach((r, i) => out.set(r.id, v[i]));
        }
        return arr.slice().sort((a, b) => a.id - b.id).map(r => out.get(r.id));
      };
      const calcRowNumber = s => s.map((_, i) => i + 1);
      const calcRank = keyf => s => {
        const out = []; let last, lastRank = 0, first = true;
        s.forEach((r, i) => { const k = keyf(r); if (first || k !== last) { lastRank = i + 1; last = k; first = false; } out.push(lastRank); });
        return out;
      };
      const calcDenseRank = keyf => s => {
        const out = []; let last, d = 0, first = true;
        s.forEach(r => { const k = keyf(r); if (first || k !== last) { d++; last = k; first = false; } out.push(d); });
        return out;
      };
      const calcPercentRank = keyf => s => {
        const rk = calcRank(keyf)(s), n = s.length;
        return rk.map(r => n === 1 ? 0 : (r - 1) / (n - 1));
      };
      // CUME_DIST は「並び順で自分と同順位までの行数 / 全行数」。昇順・降順のどちらでも
      // 同じ規則になるよう、並べ替え済みの配列の中で「同順位の最後の位置」から求める
      const calcCumeDist = keyf => s => {
        const n = s.length;
        return s.map((r, i) => {
          let last = i;
          while (last + 1 < n && keyf(s[last + 1]) === keyf(r)) last++;
          return (last + 1) / n;
        });
      };
      const calcNtile = k => s => {
        const n = s.length, base = Math.floor(n / k), rem = n % k, out = [];
        let idx = 0;
        for (let tile = 1; tile <= k; tile++) { const size = base + (tile <= rem ? 1 : 0); for (let j = 0; j < size; j++) out[idx++] = tile; }
        return out;
      };
      const calcRows = (agg, lo, hi) => s => s.map((_, i) => {
        const a = lo === null ? 0 : Math.max(0, i + lo);
        const b = hi === null ? s.length - 1 : Math.min(s.length - 1, i + hi);
        return a > b ? null : agg(s.slice(a, b + 1));
      });
      const aSum = f => a => a.reduce((x, y) => x + f(y), 0);
      const aAvg = f => a => a.reduce((x, y) => x + f(y), 0) / a.length;
      const aCount = () => a => a.length;
      const aCountOf = f => a => a.filter(x => f(x) !== null && f(x) !== undefined).length;
      const aMin = f => a => Math.min.apply(null, a.map(f));
      const aMax = f => a => Math.max.apply(null, a.map(f));
      const VV = r => r.v, WW = r => r.w;

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V38A build the table', () => {
        q('DROP TABLE IF EXISTS v38_w');
        let r = q("CREATE TABLE v38_w (id INT PRIMARY KEY, g4 TEXT, g6 TEXT, sub TEXT, v INT, w INT, nv INT, txt TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v38_w (id, g4, g6, sub, v, w, nv, txt) SELECT n, 'G' || (n % 4), 'H' || (n % 6), " +
              "'S' || (n % 3), n % 50, 1 + (n % 20), CASE WHEN n % 9 = 0 THEN NULL ELSE n % 30 END, 'p' || (n % 12) " +
              "FROM GENERATE_SERIES(1, 800) AS g(n)");
        if (r.error) throw new Error(r.error);
        return expect(db.tables['v38_w'].rowCount, 800);
      });
      val('V38A row count', "SELECT COUNT(*) FROM v38_w", W.length);
      val('V38A SUM(v)', "SELECT SUM(v) FROM v38_w", sum(W, VV));
      val('V38A SUM(w)', "SELECT SUM(w) FROM v38_w", sum(W, WW));
      val('V38A COUNT(nv)', "SELECT COUNT(nv) FROM v38_w", cnt(W, r => r.nv !== null));

      const PARTS = [
        { tag: 'no partition', sql: '', f: () => '*' },
        { tag: 'PARTITION BY g4', sql: 'PARTITION BY g4 ', f: r => r.g4 },
        { tag: 'PARTITION BY g6', sql: 'PARTITION BY g6 ', f: r => r.g6 },
        { tag: 'PARTITION BY sub', sql: 'PARTITION BY sub ', f: r => r.sub },
        { tag: 'PARTITION BY g4, sub', sql: 'PARTITION BY g4, sub ', f: r => r.g4 + '|' + r.sub }
      ];
      const TOTAL_ORDERS = [
        { tag: 'ORDER BY id', sql: 'ORDER BY id', cmp: (a, b) => a.id - b.id },
        { tag: 'ORDER BY v, id', sql: 'ORDER BY v, id', cmp: (a, b) => a.v - b.v || a.id - b.id },
        { tag: 'ORDER BY v DESC, id', sql: 'ORDER BY v DESC, id', cmp: (a, b) => b.v - a.v || a.id - b.id },
        { tag: 'ORDER BY w, id', sql: 'ORDER BY w, id', cmp: (a, b) => a.w - b.w || a.id - b.id },
        { tag: 'ORDER BY txt, id', sql: 'ORDER BY txt, id', cmp: (a, b) => (a.txt < b.txt ? -1 : a.txt > b.txt ? 1 : 0) || a.id - b.id }
      ];
      const PEER_ORDERS = [
        { tag: 'ORDER BY v', sql: 'ORDER BY v', cmp: (a, b) => a.v - b.v, key: VV },
        { tag: 'ORDER BY v DESC', sql: 'ORDER BY v DESC', cmp: (a, b) => b.v - a.v, key: VV },
        { tag: 'ORDER BY w', sql: 'ORDER BY w', cmp: (a, b) => a.w - b.w, key: WW },
        { tag: 'ORDER BY w DESC', sql: 'ORDER BY w DESC', cmp: (a, b) => b.w - a.w, key: WW }
      ];

      // ============================================================
      // B. 順位付けの関数
      // ============================================================
      PARTS.forEach(pt => {
        TOTAL_ORDERS.forEach(od => {
          t('V38B ROW_NUMBER ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT ROW_NUMBER() OVER (" + pt.sql + od.sql + ") AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, od.cmp, calcRowNumber), 0, 'row_number'));
        });
        PEER_ORDERS.forEach(od => {
          t('V38B RANK ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT RANK() OVER (" + pt.sql + od.sql + ") AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, od.cmp, calcRank(od.key)), 0, 'rank'));
          t('V38B DENSE_RANK ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT DENSE_RANK() OVER (" + pt.sql + od.sql + ") AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, od.cmp, calcDenseRank(od.key)), 0, 'dense_rank'));
        });
        PEER_ORDERS.slice(0, 3).forEach(od => {
          t('V38B PERCENT_RANK ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT PERCENT_RANK() OVER (" + pt.sql + od.sql + ") AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, od.cmp, calcPercentRank(od.key)), 1e-9, 'percent_rank'));
          t('V38B CUME_DIST ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT CUME_DIST() OVER (" + pt.sql + od.sql + ") AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, od.cmp, calcCumeDist(od.key)), 1e-9, 'cume_dist'));
        });
        [2, 3, 4, 7, 10].forEach(k => {
          t('V38B NTILE(' + k + ') ' + pt.tag, () =>
            expectArr(colOf("SELECT NTILE(" + k + ") OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, calcNtile(k)), 0, 'ntile'));
        });
      });

      // ============================================================
      // C. フレーム x 集計
      // ============================================================
      const FRAMES = [
        ['ROWS BETWEEN 1 PRECEDING AND CURRENT ROW', -1, 0],
        ['ROWS BETWEEN 2 PRECEDING AND CURRENT ROW', -2, 0],
        ['ROWS BETWEEN 3 PRECEDING AND CURRENT ROW', -3, 0],
        ['ROWS BETWEEN 5 PRECEDING AND CURRENT ROW', -5, 0],
        ['ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING', 0, 1],
        ['ROWS BETWEEN CURRENT ROW AND 3 FOLLOWING', 0, 3],
        ['ROWS BETWEEN CURRENT ROW AND 5 FOLLOWING', 0, 5],
        ['ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING', -1, 1],
        ['ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING', -2, 2],
        ['ROWS BETWEEN 4 PRECEDING AND 4 FOLLOWING', -4, 4],
        ['ROWS BETWEEN 10 PRECEDING AND 10 FOLLOWING', -10, 10],
        ['ROWS BETWEEN CURRENT ROW AND CURRENT ROW', 0, 0],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', null, 0],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND 1 FOLLOWING', null, 1],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND 5 FOLLOWING', null, 5],
        ['ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', 0, null],
        ['ROWS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING', -1, null],
        ['ROWS BETWEEN 5 PRECEDING AND UNBOUNDED FOLLOWING', -5, null],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', null, null],
        ['ROWS UNBOUNDED PRECEDING', null, 0],
        ['ROWS 1 PRECEDING', -1, 0],
        ['ROWS 3 PRECEDING', -3, 0],
        ['ROWS CURRENT ROW', 0, 0],
        ['ROWS BETWEEN 20 PRECEDING AND CURRENT ROW', -20, 0]
      ];
      const FRAME_AGGS = [
        ['SUM(v)', aSum(VV), 0], ['SUM(w)', aSum(WW), 0], ['COUNT(*)', aCount(), 0],
        ['MIN(v)', aMin(VV), 0], ['MAX(v)', aMax(VV), 0], ['MIN(w)', aMin(WW), 0],
        ['MAX(w)', aMax(WW), 0], ['AVG(v)', aAvg(VV), 1e-9]
      ];
      const FRAME_PARTS = PARTS;
      FRAMES.forEach(fr => {
        FRAME_PARTS.forEach(pt => {
          FRAME_AGGS.forEach(ag => {
            t('V38C ' + ag[0] + ' over ' + fr[0] + ' ' + pt.tag, () =>
              expectArr(colOf("SELECT " + ag[0] + " OVER (" + pt.sql + "ORDER BY id " + fr[0] + ") AS x " +
                              "FROM v38_w ORDER BY id", 'x'),
                        winOf(W, pt.f, (a, b) => a.id - b.id, calcRows(ag[1], fr[1], fr[2])), ag[2], ag[0]));
          });
        });
      });
      t('V38C COUNT of a NULL-bearing column over a frame', () =>
        expectArr(colOf("SELECT COUNT(nv) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS x " +
                        "FROM v38_w ORDER BY id", 'x'),
                  winOf(W, () => '*', (a, b) => a.id - b.id, calcRows(aCountOf(r => r.nv), -2, 0)), 0, 'count nv'));
      t('V38C SUM over a NULL-bearing column ignores the NULLs', () =>
        expectArr(colOf("SELECT SUM(nv) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS x " +
                        "FROM v38_w ORDER BY id", 'x'),
                  winOf(W, () => '*', (a, b) => a.id - b.id,
                        calcRows(a => a.reduce((s, y) => s + (y.nv === null ? 0 : y.nv), 0), -1, 0)), 0, 'sum nv'));

      // ============================================================
      // D. EXCLUDE
      // ============================================================
      t('V38D EXCLUDE CURRENT ROW drops the row itself', () => {
        const total = sum(W, VV);
        return expectArr(colOf("SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE CURRENT ROW) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => total - r.v), 0, 'exclude current row');
      });
      t('V38D EXCLUDE NO OTHERS keeps the whole frame', () =>
        expectArr(colOf("SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                        "EXCLUDE NO OTHERS) AS x FROM v38_w ORDER BY id", 'x'),
                  W.map(() => sum(W, VV)), 0, 'exclude no others'));
      t('V38D EXCLUDE GROUP drops the whole peer group', () => {
        const total = sum(W, VV);
        const byV = byKey(W, r => r.v);
        return expectArr(colOf("SELECT SUM(v) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE GROUP) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => total - sum(byV.get(r.v), VV)), 0, 'exclude group');
      });
      t('V38D EXCLUDE TIES keeps the current row but drops its peers', () => {
        const total = sum(W, VV);
        const byV = byKey(W, r => r.v);
        return expectArr(colOf("SELECT SUM(v) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE TIES) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => total - sum(byV.get(r.v), VV) + r.v), 0, 'exclude ties');
      });
      ['COUNT(*)', 'MAX(w)', 'MIN(w)'].forEach(ag => {
        t('V38D ' + ag + ' with EXCLUDE NO OTHERS equals the plain frame', () =>
          expectArr(colOf("SELECT " + ag + " OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING " +
                          "EXCLUDE NO OTHERS) AS x FROM v38_w ORDER BY id", 'x'),
                    colOf("SELECT " + ag + " OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS x " +
                          "FROM v38_w ORDER BY id", 'x'), 0, ag));
      });

      // ============================================================
      // E. LAG / LEAD / 位置関数
      // ============================================================
      const calcLag = (f, off, dflt) => s => s.map((_, i) => i - off >= 0 ? f(s[i - off]) : dflt);
      const calcLead = (f, off, dflt) => s => s.map((_, i) => i + off < s.length ? f(s[i + off]) : dflt);
      [1, 2, 3, 5, 10, 25].forEach(off => {
        PARTS.slice(0, 3).forEach(pt => {
          t('V38E LAG(v, ' + off + ') ' + pt.tag, () =>
            expectArr(colOf("SELECT LAG(v, " + off + ") OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, calcLag(VV, off, null)), 0, 'lag'));
          t('V38E LEAD(v, ' + off + ') ' + pt.tag, () =>
            expectArr(colOf("SELECT LEAD(v, " + off + ") OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, calcLead(VV, off, null)), 0, 'lead'));
          t('V38E LAG(v, ' + off + ', -1) ' + pt.tag, () =>
            expectArr(colOf("SELECT LAG(v, " + off + ", -1) OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, calcLag(VV, off, -1)), 0, 'lag default'));
          t('V38E LEAD(v, ' + off + ', -1) ' + pt.tag, () =>
            expectArr(colOf("SELECT LEAD(v, " + off + ", -1) OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, calcLead(VV, off, -1)), 0, 'lead default'));
        });
      });
      PARTS.slice(0, 3).forEach(pt => {
        t('V38E FIRST_VALUE over the whole partition ' + pt.tag, () =>
          expectArr(colOf("SELECT FIRST_VALUE(v) OVER (" + pt.sql + "ORDER BY id " +
                          "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v38_w ORDER BY id", 'x'),
                    winOf(W, pt.f, (a, b) => a.id - b.id, s => s.map(() => s[0].v)), 0, 'first_value'));
        t('V38E LAST_VALUE over the whole partition ' + pt.tag, () =>
          expectArr(colOf("SELECT LAST_VALUE(v) OVER (" + pt.sql + "ORDER BY id " +
                          "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v38_w ORDER BY id", 'x'),
                    winOf(W, pt.f, (a, b) => a.id - b.id, s => s.map(() => s[s.length - 1].v)), 0, 'last_value'));
        t('V38E LAST_VALUE with the default frame is the current row ' + pt.tag, () =>
          expectArr(colOf("SELECT LAST_VALUE(v) OVER (" + pt.sql + "ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                    W.map(r => r.v), 0, 'last_value default'));
        [1, 2, 3, 5, 8].forEach(n => {
          t('V38E NTH_VALUE(v, ' + n + ') ' + pt.tag, () =>
            expectArr(colOf("SELECT NTH_VALUE(v, " + n + ") OVER (" + pt.sql + "ORDER BY id " +
                            "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v38_w ORDER BY id", 'x'),
                      winOf(W, pt.f, (a, b) => a.id - b.id, s => s.map(() => s.length >= n ? s[n - 1].v : null)), 0, 'nth_value'));
        });
      });
      t('V38E LAG IGNORE NULLS skips the NULL rows', () => {
        const want = winOf(W, () => '*', (a, b) => a.id - b.id, s => s.map((_, i) => {
          for (let j = i - 1; j >= 0; j--) if (s[j].nv !== null) return s[j].nv;
          return null;
        }));
        return expectArr(colOf("SELECT LAG(nv) IGNORE NULLS OVER (ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                         want, 0, 'lag ignore nulls');
      });
      t('V38E LEAD IGNORE NULLS skips the NULL rows', () => {
        const want = winOf(W, () => '*', (a, b) => a.id - b.id, s => s.map((_, i) => {
          for (let j = i + 1; j < s.length; j++) if (s[j].nv !== null) return s[j].nv;
          return null;
        }));
        return expectArr(colOf("SELECT LEAD(nv) IGNORE NULLS OVER (ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                         want, 0, 'lead ignore nulls');
      });
      t('V38E RESPECT NULLS is the plain behaviour', () =>
        expectArr(colOf("SELECT LAG(nv) RESPECT NULLS OVER (ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                  winOf(W, () => '*', (a, b) => a.id - b.id, calcLag(r => r.nv, 1, null)), 0, 'respect nulls'));

      // ============================================================
      // F. RANGE / GROUPS
      // ============================================================
      const RANGE_CASES = [
        ['RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', (s, r) => s.filter(x => x.v <= r.v)],
        ['RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', (s, r) => s.filter(x => x.v >= r.v)],
        ['RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', (s) => s],
        ['RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING', (s, r) => s.filter(x => x.v >= r.v - 1 && x.v <= r.v + 1)],
        ['RANGE BETWEEN 3 PRECEDING AND 3 FOLLOWING', (s, r) => s.filter(x => x.v >= r.v - 3 && x.v <= r.v + 3)],
        ['RANGE BETWEEN 5 PRECEDING AND CURRENT ROW', (s, r) => s.filter(x => x.v >= r.v - 5 && x.v <= r.v)],
        ['RANGE BETWEEN CURRENT ROW AND 5 FOLLOWING', (s, r) => s.filter(x => x.v >= r.v && x.v <= r.v + 5)],
        ['RANGE BETWEEN 10 PRECEDING AND 2 PRECEDING', (s, r) => s.filter(x => x.v >= r.v - 10 && x.v <= r.v - 2)]
      ];
      const RANGE_AGGS = [['SUM(w)', a => sum(a, WW)], ['COUNT(*)', a => a.length],
                          ['MIN(w)', a => a.length ? Math.min.apply(null, a.map(WW)) : null],
                          ['MAX(w)', a => a.length ? Math.max.apply(null, a.map(WW)) : null]];
      RANGE_CASES.forEach(rc => {
        RANGE_AGGS.forEach(ag => {
          t('V38F ' + ag[0] + ' over ' + rc[0], () => {
            // 空フレームは COUNT だけ 0、ほかは NULL
            const want = winOf(W, () => '*', (a, b) => a.v - b.v, s => s.map(r => {
              const fr = rc[1](s, r);
              return fr.length === 0 ? (ag[0] === 'COUNT(*)' ? 0 : null) : ag[1](fr);
            }));
            return expectArr(colOf("SELECT " + ag[0] + " OVER (ORDER BY v " + rc[0] + ") AS x FROM v38_w ORDER BY id", 'x'),
                             want, 0, ag[0]);
          });
        });
      });
      const GROUPS_CASES = [
        ['GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW', -1, 0],
        ['GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING', 0, 1],
        ['GROUPS BETWEEN 2 PRECEDING AND 2 FOLLOWING', -2, 2],
        ['GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', null, 0]
      ];
      GROUPS_CASES.forEach(gc => {
        [['SUM(w)', a => sum(a, WW)], ['COUNT(*)', a => a.length]].forEach(ag => {
          t('V38F ' + ag[0] + ' over ' + gc[0], () => {
            const want = winOf(W, () => '*', (a, b) => a.v - b.v || a.id - b.id, s => {
              const keys = [...new Set(s.map(r => r.v))].sort((p, r) => p - r);
              const idx = new Map(keys.map((k, i) => [k, i]));
              return s.map(r => {
                const i = idx.get(r.v);
                const loI = gc[1] === null ? 0 : i + gc[1];
                const hiI = gc[2] === null ? keys.length - 1 : i + gc[2];
                const fr = s.filter(x => { const j = idx.get(x.v); return j >= loI && j <= hiI; });
                return ag[1](fr);
              });
            });
            return expectArr(colOf("SELECT " + ag[0] + " OVER (ORDER BY v " + gc[0] + ") AS x FROM v38_w ORDER BY id", 'x'),
                             want, 0, ag[0]);
          });
        });
      });
      t('V38F the default frame follows RANGE to the current peer group', () =>
        expectArr(colOf("SELECT SUM(v) OVER (ORDER BY v) AS x FROM v38_w ORDER BY id", 'x'),
                  winOf(W, () => '*', (a, b) => a.v - b.v, s => s.map(r => sum(s.filter(x => x.v <= r.v), VV))),
                  0, 'range default'));
      t('V38F no ORDER BY means the whole partition', () => {
        const m = byKey(W, r => r.g4);
        return expectArr(colOf("SELECT SUM(v) OVER (PARTITION BY g4) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => sum(m.get(r.g4), VV)), 0, 'whole partition');
      });
      t('V38F an empty OVER () spans the whole table', () =>
        expectArr(colOf("SELECT SUM(v) OVER () AS x FROM v38_w ORDER BY id", 'x'), W.map(() => sum(W, VV)), 0, 'over()'));

      // ============================================================
      // G. QUALIFY / 名前付きウィンドウ
      // ============================================================
      [1, 2, 3, 5, 10].forEach(k => {
        ['g4', 'g6', 'sub'].forEach(gk => {
          val('V38G QUALIFY top ' + k + ' per ' + gk,
              "SELECT COUNT(*) FROM (SELECT id FROM v38_w QUALIFY ROW_NUMBER() OVER (PARTITION BY " + gk +
              " ORDER BY v DESC, id) <= " + k + ") z", uniq(W, r => r[gk]) * k);
        });
      });
      ['g4', 'g6', 'sub'].forEach(gk => {
        val('V38G QUALIFY RANK = 1 keeps the ties of ' + gk,
            "SELECT COUNT(*) FROM (SELECT id FROM v38_w QUALIFY RANK() OVER (PARTITION BY " + gk +
            " ORDER BY v DESC) = 1) z",
            (() => { const m = byKey(W, r => r[gk]);
                     return sum([...m.values()], g => cnt(g, r => r.v === Math.max.apply(null, g.map(VV)))); })());
        val('V38G QUALIFY with a WHERE clause over ' + gk,
            "SELECT COUNT(*) FROM (SELECT id FROM v38_w WHERE v > 10 QUALIFY ROW_NUMBER() OVER (PARTITION BY " + gk +
            " ORDER BY id) = 1) z", uniq(W.filter(r => r.v > 10), r => r[gk]));
        t('V38G QUALIFY picks exactly the partition maxima of ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          const want = [...m.keys()].sort().map(k => {
            const g = m.get(k).slice().sort((a, b) => b.v - a.v || a.id - b.id);
            return { k: k, id: g[0].id, v: g[0].v };
          });
          return expectDeep(rows("SELECT " + gk + " AS k, id AS id, v AS v FROM v38_w " +
                                 "QUALIFY ROW_NUMBER() OVER (PARTITION BY " + gk + " ORDER BY v DESC, id) = 1 ORDER BY k"), want);
        });
      });
      t('V38G a named window behaves like the inline one', () => {
        const inline = colOf("SELECT SUM(v) OVER (PARTITION BY g4 ORDER BY id ROWS UNBOUNDED PRECEDING) AS x " +
                             "FROM v38_w ORDER BY id", 'x');
        const named = colOf("SELECT SUM(v) OVER wnd AS x FROM v38_w " +
                            "WINDOW wnd AS (PARTITION BY g4 ORDER BY id ROWS UNBOUNDED PRECEDING) ORDER BY id", 'x');
        return expectArr(named, inline, 0, 'named window');
      });
      ['SUM(v)', 'COUNT(*)', 'AVG(v)', 'MIN(w)', 'MAX(w)', 'ROW_NUMBER()'].forEach(fnName => {
        t('V38G named window feeding ' + fnName, () => {
          const inline = colOf("SELECT " + fnName + " OVER (PARTITION BY g6 ORDER BY id) AS x FROM v38_w ORDER BY id", 'x');
          const named = colOf("SELECT " + fnName + " OVER wnd AS x FROM v38_w WINDOW wnd AS (PARTITION BY g6 ORDER BY id) " +
                              "ORDER BY id", 'x');
          return expectArr(named, inline, 1e-9, fnName);
        });
      });
      t('V38G two named windows in one query', () => {
        const byG4 = byKey(W, r => r.g4), byG6 = byKey(W, r => r.g6);
        const got = rows("SELECT SUM(v) OVER w1 AS a, SUM(v) OVER w2 AS b FROM v38_w " +
                         "WINDOW w1 AS (PARTITION BY g4), w2 AS (PARTITION BY g6) ORDER BY id LIMIT 200");
        got.forEach((r, i) => {
          expect(r.a, sum(byG4.get(W[i].g4), VV), 'w1');
          expect(r.b, sum(byG6.get(W[i].g6), VV), 'w2');
        });
        return true;
      });
      val('V38G QUALIFY can reference a window alias',
          "SELECT COUNT(*) FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY g4 ORDER BY id) AS rn FROM v38_w QUALIFY rn <= 3) z",
          uniq(W, r => r.g4) * 3);
      val('V38G QUALIFY on a named window',
          "SELECT COUNT(*) FROM (SELECT id FROM v38_w WINDOW wnd AS (PARTITION BY g6 ORDER BY id) " +
          "QUALIFY ROW_NUMBER() OVER wnd = 1) z", uniq(W, r => r.g6));

      // ============================================================
      // H. 式に埋めたウィンドウ / 複数ウィンドウ / FILTER
      // ============================================================
      t('V38H the difference from the previous row', () => {
        const want = winOf(W, () => '*', (a, b) => a.id - b.id, s => s.map((r, i) => i === 0 ? null : r.v - s[i - 1].v));
        return expectArr(colOf("SELECT v - LAG(v) OVER (ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'), want, 0, 'delta');
      });
      t('V38H the share of each row inside its partition', () => {
        const m = byKey(W, r => r.g4);
        return expectArr(colOf("SELECT v * 1.0 / SUM(v) OVER (PARTITION BY g4) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => r.v / sum(m.get(r.g4), VV)), 1e-9, 'share');
      });
      t('V38H a window inside ROUND', () => {
        const m = byKey(W, r => r.g6);
        return expectArr(colOf("SELECT ROUND(AVG(v) OVER (PARTITION BY g6), 4) AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => Math.round(sum(m.get(r.g6), VV) / m.get(r.g6).length * 1e4) / 1e4), 1e-9, 'round avg');
      });
      t('V38H a window inside COALESCE', () =>
        expectArr(colOf("SELECT COALESCE(LAG(v) OVER (ORDER BY id), -1) AS x FROM v38_w ORDER BY id", 'x'),
                  winOf(W, () => '*', (a, b) => a.id - b.id, calcLag(VV, 1, -1)), 0, 'coalesce lag'));
      t('V38H two windows added together', () => {
        const want = winOf(W, () => '*', (a, b) => a.id - b.id, s => s.map((_, i) => {
          const p = i - 1 >= 0 ? s[i - 1].v : null, n = i + 1 < s.length ? s[i + 1].v : null;
          return (p === null || n === null) ? null : p + n;
        }));
        return expectArr(colOf("SELECT LAG(v) OVER (ORDER BY id) + LEAD(v) OVER (ORDER BY id) AS x FROM v38_w ORDER BY id", 'x'),
                         want, 0, 'lag+lead');
      });
      t('V38H a window inside CASE', () => {
        const avg = sum(W, VV) / W.length;
        return expectArr(colOf("SELECT CASE WHEN v > AVG(v) OVER () THEN 1 ELSE 0 END AS x FROM v38_w ORDER BY id", 'x'),
                         W.map(r => r.v > avg ? 1 : 0), 0, 'case');
      });
      t('V38H a ranking multiplied by a constant', () =>
        expectArr(colOf("SELECT ROW_NUMBER() OVER (ORDER BY id) * 10 AS x FROM v38_w ORDER BY id", 'x'),
                  W.map((_, i) => (i + 1) * 10), 0, 'rn*10'));
      ['g4', 'g6', 'sub'].forEach(gk => {
        t('V38H FILTER inside a window aggregate over ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          return expectArr(colOf("SELECT SUM(v) FILTER (WHERE v > 25) OVER (PARTITION BY " + gk + ") AS x " +
                                 "FROM v38_w ORDER BY id", 'x'),
                           W.map(r => sum(m.get(r[gk]).filter(x => x.v > 25), VV)), 0, 'filter over');
        });
        t('V38H FILTER inside a window count over ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          return expectArr(colOf("SELECT COUNT(*) FILTER (WHERE w > 10) OVER (PARTITION BY " + gk + ") AS x " +
                                 "FROM v38_w ORDER BY id", 'x'),
                           W.map(r => cnt(m.get(r[gk]), x => x.w > 10)), 0, 'filter count over');
        });
        t('V38H RATIO_TO_REPORT over ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          return expectArr(colOf("SELECT RATIO_TO_REPORT(v) OVER (PARTITION BY " + gk + ") AS x FROM v38_w ORDER BY id", 'x'),
                           W.map(r => r.v / sum(m.get(r[gk]), VV)), 1e-9, 'ratio_to_report');
        });
      });
      ['g4', 'g6', 'sub'].forEach(gk => {
        t('V38H several window aggregates over ' + gk + ' in one query', () => {
          const m = byKey(W, r => r[gk]);
          const got = rows("SELECT SUM(v) OVER (PARTITION BY " + gk + ") AS s, COUNT(*) OVER (PARTITION BY " + gk + ") AS c, " +
                           "MIN(v) OVER (PARTITION BY " + gk + ") AS lo, MAX(v) OVER (PARTITION BY " + gk + ") AS hi " +
                           "FROM v38_w ORDER BY id LIMIT 150");
          got.forEach((r, i) => {
            const g = m.get(W[i][gk]);
            expect(r.s, sum(g, VV), 'sum'); expect(r.c, g.length, 'count');
            expect(r.lo, Math.min.apply(null, g.map(VV)), 'min'); expect(r.hi, Math.max.apply(null, g.map(VV)), 'max');
          });
          return true;
        });
      });

      // ============================================================
      // I. GROUP BY 結果への窓
      // ============================================================
      ['g4', 'g6', 'sub'].forEach(gk => {
        t('V38I ranking the groups of ' + gk + ' by SUM(v)', () => {
          const m = byKey(W, r => r[gk]);
          const want = [...m.entries()].map(e => ({ k: e[0], s: sum(e[1], VV) }))
                         .sort((a, b) => b.s - a.s || (a.k < b.k ? -1 : 1)).map((e, i) => ({ k: e.k, s: e.s, rn: i + 1 }));
          return expectDeep(rows("SELECT " + gk + " AS k, SUM(v) AS s, ROW_NUMBER() OVER (ORDER BY SUM(v) DESC, " + gk +
                                 ") AS rn FROM v38_w GROUP BY " + gk + " ORDER BY rn"), want);
        });
        t('V38I the running total of the groups of ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          const keys = [...m.keys()].sort();
          let acc = 0;
          const want = keys.map(k => { acc += sum(m.get(k), VV); return { k: k, rt: acc }; });
          return expectDeep(rows("SELECT " + gk + " AS k, SUM(SUM(v)) OVER (ORDER BY " + gk +
                                 " ROWS UNBOUNDED PRECEDING) AS rt FROM v38_w GROUP BY " + gk + " ORDER BY k"), want);
        });
        t('V38I the share of each group of ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          const keys = [...m.keys()].sort();
          const total = sum(W, VV);
          const got = rows("SELECT " + gk + " AS k, ROUND(100.0 * SUM(v) / SUM(SUM(v)) OVER (), 4) AS pct " +
                           "FROM v38_w GROUP BY " + gk + " ORDER BY k");
          keys.forEach((k, i) => expect(got[i].pct, Math.round(100 * sum(m.get(k), VV) / total * 1e4) / 1e4, k));
          return true;
        });
        t('V38I LAG over the groups of ' + gk, () => {
          const m = byKey(W, r => r[gk]);
          const keys = [...m.keys()].sort();
          const sums = keys.map(k => sum(m.get(k), VV));
          const want = keys.map((k, i) => ({ k: k, p: i === 0 ? -1 : sums[i - 1] }));
          return expectDeep(rows("SELECT " + gk + " AS k, LAG(SUM(v), 1, -1) OVER (ORDER BY " + gk + ") AS p " +
                                 "FROM v38_w GROUP BY " + gk + " ORDER BY k"), want);
        });
      });

      // ============================================================
      // J. 累積・移動平均の検算
      // ============================================================
      t('J38J the running total ends at the grand total', () =>
        expect(one("SELECT MAX(rt) FROM (SELECT SUM(v) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS rt FROM v38_w) z"),
               sum(W, VV)));
      ['g4', 'g6', 'sub'].forEach(gk => {
        t('V38J the running total per ' + gk + ' reaches the partition total', () => {
          const m = byKey(W, r => r[gk]);
          const keys = [...m.keys()].sort();
          return expectDeep(rows("SELECT " + gk + " AS k, MAX(rt) AS m FROM (SELECT " + gk + ", SUM(v) OVER (PARTITION BY " +
                                 gk + " ORDER BY id ROWS UNBOUNDED PRECEDING) AS rt FROM v38_w) z GROUP BY " + gk + " ORDER BY k"),
                            keys.map(k => ({ k: k, m: sum(m.get(k), VV) })));
        });
        t('V38J the running count per ' + gk + ' reaches the partition size', () => {
          const m = byKey(W, r => r[gk]);
          const keys = [...m.keys()].sort();
          return expectDeep(rows("SELECT " + gk + " AS k, MAX(rc) AS m FROM (SELECT " + gk + ", COUNT(*) OVER (PARTITION BY " +
                                 gk + " ORDER BY id ROWS UNBOUNDED PRECEDING) AS rc FROM v38_w) z GROUP BY " + gk + " ORDER BY k"),
                            keys.map(k => ({ k: k, m: m.get(k).length })));
        });
      });
      [3, 5, 7, 10, 20].forEach(k => {
        t('V38J a ' + k + '-row moving average', () => {
          const want = winOf(W, () => '*', (a, b) => a.id - b.id,
                             calcRows(aAvg(VV), -(k - 1), 0));
          return expectArr(colOf("SELECT AVG(v) OVER (ORDER BY id ROWS BETWEEN " + (k - 1) +
                                 " PRECEDING AND CURRENT ROW) AS x FROM v38_w ORDER BY id", 'x'), want, 1e-9, 'moving avg');
        });
        t('V38J a ' + k + '-row moving sum', () => {
          const want = winOf(W, () => '*', (a, b) => a.id - b.id, calcRows(aSum(VV), -(k - 1), 0));
          return expectArr(colOf("SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN " + (k - 1) +
                                 " PRECEDING AND CURRENT ROW) AS x FROM v38_w ORDER BY id", 'x'), want, 0, 'moving sum');
        });
      });
      val('V38J counting rows above their partition average',
          "SELECT COUNT(*) FROM (SELECT v, AVG(v) OVER (PARTITION BY g4) AS a FROM v38_w) z WHERE v > a",
          (() => { const m = byKey(W, r => r.g4); return cnt(W, r => r.v > sum(m.get(r.g4), VV) / m.get(r.g4).length); })());
      val('V38J counting rows at their partition maximum',
          "SELECT COUNT(*) FROM (SELECT v, MAX(v) OVER (PARTITION BY g6) AS mx FROM v38_w) z WHERE v = mx",
          (() => { const m = byKey(W, r => r.g6); return cnt(W, r => r.v === Math.max.apply(null, m.get(r.g6).map(VV))); })());
      val('V38J the window result can be filtered outside',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY v DESC, id) AS rn FROM v38_w) z WHERE rn <= 100", 100);
      val('V38J two levels of windows',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY rn DESC) AS rn2 FROM " +
          "(SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v38_w) z) y", W.length);

      // ============================================================
      // 片付け
      // ============================================================
      t('V38Zz cleanup', () => {
        q("DROP TABLE IF EXISTS v38_w");
        return !db.tables['v38_w'];
      });

      return T;
    }
