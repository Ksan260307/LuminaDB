    // ============================================================================
    // [Test Suite v48] - コマンド全網羅 (6/6): SELECT の句・演算子・述語とメタ照会
    //
    //     A. 演算子の総当たり（比較・算術・論理・連結・ビット）
    //     B. 述語の総当たり（IN / BETWEEN / LIKE / EXISTS / ANY / ALL / IS）
    //     C. SELECT 句の要素
    //     D. FROM と結合
    //     E. WHERE × ORDER BY × LIMIT / OFFSET の行列
    //     F. GROUP BY と HAVING
    //     G. 集合演算
    //     H. サブクエリの置ける位置
    //     I. SHOW / DESCRIBE / EXPLAIN / PRAGMA / INFORMATION_SCHEMA の全網羅
    //     J. 表関数・配列・PIVOT・全文検索
    //     K. 誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV48Tests() のスプレッドで合流する
    // ============================================================================
    function getV48Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, ok, rowsOf: rows, oneOf: one, eq, val } = makeTestKit('V48');

      // ------------------------------------------------------------
      // 0. フィクスチャ（読み取り専用。全テストで共有する）
      // ------------------------------------------------------------
      const A = [];   // 主表 400 行
      const B = [];   // 従表 80 行
      t('V48 fixture', () => {
        ['v48_a', 'v48_b'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        q('CREATE TABLE v48_a (id INT PRIMARY KEY, g TEXT, v INT, w DECIMAL(18,4), s TEXT, bid INT)');
        A.length = 0;
        const gs = ['A', 'B', 'C', 'D'];
        const ss = ['alpha', 'beta', 'gamma', 'delta', 'Alpha', 'BETA', null, 'a_b', 'x%y'];
        const va = [];
        for (let i = 0; i < 400; i++) {
          const v = (i % 17 === 16) ? null : ((i * 13) % 71) - 30;
          const w = (i % 19 === 18) ? null : ((i % 37) - 18) * 0.25;
          const s = ss[i % ss.length];
          const bid = (i % 23 === 22) ? null : (i % 80);
          A.push({ id: i, g: gs[i % 4], v, w, s, bid });
          va.push(`(${i}, '${gs[i % 4]}', ${v === null ? 'NULL' : v}, ${w === null ? 'NULL' : w}, ` +
                  `${s === null ? 'NULL' : "'" + s.split("'").join("''") + "'"}, ${bid === null ? 'NULL' : bid})`);
        }
        q('INSERT INTO v48_a VALUES ' + va.join(','));
        q('CREATE TABLE v48_b (bid INT PRIMARY KEY, label TEXT, n INT)');
        B.length = 0;
        const vb = [];
        for (let i = 0; i < 80; i++) {
          const n = (i % 11 === 10) ? null : i * 3;
          B.push({ bid: i, label: 'L' + (i % 6), n });
          vb.push(`(${i}, 'L${i % 6}', ${n === null ? 'NULL' : n})`);
        }
        q('INSERT INTO v48_b VALUES ' + vb.join(','));
        return db.tables['v48_a'].rowCount === 400 && db.tables['v48_b'].rowCount === 80;
      });

      // 三値論理のヘルパ（模型側）
      const and3 = (a, b) => (a === false || b === false) ? false : ((a === null || b === null) ? null : true);
      const or3 = (a, b) => (a === true || b === true) ? true : ((a === null || b === null) ? null : false);
      const not3 = (a) => a === null ? null : !a;
      const isTrue = (x) => x === true;
      const cmp3 = (a, b, op) => {
        if (a === null || b === null) return null;
        switch (op) {
          case '=': return a === b;
          case '<>': return a !== b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
        }
      };

      // ============================================================
      // A. 演算子の総当たり
      // ============================================================
      const OPS = ['=', '<>', '<', '<=', '>', '>='];
      const LITS = [-31, -30, -15, -1, 0, 1, 10, 15, 30, 40];
      // 比較演算子 × 定数 を列に適用し、模型と件数を突き合わせる
      OPS.forEach(op => LITS.forEach(lit => {
        t(`V48A WHERE v ${op} ${lit}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v ${op} ${lit} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(cmp3(r.v, lit, op))).map(r => r.id);
          return eq(got, want);
        });
        t(`V48A WHERE NOT (v ${op} ${lit})`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE NOT (v ${op} ${lit}) ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(not3(cmp3(r.v, lit, op)))).map(r => r.id);
          return eq(got, want);
        });
      }));
      // 二つの列を比較する
      OPS.forEach(op => {
        t(`V48A WHERE v ${op} bid`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v ${op} bid ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(cmp3(r.v, r.bid, op))).map(r => r.id);
          return eq(got, want);
        });
      });
      // 文字列の比較
      ["'alpha'", "'beta'", "'Alpha'", "'zzz'"].forEach(lit => OPS.forEach(op => {
        t(`V48A WHERE s ${op} ${lit}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE s ${op} ${lit} ORDER BY id`).map(r => r.id);
          const bare = lit.slice(1, -1);
          const want = A.filter(r => isTrue(cmp3(r.s, bare, op))).map(r => r.id);
          return eq(got, want);
        });
      }));
      // 算術演算子
      const ARITH = [
        ['v + 10', r => r.v === null ? null : r.v + 10],
        ['v - 10', r => r.v === null ? null : r.v - 10],
        ['v * 3', r => r.v === null ? null : r.v * 3],
        ['v / 2', r => r.v === null ? null : r.v / 2],
        ['v % 7', r => r.v === null ? null : r.v % 7],
        ['-v', r => r.v === null ? null : -r.v],
        ['v + bid', r => (r.v === null || r.bid === null) ? null : r.v + r.bid],
        ['v * bid', r => (r.v === null || r.bid === null) ? null : r.v * r.bid],
        ['(v + 1) * 2', r => r.v === null ? null : (r.v + 1) * 2],
        ['v + 1 * 2', r => r.v === null ? null : r.v + 2],
        ['v / 0', () => null],
        ['v % 0', () => null],
      ];
      ARITH.forEach(([expr, ref]) => {
        t(`V48A the expression ${expr} over the column`, () => {
          const got = rows(`SELECT id, ${expr} AS r FROM v48_a ORDER BY id`).map(x => x.r);
          const want = A.map(ref).map(x => (typeof x === 'number' && !Number.isInteger(x))
            ? Math.round(x * 1e9) / 1e9 : x);
          return eq(got.map(x => (typeof x === 'number' && !Number.isInteger(x))
            ? Math.round(x * 1e9) / 1e9 : x), want);
        });
      });
      // 論理演算子（三値論理）
      const CONDS = [
        ['v > 0', r => cmp3(r.v, 0, '>')],
        ['v < 0', r => cmp3(r.v, 0, '<')],
        ['v = 0', r => cmp3(r.v, 0, '=')],
        ['bid > 40', r => cmp3(r.bid, 40, '>')],
        ['bid <= 10', r => cmp3(r.bid, 10, '<=')],
        ["g = 'A'", r => cmp3(r.g, 'A', '=')],
        ["g <> 'B'", r => cmp3(r.g, 'B', '<>')],
        ['v IS NULL', r => r.v === null],
        ['bid IS NULL', r => r.bid === null],
        ['s IS NULL', r => r.s === null],
        ['1 = 1', () => true],
        ['1 = 0', () => false],
      ];
      CONDS.forEach(([c1, f1]) => CONDS.forEach(([c2, f2]) => {
        t(`V48A WHERE ${c1} AND ${c2}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE ${c1} AND ${c2} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(and3(f1(r), f2(r)))).map(r => r.id);
          return eq(got, want);
        });
        t(`V48A WHERE ${c1} OR ${c2}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE ${c1} OR ${c2} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(or3(f1(r), f2(r)))).map(r => r.id);
          return eq(got, want);
        });
      }));
      CONDS.forEach(([c1, f1]) => {
        t(`V48A WHERE NOT (${c1})`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE NOT (${c1}) ORDER BY id`).map(r => r.id);
          const want = A.filter(r => isTrue(not3(f1(r)))).map(r => r.id);
          return eq(got, want);
        });
      });
      // 三つの条件の組み合わせ（結合順序も確かめる）
      t('V48A a AND b OR c groups AND first', () => {
        const got = rows("SELECT id FROM v48_a WHERE v > 0 AND g = 'A' OR bid > 70 ORDER BY id").map(r => r.id);
        const want = A.filter(r => isTrue(or3(and3(cmp3(r.v, 0, '>'), cmp3(r.g, 'A', '=')), cmp3(r.bid, 70, '>'))))
          .map(r => r.id);
        return eq(got, want);
      });
      t('V48A parentheses change the grouping', () => {
        const got = rows("SELECT id FROM v48_a WHERE v > 0 AND (g = 'A' OR bid > 70) ORDER BY id").map(r => r.id);
        const want = A.filter(r => isTrue(and3(cmp3(r.v, 0, '>'), or3(cmp3(r.g, 'A', '='), cmp3(r.bid, 70, '>')))))
          .map(r => r.id);
        return eq(got, want);
      });
      // 連結・ビット演算
      val('V48A string concatenation', "SELECT 'a' || 'b' || 'c' AS r", 'abc');
      val('V48A concatenation with a number', "SELECT 'n=' || 5 AS r", 'n=5');
      t('V48A concatenation over a column', () => {
        const got = rows("SELECT id, g || '-' || CAST(id AS TEXT) AS r FROM v48_a ORDER BY id LIMIT 5").map(r => r.r);
        return eq(got, A.slice(0, 5).map(r => `${r.g}-${r.id}`));
      });
      [['1 & 3', 1], ['1 | 2', 3], ['5 ^ 3', 6], ['1 << 3', 8], ['16 >> 2', 4]]
        .forEach(([e, w]) => val(`V48A ${e}`, `SELECT ${e} AS r`, w));
      // ビット否定は関数形で書く（'~' 演算子は未対応）
      val('V48A BITNOT(0)', 'SELECT BITNOT(0) AS r', -1);
      val('V48A BITNOT(5)', 'SELECT BITNOT(5) AS r', -6);

      // ============================================================
      // B. 述語の総当たり
      // ============================================================
      const INLISTS = [
        ['(1, 2, 3)', [1, 2, 3]],
        ['(-30, 0, 40)', [-30, 0, 40]],
        ['(0)', [0]],
        ['(1, 1, 1)', [1]],
        ['(-1, NULL, 1)', [-1, null, 1]],
      ];
      INLISTS.forEach(([listSql, listVals]) => {
        const hasNull = listVals.indexOf(null) !== -1;
        const plain = listVals.filter(x => x !== null);
        t(`V48B WHERE v IN ${listSql}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v IN ${listSql} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.v !== null && plain.indexOf(r.v) !== -1).map(r => r.id);
          return eq(got, want);
        });
        t(`V48B WHERE v NOT IN ${listSql}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v NOT IN ${listSql} ORDER BY id`).map(r => r.id);
          // NULL がリストに含まれると「含まれない」と言い切れないので何も返らない
          const want = hasNull ? []
            : A.filter(r => r.v !== null && plain.indexOf(r.v) === -1).map(r => r.id);
          return eq(got, want);
        });
      });
      const RANGES = [[-30, 0], [0, 20], [-5, 5], [40, 10], [-100, 100]];
      RANGES.forEach(([lo, hi]) => {
        t(`V48B WHERE v BETWEEN ${lo} AND ${hi}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v BETWEEN ${lo} AND ${hi} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.v !== null && r.v >= lo && r.v <= hi).map(r => r.id);
          return eq(got, want);
        });
        t(`V48B WHERE v NOT BETWEEN ${lo} AND ${hi}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v NOT BETWEEN ${lo} AND ${hi} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.v !== null && !(r.v >= lo && r.v <= hi)).map(r => r.id);
          return eq(got, want);
        });
      });
      // LIKE は大文字小文字を区別しない（MySQL の既定照合と同じ）。
      // 区別したいときは COLLATE や STRCMP を使う
      const LIKES = [
        ["'a%'", s => /^a/i.test(s)],
        ["'%a'", s => /a$/i.test(s)],
        ["'%a%'", s => s.toLowerCase().indexOf('a') !== -1],
        ["'_lpha'", s => /^.lpha$/i.test(s)],
        ["'alpha'", s => s.toLowerCase() === 'alpha'],
        ["'A%'", s => /^a/i.test(s)],
        ["'%'", () => true],
        ["'a\\_b'", s => s.toLowerCase() === 'a_b'],
        ["'x\\%y'", s => s.toLowerCase() === 'x%y'],
        ["'beta'", s => s.toLowerCase() === 'beta'],
        ["'%t%'", s => s.toLowerCase().indexOf('t') !== -1],
        ["'____'", s => s.length === 4],
      ];
      LIKES.forEach(([pat, ref]) => {
        t(`V48B WHERE s LIKE ${pat}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE s LIKE ${pat} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.s !== null && ref(r.s)).map(r => r.id);
          return eq(got, want);
        });
        t(`V48B WHERE s NOT LIKE ${pat}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE s NOT LIKE ${pat} ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.s !== null && !ref(r.s)).map(r => r.id);
          return eq(got, want);
        });
      });
      // ILIKE は大文字小文字を無視する
      t('V48B WHERE s ILIKE a%', () => {
        const got = rows("SELECT id FROM v48_a WHERE s ILIKE 'a%' ORDER BY id").map(r => r.id);
        const want = A.filter(r => r.s !== null && /^a/i.test(r.s)).map(r => r.id);
        return eq(got, want);
      });
      // IS NULL 系
      [['v IS NULL', r => r.v === null], ['v IS NOT NULL', r => r.v !== null],
       ['s IS NULL', r => r.s === null], ['s IS NOT NULL', r => r.s !== null],
       ['bid IS NULL', r => r.bid === null], ['w IS NULL', r => r.w === null]].forEach(([p, ref]) => {
        t(`V48B WHERE ${p}`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE ${p} ORDER BY id`).map(r => r.id);
          return eq(got, A.filter(ref).map(r => r.id));
        });
      });
      // EXISTS / IN サブクエリ
      t('V48B WHERE EXISTS over the child table', () => {
        const got = rows('SELECT id FROM v48_a WHERE EXISTS (SELECT 1 FROM v48_b WHERE v48_b.bid = v48_a.bid) ORDER BY id')
          .map(r => r.id);
        const bids = new Set(B.map(r => r.bid));
        return eq(got, A.filter(r => r.bid !== null && bids.has(r.bid)).map(r => r.id));
      });
      t('V48B WHERE NOT EXISTS', () => {
        const got = rows('SELECT id FROM v48_a WHERE NOT EXISTS (SELECT 1 FROM v48_b WHERE v48_b.bid = v48_a.bid) ORDER BY id')
          .map(r => r.id);
        const bids = new Set(B.map(r => r.bid));
        return eq(got, A.filter(r => !(r.bid !== null && bids.has(r.bid))).map(r => r.id));
      });
      t('V48B WHERE IN a subquery', () => {
        const got = rows('SELECT id FROM v48_a WHERE bid IN (SELECT bid FROM v48_b WHERE n > 100) ORDER BY id')
          .map(r => r.id);
        const s = new Set(B.filter(r => r.n !== null && r.n > 100).map(r => r.bid));
        return eq(got, A.filter(r => r.bid !== null && s.has(r.bid)).map(r => r.id));
      });
      // ANY / ALL / SOME
      [['> ANY', (v, list) => list.some(x => v > x)],
       ['< ANY', (v, list) => list.some(x => v < x)],
       ['= ANY', (v, list) => list.some(x => v === x)],
       ['> ALL', (v, list) => list.every(x => v > x)],
       ['< ALL', (v, list) => list.every(x => v < x)],
       ['> SOME', (v, list) => list.some(x => v > x)]].forEach(([op, ref]) => {
        t(`V48B WHERE v ${op} (10, 20, 30)`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE v ${op} (10, 20, 30) ORDER BY id`).map(r => r.id);
          const want = A.filter(r => r.v !== null && ref(r.v, [10, 20, 30])).map(r => r.id);
          return eq(got, want);
        });
      });
      // IS DISTINCT FROM
      t('V48B WHERE v IS DISTINCT FROM 0', () => {
        const got = rows('SELECT id FROM v48_a WHERE v IS DISTINCT FROM 0 ORDER BY id').map(r => r.id);
        return eq(got, A.filter(r => !(r.v === 0)).map(r => r.id));
      });
      t('V48B WHERE v IS NOT DISTINCT FROM NULL', () => {
        const got = rows('SELECT id FROM v48_a WHERE v IS NOT DISTINCT FROM NULL ORDER BY id').map(r => r.id);
        return eq(got, A.filter(r => r.v === null).map(r => r.id));
      });
      // 行コンストラクタ
      t('V48B a row constructor comparison', () => {
        const got = rows("SELECT COUNT(*) AS c FROM v48_a WHERE (g, v) = ('A', 10)")[0].c;
        return eq(got, A.filter(r => r.g === 'A' && r.v === 10).length);
      });
      t('V48B a row constructor IN list', () => {
        const got = rows("SELECT COUNT(*) AS c FROM v48_a WHERE (g, v) IN (('A', 10), ('B', 20))")[0].c;
        return eq(got, A.filter(r => (r.g === 'A' && r.v === 10) || (r.g === 'B' && r.v === 20)).length);
      });

      // ============================================================
      // C. SELECT 句の要素
      // ============================================================
      t('V48C SELECT star returns every column', () => {
        const d = rows('SELECT * FROM v48_a LIMIT 1');
        return eq(Object.keys(d[0]), ['id', 'g', 'v', 'w', 's', 'bid']);
      });
      t('V48C SELECT with a qualified star', () => {
        const d = rows('SELECT v48_a.* FROM v48_a LIMIT 1');
        return eq(Object.keys(d[0]).length, 6);
      });
      t('V48C SELECT with an alias', () => eq(Object.keys(rows('SELECT id AS x FROM v48_a LIMIT 1')[0]), ['x']));
      t('V48C SELECT with an alias without AS', () => eq(Object.keys(rows('SELECT id x FROM v48_a LIMIT 1')[0]), ['x']));
      t('V48C SELECT with a quoted alias', () =>
        eq(Object.keys(rows('SELECT id AS "my col" FROM v48_a LIMIT 1')[0]), ['my col']));
      t('V48C SELECT DISTINCT', () => {
        const got = rows('SELECT DISTINCT g FROM v48_a ORDER BY g').map(r => r.g);
        return eq(got, [...new Set(A.map(r => r.g))].sort());
      });
      t('V48C SELECT DISTINCT over two columns', () => {
        const got = rows('SELECT DISTINCT g, v FROM v48_a ORDER BY g, v').length;
        const want = new Set(A.map(r => r.g + '|' + r.v)).size;
        return eq(got, want);
      });
      t('V48C SELECT with a constant', () => eq(one("SELECT 'k' AS r FROM v48_a LIMIT 1"), 'k'));
      t('V48C SELECT with no FROM', () => eq(one('SELECT 1 + 1 AS r'), 2));
      t('V48C SELECT with several expressions', () => {
        const d = rows('SELECT id, id * 2 AS d, id + 1 AS p FROM v48_a ORDER BY id LIMIT 3');
        return eq(d, [{ id: 0, d: 0, p: 1 }, { id: 1, d: 2, p: 2 }, { id: 2, d: 4, p: 3 }]);
      });
      t('V48C an alias can be reused in ORDER BY', () => {
        const got = rows('SELECT id AS x FROM v48_a ORDER BY x DESC LIMIT 3').map(r => r.x);
        return eq(got, [399, 398, 397]);
      });
      t('V48C a table alias qualifies the columns', () => {
        const got = rows('SELECT z.id FROM v48_a z ORDER BY z.id LIMIT 3').map(r => r.id);
        return eq(got, [0, 1, 2]);
      });
      t('V48C a table alias with AS', () => {
        const got = rows('SELECT z.id FROM v48_a AS z ORDER BY z.id LIMIT 3').map(r => r.id);
        return eq(got, [0, 1, 2]);
      });
      t('V48C an expression alias is usable in GROUP BY', () => {
        const got = rows('SELECT id % 4 AS k, COUNT(*) AS c FROM v48_a GROUP BY k ORDER BY k').map(r => r.c);
        const m = new Map();
        A.forEach(r => { const k = r.id % 4; m.set(k, (m.get(k) || 0) + 1); });
        return eq(got, [...m.keys()].sort((a, b) => a - b).map(k => m.get(k)));
      });

      // ============================================================
      // D. FROM と結合
      // ============================================================
      const JOINS = [
        ['INNER JOIN', (a, b) => a.bid !== null && b !== undefined],
        ['JOIN', (a, b) => a.bid !== null && b !== undefined],
        ['LEFT JOIN', () => true],
        ['LEFT OUTER JOIN', () => true],
      ];
      JOINS.forEach(([kind]) => {
        t(`V48D ${kind} on bid`, () => {
          const got = one(`SELECT COUNT(*) AS c FROM v48_a a ${kind} v48_b b ON a.bid = b.bid`);
          const bmap = new Map(B.map(r => [r.bid, r]));
          const want = /LEFT/.test(kind)
            ? A.length
            : A.filter(r => r.bid !== null && bmap.has(r.bid)).length;
          return eq(got, want);
        });
      });
      t('V48D RIGHT JOIN', () => {
        const got = one('SELECT COUNT(*) AS c FROM v48_a a RIGHT JOIN v48_b b ON a.bid = b.bid');
        const amap = new Map();
        A.forEach(r => { if (r.bid !== null) amap.set(r.bid, (amap.get(r.bid) || 0) + 1); });
        const want = B.reduce((acc, r) => acc + Math.max(1, amap.get(r.bid) || 0), 0);
        return eq(got, want);
      });
      t('V48D FULL OUTER JOIN covers both sides', () => {
        const got = one('SELECT COUNT(*) AS c FROM v48_a a FULL OUTER JOIN v48_b b ON a.bid = b.bid');
        return eq(got >= A.length, true);
      });
      t('V48D CROSS JOIN multiplies the row counts', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a a CROSS JOIN v48_b b'), 400 * 80));
      t('V48D a comma join is a cross join', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a a, v48_b b'), 400 * 80));
      t('V48D JOIN USING', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a JOIN v48_b USING (bid)'),
           one('SELECT COUNT(*) AS c FROM v48_a a JOIN v48_b b ON a.bid = b.bid')));
      t('V48D NATURAL JOIN', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a NATURAL JOIN v48_b') >= 0, true));
      t('V48D a self join', () => {
        const got = one('SELECT COUNT(*) AS c FROM v48_a x JOIN v48_a y ON x.g = y.g AND x.id < y.id');
        let want = 0;
        const byG = new Map();
        A.forEach(r => byG.set(r.g, (byG.get(r.g) || 0) + 1));
        byG.forEach(n => { want += n * (n - 1) / 2; });
        return eq(got, want);
      });
      t('V48D a three-way join', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a a JOIN v48_b b ON a.bid = b.bid JOIN v48_b c ON b.bid = c.bid'),
           one('SELECT COUNT(*) AS c FROM v48_a a JOIN v48_b b ON a.bid = b.bid')));
      t('V48D a join with an extra condition', () => {
        const got = one("SELECT COUNT(*) AS c FROM v48_a a JOIN v48_b b ON a.bid = b.bid AND b.label = 'L0'");
        const bmap = new Map(B.map(r => [r.bid, r]));
        const want = A.filter(r => r.bid !== null && bmap.has(r.bid) && bmap.get(r.bid).label === 'L0').length;
        return eq(got, want);
      });
      t('V48D a left join keeps the unmatched rows as NULL', () => {
        const got = one('SELECT COUNT(*) AS c FROM v48_a a LEFT JOIN v48_b b ON a.bid = b.bid WHERE b.bid IS NULL');
        const bmap = new Set(B.map(r => r.bid));
        return eq(got, A.filter(r => r.bid === null || !bmap.has(r.bid)).length);
      });
      t('V48D a derived table in FROM', () =>
        eq(one('SELECT COUNT(*) AS c FROM (SELECT id FROM v48_a WHERE v > 0) z'),
           A.filter(r => r.v !== null && r.v > 0).length));
      t('V48D a derived table with a column list', () =>
        eq(one('SELECT COUNT(x) AS c FROM (SELECT id FROM v48_a) AS z(x)'), 400));
      t('V48D a VALUES derived table', () =>
        eq(one("SELECT COUNT(*) AS c FROM (VALUES (1), (2), (3)) AS z(x)"), 3));
      t('V48D a CTE in FROM', () =>
        eq(one('WITH c AS (SELECT id FROM v48_a WHERE v > 0) SELECT COUNT(*) AS c FROM c'),
           A.filter(r => r.v !== null && r.v > 0).length));
      t('V48D CROSS APPLY', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_b CROSS APPLY (SELECT COUNT(*) AS k FROM v48_a WHERE v48_a.bid = v48_b.bid) x'), 80));
      t('V48D LATERAL', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_b, LATERAL (SELECT COUNT(*) AS k FROM v48_a WHERE v48_a.bid = v48_b.bid) x'), 80));

      // ============================================================
      // E. WHERE × ORDER BY × LIMIT / OFFSET の行列
      // ============================================================
      const WHERES = [
        ['', () => true],
        [" WHERE g = 'A'", r => r.g === 'A'],
        [' WHERE v > 0', r => r.v !== null && r.v > 0],
        [' WHERE v IS NOT NULL', r => r.v !== null],
        [' WHERE id % 3 = 0', r => r.id % 3 === 0],
        [' WHERE bid IS NULL', r => r.bid === null],
        [" WHERE g IN ('A', 'C')", r => r.g === 'A' || r.g === 'C'],
        [' WHERE id BETWEEN 100 AND 300', r => r.id >= 100 && r.id <= 300],
        [' WHERE v < 0 AND bid > 20', r => r.v !== null && r.v < 0 && r.bid !== null && r.bid > 20],
        [' WHERE id > 380', r => r.id > 380],
      ];
      const ORDERS = [
        [' ORDER BY id', (a, b) => a.id - b.id],
        [' ORDER BY id DESC', (a, b) => b.id - a.id],
        [' ORDER BY g, id', (a, b) => (a.g < b.g ? -1 : a.g > b.g ? 1 : 0) || a.id - b.id],
        [' ORDER BY g DESC, id', (a, b) => (a.g < b.g ? 1 : a.g > b.g ? -1 : 0) || a.id - b.id],
        [' ORDER BY id % 7, id', (a, b) => (a.id % 7) - (b.id % 7) || a.id - b.id],
        [' ORDER BY g, id DESC', (a, b) => (a.g < b.g ? -1 : a.g > b.g ? 1 : 0) || b.id - a.id],
        [' ORDER BY bid NULLS LAST, id', (a, b) => {
          if (a.bid === null && b.bid === null) return a.id - b.id;
          if (a.bid === null) return 1;
          if (b.bid === null) return -1;
          return a.bid - b.bid || a.id - b.id;
        }],
        // 昇順の既定では NULL が先（MySQL と同じ。PostgreSQL は最後）
        [' ORDER BY v, id', (a, b) => {
          if (a.v === null && b.v === null) return a.id - b.id;
          if (a.v === null) return -1;
          if (b.v === null) return 1;
          return a.v - b.v || a.id - b.id;
        }],
      ];
      const PAGES = [['', 0, null], [' LIMIT 5', 0, 5], [' LIMIT 10 OFFSET 3', 3, 10],
                     [' LIMIT 0', 0, 0], [' LIMIT 1000', 0, 1000], [' OFFSET 395', 395, null],
                     [' LIMIT 1', 0, 1], [' LIMIT 7 OFFSET 0', 0, 7], [' LIMIT 3 OFFSET 100', 100, 3],
                     [' LIMIT 50 OFFSET 380', 380, 50]];
      WHERES.forEach(([wSql, wFn]) => ORDERS.forEach(([oSql, oFn]) => PAGES.forEach(([pSql, off, lim]) => {
        t(`V48E SELECT id FROM v48_a${wSql}${oSql}${pSql}`, () => {
          const got = rows(`SELECT id FROM v48_a${wSql}${oSql}${pSql}`).map(r => r.id);
          let want = A.filter(wFn).slice().sort(oFn).map(r => r.id);
          want = want.slice(off, lim === null ? undefined : off + lim);
          return eq(got, want);
        });
      })));
      // NULLS FIRST / LAST
      t('V48E ORDER BY v NULLS FIRST', () => {
        const got = rows('SELECT id FROM v48_a ORDER BY v NULLS FIRST, id').map(r => r.id);
        const want = A.slice().sort((a, b) => {
          if (a.v === null && b.v === null) return a.id - b.id;
          if (a.v === null) return -1;
          if (b.v === null) return 1;
          return a.v - b.v || a.id - b.id;
        }).map(r => r.id);
        return eq(got, want);
      });
      t('V48E ORDER BY v NULLS LAST', () => {
        const got = rows('SELECT id FROM v48_a ORDER BY v NULLS LAST, id').map(r => r.id);
        const want = A.slice().sort((a, b) => {
          if (a.v === null && b.v === null) return a.id - b.id;
          if (a.v === null) return 1;
          if (b.v === null) return -1;
          return a.v - b.v || a.id - b.id;
        }).map(r => r.id);
        return eq(got, want);
      });
      t('V48E ORDER BY an ordinal', () => {
        const got = rows('SELECT id, g FROM v48_a ORDER BY 1 DESC LIMIT 3').map(r => r.id);
        return eq(got, [399, 398, 397]);
      });
      t('V48E ORDER BY an expression', () => {
        const got = rows('SELECT id FROM v48_a WHERE v IS NOT NULL ORDER BY ABS(v), id LIMIT 5').map(r => r.id);
        const want = A.filter(r => r.v !== null).slice()
          .sort((a, b) => Math.abs(a.v) - Math.abs(b.v) || a.id - b.id).slice(0, 5).map(r => r.id);
        return eq(got, want);
      });
      t('V48E FETCH FIRST n ROWS ONLY', () =>
        eq(rows('SELECT id FROM v48_a ORDER BY id FETCH FIRST 4 ROWS ONLY').map(r => r.id), [0, 1, 2, 3]));
      t('V48E OFFSET n ROWS FETCH NEXT m ROWS ONLY', () =>
        eq(rows('SELECT id FROM v48_a ORDER BY id OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY').map(r => r.id), [2, 3, 4]));
      t('V48E TOP n', () => eq(rows('SELECT TOP 3 id FROM v48_a ORDER BY id').map(r => r.id), [0, 1, 2]));
      t('V48E LIMIT with the MySQL two-argument form', () =>
        eq(rows('SELECT id FROM v48_a ORDER BY id LIMIT 2, 3').map(r => r.id), [2, 3, 4]));

      // ============================================================
      // F. GROUP BY と HAVING
      // ============================================================
      const GROUPINGS = [
        ['g', r => r.g],
        ['v IS NULL', r => String(r.v === null)],
        ['id % 5', r => String(r.id % 5)],
        ['g, id % 2', r => r.g + '|' + (r.id % 2)],
        ["SUBSTR(s, 1, 1)", r => r.s === null ? null : r.s.slice(0, 1)],
      ];
      GROUPINGS.forEach(([gSql, gFn], gi) => {
        t(`V48F GROUP BY ${gSql} counts`, () => {
          const got = rows(`SELECT COUNT(*) AS c FROM v48_a GROUP BY ${gSql} ORDER BY c, 1`).map(r => r.c);
          const m = new Map();
          A.forEach(r => { const k = gFn(r); m.set(k, (m.get(k) || 0) + 1); });
          const want = [...m.values()].sort((a, b) => a - b);
          return eq(got.slice().sort((a, b) => a - b), want);
        });
        t(`V48F GROUP BY ${gSql} sums`, () => {
          const got = rows(`SELECT COALESCE(SUM(v), 0) AS s FROM v48_a GROUP BY ${gSql}`).map(r => r.s);
          const m = new Map();
          A.forEach(r => { const k = gFn(r); m.set(k, (m.get(k) || 0) + (r.v === null ? 0 : r.v)); });
          return eq(got.slice().sort((a, b) => a - b), [...m.values()].sort((a, b) => a - b));
        });
        t(`V48F GROUP BY ${gSql} group count`, () => {
          const got = rows(`SELECT COUNT(*) AS c FROM v48_a GROUP BY ${gSql}`).length;
          const m = new Set(A.map(gFn));
          return eq(got, m.size);
        });
      });
      const HAVINGS = [
        ['COUNT(*) > 50', n => n.count > 50],
        ['COUNT(*) < 50', n => n.count < 50],
        ['SUM(v) > 0', n => n.sum > 0],
        ['MIN(v) < -10', n => n.min !== null && n.min < -10],
        ['MAX(v) > 20', n => n.max !== null && n.max > 20],
        ['COUNT(DISTINCT v) > 10', n => n.distinct > 10],
      ];
      HAVINGS.forEach(([hSql, hFn]) => {
        t(`V48F GROUP BY g HAVING ${hSql}`, () => {
          const got = rows(`SELECT g FROM v48_a GROUP BY g HAVING ${hSql} ORDER BY g`).map(r => r.g);
          const m = new Map();
          A.forEach(r => {
            if (!m.has(r.g)) m.set(r.g, []);
            m.get(r.g).push(r);
          });
          const want = [...m.keys()].sort().filter(g => {
            const rs = m.get(g), vs = rs.filter(r => r.v !== null).map(r => r.v);
            return hFn({ count: rs.length, sum: vs.reduce((a, b) => a + b, 0),
                         min: vs.length ? Math.min(...vs) : null,
                         max: vs.length ? Math.max(...vs) : null,
                         distinct: new Set(vs).size });
          });
          return eq(got, want);
        });
      });
      ['ROLLUP(g)', 'CUBE(g)', 'GROUPING SETS ((g), ())'].forEach(gx => {
        ok(`V48F GROUP BY ${gx}`, `SELECT g, COUNT(*) AS c FROM v48_a GROUP BY ${gx}`);
      });
      t('V48F ROLLUP adds the grand total row', () => {
        const n = rows('SELECT g, COUNT(*) AS c FROM v48_a GROUP BY ROLLUP(g)').length;
        return eq(n, new Set(A.map(r => r.g)).size + 1);
      });

      // ============================================================
      // G. 集合演算
      // ============================================================
      const SETOPS = [
        ['UNION', (a, b) => [...new Set([...a, ...b])]],
        ['UNION ALL', (a, b) => [...a, ...b]],
        ['INTERSECT', (a, b) => [...new Set(a.filter(x => b.indexOf(x) !== -1))]],
        ['EXCEPT', (a, b) => [...new Set(a.filter(x => b.indexOf(x) === -1))]],
      ];
      SETOPS.forEach(([op, ref]) => {
        t(`V48G ${op} of two filters`, () => {
          const got = rows(`SELECT id FROM v48_a WHERE id < 10 ${op} SELECT id FROM v48_a WHERE id BETWEEN 5 AND 14 ORDER BY id`)
            .map(r => r.id);
          const left = A.filter(r => r.id < 10).map(r => r.id);
          const right = A.filter(r => r.id >= 5 && r.id <= 14).map(r => r.id);
          return eq(got, ref(left, right).sort((a, b) => a - b));
        });
      });
      t('V48G a UNION chain of five branches', () => {
        const parts = [];
        for (let i = 0; i < 5; i++) parts.push(`SELECT ${i} AS x`);
        return eq(rows(parts.join(' UNION ') + ' ORDER BY x').map(r => r.x), [0, 1, 2, 3, 4]);
      });
      t('V48G UNION ALL keeps duplicates', () =>
        eq(rows('SELECT 1 AS x UNION ALL SELECT 1 AS x').length, 2));
      t('V48G UNION removes duplicates', () =>
        eq(rows('SELECT 1 AS x UNION SELECT 1 AS x').length, 1));
      t('V48G parenthesised set operation branches', () =>
        eq(rows('(SELECT 1 AS x) UNION (SELECT 2 AS x) ORDER BY x').map(r => r.x), [1, 2]));
      t('V48G a set operation inside a derived table', () =>
        eq(one('SELECT COUNT(*) AS c FROM ((SELECT 1 AS x) UNION (SELECT 2 AS x)) z'), 2));

      // ============================================================
      // H. サブクエリの置ける位置
      // ============================================================
      t('V48H a scalar subquery in the select list', () =>
        eq(one('SELECT (SELECT COUNT(*) FROM v48_b) AS r FROM v48_a LIMIT 1'), 80));
      t('V48H a scalar subquery in WHERE', () =>
        eq(one('SELECT COUNT(*) AS c FROM v48_a WHERE v > (SELECT MIN(n) FROM v48_b)'),
           A.filter(r => r.v !== null && r.v > 0).length));
      t('V48H a correlated scalar subquery', () => {
        const got = rows('SELECT id, (SELECT label FROM v48_b WHERE v48_b.bid = v48_a.bid) AS lbl FROM v48_a ORDER BY id LIMIT 5')
          .map(r => r.lbl);
        const bmap = new Map(B.map(r => [r.bid, r.label]));
        return eq(got, A.slice(0, 5).map(r => (r.bid === null ? null : bmap.get(r.bid)) || null));
      });
      t('V48H a subquery in FROM', () =>
        eq(one('SELECT SUM(x) AS s FROM (SELECT id AS x FROM v48_a WHERE id < 10) z'), 45));
      t('V48H a subquery in HAVING', () =>
        eq(rows('SELECT g FROM v48_a GROUP BY g HAVING COUNT(*) > (SELECT 10) ORDER BY g').length >= 1, true));
      t('V48H a subquery in ORDER BY', () =>
        eq(rows('SELECT id FROM v48_a ORDER BY (SELECT 1), id LIMIT 3').map(r => r.id), [0, 1, 2]));
      t('V48H nested derived tables three deep', () =>
        eq(one('SELECT COUNT(*) AS c FROM (SELECT * FROM (SELECT * FROM (SELECT id FROM v48_a) a) b) c'), 400));
      t('V48H a CTE referencing another CTE', () =>
        eq(one('WITH x AS (SELECT id FROM v48_a WHERE id < 20), y AS (SELECT id FROM x WHERE id < 10) SELECT COUNT(*) AS c FROM y'), 10));
      t('V48H a recursive CTE', () =>
        eq(one('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20) SELECT COUNT(*) AS c FROM n'), 20));

      // ============================================================
      // I. メタ照会の全網羅
      // ============================================================
      const SHOWS = ['TABLES', 'VIEWS', 'PROCEDURES', 'TRIGGERS', 'FUNCTIONS', 'VARIABLES',
                     'SEQUENCES', 'PREPARED', 'STATUS', 'SCHEMAS', 'DATABASES',
                     'MATERIALIZED VIEWS', 'COMMENTS', 'TRANSACTION ISOLATION LEVEL',
                     'WARNINGS', 'SETTINGS', 'STORAGE', 'SNAPSHOTS', 'PROFILE', 'SLOW QUERIES'];
      SHOWS.forEach(s => ok(`V48I SHOW ${s}`, `SHOW ${s}`));
      ok('V48I SHOW TABLES LIKE', "SHOW TABLES LIKE 'v48%'");
      ok('V48I SHOW FUNCTIONS LIKE', "SHOW FUNCTIONS LIKE 'ABS'");
      ok('V48I SHOW COLUMNS FROM', 'SHOW COLUMNS FROM v48_a');
      ok('V48I SHOW INDEXES FROM', 'SHOW INDEXES FROM v48_a');
      ok('V48I SHOW CHECKS FROM', 'SHOW CHECKS FROM v48_a');
      ok('V48I SHOW TRIGGERS FROM', 'SHOW TRIGGERS FROM v48_a');
      ok('V48I SHOW CREATE TABLE', 'SHOW CREATE TABLE v48_a');
      ok('V48I SHOW COUNT(*) WARNINGS', 'SHOW COUNT(*) WARNINGS');
      ok('V48I DESCRIBE', 'DESCRIBE v48_a');
      ok('V48I DESC', 'DESC v48_a');
      t('V48I SHOW TABLES includes the fixture', () => {
        const names = rows('SHOW TABLES').map(r => Object.values(r)[0]);
        return eq(names.indexOf('v48_a') !== -1, true);
      });
      t('V48I DESCRIBE lists every column', () => eq(rows('DESCRIBE v48_a').length, 6));
      t('V48I SHOW COLUMNS lists every column', () => eq(rows('SHOW COLUMNS FROM v48_a').length, 6));
      const EXPLAINS = ['EXPLAIN', 'EXPLAIN QUERY PLAN', 'EXPLAIN ANALYZE',
                        'EXPLAIN (FORMAT TEXT)', 'EXPLAIN (FORMAT JSON)'];
      EXPLAINS.forEach(e => ok(`V48I ${e} over a select`, `${e} SELECT * FROM v48_a WHERE v > 0`));
      t('V48I EXPLAIN returns plan steps', () =>
        eq(rows('EXPLAIN SELECT * FROM v48_a').length >= 1, true));
      t('V48I EXPLAIN does not run the statement', () => {
        const before = one('SELECT COUNT(*) AS c FROM v48_a');
        q('EXPLAIN SELECT * FROM v48_a');
        return eq(one('SELECT COUNT(*) AS c FROM v48_a'), before);
      });
      err('V48I EXPLAIN over a DELETE is refused', 'EXPLAIN DELETE FROM v48_a', 'select');
      err('V48I EXPLAIN over a DROP is refused', 'EXPLAIN DROP TABLE v48_a', 'select');
      const PRAGMAS = ['table_info(v48_a)', 'index_list(v48_a)', 'foreign_key_list(v48_a)',
                       'table_list', 'user_version'];
      PRAGMAS.forEach(p => ok(`V48I PRAGMA ${p}`, `PRAGMA ${p}`));
      t('V48I PRAGMA table_info lists every column', () => eq(rows('PRAGMA table_info(v48_a)').length, 6));
      t('V48I PRAGMA user_version can be set', () => {
        q('PRAGMA user_version = 42');
        return eq(one('PRAGMA user_version'), 42);
      });
      const ISCHEMA = ['TABLES', 'COLUMNS', 'VIEWS', 'KEY_COLUMN_USAGE', 'TABLE_CONSTRAINTS',
                       'SCHEMATA', 'ROUTINES', 'SEQUENCES', 'REFERENTIAL_CONSTRAINTS',
                       'CHECK_CONSTRAINTS', 'STATISTICS', 'TRIGGERS', 'PARAMETERS'];
      ISCHEMA.forEach(v => ok(`V48I INFORMATION_SCHEMA.${v}`, `SELECT * FROM information_schema.${v}`));
      t('V48I INFORMATION_SCHEMA.TABLES includes the fixture', () => {
        const got = one("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_name = 'v48_a'");
        return eq(got >= 1, true);
      });
      t('V48I INFORMATION_SCHEMA.COLUMNS lists the columns', () => {
        const got = one("SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_name = 'v48_a'");
        return eq(got, 6);
      });
      ok('V48I sqlite_master', 'SELECT * FROM sqlite_master');
      err('V48I an unknown INFORMATION_SCHEMA view', 'SELECT * FROM information_schema.nosuch', 'not available');
      err('V48I an unknown PRAGMA', 'PRAGMA nosuch', 'unsupported pragma');
      err('V48I an unknown SHOW target', 'SHOW NOSUCH', 'syntax error in show');

      // ============================================================
      // J. 表関数・配列・PIVOT・全文検索
      // ============================================================
      t('V48J GENERATE_SERIES over integers', () =>
        eq(one('SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10) AS g(n)'), 10));
      t('V48J GENERATE_SERIES with a step', () =>
        eq(one('SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10, 3) AS g(n)'), 4));
      t('V48J GENERATE_SERIES over dates', () =>
        eq(one("SELECT COUNT(*) AS c FROM GENERATE_SERIES(DATE '2024-01-01', DATE '2024-01-10', INTERVAL 1 DAY) AS g(d)"), 10));
      t('V48J UNNEST over a list', () =>
        eq(one('SELECT COUNT(*) AS c FROM UNNEST(1, 2, 3) AS u(x)'), 3));
      t('V48J an array literal', () => eq(one('SELECT ARRAY[1, 2, 3] AS r'), [1, 2, 3]));
      t('V48J ARRAY_LENGTH', () => eq(one('SELECT ARRAY_LENGTH(ARRAY[1, 2, 3]) AS r'), 3));
      t('V48J array subscripting', () => eq(one('SELECT (ARRAY[10, 20, 30])[2] AS r'), 20));
      t('V48J ARRAY_CONTAINS', () => eq(one('SELECT ARRAY_CONTAINS(ARRAY[1, 2, 3], 2) AS r'), true));
      t('V48J ARRAY_TO_STRING', () => eq(one("SELECT ARRAY_TO_STRING(ARRAY[1, 2, 3], '-') AS r"), '1-2-3'));
      t('V48J STRING_TO_ARRAY', () => eq(one("SELECT STRING_TO_ARRAY('a,b,c', ',') AS r"), ['a', 'b', 'c']));
      t('V48J PIVOT', () => {
        const r = q("SELECT * FROM v48_a PIVOT (COUNT(id) FOR g IN ('A', 'B', 'C', 'D'))");
        return eq(!r.error, true);
      });
      t('V48J a full-text MATCH AGAINST', () => {
        const r = q("SELECT COUNT(*) AS c FROM v48_a WHERE MATCH(s) AGAINST ('alpha')");
        return eq(!r.error, true);
      });
      t('V48J LEVENSHTEIN', () => eq(one("SELECT LEVENSHTEIN('kitten', 'sitting') AS r"), 3));
      t('V48J DIFFERENCE compares soundex codes', () =>
        eq(one("SELECT DIFFERENCE('Robert', 'Rupert') AS r"), 4));

      // ============================================================
      // K. 誤りは拒否される
      // ============================================================
      err('V48K a missing table', 'SELECT * FROM v48_nosuch');
      err('V48K a missing column', 'SELECT nosuch FROM v48_a');
      err('V48K a missing column in WHERE', 'SELECT id FROM v48_a WHERE nosuch = 1');
      err('V48K a missing column in ORDER BY', 'SELECT id FROM v48_a ORDER BY nosuch');
      err('V48K a missing column in GROUP BY', 'SELECT COUNT(*) FROM v48_a GROUP BY nosuch');
      err('V48K an ambiguous column in a join',
          'SELECT bid FROM v48_a JOIN v48_b ON v48_a.bid = v48_b.bid', 'ambiguous');
      err('V48K an unbalanced parenthesis', 'SELECT (1 + 2 FROM v48_a');
      err('V48K an unclosed quote', "SELECT 'abc FROM v48_a");
      err('V48K a set operation with different column counts',
          'SELECT id FROM v48_a UNION SELECT id, g FROM v48_a');
      err('V48K a scalar subquery returning several rows',
          'SELECT (SELECT id FROM v48_a) AS r', 'more than 1 row');
      err('V48K a missing JOIN condition column',
          'SELECT COUNT(*) FROM v48_a a JOIN v48_b b ON a.nosuch = b.bid');
      err('V48K a misspelled function', 'SELECT LENGHT(s) FROM v48_a', 'does not exist');
      err('V48K a misspelled column suggests a name', 'SELECT idd FROM v48_a', 'did you mean');
      err('V48K LIMIT with a negative value', 'SELECT id FROM v48_a LIMIT -1');
      err('V48K an empty statement', '');

      // ============================================================
      // 片付け
      // ============================================================
      t('V48Zz cleanup', () => {
        ['v48_a', 'v48_b'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v48_') === 0).length === 0;
      });

      return T;
    }
