    // ============================================================================
    // [Test Suite v17] - v1.14 で追加した SQL コマンド / ブラウザDB運用機能の回帰テスト
    //
    //   test-suite.js の tests 配列へ getV17Tests() のスプレッドで合流する
    // ============================================================================
    function getV17Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });

      // ------------------------------------------------------------
      // 0. 専用フィクスチャ
      // ------------------------------------------------------------
      push('V17Fx create emp', "CREATE TABLE v17_emp (id INTEGER PRIMARY KEY, name TEXT, dept TEXT, salary INTEGER, mgr INTEGER)", r => r.data[0].Result === 'Success');
      push('V17Fx insert emp', "INSERT INTO v17_emp VALUES (1,'Ann','ENG',500,NULL),(2,'Bob','ENG',400,1),(3,'Cid','SALES',300,1),(4,'Dee','SALES',300,3),(5,'Eve','HR',200,1)", r => r.data[0].Result === 'Success');
      push('V17Fx create dept', "CREATE TABLE v17_dept (code TEXT, label TEXT, budget INTEGER)", r => r.data[0].Result === 'Success');
      push('V17Fx insert dept', "INSERT INTO v17_dept VALUES ('ENG','Engineering',1000),('SALES','Sales',700),('OPS','Operations',400),('HR','HumanRes',400)", r => r.data[0].Result === 'Success');

      // ------------------------------------------------------------
      // 1. '||' 連結演算子（SQL標準。NULL は伝播する）
      // ------------------------------------------------------------
      push('V17Cat literals', "SELECT 'a' || 'b' || 'c' AS x", r => r.data[0].x === 'abc');
      push('V17Cat column', "SELECT name || '/' || dept AS x FROM v17_emp WHERE id = 1", r => r.data[0].x === 'Ann/ENG');
      push('V17Cat number coerce', "SELECT 1 || 2 AS x", r => r.data[0].x === '12');
      push('V17Cat null propagates', "SELECT 'a' || NULL AS x", r => r.data[0].x === null);
      push('V17Cat vs concat null', "SELECT CONCAT('a', NULL) AS c, 'a' || NULL AS o", r => r.data[0].c === 'a' && r.data[0].o === null);
      push('V17Cat nested fn', "SELECT UPPER('a' || 'b') || LOWER('C') AS x", r => r.data[0].x === 'ABc');
      push('V17Cat inside fn arg', "SELECT LENGTH('ab' || 'cde') AS n", r => r.data[0].n === 5);
      push('V17Cat multi arg fn', "SELECT CONCAT('x' || 'y', 'z') AS x", r => r.data[0].x === 'xyz');
      push('V17Cat in where', "SELECT COUNT(*) AS c FROM v17_emp WHERE name || dept = 'AnnENG'", r => r.data[0].c === 1);
      push('V17Cat with case', "SELECT (CASE WHEN salary > 350 THEN 'hi' ELSE 'lo' END) || '!' AS x FROM v17_emp WHERE id = 5", r => r.data[0].x === 'lo!');
      push('V17Cat or still works', "SELECT COUNT(*) AS c FROM v17_emp WHERE dept = 'ENG' OR dept = 'HR'", r => r.data[0].c === 3);
      push('V17Cat parens', "SELECT ('a' || 'b') || ('c' || 'd') AS x", r => r.data[0].x === 'abcd');
      err('V17Cat missing rhs', "SELECT 'a' || AS x", 'syntax');

      // ------------------------------------------------------------
      // 2. '::' キャスト演算子 (PostgreSQL)
      // ------------------------------------------------------------
      push('V17Cast int', "SELECT '42'::INTEGER + 1 AS x", r => r.data[0].x === 43);
      push('V17Cast text', "SELECT 42::TEXT || '!' AS x", r => r.data[0].x === '42!');
      push('V17Cast float', "SELECT '3.5'::FLOAT * 2 AS x", r => r.data[0].x === 7);
      push('V17Cast bool', "SELECT 'true'::BOOLEAN AS x", r => r.data[0].x === true);
      push('V17Cast column', "SELECT salary::TEXT AS s FROM v17_emp WHERE id = 1", r => r.data[0].s === '500');
      push('V17Cast paren expr', "SELECT (1 + 2)::TEXT AS x", r => r.data[0].x === '3');
      push('V17Cast type modifier', "SELECT '12.5'::DECIMAL(10,2) AS x", r => Number(r.data[0].x) === 12.5);
      push('V17Cast chained', "SELECT '7'::INTEGER::TEXT AS x", r => r.data[0].x === '7');
      push('V17Cast in where', "SELECT COUNT(*) AS c FROM v17_emp WHERE salary::TEXT = '300'", r => r.data[0].c === 2);

      // ------------------------------------------------------------
      // 3. ILIKE / SIMILAR TO / IS [NOT] UNKNOWN
      // ------------------------------------------------------------
      push('V17Ilike basic', "SELECT COUNT(*) AS c FROM v17_emp WHERE name ILIKE 'a%'", r => r.data[0].c === 1);
      push('V17Ilike upper pattern', "SELECT COUNT(*) AS c FROM v17_emp WHERE name ILIKE 'B%'", r => r.data[0].c === 1);
      push('V17Ilike not', "SELECT COUNT(*) AS c FROM v17_emp WHERE name NOT ILIKE 'a%'", r => r.data[0].c === 4);
      push('V17Ilike underscore', "SELECT COUNT(*) AS c FROM v17_emp WHERE name ILIKE '_nn'", r => r.data[0].c === 1);
      push('V17Ilike escape', "SELECT 'a%b' ILIKE 'A!%B' ESCAPE '!' AS x", r => r.data[0].x === true);
      push('V17Sim alternation', "SELECT COUNT(*) AS c FROM v17_emp WHERE name SIMILAR TO '(Ann|Bob)'", r => r.data[0].c === 2);
      push('V17Sim percent', "SELECT COUNT(*) AS c FROM v17_emp WHERE dept SIMILAR TO 'S%'", r => r.data[0].c === 2);
      push('V17Sim underscore', "SELECT 'abc' SIMILAR TO 'a_c' AS x", r => r.data[0].x === true);
      push('V17Sim anchored', "SELECT 'abc' SIMILAR TO 'b' AS x", r => r.data[0].x === false);
      push('V17Sim repeat', "SELECT 'aaa' SIMILAR TO 'a{3}' AS x", r => r.data[0].x === true);
      push('V17Sim dot literal', "SELECT 'axc' SIMILAR TO 'a.c' AS x", r => r.data[0].x === false);
      push('V17Sim not', "SELECT COUNT(*) AS c FROM v17_emp WHERE name NOT SIMILAR TO '(Ann|Bob)'", r => r.data[0].c === 3);
      push('V17Unk true', "SELECT (1 = 1) IS NOT UNKNOWN AS x", r => r.data[0].x === true);
      push('V17Unk null', "SELECT (NULL) IS UNKNOWN AS x", r => r.data[0].x === true);
      push('V17Unk column', "SELECT COUNT(*) AS c FROM v17_emp WHERE mgr IS UNKNOWN", r => r.data[0].c === 1);
      push('V17Unk not column', "SELECT COUNT(*) AS c FROM v17_emp WHERE mgr IS NOT UNKNOWN", r => r.data[0].c === 4);

      // ------------------------------------------------------------
      // 4. 行コンストラクタ
      // ------------------------------------------------------------
      push('V17Row eq true', "SELECT (1, 2) = (1, 2) AS x", r => r.data[0].x === true);
      push('V17Row eq false', "SELECT (1, 2) = (1, 3) AS x", r => r.data[0].x === false);
      push('V17Row neq', "SELECT (1, 2) <> (9, 2) AS x", r => r.data[0].x === true);
      push('V17Row cols', "SELECT COUNT(*) AS c FROM v17_emp WHERE (dept, salary) = ('SALES', 300)", r => r.data[0].c === 2);
      push('V17Row in', "SELECT COUNT(*) AS c FROM v17_emp WHERE (dept, salary) IN (('ENG', 500), ('HR', 200))", r => r.data[0].c === 2);
      push('V17Row not in', "SELECT COUNT(*) AS c FROM v17_emp WHERE (dept, salary) NOT IN (('ENG', 500), ('HR', 200))", r => r.data[0].c === 3);
      push('V17Row three cols', "SELECT COUNT(*) AS c FROM v17_emp WHERE (id, dept, salary) = (1, 'ENG', 500)", r => r.data[0].c === 1);
      push('V17Row keyword', "SELECT ROW(1, 2) = ROW(1, 2) AS x", r => r.data[0].x === true);
      push('V17Row expr operand', "SELECT COUNT(*) AS c FROM v17_emp WHERE (id + 1, salary) = (2, 500)", r => r.data[0].c === 1);
      push('V17Row fn call untouched', "SELECT IFNULL(NULL, 7) AS x", r => r.data[0].x === 7);
      err('V17Row arity', "SELECT (1, 2) = (1, 2, 3) AS x", 'arity');

      // ------------------------------------------------------------
      // 5. MINUS / DISTINCT ON / WITH TIES / GROUP BY ALL / * EXCLUDE / * REPLACE
      // ------------------------------------------------------------
      push('V17Set minus', "SELECT id FROM v17_emp MINUS SELECT 1", r => r.data.length === 4 && !r.data.some(x => x.id === 1));
      push('V17Set minus all', "SELECT dept FROM v17_emp MINUS ALL SELECT 'ENG'", r => r.data.length === 4);
      push('V17Set except same', "SELECT id FROM v17_emp EXCEPT SELECT 1", r => r.data.length === 4);
      push('V17Don basic', "SELECT DISTINCT ON (dept) dept, salary FROM v17_emp ORDER BY dept, salary DESC", r => r.data.length === 3 && r.data[0].dept === 'ENG' && r.data[0].salary === 500);
      push('V17Don asc', "SELECT DISTINCT ON (dept) dept, salary FROM v17_emp ORDER BY dept, salary ASC", r => r.data[0].salary === 400);
      push('V17Don two keys', "SELECT DISTINCT ON (dept, salary) dept, salary, id FROM v17_emp ORDER BY dept, salary, id", r => r.data.length === 4);
      err('V17Don missing select', "SELECT DISTINCT ON (mgr) dept FROM v17_emp ORDER BY mgr", 'select list');
      push('V17Ties fetch', "SELECT id, salary FROM v17_emp ORDER BY salary ASC FETCH FIRST 1 ROWS WITH TIES", r => r.data.length === 1 && r.data[0].salary === 200);
      push('V17Ties tie hit', "SELECT id, salary FROM v17_emp ORDER BY salary ASC FETCH FIRST 2 ROWS WITH TIES", r => r.data.length === 3);
      push('V17Ties limit form', "SELECT id, salary FROM v17_emp ORDER BY salary ASC LIMIT 2 WITH TIES", r => r.data.length === 3);
      push('V17Ties only unaffected', "SELECT id FROM v17_emp ORDER BY salary ASC FETCH FIRST 2 ROWS ONLY", r => r.data.length === 2);
      err('V17Ties no order', "SELECT id FROM v17_emp LIMIT 2 WITH TIES", 'order by');
      push('V17Gba basic', "SELECT dept, COUNT(*) AS c FROM v17_emp GROUP BY ALL ORDER BY dept", r => r.data.length === 3 && r.data[0].dept === 'ENG' && r.data[0].c === 2);
      push('V17Gba two cols', "SELECT dept, salary, COUNT(*) AS c FROM v17_emp GROUP BY ALL ORDER BY dept, salary", r => r.data.length === 4);
      push('V17Gba expr', "SELECT dept, SUM(salary) AS s FROM v17_emp GROUP BY ALL HAVING SUM(salary) > 500 ORDER BY dept", r => r.data.length === 2);
      err('V17Gba all agg', "SELECT COUNT(*) AS c FROM v17_emp GROUP BY ALL", 'non-aggregate');
      push('V17Star exclude', "SELECT * EXCLUDE (mgr) FROM v17_emp WHERE id = 1", r => Object.keys(r.data[0]).length === 4 && r.data[0].mgr === undefined);
      push('V17Star exclude two', "SELECT * EXCLUDE (mgr, dept) FROM v17_emp WHERE id = 1", r => Object.keys(r.data[0]).length === 3);
      push('V17Star replace', "SELECT * REPLACE (salary * 2 AS salary) FROM v17_emp WHERE id = 1", r => r.data[0].salary === 1000 && r.data[0].name === 'Ann');
      push('V17Star replace keeps order', "SELECT * REPLACE (UPPER(name) AS name) FROM v17_emp WHERE id = 2", r => Object.keys(r.data[0])[1] === 'name' && r.data[0].name === 'BOB');
      err('V17Star exclude empty', "SELECT * EXCLUDE () FROM v17_emp", 'at least one');

      // ------------------------------------------------------------
      // 6. 派生表の列リスト / VALUES 派生表 / 表関数
      // ------------------------------------------------------------
      push('V17Der cols', "SELECT a, b FROM (SELECT id, name FROM v17_emp WHERE id < 3) AS d(a, b) ORDER BY a", r => r.data.length === 2 && r.data[0].a === 1 && r.data[0].b === 'Ann');
      push('V17Der no as', "SELECT x FROM (SELECT salary FROM v17_emp WHERE id = 1) d(x)", r => r.data[0].x === 500);
      push('V17Der where on alias', "SELECT COUNT(*) AS c FROM (SELECT id, salary FROM v17_emp) t(a, b) WHERE b > 250", r => r.data[0].c === 4);
      push('V17Val basic', "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, nm) ORDER BY id", r => r.data.length === 2 && r.data[1].nm === 'b');
      push('V17Val default cols', "SELECT column1 AS c1 FROM (VALUES (7), (8)) v ORDER BY column1", r => r.data[0].c1 === 7);
      push('V17Val join', "SELECT e.name, v.label FROM v17_emp e JOIN (VALUES ('ENG','E'),('HR','H')) AS v(code, label) ON e.dept = v.code ORDER BY e.name", r => r.data.length === 3);
      push('V17Val agg', "SELECT SUM(n) AS s FROM (VALUES (1),(2),(3)) AS t(n)", r => r.data[0].s === 6);
      push('V17Split basic', "SELECT value AS v FROM STRING_SPLIT('a,b,c', ',') ORDER BY value", r => r.data.length === 3 && r.data[0].v === 'a');
      push('V17Split alias col', "SELECT part FROM STRING_SPLIT('x|y', '|') AS s(part) ORDER BY part", r => r.data.length === 2 && r.data[1].part === 'y');
      push('V17Split join', "SELECT COUNT(*) AS c FROM v17_emp e JOIN STRING_SPLIT('Ann,Bob', ',') s ON e.name = s.value", r => r.data[0].c === 2);
      err('V17Split empty sep', "SELECT * FROM STRING_SPLIT('abc', '')", 'separator');
      push('V17Unn numbers', "SELECT SUM(n) AS s FROM UNNEST(10, 20, 30) AS u(n)", r => r.data[0].s === 60);
      push('V17Unn strings', "SELECT COUNT(*) AS c FROM UNNEST('a', 'b') AS u(v)", r => r.data[0].c === 2);

      // ------------------------------------------------------------
      // 7. 複数表 UPDATE / DELETE
      // ------------------------------------------------------------
      push('V17Mdml pg update', "UPDATE v17_emp SET salary = salary + v17_dept.budget FROM v17_dept WHERE v17_emp.dept = v17_dept.code AND v17_dept.code = 'HR'", r => r.data[0].Result === 'Success');
      push('V17Mdml pg verify', "SELECT salary AS s FROM v17_emp WHERE id = 5", r => r.data[0].s === 600);
      push('V17Mdml alias update', "UPDATE v17_emp e SET salary = d.budget FROM v17_dept d WHERE e.dept = d.code AND e.id = 5", r => r.data[0].Result === 'Success');
      push('V17Mdml alias verify', "SELECT salary AS s FROM v17_emp WHERE id = 5", r => r.data[0].s === 400);
      push('V17Mdml mysql update', "UPDATE v17_emp e JOIN v17_dept d ON e.dept = d.code SET e.salary = 111 WHERE d.code = 'HR'", r => r.data[0].Result === 'Success');
      push('V17Mdml mysql verify', "SELECT salary AS s FROM v17_emp WHERE id = 5", r => r.data[0].s === 111);
      push('V17Mdml plain update intact', "UPDATE v17_emp SET salary = (SELECT MAX(budget) FROM v17_dept) WHERE id = 5", r => r.data[0].Result === 'Success');
      push('V17Mdml plain verify', "SELECT salary AS s FROM v17_emp WHERE id = 5", r => r.data[0].s === 1000);
      push('V17Mdml seed extra', "INSERT INTO v17_emp VALUES (6,'Fay','OPS',150,1),(7,'Gus','OPS',150,1)", r => r.data[0].Result === 'Success');
      push('V17Mdml pg delete', "DELETE FROM v17_emp USING v17_dept WHERE v17_emp.dept = v17_dept.code AND v17_dept.code = 'OPS'", r => r.data[0].Result === 'Success');
      push('V17Mdml pg delete verify', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 5);
      push('V17Mdml seed again', "INSERT INTO v17_emp VALUES (8,'Hal','OPS',150,1)", r => r.data[0].Result === 'Success');
      push('V17Mdml mysql delete', "DELETE e FROM v17_emp e JOIN v17_dept d ON e.dept = d.code WHERE d.code = 'OPS'", r => r.data[0].Result === 'Success');
      push('V17Mdml mysql delete verify', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 5);
      push('V17Mdml returning', "DELETE FROM v17_emp USING v17_dept WHERE v17_emp.dept = v17_dept.code AND v17_emp.id = 4 RETURNING id", r => r.data.length === 1 && r.data[0].id === 4);
      push('V17Mdml restore row', "INSERT INTO v17_emp VALUES (4,'Dee','SALES',300,3)", r => r.data[0].Result === 'Success');
      err('V17Mdml self join', "UPDATE v17_emp SET salary = 1 FROM v17_emp WHERE 1 = 1", 'different tables');
      err('V17Mdml wrong target', "DELETE v17_dept FROM v17_emp e JOIN v17_dept d ON e.dept = d.code", 'first table');
      err('V17Mdml no where', "UPDATE v17_emp SET salary = 1 FROM v17_dept", 'where');

      // ------------------------------------------------------------
      // 8. ユーザー定義関数 (CREATE FUNCTION)
      // ------------------------------------------------------------
      push('V17Udf create', "CREATE FUNCTION v17_tax(a) RETURNS FLOAT AS RETURN ROUND(a * 1.1, 2)", r => r.data[0].Result === 'Success');
      push('V17Udf use literal', "SELECT v17_tax(100) AS x", r => r.data[0].x === 110);
      push('V17Udf use column', "SELECT v17_tax(salary) AS x FROM v17_emp WHERE id = 5", r => Math.abs(r.data[0].x - 1100) < 1e-6);
      push('V17Udf typed params', "CREATE FUNCTION v17_add(a INT, b INT) RETURNS INT AS RETURN a + b", r => r.data[0].Result === 'Success');
      push('V17Udf two args', "SELECT v17_add(2, 3) AS x", r => r.data[0].x === 5);
      push('V17Udf nested call', "SELECT v17_add(v17_add(1, 2), 4) AS x", r => r.data[0].x === 7);
      push('V17Udf in where', "SELECT COUNT(*) AS c FROM v17_emp WHERE v17_add(id, 0) >= 3", r => r.data[0].c === 3);
      push('V17Udf composes udf', "CREATE FUNCTION v17_double(x) RETURNS INT AS RETURN v17_add(x, x)", r => r.data[0].Result === 'Success');
      push('V17Udf composed call', "SELECT v17_double(21) AS x", r => r.data[0].x === 42);
      push('V17Udf with case', "CREATE OR REPLACE FUNCTION v17_grade(s) RETURNS TEXT AS RETURN CASE WHEN s > 350 THEN 'hi' ELSE 'lo' END", r => r.data[0].Result === 'Success');
      push('V17Udf case use', "SELECT v17_grade(400) AS a, v17_grade(100) AS b", r => r.data[0].a === 'hi' && r.data[0].b === 'lo');
      push('V17Udf begin end form', "CREATE FUNCTION v17_neg(x) RETURNS INT AS BEGIN RETURN 0 - x; END", r => r.data[0].Result === 'Success');
      push('V17Udf begin end use', "SELECT v17_neg(9) AS x", r => r.data[0].x === -9);
      push('V17Udf zero args', "CREATE FUNCTION v17_answer() RETURNS INT AS RETURN 42", r => r.data[0].Result === 'Success');
      push('V17Udf zero args use', "SELECT v17_answer() AS x", r => r.data[0].x === 42);
      push('V17Udf show functions', "SHOW FUNCTIONS LIKE 'v17_tax'", r => r.data.length === 1 && r.data[0].Category === 'User-defined');
      push('V17Udf in group by', "SELECT v17_grade(id * 100) AS g, COUNT(*) AS c FROM v17_emp GROUP BY v17_grade(id * 100) ORDER BY g", r => r.data.length === 2);
      err('V17Udf duplicate', "CREATE FUNCTION v17_tax(a) RETURNS FLOAT AS RETURN a", 'already exists');
      err('V17Udf builtin name', "CREATE FUNCTION upper(a) RETURNS TEXT AS RETURN a", 'built-in');
      err('V17Udf bad arity', "SELECT v17_add(1) AS x", 'expects 2');
      err('V17Udf bad body', "CREATE FUNCTION v17_bad(a) RETURNS INT AS RETURN a +", 'invalid function body');
      err('V17Udf dup param', "CREATE FUNCTION v17_dup(a, a) RETURNS INT AS RETURN a", 'duplicate parameter');
      err('V17Udf unknown drop', "DROP FUNCTION v17_nope", 'not found');
      push('V17Udf drop if exists', "DROP FUNCTION IF EXISTS v17_nope", r => r.data[0].Result === 'Success');
      push('V17Udf replace', "CREATE OR REPLACE FUNCTION v17_tax(a) RETURNS FLOAT AS RETURN a * 2", r => r.data[0].Result === 'Success');
      push('V17Udf replaced value', "SELECT v17_tax(5) AS x", r => r.data[0].x === 10);
      push('V17Udf drop', "DROP FUNCTION v17_tax", r => r.data[0].Result === 'Success');
      err('V17Udf gone', "SELECT v17_tax(1) AS x", 'does not exist');

      // ------------------------------------------------------------
      // 9. INFORMATION_SCHEMA
      // ------------------------------------------------------------
      push('V17Is tables', "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_NAME = 'v17_emp'", r => r.data.length === 1);
      push('V17Is table type', "SELECT TABLE_TYPE AS ty FROM information_schema.tables WHERE TABLE_NAME = 'users'", r => r.data[0].ty === 'BASE TABLE');
      push('V17Is table rows', "SELECT TABLE_ROWS AS n FROM information_schema.tables WHERE TABLE_NAME = 'v17_emp'", r => r.data[0].n === 5);
      push('V17Is columns count', "SELECT COUNT(*) AS c FROM information_schema.columns WHERE TABLE_NAME = 'v17_emp'", r => r.data[0].c === 5);
      push('V17Is column order', "SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE TABLE_NAME = 'v17_emp' ORDER BY ORDINAL_POSITION", r => r.data[0].c === 'id' && r.data[4].c === 'mgr');
      push('V17Is column key', "SELECT COLUMN_KEY AS k FROM information_schema.columns WHERE TABLE_NAME = 'v17_emp' AND COLUMN_NAME = 'id'", r => r.data[0].k === 'PRI');
      push('V17Is nullable', "SELECT IS_NULLABLE AS n FROM information_schema.columns WHERE TABLE_NAME = 'v17_emp' AND COLUMN_NAME = 'id'", r => r.data[0].n === 'NO');
      push('V17Is constraints', "SELECT CONSTRAINT_TYPE AS ct FROM information_schema.table_constraints WHERE TABLE_NAME = 'v17_emp'", r => r.data.some(x => x.ct === 'PRIMARY KEY'));
      push('V17Is key usage', "SELECT COLUMN_NAME AS c FROM information_schema.key_column_usage WHERE TABLE_NAME = 'v17_emp'", r => r.data[0].c === 'id');
      push('V17Is schemata', "SELECT SCHEMA_NAME AS s FROM information_schema.schemata", r => r.data[0].s === 'main');
      push('V17Is join', "SELECT t.TABLE_NAME AS tn, COUNT(*) AS c FROM information_schema.tables t JOIN information_schema.columns c ON t.TABLE_NAME = c.TABLE_NAME WHERE t.TABLE_NAME = 'v17_dept' GROUP BY t.TABLE_NAME", r => r.data[0].c === 3);
      push('V17Is views', "CREATE VIEW v17_v AS SELECT id FROM v17_emp", r => r.data[0].Result === 'Success');
      push('V17Is views list', "SELECT COUNT(*) AS c FROM information_schema.views WHERE TABLE_NAME = 'v17_v'", r => r.data[0].c === 1);
      push('V17Is cleanup view', "DROP VIEW v17_v", r => r.data[0].Result === 'Success');
      err('V17Is unknown', "SELECT * FROM information_schema.nope", 'not available');

      // ------------------------------------------------------------
      // 10. インデックス / 制約 / DDL の追加
      // ------------------------------------------------------------
      push('V17Idx multi col', "CREATE INDEX v17_ix ON v17_emp (dept, salary)", r => r.data[0].Result === 'Success');
      push('V17Idx used', "EXPLAIN SELECT * FROM v17_emp WHERE dept = 'ENG'", r => r.data[0].Operation === 'INDEX SCAN');
      push('V17Idx drop by name', "DROP INDEX v17_ix", r => r.data[0].Result === 'Success');
      push('V17Idx gone', "EXPLAIN SELECT * FROM v17_emp WHERE dept = 'ENG'", r => r.data[0].Operation === 'TABLE SCAN');
      push('V17Idx unique', "CREATE UNIQUE INDEX v17_uq ON v17_emp (name)", r => r.data[0].Result === 'Success');
      err('V17Idx unique enforced', "INSERT INTO v17_emp VALUES (99,'Ann','ENG',1,NULL)", 'unique');
      push('V17Idx drop unique', "DROP INDEX v17_uq ON v17_emp", r => r.data[0].Result === 'Success');
      err('V17Idx unique dup fail', "CREATE UNIQUE INDEX v17_uq2 ON v17_emp (dept)", 'duplicate');
      push('V17Idx drop missing ok', "DROP INDEX IF EXISTS v17_none", r => r.data[0].Result === 'Success');
      err('V17Idx unknown col', "CREATE INDEX v17_bad ON v17_emp (nope)", "not found");
      err('V17Ddl unknown', "CREATE WIDGET foo", 'unsupported');
      push('V17Ddl default values', "CREATE TABLE v17_dv (a INTEGER DEFAULT 3, b TEXT DEFAULT 'z')", r => r.data[0].Result === 'Success');
      push('V17Ddl default insert', "INSERT INTO v17_dv DEFAULT VALUES", r => r.data[0].Result === 'Success');
      push('V17Ddl default verify', "SELECT a, b FROM v17_dv", r => r.data[0].a === 3 && r.data[0].b === 'z');
      push('V17Ddl drop dv', "DROP TABLE v17_dv", r => r.data[0].Result === 'Success');

      // ------------------------------------------------------------
      // 11. システム変数 / セッション変数 / 決定的乱数
      // ------------------------------------------------------------
      push('V17Sys version', "SELECT @@version AS v", r => typeof r.data[0].v === 'string' && r.data[0].v.length > 0);
      push('V17Sys identity', "SELECT @@identity AS i", r => typeof r.data[0].i === 'number');
      err('V17Sys unknown', "SELECT @@definitely_not_a_var AS x", 'unknown system variable');
      push('V17Set timeout', "SET statement_timeout = 250", r => r.data[0].Result === 'Success');
      push('V17Set timeout var', "SELECT @@statement_timeout AS t", r => Number(r.data[0].t) === 250);
      push('V17Set timeout off', "SET statement_timeout = 0", r => r.data[0].Result === 'Success');
      push('V17Set session prefix', "SET SESSION slow_query_threshold = 5", r => r.data[0].Result === 'Success');
      push('V17Set to syntax', "SET slow_query_threshold TO 50", r => r.data[0].Result === 'Success');
      err('V17Set bad int', "SET statement_timeout = abc", 'expected');
      err('V17Set bad bool', "SET read_only = maybe", 'expected');
      push('V17Set tx untouched', "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", r => r.data[0].Result === 'Success');
      push('V17Set session tx untouched', "SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE", r => r.data[0].Result === 'Success');
      push('V17Seed set', "SELECT SETSEED(0.25) AS s", r => typeof r.data[0].s === 'number');
      push('V17Seed determinism a', "SELECT SETSEED(0.25) AS s", r => true);
      push('V17Seed determinism b', "SELECT ROUND(RAND() * 1000000) AS r", r => { T._seedA = r.data[0].r; return typeof r.data[0].r === 'number'; });
      push('V17Seed determinism c', "SELECT SETSEED(0.25) AS s", r => true);
      push('V17Seed determinism d', "SELECT ROUND(RAND() * 1000000) AS r", r => r.data[0].r === T._seedA);
      push('V17Seed range', "SELECT SETSEED(0.9) AS s0, RAND() AS a, RAND() AS b", r => r.data[0].a >= 0 && r.data[0].a < 1 && r.data[0].a !== r.data[0].b);
      push('V17Seed via set', "SET seed = 0.5", r => r.data[0].Result === 'Success');
      push('V17Seed via set value', "SELECT ROUND(RAND() * 1000000) AS r", r => { T._seedB = r.data[0].r; return true; });
      push('V17Seed via set again', "SET seed = 0.5", r => r.data[0].Result === 'Success');
      push('V17Seed via set verify', "SELECT ROUND(RAND() * 1000000) AS r", r => r.data[0].r === T._seedB);
      push('V17Seed clear', "SELECT SETSEED(NULL) AS s", r => r.data[0].s === 0);

      // ------------------------------------------------------------
      // 12. スナップショット
      // ------------------------------------------------------------
      push('V17Snap create', "CREATE SNAPSHOT v17_s1", r => r.data[0].Result === 'Success');
      push('V17Snap list', "SHOW SNAPSHOTS", r => r.data.some(x => x.Snapshot === 'v17_s1' && x.Rows > 0));
      push('V17Snap mutate', "DELETE FROM v17_emp", r => r.data[0].Result === 'Success');
      push('V17Snap mutated', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 0);
      push('V17Snap restore', "RESTORE SNAPSHOT v17_s1", r => r.data[0].Result === 'Success');
      push('V17Snap restored', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 5);
      push('V17Snap ddl too', "CREATE TABLE v17_tmp_after (x INTEGER)", r => r.data[0].Result === 'Success');
      push('V17Snap restore drops new', "RESTORE SNAPSHOT v17_s1", r => r.data[0].Result === 'Success');
      err('V17Snap new gone', "SELECT * FROM v17_tmp_after", 'not found');
      push('V17Snap if not exists', "CREATE SNAPSHOT IF NOT EXISTS v17_s1", r => r.data[0].Result === 'Success');
      push('V17Snap drop', "DROP SNAPSHOT v17_s1", r => r.data[0].Result === 'Success');
      err('V17Snap gone', "RESTORE SNAPSHOT v17_s1", 'not found');
      push('V17Snap drop if exists', "DROP SNAPSHOT IF EXISTS v17_s1", r => r.data[0].Result === 'Success');
      push('V17Snap tx guard begin', "BEGIN", r => r.data[0].Result === 'Success');
      err('V17Snap tx guard', "CREATE SNAPSHOT v17_s2", 'transaction');
      push('V17Snap tx guard end', "ROLLBACK", r => r.data[0].Result === 'Success');

      // ------------------------------------------------------------
      // 13. プロファイル / 遅いクエリログ / 読み取り専用
      // ------------------------------------------------------------
      push('V17Prof shape', "SHOW PROFILE", r => r.data.length === 1 && typeof r.data[0].DurationMs === 'number');
      push('V17Prof statement', "SHOW PROFILE", r => r.data[0].Statement === 'SHOW PROFILE');
      push('V17Prof slow list', "SHOW SLOW QUERIES", r => Array.isArray(r.data));
      push('V17Ro on', "SET read_only = ON", r => r.data[0].Result === 'Success');
      push('V17Ro select ok', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 5);
      push('V17Ro show ok', "SHOW TABLES", r => r.data.length > 0);
      push('V17Ro explain ok', "EXPLAIN SELECT * FROM v17_emp", r => r.data.length > 0);
      err('V17Ro insert blocked', "INSERT INTO v17_emp VALUES (50,'X','ENG',1,NULL)", 'read-only');
      err('V17Ro update blocked', "UPDATE v17_emp SET salary = 1", 'read-only');
      err('V17Ro delete blocked', "DELETE FROM v17_emp", 'read-only');
      err('V17Ro ddl blocked', "CREATE TABLE v17_ro (x INTEGER)", 'read-only');
      err('V17Ro drop blocked', "DROP TABLE v17_emp", 'read-only');
      push('V17Ro off', "SET read_only = OFF", r => r.data[0].Result === 'Success');
      push('V17Ro write again', "SELECT COUNT(*) AS c FROM v17_emp", r => r.data[0].c === 5);

      // ------------------------------------------------------------
      // 14. 日付リテラルのタイムゾーン修正
      // ------------------------------------------------------------
      push('V17Ts literal', "SELECT TIMESTAMP '2026-03-04 10:20:30' AS d", r => r.data[0].d === '2026-03-04 10:20:30');
      // v1.25: DATE は「日付だけ」、DATETIME / TIMESTAMP は「日付＋時刻」で区別する。
      // 比較は時刻へ寄せて行うので、表記が違っても同じ瞬間なら一致する
      push('V17Ts date literal', "SELECT DATE '2026-03-04' AS d", r => r.data[0].d === '2026-03-04');
      push('V17Ts timestamp literal keeps the time', "SELECT TIMESTAMP '2026-03-04 10:20:30' AS d", r => r.data[0].d === '2026-03-04 10:20:30');
      push('V17Ts cast to date truncates', "SELECT CAST('2026-03-04 10:20:30' AS DATE) AS d", r => r.data[0].d === '2026-03-04');
      push('V17Ts cast to datetime keeps the time', "SELECT CAST('2026-03-04 10:20:30' AS DATETIME) AS d", r => r.data[0].d === '2026-03-04 10:20:30');
      push('V17Ts date and timestamp compare equal', "SELECT DATE '2026-03-04' = TIMESTAMP '2026-03-04 00:00:00' AS x", r => r.data[0].x === true);
      push('V17Ts extract', "SELECT EXTRACT(HOUR FROM TIMESTAMP '2026-03-04 10:20:30') AS h", r => r.data[0].h === 10);
      push('V17Ts compare', "SELECT (TIMESTAMP '2026-03-04 10:00:00' > TIMESTAMP '2026-03-04 09:00:00') AS x", r => r.data[0].x === true);

      // ------------------------------------------------------------
      // 15. 外部 API (ブラウザDB運用機能)
      // ------------------------------------------------------------
      fn('V17Api readOnly toggle', () => {
        LuminaDB.readOnly(true);
        const blocked = LuminaDB.query("INSERT INTO v17_emp VALUES (60,'Z','ENG',1,NULL)");
        const ok = LuminaDB.query("SELECT COUNT(*) AS c FROM v17_emp");
        LuminaDB.readOnly(false);
        return !!blocked.error && !ok.error && LuminaDB.readOnly() === false;
      });
      fn('V17Api timeout getter', () => {
        LuminaDB.timeout(400);
        const v = LuminaDB.timeout();
        LuminaDB.timeout(0);
        return v === 400 && LuminaDB.timeout() === 0;
      });
      fn('V17Api timeout invalid', () => {
        try { LuminaDB.timeout(-1); return false; } catch (e) { return /non-negative/.test(e.message); }
      });
      fn('V17Api snapshot roundtrip', () => {
        LuminaDB.snapshot('v17_api_s');
        LuminaDB.query("DELETE FROM v17_emp WHERE id = 1");
        const mid = LuminaDB.value("SELECT COUNT(*) AS c FROM v17_emp");
        LuminaDB.restore('v17_api_s');
        const after = LuminaDB.value("SELECT COUNT(*) AS c FROM v17_emp");
        const listed = LuminaDB.snapshots().some(s => s.Snapshot === 'v17_api_s');
        LuminaDB.dropSnapshot('v17_api_s');
        return mid === 4 && after === 5 && listed && LuminaDB.snapshots().length === 0;
      });
      fn('V17Api subscribe initial', () => {
        let seen = null;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", rows => { seen = rows; });
        sub.unsubscribe();
        return !!seen && seen[0].c === 5;
      });
      fn('V17Api subscribe on change', () => {
        let calls = 0, last = null;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", rows => { calls++; last = rows; });
        LuminaDB.query("INSERT INTO v17_emp VALUES (61,'Sub','ENG',1,NULL)");
        const after = calls;
        LuminaDB.query("DELETE FROM v17_emp WHERE id = 61");
        sub.unsubscribe();
        return after === 2 && last !== null;
      });
      fn('V17Api subscribe skips unrelated', () => {
        let calls = 0;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", () => { calls++; });
        LuminaDB.query("INSERT INTO v17_dept VALUES ('QA','Quality',10)");
        const after = calls;
        LuminaDB.query("DELETE FROM v17_dept WHERE code = 'QA'");
        sub.unsubscribe();
        return after === 1;   // 初回のみ（無関係な書き込みでは再通知しない）
      });
      fn('V17Api unsubscribe stops', () => {
        let calls = 0;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", () => { calls++; });
        sub.unsubscribe();
        LuminaDB.query("INSERT INTO v17_emp VALUES (62,'X','ENG',1,NULL)");
        LuminaDB.query("DELETE FROM v17_emp WHERE id = 62");
        return calls === 1;
      });
      fn('V17Api subscribe rejects write', () => {
        try { LuminaDB.subscribe("DELETE FROM v17_emp", () => {}); return false; }
        catch (e) { return /read-only/.test(e.message); }
      });
      fn('V17Api subscribe transaction batches', () => {
        let calls = 0;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", () => { calls++; });
        LuminaDB.transaction(api => {
          api.query("INSERT INTO v17_emp VALUES (63,'T1','ENG',1,NULL)");
          api.query("INSERT INTO v17_emp VALUES (64,'T2','ENG',1,NULL)");
        });
        const after = calls;
        LuminaDB.query("DELETE FROM v17_emp WHERE id IN (63, 64)");
        sub.unsubscribe();
        return after === 2;   // 初回 + COMMIT 後 1 回（中間状態は配らない）
      });
      fn('V17Api refresh manual', () => {
        let calls = 0;
        const sub = LuminaDB.subscribe("SELECT COUNT(*) AS c FROM v17_emp", () => { calls++; });
        db.executeQuery("INSERT INTO v17_emp VALUES (65,'Direct','ENG',1,NULL)");
        LuminaDB.refresh();
        const after = calls;
        db.executeQuery("DELETE FROM v17_emp WHERE id = 65");
        sub.unsubscribe();
        return after === 2;
      });
      fn('V17Api importJSON create', () => {
        const r = LuminaDB.importJSON('v17_json', [{ id: 1, label: 'a' }, { id: 2, label: 'b' }], { create: true });
        const n = LuminaDB.value("SELECT COUNT(*) AS c FROM v17_json");
        return !r.error && n === 2;
      });
      fn('V17Api importJSON needs create', () => {
        const r = LuminaDB.importJSON('v17_missing_tbl', [{ a: 1 }]);
        return !!r.error && /create/.test(r.error);
      });
      fn('V17Api exportJSON', () => {
        const out = LuminaDB.exportJSON(['v17_json']);
        return Array.isArray(out.v17_json) && out.v17_json.length === 2 && out.v17_json[0].label === 'a';
      });
      fn('V17Api exportJSON bad name', () => {
        try { LuminaDB.exportJSON(['bad name']); return false; } catch (e) { return /Invalid table name/.test(e.message); }
      });
      fn('V17Api json cleanup', () => !LuminaDB.query("DROP TABLE v17_json").error);
      fn('V17Api profile', () => {
        LuminaDB.query("SELECT 1 AS x");
        const p = LuminaDB.profile();
        return !!p && typeof p.DurationMs === 'number';
      });
      fn('V17Api slowQueries array', () => Array.isArray(LuminaDB.slowQueries()));

      // ------------------------------------------------------------
      // 16. 後片付け
      // ------------------------------------------------------------
      push('V17Cl drop fns 1', "DROP FUNCTION IF EXISTS v17_add", r => r.data[0].Result === 'Success');
      push('V17Cl drop fns 2', "DROP FUNCTION IF EXISTS v17_double", r => r.data[0].Result === 'Success');
      push('V17Cl drop fns 3', "DROP FUNCTION IF EXISTS v17_grade", r => r.data[0].Result === 'Success');
      push('V17Cl drop fns 4', "DROP FUNCTION IF EXISTS v17_neg", r => r.data[0].Result === 'Success');
      push('V17Cl drop fns 5', "DROP FUNCTION IF EXISTS v17_answer", r => r.data[0].Result === 'Success');
      push('V17Cl drop emp', "DROP TABLE v17_emp", r => r.data[0].Result === 'Success');
      push('V17Cl drop dept', "DROP TABLE v17_dept", r => r.data[0].Result === 'Success');

      return T;
    }
