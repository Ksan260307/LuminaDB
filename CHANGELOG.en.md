# Changelog

Per-release additions and fixes for LuminaDB. Documentation for the current feature set lives in [README.en.md](README.en.md).

---

### v1.30 — defects found by the full-command sweep

Written while adding ~9,900 tests (`test-suite-v43.js` … `v50.js`) that sweep every implemented
command — the 296 functions `SHOW FUNCTIONS` reports plus every statement-level command.
Regressions live in `test-suite-v49.js`.

**Silently wrong answers**

| Symptom | Fix |
| --- | --- |
| `NULL AND FALSE` returned NULL and `NULL OR FALSE` returned FALSE (SQL says FALSE and NULL). `AND`/`OR` compiled straight to JS `&&`/`||`, so the answer diverged **only when the left operand was NULL**. Wrapped in `NOT`, the truth flipped and rows that should have been excluded passed `WHERE` | Added `__and3` / `__or3` and fold both operators as three-valued logic. The right operand is passed as a function so it is not evaluated when the left one already decides (correlated subqueries are not run needlessly) |
| `-1 BETWEEN 0 AND 10` returned `-1` and `-1 IN (0,1,2)` returned `-1`. A signed, parenthesised, or arithmetic left operand produced a number instead of a boolean — and in `WHERE`, `-1` is truthy, so the row passed | `BETWEEN` / `IN` now take their left operand as a chain of operands joined by arithmetic operators |
| `SQRT(-1)`, `ASIN(2)`, `MOD(1,0)`, `EXP(1000)` returned **NaN or Infinity**. Those serialize as `null` in JSON yet are not caught by `IS NULL`, are counted by `COUNT`, and are skipped by `SUM` | Non-finite numbers are normalized to NULL, as every real database does. A `FLOAT` column also rejects an overflowing value |
| `ROUND(x, NULL)` / `TRUNC` / `TRUNCATE` returned a rounded value; `LEFT(s, NULL)` / `RIGHT` / `LPAD` / `RPAD` returned an empty string | A NULL scale or length yields NULL |
| A column declared `DATE` kept the time part and read back as `'2024-03-15 00:00:00'`, while `CAST(x AS DATE)` returns the date only — the same date appeared in two spellings | A `DATE` column truncates to the day on write and reads back as a date. Use `TIMESTAMP` / `DATETIME` when the time matters |
| `INT` / `BIGINT` / `SMALLINT` columns skipped type checking entirely and accepted fractions and text (only the exact spelling `INTEGER` was checked). `''` stored into a `VARCHAR` column became NULL, while `TEXT` kept `''` | The declared type is normalized to a canonical kind before checking |
| `COUNT(a, b)` silently dropped the extra argument and `NTILE()` put every row in bucket 1. Functions missing from the arity table (e.g. `WIDTH_BUCKET(1,0,10)`) returned NULL instead of reporting the wrong count | Arity checks added for `COUNT` and window functions, plus 60+ entries added to the table |
| `TO_CHAR(ts, 'DD')` alone returned NULL (`'DD-MM'` worked). `D` and `G` are also numeric-format characters, so `'DD'` was routed to the number formatter | A non-numeric value is formatted as a date |
| `CAST(x AS INTEGR)` and other misspellings **succeeded without converting anything** | Unknown type names are rejected (names from `CREATE DOMAIN` / `CREATE TYPE` resolve to their base type) |
| `INITCAP('a,b,c')` gave `'A,b,c'` and `INITCAP('foo-bar')` gave `'Foo-bar'` | Words are separated by any non-alphanumeric character, as in PostgreSQL and Oracle |
| `SET NEW.col = ...` in a `BEFORE INSERT` / `BEFORE UPDATE` trigger **did nothing** — the left side was substituted with the current value and the statement discarded | The assignment is applied to the row about to be written |
| `CREATE TABLE t (a INT, a INT)` succeeded and produced a table with fewer columns than declared | Duplicate column names are rejected |
| An empty `CREATE TABLE AS SELECT` / `SELECT INTO` **lost its columns** | Columns are created from the output column names even with zero rows |
| An `OVER` clause nested two levels deep (`PARTITION BY CONCAT(a, CAST(x AS TEXT))`) was cut short, and `OVER (ORDER BY CAST(x AS TEXT))` reported unbalanced parentheses | `OVER (...)` is extracted by counting parenthesis depth, and `ORDER BY` items inside it are no longer split on whitespace — only a trailing `ASC`/`DESC`/`NULLS ...` is stripped |

**Errors that are now reported**

