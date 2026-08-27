    // ============================================================================
    // [Test Suite v49] - v1.30: コマンド全網羅（v43〜v48）で見つかった欠陥の回帰と、
    //                    句をまたぐ組み合わせ
    //
    //   A. v1.30 で直した欠陥の回帰
    //   B. 三値論理の完全な真理値表
    //   C. 同じ関数をあらゆる句の位置で使う
    //   D. 結合 × 述語 × 並べ替え の行列
    //   E. 集約とウィンドウの組み合わせ
    //   F. 部品を積み上げた大きなクエリ
    //
    //   test-suite.js の tests 配列へ getV49Tests() のスプレッドで合流する
    // ============================================================================
    function getV49Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, rowsOf: rows, oneOf: one, eq, val } = makeTestKit('V49');

      const R = [];
      t('V49 fixture', () => {
        ['v49_a', 'v49_b'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        q('CREATE TABLE v49_a (id INT PRIMARY KEY, g TEXT, v INT, s TEXT, d DATE)');
        R.length = 0;
        const gs = ['A', 'B', 'C'];
        const vs = [];
        for (let i = 0; i < 150; i++) {
          const v = (i % 11 === 10) ? null : ((i * 7) % 43) - 20;
          const s = (i % 7 === 6) ? null : 'w' + (i % 5);
          const dd = `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
          R.push({ id: i, g: gs[i % 3], v, s, d: dd });
          vs.push(`(${i}, '${gs[i % 3]}', ${v === null ? 'NULL' : v}, ${s === null ? 'NULL' : "'" + s + "'"}, '${dd}')`);
        }
        q('INSERT INTO v49_a VALUES ' + vs.join(','));
        q('CREATE TABLE v49_b (id INT, n INT)');
        q('INSERT INTO v49_b VALUES (1, 10), (2, 20), (3, 30)');
        return db.tables['v49_a'].rowCount === 150;
      });

      // ============================================================
      // A. v1.30 で直した欠陥の回帰
      // ============================================================
      // A1. 桁数・長さが NULL なら結果も NULL
      ['ROUND', 'TRUNC', 'TRUNCATE'].forEach(fn => {
        val(`V49A ${fn} with a NULL scale is NULL`, `SELECT ${fn}(2.567, NULL) AS r`, null);
        val(`V49A ${fn} with a scale still works`, `SELECT ${fn}(2.567, 1) AS r`, fn === 'ROUND' ? 2.6 : 2.5);
      });
      [['LEFT', "'abc', NULL"], ['RIGHT', "'abc', NULL"],
       ['LPAD', "'ab', NULL, '*'"], ['RPAD', "'ab', NULL, '*'"]].forEach(([fn, args]) => {
        val(`V49A ${fn} with a NULL length is NULL`, `SELECT ${fn}(${args}) AS r`, null);
      });
      val('V49A LEFT still truncates normally', "SELECT LEFT('abc', 2) AS r", 'ab');
      val('V49A LPAD still pads normally', "SELECT LPAD('ab', 4, '*') AS r", '**ab');
      t('V49A a NULL length over a column yields NULL everywhere', () => {
        const got = rows('SELECT id, LEFT(s, NULL) AS r FROM v49_a ORDER BY id LIMIT 5').map(r => r.r);
        return eq(got, [null, null, null, null, null]);
      });

      // A2. 定義域の外は NaN ではなく NULL
      const DOMAIN = [['SQRT(-1)'], ['ASIN(2)'], ['ACOS(-2)'], ['POWER(-1, 0.5)'], ['MOD(1, 0)'],
                      ['EXP(1000)'], ['COT(0)'], ['LN(0)'], ['LOG10(0)'], ['LOG2(-1)'], ['SQUARE(1e200)']];
      DOMAIN.forEach(([e]) => {
        val(`V49A ${e} is NULL`, `SELECT ${e} AS r`, null);
        val(`V49A ${e} IS NULL is true`, `SELECT ${e} IS NULL AS r`, true);
      });
      t('V49A a domain error is skipped by COUNT like a NULL', () => {
        q('DROP TABLE IF EXISTS v49_n');
        q('CREATE TABLE v49_n (x INT)');
        q('INSERT INTO v49_n VALUES (4), (-1), (9)');
        const c = one('SELECT COUNT(SQRT(x)) AS r FROM v49_n');
        const s = one('SELECT SUM(SQRT(x)) AS r FROM v49_n');
        const n = one('SELECT COUNT(*) AS r FROM v49_n WHERE SQRT(x) IS NULL');
        q('DROP TABLE IF EXISTS v49_n');
        return eq([c, s, n], [2, 5, 1]);
      });
      t('V49A a FLOAT column rejects an overflowing value', () => {
        q('DROP TABLE IF EXISTS v49_f');
        q('CREATE TABLE v49_f (x FLOAT)');
        const r = q('INSERT INTO v49_f VALUES (1e309)');
        q('DROP TABLE IF EXISTS v49_f');
        return eq(!!r.error, true);
      });

      // A3. 日付の単位名の誤りは知らせる
      [["DATE_TRUNC('fortnight', '2024-03-15')", 'DATE_TRUNC'],
       ["DATE_PART('fortnight', '2024-03-15')", 'EXTRACT / DATE_PART'],
       ["DATEPART(fortnight, '2024-03-15')", 'DATEPART'],
       ["DATENAME(fortnight, '2024-03-15')", 'DATENAME'],
       ["DATEADD(fortnight, 1, '2024-03-15')", 'DATEADD'],
       ["TIMESTAMPADD(fortnight, 1, '2024-03-15')", 'TIMESTAMPADD'],
       ["TIMESTAMPDIFF(fortnight, '2024-01-01', '2024-03-15')", 'TIMESTAMPDIFF']].forEach(([e, fn]) => {
        err(`V49A ${e} is refused`, `SELECT ${e} AS r`, 'unsupported date unit');
      });
      val('V49A a correct unit still works', "SELECT DATE_TRUNC('month', '2024-03-15') AS r", '2024-03-01 00:00:00');
      val('V49A DATEPART with an abbreviation still works', "SELECT DATEPART(dy, '2024-03-15') AS r", 75);

      // A4. 式の中の意図した誤りは NULL に丸めない
      t('V49A a unit error inside a larger expression still surfaces', () => {
        const r = q("SELECT COALESCE(DATE_TRUNC('fortnight', '2024-03-15'), 'x') AS r");
        return eq(!!r.error, true);
      });
      t('V49A a unit error in WHERE still surfaces', () => {
        const r = q("SELECT id FROM v49_a WHERE DATE_TRUNC('fortnight', d) IS NOT NULL");
        return eq(!!r.error, true);
      });

      // A5. INITCAP の語の区切り
      [["'a,b,c'", 'A,B,C'], ["'foo-bar baz'", 'Foo-Bar Baz'], ["'hello world'", 'Hello World'],
       ["'HELLO WORLD'", 'Hello World'], ["'o''brien'", "O'Brien"], ["'abc123def'", 'Abc123def'],
       ["'  pad  '", '  Pad  '], ["''", '']].forEach(([lit, want]) => {
        val(`V49A INITCAP(${lit})`, `SELECT INITCAP(${lit}) AS r`, want);
      });

      // A6. 引数個数の検査
      [['WIDTH_BUCKET(1, 0, 10)', 'WIDTH_BUCKET'], ['TRUNC(1, 2, 3)', 'TRUNC'],
       ['BITAND(1)', 'BITAND'], ["SOUNDEX('a', 'b')", 'SOUNDEX'], ['MAKETIME(1, 2)', 'MAKETIME'],
       ["DATE_TRUNC('day')", 'DATE_TRUNC'], ['SHIFTLEFT(1)', 'SHIFTLEFT'],
       ["QUOTE('a', 'b')", 'QUOTE'], ['TO_HEX(1, 2)', 'TO_HEX']].forEach(([e]) => {
        err(`V49A ${e} is refused`, `SELECT ${e} AS r`, 'parameter count');
      });
      val('V49A WIDTH_BUCKET with four arguments still works',
          'SELECT WIDTH_BUCKET(5, 0, 10, 5) AS r', 3);
      ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'MEDIAN'].forEach(fn => {
        err(`V49A ${fn} with two arguments is refused`,
            `SELECT ${fn}(v, 1) AS r FROM v49_a`, 'exactly 1 argument');
      });
      err('V49A NTILE with no argument is refused',
          'SELECT NTILE() OVER (ORDER BY id) AS r FROM v49_a', 'takes 1 argument');
      err('V49A NTH_VALUE with one argument is refused',
          'SELECT NTH_VALUE(id) OVER (ORDER BY id) AS r FROM v49_a', 'takes 2 argument');
      ['ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'LAG(id)', 'LEAD(id)', 'NTILE(4)',
       'CUME_DIST()', 'PERCENT_RANK()'].forEach(w => {
        err(`V49A ${w} without OVER is refused`,
            `SELECT ${w} AS r FROM v49_a`, 'requires an OVER clause');
      });

      // A7. TO_CHAR の書式
      [["'DD'", '15'], ["'MM'", '03'], ["'YYYY'", '2024'], ["'DD-MM'", '15-03'],
       ["'HH24'", '13'], ["'MI'", '45'], ["'SS'", '56'], ["'DDD'", '075']].forEach(([f, want]) => {
        val(`V49A TO_CHAR with the format ${f}`,
            `SELECT TO_CHAR('2024-03-15 13:45:56', ${f}) AS r`, want);
      });
      val('V49A TO_CHAR still formats numbers', "SELECT TO_CHAR(1234.567, '9999.99') AS r", '1234.57');

      // A8. CAST の型名の検査
      ['NOSUCHTYPE', 'INTEGR', 'VARCHARR', 'BOOLEN'].forEach(ty => {
        err(`V49A CAST to ${ty} is refused`, `SELECT CAST('1' AS ${ty}) AS r`, 'unknown type');
      });
      ['INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'REAL', 'DOUBLE',
       'TEXT', 'VARCHAR', 'VARCHAR2', 'NVARCHAR', 'CHAR', 'CLOB', 'BOOLEAN', 'BOOL',
       'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'SIGNED', 'UNSIGNED', 'INT8'].forEach(ty => {
        t(`V49A CAST to ${ty} is accepted`, () => {
          const r = q(`SELECT CAST('1' AS ${ty}) AS r`);
          return eq(!!r.error, false);
        });
      });

      // A9. 三値論理
      const TRUTH = [
        ['NULL AND FALSE', false], ['FALSE AND NULL', false],
        ['NULL AND TRUE', null], ['TRUE AND NULL', null],
        ['NULL AND NULL', null], ['TRUE AND TRUE', true],
        ['FALSE AND FALSE', false], ['TRUE AND FALSE', false],
        ['NULL OR TRUE', true], ['TRUE OR NULL', true],
        ['NULL OR FALSE', null], ['FALSE OR NULL', null],
        ['NULL OR NULL', null], ['TRUE OR TRUE', true],
        ['FALSE OR FALSE', false], ['TRUE OR FALSE', true],
        ['NOT NULL IS NULL', false], ['NOT (1 = NULL)', null],
        ['NOT TRUE', false], ['NOT FALSE', true],
        ['NOT (NULL AND FALSE)', true], ['NOT (NULL OR FALSE)', null],
      ];
      TRUTH.forEach(([e, want]) => val(`V49A ${e}`, `SELECT ${e} AS r`, want));
      t('V49A NOT over an OR with NULL excludes the row', () => {
        // NOT (v > 0 OR FALSE) は v が NULL の行を通してはいけない
        const got = one('SELECT COUNT(*) AS c FROM v49_a WHERE NOT (v > 0 OR 1 = 0)');
        const want = R.filter(r => r.v !== null && !(r.v > 0)).length;
        return eq(got, want);
      });
      t('V49A an AND with a false branch excludes NULL rows too', () => {
        const got = one('SELECT COUNT(*) AS c FROM v49_a WHERE v > 0 AND 1 = 0');
        return eq(got, 0);
      });

      // A10. BEFORE トリガーの SET NEW
      t('V49A a BEFORE INSERT trigger sets a column', () => {
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TRIGGER IF EXISTS v49_t1');
        q('CREATE TABLE v49_tg (a INT, log TEXT)');
        q("CREATE TRIGGER v49_t1 BEFORE INSERT ON v49_tg FOR EACH ROW SET NEW.log = 'set'");
        q('INSERT INTO v49_tg (a) VALUES (1)');
        const got = one('SELECT log FROM v49_tg');
        q('DROP TRIGGER IF EXISTS v49_t1'); q('DROP TABLE IF EXISTS v49_tg');
        return eq(got, 'set');
      });
      t('V49A a BEFORE INSERT trigger can compute from NEW', () => {
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TRIGGER IF EXISTS v49_t2');
        q('CREATE TABLE v49_tg (a INT, b INT)');
        q('CREATE TRIGGER v49_t2 BEFORE INSERT ON v49_tg FOR EACH ROW SET NEW.b = NEW.a * 10');
        q('INSERT INTO v49_tg (a) VALUES (4)');
        const got = one('SELECT b FROM v49_tg');
        q('DROP TRIGGER IF EXISTS v49_t2'); q('DROP TABLE IF EXISTS v49_tg');
        return eq(got, 40);
      });
      t('V49A a BEFORE UPDATE trigger sets a column', () => {
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TRIGGER IF EXISTS v49_t3');
        q('CREATE TABLE v49_tg (a INT, log TEXT)');
        q('INSERT INTO v49_tg VALUES (1, NULL)');
        q("CREATE TRIGGER v49_t3 BEFORE UPDATE ON v49_tg FOR EACH ROW SET NEW.log = 'upd'");
        q('UPDATE v49_tg SET a = 2');
        const got = one('SELECT log FROM v49_tg');
        q('DROP TRIGGER IF EXISTS v49_t3'); q('DROP TABLE IF EXISTS v49_tg');
        return eq(got, 'upd');
      });
      t('V49A a BEFORE trigger wrapped in BEGIN END also applies', () => {
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TRIGGER IF EXISTS v49_t4');
        q('CREATE TABLE v49_tg (a INT, log TEXT)');
        q("CREATE TRIGGER v49_t4 BEFORE INSERT ON v49_tg FOR EACH ROW BEGIN SET NEW.log = 'blk'; END");
        q('INSERT INTO v49_tg (a) VALUES (1)');
        const got = one('SELECT log FROM v49_tg');
        q('DROP TRIGGER IF EXISTS v49_t4'); q('DROP TABLE IF EXISTS v49_tg');
        return eq(got, 'blk');
      });
      t('V49A an AFTER trigger still runs its statement', () => {
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TABLE IF EXISTS v49_au');
        q('DROP TRIGGER IF EXISTS v49_t5');
        q('CREATE TABLE v49_tg (a INT)'); q('CREATE TABLE v49_au (msg TEXT)');
        q("CREATE TRIGGER v49_t5 AFTER INSERT ON v49_tg FOR EACH ROW INSERT INTO v49_au VALUES ('ins')");
        q('INSERT INTO v49_tg VALUES (1)');
        const got = one('SELECT COUNT(*) AS c FROM v49_au');
        q('DROP TRIGGER IF EXISTS v49_t5');
        q('DROP TABLE IF EXISTS v49_tg'); q('DROP TABLE IF EXISTS v49_au');
        return eq(got, 1);
      });

      // A11. DATE 列は日付だけを持つ
      t('V49A a DATE column drops the time part', () => {
        q('DROP TABLE IF EXISTS v49_d');
        q('CREATE TABLE v49_d (d DATE, ts TIMESTAMP)');
        q("INSERT INTO v49_d VALUES ('2024-03-15 12:34:56', '2024-03-15 12:34:56')");
        const got = rows('SELECT d, ts, HOUR(d) AS hd, HOUR(ts) AS ht FROM v49_d')[0];
        q('DROP TABLE IF EXISTS v49_d');
        return eq(got, { d: '2024-03-15', ts: '2024-03-15 12:34:56', hd: 0, ht: 12 });
      });
      t('V49A a DATE column groups by day', () => {
        q('DROP TABLE IF EXISTS v49_d');
        q('CREATE TABLE v49_d (d DATE)');
        q("INSERT INTO v49_d VALUES ('2024-03-15 01:00:00'), ('2024-03-15 23:00:00'), ('2024-03-16')");
        const got = rows('SELECT d, COUNT(*) AS c FROM v49_d GROUP BY d ORDER BY d');
        q('DROP TABLE IF EXISTS v49_d');
        return eq(got, [{ d: '2024-03-15', c: 2 }, { d: '2024-03-16', c: 1 }]);
      });

      // A12. 型名の別名も検査される
      [['INT', '1.5'], ['BIGINT', '1.5'], ['SMALLINT', "'abc'"], ['INT8', '2.5'],
       ['TINYINT', "'x'"]].forEach(([ty, lit]) => {
        t(`V49A a ${ty} column rejects ${lit}`, () => {
          q('DROP TABLE IF EXISTS v49_ty');
          q(`CREATE TABLE v49_ty (x ${ty})`);
          const r = q(`INSERT INTO v49_ty VALUES (${lit})`);
          q('DROP TABLE IF EXISTS v49_ty');
          return eq(!!r.error, true);
        });
      });
      ['VARCHAR(20)', 'CHAR(20)', 'NVARCHAR(20)', 'CLOB', 'TEXT', 'STRING'].forEach(ty => {
        t(`V49A a ${ty} column keeps an empty string`, () => {
          q('DROP TABLE IF EXISTS v49_ty');
          q(`CREATE TABLE v49_ty (x ${ty})`);
          q("INSERT INTO v49_ty VALUES ('')");
          const got = one('SELECT x FROM v49_ty');
          q('DROP TABLE IF EXISTS v49_ty');
          return eq(got, '');
        });
      });

      // A13. 重複列名・空 CTAS・CTE 付き INSERT
      err('V49A a duplicate column name is refused',
          'CREATE TABLE v49_dup (a INT, a INT)', 'duplicate column name');
      err('V49A a duplicate column name in any position is refused',
          'CREATE TABLE v49_dup (a INT, b INT, A TEXT)', 'duplicate column name');
      t('V49A an empty CTAS keeps its columns', () => {
        q('DROP TABLE IF EXISTS v49_e');
        q('CREATE TABLE v49_e AS SELECT id, v FROM v49_a WHERE 1 = 0');
        const d = rows('DESCRIBE v49_e');
        const s = q('SELECT COALESCE(SUM(v), 0) AS s FROM v49_e');
        q('DROP TABLE IF EXISTS v49_e');
        return eq([d.length, !!s.error, s.data[0].s], [2, false, 0]);
      });
      t('V49A an empty SELECT INTO keeps its columns', () => {
        q('DROP TABLE IF EXISTS v49_e2');
        q('SELECT id, v INTO v49_e2 FROM v49_a WHERE 1 = 0');
        const d = rows('DESCRIBE v49_e2');
        q('DROP TABLE IF EXISTS v49_e2');
        return eq(d.length, 2);
      });
      t('V49A INSERT with a trailing WITH clause', () => {
        q('DROP TABLE IF EXISTS v49_iw');
        q('CREATE TABLE v49_iw (id INT, n INT)');
        q('INSERT INTO v49_iw (id, n) WITH c AS (SELECT id, n FROM v49_b) SELECT * FROM c');
        const got = one('SELECT COUNT(*) AS c FROM v49_iw');
        q('DROP TABLE IF EXISTS v49_iw');
        return eq(got, 3);
      });
      t('V49A INSERT with a leading WITH clause still works', () => {
        q('DROP TABLE IF EXISTS v49_iw');
        q('CREATE TABLE v49_iw (id INT, n INT)');
        q('WITH c AS (SELECT id, n FROM v49_b) INSERT INTO v49_iw (id, n) SELECT * FROM c');
        const got = one('SELECT COUNT(*) AS c FROM v49_iw');
        q('DROP TABLE IF EXISTS v49_iw');
        return eq(got, 3);
      });

      // ============================================================
      // B. 三値論理の完全な真理値表（列に対して）
      // ============================================================
      const P3 = [
        ['v > 0', r => r.v === null ? null : r.v > 0],
        ['v < 0', r => r.v === null ? null : r.v < 0],
        ['s IS NULL', r => r.s === null],
        ["g = 'A'", r => r.g === 'A'],
        ['1 = 0', () => false],
        ['1 = 1', () => true],
      ];
      const A3 = (a, b) => (a === false || b === false) ? false : ((a === null || b === null) ? null : true);
      const O3 = (a, b) => (a === true || b === true) ? true : ((a === null || b === null) ? null : false);
      const N3 = (a) => a === null ? null : !a;
      P3.forEach(([e1, f1]) => P3.forEach(([e2, f2]) => {
        [['AND', A3], ['OR', O3]].forEach(([opName, opFn]) => {
          t(`V49B WHERE ${e1} ${opName} ${e2}`, () => {
            const got = rows(`SELECT id FROM v49_a WHERE ${e1} ${opName} ${e2} ORDER BY id`).map(r => r.id);
            const want = R.filter(r => opFn(f1(r), f2(r)) === true).map(r => r.id);
            return eq(got, want);
          });
          t(`V49B WHERE NOT (${e1} ${opName} ${e2})`, () => {
            const got = rows(`SELECT id FROM v49_a WHERE NOT (${e1} ${opName} ${e2}) ORDER BY id`).map(r => r.id);
            const want = R.filter(r => N3(opFn(f1(r), f2(r))) === true).map(r => r.id);
            return eq(got, want);
          });
          t(`V49B SELECT (${e1} ${opName} ${e2}) as a value`, () => {
            const got = rows(`SELECT id, (${e1} ${opName} ${e2}) AS r FROM v49_a ORDER BY id`).map(r => r.r);
            const want = R.map(r => opFn(f1(r), f2(r)));
            return eq(got, want);
          });
        });
      }));

      // ============================================================
      // C. 同じ関数をあらゆる句の位置で使う
      // ============================================================
      const FNS = [
        ['ABS(v)', r => r.v === null ? null : Math.abs(r.v)],
        ['UPPER(s)', r => r.s === null ? null : r.s.toUpperCase()],
        ['LENGTH(s)', r => r.s === null ? null : r.s.length],
        ['COALESCE(v, 0)', r => r.v === null ? 0 : r.v],
        ['ROUND(v, 0)', r => r.v === null ? null : r.v],
        ['YEAR(d)', r => Number(r.d.slice(0, 4))],
        ['MONTH(d)', r => Number(r.d.slice(5, 7))],
        ["SUBSTR(s, 1, 1)", r => r.s === null ? null : r.s.slice(0, 1)],
        ['SIGN(v)', r => r.v === null ? null : Math.sign(r.v)],
        ["CONCAT(g, '-', CAST(id AS TEXT))", r => `${r.g}-${r.id}`],
      ];
      FNS.forEach(([expr, ref]) => {
        t(`V49C ${expr} in the select list`, () => {
          const got = rows(`SELECT id, ${expr} AS r FROM v49_a ORDER BY id`).map(x => x.r);
          return eq(got, R.map(ref));
        });
        t(`V49C ${expr} in WHERE`, () => {
          const got = one(`SELECT COUNT(*) AS c FROM v49_a WHERE ${expr} IS NOT NULL`);
          return eq(got, R.filter(r => ref(r) !== null).length);
        });
        t(`V49C ${expr} in ORDER BY`, () => {
          const got = rows(`SELECT id FROM v49_a ORDER BY ${expr}, id`).map(r => r.id);
          const want = R.slice().sort((a, b) => {
            const x = ref(a), y = ref(b);
            if (x === null && y === null) return a.id - b.id;
            if (x === null) return -1;
            if (y === null) return 1;
            return (x < y ? -1 : x > y ? 1 : 0) || a.id - b.id;
          }).map(r => r.id);
          return eq(got, want);
        });
        t(`V49C ${expr} in GROUP BY`, () => {
          const got = rows(`SELECT ${expr} AS k, COUNT(*) AS c FROM v49_a GROUP BY ${expr}`).length;
          return eq(got, new Set(R.map(ref).map(x => JSON.stringify(x))).size);
        });
        t(`V49C ${expr} inside an aggregate`, () => {
          const r = q(`SELECT COUNT(${expr}) AS c FROM v49_a`);
          return eq([!!r.error, r.data[0].c], [false, R.filter(x => ref(x) !== null).length]);
        });
        t(`V49C ${expr} in a derived table`, () => {
          const got = one(`SELECT COUNT(*) AS c FROM (SELECT ${expr} AS k FROM v49_a) z WHERE k IS NOT NULL`);
          return eq(got, R.filter(r => ref(r) !== null).length);
        });
        t(`V49C ${expr} inside CASE`, () => {
          const got = one(`SELECT COUNT(*) AS c FROM v49_a WHERE CASE WHEN ${expr} IS NULL THEN 0 ELSE 1 END = 1`);
          return eq(got, R.filter(r => ref(r) !== null).length);
        });
        t(`V49C ${expr} in a window partition`, () => {
          const r = q(`SELECT ROW_NUMBER() OVER (PARTITION BY ${expr} ORDER BY id) AS rn FROM v49_a`);
          return eq(!!r.error, false);
        });
      });

      // ============================================================
      // D. 結合 × 述語 × 並べ替え
      // ============================================================
      const JKINDS = ['JOIN', 'LEFT JOIN', 'INNER JOIN', 'LEFT OUTER JOIN'];
      const JPREDS = [
        ['1 = 1', () => true],
        ['a.v > 0', r => r.v !== null && r.v > 0],
        ["a.g = 'A'", r => r.g === 'A'],
        ['a.v IS NULL', r => r.v === null],
        ['a.id < 50', r => r.id < 50],
      ];
      JKINDS.forEach(kind => JPREDS.forEach(([p, pf]) => {
        t(`V49D SELECT with ${kind} and WHERE ${p}`, () => {
          const got = one(`SELECT COUNT(*) AS c FROM v49_a a ${kind} v49_b b ON a.id = b.id WHERE ${p}`);
          const bids = new Set([1, 2, 3]);
          const want = /LEFT/.test(kind)
            ? R.filter(pf).length
            : R.filter(r => bids.has(r.id) && pf(r)).length;
          return eq(got, want);
        });
        t(`V49D ${kind} with ${p} ordered and limited`, () => {
          const got = rows(`SELECT a.id FROM v49_a a ${kind} v49_b b ON a.id = b.id WHERE ${p} ORDER BY a.id LIMIT 5`)
            .map(r => r.id);
          const bids = new Set([1, 2, 3]);
          const want = (/LEFT/.test(kind) ? R.filter(pf) : R.filter(r => bids.has(r.id) && pf(r)))
            .map(r => r.id).sort((x, y) => x - y).slice(0, 5);
          return eq(got, want);
        });
      }));

      // ============================================================
      // E. 集約とウィンドウの組み合わせ
      // ============================================================
      const EAGGS = ['COUNT(*)', 'SUM(v)', 'MIN(v)', 'MAX(v)', 'COUNT(DISTINCT v)', 'COUNT(s)'];
      const EWINS = ['ROW_NUMBER() OVER (ORDER BY g)', 'RANK() OVER (ORDER BY g)',
                     'SUM(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING)',
                     'COUNT(*) OVER ()'];
      EAGGS.forEach(agg => EWINS.forEach(win => {
        t(`V49E ${agg} with ${win} per group`, () => {
          const r = q(`SELECT g, ${agg} AS a, ${win} AS w FROM v49_a GROUP BY g ORDER BY g`);
          if (r.error) throw new Error(r.error);
          return eq(r.data.length, new Set(R.map(x => x.g)).size);
        });
      }));
      t('V49E a running total over grouped sums', () => {
        const got = rows('SELECT g, SUM(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING) AS r FROM v49_a GROUP BY g ORDER BY g')
          .map(x => x.r);
        const m = new Map();
        R.forEach(r => { if (r.v !== null) m.set(r.g, (m.get(r.g) || 0) + r.v); else if (!m.has(r.g)) m.set(r.g, 0); });
        let acc = 0;
        const want = [...m.keys()].sort().map(g => { acc += m.get(g); return acc; });
        return eq(got, want);
      });
      t('V49E QUALIFY over grouped rows', () => {
        const r = q('SELECT g, COUNT(*) AS c FROM v49_a GROUP BY g QUALIFY ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) = 1');
        return eq([!!r.error, r.data.length], [false, 1]);
      });

      // ============================================================
      // F. 部品を積み上げた大きなクエリ
      // ============================================================
      t('V49F a query with every clause at once', () => {
        const got = rows(
          "WITH c AS (SELECT id, g, v, s FROM v49_a WHERE v IS NOT NULL) " +
          "SELECT g, COUNT(*) AS n, SUM(v) AS s, " +
          "       ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, g) AS rn " +
          "FROM c JOIN v49_b b ON c.id = b.id " +
          "WHERE c.v > -100 GROUP BY g HAVING COUNT(*) >= 1 ORDER BY g LIMIT 10");
        return eq(got.length >= 1, true);
      });
      t('V49F a union of two grouped queries', () => {
        const got = rows("SELECT g, COUNT(*) AS c FROM v49_a GROUP BY g " +
                         "UNION ALL SELECT 'ALL', COUNT(*) FROM v49_a ORDER BY g");
        return eq(got.length, new Set(R.map(r => r.g)).size + 1);
      });
      t('V49F a filtered aggregate inside a derived table with a window', () => {
        const got = rows(
          'SELECT k, n, SUM(n) OVER (ORDER BY k ROWS UNBOUNDED PRECEDING) AS run FROM ' +
          '(SELECT g AS k, COUNT(*) FILTER (WHERE v > 0) AS n FROM v49_a GROUP BY g) z ORDER BY k');
        const m = new Map();
        R.forEach(r => {
          if (!m.has(r.g)) m.set(r.g, 0);
          if (r.v !== null && r.v > 0) m.set(r.g, m.get(r.g) + 1);
        });
        let acc = 0;
        const want = [...m.keys()].sort().map(g => { acc += m.get(g); return { k: g, n: m.get(g), run: acc }; });
        return eq(got, want);
      });
      t('V49F five derived tables stacked', () => {
        let sql = 'SELECT id FROM v49_a';
        for (let i = 0; i < 5; i++) sql = `SELECT id FROM (${sql}) z${i}`;
        return eq(rows(sql).length, 150);
      });
      t('V49F a CTE chain of five steps', () => {
        const parts = ['c0 AS (SELECT id FROM v49_a)'];
        for (let i = 1; i < 5; i++) parts.push(`c${i} AS (SELECT id FROM c${i - 1} WHERE id < ${150 - i * 10})`);
        return eq(one(`WITH ${parts.join(', ')} SELECT COUNT(*) AS c FROM c4`), 110);
      });
      t('V49F a scalar subquery in every clause at once', () => {
        const got = one(
          'SELECT (SELECT COUNT(*) FROM v49_b) AS r FROM v49_a ' +
          'WHERE id < (SELECT COUNT(*) FROM v49_a) ' +
          'ORDER BY (SELECT 1), id LIMIT 1');
        return eq(got, 3);
      });

      // ============================================================
      // G. BETWEEN / IN の左辺 × 値の総当たり
      //    左辺が符号つき・括弧つき・算術式でも真偽値を返すこと
      // ============================================================
      const LEFTS = [
        ['-1', -1], ['(-1)', -1], ['1', 1], ['(1)', 1], ['0', 0], ['(0)', 0],
        ['-2.5', -2.5], ['2.5', 2.5], ['0 - 1', -1], ['1 + 1', 2], ['3 - 5', -2],
        ['2 * 3', 6], ['(1 + 2) * 2', 6], ['ABS(-4)', 4], ['-ABS(4)', -4],
        ['10 / 2', 5], ['7 % 3', 1],
      ];
      const RANGES2 = [[0, 10], [-5, 5], [-1, -1], [1, 1], [10, 0], [-100, 100]];
      LEFTS.forEach(([lhs, lv]) => {
        RANGES2.forEach(([lo, hi]) => {
          val(`V49G ${lhs} BETWEEN ${lo} AND ${hi}`,
              `SELECT ${lhs} BETWEEN ${lo} AND ${hi} AS r`, lv >= lo && lv <= hi);
          val(`V49G ${lhs} NOT BETWEEN ${lo} AND ${hi}`,
              `SELECT ${lhs} NOT BETWEEN ${lo} AND ${hi} AS r`, !(lv >= lo && lv <= hi));
        });
        [['(0, 1, 2)', [0, 1, 2]], ['(-1, -2.5)', [-1, -2.5]], ['(5, 6)', [5, 6]],
         ['(1)', [1]]].forEach(([listSql, list]) => {
          val(`V49G ${lhs} IN ${listSql}`, `SELECT ${lhs} IN ${listSql} AS r`,
              list.indexOf(lv) !== -1);
          val(`V49G ${lhs} NOT IN ${listSql}`, `SELECT ${lhs} NOT IN ${listSql} AS r`,
              list.indexOf(lv) === -1);
        });
      });
      // 列を左辺にした場合も同じ結果になる
      [[0, 10], [-5, 5], [-100, 100]].forEach(([lo, hi]) => {
        t(`V49G a column BETWEEN ${lo} AND ${hi}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE v BETWEEN ${lo} AND ${hi} ORDER BY id`).map(r => r.id);
          return eq(got, R.filter(r => r.v !== null && r.v >= lo && r.v <= hi).map(r => r.id));
        });
        t(`V49G an expression column BETWEEN ${lo} AND ${hi}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE v + 0 BETWEEN ${lo} AND ${hi} ORDER BY id`).map(r => r.id);
          return eq(got, R.filter(r => r.v !== null && r.v >= lo && r.v <= hi).map(r => r.id));
        });
        t(`V49G a negated column BETWEEN ${lo} AND ${hi}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE -v BETWEEN ${lo} AND ${hi} ORDER BY id`).map(r => r.id);
          return eq(got, R.filter(r => r.v !== null && -r.v >= lo && -r.v <= hi).map(r => r.id));
        });
      });
      // BETWEEN / IN が他の条件と並んでも壊れない
      [['AND', (a, b) => a && b], ['OR', (a, b) => a || b]].forEach(([op, fn]) => {
        t(`V49G BETWEEN combined with ${op}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE v BETWEEN 0 AND 10 ${op} id < 5 ORDER BY id`).map(r => r.id);
          const want = R.filter(r => fn(r.v !== null && r.v >= 0 && r.v <= 10, r.id < 5)).map(r => r.id);
          return eq(got, want);
        });
        t(`V49G IN combined with ${op}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE v IN (0, 1, 2) ${op} id < 5 ORDER BY id`).map(r => r.id);
          const want = R.filter(r => fn(r.v !== null && [0, 1, 2].indexOf(r.v) !== -1, r.id < 5)).map(r => r.id);
          return eq(got, want);
        });
        t(`V49G NOT IN combined with ${op}`, () => {
          const got = rows(`SELECT id FROM v49_a WHERE v NOT IN (0, 1, 2) ${op} id < 5 ORDER BY id`).map(r => r.id);
          const want = R.filter(r => fn(r.v !== null && [0, 1, 2].indexOf(r.v) === -1, r.id < 5)).map(r => r.id);
          return eq(got, want);
        });
      });

      // ============================================================
      // H. OVER 句の入れ子と ORDER BY の中の式
      // ============================================================
      const PEXPRS = [
        'g', 'id % 3', 'UPPER(g)', 'CAST(id AS TEXT)', "CONCAT(g, '-')",
        "CONCAT(g, '-', CAST(id AS TEXT))", "SUBSTR(g, 1, 1)",
        "CASE WHEN v > 0 THEN 'p' ELSE 'n' END", 'COALESCE(v, 0)',
        "CONCAT(UPPER(g), LOWER(COALESCE(s, 'z')))",
      ];
      const OEXPRS = [
        'id', 'id DESC', 'v', 'v DESC', 'CAST(id AS TEXT)', 'id + 1', 'id * 2 DESC',
        "CASE WHEN v > 0 THEN 1 ELSE 0 END, id", 'ABS(COALESCE(v, 0)), id',
        "LENGTH(COALESCE(s, '')), id",
      ];
      PEXPRS.forEach(p => OEXPRS.forEach(o => {
        t(`V49H ROW_NUMBER OVER (PARTITION BY ${p} ORDER BY ${o})`, () => {
          const r = q(`SELECT id, ROW_NUMBER() OVER (PARTITION BY ${p} ORDER BY ${o}) AS rn FROM v49_a`);
          if (r.error) throw new Error(r.error);
          return eq(r.data.length, 150);
        });
      }));
      OEXPRS.forEach(o => {
        t(`V49H SUM OVER (ORDER BY ${o}) runs`, () => {
          const r = q(`SELECT SUM(id) OVER (ORDER BY ${o} ROWS UNBOUNDED PRECEDING) AS s FROM v49_a`);
          if (r.error) throw new Error(r.error);
          return eq(r.data.length, 150);
        });
      });
      t('V49H ROW_NUMBER partitioned by a nested function agrees with the model', () => {
        const got = rows("SELECT id, ROW_NUMBER() OVER (PARTITION BY CONCAT(g, '-', CAST(id % 2 AS TEXT)) ORDER BY id) AS rn FROM v49_a ORDER BY id")
          .map(r => r.rn);
        const seen = new Map();
        const want = R.map(r => {
          const k = `${r.g}-${r.id % 2}`;
          const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n;
        });
        return eq(got, want);
      });
      t('V49H ORDER BY an expression inside OVER agrees with the model', () => {
        const got = rows('SELECT id, ROW_NUMBER() OVER (ORDER BY ABS(COALESCE(v, 0)), id) AS rn FROM v49_a ORDER BY id')
          .map(r => r.rn);
        const sorted = R.slice().sort((a, b) =>
          Math.abs(a.v === null ? 0 : a.v) - Math.abs(b.v === null ? 0 : b.v) || a.id - b.id);
        const pos = new Map();
        sorted.forEach((r, i) => pos.set(r.id, i + 1));
        return eq(got, R.map(r => pos.get(r.id)));
      });
      t('V49H a top-level ORDER BY still applies alongside a window ORDER BY', () => {
        const got = rows('SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v49_a ORDER BY id DESC LIMIT 3');
        return eq(got, [{ id: 149, rn: 150 }, { id: 148, rn: 149 }, { id: 147, rn: 148 }]);
      });
      t('V49H a window is filtered with QUALIFY, not WHERE', () => {
        const got = rows('SELECT id FROM v49_a QUALIFY ROW_NUMBER() OVER (ORDER BY id) <= 3 ORDER BY id');
        return eq(got.map(r => r.id), [0, 1, 2]);
      });
      err('V49H a window function in WHERE is refused',
          'SELECT id FROM v49_a WHERE ROW_NUMBER() OVER (ORDER BY id) = 1', 'not allowed in where');

      // ============================================================
      // 片付け
      // ============================================================
      t('V49Zz cleanup', () => {
        ['v49_a', 'v49_b', 'v49_n', 'v49_f', 'v49_tg', 'v49_au', 'v49_d', 'v49_ty',
         'v49_dup', 'v49_e', 'v49_e2', 'v49_iw'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v49_') === 0).length === 0;
      });

      return T;
    }
