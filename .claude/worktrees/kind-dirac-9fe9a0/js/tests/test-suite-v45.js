    // ============================================================================
    // [Test Suite v45] - コマンド全網羅 (3/6): JSON 21 種・集約 33 種・ウィンドウ 11 種・
    //                    条件と NULL 17 種・メタ 14 種・シーケンス 3 種
    //
    //     A. JSON 関数 21 種 × 入力
    //     B. 集約関数 33 種 × データ形（通常・NULL 混在・単一行・空集合・DISTINCT）
    //     C. 集約をグループごとに全件突き合わせ
    //     D. ウィンドウ関数 11 種 × 区画と並び
    //     E. 条件と NULL の関数 17 種
    //     F. メタ関数 14 種
    //     G. シーケンス 3 種
    //     H. FILTER / WITHIN GROUP / DISTINCT の組み合わせ
    //     I. 引数と用法の誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV45Tests() のスプレッドで合流する
    // ============================================================================
    function getV45Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, rowsOf: rows, oneOf: one, eq, val } = makeTestKit('V45');
      const r4 = (n) => n === null ? null : Math.round(n * 10000) / 10000;

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      const F = [];     // { id, g, v, w, s }
      t('V45 fixture', () => {
        ['v45_f', 'v45_e', 'v45_j'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        q('CREATE TABLE v45_f (id INT, g TEXT, v INT, w DECIMAL(18,4), s TEXT)');
        F.length = 0;
        const gs = ['A', 'B', 'C', 'D'];
        for (let i = 0; i < 80; i++) {
          const v = (i % 13 === 12) ? null : ((i * 7) % 41) - 15;
          const w = (i % 17 === 16) ? null : ((i % 23) - 10) * 1.5;
          const s = (i % 11 === 10) ? null : String.fromCharCode(97 + (i % 7)) + (i % 5);
          F.push({ id: i, g: gs[i % 4], v, w, s });
        }
        q('INSERT INTO v45_f VALUES ' + F.map(r =>
          `(${r.id}, '${r.g}', ${r.v === null ? 'NULL' : r.v}, ${r.w === null ? 'NULL' : r.w}, ` +
          `${r.s === null ? 'NULL' : "'" + r.s + "'"})`).join(','));
        q('CREATE TABLE v45_e (id INT, v INT)');            // 常に空
        q('CREATE TABLE v45_j (id INT, doc TEXT)');
        q(`INSERT INTO v45_j VALUES (1, '{"a":1,"b":{"c":2},"d":[1,2,3]}'), (2, '[10,20,30]'), ` +
          `(3, '{"a":9,"z":null}'), (4, NULL), (5, 'not json')`);
        return db.tables['v45_f'].rowCount === 80 && db.tables['v45_j'].rowCount === 5;
      });

      // ============================================================
      // A. JSON 関数 21 種
      // ============================================================
      const J = `'{"a":1,"b":{"c":2},"d":[1,2,3]}'`;
      const AR = `'[1,2,3]'`;
      const JSONC = [
        [`JSON_VALID(${J})`, 1], [`JSON_VALID('{bad')`, 0], [`JSON_VALID('123')`, 1],
        [`JSON_VALID('"s"')`, 1], [`JSON_VALID('[]')`, 1], [`JSON_VALID(NULL)`, null],
        [`JSON_TYPE(${J})`, 'OBJECT'], [`JSON_TYPE(${AR})`, 'ARRAY'], [`JSON_TYPE('1')`, 'INTEGER'],
        [`JSON_TYPE('1.5')`, 'DOUBLE'], [`JSON_TYPE('"s"')`, 'STRING'], [`JSON_TYPE('true')`, 'BOOLEAN'],
        [`JSON_TYPE('null')`, 'NULL'],
        [`JSON_DEPTH(${J})`, 3], [`JSON_DEPTH(${AR})`, 2], [`JSON_DEPTH('1')`, 1], [`JSON_DEPTH('{}')`, 1],
        [`JSON_DEPTH('[]')`, 1], [`JSON_DEPTH('{"a":{"b":{"c":1}}}')`, 4],
        [`JSON_LENGTH(${J})`, 3], [`JSON_LENGTH(${AR})`, 3], [`JSON_LENGTH('{}')`, 0],
        [`JSON_LENGTH('[]')`, 0], [`JSON_LENGTH('1')`, 1],
        [`JSON_KEYS(${J})`, '["a","b","d"]'], [`JSON_KEYS('{}')`, '[]'], [`JSON_KEYS(${AR})`, null],
        [`JSON_EXTRACT(${J}, '$.a')`, 1], [`JSON_EXTRACT(${J}, '$.b.c')`, 2],
        [`JSON_EXTRACT(${J}, '$.d[0]')`, 1], [`JSON_EXTRACT(${J}, '$.d[1]')`, 2],
        [`JSON_EXTRACT(${J}, '$.d[9]')`, null], [`JSON_EXTRACT(${J}, '$.zz')`, null],
        [`JSON_EXTRACT(${J}, '$.d')`, '[1,2,3]'], [`JSON_EXTRACT(NULL, '$.a')`, null],
        [`JSON_VALUE(${J}, '$.a')`, 1], [`JSON_VALUE(${J}, '$.b.c')`, 2], [`JSON_VALUE(${J}, '$.zz')`, null],
        [`JSON_UNQUOTE('"abc"')`, 'abc'], [`JSON_UNQUOTE('abc')`, 'abc'], [`JSON_UNQUOTE(NULL)`, null],
        [`JSON_QUOTE('abc')`, '"abc"'], [`JSON_QUOTE('')`, '""'], [`JSON_QUOTE(NULL)`, null],
        [`JSON_CONTAINS(${AR}, '2')`, 1], [`JSON_CONTAINS(${AR}, '9')`, 0],
        [`JSON_CONTAINS(${J}, '1', '$.a')`, 1], [`JSON_CONTAINS(${J}, '9', '$.a')`, 0],
        [`JSON_CONTAINS_PATH(${J}, 'one', '$.a')`, 1], [`JSON_CONTAINS_PATH(${J}, 'one', '$.zz')`, 0],
        [`JSON_CONTAINS_PATH(${J}, 'all', '$.a', '$.b')`, 1],
        [`JSON_CONTAINS_PATH(${J}, 'all', '$.a', '$.zz')`, 0],
        [`JSON_CONTAINS_PATH(${J}, 'one', '$.a', '$.zz')`, 1],
        [`JSON_SET(${J}, '$.a', 9)`, '{"a":9,"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_SET(${J}, '$.new', 9)`, '{"a":1,"b":{"c":2},"d":[1,2,3],"new":9}'],
        [`JSON_INSERT(${J}, '$.a', 9)`, '{"a":1,"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_INSERT(${J}, '$.new', 9)`, '{"a":1,"b":{"c":2},"d":[1,2,3],"new":9}'],
        [`JSON_REPLACE(${J}, '$.a', 9)`, '{"a":9,"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_REPLACE(${J}, '$.new', 9)`, '{"a":1,"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_REMOVE(${J}, '$.a')`, '{"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_REMOVE(${J}, '$.zz')`, '{"a":1,"b":{"c":2},"d":[1,2,3]}'],
        [`JSON_ARRAY(1, 'a', NULL)`, '[1,"a",null]'], [`JSON_ARRAY()`, '[]'],
        [`JSON_ARRAY(1, 2, 3)`, '[1,2,3]'],
        [`JSON_OBJECT('k', 1)`, '{"k":1}'], [`JSON_OBJECT('k', 1, 'j', 2)`, '{"k":1,"j":2}'],
        [`JSON_OBJECT()`, '{}'],
        [`JSON_ARRAY_APPEND(${AR}, '$', 4)`, '[1,2,3,4]'],
        [`JSON_ARRAY_INSERT(${AR}, '$[1]', 9)`, '[1,9,2,3]'],
        [`JSON_ARRAY_INSERT(${AR}, '$[0]', 9)`, '[9,1,2,3]'],
        [`JSON_MERGE_PATCH('{"a":1}', '{"b":2}')`, '{"a":1,"b":2}'],
        [`JSON_MERGE_PATCH('{"a":1}', '{"a":9}')`, '{"a":9}'],
        [`JSON_MERGE_PATCH('{"a":1}', '{"a":null}')`, '{}'],
        [`JSON_PRETTY('{"a":1}')`, '{\n  "a": 1\n}'],
      ];
      JSONC.forEach(([e, w]) => val(`V45A ${e}`, `SELECT ${e} AS r`, w));
      // 演算子形
      val(`V45A the -> operator`, `SELECT ${J} -> '$.a' AS r`, '1');
      val(`V45A the ->> operator`, `SELECT ${J} ->> '$.a' AS r`, '1');
      val(`V45A -> keeps a string quoted`, `SELECT '{"s":"x"}' -> '$.s' AS r`, '"x"');
      val(`V45A ->> unquotes a string`, `SELECT '{"s":"x"}' ->> '$.s' AS r`, 'x');
      val(`V45A IS JSON on valid JSON`, `SELECT ${J} IS JSON AS r`, true);
      val(`V45A IS JSON on invalid JSON`, `SELECT '{bad' IS JSON AS r`, false);
      val(`V45A IS NOT JSON on valid JSON`, `SELECT ${J} IS NOT JSON AS r`, false);
      // 列へ適用
      t('V45A JSON_VALID over a column', () => {
        const got = rows('SELECT id, JSON_VALID(doc) AS r FROM v45_j ORDER BY id').map(r => r.r);
        return eq(got, [1, 1, 1, null, 0]);
      });
      t('V45A JSON_EXTRACT over a column', () => {
        const got = rows("SELECT id, JSON_EXTRACT(doc, '$.a') AS r FROM v45_j ORDER BY id").map(r => r.r);
        return eq(got, [1, null, 9, null, null]);
      });
      t('V45A JSON_TYPE over a column', () => {
        const got = rows('SELECT id, JSON_TYPE(doc) AS r FROM v45_j ORDER BY id').map(r => r.r);
        return eq(got, ['OBJECT', 'ARRAY', 'OBJECT', null, null]);
      });
      t('V45A filtering rows by a JSON path', () => {
        const got = one("SELECT COUNT(*) AS c FROM v45_j WHERE JSON_EXTRACT(doc, '$.a') IS NOT NULL");
        return eq(got, 2);
      });
      t('V45A JSON round-trips through SET and EXTRACT', () => {
        const got = one(`SELECT JSON_EXTRACT(JSON_SET(${J}, '$.a', 42), '$.a') AS r`);
        return eq(got, 42);
      });
      // 入れ子の組み立て。LuminaDB には JSON 型が無く、JSON_OBJECT / JSON_ARRAY の
      // 戻り値はただの文字列なので、入れ子にすると内側が文字列として引用される。
      // 入れ子の JSON を作るには JSON_SET / JSON_MERGE_PATCH を使う
      val('V45A a nested JSON constructor quotes the inner value',
          "SELECT JSON_ARRAY(JSON_OBJECT('k', 1)) AS r", '["{\\"k\\":1}"]');
      val('V45A JSON_SET builds a nested object',
          "SELECT JSON_SET('{}', '$.list', 1) AS r", '{"list":1}');
      val('V45A JSON_MERGE_PATCH builds a nested object',
          `SELECT JSON_MERGE_PATCH('{"a":1}', '{"b":{"c":2}}') AS r`, '{"a":1,"b":{"c":2}}');

      // ============================================================
      // B. 集約関数 33 種
      // ============================================================
      const vs = () => F.filter(r => r.v !== null).map(r => r.v);
      const ws = () => F.filter(r => r.w !== null).map(r => r.w);
      const ss = () => F.filter(r => r.s !== null).map(r => r.s);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const mean = (a) => sum(a) / a.length;
      const varp = (a) => { const m = mean(a); return sum(a.map(x => (x - m) * (x - m))) / a.length; };
      const vars = (a) => { const m = mean(a); return sum(a.map(x => (x - m) * (x - m))) / (a.length - 1); };
      const median = (a) => { const b = a.slice().sort((x, y) => x - y); const n = b.length;
        return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };

      t('V45B COUNT of a column skips NULL', () => eq(one('SELECT COUNT(v) AS r FROM v45_f'), vs().length));
      t('V45B COUNT star counts every row', () => eq(one('SELECT COUNT(*) AS r FROM v45_f'), F.length));
      t('V45B COUNT DISTINCT', () => eq(one('SELECT COUNT(DISTINCT v) AS r FROM v45_f'), new Set(vs()).size));
      t('V45B SUM', () => eq(one('SELECT SUM(v) AS r FROM v45_f'), sum(vs())));
      t('V45B AVG', () => eq(r4(one('SELECT AVG(v) AS r FROM v45_f')), r4(mean(vs()))));
      t('V45B MIN', () => eq(one('SELECT MIN(v) AS r FROM v45_f'), Math.min(...vs())));
      t('V45B MAX', () => eq(one('SELECT MAX(v) AS r FROM v45_f'), Math.max(...vs())));
      t('V45B MEDIAN', () => eq(one('SELECT MEDIAN(v) AS r FROM v45_f'), median(vs())));
      t('V45B STDDEV is the population form', () => eq(one('SELECT STDDEV(v) AS r FROM v45_f'), r4(Math.sqrt(varp(vs())))));
      t('V45B STDDEV_POP', () => eq(one('SELECT STDDEV_POP(v) AS r FROM v45_f'), r4(Math.sqrt(varp(vs())))));
      t('V45B STDDEV_SAMP', () => eq(one('SELECT STDDEV_SAMP(v) AS r FROM v45_f'), r4(Math.sqrt(vars(vs())))));
      t('V45B VARIANCE is the population form', () => eq(one('SELECT VARIANCE(v) AS r FROM v45_f'), r4(varp(vs()))));
      t('V45B VAR_POP', () => eq(one('SELECT VAR_POP(v) AS r FROM v45_f'), r4(varp(vs()))));
      t('V45B VAR_SAMP', () => eq(one('SELECT VAR_SAMP(v) AS r FROM v45_f'), r4(vars(vs()))));
      t('V45B SUM over a decimal column', () => eq(r4(one('SELECT SUM(w) AS r FROM v45_f')), r4(sum(ws()))));
      t('V45B AVG over a decimal column', () => eq(r4(one('SELECT AVG(w) AS r FROM v45_f')), r4(mean(ws()))));
      t('V45B GROUP_CONCAT', () => eq(one('SELECT GROUP_CONCAT(s) AS r FROM v45_f'), ss().join(',')));
      t('V45B GROUP_CONCAT with a separator', () => eq(one("SELECT GROUP_CONCAT(s, '|') AS r FROM v45_f"), ss().join('|')));
      t('V45B STRING_AGG', () => eq(one("SELECT STRING_AGG(s, '-') AS r FROM v45_f"), ss().join('-')));
      t('V45B LISTAGG', () => eq(one("SELECT LISTAGG(s, '-') AS r FROM v45_f"), ss().join('-')));
      t('V45B ARRAY_AGG keeps NULLs', () => eq(one('SELECT ARRAY_AGG(v) AS r FROM v45_f'), JSON.stringify(F.map(r => r.v))));
      t('V45B JSON_ARRAYAGG keeps NULLs', () => eq(one('SELECT JSON_ARRAYAGG(v) AS r FROM v45_f'), JSON.stringify(F.map(r => r.v))));
      t('V45B COUNT_IF', () => eq(one('SELECT COUNT_IF(v > 0) AS r FROM v45_f'), F.filter(r => r.v !== null && r.v > 0).length));
      t('V45B ANY_VALUE returns a value that occurs', () => {
        const got = one('SELECT ANY_VALUE(g) AS r FROM v45_f');
        return F.some(r => r.g === got) || eq(got, 'in the table');
      });
      t('V45B BIT_AND', () => eq(one('SELECT BIT_AND(id) AS r FROM v45_f'),
        F.map(r => r.id).reduce((a, b) => a & b)));
      t('V45B BIT_OR', () => eq(one('SELECT BIT_OR(id) AS r FROM v45_f'),
        F.map(r => r.id).reduce((a, b) => a | b)));
      t('V45B BIT_XOR', () => eq(one('SELECT BIT_XOR(id) AS r FROM v45_f'),
        F.map(r => r.id).reduce((a, b) => a ^ b)));
      t('V45B BOOL_AND', () => eq(one('SELECT BOOL_AND(id >= 0) AS r FROM v45_f'), true));
      t('V45B BOOL_AND finds a counterexample', () => eq(one('SELECT BOOL_AND(id > 0) AS r FROM v45_f'), false));
      t('V45B BOOL_OR', () => eq(one('SELECT BOOL_OR(id > 70) AS r FROM v45_f'), true));
      t('V45B BOOL_OR with no match', () => eq(one('SELECT BOOL_OR(id > 999) AS r FROM v45_f'), false));
      t('V45B MAX_BY', () => {
        const best = F.filter(r => r.v !== null).reduce((a, b) => b.v > a.v ? b : a);
        const got = one('SELECT MAX_BY(g, v) AS r FROM v45_f');
        const ties = F.filter(r => r.v === best.v).map(r => r.g);
        if (ties.indexOf(got) === -1) throw new Error(`${got} is not among ${ties}`);
        return true;
      });
      t('V45B MIN_BY', () => {
        const best = F.filter(r => r.v !== null).reduce((a, b) => b.v < a.v ? b : a);
        const got = one('SELECT MIN_BY(g, v) AS r FROM v45_f');
        const ties = F.filter(r => r.v === best.v).map(r => r.g);
        if (ties.indexOf(got) === -1) throw new Error(`${got} is not among ${ties}`);
        return true;
      });
      t('V45B PERCENTILE_CONT at the median', () => {
        const got = one('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v) AS r FROM v45_f');
        return eq(r4(got), r4(median(vs())));
      });
      t('V45B PERCENTILE_DISC at the median', () => {
        const a = vs().slice().sort((x, y) => x - y);
        const got = one('SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY v) AS r FROM v45_f');
        return eq(got, a[Math.ceil(0.5 * a.length) - 1]);
      });
      [0, 0.25, 0.5, 0.75, 1].forEach(p => {
        t(`V45B PERCENTILE_DISC at ${p}`, () => {
          const a = vs().slice().sort((x, y) => x - y);
          const idx = p === 0 ? 0 : Math.ceil(p * a.length) - 1;
          return eq(one(`SELECT PERCENTILE_DISC(${p}) WITHIN GROUP (ORDER BY v) AS r FROM v45_f`), a[idx]);
        });
      });
      t('V45B CORR of a column with itself is 1', () => eq(one('SELECT CORR(v, v) AS r FROM v45_f'), 1));
      t('V45B COVAR_POP of a column with itself is its variance', () =>
        eq(one('SELECT COVAR_POP(v, v) AS r FROM v45_f'), r4(varp(vs()))));
      t('V45B COVAR_SAMP of a column with itself is its sample variance', () =>
        eq(one('SELECT COVAR_SAMP(v, v) AS r FROM v45_f'), r4(vars(vs()))));
      t('V45B JSON_OBJECTAGG', () => {
        const got = one("SELECT JSON_OBJECTAGG(g, v) AS r FROM v45_f WHERE id < 4");
        const o = {};
        F.filter(r => r.id < 4).forEach(r => { o[r.g] = r.v; });
        return eq(got, JSON.stringify(o));
      });
      // 空集合
      const EMPTY_NULL = ['MIN','MAX','MEDIAN','STDDEV','STDDEV_POP','STDDEV_SAMP','VARIANCE','VAR_POP',
        'VAR_SAMP','GROUP_CONCAT','ARRAY_AGG','JSON_ARRAYAGG','ANY_VALUE','BIT_AND','BIT_OR','BIT_XOR',
        'MAX_BY','MIN_BY'];
      EMPTY_NULL.forEach(fn => {
        const args = (fn === 'MAX_BY' || fn === 'MIN_BY') ? 'v, v' : 'v';
        val(`V45B ${fn} over an empty table is NULL`, `SELECT ${fn}(${args}) AS r FROM v45_e`, null);
      });
      val('V45B COUNT over an empty table is 0', 'SELECT COUNT(v) AS r FROM v45_e', 0);
      val('V45B COUNT star over an empty table is 0', 'SELECT COUNT(*) AS r FROM v45_e', 0);
      val('V45B COUNT_IF over an empty table is 0', 'SELECT COUNT_IF(v > 0) AS r FROM v45_e', 0);
      // LuminaDB の取り決め: 空集合の SUM / AVG は 0（標準の NULL ではない）
      val('V45B SUM over an empty table is 0 by design', 'SELECT SUM(v) AS r FROM v45_e', 0);
      val('V45B AVG over an empty table is 0 by design', 'SELECT AVG(v) AS r FROM v45_e', 0);
      // すべて NULL の列
      t('V45B aggregates over an all-NULL column', () => {
        q('DROP TABLE IF EXISTS v45_n');
        q('CREATE TABLE v45_n (v INT)');
        q('INSERT INTO v45_n VALUES (NULL), (NULL), (NULL)');
        const c = one('SELECT COUNT(v) AS r FROM v45_n');
        const mx = one('SELECT MAX(v) AS r FROM v45_n');
        const ca = one('SELECT COUNT(*) AS r FROM v45_n');
        q('DROP TABLE IF EXISTS v45_n');
        return eq([c, mx, ca], [0, null, 3]);
      });
      // 1 行だけ
      t('V45B aggregates over a single row', () => {
        const got = rows('SELECT COUNT(*) AS c, SUM(v) AS s, AVG(v) AS a, MIN(v) AS mn, MAX(v) AS mx, ' +
                         'STDDEV_SAMP(v) AS ss FROM v45_f WHERE id = 0')[0];
        return eq(got, { c: 1, s: F[0].v, a: F[0].v, mn: F[0].v, mx: F[0].v, ss: null });
      });
      // DISTINCT つき
      t('V45B SUM DISTINCT', () => eq(one('SELECT SUM(DISTINCT v) AS r FROM v45_f'), sum([...new Set(vs())])));
      t('V45B AVG DISTINCT', () => eq(r4(one('SELECT AVG(DISTINCT v) AS r FROM v45_f')), r4(mean([...new Set(vs())]))));
      t('V45B COUNT DISTINCT over a text column', () => eq(one('SELECT COUNT(DISTINCT s) AS r FROM v45_f'), new Set(ss()).size));
      t('V45B GROUP_CONCAT DISTINCT', () => {
        const got = one('SELECT GROUP_CONCAT(DISTINCT s) AS r FROM v45_f');
        return eq(got.split(',').slice().sort(), [...new Set(ss())].slice().sort());
      });

      // ============================================================
      // C. 集約をグループごとに全件突き合わせ
      // ============================================================
      const byGroup = (pick) => {
        const m = new Map();
        F.forEach(r => { if (!m.has(r.g)) m.set(r.g, []); m.get(r.g).push(r); });
        return [...m.keys()].sort().map(g => ({ g, rows: m.get(g) })).map(pick);
      };
      const gcheck = (name, expr, ref) => t(name, () => {
        const got = rows(`SELECT g, ${expr} AS r FROM v45_f GROUP BY g ORDER BY g`);
        const want = byGroup(({ g, rows: rs }) => ({ g, r: ref(rs) }));
        return eq(got, want);
      });
      gcheck('V45C COUNT star per group', 'COUNT(*)', rs => rs.length);
      gcheck('V45C COUNT of a column per group', 'COUNT(v)', rs => rs.filter(r => r.v !== null).length);
      gcheck('V45C COUNT DISTINCT per group', 'COUNT(DISTINCT v)',
             rs => new Set(rs.filter(r => r.v !== null).map(r => r.v)).size);
      gcheck('V45C SUM per group', 'SUM(v)', rs => sum(rs.filter(r => r.v !== null).map(r => r.v)));
      gcheck('V45C MIN per group', 'MIN(v)', rs => Math.min(...rs.filter(r => r.v !== null).map(r => r.v)));
      gcheck('V45C MAX per group', 'MAX(v)', rs => Math.max(...rs.filter(r => r.v !== null).map(r => r.v)));
      gcheck('V45C AVG per group', 'ROUND(AVG(v), 4)',
             rs => r4(mean(rs.filter(r => r.v !== null).map(r => r.v))));
      gcheck('V45C MEDIAN per group', 'MEDIAN(v)', rs => median(rs.filter(r => r.v !== null).map(r => r.v)));
      gcheck('V45C VAR_POP per group', 'VAR_POP(v)', rs => r4(varp(rs.filter(r => r.v !== null).map(r => r.v))));
      gcheck('V45C VAR_SAMP per group', 'VAR_SAMP(v)', rs => r4(vars(rs.filter(r => r.v !== null).map(r => r.v))));
      gcheck('V45C STDDEV_POP per group', 'STDDEV_POP(v)',
             rs => r4(Math.sqrt(varp(rs.filter(r => r.v !== null).map(r => r.v)))));
      gcheck('V45C COUNT_IF per group', 'COUNT_IF(v > 0)',
             rs => rs.filter(r => r.v !== null && r.v > 0).length);
      gcheck('V45C BOOL_OR per group', 'BOOL_OR(v > 20)',
             rs => rs.some(r => r.v !== null && r.v > 20));
      gcheck('V45C BOOL_AND per group', 'BOOL_AND(v > -99)',
             rs => rs.filter(r => r.v !== null).every(r => r.v > -99));
      gcheck('V45C GROUP_CONCAT per group', 'GROUP_CONCAT(s)',
             rs => { const a = rs.filter(r => r.s !== null).map(r => r.s); return a.length ? a.join(',') : null; });
      gcheck('V45C ARRAY_AGG per group', 'ARRAY_AGG(v)', rs => JSON.stringify(rs.map(r => r.v)));
      gcheck('V45C SUM DISTINCT per group', 'SUM(DISTINCT v)',
             rs => sum([...new Set(rs.filter(r => r.v !== null).map(r => r.v))]));
      // HAVING を使った絞り込み
      t('V45C HAVING on a count', () => {
        const got = rows('SELECT g FROM v45_f GROUP BY g HAVING COUNT(*) > 19 ORDER BY g').map(r => r.g);
        const want = byGroup(({ g, rows: rs }) => rs.length > 19 ? g : null).filter(x => x !== null);
        return eq(got, want);
      });
      t('V45C HAVING on a sum', () => {
        const got = rows('SELECT g FROM v45_f GROUP BY g HAVING SUM(v) > 0 ORDER BY g').map(r => r.g);
        const want = byGroup(({ g, rows: rs }) => sum(rs.filter(r => r.v !== null).map(r => r.v)) > 0 ? g : null)
          .filter(x => x !== null);
        return eq(got, want);
      });

      // ============================================================
      // D. ウィンドウ関数 11 種
      // ============================================================
      const ordered = () => F.slice().sort((a, b) => a.id - b.id);
      t('V45D ROW_NUMBER over the whole table', () => {
        const got = rows('SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS r FROM v45_f ORDER BY id').map(r => r.r);
        return eq(got, ordered().map((_, i) => i + 1));
      });
      t('V45D RANK with ties', () => {
        const got = rows('SELECT id, RANK() OVER (ORDER BY g) AS r FROM v45_f ORDER BY id').map(r => r.r);
        const sorted = F.slice().sort((a, b) => a.g < b.g ? -1 : a.g > b.g ? 1 : 0);
        const rank = new Map();
        sorted.forEach((r, i) => { if (!rank.has(r.g)) rank.set(r.g, i + 1); });
        return eq(got, F.map(r => rank.get(r.g)));
      });
      t('V45D DENSE_RANK with ties', () => {
        const got = rows('SELECT id, DENSE_RANK() OVER (ORDER BY g) AS r FROM v45_f ORDER BY id').map(r => r.r);
        const gs = [...new Set(F.map(r => r.g))].sort();
        return eq(got, F.map(r => gs.indexOf(r.g) + 1));
      });
      t('V45D PERCENT_RANK spans 0 to 1', () => {
        const got = rows('SELECT PERCENT_RANK() OVER (ORDER BY id) AS r FROM v45_f ORDER BY id').map(r => r.r);
        return eq([got[0], got[got.length - 1]], [0, 1]);
      });
      t('V45D CUME_DIST ends at 1', () => {
        const got = rows('SELECT CUME_DIST() OVER (ORDER BY id) AS r FROM v45_f ORDER BY id').map(r => r.r);
        return eq(got[got.length - 1], 1);
      });
      [2, 4, 5, 8].forEach(n => t(`V45D NTILE(${n}) splits evenly`, () => {
        const got = rows(`SELECT NTILE(${n}) OVER (ORDER BY id) AS r FROM v45_f ORDER BY id`).map(r => r.r);
        const counts = new Map();
        got.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
        const sizes = [...counts.values()];
        return eq([counts.size, Math.max(...sizes) - Math.min(...sizes) <= 1],
                  [n, true]);
      }));
      [1, 2, 5].forEach(n => {
        t(`V45D LAG by ${n}`, () => {
          const got = rows(`SELECT id, LAG(id, ${n}) OVER (ORDER BY id) AS r FROM v45_f ORDER BY id`).map(r => r.r);
          const o = ordered().map(r => r.id);
          return eq(got, o.map((_, i) => i - n >= 0 ? o[i - n] : null));
        });
        t(`V45D LEAD by ${n}`, () => {
          const got = rows(`SELECT id, LEAD(id, ${n}) OVER (ORDER BY id) AS r FROM v45_f ORDER BY id`).map(r => r.r);
          const o = ordered().map(r => r.id);
          return eq(got, o.map((_, i) => i + n < o.length ? o[i + n] : null));
        });
        t(`V45D LAG by ${n} with a default`, () => {
          const got = rows(`SELECT id, LAG(id, ${n}, -1) OVER (ORDER BY id) AS r FROM v45_f ORDER BY id`).map(r => r.r);
          const o = ordered().map(r => r.id);
          return eq(got, o.map((_, i) => i - n >= 0 ? o[i - n] : -1));
        });
      });
      t('V45D FIRST_VALUE over the whole partition', () => {
        const got = rows('SELECT FIRST_VALUE(id) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS r FROM v45_f').map(r => r.r);
        return eq([...new Set(got)], [ordered()[0].id]);
      });
      t('V45D LAST_VALUE over the whole partition', () => {
        const got = rows('SELECT LAST_VALUE(id) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS r FROM v45_f').map(r => r.r);
        return eq([...new Set(got)], [ordered()[ordered().length - 1].id]);
      });
      [1, 3, 10].forEach(n => t(`V45D NTH_VALUE ${n}`, () => {
        const got = rows(`SELECT NTH_VALUE(id, ${n}) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS r FROM v45_f`).map(r => r.r);
        return eq([...new Set(got)], [ordered()[n - 1].id]);
      }));
      // 区画つき
      t('V45D ROW_NUMBER within each partition', () => {
        const got = rows('SELECT id, g, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) AS r FROM v45_f ORDER BY id');
        const seen = new Map();
        const want = ordered().map(r => { const n = (seen.get(r.g) || 0) + 1; seen.set(r.g, n); return { id: r.id, g: r.g, r: n }; });
        return eq(got, want);
      });
      t('V45D a running total within each partition', () => {
        const got = rows('SELECT id, SUM(id) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING) AS r FROM v45_f ORDER BY id').map(r => r.r);
        const acc = new Map();
        const want = ordered().map(r => { const a = (acc.get(r.g) || 0) + r.id; acc.set(r.g, a); return a; });
        return eq(got, want);
      });
      t('V45D a moving average of three rows', () => {
        const got = rows('SELECT id, AVG(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS r FROM v45_f ORDER BY id').map(r => r.r);
        const o = ordered().map(r => r.id);
        const want = o.map((_, i) => {
          const lo = Math.max(0, i - 1), hi = Math.min(o.length - 1, i + 1);
          const seg = o.slice(lo, hi + 1);
          return sum(seg) / seg.length;
        });
        return eq(got.map(r4), want.map(r4));
      });
      t('V45D QUALIFY keeps the first row of each partition', () => {
        const got = rows('SELECT id FROM v45_f QUALIFY ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) = 1 ORDER BY id').map(r => r.id);
        const first = new Map();
        ordered().forEach(r => { if (!first.has(r.g)) first.set(r.g, r.id); });
        return eq(got, [...first.values()].sort((a, b) => a - b));
      });

      // ============================================================
      // E. 条件と NULL の関数 17 種
      // ============================================================
      const FLOW = [
        ["COALESCE(NULL, NULL, 3)", 3], ["COALESCE(NULL, NULL)", null], ["COALESCE(1, 2)", 1],
        ["COALESCE(NULL, 'a', 'b')", 'a'],
        ["IFNULL(NULL, 5)", 5], ["IFNULL(1, 5)", 1], ["IFNULL(NULL, NULL)", null],
        ["ISNULL(NULL, 5)", 5], ["ISNULL(1, 5)", 1],
        ["NVL(NULL, 5)", 5], ["NVL(1, 5)", 1],
        ["NVL2(1, 'a', 'b')", 'a'], ["NVL2(NULL, 'a', 'b')", 'b'],
        ["NULLIF(1, 1)", null], ["NULLIF(1, 2)", 1], ["NULLIF('a', 'a')", null], ["NULLIF(NULL, 1)", null],
        ["NULLIFZERO(0)", null], ["NULLIFZERO(3)", 3], ["NULLIFZERO(NULL)", null],
        ["ZEROIFNULL(NULL)", 0], ["ZEROIFNULL(3)", 3],
        ["IF(1 > 0, 'y', 'n')", 'y'], ["IF(1 < 0, 'y', 'n')", 'n'], ["IF(NULL, 'y', 'n')", 'n'],
        ["IIF(1 > 0, 'y', 'n')", 'y'], ["IIF(1 < 0, 'y', 'n')", 'n'],
        ["DECODE(2, 1, 'a', 2, 'b', 'z')", 'b'], ["DECODE(9, 1, 'a', 2, 'b', 'z')", 'z'],
        ["DECODE(9, 1, 'a')", null], ["DECODE(1, 1, 'a')", 'a'],
        ["CHOOSE(1, 'a', 'b', 'c')", 'a'], ["CHOOSE(3, 'a', 'b', 'c')", 'c'],
        ["CHOOSE(0, 'a', 'b')", null], ["CHOOSE(9, 'a', 'b')", null],
        ["CAST('12' AS INT)", 12], ["TRY_CAST('x' AS INT)", null],
        ["CONVERT('12', INT)", 12], ["TRY_CONVERT(INT, 'x')", null],
      ];
      FLOW.forEach(([e, w]) => val(`V45E ${e}`, `SELECT ${e} AS r`, w));
      // CASE の両形
      const CASES = [
        ["CASE WHEN 1 > 0 THEN 'y' ELSE 'n' END", 'y'],
        ["CASE WHEN 1 < 0 THEN 'y' ELSE 'n' END", 'n'],
        ["CASE WHEN 1 < 0 THEN 'y' END", null],
        ["CASE WHEN NULL THEN 'y' ELSE 'n' END", 'n'],
        ["CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' END", 'b'],
        ["CASE 9 WHEN 1 THEN 'a' WHEN 2 THEN 'b' END", null],
        ["CASE 9 WHEN 1 THEN 'a' ELSE 'z' END", 'z'],
        ["CASE NULL WHEN NULL THEN 'a' ELSE 'z' END", 'z'],
        ["CASE WHEN 0 = 1 THEN 'a' WHEN 1 = 1 THEN 'b' ELSE 'c' END", 'b'],
      ];
      CASES.forEach(([e, w]) => val(`V45E ${e}`, `SELECT ${e} AS r`, w));
      // 深く入れ子にした CASE
      t('V45E twenty nested CASE expressions', () => {
        let e = "'z'";
        for (let i = 0; i < 20; i++) e = `CASE WHEN ${i} > 100 THEN 'x' ELSE ${e} END`;
        return eq(one(`SELECT ${e} AS r`), 'z');
      });
      t('V45E a CASE with forty branches', () => {
        const parts = [];
        for (let i = 0; i < 40; i++) parts.push(`WHEN ${i} THEN '${i}'`);
        return eq(one(`SELECT CASE 37 ${parts.join(' ')} ELSE 'none' END AS r`), '37');
      });
      // 三値論理
      const TRI = [
        ['NULL IS NULL', true], ['NULL IS NOT NULL', false],
        ['1 = NULL', null], ['NULL = NULL', null], ['NULL <> NULL', null],
        ['NULL AND 1 = 1', null], ['NULL AND 1 = 0', false],
        ['NULL OR 1 = 1', true], ['NULL OR 1 = 0', null],
        // IS NULL は NOT より強く結合するので NOT (NULL IS NULL) = NOT TRUE = FALSE
        ['NOT NULL IS NULL', false],
        ['NOT (NULL IS NULL)', false],
        ['NOT (1 = NULL)', null],
        ['NOT (1 = 1)', false],
        ['1 IS DISTINCT FROM NULL', true], ['NULL IS DISTINCT FROM NULL', false],
        ['1 IS NOT DISTINCT FROM 1', true], ['NULL IS NOT DISTINCT FROM NULL', true],
      ];
      TRI.forEach(([e, w]) => val(`V45E ${e}`, `SELECT ${e} AS r`, w));
      // 列に対して
      t('V45E COALESCE over a column', () => {
        const got = rows('SELECT id, COALESCE(v, -999) AS r FROM v45_f ORDER BY id').map(r => r.r);
        return eq(got, F.map(r => r.v === null ? -999 : r.v));
      });
      t('V45E NULLIF over a column', () => {
        const got = rows('SELECT id, NULLIF(g, \'A\') AS r FROM v45_f ORDER BY id').map(r => r.r);
        return eq(got, F.map(r => r.g === 'A' ? null : r.g));
      });
      t('V45E CASE over a column', () => {
        const got = rows("SELECT id, CASE WHEN v IS NULL THEN 'none' WHEN v > 0 THEN 'pos' ELSE 'nonpos' END AS r FROM v45_f ORDER BY id").map(r => r.r);
        return eq(got, F.map(r => r.v === null ? 'none' : r.v > 0 ? 'pos' : 'nonpos'));
      });

      // ============================================================
      // F. メタ関数 14 種
      // ============================================================
      ['VERSION()', 'DATABASE()', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'SUSER_NAME()',
       'USER()', 'CURRENT_SCHEMA()', 'SCHEMA_NAME()'].forEach(e => {
        val(`V45F ${e} is not NULL`, `SELECT ${e} IS NOT NULL AS r`, true);
        val(`V45F ${e} is text`, `SELECT TYPEOF(${e}) AS r`, 'text');
      });
      val('V45F UUID is 36 characters', 'SELECT LENGTH(UUID()) AS r', 36);
      val('V45F NEWID is 36 characters', 'SELECT LENGTH(NEWID()) AS r', 36);
      val('V45F SYS_GUID is 32 characters', 'SELECT LENGTH(SYS_GUID()) AS r', 32);
      t('V45F UUID differs each call', () => {
        const a = new Set();
        for (let i = 0; i < 30; i++) a.add(one('SELECT UUID() AS r'));
        return eq(a.size, 30);
      });
      val('V45F UUID has the canonical shape',
          "SELECT REGEXP_LIKE(UUID(), '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS r", 1);
      [['1', 'integer'], ["'a'", 'text'], ['1.5', 'real'], ['NULL', 'null'], ['TRUE', 'boolean']]
        .forEach(([v, w]) => val(`V45F TYPEOF(${v})`, `SELECT TYPEOF(${v}) AS r`, w));
      t('V45F LAST_INSERT_ID follows an insert', () => {
        q('DROP TABLE IF EXISTS v45_ai');
        q('CREATE TABLE v45_ai (id INT PRIMARY KEY AUTO_INCREMENT, x INT)');
        q('INSERT INTO v45_ai (x) VALUES (1)');
        const a = one('SELECT LAST_INSERT_ID() AS r');
        q('INSERT INTO v45_ai (x) VALUES (2)');
        const b = one('SELECT LAST_INSERT_ID() AS r');
        q('DROP TABLE IF EXISTS v45_ai');
        return eq([a, b], [1, 2]);
      });

      // ============================================================
      // G. シーケンス 3 種
      // ============================================================
      t('V45G a sequence advances by its increment', () => {
        q('DROP SEQUENCE IF EXISTS v45_s1');
        q('CREATE SEQUENCE v45_s1 START WITH 5 INCREMENT BY 2');
        const got = [one("SELECT NEXTVAL('v45_s1') AS r"), one("SELECT NEXTVAL('v45_s1') AS r"),
                     one("SELECT NEXTVAL('v45_s1') AS r"), one("SELECT CURRVAL('v45_s1') AS r")];
        q('DROP SEQUENCE IF EXISTS v45_s1');
        return eq(got, [5, 7, 9, 9]);
      });
      t('V45G SETVAL moves the sequence', () => {
        q('DROP SEQUENCE IF EXISTS v45_s2');
        q('CREATE SEQUENCE v45_s2 START WITH 1 INCREMENT BY 1');
        one("SELECT NEXTVAL('v45_s2') AS r");
        const set = one("SELECT SETVAL('v45_s2', 100) AS r");
        const nxt = one("SELECT NEXTVAL('v45_s2') AS r");
        q('DROP SEQUENCE IF EXISTS v45_s2');
        return eq([set, nxt], [100, 101]);
      });
      t('V45G a descending sequence', () => {
        q('DROP SEQUENCE IF EXISTS v45_s3');
        q('CREATE SEQUENCE v45_s3 START WITH 10 INCREMENT BY -3');
        const got = [one("SELECT NEXTVAL('v45_s3') AS r"), one("SELECT NEXTVAL('v45_s3') AS r"),
                     one("SELECT NEXTVAL('v45_s3') AS r")];
        q('DROP SEQUENCE IF EXISTS v45_s3');
        return eq(got, [10, 7, 4]);
      });
      t('V45G a cycling sequence wraps around', () => {
        q('DROP SEQUENCE IF EXISTS v45_s4');
        q('CREATE SEQUENCE v45_s4 START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 3 CYCLE');
        const got = [];
        for (let i = 0; i < 5; i++) got.push(one("SELECT NEXTVAL('v45_s4') AS r"));
        q('DROP SEQUENCE IF EXISTS v45_s4');
        return eq(got, [1, 2, 3, 1, 2]);
      });
      t('V45G a sequence feeds an INSERT', () => {
        q('DROP SEQUENCE IF EXISTS v45_s5'); q('DROP TABLE IF EXISTS v45_st');
        q('CREATE SEQUENCE v45_s5 START WITH 100 INCREMENT BY 10');
        q('CREATE TABLE v45_st (id INT, note TEXT)');
        for (let i = 0; i < 3; i++) q(`INSERT INTO v45_st VALUES (NEXTVAL('v45_s5'), 'x')`);
        const got = rows('SELECT id FROM v45_st ORDER BY id').map(r => r.id);
        q('DROP TABLE IF EXISTS v45_st'); q('DROP SEQUENCE IF EXISTS v45_s5');
        return eq(got, [100, 110, 120]);
      });
      err('V45G NEXTVAL on a missing sequence', "SELECT NEXTVAL('v45_nosuch') AS r");

      // ============================================================
      // H. FILTER / WITHIN GROUP / DISTINCT の組み合わせ
      // ============================================================
      t('V45H FILTER narrows an aggregate', () => {
        const got = one('SELECT COUNT(*) FILTER (WHERE v > 0) AS r FROM v45_f');
        return eq(got, F.filter(r => r.v !== null && r.v > 0).length);
      });
      t('V45H two FILTERs in one query', () => {
        const got = rows('SELECT COUNT(*) FILTER (WHERE v > 0) AS a, COUNT(*) FILTER (WHERE v < 0) AS b FROM v45_f')[0];
        return eq(got, { a: F.filter(r => r.v !== null && r.v > 0).length,
                         b: F.filter(r => r.v !== null && r.v < 0).length });
      });
      t('V45H FILTER with GROUP BY', () => {
        const got = rows('SELECT g, SUM(v) FILTER (WHERE v > 0) AS r FROM v45_f GROUP BY g ORDER BY g');
        const want = byGroup(({ g, rows: rs }) => ({ g, r: sum(rs.filter(r => r.v !== null && r.v > 0).map(r => r.v)) }));
        return eq(got, want);
      });
      t('V45H FILTER inside an expression', () => {
        const got = one('SELECT COUNT(*) FILTER (WHERE v > 0) + 1000 AS r FROM v45_f');
        return eq(got, F.filter(r => r.v !== null && r.v > 0).length + 1000);
      });
      t('V45H WITHIN GROUP per group', () => {
        const got = rows('SELECT g, PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY v) AS r FROM v45_f GROUP BY g ORDER BY g');
        const want = byGroup(({ g, rows: rs }) => {
          const a = rs.filter(r => r.v !== null).map(r => r.v).sort((x, y) => x - y);
          return { g, r: a[Math.ceil(0.5 * a.length) - 1] };
        });
        return eq(got, want);
      });
      t('V45H LISTAGG WITHIN GROUP orders the values', () => {
        const got = one("SELECT LISTAGG(s, ',') WITHIN GROUP (ORDER BY s) AS r FROM v45_f WHERE g = 'A'");
        const want = F.filter(r => r.g === 'A' && r.s !== null).map(r => r.s).sort().join(',');
        return eq(got, want);
      });
      t('V45H an aggregate over a window', () => {
        const got = rows('SELECT g, SUM(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS r FROM v45_f GROUP BY g ORDER BY g').map(r => r.r);
        let acc = 0;
        const want = byGroup(({ rows: rs }) => { acc += sum(rs.filter(r => r.v !== null).map(r => r.v)); return acc; });
        return eq(got, want);
      });

      // ============================================================
      // I. 誤った用法は拒否される
      // ============================================================
      ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'MEDIAN', 'STDDEV', 'VARIANCE', 'ARRAY_AGG',
       'BIT_AND', 'BOOL_OR', 'ANY_VALUE', 'COUNT_IF'].forEach(fn => {
        err(`V45I ${fn} with two arguments`, `SELECT ${fn}(v, 1) AS r FROM v45_f`, 'exactly 1 argument');
      });
      err('V45I an aggregate inside another aggregate', 'SELECT SUM(SUM(v)) AS r FROM v45_f');
      err('V45I an aggregate in WHERE', 'SELECT id FROM v45_f WHERE SUM(v) > 0');
      err('V45I a window function in WHERE', 'SELECT id FROM v45_f WHERE ROW_NUMBER() OVER (ORDER BY id) = 1');
      err('V45I NTILE with no argument', 'SELECT NTILE() OVER (ORDER BY id) AS r FROM v45_f', 'takes 1 argument');
      err('V45I NTH_VALUE with one argument',
          'SELECT NTH_VALUE(id) OVER (ORDER BY id) AS r FROM v45_f', 'takes 2 argument');
      err('V45I FIRST_VALUE with no argument',
          'SELECT FIRST_VALUE() OVER (ORDER BY id) AS r FROM v45_f', 'takes 1 argument');
      err('V45I LAG without a window', 'SELECT LAG(id) AS r FROM v45_f', 'requires an OVER clause');
      err('V45I ROW_NUMBER without a window', 'SELECT ROW_NUMBER() AS r FROM v45_f', 'requires an OVER clause');
      err('V45I RANK without a window', 'SELECT RANK() AS r FROM v45_f', 'requires an OVER clause');
      err('V45I NTILE without a window', 'SELECT NTILE(4) AS r FROM v45_f', 'requires an OVER clause');
      err('V45I JSON_EXTRACT with one argument', `SELECT JSON_EXTRACT(${J}) AS r`, 'parameter count');
      err('V45I JSON_VALID with two arguments', `SELECT JSON_VALID(${J}, '$') AS r`, 'parameter count');
      err('V45I NVL2 with two arguments', 'SELECT NVL2(1, 2) AS r', 'parameter count');
      err('V45I COALESCE with no arguments', 'SELECT COALESCE() AS r');
      err('V45I PERCENTILE_CONT without WITHIN GROUP', 'SELECT PERCENTILE_CONT(0.5) AS r FROM v45_f');
      err('V45I an unsupported window function', 'SELECT UPPER(s) OVER (ORDER BY id) AS r FROM v45_f');
      err('V45I DISTINCT inside a window function',
          'SELECT SUM(DISTINCT v) OVER (ORDER BY id) AS r FROM v45_f', 'distinct is not supported');
      // 意図的に寛容な箇所（実DBの方言差を吸収するため受け入れている）
      val('V45I a non-grouped column is allowed with an aggregate the MySQL way',
          'SELECT COUNT(*) AS c FROM (SELECT id, COUNT(*) AS n FROM v45_f GROUP BY g) z', 4);
      val('V45I an unparsable JSON path yields NULL rather than an error',
          `SELECT JSON_EXTRACT(${J}, 'not a path') AS r`, null);
      val('V45I a CASE with only ELSE is accepted', "SELECT CASE ELSE 'x' END AS r", 'x');

      // ============================================================
      // J. 集約 × 絞り込み × まとめ方 の総当たり
      //    「同じ集計を、絞り込みと GROUP BY を変えても模型と一致するか」
      // ============================================================
      const PREDS = [
        ['1 = 1', () => true],
        ['v > 0', r => r.v !== null && r.v > 0],
        ['v <= 0', r => r.v !== null && r.v <= 0],
        ['v IS NOT NULL', r => r.v !== null],
        ['id % 2 = 0', r => r.id % 2 === 0],
        ["g IN ('A', 'B')", r => r.g === 'A' || r.g === 'B'],
        ['w IS NULL', r => r.w === null],
        ['id > 40 AND v IS NOT NULL', r => r.id > 40 && r.v !== null],
      ];
      const AGGS = [
        ['COUNT(*)', rs => rs.length],
        ['COUNT(v)', rs => rs.filter(r => r.v !== null).length],
        ['COUNT(DISTINCT v)', rs => new Set(rs.filter(r => r.v !== null).map(r => r.v)).size],
        ['SUM(v)', rs => sum(rs.filter(r => r.v !== null).map(r => r.v))],
        ['MIN(v)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? Math.min(...a) : null; }],
        ['MAX(v)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? Math.max(...a) : null; }],
        ['ROUND(AVG(v), 4)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? r4(mean(a)) : 0; }],
        ['MEDIAN(v)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? median(a) : null; }],
        ['COUNT_IF(v > 5)', rs => rs.filter(r => r.v !== null && r.v > 5).length],
        ['BOOL_OR(v > 20)', rs => rs.length ? rs.some(r => r.v !== null && r.v > 20) : null],
        ['BOOL_AND(v > -99)', rs => { const a = rs.filter(r => r.v !== null); return rs.length ? a.every(r => r.v > -99) : null; }],
        ['SUM(DISTINCT v)', rs => sum([...new Set(rs.filter(r => r.v !== null).map(r => r.v))])],
        ['VAR_POP(v)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? r4(varp(a)) : null; }],
        ['STDDEV_POP(v)', rs => { const a = rs.filter(r => r.v !== null).map(r => r.v); return a.length ? r4(Math.sqrt(varp(a))) : null; }],
        ['COUNT(DISTINCT g)', rs => new Set(rs.map(r => r.g)).size],
        ['SUM(id)', rs => sum(rs.map(r => r.id))],
      ];
      PREDS.forEach(([pSql, pFn]) => {
        const kept = () => F.filter(pFn);
        AGGS.forEach(([aSql, aFn]) => {
          // 表全体で集計
          t(`V45J ${aSql} WHERE ${pSql}`, () =>
            eq(one(`SELECT ${aSql} AS r FROM v45_f WHERE ${pSql}`), aFn(kept())));
          // グループごと
          t(`V45J ${aSql} WHERE ${pSql} GROUP BY g`, () => {
            const got = rows(`SELECT g, ${aSql} AS r FROM v45_f WHERE ${pSql} GROUP BY g ORDER BY g`);
            const m = new Map();
            kept().forEach(r => { if (!m.has(r.g)) m.set(r.g, []); m.get(r.g).push(r); });
            const want = [...m.keys()].sort().map(g => ({ g, r: aFn(m.get(g)) }));
            return eq(got, want);
          });
          // 2 列でまとめる
          t(`V45J ${aSql} WHERE ${pSql} GROUP BY g, id % 3`, () => {
            const got = rows(`SELECT g, id % 3 AS k, ${aSql} AS r FROM v45_f WHERE ${pSql} GROUP BY g, id % 3 ORDER BY g, k`);
            const m = new Map();
            kept().forEach(r => { const key = r.g + '\0' + (r.id % 3);
              if (!m.has(key)) m.set(key, []); m.get(key).push(r); });
            const want = [...m.keys()].sort().map(key => {
              const [g, k] = key.split('\0');
              return { g, k: Number(k), r: aFn(m.get(key)) };
            });
            return eq(got, want);
          });
        });
      });

      // ============================================================
      // K. ウィンドウ集計 × フレーム の総当たり（毎回 80 行すべてを突き合わせる）
      // ============================================================
      const FRAMES = [
        ['ROWS UNBOUNDED PRECEDING', (i) => [0, i]],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', (i) => [0, i]],
        ['ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', (i, n) => [0, n - 1]],
        ['ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING', (i, n) => [i, n - 1]],
        ['ROWS BETWEEN 1 PRECEDING AND CURRENT ROW', (i) => [Math.max(0, i - 1), i]],
        ['ROWS BETWEEN 2 PRECEDING AND CURRENT ROW', (i) => [Math.max(0, i - 2), i]],
        ['ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING', (i, n) => [Math.max(0, i - 1), Math.min(n - 1, i + 1)]],
        ['ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING', (i, n) => [Math.max(0, i - 3), Math.min(n - 1, i + 3)]],
        ['ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING', (i, n) => [i, Math.min(n - 1, i + 2)]],
        ['ROWS BETWEEN CURRENT ROW AND CURRENT ROW', (i) => [i, i]],
        ['ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING', (i) => [Math.max(0, i - 5), i - 1]],
        ['ROWS BETWEEN 1 FOLLOWING AND 5 FOLLOWING', (i, n) => [i + 1, Math.min(n - 1, i + 5)]],
      ];
      const WAGGS = [
        ['SUM', a => a.length ? sum(a) : null],
        ['COUNT', a => a.length],
        ['MIN', a => a.length ? Math.min(...a) : null],
        ['MAX', a => a.length ? Math.max(...a) : null],
        ['AVG', a => a.length ? mean(a) : null],
      ];
      const PARTS_W = [
        ['', () => 'ALL'],
        ['PARTITION BY g ', r => r.g],
        ['PARTITION BY id % 3 ', r => String(r.id % 3)],
      ];
      PARTS_W.forEach(([pSql, pKey]) => FRAMES.forEach(([fSql, fRange]) => WAGGS.forEach(([fn, ref]) => {
        t(`V45K ${fn} OVER (${pSql}ORDER BY id ${fSql})`, () => {
          const got = rows(`SELECT id, ${fn}(id) OVER (${pSql}ORDER BY id ${fSql}) AS r FROM v45_f ORDER BY id`).map(x => x.r);
          // 模型: 区画ごとに id 昇順で並べ、フレームの範囲を切り出して集計する
          const parts = new Map();
          ordered().forEach(r => { const k = pKey(r); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(r.id); });
          const at = new Map();
          parts.forEach((ids) => {
            ids.forEach((idv, i) => {
              const [lo, hi] = fRange(i, ids.length);
              const seg = (lo > hi || lo >= ids.length || hi < 0) ? [] : ids.slice(Math.max(0, lo), hi + 1);
              at.set(idv, ref(seg));
            });
          });
          const want = ordered().map(r => at.get(r.id));
          return eq(got.map(x => (typeof x === 'number' && !Number.isInteger(x)) ? r4(x) : x),
                    want.map(x => (typeof x === 'number' && !Number.isInteger(x)) ? r4(x) : x));
        });
      })));

      // ============================================================
      // L. JSON パス × 文書 の総当たり
      // ============================================================
      const DOCS = [
        `'{"a":1,"b":{"c":2},"d":[1,2,3]}'`,
        `'{"a":"x","b":{"c":null},"d":[]}'`,
        `'[10,20,{"k":1}]'`,
        `'{"n":{"m":{"o":7}}}'`,
        `'{}'`,
        `'[]'`,
      ];
      const PATHS = ['$', '$.a', '$.b', '$.b.c', '$.d', '$.d[0]', '$.d[2]', '$.zz',
                     '$[0]', '$[2]', '$.n', '$.n.m', '$.n.m.o'];
      DOCS.forEach((doc, di) => PATHS.forEach(p => {
        // 期待値は JavaScript 側で同じ経路をたどって求める
        t(`V45L JSON_EXTRACT(doc${di}, '${p}')`, () => {
          const obj = JSON.parse(doc.slice(1, -1));
          let cur = obj, ok = true;
          if (p !== '$') {
            const steps = p.slice(1).replace(/\[(\d+)\]/g, '.$1').split('.').filter(x => x !== '');
            for (const st of steps) {
              if (cur === null || cur === undefined || typeof cur !== 'object') { ok = false; break; }
              const key = /^\d+$/.test(st) ? Number(st) : st;
              if (!(key in cur)) { ok = false; break; }
              cur = cur[key];
            }
          }
          const want = !ok ? null
            : (cur === null ? null
               : (typeof cur === 'object' ? JSON.stringify(cur) : cur));
          return eq(one(`SELECT JSON_EXTRACT(${doc}, '${p}') AS r`), want);
        });
        t(`V45L JSON_CONTAINS_PATH(doc${di}, 'one', '${p}')`, () => {
          const obj = JSON.parse(doc.slice(1, -1));
          let cur = obj, ok = true;
          if (p !== '$') {
            const steps = p.slice(1).replace(/\[(\d+)\]/g, '.$1').split('.').filter(x => x !== '');
            for (const st of steps) {
              if (cur === null || cur === undefined || typeof cur !== 'object') { ok = false; break; }
              const key = /^\d+$/.test(st) ? Number(st) : st;
              if (!(key in cur)) { ok = false; break; }
              cur = cur[key];
            }
          }
          return eq(one(`SELECT JSON_CONTAINS_PATH(${doc}, 'one', '${p}') AS r`), ok ? 1 : 0);
        });
      }));
      DOCS.forEach((doc, di) => {
        const obj = JSON.parse(doc.slice(1, -1));
        val(`V45L JSON_VALID(doc${di})`, `SELECT JSON_VALID(${doc}) AS r`, 1);
        val(`V45L JSON_TYPE(doc${di})`, `SELECT JSON_TYPE(${doc}) AS r`, Array.isArray(obj) ? 'ARRAY' : 'OBJECT');
        val(`V45L JSON_LENGTH(doc${di})`, `SELECT JSON_LENGTH(${doc}) AS r`,
            Array.isArray(obj) ? obj.length : Object.keys(obj).length);
        val(`V45L JSON_KEYS(doc${di})`, `SELECT JSON_KEYS(${doc}) AS r`,
            Array.isArray(obj) ? null : JSON.stringify(Object.keys(obj)));
      });

      // ============================================================
      // M. 条件・NULL 関数 × 入力の総当たり
      // ============================================================
      const INPUTS = ['NULL', '0', '1', '-1', "''", "'a'", 'TRUE', 'FALSE'];
      const jsVal = (s) => s === 'NULL' ? null : s === 'TRUE' ? true : s === 'FALSE' ? false
        : s === "''" ? '' : s === "'a'" ? 'a' : Number(s);
      INPUTS.forEach(a => INPUTS.forEach(b => {
        const av = jsVal(a), bv = jsVal(b);
        val(`V45M COALESCE(${a}, ${b})`, `SELECT COALESCE(${a}, ${b}) AS r`, av === null ? bv : av);
        val(`V45M IFNULL(${a}, ${b})`, `SELECT IFNULL(${a}, ${b}) AS r`, av === null ? bv : av);
        val(`V45M NVL(${a}, ${b})`, `SELECT NVL(${a}, ${b}) AS r`, av === null ? bv : av);
        val(`V45M ISNULL(${a}, ${b})`, `SELECT ISNULL(${a}, ${b}) AS r`, av === null ? bv : av);
      }));
      INPUTS.forEach(a => {
        val(`V45M NVL2(${a}, 'y', 'n')`, `SELECT NVL2(${a}, 'y', 'n') AS r`, jsVal(a) === null ? 'n' : 'y');
        val(`V45M ZEROIFNULL(${a})`, `SELECT ZEROIFNULL(${a}) AS r`, jsVal(a) === null ? 0 : jsVal(a));
        val(`V45M ${a} IS NULL`, `SELECT ${a} IS NULL AS r`, jsVal(a) === null);
        val(`V45M ${a} IS NOT NULL`, `SELECT ${a} IS NOT NULL AS r`, jsVal(a) !== null);
      });
      // IS DISTINCT FROM は NULL 同士を等しいとみなす
      INPUTS.forEach(a => INPUTS.forEach(b => {
        const av = jsVal(a), bv = jsVal(b);
        const same = (av === null && bv === null) ? true
          : (av === null || bv === null) ? false : av === bv;
        val(`V45M ${a} IS NOT DISTINCT FROM ${b}`,
            `SELECT ${a} IS NOT DISTINCT FROM ${b} AS r`, same);
      }));

      // ============================================================
      // 片付け
      // ============================================================
      t('V45Zz cleanup', () => {
        ['v45_f', 'v45_e', 'v45_j', 'v45_n', 'v45_ai', 'v45_st'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        ['v45_s1', 'v45_s2', 'v45_s3', 'v45_s4', 'v45_s5'].forEach(n => q('DROP SEQUENCE IF EXISTS ' + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v45_') === 0).length === 0;
      });

      return T;
    }
