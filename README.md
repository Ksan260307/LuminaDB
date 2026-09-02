# LuminaDB

**日本語** | [English](README.en.md)

ブラウザで開くだけで使える SQL データベースです。インストールもサーバーも要りません。`LuminaDB.html` をブラウザで開くと、SQL を書いて実行する画面がそのまま立ち上がります。

- **準備がいらない** — ダウンロードして開くだけ。アカウント登録も、インストールも、ビルドも不要です。
- **データが外に出ない** — 外部への通信は一切ありません。オフラインでも、外に繋がらない社内の端末でも同じように動きます。
- **本物の SQL** — 結合・集計・ウィンドウ関数・トランザクションまで、実務で書く SQL がそのまま通ります。MySQL / PostgreSQL / Oracle / SQL Server でよく使う書き方にも寄せてあります。
- **書いたものは残る** — 変更はブラウザへ自動保存され、ファイルに書き出して持ち運ぶこともできます。

> 自己完結テスト **53,276 件**が全て通っています。追加・修正の履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

---

## こんなときに

- **SQL を試したい・覚えたい** — 環境構築ゼロで、その場で書いて動かせます。画面の中にカテゴリ別の例文集があり、ワンクリックでエディタに入ります。
- **手元のデータを集計したい** — CSV を放り込めば表になり、SQL で集計できます。データが外に出ないので、持ち出せない情報でもそのまま扱えます。
- **ブラウザだけで動くアプリを作りたい** — アプリの JavaScript から呼び出せます。サーバーを立てずにデータを持てます。

---

## 使ってみる

### 1. 開く

`LuminaDB.html` をブラウザで開きます。これだけで動きます。

保存や暗号化まで含めて本来の動きを確かめるなら、ローカルサーバー経由で開いてください。`file://` で直接開くと、ブラウザ側の制限で保存まわりの一部が使えません。

```bash
python -m http.server 8788
# → http://localhost:8788/LuminaDB.html
```

### 2. 書いて動かす

`users` / `products` / `orders` のサンプル表が最初から入っています。エディタに SQL を書いて **実行**（または `Ctrl+Enter`）を押してください。

```sql
SELECT name, age FROM users WHERE age >= 25 ORDER BY age DESC;
```

表をまたいだ集計もそのまま書けます。

```sql
SELECT u.name, COUNT(*) AS orders, SUM(o.amount) AS total
FROM users u
JOIN orders o ON u.id = o.user_id
GROUP BY u.name
ORDER BY total DESC;
```

書き方が思い出せないときは **Help**（コマンドリファレンス）を開いてください。やりたいこと（「結合」「並べ替え」など日本語でも探せます）で絞り込むと、動く例文が出てきます。

### 3. 自分のデータを入れる

サイドバーの **データ**（`Ctrl+Shift+D`）→ **読み込み** を開き、CSV ファイルをドラッグ&ドロップするか選んで開くと、新しい表として取り込まれます。SQL ダンプの読み込みや、逆に SQL / JSON への書き出しも同じ画面です。

---

## 画面の使い方

| 場所 | できること |
|------|-----------|
| **クエリ入力欄** | 色分け・入力補完（`Tab`）・履歴（`Ctrl+↑/↓`）・整形（`Ctrl+Shift+F`）付きで SQL を書けます。`Ctrl+Enter` で実行。 |
| **結果の表** | 列見出しをクリックして並べ替え、セルを直接編集、CSV / JSON への書き出し。 |
| **左のツリー** | 表と列の一覧。⚙ から表の設計（列の追加・削除・並べ替え・型・主キーなど）を画面上で変更できます。変更内容は実行前に `CREATE TABLE` の形で確認できます。 |
| **Help** | カテゴリ別の例文集。コマンド名でも SQL の中身でも検索でき、ワンクリックでエディタへ入ります。 |
| **コンソール**（左下） | 実行した SQL・件数・所要時間・エラーの記録。行をクリックすると、その SQL をもう一度エディタに呼び戻せます。<kbd>Ctrl</kbd>+<kbd>&#96;</kbd> で開閉。 |
| **データ**（`Ctrl+Shift+D`） | 保存・読み込み・書き出し・初期化・テストデータ生成。操作ごとに「何が起きるか・どこに残るか・戻せるか」を画面上で説明します。 |
| **JP / EN** | 表示言語の切り替え（既定は日本語）。表名やデータの中身は訳しません。 |

---

## データはどこに残るか

書いたデータは**そのブラウザの中だけ**に残ります。どこかのサーバーへ送られることはありません。

- **自動保存** — 変更の 1 秒後にブラウザの保存領域（IndexedDB）へ自動で書き込みます。`Ctrl+S` ですぐ保存することもできます。
- **暗号化** — 保存時に AES-GCM で暗号化します（Web Crypto が使えない古い環境では、暗号化せずに保存します）。
- **ファイルとして持ち運ぶ** — `Ctrl+Shift+S` で `.luminadb` ファイルへ保存。別の端末で開き直せます。**大事なデータはこちらにも残してください**（ブラウザの「サイトデータを削除」を実行すると、ブラウザ側の保存は消えます）。
- **タブを複数開いても壊れない** — 別のタブが先に保存していた場合は上書きを止めて知らせます。保存すると他のタブにも通知が飛びます。
- **容量が足りないとき** — 保存に失敗した理由（容量上限など）を、そのまま読める日本語で表示します。

---

## どんな SQL が書けるか

普段書いている SQL は、だいたいそのまま通ります。

- **問い合わせ** — `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` / `LIMIT`、各種の `JOIN`、`UNION` などの集合演算、サブクエリ、`WITH`（再帰も）
- **集計と分析** — 多数の集計関数、`ROLLUP` / `CUBE` / `GROUPING SETS`、`ROW_NUMBER` / `RANK` / `LAG` / `LEAD` などのウィンドウ関数とフレーム指定
- **更新** — `INSERT` / `UPDATE` / `DELETE`、`MERGE`、`ON CONFLICT`（UPSERT）、`RETURNING`、トランザクションとセーブポイント
- **表の定義** — `CREATE` / `ALTER` / `DROP`、ビュー・索引・トリガー・プロシージャ・シーケンス・ユーザー定義関数、主キーや外部キーなどの制約
- **320 以上の組み込み関数** — 文字列・数値・日付時刻・JSON・正規表現・ハッシュ。`DECODE`（Oracle）、`ISNULL`（SQL Server）、`SPLIT_PART`（PostgreSQL）のような方言もそのまま書けます。`SHOW FUNCTIONS` で一覧できます。

