# LuminaDB

**日本語** | [English](README.en.md)

ブラウザだけで完結する、ビルド不要の in-memory SQL データベースエンジンです。単一の HTML ファイルを開くだけで、本格的な SQL（DQL / DML / DDL）・トランザクション・ウィンドウ関数・トリガー・ビュー・`MERGE` / `TOP` / `ON CONFLICT` などの商用 DB コマンド・270 以上の組み込み関数を、サーバーなしで実行できます。

> バージョン: **v1.13.0** / 自己完結テスト **5,082 件**（全パス）

---

## 特徴

- **依存ゼロ・ビルド不要** — `LuminaDB.html` を開くだけ。バンドラもパッケージマネージャも不要（スタイルのみ Tailwind CDN を利用）。
- **列指向ストレージ** — `Float64Array` + `Uint32Array` による 32bit パッキングでメモリ効率とキャッシュ局所性を確保。20 万行スキャン + LIKE が実測 ~26ms。
- **本格的な SQL エンジン** — 後述のとおり主要な SQL 構文をほぼ網羅。
- **商用 DB 互換関数** — MySQL / PostgreSQL / Oracle / SQL Server で頻用される関数を幅広く実装。
- **永続化** — IndexedDB へ **AES-GCM 暗号化**で保存。タブ間の上書きを防ぐ楽観ロック付き。
- **外部 API** — `window.LuminaDB`（JS API）、`fetch('lumina://...')`、`postMessage` の 3 経路でアプリから利用可能。
- **充実した UI** — シンタックスハイライト付きエディタ、Table Editor、検索付きコマンドリファレンス、実行ログコンソールなど。

---

## クイックスタート

### そのまま開く
`LuminaDB.html` をブラウザで開くだけで動作します。

### ローカルサーバー経由（推奨）
IndexedDB による永続化・暗号化などブラウザのセキュリティ機能をフルに使うには、`file://` ではなくローカルサーバー経由での起動を推奨します。

```bash
python -m http.server 8788
# → http://localhost:8788/LuminaDB.html
```

起動すると `users` / `products` / `orders` のサンプルテーブルが用意されています。エディタに SQL を入力して **Run**（または `Ctrl+Enter`）で実行してください。

```sql
SELECT u.name, o.amount
FROM users u
JOIN orders o ON u.id = o.user_id
ORDER BY o.amount DESC;
```

---

## SQL サポート範囲

