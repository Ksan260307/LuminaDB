# LuminaDB

[日本語](README.md) | **English**

A build-free, in-memory SQL database engine that runs entirely in the browser. Open a single HTML file and you get a full SQL engine (DQL / DML / DDL), transactions, window functions, triggers, views, commercial-DB commands such as `MERGE` / `TOP` / `ON CONFLICT`, and 320+ built-in functions — with no server.

> Self-contained tests: **52,655** (all passing — including 780+ security and 490+ performance tests)
>
> Additions and fixes are recorded in [CHANGELOG.en.md](CHANGELOG.en.md).

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
| **Aggregates** | many aggregate functions (including **`EVERY` (alias of `BOOL_AND`), `PRODUCT`, `APPROX_COUNT_DISTINCT` (returns the exact value)**) / **aggregates nested in expressions (`ROUND(AVG(x), 2)`, `100.0 * SUM(a) / SUM(b)`)** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`, `GROUPING SETS`** / **`GROUP BY ALL`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT` (multi-row, `SELECT`, `SET`, `DEFAULT`, **`DEFAULT VALUES`**) / `UPDATE` / `DELETE` (`ORDER BY`, `LIMIT`) / `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`, `DO UPDATE` (PostgreSQL, `EXCLUDED`) / `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED` (Oracle/SQL Server) / **multi-table `UPDATE ... FROM`, `UPDATE ... JOIN`, `DELETE ... USING`, `DELETE t FROM t JOIN s`** / `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE` (**`CASCADE`, `RESTRICT`**) / `VIEW` / **`MATERIALIZED VIEW` (with `REFRESH`)** / `INDEX` (**multi-column, `UNIQUE`, `DROP INDEX` by name**) / `TRIGGER` / `PROCEDURE` / `SEQUENCE` / **`FUNCTION` (user-defined scalar functions)** / `CREATE TABLE AS` & `LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **Constraints** | `PRIMARY KEY` (composite) / `UNIQUE` / `NOT NULL` / `DEFAULT` (incl. `CURRENT_TIMESTAMP`) / **`ON UPDATE CURRENT_TIMESTAMP`** / `CHECK` / `FOREIGN KEY` (`ON DELETE/UPDATE` actions) / `AUTO_INCREMENT` / **identity columns (`GENERATED ALWAYS AS IDENTITY`, `IDENTITY(1,1)`)** / generated columns (`GENERATED ALWAYS AS`) |
| **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **Row reshaping** | **`PIVOT` / `UNPIVOT`** (`UNPIVOT` skips NULL rows) |
| **Null-safe comparison** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** / **`IS [NOT] UNKNOWN`** |
| **Operators & predicates** | **`\|\|` (string concatenation)** / **`::` (cast)** / **`ILIKE`** / **`SIMILAR TO`** / **row constructors** / **`COLLATE` (`NOCASE`, `BINARY`, `NOACCENT`, `NUMERIC`)** / **`LIKE ANY`, `LIKE ALL`** / **date ± `INTERVAL`** |
| **Full-text search** | **`MATCH (col, ...) AGAINST ('terms' [IN BOOLEAN\|NATURAL LANGUAGE MODE])`** — `+`required / `-`excluded / `"phrase"` / `term*` prefix, usable as a relevance score |
| **Table functions** | `GENERATE_SERIES` (**numeric ranges and timestamp ranges with an `INTERVAL` step**) / `STRING_SPLIT(str, sep)` / `UNNEST(a, b, ...)` / **`JSON_TABLE` (JSON → rows)** / **`WITH ORDINALITY`** |
| **Arrays** | **`ARRAY[...]` constructor** / **`ARRAY_LENGTH`, `ARRAY_POSITION`, `ARRAY_CONTAINS`, `ARRAY_APPEND`, `ARRAY_PREPEND`, `ARRAY_REMOVE`, `ARRAY_SORT`, `ARRAY_TO_STRING`, `STRING_TO_ARRAY`, `ARRAY_DISTINCT`, `ARRAY_CAT`, `ARRAY_REVERSE`** / **`= ANY(ARRAY[...])`** |
| **Sampling** | **`TABLESAMPLE [BERNOULLI\|SYSTEM] (n PERCENT\|n ROWS) [REPEATABLE (seed)]`** |
| **Ranges & time series** | **`(s1, e1) OVERLAPS (s2, e2)`** / **`BETWEEN SYMMETRIC`** / **`DATE_BIN`, `TIME_BUCKET`** / **`AGE(a, b)`** / **`EXTRACT(EPOCH\|DOW\|DOY FROM ...)`** / **`AT TIME ZONE`, `CONVERT_TZ`** / **`TIMEDIFF`, `YEARWEEK`, `PERIOD_ADD`, `PERIOD_DIFF`, `JULIAN_DAY`** / **`LOCALTIME`, `LOCALTIMESTAMP`** (same as `NOW()`, following MySQL) |
| **Statistical aggregates** | **`REGR_SLOPE`, `REGR_INTERCEPT`, `REGR_R2`, `REGR_COUNT`, `REGR_AVGX`, `REGR_AVGY`, `REGR_SXX`, `REGR_SYY`, `REGR_SXY`** / **`MODE() WITHIN GROUP (ORDER BY x)`** |
| **Fuzzy matching** | **`LEVENSHTEIN` (`EDIT_DISTANCE`)** / **`SIMILARITY` (0–1)** / **`DIFFERENCE` (SOUNDEX closeness)** / **`REGEXP_MATCHES`, `REGEXP_SPLIT_TO_ARRAY`** |
| **JSON predicates** | **`<expr> IS [NOT] JSON [VALUE\|OBJECT\|ARRAY\|SCALAR]`** / **`JSON_EXISTS`** / **`JSON_QUERY`** |
| **Procedural** | **`DECLARE` / `SET` / `IF`, `ELSEIF`, `ELSE` / `WHILE`, `DO` / `LOOP`, `LEAVE`, `ITERATE` / `REPEAT`, `UNTIL` / `CASE` statement / `RETURN`** inside `CREATE PROCEDURE`, with arguments (`CALL p(1, 2)`) |
| **Cursors** | **`DECLARE <name> CURSOR FOR` / `OPEN` / `FETCH ... INTO` / `CLOSE`** (multi-column `FETCH`) |
| **Error handling** | **`DECLARE {CONTINUE\|EXIT} HANDLER FOR {NOT FOUND\|SQLEXCEPTION\|SQLSTATE 'xxxxx'}`** / **`SIGNAL`, `RESIGNAL`** with `SET MESSAGE_TEXT` |
| **Catalog** | **`INFORMATION_SCHEMA.TABLES / COLUMNS / VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE / ROUTINES / SEQUENCES / SCHEMATA`** / **`PRAGMA table_info`, `table_list`, `index_list`, `foreign_key_list`, `user_version`** / **`sqlite_master`** |
| **Compatibility syntax** | **schema-qualified `main.t` / `public.t`** / **`CREATE`, `DROP SCHEMA`, `CREATE`, `DROP DATABASE`, `USE`** / **partial indexes** / **`CREATE INDEX ... USING BTREE\|HASH`** (accepted) / **`CREATE UNLOGGED TABLE`** (accepted) / **`SELECT ... FOR UPDATE\|SHARE [NOWAIT\|SKIP LOCKED]`** / **`WITH ... AS [NOT] MATERIALIZED`** / **`EXPLAIN QUERY PLAN`, `EXPLAIN VERBOSE`** / **`REINDEX`, `CHECKPOINT`, `FLUSH`, `CLUSTER`, `REPAIR TABLE`** (accepted) / **`CHECKSUM TABLE`** (really computed) / **`SHOW CREATE FUNCTION`, `SHOW CREATE INDEX`, `SHOW ENGINES`, `SHOW COLUMNS ... LIKE`** / **`DESCRIBE <table> <column>`** / **`PRAGMA foreign_keys`** / **`SET @@var`, `RESET ALL`** / **`DO <expr>`** / **`EXECUTE IMMEDIATE '<sql>' [USING ...]`** / **`ALTER VIEW`, `CREATE TEMPORARY VIEW`** / **`REFRESH MATERIALIZED VIEW CONCURRENTLY`** / **`ORDER BY x USING <\|>`** |
| **Session statements** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`, `UNLOCK TABLES`** / **`GRANT`, `REVOKE`** / **`DISCARD`** (accepted for script compatibility) / **`SET statement_timeout`, `read_only`, `seed`, `slow_query_threshold`** / **system variables `@@version`, `@@identity`** |
| **Snapshots** | **`CREATE / RESTORE / DROP SNAPSHOT`**, **`SHOW SNAPSHOTS`** (in-memory time travel) |
| **Other** | prepared statements (`PREPARE`/`EXECUTE`/`DEALLOCATE`) / user variables (`SET @x`, **`DECLARE @x`**) / `EXPLAIN` (**`(FORMAT JSON)`**) & `EXPLAIN ANALYZE` / `VALUES` statement / `TABLE` statement / `SHOW *` (incl. **`STORAGE`, `SETTINGS`, `COMMENTS`, `MATERIALIZED VIEWS`, `SNAPSHOTS`, `PROFILE`, `SLOW QUERIES`**), `DESCRIBE`, `CHECK TABLE`, `ANALYZE TABLE` |