<details>
<summary><b>対応している構文と関数の全一覧（クリックで開く）</b></summary>

| 分類 | 対応内容 |
|------|----------|
| **DQL** | `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY`（序数・式・`NULLS FIRST/LAST`）/ `LIMIT`・`OFFSET`・`FETCH FIRST`（**`WITH TIES`** 対応）/ `TOP n [PERCENT]`（SQL Server）/ `DISTINCT` / **`DISTINCT ON (...)`**（PostgreSQL）/ **`SELECT * EXCLUDE (...)`・`* REPLACE (expr AS col)`** |
| **結合** | `INNER` / `LEFT` / `RIGHT` / **`FULL OUTER`** / `CROSS` / カンマ結合 / `USING` / `NATURAL` / **`CROSS APPLY`・`OUTER APPLY`・`LATERAL`** |
| **集合演算** | `UNION` / `INTERSECT` / `EXCEPT` / **`MINUS`**（Oracle）（いずれも `ALL` 対応） |
| **サブクエリ** | スカラー / `IN` / `EXISTS` / 相関サブクエリ / **量化比較 `= ANY`・`> ALL`・`SOME`** / **派生表の列リスト（`(SELECT ...) AS t(a, b)`）** / **`FROM (VALUES ...) AS t(a, b)`** |
| **CTE** | `WITH` / `WITH RECURSIVE`（列リスト対応） |
| **ウィンドウ関数** | `ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / フレーム指定（**`ROWS` / `RANGE` / `GROUPS`**、**`EXCLUDE CURRENT ROW\|GROUP\|TIES\|NO OTHERS`**）/ named window（`WINDOW` 句）/ `QUALIFY`（**ウィンドウ関数の直書き可**）/ **`IGNORE NULLS`・`RESPECT NULLS`** / **`FILTER (WHERE ...) OVER (...)`** |
| **集計** | 多数の集計関数（**`EVERY`（`BOOL_AND` の別名）・`PRODUCT`（総乗）・`APPROX_COUNT_DISTINCT`（厳密値を返す）** を含む）/ **式に内包した集計（`ROUND(AVG(x), 2)`・`100.0 * SUM(a) / SUM(b)`）** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`・`GROUPING SETS`** / **`GROUP BY ALL`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT`（複数行・`SELECT`・`SET`・`DEFAULT`・**`DEFAULT VALUES`**）/ `UPDATE` / `DELETE`（`ORDER BY`・`LIMIT`）/ `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`・`DO UPDATE`（PostgreSQL・`EXCLUDED`）/ `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED`（Oracle/SQL Server）/ **複数表 `UPDATE ... FROM`・`UPDATE ... JOIN`・`DELETE ... USING`・`DELETE t FROM t JOIN s`** / `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE`（**`CASCADE`・`RESTRICT`**） / `VIEW` / **`MATERIALIZED VIEW`（`REFRESH` 付き）** / `INDEX`（**複合列・`UNIQUE`・名前指定の `DROP INDEX`**）/ `TRIGGER` / `PROCEDURE` / `SEQUENCE` / **`FUNCTION`（ユーザー定義スカラー関数）** / `CREATE TABLE AS`・`LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **制約** | `PRIMARY KEY`（複合可）/ `UNIQUE` / `NOT NULL` / `DEFAULT`（`CURRENT_TIMESTAMP` 含む）/ **`ON UPDATE CURRENT_TIMESTAMP`** / `CHECK` / `FOREIGN KEY`（`ON DELETE/UPDATE` 参照アクション）/ `AUTO_INCREMENT` / **識別列（`GENERATED ALWAYS AS IDENTITY`・`IDENTITY(1,1)`）** / 生成列（`GENERATED ALWAYS AS`） |
| **トランザクション** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **行変換** | **`PIVOT` / `UNPIVOT`**（縦横変換。`UNPIVOT` は NULL 行を除外） |
| **NULL 安全比較** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** / **`IS [NOT] UNKNOWN`** |
| **演算子・述語** | **`\|\|`（文字列連結）** / **`::`（キャスト）** / **`ILIKE`** / **`SIMILAR TO`** / **行コンストラクタ `(a, b) = (c, d)`・`(a, b) IN ((1,2), (3,4))`** / **`COLLATE`（`NOCASE`・`BINARY`・`NOACCENT`・`NUMERIC`）** / **`LIKE ANY`・`LIKE ALL`** / **日付 ± `INTERVAL`** |
| **全文検索** | **`MATCH (col, ...) AGAINST ('語' [IN BOOLEAN\|NATURAL LANGUAGE MODE])`**（`+`必須 / `-`除外 / `"句"` / `語*` 前方一致・スコア取得可） |
| **表関数** | `GENERATE_SERIES`（**数値だけでなく「時刻 + `INTERVAL` 刻み」も生成**）/ `STRING_SPLIT(str, sep)` / `UNNEST(a, b, ...)` / **`JSON_TABLE`（JSON → 行）** / **`WITH ORDINALITY`** |
| **配列** | **`ARRAY[...]` コンストラクタ** / **`ARRAY_LENGTH`・`ARRAY_POSITION`・`ARRAY_CONTAINS`・`ARRAY_APPEND`・`ARRAY_PREPEND`・`ARRAY_REMOVE`・`ARRAY_SORT`・`ARRAY_TO_STRING`・`STRING_TO_ARRAY`・`ARRAY_DISTINCT`・`ARRAY_CAT`・`ARRAY_REVERSE`** / **`= ANY(ARRAY[...])`** |
| **サンプリング** | **`TABLESAMPLE [BERNOULLI\|SYSTEM] (n PERCENT\|n ROWS) [REPEATABLE (seed)]`** |
| **期間・時系列** | **`(s1, e1) OVERLAPS (s2, e2)`** / **`BETWEEN SYMMETRIC`** / **`DATE_BIN`・`TIME_BUCKET`**（時刻の区間丸め）/ **`AGE(a, b)`** / **`EXTRACT(EPOCH\|DOW\|DOY FROM ...)`** / **`AT TIME ZONE`・`CONVERT_TZ`** / **`TIMEDIFF`・`YEARWEEK`・`PERIOD_ADD`・`PERIOD_DIFF`・`JULIAN_DAY`** / **`LOCALTIME`・`LOCALTIMESTAMP`**（MySQL と同じく `NOW()` と同義） |
| **統計集計** | **`REGR_SLOPE`・`REGR_INTERCEPT`・`REGR_R2`・`REGR_COUNT`・`REGR_AVGX`・`REGR_AVGY`・`REGR_SXX`・`REGR_SYY`・`REGR_SXY`**（単回帰）/ **`MODE() WITHIN GROUP (ORDER BY x)`** |
| **あいまい照合** | **`LEVENSHTEIN`（`EDIT_DISTANCE`）** / **`SIMILARITY`（0〜1）** / **`DIFFERENCE`（SOUNDEX 一致度）** / **`REGEXP_MATCHES`・`REGEXP_SPLIT_TO_ARRAY`** |
| **JSON 述語** | **`<expr> IS [NOT] JSON [VALUE\|OBJECT\|ARRAY\|SCALAR]`** / **`JSON_EXISTS`** / **`JSON_QUERY`** |
| **手続き型** | **`DECLARE` / `SET` / `IF`・`ELSEIF`・`ELSE` / `WHILE`・`DO` / `LOOP`・`LEAVE`・`ITERATE` / `REPEAT`・`UNTIL` / `CASE`文 / `RETURN`**（`CREATE PROCEDURE` 本体。引数付き `CALL p(1, 2)` 可） |
| **カーソル** | **`DECLARE <名> CURSOR FOR` / `OPEN` / `FETCH ... INTO` / `CLOSE`**（複数列 `FETCH` 可） |
| **例外処理** | **`DECLARE {CONTINUE\|EXIT} HANDLER FOR {NOT FOUND\|SQLEXCEPTION\|SQLSTATE 'xxxxx'}`** / **`SIGNAL`・`RESIGNAL`**（`SET MESSAGE_TEXT`） |
| **カタログ** | **`INFORMATION_SCHEMA.TABLES / COLUMNS / VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE / ROUTINES / SEQUENCES / SCHEMATA`** / **`PRAGMA table_info`・`table_list`・`index_list`・`foreign_key_list`・`user_version`** / **`sqlite_master`** |
| **互換構文** | **スキーマ修飾 `main.t`・`public.t`** / **`CREATE`・`DROP SCHEMA`・`CREATE`・`DROP DATABASE`・`USE`** / **部分インデックス `CREATE INDEX ... WHERE`** / **`CREATE INDEX ... USING BTREE\|HASH`**（受理のみ）/ **`CREATE UNLOGGED TABLE`**（受理のみ）/ **`SELECT ... FOR UPDATE\|SHARE [NOWAIT\|SKIP LOCKED]`** / **`WITH ... AS [NOT] MATERIALIZED`** / **`EXPLAIN QUERY PLAN`・`EXPLAIN VERBOSE`** / **`REINDEX`・`CHECKPOINT`・`FLUSH`・`CLUSTER`・`REPAIR TABLE`**（受理のみ）/ **`CHECKSUM TABLE`**（実際に算出）/ **`SHOW CREATE FUNCTION`・`SHOW CREATE INDEX`・`SHOW ENGINES`・`SHOW COLUMNS ... LIKE`** / **`DESCRIBE <表> <列>`** / **`PRAGMA foreign_keys`** / **`SET @@var`・`RESET ALL`** / **`DO <式>`** / **`EXECUTE IMMEDIATE '<sql>' [USING ...]`** / **`ALTER VIEW`・`CREATE TEMPORARY VIEW`** / **`REFRESH MATERIALIZED VIEW CONCURRENTLY`** / **`ORDER BY x USING <\|>`** |
| **セッション文** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`・`UNLOCK TABLES`** / **`GRANT`・`REVOKE`** / **`DISCARD`**（スクリプト互換のため受理）/ **`SET statement_timeout`・`read_only`・`seed`・`slow_query_threshold`** / **システム変数 `@@version`・`@@identity`** |
| **スナップショット** | **`CREATE / RESTORE / DROP SNAPSHOT`**・**`SHOW SNAPSHOTS`**（メモリ内タイムトラベル） |
| **その他** | プリペアドステートメント（`PREPARE`/`EXECUTE`/`DEALLOCATE`）/ ユーザー変数（`SET @x`・**`DECLARE @x`**）/ `EXPLAIN`（**`(FORMAT JSON)`**）・`EXPLAIN ANALYZE` / `VALUES` 文 / `TABLE` 文 / `SHOW *`（**`STORAGE`・`SETTINGS`・`COMMENTS`・`MATERIALIZED VIEWS`・`SNAPSHOTS`・`PROFILE`・`SLOW QUERIES`** 含む）・`DESCRIBE`・`CHECK TABLE`・`ANALYZE TABLE` |

#### 組み込み関数（320 以上）

文字列・数値・日付/時刻・JSON・正規表現・ハッシュ/エンコード・条件/NULL 処理・集計・ウィンドウ・シーケンス・メタ情報の各カテゴリを網羅。`SHOW FUNCTIONS` で一覧・検索できます。

商用 DB でよく使われる関数も実装しています（一部）:

- **Oracle**: `DECODE` / `NVL` / `NVL2` / `ADD_MONTHS` / `MONTHS_BETWEEN` / `NEXT_DAY` / `WIDTH_BUCKET` / `INITCAP` / `LISTAGG` / `TO_NUMBER` / `TO_CHAR` / `TO_DATE` / `NANVL` / `REMAINDER` / `SYS_GUID`
- **SQL Server**: `ISNULL` / `IIF` / `CHOOSE` / `CHARINDEX` / `PATINDEX` / `LEN` / `STUFF` / `QUOTENAME` / `PARSENAME` / `REPLICATE` / `TRY_CAST` / `TRY_CONVERT` / `DATEADD` / `DATEPART` / `DATENAME` / `NEWID` / `EOMONTH`
- **PostgreSQL**: `DATE_PART` / `SPLIT_PART` / `STARTS_WITH` / `ENDS_WITH` / `STRPOS` / `OVERLAY` / `TO_HEX` / `QUOTE_IDENT` / `QUOTE_LITERAL` / `GCD` / `LCM` / `MAKE_DATE` / `CHR` / `BTRIM` / `ENCODE` / `EVERY`
- **MySQL**: `ORD` / `CONTAINS` / `TIMEDIFF` / `YEARWEEK` / `PERIOD_ADD` / `PERIOD_DIFF` / `CONVERT_TZ` / `LOCALTIME` / `LOCALTIMESTAMP` / `JSON_SEARCH` / `JSON_MERGE_PRESERVE`
- **共通/その他**: `SHIFTLEFT` / `SHIFTRIGHT` / `LOG(base, x)` / `USER` / `CURRENT_USER` / `CURRENT_SCHEMA` / `POW` / `BITAND` / `BITOR` / `BITXOR` / `UNISTR` / `JULIAN_DAY` ほか多数

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


</details>

---

## アプリから使う（JavaScript）

自分の Web アプリの中に、サーバーなしのデータ置き場として組み込めます。画面ごと使う場合は `LuminaDB.html` を開き、部品として使う場合は `import` します。

```js
import { createDatabase } from 'luminadb';   // Node / Bun / バンドラ / <script type="module">
```

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


アプリとして運用するための機能も揃えています。UI を止めないワーカー実行、変更のあった表だけ書き直す差分保存、スキーマ・マイグレーション、文単位のタイムアウト、読み取り専用モード、メモリ内スナップショット（時点への巻き戻し）、ライブクエリの購読、実行プロファイルと遅いクエリの記録など。

---

## 品質について

自己完結テストが **53,276 件**あり、全て通っています。「何を確かめるか」で 7 つの層に分けてあります。

| 層 | 件数 | 何を見るか |
|----|------|-----------|
| 土台と全網羅 | 約 16,700 | 実装した機能が一通り動くか |
| 大きなデータでの総当たり | 11,672 | 数千行の表と機械生成の組み合わせでしか出ない欠陥 |
| 書き味 | 11,216 | 書き方（改行・コメント・大小文字・言い換え）を変えても答えが変わらないか |
| 特殊なクエリ構成 | 8,804 | 深い入れ子・0 行・極端な値など、端の条件 |
| セキュリティとパフォーマンス | 1,112 | 攻撃文字列が値のままであること、計算量が想定どおりであること |
| 画面と運用機能 | 93 | DOM・IndexedDB・ワーカーを本物のまま動かした検査 |
| 回帰 | 3,072 | 一度直した欠陥が戻っていないこと |

セキュリティは「攻撃者が制御できる文字列」28 種類を 10 通りの入口へ総当たりで流し込み、**(a) JavaScript として実行されない・(b) SQL の構造が変わらない・(c) 値としてそのまま往復する**の 3 点を毎回検査しています。パフォーマンスは実行環境の速さで基準値を較正してから測るので、速い/遅いマシンによる誤検知なしに `O(n) → O(n²)` のような劣化を捕まえられます。

<details>
<summary><b>7 つの層の内訳（クリックで開く）</b></summary>

#### 土台と全網羅（約 16,700 件）

実装した機能を一通り確かめる層。ここが緑なら「機能がある」ことは言える。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite*.js`（v1〜v16） | 約 5,300 | SQL 構文・関数・UI・永続化の機能テスト |
| `test-suite-v50.js` | 1,976 | **スカラー式の総当たり**。すべての層の土台になる式評価を、算術・比較・文字列・`CASE`・NULL 伝播・演算子の結合順序・深い入れ子・列への適用で総当たりする |
| `test-suite-v43.js` | 1,448 | **数値 53 種・文字列 60 種の関数を全網羅**。`SHOW FUNCTIONS` が返す実装済み関数を「関数 × 入力バッテリ」で総当たりし、境界値・定義域の外・NULL 伝播・列への適用（全行突き合わせ）・入れ子・句の中での利用・引数個数の誤りを検査する。期待値は JavaScript 側の参照実装から求める |
| `test-suite-v44.js` | 1,514 | **日付時刻 61 種・変換 9 種・正規表現 5 種・符号化とハッシュ 9 種の全網羅**。日付部分の取り出し、`EXTRACT`/`DATEPART`/`DATE_PART`/`DATENAME` の全単位、加減算 8 単位 × 符号、差、切り捨てと組み立て、書式指定子、現在日時 14 関数、うるう年・月末・年跨ぎ、型変換の行列、ハッシュの既知値と往復 |
| `test-suite-v45.js` | 1,451 | **JSON 21 種・集約 33 種・ウィンドウ 11 種・条件と NULL 17 種・メタ 14 種・シーケンス 3 種の全網羅**。集約 × 絞り込み × まとめ方の総当たり、ウィンドウ集計 × 12 フレーム × 3 区画（毎回 80 行すべてを突き合わせ）、JSON パス × 文書の総当たり、条件関数 × 入力の総当たり |
| `test-suite-v46.js` | 560 | **DDL の全網羅**。`CREATE TABLE` の列定義・制約・オプション、データ型 36 種 × 値の格納と読み出し、`ALTER TABLE` の全アクション × 表の状態、索引（作成・改名・削除・有無で結果が変わらないこと）、ビューと実体化ビュー、プロシージャ・関数・トリガ、ドメイン・列挙型・シーケンス、`DROP` の全対象、`TRUNCATE`/`RENAME`/保守コマンド、CTAS と `SELECT INTO` |
| `test-suite-v47.js` | 407 | **DML・トランザクション・手続き型・セッションの全網羅**。`INSERT` の全形式と競合処理、`UPDATE` の代入 × 絞り込みの総当たり、`DELETE` の全形式、`MERGE` の分岐、`RETURNING`、トランザクション × 操作種別 × 結末、セーブポイント、プリペアドステートメント、変数とセッション設定、スナップショット、プロシージャの手続き型構文、`VALUES`/`TABLE` 文、制約違反が変更を残さないこと |
| `test-suite-v48.js` | 1,522 | **SELECT の句・演算子・述語とメタ照会の全網羅**。演算子の総当たり、述語（`IN`/`BETWEEN`/`LIKE`/`EXISTS`/`ANY`/`ALL`/`IS`）の総当たり、`WHERE` × `ORDER BY` × `LIMIT`/`OFFSET` の行列、結合種別、`GROUP BY`/`HAVING`、集合演算、サブクエリの置ける位置、`SHOW`/`DESCRIBE`/`EXPLAIN`/`PRAGMA`/`INFORMATION_SCHEMA` の全変種、表関数・配列・`PIVOT`・全文検索 |
| `test-suite-v62.js` | 2,503 | **追加した命令・関数の総点検**。文（`CREATE`/`DROP DATABASE`・`USE`・`ALTER VIEW`・`CREATE TEMPORARY VIEW`・`EXECUTE IMMEDIATE`・`DO`・`RESET`・`CHECKSUM`/`REPAIR TABLE`・`PRAGMA foreign_keys`・`SHOW ENGINES`/`CREATE INDEX`/`COLUMNS ... LIKE`・`DESCRIBE <表> <列>`・`EXPLAIN VERBOSE`・`ORDER BY ... USING`）、集計（`EVERY`・`PRODUCT`・`APPROX_COUNT_DISTINCT`）、スカラー関数 18 種を、JavaScript 側の参照実装や既存の同義関数との突き合わせで確かめる。時間帯の全 256 ペア、期間演算 220 通り、文字列 × 部分文字列 144 通りなどの総当たりに加え、書き方（大小・改行・タブ・コメント）と空白位置の総当たり、拒否されるべき綴りも含む |

