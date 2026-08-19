    // ============================================================================
    // [Test Suite v34] - 大型クエリの網羅検証
    //
    //   これまでのスイートが「機能ひとつを最小の例で確かめる」のに対し、v34 は
    //   **実装済みのコマンドを組み合わせた大きなクエリ**を、まとまった行数のデータに
    //   対して流したときに正しい答えを返すかを見る。
    //
    //   期待値は SQL では作らない。フィクスチャと同じ規則で組み立てた JavaScript 側の
    //   模型（FACT / CUST / ...）を集計して求め、それと SQL の答えを突き合わせる。
    //   SQL 同士の比較だと同じ誤りが両辺に乗って気づけないため。
    //
    //   構成:
    //     A. フィクスチャと素性の確認        G. 巨大な式・リスト・列
    //     B. 多段 JOIN                        H. 大量行の DML
    //     C. 大規模な集計                     I. 並べ替え・ページング・重複除去
    //     D. ウィンドウ関数                   J. 表関数 / PIVOT / JSON / 配列
    //     E. CTE とサブクエリ                 K. 索引・EXPLAIN・結果の不変性
    //     F. 集合演算                         L. 総合シナリオ
    //
    //   行数の目安: v34_fact 5000 / v34_mid 1000 / v34_small 200 / v34_wide 300(81列)
    //   test-suite.js の tests 配列へ getV34Tests() のスプレッドで合流する
    // ============================================================================
    function getV34Tests() {
      const T = [];

      // ----------------------------------------------------------------
      // 共通ヘルパ
      // ----------------------------------------------------------------
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });

      // 実行してデータ行を返す。エラーはそのまま投げてテスト名と一緒に表示させる
      const rows = (sql) => {
        const r = q(sql);
        if (r.error) throw new Error(r.error);
        return r.data || [];
      };
      // 1 行 1 列を取り出す
      const one = (sql) => {
        const d = rows(sql);
        if (!d.length) throw new Error('no rows returned');
        return Object.values(d[0])[0];
      };
      const colOf = (sql, name) => rows(sql).map(r => r[name]);

      // 期待値との突き合わせ。ずれたら中身が判るメッセージで落とす
      const same = (a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
        return a === b;
      };
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
      // 値を 1 個だけ確かめるテストの短縮形
      const val = (name, sql, want) => t(name, () => expect(one(sql), want));
      const valNear = (name, sql, want, eps) => t(name, () => expectNear(one(sql), want, eps));

      // ----------------------------------------------------------------
      // フィクスチャの模型（SQL 側と同じ規則で JavaScript でも作る）
      // ----------------------------------------------------------------
      const TIERS = ['gold', 'silver', 'bronze'];
      const FACT = [];
      for (let n = 1; n <= 5000; n++) {
        const cents = 1000 + (n % 997) * 37;
        FACT.push({
          id: n,
          cust_id: 1 + (n % 200),
          prod_id: 1 + (n % 50),
          region: 'R' + (n % 8),
          qty: 1 + (n % 9),
          cents: cents,
          price: cents / 100,
          status: (n % 7 === 0) ? 'cancelled' : ((n % 3 === 0) ? 'pending' : 'paid'),
          dayoff: n % 730,
          nv: (n % 11 === 0) ? null : (n % 100)
        });
      }
      const CUST = [];
      for (let n = 1; n <= 200; n++) {
        CUST.push({ id: n, cname: 'C' + String(n).padStart(3, '0'), tier: TIERS[n % 3],
                    region: 'R' + (n % 8), credit: 100 * (1 + (n % 13)) });
      }
      const PROD = [];
      for (let n = 1; n <= 50; n++) {
        PROD.push({ id: n, pname: 'P' + String(n).padStart(2, '0'), cat: 'CAT' + (n % 5),
                    cost_cents: 250 * n, active: (n % 4 === 0) ? 0 : 1 });
      }
      const REG = [];
      for (let n = 0; n <= 7; n++) REG.push({ code: 'R' + n, label: 'Region ' + n, zone: n < 4 ? 'west' : 'east' });
      const MID = [];
      for (let n = 1; n <= 1000; n++) {
        MID.push({ id: n, grp: 'G' + (n % 10), sub: 'S' + (n % 4), val: n % 37,
                   nval: (n % 13 === 0) ? null : (n % 50), txt: 'm' + (n % 25) });
      }
      const SMALL = [];
      for (let n = 1; n <= 200; n++) SMALL.push({ id: n, a: n % 20, b: n % 7, s: 's' + (n % 5) });
      const WIDE = [];
      for (let n = 1; n <= 300; n++) {
        const w = { id: n };
        for (let i = 0; i < 80; i++) w['c' + i] = (n * (i + 1)) % 1000;
        WIDE.push(w);
      }

      // 模型を集計するための小道具
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const cnt = (arr, f) => arr.filter(f).length;
      const uniq = (arr, f) => new Set(arr.map(f)).size;
      const byKey = (arr, keyf) => {
        const m = new Map();
        for (const x of arr) {
          const k = keyf(x);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(x);
        }
        return m;
      };
      const CUST_BY_ID = new Map(CUST.map(c => [c.id, c]));
      const PROD_BY_ID = new Map(PROD.map(p => [p.id, p]));
      const REG_BY_CODE = new Map(REG.map(r => [r.code, r]));
      // fact に次元を貼り合わせた模型（多段 JOIN の期待値はこれを絞り込んで作る）
      const WIDEJOIN = FACT.map(f => ({
        f: f, c: CUST_BY_ID.get(f.cust_id), p: PROD_BY_ID.get(f.prod_id), r: REG_BY_CODE.get(f.region)
      }));

      // ============================================================
      // A. フィクスチャと素性の確認
      // ============================================================
      t('V34A build the 5000-row fact table', () => {
        ['v34_fact', 'v34_cust', 'v34_prod', 'v34_reg', 'v34_mid', 'v34_small', 'v34_wide']
          .forEach(n => q('DROP TABLE IF EXISTS ' + n));
        let r = q("CREATE TABLE v34_fact (id INT PRIMARY KEY, cust_id INT, prod_id INT, region TEXT, " +
                  "qty INT, cents INT, price FLOAT, status TEXT, ymd DATE, txt TEXT, nv INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_fact (id, cust_id, prod_id, region, qty, cents, price, status, ymd, txt, nv) " +
              "SELECT n, 1 + (n % 200), 1 + (n % 50), 'R' || (n % 8), 1 + (n % 9), " +
              "       1000 + (n % 997) * 37, (1000 + (n % 997) * 37) / 100.0, " +
              "       CASE WHEN n % 7 = 0 THEN 'cancelled' WHEN n % 3 = 0 THEN 'pending' ELSE 'paid' END, " +
              "       DATEADD(DAY, n % 730, DATE '2024-01-01'), 'ord-' || LPAD(n, 5, '0'), " +
              "       CASE WHEN n % 11 = 0 THEN NULL ELSE n % 100 END " +
              "FROM GENERATE_SERIES(1, 5000) AS g(n)");
        if (r.error) throw new Error(r.error);
        return expect(db.tables['v34_fact'].rowCount, 5000);
      });
      t('V34A build the dimension tables', () => {
        let r = q("CREATE TABLE v34_cust (id INT PRIMARY KEY, cname TEXT, tier TEXT, region TEXT, credit INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_cust (id, cname, tier, region, credit) " +
              "SELECT n, 'C' || LPAD(n, 3, '0'), CASE n % 3 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' ELSE 'bronze' END, " +
              "'R' || (n % 8), 100 * (1 + (n % 13)) FROM GENERATE_SERIES(1, 200) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v34_prod (id INT PRIMARY KEY, pname TEXT, cat TEXT, cost_cents INT, active INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_prod (id, pname, cat, cost_cents, active) " +
              "SELECT n, 'P' || LPAD(n, 2, '0'), 'CAT' || (n % 5), 250 * n, " +
              "CASE WHEN n % 4 = 0 THEN 0 ELSE 1 END FROM GENERATE_SERIES(1, 50) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v34_reg (code TEXT PRIMARY KEY, label TEXT, zone TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_reg (code, label, zone) SELECT 'R' || n, 'Region ' || n, " +
              "CASE WHEN n < 4 THEN 'west' ELSE 'east' END FROM GENERATE_SERIES(0, 7) AS g(n)");
        if (r.error) throw new Error(r.error);
        return db.tables['v34_cust'].rowCount === 200 && db.tables['v34_prod'].rowCount === 50 &&
               db.tables['v34_reg'].rowCount === 8;
      });
      t('V34A build the mid / small / wide tables', () => {
        let r = q("CREATE TABLE v34_mid (id INT PRIMARY KEY, grp TEXT, sub TEXT, val INT, nval INT, txt TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_mid (id, grp, sub, val, nval, txt) SELECT n, 'G' || (n % 10), 'S' || (n % 4), " +
              "n % 37, CASE WHEN n % 13 = 0 THEN NULL ELSE n % 50 END, 'm' || (n % 25) " +
              "FROM GENERATE_SERIES(1, 1000) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v34_small (id INT PRIMARY KEY, a INT, b INT, s TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_small (id, a, b, s) SELECT n, n % 20, n % 7, 's' || (n % 5) " +
              "FROM GENERATE_SERIES(1, 200) AS g(n)");
        if (r.error) throw new Error(r.error);
        const wcols = [], wvals = [];
        for (let i = 0; i < 80; i++) { wcols.push('c' + i + ' INT'); wvals.push('(n * ' + (i + 1) + ') % 1000'); }
        r = q("CREATE TABLE v34_wide (id INT PRIMARY KEY, " + wcols.join(', ') + ")");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v34_wide SELECT n, " + wvals.join(', ') + " FROM GENERATE_SERIES(1, 300) AS g(n)");
        if (r.error) throw new Error(r.error);
        return db.tables['v34_mid'].rowCount === 1000 && db.tables['v34_small'].rowCount === 200 &&
               db.tables['v34_wide'].rowCount === 300;
      });

      val('V34A fact row count', "SELECT COUNT(*) FROM v34_fact", 5000);
      val('V34A fact SUM(qty) matches the model', "SELECT SUM(qty) FROM v34_fact", sum(FACT, r => r.qty));
      val('V34A fact SUM(cents) matches the model', "SELECT SUM(cents) FROM v34_fact", sum(FACT, r => r.cents));
      val('V34A fact COUNT(nv) skips the NULLs', "SELECT COUNT(nv) FROM v34_fact", cnt(FACT, r => r.nv !== null));
      val('V34A fact NULL count on nv', "SELECT COUNT(*) FROM v34_fact WHERE nv IS NULL", cnt(FACT, r => r.nv === null));
      val('V34A fact distinct customers', "SELECT COUNT(DISTINCT cust_id) FROM v34_fact", uniq(FACT, r => r.cust_id));
      val('V34A fact distinct products', "SELECT COUNT(DISTINCT prod_id) FROM v34_fact", uniq(FACT, r => r.prod_id));
      val('V34A fact distinct regions', "SELECT COUNT(DISTINCT region) FROM v34_fact", uniq(FACT, r => r.region));
      val('V34A fact MIN(cents)', "SELECT MIN(cents) FROM v34_fact", Math.min.apply(null, FACT.map(r => r.cents)));
      val('V34A fact MAX(cents)', "SELECT MAX(cents) FROM v34_fact", Math.max.apply(null, FACT.map(r => r.cents)));
      val('V34A fact MIN(txt) is zero padded', "SELECT MIN(txt) FROM v34_fact", 'ord-00001');
      val('V34A fact MAX(txt) is zero padded', "SELECT MAX(txt) FROM v34_fact", 'ord-05000');
      valNear('V34A fact AVG(price) matches the model', "SELECT AVG(price) FROM v34_fact",
              sum(FACT, r => r.price) / FACT.length, 1e-9);
      val('V34A fact price is cents / 100 on every row', "SELECT COUNT(*) FROM v34_fact WHERE ROUND(price * 100) <> cents", 0);
      val('V34A fact date span start', "SELECT MIN(ymd) FROM v34_fact", '2024-01-01');
      val('V34A fact date span end', "SELECT MAX(ymd) FROM v34_fact", '2025-12-30');
      val('V34A cust row count', "SELECT COUNT(*) FROM v34_cust", 200);
      val('V34A cust SUM(credit)', "SELECT SUM(credit) FROM v34_cust", sum(CUST, r => r.credit));
      val('V34A prod row count', "SELECT COUNT(*) FROM v34_prod", 50);
      val('V34A prod SUM(cost_cents)', "SELECT SUM(cost_cents) FROM v34_prod", sum(PROD, r => r.cost_cents));
      val('V34A prod active count', "SELECT COUNT(*) FROM v34_prod WHERE active = 1", cnt(PROD, r => r.active === 1));
      val('V34A reg row count', "SELECT COUNT(*) FROM v34_reg", 8);
      val('V34A mid row count', "SELECT COUNT(*) FROM v34_mid", 1000);
      val('V34A mid SUM(val)', "SELECT SUM(val) FROM v34_mid", sum(MID, r => r.val));
      val('V34A mid COUNT(nval)', "SELECT COUNT(nval) FROM v34_mid", cnt(MID, r => r.nval !== null));
      val('V34A small row count', "SELECT COUNT(*) FROM v34_small", 200);
      val('V34A small SUM(a)', "SELECT SUM(a) FROM v34_small", sum(SMALL, r => r.a));
      val('V34A wide row count', "SELECT COUNT(*) FROM v34_wide", 300);
      val('V34A wide SUM(c0)', "SELECT SUM(c0) FROM v34_wide", sum(WIDE, r => r.c0));
      val('V34A wide SUM(c79)', "SELECT SUM(c79) FROM v34_wide", sum(WIDE, r => r.c79));
      t('V34A wide really has 81 columns', () => expect(Object.keys(rows("SELECT * FROM v34_wide LIMIT 1")[0]).length, 81));
      t('V34A the fact primary key rejects a duplicate', () => {
        const r = q("INSERT INTO v34_fact (id, qty) VALUES (1, 1)");
        return !!r.error && /PRIMARY KEY/i.test(r.error);
      });
      t('V34A every fact row points at a real customer', () =>
        expect(one("SELECT COUNT(*) FROM v34_fact f WHERE NOT EXISTS (SELECT 1 FROM v34_cust c WHERE c.id = f.cust_id)"), 0));
      t('V34A every fact row points at a real product', () =>
        expect(one("SELECT COUNT(*) FROM v34_fact f WHERE NOT EXISTS (SELECT 1 FROM v34_prod p WHERE p.id = f.prod_id)"), 0));
      t('V34A every fact row points at a real region', () =>
        expect(one("SELECT COUNT(*) FROM v34_fact f WHERE NOT EXISTS (SELECT 1 FROM v34_reg r WHERE r.code = f.region)"), 0));

      // 各列の分布そのものを模型と突き合わせる（後段の期待値の土台になる）
      ['region', 'status'].forEach(cname => {
        const want = [...byKey(FACT, r => r[cname]).entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
                       .map(e => ({ k: e[0], n: e[1].length }));
        t('V34A the ' + cname + ' distribution matches the model', () =>
          expectDeep(rows("SELECT " + cname + " AS k, COUNT(*) AS n FROM v34_fact GROUP BY " + cname + " ORDER BY k"), want));
      });
      t('V34A the qty distribution matches the model', () => {
        const want = [...byKey(FACT, r => r.qty).entries()].sort((a, b) => a[0] - b[0]).map(e => ({ k: e[0], n: e[1].length }));
        return expectDeep(rows("SELECT qty AS k, COUNT(*) AS n FROM v34_fact GROUP BY qty ORDER BY k"), want);
      });
      t('V34A the tier distribution matches the model', () => {
        const want = [...byKey(CUST, r => r.tier).entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(e => ({ k: e[0], n: e[1].length }));
        return expectDeep(rows("SELECT tier AS k, COUNT(*) AS n FROM v34_cust GROUP BY tier ORDER BY k"), want);
      });

      // ============================================================
      // B. 多段 JOIN
      //    4 表を貼り合わせた大きな結合に、様々な絞り込み・結合種別・
      //    結合順序・相関を与えて、模型と同じ答えになるかを見る
      // ============================================================

      // 模型側で総当たり結合するための小道具
      const njoin = (L, R, pred) => { let n = 0; for (const l of L) for (const r of R) if (pred(l, r)) n++; return n; };
      const sjoin = (L, R, pred, f) => { let s = 0; for (const l of L) for (const r of R) if (pred(l, r)) s += f(l, r); return s; };
      const nleft = (L, R, pred) => { let n = 0; for (const l of L) { let m = 0; for (const r of R) if (pred(l, r)) m++; n += (m || 1); } return n; };

      // ---- B1. fact x cust x prod x reg の 4 表結合を 24 通りに絞り込む ----
      const FOUR_WAY = "FROM v34_fact f " +
        "JOIN v34_cust c ON f.cust_id = c.id " +
        "JOIN v34_prod p ON f.prod_id = p.id " +
        "JOIN v34_reg  g ON f.region  = g.code ";
      const B1_PREDS = [
        ["c.tier = 'gold'", x => x.c.tier === 'gold'],
        ["c.tier = 'silver'", x => x.c.tier === 'silver'],
        ["c.tier = 'bronze'", x => x.c.tier === 'bronze'],
        ["p.cat = 'CAT0'", x => x.p.cat === 'CAT0'],
        ["p.cat = 'CAT1'", x => x.p.cat === 'CAT1'],
        ["p.cat = 'CAT2'", x => x.p.cat === 'CAT2'],
        ["p.cat = 'CAT3'", x => x.p.cat === 'CAT3'],
        ["p.cat = 'CAT4'", x => x.p.cat === 'CAT4'],
        ["g.zone = 'west'", x => x.r.zone === 'west'],
        ["g.zone = 'east'", x => x.r.zone === 'east'],
        ["f.status = 'paid'", x => x.f.status === 'paid'],
        ["f.status = 'pending'", x => x.f.status === 'pending'],
        ["f.status = 'cancelled'", x => x.f.status === 'cancelled'],
        ["f.qty >= 5", x => x.f.qty >= 5],
        ["f.cents > 20000", x => x.f.cents > 20000],
        ["c.tier = 'gold' AND p.active = 1", x => x.c.tier === 'gold' && x.p.active === 1],
        ["c.credit >= 800", x => x.c.credit >= 800],
        ["g.zone = 'east' AND f.status <> 'cancelled'", x => x.r.zone === 'east' && x.f.status !== 'cancelled'],
        ["p.cat IN ('CAT1', 'CAT3') AND c.tier <> 'bronze'", x => (x.p.cat === 'CAT1' || x.p.cat === 'CAT3') && x.c.tier !== 'bronze'],
        ["f.nv IS NULL", x => x.f.nv === null],
        ["f.nv IS NOT NULL AND f.nv < 50", x => x.f.nv !== null && x.f.nv < 50],
        ["c.region = g.code", x => x.c.region === x.r.code],
        ["c.region <> g.code", x => x.c.region !== x.r.code],
        ["f.qty * f.cents > 100000", x => x.f.qty * x.f.cents > 100000]
      ];
      B1_PREDS.forEach((pr, i) => {
        const label = 'B1#' + (i + 1) + ' [' + pr[0] + ']';
        const hit = WIDEJOIN.filter(pr[1]);
        val('V34B ' + label + ' four-way join row count', "SELECT COUNT(*) " + FOUR_WAY + "WHERE " + pr[0], hit.length);
        val('V34B ' + label + ' four-way join SUM(qty)', "SELECT SUM(f.qty) " + FOUR_WAY + "WHERE " + pr[0], sum(hit, x => x.f.qty));
        val('V34B ' + label + ' four-way join SUM(cents)', "SELECT SUM(f.cents) " + FOUR_WAY + "WHERE " + pr[0], sum(hit, x => x.f.cents));
      });

      // ---- B2. 外部結合の 4 種別 x ON 句の中の絞り込み ----
      ['s0', 's1', 's2'].forEach(sv => {
        const matched = cnt(SMALL, r => r.s === sv);          // small 側の該当行（id は必ず mid にも在る）
        const unmatchedRight = SMALL.length - matched;
        const shapes = [
          ['INNER JOIN', matched, matched],
          ['LEFT JOIN', MID.length, matched],
          ['RIGHT JOIN', matched + unmatchedRight, matched + unmatchedRight],
          ['FULL OUTER JOIN', MID.length + unmatchedRight, matched + unmatchedRight]
        ];
        shapes.forEach(sh => {
          const from = "FROM v34_mid m " + sh[0] + " v34_small s ON m.id = s.id AND s.s = '" + sv + "'";
          val("V34B B2 " + sh[0] + " with s = '" + sv + "' in ON keeps the right rows", "SELECT COUNT(*) " + from, sh[1]);
          val("V34B B2 " + sh[0] + " with s = '" + sv + "' counts the preserved keys", "SELECT COUNT(s.id) " + from, sh[2]);
        });
      });

      // ---- B3. 結合順序を入れ替えても答えは変わらない ----
      const DIMS = {
        c: "JOIN v34_cust c ON f.cust_id = c.id ",
        p: "JOIN v34_prod p ON f.prod_id = p.id ",
        g: "JOIN v34_reg  g ON f.region  = g.code "
      };
      const PERMS = [['c', 'p', 'g'], ['c', 'g', 'p'], ['p', 'c', 'g'], ['p', 'g', 'c'], ['g', 'c', 'p'], ['g', 'p', 'c']];
      const B3_WHERE = "WHERE c.tier <> 'bronze' AND p.active = 1 AND g.zone = 'west'";
      const B3_HIT = WIDEJOIN.filter(x => x.c.tier !== 'bronze' && x.p.active === 1 && x.r.zone === 'west');
      PERMS.forEach(pm => {
        const from = "FROM v34_fact f " + pm.map(k => DIMS[k]).join('') + B3_WHERE;
        const tag = 'B3 order ' + pm.join('-');
        val('V34B ' + tag + ' row count', "SELECT COUNT(*) " + from, B3_HIT.length);
        val('V34B ' + tag + ' SUM(cents)', "SELECT SUM(f.cents) " + from, sum(B3_HIT, x => x.f.cents));
        val('V34B ' + tag + ' SUM(qty)', "SELECT SUM(f.qty) " + from, sum(B3_HIT, x => x.f.qty));
        val('V34B ' + tag + ' distinct customers', "SELECT COUNT(DISTINCT f.cust_id) " + from, uniq(B3_HIT, x => x.f.cust_id));
      });

      // ---- B4. USING / NATURAL / ON が同じ結合を表す ----
      const MID_SMALL = MID.filter(m => m.id <= 200);        // id が重なるのは 1..200
      const B4_SHAPES = [
        ['USING (id)', "FROM v34_mid m JOIN v34_small s USING (id)"],
        ['ON m.id = s.id', "FROM v34_mid m JOIN v34_small s ON m.id = s.id"],
        ['NATURAL JOIN', "FROM v34_mid m NATURAL JOIN v34_small s"]
      ];
      B4_SHAPES.forEach(sh => {
        val('V34B B4 ' + sh[0] + ' row count', "SELECT COUNT(*) " + sh[1], MID_SMALL.length);
        val('V34B B4 ' + sh[0] + ' SUM(m.val)', "SELECT SUM(m.val) " + sh[1], sum(MID_SMALL, m => m.val));
        val('V34B B4 ' + sh[0] + ' SUM(s.a)', "SELECT SUM(s.a) " + sh[1], sum(SMALL, s => s.a));
        val('V34B B4 ' + sh[0] + ' distinct groups', "SELECT COUNT(DISTINCT m.grp) " + sh[1], uniq(MID_SMALL, m => m.grp));
      });
      const FC_USING = njoin(FACT, CUST, (f, c) => f.region === c.region);
      val('V34B B4 USING (region) across 5000 x 200 rows', "SELECT COUNT(*) FROM v34_fact f JOIN v34_cust c USING (region)", FC_USING);
      val('V34B B4 USING (region) SUM(qty)', "SELECT SUM(f.qty) FROM v34_fact f JOIN v34_cust c USING (region)",
          sjoin(FACT, CUST, (f, c) => f.region === c.region, f => f.qty));
      val('V34B B4 the ON form of USING (region) agrees', "SELECT COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.region = c.region", FC_USING);
      val('V34B B4 the ON form of USING (region) SUM(qty)', "SELECT SUM(f.qty) FROM v34_fact f JOIN v34_cust c ON f.region = c.region",
          sjoin(FACT, CUST, (f, c) => f.region === c.region, f => f.qty));
      const FC_NAT = njoin(FACT, CUST, (f, c) => f.id === c.id && f.region === c.region);
      val('V34B B4 NATURAL JOIN uses every shared column', "SELECT COUNT(*) FROM v34_fact f NATURAL JOIN v34_cust c", FC_NAT);
      val('V34B B4 NATURAL JOIN SUM(cents)', "SELECT SUM(f.cents) FROM v34_fact f NATURAL JOIN v34_cust c",
          sjoin(FACT, CUST, (f, c) => f.id === c.id && f.region === c.region, f => f.cents));
      val('V34B B4 LEFT JOIN USING keeps every left row', "SELECT COUNT(*) FROM v34_mid m LEFT JOIN v34_small s USING (id)", MID.length);
      val('V34B B4 LEFT JOIN USING counts the matches', "SELECT COUNT(s.a) FROM v34_mid m LEFT JOIN v34_small s USING (id)", MID_SMALL.length);
      val('V34B B4 fact joined to the region dimension', "SELECT COUNT(*) FROM v34_fact f JOIN v34_reg g ON f.region = g.code", FACT.length);
      val('V34B B4 fact joined to west regions only',
          "SELECT COUNT(*) FROM v34_fact f JOIN v34_reg g ON f.region = g.code WHERE g.zone = 'west'",
          cnt(WIDEJOIN, x => x.r.zone === 'west'));
      val('V34B B4 fact joined to the region dimension SUM(qty)',
          "SELECT SUM(f.qty) FROM v34_fact f JOIN v34_reg g ON f.region = g.code", sum(FACT, f => f.qty));
      val('V34B B4 fact joined to the region dimension distinct labels',
          "SELECT COUNT(DISTINCT g.label) FROM v34_fact f JOIN v34_reg g ON f.region = g.code", REG.length);

      // ---- B5. 自己結合・交差結合の連鎖 ----
      const B5_AB = (l, r) => l.a === r.b;
      val('V34B B5 self join on a = b row count', "SELECT COUNT(*) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b",
          njoin(SMALL, SMALL, B5_AB));
      val('V34B B5 self join on a = b SUM(s1.id)', "SELECT SUM(s1.id) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b",
          sjoin(SMALL, SMALL, B5_AB, l => l.id));
      val('V34B B5 self join on a = b SUM(s2.id)', "SELECT SUM(s2.id) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b",
          sjoin(SMALL, SMALL, B5_AB, (l, r) => r.id));
      val('V34B B5 self join on a = b distinct left rows', "SELECT COUNT(DISTINCT s1.id) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b",
          cnt(SMALL, l => SMALL.some(r => B5_AB(l, r))));
      const B5_3WAY = (() => {
        let n = 0, s = 0;
        for (const x of SMALL) for (const y of SMALL) { if (x.a !== y.b) continue; for (const z of SMALL) if (y.a === z.b) { n++; s += z.id; } }
        return { n: n, s: s };
      })();
      val('V34B B5 three-way self join row count',
          "SELECT COUNT(*) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b JOIN v34_small s3 ON s2.a = s3.b", B5_3WAY.n);
      val('V34B B5 three-way self join SUM(s3.id)',
          "SELECT SUM(s3.id) FROM v34_small s1 JOIN v34_small s2 ON s1.a = s2.b JOIN v34_small s3 ON s2.a = s3.b", B5_3WAY.s);
      const B5_OFF = (l, r) => l.id === r.id + 1;
      val('V34B B5 offset self join row count', "SELECT COUNT(*) FROM v34_small s1 JOIN v34_small s2 ON s1.id = s2.id + 1",
          njoin(SMALL, SMALL, B5_OFF));
      val('V34B B5 offset self join SUM(s1.a)', "SELECT SUM(s1.a) FROM v34_small s1 JOIN v34_small s2 ON s1.id = s2.id + 1",
          sjoin(SMALL, SMALL, B5_OFF, l => l.a));
      const B5_PAIR = (l, r) => l.s === r.s && l.id < r.id;
      val('V34B B5 unordered pairs inside a group', "SELECT COUNT(*) FROM v34_small s1 JOIN v34_small s2 ON s1.s = s2.s AND s1.id < s2.id",
          njoin(SMALL, SMALL, B5_PAIR));
      val('V34B B5 unordered pairs SUM of the id gap',
          "SELECT SUM(s2.id - s1.id) FROM v34_small s1 JOIN v34_small s2 ON s1.s = s2.s AND s1.id < s2.id",
          sjoin(SMALL, SMALL, B5_PAIR, (l, r) => r.id - l.id));
      val('V34B B5 LEFT self join keeps unmatched rows', "SELECT COUNT(*) FROM v34_small s1 LEFT JOIN v34_small s2 ON s1.a = s2.b",
          nleft(SMALL, SMALL, B5_AB));
      val('V34B B5 LEFT self join counts real matches', "SELECT COUNT(s2.id) FROM v34_small s1 LEFT JOIN v34_small s2 ON s1.a = s2.b",
          njoin(SMALL, SMALL, B5_AB));
      val('V34B B5 LEFT self join finds the unmatched rows',
          "SELECT COUNT(*) FROM v34_small s1 LEFT JOIN v34_small s2 ON s1.a = s2.b WHERE s2.id IS NULL",
          cnt(SMALL, l => !SMALL.some(r => B5_AB(l, r))));
      const B5_MID = (l, r) => l.grp === r.grp && l.sub === r.sub && l.id < r.id && r.id <= 100 && l.id <= 100;
      val('V34B B5 mid self join inside grp and sub',
          "SELECT COUNT(*) FROM v34_mid m1 JOIN v34_mid m2 ON m1.grp = m2.grp AND m1.sub = m2.sub AND m1.id < m2.id " +
          "WHERE m1.id <= 100 AND m2.id <= 100", njoin(MID, MID, B5_MID));
      val('V34B B5 mid self join SUM of the val products',
          "SELECT SUM(m1.val * m2.val) FROM v34_mid m1 JOIN v34_mid m2 ON m1.grp = m2.grp AND m1.sub = m2.sub AND m1.id < m2.id " +
          "WHERE m1.id <= 100 AND m2.id <= 100", sjoin(MID, MID, B5_MID, (l, r) => l.val * r.val));
      const B5_CROSS = (l, r) => l.b === r.b;
      val('V34B B5 comma join with a WHERE predicate', "SELECT COUNT(*) FROM v34_small s1, v34_small s2 WHERE s1.b = s2.b",
          njoin(SMALL, SMALL, B5_CROSS));
      val('V34B B5 CROSS JOIN with the same predicate agrees',
          "SELECT COUNT(*) FROM v34_small s1 CROSS JOIN v34_small s2 WHERE s1.b = s2.b", njoin(SMALL, SMALL, B5_CROSS));
      val('V34B B5 CROSS JOIN of small by reg is the product', "SELECT COUNT(*) FROM v34_small s CROSS JOIN v34_reg g",
          SMALL.length * REG.length);
      val('V34B B5 CROSS JOIN of small by reg SUM(a)', "SELECT SUM(s.a) FROM v34_small s CROSS JOIN v34_reg g",
          sum(SMALL, s => s.a) * REG.length);
      val('V34B B5 triple CROSS JOIN row count', "SELECT COUNT(*) FROM v34_reg g1 CROSS JOIN v34_reg g2 CROSS JOIN v34_reg g3",
          REG.length * REG.length * REG.length);

      // ---- B6. APPLY / LATERAL ----
      val('V34B B6 CROSS APPLY runs once per outer row',
          "SELECT COUNT(*) FROM v34_small s CROSS APPLY (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x", SMALL.length);
      val('V34B B6 CROSS APPLY totals the inner counts',
          "SELECT SUM(x.k) FROM v34_small s CROSS APPLY (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x",
          njoin(SMALL, MID, (s, m) => m.val === s.a));
      val('V34B B6 LATERAL with a comma join runs once per outer row',
          "SELECT COUNT(*) FROM v34_small s, LATERAL (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x", SMALL.length);
      val('V34B B6 LATERAL totals the inner counts',
          "SELECT SUM(x.k) FROM v34_small s, LATERAL (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x",
          njoin(SMALL, MID, (s, m) => m.val === s.a));
      val('V34B B6 LATERAL can also carry a SUM',
          "SELECT SUM(x.k) FROM v34_small s, LATERAL (SELECT SUM(m.val) AS k FROM v34_mid m WHERE m.id <= 50 AND m.val = s.a) x",
          sjoin(SMALL, MID.filter(m => m.id <= 50), (s, m) => m.val === s.a, (s, m) => m.val));
      const B6_OUTER = (() => {
        let n = 0;
        for (const s of SMALL) { const m = cnt(MID, x => x.val === s.a && x.id < 40); n += (m || 1); }
        return n;
      })();
      val('V34B B6 OUTER APPLY keeps rows whose inner query is empty',
          "SELECT COUNT(*) FROM v34_small s OUTER APPLY (SELECT m.id FROM v34_mid m WHERE m.val = s.a AND m.id < 40) x", B6_OUTER);
      val('V34B B6 OUTER APPLY counts only the real inner rows',
          "SELECT COUNT(x.id) FROM v34_small s OUTER APPLY (SELECT m.id FROM v34_mid m WHERE m.val = s.a AND m.id < 40) x",
          njoin(SMALL, MID.filter(m => m.id < 40), (s, m) => m.val === s.a));
      val('V34B B6 LATERAL ON TRUE behaves like a comma join',
          "SELECT COUNT(*) FROM v34_small s JOIN LATERAL (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x ON TRUE",
          SMALL.length);
      val('V34B B6 LATERAL sees the columns of the row it is applied to',
          "SELECT SUM(x.k) FROM v34_small s, LATERAL (SELECT s.a + s.b AS k) x", sum(SMALL, s => s.a + s.b));
      val('V34B B6 the LATERAL result can be filtered outside',
          "SELECT COUNT(*) FROM v34_small s, LATERAL (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x WHERE x.k > 0",
          cnt(SMALL, s => MID.some(m => m.val === s.a)));
      t('V34B B6 the LATERAL result can be grouped outside', () => {
        const m = byKey(SMALL, s => s.s);
        const want = [...m.keys()].sort().map(k => ({ grp: k, k: njoin(m.get(k), MID, (s, mm) => mm.val === s.a) }));
        return expectDeep(rows("SELECT s.s AS grp, SUM(x.k) AS k FROM v34_small s, " +
                               "LATERAL (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x GROUP BY s.s ORDER BY grp"), want);
      });
      val('V34B B6 APPLY combined with an ordinary join',
          "SELECT COUNT(*) FROM v34_small s JOIN v34_reg g ON s.b = SUBSTR(g.code, 2) " +
          "CROSS APPLY (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x",
          njoin(SMALL, REG, (s, g) => String(s.b) === g.code.slice(1)));
      val('V34B B6 APPLY with a constant inner query',
          "SELECT SUM(x.k) FROM v34_small s CROSS APPLY (SELECT 3 AS k) x", SMALL.length * 3);
      val('V34B B6 the APPLY body can use two outer columns',
          "SELECT SUM(x.k) FROM v34_small s CROSS APPLY (SELECT s.a * s.b AS k) x", sum(SMALL, s => s.a * s.b));
      val('V34B B6 LATERAL over the fact table stays correct',
          "SELECT SUM(x.k) FROM v34_reg g, LATERAL (SELECT COUNT(*) AS k FROM v34_fact f WHERE f.region = g.code) x", FACT.length);
      val('V34B B6 LATERAL over the fact table per region',
          "SELECT COUNT(*) FROM v34_reg g, LATERAL (SELECT COUNT(*) AS k FROM v34_fact f WHERE f.region = g.code) x WHERE x.k = 625",
          cnt(REG, g => cnt(FACT, f => f.region === g.code) === 625));
      val('V34B B6 an APPLY body returning two correlated counts',
          "SELECT SUM(x.k1 + x.k2) FROM v34_reg g CROSS APPLY (SELECT COUNT(*) AS k1, " +
          "(SELECT COUNT(*) FROM v34_cust c WHERE c.region = g.code) AS k2 FROM v34_fact f WHERE f.region = g.code) x",
          FACT.length + CUST.length);
      val('V34B B6 APPLY feeding a MAX over regions',
          "SELECT MAX(x.k) FROM v34_reg g CROSS APPLY (SELECT COUNT(*) AS k FROM v34_fact f WHERE f.region = g.code) x",
          Math.max.apply(null, REG.map(g => cnt(FACT, f => f.region === g.code))));
      val('V34B B6 APPLY feeding a MIN over regions',
          "SELECT MIN(x.k) FROM v34_reg g CROSS APPLY (SELECT COUNT(*) AS k FROM v34_fact f WHERE f.region = g.code) x",
          Math.min.apply(null, REG.map(g => cnt(FACT, f => f.region === g.code))));
      val('V34B B6 APPLY over a filtered outer table',
          "SELECT SUM(x.k) FROM v34_small s CROSS APPLY (SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x WHERE s.b = 0",
          njoin(SMALL.filter(s => s.b === 0), MID, (s, m) => m.val === s.a));
      t('V34B B6 the APPLY result can be ordered and limited', () => {
        const want = SMALL.map(s => njoin([s], MID, (ss, m) => m.val === ss.a)).sort((a, b) => b - a).slice(0, 25);
        return expectDeep(colOf("SELECT x.k AS k FROM v34_small s CROSS APPLY " +
                                "(SELECT COUNT(*) AS k FROM v34_mid m WHERE m.val = s.a) x ORDER BY k DESC LIMIT 25", 'k'), want);
      });

      // ---- B7. 準結合・反結合 ----
      const SMALL_A = new Set(SMALL.map(s => s.a));
      const B7 = [
        ["EXISTS", "SELECT COUNT(*) FROM v34_mid m WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          cnt(MID, m => SMALL_A.has(m.val))],
        ["NOT EXISTS", "SELECT COUNT(*) FROM v34_mid m WHERE NOT EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          cnt(MID, m => !SMALL_A.has(m.val))],
        ["IN", "SELECT COUNT(*) FROM v34_mid m WHERE m.val IN (SELECT a FROM v34_small)", cnt(MID, m => SMALL_A.has(m.val))],
        ["NOT IN", "SELECT COUNT(*) FROM v34_mid m WHERE m.val NOT IN (SELECT a FROM v34_small)", cnt(MID, m => !SMALL_A.has(m.val))],
        ["= ANY", "SELECT COUNT(*) FROM v34_mid m WHERE m.val = ANY (SELECT a FROM v34_small)", cnt(MID, m => SMALL_A.has(m.val))],
        ["<> ALL", "SELECT COUNT(*) FROM v34_mid m WHERE m.val <> ALL (SELECT a FROM v34_small)", cnt(MID, m => !SMALL_A.has(m.val))],
        ["EXISTS with SUM", "SELECT SUM(m.val) FROM v34_mid m WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          sum(MID.filter(m => SMALL_A.has(m.val)), m => m.val)],
        ["NOT EXISTS with SUM", "SELECT SUM(m.val) FROM v34_mid m WHERE NOT EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          sum(MID.filter(m => !SMALL_A.has(m.val)), m => m.val)],
        ["EXISTS with two conditions",
          "SELECT COUNT(*) FROM v34_mid m WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val AND s.b = 3)",
          cnt(MID, m => SMALL.some(s => s.a === m.val && s.b === 3))],
        ["EXISTS against the fact table",
          "SELECT COUNT(*) FROM v34_cust c WHERE EXISTS (SELECT 1 FROM v34_fact f WHERE f.cust_id = c.id AND f.status = 'cancelled')",
          cnt(CUST, c => FACT.some(f => f.cust_id === c.id && f.status === 'cancelled'))],
        ["NOT EXISTS against the fact table",
          "SELECT COUNT(*) FROM v34_cust c WHERE NOT EXISTS (SELECT 1 FROM v34_fact f WHERE f.cust_id = c.id AND f.qty = 9)",
          cnt(CUST, c => !FACT.some(f => f.cust_id === c.id && f.qty === 9))],
        ["IN over a joined subquery",
          "SELECT COUNT(*) FROM v34_fact f WHERE f.cust_id IN (SELECT c.id FROM v34_cust c JOIN v34_reg g ON c.region = g.code WHERE g.zone = 'west')",
          cnt(FACT, f => REG_BY_CODE.get(CUST_BY_ID.get(f.cust_id).region).zone === 'west')],
        ["NOT IN over a joined subquery",
          "SELECT COUNT(*) FROM v34_fact f WHERE f.cust_id NOT IN (SELECT c.id FROM v34_cust c JOIN v34_reg g ON c.region = g.code WHERE g.zone = 'west')",
          cnt(FACT, f => REG_BY_CODE.get(CUST_BY_ID.get(f.cust_id).region).zone !== 'west')],
        ["a semi join written as JOIN plus DISTINCT",
          "SELECT COUNT(*) FROM (SELECT DISTINCT m.id FROM v34_mid m JOIN v34_small s ON s.a = m.val) z",
          cnt(MID, m => SMALL_A.has(m.val))],
        ["an anti join written as LEFT JOIN IS NULL",
          "SELECT COUNT(*) FROM v34_mid m LEFT JOIN (SELECT DISTINCT a FROM v34_small) s ON s.a = m.val WHERE s.a IS NULL",
          cnt(MID, m => !SMALL_A.has(m.val))],
        ["EXISTS wrapping an uncorrelated IN subquery",
          "SELECT COUNT(*) FROM v34_reg g WHERE EXISTS (SELECT 1 FROM v34_cust c WHERE c.region = g.code AND c.id IN " +
          "(SELECT f.cust_id FROM v34_fact f WHERE f.qty = 9))",
          (() => { const ids = new Set(FACT.filter(f => f.qty === 9).map(f => f.cust_id));
                   return cnt(REG, g => CUST.some(c => c.region === g.code && ids.has(c.id))); })()],
        ["> ALL over a subquery",
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val > ALL (SELECT b FROM v34_small)",
          cnt(MID, m => SMALL.every(s => m.val > s.b))],
        ["< ANY over a subquery",
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val < ANY (SELECT b FROM v34_small)",
          cnt(MID, m => SMALL.some(s => m.val < s.b))],
        [">= SOME over a subquery",
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val >= SOME (SELECT b FROM v34_small)",
          cnt(MID, m => SMALL.some(s => m.val >= s.b))],
        ["IN against a literal list agrees with the model",
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)",
          cnt(MID, m => m.val <= 9)],
        ["a semi join keeps the left cardinality",
          "SELECT COUNT(DISTINCT m.id) FROM v34_mid m WHERE m.val IN (SELECT a FROM v34_small)",
          cnt(MID, m => SMALL_A.has(m.val))],
        ["semi and anti together cover every row",
          "SELECT (SELECT COUNT(*) FROM v34_mid m WHERE m.val IN (SELECT a FROM v34_small)) + " +
          "(SELECT COUNT(*) FROM v34_mid m WHERE m.val NOT IN (SELECT a FROM v34_small))", MID.length],
        ["EXISTS over the wide table",
          "SELECT COUNT(*) FROM v34_wide w WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.id = w.id AND s.b = 0)",
          cnt(WIDE, w => SMALL.some(s => s.id === w.id && s.b === 0))],
        ["NOT EXISTS over the wide table",
          "SELECT COUNT(*) FROM v34_wide w WHERE NOT EXISTS (SELECT 1 FROM v34_small s WHERE s.id = w.id)",
          cnt(WIDE, w => !SMALL.some(s => s.id === w.id))]
      ];
      B7.forEach((c, i) => val('V34B B7#' + (i + 1) + ' ' + c[0], c[1], c[2]));

      // ---- B8. 結合してから集計する ----
      const B8_TIER = byKey(WIDEJOIN, x => x.c.tier);
      [...B8_TIER.keys()].sort().forEach(tier => {
        const hit = B8_TIER.get(tier);
        val('V34B B8 tier ' + tier + ' joined count',
            "SELECT COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = '" + tier + "'", hit.length);
        val('V34B B8 tier ' + tier + ' joined SUM(cents)',
            "SELECT SUM(f.cents) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = '" + tier + "'",
            sum(hit, x => x.f.cents));
      });
      t('V34B B8 grouping the four-way join by tier and zone', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.r.zone);
        const want = [...m.keys()].sort().map(k => ({ tier: k.split('|')[0], zone: k.split('|')[1], n: m.get(k).length,
                                                      s: sum(m.get(k), x => x.f.cents) }));
        return expectDeep(rows("SELECT c.tier AS tier, g.zone AS zone, COUNT(*) AS n, SUM(f.cents) AS s " + FOUR_WAY +
                               "GROUP BY c.tier, g.zone ORDER BY tier, zone"), want);
      });
      t('V34B B8 grouping the four-way join by cat and status', () => {
        const m = byKey(WIDEJOIN, x => x.p.cat + '|' + x.f.status);
        const want = [...m.keys()].sort().map(k => ({ cat: k.split('|')[0], st: k.split('|')[1], n: m.get(k).length,
                                                      qq: sum(m.get(k), x => x.f.qty) }));
        return expectDeep(rows("SELECT p.cat AS cat, f.status AS st, COUNT(*) AS n, SUM(f.qty) AS qq " + FOUR_WAY +
                               "GROUP BY p.cat, f.status ORDER BY cat, st"), want);
      });
      t('V34B B8 grouping the four-way join by three keys', () =>
        expect(one("SELECT COUNT(*) FROM (SELECT c.tier, p.cat, g.zone " + FOUR_WAY + "GROUP BY c.tier, p.cat, g.zone) z"),
               uniq(WIDEJOIN, x => x.c.tier + '|' + x.p.cat + '|' + x.r.zone)));
      [50, 100, 200, 400, 800].forEach(th => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat);
        val('V34B B8 HAVING COUNT(*) > ' + th + ' after the four-way join',
            "SELECT COUNT(*) FROM (SELECT c.tier, p.cat " + FOUR_WAY + "GROUP BY c.tier, p.cat HAVING COUNT(*) > " + th + ") z",
            [...m.values()].filter(v => v.length > th).length);
      });
      [1000000, 2000000, 4000000].forEach(th => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat);
        val('V34B B8 HAVING SUM(cents) > ' + th + ' after the four-way join',
            "SELECT COUNT(*) FROM (SELECT c.tier, p.cat " + FOUR_WAY + "GROUP BY c.tier, p.cat HAVING SUM(f.cents) > " + th + ") z",
            [...m.values()].filter(v => sum(v, x => x.f.cents) > th).length);
      });
      val('V34B B8 joined subtotals add up to the grand total',
          "SELECT SUM(s) FROM (SELECT SUM(f.cents) AS s " + FOUR_WAY + "GROUP BY c.tier, p.cat, g.zone, f.status) z",
          sum(FACT, f => f.cents));
      val('V34B B8 joined group counts add up to the row count',
          "SELECT SUM(n) FROM (SELECT COUNT(*) AS n " + FOUR_WAY + "GROUP BY c.tier, p.cat, g.zone, f.status) z", FACT.length);
      val('V34B B8 LEFT JOIN aggregate keeps dimension rows with no facts',
          "SELECT COUNT(*) FROM (SELECT p.id, COUNT(f.id) AS n FROM v34_prod p LEFT JOIN v34_fact f " +
          "ON f.prod_id = p.id AND f.qty = 9 GROUP BY p.id HAVING COUNT(f.id) = 0) z",
          cnt(PROD, p => !FACT.some(f => f.prod_id === p.id && f.qty === 9)));
      val('V34B B8 aggregate over a three-table chain',
          "SELECT COUNT(*) FROM (SELECT c.tier, p.cat FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id " +
          "JOIN v34_prod p ON f.prod_id = p.id WHERE p.active = 1 GROUP BY c.tier, p.cat) z",
          uniq(WIDEJOIN.filter(x => x.p.active === 1), x => x.c.tier + '|' + x.p.cat));
      t('V34B B8 COUNT(DISTINCT) survives the four-way join', () => {
        const m = byKey(WIDEJOIN, x => x.r.zone);
        const want = [...m.keys()].sort().map(k => ({ zone: k, cc: uniq(m.get(k), x => x.f.cust_id), pp: uniq(m.get(k), x => x.f.prod_id) }));
        return expectDeep(rows("SELECT g.zone AS zone, COUNT(DISTINCT f.cust_id) AS cc, COUNT(DISTINCT f.prod_id) AS pp " +
                               FOUR_WAY + "GROUP BY g.zone ORDER BY zone"), want);
      });
      t('V34B B8 AVG after the four-way join', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier);
        const keys = [...m.keys()].sort();
        const got = rows("SELECT c.tier AS tier, AVG(f.qty) AS a " + FOUR_WAY + "GROUP BY c.tier ORDER BY tier");
        expect(got.length, keys.length, 'group count');
        got.forEach((row, i) => {
          const grp = m.get(keys[i]);
          expectNear(row.a, sum(grp, x => x.f.qty) / grp.length, 1e-9, keys[i]);
        });
        return true;
      });
      t('V34B B8 MIN and MAX after the four-way join', () => {
        const m = byKey(WIDEJOIN, x => x.p.cat);
        const want = [...m.keys()].sort().map(k => ({ cat: k, lo: Math.min.apply(null, m.get(k).map(x => x.f.cents)),
                                                      hi: Math.max.apply(null, m.get(k).map(x => x.f.cents)) }));
        return expectDeep(rows("SELECT p.cat AS cat, MIN(f.cents) AS lo, MAX(f.cents) AS hi " + FOUR_WAY +
                               "GROUP BY p.cat ORDER BY cat"), want);
      });
      t('V34B B8 ORDER BY an aggregate after the join', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier);
        const want = [...m.entries()].map(e => ({ tier: e[0], n: e[1].length })).sort((a, b) => b.n - a.n || (a.tier < b.tier ? -1 : 1));
        return expectDeep(rows("SELECT c.tier AS tier, COUNT(*) AS n " + FOUR_WAY + "GROUP BY c.tier ORDER BY n DESC, tier"), want);
      });
      val('V34B B8 LIMIT after grouping the join',
          "SELECT COUNT(*) FROM (SELECT c.tier AS tier, COUNT(*) AS n " + FOUR_WAY + "GROUP BY c.tier ORDER BY n DESC, tier LIMIT 2) z", 2);
      t('V34B B8 grouping by an expression over joined columns', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '/' + x.r.zone);
        const want = [...m.keys()].sort().map(k => ({ k: k, n: m.get(k).length }));
        return expectDeep(rows("SELECT c.tier || '/' || g.zone AS k, COUNT(*) AS n " + FOUR_WAY +
                               "GROUP BY c.tier || '/' || g.zone ORDER BY k"), want);
      });
      val('V34B B8 HAVING on an expression of two aggregates',
          "SELECT COUNT(*) FROM (SELECT c.tier, p.cat " + FOUR_WAY +
          "GROUP BY c.tier, p.cat HAVING SUM(f.cents) * 1.0 / COUNT(*) > 19000) z",
          [...byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat).values()].filter(v => sum(v, x => x.f.cents) / v.length > 19000).length);

      // ============================================================
      // C. 大規模な集計
      //    5000 行を様々な軸でまとめ、集計関数の答えを模型と突き合わせる
      // ============================================================

      // 相対誤差を許す突き合わせ（統計集計は小数第 4 位で丸めて返る）
      const expectRel = (actual, want, label) => {
        const tol = Math.max(1e-4, Math.abs(want) * 1e-9);
        if (typeof actual !== 'number' || Math.abs(actual - want) > tol) {
          throw new Error((label ? label + ' ' : '') + 'expected ~' + want + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const mean = (arr, f) => sum(arr, f) / arr.length;
      const varPop = (arr, f) => { const m = mean(arr, f); return sum(arr, x => (f(x) - m) * (f(x) - m)) / arr.length; };
      const varSamp = (arr, f) => { const m = mean(arr, f); return sum(arr, x => (f(x) - m) * (f(x) - m)) / (arr.length - 1); };
      const covPop = (arr, fx, fy) => { const mx = mean(arr, fx), my = mean(arr, fy);
                                        return sum(arr, x => (fx(x) - mx) * (fy(x) - my)) / arr.length; };
      const covSamp = (arr, fx, fy) => { const mx = mean(arr, fx), my = mean(arr, fy);
                                         return sum(arr, x => (fx(x) - mx) * (fy(x) - my)) / (arr.length - 1); };
      // PERCENTILE_CONT の線形補間（順位 p*(n-1) の位置を前後の値で按分）
      const pctCont = (sorted, p) => {
        const pos = p * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
        return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      };

      // ---- C1. 6 通りのまとめ方 x 8 個の集計関数を全件突き合わせ ----
      const C1_GROUPS = [
        { cols: ['region'], types: ['t'] },
        { cols: ['status'], types: ['t'] },
        { cols: ['qty'], types: ['n'] },
        { cols: ['prod_id'], types: ['n'] },
        { cols: ['region', 'status'], types: ['t', 't'] },
        { cols: ['qty', 'status'], types: ['n', 't'] }
      ];
      const C1_AGGS = [
        { sql: 'COUNT(*)', f: g => g.length, exact: true },
        { sql: 'SUM(qty)', f: g => sum(g, r => r.qty), exact: true },
        { sql: 'SUM(cents)', f: g => sum(g, r => r.cents), exact: true },
        { sql: 'MIN(cents)', f: g => Math.min.apply(null, g.map(r => r.cents)), exact: true },
        { sql: 'MAX(cents)', f: g => Math.max.apply(null, g.map(r => r.cents)), exact: true },
        { sql: 'COUNT(nv)', f: g => cnt(g, r => r.nv !== null), exact: true },
        { sql: 'COUNT(DISTINCT cust_id)', f: g => uniq(g, r => r.cust_id), exact: true },
        { sql: 'AVG(qty)', f: g => mean(g, r => r.qty), exact: false }
      ];
      C1_GROUPS.forEach(grp => {
        const keyOf = r => grp.cols.map(c => r[c]).join('');
        const buckets = byKey(FACT, keyOf);
        const keys = [...buckets.keys()].sort((A, B) => {
          const a = A.split(''), b = B.split('');
          for (let i = 0; i < a.length; i++) {
            if (grp.types[i] === 'n') { const d = Number(a[i]) - Number(b[i]); if (d) return d; }
            else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
          }
          return 0;
        });
        const selKeys = grp.cols.map((c, i) => c + ' AS k' + i).join(', ');
        const ordKeys = grp.cols.map((c, i) => 'k' + i).join(', ');
        C1_AGGS.forEach(ag => {
          const name = 'V34C C1 GROUP BY ' + grp.cols.join('+') + ' with ' + ag.sql;
          const sql = "SELECT " + selKeys + ", " + ag.sql + " AS m FROM v34_fact GROUP BY " +
                      grp.cols.join(', ') + " ORDER BY " + ordKeys;
          t(name, () => {
            const got = rows(sql);
            expect(got.length, keys.length, 'group count');
            keys.forEach((k, i) => {
              const parts = k.split('');
              grp.cols.forEach((c, j) => {
                const wantKey = grp.types[j] === 'n' ? Number(parts[j]) : parts[j];
                expect(got[i]['k' + j], wantKey, 'key ' + c + ' at row ' + i);
              });
              const w = ag.f(buckets.get(k));
              if (ag.exact) expect(got[i].m, w, 'row ' + i);
              else expectNear(got[i].m, w, 1e-9, 'row ' + i);
            });
            return true;
          });
        });
      });

      // ---- C2. HAVING でグループを絞る ----
      const C2_GROUPS = [
        ['region', r => r.region], ['prod_id', r => r.prod_id],
        ['cust_id', r => r.cust_id], ['region, status', r => r.region + '|' + r.status]
      ];
      C2_GROUPS.forEach(gp => {
        const buckets = [...byKey(FACT, gp[1]).values()];
        [1, 5, 10, 20, 25, 30, 50, 100].forEach(th => {
          val('V34C C2 GROUP BY ' + gp[0] + ' HAVING COUNT(*) > ' + th,
              "SELECT COUNT(*) FROM (SELECT " + gp[0] + " FROM v34_fact GROUP BY " + gp[0] + " HAVING COUNT(*) > " + th + ") z",
              buckets.filter(b => b.length > th).length);
        });
        [50000, 100000, 400000, 1000000, 2000000, 4000000, 12000000].forEach(th => {
          val('V34C C2 GROUP BY ' + gp[0] + ' HAVING SUM(cents) > ' + th,
              "SELECT COUNT(*) FROM (SELECT " + gp[0] + " FROM v34_fact GROUP BY " + gp[0] + " HAVING SUM(cents) > " + th + ") z",
              buckets.filter(b => sum(b, r => r.cents) > th).length);
        });
      });

      // ---- C3. ROLLUP / CUBE / GROUPING SETS ----
      const REGIONS = [...new Set(FACT.map(r => r.region))].sort();
      const STATUSES = [...new Set(FACT.map(r => r.status))].sort();
      const RS_PAIRS = [...new Set(FACT.map(r => r.region + '|' + r.status))];
      val('V34C C3 ROLLUP(region) adds one grand total row',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region)) z", REGIONS.length + 1);
      val('V34C C3 ROLLUP(region) grand total counts every row',
          "SELECT n FROM (SELECT region AS r, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region)) z WHERE r IS NULL", FACT.length);
      val('V34C C3 ROLLUP(region) detail rows still add up',
          "SELECT SUM(n) FROM (SELECT region AS r, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region)) z WHERE r IS NOT NULL",
          FACT.length);
      val('V34C C3 ROLLUP(region) grand total sums the cents',
          "SELECT s FROM (SELECT region AS r, SUM(cents) AS s FROM v34_fact GROUP BY ROLLUP(region)) z WHERE r IS NULL",
          sum(FACT, r => r.cents));
      val('V34C C3 ROLLUP(region, status) row count',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY ROLLUP(region, status)) z",
          RS_PAIRS.length + REGIONS.length + 1);
      val('V34C C3 ROLLUP(region, status) subtotal rows',
          "SELECT COUNT(*) FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region, status)) z " +
          "WHERE r IS NOT NULL AND st IS NULL", REGIONS.length);
      val('V34C C3 ROLLUP(region, status) region subtotals are right',
          "SELECT n FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region, status)) z " +
          "WHERE r = 'R3' AND st IS NULL", cnt(FACT, r => r.region === 'R3'));
      val('V34C C3 CUBE(region, status) row count',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY CUBE(region, status)) z",
          RS_PAIRS.length + REGIONS.length + STATUSES.length + 1);
      val('V34C C3 CUBE(region, status) status-only subtotal',
          "SELECT n FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY CUBE(region, status)) z " +
          "WHERE r IS NULL AND st = 'paid'", cnt(FACT, r => r.status === 'paid'));
      val('V34C C3 CUBE(region, status) region-only subtotal',
          "SELECT n FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY CUBE(region, status)) z " +
          "WHERE r = 'R5' AND st IS NULL", cnt(FACT, r => r.region === 'R5'));
      val('V34C C3 CUBE(region, status) grand total',
          "SELECT n FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY CUBE(region, status)) z " +
          "WHERE r IS NULL AND st IS NULL", FACT.length);
      val('V34C C3 GROUPING SETS of two single columns plus the empty set',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS ((region), (status), ())) z",
          REGIONS.length + STATUSES.length + 1);
      val('V34C C3 GROUPING SETS of the pair and the empty set',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS ((region, status), ())) z",
          RS_PAIRS.length + 1);
      val('V34C C3 GROUPING SETS with three sets',
          "SELECT COUNT(*) FROM (SELECT region, status, qty, COUNT(*) FROM v34_fact " +
          "GROUP BY GROUPING SETS ((region), (status), (qty))) z",
          REGIONS.length + STATUSES.length + uniq(FACT, r => r.qty));
      val('V34C C3 GROUPING SETS totals stay consistent',
          "SELECT SUM(n) FROM (SELECT region, status, COUNT(*) AS n FROM v34_fact GROUP BY GROUPING SETS ((region), (status))) z",
          FACT.length * 2);
      val('V34C C3 GROUPING() marks the rolled-up rows',
          "SELECT COUNT(*) FROM (SELECT region, GROUPING(region) AS g, COUNT(*) FROM v34_fact GROUP BY ROLLUP(region)) z WHERE g = 1", 1);
      val('V34C C3 GROUPING() leaves the detail rows at zero',
          "SELECT COUNT(*) FROM (SELECT region, GROUPING(region) AS g, COUNT(*) FROM v34_fact GROUP BY ROLLUP(region)) z WHERE g = 0",
          REGIONS.length);
      val('V34C C3 GROUPING_ID over two columns has three distinct values in ROLLUP',
          "SELECT COUNT(DISTINCT gid) FROM (SELECT GROUPING_ID(region, status) AS gid FROM v34_fact GROUP BY ROLLUP(region, status)) z", 3);
      val('V34C C3 GROUPING_ID over two columns has four distinct values in CUBE',
          "SELECT COUNT(DISTINCT gid) FROM (SELECT GROUPING_ID(region, status) AS gid FROM v34_fact GROUP BY CUBE(region, status)) z", 4);
      val('V34C C3 WITH ROLLUP is the same as ROLLUP()',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) FROM v34_fact GROUP BY region WITH ROLLUP) z", REGIONS.length + 1);
      val('V34C C3 ROLLUP over three columns',
          "SELECT COUNT(*) FROM (SELECT region, status, qty, COUNT(*) FROM v34_fact GROUP BY ROLLUP(region, status, qty)) z",
          uniq(FACT, r => r.region + '|' + r.status + '|' + r.qty) + RS_PAIRS.length + REGIONS.length + 1);
      val('V34C C3 CUBE keeps the detail rows intact',
          "SELECT SUM(n) FROM (SELECT region AS r, status AS st, COUNT(*) AS n FROM v34_fact GROUP BY CUBE(region, status)) z " +
          "WHERE r IS NOT NULL AND st IS NOT NULL", FACT.length);
      val('V34C C3 ROLLUP with a HAVING filter',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region) HAVING COUNT(*) > 1000) z", 1);
      val('V34C C3 ROLLUP over a joined query',
          "SELECT COUNT(*) FROM (SELECT c.tier, COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id " +
          "GROUP BY ROLLUP(c.tier)) z", TIERS.length + 1);
      val('V34C C3 CUBE over a joined query',
          "SELECT COUNT(*) FROM (SELECT c.tier, f.status, COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id " +
          "GROUP BY CUBE(c.tier, f.status)) z",
          uniq(WIDEJOIN, x => x.c.tier + '|' + x.f.status) + TIERS.length + STATUSES.length + 1);
      val('V34C C3 ROLLUP subtotals of SUM(qty) per region',
          "SELECT SUM(s) FROM (SELECT region AS r, SUM(qty) AS s FROM v34_fact GROUP BY ROLLUP(region)) z WHERE r IS NOT NULL",
          sum(FACT, r => r.qty));
      val('V34C C3 the ROLLUP grand total of SUM(qty)',
          "SELECT s FROM (SELECT region AS r, SUM(qty) AS s FROM v34_fact GROUP BY ROLLUP(region)) z WHERE r IS NULL",
          sum(FACT, r => r.qty));
      val('V34C C3 GROUPING SETS of one column equals a plain GROUP BY',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS ((region))) z", REGIONS.length);
      val('V34C C3 GROUPING SETS of one column keeps every row',
          "SELECT SUM(n) FROM (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY GROUPING SETS ((region))) z", FACT.length);
      val('V34C C3 ROLLUP over the mid table by grp',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) FROM v34_mid GROUP BY ROLLUP(grp)) z", uniq(MID, r => r.grp) + 1);
      val('V34C C3 CUBE over the mid table by grp and sub',
          "SELECT COUNT(*) FROM (SELECT grp, sub, COUNT(*) FROM v34_mid GROUP BY CUBE(grp, sub)) z",
          uniq(MID, r => r.grp + '|' + r.sub) + uniq(MID, r => r.grp) + uniq(MID, r => r.sub) + 1);
      val('V34C C3 ROLLUP over the mid table keeps SUM(val)',
          "SELECT s FROM (SELECT grp AS g, SUM(val) AS s FROM v34_mid GROUP BY ROLLUP(grp)) z WHERE g IS NULL",
          sum(MID, r => r.val));
      val('V34C C3 ROLLUP counts NULL-bearing columns the same way',
          "SELECT c FROM (SELECT grp AS g, COUNT(nval) AS c FROM v34_mid GROUP BY ROLLUP(grp)) z WHERE g IS NULL",
          cnt(MID, r => r.nval !== null));
      val('V34C C3 ROLLUP with ORDER BY on the alias',
          "SELECT COUNT(*) FROM (SELECT region AS r, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region) ORDER BY n DESC) z",
          REGIONS.length + 1);
      val('V34C C3 GROUPING SETS repeated column appears twice',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS ((region), (region))) z",
          REGIONS.length * 2);
      val('V34C C3 GROUPING SETS containing ROLLUP',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS (ROLLUP(region), (status))) z",
          REGIONS.length + 1 + STATUSES.length);
      val('V34C C3 GROUPING SETS containing CUBE',
          "SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact GROUP BY GROUPING SETS (CUBE(region, status))) z",
          RS_PAIRS.length + REGIONS.length + STATUSES.length + 1);
      val('V34C C3 ROLLUP result can be filtered by GROUPING()',
          "SELECT n FROM (SELECT GROUPING(region) AS g, COUNT(*) AS n FROM v34_fact GROUP BY ROLLUP(region)) z WHERE g = 1",
          FACT.length);
      val('V34C C3 CUBE over three columns row count',
          "SELECT COUNT(*) FROM (SELECT region, status, qty, COUNT(*) FROM v34_fact GROUP BY CUBE(region, status, qty)) z",
          (() => {
            const k = (fs) => uniq(FACT, r => fs.map(f => r[f]).join('|'));
            return k(['region', 'status', 'qty']) + k(['region', 'status']) + k(['region', 'qty']) + k(['status', 'qty']) +
                   k(['region']) + k(['status']) + k(['qty']) + 1;
          })());

      // ---- C4. FILTER 句 ----
      const C4_CASES = [
        ["COUNT(*) FILTER (WHERE status = 'paid')", cnt(FACT, r => r.status === 'paid')],
        ["COUNT(*) FILTER (WHERE status = 'pending')", cnt(FACT, r => r.status === 'pending')],
        ["COUNT(*) FILTER (WHERE status = 'cancelled')", cnt(FACT, r => r.status === 'cancelled')],
        ["COUNT(*) FILTER (WHERE qty >= 5)", cnt(FACT, r => r.qty >= 5)],
        ["COUNT(*) FILTER (WHERE nv IS NULL)", cnt(FACT, r => r.nv === null)],
        ["SUM(qty) FILTER (WHERE status = 'paid')", sum(FACT.filter(r => r.status === 'paid'), r => r.qty)],
        ["SUM(cents) FILTER (WHERE region = 'R0')", sum(FACT.filter(r => r.region === 'R0'), r => r.cents)],
        ["SUM(cents) FILTER (WHERE qty > 4 AND status <> 'cancelled')",
          sum(FACT.filter(r => r.qty > 4 && r.status !== 'cancelled'), r => r.cents)],
        ["MIN(cents) FILTER (WHERE status = 'pending')",
          Math.min.apply(null, FACT.filter(r => r.status === 'pending').map(r => r.cents))],
        ["MAX(cents) FILTER (WHERE status = 'pending')",
          Math.max.apply(null, FACT.filter(r => r.status === 'pending').map(r => r.cents))],
        ["COUNT(DISTINCT cust_id) FILTER (WHERE region = 'R1')",
          uniq(FACT.filter(r => r.region === 'R1'), r => r.cust_id)],
        ["COUNT(nv) FILTER (WHERE qty = 1)", cnt(FACT.filter(r => r.qty === 1), r => r.nv !== null)],
        ["COUNT(*) FILTER (WHERE cents BETWEEN 5000 AND 15000)", cnt(FACT, r => r.cents >= 5000 && r.cents <= 15000)],
        ["COUNT(*) FILTER (WHERE txt LIKE 'ord-000%')", cnt(FACT, r => /^ord-000/.test('ord-' + String(r.id).padStart(5, '0')))],
        ["SUM(qty) FILTER (WHERE prod_id <= 10)", sum(FACT.filter(r => r.prod_id <= 10), r => r.qty)]
      ];
      C4_CASES.forEach((c, i) => val('V34C C4#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " FROM v34_fact", c[1]));
      t('V34C C4 FILTER per region for the paid rows', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, n: cnt(m.get(k), x => x.status === 'paid') }));
        return expectDeep(rows("SELECT region AS r, COUNT(*) FILTER (WHERE status = 'paid') AS n FROM v34_fact " +
                               "GROUP BY region ORDER BY r"), want);
      });
      t('V34C C4 three FILTER columns partition each region', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, a: cnt(m.get(k), x => x.status === 'paid'),
                                         b: cnt(m.get(k), x => x.status === 'pending'),
                                         c: cnt(m.get(k), x => x.status === 'cancelled') }));
        return expectDeep(rows("SELECT region AS r, COUNT(*) FILTER (WHERE status = 'paid') AS a, " +
                               "COUNT(*) FILTER (WHERE status = 'pending') AS b, " +
                               "COUNT(*) FILTER (WHERE status = 'cancelled') AS c FROM v34_fact GROUP BY region ORDER BY r"), want);
      });
      t('V34C C4 FILTER and plain aggregates side by side', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, all: m.get(k).length, paid: cnt(m.get(k), x => x.status === 'paid') }));
        return expectDeep(rows("SELECT region AS r, COUNT(*) AS all, COUNT(*) FILTER (WHERE status = 'paid') AS paid " +
                               "FROM v34_fact GROUP BY region ORDER BY r"), want);
      });
      val('V34C C4 FILTER that matches nothing yields zero',
          "SELECT COUNT(*) FILTER (WHERE status = 'nope') FROM v34_fact", 0);
      // 空集合の SUM / AVG を 0 とするのは LuminaDB の既存仕様（標準は NULL）。FILTER でも同じに揃う
      val('V34C C4 SUM with a FILTER that matches nothing follows the empty-set rule',
          "SELECT SUM(qty) FILTER (WHERE status = 'nope') FROM v34_fact", 0);
      val('V34C C4 AVG with a FILTER that matches nothing follows the empty-set rule',
          "SELECT AVG(qty) FILTER (WHERE status = 'nope') FROM v34_fact", 0);
      t('V34C C4 MIN with a FILTER that matches nothing is NULL', () =>
        expect(one("SELECT MIN(qty) FILTER (WHERE status = 'nope') FROM v34_fact"), null));
      t('V34C C4 MAX with a FILTER that matches nothing is NULL', () =>
        expect(one("SELECT MAX(qty) FILTER (WHERE status = 'nope') FROM v34_fact"), null));
      val('V34C C4 FILTER combined with a WHERE clause',
          "SELECT COUNT(*) FILTER (WHERE qty > 4) FROM v34_fact WHERE region = 'R2'",
          cnt(FACT, r => r.region === 'R2' && r.qty > 4));
      t('V34C C4 the three FILTER counts add back up to the total', () => {
        const r = rows("SELECT COUNT(*) FILTER (WHERE status = 'paid') AS a, COUNT(*) FILTER (WHERE status = 'pending') AS b, " +
                       "COUNT(*) FILTER (WHERE status = 'cancelled') AS c FROM v34_fact")[0];
        return expect(r.a + r.b + r.c, FACT.length);
      });
      t('V34C C4 a FILTER result can be doubled outside the query', () =>
        expect(one("SELECT COUNT(*) FILTER (WHERE status = 'paid') AS a FROM v34_fact") * 2,
               cnt(FACT, r => r.status === 'paid') * 2));
      val('V34C C4 FILTER over a joined query',
          "SELECT COUNT(*) FILTER (WHERE c.tier = 'gold') FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id",
          cnt(WIDEJOIN, x => x.c.tier === 'gold'));
      t('V34C C4 a FILTER column can be filtered in an outer query', () =>
        expect(one("SELECT COUNT(*) FROM (SELECT region, COUNT(*) FILTER (WHERE qty = 9) AS n FROM v34_fact GROUP BY region) z " +
                   "WHERE n > 60"),
               [...byKey(FACT, r => r.region).values()].filter(b => cnt(b, x => x.qty === 9) > 60).length));
      t('V34C C4 AVG with FILTER stays a float', () =>
        expectNear(one("SELECT AVG(qty) FILTER (WHERE status = 'paid') FROM v34_fact"),
                   mean(FACT.filter(r => r.status === 'paid'), r => r.qty), 1e-9));
      val('V34C C4 FILTER over the mid table',
          "SELECT COUNT(*) FILTER (WHERE nval IS NULL) FROM v34_mid", cnt(MID, r => r.nval === null));
      val('V34C C4 FILTER with an IN predicate',
          "SELECT COUNT(*) FILTER (WHERE region IN ('R0', 'R1', 'R2')) FROM v34_fact",
          cnt(FACT, r => ['R0', 'R1', 'R2'].indexOf(r.region) >= 0));
      val('V34C C4 FILTER with a NOT predicate',
          "SELECT COUNT(*) FILTER (WHERE NOT (qty < 5)) FROM v34_fact", cnt(FACT, r => r.qty >= 5));
      t('V34C C4 two FILTER sums can be divided in an outer query', () =>
        expectNear(one("SELECT a * 1.0 / b AS ratio FROM (SELECT SUM(cents) FILTER (WHERE status = 'paid') AS a, " +
                       "SUM(cents) FILTER (WHERE status = 'pending') AS b FROM v34_fact) z"),
                   sum(FACT.filter(r => r.status === 'paid'), r => r.cents) /
                   sum(FACT.filter(r => r.status === 'pending'), r => r.cents), 1e-9));

      // ---- C5. DISTINCT を伴う集計 ----
      const C5_CASES = [
        ["COUNT(DISTINCT cust_id)", uniq(FACT, r => r.cust_id)],
        ["COUNT(DISTINCT prod_id)", uniq(FACT, r => r.prod_id)],
        ["COUNT(DISTINCT region)", uniq(FACT, r => r.region)],
        ["COUNT(DISTINCT status)", uniq(FACT, r => r.status)],
        ["COUNT(DISTINCT qty)", uniq(FACT, r => r.qty)],
        ["COUNT(DISTINCT cents)", uniq(FACT, r => r.cents)],
        ["COUNT(DISTINCT nv)", uniq(FACT.filter(r => r.nv !== null), r => r.nv)],
        ["SUM(DISTINCT qty)", [...new Set(FACT.map(r => r.qty))].reduce((s, x) => s + x, 0)],
        ["SUM(DISTINCT cents)", [...new Set(FACT.map(r => r.cents))].reduce((s, x) => s + x, 0)],
        ["MIN(DISTINCT cents)", Math.min.apply(null, FACT.map(r => r.cents))],
        ["MAX(DISTINCT cents)", Math.max.apply(null, FACT.map(r => r.cents))],
        ["COUNT(DISTINCT cust_id) + COUNT(DISTINCT prod_id)", uniq(FACT, r => r.cust_id) + uniq(FACT, r => r.prod_id)]
      ];
      C5_CASES.forEach((c, i) => val('V34C C5#' + (i + 1) + ' ' + c[0], "SELECT " + c[0] + " FROM v34_fact", c[1]));
      t('V34C C5 COUNT(DISTINCT cust_id) per region', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, n: uniq(m.get(k), x => x.cust_id) }));
        return expectDeep(rows("SELECT region AS r, COUNT(DISTINCT cust_id) AS n FROM v34_fact GROUP BY region ORDER BY r"), want);
      });
      t('V34C C5 COUNT(DISTINCT prod_id) per status', () => {
        const m = byKey(FACT, r => r.status);
        const want = STATUSES.map(k => ({ st: k, n: uniq(m.get(k), x => x.prod_id) }));
        return expectDeep(rows("SELECT status AS st, COUNT(DISTINCT prod_id) AS n FROM v34_fact GROUP BY status ORDER BY st"), want);
      });
      t('V34C C5 SUM(DISTINCT qty) per region', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, n: [...new Set(m.get(k).map(x => x.qty))].reduce((s, x) => s + x, 0) }));
        return expectDeep(rows("SELECT region AS r, SUM(DISTINCT qty) AS n FROM v34_fact GROUP BY region ORDER BY r"), want);
      });
      val('V34C C5 DISTINCT over a pair of columns',
          "SELECT COUNT(*) FROM (SELECT DISTINCT region, status FROM v34_fact) z", uniq(FACT, r => r.region + '|' + r.status));
      val('V34C C5 DISTINCT over three columns',
          "SELECT COUNT(*) FROM (SELECT DISTINCT region, status, qty FROM v34_fact) z",
          uniq(FACT, r => r.region + '|' + r.status + '|' + r.qty));
      val('V34C C5 DISTINCT over the whole 5000-row table',
          "SELECT COUNT(*) FROM (SELECT DISTINCT id, cust_id, prod_id FROM v34_fact) z", FACT.length);
      val('V34C C5 COUNT(DISTINCT) ignores NULLs', "SELECT COUNT(DISTINCT nval) FROM v34_mid",
          uniq(MID.filter(r => r.nval !== null), r => r.nval));
      val('V34C C5 COUNT(*) counts the NULL rows too', "SELECT COUNT(*) FROM v34_mid", MID.length);
      val('V34C C5 DISTINCT after a join',
          "SELECT COUNT(DISTINCT c.tier) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id", TIERS.length);
      val('V34C C5 DISTINCT of an expression',
          "SELECT COUNT(DISTINCT qty * 10 + prod_id) FROM v34_fact", uniq(FACT, r => r.qty * 10 + r.prod_id));
      val('V34C C5 DISTINCT of a concatenation',
          "SELECT COUNT(DISTINCT region || status) FROM v34_fact", uniq(FACT, r => r.region + r.status));
      val('V34C C5 DISTINCT combined with a WHERE clause',
          "SELECT COUNT(DISTINCT cust_id) FROM v34_fact WHERE qty >= 5", uniq(FACT.filter(r => r.qty >= 5), r => r.cust_id));
      val('V34C C5 DISTINCT inside a HAVING clause',
          "SELECT COUNT(*) FROM (SELECT region FROM v34_fact GROUP BY region HAVING COUNT(DISTINCT cust_id) = 25) z",
          [...byKey(FACT, r => r.region).values()].filter(b => uniq(b, x => x.cust_id) === 25).length);

      // ---- C6. 文字列を畳み込む集計 ----
      val('V34C C6 GROUP_CONCAT of five ids', "SELECT GROUP_CONCAT(id) FROM v34_small WHERE id <= 5", '1,2,3,4,5');
      val('V34C C6 GROUP_CONCAT with a SEPARATOR', "SELECT GROUP_CONCAT(id SEPARATOR '-') FROM v34_small WHERE id <= 5", '1-2-3-4-5');
      val('V34C C6 GROUP_CONCAT with ORDER BY DESC',
          "SELECT GROUP_CONCAT(id ORDER BY id DESC) FROM v34_small WHERE id <= 5", '5,4,3,2,1');
      val('V34C C6 GROUP_CONCAT with ORDER BY and a SEPARATOR',
          "SELECT GROUP_CONCAT(id ORDER BY id DESC SEPARATOR '|') FROM v34_small WHERE id <= 5", '5|4|3|2|1');
      val('V34C C6 GROUP_CONCAT DISTINCT over a big table',
          "SELECT GROUP_CONCAT(DISTINCT region ORDER BY region) FROM v34_fact", REGIONS.join(','));
      val('V34C C6 GROUP_CONCAT over 5000 rows has the right length',
          "SELECT LENGTH(GROUP_CONCAT(id)) FROM v34_fact",
          sum(FACT, r => String(r.id).length) + FACT.length - 1);
      val('V34C C6 STRING_AGG with an explicit separator',
          "SELECT STRING_AGG(id, '-') FROM v34_small WHERE id <= 5", '1-2-3-4-5');
      t('V34C C6 STRING_AGG over the region list holds every region', () =>
        expectDeep(String(one("SELECT STRING_AGG(DISTINCT region, ',') FROM v34_fact")).split(',').sort(), REGIONS));
      val('V34C C6 LISTAGG with WITHIN GROUP',
          "SELECT LISTAGG(id, '-') WITHIN GROUP (ORDER BY id DESC) FROM v34_small WHERE id <= 5", '5-4-3-2-1');
      val('V34C C6 LISTAGG over the distinct regions',
          "SELECT LISTAGG(code, '/') WITHIN GROUP (ORDER BY code) FROM v34_reg", REG.map(r => r.code).join('/'));
      val('V34C C6 ARRAY_AGG length matches the row count',
          "SELECT ARRAY_LENGTH(ARRAY_AGG(id)) FROM v34_small", SMALL.length);
      val('V34C C6 ARRAY_AGG over the fact table',
          "SELECT ARRAY_LENGTH(ARRAY_AGG(id)) FROM v34_fact WHERE qty = 9", cnt(FACT, r => r.qty === 9));
      t('V34C C6 GROUP_CONCAT per group of the small table', () => {
        const m = byKey(SMALL, r => r.s);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => ({ s: k, g: m.get(k).filter(r => r.id <= 20).map(r => r.id).sort((a, b) => a - b).join(',') }));
        return expectDeep(rows("SELECT s AS s, GROUP_CONCAT(id ORDER BY id) AS g FROM v34_small WHERE id <= 20 " +
                               "GROUP BY s ORDER BY s"), want);
      });
      t('V34C C6 GROUP_CONCAT per region of the fact table lengths', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => ({ r: k, l: sum(m.get(k), x => String(x.id).length) + m.get(k).length - 1 }));
        return expectDeep(rows("SELECT region AS r, LENGTH(GROUP_CONCAT(id)) AS l FROM v34_fact GROUP BY region ORDER BY r"), want);
      });
      val('V34C C6 GROUP_CONCAT of an empty selection is NULL',
          "SELECT COALESCE(GROUP_CONCAT(id), 'none') FROM v34_small WHERE id > 10000", 'none');
      val('V34C C6 GROUP_CONCAT skips NULL values',
          "SELECT LENGTH(GROUP_CONCAT(nval)) FROM v34_mid WHERE id <= 26",
          (() => { const v = MID.filter(r => r.id <= 26 && r.nval !== null).map(r => String(r.nval));
                   return v.join(',').length; })());
      val('V34C C6 GROUP_CONCAT of a computed string',
          "SELECT GROUP_CONCAT('x' || id ORDER BY id) FROM v34_small WHERE id <= 4", 'x1,x2,x3,x4');
      val('V34C C6 STRING_AGG of a computed string',
          "SELECT STRING_AGG('y' || id, '+') FROM v34_small WHERE id <= 4", 'y1+y2+y3+y4');
      val('V34C C6 GROUP_CONCAT inside a longer expression',
          "SELECT LENGTH('[' || GROUP_CONCAT(id) || ']') FROM v34_small WHERE id <= 5", '[1,2,3,4,5]'.length);
      val('V34C C6 JSON_ARRAYAGG produces valid JSON',
          "SELECT JSON_VALID(JSON_ARRAYAGG(id)) FROM v34_small WHERE id <= 5", 1);
      val('V34C C6 JSON_ARRAYAGG holds every element',
          "SELECT JSON_LENGTH(JSON_ARRAYAGG(id)) FROM v34_small", SMALL.length);
      val('V34C C6 GROUP_CONCAT over a joined query',
          "SELECT GROUP_CONCAT(DISTINCT c.tier ORDER BY c.tier) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id",
          TIERS.slice().sort().join(','));
      val('V34C C6 GROUP_CONCAT of the pivoted region labels',
          "SELECT GROUP_CONCAT(label ORDER BY code SEPARATOR ' / ') FROM v34_reg", REG.map(r => r.label).join(' / '));

      // ---- C7. 統計集計 ----
      const QTY = r => r.qty, CENTS = r => r.cents;
      const C7_CASES = [
        ["STDDEV_POP(qty)", Math.sqrt(varPop(FACT, QTY))],
        ["STDDEV_SAMP(qty)", Math.sqrt(varSamp(FACT, QTY))],
        ["VAR_POP(qty)", varPop(FACT, QTY)],
        ["VAR_SAMP(qty)", varSamp(FACT, QTY)],
        ["STDDEV_POP(cents)", Math.sqrt(varPop(FACT, CENTS))],
        ["VAR_POP(cents)", varPop(FACT, CENTS)],
        ["COVAR_POP(qty, cents)", covPop(FACT, QTY, CENTS)],
        ["COVAR_SAMP(qty, cents)", covSamp(FACT, QTY, CENTS)],
        ["CORR(qty, cents)", covPop(FACT, QTY, CENTS) / (Math.sqrt(varPop(FACT, QTY)) * Math.sqrt(varPop(FACT, CENTS)))],
        ["REGR_COUNT(cents, qty)", FACT.length],
        ["REGR_AVGX(cents, qty)", mean(FACT, QTY)],
        ["REGR_AVGY(cents, qty)", mean(FACT, CENTS)],
        ["REGR_SLOPE(cents, qty)", covPop(FACT, QTY, CENTS) / varPop(FACT, QTY)],
        ["REGR_INTERCEPT(cents, qty)", mean(FACT, CENTS) - (covPop(FACT, QTY, CENTS) / varPop(FACT, QTY)) * mean(FACT, QTY)],
        ["REGR_SXX(cents, qty)", varPop(FACT, QTY) * FACT.length],
        ["REGR_SYY(cents, qty)", varPop(FACT, CENTS) * FACT.length],
        ["REGR_SXY(cents, qty)", covPop(FACT, QTY, CENTS) * FACT.length],
        ["REGR_R2(cents, qty)", Math.pow(covPop(FACT, QTY, CENTS) / (Math.sqrt(varPop(FACT, QTY)) * Math.sqrt(varPop(FACT, CENTS))), 2)]
      ];
      C7_CASES.forEach((c, i) => t('V34C C7#' + (i + 1) + ' ' + c[0], () =>
        expectRel(one("SELECT " + c[0] + " FROM v34_fact"), c[1], c[0])));
      t('V34C C7 STDDEV_POP per region', () => {
        const m = byKey(FACT, r => r.region);
        const got = rows("SELECT region AS r, STDDEV_POP(qty) AS s FROM v34_fact GROUP BY region ORDER BY r");
        expect(got.length, REGIONS.length, 'group count');
        got.forEach((row, i) => expectRel(row.s, Math.sqrt(varPop(m.get(REGIONS[i]), QTY)), REGIONS[i]));
        return true;
      });
      t('V34C C7 VAR_SAMP per status', () => {
        const m = byKey(FACT, r => r.status);
        const got = rows("SELECT status AS st, VAR_SAMP(cents) AS v FROM v34_fact GROUP BY status ORDER BY st");
        expect(got.length, STATUSES.length, 'group count');
        got.forEach((row, i) => expectRel(row.v, varSamp(m.get(STATUSES[i]), CENTS), STATUSES[i]));
        return true;
      });
      t('V34C C7 CORR per region', () => {
        const m = byKey(FACT, r => r.region);
        const got = rows("SELECT region AS r, CORR(qty, cents) AS c FROM v34_fact GROUP BY region ORDER BY r");
        got.forEach((row, i) => {
          const g = m.get(REGIONS[i]);
          expectRel(row.c, covPop(g, QTY, CENTS) / (Math.sqrt(varPop(g, QTY)) * Math.sqrt(varPop(g, CENTS))), REGIONS[i]);
        });
        return true;
      });
      val('V34C C7 STDDEV of a single row is zero', "SELECT STDDEV_POP(qty) FROM v34_fact WHERE id = 1", 0);
      val('V34C C7 VAR_SAMP of a single row is NULL',
          "SELECT COALESCE(VAR_SAMP(qty), -1) FROM v34_fact WHERE id = 1", -1);
      val('V34C C7 statistical aggregates over an empty set are NULL',
          "SELECT COALESCE(STDDEV_POP(qty), -1) FROM v34_fact WHERE id < 0", -1);
      t('V34C C7 population and sample variance differ by n / (n - 1)', () => {
        const vp = one("SELECT VAR_POP(qty) FROM v34_fact");
        const vs = one("SELECT VAR_SAMP(qty) FROM v34_fact");
        return expectRel(vs * (FACT.length - 1) / FACT.length, vp, 'ratio');
      });
      t('V34C C7 REGR_SLOPE equals COVAR_POP over VAR_POP', () => {
        const slope = one("SELECT REGR_SLOPE(cents, qty) FROM v34_fact");
        return expectRel(slope, covPop(FACT, QTY, CENTS) / varPop(FACT, QTY), 'slope');
      });
      t('V34C C7 CORR of a column with itself is one', () => expectRel(one("SELECT CORR(qty, qty) FROM v34_fact"), 1));
      t('V34C C7 COVAR_POP of a column with itself is VAR_POP', () =>
        expectRel(one("SELECT COVAR_POP(qty, qty) FROM v34_fact"), varPop(FACT, QTY)));

      // ---- C8. WITHIN GROUP を伴う集計 ----
      const QTY_SORTED = FACT.map(r => r.qty).sort((a, b) => a - b);
      const CENTS_SORTED = FACT.map(r => r.cents).sort((a, b) => a - b);
      const C8_CASES = [
        ["PERCENTILE_CONT(0.0) WITHIN GROUP (ORDER BY qty)", pctCont(QTY_SORTED, 0)],
        ["PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY qty)", pctCont(QTY_SORTED, 0.25)],
        ["PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qty)", pctCont(QTY_SORTED, 0.5)],
        ["PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY qty)", pctCont(QTY_SORTED, 0.75)],
        ["PERCENTILE_CONT(1.0) WITHIN GROUP (ORDER BY qty)", pctCont(QTY_SORTED, 1)],
        ["PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cents)", pctCont(CENTS_SORTED, 0.5)],
        ["PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY cents)", pctCont(CENTS_SORTED, 0.9)],
        ["MEDIAN(qty)", pctCont(QTY_SORTED, 0.5)],
        ["MEDIAN(cents)", pctCont(CENTS_SORTED, 0.5)]
      ];
      C8_CASES.forEach((c, i) => t('V34C C8#' + (i + 1) + ' ' + c[0], () =>
        expectRel(one("SELECT " + c[0] + " FROM v34_fact"), c[1], c[0])));
      val('V34C C8 PERCENTILE_DISC picks a value that exists',
          "SELECT COUNT(*) FROM v34_fact WHERE qty = (SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY qty) FROM v34_fact) " +
          "AND 1 = 1", cnt(FACT, r => r.qty === QTY_SORTED[Math.min(QTY_SORTED.length - 1, Math.ceil(0.5 * QTY_SORTED.length) - 1)]));
      val('V34C C8 MODE returns the most frequent qty',
          "SELECT MODE() WITHIN GROUP (ORDER BY qty) FROM v34_fact",
          (() => { const m = byKey(FACT, r => r.qty); let best = null, bn = -1;
                   [...m.entries()].sort((a, b) => a[0] - b[0]).forEach(e => { if (e[1].length > bn) { bn = e[1].length; best = e[0]; } });
                   return best; })());
      val('V34C C8 MODE over the mid table',
          "SELECT MODE() WITHIN GROUP (ORDER BY val) FROM v34_mid",
          (() => { const m = byKey(MID, r => r.val); let best = null, bn = -1;
                   [...m.entries()].sort((a, b) => a[0] - b[0]).forEach(e => { if (e[1].length > bn) { bn = e[1].length; best = e[0]; } });
                   return best; })());
      t('V34C C8 the median per region', () => {
        const m = byKey(FACT, r => r.region);
        const got = rows("SELECT region AS r, MEDIAN(cents) AS md FROM v34_fact GROUP BY region ORDER BY r");
        got.forEach((row, i) => expectRel(row.md, pctCont(m.get(REGIONS[i]).map(x => x.cents).sort((a, b) => a - b), 0.5), REGIONS[i]));
        return true;
      });
      t('V34C C8 the quartiles per status', () => {
        const m = byKey(FACT, r => r.status);
        const got = rows("SELECT status AS st, PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY cents) AS q1, " +
                         "PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY cents) AS q3 FROM v34_fact GROUP BY status ORDER BY st");
        got.forEach((row, i) => {
          const s = m.get(STATUSES[i]).map(x => x.cents).sort((a, b) => a - b);
          expectRel(row.q1, pctCont(s, 0.25), STATUSES[i] + ' q1');
          expectRel(row.q3, pctCont(s, 0.75), STATUSES[i] + ' q3');
        });
        return true;
      });
      t('V34C C8 percentiles are monotone', () => {
        const r = rows("SELECT PERCENTILE_CONT(0.1) WITHIN GROUP (ORDER BY cents) AS a, " +
                       "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cents) AS b, " +
                       "PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY cents) AS c FROM v34_fact")[0];
        if (!(r.a <= r.b && r.b <= r.c)) throw new Error('not monotone: ' + JSON.stringify(r));
        return true;
      });
      val('V34C C8 the median of an empty selection is NULL',
          "SELECT COALESCE(MEDIAN(qty), -1) FROM v34_fact WHERE id < 0", -1);
      val('V34C C8 PERCENTILE_CONT over a descending order',
          "SELECT PERCENTILE_CONT(0.0) WITHIN GROUP (ORDER BY qty DESC) FROM v34_fact", QTY_SORTED[QTY_SORTED.length - 1]);
      val('V34C C8 MEDIAN over a joined query',
          "SELECT MEDIAN(f.cents) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'gold'",
          pctCont(WIDEJOIN.filter(x => x.c.tier === 'gold').map(x => x.f.cents).sort((a, b) => a - b), 0.5));
      val('V34C C8 MEDIAN with a WHERE clause',
          "SELECT MEDIAN(cents) FROM v34_fact WHERE region = 'R4'",
          pctCont(FACT.filter(r => r.region === 'R4').map(r => r.cents).sort((a, b) => a - b), 0.5));
      val('V34C C8 MEDIAN of the mid table values',
          "SELECT MEDIAN(val) FROM v34_mid", pctCont(MID.map(r => r.val).sort((a, b) => a - b), 0.5));
      val('V34C C8 MEDIAN skips NULLs',
          "SELECT MEDIAN(nval) FROM v34_mid", pctCont(MID.filter(r => r.nval !== null).map(r => r.nval).sort((a, b) => a - b), 0.5));

      // ============================================================
      // D. ウィンドウ関数
      //    1000 行の v34_mid に対し、区画・並び・フレームを変えながら
      //    1 行ずつの値を模型と突き合わせる（id 昇順に並べて比較）
      // ============================================================

      // 列をまるごと比べる（数値は誤差を許す）
      const expectArr = (got, want, eps, label) => {
        if (got.length !== want.length) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + want.length + ' rows but got ' + got.length);
        }
        for (let i = 0; i < want.length; i++) {
          const a = got[i], b = want[i];
          if (a === b) continue;
          if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (eps || 0)) continue;
          throw new Error((label ? label + ' ' : '') + 'row ' + i + ': expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a));
        }
        return true;
      };
      // 模型側のウィンドウ評価。calc は「並べ替え済みの区画」を受け取り各行の値を返す
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
      const calcCumeDist = keyf => s => {
        const n = s.length;
        return s.map(r => { const k = keyf(r); let c = 0; for (const x of s) if (keyf(x) <= k) c++; return c / n; });
      };
      const calcNtile = k => s => {
        const n = s.length, base = Math.floor(n / k), rem = n % k, out = [];
        let idx = 0;
        for (let tile = 1; tile <= k; tile++) { const size = base + (tile <= rem ? 1 : 0); for (let j = 0; j < size; j++) out[idx++] = tile; }
        return out;
      };
      // ROWS フレーム。lo / hi は現在行からの相対位置（null は無制限）
      const calcRows = (agg, lo, hi) => s => s.map((_, i) => {
        const a = lo === null ? 0 : Math.max(0, i + lo);
        const b = hi === null ? s.length - 1 : Math.min(s.length - 1, i + hi);
        return a > b ? null : agg(s.slice(a, b + 1));
      });
      // ORDER BY を付けたときの既定フレーム（RANGE UNBOUNDED PRECEDING 〜 CURRENT ROW。同値行を含む）
      const calcRangeDefault = (agg, keyf) => s => s.map((r, i) => {
        const k = keyf(r); let b = i;
        while (b + 1 < s.length && keyf(s[b + 1]) === k) b++;
        return agg(s.slice(0, b + 1));
      });
      const aSum = f => a => a.reduce((x, y) => x + f(y), 0);
      const aAvg = f => a => a.reduce((x, y) => x + f(y), 0) / a.length;
      const aCount = () => a => a.length;
      const aMin = f => a => Math.min.apply(null, a.map(f));
      const aMax = f => a => Math.max.apply(null, a.map(f));
      const VAL = r => r.val;

      const D_PARTS = [
        { tag: 'no partition', sql: '', f: () => '*' },
        { tag: 'PARTITION BY grp', sql: 'PARTITION BY grp ', f: r => r.grp },
        { tag: 'PARTITION BY sub', sql: 'PARTITION BY sub ', f: r => r.sub },
        { tag: 'PARTITION BY grp, sub', sql: 'PARTITION BY grp, sub ', f: r => r.grp + '|' + r.sub }
      ];
      const D_ORDERS = [
        { tag: 'ORDER BY id', sql: 'ORDER BY id', cmp: (a, b) => a.id - b.id },
        { tag: 'ORDER BY val, id', sql: 'ORDER BY val, id', cmp: (a, b) => a.val - b.val || a.id - b.id },
        { tag: 'ORDER BY val DESC, id', sql: 'ORDER BY val DESC, id', cmp: (a, b) => b.val - a.val || a.id - b.id },
        { tag: 'ORDER BY txt, id', sql: 'ORDER BY txt, id', cmp: (a, b) => (a.txt < b.txt ? -1 : a.txt > b.txt ? 1 : 0) || a.id - b.id }
      ];

      // ---- D1. 順位付けの関数 ----
      D_PARTS.forEach(pt => {
        D_ORDERS.forEach(od => {
          t('V34D D1 ROW_NUMBER with ' + pt.tag + ' ' + od.tag, () =>
            expectArr(colOf("SELECT ROW_NUMBER() OVER (" + pt.sql + od.sql + ") AS rn FROM v34_mid ORDER BY id", 'rn'),
                      winOf(MID, pt.f, od.cmp, calcRowNumber), 0, 'row_number'));
        });
        [['ORDER BY val', (a, b) => a.val - b.val, VAL], ['ORDER BY val DESC', (a, b) => b.val - a.val, VAL]].forEach(od => {
          t('V34D D1 RANK with ' + pt.tag + ' ' + od[0], () =>
            expectArr(colOf("SELECT RANK() OVER (" + pt.sql + od[0] + ") AS rk FROM v34_mid ORDER BY id", 'rk'),
                      winOf(MID, pt.f, od[1], calcRank(od[2])), 0, 'rank'));
          t('V34D D1 DENSE_RANK with ' + pt.tag + ' ' + od[0], () =>
            expectArr(colOf("SELECT DENSE_RANK() OVER (" + pt.sql + od[0] + ") AS rk FROM v34_mid ORDER BY id", 'rk'),
                      winOf(MID, pt.f, od[1], calcDenseRank(od[2])), 0, 'dense_rank'));
        });
        [4, 7].forEach(k => {
          t('V34D D1 NTILE(' + k + ') with ' + pt.tag, () =>
            expectArr(colOf("SELECT NTILE(" + k + ") OVER (" + pt.sql + "ORDER BY id) AS nt FROM v34_mid ORDER BY id", 'nt'),
                      winOf(MID, pt.f, (a, b) => a.id - b.id, calcNtile(k)), 0, 'ntile'));
        });
        t('V34D D1 PERCENT_RANK with ' + pt.tag, () =>
          expectArr(colOf("SELECT PERCENT_RANK() OVER (" + pt.sql + "ORDER BY val) AS pr FROM v34_mid ORDER BY id", 'pr'),
                    winOf(MID, pt.f, (a, b) => a.val - b.val, calcPercentRank(VAL)), 1e-9, 'percent_rank'));
        t('V34D D1 CUME_DIST with ' + pt.tag, () =>
          expectArr(colOf("SELECT CUME_DIST() OVER (" + pt.sql + "ORDER BY val) AS cd FROM v34_mid ORDER BY id", 'cd'),
                    winOf(MID, pt.f, (a, b) => a.val - b.val, calcCumeDist(VAL)), 1e-9, 'cume_dist'));
      });

      // ---- D2. フレーム指定 ----
      const D2_FRAMES = [
        ['ROWS BETWEEN 1 PRECEDING AND CURRENT ROW', -1, 0],
        ['ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING', 0, 1],
        ['ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING', -1, 1],
        ['ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING', -2, 2],
        ['ROWS BETWEEN 3 PRECEDING AND CURRENT ROW', -3, 0],
        ['ROWS BETWEEN CURRENT ROW AND CURRENT ROW', 0, 0],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', null, 0],
        ['ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', 0, null],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', null, null],
        ['ROWS BETWEEN 5 PRECEDING AND 5 FOLLOWING', -5, 5],
        ['ROWS BETWEEN 10 PRECEDING AND CURRENT ROW', -10, 0],
        ['ROWS BETWEEN CURRENT ROW AND 10 FOLLOWING', 0, 10]
      ];
      [D_PARTS[0], D_PARTS[1]].forEach(pt => {
        D2_FRAMES.forEach(fr => {
          t('V34D D2 SUM over ' + fr[0] + ' with ' + pt.tag, () =>
            expectArr(colOf("SELECT SUM(val) OVER (" + pt.sql + "ORDER BY id " + fr[0] + ") AS s FROM v34_mid ORDER BY id", 's'),
                      winOf(MID, pt.f, (a, b) => a.id - b.id, calcRows(aSum(VAL), fr[1], fr[2])), 0, 'sum'));
        });
      });
      [['AVG(val)', aAvg(VAL), 1e-9], ['COUNT(*)', aCount(), 0], ['MIN(val)', aMin(VAL), 0], ['MAX(val)', aMax(VAL), 0]]
        .forEach(ag => {
          [D2_FRAMES[0], D2_FRAMES[1], D2_FRAMES[2], D2_FRAMES[3], D2_FRAMES[6], D2_FRAMES[7], D2_FRAMES[8], D2_FRAMES[9]].forEach(fr => {
            t('V34D D2 ' + ag[0] + ' over ' + fr[0], () =>
              expectArr(colOf("SELECT " + ag[0] + " OVER (ORDER BY id " + fr[0] + ") AS s FROM v34_mid ORDER BY id", 's'),
                        winOf(MID, () => '*', (a, b) => a.id - b.id, calcRows(ag[1], fr[1], fr[2])), ag[2], ag[0]));
          });
        });
      t('V34D D2 the default frame follows RANGE to the current peer group', () =>
        expectArr(colOf("SELECT SUM(val) OVER (ORDER BY val) AS s FROM v34_mid ORDER BY id", 's'),
                  winOf(MID, () => '*', (a, b) => a.val - b.val, calcRangeDefault(aSum(VAL), VAL)), 0, 'range default'));
      t('V34D D2 the default frame per partition', () =>
        expectArr(colOf("SELECT SUM(val) OVER (PARTITION BY grp ORDER BY val) AS s FROM v34_mid ORDER BY id", 's'),
                  winOf(MID, r => r.grp, (a, b) => a.val - b.val, calcRangeDefault(aSum(VAL), VAL)), 0, 'range default'));
      t('V34D D2 no ORDER BY means the whole partition', () =>
        expectArr(colOf("SELECT SUM(val) OVER (PARTITION BY grp) AS s FROM v34_mid ORDER BY id", 's'),
                  winOf(MID, r => r.grp, null, s => { const tot = aSum(VAL)(s); return s.map(() => tot); }), 0, 'whole partition'));
      t('V34D D2 an empty OVER () spans the whole table', () =>
        expectArr(colOf("SELECT SUM(val) OVER () AS s FROM v34_mid ORDER BY id", 's'),
                  MID.map(() => sum(MID, VAL)), 0, 'over()'));
      t('V34D D2 RANGE with a numeric offset on the small table', () => {
        const want = winOf(SMALL, () => '*', (a, b) => a.a - b.a, s => s.map(r => {
          let acc = 0;
          for (const x of s) if (x.a >= r.a - 2 && x.a <= r.a + 2) acc += x.b;
          return acc;
        }));
        return expectArr(colOf("SELECT SUM(b) OVER (ORDER BY a RANGE BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS s " +
                               "FROM v34_small ORDER BY id", 's'), want, 0, 'range offset');
      });
      t('V34D D2 RANGE unbounded preceding on the small table', () => {
        const want = winOf(SMALL, () => '*', (a, b) => a.a - b.a, s => s.map(r => {
          let acc = 0;
          for (const x of s) if (x.a <= r.a) acc += x.b;
          return acc;
        }));
        return expectArr(colOf("SELECT SUM(b) OVER (ORDER BY a RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s " +
                               "FROM v34_small ORDER BY id", 's'), want, 0, 'range unbounded');
      });
      t('V34D D2 RANGE with a partition on the small table', () => {
        const want = winOf(SMALL, r => r.s, (a, b) => a.a - b.a, s => s.map(r => {
          let acc = 0;
          for (const x of s) if (x.a <= r.a) acc += x.b;
          return acc;
        }));
        return expectArr(colOf("SELECT SUM(b) OVER (PARTITION BY s ORDER BY a RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS x " +
                               "FROM v34_small ORDER BY id", 'x'), want, 0, 'range partition');
      });
      t('V34D D2 GROUPS counts peer groups, not rows', () => {
        const want = winOf(SMALL, () => '*', (a, b) => a.b - b.b || a.id - b.id, s => {
          const keys = [...new Set(s.map(r => r.b))].sort((x, y) => x - y);
          const idx = new Map(keys.map((k, i) => [k, i]));
          return s.map(r => {
            const i = idx.get(r.b);
            let acc = 0;
            for (const x of s) { const j = idx.get(x.b); if (j >= i - 1 && j <= i) acc += x.a; }
            return acc;
          });
        });
        return expectArr(colOf("SELECT SUM(a) OVER (ORDER BY b GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s " +
                               "FROM v34_small ORDER BY id", 's'), want, 0, 'groups');
      });
      t('V34D D2 GROUPS with a following bound', () => {
        const want = winOf(SMALL, () => '*', (a, b) => a.b - b.b || a.id - b.id, s => {
          const keys = [...new Set(s.map(r => r.b))].sort((x, y) => x - y);
          const idx = new Map(keys.map((k, i) => [k, i]));
          return s.map(r => {
            const i = idx.get(r.b);
            let acc = 0;
            for (const x of s) { const j = idx.get(x.b); if (j >= i && j <= i + 1) acc += x.a; }
            return acc;
          });
        });
        return expectArr(colOf("SELECT SUM(a) OVER (ORDER BY b GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS s " +
                               "FROM v34_small ORDER BY id", 's'), want, 0, 'groups following');
      });
      t('V34D D2 EXCLUDE CURRENT ROW drops the row itself', () => {
        const total = sum(SMALL, r => r.a);
        return expectArr(colOf("SELECT SUM(a) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE CURRENT ROW) AS s FROM v34_small ORDER BY id", 's'),
                         SMALL.slice().sort((x, y) => x.id - y.id).map(r => total - r.a), 0, 'exclude current row');
      });
      t('V34D D2 EXCLUDE NO OTHERS keeps the full frame', () =>
        expectArr(colOf("SELECT SUM(a) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                        "EXCLUDE NO OTHERS) AS s FROM v34_small ORDER BY id", 's'),
                  SMALL.map(() => sum(SMALL, r => r.a)), 0, 'exclude no others'));
      t('V34D D2 EXCLUDE GROUP drops the whole peer group', () => {
        const total = sum(SMALL, r => r.a);
        const byB = byKey(SMALL, r => r.b);
        return expectArr(colOf("SELECT SUM(a) OVER (ORDER BY b RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE GROUP) AS s FROM v34_small ORDER BY id", 's'),
                         SMALL.slice().sort((x, y) => x.id - y.id).map(r => total - sum(byB.get(r.b), x => x.a)), 0, 'exclude group');
      });
      t('V34D D2 EXCLUDE TIES keeps the current row but drops its peers', () => {
        const total = sum(SMALL, r => r.a);
        const byB = byKey(SMALL, r => r.b);
        return expectArr(colOf("SELECT SUM(a) OVER (ORDER BY b RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING " +
                               "EXCLUDE TIES) AS s FROM v34_small ORDER BY id", 's'),
                         SMALL.slice().sort((x, y) => x.id - y.id).map(r => total - sum(byB.get(r.b), x => x.a) + r.a), 0, 'exclude ties');
      });

      // ---- D3. 位置を取り出す関数 ----
      const calcLag = (f, off, dflt) => s => s.map((_, i) => i - off >= 0 ? f(s[i - off]) : dflt);
      const calcLead = (f, off, dflt) => s => s.map((_, i) => i + off < s.length ? f(s[i + off]) : dflt);
      [1, 2, 3].forEach(off => {
        t('V34D D3 LAG(val, ' + off + ') without a partition', () =>
          expectArr(colOf("SELECT LAG(val, " + off + ") OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                    winOf(MID, () => '*', (a, b) => a.id - b.id, calcLag(VAL, off, null)), 0, 'lag'));
        t('V34D D3 LEAD(val, ' + off + ') without a partition', () =>
          expectArr(colOf("SELECT LEAD(val, " + off + ") OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                    winOf(MID, () => '*', (a, b) => a.id - b.id, calcLead(VAL, off, null)), 0, 'lead'));
        t('V34D D3 LAG(val, ' + off + ') partitioned by grp', () =>
          expectArr(colOf("SELECT LAG(val, " + off + ") OVER (PARTITION BY grp ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                    winOf(MID, r => r.grp, (a, b) => a.id - b.id, calcLag(VAL, off, null)), 0, 'lag'));
        t('V34D D3 LEAD(val, ' + off + ') partitioned by grp', () =>
          expectArr(colOf("SELECT LEAD(val, " + off + ") OVER (PARTITION BY grp ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                    winOf(MID, r => r.grp, (a, b) => a.id - b.id, calcLead(VAL, off, null)), 0, 'lead'));
        t('V34D D3 LAG(val, ' + off + ') filled in with COALESCE outside', () =>
          expectArr(colOf("SELECT COALESCE(x, -1) AS x FROM (SELECT id, LAG(val, " + off + ") OVER (ORDER BY id) AS x " +
                          "FROM v34_mid) z ORDER BY id", 'x'),
                    winOf(MID, () => '*', (a, b) => a.id - b.id, calcLag(VAL, off, -1)), 0, 'lag default'));
        t('V34D D3 LEAD(val, ' + off + ') filled in with COALESCE outside', () =>
          expectArr(colOf("SELECT COALESCE(x, -1) AS x FROM (SELECT id, LEAD(val, " + off + ") OVER (ORDER BY id) AS x " +
                          "FROM v34_mid) z ORDER BY id", 'x'),
                    winOf(MID, () => '*', (a, b) => a.id - b.id, calcLead(VAL, off, -1)), 0, 'lead default'));
      });
      t('V34D D3 LAG with no offset means one row back', () =>
        expectArr(colOf("SELECT LAG(val) OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, () => '*', (a, b) => a.id - b.id, calcLag(VAL, 1, null)), 0, 'lag'));
      t('V34D D3 LEAD with no offset means one row ahead', () =>
        expectArr(colOf("SELECT LEAD(val) OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, () => '*', (a, b) => a.id - b.id, calcLead(VAL, 1, null)), 0, 'lead'));
      t('V34D D3 FIRST_VALUE over the whole partition', () =>
        expectArr(colOf("SELECT FIRST_VALUE(val) OVER (PARTITION BY grp ORDER BY id " +
                        "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, r => r.grp, (a, b) => a.id - b.id, s => s.map(() => s[0].val)), 0, 'first_value'));
      t('V34D D3 LAST_VALUE over the whole partition', () =>
        expectArr(colOf("SELECT LAST_VALUE(val) OVER (PARTITION BY grp ORDER BY id " +
                        "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, r => r.grp, (a, b) => a.id - b.id, s => s.map(() => s[s.length - 1].val)), 0, 'last_value'));
      t('V34D D3 LAST_VALUE with the default frame is the current row', () =>
        expectArr(colOf("SELECT LAST_VALUE(val) OVER (PARTITION BY grp ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                  MID.map(r => r.val), 0, 'last_value default frame'));
      [1, 2, 3].forEach(n => {
        t('V34D D3 NTH_VALUE(val, ' + n + ') over the whole partition', () =>
          expectArr(colOf("SELECT NTH_VALUE(val, " + n + ") OVER (PARTITION BY grp ORDER BY id " +
                          "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v34_mid ORDER BY id", 'x'),
                    winOf(MID, r => r.grp, (a, b) => a.id - b.id, s => s.map(() => s.length >= n ? s[n - 1].val : null)), 0, 'nth_value'));
      });
      t('V34D D3 FIRST_VALUE follows a descending order', () =>
        expectArr(colOf("SELECT FIRST_VALUE(val) OVER (PARTITION BY grp ORDER BY val DESC, id " +
                        "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, r => r.grp, (a, b) => b.val - a.val || a.id - b.id, s => s.map(() => s[0].val)), 0, 'first_value desc'));
      t('V34D D3 LAG over a column that holds NULLs', () =>
        expectArr(colOf("SELECT LAG(nval) OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, () => '*', (a, b) => a.id - b.id, calcLag(r => r.nval, 1, null)), 0, 'lag nval'));
      t('V34D D3 LAG IGNORE NULLS skips the NULL rows', () => {
        const want = winOf(MID, () => '*', (a, b) => a.id - b.id, s => s.map((_, i) => {
          for (let j = i - 1; j >= 0; j--) if (s[j].nval !== null) return s[j].nval;
          return null;
        }));
        return expectArr(colOf("SELECT LAG(nval) IGNORE NULLS OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                         want, 0, 'lag ignore nulls');
      });
      t('V34D D3 LEAD IGNORE NULLS skips the NULL rows', () => {
        const want = winOf(MID, () => '*', (a, b) => a.id - b.id, s => s.map((_, i) => {
          for (let j = i + 1; j < s.length; j++) if (s[j].nval !== null) return s[j].nval;
          return null;
        }));
        return expectArr(colOf("SELECT LEAD(nval) IGNORE NULLS OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                         want, 0, 'lead ignore nulls');
      });
      t('V34D D3 RESPECT NULLS is the plain behaviour', () =>
        expectArr(colOf("SELECT LAG(nval) RESPECT NULLS OVER (ORDER BY id) AS x FROM v34_mid ORDER BY id", 'x'),
                  winOf(MID, () => '*', (a, b) => a.id - b.id, calcLag(r => r.nval, 1, null)), 0, 'respect nulls'));
      // ウィンドウ関数は選択項目そのものである必要があるので、差分は派生表の外側で取る
      t('V34D D3 the difference from the previous row', () => {
        const want = winOf(MID, () => '*', (a, b) => a.id - b.id, s => s.map((r, i) => i === 0 ? null : r.val - s[i - 1].val));
        return expectArr(colOf("SELECT val - prev AS d FROM (SELECT id, val, LAG(val) OVER (ORDER BY id) AS prev " +
                               "FROM v34_mid) z ORDER BY id", 'd'), want, 0, 'delta');
      });
      t('V34D D3 LAG over the 5000-row fact table', () =>
        expectArr(colOf("SELECT LAG(qty) OVER (ORDER BY id) AS x FROM v34_fact ORDER BY id LIMIT 500", 'x'),
                  FACT.slice(0, 500).map((r, i) => i === 0 ? null : FACT[i - 1].qty), 0, 'lag fact'));

      // ---- D4. ウィンドウ集計とグループ集計の一致 ----
      t('V34D D4 SUM over a partition equals the group total', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT SUM(val) OVER (PARTITION BY grp) AS s FROM v34_mid ORDER BY id", 's'),
                         MID.map(r => sum(m.get(r.grp), VAL)), 0, 'partition sum');
      });
      t('V34D D4 COUNT over a partition equals the group size', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT COUNT(*) OVER (PARTITION BY grp) AS c FROM v34_mid ORDER BY id", 'c'),
                         MID.map(r => m.get(r.grp).length), 0, 'partition count');
      });
      t('V34D D4 AVG over a partition equals the group mean', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT AVG(val) OVER (PARTITION BY grp) AS a FROM v34_mid ORDER BY id", 'a'),
                         MID.map(r => mean(m.get(r.grp), VAL)), 1e-9, 'partition avg');
      });
      t('V34D D4 MIN and MAX over a partition', () => {
        const m = byKey(MID, r => r.grp);
        const got = rows("SELECT MIN(val) OVER (PARTITION BY grp) AS lo, MAX(val) OVER (PARTITION BY grp) AS hi " +
                         "FROM v34_mid ORDER BY id");
        MID.forEach((r, i) => {
          expect(got[i].lo, Math.min.apply(null, m.get(r.grp).map(VAL)), 'min row ' + i);
          expect(got[i].hi, Math.max.apply(null, m.get(r.grp).map(VAL)), 'max row ' + i);
        });
        return true;
      });
      t('V34D D4 a two-key partition equals the two-key group', () => {
        const m = byKey(MID, r => r.grp + '|' + r.sub);
        return expectArr(colOf("SELECT SUM(val) OVER (PARTITION BY grp, sub) AS s FROM v34_mid ORDER BY id", 's'),
                         MID.map(r => sum(m.get(r.grp + '|' + r.sub), VAL)), 0, 'two-key partition');
      });
      t('V34D D4 the running total ends at the partition total', () => {
        const m = byKey(MID, r => r.grp);
        const got = rows("SELECT grp AS g, MAX(rt) AS mx FROM (SELECT grp, SUM(val) OVER (PARTITION BY grp ORDER BY id " +
                         "ROWS UNBOUNDED PRECEDING) AS rt FROM v34_mid) z GROUP BY grp ORDER BY g");
        const keys = [...m.keys()].sort();
        return expectDeep(got, keys.map(k => ({ g: k, mx: sum(m.get(k), VAL) })));
      });
      t('V34D D4 the share of each row inside its partition adds to one', () => {
        const got = rows("SELECT grp AS g, SUM(val * 1.0 / tot) AS s FROM (SELECT grp, val, SUM(val) OVER (PARTITION BY grp) AS tot " +
                         "FROM v34_mid) z GROUP BY grp ORDER BY g");
        expect(got.length, uniq(MID, r => r.grp), 'group count');
        got.forEach(r => expectNear(r.s, 1, 1e-9, r.g));
        return true;
      });
      t('V34D D4 RATIO_TO_REPORT matches the manual share', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT RATIO_TO_REPORT(val) OVER (PARTITION BY grp) AS r FROM v34_mid ORDER BY id", 'r'),
                         MID.map(r => r.val / sum(m.get(r.grp), VAL)), 1e-9, 'ratio_to_report');
      });
      t('V34D D4 a window aggregate next to a plain column', () => {
        const got = rows("SELECT id, val, SUM(val) OVER (PARTITION BY grp) AS s FROM v34_mid ORDER BY id LIMIT 50");
        const m = byKey(MID, r => r.grp);
        got.forEach((r, i) => { expect(r.val, MID[i].val, 'val'); expect(r.s, sum(m.get(MID[i].grp), VAL), 'sum'); });
        return true;
      });
      t('V34D D4 window aggregates over the 5000-row fact table', () => {
        const m = byKey(FACT, r => r.region);
        return expectArr(colOf("SELECT SUM(qty) OVER (PARTITION BY region) AS s FROM v34_fact ORDER BY id LIMIT 400", 's'),
                         FACT.slice(0, 400).map(r => sum(m.get(r.region), x => x.qty)), 0, 'fact partition sum');
      });
      t('V34D D4 the running count reaches the partition size', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT COUNT(*) OVER (PARTITION BY grp ORDER BY id ROWS UNBOUNDED PRECEDING) AS c " +
                               "FROM v34_mid ORDER BY id", 'c'),
                         winOf(MID, r => r.grp, (a, b) => a.id - b.id, calcRows(aCount(), null, 0)), 0, 'running count');
      });
      t('V34D D4 several window aggregates in one query', () => {
        const m = byKey(MID, r => r.grp);
        const got = rows("SELECT SUM(val) OVER (PARTITION BY grp) AS s, AVG(val) OVER (PARTITION BY grp) AS a, " +
                         "COUNT(*) OVER (PARTITION BY grp) AS c, MIN(val) OVER (PARTITION BY grp) AS lo, " +
                         "MAX(val) OVER (PARTITION BY grp) AS hi FROM v34_mid ORDER BY id LIMIT 100");
        got.forEach((r, i) => {
          const g = m.get(MID[i].grp);
          expect(r.s, sum(g, VAL), 'sum'); expectNear(r.a, mean(g, VAL), 1e-9, 'avg');
          expect(r.c, g.length, 'count'); expect(r.lo, Math.min.apply(null, g.map(VAL)), 'min');
          expect(r.hi, Math.max.apply(null, g.map(VAL)), 'max');
        });
        return true;
      });
      t('V34D D4 windows over two different partitions in one query', () => {
        const byG = byKey(MID, r => r.grp), byS = byKey(MID, r => r.sub);
        const got = rows("SELECT SUM(val) OVER (PARTITION BY grp) AS g, SUM(val) OVER (PARTITION BY sub) AS s " +
                         "FROM v34_mid ORDER BY id LIMIT 100");
        got.forEach((r, i) => {
          expect(r.g, sum(byG.get(MID[i].grp), VAL), 'grp sum');
          expect(r.s, sum(byS.get(MID[i].sub), VAL), 'sub sum');
        });
        return true;
      });
      val('V34D D4 the sum of window sums over the whole table',
          "SELECT SUM(s) FROM (SELECT SUM(val) OVER (PARTITION BY grp) AS s FROM v34_mid) z",
          (() => { const m = byKey(MID, r => r.grp); return sum(MID, r => sum(m.get(r.grp), VAL)); })());
      val('V34D D4 counting rows above their partition average',
          "SELECT COUNT(*) FROM (SELECT val, AVG(val) OVER (PARTITION BY grp) AS a FROM v34_mid) z WHERE val > a",
          (() => { const m = byKey(MID, r => r.grp); return cnt(MID, r => r.val > mean(m.get(r.grp), VAL)); })());
      val('V34D D4 counting rows at their partition maximum',
          "SELECT COUNT(*) FROM (SELECT val, MAX(val) OVER (PARTITION BY grp) AS mx FROM v34_mid) z WHERE val = mx",
          (() => { const m = byKey(MID, r => r.grp);
                   return cnt(MID, r => r.val === Math.max.apply(null, m.get(r.grp).map(VAL))); })());

      // ---- D5. QUALIFY / 名前付きウィンドウ ----
      val('V34D D5 QUALIFY keeps the first row of each partition',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) = 1) z",
          uniq(MID, r => r.grp));
      val('V34D D5 QUALIFY keeps the top three of each partition',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY val DESC, id) <= 3) z",
          uniq(MID, r => r.grp) * 3);
      val('V34D D5 QUALIFY with a two-key partition',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid QUALIFY ROW_NUMBER() OVER (PARTITION BY grp, sub ORDER BY id) = 1) z",
          uniq(MID, r => r.grp + '|' + r.sub));
      val('V34D D5 QUALIFY on RANK keeps the ties',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid QUALIFY RANK() OVER (PARTITION BY grp ORDER BY val DESC) = 1) z",
          (() => { const m = byKey(MID, r => r.grp);
                   return sum([...m.values()], g => cnt(g, r => r.val === Math.max.apply(null, g.map(VAL)))); })());
      val('V34D D5 QUALIFY over the fact table',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_fact QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY id) <= 10) z",
          uniq(FACT, r => r.region) * 10);
      val('V34D D5 QUALIFY combined with WHERE',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE val > 10 " +
          "QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) = 1) z",
          uniq(MID.filter(r => r.val > 10), r => r.grp));
      t('V34D D5 QUALIFY picks exactly the partition maxima', () => {
        const m = byKey(MID, r => r.grp);
        const want = [...m.keys()].sort().map(k => {
          const g = m.get(k).slice().sort((a, b) => b.val - a.val || a.id - b.id);
          return { g: k, id: g[0].id, val: g[0].val };
        });
        return expectDeep(rows("SELECT grp AS g, id AS id, val AS val FROM v34_mid " +
                               "QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY val DESC, id) = 1 ORDER BY g"), want);
      });
      t('V34D D5 a named window behaves like the inline one', () => {
        const inline = colOf("SELECT SUM(val) OVER (PARTITION BY grp ORDER BY id ROWS UNBOUNDED PRECEDING) AS s " +
                             "FROM v34_mid ORDER BY id", 's');
        const named = colOf("SELECT SUM(val) OVER wnd AS s FROM v34_mid " +
                            "WINDOW wnd AS (PARTITION BY grp ORDER BY id ROWS UNBOUNDED PRECEDING) ORDER BY id", 's');
        return expectArr(named, inline, 0, 'named window');
      });
      t('V34D D5 one named window feeds several functions', () => {
        const got = rows("SELECT SUM(val) OVER wnd AS s, COUNT(*) OVER wnd AS c, AVG(val) OVER wnd AS a " +
                         "FROM v34_mid WINDOW wnd AS (PARTITION BY grp) ORDER BY id LIMIT 100");
        const m = byKey(MID, r => r.grp);
        got.forEach((r, i) => {
          const g = m.get(MID[i].grp);
          expect(r.s, sum(g, VAL), 'sum'); expect(r.c, g.length, 'count'); expectNear(r.a, mean(g, VAL), 1e-9, 'avg');
        });
        return true;
      });
      t('V34D D5 two named windows in one query', () => {
        const got = rows("SELECT SUM(val) OVER w1 AS a, SUM(val) OVER w2 AS b FROM v34_mid " +
                         "WINDOW w1 AS (PARTITION BY grp), w2 AS (PARTITION BY sub) ORDER BY id LIMIT 100");
        const byG = byKey(MID, r => r.grp), byS = byKey(MID, r => r.sub);
        got.forEach((r, i) => {
          expect(r.a, sum(byG.get(MID[i].grp), VAL), 'w1');
          expect(r.b, sum(byS.get(MID[i].sub), VAL), 'w2');
        });
        return true;
      });
      t('V34D D5 FILTER inside a window aggregate', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT SUM(val) FILTER (WHERE val > 18) OVER (PARTITION BY grp) AS s FROM v34_mid ORDER BY id", 's'),
                         MID.map(r => sum(m.get(r.grp).filter(x => x.val > 18), VAL)), 0, 'filter over');
      });
      t('V34D D5 FILTER inside a window count', () => {
        const m = byKey(MID, r => r.grp);
        return expectArr(colOf("SELECT COUNT(*) FILTER (WHERE sub = 'S0') OVER (PARTITION BY grp) AS c FROM v34_mid ORDER BY id", 'c'),
                         MID.map(r => cnt(m.get(r.grp), x => x.sub === 'S0')), 0, 'filter count over');
      });
      val('V34D D5 QUALIFY can reference a window alias',
          "SELECT COUNT(*) FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) AS rn FROM v34_mid QUALIFY rn <= 2) z",
          uniq(MID, r => r.grp) * 2);
      val('V34D D5 QUALIFY on a named window',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WINDOW wnd AS (PARTITION BY grp ORDER BY id) " +
          "QUALIFY ROW_NUMBER() OVER wnd = 1) z", uniq(MID, r => r.grp));

      // ---- D6. ウィンドウと他の句の組合せ ----
      val('V34D D6 a window result can be filtered in an outer query',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY val DESC, id) AS rn FROM v34_mid) z WHERE rn <= 100", 100);
      val('V34D D6 a window result can be grouped in an outer query',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM (SELECT grp, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) AS rn " +
          "FROM v34_mid) z WHERE rn <= 5 GROUP BY grp) y", uniq(MID, r => r.grp));
      val('V34D D6 the top row of each partition through a derived table',
          "SELECT SUM(val) FROM (SELECT val, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY val DESC, id) AS rn FROM v34_mid) z " +
          "WHERE rn = 1",
          (() => { const m = byKey(MID, r => r.grp);
                   return sum([...m.values()], g => g.slice().sort((a, b) => b.val - a.val || a.id - b.id)[0].val); })());
      val('V34D D6 windows over a joined query',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (PARTITION BY c.tier ORDER BY f.id) AS rn " +
          "FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id) z WHERE rn <= 5", TIERS.length * 5);
      val('V34D D6 windows over a CTE',
          "WITH base AS (SELECT id, grp, val FROM v34_mid WHERE val > 5) " +
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) AS rn FROM base) z WHERE rn = 1",
          uniq(MID.filter(r => r.val > 5), r => r.grp));
      val('V34D D6 windows over a UNION ALL',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM " +
          "(SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small) u) z", SMALL.length * 2);
      val('V34D D6 windows after a GROUP BY',
          "SELECT COUNT(*) FROM (SELECT grp, SUM(val) AS s, ROW_NUMBER() OVER (ORDER BY SUM(val) DESC) AS rn " +
          "FROM v34_mid GROUP BY grp) z WHERE rn <= 3", 3);
      t('V34D D6 the ranking of group totals', () => {
        const m = byKey(MID, r => r.grp);
        const want = [...m.entries()].map(e => ({ g: e[0], s: sum(e[1], VAL) }))
                       .sort((a, b) => b.s - a.s || (a.g < b.g ? -1 : 1)).map((e, i) => ({ g: e.g, s: e.s, rn: i + 1 }));
        return expectDeep(rows("SELECT grp, SUM(val) AS s, ROW_NUMBER() OVER (ORDER BY SUM(val) DESC, grp) AS rn " +
                               "FROM v34_mid GROUP BY grp ORDER BY rn"),
                          want.map(e => ({ grp: e.g, s: e.s, rn: e.rn })));
      });
      val('V34D D6 a window with DISTINCT in the outer query',
          "SELECT COUNT(*) FROM (SELECT DISTINCT rn FROM (SELECT NTILE(4) OVER (ORDER BY id) AS rn FROM v34_mid) z) y", 4);
      val('V34D D6 ORDER BY a window column',
          "SELECT rn FROM (SELECT ROW_NUMBER() OVER (ORDER BY val DESC, id) AS rn FROM v34_mid) z ORDER BY rn DESC LIMIT 1",
          MID.length);
      val('V34D D6 a window inside a scalar subquery',
          "SELECT (SELECT MAX(rn) FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v34_small) z)", SMALL.length);
      val('V34D D6 windows over the wide table',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (PARTITION BY c0 % 10 ORDER BY id) AS rn FROM v34_wide) z WHERE rn = 1",
          uniq(WIDE, r => r.c0 % 10));
      t('V34D D6 a running total over the fact table stays consistent', () => {
        const total = one("SELECT MAX(rt) AS m FROM (SELECT SUM(qty) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS rt " +
                          "FROM v34_fact) z");
        return expect(total, sum(FACT, r => r.qty));
      });
      t('V34D D6 the running total per region reaches the region total', () => {
        const m = byKey(FACT, r => r.region);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT region AS r, MAX(rt) AS m FROM (SELECT region, SUM(qty) OVER " +
                               "(PARTITION BY region ORDER BY id ROWS UNBOUNDED PRECEDING) AS rt FROM v34_fact) z " +
                               "GROUP BY region ORDER BY r"),
                          keys.map(k => ({ r: k, m: sum(m.get(k), x => x.qty) })));
      });
      val('V34D D6 a window feeding a HAVING through a derived table',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM (SELECT grp, NTILE(10) OVER (ORDER BY id) AS nt FROM v34_mid) z " +
          "GROUP BY grp HAVING COUNT(*) = 100) y", uniq(MID, r => r.grp));
      val('V34D D6 two levels of windows',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY rn DESC) AS rn2 FROM " +
          "(SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v34_small) z) y", SMALL.length);
      t('V34D D6 the second level reverses the first', () => {
        const got = colOf("SELECT rn2 FROM (SELECT ROW_NUMBER() OVER (ORDER BY rn DESC) AS rn2, rn FROM " +
                          "(SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v34_small) z) y ORDER BY rn", 'rn2');
        return expectArr(got, SMALL.map((_, i) => SMALL.length - i), 0, 'reversed');
      });

      // ============================================================
      // E. CTE とサブクエリ
      //    入れ子の深さ・CTE の本数・再帰の段数・相関の組合せを増やしていく
      // ============================================================

      // ---- E1. 派生表の入れ子を 1 段ずつ深くする ----
      for (let depth = 1; depth <= 25; depth++) {
        let sql = "SELECT id, val FROM v34_mid WHERE id <= 200";
        for (let i = 1; i <= depth; i++) sql = "SELECT id, val FROM (" + sql + ") n" + i + " WHERE id > " + i;
        val('V34E E1 derived tables nested ' + depth + ' deep', "SELECT COUNT(*) FROM (" + sql + ") z", 200 - depth);
        if (depth % 5 === 0) {
          val('V34E E1 derived tables nested ' + depth + ' deep keep SUM(val)', "SELECT SUM(val) FROM (" + sql + ") z",
              sum(MID.filter(r => r.id > depth && r.id <= 200), r => r.val));
        }
      }

      // ---- E2. CTE の本数を増やす ----
      for (let n = 1; n <= 20; n++) {
        const parts = ['c1 AS (SELECT 1 AS k)'];
        for (let i = 2; i <= n; i++) parts.push('c' + i + ' AS (SELECT k + 1 AS k FROM c' + (i - 1) + ')');
        val('V34E E2 a chain of ' + n + ' CTEs', "WITH " + parts.join(', ') + " SELECT k FROM c" + n, n);
      }
      [1, 3, 5, 8, 12, 16, 20, 25, 30, 35, 40].forEach(n => {
        const parts = [], sels = [];
        for (let i = 0; i < n; i++) { parts.push('d' + i + ' AS (SELECT ' + i + ' AS k)'); sels.push('SELECT k FROM d' + i); }
        const body = "(" + sels.join(' UNION ALL ') + ")";
        val('V34E E2 ' + n + ' independent CTEs unioned together',
            "WITH " + parts.join(', ') + " SELECT COUNT(*) FROM " + body + " u", n);
        val('V34E E2 ' + n + ' independent CTEs summed',
            "WITH " + parts.join(', ') + " SELECT SUM(k) FROM " + body + " u", n * (n - 1) / 2);
      });
      val('V34E E2 a CTE used twice in one query',
          "WITH base AS (SELECT id, val FROM v34_mid WHERE val > 20) " +
          "SELECT (SELECT COUNT(*) FROM base) + (SELECT COUNT(*) FROM base)", cnt(MID, r => r.val > 20) * 2);
      val('V34E E2 a CTE joined to itself',
          "WITH base AS (SELECT id, val FROM v34_mid WHERE id <= 100) " +
          "SELECT COUNT(*) FROM base a JOIN base b ON a.val = b.val",
          njoin(MID.filter(r => r.id <= 100), MID.filter(r => r.id <= 100), (x, y) => x.val === y.val));
      val('V34E E2 a CTE feeding a grouped query',
          "WITH base AS (SELECT grp, val FROM v34_mid WHERE val < 20) " +
          "SELECT COUNT(*) FROM (SELECT grp, SUM(val) AS s FROM base GROUP BY grp) z", uniq(MID.filter(r => r.val < 20), r => r.grp));
      val('V34E E2 a CTE over the 5000-row fact table',
          "WITH big AS (SELECT region, qty, cents FROM v34_fact WHERE status = 'paid') SELECT SUM(cents) FROM big",
          sum(FACT.filter(r => r.status === 'paid'), r => r.cents));
      val('V34E E2 two CTEs joined to each other',
          "WITH a AS (SELECT id, val FROM v34_mid WHERE id <= 200), b AS (SELECT id, a AS av FROM v34_small) " +
          "SELECT COUNT(*) FROM a JOIN b ON a.id = b.id", 200);
      val('V34E E2 a CTE referencing an earlier CTE twice',
          "WITH a AS (SELECT 5 AS k), b AS (SELECT k * 2 AS k FROM a), c AS (SELECT (SELECT k FROM a) + (SELECT k FROM b) AS k) " +
          "SELECT k FROM c", 15);
      val('V34E E2 MATERIALIZED is accepted on a CTE',
          "WITH a AS MATERIALIZED (SELECT COUNT(*) AS k FROM v34_mid) SELECT k FROM a", MID.length);
      val('V34E E2 NOT MATERIALIZED is accepted on a CTE',
          "WITH a AS NOT MATERIALIZED (SELECT COUNT(*) AS k FROM v34_mid) SELECT k FROM a", MID.length);
      val('V34E E2 a CTE with an explicit column list',
          "WITH a(x, y) AS (SELECT id, val FROM v34_mid WHERE id <= 10) SELECT SUM(y) FROM a",
          sum(MID.filter(r => r.id <= 10), r => r.val));

      // ---- E3. 再帰 CTE ----
      [10, 50, 100, 200, 400, 499].forEach(n => {
        val('V34E E3 a recursive counter up to ' + n + ' produces the rows',
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < " + n + ") SELECT COUNT(*) FROM r", n);
        val('V34E E3 a recursive counter up to ' + n + ' sums correctly',
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < " + n + ") SELECT SUM(n) FROM r",
            n * (n + 1) / 2);
      });
      val('V34E E3 a recursive counter stepping by three',
          "WITH RECURSIVE r(n) AS (SELECT 0 UNION ALL SELECT n + 3 FROM r WHERE n < 297) SELECT COUNT(*) FROM r", 100);
      val('V34E E3 a recursive counter counting down',
          "WITH RECURSIVE r(n) AS (SELECT 100 UNION ALL SELECT n - 1 FROM r WHERE n > 1) SELECT MIN(n) FROM r", 1);
      val('V34E E3 a recursive doubling sequence',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n * 2 FROM r WHERE n < 1024) SELECT COUNT(*) FROM r", 11);
      val('V34E E3 a recursive doubling sequence reaches its last value',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n * 2 FROM r WHERE n < 1024) SELECT MAX(n) FROM r", 1024);
      val('V34E E3 a recursive running total',
          "WITH RECURSIVE r(n, s) AS (SELECT 1, 1 UNION ALL SELECT n + 1, s + n + 1 FROM r WHERE n < 100) " +
          "SELECT s FROM r WHERE n = 100", 5050);
      val('V34E E3 a recursive Fibonacci sequence',
          "WITH RECURSIVE fib(i, a, b) AS (SELECT 1, 0, 1 UNION ALL SELECT i + 1, b, a + b FROM fib WHERE i < 30) " +
          "SELECT a FROM fib WHERE i = 30", 514229);
      val('V34E E3 a recursive factorial',
          "WITH RECURSIVE f(i, v) AS (SELECT 1, 1 UNION ALL SELECT i + 1, v * (i + 1) FROM f WHERE i < 10) " +
          "SELECT v FROM f WHERE i = 10", 3628800);
      val('V34E E3 a recursive string builder',
          "WITH RECURSIVE s(i, txt) AS (SELECT 1, 'x' UNION ALL SELECT i + 1, txt || 'x' FROM s WHERE i < 50) " +
          "SELECT LENGTH(txt) FROM s WHERE i = 50", 50);
      val('V34E E3 a recursive CTE with an explicit column list',
          "WITH RECURSIVE r(a, b) AS (SELECT 1, 10 UNION ALL SELECT a + 1, b + 10 FROM r WHERE a < 20) SELECT SUM(b) FROM r",
          (() => { let s = 0; for (let i = 0; i < 20; i++) s += 10 + i * 10; return s; })());
      val('V34E E3 a recursive CTE filtered afterwards',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 300) SELECT COUNT(*) FROM r WHERE n % 7 = 0",
          Math.floor(300 / 7));
      val('V34E E3 a recursive CTE grouped afterwards',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 300) " +
          "SELECT COUNT(*) FROM (SELECT n % 10 AS k, COUNT(*) AS c FROM r GROUP BY n % 10) z", 10);
      val('V34E E3 a recursive CTE joined to a table',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) " +
          "SELECT COUNT(*) FROM r JOIN v34_small s ON s.id = r.n", 200);
      val('V34E E3 a recursive CTE joined to a table and summed',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) " +
          "SELECT SUM(s.a) FROM r JOIN v34_small s ON s.id = r.n", sum(SMALL, r => r.a));
      val('V34E E3 UNION in a recursive CTE removes duplicates',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT (n % 5) + 1 FROM r) SELECT COUNT(*) FROM r", 5);
      val('V34E E3 a recursive CTE used inside a bigger query',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 100) " +
          "SELECT COUNT(*) FROM v34_mid m WHERE m.id IN (SELECT n FROM r)", 100);
      val('V34E E3 a recursive CTE next to a plain CTE',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 50), " +
          "base AS (SELECT COUNT(*) AS c FROM v34_small) " +
          "SELECT (SELECT c FROM base) + (SELECT COUNT(*) FROM r)", SMALL.length + 50);
      val('V34E E3 a recursive walk over a parent chain',
          "WITH RECURSIVE up(id, lvl) AS (SELECT 200, 0 UNION ALL SELECT id - 10, lvl + 1 FROM up WHERE id > 10) " +
          "SELECT COUNT(*) FROM up", 20);
      val('V34E E3 the depth of a recursive walk',
          "WITH RECURSIVE up(id, lvl) AS (SELECT 200, 0 UNION ALL SELECT id - 10, lvl + 1 FROM up WHERE id > 10) " +
          "SELECT MAX(lvl) FROM up", 19);
      val('V34E E3 a recursive path accumulator',
          "WITH RECURSIVE p(n, path) AS (SELECT 1, '1' UNION ALL SELECT n + 1, path || '>' || (n + 1) FROM p WHERE n < 10) " +
          "SELECT path FROM p WHERE n = 10", '1>2>3>4>5>6>7>8>9>10');
      t('V34E E3 running past 500 iterations is refused', () => {
        const r = q("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5000) SELECT COUNT(*) FROM r");
        return !!r.error && /500 iterations/i.test(r.error);
      });
      val('V34E E3 a recursive CTE with two seed rows',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT n + 10 FROM r WHERE n < 100) " +
          "SELECT COUNT(*) FROM r", 22);
      val('V34E E3 a recursive CTE ordered and limited',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) " +
          "SELECT n FROM r ORDER BY n DESC LIMIT 1", 200);
      val('V34E E3 a recursive CTE feeding a window function',
          "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 100) " +
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY n) AS rn FROM r) z WHERE rn <= 10", 10);
      val('V34E E3 a recursive CTE with a computed seed',
          "WITH RECURSIVE r(n) AS (SELECT (SELECT COUNT(*) FROM v34_reg) UNION ALL SELECT n + 1 FROM r WHERE n < 20) " +
          "SELECT COUNT(*) FROM r", 20 - REG.length + 1);
      val('V34E E3 two recursive CTEs in one statement',
          "WITH RECURSIVE a(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 30), " +
          "b(n) AS (SELECT 1 UNION ALL SELECT n + 2 FROM b WHERE n < 30) " +
          "SELECT (SELECT COUNT(*) FROM a) + (SELECT COUNT(*) FROM b)", 30 + 16);

      // ---- E4. 相関サブクエリ ----
      t('V34E E4 a correlated COUNT per small row', () => {
        const want = SMALL.map(s => cnt(MID, m => m.val === s.a));
        return expectArr(colOf("SELECT (SELECT COUNT(*) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s ORDER BY s.id", 'k'),
                         want, 0, 'correlated count');
      });
      t('V34E E4 a correlated SUM per small row', () => {
        const want = SMALL.map(s => { const g = MID.filter(m => m.val === s.a); return g.length ? sum(g, m => m.id) : 0; });
        return expectArr(colOf("SELECT (SELECT SUM(m.id) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s ORDER BY s.id", 'k'),
                         want, 0, 'correlated sum');
      });
      t('V34E E4 a correlated MAX per small row', () => {
        const want = SMALL.map(s => { const g = MID.filter(m => m.val === s.a); return g.length ? Math.max.apply(null, g.map(m => m.id)) : null; });
        return expectArr(colOf("SELECT (SELECT MAX(m.id) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s ORDER BY s.id", 'k'),
                         want, 0, 'correlated max');
      });
      t('V34E E4 a correlated MIN per small row', () => {
        const want = SMALL.map(s => { const g = MID.filter(m => m.val === s.a); return g.length ? Math.min.apply(null, g.map(m => m.id)) : null; });
        return expectArr(colOf("SELECT (SELECT MIN(m.id) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s ORDER BY s.id", 'k'),
                         want, 0, 'correlated min');
      });
      t('V34E E4 a correlated count per region', () => {
        const want = REG.map(g => cnt(FACT, f => f.region === g.code));
        return expectArr(colOf("SELECT (SELECT COUNT(*) FROM v34_fact f WHERE f.region = g.code) AS k FROM v34_reg g ORDER BY g.code", 'k'),
                         want, 0, 'per region');
      });
      t('V34E E4 a correlated sum per customer', () => {
        const want = CUST.map(c => sum(FACT.filter(f => f.cust_id === c.id), f => f.qty));
        return expectArr(colOf("SELECT (SELECT SUM(f.qty) FROM v34_fact f WHERE f.cust_id = c.id) AS k FROM v34_cust c ORDER BY c.id", 'k'),
                         want, 0, 'per customer');
      });
      t('V34E E4 two correlated subqueries side by side', () => {
        const got = rows("SELECT (SELECT COUNT(*) FROM v34_fact f WHERE f.region = g.code) AS a, " +
                         "(SELECT COUNT(*) FROM v34_cust c WHERE c.region = g.code) AS b FROM v34_reg g ORDER BY g.code");
        REG.forEach((g, i) => {
          expect(got[i].a, cnt(FACT, f => f.region === g.code), 'fact count');
          expect(got[i].b, cnt(CUST, c => c.region === g.code), 'cust count');
        });
        return true;
      });
      val('V34E E4 a correlated subquery in WHERE compares against the group average',
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val > (SELECT AVG(m2.val) FROM v34_mid m2 WHERE m2.grp = m.grp)",
          (() => { const g = byKey(MID, r => r.grp); return cnt(MID, m => m.val > mean(g.get(m.grp), VAL)); })());
      val('V34E E4 a correlated subquery in WHERE compares against the group maximum',
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val = (SELECT MAX(m2.val) FROM v34_mid m2 WHERE m2.grp = m.grp)",
          (() => { const g = byKey(MID, r => r.grp);
                   return cnt(MID, m => m.val === Math.max.apply(null, g.get(m.grp).map(VAL))); })());
      val('V34E E4 a correlated subquery in WHERE over two keys',
          "SELECT COUNT(*) FROM v34_mid m WHERE m.val >= (SELECT MAX(m2.val) FROM v34_mid m2 WHERE m2.grp = m.grp AND m2.sub = m.sub)",
          (() => { const g = byKey(MID, r => r.grp + '|' + r.sub);
                   return cnt(MID, m => m.val >= Math.max.apply(null, g.get(m.grp + '|' + m.sub).map(VAL))); })());
      val('V34E E4 a correlated subquery over the fact table',
          "SELECT COUNT(*) FROM v34_fact f WHERE f.cents > (SELECT AVG(f2.cents) FROM v34_fact f2 WHERE f2.region = f.region)",
          (() => { const g = byKey(FACT, r => r.region);
                   return cnt(FACT, f => f.cents > mean(g.get(f.region), r => r.cents)); })());
      val('V34E E4 a correlated subquery inside HAVING',
          "SELECT COUNT(*) FROM (SELECT grp FROM v34_mid m GROUP BY grp " +
          "HAVING COUNT(*) > (SELECT COUNT(*) / 20 FROM v34_mid)) z",
          (() => { const g = byKey(MID, r => r.grp); const th = MID.length / 20;
                   return [...g.values()].filter(b => b.length > th).length; })());
      val('V34E E4 an uncorrelated scalar subquery in the select list',
          "SELECT (SELECT COUNT(*) FROM v34_fact) + (SELECT COUNT(*) FROM v34_mid)", FACT.length + MID.length);
      val('V34E E4 a scalar subquery compared in WHERE',
          "SELECT COUNT(*) FROM v34_mid WHERE val > (SELECT AVG(val) FROM v34_mid)",
          cnt(MID, r => r.val > mean(MID, VAL)));
      val('V34E E4 a scalar subquery used as a constant column',
          "SELECT COUNT(*) FROM (SELECT id, (SELECT MAX(val) FROM v34_mid) AS mx FROM v34_mid) z WHERE mx = " +
          Math.max.apply(null, MID.map(VAL)), MID.length);
      val('V34E E4 a correlated EXISTS inside a CASE',
          "SELECT SUM(k) FROM (SELECT CASE WHEN EXISTS (SELECT 1 FROM v34_mid m WHERE m.val = s.a) THEN 1 ELSE 0 END AS k " +
          "FROM v34_small s) z", cnt(SMALL, s => MID.some(m => m.val === s.a)));
      val('V34E E4 a correlated subquery inside COALESCE',
          "SELECT SUM(k) FROM (SELECT COALESCE((SELECT MAX(m.id) FROM v34_mid m WHERE m.val = s.a AND m.id < 0), -1) AS k " +
          "FROM v34_small s) z", -SMALL.length);
      val('V34E E4 a correlated subquery in ORDER BY through a derived table',
          "SELECT k FROM (SELECT (SELECT COUNT(*) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s) z ORDER BY k DESC LIMIT 1",
          Math.max.apply(null, SMALL.map(s => cnt(MID, m => m.val === s.a))));
      val('V34E E4 a subquery in the FROM clause aggregated twice',
          "SELECT SUM(s) FROM (SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp) z", sum(MID, VAL));
      val('V34E E4 a derived table over the fact table joined back',
          "SELECT COUNT(*) FROM (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY region) z " +
          "JOIN v34_reg g ON g.code = z.region", REG.length);
      val('V34E E4 a derived table compared with the outer row',
          "SELECT COUNT(*) FROM v34_reg g JOIN (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY region) z " +
          "ON z.region = g.code WHERE z.n = 625", cnt(REG, g => cnt(FACT, f => f.region === g.code) === 625));
      val('V34E E4 a correlated subquery returning NULL for the empty case',
          "SELECT COUNT(*) FROM (SELECT (SELECT MAX(m.id) FROM v34_mid m WHERE m.val = s.a + 1000) AS k FROM v34_small s) z " +
          "WHERE k IS NULL", SMALL.length);
      val('V34E E4 nesting a scalar subquery inside a derived table',
          "SELECT SUM(k) FROM (SELECT (SELECT COUNT(*) FROM v34_reg) AS k FROM v34_small) z", SMALL.length * REG.length);
      val('V34E E4 a subquery inside an IN list',
          "SELECT COUNT(*) FROM v34_mid WHERE grp IN (SELECT 'G' || (n % 10) FROM GENERATE_SERIES(0, 4) AS g(n))",
          cnt(MID, r => ['G0', 'G1', 'G2', 'G3', 'G4'].indexOf(r.grp) >= 0));
      val('V34E E4 a subquery result reused by a window function',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY n) AS rn FROM " +
          "(SELECT id AS n FROM v34_mid WHERE val > (SELECT AVG(val) FROM v34_mid)) z) y",
          cnt(MID, r => r.val > mean(MID, VAL)));

      // ---- E5. 派生表と VALUES ----
      val('V34E E5 a VALUES list used as a table',
          "SELECT COUNT(*) FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, nm)", 3);
      val('V34E E5 a VALUES list summed',
          "SELECT SUM(id) FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, nm)", 6);
      val('V34E E5 a long VALUES list',
          "SELECT COUNT(*) FROM (VALUES " + Array.from({ length: 100 }, (_, i) => '(' + (i + 1) + ')').join(', ') + ") AS t(n)", 100);
      val('V34E E5 a long VALUES list summed',
          "SELECT SUM(n) FROM (VALUES " + Array.from({ length: 100 }, (_, i) => '(' + (i + 1) + ')').join(', ') + ") AS t(n)", 5050);
      val('V34E E5 a VALUES list joined to a table',
          "SELECT COUNT(*) FROM (VALUES ('R0'), ('R1'), ('R2')) AS t(code) JOIN v34_fact f ON f.region = t.code",
          cnt(FACT, f => ['R0', 'R1', 'R2'].indexOf(f.region) >= 0));
      val('V34E E5 a derived table with an explicit column list',
          "SELECT SUM(y) FROM (SELECT id, val FROM v34_mid WHERE id <= 20) AS t(x, y)",
          sum(MID.filter(r => r.id <= 20), VAL));
      val('V34E E5 a derived table renaming every column',
          "SELECT COUNT(*) FROM (SELECT id, grp, val FROM v34_mid) AS t(a, b, c) WHERE c > 30",
          cnt(MID, r => r.val > 30));
      val('V34E E5 a derived table over a UNION',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small) AS t(x)", SMALL.length * 2);
      val('V34E E5 a derived table over a grouped query joined again',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM v34_mid GROUP BY grp) a " +
          "JOIN (SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp) b ON a.grp = b.grp", uniq(MID, r => r.grp));
      val('V34E E5 three derived tables joined together',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM v34_mid GROUP BY grp) a " +
          "JOIN (SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp) b ON a.grp = b.grp " +
          "JOIN (SELECT grp, MAX(val) AS mx FROM v34_mid GROUP BY grp) c ON b.grp = c.grp", uniq(MID, r => r.grp));
      val('V34E E5 GENERATE_SERIES used as a derived table',
          "SELECT COUNT(*) FROM (SELECT n FROM GENERATE_SERIES(1, 500) AS g(n)) z", 500);
      val('V34E E5 GENERATE_SERIES joined to a table',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 200) AS g(n) JOIN v34_small s ON s.id = g.n", 200);
      val('V34E E5 a derived table filtered on an aggregate column',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM v34_mid GROUP BY grp) z WHERE n = 100",
          [...byKey(MID, r => r.grp).values()].filter(b => b.length === 100).length);
      val('V34E E5 a derived table ordered and limited',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY val DESC, id LIMIT 37) z", 37);
      val('V34E E5 a derived table with DISTINCT inside',
          "SELECT COUNT(*) FROM (SELECT DISTINCT grp, sub FROM v34_mid) z", uniq(MID, r => r.grp + '|' + r.sub));

      // ============================================================
      // F. 集合演算
      // ============================================================

      // ---- F1. UNION ALL の長い連結 ----
      const F_LENGTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60];
      F_LENGTHS.forEach(len => {
        const chain = Array.from({ length: len }, (_, i) => 'SELECT ' + (i + 1) + ' AS v').join(' UNION ALL ');
        val('V34F F1 a UNION ALL chain of ' + len + ' branches counts its rows',
            "SELECT COUNT(*) FROM (" + chain + ") t", len);
        val('V34F F1 a UNION ALL chain of ' + len + ' branches sums its values',
            "SELECT SUM(v) FROM (" + chain + ") t", len * (len + 1) / 2);
      });
      val('V34F F1 a UNION ALL chain of table scans',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small UNION ALL " +
          "SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small) t", SMALL.length * 4);
      val('V34F F1 a UNION ALL of filtered slices covers the table',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE id <= 250 UNION ALL SELECT id FROM v34_mid WHERE id BETWEEN 251 AND 500 " +
          "UNION ALL SELECT id FROM v34_mid WHERE id BETWEEN 501 AND 750 UNION ALL SELECT id FROM v34_mid WHERE id > 750) t",
          MID.length);
      val('V34F F1 a UNION ALL of filtered slices keeps the total',
          "SELECT SUM(val) FROM (SELECT val FROM v34_mid WHERE id <= 500 UNION ALL SELECT val FROM v34_mid WHERE id > 500) t",
          sum(MID, VAL));

      // ---- F2. UNION による重複除去 ----
      val('V34F F2 UNION removes the duplicated rows',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small UNION SELECT id FROM v34_small) t", SMALL.length);
      val('V34F F2 UNION over overlapping ranges',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE id <= 600 UNION SELECT id FROM v34_mid WHERE id > 400) t", MID.length);
      val('V34F F2 UNION of disjoint ranges keeps every row',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE id <= 500 UNION SELECT id FROM v34_mid WHERE id > 500) t", MID.length);
      val('V34F F2 UNION collapses a repeated constant',
          "SELECT COUNT(*) FROM (SELECT 1 AS v UNION SELECT 1 UNION SELECT 1 UNION SELECT 2) t", 2);
      val('V34F F2 UNION over two columns dedupes on the pair',
          "SELECT COUNT(*) FROM (SELECT grp, sub FROM v34_mid UNION SELECT grp, sub FROM v34_mid) t",
          uniq(MID, r => r.grp + '|' + r.sub));
      val('V34F F2 UNION ALL keeps what UNION removes',
          "SELECT COUNT(*) FROM (SELECT grp, sub FROM v34_mid UNION ALL SELECT grp, sub FROM v34_mid) t", MID.length * 2);
      val('V34F F2 UNION of the regions from two tables',
          "SELECT COUNT(*) FROM (SELECT region FROM v34_fact UNION SELECT region FROM v34_cust) t", REG.length);
      val('V34F F2 UNION with a computed column',
          "SELECT COUNT(*) FROM (SELECT val * 2 AS v FROM v34_mid UNION SELECT val * 2 FROM v34_mid) t", uniq(MID, VAL));
      val('V34F F2 a long UNION chain still dedupes',
          "SELECT COUNT(*) FROM (" + Array.from({ length: 20 }, () => 'SELECT 7 AS v').join(' UNION ') + ") t", 1);
      val('V34F F2 UNION of two grouped queries',
          "SELECT COUNT(*) FROM (SELECT grp FROM v34_mid GROUP BY grp UNION SELECT grp FROM v34_mid GROUP BY grp) t",
          uniq(MID, r => r.grp));

      // ---- F3. INTERSECT / EXCEPT / MINUS ----
      const EVEN_IDS = MID.filter(r => r.id % 2 === 0).length;
      val('V34F F3 INTERSECT keeps the shared rows',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT SELECT id FROM v34_mid WHERE id % 2 = 0) t", EVEN_IDS);
      val('V34F F3 INTERSECT of disjoint sets is empty',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE id <= 500 INTERSECT SELECT id FROM v34_mid WHERE id > 500) t", 0);
      val('V34F F3 INTERSECT ALL keeps the shared rows',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT ALL SELECT id FROM v34_mid WHERE id % 3 = 0) t",
          cnt(MID, r => r.id % 3 === 0));
      val('V34F F3 EXCEPT removes the second set',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid EXCEPT SELECT id FROM v34_mid WHERE id % 2 = 0) t",
          MID.length - EVEN_IDS);
      val('V34F F3 EXCEPT of a set with itself is empty',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid EXCEPT SELECT id FROM v34_mid) t", 0);
      val('V34F F3 MINUS is a synonym for EXCEPT',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid MINUS SELECT id FROM v34_mid WHERE id % 2 = 0) t",
          MID.length - EVEN_IDS);
      val('V34F F3 EXCEPT over two columns',
          "SELECT COUNT(*) FROM (SELECT grp, sub FROM v34_mid EXCEPT SELECT grp, sub FROM v34_mid WHERE sub = 'S0') t",
          uniq(MID, r => r.grp + '|' + r.sub) - uniq(MID.filter(r => r.sub === 'S0'), r => r.grp + '|' + r.sub));
      val('V34F F3 INTERSECT over two columns',
          "SELECT COUNT(*) FROM (SELECT grp, sub FROM v34_mid INTERSECT SELECT grp, sub FROM v34_mid WHERE sub = 'S0') t",
          uniq(MID.filter(r => r.sub === 'S0'), r => r.grp + '|' + r.sub));
      val('V34F F3 INTERSECT and EXCEPT partition the rows',
          "SELECT (SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT SELECT id FROM v34_mid WHERE id % 2 = 0) a) + " +
          "(SELECT COUNT(*) FROM (SELECT id FROM v34_mid EXCEPT SELECT id FROM v34_mid WHERE id % 2 = 0) b)", MID.length);
      val('V34F F3 EXCEPT between two tables',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid EXCEPT SELECT id FROM v34_small) t", MID.length - SMALL.length);
      val('V34F F3 INTERSECT between two tables',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT SELECT id FROM v34_small) t", SMALL.length);
      val('V34F F3 EXCEPT the other way round is empty',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small EXCEPT SELECT id FROM v34_mid) t", 0);
      val('V34F F3 a chain of two EXCEPTs',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid EXCEPT SELECT id FROM v34_mid WHERE id % 2 = 0 " +
          "EXCEPT SELECT id FROM v34_mid WHERE id % 3 = 0) t", cnt(MID, r => r.id % 2 !== 0 && r.id % 3 !== 0));
      val('V34F F3 a chain of two INTERSECTs',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT SELECT id FROM v34_mid WHERE id % 2 = 0 " +
          "INTERSECT SELECT id FROM v34_mid WHERE id % 3 = 0) t", cnt(MID, r => r.id % 6 === 0));
      val('V34F F3 EXCEPT over the fact table by region',
          "SELECT COUNT(*) FROM (SELECT region FROM v34_fact EXCEPT SELECT code FROM v34_reg WHERE zone = 'west') t",
          REG.filter(g => g.zone !== 'west').length);
      val('V34F F3 INTERSECT over the fact table by region',
          "SELECT COUNT(*) FROM (SELECT region FROM v34_fact INTERSECT SELECT code FROM v34_reg WHERE zone = 'east') t",
          REG.filter(g => g.zone === 'east').length);

      // ---- F4. 括弧・混在・後段の句 ----
      // 括弧付きの集合演算は文の最上位で書く（FROM の派生表の中には置けない）
      t('V34F F4 UNION ALL then INTERSECT with parentheses', () =>
        expect(rows("(SELECT id FROM v34_mid WHERE id <= 300 UNION ALL SELECT id FROM v34_mid WHERE id > 700) " +
                    "INTERSECT (SELECT id FROM v34_mid WHERE id % 2 = 0)").length,
               cnt(MID, r => (r.id <= 300 || r.id > 700) && r.id % 2 === 0)));
      t('V34F F4 EXCEPT applied to a UNION', () =>
        expect(rows("(SELECT id FROM v34_mid WHERE id <= 400 UNION SELECT id FROM v34_mid WHERE id > 900) " +
                    "EXCEPT (SELECT id FROM v34_mid WHERE id % 5 = 0)").length,
               cnt(MID, r => (r.id <= 400 || r.id > 900) && r.id % 5 !== 0)));
      val('V34F F4 a set operation nested through a derived table',
          "SELECT COUNT(*) FROM (SELECT id FROM (SELECT id FROM v34_mid WHERE id <= 300 UNION ALL " +
          "SELECT id FROM v34_mid WHERE id > 700) u INTERSECT SELECT id FROM v34_mid WHERE id % 2 = 0) t",
          cnt(MID, r => (r.id <= 300 || r.id > 700) && r.id % 2 === 0));
      val('V34F F4 ORDER BY over a set operation',
          "SELECT v FROM (SELECT 3 AS v UNION SELECT 1 UNION SELECT 2) t ORDER BY v LIMIT 1", 1);
      val('V34F F4 ORDER BY DESC over a set operation',
          "SELECT v FROM (SELECT 3 AS v UNION SELECT 1 UNION SELECT 2) t ORDER BY v DESC LIMIT 1", 3);
      val('V34F F4 LIMIT over a UNION ALL chain',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small LIMIT 250) t", 250);
      val('V34F F4 a set operation feeding a GROUP BY',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM (SELECT grp FROM v34_mid UNION ALL SELECT grp FROM v34_mid) u " +
          "GROUP BY grp) z", uniq(MID, r => r.grp));
      val('V34F F4 a set operation feeding a window function',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM " +
          "(SELECT id FROM v34_small UNION ALL SELECT id + 1000 FROM v34_small) u) z", SMALL.length * 2);
      val('V34F F4 a set operation inside a CTE',
          "WITH u AS (SELECT id FROM v34_small UNION ALL SELECT id FROM v34_small) SELECT COUNT(*) FROM u", SMALL.length * 2);
      val('V34F F4 a set operation joined to a table',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_small UNION SELECT id FROM v34_small) u JOIN v34_mid m ON m.id = u.id",
          SMALL.length);
      val('V34F F4 a set operation of two grouped queries',
          "SELECT COUNT(*) FROM (SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp UNION ALL " +
          "SELECT grp, SUM(val) FROM v34_mid GROUP BY grp) t", uniq(MID, r => r.grp) * 2);
      val('V34F F4 a set operation of two joined queries',
          "SELECT COUNT(*) FROM (SELECT f.id FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'gold' " +
          "UNION ALL SELECT f.id FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'silver') t",
          cnt(WIDEJOIN, x => x.c.tier === 'gold') + cnt(WIDEJOIN, x => x.c.tier === 'silver'));
      val('V34F F4 the set operation branches must agree on column count',
          "SELECT COUNT(*) FROM (SELECT id, val FROM v34_mid UNION ALL SELECT id, a FROM v34_small) t",
          MID.length + SMALL.length);
      t('V34F F4 mismatched column counts are refused', () => {
        const r = q("SELECT id, val FROM v34_mid UNION SELECT id FROM v34_small");
        return !!r.error;
      });
      val('V34F F4 a set operation over 5000 rows',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_fact UNION ALL SELECT id FROM v34_fact) t", FACT.length * 2);
      val('V34F F4 UNION over 5000 rows dedupes back down',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_fact UNION SELECT id FROM v34_fact) t", FACT.length);
      val('V34F F4 a set operation with an outer WHERE',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid UNION ALL SELECT id FROM v34_small) t WHERE id <= 100", 200);

      // ============================================================
      // G. 巨大な式・リスト・列
      //    IN リスト・CASE の分岐・演算の連鎖・列数を極端に増やす
      // ============================================================

      // ---- G1. 巨大な IN リスト ----
      [10, 25, 50, 75, 100, 250, 400, 500, 750, 1000, 1500, 2000].forEach(n => {
        const list = Array.from({ length: n }, (_, i) => i + 1).join(', ');
        val('V34G G1 an IN list of ' + n + ' numbers over the fact table',
            "SELECT COUNT(*) FROM v34_fact WHERE id IN (" + list + ")", Math.min(n, FACT.length));
        val('V34G G1 an IN list of ' + n + ' numbers summed',
            "SELECT SUM(qty) FROM v34_fact WHERE id IN (" + list + ")",
            sum(FACT.filter(r => r.id <= n), r => r.qty));
        val('V34G G1 a NOT IN list of ' + n + ' numbers',
            "SELECT COUNT(*) FROM v34_fact WHERE id NOT IN (" + list + ")", FACT.length - Math.min(n, FACT.length));
      });
      val('V34G G1 an IN list of 300 strings',
          "SELECT COUNT(*) FROM v34_fact WHERE txt IN (" +
          Array.from({ length: 300 }, (_, i) => "'ord-" + String(i + 1).padStart(5, '0') + "'").join(', ') + ")", 300);
      val('V34G G1 an IN list mixing hits and misses',
          "SELECT COUNT(*) FROM v34_fact WHERE id IN (" +
          Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? i + 1 : 100000 + i)).join(', ') + ")", 250);
      val('V34G G1 a row constructor IN list of 200 pairs',
          "SELECT COUNT(*) FROM v34_fact WHERE (region, qty) IN (" +
          Array.from({ length: 200 }, (_, i) => "('R" + (i % 8) + "', " + (1 + (i % 9)) + ")").join(', ') + ")",
          (() => { const set = new Set();
                   for (let i = 0; i < 200; i++) set.add('R' + (i % 8) + '|' + (1 + (i % 9)));
                   return cnt(FACT, r => set.has(r.region + '|' + r.qty)); })());
      val('V34G G1 an IN list against an indexed-looking key',
          "SELECT SUM(cents) FROM v34_fact WHERE cust_id IN (" +
          Array.from({ length: 100 }, (_, i) => i + 1).join(', ') + ")",
          sum(FACT.filter(r => r.cust_id <= 100), r => r.cents));

      // ---- G2. 分岐の多い CASE ----
      [5, 10, 25, 50, 100, 150, 200].forEach(n => {
        const branches = Array.from({ length: n }, (_, i) => "WHEN " + i + " THEN " + (i * 2)).join(' ');
        val('V34G G2 a CASE with ' + n + ' branches over the mid table',
            "SELECT SUM(CASE val " + branches + " ELSE -1 END) FROM v34_mid",
            sum(MID, r => r.val < n ? r.val * 2 : -1));
        const searched = Array.from({ length: n }, (_, i) => "WHEN val = " + i + " THEN " + (i * 3)).join(' ');
        val('V34G G2 a searched CASE with ' + n + ' branches over the mid table',
            "SELECT SUM(CASE " + searched + " ELSE 0 END) FROM v34_mid",
            sum(MID, r => r.val < n ? r.val * 3 : 0));
      });
      val('V34G G2 nested CASE expressions five deep',
          "SELECT SUM(CASE WHEN val < 10 THEN CASE WHEN val < 5 THEN CASE WHEN val < 3 THEN " +
          "CASE WHEN val < 2 THEN CASE WHEN val < 1 THEN 0 ELSE 1 END ELSE 2 END ELSE 3 END ELSE 4 END ELSE 5 END) FROM v34_mid",
          sum(MID, r => r.val < 1 ? 0 : r.val < 2 ? 1 : r.val < 3 ? 2 : r.val < 5 ? 3 : r.val < 10 ? 4 : 5));
      val('V34G G2 a CASE over a joined query',
          "SELECT SUM(CASE c.tier WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END) " +
          "FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id",
          sum(WIDEJOIN, x => x.c.tier === 'gold' ? 3 : x.c.tier === 'silver' ? 2 : 1));
      val('V34G G2 a CASE used as a GROUP BY key',
          "SELECT COUNT(*) FROM (SELECT CASE WHEN val < 12 THEN 'lo' WHEN val < 25 THEN 'mid' ELSE 'hi' END AS b, COUNT(*) AS n " +
          "FROM v34_mid GROUP BY CASE WHEN val < 12 THEN 'lo' WHEN val < 25 THEN 'mid' ELSE 'hi' END) z", 3);
      val('V34G G2 a CASE used inside an aggregate',
          "SELECT SUM(CASE WHEN status = 'paid' THEN cents ELSE 0 END) FROM v34_fact",
          sum(FACT, r => r.status === 'paid' ? r.cents : 0));
      val('V34G G2 a CASE without an ELSE yields NULL',
          "SELECT COUNT(*) FROM v34_mid WHERE (CASE WHEN val > 1000 THEN 1 END) IS NULL", MID.length);
      val('V34G G2 DECODE behaves like a simple CASE',
          "SELECT SUM(DECODE(sub, 'S0', 1, 'S1', 2, 'S2', 3, 0)) FROM v34_mid",
          sum(MID, r => r.sub === 'S0' ? 1 : r.sub === 'S1' ? 2 : r.sub === 'S2' ? 3 : 0));
      val('V34G G2 IIF as a two-way CASE',
          "SELECT SUM(IIF(val >= 18, 1, 0)) FROM v34_mid", cnt(MID, r => r.val >= 18));

      // ---- G3. 長い演算・連結の連鎖 ----
      [10, 50, 100, 200, 300, 500].forEach(n => {
        val('V34G G3 adding ' + n + ' literals together',
            "SELECT " + Array.from({ length: n }, (_, i) => i + 1).join(' + ') + " AS s", n * (n + 1) / 2);
      });
      [10, 50, 100, 200].forEach(n => {
        val('V34G G3 alternating plus and minus over ' + n + ' terms',
            "SELECT " + Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '+ ' : '- ') + (i + 1)).join(' ').replace(/^\+ /, '') + " AS s",
            (() => { let s = 0; for (let i = 0; i < n; i++) s += (i % 2 === 0 ? 1 : -1) * (i + 1); return s; })());
      });
      [10, 50, 100, 200].forEach(n => {
        val('V34G G3 concatenating ' + n + ' literals',
            "SELECT LENGTH(" + Array.from({ length: n }, (_, i) => "'" + (i % 10) + "'").join(' || ') + ") AS s", n);
      });
      val('V34G G3 a long chain applied per row',
          "SELECT SUM(val + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10) FROM v34_mid", sum(MID, r => r.val + 55));
      val('V34G G3 a long multiplication chain',
          "SELECT 2 * 2 * 2 * 2 * 2 * 2 * 2 * 2 * 2 * 2 AS s", 1024);
      val('V34G G3 a long chain with parentheses',
          "SELECT ((((((((1 + 2) * 3) - 4) * 5) + 6) * 7) - 8) * 9) AS s", ((((((((1 + 2) * 3) - 4) * 5) + 6) * 7) - 8) * 9));
      val('V34G G3 concatenating many columns of one row',
          "SELECT LENGTH(grp || sub || txt || grp || sub || txt || grp || sub || txt) FROM v34_mid WHERE id = 1",
          (MID[0].grp + MID[0].sub + MID[0].txt).repeat(3).length);
      val('V34G G3 a long boolean chain in the select list',
          "SELECT COUNT(*) FROM v34_mid WHERE (val > 0 OR val = 0) AND (val < 100 OR val = 100) AND " +
          "(id > 0) AND (id <= 1000) AND (grp IS NOT NULL) AND (sub IS NOT NULL) AND (txt IS NOT NULL)", MID.length);
      val('V34G G3 a modulo chain',
          "SELECT SUM(((val * 7) % 13 + (id * 3) % 11) % 17) FROM v34_mid",
          sum(MID, r => (((r.val * 7) % 13) + ((r.id * 3) % 11)) % 17));
      val('V34G G3 arithmetic mixing several columns',
          "SELECT SUM(qty * cents - prod_id * 100 + cust_id) FROM v34_fact",
          sum(FACT, r => r.qty * r.cents - r.prod_id * 100 + r.cust_id));
      val('V34G G3 a long ROUND chain over floats',
          "SELECT ROUND(SUM(ROUND(price * 2, 2)), 2) FROM v34_fact",
          Math.round(sum(FACT, r => Math.round(r.price * 2 * 100) / 100) * 100) / 100);

      // ---- G4. 関数の深い入れ子 ----
      [5, 10, 20, 40].forEach(n => {
        let e = '7';
        for (let i = 0; i < n; i++) e = 'ABS(' + e + ')';
        val('V34G G4 ABS nested ' + n + ' deep', "SELECT " + e + " AS v", 7);
      });
      [5, 10, 20].forEach(n => {
        let e = "'x'";
        for (let i = 0; i < n; i++) e = 'UPPER(LOWER(' + e + '))';
        val('V34G G4 UPPER over LOWER nested ' + n + ' deep', "SELECT " + e + " AS v", 'X');
      });
      [5, 10, 20].forEach(n => {
        let e = '1';
        for (let i = 0; i < n; i++) e = 'COALESCE(NULL, ' + e + ')';
        val('V34G G4 COALESCE nested ' + n + ' deep', "SELECT " + e + " AS v", 1);
      });
      val('V34G G4 nested string functions over a column',
          "SELECT SUM(LENGTH(TRIM(UPPER(LOWER(SUBSTR(txt || txt, 1, 4)))))) FROM v34_mid",
          sum(MID, r => (r.txt + r.txt).substr(0, 4).length));
      val('V34G G4 nested numeric functions over a column',
          "SELECT SUM(ABS(ROUND(FLOOR(val * 1.0) - CEIL(val * 1.0)))) FROM v34_mid", 0);
      val('V34G G4 nested conditional functions',
          "SELECT SUM(COALESCE(NULLIF(val, 0), 100)) FROM v34_mid", sum(MID, r => r.val === 0 ? 100 : r.val));
      val('V34G G4 nested aggregate inside a scalar function',
          "SELECT ROUND(AVG(val), 4) FROM v34_mid", Math.round(mean(MID, VAL) * 10000) / 10000);
      val('V34G G4 two aggregates inside one expression',
          "SELECT ROUND(SUM(cents) * 1.0 / COUNT(*), 6) FROM v34_fact",
          Math.round(sum(FACT, r => r.cents) / FACT.length * 1e6) / 1e6);
      val('V34G G4 an aggregate divided by another aggregate per group',
          "SELECT COUNT(*) FROM (SELECT region, SUM(cents) * 1.0 / SUM(qty) AS r FROM v34_fact GROUP BY region) z", REG.length);

      // ---- G5. 列数の多い問い合わせ ----
      const W_ALL = Array.from({ length: 80 }, (_, i) => 'c' + i);
      t('V34G G5 summing all 80 columns of the wide table', () => {
        const got = rows("SELECT " + W_ALL.map(c => 'SUM(' + c + ') AS s_' + c).join(', ') + " FROM v34_wide")[0];
        W_ALL.forEach(c => expect(got['s_' + c], sum(WIDE, r => r[c]), c));
        return true;
      });
      t('V34G G5 selecting all 81 columns of one row', () => {
        const got = rows("SELECT * FROM v34_wide WHERE id = 7")[0];
        expect(Object.keys(got).length, 81, 'column count');
        W_ALL.forEach(c => expect(got[c], WIDE[6][c], c));
        return true;
      });
      t('V34G G5 doubling all 80 columns', () => {
        const got = rows("SELECT " + W_ALL.map(c => c + ' * 2 AS d_' + c).join(', ') + " FROM v34_wide WHERE id = 3")[0];
        W_ALL.forEach(c => expect(got['d_' + c], WIDE[2][c] * 2, c));
        return true;
      });
      val('V34G G5 EXCLUDE drops the named columns',
          "SELECT COUNT(*) FROM (SELECT * EXCLUDE (c0, c1, c2) FROM v34_wide WHERE id = 1) z", 1);
      t('V34G G5 EXCLUDE leaves the other columns in place', () => {
        const got = rows("SELECT * EXCLUDE (c0, c1, c2) FROM v34_wide WHERE id = 1")[0];
        return expect(Object.keys(got).length, 78);
      });
      t('V34G G5 REPLACE rewrites one column and keeps the rest', () => {
        const got = rows("SELECT * REPLACE (c0 * 10 AS c0) FROM v34_wide WHERE id = 5")[0];
        expect(Object.keys(got).length, 81, 'column count');
        expect(got.c0, WIDE[4].c0 * 10, 'c0');
        return expect(got.c1, WIDE[4].c1, 'c1');
      });
      val('V34G G5 grouping by ten columns',
          "SELECT COUNT(*) FROM (SELECT " + W_ALL.slice(0, 10).join(', ') + ", COUNT(*) AS n FROM v34_wide GROUP BY " +
          W_ALL.slice(0, 10).join(', ') + ") z", uniq(WIDE, r => W_ALL.slice(0, 10).map(c => r[c]).join('|')));
      val('V34G G5 grouping by twenty columns',
          "SELECT COUNT(*) FROM (SELECT " + W_ALL.slice(0, 20).join(', ') + ", COUNT(*) AS n FROM v34_wide GROUP BY " +
          W_ALL.slice(0, 20).join(', ') + ") z", uniq(WIDE, r => W_ALL.slice(0, 20).map(c => r[c]).join('|')));
      val('V34G G5 ordering by ten columns',
          "SELECT id FROM v34_wide ORDER BY " + W_ALL.slice(0, 10).map(c => c + ' DESC').join(', ') + ", id LIMIT 1",
          (() => WIDE.slice().sort((a, b) => {
            for (const c of W_ALL.slice(0, 10)) { const d = b[c] - a[c]; if (d) return d; }
            return a.id - b.id;
          })[0].id)());
      val('V34G G5 a WHERE clause naming forty columns',
          "SELECT COUNT(*) FROM v34_wide WHERE " + W_ALL.slice(0, 40).map(c => c + ' >= 0').join(' AND '), WIDE.length);
      val('V34G G5 a WHERE clause with forty OR terms',
          "SELECT COUNT(*) FROM v34_wide WHERE " + W_ALL.slice(0, 40).map(c => c + ' = 999').join(' OR '),
          cnt(WIDE, r => W_ALL.slice(0, 40).some(c => r[c] === 999)));
      val('V34G G5 a derived table carrying all 80 columns',
          "SELECT COUNT(*) FROM (SELECT " + W_ALL.join(', ') + " FROM v34_wide) z", WIDE.length);
      val('V34G G5 a UNION ALL of two wide selects',
          "SELECT COUNT(*) FROM (SELECT " + W_ALL.join(', ') + " FROM v34_wide UNION ALL SELECT " + W_ALL.join(', ') +
          " FROM v34_wide) z", WIDE.length * 2);
      val('V34G G5 DISTINCT over twenty wide columns',
          "SELECT COUNT(*) FROM (SELECT DISTINCT " + W_ALL.slice(0, 20).join(', ') + " FROM v34_wide) z",
          uniq(WIDE, r => W_ALL.slice(0, 20).map(c => r[c]).join('|')));
      val('V34G G5 adding forty columns together',
          "SELECT SUM(" + W_ALL.slice(0, 40).join(' + ') + ") FROM v34_wide",
          sum(WIDE, r => W_ALL.slice(0, 40).reduce((s, c) => s + r[c], 0)));
      val('V34G G5 GREATEST over ten wide columns',
          "SELECT SUM(GREATEST(" + W_ALL.slice(0, 10).join(', ') + ")) FROM v34_wide",
          sum(WIDE, r => Math.max.apply(null, W_ALL.slice(0, 10).map(c => r[c]))));
      val('V34G G5 LEAST over ten wide columns',
          "SELECT SUM(LEAST(" + W_ALL.slice(0, 10).join(', ') + ")) FROM v34_wide",
          sum(WIDE, r => Math.min.apply(null, W_ALL.slice(0, 10).map(c => r[c]))));
      val('V34G G5 a wide table joined to the small table',
          "SELECT COUNT(*) FROM v34_wide w JOIN v34_small s ON s.id = w.id", Math.min(WIDE.length, SMALL.length));
      val('V34G G5 a window function over the wide table',
          "SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (ORDER BY c0, id) AS rn FROM v34_wide) z", WIDE.length);

      // ---- G6. 引数の多い関数 ----
      [10, 50, 100, 200].forEach(n => {
        const args = Array.from({ length: n }, () => 'NULL').join(', ');
        val('V34G G6 COALESCE with ' + n + ' NULLs and a value', "SELECT COALESCE(" + args + ", 42) AS v", 42);
      });
      [10, 50, 100].forEach(n => {
        val('V34G G6 GREATEST over ' + n + ' numbers',
            "SELECT GREATEST(" + Array.from({ length: n }, (_, i) => i + 1).join(', ') + ") AS v", n);
        val('V34G G6 LEAST over ' + n + ' numbers',
            "SELECT LEAST(" + Array.from({ length: n }, (_, i) => i + 1).join(', ') + ") AS v", 1);
      });
      [10, 50, 100].forEach(n => {
        val('V34G G6 CONCAT of ' + n + ' strings',
            "SELECT LENGTH(CONCAT(" + Array.from({ length: n }, (_, i) => "'" + (i % 10) + "'").join(', ') + ")) AS v", n);
      });
      val('V34G G6 CONCAT_WS with many parts',
          "SELECT LENGTH(CONCAT_WS('-', " + Array.from({ length: 20 }, () => "'ab'").join(', ') + ")) AS v", 20 * 2 + 19);
      val('V34G G6 an ARRAY constructor with 100 elements',
          "SELECT ARRAY_LENGTH(ARRAY[" + Array.from({ length: 100 }, (_, i) => i).join(', ') + "]) AS v", 100);
      val('V34G G6 = ANY over a 100-element array',
          "SELECT COUNT(*) FROM v34_mid WHERE val = ANY(ARRAY[" + Array.from({ length: 100 }, (_, i) => i).join(', ') + "])",
          MID.length);
      val('V34G G6 a JSON object with many keys',
          "SELECT JSON_VALID(JSON_OBJECT(" +
          Array.from({ length: 30 }, (_, i) => "'k" + i + "', " + i).join(', ') + ")) AS v", 1);
      val('V34G G6 a JSON array with many elements',
          "SELECT JSON_LENGTH(JSON_ARRAY(" + Array.from({ length: 50 }, (_, i) => i).join(', ') + ")) AS v", 50);

      // ---- G7. 長い WHERE 節 ----
      [10, 25, 50, 100].forEach(n => {
        val('V34G G7 a WHERE clause with ' + n + ' AND terms',
            "SELECT COUNT(*) FROM v34_mid WHERE " + Array.from({ length: n }, (_, i) => 'id > ' + i).join(' AND '),
            cnt(MID, r => r.id > n - 1));
        val('V34G G7 a WHERE clause with ' + n + ' OR terms',
            "SELECT COUNT(*) FROM v34_mid WHERE " + Array.from({ length: n }, (_, i) => 'id = ' + (i + 1)).join(' OR '), n);
      });
      val('V34G G7 alternating AND and OR groups',
          "SELECT COUNT(*) FROM v34_mid WHERE " +
          Array.from({ length: 20 }, (_, i) => '(id = ' + (i + 1) + ' OR id = ' + (i + 501) + ')').join(' OR '), 40);
      val('V34G G7 a long NOT chain',
          "SELECT COUNT(*) FROM v34_mid WHERE NOT (NOT (NOT (NOT (val >= 0))))", MID.length);
      val('V34G G7 a WHERE clause combining every predicate kind',
          "SELECT COUNT(*) FROM v34_fact WHERE id BETWEEN 1 AND 4000 AND region IN ('R0', 'R1', 'R2') " +
          "AND status <> 'cancelled' AND txt LIKE 'ord-%' AND nv IS NOT NULL AND qty > 2 AND cents < 30000",
          cnt(FACT, r => r.id >= 1 && r.id <= 4000 && ['R0', 'R1', 'R2'].indexOf(r.region) >= 0 &&
                         r.status !== 'cancelled' && r.nv !== null && r.qty > 2 && r.cents < 30000));
      val('V34G G7 a long BETWEEN chain',
          "SELECT COUNT(*) FROM v34_mid WHERE " +
          Array.from({ length: 10 }, (_, i) => 'val BETWEEN ' + (i) + ' AND ' + (36 - i)).join(' AND '),
          cnt(MID, r => r.val >= 9 && r.val <= 27));
      val('V34G G7 many LIKE terms combined with OR',
          "SELECT COUNT(*) FROM v34_fact WHERE " +
          Array.from({ length: 10 }, (_, i) => "txt LIKE 'ord-0000" + i + "'").join(' OR '), 9);

      // ============================================================
      // H. 大量行の DML
      //    作業表を毎回組み直してから流すので、どの順に走らせても同じ答えになる
      // ============================================================
      const run = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r; };
      // 1000 行の作業表（v34_mid の写し）
      const buildWM = () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT id, grp, sub, val, nval FROM v34_mid");
      };
      // 5000 行の作業表（v34_fact の写し）
      const buildWF = () => {
        q("DROP TABLE IF EXISTS v34_wf");
        run("CREATE TABLE v34_wf AS SELECT id, cust_id, prod_id, region, qty, cents, status FROM v34_fact");
      };
      const nWM = () => one("SELECT COUNT(*) FROM v34_wm");
      const sWM = () => one("SELECT SUM(val) FROM v34_wm");

      // ---- H1. まとまった行の投入 ----
      t('V34H H1 CREATE TABLE AS copies every row', () => { buildWM(); return expect(nWM(), MID.length); });
      t('V34H H1 CREATE TABLE AS copies the values', () => { buildWM(); return expect(sWM(), sum(MID, VAL)); });
      t('V34H H1 CREATE TABLE AS copies the 5000-row table', () => {
        buildWF();
        return expect(one("SELECT COUNT(*) FROM v34_wf"), FACT.length);
      });
      t('V34H H1 CREATE TABLE AS keeps the 5000-row totals', () => {
        buildWF();
        return expect(one("SELECT SUM(cents) FROM v34_wf"), sum(FACT, r => r.cents));
      });
      t('V34H H1 CREATE TABLE AS with a WHERE clause', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT id, val FROM v34_mid WHERE val > 20");
        return expect(nWM(), cnt(MID, r => r.val > 20));
      });
      t('V34H H1 CREATE TABLE AS with a GROUP BY', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT grp, COUNT(*) AS n, SUM(val) AS s FROM v34_mid GROUP BY grp");
        return expect(nWM(), uniq(MID, r => r.grp));
      });
      t('V34H H1 CREATE TABLE AS with a GROUP BY keeps the totals', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp");
        return expect(one("SELECT SUM(s) FROM v34_wm"), sum(MID, VAL));
      });
      t('V34H H1 CREATE TABLE AS over a four-way join', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT f.id, c.tier, p.cat, g.zone, f.cents " + FOUR_WAY);
        return expect(nWM(), FACT.length);
      });
      t('V34H H1 CREATE TABLE AS over a join keeps the sums', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT f.id, c.tier, f.cents " + FOUR_WAY);
        return expect(one("SELECT SUM(cents) FROM v34_wm"), sum(FACT, r => r.cents));
      });
      t('V34H H1 CREATE TABLE AS over a derived table', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT id, val FROM (SELECT id, val FROM v34_mid WHERE id % 3 = 0) base");
        return expect(nWM(), cnt(MID, r => r.id % 3 === 0));
      });
      t('V34H H1 CREATE TABLE AS over a UNION ALL', () => {
        q("DROP TABLE IF EXISTS v34_wm");
        run("CREATE TABLE v34_wm AS SELECT id FROM v34_small UNION ALL SELECT id + 1000 FROM v34_small");
        return expect(nWM(), SMALL.length * 2);
      });
      t('V34H H1 INSERT SELECT appends the same rows again', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, sub, val, nval) SELECT id + 10000, grp, sub, val, nval FROM v34_mid");
        return expect(nWM(), MID.length * 2);
      });
      t('V34H H1 INSERT SELECT doubles the total', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, sub, val, nval) SELECT id + 10000, grp, sub, val, nval FROM v34_mid");
        return expect(sWM(), sum(MID, VAL) * 2);
      });
      t('V34H H1 INSERT SELECT with a filter', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, val) SELECT id + 10000, val FROM v34_mid WHERE val > 30");
        return expect(nWM(), MID.length + cnt(MID, r => r.val > 30));
      });
      t('V34H H1 INSERT SELECT of a grouped result', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, val) SELECT 20000 + rn AS id, grp, s FROM " +
            "(SELECT grp, SUM(val) AS s, ROW_NUMBER() OVER (ORDER BY grp) AS rn FROM v34_mid GROUP BY grp) z");
        return expect(nWM(), MID.length + uniq(MID, r => r.grp)) &&
               expect(sWM(), sum(MID, VAL) * 2);
      });
      t('V34H H1 INSERT SELECT from GENERATE_SERIES', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, val) SELECT 30000 + n, 'GS', n % 50 FROM GENERATE_SERIES(1, 2000) AS g(n)");
        return expect(nWM(), MID.length + 2000);
      });
      t('V34H H1 INSERT SELECT from GENERATE_SERIES sums correctly', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, val) SELECT 30000 + n, 'GS', n % 50 FROM GENERATE_SERIES(1, 2000) AS g(n)");
        let extra = 0;
        for (let n = 1; n <= 2000; n++) extra += n % 50;
        return expect(sWM(), sum(MID, VAL) + extra);
      });
      t('V34H H1 a 200-row VALUES list', () => {
        buildWM();
        const vals = Array.from({ length: 200 }, (_, i) => "(" + (40000 + i) + ", 'GV', 'S0', " + i + ")").join(', ');
        run("INSERT INTO v34_wm (id, grp, sub, val) VALUES " + vals);
        return expect(nWM(), MID.length + 200);
      });
      t('V34H H1 a 200-row VALUES list sums correctly', () => {
        buildWM();
        const vals = Array.from({ length: 200 }, (_, i) => "(" + (40000 + i) + ", 'GV', 'S0', " + i + ")").join(', ');
        run("INSERT INTO v34_wm (id, grp, sub, val) VALUES " + vals);
        return expect(sWM(), sum(MID, VAL) + 199 * 200 / 2);
      });
      t('V34H H1 INSERT SELECT with computed columns', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, val) SELECT id + 50000, UPPER(grp), val * 3 FROM v34_mid WHERE id <= 100");
        return expect(sWM(), sum(MID, VAL) + sum(MID.filter(r => r.id <= 100), r => r.val * 3));
      });
      t('V34H H1 INSERT with the SET syntax', () => {
        buildWM();
        run("INSERT INTO v34_wm SET id = 60000, grp = 'GS', val = 7");
        return expect(nWM(), MID.length + 1);
      });
      t('V34H H1 INSERT DEFAULT VALUES adds one empty row', () => {
        q("DROP TABLE IF EXISTS v34_wd");
        run("CREATE TABLE v34_wd (id INT, v INT DEFAULT 9)");
        run("INSERT INTO v34_wd DEFAULT VALUES");
        const r = expect(one("SELECT COUNT(*) FROM v34_wd"), 1) && expect(one("SELECT v FROM v34_wd"), 9);
        q("DROP TABLE IF EXISTS v34_wd");
        return r;
      });
      t('V34H H1 INSERT SELECT into the 5000-row work table', () => {
        buildWF();
        run("INSERT INTO v34_wf (id, region, qty, cents, status) SELECT id + 100000, region, qty, cents, status " +
            "FROM v34_fact WHERE status = 'paid'");
        return expect(one("SELECT COUNT(*) FROM v34_wf"), FACT.length + cnt(FACT, r => r.status === 'paid'));
      });
      t('V34H H1 INSERT SELECT into the 5000-row work table keeps the totals', () => {
        buildWF();
        run("INSERT INTO v34_wf (id, region, qty, cents, status) SELECT id + 100000, region, qty, cents, status " +
            "FROM v34_fact WHERE status = 'paid'");
        return expect(one("SELECT SUM(cents) FROM v34_wf"),
                      sum(FACT, r => r.cents) + sum(FACT.filter(r => r.status === 'paid'), r => r.cents));
      });
      t('V34H H1 SELECT INTO creates a new table', () => {
        q("DROP TABLE IF EXISTS v34_wi");
        run("SELECT id, val INTO v34_wi FROM v34_mid WHERE val < 10");
        const r = expect(one("SELECT COUNT(*) FROM v34_wi"), cnt(MID, x => x.val < 10));
        q("DROP TABLE IF EXISTS v34_wi");
        return r;
      });

      // ---- H2. まとまった行の更新 ----
      const H2_UPDATES = [
        ["val = val + 1", "", r => r.val + 1, () => true],
        ["val = val * 2", "", r => r.val * 2, () => true],
        ["val = 0", "", () => 0, () => true],
        ["val = val + 10", "WHERE grp = 'G1'", r => r.val + 10, r => r.grp === 'G1'],
        ["val = val - 1", "WHERE val > 20", r => r.val - 1, r => r.val > 20],
        ["val = val * val", "WHERE id <= 100", r => r.val * r.val, r => r.id <= 100],
        ["val = val + id", "WHERE sub = 'S2'", r => r.val + r.id, r => r.sub === 'S2'],
        ["val = ABS(val - 18)", "", r => Math.abs(r.val - 18), () => true],
        ["val = CASE WHEN val > 18 THEN 1 ELSE 0 END", "", r => (r.val > 18 ? 1 : 0), () => true],
        ["val = (SELECT MAX(val) FROM v34_mid)", "WHERE id <= 50", () => Math.max.apply(null, MID.map(VAL)), r => r.id <= 50],
        ["val = val + 5", "WHERE grp IN ('G0', 'G2', 'G4')", r => r.val + 5, r => ['G0', 'G2', 'G4'].indexOf(r.grp) >= 0],
        ["val = val % 7", "WHERE id % 3 = 0", r => r.val % 7, r => r.id % 3 === 0],
        ["val = 100", "WHERE nval IS NULL", () => 100, r => r.nval === null],
        ["val = val + 2", "WHERE id BETWEEN 200 AND 800", r => r.val + 2, r => r.id >= 200 && r.id <= 800],
        ["val = val * 10", "WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.id = v34_wm.id)", r => r.val * 10, r => r.id <= 200]
      ];
      H2_UPDATES.forEach((u, i) => {
        const want = sum(MID, r => u[3](r) ? u[2](r) : r.val);
        const wantN = cnt(MID, u[3]);
        t('V34H H2#' + (i + 1) + ' UPDATE SET ' + u[0] + ' ' + u[1] + ' changes the right rows', () => {
          buildWM();
          const r = run("UPDATE v34_wm SET " + u[0] + " " + u[1]);
          return expect(Number(String(r.data[0].Message).split(' ')[0]), wantN);
        });
        t('V34H H2#' + (i + 1) + ' UPDATE SET ' + u[0] + ' ' + u[1] + ' leaves the right total', () => {
          buildWM();
          run("UPDATE v34_wm SET " + u[0] + " " + u[1]);
          return expect(sWM(), want);
        });
      });
      t('V34H H2 UPDATE of two columns at once', () => {
        buildWM();
        run("UPDATE v34_wm SET val = val + 1, nval = 0 WHERE grp = 'G3'");
        return expect(one("SELECT SUM(val) FROM v34_wm WHERE grp = 'G3'"),
                      sum(MID.filter(r => r.grp === 'G3'), r => r.val + 1)) &&
               expect(one("SELECT SUM(nval) FROM v34_wm WHERE grp = 'G3'"), 0);
      });
      t('V34H H2 UPDATE with ORDER BY and LIMIT', () => {
        buildWM();
        run("UPDATE v34_wm SET val = -1 ORDER BY id LIMIT 50");
        return expect(one("SELECT COUNT(*) FROM v34_wm WHERE val = -1"), 50);
      });
      t('V34H H2 UPDATE touching every row of the 5000-row table', () => {
        buildWF();
        run("UPDATE v34_wf SET qty = qty + 1");
        return expect(one("SELECT SUM(qty) FROM v34_wf"), sum(FACT, r => r.qty) + FACT.length);
      });
      t('V34H H2 UPDATE with a correlated subquery in SET', () => {
        buildWM();
        run("UPDATE v34_wm SET val = (SELECT COUNT(*) FROM v34_small s WHERE s.a = v34_wm.val)");
        return expect(sWM(), sum(MID, r => cnt(SMALL, s => s.a === r.val)));
      });
      t('V34H H2 UPDATE that matches nothing changes nothing', () => {
        buildWM();
        run("UPDATE v34_wm SET val = -1 WHERE grp = 'NOPE'");
        return expect(sWM(), sum(MID, VAL));
      });
      t('V34H H2 UPDATE reports the number of rows changed', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = val + 1 WHERE val = 0");
        return expect(String(r.data[0].Message), cnt(MID, x => x.val === 0) + ' rows updated.');
      });
      t('V34H H2 two UPDATEs in a row compose', () => {
        buildWM();
        run("UPDATE v34_wm SET val = val + 1");
        run("UPDATE v34_wm SET val = val * 2");
        return expect(sWM(), sum(MID, r => (r.val + 1) * 2));
      });
      t('V34H H2 UPDATE using a value from another table', () => {
        buildWM();
        run("UPDATE v34_wm SET val = val + (SELECT COUNT(*) FROM v34_reg)");
        return expect(sWM(), sum(MID, r => r.val + REG.length));
      });
      t('V34H H2 UPDATE of a NULL-bearing column', () => {
        buildWM();
        run("UPDATE v34_wm SET nval = COALESCE(nval, 0)");
        return expect(one("SELECT COUNT(*) FROM v34_wm WHERE nval IS NULL"), 0);
      });

      // ---- H3. まとまった行の削除 ----
      const H3_DELETES = [
        ["", () => true],
        ["WHERE val > 20", r => r.val > 20],
        ["WHERE grp = 'G5'", r => r.grp === 'G5'],
        ["WHERE id % 2 = 0", r => r.id % 2 === 0],
        ["WHERE nval IS NULL", r => r.nval === null],
        ["WHERE id <= 500", r => r.id <= 500],
        ["WHERE sub IN ('S0', 'S2')", r => r.sub === 'S0' || r.sub === 'S2'],
        ["WHERE val BETWEEN 10 AND 20", r => r.val >= 10 && r.val <= 20],
        ["WHERE grp <> 'G0'", r => r.grp !== 'G0'],
        ["WHERE id IN (SELECT id FROM v34_small)", r => r.id <= 200],
        ["WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.a = v34_wm.val)", r => SMALL.some(s => s.a === r.val)],
        ["WHERE val * 2 > 60", r => r.val * 2 > 60]
      ];
      H3_DELETES.forEach((d, i) => {
        const gone = cnt(MID, d[1]);
        t('V34H H3#' + (i + 1) + ' DELETE ' + (d[0] || '(every row)') + ' removes the right count', () => {
          buildWM();
          run("DELETE FROM v34_wm " + d[0]);
          return expect(nWM(), MID.length - gone);
        });
        t('V34H H3#' + (i + 1) + ' DELETE ' + (d[0] || '(every row)') + ' leaves the right total', () => {
          buildWM();
          run("DELETE FROM v34_wm " + d[0]);
          return expect(one("SELECT COALESCE(SUM(val), 0) FROM v34_wm"), sum(MID.filter(r => !d[1](r)), VAL));
        });
      });
      t('V34H H3 DELETE with ORDER BY and LIMIT', () => {
        buildWM();
        run("DELETE FROM v34_wm ORDER BY id DESC LIMIT 100");
        return expect(nWM(), MID.length - 100) && expect(one("SELECT MAX(id) FROM v34_wm"), MID.length - 100);
      });
      t('V34H H3 DELETE over the 5000-row work table', () => {
        buildWF();
        run("DELETE FROM v34_wf WHERE status = 'cancelled'");
        return expect(one("SELECT COUNT(*) FROM v34_wf"), cnt(FACT, r => r.status !== 'cancelled'));
      });
      t('V34H H3 DELETE reports the number of rows removed', () => {
        buildWM();
        const r = run("DELETE FROM v34_wm WHERE grp = 'G7'");
        return expect(String(r.data[0].Message), cnt(MID, x => x.grp === 'G7') + ' rows deleted.');
      });
      t('V34H H3 TRUNCATE empties the table', () => {
        buildWM();
        run("TRUNCATE TABLE v34_wm");
        return expect(nWM(), 0);
      });
      t('V34H H3 the table still exists after TRUNCATE', () => {
        buildWM();
        run("TRUNCATE TABLE v34_wm");
        run("INSERT INTO v34_wm (id, val) VALUES (1, 1)");
        return expect(nWM(), 1);
      });
      t('V34H H3 DELETE then INSERT restores the count', () => {
        buildWM();
        run("DELETE FROM v34_wm WHERE id > 500");
        run("INSERT INTO v34_wm (id, grp, sub, val, nval) SELECT id, grp, sub, val, nval FROM v34_mid WHERE id > 500");
        return expect(nWM(), MID.length) && expect(sWM(), sum(MID, VAL));
      });

      // ---- H4. MERGE ----
      t('V34H H4 MERGE updates every matched row', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id, val * 2 AS val FROM v34_mid WHERE id <= 300) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN UPDATE SET val = s.val");
        return expect(sWM(), sum(MID, r => r.id <= 300 ? r.val * 2 : r.val));
      });
      t('V34H H4 MERGE inserts the rows that do not match', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id + 5000 AS id, val FROM v34_mid WHERE id <= 200) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN UPDATE SET val = s.val WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val)");
        return expect(nWM(), MID.length + 200);
      });
      t('V34H H4 MERGE reports what it did', () => {
        buildWM();
        const r = run("MERGE INTO v34_wm t USING (SELECT id, val FROM v34_mid WHERE id <= 150) s ON (t.id = s.id) " +
                      "WHEN MATCHED THEN UPDATE SET val = s.val");
        return /150 rows merged/.test(String(r.data[0].Message));
      });
      t('V34H H4 MERGE with both branches', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id + 900 AS id, val + 1 AS val FROM v34_mid WHERE id <= 200) s " +
            "ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET val = s.val WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val)");
        return expect(nWM(), MID.length + 100);
      });
      t('V34H H4 MERGE with a condition on the matched branch', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id, val FROM v34_mid WHERE id <= 300) s ON (t.id = s.id) " +
            "WHEN MATCHED AND s.val > 20 THEN UPDATE SET val = 0");
        return expect(one("SELECT COUNT(*) FROM v34_wm WHERE val = 0"),
                      cnt(MID, r => (r.id <= 300 && r.val > 20) || r.val === 0));
      });
      t('V34H H4 MERGE with DELETE on the matched branch', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id FROM v34_mid WHERE val > 30) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN DELETE");
        return expect(nWM(), MID.length - cnt(MID, r => r.val > 30));
      });
      t('V34H H4 MERGE over a 1000-row source', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT id, val + 100 AS val FROM v34_mid WHERE id <= 400) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN UPDATE SET val = s.val");
        return expect(sWM(), sum(MID, r => r.id <= 400 ? r.val + 100 : r.val));
      });
      t('V34H H4 MERGE against a table source', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING v34_small s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET val = s.a");
        return expect(sWM(), sum(MID, r => r.id <= 200 ? SMALL[r.id - 1].a : r.val));
      });
      t('V34H H4 MERGE that matches nothing changes nothing', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT 99999 AS id, 1 AS val) s ON (t.id = s.id) " +
            "WHEN MATCHED THEN UPDATE SET val = s.val");
        return expect(sWM(), sum(MID, VAL));
      });
      t('V34H H4 MERGE inserting only', () => {
        buildWM();
        run("MERGE INTO v34_wm t USING (SELECT 99999 AS id, 5 AS val) s ON (t.id = s.id) " +
            "WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val)");
        return expect(nWM(), MID.length + 1) && expect(sWM(), sum(MID, VAL) + 5);
      });

      // ---- H5. upsert ----
      const buildWU = () => {
        q("DROP TABLE IF EXISTS v34_wu");
        run("CREATE TABLE v34_wu (id INT PRIMARY KEY, v INT)");
        run("INSERT INTO v34_wu (id, v) SELECT n, n FROM GENERATE_SERIES(1, 1000) AS g(n)");
      };
      t('V34H H5 ON DUPLICATE KEY UPDATE replaces the value', () => {
        buildWU();
        run("INSERT INTO v34_wu (id, v) VALUES (1, 999) ON DUPLICATE KEY UPDATE v = 999");
        return expect(one("SELECT v FROM v34_wu WHERE id = 1"), 999) && expect(one("SELECT COUNT(*) FROM v34_wu"), 1000);
      });
      t('V34H H5 ON DUPLICATE KEY UPDATE over many rows', () => {
        buildWU();
        const vals = Array.from({ length: 100 }, (_, i) => "(" + (i + 1) + ", 0)").join(', ');
        run("INSERT INTO v34_wu (id, v) VALUES " + vals + " ON DUPLICATE KEY UPDATE v = 0");
        return expect(one("SELECT COUNT(*) FROM v34_wu WHERE v = 0"), 100);
      });
      t('V34H H5 ON CONFLICT DO UPDATE uses EXCLUDED', () => {
        buildWU();
        run("INSERT INTO v34_wu (id, v) VALUES (5, 777) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v");
        return expect(one("SELECT v FROM v34_wu WHERE id = 5"), 777);
      });
      t('V34H H5 ON CONFLICT DO NOTHING keeps the old value', () => {
        buildWU();
        run("INSERT INTO v34_wu (id, v) VALUES (6, 777) ON CONFLICT (id) DO NOTHING");
        return expect(one("SELECT v FROM v34_wu WHERE id = 6"), 6);
      });
      t('V34H H5 ON CONFLICT inserts when there is no clash', () => {
        buildWU();
        run("INSERT INTO v34_wu (id, v) VALUES (2000, 5) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v");
        return expect(one("SELECT COUNT(*) FROM v34_wu"), 1001);
      });
      t('V34H H5 INSERT OR IGNORE skips the clashing row', () => {
        buildWU();
        run("INSERT OR IGNORE INTO v34_wu (id, v) VALUES (7, 555)");
        return expect(one("SELECT v FROM v34_wu WHERE id = 7"), 7);
      });
      t('V34H H5 INSERT IGNORE skips the clashing row', () => {
        buildWU();
        run("INSERT IGNORE INTO v34_wu (id, v) VALUES (8, 555)");
        return expect(one("SELECT v FROM v34_wu WHERE id = 8"), 8);
      });
      t('V34H H5 INSERT OR REPLACE overwrites the row', () => {
        buildWU();
        run("INSERT OR REPLACE INTO v34_wu (id, v) VALUES (9, 555)");
        return expect(one("SELECT v FROM v34_wu WHERE id = 9"), 555);
      });
      t('V34H H5 REPLACE INTO overwrites the row', () => {
        buildWU();
        run("REPLACE INTO v34_wu (id, v) VALUES (10, 444)");
        return expect(one("SELECT v FROM v34_wu WHERE id = 10"), 444);
      });
      t('V34H H5 a bulk upsert of 500 rows half of which are new', () => {
        buildWU();
        const vals = Array.from({ length: 500 }, (_, i) => "(" + (751 + i) + ", -1)").join(', ');
        run("INSERT INTO v34_wu (id, v) VALUES " + vals + " ON DUPLICATE KEY UPDATE v = -1");
        return expect(one("SELECT COUNT(*) FROM v34_wu"), 1250) &&
               expect(one("SELECT COUNT(*) FROM v34_wu WHERE v = -1"), 500);
      });
      t('V34H H5 a clashing insert without a conflict clause is refused', () => {
        buildWU();
        const r = q("INSERT INTO v34_wu (id, v) VALUES (1, 1)");
        return !!r.error && /PRIMARY KEY/i.test(r.error);
      });

      // ---- H6. RETURNING ----
      t('V34H H6 INSERT RETURNING gives back the new rows', () => {
        buildWM();
        const r = run("INSERT INTO v34_wm (id, grp, val) SELECT id + 70000, grp, val FROM v34_mid WHERE id <= 100 RETURNING id");
        return expect(r.data.length, 100);
      });
      t('V34H H6 UPDATE RETURNING gives back the changed rows', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = val + 1 WHERE grp = 'G2' RETURNING id, val");
        return expect(r.data.length, cnt(MID, x => x.grp === 'G2'));
      });
      t('V34H H6 UPDATE RETURNING shows the new values', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = 42 WHERE id <= 5 RETURNING id, val");
        return expectDeep(r.data.map(x => x.val), [42, 42, 42, 42, 42]);
      });
      t('V34H H6 DELETE RETURNING gives back the removed rows', () => {
        buildWM();
        const r = run("DELETE FROM v34_wm WHERE grp = 'G4' RETURNING id");
        return expect(r.data.length, cnt(MID, x => x.grp === 'G4'));
      });
      t('V34H H6 RETURNING can name several columns', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = 1 WHERE id = 3 RETURNING id, grp, sub, val");
        return expect(Object.keys(r.data[0]).length, 4);
      });
      t('V34H H6 RETURNING star gives every column', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = 1 WHERE id = 4 RETURNING *");
        return expect(Object.keys(r.data[0]).length, 5);
      });
      t('V34H H6 RETURNING over 1000 rows', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = val RETURNING id");
        return expect(r.data.length, MID.length);
      });
      t('V34H H6 RETURNING an expression', () => {
        buildWM();
        const r = run("UPDATE v34_wm SET val = 10 WHERE id <= 3 RETURNING val * 2 AS d");
        return expectDeep(r.data.map(x => x.d), [20, 20, 20]);
      });
      t('V34H H6 upsert RETURNING', () => {
        buildWU();
        const r = run("INSERT INTO v34_wu (id, v) VALUES (11, 123) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v RETURNING id, v");
        return expect(r.data.length, 1) && expect(r.data[0].v, 123);
      });
      t('V34H H6 DELETE RETURNING over the 5000-row table', () => {
        buildWF();
        const r = run("DELETE FROM v34_wf WHERE status = 'cancelled' RETURNING id");
        return expect(r.data.length, cnt(FACT, x => x.status === 'cancelled'));
      });

      // ---- H7. トランザクション ----
      t('V34H H7 ROLLBACK undoes a bulk DELETE', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 100");
        const during = nWM();
        run("ROLLBACK");
        return expect(during, 100) && expect(nWM(), MID.length);
      });
      t('V34H H7 COMMIT keeps a bulk DELETE', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 100");
        run("COMMIT");
        return expect(nWM(), 100);
      });
      t('V34H H7 ROLLBACK undoes a bulk UPDATE', () => {
        buildWM();
        run("BEGIN");
        run("UPDATE v34_wm SET val = 0");
        run("ROLLBACK");
        return expect(sWM(), sum(MID, VAL));
      });
      t('V34H H7 ROLLBACK undoes a bulk INSERT', () => {
        buildWM();
        run("BEGIN");
        run("INSERT INTO v34_wm (id, val) SELECT id + 80000, val FROM v34_mid");
        run("ROLLBACK");
        return expect(nWM(), MID.length);
      });
      t('V34H H7 ROLLBACK undoes several statements at once', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 800");
        run("UPDATE v34_wm SET val = val * 3");
        run("INSERT INTO v34_wm (id, val) VALUES (90000, 1)");
        run("ROLLBACK");
        return expect(nWM(), MID.length) && expect(sWM(), sum(MID, VAL));
      });
      t('V34H H7 ROLLBACK TO a savepoint keeps the earlier work', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 900");
        run("SAVEPOINT sp1");
        run("DELETE FROM v34_wm WHERE id > 500");
        run("ROLLBACK TO sp1");
        const mid = nWM();
        run("COMMIT");
        return expect(mid, 900) && expect(nWM(), 900);
      });
      t('V34H H7 two savepoints in one transaction', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 900");
        run("SAVEPOINT a");
        run("DELETE FROM v34_wm WHERE id > 800");
        run("SAVEPOINT b");
        run("DELETE FROM v34_wm WHERE id > 700");
        run("ROLLBACK TO b");
        const afterB = nWM();
        run("ROLLBACK TO a");
        const afterA = nWM();
        run("COMMIT");
        return expect(afterB, 800) && expect(afterA, 900);
      });
      t('V34H H7 RELEASE keeps the work of the savepoint', () => {
        buildWM();
        run("BEGIN");
        run("DELETE FROM v34_wm WHERE id > 900");
        run("SAVEPOINT sp1");
        run("DELETE FROM v34_wm WHERE id > 500");
        run("RELEASE sp1");
        run("COMMIT");
        return expect(nWM(), 500);
      });
      t('V34H H7 a rolled-back transaction over the 5000-row table', () => {
        buildWF();
        run("BEGIN");
        run("UPDATE v34_wf SET cents = 0");
        run("ROLLBACK");
        return expect(one("SELECT SUM(cents) FROM v34_wf"), sum(FACT, r => r.cents));
      });
      t('V34H H7 a committed transaction over the 5000-row table', () => {
        buildWF();
        run("BEGIN");
        run("DELETE FROM v34_wf WHERE qty < 5");
        run("COMMIT");
        return expect(one("SELECT COUNT(*) FROM v34_wf"), cnt(FACT, r => r.qty >= 5));
      });
      t('V34H H7 a transaction wrapping CREATE and INSERT', () => {
        q("DROP TABLE IF EXISTS v34_wt");
        run("BEGIN");
        run("CREATE TABLE v34_wt (id INT, v INT)");
        run("INSERT INTO v34_wt (id, v) SELECT n, n FROM GENERATE_SERIES(1, 500) AS g(n)");
        run("COMMIT");
        const r = expect(one("SELECT COUNT(*) FROM v34_wt"), 500);
        q("DROP TABLE IF EXISTS v34_wt");
        return r;
      });
      t('V34H H7 many small statements inside one transaction', () => {
        buildWM();
        run("BEGIN");
        for (let i = 0; i < 50; i++) run("UPDATE v34_wm SET val = val + 1 WHERE id = " + (i + 1));
        run("COMMIT");
        return expect(sWM(), sum(MID, VAL) + 50);
      });
      t('V34H H7 rolling back many small statements', () => {
        buildWM();
        run("BEGIN");
        for (let i = 0; i < 50; i++) run("UPDATE v34_wm SET val = val + 1 WHERE id = " + (i + 1));
        run("ROLLBACK");
        return expect(sWM(), sum(MID, VAL));
      });

      // ---- H8. 複数表にまたがる DML ----
      t('V34H H8 UPDATE ... FROM another table', () => {
        buildWM();
        run("UPDATE v34_wm SET val = s.a FROM v34_small s WHERE s.id = v34_wm.id");
        return expect(one("SELECT SUM(val) FROM v34_wm WHERE id <= 200"), sum(SMALL, s => s.a));
      });
      t('V34H H8 UPDATE ... FROM leaves the other rows alone', () => {
        buildWM();
        run("UPDATE v34_wm SET val = s.a FROM v34_small s WHERE s.id = v34_wm.id");
        return expect(one("SELECT SUM(val) FROM v34_wm WHERE id > 200"), sum(MID.filter(r => r.id > 200), VAL));
      });
      t('V34H H8 UPDATE ... FROM with an extra condition', () => {
        buildWM();
        run("UPDATE v34_wm SET val = 0 FROM v34_small s WHERE s.id = v34_wm.id AND s.b = 0");
        const smallById = new Map(SMALL.map(x => [x.id, x]));
        return expect(one("SELECT COUNT(*) FROM v34_wm WHERE val = 0"),
                      cnt(MID, r => { const sm = smallById.get(r.id);
                                      return (sm && sm.b === 0) ? true : r.val === 0; }));
      });
      t('V34H H8 DELETE ... USING another table', () => {
        buildWM();
        run("DELETE FROM v34_wm USING v34_small s WHERE s.id = v34_wm.id AND s.b = 0");
        return expect(nWM(), MID.length - cnt(SMALL, s => s.b === 0));
      });
      t('V34H H8 DELETE ... USING with a wider match', () => {
        buildWM();
        run("DELETE FROM v34_wm USING v34_small s WHERE s.id = v34_wm.id");
        return expect(nWM(), MID.length - SMALL.length);
      });
      t('V34H H8 UPDATE joined to a dimension table', () => {
        buildWF();
        run("UPDATE v34_wf SET qty = qty + 1 FROM v34_cust c WHERE v34_wf.cust_id = c.id AND c.tier = 'gold'");
        return expect(one("SELECT SUM(qty) FROM v34_wf"),
                      sum(FACT, r => r.qty) + cnt(WIDEJOIN, x => x.c.tier === 'gold'));
      });
      t('V34H H8 DELETE joined to a dimension table', () => {
        buildWF();
        run("DELETE FROM v34_wf USING v34_cust c WHERE v34_wf.cust_id = c.id AND c.tier = 'bronze'");
        return expect(one("SELECT COUNT(*) FROM v34_wf"), cnt(WIDEJOIN, x => x.c.tier !== 'bronze'));
      });
      t('V34H H8 UPDATE with a subquery over another table', () => {
        buildWM();
        run("UPDATE v34_wm SET val = (SELECT COUNT(*) FROM v34_reg) WHERE id <= 100");
        return expect(one("SELECT SUM(val) FROM v34_wm WHERE id <= 100"), REG.length * 100);
      });
      t('V34H H8 DELETE driven by a subquery over another table', () => {
        buildWM();
        run("DELETE FROM v34_wm WHERE id IN (SELECT id FROM v34_small WHERE s = 's0')");
        return expect(nWM(), MID.length - cnt(SMALL, s => s.s === 's0'));
      });
      t('V34H H8 INSERT driven by a join of two tables', () => {
        buildWM();
        run("INSERT INTO v34_wm (id, grp, val) SELECT m.id + 60000, m.grp, s.a FROM v34_mid m JOIN v34_small s ON s.id = m.id");
        return expect(nWM(), MID.length + SMALL.length);
      });

      // ---- H9. 大量投入と制約 ----
      t('V34H H9 a CHECK constraint stops the bad row', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INT PRIMARY KEY, v INT CHECK (v >= 0))");
        run("INSERT INTO v34_wc (id, v) SELECT n, n FROM GENERATE_SERIES(1, 1000) AS g(n)");
        const bad = q("INSERT INTO v34_wc (id, v) VALUES (1001, -1)");
        const ok = !!bad.error && one("SELECT COUNT(*) FROM v34_wc") === 1000;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 a NOT NULL constraint stops the bad row', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INT PRIMARY KEY, v INT NOT NULL)");
        run("INSERT INTO v34_wc (id, v) SELECT n, n FROM GENERATE_SERIES(1, 500) AS g(n)");
        const bad = q("INSERT INTO v34_wc (id, v) VALUES (501, NULL)");
        const ok = !!bad.error && one("SELECT COUNT(*) FROM v34_wc") === 500;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 a UNIQUE constraint survives a bulk load', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INT PRIMARY KEY, v INT UNIQUE)");
        run("INSERT INTO v34_wc (id, v) SELECT n, n FROM GENERATE_SERIES(1, 1000) AS g(n)");
        const bad = q("INSERT INTO v34_wc (id, v) VALUES (1001, 500)");
        const ok = !!bad.error && one("SELECT COUNT(*) FROM v34_wc") === 1000;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 a DEFAULT fills the missing column on every row', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INT, v INT DEFAULT 7)");
        run("INSERT INTO v34_wc (id) SELECT n FROM GENERATE_SERIES(1, 500) AS g(n)");
        const ok = one("SELECT SUM(v) FROM v34_wc") === 3500;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 a generated column is computed for every row', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INT, v INT, d INT GENERATED ALWAYS AS (v * 2))");
        run("INSERT INTO v34_wc (id, v) SELECT n, n FROM GENERATE_SERIES(1, 500) AS g(n)");
        const ok = one("SELECT SUM(d) FROM v34_wc") === 500 * 501;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 AUTO_INCREMENT numbers a bulk load', () => {
        q("DROP TABLE IF EXISTS v34_wc");
        run("CREATE TABLE v34_wc (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INT)");
        run("INSERT INTO v34_wc (v) SELECT n FROM GENERATE_SERIES(1, 300) AS g(n)");
        const ok = one("SELECT MAX(id) FROM v34_wc") === 300 && one("SELECT COUNT(DISTINCT id) FROM v34_wc") === 300;
        q("DROP TABLE IF EXISTS v34_wc");
        return ok;
      });
      t('V34H H9 a foreign key refuses an orphan row', () => {
        q("DROP TABLE IF EXISTS v34_wch"); q("DROP TABLE IF EXISTS v34_wcp");
        run("CREATE TABLE v34_wcp (id INT PRIMARY KEY)");
        run("INSERT INTO v34_wcp (id) SELECT n FROM GENERATE_SERIES(1, 100) AS g(n)");
        run("CREATE TABLE v34_wch (id INT PRIMARY KEY, pid INT REFERENCES v34_wcp(id))");
        run("INSERT INTO v34_wch (id, pid) SELECT n, n FROM GENERATE_SERIES(1, 100) AS g(n)");
        const bad = q("INSERT INTO v34_wch (id, pid) VALUES (101, 9999)");
        const ok = !!bad.error && one("SELECT COUNT(*) FROM v34_wch") === 100;
        q("DROP TABLE IF EXISTS v34_wch"); q("DROP TABLE IF EXISTS v34_wcp");
        return ok;
      });
      t('V34H H9 ON DELETE CASCADE removes the children', () => {
        q("DROP TABLE IF EXISTS v34_wch"); q("DROP TABLE IF EXISTS v34_wcp");
        run("CREATE TABLE v34_wcp (id INT PRIMARY KEY)");
        run("INSERT INTO v34_wcp (id) SELECT n FROM GENERATE_SERIES(1, 100) AS g(n)");
        run("CREATE TABLE v34_wch (id INT PRIMARY KEY, pid INT REFERENCES v34_wcp(id) ON DELETE CASCADE)");
        run("INSERT INTO v34_wch (id, pid) SELECT n, n FROM GENERATE_SERIES(1, 100) AS g(n)");
        run("DELETE FROM v34_wcp WHERE id <= 40");
        const ok = one("SELECT COUNT(*) FROM v34_wch") === 60;
        q("DROP TABLE IF EXISTS v34_wch"); q("DROP TABLE IF EXISTS v34_wcp");
        return ok;
      });
      t('V34H H9 a trigger fires once per inserted row', () => {
        q("DROP TABLE IF EXISTS v34_wlog"); q("DROP TABLE IF EXISTS v34_wsrc");
        q("DROP TRIGGER IF EXISTS v34_trg");
        run("CREATE TABLE v34_wsrc (id INT, v INT)");
        run("CREATE TABLE v34_wlog (id INT)");
        run("CREATE TRIGGER v34_trg AFTER INSERT ON v34_wsrc FOR EACH ROW INSERT INTO v34_wlog (id) VALUES (NEW.id)");
        run("INSERT INTO v34_wsrc (id, v) SELECT n, n FROM GENERATE_SERIES(1, 200) AS g(n)");
        const ok = one("SELECT COUNT(*) FROM v34_wlog") === 200;
        q("DROP TRIGGER IF EXISTS v34_trg");
        q("DROP TABLE IF EXISTS v34_wlog"); q("DROP TABLE IF EXISTS v34_wsrc");
        return ok;
      });
      t('V34H H9 the work tables are cleaned up', () => {
        ['v34_wm', 'v34_wf', 'v34_wu'].forEach(n => q("DROP TABLE IF EXISTS " + n));
        return !db.tables['v34_wm'] && !db.tables['v34_wf'] && !db.tables['v34_wu'];
      });

      // ============================================================
      // I. 並べ替え・ページング・重複除去
      // ============================================================
      const cmpText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

      // ---- I1. 複数キーの並べ替え ----
      const I1_ORDERS = [
        ['id', (a, b) => a.id - b.id],
        ['id DESC', (a, b) => b.id - a.id],
        ['val, id', (a, b) => a.val - b.val || a.id - b.id],
        ['val DESC, id', (a, b) => b.val - a.val || a.id - b.id],
        ['val, id DESC', (a, b) => a.val - b.val || b.id - a.id],
        ['grp, val, id', (a, b) => cmpText(a.grp, b.grp) || a.val - b.val || a.id - b.id],
        ['grp DESC, val DESC, id', (a, b) => cmpText(b.grp, a.grp) || b.val - a.val || a.id - b.id],
        ['sub, grp, id', (a, b) => cmpText(a.sub, b.sub) || cmpText(a.grp, b.grp) || a.id - b.id],
        ['txt, id', (a, b) => cmpText(a.txt, b.txt) || a.id - b.id],
        ['txt DESC, id DESC', (a, b) => cmpText(b.txt, a.txt) || b.id - a.id],
        ['val % 5, val, id', (a, b) => (a.val % 5) - (b.val % 5) || a.val - b.val || a.id - b.id],
        ['LENGTH(txt), txt, id', (a, b) => a.txt.length - b.txt.length || cmpText(a.txt, b.txt) || a.id - b.id],
        ['grp, sub, val DESC, id', (a, b) => cmpText(a.grp, b.grp) || cmpText(a.sub, b.sub) || b.val - a.val || a.id - b.id],
        ['id % 7, id', (a, b) => (a.id % 7) - (b.id % 7) || a.id - b.id],
        ['val * -1, id', (a, b) => (a.val * -1) - (b.val * -1) || a.id - b.id]
      ];
      I1_ORDERS.forEach((od, i) => {
        const want = MID.slice().sort(od[1]).map(r => r.id);
        t('V34I I1#' + (i + 1) + ' ORDER BY ' + od[0] + ' over 1000 rows', () =>
          expectArr(colOf("SELECT id FROM v34_mid ORDER BY " + od[0], 'id'), want, 0, 'order'));
        t('V34I I1#' + (i + 1) + ' ORDER BY ' + od[0] + ' picks the same first row', () =>
          expect(one("SELECT id FROM v34_mid ORDER BY " + od[0] + " LIMIT 1"), want[0]));
      });
      t('V34I I1 ORDER BY over the 5000-row fact table', () => {
        const want = FACT.slice().sort((a, b) => b.cents - a.cents || a.id - b.id).slice(0, 200).map(r => r.id);
        return expectArr(colOf("SELECT id FROM v34_fact ORDER BY cents DESC, id LIMIT 200", 'id'), want, 0, 'fact order');
      });
      t('V34I I1 ORDER BY four keys over the fact table', () => {
        const want = FACT.slice().sort((a, b) => cmpText(a.region, b.region) || cmpText(a.status, b.status) ||
                                                 b.qty - a.qty || a.id - b.id).slice(0, 300).map(r => r.id);
        return expectArr(colOf("SELECT id FROM v34_fact ORDER BY region, status, qty DESC, id LIMIT 300", 'id'), want, 0, 'four keys');
      });
      val('V34I I1 ORDER BY an ordinal position',
          "SELECT id FROM v34_mid ORDER BY 1 DESC LIMIT 1", MID.length);
      val('V34I I1 ORDER BY an output alias',
          "SELECT id AS k FROM v34_mid ORDER BY k DESC LIMIT 1", MID.length);
      val('V34I I1 ORDER BY an expression not in the select list',
          "SELECT id FROM v34_mid ORDER BY val DESC, id LIMIT 1",
          MID.slice().sort((a, b) => b.val - a.val || a.id - b.id)[0].id);
      val('V34I I1 ORDER BY a CASE expression',
          "SELECT id FROM v34_mid ORDER BY CASE WHEN grp = 'G9' THEN 0 ELSE 1 END, id LIMIT 1",
          MID.filter(r => r.grp === 'G9')[0].id);
      val('V34I I1 ORDER BY ALL takes every output column',
          "SELECT id FROM v34_mid ORDER BY ALL LIMIT 1", 1);

      // ---- I2. NULL の並び ----
      t('V34I I2 NULLS FIRST puts the NULLs at the top', () => {
        const got = colOf("SELECT nval FROM v34_mid ORDER BY nval NULLS FIRST, id", 'nval');
        return expect(got[0], null) && expect(cnt(MID, r => r.nval === null), got.filter(v => v === null).length);
      });
      t('V34I I2 NULLS LAST puts the NULLs at the bottom', () => {
        const got = colOf("SELECT nval FROM v34_mid ORDER BY nval NULLS LAST, id", 'nval');
        return expect(got[got.length - 1], null);
      });
      t('V34I I2 DESC NULLS FIRST', () => {
        const got = colOf("SELECT nval FROM v34_mid ORDER BY nval DESC NULLS FIRST, id", 'nval');
        return expect(got[0], null);
      });
      t('V34I I2 DESC NULLS LAST', () => {
        const got = colOf("SELECT nval FROM v34_mid ORDER BY nval DESC NULLS LAST, id", 'nval');
        return expect(got[0], Math.max.apply(null, MID.filter(r => r.nval !== null).map(r => r.nval)));
      });
      t('V34I I2 NULLS FIRST keeps the non-NULL order', () => {
        const got = colOf("SELECT nval FROM v34_mid ORDER BY nval NULLS FIRST, id", 'nval').filter(v => v !== null);
        const want = MID.filter(r => r.nval !== null).sort((a, b) => a.nval - b.nval || a.id - b.id).map(r => r.nval);
        return expectArr(got, want, 0, 'non-null order');
      });
      val('V34I I2 counting the NULLs that sort first',
          "SELECT COUNT(*) FROM (SELECT nval FROM v34_mid ORDER BY nval NULLS FIRST LIMIT " +
          cnt(MID, r => r.nval === null) + ") z WHERE nval IS NULL", cnt(MID, r => r.nval === null));
      val('V34I I2 ORDER BY a NULL-bearing column with a tiebreaker',
          "SELECT id FROM v34_mid ORDER BY nval NULLS LAST, id LIMIT 1",
          MID.filter(r => r.nval !== null).sort((a, b) => a.nval - b.nval || a.id - b.id)[0].id);
      val('V34I I2 NULLs do not change the row count',
          "SELECT COUNT(*) FROM (SELECT nval FROM v34_mid ORDER BY nval NULLS FIRST) z", MID.length);

      // ---- I3. LIMIT / OFFSET によるページング ----
      [50, 100, 250, 500].forEach(page => {
        t('V34I I3 paging through 1000 rows ' + page + ' at a time covers every row', () => {
          const seen = [];
          for (let off = 0; off < MID.length; off += page) {
            seen.push.apply(seen, colOf("SELECT id FROM v34_mid ORDER BY id LIMIT " + page + " OFFSET " + off, 'id'));
          }
          return expectArr(seen, MID.map(r => r.id), 0, 'paging');
        });
      });
      [[0, 10], [10, 10], [100, 25], [500, 100], [900, 100], [990, 20], [999, 5], [1000, 10]].forEach(pair => {
        const off = pair[0], lim = pair[1];
        const want = MID.slice(off, off + lim).map(r => r.id);
        t('V34I I3 LIMIT ' + lim + ' OFFSET ' + off, () =>
          expectArr(colOf("SELECT id FROM v34_mid ORDER BY id LIMIT " + lim + " OFFSET " + off, 'id'), want, 0, 'page'));
        t('V34I I3 LIMIT ' + lim + ' OFFSET ' + off + ' returns the right count', () =>
          expect(one("SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY id LIMIT " + lim + " OFFSET " + off + ") z"),
                 want.length));
      });
      val('V34I I3 LIMIT larger than the table returns every row',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid LIMIT 100000) z", MID.length);
      val('V34I I3 OFFSET past the end returns nothing',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid LIMIT 10 OFFSET 100000) z", 0);
      val('V34I I3 LIMIT 0 returns nothing',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid LIMIT 0) z", 0);
      val('V34I I3 the MySQL two-argument LIMIT',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY id LIMIT 100, 30) z", 30);
      t('V34I I3 the MySQL two-argument LIMIT starts at the offset', () =>
        expectArr(colOf("SELECT id FROM v34_mid ORDER BY id LIMIT 100, 30", 'id'),
                  MID.slice(100, 130).map(r => r.id), 0, 'limit offset'));
      val('V34I I3 paging over the 5000-row table',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_fact ORDER BY id LIMIT 1000 OFFSET 4000) z", 1000);
      t('V34I I3 the last page of the 5000-row table', () =>
        expectArr(colOf("SELECT id FROM v34_fact ORDER BY id LIMIT 1000 OFFSET 4000", 'id'),
                  FACT.slice(4000).map(r => r.id), 0, 'last page'));
      val('V34I I3 OFFSET without LIMIT',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY id OFFSET 750) z", 250);
      val('V34I I3 FETCH FIRST n ROWS ONLY',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY id FETCH FIRST 42 ROWS ONLY) z", 42);
      val('V34I I3 OFFSET with FETCH NEXT',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY id OFFSET 100 ROWS FETCH NEXT 25 ROWS ONLY) z", 25);
      val('V34I I3 LIMIT after a GROUP BY',
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) FROM v34_mid GROUP BY grp ORDER BY grp LIMIT 4) z", 4);
      val('V34I I3 LIMIT after a JOIN',
          "SELECT COUNT(*) FROM (SELECT f.id FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id ORDER BY f.id LIMIT 123) z", 123);

      // ---- I4. 重複除去 ----
      val('V34I I4 DISTINCT over one column', "SELECT COUNT(*) FROM (SELECT DISTINCT grp FROM v34_mid) z", uniq(MID, r => r.grp));
      val('V34I I4 DISTINCT over two columns', "SELECT COUNT(*) FROM (SELECT DISTINCT grp, sub FROM v34_mid) z",
          uniq(MID, r => r.grp + '|' + r.sub));
      val('V34I I4 DISTINCT over three columns', "SELECT COUNT(*) FROM (SELECT DISTINCT grp, sub, val FROM v34_mid) z",
          uniq(MID, r => r.grp + '|' + r.sub + '|' + r.val));
      val('V34I I4 DISTINCT over an expression', "SELECT COUNT(*) FROM (SELECT DISTINCT val % 5 AS k FROM v34_mid) z",
          uniq(MID, r => r.val % 5));
      val('V34I I4 DISTINCT keeps every row when they are unique',
          "SELECT COUNT(*) FROM (SELECT DISTINCT id FROM v34_mid) z", MID.length);
      val('V34I I4 DISTINCT with ORDER BY and LIMIT',
          "SELECT COUNT(*) FROM (SELECT DISTINCT grp FROM v34_mid ORDER BY grp LIMIT 3) z", 3);
      t('V34I I4 DISTINCT results come back in order', () => {
        const want = [...new Set(MID.map(r => r.grp))].sort();
        return expectDeep(colOf("SELECT DISTINCT grp FROM v34_mid ORDER BY grp", 'grp'), want);
      });
      val('V34I I4 DISTINCT over the 5000-row fact table',
          "SELECT COUNT(*) FROM (SELECT DISTINCT region, status FROM v34_fact) z",
          uniq(FACT, r => r.region + '|' + r.status));
      val('V34I I4 DISTINCT after a join',
          "SELECT COUNT(*) FROM (SELECT DISTINCT c.tier, p.cat " + FOUR_WAY + ") z",
          uniq(WIDEJOIN, x => x.c.tier + '|' + x.p.cat));
      val('V34I I4 DISTINCT ON keeps one row per key',
          "SELECT COUNT(*) FROM (SELECT DISTINCT ON (grp) grp, id FROM v34_mid ORDER BY grp, id) z", uniq(MID, r => r.grp));
      t('V34I I4 DISTINCT ON keeps the first row of each key', () => {
        const m = byKey(MID, r => r.grp);
        const want = [...m.keys()].sort().map(k => ({ grp: k, id: Math.min.apply(null, m.get(k).map(r => r.id)) }));
        return expectDeep(rows("SELECT DISTINCT ON (grp) grp, id FROM v34_mid ORDER BY grp, id"), want);
      });
      t('V34I I4 DISTINCT ON with a descending tiebreak', () => {
        const m = byKey(MID, r => r.grp);
        const want = [...m.keys()].sort().map(k => ({ grp: k, id: Math.max.apply(null, m.get(k).map(r => r.id)) }));
        return expectDeep(rows("SELECT DISTINCT ON (grp) grp, id FROM v34_mid ORDER BY grp, id DESC"), want);
      });
      val('V34I I4 DISTINCT ON over two keys',
          "SELECT COUNT(*) FROM (SELECT DISTINCT ON (grp, sub) grp, sub, id FROM v34_mid ORDER BY grp, sub, id) z",
          uniq(MID, r => r.grp + '|' + r.sub));
      val('V34I I4 DISTINCT ON over the fact table',
          "SELECT COUNT(*) FROM (SELECT DISTINCT ON (region) region, id FROM v34_fact ORDER BY region, id) z",
          uniq(FACT, r => r.region));
      val('V34I I4 DISTINCT combined with an aggregate in an outer query',
          "SELECT SUM(k) FROM (SELECT DISTINCT val AS k FROM v34_mid) z",
          [...new Set(MID.map(r => r.val))].reduce((a, b) => a + b, 0));

      // ---- I5. TOP / WITH TIES ----
      val('V34I I5 TOP n takes the first rows', "SELECT COUNT(*) FROM (SELECT TOP 25 id FROM v34_mid ORDER BY id) z", 25);
      t('V34I I5 TOP n takes the right rows', () =>
        expectArr(colOf("SELECT TOP 10 id FROM v34_mid ORDER BY id", 'id'), MID.slice(0, 10).map(r => r.id), 0, 'top'));
      val('V34I I5 TOP n PERCENT takes a share of the rows',
          "SELECT COUNT(*) FROM (SELECT TOP 10 PERCENT id FROM v34_mid ORDER BY id) z", 100);
      val('V34I I5 TOP over the fact table',
          "SELECT COUNT(*) FROM (SELECT TOP 500 id FROM v34_fact ORDER BY cents DESC, id) z", 500);
      t('V34I I5 FETCH FIRST WITH TIES keeps the whole peer group', () => {
        const maxv = Math.max.apply(null, MID.map(VAL));
        return expect(one("SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY val DESC FETCH FIRST 1 ROWS WITH TIES) z"),
                      cnt(MID, r => r.val === maxv));
      });
      t('V34I I5 FETCH FIRST WITH TIES over the fact table', () => {
        const sorted = FACT.map(r => r.qty).sort((a, b) => b - a);
        const cut = sorted[2];
        return expect(one("SELECT COUNT(*) FROM (SELECT id FROM v34_fact ORDER BY qty DESC FETCH FIRST 3 ROWS WITH TIES) z"),
                      cnt(FACT, r => r.qty >= cut));
      });
      val('V34I I5 FETCH FIRST ONLY does not keep the ties',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid ORDER BY val DESC FETCH FIRST 3 ROWS ONLY) z", 3);
      val('V34I I5 TOP inside a derived table',
          "SELECT SUM(val) FROM (SELECT TOP 5 val FROM v34_mid ORDER BY val DESC, id) z",
          sum(MID.slice().sort((a, b) => b.val - a.val || a.id - b.id).slice(0, 5), VAL));
      val('V34I I5 TOP 1 of each group through a window',
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY val DESC, id) = 1) z",
          uniq(MID, r => r.grp));

      // ============================================================
      // J. 表関数 / PIVOT / JSON / 配列
      // ============================================================

      // ---- J1. GENERATE_SERIES ----
      [10, 100, 1000, 5000, 10000].forEach(n => {
        val('V34J J1 GENERATE_SERIES(1, ' + n + ') row count',
            "SELECT COUNT(*) FROM GENERATE_SERIES(1, " + n + ") AS g(n)", n);
        val('V34J J1 GENERATE_SERIES(1, ' + n + ') sum',
            "SELECT SUM(n) FROM GENERATE_SERIES(1, " + n + ") AS g(n)", n * (n + 1) / 2);
      });
      [2, 3, 5, 7, 10].forEach(step => {
        val('V34J J1 GENERATE_SERIES with step ' + step,
            "SELECT COUNT(*) FROM GENERATE_SERIES(0, 1000, " + step + ") AS g(n)", Math.floor(1000 / step) + 1);
      });
      val('V34J J1 GENERATE_SERIES counting down',
          "SELECT COUNT(*) FROM GENERATE_SERIES(100, 1, -1) AS g(n)", 100);
      val('V34J J1 GENERATE_SERIES counting down sums the same',
          "SELECT SUM(n) FROM GENERATE_SERIES(100, 1, -1) AS g(n)", 5050);
      val('V34J J1 GENERATE_SERIES with an empty range',
          "SELECT COUNT(*) FROM GENERATE_SERIES(10, 1) AS g(n)", 0);
      val('V34J J1 GENERATE_SERIES of a single value',
          "SELECT COUNT(*) FROM GENERATE_SERIES(5, 5) AS g(n)", 1);
      val('V34J J1 GENERATE_SERIES joined to a table',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 1000) AS g(n) JOIN v34_mid m ON m.id = g.n", MID.length);
      val('V34J J1 GENERATE_SERIES filtered',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 1000) AS g(n) WHERE n % 3 = 0", Math.floor(1000 / 3));
      val('V34J J1 GENERATE_SERIES grouped',
          "SELECT COUNT(*) FROM (SELECT n % 10 AS k, COUNT(*) AS c FROM GENERATE_SERIES(1, 1000) AS g(n) GROUP BY n % 10) z", 10);
      val('V34J J1 GENERATE_SERIES feeding a window function',
          "SELECT MAX(rn) FROM (SELECT ROW_NUMBER() OVER (ORDER BY n) AS rn FROM GENERATE_SERIES(1, 2000) AS g(n)) z", 2000);
      val('V34J J1 GENERATE_SERIES crossed with a small table',
          "SELECT COUNT(*) FROM GENERATE_SERIES(1, 100) AS g(n) CROSS JOIN v34_reg", 100 * REG.length);
      val('V34J J1 GENERATE_SERIES over dates',
          "SELECT COUNT(*) FROM GENERATE_SERIES(DATE '2024-01-01', DATE '2024-01-31', INTERVAL 1 DAY) AS g(d)", 31);
      val('V34J J1 GENERATE_SERIES over dates by week',
          "SELECT COUNT(*) FROM GENERATE_SERIES(DATE '2024-01-01', DATE '2024-03-31', INTERVAL 7 DAY) AS g(d)", 13);
      val('V34J J1 GENERATE_SERIES used to build a calendar join',
          "SELECT COUNT(*) FROM (SELECT n FROM GENERATE_SERIES(1, 5000) AS g(n)) cal JOIN v34_fact f ON f.id = cal.n",
          FACT.length);

      // ---- J2. STRING_SPLIT / UNNEST ----
      [2, 5, 10, 50, 100].forEach(n => {
        const strv = Array.from({ length: n }, (_, i) => 'p' + i).join(',');
        val('V34J J2 STRING_SPLIT of ' + n + ' parts',
            "SELECT COUNT(*) FROM STRING_SPLIT('" + strv + "', ',')", n);
      });
      val('V34J J2 STRING_SPLIT with a multi-character separator',
          "SELECT COUNT(*) FROM STRING_SPLIT('a--b--c', '--')", 3);
      val('V34J J2 STRING_SPLIT of a single value',
          "SELECT COUNT(*) FROM STRING_SPLIT('solo', ',')", 1);
      val('V34J J2 STRING_SPLIT joined to a table',
          "SELECT COUNT(*) FROM STRING_SPLIT('R0,R1,R2', ',') s JOIN v34_fact f ON f.region = s.value",
          cnt(FACT, r => ['R0', 'R1', 'R2'].indexOf(r.region) >= 0));
      // UNNEST は引数を順につないで 1 列に平らにする（PostgreSQL のような列の並置ではない）
      val('V34J J2 UNNEST of one array', "SELECT COUNT(*) FROM UNNEST(ARRAY[1, 2, 3, 4, 5]) AS u(v)", 5);
      val('V34J J2 UNNEST of one array sums', "SELECT SUM(v) FROM UNNEST(ARRAY[1, 2, 3, 4, 5]) AS u(v)", 15);
      val('V34J J2 UNNEST of a 100-element array',
          "SELECT COUNT(*) FROM UNNEST(ARRAY[" + Array.from({ length: 100 }, (_, i) => i).join(', ') + "]) AS u(v)", 100);
      val('V34J J2 UNNEST flattens two arrays into one column',
          "SELECT COUNT(*) FROM UNNEST(ARRAY[1, 2, 3], ARRAY[4, 5, 6]) AS u(v)", 6);
      val('V34J J2 UNNEST of a scalar list', "SELECT SUM(n) FROM UNNEST(10, 20, 30) AS u(n)", 60);
      val('V34J J2 UNNEST of an empty array', "SELECT COUNT(*) FROM UNNEST(ARRAY[]) AS u(v)", 0);
      t('V34J J2 UNNEST WITH ORDINALITY numbers the rows', () =>
        expectDeep(rows("SELECT v, i FROM UNNEST(ARRAY[10, 20, 30]) WITH ORDINALITY AS u(v, i) ORDER BY i"),
                   [{ v: 10, i: 1 }, { v: 20, i: 2 }, { v: 30, i: 3 }]));
      val('V34J J2 UNNEST over STRING_TO_ARRAY',
          "SELECT COUNT(*) FROM UNNEST(STRING_TO_ARRAY('a,b,c,d', ',')) AS u(v)", 4);
      val('V34J J2 UNNEST joined to a table',
          "SELECT COUNT(*) FROM UNNEST(ARRAY[1, 2, 3]) AS u(v) JOIN v34_small s ON s.id = u.v", 3);
      val('V34J J2 UNNEST in the select list',
          "SELECT COUNT(*) FROM (SELECT UNNEST(ARRAY[1, 2, 3, 4]) AS v) z", 4);
      val('V34J J2 UNNEST crossed with a table',
          "SELECT COUNT(*) FROM v34_reg CROSS JOIN UNNEST(ARRAY[1, 2]) AS u(v)", REG.length * 2);

      // ---- J3. JSON ----
      val('V34J J3 JSON_TABLE turns an array into rows',
          "SELECT COUNT(*) FROM JSON_TABLE('[{\"a\":1},{\"a\":2},{\"a\":3}]', '$[*]' COLUMNS (a INT PATH '$.a')) jt", 3);
      val('V34J J3 JSON_TABLE sums the extracted column',
          "SELECT SUM(a) FROM JSON_TABLE('[{\"a\":1},{\"a\":2},{\"a\":3}]', '$[*]' COLUMNS (a INT PATH '$.a')) jt", 6);
      val('V34J J3 JSON_TABLE with two columns',
          "SELECT COUNT(*) FROM JSON_TABLE('[{\"a\":1,\"b\":\"x\"},{\"a\":2,\"b\":\"y\"}]', '$[*]' " +
          "COLUMNS (a INT PATH '$.a', b TEXT PATH '$.b')) jt", 2);
      val('V34J J3 JSON_TABLE joined to a table',
          "SELECT COUNT(*) FROM JSON_TABLE('[{\"c\":\"R0\"},{\"c\":\"R1\"}]', '$[*]' COLUMNS (c TEXT PATH '$.c')) jt " +
          "JOIN v34_fact f ON f.region = jt.c", cnt(FACT, r => r.region === 'R0' || r.region === 'R1'));
      val('V34J J3 JSON_EXTRACT reaches into an array',
          "SELECT JSON_EXTRACT('{\"a\":[10,20,30]}', '$.a[1]')", 20);
      val('V34J J3 JSON_EXTRACT reaches into a nested object',
          "SELECT JSON_EXTRACT('{\"a\":{\"b\":{\"c\":7}}}', '$.a.b.c')", 7);
      val('V34J J3 JSON_LENGTH counts array elements', "SELECT JSON_LENGTH('[1,2,3,4,5]')", 5);
      val('V34J J3 JSON_TYPE names the kind of value', "SELECT JSON_TYPE('[1,2]')", 'ARRAY');
      val('V34J J3 JSON_VALID accepts good JSON', "SELECT JSON_VALID('{\"a\":1}')", 1);
      val('V34J J3 JSON_VALID rejects bad JSON', "SELECT JSON_VALID('{a:1')", 0);
      val('V34J J3 JSON_OBJECT built per row is always valid',
          "SELECT COUNT(*) FROM v34_mid WHERE JSON_VALID(JSON_OBJECT('id', id, 'grp', grp, 'val', val))", MID.length);
      val('V34J J3 JSON_ARRAYAGG over a whole group',
          "SELECT JSON_LENGTH(JSON_ARRAYAGG(id)) FROM v34_mid WHERE grp = 'G0'", cnt(MID, r => r.grp === 'G0'));
      t('V34J J3 JSON_ARRAYAGG per group', () => {
        const m = byKey(MID, r => r.grp);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT grp, JSON_LENGTH(JSON_ARRAYAGG(id)) AS n FROM v34_mid GROUP BY grp ORDER BY grp"),
                          keys.map(k => ({ grp: k, n: m.get(k).length })));
      });
      val('V34J J3 JSON_EXTRACT over a generated document',
          "SELECT COUNT(*) FROM (SELECT JSON_EXTRACT(JSON_OBJECT('v', val), '$.v') AS v FROM v34_mid) z WHERE v >= 0",
          MID.length);
      val('V34J J3 JSON round trip keeps the total',
          "SELECT SUM(v) FROM (SELECT JSON_EXTRACT(JSON_OBJECT('v', val), '$.v') AS v FROM v34_mid) z", sum(MID, VAL));
      // IS JSON は列や文字列リテラルに対して書く（関数呼び出しを直接置くと解決できない）
      val('V34J J3 IS JSON over a derived column',
          "SELECT COUNT(*) FROM (SELECT JSON_OBJECT('a', id) AS j FROM v34_mid) z WHERE j IS JSON", MID.length);
      val('V34J J3 IS JSON OBJECT over a literal',
          "SELECT COUNT(*) FROM v34_mid WHERE '{\"a\":1}' IS JSON OBJECT", MID.length);
      val('V34J J3 IS JSON ARRAY over a literal',
          "SELECT COUNT(*) FROM v34_mid WHERE '[1,2]' IS JSON ARRAY", MID.length);
      val('V34J J3 IS JSON SCALAR over a literal',
          "SELECT COUNT(*) FROM v34_mid WHERE '5' IS JSON SCALAR", MID.length);
      val('V34J J3 IS NOT JSON as a predicate',
          "SELECT COUNT(*) FROM v34_mid WHERE txt IS NOT JSON", MID.length);
      val('V34J J3 JSON_EXISTS checks a path',
          "SELECT COUNT(*) FROM v34_mid WHERE JSON_EXISTS(JSON_OBJECT('a', id), '$.a')", MID.length);
      val('V34J J3 JSON_KEYS lists the keys', "SELECT JSON_KEYS('{\"a\":1,\"b\":2}')", '["a","b"]');
      val('V34J J3 JSON_SET changes a value',
          "SELECT JSON_EXTRACT(JSON_SET('{\"a\":1}', '$.a', 9), '$.a')", 9);
      val('V34J J3 JSON_REMOVE drops a key',
          "SELECT JSON_LENGTH(JSON_REMOVE('{\"a\":1,\"b\":2}', '$.a'))", 1);
      val('V34J J3 JSON_ARRAY builds an array of the right size',
          "SELECT JSON_LENGTH(JSON_ARRAY(1, 2, 3, 4, 5))", 5);

      // ---- J4. PIVOT / UNPIVOT ----
      t('V34J J4 PIVOT turns the sub column into columns', () => {
        const m = byKey(MID, r => r.grp);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => {
          const g = m.get(k);
          return { grp: k, s0: sum(g.filter(r => r.sub === 'S0'), VAL), s1: sum(g.filter(r => r.sub === 'S1'), VAL),
                   s2: sum(g.filter(r => r.sub === 'S2'), VAL), s3: sum(g.filter(r => r.sub === 'S3'), VAL) };
        });
        return expectDeep(rows("SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
                               "PIVOT (SUM(val) FOR sub IN ('S0', 'S1', 'S2', 'S3')) ORDER BY grp"), want);
      });
      t('V34J J4 PIVOT with COUNT', () => {
        const m = byKey(MID, r => r.grp);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => {
          const g = m.get(k);
          return { grp: k, s0: cnt(g, r => r.sub === 'S0'), s1: cnt(g, r => r.sub === 'S1'),
                   s2: cnt(g, r => r.sub === 'S2'), s3: cnt(g, r => r.sub === 'S3') };
        });
        return expectDeep(rows("SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
                               "PIVOT (COUNT(val) FOR sub IN ('S0', 'S1', 'S2', 'S3')) ORDER BY grp"), want);
      });
      t('V34J J4 PIVOT over the fact table by status', () => {
        const m = byKey(FACT, r => r.region);
        const want = REGIONS.map(k => {
          const g = m.get(k);
          return { region: k, paid: sum(g.filter(r => r.status === 'paid'), r => r.qty),
                   pending: sum(g.filter(r => r.status === 'pending'), r => r.qty),
                   cancelled: sum(g.filter(r => r.status === 'cancelled'), r => r.qty) };
        });
        return expectDeep(rows("SELECT * FROM (SELECT region, status, qty FROM v34_fact) src " +
                               "PIVOT (SUM(qty) FOR status IN ('paid', 'pending', 'cancelled')) ORDER BY region"), want);
      });
      val('V34J J4 PIVOT row count matches the number of groups',
          "SELECT COUNT(*) FROM (SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
          "PIVOT (SUM(val) FOR sub IN ('S0', 'S1', 'S2', 'S3'))) z", uniq(MID, r => r.grp));
      val('V34J J4 PIVOT with a value that never appears gives zero',
          "SELECT SUM(sx) FROM (SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
          "PIVOT (SUM(val) FOR sub IN ('SX'))) z", 0);
      val('V34J J4 PIVOT columns add back up to the total',
          "SELECT SUM(s0 + s1 + s2 + s3) FROM (SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
          "PIVOT (SUM(val) FOR sub IN ('S0', 'S1', 'S2', 'S3'))) z", sum(MID, VAL));
      val('V34J J4 PIVOT with MAX',
          "SELECT MAX(s0) FROM (SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
          "PIVOT (MAX(val) FOR sub IN ('S0'))) z",
          Math.max.apply(null, MID.filter(r => r.sub === 'S0').map(VAL)));
      t('V34J J4 UNPIVOT turns columns back into rows', () =>
        expectDeep(rows("SELECT * FROM (SELECT 1 AS id, 10 AS q1, 20 AS q2, 30 AS q3) t UNPIVOT (v FOR q IN (q1, q2, q3))"),
                   [{ id: 1, q: 'q1', v: 10 }, { id: 1, q: 'q2', v: 20 }, { id: 1, q: 'q3', v: 30 }]));
      val('V34J J4 UNPIVOT row count over several source rows',
          "SELECT COUNT(*) FROM (SELECT id, c0, c1, c2 FROM v34_wide WHERE id <= 20) t UNPIVOT (v FOR c IN (c0, c1, c2))",
          20 * 3);
      val('V34J J4 UNPIVOT keeps the totals',
          "SELECT SUM(v) FROM (SELECT id, c0, c1, c2 FROM v34_wide WHERE id <= 20) t UNPIVOT (v FOR c IN (c0, c1, c2))",
          sum(WIDE.filter(r => r.id <= 20), r => r.c0 + r.c1 + r.c2));
      val('V34J J4 UNPIVOT over ten columns',
          "SELECT COUNT(*) FROM (SELECT id, " + Array.from({ length: 10 }, (_, i) => 'c' + i).join(', ') +
          " FROM v34_wide WHERE id <= 30) t UNPIVOT (v FOR c IN (" +
          Array.from({ length: 10 }, (_, i) => 'c' + i).join(', ') + "))", 300);
      val('V34J J4 UNPIVOT then group again',
          "SELECT COUNT(*) FROM (SELECT c, SUM(v) AS s FROM (SELECT id, c0, c1, c2 FROM v34_wide) t " +
          "UNPIVOT (v FOR c IN (c0, c1, c2)) GROUP BY c) z", 3);
      val('V34J J4 PIVOT then UNPIVOT returns the same total',
          "SELECT SUM(v) FROM (SELECT * FROM (SELECT grp, sub, val FROM v34_mid) src " +
          "PIVOT (SUM(val) FOR sub IN ('S0', 'S1', 'S2', 'S3'))) p UNPIVOT (v FOR c IN (s0, s1, s2, s3))",
          sum(MID, VAL));

      // ---- J5. 配列 ----
      val('V34J J5 ARRAY_LENGTH of a literal array', "SELECT ARRAY_LENGTH(ARRAY[1, 2, 3, 4])", 4);
      val('V34J J5 ARRAY_POSITION finds an element', "SELECT ARRAY_POSITION(ARRAY[5, 6, 7], 7)", 3);
      val('V34J J5 ARRAY_POSITION returns NULL when missing',
          "SELECT COALESCE(ARRAY_POSITION(ARRAY[5, 6, 7], 9), -1)", -1);
      val('V34J J5 ARRAY_CONTAINS is true for a member', "SELECT ARRAY_CONTAINS(ARRAY[1, 2, 3], 2)", true);
      val('V34J J5 ARRAY_CONTAINS is false for a non-member', "SELECT ARRAY_CONTAINS(ARRAY[1, 2, 3], 9)", false);
      val('V34J J5 ARRAY_APPEND grows the array', "SELECT ARRAY_LENGTH(ARRAY_APPEND(ARRAY[1, 2], 3))", 3);
      val('V34J J5 ARRAY_PREPEND grows the array', "SELECT ARRAY_LENGTH(ARRAY_PREPEND(0, ARRAY[1, 2]))", 3);
      val('V34J J5 ARRAY_REMOVE shrinks the array', "SELECT ARRAY_LENGTH(ARRAY_REMOVE(ARRAY[1, 2, 3], 2))", 2);
      val('V34J J5 ARRAY_SORT orders the elements', "SELECT ARRAY_TO_STRING(ARRAY_SORT(ARRAY[3, 1, 2]), ',')", '1,2,3');
      val('V34J J5 ARRAY_TO_STRING joins the elements', "SELECT ARRAY_TO_STRING(ARRAY[1, 2, 3], '-')", '1-2-3');
      val('V34J J5 STRING_TO_ARRAY splits a string', "SELECT ARRAY_LENGTH(STRING_TO_ARRAY('a,b,c,d', ','))", 4);
      val('V34J J5 = ANY over an array literal',
          "SELECT COUNT(*) FROM v34_fact WHERE region = ANY(ARRAY['R0', 'R3', 'R6'])",
          cnt(FACT, r => ['R0', 'R3', 'R6'].indexOf(r.region) >= 0));
      val('V34J J5 <> ALL over an array literal',
          "SELECT COUNT(*) FROM v34_fact WHERE region <> ALL(ARRAY['R0', 'R3', 'R6'])",
          cnt(FACT, r => ['R0', 'R3', 'R6'].indexOf(r.region) < 0));
      val('V34J J5 ARRAY_AGG length matches the group size',
          "SELECT ARRAY_LENGTH(ARRAY_AGG(id)) FROM v34_mid WHERE grp = 'G5'", cnt(MID, r => r.grp === 'G5'));
      t('V34J J5 ARRAY_AGG per group', () => {
        const m = byKey(MID, r => r.grp);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT grp, ARRAY_LENGTH(ARRAY_AGG(val)) AS n FROM v34_mid GROUP BY grp ORDER BY grp"),
                          keys.map(k => ({ grp: k, n: m.get(k).length })));
      });
      val('V34J J5 a 500-element array literal',
          "SELECT ARRAY_LENGTH(ARRAY[" + Array.from({ length: 500 }, (_, i) => i).join(', ') + "])", 500);
      val('V34J J5 ARRAY_TO_STRING over a long array',
          "SELECT LENGTH(ARRAY_TO_STRING(ARRAY[" + Array.from({ length: 100 }, (_, i) => i % 10).join(', ') + "], ''))", 100);
      val('V34J J5 an array built from a column',
          "SELECT ARRAY_LENGTH(ARRAY_AGG(region)) FROM v34_fact WHERE id <= 100", 100);
      val('V34J J5 an array used in a join predicate',
          "SELECT COUNT(*) FROM v34_reg g WHERE g.code = ANY(ARRAY['R1', 'R2', 'R3'])", 3);
      val('V34J J5 an array of strings sorted',
          "SELECT ARRAY_TO_STRING(ARRAY_SORT(ARRAY['c', 'a', 'b']), '')", 'abc');

      // ---- J6. 全文検索 ----
      val('V34J J6 MATCH AGAINST finds the paid rows',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status) AGAINST ('paid')", cnt(FACT, r => r.status === 'paid'));
      val('V34J J6 MATCH AGAINST finds the pending rows',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status) AGAINST ('pending')", cnt(FACT, r => r.status === 'pending'));
      val('V34J J6 MATCH over two columns',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status, region) AGAINST ('paid')", cnt(FACT, r => r.status === 'paid'));
      val('V34J J6 MATCH in boolean mode with a prefix',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (txt) AGAINST ('ord*' IN BOOLEAN MODE)", FACT.length);
      val('V34J J6 MATCH in boolean mode with an exclusion',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status) AGAINST ('+paid -pending' IN BOOLEAN MODE)",
          cnt(FACT, r => r.status === 'paid'));
      val('V34J J6 MATCH that finds nothing',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status) AGAINST ('nothinghere')", 0);
      val('V34J J6 MATCH combined with another predicate',
          "SELECT COUNT(*) FROM v34_fact WHERE MATCH (status) AGAINST ('paid') AND region = 'R2'",
          cnt(FACT, r => r.status === 'paid' && r.region === 'R2'));
      val('V34J J6 MATCH over the mid table',
          "SELECT COUNT(*) FROM v34_mid WHERE MATCH (txt) AGAINST ('m1')", cnt(MID, r => r.txt === 'm1'));

      // ============================================================
      // K. 索引・EXPLAIN・結果の不変性
      //    同じ問い合わせが索引の有無で答えを変えないことを確かめる
      // ============================================================
      const K_QUERIES = [
        ["SELECT COUNT(*) FROM v34_fact WHERE cust_id = 7", cnt(FACT, r => r.cust_id === 7)],
        ["SELECT SUM(cents) FROM v34_fact WHERE cust_id = 7", sum(FACT.filter(r => r.cust_id === 7), r => r.cents)],
        ["SELECT COUNT(*) FROM v34_fact WHERE cust_id BETWEEN 10 AND 20", cnt(FACT, r => r.cust_id >= 10 && r.cust_id <= 20)],
        ["SELECT COUNT(*) FROM v34_fact WHERE cust_id IN (1, 2, 3, 4, 5)", cnt(FACT, r => r.cust_id <= 5)],
        ["SELECT COUNT(*) FROM v34_fact WHERE cust_id <> 7", cnt(FACT, r => r.cust_id !== 7)],
        ["SELECT COUNT(*) FROM v34_fact WHERE region = 'R3'", cnt(FACT, r => r.region === 'R3')],
        ["SELECT COUNT(*) FROM v34_fact WHERE region = 'R3' AND status = 'paid'",
          cnt(FACT, r => r.region === 'R3' && r.status === 'paid')],
        ["SELECT COUNT(*) FROM v34_fact WHERE status <> 'cancelled'", cnt(FACT, r => r.status !== 'cancelled')],
        ["SELECT SUM(qty) FROM v34_fact WHERE region = 'R5'", sum(FACT.filter(r => r.region === 'R5'), r => r.qty)],
        ["SELECT COUNT(DISTINCT cust_id) FROM v34_fact WHERE region = 'R2'",
          uniq(FACT.filter(r => r.region === 'R2'), r => r.cust_id)],
        ["SELECT COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'gold'",
          cnt(WIDEJOIN, x => x.c.tier === 'gold')],
        ["SELECT SUM(f.cents) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'silver'",
          sum(WIDEJOIN.filter(x => x.c.tier === 'silver'), x => x.f.cents)],
        ["SELECT COUNT(*) " + FOUR_WAY, FACT.length],
        ["SELECT SUM(f.qty) " + FOUR_WAY + "WHERE g.zone = 'west'",
          sum(WIDEJOIN.filter(x => x.r.zone === 'west'), x => x.f.qty)],
        ["SELECT COUNT(*) FROM (SELECT region, COUNT(*) AS n FROM v34_fact GROUP BY region) z", REGIONS.length],
        ["SELECT MAX(n) FROM (SELECT cust_id, COUNT(*) AS n FROM v34_fact GROUP BY cust_id) z",
          Math.max.apply(null, [...byKey(FACT, r => r.cust_id).values()].map(b => b.length))],
        ["SELECT COUNT(*) FROM v34_mid WHERE val = 18", cnt(MID, r => r.val === 18)],
        ["SELECT SUM(val) FROM v34_mid WHERE grp = 'G4'", sum(MID.filter(r => r.grp === 'G4'), VAL)],
        ["SELECT COUNT(*) FROM v34_mid WHERE grp = 'G4' AND sub = 'S1'",
          cnt(MID, r => r.grp === 'G4' && r.sub === 'S1')],
        ["SELECT COUNT(*) FROM v34_mid m JOIN v34_small s ON s.id = m.id", SMALL.length],
        ["SELECT COUNT(*) FROM v34_fact WHERE txt = 'ord-00500'", 1],
        ["SELECT COUNT(*) FROM v34_fact WHERE txt LIKE 'ord-001%'", 100],
        ["SELECT COUNT(*) FROM v34_fact WHERE nv IS NULL", cnt(FACT, r => r.nv === null)],
        ["SELECT COUNT(*) FROM v34_fact WHERE qty >= 5 AND cents < 20000",
          cnt(FACT, r => r.qty >= 5 && r.cents < 20000)],
        ["SELECT id FROM v34_fact ORDER BY cents DESC, id LIMIT 1",
          FACT.slice().sort((a, b) => b.cents - a.cents || a.id - b.id)[0].id],
        ["SELECT COUNT(*) FROM v34_fact WHERE EXISTS (SELECT 1 FROM v34_cust c WHERE c.id = v34_fact.cust_id AND c.tier = 'gold')",
          cnt(WIDEJOIN, x => x.c.tier === 'gold')],
        ["SELECT COUNT(*) FROM (SELECT DISTINCT cust_id, region FROM v34_fact) z",
          uniq(FACT, r => r.cust_id + '|' + r.region)],
        ["SELECT SUM(s) FROM (SELECT cust_id, SUM(cents) AS s FROM v34_fact GROUP BY cust_id) z", sum(FACT, r => r.cents)],
        ["SELECT COUNT(*) FROM (SELECT ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY id) AS rn FROM v34_fact) z WHERE rn = 1",
          uniq(FACT, r => r.cust_id)],
        ["SELECT COUNT(*) FROM v34_fact WHERE cust_id % 7 = 0", cnt(FACT, r => r.cust_id % 7 === 0)]
      ];
      K_QUERIES.forEach((c, i) => val('V34K K1#' + (i + 1) + ' without an index', c[0], c[1]));
      t('V34K K1 build the indexes', () => {
        ['v34_ix_cust', 'v34_ix_reg', 'v34_ix_txt', 'v34_ix_mid', 'v34_ix_midg']
          .forEach(n => q("DROP INDEX IF EXISTS " + n));
        let r = q("CREATE INDEX v34_ix_cust ON v34_fact (cust_id)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v34_ix_reg ON v34_fact (region, status)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v34_ix_txt ON v34_fact (txt)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v34_ix_mid ON v34_mid (val)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v34_ix_midg ON v34_mid (grp, sub)");
        if (r.error) throw new Error(r.error);
        return true;
      });
      K_QUERIES.forEach((c, i) => val('V34K K1#' + (i + 1) + ' with the indexes in place', c[0], c[1]));
      t('V34K K1 the index scan is actually chosen', () => {
        const ops = rows("EXPLAIN SELECT * FROM v34_fact WHERE cust_id = 7").map(x => x.Operation);
        if (ops.indexOf('INDEX SCAN') < 0) throw new Error('expected an INDEX SCAN but got ' + JSON.stringify(ops));
        return true;
      });
      t('V34K K1 the index survives a bulk update of another column', () => {
        run("UPDATE v34_fact SET nv = nv WHERE id <= 100");
        return expect(one("SELECT COUNT(*) FROM v34_fact WHERE cust_id = 7"), cnt(FACT, r => r.cust_id === 7));
      });
      t('V34K K1 SHOW INDEXES lists what was created', () => {
        const names = rows("SHOW INDEXES FROM v34_fact").map(x => x.Name);
        return ['v34_ix_cust', 'v34_ix_reg', 'v34_ix_txt'].every(n => names.indexOf(n) >= 0);
      });
      t('V34K K1 a unique index refuses a duplicate', () => {
        q("DROP TABLE IF EXISTS v34_iu");
        run("CREATE TABLE v34_iu (id INT, v INT)");
        run("INSERT INTO v34_iu (id, v) SELECT n, n FROM GENERATE_SERIES(1, 500) AS g(n)");
        run("CREATE UNIQUE INDEX v34_ix_iu ON v34_iu (v)");
        const bad = q("INSERT INTO v34_iu (id, v) VALUES (501, 250)");
        const ok = !!bad.error && one("SELECT COUNT(*) FROM v34_iu") === 500;
        q("DROP TABLE IF EXISTS v34_iu");
        return ok;
      });
      t('V34K K1 a partial index is accepted', () => {
        q("DROP INDEX IF EXISTS v34_ix_part");
        const r = q("CREATE INDEX v34_ix_part ON v34_fact (qty) WHERE qty > 5");
        const ok = !r.error && one("SELECT COUNT(*) FROM v34_fact WHERE qty > 5") === cnt(FACT, x => x.qty > 5);
        q("DROP INDEX IF EXISTS v34_ix_part");
        return ok;
      });
      t('V34K K1 dropping the indexes leaves the answers alone', () => {
        ['v34_ix_cust', 'v34_ix_reg', 'v34_ix_txt', 'v34_ix_mid', 'v34_ix_midg']
          .forEach(n => q("DROP INDEX IF EXISTS " + n));
        return expect(one("SELECT COUNT(*) FROM v34_fact WHERE cust_id = 7"), cnt(FACT, r => r.cust_id === 7));
      });

      // ---- K2. EXPLAIN の段 ----
      const explainOps = (sql) => rows("EXPLAIN " + sql).map(x => x.Operation);
      const K2 = [
        ["a plain scan", "SELECT * FROM v34_fact", ['TABLE SCAN']],
        ["a filtered scan", "SELECT * FROM v34_fact WHERE qty > 3", ['TABLE SCAN', 'FILTER']],
        ["a grouped query", "SELECT region, COUNT(*) FROM v34_fact GROUP BY region", ['TABLE SCAN', 'GROUP BY']],
        ["an ungrouped aggregate", "SELECT COUNT(*) FROM v34_fact", ['TABLE SCAN', 'AGGREGATE']],
        ["a DISTINCT query", "SELECT DISTINCT region FROM v34_fact", ['TABLE SCAN', 'DISTINCT']],
        ["a window query", "SELECT ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v34_fact", ['TABLE SCAN', 'WINDOW']],
        ["a sorted query", "SELECT * FROM v34_fact ORDER BY cents DESC", ['TABLE SCAN', 'ORDER BY']],
        ["a limited query", "SELECT * FROM v34_fact LIMIT 10", ['TABLE SCAN', 'LIMIT']],
        ["a two-table join", "SELECT * FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id", ['TABLE SCAN']],
        ["a four-table join", "SELECT COUNT(*) " + FOUR_WAY, ['TABLE SCAN', 'AGGREGATE']]
      ];
      K2.forEach((c, i) => {
        t('V34K K2#' + (i + 1) + ' EXPLAIN of ' + c[0] + ' names the expected steps', () => {
          const ops = explainOps(c[1]);
          c[2].forEach(op => { if (ops.indexOf(op) < 0) throw new Error('missing ' + op + ' in ' + JSON.stringify(ops)); });
          return true;
        });
        t('V34K K2#' + (i + 1) + ' EXPLAIN of ' + c[0] + ' numbers its steps', () => {
          const steps = rows("EXPLAIN " + c[1]).map(x => x.Step);
          return expectDeep(steps, steps.map((_, j) => j + 1));
        });
      });
      t('V34K K2 EXPLAIN estimates the row count of a scan', () =>
        expect(rows("EXPLAIN SELECT * FROM v34_fact")[0].Rows, FACT.length));
      t('V34K K2 EXPLAIN estimates the row count of the mid table', () =>
        expect(rows("EXPLAIN SELECT * FROM v34_mid")[0].Rows, MID.length));
      t('V34K K2 EXPLAIN QUERY PLAN is accepted', () => {
        const r = q("EXPLAIN QUERY PLAN SELECT * FROM v34_fact WHERE qty > 3");
        return !r.error && r.data.length > 0;
      });
      t('V34K K2 EXPLAIN (FORMAT JSON) returns parseable JSON', () => {
        const v = one("EXPLAIN (FORMAT JSON) SELECT * FROM v34_fact WHERE qty > 3");
        const parsed = JSON.parse(String(v));
        return Array.isArray(parsed) && parsed.length > 0;
      });
      t('V34K K2 EXPLAIN ANALYZE adds an actual-timing row', () => {
        const ops = rows("EXPLAIN ANALYZE SELECT COUNT(*) FROM v34_fact").map(x => x.Operation);
        return ops.indexOf('ACTUAL') >= 0;
      });
      t('V34K K2 EXPLAIN of a big query has several steps', () => {
        const ops = explainOps("SELECT c.tier, COUNT(*) AS n " + FOUR_WAY +
                               "WHERE f.qty > 3 GROUP BY c.tier ORDER BY n DESC LIMIT 2");
        if (ops.length < 4) throw new Error('expected several steps but got ' + JSON.stringify(ops));
        return true;
      });
      t('V34K K2 EXPLAIN does not run the statement', () => {
        q("DROP TABLE IF EXISTS v34_ex");
        run("CREATE TABLE v34_ex (id INT)");
        run("INSERT INTO v34_ex (id) VALUES (1)");
        q("EXPLAIN SELECT * FROM v34_ex");
        const ok = one("SELECT COUNT(*) FROM v34_ex") === 1;
        q("DROP TABLE IF EXISTS v34_ex");
        return ok;
      });

      // ---- K3. 表の情報 ----
      t('V34K K3 ANALYZE reports one row per column', () =>
        expect(rows("ANALYZE TABLE v34_fact").length, 11));
      t('V34K K3 ANALYZE counts the rows correctly', () =>
        expect(rows("ANALYZE TABLE v34_fact")[0].Rows, FACT.length));
      t('V34K K3 ANALYZE counts the distinct values correctly', () => {
        const r = rows("ANALYZE TABLE v34_fact").filter(x => x.Column === 'cust_id')[0];
        return expect(r.Distinct, uniq(FACT, x => x.cust_id));
      });
      t('V34K K3 ANALYZE finds the minimum and maximum', () => {
        const r = rows("ANALYZE TABLE v34_fact").filter(x => x.Column === 'cents')[0];
        return expect(r.Min, Math.min.apply(null, FACT.map(x => x.cents))) &&
               expect(r.Max, Math.max.apply(null, FACT.map(x => x.cents)));
      });
      t('V34K K3 ANALYZE counts the NULLs', () => {
        const r = rows("ANALYZE TABLE v34_fact").filter(x => x.Column === 'nv')[0];
        return expect(r.Nulls, cnt(FACT, x => x.nv === null));
      });
      t('V34K K3 CHECK TABLE reports the primary key as OK', () => {
        const r = rows("CHECK TABLE v34_fact");
        return r.every(x => x.Status === 'OK');
      });
      t('V34K K3 DESCRIBE lists every column', () => expect(rows("DESCRIBE v34_fact").length, 11));
      t('V34K K3 DESCRIBE lists the wide table columns', () => expect(rows("DESCRIBE v34_wide").length, 81));
      t('V34K K3 SHOW CREATE TABLE returns the definition', () => {
        const v = rows("SHOW CREATE TABLE v34_fact");
        return v.length === 1 && /CREATE TABLE/i.test(JSON.stringify(v[0]));
      });
      t('V34K K3 information_schema.columns knows the fact table', () =>
        expect(one("SELECT COUNT(*) FROM information_schema.columns WHERE TABLE_NAME = 'v34_fact'"), 11));
      t('V34K K3 information_schema.columns knows the wide table', () =>
        expect(one("SELECT COUNT(*) FROM information_schema.columns WHERE TABLE_NAME = 'v34_wide'"), 81));
      t('V34K K3 information_schema.tables lists the fixture tables', () => {
        const n = one("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_NAME LIKE 'v34_%'");
        return typeof n === 'number' && n >= 7;
      });
      t('V34K K3 PRAGMA table_info describes the fact table', () =>
        expect(rows("PRAGMA table_info(v34_fact)").length, 11));
      t('V34K K3 REINDEX is accepted', () => !q("REINDEX").error);
      t('V34K K3 the row count survives REINDEX', () => {
        q("REINDEX");
        return expect(one("SELECT COUNT(*) FROM v34_fact"), FACT.length);
      });

      // ---- K4. 同じ意味の書き換えは同じ答えになる ----
      const K4 = [
        ["a join and an IN subquery agree",
          "SELECT COUNT(DISTINCT f.id) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id WHERE c.tier = 'gold'",
          "SELECT COUNT(*) FROM v34_fact WHERE cust_id IN (SELECT id FROM v34_cust WHERE tier = 'gold')"],
        ["EXISTS and IN agree",
          "SELECT COUNT(*) FROM v34_mid m WHERE EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          "SELECT COUNT(*) FROM v34_mid WHERE val IN (SELECT a FROM v34_small)"],
        ["NOT EXISTS and NOT IN agree",
          "SELECT COUNT(*) FROM v34_mid m WHERE NOT EXISTS (SELECT 1 FROM v34_small s WHERE s.a = m.val)",
          "SELECT COUNT(*) FROM v34_mid WHERE val NOT IN (SELECT a FROM v34_small)"],
        ["an OR chain and an IN list agree",
          "SELECT COUNT(*) FROM v34_fact WHERE region = 'R0' OR region = 'R1' OR region = 'R2'",
          "SELECT COUNT(*) FROM v34_fact WHERE region IN ('R0', 'R1', 'R2')"],
        ["BETWEEN and a pair of comparisons agree",
          "SELECT COUNT(*) FROM v34_fact WHERE cents BETWEEN 5000 AND 15000",
          "SELECT COUNT(*) FROM v34_fact WHERE cents >= 5000 AND cents <= 15000"],
        ["a GROUP BY and a window aggregate agree",
          "SELECT SUM(s) FROM (SELECT grp, SUM(val) AS s FROM v34_mid GROUP BY grp) z",
          "SELECT SUM(s) FROM (SELECT DISTINCT grp, SUM(val) OVER (PARTITION BY grp) AS s FROM v34_mid) z"],
        ["a HAVING and an outer WHERE agree",
          "SELECT COUNT(*) FROM (SELECT grp FROM v34_mid GROUP BY grp HAVING COUNT(*) > 50) z",
          "SELECT COUNT(*) FROM (SELECT grp, COUNT(*) AS n FROM v34_mid GROUP BY grp) z WHERE n > 50"],
        ["a UNION and an OR agree",
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid WHERE grp = 'G1' UNION SELECT id FROM v34_mid WHERE grp = 'G2') z",
          "SELECT COUNT(*) FROM v34_mid WHERE grp = 'G1' OR grp = 'G2'"],
        ["a CASE sum and a FILTER sum agree",
          "SELECT SUM(CASE WHEN status = 'paid' THEN cents ELSE 0 END) FROM v34_fact",
          "SELECT SUM(cents) FILTER (WHERE status = 'paid') FROM v34_fact"],
        ["a LEFT JOIN IS NULL and a NOT EXISTS agree",
          "SELECT COUNT(*) FROM v34_mid m LEFT JOIN v34_small s ON s.id = m.id WHERE s.id IS NULL",
          "SELECT COUNT(*) FROM v34_mid m WHERE NOT EXISTS (SELECT 1 FROM v34_small s WHERE s.id = m.id)"],
        ["a CTE and a derived table agree",
          "WITH base AS (SELECT grp, val FROM v34_mid WHERE val > 10) SELECT SUM(val) FROM base",
          "SELECT SUM(val) FROM (SELECT grp, val FROM v34_mid WHERE val > 10) base"],
        ["a correlated subquery and a join agree",
          "SELECT SUM(k) FROM (SELECT (SELECT COUNT(*) FROM v34_mid m WHERE m.val = s.a) AS k FROM v34_small s) z",
          "SELECT COUNT(*) FROM v34_small s JOIN v34_mid m ON m.val = s.a"],
        ["DISTINCT and GROUP BY agree",
          "SELECT COUNT(*) FROM (SELECT DISTINCT grp, sub FROM v34_mid) z",
          "SELECT COUNT(*) FROM (SELECT grp, sub FROM v34_mid GROUP BY grp, sub) z"],
        ["COUNT(*) and SUM(1) agree", "SELECT COUNT(*) FROM v34_fact", "SELECT SUM(1) FROM v34_fact"],
        ["an INTERSECT and an IN agree",
          "SELECT COUNT(*) FROM (SELECT id FROM v34_mid INTERSECT SELECT id FROM v34_small) z",
          "SELECT COUNT(*) FROM v34_mid WHERE id IN (SELECT id FROM v34_small)"]
      ];
      K4.forEach((c, i) => t('V34K K4#' + (i + 1) + ' ' + c[0], () => {
        const a = one(c[1]), b = one(c[2]);
        if (!same(a, b)) throw new Error('the two forms disagree: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
        return true;
      }));

      // ============================================================
      // L. 総合シナリオ
      //    実際に書きそうな「全部入り」の問い合わせを模型と突き合わせる
      // ============================================================
      const DAY_MS = 86400000, BASE_MS = Date.UTC(2024, 0, 1);
      const dateOf = f => new Date(BASE_MS + f.dayoff * DAY_MS);
      const yearOf = f => dateOf(f).getUTCFullYear();
      const monthOf = f => dateOf(f).getUTCMonth() + 1;

      // ---- L1. 地域ごとの上位 n 顧客 ----
      REGIONS.forEach(rg => {
        const byCust = byKey(FACT.filter(f => f.region === rg), f => f.cust_id);
        const ranked = [...byCust.entries()].map(e => ({ cust: e[0], s: sum(e[1], f => f.cents) }))
                         .sort((a, b) => b.s - a.s || a.cust - b.cust);
        [1, 2, 3, 5, 10].forEach(n => {
          t('V34L L1 the top ' + n + ' customers of ' + rg + ' by revenue', () => {
            const got = rows("SELECT cust_id AS cust, SUM(cents) AS s FROM v34_fact WHERE region = '" + rg + "' " +
                             "GROUP BY cust_id ORDER BY s DESC, cust LIMIT " + n);
            return expectDeep(got, ranked.slice(0, n));
          });
        });
      });

      // ---- L2. 階層ごとの売上構成 ----
      t('V34L L2 revenue by tier and category', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat);
        const want = [...m.keys()].sort().map(k => ({ tier: k.split('|')[0], cat: k.split('|')[1],
                                                      orders: m.get(k).length, revenue: sum(m.get(k), x => x.f.cents) }));
        return expectDeep(rows("SELECT c.tier AS tier, p.cat AS cat, COUNT(*) AS orders, SUM(f.cents) AS revenue " +
                               FOUR_WAY + "GROUP BY c.tier, p.cat ORDER BY tier, cat"), want);
      });
      t('V34L L2 revenue by zone with a share column', () => {
        const total = sum(FACT, f => f.cents);
        const m = byKey(WIDEJOIN, x => x.r.zone);
        const keys = [...m.keys()].sort();
        const got = rows("SELECT g.zone AS zone, SUM(f.cents) AS revenue FROM v34_fact f " +
                         "JOIN v34_reg g ON f.region = g.code GROUP BY g.zone ORDER BY zone");
        expect(got.length, keys.length, 'zones');
        got.forEach((r, i) => expect(r.revenue, sum(m.get(keys[i]), x => x.f.cents), keys[i]));
        return expect(sum(got, r => r.revenue), total);
      });
      t('V34L L2 the paid share per region', () => {
        const m = byKey(FACT, f => f.region);
        const got = rows("SELECT region AS r, COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'paid') AS paid " +
                         "FROM v34_fact GROUP BY region ORDER BY r");
        got.forEach((row, i) => {
          const g = m.get(REGIONS[i]);
          expect(row.n, g.length, 'total');
          expect(row.paid, cnt(g, x => x.status === 'paid'), 'paid');
        });
        return true;
      });

      // ---- L3. 月次の推移 ----
      t('V34L L3 orders per calendar year', () => {
        const m = byKey(FACT, yearOf);
        const keys = [...m.keys()].sort((a, b) => a - b);
        return expectDeep(rows("SELECT EXTRACT(YEAR FROM ymd) AS y, COUNT(*) AS n FROM v34_fact " +
                               "GROUP BY EXTRACT(YEAR FROM ymd) ORDER BY y"),
                          keys.map(k => ({ y: k, n: m.get(k).length })));
      });
      t('V34L L3 orders per month of the year', () => {
        const m = byKey(FACT, monthOf);
        const keys = [...m.keys()].sort((a, b) => a - b);
        return expectDeep(rows("SELECT EXTRACT(MONTH FROM ymd) AS mm, COUNT(*) AS n FROM v34_fact " +
                               "GROUP BY EXTRACT(MONTH FROM ymd) ORDER BY mm"),
                          keys.map(k => ({ mm: k, n: m.get(k).length })));
      });
      t('V34L L3 revenue per year and month', () => {
        const m = byKey(FACT, f => yearOf(f) * 100 + monthOf(f));
        const keys = [...m.keys()].sort((a, b) => a - b);
        const got = rows("SELECT EXTRACT(YEAR FROM ymd) * 100 + EXTRACT(MONTH FROM ymd) AS ym, SUM(cents) AS s " +
                         "FROM v34_fact GROUP BY EXTRACT(YEAR FROM ymd) * 100 + EXTRACT(MONTH FROM ymd) ORDER BY ym");
        return expectDeep(got, keys.map(k => ({ ym: k, s: sum(m.get(k), f => f.cents) })));
      });
      t('V34L L3 the monthly totals add back up', () =>
        expect(one("SELECT SUM(s) FROM (SELECT EXTRACT(MONTH FROM ymd) AS mm, SUM(cents) AS s FROM v34_fact " +
                   "GROUP BY EXTRACT(MONTH FROM ymd)) z"), sum(FACT, f => f.cents)));
      t('V34L L3 the first and last order dates', () => {
        const r = rows("SELECT MIN(ymd) AS lo, MAX(ymd) AS hi FROM v34_fact")[0];
        return expect(r.lo, '2024-01-01') && expect(r.hi, '2025-12-30');
      });
      t('V34L L3 orders in the first quarter of 2024', () =>
        expect(one("SELECT COUNT(*) FROM v34_fact WHERE ymd >= DATE '2024-01-01' AND ymd < DATE '2024-04-01'"),
               cnt(FACT, f => f.dayoff < 91)));
      t('V34L L3 orders in a named month', () =>
        expect(one("SELECT COUNT(*) FROM v34_fact WHERE EXTRACT(YEAR FROM ymd) = 2024 AND EXTRACT(MONTH FROM ymd) = 6"),
               cnt(FACT, f => yearOf(f) === 2024 && monthOf(f) === 6)));

      // ---- L4. 全部入りの分析クエリ ----
      t('V34L L4 a report joining four tables with filters, grouping and ordering', () => {
        const hit = WIDEJOIN.filter(x => x.f.status !== 'cancelled' && x.p.active === 1 && x.c.credit >= 500);
        const m = byKey(hit, x => x.c.tier + '|' + x.r.zone);
        const want = [...m.entries()].map(e => ({ tier: e[0].split('|')[0], zone: e[0].split('|')[1],
                                                  orders: e[1].length, revenue: sum(e[1], x => x.f.cents),
                                                  buyers: uniq(e[1], x => x.f.cust_id) }))
                       .sort((a, b) => b.revenue - a.revenue || (a.tier < b.tier ? -1 : 1));
        const got = rows("SELECT c.tier AS tier, g.zone AS zone, COUNT(*) AS orders, SUM(f.cents) AS revenue, " +
                         "COUNT(DISTINCT f.cust_id) AS buyers " + FOUR_WAY +
                         "WHERE f.status <> 'cancelled' AND p.active = 1 AND c.credit >= 500 " +
                         "GROUP BY c.tier, g.zone ORDER BY revenue DESC, tier");
        return expectDeep(got, want);
      });
      t('V34L L4 a report with HAVING and a computed ratio', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat);
        const want = [...m.entries()].filter(e => e[1].length >= 100)
                       .map(e => ({ k: e[0], avg: sum(e[1], x => x.f.cents) / e[1].length }))
                       .filter(e => e.avg > 19000).length;
        return expect(one("SELECT COUNT(*) FROM (SELECT c.tier, p.cat, COUNT(*) AS n, SUM(f.cents) AS s " + FOUR_WAY +
                          "GROUP BY c.tier, p.cat HAVING COUNT(*) >= 100) z WHERE s * 1.0 / n > 19000"), want);
      });
      t('V34L L4 a report with a window ranking inside each zone', () => {
        const m = byKey(WIDEJOIN, x => x.r.zone);
        const want = [];
        [...m.keys()].sort().forEach(zone => {
          const byTier = byKey(m.get(zone), x => x.c.tier);
          const ranked = [...byTier.entries()].map(e => ({ zone: zone, tier: e[0], revenue: sum(e[1], x => x.f.cents) }))
                           .sort((a, b) => b.revenue - a.revenue || (a.tier < b.tier ? -1 : 1));
          ranked.forEach((r, i) => want.push({ zone: r.zone, tier: r.tier, revenue: r.revenue, rn: i + 1 }));
        });
        const got = rows("SELECT zone, tier, revenue, ROW_NUMBER() OVER (PARTITION BY zone ORDER BY revenue DESC, tier) AS rn " +
                         "FROM (SELECT g.zone AS zone, c.tier AS tier, SUM(f.cents) AS revenue " + FOUR_WAY +
                         "GROUP BY g.zone, c.tier) z ORDER BY zone, rn");
        return expectDeep(got, want);
      });
      t('V34L L4 a report built on a CTE chain', () => {
        const paid = FACT.filter(f => f.status === 'paid');
        const byCust = byKey(paid, f => f.cust_id);
        const want = [...byCust.values()].filter(b => sum(b, f => f.cents) > 100000).length;
        return expect(one("WITH paid AS (SELECT cust_id, cents FROM v34_fact WHERE status = 'paid'), " +
                          "per_cust AS (SELECT cust_id, SUM(cents) AS s FROM paid GROUP BY cust_id) " +
                          "SELECT COUNT(*) FROM per_cust WHERE s > 100000"), want);
      });
      t('V34L L4 a report combining a CTE, a join and a window', () => {
        const paid = WIDEJOIN.filter(x => x.f.status === 'paid');
        const m = byKey(paid, x => x.c.tier);
        const want = [...m.entries()].map(e => ({ tier: e[0], revenue: sum(e[1], x => x.f.cents) }))
                       .sort((a, b) => b.revenue - a.revenue).slice(0, 2).map(e => e.tier);
        const got = colOf("WITH paid AS (SELECT f.cust_id, f.cents FROM v34_fact f WHERE f.status = 'paid') " +
                          "SELECT tier FROM (SELECT c.tier AS tier, SUM(p.cents) AS revenue, " +
                          "ROW_NUMBER() OVER (ORDER BY SUM(p.cents) DESC) AS rn " +
                          "FROM paid p JOIN v34_cust c ON p.cust_id = c.id GROUP BY c.tier) z WHERE rn <= 2 ORDER BY rn", 'tier');
        return expectDeep(got, want);
      });
      t('V34L L4 a basket analysis over products', () => {
        const m = byKey(WIDEJOIN, x => x.p.cat);
        const keys = [...m.keys()].sort();
        const want = keys.map(k => ({ cat: k, orders: m.get(k).length, units: sum(m.get(k), x => x.f.qty),
                                      revenue: sum(m.get(k), x => x.f.cents) }));
        return expectDeep(rows("SELECT p.cat AS cat, COUNT(*) AS orders, SUM(f.qty) AS units, SUM(f.cents) AS revenue " +
                               "FROM v34_fact f JOIN v34_prod p ON f.prod_id = p.id GROUP BY p.cat ORDER BY cat"), want);
      });
      t('V34L L4 a cohort-style count by first order', () => {
        const first = new Map();
        FACT.forEach(f => { if (!first.has(f.cust_id) || f.id < first.get(f.cust_id)) first.set(f.cust_id, f.id); });
        const want = cnt([...first.values()], v => v <= 200);
        return expect(one("SELECT COUNT(*) FROM (SELECT cust_id, MIN(id) AS first_id FROM v34_fact GROUP BY cust_id) z " +
                          "WHERE first_id <= 200"), want);
      });
      t('V34L L4 a running revenue total per region', () => {
        const m = byKey(FACT, f => f.region);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT region AS r, MAX(rt) AS total FROM (SELECT region, " +
                               "SUM(cents) OVER (PARTITION BY region ORDER BY id ROWS UNBOUNDED PRECEDING) AS rt " +
                               "FROM v34_fact) z GROUP BY region ORDER BY r"),
                          keys.map(k => ({ r: k, total: sum(m.get(k), f => f.cents) })));
      });
      t('V34L L4 the customers who never cancelled', () => {
        const bad = new Set(FACT.filter(f => f.status === 'cancelled').map(f => f.cust_id));
        return expect(one("SELECT COUNT(*) FROM v34_cust c WHERE NOT EXISTS " +
                          "(SELECT 1 FROM v34_fact f WHERE f.cust_id = c.id AND f.status = 'cancelled')"),
                      cnt(CUST, c => !bad.has(c.id)));
      });
      t('V34L L4 the products above the overall average revenue', () => {
        const m = byKey(FACT, f => f.prod_id);
        const totals = [...m.values()].map(b => sum(b, f => f.cents));
        const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
        return expect(one("SELECT COUNT(*) FROM (SELECT prod_id, SUM(cents) AS s FROM v34_fact GROUP BY prod_id) z " +
                          "WHERE s > (SELECT AVG(s2) FROM (SELECT SUM(cents) AS s2 FROM v34_fact GROUP BY prod_id) y)"),
                      totals.filter(v => v > avg).length);
      });
      t('V34L L4 a pivoted status report per region', () => {
        const m = byKey(FACT, f => f.region);
        const want = REGIONS.map(k => {
          const g = m.get(k);
          return { region: k, paid: cnt(g, f => f.status === 'paid'), pending: cnt(g, f => f.status === 'pending'),
                   cancelled: cnt(g, f => f.status === 'cancelled') };
        });
        return expectDeep(rows("SELECT * FROM (SELECT region, status, id FROM v34_fact) src " +
                               "PIVOT (COUNT(id) FOR status IN ('paid', 'pending', 'cancelled')) ORDER BY region"), want);
      });
      t('V34L L4 a rollup report over region and status', () => {
        const detail = uniq(FACT, f => f.region + '|' + f.status);
        return expect(one("SELECT COUNT(*) FROM (SELECT region, status, COUNT(*) FROM v34_fact " +
                          "GROUP BY ROLLUP(region, status)) z"), detail + REGIONS.length + 1);
      });
      t('V34L L4 the busiest day of the calendar', () => {
        const m = byKey(FACT, f => f.dayoff);
        const best = Math.max.apply(null, [...m.values()].map(b => b.length));
        return expect(one("SELECT MAX(n) FROM (SELECT ymd, COUNT(*) AS n FROM v34_fact GROUP BY ymd) z"), best);
      });
      t('V34L L4 a report restricted by a large IN list', () => {
        const ids = Array.from({ length: 400 }, (_, i) => i * 5 + 1);
        const set = new Set(ids);
        const hit = FACT.filter(f => set.has(f.id));
        const m = byKey(hit, f => f.region);
        const keys = [...m.keys()].sort();
        return expectDeep(rows("SELECT region AS r, COUNT(*) AS n FROM v34_fact WHERE id IN (" + ids.join(', ') + ") " +
                               "GROUP BY region ORDER BY r"), keys.map(k => ({ r: k, n: m.get(k).length })));
      });
      t('V34L L4 a report over a UNION of two slices', () => {
        const want = cnt(FACT, f => f.status === 'paid') + cnt(FACT, f => f.status === 'pending');
        return expect(one("SELECT COUNT(*) FROM (SELECT id FROM v34_fact WHERE status = 'paid' UNION ALL " +
                          "SELECT id FROM v34_fact WHERE status = 'pending') z"), want);
      });
      t('V34L L4 a report with a correlated per-region average', () => {
        const m = byKey(FACT, f => f.region);
        return expect(one("SELECT COUNT(*) FROM v34_fact f WHERE f.cents > " +
                          "(SELECT AVG(f2.cents) FROM v34_fact f2 WHERE f2.region = f.region)"),
                      cnt(FACT, f => f.cents > mean(m.get(f.region), x => x.cents)));
      });
      t('V34L L4 a report with GROUPING SETS over three axes', () => {
        const want = uniq(WIDEJOIN, x => x.c.tier) + uniq(WIDEJOIN, x => x.p.cat) + uniq(WIDEJOIN, x => x.r.zone);
        return expect(one("SELECT COUNT(*) FROM (SELECT c.tier, p.cat, g.zone, COUNT(*) " + FOUR_WAY +
                          "GROUP BY GROUPING SETS ((c.tier), (p.cat), (g.zone))) z"), want);
      });
      t('V34L L4 a report whose totals match the ungrouped total', () => {
        const total = sum(FACT, f => f.cents);
        return expect(one("SELECT SUM(revenue) FROM (SELECT c.tier, p.cat, g.zone, f.status, SUM(f.cents) AS revenue " +
                          FOUR_WAY + "GROUP BY c.tier, p.cat, g.zone, f.status) z"), total);
      });
      t('V34L L4 a paged report keeps every group exactly once', () => {
        const m = byKey(WIDEJOIN, x => x.c.tier + '|' + x.p.cat);
        const total = m.size;
        const seen = [];
        for (let off = 0; off < total; off += 4) {
          seen.push.apply(seen, colOf("SELECT c.tier || '|' || p.cat AS k, COUNT(*) AS n " + FOUR_WAY +
                                      "GROUP BY c.tier, p.cat ORDER BY k LIMIT 4 OFFSET " + off, 'k'));
        }
        return expectDeep(seen, [...m.keys()].sort());
      });
      t('V34L L4 a deeply nested report still adds up', () => {
        const want = sum(FACT, f => f.cents);
        return expect(one("SELECT SUM(s) FROM (SELECT SUM(s) AS s FROM (SELECT SUM(s) AS s FROM " +
                          "(SELECT region, status, SUM(cents) AS s FROM v34_fact GROUP BY region, status) a " +
                          "GROUP BY region) b) c"), want);
      });
      t('V34L L4 a report joining an aggregate back to the detail', () => {
        const m = byKey(FACT, f => f.region);
        return expect(one("SELECT COUNT(*) FROM v34_fact f JOIN (SELECT region, AVG(cents) AS a FROM v34_fact GROUP BY region) z " +
                          "ON z.region = f.region WHERE f.cents > z.a"),
                      cnt(FACT, f => f.cents > mean(m.get(f.region), x => x.cents)));
      });
      t('V34L L4 a report over the wide table joined to the fact table', () => {
        const want = njoin(WIDE, FACT, (w, f) => w.id === f.id);
        return expect(one("SELECT COUNT(*) FROM v34_wide w JOIN v34_fact f ON f.id = w.id"), want);
      });
      t('V34L L4 a report over every fixture table at once', () => {
        const want = FACT.length;
        return expect(one("SELECT COUNT(*) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id " +
                          "JOIN v34_prod p ON f.prod_id = p.id JOIN v34_reg g ON f.region = g.code " +
                          "LEFT JOIN v34_mid m ON m.id = f.id LEFT JOIN v34_small s ON s.id = f.id " +
                          "LEFT JOIN v34_wide w ON w.id = f.id"), want);
      });
      t('V34L L4 the six-table report keeps the revenue total', () =>
        expect(one("SELECT SUM(f.cents) FROM v34_fact f JOIN v34_cust c ON f.cust_id = c.id " +
                   "JOIN v34_prod p ON f.prod_id = p.id JOIN v34_reg g ON f.region = g.code " +
                   "LEFT JOIN v34_mid m ON m.id = f.id LEFT JOIN v34_small s ON s.id = f.id"),
               sum(FACT, f => f.cents)));

      // ============================================================
      // M. 片付け
      // ============================================================
      t('V34M drop the fixture tables', () => {
        ['v34_fact', 'v34_cust', 'v34_prod', 'v34_reg', 'v34_mid', 'v34_small', 'v34_wide',
         'v34_wm', 'v34_wf', 'v34_wu', 'v34_wd', 'v34_wi', 'v34_wt', 'v34_wc', 'v34_wch', 'v34_wcp',
         'v34_wlog', 'v34_wsrc', 'v34_ex', 'v34_iu']
          .forEach(n => q("DROP TABLE IF EXISTS " + n));
        return ['v34_fact', 'v34_cust', 'v34_prod', 'v34_reg', 'v34_mid', 'v34_small', 'v34_wide']
          .every(n => !db.tables[n]);
      });
      t('V34M no v34 table is left behind', () =>
        expect(Object.keys(db.tables).filter(n => n.indexOf('v34_') === 0).length, 0));

      return T;
    }
