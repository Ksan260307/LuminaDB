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
        { name: "Substring Index", sql: "SELECT SUBSTRING_INDEX('a.b.c', '.', 2), SUBSTRING_INDEX('a.b.c', '.', -1) FROM {table} LIMIT 1" }
      ]},
      { cat: "Math & Date Functions", cmds: [
        { name: "Math Basic", sql: "SELECT ABS(age), CEIL(age), FLOOR(age), ROUND(age) FROM {table}" },
        { name: "Math Advanced", sql: "SELECT MOD(age, 100), POWER(age, 2), SQRT(age), SIGN(age), RAND() FROM {table}" },
        { name: "Exp / Log / Pi", sql: "SELECT EXP(1), LOG(10), LOG10(1000), PI() FROM {table} LIMIT 1" },
        { name: "Truncate & Ceiling", sql: "SELECT TRUNCATE(3.14159, 2), CEILING(1.2) FROM {table} LIMIT 1" },
        { name: "Greatest & Least", sql: "SELECT GREATEST(age, 30, 40), LEAST(age, 30, 40) FROM {table}" },
        { name: "Date & Null", sql: "SELECT NOW(), YEAR(NOW()), MONTH(NOW()), DAY(NOW()), COALESCE(name, 'Unknown') FROM {table}" },
        { name: "Time Parts & Diff", sql: "SELECT HOUR(NOW()), MINUTE(NOW()), SECOND(NOW()), DATEDIFF(NOW(), '2026-01-01') FROM {table} LIMIT 1" },
        { name: "Null Handling", sql: "SELECT IFNULL(name, 'none'), NULLIF(age, 25), IF(age >= 30, 'senior', 'junior') FROM {table}" }
      ]},
      { cat: "Advanced DQL", cmds: [
        { name: "Aggregates", sql: "SELECT COUNT(*), SUM(age), AVG(age), MAX(age), MIN(age) FROM {table}" },
        { name: "Count Distinct", sql: "SELECT COUNT(DISTINCT user_id) FROM orders" },
        { name: "Stats Aggregates", sql: "SELECT STDDEV(age), VARIANCE(age), MEDIAN(age) FROM {table}" },
        { name: "Group By Having", sql: "SELECT age, COUNT(*) as c FROM {table} GROUP BY age HAVING c > 0" },
        { name: "Having Aggregate", sql: "SELECT age FROM {table} GROUP BY age HAVING COUNT(*) >= 1 ORDER BY COUNT(*) DESC" },
        { name: "Joins", sql: "SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id" },
        { name: "Comma Join (Implicit)", sql: "SELECT u.name, o.amount FROM users u, orders o WHERE u.id = o.user_id" },
        { name: "Right Join", sql: "SELECT u.name, o.amount FROM orders o RIGHT JOIN users u ON o.user_id = u.id" },
        { name: "Subqueries", sql: "SELECT * FROM {table} WHERE id IN (SELECT user_id FROM orders)" },
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
        { name: "Exists", sql: "SELECT * FROM {table} WHERE EXISTS (SELECT 1 FROM orders WHERE amount > 1)" },
        { name: "CTE (WITH)", sql: "WITH adults AS (SELECT * FROM users WHERE age >= 30) SELECT COUNT(*) FROM adults" },
        { name: "Ntile", sql: "SELECT id, NTILE(4) OVER(ORDER BY age DESC) FROM {table}" },
        { name: "First / Last Value", sql: "SELECT id, FIRST_VALUE(name) OVER(ORDER BY age DESC), LAST_VALUE(name) OVER(ORDER BY age DESC) FROM {table}" },
        { name: "Select Without FROM", sql: "SELECT 1 + 1 AS calc, NOW() AS current_time" }
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
        { name: "Insert Set (MySQL)", sql: "INSERT INTO {table} SET id = 999, name = 'ViaSet'" }
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
        { name: "Constraints", sql: "CREATE TABLE full_tbl (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active')" },
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
        { name: "Drop Index", sql: "DROP INDEX idx_col ON {table} (id)" },
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