#### 大きなデータでの総当たり（11,672 件）

小さな例では出ない欠陥（結合順序・フレーム・索引の効き方）を、数千行の表と機械生成の組み合わせで探す層。期待値は SQL ではなく JavaScript 側に組んだ模型から作る。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v34.js` | 1,717 | **大型クエリの網羅検証**。5,000 行の fact 表・1,000 行の mid 表・81 列の wide 表などを組み立て、多段 JOIN（4 表・結合順序の入れ替え・`USING`/`NATURAL`/`APPLY`/`LATERAL`・準結合/反結合）、大規模集計（`ROLLUP`/`CUBE`/`GROUPING SETS`・`FILTER`・`DISTINCT` 集計・統計集計・`WITHIN GROUP`）、ウィンドウ関数（順位・フレーム・`EXCLUDE`・`LAG`/`LEAD`・`QUALIFY`・名前付き窓）、深い CTE と再帰、長い集合演算、巨大な `IN`/`CASE`/列リスト、大量行の DML とトランザクション、ページング、表関数・`PIVOT`・JSON・配列、索引の有無で結果が変わらないこと、総合シナリオを検査する。期待値は SQL ではなく **JavaScript 側に同じ規則で組んだ模型**の集計から作る（差分テスト） |
| `test-suite-v36.js` | 1,747 | **多段 JOIN の総当たり**。列 × 演算子 × 定数で機械的に組んだ述語を 4 表結合へ流し、結合種別 × `ON` 条件、結合順序の入れ替え、自己結合・非等価結合、準結合/反結合、`USING`/`NATURAL`、`APPLY`/`LATERAL`、外部結合の連鎖、索引の有無による不変性を検査する |
| `test-suite-v37.js` | 1,623 | **大規模な集計の総当たり**。2,500 行に対し「まとめ方 18 通り × 集計関数 14 種」の結果セットを丸ごと突き合わせ、`HAVING`・`ROLLUP`/`CUBE`/`GROUPING SETS`・`FILTER`・`DISTINCT`・統計集計・`WITHIN GROUP`・絞り込み × 集計の総当たりを検査する |
| `test-suite-v38.js` | 1,323 | **ウィンドウ関数の総当たり**。800 行に対し順位付け関数 × 区画 × 並び、24 種のフレーム × 8 集計 × 5 区画、`EXCLUDE`、`LAG`/`LEAD` の位置と既定値、`RANGE`/`GROUPS`、`QUALIFY`、名前付き窓、式に埋めた窓、`GROUP BY` 結果への窓、移動平均の検算を、800 行ぶんの値ごと突き合わせる |
| `test-suite-v39.js` | 1,649 | **CTE・サブクエリ・集合演算の総当たり**。派生表 40 段の入れ子、CTE 40 本、再帰 499 段、相関・スカラーサブクエリ、`UNION` 60 連結、`INTERSECT`/`EXCEPT`、括弧付き集合演算、`VALUES`、および「同じ絞り込みを 8 通りに書いて答えが一致すること」を検査する |
| `test-suite-v40.js` | 1,950 | **式・関数・並べ替え・ページングの総当たり**。数値/文字列/条件/型変換の各関数を入力を変えて確かめ、`LIKE`・正規表現、20 通りの並べ替え、ページングの全面走査、`DISTINCT`、巨大な `IN`/`CASE`/連結、述語 × 並べ替え × ページングの組合せを検査する |
| `test-suite-v41.js` | 1,663 | **大量行の DML・表関数・索引・総合シナリオ**。`UPDATE` 代入 × 絞り込みの総当たり、`DELETE`、`INSERT`/`MERGE`/upsert、複数表 DML、制約、`RETURNING`、トランザクションとセーブポイント、表関数・JSON・配列・`PIVOT`、索引の有無による不変性、`EXPLAIN`・メタデータ、レポート系の総合クエリ |

#### 書き味 — 同じ意味を違う書き方で（11,216 件）

「書き方を変えたら答えが変わる」欠陥を探す層。整形・大小文字・コメント・言い換えを機械的に掛け、基準クエリと 1 文字も違わないことを見る。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v51.js` | 4,122 | **字句とレイアウトの書き味**。実装済みのクエリ 60 本に対し、大文字小文字・空白・タブ・CRLF・前後の余白・末尾のセミコロン・行コメント・ブロックコメントを機械的に掛け、さらに**空白 1 個ずつを改行／コメントへ差し替える総当たり**（1 クエリあたり全空白位置）で、結果が 1 文字も変わらないことを確かめる。識別子・別名・修飾の書き分けと、受け付けない書き方（`"…"` は文字列・`[…]` 不可・`#` はコメントでない）も記録する |
| `test-suite-v52.js` | 783 | **同じ意味の別の書き方**。述語（`=` / `<>` / `<` / `BETWEEN` / `IN` / `IS NULL`）の言い換え、論理演算（交換法則・ド・モルガン・分配法則・二重否定）、結合（`JOIN` / カンマ / `CROSS`+`WHERE` / 副問い合わせ / 左右の入れ替え / 半結合・反結合）、集約、副問い合わせと CTE、並べ替えとページング、式と関数の同義形、集合演算を、NULL を含む表に対して突き合わせる |
| `test-suite-v53.js` | 1,329 | **句の組み合わせ**。`DISTINCT` × 結合 × `WHERE` × `GROUP BY` × `HAVING` × `ORDER BY` × `LIMIT` / `OFFSET` の 144 通りを、1 行・整形・コメント入り・大小文字・タブ・派生表・CTE・序数で書き分けて突き合わせる。結合の並べ替え、ウィンドウ句の書き分け、`ROLLUP` / `GROUPING SETS`、集合演算の括り方も同様に検査する |
| `test-suite-v54.js` | 1,307 | **関数呼び出しと式の書き味**。組み込み関数 135 本 × 9 通りの書き方（名前と括弧の間の空白・カンマ前後の空白・引数ごとの改行・引数間のコメント・大小文字・タブ）、引数の書き方、演算子の優先順位、`CASE` の書き分け、型変換の綴り、日付式・JSON の取り出し方、文字列関数の別綴り |
| `test-suite-v55.js` | 1,146 | **DML・DDL・トランザクションの書き味**。`INSERT` / `UPDATE` / `DELETE` の基準文 33 本に字句変換 10 通りと空白位置ごとの改行・コメントを掛け、実行後の表の中身を突き合わせる。DDL は列定義・制約・型の別名・`ALTER` の綴り違いをスキーマで比較し、トランザクション文（`BEGIN` / `START TRANSACTION` / `COMMIT WORK` …）は 60 通りの組み合わせで確かめる |
| `test-suite-v56.js` | 2,529 | **実務の整形スタイルと総合シナリオ**。受注・顧客・明細に対する実務的なクエリ 40 本へ、整形ツール風の体裁（先頭カンマ・句ごとの改行・全体インデント）と空白位置ごとの改行・コメントを掛ける。メタ照会（`SHOW` / `DESCRIBE` / `EXPLAIN` / `INFORMATION_SCHEMA`）の書き味と、同じ集計を 7 通りに組み立てて一致することも見る |

