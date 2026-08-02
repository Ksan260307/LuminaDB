    // ============================================================================
    // [Test Suite Extra] - 追加テスト群
    //   1. 複雑クエリ (XCplx)   : 多段JOIN / サブクエリ / CTE / 集合演算 / ウィンドウ関数
    //   2. 異常系   (XNeg)     : 構文エラー / 存在しない対象 / 型・制約違反
    //   3. 境界値   (XBnd)     : LIMIT/OFFSET / 空・1行テーブル / NULL / 数値・文字列・日付の極値
    //   4. 性能     (XPerf)    : 5万行規模のCRUD・集計・結合・インデックスの時間検証
    //   5. セキュリティ (XSec) : XSS / SQLインジェクション / プロトタイプ汚染 / DoSガード
    //   test-suite.js の tests 配列へ getExtraTests() のスプレッドで合流する
    // ============================================================================
    function getExtraTests() {
      // 初期データ（users / products / orders）のミラー定数。生成テストの期待値計算に使う
      const AGES = [25, 30, 22, 35, 28, 40, 29, 31, 24, 27];
      const PNAMES = ["Laptop", "Monitor", "Mouse", "Keyboard", "Router"];
      const OAMOUNTS = [1, 2, 1, 5, 1];

      return [
        // ============================================================
        // 1. 複雑クエリテスト (XCplx)
        //    cq_dept / cq_emp / cq_sale の決定的データセット上で検証する
        // ============================================================
        { name: "XCplx: Setup Dept", sql: "CREATE TABLE cq_dept (id INTEGER PRIMARY KEY, dname TEXT, region TEXT)", check: r => r.data[0].Result === "Success" },
        { name: "XCplx: Setup Dept Rows", sql: "INSERT INTO cq_dept (id, dname, region) VALUES (1, 'Sales', 'East'), (2, 'Dev', 'West'), (3, 'HR', 'East'), (4, 'Lab', 'West')", check: r => r.data[0].Message.includes('4') },
        { name: "XCplx: Setup Emp", sql: "CREATE TABLE cq_emp (id INTEGER PRIMARY KEY, name TEXT, dept_id INTEGER, salary INTEGER, mgr_id INTEGER, active BOOLEAN, FOREIGN KEY (dept_id) REFERENCES cq_dept(id))", check: r => r.data[0].Result === "Success" },
        { name: "XCplx: Setup Emp Rows", sql: "INSERT INTO cq_emp (id, name, dept_id, salary, mgr_id, active) VALUES (1, 'Ann', 1, 500, null, true), (2, 'Ben', 1, 300, 1, true), (3, 'Cal', 1, 300, 1, false), (4, 'Dee', 2, 700, null, true), (5, 'Eli', 2, 400, 4, true), (6, 'Fay', 2, 400, 4, true), (7, 'Gus', 3, 250, null, false), (8, 'Hal', 3, 260, 7, true), (9, 'Ivy', null, 320, null, true), (10, 'Jon', 2, 800, 4, false)", check: r => r.data[0].Message.includes('10') },
        { name: "XCplx: Setup Sale", sql: "CREATE TABLE cq_sale (sid INTEGER PRIMARY KEY, emp_id INTEGER, amt INTEGER, q INTEGER)", check: r => r.data[0].Result === "Success" },
        { name: "XCplx: Setup Sale Rows", sql: "INSERT INTO cq_sale (sid, emp_id, amt, q) VALUES (1, 1, 100, 1), (2, 1, 200, 2), (3, 2, 150, 1), (4, 4, 300, 1), (5, 4, 100, 2), (6, 5, 50, 1), (7, 99, 10, 1), (8, 8, 120, 3), (9, 10, 90, 4), (10, 2, 60, 2)", check: r => r.data[0].Message.includes('10') },

        // --- JOIN 複合 ---
        { name: "XCplx: Inner Join Count", sql: "SELECT COUNT(*) AS c FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id", check: r => r.data[0].c === 9 },
        { name: "XCplx: Left Join Keeps Null Dept", sql: "SELECT e.name, d.dname FROM cq_emp e LEFT JOIN cq_dept d ON e.dept_id = d.id WHERE d.dname IS NULL", check: r => r.data.length === 1 && r.data[0].name === 'Ivy' },
        { name: "XCplx: Left Join Total Rows", sql: "SELECT COUNT(*) AS c FROM cq_emp e LEFT JOIN cq_dept d ON e.dept_id = d.id", check: r => r.data[0].c === 10 },
        { name: "XCplx: Right Join Unmatched Dept", sql: "SELECT d.dname, e.id AS eid FROM cq_emp e RIGHT JOIN cq_dept d ON e.dept_id = d.id WHERE e.id IS NULL", check: r => r.data.length === 1 && r.data[0].dname === 'Lab' },
        { name: "XCplx: Right Join Total Rows", sql: "SELECT COUNT(*) AS c FROM cq_emp e RIGHT JOIN cq_dept d ON e.dept_id = d.id", check: r => r.data[0].c === 10 },
        { name: "XCplx: Cross Join Product", sql: "SELECT COUNT(*) AS c FROM cq_emp CROSS JOIN cq_dept", check: r => r.data[0].c === 40 },
        { name: "XCplx: Three Table Join", sql: "SELECT COUNT(*) AS c FROM cq_sale s JOIN cq_emp e ON s.emp_id = e.id JOIN cq_dept d ON e.dept_id = d.id", check: r => r.data[0].c === 9 },
        { name: "XCplx: Join ON With AND (Nested Loop)", sql: "SELECT COUNT(*) AS c FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id AND e.salary > 350", check: r => r.data[0].c === 5 },
        { name: "XCplx: Left Join ON With AND", sql: "SELECT COUNT(*) AS total, COUNT(d.region) AS matched FROM cq_emp e LEFT JOIN cq_dept d ON e.dept_id = d.id AND d.region = 'East'", check: r => r.data[0].total === 10 && r.data[0].matched === 5 },
        { name: "XCplx: Self Join Manager Pairs", sql: "SELECT COUNT(*) AS c FROM cq_emp e JOIN cq_emp m ON e.mgr_id = m.id", check: r => r.data[0].c === 6 },
        { name: "XCplx: Self Join Manager Name", sql: "SELECT m.name AS mname FROM cq_emp e JOIN cq_emp m ON e.mgr_id = m.id WHERE e.id = 5", check: r => r.data.length === 1 && r.data[0].mname === 'Dee' },
        { name: "XCplx: Join Group Having Order", sql: "SELECT d.dname, SUM(e.salary) AS s FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id GROUP BY d.dname HAVING s > 600 ORDER BY s DESC", check: r => r.data.length === 2 && r.data[0].dname === 'Dev' && r.data[0].s === 2300 && r.data[1].dname === 'Sales' && r.data[1].s === 1100 },
        { name: "XCplx: Join Group Having Limit", sql: "SELECT d.dname, SUM(e.salary) AS s FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id GROUP BY d.dname ORDER BY s DESC LIMIT 2", check: r => r.data.length === 2 && r.data[0].dname === 'Dev' && r.data[1].dname === 'Sales' },
        { name: "XCplx: Dept Left Join Counts (Zero Incl)", sql: "SELECT d.dname, COUNT(e.id) AS c FROM cq_dept d LEFT JOIN cq_emp e ON d.id = e.dept_id GROUP BY d.dname ORDER BY d.dname ASC", check: r => r.data.length === 4 && r.data[0].dname === 'Dev' && r.data[0].c === 4 && r.data[1].c === 2 && r.data[2].dname === 'Lab' && r.data[2].c === 0 && r.data[3].c === 3 },
        { name: "XCplx: Triple Left Join Dept Sales", sql: "SELECT d.dname, SUM(s.amt) AS total FROM cq_dept d LEFT JOIN cq_emp e ON d.id = e.dept_id LEFT JOIN cq_sale s ON e.id = s.emp_id GROUP BY d.dname ORDER BY d.dname ASC", check: r => r.data.length === 4 && r.data[0].total === 540 && r.data[1].total === 120 && r.data[2].total === 0 && r.data[3].total === 510 },
        { name: "XCplx: Hash Join Reverse Direction", sql: "SELECT COUNT(*) AS c FROM cq_dept d JOIN cq_emp e ON d.id = e.dept_id", check: r => r.data[0].c === 9 },

        // --- サブクエリ複合 ---
        { name: "XCplx: Scalar Subquery In Where", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE salary > (SELECT AVG(salary) AS a FROM cq_emp)", check: r => r.data[0].c === 3 },
        { name: "XCplx: Scalar Subquery In Select", sql: "SELECT (SELECT MAX(salary) FROM cq_emp) AS m", check: r => r.data[0].m === 800 },
        { name: "XCplx: IN Subquery", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE id IN (SELECT emp_id FROM cq_sale)", check: r => r.data[0].c === 6 },
        { name: "XCplx: NOT IN Subquery", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE id NOT IN (SELECT emp_id FROM cq_sale)", check: r => r.data[0].c === 4 },
        { name: "XCplx: 3-Level Nested Subquery", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE dept_id IN (SELECT id FROM cq_dept WHERE region IN (SELECT region FROM cq_dept WHERE dname = 'Dev'))", check: r => r.data[0].c === 4 },
        { name: "XCplx: FROM Subquery Plus Join", sql: "SELECT t.dept_id, t.s, d.dname FROM (SELECT dept_id, SUM(salary) AS s FROM cq_emp WHERE dept_id IS NOT NULL GROUP BY dept_id) t JOIN cq_dept d ON t.dept_id = d.id ORDER BY t.s DESC", check: r => r.data.length === 3 && r.data[0].dname === 'Dev' && r.data[0].s === 2300 && r.data[2].dname === 'HR' && r.data[2].s === 510 },
        { name: "XCplx: Double Nested FROM Subquery", sql: "SELECT COUNT(*) AS c FROM (SELECT * FROM (SELECT id FROM cq_emp WHERE salary >= 400) x) y", check: r => r.data[0].c === 5 },
        { name: "XCplx: EXISTS True", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE EXISTS (SELECT 1 FROM cq_sale WHERE amt > 250)", check: r => r.data[0].c === 10 },
        { name: "XCplx: EXISTS False", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE EXISTS (SELECT 1 FROM cq_sale WHERE amt > 1000)", check: r => r.data[0].c === 0 },
        { name: "XCplx: NOT EXISTS", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE NOT EXISTS (SELECT 1 FROM cq_sale WHERE amt > 1000)", check: r => r.data[0].c === 10 },
        { name: "XCplx: IN Subquery With Condition", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE id IN (SELECT emp_id FROM cq_sale WHERE q = 1)", check: r => r.data[0].c === 4 },
        { name: "XCplx: Scalar Subquery In Expression", sql: "SELECT salary - (SELECT MIN(salary) FROM cq_emp) AS diff FROM cq_emp WHERE id = 10", check: r => r.data[0].diff === 550 },
        { name: "XCplx: IN Empty Subquery", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE id IN (SELECT emp_id FROM cq_sale WHERE amt > 99999)", check: r => r.data[0].c === 0 },
        { name: "XCplx: NOT IN Empty Subquery", sql: "SELECT COUNT(*) AS c FROM cq_emp WHERE id NOT IN (SELECT emp_id FROM cq_sale WHERE amt > 99999)", check: r => r.data[0].c === 10 },
        { name: "XCplx: Scalar Empty Subquery Folds To Null", sql: "SELECT COALESCE((SELECT MAX(amt) FROM cq_sale WHERE amt > 99999), -1) AS v FROM cq_emp WHERE id = 1", check: r => r.data.length === 1 && r.data[0].v === -1 },

        // --- CTE 複合 ---
        { name: "XCplx: CTE Basic", sql: "WITH high AS (SELECT * FROM cq_emp WHERE salary >= 400) SELECT COUNT(*) AS c FROM high", check: r => r.data[0].c === 5 },
        { name: "XCplx: CTE Chained", sql: "WITH a AS (SELECT id, salary FROM cq_emp WHERE salary >= 300), b AS (SELECT id FROM a WHERE salary >= 500) SELECT COUNT(*) AS c FROM b", check: r => r.data[0].c === 3 },
        { name: "XCplx: CTE Join Real Table", sql: "WITH ds AS (SELECT dept_id, COUNT(*) AS c FROM cq_emp WHERE dept_id IS NOT NULL GROUP BY dept_id) SELECT d.dname, ds.c FROM cq_dept d JOIN ds ON d.id = ds.dept_id ORDER BY ds.c DESC LIMIT 1", check: r => r.data[0].dname === 'Dev' && r.data[0].c === 4 },
        { name: "XCplx: CTE With Union Body", sql: "WITH u AS (SELECT id FROM cq_emp WHERE id <= 2 UNION SELECT id FROM cq_emp WHERE id >= 9) SELECT COUNT(*) AS c FROM u", check: r => r.data[0].c === 4 },
        { name: "XCplx: CTE Aggregation", sql: "WITH t AS (SELECT salary FROM cq_emp WHERE active = true) SELECT COUNT(*) AS c, SUM(salary) AS s FROM t", check: r => r.data[0].c === 7 && r.data[0].s === 2880 },

        // --- 集合演算 複合 ---
        { name: "XCplx: Union Dedup", sql: "SELECT id FROM cq_emp WHERE id <= 3 UNION SELECT id FROM cq_emp WHERE id >= 2 AND id <= 4", check: r => r.data.length === 4 },
        { name: "XCplx: Union All Keeps Dups", sql: "SELECT id FROM cq_emp WHERE id <= 3 UNION ALL SELECT id FROM cq_emp WHERE id <= 3", check: r => r.data.length === 6 },
        { name: "XCplx: Intersect", sql: "SELECT id FROM cq_emp WHERE id <= 5 INTERSECT SELECT id FROM cq_emp WHERE id >= 4", check: r => r.data.length === 2 },
        { name: "XCplx: Except", sql: "SELECT id FROM cq_emp WHERE id <= 5 EXCEPT SELECT id FROM cq_emp WHERE id >= 3", check: r => r.data.length === 2 },
        { name: "XCplx: Union Except Chain", sql: "SELECT id FROM cq_emp WHERE id <= 3 UNION SELECT id FROM cq_emp WHERE id = 5 EXCEPT SELECT id FROM cq_emp WHERE id = 2", check: r => r.data.length === 3 },
        { name: "XCplx: Union Column Remap", sql: "SELECT id, name FROM cq_emp WHERE id = 1 UNION SELECT sid, amt FROM cq_sale WHERE sid = 1", check: r => r.data.length === 2 && r.data[0].name === 'Ann' && r.data[1].id === 1 && r.data[1].name === 100 },
        { name: "XCplx: Union Order Ordinal Limit", sql: "SELECT id FROM cq_emp WHERE id <= 3 UNION SELECT id FROM cq_emp WHERE id >= 9 ORDER BY 1 DESC LIMIT 1, 2", check: r => r.data.length === 2 && r.data[0].id === 9 && r.data[1].id === 3 },
        { name: "XCplx: Union Of Aggregates", sql: "SELECT SUM(salary) AS v FROM cq_emp UNION ALL SELECT SUM(amt) AS v FROM cq_sale", check: r => r.data.length === 2 && r.data[0].v === 4230 && r.data[1].v === 1180 },
        { name: "XCplx: Intersect Empty Result", sql: "SELECT id FROM cq_emp WHERE id <= 2 INTERSECT SELECT id FROM cq_emp WHERE id >= 9", check: r => r.data.length === 0 },
        { name: "XCplx: Intersect Then Union All", sql: "SELECT id FROM cq_emp WHERE id <= 5 INTERSECT SELECT id FROM cq_emp WHERE id >= 5 UNION ALL SELECT id FROM cq_emp WHERE id = 1", check: r => r.data.length === 2 },

        // --- ウィンドウ関数 複合 ---
        { name: "XCplx: Window RANK Full", sql: "SELECT id, RANK() OVER(ORDER BY salary DESC) AS rk FROM cq_emp ORDER BY rk ASC, id ASC", check: r => r.data.length === 10 && r.data[0].id === 10 && r.data[0].rk === 1 && r.data[1].id === 4 && r.data[2].id === 1 && r.data[3].rk === 4 && r.data[4].rk === 4 && r.data[5].rk === 6 && r.data[9].rk === 10 },
        { name: "XCplx: Window DENSE_RANK Full", sql: "SELECT id, DENSE_RANK() OVER(ORDER BY salary DESC) AS drk FROM cq_emp ORDER BY drk ASC, id ASC", check: r => r.data[3].drk === 4 && r.data[4].drk === 4 && r.data[5].id === 9 && r.data[5].drk === 5 && r.data[9].drk === 8 },
        { name: "XCplx: Window RowNum Partition", sql: "SELECT id, ROW_NUMBER() OVER(PARTITION BY dept_id ORDER BY salary DESC) AS rn FROM cq_emp WHERE dept_id = 2 ORDER BY rn ASC", check: r => r.data.length === 4 && r.data[0].id === 10 && r.data[1].id === 4 && r.data[2].id === 5 && r.data[3].id === 6 },
        { name: "XCplx: Window Running Sum", sql: "SELECT id, SUM(salary) OVER(PARTITION BY dept_id ORDER BY id ASC) AS run FROM cq_emp WHERE dept_id = 1 ORDER BY id ASC", check: r => r.data[0].run === 500 && r.data[1].run === 800 && r.data[2].run === 1100 },
        { name: "XCplx: Window Count No Order", sql: "SELECT id, COUNT(*) OVER(PARTITION BY dept_id) AS c FROM cq_emp WHERE dept_id = 2", check: r => r.data.length === 4 && r.data.every(d => d.c === 4) },
        { name: "XCplx: Window Avg Partition", sql: "SELECT id, AVG(salary) OVER(PARTITION BY dept_id) AS a FROM cq_emp WHERE dept_id = 2", check: r => r.data.length === 4 && r.data.every(d => d.a === 575) },
        { name: "XCplx: Window MinMax Partition", sql: "SELECT id, MIN(salary) OVER(PARTITION BY dept_id) AS mn, MAX(salary) OVER(PARTITION BY dept_id) AS mx FROM cq_emp WHERE dept_id = 1", check: r => r.data.length === 3 && r.data.every(d => d.mn === 300 && d.mx === 500) },
        { name: "XCplx: Window Lag Lead", sql: "SELECT id, LAG(salary) OVER(ORDER BY id ASC) AS pv, LEAD(salary) OVER(ORDER BY id ASC) AS nv FROM cq_emp WHERE dept_id = 3 ORDER BY id ASC", check: r => r.data[0].pv === null && r.data[0].nv === 260 && r.data[1].pv === 250 && r.data[1].nv === null },
        { name: "XCplx: Window Lag Offset 3", sql: "SELECT id, LAG(salary, 3) OVER(ORDER BY id ASC) AS pv FROM cq_emp ORDER BY id ASC LIMIT 4", check: r => r.data[0].pv === null && r.data[2].pv === null && r.data[3].pv === 500 },
        { name: "XCplx: Window NTILE 2", sql: "SELECT id, NTILE(2) OVER(ORDER BY id ASC) AS nt FROM cq_emp ORDER BY id ASC", check: r => r.data[4].nt === 1 && r.data[5].nt === 2 },
        { name: "XCplx: Window NTILE 3 Uneven", sql: "SELECT id, NTILE(3) OVER(ORDER BY id ASC) AS nt FROM cq_emp ORDER BY id ASC", check: r => r.data[3].nt === 1 && r.data[4].nt === 2 && r.data[6].nt === 2 && r.data[7].nt === 3 },
        { name: "XCplx: Window First Last Value", sql: "SELECT FIRST_VALUE(name) OVER(ORDER BY salary ASC) AS f, LAST_VALUE(name) OVER(ORDER BY salary ASC) AS l FROM cq_emp LIMIT 1", check: r => r.data[0].f === 'Gus' && r.data[0].l === 'Jon' },
        { name: "XCplx: Two Windows One Query", sql: "SELECT id, ROW_NUMBER() OVER(ORDER BY id ASC) AS rn, RANK() OVER(ORDER BY salary DESC) AS rk FROM cq_emp WHERE id <= 3 ORDER BY id ASC", check: r => r.data[0].rn === 1 && r.data[0].rk === 1 && r.data[1].rk === 2 && r.data[2].rn === 3 && r.data[2].rk === 2 },

        // --- 集計・式 複合 ---
        { name: "XCplx: Multi Aggregates", sql: "SELECT COUNT(*) AS c, SUM(salary) AS s, AVG(salary) AS a, MAX(salary) AS mx, MIN(salary) AS mn FROM cq_emp", check: r => r.data[0].c === 10 && r.data[0].s === 4230 && r.data[0].a === 423 && r.data[0].mx === 800 && r.data[0].mn === 250 },
        { name: "XCplx: Avg Rounded 2 Digits", sql: "SELECT AVG(salary) AS a FROM cq_emp WHERE dept_id = 1", check: r => r.data[0].a === 366.67 },
        { name: "XCplx: Group By Expression", sql: "SELECT COUNT(*) AS c FROM cq_emp GROUP BY salary >= 500", check: r => r.data.length === 2 && r.data[0].c === 3 && r.data[1].c === 7 },
        { name: "XCplx: Group By Multi Column", sql: "SELECT dept_id, active, COUNT(*) AS c FROM cq_emp GROUP BY dept_id, active", check: r => r.data.length === 7 },
        { name: "XCplx: Having Multi Condition", sql: "SELECT dept_id, COUNT(*) AS c, SUM(salary) AS s FROM cq_emp WHERE dept_id IS NOT NULL GROUP BY dept_id HAVING c >= 2 AND s < 2000 ORDER BY dept_id ASC", check: r => r.data.length === 2 && r.data[0].dept_id === 1 && r.data[1].dept_id === 3 },
        { name: "XCplx: Count Distinct Vs Count", sql: "SELECT COUNT(DISTINCT dept_id) AS cd, COUNT(dept_id) AS c FROM cq_emp", check: r => r.data[0].cd === 3 && r.data[0].c === 9 },
        { name: "XCplx: Sum Avg Distinct", sql: "SELECT SUM(DISTINCT salary) AS s, AVG(DISTINCT salary) AS a FROM cq_emp", check: r => r.data[0].s === 3530 && r.data[0].a === 441.25 },
        { name: "XCplx: Group Concat Basic", sql: "SELECT GROUP_CONCAT(name) AS g FROM cq_emp WHERE dept_id = 1", check: r => r.data[0].g === 'Ann,Ben,Cal' },
        { name: "XCplx: Group Concat Separator", sql: "SELECT GROUP_CONCAT(name SEPARATOR ' / ') AS g FROM cq_emp WHERE dept_id = 1", check: r => r.data[0].g === 'Ann / Ben / Cal' },
        { name: "XCplx: Group Concat Distinct", sql: "SELECT GROUP_CONCAT(DISTINCT dept_id) AS g FROM cq_emp", check: r => r.data[0].g === '1,2,3' },
        { name: "XCplx: Median Even Count", sql: "SELECT MEDIAN(salary) AS m FROM cq_emp", check: r => r.data[0].m === 360 },
        { name: "XCplx: Median Group", sql: "SELECT MEDIAN(salary) AS m FROM cq_emp WHERE dept_id = 2", check: r => r.data[0].m === 550 },
        { name: "XCplx: Variance Stddev", sql: "SELECT VARIANCE(salary) AS va, STDDEV(salary) AS sd FROM cq_emp WHERE dept_id = 3", check: r => r.data[0].va === 25 && r.data[0].sd === 5 },
        { name: "XCplx: Sum Of Expression", sql: "SELECT SUM(salary * 2) AS s FROM cq_emp", check: r => r.data[0].s === 8460 },
        { name: "XCplx: Conditional Sum", sql: "SELECT SUM(CASE WHEN active = true THEN salary ELSE 0 END) AS s FROM cq_emp", check: r => r.data[0].s === 2880 },
        { name: "XCplx: MinMax Strings", sql: "SELECT MAX(name) AS mx, MIN(name) AS mn FROM cq_emp", check: r => r.data[0].mx === 'Jon' && r.data[0].mn === 'Ann' },
        { name: "XCplx: Agg With Group Col", sql: "SELECT dept_id, MAX(salary) AS m FROM cq_emp WHERE dept_id = 2 GROUP BY dept_id", check: r => r.data.length === 1 && r.data[0].dept_id === 2 && r.data[0].m === 800 },

        // --- CASE / 関数チェーン ---
        { name: "XCplx: Simple Case Region", sql: "SELECT CASE region WHEN 'East' THEN 1 ELSE 0 END AS e FROM cq_dept WHERE id = 1", check: r => r.data[0].e === 1 },
        { name: "XCplx: Case Band Group", sql: "SELECT CASE WHEN salary < 300 THEN 'low' WHEN salary < 500 THEN 'mid' ELSE 'high' END AS band, COUNT(*) AS c FROM cq_emp GROUP BY CASE WHEN salary < 300 THEN 'low' WHEN salary < 500 THEN 'mid' ELSE 'high' END ORDER BY band ASC", check: r => r.data.length === 3 && r.data[0].band === 'high' && r.data[0].c === 3 && r.data[1].band === 'low' && r.data[1].c === 2 && r.data[2].band === 'mid' && r.data[2].c === 5 },
        { name: "XCplx: Nested String Funcs", sql: "SELECT CONCAT(UPPER(LEFT(name, 2)), LOWER(RIGHT(name, 1))) AS x FROM cq_emp WHERE id = 1", check: r => r.data[0].x === 'ANn' },
        { name: "XCplx: Date Literal Funcs", sql: "SELECT YEAR('2030-07-15') AS y, MONTH('2030-07-15') AS m, DAY('2030-07-15') AS d", check: r => r.data[0].y === 2030 && r.data[0].m === 7 && r.data[0].d === 15 },
        { name: "XCplx: If Ifnull Composite", sql: "SELECT IF(1 < 2, IFNULL(null, 'a'), 'b') AS v", check: r => r.data[0].v === 'a' },
        { name: "XCplx: Cast Roundtrip", sql: "SELECT CAST(CAST(salary AS TEXT) AS INTEGER) AS v FROM cq_emp WHERE id = 4", check: r => r.data[0].v === 700 },

        // --- ビュー 複合 ---
        { name: "XCplx: View Create", sql: "CREATE VIEW cq_v_high AS SELECT id, name, dept_id, salary FROM cq_emp WHERE salary >= 400", check: r => r.data[0].Result === "Success" },
        { name: "XCplx: View Count", sql: "SELECT COUNT(*) AS c FROM cq_v_high", check: r => r.data[0].c === 5 },
        { name: "XCplx: View Where Order", sql: "SELECT name, salary FROM cq_v_high WHERE salary >= 700 ORDER BY salary DESC", check: r => r.data.length === 2 && r.data[0].name === 'Jon' && r.data[1].name === 'Dee' },
        { name: "XCplx: View Join Dept", sql: "SELECT COUNT(*) AS c FROM cq_v_high v JOIN cq_dept d ON v.dept_id = d.id", check: r => r.data[0].c === 5 },
        { name: "XCplx: View Of View", fn: () => {
            db.executeQuery("CREATE VIEW cq_v_top AS SELECT * FROM cq_v_high WHERE salary >= 700");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM cq_v_top");
            return !r.error && r.data[0].c === 2;
        }},
        { name: "XCplx: View Or Replace", fn: () => {
            const rep = db.executeQuery("CREATE OR REPLACE VIEW cq_v_top AS SELECT * FROM cq_v_high WHERE salary >= 800");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM cq_v_top");
            db.executeQuery("DROP VIEW cq_v_top");
            db.executeQuery("DROP VIEW cq_v_high");
            return !rep.error && r.data[0].c === 1;
        }},

        // --- 複合DML / トランザクション ---
        { name: "XCplx: CTAS With Group", fn: () => {
            const r = db.executeQuery("CREATE TABLE cq_stat AS SELECT dept_id, SUM(salary) AS s FROM cq_emp WHERE dept_id IS NOT NULL GROUP BY dept_id");
            const v = db.executeQuery("SELECT s FROM cq_stat WHERE dept_id = 2");
            db.executeQuery("DROP TABLE cq_stat");
            return !r.error && v.data.length === 1 && v.data[0].s === 2300;
        }},
        { name: "XCplx: Insert Select With Join", fn: () => {
            db.executeQuery("CREATE TABLE cq_flat (ename TEXT, dname TEXT)");
            const r = db.executeQuery("INSERT INTO cq_flat (ename, dname) SELECT e.name, d.dname FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM cq_flat WHERE dname = 'Dev'");
            db.executeQuery("DROP TABLE cq_flat");
            return !r.error && r.data[0].Message.includes('9') && c.data[0].c === 4;
        }},
        { name: "XCplx: Update With Math On Copy", fn: () => {
            db.executeQuery("CREATE TABLE cq_up AS SELECT id, salary FROM cq_emp");
            const r = db.executeQuery("UPDATE cq_up SET salary = ROUND(salary * 1.1) WHERE salary >= 400");
            const v1 = db.executeQuery("SELECT salary FROM cq_up WHERE id = 4");
            const v2 = db.executeQuery("SELECT salary FROM cq_up WHERE id = 7");
            db.executeQuery("DROP TABLE cq_up");
            return !r.error && r.data[0].Message.includes('5') && v1.data[0].salary === 770 && v2.data[0].salary === 250;
        }},
        { name: "XCplx: Delete With Not In Subquery", fn: () => {
            db.executeQuery("CREATE TABLE cq_del AS SELECT id FROM cq_emp");
            const r = db.executeQuery("DELETE FROM cq_del WHERE id NOT IN (SELECT emp_id FROM cq_sale)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM cq_del");
            db.executeQuery("DROP TABLE cq_del");
            return !r.error && r.data[0].Message.includes('4') && c.data[0].c === 6;
        }},
        { name: "XCplx: Tx Savepoint Combo", fn: () => {
            db.executeQuery("CREATE TABLE cq_tx AS SELECT id, salary FROM cq_emp");
            db.executeQuery("BEGIN");
            db.executeQuery("UPDATE cq_tx SET salary = 0 WHERE id = 1");
            db.executeQuery("SAVEPOINT s1");
            db.executeQuery("DELETE FROM cq_tx WHERE id >= 6");
            const mid = db.executeQuery("SELECT COUNT(*) AS c FROM cq_tx").data[0].c;
            db.executeQuery("ROLLBACK TO SAVEPOINT s1");
            const back = db.executeQuery("SELECT COUNT(*) AS c FROM cq_tx").data[0].c;
            db.executeQuery("COMMIT");
            const sal = db.executeQuery("SELECT salary FROM cq_tx WHERE id = 1").data[0].salary;
            db.executeQuery("DROP TABLE cq_tx");
            return mid === 5 && back === 10 && sal === 0;
        }},
        { name: "XCplx: Explain Multi Join Plan", sql: "EXPLAIN SELECT e.name, d.dname, s.amt FROM cq_emp e JOIN cq_dept d ON e.dept_id = d.id LEFT JOIN cq_sale s ON e.id = s.emp_id WHERE e.salary > 300 ORDER BY e.id LIMIT 5", check: r => r.data.length >= 4 && r.data.some(d => d.Operation.includes('JOIN')) && r.data.some(d => d.Operation === 'ORDER BY') && r.data.some(d => d.Operation === 'LIMIT') },

        // --- 生成テスト: users/products/orders ミラー定数との突き合わせ ---
        ...Array.from({length: 10}).map((_, i) => ({
            name: `XCplx Gen: Age Between ${20 + i}-${29 + i}`,
            sql: `SELECT COUNT(*) AS c FROM users WHERE age BETWEEN ${20 + i} AND ${29 + i}`,
            check: r => r.data[0].c === AGES.filter(a => a >= 20 + i && a <= 29 + i).length
        })),
        ...Array.from({length: 10}).map((_, i) => ({
            name: `XCplx Gen: Join Amount >= ${i % 5}`,
            sql: `SELECT COUNT(*) AS c FROM orders o JOIN users u ON o.user_id = u.id WHERE o.amount >= ${i % 5}`,
            check: r => r.data[0].c === OAMOUNTS.filter(a => a >= i % 5).length
        })),
        ...Array.from({length: 10}).map((_, i) => ({
            name: `XCplx Gen: Math Identity ${i}`,
            sql: `SELECT POWER(${i}, 2) + SQRT(${i * i}) AS v`,
            check: r => r.data[0].v === i * i + i
        })),
        ...Array.from({length: 10}).map((_, i) => ({
            name: `XCplx Gen: Product String Funcs ${i}`,
            sql: `SELECT UPPER(name) AS u, LENGTH(name) AS l FROM products WHERE id = ${101 + (i % 5)}`,
            check: r => r.data[0].u === PNAMES[i % 5].toUpperCase() && r.data[0].l === PNAMES[i % 5].length
        })),
        ...Array.from({length: 10}).map((_, i) => ({
            name: `XCplx Gen: Mod Age Divisible ${i + 2}`,
            sql: `SELECT COUNT(*) AS c FROM users WHERE MOD(age, ${i + 2}) = 0`,
            check: r => r.data[0].c === AGES.filter(a => a % (i + 2) === 0).length
        })),

        // ============================================================
        // 2. 異常系テスト (XNeg)
        // ============================================================
        { name: "XNeg: Select Missing Table", sql: "SELECT * FROM zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Join Missing Table", sql: "SELECT * FROM users u JOIN zz_nothing z ON u.id = z.id", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: From Subquery Missing Table", sql: "SELECT * FROM (SELECT * FROM zz_nothing) t", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Having Unknown Column", sql: "SELECT age, COUNT(*) AS c FROM users GROUP BY age HAVING zz_ghost > 1", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Order By Ordinal Zero", sql: "SELECT id FROM users ORDER BY 0", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('out of range') },
        { name: "XNeg: Order By Ordinal 99", sql: "SELECT id FROM users ORDER BY 99", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('out of range') },
        { name: "XNeg: Union Column Mismatch", sql: "SELECT id, name FROM users UNION SELECT id FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Intersect Column Mismatch", sql: "SELECT id, name FROM users INTERSECT SELECT id FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Except Column Mismatch", sql: "SELECT id FROM users EXCEPT SELECT id, name FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Unknown Function", sql: "SELECT TOTALLY_FAKE_FN(id) AS v FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Unterminated String", sql: "SELECT * FROM users WHERE name = 'Alice", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Insert Missing Table", sql: "INSERT INTO zz_nothing (id) VALUES (1)", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Update Missing Table", sql: "UPDATE zz_nothing SET id = 1", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Delete Missing Table", sql: "DELETE FROM zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Insert Fewer Values", fn: () => {
            db.executeQuery("CREATE TABLE nx_cnt (a INTEGER, b INTEGER)");
            const r = db.executeQuery("INSERT INTO nx_cnt (a, b) VALUES (1)");
            db.executeQuery("DROP TABLE nx_cnt");
            return r.error !== undefined && r.error.includes("Column count");
        }},
        { name: "XNeg: Insert More Values", fn: () => {
            db.executeQuery("CREATE TABLE nx_cnt2 (a INTEGER)");
            const r = db.executeQuery("INSERT INTO nx_cnt2 (a) VALUES (1, 2)");
            db.executeQuery("DROP TABLE nx_cnt2");
            return r.error !== undefined && r.error.includes("Column count");
        }},
        { name: "XNeg: Insert Select Count Mismatch", fn: () => {
            db.executeQuery("CREATE TABLE nx_is (a INTEGER, b INTEGER)");
            const r = db.executeQuery("INSERT INTO nx_is (a, b) SELECT id FROM users");
            db.executeQuery("DROP TABLE nx_is");
            return r.error !== undefined;
        }},
        { name: "XNeg: Insert Select Missing Source", fn: () => {
            db.executeQuery("CREATE TABLE nx_is2 (a INTEGER)");
            const r = db.executeQuery("INSERT INTO nx_is2 (a) SELECT id FROM zz_nothing");
            db.executeQuery("DROP TABLE nx_is2");
            return r.error !== undefined;
        }},
        // v1.3: INSERT ... SELECT と ON DUPLICATE KEY UPDATE の併用はサポートされた（旧: 明示エラー）
        { name: "XNeg: ODKU With Insert Select Now Works", fn: () => {
            db.executeQuery("CREATE TABLE nx_od (a INTEGER PRIMARY KEY, hit INTEGER)");
            db.executeQuery("INSERT INTO nx_od (a, hit) VALUES (1, 0)");
            const r = db.executeQuery("INSERT INTO nx_od (a, hit) SELECT id, age FROM users WHERE id <= 3 ON DUPLICATE KEY UPDATE hit = 9");
            const upd = db.executeQuery("SELECT hit FROM nx_od WHERE a = 1");
            const ins = db.executeQuery("SELECT hit FROM nx_od WHERE a = 2");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM nx_od");
            db.executeQuery("DROP TABLE nx_od");
            return !r.error && upd.data[0].hit === 9 && ins.data[0].hit === 30 && c.data[0].c === 3;
        }},
        { name: "XNeg: Insert Set Malformed", fn: () => {
            db.executeQuery("CREATE TABLE nx_set (a INTEGER)");
            const r = db.executeQuery("INSERT INTO nx_set SET a");
            db.executeQuery("DROP TABLE nx_set");
            return r.error !== undefined;
        }},
        { name: "XNeg: Create Table View Conflict", fn: () => {
            db.executeQuery("CREATE VIEW nx_v AS SELECT id FROM users");
            const r = db.executeQuery("CREATE TABLE nx_v (id INTEGER)");
            db.executeQuery("DROP VIEW nx_v");
            return r.error !== undefined;
        }},
        { name: "XNeg: Multi Auto Increment", sql: "CREATE TABLE nx_ai (a INTEGER AUTO_INCREMENT, b INTEGER AUTO_INCREMENT)", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Table PK On Missing Column", sql: "CREATE TABLE nx_pkm (a INTEGER, PRIMARY KEY (zz))", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Create Index Syntax", sql: "CREATE INDEX ON users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Drop Index No On Clause", sql: "DROP INDEX idx_x", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Alter Missing Table", sql: "ALTER TABLE zz_nothing ADD COLUMN x TEXT", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Rename Column Missing", sql: "ALTER TABLE users RENAME COLUMN zz_ghost TO abc", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Rename Column To Existing", sql: "ALTER TABLE users RENAME COLUMN id TO name", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Rename Table To Existing", fn: () => {
            db.executeQuery("CREATE TABLE nx_rn (id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_rn RENAME TO users");
            db.executeQuery("DROP TABLE nx_rn");
            return r.error !== undefined;
        }},
        { name: "XNeg: Rename Table Statement Missing", sql: "RENAME TABLE zz_nothing TO abc", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Rename Table Syntax", sql: "RENAME TABLE users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Modify Missing Column", sql: "ALTER TABLE users MODIFY COLUMN zz_ghost INTEGER", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Alter Add PK Twice", fn: () => {
            db.executeQuery("CREATE TABLE nx_pk2 (id INTEGER PRIMARY KEY)");
            const r = db.executeQuery("ALTER TABLE nx_pk2 ADD PRIMARY KEY (id)");
            db.executeQuery("DROP TABLE nx_pk2");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Drop PK None", fn: () => {
            db.executeQuery("CREATE TABLE nx_pk3 (id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_pk3 DROP PRIMARY KEY");
            db.executeQuery("DROP TABLE nx_pk3");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Drop Unique None", fn: () => {
            db.executeQuery("CREATE TABLE nx_uq (id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_uq DROP UNIQUE (id)");
            db.executeQuery("DROP TABLE nx_uq");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Add FK Missing Ref Table", fn: () => {
            db.executeQuery("CREATE TABLE nx_fk1 (p_id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_fk1 ADD FOREIGN KEY (p_id) REFERENCES zz_nothing (id)");
            db.executeQuery("DROP TABLE nx_fk1");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Add FK Missing Ref Column", fn: () => {
            db.executeQuery("CREATE TABLE nx_fk2 (p_id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_fk2 ADD FOREIGN KEY (p_id) REFERENCES users (zz_ghost)");
            db.executeQuery("DROP TABLE nx_fk2");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Add FK Duplicate", fn: () => {
            db.executeQuery("CREATE TABLE nx_fkp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE nx_fkc (p_id INTEGER, FOREIGN KEY (p_id) REFERENCES nx_fkp(id))");
            const r = db.executeQuery("ALTER TABLE nx_fkc ADD FOREIGN KEY (p_id) REFERENCES nx_fkp (id)");
            db.executeQuery("DROP TABLE nx_fkc");
            db.executeQuery("DROP TABLE nx_fkp");
            return r.error !== undefined;
        }},
        { name: "XNeg: Alter Drop FK None", fn: () => {
            db.executeQuery("CREATE TABLE nx_fk3 (p_id INTEGER)");
            const r = db.executeQuery("ALTER TABLE nx_fk3 DROP FOREIGN KEY (p_id)");
            db.executeQuery("DROP TABLE nx_fk3");
            return r.error !== undefined;
        }},
        { name: "XNeg: Tx Savepoint Release Missing", fn: () => {
            db.executeQuery("BEGIN");
            const r = db.executeQuery("RELEASE SAVEPOINT zz_no_sp");
            db.executeQuery("ROLLBACK");
            return r.error !== undefined;
        }},
        { name: "XNeg: Tx Rollback To Missing", fn: () => {
            db.executeQuery("BEGIN");
            const r = db.executeQuery("ROLLBACK TO SAVEPOINT zz_no_sp");
            db.executeQuery("ROLLBACK");
            return r.error !== undefined;
        }},
        { name: "XNeg: View Non-Select Body", sql: "CREATE VIEW nx_bad AS UPDATE users SET age = 1", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: View Self Reference", sql: "CREATE VIEW nx_selfv AS SELECT * FROM nx_selfv", isErrorExpected: true, check: r => r.error !== undefined },
        // v1.18: 単一表ビューへの INSERT / UPDATE は基底表へ書き換えて実行される（旧: 明示エラー）。
        // 共有テーブル (users) を書き換えないよう専用テーブルで検証する
        { name: "XView: Insert Into View Now Works", fn: () => {
            db.executeQuery("CREATE TABLE nx_t2 (id INTEGER, nm TEXT)");
            db.executeQuery("CREATE VIEW nx_v2 AS SELECT id FROM nx_t2");
            const r = db.executeQuery("INSERT INTO nx_v2 (id) VALUES (99)");
            const got = db.executeQuery("SELECT id, nm FROM nx_t2");
            db.executeQuery("DROP VIEW nx_v2");
            db.executeQuery("DROP TABLE nx_t2");
            // ビューに含まれない列は既定値 (NULL) のまま
            return !r.error && got.data.length === 1 && got.data[0].id === 99 && got.data[0].nm === null;
        }},
        { name: "XView: Update View Now Works", fn: () => {
            db.executeQuery("CREATE TABLE nx_t3 (id INTEGER)");
            db.executeQuery("INSERT INTO nx_t3 (id) VALUES (5)");
            db.executeQuery("CREATE VIEW nx_v3 AS SELECT id FROM nx_t3");
            const r = db.executeQuery("UPDATE nx_v3 SET id = 1");
            const got = db.executeQuery("SELECT id FROM nx_t3");
            db.executeQuery("DROP VIEW nx_v3");
            db.executeQuery("DROP TABLE nx_t3");
            return !r.error && got.data[0].id === 1;
        }},
        { name: "XNeg: Update Aggregate View Rejected", fn: () => {
            db.executeQuery("CREATE VIEW nx_v4 AS SELECT age, COUNT(*) AS n FROM users GROUP BY age");
            const r = db.executeQuery("UPDATE nx_v4 SET n = 1");
            db.executeQuery("DROP VIEW nx_v4");
            return r.error !== undefined && r.error.includes('not updatable');
        }},
        { name: "XNeg: Call Syntax With Args", sql: "CALL some_proc(1)", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Create Procedure Empty Body", sql: "CREATE PROCEDURE nx_p AS", isErrorExpected: true, check: r => r.error !== undefined },
        // v1.2: 相関サブクエリは行単位評価でサポートされた（旧: 明示エラー）
        { name: "XNeg: Correlated Scalar Subquery Now Works", sql: "SELECT * FROM users u WHERE age > (SELECT AVG(amount) FROM orders o WHERE o.user_id = u.id)", check: r => !r.error && r.data.length === 10 },
        { name: "XNeg: Correlated IN Subquery Now Works", sql: "SELECT * FROM users u WHERE id IN (SELECT user_id FROM orders WHERE user_id = u.id)", check: r => !r.error && r.data.length === 4 },
        { name: "XNeg: CTE Missing Main Statement", sql: "WITH a AS (SELECT id FROM users)", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: CTE Body Error", sql: "WITH a AS (SELECT * FROM zz_nothing) SELECT * FROM a", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Show Unknown Target", sql: "SHOW GADGETS", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Show Indexes Missing Table", sql: "SHOW INDEXES FROM zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Show Create Table Missing", sql: "SHOW CREATE TABLE zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Show Create View Missing", sql: "SHOW CREATE VIEW zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Describe Missing", sql: "DESCRIBE zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Truncate Missing", sql: "TRUNCATE TABLE zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Create Table Like Missing Source", sql: "CREATE TABLE nx_like LIKE zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: CTAS From Missing Table", sql: "CREATE TABLE nx_ctas AS SELECT * FROM zz_nothing", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XNeg: Optimize In Transaction", fn: () => {
            db.executeQuery("BEGIN");
            const r = db.executeQuery("OPTIMIZE");
            db.executeQuery("ROLLBACK");
            return r.error !== undefined;
        }},

        // --- 制約違反まとめ (専用テーブル) ---
        { name: "XNeg: Constraint Setup", fn: () => {
            db.executeQuery("CREATE TABLE nx_cp (id INTEGER PRIMARY KEY)");
            db.executeQuery("CREATE TABLE nx_cc (id INTEGER PRIMARY KEY, p_id INTEGER, em TEXT UNIQUE, nm TEXT NOT NULL, FOREIGN KEY (p_id) REFERENCES nx_cp(id))");
            db.executeQuery("INSERT INTO nx_cp (id) VALUES (1), (2)");
            const r = db.executeQuery("INSERT INTO nx_cc (id, p_id, em, nm) VALUES (10, 1, 'a@x', 'n1'), (11, 2, 'b@x', 'n2')");
            return !r.error && r.data[0].Message.includes('2');
        }},
        { name: "XNeg: FK Insert Invalid", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (12, 99, 'c@x', 'n3')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key') },
        { name: "XNeg: FK Update Invalid", sql: "UPDATE nx_cc SET p_id = 99 WHERE id = 10", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key') },
        { name: "XNeg: FK Delete Parent Restrict", sql: "DELETE FROM nx_cp WHERE id = 1", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key') },
        { name: "XNeg: FK Update Parent Restrict", sql: "UPDATE nx_cp SET id = 5 WHERE id = 1", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Foreign key') },
        { name: "XNeg: PK Duplicate Insert", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (10, 1, 'z@x', 'n9')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('PRIMARY KEY') },
        { name: "XNeg: PK Batch Internal Duplicate", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (20, 1, 'k1@x', 'k1'), (20, 1, 'k2@x', 'k2')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('PRIMARY KEY') },
        { name: "XNeg: PK Null Insert", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (null, 1, 'w@x', 'w1')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('PRIMARY KEY') },
        { name: "XNeg: Unique Duplicate Insert", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (30, 1, 'a@x', 'n5')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('UNIQUE') },
        { name: "XNeg: Unique Update Collision", sql: "UPDATE nx_cc SET em = 'a@x' WHERE id = 11", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('UNIQUE') },
        { name: "XNeg: NotNull Insert Null", sql: "INSERT INTO nx_cc (id, p_id, em, nm) VALUES (40, 1, 'd@x', null)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('NOT NULL') },
        { name: "XNeg: NotNull Column Omitted", sql: "INSERT INTO nx_cc (id, p_id, em) VALUES (41, 1, 'e@x')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('NOT NULL') },
        { name: "XNeg: NotNull Update To Null", sql: "UPDATE nx_cc SET nm = null WHERE id = 10", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('NOT NULL') },
        { name: "XNeg: Constraint Rows Unchanged", sql: "SELECT COUNT(*) AS c FROM nx_cc", check: r => r.data[0].c === 2 },
        { name: "XNeg: Constraint Cleanup", fn: () => {
            db.executeQuery("DROP TABLE nx_cc");
            db.executeQuery("DROP TABLE nx_cp");
            return !db.tables['nx_cc'] && !db.tables['nx_cp'];
        }},

        // --- 生成テスト: 不正構文 ---
        ...[
            "SELECT",
            "SELECT FROM users",
            "SELECT * FORM users",
            "SELECT * FROM",
            "INSERT INTO",
            "INSERT INTO users VALUES",
            "UPDATE",
            "UPDATE users SET",
            "DELETE",
            "TRUNCATE",
            "WITH x AS SELECT 1",
            "CALL",
            "SHOW",
            "DESCRIBE",
        ].map((sql, i) => ({ name: `XNeg Gen: Malformed ${i + 1} [${sql.slice(0, 24)}]`, sql, isErrorExpected: true, check: r => r.error !== undefined })),

        // --- 生成テスト: 型違反マトリクス ---
        { name: "XNeg: Types Setup", sql: "CREATE TABLE nx_types (i INTEGER, f FLOAT, b BOOLEAN, d DATE)", check: r => r.data[0].Result === "Success" },
        ...[
            ["i", "'abc'"], ["i", "1.5"], ["i", "true"], ["i", "'1.5'"],
            ["f", "'xyz'"], ["f", "false"], ["f", "'1.2.3'"],
            ["b", "'yes'"], ["b", "2"], ["b", "'10'"],
            ["d", "'2026/01/01'"], ["d", "'not-a-date'"],
        ].map(([col, val], i) => ({
            name: `XNeg Gen: Type Mismatch ${i + 1} [${col} <- ${val}]`,
            sql: `INSERT INTO nx_types (${col}) VALUES (${val})`,
            isErrorExpected: true,
            check: r => r.error !== undefined && r.error.includes('Type mismatch')
        })),
        { name: "XNeg: Types No Rows Leaked", sql: "SELECT COUNT(*) AS c FROM nx_types", check: r => r.data[0].c === 0 },
        { name: "XNeg: Types Cleanup", sql: "DROP TABLE nx_types", check: r => r.data[0].Result === "Success" },

        // --- 生成テスト: 未知の識別子 ---
        ...[
            "SELECT zz_ghost FROM users",
            "SELECT * FROM users WHERE zz_ghost = 1",
            "SELECT * FROM users ORDER BY zz_ghost",
            "SELECT COUNT(*) AS c FROM users GROUP BY zz_ghost",
            "SELECT name FROM users WHERE UPPER(zz_ghost) = 'X'",
            "SELECT u.zz_ghost FROM users u",
            "UPDATE users SET zz_ghost = 1",
            "SELECT COUNT(*) AS c FROM users u JOIN orders o ON u.id = o.user_id AND o.zz_ghost = 1",
            "SELECT MAX(zz_ghost) AS m FROM users",
            "DELETE FROM users WHERE zz_ghost = 1",
        ].map((sql, i) => ({ name: `XNeg Gen: Unknown Identifier ${i + 1}`, sql, isErrorExpected: true, check: r => r.error !== undefined })),

        // ============================================================
        // 3. 境界値テスト (XBnd)
        // ============================================================
        { name: "XBnd: Setup Base", fn: () => {
            db.executeQuery("CREATE TABLE bx_t (id INTEGER, v INTEGER, s TEXT)");
            db.executeQuery("INSERT INTO bx_t (id, v, s) VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd'), (5, 50, 'e'), (6, null, 'f'), (7, 70, null)");
            db.executeQuery("CREATE TABLE bx_empty (id INTEGER, v INTEGER)");
            db.executeQuery("CREATE TABLE bx_one (id INTEGER, v INTEGER)");
            db.executeQuery("INSERT INTO bx_one (id, v) VALUES (1, 100)");
            return db.tables['bx_t'].rowCount === 7 && db.tables['bx_empty'].rowCount === 0 && db.tables['bx_one'].rowCount === 1;
        }},

        // --- LIMIT / OFFSET 境界 ---
        ...[
            [0, 0], [1, 0], [7, 0], [8, 0], [3, 3], [3, 4], [3, 5], [7, 6], [2, 7], [5, 8], [7, 7], [1, 6],
        ].map(([lim, off]) => {
            const exp = off >= 7 ? 0 : Math.min(lim, 7 - off);
            return {
                name: `XBnd Gen: Limit ${lim} Offset ${off}`,
                sql: `SELECT id FROM bx_t ORDER BY id ASC LIMIT ${lim} OFFSET ${off}`,
                check: r => exp === 0 ? r.data.length === 0 : (r.data.length === exp && r.data[0].id === off + 1)
            };
        }),
        { name: "XBnd: Offset Without Limit", sql: "SELECT id FROM bx_t ORDER BY id ASC OFFSET 3", check: r => r.data.length === 4 && r.data[0].id === 4 },
        { name: "XBnd: Limit Comma Zero Zero", sql: "SELECT id FROM bx_t LIMIT 0, 0", check: r => r.data.length === 0 },
        { name: "XBnd: Limit Comma Tail", sql: "SELECT id FROM bx_t ORDER BY id ASC LIMIT 5, 5", check: r => r.data.length === 2 && r.data[0].id === 6 },

        // --- 空テーブル境界 ---
        { name: "XBnd: Empty Aggregates", sql: "SELECT COUNT(*) AS c, COUNT(v) AS cv, SUM(v) AS s, AVG(v) AS a, MAX(v) AS mx, MIN(v) AS mn FROM bx_empty", check: r => r.data[0].c === 0 && r.data[0].cv === 0 && r.data[0].s === 0 && r.data[0].a === 0 && r.data[0].mx === null && r.data[0].mn === null },
        { name: "XBnd: Empty Statistical Aggregates", sql: "SELECT STDDEV(v) AS sd, VARIANCE(v) AS va, MEDIAN(v) AS md, GROUP_CONCAT(v) AS gc FROM bx_empty", check: r => r.data[0].sd === null && r.data[0].va === null && r.data[0].md === null && r.data[0].gc === null },
        { name: "XBnd: Empty Count Distinct", sql: "SELECT COUNT(DISTINCT v) AS c FROM bx_empty", check: r => r.data[0].c === 0 },
        { name: "XBnd: Empty Select Star", sql: "SELECT * FROM bx_empty", check: r => r.data.length === 0 },
        { name: "XBnd: Empty Distinct", sql: "SELECT DISTINCT v FROM bx_empty", check: r => r.data.length === 0 },
        { name: "XBnd: Empty Group By", sql: "SELECT v, COUNT(*) AS c FROM bx_empty GROUP BY v", check: r => r.data.length === 0 },
        { name: "XBnd: Empty Group By Having", sql: "SELECT v, COUNT(*) AS c FROM bx_empty GROUP BY v HAVING c > 0", check: r => r.data.length === 0 },
        { name: "XBnd: Empty Window", sql: "SELECT ROW_NUMBER() OVER(ORDER BY id ASC) AS rn FROM bx_empty", check: r => r.data.length === 0 },
        { name: "XBnd: Empty Order By Unknown Col Tolerated", sql: "SELECT v FROM bx_empty ORDER BY zz_ghost", check: r => r.error === undefined && r.data.length === 0 },
        { name: "XBnd: Inner Join From Empty", sql: "SELECT COUNT(*) AS c FROM bx_empty e JOIN bx_t t ON e.id = t.id", check: r => r.data[0].c === 0 },
        { name: "XBnd: Left Join To Empty", sql: "SELECT COUNT(*) AS total, COUNT(e.id) AS matched FROM bx_t t LEFT JOIN bx_empty e ON t.id = e.id", check: r => r.data[0].total === 7 && r.data[0].matched === 0 },
        { name: "XBnd: Right Join To Empty", sql: "SELECT COUNT(*) AS c FROM bx_t t RIGHT JOIN bx_empty e ON t.id = e.id", check: r => r.data[0].c === 0 },
        { name: "XBnd: Union Both Empty", sql: "SELECT id FROM bx_empty UNION SELECT id FROM bx_empty", check: r => r.error === undefined && r.data.length === 0 },
        { name: "XBnd: Union Empty With Data", sql: "SELECT id FROM bx_empty UNION SELECT id FROM bx_one", check: r => r.data.length === 1 && r.data[0].id === 1 },
        { name: "XBnd: Except Minus Empty", sql: "SELECT id FROM bx_t EXCEPT SELECT id FROM bx_empty", check: r => r.data.length === 7 },
        { name: "XBnd: Intersect With Empty", sql: "SELECT id FROM bx_t INTERSECT SELECT id FROM bx_empty", check: r => r.data.length === 0 },
        { name: "XBnd: Update Empty Table", sql: "UPDATE bx_empty SET v = 1", check: r => r.data[0].Message.includes('0 rows') },
        { name: "XBnd: Delete Empty Table", sql: "DELETE FROM bx_empty", check: r => r.data[0].Message.includes('0 rows') },

        // --- 1行テーブル境界 ---
        { name: "XBnd: Single Row Windows", sql: "SELECT LAG(v) OVER(ORDER BY id ASC) AS pv, LEAD(v) OVER(ORDER BY id ASC) AS nv, RANK() OVER(ORDER BY v ASC) AS rk, NTILE(5) OVER(ORDER BY id ASC) AS nt FROM bx_one", check: r => r.data.length === 1 && r.data[0].pv === null && r.data[0].nv === null && r.data[0].rk === 1 && r.data[0].nt === 1 },
        { name: "XBnd: Single Row First Last", sql: "SELECT FIRST_VALUE(v) OVER(ORDER BY id ASC) AS f, LAST_VALUE(v) OVER(ORDER BY id ASC) AS l FROM bx_one", check: r => r.data[0].f === 100 && r.data[0].l === 100 },
        { name: "XBnd: Single Row Stats", sql: "SELECT MEDIAN(v) AS md, STDDEV(v) AS sd, VARIANCE(v) AS va FROM bx_one", check: r => r.data[0].md === 100 && r.data[0].sd === 0 && r.data[0].va === 0 },

        // --- NULL 境界 ---
        { name: "XBnd: Equality With Null Literal", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v = null", check: r => r.data[0].c === 1 },
        { name: "XBnd: Inequality With Null Literal", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v <> null", check: r => r.data[0].c === 6 },
        { name: "XBnd: Null In List Matches", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v IN (null, 10)", check: r => r.data[0].c === 2 },
        { name: "XBnd: Null Not In List", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v NOT IN (null, 10)", check: r => r.data[0].c === 5 },
        { name: "XBnd: Null Sorts First Asc", sql: "SELECT id, v FROM bx_t ORDER BY v ASC", check: r => r.data[0].id === 6 },
        { name: "XBnd: Null Sorts Last Desc", sql: "SELECT id, v FROM bx_t ORDER BY v DESC", check: r => r.data[6].id === 6 },
        { name: "XBnd: Aggregates Skip Null", sql: "SELECT COUNT(v) AS c, SUM(v) AS s, AVG(v) AS a, MAX(v) AS mx, MIN(v) AS mn FROM bx_t", check: r => r.data[0].c === 6 && r.data[0].s === 220 && r.data[0].a === 36.67 && r.data[0].mx === 70 && r.data[0].mn === 10 },
        { name: "XBnd: Null Plus Number Is Number", sql: "SELECT v + 10 AS x FROM bx_t WHERE id = 6", check: r => r.data[0].x === 10 },
        { name: "XBnd: Concat Null Column", sql: "SELECT CONCAT(s, '-') AS x FROM bx_t WHERE id = 7", check: r => r.data[0].x === '-' },
        { name: "XBnd: Group By With Null Group", sql: "SELECT v, COUNT(*) AS c FROM bx_t GROUP BY v", check: r => r.data.length === 7 },
        { name: "XBnd: Coalesce Fallback Chain", sql: "SELECT COALESCE(v, id, -1) AS x FROM bx_t WHERE id = 6", check: r => r.data[0].x === 6 },

        // --- 数値境界 ---
        { name: "XBnd: Zero Equals Negative Zero", sql: "SELECT 0 = -0 AS v", check: r => r.data[0].v === true },
        { name: "XBnd: Float Precision Inequality", sql: "SELECT 0.1 + 0.2 = 0.3 AS v", check: r => r.data[0].v === false },
        { name: "XBnd: Float Epsilon Compare", sql: "SELECT ABS(0.1 + 0.2 - 0.3) < 0.0000001 AS v", check: r => r.data[0].v === true },
        { name: "XBnd: Types Setup", sql: "CREATE TABLE bx_types (i INTEGER, f FLOAT)", check: r => r.data[0].Result === "Success" },
        { name: "XBnd: Max Safe Integer Roundtrip", fn: () => {
            const r = db.executeQuery("INSERT INTO bx_types (i) VALUES (9007199254740991)");
            const v = db.executeQuery("SELECT COUNT(*) AS c FROM bx_types WHERE i = 9007199254740991");
            return !r.error && v.data[0].c === 1;
        }},
        { name: "XBnd: Leading Zero Integer String", fn: () => {
            const r = db.executeQuery("INSERT INTO bx_types (i) VALUES ('007')");
            const v = db.executeQuery("SELECT COUNT(*) AS c FROM bx_types WHERE i = 7");
            return !r.error && v.data[0].c === 1;
        }},
        { name: "XBnd: Float 1e308 And Negative", fn: () => {
            const r = db.executeQuery("INSERT INTO bx_types (f) VALUES (1e308), (-1e308)");
            const v = db.executeQuery("SELECT COUNT(*) AS c FROM bx_types WHERE f = 1e308 OR f = -1e308");
            return !r.error && v.data[0].c === 2;
        }},
        { name: "XBnd: Float Overflow To Infinity", fn: () => {
            const r = db.executeQuery("INSERT INTO bx_types (f) VALUES (1e309)");
            const v = db.executeQuery("SELECT f FROM bx_types WHERE f > 1e308");
            return !r.error && v.data.length === 1 && v.data[0].f === Infinity;
        }},
        { name: "XBnd: Integer Overflow Rejected", sql: "INSERT INTO bx_types (i) VALUES (1e309)", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Type mismatch') },
        { name: "XBnd: Empty String Into Integer Is Null", fn: () => {
            db.executeQuery("CREATE TABLE bx_e1 (i INTEGER)");
            const r = db.executeQuery("INSERT INTO bx_e1 (i) VALUES ('')");
            const v = db.executeQuery("SELECT COUNT(*) AS c FROM bx_e1 WHERE i IS NULL");
            db.executeQuery("DROP TABLE bx_e1");
            return !r.error && v.data[0].c === 1;
        }},
        { name: "XBnd: Types Cleanup", sql: "DROP TABLE bx_types", check: r => r.data[0].Result === "Success" },
        { name: "XBnd: Divide By Zero Infinity", sql: "SELECT 10 / 0 AS v", check: r => r.data[0].v === Infinity },
        { name: "XBnd: Negative Divide By Zero", sql: "SELECT -10 / 0 AS v", check: r => r.data[0].v === -Infinity },
        { name: "XBnd: Zero Divide Zero NaN", sql: "SELECT 0 / 0 AS v", check: r => typeof r.data[0].v === 'number' && isNaN(r.data[0].v) },
        { name: "XBnd: Mod By Zero NaN", sql: "SELECT MOD(10, 0) AS v", check: r => typeof r.data[0].v === 'number' && isNaN(r.data[0].v) },
        { name: "XBnd: Mod Negative Operands", sql: "SELECT MOD(-7, 3) AS a, MOD(7, -3) AS b", check: r => r.data[0].a === -1 && r.data[0].b === 1 },
        // v1.1: ROUND は MySQL 互換の「ゼロから遠い方向」丸めへ変更（JS Math.round の
        // 負数切り上げ挙動 ROUND(-2.5)=-2 は SQL として直感に反するため）
        { name: "XBnd: Round Half Values", sql: "SELECT ROUND(0.5) AS a, ROUND(-0.5) AS b, ROUND(2.5) AS c, ROUND(-2.5) AS d", check: r => r.data[0].a === 1 && r.data[0].b === -1 && r.data[0].c === 3 && r.data[0].d === -3 },
        { name: "XBnd: Ceil Floor Near Zero", sql: "SELECT CEIL(-0.1) AS a, FLOOR(-0.1) AS b", check: r => r.data[0].a === 0 && r.data[0].b === -1 },
        { name: "XBnd: Truncate Digits", sql: "SELECT TRUNCATE(3.999, 0) AS a, TRUNCATE(-3.999, 0) AS b, TRUNCATE(3.14159, 4) AS c", check: r => r.data[0].a === 3 && r.data[0].b === -3 && r.data[0].c === 3.1415 },

        // --- 数値式 生成テスト ---
        ...[
            ["ABS(-0)", 0], ["SIGN(0)", 0], ["SIGN(-5)", -1], ["POWER(2, 10)", 1024], ["POWER(2, -1)", 0.5],
            ["FLOOR(-1.5)", -2], ["CEIL(-1.5)", -1], ["MOD(10, 4)", 2], ["GREATEST(-1, -2, -3)", -1], ["LEAST(0, 5, -5)", -5],
        ].map(([expr, exp], i) => ({
            name: `XBnd Gen: Numeric Expr ${i + 1} [${expr}]`,
            sql: `SELECT ${expr} AS v`,
            check: r => r.data[0].v === exp
        })),

        // --- 文字列境界 ---
        { name: "XBnd: Strings Setup", sql: "CREATE TABLE bx_str (id INTEGER, s TEXT)", check: r => r.data[0].Result === "Success" },
        { name: "XBnd: Strings Insert", sql: "INSERT INTO bx_str (id, s) VALUES (1, 'It''s'), (2, 'a\\\\b'), (3, 'say \"hi\"'), (4, '  pad  '), (5, ''), (6, null), (7, 'a.b'), (8, 'axb'), (9, '10%'), (10, 'ABC'), (11, 'こんにちは'), (12, '😀👍')", check: r => r.data[0].Message.includes('12') },
        { name: "XBnd: Doubled Quote Roundtrip", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s = 'It''s'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Backslash Roundtrip", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s = 'a\\\\b'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Double Quote In Single", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s = 'say \"hi\"'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Whitespace Preserved", sql: "SELECT LENGTH(s) AS l, TRIM(s) AS t FROM bx_str WHERE id = 4", check: r => r.data[0].l === 7 && r.data[0].t === 'pad' },
        { name: "XBnd: Empty String Not Null", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s = ''", check: r => r.data[0].c === 1 },
        { name: "XBnd: Null String Is Null", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s IS NULL", check: r => r.data[0].c === 1 },
        { name: "XBnd: Length Empty String", sql: "SELECT LENGTH(s) AS l FROM bx_str WHERE id = 5", check: r => r.data[0].l === 0 },
        { name: "XBnd: Like Dot Is Literal", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s LIKE 'a.b'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Like Underscore Wildcard", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s LIKE '10_'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Like Case Insensitive", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s LIKE 'abc'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Regexp Case Sensitive", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s REGEXP '^abc$'", check: r => r.data[0].c === 0 },
        { name: "XBnd: Regexp Exact Match", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s REGEXP '^ABC$'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Japanese Length", sql: "SELECT LENGTH(s) AS l FROM bx_str WHERE id = 11", check: r => r.data[0].l === 5 },
        { name: "XBnd: Japanese Like Prefix", sql: "SELECT COUNT(*) AS c FROM bx_str WHERE s LIKE 'こん%'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Emoji Surrogate Length", sql: "SELECT LENGTH(s) AS l FROM bx_str WHERE id = 12", check: r => r.data[0].l === 4 },
        { name: "XBnd: Long String 5000 Roundtrip", fn: () => {
            const big = 'x'.repeat(5000);
            const r = db.executeQuery("INSERT INTO bx_str (id, s) VALUES (100, '" + big + "')");
            const v = db.executeQuery("SELECT LENGTH(s) AS l FROM bx_str WHERE id = 100");
            return !r.error && v.data[0].l === 5000;
        }},
        { name: "XBnd: Concat Numbers", sql: "SELECT CONCAT(1, 2) AS v", check: r => r.data[0].v === '12' },
        { name: "XBnd: Lpad No Truncate", sql: "SELECT LPAD('abcde', 3, '0') AS a, RPAD('abcde', 3, '-') AS b, LPAD('a', 5, 'xy') AS c", check: r => r.data[0].a === 'abcde' && r.data[0].b === 'abcde' && r.data[0].c === 'xyxya' },
        { name: "XBnd: Repeat Zero And Negative", sql: "SELECT REPEAT('ab', 0) AS a, REPEAT('ab', -1) AS b", check: r => r.data[0].a === '' && r.data[0].b === null },
        { name: "XBnd: Left Right Extremes", sql: "SELECT LEFT('abc', 0) AS a, RIGHT('abc', 0) AS b, LEFT('abc', 10) AS c, RIGHT('abc', 10) AS d", check: r => r.data[0].a === '' && r.data[0].b === '' && r.data[0].c === 'abc' && r.data[0].d === 'abc' },
        { name: "XBnd: Substring Index Beyond Parts", sql: "SELECT SUBSTRING_INDEX('a.b.c', '.', 10) AS a, SUBSTRING_INDEX('a.b.c', '.', -10) AS b", check: r => r.data[0].a === 'a.b.c' && r.data[0].b === 'a.b.c' },
        { name: "XBnd: Strings Cleanup", sql: "DROP TABLE bx_str", check: r => r.data[0].Result === "Success" },

        // --- SUBSTRING 生成テスト ---
        ...[
            [1, 1, 'a'], [1, 6, 'abcdef'], [1, 7, 'abcdef'], [0, 2, 'ab'], [2, 3, 'bcd'],
            [6, 1, 'f'], [7, 2, ''], [3, 0, ''], [4, 10, 'def'], [0, 0, ''],
        ].map(([st, len, exp], i) => ({
            name: `XBnd Gen: Substring(${st},${len})`,
            sql: `SELECT SUBSTRING('abcdef', ${st}, ${len}) AS v`,
            check: r => r.data[0].v === exp
        })),

        // --- 日付境界 ---
        { name: "XBnd: Date Setup", sql: "CREATE TABLE bx_date (id INTEGER, d DATE)", check: r => r.data[0].Result === "Success" },
        { name: "XBnd: Leap Day Accepted", sql: "INSERT INTO bx_date (id, d) VALUES (1, '2024-02-29')", check: r => r.data[0].Message.includes('1') },
        { name: "XBnd: Leap Day Stored Value", sql: "SELECT COUNT(*) AS c FROM bx_date WHERE d = '2024-02-29 00:00:00'", check: r => r.data[0].c === 1 },
        // JS の Date は非閏年の 2/29 を 3/1 へ繰り上げる（不正日付ではなく有効値として受理される）
        { name: "XBnd: Non-Leap Feb 29 Rolls To Mar 1", sql: "INSERT INTO bx_date (id, d) VALUES (2, '2023-02-29')", check: r => r.data[0].Message.includes('1 rows inserted') },
        { name: "XBnd: Non-Leap Feb 29 Stored As Mar 1", sql: "SELECT COUNT(*) AS c FROM bx_date WHERE d = '2023-03-01 00:00:00'", check: r => r.data[0].c === 1 },
        { name: "XBnd: Month 13 Rejected", sql: "INSERT INTO bx_date (id, d) VALUES (3, '2026-13-01')", isErrorExpected: true, check: r => r.error !== undefined && r.error.includes('Type mismatch') },
        { name: "XBnd: Min Max Year Accepted", sql: "INSERT INTO bx_date (id, d) VALUES (4, '0001-01-01'), (5, '9999-12-31')", check: r => r.data[0].Message.includes('2') },
        { name: "XBnd: DateTime With Seconds", sql: "INSERT INTO bx_date (id, d) VALUES (6, '2026-07-11 12:34:56')", check: r => r.data[0].Message.includes('1') },
        { name: "XBnd: DateTime Millis Accepted", sql: "INSERT INTO bx_date (id, d) VALUES (7, '2026-01-01 00:00:00.123')", check: r => r.data[0].Message.includes('1') },
        { name: "XBnd: Date Part Extraction", sql: "SELECT YEAR(d) AS y, MONTH(d) AS m, DAY(d) AS dy FROM bx_date WHERE id = 1", check: r => r.data[0].y === 2024 && r.data[0].m === 2 && r.data[0].dy === 29 },
        { name: "XBnd: Time Part Extraction", sql: "SELECT HOUR(d) AS h, MINUTE(d) AS mi, SECOND(d) AS se FROM bx_date WHERE id = 6", check: r => r.data[0].h === 12 && r.data[0].mi === 34 && r.data[0].se === 56 },
        { name: "XBnd: Date String Comparison", sql: "SELECT COUNT(*) AS c FROM bx_date WHERE d >= '2024-01-01'", check: r => r.data[0].c === 4 },
        { name: "XBnd: DateDiff Across Leap Day", sql: "SELECT DATEDIFF('2024-03-01', '2024-02-28') AS a, DATEDIFF('2023-03-01', '2023-02-28') AS b", check: r => r.data[0].a === 2 && r.data[0].b === 1 },
        { name: "XBnd: Date Cleanup", sql: "DROP TABLE bx_date", check: r => r.data[0].Result === "Success" },

        // --- BOOLEAN 境界 ---
        { name: "XBnd: Bool Setup", sql: "CREATE TABLE bx_bool (b BOOLEAN)", check: r => r.data[0].Result === "Success" },
        { name: "XBnd: Bool Accepted Forms", sql: "INSERT INTO bx_bool (b) VALUES (1), (0), ('true'), ('FALSE'), ('1'), ('0')", check: r => r.data[0].Message.includes('6') },
        { name: "XBnd: Bool True Count", sql: "SELECT COUNT(*) AS c FROM bx_bool WHERE b = true", check: r => r.data[0].c === 3 },
        { name: "XBnd: Bool False Count", sql: "SELECT COUNT(*) AS c FROM bx_bool WHERE b = false", check: r => r.data[0].c === 3 },
        { name: "XBnd: Bool Sort Order", sql: "SELECT b FROM bx_bool ORDER BY b ASC", check: r => r.data[0].b === false && r.data[5].b === true },
        { name: "XBnd: Bool Cleanup", sql: "DROP TABLE bx_bool", check: r => r.data[0].Result === "Success" },

        // --- 制約・その他境界 ---
        { name: "XBnd: Unique Allows Multiple Nulls", fn: () => {
            db.executeQuery("CREATE TABLE bx_uq (u TEXT UNIQUE)");
            const r = db.executeQuery("INSERT INTO bx_uq (u) VALUES (null), (null), (null)");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM bx_uq");
            db.executeQuery("DROP TABLE bx_uq");
            return !r.error && c.data[0].c === 3;
        }},
        { name: "XBnd: PK Zero And Negative", fn: () => {
            db.executeQuery("CREATE TABLE bx_pk (id INTEGER PRIMARY KEY)");
            const r1 = db.executeQuery("INSERT INTO bx_pk (id) VALUES (0), (-5)");
            const r2 = db.executeQuery("INSERT INTO bx_pk (id) VALUES (0)");
            db.executeQuery("DROP TABLE bx_pk");
            return !r1.error && r2.error !== undefined && r2.error.includes('PRIMARY KEY');
        }},
        { name: "XBnd: Auto Increment Reuses After Delete", fn: () => {
            db.executeQuery("CREATE TABLE bx_ai (id INTEGER PRIMARY KEY AUTO_INCREMENT, v TEXT)");
            db.executeQuery("INSERT INTO bx_ai (v) VALUES ('a'), ('b')");
            db.executeQuery("DELETE FROM bx_ai WHERE id = 2");
            db.executeQuery("INSERT INTO bx_ai (v) VALUES ('c')");
            const r = db.executeQuery("SELECT MAX(id) AS m, COUNT(*) AS c FROM bx_ai");
            const ok = r.data[0].m === 2 && r.data[0].c === 2;
            db.executeQuery("TRUNCATE TABLE bx_ai");
            db.executeQuery("INSERT INTO bx_ai (v) VALUES ('d')");
            const r2 = db.executeQuery("SELECT MAX(id) AS m FROM bx_ai");
            db.executeQuery("DROP TABLE bx_ai");
            return ok && r2.data[0].m === 1;
        }},
        { name: "XBnd: Default Null Applied", fn: () => {
            db.executeQuery("CREATE TABLE bx_dfn (id INTEGER, st TEXT DEFAULT null)");
            db.executeQuery("INSERT INTO bx_dfn (id) VALUES (1)");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM bx_dfn WHERE st IS NULL");
            db.executeQuery("DROP TABLE bx_dfn");
            return r.data[0].c === 1;
        }},
        { name: "XBnd: NotNull With Default And Empty String", fn: () => {
            db.executeQuery("CREATE TABLE bx_nnd (id INTEGER, st TEXT NOT NULL DEFAULT 'x')");
            const r1 = db.executeQuery("INSERT INTO bx_nnd (id) VALUES (1)");
            const r2 = db.executeQuery("INSERT INTO bx_nnd (id, st) VALUES (2, null)");
            const r3 = db.executeQuery("INSERT INTO bx_nnd (id, st) VALUES (3, '')");
            const v = db.executeQuery("SELECT st FROM bx_nnd WHERE id = 1");
            db.executeQuery("DROP TABLE bx_nnd");
            return !r1.error && r2.error !== undefined && !r3.error && v.data[0].st === 'x';
        }},
        { name: "XBnd: Self Referencing FK", fn: () => {
            db.executeQuery("CREATE TABLE bx_self (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES bx_self(id))");
            const r1 = db.executeQuery("INSERT INTO bx_self (id, pid) VALUES (1, null)");
            const r2 = db.executeQuery("INSERT INTO bx_self (id, pid) VALUES (2, 1)");
            const r3 = db.executeQuery("INSERT INTO bx_self (id, pid) VALUES (3, 99)");
            const d1 = db.executeQuery("DELETE FROM bx_self WHERE id = 1");
            const d2 = db.executeQuery("DELETE FROM bx_self WHERE id = 2");
            const d3 = db.executeQuery("DELETE FROM bx_self WHERE id = 1");
            db.executeQuery("DROP TABLE bx_self");
            return !r1.error && !r2.error && r3.error !== undefined && d1.error !== undefined && !d2.error && !d3.error;
        }},
        { name: "XBnd: Between Same Bounds", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v BETWEEN 30 AND 30", check: r => r.data[0].c === 1 },
        { name: "XBnd: Between Reversed Bounds", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v BETWEEN 50 AND 10", check: r => r.data[0].c === 0 },
        { name: "XBnd: In Duplicate List Values", sql: "SELECT COUNT(*) AS c FROM bx_t WHERE v IN (10, 10, 10)", check: r => r.data[0].c === 1 },
        { name: "XBnd: Distinct All Identical", fn: () => {
            db.executeQuery("CREATE TABLE bx_dup (v INTEGER)");
            db.executeQuery("INSERT INTO bx_dup (v) VALUES (5), (5), (5), (5)");
            const r = db.executeQuery("SELECT DISTINCT v FROM bx_dup");
            db.executeQuery("DROP TABLE bx_dup");
            return r.data.length === 1 && r.data[0].v === 5;
        }},
        { name: "XBnd: Lag Zero Offset Is Self", sql: "SELECT id, LAG(v, 0) OVER(ORDER BY id ASC) AS pv FROM bx_t WHERE id <= 3 ORDER BY id ASC", check: r => r.data[0].pv === 10 && r.data[1].pv === 20 && r.data[2].pv === 30 },
        { name: "XBnd: Lag Offset Beyond Partition", sql: "SELECT LAG(v, 99) OVER(ORDER BY id ASC) AS pv FROM bx_t WHERE id <= 3", check: r => r.data.every(d => d.pv === null) },
        { name: "XBnd: NTILE One Bucket", sql: "SELECT NTILE(1) OVER(ORDER BY id ASC) AS nt FROM bx_t", check: r => r.data.length === 7 && r.data.every(d => d.nt === 1) },

        // ============================================================
        // 4. パフォーマンステスト (XPerf) - 5万行規模
        // ============================================================
        { name: "XPerf: Bulk Insert 50k Rows", fn: () => {
            db.executeQuery("CREATE TABLE px_main (id INTEGER, grp INTEGER, val INTEGER, name TEXT)");
            const rows = [];
            for (let i = 1; i <= 50000; i++) rows.push([i, i % 100, i % 1000, 'nm_' + (i % 500)]);
            const start = performance.now();
            db.insertRows('px_main', ['id', 'grp', 'val', 'name'], rows);
            const elapsed = performance.now() - start;
            return elapsed < 4000 && db.tables['px_main'].rowCount === 50000;
        }},
        { name: "XPerf: Count 50k Fast", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main");
            return (performance.now() - start) < 1000 && r.data[0].c === 50000;
        }},
        { name: "XPerf: Full Scan Filter", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main WHERE val = 123");
            return (performance.now() - start) < 2000 && r.data[0].c === 50;
        }},
        { name: "XPerf: Create Index On 50k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("CREATE INDEX idx_px_val ON px_main (val)");
            return !r.error && (performance.now() - start) < 2000;
        }},
        { name: "XPerf: Explain Uses Index", sql: "EXPLAIN SELECT * FROM px_main WHERE val = 123", check: r => r.data[0].Operation === 'INDEX SCAN' },
        { name: "XPerf: Indexed Point Lookup", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main WHERE val = 123");
            return (performance.now() - start) < 500 && r.data[0].c === 50;
        }},
        { name: "XPerf: 200 Indexed Lookups", fn: () => {
            const start = performance.now();
            let total = 0;
            for (let i = 0; i < 200; i++) {
                const r = db.executeQuery(`SELECT COUNT(*) AS c FROM px_main WHERE val = ${i * 5 % 1000}`);
                total += r.data[0].c;
            }
            return (performance.now() - start) < 3000 && total === 200 * 50;
        }},
        { name: "XPerf: Group By 100 Groups", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT grp, COUNT(*) AS c, SUM(val) AS s FROM px_main GROUP BY grp");
            return (performance.now() - start) < 3000 && r.data.length === 100 && r.data[0].c === 500;
        }},
        { name: "XPerf: Order By Desc Limit", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT id FROM px_main ORDER BY id DESC LIMIT 10");
            return (performance.now() - start) < 3000 && r.data.length === 10 && r.data[0].id === 50000;
        }},
        { name: "XPerf: Distinct 500 Names", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT DISTINCT name FROM px_main");
            return (performance.now() - start) < 3000 && r.data.length === 500;
        }},
        { name: "XPerf: Like Prefix Scan", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main WHERE name LIKE 'nm_49%'");
            return (performance.now() - start) < 3000 && r.data[0].c === 1100;
        }},
        { name: "XPerf: Window RowNumber 20k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT id, ROW_NUMBER() OVER(PARTITION BY grp ORDER BY id ASC) AS rn FROM px_main WHERE id <= 20000");
            return (performance.now() - start) < 5000 && r.data.length === 20000;
        }},
        { name: "XPerf: Hash Join 50k x 100", fn: () => {
            db.executeQuery("CREATE TABLE px_dim (gid INTEGER, label TEXT)");
            const rows = [];
            for (let i = 0; i < 100; i++) rows.push([i, 'G' + i]);
            db.insertRows('px_dim', ['gid', 'label'], rows);
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main m JOIN px_dim d ON m.grp = d.gid");
            return (performance.now() - start) < 4000 && r.data[0].c === 50000;
        }},
        { name: "XPerf: Join Group Having", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT d.label, COUNT(*) AS c FROM px_main m JOIN px_dim d ON m.grp = d.gid GROUP BY d.label HAVING c > 0");
            return (performance.now() - start) < 5000 && r.data.length === 100;
        }},
        { name: "XPerf: Subquery IN Dim", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM px_main WHERE grp IN (SELECT gid FROM px_dim WHERE gid < 10)");
            return (performance.now() - start) < 3000 && r.data[0].c === 5000;
        }},
        { name: "XPerf: Large IN Literal List", fn: () => {
            const list = Array.from({length: 500}, (_, i) => i).join(', ');
            const start = performance.now();
            const r = db.executeQuery(`SELECT COUNT(*) AS c FROM px_main WHERE val IN (${list})`);
            return (performance.now() - start) < 3000 && r.data[0].c === 25000;
        }},
        { name: "XPerf: Union All 10k Plus 10k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT id FROM px_main WHERE id <= 10000 UNION ALL SELECT id FROM px_main WHERE id <= 10000");
            return (performance.now() - start) < 4000 && r.data.length === 20000;
        }},
        { name: "XPerf: Median Stddev 25k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT MEDIAN(val) AS md, STDDEV(val) AS sd FROM px_main WHERE id <= 25000");
            return (performance.now() - start) < 3000 && r.data[0].md !== null && r.data[0].sd !== null;
        }},
        { name: "XPerf: Group Concat 5k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT grp, GROUP_CONCAT(id) AS g FROM px_main WHERE id <= 5000 GROUP BY grp");
            return (performance.now() - start) < 3000 && r.data.length === 100;
        }},
        { name: "XPerf: CTAS From 50k Filtered", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("CREATE TABLE px_copy AS SELECT id, val FROM px_main WHERE id <= 10000");
            const ok = !r.error && db.tables['px_copy'].rowCount === 10000 && (performance.now() - start) < 4000;
            db.executeQuery("DROP TABLE px_copy");
            return ok;
        }},
        { name: "XPerf: Export Import Roundtrip 50k", fn: () => {
            const start = performance.now();
            const dump = db.exportForIDB();
            const eng2 = new DatabaseEngine();
            eng2.importFromIDB(dump);
            const elapsed = performance.now() - start;
            return elapsed < 6000 && eng2.tables['px_main'].rowCount === 50000;
        }},
        { name: "XPerf: ExportSQL 5k Rows", fn: () => {
            db.executeQuery("CREATE TABLE px_exp (id INTEGER, t TEXT)");
            const rows = [];
            for (let i = 1; i <= 5000; i++) rows.push([i, 'txt_' + i]);
            db.insertRows('px_exp', ['id', 't'], rows);
            const eng = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng.tables[t]);
            eng.tables['px_exp'] = db.tables['px_exp'];
            const start = performance.now();
            const sql = eng.exportSQL();
            const elapsed = performance.now() - start;
            const stmts = splitSqlStatements(sql);
            db.executeQuery("DROP TABLE px_exp");
            return elapsed < 3000 && stmts.length === 51 && sql.includes('txt_5000');
        }},
        { name: "XPerf: Generate Dummy Constrained 20k", fn: () => {
            db.executeQuery("CREATE TABLE px_gen (id INTEGER PRIMARY KEY AUTO_INCREMENT, nm TEXT NOT NULL, gid INTEGER, FOREIGN KEY (gid) REFERENCES px_dim(gid))");
            const start = performance.now();
            const n = db.generateDummyData('px_gen', 20000);
            const ok = n === 20000 && (performance.now() - start) < 5000 && db.tables['px_gen'].rowCount === 20000;
            db.executeQuery("DROP TABLE px_gen");
            return ok;
        }},
        { name: "XPerf: Update All 50k Rows", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("UPDATE px_main SET val = val + 1");
            return (performance.now() - start) < 5000 && r.data[0].Message.includes('50000');
        }},
        { name: "XPerf: Tx Bulk Update Rollback", fn: () => {
            const before = db.executeQuery("SELECT val FROM px_main WHERE id = 1").data[0].val;
            const start = performance.now();
            db.executeQuery("BEGIN");
            db.executeQuery("UPDATE px_main SET val = 0 WHERE id <= 25000");
            db.executeQuery("ROLLBACK");
            const elapsed = performance.now() - start;
            const after = db.executeQuery("SELECT val FROM px_main WHERE id = 1").data[0].val;
            return elapsed < 6000 && before === after;
        }},
        { name: "XPerf: Delete Half 50k", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("DELETE FROM px_main WHERE id > 25000");
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM px_main");
            return (performance.now() - start) < 4000 && r.data[0].Message.includes('25000') && c.data[0].c === 25000;
        }},
        { name: "XPerf: Vacuum After Bulk Delete", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("VACUUM");
            return !r.error && (performance.now() - start) < 3000 && db.tables['px_main'].capacity <= 25000 + 1024;
        }},
        { name: "XPerf: Replace Into Bulk Conflicts", fn: () => {
            db.executeQuery("CREATE TABLE px_rep (id INTEGER PRIMARY KEY, v INTEGER)");
            const rows = [];
            for (let i = 1; i <= 10000; i++) rows.push([i, i]);
            db.insertRows('px_rep', ['id', 'v'], rows);
            const vals = [];
            for (let i = 9001; i <= 11000; i++) vals.push(`(${i}, ${i * 2})`);
            const start = performance.now();
            const r = db.executeQuery(`REPLACE INTO px_rep (id, v) VALUES ${vals.join(', ')}`);
            const elapsed = performance.now() - start;
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM px_rep");
            const ok = !r.error && elapsed < 3000 && c.data[0].c === 11000;
            db.executeQuery("DROP TABLE px_rep");
            return ok;
        }},
        { name: "XPerf: Insert Ignore Bulk Dups", fn: () => {
            db.executeQuery("CREATE TABLE px_ign (id INTEGER PRIMARY KEY)");
            const rows = [];
            for (let i = 1; i <= 5000; i++) rows.push([i]);
            db.insertRows('px_ign', ['id'], rows);
            const vals = [];
            for (let i = 4001; i <= 6000; i++) vals.push(`(${i})`);
            const start = performance.now();
            const r = db.executeQuery(`INSERT IGNORE INTO px_ign (id) VALUES ${vals.join(', ')}`);
            const elapsed = performance.now() - start;
            const c = db.executeQuery("SELECT COUNT(*) AS c FROM px_ign");
            const ok = !r.error && elapsed < 3000 && c.data[0].c === 6000 && r.data[0].Message.includes('1000 ignored');
            db.executeQuery("DROP TABLE px_ign");
            return ok;
        }},
        { name: "XPerf: 500 Tiny Queries Loop", fn: () => {
            const start = performance.now();
            let sum = 0;
            for (let i = 0; i < 500; i++) {
                const r = db.executeQuery(`SELECT ${i} + 1 AS v`);
                sum += r.data[0].v;
            }
            return (performance.now() - start) < 3000 && sum === (500 * 501) / 2;
        }},
        { name: "XPerf: Explain Plan Only Fast", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("EXPLAIN SELECT m.id, d.label FROM px_main m JOIN px_dim d ON m.grp = d.gid WHERE m.val > 500 ORDER BY m.id LIMIT 10");
            return !r.error && (performance.now() - start) < 500 && r.data.length >= 3;
        }},
        { name: "XPerf: Cleanup", fn: () => {
            db.executeQuery("DROP TABLE px_main");
            db.executeQuery("DROP TABLE px_dim");
            return !db.tables['px_main'] && !db.tables['px_dim'];
        }},

        // ============================================================
        // 5. セキュリティテスト (XSec)
        // ============================================================
        // --- 式コンパイルのコード注入防御 ---
        { name: "XSec: Template Literal In String Inert", sql: "SELECT 'a${window.__sp=1}b' AS v", check: r => r.data[0].v === 'a${window.__sp=1}b' && window.__sp === undefined },
        { name: "XSec: Backtick In String Inert", sql: "SELECT '`whoami`' AS v", check: r => r.data[0].v === '`whoami`' },
        { name: "XSec: window Not Resolvable", sql: "SELECT window FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XSec: document Not Resolvable", sql: "SELECT document FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XSec: eval Not Resolvable", sql: "SELECT eval FROM users", isErrorExpected: true, check: r => r.error !== undefined },
        { name: "XSec: alert Call Not Executable", fn: () => {
            const r = db.executeQuery("SELECT * FROM users WHERE alert(1)");
            return r.error !== undefined;
        }},
        ...[
            "SELECT `id` FROM users",
            "SELECT * FROM users WHERE name = `whoami`",
            "UPDATE users SET age = `29` WHERE id = 1",
            "SELECT ${window.__e1=1} AS v",
            "SELECT * FROM users WHERE age = ${window.__e2=1}",
            "SELECT id FROM users GROUP BY ${window.__e3=1}",
        ].map((sql, i) => ({ name: `XSec Gen: Code Injection Blocked ${i + 1}`, sql, isErrorExpected: true, check: r => r.error !== undefined })),
        { name: "XSec: No Globals Polluted By Injections", fn: () => {
            return window.__e1 === undefined && window.__e2 === undefined && window.__e3 === undefined
                && db.executeQuery("SELECT age FROM users WHERE id = 1").data[0].age === 25;
        }},

        // --- SQLインジェクション（パラメータバインド） ---
        { name: "XSec: Inj Setup", sql: "CREATE TABLE sx_inj (id INTEGER, txt TEXT)", check: r => r.data[0].Result === "Success" },
        ...[
            "'; DROP TABLE users; --",
            "1' OR '1'='1",
            "\"; DROP TABLE users; --",
            "a\\'; window.__inj=1 //",
            "%_%",
            "__proto__",
            "constructor.prototype.polluted",
            "南'; SELECT 'x",
        ].map((p, i) => ({ name: `XSec Gen: Param Injection Safe ${i + 1}`, fn: () => {
            const ins = window.LuminaDB.query("INSERT INTO sx_inj (id, txt) VALUES (?, ?)", [i, p]);
            const sel = window.LuminaDB.query("SELECT COUNT(*) AS c FROM sx_inj WHERE txt = ?", [p]);
            const usersOk = db.executeQuery("SELECT COUNT(*) AS c FROM users").data[0].c === 10;
            const stored = db.tables['sx_inj'].getValue('txt', i) === p;
            return !ins.error && !sel.error && sel.data[0].c === 1 && usersOk && stored && window.__inj === undefined;
        }})),
        { name: "XSec: Inj Cleanup", sql: "DROP TABLE sx_inj", check: r => r.data[0].Result === "Success" },
        { name: "XSec: Numeric Injection Stays String", fn: () => {
            const r = window.LuminaDB.query("SELECT * FROM users WHERE id = ?", ['1 OR 1=1']);
            return !r.error && r.data.length === 0;
        }},
        { name: "XSec: Union Injection Via Param Inert", fn: () => {
            const r = window.LuminaDB.query("SELECT * FROM users WHERE name = ?", ["x' UNION SELECT id FROM users --"]);
            return !r.error && r.data.length === 0;
        }},
        { name: "XSec: Param NaN Rejected", fn: () => {
            const r = window.LuminaDB.query("SELECT ? AS v", [NaN]);
            return r.error !== undefined;
        }},
        { name: "XSec: Param Infinity Rejected", fn: () => {
            const r = window.LuminaDB.query("SELECT ? AS v", [Infinity]);
            return r.error !== undefined;
        }},
        { name: "XSec: Param Null And Undefined", fn: () => {
            const r1 = window.LuminaDB.query("SELECT ? AS v", [null]);
            const r2 = window.LuminaDB.query("SELECT ? AS v", [undefined]);
            return !r1.error && r1.data[0].v === null && !r2.error && r2.data[0].v === null;
        }},
        { name: "XSec: Param Boolean", fn: () => {
            const r = window.LuminaDB.query("SELECT ? AS v", [true]);
            return !r.error && r.data[0].v === true;
        }},
        { name: "XSec: Param Date Binding", fn: () => {
            db.executeQuery("CREATE TABLE sx_d (d DATE)");
            const ins = window.LuminaDB.query("INSERT INTO sx_d (d) VALUES (?)", [new Date(Date.UTC(2026, 5, 15, 12, 0, 0))]);
            const r = db.executeQuery("SELECT YEAR(d) AS y, MONTH(d) AS m FROM sx_d");
            db.executeQuery("DROP TABLE sx_d");
            return !ins.error && r.data[0].y === 2026 && r.data[0].m === 6;
        }},
        { name: "XSec: Question Mark In Literal Not Placeholder", fn: () => {
            const r1 = window.LuminaDB.query("SELECT '?' AS v");
            const r2 = window.LuminaDB.query("SELECT '?' AS v", ['x']);
            return !r1.error && r1.data[0].v === '?' && r2.error !== undefined;
        }},

        // --- XSS（結果描画のエスケープ） ---
        ...[
            ['<script>window.__xa0=1<\/script>', '__xa0'],
            ['<img src=x onerror=window.__xa1=1>', '__xa1'],
            ['<svg onload=window.__xa2=1>', '__xa2'],
            ['"><iframe src="javascript:window.__xa3=1"></iframe>', '__xa3'],
            ['<a href="javascript:window.__xa4=1">link</a>', '__xa4'],
            ['<div onclick=window.__xa5=1>x</div>', '__xa5'],
            ['<style>#resultsArea{display:none}</style>', '__xa6'],
            ['<input autofocus onfocus=window.__xa7=1>', '__xa7'],
        ].map(([payload, flag], i) => ({ name: `XSec Gen: XSS Cell Escaped ${i + 1}`, fn: () => {
            const bku = currentResultData;
            currentResultData = [{ p: payload }];
            renderDisplay(true);
            const cell = els.resArea.querySelector('#resultsTbody td');
            const ok = cell && cell.children.length === 0 && cell.textContent === payload && window[flag] === undefined;
            currentResultData = bku;
            renderDisplay(true);
            return !!ok;
        }})),
        { name: "XSec: Error Message Svg Escaped", fn: () => {
            db.executeQuery("CREATE TABLE sx_xt (i INTEGER)");
            els.query.value = "INSERT INTO sx_xt (i) VALUES ('<svg onload=window.__xsvg=1>')";
            document.getElementById('executeBtn').click();
            const noEl = !els.resArea.querySelector('svg');
            const escaped = els.resArea.innerHTML.includes('&lt;svg');
            db.executeQuery("DROP TABLE sx_xt");
            return noEl && escaped && window.__xsvg === undefined;
        }},
        { name: "XSec: Header Attribute Breakout Escaped", fn: () => {
            const bku = currentResultData;
            currentResultData = [{ 'x" onmouseover="window.__xh=1': 1 }];
            renderDisplay(true);
            const th = els.resArea.querySelector('th[data-col]');
            const ok = th && !th.hasAttribute('onmouseover') && th.getAttribute('data-col') === 'x" onmouseover="window.__xh=1';
            currentResultData = bku;
            renderDisplay(true);
            return !!ok && window.__xh === undefined;
        }},

        // --- プロトタイプ汚染 ---
        { name: "XSec: Group By Hostile Values Safe", fn: () => {
            db.executeQuery("CREATE TABLE sx_g (k TEXT)");
            db.executeQuery("INSERT INTO sx_g (k) VALUES ('__proto__'), ('constructor'), ('x'), ('__proto__')");
            const r = db.executeQuery("SELECT k, COUNT(*) AS c FROM sx_g GROUP BY k ORDER BY k ASC");
            db.executeQuery("DROP TABLE sx_g");
            return !r.error && r.data.length === 3 && r.data.find(d => d.k === '__proto__').c === 2
                && Object.prototype.polluted === undefined && ({}).polluted === undefined;
        }},
        { name: "XSec: Partition By Hostile Values Safe", fn: () => {
            db.executeQuery("CREATE TABLE sx_w (k TEXT, v INTEGER)");
            db.executeQuery("INSERT INTO sx_w (k, v) VALUES ('__proto__', 1), ('__proto__', 2), ('z', 3)");
            const r = db.executeQuery("SELECT k, v, ROW_NUMBER() OVER(PARTITION BY k ORDER BY v ASC) AS rn FROM sx_w");
            db.executeQuery("DROP TABLE sx_w");
            return !r.error && r.data[0].rn === 1 && r.data[1].rn === 2 && r.data[2].rn === 1 && ({}).rn === undefined;
        }},
        { name: "XSec: Table Named prototype Isolated", fn: () => {
            const r1 = db.executeQuery("CREATE TABLE prototype (id INTEGER)");
            const ins = db.executeQuery("INSERT INTO prototype (id) VALUES (7)");
            const sel = db.executeQuery("SELECT id FROM prototype");
            const dr = db.executeQuery("DROP TABLE prototype");
            return !r1.error && !ins.error && sel.data[0].id === 7 && !dr.error && Object.keys({}).length === 0 && ({}).id === undefined;
        }},
        { name: "XSec: Table Named hasOwnProperty Isolated", fn: () => {
            const r1 = db.executeQuery("CREATE TABLE hasownproperty (id INTEGER)");
            const ins = db.executeQuery("INSERT INTO hasownproperty (id) VALUES (1)");
            const sel = db.executeQuery("SELECT COUNT(*) AS c FROM hasownproperty");
            const dr = db.executeQuery("DROP TABLE hasownproperty");
            return !r1.error && !ins.error && sel.data[0].c === 1 && !dr.error && typeof ({}).hasOwnProperty === 'function';
        }},
        { name: "XSec: Column Named __proto__ Engine Level", fn: () => {
            db.executeQuery("CREATE TABLE sx_pc (__proto__ TEXT)");
            const ins = db.executeQuery("INSERT INTO sx_pc (__proto__) VALUES ('safe')");
            const t = db.tables['sx_pc'];
            const vOk = t && t.getValue('__proto__', 0) === 'safe';
            db.executeQuery("DROP TABLE sx_pc");
            return !ins.error && vOk && Object.prototype.polluted === undefined && ({}).safe === undefined;
        }},
        { name: "XSec: Hostile Value Where Comparison", fn: () => {
            db.executeQuery("CREATE TABLE sx_hv (v TEXT)");
            db.executeQuery("INSERT INTO sx_hv (v) VALUES ('constructor.prototype.polluted')");
            const r = window.LuminaDB.query("SELECT COUNT(*) AS c FROM sx_hv WHERE v = ?", ['constructor.prototype.polluted']);
            db.executeQuery("DROP TABLE sx_hv");
            return !r.error && r.data[0].c === 1 && Object.prototype.polluted === undefined;
        }},

        // --- DoS ガード境界 ---
        { name: "XSec: Query Length Exactly At Cap OK", fn: () => {
            const base = "SELECT 1 AS v";
            const q = base + " ".repeat(1000000 - base.length);
            const r = db.executeQuery(q);
            return q.length === 1000000 && !r.error && r.data[0].v === 1;
        }},
        { name: "XSec: Query Length Over Cap Rejected", fn: () => {
            const base = "SELECT 1 AS v";
            const q = base + " ".repeat(1000001 - base.length);
            const r = db.executeQuery(q);
            return q.length === 1000001 && r.error !== undefined && r.error.includes('too long');
        }},
        { name: "XSec: Regexp Exactly 1000 OK", fn: () => {
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE name REGEXP '" + "a".repeat(1000) + "'");
            return !r.error && r.data[0].c === 0;
        }},
        { name: "XSec: Regexp 1001 Rejected", fn: () => {
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE name REGEXP '" + "a".repeat(1001) + "'");
            return r.error !== undefined && r.error.includes('too long');
        }},
        { name: "XSec: Nested Subqueries 100 OK", fn: () => {
            let q = "SELECT 1 AS v";
            for (let i = 0; i < 100; i++) q = "SELECT 1 AS v WHERE EXISTS (" + q + ")";
            const r = db.executeQuery(q);
            return !r.error && r.data[0].v === 1;
        }},
        { name: "XSec: Nested Subqueries 101 Rejected", fn: () => {
            let q = "SELECT 1 AS v";
            for (let i = 0; i < 101; i++) q = "SELECT 1 AS v WHERE EXISTS (" + q + ")";
            const r = db.executeQuery(q);
            return r.error !== undefined && r.error.includes('Too many subqueries');
        }},
        { name: "XSec: Procedure Recursion Depth Limited", fn: () => {
            db.executeQuery("CREATE PROCEDURE sx_rec AS CALL sx_rec");
            const r = db.executeQuery("CALL sx_rec");
            db.executeQuery("DROP PROCEDURE sx_rec");
            return r.error !== undefined && r.error.includes('depth');
        }},
        { name: "XSec: Procedure Chain 3 Levels OK", fn: () => {
            db.executeQuery("CREATE PROCEDURE sx_pa AS SELECT 1 AS v");
            db.executeQuery("CREATE PROCEDURE sx_pb AS CALL sx_pa");
            db.executeQuery("CREATE PROCEDURE sx_pc2 AS CALL sx_pb");
            const r = db.executeQuery("CALL sx_pc2");
            db.executeQuery("DROP PROCEDURE sx_pc2");
            db.executeQuery("DROP PROCEDURE sx_pb");
            db.executeQuery("DROP PROCEDURE sx_pa");
            return !r.error && r.data[0].v === 1;
        }},
        { name: "XSec: Like ReDoS Pattern Fast", fn: () => {
            const start = performance.now();
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE name LIKE '((((((((((a+)+)+)+)+)+)+)+)+)+$'");
            return !r.error && r.data[0].c === 0 && (performance.now() - start) < 500;
        }},
        { name: "XSec: Invalid Regexp No Crash", fn: () => {
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM users WHERE name REGEXP '((('");
            return !r.error && r.data[0].c === 0;
        }},

        // --- 外部API・postMessage 防御 ---
        { name: "XSec: External DDL Blocked During Tx", fn: () => {
            db.executeQuery("BEGIN");
            const w = window.LuminaDB.query("CREATE TABLE sx_ddl (id INTEGER)");
            db.executeQuery("ROLLBACK");
            const blocked = w.error !== undefined && w.error.includes('Transaction in progress');
            const notCreated = !db.tables['sx_ddl'];
            return blocked && notCreated;
        }},
        { name: "XSec: External Explain Allowed During Tx", fn: () => {
            db.executeQuery("BEGIN");
            const r = window.LuminaDB.query("EXPLAIN SELECT * FROM users");
            db.executeQuery("ROLLBACK");
            return !r.error && r.data.length > 0;
        }},
        { name: "XSec: postMessage Wrong Type Ignored", fn: () => {
            let called = false;
            const orig = window.LuminaDB.query;
            window.LuminaDB.query = function (...a) { called = true; return orig.apply(window.LuminaDB, a); };
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'other:query', sql: 'SELECT 1 AS x' },
                origin: window.location.origin
            }));
            window.LuminaDB.query = orig;
            return called === false;
        }},
        { name: "XSec: postMessage Non-String SQL Ignored", fn: () => {
            let called = false;
            const orig = window.LuminaDB.query;
            window.LuminaDB.query = function (...a) { called = true; return orig.apply(window.LuminaDB, a); };
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'luminadb:query', sql: 12345 },
                origin: window.location.origin
            }));
            window.LuminaDB.query = orig;
            return called === false;
        }},
        { name: "XSec: Fetch Missing SQL 400", fn: async () => {
            const res = await fetch('lumina://query');
            const j = await res.json();
            return res.status === 400 && j.error !== undefined;
        }},
        { name: "XSec: Fetch Malformed JSON 500", fn: async () => {
            const res = await fetch('lumina://query', { method: 'POST', body: '{bad json' });
            return res.status === 500;
        }},
        { name: "XSec: Fetch Api Path Variant", fn: async () => {
            const res = await fetch('/api/lumina/query?sql=' + encodeURIComponent('SELECT 1 AS v'));
            const j = await res.json();
            return res.status === 200 && j.data[0].v === 1;
        }},
        { name: "XSec: Fetch Api Export Endpoint", fn: async () => {
            const res = await fetch('/api/lumina/export');
            const j = await res.json();
            return res.status === 200 && typeof j.sql === 'string' && j.sql.includes('CREATE TABLE users');
        }},
        { name: "XSec: Fetch Api Unknown Path 404", fn: async () => {
            const res = await fetch('/api/lumina/bogus');
            return res.status === 404;
        }},
        { name: "XSec: Allowed Origins Contains Own", fn: () => {
            return Array.isArray(window.LuminaDB.allowedOrigins) && window.LuminaDB.allowedOrigins.includes(window.location.origin);
        }},
        { name: "XSec: ExportSQL Hostile Content Roundtrip", fn: () => {
            const eng = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng.tables[t]);
            eng.executeQuery("CREATE TABLE sx_rt (id INTEGER, s TEXT)");
            const ins = eng.executeQuery("INSERT INTO sx_rt (id, s) VALUES (1, '<script>alert(''x'')</script>'), (2, 'a\\\\b; DROP TABLE users; --'), (3, '日本語 ''引用'' テスト')");
            if (ins.error) return false;
            const dump = eng.exportSQL();
            const eng2 = new DatabaseEngine();
            ['users', 'products', 'orders'].forEach(t => delete eng2.tables[t]);
            for (const stmt of splitSqlStatements(dump)) {
                const r = eng2.executeQuery(stmt);
                if (r.error) return false;
            }
            const v1 = eng2.executeQuery("SELECT s FROM sx_rt WHERE id = 1").data[0].s;
            const v2 = eng2.executeQuery("SELECT s FROM sx_rt WHERE id = 2").data[0].s;
            const v3 = eng2.executeQuery("SELECT s FROM sx_rt WHERE id = 3").data[0].s;
            const noUsers = !eng2.tables['users'];
            return v1 === "<script>alert('x')</script>" && v2 === "a\\b; DROP TABLE users; --" && v3 === "日本語 '引用' テスト" && noUsers;
        }},

        // --- escapeHtml 単体 ---
        ...[
            ['<', '&lt;'], ['>', '&gt;'], ['&', '&amp;'], ['"', '&quot;'], ["'", '&#39;'],
        ].map(([inp, out], i) => ({ name: `XSec Gen: escapeHtml ${i + 1}`, fn: () => escapeHtml(inp) === out })),
        { name: "XSec: escapeHtml Composite", fn: () => escapeHtml('<script>"a"&\'b\'</script>') === '&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;' },

        // ============================================================
        // 追加テストで検出したエンジンバグの回帰テスト (XFix)
        //   Bug1: 文字列リテラル中の '$' が String.replace の特殊置換パターンとして
        //         誤解釈され、比較/LIKE/REGEXP/INSERT値が壊れる
        //   Bug2: 単独の大文字 NULL リテラルが列名として解決され失敗する
        //         （null パラメータバインドが 'NULL' を埋め込むため顕在化）
        // ============================================================
        { name: "XFix: Dollar In String Equality", fn: () => {
            db.executeQuery("CREATE TABLE xf_d (s TEXT)");
            db.executeQuery("INSERT INTO xf_d (s) VALUES ('100$'), ('$var'), ('a$b$c')");
            const r1 = db.executeQuery("SELECT COUNT(*) AS c FROM xf_d WHERE s = '100$'");
            const r2 = db.executeQuery("SELECT COUNT(*) AS c FROM xf_d WHERE s = '$var'");
            const stored = db.tables['xf_d'].getValue('s', 0);
            db.executeQuery("DROP TABLE xf_d");
            return !r1.error && r1.data[0].c === 1 && !r2.error && r2.data[0].c === 1 && stored === '100$';
        }},
        { name: "XFix: Dollar In Like Literal", sql: "SELECT COUNT(*) AS c FROM users WHERE name LIKE 'A$'", check: r => r.error === undefined && r.data[0].c === 0 },
        { name: "XFix: Dollar In Regexp Anchor", sql: "SELECT COUNT(*) AS c FROM users WHERE name REGEXP '^Alice$'", check: r => r.error === undefined && r.data[0].c === 1 },
        { name: "XFix: Dollar Ampersand Digit In Regexp", sql: "SELECT COUNT(*) AS c FROM users WHERE name REGEXP 'e$&$1'", check: r => r.error === undefined && r.data[0].c === 0 },
        { name: "XFix: Dollar Insert Roundtrip Via Param", fn: () => {
            db.executeQuery("CREATE TABLE xf_r (id INTEGER, s TEXT)");
            const ins = window.LuminaDB.query("INSERT INTO xf_r (id, s) VALUES (?, ?)", [1, 'price=$5&x$']);
            const sel = window.LuminaDB.query("SELECT s FROM xf_r WHERE id = ?", [1]);
            const stored = db.tables['xf_r'].getValue('s', 0);
            db.executeQuery("DROP TABLE xf_r");
            return !ins.error && stored === 'price=$5&x$' && sel.data[0].s === 'price=$5&x$';
        }},
        { name: "XFix: Dollar Value In Subquery IN", fn: () => {
            db.executeQuery("CREATE TABLE xf_sq (s TEXT)");
            db.executeQuery("INSERT INTO xf_sq (s) VALUES ('x$'), ('y')");
            const r = db.executeQuery("SELECT COUNT(*) AS c FROM xf_sq WHERE s IN (SELECT s FROM xf_sq WHERE s = 'x$')");
            db.executeQuery("DROP TABLE xf_sq");
            return !r.error && r.data[0].c === 1;
        }},
        { name: "XFix: Uppercase NULL Literal Select", sql: "SELECT NULL AS v", check: r => r.data.length === 1 && r.data[0].v === null },
        { name: "XFix: Mixed Case Null In Coalesce", sql: "SELECT COALESCE(NULL, Null, 'x') AS v", check: r => r.data[0].v === 'x' },
        { name: "XFix: NULL Literal In Case", sql: "SELECT CASE WHEN 1 = 2 THEN 'a' ELSE NULL END AS v", check: r => r.data[0].v === null },
        { name: "XFix: Null Param Binding", fn: () => {
            const r1 = window.LuminaDB.query("SELECT ? AS v", [null]);
            const r2 = window.LuminaDB.query("SELECT ? AS v", [undefined]);
            return !r1.error && r1.data[0].v === null && !r2.error && r2.data[0].v === null;
        }},
        { name: "XFix: NULLIF Still Works After NULL Norm", sql: "SELECT NULLIF(5, 5) AS a, NULLIF(5, 3) AS b, IFNULL(NULL, 'x') AS c", check: r => r.data[0].a === null && r.data[0].b === 5 && r.data[0].c === 'x' },

        // ============================================================
        // 追加テスト群のクリーンアップ / 後始末検証
        // ============================================================
        { name: "XClean: Drop Complex Tables", fn: () => {
            db.executeQuery("DROP TABLE cq_sale");
            db.executeQuery("DROP TABLE cq_emp");
            db.executeQuery("DROP TABLE cq_dept");
            db.executeQuery("DROP TABLE bx_t");
            db.executeQuery("DROP TABLE bx_empty");
            db.executeQuery("DROP TABLE bx_one");
            return !db.tables['cq_emp'] && !db.tables['bx_t'];
        }},
        { name: "XClean: No Leftover Extra Tables", fn: () => {
            const pat = /^(cq|nx|bx|px|sx)_/;
            Object.keys(db.tables).filter(t => pat.test(t)).forEach(t => db.executeQuery(`DROP TABLE ${t}`));
            Object.keys(db.views).filter(v => pat.test(v)).forEach(v => db.executeQuery(`DROP VIEW ${v}`));
            Object.keys(db.procedures).filter(p => pat.test(p)).forEach(p => db.executeQuery(`DROP PROCEDURE ${p}`));
            return !Object.keys(db.tables).some(t => pat.test(t))
                && !Object.keys(db.views).some(v => pat.test(v))
                && !Object.keys(db.procedures).some(p => pat.test(p));
        }},
        { name: "XClean: No Open Transaction", fn: () => db.inTransaction === false },
        { name: "XClean: Default Tables Intact", sql: "SELECT COUNT(*) AS c FROM users", check: r => r.data[0].c === 10 },
      ];
    }
