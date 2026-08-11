# LuminaDB

**日本語** | [English](README.en.md)

ブラウザだけで完結する、ビルド不要の in-memory SQL データベースエンジンです。単一の HTML ファイルを開くだけで、本格的な SQL（DQL / DML / DDL）・トランザクション・ウィンドウ関数・トリガー・ビュー・`MERGE` / `TOP` / `ON CONFLICT` などの商用 DB コマンド・270 以上の組み込み関数を、サーバーなしで実行できます。

> バージョン: **v1.27.0** / 自己完結テスト **8,326 件**（全パス。うちセキュリティ 780 件超 / パフォーマンス 490 件超）

---

## 特徴

- **依存ゼロ・ビルド不要** — `LuminaDB.html` を開くだけ。バンドラもパッケージマネージャも不要（スタイルのみ Tailwind CDN を利用）。
- **列指向ストレージ** — `Float64Array` + `Uint32Array` による 32bit パッキングでメモリ効率とキャッシュ局所性を確保。20 万行スキャン + LIKE が実測 ~26ms。
- **本格的な SQL エンジン** — 後述のとおり主要な SQL 構文をほぼ網羅。
- **商用 DB 互換関数** — MySQL / PostgreSQL / Oracle / SQL Server で頻用される関数を幅広く実装。
- **永続化** — IndexedDB へ **AES-GCM 暗号化**で保存。タブ間の上書きを防ぐ楽観ロック付き。
- **外部 API** — `window.LuminaDB`（JS API）、`fetch('lumina://...')`、`postMessage` の 3 経路でアプリから利用可能。
- **充実した UI** — シンタックスハイライト付きエディタ、Table Editor、検索付きコマンドリファレンス、実行ログコンソールなど。
- **ブラウザDBの運用機能** — **式コンパイルキャッシュ**、**差分永続化（変更のあった表だけ書く）**、**ワーカー実行（UI を止めない）**、**スキーマ・マイグレーション**、**バックアップ / CSV のファイル入出力**、**バッチ読み出し**、**タブのリーダー選出**、文単位タイムアウト、読み取り専用モード、メモリ内スナップショット（タイムトラベル）、ライブクエリ購読、プロファイル / 遅いクエリログ。

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
| **DQL** | `SELECT` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY`（序数・式・`NULLS FIRST/LAST`）/ `LIMIT`・`OFFSET`・`FETCH FIRST`（**`WITH TIES`** 対応）/ `TOP n [PERCENT]`（SQL Server）/ `DISTINCT` / **`DISTINCT ON (...)`**（PostgreSQL）/ **`SELECT * EXCLUDE (...)`・`* REPLACE (expr AS col)`** |
| **結合** | `INNER` / `LEFT` / `RIGHT` / **`FULL OUTER`** / `CROSS` / カンマ結合 / `USING` / `NATURAL` / **`CROSS APPLY`・`OUTER APPLY`・`LATERAL`** |
| **集合演算** | `UNION` / `INTERSECT` / `EXCEPT` / **`MINUS`**（Oracle）（いずれも `ALL` 対応） |
| **サブクエリ** | スカラー / `IN` / `EXISTS` / 相関サブクエリ / **量化比較 `= ANY`・`> ALL`・`SOME`** / **派生表の列リスト（`(SELECT ...) AS t(a, b)`）** / **`FROM (VALUES ...) AS t(a, b)`** |
| **CTE** | `WITH` / `WITH RECURSIVE`（列リスト対応） |
| **ウィンドウ関数** | `ROW_NUMBER` / `RANK` / `LAG` / `LEAD` / フレーム指定（**`ROWS` / `RANGE` / `GROUPS`**、**`EXCLUDE CURRENT ROW\|GROUP\|TIES\|NO OTHERS`**）/ named window（`WINDOW` 句）/ `QUALIFY`（**ウィンドウ関数の直書き可**）/ **`IGNORE NULLS`・`RESPECT NULLS`** / **`FILTER (WHERE ...) OVER (...)`** |
| **集計** | 多数の集計関数 / **式に内包した集計（`ROUND(AVG(x), 2)`・`100.0 * SUM(a) / SUM(b)`）** / `FILTER (WHERE ...)` / `GROUP BY ... WITH ROLLUP` / **`CUBE`・`GROUPING SETS`** / **`GROUP BY ALL`** / `GROUPING()` / **`WITHIN GROUP (ORDER BY ...)`** / `GROUP_CONCAT` |
| **DML** | `INSERT`（複数行・`SELECT`・`SET`・`DEFAULT`・**`DEFAULT VALUES`**）/ `UPDATE` / `DELETE`（`ORDER BY`・`LIMIT`）/ `REPLACE` / `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` / `ON CONFLICT DO NOTHING`・`DO UPDATE`（PostgreSQL・`EXCLUDED`）/ `MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED`（Oracle/SQL Server）/ **複数表 `UPDATE ... FROM`・`UPDATE ... JOIN`・`DELETE ... USING`・`DELETE t FROM t JOIN s`** / `RETURNING` |
| **DDL** | `CREATE / ALTER / DROP TABLE`（**`CASCADE`・`RESTRICT`**） / `VIEW` / **`MATERIALIZED VIEW`（`REFRESH` 付き）** / `INDEX`（**複合列・`UNIQUE`・名前指定の `DROP INDEX`**）/ `TRIGGER` / `PROCEDURE` / `SEQUENCE` / **`FUNCTION`（ユーザー定義スカラー関数）** / `CREATE TABLE AS`・`LIKE` / **`SELECT ... INTO`** / **`COMMENT ON`** / `TEMPORARY` |
| **制約** | `PRIMARY KEY`（複合可）/ `UNIQUE` / `NOT NULL` / `DEFAULT`（`CURRENT_TIMESTAMP` 含む）/ **`ON UPDATE CURRENT_TIMESTAMP`** / `CHECK` / `FOREIGN KEY`（`ON DELETE/UPDATE` 参照アクション）/ `AUTO_INCREMENT` / **識別列（`GENERATED ALWAYS AS IDENTITY`・`IDENTITY(1,1)`）** / 生成列（`GENERATED ALWAYS AS`） |
| **トランザクション** | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` |
| **行変換** | **`PIVOT` / `UNPIVOT`**（縦横変換。`UNPIVOT` は NULL 行を除外） |
| **NULL 安全比較** | **`IS [NOT] DISTINCT FROM`** / **`<=>`** / **`IS [NOT] UNKNOWN`** |
| **演算子・述語** | **`\|\|`（文字列連結）** / **`::`（キャスト）** / **`ILIKE`** / **`SIMILAR TO`** / **行コンストラクタ `(a, b) = (c, d)`・`(a, b) IN ((1,2), (3,4))`** / **`COLLATE`（`NOCASE`・`BINARY`・`NOACCENT`・`NUMERIC`）** / **`LIKE ANY`・`LIKE ALL`** / **日付 ± `INTERVAL`** |
| **全文検索** | **`MATCH (col, ...) AGAINST ('語' [IN BOOLEAN\|NATURAL LANGUAGE MODE])`**（`+`必須 / `-`除外 / `"句"` / `語*` 前方一致・スコア取得可） |
| **表関数** | `GENERATE_SERIES`（**数値だけでなく「時刻 + `INTERVAL` 刻み」も生成**）/ `STRING_SPLIT(str, sep)` / `UNNEST(a, b, ...)` / **`JSON_TABLE`（JSON → 行）** / **`WITH ORDINALITY`** |
| **配列** | **`ARRAY[...]` コンストラクタ** / **`ARRAY_LENGTH`・`ARRAY_POSITION`・`ARRAY_CONTAINS`・`ARRAY_APPEND`・`ARRAY_PREPEND`・`ARRAY_REMOVE`・`ARRAY_SORT`・`ARRAY_TO_STRING`・`STRING_TO_ARRAY`** / **`= ANY(ARRAY[...])`** |
| **サンプリング** | **`TABLESAMPLE [BERNOULLI\|SYSTEM] (n PERCENT\|n ROWS) [REPEATABLE (seed)]`** |
| **期間・時系列** | **`(s1, e1) OVERLAPS (s2, e2)`** / **`BETWEEN SYMMETRIC`** / **`DATE_BIN`・`TIME_BUCKET`**（時刻の区間丸め）/ **`AGE(a, b)`** / **`EXTRACT(EPOCH\|DOW\|DOY FROM ...)`** / **`AT TIME ZONE`** |
| **統計集計** | **`REGR_SLOPE`・`REGR_INTERCEPT`・`REGR_R2`・`REGR_COUNT`・`REGR_AVGX`・`REGR_AVGY`・`REGR_SXX`・`REGR_SYY`・`REGR_SXY`**（単回帰）/ **`MODE() WITHIN GROUP (ORDER BY x)`** |
| **あいまい照合** | **`LEVENSHTEIN`（`EDIT_DISTANCE`）** / **`SIMILARITY`（0〜1）** / **`DIFFERENCE`（SOUNDEX 一致度）** / **`REGEXP_MATCHES`・`REGEXP_SPLIT_TO_ARRAY`** |
| **JSON 述語** | **`<expr> IS [NOT] JSON [VALUE\|OBJECT\|ARRAY\|SCALAR]`** / **`JSON_EXISTS`** / **`JSON_QUERY`** |
| **手続き型** | **`DECLARE` / `SET` / `IF`・`ELSEIF`・`ELSE` / `WHILE`・`DO` / `LOOP`・`LEAVE`・`ITERATE` / `REPEAT`・`UNTIL` / `CASE`文 / `RETURN`**（`CREATE PROCEDURE` 本体。引数付き `CALL p(1, 2)` 可） |
| **カーソル** | **`DECLARE <名> CURSOR FOR` / `OPEN` / `FETCH ... INTO` / `CLOSE`**（複数列 `FETCH` 可） |
| **例外処理** | **`DECLARE {CONTINUE\|EXIT} HANDLER FOR {NOT FOUND\|SQLEXCEPTION\|SQLSTATE 'xxxxx'}`** / **`SIGNAL`・`RESIGNAL`**（`SET MESSAGE_TEXT`） |
| **カタログ** | **`INFORMATION_SCHEMA.TABLES / COLUMNS / VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE / ROUTINES / SEQUENCES / SCHEMATA`** / **`PRAGMA table_info`・`table_list`・`index_list`・`foreign_key_list`・`user_version`** / **`sqlite_master`** |
| **互換構文** | **スキーマ修飾 `main.t`・`public.t`** / **`CREATE`・`DROP SCHEMA`** / **部分インデックス `CREATE INDEX ... WHERE`** / **`SELECT ... FOR UPDATE\|SHARE [NOWAIT\|SKIP LOCKED]`** / **`WITH ... AS [NOT] MATERIALIZED`** / **`EXPLAIN QUERY PLAN`** / **`REINDEX`・`CHECKPOINT`・`FLUSH`・`CLUSTER`**（受理のみ）/ **`SHOW CREATE FUNCTION`** |
| **セッション文** | **`SET TRANSACTION ISOLATION LEVEL`** / **`LOCK`・`UNLOCK TABLES`** / **`GRANT`・`REVOKE`** / **`DISCARD`**（スクリプト互換のため受理）/ **`SET statement_timeout`・`read_only`・`seed`・`slow_query_threshold`** / **システム変数 `@@version`・`@@identity`** |
| **スナップショット** | **`CREATE / RESTORE / DROP SNAPSHOT`**・**`SHOW SNAPSHOTS`**（メモリ内タイムトラベル） |
| **その他** | プリペアドステートメント（`PREPARE`/`EXECUTE`/`DEALLOCATE`）/ ユーザー変数（`SET @x`・**`DECLARE @x`**）/ `EXPLAIN`（**`(FORMAT JSON)`**）・`EXPLAIN ANALYZE` / `VALUES` 文 / `TABLE` 文 / `SHOW *`（**`STORAGE`・`SETTINGS`・`COMMENTS`・`MATERIALIZED VIEWS`・`SNAPSHOTS`・`PROFILE`・`SLOW QUERIES`** 含む）・`DESCRIBE`・`CHECK TABLE`・`ANALYZE TABLE` |

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