#### 特殊なクエリ構成（8,804 件）

普通は書かないが書ける形。深さ・幅・縮退したデータ・端の値・実行条件の違いを総当たりする層。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v57.js` | 856 | **深さと幅**。派生表・CTE 連鎖・関数・括弧・CASE・副問い合わせを 1 段ずつ 80 段まで重ね、SELECT 項目・IN リスト・演算項・`WHEN`・`ORDER BY` キー・結合表数を 1 個ずつ 320 個まで広げて、素直に書いた同じ意味のクエリと突き合わせる。深い構造 × 外側の句（WHERE / GROUP BY / ウィンドウ / 集合演算）、整形して書いた形、受け付けない限界（再帰の反復上限など）も併せて検査する |
| `test-suite-v58.js` | 2,905 | **縮退したデータと境界**。0 行・1 行・全 NULL・全部同じ値・重複だらけ・全部負・2 値だけ・1 行だけ値あり、の 11 通りの表に対し、集約 22 種・まとめ方・`LIMIT` × `OFFSET` の 15 × 15 格子・常に真/偽を含む述語 42 種・並べ替え・結合・集合演算・ウィンドウ 18 種・0 行に当たる書き換えを掛け、**期待値は JavaScript 側の模型**から求めて突き合わせる |
| `test-suite-v59.js` | 1,126 | **句とスコープの相互作用**。副問い合わせを置ける 17 か所 × 7 つの形、名前の衝突（列別名・表別名・CTE 名・派生表名が実表と同じ）、句の同時使用（グループ列 × 集約 × 絞り込みを 5 通りの組み立て方で）、相関の位置、集合演算と句、結合条件の特殊形（定数・NULL 安全比較・OR・不等号・副問い合わせ）、ウィンドウと `GROUP BY`・`QUALIFY` の相互作用 |
| `test-suite-v60.js` | 2,749 | **極端な値と型**。桁あふれ・極小・負のゼロ・整数の上限といった 21 種の数値 × 演算子・比較・数値関数 21 種、空文字・長大文字列・サロゲートペア・制御文字・引用符を含む 20 種の文字列 × 文字列関数、1900〜2999 年の 22 日付 × 日付関数、型の混在、極端な値を列に入れた読み書き、JSON の特殊な形、丸めと精度 |
| `test-suite-v61.js` | 1,168 | **実行条件の不変性**。同じ 56 本のクエリを、索引の有無 6 通り・行の挿入順序 4 通り・トランザクションの内外とロールバック後・ビュー / 一時表 / CTE 経由・式キャッシュが温まった状態で実行し、答えが 1 文字も変わらないことを確かめる。自己参照 `UPDATE`・`FROM` 併用・UPSERT の連鎖といった書き換えの特殊構成も検査する |

#### セキュリティとパフォーマンス（1,112 件）

正しさとは別の軸。攻撃文字列がどの入口からも値のままであること、計算量が想定どおりであること。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v18.js` | 679 | **セキュリティ**（インジェクション / 識別子検証 / JS 脱出 / プロトタイプ汚染 / DoS ガード / 読み取り専用の強制 / API 境界 / 出力エスケープ） |
| `test-suite-v19.js` | 433 | **パフォーマンス**（較正付きの時間予算・計算量スケーリング・絶対値の安全網） |