| 分類 | 対応内容 |
|------|----------|
| **DQL** | `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY`（序数・式・`NULLS FIRST/LAST`）/ `LIMIT`・`OFFSET`・`FETCH FIRST` / `TOP n [PERCENT]`（SQL Server）/ `DISTINCT` |
| **結合** | `INNER` / `LEFT` / `RIGHT` / **`FULL OUTER`** / `CROSS` / カンマ結合 / `USING` / `NATURAL` / **`CROSS APPLY`・`OUTER APPLY`・`LATERAL`** |
| **集合演算** | `UNION` / `INTERSECT` / `EXCEPT`（`ALL` 対応） |
| **サブクエリ** | スカラー / `IN` / `EXISTS` / 相関サブクエリ / **量化比較 `= ANY`・`> ALL`・`SOME`** |
| **CTE** | `WITH` / `WITH RECURSIVE`（列リスト対応） |
| **ウィンドウ関数** | `ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / フレーム指定（**`ROWS` / `RANGE` / `GROUPS`**）/ named window（`WINDOW` 句）/ `QUALIFY`（**ウィンドウ関数の直書き可**） |
| **集計** | 多数の集計関数 / **式に内包した集計（`ROUND(AVG(x), 2)`・`100.0 * SUM(a) / SUM(b)`）** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`・`GROUPING SETS`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT`（複数行・`SELECT`・`SET`・`DEFAULT`）/ `UPDATE` / `DELETE`（`ORDER BY`・`LIMIT`）/ `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`・`DO UPDATE`（PostgreSQL・`EXCLUDED`）/ `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED`（Oracle/SQL Server）/ `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE` / `VIEW` / **`MATERIALIZED VIEW`（`REFRESH` 付き）** / `INDEX` / `TRIGGER` / `PROCEDURE` / `SEQUENCE` / `CREATE TABLE AS`・`LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **制約** | `PRIMARY KEY`（複合可）/ `UNIQUE` / `NOT NULL` / `DEFAULT`（`CURRENT_TIMESTAMP` 含む）/ `CHECK` / `FOREIGN KEY`（`ON DELETE/UPDATE` 参照アクション）/ `AUTO_INCREMENT` / **識別列（`GENERATED ALWAYS AS IDENTITY`・`IDENTITY(1,1)`）** / 生成列（`GENERATED ALWAYS AS`） |
| **トランザクション** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **行変換** | **`PIVOT` / `UNPIVOT`**（縦横変換。`UNPIVOT` は NULL 行を除外） |
| **NULL 安全比較** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** |
| **セッション文** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`・`UNLOCK TABLES`** / **`GRANT`・`REVOKE`** / **`DISCARD`**（スクリプト互換のため受理） |
| **その他** | プリペアドステートメント（`PREPARE`/`EXECUTE`/`DEALLOCATE`）/ ユーザー変数（`SET @x`）/ `EXPLAIN`・`EXPLAIN ANALYZE` / `VALUES` 文 / `TABLE` 文 / `SHOW *`（**`STORAGE`・`SETTINGS`・`COMMENTS`・`MATERIALIZED VIEWS`** 含む）・`DESCRIBE`・`CHECK TABLE`・`ANALYZE TABLE` |

### 組み込み関数（270 以上）

文字列・数値・日付/時刻・JSON・正規表現・ハッシュ/エンコード・条件/NULL 処理・集計・ウィンドウ・シーケンス・メタ情報の各カテゴリを網羅。`SHOW FUNCTIONS` で一覧・検索できます。

商用 DB でよく使われる関数も実装しています（一部）:

- **Oracle**: `DECODE` / `NVL` / `NVL2` / `ADD_MONTHS` / `MONTHS_BETWEEN` / `NEXT_DAY` / `WIDTH_BUCKET` / `INITCAP` / `LISTAGG` / `TO_NUMBER` / `TO_CHAR` / `TO_DATE` / `NANVL` / `REMAINDER` / `SYS_GUID`
- **SQL Server**: `ISNULL` / `IIF` / `CHOOSE` / `CHARINDEX` / `PATINDEX` / `LEN` / `STUFF` / `QUOTENAME` / `PARSENAME` / `REPLICATE` / `TRY_CAST` / `TRY_CONVERT` / `DATEADD` / `DATEPART` / `DATENAME` / `NEWID` / `EOMONTH`
- **PostgreSQL**: `DATE_PART` / `SPLIT_PART` / `STARTS_WITH` / `ENDS_WITH` / `STRPOS` / `OVERLAY` / `TO_HEX` / `QUOTE_IDENT` / `QUOTE_LITERAL` / `GCD` / `LCM` / `MAKE_DATE` / `CHR`
- **共通/その他**: `SHIFTLEFT` / `SHIFTRIGHT` / `LOG(base, x)` / `USER` / `CURRENT_USER` / `CURRENT_SCHEMA` / `POW` / `BITAND` / `BITOR` / `BITXOR` ほか多数

```sql
-- スカラー関数の例
SELECT TO_CHAR(1234.5, '9,999.99')        AS money,
       DATEADD(MONTH, 1, DATE('2026-01-31')) AS next_eom,
       TRY_CAST('abc' AS INTEGER)          AS safe_cast,   -- 変換不可なら NULL
       NEXT_DAY(DATE('2026-07-23'), 'Monday') AS next_mon;

-- MERGE（UPSERT）の例
MERGE INTO target t USING source s ON (t.id = s.id)
  WHEN MATCHED THEN UPDATE SET val = s.val
  WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val);

