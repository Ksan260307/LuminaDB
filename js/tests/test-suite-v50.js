    // ============================================================================
    // [Test Suite v50] - コマンド全網羅（補遺）: スカラー式の総当たり
    //
    //   すべての層の土台になる「式の評価」を、演算子・被演算子・NULL の組み合わせで
    //   総当たりする。期待値は JavaScript 側で同じ規則を組んで求める。
    //
    //     A. 算術演算子 × 被演算子の全組み合わせ
    //     B. 比較演算子 × 被演算子の全組み合わせ（三値論理）
    //     C. 文字列の比較と連結
    //     D. CASE 式の全分岐
    //     E. NULL を含む式の伝播
    //     F. 演算子の結合順序
    //     G. 入れ子にした式
    //     H. 列に対して同じ式を評価する
    //
    //   test-suite.js の tests 配列へ getV50Tests() のスプレッドで合流する
    // ============================================================================
    function getV50Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };
      const val = (name, sql, want) => t(name, () => eq(one(sql), want));
      // 浮動小数は下位桁の丸め方が両側で揃わないので、比較前に同じ桁で丸める
      const valN = (name, sql, want) => t(name, () => eq(r9(one(sql)), r9(want)));
      // 非有限は NULL に揃える（engine と同じ取り決め）
      const fin = (v) => (typeof v === 'number' && !isFinite(v)) ? null : v;
      const r9 = (v) => (typeof v === 'number' && !Number.isInteger(v)) ? Math.round(v * 1e9) / 1e9 : v;

      // ============================================================
      // A. 算術演算子 × 被演算子
      // ============================================================
      const NUMS = ['0', '1', '-1', '2', '-2', '7', '-7', '2.5', '-2.5', '100', '0.5', 'NULL'];
      const nv = (s) => s === 'NULL' ? null : Number(s);
      const AOPS = [
        ['+', (a, b) => a + b],
        ['-', (a, b) => a - b],
        ['*', (a, b) => a * b],
        ['/', (a, b) => b === 0 ? null : a / b],
        ['%', (a, b) => b === 0 ? null : a % b],
      ];
      AOPS.forEach(([op, ref]) => NUMS.forEach(a => NUMS.forEach(b => {
        const av = nv(a), bv = nv(b);
        const want = (av === null || bv === null) ? null : fin(ref(av, bv));
        valN(`V50A ${a} ${op} ${b}`, `SELECT ${a} ${op} ${b} AS r`, want);
      })));
      // 単項マイナス
      NUMS.forEach(a => {
        const av = nv(a);
        val(`V50A -(${a})`, `SELECT -(${a}) AS r`, av === null ? null : -av);
      });

      // ============================================================
      // B. 比較演算子 × 被演算子（三値論理）
      // ============================================================
      const COPS = [
        ['=', (a, b) => a === b],
        ['<>', (a, b) => a !== b],
        ['!=', (a, b) => a !== b],
        ['<', (a, b) => a < b],
        ['<=', (a, b) => a <= b],
        ['>', (a, b) => a > b],
        ['>=', (a, b) => a >= b],
      ];
      const CNUMS = ['0', '1', '-1', '2.5', '100', 'NULL'];
      COPS.forEach(([op, ref]) => CNUMS.forEach(a => CNUMS.forEach(b => {
        const av = nv(a), bv = nv(b);
        const want = (av === null || bv === null) ? null : ref(av, bv);
        val(`V50B ${a} ${op} ${b}`, `SELECT ${a} ${op} ${b} AS r`, want);
      })));
      // IS NULL / IS NOT NULL
      NUMS.forEach(a => {
        val(`V50B ${a} IS NULL`, `SELECT ${a} IS NULL AS r`, nv(a) === null);
        val(`V50B ${a} IS NOT NULL`, `SELECT ${a} IS NOT NULL AS r`, nv(a) !== null);
      });
      // IS DISTINCT FROM は NULL 同士を等しいとみなす
      CNUMS.forEach(a => CNUMS.forEach(b => {
        const av = nv(a), bv = nv(b);
        const same = (av === null && bv === null) ? true : (av === null || bv === null) ? false : av === bv;
        val(`V50B ${a} IS DISTINCT FROM ${b}`, `SELECT ${a} IS DISTINCT FROM ${b} AS r`, !same);
        val(`V50B ${a} IS NOT DISTINCT FROM ${b}`, `SELECT ${a} IS NOT DISTINCT FROM ${b} AS r`, same);
      }));
      // BETWEEN
      CNUMS.forEach(a => {
        const av = nv(a);
        [[0, 10], [-5, 5], [1, 1], [10, 0]].forEach(([lo, hi]) => {
          const want = av === null ? null : (av >= lo && av <= hi);
          val(`V50B ${a} BETWEEN ${lo} AND ${hi}`, `SELECT ${a} BETWEEN ${lo} AND ${hi} AS r`, want);
        });
      });
      // IN
      CNUMS.forEach(a => {
        const av = nv(a);
        [['(0, 1, 2)', [0, 1, 2]], ['(100)', [100]], ['(-1, 2.5)', [-1, 2.5]]].forEach(([listSql, list]) => {
          const want = av === null ? null : list.indexOf(av) !== -1;
          val(`V50B ${a} IN ${listSql}`, `SELECT ${a} IN ${listSql} AS r`, want);
          val(`V50B ${a} NOT IN ${listSql}`, `SELECT ${a} NOT IN ${listSql} AS r`,
              want === null ? null : !want);
        });
      });

      // ============================================================
      // C. 文字列の比較と連結
      // ============================================================
      const STRS = ["''", "'a'", "'b'", "'ab'", "'A'", "'abc'", 'NULL'];
      const sv = (s) => s === 'NULL' ? null : s.slice(1, -1);
      COPS.forEach(([op, ref]) => STRS.forEach(a => STRS.forEach(b => {
        const av = sv(a), bv = sv(b);
        const want = (av === null || bv === null) ? null : ref(av, bv);
        val(`V50C ${a} ${op} ${b}`, `SELECT ${a} ${op} ${b} AS r`, want);
      })));
      STRS.forEach(a => STRS.forEach(b => {
        const av = sv(a), bv = sv(b);
        const want = (av === null || bv === null) ? null : av + bv;
        val(`V50C ${a} || ${b}`, `SELECT ${a} || ${b} AS r`, want);
      }));
      // LIKE（大文字小文字を区別しない）
      const PATS = ["'a'", "'a%'", "'%b'", "'%a%'", "'_'", "'__'", "'%'"];
      const likeRe = (p) => {
        let out = '^';
        for (const ch of p) {
          if (ch === '%') out += '[\\s\\S]*';
          else if (ch === '_') out += '[\\s\\S]';
          else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(out + '$', 'i');
      };
      STRS.forEach(a => PATS.forEach(p => {
        const av = sv(a);
        const want = av === null ? null : likeRe(sv(p)).test(av);
        val(`V50C ${a} LIKE ${p}`, `SELECT ${a} LIKE ${p} AS r`, want);
        val(`V50C ${a} NOT LIKE ${p}`, `SELECT ${a} NOT LIKE ${p} AS r`, want === null ? null : !want);
      }));

      // ============================================================
      // D. CASE 式の全分岐
      // ============================================================
      const BOOLS = ['1 = 1', '1 = 0', 'NULL = 1'];
      const bval = (s) => s === '1 = 1' ? true : s === '1 = 0' ? false : null;
      BOOLS.forEach(c1 => BOOLS.forEach(c2 => {
        const want = bval(c1) === true ? 'x' : (bval(c2) === true ? 'y' : 'z');
        val(`V50D CASE WHEN ${c1} THEN x WHEN ${c2} THEN y ELSE z END`,
            `SELECT CASE WHEN ${c1} THEN 'x' WHEN ${c2} THEN 'y' ELSE 'z' END AS r`, want);
        const wantNoElse = bval(c1) === true ? 'x' : (bval(c2) === true ? 'y' : null);
        val(`V50D CASE WHEN ${c1} THEN x WHEN ${c2} THEN y END`,
            `SELECT CASE WHEN ${c1} THEN 'x' WHEN ${c2} THEN 'y' END AS r`, wantNoElse);
      }));
      // 単純 CASE
      CNUMS.forEach(a => {
        const av = nv(a);
        const want = av === 0 ? 'zero' : av === 1 ? 'one' : 'other';
        val(`V50D CASE ${a} WHEN 0 THEN zero WHEN 1 THEN one ELSE other END`,
            `SELECT CASE ${a} WHEN 0 THEN 'zero' WHEN 1 THEN 'one' ELSE 'other' END AS r`, want);
      });
      // COALESCE / NULLIF / IFNULL の組み合わせ
      CNUMS.forEach(a => CNUMS.forEach(b => {
        const av = nv(a), bv = nv(b);
        val(`V50D COALESCE(${a}, ${b})`, `SELECT COALESCE(${a}, ${b}) AS r`, av === null ? bv : av);
        val(`V50D NULLIF(${a}, ${b})`, `SELECT NULLIF(${a}, ${b}) AS r`,
            (av !== null && bv !== null && av === bv) ? null : av);
        val(`V50D IFNULL(${a}, ${b})`, `SELECT IFNULL(${a}, ${b}) AS r`, av === null ? bv : av);
      }));

      // ============================================================
      // E. NULL を含む式の伝播
      // ============================================================
      const UNARY = [
        ['ABS', a => Math.abs(a)],
        ['SIGN', a => Math.sign(a)],
        ['CEIL', a => Math.ceil(a)],
        ['FLOOR', a => Math.floor(a)],
        ['ROUND', a => Math.sign(a) * Math.round(Math.abs(a))],
        ['SQRT', a => a < 0 ? null : Math.sqrt(a)],
        ['EXP', a => Math.exp(a)],
        ['LN', a => a <= 0 ? null : Math.log(a)],
      ];
      UNARY.forEach(([fn, ref]) => NUMS.forEach(a => {
        const av = nv(a);
        const want = av === null ? null : fin(ref(av));
        valN(`V50E ${fn}(${a})`, `SELECT ${fn}(${a}) AS r`, want);
      }));
      // NULL が式のどこにあっても伝播する
      ['NULL + 1', '1 + NULL', 'NULL * 0', '0 * NULL', 'NULL - NULL',
       'ABS(NULL)', 'ABS(NULL) + 1', '1 + ABS(NULL)',
       'ROUND(NULL, 2)', 'COALESCE(NULL, NULL)',
       "CONCAT_WS(NULL, 'a')", "NULL || 'a'", "'a' || NULL",
       'NULL AND NULL', 'NULL OR NULL'].forEach(e => {
        val(`V50E ${e} is NULL`, `SELECT ${e} AS r`, null);
      });

      // ============================================================
      // F. 演算子の結合順序
      // ============================================================
      const PREC = [
        ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9],
        ['2 * 3 + 1', 7], ['2 * (3 + 1)', 8],
        ['10 - 2 - 3', 5], ['10 - (2 - 3)', 11],
        ['12 / 2 / 3', 2], ['12 / (2 / 3)', 18],
        ['1 + 2 - 3 + 4', 4],
        ['2 * 3 * 4', 24],
        ['10 % 4 + 1', 3], ['10 % (4 + 1)', 0],
        ['-2 * 3', -6], ['-(2 * 3)', -6],
        ['2 + 3 = 5', true], ['2 + 3 <> 5', false],
        // 比較は左結合。(1 < 2) = 1 は TRUE を 1 と比べて真（MySQL と同じ）
        ['1 < 2', true], ['1 < 2 = 1', true], ['1 < 2 = 0', false],
      ];
      PREC.forEach(([e, w]) => val(`V50F ${e}`, `SELECT ${e} AS r`, w));
      // AND は OR より強く結合する
      [['1 = 1 OR 1 = 0 AND 1 = 0', true],
       ['(1 = 1 OR 1 = 0) AND 1 = 0', false],
       ['1 = 0 AND 1 = 0 OR 1 = 1', true],
       ['1 = 0 AND (1 = 0 OR 1 = 1)', false],
       ['NOT 1 = 0 AND 1 = 1', true],
       ['NOT (1 = 0 AND 1 = 1)', true]].forEach(([e, w]) => {
        val(`V50F ${e}`, `SELECT ${e} AS r`, w);
      });

      // ============================================================
      // G. 入れ子にした式
      // ============================================================
      [5, 10, 20, 40].forEach(n => {
        t(`V50G ${n} nested parentheses`, () => {
          const e = '('.repeat(n) + '7' + ')'.repeat(n);
          return eq(one(`SELECT ${e} AS r`), 7);
        });
        t(`V50G ${n} chained additions`, () => {
          const parts = [];
          for (let i = 1; i <= n; i++) parts.push(String(i));
          return eq(one(`SELECT ${parts.join(' + ')} AS r`), n * (n + 1) / 2);
        });
        t(`V50G ${n} nested ABS calls`, () => {
          let e = '-3';
          for (let i = 0; i < n; i++) e = `ABS(${e})`;
          return eq(one(`SELECT ${e} AS r`), 3);
        });
        t(`V50G ${n} chained ANDs`, () => {
          const parts = [];
          for (let i = 0; i < n; i++) parts.push('1 = 1');
          return eq(one(`SELECT ${parts.join(' AND ')} AS r`), true);
        });
        t(`V50G ${n} chained ORs with one true`, () => {
          const parts = [];
          for (let i = 0; i < n; i++) parts.push(i === n - 1 ? '1 = 1' : '1 = 0');
          return eq(one(`SELECT ${parts.join(' OR ')} AS r`), true);
        });
        t(`V50G ${n} chained concatenations`, () => {
          const parts = [];
          let want = '';
          for (let i = 0; i < n; i++) { parts.push(`'${i % 10}'`); want += String(i % 10); }
          return eq(one(`SELECT ${parts.join(' || ')} AS r`), want);
        });
        t(`V50G ${n} nested COALESCE calls`, () => {
          let e = '42';
          for (let i = 0; i < n; i++) e = `COALESCE(NULL, ${e})`;
          return eq(one(`SELECT ${e} AS r`), 42);
        });
        t(`V50G ${n} nested CASE expressions`, () => {
          let e = "'end'";
          for (let i = 0; i < n; i++) e = `CASE WHEN 1 = 0 THEN 'no' ELSE ${e} END`;
          return eq(one(`SELECT ${e} AS r`), 'end');
        });
      });

      // ============================================================
      // H. 列に対して同じ式を評価する
      // ============================================================
      const ROWS_ = [];
      t('V50H fixture', () => {
        q('DROP TABLE IF EXISTS v50_t');
        q('CREATE TABLE v50_t (id INT, a INT, b INT, s TEXT)');
        ROWS_.length = 0;
        const vs = [];
        for (let i = 0; i < 120; i++) {
          const a = (i % 13 === 12) ? null : (i % 21) - 10;
          const b = (i % 7 === 6) ? null : (i % 5) - 2;
          const s = (i % 9 === 8) ? null : 'k' + (i % 4);
          ROWS_.push({ id: i, a, b, s });
          vs.push(`(${i}, ${a === null ? 'NULL' : a}, ${b === null ? 'NULL' : b}, ${s === null ? 'NULL' : "'" + s + "'"})`);
        }
        q('INSERT INTO v50_t VALUES ' + vs.join(','));
        return db.tables['v50_t'].rowCount === 120;
      });
      const COLEXPRS = [
        ['a + b', r => (r.a === null || r.b === null) ? null : r.a + r.b],
        ['a - b', r => (r.a === null || r.b === null) ? null : r.a - r.b],
        ['a * b', r => (r.a === null || r.b === null) ? null : r.a * r.b],
        ['a / b', r => (r.a === null || r.b === null || r.b === 0) ? null : r.a / r.b],
        ['a % b', r => (r.a === null || r.b === null || r.b === 0) ? null : r.a % r.b],
        ['ABS(a)', r => r.a === null ? null : Math.abs(r.a)],
        ['-a', r => r.a === null ? null : -r.a],
        ['a + 1', r => r.a === null ? null : r.a + 1],
        ['COALESCE(a, b)', r => r.a === null ? r.b : r.a],
        ['COALESCE(a, b, 0)', r => r.a !== null ? r.a : (r.b !== null ? r.b : 0)],
        ['NULLIF(a, b)', r => (r.a !== null && r.b !== null && r.a === r.b) ? null : r.a],
        ['a = b', r => (r.a === null || r.b === null) ? null : r.a === r.b],
        ['a > b', r => (r.a === null || r.b === null) ? null : r.a > r.b],
        ['a IS NULL', r => r.a === null],
        ['a IS NOT NULL', r => r.a !== null],
        ["s || 'x'", r => r.s === null ? null : r.s + 'x'],
        ['UPPER(s)', r => r.s === null ? null : r.s.toUpperCase()],
        ['LENGTH(s)', r => r.s === null ? null : r.s.length],
        ["CASE WHEN a > 0 THEN 'p' WHEN a < 0 THEN 'n' ELSE 'z' END",
         r => r.a === null ? 'z' : (r.a > 0 ? 'p' : r.a < 0 ? 'n' : 'z')],
        ['a > 0 AND b > 0',
         r => { const x = r.a === null ? null : r.a > 0, y = r.b === null ? null : r.b > 0;
                return (x === false || y === false) ? false : ((x === null || y === null) ? null : true); }],
        ['a > 0 OR b > 0',
         r => { const x = r.a === null ? null : r.a > 0, y = r.b === null ? null : r.b > 0;
                return (x === true || y === true) ? true : ((x === null || y === null) ? null : false); }],
        ['NOT (a > 0)', r => r.a === null ? null : !(r.a > 0)],
      ];
      COLEXPRS.forEach(([expr, ref]) => {
        t(`V50H ${expr} over the column`, () => {
          const got = rows(`SELECT id, ${expr} AS r FROM v50_t ORDER BY id`).map(x => r9(x.r));
          return eq(got, ROWS_.map(r => r9(fin(ref(r)))));
        });
        t(`V50H ${expr} used as a filter`, () => {
          const got = rows(`SELECT id FROM v50_t WHERE (${expr}) IS NOT NULL ORDER BY id`).map(x => x.id);
          return eq(got, ROWS_.filter(r => fin(ref(r)) !== null).map(r => r.id));
        });
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V50Zz cleanup', () => {
        q('DROP TABLE IF EXISTS v50_t');
        return Object.keys(db.tables).filter(n => n.indexOf('v50_') === 0).length === 0;
      });

      return T;
    }
