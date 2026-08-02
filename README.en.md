# LuminaDB

[日本語](README.md) | **English**

A build-free, in-memory SQL database engine that runs entirely in the browser. Open a single HTML file and you get a full SQL engine (DQL / DML / DDL), transactions, window functions, triggers, views, commercial-DB commands such as `MERGE` / `TOP` / `ON CONFLICT`, and 270+ built-in functions — with no server.

> Version: **v1.22.0** / Self-contained tests: **7,772** (all passing — including 780+ security and 490+ performance tests)

---

## Highlights

- **Zero dependencies, no build step** — just open `LuminaDB.html`. No bundler, no package manager (only Tailwind is loaded from a CDN for styling).
- **Columnar storage** — 32-bit packing via `Float64Array` + `Uint32Array` for memory efficiency and cache locality. Scanning 200k rows with a LIKE filter measures ~26ms.
- **A real SQL engine** — near-complete coverage of common SQL syntax (see below).
- **Commercial-DB-compatible functions** — a broad set of functions commonly used in MySQL / PostgreSQL / Oracle / SQL Server.
- **Persistence** — snapshots stored in IndexedDB with **AES-GCM encryption**, guarded by optimistic locking to prevent cross-tab overwrites.
- **External APIs** — usable from your app via `window.LuminaDB` (JS API), `fetch('lumina://...')`, and `postMessage`.
- **Rich UI** — syntax-highlighted editor, Table Editor, searchable command reference, execution-log console, and more.

---

## Quick Start

### Just open it
Open `LuminaDB.html` in any modern browser — it works immediately.

### Via a local server (recommended)
To fully use browser security features such as IndexedDB persistence and encryption, run it through a local server rather than `file://`:

```bash
python -m http.server 8788
# → http://localhost:8788/LuminaDB.html
```

Sample tables `users`, `products`, and `orders` are provided on startup. Type SQL into the editor and press **Run** (or `Ctrl+Enter`).

```sql
SELECT u.name, o.amount
FROM users u
JOIN orders o ON u.id = o.user_id
ORDER BY o.amount DESC;
```

---

## SQL Coverage

