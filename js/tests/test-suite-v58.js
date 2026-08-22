    // ============================================================================
    // [Test Suite v58] - 特殊なクエリ構成 (2/4): 縮退したデータと境界
    //
    //   0 行・1 行・全 NULL・全部同じ値・重複だらけ、といった「縮退した表」に対して
    //   ひととおりの操作を掛け、期待値は JavaScript 側の模型から求めて突き合わせる。
    //   境界（LIMIT / OFFSET の格子、常に真・常に偽の述語）も同じやり方で総当たりする。
    //
    //     A. 集約（表 × 集約関数）
    //     B. まとめ方（GROUP BY / DISTINCT / HAVING）
    //     C. ページング（LIMIT × OFFSET の格子）
    //     D. 述語（常に真・常に偽・NULL 比較・境界値）
    //     E. 並べ替え（全同値・全 NULL・NULLS FIRST / LAST）
    //     F. 結合（空表・1 行・重複との組み合わせ）
    //     G. 集合演算（空集合・自分自身・重複）
    //     H. ウィンドウ関数
    //     I. 書き換え（空表・全行・0 行に当たる UPDATE / DELETE）
    //
    //   test-suite.js の tests 配列へ getV58Tests() のスプレッドで合流する
    // ============================================================================
    function getV58Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V58');

      // ------------------------------------------------------------
      // 0. フィクスチャと JavaScript 側の模型
      //    どの表も (id INT PRIMARY KEY, v INT, g TEXT) の同じ形にして、
      //    同じクエリ文を表名だけ変えて流せるようにする
      // ------------------------------------------------------------
      const MODEL = {
        empty: [],
        one: [[1, 7, 'a']],
        two: [[1, 7, 'a'], [2, 9, 'b']],
        nul: [[1, null, null], [2, null, null], [3, null, null]],
        dup: [[1, 5, 'a'], [2, 5, 'a'], [3, 5, 'a'], [4, 5, 'a'], [5, 5, 'a']],
        same: [[1, 3, 'x'], [2, 3, 'x'], [3, 3, 'x'], [4, 3, 'x']],
        mix: [[1, 10, 'a'], [2, null, 'b'], [3, 30, null], [4, 10, 'a'], [5, null, null],
              [6, 50, 'c'], [7, 30, 'b'], [8, 0, 'a'], [9, -5, null], [10, 10, 'c']],
        // 全部が負 / 値が 2 種類だけ / 1 行だけ値があって残りは NULL
        neg: [[1, -1, 'a'], [2, -50, 'b'], [3, -100, 'a'], [4, -7, 'c']],
        pair: [[1, 1, 'a'], [2, 2, 'b'], [3, 1, 'a'], [4, 2, 'b'], [5, 1, 'a'], [6, 2, 'b']],
        lone: [[1, 42, 'a'], [2, null, null], [3, null, null], [4, null, null], [5, null, null]],
        big: Array.from({ length: 40 }, (_, i) => [i + 1, (i % 7 === 6) ? null : ((i * 13) % 50) - 10,
                                                  (i % 9 === 8) ? null : ['a', 'b', 'c', 'd'][i % 4]]),
      };
      const NAMES = Object.keys(MODEL);
      const tbl = (k) => 'v58_' + k;
      const rowsOfModel = (k) => MODEL[k].map(([id, v, g]) => ({ id, v, g }));

      t('V58 fixture', () => {
        drop(...NAMES.map(tbl));
        let ok = true;
        NAMES.forEach(k => {
          q(`CREATE TABLE ${tbl(k)} (id INT PRIMARY KEY, v INT, g TEXT)`);
          insertRows(tbl(k), MODEL[k]);
          if (db.tables[tbl(k)].rowCount !== MODEL[k].length) ok = false;
        });
        return ok;
      });

      // 模型側の集約（LuminaDB の取り決め: 空集合の SUM / AVG は 0、MIN / MAX は NULL）
      const nn = (rows) => rows.map(r => r.v).filter(x => x !== null);
      const AGGS = [
        ['COUNT(*)', rows => rows.length],
        ['COUNT(v)', rows => nn(rows).length],
        ['COUNT(DISTINCT v)', rows => new Set(nn(rows)).size],
        ['COUNT(g)', rows => rows.filter(r => r.g !== null).length],
        ['SUM(v)', rows => nn(rows).reduce((a, b) => a + b, 0)],
        ['SUM(DISTINCT v)', rows => [...new Set(nn(rows))].reduce((a, b) => a + b, 0)],
        ['MIN(v)', rows => nn(rows).length ? Math.min(...nn(rows)) : null],
        ['MAX(v)', rows => nn(rows).length ? Math.max(...nn(rows)) : null],
        ['MIN(g)', rows => { const s = rows.map(r => r.g).filter(x => x !== null).sort(); return s.length ? s[0] : null; }],
        ['MAX(g)', rows => { const s = rows.map(r => r.g).filter(x => x !== null).sort(); return s.length ? s[s.length - 1] : null; }],
        ['COUNT(*) FILTER (WHERE v > 5)', rows => rows.filter(r => r.v !== null && r.v > 5).length],
        ['SUM(v) FILTER (WHERE v > 5)', rows => { const a = nn(rows).filter(x => x > 5); return a.reduce((s, b) => s + b, 0); }],
        ['SUM(CASE WHEN v IS NULL THEN 1 ELSE 0 END)', rows => rows.filter(r => r.v === null).length],
        ['COUNT(*) - COUNT(v)', rows => rows.length - nn(rows).length],
        ['MAX(v) - MIN(v)', rows => nn(rows).length ? Math.max(...nn(rows)) - Math.min(...nn(rows)) : null],
        ['GROUP_CONCAT(v ORDER BY id)', rows => nn(rows).length ? nn(rows).join(',') : null],
        ['COUNT(DISTINCT g)', rows => new Set(rows.map(r => r.g).filter(x => x !== null)).size],
        ['SUM(id)', rows => rows.reduce((s, r) => s + r.id, 0)],
        ['MIN(id)', rows => (rows.length ? Math.min(...rows.map(r => r.id)) : null)],
        ['MAX(id)', rows => (rows.length ? Math.max(...rows.map(r => r.id)) : null)],
        ['COUNT(*) FILTER (WHERE v IS NULL)', rows => rows.filter(r => r.v === null).length],
        ['SUM(ABS(v))', rows => nn(rows).reduce((s, x) => s + Math.abs(x), 0)],
      ];
      // AVG は平均値の丸めが絡むので個別に（空集合と全 NULL は 0）
      const avgOf = (rows) => { const a = nn(rows); return a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0; };

      // ============================================================
      // A. 集約 × 縮退した表
      // ============================================================
      NAMES.forEach(k => {
        const rows = rowsOfModel(k);
        AGGS.forEach(([expr, ref]) => {
          t(`V58A ${k}: ${expr}`, () => eq(valsOf(`SELECT ${expr} AS r FROM ${tbl(k)}`),
                                           JSON.stringify([[ref(rows)]]), expr));
        });
        t(`V58A ${k}: AVG(v)`, () => {
          const got = JSON.parse(valsOf(`SELECT AVG(v) AS r FROM ${tbl(k)}`))[0][0];
          const want = avgOf(rows);
          if (Math.abs((got === null ? 0 : got) - want) > 1e-9) {
            throw new Error(`expected ${want} but got ${got}`);
          }
          return true;
        });
        // 0 件に絞ってからの集約（WHERE で全部落とす）
        AGGS.forEach(([expr, ref]) => {
          t(`V58A ${k}: ${expr}（0 件に絞ってから）`,
            () => eq(valsOf(`SELECT ${expr} AS r FROM ${tbl(k)} WHERE 1 = 0`),
                     JSON.stringify([[ref([])]]), expr));
        });
      });

      // ============================================================
      // B. まとめ方
      // ============================================================
      NAMES.forEach(k => {
        const rows = rowsOfModel(k);
        // GROUP BY v（NULL も 1 グループ。並びは v の昇順で NULL が先）
        t(`V58B ${k}: GROUP BY v`, () => {
          const m = new Map();
          rows.forEach(r => m.set(r.v, (m.get(r.v) || 0) + 1));
          const want = [...m.entries()].sort((a, b) => {
            if (a[0] === null) return -1;
            if (b[0] === null) return 1;
            return a[0] - b[0];
          });
          return eq(valsOf(`SELECT v, COUNT(*) AS c FROM ${tbl(k)} GROUP BY v ORDER BY v`),
                    JSON.stringify(want));
        });
        t(`V58B ${k}: DISTINCT v`, () => {
          const vals = [...new Set(rows.map(r => r.v))].sort((a, b) => {
            if (a === null) return -1;
            if (b === null) return 1;
            return a - b;
          });
          return eq(valsOf(`SELECT DISTINCT v FROM ${tbl(k)} ORDER BY v`),
                    JSON.stringify(vals.map(x => [x])));
        });
        t(`V58B ${k}: DISTINCT の件数`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT DISTINCT v FROM ${tbl(k)}) x`),
          JSON.stringify([[new Set(rows.map(r => r.v)).size]])));
        t(`V58B ${k}: HAVING で全部落とす`, () => eq(
          valsOf(`SELECT v, COUNT(*) AS c FROM ${tbl(k)} GROUP BY v HAVING COUNT(*) > 1000 ORDER BY v`), '[]'));
        t(`V58B ${k}: HAVING が常に真`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT v FROM ${tbl(k)} GROUP BY v HAVING COUNT(*) >= 1) x`),
          JSON.stringify([[new Set(rows.map(r => r.v)).size]])));
        t(`V58B ${k}: GROUP BY の無い集約は必ず 1 行`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT COUNT(*) AS n FROM ${tbl(k)}) x`), '[[1]]'));
        t(`V58B ${k}: GROUP BY 2 列`, () => {
          const m = new Map();
          rows.forEach(r => { const key = JSON.stringify([r.v, r.g]); m.set(key, (m.get(key) || 0) + 1); });
          return eq(valsOf(`SELECT COUNT(*) AS c FROM (SELECT v, g FROM ${tbl(k)} GROUP BY v, g) x`),
                    JSON.stringify([[m.size]]));
        });
      });

      // ============================================================
      // C. ページング（LIMIT × OFFSET の格子）
      // ============================================================
      const PAGE = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 19, 39, 40, 41, 1000];
      ['mix', 'big', 'one', 'empty', 'dup', 'pair'].forEach(k => {
        const ids = rowsOfModel(k).map(r => r.id).sort((a, b) => a - b);
        PAGE.forEach(lim => PAGE.forEach(off => {
          t(`V58C ${k}: LIMIT ${lim} OFFSET ${off}`, () => eq(
            valsOf(`SELECT id FROM ${tbl(k)} ORDER BY id LIMIT ${lim} OFFSET ${off}`),
            JSON.stringify(ids.slice(off, off + lim).map(x => [x]))));
        }));
      });
      // LIMIT だけ / OFFSET だけ
      ['mix', 'big'].forEach(k => {
        const ids = rowsOfModel(k).map(r => r.id).sort((a, b) => a - b);
        PAGE.forEach(n => {
          t(`V58C ${k}: LIMIT ${n} だけ`, () => eq(
            valsOf(`SELECT id FROM ${tbl(k)} ORDER BY id LIMIT ${n}`),
            JSON.stringify(ids.slice(0, n).map(x => [x]))));
          t(`V58C ${k}: OFFSET ${n} だけ`, () => eq(
            valsOf(`SELECT id FROM ${tbl(k)} ORDER BY id OFFSET ${n}`),
            JSON.stringify(ids.slice(n).map(x => [x]))));
        });
      });

      // ============================================================
      // D. 述語（常に真・常に偽・NULL 比較・境界）
      // ============================================================
      const PREDS = [
        ['1 = 1', r => true],
        ['1 = 0', r => false],
        ['TRUE', r => true],
        ['FALSE', r => false],
        ['NULL IS NULL', r => true],
        ['NULL = NULL', r => false],
        ['v = v', r => r.v !== null],
        ['v <> v', r => false],
        ['v IS NULL', r => r.v === null],
        ['v IS NOT NULL', r => r.v !== null],
        ['v = NULL', r => false],
        ['v <> NULL', r => false],
        ['NOT (v IS NULL)', r => r.v !== null],
        ['v > 0', r => r.v !== null && r.v > 0],
        ['v >= 0', r => r.v !== null && r.v >= 0],
        ['v < 0', r => r.v !== null && r.v < 0],
        ['v = 0', r => r.v !== null && r.v === 0],
        ['v BETWEEN 0 AND 0', r => r.v !== null && r.v === 0],
        ['v IN (0)', r => r.v !== null && r.v === 0],
        ['v NOT IN (0)', r => r.v !== null && r.v !== 0],
        ['v IN (NULL)', r => false],
        ['v NOT IN (NULL)', r => false],
        ['g IS NULL', r => r.g === null],
        ["g = ''", r => false],
        ["g LIKE '%'", r => r.g !== null],
        ["g NOT LIKE '%'", r => false],
        ['id > 0', r => true],
        ['id < 0', r => false],
        ['v IS NULL OR v IS NOT NULL', r => true],
        ['v IS NULL AND v IS NOT NULL', r => false],
        ['v > 0 AND v < 0', r => false],
        ['v > 0 OR v <= 0', r => r.v !== null],
        ['NOT (v > 0)', r => r.v !== null && !(r.v > 0)],
        ['NOT (v IS NULL OR v > 0)', r => r.v !== null && !(r.v > 0)],
        ['id IN (1, 2, 3)', r => [1, 2, 3].includes(r.id)],
        ['id NOT IN (1, 2, 3)', r => ![1, 2, 3].includes(r.id)],
        ['id BETWEEN 2 AND 4', r => r.id >= 2 && r.id <= 4],
        ['id NOT BETWEEN 2 AND 4', r => !(r.id >= 2 && r.id <= 4)],
        ['COALESCE(v, 0) = 0', r => (r.v === null ? 0 : r.v) === 0],
        ['ABS(v) > 5', r => r.v !== null && Math.abs(r.v) > 5],
        ["g IN ('a', 'b')", r => r.g !== null && ['a', 'b'].includes(r.g)],
        ['LENGTH(g) = 1', r => r.g !== null && r.g.length === 1],
      ];
      NAMES.forEach(k => {
        const rows = rowsOfModel(k);
        PREDS.forEach(([pred, ref]) => {
          t(`V58D ${k}: WHERE ${pred}`, () => eq(
            valsOf(`SELECT id FROM ${tbl(k)} WHERE ${pred} ORDER BY id`),
            JSON.stringify(rows.filter(ref).map(r => [r.id])), pred));
        });
      });

      // ============================================================
      // E. 並べ替え（全同値・全 NULL・NULLS FIRST / LAST）
      // ============================================================
      const cmpNum = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
      const ORDERS = [
        ['v ASC, id', rows => rows.slice().sort((x, y) => {
          if (x.v === null && y.v === null) return x.id - y.id;
          if (x.v === null) return -1;
          if (y.v === null) return 1;
          return cmpNum(x.v, y.v) || (x.id - y.id);
        })],
        ['v DESC, id', rows => rows.slice().sort((x, y) => {
          if (x.v === null && y.v === null) return x.id - y.id;
          if (x.v === null) return 1;
          if (y.v === null) return -1;
          return cmpNum(y.v, x.v) || (x.id - y.id);
        })],
        ['v ASC NULLS LAST, id', rows => rows.slice().sort((x, y) => {
          if (x.v === null && y.v === null) return x.id - y.id;
          if (x.v === null) return 1;
          if (y.v === null) return -1;
          return cmpNum(x.v, y.v) || (x.id - y.id);
        })],
        ['v DESC NULLS FIRST, id', rows => rows.slice().sort((x, y) => {
          if (x.v === null && y.v === null) return x.id - y.id;
          if (x.v === null) return -1;
          if (y.v === null) return 1;
          return cmpNum(y.v, x.v) || (x.id - y.id);
        })],
        ['1, id', rows => rows.slice().sort((x, y) => x.id - y.id)],
        ["'z', id", rows => rows.slice().sort((x, y) => x.id - y.id)],
        ['id % 2, id', rows => rows.slice().sort((x, y) => (x.id % 2) - (y.id % 2) || (x.id - y.id))],
      ];
      NAMES.forEach(k => {
        const rows = rowsOfModel(k);
        ORDERS.forEach(([ord, ref]) => {
          t(`V58E ${k}: ORDER BY ${ord}`, () => eq(
            valsOf(`SELECT id FROM ${tbl(k)} ORDER BY ${ord}`),
            JSON.stringify(ref(rows).map(r => [r.id])), ord));
        });
      });

      // ============================================================
      // F. 結合（空表・1 行・重複との組み合わせ）
      // ============================================================
      const PAIRS = [['empty', 'mix'], ['mix', 'empty'], ['one', 'mix'], ['mix', 'one'],
                     ['dup', 'same'], ['same', 'dup'], ['nul', 'mix'], ['mix', 'mix'], ['two', 'big']];
      PAIRS.forEach(([a, b]) => {
        const ra = rowsOfModel(a), rb = rowsOfModel(b);
        t(`V58F ${a} INNER JOIN ${b}`, () => {
          let n = 0;
          ra.forEach(x => rb.forEach(y => { if (x.id === y.id) n++; }));
          return eq(valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x JOIN ${tbl(b)} y ON x.id = y.id`),
                    JSON.stringify([[n]]));
        });
        t(`V58F ${a} LEFT JOIN ${b}`, () => {
          let n = 0;
          ra.forEach(x => { const m = rb.filter(y => y.id === x.id).length; n += m || 1; });
          return eq(valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x LEFT JOIN ${tbl(b)} y ON x.id = y.id`),
                    JSON.stringify([[n]]));
        });
        t(`V58F ${a} CROSS JOIN ${b}`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x CROSS JOIN ${tbl(b)} y`),
          JSON.stringify([[ra.length * rb.length]])));
        t(`V58F ${a} と ${b} の準結合`, () => {
          const ids = new Set(rb.map(r => r.id));
          return eq(valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x WHERE EXISTS (SELECT 1 FROM ${tbl(b)} y WHERE y.id = x.id)`),
                    JSON.stringify([[ra.filter(r => ids.has(r.id)).length]]));
        });
        t(`V58F ${a} と ${b} の反結合`, () => {
          const ids = new Set(rb.map(r => r.id));
          return eq(valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x WHERE NOT EXISTS (SELECT 1 FROM ${tbl(b)} y WHERE y.id = x.id)`),
                    JSON.stringify([[ra.filter(r => !ids.has(r.id)).length]]));
        });
        t(`V58F ${a} と ${b} の ON が常に偽`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM ${tbl(a)} x JOIN ${tbl(b)} y ON 1 = 0`), '[[0]]'));
      });

      // ============================================================
      // G. 集合演算
      // ============================================================
      const SETPAIRS = [['empty', 'mix'], ['mix', 'empty'], ['dup', 'dup'], ['same', 'same'],
                        ['one', 'two'], ['nul', 'nul'], ['mix', 'big']];
      SETPAIRS.forEach(([a, b]) => {
        const ia = rowsOfModel(a).map(r => r.id), ib = rowsOfModel(b).map(r => r.id);
        t(`V58G ${a} UNION ALL ${b}`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} UNION ALL SELECT id FROM ${tbl(b)}) x`),
          JSON.stringify([[ia.length + ib.length]])));
        t(`V58G ${a} UNION ${b}`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} UNION SELECT id FROM ${tbl(b)}) x`),
          JSON.stringify([[new Set(ia.concat(ib)).size]])));
        t(`V58G ${a} INTERSECT ${b}`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} INTERSECT SELECT id FROM ${tbl(b)}) x`),
          JSON.stringify([[new Set(ia.filter(x => ib.includes(x))).size]])));
        t(`V58G ${a} EXCEPT ${b}`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} EXCEPT SELECT id FROM ${tbl(b)}) x`),
          JSON.stringify([[new Set(ia.filter(x => !ib.includes(x))).size]])));
        t(`V58G ${a} と自分自身の INTERSECT`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} INTERSECT SELECT id FROM ${tbl(a)}) x`),
          JSON.stringify([[new Set(ia).size]])));
        t(`V58G ${a} と自分自身の EXCEPT は空`, () => eq(
          valsOf(`SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(a)} EXCEPT SELECT id FROM ${tbl(a)}) x`), '[[0]]'));
      });

      // ============================================================
      // H. ウィンドウ関数
      // ============================================================
      const WINS = [
        ['ROW_NUMBER() OVER (ORDER BY id)', rows => rows.map((r, i) => i + 1)],
        ['COUNT(*) OVER ()', rows => rows.map(() => rows.length)],
        ['COUNT(v) OVER ()', rows => rows.map(() => nn(rows).length)],
        // 集約と同じ取り決め: 値が 1 つも無い SUM は 0（MIN / MAX は NULL）
        ['SUM(v) OVER ()', rows => rows.map(() => nn(rows).reduce((a, b) => a + b, 0))],
        ['MIN(v) OVER ()', rows => rows.map(() => (nn(rows).length ? Math.min(...nn(rows)) : null))],
        ['MAX(v) OVER ()', rows => rows.map(() => (nn(rows).length ? Math.max(...nn(rows)) : null))],
        ['LAG(id) OVER (ORDER BY id)', rows => rows.map((r, i) => (i === 0 ? null : rows[i - 1].id))],
        ['LEAD(id) OVER (ORDER BY id)', rows => rows.map((r, i) => (i === rows.length - 1 ? null : rows[i + 1].id))],
        ['FIRST_VALUE(id) OVER (ORDER BY id)', rows => rows.map(() => (rows.length ? rows[0].id : null))],
        ['COUNT(*) OVER (PARTITION BY id)', rows => rows.map(() => 1)],
        ['SUM(id) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
         rows => rows.map((r, i) => rows.slice(0, i + 1).reduce((s, x) => s + x.id, 0))],
        ['ROW_NUMBER() OVER (PARTITION BY v ORDER BY id)', rows => {
          const seen = new Map();
          return rows.map(r => { const n = (seen.get(r.v) || 0) + 1; seen.set(r.v, n); return n; });
        }],
        ['COUNT(g) OVER ()', rows => rows.map(() => rows.filter(r => r.g !== null).length)],
        ['MAX(id) OVER ()', rows => rows.map(() => (rows.length ? Math.max(...rows.map(r => r.id)) : null))],
        ['LAG(id, 2) OVER (ORDER BY id)', rows => rows.map((r, i) => (i < 2 ? null : rows[i - 2].id))],
        ['LEAD(id, 2) OVER (ORDER BY id)', rows => rows.map((r, i) => (i + 2 >= rows.length ? null : rows[i + 2].id))],
        ['LAST_VALUE(id) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)',
         rows => rows.map(() => (rows.length ? rows[rows.length - 1].id : null))],
        ['DENSE_RANK() OVER (ORDER BY v)', rows => {
          const vs = [...new Set(rows.map(r => r.v))].sort((a, b) => {
            if (a === null) return -1;
            if (b === null) return 1;
            return a - b;
          });
          return rows.map(r => vs.indexOf(r.v) + 1);
        }],
      ];
      NAMES.forEach(k => {
        const rows = rowsOfModel(k).slice().sort((a, b) => a.id - b.id);
        WINS.forEach(([expr, ref]) => {
          t(`V58H ${k}: ${expr}`, () => eq(
            valsOf(`SELECT ${expr} AS r FROM ${tbl(k)} ORDER BY id`),
            JSON.stringify(ref(rows).map(x => [x])), expr));
        });
      });

      // ============================================================
      // I. 書き換え（0 行に当たる / 全行に当たる）
      // ============================================================
      NAMES.forEach(k => {
        t(`V58I ${k}: 0 行に当たる UPDATE`, () => {
          const before = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          const r = q(`UPDATE ${tbl(k)} SET v = -999 WHERE 1 = 0`);
          if (r.error) throw new Error(r.error);
          return eq(valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`), before);
        });
        t(`V58I ${k}: 0 行に当たる DELETE`, () => {
          const before = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          const r = q(`DELETE FROM ${tbl(k)} WHERE 1 = 0`);
          if (r.error) throw new Error(r.error);
          return eq(valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`), before);
        });
        t(`V58I ${k}: 値が変わらない UPDATE`, () => {
          const before = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          const r = q(`UPDATE ${tbl(k)} SET v = v`);
          if (r.error) throw new Error(r.error);
          return eq(valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`), before);
        });
        t(`V58I ${k}: 全行 UPDATE のあと戻す`, () => {
          const before = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          q(`UPDATE ${tbl(k)} SET g = 'ZZ'`);
          const n = JSON.parse(valsOf(`SELECT COUNT(*) AS c FROM ${tbl(k)} WHERE g = 'ZZ'`))[0][0];
          q(`DELETE FROM ${tbl(k)}`);
          insertRows(tbl(k), MODEL[k]);
          const after = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          if (n !== MODEL[k].length) throw new Error(`expected ${MODEL[k].length} rows updated but got ${n}`);
          return eq(after, before);
        });
        t(`V58I ${k}: 全件 DELETE のあと入れ直す`, () => {
          const before = valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`);
          q(`DELETE FROM ${tbl(k)}`);
          const empty = valsOf(`SELECT COUNT(*) AS c FROM ${tbl(k)}`);
          insertRows(tbl(k), MODEL[k]);
          if (empty !== '[[0]]') throw new Error('DELETE 後が空でない: ' + empty);
          return eq(valsOf(`SELECT id, v, g FROM ${tbl(k)} ORDER BY id`), before);
        });
      });

      // 縮退した表どうしでも「同じ意味の書き方」は一致する
      NAMES.forEach(k => {
        same(`V58I ${k}: COUNT(*) と派生表の COUNT`,
             `SELECT COUNT(*) AS c FROM ${tbl(k)}`,
             `SELECT COUNT(*) AS c FROM (SELECT id FROM ${tbl(k)}) x`);
        same(`V58I ${k}: WHERE と HAVING`,
             `SELECT COUNT(*) AS c FROM ${tbl(k)} WHERE v > 5`,
             `SELECT COUNT(*) AS c FROM (SELECT v FROM ${tbl(k)} GROUP BY id, v HAVING v > 5) x`);
        same(`V58I ${k}: DISTINCT と GROUP BY`,
             `SELECT DISTINCT v FROM ${tbl(k)} ORDER BY v`,
             `SELECT v FROM ${tbl(k)} GROUP BY v ORDER BY v`);
      });

      // ============================================================
      // 片付け
      // ============================================================
      cleanup(...NAMES.map(tbl));

      return T;
    }
