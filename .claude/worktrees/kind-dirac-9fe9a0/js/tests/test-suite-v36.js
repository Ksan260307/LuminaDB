    // ============================================================================
    // [Test Suite v36] - 多段 JOIN の網羅
    //
    //   v34 が「大型クエリを一通り」だったのに対し、v36 は **結合** だけを軸に
    //   組合せを一気に広げる。列 x 演算子 x 定数で作った述語を 4 表結合へ流し、
    //   結合種別・結合順序・自己結合・非等価結合・半/反結合・外部結合の連鎖を
    //   すべて JavaScript 側の模型と突き合わせる（差分テスト）。
    //
    //     A. フィクスチャ            F. 準結合・反結合
    //     B. 4 表結合 x 生成述語     G. USING / NATURAL
    //     C. 結合種別 x ON 条件      H. 結合してから集計
    //     D. 結合順序の入れ替え      I. APPLY / LATERAL
    //     E. 自己結合・非等価結合    J. 外部結合の連鎖 / 並べ替え / 索引の不変性
    //
    //   test-suite.js の tests 配列へ getV36Tests() のスプレッドで合流する
    // ============================================================================
    function getV36Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, rowsOf: rows, oneOf: one, numEq: same, expect, expectDeep, val, sum, cnt, uniq,
              byKey } = makeTestKit('V36');
      const njoin = (L, R, pred) => { let n = 0; for (const l of L) for (const r of R) if (pred(l, r)) n++; return n; };
      const sjoin = (L, R, pred, f) => { let s = 0; for (const l of L) for (const r of R) if (pred(l, r)) s += f(l, r); return s; };
      const nleft = (L, R, pred) => { let n = 0; for (const l of L) { let m = 0; for (const r of R) if (pred(l, r)) m++; n += (m || 1); } return n; };

      // ----------------------------------------------------------------
      // 模型（SQL 側と同じ規則で JavaScript でも作る）
      // ----------------------------------------------------------------
      const TIERS = ['gold', 'silver', 'bronze'];
      const FACT = [];
      for (let n = 1; n <= 2000; n++) {
        FACT.push({
          id: n, cust_id: 1 + (n % 120), prod_id: 1 + (n % 30), region: 'R' + (n % 6),
          qty: 1 + (n % 9), cents: 1000 + (n % 397) * 71,
          status: (n % 7 === 0) ? 'cancelled' : ((n % 3 === 0) ? 'pending' : 'paid'),
          nv: (n % 13 === 0) ? null : (n % 100)
        });
      }
      const CUST = [];
      for (let n = 1; n <= 120; n++) {
        CUST.push({ id: n, tier: TIERS[n % 3], region: 'R' + (n % 6), credit: 100 * (1 + (n % 15)) });
      }
      const PROD = [];
      for (let n = 1; n <= 30; n++) PROD.push({ id: n, cat: 'CAT' + (n % 5), active: (n % 4 === 0) ? 0 : 1 });
      const REG = [];
      for (let n = 0; n <= 5; n++) REG.push({ code: 'R' + n, zone: n < 3 ? 'west' : 'east' });
      const SMALL = [];
      for (let n = 1; n <= 200; n++) SMALL.push({ id: n, a: n % 20, b: n % 7, s: 's' + (n % 5) });

      const CUST_BY_ID = new Map(CUST.map(c => [c.id, c]));
      const PROD_BY_ID = new Map(PROD.map(p => [p.id, p]));
      const REG_BY_CODE = new Map(REG.map(r => [r.code, r]));
      // 4 表を貼り合わせた模型。B 以降の期待値はこれを絞り込んで作る
      const WJ = FACT.map(f => ({
        f: f, c: CUST_BY_ID.get(f.cust_id), p: PROD_BY_ID.get(f.prod_id), g: REG_BY_CODE.get(f.region)
      }));

      // ============================================================
      // A. フィクスチャ
      // ============================================================
      t('V36A build the fact table', () => {
        ['v36_f', 'v36_c', 'v36_p', 'v36_g', 'v36_s'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        let r = q("CREATE TABLE v36_f (id INT PRIMARY KEY, cust_id INT, prod_id INT, region TEXT, " +
                  "qty INT, cents INT, status TEXT, nv INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v36_f (id, cust_id, prod_id, region, qty, cents, status, nv) " +
              "SELECT n, 1 + (n % 120), 1 + (n % 30), 'R' || (n % 6), 1 + (n % 9), 1000 + (n % 397) * 71, " +
              "CASE WHEN n % 7 = 0 THEN 'cancelled' WHEN n % 3 = 0 THEN 'pending' ELSE 'paid' END, " +
              "CASE WHEN n % 13 = 0 THEN NULL ELSE n % 100 END FROM GENERATE_SERIES(1, 2000) AS g(n)");
        if (r.error) throw new Error(r.error);
        return expect(db.tables['v36_f'].rowCount, 2000);
      });
      t('V36A build the dimension tables', () => {
        let r = q("CREATE TABLE v36_c (id INT PRIMARY KEY, tier TEXT, region TEXT, credit INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v36_c (id, tier, region, credit) SELECT n, " +
              "CASE n % 3 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' ELSE 'bronze' END, " +
              "'R' || (n % 6), 100 * (1 + (n % 15)) FROM GENERATE_SERIES(1, 120) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v36_p (id INT PRIMARY KEY, cat TEXT, active INT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v36_p (id, cat, active) SELECT n, 'CAT' || (n % 5), " +
              "CASE WHEN n % 4 = 0 THEN 0 ELSE 1 END FROM GENERATE_SERIES(1, 30) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v36_g (code TEXT PRIMARY KEY, zone TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v36_g (code, zone) SELECT 'R' || n, CASE WHEN n < 3 THEN 'west' ELSE 'east' END " +
              "FROM GENERATE_SERIES(0, 5) AS g(n)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE TABLE v36_s (id INT PRIMARY KEY, a INT, b INT, s TEXT)");
        if (r.error) throw new Error(r.error);
        r = q("INSERT INTO v36_s (id, a, b, s) SELECT n, n % 20, n % 7, 's' || (n % 5) " +
              "FROM GENERATE_SERIES(1, 200) AS g(n)");
        if (r.error) throw new Error(r.error);
        return db.tables['v36_c'].rowCount === 120 && db.tables['v36_p'].rowCount === 30 &&
               db.tables['v36_g'].rowCount === 6 && db.tables['v36_s'].rowCount === 200;
      });
      val('V36A fact row count', "SELECT COUNT(*) FROM v36_f", FACT.length);
      val('V36A fact SUM(qty)', "SELECT SUM(qty) FROM v36_f", sum(FACT, r => r.qty));
      val('V36A fact SUM(cents)', "SELECT SUM(cents) FROM v36_f", sum(FACT, r => r.cents));
      val('V36A fact COUNT(nv)', "SELECT COUNT(nv) FROM v36_f", cnt(FACT, r => r.nv !== null));
      val('V36A the four-way join keeps every fact row',
          "SELECT COUNT(*) FROM v36_f f JOIN v36_c c ON f.cust_id = c.id JOIN v36_p p ON f.prod_id = p.id " +
          "JOIN v36_g g ON f.region = g.code", FACT.length);

      const FOUR = "FROM v36_f f JOIN v36_c c ON f.cust_id = c.id JOIN v36_p p ON f.prod_id = p.id " +
                   "JOIN v36_g g ON f.region = g.code ";

      // ============================================================
      // B. 4 表結合 x 生成述語
      //    列 x 演算子 x 定数を機械的に組んで、絞り込みの全組合せを流す
      // ============================================================
      const OPF = {
        '=': (a, b) => a === b, '<>': (a, b) => a !== b,
        '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b
      };
      const OPS = Object.keys(OPF);
      // NULL との比較は UNKNOWN。模型側も 3 値論理で持つ（true / false / null）。
      // false に倒してしまうと NOT (...) の答えがずれる（NOT UNKNOWN は UNKNOWN）
      const cmp = (getv, op, lit) => (x) => { const v = getv(x); return v === null || v === undefined ? null : OPF[op](v, lit); };
      const and3 = (a, b) => (x) => { const p = a(x), r = b(x); if (p === false || r === false) return false; return (p === null || r === null) ? null : true; };
      const or3 = (a, b) => (x) => { const p = a(x), r = b(x); if (p === true || r === true) return true; return (p === null || r === null) ? null : false; };
      const not3 = (a) => (x) => { const p = a(x); return p === null ? null : !p; };
      const isTrue = (f) => (x) => f(x) === true;
      const NUMCOLS = [
        ['f.qty', x => x.f.qty, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
        ['f.cents', x => x.f.cents, [1000, 5000, 12000, 20000, 24000, 28000, 29000, 30000]],
        ['f.prod_id', x => x.f.prod_id, [1, 5, 10, 15, 20, 25, 30, 31]],
        ['f.cust_id', x => x.f.cust_id, [1, 30, 60, 90, 119, 120]],
        ['f.nv', x => x.f.nv, [0, 20, 50, 80, 99]],
        ['c.credit', x => x.c.credit, [100, 400, 800, 1200, 1500]],
        ['p.active', x => x.p.active, [0, 1]],
        ['f.id', x => x.f.id, [1, 500, 1000, 1500, 2000]]
      ];
      const TXTCOLS = [
        ['f.region', x => x.f.region, ["'R0'", "'R2'", "'R5'"]],
        ['f.status', x => x.f.status, ["'paid'", "'pending'", "'cancelled'"]],
        ['c.tier', x => x.c.tier, ["'gold'", "'silver'", "'bronze'"]],
        ['c.region', x => x.c.region, ["'R1'", "'R4'"]],
        ['p.cat', x => x.p.cat, ["'CAT0'", "'CAT2'", "'CAT4'"]],
        ['g.zone', x => x.g.zone, ["'west'", "'east'"]]
      ];
      const B_PREDS = [];
      NUMCOLS.forEach(spec => OPS.forEach(op => spec[2].forEach(lit => {
        B_PREDS.push([spec[0] + ' ' + op + ' ' + lit, cmp(spec[1], op, lit)]);
      })));
      TXTCOLS.forEach(spec => OPS.forEach(op => spec[2].forEach(lit => {
        B_PREDS.push([spec[0] + ' ' + op + ' ' + lit, cmp(spec[1], op, lit.slice(1, -1))]);
      })));
      B_PREDS.forEach((pr, i) => {
        const hit = WJ.filter(isTrue(pr[1]));
        const tag = 'V36B#' + (i + 1) + ' [' + pr[0] + ']';
        val(tag + ' row count', "SELECT COUNT(*) " + FOUR + "WHERE " + pr[0], hit.length);
        val(tag + ' SUM(qty)', "SELECT SUM(f.qty) " + FOUR + "WHERE " + pr[0], sum(hit, x => x.f.qty));
        val(tag + ' distinct customers', "SELECT COUNT(DISTINCT f.cust_id) " + FOUR + "WHERE " + pr[0],
            uniq(hit, x => x.f.cust_id));
      });

      // ---- 複合述語（AND / OR / NOT） ----
      const B_COMBOS = [];
      for (let i = 0; i < 20; i++) {
        const a = B_PREDS[(i * 7) % B_PREDS.length], b = B_PREDS[(i * 13 + 5) % B_PREDS.length];
        B_COMBOS.push(['(' + a[0] + ') AND (' + b[0] + ')', and3(a[1], b[1])]);
        B_COMBOS.push(['(' + a[0] + ') OR (' + b[0] + ')', or3(a[1], b[1])]);
        B_COMBOS.push(['NOT (' + a[0] + ')', not3(a[1])]);
      }
      B_COMBOS.forEach((pr, i) => {
        const hit = WJ.filter(isTrue(pr[1]));
        val('V36B combo#' + (i + 1) + ' row count', "SELECT COUNT(*) " + FOUR + "WHERE " + pr[0], hit.length);
        val('V36B combo#' + (i + 1) + ' SUM(cents)', "SELECT SUM(f.cents) " + FOUR + "WHERE " + pr[0],
            sum(hit, x => x.f.cents));
      });
      // ---- 表をまたぐ述語（列 x 列） ----
      const B_CROSS = [
        ['f.qty * 100 > c.credit', x => x.f.qty * 100 > x.c.credit],
        ['f.qty * 100 <= c.credit', x => x.f.qty * 100 <= x.c.credit],
        ['f.cust_id > c.credit / 100', x => x.f.cust_id > x.c.credit / 100],
        ['c.region = g.code', x => x.c.region === x.g.code],
        ['c.region <> g.code', x => x.c.region !== x.g.code],
        ['f.prod_id + p.active > 20', x => x.f.prod_id + x.p.active > 20],
        ['f.cents / 1000 > f.qty', x => x.f.cents / 1000 > x.f.qty],
        ['f.qty + f.prod_id > 20', x => x.f.qty + x.f.prod_id > 20],
        ['f.cust_id % 7 = 0', x => x.f.cust_id % 7 === 0],
        ['f.cents % 2 = 0', x => x.f.cents % 2 === 0],
        ['LENGTH(c.tier) = 4', x => x.c.tier.length === 4],
        ['LENGTH(p.cat) = 4', x => x.p.cat.length === 4],
        ['SUBSTR(f.region, 2) = SUBSTR(c.region, 2)', x => x.f.region.slice(1) === x.c.region.slice(1)],
        ['UPPER(g.zone) = \'WEST\'', x => x.g.zone.toUpperCase() === 'WEST'],
        ['f.qty BETWEEN 3 AND 6', x => x.f.qty >= 3 && x.f.qty <= 6],
        ['f.cents NOT BETWEEN 5000 AND 20000', x => !(x.f.cents >= 5000 && x.f.cents <= 20000)],
        ['f.region IN (\'R0\', \'R2\', \'R4\')', x => ['R0', 'R2', 'R4'].indexOf(x.f.region) >= 0],
        ['c.tier NOT IN (\'gold\')', x => x.c.tier !== 'gold'],
        ['f.status LIKE \'p%\'', x => /^p/.test(x.f.status)],
        ['p.cat LIKE \'%2\'', x => /2$/.test(x.p.cat)]
      ];
      B_CROSS.forEach((pr, i) => {
        const hit = WJ.filter(pr[1]);
        val('V36B cross#' + (i + 1) + ' [' + pr[0] + '] row count', "SELECT COUNT(*) " + FOUR + "WHERE " + pr[0], hit.length);
        val('V36B cross#' + (i + 1) + ' [' + pr[0] + '] SUM(qty)', "SELECT SUM(f.qty) " + FOUR + "WHERE " + pr[0],
            sum(hit, x => x.f.qty));
        val('V36B cross#' + (i + 1) + ' [' + pr[0] + '] SUM(cents)', "SELECT SUM(f.cents) " + FOUR + "WHERE " + pr[0],
            sum(hit, x => x.f.cents));
      });

      // NOT は NULL を含む列に対して 3 値論理で効く（NULL 行は残らない）
      val('V36B NOT over a NULL-bearing column excludes the NULL rows',
          "SELECT COUNT(*) " + FOUR + "WHERE NOT (f.nv > 50)", cnt(WJ, x => x.f.nv !== null && !(x.f.nv > 50)));
      val('V36B IS NULL finds the NULL rows', "SELECT COUNT(*) " + FOUR + "WHERE f.nv IS NULL",
          cnt(WJ, x => x.f.nv === null));
      val('V36B IS NOT NULL and IS NULL partition the rows',
          "SELECT COUNT(*) " + FOUR + "WHERE f.nv IS NOT NULL OR f.nv IS NULL", FACT.length);

      // ============================================================
      // C. 結合種別 x ON 条件
      // ============================================================
      const C_ONS = [
        ["m.id = s.id", (m, s) => m.id === s.id],
        ["m.id = s.id AND s.b = 0", (m, s) => m.id === s.id && s.b === 0],
        ["m.id = s.id AND s.b > 3", (m, s) => m.id === s.id && s.b > 3],
        ["m.id = s.id AND s.s = 's1'", (m, s) => m.id === s.id && s.s === 's1'],
        ["m.id = s.id AND m.qty > 4", (m, s) => m.id === s.id && m.qty > 4],
        ["m.id = s.id AND m.status = 'paid'", (m, s) => m.id === s.id && m.status === 'paid'],
        ["m.id = s.id AND s.a = m.qty", (m, s) => m.id === s.id && s.a === m.qty],
        ["m.qty = s.b", (m, s) => m.qty === s.b]
      ];
      C_ONS.forEach((on, i) => {
        const matched = njoin(FACT, SMALL, on[1]);
        const leftKept = nleft(FACT, SMALL, on[1]);
        const rightKept = nleft(SMALL, FACT, (s, m) => on[1](m, s));
        const shapes = [
          ['INNER JOIN', matched, matched],
          ['LEFT JOIN', leftKept, matched],
          ['RIGHT JOIN', rightKept, matched],
          ['FULL OUTER JOIN', leftKept + (rightKept - matched), matched]
        ];
        shapes.forEach(sh => {
          const from = "FROM v36_f m " + sh[0] + " v36_s s ON " + on[1 - 1] + "";
          const fromSql = "FROM v36_f m " + sh[0] + " v36_s s ON " + on[0];
          val('V36C#' + (i + 1) + ' ' + sh[0] + ' [' + on[0] + '] row count', "SELECT COUNT(*) " + fromSql, sh[1]);
          val('V36C#' + (i + 1) + ' ' + sh[0] + ' [' + on[0] + '] matched pairs',
              "SELECT COUNT(m.id) + COUNT(s.id) - COUNT(*) " + fromSql, sh[2]);
          void from;
        });
      });

      // ============================================================
      // D. 結合順序を入れ替えても答えは変わらない
      // ============================================================
      const DIMS = {
        c: "JOIN v36_c c ON f.cust_id = c.id ",
        p: "JOIN v36_p p ON f.prod_id = p.id ",
        g: "JOIN v36_g g ON f.region  = g.code "
      };
      const PERMS = [['c', 'p', 'g'], ['c', 'g', 'p'], ['p', 'c', 'g'], ['p', 'g', 'c'], ['g', 'c', 'p'], ['g', 'p', 'c']];
      const D_WHERES = [
        ["c.tier <> 'bronze' AND p.active = 1", x => x.c.tier !== 'bronze' && x.p.active === 1],
        ["g.zone = 'west' AND f.qty >= 5", x => x.g.zone === 'west' && x.f.qty >= 5],
        ["p.cat IN ('CAT1', 'CAT3') AND c.credit > 600", x => ['CAT1', 'CAT3'].indexOf(x.p.cat) >= 0 && x.c.credit > 600],
        ["f.status = 'paid' AND c.region = g.code", x => x.f.status === 'paid' && x.c.region === x.g.code]
      ];
      D_WHERES.forEach((w, wi) => {
        const hit = WJ.filter(w[1]);
        PERMS.forEach(pm => {
          const from = "FROM v36_f f " + pm.map(k => DIMS[k]).join('') + "WHERE " + w[0];
          const tag = 'V36D w' + (wi + 1) + ' order ' + pm.join('-');
          val(tag + ' row count', "SELECT COUNT(*) " + from, hit.length);
          val(tag + ' SUM(cents)', "SELECT SUM(f.cents) " + from, sum(hit, x => x.f.cents));
          val(tag + ' distinct products', "SELECT COUNT(DISTINCT f.prod_id) " + from, uniq(hit, x => x.f.prod_id));
        });
      });

      // ============================================================
      // E. 自己結合・非等価結合
      // ============================================================
      const E_SELF = [
        ["s1.a = s2.b", (l, r) => l.a === r.b],
        ["s1.a = s2.a AND s1.id < s2.id", (l, r) => l.a === r.a && l.id < r.id],
        ["s1.b = s2.b AND s1.id <> s2.id", (l, r) => l.b === r.b && l.id !== r.id],
        ["s1.s = s2.s AND s1.id + 1 = s2.id", (l, r) => l.s === r.s && l.id + 1 === r.id],
        ["s1.id = s2.id + 5", (l, r) => l.id === r.id + 5],
        ["s1.a > s2.b", (l, r) => l.a > r.b],
        ["s1.a >= s2.a AND s1.b <= s2.b", (l, r) => l.a >= r.a && l.b <= r.b],
        ["s1.id BETWEEN s2.id AND s2.id + 2", (l, r) => l.id >= r.id && l.id <= r.id + 2],
        ["s1.a = s2.b AND s1.s = s2.s", (l, r) => l.a === r.b && l.s === r.s],
        ["s1.a + s2.b = 10", (l, r) => l.a + r.b === 10],
        ["s1.a * 2 = s2.a", (l, r) => l.a * 2 === r.a],
        ["ABS(s1.a - s2.a) = 1", (l, r) => Math.abs(l.a - r.a) === 1]
      ];
      E_SELF.forEach((c, i) => {
        val('V36E self#' + (i + 1) + ' [' + c[0] + '] row count',
            "SELECT COUNT(*) FROM v36_s s1 JOIN v36_s s2 ON " + c[0], njoin(SMALL, SMALL, c[1]));
        val('V36E self#' + (i + 1) + ' [' + c[0] + '] SUM(s2.a)',
            "SELECT SUM(s2.a) FROM v36_s s1 JOIN v36_s s2 ON " + c[0], sjoin(SMALL, SMALL, c[1], (l, r) => r.a));
      });
      val('V36E a three-way self join',
          "SELECT COUNT(*) FROM v36_s s1 JOIN v36_s s2 ON s1.a = s2.b JOIN v36_s s3 ON s2.a = s3.b",
          (() => { let n = 0; for (const x of SMALL) for (const y of SMALL) { if (x.a !== y.b) continue; for (const z of SMALL) if (y.a === z.b) n++; } return n; })());
      val('V36E a LEFT self join keeps the unmatched rows',
          "SELECT COUNT(*) FROM v36_s s1 LEFT JOIN v36_s s2 ON s1.a = s2.b", nleft(SMALL, SMALL, (l, r) => l.a === r.b));
      val('V36E the unmatched rows of a LEFT self join',
          "SELECT COUNT(*) FROM v36_s s1 LEFT JOIN v36_s s2 ON s1.a = s2.b WHERE s2.id IS NULL",
          cnt(SMALL, l => !SMALL.some(r => l.a === r.b)));
      val('V36E a CROSS JOIN is the product', "SELECT COUNT(*) FROM v36_s s CROSS JOIN v36_g g",
          SMALL.length * REG.length);
      val('V36E a comma join with a predicate equals the ON form',
          "SELECT COUNT(*) FROM v36_s s1, v36_s s2 WHERE s1.b = s2.b", njoin(SMALL, SMALL, (l, r) => l.b === r.b));

      // ============================================================
      // F. 準結合・反結合
      // ============================================================
      const SMALL_A = new Set(SMALL.map(s => s.a));
      const F_CASES = [];
      [['EXISTS', true], ['NOT EXISTS', false]].forEach(kind => {
        [['s.a = f.qty', (f, s) => s.a === f.qty], ['s.b = f.qty', (f, s) => s.b === f.qty],
         ['s.id = f.id', (f, s) => s.id === f.id], ['s.a = f.prod_id', (f, s) => s.a === f.prod_id]].forEach(p => {
          F_CASES.push([
            kind[0] + ' (' + p[0] + ')',
            "SELECT COUNT(*) FROM v36_f f WHERE " + kind[0] + " (SELECT 1 FROM v36_s s WHERE " + p[0] + ")",
            cnt(FACT, f => SMALL.some(s => p[1](f, s)) === kind[1])
          ]);
        });
      });
      [['IN', true], ['NOT IN', false]].forEach(kind => {
        [['qty', 'a', f => SMALL_A.has(f.qty)], ['prod_id', 'a', f => SMALL_A.has(f.prod_id)],
         ['qty', 'b', f => SMALL.some(s => s.b === f.qty)]].forEach(p => {
          F_CASES.push([
            kind[0] + ' ' + p[0] + '/' + p[1],
            "SELECT COUNT(*) FROM v36_f f WHERE f." + p[0] + " " + kind[0] + " (SELECT " + p[1] + " FROM v36_s)",
            cnt(FACT, f => p[2](f) === kind[1])
          ]);
        });
      });
      [['= ANY', f => SMALL_A.has(f.qty)], ['<> ALL', f => !SMALL_A.has(f.qty)],
       ['> ALL', f => SMALL.every(s => f.qty > s.b)], ['< ANY', f => SMALL.some(s => f.qty < s.b)],
       ['>= SOME', f => SMALL.some(s => f.qty >= s.b)]].forEach((p, i) => {
        const src = (i <= 1) ? 'a' : 'b';
        F_CASES.push([
          'quantified ' + p[0],
          "SELECT COUNT(*) FROM v36_f f WHERE f.qty " + p[0] + " (SELECT " + src + " FROM v36_s)",
          cnt(FACT, p[1])
        ]);
      });
      F_CASES.forEach((c, i) => {
        val('V36F#' + (i + 1) + ' ' + c[0], c[1], c[2]);
        val('V36F#' + (i + 1) + ' ' + c[0] + ' via a derived table',
            "SELECT COUNT(*) FROM (" + c[1].replace('SELECT COUNT(*) ', 'SELECT f.id ') + ") z", c[2]);
      });
      val('V36F a semi join written as JOIN plus DISTINCT',
          "SELECT COUNT(*) FROM (SELECT DISTINCT f.id FROM v36_f f JOIN v36_s s ON s.a = f.qty) z",
          cnt(FACT, f => SMALL_A.has(f.qty)));
      val('V36F an anti join written as LEFT JOIN IS NULL',
          "SELECT COUNT(*) FROM v36_f f LEFT JOIN (SELECT DISTINCT a FROM v36_s) s ON s.a = f.qty WHERE s.a IS NULL",
          cnt(FACT, f => !SMALL_A.has(f.qty)));

      // ============================================================
      // G. USING / NATURAL
      // ============================================================
      const FS_ID = FACT.filter(f => f.id <= 200);
      const G_SHAPES = [
        ['USING (id)', "FROM v36_f f JOIN v36_s s USING (id)"],
        ['ON f.id = s.id', "FROM v36_f f JOIN v36_s s ON f.id = s.id"],
        ['NATURAL JOIN', "FROM v36_f f NATURAL JOIN v36_s s"]
      ];
      G_SHAPES.forEach(sh => {
        val('V36G ' + sh[0] + ' row count', "SELECT COUNT(*) " + sh[1], FS_ID.length);
        val('V36G ' + sh[0] + ' SUM(f.qty)', "SELECT SUM(f.qty) " + sh[1], sum(FS_ID, f => f.qty));
        val('V36G ' + sh[0] + ' SUM(s.a)', "SELECT SUM(s.a) " + sh[1], sum(SMALL, s => s.a));
        val('V36G ' + sh[0] + ' distinct regions', "SELECT COUNT(DISTINCT f.region) " + sh[1], uniq(FS_ID, f => f.region));
      });
      val('V36G LEFT JOIN USING keeps every left row',
          "SELECT COUNT(*) FROM v36_f f LEFT JOIN v36_s s USING (id)", FACT.length);
      val('V36G LEFT JOIN USING counts the matches',
          "SELECT COUNT(s.a) FROM v36_f f LEFT JOIN v36_s s USING (id)", FS_ID.length);
      val('V36G USING (region) across the dimension',
          "SELECT COUNT(*) FROM v36_f f JOIN v36_c c USING (region)",
          njoin(FACT, CUST, (f, c) => f.region === c.region));
      val('V36G USING (region) SUM(qty)',
          "SELECT SUM(f.qty) FROM v36_f f JOIN v36_c c USING (region)",
          sjoin(FACT, CUST, (f, c) => f.region === c.region, f => f.qty));
      val('V36G the ON form of USING (region) agrees',
          "SELECT COUNT(*) FROM v36_f f JOIN v36_c c ON f.region = c.region",
          njoin(FACT, CUST, (f, c) => f.region === c.region));
      val('V36G NATURAL JOIN uses every shared column',
          "SELECT COUNT(*) FROM v36_f f NATURAL JOIN v36_c c",
          njoin(FACT, CUST, (f, c) => f.id === c.id && f.region === c.region));

      // ============================================================
      // H. 結合してから集計
      // ============================================================
      const H_GROUPS = [
        ['c.tier', x => x.c.tier], ['p.cat', x => x.p.cat], ['g.zone', x => x.g.zone],
        ['f.status', x => x.f.status], ['f.region', x => x.f.region],
        ['c.tier, p.cat', x => x.c.tier + '|' + x.p.cat],
        ['g.zone, f.status', x => x.g.zone + '|' + x.f.status],
        ['c.tier, g.zone', x => x.c.tier + '|' + x.g.zone],
        ['p.cat, f.status', x => x.p.cat + '|' + x.f.status],
        ['c.tier, p.cat, g.zone', x => x.c.tier + '|' + x.p.cat + '|' + x.g.zone]
      ];
      const H_AGGS = [
        ['COUNT(*)', g => g.length], ['SUM(f.qty)', g => sum(g, x => x.f.qty)],
        ['SUM(f.cents)', g => sum(g, x => x.f.cents)],
        ['MIN(f.cents)', g => Math.min.apply(null, g.map(x => x.f.cents))],
        ['MAX(f.cents)', g => Math.max.apply(null, g.map(x => x.f.cents))],
        ['COUNT(DISTINCT f.cust_id)', g => uniq(g, x => x.f.cust_id)],
        ['COUNT(DISTINCT f.prod_id)', g => uniq(g, x => x.f.prod_id)],
        ['COUNT(f.nv)', g => cnt(g, x => x.f.nv !== null)]
      ];
      H_GROUPS.forEach(grp => {
        const buckets = byKey(WJ, grp[1]);
        const keys = [...buckets.keys()].sort();
        H_AGGS.forEach(ag => {
          t('V36H GROUP BY ' + grp[0] + ' with ' + ag[0], () => {
            const cols = grp[0].split(',').map((c, i) => c.trim() + ' AS k' + i).join(', ');
            const ord = grp[0].split(',').map((c, i) => 'k' + i).join(', ');
            const got = rows("SELECT " + cols + ", " + ag[0] + " AS m " + FOUR +
                             "GROUP BY " + grp[0] + " ORDER BY " + ord);
            expect(got.length, keys.length, 'group count');
            keys.forEach((k, i) => expect(got[i].m, ag[1](buckets.get(k)), 'row ' + i));
            return true;
          });
        });
      });
      [1, 10, 50, 100, 200, 400].forEach(th => {
        const m = byKey(WJ, x => x.c.tier + '|' + x.p.cat);
        val('V36H HAVING COUNT(*) > ' + th + ' after the join',
            "SELECT COUNT(*) FROM (SELECT c.tier, p.cat " + FOUR + "GROUP BY c.tier, p.cat HAVING COUNT(*) > " + th + ") z",
            [...m.values()].filter(v => v.length > th).length);
      });
      val('V36H the joined subtotals add up to the grand total',
          "SELECT SUM(s) FROM (SELECT c.tier, p.cat, g.zone, SUM(f.cents) AS s " + FOUR +
          "GROUP BY c.tier, p.cat, g.zone) z", sum(FACT, f => f.cents));
      val('V36H the joined group counts add up to the row count',
          "SELECT SUM(n) FROM (SELECT c.tier, p.cat, g.zone, COUNT(*) AS n " + FOUR +
          "GROUP BY c.tier, p.cat, g.zone) z", FACT.length);

      // ============================================================
      // I. APPLY / LATERAL
      // ============================================================
      const I_INNERS = [
        ['COUNT(*)', "SELECT COUNT(*) AS k FROM v36_f f WHERE f.region = g.code", g => cnt(FACT, f => f.region === g.code)],
        ['SUM(qty)', "SELECT SUM(f.qty) AS k FROM v36_f f WHERE f.region = g.code", g => sum(FACT.filter(f => f.region === g.code), f => f.qty)],
        ['MAX(cents)', "SELECT MAX(f.cents) AS k FROM v36_f f WHERE f.region = g.code", g => Math.max.apply(null, FACT.filter(f => f.region === g.code).map(f => f.cents))],
        ['MIN(cents)', "SELECT MIN(f.cents) AS k FROM v36_f f WHERE f.region = g.code", g => Math.min.apply(null, FACT.filter(f => f.region === g.code).map(f => f.cents))],
        ['COUNT(DISTINCT cust)', "SELECT COUNT(DISTINCT f.cust_id) AS k FROM v36_f f WHERE f.region = g.code", g => uniq(FACT.filter(f => f.region === g.code), f => f.cust_id)],
        ['paid only', "SELECT COUNT(*) AS k FROM v36_f f WHERE f.region = g.code AND f.status = 'paid'", g => cnt(FACT, f => f.region === g.code && f.status === 'paid')]
      ];
      I_INNERS.forEach((inn, i) => {
        const want = sum(REG, g => inn[2](g));
        val('V36I CROSS APPLY#' + (i + 1) + ' ' + inn[0],
            "SELECT SUM(x.k) FROM v36_g g CROSS APPLY (" + inn[1] + ") x", want);
        val('V36I LATERAL#' + (i + 1) + ' ' + inn[0],
            "SELECT SUM(x.k) FROM v36_g g, LATERAL (" + inn[1] + ") x", want);
        val('V36I JOIN LATERAL ON TRUE#' + (i + 1) + ' ' + inn[0],
            "SELECT SUM(x.k) FROM v36_g g JOIN LATERAL (" + inn[1] + ") x ON TRUE", want);
        val('V36I APPLY#' + (i + 1) + ' ' + inn[0] + ' row count',
            "SELECT COUNT(*) FROM v36_g g CROSS APPLY (" + inn[1] + ") x", REG.length);
      });
      val('V36I two APPLY clauses in a row',
          "SELECT SUM(x.k + y.k) FROM v36_g g CROSS APPLY (SELECT COUNT(*) AS k FROM v36_f f WHERE f.region = g.code) x " +
          "CROSS APPLY (SELECT COUNT(*) AS k FROM v36_c c WHERE c.region = g.code) y", FACT.length + CUST.length);
      val('V36I OUTER APPLY keeps rows whose inner query is empty',
          "SELECT COUNT(*) FROM v36_g g OUTER APPLY (SELECT f.id FROM v36_f f WHERE f.region = g.code AND f.qty > 100) x",
          REG.length);
      val('V36I APPLY over a derived table on the left',
          "SELECT SUM(x.k) FROM (SELECT code FROM v36_g) z CROSS APPLY " +
          "(SELECT COUNT(*) AS k FROM v36_f f WHERE f.region = z.code) x", FACT.length);
      val('V36I APPLY grouped afterwards',
          "SELECT COUNT(*) FROM (SELECT g.zone AS zone, SUM(x.k) AS k FROM v36_g g CROSS APPLY " +
          "(SELECT COUNT(*) AS k FROM v36_f f WHERE f.region = g.code) x GROUP BY g.zone) z", uniq(REG, g => g.zone));

      // ============================================================
      // J. 外部結合の連鎖 / 並べ替え / 索引の不変性
      // ============================================================
      const J_KINDS = ['INNER', 'LEFT'];
      J_KINDS.forEach(k1 => J_KINDS.forEach(k2 => J_KINDS.forEach(k3 => {
        const tag = 'V36J chain ' + k1 + '-' + k2 + '-' + k3;
        const sql = "SELECT COUNT(*) FROM v36_f f " +
          k1 + " JOIN v36_c c ON f.cust_id = c.id " +
          k2 + " JOIN v36_p p ON f.prod_id = p.id " +
          k3 + " JOIN v36_g g ON f.region = g.code";
        // どの表も全 fact 行に必ず対応するので、種別を変えても行数は変わらない
        val(tag + ' row count', sql, FACT.length);
      })));
      const J_ORDERS = [
        ['f.id', (a, b) => a.f.id - b.f.id],
        ['f.cents DESC, f.id', (a, b) => b.f.cents - a.f.cents || a.f.id - b.f.id],
        ['c.tier, f.id', (a, b) => (a.c.tier < b.c.tier ? -1 : a.c.tier > b.c.tier ? 1 : 0) || a.f.id - b.f.id],
        ['p.cat DESC, f.id', (a, b) => (b.p.cat < a.p.cat ? -1 : b.p.cat > a.p.cat ? 1 : 0) || a.f.id - b.f.id],
        ['g.zone, f.cents DESC, f.id', (a, b) => (a.g.zone < b.g.zone ? -1 : a.g.zone > b.g.zone ? 1 : 0) || b.f.cents - a.f.cents || a.f.id - b.f.id],
        ['f.qty, f.id DESC', (a, b) => a.f.qty - b.f.qty || b.f.id - a.f.id]
      ];
      J_ORDERS.forEach((od, i) => {
        const want = WJ.slice().sort(od[1]).slice(0, 25).map(x => x.f.id);
        t('V36J order#' + (i + 1) + ' [' + od[0] + '] first 25 ids', () =>
          expectDeep(rows("SELECT f.id AS id " + FOUR + "ORDER BY " + od[0] + " LIMIT 25").map(r => r.id), want));
        val('V36J order#' + (i + 1) + ' [' + od[0] + '] first id',
            "SELECT f.id " + FOUR + "ORDER BY " + od[0] + " LIMIT 1", want[0]);
      });
      [0, 100, 500, 1000, 1900].forEach(off => {
        const want = WJ.slice().sort((a, b) => a.f.id - b.f.id).slice(off, off + 20).map(x => x.f.id);
        t('V36J paging at offset ' + off, () =>
          expectDeep(rows("SELECT f.id AS id " + FOUR + "ORDER BY f.id LIMIT 20 OFFSET " + off).map(r => r.id), want));
      });
      const J_INVARIANT = [
        ["SELECT COUNT(*) " + FOUR + "WHERE c.tier = 'gold'", cnt(WJ, x => x.c.tier === 'gold')],
        ["SELECT SUM(f.cents) " + FOUR + "WHERE p.cat = 'CAT2'", sum(WJ.filter(x => x.p.cat === 'CAT2'), x => x.f.cents)],
        ["SELECT COUNT(*) " + FOUR + "WHERE g.zone = 'east' AND f.qty > 4", cnt(WJ, x => x.g.zone === 'east' && x.f.qty > 4)],
        ["SELECT COUNT(DISTINCT f.cust_id) " + FOUR, uniq(WJ, x => x.f.cust_id)],
        ["SELECT COUNT(*) FROM v36_f f WHERE f.cust_id = 7", cnt(FACT, f => f.cust_id === 7)],
        ["SELECT SUM(qty) FROM v36_f WHERE region = 'R3'", sum(FACT.filter(f => f.region === 'R3'), f => f.qty)],
        ["SELECT COUNT(*) FROM v36_f f JOIN v36_s s ON s.id = f.id", FS_ID.length],
        ["SELECT COUNT(*) FROM v36_f f WHERE f.status = 'paid' AND f.qty >= 5",
          cnt(FACT, f => f.status === 'paid' && f.qty >= 5)],
        ["SELECT COUNT(*) FROM (SELECT c.tier, COUNT(*) AS n " + FOUR + "GROUP BY c.tier) z", TIERS.length],
        ["SELECT MAX(f.cents) " + FOUR + "WHERE c.tier = 'silver'",
          Math.max.apply(null, WJ.filter(x => x.c.tier === 'silver').map(x => x.f.cents))]
      ];
      J_INVARIANT.forEach((c, i) => val('V36J invariant#' + (i + 1) + ' without an index', c[0], c[1]));
      t('V36J build the indexes', () => {
        ['v36_ix_cust', 'v36_ix_rg', 'v36_ix_st'].forEach(n => q("DROP INDEX IF EXISTS " + n));
        let r = q("CREATE INDEX v36_ix_cust ON v36_f (cust_id)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v36_ix_rg ON v36_f (region)");
        if (r.error) throw new Error(r.error);
        r = q("CREATE INDEX v36_ix_st ON v36_f (status, qty)");
        if (r.error) throw new Error(r.error);
        return true;
      });
      J_INVARIANT.forEach((c, i) => val('V36J invariant#' + (i + 1) + ' with the indexes in place', c[0], c[1]));
      t('V36J drop the indexes', () => {
        ['v36_ix_cust', 'v36_ix_rg', 'v36_ix_st'].forEach(n => q("DROP INDEX IF EXISTS " + n));
        return expect(one("SELECT COUNT(*) FROM v36_f WHERE cust_id = 7"), cnt(FACT, f => f.cust_id === 7));
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V36Zz cleanup', () => {
        ['v36_f', 'v36_c', 'v36_p', 'v36_g', 'v36_s'].forEach(n => q("DROP TABLE IF EXISTS " + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v36_') === 0).length === 0;
      });

      return T;
    }
