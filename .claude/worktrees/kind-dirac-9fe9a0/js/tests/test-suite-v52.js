    // ============================================================================
    // [Test Suite v52] - 書き味 (2/5): 同じ意味の別の書き方
    //
    //   「意味は同じだが書き方が違う」クエリ同士を突き合わせる。字句の違い（v51）と
    //   違って、こちらは述語・結合・集約・副問い合わせの組み立て方そのものを変える。
    //   3 値論理（NULL）が絡んでも一致することを確かめたいので、フィクスチャには
    //   NULL を含む列を用意してある。
    //
    //     A. 述語の言い換え（= / <> / < / BETWEEN / IN / IS NULL）
    //     B. 論理演算の言い換え（交換法則・ド・モルガン・分配法則・二重否定）
    //     C. 結合の言い換え（JOIN / カンマ / CROSS+WHERE / 副問い合わせ / 左右の入れ替え）
    //     D. 集約の言い換え（COUNT(*) / GROUP BY の書き方 / HAVING と副問い合わせ）
    //     E. 副問い合わせ・CTE・派生表の言い換え
    //     F. 並べ替えとページングの言い換え
    //     G. 式と関数の同義形（|| と CONCAT / SUBSTRING の各形 / COALESCE の各形 など）
    //     H. 集合演算の言い換え
    //
    //   test-suite.js の tests 配列へ getV52Tests() のスプレッドで合流する
    // ============================================================================
    function getV52Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, differs, insertRows, drop, cleanup } = makeTestKit('V52');
      // WHERE 句だけを差し替えて比べる
      const sameWhere = (name, basePred, varPred) =>
        same(name, `SELECT id FROM v52_emp WHERE ${basePred} ORDER BY id`,
                   `SELECT id FROM v52_emp WHERE ${varPred} ORDER BY id`);

      // ------------------------------------------------------------
      // 0. フィクスチャ（NULL を含む。読み取り専用）
      // ------------------------------------------------------------
      t('V52 fixture', () => {
        drop('v52_emp', 'v52_dept', 'v52_sale');
        q("CREATE TABLE v52_dept (dname TEXT PRIMARY KEY, floor INT)");
        q("CREATE TABLE v52_emp (id INT PRIMARY KEY, name TEXT, dept TEXT, sal INT, mgr INT, hired DATE, active BOOLEAN)");
        q("CREATE TABLE v52_sale (sid INT PRIMARY KEY, eid INT, amt INT, region TEXT)");
        insertRows('v52_dept', [['Sales', 1], ['Tech', 2], ['HR', 3], ['Ops', 2]]);
        const names = ['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay', 'Gil', 'Hal'];
        const dn = ['Sales', 'Tech', 'HR', 'Ops'];
        const emp = [], sale = [];
        for (let i = 1; i <= 40; i++) {
          emp.push([
            i,
            names[i % 8] + i,
            (i % 9 === 0) ? null : dn[i % 4],
            (i % 8 === 0) ? null : 200 + ((i * 5) % 10) * 25,
            (i % 6 === 0) ? null : ((i * 7) % 40) + 1,
            `20${19 + (i % 5)}-${String((i % 12) + 1).padStart(2, '0')}-1${i % 10}`,
            i % 3 !== 0
          ]);
          sale.push([
            i,
            (i % 7 === 0) ? null : ((i * 3) % 40) + 1,
            (i % 11 === 0) ? null : ((i * 13) % 150) + 20,
            ['east', 'west', 'north', 'south'][i % 4]
          ]);
        }
        insertRows('v52_emp', emp);
        insertRows('v52_sale', sale);
        return db.tables['v52_emp'].rowCount === 40 && db.tables['v52_sale'].rowCount === 40;
      });

      // ============================================================
      // A. 述語の言い換え
      //   NULL を含む列に対しても、書き換え前後で通る行が変わらないことを見る
      // ============================================================
      const NUMCOLS = ['sal', 'id', 'mgr'];
      const NUMVALS = [200, 250, 325, 400, 41];
      NUMCOLS.forEach(c => NUMVALS.forEach(v => {
        // 等値
        [
          [`${v} = ${c}`, 'flipped'],
          [`NOT (${c} <> ${v})`, 'NOT <>'],
          [`NOT ${c} != ${v}`, 'NOT !='],
          [`${c} IN (${v})`, 'IN with one item'],
          [`${c} BETWEEN ${v} AND ${v}`, 'BETWEEN v AND v'],
          [`${c} >= ${v} AND ${c} <= ${v}`, '>= AND <='],
          [`NOT (${c} < ${v} OR ${c} > ${v})`, 'NOT (< OR >)'],
          [`COALESCE(${c} = ${v}, FALSE)`, 'COALESCE(pred, FALSE)'],
          [`CASE WHEN ${c} = ${v} THEN TRUE ELSE FALSE END`, 'CASE'],
          [`${c} - ${v} = 0`, 'difference = 0'],
        ].forEach(([alt, label]) => sameWhere(`V52A ${c} = ${v} as ${label}`, `${c} = ${v}`, alt));
        // 非等値
        [
          [`${c} != ${v}`, '!='],
          [`NOT (${c} = ${v})`, 'NOT ='],
          [`${c} < ${v} OR ${c} > ${v}`, '< OR >'],
          [`${c} NOT IN (${v})`, 'NOT IN'],
          [`NOT ${c} IN (${v})`, 'NOT IN (prefix)'],
          [`${c} IS DISTINCT FROM ${v} AND ${c} IS NOT NULL`, 'IS DISTINCT FROM'],
        ].forEach(([alt, label]) => sameWhere(`V52A ${c} <> ${v} as ${label}`, `${c} <> ${v}`, alt));
        // 大小
        [
          [`${v} > ${c}`, 'flipped'],
          [`NOT (${c} >= ${v})`, 'NOT >='],
          [`${c} <= ${v} - 1`, '<= v-1 (整数列)'],
          [`${c} - ${v} < 0`, 'difference < 0'],
        ].forEach(([alt, label]) => sameWhere(`V52A ${c} < ${v} as ${label}`, `${c} < ${v}`, alt));
        [
          [`${v} <= ${c}`, 'flipped'],
          [`NOT (${c} < ${v})`, 'NOT <'],
          [`${c} > ${v} - 1`, '> v-1 (整数列)'],
        ].forEach(([alt, label]) => sameWhere(`V52A ${c} >= ${v} as ${label}`, `${c} >= ${v}`, alt));
      }));
      // 範囲
      NUMCOLS.forEach(c => [[200, 400], [1, 20], [325, 325], [400, 200]].forEach(([lo, hi]) => {
        [
          [`${c} >= ${lo} AND ${c} <= ${hi}`, '>= AND <='],
          [`NOT (${c} < ${lo} OR ${c} > ${hi})`, 'NOT (< OR >)'],
          [`${c} BETWEEN SYMMETRIC ${lo} AND ${hi} AND ${c} >= ${lo}`, 'SYMMETRIC + 下限'],
        ].forEach(([alt, label]) =>
          sameWhere(`V52A ${c} BETWEEN ${lo} AND ${hi} as ${label}`, `${c} BETWEEN ${lo} AND ${hi}`, alt));
        [
          [`${c} < ${lo} OR ${c} > ${hi}`, '< OR >'],
          [`NOT (${c} BETWEEN ${lo} AND ${hi})`, 'NOT BETWEEN'],
        ].forEach(([alt, label]) =>
          sameWhere(`V52A ${c} NOT BETWEEN ${lo} AND ${hi} as ${label}`, `${c} NOT BETWEEN ${lo} AND ${hi}`, alt));
      }));
      // IN リスト
      const INLISTS = [['sal', '200, 250, 325'], ['id', '1, 2, 3, 40'], ['mgr', '5, 10'],
                       ['dept', "'Tech', 'HR'"], ['name', "'Ann8', 'Bob1'"]];
      INLISTS.forEach(([c, list]) => {
        const items = list.split(',').map(x => x.trim());
        sameWhere(`V52A ${c} IN (${list}) as OR chain`, `${c} IN (${list})`,
                  items.map(v => `${c} = ${v}`).join(' OR '));
        sameWhere(`V52A ${c} IN (${list}) as = ANY`, `${c} IN (${list})`, `${c} = ANY (${list})`);
        sameWhere(`V52A ${c} IN (${list}) as NOT NOT IN`, `${c} IN (${list})`, `NOT ${c} NOT IN (${list})`);
        sameWhere(`V52A ${c} NOT IN (${list}) as AND chain`, `${c} NOT IN (${list})`,
                  items.map(v => `${c} <> ${v}`).join(' AND '));
        sameWhere(`V52A ${c} NOT IN (${list}) as <> ALL`, `${c} NOT IN (${list})`, `${c} <> ALL (${list})`);
      });
      // NULL 判定
      ['sal', 'mgr', 'dept'].forEach(c => {
        sameWhere(`V52A ${c} IS NULL as NOT IS NOT NULL`, `${c} IS NULL`, `NOT (${c} IS NOT NULL)`);
        sameWhere(`V52A ${c} IS NULL as IS NOT DISTINCT FROM NULL`, `${c} IS NULL`, `${c} IS NOT DISTINCT FROM NULL`);
        sameWhere(`V52A ${c} IS NULL as COALESCE`, `${c} IS NULL`, `COALESCE(${c} IS NULL, TRUE)`);
        sameWhere(`V52A ${c} IS NOT NULL as NOT IS NULL`, `${c} IS NOT NULL`, `NOT (${c} IS NULL)`);
        sameWhere(`V52A ${c} IS NOT NULL as IS DISTINCT FROM NULL`, `${c} IS NOT NULL`, `${c} IS DISTINCT FROM NULL`);
      });
      // 文字列の述語
      [
        ["dept = 'Tech'", "'Tech' = dept", 'flipped'],
        ["dept = 'Tech'", "dept LIKE 'Tech'", 'LIKE without wildcards'],
        ["dept = 'Tech'", "UPPER(dept) = 'TECH'", 'UPPER both sides'],
        ["dept = 'Tech'", "dept IN ('Tech')", 'IN'],
        ["name LIKE 'A%'", "name LIKE 'A' || '%'", '連結したパターン'],
        ["name LIKE 'A%'", "name LIKE CONCAT('A', '%')", 'CONCAT したパターン'],
        ["name LIKE 'A%'", "SUBSTRING(name, 1, 1) = 'A'", 'SUBSTRING で先頭比較'],
        ["name LIKE 'A%'", "LEFT(name, 1) = 'A'", 'LEFT で先頭比較'],
        ["name LIKE '%1'", "RIGHT(name, 1) = '1'", 'RIGHT で末尾比較'],
        ["name NOT LIKE 'A%'", "NOT (name LIKE 'A%')", 'NOT LIKE'],
        ["dept ILIKE 'tech'", "UPPER(dept) = 'TECH'", 'ILIKE'],
      ].forEach(([base, alt, label], i) => sameWhere(`V52A #${i} ${label}`, base, alt));
      // 真偽値の列
      [
        ['active = TRUE', 'active', '列そのまま'],
        ['active = TRUE', 'active IS TRUE', 'IS TRUE'],
        ['active = TRUE', 'NOT (active = FALSE)', 'NOT = FALSE'],
        ['active = TRUE', 'active <> FALSE', '<> FALSE'],
        ['active = FALSE', 'NOT active', 'NOT 列'],
        ['active = FALSE', 'active IS FALSE', 'IS FALSE'],
      ].forEach(([base, alt, label], i) => sameWhere(`V52A bool #${i} ${label}`, base, alt));

      // ============================================================
      // B. 論理演算の言い換え（3 値論理でも成り立つ形だけを並べる）
      // ============================================================
      const PREDS = [
        'sal > 300', 'dept = \'Tech\'', 'mgr IS NULL', 'id % 2 = 0',
        'active = TRUE', 'sal IS NULL', 'name LIKE \'A%\'', 'id > 20',
      ];
      PREDS.forEach((p, i) => PREDS.forEach((r, j) => {
        if (i >= j) return;
        sameWhere(`V52B (${p}) AND (${r}) は交換できる`, `(${p}) AND (${r})`, `(${r}) AND (${p})`);
        sameWhere(`V52B (${p}) OR (${r}) は交換できる`, `(${p}) OR (${r})`, `(${r}) OR (${p})`);
        sameWhere(`V52B ド・モルガン NOT((${p}) AND (${r}))`,
                  `NOT ((${p}) AND (${r}))`, `NOT (${p}) OR NOT (${r})`);
        sameWhere(`V52B ド・モルガン NOT((${p}) OR (${r}))`,
                  `NOT ((${p}) OR (${r}))`, `NOT (${p}) AND NOT (${r})`);
        sameWhere(`V52B 二重否定 (${p}) AND (${r})`,
                  `(${p}) AND (${r})`, `NOT (NOT (${p}) OR NOT (${r}))`);
      }));
      PREDS.forEach((p, i) => {
        sameWhere(`V52B 二重否定 ${p}`, p, `NOT (NOT (${p}))`);
        sameWhere(`V52B TRUE との AND ${p}`, p, `(${p}) AND 1 = 1`);
        sameWhere(`V52B FALSE との OR ${p}`, p, `(${p}) OR 1 = 0`);
        sameWhere(`V52B CASE へ展開 ${p}`, p, `CASE WHEN ${p} THEN TRUE ELSE FALSE END`);
        sameWhere(`V52B 括弧の重ね掛け ${p}`, p, `((((${p}))))`);
        // 分配法則
        PREDS.forEach((r, j) => {
          if (j !== (i + 1) % PREDS.length) return;
          const u = PREDS[(i + 2) % PREDS.length];
          sameWhere(`V52B 分配法則 (${p}) AND ((${r}) OR (${u}))`,
                    `(${p}) AND ((${r}) OR (${u}))`, `((${p}) AND (${r})) OR ((${p}) AND (${u}))`);
          sameWhere(`V52B 分配法則 (${p}) OR ((${r}) AND (${u}))`,
                    `(${p}) OR ((${r}) AND (${u}))`, `((${p}) OR (${r})) AND ((${p}) OR (${u}))`);
        });
      });

      // ============================================================
      // C. 結合の言い換え
      // ============================================================
      const JOIN_BASE = "SELECT e.id, d.floor FROM v52_emp e INNER JOIN v52_dept d ON e.dept = d.dname ORDER BY e.id";
      [
        ['INNER を省く', "SELECT e.id, d.floor FROM v52_emp e JOIN v52_dept d ON e.dept = d.dname ORDER BY e.id"],
        ['カンマ結合', "SELECT e.id, d.floor FROM v52_emp e, v52_dept d WHERE e.dept = d.dname ORDER BY e.id"],
        ['CROSS JOIN + WHERE', "SELECT e.id, d.floor FROM v52_emp e CROSS JOIN v52_dept d WHERE e.dept = d.dname ORDER BY e.id"],
        ['ON の左右を入れ替える', "SELECT e.id, d.floor FROM v52_emp e INNER JOIN v52_dept d ON d.dname = e.dept ORDER BY e.id"],
        ['表の順を入れ替える', "SELECT e.id, d.floor FROM v52_dept d INNER JOIN v52_emp e ON e.dept = d.dname ORDER BY e.id"],
        ['RIGHT JOIN で書く', "SELECT e.id, d.floor FROM v52_dept d RIGHT JOIN v52_emp e ON e.dept = d.dname WHERE d.dname IS NOT NULL ORDER BY e.id"],
        ['ON を真にして WHERE で絞る', "SELECT e.id, d.floor FROM v52_emp e JOIN v52_dept d ON 1 = 1 WHERE e.dept = d.dname ORDER BY e.id"],
        ['スカラー副問い合わせ', "SELECT e.id, (SELECT d.floor FROM v52_dept d WHERE d.dname = e.dept) AS floor FROM v52_emp e WHERE e.dept IN (SELECT dname FROM v52_dept) ORDER BY e.id"],
        ['別名を付けない', "SELECT v52_emp.id, v52_dept.floor FROM v52_emp INNER JOIN v52_dept ON v52_emp.dept = v52_dept.dname ORDER BY v52_emp.id"],
        ['派生表と結合する', "SELECT e.id, d.floor FROM v52_emp e JOIN (SELECT * FROM v52_dept) d ON e.dept = d.dname ORDER BY e.id"],
        ['CTE と結合する', "WITH d AS (SELECT * FROM v52_dept) SELECT e.id, d.floor FROM v52_emp e JOIN d ON e.dept = d.dname ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V52C ${label}`, JOIN_BASE, variant));
      const LEFT_BASE = "SELECT e.id, d.floor FROM v52_emp e LEFT JOIN v52_dept d ON e.dept = d.dname ORDER BY e.id";
      [
        ['LEFT OUTER と書く', "SELECT e.id, d.floor FROM v52_emp e LEFT OUTER JOIN v52_dept d ON e.dept = d.dname ORDER BY e.id"],
        ['RIGHT JOIN で左右を入れ替える', "SELECT e.id, d.floor FROM v52_dept d RIGHT JOIN v52_emp e ON e.dept = d.dname ORDER BY e.id"],
        ['RIGHT OUTER で書く', "SELECT e.id, d.floor FROM v52_dept d RIGHT OUTER JOIN v52_emp e ON e.dept = d.dname ORDER BY e.id"],
        ['スカラー副問い合わせ', "SELECT e.id, (SELECT d.floor FROM v52_dept d WHERE d.dname = e.dept) AS floor FROM v52_emp e ORDER BY e.id"],
        ['UNION ALL で外部結合を組む',
         "SELECT e.id, d.floor FROM v52_emp e JOIN v52_dept d ON e.dept = d.dname "
         + "UNION ALL SELECT e.id, NULL FROM v52_emp e WHERE e.dept IS NULL OR e.dept NOT IN (SELECT dname FROM v52_dept) ORDER BY id"],
      ].forEach(([label, variant]) => same(`V52C LEFT: ${label}`, LEFT_BASE, variant));
      // 半結合（存在するか）の言い換え
      const SEMI = "SELECT id FROM v52_emp e WHERE EXISTS (SELECT 1 FROM v52_sale s WHERE s.eid = e.id) ORDER BY id";
      [
        ['IN 副問い合わせ', "SELECT id FROM v52_emp WHERE id IN (SELECT eid FROM v52_sale WHERE eid IS NOT NULL) ORDER BY id"],
        ['= ANY 副問い合わせ', "SELECT id FROM v52_emp WHERE id = ANY (SELECT eid FROM v52_sale WHERE eid IS NOT NULL) ORDER BY id"],
        ['JOIN + DISTINCT', "SELECT DISTINCT e.id FROM v52_emp e JOIN v52_sale s ON s.eid = e.id ORDER BY e.id"],
        ['相関 COUNT > 0', "SELECT id FROM v52_emp e WHERE (SELECT COUNT(*) FROM v52_sale s WHERE s.eid = e.id) > 0 ORDER BY id"],
        ['GROUP BY した派生表と結合', "SELECT e.id FROM v52_emp e JOIN (SELECT eid FROM v52_sale GROUP BY eid) s ON s.eid = e.id ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V52C 半結合: ${label}`, SEMI, variant));
      // 反結合
      const ANTI = "SELECT id FROM v52_emp e WHERE NOT EXISTS (SELECT 1 FROM v52_sale s WHERE s.eid = e.id) ORDER BY id";
      [
        ['NOT IN（NULL を除いた副問い合わせ）', "SELECT id FROM v52_emp WHERE id NOT IN (SELECT eid FROM v52_sale WHERE eid IS NOT NULL) ORDER BY id"],
        ['LEFT JOIN + IS NULL', "SELECT e.id FROM v52_emp e LEFT JOIN v52_sale s ON s.eid = e.id WHERE s.sid IS NULL ORDER BY e.id"],
        ['相関 COUNT = 0', "SELECT id FROM v52_emp e WHERE (SELECT COUNT(*) FROM v52_sale s WHERE s.eid = e.id) = 0 ORDER BY id"],
        ['EXCEPT', "SELECT id FROM v52_emp EXCEPT SELECT eid FROM v52_sale WHERE eid IS NOT NULL ORDER BY id"],
      ].forEach(([label, variant]) => same(`V52C 反結合: ${label}`, ANTI, variant));

      // ============================================================
      // D. 集約の言い換え
      // ============================================================
      const CNT = "SELECT COUNT(*) AS c FROM v52_emp";
      [
        ['COUNT(1)', "SELECT COUNT(1) AS c FROM v52_emp"],
        ['COUNT(id)（PK は NULL 無し）', "SELECT COUNT(id) AS c FROM v52_emp"],
        ['SUM(1)', "SELECT SUM(1) AS c FROM v52_emp"],
        ['スカラー副問い合わせ', "SELECT (SELECT COUNT(*) FROM v52_emp) AS c"],
        ['派生表で数える', "SELECT COUNT(*) AS c FROM (SELECT id FROM v52_emp) t"],
        ['CTE で数える', "WITH t AS (SELECT id FROM v52_emp) SELECT COUNT(*) AS c FROM t"],
      ].forEach(([label, variant]) => same(`V52D 全件数: ${label}`, CNT, variant));
      const GRP = "SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept ORDER BY dept";
      [
        ['序数でまとめる', "SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY 1 ORDER BY 1"],
        ['別名でまとめる', "SELECT dept AS d, COUNT(*) AS c FROM v52_emp GROUP BY d ORDER BY d"],
        ['修飾名でまとめる', "SELECT v52_emp.dept, COUNT(*) AS c FROM v52_emp GROUP BY v52_emp.dept ORDER BY v52_emp.dept"],
        ['別名を付けた表でまとめる', "SELECT e.dept, COUNT(*) AS c FROM v52_emp e GROUP BY e.dept ORDER BY e.dept"],
        ['派生表を経由する', "SELECT dept, COUNT(*) AS c FROM (SELECT dept FROM v52_emp) t GROUP BY dept ORDER BY dept"],
        ['DISTINCT + 相関副問い合わせ',
         "SELECT DISTINCT dept, (SELECT COUNT(*) FROM v52_emp x WHERE x.dept IS NOT DISTINCT FROM e.dept) AS c FROM v52_emp e ORDER BY dept"],
        ['ウィンドウ関数 + DISTINCT',
         "SELECT DISTINCT dept, COUNT(*) OVER (PARTITION BY dept) AS c FROM v52_emp ORDER BY dept"],
      ].forEach(([label, variant]) => same(`V52D まとめ方: ${label}`, GRP, variant));
      const HAV = "SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept HAVING COUNT(*) >= 8 ORDER BY dept";
      [
        ['別名を HAVING で使う', "SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept HAVING c >= 8 ORDER BY dept"],
        ['派生表 + WHERE', "SELECT * FROM (SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept) t WHERE c >= 8 ORDER BY dept"],
        ['CTE + WHERE', "WITH t AS (SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept) SELECT * FROM t WHERE c >= 8 ORDER BY dept"],
        ['QUALIFY 相当をウィンドウで',
         "SELECT DISTINCT dept, COUNT(*) OVER (PARTITION BY dept) AS c FROM v52_emp QUALIFY COUNT(*) OVER (PARTITION BY dept) >= 8 ORDER BY dept"],
      ].forEach(([label, variant]) => same(`V52D HAVING: ${label}`, HAV, variant));
      // 集約関数そのものの言い換え
      [
        ['AVG は SUM / COUNT', "SELECT ROUND(AVG(sal), 6) AS a FROM v52_emp",
         "SELECT ROUND(SUM(sal) * 1.0 / COUNT(sal), 6) AS a FROM v52_emp"],
        ['MAX は ORDER BY DESC LIMIT 1', "SELECT MAX(sal) AS m FROM v52_emp",
         "SELECT sal AS m FROM v52_emp WHERE sal IS NOT NULL ORDER BY sal DESC LIMIT 1"],
        ['MIN は ORDER BY ASC LIMIT 1', "SELECT MIN(sal) AS m FROM v52_emp",
         "SELECT sal AS m FROM v52_emp WHERE sal IS NOT NULL ORDER BY sal ASC LIMIT 1"],
        ['COUNT(col) は FILTER 付き COUNT(*)', "SELECT COUNT(sal) AS c FROM v52_emp",
         "SELECT COUNT(*) FILTER (WHERE sal IS NOT NULL) AS c FROM v52_emp"],
        ['COUNT(col) は SUM(CASE ...)', "SELECT COUNT(sal) AS c FROM v52_emp",
         "SELECT SUM(CASE WHEN sal IS NOT NULL THEN 1 ELSE 0 END) AS c FROM v52_emp"],
        ['COUNT(DISTINCT) は派生表', "SELECT COUNT(DISTINCT dept) AS c FROM v52_emp",
         "SELECT COUNT(*) AS c FROM (SELECT DISTINCT dept FROM v52_emp WHERE dept IS NOT NULL) t"],
        ['条件付き集計は FILTER でも CASE でも同じ',
         "SELECT SUM(sal) FILTER (WHERE dept = 'Tech') AS s FROM v52_emp",
         "SELECT SUM(CASE WHEN dept = 'Tech' THEN sal END) AS s FROM v52_emp"],
        ['SUM は GROUP BY 無しでも派生表と一致',
         "SELECT SUM(amt) AS s FROM v52_sale",
         "SELECT SUM(s) AS s FROM (SELECT region, SUM(amt) AS s FROM v52_sale GROUP BY region) t"],
      ].forEach(([label, base, variant]) => same(`V52D 集約: ${label}`, base, variant));

      // ============================================================
      // E. 副問い合わせ・CTE・派生表
      // ============================================================
      const SUB = "SELECT id, sal FROM v52_emp WHERE sal > (SELECT AVG(sal) FROM v52_emp) ORDER BY id";
      [
        ['CTE で平均を出す', "WITH a AS (SELECT AVG(sal) AS m FROM v52_emp) SELECT id, sal FROM v52_emp, a WHERE sal > a.m ORDER BY id"],
        ['派生表と結合する', "SELECT e.id, e.sal FROM v52_emp e JOIN (SELECT AVG(sal) AS m FROM v52_emp) a ON e.sal > a.m ORDER BY e.id"],
        ['CROSS JOIN で持ち込む', "SELECT e.id, e.sal FROM v52_emp e CROSS JOIN (SELECT AVG(sal) AS m FROM v52_emp) a WHERE e.sal > a.m ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V52E 平均超え: ${label}`, SUB, variant));
      const CTE2 = "WITH a AS (SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept), "
        + "b AS (SELECT * FROM a WHERE c >= 8) SELECT dept, c FROM b ORDER BY dept";
      [
        ['入れ子の派生表', "SELECT dept, c FROM (SELECT * FROM (SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept) a WHERE c >= 8) b ORDER BY dept"],
        ['1 段の派生表', "SELECT dept, c FROM (SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept) a WHERE c >= 8 ORDER BY dept"],
        ['HAVING でまとめる', "SELECT dept, COUNT(*) AS c FROM v52_emp GROUP BY dept HAVING COUNT(*) >= 8 ORDER BY dept"],
        ['CTE の列名を宣言する', "WITH a(d, c) AS (SELECT dept, COUNT(*) FROM v52_emp GROUP BY dept) SELECT d, c FROM a WHERE c >= 8 ORDER BY d"],
      ].forEach(([label, variant]) => same(`V52E CTE: ${label}`, CTE2, variant));
      // 相関副問い合わせとウィンドウ関数
      const CORR = "SELECT e.id, (SELECT COUNT(*) FROM v52_sale s WHERE s.eid = e.id) AS n FROM v52_emp e ORDER BY e.id";
      [
        ['LEFT JOIN + COUNT', "SELECT e.id, COUNT(s.sid) AS n FROM v52_emp e LEFT JOIN v52_sale s ON s.eid = e.id GROUP BY e.id ORDER BY e.id"],
        ['集計済みの派生表と結合', "SELECT e.id, COALESCE(a.n, 0) AS n FROM v52_emp e LEFT JOIN (SELECT eid, COUNT(*) AS n FROM v52_sale GROUP BY eid) a ON a.eid = e.id ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V52E 相関: ${label}`, CORR, variant));

      // ============================================================
      // F. 並べ替えとページング
      // ============================================================
      const ORD = "SELECT id, dept, sal FROM v52_emp ORDER BY dept ASC, sal DESC, id ASC";
      [
        ['ASC を省く', "SELECT id, dept, sal FROM v52_emp ORDER BY dept, sal DESC, id"],
        ['序数で並べる', "SELECT id, dept, sal FROM v52_emp ORDER BY 2 ASC, 3 DESC, 1 ASC"],
        ['別名で並べる', "SELECT id AS i, dept AS d, sal AS s FROM v52_emp ORDER BY d ASC, s DESC, i ASC"],
        ['序数と名前を混ぜる', "SELECT id, dept, sal FROM v52_emp ORDER BY dept, 3 DESC, id"],
        ['修飾名で並べる', "SELECT e.id, e.dept, e.sal FROM v52_emp e ORDER BY e.dept ASC, e.sal DESC, e.id ASC"],
        ['派生表の外側で並べる', "SELECT id, dept, sal FROM (SELECT id, dept, sal FROM v52_emp) t ORDER BY dept ASC, sal DESC, id ASC"],
      ].forEach(([label, variant]) => same(`V52F 並べ替え: ${label}`, ORD, variant));
      const PAGE = "SELECT id FROM v52_emp ORDER BY id LIMIT 5 OFFSET 10";
      [
        ['LIMIT offset, count', "SELECT id FROM v52_emp ORDER BY id LIMIT 10, 5"],
        ['OFFSET ... FETCH FIRST', "SELECT id FROM v52_emp ORDER BY id OFFSET 10 ROWS FETCH FIRST 5 ROWS ONLY"],
        ['OFFSET ... FETCH NEXT', "SELECT id FROM v52_emp ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY"],
        ['ROW_NUMBER で切り出す', "SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v52_emp) t WHERE rn BETWEEN 11 AND 15 ORDER BY id"],
        ['OFFSET を先に書く', "SELECT id FROM v52_emp ORDER BY id OFFSET 10 LIMIT 5"],
      ].forEach(([label, variant]) => same(`V52F ページング: ${label}`, PAGE, variant));
      // NULL の並び
      [
        ['NULLS LAST は式で書ける', "SELECT id, sal FROM v52_emp ORDER BY sal ASC NULLS LAST, id",
         "SELECT id, sal FROM v52_emp ORDER BY CASE WHEN sal IS NULL THEN 1 ELSE 0 END, sal ASC, id"],
        ['NULLS FIRST は式で書ける', "SELECT id, sal FROM v52_emp ORDER BY sal ASC NULLS FIRST, id",
         "SELECT id, sal FROM v52_emp ORDER BY CASE WHEN sal IS NULL THEN 0 ELSE 1 END, sal ASC, id"],
      ].forEach(([label, base, variant]) => same(`V52F ${label}`, base, variant));

      // ============================================================
      // G. 式と関数の同義形
      // ============================================================
      const EXPR = [
        // CONCAT は NULL を空文字として連結する（PostgreSQL 流）。|| は NULL を伝播するので、
        // 両者を突き合わせるときは NULL を先に潰しておく（差そのものは下の H 節で記録する）
        ['連結', "name || '-' || COALESCE(dept, '')", "CONCAT(name, '-', COALESCE(dept, ''))"],
        ['連結（入れ子）', "name || '-' || COALESCE(dept, '')", "CONCAT(CONCAT(name, '-'), COALESCE(dept, ''))"],
        ['部分文字列', "SUBSTRING(name, 1, 3)", "SUBSTR(name, 1, 3)"],
        ['部分文字列（MID）', "SUBSTRING(name, 1, 3)", "MID(name, 1, 3)"],
        ['部分文字列（FROM FOR）', "SUBSTRING(name, 1, 3)", "SUBSTRING(name FROM 1 FOR 3)"],
        ['先頭 3 文字', "SUBSTRING(name, 1, 3)", "LEFT(name, 3)"],
        ['大文字', "UPPER(name)", "UCASE(name)"],
        ['小文字', "LOWER(name)", "LCASE(name)"],
        ['NULL 置換（IFNULL）', "COALESCE(sal, 0)", "IFNULL(sal, 0)"],
        ['NULL 置換（NVL）', "COALESCE(sal, 0)", "NVL(sal, 0)"],
        ['NULL 置換（ISNULL）', "COALESCE(sal, 0)", "ISNULL(sal, 0)"],
        ['NULL 置換（CASE）', "COALESCE(sal, 0)", "CASE WHEN sal IS NULL THEN 0 ELSE sal END"],
        ['NULL 置換（IF）', "COALESCE(sal, 0)", "IF(sal IS NULL, 0, sal)"],
        ['三項の分岐（IIF）', "CASE WHEN sal > 300 THEN 1 ELSE 0 END", "IIF(sal > 300, 1, 0)"],
        ['三項の分岐（IF）', "CASE WHEN sal > 300 THEN 1 ELSE 0 END", "IF(sal > 300, 1, 0)"],
        ['年', "YEAR(hired)", "EXTRACT(YEAR FROM hired)"],
        ['年（DATE_PART）', "YEAR(hired)", "DATE_PART('year', hired)"],
        ['年（DATEPART）', "YEAR(hired)", "DATEPART(YEAR, hired)"],
        ['月', "MONTH(hired)", "EXTRACT(MONTH FROM hired)"],
        ['型変換', "CAST(sal AS TEXT)", "CONVERT(sal, CHAR)"],
        ['型変換（::）', "CAST(sal AS TEXT)", "sal::TEXT"],
        ['型変換（入れ子）', "CAST(sal AS TEXT)", "CAST(CAST(sal AS TEXT) AS TEXT)"],
        ['剰余', "sal % 7", "MOD(sal, 7)"],
        ['絶対値', "ABS(sal - 300)", "CASE WHEN sal - 300 < 0 THEN -(sal - 300) ELSE sal - 300 END"],
        ['符号反転', "-sal", "sal * -1"],
        ['丸め', "ROUND(sal / 7.0, 2)", "ROUND(sal / 7.0, 2)"],
        ['べき乗', "POWER(id, 2)", "id * id"],
        // GREATEST / LEAST は引数に NULL があれば NULL（MySQL 流）。CASE との対応を見るため
        // NULL を潰してから比べる
        ['最大値（2 引数）', "GREATEST(COALESCE(sal, 0), 300)", "CASE WHEN COALESCE(sal, 0) > 300 THEN COALESCE(sal, 0) ELSE 300 END"],
        ['最小値（2 引数）', "LEAST(COALESCE(sal, 0), 300)", "CASE WHEN COALESCE(sal, 0) < 300 THEN COALESCE(sal, 0) ELSE 300 END"],
        ['NULLIF', "NULLIF(dept, 'Tech')", "CASE WHEN dept = 'Tech' THEN NULL ELSE dept END"],
        ['文字数', "LENGTH(name)", "CHAR_LENGTH(name)"],
        ['位置', "POSITION('n' IN name)", "INSTR(name, 'n')"],
        ['位置（LOCATE）', "POSITION('n' IN name)", "LOCATE('n', name)"],
        ['繰り返し', "REPEAT('ab', 3)", "'ab' || 'ab' || 'ab'"],
        ['空白除去', "TRIM('  ' || name || '  ')", "LTRIM(RTRIM('  ' || name || '  '))"],
      ];
      EXPR.forEach(([label, a, b], i) => same(`V52G #${i} ${label}`,
        `SELECT id, ${a} AS v FROM v52_emp ORDER BY id`,
        `SELECT id, ${b} AS v FROM v52_emp ORDER BY id`));

      // ============================================================
      // H. 集合演算
      // ============================================================
      const U = "SELECT id FROM v52_emp WHERE sal > 400 UNION SELECT id FROM v52_emp WHERE dept = 'HR' ORDER BY id";
      [
        ['UNION ALL + DISTINCT', "SELECT DISTINCT id FROM (SELECT id FROM v52_emp WHERE sal > 400 UNION ALL SELECT id FROM v52_emp WHERE dept = 'HR') t ORDER BY id"],
        ['OR でまとめる', "SELECT id FROM v52_emp WHERE sal > 400 OR dept = 'HR' ORDER BY id"],
        ['左右を入れ替える', "SELECT id FROM v52_emp WHERE dept = 'HR' UNION SELECT id FROM v52_emp WHERE sal > 400 ORDER BY id"],
      ].forEach(([label, variant]) => same(`V52H UNION: ${label}`, U, variant));
      const I = "SELECT id FROM v52_emp WHERE sal > 300 INTERSECT SELECT id FROM v52_emp WHERE dept = 'Tech' ORDER BY id";
      [
        ['AND でまとめる', "SELECT id FROM v52_emp WHERE sal > 300 AND dept = 'Tech' ORDER BY id"],
        ['IN 副問い合わせ', "SELECT id FROM v52_emp WHERE sal > 300 AND id IN (SELECT id FROM v52_emp WHERE dept = 'Tech') ORDER BY id"],
        ['EXISTS', "SELECT id FROM v52_emp e WHERE sal > 300 AND EXISTS (SELECT 1 FROM v52_emp x WHERE x.id = e.id AND x.dept = 'Tech') ORDER BY id"],
      ].forEach(([label, variant]) => same(`V52H INTERSECT: ${label}`, I, variant));
      const E = "SELECT id FROM v52_emp WHERE sal > 300 EXCEPT SELECT id FROM v52_emp WHERE dept = 'Tech' ORDER BY id";
      [
        ['AND NOT でまとめる', "SELECT id FROM v52_emp WHERE sal > 300 AND (dept <> 'Tech' OR dept IS NULL) ORDER BY id"],
        ['NOT IN 副問い合わせ', "SELECT id FROM v52_emp WHERE sal > 300 AND id NOT IN (SELECT id FROM v52_emp WHERE dept = 'Tech') ORDER BY id"],
        ['NOT EXISTS', "SELECT id FROM v52_emp e WHERE sal > 300 AND NOT EXISTS (SELECT 1 FROM v52_emp x WHERE x.id = e.id AND x.dept = 'Tech') ORDER BY id"],
      ].forEach(([label, variant]) => same(`V52H EXCEPT: ${label}`, E, variant));

      // ------------------------------------------------------------
      // 「同じに見えて同じではない」書き方（言い換えられない組み合わせ）
      // ------------------------------------------------------------
      same('V52H CONCAT は NULL を空文字として連結する', "SELECT CONCAT('a', NULL, 'b') AS v", "SELECT 'ab' AS v");
      differs('V52H || は NULL を伝播するので CONCAT とは違う',
              "SELECT CONCAT('a', NULL, 'b') AS v", "SELECT 'a' || NULL || 'b' AS v");
      same('V52H GREATEST は NULL があれば NULL', "SELECT GREATEST(1, NULL) AS v", "SELECT NULL AS v");
      same('V52H LEAST は NULL があれば NULL', "SELECT LEAST(1, NULL) AS v", "SELECT NULL AS v");
      differs('V52H NOT IN は NULL を含むリストで真にならない',
              "SELECT 1 WHERE 5 NOT IN (1, NULL)", "SELECT 1 WHERE 5 NOT IN (1, 2)");
      differs('V52H COUNT(*) と COUNT(col) は NULL の扱いが違う',
              "SELECT COUNT(*) AS c FROM v52_emp", "SELECT COUNT(sal) AS c FROM v52_emp");
      differs('V52H UNION と UNION ALL は重複の扱いが違う',
              "SELECT dept FROM v52_emp UNION SELECT dept FROM v52_emp",
              "SELECT dept FROM v52_emp UNION ALL SELECT dept FROM v52_emp");

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v52_emp', 'v52_dept', 'v52_sale');

      return T;
    }