### Built-in functions (320+)

Covering String, Numeric, Date/Time, JSON, Regexp, Hash/Encoding, Null/Flow, Aggregate, Window, Sequence, and Meta categories. Use `SHOW FUNCTIONS` to list and search them.

Functions commonly used in commercial databases are included (selection):

- **Oracle**: `DECODE` / `NVL` / `NVL2` / `ADD_MONTHS` / `MONTHS_BETWEEN` / `NEXT_DAY` / `WIDTH_BUCKET` / `INITCAP` / `LISTAGG` / `TO_NUMBER` / `TO_CHAR` / `TO_DATE` / `NANVL` / `REMAINDER` / `SYS_GUID`
- **SQL Server**: `ISNULL` / `IIF` / `CHOOSE` / `CHARINDEX` / `PATINDEX` / `LEN` / `STUFF` / `QUOTENAME` / `PARSENAME` / `REPLICATE` / `TRY_CAST` / `TRY_CONVERT` / `DATEADD` / `DATEPART` / `DATENAME` / `NEWID` / `EOMONTH`
- **PostgreSQL**: `DATE_PART` / `SPLIT_PART` / `STARTS_WITH` / `ENDS_WITH` / `STRPOS` / `OVERLAY` / `TO_HEX` / `QUOTE_IDENT` / `QUOTE_LITERAL` / `GCD` / `LCM` / `MAKE_DATE` / `CHR` / `BTRIM` / `ENCODE` / `EVERY`
- **MySQL**: `ORD` / `CONTAINS` / `TIMEDIFF` / `YEARWEEK` / `PERIOD_ADD` / `PERIOD_DIFF` / `CONVERT_TZ` / `LOCALTIME` / `LOCALTIMESTAMP` / `JSON_SEARCH` / `JSON_MERGE_PRESERVE`
- **Common/other**: `SHIFTLEFT` / `SHIFTRIGHT` / `LOG(base, x)` / `USER` / `CURRENT_USER` / `CURRENT_SCHEMA` / `POW` / `BITAND` / `BITOR` / `BITXOR` / `UNISTR` / `JULIAN_DAY` and many more

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
| **Data screen** | Five tabs behind the sidebar's "データ" button (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>): **This browser** (save / load / reset the IndexedDB store), **File** (open, overwrite, or save-as a `.luminadb` file), **Export** (SQL dump, JSON), **Import** (SQL and CSV, drag & drop), and **Test data** (generate dummy rows). **Every control explains on screen what it does, where the data ends up, and whether it can be undone.** |
| **Interface language** | Switch with **JP / EN** in the sidebar header (**Japanese is the default**); the choice persists across visits. **Your data — table names, results, the execution log — is never translated**, and SQL engine errors stay English in both languages. |
| **Saving** | Changes auto-save to this browser (IndexedDB) one second later; a line in the sidebar shows whether a save is pending. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves to the browser immediately, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves to a file. |

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