| Symptom | Fix |
| --- | --- |
| Every runtime error inside an expression was flattened to NULL — **including errors raised deliberately** | Exceptions marked `__sqlError`, and the statement timeout, propagate instead of being flattened |
| `DATE_TRUNC('fortnight', d)` and `DATE_PART('dayofyear', d)` silently returned NULL | An unrecognized unit is reported along with the units that are accepted |
| `DATEPART(bogus, d)` produced "Function 'DATEPART' does not exist. Did you mean 'DATEPART'?" — suggesting itself | The offending unit is named |
| `LAG(id)` without `OVER` reported "Column 'lag' not found" | Window functions report that an `OVER` clause is required |
| `INSERT INTO t (cols) WITH c AS (...) SELECT ...` reported "more than 1 row" | A `WITH` clause placed after `INSERT` is expanded too |

### v1.29 — defects found by the exhaustive test sweep

Found while adding ~10,000 generated tests (`test-suite-v36.js` – `v41.js`) built from column × operator × literal
matrices. Regressions live in `test-suite-v42.js` (44 cases).

| Symptom | Fix |
| --- | --- |
| String literals inside a `CROSS APPLY` / `LATERAL` body were lost, so the predicate failed at runtime and the query silently returned 0 rows (numeric-only predicates worked, which made it hard to spot) | Run the body with the same string table used to mask the statement, and mask substituted correlation values that are strings |
| `SELECT a.id AS id FROM a JOIN b ON …` was rejected as an ambiguous column. An alias is an output name, not a column reference | Check ambiguity against the select list with aliases stripped, and exempt output names in `HAVING` / `ORDER BY` / `QUALIFY` |
| `ROWS` frames were refused over `GROUP BY` output, so the classic running total over group sums (`SUM(SUM(v)) OVER (ORDER BY g ROWS UNBOUNDED PRECEDING)`) could not be written | Evaluate `ROWS` frames over the aggregated rows too. `RANGE` / `GROUPS` still need peer logic and remain refused (with a message that says so) |
| A derived table or CTE that returned no rows lost its columns, so `SELECT SUM(v) FROM (SELECT v FROM t WHERE false) z` failed with "column v not found" | Carry the projected column names on the result and create the columns even when there are no rows |

---

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

### v1.26 — quoted identifiers, nested GROUPING SETS, complete dumps

This release closes the two items v1.25 listed as unsupported, and fixes a gap in the SQL dump.

```sql
-- 1. Backticks make reserved words usable as identifiers (MySQL style)
CREATE TABLE t (`order` INTEGER, `select` TEXT);
SELECT `order`, `select` FROM t WHERE `order` = 1;
-- Up to v1.25 backticks passed straight through, so a column really named `order`
-- was created, and `col name` was truncated to `col — silently wrong either way
CREATE TABLE t (`col name` INTEGER);   -- names that cannot be identifiers are now refused
CREATE TABLE "my tbl" (a INT);         -- double quotes are strings; the error points at backticks

-- 2. GROUPING SETS may contain ROLLUP / CUBE / nested GROUPING SETS
SELECT a, SUM(v) FROM t GROUP BY GROUPING SETS (ROLLUP(a));
SELECT a, b, SUM(v) FROM t GROUP BY GROUPING SETS ((a,b), ROLLUP(a));
-- Up to v1.25 this failed with "Function 'ROLLUP' does not exist."
```

**3. The SQL dump is now a complete schema backup.** `Export SQL` emitted only tables, data, indexes,
views and sequences — it **silently dropped triggers, user-defined functions, procedures and comments**.
All of them are now included, indexes are written under their registered names, and implicit
PRIMARY KEY / UNIQUE indexes are no longer duplicated. A test replays a dump into an empty database
and checks every object came back.

**UI: a right-click menu on the schema tree.** Actions that previously required hand-written SQL are now
one click away — browse the first 100 rows, count rows, show the DDL, list columns, open the column
profile, edit the schema, copy the table name, or drop the table. Dropping only stages the statement in
the editor rather than running it, since it cannot be undone.

### v1.25 — NULL in arithmetic, DATE vs DATETIME, default window frames

This release clears the three items v1.24 explicitly left open. All three produced **wrong values without any error**.

```sql
-- 1. Arithmetic propagates NULL (up to v1.24, JS turned NULL into 0)
SELECT amt * qty, amt - qty, -qty FROM s;   -- every one is NULL when qty is NULL
SELECT AVG(amt*qty), MIN(amt*qty), COUNT(amt*qty) FROM s;
--   old: 366.67 / 0 / 3   ← a NULL-derived 0 won MIN and inflated the AVG denominator
--   new: 550    / 200 / 2
SELECT 10 / 0, 10 % 0;    -- old: Infinity / NaN → new: NULL (as MySQL does)

