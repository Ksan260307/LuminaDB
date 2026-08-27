    // ============================================================================
    // [Test Suite v67] - ORDER BY ... LIMIT を全件並べ替えずに解く
    //
    //   従来は必ず全件を sort してから slice していたので、20 万行から 10 行取る
    //   `ORDER BY amt DESC, id LIMIT 10` が 20 万件ぶんの比較を払っていた
    //   （並べ替えだけで約 60ms → 約 5ms）。
    //
    //   この層が見張るのは「上位 k 件の選び方が、安定ソートして先頭 k 件を取ったものと
    //   完全に一致すること」。同値が多いときの並び（安定性）と、NULL の位置、
    //   OFFSET の足し込み、閾値の境目が崩れやすい。
    //
    //     A. 全件並べ替え + JS 側で切った参照と総当たりで一致する
    //     B. 上位 k 件を使わない条件（TOP n PERCENT / WITH TIES / DISTINCT ON）
    //     C. 閾値の境目（切り替わる大きさの前後で答えが変わらない）
    //     D. 句の組み合わせ（GROUP BY / DISTINCT / 結合 / 派生表 / 集合演算）
    //
    //   test-suite.js の tests 配列へ getV67Tests() のスプレッドで合流する
    // ============================================================================
    function getV67Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V67');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      //    900 行。amt は 13 通り・s は 17 通りしかないので同値が大量に出る
      //    （安定性が崩れていればここで露見する）。NULL とゼロも混ぜる
      // ------------------------------------------------------------
      const ROWS = [];
      for (let i = 1; i <= 900; i++) {
        ROWS.push([i, i % 37, i % 13, (i % 11 === 0) ? null : 's' + (i % 17), (i % 5 === 0) ? 0 : i]);
      }
      t('V67 fixture', () => {
        drop('v67_a', 'v67_s');
        q("CREATE TABLE v67_a (id INT PRIMARY KEY, k INT, amt INT, s TEXT, n INT)");
        insertRows('v67_a', ROWS);
        q("CREATE TABLE v67_s (id INT PRIMARY KEY, v INT)");
        insertRows('v67_s', [[1, 30], [2, 10], [3, 30], [4, 20], [5, 10]]);
        return db.tables['v67_a'].rowCount === 900;
      });

      // ============================================================
      // A. 参照との総当たり
      //    「全件を並べ替えた結果を JS 側で slice したもの」が唯一の正解
      // ============================================================
      const ORDERS = [
        'amt DESC, id', 'amt, id', 's, id', 's DESC, id', 'k, amt DESC, id',
        'n DESC, id', 'amt DESC', 's NULLS FIRST, id', 's DESC NULLS LAST, id',
        'k DESC, s, id', 'amt DESC, k, id'
      ];
      // 閾値（64 と k*4）の内側・外側・境目をまたぐ大きさを混ぜる
      const KS = [1, 2, 3, 7, 10, 50, 224, 225, 226, 899, 900, 901];
      const OFFS = [0, 1, 5, 100, 890, 900];

      // 全件並べ替えの結果は ORDER BY ごとに 1 回だけ引いて使い回す
      const fullCache = Object.create(null);
      const fullIds = (ord) => {
        if (!(ord in fullCache)) {
          fullCache[ord] = q(`SELECT id FROM v67_a ORDER BY ${ord}`).data.map(r => r.id);
        }
        return fullCache[ord];
      };

      ORDERS.forEach(ord => {
        KS.forEach(k => {
          t(`A ORDER BY ${ord} LIMIT ${k}`, () => {
            const want = fullIds(ord).slice(0, k);
            const got = q(`SELECT id FROM v67_a ORDER BY ${ord} LIMIT ${k}`).data.map(r => r.id);
            return eq(got, want, `上位 ${k} 件`);
          });
        });
      });

      // OFFSET は「先頭から off + limit 件を選んでから前を捨てる」形になる
      ORDERS.slice(0, 5).forEach(ord => {
        OFFS.forEach(off => {
          [1, 10, 50].forEach(k => {
            t(`A ORDER BY ${ord} LIMIT ${k} OFFSET ${off}`, () => {
              const want = fullIds(ord).slice(off, off + k);
              const got = q(`SELECT id FROM v67_a ORDER BY ${ord} LIMIT ${k} OFFSET ${off}`).data.map(r => r.id);
              return eq(got, want, `${off} 件飛ばして ${k} 件`);
            });
          });
        });
      });

      // FETCH FIRST / TOP も同じ経路へ入る
      t('A FETCH FIRST n ROWS ONLY', () => {
        const want = fullIds('amt DESC, id').slice(0, 12);
        const got = q("SELECT id FROM v67_a ORDER BY amt DESC, id FETCH FIRST 12 ROWS ONLY").data.map(r => r.id);
        return eq(got, want, 'FETCH FIRST');
      });

      t('A TOP n', () => {
        const want = fullIds('amt DESC, id').slice(0, 12);
        const got = q("SELECT TOP 12 id FROM v67_a ORDER BY amt DESC, id").data.map(r => r.id);
        return eq(got, want, 'TOP');
      });

      // ============================================================
      // B. 上位 k 件では解けない形は、従来どおり全件を並べ替える
      // ============================================================
      t('B TOP n PERCENT は全体件数が要る', () => {
        const d = q("SELECT TOP 10 PERCENT id FROM v67_a ORDER BY amt DESC, id").data;
        return eq(d.length, 90, '900 行の 10%')
          && eq(d.map(r => r.id), fullIds('amt DESC, id').slice(0, 90), '中身');
      });

      t('B WITH TIES は打ち切り位置の同値を連れてくる', () => {
        // amt は 13 通りなので LIMIT 3 の境界に必ず同値が居る
        const plain = q("SELECT id FROM v67_a ORDER BY amt DESC LIMIT 3").data.length;
        const ties = q("SELECT id FROM v67_a ORDER BY amt DESC FETCH FIRST 3 ROWS WITH TIES").data.length;
        return eq(plain, 3, 'LIMIT 3') && (ties > 3 || (() => { throw new Error('WITH TIES が増えていない: ' + ties); })());
      });

      t('B WITH TIES の中身が全件並べ替えと一致する', () => {
        const all = q("SELECT id, amt FROM v67_a ORDER BY amt DESC").data;
        const ties = q("SELECT id, amt FROM v67_a ORDER BY amt DESC FETCH FIRST 3 ROWS WITH TIES").data;
        const boundary = all[2].amt;
        const want = all.filter(r => r.amt >= boundary).length;
        return eq(ties.length, want, '境界と同値の行を含めた件数');
      });

      t('B DISTINCT ON は並べ替えの後で行を落とす', () => {
        const d = q("SELECT DISTINCT ON (amt) id, amt FROM v67_a ORDER BY amt DESC, id LIMIT 5").data;
        // amt ごとに最初の 1 行 → amt が 5 通りぶん出る
        return eq(d.length, 5, '件数') && eq(new Set(d.map(r => r.amt)).size, 5, 'amt が重複しない');
      });

      same('B DISTINCT ON + LIMIT が全件経路と一致',
        'SELECT * FROM (SELECT DISTINCT ON (amt) id, amt FROM v67_a ORDER BY amt DESC, id) x LIMIT 5',
        'SELECT DISTINCT ON (amt) id, amt FROM v67_a ORDER BY amt DESC, id LIMIT 5');

      // ============================================================
      // C. 閾値の境目
      //    小さい結果では全件 sort を使う。切り替わっても答えは同じでなければならない
      // ============================================================
      t('C 小さい表（閾値の下）でも一致', () => {
        const want = q("SELECT id FROM v67_s ORDER BY v DESC, id").data.map(r => r.id).slice(0, 2);
        const got = q("SELECT id FROM v67_s ORDER BY v DESC, id LIMIT 2").data.map(r => r.id);
        return eq(got, want, '5 行の表から 2 件');
      });

      t('C LIMIT が全件数を超える', () => {
        const got = q("SELECT id FROM v67_a ORDER BY amt DESC, id LIMIT 5000").data.map(r => r.id);
        return eq(got, fullIds('amt DESC, id'), '全件が返る');
      });

      t('C LIMIT 0 は 0 件', () =>
        eq(q("SELECT id FROM v67_a ORDER BY amt DESC LIMIT 0").data.length, 0, '件数'));

      t('C OFFSET が全件数を超えたら 0 件', () =>
        eq(q("SELECT id FROM v67_a ORDER BY amt DESC LIMIT 10 OFFSET 5000").data.length, 0, '件数'));

      t('C LIMIT ALL は全件', () =>
        eq(q("SELECT id FROM v67_a ORDER BY amt DESC, id LIMIT ALL").data.map(r => r.id),
           fullIds('amt DESC, id'), '全件'));

      t('C ORDER BY 無しの LIMIT は並べ替えない', () => {
        const d = q("SELECT id FROM v67_a LIMIT 5").data.map(r => r.id);
        return eq(d, [1, 2, 3, 4, 5], '物理順の先頭 5 件');
      });

      // ============================================================
      // D. 句の組み合わせ
      // ============================================================
      t('D GROUP BY の後の上位 k 件', () => {
        const all = q("SELECT amt, COUNT(*) c FROM v67_a GROUP BY amt ORDER BY c DESC, amt").data;
        const got = q("SELECT amt, COUNT(*) c FROM v67_a GROUP BY amt ORDER BY c DESC, amt LIMIT 4").data;
        return eq(got, all.slice(0, 4), 'グループの上位');
      });

      t('D HAVING と併用', () => {
        const all = q("SELECT amt, COUNT(*) c FROM v67_a GROUP BY amt HAVING COUNT(*) > 60 ORDER BY amt DESC").data;
        const got = q("SELECT amt, COUNT(*) c FROM v67_a GROUP BY amt HAVING COUNT(*) > 60 ORDER BY amt DESC LIMIT 3").data;
        return eq(got, all.slice(0, 3), 'HAVING の後');
      });

      t('D DISTINCT と併用', () => {
        const all = q("SELECT DISTINCT amt FROM v67_a ORDER BY amt DESC").data;
        const got = q("SELECT DISTINCT amt FROM v67_a ORDER BY amt DESC LIMIT 4").data;
        return eq(got, all.slice(0, 4), 'DISTINCT の後');
      });

      t('D 結合の後', () => {
        const all = q("SELECT a.id FROM v67_a a JOIN v67_s s ON a.amt = s.v ORDER BY a.id").data;
        const got = q("SELECT a.id FROM v67_a a JOIN v67_s s ON a.amt = s.v ORDER BY a.id LIMIT 6").data;
        return eq(got, all.slice(0, 6), '結合の後');
      });

      t('D 派生表の中の LIMIT', () => {
        const want = fullIds('amt DESC, id').slice(0, 20);
        const got = q("SELECT id FROM (SELECT id FROM v67_a ORDER BY amt DESC, id LIMIT 20) x ORDER BY id").data.map(r => r.id);
        return eq(got.sort((a, b) => a - b), want.slice().sort((a, b) => a - b), '派生表の中身');
      });

      t('D 集合演算の後', () => {
        const all = q("SELECT id FROM v67_a WHERE id < 100 UNION SELECT id FROM v67_a WHERE id > 880 ORDER BY id").data;
        const got = q("SELECT id FROM v67_a WHERE id < 100 UNION SELECT id FROM v67_a WHERE id > 880 ORDER BY id LIMIT 7").data;
        return eq(got, all.slice(0, 7), 'UNION の後');
      });

      t('D ウィンドウ関数と併用', () => {
        const all = q("SELECT id, ROW_NUMBER() OVER (ORDER BY amt DESC, id) rn FROM v67_a ORDER BY rn").data;
        const got = q("SELECT id, ROW_NUMBER() OVER (ORDER BY amt DESC, id) rn FROM v67_a ORDER BY rn LIMIT 8").data;
        return eq(got, all.slice(0, 8), 'ウィンドウの後');
      });

      t('D ORDER BY に式を書く', () => {
        const all = q("SELECT id FROM v67_a ORDER BY amt * -1, id").data;
        const got = q("SELECT id FROM v67_a ORDER BY amt * -1, id LIMIT 9").data;
        return eq(got, all.slice(0, 9), '式で並べ替え');
      });

      t('D ORDER BY に序数を書く', () => {
        const all = q("SELECT id, amt FROM v67_a ORDER BY 2 DESC, 1").data;
        const got = q("SELECT id, amt FROM v67_a ORDER BY 2 DESC, 1 LIMIT 9").data;
        return eq(got, all.slice(0, 9), '序数で並べ替え');
      });

      t('D COLLATE 付きの並べ替え', () => {
        const all = q("SELECT id FROM v67_a WHERE s IS NOT NULL ORDER BY s COLLATE NOCASE, id").data;
        const got = q("SELECT id FROM v67_a WHERE s IS NOT NULL ORDER BY s COLLATE NOCASE, id LIMIT 11").data;
        return eq(got, all.slice(0, 11), '照合順序付き');
      });

      cleanup('v67_a', 'v67_s');
      return T;
    }
