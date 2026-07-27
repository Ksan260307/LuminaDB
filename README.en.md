# LuminaDB

[日本語](README.md) | **English**

A build-free, in-memory SQL database engine that runs entirely in the browser. Open a single HTML file and you get a full SQL engine (DQL / DML / DDL), transactions, window functions, triggers, views, commercial-DB commands such as `MERGE` / `TOP` / `ON CONFLICT`, and 270+ built-in functions — with no server.

> Version: **v1.13.0** / Self-contained tests: **5,082** (all passing)

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
| **DQL** | `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` (ordinal, expression, `NULLS FIRST/LAST`) / `LIMIT`, `OFFSET`, `FETCH FIRST` / `TOP n [PERCENT]` (SQL Server) / `DISTINCT` |
| **Joins** | `INNER` / `LEFT` / `RIGHT` / **`FULL OUTER`** / `CROSS` / comma join / `USING` / `NATURAL` / **`CROSS APPLY`, `OUTER APPLY`, `LATERAL`** |
| **Set ops** | `UNION` / `INTERSECT` / `EXCEPT` (with `ALL`) |
| **Subqueries** | scalar / `IN` / `EXISTS` / correlated / **quantified comparison `= ANY`, `> ALL`, `SOME`** |
| **CTEs** | `WITH` / `WITH RECURSIVE` (with column lists) |
| **Window functions** | `ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / frame specs (**`ROWS` / `RANGE` / `GROUPS`**) / named windows (`WINDOW` clause) / `QUALIFY` (**inline window functions supported**) |
| **Aggregates** | many aggregate functions / **aggregates nested in expressions (`ROUND(AVG(x), 2)`, `100.0 * SUM(a) / SUM(b)`)** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`, `GROUPING SETS`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT` (multi-row, `SELECT`, `SET`, `DEFAULT`) / `UPDATE` / `DELETE` (`ORDER BY`, `LIMIT`) / `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`, `DO UPDATE` (PostgreSQL, `EXCLUDED`) / `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED` (Oracle/SQL Server) / `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE` / `VIEW` / **`MATERIALIZED VIEW` (with `REFRESH`)** / `INDEX` / `TRIGGER` / `PROCEDURE` / `SEQUENCE` / `CREATE TABLE AS` & `LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **Constraints** | `PRIMARY KEY` (composite) / `UNIQUE` / `NOT NULL` / `DEFAULT` (incl. `CURRENT_TIMESTAMP`) / `CHECK` / `FOREIGN KEY` (`ON DELETE/UPDATE` actions) / `AUTO_INCREMENT` / **identity columns (`GENERATED ALWAYS AS IDENTITY`, `IDENTITY(1,1)`)** / generated columns (`GENERATED ALWAYS AS`) |
| **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **Row reshaping** | **`PIVOT` / `UNPIVOT`** (`UNPIVOT` skips NULL rows) |
| **Null-safe comparison** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** |
| **Session statements** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`, `UNLOCK TABLES`** / **`GRANT`, `REVOKE`** / **`DISCARD`** (accepted for script compatibility) |
| **Other** | prepared statements (`PREPARE`/`EXECUTE`/`DEALLOCATE`) / user variables (`SET @x`) / `EXPLAIN` & `EXPLAIN ANALYZE` / `VALUES` statement / `TABLE` statement / `SHOW *` (incl. **`STORAGE`, `SETTINGS`, `COMMENTS`, `MATERIALIZED VIEWS`**), `DESCRIBE`, `CHECK TABLE`, `ANALYZE TABLE` |

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
├── storage/idb.js       IndexedDB persistence (AES-GCM encryption, optimistic lock)
├── ui/                  UI (state / editor / results / table-tree / schema-editor /
│                        help / modals / data-io / query-runner / console)
├── api/api.js           External API (window.LuminaDB / fetch / postMessage)
└── tests/               Self-contained test suites (test-suite*.js)
```

---

## Testing

The 2,000+ self-contained tests can be run two ways.

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