-- PostgreSQL 風 UPSERT
INSERT INTO target (id, val) VALUES (1, 100)
  ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val;

-- SQL Server 風 TOP
SELECT TOP 3 * FROM users ORDER BY age DESC;
```

---

## UI ガイド

| 機能 | 説明 |
|------|------|
| **Query Workspace** | シンタックスハイライト・オートコンプリート（`Tab`）・履歴（`Ctrl+↑/↓`）・整形（`Ctrl+Shift+F`）付きの SQL エディタ。 |
| **結果テーブル** | 列ヘッダクリックでソート、CSV / JSON エクスポート、表示行数の切り替え。 |
| **Table Editor** | サイドバーの ⚙ から起動。列の追加・削除・リネーム・型変更・ドラッグ並べ替えに加え、**PRIMARY KEY / NOT NULL / UNIQUE / AUTO_INCREMENT / DEFAULT** をチェックボックスで編集。編集内容は等価な `CREATE TABLE` としてライブプレビュー表示。 |
| **Command Reference** | 「Help」から起動。カテゴリ別のコマンド集を**検索**（コマンド名・SQL 本文の両方に対してインクリメンタル絞り込み＋ハイライト）でき、ワンクリックでエディタへ挿入。 |
| **Console** | 画面**左下**の実行ログパネル。実行したクエリ・**結果件数**（SELECT は取得件数、DML は処理行数）・実行時間・エラー・システムイベントを時系列で記録。**ログ行をクリックすると元クエリをエディタへ再読込**でき、**Copy** ボタンでログ全体をクリップボードへコピーできます。ランチャーボタン、または <kbd>Ctrl</kbd>+<kbd>`</kbd>（バッククォート）で**表示 ON/OFF を任意に切替**（状態は保存されます）。 |
| **Test Data Generator** | 指定テーブルへダミーデータを一括投入。 |
| **CSV Import / SQL Import・Export** | CSV の取り込み、スキーマ+データの SQL ダンプ入出力。 |
| **Save / Load / Clear DB** | IndexedDB への手動保存・読込・初期化。 |

---

## 外部 API

アプリの JavaScript から 3 通りの方法で DB を操作できます。

### 1. `window.LuminaDB`（JS API）

```js
// パラメータバインド（位置・名前付き両対応）
LuminaDB.query('SELECT * FROM users WHERE age > ?', [25]);
LuminaDB.query('SELECT * FROM users WHERE age BETWEEN :min AND @max', { min: 24, max: 31 });

// CRUD ヘルパー
LuminaDB.insert('users', { id: 11, name: 'Ken', age: 20 });   // 配列で複数行も可
LuminaDB.select('users', { columns: ['id', 'name'], where: { age: 25 }, orderBy: 'id DESC', limit: 5 });
LuminaDB.update('users', { age: 26 }, { id: 1 });
LuminaDB.remove('users', { id: 1 });
LuminaDB.upsert('users', { id: 1, name: 'Alice2', age: 26 });
LuminaDB.count('users', { age: 25 }).count;

// スクリプト・トランザクション・その他
LuminaDB.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
LuminaDB.transaction(api => { api.insert('t', {/* ... */}); });  // 例外で自動 ROLLBACK
LuminaDB.status().status.total_rows;
LuminaDB.explain('SELECT * FROM users');
LuminaDB.each('SELECT * FROM users', [], row => console.log(row));
const stmt = LuminaDB.prepare('SELECT * FROM users WHERE id = ?');
```

### 2. `fetch`（`lumina://` インターセプト）

```js
fetch('lumina://query?sql=' + encodeURIComponent('SELECT * FROM users'));
fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }) });
fetch('lumina://tables').then(r => r.json());
```

### 3. `postMessage`

`iframe` などから `postMessage` 経由でクエリを送信し、結果を受け取れます。

---

## 永続化・ブラウザDBとしての運用

サーバ DB には無い「ブラウザ特有の失敗モード」（容量上限・データ退避・タブ間競合・タブを閉じる）に対応しています。

