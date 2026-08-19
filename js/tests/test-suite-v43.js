    // ============================================================================
    // [Test Suite v43] - コマンド全網羅 (1/6): 数値関数 53 種・文字列関数 60 種
    //
    //   SHOW FUNCTIONS が返す実装済み関数のうち Numeric / String の全件を対象に、
    //   「関数 × 入力バッテリ」の総当たりで検証する。期待値は SQL からではなく
    //   JavaScript 側の参照実装から求める（両側が同じバグで相殺しないようにする）。
    //
    //     A. 単項数値関数 × 入力バッテリ
    //     B. 二項数値関数 × 入力行列
    //     C. 数値関数の NULL 伝播（引数のどれが NULL でも NULL）
    //     D. 数値関数を列へ適用し全行を突き合わせる
    //     E. 単項文字列関数 × 入力バッテリ
    //     F. 二項・三項文字列関数 × 引数の組
    //     G. 文字列関数を列へ適用し全行を突き合わせる
    //     H. 関数の入れ子・合成
    //     I. WHERE / GROUP BY / ORDER BY / HAVING の中での関数
    //     J. 引数個数の誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV43Tests() のスプレッドで合流する
    // ============================================================================
    function getV43Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };
      const val = (name, sql, want) => t(name, () => eq(one(sql), want));
      // 浮動小数の比較。参照実装も engine も同じ JS の Math を使うので通常は完全一致するが、
      // 演算順序の違いで最下位桁がずれうる箇所だけこちらを使う
      const close = (name, sql, want) => t(name, () => {
        const got = one(sql);
        if (want === null || got === null) return eq(got, want);
        if (Math.abs(got - want) > 1e-9 * Math.max(1, Math.abs(want)))
          throw new Error('expected ' + want + ' but got ' + got);
        return true;
      });
      // SQL リテラル化
      const lit = (v) => v === null ? 'NULL'
        : (typeof v === 'string' ? "'" + v.split("'").join("''") + "'" : String(v));

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      const NUMS = [];      // 数値列の元データ（参照実装と共有する）
      const STRS = [];      // 文字列列の元データ
      t('V43 fixture', () => {
        ['v43_n', 'v43_s'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        q('CREATE TABLE v43_n (id INT, x DECIMAL(18,4), y INT)');
        NUMS.length = 0;
        // 0 / 正 / 負 / 小数 / 大きい値 / NULL をひととおり含む 60 行
        for (let i = 0; i < 60; i++) {
          const x = (i % 7 === 6) ? null : ((i - 30) * 1.25);
          const y = (i % 11 === 10) ? null : (i - 25);
          NUMS.push({ id: i, x, y });
        }
        q('INSERT INTO v43_n VALUES ' + NUMS.map(r => `(${r.id}, ${lit(r.x)}, ${lit(r.y)})`).join(','));
        q('CREATE TABLE v43_s (id INT, s TEXT, p TEXT)');
        STRS.length = 0;
        const words = ['Hello World', 'abc', '', '  pad  ', 'ABC', 'a,b,c', 'Robert', 'xxabcxx',
                       'The quick brown fox', 'MiXeD CaSe', '123', 'a', 'ZZ', 'x.y.z', 'tab\there'];
        for (let i = 0; i < 45; i++) {
          const s = (i % 9 === 8) ? null : words[i % words.length];
          STRS.push({ id: i, s, p: ['a', 'b', 'o', 'x', ','][i % 5] });
        }
        q('INSERT INTO v43_s VALUES ' + STRS.map(r => `(${r.id}, ${lit(r.s)}, ${lit(r.p)})`).join(','));
        return db.tables['v43_n'].rowCount === 60 && db.tables['v43_s'].rowCount === 45;
      });

      // ============================================================
      // 参照実装（JavaScript 側で期待値を独立に求める）
      // ============================================================
      const utf8len = (s) => {
        let n = 0;
        for (const ch of s) {
          const c = ch.codePointAt(0);
          n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        }
        return n;
      };
      const utf8bytes = (s) => {
        const out = [];
        for (const ch of s) {
          const c = ch.codePointAt(0);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
          else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
          else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return out;
      };
      const popcnt64 = (n) => {
        let b = BigInt(Math.trunc(n));
        if (b < 0n) b += (1n << 64n);
        let c = 0;
        while (b > 0n) { if (b & 1n) c++; b >>= 1n; }
        return c;
      };
      const soundex = (s0) => {
        const s = String(s0).toUpperCase().replace(/[^A-Z]/g, '');
        if (!s) return '';
        const code = (c) => 'BFPV'.includes(c) ? '1' : 'CGJKQSXZ'.includes(c) ? '2'
          : 'DT'.includes(c) ? '3' : c === 'L' ? '4' : 'MN'.includes(c) ? '5' : c === 'R' ? '6' : '';
        let out = s[0], prev = code(s[0]);
        for (let i = 1; i < s.length; i++) {
          const c = s[i], d = code(c);
          if (d && d !== prev) out += d;
          if (c !== 'H' && c !== 'W') prev = d;
          if (out.length === 4) break;
        }
        return (out + '000').slice(0, 4);
      };
      // 丸めは「ゼロから遠い方向へ」。10^d を掛けてから丸めると 2.345 のような
      // 二進で表せない値がずれるので、engine と同じく絶対値側で丸める
      const roundTo = (n, d) => {
        const f = Math.pow(10, Math.trunc(d));
        return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
      };
      const truncTo = (n, d) => {
        const f = Math.pow(10, Math.trunc(d));
        return Math.trunc(n * f) / f;
      };
      // 参照実装側も NaN / Infinity は NULL に揃える（engine と同じ取り決め）。
      // JSON.stringify は NaN も Infinity も "null" と出すので、揃えておかないと
      // 差分が「null vs null」という読めない形で出る
      const fin = (v) => (typeof v === 'number' && !isFinite(v)) ? null : v;
      // IEEE 754 の「最近接、半数は偶数へ」。JS の Math.round は半数を常に上へ丸めるので使えない
      const rint = (x) => {
        const f = Math.floor(x), d = x - f;
        return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
      };
      const gcd2 = (a, b) => {
        a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b));
        while (b) { const r = a % b; a = b; b = r; }
        return a;
      };

      // ============================================================
      // A. 単項数値関数 × 入力バッテリ
      // ============================================================
      const UN_NUM = [
        ['ABS', a => Math.abs(a)],
        ['SIGN', a => Math.sign(a)],
        ['CEIL', a => Math.ceil(a)],
        ['CEILING', a => Math.ceil(a)],
        ['FLOOR', a => Math.floor(a)],
        ['SQRT', a => a < 0 ? null : Math.sqrt(a)],
        ['CBRT', a => Math.cbrt(a)],
        ['EXP', a => Math.exp(a)],
        ['LN', a => a <= 0 ? null : Math.log(a)],
        ['LOG10', a => a <= 0 ? null : Math.log10(a)],
        ['LOG2', a => a <= 0 ? null : Math.log2(a)],
        ['SIN', a => Math.sin(a)],
        ['COS', a => Math.cos(a)],
        ['TAN', a => Math.tan(a)],
        ['ASIN', a => Math.abs(a) > 1 ? null : Math.asin(a)],
        ['ACOS', a => Math.abs(a) > 1 ? null : Math.acos(a)],
        ['ATAN', a => Math.atan(a)],
        ['SINH', a => Math.sinh(a)],
        ['COSH', a => Math.cosh(a)],
        ['TANH', a => Math.tanh(a)],
        ['COT', a => 1 / Math.tan(a)],
        ['DEGREES', a => a * 180 / Math.PI],
        ['RADIANS', a => a * Math.PI / 180],
        ['SQUARE', a => a * a],
        ['BIT_COUNT', a => popcnt64(a)],
        ['BITNOT', a => -Math.trunc(a) - 1],
        ['ROUND', a => roundTo(a, 0)],
        ['TRUNC', a => truncTo(a, 0)],
        ['TRUNCATE', a => truncTo(a, 0)],
      ];
      const NUM_IN = [0, 1, -1, 2.5, -2.5, 16, 100, -7, 0.5, -0.25];
      UN_NUM.forEach(([fn, ref]) => {
        NUM_IN.forEach(a => {
          const want = fin(ref(a));
          const nm = `V43A ${fn}(${a})`;
          if (want === null || Number.isInteger(want)) val(nm, `SELECT ${fn}(${a}) AS r`, want);
          else close(nm, `SELECT ${fn}(${a}) AS r`, want);
        });
        val(`V43A ${fn}(NULL) is NULL`, `SELECT ${fn}(NULL) AS r`, null);
      });

      // 定義域の外・特別な入力
      val('V43A SQRT of a negative is NULL', 'SELECT SQRT(-9) AS r', null);
      val('V43A LN(0) is NULL', 'SELECT LN(0) AS r', null);
      val('V43A LOG10(0) is NULL', 'SELECT LOG10(0) AS r', null);
      val('V43A ASIN out of range is NULL', 'SELECT ASIN(2) AS r', null);
      val('V43A ACOS out of range is NULL', 'SELECT ACOS(-2) AS r', null);
      val('V43A EXP(0) is 1', 'SELECT EXP(0) AS r', 1);
      close('V43A PI', 'SELECT PI() AS r', Math.PI);
      val('V43A PI rounded to 4 places', 'SELECT ROUND(PI(), 4) AS r', 3.1416);
      [0, 1, 5, 10, 16].forEach(n => {
        let f = 1; for (let i = 2; i <= n; i++) f *= i;
        val(`V43A FACTORIAL(${n})`, `SELECT FACTORIAL(${n}) AS r`, f);
      });
      val('V43A FACTORIAL of a negative is NULL', 'SELECT FACTORIAL(-1) AS r', null);
      val('V43A FACTORIAL truncates a fraction', 'SELECT FACTORIAL(4.9) AS r', 24);
      [['12', 1], ['ab', 0], ['', 0], ['1.5', 1], ['-3', 1], ['1e3', 1], ['1,2', 0]].forEach(([s, w]) => {
        val(`V43A ISNUMERIC(${lit(s)})`, `SELECT ISNUMERIC(${lit(s)}) AS r`, w);
      });
      [[0, '0 bytes'], [1023, '1023 bytes'], [1024, '1.00 KB'], [1048576, '1.00 MB'],
       [1073741824, '1.00 GB']].forEach(([n, w]) => {
        val(`V43A FORMAT_BYTES(${n})`, `SELECT FORMAT_BYTES(${n}) AS r`, w);
      });
      val('V43A CRC32 of abc', "SELECT CRC32('abc') AS r", 891568578);
      val('V43A CRC32 of the empty string', "SELECT CRC32('') AS r", 0);
      t('V43A RAND stays inside [0, 1)', () => {
        for (let i = 0; i < 20; i++) { const v = one('SELECT RAND() AS r'); if (!(v >= 0 && v < 1)) throw new Error('out of range: ' + v); }
        return true;
      });
      t('V43A RANDOM stays inside [0, 1)', () => {
        for (let i = 0; i < 20; i++) { const v = one('SELECT RANDOM() AS r'); if (!(v >= 0 && v < 1)) throw new Error('out of range: ' + v); }
        return true;
      });

      // ============================================================
      // B. 二項数値関数 × 入力行列
      // ============================================================
      const BI_NUM = [
        ['ATAN2', (a, b) => Math.atan2(a, b)],
        ['MOD', (a, b) => b === 0 ? null : a % b],
        ['POW', (a, b) => Math.pow(a, b)],
        ['POWER', (a, b) => Math.pow(a, b)],
        ['GCD', (a, b) => gcd2(a, b)],
        ['LCM', (a, b) => { const g = gcd2(a, b); return g === 0 ? 0 : Math.abs(Math.trunc(a) * Math.trunc(b)) / g; }],
        // Oracle の REMAINDER は「最近接の整数」に IEEE の半数偶数丸めを使う
        ['REMAINDER', (a, b) => b === 0 ? null : a - b * rint(a / b)],
        ['BITAND', (a, b) => Number(BigInt(Math.trunc(a)) & BigInt(Math.trunc(b)))],
        ['BITOR', (a, b) => Number(BigInt(Math.trunc(a)) | BigInt(Math.trunc(b)))],
        ['BITXOR', (a, b) => Number(BigInt(Math.trunc(a)) ^ BigInt(Math.trunc(b)))],
        ['GREATEST', (a, b) => Math.max(a, b)],
        ['LEAST', (a, b) => Math.min(a, b)],
        ['ROUND', (a, b) => roundTo(a, b)],
        ['TRUNC', (a, b) => truncTo(a, b)],
        ['TRUNCATE', (a, b) => truncTo(a, b)],
      ];
      const A_IN = [12, -12, 2.567, 0, 7.5];
      const B_IN = [0, 1, 2, 3, -2, 10];
      BI_NUM.forEach(([fn, ref]) => {
        A_IN.forEach(a => B_IN.forEach(b => {
          const want = fin(ref(a, b));
          const nm = `V43B ${fn}(${a}, ${b})`;
          if (want === null || Number.isInteger(want)) val(nm, `SELECT ${fn}(${a}, ${b}) AS r`, want);
          else close(nm, `SELECT ${fn}(${a}, ${b}) AS r`, want);
        }));
      });
      // シフトは負のシフト量を 0 と見なす（実装の取り決め）
      [[12, 0, 12], [12, 1, 24], [12, 2, 48], [12, 10, 12288], [12, -2, 0], [0, 3, 0], [-8, 1, -16]]
        .forEach(([a, b, w]) => val(`V43B SHIFTLEFT(${a}, ${b})`, `SELECT SHIFTLEFT(${a}, ${b}) AS r`, w));
      [[12, 0, 12], [12, 1, 6], [12, 2, 3], [12, 3, 1], [12, 10, 0], [12, -2, 0], [-8, 1, -4]]
        .forEach(([a, b, w]) => val(`V43B SHIFTRIGHT(${a}, ${b})`, `SELECT SHIFTRIGHT(${a}, ${b}) AS r`, w));
      // LOG は 1 引数なら自然対数、2 引数なら底つき（MySQL 互換）
      close('V43B LOG with one argument is the natural log', 'SELECT LOG(100) AS r', Math.log(100));
      val('V43B LOG base 2 of 8', 'SELECT LOG(2, 8) AS r', 3);
      val('V43B LOG base 10 of 100', 'SELECT LOG(10, 100) AS r', 2);
      // NANVL は第1引数が NaN のときだけ第2引数
      val('V43B NANVL passes a normal value through', 'SELECT NANVL(1, 2) AS r', 1);
      val('V43B NANVL keeps NULL as NULL', 'SELECT NANVL(NULL, 2) AS r', null);
      // WIDTH_BUCKET は範囲外に 0 と n+1 を割り当てる
      [[-1, 0], [0, 1], [1, 1], [2, 2], [5, 3], [9.99, 5], [10, 6], [11, 6]].forEach(([v, w]) => {
        val(`V43B WIDTH_BUCKET(${v}, 0, 10, 5)`, `SELECT WIDTH_BUCKET(${v}, 0, 10, 5) AS r`, w);
      });
      val('V43B WIDTH_BUCKET of NULL is NULL', 'SELECT WIDTH_BUCKET(NULL, 0, 10, 5) AS r', null);
      // 可変長引数
      val('V43B GREATEST over three values', 'SELECT GREATEST(1, 9, 3) AS r', 9);
      val('V43B LEAST over three values', 'SELECT LEAST(1, 9, 3) AS r', 1);
      val('V43B GREATEST with a NULL is NULL', 'SELECT GREATEST(1, NULL, 3) AS r', null);
      val('V43B LEAST with a NULL is NULL', 'SELECT LEAST(1, NULL, 3) AS r', null);
      val('V43B GREATEST over strings', "SELECT GREATEST('a', 'c', 'b') AS r", 'c');
      val('V43B LEAST over strings', "SELECT LEAST('a', 'c', 'b') AS r", 'a');
      // MOD の符号は被除数に従う（切り捨て除算）
      [[-7, 3, -1], [7, -3, 1], [-7, -3, -1], [7, 3, 1]].forEach(([a, b, w]) => {
        val(`V43B MOD(${a}, ${b}) follows the dividend sign`, `SELECT MOD(${a}, ${b}) AS r`, w);
      });
      // 負の桁数は 10 の位・100 の位へ丸める
      [[12345, -1, 12350], [12345, -2, 12300], [12345, -3, 12000], [12345, -4, 10000]].forEach(([a, d, w]) => {
        val(`V43B ROUND(${a}, ${d})`, `SELECT ROUND(${a}, ${d}) AS r`, w);
      });
      [[12345, -1, 12340], [12345, -2, 12300], [12345, -3, 12000]].forEach(([a, d, w]) => {
        val(`V43B TRUNCATE(${a}, ${d})`, `SELECT TRUNCATE(${a}, ${d}) AS r`, w);
      });
      // 半数の丸めはゼロから遠い方向へ（銀行家丸めではない）
      [[2.5, 3], [3.5, 4], [-2.5, -3], [-3.5, -4], [0.5, 1], [-0.5, -1]].forEach(([a, w]) => {
        val(`V43B ROUND(${a}) rounds away from zero`, `SELECT ROUND(${a}) AS r`, w);
      });

      // ============================================================
      // C. 数値関数の NULL 伝播
      // ============================================================
      const NUM_ALL_1 = ['ABS','ACOS','ASIN','ATAN','BIT_COUNT','BITNOT','CBRT','CEIL','CEILING','COS',
        'COSH','COT','CRC32','DEGREES','EXP','FACTORIAL','FLOOR','FORMAT_BYTES','LN','LOG10',
        'LOG2','RADIANS','ROUND','SIGN','SIN','SINH','SQRT','SQUARE','TAN','TANH','TRUNC','TRUNCATE'];
      NUM_ALL_1.forEach(fn => val(`V43C ${fn}(NULL) is NULL`, `SELECT ${fn}(NULL) AS r`, null));
      // ISNUMERIC だけは NULL でも 0 を返す（SQL Server と同じ。NULL は「数値ではない」）
      val('V43C ISNUMERIC(NULL) is 0', 'SELECT ISNUMERIC(NULL) AS r', 0);
      const NUM_ALL_2 = ['ATAN2','BITAND','BITOR','BITXOR','GCD','LCM','MOD','POW','POWER','REMAINDER',
        'SHIFTLEFT','SHIFTRIGHT','ROUND','TRUNC','TRUNCATE','GREATEST','LEAST'];
      NUM_ALL_2.forEach(fn => {
        val(`V43C ${fn}(NULL, 2) is NULL`, `SELECT ${fn}(NULL, 2) AS r`, null);
        val(`V43C ${fn}(12, NULL) is NULL`, `SELECT ${fn}(12, NULL) AS r`, null);
      });

      // ============================================================
      // D. 数値関数を列へ適用して全行を突き合わせる
      // ============================================================
      const colCheck = (name, sqlExpr, ref, src, key) => t(name, () => {
        const got = rows(`SELECT id, ${sqlExpr} AS r FROM ${src} ORDER BY id`).map(r => fin(r.r));
        const want = (src === 'v43_n' ? NUMS : STRS).map(row => row[key] === null ? null : fin(ref(row[key])));
        if (got.length !== want.length) throw new Error(`row count ${got.length} vs ${want.length}`);
        for (let i = 0; i < want.length; i++) {
          const a = got[i], b = want[i];
          if (a === null || b === null) { if (a !== b) throw new Error(`row ${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); continue; }
          if (typeof b === 'number' && !Number.isInteger(b)) {
            if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) throw new Error(`row ${i}: ${a} vs ${b}`);
          } else if (a !== b) throw new Error(`row ${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
        return true;
      });
      UN_NUM.forEach(([fn, ref]) => colCheck(`V43D ${fn} over a column`, `${fn}(x)`, ref, 'v43_n', 'x'));
      colCheck('V43D ABS over an integer column', 'ABS(y)', a => Math.abs(a), 'v43_n', 'y');
      colCheck('V43D SIGN over an integer column', 'SIGN(y)', a => Math.sign(a), 'v43_n', 'y');
      colCheck('V43D ROUND to 2 places over a column', 'ROUND(x, 2)', a => roundTo(a, 2), 'v43_n', 'x');
      colCheck('V43D TRUNCATE to 1 place over a column', 'TRUNCATE(x, 1)', a => truncTo(a, 1), 'v43_n', 'x');
      colCheck('V43D MOD by 3 over a column', 'MOD(y, 3)', a => a % 3, 'v43_n', 'y');
      colCheck('V43D POWER of 2 over a column', 'POWER(y, 2)', a => Math.pow(a, 2), 'v43_n', 'y');
      colCheck('V43D BIT_COUNT over a column', 'BIT_COUNT(y)', a => popcnt64(a), 'v43_n', 'y');

      // ============================================================
      // E. 単項文字列関数 × 入力バッテリ
      // ============================================================
      const UN_STR = [
        ['LENGTH', s => Array.from(s).length],
        ['LEN', s => Array.from(s.replace(/ +$/, '')).length],   // SQL Server の LEN は末尾の空白を数えない
        ['CHAR_LENGTH', s => Array.from(s).length],
        ['CHARACTER_LENGTH', s => Array.from(s).length],
        ['OCTET_LENGTH', s => utf8len(s)],
        ['BIT_LENGTH', s => utf8len(s) * 8],
        ['UPPER', s => s.toUpperCase()],
        ['LOWER', s => s.toLowerCase()],
        ['UCASE', s => s.toUpperCase()],
        ['LCASE', s => s.toLowerCase()],
        ['REVERSE', s => Array.from(s).reverse().join('')],
        ['LTRIM', s => s.replace(/^\s+/, '')],
        ['RTRIM', s => s.replace(/\s+$/, '')],
        ['TRIM', s => s.trim()],
        ['ASCII', s => s.length ? s.codePointAt(0) : 0],
        ['SOUNDEX', s => soundex(s)],
        ['HEX', s => utf8bytes(s).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('')],
        ['QUOTENAME', s => '[' + s.split(']').join(']]') + ']'],
        ['QUOTE_IDENT', s => '"' + s.split('"').join('""') + '"'],
        ['QUOTE_LITERAL', s => "'" + s.split("'").join("''") + "'"],
        // 語の区切りは英数字以外すべて（PostgreSQL / Oracle と同じ）
        ['INITCAP', s => s.toLowerCase().replace(/[a-z0-9]+/g, w => w[0].toUpperCase() + w.slice(1))],
      ];
      const STR_IN = ['Hello World', 'abc', '', '  pad  ', 'ABC', 'a,b,c', 'Robert', 'MiXeD CaSe', '123'];
      UN_STR.forEach(([fn, ref]) => {
        STR_IN.forEach(s => val(`V43E ${fn}(${lit(s)})`, `SELECT ${fn}(${lit(s)}) AS r`, ref(s)));
        val(`V43E ${fn}(NULL) is NULL`, `SELECT ${fn}(NULL) AS r`, null);
      });
      // QUOTE だけは NULL を文字列 'NULL' にする（SQLite / MySQL と同じ）
      STR_IN.forEach(s => val(`V43E QUOTE(${lit(s)})`, `SELECT QUOTE(${lit(s)}) AS r`, "'" + s.split("'").join("''") + "'"));
      val('V43E QUOTE(NULL) is the text NULL', 'SELECT QUOTE(NULL) AS r', 'NULL');
      // SPACE は繰り返し空白
      [0, 1, 3, 5].forEach(n => val(`V43E SPACE(${n})`, `SELECT SPACE(${n}) AS r`, ' '.repeat(n)));
      val('V43E SPACE(NULL) is NULL', 'SELECT SPACE(NULL) AS r', null);
      // SOUNDEX の定番の検証値
      [['Robert', 'R163'], ['Rupert', 'R163'], ['Tymczak', 'T522'], ['Ashcraft', 'A261'],
       ['Pfister', 'P236'], ['Honeyman', 'H555']].forEach(([s, w]) => {
        val(`V43E SOUNDEX(${lit(s)})`, `SELECT SOUNDEX(${lit(s)}) AS r`, w);
      });

      // ============================================================
      // F. 二項・三項文字列関数
      // ============================================================
      const SF = [
        ['LEFT', [["'Hello World', 3", 'Hel'], ["'Hello World', 0", ''], ["'Hello World', 99", 'Hello World'],
                  ["'Hello World', -1", ''], ["NULL, 3", null], ["'abc', NULL", null]]],
        ['RIGHT', [["'Hello World', 3", 'rld'], ["'Hello World', 0", ''], ["'Hello World', 99", 'Hello World'],
                   ["'Hello World', -1", ''], ["NULL, 3", null], ["'abc', NULL", null]]],
        ['REPEAT', [["'ab', 3", 'ababab'], ["'ab', 0", ''], ["'ab', 1", 'ab'], ["'ab', -1", null], ["'ab', NULL", null]]],
        ['REPLICATE', [["'ab', 3", 'ababab'], ["'ab', 0", ''], ["'ab', -1", null]]],
        ['INSTR', [["'Hello World', 'o'", 5], ["'Hello World', 'z'", 0], ["'Hello World', ''", 1],
                   ["'Hello World', 'World'", 7], ["NULL, 'a'", null], ["'abc', NULL", null]]],
        ['STRPOS', [["'Hello World', 'o'", 5], ["'Hello World', 'z'", 0], ["'Hello World', 'World'", 7]]],
        ['CHARINDEX', [["'o', 'Hello World'", 5], ["'z', 'Hello World'", 0], ["'o', 'Hello World', 6", 8]]],
        ['LOCATE', [["'o', 'Hello World'", 5], ["'o', 'Hello World', 6", 8], ["'z', 'Hello World'", 0]]],
        ['PATINDEX', [["'%o%', 'Hello World'", 5], ["'%z%', 'Hello World'", 0]]],
        ['STRCMP', [["'a', 'b'", -1], ["'b', 'a'", 1], ["'a', 'a'", 0], ["'a', NULL", null]]],
        ['CONCAT', [["'a', 'b'", 'ab'], ["'a', 'b', 'c'", 'abc'], ["'a', NULL", 'a'], ["'a', 1, 2", 'a12'], ["''", '']]],
        ['CONCAT_WS', [["'-', 'a', 'b'", 'a-b'], ["'-', 'a', NULL, 'b'", 'a-b'], ["NULL, 'a', 'b'", null],
                       ["'-', 'a'", 'a'], ["'', 'a', 'b'", 'ab']]],
        ['LPAD', [["'ab', 5", '   ab'], ["'ab', 5, '*'", '***ab'], ["'ab', 1, '*'", 'a'], ["'ab', 0, '*'", ''],
                  ["'abcdef', 3, '*'", 'abc'], ["'ab', NULL, '*'", null], ["'ab', 6, 'xy'", 'xyxyab']]],
        ['RPAD', [["'ab', 5", 'ab   '], ["'ab', 5, '*'", 'ab***'], ["'ab', 1, '*'", 'a'],
                  ["'abcdef', 3, '*'", 'abc'], ["'ab', NULL, '*'", null], ["'ab', 6, 'xy'", 'abxyxy']]],
        ['LTRIM', [["'xxabc', 'x'", 'abc'], ["'  abc'", 'abc'], ["'abc', 'x'", 'abc']]],
        ['RTRIM', [["'abcxx', 'x'", 'abc'], ["'abc  '", 'abc'], ["'abc', 'x'", 'abc']]],
        ['SUBSTR', [["'Hello World', 7", 'World'], ["'Hello World', 1, 5", 'Hello'], ["'Hello World', -5", 'World'],
                    ["'Hello World', -5, 3", 'Wor'], ["'Hello World', 7, 99", 'World'], ["'abc', 1, 0", ''],
                    ["'abc', 1, -1", ''], ["NULL, 1", null]]],
        ['SUBSTRING', [["'Hello World', 7", 'World'], ["'Hello World', 1, 5", 'Hello'],
                       ["'Hello World' FROM 7", 'World'], ["'Hello World' FROM 1 FOR 5", 'Hello']]],
        ['MID', [["'Hello World', 7", 'World'], ["'Hello World', 1, 5", 'Hello']]],
        ['SUBSTRING_INDEX', [["'a.b.c', '.', 2", 'a.b'], ["'a.b.c', '.', -2", 'b.c'], ["'a.b.c', '.', 0", ''],
                             ["'a.b.c', '.', 9", 'a.b.c'], ["'a.b.c', 'z', 1", 'a.b.c']]],
        ['SPLIT_PART', [["'a,b,c', ',', 1", 'a'], ["'a,b,c', ',', 2", 'b'], ["'a,b,c', ',', 9", ''],
                        ["'a,b,c', ',', -1", 'c']]],
        ['REPLACE', [["'aXbXc', 'X', '-'", 'a-b-c'], ["'abc', 'z', '-'", 'abc'], ["'abc', 'b', ''", 'ac'],
                     ["NULL, 'a', 'b'", null]]],
        ['TRANSLATE', [["'abc', 'ab', 'xy'", 'xyc'], ["'abc', 'abc', 'x'", 'x'], ["'abc', '', ''", 'abc'],
                       ["NULL, 'a', 'b'", null]]],
        ['OVERLAY', [["'abcdef' PLACING 'XY' FROM 2", 'aXYdef'], ["'abcdef' PLACING 'XY' FROM 2 FOR 3", 'aXYef'],
                     ["'abcdef', 'XY', 2", 'aXYdef'], ["'abcdef', 'XY', 2, 3", 'aXYef']]],
        ['STUFF', [["'abcdef', 2, 3, 'XY'", 'aXYef'], ["'abcdef', 2, 0, 'XY'", 'aXYbcdef'], ["'abcdef', 9, 1, 'XY'", null]]],
        ['INSERT', [["'abcdef', 2, 3, 'XY'", 'aXYef'], ["'abcdef', 0, 3, 'XY'", 'abcdef'], ["'abcdef', 9, 1, 'XY'", 'abcdef']]],
        ['ELT', [["2, 'a', 'b', 'c'", 'b'], ["1, 'a', 'b'", 'a'], ["0, 'a', 'b'", null], ["9, 'a', 'b'", null]]],
        ['FIELD', [["'b', 'a', 'b', 'c'", 2], ["'a', 'a', 'b'", 1], ["'z', 'a', 'b'", 0], ["NULL, 'a'", 0]]],
        ['CHAR', [["65", 'A'], ["65, 66", 'AB'], ["65.7", 'A']]],
        ['CHR', [["65", 'A'], ["97", 'a'], ["NULL", null]]],
        ['BIN', [["12", '1100'], ["0", '0'], ["255", '11111111'], ["NULL", null]]],
        ['OCT', [["8", '10'], ["0", '0'], ["64", '100']]],
        ['CONV', [["'ff', 16, 10", '255'], ["'255', 10, 16", 'FF'], ["'1010', 2, 10", '10'], ["'z', 36, 10", '35']]],
        ['HEX', [["255", 'FF'], ["'abc'", '616263'], ["0", '0']]],
        ['UNHEX', [["'616263'", 'abc'], ["'zz'", null], ["''", '']]],
        ['FORMAT', [["1234567.891, 2", '1,234,567.89'], ["1234567.891, 0", '1,234,568'],
                    ["1234.5, 4", '1,234.5000'], ["NULL, 2", null], ["0, 2", '0.00']]],
        ['STARTS_WITH', [["'Hello', 'He'", true], ["'Hello', 'lo'", false], ["'Hello', ''", true], ["NULL, 'a'", null]]],
        ['ENDS_WITH', [["'Hello', 'lo'", true], ["'Hello', 'He'", false], ["'Hello', ''", true]]],
        ['PARSENAME', [["'a.b.c', 1", 'c'], ["'a.b.c', 2", 'b'], ["'a.b.c', 3", 'a'], ["'a.b.c', 9", null]]],
      ];
      SF.forEach(([fn, cases]) => cases.forEach(([args, want]) => {
        val(`V43F ${fn}(${args})`, `SELECT ${fn}(${args}) AS r`, want);
      }));
      // TRIM の方向指定つき構文
      [["'x' FROM 'xxabcxx'", 'abc'], ["LEADING 'x' FROM 'xxabcxx'", 'abcxx'],
       ["TRAILING 'x' FROM 'xxabcxx'", 'xxabc'], ["BOTH 'x' FROM 'xxabcxx'", 'abc'],
       ["BOTH FROM '  abc  '", 'abc'], ["LEADING FROM '  abc  '", 'abc  '],
       ["TRAILING FROM '  abc  '", '  abc']].forEach(([args, want]) => {
        val(`V43F TRIM(${args})`, `SELECT TRIM(${args}) AS r`, want);
      });
      // POSITION は IN 構文
      val("V43F POSITION('o' IN 'Hello World')", "SELECT POSITION('o' IN 'Hello World') AS r", 5);
      val("V43F POSITION('z' IN 'Hello World')", "SELECT POSITION('z' IN 'Hello World') AS r", 0);
      // 連結演算子
      val('V43F the concatenation operator', "SELECT 'a' || 'b' || 'c' AS r", 'abc');
      val('V43F concatenating a NULL yields NULL', "SELECT 'a' || NULL AS r", null);

      // 文字列関数の NULL 伝播（第1引数）
      ['LEFT','RIGHT','REPEAT','REPLICATE','INSTR','STRPOS','LPAD','RPAD','SUBSTR','SUBSTRING','MID',
       'SUBSTRING_INDEX','SPLIT_PART','REPLACE','TRANSLATE','STARTS_WITH','ENDS_WITH','PARSENAME',
       'STRCMP','LTRIM','RTRIM'].forEach(fn => {
        const extra = ['REPLACE','TRANSLATE'].includes(fn) ? ", 'a', 'b'"
          : ['SUBSTRING_INDEX','SPLIT_PART'].includes(fn) ? ", ',', 1"
          : ['SUBSTR','SUBSTRING','MID','LEFT','RIGHT','REPEAT','REPLICATE','PARSENAME'].includes(fn) ? ', 1'
          : ['LPAD','RPAD'].includes(fn) ? ', 3'
          : ", 'a'";
        val(`V43F ${fn} propagates a NULL first argument`, `SELECT ${fn}(NULL${extra}) AS r`, null);
      });

      // ============================================================
      // G. 文字列関数を列へ適用して全行を突き合わせる
      // ============================================================
      UN_STR.forEach(([fn, ref]) => colCheck(`V43G ${fn} over a column`, `${fn}(s)`, ref, 'v43_s', 's'));
      colCheck('V43G LEFT 3 over a column', 'LEFT(s, 3)', s => s.slice(0, 3), 'v43_s', 's');
      colCheck('V43G RIGHT 3 over a column', 'RIGHT(s, 3)', s => s.length ? s.slice(-3) : '', 'v43_s', 's');
      colCheck('V43G SUBSTR 2,4 over a column', 'SUBSTR(s, 2, 4)', s => s.slice(1, 5), 'v43_s', 's');
      colCheck('V43G REPLACE over a column', "REPLACE(s, 'a', 'A')", s => s.split('a').join('A'), 'v43_s', 's');
      colCheck('V43G LPAD 12 over a column', "LPAD(s, 12, '.')",
        s => s.length >= 12 ? s.slice(0, 12) : '.'.repeat(12 - s.length) + s, 'v43_s', 's');
      colCheck('V43G INSTR over a column', "INSTR(s, 'o')", s => s.indexOf('o') + 1, 'v43_s', 's');
      // CONCAT は NULL の引数を読み飛ばす（PostgreSQL 方式）ので NULL 行も '!' になる
      t('V43G CONCAT over a column skips NULL', () => {
        const got = rows("SELECT id, CONCAT(s, '!') AS r FROM v43_s ORDER BY id").map(r => r.r);
        return eq(got, STRS.map(r => (r.s === null ? '' : r.s) + '!'));
      });

      // ============================================================
      // H. 関数の入れ子・合成
      // ============================================================
      val('V43H UPPER inside LEFT', "SELECT UPPER(LEFT('hello world', 5)) AS r", 'HELLO');
      val('V43H LEFT inside UPPER', "SELECT LEFT(UPPER('hello world'), 5) AS r", 'HELLO');
      val('V43H TRIM inside LENGTH', "SELECT LENGTH(TRIM('  abc  ')) AS r", 3);
      val('V43H four functions nested', "SELECT UPPER(REVERSE(TRIM(SUBSTR('  abcdef  ', 3, 6)))) AS r", 'FEDCBA');
      val('V43H ABS inside ROUND', 'SELECT ROUND(ABS(-2.567), 2) AS r', 2.57);
      val('V43H ROUND inside ABS', 'SELECT ABS(ROUND(-2.567, 2)) AS r', 2.57);
      val('V43H arithmetic between two functions', "SELECT LENGTH('abcd') * ABS(-3) AS r", 12);
      val('V43H a function on both sides of a comparison', "SELECT LENGTH('abc') = ABS(-3) AS r", true);
      close('V43H five numeric functions nested', 'SELECT SQRT(ABS(FLOOR(-16.7))) AS r', Math.sqrt(17));
      val('V43H CONCAT of several function results',
          "SELECT CONCAT(UPPER('a'), LOWER('B'), LEFT('cde', 1)) AS r", 'Abc');
      // 深い入れ子（30 段）
      t('V43H thirty nested ABS calls', () => {
        let e = '-5';
        for (let i = 0; i < 30; i++) e = `ABS(${e})`;
        return eq(one(`SELECT ${e} AS r`), 5);
      });
      t('V43H thirty nested TRIM calls', () => {
        let e = "'  x  '";
        for (let i = 0; i < 30; i++) e = `TRIM(${e})`;
        return eq(one(`SELECT ${e} AS r`), 'x');
      });
      t('V43H a chain of alternating string functions', () => {
        let e = "'abc'";
        for (let i = 0; i < 15; i++) e = i % 2 === 0 ? `UPPER(${e})` : `LOWER(${e})`;
        return eq(one(`SELECT ${e} AS r`), 'ABC');
      });
      // 40 個の関数呼び出しを 1 つの式に並べる
      t('V43H forty function calls added together', () => {
        const parts = [];
        for (let i = 1; i <= 40; i++) parts.push(`ABS(-${i})`);
        return eq(one(`SELECT ${parts.join(' + ')} AS r`), 820);
      });
      t('V43H forty string function calls concatenated', () => {
        const parts = [];
        for (let i = 0; i < 40; i++) parts.push(`LEFT('${String.fromCharCode(97 + (i % 26))}z', 1)`);
        let want = '';
        for (let i = 0; i < 40; i++) want += String.fromCharCode(97 + (i % 26));
        return eq(one(`SELECT CONCAT(${parts.join(', ')}) AS r`), want);
      });

      // ============================================================
      // I. 句の中での関数
      // ============================================================
      t('V43I a numeric function in WHERE', () => {
        const got = one('SELECT COUNT(*) AS c FROM v43_n WHERE ABS(x) > 20');
        const want = NUMS.filter(r => r.x !== null && Math.abs(r.x) > 20).length;
        return eq(got, want);
      });
      t('V43I a string function in WHERE', () => {
        const got = one("SELECT COUNT(*) AS c FROM v43_s WHERE LENGTH(s) > 3");
        const want = STRS.filter(r => r.s !== null && Array.from(r.s).length > 3).length;
        return eq(got, want);
      });
      t('V43I a function in GROUP BY', () => {
        const got = rows('SELECT SIGN(y) AS g, COUNT(*) AS c FROM v43_n WHERE y IS NOT NULL GROUP BY SIGN(y) ORDER BY g');
        const m = new Map();
        NUMS.filter(r => r.y !== null).forEach(r => { const k = Math.sign(r.y); m.set(k, (m.get(k) || 0) + 1); });
        const want = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([g, c]) => ({ g, c }));
        return eq(got, want);
      });
      t('V43I a function in ORDER BY', () => {
        const got = rows('SELECT id FROM v43_n WHERE x IS NOT NULL ORDER BY ABS(x), id').map(r => r.id);
        const want = NUMS.filter(r => r.x !== null)
          .sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || a.id - b.id).map(r => r.id);
        return eq(got, want);
      });
      t('V43I a function in HAVING', () => {
        const got = rows('SELECT SIGN(y) AS g FROM v43_n WHERE y IS NOT NULL GROUP BY SIGN(y) HAVING COUNT(*) > 1 ORDER BY g')
          .map(r => r.g);
        const m = new Map();
        NUMS.filter(r => r.y !== null).forEach(r => { const k = Math.sign(r.y); m.set(k, (m.get(k) || 0) + 1); });
        const want = [...m.entries()].filter(([, c]) => c > 1).map(([g]) => g).sort((a, b) => a - b);
        return eq(got, want);
      });
      t('V43I a function inside an aggregate', () => {
        const got = one('SELECT SUM(ABS(x)) AS s FROM v43_n');
        const want = NUMS.reduce((a, r) => a + (r.x === null ? 0 : Math.abs(r.x)), 0);
        return Math.abs(got - want) < 1e-9 || eq(got, want);
      });
      t('V43I a function applied to an aggregate', () => {
        const got = one('SELECT ROUND(AVG(y), 3) AS s FROM v43_n');
        const vs = NUMS.filter(r => r.y !== null).map(r => r.y);
        return eq(got, roundTo(vs.reduce((a, b) => a + b, 0) / vs.length, 3));
      });
      t('V43I a function inside CASE', () => {
        const got = rows("SELECT id, CASE WHEN ABS(x) > 20 THEN 'big' ELSE 'small' END AS k FROM v43_n WHERE x IS NOT NULL ORDER BY id")
          .map(r => r.k);
        const want = NUMS.filter(r => r.x !== null).map(r => Math.abs(r.x) > 20 ? 'big' : 'small');
        return eq(got, want);
      });
      t('V43I a function in a join condition', () => {
        const got = one('SELECT COUNT(*) AS c FROM v43_n a JOIN v43_n b ON ABS(a.y) = ABS(b.y) AND a.id < b.id');
        let want = 0;
        for (let i = 0; i < NUMS.length; i++) for (let j = i + 1; j < NUMS.length; j++) {
          if (NUMS[i].y !== null && NUMS[j].y !== null && Math.abs(NUMS[i].y) === Math.abs(NUMS[j].y)) want++;
        }
        return eq(got, want);
      });
      t('V43I a function in a subquery filter', () => {
        const got = one('SELECT COUNT(*) AS c FROM v43_n WHERE ABS(y) IN (SELECT ABS(y) FROM v43_n WHERE y < -20)');
        const inner = new Set(NUMS.filter(r => r.y !== null && r.y < -20).map(r => Math.abs(r.y)));
        const want = NUMS.filter(r => r.y !== null && inner.has(Math.abs(r.y))).length;
        return eq(got, want);
      });
      t('V43I a function in DISTINCT', () => {
        const got = rows('SELECT DISTINCT SIGN(y) AS g FROM v43_n WHERE y IS NOT NULL ORDER BY g').map(r => r.g);
        const want = [...new Set(NUMS.filter(r => r.y !== null).map(r => Math.sign(r.y)))].sort((a, b) => a - b);
        return eq(got, want);
      });

      // ============================================================
      // J. 引数個数・型の誤りは拒否される
      // ============================================================
      err('V43J ABS with no argument', 'SELECT ABS() AS r');
      err('V43J ABS with two arguments', 'SELECT ABS(1, 2) AS r');
      err('V43J SQRT with two arguments', 'SELECT SQRT(1, 2) AS r');
      err('V43J POWER with one argument', 'SELECT POWER(2) AS r');
      err('V43J ATAN2 with one argument', 'SELECT ATAN2(1) AS r');
      err('V43J LENGTH with no argument', 'SELECT LENGTH() AS r');
      err('V43J LEFT with one argument', "SELECT LEFT('abc') AS r");
      err('V43J REPLACE with two arguments', "SELECT REPLACE('abc', 'a') AS r");
      err('V43J an unknown function is reported', 'SELECT NOSUCHFUNC(1) AS r', 'does not exist');
      err('V43J an unknown function suggests a close name', 'SELECT LENGHT(1) AS r', 'length');
      err('V43J WIDTH_BUCKET with three arguments', 'SELECT WIDTH_BUCKET(1, 0, 10) AS r', 'parameter count');
      err('V43J TRUNC with three arguments', 'SELECT TRUNC(1, 2, 3) AS r', 'parameter count');
      err('V43J BITAND with one argument', 'SELECT BITAND(1) AS r', 'parameter count');
      err('V43J SOUNDEX with two arguments', "SELECT SOUNDEX('a', 'b') AS r", 'parameter count');
      err('V43J MAKETIME with two arguments', 'SELECT MAKETIME(1, 2) AS r', 'parameter count');
      err('V43J DATE_TRUNC with one argument', "SELECT DATE_TRUNC('day') AS r", 'parameter count');
      err('V43J CONCAT_WS with no values', "SELECT CONCAT_WS('-') AS r");

      // ============================================================
      // 片付け
      // ============================================================
      t('V43Zz cleanup', () => {
        ['v43_n', 'v43_s'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        return Object.keys(db.tables).filter(n => n.indexOf('v43_') === 0).length === 0;
      });

      return T;
    }