### v1.14 で追加した構文（抜粋）

```sql
-- 連結演算子 / キャスト演算子 / ILIKE / 行コンストラクタ
SELECT name || ' (' || age::TEXT || ')' AS label FROM users WHERE name ILIKE 'a%';
SELECT * FROM users WHERE (id, age) IN ((1, 25), (2, 30));

-- 列を選び直す短縮記法（DuckDB / Snowflake 風）
SELECT * EXCLUDE (age) FROM users;
SELECT * REPLACE (age * 2 AS age) FROM users;
SELECT age, COUNT(*) FROM users GROUP BY ALL;

-- 各グループの先頭 1 行 / 同値を含めた上位 n 件
SELECT DISTINCT ON (user_id) user_id, amount FROM orders ORDER BY user_id, amount DESC;
SELECT * FROM users ORDER BY age DESC FETCH FIRST 3 ROWS WITH TIES;

-- 複数表の UPDATE / DELETE
UPDATE orders o SET amount = amount + 1 FROM users u WHERE o.user_id = u.id AND u.age > 30;
DELETE FROM orders USING users WHERE orders.user_id = users.id AND users.age > 90;

-- ユーザー定義スカラー関数（呼び出し箇所へ式として展開される）
CREATE FUNCTION tax(amount) RETURNS FLOAT AS RETURN ROUND(amount * 1.1, 2);
SELECT price, tax(price) AS with_tax FROM products;

-- カタログ / 表関数 / 派生表
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY FROM information_schema.columns WHERE TABLE_NAME = 'users';
SELECT value FROM STRING_SPLIT('a,b,c', ',');
SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, label);
```

### v1.15 で追加した構文（抜粋）

```sql
-- 日付演算 / 照合順 / 全文検索
SELECT DATE '2026-01-31' + INTERVAL 1 MONTH AS eom, NOW() - INTERVAL '7 days' AS week_ago;
SELECT * FROM users WHERE name COLLATE NOCASE = 'alice' ORDER BY name COLLATE NUMERIC;
SELECT name, MATCH(name) AGAINST('alice bob') AS score
FROM users WHERE MATCH(name) AGAINST('+alice -bob' IN BOOLEAN MODE);

-- 欠測を飛ばして前の値を引く（IGNORE NULLS）
SELECT id, LAG(v) IGNORE NULLS OVER (ORDER BY id) AS carried FROM readings;

-- JSON をそのまま表として扱う（API 応答の取り込みに）
SELECT * FROM JSON_TABLE('[{"id":1,"nm":"a"},{"id":2,"nm":"b"}]', '$[*]'
                         COLUMNS (id INT PATH '$.id', nm TEXT PATH '$.nm')) t;

-- 大きな表の概算集計（REPEATABLE で再現可能）
SELECT AVG(price) FROM products TABLESAMPLE (10 PERCENT) REPEATABLE (42);

-- ストアドプロシージャの制御構造
CREATE PROCEDURE grade(s) AS BEGIN
  DECLARE g TEXT;
  IF s >= 90 THEN SET g = 'A';
  ELSEIF s >= 70 THEN SET g = 'B';
  ELSE SET g = 'C';
  END IF;
  RETURN g;
END;
CALL grade(85);   -- 'B'

-- 更新時刻の自動記録 / イントロスペクション
CREATE TABLE audit (id INTEGER PRIMARY KEY, v INTEGER,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
PRAGMA table_info(audit);
SELECT type, name FROM sqlite_master;
EXPLAIN (FORMAT JSON) SELECT * FROM users;
```

### v1.16 で追加した構文（抜粋）

```sql
-- カーソル + 例外ハンドラ（MySQL ルーチンの定番形）
CREATE PROCEDURE archive() AS BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE uid INT;
  DECLARE c CURSOR FOR SELECT id FROM users WHERE age > 30;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN c;
  read_loop: LOOP
    FETCH c INTO uid;
    IF done = 1 THEN LEAVE read_loop; END IF;
    INSERT INTO archived (id) VALUES (uid);
  END LOOP;
  CLOSE c;
END;

-- 業務エラーを明示的に上げる / 受け止める
CREATE PROCEDURE withdraw(amount) AS BEGIN
  IF amount <= 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'amount must be positive'; END IF;
  RETURN amount;
END;

-- 期間の重なり / 時系列バケット / JSON 述語
SELECT (DATE '2026-01-01', DATE '2026-06-01') OVERLAPS (DATE '2026-03-01', DATE '2026-09-01') AS conflicts;
SELECT TIME_BUCKET(INTERVAL 1 HOUR, ts) AS bucket, SUM(amount) FROM events GROUP BY TIME_BUCKET(INTERVAL 1 HOUR, ts);
SELECT AGE(DATE '2028-03-15', DATE '2026-01-20') AS gap;      -- '2 years 1 mon 24 days'
SELECT * FROM docs WHERE body IS JSON OBJECT AND JSON_EXISTS(body, '$.meta.id');

-- 実 DB 向けスクリプトの互換構文
SELECT * FROM main.users WHERE id = 1 FOR UPDATE;
CREATE INDEX idx_adult ON users (age) WHERE age >= 18;
WITH c AS MATERIALIZED (SELECT id FROM users) SELECT COUNT(*) FROM c;
EXPLAIN QUERY PLAN SELECT * FROM users WHERE id = 1;
```

### v1.27 — 「黙って壊す・黙って誤る」箇所の一斉修正

12 の観点でエンジンと画面を監査し、**再現できた欠陥だけ**を直した回です。共通しているのは
「エラーも警告も出さないまま、データを失うか、もっともらしい誤答を返す」という性質でした。

**データを失う・原子性が壊れる**

| 症状 | 直した内容 |
| --- | --- |
| 失敗した `REPLACE INTO` が **削除だけ**を残した | 削除を伴う `REPLACE` を暗黙セーブポイントで囲み、入れ直しが失敗したら消した行を戻す |
| `TRUNCATE` が外部キーを一切見ず、子行を親の無い状態にできた（同じ `DELETE` は拒否されるのに） | 既定 `RESTRICT` で拒否、`CASCADE` で子表も空にする。自己参照は許可 |
| `ROLLBACK` が `ON UPDATE CURRENT_TIMESTAMP` 列と生成列を戻さず、値が消える／古い値が残って **UNIQUE 違反の状態**になった | `UPDATE` の COW 対象を「その文が書き得る全列」へ拡張 |
| AFTER トリガーの失敗で「文はエラーなのに変更は残る」 | トリガーを持つ表に限り適用区間を暗黙セーブポイントで囲い、失敗時に巻き戻す |
| FK `ON UPDATE CASCADE` の波及値が子表の `CHECK` / `UNIQUE` / `NOT NULL` を通らなかった | 親を書く**前**に子側を検証（`skipFk` で FK だけ除外） |

**問い合わせ・型の誤り**

```sql
EXPLAIN DELETE FROM t WHERE id = 1;   -- 以前: 計画ではなく本体を実行して行が消えた → 明示エラー
SELECT * FROM a JOIN b ON a.id = b.typo_id;  -- 以前: 0 件（LEFT なら右側全 NULL）→ 列名エラー
SELECT CONCAT(f, ' ', l) FROM t;      -- 以前: 列名が CONCAT(f, __STR_0__, l) → 書いたとおりの式
SELECT (SELECT a FROM t) AS s;        -- 以前: 先頭行を黙って採用 → "more than 1 row"
SELECT a FROM t WHERE a NOT IN (SELECT b FROM u);  -- u に NULL があると行を返していた → 空（標準どおり）
SELECT AVG(x) FROM t;                 -- 以前: 常に小数2桁（0.000001 台が 0 に）→ 倍精度のまま
SELECT SUM(flag) FROM t;              -- BOOLEAN / 数値文字列を 0 扱い → 1/0・数値として集計
SELECT DATE('2024-03-15 23:30:00');   -- 以前: ローカル時刻解釈で 9 時間ずれた ISO 文字列 → '2024-03-15'
SELECT HOUR('12:34:56');              -- 以前: NULL（自分が作った TIME 値を読めなかった）→ 12
SELECT COUNT(*) FROM t WHERE ok = 1;  -- BOOLEAN 列で 0 件（`ok > 0` は真）→ 6 つの比較演算子が一致
SELECT CHAR_LENGTH('😀');             -- 以前: 2、SUBSTRING は文字化け → コードポイント単位
SELECT * FROM t WHERE a IN (SELECT a, b FROM t);  -- 余分な列を黙って捨てた → 列数エラー
SELECT * FROM t WHERE;                -- 以前: 条件無しとして全行 → 構文エラー
SELECT * FROM t WHERE SUM(b) > 5;     -- 以前: "Column 'sum' not found." → HAVING を案内
CREATE TABLE t (v INT CHECK (v IN (SELECT id FROM p)));  -- 定義時の結果に凍結された → 定義時に拒否
CREATE TABLE c (y INT REFERENCES p(x));  -- x が一意でないと CASCADE が生きた子を消した → 定義時に拒否
```