セキュリティテストは「攻撃者が制御できる文字列」を 28 種類用意し、10 通りの入口（`?` バインド / 名前付きバインド / `insert` / `update` / `select` / `remove` / `prepare` / SQL プリペアド / `WHERE` / `LIKE`）へ総当たりで流し込み、**(a) JS として実行されない・(b) SQL の構造が変わらない・(c) 値としてそのまま往復する** の 3 点を毎回検査します。

パフォーマンステストは、まず 20,000 行のスキャン 1 回を実測して基準値に較正し、以降の予算をその倍数で表します。実行環境の速さによる偽陽性を避けつつ、`O(n) → O(n^2)` のような劣化を確実に検出できます。較正が一緒に緩むケースに備えて、絶対値の上限（例: 20,000 行スキャンが 300ms 未満）も併せて固定しています。

#### 画面（UI）と運用機能（93 件）

DOM・IndexedDB・ワーカー・クリップボードを本物のまま動かす層。画面まわりの検査は下の回帰の各スイートにも含まれるが、ここは「作り直した画面そのもの」を見る。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v63.js` | 59 | **データ画面の再編**。サイドバーから移した 6 つの操作が本当にモーダルから届くか、**6 つ全部に見出しと説明が付いているか**、破壊的な操作が赤で「戻せません」と書いてあるか、タブとペインが 1 対 1 か、保存状態の表示が実際のデータ量に追随するか、`Ctrl+S` がブラウザ既定の動作を止めるか、元からある 3 タブが壊れていないかを見る |
| `test-suite-v64.js` | 34 | **日本語 / 英語切り替え**。既定が日本語であること、選択が `localStorage` と `<html lang>` に反映されること、**英語表示で日本語が残っていないこと**（通常画面・全モーダル・データ画面の 5 タブ・コマンドリファレンスを機械的に走査）、日本語→英語→日本語で原文へ戻ること、5 往復しても崩れないこと、`i18nT` の引数差し込みと未登録語のフォールバック、辞書の `{0}` の個数が原文と訳で一致すること、表名・結果セル・エンジンのエラーが訳されないことを見る |

#### 回帰 — 追加した機能と、見つかった欠陥（3,072 件）

一度直したものが戻らないための層。機能を足すたび、総当たりで欠陥が出るたびに積み上がる。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite-v17.js` | 247 | 追加した構文と運用機能の回帰 |
| `test-suite-v20.js` | 275 | 構文とブラウザDB必須機能。新しい入口（プロシージャのローカル変数・`JSON_TABLE` のパス・`MATCH` の検索語・バックアップの取り込み・ワーカーのメッセージ）に対するセキュリティ検査と性能予算を含む |
| `test-suite-v21.js` | 185 | 手続き型（カーソル・ハンドラ・`SIGNAL`・`CASE` 文）、期間/JSON/時系列の述語、差分永続化・ストリーミング読み出し。カーソルが返す値と `SIGNAL` の本文に対するセキュリティ検査を含む |
| `test-suite-v22.js` | 180 | 配列・回帰集計・あいまい照合・時系列生成・ウィンドウ拡張、式キャッシュ・CSV 取り込み・リーダー選出。CSV のフィールド/ヘッダーと配列要素に対するセキュリティ検査を含む |
| `test-suite-v23.js` | 203 | 桁指定付き `CAST`/`CONVERT`、更新可能ビューと `WITH CHECK OPTION`、`INSTEAD OF` トリガー、列レベル `REFERENCES`、JSON アクセス演算子、`IS [NOT] TRUE/FALSE`、名前付き制約、DML の別名、行コンストラクタ `IN (SELECT)`、索引の並び順/式キー、メタデータビュー、`UNNEST`。UI（結果絞り込み・セル詳細・ツリー展開・トランザクションバー・カーソル位置の文の実行）も含む |
| `test-suite-v24.js` | 124 | 複合列 `FOREIGN KEY`、シーケンスのオプションと `ALTER SEQUENCE`、`DEFAULT` 式、`MERGE` の条件付き `WHEN` と `NOT MATCHED BY SOURCE`、`VALUES(col)` / `ON CONFLICT ... WHERE`、ビューの列リスト、`ALTER INDEX RENAME` / `SHOW TABLE STATUS` / `WITH [NO] DATA`、集計入れ子の診断。UI（結果グリッドの直接編集・コピー書式・ショートカット）も含み、セル編集の値がバインドされること（SQL 組み立てでないこと）を検査する |
| `test-suite-v25.js` | 110 | 連結系集計の引数内 `ORDER BY`、`ORDER BY` のウィンドウ関数、`UPDATE`/`DELETE` の派生表ソース、SELECT 句の集合返し関数、`DIV` 演算子、`CREATE DOMAIN`/`TYPE AS ENUM`、ユーザー・ロール、`TRUNCATE CONTINUE IDENTITY`、再帰CTE の `SEARCH`/`CYCLE`、`IN` のインデックス活用、定数列の命名。UI（行追加・削除、クエリ履歴パネル）も含み、行削除のキー値がバインドされることを検査する |
| `test-suite-v26.js` | 115 | GROUP BY 結果へのウィンドウ関数、列レベル `COLLATE` の実効化（比較・`IN`・`BETWEEN`・`ORDER BY`・`GROUP BY`・`DISTINCT`・`UNIQUE`・索引経路の回避）、`ORDER BY ALL` / `GROUPING_ID`、`ALTER COLUMN ... SET DATA TYPE` / `TYPE ... USING`、`RENAME CONSTRAINT`、`INSERT ... OVERRIDING VALUE`、`JOIN LATERAL ... ON TRUE`、1 始まりの添字とスライス、文単位の警告と `SHOW WARNINGS`。UI（エディタタブ、警告のコンソール出力）も含む |
| `test-suite-v27.js` | 123 | 日付演算（日付 ± 数値 / 日付 − 日付）、Oracle の階層問い合わせ（`CONNECT BY` / `LEVEL` / `SYS_CONNECT_BY_PATH` / `CONNECT_BY_ROOT` / `NOCYCLE`）と `ROWNUM`、分析関数（`RATIO_TO_REPORT` / `PERCENTILE_* OVER` / `NTH_VALUE ... FROM LAST` / `KEEP (DENSE_RANK ...)`）、`TRUNCATE` の複数表指定、`CREATE INDEX` の `INCLUDE`/`CONCURRENTLY`、`ADD COLUMN` の生成列、`SET CONSTRAINTS`、upsert の `RETURNING`、PostgreSQL の照合演算子。UI（列プロファイル・ER 図）も含む |
| `test-suite-v28.js` | 162 | 別名（`AS` 省略・引用符付き）、修飾スター、出力列名の重複解決、`LTRIM`/`RTRIM` の文字集合、`SUBSTRING` の負の開始位置、`LPAD`/`RPAD` の切り詰め、`HEX`/`UNHEX` の UTF-8 化、`TO_TIMESTAMP` のエポック秒、`AGE` の符号、`REGEXP_*` の position/occurrence/match_type、`SHA2`/`SHA256`/`SHA224`、列の改名・削除に伴うメタデータ追随（生成列・CHECK・列順・索引名）、複合 `UNIQUE INDEX`、`INSERT` の未知列拒否、`INSERT OR <action>`、`ALTER TABLE` の複数アクション、括弧付き集合演算、エラーメッセージ。UI（スキーマ検索・スプリッタ・Explain・行選択・書き出し）も含む |
| `test-suite-v29.js` | 82 | NULL 3 値論理（比較・`NOT`・`IN`/`NOT IN`・`CHECK`・`LIKE` 系）、`IS [NOT] NULL`/`UNKNOWN` が述語のままであること、外部結合 `SELECT *` の NULL 埋め、`ALTER TABLE` の桁付き型と方言別名、`__` で始まる表名の拒否、`transaction()` の async 拒否、`insert()` の列は全行の和集合。UI（Data モーダルへの集約、SQL インポートの失敗レポート、RFC4180 CSV・新規表作成・置換・ドラッグ&ドロップ）も含む |
| `test-suite-v30.js` | 68 | 算術 NULL 伝播（`+ - *` と単項マイナス・演算子優先順位・指数表記）と 0 除算、`DATE` と `DATETIME`/`TIMESTAMP` の分離（`CAST` / 型付きリテラル / `::` / 日次 `GROUP BY` / 表記違いの比較）、ウィンドウ関数の既定フレーム（`RANGE ... CURRENT ROW`・明示 `ROWS` との差・`PARTITION BY`・GROUP BY 結果への窓）、`ON DELETE SET DEFAULT`、`COMMENT ON` の `ROLLBACK`、UI（実行時間の上限） |
| `test-suite-v31.js` | 41 | バッククォート区切り識別子（予約語の列名・表名／不正な名前と未終端の明示エラー／文字列リテラル内は不変／例外ではなくエラー結果を返すこと）、`GROUPING SETS` 内の `ROLLUP`/`CUBE`/入れ子、`exportSQL` のトリガー・関数・プロシージャ・コメント出力と索引名・往復再生、UI（表の右クリックメニュー） |
| `test-suite-v35.js` | 106 | 大型クエリ検証で見つかった取りこぼしの回帰。`LAG`/`LEAD` の既定値、`GROUP_CONCAT(x, 'sep')` と集計の引数個数、`DATE(x)` の算術、別名を付けた列の `ORDER BY` / `OVER(ORDER BY)`、式の一部に書いたウィンドウ関数と `FILTER`、CTE 付き `CREATE TABLE AS`、`GROUPING SETS (())`、`IS JSON` の左辺、`APPLY` の連続・入れ子・派生表、括弧付き集合演算の派生表 |
| `test-suite-v42.js` | 44 | 総当たりテストで見つかった欠陥の回帰。`APPLY` 本体の文字列リテラル消失、別名が結合先と同名でも曖昧としないこと、`GROUP BY` 結果への `ROWS` フレーム、0 件の派生表・CTE でも列が残ること |
| `test-suite-v49.js` | 1,007 | 全網羅テストで見つかった欠陥の回帰と、句をまたぐ組み合わせ。三値論理の真理値表、同じ関数を 8 か所の句で使う、結合 × 述語 × 並べ替え、集約とウィンドウの組み合わせ、`BETWEEN`/`IN` の左辺 × 値の総当たり、`OVER` 句の入れ子 |


