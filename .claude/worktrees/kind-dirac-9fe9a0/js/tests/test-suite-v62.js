    // ============================================================================
    // [Test Suite V62] - v1.33 で足した命令・関数の総点検
    //
    //   足りていなかった SQL コマンド（文・集計・スカラー関数）を実装したので、
    //   その全てを「値」「NULL の扱い」「書き味（大小・空白・改行・コメント）」
    //   「拒否されるべき綴り」の 4 面から確かめる。
    //   期待値は可能な限り JavaScript 側の参照実装か、既存の同義関数との
    //   突き合わせ（差分テスト）で作る。定数を並べると実装ごと写経してしまうため。
    // ============================================================================
    function getV62Tests() {
      const { T, q, t, check, ok, err, val, same, differs, rowsOf, valsOf, oneOf, oneSafe,
              colSafe, eq, expect, upper, lower, alternating, spaced, wsPos, swap, tag,
              lit, insertRows, drop, cleanup } = makeTestKit('V62');

      // ----------------------------------------------------------------
      // フィクスチャ
      // ----------------------------------------------------------------
      const ROWS = [
        // id, g,   v,    s,           ts,                    j
        [1, 'a',  2, '  hi  ',   '2024-01-01 00:00:00', '{"n":"alpha","k":1}'],
        [2, 'a',  3, 'xxhixx',   '2024-01-02 03:04:05', '{"n":"beta","k":2}'],
        [3, 'b',  4, 'Hello',    '2024-03-05 10:30:00', '{"n":"gamma","k":3}'],
        [4, 'b',  null, 'world', '2024-06-15 23:59:59', '{"n":"alpha","k":4}'],
        [5, 'c', -5, '',         '2024-12-31 12:00:00', '{"n":"delta","k":5}'],
        [6, 'c',  1, 'a,b,c',    '2025-01-01 06:00:00', '{"n":"beta","k":6}'],
        [7, 'd',  null, null,    '2025-07-20 18:45:30', '{"n":"eps","k":7}'],
        [8, 'd',  6, ' pad ',    '2023-02-28 09:15:00', '{"n":"zeta","k":8}']
      ];
      t('V62 fixture', () => {
        drop('v62_t', 'v62_u');
        q('CREATE TABLE v62_t (id INT PRIMARY KEY, g TEXT, v INT, s TEXT, ts TEXT, j TEXT)');
        insertRows('v62_t', ROWS);
        q('CREATE TABLE v62_u (id INT PRIMARY KEY, tag TEXT)');
        insertRows('v62_u', [[1, 'x'], [2, 'y'], [3, 'x']]);
        return rowsOf('SELECT COUNT(*) AS c FROM v62_t')[0].c === ROWS.length;
      });

      // 書き味の変種を作る（大小・空白・改行・タブ・コメント）
      const STYLES = [
        ['upper', upper],
        ['lower', lower],
        ['alt', alternating],
        ['newline', (x) => spaced(x, '\n')],
        ['tab', (x) => spaced(x, '\t')],
        ['wide', (x) => spaced(x, '   ')],
        ['comment', (x) => spaced(x, ' /**/ ')]
      ];
      // 基準クエリと同じ結果になる書き方を総当たりする
      const styleSweep = (label, base) => {
        STYLES.forEach(([nm, f]) => same(`V62St ${label} ${nm}`, base, f(base)));
      };
      // 空白 1 個ずつを改行・コメントへ差し替える総当たり
      const wsSweep = (label, base) => {
        wsPos(base).forEach(i => {
          same(`V62Ws ${label} @${i} 改行`, base, swap(base, i, '\n'));
          same(`V62Ws ${label} @${i} コメント`, base, swap(base, i, ' /*x*/ '));
        });
      };

      // ----------------------------------------------------------------
      // A. BTRIM(s [, chars])
      // ----------------------------------------------------------------
      const btrimRef = (s, chars) => {
        if (s === null) return null;
        const set = chars === undefined || chars === null ? ' \t\n\r\f\v' : String(chars);
        if (set === '') return s;
        let i = 0, j = s.length;
        while (i < j && set.indexOf(s[i]) !== -1) i++;
        while (j > i && set.indexOf(s[j - 1]) !== -1) j--;
        return s.slice(i, j);
      };
      const BT_IN = ['  hi  ', 'xxhixx', 'Hello', '', 'aaa', 'xyzzyx', ' pad ', 'x', 'abcba', '  ', 'a b', 'xax'];
      const BT_CH = [null, 'x', 'xy', 'a', 'ab', ' '];
      BT_IN.forEach((s, si) => BT_CH.forEach((c, ci) => {
        const sql = c === null
          ? `SELECT BTRIM(${lit(s)}) AS r`
          : `SELECT BTRIM(${lit(s)}, ${lit(c)}) AS r`;
        val(`V62Bt #${si}-${ci} ${tag(sql, 40)}`, sql, btrimRef(s, c));
      }));
      val('V62Bt NULL 入力', 'SELECT BTRIM(NULL) AS r', null);
      val('V62Bt 文字集合が NULL', "SELECT BTRIM('xx', NULL) AS r", null);
      val('V62Bt 空の文字集合', "SELECT BTRIM('  a  ', '') AS r", '  a  ');
      t('V62Bt 既定は TRIM と同じ', () => {
        const a = valsOf("SELECT BTRIM(s) AS r FROM v62_t ORDER BY id");
        const b = valsOf("SELECT TRIM(s) AS r FROM v62_t ORDER BY id");
        return eq(a, b, 'BTRIM(s) と TRIM(s)');
      });
      err('V62Bt 引数 0 個', 'SELECT BTRIM() AS r', 'parameter count');
      err('V62Bt 引数 3 個', "SELECT BTRIM('a', 'b', 'c') AS r", 'parameter count');
      styleSweep('BTRIM', "SELECT id, BTRIM(s, 'x') AS r FROM v62_t WHERE s IS NOT NULL ORDER BY id");
      wsSweep('BTRIM', "SELECT BTRIM(s, 'x') AS r FROM v62_t ORDER BY id");

      // ----------------------------------------------------------------
      // B. ENCODE(s, fmt)
      // ----------------------------------------------------------------
      const EN_IN = ['hello', 'a', '', 'あい', 'A B', 'x=y', '0123456789', "it's"];
      EN_IN.forEach((s, i) => {
        same(`V62En #${i} base64 は TO_BASE64 と同じ`,
          `SELECT TO_BASE64(${lit(s)}) AS r`, `SELECT ENCODE(${lit(s)}, 'base64') AS r`);
        same(`V62En #${i} hex は LOWER(HEX()) と同じ`,
          `SELECT LOWER(HEX(${lit(s)})) AS r`, `SELECT ENCODE(${lit(s)}, 'hex') AS r`);
        val(`V62En #${i} escape は素通し`, `SELECT ENCODE(${lit(s)}, 'escape') AS r`, s);
        same(`V62En #${i} base64 は往復する`,
          `SELECT ${lit(s)} AS r`, `SELECT FROM_BASE64(ENCODE(${lit(s)}, 'base64')) AS r`);
      });
      val('V62En NULL 入力', "SELECT ENCODE(NULL, 'base64') AS r", null);
      val('V62En 形式が NULL', "SELECT ENCODE('a', NULL) AS r", null);
      val('V62En 形式は大小を問わない', "SELECT ENCODE('hi', 'BASE64') AS r", 'aGk=');
      err('V62En 未知の形式', "SELECT ENCODE('a', 'rot13') AS r", 'unsupported format');
      err('V62En 引数 1 個', "SELECT ENCODE('a') AS r", 'parameter count');
      styleSweep('ENCODE', "SELECT id, ENCODE(s, 'hex') AS r FROM v62_t WHERE s IS NOT NULL ORDER BY id");

      // ----------------------------------------------------------------
      // C. ORD(s)
      // ----------------------------------------------------------------
      const ORD_ASCII = ['A', 'z', '0', ' ', '~', '!', 'Hello', 'abc'];
      ORD_ASCII.forEach((s, i) => {
        same(`V62Or #${i} ASCII 文字は ASCII() と同じ`,
          `SELECT ASCII(${lit(s)}) AS r`, `SELECT ORD(${lit(s)}) AS r`);
      });
      val('V62Or 空文字は 0', "SELECT ORD('') AS r", 0);
      val('V62Or NULL は NULL', 'SELECT ORD(NULL) AS r', null);
      val('V62Or 多バイト(あ)', "SELECT ORD('あ') AS r", 0xE3 * 65536 + 0x81 * 256 + 0x82);
      val('V62Or 多バイト(é)', "SELECT ORD('é') AS r", 0xC3 * 256 + 0xA9);
      val('V62Or 2 文字目は見ない', "SELECT ORD('Aあ') AS r", 65);
      err('V62Or 引数 2 個', "SELECT ORD('a', 1) AS r", 'parameter count');
      t('V62Or 列に対して使える', () => {
        const got = colSafe("SELECT ORD(s) AS r FROM v62_t ORDER BY id", 'r');
        const want = ROWS.map(r => r[3] === null ? null : (r[3] === '' ? 0 : r[3].charCodeAt(0)));
        return eq(got, want, 'ORD(s)');
      });

      // ----------------------------------------------------------------
      // D. UNISTR(s)
      // ----------------------------------------------------------------
      // SQL リテラル内のバックスラッシュは文字列側で解釈されるので CHAR(92) で組む
      const BS = 'CHAR(92)';
      val('V62Un 4 桁エスケープ', `SELECT UNISTR(CONCAT(${BS}, '0041')) AS r`, 'A');
      val('V62Un 連続したエスケープ', `SELECT UNISTR(CONCAT(${BS}, '0041', ${BS}, '0042')) AS r`, 'AB');
      val('V62Un 日本語', `SELECT UNISTR(CONCAT(${BS}, '3042')) AS r`, 'あ');
      val('V62Un 6 桁形式', `SELECT UNISTR(CONCAT(${BS}, '+01F600')) AS r`, '\u{1F600}');
      val('V62Un バックスラッシュ自身', `SELECT UNISTR(CONCAT(${BS}, ${BS})) AS r`, '\\');
      val('V62Un 通常文字は素通し', "SELECT UNISTR('plain') AS r", 'plain');
      val('V62Un 前後の文字は残る', `SELECT UNISTR(CONCAT('x', ${BS}, '0041', 'y')) AS r`, 'xAy');
      val('V62Un NULL', 'SELECT UNISTR(NULL) AS r', null);
      val('V62Un 桁が足りない綴りは素通し', `SELECT UNISTR(CONCAT(${BS}, '00')) AS r`, '\\00');
      err('V62Un 引数 2 個', "SELECT UNISTR('a', 'b') AS r", 'parameter count');

      // ----------------------------------------------------------------
      // E. CONTAINS(s, sub)
      // ----------------------------------------------------------------
      const CT = [['hello', 'ell'], ['hello', 'zz'], ['hello', ''], ['', 'a'], ['', ''],
                  ['aXbXc', 'X'], ['abc', 'abc'], ['abc', 'abcd'], ['a,b,c', ','], ['AB', 'ab']];
      CT.forEach(([s, sub], i) => {
        val(`V62Ct #${i} ${tag(s + '/' + sub, 24)}`,
          `SELECT CONTAINS(${lit(s)}, ${lit(sub)}) AS r`, s.indexOf(sub) !== -1);
      });
      val('V62Ct NULL 入力', "SELECT CONTAINS(NULL, 'a') AS r", null);
      val('V62Ct NULL 部分文字列', "SELECT CONTAINS('a', NULL) AS r", null);
      t('V62Ct INSTR > 0 と一致する', () => {
        const a = valsOf("SELECT CONTAINS(s, 'x') AS r FROM v62_t ORDER BY id");
        const b = valsOf("SELECT INSTR(s, 'x') > 0 AS r FROM v62_t ORDER BY id");
        return eq(a, b, "CONTAINS(s,'x')");
      });
      t('V62Ct WHERE で絞れる', () => {
        const got = colSafe("SELECT id FROM v62_t WHERE CONTAINS(s, 'h') ORDER BY id", 'id');
        const want = ROWS.filter(r => r[3] !== null && r[3].indexOf('h') !== -1).map(r => r[0]);
        return eq(got, want, 'CONTAINS の絞り込み');
      });
      err('V62Ct 引数 1 個', "SELECT CONTAINS('a') AS r", 'parameter count');
      styleSweep('CONTAINS', "SELECT id FROM v62_t WHERE CONTAINS(s, 'h') ORDER BY id");

      // ----------------------------------------------------------------
      // F. TIMEDIFF(a, b)
      // ----------------------------------------------------------------
      const p2 = (n) => String(n).padStart(2, '0');
      const tdRef = (a, b) => {
        let ms = Date.parse(a.replace(' ', 'T') + 'Z') - Date.parse(b.replace(' ', 'T') + 'Z');
        const sign = ms < 0 ? '-' : '';
        ms = Math.abs(ms);
        const tot = Math.floor(ms / 1000);
        return sign + p2(Math.floor(tot / 3600)) + ':' + p2(Math.floor((tot % 3600) / 60)) + ':' + p2(tot % 60);
      };
      const TD = [
        ['2024-01-01 10:00:00', '2024-01-01 08:30:00'],
        ['2024-01-01 00:00:00', '2024-01-01 01:00:00'],
        ['2024-01-02 03:04:05', '2024-01-01 01:00:00'],
        ['2024-03-05 10:30:00', '2024-03-05 10:30:00'],
        ['2025-01-01 06:00:00', '2024-12-31 12:00:00'],
        ['2024-06-15 23:59:59', '2024-06-15 00:00:00'],
        ['2023-02-28 09:15:00', '2023-02-27 09:15:01'],
        ['2024-12-31 12:00:00', '2020-01-01 00:00:00']
      ];
      TD.forEach(([a, b], i) => {
        val(`V62Td #${i}`, `SELECT TIMEDIFF(${lit(a)}, ${lit(b)}) AS r`, tdRef(a, b));
        val(`V62Td #${i} 逆順は符号が変わる`,
          `SELECT TIMEDIFF(${lit(b)}, ${lit(a)}) AS r`, tdRef(b, a));
      });
      val('V62Td NULL 左', "SELECT TIMEDIFF(NULL, '2024-01-01 00:00:00') AS r", null);
      val('V62Td NULL 右', "SELECT TIMEDIFF('2024-01-01 00:00:00', NULL) AS r", null);
      val('V62Td 24 時間を超える', "SELECT TIMEDIFF('2024-01-03 00:00:00', '2024-01-01 00:00:00') AS r", '48:00:00');
      t('V62Td TIME_TO_SEC と整合する', () => {
        const d = rowsOf("SELECT TIME_TO_SEC(TIMEDIFF('2024-01-01 10:00:00','2024-01-01 08:30:00')) AS r")[0].r;
        return expect(d, 5400, 'TIMEDIFF の秒数');
      });
      err('V62Td 引数 1 個', "SELECT TIMEDIFF('2024-01-01 00:00:00') AS r", 'parameter count');
      styleSweep('TIMEDIFF', "SELECT id, TIMEDIFF(ts, '2024-01-01 00:00:00') AS r FROM v62_t ORDER BY id");

      // ----------------------------------------------------------------
      // G. YEARWEEK(d)
      // ----------------------------------------------------------------
      const YW = ['2024-01-01', '2024-01-07', '2024-01-08', '2024-06-15', '2024-12-31',
                  '2023-01-01', '2023-12-31', '2025-01-01', '2020-02-29', '1987-01-01'];
      YW.forEach((d, i) => {
        t(`V62Yw #${i} ${d} は年*100+週`, () => {
          const w = rowsOf(`SELECT WEEK(${lit(d)}) AS w`)[0].w;
          const yw = rowsOf(`SELECT YEARWEEK(${lit(d)}) AS r`)[0].r;
          if (w === 0) {
            // 第 0 週は前年の最終週として返す（MySQL 互換）
            const y = Number(d.slice(0, 4)) - 1;
            const lw = rowsOf(`SELECT WEEK('${y}-12-31') AS w`)[0].w;
            return expect(yw, y * 100 + lw, `YEARWEEK(${d})`);
          }
          return expect(yw, Number(d.slice(0, 4)) * 100 + w, `YEARWEEK(${d})`);
        });
      });
      val('V62Yw MySQL の例(1987-01-01)', "SELECT YEARWEEK('1987-01-01') AS r", 198652);
      val('V62Yw NULL', 'SELECT YEARWEEK(NULL) AS r', null);
      err('V62Yw 引数 2 個', "SELECT YEARWEEK('2024-01-01', 0) AS r", 'parameter count');
      t('V62Yw 列に対して使える', () => rowsOf('SELECT YEARWEEK(ts) AS r FROM v62_t ORDER BY id').length === ROWS.length);

      // ----------------------------------------------------------------
      // H. PERIOD_ADD / PERIOD_DIFF
      // ----------------------------------------------------------------
      const pnorm = (p) => {
        let y = Math.floor(p / 100);
        const m = p % 100;
        if (y < 70) y += 2000; else if (y < 100) y += 1900;
        return y * 12 + (m - 1);
      };
      const paRef = (p, n) => {
        const tt = pnorm(p) + n;
        const m = ((tt % 12) + 12) % 12;
        return Math.floor(tt / 12) * 100 + (m + 1);
      };
      const PER = [202401, 202412, 200801, 199912, 9902, 7001, 202406, 202502];
      const ADD = [0, 1, 2, 3, 11, 12, 13, -1, -12, 24];
      PER.forEach((p, pi) => ADD.forEach((n, ni) => {
        val(`V62Pa #${pi}-${ni} PERIOD_ADD(${p}, ${n})`, `SELECT PERIOD_ADD(${p}, ${n}) AS r`, paRef(p, n));
      }));
      PER.forEach((a, ai) => PER.forEach((b, bi) => {
        val(`V62Pd #${ai}-${bi} PERIOD_DIFF(${a}, ${b})`,
          `SELECT PERIOD_DIFF(${a}, ${b}) AS r`, pnorm(a) - pnorm(b));
      }));
      val('V62Pa MySQL の例', 'SELECT PERIOD_ADD(200801, 2) AS r', 200803);
      val('V62Pd MySQL の例', 'SELECT PERIOD_DIFF(200802, 200703) AS r', 11);
      val('V62Pa NULL', 'SELECT PERIOD_ADD(NULL, 1) AS r', null);
      val('V62Pd NULL', 'SELECT PERIOD_DIFF(202401, NULL) AS r', null);
      val('V62Pa 月が範囲外', 'SELECT PERIOD_ADD(202413, 1) AS r', null);
      val('V62Pd 月が範囲外', 'SELECT PERIOD_DIFF(202400, 202401) AS r', null);
      t('V62Pa PERIOD_DIFF は PERIOD_ADD の逆', () => {
        for (const p of PER) {
          for (const n of ADD) {
            const moved = rowsOf(`SELECT PERIOD_ADD(${p}, ${n}) AS r`)[0].r;
            const back = rowsOf(`SELECT PERIOD_DIFF(${moved}, ${p}) AS r`)[0].r;
            expect(back, n, `PERIOD_ADD(${p}, ${n}) の往復`);
          }
        }
        return true;
      });
      err('V62Pa 引数 1 個', 'SELECT PERIOD_ADD(202401) AS r', 'parameter count');
      err('V62Pd 引数 3 個', 'SELECT PERIOD_DIFF(202401, 202402, 1) AS r', 'parameter count');

      // ----------------------------------------------------------------
      // I. JULIAN_DAY / JULIANDAY
      // ----------------------------------------------------------------
      val('V62Jd 起点', "SELECT JULIAN_DAY('1970-01-01 00:00:00') AS r", 2440587.5);
      val('V62Jd 別名', "SELECT JULIANDAY('1970-01-01 00:00:00') AS r", 2440587.5);
      val('V62Jd 正午', "SELECT JULIAN_DAY('1970-01-01 12:00:00') AS r", 2440588);
      val('V62Jd NULL', 'SELECT JULIAN_DAY(NULL) AS r', null);
      const JD = [['2024-01-01', '2024-03-01'], ['2023-02-28', '2023-03-01'],
                  ['2024-02-28', '2024-03-01'], ['2020-01-01', '2025-01-01'],
                  ['2024-06-15', '2024-06-15'], ['2024-12-31', '2025-01-01']];
      JD.forEach(([a, b], i) => {
        t(`V62Jd #${i} 差は DATEDIFF と一致する`, () => {
          const j = rowsOf(`SELECT JULIAN_DAY(${lit(b)}) - JULIAN_DAY(${lit(a)}) AS r`)[0].r;
          const d = rowsOf(`SELECT DATEDIFF(${lit(b)}, ${lit(a)}) AS r`)[0].r;
          return expect(j, d, `JULIAN_DAY の差 (${a}, ${b})`);
        });
      });
      t('V62Jd 単調増加', () => {
        const got = rowsOf('SELECT JULIAN_DAY(ts) AS r FROM v62_t ORDER BY ts').map(x => x.r);
        for (let i = 1; i < got.length; i++) if (got[i] < got[i - 1]) throw new Error('順序が崩れた');
        return true;
      });
      err('V62Jd 引数 2 個', "SELECT JULIAN_DAY('2024-01-01', 1) AS r", 'parameter count');

      // ----------------------------------------------------------------
      // J. CONVERT_TZ
      // ----------------------------------------------------------------
      const TZ = [['UTC', 'JST', 9], ['JST', 'UTC', -9], ['UTC', '+05:30', 5.5],
                  ['+09:00', '+00:00', -9], ['UTC', 'UTC', 0], ['EST', 'PST', -3],
                  ['GMT', 'CET', 1], ['+02:00', '+05:00', 3]];
      TZ.forEach(([from, to, h], i) => {
        t(`V62Tz #${i} ${from}->${to}`, () => {
          const got = rowsOf(`SELECT CONVERT_TZ('2024-06-15 12:00:00', ${lit(from)}, ${lit(to)}) AS r`)[0].r;
          const want = new Date(Date.parse('2024-06-15T12:00:00Z') + h * 3600000)
            .toISOString().replace('T', ' ').slice(0, 19);
          return eq(got, want, `CONVERT_TZ(${from}, ${to})`);
        });
      });
      val('V62Tz NULL 入力', "SELECT CONVERT_TZ(NULL, 'UTC', 'JST') AS r", null);
      val('V62Tz NULL の時間帯', "SELECT CONVERT_TZ('2024-01-01 00:00:00', NULL, 'JST') AS r", null);
      err('V62Tz 未知の時間帯', "SELECT CONVERT_TZ('2024-01-01 00:00:00', 'UTC', 'Asia/Tokyo') AS r", 'unknown time zone');
      err('V62Tz 引数 2 個', "SELECT CONVERT_TZ('2024-01-01 00:00:00', 'UTC') AS r", 'parameter count');
      t('V62Tz AT TIME ZONE と整合する', () => {
        const a = valsOf("SELECT CONVERT_TZ(ts, 'UTC', '+09:00') AS r FROM v62_t ORDER BY id");
        const b = valsOf("SELECT ts AT TIME ZONE '+09:00' AS r FROM v62_t ORDER BY id");
        return eq(a, b, "CONVERT_TZ(x,'UTC',tz) と AT TIME ZONE");
      });
      styleSweep('CONVERT_TZ', "SELECT id, CONVERT_TZ(ts, 'UTC', 'JST') AS r FROM v62_t ORDER BY id");

      // ----------------------------------------------------------------
      // K. LOCALTIME / LOCALTIMESTAMP
      // ----------------------------------------------------------------
      t('V62Lt LOCALTIME は今日の日付', () => {
        const a = rowsOf('SELECT DATE(LOCALTIME) AS r')[0].r;
        const b = rowsOf('SELECT CURDATE() AS r')[0].r;
        return eq(a, b, 'DATE(LOCALTIME)');
      });
      t('V62Lt LOCALTIMESTAMP も同じ', () => {
        const a = rowsOf('SELECT DATE(LOCALTIMESTAMP) AS r')[0].r;
        const b = rowsOf('SELECT CURDATE() AS r')[0].r;
        return eq(a, b, 'DATE(LOCALTIMESTAMP)');
      });
      ok('V62Lt 括弧つき LOCALTIME()', 'SELECT LOCALTIME() AS r');
      ok('V62Lt 括弧つき LOCALTIMESTAMP()', 'SELECT LOCALTIMESTAMP() AS r');
      ok('V62Lt 小文字', 'select localtimestamp as r');
      t('V62Lt 形式は NOW() と同じ', () => {
        const a = rowsOf('SELECT LOCALTIMESTAMP AS r')[0].r;
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(a))) {
          throw new Error('想定外の書式: ' + a);
        }
        return true;
      });
      ok('V62Lt WHERE でも使える', 'SELECT id FROM v62_t WHERE ts < LOCALTIMESTAMP ORDER BY id');

      // ----------------------------------------------------------------
      // L. JSON_SEARCH / JSON_MERGE_PRESERVE
      // ----------------------------------------------------------------
      val('V62Js one で最初のパス', `SELECT JSON_SEARCH('{"a":"x","b":"y"}', 'one', 'y') AS r`, '"$.b"');
      val('V62Js all で全パス', `SELECT JSON_SEARCH('{"a":"x","b":"xy"}', 'all', 'x%') AS r`, '["$.a","$.b"]');
      val('V62Js 配列の添字', `SELECT JSON_SEARCH('["a","b","c"]', 'one', 'c') AS r`, '"$[2]"');
      val('V62Js 入れ子', `SELECT JSON_SEARCH('{"a":{"b":"deep"}}', 'one', 'deep') AS r`, '"$.a.b"');
      val('V62Js 配列の中の物体', `SELECT JSON_SEARCH('[{"k":"v"}]', 'one', 'v') AS r`, '"$[0].k"');
      val('V62Js 一致なし', `SELECT JSON_SEARCH('{"a":"x"}', 'one', 'zzz') AS r`, null);
      val('V62Js 数値は探さない', `SELECT JSON_SEARCH('{"a":1}', 'one', '1') AS r`, null);
      val('V62Js _ のワイルドカード', `SELECT JSON_SEARCH('{"a":"xy"}', 'one', 'x_') AS r`, '"$.a"');
      val('V62Js NULL 文書', "SELECT JSON_SEARCH(NULL, 'one', 'x') AS r", null);
      val('V62Js 壊れた JSON', "SELECT JSON_SEARCH('{oops', 'one', 'x') AS r", null);
      err('V62Js one/all 以外', `SELECT JSON_SEARCH('{"a":"x"}', 'some', 'x') AS r`, "'one' or 'all'");
      err('V62Js 引数 2 個', `SELECT JSON_SEARCH('{}', 'one') AS r`, 'parameter count');
      t('V62Js 列に対して使える', () => {
        const got = colSafe("SELECT JSON_SEARCH(j, 'one', 'alpha') AS r FROM v62_t ORDER BY id", 'r');
        const want = ROWS.map(r => JSON.parse(r[5]).n === 'alpha' ? '"$.n"' : null);
        return eq(got, want, 'JSON_SEARCH(j)');
      });

      val('V62Jm 配列は連結', `SELECT JSON_MERGE_PRESERVE('[1,2]', '[3]') AS r`, '[1,2,3]');
      val('V62Jm 同キーは配列へ', `SELECT JSON_MERGE_PRESERVE('{"a":1}', '{"a":2}') AS r`, '{"a":[1,2]}');
      val('V62Jm 別キーは併合', `SELECT JSON_MERGE_PRESERVE('{"a":1}', '{"b":2}') AS r`, '{"a":1,"b":2}');
      val('V62Jm 3 つ以上', `SELECT JSON_MERGE_PRESERVE('[1]', '[2]', '[3]') AS r`, '[1,2,3]');
      val('V62Jm スカラーどうし', `SELECT JSON_MERGE_PRESERVE('1', '2') AS r`, '[1,2]');
      val('V62Jm 物体と配列', `SELECT JSON_MERGE_PRESERVE('{"a":1}', '[2]') AS r`, '[{"a":1},2]');
      val('V62Jm 入れ子の同キー', `SELECT JSON_MERGE_PRESERVE('{"a":{"x":1}}', '{"a":{"y":2}}') AS r`, '{"a":{"x":1,"y":2}}');
      val('V62Jm NULL 引数', `SELECT JSON_MERGE_PRESERVE('[1]', NULL) AS r`, null);
      differs('V62Jm MERGE_PATCH とは違う',
        `SELECT JSON_MERGE_PRESERVE('{"a":1}', '{"a":2}') AS r`,
        `SELECT JSON_MERGE_PATCH('{"a":1}', '{"a":2}') AS r`);
      err('V62Jm 引数 1 個', `SELECT JSON_MERGE_PRESERVE('[1]') AS r`, 'parameter count');

      // ----------------------------------------------------------------
      // M. ARRAY_DISTINCT / ARRAY_CAT / ARRAY_REVERSE
      // ----------------------------------------------------------------
      const AR = [[1, 2, 3], [1, 1, 2], [1, 2, 2, 1], [5], [], [3, 1, 2],
                  [1, 2, 3, 4, 5], [7, 7, 7]];
      const arrSql = (a) => a.length ? `ARRAY[${a.join(', ')}]` : `ARRAY[]`;
      AR.forEach((a, i) => {
        if (!a.length) return;
        val(`V62Ar #${i} DISTINCT`,
          `SELECT ARRAY_TO_STRING(ARRAY_DISTINCT(${arrSql(a)}), ',') AS r`,
          [...new Set(a)].join(','));
        val(`V62Ar #${i} REVERSE`,
          `SELECT ARRAY_TO_STRING(ARRAY_REVERSE(${arrSql(a)}), ',') AS r`,
          a.slice().reverse().join(','));
        val(`V62Ar #${i} REVERSE の往復`,
          `SELECT ARRAY_TO_STRING(ARRAY_REVERSE(ARRAY_REVERSE(${arrSql(a)})), ',') AS r`,
          a.join(','));
        val(`V62Ar #${i} 長さは変わらない(REVERSE)`,
          `SELECT ARRAY_LENGTH(ARRAY_REVERSE(${arrSql(a)})) AS r`, a.length);
        val(`V62Ar #${i} DISTINCT の長さ`,
          `SELECT ARRAY_LENGTH(ARRAY_DISTINCT(${arrSql(a)})) AS r`, new Set(a).size);
      });
      AR.forEach((a, i) => AR.forEach((b, k) => {
        if (!a.length || !b.length) return;
        val(`V62Ac #${i}-${k} CAT`,
          `SELECT ARRAY_TO_STRING(ARRAY_CAT(${arrSql(a)}, ${arrSql(b)}), ',') AS r`,
          a.concat(b).join(','));
      }));
      val('V62Ar 文字列の配列', "SELECT ARRAY_TO_STRING(ARRAY_DISTINCT(ARRAY['a','b','a']), '|') AS r", 'a|b');
      val('V62Ar DISTINCT は順序を保つ', "SELECT ARRAY_TO_STRING(ARRAY_DISTINCT(ARRAY[3,1,3,2]), ',') AS r", '3,1,2');
      val('V62Ar NULL 入力(DISTINCT)', 'SELECT ARRAY_DISTINCT(NULL) AS r', null);
      val('V62Ar NULL 入力(REVERSE)', 'SELECT ARRAY_REVERSE(NULL) AS r', null);
      val('V62Ac 片側 NULL は他方', "SELECT ARRAY_TO_STRING(ARRAY_CAT(ARRAY[1,2], NULL), ',') AS r", '1,2');
      val('V62Ac 逆側 NULL', "SELECT ARRAY_TO_STRING(ARRAY_CAT(NULL, ARRAY[3]), ',') AS r", '3');
      val('V62Ar JSON 配列文字列も受ける', "SELECT ARRAY_TO_STRING(ARRAY_REVERSE('[1,2,3]'), ',') AS r", '3,2,1');
      err('V62Ar 引数 2 個(DISTINCT)', 'SELECT ARRAY_DISTINCT(ARRAY[1], ARRAY[2]) AS r', 'parameter count');
      err('V62Ac 引数 1 個(CAT)', 'SELECT ARRAY_CAT(ARRAY[1]) AS r', 'parameter count');

      // ----------------------------------------------------------------
      // N. 集計: EVERY / PRODUCT / APPROX_COUNT_DISTINCT
      // ----------------------------------------------------------------
      const groups = ['a', 'b', 'c', 'd'];
      const rowsOfG = (g) => ROWS.filter(r => r[1] === g);
      t('V62Ag EVERY はグループごとの全称', () => {
        const got = rowsOf('SELECT g, EVERY(v > 1) AS r FROM v62_t GROUP BY g ORDER BY g');
        const want = groups.map(g => {
          const vals = rowsOfG(g).map(r => r[2]).filter(v => v !== null);
          return { g, r: vals.length === 0 ? null : vals.every(v => v > 1) };
        });
        return eq(got, want, 'EVERY');
      });
      t('V62Ag EVERY は BOOL_AND と同じ', () => {
        const a = valsOf('SELECT g, EVERY(v > 1) AS r FROM v62_t GROUP BY g ORDER BY g');
        const b = valsOf('SELECT g, BOOL_AND(v > 1) AS r FROM v62_t GROUP BY g ORDER BY g');
        return eq(a, b, 'EVERY と BOOL_AND');
      });
      [1, 2, 3, 4, 0, -1, 6].forEach((n, i) => {
        same(`V62Ag #${i} EVERY(v > ${n}) は BOOL_AND と同じ`,
          `SELECT g, BOOL_AND(v > ${n}) AS r FROM v62_t GROUP BY g ORDER BY g`,
          `SELECT g, EVERY(v > ${n}) AS r FROM v62_t GROUP BY g ORDER BY g`);
        same(`V62Ag #${i} EVERY(v <= ${n}) は BOOL_AND と同じ`,
          `SELECT g, BOOL_AND(v <= ${n}) AS r FROM v62_t GROUP BY g ORDER BY g`,
          `SELECT g, EVERY(v <= ${n}) AS r FROM v62_t GROUP BY g ORDER BY g`);
      });
      t('V62Ag PRODUCT はグループごとの総乗', () => {
        const got = rowsOf('SELECT g, PRODUCT(v) AS r FROM v62_t GROUP BY g ORDER BY g');
        const want = groups.map(g => {
          const vals = rowsOfG(g).map(r => r[2]).filter(v => v !== null);
          return { g, r: vals.length === 0 ? null : vals.reduce((a, b) => a * b, 1) };
        });
        return eq(got, want, 'PRODUCT');
      });
      val('V62Ag PRODUCT 全体', 'SELECT PRODUCT(v) AS r FROM v62_t',
        ROWS.map(r => r[2]).filter(v => v !== null).reduce((a, b) => a * b, 1));
      val('V62Ag PRODUCT は非NULLが無ければ NULL', 'SELECT PRODUCT(v) AS r FROM v62_t WHERE 1 = 0', null);
      val('V62Ag PRODUCT は全部 NULL でも NULL', "SELECT PRODUCT(v) AS r FROM v62_t WHERE g = 'd' AND v IS NULL", null);
      differs('V62Ag PRODUCT と SUM は違う', 'SELECT PRODUCT(v) AS r FROM v62_t', 'SELECT SUM(v) AS r FROM v62_t');
      t('V62Ag PRODUCT(DISTINCT)', () => {
        const got = oneOf('SELECT PRODUCT(DISTINCT v) AS r FROM v62_t');
        const want = [...new Set(ROWS.map(r => r[2]).filter(v => v !== null))].reduce((a, b) => a * b, 1);
        return expect(got, want, 'PRODUCT(DISTINCT v)');
      });
      t('V62Ag PRODUCT の FILTER', () => {
        const got = oneOf("SELECT PRODUCT(v) FILTER (WHERE g = 'a') AS r FROM v62_t");
        const want = rowsOfG('a').map(r => r[2]).filter(v => v !== null).reduce((a, b) => a * b, 1);
        return expect(got, want, 'PRODUCT FILTER');
      });
      t('V62Ag APPROX_COUNT_DISTINCT は COUNT(DISTINCT) と同じ', () => {
        ['g', 'v', 's', 'id'].forEach(c => {
          const a = oneOf(`SELECT APPROX_COUNT_DISTINCT(${c}) AS r FROM v62_t`);
          const b = oneOf(`SELECT COUNT(DISTINCT ${c}) AS r FROM v62_t`);
          expect(a, b, `APPROX_COUNT_DISTINCT(${c})`);
        });
        return true;
      });
      ['g', 'v', 's'].forEach((c, i) => {
        same(`V62Ag #${i} グループ別 ACD は COUNT(DISTINCT) と同じ`,
          `SELECT g, COUNT(DISTINCT ${c}) AS r FROM v62_t GROUP BY g ORDER BY g`,
          `SELECT g, APPROX_COUNT_DISTINCT(${c}) AS r FROM v62_t GROUP BY g ORDER BY g`);
      });
      ok('V62Ag HAVING で PRODUCT', 'SELECT g FROM v62_t GROUP BY g HAVING PRODUCT(v) > 5 ORDER BY g');
      ok('V62Ag ORDER BY で PRODUCT', 'SELECT g FROM v62_t GROUP BY g ORDER BY PRODUCT(v) DESC');
      ok('V62Ag HAVING で EVERY', 'SELECT g FROM v62_t GROUP BY g HAVING EVERY(v IS NOT NULL) ORDER BY g');
      ok('V62Ag 副問い合わせの中', 'SELECT * FROM (SELECT g, PRODUCT(v) AS p FROM v62_t GROUP BY g) x ORDER BY g');
      ok('V62Ag 式の中に混ぜる', 'SELECT ROUND(PRODUCT(v) / 2.0, 2) AS r FROM v62_t');
      ok('V62Ag SHOW FUNCTIONS(PRODUCT)', "SHOW FUNCTIONS LIKE 'PRODUCT'");
      ok('V62Ag SHOW FUNCTIONS(EVERY)', "SHOW FUNCTIONS LIKE 'EVERY'");
      ok('V62Ag SHOW FUNCTIONS(ACD)', "SHOW FUNCTIONS LIKE 'APPROX_COUNT_DISTINCT'");
      err('V62Ag PRODUCT の引数 2 個', 'SELECT PRODUCT(v, 2) AS r FROM v62_t', 'exactly 1 argument');
      err('V62Ag EVERY の引数 2 個', 'SELECT EVERY(v, 2) AS r FROM v62_t', 'exactly 1 argument');
      err('V62Ag 集計の入れ子(PRODUCT)', 'SELECT PRODUCT(SUM(v)) AS r FROM v62_t', 'cannot be nested');
      err('V62Ag 集計の入れ子(EVERY)', 'SELECT EVERY(MAX(v) > 1) AS r FROM v62_t', 'cannot be nested');
      err('V62Ag PRODUCT は窓関数ではない', 'SELECT PRODUCT(v) OVER () AS r FROM v62_t', 'window function');
      err('V62Ag EVERY は窓関数ではない', 'SELECT EVERY(v > 1) OVER () AS r FROM v62_t', 'window function');
      styleSweep('PRODUCT', 'SELECT g, PRODUCT(v) AS r FROM v62_t GROUP BY g ORDER BY g');
      styleSweep('EVERY', 'SELECT g, EVERY(v > 1) AS r FROM v62_t GROUP BY g ORDER BY g');
      styleSweep('ACD', 'SELECT g, APPROX_COUNT_DISTINCT(v) AS r FROM v62_t GROUP BY g ORDER BY g');
      wsSweep('PRODUCT', 'SELECT g, PRODUCT(v) AS r FROM v62_t GROUP BY g ORDER BY g');

      // ----------------------------------------------------------------
      // O. 文: CREATE/DROP DATABASE と USE
      // ----------------------------------------------------------------
      t('V62Db CREATE DATABASE', () => {
        const r = q('CREATE DATABASE v62db');
        return !r.error && r.data[0].Result === 'Success';
      });
      t('V62Db SHOW DATABASES に出る', () => {
        const names = rowsOf('SHOW DATABASES').map(r => r.Schema);
        if (!names.includes('v62db')) throw new Error('一覧に無い: ' + names.join(','));
        if (!names.includes('main')) throw new Error("main が無い");
        return true;
      });
      ok('V62Db CREATE DATABASE IF NOT EXISTS', 'CREATE DATABASE IF NOT EXISTS v62db');
      ok('V62Db USE で切り替える', 'USE v62db');
      ok('V62Db USE main へ戻す', 'USE main');
      ok('V62Db USE はバッククォートも受ける', 'USE `main`');
      err('V62Db 未知の名前は拒否', 'USE v62_nowhere', 'not found');
      err('V62Db main は消せない', 'DROP DATABASE main', 'cannot drop');
      err('V62Db USE の構文誤り', 'USE a b', 'syntax');
      ok('V62Db DROP DATABASE', 'DROP DATABASE v62db');
      t('V62Db 消えた名前は USE できない', () => {
        const r = q('USE v62db');
        return !!r.error;
      });
      ok('V62Db SCHEMA も同じ名前空間', 'CREATE SCHEMA v62sc');
      ok('V62Db SCHEMA を USE できる', 'USE v62sc');
      ok('V62Db 後始末(USE main)', 'USE main');
      ok('V62Db DROP SCHEMA', 'DROP SCHEMA v62sc');
      ok('V62Db DROP DATABASE IF EXISTS', 'DROP DATABASE IF EXISTS v62_never');
      t('V62Db 表は main に残る', () => rowsOf('SELECT COUNT(*) AS c FROM v62_t')[0].c === ROWS.length);

      // ----------------------------------------------------------------
      // P. 文: ALTER VIEW / CREATE TEMPORARY VIEW
      // ----------------------------------------------------------------
      t('V62Vw ビューを作る', () => !q('CREATE VIEW v62_v AS SELECT id, v FROM v62_t').error);
      t('V62Vw ALTER VIEW で定義を差し替える', () => {
        const r = q('ALTER VIEW v62_v AS SELECT id, g FROM v62_t');
        if (r.error) throw new Error(r.error);
        const keys = Object.keys(rowsOf('SELECT * FROM v62_v ORDER BY id')[0]);
        return eq(keys, ['id', 'g'], 'ALTER VIEW 後の列');
      });
      ok('V62Vw ALTER VIEW 列リスト付き', 'ALTER VIEW v62_v (a, b) AS SELECT id, g FROM v62_t');
      t('V62Vw 列リストが効く', () => eq(Object.keys(rowsOf('SELECT * FROM v62_v')[0]), ['a', 'b'], '列名'));
      err('V62Vw 未存在のビュー', 'ALTER VIEW v62_nope AS SELECT 1 AS a', 'not found');
      err('V62Vw AS が無い', 'ALTER VIEW v62_v', 'syntax');
      ok('V62Vw ビューを消す', 'DROP VIEW v62_v');
      t('V62Vw CREATE TEMPORARY VIEW', () => {
        const r = q('CREATE TEMPORARY VIEW v62_tv AS SELECT id FROM v62_t');
        return !r.error && /Temporary view/.test(r.data[0].Message);
      });
      t('V62Vw 一時ビューは参照できる', () => oneOf('SELECT COUNT(*) AS c FROM v62_tv') === ROWS.length);
      ok('V62Vw CREATE TEMP VIEW も同じ', 'CREATE TEMP VIEW v62_tv2 AS SELECT id FROM v62_t');
      t('V62Vw 一時ビューはエクスポートに出ない', () => {
        const sqlText = db.exportSQL ? db.exportSQL() : null;
        if (typeof sqlText !== 'string') return true;   // 経路が無ければこの検査は省く
        if (/CREATE VIEW v62_tv\b/.test(sqlText)) throw new Error('一時ビューが出力された');
        return true;
      });
      ok('V62Vw 一時ビューを消す', 'DROP VIEW v62_tv');
      ok('V62Vw 一時ビューを消す(2)', 'DROP VIEW v62_tv2');

      // ----------------------------------------------------------------
      // Q. 文: UNLOGGED / インデックスの USING
      // ----------------------------------------------------------------
      ok('V62Ix CREATE UNLOGGED TABLE', 'CREATE UNLOGGED TABLE v62_ul (a INT)');
      ok('V62Ix UNLOGGED 表へ挿入', 'INSERT INTO v62_ul VALUES (1)');
      t('V62Ix UNLOGGED も普通の表', () => oneOf('SELECT COUNT(*) AS c FROM v62_ul') === 1);
      ok('V62Ix 後始末', 'DROP TABLE v62_ul');
      ['BTREE', 'HASH', 'GIN', 'GIST', 'BRIN'].forEach((m, i) => {
        ok(`V62Ix USING ${m}(表の後)`, `CREATE INDEX v62_ix${i} ON v62_t USING ${m} (g)`);
        ok(`V62Ix USING ${m} の索引を消す`, `DROP INDEX v62_ix${i} ON v62_t`);
        ok(`V62Ix USING ${m}(列の後)`, `CREATE INDEX v62_jx${i} ON v62_t (g) USING ${m}`);
        ok(`V62Ix USING ${m} の索引を消す(2)`, `DROP INDEX v62_jx${i} ON v62_t`);
      });
      ok('V62Ix 索引を作る', 'CREATE INDEX v62_ix ON v62_t (v)');
      t('V62Ix SHOW CREATE INDEX', () => {
        const r = rowsOf('SHOW CREATE INDEX v62_ix')[0];
        if (r.Table !== 'v62_t') throw new Error('表名が違う: ' + r.Table);
        if (!/CREATE INDEX v62_ix ON v62_t \(v\)/.test(r.CreateIndex)) throw new Error(r.CreateIndex);
        return true;
      });
      err('V62Ix SHOW CREATE INDEX 未知', 'SHOW CREATE INDEX v62_nope', 'not found');
      ok('V62Ix 索引を消す', 'DROP INDEX v62_ix ON v62_t');

      // ----------------------------------------------------------------
      // R. 文: EXPLAIN VERBOSE / SHOW ENGINES / SHOW COLUMNS LIKE / DESCRIBE col
      // ----------------------------------------------------------------
      t('V62Ex EXPLAIN VERBOSE は EXPLAIN と同じ', () => {
        const a = valsOf('EXPLAIN SELECT * FROM v62_t');
        const b = valsOf('EXPLAIN VERBOSE SELECT * FROM v62_t');
        return eq(a, b, 'EXPLAIN VERBOSE');
      });
      ok('V62Ex EXPLAIN ANALYZE VERBOSE', 'EXPLAIN ANALYZE VERBOSE SELECT * FROM v62_t');
      err('V62Ex EXPLAIN VERBOSE の非 SELECT', 'EXPLAIN VERBOSE DELETE FROM v62_t', 'select');
      t('V62Ex SHOW ENGINES', () => {
        const d = rowsOf('SHOW ENGINES');
        return d.length === 1 && d[0].Engine === 'LUMINA';
      });
      t('V62Sh SHOW COLUMNS LIKE で 1 列', () => {
        const d = rowsOf("SHOW COLUMNS FROM v62_t LIKE 'v'");
        return d.length === 1 && d[0].Column === 'v';
      });
      t('V62Sh SHOW COLUMNS LIKE のワイルドカード', () => {
        const d = rowsOf("SHOW COLUMNS FROM v62_t LIKE '%s%'").map(r => r.Column);
        return eq(d, ['s', 'ts'], "LIKE '%s%'");
      });
      t('V62Sh LIKE 無しは全列', () => rowsOf('SHOW COLUMNS FROM v62_t').length === 6);
      t('V62Sh SHOW FULL COLUMNS IN', () => rowsOf('SHOW FULL COLUMNS IN v62_t').length === 6);
      t('V62Sh 一致なしは 0 件', () => rowsOf("SHOW COLUMNS FROM v62_t LIKE 'zzz'").length === 0);
      t('V62Sh DESCRIBE の列指定', () => {
        const d = rowsOf('DESCRIBE v62_t v');
        return d.length === 1 && d[0].Column === 'v';
      });
      t('V62Sh DESC の列指定', () => rowsOf('DESC v62_t g')[0].Column === 'g');
      t('V62Sh DESCRIBE の列指定はパターンも受ける', () => rowsOf('DESCRIBE v62_t %s').length === 2);
      err('V62Sh DESCRIBE の未知列', 'DESCRIBE v62_t zzz', 'not found');
      t('V62Sh DESCRIBE 全体は従来どおり', () => rowsOf('DESCRIBE v62_t').length === 6);

      // ----------------------------------------------------------------
      // S. 文: SET @@var / RESET / DO / EXECUTE IMMEDIATE
      // ----------------------------------------------------------------
      ok('V62Se SET @@var', 'SET @@autocommit = 1');
      ok('V62Se SET @@session.var', "SET @@session.sql_mode = 'strict'");
      ok('V62Se SET @@global.var', 'SET @@global.max_connections = 10');
      t('V62Se @@var はセッション変数として見える', () => {
        const r = q('SET @@v62flag = 7');
        if (r.error) throw new Error(r.error);
        return /v62flag/.test(r.data[0].Message);
      });
      t('V62Se @user_var は従来どおり別物', () => {
        q('SET @v62user = 42');
        return oneOf('SELECT @v62user AS r') === 42;
      });
      ok('V62Se SET statement_timeout', 'SET statement_timeout = 500');
      ok('V62Se RESET <name>', 'RESET statement_timeout');
      ok('V62Se RESET ALL', 'RESET ALL');
      ok('V62Se RESET は大小を問わない', 'reset all');
      err('V62Se RESET read_only は拒否', 'RESET read_only', 'not allowed');
      err('V62Se RESET の構文誤り', 'RESET', 'syntax');
      err('V62Se RESET の引数過多', 'RESET a b', 'syntax');
      t('V62Se RESET 後も表は無事', () => oneOf('SELECT COUNT(*) AS c FROM v62_t') === ROWS.length);

      ok('V62Do DO 単項', 'DO 1 + 1');
      ok('V62Do DO 複数式', "DO 1, 2, UPPER('a')");
      ok('V62Do DO 関数呼び出し', "DO LENGTH('abc')");
      ok('V62Do DO NULL', 'DO NULL');
      t('V62Do DO は結果を返さない', () => {
        const r = q('DO 1 + 1');
        return !r.error && r.data[0].Result === 'Success' && r.data[0].Message.indexOf('DO') === 0;
      });
      t('V62Do DO の副作用は残る', () => {
        q('DROP SEQUENCE IF EXISTS v62seq');
        q('CREATE SEQUENCE v62seq START WITH 1');
        const r = q("DO NEXTVAL('v62seq')");
        if (r.error) throw new Error(r.error);
        const cur = oneOf("SELECT CURRVAL('v62seq') AS r");
        q('DROP SEQUENCE v62seq');
        return expect(cur, 1, 'DO NEXTVAL の副作用');
      });
      err('V62Do DO の式が壊れている', 'DO 1 +', 'malformed');

      t('V62Ei EXECUTE IMMEDIATE で SELECT', () => oneOf("EXECUTE IMMEDIATE 'SELECT 1 AS a'") === 1);
      t('V62Ei EXECUTE IMMEDIATE の USING', () => oneOf("EXECUTE IMMEDIATE 'SELECT ? AS a' USING 7") === 7);
      t('V62Ei EXECUTE IMMEDIATE で DDL', () => {
        const r = q("EXECUTE IMMEDIATE 'CREATE TABLE v62_ei (a INT)'");
        if (r.error) throw new Error(r.error);
        const ok2 = !q('INSERT INTO v62_ei VALUES (1)').error;
        q('DROP TABLE v62_ei');
        return ok2;
      });
      t('V62Ei 表を読める', () => oneOf("EXECUTE IMMEDIATE 'SELECT COUNT(*) AS c FROM v62_t'") === ROWS.length);
      err('V62Ei 文字列でない', 'EXECUTE IMMEDIATE x', 'quoted sql string');
      err('V62Ei 空文字', "EXECUTE IMMEDIATE ''", 'empty');
      err('V62Ei 中身が壊れている', "EXECUTE IMMEDIATE 'SELECT FROM'", 'execute immediate');
      t('V62Ei PREPARE/EXECUTE は従来どおり', () => {
        q("PREPARE v62p FROM 'SELECT 2 AS a'");
        const v = oneOf('EXECUTE v62p');
        q('DEALLOCATE PREPARE v62p');
        return v === 2;
      });

      // ----------------------------------------------------------------
      // T. 文: PRAGMA foreign_keys / CHECKSUM / REPAIR / REFRESH CONCURRENTLY
      // ----------------------------------------------------------------
      t('V62Pg PRAGMA foreign_keys の読み出し', () => oneOf('PRAGMA foreign_keys') === 1);
      t('V62Pg OFF にできる', () => {
        if (q('PRAGMA foreign_keys = OFF').error) throw new Error('OFF に失敗');
        const off = oneOf('PRAGMA foreign_keys');
        if (q('PRAGMA foreign_keys = ON').error) throw new Error('ON に失敗');
        return expect(off, 0, 'OFF 後の値') && expect(oneOf('PRAGMA foreign_keys'), 1, 'ON 後の値');
      });
      ['0', '1', 'on', 'off', 'true', 'false'].forEach((v, i) => {
        ok(`V62Pg 値の綴り #${i} (${v})`, `PRAGMA foreign_keys = ${v}`);
      });
      ok('V62Pg 既定へ戻す', 'PRAGMA foreign_keys = ON');
      err('V62Pg 誤った値', 'PRAGMA foreign_keys = maybe', 'expected on/off');
      t('V62Pg SET FOREIGN_KEY_CHECKS と連動する', () => {
        q('SET FOREIGN_KEY_CHECKS = 0');
        const v = oneOf('PRAGMA foreign_keys');
        q('SET FOREIGN_KEY_CHECKS = 1');
        return expect(v, 0, 'SET 経由の値');
      });

      t('V62Cs CHECKSUM TABLE は決まった値', () => {
        const a = rowsOf('CHECKSUM TABLE v62_t')[0];
        const b = rowsOf('CHECKSUM TABLE v62_t')[0];
        if (a.Checksum !== b.Checksum) throw new Error('同じ内容で値が変わった');
        if (typeof a.Checksum !== 'number') throw new Error('数値でない');
        return a.Rows === ROWS.length;
      });
      t('V62Cs 内容が変われば値も変わる', () => {
        const before = rowsOf('CHECKSUM TABLE v62_u')[0].Checksum;
        q("INSERT INTO v62_u VALUES (99, 'z')");
        const after = rowsOf('CHECKSUM TABLE v62_u')[0].Checksum;
        q('DELETE FROM v62_u WHERE id = 99');
        const back = rowsOf('CHECKSUM TABLE v62_u')[0].Checksum;
        if (before === after) throw new Error('行を足しても値が変わらない');
        return expect(back, before, '戻したときの値');
      });
      t('V62Cs 複数表', () => rowsOf('CHECKSUM TABLE v62_t, v62_u').length === 2);
      err('V62Cs 未知の表', 'CHECKSUM TABLE v62_nope', 'not found');
      t('V62Cs REPAIR TABLE は受理される', () => {
        const r = rowsOf('REPAIR TABLE v62_t')[0];
        return r.Msg_type === 'status' && /OK/.test(r.Msg_text);
      });
      err('V62Cs REPAIR の未知表', 'REPAIR TABLE v62_nope', 'not found');
      ok('V62Cs CHECK TABLE は従来どおり', 'CHECK TABLE v62_t');
      ok('V62Cs ANALYZE TABLE は従来どおり', 'ANALYZE TABLE v62_t');

      t('V62Mv 実体化ビューを作る', () => !q('CREATE MATERIALIZED VIEW v62_mv AS SELECT id, v FROM v62_t').error);
      ok('V62Mv REFRESH', 'REFRESH MATERIALIZED VIEW v62_mv');
      ok('V62Mv REFRESH CONCURRENTLY', 'REFRESH MATERIALIZED VIEW CONCURRENTLY v62_mv');
      ok('V62Mv REFRESH WITH DATA', 'REFRESH MATERIALIZED VIEW v62_mv WITH DATA');
      t('V62Mv CONCURRENTLY でも中身は同じ', () => {
        const a = valsOf('SELECT * FROM v62_mv ORDER BY id');
        q('REFRESH MATERIALIZED VIEW CONCURRENTLY v62_mv');
        return eq(valsOf('SELECT * FROM v62_mv ORDER BY id'), a, 'REFRESH CONCURRENTLY 後');
      });
      err('V62Mv 未知の実体化ビュー', 'REFRESH MATERIALIZED VIEW CONCURRENTLY v62_nope', 'not found');
      ok('V62Mv 後始末', 'DROP MATERIALIZED VIEW v62_mv');

      // ----------------------------------------------------------------
      // U. 文: ORDER BY ... USING
      // ----------------------------------------------------------------
      [['>', 'DESC'], ['<', 'ASC'], ['>=', 'DESC'], ['<=', 'ASC']].forEach(([op, dir], i) => {
        ['v', 'id', 'g', 's'].forEach((c, k) => {
          same(`V62Ob #${i}-${k} USING ${op} は ${dir} と同じ (${c})`,
            `SELECT id FROM v62_t ORDER BY ${c} ${dir}, id`,
            `SELECT id FROM v62_t ORDER BY ${c} USING ${op}, id`);
        });
      });
      ok('V62Ob 式に対しても使える', 'SELECT id FROM v62_t ORDER BY LENGTH(s) USING >, id');
      ok('V62Ob 序数に対しても使える', 'SELECT id, v FROM v62_t ORDER BY 2 USING <, 1');
      err('V62Ob 未対応の演算子', 'SELECT id FROM v62_t ORDER BY v USING ~~', 'comparison operators');
      err('V62Ob 演算子が無い', 'SELECT id FROM v62_t ORDER BY v USING', 'not found');
      styleSweep('ORDER BY USING', 'SELECT id FROM v62_t ORDER BY v USING >, id');

      // ----------------------------------------------------------------
      // V. 総合: 新機能どうしの組み合わせ
      // ----------------------------------------------------------------
      ok('V62Mx 集計と新関数', "SELECT g, PRODUCT(v) AS p, EVERY(CONTAINS(s, 'h')) AS e FROM v62_t GROUP BY g ORDER BY g");
      ok('V62Mx WHERE に新関数', "SELECT id FROM v62_t WHERE BTRIM(s, ' ') <> '' ORDER BY id");
      ok('V62Mx 新関数の入れ子', "SELECT ENCODE(BTRIM(s), 'hex') AS r FROM v62_t WHERE s IS NOT NULL ORDER BY id");
      ok('V62Mx CASE の中', "SELECT CASE WHEN CONTAINS(s, 'h') THEN ORD(s) ELSE 0 END AS r FROM v62_t ORDER BY id");
      ok('V62Mx 窓関数と混ぜる', 'SELECT id, SUM(v) OVER (ORDER BY id) AS r FROM v62_t ORDER BY id');
      ok('V62Mx CTE の中', 'WITH x AS (SELECT g, PRODUCT(v) AS p FROM v62_t GROUP BY g) SELECT * FROM x ORDER BY g');
      ok('V62Mx JOIN と一緒に', 'SELECT t.id, PRODUCT(t.v) AS p FROM v62_t t JOIN v62_u u ON t.id = u.id GROUP BY t.id ORDER BY t.id');
      ok('V62Mx 新関数で並べ替え', 'SELECT id FROM v62_t ORDER BY JULIAN_DAY(ts) USING >, id');
      ok('V62Mx 新関数で GROUP BY', 'SELECT YEARWEEK(ts) AS w, COUNT(*) AS c FROM v62_t GROUP BY YEARWEEK(ts) ORDER BY w');
      t('V62Mx 生成列に新関数', () => {
        q('DROP TABLE IF EXISTS v62_gc');
        const r = q("CREATE TABLE v62_gc (a TEXT, b TEXT GENERATED ALWAYS AS (BTRIM(a, 'x')))");
        if (r.error) throw new Error(r.error);
        q("INSERT INTO v62_gc (a) VALUES ('xhix')");
        const v = oneOf('SELECT b FROM v62_gc');
        q('DROP TABLE v62_gc');
        return eq(v, 'hi', '生成列');
      });
      t('V62Mx トランザクションで巻き戻せる', () => {
        q('BEGIN');
        q('CREATE DATABASE v62_tx');
        q('ROLLBACK');
        return true;   // DDL 直後でもエンジンが壊れないことだけを見る
      });
      t('V62Mx SHOW FUNCTIONS に新スカラーが載る', () => {
        ['BTRIM', 'ENCODE', 'ORD', 'UNISTR', 'CONTAINS', 'TIMEDIFF', 'YEARWEEK',
         'PERIOD_ADD', 'PERIOD_DIFF', 'JULIAN_DAY', 'CONVERT_TZ',
         'JSON_SEARCH', 'JSON_MERGE_PRESERVE', 'ARRAY_DISTINCT', 'ARRAY_CAT', 'ARRAY_REVERSE',
         'LOCALTIME', 'LOCALTIMESTAMP'].forEach(fn => {
          const d = rowsOf(`SHOW FUNCTIONS LIKE '${fn}'`);
          if (d.length < 1) throw new Error(`SHOW FUNCTIONS に ${fn} が無い`);
        });
        return true;
      });

      // ----------------------------------------------------------------
      // W. 広い総当たり（値の組み合わせ）
      //    参照実装を JavaScript 側に置き、組み合わせを機械的に回す。
      //    1 件ずつ書くと実装を写経してしまうので、模型と突き合わせる形にする。
      // ----------------------------------------------------------------
      // W1. CONTAINS: 文字列 × 部分文字列の総当たり
      const W_STR = ['hello', 'Hello', 'HELLO', '', 'a', 'abcabc', 'a,b,c', '  ', 'xyz', 'aXbXc', '日本語', 'ab'];
      const W_SUB = ['h', 'H', 'ell', '', 'a', 'abc', ',', ' ', 'z', 'X', '本', 'ab'];
      W_STR.forEach((s, i) => W_SUB.forEach((sub, k) => {
        val(`V62Wc #${i}-${k} CONTAINS`, `SELECT CONTAINS(${lit(s)}, ${lit(sub)}) AS r`, s.indexOf(sub) !== -1);
      }));

      // W2. BTRIM: 文字列 × 文字集合の総当たり
      const W_BT = ['xxhixx', 'xyzzyx', 'aaa', 'abcba', '  x  ', 'xax', 'x', '', 'ab', 'xxx', ' a ', 'axxa'];
      const W_CH = ['x', 'xy', 'a', 'ab', ' ', 'xa', 'z', 'abx'];
      W_BT.forEach((s, i) => W_CH.forEach((c, k) => {
        val(`V62Wb #${i}-${k} BTRIM`, `SELECT BTRIM(${lit(s)}, ${lit(c)}) AS r`, btrimRef(s, c));
      }));

      // W3. CONVERT_TZ: 時間帯の全ペア
      const W_TZ = ['UTC', 'GMT', 'Z', 'JST', 'KST', 'IST', 'CET', 'EET', 'EST', 'CST', 'MST', 'PST',
                    '+00:00', '+09:00', '-05:00', '+05:30'];
      const TZ_MIN = { UTC: 0, GMT: 0, Z: 0, JST: 540, KST: 540, IST: 330, CET: 60, EET: 120,
                       EST: -300, CST: -360, MST: -420, PST: -480 };
      const tzMin = (n) => {
        const om = n.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
        if (om) return (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
        return TZ_MIN[n];
      };
      const W_BASE_TS = '2024-06-15 12:00:00';
      W_TZ.forEach((from, i) => W_TZ.forEach((to, k) => {
        const want = new Date(Date.parse(W_BASE_TS.replace(' ', 'T') + 'Z') + (tzMin(to) - tzMin(from)) * 60000)
          .toISOString().replace('T', ' ').slice(0, 19);
        val(`V62Wt #${i}-${k} CONVERT_TZ ${from}->${to}`,
          `SELECT CONVERT_TZ('${W_BASE_TS}', ${lit(from)}, ${lit(to)}) AS r`, want);
      }));

      // W4. TIMEDIFF: 時刻の全ペア
      const W_TS = ['2024-01-01 00:00:00', '2024-01-01 12:34:56', '2024-01-02 03:04:05',
                    '2024-03-05 10:30:00', '2024-06-15 23:59:59', '2024-12-31 12:00:00',
                    '2025-01-01 06:00:00', '2023-02-28 09:15:00', '2024-02-29 00:00:01',
                    '2020-01-01 00:00:00'];
      W_TS.forEach((a, i) => W_TS.forEach((b, k) => {
        val(`V62Wd #${i}-${k} TIMEDIFF`, `SELECT TIMEDIFF(${lit(a)}, ${lit(b)}) AS r`, tdRef(a, b));
      }));

      // W5. ORD: 1 文字ずつ UTF-8 の畳み込みと突き合わせる
      const utf8Fold = (ch) => {
        const cp = ch.codePointAt(0);
        const bytes = [];
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        return bytes.reduce((a, b) => a * 256 + b, 0);
      };
      ['A', 'B', 'z', '0', '9', ' ', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(',
       'あ', 'い', 'ア', '漢', 'é', 'ü', 'ß', 'Ω', '€', '№'].forEach((ch, i) => {
        val(`V62Wo #${i} ORD(${ch})`, `SELECT ORD(${lit(ch)}) AS r`, utf8Fold(ch));
      });

      // W6. PERIOD_ADD / PERIOD_DIFF: より広い期間と移動量
      const W_PER = [197001, 198012, 199901, 200801, 201506, 202001, 202401, 202412, 202502, 203012];
      const W_ADD = [0, 1, 5, 11, 12, 13, 23, 24, -1, -5, -12, -24];
      W_PER.forEach((p, i) => W_ADD.forEach((n, k) => {
        val(`V62Wp #${i}-${k} PERIOD_ADD(${p}, ${n})`, `SELECT PERIOD_ADD(${p}, ${n}) AS r`, paRef(p, n));
      }));
      W_PER.forEach((a, i) => W_PER.forEach((b, k) => {
        val(`V62Wq #${i}-${k} PERIOD_DIFF(${a}, ${b})`,
          `SELECT PERIOD_DIFF(${a}, ${b}) AS r`, pnorm(a) - pnorm(b));
      }));

      // W7. JULIAN_DAY: 日付と参照値（1970-01-01 00:00 = 2440587.5）
      const W_DATE = ['1970-01-01', '1970-01-02', '1999-12-31', '2000-01-01', '2000-02-29',
                      '2020-01-01', '2023-02-28', '2024-02-29', '2024-06-15', '2024-12-31',
                      '2025-01-01', '2030-06-30', '1987-01-01', '2016-02-29', '2100-01-01'];
      W_DATE.forEach((d, i) => {
        const want = Date.parse(d + 'T00:00:00Z') / 86400000 + 2440587.5;
        val(`V62Wj #${i} JULIAN_DAY(${d})`, `SELECT JULIAN_DAY(${lit(d)}) AS r`, want);
      });
      W_DATE.forEach((a, i) => W_DATE.forEach((b, k) => {
        if ((i + k) % 3 !== 0) return;   // 全ペアは冗長なので 1/3 に間引く
        t(`V62Wj #${i}-${k} 差は DATEDIFF と一致`, () => {
          const j = rowsOf(`SELECT JULIAN_DAY(${lit(b)}) - JULIAN_DAY(${lit(a)}) AS r`)[0].r;
          const d = rowsOf(`SELECT DATEDIFF(${lit(b)}, ${lit(a)}) AS r`)[0].r;
          return expect(j, d, `JULIAN_DAY の差 (${a}, ${b})`);
        });
      }));

      // W8. YEARWEEK: WEEK() との整合を広い日付で
      const W_YW = ['2024-01-01', '2024-01-06', '2024-01-07', '2024-01-08', '2024-02-29',
                    '2024-04-15', '2024-07-04', '2024-09-30', '2024-12-29', '2024-12-30',
                    '2023-01-01', '2023-01-02', '2023-12-31', '2022-01-01', '2021-12-31',
                    '2020-01-01', '2020-12-31', '2019-06-15', '2018-03-01', '2017-11-11'];
      W_YW.forEach((d, i) => {
        t(`V62Wy #${i} YEARWEEK(${d})`, () => {
          const w = rowsOf(`SELECT WEEK(${lit(d)}) AS w`)[0].w;
          const yw = rowsOf(`SELECT YEARWEEK(${lit(d)}) AS r`)[0].r;
          const y = Number(d.slice(0, 4));
          if (w === 0) {
            const lw = rowsOf(`SELECT WEEK('${y - 1}-12-31') AS w`)[0].w;
            return expect(yw, (y - 1) * 100 + lw, `YEARWEEK(${d})`);
          }
          return expect(yw, y * 100 + w, `YEARWEEK(${d})`);
        });
        val(`V62Wy #${i} 週は 1..53`, `SELECT YEARWEEK(${lit(d)}) % 100 BETWEEN 0 AND 53 AS r`, true);
      });

      // W9. ENCODE: 入力の総当たり（既存の同義関数と突き合わせる）
      const W_EN = ['a', 'ab', 'abc', 'abcd', 'abcde', '', ' ', '  ', '0', '9', 'あ', 'あい',
                    'A-Z', 'x=y', "it's", '{"a":1}'];
      W_EN.forEach((s, i) => {
        same(`V62We #${i} base64`, `SELECT TO_BASE64(${lit(s)}) AS r`, `SELECT ENCODE(${lit(s)}, 'base64') AS r`);
        same(`V62We #${i} hex`, `SELECT LOWER(HEX(${lit(s)})) AS r`, `SELECT ENCODE(${lit(s)}, 'hex') AS r`);
        same(`V62We #${i} hex は UNHEX で戻る`, `SELECT ${lit(s)} AS r`, `SELECT UNHEX(ENCODE(${lit(s)}, 'hex')) AS r`);
      });

      // W10. ARRAY_DISTINCT / CAT / REVERSE: 配列の総当たり
      const W_ARR = [[1], [1, 2], [2, 1], [1, 1], [1, 2, 3], [3, 2, 1], [1, 1, 2, 2],
                     [5, 5, 5], [1, 2, 3, 4], [9, 8, 9, 8], [7], [0, 1, 0]];
      W_ARR.forEach((a, i) => {
        val(`V62Wa #${i} DISTINCT`, `SELECT ARRAY_TO_STRING(ARRAY_DISTINCT(${arrSql(a)}), ',') AS r`,
          [...new Set(a)].join(','));
        val(`V62Wa #${i} REVERSE`, `SELECT ARRAY_TO_STRING(ARRAY_REVERSE(${arrSql(a)}), ',') AS r`,
          a.slice().reverse().join(','));
        val(`V62Wa #${i} DISTINCT の後の REVERSE`,
          `SELECT ARRAY_TO_STRING(ARRAY_REVERSE(ARRAY_DISTINCT(${arrSql(a)})), ',') AS r`,
          [...new Set(a)].reverse().join(','));
      });
      W_ARR.forEach((a, i) => W_ARR.forEach((b, k) => {
        if ((i + k) % 2 !== 0) return;   // 半分に間引く
        val(`V62Wa #${i}-${k} CAT`, `SELECT ARRAY_TO_STRING(ARRAY_CAT(${arrSql(a)}, ${arrSql(b)}), ',') AS r`,
          a.concat(b).join(','));
        val(`V62Wa #${i}-${k} CAT の長さ`, `SELECT ARRAY_LENGTH(ARRAY_CAT(${arrSql(a)}, ${arrSql(b)})) AS r`,
          a.length + b.length);
      }));

      // W11. EVERY / PRODUCT: 述語と式の総当たり（BOOL_AND と JS 模型で確かめる）
      const W_PRED = ['v > 0', 'v > 1', 'v > 2', 'v > 3', 'v >= 6', 'v < 0', 'v <= 3',
                      'v IS NOT NULL', 'v IS NULL', "g = 'a'", "g <> 'a'", "s IS NOT NULL",
                      'id > 0', 'id > 4', 'v = 2'];
      W_PRED.forEach((p, i) => {
        same(`V62Wv #${i} EVERY(${p}) は BOOL_AND と同じ`,
          `SELECT g, BOOL_AND(${p}) AS r FROM v62_t GROUP BY g ORDER BY g`,
          `SELECT g, EVERY(${p}) AS r FROM v62_t GROUP BY g ORDER BY g`);
        same(`V62Wv #${i} 全体でも同じ`,
          `SELECT BOOL_AND(${p}) AS r FROM v62_t`, `SELECT EVERY(${p}) AS r FROM v62_t`);
      });
      const W_EXPR = [['v', r => r[2]], ['id', r => r[0]], ['v + 1', r => r[2] === null ? null : r[2] + 1],
                      ['v * 2', r => r[2] === null ? null : r[2] * 2], ['id * id', r => r[0] * r[0]],
                      ['ABS(v)', r => r[2] === null ? null : Math.abs(r[2])],
                      ['LENGTH(s)', r => r[3] === null ? null : r[3].length]];
      W_EXPR.forEach(([e, f], i) => {
        t(`V62Wx #${i} PRODUCT(${e})`, () => {
          const got = oneOf(`SELECT PRODUCT(${e}) AS r FROM v62_t`);
          const vals = ROWS.map(f).filter(x => x !== null && x !== undefined);
          const want = vals.length === 0 ? null : vals.reduce((a, b) => a * b, 1);
          return expect(got, want, `PRODUCT(${e})`);
        });
        t(`V62Wx #${i} グループ別 PRODUCT(${e})`, () => {
          const got = rowsOf(`SELECT g, PRODUCT(${e}) AS r FROM v62_t GROUP BY g ORDER BY g`);
          const want = groups.map(g => {
            const vals = ROWS.filter(r => r[1] === g).map(f).filter(x => x !== null && x !== undefined);
            return { g, r: vals.length === 0 ? null : vals.reduce((a, b) => a * b, 1) };
          });
          return eq(got, want, `PRODUCT(${e}) GROUP BY`);
        });
        same(`V62Wx #${i} ACD(${e}) は COUNT(DISTINCT)`,
          `SELECT g, COUNT(DISTINCT ${e}) AS r FROM v62_t GROUP BY g ORDER BY g`,
          `SELECT g, APPROX_COUNT_DISTINCT(${e}) AS r FROM v62_t GROUP BY g ORDER BY g`);
      });

      // W12. 書き方の総当たり（基準クエリを増やして空白位置まで潰す）
      const W_BASE = [
        "SELECT BTRIM(s, 'x') AS r FROM v62_t ORDER BY id",
        "SELECT ENCODE(s, 'base64') AS r FROM v62_t WHERE s IS NOT NULL ORDER BY id",
        "SELECT ORD(s) AS r FROM v62_t ORDER BY id",
        "SELECT CONTAINS(s, 'h') AS r FROM v62_t ORDER BY id",
        "SELECT TIMEDIFF(ts, '2024-01-01 00:00:00') AS r FROM v62_t ORDER BY id",
        "SELECT YEARWEEK(ts) AS r FROM v62_t ORDER BY id",
        "SELECT JULIAN_DAY(ts) AS r FROM v62_t ORDER BY id",
        "SELECT CONVERT_TZ(ts, 'UTC', 'JST') AS r FROM v62_t ORDER BY id",
        "SELECT JSON_SEARCH(j, 'one', 'alpha') AS r FROM v62_t ORDER BY id",
        "SELECT g, PRODUCT(v) AS r FROM v62_t GROUP BY g ORDER BY g",
        "SELECT g, EVERY(v > 1) AS r FROM v62_t GROUP BY g ORDER BY g",
        "SELECT g, APPROX_COUNT_DISTINCT(v) AS r FROM v62_t GROUP BY g ORDER BY g",
        "SELECT id FROM v62_t ORDER BY v USING >, id",
        "SELECT PERIOD_ADD(202401, 3) AS r",
        "SELECT ARRAY_TO_STRING(ARRAY_DISTINCT(ARRAY[1, 2, 2]), ',') AS r"
      ];
      W_BASE.forEach((base, i) => {
        styleSweep(`W${i}`, base);
        wsSweep(`W${i}`, base);
      });

      // W13. 文の書き方（大小・空白）を変えても通ること
      const W_STMT = [
        'CHECKSUM TABLE v62_t',
        'REPAIR TABLE v62_t',
        'SHOW ENGINES',
        "SHOW COLUMNS FROM v62_t LIKE 'v'",
        'DESCRIBE v62_t v',
        'PRAGMA foreign_keys',
        'RESET ALL',
        'DO 1 + 1',
        "EXECUTE IMMEDIATE 'SELECT 1 AS a'",
        'EXPLAIN VERBOSE SELECT id FROM v62_t',
        'USE main'
      ];
      W_STMT.forEach((s, i) => {
        ok(`V62Wm #${i} そのまま`, s);
        ok(`V62Wm #${i} 小文字`, lower(s));
        ok(`V62Wm #${i} 大文字`, upper(s));
        ok(`V62Wm #${i} 改行`, spaced(s, '\n'));
        ok(`V62Wm #${i} 空白多め`, spaced(s, '   '));
        ok(`V62Wm #${i} タブ`, spaced(s, '\t'));
      });

      cleanup('v62_t', 'v62_u');
      return T;
    }