**トランザクション文**

```sql
ROLLBACK WORK;         -- 以前: 拒否した上にトランザクションを開いたままにした（最悪の取り違え）
ROLLBACK TRANSACTION;  -- 同上。どちらも受理する
RELEASE SAVEPOINT sp1; -- sp1 より後に作った sp2 も一緒に消える（SQL 標準）
```

**ブラウザ DB として足りなかったもの**

```sql
-- 相互参照する 2 表（社員↔部署）に初回の行を入れる／一括取り込みの逃げ道。
-- 1 に戻すとき全表を検査し直すので、不整合が黙って残ることはない（MySQL より厳しい）
SET FOREIGN_KEY_CHECKS = 0;
INSERT INTO dept VALUES (1, 100);
INSERT INTO emp  VALUES (100, 1);
SET FOREIGN_KEY_CHECKS = 1;
```

- **ディスク上のファイルとして開く / 保存する**（File System Access API）。サイドバーの
  `Open File` / `Save` / `Save As`。IndexedDB はサイトデータを消すと失われ別端末へ持ち出せないので、
  通常のアプリと同じ「開く→編集→上書き保存」ができる導線を追加しました。
  未対応ブラウザ（Firefox / Safari / `file://`）ではダウンロードとファイル選択に自動で落ちます。

**画面**

- **Tailwind CDN が読めないと 9 個のモーダルが全部開いた状態で積まれ、操作不能**だった
  （オフライン・社内プロキシで実測）。`.hidden` を含む最小限のフォールバックを内蔵し、
  読み込み失敗を知らせる帯を出すようにしました。CDN が生きているときの見た目は変わりません。
- 複数文スクリプトが**別の文の結果を「答え」として表示**していた（末尾の SELECT が 0 件だと
  途中の結果に落ちる）。末尾の結果セットを出し、結果セットが複数あるときは**タブで全部見られる**ように。
- `SELECT note AS Result FROM t` のように `Result` という別名の列があるだけで、
  書き出し・コピーの 5 ボタンが理由も出さず無効化されていた（判定を結果の形に統一）。
- 補完が `t.` の後ろで何も出さず、無関係な表の列を混ぜていた。修飾子付きはその表の列だけ、
  修飾子なしは「この文の表の列 → 表名 → キーワード」の順に並べます。
- 編集可セルのダブルクリックで、詳細モーダルが開いた編集欄に被さって入力が失われた。
- セルの**文字列内容**で成功/失敗色を塗っていたため、`record deleted by ops` のようなただのデータが
  緑に、`customer not found in CRM` が赤地になっていた。結果の形で判定するようにし、
  `NULL` / 文字列 `'null'` / 空文字を `[NULL]` / `null` / `[empty]` で区別します。

**後半（v32 で「未着手」としていた項目）**

```sql
-- 修飾なしの曖昧な列名を拒否する（MySQL 1052 / PostgreSQL / SQLite と同じ）。
-- 従来は「最初に見つかった表」を黙って採っていた。SELECT / WHERE / ON / HAVING /
-- QUALIFY / ORDER BY のいずれでも検出する
SELECT SUM(amount) FROM orders o JOIN payments p ON o.id = p.id;
--> Column 'amount' is ambiguous: it exists in orders and payments. Qualify it ...

-- 組み込み関数の引数個数を検査する（従来は黙って NULL / 変な値 / 列そのものが消えた）
SELECT ABS();      --> Incorrect parameter count ... 'ABS': got 0, expected 1
SELECT POWER(2);   --> ... 'POWER': got 1, expected 2
SELECT ABS(POWER(2));  -- 入れ子も個別に検査する
-- EXTRACT(YEAR FROM d) / CAST(x AS INT) / TRIM(BOTH ' ' FROM x) のように
-- キーワードで引数を区切る綴りは対象外（誤って弾かないため）

-- 16 進リテラル。従来はこの綴りを知らず、ソーステキストがそのまま列へ入っていた
SELECT X'48656C6C6F';        --> 'Hello'（MySQL と同じく UNHEX と同義）
SELECT HEX(X'48656C6C6F');   --> '48656C6C6F'（往復する）
SELECT X'4';                 --> Invalid hex literal: odd number of digits

-- ALTER TABLE ADD CHECK の 3 値論理。NULL を含む行を違反と判定していたため、
-- INSERT では通る制約を後から付けられなかった
ALTER TABLE t ADD CONSTRAINT c CHECK (a < 100);   -- a に NULL があっても通る

-- DECIMAL(p,s) / VARCHAR(n) を格納時にも適用する（従来は宣言が単なる飾りだった）
CREATE TABLE m (price DECIMAL(10,2), code VARCHAR(3));
INSERT INTO m VALUES (123.4567, 'abc');   --> price は 123.46（CAST と同じ丸め）
INSERT INTO m VALUES (1, 'abcdefgh');     --> Data too long for column 'code'
```

- **EXPLAIN の充実**: 各段に行数の見積り列 `Rows` が付き、`DISTINCT` / `WINDOW` /
  `AGGREGATE` の段が出るようになりました。派生表・CTE は内部名 `__tmp_16026` ではなく
  `<derived table>` / `CTE 'c'` と表示され、`Details` に内部トークン `__STR_0__` が漏れません。

**述語の押し下げ（この回で最大の性能改善）**

`WHERE` のうち「基底表の列だけを見る条件」を、結合の**前**に適用するようになりました。
従来は必ず結合の後に評価していたため、絞り込みが効く問い合わせでも全行を結合していました。

```sql
-- 20 万行 × 20 万行。a.id < 200 は 200 行しか通らない
SELECT COUNT(*) FROM big a JOIN big b ON a.k = b.k WHERE a.id < 200;
-- 変更前: 5,004ms ／ 変更後: 21ms（237 倍）
-- 同じ意味を派生表で書いた場合（18ms）とほぼ同じになりました
```

`RIGHT` / `FULL JOIN` では未マッチ行の扱いが変わるため押し下げません。深さ 0 に `OR` がある式、
相関サブクエリを含む条件も対象外です。`EXPLAIN` は `FILTER (pushed down)` として区別して表示します。
押し下げの前後で結果が変わらないことは、4 種の結合 × 22 種の条件＋3 表結合・集計・DISTINCT・LIMIT の
**98 通りを変更前のエンジンと突き合わせて 0 件差分**であることを確認しています。

**そのほかこの回で見つけて直したもの**

```sql
-- 空の表（または絞り込みで空になった結果）では式が一度も評価されないため、
-- 列名の誤りが「エラーではなく 0 件」になっていた
SELECT nosuchcol FROM empty_table;   --> Column 'nosuchcol' not found.

-- ダブルクォートは文字列リテラルなので表名にならないが、内部トークンが露出していた
SELECT * FROM "some table";
--> Table 'some table' not found. (Note: "..." is a string literal ... )

-- ALTER TABLE ADD CHECK が NULL 行を違反と判定していた（INSERT では通るのに）
ALTER TABLE t ADD CONSTRAINT c CHECK (a < 100);
```

**この回で意図的に残したもの**

- クエリのキャンセル（実行中の停止）。エンジンは同期実行なので、真の中断には Worker 経路への
  移行が必要です。現状の歯止めは「1 文あたりの実行時間の上限」（既定 30 秒）。
- 空集合の `SUM` / `AVG` が `0`（標準は `NULL`）。既存の仕様として記録済みで、
  PIVOT の空セルもこの挙動に依存しているため変更していません。
- `X'..'` は「バイト列そのもの」ではなく `UNHEX()` と同義の文字列として扱います
  （BLOB 型を持たないため）。ASCII 範囲では `HEX()` と往復しますが、
  0x80 以上のバイトは UTF-8 として復号されるので、生バイトの保存には向きません。

### v1.26 — 区切り識別子 / GROUPING SETS の入れ子 / ダンプの完全性

v1.25 で「未対応」と書いた 2 件を片付け、あわせて SQL ダンプの欠損を直しました。

```sql
-- 1. バッククォートで囲めば予約語も識別子として使える（MySQL 形式）
CREATE TABLE t (`order` INTEGER, `select` TEXT);
SELECT `order`, `select` FROM t WHERE `order` = 1;
-- v1.25 までは素通しで、`order` という名前の列が作られたり
-- `col name` が `col で切れたりしていた（黙って壊れる）
CREATE TABLE t (`col name` INTEGER);   -- 識別子として使えない名前は明示エラー
CREATE TABLE "my tbl" (a INT);         -- ダブルクォートは文字列。バッククォートを使うよう案内する