</details>

### テストの走らせ方

#### 1. 実ブラウザ・ヘッドレステスト（推奨・高信頼）

```bash
bun test/browser-test.mjs
```

ヘッドレス Chrome / Edge で実際の `LuminaDB.html` を開き、Chrome DevTools Protocol 経由で `runTestSuite()` の完了を待って結果を回収します。DOM・IndexedDB・`crypto.subtle`・`postMessage` がすべて本物のため、UI・セキュリティ・暗号化永続化まで本番同様に検証できます（終了コード `0`=全パス / `1`=失敗あり / `2`=起動失敗）。

#### 2. スイート単体ランナー（開発中の素早い確認）

```bash
bun test/run-suite.mjs v51
```

エンジンだけを読み込んで、SQL で完結するスイートを 1 本（`all` で全部）回します。1 秒前後で終わるので、
エンジンを触ったらまずこれで潰し、最後に経路 1 で確認する、という二段構えで使います。

#### 3. ブラウザ UI から手動実行

クエリ欄に `runtest` と入力して実行（または `runTestSuite()` を直接呼び出し）。結果はトーストとコンソールに表示されます。

実行方法とスイートの書き方（共通ヘルパ `makeTestKit`）の詳細は [`test/README.md`](test/README.md) を参照してください。

---

