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
      { cat: "Commercial SQL (Oracle / SQL Server / PostgreSQL)", cmds: [
        { name: "Decode (Oracle)", sql: "SELECT id, DECODE(age, 25, 'young', 30, 'mid', 'other') AS grp FROM {table}" },
        { name: "Nvl2 (Oracle)", sql: "SELECT name, NVL2(name, 'has name', 'no name') AS chk FROM {table}" },
        { name: "IsNull / ZeroIfNull / NullIfZero", sql: "SELECT ISNULL(NULL, 'N/A'), ZEROIFNULL(NULL), NULLIFZERO(0)" },
        { name: "Choose (SQL Server)", sql: "SELECT CHOOSE(2, 'gold', 'silver', 'bronze') AS medal" },
        { name: "Starts With / Ends With", sql: "SELECT name FROM {table} WHERE STARTS_WITH(name, 'A') OR ENDS_WITH(name, 'e')" },
        { name: "CharIndex / Len / Stuff (SQL Server)", sql: "SELECT CHARINDEX('l', 'hello') AS pos, LEN('abc   ') AS ln, STUFF('abcdef', 2, 3, 'XY') AS s" },
        { name: "Regexp Instr", sql: "SELECT REGEXP_INSTR('order#123', '[0-9]+') AS pos" },
        { name: "Square / Pow", sql: "SELECT SQUARE(7) AS sq, POW(2, 10) AS p" },
        { name: "Gcd / Lcm / Factorial", sql: "SELECT GCD(12, 18) AS g, LCM(4, 6) AS l, FACTORIAL(5) AS f" },
        { name: "Width Bucket (Histogram)", sql: "SELECT id, age, WIDTH_BUCKET(age, 20, 40, 4) AS bucket FROM {table} ORDER BY age" },
        { name: "Add Months / Months Between (Oracle)", sql: "SELECT ADD_MONTHS('2026-01-31', 1) AS nx, MONTHS_BETWEEN('2026-03-15', '2026-01-15') AS diff" },
        { name: "Date Part / GetDate", sql: "SELECT DATE_PART('year', NOW()) AS yr, DATE_PART('dow', NOW()) AS dow, GETDATE() AS now_ts" },
        { name: "Listagg (Oracle Aggregate)", sql: "SELECT LISTAGG(name, ', ') AS names FROM {table}" },
        { name: "To Number / To Date / To Timestamp", sql: "SELECT TO_NUMBER('1,234.5') AS n, TO_DATE('2026-07-23 10:00:00') AS d, TO_TIMESTAMP('2026-07-23') AS ts" },
        { name: "Eomonth / Make Date (Date Builders)", sql: "SELECT EOMONTH('2026-02-10') AS eom, EOMONTH('2026-02-10', 1) AS next_eom, MAKE_DATE(2026, 7, 23) AS md" },
        { name: "Make Timestamp", sql: "SELECT MAKE_TIMESTAMP(2026, 7, 23, 14, 30, 0) AS ts" },
        { name: "Bitwise (BITAND / BITOR / BITXOR)", sql: "SELECT BITAND(12, 10) AS a, BITOR(12, 10) AS o, BITXOR(12, 10) AS x, BITNOT(0) AS n" },
        { name: "IsNumeric / Chr / Strpos", sql: "SELECT ISNUMERIC('123') AS n1, ISNUMERIC('ab') AS n2, CHR(65) AS c, STRPOS('hello', 'll') AS p" },
        { name: "QuoteName / PatIndex / Replicate", sql: "SELECT QUOTENAME('col name') AS q, PATINDEX('%[0-9]%', 'abc123') AS pos, REPLICATE('ab', 3) AS r" }
      ]},
      { cat: "Operators & Predicates", cmds: [
        { name: "String Concat (||)", sql: "SELECT name || ' (' || age || ')' AS label FROM {table}" },
        { name: "Cast Operator (::)", sql: "SELECT '42'::INTEGER + 1 AS n, age::TEXT AS s FROM {table} LIMIT 3" },
        { name: "ILIKE (case-insensitive)", sql: "SELECT * FROM {table} WHERE name ILIKE 'a%'" },
        { name: "SIMILAR TO (SQL standard)", sql: "SELECT * FROM {table} WHERE name SIMILAR TO '(A|B)%'" },
        { name: "IS [NOT] UNKNOWN", sql: "SELECT id FROM {table} WHERE (age > 100) IS NOT UNKNOWN" },
        { name: "Row Constructor Compare", sql: "SELECT * FROM {table} WHERE (id, age) = (1, 25)" },
        { name: "Row Constructor IN", sql: "SELECT * FROM {table} WHERE (id, age) IN ((1, 25), (2, 30))" },
        { name: "System Variables (@@)", sql: "SELECT @@version AS ver, @@identity AS last_id" }
      ]},
      { cat: "Query Shorthands", cmds: [
        { name: "DISTINCT ON (PostgreSQL)", sql: "SELECT DISTINCT ON (user_id) user_id, amount FROM orders ORDER BY user_id, amount DESC" },
        { name: "SELECT * EXCLUDE", sql: "SELECT * EXCLUDE (age) FROM {table}" },
        { name: "SELECT * REPLACE", sql: "SELECT * REPLACE (age * 2 AS age) FROM {table}" },
        { name: "GROUP BY ALL", sql: "SELECT age, COUNT(*) AS c FROM {table} GROUP BY ALL" },
        { name: "FETCH FIRST ... WITH TIES", sql: "SELECT * FROM {table} ORDER BY age DESC FETCH FIRST 3 ROWS WITH TIES" },
        { name: "MINUS (Oracle)", sql: "SELECT id FROM {table} MINUS SELECT 1" },
        { name: "Derived Table Columns", sql: "SELECT a, b FROM (SELECT id, name FROM {table}) AS d(a, b)" },
        { name: "FROM (VALUES ...)", sql: "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, label)" },
        { name: "STRING_SPLIT (table fn)", sql: "SELECT value FROM STRING_SPLIT('a,b,c', ',')" },
        { name: "UNNEST (table fn)", sql: "SELECT n FROM UNNEST(10, 20, 30) AS u(n)" }
      ]},
      { cat: "Multi-table DML", cmds: [
        { name: "UPDATE ... FROM (PostgreSQL)", sql: "UPDATE orders SET amount = amount + 1 FROM users WHERE orders.user_id = users.id AND users.age > 30" },
        { name: "UPDATE ... JOIN (MySQL)", sql: "UPDATE orders o JOIN users u ON o.user_id = u.id SET o.amount = 9 WHERE u.age > 30" },
        { name: "DELETE ... USING (PostgreSQL)", sql: "DELETE FROM orders USING users WHERE orders.user_id = users.id AND users.age > 90" },
        { name: "DELETE t FROM t JOIN s (MySQL)", sql: "DELETE o FROM orders o JOIN users u ON o.user_id = u.id WHERE u.age > 90" },
        { name: "INSERT DEFAULT VALUES", sql: "INSERT INTO {table} DEFAULT VALUES" }
      ]},
      { cat: "Catalog & Functions", cmds: [
        { name: "Create Function", sql: "CREATE OR REPLACE FUNCTION tax(amount) RETURNS FLOAT AS RETURN ROUND(amount * 1.1, 2)" },
        { name: "Use Function", sql: "SELECT price, tax(price) AS with_tax FROM products" },
        { name: "Drop Function", sql: "DROP FUNCTION IF EXISTS tax" },
        { name: "Information Schema (Tables)", sql: "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.tables" },
        { name: "Information Schema (Columns)", sql: "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.columns WHERE TABLE_NAME = '{table}'" },
        { name: "Information Schema (Constraints)", sql: "SELECT * FROM information_schema.table_constraints" },
        { name: "Unique / Multi-column Index", sql: "CREATE UNIQUE INDEX idx_name ON {table} (name)" },
        { name: "Drop Index by Name", sql: "DROP INDEX IF EXISTS idx_name" }
      ]},
      { cat: "Browser DB Operations", cmds: [
        { name: "Statement Timeout", sql: "SET statement_timeout = 500" },
        { name: "Read-only Mode", sql: "SET read_only = ON" },
        { name: "Deterministic RAND", sql: "SET seed = 0.42; SELECT ROUND(RAND() * 100) AS r" },
        { name: "Create Snapshot", sql: "CREATE SNAPSHOT before_import" },
        { name: "Restore Snapshot", sql: "RESTORE SNAPSHOT before_import" },
        { name: "List / Drop Snapshots", sql: "SHOW SNAPSHOTS" },
        { name: "Last Query Profile", sql: "SHOW PROFILE" },
        { name: "Slow Query Log", sql: "SHOW SLOW QUERIES" },
        { name: "JS API (Live Query)", sql: "// const sub = LuminaDB.subscribe('SELECT COUNT(*) AS c FROM users', rows => console.log(rows)); sub.unsubscribe()" },
        { name: "JS API (Read-only / Timeout)", sql: "// LuminaDB.readOnly(true); LuminaDB.timeout(500)" },
        { name: "JS API (Snapshot / Restore)", sql: "// LuminaDB.snapshot('p1'); LuminaDB.restore('p1')" },
        { name: "JS API (JSON I/O)", sql: "// LuminaDB.importJSON('t', [{ id: 1 }], { create: true }); LuminaDB.exportJSON(['t'])" }
      ]},
      { cat: "Operators & Search", cmds: [
        { name: "Date + INTERVAL", sql: "SELECT DATE '2026-01-31' + INTERVAL 1 MONTH AS next_month, NOW() - INTERVAL 7 DAY AS week_ago" },
        { name: "Interval (string form)", sql: "SELECT DATE '2026-01-01' + INTERVAL '2 weeks' AS d" },
        { name: "COLLATE (case-insensitive)", sql: "SELECT * FROM {table} WHERE name COLLATE NOCASE = 'alice'" },
        { name: "COLLATE (natural sort)", sql: "SELECT name FROM {table} ORDER BY name COLLATE NUMERIC" },
        { name: "COLLATE (accent-insensitive)", sql: "SELECT ('がぎ' COLLATE NOACCENT = 'かき') AS same" },
        { name: "Full-text MATCH ... AGAINST", sql: "SELECT * FROM {table} WHERE MATCH(name) AGAINST('alice bob')" },
        { name: "Full-text (boolean mode)", sql: "SELECT * FROM {table} WHERE MATCH(name) AGAINST('+alice -bob' IN BOOLEAN MODE)" },
        { name: "Full-text (relevance score)", sql: "SELECT name, MATCH(name) AGAINST('alice bob') AS score FROM {table} ORDER BY score DESC" },
        { name: "LIKE ANY / ALL", sql: "SELECT * FROM {table} WHERE name LIKE ANY ('A%', 'B%')" },
        { name: "IGNORE NULLS (window)", sql: "SELECT id, LAG(age) IGNORE NULLS OVER (ORDER BY id) AS prev FROM {table}" }
      ]},
      { cat: "Tables from JSON & Sampling", cmds: [
        { name: "JSON_TABLE (array to rows)", sql: "SELECT * FROM JSON_TABLE('[{\"id\":1,\"nm\":\"a\"},{\"id\":2,\"nm\":\"b\"}]', '$[*]' COLUMNS (id INT PATH '$.id', nm TEXT PATH '$.nm')) t" },
        { name: "JSON_TABLE (nested key)", sql: "SELECT * FROM JSON_TABLE('{\"items\":[{\"v\":1}]}', '$.items[*]' COLUMNS (v INT PATH '$.v')) t" },
        { name: "TABLESAMPLE (percent)", sql: "SELECT * FROM {table} TABLESAMPLE (25 PERCENT)" },
        { name: "TABLESAMPLE (fixed rows)", sql: "SELECT * FROM {table} TABLESAMPLE (100 ROWS)" },
        { name: "TABLESAMPLE (reproducible)", sql: "SELECT * FROM {table} TABLESAMPLE (50 PERCENT) REPEATABLE (42)" }
      ]},
      { cat: "Stored Procedure Logic", cmds: [
        { name: "IF / ELSEIF / ELSE", sql: "CREATE OR REPLACE PROCEDURE grade(s) AS BEGIN\n  DECLARE g TEXT;\n  IF s >= 90 THEN SET g = 'A';\n  ELSEIF s >= 70 THEN SET g = 'B';\n  ELSE SET g = 'C';\n  END IF;\n  RETURN g;\nEND" },
        { name: "WHILE loop", sql: "CREATE OR REPLACE PROCEDURE total(n) AS BEGIN\n  DECLARE i INT DEFAULT 1;\n  DECLARE s INT DEFAULT 0;\n  WHILE i <= n DO SET s = s + i; SET i = i + 1; END WHILE;\n  RETURN s;\nEND" },
        { name: "LOOP with LEAVE", sql: "CREATE OR REPLACE PROCEDURE countdown(n) AS BEGIN\n  DECLARE i INT DEFAULT 0;\n  lp: LOOP SET i = i + 1; IF i >= n THEN LEAVE lp; END IF; END LOOP;\n  RETURN i;\nEND" },
        { name: "REPEAT ... UNTIL", sql: "CREATE OR REPLACE PROCEDURE step2(n) AS BEGIN\n  DECLARE i INT DEFAULT 0;\n  REPEAT SET i = i + 2; UNTIL i >= n END REPEAT;\n  RETURN i;\nEND" },
        { name: "Call with arguments", sql: "CALL grade(85)" },
        { name: "Procedure that writes rows", sql: "CREATE OR REPLACE PROCEDURE seed(n) AS BEGIN\n  DECLARE i INT DEFAULT 0;\n  WHILE i < n DO INSERT INTO {table} (id) VALUES (1000 + i); SET i = i + 1; END WHILE;\nEND" }
      ]},
      { cat: "Introspection & Schema Ops", cmds: [
        { name: "PRAGMA table_info", sql: "PRAGMA table_info({table})" },
        { name: "PRAGMA table_list", sql: "PRAGMA table_list" },
        { name: "PRAGMA foreign_key_list", sql: "PRAGMA foreign_key_list({table})" },
        { name: "PRAGMA user_version", sql: "PRAGMA user_version" },
        { name: "sqlite_master", sql: "SELECT type, name, sql FROM sqlite_master ORDER BY type, name" },
        { name: "ON UPDATE CURRENT_TIMESTAMP", sql: "CREATE TABLE audit_demo (id INTEGER PRIMARY KEY, v INTEGER, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)" },
        { name: "DECLARE @var (T-SQL)", sql: "DECLARE @min INT = 25; SELECT * FROM {table} WHERE age > @min" },
        { name: "EXPLAIN (FORMAT JSON)", sql: "EXPLAIN (FORMAT JSON) SELECT * FROM {table}" },
        { name: "DROP TABLE ... CASCADE", sql: "DROP TABLE IF EXISTS parent_demo CASCADE" }
      ]},
      { cat: "Browser DB Essentials", cmds: [
        { name: "JS API (run off the UI thread)", sql: "// await LuminaDB.worker.start(); await LuminaDB.worker.sync();\n// const r = await LuminaDB.worker.query('SELECT COUNT(*) FROM big'); await LuminaDB.worker.pull();" },
        { name: "JS API (worker timeout)", sql: "// await LuminaDB.worker.timeout(2000)   // ワーカー側の文単位タイムアウト" },
        { name: "JS API (schema migration)", sql: "// LuminaDB.migrate([\n//   { version: 1, up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)' },\n//   { version: 2, up: api => api.exec('ALTER TABLE notes ADD COLUMN tag TEXT') }\n// ])" },
        { name: "JS API (schema version)", sql: "// LuminaDB.schemaVersion()      // PRAGMA user_version と同じ値" },
        { name: "JS API (backup to file)", sql: "// LuminaDB.download('mydb.json')          // ダウンロード\n// LuminaDB.restoreBackup(await file.text()) // 復元" },
        { name: "JS API (backup as string)", sql: "// const text = LuminaDB.backup()" }
      ]},
      { cat: "Cursors & Error Handling", cmds: [
        { name: "Cursor loop (row by row)", sql: "CREATE OR REPLACE PROCEDURE walk() AS BEGIN\n  DECLARE done INT DEFAULT 0;\n  DECLARE v INT;\n  DECLARE c CURSOR FOR SELECT id FROM {table};\n  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;\n  OPEN c;\n  read_loop: LOOP\n    FETCH c INTO v;\n    IF done = 1 THEN LEAVE read_loop; END IF;\n  END LOOP;\n  CLOSE c;\nEND" },
        { name: "Catch errors (CONTINUE HANDLER)", sql: "CREATE OR REPLACE PROCEDURE safe() AS BEGIN\n  DECLARE st TEXT DEFAULT 'ok';\n  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET st = 'failed';\n  SELECT * FROM missing_table;\n  RETURN st;\nEND" },
        { name: "Abort on error (EXIT HANDLER)", sql: "CREATE OR REPLACE PROCEDURE guarded() AS BEGIN\n  DECLARE EXIT HANDLER FOR SQLEXCEPTION SELECT 'aborted' AS status;\n  INSERT INTO {table} (id) VALUES (1);\nEND" },
        { name: "Raise an error (SIGNAL)", sql: "CREATE OR REPLACE PROCEDURE check_positive(n) AS BEGIN\n  IF n < 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'n must be >= 0'; END IF;\n  RETURN n;\nEND" },
        { name: "Handle a specific SQLSTATE", sql: "// DECLARE CONTINUE HANDLER FOR SQLSTATE '45000' SET msg = 'business rule hit';" },
        { name: "CASE statement", sql: "CREATE OR REPLACE PROCEDURE label(n) AS BEGIN\n  CASE n\n    WHEN 1 THEN RETURN 'one';\n    WHEN 2 THEN RETURN 'two';\n    ELSE RETURN 'many';\n  END CASE;\nEND" }
      ]},
      { cat: "Ranges, JSON & Time Buckets", cmds: [
        { name: "OVERLAPS (period intersection)", sql: "SELECT (DATE '2026-01-01', DATE '2026-06-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01') AS conflicts" },
        { name: "BETWEEN SYMMETRIC", sql: "SELECT * FROM {table} WHERE age BETWEEN SYMMETRIC 30 AND 25" },
        { name: "IS JSON", sql: "SELECT * FROM {table} WHERE '{\"a\":1}' IS JSON OBJECT" },
        { name: "JSON_EXISTS / JSON_QUERY", sql: "SELECT JSON_EXISTS('{\"a\":{\"b\":1}}', '$.a.b') AS has_it, JSON_QUERY('{\"a\":{\"b\":1}}', '$.a') AS sub" },
        { name: "DATE_BIN / TIME_BUCKET", sql: "SELECT DATE_BIN(INTERVAL 1 HOUR, NOW()) AS hour_bucket" },
        { name: "Bucketed time series", sql: "SELECT TIME_BUCKET(INTERVAL 1 HOUR, NOW()) AS bucket, COUNT(*) AS n FROM {table} GROUP BY TIME_BUCKET(INTERVAL 1 HOUR, NOW())" },
        { name: "AGE (interval between dates)", sql: "SELECT AGE(DATE '2028-03-15', DATE '2026-01-20') AS gap" },
        { name: "EXTRACT EPOCH / DOW / DOY", sql: "SELECT EXTRACT(EPOCH FROM NOW()) AS unix_ts, EXTRACT(DOW FROM NOW()) AS weekday" }
      ]},
      { cat: "Schema & Planner Compatibility", cmds: [
        { name: "Schema-qualified names", sql: "SELECT COUNT(*) FROM main.{table}" },
        { name: "CREATE / DROP SCHEMA", sql: "CREATE SCHEMA app" },
        { name: "Partial index", sql: "CREATE INDEX idx_active ON {table} (age) WHERE age > 25" },
        { name: "SELECT ... FOR UPDATE", sql: "SELECT * FROM {table} WHERE id = 1 FOR UPDATE" },
        { name: "CTE materialization hint", sql: "WITH c AS MATERIALIZED (SELECT id FROM {table}) SELECT COUNT(*) FROM c" },
        { name: "EXPLAIN QUERY PLAN", sql: "EXPLAIN QUERY PLAN SELECT * FROM {table} WHERE id = 1" }
      ]},
      { cat: "Persistence & Streaming", cmds: [
        { name: "JS API (batched read)", sql: "// LuminaDB.eachBatch('SELECT * FROM big ORDER BY id', [], 1000, rows => render(rows))" },
        { name: "JS API (row cursor)", sql: "// for (const row of LuminaDB.cursor('SELECT * FROM big ORDER BY id')) { /* ... */ }" },
        { name: "JS API (incremental save stats)", sql: "// LuminaDB.saveStats()   // { tables, written, skipped, removed } — 差分保存が効いているかの確認" },
        { name: "JS API (follow other tabs)", sql: "// LuminaDB.autoReload(true)   // 他タブの保存を自動で読み直す" }
      ]},
      { cat: "Arrays & Fuzzy Matching", cmds: [
        { name: "ARRAY constructor", sql: "SELECT ARRAY_TO_STRING(ARRAY[1, 2, 3], '-') AS joined, ARRAY_LENGTH(ARRAY[1, 2, 3]) AS n" },
        { name: "Array membership", sql: "SELECT * FROM {table} WHERE id = ANY(ARRAY[1, 2, 3])" },
        { name: "String ↔ array", sql: "SELECT ARRAY_TO_STRING(STRING_TO_ARRAY('a,b,c', ','), ' | ') AS s" },
        { name: "Array edit helpers", sql: "SELECT ARRAY_TO_STRING(ARRAY_REMOVE(ARRAY_APPEND(ARRAY[1, 2], 3), 1), ',') AS s" },
        { name: "Fuzzy search (LEVENSHTEIN)", sql: "SELECT name FROM {table} WHERE LEVENSHTEIN(name, 'Alise') <= 2" },
        { name: "Rank by SIMILARITY", sql: "SELECT name, SIMILARITY(name, 'Alise') AS score FROM {table} ORDER BY score DESC LIMIT 5" },
        { name: "Sounds-like (DIFFERENCE)", sql: "SELECT DIFFERENCE('Robert', 'Rupert') AS closeness" },
        { name: "REGEXP_MATCHES / SPLIT", sql: "SELECT ARRAY_TO_STRING(REGEXP_MATCHES('a1b2', '[0-9]', 'g'), ',') AS digits" },
        { name: "DIV / SAFE_DIVIDE", sql: "SELECT DIV(7, 2) AS whole, SAFE_DIVIDE(1, 0) AS no_error" }
      ]},
      { cat: "Statistics & Time Series", cmds: [
        { name: "Linear regression", sql: "SELECT REGR_SLOPE(price, stock) AS slope, REGR_INTERCEPT(price, stock) AS intercept, REGR_R2(price, stock) AS r2 FROM products" },
        { name: "Regression detail", sql: "SELECT REGR_COUNT(price, stock) AS n, REGR_AVGX(price, stock) AS avg_x, REGR_AVGY(price, stock) AS avg_y FROM products" },
        { name: "MODE (most common value)", sql: "SELECT MODE() WITHIN GROUP (ORDER BY age) AS most_common FROM {table}" },
        { name: "Hourly buckets (gap-free)", sql: "SELECT value AS hour FROM GENERATE_SERIES(TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-01-01 23:00:00', INTERVAL 1 HOUR)" },
        { name: "Daily series + LEFT JOIN", sql: "SELECT d.value AS day, COUNT(o.order_id) AS n\nFROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-07', INTERVAL 1 DAY) d\nLEFT JOIN orders o ON 1 = 0\nGROUP BY d.value ORDER BY day" },
        { name: "WITH ORDINALITY", sql: "SELECT v, n FROM GENERATE_SERIES(10, 30, 10) WITH ORDINALITY AS t(v, n)" },
        { name: "AT TIME ZONE", sql: "SELECT NOW() AT TIME ZONE '+09:00' AS tokyo, NOW() AT TIME ZONE 'UTC' AS utc" }
      ]},
      { cat: "Window Extras", cmds: [
        { name: "Running total excluding self", sql: "SELECT id, SUM(age) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) AS others FROM {table}" },
        { name: "EXCLUDE GROUP / TIES", sql: "SELECT id, COUNT(*) OVER (ORDER BY age RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) AS c FROM {table}" },
        { name: "Window FILTER", sql: "SELECT id, SUM(age) FILTER (WHERE age > 25) OVER () AS adults_total FROM {table}" },
        { name: "Window FILTER by partition", sql: "SELECT id, COUNT(*) FILTER (WHERE age > 25) OVER (PARTITION BY age) AS n FROM {table}" }
      ]},
      { cat: "CSV, Cache & Coordination", cmds: [
        { name: "JS API (import CSV text)", sql: "// LuminaDB.importCSV(await file.text(), 'sales', { create: true })\n// opts: { create, header, delimiter, replace }" },
        { name: "JS API (export a table as CSV)", sql: "// LuminaDB.exportCSV('sales')" },
        { name: "JS API (compile cache stats)", sql: "// LuminaDB.cacheStats()   // { hits, misses, size, hitRate } — 同じ形のクエリの再コンパイルを省けているか" },
        { name: "JS API (leader tab election)", sql: "// const h = LuminaDB.onLeader(() => startBackgroundSync());\n// h.release();   // 別タブが自動的に昇格する" },
        { name: "Maintenance no-ops", sql: "REINDEX" }
      ]},
      { cat: "Type Conversion with Precision", cmds: [
        { name: "CAST AS DECIMAL(p, s)", sql: "SELECT CAST(1.005 AS DECIMAL(10,2)) AS rounded" },
        { name: "CAST AS VARCHAR(n) (truncates)", sql: "SELECT CAST(12345 AS VARCHAR(3)) AS truncated" },
        { name: "CAST AS BIGINT / DOUBLE PRECISION", sql: "SELECT CAST(3.7 AS BIGINT) AS i, CAST('1.25' AS DOUBLE PRECISION) AS d" },
        { name: "CONVERT (SQL Server order)", sql: "SELECT CONVERT(DECIMAL(5,1), 3.14159) AS s" },
        { name: "CAST AS TIME", sql: "SELECT CAST('2020-05-06 13:14:15' AS TIME) AS t" }
      ]},
      { cat: "Updatable Views", cmds: [
        { name: "CREATE VIEW ... WITH CHECK OPTION", sql: "CREATE VIEW v_upd AS SELECT id, name, age FROM {table} WHERE age >= 30 WITH CHECK OPTION" },
        { name: "UPDATE through a view", sql: "UPDATE v_upd SET name = 'Bobby' WHERE id = 2" },
        { name: "INSERT through a view", sql: "INSERT INTO v_upd (id, name, age) VALUES (99, 'New', 40)" },
        { name: "DELETE through a view", sql: "DELETE FROM v_upd WHERE id = 99" },
        { name: "INSTEAD OF trigger (writable aggregate view)", sql: "CREATE TRIGGER tg_io INSTEAD OF INSERT ON v_upd FOR EACH ROW INSERT INTO {table} (id, name, age) VALUES (NEW.id, NEW.name, NEW.age)" },
        { name: "Check updatability", sql: "SELECT table_name, is_updatable, check_option FROM information_schema.views" }
      ]},
      { cat: "Constraints & Keys", cmds: [
        { name: "Column-level REFERENCES", sql: "CREATE TABLE v18_child (id INTEGER, pid INTEGER REFERENCES {table}(id) ON DELETE CASCADE)" },
        { name: "REFERENCES without a column (uses PK)", sql: "CREATE TABLE v18_child2 (id INTEGER, pid INTEGER REFERENCES {table})" },
        { name: "ADD CONSTRAINT name FOREIGN KEY", sql: "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)" },
        { name: "ADD CONSTRAINT name UNIQUE", sql: "ALTER TABLE {table} ADD CONSTRAINT uq_name UNIQUE (name)" },
        { name: "DROP CONSTRAINT by name", sql: "ALTER TABLE orders DROP CONSTRAINT fk_user" },
        { name: "DROP FOREIGN KEY by name (MySQL)", sql: "ALTER TABLE orders DROP FOREIGN KEY fk_user" },
        { name: "Referential actions", sql: "SELECT constraint_name, delete_rule, update_rule FROM information_schema.referential_constraints" },
        { name: "CHECK constraint expressions", sql: "SELECT constraint_name, check_clause FROM information_schema.check_constraints" }
      ]},
      { cat: "JSON Operators", cmds: [
        { name: "-> (keeps JSON)", sql: "SELECT '{\"a\":{\"b\":2}}' -> 'a' AS v" },
        { name: "->> (as text)", sql: "SELECT '{\"a\":1}' ->> 'a' AS v" },
        { name: "-> chained", sql: "SELECT '{\"a\":{\"b\":7}}' -> 'a' ->> 'b' AS v" },
        { name: "#> / #>> (path array)", sql: "SELECT '{\"a\":{\"b\":2}}' #>> '{a,b}' AS v" },
        { name: "@> / <@ (containment)", sql: "SELECT ('{\"a\":1,\"b\":2}' @> '{\"a\":1}') AS contains" },
        { name: "JSON_INSERT (missing paths only)", sql: "SELECT JSON_INSERT('{\"a\":1}', '$.b', 2) AS v" },
        { name: "JSON_REPLACE (existing paths only)", sql: "SELECT JSON_REPLACE('{\"a\":1}', '$.a', 5) AS v" },
        { name: "JSON_ARRAY_INSERT", sql: "SELECT JSON_ARRAY_INSERT('[1,2]', '$[0]', 9) AS v" },
        { name: "JSON_CONTAINS_PATH", sql: "SELECT JSON_CONTAINS_PATH('{\"a\":1}', 'one', '$.a', '$.z') AS v" }
      ]},
      { cat: "Predicates, Aliases & Indexes", cmds: [
        { name: "IS [NOT] TRUE / FALSE", sql: "SELECT COUNT(*) AS c FROM {table} WHERE (age > 30) IS NOT TRUE" },
        { name: "UPDATE with a table alias", sql: "UPDATE {table} t SET t.age = t.age + 1 WHERE t.id = 1" },
        { name: "DELETE with a table alias", sql: "DELETE FROM {table} t WHERE t.id = 99999" },
        { name: "Row constructor IN (SELECT ...)", sql: "SELECT COUNT(*) AS c FROM orders WHERE (user_id, product_id) IN (SELECT user_id, product_id FROM orders)" },
        { name: "CREATE INDEX with ordering", sql: "CREATE INDEX ix_v18 ON products (price DESC, name ASC NULLS LAST)" },
        { name: "CREATE INDEX on an expression", sql: "CREATE INDEX ix_v18e ON {table} (LOWER(name))" },
        { name: "SHOW INDEX / SHOW KEYS", sql: "SHOW INDEX FROM {table}" },
        { name: "Index metadata", sql: "SELECT index_name, seq_in_index, column_name, expression, collation FROM information_schema.statistics" },
        { name: "UNNEST an array", sql: "SELECT SUM(v) AS s FROM UNNEST(ARRAY[1, 2, 3]) AS t(v)" },
        { name: "UNNEST WITH ORDINALITY", sql: "SELECT v, n FROM UNNEST(ARRAY['a','b']) WITH ORDINALITY AS t(v, n)" }
      ]},
      { cat: "Composite Keys & Sequences", cmds: [
        { name: "Composite FOREIGN KEY", sql: "CREATE TABLE v19_p (a INTEGER, b INTEGER, PRIMARY KEY (a, b));\nCREATE TABLE v19_c (id INTEGER, pa INTEGER, pb INTEGER, FOREIGN KEY (pa, pb) REFERENCES v19_p(a, b) ON DELETE CASCADE)" },
        { name: "ALTER ADD composite FOREIGN KEY", sql: "ALTER TABLE v19_c ADD CONSTRAINT fk_pair FOREIGN KEY (pa, pb) REFERENCES v19_p(a, b)" },
        { name: "DROP composite FOREIGN KEY", sql: "ALTER TABLE v19_c DROP FOREIGN KEY (pa, pb)" },
        { name: "CREATE SEQUENCE with range", sql: "CREATE SEQUENCE v19_seq START WITH 100 INCREMENT BY 10 MINVALUE 1 MAXVALUE 999 CYCLE" },
        { name: "ALTER SEQUENCE RESTART", sql: "ALTER SEQUENCE v19_seq RESTART WITH 500" },
        { name: "Sequence metadata", sql: "SELECT sequence_name, minimum_value, maximum_value, cycle_option FROM information_schema.sequences" },
        { name: "DEFAULT NEXTVAL", sql: "CREATE TABLE v19_t (id INTEGER DEFAULT NEXTVAL('v19_seq'), v TEXT)" },
        { name: "DEFAULT with an expression", sql: "CREATE TABLE v19_e (a INTEGER, u TEXT DEFAULT UUID(), n INTEGER DEFAULT (1 + 2))" }
      ]},
      { cat: "MERGE & Upsert", cmds: [
        { name: "MERGE with a condition", sql: "MERGE INTO {table} t USING (SELECT 1 AS id, 'x' AS nm) s ON t.id = s.id\n  WHEN MATCHED AND t.name <> s.nm THEN UPDATE SET name = s.nm\n  WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.nm)" },
        { name: "MERGE ... WHEN NOT MATCHED BY SOURCE", sql: "MERGE INTO {table} t USING (SELECT 1 AS id) s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE" },
        { name: "ON DUPLICATE KEY UPDATE with VALUES()", sql: "INSERT INTO {table} (id, name) VALUES (1, 'x') ON DUPLICATE KEY UPDATE name = VALUES(name)" },
        { name: "ON CONFLICT ... DO UPDATE ... WHERE", sql: "INSERT INTO {table} (id, age) VALUES (1, 40) ON CONFLICT (id) DO UPDATE SET age = EXCLUDED.age WHERE {table}.age < EXCLUDED.age" }
      ]},
      { cat: "Views, Indexes & Catalog", cmds: [
        { name: "CREATE VIEW with a column list", sql: "CREATE VIEW v19_v (uid, uname) AS SELECT id, name FROM {table}" },
        { name: "ALTER INDEX RENAME", sql: "ALTER INDEX ix_old RENAME TO ix_new" },
        { name: "SHOW TABLE STATUS", sql: "SHOW TABLE STATUS" },
        { name: "SHOW TABLE STATUS LIKE", sql: "SHOW TABLE STATUS LIKE 'user%'" },
        { name: "CREATE TABLE AS ... WITH NO DATA", sql: "CREATE TABLE v19_shape AS SELECT * FROM {table} WITH NO DATA" },
        { name: "CREATE GLOBAL TEMPORARY TABLE", sql: "CREATE GLOBAL TEMPORARY TABLE v19_scratch (a INTEGER)" }
      ]},
      { cat: "Date Arithmetic", cmds: [
        { name: "日付 + 日数", sql: "SELECT DATE '2026-01-01' + 30 AS due" },
        { name: "日付 - 日数", sql: "SELECT CURRENT_DATE - 7 AS week_ago" },
        { name: "日付 - 日付（日数差）", sql: "SELECT DATE '2026-03-01' - DATE '2026-01-01' AS days" },
        { name: "日付列の演算", sql: "-- 日付型の列にもそのまま効く\n-- SELECT nm, hire + 90 AS probation_end FROM emp" },
        { name: "INTERVAL 版（従来どおり）", sql: "SELECT DATE '2026-01-31' + INTERVAL 1 MONTH AS d" }
      ]},
      { cat: "Hierarchical Queries (Oracle)", cmds: [
        { name: "START WITH ... CONNECT BY", sql: "-- 組織図をたどる\n-- SELECT nm, LEVEL FROM emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr" },
        { name: "SYS_CONNECT_BY_PATH", sql: "-- SELECT SYS_CONNECT_BY_PATH(nm, '/') AS path FROM emp\n--   START WITH mgr IS NULL CONNECT BY PRIOR id = mgr" },
        { name: "CONNECT_BY_ROOT / ISLEAF", sql: "-- SELECT nm, CONNECT_BY_ROOT nm AS top, CONNECT_BY_ISLEAF AS leaf FROM emp\n--   START WITH mgr IS NULL CONNECT BY PRIOR id = mgr" },
        { name: "ORDER SIBLINGS BY", sql: "-- 同じ親の子どもの並び順を決める\n-- ... CONNECT BY PRIOR id = mgr ORDER SIBLINGS BY nm" },
        { name: "CONNECT BY NOCYCLE", sql: "-- データが循環していても止まる\n-- ... CONNECT BY NOCYCLE PRIOR id = mgr" },
        { name: "ROWNUM で上位 n 件", sql: "SELECT name FROM {table} WHERE ROWNUM <= 3" },
        { name: "ROWNUM を列として", sql: "SELECT ROWNUM AS rn, name FROM {table}" }
      ]},
      { cat: "Analytic Functions", cmds: [
        { name: "RATIO_TO_REPORT", sql: "-- ウィンドウ関数は選択項目そのものである必要があるので、加工は副問い合わせの外で行う\nSELECT name, ROUND(r * 100, 1) AS pct FROM (SELECT name, RATIO_TO_REPORT(age) OVER () AS r FROM {table}) q" },
        { name: "PERCENTILE_CONT OVER", sql: "SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY age) OVER () AS median FROM {table}" },
        { name: "NTH_VALUE ... FROM LAST", sql: "SELECT NTH_VALUE(name, 2) FROM LAST OVER (ORDER BY id) AS v FROM {table}" },
        { name: "KEEP (DENSE_RANK FIRST)", sql: "SELECT MAX(name) KEEP (DENSE_RANK FIRST ORDER BY age) AS youngest FROM {table}" },
        { name: "KEEP (DENSE_RANK LAST)", sql: "SELECT MAX(name) KEEP (DENSE_RANK LAST ORDER BY age) AS oldest FROM {table}" }
      ]},
      { cat: "Match Operators (PostgreSQL)", cmds: [
        { name: "~ 正規表現", sql: "SELECT * FROM {table} WHERE name ~ '^A'" },
        { name: "~* 大小無視の正規表現", sql: "SELECT * FROM {table} WHERE name ~* '^a'" },
        { name: "!~ 否定", sql: "SELECT COUNT(*) AS c FROM {table} WHERE name !~ 'a'" },
        { name: "~~ / ~~* (LIKE / ILIKE)", sql: "SELECT * FROM {table} WHERE name ~~* 'a%'" },
        { name: "CURRENT_CATALOG", sql: "SELECT CURRENT_CATALOG AS db, CURRENT_SCHEMA AS schema" }
      ]},
      { cat: "DDL & Upsert Extras", cmds: [
        { name: "TRUNCATE 複数表", sql: "-- 指定した表をすべて空にする\n-- TRUNCATE TABLE t1, t2" },
        { name: "ADD COLUMN の生成列", sql: "-- ALTER TABLE t ADD COLUMN len INTEGER GENERATED ALWAYS AS (LENGTH(nm)) STORED" },
        { name: "CREATE INDEX ... INCLUDE", sql: "-- CREATE INDEX ix ON t (nm) INCLUDE (v)" },
        { name: "SET CONSTRAINTS", sql: "SET CONSTRAINTS ALL IMMEDIATE" },
        { name: "SHOW SCHEMAS", sql: "SHOW SCHEMAS" },
        { name: "SHOW TRANSACTION ISOLATION LEVEL", sql: "SHOW TRANSACTION ISOLATION LEVEL" },
        { name: "ON CONFLICT ... RETURNING", sql: "-- 実際に書き込んだ行だけが返る\n-- INSERT INTO t (id, nm) VALUES (1, 'a') ON CONFLICT (id) DO NOTHING RETURNING id" }
      ]},
      { cat: "Windows over Groups", cmds: [
        { name: "Percent of total", sql: "SELECT age, COUNT(*) AS n,\n       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct\nFROM {table} GROUP BY age ORDER BY age" },
        { name: "Rank the groups", sql: "SELECT age, COUNT(*) AS n, RANK() OVER (ORDER BY COUNT(*) DESC) AS rk FROM {table} GROUP BY age" },
        { name: "Running total over groups", sql: "SELECT age, SUM(COUNT(*)) OVER (ORDER BY age) AS running FROM {table} GROUP BY age" },
        { name: "Partitioned rank over groups", sql: "SELECT age, COUNT(*) AS n, ROW_NUMBER() OVER (PARTITION BY age % 2 ORDER BY age) AS rn FROM {table} GROUP BY age" }
      ]},
      { cat: "Collation, ORDER BY ALL & GROUPING_ID", cmds: [
        { name: "Column-level COLLATE NOCASE", sql: "CREATE TABLE v21_ci (id INTEGER PRIMARY KEY, nm TEXT COLLATE NOCASE UNIQUE)" },
        { name: "Case-insensitive lookup", sql: "-- 'Apple' も 'APPLE' も一致する\n-- SELECT * FROM v21_ci WHERE nm = 'APPLE'" },
        { name: "COLLATE NUMERIC (自然順)", sql: "CREATE TABLE v21_nat (v TEXT COLLATE NUMERIC)" },
        { name: "ORDER BY ALL", sql: "SELECT name, age FROM {table} ORDER BY ALL" },
        { name: "ORDER BY ALL DESC", sql: "SELECT name, age FROM {table} ORDER BY ALL DESC" },
        { name: "GROUPING_ID over CUBE", sql: "SELECT age, id, COUNT(*) AS n, GROUPING_ID(age, id) AS gid FROM {table} GROUP BY CUBE(age, id)" }
      ]},
      { cat: "DDL, Identity & LATERAL", cmds: [
        { name: "ALTER COLUMN ... SET DATA TYPE", sql: "ALTER TABLE {table} ALTER COLUMN age SET DATA TYPE FLOAT" },
        { name: "ALTER COLUMN ... TYPE ... USING", sql: "ALTER TABLE {table} ALTER COLUMN name TYPE INTEGER USING LENGTH(name)" },
        { name: "ALTER TABLE RENAME CONSTRAINT", sql: "-- ALTER TABLE {table} RENAME CONSTRAINT uq_old TO uq_new" },
        { name: "OVERRIDING SYSTEM VALUE", sql: "-- 識別列に与えた値をそのまま使う\n-- INSERT INTO t (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, 'a')" },
        { name: "OVERRIDING USER VALUE", sql: "-- 与えた値を捨てて自動採番させる\n-- INSERT INTO t (id, nm) OVERRIDING USER VALUE VALUES (99, 'b')" },
        { name: "JOIN LATERAL ... ON TRUE", sql: "SELECT u.name AS name, x.c AS c FROM users u\nJOIN LATERAL (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x ON TRUE" },
        { name: "LEFT JOIN LATERAL", sql: "SELECT u.name AS name, x.oid AS oid FROM users u\nLEFT JOIN LATERAL (SELECT order_id AS oid FROM orders o WHERE o.user_id = u.id) x ON TRUE" }
      ]},
      { cat: "Subscripts & Warnings", cmds: [
        { name: "Array subscript (1-based)", sql: "SELECT ARRAY[10, 20, 30, 40][2] AS second" },
        { name: "Array slice", sql: "SELECT ARRAY_TO_STRING(ARRAY[10, 20, 30, 40][2:3], '-') AS slice" },
        { name: "String slice", sql: "SELECT ('hello')[2:4] AS sub" },
        { name: "JSON element by subscript", sql: "SELECT ('[5,6,7]')[2] AS v" },
        { name: "SHOW WARNINGS", sql: "DROP TABLE IF EXISTS not_here;\nSHOW WARNINGS" },
        { name: "SHOW COUNT(*) WARNINGS", sql: "DROP TABLE IF EXISTS not_here;\nSHOW COUNT(*) WARNINGS" }
      ]},
      { cat: "Ordered Aggregates & Windows", cmds: [
        { name: "STRING_AGG with ORDER BY", sql: "SELECT STRING_AGG(name, ',' ORDER BY age DESC) AS names FROM {table}" },
        { name: "ARRAY_AGG with ORDER BY", sql: "SELECT ARRAY_AGG(name ORDER BY id) AS arr FROM {table}" },
        { name: "LISTAGG with ORDER BY", sql: "SELECT LISTAGG(name, ' / ' ORDER BY name) AS s FROM {table}" },
        { name: "Window function in ORDER BY", sql: "SELECT name FROM {table} ORDER BY ROW_NUMBER() OVER (ORDER BY age DESC)" },
        { name: "Integer division (infix)", sql: "SELECT age DIV 10 AS decade FROM {table}" }
      ]},
      { cat: "Derived Sources & SRFs", cmds: [
        { name: "UPDATE ... FROM (VALUES ...)", sql: "UPDATE {table} SET age = v.a FROM (VALUES (1, 41), (2, 42)) AS v(i, a) WHERE {table}.id = v.i" },
        { name: "DELETE ... USING (VALUES ...)", sql: "DELETE FROM {table} USING (VALUES (99999)) AS d(i) WHERE {table}.id = d.i" },
        { name: "UNNEST in the SELECT list", sql: "SELECT UNNEST(ARRAY[1, 2, 3]) AS v" },
        { name: "GENERATE_SERIES in the SELECT list", sql: "SELECT GENERATE_SERIES(1, 12) AS month" },
        { name: "STRING_SPLIT in the SELECT list", sql: "SELECT STRING_SPLIT('a,b,c', ',') AS part" }
      ]},
      { cat: "Domains, Types & Roles", cmds: [
        { name: "CREATE DOMAIN with a CHECK", sql: "CREATE DOMAIN v20_pos AS INTEGER CHECK (VALUE > 0)" },
        { name: "CREATE TYPE ... AS ENUM", sql: "CREATE TYPE v20_mood AS ENUM ('sad', 'ok', 'happy')" },
        { name: "Use a domain as a column type", sql: "CREATE TABLE v20_survey (id INTEGER, score v20_pos, m v20_mood)" },
        { name: "SHOW DOMAINS", sql: "SHOW DOMAINS" },
        { name: "CREATE ROLE / USER", sql: "CREATE ROLE v20_reporting" },
        { name: "SHOW GRANTS", sql: "SHOW GRANTS" },
        { name: "TRUNCATE ... CONTINUE IDENTITY", sql: "TRUNCATE TABLE v20_survey CONTINUE IDENTITY" }
      ]},
      { cat: "Recursive SEARCH & CYCLE", cmds: [
        { name: "SEARCH DEPTH FIRST", sql: "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5)\n  SEARCH DEPTH FIRST BY n SET ord\nSELECT n, ord FROM t ORDER BY ord" },
        { name: "SEARCH BREADTH FIRST", sql: "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5)\n  SEARCH BREADTH FIRST BY n SET ord\nSELECT n, ord FROM t ORDER BY ord" },
        { name: "CYCLE (stops on a loop)", sql: "-- 循環するグラフでも上限エラーにならず、印を付けて止まる\n-- WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM g JOIN t ON g.a = t.n)\n--   CYCLE n SET is_cycle USING path\n-- SELECT n, is_cycle, path FROM t" },
        { name: "Index-backed IN", sql: "EXPLAIN SELECT * FROM {table} WHERE id IN (1, 2, 3)" }
      ]},
      { cat: "Quoted Identifiers & Grouping Sets", cmds: [
        { name: "予約語を列名に使う", sql: "-- バッククォートで囲むと予約語も識別子として使える\n-- CREATE TABLE t (`order` INTEGER, `select` TEXT)" },
        { name: "バッククォートで参照する", sql: "SELECT `name`, `age` FROM {table} LIMIT 3" },
        { name: "ダブルクォートは文字列", sql: "-- MySQL 既定と同じ。識別子にはバッククォートを使う\nSELECT \"plain text\" AS s" },
        { name: "GROUPING SETS に ROLLUP", sql: "SELECT age, COUNT(*) AS c FROM {table} GROUP BY GROUPING SETS (ROLLUP(age))" },
        { name: "GROUPING SETS に CUBE", sql: "SELECT age, COUNT(*) AS c FROM {table} GROUP BY GROUPING SETS (CUBE(age))" },
        { name: "集合の組み合わせ", sql: "SELECT age, COUNT(*) AS c FROM {table} GROUP BY GROUPING SETS ((age), ())" },
        { name: "SQL ダンプは全オブジェクトを含む", sql: "-- 表・データ・索引・ビュー・シーケンスに加えて\n-- トリガー・関数・プロシージャ・コメントも書き出される（Data → 書き出し）" }
      ]},
      { cat: "NULL in Arithmetic & Date Types", cmds: [
        { name: "算術も NULL を伝播する", sql: "-- どれか一つでも NULL なら結果は NULL（0 として扱わない）\nSELECT NULL + 10, 10 - NULL, NULL * 0" },
        { name: "集計は NULL を数えない", sql: "-- 式が NULL になった行は AVG の分母にも MIN の候補にも入らない\nSELECT AVG(price * stock), MIN(price * stock), COUNT(price * stock) FROM {table}" },
        { name: "0 除算は NULL", sql: "SELECT 10 / 0, 10 % 0" },
        { name: "DATE は日付だけ", sql: "SELECT CAST('2026-01-02 13:45:00' AS DATE)     -- 2026-01-02" },
        { name: "DATETIME / TIMESTAMP は時刻も残す", sql: "SELECT CAST('2026-01-02 13:45:00' AS DATETIME) -- 2026-01-02 13:45:00" },
        { name: "日次の集計", sql: "-- 時刻を切り捨てて 1 日にまとめる\n-- SELECT CAST(at AS DATE) AS d, COUNT(*) FROM events GROUP BY CAST(at AS DATE)" },
        { name: "日付の比較は時刻で行う", sql: "SELECT DATE '2026-01-02' = TIMESTAMP '2026-01-02 00:00:00'   -- true" },
        { name: "ウィンドウの既定フレーム", sql: "-- ORDER BY だけなら RANGE ... CURRENT ROW（同じ並び順の行はまとめて同じ値）\nSELECT age, SUM(age) OVER (ORDER BY age) FROM {table}" },
        { name: "パーティション全体を見る", sql: "SELECT LAST_VALUE(name) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM {table}" },
        { name: "ON DELETE SET DEFAULT", sql: "-- 親が消えたら子を既定値へ戻す\n-- CREATE TABLE c (pid INT DEFAULT 9, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET DEFAULT)" }
      ]},
      { cat: "NULL & Three-Valued Logic", cmds: [
        { name: "NULL 比較は UNKNOWN", sql: "-- どちらかが NULL なら結果は真でも偽でもない（WHERE は通さない）\nSELECT NULL = NULL, 1 = NULL, 1 <> NULL" },
        { name: "範囲条件は NULL 行を拾わない", sql: "SELECT * FROM {table} WHERE age < 100     -- age が NULL の行は含まれない" },
        { name: "NULL を調べるのは IS NULL", sql: "SELECT * FROM {table} WHERE age IS NULL" },
        { name: "IS [NOT] UNKNOWN", sql: "SELECT (1 = 1) IS NOT UNKNOWN, (NULL) IS UNKNOWN" },
        { name: "NOT も 3 値論理", sql: "-- NOT UNKNOWN は UNKNOWN。NULL の行は通らない\nSELECT * FROM {table} WHERE NOT (age = 25)" },
        { name: "NULL を含む NOT IN は真にならない", sql: "SELECT * FROM {table} WHERE age NOT IN (25, NULL)   -- 常に 0 件" },
        { name: "NOT LIKE も NULL を除く", sql: "SELECT * FROM {table} WHERE name NOT LIKE 'A%'" },
        { name: "CHECK は UNKNOWN を通す", sql: "-- b が NULL の行は CHECK 違反にならない（SQL 標準）\n-- CREATE TABLE t (a INT, b INT CHECK (b > 0));  INSERT INTO t (a) VALUES (1)" },
        { name: "IS DISTINCT FROM で NULL 込みの比較", sql: "SELECT * FROM {table} WHERE age IS DISTINCT FROM 25" }
      ]},
      { cat: "Aliases, Stars & Set Operations", cmds: [
        { name: "Alias without AS", sql: "SELECT id x, COUNT(*) c FROM {table} GROUP BY id" },
        { name: "Quoted alias", sql: "SELECT id AS \"row id\", name AS \"名前\" FROM {table}" },
        { name: "Qualified star", sql: "SELECT u.* FROM {table} u" },
        { name: "Duplicate output names", sql: "-- 同名の列は 2 つ目以降に _1, _2 … が付く（消えない）\nSELECT id, id, id FROM {table}" },
        { name: "Parenthesised set operation", sql: "(SELECT id FROM {table} WHERE id < 3)\nUNION\n(SELECT id FROM {table} WHERE id > 8)" },
        { name: "Parenthesised branches with ORDER BY", sql: "(SELECT id FROM {table} WHERE id < 3)\nUNION ALL\n(SELECT id FROM {table} WHERE id = 1)\nORDER BY id DESC" }
      ]},
      { cat: "SHA-2 & Regexp Options", cmds: [
        { name: "SHA-256 / SHA-224", sql: "SELECT SHA256('abc'), SHA224('abc'), SHA2('abc', 256)" },
        { name: "HEX is UTF-8", sql: "SELECT HEX('あ'), UNHEX(HEX('あ'))" },
        { name: "REGEXP_SUBSTR occurrence", sql: "SELECT REGEXP_SUBSTR('a1b2c3', '[0-9]', 1, 2)" },
        { name: "REGEXP_REPLACE nth match", sql: "SELECT REGEXP_REPLACE('aaa', 'a', 'b', 1, 2)" },
        { name: "REGEXP_INSTR position", sql: "SELECT REGEXP_INSTR('a1b2', '[0-9]', 1, 2)" },
        { name: "Case-insensitive match_type", sql: "SELECT REGEXP_LIKE('ABC', 'abc', 'i')" },
        { name: "LTRIM / RTRIM character set", sql: "SELECT LTRIM('xxhixx', 'x'), RTRIM('xxhixx', 'x')" },
        { name: "SUBSTRING from the end", sql: "SELECT SUBSTRING('abcdef', -3), SUBSTR('abcdef', -3, 2)" },
        { name: "TO_TIMESTAMP (epoch seconds)", sql: "SELECT TO_TIMESTAMP(1700000000)" }
      ]},
      { cat: "Schema Changes", cmds: [
        { name: "Several actions at once", sql: "ALTER TABLE {table} ADD COLUMN memo TEXT, ADD COLUMN memo2 TEXT" },
        { name: "Composite UNIQUE index", sql: "-- 「組が一意」であって「各列が一意」ではない\nCREATE UNIQUE INDEX ux_pair ON {table} (id, name)" },
        { name: "INSERT OR <action>", sql: "-- REPLACE / IGNORE / ABORT / FAIL / ROLLBACK\nINSERT OR REPLACE INTO {table} (id, name) VALUES (1, 'X')" },
        { name: "Rename keeps constraints", sql: "-- 生成列・CHECK・索引名・列順すべて追随する\nALTER TABLE {table} RENAME COLUMN name TO nm" }
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

    // 検索フィルタ用: HTMLエスケープ + マッチ部分のハイライト
    function escapeHtmlHelp(s) {
      return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function highlightHelp(text, term) {
      const esc = escapeHtmlHelp(text);
      if (!term) return esc;
      const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      return esc.replace(re, '<mark class="bg-yellow-200 text-inherit rounded-sm px-0.5">$1</mark>');
    }

    function renderHelpCommands() {
      const tbl = document.getElementById('helpTableSelect').value || 'users';
      const searchEl = document.getElementById('helpSearchInput');
      const term = searchEl ? searchEl.value.trim() : '';
      const termLower = term.toLowerCase();

      // コマンド名（UI非表示）と展開後SQLの双方を対象に検索する
      const createCommandHTML = (cmd, q) => `
          <div class="bg-gray-50 p-3 rounded-lg border border-gray-200 flex justify-between items-center hover:border-gray-300 transition-colors">
            <span class="font-mono text-xs text-blue-600 truncate mr-2 font-medium" title="${escapeHtmlHelp(cmd.name)}">${highlightHelp(q, term)}</span>
            <button class="bg-white hover:bg-gray-100 border border-gray-300 text-gray-700 text-[10px] px-3 py-1.5 rounded shadow-sm font-semibold copy-cmd-btn transition-colors whitespace-nowrap" data-query="${q.replace(/"/g, '&quot;')}">Use</button>
          </div>`;

      let matchCount = 0;
      const sections = helpData.map(group => {
        const items = group.cmds
          .map(cmd => ({ cmd, q: cmd.sql.replace(/\{table\}/g, tbl) }))
          .filter(({ cmd, q }) => !termLower || cmd.name.toLowerCase().includes(termLower) || q.toLowerCase().includes(termLower));
        if (items.length === 0) return '';
        matchCount += items.length;
        return `
          <div class="mb-4">
            <h3 class="text-xs font-bold text-gray-400 uppercase border-b border-gray-100 pb-1 mb-2 tracking-wider">${group.cat} <span class="text-gray-300 font-medium normal-case">(${items.length})</span></h3>
            <div class="space-y-3">
              ${items.map(({ cmd, q }) => createCommandHTML(cmd, q)).join('')}
            </div>
          </div>`;
      }).join('');

      document.getElementById('helpContent').innerHTML = sections;

      const noRes = document.getElementById('helpNoResults');
      if (noRes) noRes.classList.toggle('hidden', matchCount > 0);
      const countEl = document.getElementById('helpSearchCount');
      if (countEl) countEl.textContent = term ? `${matchCount} 件ヒット` : '';
    }

    // 検索ボックスのワイヤリング（入力で絞り込み・Esc/✕でクリア・モーダル表示時に自動フォーカス）
    const helpSearchInput = document.getElementById('helpSearchInput');
    if (helpSearchInput) {
      helpSearchInput.addEventListener('input', renderHelpCommands);
      helpSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && helpSearchInput.value) {
          helpSearchInput.value = '';
          renderHelpCommands();
          e.stopPropagation();
        }
      });
    }
    const helpSearchClear = document.getElementById('helpSearchClear');
    if (helpSearchClear) {
      helpSearchClear.addEventListener('click', () => {
        if (!helpSearchInput) return;
        helpSearchInput.value = '';
        renderHelpCommands();
        helpSearchInput.focus();
      });
    }
    const openHelpBtnEl = document.getElementById('openHelpBtn');
    if (openHelpBtnEl) {
      openHelpBtnEl.addEventListener('click', () => {
        if (helpSearchInput) helpSearchInput.value = '';
        renderHelpCommands();
        setTimeout(() => { if (helpSearchInput) helpSearchInput.focus(); }, 30);
      });
    }

    document.getElementById('helpTableSelect').addEventListener('change', renderHelpCommands);