| Category | Supported |
|----------|-----------|
| **DQL** | `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` (ordinal, expression, `NULLS FIRST/LAST`) / `LIMIT`, `OFFSET`, `FETCH FIRST` (**`WITH TIES`**) / `TOP n [PERCENT]` (SQL Server) / `DISTINCT` / **`DISTINCT ON (...)`** (PostgreSQL) / **`SELECT * EXCLUDE (...)`, `* REPLACE (expr AS col)`** |
| **Joins** | `INNER` / `LEFT` / `RIGHT` / **`FULL OUTER`** / `CROSS` / comma join / `USING` / `NATURAL` / **`CROSS APPLY`, `OUTER APPLY`, `LATERAL`** |
| **Set ops** | `UNION` / `INTERSECT` / `EXCEPT` / **`MINUS`** (Oracle) — all with `ALL` |
| **Subqueries** | scalar / `IN` / `EXISTS` / correlated / **quantified comparison `= ANY`, `> ALL`, `SOME`** / **derived-table column lists (`(SELECT ...) AS t(a, b)`)** / **`FROM (VALUES ...) AS t(a, b)`** |
| **CTEs** | `WITH` / `WITH RECURSIVE` (with column lists) |
| **Window functions** | `ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / frame specs (**`ROWS` / `RANGE` / `GROUPS`**, **`EXCLUDE CURRENT ROW\|GROUP\|TIES\|NO OTHERS`**) / named windows (`WINDOW` clause) / `QUALIFY` / **`IGNORE NULLS`, `RESPECT NULLS`** / **`FILTER (WHERE ...) OVER (...)`** |
| **Aggregates** | many aggregate functions / **aggregates nested in expressions (`ROUND(AVG(x), 2)`, `100.0 * SUM(a) / SUM(b)`)** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`, `GROUPING SETS`** / **`GROUP BY ALL`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT` (multi-row, `SELECT`, `SET`, `DEFAULT`, **`DEFAULT VALUES`**) / `UPDATE` / `DELETE` (`ORDER BY`, `LIMIT`) / `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`, `DO UPDATE` (PostgreSQL, `EXCLUDED`) / `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED` (Oracle/SQL Server) / **multi-table `UPDATE ... FROM`, `UPDATE ... JOIN`, `DELETE ... USING`, `DELETE t FROM t JOIN s`** / `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE` (**`CASCADE`, `RESTRICT`**) / `VIEW` / **`MATERIALIZED VIEW` (with `REFRESH`)** / `INDEX` (**multi-column, `UNIQUE`, `DROP INDEX` by name**) / `TRIGGER` / `PROCEDURE` / `SEQUENCE` / **`FUNCTION` (user-defined scalar functions)** / `CREATE TABLE AS` & `LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **Constraints** | `PRIMARY KEY` (composite) / `UNIQUE` / `NOT NULL` / `DEFAULT` (incl. `CURRENT_TIMESTAMP`) / **`ON UPDATE CURRENT_TIMESTAMP`** / `CHECK` / `FOREIGN KEY` (`ON DELETE/UPDATE` actions) / `AUTO_INCREMENT` / **identity columns (`GENERATED ALWAYS AS IDENTITY`, `IDENTITY(1,1)`)** / generated columns (`GENERATED ALWAYS AS`) |
| **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **Row reshaping** | **`PIVOT` / `UNPIVOT`** (`UNPIVOT` skips NULL rows) |
| **Null-safe comparison** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** / **`IS [NOT] UNKNOWN`** |
| **Operators & predicates** | **`\|\|` (string concatenation)** / **`::` (cast)** / **`ILIKE`** / **`SIMILAR TO`** / **row constructors** / **`COLLATE` (`NOCASE`, `BINARY`, `NOACCENT`, `NUMERIC`)** / **`LIKE ANY`, `LIKE ALL`** / **date ± `INTERVAL`** |
| **Full-text search** | **`MATCH (col, ...) AGAINST ('terms' [IN BOOLEAN\|NATURAL LANGUAGE MODE])`** — `+`required / `-`excluded / `"phrase"` / `term*` prefix, usable as a relevance score |
| **Table functions** | `GENERATE_SERIES` (**numeric ranges and timestamp ranges with an `INTERVAL` step**) / `STRING_SPLIT(str, sep)` / `UNNEST(a, b, ...)` / **`JSON_TABLE` (JSON → rows)** / **`WITH ORDINALITY`** |
| **Arrays** | **`ARRAY[...]` constructor** / **`ARRAY_LENGTH`, `ARRAY_POSITION`, `ARRAY_CONTAINS`, `ARRAY_APPEND`, `ARRAY_PREPEND`, `ARRAY_REMOVE`, `ARRAY_SORT`, `ARRAY_TO_STRING`, `STRING_TO_ARRAY`** / **`= ANY(ARRAY[...])`** |
| **Sampling** | **`TABLESAMPLE [BERNOULLI\|SYSTEM] (n PERCENT\|n ROWS) [REPEATABLE (seed)]`** |
| **Ranges & time series** | **`(s1, e1) OVERLAPS (s2, e2)`** / **`BETWEEN SYMMETRIC`** / **`DATE_BIN`, `TIME_BUCKET`** / **`AGE(a, b)`** / **`EXTRACT(EPOCH\|DOW\|DOY FROM ...)`** / **`AT TIME ZONE`** |
| **Statistical aggregates** | **`REGR_SLOPE`, `REGR_INTERCEPT`, `REGR_R2`, `REGR_COUNT`, `REGR_AVGX`, `REGR_AVGY`, `REGR_SXX`, `REGR_SYY`, `REGR_SXY`** / **`MODE() WITHIN GROUP (ORDER BY x)`** |
| **Fuzzy matching** | **`LEVENSHTEIN` (`EDIT_DISTANCE`)** / **`SIMILARITY` (0–1)** / **`DIFFERENCE` (SOUNDEX closeness)** / **`REGEXP_MATCHES`, `REGEXP_SPLIT_TO_ARRAY`** |
| **JSON predicates** | **`<expr> IS [NOT] JSON [VALUE\|OBJECT\|ARRAY\|SCALAR]`** / **`JSON_EXISTS`** / **`JSON_QUERY`** |
| **Procedural** | **`DECLARE` / `SET` / `IF`, `ELSEIF`, `ELSE` / `WHILE`, `DO` / `LOOP`, `LEAVE`, `ITERATE` / `REPEAT`, `UNTIL` / `CASE` statement / `RETURN`** inside `CREATE PROCEDURE`, with arguments (`CALL p(1, 2)`) |
| **Cursors** | **`DECLARE <name> CURSOR FOR` / `OPEN` / `FETCH ... INTO` / `CLOSE`** (multi-column `FETCH`) |
| **Error handling** | **`DECLARE {CONTINUE\|EXIT} HANDLER FOR {NOT FOUND\|SQLEXCEPTION\|SQLSTATE 'xxxxx'}`** / **`SIGNAL`, `RESIGNAL`** with `SET MESSAGE_TEXT` |
| **Catalog** | **`INFORMATION_SCHEMA.TABLES / COLUMNS / VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE / ROUTINES / SEQUENCES / SCHEMATA`** / **`PRAGMA table_info`, `table_list`, `index_list`, `foreign_key_list`, `user_version`** / **`sqlite_master`** |
| **Compatibility syntax** | **schema-qualified `main.t` / `public.t`** / **`CREATE`, `DROP SCHEMA`** / **partial indexes** / **`SELECT ... FOR UPDATE\|SHARE [NOWAIT\|SKIP LOCKED]`** / **`WITH ... AS [NOT] MATERIALIZED`** / **`EXPLAIN QUERY PLAN`** / **`REINDEX`, `CHECKPOINT`, `FLUSH`, `CLUSTER`** (accepted) / **`SHOW CREATE FUNCTION`** |
| **Session statements** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`, `UNLOCK TABLES`** / **`GRANT`, `REVOKE`** / **`DISCARD`** (accepted for script compatibility) / **`SET statement_timeout`, `read_only`, `seed`, `slow_query_threshold`** / **system variables `@@version`, `@@identity`** |
| **Snapshots** | **`CREATE / RESTORE / DROP SNAPSHOT`**, **`SHOW SNAPSHOTS`** (in-memory time travel) |
| **Other** | prepared statements (`PREPARE`/`EXECUTE`/`DEALLOCATE`) / user variables (`SET @x`, **`DECLARE @x`**) / `EXPLAIN` (**`(FORMAT JSON)`**) & `EXPLAIN ANALYZE` / `VALUES` statement / `TABLE` statement / `SHOW *` (incl. **`STORAGE`, `SETTINGS`, `COMMENTS`, `MATERIALIZED VIEWS`, `SNAPSHOTS`, `PROFILE`, `SLOW QUERIES`**), `DESCRIBE`, `CHECK TABLE`, `ANALYZE TABLE` |

### Built-in functions (270+)

Covering String, Numeric, Date/Time, JSON, Regexp, Hash/Encoding, Null/Flow, Aggregate, Window, Sequence, and Meta categories. Use `SHOW FUNCTIONS` to list and search them.

Functions commonly used in commercial databases are included (selection):

- **Oracle**: `DECODE` / `NVL` / `NVL2` / `ADD_MONTHS` / `MONTHS_BETWEEN` / `NEXT_DAY` / `WIDTH_BUCKET` / `INITCAP` / `LISTAGG` / `TO_NUMBER` / `TO_CHAR` / `TO_DATE` / `NANVL` / `REMAINDER` / `SYS_GUID`
- **SQL Server**: `ISNULL` / `IIF` / `CHOOSE` / `CHARINDEX` / `PATINDEX` / `LEN` / `STUFF` / `QUOTENAME` / `PARSENAME` / `REPLICATE` / `TRY_CAST` / `TRY_CONVERT` / `DATEADD` / `DATEPART` / `DATENAME` / `NEWID` / `EOMONTH`
- **PostgreSQL**: `DATE_PART` / `SPLIT_PART` / `STARTS_WITH` / `ENDS_WITH` / `STRPOS` / `OVERLAY` / `TO_HEX` / `QUOTE_IDENT` / `QUOTE_LITERAL` / `GCD` / `LCM` / `MAKE_DATE` / `CHR`
- **Common/other**: `SHIFTLEFT` / `SHIFTRIGHT` / `LOG(base, x)` / `USER` / `CURRENT_USER` / `CURRENT_SCHEMA` / `POW` / `BITAND` / `BITOR` / `BITXOR` and many more

```sql
-- Scalar function example
SELECT TO_CHAR(1234.5, '9,999.99')            AS money,
       DATEADD(MONTH, 1, DATE('2026-01-31'))  AS next_eom,
       TRY_CAST('abc' AS INTEGER)             AS safe_cast,   -- NULL if not convertible
       NEXT_DAY(DATE('2026-07-23'), 'Monday') AS next_mon;

