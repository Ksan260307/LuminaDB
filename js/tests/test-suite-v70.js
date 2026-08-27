    // ============================================================================
    // [Test Suite v70] - 範囲検索を索引で引く / MIN・MAX を 1 度のなめで求める
    //
    //   索引はハッシュ（Map）だけだったので、等価一致しか引けなかった。`col > 100` や
    //   `BETWEEN` は索引があっても全表走査に落ちていた。キーを並べた配列を持たせて
    //   両端を二分探索するようにした（20 万行で 21.4ms → 2.4ms）。
    //
    //   ここで見張るのは「索引経路と全表走査が同じ答えを返すこと」。括弧で包んだ
    //   WHERE は索引判定の正規表現に当たらないので、全表走査の基準として使う。
    //   境界の含む / 含まない、NULL、型混在、データ変更後の作り直しが崩れやすい。
    //
    //     A. 範囲の索引経路と全表走査が一致する
    //     B. 境界（>, >=, <, <=, BETWEEN）と空区間
    //     C. 索引に載せない範囲（型混在・照合順序・広すぎる区間）
    //     D. データを変えたら並べたキーも作り直される
    //     E. MIN / MAX が 1 度のなめで正しい値を返す
    //
    //   test-suite.js の tests 配列へ getV70Tests() のスプレッドで合流する
    // ============================================================================
    function getV70Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V70');

      // ------------------------------------------------------------
      // 0. フィクスチャ（400 行。NULL・負値・0・重複キーを混ぜる）
      // ------------------------------------------------------------
      const ROWS = [];
      for (let i = 1; i <= 400; i++) {
        ROWS.push([
          i,
          (i % 13 === 0) ? null : i - 200,     // n: 負～正、NULL 混じり
          'k' + String(i % 97).padStart(3, '0'),
          (i % 7)                              // g: 重複の多いキー
        ]);
      }
      t('V70 fixture', () => {
        drop('v70_t', 'v70_mix', 'v70_c');
        q("CREATE TABLE v70_t (id INT PRIMARY KEY, n INT, s TEXT, g INT)");
        insertRows('v70_t', ROWS);
        q("CREATE INDEX v70_ix_n ON v70_t(n)");
        q("CREATE INDEX v70_ix_s ON v70_t(s)");
        q("CREATE INDEX v70_ix_g ON v70_t(g)");
        return db.tables['v70_t'].rowCount === 400;
      });

      // ============================================================
      // A / B. 索引経路と全表走査の一致（境界も含めて総当たり）
      // ============================================================
      const RANGES = [
        'id > 380', 'id >= 380', 'id < 20', 'id <= 20',
        'id BETWEEN 100 AND 110', 'id BETWEEN 110 AND 100',
        'id > 100 AND id < 120', 'id >= 100 AND id <= 120',
        'id > 100 AND id <= 120', 'id >= 100 AND id < 120',
        'id > 399', 'id >= 400', 'id > 400', 'id < 1', 'id <= 0',
        'n > 190', 'n >= 190', 'n < -190', 'n <= -190',
        'n BETWEEN -5 AND 5', 'n > 0 AND n < 10',
        "s > 'k090'", "s >= 'k090'", "s < 'k005'", "s <= 'k005'",
        "s BETWEEN 'k010' AND 'k012'",
        'g > 5', 'g >= 5', 'g < 1',
        'id > 380 AND g = 3', 'id BETWEEN 100 AND 200 AND n IS NOT NULL',
        'id > 100 AND id < 120 AND s IS NOT NULL'
      ];
      RANGES.forEach(w => {
        // 括弧で包むと索引判定に当たらないので全表走査になる
        const scan = '(' + w.replace(/ AND /g, ') AND (') + ')';
        same(`A/B WHERE ${w}`,
          `SELECT id, n, s FROM v70_t WHERE ${scan} ORDER BY id`,
          `SELECT id, n, s FROM v70_t WHERE ${w} ORDER BY id`);
      });

      t('B 空区間は 0 件', () =>
        eq(q("SELECT COUNT(*) AS c FROM v70_t WHERE id BETWEEN 110 AND 100").data[0].c, 0, '逆順の BETWEEN'));

      t('B 範囲に NULL は入らない', () => {
        // n が NULL の行（i % 13 === 0）は、どの範囲比較にも一致しない
        const c = q("SELECT COUNT(*) AS c FROM v70_t WHERE n > -100000").data[0].c;
        const notNull = q("SELECT COUNT(*) AS c FROM v70_t WHERE n IS NOT NULL").data[0].c;
        return eq(c, notNull, 'NULL は範囲比較に参加しない');
      });

      t('B 集計・並べ替えと併用しても一致', () => {
        const a = valsOf("SELECT g, COUNT(*) AS c, MIN(id) AS lo FROM v70_t WHERE id > 300 GROUP BY g ORDER BY g");
        const b = valsOf("SELECT g, COUNT(*) AS c, MIN(id) AS lo FROM v70_t WHERE (id > 300) GROUP BY g ORDER BY g");
        return eq(a, b, '索引経路と全表走査');
      });

      t('B 結合の駆動表でも一致', () => {
        const a = valsOf("SELECT a.id, b.id FROM v70_t a JOIN v70_t b ON a.g = b.g WHERE a.id > 395 ORDER BY a.id, b.id");
        const b = valsOf("SELECT a.id, b.id FROM v70_t a JOIN v70_t b ON a.g = b.g WHERE (a.id > 395) ORDER BY a.id, b.id");
        return eq(a, b, '結合の左側');
      });

      // ============================================================
      // C. 索引に載せない範囲
      // ============================================================
      const planOf = (sql) => q(sql).data.map(r => r.Operation);

      t('C 選択率の高い範囲は索引を使う', () =>
        eq(planOf("EXPLAIN SELECT * FROM v70_t WHERE id > 395").includes('INDEX SCAN'), true, '計画'));

      t('C 広すぎる範囲は全表走査へ落とす', () =>
        eq(planOf("EXPLAIN SELECT * FROM v70_t WHERE id > 10").includes('TABLE SCAN'), true,
           '表のほとんどを拾う範囲は索引の方が高い'));

      t('C 索引の無い列の範囲は全表走査', () => {
        drop('v70_noidx');
        q("CREATE TABLE v70_noidx (id INT PRIMARY KEY, v INT)");
        insertRows('v70_noidx', [[1, 10], [2, 20], [3, 30]]);
        const ok = planOf("EXPLAIN SELECT * FROM v70_noidx WHERE v > 15").includes('TABLE SCAN');
        q("DROP TABLE v70_noidx");
        return eq(ok, true, '計画');
      });

      t('C 右辺が式なら索引に載せない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v70_t WHERE id > 300 + 90").includes('TABLE SCAN'), true, '計画'));

      // 型が混ざった列は、生値を並べた順序が比較側の型寄せと食い違うので使わない
      t('C fixture（型混在）', () => {
        drop('v70_mix');
        q("CREATE TABLE v70_mix (id INT PRIMARY KEY, v ANY)");
        insertRows('v70_mix', [[1, 5], [2, '7'], [3, 100], [4, 'abc'], [5, 20]]);
        q("CREATE INDEX v70_ix_mix ON v70_mix(v)");
        return db.tables['v70_mix'].rowCount === 5;
      });

      t('C 型混在の列は範囲を索引で引かない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v70_mix WHERE v > 6").includes('TABLE SCAN'), true,
           '数値と文字列が混じる列'));

      same('C 型混在でも答えは全表走査と同じ',
        'SELECT id FROM v70_mix WHERE (v > 6) ORDER BY id',
        'SELECT id FROM v70_mix WHERE v > 6 ORDER BY id');

      // 照合順序付きの列は索引が生値で作られているので使わない
      t('C fixture（照合順序）', () => {
        drop('v70_c');
        q("CREATE TABLE v70_c (id INT PRIMARY KEY, nm TEXT COLLATE NOCASE)");
        insertRows('v70_c', [[1, 'Alpha'], [2, 'beta'], [3, 'GAMMA'], [4, 'delta']]);
        q("CREATE INDEX v70_ix_c ON v70_c(nm)");
        return db.tables['v70_c'].rowCount === 4;
      });

      t('C COLLATE 付きの列は範囲を索引で引かない', () =>
        eq(planOf("EXPLAIN SELECT * FROM v70_c WHERE nm > 'b'").includes('TABLE SCAN'), true, '計画'));

      same('C COLLATE 付きでも答えは照合順序どおり',
        "SELECT id FROM v70_c WHERE (nm > 'b') ORDER BY id",
        "SELECT id FROM v70_c WHERE nm > 'b' ORDER BY id");

      // ============================================================
      // D. データを変えたら並べたキーも作り直す
      //    （並べた配列は表の変更世代で無効化される）
      // ============================================================
      t('D INSERT した行が範囲に現れる', () => {
        q("INSERT INTO v70_t VALUES (401, 999, 'zzz', 3)");
        const d = q("SELECT id FROM v70_t WHERE id > 399 ORDER BY id").data.map(r => r.id);
        return eq(d, [400, 401], '新しい行が見える');
      });

      t('D UPDATE した値が範囲に反映される', () => {
        q("UPDATE v70_t SET id = 500 WHERE id = 401");
        const d = q("SELECT id FROM v70_t WHERE id > 450 ORDER BY id").data.map(r => r.id);
        return eq(d, [500], '更新後の値で引ける');
      });

      t('D DELETE した行が範囲から消える', () => {
        q("DELETE FROM v70_t WHERE id = 500");
        const d = q("SELECT id FROM v70_t WHERE id > 399 ORDER BY id").data.map(r => r.id);
        return eq(d, [400], '削除後');
      });

      t('D 索引を張り直しても一致する', () => {
        q("DROP INDEX v70_ix_n");
        const without = valsOf("SELECT id FROM v70_t WHERE n > 150 ORDER BY id");
        q("CREATE INDEX v70_ix_n ON v70_t(n)");
        const withIdx = valsOf("SELECT id FROM v70_t WHERE n > 150 ORDER BY id");
        return eq(withIdx, without, '索引の有無で答えが変わらない');
      });

      t('D トランザクションを巻き戻したら範囲も戻る', () => {
        const before = valsOf("SELECT id FROM v70_t WHERE id > 395 ORDER BY id");
        q("BEGIN");
        q("INSERT INTO v70_t VALUES (600, 1, 'a', 1)");
        const during = valsOf("SELECT id FROM v70_t WHERE id > 395 ORDER BY id");
        q("ROLLBACK");
        const after = valsOf("SELECT id FROM v70_t WHERE id > 395 ORDER BY id");
        if (during === before) throw new Error('トランザクション中の追加が見えていない');
        return eq(after, before, 'ROLLBACK 後');
      });

      // ============================================================
      // E. MIN / MAX
      //    全件を並べ替えて端を取るのをやめ、1 度のなめで求める
      // ============================================================
      t('E MAX / MIN（数値）', () => {
        const d = q("SELECT MIN(id) AS lo, MAX(id) AS hi FROM v70_t").data[0];
        return eq(d.lo, 1, 'MIN') && eq(d.hi, 400, 'MAX');
      });

      t('E MAX / MIN（文字列は文字列として比べる）', () => {
        const d = q("SELECT MIN(s) AS lo, MAX(s) AS hi FROM v70_t").data[0];
        return eq(d.lo, 'k000', 'MIN(s)') && eq(d.hi, 'k096', 'MAX(s)');
      });

      t('E NULL は無視する', () => {
        const d = q("SELECT MIN(n) AS lo, MAX(n) AS hi FROM v70_t").data[0];
        const ref = q("SELECT MIN(n) AS lo, MAX(n) AS hi FROM v70_t WHERE n IS NOT NULL").data[0];
        return eq(d.lo, ref.lo, 'MIN(n)') && eq(d.hi, ref.hi, 'MAX(n)');
      });

      t('E 1 行も無ければ NULL', () => {
        const d = q("SELECT MIN(id) AS lo, MAX(id) AS hi FROM v70_t WHERE id < 0").data[0];
        return eq(d.lo, null, 'MIN') && eq(d.hi, null, 'MAX');
      });

      t('E 全部 NULL の列は NULL', () => {
        drop('v70_n');
        q("CREATE TABLE v70_n (id INT PRIMARY KEY, v INT)");
        insertRows('v70_n', [[1, null], [2, null]]);
        const d = q("SELECT MIN(v) AS lo, MAX(v) AS hi FROM v70_n").data[0];
        q("DROP TABLE v70_n");
        return eq(d.lo, null, 'MIN') && eq(d.hi, null, 'MAX');
      });

      t('E GROUP BY ごとの MIN / MAX', () => {
        const d = q("SELECT g, MIN(id) AS lo, MAX(id) AS hi FROM v70_t GROUP BY g ORDER BY g").data;
        // 各グループを JS 側で組んだ期待値と突き合わせる
        const live = ROWS.filter(r => r[0] <= 400);
        const byG = new Map();
        live.forEach(r => {
          const g = r[3];
          if (!byG.has(g)) byG.set(g, { lo: r[0], hi: r[0] });
          else { const o = byG.get(g); if (r[0] < o.lo) o.lo = r[0]; if (r[0] > o.hi) o.hi = r[0]; }
        });
        const want = [...byG.keys()].sort((a, b) => a - b).map(g => ({ g, lo: byG.get(g).lo, hi: byG.get(g).hi }));
        return eq(d, want, 'グループごとの端');
      });

      t('E MIN / MAX と範囲の索引経路を併用', () => {
        const a = q("SELECT MIN(id) AS lo, MAX(id) AS hi FROM v70_t WHERE id > 380").data[0];
        const b = q("SELECT MIN(id) AS lo, MAX(id) AS hi FROM v70_t WHERE (id > 380)").data[0];
        return eq(a, b, '索引経路と全表走査');
      });

      t('E 混在型の MAX は従来どおりの比較', () => {
        const a = valsOf("SELECT MAX(v) AS hi FROM v70_mix");
        const b = valsOf("SELECT MAX(v) AS hi FROM (SELECT v FROM v70_mix) x");
        return eq(a, b, '同じ比較規則');
      });

      // ============================================================
      // F. EXPLAIN の見積り
      //    索引がある列は推測せず、相異なりキー数と並べたキーの位置から出す。
      //    「見積りが実際とどれだけ違うか」を固定しておくと、推測へ戻ったら気づける
      // ============================================================
      const estOf = (sql) => {
        const plan = q('EXPLAIN ' + sql).data;
        const f = plan.filter(r => /FILTER/.test(r.Operation)).pop();
        return f ? f.Rows : plan[plan.length - 1].Rows;
      };
      const actualOf = (sql) => q(sql.replace('SELECT *', 'SELECT COUNT(*) AS c')).data[0].c;

      [
        'SELECT * FROM v70_t WHERE id > 395',
        'SELECT * FROM v70_t WHERE id < 10',
        'SELECT * FROM v70_t WHERE id BETWEEN 100 AND 110',
        'SELECT * FROM v70_t WHERE g = 3',
        'SELECT * FROM v70_t WHERE id > 100',
        'SELECT * FROM v70_t WHERE id > 390 AND g = 3'
      ].forEach(sql => {
        t(`F 見積りが実際と桁で外れない: ${sql.replace('SELECT * FROM v70_t ', '')}`, () => {
          const est = estOf(sql), act = actualOf(sql);
          // 索引の統計から出しているので、ここは 2 倍以内に収まるべき
          const lo = Math.max(1, act / 2), hi = Math.max(2, act * 2 + 1);
          if (est < lo || est > hi) {
            throw new Error(`見積り ${est} が実際 ${act} から離れすぎ（許容 ${Math.round(lo)}〜${Math.round(hi)}）`);
          }
          return true;
        });
      });

      cleanup('v70_t', 'v70_mix', 'v70_c');
      return T;
    }