All 52,655 tests are grouped into seven layers by what they check. The earlier layers sit closer to the foundations; the later ones cluster around places that once broke.
Counts are per table (only `v1–v16` is approximate); how to run them is [further down this section](#1-real-browser-headless-test-recommended-high-fidelity).

### Coverage — every implemented feature (approx. 16,700 tests)

The layer that walks the whole feature set once. Green here means the features exist.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite*.js` (v1–v16) | ~5,300 | SQL syntax, functions, UI, persistence |
| `test-suite-v50.js` | 1,976 | **Scalar expression sweep.** The evaluation layer everything else rests on, swept across arithmetic, comparison, string, `CASE`, NULL propagation, operator precedence, deep nesting, and application to columns |
| `test-suite-v43.js` | 1,448 | **Every numeric (53) and string (60) function.** Each function that `SHOW FUNCTIONS` reports is swept against an input battery: boundaries, out-of-domain inputs, NULL propagation, whole-column comparison, nesting, use in every clause, and wrong argument counts. Expected values come from a JavaScript reference implementation |
| `test-suite-v44.js` | 1,514 | **Every date/time (61), conversion (9), regexp (5), and encoding/hash (9) function.** Field extraction, every unit of `EXTRACT`/`DATEPART`/`DATE_PART`/`DATENAME`, add/subtract across 8 units and signs, differences, truncation and construction, format specifiers, the 14 current-time functions, leap years and month ends, the cast matrix, and known hash values with round trips |
| `test-suite-v45.js` | 1,451 | **Every JSON (21), aggregate (33), window (11), conditional/NULL (17), meta (14), and sequence (3) function.** Aggregate × filter × grouping sweep, window aggregate × 12 frames × 3 partitions (all 80 values compared each time), JSON path × document sweep, and conditional function × input sweep |
| `test-suite-v46.js` | 560 | **Every DDL statement.** `CREATE TABLE` column definitions, constraints and options; 36 data types × values stored and read back; every `ALTER TABLE` action × table state; indexes (create, rename, drop, and result invariance); views and materialized views; procedures, functions and triggers; domains, enums and sequences; every `DROP` target; `TRUNCATE`/`RENAME`/maintenance commands; CTAS and `SELECT INTO` |
| `test-suite-v47.js` | 407 | **Every DML, transaction, procedural, and session statement.** All `INSERT` forms and conflict handling, an `UPDATE` assignment × filter sweep, all `DELETE` forms, `MERGE` branches, `RETURNING`, transaction × operation × outcome, savepoints, prepared statements, variables and session settings, snapshots, procedural syntax, `VALUES`/`TABLE` statements, and constraint violations leaving nothing behind |
| `test-suite-v48.js` | 1,522 | **Every SELECT clause, operator, predicate, and metadata query.** Operator sweep; predicate sweep (`IN`/`BETWEEN`/`LIKE`/`EXISTS`/`ANY`/`ALL`/`IS`); the `WHERE` × `ORDER BY` × `LIMIT`/`OFFSET` matrix; join kinds; `GROUP BY`/`HAVING`; set operations; every position a subquery can take; every `SHOW`/`DESCRIBE`/`EXPLAIN`/`PRAGMA`/`INFORMATION_SCHEMA` variant; table functions, arrays, `PIVOT`, and full-text search |
| `test-suite-v62.js` | 2,503 | **Full check of the commands added in v1.33.** Statements (`CREATE`/`DROP DATABASE`, `USE`, `ALTER VIEW`, `CREATE TEMPORARY VIEW`, `EXECUTE IMMEDIATE`, `DO`, `RESET`, `CHECKSUM`/`REPAIR TABLE`, `PRAGMA foreign_keys`, `SHOW ENGINES`/`CREATE INDEX`/`COLUMNS ... LIKE`, `DESCRIBE <table> <column>`, `EXPLAIN VERBOSE`, `ORDER BY ... USING`), aggregates (`EVERY`, `PRODUCT`, `APPROX_COUNT_DISTINCT`) and 18 scalar functions, each checked against a JavaScript reference implementation or an existing equivalent function. Includes exhaustive sweeps — all 256 time-zone pairs, 220 period arithmetic cases, 144 string × substring pairs — plus spelling sweeps (case, newlines, tabs, comments), whitespace-position sweeps, and the spellings that must be rejected |

### Exhaustive sweeps over large data (11,672 tests)

Defects that small examples never surface — join order, frames, index usage — hunted with thousand-row tables and machine-generated combinations. Expected values come from a model built in JavaScript, not from SQL.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v34.js` | 1,717 | **Large-query coverage.** Builds a 5,000-row fact table, a 1,000-row mid table and an 81-column wide table, then exercises multi-way joins (four tables, reordered joins, `USING`/`NATURAL`/`APPLY`/`LATERAL`, semi/anti joins), large-scale aggregation (`ROLLUP`/`CUBE`/`GROUPING SETS`, `FILTER`, `DISTINCT` aggregates, statistical aggregates, `WITHIN GROUP`), window functions (ranking, frames, `EXCLUDE`, `LAG`/`LEAD`, `QUALIFY`, named windows), deep and recursive CTEs, long set-operation chains, huge `IN`/`CASE`/column lists, bulk DML and transactions, paging, table functions, `PIVOT`, JSON and arrays, result invariance with and without indexes, and end-to-end reporting scenarios. Expected values come from a **JavaScript model built with the same rules as the fixture**, not from other SQL (differential testing) |
| `test-suite-v36.js` | 1,747 | **Exhaustive multi-way joins.** Predicates built from column × operator × literal are pushed through a four-table join, together with join types × `ON` conditions, reordered joins, self and non-equi joins, semi/anti joins, `USING`/`NATURAL`, `APPLY`/`LATERAL`, chained outer joins, and result invariance with and without indexes |
| `test-suite-v37.js` | 1,623 | **Exhaustive aggregation.** Over 2,500 rows, 18 groupings × 14 aggregate functions are compared result-set by result-set, plus `HAVING`, `ROLLUP`/`CUBE`/`GROUPING SETS`, `FILTER`, `DISTINCT` aggregates, statistical aggregates, `WITHIN GROUP`, and a filter × aggregate matrix |
| `test-suite-v38.js` | 1,323 | **Exhaustive window functions.** Over 800 rows: ranking functions × partitions × orders, 24 frames × 8 aggregates × 5 partitions, `EXCLUDE`, `LAG`/`LEAD` offsets and defaults, `RANGE`/`GROUPS`, `QUALIFY`, named windows, windows inside expressions, windows over `GROUP BY` output, and moving averages — every test compares all 800 values |
| `test-suite-v39.js` | 1,649 | **Exhaustive CTEs, subqueries and set operations.** Derived tables nested 40 deep, 40 CTEs, recursion to 499 levels, correlated and scalar subqueries, `UNION` chains of 60 branches, `INTERSECT`/`EXCEPT`, parenthesised set operations, `VALUES`, and "the same filter written eight ways agrees" |
| `test-suite-v40.js` | 1,950 | **Exhaustive expressions, ordering and paging.** Numeric/string/conditional/cast functions across varying inputs, `LIKE` and regular expressions, 20 orderings, full-table paging sweeps, `DISTINCT`, huge `IN`/`CASE`/concatenation expressions, and a predicate × ordering × paging matrix |
| `test-suite-v41.js` | 1,663 | **Bulk DML, table functions, indexes and end-to-end reports.** `UPDATE` assignment × filter matrix, `DELETE`, `INSERT`/`MERGE`/upsert, multi-table DML, constraints, `RETURNING`, transactions and savepoints, table functions, JSON, arrays, `PIVOT`, index invariance, `EXPLAIN` and metadata |

### Spelling — the same query written differently (11,216 tests)

Hunts for "reformat it and the answer changes" defects. Layout, case, comments and paraphrases are applied mechanically, and the result must not differ from the baseline by a single character.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v51.js` | 4,122 | **Lexical and layout styles.** 60 implemented queries put through case changes, whitespace, tabs, CRLF, surrounding blank lines, trailing semicolons, line comments and block comments — plus an exhaustive sweep that replaces **each single space, one at a time, with a newline or a comment**. Also covers identifier/alias/qualification spellings and the forms that are rejected (`"…"` is a string, `[…]` is not an identifier quote, `#` is not a comment) |
| `test-suite-v52.js` | 783 | **Same meaning, different phrasing.** Predicate rewrites (`=` / `<>` / `<` / `BETWEEN` / `IN` / `IS NULL`), boolean algebra (commutativity, De Morgan, distribution, double negation), joins (`JOIN` / comma / `CROSS`+`WHERE` / subquery / swapped sides / semi- and anti-joins), aggregation, subqueries and CTEs, ordering and paging, function synonyms, and set operations — all over a table containing NULLs |
| `test-suite-v53.js` | 1,329 | **Clause combinations.** 144 combinations of `DISTINCT` × join × `WHERE` × `GROUP BY` × `HAVING` × `ORDER BY` × `LIMIT` / `OFFSET`, each written one-line, formatted, commented, upper/lower case, tab-separated, as a derived table, as a CTE, and with ordinals. Join reordering, window-clause spellings, `ROLLUP` / `GROUPING SETS`, and set-operation grouping are checked the same way |
| `test-suite-v54.js` | 1,307 | **Function calls and expressions.** 135 built-in functions × 9 call styles (space before the parenthesis, spacing around commas, one argument per line, comments between arguments, case, tabs), argument spellings, operator precedence, `CASE` layouts, cast spellings, date expressions, JSON accessors, and string-function synonyms |
| `test-suite-v55.js` | 1,146 | **DML / DDL / transaction styles.** 33 baseline `INSERT` / `UPDATE` / `DELETE` statements put through 10 lexical transforms and a per-space newline/comment sweep, comparing the resulting table contents. DDL variants are compared by schema (column definitions, constraints, type aliases, `ALTER` spellings), and transaction statements (`BEGIN` / `START TRANSACTION` / `COMMIT WORK` …) across 60 combinations |
| `test-suite-v56.js` | 2,529 | **Real-world formatting and end-to-end scenarios.** 40 realistic order/customer/line-item queries put through formatter-style layouts (leading commas, newline per clause, full indentation) and the per-space newline/comment sweep. Also covers meta queries (`SHOW` / `DESCRIBE` / `EXPLAIN` / `INFORMATION_SCHEMA`) and the same aggregate assembled seven different ways |

### Unusual query shapes (8,804 tests)

Shapes nobody writes but the engine still has to handle: depth, width, degenerate data, edge values, and differing execution conditions.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v57.js` | 856 | **depth and width.** Derived tables, CTE chains, function calls, parentheses, `CASE` and subqueries nested one level at a time up to 80 deep; select items, `IN` lists, operator chains, `WHEN` branches, `ORDER BY` keys and joined tables widened one at a time up to 320 — each compared against the plain query that means the same thing. Also deep structures combined with outer clauses, formatted layouts, and the limits that are rejected (recursion cap, etc.) |
| `test-suite-v58.js` | 2,905 | **degenerate data and boundaries.** Eleven table shapes (0 rows, 1 row, all NULL, all the same value, all duplicates, all negative, two values, one value with the rest NULL, …) put through 22 aggregates, grouping, a 15 × 15 `LIMIT` × `OFFSET` grid, 42 predicates including always-true/false, ordering, joins, set operations, 18 window functions, and no-op writes — **with expected values computed by a JavaScript model** |
| `test-suite-v59.js` | 1,126 | **clause and scope interactions.** Subqueries in 17 positions × 7 forms, name collisions (column alias, table alias, CTE name and derived-table name matching a real table), simultaneous clauses (grouping key × aggregate × filter written five different ways), correlation position, set operations with clauses, unusual join conditions (constant, null-safe, `OR`, inequality, subquery), and window functions interacting with `GROUP BY` / `QUALIFY` |
| `test-suite-v60.js` | 2,749 | **extreme values and types.** 21 numbers (overflow, tiny, negative zero, integer limits) × operators, comparisons and 21 numeric functions; 20 strings (empty, very long, surrogate pairs, control characters, quotes) × string functions; 22 dates from 1900 to 2999 × date functions; mixed-type comparison; extreme values stored in columns; unusual JSON shapes; rounding and precision |
| `test-suite-v61.js` | 1,168 | **invariance across execution conditions.** The same 56 queries run with six index configurations, four row-insertion orders, inside/outside transactions and after a rollback, through views / temp tables / CTEs, and with a warm expression cache — the answer must not change by a single character. Also covers unusual write shapes (self-referencing `UPDATE`, `UPDATE ... FROM`, chained upserts) |

### Security and performance (1,112 tests)

A different axis from correctness: attacker-controlled strings must stay values at every entry point, and complexity must scale as intended.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v18.js` | 679 | **Security** (injection, identifier validation, JS escape, prototype pollution, DoS guards, read-only enforcement, API boundaries, output escaping) |
| `test-suite-v19.js` | 433 | **Performance** (calibrated time budgets, complexity scaling, absolute safety net) |

The security suite takes 28 attacker-controlled payloads and pushes each through 10 entry points (`?` binding, named binding, `insert`, `update`, `select`, `remove`, `prepare`, SQL prepared statements, `WHERE`, `LIKE`), asserting every time that the payload **(a) is never evaluated as JS, (b) never changes the SQL structure, and (c) round-trips unchanged as data**.

The performance suite first calibrates against a measured 20,000-row scan and expresses every budget as a multiple of it. That avoids false positives on slow machines while still catching `O(n) → O(n^2)` regressions. Absolute ceilings (e.g. a 20,000-row scan under 300 ms) are pinned as well, so a uniform slowdown cannot hide inside the calibration.

### Interface and operational features (93 tests)

Exercises the real DOM, IndexedDB, workers and clipboard. Interface checks also live inside the regression suites below; these two cover the screens that were rebuilt in a given release.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v63.js` | 59 | **The reorganized data screen** (v1.34). Checks that the six controls moved out of the sidebar are actually reachable in the modal, that **all six carry a heading and an explanation**, that the destructive one is red and says it cannot be undone, that tabs and panes match one-to-one, that the save-state readout tracks the real data size, that `Ctrl+S` suppresses the browser's own save dialog, and that the original three tabs still work |
| `test-suite-v64.js` | 34 | **Japanese / English UI** (v1.35). Japanese is the default; the choice reaches `localStorage` and `<html lang>`; **no Japanese remains in English mode** (checked mechanically across the main screen, every modal, all five data-screen tabs, and the command reference); ja → en → ja restores the original; five round trips leave it intact; `i18nT` argument substitution and fallback for unknown strings; placeholder counts matching between source and translation; and table names, result cells and engine errors staying untranslated |

### Regression — added features and fixed defects (3,072 tests)

What keeps fixed things fixed. It grows every time a feature lands or a sweep finds a defect.

| Suite | Tests | What it checks |
|----------|------|------|
| `test-suite-v17.js` | 247 | Regression coverage for the added syntax and operational features |
| `test-suite-v20.js` | 275 | syntax and the browser-DB essentials, including security checks and time budgets for the new entry points (procedure locals, `JSON_TABLE` paths, `MATCH` terms, backup import, worker messages) |
| `test-suite-v21.js` | 185 | procedural SQL (cursors, handlers, `SIGNAL`, `CASE` statement), range/JSON/time-series predicates, incremental persistence and streaming reads — including security checks on cursor values and `SIGNAL` message text |
| `test-suite-v22.js` | 180 | arrays, regression aggregates, fuzzy matching, time-series generation, window extras, the compile cache, CSV import and leader election — including security checks on CSV fields/headers and array elements |
| `test-suite-v23.js` | 203 | precision `CAST`/`CONVERT`, updatable views and `WITH CHECK OPTION`, `INSTEAD OF` triggers, column-level `REFERENCES`, JSON access operators, `IS [NOT] TRUE/FALSE`, named constraints, DML aliases, row-constructor `IN (SELECT)`, index key ordering/expression keys, metadata views and `UNNEST` — plus the UI (result filter, cell detail, tree expansion, transaction bar, run-at-caret) |
| `test-suite-v24.js` | 124 | composite `FOREIGN KEY`, sequence options and `ALTER SEQUENCE`, `DEFAULT` expressions, conditional `MERGE` clauses and `NOT MATCHED BY SOURCE`, `VALUES(col)` / `ON CONFLICT ... WHERE`, view column lists, `ALTER INDEX RENAME` / `SHOW TABLE STATUS` / `WITH [NO] DATA`, nested-aggregate diagnostics — plus the UI (editable grid, copy formats, shortcuts), including a check that edited cell values are bound rather than concatenated into SQL |
| `test-suite-v25.js` | 110 | ordered concat aggregates, window functions in `ORDER BY`, derived-table sources for `UPDATE`/`DELETE`, set-returning functions in the SELECT list, the `DIV` operator, `CREATE DOMAIN`/`TYPE AS ENUM`, users and roles, `TRUNCATE CONTINUE IDENTITY`, recursive `SEARCH`/`CYCLE`, index-backed `IN`, constant-column naming — plus the UI (row add/delete, query history), including a check that deleted-row key values are bound |
| `test-suite-v26.js` | 115 | window functions over `GROUP BY` output, column-level `COLLATE` made effective (comparison, `IN`, `BETWEEN`, `ORDER BY`, `GROUP BY`, `DISTINCT`, `UNIQUE`, index-path bypass), `ORDER BY ALL` / `GROUPING_ID`, `ALTER COLUMN ... SET DATA TYPE` / `TYPE ... USING`, `RENAME CONSTRAINT`, `INSERT ... OVERRIDING VALUE`, `JOIN LATERAL ... ON TRUE`, 1-based subscripts and slices, statement warnings and `SHOW WARNINGS` — plus the UI (editor tabs, warnings in the console) |
| `test-suite-v27.js` | 123 | date arithmetic (date ± integer, date − date), Oracle hierarchical queries (`CONNECT BY`, `LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ROOT`, `NOCYCLE`) and `ROWNUM`, analytic functions (`RATIO_TO_REPORT`, `PERCENTILE_* OVER`, `NTH_VALUE ... FROM LAST`, `KEEP (DENSE_RANK ...)`), multi-table `TRUNCATE`, `CREATE INDEX ... INCLUDE`/`CONCURRENTLY`, generated columns via `ADD COLUMN`, `SET CONSTRAINTS`, `RETURNING` with upserts, PostgreSQL match operators — plus the UI (column profile, ER diagram) |
| `test-suite-v28.js` | 162 | aliases (`AS`-less and quoted), qualified stars, duplicate output-name resolution, `LTRIM`/`RTRIM` character sets, negative `SUBSTRING` offsets, `LPAD`/`RPAD` truncation, UTF-8 `HEX`/`UNHEX`, epoch-second `TO_TIMESTAMP`, `AGE` sign, `REGEXP_*` position/occurrence/match_type, `SHA2`/`SHA256`/`SHA224`, metadata following column renames and drops (generated columns, CHECK, column order, index names), composite `UNIQUE INDEX`, rejection of unknown INSERT columns, `INSERT OR <action>`, multi-action `ALTER TABLE`, parenthesised set operations, error messages — plus the UI (schema search, splitter, Explain, row selection, exports) |
| `test-suite-v29.js` | 82 | three-valued NULL logic (comparisons, `NOT`, `IN`/`NOT IN`, `CHECK`, LIKE-family), `IS [NOT] NULL`/`UNKNOWN` staying predicates, NULL-filled outer-join `SELECT *`, parameterised/aliased `ALTER TABLE` types, refusal of `__`-prefixed table names, `transaction()` rejecting async callbacks, `insert()` using the union of row keys — plus the UI (Data modal consolidation, SQL import failure report, RFC 4180 CSV, table creation, replace, drag & drop) |
| `test-suite-v30.js` | 68 | arithmetic NULL propagation (`+ - *`, unary minus, precedence, exponent notation) and division by zero, `DATE` vs `DATETIME`/`TIMESTAMP` (casts, typed literals, `::`, daily `GROUP BY`, cross-spelling comparisons), default window frames (`RANGE ... CURRENT ROW`, explicit `ROWS`, `PARTITION BY`, windows over GROUP BY), `ON DELETE SET DEFAULT`, `COMMENT ON` rollback, UI (statement time limit) |
| `test-suite-v31.js` | 41 | backtick-quoted identifiers (reserved words as column/table names, explicit errors for unusable or unterminated names, string literals untouched, errors returned rather than thrown), `ROLLUP`/`CUBE`/nesting inside `GROUPING SETS`, `exportSQL` emitting triggers, functions, procedures and comments plus index names and a replay round-trip, UI (schema-tree context menu) |
| `test-suite-v35.js` | 106 | Regressions for the gaps found by the large-query suite: the `LAG`/`LEAD` default argument, `GROUP_CONCAT(x, 'sep')` and aggregate arity, `DATE(x)` arithmetic, ordering by a column that the select list renamed, window functions and `FILTER` written inside a larger expression, `CREATE TABLE AS` over a CTE, `GROUPING SETS (())`, the left-hand side of `IS JSON`, chained/nested/derived-table `APPLY`, and parenthesised set operations used as a derived table |
| `test-suite-v42.js` | 44 | Regressions for the defects the sweep found: string literals lost inside an `APPLY` body, an alias that collides with a joined column no longer reported as ambiguous, `ROWS` frames over `GROUP BY` output, and empty derived tables/CTEs keeping their columns |
| `test-suite-v49.js` | 1,007 | Regressions for the defects this sweep found, plus cross-clause combinations: the three-valued truth table, the same function used in eight clause positions, join × predicate × ordering, aggregates combined with windows, `BETWEEN`/`IN` left operand × value sweep, and nested `OVER` clauses |

There are three ways to run them. During development, use 2 for quick feedback and finish with 1.

The 50,000+ self-contained tests can be run three ways. The main suites are:

### 1. Real-browser headless test (recommended, high fidelity)

```bash
bun test/browser-test.mjs
```

Opens the actual `LuminaDB.html` in headless Chrome / Edge and, via the Chrome DevTools Protocol, waits for `runTestSuite()` to finish and collects the results. Because DOM, IndexedDB, `crypto.subtle`, and `postMessage` are all real, UI, security, and encrypted persistence are verified as in production (exit codes: `0`=all pass / `1`=failures / `2`=startup error).

### 2. Single-suite runner (fast feedback while developing)

```bash
bun test/run-suite.mjs v51
```

Loads only the engine and runs one SQL-only suite (`all` runs them all). It finishes in about a second,
so the usual loop is: change the engine, run this, then confirm with route 1 at the end.

### 3. Manually from the browser UI

Type `runtest` into the query box and run it (or call `runTestSuite()` directly). Results appear in a toast and in the Console.

See [`test/README.md`](test/README.md) for how to run the tests and how to write a suite (the shared `makeTestKit` helpers).

---

## License

Per this repository's terms.
