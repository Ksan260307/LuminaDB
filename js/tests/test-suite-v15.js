    // ============================================================================
    // [Test Suite v15] - 網羅性拡大 第2弾（v1.12 の新構文＋既存機能の総当たり）
    //   期待値は独立した JS 参照（シード配列・素の JS 実装）から算出し、
    //   SQL 経路（構文解析 → 式コンパイル → 実行）の結果と突き合わせる。
    //   test-suite.js の tests 配列へ getV15Tests() のスプレッドで合流する
    // ============================================================================
    function getV15Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const approx = (a, b) => a != null && Math.abs(a - b) < 1e-6;
      const mround = (x, d) => { const f = Math.pow(10, d || 0); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; };

      // ---- シード（engine-core の _initDefaultData と一致）----
      const U_ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const U_ages = [25, 30, 22, 35, 28, 40, 29, 31, 24, 27];
      const U_names = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"];
      const P_ids = [101, 102, 103, 104, 105];
      const P_prices = [1500, 800, 120, 250, 400];
      const P_stock = [45, 12, 100, 80, 0];
      const O_user = [1, 2, 1, 3, 4];
      const O_amount = [1, 2, 1, 5, 1];

      // ============================================================
      // 1. 量化比較 ANY / SOME / ALL の総当たり（リテラルリスト）
      //    参照実装: JS の some / every
      // ============================================================
      const qSets = [[25, 30], [22, 40], [24, 27, 31], [28], [20, 50]];
      const qOps = [
        ['>', (a, b) => a > b], ['>=', (a, b) => a >= b], ['<', (a, b) => a < b],
        ['<=', (a, b) => a <= b], ['=', (a, b) => a === b], ['<>', (a, b) => a !== b]
      ];
      qSets.forEach((set, si) => qOps.forEach(([op, fn]) => {
        const listTxt = set.join(', ');
        push(`V15Any ${si}${op}`, `SELECT COUNT(*) AS c FROM users WHERE age ${op} ANY (${listTxt})`,
          r => r.data[0].c === U_ages.filter(a => set.some(v => fn(a, v))).length);
        push(`V15Some ${si}${op}`, `SELECT COUNT(*) AS c FROM users WHERE age ${op} SOME (${listTxt})`,
          r => r.data[0].c === U_ages.filter(a => set.some(v => fn(a, v))).length);
        push(`V15All ${si}${op}`, `SELECT COUNT(*) AS c FROM users WHERE age ${op} ALL (${listTxt})`,
          r => r.data[0].c === U_ages.filter(a => set.every(v => fn(a, v))).length);
      }));
      // products の price でも同様に
      [[120, 400], [250, 800, 1500]].forEach((set, si) => qOps.forEach(([op, fn]) => {
        push(`V15PAny ${si}${op}`, `SELECT COUNT(*) AS c FROM products WHERE price ${op} ANY (${set.join(', ')})`,
          r => r.data[0].c === P_prices.filter(p => set.some(v => fn(p, v))).length);
        push(`V15PAll ${si}${op}`, `SELECT COUNT(*) AS c FROM products WHERE price ${op} ALL (${set.join(', ')})`,
          r => r.data[0].c === P_prices.filter(p => set.every(v => fn(p, v))).length);
      }));

      // ============================================================
      // 2. IS [NOT] DISTINCT FROM / <=> の総当たり（NULL 安全比較）
      // ============================================================
      const ndPairs = [
        ['1', '1', false], ['1', '2', true], ['NULL', 'NULL', false], ['NULL', '1', true],
        ['1', 'NULL', true], ["'a'", "'a'", false], ["'a'", "'b'", true], ['0', '0', false],
        ['0', 'NULL', true], ['TRUE', 'TRUE', false], ['TRUE', 'FALSE', true], ['-1', '-1', false]
      ];
      ndPairs.forEach(([a, b, distinct], i) => {
        push(`V15Nd ${i} dist`, `SELECT ${a} IS DISTINCT FROM ${b} AS x`, r => r.data[0].x === distinct);
        push(`V15Nd ${i} notdist`, `SELECT ${a} IS NOT DISTINCT FROM ${b} AS x`, r => r.data[0].x === !distinct);
        push(`V15Nd ${i} nseq`, `SELECT ${a} <=> ${b} AS x`, r => r.data[0].x === !distinct);
      });

      // ============================================================
      // 3. FULL OUTER JOIN の総当たり（重なり方を変えた組み合わせ）
      //    期待行数 = |左のみ| + |一致ペア| + |右のみ|
      // ============================================================
      const joinCases = [
        [[1, 2, 3], [2, 3, 4]], [[1, 2], [3, 4]], [[1, 2, 3], [1, 2, 3]],
        [[1], [1, 2, 3]], [[1, 2, 3], [1]], [[5, 6], [6]], [[1, 2, 3, 4], [2, 4]]
      ];
      joinCases.forEach(([L, R], i) => {
        const tn = `v15j_${i}`;
        const pairs = L.filter(x => R.includes(x)).length;
        const leftOnly = L.filter(x => !R.includes(x)).length;
        const rightOnly = R.filter(x => !L.includes(x)).length;
        T.push({ name: `V15Fj ${i} setup`, fn: () => {
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}_l`); db.executeQuery(`DROP TABLE IF EXISTS ${tn}_r`);
            db.executeQuery(`CREATE TABLE ${tn}_l (id INTEGER)`);
            db.executeQuery(`CREATE TABLE ${tn}_r (id INTEGER)`);
            db.executeQuery(`INSERT INTO ${tn}_l (id) VALUES ${L.map(x => `(${x})`).join(', ')}`);
            db.executeQuery(`INSERT INTO ${tn}_r (id) VALUES ${R.map(x => `(${x})`).join(', ')}`);
            return true;
        }});
        push(`V15Fj ${i} inner`, `SELECT COUNT(*) AS c FROM ${tn}_l l JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs);
        push(`V15Fj ${i} left`, `SELECT COUNT(*) AS c FROM ${tn}_l l LEFT JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + leftOnly);
        push(`V15Fj ${i} right`, `SELECT COUNT(*) AS c FROM ${tn}_l l RIGHT JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + rightOnly);
        push(`V15Fj ${i} full`, `SELECT COUNT(*) AS c FROM ${tn}_l l FULL OUTER JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + leftOnly + rightOnly);
        push(`V15Fj ${i} full leftnull`, `SELECT COUNT(*) AS c FROM ${tn}_l l FULL OUTER JOIN ${tn}_r r ON l.id = r.id WHERE l.id IS NULL`, r => r.data[0].c === rightOnly);
        push(`V15Fj ${i} full rightnull`, `SELECT COUNT(*) AS c FROM ${tn}_l l FULL OUTER JOIN ${tn}_r r ON l.id = r.id WHERE r.id IS NULL`, r => r.data[0].c === leftOnly);
        T.push({ name: `V15Fj ${i} cleanup`, fn: () => {
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}_l`); db.executeQuery(`DROP TABLE IF EXISTS ${tn}_r`);
            return true;
        }});
      });

      // ============================================================
      // 4. GROUPING SETS / CUBE / ROLLUP の行数を組み合わせで検証
      //    n 項目の CUBE は 2^n 集合、ROLLUP は n+1 集合
      // ============================================================
      T.push({ name: 'V15Gs setup', fn: () => {
          db.executeQuery("DROP TABLE IF EXISTS v15gs");
          db.executeQuery("CREATE TABLE v15gs (a TEXT, b TEXT, c TEXT, v INTEGER)");
          const rows = [];
          ['p', 'q'].forEach(a => ['x', 'y'].forEach(b => ['m', 'n'].forEach(c => rows.push(`('${a}','${b}','${c}',1)`))));
          db.executeQuery(`INSERT INTO v15gs (a, b, c, v) VALUES ${rows.join(', ')}`);
          return true;
      }});
      // 2項目: CUBE=4+2+2+1=9行, ROLLUP=4+2+1=7行
      push('V15Gs cube2', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY CUBE(a, b)", r => r.data.length === 9);
      push('V15Gs rollup2', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY ROLLUP(a, b)", r => r.data.length === 7);
      // 3項目: CUBE= 8+4+4+4+2+2+2+1 = 27行, ROLLUP = 8+4+2+1 = 15行
      push('V15Gs cube3', "SELECT a, b, c, SUM(v) AS s FROM v15gs GROUP BY CUBE(a, b, c)", r => r.data.length === 27);
      push('V15Gs rollup3', "SELECT a, b, c, SUM(v) AS s FROM v15gs GROUP BY ROLLUP(a, b, c)", r => r.data.length === 15);
      push('V15Gs total', "SELECT SUM(v) AS s FROM v15gs", r => r.data[0].s === 8);
      push('V15Gs cube total row', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY CUBE(a, b)", r => r.data.some(x => x.a === null && x.b === null && x.s === 8));
      push('V15Gs sets ab', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY GROUPING SETS ((a, b))", r => r.data.length === 4);
      push('V15Gs sets a_b', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY GROUPING SETS ((a), (b))", r => r.data.length === 4);
      push('V15Gs sets a_empty', "SELECT a, SUM(v) AS s FROM v15gs GROUP BY GROUPING SETS ((a), ())", r => r.data.length === 3);
      push('V15Gs sets abc', "SELECT a, b, c, SUM(v) AS s FROM v15gs GROUP BY GROUPING SETS ((a, b, c))", r => r.data.length === 8);
      push('V15Gs sets triple', "SELECT a, b, c, SUM(v) AS s FROM v15gs GROUP BY GROUPING SETS ((a), (b), (c))", r => r.data.length === 6);
      push('V15Gs grouping flag', "SELECT a, GROUPING(a) AS g, SUM(v) AS s FROM v15gs GROUP BY CUBE(a)", r => r.data.filter(x => x.g === 1).length === 1);
      push('V15Gs cube each subtotal', "SELECT a, b, SUM(v) AS s FROM v15gs GROUP BY CUBE(a, b)", r => r.data.filter(x => x.a === null && x.b !== null).length === 2);
      push('V15Gs count agg', "SELECT a, COUNT(*) AS c FROM v15gs GROUP BY CUBE(a)", r => r.data.some(x => x.a === null && x.c === 8));
      T.push({ name: 'V15Gs cleanup', fn: () => { db.executeQuery("DROP TABLE IF EXISTS v15gs"); return true; } });

      // ============================================================
      // 5. PIVOT / UNPIVOT のラウンドトリップ（複数パターン）
      // ============================================================
      for (let k = 0; k < 6; k++) {
        T.push({ name: `V15Pv roundtrip ${k}`, fn: () => {
            const tn = `v15pv_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (g TEXT, k TEXT, v INTEGER)`);
            const base = (k + 1) * 10;
            db.executeQuery(`INSERT INTO ${tn} (g, k, v) VALUES ('a','k1',${base}), ('a','k2',${base + 1}), ('b','k1',${base + 2}), ('b','k2',${base + 3})`);
            const p = db.executeQuery(`SELECT * FROM ${tn} PIVOT (SUM(v) FOR k IN ('k1', 'k2')) x ORDER BY g`);
            const ok1 = p.data.length === 2 && p.data[0].k1 === base && p.data[0].k2 === base + 1
                     && p.data[1].k1 === base + 2 && p.data[1].k2 === base + 3;
            // ピボット結果を UNPIVOT すると元の 4 行に戻る
            const u = db.executeQuery(`SELECT COUNT(*) AS c, SUM(amt) AS s FROM (SELECT * FROM ${tn} PIVOT (SUM(v) FOR k IN ('k1','k2')) x) y UNPIVOT (amt FOR kk IN (k1, k2)) z`);
            const expSum = base + (base + 1) + (base + 2) + (base + 3);
            const ok2 = u.data[0].c === 4 && u.data[0].s === expSum;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return ok1 && ok2;
        }});
      }
      // UNPIVOT の NULL 除外を列数違いで確認
      for (let nulls = 0; nulls <= 3; nulls++) {
        T.push({ name: `V15Up nulls ${nulls}`, fn: () => {
            const tn = `v15up_${nulls}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (g TEXT, c1 INTEGER, c2 INTEGER, c3 INTEGER)`);
            const vals = [1, 2, 3].map((v, i) => (i < nulls ? 'NULL' : String(v)));
            db.executeQuery(`INSERT INTO ${tn} (g, c1, c2, c3) VALUES ('g', ${vals.join(', ')})`);
            const r = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn} UNPIVOT (v FOR col IN (c1, c2, c3)) u`);
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return r.data[0].c === 3 - nulls;
        }});
      }

      // ============================================================
      // 6. CROSS / OUTER APPLY を条件を変えて総当たり
      //    期待: CROSS は一致行のみ、OUTER は左行すべてが最低1行残る
      // ============================================================
      [1, 2, 3, 4, 5].forEach(maxId => {
        const matched = O_user.filter(u => u <= maxId).length;
        const usersWithNone = U_ids.filter(id => !(id <= maxId && O_user.includes(id))).length;
        push(`V15Ap cross ${maxId}`,
          `SELECT u.name AS name, x.oid AS oid FROM users u CROSS APPLY (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id AND o.user_id <= ${maxId}) x`,
          r => r.data.length === matched);
        push(`V15Ap outer ${maxId}`,
          `SELECT u.name AS name, x.oid AS oid FROM users u OUTER APPLY (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id AND o.user_id <= ${maxId}) x`,
          r => r.data.length === matched + usersWithNone);
      });
      // APPLY 内で集計した値を外側で再集計
      push('V15Ap sum of counts', "SELECT SUM(x.c) AS t FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x", r => r.data[0].t === O_user.length);
      push('V15Ap max of counts', "SELECT MAX(x.c) AS m FROM users u CROSS APPLY (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x", r => r.data[0].m === 2);
      push('V15Ap lateral arith', "SELECT SUM(x.d) AS s FROM users u, LATERAL (SELECT u.age + 1 AS d) x", r => r.data[0].s === U_ages.reduce((a, b) => a + b, 0) + U_ages.length);

      // ============================================================
      // 7. WITHIN GROUP の分位を多数の p で検証
      //    参照: 線形補間の PERCENTILE_CONT
      // ============================================================
      const pv = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const pctCont = (arr, p) => {
        const s = [...arr].sort((a, b) => a - b);
        const idx = (s.length - 1) * p;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
      };
      T.push({ name: 'V15Wg setup', fn: () => {
          db.executeQuery("DROP TABLE IF EXISTS v15wg");
          db.executeQuery("CREATE TABLE v15wg (v INTEGER)");
          db.executeQuery(`INSERT INTO v15wg (v) VALUES ${pv.map(x => `(${x})`).join(', ')}`);
          return true;
      }});
      [0, 0.1, 0.25, 0.3, 0.5, 0.6, 0.75, 0.9, 1].forEach((p, i) => {
        push(`V15Wg cont ${i}`, `SELECT PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY v) AS x FROM v15wg`,
          r => approx(r.data[0].x, pctCont(pv, p)));
        push(`V15Wg cont 2arg ${i}`, `SELECT PERCENTILE_CONT(v, ${p}) AS x FROM v15wg`,
          r => approx(r.data[0].x, pctCont(pv, p)));
        push(`V15Wg disc ${i}`, `SELECT PERCENTILE_DISC(${p}) WITHIN GROUP (ORDER BY v) AS x FROM v15wg`,
          r => pv.includes(r.data[0].x));
      });
      push('V15Wg listagg asc', "SELECT LISTAGG(v, ',') WITHIN GROUP (ORDER BY v) AS s FROM v15wg", r => r.data[0].s === pv.join(','));
      push('V15Wg listagg desc', "SELECT LISTAGG(v, ',') WITHIN GROUP (ORDER BY v DESC) AS s FROM v15wg", r => r.data[0].s === [...pv].reverse().join(','));
      push('V15Wg listagg pipe', "SELECT LISTAGG(v, '|') WITHIN GROUP (ORDER BY v) AS s FROM v15wg", r => r.data[0].s === pv.join('|'));

      // ============================================================
      // 8. ウィンドウフレーム ROWS / RANGE / GROUPS の総当たり
      //    参照: JS でフレームを再現して SUM を計算
      // ============================================================
      const fv = [1, 1, 2, 3, 3, 4]; // ピア（同値）を含む
      T.push({ name: 'V15Fr setup', fn: () => {
          db.executeQuery("DROP TABLE IF EXISTS v15fr");
          db.executeQuery("CREATE TABLE v15fr (v INTEGER)");
          db.executeQuery(`INSERT INTO v15fr (v) VALUES ${fv.map(x => `(${x})`).join(', ')}`);
          return true;
      }});
      const sorted = [...fv].sort((a, b) => a - b);
      // ROWS n PRECEDING .. CURRENT ROW
      [0, 1, 2, 3].forEach(n => {
        const exp = sorted.map((_, i) => sorted.slice(Math.max(0, i - n), i + 1).reduce((a, b) => a + b, 0));
        push(`V15Fr rows ${n}`, `SELECT v, SUM(v) OVER (ORDER BY v ROWS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === exp.join(','));
      });
      // RANGE n PRECEDING .. CURRENT ROW（値の差で判定 = 同値ピアを含む）
      [0, 1, 2].forEach(n => {
        const exp = sorted.map(cur => sorted.filter(x => x >= cur - n && x <= cur).reduce((a, b) => a + b, 0));
        push(`V15Fr range ${n}`, `SELECT v, SUM(v) OVER (ORDER BY v RANGE BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === exp.join(','));
      });
      // GROUPS n PRECEDING .. CURRENT ROW（ピアグループ単位）
      const uniq = [...new Set(sorted)];
      [0, 1, 2].forEach(n => {
        const exp = sorted.map(cur => {
          const g = uniq.indexOf(cur);
          const lo = uniq[Math.max(0, g - n)];
          return sorted.filter(x => x >= lo && x <= cur).reduce((a, b) => a + b, 0);
        });
        push(`V15Fr groups ${n}`, `SELECT v, SUM(v) OVER (ORDER BY v GROUPS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === exp.join(','));
      });
      // COUNT / MIN / MAX をフレーム付きで
      [1, 2].forEach(n => {
        const expC = sorted.map((_, i) => sorted.slice(Math.max(0, i - n), i + 1).length);
        push(`V15Fr count rows ${n}`, `SELECT COUNT(*) OVER (ORDER BY v ROWS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === expC.join(','));
        const expMin = sorted.map((_, i) => Math.min(...sorted.slice(Math.max(0, i - n), i + 1)));
        push(`V15Fr min rows ${n}`, `SELECT MIN(v) OVER (ORDER BY v ROWS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === expMin.join(','));
        const expMax = sorted.map((_, i) => Math.max(...sorted.slice(Math.max(0, i - n), i + 1)));
        push(`V15Fr max rows ${n}`, `SELECT MAX(v) OVER (ORDER BY v ROWS BETWEEN ${n} PRECEDING AND CURRENT ROW) AS s FROM v15fr ORDER BY v`,
          r => r.data.map(x => x.s).join(',') === expMax.join(','));
      });
      push('V15Fr unbounded both', "SELECT SUM(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS s FROM v15fr LIMIT 1",
        r => r.data[0].s === fv.reduce((a, b) => a + b, 0));
      push('V15Fr range unbounded both', "SELECT SUM(v) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS s FROM v15fr LIMIT 1",
        r => r.data[0].s === fv.reduce((a, b) => a + b, 0));
      push('V15Fr groups unbounded both', "SELECT SUM(v) OVER (ORDER BY v GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS s FROM v15fr LIMIT 1",
        r => r.data[0].s === fv.reduce((a, b) => a + b, 0));
      T.push({ name: 'V15Fr cleanup', fn: () => { db.executeQuery("DROP TABLE IF EXISTS v15fr"); return true; } });

      // ============================================================
      // 9. MATERIALIZED VIEW のライフサイクルを繰り返し検証
      // ============================================================
      for (let k = 0; k < 5; k++) {
        T.push({ name: `V15Mv lifecycle ${k}`, fn: () => {
            const st = `v15mvs_${k}`, mv = `v15mv_${k}`;
            db.executeQuery(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`);
            db.executeQuery(`DROP TABLE IF EXISTS ${st}`);
            db.executeQuery(`CREATE TABLE ${st} (v INTEGER)`);
            db.executeQuery(`INSERT INTO ${st} (v) VALUES (${k + 1}), (${k + 2})`);
            db.executeQuery(`CREATE MATERIALIZED VIEW ${mv} AS SELECT SUM(v) AS s FROM ${st}`);
            const before = db.executeQuery(`SELECT s FROM ${mv}`).data[0].s;
            db.executeQuery(`INSERT INTO ${st} (v) VALUES (100)`);
            const stale = db.executeQuery(`SELECT s FROM ${mv}`).data[0].s;
            db.executeQuery(`REFRESH MATERIALIZED VIEW ${mv}`);
            const after = db.executeQuery(`SELECT s FROM ${mv}`).data[0].s;
            db.executeQuery(`DROP MATERIALIZED VIEW ${mv}`);
            db.executeQuery(`DROP TABLE IF EXISTS ${st}`);
            return before === (k + 1) + (k + 2) && stale === before && after === before + 100;
        }});
      }

      // ============================================================
      // 10. SELECT INTO / COMMENT ON / IDENTITY を繰り返し検証
      // ============================================================
      for (let k = 0; k < 6; k++) {
        const th = 20 + k * 3;
        T.push({ name: `V15Into ${k}`, fn: () => {
            const tn = `v15si_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            const r = db.executeQuery(`SELECT id, age INTO ${tn} FROM users WHERE age >= ${th}`);
            if (r.error) return false;
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            const s = db.executeQuery(`SELECT SUM(age) AS s FROM ${tn}`).data[0].s;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            const exp = U_ages.filter(a => a >= th);
            return c === exp.length && s === exp.reduce((a, b) => a + b, 0);
        }});
      }
      for (let k = 0; k < 5; k++) {
        T.push({ name: `V15Cm comment ${k}`, fn: () => {
            const tn = `v15cm_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (a INTEGER, b TEXT)`);
            db.executeQuery(`COMMENT ON TABLE ${tn} IS 'tbl ${k}'`);
            db.executeQuery(`COMMENT ON COLUMN ${tn}.a IS 'col ${k}'`);
            const rows = db.executeQuery('SHOW COMMENTS').data;
            const okT = rows.some(x => x.Kind === 'TABLE' && x.Object === tn && x.Comment === `tbl ${k}`);
            const okC = rows.some(x => x.Kind === 'COLUMN' && x.Object === `${tn}.a` && x.Comment === `col ${k}`);
            db.executeQuery(`COMMENT ON TABLE ${tn} IS NULL`);
            const gone = !db.executeQuery('SHOW COMMENTS').data.some(x => x.Kind === 'TABLE' && x.Object === tn);
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return okT && okC && gone;
        }});
      }
      for (let k = 1; k <= 6; k++) {
        T.push({ name: `V15Id identity ${k}`, fn: () => {
            const tn = `v15id_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER GENERATED ALWAYS AS IDENTITY, v TEXT)`);
            for (let i = 0; i < k; i++) db.executeQuery(`INSERT INTO ${tn} (v) VALUES ('r${i}')`);
            const r = db.executeQuery(`SELECT id FROM ${tn} ORDER BY id`);
            const seq = r.data.map(x => x.id).join(',');
            const expSeq = Array.from({ length: k }, (_, i) => i + 1).join(',');
            db.executeQuery(`TRUNCATE TABLE ${tn} RESTART IDENTITY`);
            db.executeQuery(`INSERT INTO ${tn} (v) VALUES ('again')`);
            const restarted = db.executeQuery(`SELECT id FROM ${tn}`).data[0].id === 1;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return seq === expSeq && restarted;
        }});
      }

      // ============================================================
      // 11. 既存機能のさらなる網羅（結合 / 集計 / 文字列 / 数値 / 日付）
      // ============================================================
      // JOIN の行数をシードから算出
      push('V15Jn users-orders inner', "SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id", r => r.data[0].c === O_user.length);
      push('V15Jn users-orders left', "SELECT COUNT(*) AS c FROM users u LEFT JOIN orders o ON u.id = o.user_id",
        r => r.data[0].c === O_user.length + U_ids.filter(id => !O_user.includes(id)).length);
      push('V15Jn orders-products', "SELECT COUNT(*) AS c FROM orders o JOIN products p ON o.product_id = p.id", r => r.data[0].c === 5);
      push('V15Jn three way', "SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id", r => r.data[0].c === 5);
      push('V15Jn cross product', "SELECT COUNT(*) AS c FROM users CROSS JOIN products", r => r.data[0].c === U_ids.length * P_ids.length);
      push('V15Jn revenue', "SELECT SUM(o.amount * p.price) AS s FROM orders o JOIN products p ON o.product_id = p.id",
        r => r.data[0].s === O_amount.reduce((acc, amt, i) => acc + amt * P_prices[P_ids.indexOf([101, 103, 105, 102, 104][i])], 0));
      // 集計の総当たり（products）
      push('V15Ag prod count', "SELECT COUNT(*) AS c FROM products", r => r.data[0].c === P_ids.length);
      push('V15Ag prod sum stock', "SELECT SUM(stock) AS s FROM products", r => r.data[0].s === P_stock.reduce((a, b) => a + b, 0));
      push('V15Ag prod avg price', "SELECT AVG(price) AS a FROM products", r => approx(r.data[0].a, Number((P_prices.reduce((a, b) => a + b, 0) / P_prices.length).toFixed(2))));
      push('V15Ag prod max stock', "SELECT MAX(stock) AS m FROM products", r => r.data[0].m === Math.max(...P_stock));
      push('V15Ag orders sum', "SELECT SUM(amount) AS s FROM orders", r => r.data[0].s === O_amount.reduce((a, b) => a + b, 0));
      push('V15Ag orders avg', "SELECT AVG(amount) AS a FROM orders", r => approx(r.data[0].a, Number((O_amount.reduce((a, b) => a + b, 0) / O_amount.length).toFixed(2))));
      // 文字列関数を全ユーザー名で総当たり
      U_names.forEach((nm, i) => {
        push(`V15S lower ${i}`, `SELECT LOWER(name) AS x FROM users WHERE id = ${i + 1}`, r => r.data[0].x === nm.toLowerCase());
        push(`V15S left3 ${i}`, `SELECT LEFT(name, 3) AS x FROM users WHERE id = ${i + 1}`, r => r.data[0].x === nm.slice(0, 3));
        push(`V15S right2 ${i}`, `SELECT RIGHT(name, 2) AS x FROM users WHERE id = ${i + 1}`, r => r.data[0].x === nm.slice(-2));
        push(`V15S concat ${i}`, `SELECT CONCAT(name, '!') AS x FROM users WHERE id = ${i + 1}`, r => r.data[0].x === nm + '!');
        push(`V15S initcap ${i}`, `SELECT INITCAP(LOWER(name)) AS x FROM users WHERE id = ${i + 1}`, r => r.data[0].x === nm);
      });
      // 数値関数を全 price で総当たり
      P_prices.forEach((p, i) => {
        push(`V15N sqrt ${i}`, `SELECT ROUND(SQRT(price), 4) AS x FROM products WHERE id = ${P_ids[i]}`, r => approx(r.data[0].x, mround(Math.sqrt(p), 4)));
        push(`V15N half ${i}`, `SELECT price / 2 AS x FROM products WHERE id = ${P_ids[i]}`, r => approx(r.data[0].x, p / 2));
        push(`V15N mod7 ${i}`, `SELECT MOD(price, 7) AS x FROM products WHERE id = ${P_ids[i]}`, r => r.data[0].x === p % 7);
        push(`V15N abs neg ${i}`, `SELECT ABS(0 - price) AS x FROM products WHERE id = ${P_ids[i]}`, r => r.data[0].x === p);
      });
      // 日付関数を固定日で総当たり
      const dts = ['2024-01-31', '2024-02-29', '2025-06-15', '2026-12-25', '2027-03-01', '2023-11-30'];
      dts.forEach((d, i) => {
        const dt = new Date(d + 'T00:00:00Z');
        push(`V15D dow ${i}`, `SELECT DAYOFWEEK(DATE('${d}')) AS x`, r => r.data[0].x === dt.getUTCDay() + 1);
        push(`V15D q ${i}`, `SELECT QUARTER(DATE('${d}')) AS x`, r => r.data[0].x === Math.floor(dt.getUTCMonth() / 3) + 1);
        push(`V15D lastday ${i}`, `SELECT LAST_DAY(DATE('${d}')) AS x`, r => {
          const e = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0));
          return r.data[0].x === e.toISOString().slice(0, 10);
        });
        push(`V15D addday ${i}`, `SELECT DATEADD(DAY, 7, DATE('${d}')) AS x`, r => {
          const e = new Date(dt.getTime() + 7 * 86400000);
          return String(r.data[0].x).startsWith(e.toISOString().slice(0, 10));
        });
        push(`V15D diff ${i}`, `SELECT DATEDIFF(DAY, DATE('${d}'), DATE('${d}')) AS x`, r => r.data[0].x === 0);
      });

      // ============================================================
      // 12. セッション文・SHOW 系の受理確認（スクリプト互換）
      // ============================================================
      const sessionStmts = [
        "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED",
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
        "SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE",
        "SET TRANSACTION READ ONLY",
        "SET TRANSACTION READ WRITE",
        "LOCK TABLES users READ",
        "LOCK TABLE users IN EXCLUSIVE MODE",
        "UNLOCK TABLES",
        "GRANT SELECT ON users TO app_user",
        "GRANT ALL PRIVILEGES ON products TO admin",
        "REVOKE INSERT ON users FROM app_user",
        "ANALYZE",
        "DISCARD ALL"
      ];
      sessionStmts.forEach((s, i) => push(`V15Se ${i}`, s, r => r.data[0].Result === 'Success'));
      push('V15Sh storage shape', "SHOW STORAGE", r => r.data.length === 9 && r.data.every(x => x.Metric !== undefined && x.Value !== undefined));
      push('V15Sh settings has effective', "SHOW SETTINGS", r => r.data.some(x => x.Setting === 'effective_isolation' && x.Value === 'SERIALIZABLE'));
      push('V15Sh matviews empty ok', "SHOW MATERIALIZED VIEWS", r => Array.isArray(r.data));
      push('V15Sh comments array', "SHOW COMMENTS", r => Array.isArray(r.data));
      push('V15Sh tables still works', "SHOW TABLES", r => r.data.some(x => x.Table === 'users'));
      push('V15Sh functions still works', "SHOW FUNCTIONS LIKE 'SUM'", r => r.data.length >= 1);

      // ============================================================
      // 13. 量化比較の追加総当たり（別のしきい値集合 / products・orders 上）
      // ============================================================
      const qSets2 = [[27], [22, 25, 28], [31, 35], [24, 29, 40], [26, 33], [23, 37, 41]];
      qSets2.forEach((set, si) => qOps.forEach(([op, fn]) => {
        push(`V15Any2 ${si}${op}`, `SELECT COUNT(*) AS c FROM users WHERE age ${op} ANY (${set.join(', ')})`,
          r => r.data[0].c === U_ages.filter(a => set.some(v => fn(a, v))).length);
        push(`V15All2 ${si}${op}`, `SELECT COUNT(*) AS c FROM users WHERE age ${op} ALL (${set.join(', ')})`,
          r => r.data[0].c === U_ages.filter(a => set.every(v => fn(a, v))).length);
      }));
      [[45, 80], [0, 12, 100], [12, 45, 80, 100]].forEach((set, si) => qOps.forEach(([op, fn]) => {
        push(`V15SAny ${si}${op}`, `SELECT COUNT(*) AS c FROM products WHERE stock ${op} ANY (${set.join(', ')})`,
          r => r.data[0].c === P_stock.filter(s => set.some(v => fn(s, v))).length);
        push(`V15SAll ${si}${op}`, `SELECT COUNT(*) AS c FROM products WHERE stock ${op} ALL (${set.join(', ')})`,
          r => r.data[0].c === P_stock.filter(s => set.every(v => fn(s, v))).length);
      }));
      [[1, 2], [1, 5], [2, 5]].forEach((set, si) => qOps.forEach(([op, fn]) => {
        push(`V15OAny ${si}${op}`, `SELECT COUNT(*) AS c FROM orders WHERE amount ${op} ANY (${set.join(', ')})`,
          r => r.data[0].c === O_amount.filter(a => set.some(v => fn(a, v))).length);
      }));

      // ============================================================
      // 14. FULL OUTER JOIN の追加パターン（重複キー・空表を含む）
      // ============================================================
      const joinCases2 = [
        [[1, 1, 2], [2, 3]], [[], [1, 2]], [[1, 2], []], [[7], [7]],
        [[1, 2, 3, 4, 5], [3, 4, 5, 6, 7]], [[9], [8]]
      ];
      joinCases2.forEach(([L, R], i) => {
        const tn = `v15k_${i}`;
        // 重複キーがあるため、一致行数は左右のカウント積の総和で数える
        const keys = [...new Set([...L, ...R])];
        let pairs = 0, leftOnly = 0, rightOnly = 0;
        keys.forEach(k => {
          const lc = L.filter(x => x === k).length;
          const rc = R.filter(x => x === k).length;
          if (lc && rc) pairs += lc * rc;
          else if (lc) leftOnly += lc;
          else rightOnly += rc;
        });
        T.push({ name: `V15Fk ${i} setup`, fn: () => {
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}_l`); db.executeQuery(`DROP TABLE IF EXISTS ${tn}_r`);
            db.executeQuery(`CREATE TABLE ${tn}_l (id INTEGER)`);
            db.executeQuery(`CREATE TABLE ${tn}_r (id INTEGER)`);
            if (L.length) db.executeQuery(`INSERT INTO ${tn}_l (id) VALUES ${L.map(x => `(${x})`).join(', ')}`);
            if (R.length) db.executeQuery(`INSERT INTO ${tn}_r (id) VALUES ${R.map(x => `(${x})`).join(', ')}`);
            return true;
        }});
        push(`V15Fk ${i} inner`, `SELECT COUNT(*) AS c FROM ${tn}_l l JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs);
        push(`V15Fk ${i} left`, `SELECT COUNT(*) AS c FROM ${tn}_l l LEFT JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + leftOnly);
        push(`V15Fk ${i} right`, `SELECT COUNT(*) AS c FROM ${tn}_l l RIGHT JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + rightOnly);
        push(`V15Fk ${i} full`, `SELECT COUNT(*) AS c FROM ${tn}_l l FULL OUTER JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + leftOnly + rightOnly);
        push(`V15Fk ${i} full outer kw`, `SELECT COUNT(*) AS c FROM ${tn}_l l FULL JOIN ${tn}_r r ON l.id = r.id`, r => r.data[0].c === pairs + leftOnly + rightOnly);
        T.push({ name: `V15Fk ${i} cleanup`, fn: () => {
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}_l`); db.executeQuery(`DROP TABLE IF EXISTS ${tn}_r`);
            return true;
        }});
      });

      // ============================================================
      // 15. 述語・集計の追加網羅（users / products / orders）
      // ============================================================
      const ageT = [21, 23, 26, 32, 34, 36, 38, 41];
      ageT.forEach(t => {
        push(`V15W2 gt ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age > ${t}`, r => r.data[0].c === U_ages.filter(a => a > t).length);
        push(`V15W2 le ${t}`, `SELECT COUNT(*) AS c FROM users WHERE age <= ${t}`, r => r.data[0].c === U_ages.filter(a => a <= t).length);
        push(`V15W2 sum ${t}`, `SELECT SUM(age) AS s FROM users WHERE age > ${t}`, r => (r.data[0].s || 0) === U_ages.filter(a => a > t).reduce((x, y) => x + y, 0));
        push(`V15W2 cnt distinct ${t}`, `SELECT COUNT(DISTINCT age) AS c FROM users WHERE age > ${t}`, r => r.data[0].c === new Set(U_ages.filter(a => a > t)).size);
        const f = U_ages.filter(a => a > t);
        push(`V15W2 min ${t}`, `SELECT MIN(age) AS m FROM users WHERE age > ${t}`, r => r.data[0].m === (f.length ? Math.min(...f) : null));
        push(`V15W2 max ${t}`, `SELECT MAX(age) AS m FROM users WHERE age > ${t}`, r => r.data[0].m === (f.length ? Math.max(...f) : null));
      });
      const priceT = [100, 200, 300, 500, 900, 1600];
      priceT.forEach(t => {
        push(`V15P2 gt ${t}`, `SELECT COUNT(*) AS c FROM products WHERE price > ${t}`, r => r.data[0].c === P_prices.filter(p => p > t).length);
        push(`V15P2 sum le ${t}`, `SELECT SUM(price) AS s FROM products WHERE price <= ${t}`, r => (r.data[0].s || 0) === P_prices.filter(p => p <= t).reduce((a, b) => a + b, 0));
        push(`V15P2 avgstock gt ${t}`, `SELECT COUNT(*) AS c FROM products WHERE price > ${t} AND stock > 0`,
          r => r.data[0].c === P_prices.filter((p, i) => p > t && P_stock[i] > 0).length);
      });
      // ORDER BY / LIMIT の組み合わせ
      [1, 2, 3, 4, 5, 6, 8, 10].forEach(n => {
        push(`V15Ol asc ${n}`, `SELECT age FROM users ORDER BY age ASC LIMIT ${n}`,
          r => r.data.map(x => x.age).join(',') === [...U_ages].sort((a, b) => a - b).slice(0, n).join(','));
        push(`V15Ol desc ${n}`, `SELECT age FROM users ORDER BY age DESC LIMIT ${n}`,
          r => r.data.map(x => x.age).join(',') === [...U_ages].sort((a, b) => b - a).slice(0, n).join(','));
        push(`V15Ol top ${n}`, `SELECT TOP ${n} age FROM users ORDER BY age ASC`,
          r => r.data.map(x => x.age).join(',') === [...U_ages].sort((a, b) => a - b).slice(0, n).join(','));
      });
      // OFFSET を変えながら
      [0, 1, 3, 5, 7, 9].forEach(o => {
        push(`V15Of ${o}`, `SELECT id FROM users ORDER BY id LIMIT 2 OFFSET ${o}`,
          r => r.data.map(x => x.id).join(',') === U_ids.slice(o, o + 2).join(','));
      });

      // ============================================================
      // 16. ウィンドウ関数の追加網羅（RANK / DENSE_RANK / LAG / LEAD / NTILE）
      // ============================================================
      const sortedDesc = [...U_ages].sort((a, b) => b - a);
      push('V15Wf rownum full', "SELECT ROW_NUMBER() OVER (ORDER BY age DESC) AS rn FROM users ORDER BY rn",
        r => r.data.map(x => x.rn).join(',') === U_ids.map((_, i) => i + 1).join(','));
      push('V15Wf rank distinct ages', "SELECT age, RANK() OVER (ORDER BY age DESC) AS rk FROM users ORDER BY rk",
        r => r.data[0].age === sortedDesc[0] && r.data[0].rk === 1 && r.data[9].rk === 10);
      push('V15Wf dense rank', "SELECT DENSE_RANK() OVER (ORDER BY age) AS dr FROM users ORDER BY dr",
        r => r.data[9].dr === new Set(U_ages).size);
      push('V15Wf lag first null', "SELECT LAG(age) OVER (ORDER BY id) AS l FROM users ORDER BY id", r => r.data[0].l === null);
      push('V15Wf lead last null', "SELECT LEAD(age) OVER (ORDER BY id) AS l FROM users ORDER BY id", r => r.data[9].l === null);
      push('V15Wf lag value', "SELECT id, LAG(age) OVER (ORDER BY id) AS l FROM users ORDER BY id", r => r.data[1].l === U_ages[0]);
      push('V15Wf lead value', "SELECT id, LEAD(age) OVER (ORDER BY id) AS l FROM users ORDER BY id", r => r.data[0].l === U_ages[1]);
      [2, 3, 5].forEach(n => {
        push(`V15Wf ntile ${n}`, `SELECT NTILE(${n}) OVER (ORDER BY id) AS t FROM users ORDER BY id`,
          r => new Set(r.data.map(x => x.t)).size === n);
      });
      push('V15Wf running sum', "SELECT SUM(age) OVER (ORDER BY id) AS s FROM users ORDER BY id",
        r => r.data[9].s === U_ages.reduce((a, b) => a + b, 0));
      push('V15Wf partition count', "SELECT COUNT(*) OVER (PARTITION BY user_id) AS c FROM orders ORDER BY user_id",
        r => r.data.some(x => x.c === 2));
      push('V15Wf first_value', "SELECT FIRST_VALUE(age) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS f FROM users ORDER BY id",
        r => r.data[5].f === U_ages[0]);
      push('V15Wf last_value', "SELECT LAST_VALUE(age) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS f FROM users ORDER BY id",
        r => r.data[5].f === U_ages[5]);

      // ============================================================
      // 17. トランザクション・制約の追加網羅
      // ============================================================
      for (let k = 0; k < 6; k++) {
        T.push({ name: `V15Tx rollback ${k}`, fn: () => {
            const tn = `v15tx_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER PRIMARY KEY, v INTEGER)`);
            db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (1, ${k})`);
            db.executeQuery('BEGIN');
            db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (2, 99)`);
            db.executeQuery(`UPDATE ${tn} SET v = 555 WHERE id = 1`);
            db.executeQuery('ROLLBACK');
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            const v = db.executeQuery(`SELECT v FROM ${tn} WHERE id = 1`).data[0].v;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return c === 1 && v === k;
        }});
        T.push({ name: `V15Tx commit ${k}`, fn: () => {
            const tn = `v15tc_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER PRIMARY KEY, v INTEGER)`);
            db.executeQuery('BEGIN');
            db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (1, ${k}), (2, ${k + 1})`);
            db.executeQuery('COMMIT');
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return c === 2;
        }});
        T.push({ name: `V15Cn unique ${k}`, fn: () => {
            const tn = `v15cn_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER UNIQUE, v INTEGER)`);
            db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (${k}, 1)`);
            const dup = db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (${k}, 2)`);
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return dup.error !== undefined && c === 1;
        }});
        T.push({ name: `V15Cn notnull ${k}`, fn: () => {
            const tn = `v15nn_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER, v INTEGER NOT NULL)`);
            const bad = db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (${k}, NULL)`);
            const good = db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES (${k}, 1)`);
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return bad.error !== undefined && !good.error;
        }});
      }

      // ============================================================
      // 18. DML の追加網羅（UPSERT / MERGE / ON CONFLICT を繰り返し）
      // ============================================================
      for (let k = 0; k < 5; k++) {
        T.push({ name: `V15Dm merge ${k}`, fn: () => {
            const t1 = `v15mt_${k}`, t2 = `v15ms_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${t1}`); db.executeQuery(`DROP TABLE IF EXISTS ${t2}`);
            db.executeQuery(`CREATE TABLE ${t1} (id INTEGER PRIMARY KEY, v INTEGER)`);
            db.executeQuery(`CREATE TABLE ${t2} (id INTEGER, v INTEGER)`);
            db.executeQuery(`INSERT INTO ${t1} (id, v) VALUES (1, ${k}), (2, ${k})`);
            db.executeQuery(`INSERT INTO ${t2} (id, v) VALUES (2, ${k * 10}), (3, ${k * 100})`);
            db.executeQuery(`MERGE INTO ${t1} t USING ${t2} s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)`);
            const rows = db.executeQuery(`SELECT id, v FROM ${t1} ORDER BY id`).data;
            db.executeQuery(`DROP TABLE IF EXISTS ${t1}`); db.executeQuery(`DROP TABLE IF EXISTS ${t2}`);
            return rows.length === 3 && rows[0].v === k && rows[1].v === k * 10 && rows[2].v === k * 100;
        }});
        T.push({ name: `V15Dm conflict ${k}`, fn: () => {
            const tn = `v15oc_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER PRIMARY KEY, c INTEGER)`);
            db.executeQuery(`INSERT INTO ${tn} (id, c) VALUES (1, ${k})`);
            db.executeQuery(`INSERT INTO ${tn} (id, c) VALUES (1, 100) ON CONFLICT (id) DO UPDATE SET c = ${tn}.c + EXCLUDED.c`);
            const v1 = db.executeQuery(`SELECT c FROM ${tn} WHERE id = 1`).data[0].c;
            db.executeQuery(`INSERT INTO ${tn} (id, c) VALUES (1, 7) ON CONFLICT (id) DO NOTHING`);
            const v2 = db.executeQuery(`SELECT c FROM ${tn} WHERE id = 1`).data[0].c;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            return v1 === k + 100 && v2 === v1;
        }});
        T.push({ name: `V15Dm delete where ${k}`, fn: () => {
            const tn = `v15dw_${k}`;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            db.executeQuery(`CREATE TABLE ${tn} (id INTEGER, v INTEGER)`);
            const vals = Array.from({ length: 10 }, (_, i) => `(${i}, ${i * (k + 1)})`).join(', ');
            db.executeQuery(`INSERT INTO ${tn} (id, v) VALUES ${vals}`);
            db.executeQuery(`DELETE FROM ${tn} WHERE id >= 5`);
            const c = db.executeQuery(`SELECT COUNT(*) AS c FROM ${tn}`).data[0].c;
            const s = db.executeQuery(`SELECT SUM(v) AS s FROM ${tn}`).data[0].s;
            db.executeQuery(`DROP TABLE IF EXISTS ${tn}`);
            const exp = [0, 1, 2, 3, 4].reduce((a, i) => a + i * (k + 1), 0);
            return c === 5 && s === exp;
        }});
      }

      // ============================================================
      // 19. 文字列・数値関数の追加総当たり
      // ============================================================
      for (let n = 1; n <= 12; n++) {
        push(`V15X2 space ${n}`, `SELECT LENGTH(SPACE(${n})) AS x`, r => r.data[0].x === n);
        push(`V15X2 lpadlen ${n}`, `SELECT LENGTH(LPAD('a', ${n}, '.')) AS x`, r => r.data[0].x === Math.max(1, n));
        push(`V15X2 hex ${n}`, `SELECT HEX(${n}) AS x`, r => r.data[0].x === n.toString(16).toUpperCase());
        push(`V15X2 bin ${n}`, `SELECT BIN(${n}) AS x`, r => r.data[0].x === n.toString(2));
        push(`V15X2 tohex ${n}`, `SELECT TO_HEX(${n}) AS x`, r => r.data[0].x === n.toString(16));
      }
      for (let n = -5; n <= 5; n++) {
        push(`V15X2 shl ${n}`, `SELECT SHIFTLEFT(${n}, 2) AS x`, r => r.data[0].x === (n << 2));
        push(`V15X2 shr ${n}`, `SELECT SHIFTRIGHT(${n}, 1) AS x`, r => r.data[0].x === (n >> 1));
        push(`V15X2 bitnot ${n}`, `SELECT BITNOT(${n}) AS x`, r => r.data[0].x === ~n);
      }
      [[6, 4], [9, 6], [12, 18], [7, 13], [100, 75]].forEach(([a, b], i) => {
        const g = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) { [x, y] = [y, x % y]; } return x; };
        push(`V15X2 gcd ${i}`, `SELECT GCD(${a}, ${b}) AS x`, r => r.data[0].x === g(a, b));
        push(`V15X2 lcm ${i}`, `SELECT LCM(${a}, ${b}) AS x`, r => r.data[0].x === Math.abs(a * b) / g(a, b));
        push(`V15X2 bitand ${i}`, `SELECT BITAND(${a}, ${b}) AS x`, r => r.data[0].x === (a & b));
        push(`V15X2 bitor ${i}`, `SELECT BITOR(${a}, ${b}) AS x`, r => r.data[0].x === (a | b));
        push(`V15X2 bitxor ${i}`, `SELECT BITXOR(${a}, ${b}) AS x`, r => r.data[0].x === (a ^ b));
      });
      ['abc', 'Hello World', 'a-b-c', '  pad  ', 'MiXeD', 'x'].forEach((s, i) => {
        const q = s.replace(/'/g, "''");
        push(`V15X2 up ${i}`, `SELECT UPPER('${q}') AS x`, r => r.data[0].x === s.toUpperCase());
        push(`V15X2 low ${i}`, `SELECT LOWER('${q}') AS x`, r => r.data[0].x === s.toLowerCase());
        push(`V15X2 len ${i}`, `SELECT LENGTH('${q}') AS x`, r => r.data[0].x === s.length);
        push(`V15X2 rev ${i}`, `SELECT REVERSE('${q}') AS x`, r => r.data[0].x === s.split('').reverse().join(''));
        push(`V15X2 trim ${i}`, `SELECT TRIM('${q}') AS x`, r => r.data[0].x === s.trim());
        push(`V15X2 asc ${i}`, `SELECT ASCII('${q}') AS x`, r => r.data[0].x === s.charCodeAt(0));
      });

      return T;
    }