## 仕組み

データは行ではなく**列ごと**に持っています（`Float64Array` などの型付き配列に詰める列指向ストレージ）。同じ列の値がメモリ上で連続するため、走査と集計が速く、メモリも小さく収まります。20 万行の走査 + `LIKE` が実測で約 26ms です。

SQL は実行のたびに解釈し直すのではなく、式を JavaScript の関数へコンパイルして使い回します。画面を止めたくない処理はワーカースレッドへ逃がせます。

外部ホストへの参照はゼロです。スタイルシートも生成済みのものを同梱しているので、オフラインでも `file://` でも、外部通信を禁じた環境でも見た目が崩れません。

<details>
<summary><b>ファイル構成（クリックで開く）</b></summary>


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
├── storage/idb.js       IndexedDB 永続化（AES-GCM 暗号化・Web Locks 排他・バックアップ）
├── worker/              ワーカースレッド版エンジン（UI を止めない実行）
├── ui/                  画面（state / editor / results / table-tree / schema-editor /
│                        help / modals / data-io / query-runner / console）
├── api/api.js           外部 API（window.LuminaDB / fetch / postMessage）
└── tests/               自己完結テストスイート（test-suite*.js）
```


</details>

---

## よくある質問

**インターネットに繋がっていないと使えませんか。**
いいえ。むしろ通信は一切しません。最初にファイルを入手した後は、オフラインでも同じように動きます。

**入力したデータはどこかに送られますか。**
送られません。データはブラウザの中だけに保存され、外部ホストへの参照も持ちません。

**どのくらいの量のデータを扱えますか。**
すべてメモリ上で処理するので、目安は数万〜数十万行です（20 万行の走査で約 26ms）。それ以上になるとブラウザのメモリが上限になります。

**どのブラウザで動きますか。**
Chrome / Edge / Firefox / Safari の最近の版で動きます。テストは毎回ヘッドレスの Chrome / Edge で流しています。

**データが消えることはありますか。**
ブラウザの「サイトデータを削除」を実行すると、ブラウザ側に保存した内容は消えます。大事なデータは `Ctrl+Shift+S` でファイルにも保存してください。

**既存の MySQL や PostgreSQL に接続できますか。**
できません。LuminaDB は単体で完結するデータベースです。ただし SQL ダンプや CSV の読み込み・書き出しでデータを行き来させることはできます。

**エラーメッセージが英語で出ます。**
SQL エンジンが返すエラーは、表示言語の設定にかかわらず英語です（他のデータベースのメッセージと見比べられるようにしています）。画面の文言は日本語・英語を切り替えられます。

---

## ライセンス

**未定です。** ライセンスファイルを置いていないため、既定では著作権法上のすべての権利が
留保された状態にあたります。再配布・改変・組み込みを許す場合は、意図する条件の
`LICENSE` を追加してください（`package.json` は `"private": true` にしてあり、
ライセンスを決めるまで誤って公開できないようにしています）。