-- MERGE (UPSERT)
MERGE INTO target t USING source s ON (t.id = s.id)
  WHEN MATCHED THEN UPDATE SET val = s.val
  WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val);

-- PostgreSQL-style UPSERT
INSERT INTO target (id, val) VALUES (1, 100)
  ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val;

-- SQL Server-style TOP
SELECT TOP 3 * FROM users ORDER BY age DESC;
```

---

## UI Guide

| Feature | Description |
|---------|-------------|
| **Query Workspace** | SQL editor with syntax highlighting, autocomplete (`Tab`), history (`Ctrl+↑/↓`), and formatting (`Ctrl+Shift+F`). |
| **Results table** | Click a column header to sort; export to CSV / JSON; switch the number of displayed rows. |
| **Table Editor** | Launched from the ⚙ icon in the sidebar. Add / delete / rename / retype / drag-reorder columns, plus edit **PRIMARY KEY / NOT NULL / UNIQUE / AUTO_INCREMENT / DEFAULT** via checkboxes. The edit is shown as a live `CREATE TABLE` preview. |
| **Command Reference** | Opened from "Help". A categorized command catalog with **search** (incremental filtering + highlighting across both command names and SQL text); one click inserts a command into the editor. |
| **Console** | An execution-log panel in the **bottom-left** of the screen. Records executed queries, **result counts** (rows returned for SELECT, rows affected for DML), timings, errors, and system events chronologically. **Click a log line to reload its query into the editor**, and use **Copy** to copy the whole log to the clipboard. **Toggle its visibility at will** via the launcher button or <kbd>Ctrl</kbd>+<kbd>`</kbd> (backtick); the state is persisted. |
| **Test Data Generator** | Bulk-inject dummy data into a chosen table. |
| **CSV Import / SQL Import & Export** | Import CSV; dump/restore schema + data as SQL. |
| **Save / Load / Clear DB** | Manually save/load/reset the IndexedDB store. |

---

## External APIs

You can drive the database from JavaScript in three ways.

### 1. `window.LuminaDB` (JS API)

```js
// Parameter binding (positional and named)
LuminaDB.query('SELECT * FROM users WHERE age > ?', [25]);
LuminaDB.query('SELECT * FROM users WHERE age BETWEEN :min AND @max', { min: 24, max: 31 });

// CRUD helpers
LuminaDB.insert('users', { id: 11, name: 'Ken', age: 20 });   // arrays insert multiple rows
LuminaDB.select('users', { columns: ['id', 'name'], where: { age: 25 }, orderBy: 'id DESC', limit: 5 });
LuminaDB.update('users', { age: 26 }, { id: 1 });
LuminaDB.remove('users', { id: 1 });
LuminaDB.upsert('users', { id: 1, name: 'Alice2', age: 26 });
LuminaDB.count('users', { age: 25 }).count;

// Scripts, transactions, and more
LuminaDB.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
LuminaDB.transaction(api => { api.insert('t', {/* ... */}); });  // throwing rolls back automatically
LuminaDB.status().status.total_rows;
LuminaDB.explain('SELECT * FROM users');
LuminaDB.each('SELECT * FROM users', [], row => console.log(row));
const stmt = LuminaDB.prepare('SELECT * FROM users WHERE id = ?');
```

### 2. `fetch` (`lumina://` interception)

```js
fetch('lumina://query?sql=' + encodeURIComponent('SELECT * FROM users'));
fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }) });
fetch('lumina://tables').then(r => r.json());
```

### 3. `postMessage`

Send queries from an `iframe` (etc.) via `postMessage` and receive the results back.

---

## Persistence & running as a browser database

LuminaDB handles failure modes a server database never sees: storage quotas, browser-initiated eviction, cross-tab conflicts, and tabs being closed mid-write.

