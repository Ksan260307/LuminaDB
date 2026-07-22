    // ============================================================================
    // [Help] - コマンドリファレンスの定義と描画
    // ============================================================================
    const helpData = [
      { cat: "Basic DQL", cmds: [
        { name: "Select All", sql: "SELECT * FROM {table}" },
        { name: "Where & Limit", sql: "SELECT * FROM {table} WHERE id BETWEEN 1 AND 5 LIMIT 3" },
        { name: "Limit Offset (MySQL)", sql: "SELECT * FROM {table} ORDER BY id LIMIT 2, 3" },
        { name: "Comments", sql: "SELECT * FROM {table} /* ブロックコメント */ LIMIT 3 -- 行コメント" },
        { name: "Multi Order By", sql: "SELECT * FROM {table} ORDER BY id ASC, name DESC" },
        { name: "Order By Ordinal", sql: "SELECT name, age FROM {table} ORDER BY 2 DESC, 1 ASC" },
        { name: "Order By Expression", sql: "SELECT name FROM {table} ORDER BY LENGTH(name) DESC, id" },
        { name: "Not Between", sql: "SELECT * FROM {table} WHERE id NOT BETWEEN 2 AND 8" },
        { name: "Distinct", sql: "SELECT DISTINCT name FROM {table}" }
      ]},
      { cat: "String Functions", cmds: [
        { name: "Concat & Replace", sql: "SELECT CONCAT(id, '-', name), REPLACE(name, 'a', '@') FROM {table}" },
        { name: "Trim & Substr", sql: "SELECT TRIM(name), SUBSTRING(name, 1, 3) FROM {table}" },
        { name: "Case & Padding", sql: "SELECT UPPER(name), LOWER(name), LPAD(id, 5, '0'), RPAD(id, 5, '-') FROM {table}" },
        { name: "Left / Right / Instr", sql: "SELECT LEFT(name, 3), RIGHT(name, 3), INSTR(name, 'a') FROM {table}" },
        { name: "Reverse & Repeat", sql: "SELECT REVERSE(name), REPEAT('ab', 3) FROM {table}" },
        { name: "Concat WS & Locate", sql: "SELECT CONCAT_WS('-', id, name), LOCATE('a', name) FROM {table}" },
        { name: "Substring Index", sql: "SELECT SUBSTRING_INDEX('a.b.c', '.', 2), SUBSTRING_INDEX('a.b.c', '.', -1) FROM {table} LIMIT 1" },
        { name: "Format & Space", sql: "SELECT FORMAT(1234567.891, 2), SPACE(3), STRCMP('a', 'b')" },
        { name: "Elt / Field / Mid", sql: "SELECT ELT(2, 'a', 'b', 'c'), FIELD('b', 'a', 'b', 'c'), MID('abcdef', 2, 3)" },
        { name: "Initcap & Case Alias", sql: "SELECT INITCAP('hello world'), UCASE(name), LCASE(name) FROM {table}" },
        { name: "Position & Locate Pos", sql: "SELECT POSITION('ll' IN 'hello'), LOCATE('l', 'hello', 4)" },
        { name: "Hex / Bin / Oct / Conv", sql: "SELECT HEX(255), BIN(5), OCT(8), CONV('ff', 16, 10)" },
        { name: "Regexp Functions", sql: "SELECT REGEXP_REPLACE('a1b2', '[0-9]', '#'), REGEXP_SUBSTR('abc123', '[0-9]+'), REGEXP_LIKE('abc', '^a')" },
        { name: "Split Part & Quote", sql: "SELECT SPLIT_PART('a,b,c', ',', 2), QUOTE(name) FROM {table}" },
        { name: "Trim Extended", sql: "SELECT TRIM(LEADING 'x' FROM 'xxhi'), TRIM(BOTH ' ' FROM '  hi  ')" },
        { name: "Substring (SQL Standard)", sql: "SELECT SUBSTRING(name FROM 2 FOR 3) FROM {table}" },
        { name: "Translate & Insert", sql: "SELECT TRANSLATE('abc-def', '-', '_'), INSERT('Quadratic', 3, 4, 'What')" },
        { name: "Soundex", sql: "SELECT SOUNDEX('Robert'), SOUNDEX('Rupert') -- 発音が近い名前は同じコードになる" }
      ]},
      { cat: "Hash & Encoding", cmds: [
        { name: "MD5 & SHA1 & CRC32", sql: "SELECT MD5(name), SHA1(name), CRC32(name) FROM {table} LIMIT 3" },
        { name: "Base64 Roundtrip", sql: "SELECT TO_BASE64('Hello'), FROM_BASE64(TO_BASE64('Hello'))" },
        { name: "Hex & Byte Length", sql: "SELECT UNHEX(HEX('abc')), OCTET_LENGTH('こんにちは'), BIT_LENGTH('ab')" },
        { name: "IPv4 Conversion", sql: "SELECT INET_ATON('192.168.1.1'), INET_NTOA(3232235777)" }
      ]},
      { cat: "Sequences & Prepared Statements", cmds: [
        { name: "Create Sequence", sql: "CREATE SEQUENCE order_seq START WITH 100 INCREMENT BY 1" },
        { name: "Nextval / Currval", sql: "SELECT NEXTVAL('order_seq'), CURRVAL('order_seq')" },
        { name: "Insert With Sequence", sql: "INSERT INTO orders (order_id, user_id, product_id, amount) VALUES (NEXTVAL('order_seq'), 1, 101, 1)" },
        { name: "Show / Drop Sequence", sql: "SHOW SEQUENCES -- 削除: DROP SEQUENCE IF EXISTS order_seq" },
        { name: "Prepare & Execute", sql: "PREPARE find_user FROM 'SELECT * FROM users WHERE age > ?'" },
        { name: "Execute With Values", sql: "EXECUTE find_user USING 25" },
        { name: "Execute With Variables", sql: "SET @min = 30; EXECUTE find_user USING @min" },
        { name: "Show / Deallocate", sql: "SHOW PREPARED -- 解放: DEALLOCATE PREPARE find_user" }
      ]},
      { cat: "Math & Date Functions", cmds: [
        { name: "Math Basic", sql: "SELECT ABS(age), CEIL(age), FLOOR(age), ROUND(age) FROM {table}" },
        { name: "Math Advanced", sql: "SELECT MOD(age, 100), POWER(age, 2), SQRT(age), SIGN(age), RAND() FROM {table}" },
        { name: "Exp / Log / Pi", sql: "SELECT EXP(1), LOG(10), LOG10(1000), PI() FROM {table} LIMIT 1" },
        { name: "Truncate & Ceiling", sql: "SELECT TRUNCATE(3.14159, 2), CEILING(1.2) FROM {table} LIMIT 1" },
        { name: "Greatest & Least", sql: "SELECT GREATEST(age, 30, 40), LEAST(age, 30, 40) FROM {table}" },
        { name: "Date & Null", sql: "SELECT NOW(), YEAR(NOW()), MONTH(NOW()), DAY(NOW()), COALESCE(name, 'Unknown') FROM {table}" },
        { name: "Time Parts & Diff", sql: "SELECT HOUR(NOW()), MINUTE(NOW()), SECOND(NOW()), DATEDIFF(NOW(), '2026-01-01') FROM {table} LIMIT 1" },
        { name: "Null Handling", sql: "SELECT IFNULL(name, 'none'), NULLIF(age, 25), IF(age >= 30, 'senior', 'junior') FROM {table}" },
        { name: "Round Precision", sql: "SELECT ROUND(3.14159, 2), ROUND(1234.5678, -2), LOG2(8), COT(1)" },
        { name: "Date Format", sql: "SELECT DATE_FORMAT(NOW(), '%Y/%m/%d %H:%i:%s'), DATE_FORMAT(NOW(), '%W, %M %D')" },
        { name: "Date Names & Weeks", sql: "SELECT MONTHNAME(NOW()), DAYNAME(NOW()), WEEK(NOW()), WEEKDAY(NOW()), WEEKOFYEAR(NOW())" },
        { name: "Unix Time", sql: "SELECT UNIX_TIMESTAMP(), UNIX_TIMESTAMP('2026-01-01'), FROM_UNIXTIME(86400)" },
        { name: "Extract & Diff", sql: "SELECT EXTRACT(YEAR FROM NOW()), TIMESTAMPDIFF(DAY, '2026-01-01', NOW())" },
        { name: "Interval Arithmetic", sql: "SELECT DATE_ADD(NOW(), INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 2 WEEK)" },
        { name: "Meta Functions", sql: "SELECT UUID(), VERSION(), DATABASE(), LAST_INSERT_ID()" },
        { name: "Bit Count & Time Conv", sql: "SELECT BIT_COUNT(255), SEC_TO_TIME(3661), TIME_TO_SEC('01:01:01'), MAKEDATE(2026, 200)" },
        { name: "Str To Date", sql: "SELECT STR_TO_DATE('16/07/2026', '%d/%m/%Y'), STR_TO_DATE('July 16, 2026', '%M %d, %Y')" },
        { name: "Date Literal", sql: "SELECT * FROM orders WHERE order_id > 1000 AND DATE '2026-01-01' <= NOW()" },
        { name: "Timestamp Add", sql: "SELECT TIMESTAMPADD(MONTH, 2, '2026-01-31'), TIMESTAMPADD(HOUR, -5, NOW())" },
        { name: "Days Conversion", sql: "SELECT TO_DAYS('2026-07-17'), FROM_DAYS(TO_DAYS('2026-07-17'))" },
        { name: "Time Builders", sql: "SELECT MAKETIME(9, 30, 0), CURTIME(), UTC_DATE" },
        { name: "Hyperbolic & Aliases", sql: "SELECT COSH(0), TANH(0), TRUNC(3.987, 2), RANDOM(), NVL(NULL, 'fallback')" },
        { name: "Format Bytes", sql: "SELECT FORMAT_BYTES(1536), FORMAT_BYTES(1073741824)" }
      ]},
      { cat: "JSON Functions", cmds: [
        { name: "Extract Path", sql: `SELECT JSON_EXTRACT('{"a": 1, "b": {"c": [10, 20]}}', '$.b.c[1]')` },
        { name: "Build Array / Object", sql: "SELECT JSON_ARRAY(1, 'a', TRUE), JSON_OBJECT('k', 1, 'm', 'x')" },
        { name: "Length & Keys", sql: `SELECT JSON_LENGTH('{"a": 1, "b": 2}'), JSON_KEYS('{"a": 1, "b": 2}')` },
        { name: "Valid & Type", sql: `SELECT JSON_VALID('{"a": 1}'), JSON_TYPE('[1, 2]'), JSON_TYPE('{"a": 1}', '$.a')` },
        { name: "Contains", sql: `SELECT JSON_CONTAINS('{"a": 1, "b": 2}', '{"a": 1}'), JSON_CONTAINS('[1, 2, 3]', '2')` },
        { name: "Set & Remove", sql: `SELECT JSON_SET('{"a": 1}', '$.b', 99), JSON_REMOVE('{"a": 1, "b": 2}', '$.a')` },
        { name: "Quote & Unquote", sql: `SELECT JSON_QUOTE('ab"c'), JSON_UNQUOTE('"hello"')` },
        { name: "Pretty & Depth", sql: `SELECT JSON_PRETTY('{"a": [1, 2]}'), JSON_DEPTH('{"a": [1, 2]}')` },
        { name: "Array Append", sql: `SELECT JSON_ARRAY_APPEND('{"tags": [1, 2]}', '$.tags', 3)` },
        { name: "Merge Patch (RFC 7396)", sql: `SELECT JSON_MERGE_PATCH('{"a": 1, "b": 2}', '{"b": null, "c": 3}')` }
      ]},
      { cat: "Advanced DQL", cmds: [
        { name: "Aggregates", sql: "SELECT COUNT(*), SUM(age), AVG(age), MAX(age), MIN(age) FROM {table}" },
        { name: "Count Distinct", sql: "SELECT COUNT(DISTINCT user_id) FROM orders" },
        { name: "Stats Aggregates", sql: "SELECT STDDEV(age), VARIANCE(age), MEDIAN(age) FROM {table}" },
        { name: "Sample Stats", sql: "SELECT STDDEV_SAMP(age), VAR_SAMP(age), STDDEV_POP(age), VAR_POP(age) FROM {table}" },
        { name: "Bit Aggregates", sql: "SELECT BIT_AND(id), BIT_OR(id), BIT_XOR(id), ANY_VALUE(name) FROM {table}" },
        { name: "Group By Having", sql: "SELECT age, COUNT(*) as c FROM {table} GROUP BY age HAVING c > 0" },
        { name: "Having Aggregate", sql: "SELECT age FROM {table} GROUP BY age HAVING COUNT(*) >= 1 ORDER BY COUNT(*) DESC" },
        { name: "Joins", sql: "SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id" },
        { name: "Join USING / NATURAL", sql: "SELECT * FROM t1 JOIN t2 USING (id) -- 共通列すべてなら: t1 NATURAL JOIN t2" },
        { name: "Intersect All / Except All", sql: "SELECT v FROM t1 INTERSECT ALL SELECT v FROM t2 -- 多重集合演算（重複を保持）" },
        { name: "Comma Join (Implicit)", sql: "SELECT u.name, o.amount FROM users u, orders o WHERE u.id = o.user_id" },
        { name: "Right Join", sql: "SELECT u.name, o.amount FROM orders o RIGHT JOIN users u ON o.user_id = u.id" },
        { name: "Subqueries", sql: "SELECT * FROM {table} WHERE id IN (SELECT user_id FROM orders)" },
        { name: "Correlated EXISTS", sql: "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)" },
        { name: "Correlated Scalar", sql: "SELECT u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count FROM users u" },
        { name: "Recursive CTE", sql: "WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 10) SELECT * FROM seq" },
        { name: "Window Functions", sql: "SELECT id, ROW_NUMBER() OVER(PARTITION BY age ORDER BY id) FROM {table}" },
        { name: "Case When", sql: "SELECT id, CASE WHEN age > 30 THEN 'Senior' ELSE 'Junior' END FROM {table}" },
        { name: "Simple Case", sql: "SELECT id, CASE age WHEN 25 THEN 'young' WHEN 30 THEN 'mid' ELSE 'other' END FROM {table}" },
        { name: "Regexp Match", sql: "SELECT * FROM {table} WHERE name REGEXP '^A'" },
        { name: "Union", sql: "SELECT id, name FROM {table} WHERE id <= 3 UNION SELECT id, name FROM {table} WHERE id >= 3" },
        { name: "Intersect / Except", sql: "SELECT id FROM {table} WHERE id <= 5 INTERSECT SELECT id FROM {table} WHERE id >= 3" },
        { name: "Cross Join", sql: "SELECT u.name, p.name FROM users u CROSS JOIN products p LIMIT 10" },
        { name: "Rank & Dense Rank", sql: "SELECT id, RANK() OVER(ORDER BY age DESC), DENSE_RANK() OVER(ORDER BY age DESC) FROM {table}" },
        { name: "Lag & Lead", sql: "SELECT id, age, LAG(age) OVER(ORDER BY id), LEAD(age) OVER(ORDER BY id) FROM {table}" },
        { name: "Aggregate Over", sql: "SELECT id, age, AVG(age) OVER(), SUM(age) OVER(ORDER BY id) FROM {table}" },
        { name: "Cast", sql: "SELECT CAST(id AS TEXT), CAST(age AS FLOAT) FROM {table}" },
        { name: "Group Concat", sql: "SELECT age, GROUP_CONCAT(name SEPARATOR ', ') FROM {table} GROUP BY age" },
        { name: "Group Concat Ordered", sql: "SELECT GROUP_CONCAT(name ORDER BY age DESC SEPARATOR ' > ') FROM {table}" },
        { name: "JSON Aggregates", sql: "SELECT JSON_ARRAYAGG(name ORDER BY id), JSON_OBJECTAGG(name, age) FROM {table}" },
        { name: "Count Distinct Multi", sql: "SELECT COUNT(DISTINCT user_id, product_id) FROM orders" },
        { name: "Group By Ordinal / Alias", sql: "SELECT age >= 30 AS senior, COUNT(*) FROM {table} GROUP BY senior" },
        { name: "Filter (Conditional Agg)", sql: "SELECT COUNT(*) FILTER (WHERE age >= 30) AS senior, COUNT(*) FILTER (WHERE age < 30) AS junior FROM {table}" },
        { name: "Filter Per Group", sql: "SELECT user_id, COUNT(*) FILTER (WHERE amount > 1) AS big FROM orders GROUP BY user_id" },
        { name: "Generate Series", sql: "SELECT value FROM GENERATE_SERIES(1, 10)" },
        { name: "Generate Series (Step / Alias)", sql: "SELECT n FROM GENERATE_SERIES(0, 100, 10) AS s(n)" },
        { name: "Named Window", sql: "SELECT id, ROW_NUMBER() OVER w AS rn, RANK() OVER w AS rk FROM {table} WINDOW w AS (ORDER BY age DESC)" },
        { name: "Fetch First (SQL Standard)", sql: "SELECT * FROM {table} ORDER BY id OFFSET 2 ROWS FETCH FIRST 3 ROWS ONLY" },
        { name: "Exists", sql: "SELECT * FROM {table} WHERE EXISTS (SELECT 1 FROM orders WHERE amount > 1)" },
        { name: "CTE (WITH)", sql: "WITH adults AS (SELECT * FROM users WHERE age >= 30) SELECT COUNT(*) FROM adults" },
        { name: "Ntile", sql: "SELECT id, NTILE(4) OVER(ORDER BY age DESC) FROM {table}" },
        { name: "First / Last Value", sql: "SELECT id, FIRST_VALUE(name) OVER(ORDER BY age DESC), LAST_VALUE(name) OVER(ORDER BY age DESC) FROM {table}" },
        { name: "Percent Rank & Cume Dist", sql: "SELECT id, PERCENT_RANK() OVER(ORDER BY age), CUME_DIST() OVER(ORDER BY age) FROM {table}" },
        { name: "Window Frame (Moving Avg)", sql: "SELECT id, AVG(age) OVER(ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM {table}" },
        { name: "Window Frame (Running)", sql: "SELECT id, SUM(age) OVER(ORDER BY id ROWS 2 PRECEDING), LAST_VALUE(name) OVER(ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM {table}" },
        { name: "Table Statement", sql: "TABLE {table}" },
        { name: "Nth Value", sql: "SELECT id, NTH_VALUE(name, 2) OVER(ORDER BY age DESC) FROM {table}" },
        { name: "Nulls First / Last", sql: "SELECT * FROM {table} ORDER BY age DESC NULLS LAST" },
        { name: "Select Without FROM", sql: "SELECT 1 + 1 AS calc, NOW() AS now_time" },
        { name: "From Dual (MySQL)", sql: "SELECT 1 + 1, VERSION() FROM DUAL" },
        { name: "Values Statement", sql: "VALUES (1, 'one'), (2, 'two'), (3, 'three')" },
        { name: "Min By / Max By", sql: "SELECT MAX_BY(name, age) AS oldest, MIN_BY(name, age) AS youngest FROM {table}" },
        { name: "Count If", sql: "SELECT COUNT_IF(age >= 30) AS seniors, COUNT_IF(age < 30) AS juniors FROM {table}" },
        { name: "Percentile", sql: "SELECT PERCENTILE_CONT(age, 0.5) AS p50, PERCENTILE_DISC(age, 0.9) AS p90 FROM {table}" },
        { name: "Group By Rollup", sql: "SELECT user_id, COUNT(*) AS c, SUM(amount) AS total FROM orders GROUP BY user_id WITH ROLLUP" },
        { name: "Grouping Flag (Rollup)", sql: "SELECT user_id, GROUPING(user_id) AS is_total, SUM(amount) FROM orders GROUP BY user_id WITH ROLLUP" },
        { name: "CTE Column List", sql: "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT * FROM seq" },
        { name: "Qualify (Window Filter)", sql: "SELECT id, name, ROW_NUMBER() OVER(PARTITION BY age ORDER BY id) AS rn FROM {table} QUALIFY rn = 1" },
        { name: "Like Escape", sql: "SELECT '100%' LIKE '100!%' ESCAPE '!' AS pct, 'abc' LIKE 'a!_c' ESCAPE '!' AS us" },
        { name: "Expression In Like / In", sql: "SELECT * FROM {table} WHERE UPPER(name) LIKE 'A%' AND LENGTH(name) IN (3, 5)" },
        { name: "String Agg / Array Agg", sql: "SELECT STRING_AGG(name, ' / '), ARRAY_AGG(name ORDER BY id) FROM {table}" },
        { name: "Bool Aggregates", sql: "SELECT BOOL_AND(age > 18) AS all_adult, BOOL_OR(age > 35) AS any_senior FROM {table}" },
        { name: "Correlation & Covariance", sql: "SELECT CORR(id, age), COVAR_POP(id, age), COVAR_SAMP(id, age) FROM {table}" },
        { name: "Date Trunc", sql: "SELECT DATE_TRUNC('month', NOW()), DATE_TRUNC('week', NOW())" },
        { name: "Explain Analyze", sql: "EXPLAIN ANALYZE SELECT * FROM {table} WHERE id > 3 ORDER BY age" },
        { name: "Typeof", sql: "SELECT TYPEOF(1), TYPEOF(1.5), TYPEOF('a'), TYPEOF(NULL), TYPEOF(TRUE)" }
      ]},
      { cat: "Data Manipulation (DML)", cmds: [
        { name: "Insert", sql: "INSERT INTO {table} (id, name) VALUES (99, 'Test'), (100, 'Test2')" },
        { name: "Insert (No Columns)", sql: "INSERT INTO users VALUES (999, 'NoCols', 20)" },
        { name: "Insert Select", sql: "INSERT INTO {table} (id, name) SELECT id+10, name FROM {table} LIMIT 5" },
        { name: "Update", sql: "UPDATE {table} SET name = 'Updated', age = 30 WHERE id = 1" },
        { name: "Update Limit", sql: "UPDATE {table} SET age = age + 1 WHERE age > 0 LIMIT 3" },
        { name: "Delete", sql: "DELETE FROM {table} WHERE id = 99" },
        { name: "Delete Limit", sql: "DELETE FROM {table} WHERE id > 90 LIMIT 2" },
        { name: "Insert Default Values", sql: "INSERT INTO {table} DEFAULT VALUES" },
        { name: "Replace Into (Upsert)", sql: "REPLACE INTO {table} (id, name) VALUES (1, 'Replaced')" },
        { name: "Insert Ignore", sql: "INSERT IGNORE INTO {table} (id, name) VALUES (1, 'SkipIfExists')" },
        { name: "On Duplicate Key Update", sql: "INSERT INTO {table} (id, name) VALUES (1, 'New') ON DUPLICATE KEY UPDATE name = 'Updated'" },
        { name: "Insert Set (MySQL)", sql: "INSERT INTO {table} SET id = 999, name = 'ViaSet'" },
        { name: "Insert Expressions", sql: "INSERT INTO {table} (id, name) VALUES (100 + 1, UPPER('bob'))" },
        { name: "Insert DEFAULT Keyword", sql: "INSERT INTO full_tbl (id, name, status) VALUES (DEFAULT, 'Ken', DEFAULT)" },
        { name: "Upsert From Select", sql: "INSERT INTO {table} (id, name) SELECT id + 100, name FROM {table} ON DUPLICATE KEY UPDATE name = 'dup'" },
        { name: "User Variables", sql: "SET @min = 25, @label = 'senior'" },
        { name: "Use Variables", sql: "SELECT @label, name FROM {table} WHERE age >= @min" },
        { name: "Insert Returning", sql: "INSERT INTO {table} (id, name) VALUES (101, 'Ret') RETURNING *" },
        { name: "Update Returning", sql: "UPDATE {table} SET age = age + 1 WHERE id = 1 RETURNING id, age" },
        { name: "Delete Returning", sql: "DELETE FROM {table} WHERE id = 101 RETURNING id, name" },
        { name: "Update Order By Limit", sql: "UPDATE {table} SET age = age + 1 ORDER BY age ASC LIMIT 2" },
        { name: "Delete Order By Limit", sql: "DELETE FROM {table} ORDER BY id DESC LIMIT 1" }
      ]},
      { cat: "Data Definition (DDL)", cmds: [
        { name: "Create Table", sql: "CREATE TABLE new_table (id INTEGER, name TEXT, flag BOOLEAN, dt DATE)" },
        { name: "Create If Not Exists", sql: "CREATE TABLE IF NOT EXISTS new_table (id INTEGER, name TEXT)" },
        { name: "Create Table As Select", sql: "CREATE TABLE {table}_copy AS SELECT * FROM {table}" },
        { name: "Create Table Like", sql: "CREATE TABLE {table}_clone LIKE {table}" },
        { name: "Drop If Exists", sql: "DROP TABLE IF EXISTS old_table" },
        { name: "Create Or Replace View", sql: "CREATE OR REPLACE VIEW my_view AS SELECT * FROM {table} LIMIT 5" },
        { name: "Create with FK", sql: "CREATE TABLE child_tbl (id INTEGER, p_id INTEGER, FOREIGN KEY (p_id) REFERENCES {table}(id))" },
        { name: "PK & Unique", sql: "CREATE TABLE strict_tbl (id INTEGER PRIMARY KEY, email TEXT UNIQUE)" },
        { name: "Composite Keys", sql: "CREATE TABLE line_items (order_id INTEGER, line_no INTEGER, qty INTEGER, PRIMARY KEY (order_id, line_no))" },
        { name: "Add Composite Unique", sql: "ALTER TABLE line_items ADD UNIQUE (order_id, qty)" },
        { name: "Temporary Table", sql: "CREATE TEMPORARY TABLE work_tbl AS SELECT * FROM {table} WHERE id <= 5" },
        { name: "Change Column", sql: "ALTER TABLE {table} CHANGE COLUMN name full_name TEXT" },
        { name: "Create Trigger (Audit)", sql: "CREATE TRIGGER audit_ins AFTER INSERT ON {table} FOR EACH ROW INSERT INTO audit_log (op, detail) VALUES ('INSERT', NEW.name)" },
        { name: "Create Trigger (Update)", sql: "CREATE TRIGGER audit_upd AFTER UPDATE ON {table} FOR EACH ROW INSERT INTO audit_log (op, detail) VALUES ('UPDATE', CONCAT(OLD.name, ' -> ', NEW.name))" },
        { name: "Drop Trigger", sql: "DROP TRIGGER IF EXISTS audit_ins" },
        { name: "Constraints", sql: "CREATE TABLE full_tbl (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active')" },
        { name: "Default Current Timestamp", sql: "CREATE TABLE logs_tbl (id INTEGER PRIMARY KEY AUTO_INCREMENT, msg TEXT, created_at DEFAULT CURRENT_TIMESTAMP)" },
        { name: "Generated Column", sql: "CREATE TABLE rect (w INTEGER, h INTEGER, area GENERATED ALWAYS AS (w * h) STORED)" },
        { name: "Generated Column (Short)", sql: "CREATE TABLE person (first TEXT, last TEXT, full AS (CONCAT(first, ' ', last)))" },
        { name: "Add / Drop Column If Exists", sql: "ALTER TABLE {table} ADD COLUMN IF NOT EXISTS memo TEXT" },
        { name: "Modify Column Type", sql: "ALTER TABLE {table} MODIFY COLUMN id INTEGER" },
        { name: "Create View", sql: "CREATE VIEW my_view AS SELECT * FROM {table} LIMIT 5" },
        { name: "Drop View", sql: "DROP VIEW my_view" },
        { name: "Add Column", sql: "ALTER TABLE {table} ADD COLUMN new_col INTEGER" },
        { name: "Add Column + Default", sql: "ALTER TABLE {table} ADD COLUMN status TEXT DEFAULT 'active' NOT NULL" },
        { name: "Rename Column", sql: "ALTER TABLE {table} RENAME COLUMN id TO new_id" },
        { name: "Rename Table", sql: "ALTER TABLE {table} RENAME TO renamed_tbl" },
        { name: "Rename Table (MySQL)", sql: "RENAME TABLE {table} TO renamed_tbl" },
        { name: "Drop Column", sql: "ALTER TABLE {table} DROP COLUMN name" },
        { name: "Add / Drop Primary Key", sql: "ALTER TABLE {table} ADD PRIMARY KEY (id)" },
        { name: "Add Unique", sql: "ALTER TABLE {table} ADD UNIQUE (name)" },
        { name: "Add Foreign Key", sql: "ALTER TABLE child_tbl ADD FOREIGN KEY (p_id) REFERENCES {table}(id)" },
        { name: "Set Default", sql: "ALTER TABLE {table} ALTER COLUMN name SET DEFAULT 'N/A'" },
        { name: "Set Not Null", sql: "ALTER TABLE {table} ALTER COLUMN name SET NOT NULL" },
        { name: "Create Index", sql: "CREATE INDEX idx_col ON {table} (id)" },
        { name: "Create Index If Not Exists", sql: "CREATE INDEX IF NOT EXISTS idx_col ON {table} (id)" },
        { name: "Drop Index", sql: "DROP INDEX idx_col ON {table} (id)" },
        { name: "Drop Index If Exists", sql: "DROP INDEX IF EXISTS ON {table} (id)" },
        { name: "Add Column Positioned", sql: "ALTER TABLE {table} ADD COLUMN new_col INTEGER AFTER id" },
        { name: "Drop Multiple Tables", sql: "DROP TABLE IF EXISTS tmp_a, tmp_b, tmp_c" },
        { name: "Truncate/Drop", sql: "TRUNCATE TABLE {table}" }
      ]},
      { cat: "Metadata / Introspection", cmds: [
        { name: "Show Tables", sql: "SHOW TABLES" },
        { name: "Show Tables Like", sql: "SHOW TABLES LIKE 'use%'" },
        { name: "Show Views", sql: "SHOW VIEWS" },
        { name: "Show Procedures", sql: "SHOW PROCEDURES" },
        { name: "Show Indexes", sql: "SHOW INDEXES" },
        { name: "Show Create Table", sql: "SHOW CREATE TABLE {table}" },
        { name: "Show Create View", sql: "SHOW CREATE VIEW my_view" },
        { name: "Show Columns", sql: "SHOW COLUMNS FROM {table}" },
        { name: "Show Create Procedure", sql: "SHOW CREATE PROCEDURE my_proc" },
        { name: "Show Status", sql: "SHOW STATUS" },
        { name: "Show Checks", sql: "SHOW CHECKS FROM {table}" },
        { name: "Show Triggers / Variables", sql: "SHOW TRIGGERS" },
        { name: "Show Triggers From Table", sql: "SHOW TRIGGERS FROM {table}" },
        { name: "Show Functions", sql: "SHOW FUNCTIONS LIKE 'JSON%'" },
        { name: "Check Table (Integrity)", sql: "CHECK TABLE {table}" },
        { name: "Analyze Table (Statistics)", sql: "ANALYZE TABLE {table}" },
        { name: "Describe Table", sql: "DESCRIBE {table}" }
      ]},
      { cat: "Tools & Transactions", cmds: [
        { name: "Explain Query", sql: "EXPLAIN SELECT * FROM {table} WHERE id = 1" },
        { name: "Create Procedure", sql: "CREATE PROCEDURE my_proc AS BEGIN SELECT * FROM {table} LIMIT 3 END" },
        { name: "Replace Procedure", sql: "CREATE OR REPLACE PROCEDURE my_proc AS SELECT COUNT(*) FROM {table}" },
        { name: "Vacuum / Optimize", sql: "VACUUM" },
        { name: "Call Procedure", sql: "CALL my_proc" },
        { name: "Drop Procedure", sql: "DROP PROCEDURE my_proc" },
        { name: "Begin Tx", sql: "BEGIN" },
        { name: "Start Transaction", sql: "START TRANSACTION" },
        { name: "Commit Tx", sql: "COMMIT" },
        { name: "Rollback Tx", sql: "ROLLBACK" },
        { name: "Savepoint", sql: "SAVEPOINT sp1" },
        { name: "Rollback to Savepoint", sql: "ROLLBACK TO SAVEPOINT sp1" },
        { name: "Release Savepoint", sql: "RELEASE SAVEPOINT sp1" }
      ]},
      { cat: "External API", cmds: [
        { name: "JS API", sql: "// JSコンソールから: LuminaDB.query('SELECT * FROM users WHERE id = ?', [1])" },
        { name: "JS API (Named Params)", sql: "// LuminaDB.query('SELECT * FROM users WHERE age > :min AND age < @max', { min: 24, max: 31 })" },
        { name: "JS API (Insert Object)", sql: "// LuminaDB.insert('users', { id: 11, name: 'Ken', age: 20 })  // 配列で複数行も可" },
        { name: "JS API (Multi Statement)", sql: "// LuminaDB.exec('CREATE TABLE t (id INTEGER); INSERT INTO t (id) VALUES (1);')" },
        { name: "JS API (Select Helper)", sql: "// LuminaDB.select('users', { columns: ['id', 'name'], where: { age: 25 }, orderBy: 'id DESC', limit: 5 })" },
        { name: "JS API (Update / Remove)", sql: "// LuminaDB.update('users', { age: 26 }, { id: 1 })  /  LuminaDB.remove('users', { id: 1 })" },
        { name: "JS API (Count)", sql: "// LuminaDB.count('users', { age: 25 }).count" },
        { name: "JS API (Upsert)", sql: "// LuminaDB.upsert('users', { id: 1, name: 'Alice2', age: 26 })" },
        { name: "JS API (Transaction)", sql: "// LuminaDB.transaction(api => { api.insert('t', {...}); api.update('t', {...}, {...}); })  // throwでROLLBACK" },
        { name: "JS API (Status)", sql: "// LuminaDB.status().status.total_rows" },
        { name: "Fetch API (GET)", sql: "// fetch('lumina://query?sql=' + encodeURIComponent('SELECT * FROM users'))" },
        { name: "Fetch API (POST)", sql: "// fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }) })" },
        { name: "Table List", sql: "// fetch('lumina://tables').then(r => r.json())" }
      ]}
    ];

    // Use Event Delegation for command buttons
    document.getElementById('helpContent').addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-cmd-btn');
      if (btn) {
        setQueryValue(btn.dataset.query);
        document.getElementById('helpModal').classList.add('hidden');
        els.query.focus();
      }
    });

    function renderHelpCommands() {
      const tbl = document.getElementById('helpTableSelect').value || 'users';

      const createCommandHTML = (cmd) => {
        const q = cmd.sql.replace(/\{table\}/g, tbl);
        return `
          <div class="bg-gray-50 p-3 rounded-lg border border-gray-200 flex justify-between items-center hover:border-gray-300 transition-colors">
            <span class="font-mono text-xs text-blue-600 truncate mr-2 font-medium">${q}</span>
            <button class="bg-white hover:bg-gray-100 border border-gray-300 text-gray-700 text-[10px] px-3 py-1.5 rounded shadow-sm font-semibold copy-cmd-btn transition-colors" data-query="${q.replace(/"/g, '&quot;')}">Use</button>
          </div>`;
      };

      const createCategoryHTML = (group) => `
        <div class="mb-4">
          <h3 class="text-xs font-bold text-gray-400 uppercase border-b border-gray-100 pb-1 mb-2 tracking-wider">${group.cat}</h3>
          <div class="space-y-3">
            ${group.cmds.map(createCommandHTML).join('')}
          </div>
        </div>`;

      document.getElementById('helpContent').innerHTML = helpData.map(createCategoryHTML).join('');
    }

    document.getElementById('helpTableSelect').addEventListener('change', renderHelpCommands);