-- 2. GROUPING SETS の中に ROLLUP / CUBE / 入れ子の GROUPING SETS を書ける
SELECT a, SUM(v) FROM t GROUP BY GROUPING SETS (ROLLUP(a));
SELECT a, b, SUM(v) FROM t GROUP BY GROUPING SETS ((a,b), ROLLUP(a));
-- v1.25 までは "Function 'ROLLUP' does not exist." になっていた
```

**3. SQL ダンプがスキーマの完全なバックアップになった。** `Export SQL` は表・データ・索引・ビュー・
シーケンスしか書き出しておらず、**トリガー・ユーザー定義関数・プロシージャ・コメントを黙って捨てて**いました。
これらも出力し、索引は登録した名前で書き出します（PRIMARY KEY / UNIQUE 由来の暗黙索引は重複して出しません）。
書き出したダンプがそのまま空の DB へ流し込めることをテストで固定しています。

**画面: 表の右クリックメニュー。** これまで SQL を手で書くしか到達手段の無かった操作をツリーから辿れます
— データを見る（先頭100行）／件数を数える／DDL を表示／列の一覧／列プロファイル／スキーマを編集／表名をコピー／表を削除。
削除だけは実行せずエディタへ下書きします（取り返しがつかないため）。

### v1.25 — 算術の NULL 伝播 / 日付型の分離 / ウィンドウの既定フレーム

v1.24 で「未着手」と明記した 3 件を片付けた回です。いずれも **エラーにならず値だけが違う** 種類の不具合でした。

```sql
-- 1. 算術も NULL を伝播する（v1.24 までは JS の挙動で NULL が 0 になっていた）
SELECT amt * qty, amt - qty, -qty FROM s;   -- qty が NULL の行はすべて NULL
SELECT AVG(amt*qty), MIN(amt*qty), COUNT(amt*qty) FROM s;
--   旧: 366.67 / 0 / 3   ← NULL 由来の 0 が最小値に選ばれ、平均の分母にも数えられていた
--   新: 550    / 200 / 2
SELECT 10 / 0, 10 % 0;    -- 旧: Infinity / NaN → 新: NULL（MySQL と同じ）

-- 2. DATE は「日付だけ」、DATETIME / TIMESTAMP は「日付＋時刻」
SELECT CAST('2026-01-02 13:45:00' AS DATE);       -- 2026-01-02（旧: 時刻が残っていた）
SELECT CAST('2026-01-02 13:45:00' AS DATETIME);   -- 2026-01-02 13:45:00
SELECT CAST(at AS DATE) AS d, COUNT(*) FROM events GROUP BY CAST(at AS DATE);  -- 日次集計が成立する
-- 比較は「文字列の並び」ではなく時刻で行うので、表記が違っても同じ瞬間なら一致する
SELECT DATE '2026-01-02' = TIMESTAMP '2026-01-02 00:00:00';   -- true

