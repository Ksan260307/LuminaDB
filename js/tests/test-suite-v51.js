    // ============================================================================
    // [Test Suite v51] - 書き味 (1/5): 字句とレイアウト
    //
    //   同じ意味のクエリを「書き方」だけ変えて投げ、結果が 1 文字も変わらないことを
    //   確かめる。実装済みのクエリ 60 本を土台に、機械的な変換で総当たりする。
    //
    //     A. 大文字小文字（キーワードも識別子も区別しない）
    //     B. 空白・改行・タブ・CRLF・前後の余白・末尾のセミコロン
    //     C. コメント（行コメント / ブロックコメント / 併用）
    //     D. 空白 1 個ずつを改行へ差し替える総当たり
    //     E. 空白 1 個ずつをブロックコメントへ差し替える総当たり
    //     F. 空白 1 個ずつを「行コメント＋改行」へ差し替える総当たり
    //     G. 識別子・別名・修飾の書き分け
    //     H. 受け付けない書き方（MySQL 系の方言に寄せた仕様）
    //
    //   D〜F は v1.31 で見つけた「整形した SQL が黙って誤答する」欠陥
    //   （複数行の CASE / OVER 句 / 複数行の select 項目 / FILTER ( WHERE ...)）の
    //   回帰でもある。基準は 1 行で書いた形の実行結果そのもの。
    //
    //   test-suite.js の tests 配列へ getV51Tests() のスプレッドで合流する
    // ============================================================================
    function getV51Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, same, outside, upper, lower, alternating, spaced, insertRows, drop,
              wsPos, swap, tag, cleanup } = makeTestKit("V51");

      // ------------------------------------------------------------
      // 0. フィクスチャ（読み取り専用。全テストで共有する）
      // ------------------------------------------------------------
      t('V51 fixture', () => {
        drop('v51_emp', 'v51_dept', 'v51_sale');
        q("CREATE TABLE v51_dept (dname TEXT PRIMARY KEY, floor INT, head INT)");
        q("CREATE TABLE v51_emp (id INT PRIMARY KEY, name TEXT, dept TEXT, sal INT, mgr INT, hired DATE, active BOOLEAN)");
        q("CREATE TABLE v51_sale (sid INT PRIMARY KEY, eid INT, amt DECIMAL(18,4), sold DATE, region TEXT)");
        insertRows('v51_dept',
          [['Sales', 1, 1], ['Tech', 2, 3], ['HR', 3, 5], ['Ops', 2, 7], ['Legal', 4, null]]);
        const names = ['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay', 'Gil', 'Hal', 'Ivy', 'Joe'];
        const dn = ['Sales', 'Tech', 'HR', 'Ops', 'Legal'];
        const emp = [];
        for (let i = 1; i <= 30; i++) {
          emp.push([
            i,
            names[i % 10] + i,
            (i % 11 === 0) ? null : dn[i % 5],
            (i % 7 === 0) ? null : 180 + ((i * 37) % 12) * 25,
            (i % 5 === 0) ? null : ((i * 3) % 30) + 1,
            `20${18 + (i % 6)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
            i % 3 !== 0
          ]);
        }
        insertRows('v51_emp', emp);
        const regions = ['east', 'west', 'north', 'south'];
        const sale = [];
        for (let i = 1; i <= 60; i++) {
          sale.push([
            i,
            (i % 9 === 0) ? null : ((i * 7) % 30) + 1,
            (i % 13 === 0) ? null : ((i * 17) % 200) + 10.5,
            `202${(i % 4) + 1}-0${(i % 9) + 1}-1${i % 10}`,
            regions[i % 4]
          ]);
        }
        insertRows('v51_sale', sale);
        return db.tables['v51_emp'].rowCount === 30 && db.tables['v51_sale'].rowCount === 60
          && db.tables['v51_dept'].rowCount === 5;
      });

      // ------------------------------------------------------------
      // 土台になるクエリ（すべて 1 行・結果は決定的）
      // ------------------------------------------------------------
      const CORPUS = [
        "SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
        "SELECT * FROM v51_emp ORDER BY id LIMIT 5",
        "SELECT DISTINCT dept FROM v51_emp ORDER BY dept",
        "SELECT dept, COUNT(*) AS c, SUM(sal) AS s, ROUND(AVG(sal), 2) AS a FROM v51_emp GROUP BY dept ORDER BY dept",
        "SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept HAVING COUNT(*) >= 2 ORDER BY dept",
        "SELECT e.id, e.name, d.floor FROM v51_emp e JOIN v51_dept d ON e.dept = d.dname ORDER BY e.id",
        "SELECT e.id, d.floor FROM v51_emp e LEFT JOIN v51_dept d ON e.dept = d.dname ORDER BY e.id",
        "SELECT e.name, s.amt FROM v51_emp e INNER JOIN v51_sale s ON s.eid = e.id WHERE s.amt > 100 ORDER BY s.sid LIMIT 10",
        "SELECT id, CASE WHEN sal >= 400 THEN 'A' WHEN sal >= 300 THEN 'B' ELSE 'C' END AS band FROM v51_emp ORDER BY id",
        "SELECT id, CASE dept WHEN 'Sales' THEN 1 WHEN 'Tech' THEN 2 ELSE 0 END AS d FROM v51_emp ORDER BY id",
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY sal DESC, id) AS rn FROM v51_emp ORDER BY id",
        "SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS w FROM v51_emp ORDER BY id",
        "SELECT id, LAG(sal, 1, 0) OVER (ORDER BY id) AS p, LEAD(sal) OVER (ORDER BY id) AS n FROM v51_emp ORDER BY id",
        "WITH big AS (SELECT * FROM v51_emp WHERE sal > 300) SELECT id, name FROM big ORDER BY id",
        "WITH a AS (SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept), b AS (SELECT * FROM a WHERE c > 1) SELECT * FROM b ORDER BY dept",
        "SELECT id FROM v51_emp WHERE sal > 400 UNION SELECT id FROM v51_emp WHERE sal < 220 ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal > 400 UNION ALL SELECT id FROM v51_emp WHERE dept = 'Tech' ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal > 300 INTERSECT SELECT id FROM v51_emp WHERE dept = 'Tech' ORDER BY id",
        "SELECT id FROM v51_emp EXCEPT SELECT id FROM v51_emp WHERE sal IS NULL ORDER BY id",
        "SELECT id, name FROM v51_emp WHERE dept IN (SELECT dname FROM v51_dept WHERE floor <= 2) ORDER BY id",
        "SELECT id FROM v51_emp e WHERE EXISTS (SELECT 1 FROM v51_sale s WHERE s.eid = e.id AND s.amt > 150) ORDER BY id",
        "SELECT id FROM v51_emp e WHERE NOT EXISTS (SELECT 1 FROM v51_sale s WHERE s.eid = e.id AND s.amt > 180) ORDER BY id",
        "SELECT id, (SELECT COUNT(*) FROM v51_sale s WHERE s.eid = e.id) AS n FROM v51_emp e ORDER BY id",
        "SELECT COUNT(*) AS all_n, COUNT(*) FILTER (WHERE sal > 300) AS big_n FROM v51_emp",
        "SELECT dept, GROUP_CONCAT(name ORDER BY id SEPARATOR '|') AS g FROM v51_emp GROUP BY dept ORDER BY dept",
        "SELECT id, UPPER(name) AS u, SUBSTRING(name, 1, 3) AS s, LENGTH(name) AS l FROM v51_emp ORDER BY id",
        "SELECT id, TRIM(name) AS t, REPLACE(name, 'a', 'X') AS r, CONCAT(name, '@', dept) AS c FROM v51_emp ORDER BY id",
        "SELECT id, YEAR(hired) AS y, MONTH(hired) AS m, EXTRACT(DAY FROM hired) AS d FROM v51_emp ORDER BY id",
        "SELECT id, DATEDIFF(hired, '2020-01-01') AS dd FROM v51_emp ORDER BY id",
        "SELECT id, CAST(sal AS TEXT) AS t, COALESCE(sal, 0) AS c, NULLIF(dept, 'HR') AS n FROM v51_emp ORDER BY id",
        "SELECT id, sal * 2 + 1 AS x, (sal - 100) / 2 AS y, sal % 7 AS z FROM v51_emp ORDER BY id",
        "SELECT id FROM v51_emp WHERE name LIKE 'A%' OR name NOT LIKE '%1' ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal BETWEEN 250 AND 400 AND dept IN ('Sales', 'Tech') ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal IS NULL OR mgr IS NOT NULL ORDER BY id",
        "SELECT id, dept, sal FROM v51_emp ORDER BY dept ASC, sal DESC, id ASC",
        "SELECT id FROM v51_emp ORDER BY id LIMIT 7 OFFSET 3",
        "SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS v",
        "SELECT a.id, b.id AS bid FROM v51_emp a JOIN v51_emp b ON a.mgr = b.id ORDER BY a.id",
        "SELECT e.id, d.floor, s.amt FROM v51_emp e JOIN v51_dept d ON e.dept = d.dname JOIN v51_sale s ON s.eid = e.id ORDER BY e.id, s.sid LIMIT 15",
        "SELECT id FROM v51_emp e WHERE sal > (SELECT AVG(sal) FROM v51_emp) ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal > ANY (SELECT sal FROM v51_emp WHERE dept = 'HR') ORDER BY id",
        "SELECT id FROM v51_emp WHERE sal >= ALL (SELECT sal FROM v51_emp WHERE dept = 'HR' AND sal IS NOT NULL) ORDER BY id",
        "SELECT id, sal FROM v51_emp ORDER BY sal DESC NULLS LAST, id",
        "SELECT dept, SUM(sal) AS s FROM v51_emp GROUP BY dept ORDER BY s DESC, dept",
        "SELECT region, COUNT(*) AS c, MIN(amt) AS lo, MAX(amt) AS hi FROM v51_sale GROUP BY region ORDER BY region",
        "SELECT id, nt FROM (SELECT id, NTILE(4) OVER (ORDER BY id) AS nt FROM v51_emp) t ORDER BY id",
        "SELECT id, RANK() OVER (ORDER BY sal DESC) AS r, DENSE_RANK() OVER (ORDER BY sal DESC) AS dr FROM v51_emp ORDER BY id",
        "SELECT id, sal FROM v51_emp QUALIFY ROW_NUMBER() OVER (PARTITION BY dept ORDER BY id) <= 2 ORDER BY id",
        "SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY ROLLUP(dept) ORDER BY dept",
        "SELECT id, JSON_OBJECT('id', id, 'nm', name) AS j FROM v51_emp ORDER BY id LIMIT 5",
        "SELECT COUNT(DISTINCT dept) AS c FROM v51_emp",
        "SELECT id, name FROM v51_emp WHERE id % 3 = 0 AND active = FALSE ORDER BY id",
        "SELECT dept, AVG(sal) AS a FROM v51_emp WHERE sal IS NOT NULL GROUP BY dept HAVING AVG(sal) > 250 ORDER BY dept",
        "SELECT s.region, e.dept, SUM(s.amt) AS total FROM v51_sale s JOIN v51_emp e ON e.id = s.eid GROUP BY s.region, e.dept ORDER BY s.region, e.dept",
        "SELECT id FROM v51_emp WHERE (sal > 300 AND dept = 'Tech') OR (sal < 250 AND dept = 'HR') ORDER BY id",
        "SELECT MIN(hired) AS first_hire, MAX(hired) AS last_hire FROM v51_emp",
        "SELECT id, COALESCE(CAST(mgr AS TEXT), 'none') AS m FROM v51_emp ORDER BY id",
        "SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept ORDER BY c DESC, dept ASC LIMIT 3",
        "SELECT id, name FROM v51_emp WHERE dept IS NULL ORDER BY id",
        "SELECT COUNT(*) AS n FROM v51_emp e JOIN v51_sale s ON s.eid = e.id WHERE s.region = 'east'",
      ];

      // ============================================================
      // A. 大文字小文字
      //   キーワードも識別子も大小を区別しない。文字列リテラルの中身だけは保つ
      // ============================================================
      const CASES = [
        ['upper', upper],
        ['lower', lower],
        ['alternating', alternating],
        ['lower + newlines', s => lower(spaced(s, '\n'))],
        ['upper + tabs', s => upper(spaced(s, '\t'))],
      ];
      CORPUS.forEach((base, qi) => CASES.forEach(([label, f]) => {
        same(`V51A q${qi} ${label}: ${tag(base)}`, base, f(base));
      }));

      // ============================================================
      // B. 空白・改行・セミコロン
      // ============================================================
      const LAYOUTS = [
        ['every space -> newline', s => spaced(s, '\n')],
        ['every space -> tab', s => spaced(s, '\t')],
        ['every space -> 3 spaces', s => spaced(s, '   ')],
        ['every space -> CRLF', s => spaced(s, '\r\n')],
        ['leading / trailing blank lines', s => '\n\n   ' + s + '   \n'],
        ['trailing semicolon', s => s + ';'],
        ['semicolon with spaces around', s => '  ' + s + '  ;  '],
      ];
      CORPUS.forEach((base, qi) => LAYOUTS.forEach(([label, f]) => {
        same(`V51B q${qi} ${label}: ${tag(base)}`, base, f(base));
      }));

      // ============================================================
      // C. コメント
      // ============================================================
      const COMMENTS = [
        ['header line comment', s => '-- 見出し\n' + s],
        ['trailing line comment', s => s + ' -- 末尾のメモ'],
        ['header block comment', s => '/* 複数行の\n   説明 */\n' + s],
        ['trailing block comment', s => s + ' /* 末尾 */'],
        ['comments + newlines', s => '-- 見出し\n' + spaced(s, '\n') + '\n-- 終わり'],
      ];
      CORPUS.forEach((base, qi) => COMMENTS.forEach(([label, f]) => {
        same(`V51C q${qi} ${label}: ${tag(base)}`, base, f(base));
      }));

      // ============================================================
      // D〜F. 空白 1 個ずつを置き換える総当たり
      //   「どこで改行しても・どこにコメントを挟んでも同じ結果」を位置ごとに確かめる。
      //   v1.31 の欠陥（複数行の select 項目 / CASE / OVER 句）はすべてこの形で出た
      // ============================================================
      const POS_MODES = [
        ['D', 'newline', '\n'],
        ['E', 'block comment', ' /*c*/ '],
        ['F', 'line comment', ' -- note\n'],
      ];
      CORPUS.forEach((base, qi) => {
        const positions = wsPos(base);
        POS_MODES.forEach(([sec, label, text]) => {
          positions.forEach(i => {
            same(`V51${sec} q${qi} ${label} @${i}: ${tag(base)}`, base, swap(base, i, text));
          });
        });
      });

      // ============================================================
      // G. 識別子・別名・修飾の書き分け
      // ============================================================
      const IDENT = [
        // 表・列をバッククォートで囲む
        ["SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT `id`, `name` FROM `v51_emp` WHERE `sal` > 300 ORDER BY `id`"],
        ["SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT v51_emp.id, v51_emp.name FROM v51_emp WHERE v51_emp.sal > 300 ORDER BY v51_emp.id"],
        ["SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT e.id, e.name FROM v51_emp AS e WHERE e.sal > 300 ORDER BY e.id"],
        ["SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT e.id, e.name FROM v51_emp e WHERE e.sal > 300 ORDER BY e.id"],
        ["SELECT id, name FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT `e`.`id`, `e`.`name` FROM `v51_emp` `e` WHERE `e`.`sal` > 300 ORDER BY `e`.`id`"],
        // 別名の付け方
        ["SELECT id AS a, name AS b FROM v51_emp ORDER BY id",
         "SELECT id a, name b FROM v51_emp ORDER BY id"],
        ["SELECT id AS a, name AS b FROM v51_emp ORDER BY id",
         "SELECT id AS `a`, name AS `b` FROM v51_emp ORDER BY id"],
        ["SELECT id AS a, name AS b FROM v51_emp ORDER BY id",
         "SELECT id as a, name as b FROM v51_emp ORDER BY id"],
        ["SELECT id AS a, name AS b FROM v51_emp ORDER BY id",
         "SELECT id AS 'a', name AS 'b' FROM v51_emp ORDER BY id"],
        // 別名で並べ替える / 序数で並べ替える
        ["SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept ORDER BY dept",
         "SELECT dept AS d, COUNT(*) AS c FROM v51_emp GROUP BY d ORDER BY d"],
        ["SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept ORDER BY dept",
         "SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY 1 ORDER BY 1"],
        ["SELECT dept, COUNT(*) AS c FROM v51_emp GROUP BY dept ORDER BY dept",
         "SELECT dept, COUNT(*) FROM v51_emp GROUP BY dept ORDER BY dept ASC"],
        // 派生表・CTE の別名
        ["SELECT x.id FROM (SELECT id FROM v51_emp WHERE sal > 300) AS x ORDER BY x.id",
         "SELECT x.id FROM (SELECT id FROM v51_emp WHERE sal > 300) x ORDER BY x.id"],
        ["SELECT x.id FROM (SELECT id FROM v51_emp WHERE sal > 300) AS x ORDER BY x.id",
         "SELECT id FROM (SELECT id FROM v51_emp WHERE sal > 300) AS x ORDER BY id"],
        ["SELECT x.id FROM (SELECT id FROM v51_emp WHERE sal > 300) AS x ORDER BY x.id",
         "WITH x AS (SELECT id FROM v51_emp WHERE sal > 300) SELECT x.id FROM x ORDER BY x.id"],
        // 表の別名を大文字で書く（識別子は大小を区別しない）
        ["SELECT e.id FROM v51_emp e ORDER BY e.id",
         "SELECT E.id FROM v51_emp E ORDER BY E.id"],
        ["SELECT e.id FROM v51_emp e ORDER BY e.id",
         "SELECT E.ID FROM V51_EMP e ORDER BY e.ID"],
        // * の書き方
        ["SELECT * FROM v51_emp ORDER BY id LIMIT 3",
         "SELECT v51_emp.* FROM v51_emp ORDER BY id LIMIT 3"],
        ["SELECT * FROM v51_emp ORDER BY id LIMIT 3",
         "SELECT e.* FROM v51_emp e ORDER BY e.id LIMIT 3"],
        ["SELECT * FROM v51_emp ORDER BY id LIMIT 3",
         "SELECT id, name, dept, sal, mgr, hired, active FROM v51_emp ORDER BY id LIMIT 3"],
        // 括弧の重ね掛け
        ["SELECT id FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT (id) FROM v51_emp WHERE ((sal) > (300)) ORDER BY id"],
        ["SELECT id FROM v51_emp WHERE sal > 300 ORDER BY id",
         "SELECT id FROM v51_emp WHERE (((((sal > 300))))) ORDER BY id"],
        ["SELECT id FROM v51_emp WHERE sal > 300 AND dept = 'Tech' ORDER BY id",
         "SELECT id FROM v51_emp WHERE (sal > 300) AND (dept = 'Tech') ORDER BY id"],
        // 文字列リテラルの書き方
        ["SELECT id FROM v51_emp WHERE dept = 'Tech' ORDER BY id",
         'SELECT id FROM v51_emp WHERE dept = "Tech" ORDER BY id'],
        ["SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE 'A%'",
         "SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE 'A' || '%'"],
        ["SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE 'A%'",
         "SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE CONCAT('A', '%')"],
        ["SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE 'A%'",
         "SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE ('A%')"],
        ["SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE 'A%'",
         "SELECT COUNT(*) AS c FROM v51_emp WHERE name LIKE (SELECT 'A%')"],
        // 引用符の中の引用符（'' の重ね書きとバックスラッシュ）
        ["SELECT 'it''s' AS x", "SELECT 'it\\'s' AS x"],
        ["SELECT 'it''s' = 'it''s' AS r", "SELECT 'it''s' = 'it\\'s' AS r"],
      ];
      IDENT.forEach(([base, variant], i) => {
        same(`V51G #${i} ${tag(variant)}`, base, variant);
      });

      // ============================================================
      // H. 受け付けない書き方（LuminaDB は MySQL 寄りの仕様）
      // ============================================================
      err('V51H double quotes are string literals, not identifiers',
          'SELECT "id" FROM "v51_emp"', 'not found');
      err('V51H square brackets are not identifier quotes',
          'SELECT [id] FROM v51_emp', 'syntax');
      err('V51H # is not a comment marker',
          'SELECT id FROM v51_emp # comment', 'syntax');
      err('V51H SELECT ALL is not supported',
          'SELECT ALL id FROM v51_emp', 'malformed');
      err('V51H an unterminated block comment is rejected',
          'SELECT id FROM v51_emp /* not closed', 'syntax');
      err('V51H an empty statement is rejected', '   ', '');
      err('V51H a comment-only statement is rejected', '-- nothing here', '');

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v51_emp', 'v51_dept', 'v51_sale');

      return T;
    }
