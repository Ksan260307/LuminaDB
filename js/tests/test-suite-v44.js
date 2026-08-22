    // ============================================================================
    // [Test Suite v44] - コマンド全網羅 (2/6): 日付時刻 61 種・変換 9 種・正規表現 5 種・
    //                    符号化とハッシュ 9 種
    //
    //   期待値は JavaScript の Date（UTC 固定）で独立に組み立てる。
    //
    //     A. 日付部分を取り出す関数 × 日付バッテリ
    //     B. EXTRACT / DATEPART / DATE_PART / DATENAME × 全単位
    //     C. 加算・減算（DATE_ADD / DATE_SUB / DATEADD / TIMESTAMPADD）× 8 単位 × 符号
    //     D. 差を取る（DATEDIFF / TIMESTAMPDIFF）× 8 単位
    //     E. 切り捨てと組み立て
    //     F. 書式（DATE_FORMAT の指定子 / TO_CHAR）
    //     G. 現在日時 14 関数の形
    //     H. うるう年・月末・年跨ぎの境界
    //     I. 型変換 × 型行列
    //     J. 正規表現 5 関数
    //     K. 符号化とハッシュ 9 関数
    //     L. 列へ適用して全行を突き合わせる
    //     M. 単位名・書式の誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV44Tests() のスプレッドで合流する
    // ============================================================================
    function getV44Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, rowsOf: rows, oneOf: one, eq, val } = makeTestKit('V44');

      // ------------------------------------------------------------
      // 参照実装（すべて UTC で組み立てる）
      // ------------------------------------------------------------
      const D = (s) => new Date(s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z');
      const p2 = (n) => String(n).padStart(2, '0');
      const fmtD = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
      const fmtTS = (d) => `${fmtD(d)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
      const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
        - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
      // ISO 8601 の週番号（月曜始まり、第1週は最初の木曜を含む週）
      const isoWeek = (d0) => {
        const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
        const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - y0) / 86400000) + 1) / 7);
      };
      // WEEK() は MySQL の既定モード 0（日曜始まり・その年に日曜を含む最初の週が第1週。
      // 年初の日曜より前は第0週）。WEEKOFYEAR() の ISO 週とは別物なので分けて持つ
      const week0 = (d) => {
        const y = d.getUTCFullYear();
        const jan1 = new Date(Date.UTC(y, 0, 1));
        const firstSunday = new Date(Date.UTC(y, 0, 1 + ((7 - jan1.getUTCDay()) % 7)));
        const day = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
        if (day < firstSunday) return 0;
        return Math.floor((day - firstSunday) / 604800000) + 1;
      };
      const lastDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const addMonths = (d, n) => {
        const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
        const t2 = new Date(Date.UTC(y, m + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
        const dim = new Date(Date.UTC(t2.getUTCFullYear(), t2.getUTCMonth() + 1, 0)).getUTCDate();
        t2.setUTCDate(Math.min(day, dim));
        return t2;
      };
      const addUnit = (d, n, u) => {
        if (u === 'YEAR') return addMonths(d, n * 12);
        if (u === 'QUARTER') return addMonths(d, n * 3);
        if (u === 'MONTH') return addMonths(d, n);
        const ms = { WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000 }[u];
        return new Date(d.getTime() + n * ms);
      };

      // 日付バッテリ（うるう日・月末・年始年末・平日を含む）
      const DATES = ['2024-03-15', '2024-01-01', '2024-12-31', '2024-02-29', '2023-02-28',
                     '2024-06-30', '2020-01-31', '1999-12-31', '2000-01-01', '2024-07-04'];
      const TSS = ['2024-03-15 13:45:56', '2024-01-01 00:00:00', '2024-12-31 23:59:59',
                   '2024-02-29 12:00:00', '2024-06-30 06:07:08'];

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      const ROWS = [];
      t('V44 fixture', () => {
        q('DROP TABLE IF EXISTS v44_d');
        q('CREATE TABLE v44_d (id INT, d DATE, ts TIMESTAMP)');
        ROWS.length = 0;
        const base = Date.UTC(2024, 0, 1, 3, 14, 15);
        for (let i = 0; i < 50; i++) {
          const dd = (i % 8 === 7) ? null : new Date(base + i * 9 * 86400000 + i * 3600000);
          ROWS.push({ id: i, d: dd ? fmtD(dd) : null, ts: dd ? fmtTS(dd) : null });
        }
        q('INSERT INTO v44_d VALUES ' + ROWS.map(r =>
          `(${r.id}, ${r.d ? "'" + r.d + "'" : 'NULL'}, ${r.ts ? "'" + r.ts + "'" : 'NULL'})`).join(','));
        return db.tables['v44_d'].rowCount === 50;
      });

      // ============================================================
      // A. 日付部分を取り出す関数 × 日付バッテリ
      // ============================================================
      const PARTS = [
        ['YEAR', d => d.getUTCFullYear()],
        ['MONTH', d => d.getUTCMonth() + 1],
        ['DAY', d => d.getUTCDate()],
        ['DAYOFMONTH', d => d.getUTCDate()],
        ['HOUR', d => d.getUTCHours()],
        ['MINUTE', d => d.getUTCMinutes()],
        ['SECOND', d => d.getUTCSeconds()],
        ['QUARTER', d => Math.floor(d.getUTCMonth() / 3) + 1],
        ['DAYOFWEEK', d => d.getUTCDay() + 1],        // 日曜 = 1（MySQL）
        ['WEEKDAY', d => (d.getUTCDay() + 6) % 7],    // 月曜 = 0（MySQL）
        ['DAYOFYEAR', d => doy(d)],
        ['WEEKOFYEAR', d => isoWeek(d)],   // ISO 8601
        ['WEEK', d => week0(d)],           // MySQL の既定モード 0
        ['DAYNAME', d => DAYS[d.getUTCDay()]],
        ['MONTHNAME', d => MONTHS[d.getUTCMonth()]],
        ['TO_DAYS', d => Math.floor(d.getTime() / 86400000) + 719528],
        ['UNIX_TIMESTAMP', d => Math.floor(d.getTime() / 1000)],
      ];
      PARTS.forEach(([fn, ref]) => {
        DATES.concat(TSS).forEach(s => {
          val(`V44A ${fn}('${s}')`, `SELECT ${fn}('${s}') AS r`, ref(D(s)));
        });
        val(`V44A ${fn}(NULL) is NULL`, `SELECT ${fn}(NULL) AS r`, null);
      });
      // DATE / TIME / LAST_DAY / EOMONTH
      DATES.concat(TSS).forEach(s => {
        val(`V44A DATE('${s}')`, `SELECT DATE('${s}') AS r`, fmtD(D(s)));
        val(`V44A LAST_DAY('${s}')`, `SELECT LAST_DAY('${s}') AS r`, fmtD(lastDay(D(s))));
        val(`V44A EOMONTH('${s}')`, `SELECT EOMONTH('${s}') AS r`, fmtD(lastDay(D(s))));
      });
      TSS.forEach(s => {
        const d = D(s);
        val(`V44A TIME('${s}')`, `SELECT TIME('${s}') AS r`,
            `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`);
        val(`V44A TIME_TO_SEC('${s}')`, `SELECT TIME_TO_SEC('${s}') AS r`,
            d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds());
      });

      // ============================================================
      // B. EXTRACT / DATEPART / DATE_PART / DATENAME
      // ============================================================
      const EX_UNITS = [
        ['YEAR', d => d.getUTCFullYear()],
        ['MONTH', d => d.getUTCMonth() + 1],
        ['DAY', d => d.getUTCDate()],
        ['HOUR', d => d.getUTCHours()],
        ['MINUTE', d => d.getUTCMinutes()],
        ['SECOND', d => d.getUTCSeconds()],
        ['QUARTER', d => Math.floor(d.getUTCMonth() / 3) + 1],
        ['WEEK', d => isoWeek(d)],
        ['DOY', d => doy(d)],
        ['DOW', d => d.getUTCDay()],
        ['EPOCH', d => Math.floor(d.getTime() / 1000)],
      ];
      EX_UNITS.forEach(([u, ref]) => {
        TSS.forEach(s => {
          val(`V44B EXTRACT(${u} FROM '${s}')`, `SELECT EXTRACT(${u} FROM '${s}') AS r`, ref(D(s)));
          val(`V44B DATE_PART('${u}', '${s}')`, `SELECT DATE_PART('${u.toLowerCase()}', '${s}') AS r`, ref(D(s)));
        });
      });
      // SQL Server 系の綴りと略記
      const DP_UNITS = [
        ['year', d => d.getUTCFullYear()], ['yy', d => d.getUTCFullYear()], ['yyyy', d => d.getUTCFullYear()],
        ['quarter', d => Math.floor(d.getUTCMonth() / 3) + 1], ['qq', d => Math.floor(d.getUTCMonth() / 3) + 1],
        ['month', d => d.getUTCMonth() + 1], ['mm', d => d.getUTCMonth() + 1],
        ['day', d => d.getUTCDate()], ['dd', d => d.getUTCDate()],
        ['dayofyear', d => doy(d)], ['dy', d => doy(d)],
        ['week', d => isoWeek(d)], ['wk', d => isoWeek(d)], ['ww', d => isoWeek(d)],
        ['weekday', d => d.getUTCDay() + 1], ['dw', d => d.getUTCDay() + 1],
        ['hour', d => d.getUTCHours()], ['hh', d => d.getUTCHours()],
        ['minute', d => d.getUTCMinutes()], ['mi', d => d.getUTCMinutes()],
        ['second', d => d.getUTCSeconds()], ['ss', d => d.getUTCSeconds()],
      ];
      DP_UNITS.forEach(([u, ref]) => TSS.forEach(s => {
        val(`V44B DATEPART(${u}, '${s}')`, `SELECT DATEPART(${u}, '${s}') AS r`, ref(D(s)));
      }));
      // DATENAME は月と曜日だけ名称、他は数値の文字列
      TSS.forEach(s => {
        const d = D(s);
        val(`V44B DATENAME(month, '${s}')`, `SELECT DATENAME(month, '${s}') AS r`, MONTHS[d.getUTCMonth()]);
        val(`V44B DATENAME(weekday, '${s}')`, `SELECT DATENAME(weekday, '${s}') AS r`, DAYS[d.getUTCDay()]);
        val(`V44B DATENAME(year, '${s}')`, `SELECT DATENAME(year, '${s}') AS r`, String(d.getUTCFullYear()));
        val(`V44B DATENAME(day, '${s}')`, `SELECT DATENAME(day, '${s}') AS r`, String(d.getUTCDate()));
      });

      // ============================================================
      // C. 加算・減算
      // ============================================================
      const UNITS = ['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];
      const AMOUNTS = [1, -1, 0, 13, -25];
      UNITS.forEach(u => AMOUNTS.forEach(n => TSS.slice(0, 3).forEach(s => {
        const d = D(s);
        val(`V44C DATE_ADD('${s}', INTERVAL ${n} ${u})`,
            `SELECT DATE_ADD('${s}', INTERVAL ${n} ${u}) AS r`, fmtTS(addUnit(d, n, u)));
        val(`V44C DATE_SUB('${s}', INTERVAL ${n} ${u})`,
            `SELECT DATE_SUB('${s}', INTERVAL ${n} ${u}) AS r`, fmtTS(addUnit(d, -n, u)));
        val(`V44C DATEADD(${u}, ${n}, '${s}')`,
            `SELECT DATEADD(${u}, ${n}, '${s}') AS r`, fmtTS(addUnit(d, n, u)));
        val(`V44C TIMESTAMPADD(${u}, ${n}, '${s}')`,
            `SELECT TIMESTAMPADD(${u}, ${n}, '${s}') AS r`, fmtTS(addUnit(d, n, u)));
      })));
      // PostgreSQL 形式の文字列インターバル
      [['1 day', 1, 'DAY'], ['2 hours', 2, 'HOUR'], ['3 months', 3, 'MONTH'],
       ['-1 week', -1, 'WEEK'], ['10 minutes', 10, 'MINUTE'], ['1 year', 1, 'YEAR']].forEach(([txt, n, u]) => {
        val(`V44C DATE_ADD with the interval string '${txt}'`,
            `SELECT DATE_ADD('2024-03-15 13:45:56', INTERVAL '${txt}') AS r`,
            fmtTS(addUnit(D('2024-03-15 13:45:56'), n, u)));
      });
      // ADDDATE / SUBDATE は日数でもインターバルでも取れる
      [1, 10, -5, 0, 400].forEach(n => {
        val(`V44C ADDDATE by ${n} days`, `SELECT ADDDATE('2024-03-15', ${n}) AS r`,
            fmtTS(addUnit(D('2024-03-15'), n, 'DAY')));
        val(`V44C SUBDATE by ${n} days`, `SELECT SUBDATE('2024-03-15', ${n}) AS r`,
            fmtTS(addUnit(D('2024-03-15'), -n, 'DAY')));
      });
      // ADD_MONTHS は月末を丸める（Oracle）
      [['2024-01-31', 1, '2024-02-29'], ['2023-01-31', 1, '2023-02-28'],
       ['2024-03-31', -1, '2024-02-29'], ['2024-05-31', 1, '2024-06-30'],
       ['2024-03-15', 2, '2024-05-15'], ['2024-03-15', -2, '2024-01-15'],
       ['2024-12-31', 1, '2025-01-31']].forEach(([s, n, w]) => {
        val(`V44C ADD_MONTHS('${s}', ${n})`, `SELECT ADD_MONTHS('${s}', ${n}) AS r`, w + ' 00:00:00');
      });
      [['2024-03-15', '2024-01-15', 2], ['2024-01-15', '2024-03-15', -2],
       ['2024-03-15', '2024-03-15', 0], ['2025-03-15', '2024-03-15', 12]].forEach(([a, b, w]) => {
        val(`V44C MONTHS_BETWEEN('${a}', '${b}')`, `SELECT MONTHS_BETWEEN('${a}', '${b}') AS r`, w);
      });
      // NEXT_DAY は「その日より後」の最初の該当曜日
      DAYS.forEach(dn => {
        const base = D('2024-03-15');           // 金曜
        let n = 1;
        while (new Date(base.getTime() + n * 86400000).getUTCDay() !== DAYS.indexOf(dn)) n++;
        val(`V44C NEXT_DAY('2024-03-15', '${dn}')`, `SELECT NEXT_DAY('2024-03-15', '${dn}') AS r`,
            fmtD(new Date(base.getTime() + n * 86400000)));
      });

      // ============================================================
      // D. 差を取る
      // ============================================================
      const DIFF_PAIRS = [['2024-01-01 00:00:00', '2024-03-15 13:45:56'],
                          ['2024-03-15 13:45:56', '2024-01-01 00:00:00'],
                          ['2024-01-01 00:00:00', '2024-01-01 00:00:00'],
                          ['2023-06-15 08:00:00', '2024-06-15 08:00:00']];
      const diffRef = (u, a, b) => {
        const d1 = D(a), d2 = D(b), ms = d2.getTime() - d1.getTime();
        if (u === 'SECOND') return Math.trunc(ms / 1000);
        if (u === 'MINUTE') return Math.trunc(ms / 60000);
        if (u === 'HOUR') return Math.trunc(ms / 3600000);
        if (u === 'DAY') return Math.trunc(ms / 86400000);
        if (u === 'WEEK') return Math.trunc(ms / 604800000);
        // 月単位系は暦上の月差から、日・時刻が満たない分を差し引く
        let months = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
        const anchor = addMonths(d1, months);
        if (months > 0 && anchor.getTime() > d2.getTime()) months--;
        if (months < 0 && anchor.getTime() < d2.getTime()) months++;
        if (u === 'MONTH') return months;
        if (u === 'QUARTER') return Math.trunc(months / 3);
        return Math.trunc(months / 12);
      };
      UNITS.forEach(u => DIFF_PAIRS.forEach(([a, b]) => {
        val(`V44D TIMESTAMPDIFF(${u}, '${a}', '${b}')`,
            `SELECT TIMESTAMPDIFF(${u}, '${a}', '${b}') AS r`, diffRef(u, a, b));
      }));
      // 2 引数の DATEDIFF は日数（MySQL）
      [['2024-03-15', '2024-01-01', 74], ['2024-01-01', '2024-03-15', -74],
       ['2024-03-15', '2024-03-15', 0], ['2024-03-01', '2024-02-29', 1],
       ['2025-01-01', '2024-01-01', 366]].forEach(([a, b, w]) => {
        val(`V44D DATEDIFF('${a}', '${b}')`, `SELECT DATEDIFF('${a}', '${b}') AS r`, w);
      });
      val('V44D DATEDIFF with a NULL is NULL', "SELECT DATEDIFF('2024-03-15', NULL) AS r", null);
      // 3 引数の DATEDIFF は単位つき（SQL Server）
      UNITS.forEach(u => {
        val(`V44D DATEDIFF(${u}, '2024-01-01', '2024-03-15')`,
            `SELECT DATEDIFF(${u}, '2024-01-01', '2024-03-15') AS r`,
            diffRef(u, '2024-01-01 00:00:00', '2024-03-15 00:00:00'));
      });

      // ============================================================
      // E. 切り捨てと組み立て
      // ============================================================
      const TRUNC_UNITS = [
        ['year', d => new Date(Date.UTC(d.getUTCFullYear(), 0, 1))],
        ['quarter', d => new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))],
        ['month', d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))],
        ['week', d => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
                        x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; }],
        ['day', d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))],
        ['hour', d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()))],
        ['minute', d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()))],
        ['second', d => d],
      ];
      TRUNC_UNITS.forEach(([u, ref]) => TSS.forEach(s => {
        val(`V44E DATE_TRUNC('${u}', '${s}')`, `SELECT DATE_TRUNC('${u}', '${s}') AS r`, fmtTS(ref(D(s))));
      }));
      // 組み立て系
      [[2024, 1, '2024-01-01'], [2024, 60, '2024-02-29'], [2024, 366, '2024-12-31'],
       [2023, 60, '2023-03-01'], [2024, 100, '2024-04-09']].forEach(([y, n, w]) => {
        val(`V44E MAKEDATE(${y}, ${n})`, `SELECT MAKEDATE(${y}, ${n}) AS r`, w);
      });
      [[2024, 3, 15, '2024-03-15'], [2024, 12, 31, '2024-12-31'], [2000, 1, 1, '2000-01-01']]
        .forEach(([y, m, d, w]) => val(`V44E MAKE_DATE(${y}, ${m}, ${d})`, `SELECT MAKE_DATE(${y}, ${m}, ${d}) AS r`, w));
      [[13, 45, 56, '13:45:56'], [0, 0, 0, '00:00:00'], [23, 59, 59, '23:59:59']]
        .forEach(([h, m, s, w]) => val(`V44E MAKETIME(${h}, ${m}, ${s})`, `SELECT MAKETIME(${h}, ${m}, ${s}) AS r`, w));
      val('V44E MAKE_TIMESTAMP', 'SELECT MAKE_TIMESTAMP(2024, 3, 15, 13, 45, 56) AS r', '2024-03-15 13:45:56');
      [[0, '00:00:00'], [3661, '01:01:01'], [86399, '23:59:59'], [59, '00:00:59']]
        .forEach(([n, w]) => val(`V44E SEC_TO_TIME(${n})`, `SELECT SEC_TO_TIME(${n}) AS r`, w));
      DATES.forEach(s => {
        const days = Math.floor(D(s).getTime() / 86400000) + 719528;
        val(`V44E FROM_DAYS round-trips '${s}'`, `SELECT FROM_DAYS(${days}) AS r`, s);
      });
      TSS.forEach(s => {
        const secs = Math.floor(D(s).getTime() / 1000);
        val(`V44E FROM_UNIXTIME round-trips '${s}'`, `SELECT FROM_UNIXTIME(${secs}) AS r`, s);
      });
      // 文字列からの解釈
      [['15/03/2024', '%d/%m/%Y', '2024-03-15'], ['2024-03-15', '%Y-%m-%d', '2024-03-15'],
       ['03/15/2024', '%m/%d/%Y', '2024-03-15'], ['20240315', '%Y%m%d', '2024-03-15']].forEach(([s, f, w]) => {
        val(`V44E STR_TO_DATE('${s}', '${f}')`, `SELECT STR_TO_DATE('${s}', '${f}') AS r`, w);
      });
      val('V44E TO_DATE with a format', "SELECT TO_DATE('2024-03-15', 'YYYY-MM-DD') AS r", '2024-03-15');
      val('V44E TO_TIMESTAMP with a format',
          "SELECT TO_TIMESTAMP('2024-03-15 13:45:56', 'YYYY-MM-DD HH24:MI:SS') AS r", '2024-03-15 13:45:56');

      // ============================================================
      // F. 書式
      // ============================================================
      const S1 = '2024-03-15 13:45:56';
      const d1 = D(S1);
      [['%Y-%m-%d', '2024-03-15'], ['%d/%m/%Y', '15/03/2024'], ['%H:%i:%s', '13:45:56'],
       ['%Y', '2024'], ['%m', '03'], ['%d', '15'], ['%H', '13'], ['%i', '45'], ['%s', '56'],
       ['%b %e %Y', 'Mar 15 2024'], ['%W', 'Friday'], ['%M', 'March'], ['%j', '075'],
       ['%p %h', 'PM 01'], ['%y', '24'], ['%a', 'Fri'], ['%c', '3'], ['%e', '15']].forEach(([f, w]) => {
        val(`V44F DATE_FORMAT with '${f}'`, `SELECT DATE_FORMAT('${S1}', '${f}') AS r`, w);
      });
      [['YYYY-MM-DD', '2024-03-15'], ['DD/MM/YYYY', '15/03/2024'], ['HH24:MI:SS', '13:45:56'],
       ['YYYY', '2024'], ['MM', '03'], ['DD', '15'], ['MON', 'MAR'], ['DAY', 'FRIDAY'],
       ['YYYY-MM', '2024-03']].forEach(([f, w]) => {
        val(`V44F TO_CHAR with '${f}'`, `SELECT TO_CHAR('${S1}', '${f}') AS r`, w);
      });
      // 書式は日付バッテリ全体でも通る
      DATES.forEach(s => {
        val(`V44F DATE_FORMAT %Y-%m-%d round-trips '${s}'`,
            `SELECT DATE_FORMAT('${s}', '%Y-%m-%d') AS r`, s);
        val(`V44F TO_CHAR YYYY-MM-DD round-trips '${s}'`,
            `SELECT TO_CHAR('${s}', 'YYYY-MM-DD') AS r`, s);
        val(`V44F DATE_FORMAT %W on '${s}'`, `SELECT DATE_FORMAT('${s}', '%W') AS r`, DAYS[D(s).getUTCDay()]);
        val(`V44F DATE_FORMAT %M on '${s}'`, `SELECT DATE_FORMAT('${s}', '%M') AS r`, MONTHS[D(s).getUTCMonth()]);
      });

      // ============================================================
      // G. 現在日時 14 関数の形
      // ============================================================
      [['NOW()', 19], ['CURRENT_TIMESTAMP', 19], ['GETDATE()', 19], ['SYSDATE()', 19],
       ['SYSDATETIME()', 19], ['GETUTCDATE()', 19], ['SYSUTCDATETIME()', 19], ['SYSTIMESTAMP', 19],
       ['UTC_TIMESTAMP()', 19], ['CURDATE()', 10], ['CURRENT_DATE', 10], ['UTC_DATE()', 10],
       ['CURTIME()', 8], ['CURRENT_TIME', 8]].forEach(([e, len]) => {
        val(`V44G ${e} has ${len} characters`, `SELECT LENGTH(CAST(${e} AS TEXT)) AS r`, len);
      });
      val('V44G CURRENT_DATE equals CURDATE', 'SELECT CURRENT_DATE = CURDATE() AS r', true);
      val('V44G the year of NOW is at least 2024', 'SELECT YEAR(NOW()) >= 2024 AS r', true);
      val('V44G DATE of NOW equals CURDATE', 'SELECT DATE(NOW()) = CURDATE() AS r', true);
      val('V44G NOW is not NULL', 'SELECT NOW() IS NOT NULL AS r', true);

      // ============================================================
      // H. うるう年・月末・年跨ぎ
      // ============================================================
      [[2024, true], [2023, false], [2000, true], [1900, false], [2100, false], [2400, true]]
        .forEach(([y, leap]) => {
          val(`V44H ${y} February has ${leap ? 29 : 28} days`,
              `SELECT DAY(LAST_DAY('${y}-02-01')) AS r`, leap ? 29 : 28);
          val(`V44H ${y} has ${leap ? 366 : 365} days`,
              `SELECT DAYOFYEAR('${y}-12-31') AS r`, leap ? 366 : 365);
        });
      for (let m = 1; m <= 12; m++) {
        const w = new Date(Date.UTC(2024, m, 0)).getUTCDate();
        val(`V44H the last day of 2024-${p2(m)}`, `SELECT DAY(LAST_DAY('2024-${p2(m)}-01')) AS r`, w);
      }
      val('V44H adding one day crosses the year boundary',
          "SELECT DATE_ADD('2024-12-31', INTERVAL 1 DAY) AS r", '2025-01-01 00:00:00');
      val('V44H subtracting one day crosses the year boundary backwards',
          "SELECT DATE_SUB('2024-01-01', INTERVAL 1 DAY) AS r", '2023-12-31 00:00:00');
      val('V44H one day past the leap day',
          "SELECT DATE_ADD('2024-02-28', INTERVAL 1 DAY) AS r", '2024-02-29 00:00:00');
      val('V44H the leap day does not exist in a common year',
          "SELECT DATE_ADD('2023-02-28', INTERVAL 1 DAY) AS r", '2023-03-01 00:00:00');
      val('V44H one year from the leap day lands on the 28th',
          "SELECT DATE_ADD('2024-02-29', INTERVAL 1 YEAR) AS r", '2025-02-28 00:00:00');
      val('V44H the last second of the year rolls over',
          "SELECT DATE_ADD('2024-12-31 23:59:59', INTERVAL 1 SECOND) AS r", '2025-01-01 00:00:00');
      val('V44H the ISO week of 2024-01-01', "SELECT WEEKOFYEAR('2024-01-01') AS r", 1);
      val('V44H the ISO week of 2024-12-31', "SELECT WEEKOFYEAR('2024-12-31') AS r", 1);

      // ============================================================
      // I. 型変換
      // ============================================================
      const CASTS = [
        ["'12'", 'INTEGER', 12], ["'12'", 'INT', 12], ["'-5'", 'INTEGER', -5],
        ["'12.5'", 'DECIMAL', 12.5], ["'12.5'", 'FLOAT', 12.5], ["'abc'", 'INTEGER', null],
        // CAST('' AS INTEGER) は 0（MySQL / SQLite と同じ）。
        // 列への INSERT では '' を NULL 扱いにするのとは別の規約
        ["''", 'INTEGER', 0], ['12.7', 'INT', 12], ['-12.7', 'INT', -12],
        ['12', 'TEXT', '12'], ['12.5', 'TEXT', '12.5'], ["'2024-03-15'", 'DATE', '2024-03-15'],
        ["'2024-03-15 13:45:56'", 'DATE', '2024-03-15'], ['NULL', 'INT', null],
        ['NULL', 'TEXT', null], ["'true'", 'BOOLEAN', true], ["'false'", 'BOOLEAN', false],
        ['1', 'BOOLEAN', true], ['0', 'BOOLEAN', false], ["'abc'", 'TEXT', 'abc'],
      ];
      CASTS.forEach(([v, ty, w]) => {
        val(`V44I CAST(${v} AS ${ty})`, `SELECT CAST(${v} AS ${ty}) AS r`, w);
        val(`V44I TRY_CAST(${v} AS ${ty})`, `SELECT TRY_CAST(${v} AS ${ty}) AS r`, w);
      });
      [["'12'", 'INTEGER', 12], ["'abc'", 'INTEGER', null], ['12.7', 'INT', 12], ['12', 'TEXT', '12']]
        .forEach(([v, ty, w]) => {
          val(`V44I CONVERT(${v}, ${ty})`, `SELECT CONVERT(${v}, ${ty}) AS r`, w);
          val(`V44I CONVERT(${ty}, ${v})`, `SELECT CONVERT(${ty}, ${v}) AS r`, w);
          val(`V44I TRY_CONVERT(${ty}, ${v})`, `SELECT TRY_CONVERT(${ty}, ${v}) AS r`, w);
        });
      [["'12.5'", 12.5], ["'abc'", null], ["'-3'", -3], ["'0'", 0], ['NULL', null]].forEach(([v, w]) => {
        val(`V44I TO_NUMBER(${v})`, `SELECT TO_NUMBER(${v}) AS r`, w);
      });
      [['12.5', '12.5'], ['12', '12'], ["'abc'", 'abc'], ['NULL', null]].forEach(([v, w]) => {
        val(`V44I TO_CHAR(${v})`, `SELECT TO_CHAR(${v}) AS r`, w);
      });
      [[255, 'ff'], [0, '0'], [16, '10'], [4095, 'fff']].forEach(([n, w]) => {
        val(`V44I TO_HEX(${n})`, `SELECT TO_HEX(${n}) AS r`, w);
      });
      // 変換した値がそのまま演算に使える
      val('V44I a cast value takes part in arithmetic', "SELECT CAST('12' AS INTEGER) + 3 AS r", 15);
      val('V44I a cast value takes part in concatenation', "SELECT CAST(12 AS TEXT) || 'x' AS r", '12x');
      val('V44I a cast date takes part in date arithmetic',
          "SELECT DATE_ADD(CAST('2024-03-15' AS DATE), INTERVAL 1 DAY) AS r", '2024-03-16 00:00:00');
      val('V44I TYPEOF after a cast to text', "SELECT TYPEOF(CAST(12 AS TEXT)) AS r", 'text');
      val('V44I TYPEOF after a cast to integer', "SELECT TYPEOF(CAST('12' AS INTEGER)) AS r", 'integer');

      // ============================================================
      // J. 正規表現
      // ============================================================
      const RX = [
        ["REGEXP_LIKE('abc', 'b')", 1], ["REGEXP_LIKE('abc', 'z')", 0],
        ["REGEXP_LIKE('abc', '^a')", 1], ["REGEXP_LIKE('abc', 'c$')", 1],
        ["REGEXP_LIKE('ABC', 'b')", 0], ["REGEXP_LIKE('ABC', 'b', 'i')", 1],
        ["REGEXP_LIKE(NULL, 'b')", null],
        ["REGEXP_REPLACE('abc', 'b', 'X')", 'aXc'],
        ["REGEXP_REPLACE('a1b2c3', '[0-9]', '')", 'abc'],
        ["REGEXP_REPLACE('abc', 'z', 'X')", 'abc'],
        ["REGEXP_REPLACE('aaa', 'a', 'X')", 'XXX'],
        ["REGEXP_REPLACE(NULL, 'a', 'X')", null],
        ["REGEXP_SUBSTR('a1b2', '[0-9]')", '1'],
        ["REGEXP_SUBSTR('a1b2', '[0-9]+')", '1'],
        ["REGEXP_SUBSTR('abc', '[0-9]')", null],
        ["REGEXP_INSTR('a1b2', '[0-9]')", 2],
        ["REGEXP_INSTR('abc', '[0-9]')", 0],
        ["REGEXP_COUNT('a1b2c3', '[0-9]')", 3],
        ["REGEXP_COUNT('abc', '[0-9]')", 0],
        ["REGEXP_COUNT('aaa', 'a')", 3],
      ];
      RX.forEach(([e, w]) => val(`V44J ${e}`, `SELECT ${e} AS r`, w));
      // 演算子形
      [["'abc' REGEXP 'b'", true], ["'abc' REGEXP 'z'", false],
       ["'abc' NOT REGEXP 'z'", true], ["'abc' SIMILAR TO 'a%'", true],
       ["'abc' SIMILAR TO 'a.*'", false]].forEach(([e, w]) => {
        val(`V44J ${e}`, `SELECT ${e} AS r`, w);
      });
      // 正規表現を列へ適用
      t('V44J REGEXP_LIKE over a column', () => {
        const got = one("SELECT COUNT(*) AS c FROM v44_d WHERE REGEXP_LIKE(CAST(d AS TEXT), '^2024')");
        return eq(got, ROWS.filter(r => r.d !== null && /^2024/.test(r.d)).length);
      });

      // ============================================================
      // K. 符号化とハッシュ
      // ============================================================
      const HASH = [
        ["MD5('abc')", '900150983cd24fb0d6963f7d28e17f72'],
        ["MD5('')", 'd41d8cd98f00b204e9800998ecf8427e'],
        ["SHA1('abc')", 'a9993e364706816aba3e25717850c26c9cd0d89d'],
        ["SHA1('')", 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
        ["SHA256('abc')", 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ["SHA2('abc', 256)", 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ["SHA224('abc')", '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'],
        ["TO_BASE64('abc')", 'YWJj'],
        ["TO_BASE64('')", ''],
        ["FROM_BASE64('YWJj')", 'abc'],
        ["INET_ATON('192.168.1.1')", 3232235777],
        ["INET_ATON('0.0.0.0')", 0],
        ["INET_ATON('255.255.255.255')", 4294967295],
        ["INET_NTOA(3232235777)", '192.168.1.1'],
        ["INET_NTOA(0)", '0.0.0.0'],
        ["INET_NTOA(4294967295)", '255.255.255.255'],
      ];
      HASH.forEach(([e, w]) => val(`V44K ${e}`, `SELECT ${e} AS r`, w));
      ['MD5','SHA1','SHA256','SHA224','TO_BASE64','FROM_BASE64','INET_ATON','INET_NTOA'].forEach(fn => {
        val(`V44K ${fn}(NULL) is NULL`, `SELECT ${fn}(NULL) AS r`, null);
      });
      // 往復
      ['abc', 'Hello World', '', 'a,b,c', '0123456789'].forEach(s => {
        val(`V44K base64 round-trips '${s}'`, `SELECT FROM_BASE64(TO_BASE64('${s}')) AS r`, s);
        val(`V44K hex round-trips '${s}'`, `SELECT UNHEX(HEX('${s}')) AS r`, s);
      });
      ['192.168.1.1', '10.0.0.1', '172.16.254.1', '8.8.8.8', '127.0.0.1'].forEach(ip => {
        val(`V44K the IPv4 address ${ip} round-trips`, `SELECT INET_NTOA(INET_ATON('${ip}')) AS r`, ip);
      });
      // 同じ入力は同じハッシュ、違う入力は違うハッシュ
      val('V44K the same input hashes the same', "SELECT MD5('abc') = MD5('abc') AS r", true);
      val('V44K a different input hashes differently', "SELECT MD5('abc') = MD5('abd') AS r", false);
      val('V44K MD5 is 32 characters', "SELECT LENGTH(MD5('anything')) AS r", 32);
      val('V44K SHA1 is 40 characters', "SELECT LENGTH(SHA1('anything')) AS r", 40);
      val('V44K SHA256 is 64 characters', "SELECT LENGTH(SHA256('anything')) AS r", 64);
      val('V44K SHA224 is 56 characters', "SELECT LENGTH(SHA224('anything')) AS r", 56);

      // ============================================================
      // L. 列へ適用して全行を突き合わせる
      // ============================================================
      const dcol = (name, expr, ref) => t(name, () => {
        const got = rows(`SELECT id, ${expr} AS r FROM v44_d ORDER BY id`).map(r => r.r);
        const want = ROWS.map(r => r.ts === null ? null : ref(D(r.ts)));
        return eq(got, want);
      });
      PARTS.forEach(([fn, ref]) => dcol(`V44L ${fn} over a column`, `${fn}(ts)`, ref));
      dcol('V44L DATE over a column', 'DATE(ts)', d => fmtD(d));
      dcol('V44L LAST_DAY over a column', 'LAST_DAY(ts)', d => fmtD(lastDay(d)));
      dcol('V44L DATE_TRUNC month over a column', "DATE_TRUNC('month', ts)",
           d => fmtTS(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))));
      dcol('V44L DATE_ADD 1 day over a column', 'DATE_ADD(ts, INTERVAL 1 DAY)',
           d => fmtTS(new Date(d.getTime() + 86400000)));
      dcol('V44L DATE_FORMAT over a column', "DATE_FORMAT(ts, '%Y/%m')",
           d => `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}`);
      dcol('V44L EXTRACT year over a column', 'EXTRACT(YEAR FROM ts)', d => d.getUTCFullYear());
      dcol('V44L DATEPART quarter over a column', 'DATEPART(quarter, ts)',
           d => Math.floor(d.getUTCMonth() / 3) + 1);
      t('V44L grouping by a date part', () => {
        const got = rows('SELECT YEAR(ts) AS y, COUNT(*) AS c FROM v44_d WHERE ts IS NOT NULL GROUP BY YEAR(ts) ORDER BY y');
        const m = new Map();
        ROWS.filter(r => r.ts).forEach(r => { const y = D(r.ts).getUTCFullYear(); m.set(y, (m.get(y) || 0) + 1); });
        return eq(got, [...m.entries()].sort((a, b) => a[0] - b[0]).map(([y, c]) => ({ y, c })));
      });
      t('V44L ordering by a date expression', () => {
        const got = rows('SELECT id FROM v44_d WHERE ts IS NOT NULL ORDER BY DATE_TRUNC(\'month\', ts), id').map(r => r.id);
        const want = ROWS.filter(r => r.ts).slice().sort((a, b) => {
          const ka = D(a.ts).getUTCFullYear() * 12 + D(a.ts).getUTCMonth();
          const kb = D(b.ts).getUTCFullYear() * 12 + D(b.ts).getUTCMonth();
          return ka - kb || a.id - b.id;
        }).map(r => r.id);
        return eq(got, want);
      });
      t('V44L filtering on a date range', () => {
        const got = one("SELECT COUNT(*) AS c FROM v44_d WHERE d BETWEEN '2024-03-01' AND '2024-09-30'");
        return eq(got, ROWS.filter(r => r.d !== null && r.d >= '2024-03-01' && r.d <= '2024-09-30').length);
      });

      // ============================================================
      // M. 単位名・引数の誤りは拒否される
      // ============================================================
      err('V44M DATE_TRUNC with an unknown unit', "SELECT DATE_TRUNC('fortnight', '2024-03-15') AS r", 'unsupported date unit');
      err('V44M DATE_PART with an unknown unit', "SELECT DATE_PART('fortnight', '2024-03-15') AS r", 'unsupported date unit');
      err('V44M DATEPART with an unknown unit', "SELECT DATEPART(fortnight, '2024-03-15') AS r", 'unsupported date unit');
      err('V44M DATENAME with an unknown unit', "SELECT DATENAME(fortnight, '2024-03-15') AS r", 'unsupported date unit');
      err('V44M DATEADD with an unknown unit', "SELECT DATEADD(fortnight, 1, '2024-03-15') AS r", 'unsupported date unit');
      err('V44M TIMESTAMPADD with an unknown unit', "SELECT TIMESTAMPADD(fortnight, 1, '2024-03-15') AS r", 'unsupported date unit');
      err('V44M TIMESTAMPDIFF with an unknown unit', "SELECT TIMESTAMPDIFF(fortnight, '2024-01-01', '2024-03-15') AS r", 'unsupported date unit');
      err('V44M an interval with an unknown unit', "SELECT DATE_ADD('2024-03-15', INTERVAL 1 FORTNIGHT) AS r");
      err('V44M an invalid interval string', "SELECT DATE_ADD('2024-03-15', INTERVAL '1 fortnight') AS r", 'invalid interval');
      err('V44M YEAR with two arguments', "SELECT YEAR('2024-03-15', 1) AS r", 'parameter count');
      err('V44M DATEDIFF with one argument', "SELECT DATEDIFF('2024-03-15') AS r", 'parameter count');
      err('V44M MAKEDATE with one argument', 'SELECT MAKEDATE(2024) AS r', 'parameter count');
      err('V44M an unknown cast target', "SELECT CAST('1' AS NOSUCHTYPE) AS r", "unknown type 'NOSUCHTYPE'");
      err('V44M a misspelled cast target', "SELECT CAST('1' AS INTEGR) AS r", 'unknown type');
      err('V44M an unknown CONVERT target', "SELECT CONVERT(NOSUCHTYPE, '1') AS r", 'unknown type');
      err('V44M an unknown :: cast target', "SELECT '1'::NOSUCHTYPE AS r", 'unknown type');
      // 方言別名は通る
      val('V44M VARCHAR2 is accepted', "SELECT CAST(1 AS VARCHAR2(10)) AS r", '1');
      val('V44M NUMBER is accepted', "SELECT CAST('2.5' AS NUMBER) AS r", 2.5);
      val('V44M INT8 is accepted', "SELECT CAST('7' AS INT8) AS r", 7);
      val('V44M SIGNED is accepted', "SELECT CAST('7' AS SIGNED) AS r", 7);
      // 解釈できない日付は NULL（エラーではない）
      val('V44M an unparsable date yields NULL', "SELECT YEAR('not a date') AS r", null);
      val('V44M an empty date string yields NULL', "SELECT YEAR('') AS r", null);
      val('V44M STR_TO_DATE with a mismatched format yields NULL',
          "SELECT STR_TO_DATE('15/03/2024', '%Y-%m-%d') AS r", null);

      // ============================================================
      // 片付け
      // ============================================================
      t('V44Zz cleanup', () => {
        q('DROP TABLE IF EXISTS v44_d');
        return Object.keys(db.tables).filter(n => n.indexOf('v44_') === 0).length === 0;
      });

      return T;
    }