-- 3. ORDER BY だけを書いた OVER 句の既定フレームは RANGE ... CURRENT ROW（SQL 標準）
SELECT day, SUM(amt) OVER (ORDER BY day) FROM sales;
--   旧: 10, 30, 35（行単位＝ROWS 相当。同じ日の途中経過が出ていた）
--   新: 30, 30, 35（同じ並び順の行はまとめて同じ値）
-- パーティション全体が欲しいときはフレームを明示する（実DBと同じ作法）
SELECT LAST_VALUE(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t;
```

あわせて直したもの:

```sql
-- ON DELETE / ON UPDATE SET DEFAULT が綴りを解釈されず、黙って RESTRICT に落ちていた
CREATE TABLE c (id INT, pid INT DEFAULT 9, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET DEFAULT);
DELETE FROM p WHERE id = 1;   -- c.pid が 9 に戻る（旧: 削除そのものが拒否されていた）

-- COMMENT ON がトランザクションの undo ログに載っておらず ROLLBACK で戻らなかった
BEGIN; COMMENT ON TABLE t IS 'x'; ROLLBACK;   -- 元のコメントに戻る
```

**画面: 1 文あたりの実行時間の上限**（既定 30 秒）。ブラウザ内 DB はクエリが UI スレッドを占有するため、
書き間違えた結合ひとつでタブが永久に固まります。トランザクションバー右側の「上限」で変更・解除でき、選択は保存されます。

### v1.24 — NULL の 3 値論理と、データ入出力 UI の整理

v1.24 の中心は **NULL の扱い**です。v1.23 まで、SQL 式は素の JavaScript 演算子へ写像されていました。
JS は `null` を数値文脈で 0 に、等値比較で `null === null` を真にするため、**エラーを出さずに間違った行を返して**いました。

```sql
-- すべて v1.23 までの挙動 → v1.24 の挙動
SELECT * FROM t WHERE v < 100;      -- v が NULL の行も返っていた → 返らない
SELECT * FROM t WHERE v >= 0;       -- 同上                        → 返らない
SELECT * FROM t WHERE v = NULL;     -- NULL 行に一致していた       → 0 件（UNKNOWN）
SELECT * FROM t WHERE v <> 10;      -- NULL 行を含んでいた         → 含まない
SELECT * FROM t WHERE NOT (v = 10); -- NULL 行を含んでいた         → 含まない
SELECT * FROM t WHERE v BETWEEN -5 AND 5;   -- NULL 行が混入       → 0 件
SELECT * FROM t WHERE v NOT IN (10, NULL);  -- 行を返していた      → 0 件（SQL 標準）
SELECT * FROM t WHERE s NOT LIKE 'x';       -- NULL 行を含んでいた → 含まない
SELECT NULL = NULL, 1 = NULL;               -- true, false        → NULL, NULL

-- CHECK 制約も 3 値論理に。UNKNOWN は違反ではない
CREATE TABLE t (a INT, b INT CHECK (b > 0));
INSERT INTO t (a) VALUES (1);   -- v1.23 までは必ず失敗していた → 通る
INSERT INTO t VALUES (2, -1);   -- 違反はこれまで通り拒否

-- 反結合が NULL で潰れなくなった
SELECT o.id FROM orders o WHERE NOT EXISTS (SELECT 1 FROM coupons c WHERE c.code = o.coupon);
```

`IS NULL` / `IS NOT NULL` / `IS UNKNOWN` は比較ではなく述語なので、これまで通り真偽を返します。

その他の修正:

```sql
-- 外部結合の未マッチ行が「列ごと欠落」していた（行によって列数が違う結果セット）
SELECT * FROM a LEFT JOIN b ON a.k = b.bk;   -- 未マッチ側は NULL で揃うようになった

-- ALTER TABLE の型指定が桁付き・方言別名を受けるようになった
ALTER TABLE t MODIFY COLUMN a VARCHAR(50);   -- v1.23 までは構文エラー
ALTER TABLE t MODIFY COLUMN b DECIMAL(12,4);

-- '__' で始まる表名は予約（作れてしまうと保存時に内部カタログと衝突して黙って消えた）
CREATE TABLE __secret (a INT);   -- 明示的に拒否
```

JS API:

- `LuminaDB.transaction()` に **async 関数**を渡すと、中の書き込みが走る前に COMMIT していた（原子性なし・例外も消える）。明示的なエラーで拒否するようにしました。
- `LuminaDB.insert()` / `upsert()` / `importJSON()` が **先頭行のキーだけ**を列として使い、後続行にしかない項目を無警告で捨てていた。全行のキーの和集合を使います。

### v1.23 で直した「黙って誤る」挙動と追加した構文（抜粋）

v1.23 は新機能よりも **「エラーにならず、間違った結果を返していた箇所」** の修正が中心です。

```sql
-- 別名: AS を省いた後置別名と引用符付き別名（従来は JS の構文エラーが漏れていた）
SELECT id x, COUNT(*) c FROM users GROUP BY id;
SELECT id AS "row id", name AS "名前" FROM users;   -- 従来は列名が __STR_0__ になっていた

-- 修飾スター
SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id;

-- 出力列名の重複: 従来は後の列が前の列を黙って上書きしていた（＝データが消えていた）
SELECT u.name, p.name FROM users u JOIN products p ON 1=1;   -- name, name_1
SELECT * FROM users u JOIN products p ON 1=1;                -- id, name, age, id_1, name_1, ...

-- 集合演算の枝を括弧で囲む書き方（従来は構文エラー）
(SELECT id FROM users WHERE id < 3) UNION (SELECT id FROM users WHERE id > 8);

-- スカラー関数の修正（いずれも従来は黙って誤った値を返していた）
SELECT LTRIM('xxhixx', 'x');        -- hixx  （第2引数が無視されていた）
SELECT SUBSTRING('abcdef', -3);     -- def   （負の開始位置が効かなかった）
SELECT LPAD('abcdef', 3, '-');      -- abc   （長い文字列を切り詰めていなかった）
SELECT HEX('あ');                    -- E38182（UTF-16 単位で 1 バイトに潰れていた）
SELECT UNHEX(HEX('あ'));             -- あ    （往復できなかった）
SELECT TO_TIMESTAMP(1700000000);    -- 2023-11-14（ミリ秒として解釈していた）
SELECT AGE(DATE '2020-01-01');      -- 正の期間（符号が逆だった）
SELECT REGEXP_SUBSTR('a1b2c3', '[0-9]', 1, 2);   -- 2（position / occurrence が無視されていた）

-- SHA-2 系を追加
SELECT SHA256('abc'), SHA224('abc'), SHA2('abc', 256);

-- スキーマ変更: メタデータの取り残しを修正
CREATE TABLE t (a INT, b INT, c INT GENERATED ALWAYS AS (b * 2), CHECK (b > 0));
ALTER TABLE t RENAME COLUMN b TO b2;   -- 生成列の式・CHECK の式・列順・索引名がすべて追随する
                                       -- 従来は追随せず、以後この表へ一切挿入できなくなっていた

-- 複合 UNIQUE INDEX は「組が一意」（従来は「各列が一意」として (1,3) まで拒否していた）
CREATE UNIQUE INDEX ux ON t (a, b2);

-- INSERT の未知列は拒否する（従来は黙って列を作っていた＝無言のスキーマドリフト）
INSERT INTO users (id, nmae) VALUES (1, 'x');   -- Column 'nmae' not found. Did you mean 'name'?

-- ALTER TABLE の複数アクション / INSERT OR <action>
ALTER TABLE t ADD COLUMN d INT, ADD COLUMN e TEXT;
INSERT OR REPLACE INTO t (a) VALUES (1);   -- REPLACE / IGNORE / ABORT / FAIL / ROLLBACK
```

エラーメッセージも直しました。

| 入力 | v1.22 まで | v1.23 |
|------|-----------|-------|
| `SELECT LENGHT('abc')` | `Column 'lenght' not found.` | `Function 'LENGHT' does not exist. Did you mean 'LENGTH'?` |
| `SELECT (1+2 FROM t` | `Unexpected token ';'. Expected ')' to end a compound expression.`（JS の言い回し） | `Malformed expression: (1+2 — check for unbalanced parentheses, an unclosed quote, or a missing operand.` |

### v1.22 で追加した構文（抜粋）

```sql
-- 日付演算（従来は文字列連結や NULL になっていた）
SELECT DATE '2026-01-01' + 30                AS due;      -- 2026-01-31
SELECT CURRENT_DATE - 7                      AS week_ago;
SELECT DATE '2026-03-01' - DATE '2026-01-01' AS days;     -- 59
SELECT nm, hire + 90 AS probation_end FROM emp;           -- 日付型の列にも効く

-- Oracle の階層問い合わせ
SELECT nm, LEVEL, SYS_CONNECT_BY_PATH(nm, '/') AS path, CONNECT_BY_ISLEAF AS leaf
FROM emp
START WITH mgr IS NULL
CONNECT BY PRIOR id = mgr
ORDER SIBLINGS BY nm;

SELECT name FROM users WHERE ROWNUM <= 3;                 -- 上位 n 件の定番
SELECT nm FROM (SELECT nm FROM emp ORDER BY sal DESC) WHERE ROWNUM <= 3;

-- 分析関数
SELECT nm, RATIO_TO_REPORT(sal) OVER (PARTITION BY dept)          AS share FROM emp;
SELECT DISTINCT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sal) OVER () AS median FROM emp;
SELECT NTH_VALUE(nm, 2) FROM LAST OVER (ORDER BY id)              AS second_last FROM emp;
SELECT MAX(sal) KEEP (DENSE_RANK FIRST ORDER BY hire)             AS earliest_hire_sal FROM emp;

-- DDL の取りこぼし修正・追加
TRUNCATE TABLE t1, t2;                                    -- 以前は先頭 1 表しか空にしていなかった
ALTER TABLE t ADD COLUMN len INTEGER GENERATED ALWAYS AS (LENGTH(nm)) STORED;
CREATE INDEX ix ON t (nm) INCLUDE (v);
CREATE INDEX CONCURRENTLY ix2 ON t (v);
SET CONSTRAINTS ALL IMMEDIATE;
SHOW SCHEMAS;
SHOW TRANSACTION ISOLATION LEVEL;

-- upsert でも RETURNING が使える（実際に書き込んだ行だけ返る）
INSERT INTO t (id, nm) VALUES (1, 'a') ON CONFLICT (id) DO NOTHING RETURNING id;
INSERT INTO t (id, nm) VALUES (1, 'b') ON CONFLICT (id) DO UPDATE SET nm = 'b' RETURNING id, nm;

-- PostgreSQL の照合演算子
SELECT * FROM t WHERE nm ~  '^A';      -- 正規表現
SELECT * FROM t WHERE nm ~* '^a';      -- 大小無視
SELECT * FROM t WHERE nm !~~ 'A%';     -- NOT LIKE
SELECT CURRENT_CATALOG AS db;
```

### v1.21 で追加した構文（抜粋）

```sql
-- GROUP BY の結果に対するウィンドウ関数（構成比・グループ内順位・累計）
SELECT dept,
       SUM(salary)                                            AS total,
       ROUND(SUM(salary) * 100.0 / SUM(SUM(salary)) OVER (), 1) AS pct,
       RANK() OVER (ORDER BY SUM(salary) DESC)                AS rk,
       SUM(SUM(salary)) OVER (ORDER BY dept)                  AS running
FROM emp GROUP BY dept;

-- 列レベルの COLLATE が実際に効く（比較・IN・BETWEEN・ORDER BY・GROUP BY・DISTINCT・UNIQUE）
CREATE TABLE m (id INTEGER PRIMARY KEY, nm TEXT COLLATE NOCASE UNIQUE);
SELECT * FROM m WHERE nm = 'APPLE';        -- 'Apple' も一致する
SELECT DISTINCT nm FROM m ORDER BY nm;     -- 大文字小文字を畳んで比較・整列する

-- ORDER BY ALL / GROUPING_ID
SELECT region, product FROM sales ORDER BY ALL DESC;
SELECT region, product, SUM(amt), GROUPING_ID(region, product) AS gid
FROM sales GROUP BY CUBE(region, product);

-- ALTER COLUMN の標準綴りと変換式、制約の改名
ALTER TABLE t ALTER COLUMN amt SET DATA TYPE FLOAT;
ALTER TABLE t ALTER COLUMN s TYPE INTEGER USING LENGTH(s);
ALTER TABLE t RENAME CONSTRAINT uq_old TO uq_new;

-- 識別列への明示代入の扱いを選ぶ（SQL標準）
INSERT INTO t (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, 'a');  -- 与えた値を使う
INSERT INTO t (id, nm) OVERRIDING USER VALUE   VALUES (99, 'b');  -- 捨てて自動採番

-- JOIN LATERAL ... ON TRUE（LEFT / INNER / CROSS）
SELECT u.name, x.c FROM users u
JOIN LATERAL (SELECT COUNT(*) AS c FROM orders o WHERE o.user_id = u.id) x ON TRUE;

-- 添字とスライス（SQL 準拠の 1 始まり。配列・文字列・JSON 共通）
SELECT ARRAY[10, 20, 30, 40][2]    AS second;   -- 20
SELECT ARRAY[10, 20, 30, 40][2:3]  AS slice;    -- [20, 30]
SELECT ('hello')[2:4]              AS sub;      -- 'ell'

-- 致命的でない問題は「警告」として残る（実行は続行）
UPDATE emp SET salary = 0;      -- WHERE なしの全行更新
SHOW WARNINGS;                  -- 直前の文が出した警告を読む
SHOW COUNT(*) WARNINGS;
```

### v1.20 で追加した構文（抜粋）

```sql
-- 連結系集計の引数内 ORDER BY（PostgreSQL / Oracle の書き方）
SELECT STRING_AGG(name, ',' ORDER BY salary DESC) AS names FROM emp;
SELECT ARRAY_AGG(name ORDER BY id) AS arr FROM emp;

-- ORDER BY にウィンドウ関数を直書きできる（WHERE / GROUP BY は理由付きで拒否）
SELECT name FROM emp ORDER BY ROW_NUMBER() OVER (ORDER BY salary DESC);

-- 値の並びからの一括更新（移行スクリプトの定番）
UPDATE emp SET salary = v.s FROM (VALUES (1, 111), (2, 222)) AS v(i, s) WHERE emp.id = v.i;
DELETE FROM emp USING (VALUES (9)) AS d(i) WHERE emp.id = d.i;

-- SELECT 句に書く集合返し関数と中置整数除算
SELECT UNNEST(ARRAY[1, 2, 3]) AS v;
SELECT GENERATE_SERIES(1, 12) AS month;
SELECT salary DIV 1000 AS band FROM emp;

-- ドメインと列挙型（列制約として強制される）
CREATE DOMAIN pos_int AS INTEGER CHECK (VALUE > 0);
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE survey (id INTEGER, score pos_int, m mood);

-- ユーザー・ロール（権限は強制しないがスクリプトは通る）
CREATE ROLE reporting;  GRANT SELECT ON emp TO reporting;  SHOW GRANTS;

-- 採番を維持したまま全消し
TRUNCATE TABLE audit CONTINUE IDENTITY;

-- 再帰CTE の走査順と循環検出（循環グラフが上限エラーで落ちなくなる）
WITH RECURSIVE t(id, nm) AS (
  SELECT id, nm FROM tree WHERE pid IS NULL
  UNION ALL SELECT e.id, e.nm FROM tree e JOIN t s ON e.pid = s.id
) SEARCH DEPTH FIRST BY id SET ord
SELECT id, ord FROM t ORDER BY ord;

WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM g JOIN t ON g.a = t.n)
CYCLE n SET is_cycle USING path
SELECT n, is_cycle, path FROM t;
```

**性能**: `IN (値, ...)` がインデックスを使うようになりました（従来は全表走査）。
`EXPLAIN` にも `Index lookup of N value(s)` として出ます。

**修正**: 別名の無い定数列（`SELECT id, name, 0`）が JS の整数風キー順序で先頭へ回り、
**出力列の順序が SELECT の並びと食い違っていた**のを修正しました。文字列定数で内部トークン
`__STR_0__` が列名として露出していたのも併せて直しています（いずれも `columnN` になります）。
集計の入れ子や WHERE でのウィンドウ関数など、実DBが拒否するものは理由の判る文言で拒否します。

### v1.19 で追加した構文（抜粋）

```sql
-- 複合列の外部キー（複合主キーを参照する定番形。従来は明示エラーだった）
CREATE TABLE order_line (
  order_id INTEGER, line_no INTEGER, sku TEXT,
  FOREIGN KEY (order_id, line_no) REFERENCES shipment(order_id, line_no) ON DELETE CASCADE
);
ALTER TABLE order_line ADD CONSTRAINT fk_ship FOREIGN KEY (order_id, line_no) REFERENCES shipment(order_id, line_no);

-- シーケンスのオプションと ALTER
CREATE SEQUENCE ticket START WITH 100 INCREMENT BY 10 MINVALUE 1 MAXVALUE 999 CYCLE;
ALTER SEQUENCE ticket RESTART WITH 500;

-- DEFAULT に式を書ける（行ごとに評価される）
CREATE TABLE audit (
  id  INTEGER DEFAULT NEXTVAL('ticket'),
  tag TEXT    DEFAULT UUID(),
  n   INTEGER DEFAULT (1 + 2)
);

-- MERGE の条件付き WHEN と、ソースに無い行への操作
MERGE INTO target t USING source s ON t.id = s.id
  WHEN MATCHED AND t.qty <> s.qty THEN UPDATE SET qty = s.qty
  WHEN MATCHED AND s.qty = 0      THEN DELETE
  WHEN NOT MATCHED AND s.qty > 0  THEN INSERT (id, qty) VALUES (s.id, s.qty)
  WHEN NOT MATCHED BY SOURCE      THEN DELETE;

-- upsert の追加構文
INSERT INTO counter (id, hits) VALUES (1, 5) ON DUPLICATE KEY UPDATE hits = hits + VALUES(hits);
INSERT INTO counter (id, hits) VALUES (1, 5)
  ON CONFLICT (id) DO UPDATE SET hits = EXCLUDED.hits WHERE counter.hits < EXCLUDED.hits;

-- ビューの列リスト（更新可能ビューのまま使える）
CREATE VIEW v_user (uid, uname) AS SELECT id, name FROM users;
UPDATE v_user SET uname = 'Bobby' WHERE uid = 2;

-- DDL とメタデータ
ALTER INDEX ix_old RENAME TO ix_new;
SHOW TABLE STATUS LIKE 'user%';
CREATE TABLE snapshot_shape AS SELECT * FROM users WITH NO DATA;
CREATE GLOBAL TEMPORARY TABLE scratch (a INTEGER);
```

集計の入れ子（`MAX(SUM(x))`）は、内側が列名として解決されて判りにくいエラーになっていたのを、
「入れ子にはできない・サブクエリで先に集計せよ」と伝えるメッセージに変えました。

### v1.18 で追加した構文（抜粋）

```sql
-- 桁指定付きの型変換（DECIMAL は位取りへ丸め、VARCHAR/CHAR は長さで切り捨て）
SELECT CAST(1.005 AS DECIMAL(10,2)) AS rounded;   -- 1.01（MySQL と同じ丸め）
SELECT CAST(12345 AS VARCHAR(3)) AS truncated;    -- '123'
SELECT CONVERT(DECIMAL(5,1), 3.14159) AS s;       -- SQL Server 形の引数順も可

-- 更新可能ビュー: 単一表への射影＋選択なら INSERT / UPDATE / DELETE が通る
CREATE VIEW v_active AS SELECT id, name FROM users WHERE age >= 30 WITH CHECK OPTION;
UPDATE v_active SET name = 'Bobby' WHERE id = 2;  -- 基底表へ書き換えて実行
INSERT INTO v_active (id, name) VALUES (99, 'x'); -- CHECK OPTION でビュー外の行は拒否

-- 集約ビューへも INSTEAD OF トリガーで書ける
CREATE TRIGGER tg_sum INSTEAD OF INSERT ON v_totals FOR EACH ROW
  INSERT INTO orders (user_id, amount) VALUES (NEW.user_id, NEW.total);

-- 列レベルの外部キー宣言（従来は黙って制約が落ちていた）
CREATE TABLE child (id INTEGER, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE);
CREATE TABLE child2 (id INTEGER, pid INTEGER REFERENCES parent);  -- 参照列は PK へ解決

-- JSON アクセス演算子と部分更新
SELECT payload ->> 'name' AS name, payload -> 'tags' AS tags FROM events;
SELECT payload #>> '{addr,city}' AS city FROM events;
SELECT COUNT(*) FROM events WHERE payload @> '{"kind":"click"}';
SELECT JSON_INSERT(payload, '$.seen', TRUE) FROM events;   -- 無いパスだけ書く
SELECT JSON_REPLACE(payload, '$.seen', FALSE) FROM events;  -- 有るパスだけ書く

-- 真偽述語（3値論理: NULL は TRUE でも FALSE でもない）
SELECT * FROM users WHERE (age > 30) IS NOT TRUE;

-- 名前付き制約とテーブル別名つき DML
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE orders DROP CONSTRAINT fk_user;
UPDATE orders o SET o.amount = o.amount + 1 WHERE o.order_id = 1001;
DELETE FROM orders o WHERE o.amount = 0;

-- 行コンストラクタ IN のサブクエリ形
SELECT * FROM orders WHERE (user_id, product_id) IN (SELECT user_id, product_id FROM archive);

-- 索引の並び順・式キーと配列の行展開
CREATE INDEX ix_price ON products (price DESC, name ASC NULLS LAST);
CREATE INDEX ix_lname ON users (LOWER(name));
SELECT SUM(v) FROM UNNEST(ARRAY[1, 2, 3]) AS t(v);
SELECT v, n FROM UNNEST(ARRAY['a','b']) WITH ORDINALITY AS t(v, n);
```

追加したメタデータビュー: `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` /
`CHECK_CONSTRAINTS` / `STATISTICS` / `TRIGGERS` / `PARAMETERS`、および
`SHOW INDEX` / `SHOW KEYS`（`SHOW INDEXES` の MySQL 綴り）。

### v1.17 で追加した構文（抜粋）

```sql
-- 配列とあいまい検索（クライアント側の名寄せ・検索に）
SELECT ARRAY_TO_STRING(ARRAY[1, 2, 3], '-') AS joined;
SELECT * FROM users WHERE id = ANY(ARRAY[1, 2, 3]);
SELECT name, SIMILARITY(name, 'Alise') AS score
FROM users WHERE LEVENSHTEIN(name, 'Alise') <= 2 ORDER BY score DESC;

-- 単回帰と最頻値
SELECT REGR_SLOPE(price, stock) AS slope, REGR_R2(price, stock) AS r2 FROM products;
SELECT MODE() WITHIN GROUP (ORDER BY age) AS most_common FROM users;

-- 欠測のない時系列（バケットを先に作って LEFT JOIN する定番形）
SELECT d.value AS day, COUNT(o.order_id) AS n
FROM GENERATE_SERIES(DATE '2026-01-01', DATE '2026-01-07', INTERVAL 1 DAY) d
LEFT JOIN orders o ON DATE_BIN(INTERVAL 1 DAY, o.created_at) = d.value
GROUP BY d.value ORDER BY day;

SELECT v, n FROM GENERATE_SERIES(10, 30, 10) WITH ORDINALITY AS t(v, n);
SELECT NOW() AT TIME ZONE '+09:00' AS tokyo;

-- ウィンドウ関数の EXCLUDE と FILTER
SELECT id, SUM(age) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                          EXCLUDE CURRENT ROW) AS others_total FROM users;
SELECT id, SUM(age) FILTER (WHERE age > 25) OVER () AS adults_total FROM users;
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

