    // ============================================================================
    // [Test Suite v19] - パフォーマンステスト（約 500 件）
    //
    //   方針:
    //     * 「絶対時間の閾値」だけだと実行環境の速さでブレるので、まず実測で
    //       基準値（20,000 行の絞り込みスキャン 1 回）を較正し、以降の予算は
    //       その倍数で表す。アルゴリズム的な劣化（O(n) → O(n^2) 等）は倍数で
    //       確実に検出でき、単に遅いマシンでの偽陽性は起きにくい。
    //     * 各テストは「正しい結果」と「予算内の時間」の両方を検査する。
    //       期待値は SQL を使わず JS 側の独立計算から求める。
    //     * スケーリング検査（N と 2N の所要時間比）で計算量そのものも見る。
    //
    //   test-suite.js の tests 配列へ getV19Tests() のスプレッドで合流する
    // ============================================================================
    function getV19Tests() {
      const T = [];
      const fn = (name, f) => T.push({ name, fn: f });

      // 較正値（V19Cal で実測して埋める）。base は 20,000 行スキャン 1 回の ms
      const CAL = { base: 3 };
      const bud = (mult, floorMs) => Math.max(floorMs || 0, CAL.base * mult);

      // 予算付きの SQL テスト: 結果の正しさ + 実行時間の上限
      const perf = (name, sql, mult, floorMs, check) => T.push({
        name,
        fn: () => {
          const r = db.executeQuery(sql);
          if (r.error) { T._lastErr = r.error; return false; }
          if (check && !check(r)) return false;
          return Number(r.executionTime) <= bud(mult, floorMs);
        }
      });

      // ------------------------------------------------------------
      // フィクスチャ（決定的な式で生成するので期待値を JS 側で厳密に再現できる）
      //   v19_big : 20,000 行（スキャン / 集計 / 文字列関数）
      //   v19_mid :  4,000 行（結合 / ソート / ウィンドウ）
      //   v19_dim :    100 行（ディメンション表）
      // ------------------------------------------------------------
      const N_BIG = 20000, N_MID = 4000, N_DIM = 100;
      const bigN = (id) => (id * 37) % 1000;
      const bigGrp = (id) => id % 20;
      const midG = (id) => id % 50;
      const midV = (id) => (id * 17) % 500;

      const BIG = [], MID = [];
      for (let i = 1; i <= N_BIG; i++) BIG.push(i);
      for (let i = 1; i <= N_MID; i++) MID.push(i);
      const countBig = (pred) => BIG.reduce((a, i) => a + (pred(i) ? 1 : 0), 0);
      const sumBig = (f) => BIG.reduce((a, i) => a + f(i), 0);

      fn('V19Fx create big', () => !db.executeQuery(
        "CREATE TABLE v19_big (id INTEGER, grp INTEGER, n INTEGER, s TEXT, flag INTEGER)").error);
      fn('V19Fx fill big', () => {
        const r = db.executeQuery(
          "INSERT INTO v19_big SELECT value AS id, MOD(value, 20) AS grp, MOD(value * 37, 1000) AS n, " +
          "'row' || value AS s, MOD(value, 2) AS flag FROM GENERATE_SERIES(1, " + N_BIG + ")");
        return !r.error && db.tables['v19_big'].rowCount === N_BIG;
      });
      fn('V19Fx create mid', () => !db.executeQuery(
        "CREATE TABLE v19_mid (id INTEGER, g INTEGER, v INTEGER, t TEXT)").error);
      fn('V19Fx fill mid', () => {
        const r = db.executeQuery(
          "INSERT INTO v19_mid SELECT value AS id, MOD(value, 50) AS g, MOD(value * 17, 500) AS v, " +
          "'m' || value AS t FROM GENERATE_SERIES(1, " + N_MID + ")");
        return !r.error && db.tables['v19_mid'].rowCount === N_MID;
      });
      fn('V19Fx create dim', () => !db.executeQuery(
        "CREATE TABLE v19_dim (g INTEGER, label TEXT, w INTEGER)").error);
      fn('V19Fx fill dim', () => {
        const r = db.executeQuery(
          "INSERT INTO v19_dim SELECT value - 1 AS g, 'g' || value AS label, MOD(value, 7) AS w " +
          "FROM GENERATE_SERIES(1, " + N_DIM + ")");
        return !r.error && db.tables['v19_dim'].rowCount === N_DIM;
      });
      fn('V19Cal calibrate', () => {
        let best = Infinity;
        for (let i = 0; i < 5; i++) {
          const r = db.executeQuery("SELECT COUNT(*) AS c FROM v19_big WHERE n > 500");
          if (r.error) return false;
          best = Math.min(best, Number(r.executionTime));
        }
        CAL.base = Math.max(0.5, best);
        return isFinite(CAL.base);
      });

      // ============================================================
      // 1. フルスキャン + 述語（20,000 行）— 述語の形が変わっても線形に収まること
      // ============================================================
      const THRESH = [0, 50, 100, 200, 250, 333, 400, 500, 600, 700, 750, 800, 900, 950, 999];
      THRESH.forEach(t => {
        perf(`V19Scan gt ${t}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n > ${t}`, 6, 40,
          r => r.data[0].c === countBig(i => bigN(i) > t));
        perf(`V19Scan lte ${t}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n <= ${t}`, 6, 40,
          r => r.data[0].c === countBig(i => bigN(i) <= t));
        perf(`V19Scan eq ${t}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n = ${t}`, 6, 40,
          r => r.data[0].c === countBig(i => bigN(i) === t));
        perf(`V19Scan between ${t}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n BETWEEN ${t} AND ${t + 100}`, 6, 40,
          r => r.data[0].c === countBig(i => bigN(i) >= t && bigN(i) <= t + 100));
      });
      // 複合条件（AND / OR / NOT）でも同じ桁に収まること
      [1, 2, 3, 4, 5, 6, 7, 8].forEach(k => {
        perf(`V19Scan and ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n > ${k * 100} AND flag = 1`, 8, 40,
          r => r.data[0].c === countBig(i => bigN(i) > k * 100 && i % 2 === 1));
        perf(`V19Scan or ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n < ${k * 100} OR grp = ${k}`, 8, 40,
          r => r.data[0].c === countBig(i => bigN(i) < k * 100 || bigGrp(i) === k));
        perf(`V19Scan not ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE NOT (n > ${k * 100})`, 8, 40,
          r => r.data[0].c === countBig(i => !(bigN(i) > k * 100)));
        perf(`V19Scan in ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE grp IN (${k}, ${k + 1}, ${k + 2})`, 8, 40,
          r => r.data[0].c === countBig(i => [k, k + 1, k + 2].includes(bigGrp(i))));
      });
      // 式を含む述語
      [2, 3, 4, 5, 6].forEach(k => {
        perf(`V19Scan expr mod ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE MOD(id, ${k}) = 0`, 10, 50,
          r => r.data[0].c === countBig(i => i % k === 0));
        perf(`V19Scan expr arith ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n * ${k} > 2000`, 10, 50,
          r => r.data[0].c === countBig(i => bigN(i) * k > 2000));
        perf(`V19Scan expr abs ${k}`, `SELECT COUNT(*) AS c FROM v19_big WHERE ABS(n - 500) < ${k * 50}`, 10, 50,
          r => r.data[0].c === countBig(i => Math.abs(bigN(i) - 500) < k * 50));
      });

      // ============================================================
      // 2. インデックス — 等価検索は行数に依らずスキャンより桁で速いこと
      // ============================================================
      fn('V19Idx create', () => !db.executeQuery("CREATE INDEX v19_ix_grp ON v19_big (grp)").error);
      fn('V19Idx explain uses index', () => {
        const r = db.executeQuery("EXPLAIN SELECT * FROM v19_big WHERE grp = 3");
        return !r.error && r.data[0].Operation === 'INDEX SCAN';
      });
      for (let g = 0; g < 20; g++) {
        perf(`V19Idx lookup ${g}`, `SELECT COUNT(*) AS c FROM v19_big WHERE grp = ${g}`, 2, 25,
          r => r.data[0].c === countBig(i => bigGrp(i) === g));
        perf(`V19Idx lookup rows ${g}`, `SELECT id FROM v19_big WHERE grp = ${g} LIMIT 5`, 3, 25,
          r => r.data.length === 5 && r.data.every(x => bigGrp(x.id) === g));
      }
      fn('V19Idx faster than scan', () => {
        const t = (sql) => { let b = Infinity; for (let i = 0; i < 3; i++) { const r = db.executeQuery(sql); if (r.error) return Infinity; b = Math.min(b, Number(r.executionTime)); } return b; };
        const idx = t("SELECT COUNT(*) AS c FROM v19_big WHERE grp = 7");
        const scan = t("SELECT COUNT(*) AS c FROM v19_big WHERE n = 7");
        // インデックス検索はフルスキャンより明確に速い（最低でも 2 倍）
        return idx * 2 <= scan + 0.5;
      });
      fn('V19Idx drop', () => !db.executeQuery("DROP INDEX v19_ix_grp").error);
      fn('V19Idx explain scan after drop', () => {
        const r = db.executeQuery("EXPLAIN SELECT * FROM v19_big WHERE grp = 3");
        return !r.error && r.data[0].Operation === 'TABLE SCAN';
      });

      // ============================================================
      // 3. 集計（20,000 行に対する単一パス集計）
      // ============================================================
      const AGGS = [
        ['COUNT(*)', () => N_BIG],
        ['COUNT(n)', () => N_BIG],
        ['SUM(n)', () => sumBig(bigN)],
        ['MIN(n)', () => BIG.reduce((a, i) => Math.min(a, bigN(i)), Infinity)],
        ['MAX(n)', () => BIG.reduce((a, i) => Math.max(a, bigN(i)), -Infinity)],
        ['SUM(id)', () => sumBig(i => i)],
        ['MAX(id)', () => N_BIG],
        ['MIN(id)', () => 1],
        ['SUM(flag)', () => countBig(i => i % 2 === 1)],
        ['COUNT(DISTINCT grp)', () => 20],
        ['COUNT(DISTINCT flag)', () => 2]
      ];
      AGGS.forEach(([expr, want], i) => {
        perf(`V19Agg ${i} ${expr}`, `SELECT ${expr} AS v FROM v19_big`, 8, 40,
          r => Math.abs(Number(r.data[0].v) - want()) < 1e-6);
      });
      const AGG_LOOSE = ['AVG(n)', 'STDDEV(n)', 'VARIANCE(n)', 'MEDIAN(n)', 'ANY_VALUE(n)',
        'BIT_AND(flag)', 'BIT_OR(flag)', 'BOOL_AND(flag = 0)', 'BOOL_OR(flag = 1)',
        'PERCENTILE_CONT(n, 0.5)', 'PERCENTILE_DISC(n, 0.9)', 'CORR(id, n)', 'COVAR_POP(id, n)',
        'STDDEV_POP(n)', 'VAR_POP(n)', 'COUNT_IF(n > 500)', 'MIN_BY(id, n)', 'MAX_BY(id, n)'];
      AGG_LOOSE.forEach((expr, i) => {
        perf(`V19Agg loose ${i}`, `SELECT ${expr} AS v FROM v19_big`, 15, 60,
          r => r.data.length === 1 && r.data[0].v !== undefined);
      });
      // FILTER 付き集計
      [100, 300, 500, 700, 900].forEach(t => {
        perf(`V19Agg filter ${t}`, `SELECT COUNT(*) FILTER (WHERE n > ${t}) AS c FROM v19_big`, 10, 50,
          r => r.data[0].c === countBig(i => bigN(i) > t));
        perf(`V19Agg sum filter ${t}`, `SELECT SUM(n) FILTER (WHERE n > ${t}) AS s FROM v19_big`, 10, 50,
          r => r.data[0].s === BIG.filter(i => bigN(i) > t).reduce((a, i) => a + bigN(i), 0));
      });
      // 式に内包した集計
      perf('V19Agg expr round avg', "SELECT ROUND(AVG(n), 2) AS v FROM v19_big", 12, 50, r => r.data[0].v !== null);
      perf('V19Agg expr ratio', "SELECT 100.0 * SUM(flag) / COUNT(*) AS v FROM v19_big", 12, 50, r => Math.abs(r.data[0].v - 50) < 0.01);
      perf('V19Agg expr span', "SELECT MAX(n) - MIN(n) AS v FROM v19_big", 12, 50, r => r.data[0].v === 999);

      // ============================================================
      // 4. GROUP BY（グループ数を変えてもハッシュ集約が線形であること）
      // ============================================================
      [2, 4, 5, 8, 10, 16, 20, 25, 40, 50, 100, 200, 500, 1000].forEach(k => {
        perf(`V19Grp mod ${k}`, `SELECT MOD(id, ${k}) AS g, COUNT(*) AS c FROM v19_big GROUP BY MOD(id, ${k})`, 20, 80,
          r => r.data.length === Math.min(k, N_BIG));
      });
      perf('V19Grp having', "SELECT grp, COUNT(*) AS c FROM v19_big GROUP BY grp HAVING COUNT(*) > 100", 15, 60,
        r => r.data.length === 20);
      perf('V19Grp two keys', "SELECT grp, flag, COUNT(*) AS c FROM v19_big GROUP BY grp, flag", 20, 80,
        r => r.data.length === 20);
      perf('V19Grp order by agg', "SELECT grp, SUM(n) AS s FROM v19_big GROUP BY grp ORDER BY s DESC", 20, 80,
        r => r.data.length === 20);
      perf('V19Grp rollup', "SELECT grp, COUNT(*) AS c FROM v19_big GROUP BY grp WITH ROLLUP", 25, 100,
        r => r.data.length === 21);
      perf('V19Grp cube', "SELECT grp, flag, COUNT(*) AS c FROM v19_big GROUP BY CUBE (grp, flag)", 30, 120,
        r => r.data.length > 20);
      perf('V19Grp all', "SELECT grp, COUNT(*) AS c FROM v19_big GROUP BY ALL", 20, 80, r => r.data.length === 20);
      perf('V19Grp concat', "SELECT grp, COUNT(*) AS c FROM v19_big WHERE id < 500 GROUP BY grp", 15, 60, r => r.data.length === 20);
      ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].forEach(f => {
        perf(`V19Grp agg ${f}`, `SELECT grp, ${f}(n) AS v FROM v19_big GROUP BY grp ORDER BY grp`, 20, 80,
          r => r.data.length === 20 && r.data[0].grp === 0);
      });
      perf('V19Grp group_concat small', "SELECT grp, GROUP_CONCAT(id) AS g FROM v19_big WHERE id <= 200 GROUP BY grp", 20, 80,
        r => r.data.length === 20);

      // ============================================================
      // 5. ORDER BY / LIMIT（ソートは n log n に収まること）
      // ============================================================
      ['id', 'n', 'grp', 's', 'flag'].forEach(col => {
        ['ASC', 'DESC'].forEach(dir => {
          perf(`V19Sort ${col} ${dir}`, `SELECT id FROM v19_big ORDER BY ${col} ${dir} LIMIT 10`, 25, 100,
            r => r.data.length === 10);
        });
      });
      perf('V19Sort two keys', "SELECT id FROM v19_big ORDER BY grp ASC, n DESC LIMIT 10", 25, 100, r => r.data.length === 10);
      perf('V19Sort expr', "SELECT id FROM v19_big ORDER BY n * 2 + id DESC LIMIT 10", 35, 140, r => r.data.length === 10);
      perf('V19Sort nulls last', "SELECT id FROM v19_big ORDER BY n DESC NULLS LAST LIMIT 10", 25, 100, r => r.data.length === 10);
      perf('V19Sort ordinal', "SELECT id, n FROM v19_big ORDER BY 2 LIMIT 10", 25, 100, r => r.data.length === 10);
      [1, 10, 100, 1000, 5000].forEach(k => {
        perf(`V19Lim ${k}`, `SELECT id FROM v19_big ORDER BY id LIMIT ${k}`, 25, 100, r => r.data.length === k);
        perf(`V19Off ${k}`, `SELECT id FROM v19_big ORDER BY id LIMIT 10 OFFSET ${k}`, 25, 100,
          r => r.data.length === 10 && r.data[0].id === k + 1);
      });
      perf('V19Lim top percent', "SELECT TOP 1 PERCENT id FROM v19_big ORDER BY id", 25, 100, r => r.data.length === 200);
      perf('V19Lim with ties', "SELECT id, grp FROM v19_big ORDER BY grp LIMIT 1 WITH TIES", 25, 100, r => r.data.length === 1000);
      perf('V19Dist grp', "SELECT DISTINCT grp FROM v19_big", 20, 80, r => r.data.length === 20);
      perf('V19Dist two', "SELECT DISTINCT grp, flag FROM v19_big", 25, 100, r => r.data.length === 20);
      perf('V19Dist on', "SELECT DISTINCT ON (grp) grp, n FROM v19_big ORDER BY grp, n DESC", 30, 120, r => r.data.length === 20);

      // ============================================================
      // 6. 結合（ハッシュ結合が積ではなく和のオーダーであること）
      // ============================================================
      perf('V19Join hash mid-dim', "SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g", 25, 100,
        r => r.data[0].c === N_MID);
      perf('V19Join hash big-dim', "SELECT COUNT(*) AS c FROM v19_big b JOIN v19_dim d ON b.grp = d.g", 40, 150,
        r => r.data[0].c === N_BIG);
      perf('V19Join left', "SELECT COUNT(*) AS c FROM v19_mid m LEFT JOIN v19_dim d ON m.g = d.g", 30, 120,
        r => r.data[0].c === N_MID);
      perf('V19Join right', "SELECT COUNT(*) AS c FROM v19_mid m RIGHT JOIN v19_dim d ON m.g = d.g", 30, 120,
        r => r.data[0].c >= N_MID);
      perf('V19Join full', "SELECT COUNT(*) AS c FROM v19_mid m FULL OUTER JOIN v19_dim d ON m.g = d.g", 35, 140,
        r => r.data[0].c >= N_MID);
      perf('V19Join self key', "SELECT COUNT(*) AS c FROM v19_mid a JOIN v19_mid b ON a.id = b.id", 35, 140,
        r => r.data[0].c === N_MID);
      perf('V19Join three way', "SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g JOIN v19_dim d2 ON d.g = d2.g", 45, 180,
        r => r.data[0].c === N_MID);
      perf('V19Join using', "SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d USING (g)", 30, 120, r => r.data[0].c === N_MID);
      perf('V19Join filtered', "SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g WHERE m.v > 250", 30, 120,
        r => r.data[0].c === MID.filter(i => midV(i) > 250).length);
      perf('V19Join agg', "SELECT d.label, COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g GROUP BY d.label", 40, 160,
        r => r.data.length === 50);
      perf('V19Join cross small', "SELECT COUNT(*) AS c FROM v19_dim a CROSS JOIN v19_dim b", 40, 160,
        r => r.data[0].c === N_DIM * N_DIM);
      perf('V19Join nested loop small', "SELECT COUNT(*) AS c FROM v19_dim a JOIN v19_dim b ON a.g < b.g", 40, 160,
        r => r.data[0].c === (N_DIM * (N_DIM - 1)) / 2);
      for (let k = 0; k < 10; k++) {
        perf(`V19Join eq filter ${k}`, `SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g WHERE d.w = ${k % 7}`, 30, 120,
          r => typeof r.data[0].c === 'number');
      }

      // ============================================================
      // 7. ウィンドウ関数（パーティションごとの計算が線形であること）
      // ============================================================
      const WFS = ['ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'PERCENT_RANK()', 'CUME_DIST()',
        'LAG(v)', 'LEAD(v)', 'FIRST_VALUE(v)', 'LAST_VALUE(v)', 'NTILE(4)',
        'SUM(v)', 'AVG(v)', 'MIN(v)', 'MAX(v)', 'COUNT(*)'];
      WFS.forEach((w, i) => {
        perf(`V19Win ${i} ${w}`, `SELECT COUNT(*) AS c FROM (SELECT ${w} OVER (PARTITION BY g ORDER BY v) AS x FROM v19_mid) t`, 60, 250,
          r => r.data[0].c === N_MID);
      });
      perf('V19Win no partition', "SELECT COUNT(*) AS c FROM (SELECT ROW_NUMBER() OVER (ORDER BY v) AS x FROM v19_mid) t", 60, 250,
        r => r.data[0].c === N_MID);
      perf('V19Win frame rows', "SELECT COUNT(*) AS c FROM (SELECT SUM(v) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS x FROM v19_mid) t", 70, 300,
        r => r.data[0].c === N_MID);
      perf('V19Win frame range', "SELECT COUNT(*) AS c FROM (SELECT SUM(v) OVER (PARTITION BY g ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS x FROM v19_mid) t", 80, 320,
        r => r.data[0].c === N_MID);
      perf('V19Win qualify', "SELECT COUNT(*) AS c FROM (SELECT id FROM v19_mid QUALIFY ROW_NUMBER() OVER (PARTITION BY g ORDER BY v) = 1) t", 70, 300,
        r => r.data[0].c === 50);
      perf('V19Win named window', "SELECT COUNT(*) AS c FROM (SELECT RANK() OVER w AS x FROM v19_mid WINDOW w AS (PARTITION BY g ORDER BY v)) t", 70, 300,
        r => r.data[0].c === N_MID);

      // ============================================================
      // 8. 文字列 / スカラー関数（20,000 行に適用）
      // ============================================================
      const SFNS = ['UPPER(s)', 'LOWER(s)', 'LENGTH(s)', 'TRIM(s)', 'REVERSE(s)', 'LEFT(s, 3)',
        'RIGHT(s, 3)', 'SUBSTRING(s, 2, 3)', 'REPLACE(s, \'row\', \'r\')', 'CONCAT(s, \'x\')',
        's || \'x\'', 'INSTR(s, \'w\')', 'LPAD(s, 12, \'0\')', 'INITCAP(s)', 'MD5(s)',
        'TO_BASE64(s)', 'SOUNDEX(s)', 'HEX(n)', 'ABS(n - 500)', 'ROUND(n / 7.0, 2)',
        'SQRT(n)', 'POWER(n, 2)', 'MOD(n, 7)', 'SIGN(n - 500)', 'CAST(n AS TEXT)',
        'n::TEXT', 'COALESCE(n, 0)', 'NULLIF(n, 0)', 'GREATEST(n, 500)', 'LEAST(n, 500)'];
      SFNS.forEach((f, i) => {
        perf(`V19Fn ${i}`, `SELECT COUNT(${f}) AS c FROM v19_big`, 30, 130, r => r.data[0].c >= 0);
      });
      perf('V19Fn like prefix', "SELECT COUNT(*) AS c FROM v19_big WHERE s LIKE 'row1%'", 25, 100,
        r => r.data[0].c === countBig(i => ('row' + i).indexOf('row1') === 0));
      perf('V19Fn like suffix', "SELECT COUNT(*) AS c FROM v19_big WHERE s LIKE '%9'", 25, 100,
        r => r.data[0].c === countBig(i => String(i).endsWith('9')));
      perf('V19Fn like contains', "SELECT COUNT(*) AS c FROM v19_big WHERE s LIKE '%123%'", 25, 100,
        r => r.data[0].c === countBig(i => ('row' + i).indexOf('123') !== -1));
      perf('V19Fn ilike', "SELECT COUNT(*) AS c FROM v19_big WHERE s ILIKE 'ROW1%'", 25, 100,
        r => r.data[0].c === countBig(i => ('row' + i).indexOf('row1') === 0));
      perf('V19Fn regexp', "SELECT COUNT(*) AS c FROM v19_big WHERE s REGEXP '^row1[0-9]$'", 30, 130,
        r => r.data[0].c === countBig(i => /^row1[0-9]$/.test('row' + i)));
      perf('V19Fn similar', "SELECT COUNT(*) AS c FROM v19_big WHERE s SIMILAR TO 'row1_'", 30, 130,
        r => r.data[0].c === countBig(i => /^row1.$/.test('row' + i)));
      perf('V19Fn case expr', "SELECT COUNT(*) AS c FROM v19_big WHERE (CASE WHEN n > 500 THEN 1 ELSE 0 END) = 1", 25, 100,
        r => r.data[0].c === countBig(i => bigN(i) > 500));
      perf('V19Fn nested fns', "SELECT COUNT(*) AS c FROM v19_big WHERE LENGTH(UPPER(TRIM(s))) > 5", 30, 130,
        r => r.data[0].c === countBig(i => ('row' + i).length > 5));
      fn('V19Fn udf overhead', () => {
        db.executeQuery("CREATE OR REPLACE FUNCTION v19_f(x) RETURNS INT AS RETURN x * 2 + 1");
        const t = (sql) => { let b = Infinity; for (let i = 0; i < 3; i++) { const r = db.executeQuery(sql); if (r.error) return Infinity; b = Math.min(b, Number(r.executionTime)); } return b; };
        const inline = t("SELECT COUNT(*) AS c FROM v19_big WHERE n * 2 + 1 > 500");
        const udf = t("SELECT COUNT(*) AS c FROM v19_big WHERE v19_f(n) > 500");
        db.executeQuery("DROP FUNCTION IF EXISTS v19_f");
        // UDF はコンパイル時に式へ展開されるので、行あたりのコストは組み込み式と同等
        return isFinite(udf) && udf <= Math.max(inline * 3, inline + 30);
      });

      // ============================================================
      // 9. サブクエリ / CTE / 集合演算
      // ============================================================
      perf('V19Sub in list', "SELECT COUNT(*) AS c FROM v19_big WHERE grp IN (SELECT g FROM v19_dim WHERE g < 5)", 30, 130,
        r => r.data[0].c === countBig(i => bigGrp(i) < 5));
      perf('V19Sub scalar', "SELECT COUNT(*) AS c FROM v19_big WHERE n > (SELECT AVG(n) FROM v19_big)", 40, 160, r => r.data[0].c > 0);
      perf('V19Sub exists', "SELECT COUNT(*) AS c FROM v19_mid m WHERE EXISTS (SELECT 1 FROM v19_dim d WHERE d.g = 1)", 30, 130,
        r => r.data[0].c === N_MID);
      perf('V19Sub derived', "SELECT COUNT(*) AS c FROM (SELECT id, n FROM v19_big WHERE n > 500) t", 30, 130,
        r => r.data[0].c === countBig(i => bigN(i) > 500));
      perf('V19Sub derived cols', "SELECT COUNT(*) AS c FROM (SELECT id, n FROM v19_big WHERE n > 900) d(a, b)", 30, 130,
        r => r.data[0].c === countBig(i => bigN(i) > 900));
      perf('V19Cte simple', "WITH c AS (SELECT grp, COUNT(*) AS k FROM v19_big GROUP BY grp) SELECT COUNT(*) AS c FROM c", 30, 130,
        r => r.data[0].c === 20);
      perf('V19Cte chained', "WITH a AS (SELECT id, n FROM v19_big WHERE n > 500), b AS (SELECT COUNT(*) AS k FROM a) SELECT k AS c FROM b", 35, 140,
        r => r.data[0].c === countBig(i => bigN(i) > 500));
      perf('V19Cte recursive', "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 200) SELECT COUNT(*) AS c FROM r", 60, 250,
        r => r.data[0].c === 200);
      perf('V19Set union', "SELECT id FROM v19_mid UNION SELECT id FROM v19_mid", 60, 250, r => r.data.length === N_MID);
      perf('V19Set union all', "SELECT id FROM v19_mid UNION ALL SELECT id FROM v19_mid", 50, 200, r => r.data.length === N_MID * 2);
      perf('V19Set intersect', "SELECT id FROM v19_mid INTERSECT SELECT id FROM v19_mid", 60, 250, r => r.data.length === N_MID);
      perf('V19Set except', "SELECT id FROM v19_mid EXCEPT SELECT id FROM v19_mid WHERE v > 250", 60, 250,
        r => r.data.length === MID.filter(i => midV(i) <= 250).length);
      perf('V19Set minus', "SELECT id FROM v19_mid MINUS SELECT id FROM v19_mid WHERE v > 250", 60, 250,
        r => r.data.length === MID.filter(i => midV(i) <= 250).length);

      // ============================================================
      // 10. DML スループット
      // ============================================================
      fn('V19Dml create sink', () => !db.executeQuery("CREATE TABLE v19_sink (id INTEGER, v INTEGER)").error);
      perf('V19Dml insert select 5k', "INSERT INTO v19_sink SELECT id, n FROM v19_big WHERE id <= 5000", 40, 200,
        r => r.data[0].Result === 'Success');
      perf('V19Dml count after insert', "SELECT COUNT(*) AS c FROM v19_sink", 6, 40, r => r.data[0].c === 5000);
      perf('V19Dml update all', "UPDATE v19_sink SET v = v + 1", 60, 250, r => r.data[0].Result === 'Success');
      perf('V19Dml update filtered', "UPDATE v19_sink SET v = 0 WHERE id <= 1000", 40, 200, r => r.data[0].Result === 'Success');
      perf('V19Dml verify update', "SELECT COUNT(*) AS c FROM v19_sink WHERE v = 0", 8, 40, r => r.data[0].c >= 1000);
      perf('V19Dml delete filtered', "DELETE FROM v19_sink WHERE id <= 1000", 40, 200, r => r.data[0].Result === 'Success');
      perf('V19Dml count after delete', "SELECT COUNT(*) AS c FROM v19_sink", 6, 40, r => r.data[0].c === 4000);
      perf('V19Dml delete all', "DELETE FROM v19_sink", 40, 200, r => r.data[0].Result === 'Success');
      fn('V19Dml multi-row insert 1000', () => {
        const vals = [];
        for (let i = 1; i <= 1000; i++) vals.push(`(${i}, ${i * 2})`);
        const r = db.executeQuery("INSERT INTO v19_sink VALUES " + vals.join(','));
        return !r.error && Number(r.executionTime) <= bud(80, 400);
      });
      perf('V19Dml verify bulk', "SELECT COUNT(*) AS c FROM v19_sink", 6, 40, r => r.data[0].c === 1000);
      fn('V19Dml transaction batch', () => {
        const t0 = performance.now();
        db.executeQuery('BEGIN');
        for (let i = 0; i < 200; i++) db.executeQuery(`INSERT INTO v19_sink VALUES (${2000 + i}, 1)`);
        db.executeQuery('COMMIT');
        const ms = performance.now() - t0;
        const c = db.executeQuery("SELECT COUNT(*) AS c FROM v19_sink").data[0].c;
        return c === 1200 && ms <= bud(300, 1500);
      });
      fn('V19Dml rollback cost', () => {
        const t0 = performance.now();
        db.executeQuery('BEGIN');
        db.executeQuery("UPDATE v19_sink SET v = 999");
        db.executeQuery('ROLLBACK');
        const ms = performance.now() - t0;
        const c = db.executeQuery("SELECT COUNT(*) AS c FROM v19_sink WHERE v = 999").data[0].c;
        return c === 0 && ms <= bud(200, 900);
      });
      perf('V19Dml truncate', "TRUNCATE TABLE v19_sink", 20, 80, r => r.data[0].Result === 'Success');
      fn('V19Dml drop sink', () => !db.executeQuery("DROP TABLE v19_sink").error);

      // ============================================================
      // 11. スケーリング（N → 2N で線形の範囲に収まること）
      //     計算量が跳ねると比率が大きく崩れるので、そこを見る
      // ============================================================
      const timeIt = (sql, reps) => {
        let best = Infinity;
        for (let i = 0; i < (reps || 3); i++) {
          const r = db.executeQuery(sql);
          if (r.error) return Infinity;
          best = Math.min(best, Number(r.executionTime));
        }
        return best;
      };
      const scaling = (name, sqlOf, ratioMax) => fn(name, () => {
        const t1 = timeIt(sqlOf(5000));
        const t2 = timeIt(sqlOf(10000));
        const t4 = timeIt(sqlOf(20000));
        if (!isFinite(t4)) return false;
        // 微小時間の測定誤差を吸収するため下駄を履かせる
        const r2 = (t2 + 1) / (t1 + 1);
        const r4 = (t4 + 1) / (t1 + 1);
        return r2 <= ratioMax && r4 <= ratioMax * ratioMax;
      });
      scaling('V19Scale filter linear', (n) => `SELECT COUNT(*) AS c FROM v19_big WHERE id <= ${n} AND n > 500`, 4);
      scaling('V19Scale sum linear', (n) => `SELECT SUM(n) AS s FROM v19_big WHERE id <= ${n}`, 4);
      scaling('V19Scale group linear', (n) => `SELECT grp, COUNT(*) AS c FROM v19_big WHERE id <= ${n} GROUP BY grp`, 4);
      scaling('V19Scale distinct linear', (n) => `SELECT DISTINCT grp FROM v19_big WHERE id <= ${n}`, 4);
      scaling('V19Scale sort nlogn', (n) => `SELECT id FROM v19_big WHERE id <= ${n} ORDER BY n LIMIT 5`, 5);
      scaling('V19Scale string fn linear', (n) => `SELECT COUNT(UPPER(s)) AS c FROM v19_big WHERE id <= ${n}`, 4);
      scaling('V19Scale like linear', (n) => `SELECT COUNT(*) AS c FROM v19_big WHERE id <= ${n} AND s LIKE '%1%'`, 4);
      scaling('V19Scale concat linear', (n) => `SELECT COUNT(s || 'x') AS c FROM v19_big WHERE id <= ${n}`, 4);
      fn('V19Scale hash join not quadratic', () => {
        const t1 = timeIt("SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g WHERE m.id <= 1000");
        const t4 = timeIt("SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g WHERE m.id <= 4000");
        return isFinite(t4) && (t4 + 1) / (t1 + 1) <= 12;
      });
      fn('V19Scale index lookup flat', () => {
        db.executeQuery("CREATE INDEX v19_ix2 ON v19_big (grp)");
        const t1 = timeIt("SELECT COUNT(*) AS c FROM v19_big WHERE grp = 1");
        const scan = timeIt("SELECT COUNT(*) AS c FROM v19_big WHERE n = 1");
        db.executeQuery("DROP INDEX v19_ix2");
        // インデックス検索の時間は行数ではなくヒット件数に比例するので、スキャンより十分小さい
        return t1 <= Math.max(scan * 0.75, 1.5);
      });

      // ============================================================
      // 12. 運用機能のコスト（スナップショット / エクスポート / タイムアウト）
      // ============================================================
      fn('V19Ops snapshot create cost', () => {
        const t0 = performance.now();
        const r = db.executeQuery("CREATE SNAPSHOT v19_snap");
        const ms = performance.now() - t0;
        return !r.error && ms <= bud(120, 600);
      });
      fn('V19Ops snapshot restore cost', () => {
        db.executeQuery("DELETE FROM v19_mid");
        const t0 = performance.now();
        const r = db.executeQuery("RESTORE SNAPSHOT v19_snap");
        const ms = performance.now() - t0;
        const c = db.executeQuery("SELECT COUNT(*) AS c FROM v19_mid").data[0].c;
        return !r.error && c === N_MID && ms <= bud(120, 600);
      });
      fn('V19Ops snapshot drop', () => !db.executeQuery("DROP SNAPSHOT v19_snap").error);
      fn('V19Ops exportForIDB cost', () => {
        const t0 = performance.now();
        const dump = db.exportForIDB();
        const ms = performance.now() - t0;
        return !!dump.v19_big && ms <= bud(150, 700);
      });
      fn('V19Ops show storage', () => {
        const r = db.executeQuery("SHOW STORAGE");
        return !r.error && Number(r.executionTime) <= bud(60, 250);
      });
      fn('V19Ops csv export cost', () => {
        const t0 = performance.now();
        const csv = LuminaDB.csv("SELECT id, n FROM v19_big WHERE id <= 5000");
        const ms = performance.now() - t0;
        return csv.split('\n').length === 5001 && ms <= bud(150, 700);
      });
      fn('V19Ops exportJSON cost', () => {
        const t0 = performance.now();
        const out = LuminaDB.exportJSON(['v19_dim']);
        const ms = performance.now() - t0;
        return out.v19_dim.length === N_DIM && ms <= bud(60, 250);
      });
      fn('V19Ops vacuum cost', () => {
        const r = db.executeQuery("VACUUM");
        return !r.error && Number(r.executionTime) <= bud(200, 900);
      });
      [10, 20, 40, 80].forEach(ms => {
        fn(`V19Ops timeout ${ms}ms honoured`, () => {
          db.statementTimeoutMs = ms;
          const t0 = performance.now();
          const r = db.executeQuery(
            "SELECT COUNT(*) AS c FROM v19_mid a JOIN v19_mid b ON a.v <> b.v JOIN v19_mid c ON c.v <> a.v");
          const el = performance.now() - t0;
          db.statementTimeoutMs = 0;
          // 期限を大きく超える前に止まること（チェック間隔ぶんの余裕を見て 25 倍 + 250ms）
          return !!r.error && /timeout/i.test(r.error) && el < ms * 25 + 250;
        });
      });
      fn('V19Ops timeout off completes', () => {
        db.statementTimeoutMs = 0;
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v19_big WHERE n > 500");
        return !r.error && r.data[0].c === countBig(i => bigN(i) > 500);
      });
      fn('V19Ops no-timeout overhead', () => {
        // 期限未設定時のチェックコストが実質ゼロであること（較正値の 3 倍以内）
        db.statementTimeoutMs = 0;
        const t = timeIt("SELECT COUNT(*) AS c FROM v19_big WHERE n > 500", 5);
        return t <= bud(3, 30);
      });
      fn('V19Ops profile recorded', () => {
        db.executeQuery("SELECT COUNT(*) AS c FROM v19_big");
        const p = db.lastProfile;
        return !!p && typeof p.ms === 'number' && p.rows === 1;
      });
      fn('V19Ops slow log bounded', () => {
        db.slowLogThresholdMs = 0;
        for (let i = 0; i < 150; i++) db.executeQuery("SELECT 1 AS x");
        const n = db.slowLog.length;
        db.slowLogThresholdMs = 50;
        db.slowLog = [];
        return n === 100;   // リングバッファ上限
      });

      // ============================================================
      // 13. 繰り返し実行の安定性（式コンパイルのコストが累積しないこと）
      // ============================================================
      fn('V19Rep repeated compile stable', () => {
        const first = timeIt("SELECT COUNT(*) AS c FROM v19_big WHERE n > 123", 1);
        let worst = 0;
        for (let i = 0; i < 30; i++) {
          const r = db.executeQuery("SELECT COUNT(*) AS c FROM v19_big WHERE n > 123");
          if (r.error) return false;
          worst = Math.max(worst, Number(r.executionTime));
        }
        return worst <= Math.max(first * 4, bud(10, 60));
      });
      fn('V19Rep distinct sql no leak', () => {
        const before = Object.keys(db.tables).length;
        for (let i = 0; i < 50; i++) db.executeQuery(`SELECT COUNT(*) AS c FROM v19_big WHERE n > ${i}`);
        return Object.keys(db.tables).length === before;
      });
      fn('V19Rep subquery temp cleanup', () => {
        for (let i = 0; i < 20; i++) db.executeQuery(`SELECT COUNT(*) AS c FROM (SELECT id FROM v19_mid WHERE id > ${i}) t`);
        return Object.keys(db.tables).filter(t => t.startsWith('__tmp_')).length === 0;
      });
      fn('V19Rep string pool bounded', () => {
        const t = db.tables['v19_big'];
        // 同一列の文字列プールは重複を持たない（20,000 行ぶんちょうど）
        return t.strPools['s'].length <= N_BIG + 1;
      });
      for (let i = 0; i < 20; i++) {
        perf(`V19Rep steady ${i}`, `SELECT COUNT(*) AS c FROM v19_big WHERE n > ${400 + i}`, 8, 40,
          r => r.data[0].c === countBig(j => bigN(j) > 400 + i));
      }

      // ============================================================
      // 14. 絶対値の下限保証（較正に頼らない安全網）
      //     較正付き予算は「一様に遅くなった」場合には一緒に緩んでしまうため、
      //     どんな実行環境でも通るはずの緩い絶対値も併せて固定する。
      //     普通のマシンでは 10〜100 倍の余裕があり、桁で遅くなった時だけ落ちる。
      // ============================================================
      const ABS = [
        ['scan 20k rows', "SELECT COUNT(*) AS c FROM v19_big WHERE n > 500", 300],
        ['count 20k rows', "SELECT COUNT(*) AS c FROM v19_big", 200],
        ['sum 20k rows', "SELECT SUM(n) AS s FROM v19_big", 300],
        ['group 20k rows', "SELECT grp, COUNT(*) AS c FROM v19_big GROUP BY grp", 500],
        ['distinct 20k rows', "SELECT DISTINCT grp FROM v19_big", 500],
        ['sort 20k rows', "SELECT id FROM v19_big ORDER BY n LIMIT 10", 800],
        ['like 20k rows', "SELECT COUNT(*) AS c FROM v19_big WHERE s LIKE '%1%'", 600],
        ['upper 20k rows', "SELECT COUNT(UPPER(s)) AS c FROM v19_big", 800],
        ['concat 20k rows', "SELECT COUNT(s || 'x') AS c FROM v19_big", 800],
        ['hash join 4k x 100', "SELECT COUNT(*) AS c FROM v19_mid m JOIN v19_dim d ON m.g = d.g", 800],
        ['window 4k rows', "SELECT COUNT(*) AS c FROM (SELECT ROW_NUMBER() OVER (PARTITION BY g ORDER BY v) AS x FROM v19_mid) t", 1200],
        ['cte 20k rows', "WITH c AS (SELECT grp FROM v19_big WHERE n > 500) SELECT COUNT(*) AS c FROM c", 800]
      ];
      ABS.forEach(([label, sql, capMs]) => {
        fn(`V19Abs ${label} < ${capMs}ms`, () => {
          const r = db.executeQuery(sql);
          return !r.error && Number(r.executionTime) < capMs;
        });
      });
      fn('V19Abs insert 5000 rows < 2000ms', () => {
        db.executeQuery("CREATE TABLE v19_abs (id INTEGER, v INTEGER)");
        const r = db.executeQuery("INSERT INTO v19_abs SELECT id, n FROM v19_big WHERE id <= 5000");
        const ok = !r.error && Number(r.executionTime) < 2000;
        db.executeQuery("DROP TABLE v19_abs");
        return ok;
      });
      fn('V19Abs calibration sane', () => CAL.base > 0 && CAL.base < 300);

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V19Cl drop big', () => !db.executeQuery("DROP TABLE v19_big").error);
      fn('V19Cl drop mid', () => !db.executeQuery("DROP TABLE v19_mid").error);
      fn('V19Cl drop dim', () => !db.executeQuery("DROP TABLE v19_dim").error);

      return T;
    }
