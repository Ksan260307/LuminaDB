    // ============================================================================
    // [Test Suite v69] - 行数に対して二乗・線形だった処理の作り直し
    //
    //   A. ウィンドウのフレーム集計   行ごとにフレームを作り直していた（32,000 行で 27 秒）
    //   B. LIMIT の打ち切り           全行を組み立ててから捨てていた（40 万行で 164ms）
    //   C. 文字列プールの自動回収     UPDATE のたびに伸び続け、上限で挿入不能になっていた
    //   D. IN (副問い合わせ) の重複   相異なり 1,000 個を 20 万要素として毎行確保していた
    //
    //   いずれも「答えは合っているが桁違いに遅い」型なので、この層では**答えが
    //   変わっていないこと**を確かめる。速さは CHANGELOG に実測を残す。
    //
    //   test-suite.js の tests 配列へ getV69Tests() のスプレッドで合流する
    // ============================================================================
    function getV69Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup, expectNear } = makeTestKit('V69');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      //    60 行。NULL・同値・0・負値を混ぜ、ピア（ORDER BY 値が等しい行）も作る
      // ------------------------------------------------------------
      const ROWS = [];
      for (let i = 1; i <= 60; i++) {
        ROWS.push([
          i,
          i % 4,                                   // g: パーティション
          (i % 7 === 0) ? null : (i * 13) % 29,    // v: NULL 混じり・同値多数
          ((i * 7) % 13) / 4,                      // f: 小数
          (i % 5 === 0) ? null : 's' + (i % 9)     // s: 文字列（MIN/MAX 用）
        ]);
      }
      t('V69 fixture', () => {
        drop('v69_w', 'v69_p', 'v69_big', 'v69_probe');
        q("CREATE TABLE v69_w (id INT PRIMARY KEY, g INT, v INT, f DECIMAL(10,2), s TEXT)");
        insertRows('v69_w', ROWS);
        return db.tables['v69_w'].rowCount === 60;
      });

      // ============================================================
      // A. ウィンドウのフレーム集計
      //    前計算（累積和・持ち回りの最良値）で引いた結果が、
      //    JS 側で素直に組んだ参照実装と一致すること
      // ============================================================
      const R = ROWS.map(r => ({ id: r[0], g: r[1], v: r[2], f: r[3], s: r[4] }));

      // 参照実装: [lo, hi] を素直に走査して集計する
      const refAgg = (rows, fn, key) => {
        const vals = rows.map(r => r[key]).filter(x => x !== null && x !== undefined);
        if (fn === 'COUNT') return vals.length;
        if (vals.length === 0) return null;
        if (fn === 'SUM') return vals.reduce((a, b) => a + b, 0);
        if (fn === 'AVG') return vals.reduce((a, b) => a + b, 0) / vals.length;
        if (fn === 'MIN') return vals.reduce((a, b) => (b < a ? b : a));
        if (fn === 'MAX') return vals.reduce((a, b) => (b > a ? b : a));
        return null;
      };
      // ROWS フレームの窓を切り出す（境界は行位置）
      const win = (arr, i, pre, fol) => {
        const lo = pre === null ? 0 : Math.max(0, i - pre);
        const hi = fol === null ? arr.length - 1 : Math.min(arr.length - 1, i + fol);
        return lo > hi ? [] : arr.slice(lo, hi + 1);
      };

      const FRAMES = [
        // ラベル, SQL のフレーム, 参照側の [preceding, following]（null は UNBOUNDED）
        ['既定（累計）',           'ORDER BY id',                                                        [null, 0]],
        ['明示 UNBOUNDED..CURRENT','ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',       [null, 0]],
        ['3 PRECEDING..CURRENT',   'ORDER BY id ROWS BETWEEN 3 PRECEDING AND CURRENT ROW',              [3, 0]],
        ['2 PRECEDING..2 FOLLOWING','ORDER BY id ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING',             [2, 2]],
        ['CURRENT..UNBOUNDED',     'ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING',      [0, null]],
        ['全体',                   'ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', [null, null]]
      ];

      ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].forEach(fn => {
        FRAMES.forEach(([label, over, [pre, fol]]) => {
          t(`A ${fn}(v) / ${label}`, () => {
            const got = q(`SELECT id, ${fn}(v) OVER (${over}) AS r FROM v69_w ORDER BY id`).data.map(x => x.r);
            const want = R.map((_, i) => refAgg(win(R, i, pre, fol), fn, 'v'));
            for (let i = 0; i < want.length; i++) {
              const a = got[i], b = want[i];
              if (a === null || b === null) { if (a !== b) throw new Error(`row ${i + 1}: expected ${b} got ${a}`); continue; }
              if (Math.abs(a - b) > 1e-9) throw new Error(`row ${i + 1}: expected ${b} got ${a}`);
            }
            return true;
          });
        });
      });

      // 文字列の MIN / MAX は生値の比較（数値へ寄せない）
      t('A MIN(s) は文字列として比べる', () => {
        const got = q("SELECT id, MIN(s) OVER (ORDER BY id) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const want = R.map((_, i) => refAgg(win(R, i, null, 0), 'MIN', 's'));
        return eq(got, want, 'MIN(s) の累計');
      });
      t('A MAX(s) は文字列として比べる', () => {
        const got = q("SELECT id, MAX(s) OVER (ORDER BY id) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const want = R.map((_, i) => refAgg(win(R, i, null, 0), 'MAX', 's'));
        return eq(got, want, 'MAX(s) の累計');
      });

      // FIRST_VALUE / LAST_VALUE は前計算の O(1) 経路を通る
      t('A FIRST_VALUE は窓の先頭', () => {
        const got = q("SELECT id, FIRST_VALUE(v) OVER (ORDER BY id ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const want = R.map((_, i) => win(R, i, 3, 0)[0].v);
        return eq(got, want, 'FIRST_VALUE');
      });
      t('A LAST_VALUE は窓の末尾', () => {
        const got = q("SELECT id, LAST_VALUE(v) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const want = R.map((_, i) => { const w = win(R, i, 0, 2); return w[w.length - 1].v; });
        return eq(got, want, 'LAST_VALUE');
      });

      // COUNT(*) は NULL も数える（COUNT(v) との違いを固定する）
      t('A COUNT(*) は NULL も数える', () => {
        const got = q("SELECT id, COUNT(*) OVER (ORDER BY id) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        return eq(got, R.map((_, i) => i + 1), 'COUNT(*) の累計');
      });

      // 空フレーム: SUM は NULL / COUNT は 0
      t('A 空フレームは SUM=NULL / COUNT=0', () => {
        const d = q("SELECT id, SUM(v) OVER (ORDER BY id ROWS BETWEEN 5 PRECEDING AND 3 PRECEDING) AS s,"
                  + " COUNT(v) OVER (ORDER BY id ROWS BETWEEN 5 PRECEDING AND 3 PRECEDING) AS c"
                  + " FROM v69_w ORDER BY id LIMIT 2").data;
        return eq(d[0].s, null, '1 行目の SUM') && eq(d[0].c, 0, '1 行目の COUNT');
      });

      // 十進の和がフレーム集計でも崩れない（累積和を桁ずらし整数で積んでいる）
      t('A フレームの SUM も十進で合う', () => {
        drop('v69_d');
        q("CREATE TABLE v69_d (id INT PRIMARY KEY, p DECIMAL(10,2))");
        insertRows('v69_d', [[1, 0.10], [2, 0.20], [3, 0.30]]);
        const d = q("SELECT id, SUM(p) OVER (ORDER BY id) AS r FROM v69_d ORDER BY id").data.map(x => x.r);
        q("DROP TABLE v69_d");
        return eq(d, [0.1, 0.3, 0.6], '累計が十進で一致');
      });

      // PARTITION BY / RANGE / GROUPS / EXCLUDE も従来どおり
      t('A PARTITION ごとに独立して累計する', () => {
        const got = q("SELECT id, SUM(v) OVER (PARTITION BY g ORDER BY id) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const want = R.map((row, i) => {
          const prior = R.slice(0, i + 1).filter(x => x.g === row.g);
          return refAgg(prior, 'SUM', 'v');
        });
        return eq(got, want, 'パーティション別の累計');
      });

      t('A RANGE の既定は同値ピアをまとめる', () => {
        // 同じ v の行は同じ累計値になる
        const d = q("SELECT v, SUM(v) OVER (ORDER BY v) AS r FROM v69_w WHERE v IS NOT NULL ORDER BY v, id").data;
        for (let i = 1; i < d.length; i++) {
          if (d[i].v === d[i - 1].v && d[i].r !== d[i - 1].r) {
            throw new Error(`同値 v=${d[i].v} で累計が違う: ${d[i - 1].r} vs ${d[i].r}`);
          }
        }
        return true;
      });

      t('A EXCLUDE CURRENT ROW は従来経路で自分を外す', () => {
        const withCur = q("SELECT id, SUM(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        const without = q("SELECT id, SUM(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) AS r FROM v69_w ORDER BY id").data.map(x => x.r);
        // 現在行の v を引いた値になっていること（v が NULL の行は変わらない）
        for (let i = 0; i < R.length; i++) {
          const v = R[i].v;
          if (v === null) { if (withCur[i] !== without[i]) throw new Error(`row ${i + 1}: NULL 行で差が出た`); continue; }
          const a = withCur[i], b = without[i];
          if (b === null) { if (a !== v) throw new Error(`row ${i + 1}: 自分だけの窓で NULL にならない`); continue; }
          if (Math.abs((a - v) - b) > 1e-9) throw new Error(`row ${i + 1}: expected ${a - v} got ${b}`);
        }
        return true;
      });

      t('A GROUPS フレームも従来どおり', () => {
        const d = q("SELECT id, SUM(v) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS r FROM v69_w ORDER BY id");
        return eq(!!d.data && d.data.length === 60, true, 'GROUPS が動く');
      });

      // ============================================================
      // B. LIMIT の打ち切り
      //    打ち切れる形と打ち切れない形で、答えが変わらないこと
      // ============================================================
      t('B fixture', () => {
        drop('v69_big');
        q("CREATE TABLE v69_big (id INT PRIMARY KEY, g INT, s TEXT)");
        q("INSERT INTO v69_big SELECT n, n % 7, 'x' || (n % 11) FROM GENERATE_SERIES(1, 500) AS x(n)");
        return db.tables['v69_big'].rowCount === 500;
      });

      t('B LIMIT は物理順の先頭を返す', () =>
        eq(q("SELECT id FROM v69_big LIMIT 5").data.map(r => r.id), [1, 2, 3, 4, 5], '先頭 5 件'));

      t('B LIMIT + OFFSET', () =>
        eq(q("SELECT id FROM v69_big LIMIT 3 OFFSET 10").data.map(r => r.id), [11, 12, 13], '11 件目から 3 件'));

      t('B WHERE と併用しても絞った後の先頭', () =>
        eq(q("SELECT id FROM v69_big WHERE g = 3 LIMIT 4").data.map(r => r.id), [3, 10, 17, 24], 'g=3 の先頭 4 件'));

      t('B LIMIT が全件を超えたら全件', () =>
        eq(q("SELECT COUNT(*) AS c FROM (SELECT id FROM v69_big LIMIT 9999) x").data[0].c, 500, '全件'));

      t('B LIMIT 0 は 0 件', () =>
        eq(q("SELECT id FROM v69_big LIMIT 0").data.length, 0, '0 件'));

      t('B OFFSET が全件超なら 0 件', () =>
        eq(q("SELECT id FROM v69_big LIMIT 5 OFFSET 9999").data.length, 0, '0 件'));

      // 打ち切ってはいけない形（後段で行が減る・並びが変わる）
      same('B ORDER BY があるときは並べ替えが先',
        'SELECT id FROM (SELECT id FROM v69_big ORDER BY g, id) x LIMIT 5',
        'SELECT id FROM v69_big ORDER BY g, id LIMIT 5');

      t('B DISTINCT は先に重複を落とす', () => {
        const d = q("SELECT DISTINCT s FROM v69_big LIMIT 5").data.map(r => r.s);
        return eq(d.length, 5, '5 件') && eq(new Set(d).size, 5, '重複なし');
      });

      t('B GROUP BY はグループを数え切ってから', () => {
        const d = q("SELECT g, COUNT(*) AS c FROM v69_big GROUP BY g ORDER BY g LIMIT 3").data;
        // 500 行を n%7 で割ると g=0 は 71 行 / g=1,2 は 72 行（LIMIT で減らないこと）
        return eq(d.map(r => r.c), [71, 72, 72], 'グループの件数が全行ぶん');
      });

      t('B ウィンドウ関数は全行を見てから', () => {
        const d = q("SELECT id, COUNT(*) OVER () AS n FROM v69_big LIMIT 3").data;
        return eq(d.map(r => r.n), [500, 500, 500], '窓は全体を数える');
      });

      t('B 集計は全行を見てから', () =>
        eq(q("SELECT COUNT(*) AS c FROM v69_big LIMIT 1").data[0].c, 500, '集計は打ち切らない'));

      // ============================================================
      // C. 文字列プールの自動回収
      // ============================================================
      t('C 繰り返し UPDATE してもプールが膨らみ続けない', () => {
        drop('v69_p');
        q("CREATE TABLE v69_p (id INT PRIMARY KEY, s TEXT)");
        q("INSERT INTO v69_p SELECT n, 'a' || n FROM GENERATE_SERIES(1, 2000) AS x(n)");
        const tb = db.tables['v69_p'];
        for (let r = 1; r <= 10; r++) q(`UPDATE v69_p SET s = 'r${r}_' || id`);
        const ratio = tb.strPools['s'].length / tb.rowCount;
        if (ratio > 5) throw new Error(`プールが膨らんだまま: ${tb.strPools['s'].length} / ${tb.rowCount} = ${ratio.toFixed(1)}x`);
        return true;
      });

      t('C 回収しても値は壊れない', () => {
        const d = q("SELECT s FROM v69_p WHERE id IN (1, 1000, 2000) ORDER BY id").data.map(r => r.s);
        return eq(d, ['r10_1', 'r10_1000', 'r10_2000'], '最後に書いた値');
      });

      t('C 相異なり数が保たれる', () =>
        eq(q("SELECT COUNT(DISTINCT s) AS c FROM v69_p").data[0].c, 2000, '2000 通り'));

      // トランザクション中は回収しない（巻き戻しがプールの長さを控えているため）
      t('C トランザクション中は回収せず、ROLLBACK が正しく戻る', () => {
        const before = valsOf("SELECT s FROM v69_p WHERE id IN (1, 2000) ORDER BY id");
        q("BEGIN");
        for (let r = 1; r <= 8; r++) q(`UPDATE v69_p SET s = 'txn${r}_' || id`);
        q("ROLLBACK");
        const after = valsOf("SELECT s FROM v69_p WHERE id IN (1, 2000) ORDER BY id");
        return eq(after, before, 'ROLLBACK で元の値へ戻る');
      });

      t('C COMMIT した値は残る', () => {
        q("BEGIN");
        q("UPDATE v69_p SET s = 'kept_' || id WHERE id = 5");
        q("COMMIT");
        return eq(q("SELECT s FROM v69_p WHERE id = 5").data[0].s, 'kept_5', 'COMMIT 後の値');
      });

      // ============================================================
      // D. IN (副問い合わせ) の重複除去
      //    重複を落としても答えは変わらない。NULL の有無で三値論理も保たれる
      // ============================================================
      t('D fixture', () => {
        drop('v69_probe');
        q("CREATE TABLE v69_probe (id INT PRIMARY KEY, k INT)");
        insertRows('v69_probe', [[1, 3], [2, 999], [3, null]]);
        return db.tables['v69_probe'].rowCount === 3;
      });

      t('D 重複だらけの副問い合わせでも一致する', () => {
        // v69_big.g は 0..6 が 70 回以上ずつ出る
        const d = q("SELECT id FROM v69_probe WHERE k IN (SELECT g FROM v69_big) ORDER BY id").data.map(r => r.id);
        return eq(d, [1], 'k=3 だけが一致');
      });

      t('D NULL を含む副問い合わせは三値論理', () => {
        drop('v69_n');
        q("CREATE TABLE v69_n (v INT)");
        q("INSERT INTO v69_n SELECT CASE WHEN n = 7 THEN NULL ELSE n END FROM GENERATE_SERIES(1, 40) AS x(n)");
        const inR = q("SELECT id, k IN (SELECT v FROM v69_n) AS r FROM v69_probe ORDER BY id").data.map(x => x.r);
        const notR = q("SELECT id, k NOT IN (SELECT v FROM v69_n) AS r FROM v69_probe ORDER BY id").data.map(x => x.r);
        q("DROP TABLE v69_n");
        return eq(inR, [true, null, null], 'IN') && eq(notR, [false, null, null], 'NOT IN');
      });

      t('D 行コンストラクタの IN も一致する', () => {
        const d = q("SELECT COUNT(*) AS c FROM v69_big a WHERE (a.g, a.s) IN (SELECT b.g, b.s FROM v69_big b WHERE b.id < 20)").data[0].c;
        const ref = q("SELECT COUNT(*) AS c FROM v69_big a WHERE EXISTS (SELECT 1 FROM v69_big b WHERE b.id < 20 AND b.g = a.g AND b.s = a.s)").data[0].c;
        return eq(d, ref, '行コンストラクタ IN と EXISTS が一致');
      });

      t('D 短いリテラルの IN は従来どおり', () =>
        eq(q("SELECT id FROM v69_probe WHERE k IN (3, 4, 5) ORDER BY id").data.map(r => r.id), [1], '短いリスト'));

      t('D 32 件を超えるリテラルの IN も正しい', () => {
        const list = Array.from({ length: 60 }, (_, i) => i + 1).join(', ');
        const d = q(`SELECT id FROM v69_probe WHERE k IN (${list}) ORDER BY id`).data.map(r => r.id);
        return eq(d, [1], '長いリテラルリスト');
      });

      t('D NOT IN の長いリテラルリスト', () => {
        const list = Array.from({ length: 60 }, (_, i) => i + 1).join(', ');
        const d = q(`SELECT id FROM v69_probe WHERE k NOT IN (${list}) ORDER BY id`).data.map(r => r.id);
        return eq(d, [2], 'k=999 だけが外れる（NULL は不明）');
      });

      cleanup('v69_w', 'v69_big', 'v69_p', 'v69_probe');
      return T;
    }