### v1.14 で追加した運用機能

ブラウザではクエリが UI スレッドを占有し、DB がページと同じ権限空間に置かれます。そこに効く 5 つの機能を追加しました。

| 機能 | 用途 | SQL | JS API |
|------|------|-----|--------|
| **文単位タイムアウト** | 暴走クエリで画面が固まるのを防ぐ | `SET statement_timeout = 500` | `LuminaDB.timeout(500)` |
| **読み取り専用モード** | iframe / 外部スクリプトへ安全に公開する | `SET read_only = ON` | `LuminaDB.readOnly(true, { lock: true })` |
| **スナップショット** | 取り込み前に戻れる「メモリ内タイムトラベル」 | `CREATE / RESTORE / DROP SNAPSHOT s` | `LuminaDB.snapshot('s')` / `restore('s')` |
| **ライブクエリ** | 書き込みに追従して UI を更新する | — | `LuminaDB.subscribe(sql, rows => ...)` |
| **プロファイル / 遅いクエリログ** | どのクエリが重いかを可視化する | `SHOW PROFILE` / `SHOW SLOW QUERIES` | `LuminaDB.profile()` / `slowQueries()` |

### v1.15 で追加した「ブラウザDBに必須」の 3 機能

| 機能 | 解決する問題 | 使い方 |
|------|--------------|--------|
| **ワーカー実行** | クエリが UI スレッドを占有し、重い集計の間だけ画面が固まる | `LuminaDB.worker.*`（別スレッドの複製 DB で実行し、必要なら書き戻す） |
| **スキーマ・マイグレーション** | 利用者の端末に古いスキーマが残り続ける | `LuminaDB.migrate([...])` + `PRAGMA user_version` |
| **バックアップ入出力** | IndexedDB はブラウザを消せば消える。手元に取り出す経路が要る | `LuminaDB.download()` / `LuminaDB.backup()` / `LuminaDB.restoreBackup()` |

```js
// 1. 重いクエリを UI スレッドの外で走らせる（画面は固まらない）
await LuminaDB.worker.start();
await LuminaDB.worker.sync();                        // 現在の DB をワーカーへ複製
const r = await LuminaDB.worker.query('SELECT g, COUNT(*) FROM big GROUP BY g');
await LuminaDB.worker.pull();                        // ワーカー側で書いた結果を戻す
LuminaDB.worker.stop();

// 2. 版数を見て差分だけ適用する（途中で失敗したらスナップショットで自動ロールバック）
LuminaDB.migrate([
  { version: 1, up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)' },
  { version: 2, up: 'ALTER TABLE notes ADD COLUMN tag TEXT' },
  { version: 3, up: api => api.exec("INSERT INTO notes (id, body) VALUES (1, 'hello')") }
]);
// → { applied: [1, 2, 3], from: 0, to: 3 }

// 3. 完全な状態（スキーマ・データ・ビュー・関数・版数）を 1 ファイルで往復
LuminaDB.download('mydb.json');
LuminaDB.restoreBackup(await file.text());
```

保存の排他は **Web Locks API** で直列化されるようになりました（従来の楽観ロックだけでは
「バージョン読み取り → 書き込み」の間に他タブが割り込む窓が残っていました）。

### v1.16 で追加した「ブラウザDBに必須」の 3 機能

| 機能 | 解決する問題 | 使い方 |
|------|--------------|--------|
| **差分永続化** | 1 行変えただけでも DB 全体を再直列化・再暗号化していた | 自動（テーブル単位。`LuminaDB.saveStats()` で内訳を確認） |
| **バッチ読み出し** | `rows()` は全件をメモリへ載せるので大きな表で破綻する | `LuminaDB.eachBatch()` / `LuminaDB.cursor()` |
| **タブ間の追従・離脱保護** | 他タブの更新に気づけない / 未保存のまま閉じてしまう | `LuminaDB.autoReload(true)` と `beforeunload` ガード（自動） |

