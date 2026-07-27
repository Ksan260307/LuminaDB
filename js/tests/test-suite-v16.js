    // ============================================================================
    // [Test Suite v16] - 超複雑・大型クエリのテスト
    //
    //   方針:
    //     * 決定的擬似乱数(Lehmer MINSTD)で「受注スキーマ」の大きめフィクスチャを生成し、
    //       同じ JS 配列から (a) INSERT 文 と (b) 期待値 の両方を作る。
    //       エンジンの結果と、SQL を一切使わない JS 側の独立計算を突き合わせる。
    //     * 「大型」は 2 方向で攻める:
    //         - データが大きい（数千行に対する結合・集計・ウィンドウ）
    //         - SQL 文自体が大きい（長い IN / 多段 UNION / 深いネスト / 多数の列）
    //     * 相関サブクエリ・APPLY は行ごとに再実行されるため、小さい表に限定して使う。
    //
    //   test-suite.js の tests 配列へ getV16Tests() のスプレッドで合流する
    // ============================================================================
    function getV16Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const approx = (a, b) => a != null && Math.abs(a - b) < 1e-6;
      // エンジンの AVG は小数2桁へ丸める（_executeSelectPlan の実装に合わせる）
      const avg2 = (arr) => arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : 0;
      const sum = (arr) => arr.reduce((a, b) => a + b, 0);

      // ------------------------------------------------------------
      // 決定的擬似乱数（Lehmer MINSTD）。倍精度で厳密に計算できる乗数を使う
      // ------------------------------------------------------------
      let _s = 20260727 % 2147483647;
      const rnd = () => { _s = (_s * 48271) % 2147483647; return _s / 2147483647; };
      const ri = (n) => Math.floor(rnd() * n);

      // ------------------------------------------------------------
      // フィクスチャ（受注スキーマ）: 顧客 50 / 商品 30 / 受注 300 / 明細 900
      // ------------------------------------------------------------
      const REGIONS = ['EAST', 'WEST', 'NORTH', 'SOUTH', 'CENTRAL'];
      const TIERS = ['GOLD', 'SILVER', 'BRONZE'];
      const CATS = ['HW', 'SW', 'SVC', 'ACC'];
      const STATUSES = ['NEW', 'PAID', 'SHIP', 'DONE'];

      const CUST = [];
      for (let i = 1; i <= 50; i++) CUST.push({ id: i, nm: 'CUST' + String(i).padStart(3, '0'), region: REGIONS[ri(5)], tier: TIERS[ri(3)], credit: 100 + ri(50) * 20 });
      const PROD = [];
      for (let i = 1; i <= 30; i++) PROD.push({ id: i, nm: 'PROD' + String(i).padStart(3, '0'), cat: CATS[ri(4)], price: 50 + ri(60) * 25 });
      const ORD = [];
      for (let i = 1; i <= 300; i++) ORD.push({ id: 1000 + i, cid: 1 + ri(50), day: 1 + ri(90), st: STATUSES[ri(4)] });
      const ITEM = [];
      for (let i = 1; i <= 900; i++) ITEM.push({ id: i, oid: 1000 + 1 + ri(300), pid: 1 + ri(30), qty: 1 + ri(9) });

      // JS 側の索引と派生値（期待値計算に使う）
      const custById = {}; CUST.forEach(c => custById[c.id] = c);
      const prodById = {}; PROD.forEach(p => prodById[p.id] = p);
      const ordById = {}; ORD.forEach(o => ordById[o.id] = o);
      // 明細1行の売上 = 数量 × 単価
      const itemRev = (it) => it.qty * prodById[it.pid].price;
      // 「明細 → 受注 → 顧客」を結合した平坦ビュー（多重結合の期待値はここから作る）
      const FLAT = ITEM.map(it => {
        const o = ordById[it.oid], c = custById[o.cid], p = prodById[it.pid];
        return { iid: it.id, oid: o.id, cid: c.id, qty: it.qty, price: p.price, rev: it.qty * p.price,
                 region: c.region, tier: c.tier, cat: p.cat, st: o.st, day: o.day };
      });
      const groupBy = (rows, keyFn) => {
        const m = new Map();
        rows.forEach(r => { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
        return m;
      };
      const sqlStr = (v) => "'" + String(v).replace(/'/g, "''") + "'";

      // ------------------------------------------------------------
      // 0. フィクスチャ構築（1 テストで一括作成。以降のテストが共有する）
      // ------------------------------------------------------------
      T.push({ name: 'XL Setup: build warehouse fixture', fn: () => {
          ['xl_item', 'xl_ord', 'xl_prod', 'xl_cust'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
          db.executeQuery("CREATE TABLE xl_cust (id INTEGER PRIMARY KEY, nm TEXT, region TEXT, tier TEXT, credit INTEGER)");
          db.executeQuery("CREATE TABLE xl_prod (id INTEGER PRIMARY KEY, nm TEXT, cat TEXT, price INTEGER)");
          db.executeQuery("CREATE TABLE xl_ord (id INTEGER PRIMARY KEY, cid INTEGER, day INTEGER, st TEXT)");
          db.executeQuery("CREATE TABLE xl_item (id INTEGER PRIMARY KEY, oid INTEGER, pid INTEGER, qty INTEGER)");
          const r1 = db.executeQuery(`INSERT INTO xl_cust (id, nm, region, tier, credit) VALUES ${CUST.map(c => `(${c.id}, ${sqlStr(c.nm)}, ${sqlStr(c.region)}, ${sqlStr(c.tier)}, ${c.credit})`).join(', ')}`);
          const r2 = db.executeQuery(`INSERT INTO xl_prod (id, nm, cat, price) VALUES ${PROD.map(p => `(${p.id}, ${sqlStr(p.nm)}, ${sqlStr(p.cat)}, ${p.price})`).join(', ')}`);
          const r3 = db.executeQuery(`INSERT INTO xl_ord (id, cid, day, st) VALUES ${ORD.map(o => `(${o.id}, ${o.cid}, ${o.day}, ${sqlStr(o.st)})`).join(', ')}`);
          const r4 = db.executeQuery(`INSERT INTO xl_item (id, oid, pid, qty) VALUES ${ITEM.map(i => `(${i.id}, ${i.oid}, ${i.pid}, ${i.qty})`).join(', ')}`);
          if (r1.error || r2.error || r3.error || r4.error) return false;
          db.executeQuery("CREATE INDEX ix_item_oid ON xl_item (oid)");
          db.executeQuery("CREATE INDEX ix_ord_cid ON xl_ord (cid)");
          const c = db.executeQuery("SELECT COUNT(*) AS c FROM xl_item").data[0].c;
          return c === ITEM.length;
      }});
      push('XL Setup: cust count', "SELECT COUNT(*) AS c FROM xl_cust", r => r.data[0].c === CUST.length);
      push('XL Setup: prod count', "SELECT COUNT(*) AS c FROM xl_prod", r => r.data[0].c === PROD.length);
      push('XL Setup: ord count', "SELECT COUNT(*) AS c FROM xl_ord", r => r.data[0].c === ORD.length);
      push('XL Setup: item count', "SELECT COUNT(*) AS c FROM xl_item", r => r.data[0].c === ITEM.length);

      // ============================================================
      // A. 大型 SQL 文（文そのものが巨大なケース）
      // ============================================================
      // A1. 長い IN / NOT IN リスト
      [5, 10, 25, 50, 100, 150, 200, 300].forEach(n => {
        const ids = Array.from({ length: n }, (_, i) => i + 1);
        const inSet = new Set(ids);
        push(`XL-A in ${n}`, `SELECT COUNT(*) AS c FROM xl_cust WHERE id IN (${ids.join(', ')})`,
          r => r.data[0].c === CUST.filter(c => inSet.has(c.id)).length);
        push(`XL-A notin ${n}`, `SELECT COUNT(*) AS c FROM xl_cust WHERE id NOT IN (${ids.join(', ')})`,
          r => r.data[0].c === CUST.filter(c => !inSet.has(c.id)).length);
        push(`XL-A in sum ${n}`, `SELECT SUM(credit) AS s FROM xl_cust WHERE id IN (${ids.join(', ')})`,
          r => r.data[0].s === sum(CUST.filter(c => inSet.has(c.id)).map(c => c.credit)));
      });
      // A2. 多段 UNION ALL / UNION
      for (let n = 2; n <= 30; n++) {
        const segs = Array.from({ length: n }, (_, i) => `SELECT ${i + 1} AS v`).join(' UNION ALL ');
        push(`XL-A unionall ${n}`, segs, r => r.data.length === n && r.data[n - 1].v === n);
      }
      for (let n = 2; n <= 20; n++) {
        // 同じ値を 2 回ずつ並べ、UNION（重複除去）で n 件になることを確認
        const segs = Array.from({ length: n * 2 }, (_, i) => `SELECT ${Math.floor(i / 2) + 1} AS v`).join(' UNION ');
        push(`XL-A union distinct ${n}`, segs, r => r.data.length === n);
      }
      // A3. 長い AND / OR チェーン
      [5, 10, 20, 30, 40, 50].forEach(n => {
        const andTerms = Array.from({ length: n }, (_, i) => `id <> ${i + 1}`).join(' AND ');
        push(`XL-A and ${n}`, `SELECT COUNT(*) AS c FROM xl_cust WHERE ${andTerms}`,
          r => r.data[0].c === CUST.filter(c => c.id > n).length);
        const orTerms = Array.from({ length: n }, (_, i) => `id = ${i + 1}`).join(' OR ');
        push(`XL-A or ${n}`, `SELECT COUNT(*) AS c FROM xl_cust WHERE ${orTerms}`,
          r => r.data[0].c === CUST.filter(c => c.id <= n).length);
        // AND と OR の混在（優先順位も併せて検証）
        const mixed = Array.from({ length: n }, (_, i) => `(id = ${i + 1} AND credit >= 0)`).join(' OR ');
        push(`XL-A mixed ${n}`, `SELECT COUNT(*) AS c FROM xl_cust WHERE ${mixed}`,
          r => r.data[0].c === CUST.filter(c => c.id <= n).length);
      });
      // A4. 深くネストした CASE
      for (let d = 1; d <= 20; d++) {
        let expr = String(d);
        for (let i = d - 1; i >= 1; i--) expr = `CASE WHEN 1 = 0 THEN ${i} ELSE ${expr} END`;
        push(`XL-A case depth ${d}`, `SELECT ${expr} AS x`, r => r.data[0].x === d);
      }
      // A5. 深くネストした関数呼び出し
      for (let d = 1; d <= 20; d++) {
        push(`XL-A fn depth ${d}`, `SELECT ${'ABS('.repeat(d)}-7${')'.repeat(d)} AS x`, r => r.data[0].x === 7);
      }
      for (let d = 1; d <= 12; d++) {
        // ROUND(ROUND(...(3.456, 2)...)) は 2 桁丸めが冪等であることの確認
        push(`XL-A round depth ${d}`, `SELECT ${'ROUND('.repeat(d)}3.456${', 2)'.repeat(d)} AS x`, r => approx(r.data[0].x, 3.46));
      }
      // A6. 多数の SELECT 列
      [10, 20, 40, 60, 80].forEach(n => {
        const cols = Array.from({ length: n }, (_, i) => `${i + 1} AS c${i + 1}`).join(', ');
        push(`XL-A cols ${n}`, `SELECT ${cols}`,
          r => Object.keys(r.data[0]).length === n && r.data[0]['c' + n] === n && r.data[0].c1 === 1);
      });
      // A7. 長い CONCAT / 算術チェーン / 深い括弧
      [5, 10, 20, 40].forEach(n => {
        const parts = Array.from({ length: n }, (_, i) => `'${i % 10}'`).join(', ');
        const expStr = Array.from({ length: n }, (_, i) => String(i % 10)).join('');
        push(`XL-A concat ${n}`, `SELECT CONCAT(${parts}) AS x`, r => r.data[0].x === expStr);
        const addChain = Array.from({ length: n }, (_, i) => String(i + 1)).join(' + ');
        push(`XL-A add ${n}`, `SELECT ${addChain} AS x`, r => r.data[0].x === (n * (n + 1)) / 2);
      });
      for (let d = 1; d <= 15; d++) {
        push(`XL-A paren ${d}`, `SELECT ${'('.repeat(d)}1 + 1${')'.repeat(d)} * 3 AS x`, r => r.data[0].x === 6);
      }
      // A8. 巨大な VALUES / 複数行 INSERT のラウンドトリップ
      [50, 200, 500].forEach(n => {
        T.push({ name: `XL-A bulk insert ${n}`, fn: () => {
            const tn = `xl_bulk_${n}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER, v INTEGER)`);
            const vals = Array.from({ length: n }, (_, i) => `(${i + 1}, ${(i + 1) * 3})`).join(', ');
            const ins = db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES ${vals}`);
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            const s = db.executeQuery(`SELECT SUM(v) AS s FROM ${tn}`).data[0].s;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return !ins.error && c === n && s === 3 * (n * (n + 1)) / 2;
        }});
      });

      // ============================================================
      // B. 多段ネストのサブクエリ
      // ============================================================
      // B1. スカラーサブクエリの入れ子
      for (let d = 1; d <= 8; d++) {
        let q = 'SELECT 42 AS v';
        for (let i = 0; i < d; i++) q = `SELECT (${q}) AS v`;
        push(`XL-B scalar nest ${d}`, q, r => r.data[0].v === 42);
      }
      // B2. FROM サブクエリの入れ子
      for (let d = 1; d <= 8; d++) {
        let q = 'SELECT id FROM xl_cust WHERE id <= 20';
        for (let i = 0; i < d; i++) q = `SELECT id FROM (${q}) n${i}`;
        push(`XL-B from nest ${d}`, `SELECT COUNT(*) AS c FROM (${q}) z`, r => r.data[0].c === 20);
      }
      // B3. FROM サブクエリを重ねながら段階的に絞る
      for (let d = 1; d <= 8; d++) {
        let q = 'SELECT id, credit FROM xl_cust';
        for (let i = 0; i < d; i++) q = `SELECT id, credit FROM (${q}) n${i} WHERE id > ${i}`;
        const exp = CUST.filter(c => c.id > d - 1).length;
        push(`XL-B nest filter ${d}`, `SELECT COUNT(*) AS c FROM (${q}) z`, r => r.data[0].c === exp);
      }
      // B4. IN サブクエリの連鎖
      [10, 20, 30, 40, 50].forEach(n => {
        const exp = ORD.filter(o => o.cid <= n).length;
        push(`XL-B in subq ${n}`,
          `SELECT COUNT(*) AS c FROM xl_ord WHERE cid IN (SELECT id FROM xl_cust WHERE id <= ${n})`,
          r => r.data[0].c === exp);
        const exp2 = ITEM.filter(it => ORD.find(o => o.id === it.oid && o.cid <= n)).length;
        push(`XL-B in subq 2level ${n}`,
          `SELECT COUNT(*) AS c FROM xl_item WHERE oid IN (SELECT id FROM xl_ord WHERE cid IN (SELECT id FROM xl_cust WHERE id <= ${n}))`,
          r => r.data[0].c === exp2);
      });
      // B5. EXISTS / NOT EXISTS（小さい表に限定）
      REGIONS.forEach(rg => {
        const exp = CUST.filter(c => c.region === rg && ORD.some(o => o.cid === c.id)).length;
        push(`XL-B exists ${rg}`,
          `SELECT COUNT(*) AS c FROM xl_cust c WHERE c.region = ${sqlStr(rg)} AND EXISTS (SELECT 1 FROM xl_ord o WHERE o.cid = c.id)`,
          r => r.data[0].c === exp);
        const exp2 = CUST.filter(c => c.region === rg && !ORD.some(o => o.cid === c.id)).length;
        push(`XL-B not exists ${rg}`,
          `SELECT COUNT(*) AS c FROM xl_cust c WHERE c.region = ${sqlStr(rg)} AND NOT EXISTS (SELECT 1 FROM xl_ord o WHERE o.cid = c.id)`,
          r => r.data[0].c === exp2);
      });
      // B6. 相関サブクエリ（顧客 50 行のみを走査）
      [0, 3, 6, 9, 12].forEach(th => {
        const exp = CUST.filter(c => ORD.filter(o => o.cid === c.id).length > th).length;
        push(`XL-B corr count > ${th}`,
          `SELECT COUNT(*) AS c FROM xl_cust c WHERE (SELECT COUNT(*) FROM xl_ord o WHERE o.cid = c.id) > ${th}`,
          r => r.data[0].c === exp);
      });
      TIERS.forEach(tr => {
        const exp = CUST.filter(c => c.tier === tr).map(c => ORD.filter(o => o.cid === c.id).length);
        push(`XL-B corr scalar ${tr}`,
          `SELECT SUM((SELECT COUNT(*) FROM xl_ord o WHERE o.cid = c.id)) AS s FROM xl_cust c WHERE c.tier = ${sqlStr(tr)}`,
          r => r.data[0].s === sum(exp));
      });
      // B7. サブクエリ + 集計 + HAVING の複合
      [1, 2, 3, 5, 8].forEach(th => {
        const cnt = groupBy(ORD, o => o.cid);
        const exp = [...cnt.entries()].filter(([, v]) => v.length > th).length;
        push(`XL-B group having ${th}`,
          `SELECT COUNT(*) AS c FROM (SELECT cid, COUNT(*) AS n FROM xl_ord GROUP BY cid HAVING COUNT(*) > ${th}) z`,
          r => r.data[0].c === exp);
      });

      // ============================================================
      // C. 多重結合（3〜5 表 + 集計 + 絞り込み）
      // ============================================================
      // C1. 3 表結合の行数と売上合計
      push('XL-C join3 rows', "SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id",
        r => r.data[0].c === FLAT.length);
      push('XL-C join3 revenue', "SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_prod p ON i.pid = p.id",
        r => r.data[0].s === sum(ITEM.map(itemRev)));
      push('XL-C join4 rows', "SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id",
        r => r.data[0].c === FLAT.length);
      push('XL-C join4 revenue', "SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id",
        r => r.data[0].s === sum(FLAT.map(f => f.rev)));
      // C2. 地域別・階層別・カテゴリ別・状態別の集計（4 表結合 + GROUP BY）
      REGIONS.forEach(rg => {
        const f = FLAT.filter(x => x.region === rg);
        push(`XL-C region rev ${rg}`,
          `SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id WHERE c.region = ${sqlStr(rg)}`,
          r => (r.data[0].s || 0) === sum(f.map(x => x.rev)));
        push(`XL-C region rows ${rg}`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)}`,
          r => r.data[0].c === f.length);
        push(`XL-C region qty ${rg}`,
          `SELECT SUM(i.qty) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)}`,
          r => (r.data[0].s || 0) === sum(f.map(x => x.qty)));
        push(`XL-C region avgrev ${rg}`,
          `SELECT AVG(i.qty * p.price) AS a FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id WHERE c.region = ${sqlStr(rg)}`,
          r => approx(r.data[0].a, avg2(f.map(x => x.rev))));
      });
      TIERS.forEach(tr => CATS.forEach(ct => {
        const f = FLAT.filter(x => x.tier === tr && x.cat === ct);
        push(`XL-C tier×cat ${tr}/${ct}`,
          `SELECT COUNT(*) AS c, SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id WHERE c.tier = ${sqlStr(tr)} AND p.cat = ${sqlStr(ct)}`,
          r => r.data[0].c === f.length && (r.data[0].s || 0) === sum(f.map(x => x.rev)));
      }));
      STATUSES.forEach(st => {
        const f = FLAT.filter(x => x.st === st);
        push(`XL-C status ${st}`,
          `SELECT COUNT(*) AS c, SUM(i.qty) AS q FROM xl_item i JOIN xl_ord o ON i.oid = o.id WHERE o.st = ${sqlStr(st)}`,
          r => r.data[0].c === f.length && (r.data[0].q || 0) === sum(f.map(x => x.qty)));
      });
      // C3. GROUP BY の結果セット全体を照合（キーでソートして比較）
      T.push({ name: 'XL-C groupby region full', fn: () => {
          const r = db.executeQuery("SELECT c.region AS region, COUNT(*) AS n, SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id GROUP BY c.region ORDER BY c.region");
          if (r.error) return false;
          const g = groupBy(FLAT, x => x.region);
          const exp = [...g.keys()].sort().map(k => `${k}:${g.get(k).length}:${sum(g.get(k).map(x => x.rev))}`).join('|');
          const got = r.data.map(x => `${x.region}:${x.n}:${x.s}`).join('|');
          return got === exp;
      }});
      T.push({ name: 'XL-C groupby cat full', fn: () => {
          const r = db.executeQuery("SELECT p.cat AS cat, COUNT(*) AS n, SUM(i.qty) AS q FROM xl_item i JOIN xl_prod p ON i.pid = p.id GROUP BY p.cat ORDER BY p.cat");
          if (r.error) return false;
          const g = groupBy(ITEM, it => prodById[it.pid].cat);
          const exp = [...g.keys()].sort().map(k => `${k}:${g.get(k).length}:${sum(g.get(k).map(x => x.qty))}`).join('|');
          return r.data.map(x => `${x.cat}:${x.n}:${x.q}`).join('|') === exp;
      }});
      T.push({ name: 'XL-C groupby region×tier full', fn: () => {
          const r = db.executeQuery("SELECT c.region AS region, c.tier AS tier, COUNT(*) AS n FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id GROUP BY c.region, c.tier ORDER BY c.region, c.tier");
          if (r.error) return false;
          const g = groupBy(FLAT, x => x.region + '' + x.tier);
          const exp = [...g.keys()].sort().map(k => `${k}:${g.get(k).length}`).join('|');
          return r.data.map(x => `${x.region}${x.tier}:${x.n}`).join('|') === exp;
      }});
      // C4. LEFT / FULL OUTER を絡めた結合（未発注顧客を含む）
      push('XL-C left join all cust', "SELECT COUNT(*) AS c FROM xl_cust c LEFT JOIN xl_ord o ON c.id = o.cid",
        r => r.data[0].c === ORD.length + CUST.filter(c => !ORD.some(o => o.cid === c.id)).length);
      push('XL-C left join orphan cust', "SELECT COUNT(*) AS c FROM xl_cust c LEFT JOIN xl_ord o ON c.id = o.cid WHERE o.id IS NULL",
        r => r.data[0].c === CUST.filter(c => !ORD.some(o => o.cid === c.id)).length);
      push('XL-C full outer cust-ord', "SELECT COUNT(*) AS c FROM xl_cust c FULL OUTER JOIN xl_ord o ON c.id = o.cid",
        r => r.data[0].c === ORD.length + CUST.filter(c => !ORD.some(o => o.cid === c.id)).length);
      push('XL-C left join prod unsold', "SELECT COUNT(*) AS c FROM xl_prod p LEFT JOIN xl_item i ON p.id = i.pid WHERE i.id IS NULL",
        r => r.data[0].c === PROD.filter(p => !ITEM.some(it => it.pid === p.id)).length);
      // C5. 自己結合
      push('XL-C self join same region', "SELECT COUNT(*) AS c FROM xl_cust a JOIN xl_cust b ON a.region = b.region WHERE a.id < b.id",
        r => {
          let n = 0;
          for (let i = 0; i < CUST.length; i++) for (let j = i + 1; j < CUST.length; j++) if (CUST[i].region === CUST[j].region && CUST[i].id < CUST[j].id) n++;
          return r.data[0].c === n;
        });
      push('XL-C self join same tier', "SELECT COUNT(*) AS c FROM xl_cust a JOIN xl_cust b ON a.tier = b.tier AND a.id <> b.id",
        r => {
          let n = 0;
          CUST.forEach(a => CUST.forEach(b => { if (a.tier === b.tier && a.id !== b.id) n++; }));
          return r.data[0].c === n;
        });
      // C6. 日次しきい値を変えた 4 表結合レポート
      [10, 20, 30, 45, 60, 75, 90].forEach(d => {
        const f = FLAT.filter(x => x.day <= d);
        push(`XL-C day<=${d} rows`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id WHERE o.day <= ${d}`,
          r => r.data[0].c === f.length);
        push(`XL-C day<=${d} rev`,
          `SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id WHERE o.day <= ${d}`,
          r => (r.data[0].s || 0) === sum(f.map(x => x.rev)));
        push(`XL-C day<=${d} distinct cust`,
          `SELECT COUNT(DISTINCT o.cid) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id WHERE o.day <= ${d}`,
          r => r.data[0].c === new Set(f.map(x => x.cid)).size);
      });

      // ============================================================
      // D. CTE + ウィンドウ関数 + 集計の複合パイプライン
      // ============================================================
      // D1. 多段 CTE チェーン
      for (let n = 2; n <= 6; n++) {
        const parts = [];
        parts.push(`w0 AS (SELECT id, credit FROM xl_cust)`);
        for (let i = 1; i < n; i++) parts.push(`w${i} AS (SELECT id, credit FROM w${i - 1} WHERE id > ${i})`);
        const exp = CUST.filter(c => c.id > n - 1).length;
        push(`XL-D cte chain ${n}`, `WITH ${parts.join(', ')} SELECT COUNT(*) AS c FROM w${n - 1}`,
          r => r.data[0].c === exp);
      }
      // D2. CTE + 結合 + 集計
      REGIONS.forEach(rg => {
        const f = FLAT.filter(x => x.region === rg);
        push(`XL-D cte join ${rg}`,
          `WITH rc AS (SELECT id FROM xl_cust WHERE region = ${sqlStr(rg)}), ro AS (SELECT o.id AS oid FROM xl_ord o JOIN rc ON o.cid = rc.id) SELECT COUNT(*) AS c FROM xl_item i JOIN ro ON i.oid = ro.oid`,
          r => r.data[0].c === f.length);
      });
      // D3. 再帰 CTE（深さを変えて等差数列を生成）
      [5, 10, 25, 50, 100, 200].forEach(n => {
        push(`XL-D recursive ${n}`,
          `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${n}) SELECT COUNT(*) AS c, SUM(n) AS t FROM s`,
          r => r.data[0].c === n && r.data[0].t === (n * (n + 1)) / 2);
      });
      // D4. ウィンドウ関数でグループ内順位（Top-N per group）
      REGIONS.forEach(rg => {
        const custs = CUST.filter(c => c.region === rg).slice().sort((a, b) => b.credit - a.credit || a.id - b.id);
        const top3 = custs.slice(0, 3).map(c => c.id).join(',');
        T.push({ name: `XL-D top3 per region ${rg}`, fn: () => {
            const r = db.executeQuery(`SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY credit DESC, id ASC) AS rn FROM xl_cust) z WHERE rn <= 3 AND id IN (${custs.map(c => c.id).join(',')}) ORDER BY rn`);
            if (r.error) return false;
            return r.data.map(x => x.id).join(',') === top3;
        }});
      });
      // D5. QUALIFY による Top-N
      TIERS.forEach(tr => {
        const custs = CUST.filter(c => c.tier === tr).slice().sort((a, b) => b.credit - a.credit || a.id - b.id);
        const top2 = custs.slice(0, 2).map(c => c.id).sort((a, b) => a - b).join(',');
        push(`XL-D qualify top2 ${tr}`,
          `SELECT id FROM xl_cust WHERE tier = ${sqlStr(tr)} QUALIFY ROW_NUMBER() OVER (ORDER BY credit DESC, id ASC) <= 2 ORDER BY id`,
          r => r.data.map(x => x.id).join(',') === top2);
      });
      // D6. 累計（running total）とウィンドウフレーム
      [10, 20, 30, 50].forEach(n => {
        const ids = CUST.slice(0, n);
        const running = [];
        let acc = 0;
        ids.forEach(c => { acc += c.credit; running.push(acc); });
        T.push({ name: `XL-D running total ${n}`, fn: () => {
            const r = db.executeQuery(`SELECT id, SUM(credit) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS rt FROM xl_cust WHERE id <= ${n} ORDER BY id`);
            if (r.error) return false;
            return r.data.map(x => x.rt).join(',') === running.join(',');
        }});
      });
      // D7. 移動平均（直近 3 行）
      [10, 20, 30].forEach(n => {
        const ids = CUST.slice(0, n);
        const mv = ids.map((_, i) => {
          const w = ids.slice(Math.max(0, i - 2), i + 1).map(c => c.credit);
          return avg2(w);
        });
        T.push({ name: `XL-D moving avg3 ${n}`, fn: () => {
            const r = db.executeQuery(`SELECT AVG(credit) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS ma FROM xl_cust WHERE id <= ${n} ORDER BY id`);
            if (r.error) return false;
            return r.data.every((x, i) => approx(x.ma, mv[i]));
        }});
      });
      // D8. ROLLUP / CUBE / GROUPING SETS を大きめデータで
      T.push({ name: 'XL-D rollup region×tier', fn: () => {
          const r = db.executeQuery("SELECT c.region AS region, c.tier AS tier, COUNT(*) AS n FROM xl_ord o JOIN xl_cust c ON o.cid = c.id GROUP BY ROLLUP(c.region, c.tier)");
          if (r.error) return false;
          const rows = ORD.map(o => custById[o.cid]);
          const pairs = new Set(rows.map(c => c.region + '' + c.tier)).size;
          const regs = new Set(rows.map(c => c.region)).size;
          return r.data.length === pairs + regs + 1 && r.data.some(x => x.region === null && x.tier === null && x.n === ORD.length);
      }});
      T.push({ name: 'XL-D cube region×tier', fn: () => {
          const r = db.executeQuery("SELECT c.region AS region, c.tier AS tier, COUNT(*) AS n FROM xl_ord o JOIN xl_cust c ON o.cid = c.id GROUP BY CUBE(c.region, c.tier)");
          if (r.error) return false;
          const rows = ORD.map(o => custById[o.cid]);
          const pairs = new Set(rows.map(c => c.region + '' + c.tier)).size;
          const regs = new Set(rows.map(c => c.region)).size;
          const tiers = new Set(rows.map(c => c.tier)).size;
          return r.data.length === pairs + regs + tiers + 1;
      }});
      T.push({ name: 'XL-D grouping sets region/tier', fn: () => {
          const r = db.executeQuery("SELECT c.region AS region, c.tier AS tier, COUNT(*) AS n FROM xl_ord o JOIN xl_cust c ON o.cid = c.id GROUP BY GROUPING SETS ((c.region), (c.tier), ())");
          if (r.error) return false;
          const rows = ORD.map(o => custById[o.cid]);
          const regs = new Set(rows.map(c => c.region)).size;
          const tiers = new Set(rows.map(c => c.tier)).size;
          return r.data.length === regs + tiers + 1;
      }});
      // D9. CTE → ウィンドウ → 外側集計の 3 段パイプライン
      [1, 2, 3, 5].forEach(k => {
        const g = groupBy(FLAT, x => x.cid);
        // 顧客ごとの売上を降順にし、上位 k 件の合計
        const totals = [...g.entries()].map(([cid, rows]) => ({ cid: Number(cid), rev: sum(rows.map(x => x.rev)) }))
          .sort((a, b) => b.rev - a.rev || a.cid - b.cid);
        const exp = sum(totals.slice(0, k).map(t => t.rev));
        push(`XL-D pipeline top${k} revenue`,
          `WITH cr AS (SELECT o.cid AS cid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id GROUP BY o.cid), rk AS (SELECT cid, rev, ROW_NUMBER() OVER (ORDER BY rev DESC, cid ASC) AS rn FROM cr) SELECT SUM(rev) AS s FROM rk WHERE rn <= ${k}`,
          r => r.data[0].s === exp);
      });
      // D10. named window + 複数ウィンドウ関数
      push('XL-D named window', "SELECT COUNT(*) AS c FROM (SELECT id, RANK() OVER w AS rk, DENSE_RANK() OVER w AS dr FROM xl_cust WINDOW w AS (ORDER BY credit DESC)) z",
        r => r.data[0].c === CUST.length);

      // ============================================================
      // E. 大量データに対する集計・DISTINCT・ソート
      // ============================================================
      push('XL-E total qty', "SELECT SUM(qty) AS s FROM xl_item", r => r.data[0].s === sum(ITEM.map(i => i.qty)));
      push('XL-E avg qty', "SELECT AVG(qty) AS a FROM xl_item", r => approx(r.data[0].a, avg2(ITEM.map(i => i.qty))));
      push('XL-E min/max qty', "SELECT MIN(qty) AS mn, MAX(qty) AS mx FROM xl_item",
        r => r.data[0].mn === Math.min(...ITEM.map(i => i.qty)) && r.data[0].mx === Math.max(...ITEM.map(i => i.qty)));
      push('XL-E distinct pid', "SELECT COUNT(DISTINCT pid) AS c FROM xl_item", r => r.data[0].c === new Set(ITEM.map(i => i.pid)).size);
      push('XL-E distinct oid', "SELECT COUNT(DISTINCT oid) AS c FROM xl_item", r => r.data[0].c === new Set(ITEM.map(i => i.oid)).size);
      push('XL-E median qty', "SELECT MEDIAN(qty) AS m FROM xl_item", r => {
        const s = ITEM.map(i => i.qty).sort((a, b) => a - b);
        const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        return approx(r.data[0].m, mid);
      });
      // 数量しきい値ごとの集計
      for (let q = 1; q <= 9; q++) {
        const f = ITEM.filter(i => i.qty >= q);
        push(`XL-E qty>=${q} count`, `SELECT COUNT(*) AS c FROM xl_item WHERE qty >= ${q}`, r => r.data[0].c === f.length);
        push(`XL-E qty>=${q} sum`, `SELECT SUM(qty) AS s FROM xl_item WHERE qty >= ${q}`, r => (r.data[0].s || 0) === sum(f.map(i => i.qty)));
        push(`XL-E qty>=${q} distinct pid`, `SELECT COUNT(DISTINCT pid) AS c FROM xl_item WHERE qty >= ${q}`, r => r.data[0].c === new Set(f.map(i => i.pid)).size);
        push(`XL-E qty=${q} avg`, `SELECT AVG(qty) AS a FROM xl_item WHERE qty = ${q}`,
          r => approx(r.data[0].a, avg2(ITEM.filter(i => i.qty === q).map(i => i.qty))));
      }
      // 価格帯ごとの集計
      [100, 300, 500, 800, 1200, 1600].forEach(p => {
        const f = ITEM.filter(i => prodById[i.pid].price >= p);
        push(`XL-E price>=${p} items`, `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_prod p ON i.pid = p.id WHERE p.price >= ${p}`,
          r => r.data[0].c === f.length);
        push(`XL-E price>=${p} rev`, `SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_prod p ON i.pid = p.id WHERE p.price >= ${p}`,
          r => (r.data[0].s || 0) === sum(f.map(itemRev)));
      });
      // 統計関数
      push('XL-E stddev qty', "SELECT ROUND(STDDEV(qty), 4) AS s FROM xl_item", r => {
        const a = ITEM.map(i => i.qty), m = a.reduce((x, y) => x + y, 0) / a.length;
        const v = a.reduce((acc, x) => acc + (x - m) * (x - m), 0) / a.length;
        return approx(r.data[0].s, Number(Math.sqrt(v).toFixed(4)));
      });
      push('XL-E variance qty', "SELECT ROUND(VARIANCE(qty), 4) AS s FROM xl_item", r => {
        const a = ITEM.map(i => i.qty), m = a.reduce((x, y) => x + y, 0) / a.length;
        const v = a.reduce((acc, x) => acc + (x - m) * (x - m), 0) / a.length;
        return approx(r.data[0].s, Number(v.toFixed(4)));
      });
      // ORDER BY + LIMIT を大きめデータで（上位 N の一致）
      [1, 3, 5, 10, 20, 50].forEach(n => {
        const top = ITEM.slice().sort((a, b) => b.qty - a.qty || a.id - b.id).slice(0, n).map(i => i.id).join(',');
        push(`XL-E top${n} by qty`, `SELECT id FROM xl_item ORDER BY qty DESC, id ASC LIMIT ${n}`,
          r => r.data.map(x => x.id).join(',') === top);
        const bot = ITEM.slice().sort((a, b) => a.qty - b.qty || a.id - b.id).slice(0, n).map(i => i.id).join(',');
        push(`XL-E bottom${n} by qty`, `SELECT id FROM xl_item ORDER BY qty ASC, id ASC LIMIT ${n}`,
          r => r.data.map(x => x.id).join(',') === bot);
      });
      // OFFSET を進めながらページング（全件を復元できること）
      [50, 100, 200, 300].forEach(pageSize => {
        T.push({ name: `XL-E paging ${pageSize}`, fn: () => {
            const ids = [];
            for (let off = 0; off < ITEM.length; off += pageSize) {
              const r = db.executeQuery(`SELECT id FROM xl_item ORDER BY id LIMIT ${pageSize} OFFSET ${off}`);
              if (r.error) return false;
              r.data.forEach(x => ids.push(x.id));
            }
            return ids.length === ITEM.length && ids[0] === 1 && ids[ITEM.length - 1] === ITEM.length;
        }});
      });
      // 集計 + FILTER (WHERE)
      STATUSES.forEach(st => {
        const f = FLAT.filter(x => x.st === st);
        push(`XL-E filter agg ${st}`,
          `SELECT COUNT(*) FILTER (WHERE o.st = ${sqlStr(st)}) AS c, SUM(i.qty) FILTER (WHERE o.st = ${sqlStr(st)}) AS q FROM xl_item i JOIN xl_ord o ON i.oid = o.id`,
          r => r.data[0].c === f.length && (r.data[0].q || 0) === sum(f.map(x => x.qty)));
      });
      // GROUP_CONCAT / LISTAGG を大きめグループで
      push('XL-E group_concat len', "SELECT LENGTH(GROUP_CONCAT(id)) AS l FROM xl_cust",
        r => r.data[0].l === CUST.map(c => c.id).join(',').length);
      push('XL-E listagg within group', "SELECT LISTAGG(id, '-') WITHIN GROUP (ORDER BY id) AS s FROM xl_cust WHERE id <= 20",
        r => r.data[0].s === CUST.filter(c => c.id <= 20).map(c => c.id).join('-'));

      // ============================================================
      // F. 実務的な複合レポート（複数機能を1本に詰め込む）
      // ============================================================
      // F1. 顧客別売上ランキング（結合 + 集計 + ウィンドウ + 絞り込み）
      const custRev = (() => {
        const g = groupBy(FLAT, x => x.cid);
        return [...g.entries()].map(([cid, rows]) => ({ cid: Number(cid), rev: sum(rows.map(x => x.rev)), n: rows.length }))
          .sort((a, b) => b.rev - a.rev || a.cid - b.cid);
      })();
      [1, 3, 5, 10, 20].forEach(n => {
        const exp = custRev.slice(0, n).map(x => x.cid).join(',');
        T.push({ name: `XL-F cust revenue rank top${n}`, fn: () => {
            const r = db.executeQuery(`WITH cr AS (SELECT o.cid AS cid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id GROUP BY o.cid) SELECT cid FROM cr ORDER BY rev DESC, cid ASC LIMIT ${n}`);
            if (r.error) return false;
            return r.data.map(x => x.cid).join(',') === exp;
        }});
      });
      // F2. 全体に占める割合（percent of total）
      REGIONS.forEach(rg => {
        const total = sum(FLAT.map(x => x.rev));
        const part = sum(FLAT.filter(x => x.region === rg).map(x => x.rev));
        const pct = Number(((part / total) * 100).toFixed(2));
        push(`XL-F pct of total ${rg}`,
          `SELECT ROUND(100.0 * SUM(CASE WHEN c.region = ${sqlStr(rg)} THEN i.qty * p.price ELSE 0 END) / SUM(i.qty * p.price), 2) AS pct FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id`,
          r => approx(r.data[0].pct, pct));
      });
      // F3. カテゴリ×階層のクロス集計を PIVOT で
      TIERS.forEach(tr => {
        const f = FLAT.filter(x => x.tier === tr);
        const byCat = {}; CATS.forEach(c => byCat[c] = sum(f.filter(x => x.cat === c).map(x => x.qty)));
        T.push({ name: `XL-F pivot cat×tier ${tr}`, fn: () => {
            const r = db.executeQuery(`SELECT * FROM (SELECT c.tier AS tier, p.cat AS cat, i.qty AS qty FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id WHERE c.tier = ${sqlStr(tr)}) s PIVOT (SUM(qty) FOR cat IN (${CATS.map(c => sqlStr(c)).join(', ')})) pv`);
            if (r.error) return false;
            if (r.data.length !== 1) return false;
            return CATS.every(c => (r.data[0][c.toLowerCase()] || 0) === byCat[c]);
        }});
      });
      // F4. 階段状のしきい値レポート（CASE で区分 → 集計）
      T.push({ name: 'XL-F qty buckets', fn: () => {
          const r = db.executeQuery("SELECT CASE WHEN qty <= 3 THEN 'LOW' WHEN qty <= 6 THEN 'MID' ELSE 'HIGH' END AS b, COUNT(*) AS n FROM xl_item GROUP BY b ORDER BY b");
          if (r.error) return false;
          const bk = { LOW: 0, MID: 0, HIGH: 0 };
          ITEM.forEach(i => { bk[i.qty <= 3 ? 'LOW' : i.qty <= 6 ? 'MID' : 'HIGH']++; });
          const exp = Object.keys(bk).sort().map(k => `${k}:${bk[k]}`).join('|');
          return r.data.map(x => `${x.b}:${x.n}`).join('|') === exp;
      }});
      // F5. HAVING + ORDER BY + LIMIT を重ねたレポート
      [1, 2, 3, 5, 8, 12].forEach(th => {
        const g = groupBy(ITEM, i => i.pid);
        const exp = [...g.entries()].filter(([, v]) => v.length > th * 3).length;
        push(`XL-F prod having ${th}`,
          `SELECT COUNT(*) AS c FROM (SELECT pid, COUNT(*) AS n FROM xl_item GROUP BY pid HAVING COUNT(*) > ${th * 3}) z`,
          r => r.data[0].c === exp);
      });
      // F6. UNION で複数レポートを縦に連結
      [2, 3, 4, 5].forEach(k => {
        const segs = REGIONS.slice(0, k).map(rg =>
          `SELECT ${sqlStr(rg)} AS region, COUNT(*) AS n FROM xl_ord o JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)}`).join(' UNION ALL ');
        const exp = REGIONS.slice(0, k).map(rg => ORD.filter(o => custById[o.cid].region === rg).length);
        T.push({ name: `XL-F union report ${k}`, fn: () => {
            const r = db.executeQuery(segs);
            if (r.error) return false;
            return r.data.length === k && r.data.every((x, i) => x.n === exp[i]);
        }});
      });
      // F7. INTERSECT / EXCEPT を大きめ集合で
      [10, 20, 30, 40].forEach(n => {
        const a = new Set(CUST.filter(c => c.id <= n).map(c => c.id));
        const b = new Set(CUST.filter(c => c.id > n / 2).map(c => c.id));
        const inter = [...a].filter(x => b.has(x)).length;
        const exc = [...a].filter(x => !b.has(x)).length;
        push(`XL-F intersect ${n}`, `SELECT COUNT(*) AS c FROM (SELECT id FROM xl_cust WHERE id <= ${n} INTERSECT SELECT id FROM xl_cust WHERE id > ${n / 2}) z`,
          r => r.data[0].c === inter);
        push(`XL-F except ${n}`, `SELECT COUNT(*) AS c FROM (SELECT id FROM xl_cust WHERE id <= ${n} EXCEPT SELECT id FROM xl_cust WHERE id > ${n / 2}) z`,
          r => r.data[0].c === exc);
      });
      // F8. MERGE で集計結果を差分反映（大きめソース）
      [1, 2, 3].forEach(k => {
        T.push({ name: `XL-F merge rollup ${k}`, fn: () => {
            const tn = `xl_mrg_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (cid INTEGER PRIMARY KEY, n INTEGER)`);
            // 一部の顧客だけ先に入れておき、MERGE で残りを INSERT・既存を UPDATE させる
            const pre = CUST.filter(c => c.id % 5 === 0).slice(0, 5);
            if (pre.length) db.executeQuery(`INSERT INTO ${tn} (cid, n) VALUES ${pre.map(c => `(${c.id}, -1)`).join(', ')}`);
            const m = db.executeQuery(`MERGE INTO ${tn} t USING (SELECT cid, COUNT(*) AS n FROM xl_ord GROUP BY cid) s ON (t.cid = s.cid) WHEN MATCHED THEN UPDATE SET n = s.n WHEN NOT MATCHED THEN INSERT (cid, n) VALUES (s.cid, s.n)`);
            if (m.error) return false;
            const g = groupBy(ORD, o => o.cid);
            const expRows = g.size;
            const got = db.executeQuery(`SELECT COUNT(*) AS c, SUM(n) AS s FROM ${tn}`).data[0];
            // MERGE 対象外だった事前行（受注のない顧客）は -1 のまま残る
            const orphanPre = pre.filter(c => !g.has(String(c.id)) && !g.has(c.id)).length;
            const okRows = got.c === expRows + orphanPre;
            const okSum = got.s === ORD.length - orphanPre;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return okRows && okSum;
        }});
      });
      // F9. 相関サブクエリを含む複合レポート（顧客 50 行に限定）
      [0, 1, 2, 4].forEach(th => {
        const exp = CUST.filter(c => {
          const os = ORD.filter(o => o.cid === c.id);
          return os.length > th;
        }).length;
        push(`XL-F corr report ${th}`,
          `SELECT COUNT(*) AS c FROM xl_cust c WHERE (SELECT COUNT(*) FROM xl_ord o WHERE o.cid = c.id) > ${th} AND c.credit > 0`,
          r => r.data[0].c === exp);
      });
      // F10. APPLY を使った顧客別サマリ（小さい母集合に限定）
      [5, 10, 20].forEach(n => {
        const exp = sum(CUST.filter(c => c.id <= n).map(c => ORD.filter(o => o.cid === c.id).length));
        push(`XL-F apply summary ${n}`,
          `SELECT SUM(x.n) AS s FROM xl_cust c CROSS APPLY (SELECT COUNT(*) AS n FROM xl_ord o WHERE o.cid = c.id) x WHERE c.id <= ${n}`,
          r => r.data[0].s === exp);
      });
      // F11. 深いネスト + 結合 + 集計を一度に（回帰の総仕上げ）
      [20, 35, 50].forEach(n => {
        const cids = new Set(CUST.filter(c => c.id <= n).map(c => c.id));
        const f = FLAT.filter(x => cids.has(x.cid));
        push(`XL-F kitchen sink ${n}`,
          `SELECT COUNT(*) AS c, SUM(rev) AS s FROM (
             SELECT z.rev AS rev FROM (
               SELECT i.qty * p.price AS rev, o.cid AS cid
               FROM xl_item i
               JOIN xl_ord o ON i.oid = o.id
               JOIN xl_prod p ON i.pid = p.id
             ) z
             WHERE z.cid IN (SELECT id FROM xl_cust WHERE id <= ${n})
           ) y`,
          r => r.data[0].c === f.length && (r.data[0].s || 0) === sum(f.map(x => x.rev)));
      });

      // ============================================================
      // G. 集計を内包した式（ROUND(AVG(x),2) / 比率計算 など実務頻出形）
      // ============================================================
      push('XL-G round avg qty', "SELECT ROUND(AVG(qty), 2) AS a FROM xl_item", r => approx(r.data[0].a, avg2(ITEM.map(i => i.qty))));
      push('XL-G round avg price', "SELECT ROUND(AVG(price), 2) AS a FROM xl_prod", r => approx(r.data[0].a, avg2(PROD.map(p => p.price))));
      push('XL-G sum ratio', "SELECT SUM(qty) / COUNT(*) AS a FROM xl_item", r => approx(r.data[0].a, sum(ITEM.map(i => i.qty)) / ITEM.length));
      push('XL-G abs of diff', "SELECT ABS(MAX(qty) - MIN(qty)) AS a FROM xl_item",
        r => r.data[0].a === Math.max(...ITEM.map(i => i.qty)) - Math.min(...ITEM.map(i => i.qty)));
      push('XL-G concat with agg', "SELECT CONCAT('n=', COUNT(*)) AS a FROM xl_item", r => r.data[0].a === 'n=' + ITEM.length);
      push('XL-G case on agg', "SELECT CASE WHEN COUNT(*) > 100 THEN 'BIG' ELSE 'SMALL' END AS a FROM xl_item", r => r.data[0].a === 'BIG');
      push('XL-G nested agg fn', "SELECT ROUND(SQRT(SUM(qty)), 3) AS a FROM xl_item",
        r => approx(r.data[0].a, Number(Math.sqrt(sum(ITEM.map(i => i.qty))).toFixed(3))));
      push('XL-G two aggs in expr', "SELECT MAX(qty) * MIN(qty) AS a FROM xl_item",
        r => r.data[0].a === Math.max(...ITEM.map(i => i.qty)) * Math.min(...ITEM.map(i => i.qty)));
      push('XL-G agg expr with literal', "SELECT SUM(qty) + 1000 AS a FROM xl_item", r => r.data[0].a === sum(ITEM.map(i => i.qty)) + 1000);
      push('XL-G coalesce over agg', "SELECT COALESCE(SUM(qty), 0) AS a FROM xl_item WHERE qty > 1000", r => r.data[0].a === 0);
      // グループ単位で集計内包式
      CATS.forEach(ct => {
        const f = ITEM.filter(i => prodById[i.pid].cat === ct);
        push(`XL-G grouped round avg ${ct}`,
          `SELECT ROUND(AVG(i.qty), 2) AS a FROM xl_item i JOIN xl_prod p ON i.pid = p.id WHERE p.cat = ${sqlStr(ct)}`,
          r => approx(r.data[0].a, avg2(f.map(i => i.qty))));
        push(`XL-G grouped pct ${ct}`,
          `SELECT ROUND(100.0 * SUM(CASE WHEN p.cat = ${sqlStr(ct)} THEN i.qty ELSE 0 END) / SUM(i.qty), 3) AS a FROM xl_item i JOIN xl_prod p ON i.pid = p.id`,
          r => approx(r.data[0].a, Number((100 * sum(f.map(i => i.qty)) / sum(ITEM.map(i => i.qty))).toFixed(3))));
      });
      T.push({ name: 'XL-G groupby with agg expr', fn: () => {
          const r = db.executeQuery("SELECT p.cat AS cat, ROUND(AVG(i.qty), 2) AS a, SUM(i.qty) * 2 AS d FROM xl_item i JOIN xl_prod p ON i.pid = p.id GROUP BY p.cat ORDER BY p.cat");
          if (r.error) return false;
          const g = groupBy(ITEM, i => prodById[i.pid].cat);
          return [...g.keys()].sort().every((k, idx) => {
            const rows = g.get(k);
            return approx(r.data[idx].a, avg2(rows.map(x => x.qty))) && r.data[idx].d === sum(rows.map(x => x.qty)) * 2;
          });
      }});
      // 集計内包式 + HAVING + ORDER BY
      [2, 3, 4, 5].forEach(th => {
        const g = groupBy(ITEM, i => i.pid);
        const exp = [...g.entries()].filter(([, v]) => avg2(v.map(x => x.qty)) > th).length;
        push(`XL-G having on avg ${th}`,
          `SELECT COUNT(*) AS c FROM (SELECT pid, ROUND(AVG(qty), 2) AS a FROM xl_item GROUP BY pid HAVING AVG(qty) > ${th}) z`,
          r => r.data[0].c === exp);
      });

      // ============================================================
      // H. 追加の大型集計マトリクス（地域 × 階層 × カテゴリ × 状態）
      // ============================================================
      REGIONS.forEach(rg => TIERS.forEach(tr => {
        const f = FLAT.filter(x => x.region === rg && x.tier === tr);
        push(`XL-H r×t ${rg}/${tr} rows`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)} AND c.tier = ${sqlStr(tr)}`,
          r => r.data[0].c === f.length);
        push(`XL-H r×t ${rg}/${tr} qty`,
          `SELECT SUM(i.qty) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)} AND c.tier = ${sqlStr(tr)}`,
          r => (r.data[0].s || 0) === sum(f.map(x => x.qty)));
      }));
      REGIONS.forEach(rg => STATUSES.forEach(st => {
        const f = FLAT.filter(x => x.region === rg && x.st === st);
        push(`XL-H r×s ${rg}/${st}`,
          `SELECT COUNT(*) AS c, SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id WHERE c.region = ${sqlStr(rg)} AND o.st = ${sqlStr(st)}`,
          r => r.data[0].c === f.length && (r.data[0].s || 0) === sum(f.map(x => x.rev)));
      }));
      CATS.forEach(ct => STATUSES.forEach(st => {
        const f = FLAT.filter(x => x.cat === ct && x.st === st);
        push(`XL-H c×s ${ct}/${st}`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id WHERE p.cat = ${sqlStr(ct)} AND o.st = ${sqlStr(st)}`,
          r => r.data[0].c === f.length);
      }));
      // 日次バケット × 地域
      [30, 60, 90].forEach(d => REGIONS.forEach(rg => {
        const f = FLAT.filter(x => x.day <= d && x.region === rg);
        push(`XL-H day${d}×${rg}`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE o.day <= ${d} AND c.region = ${sqlStr(rg)}`,
          r => r.data[0].c === f.length);
      }));

      // ============================================================
      // I. 顧客・商品ごとの網羅集計（相関のない結合ベース）
      // ============================================================
      // 顧客 50 件それぞれの受注数・売上を個別に検証
      CUST.forEach(c => {
        const os = ORD.filter(o => o.cid === c.id);
        push(`XL-I cust${c.id} orders`, `SELECT COUNT(*) AS n FROM xl_ord WHERE cid = ${c.id}`, r => r.data[0].n === os.length);
        const f = FLAT.filter(x => x.cid === c.id);
        push(`XL-I cust${c.id} revenue`,
          `SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id WHERE o.cid = ${c.id}`,
          r => (r.data[0].s || 0) === sum(f.map(x => x.rev)));
      });
      // 商品 30 件それぞれの販売数・明細数
      PROD.forEach(p => {
        const its = ITEM.filter(i => i.pid === p.id);
        push(`XL-I prod${p.id} qty`, `SELECT SUM(qty) AS s FROM xl_item WHERE pid = ${p.id}`,
          r => (r.data[0].s || 0) === sum(its.map(i => i.qty)));
        push(`XL-I prod${p.id} lines`, `SELECT COUNT(*) AS c FROM xl_item WHERE pid = ${p.id}`, r => r.data[0].c === its.length);
      });
      // 受注 300 件のうち先頭 60 件の明細数
      ORD.slice(0, 60).forEach(o => {
        const its = ITEM.filter(i => i.oid === o.id);
        push(`XL-I ord${o.id} lines`, `SELECT COUNT(*) AS c FROM xl_item WHERE oid = ${o.id}`, r => r.data[0].c === its.length);
      });

      // ============================================================
      // J. 大型クエリのストレステスト（多段 UNION + 結合 + ネストの複合）
      // ============================================================
      // J1. N 本の集計を UNION ALL で束ねた「レポート束」
      [3, 5, 8, 12].forEach(k => {
        const cats = CATS.slice(0, Math.min(k, CATS.length));
        const segs = [];
        const exps = [];
        for (let i = 0; i < k; i++) {
          const ct = cats[i % cats.length];
          const d = 20 + i * 5;
          segs.push(`SELECT ${i} AS seg, COUNT(*) AS n FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id WHERE p.cat = ${sqlStr(ct)} AND o.day <= ${d}`);
          exps.push(FLAT.filter(x => x.cat === ct && x.day <= d).length);
        }
        T.push({ name: `XL-J union report ${k}`, fn: () => {
            const r = db.executeQuery(segs.join(' UNION ALL '));
            if (r.error) return false;
            return r.data.length === k && r.data.every((x, i) => x.n === exps[i]);
        }});
      });
      // J2. サブクエリを段重ねしながら結合も挟む
      [2, 3, 4].forEach(d => {
        let inner = 'SELECT i.id AS iid, i.qty AS qty, o.cid AS cid FROM xl_item i JOIN xl_ord o ON i.oid = o.id';
        for (let k = 0; k < d; k++) inner = `SELECT iid, qty, cid FROM (${inner}) s${k} WHERE qty >= ${k + 1}`;
        const exp = FLAT.filter(x => x.qty >= d).length;
        push(`XL-J nested join ${d}`, `SELECT COUNT(*) AS c FROM (${inner}) z`, r => r.data[0].c === exp);
      });
      // J3. CTE + 結合 + ウィンドウ + QUALIFY + ORDER BY + LIMIT の全部入り
      [1, 2, 3].forEach(k => {
        const g = groupBy(FLAT, x => x.region);
        const perRegion = [...g.entries()].map(([rg, rows]) => ({ rg, rev: sum(rows.map(x => x.rev)) }))
          .sort((a, b) => b.rev - a.rev || (a.rg < b.rg ? -1 : 1));
        const exp = perRegion.slice(0, k).map(x => x.rg).join(',');
        T.push({ name: `XL-J full pipeline top${k}`, fn: () => {
            const r = db.executeQuery(`WITH base AS (
                SELECT c.region AS region, i.qty * p.price AS rev
                FROM xl_item i
                JOIN xl_ord o ON i.oid = o.id
                JOIN xl_cust c ON o.cid = c.id
                JOIN xl_prod p ON i.pid = p.id
              ), agg AS (
                SELECT region, SUM(rev) AS total FROM base GROUP BY region
              )
              SELECT region FROM agg ORDER BY total DESC, region ASC LIMIT ${k}`);
            if (r.error) return false;
            return r.data.map(x => x.region).join(',') === exp;
        }});
      });
      // J4. 大きな IN リストを結合と併用
      [50, 100, 200, 300].forEach(n => {
        const oids = ORD.slice(0, Math.min(n, ORD.length)).map(o => o.id);
        const oidSet = new Set(oids);
        const exp = ITEM.filter(i => oidSet.has(i.oid)).length;
        push(`XL-J big in join ${n}`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id WHERE i.oid IN (${oids.join(',')})`,
          r => r.data[0].c === exp);
      });
      // J5. DISTINCT を大きな結合結果に適用
      push('XL-J distinct region×cat', "SELECT COUNT(*) AS c FROM (SELECT DISTINCT c.region AS region, p.cat AS cat FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id JOIN xl_prod p ON i.pid = p.id) z",
        r => r.data[0].c === new Set(FLAT.map(x => x.region + '' + x.cat)).size);
      push('XL-J distinct cust×prod', "SELECT COUNT(*) AS c FROM (SELECT DISTINCT o.cid AS cid, i.pid AS pid FROM xl_item i JOIN xl_ord o ON i.oid = o.id) z",
        r => r.data[0].c === new Set(ITEM.map(i => ordById[i.oid].cid + '/' + i.pid)).size);
      // J6. ORDER BY 複合キー（安定性を一意キーで担保）
      [10, 30, 60].forEach(n => {
        const exp = FLAT.slice().sort((a, b) => b.rev - a.rev || a.iid - b.iid).slice(0, n).map(x => x.iid).join(',');
        push(`XL-J multikey order ${n}`,
          `SELECT i.id AS iid FROM xl_item i JOIN xl_prod p ON i.pid = p.id ORDER BY i.qty * p.price DESC, i.id ASC LIMIT ${n}`,
          r => r.data.map(x => x.iid).join(',') === exp);
      });

      // ============================================================
      // K. 巨大な派生テーブル・CTE を跨いだ多段変換
      // ============================================================
      // K1. 明細 → 受注小計 → 顧客小計 → 地域小計 の 3 段ロールアップ
      T.push({ name: 'XL-K 3-stage rollup', fn: () => {
          const r = db.executeQuery(`WITH oi AS (
              SELECT i.oid AS oid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_prod p ON i.pid = p.id GROUP BY i.oid
            ), co AS (
              SELECT o.cid AS cid, SUM(oi.rev) AS rev FROM oi JOIN xl_ord o ON oi.oid = o.id GROUP BY o.cid
            ), rc AS (
              SELECT c.region AS region, SUM(co.rev) AS rev FROM co JOIN xl_cust c ON co.cid = c.id GROUP BY c.region
            ) SELECT region, rev FROM rc ORDER BY region`);
          if (r.error) return false;
          const g = groupBy(FLAT, x => x.region);
          const exp = [...g.keys()].sort().map(k => `${k}:${sum(g.get(k).map(x => x.rev))}`).join('|');
          return r.data.map(x => `${x.region}:${x.rev}`).join('|') === exp;
      }});
      // K2. 各段の中間結果も個別に検証
      T.push({ name: 'XL-K stage1 order subtotal', fn: () => {
          const r = db.executeQuery("SELECT COUNT(*) AS c, SUM(rev) AS s FROM (SELECT i.oid AS oid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_prod p ON i.pid = p.id GROUP BY i.oid) z");
          if (r.error) return false;
          return r.data[0].c === new Set(ITEM.map(i => i.oid)).size && r.data[0].s === sum(ITEM.map(itemRev));
      }});
      T.push({ name: 'XL-K stage2 cust subtotal', fn: () => {
          const r = db.executeQuery("SELECT COUNT(*) AS c, SUM(rev) AS s FROM (SELECT o.cid AS cid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id GROUP BY o.cid) z");
          if (r.error) return false;
          return r.data[0].c === new Set(FLAT.map(x => x.cid)).size && r.data[0].s === sum(FLAT.map(x => x.rev));
      }});
      // K3. 地域ごとに 3 段パイプラインを個別検証
      REGIONS.forEach(rg => {
        const exp = sum(FLAT.filter(x => x.region === rg).map(x => x.rev));
        push(`XL-K pipeline ${rg}`,
          `WITH oi AS (SELECT i.oid AS oid, SUM(i.qty * p.price) AS rev FROM xl_item i JOIN xl_prod p ON i.pid = p.id GROUP BY i.oid) SELECT SUM(oi.rev) AS s FROM oi JOIN xl_ord o ON oi.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)}`,
          r => (r.data[0].s || 0) === exp);
      });
      // K4. 上位 N 顧客だけを CTE で絞ってから再結合
      [3, 5, 10, 15].forEach(n => {
        const g = groupBy(FLAT, x => x.cid);
        const ranked = [...g.entries()].map(([cid, rows]) => ({ cid: Number(cid), rev: sum(rows.map(x => x.rev)) }))
          .sort((a, b) => b.rev - a.rev || a.cid - b.cid).slice(0, n);
        const cidSet = new Set(ranked.map(x => x.cid));
        const expLines = FLAT.filter(x => cidSet.has(x.cid)).length;
        T.push({ name: `XL-K top${n} rejoin`, fn: () => {
            const r = db.executeQuery(`WITH cr AS (
                SELECT o.cid AS cid, SUM(i.qty * p.price) AS rev
                FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_prod p ON i.pid = p.id
                GROUP BY o.cid
              ), topc AS (
                SELECT cid FROM cr ORDER BY rev DESC, cid ASC LIMIT ${n}
              )
              SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN topc t ON o.cid = t.cid`);
            if (r.error) return false;
            return r.data[0].c === expLines;
        }});
      });

      // ============================================================
      // L. ウィンドウ関数の大型パーティション検証
      // ============================================================
      // L1. 地域ごとの顧客順位（パーティション内の件数と最大順位が一致すること）
      T.push({ name: 'XL-L rank per region', fn: () => {
          const r = db.executeQuery("SELECT region, ROW_NUMBER() OVER (PARTITION BY region ORDER BY credit DESC, id ASC) AS rn FROM xl_cust");
          if (r.error) return false;
          const g = groupBy(CUST, c => c.region);
          return [...g.entries()].every(([rg, rows]) =>
            Math.max(...r.data.filter(x => x.region === rg).map(x => x.rn)) === rows.length);
      }});
      // L2. パーティションごとの合計がグループ集計と一致すること
      T.push({ name: 'XL-L partition sum matches group', fn: () => {
          const r = db.executeQuery("SELECT DISTINCT region, SUM(credit) OVER (PARTITION BY region) AS s FROM xl_cust ORDER BY region");
          if (r.error) return false;
          const g = groupBy(CUST, c => c.region);
          const exp = [...g.keys()].sort().map(k => `${k}:${sum(g.get(k).map(c => c.credit))}`).join('|');
          return r.data.map(x => `${x.region}:${x.s}`).join('|') === exp;
      }});
      // L3. LAG / LEAD の値を JS 側と突き合わせ
      [10, 25, 50].forEach(n => {
        const rows = CUST.slice(0, n);
        T.push({ name: `XL-L lag ${n}`, fn: () => {
            const r = db.executeQuery(`SELECT id, LAG(credit) OVER (ORDER BY id) AS lg FROM xl_cust WHERE id <= ${n} ORDER BY id`);
            if (r.error) return false;
            return r.data.every((x, i) => x.lg === (i === 0 ? null : rows[i - 1].credit));
        }});
        T.push({ name: `XL-L lead ${n}`, fn: () => {
            const r = db.executeQuery(`SELECT id, LEAD(credit) OVER (ORDER BY id) AS ld FROM xl_cust WHERE id <= ${n} ORDER BY id`);
            if (r.error) return false;
            return r.data.every((x, i) => x.ld === (i === rows.length - 1 ? null : rows[i + 1].credit));
        }});
      });
      // L4. NTILE の分割サイズ
      [2, 3, 4, 5, 10].forEach(k => {
        T.push({ name: `XL-L ntile ${k}`, fn: () => {
            const r = db.executeQuery(`SELECT NTILE(${k}) OVER (ORDER BY id) AS t FROM xl_cust`);
            if (r.error) return false;
            const buckets = new Set(r.data.map(x => x.t));
            const sizes = [...buckets].map(b => r.data.filter(x => x.t === b).length);
            // 各バケットのサイズ差は 1 以内
            return buckets.size === k && Math.max(...sizes) - Math.min(...sizes) <= 1;
        }});
      });
      // L5. 大きめデータの累計がグループ合計に収束すること
      REGIONS.forEach(rg => {
        const rows = CUST.filter(c => c.region === rg).sort((a, b) => a.id - b.id);
        const total = sum(rows.map(c => c.credit));
        push(`XL-L running converges ${rg}`,
          `SELECT MAX(rt) AS m FROM (SELECT SUM(credit) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS rt FROM xl_cust WHERE region = ${sqlStr(rg)}) z`,
          r => r.data[0].m === total);
      });
      // L6. RANGE / GROUPS フレームを大きめデータで
      [1, 2, 3].forEach(n => {
        T.push({ name: `XL-L groups frame ${n}`, fn: () => {
            const r = db.executeQuery(`SELECT qty, SUM(qty) OVER (ORDER BY qty GROUPS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM xl_item ORDER BY qty`);
            if (r.error) return false;
            const sorted = ITEM.map(i => i.qty).sort((a, b) => a - b);
            const uniq = [...new Set(sorted)];
            return r.data.every((x, i) => {
              const cur = sorted[i];
              const lo = uniq[Math.max(0, uniq.indexOf(cur) - n)];
              return x.s === sum(sorted.filter(v => v >= lo && v <= cur));
            });
        }});
      });

      // ============================================================
      // M. 追加の商品×受注クロス検証（網羅を厚くする）
      // ============================================================
      PROD.forEach(p => {
        push(`XL-M prod${p.id} revenue`,
          `SELECT SUM(i.qty * p.price) AS s FROM xl_item i JOIN xl_prod p ON i.pid = p.id WHERE p.id = ${p.id}`,
          r => (r.data[0].s || 0) === sum(ITEM.filter(i => i.pid === p.id).map(itemRev)));
        push(`XL-M prod${p.id} distinct orders`,
          `SELECT COUNT(DISTINCT oid) AS c FROM xl_item WHERE pid = ${p.id}`,
          r => r.data[0].c === new Set(ITEM.filter(i => i.pid === p.id).map(i => i.oid)).size);
      });
      // 顧客ごとの明細数（結合経由）
      CUST.forEach(c => {
        const n = FLAT.filter(x => x.cid === c.id).length;
        push(`XL-M cust${c.id} lines`,
          `SELECT COUNT(*) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id WHERE o.cid = ${c.id}`,
          r => r.data[0].c === n);
      });

      // ============================================================
      // N. 総仕上げ: 条件式・集合演算・並べ替えを重ねた大型クエリ
      // ============================================================
      // N1. CASE を多段に重ねた区分集計（区分境界を変えながら）
      [[2, 5], [3, 6], [4, 7], [1, 8], [2, 8]].forEach(([lo, hi], i) => {
        T.push({ name: `XL-N case buckets ${i}`, fn: () => {
            const r = db.executeQuery(`SELECT CASE WHEN qty <= ${lo} THEN 'A' WHEN qty <= ${hi} THEN 'B' ELSE 'C' END AS b, COUNT(*) AS n, SUM(qty) AS s FROM xl_item GROUP BY b ORDER BY b`);
            if (r.error) return false;
            const bk = {};
            ITEM.forEach(it => { const k = it.qty <= lo ? 'A' : it.qty <= hi ? 'B' : 'C'; (bk[k] = bk[k] || []).push(it.qty); });
            const exp = Object.keys(bk).sort().map(k => `${k}:${bk[k].length}:${sum(bk[k])}`).join('|');
            return r.data.map(x => `${x.b}:${x.n}:${x.s}`).join('|') === exp;
        }});
      });
      // N2. CASE を集計の内側に置く（条件付き集計）
      STATUSES.forEach(st => {
        const f = FLAT.filter(x => x.st === st);
        push(`XL-N conditional sum ${st}`,
          `SELECT SUM(CASE WHEN o.st = ${sqlStr(st)} THEN i.qty ELSE 0 END) AS s, COUNT(CASE WHEN o.st = ${sqlStr(st)} THEN 1 END) AS c FROM xl_item i JOIN xl_ord o ON i.oid = o.id`,
          r => r.data[0].s === sum(f.map(x => x.qty)) && r.data[0].c === f.length);
      });
      // N3. 複数条件付き集計を一度に（1 本で 4 状態の内訳を出す横持ちレポート）
      T.push({ name: 'XL-N status crosstab one shot', fn: () => {
          const sel = STATUSES.map((st, i) => `SUM(CASE WHEN o.st = ${sqlStr(st)} THEN i.qty ELSE 0 END) AS s${i}`).join(', ');
          const r = db.executeQuery(`SELECT ${sel} FROM xl_item i JOIN xl_ord o ON i.oid = o.id`);
          if (r.error) return false;
          return STATUSES.every((st, i) => r.data[0]['s' + i] === sum(FLAT.filter(x => x.st === st).map(x => x.qty)));
      }});
      // N4. CTE 内で UNION ALL してから集計
      [2, 3, 4].forEach(k => {
        const regs = REGIONS.slice(0, k);
        const exp = sum(regs.map(rg => FLAT.filter(x => x.region === rg).length));
        const segs = regs.map(rg => `SELECT i.id AS iid FROM xl_item i JOIN xl_ord o ON i.oid = o.id JOIN xl_cust c ON o.cid = c.id WHERE c.region = ${sqlStr(rg)}`).join(' UNION ALL ');
        push(`XL-N cte union ${k}`, `WITH u AS (${segs}) SELECT COUNT(*) AS c FROM u`, r => r.data[0].c === exp);
      });
      // N5. ORDER BY に式を書く（計算列での並べ替え）
      [5, 15, 30].forEach(n => {
        const exp = CUST.slice().sort((a, b) => (b.credit % 100) - (a.credit % 100) || a.id - b.id).slice(0, n).map(c => c.id).join(',');
        push(`XL-N order by expr ${n}`, `SELECT id FROM xl_cust ORDER BY MOD(credit, 100) DESC, id ASC LIMIT ${n}`,
          r => r.data.map(x => x.id).join(',') === exp);
      });
      // N6. 「顧客 → 受注 → 明細」の 3 階層絞り込み。
      // 相関サブクエリの入れ子はエンジンが明示的に非対応なので、
      // 等価な「非相関 IN + 結合」で表現する（下に制約自体のテストも置く）。
      [1, 3, 5, 9].forEach(q => {
        const exp = CUST.filter(c => ORD.some(o => o.cid === c.id && ITEM.some(it => it.oid === o.id && it.qty >= q))).length;
        push(`XL-N three level in qty>=${q}`,
          `SELECT COUNT(*) AS c FROM xl_cust c WHERE c.id IN (SELECT o.cid FROM xl_ord o JOIN xl_item i ON i.oid = o.id WHERE i.qty >= ${q})`,
          r => r.data[0].c === exp);
        push(`XL-N three level exists-join qty>=${q}`,
          `SELECT COUNT(DISTINCT o.cid) AS c FROM xl_ord o JOIN xl_item i ON i.oid = o.id WHERE i.qty >= ${q}`,
          r => r.data[0].c === exp);
      });
      // 入れ子の相関サブクエリは「未対応」を明示エラーで返す（黙って誤答しない）
      T.push({ name: 'XL-N nested correlated rejected', sql:
        "SELECT COUNT(*) AS c FROM xl_cust c WHERE EXISTS (SELECT 1 FROM xl_ord o WHERE o.cid = c.id AND EXISTS (SELECT 1 FROM xl_item i WHERE i.oid = o.id AND i.qty >= 5))",
        isErrorExpected: true,
        check: r => r.error !== undefined && r.error.includes('Nested correlated subqueries are not supported') });
      // N7. IN + NOT IN を同時に使った差集合的な絞り込み
      [10, 20, 30].forEach(n => {
        const exp = ORD.filter(o => o.cid <= n && !(o.cid <= n / 2)).length;
        push(`XL-N in and notin ${n}`,
          `SELECT COUNT(*) AS c FROM xl_ord WHERE cid IN (SELECT id FROM xl_cust WHERE id <= ${n}) AND cid NOT IN (SELECT id FROM xl_cust WHERE id <= ${Math.floor(n / 2)})`,
          r => r.data[0].c === exp);
      });
      // N8. 量化比較を大型データで
      [3, 5, 7].forEach(q => {
        const exp = ITEM.filter(i => i.qty > q).length;
        push(`XL-N gt all ${q}`, `SELECT COUNT(*) AS c FROM xl_item WHERE qty > ALL (SELECT qty FROM xl_item WHERE qty <= ${q})`,
          r => r.data[0].c === exp);
      });
      // N9. 集合演算 + 集計の複合
      [15, 25, 35].forEach(n => {
        const a = CUST.filter(c => c.id <= n).map(c => c.id);
        const b = CUST.filter(c => c.credit >= 600).map(c => c.id);
        const inter = a.filter(x => b.includes(x));
        push(`XL-N intersect sum ${n}`,
          `SELECT COUNT(*) AS c FROM (SELECT id FROM xl_cust WHERE id <= ${n} INTERSECT SELECT id FROM xl_cust WHERE credit >= 600) z`,
          r => r.data[0].c === inter.length);
      });
      // N10. 巨大 SQL: 30 列の計算列 + 結合 + 集計を一度に
      T.push({ name: 'XL-N wide computed report', fn: () => {
          const cols = Array.from({ length: 30 }, (_, i) => `SUM(i.qty * ${i + 1}) AS w${i + 1}`).join(', ');
          const r = db.executeQuery(`SELECT ${cols} FROM xl_item i`);
          if (r.error) return false;
          const base = sum(ITEM.map(i => i.qty));
          return Array.from({ length: 30 }, (_, i) => i + 1).every(k => r.data[0]['w' + k] === base * k);
      }});

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      T.push({ name: 'XL Cleanup', fn: () => {
          ['xl_item', 'xl_ord', 'xl_prod', 'xl_cust'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
          return true;
      }});

      return T;
    }