- Snapshots are stored in **IndexedDB**, and **encrypted with AES-GCM** where the Web Crypto API is available.
- **Debounced auto-save** (1s), with a **flush on tab hide** so a pending save is not lost when the tab closes.
- **Optimistic locking** aborts a save (with a warning) if another tab/window saved first, preventing accidental overwrites.
- **Multi-tab sync** — each save is announced over `BroadcastChannel`, so other tabs learn immediately that the database changed.
- **Quota errors are explained** — hitting the storage limit produces an actionable message instead of a raw `QuotaExceededError`.
- **Usage visibility** — `SHOW STORAGE` (the database's own estimated size) and `LuminaDB.storage()` (browser usage, quota, persistence state).
- **Persistent storage** — `LuminaDB.persist()` asks the browser for storage that is not evicted under disk pressure.

### Added in v1.14

In a browser, a query blocks the UI thread and the database shares the page's privilege space. These five features address exactly that.

| Feature | Why it matters | SQL | JS API |
|---------|----------------|-----|--------|
| **Statement timeout** | A runaway query can no longer freeze the page | `SET statement_timeout = 500` | `LuminaDB.timeout(500)` |
| **Read-only mode** | Expose the database safely to an iframe or third-party script | `SET read_only = ON` | `LuminaDB.readOnly(true, { lock: true })` |
| **Snapshots** | In-memory time travel — get back to a known good state | `CREATE / RESTORE / DROP SNAPSHOT s` | `LuminaDB.snapshot('s')` / `restore('s')` |
| **Live queries** | Keep the UI in sync with writes | — | `LuminaDB.subscribe(sql, rows => ...)` |
| **Profile & slow-query log** | See which queries actually cost you | `SHOW PROFILE` / `SHOW SLOW QUERIES` | `LuminaDB.profile()` / `slowQueries()` |

### Added in v1.15 — the three things a browser database really needs

| Feature | Problem it solves | API |
|---------|-------------------|-----|
| **Worker execution** | Queries own the UI thread; a heavy aggregate freezes the page | `LuminaDB.worker.*` — runs on a replica in a separate thread, optionally written back |
| **Schema migrations** | Old schemas live forever on users' devices | `LuminaDB.migrate([...])` + `PRAGMA user_version` |
| **Backup import/export** | IndexedDB disappears with the browser profile | `LuminaDB.download()` / `backup()` / `restoreBackup()` |

```js
// 1. Run the heavy query off the UI thread — the page stays responsive
await LuminaDB.worker.start();
await LuminaDB.worker.sync();                        // copy the current DB into the worker
const r = await LuminaDB.worker.query('SELECT g, COUNT(*) FROM big GROUP BY g');
await LuminaDB.worker.pull();                        // write worker-side changes back
LuminaDB.worker.stop();

// 2. Apply only what is missing; a failure rolls the whole run back via a snapshot
LuminaDB.migrate([
  { version: 1, up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)' },
  { version: 2, up: 'ALTER TABLE notes ADD COLUMN tag TEXT' },
  { version: 3, up: api => api.exec("INSERT INTO notes (id, body) VALUES (1, 'hello')") }
]);
// → { applied: [1, 2, 3], from: 0, to: 3 }

// 3. Round-trip the complete state (schema, data, views, functions, version) as one file
LuminaDB.download('mydb.json');
LuminaDB.restoreBackup(await file.text());
```

Saves are now serialized with the **Web Locks API**; optimistic locking alone still left a
window between reading the version and writing it back.

### Added in v1.16 — three more browser-database essentials

| Feature | Problem it solves | API |
|---------|-------------------|-----|
| **Incremental persistence** | Changing one row re-serialized and re-encrypted the entire database | Automatic, per table (`LuminaDB.saveStats()` shows the breakdown) |
| **Batched reads** | `rows()` materializes everything, which breaks on large tables | `LuminaDB.eachBatch()` / `LuminaDB.cursor()` |
| **Cross-tab follow & unload guard** | You never notice another tab's writes; you close with unsaved work | `LuminaDB.autoReload(true)` plus an automatic `beforeunload` guard |

Each table carries a `version:rowCount:capacity` fingerprint, and tables whose fingerprint is
unchanged are not rewritten. Measured on a 60,000-row database: a full first save takes 25 ms,
while a save after touching one small table takes **2 ms** (a no-op save is 1 ms, 0 tables written).

### Added in v1.22 — date arithmetic, hierarchical queries, analytic functions

```sql
-- Date arithmetic (previously string concatenation or NULL)
SELECT DATE '2026-01-01' + 30                AS due;      -- 2026-01-31
SELECT CURRENT_DATE - 7                      AS week_ago;
SELECT DATE '2026-03-01' - DATE '2026-01-01' AS days;     -- 59
SELECT nm, hire + 90 AS probation_end FROM emp;           -- works on DATE columns too

-- Oracle hierarchical queries
SELECT nm, LEVEL, SYS_CONNECT_BY_PATH(nm, '/') AS path, CONNECT_BY_ISLEAF AS leaf
FROM emp
START WITH mgr IS NULL
CONNECT BY PRIOR id = mgr
ORDER SIBLINGS BY nm;

SELECT name FROM users WHERE ROWNUM <= 3;                 -- the classic top-n idiom
SELECT nm FROM (SELECT nm FROM emp ORDER BY sal DESC) WHERE ROWNUM <= 3;

-- Analytic functions
SELECT nm, RATIO_TO_REPORT(sal) OVER (PARTITION BY dept)          AS share FROM emp;
SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sal) OVER () AS median FROM emp;
SELECT NTH_VALUE(nm, 2) FROM LAST OVER (ORDER BY id)              AS second_last FROM emp;
SELECT MAX(sal) KEEP (DENSE_RANK FIRST ORDER BY hire)             AS earliest_hire_sal FROM emp;

-- DDL fixes and additions
TRUNCATE TABLE t1, t2;                                    -- previously only the first table was emptied
ALTER TABLE t ADD COLUMN len INTEGER GENERATED ALWAYS AS (LENGTH(nm)) STORED;
CREATE INDEX ix ON t (nm) INCLUDE (v);
CREATE INDEX CONCURRENTLY ix2 ON t (v);
SET CONSTRAINTS ALL IMMEDIATE;
SHOW SCHEMAS;
SHOW TRANSACTION ISOLATION LEVEL;

-- RETURNING now works with upserts (only rows actually written come back)
INSERT INTO t (id, nm) VALUES (1, 'a') ON CONFLICT (id) DO NOTHING RETURNING id;
INSERT INTO t (id, nm) VALUES (1, 'b') ON CONFLICT (id) DO UPDATE SET nm = 'b' RETURNING id, nm;

-- PostgreSQL match operators
SELECT * FROM t WHERE nm ~  '^A';      -- regex
SELECT * FROM t WHERE nm ~* '^a';      -- case-insensitive
SELECT * FROM t WHERE nm !~~ 'A%';     -- NOT LIKE
SELECT CURRENT_CATALOG AS db;
```

**Fixed**: `DATE '2026-01-01' + 1` concatenated into `'2026-01-01 00:00:001'` and `date - date`
returned NULL — both are real arithmetic now, including on DATE-typed columns.
`TRUNCATE TABLE t1, t2` reported success but only emptied the first table.
`CREATE INDEX ... INCLUDE (...)` and `MAX(x) KEEP (DENSE_RANK ...)` failed with a raw
JavaScript parse error instead of being supported. `CREATE TABLE ... WITH SYSTEM VERSIONING`
and other trailing table options were silently discarded; they are accepted with a warning,
and `FOR SYSTEM_TIME` now says plainly that it is unsupported.

UI additions:

| Feature | Problem it solves | How to use |
|---------|-------------------|------------|
| **Column profile** | Answering "what is actually in this column" meant writing SQL every time | The chart icon on a table row. Lists row count, nulls and their share, distinct values, min/max, average, length range and the three most common values. Click a column name to load a distribution query |
| **ER diagram** | Foreign-key relationships were nowhere on screen | The `ER図` button at the top of the sidebar. Parents on top, children below, foreign keys drawn as arrows. Click a table for a `SELECT`, `Copy SVG` to copy the drawing |

### Added in v1.21 — windows over groups, real COLLATE, statement warnings

```sql
-- Window functions over GROUP BY output (percent of total, group ranking, running totals)
SELECT dept,
       SUM(salary)                                            AS total,
       ROUND(SUM(salary) * 100.0 / SUM(SUM(salary)) OVER (), 1) AS pct,
       RANK() OVER (ORDER BY SUM(salary) DESC)                AS rk,
       SUM(SUM(salary)) OVER (ORDER BY dept)                  AS running
FROM emp GROUP BY dept;

-- Column-level COLLATE now actually applies (comparison, IN, BETWEEN,
-- ORDER BY, GROUP BY, DISTINCT, UNIQUE / PK)
CREATE TABLE m (id INTEGER PRIMARY KEY, nm TEXT COLLATE NOCASE UNIQUE);
SELECT * FROM m WHERE nm = 'APPLE';        -- matches 'Apple'
SELECT DISTINCT nm FROM m ORDER BY nm;     -- folds case for both

-- ORDER BY ALL / GROUPING_ID
SELECT region, product FROM sales ORDER BY ALL DESC;
SELECT region, product, SUM(amt), GROUPING_ID(region, product) AS gid
FROM sales GROUP BY CUBE(region, product);

-- Standard ALTER COLUMN spellings, a conversion expression, and constraint renaming
ALTER TABLE t ALTER COLUMN amt SET DATA TYPE FLOAT;
ALTER TABLE t ALTER COLUMN s TYPE INTEGER USING LENGTH(s);
ALTER TABLE t RENAME CONSTRAINT uq_old TO uq_new;

-- Choose what happens to a value written into an identity column
INSERT INTO t (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, 'a');  -- keep the given value
INSERT INTO t (id, nm) OVERRIDING USER VALUE   VALUES (99, 'b');  -- discard it, auto-number

-- JOIN LATERAL ... ON TRUE (LEFT / INNER / CROSS)
SELECT u.name, x.c FROM users u
JOIN LATERAL (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x ON TRUE;

-- Subscripts and slices, 1-based as SQL requires (arrays, strings, JSON)
SELECT ARRAY[10, 20, 30, 40][2]    AS second;   -- 20
SELECT ARRAY[10, 20, 30, 40][2:3]  AS slice;    -- [20, 30]
SELECT ('hello')[2:4]              AS sub;      -- 'ell'

-- Non-fatal problems are recorded as warnings; the statement still runs
UPDATE emp SET salary = 0;      -- whole-table update with no WHERE
SHOW WARNINGS;                  -- read what the previous statement reported
SHOW COUNT(*) WARNINGS;
```

**Fixed**: a column-level `COLLATE` was parsed and stored but never applied, so
`WHERE nm = 'APPLE'` silently missed `'Apple'` and a `NOCASE UNIQUE` column happily accepted
both spellings. Collated columns now also bypass the hash-index fast path (indexes are built
on raw values, so an index lookup would miss the folded match). Array subscripts leaked
JavaScript's 0-based indexing; they are now 1-based, with slices. Window functions over
`GROUP BY` output are evaluated after `HAVING`, so filtered-out groups no longer affect
percentages or rankings.

UI additions:

| Feature | Problem it solves | How to use |
|---------|-------------------|------------|
| **Editor tabs** | Trying another query meant either discarding the draft or piling everything into one editor | Tabs above the editor. `+` (`Ctrl+Alt+T`) adds, `x` (`Ctrl+Alt+W`) closes, `Alt+1`-`9` switches. Names are derived from the SQL and can be renamed by double-clicking. Text and undo history are per tab and are saved in the browser, so they survive a reload |
| **Warnings in the console** | A no-op `IF EXISTS` DDL or a `WHERE`-less full-table update only ever reported "Success" | They appear as `WRN` lines in the execution log console (``Ctrl+` ``); `SHOW WARNINGS` reads them from SQL |

### Added in v1.20 — ordered aggregates, domains, set-returning functions

```sql
-- Ordered concat aggregates (the PostgreSQL / Oracle spelling)
SELECT STRING_AGG(name, ',' ORDER BY salary DESC) AS names FROM emp;
SELECT ARRAY_AGG(name ORDER BY id) AS arr FROM emp;

-- Window functions are allowed in ORDER BY (and rejected in WHERE / GROUP BY with a reason)
SELECT name FROM emp ORDER BY ROW_NUMBER() OVER (ORDER BY salary DESC);

-- Bulk update from a literal list — the usual migration-script shape
UPDATE emp SET salary = v.s FROM (VALUES (1, 111), (2, 222)) AS v(i, s) WHERE emp.id = v.i;
DELETE FROM emp USING (VALUES (9)) AS d(i) WHERE emp.id = d.i;

-- Set-returning functions in the SELECT list, and infix integer division
SELECT UNNEST(ARRAY[1, 2, 3]) AS v;
SELECT GENERATE_SERIES(1, 12) AS month;
SELECT salary DIV 1000 AS band FROM emp;

-- Domains and enums, enforced as column constraints
CREATE DOMAIN pos_int AS INTEGER CHECK (VALUE > 0);
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE survey (id INTEGER, score pos_int, m mood);

-- Users and roles (privileges are not enforced, but the scripts run)
CREATE ROLE reporting;  GRANT SELECT ON emp TO reporting;  SHOW GRANTS;

-- Empty the table but keep the numbering
TRUNCATE TABLE audit CONTINUE IDENTITY;

-- Recursive traversal order and cycle detection
WITH RECURSIVE t(id, nm) AS (
  SELECT id, nm FROM tree WHERE pid IS NULL
  UNION ALL SELECT e.id, e.nm FROM tree e JOIN t s ON e.pid = s.id
) SEARCH DEPTH FIRST BY id SET ord
SELECT id, ord FROM t ORDER BY ord;

WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM g JOIN t ON g.a = t.n)
CYCLE n SET is_cycle USING path
SELECT n, is_cycle, path FROM t;
```

**Performance**: `IN (value, ...)` now uses the hash index instead of a full scan;
`EXPLAIN` reports it as `Index lookup of N value(s)`.

**Fixed**: unaliased constant columns (`SELECT id, name, 0`) got integer-like keys and were
reordered to the front of the result, so **the output column order did not match the SELECT
list**; string constants leaked the internal `__STR_0__` token as a column name. Both now
become `columnN`. Constructs real databases reject — nested aggregates, window functions in
`WHERE` — now fail with an explanatory message instead of an internal one.

UI additions:

| Feature | Problem it solves | How to use |
|---------|-------------------|------------|
| **Row add / delete in the grid** | Cell editing worked, but adding or removing a row still meant writing SQL | Click a cell to select its row, then `− Row` to delete or `+ Row` to append a defaults-only row. Editable grids only; key values are parameter-bound |
| **Query history panel** | `Ctrl+↑↓` cycling could not reach "that statement from a while back" | The `History` button lists past statements; search to narrow, click to load into the editor, `Run` to execute immediately |

### Added in v1.19 — composite keys, sequences, MERGE and an editable grid

```sql
-- Composite foreign keys (the usual shape against a composite primary key)
CREATE TABLE order_line (
  order_id INTEGER, line_no INTEGER, sku TEXT,
  FOREIGN KEY (order_id, line_no) REFERENCES shipment(order_id, line_no) ON DELETE CASCADE
);
ALTER TABLE order_line ADD CONSTRAINT fk_ship FOREIGN KEY (order_id, line_no) REFERENCES shipment(order_id, line_no);

-- Sequence options and ALTER
CREATE SEQUENCE ticket START WITH 100 INCREMENT BY 10 MINVALUE 1 MAXVALUE 999 CYCLE;
ALTER SEQUENCE ticket RESTART WITH 500;

-- DEFAULT accepts expressions, evaluated per inserted row
CREATE TABLE audit (
  id  INTEGER DEFAULT NEXTVAL('ticket'),
  tag TEXT    DEFAULT UUID(),
  n   INTEGER DEFAULT (1 + 2)
);

-- Conditional MERGE clauses and actions on rows the source does not cover
MERGE INTO target t USING source s ON t.id = s.id
  WHEN MATCHED AND t.qty <> s.qty THEN UPDATE SET qty = s.qty
  WHEN MATCHED AND s.qty = 0      THEN DELETE
  WHEN NOT MATCHED AND s.qty > 0  THEN INSERT (id, qty) VALUES (s.id, s.qty)
  WHEN NOT MATCHED BY SOURCE      THEN DELETE;

-- Upsert additions
INSERT INTO counter (id, hits) VALUES (1, 5) ON DUPLICATE KEY UPDATE hits = hits + VALUES(hits);
INSERT INTO counter (id, hits) VALUES (1, 5)
  ON CONFLICT (id) DO UPDATE SET hits = EXCLUDED.hits WHERE counter.hits < EXCLUDED.hits;

-- View column lists (the view stays updatable)
CREATE VIEW v_user (uid, uname) AS SELECT id, name FROM users;
UPDATE v_user SET uname = 'Bobby' WHERE uid = 2;

-- DDL and metadata
ALTER INDEX ix_old RENAME TO ix_new;
SHOW TABLE STATUS LIKE 'user%';
CREATE TABLE snapshot_shape AS SELECT * FROM users WITH NO DATA;
CREATE GLOBAL TEMPORARY TABLE scratch (a INTEGER);
```

Nested aggregates (`MAX(SUM(x))`) used to fail with a confusing "column not found"; they now
report that aggregates cannot be nested and suggest computing the inner one in a subquery.

UI additions:

| Feature | Problem it solves | How to use |
|---------|-------------------|------------|
| **Editable result grid** | Fixing one value meant writing an `UPDATE` | **Double-click** a cell to edit; Enter commits, Esc cancels. Enabled only for a single-table SELECT whose result carries a key column (PK / UNIQUE) — the toolbar badge shows whether it is editable and why not. Values are always parameter-bound, so quotes and semicolons are stored as data |
| **Copy as Markdown / INSERT** | Moving results into a ticket or another database was manual | `Copy MD` copies a Markdown table (escaping `\|` and newlines); `Copy INSERT` copies `INSERT` statements (doubling quotes) |
| **Shortcut reference** | Nothing on screen listed the available keys | The `?` button in the toolbar, or press `?`. Esc closes any open modal |

### Added in v1.18 — commercial-SQL parity and client-grade UI

```sql
-- Type conversion with precision (DECIMAL rounds to scale; VARCHAR/CHAR truncate to length)
SELECT CAST(1.005 AS DECIMAL(10,2)) AS rounded;   -- 1.01, matching MySQL's rounding
SELECT CAST(12345 AS VARCHAR(3)) AS truncated;    -- '123'
SELECT CONVERT(DECIMAL(5,1), 3.14159) AS s;       -- SQL Server argument order also accepted

-- Updatable views: a projection + selection over one table accepts INSERT / UPDATE / DELETE
CREATE VIEW v_active AS SELECT id, name FROM users WHERE age >= 30 WITH CHECK OPTION;
UPDATE v_active SET name = 'Bobby' WHERE id = 2;  -- rewritten against the base table
INSERT INTO v_active (id, name) VALUES (99, 'x'); -- CHECK OPTION rejects rows outside the view

-- Aggregate views become writable through an INSTEAD OF trigger
CREATE TRIGGER tg_sum INSTEAD OF INSERT ON v_totals FOR EACH ROW
  INSERT INTO orders (user_id, amount) VALUES (NEW.user_id, NEW.total);

-- Column-level foreign keys (previously the constraint was silently dropped)
CREATE TABLE child (id INTEGER, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE);
CREATE TABLE child2 (id INTEGER, pid INTEGER REFERENCES parent);  -- resolves to the PK

-- JSON access operators and partial updates
SELECT payload ->> 'name' AS name, payload -> 'tags' AS tags FROM events;
SELECT payload #>> '{addr,city}' AS city FROM events;
SELECT COUNT(*) FROM events WHERE payload @> '{"kind":"click"}';
SELECT JSON_INSERT(payload, '$.seen', TRUE) FROM events;    -- writes missing paths only
SELECT JSON_REPLACE(payload, '$.seen', FALSE) FROM events;   -- writes existing paths only

-- Boolean predicates (three-valued: NULL is neither TRUE nor FALSE)
SELECT * FROM users WHERE (age > 30) IS NOT TRUE;

-- Named constraints and table aliases in DML
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE orders DROP CONSTRAINT fk_user;
UPDATE orders o SET o.amount = o.amount + 1 WHERE o.order_id = 1001;
DELETE FROM orders o WHERE o.amount = 0;

-- Row-constructor IN with a subquery
SELECT * FROM orders WHERE (user_id, product_id) IN (SELECT user_id, product_id FROM archive);

-- Index key ordering, expression keys, and array-to-rows
CREATE INDEX ix_price ON products (price DESC, name ASC NULLS LAST);
CREATE INDEX ix_lname ON users (LOWER(name));
SELECT SUM(v) FROM UNNEST(ARRAY[1, 2, 3]) AS t(v);
SELECT v, n FROM UNNEST(ARRAY['a','b']) WITH ORDINALITY AS t(v, n);
```

New metadata views: `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS`, `CHECK_CONSTRAINTS`,
`STATISTICS`, `TRIGGERS`, `PARAMETERS`, plus `SHOW INDEX` / `SHOW KEYS` (MySQL spellings
of `SHOW INDEXES`).

UI additions, matching what DBeaver / pgAdmin / SSMS give you day to day:

| Feature | Problem it solves | How to use |
|---------|-------------------|------------|
| **Result grid filter** | Finding one row in thousands meant editing the SQL's `WHERE` every time | Filter box above the grid (substring match across all columns; the footer shows filtered / total) |
| **Cell detail view** | Long text and JSON were clipped inside the cell | Click a cell for its type, length and raw value — JSON pretty-prints and copies in one click |
| **Expandable schema tree** | Checking columns and constraints required typing `DESCRIBE` | The ▶ next to a table expands it; each column shows its type and `PK` / `FK` / `UQ` / `NN` / `AI` / `GEN` badges, and clicking inserts the column name at the caret |
| **More object sections** | Only views and triggers were listed | Indexes / Sequences / Procedures / Functions sections (views show their `CHECK OPTION`) |
| **Transaction bar** | `BEGIN` / `COMMIT` / `ROLLBACK` were typed by hand and nothing showed uncommitted state | Begin / Commit / Rollback buttons with a live indicator and pending-change count (auto-save pauses inside a transaction) |
| **Run the statement at the caret** | You could not try one statement from a scratchpad of many | `Ctrl+Enter` runs only the statement under the cursor (`Ctrl+Shift+Enter` still runs everything); semicolons inside string literals are not treated as separators |

### Added in v1.17

| Feature | Problem it solves | API |
|---------|-------------------|-----|
| **Expression compile cache** | Hundreds of small queries make compilation, not execution, the bottleneck | Automatic (`LuminaDB.cacheStats()`) |
| **CSV import / export** | No JS API path from a `File` or a fetched string into a table | `LuminaDB.importCSV()` / `exportCSV()` |
| **Leader-tab election** | Every open tab runs the same periodic job | `LuminaDB.onLeader(cb)` / `isLeader()` |

The cache is an LRU keyed by expression text (500 entries by default). Expressions that fold
run-time state into the generated code — user variables, `LAST_INSERT_ID()`, sequences, user-defined
functions — are never cached. Repeating the same query measures about **2× faster**.

```js
// RFC 4180 CSV: quoted commas, embedded newlines and doubled quotes; blanks become NULL,
// column types are inferred per column
LuminaDB.importCSV(await file.text(), 'sales', { create: true });
const csv = LuminaDB.exportCSV('sales');

// Only the leader tab runs the background job; another tab takes over when it closes
const handle = LuminaDB.onLeader(() => startBackgroundSync());
handle.release();

LuminaDB.cacheStats();  // { hits: 204, misses: 1, size: 1, max: 500, hitRate: 0.995 }
```

```js
LuminaDB.saveStats();   // { tables: 5, written: 1, skipped: 4, removed: 0, full: false }

// Process a large result a page at a time — peak memory stays at one batch
LuminaDB.eachBatch('SELECT * FROM big ORDER BY id', [], 1000, rows => render(rows));
for (const row of LuminaDB.cursor('SELECT * FROM big ORDER BY id')) { /* ... */ }

// Follow other tabs automatically (only when this tab has no unsaved changes)
LuminaDB.autoReload(true);
```

```js
// Live query: fires only when the result actually changes (unrelated writes do not trigger it)
const sub = LuminaDB.subscribe('SELECT COUNT(*) AS c FROM users', rows => render(rows[0].c));
sub.unsubscribe();

// Publish read-only. With lock: true, SQL's SET read_only = OFF cannot re-enable writes.
LuminaDB.readOnly(true, { lock: true });

// Snapshot before a risky operation, roll back if it fails
LuminaDB.snapshot('before_import');
try { LuminaDB.importJSON('users', rows); } catch (e) { LuminaDB.restore('before_import'); }

// JSON I/O and a deterministic RAND() seed (reproducible test data)
LuminaDB.importJSON('metrics', [{ id: 1, v: 10 }], { create: true });
const dump = LuminaDB.exportJSON(['metrics']);
LuminaDB.query("SET seed = 0.42");
```

```js
await LuminaDB.storage();
// { supported: true, usage: 12345678, quota: 9876543210, usagePercent: 0.12,
//   persisted: false, estimatedBytes: 4096, tables: 3, rows: 20 }

await LuminaDB.persist();   // { granted: true | false }
```

```sql
SHOW STORAGE;    -- tables / rows / string_pool_bytes / estimated_bytes / estimated_mb ...
SHOW SETTINGS;   -- session settings and the effective isolation level
```

---

## Architecture / File Layout

A single `LuminaDB.html` provides the UI and loads the scripts; the logic is split into modules under `js/`.

```
LuminaDB.html            Entry point (UI, modals, script load order)
js/
├── engine/              SQL engine (DatabaseEngine split via prototype extension)
│   ├── engine-core.js       Constructor / seed data / query dispatch / version
│   ├── engine-expression.js Expression→JS compilation & built-in function library
│   ├── engine-select.js     SELECT execution plan
│   ├── engine-subquery.js   Subquery / CTE / table-function expansion
│   ├── engine-dml.js        INSERT / UPDATE / DELETE / triggers
│   ├── engine-ddl.js        CREATE / ALTER / DROP / procedures / function registry
│   ├── engine-transaction.js Transactions / savepoints
│   ├── engine-io.js         SQL dump import/export / IndexedDB serialization
│   └── table.js             Columnar table (TypedArray storage)
├── storage/idb.js       IndexedDB persistence (AES-GCM, Web Locks, backup import/export)
├── worker/              Worker-thread engine (keeps the UI thread free)
├── ui/                  UI (state / editor / results / table-tree / schema-editor /
│                        help / modals / data-io / query-runner / console)
├── api/api.js           External API (window.LuminaDB / fetch / postMessage)
└── tests/               Self-contained test suites (test-suite*.js)
```

---

## Testing

The 7,000+ self-contained tests can be run two ways. The main suites are:

| Suite | Tests | Focus |
|-------|-------|-------|
| `test-suite*.js` (v1–v16) | ~5,300 | SQL syntax, functions, UI, persistence |
| `test-suite-v17.js` | 247 | Regression coverage for the v1.14 syntax and operational features |
| `test-suite-v18.js` | 679 | **Security** (injection, identifier validation, JS escape, prototype pollution, DoS guards, read-only enforcement, API boundaries, output escaping) |
| `test-suite-v19.js` | 433 | **Performance** (calibrated time budgets, complexity scaling, absolute safety net) |
| `test-suite-v20.js` | 275 | v1.15 syntax and the browser-DB essentials, including security checks and time budgets for the new entry points (procedure locals, `JSON_TABLE` paths, `MATCH` terms, backup import, worker messages) |
| `test-suite-v21.js` | 185 | v1.16 procedural SQL (cursors, handlers, `SIGNAL`, `CASE` statement), range/JSON/time-series predicates, incremental persistence and streaming reads — including security checks on cursor values and `SIGNAL` message text |
| `test-suite-v22.js` | 180 | v1.17 arrays, regression aggregates, fuzzy matching, time-series generation, window extras, the compile cache, CSV import and leader election — including security checks on CSV fields/headers and array elements |
| `test-suite-v23.js` | 203 | v1.18 precision `CAST`/`CONVERT`, updatable views and `WITH CHECK OPTION`, `INSTEAD OF` triggers, column-level `REFERENCES`, JSON access operators, `IS [NOT] TRUE/FALSE`, named constraints, DML aliases, row-constructor `IN (SELECT)`, index key ordering/expression keys, metadata views and `UNNEST` — plus the UI (result filter, cell detail, tree expansion, transaction bar, run-at-caret) |
| `test-suite-v24.js` | 124 | v1.19 composite `FOREIGN KEY`, sequence options and `ALTER SEQUENCE`, `DEFAULT` expressions, conditional `MERGE` clauses and `NOT MATCHED BY SOURCE`, `VALUES(col)` / `ON CONFLICT ... WHERE`, view column lists, `ALTER INDEX RENAME` / `SHOW TABLE STATUS` / `WITH [NO] DATA`, nested-aggregate diagnostics — plus the UI (editable grid, copy formats, shortcuts), including a check that edited cell values are bound rather than concatenated into SQL |
| `test-suite-v27.js` | 123 | v1.22 date arithmetic (date ± integer, date − date), Oracle hierarchical queries (`CONNECT BY`, `LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ROOT`, `NOCYCLE`) and `ROWNUM`, analytic functions (`RATIO_TO_REPORT`, `PERCENTILE_* OVER`, `NTH_VALUE ... FROM LAST`, `KEEP (DENSE_RANK ...)`), multi-table `TRUNCATE`, `CREATE INDEX ... INCLUDE`/`CONCURRENTLY`, generated columns via `ADD COLUMN`, `SET CONSTRAINTS`, `RETURNING` with upserts, PostgreSQL match operators — plus the UI (column profile, ER diagram) |
| `test-suite-v26.js` | 115 | v1.21 window functions over `GROUP BY` output, column-level `COLLATE` made effective (comparison, `IN`, `BETWEEN`, `ORDER BY`, `GROUP BY`, `DISTINCT`, `UNIQUE`, index-path bypass), `ORDER BY ALL` / `GROUPING_ID`, `ALTER COLUMN ... SET DATA TYPE` / `TYPE ... USING`, `RENAME CONSTRAINT`, `INSERT ... OVERRIDING VALUE`, `JOIN LATERAL ... ON TRUE`, 1-based subscripts and slices, statement warnings and `SHOW WARNINGS` — plus the UI (editor tabs, warnings in the console) |
| `test-suite-v25.js` | 110 | v1.20 ordered concat aggregates, window functions in `ORDER BY`, derived-table sources for `UPDATE`/`DELETE`, set-returning functions in the SELECT list, the `DIV` operator, `CREATE DOMAIN`/`TYPE AS ENUM`, users and roles, `TRUNCATE CONTINUE IDENTITY`, recursive `SEARCH`/`CYCLE`, index-backed `IN`, constant-column naming — plus the UI (row add/delete, query history), including a check that deleted-row key values are bound |

The security suite takes 28 attacker-controlled payloads and pushes each through 10 entry points (`?` binding, named binding, `insert`, `update`, `select`, `remove`, `prepare`, SQL prepared statements, `WHERE`, `LIKE`), asserting every time that the payload **(a) is never evaluated as JS, (b) never changes the SQL structure, and (c) round-trips unchanged as data**.

The performance suite first calibrates against a measured 20,000-row scan and expresses every budget as a multiple of it. That avoids false positives on slow machines while still catching `O(n) → O(n^2)` regressions. Absolute ceilings (e.g. a 20,000-row scan under 300 ms) are pinned as well, so a uniform slowdown cannot hide inside the calibration.

### 1. Real-browser headless test (recommended, high fidelity)

```bash
bun test/browser-test.mjs
```

Opens the actual `LuminaDB.html` in headless Chrome / Edge and, via the Chrome DevTools Protocol, waits for `runTestSuite()` to finish and collects the results. Because DOM, IndexedDB, `crypto.subtle`, and `postMessage` are all real, UI, security, and encrypted persistence are verified as in production (exit codes: `0`=all pass / `1`=failures / `2`=startup error).

### 2. Manually from the browser UI

Type `runtest` into the query box and run it (or call `runTestSuite()` directly). Results appear in a toast and in the Console.

See [`test/README.md`](test/README.md) for details.

---

## License

Per this repository's terms.