差分永続化はテーブルごとに「変更世代 : 行数 : 容量」の指紋を持ち、前回保存と同じ表は
書き直しません。60,000 行の DB で実測すると、初回の全保存 25ms に対し、小さな表を 1 つ
更新しただけの保存は **2ms**（変更なしの保存は 1ms・書き込み 0 テーブル）です。

### v1.24 で整理した画面機能

サイドバーにあった **Export SQL / Import SQL / Import CSV / Test Data** の 4 ボタンは、
説明が無く・場所を取り・押すまで何が起きるか判らないものでした。**Data** の 1 ボタンに集約し、
中身をタブ付きのパネルへ移して、各操作に「何をするか・何が要るか」を書いてあります（`Ctrl+Shift+D`）。

| タブ | 内容 |
|------|------|
| **書き出し** | SQL ダンプ（`CREATE TABLE` + `INSERT`）／全テーブルの JSON。書き出した表数と文字数を表示 |
| **読み込み** | SQL ファイル（`;` 区切りで順に実行）／CSV ファイル。`.sql` `.csv` のドラッグ&ドロップにも対応 |
| **テストデータ** | 既存のダミー行生成（対象表と行数） |

あわせて入出力そのものも直しました。

| 項目 | v1.23 まで | v1.24 |
|------|-----------|-------|
| SQL インポートの失敗 | 「N / M 件実行しました」だけで、**どの文がなぜ落ちたか判らなかった** | 失敗した文とエラー内容を一覧表示 |
| CSV パーサ | 画面独自の簡易実装で、**引用符の中の改行で行が壊れた** | API 側の RFC 4180 パーサを共用（引用符内のカンマ・改行に対応） |
| CSV の取り込み先 | 既存の表のみ・列数の完全一致が必須 | 「＋ 新しい表を作る」でヘッダーから表を作成し型を推定。取り込み前に既存行を消すオプションも |

### v1.23 で追加・修正した画面機能

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **スキーマ検索** | 表が増えるとサイドバーを目で探すしかなく、列名からは辿れなかった | サイドバーの検索欄。表名・列名の部分一致で絞り込み、列に当たった表は自動で展開する。`Esc` でクリア |
| **エディタの高さ変更** | エディタが 128px 固定で、長い SQL が数行しか見えなかった | エディタ下端の境界をドラッグ（キーボードは矢印キー）。ダブルクリックで既定へ戻す。高さはブラウザに保存される |
| **Explain ボタン** | 実行計画を見るには毎回 `EXPLAIN` を手で付けていた | エディタ上部の `Explain`（`Ctrl+Shift+E`）。カーソル位置の文の計画だけを出し、データは書き換えない |
| **TSV コピー** | 結果を表計算ソフトへ貼る手段が無かった | 結果ツールバーの `Copy TSV` |
| **行選択の解除（不具合修正）** | 行を選んでから並べ替え・絞り込みをすると、`− Row` が**別の行を削除**していた | 表示順が変わる操作で選択を解除する |
| **書き出しが絞り込みに追従（不具合修正）** | 絞り込み中でも CSV / JSON / Markdown / INSERT は絞り込み前の全行を出していた | 画面に見えている行だけを書き出す |
| **CSV の NULL 表現（不具合修正）** | すべての値を `"..."` で囲むため NULL と空文字が区別できなかった | 引用は必要なときだけ。NULL は空欄、空文字は `""` |

### v1.22 で追加した画面機能

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **列プロファイル** | 「この列に何が入っているか」を見るのに毎回 SQL を書いていた | テーブル行のグラフアイコン。行数・NULL 数と割合・相異なり数・最小/最大・平均・文字数の幅・出現上位 3 件を一覧する。列名クリックでその列の分布クエリをエディタへ |
| **ER 図** | 外部キーの関係が画面のどこにも出ていなかった | サイドバー右上の `ER図`。親を上・子を下に並べ、外部キーを矢印で結ぶ。表クリックで `SELECT`、`Copy SVG` で図をコピー |

### v1.21 で追加した画面機能

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **エディタタブ** | 別のクエリを試すたびに書きかけを消すか、1 枚のエディタに積み上げるしかなかった | エディタ上部のタブ。`＋`（`Ctrl+Alt+T`）で追加、`×`（`Ctrl+Alt+W`）で閉じる、`Alt+1〜9` で切替。タブ名は SQL から自動で付き、ダブルクリックで手動命名できる。内容と undo 履歴はタブごとに保持され、ブラウザに保存されるのでリロードしても残る |
| **警告のコンソール出力** | `IF EXISTS` で何もしなかった DDL や `WHERE` なしの全行更新が「成功」としか出なかった | 実行ログコンソール（``Ctrl+` ``）に `WRN` 行として出る。SQL からは `SHOW WARNINGS` で読める |

### v1.20 で追加した画面機能

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **結果グリッドの行追加・行削除** | セル編集はできても行の増減は SQL を書く必要があった | セルをクリックして行を選択 → `− Row` で削除、`+ Row` で既定値の行を追加。編集可能なグリッドでのみ有効で、キー値はプレースホルダで束縛される |
| **クエリ履歴パネル** | `Ctrl+↑↓` の巡回だけでは「少し前のあの1文」に戻れなかった | `History` ボタンで一覧。検索で絞り込み、クリックでエディタへ読み込み、`Run` で即実行 |

### v1.19 で追加した画面機能

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **結果グリッドの直接編集** | 1 セル直すだけでも `UPDATE` を書く必要があった | セルを**ダブルクリック**して編集、Enter で確定・Esc で取消。単一表の SELECT でキー列（PK / UNIQUE）が結果に含まれるときだけ有効で、可否と理由はツールバーのバッジに出る。入力値は必ずプレースホルダでバインドするため、引用符やセミコロンを含む値も安全に保存される |
| **Markdown / INSERT でコピー** | 結果を課題票へ貼ったり別DBへ移すのに手作業が要った | `Copy MD` は Markdown 表（`\|` と改行をエスケープ）、`Copy INSERT` は `INSERT` 文（引用符を二重化）としてクリップボードへ |
| **ショートカット一覧** | 使える操作が画面から判らなかった | ツールバーの `?` ボタン、またはキーボードの `?`。Esc で全モーダルを閉じる |

### v1.18 で追加した画面機能

商用DBクライアント（DBeaver / pgAdmin / SSMS）で日常的に使う操作を揃えました。

| 機能 | 解決する問題 | 操作 |
|------|--------------|------|
| **結果グリッドの絞り込み** | 数千行の結果から目的の行を探すのに、毎回 SQL へ `WHERE` を足していた | 結果上部の絞り込み欄（全列を対象に部分一致。件数は「絞り込み後 / 全件」で表示） |
| **セル詳細ビュー** | 長いテキストや JSON がセル内で切れて読めなかった | セルをクリック → 型・長さ・生の値を表示（JSON はワンクリックで整形・コピー可） |
| **スキーマツリーの展開** | 列名と制約を確認するのに `DESCRIBE` を打つ必要があった | テーブル名の左の ▶ で展開。列ごとに型と `PK` / `FK` / `UQ` / `NN` / `AI` / `GEN` のバッジを表示し、クリックでカーソル位置へ列名を挿入 |
| **オブジェクト一覧の拡充** | ビューとトリガーしか一覧できなかった | Indexes / Sequences / Procedures / Functions のセクションを追加（ビューの `CHECK OPTION` も表示） |
| **トランザクション操作バー** | `BEGIN` / `COMMIT` / `ROLLBACK` を毎回手で打ち、未確定かどうかが画面から分からなかった | Begin / Commit / Rollback ボタンと状態表示（未確定の変更数つき。トランザクション中は自動保存を止める） |
| **カーソル位置の文だけ実行** | 複数文を書き溜めたエディタから 1 文だけ試せなかった | `Ctrl+Enter` でカーソル位置の文のみ実行（`Ctrl+Shift+Enter` は従来どおり全文）。文字列リテラル内の `;` は区切りとして扱わない |

### v1.17 で追加したブラウザDB機能

| 機能 | 解決する問題 | API |
|------|--------------|-----|
| **式コンパイルキャッシュ** | 同じ形のクエリを何百回も投げると、毎回の式コンパイルが支配的になる | 自動（`LuminaDB.cacheStats()` でヒット率を確認） |
| **CSV 取り込み / 書き出し** | ファイルやフェッチしたテキストを表に落とす経路が JS API に無かった | `LuminaDB.importCSV()` / `exportCSV()` |
| **タブのリーダー選出** | 複数タブで同じ定期処理が重複して走る | `LuminaDB.onLeader(cb)` / `isLeader()` |

式キャッシュは式テキストをキーにした LRU（既定 500 件）です。ユーザー変数・`LAST_INSERT_ID()`・
シーケンス・ユーザー定義関数など「実行時点の状態を式へ畳み込む」構文が含まれる場合はキャッシュしません。
同一クエリの反復では実測で **約 2 倍** 速くなります。

```js
// CSV（RFC 4180: 引用符内のカンマ・改行・二重引用符に対応。空欄は NULL、型は列ごとに推定）
LuminaDB.importCSV(await file.text(), 'sales', { create: true });
LuminaDB.importCSV(text, 'sales', { replace: true, delimiter: ';' });
const csv = LuminaDB.exportCSV('sales');

// リーダータブだけが重い定期処理を担う（閉じると別タブが自動昇格）
const handle = LuminaDB.onLeader(() => startBackgroundSync());
handle.release();

LuminaDB.cacheStats();  // { hits: 204, misses: 1, size: 1, max: 500, hitRate: 0.995 }
```

```js
// 差分保存が効いているかの確認
LuminaDB.saveStats();   // { tables: 5, written: 1, skipped: 4, removed: 0, full: false }

// 大きな結果を一定件数ずつ処理する（ピークメモリは batch 件ぶんだけ）
LuminaDB.eachBatch('SELECT * FROM big ORDER BY id', [], 1000, rows => render(rows));
for (const row of LuminaDB.cursor('SELECT * FROM big ORDER BY id')) { /* ... */ }