- スナップショットを **IndexedDB** に保存。Web Crypto が使える環境では **AES-GCM で暗号化**して格納します。
- **自動保存**（デバウンス 1 秒）。タブが非表示になる際は保留中の保存を**即時フラッシュ**します。
- **楽観ロック**により、別タブ/ウィンドウが先に保存していた場合は上書きを中止して警告します。
- **マルチタブ同期** — 保存時に `BroadcastChannel` で他タブへ通知し、「別のタブが更新した」ことを即座に知らせます。
- **クォータ超過の明示** — 容量上限に達した保存失敗は原因の分かる日本語メッセージに変換されます。
- **使用量の可視化** — `SHOW STORAGE`（DB 自身の概算サイズ）と `LuminaDB.storage()`（ブラウザの使用量・上限・永続化状態）で確認できます。
- **永続化ストレージの要求** — `LuminaDB.persist()` でディスク逼迫時の自動退避を防ぐ永続化を要求できます。

```js
await LuminaDB.storage();
// { supported: true, usage: 12345678, quota: 9876543210, usagePercent: 0.12,
//   persisted: false, estimatedBytes: 4096, tables: 3, rows: 20 }

await LuminaDB.persist();   // { granted: true | false }
```

```sql
SHOW STORAGE;    -- tables / rows / string_pool_bytes / estimated_bytes / estimated_mb ...
SHOW SETTINGS;   -- セッション設定と実効分離レベル
```

---

## アーキテクチャ / ファイル構成

単一の `LuminaDB.html` が UI とスクリプト読み込みを担い、ロジックは `js/` 以下のモジュールに分割されています。

```
LuminaDB.html            エントリポイント（UI・モーダル・スクリプト読込順）
js/
├── engine/              SQL エンジン（DatabaseEngine を prototype 拡張で分割）
│   ├── engine-core.js       コンストラクタ / 初期データ / クエリディスパッチ / バージョン
│   ├── engine-expression.js 式→JS関数コンパイル・組み込み関数ライブラリ
│   ├── engine-select.js     SELECT 実行計画
│   ├── engine-subquery.js   サブクエリ / CTE / テーブル関数展開
│   ├── engine-dml.js        INSERT / UPDATE / DELETE / トリガー
│   ├── engine-ddl.js        CREATE / ALTER / DROP / プロシージャ / 関数レジストリ
│   ├── engine-transaction.js トランザクション / セーブポイント
│   ├── engine-io.js         SQL ダンプ入出力 / IndexedDB シリアライズ
│   └── table.js             列指向テーブル（TypedArray ストレージ）
├── storage/idb.js       IndexedDB 永続化（AES-GCM 暗号化・楽観ロック）
├── ui/                  画面（state / editor / results / table-tree / schema-editor /
│                        help / modals / data-io / query-runner / console）
├── api/api.js           外部 API（window.LuminaDB / fetch / postMessage）
└── tests/               自己完結テストスイート（test-suite*.js）
```

---

## テスト

2,000 件超の自己完結テストを 2 通りで実行できます。

### 1. 実ブラウザ・ヘッドレステスト（推奨・高信頼）

```bash
bun test/browser-test.mjs
```

ヘッドレス Chrome / Edge で実際の `LuminaDB.html` を開き、Chrome DevTools Protocol 経由で `runTestSuite()` の完了を待って結果を回収します。DOM・IndexedDB・`crypto.subtle`・`postMessage` がすべて本物のため、UI・セキュリティ・暗号化永続化まで本番同様に検証できます（終了コード `0`=全パス / `1`=失敗あり / `2`=起動失敗）。

### 2. ブラウザ UI から手動実行

クエリ欄に `runtest` と入力して実行（または `runTestSuite()` を直接呼び出し）。結果はトーストとコンソールに表示されます。

詳細は [`test/README.md`](test/README.md) を参照してください。

---

## ライセンス

このリポジトリの指定に従います。