-- 2. DATE is date-only; DATETIME / TIMESTAMP keep the time
SELECT CAST('2026-01-02 13:45:00' AS DATE);       -- 2026-01-02 (the time used to survive)
SELECT CAST('2026-01-02 13:45:00' AS DATETIME);   -- 2026-01-02 13:45:00
SELECT CAST(at AS DATE) AS d, COUNT(*) FROM events GROUP BY CAST(at AS DATE);  -- daily grouping works
-- Comparisons use the instant rather than the string, so different spellings still match
SELECT DATE '2026-01-02' = TIMESTAMP '2026-01-02 00:00:00';   -- true

-- 3. An OVER clause with only ORDER BY defaults to RANGE ... CURRENT ROW (the standard)
SELECT day, SUM(amt) OVER (ORDER BY day) FROM sales;
--   old: 10, 30, 35 (row-by-row, i.e. ROWS — partial totals showed inside a day)
--   new: 30, 30, 35 (peer rows share one value)
-- Ask for the whole partition explicitly, as you would in any other database
SELECT LAST_VALUE(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t;
```

Also fixed:

```sql
-- ON DELETE / ON UPDATE SET DEFAULT was not recognised and silently degraded to RESTRICT
CREATE TABLE c (id INT, pid INT DEFAULT 9, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET DEFAULT);
DELETE FROM p WHERE id = 1;   -- c.pid returns to 9 (the delete used to be rejected)

-- COMMENT ON was missing from the undo log and survived a ROLLBACK
BEGIN; COMMENT ON TABLE t IS 'x'; ROLLBACK;   -- the previous comment is restored
```

**UI: a per-statement time limit** (30 s by default). A query holds the UI thread in a browser database,
so one mistyped join can freeze the tab forever. Change or remove it from the transaction bar; the choice is remembered.

### v1.24 — three-valued NULL logic, and a tidier data panel

The heart of v1.24 is **NULL handling**. Up to v1.23 SQL expressions compiled straight to JavaScript
operators, and JS coerces `null` to 0 in numeric contexts and makes `null === null` true — so queries
**returned the wrong rows without raising anything**.

```sql
-- behaviour up to v1.23 → behaviour in v1.24
SELECT * FROM t WHERE v < 100;      -- NULL rows were returned      → they are not
SELECT * FROM t WHERE v >= 0;       -- same                          → they are not
SELECT * FROM t WHERE v = NULL;     -- matched the NULL rows         → 0 rows (UNKNOWN)
SELECT * FROM t WHERE v <> 10;      -- included NULL rows            → excludes them
SELECT * FROM t WHERE NOT (v = 10); -- included NULL rows            → excludes them
SELECT * FROM t WHERE v BETWEEN -5 AND 5;   -- NULL rows leaked in   → 0 rows
SELECT * FROM t WHERE v NOT IN (10, NULL);  -- returned rows         → 0 rows (per the standard)
SELECT * FROM t WHERE s NOT LIKE 'x';       -- included NULL rows    → excludes them
SELECT NULL = NULL, 1 = NULL;               -- true, false           → NULL, NULL

-- CHECK constraints are three-valued too: UNKNOWN is not a violation
CREATE TABLE t (a INT, b INT CHECK (b > 0));
INSERT INTO t (a) VALUES (1);   -- always failed up to v1.23 → accepted
INSERT INTO t VALUES (2, -1);   -- a real violation is still rejected

-- Anti-joins no longer collapse on NULL
SELECT o.id FROM orders o WHERE NOT EXISTS (SELECT 1 FROM coupons c WHERE c.code = o.coupon);
```

`IS NULL`, `IS NOT NULL` and `IS UNKNOWN` are predicates rather than comparisons, so they still return booleans.

Other fixes:

```sql
-- Outer joins dropped the unmatched side's columns entirely (rows with different shapes)
SELECT * FROM a LEFT JOIN b ON a.k = b.bk;   -- unmatched rows now carry NULLs

-- ALTER TABLE accepts parameterised types and dialect aliases
ALTER TABLE t MODIFY COLUMN a VARCHAR(50);   -- was a syntax error up to v1.23
ALTER TABLE t MODIFY COLUMN b DECIMAL(12,4);

-- Table names starting with '__' are reserved (they used to be created and then silently
-- swallowed by the internal catalog on save)
CREATE TABLE __secret (a INT);   -- explicitly refused
```

JS API:

- `LuminaDB.transaction()` given an **async** callback committed before the callback's writes ran (no atomicity, exceptions lost). It is now refused with a clear message.
- `LuminaDB.insert()` / `upsert()` / `importJSON()` used **only the first row's keys** as the column list and silently dropped fields that appeared later. They now use the union of every row's keys.

UI: the four unlabelled sidebar buttons (**Export SQL / Import SQL / Import CSV / Test Data**) are now a
single **Data** button opening a tabbed panel that explains each operation (`Ctrl+Shift+D`). SQL import
lists the statements that failed and why; CSV import uses the RFC 4180 parser (quoted commas and
newlines), can create a new table from the header, can replace existing rows, and accepts drag & drop.

### Fixed in v1.23 — silently wrong results

v1.23 is mostly about places that **returned a wrong answer instead of raising an error**.

```sql
-- Aliases: trailing alias without AS, and quoted aliases (both used to leak a raw JS error)
SELECT id x, COUNT(*) c FROM users GROUP BY id;
SELECT id AS "row id", name AS "名前" FROM users;   -- the column used to be named __STR_0__

-- Qualified star
SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id;

-- Duplicate output names: later columns used to silently overwrite earlier ones (data was lost)
SELECT u.name, p.name FROM users u JOIN products p ON 1=1;   -- name, name_1
SELECT * FROM users u JOIN products p ON 1=1;                -- id, name, age, id_1, name_1, ...

-- Parenthesised set-operation branches (previously a syntax error)
(SELECT id FROM users WHERE id < 3) UNION (SELECT id FROM users WHERE id > 8);

-- Scalar functions that used to return a wrong value without complaining
SELECT LTRIM('xxhixx', 'x');        -- hixx   (the second argument was ignored)
SELECT SUBSTRING('abcdef', -3);     -- def    (negative start positions did nothing)
SELECT LPAD('abcdef', 3, '-');      -- abc    (longer strings were not truncated)
SELECT HEX('あ');                    -- E38182 (UTF-16 units were squeezed into one byte)
SELECT UNHEX(HEX('あ'));             -- あ     (the round trip was broken)
SELECT TO_TIMESTAMP(1700000000);    -- 2023-11-14 (the argument was read as milliseconds)
SELECT AGE(DATE '2020-01-01');      -- positive interval (the sign was inverted)
SELECT REGEXP_SUBSTR('a1b2c3', '[0-9]', 1, 2);   -- 2 (position/occurrence were ignored)

-- SHA-2 family added
SELECT SHA256('abc'), SHA224('abc'), SHA2('abc', 256);

-- Schema changes: metadata now follows a rename
CREATE TABLE t (a INT, b INT, c INT GENERATED ALWAYS AS (b * 2), CHECK (b > 0));
ALTER TABLE t RENAME COLUMN b TO b2;   -- generated expression, CHECK text, column order and
                                       -- index names all follow. Previously they did not, and
                                       -- the table became impossible to insert into.

-- A composite UNIQUE INDEX constrains the tuple, not each column
CREATE UNIQUE INDEX ux ON t (a, b2);   -- (1,2) and (1,3) can now coexist

-- Unknown columns in an INSERT list are rejected (they used to be created silently)
INSERT INTO users (id, nmae) VALUES (1, 'x');   -- Column 'nmae' not found. Did you mean 'name'?

-- Multiple ALTER TABLE actions / INSERT OR <action>
ALTER TABLE t ADD COLUMN d INT, ADD COLUMN e TEXT;
INSERT OR REPLACE INTO t (a) VALUES (1);   -- REPLACE / IGNORE / ABORT / FAIL / ROLLBACK
```

Error messages improved too:

| Input | Up to v1.22 | v1.23 |
|-------|-------------|-------|
| `SELECT LENGHT('abc')` | `Column 'lenght' not found.` | `Function 'LENGHT' does not exist. Did you mean 'LENGTH'?` |
| `SELECT (1+2 FROM t` | `Unexpected token ';'. Expected ')' to end a compound expression.` (raw JS wording) | `Malformed expression: (1+2 — check for unbalanced parentheses, an unclosed quote, or a missing operand.` |

UI changes in v1.23:

| Feature | Problem it solves | How |
|---------|-------------------|-----|
| **Schema search** | With many tables the sidebar could only be scanned by eye, and columns were not searchable at all | Search box in the sidebar. Substring match on table and column names; tables matched by a column expand automatically. `Esc` clears |
| **Resizable editor** | The editor was fixed at 128 px, so long statements showed only a few lines | Drag the divider below the editor (arrow keys work too). Double-click restores the default. The height is remembered |
| **Explain button** | Seeing a plan meant typing `EXPLAIN` every time | `Explain` above the editor (`Ctrl+Shift+E`). Plans the statement under the cursor without modifying data |
| **Copy TSV** | There was no way to paste results into a spreadsheet | `Copy TSV` in the result toolbar |
| **Row selection reset** (bug) | Selecting a row and then sorting or filtering made `− Row` **delete a different row** | Selection is cleared whenever the display order changes |
| **Exports follow the filter** (bug) | CSV / JSON / Markdown / INSERT exports ignored the active filter | Only the rows on screen are exported |
| **CSV null handling** (bug) | Every value was quoted, so NULL and the empty string were indistinguishable | Quote only when required; NULL is an empty field, the empty string is `""` |

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