// 他タブの保存に自動追従（未保存の変更が無いときだけ読み直す）
LuminaDB.autoReload(true);
```

```js
// ライブクエリ: 結果が変わったときだけコールバックされる（無関係な書き込みでは呼ばれない）
const sub = LuminaDB.subscribe('SELECT COUNT(*) AS c FROM users', rows => render(rows[0].c));
sub.unsubscribe();

// 読み取り専用で公開する（lock: true にすると SQL の SET read_only = OFF では解除できない）
LuminaDB.readOnly(true, { lock: true });

// 壊す前にスナップショットを取り、失敗したら戻す
LuminaDB.snapshot('before_import');
try { LuminaDB.importJSON('users', rows); } catch (e) { LuminaDB.restore('before_import'); }

// JSON 入出力 / 決定的な乱数（テストデータの再現）
LuminaDB.importJSON('metrics', [{ id: 1, v: 10 }], { create: true });
const dump = LuminaDB.exportJSON(['metrics']);
LuminaDB.query("SET seed = 0.42");   // 以降 RAND() が再現可能になる
```

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
├── storage/idb.js       IndexedDB 永続化（AES-GCM 暗号化・Web Locks 排他・バックアップ）
├── worker/              ワーカースレッド版エンジン（UI を止めない実行）
├── ui/                  画面（state / editor / results / table-tree / schema-editor /
│                        help / modals / data-io / query-runner / console）
├── api/api.js           外部 API（window.LuminaDB / fetch / postMessage）
└── tests/               自己完結テストスイート（test-suite*.js）
```

---

## テスト

7,000 件超の自己完結テストを 2 通りで実行できます。内訳の主なものは以下のとおりです。

| スイート | 件数 | 内容 |
|----------|------|------|
| `test-suite*.js`（v1〜v16） | 約 5,300 | SQL 構文・関数・UI・永続化の機能テスト |
| `test-suite-v17.js` | 247 | v1.14 で追加した構文と運用機能の回帰 |
| `test-suite-v18.js` | 679 | **セキュリティ**（インジェクション / 識別子検証 / JS 脱出 / プロトタイプ汚染 / DoS ガード / 読み取り専用の強制 / API 境界 / 出力エスケープ） |
| `test-suite-v19.js` | 433 | **パフォーマンス**（較正付きの時間予算・計算量スケーリング・絶対値の安全網） |
| `test-suite-v20.js` | 275 | v1.15 の構文とブラウザDB必須機能。新しい入口（プロシージャのローカル変数・`JSON_TABLE` のパス・`MATCH` の検索語・バックアップの取り込み・ワーカーのメッセージ）に対するセキュリティ検査と性能予算を含む |
| `test-suite-v21.js` | 185 | v1.16 の手続き型（カーソル・ハンドラ・`SIGNAL`・`CASE` 文）、期間/JSON/時系列の述語、差分永続化・ストリーミング読み出し。カーソルが返す値と `SIGNAL` の本文に対するセキュリティ検査を含む |
| `test-suite-v22.js` | 180 | v1.17 の配列・回帰集計・あいまい照合・時系列生成・ウィンドウ拡張、式キャッシュ・CSV 取り込み・リーダー選出。CSV のフィールド/ヘッダーと配列要素に対するセキュリティ検査を含む |
| `test-suite-v23.js` | 203 | v1.18 の桁指定付き `CAST`/`CONVERT`、更新可能ビューと `WITH CHECK OPTION`、`INSTEAD OF` トリガー、列レベル `REFERENCES`、JSON アクセス演算子、`IS [NOT] TRUE/FALSE`、名前付き制約、DML の別名、行コンストラクタ `IN (SELECT)`、索引の並び順/式キー、メタデータビュー、`UNNEST`。UI（結果絞り込み・セル詳細・ツリー展開・トランザクションバー・カーソル位置の文の実行）も含む |
| `test-suite-v24.js` | 124 | v1.19 の複合列 `FOREIGN KEY`、シーケンスのオプションと `ALTER SEQUENCE`、`DEFAULT` 式、`MERGE` の条件付き `WHEN` と `NOT MATCHED BY SOURCE`、`VALUES(col)` / `ON CONFLICT ... WHERE`、ビューの列リスト、`ALTER INDEX RENAME` / `SHOW TABLE STATUS` / `WITH [NO] DATA`、集計入れ子の診断。UI（結果グリッドの直接編集・コピー書式・ショートカット）も含み、セル編集の値がバインドされること（SQL 組み立てでないこと）を検査する |
| `test-suite-v31.js` | 41 | v1.26 のバッククォート区切り識別子（予約語の列名・表名／不正な名前と未終端の明示エラー／文字列リテラル内は不変／例外ではなくエラー結果を返すこと）、`GROUPING SETS` 内の `ROLLUP`/`CUBE`/入れ子、`exportSQL` のトリガー・関数・プロシージャ・コメント出力と索引名・往復再生、UI（表の右クリックメニュー） |
| `test-suite-v30.js` | 68 | v1.25 の算術 NULL 伝播（`+ - *` と単項マイナス・演算子優先順位・指数表記）と 0 除算、`DATE` と `DATETIME`/`TIMESTAMP` の分離（`CAST` / 型付きリテラル / `::` / 日次 `GROUP BY` / 表記違いの比較）、ウィンドウ関数の既定フレーム（`RANGE ... CURRENT ROW`・明示 `ROWS` との差・`PARTITION BY`・GROUP BY 結果への窓）、`ON DELETE SET DEFAULT`、`COMMENT ON` の `ROLLBACK`、UI（実行時間の上限） |
| `test-suite-v29.js` | 82 | v1.24 の NULL 3 値論理（比較・`NOT`・`IN`/`NOT IN`・`CHECK`・`LIKE` 系）、`IS [NOT] NULL`/`UNKNOWN` が述語のままであること、外部結合 `SELECT *` の NULL 埋め、`ALTER TABLE` の桁付き型と方言別名、`__` で始まる表名の拒否、`transaction()` の async 拒否、`insert()` の列は全行の和集合。UI（Data モーダルへの集約、SQL インポートの失敗レポート、RFC4180 CSV・新規表作成・置換・ドラッグ&ドロップ）も含む |
| `test-suite-v28.js` | 162 | v1.23 の別名（`AS` 省略・引用符付き）、修飾スター、出力列名の重複解決、`LTRIM`/`RTRIM` の文字集合、`SUBSTRING` の負の開始位置、`LPAD`/`RPAD` の切り詰め、`HEX`/`UNHEX` の UTF-8 化、`TO_TIMESTAMP` のエポック秒、`AGE` の符号、`REGEXP_*` の position/occurrence/match_type、`SHA2`/`SHA256`/`SHA224`、列の改名・削除に伴うメタデータ追随（生成列・CHECK・列順・索引名）、複合 `UNIQUE INDEX`、`INSERT` の未知列拒否、`INSERT OR <action>`、`ALTER TABLE` の複数アクション、括弧付き集合演算、エラーメッセージ。UI（スキーマ検索・スプリッタ・Explain・行選択・書き出し）も含む |
| `test-suite-v27.js` | 123 | v1.22 の日付演算（日付 ± 数値 / 日付 − 日付）、Oracle の階層問い合わせ（`CONNECT BY` / `LEVEL` / `SYS_CONNECT_BY_PATH` / `CONNECT_BY_ROOT` / `NOCYCLE`）と `ROWNUM`、分析関数（`RATIO_TO_REPORT` / `PERCENTILE_* OVER` / `NTH_VALUE ... FROM LAST` / `KEEP (DENSE_RANK ...)`）、`TRUNCATE` の複数表指定、`CREATE INDEX` の `INCLUDE`/`CONCURRENTLY`、`ADD COLUMN` の生成列、`SET CONSTRAINTS`、upsert の `RETURNING`、PostgreSQL の照合演算子。UI（列プロファイル・ER 図）も含む |
| `test-suite-v26.js` | 115 | v1.21 の GROUP BY 結果へのウィンドウ関数、列レベル `COLLATE` の実効化（比較・`IN`・`BETWEEN`・`ORDER BY`・`GROUP BY`・`DISTINCT`・`UNIQUE`・索引経路の回避）、`ORDER BY ALL` / `GROUPING_ID`、`ALTER COLUMN ... SET DATA TYPE` / `TYPE ... USING`、`RENAME CONSTRAINT`、`INSERT ... OVERRIDING VALUE`、`JOIN LATERAL ... ON TRUE`、1 始まりの添字とスライス、文単位の警告と `SHOW WARNINGS`。UI（エディタタブ、警告のコンソール出力）も含む |
| `test-suite-v25.js` | 110 | v1.20 の連結系集計の引数内 `ORDER BY`、`ORDER BY` のウィンドウ関数、`UPDATE`/`DELETE` の派生表ソース、SELECT 句の集合返し関数、`DIV` 演算子、`CREATE DOMAIN`/`TYPE AS ENUM`、ユーザー・ロール、`TRUNCATE CONTINUE IDENTITY`、再帰CTE の `SEARCH`/`CYCLE`、`IN` のインデックス活用、定数列の命名。UI（行追加・削除、クエリ履歴パネル）も含み、行削除のキー値がバインドされることを検査する |

セキュリティテストは「攻撃者が制御できる文字列」を 28 種類用意し、10 通りの入口（`?` バインド / 名前付きバインド / `insert` / `update` / `select` / `remove` / `prepare` / SQL プリペアド / `WHERE` / `LIKE`）へ総当たりで流し込み、**(a) JS として実行されない・(b) SQL の構造が変わらない・(c) 値としてそのまま往復する** の 3 点を毎回検査します。

パフォーマンステストは、まず 20,000 行のスキャン 1 回を実測して基準値に較正し、以降の予算をその倍数で表します。実行環境の速さによる偽陽性を避けつつ、`O(n) → O(n^2)` のような劣化を確実に検出できます。較正が一緒に緩むケースに備えて、絶対値の上限（例: 20,000 行スキャンが 300ms 未満）も併せて固定しています。

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
