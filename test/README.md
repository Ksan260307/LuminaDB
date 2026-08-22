# LuminaDB テスト実行

LuminaDB は 52,600 件超の自己完結テスト（`js/tests/test-suite*.js`）を持つ。実行経路は 3 つ。

| 経路 | コマンド | 何を見るか | 速さ |
|------|----------|-----------|------|
| 1. 実ブラウザ（推奨） | `bun test/browser-test.mjs` | 全件。DOM・IndexedDB・暗号化まで本物 | 数分 |
| 2. スイート単体 | `bun test/run-suite.mjs v51` | SQL だけで完結するスイート 1 本 | 1 秒前後 |
| 3. ブラウザ UI | クエリ欄に `runtest` | 全件（手元で目視） | 数分 |

開発中は **2 で素早く潰し、最後に 1 で確認する**。

## 1. 実ブラウザ・ヘッドレステスト（推奨・高信頼）

```
bun test/browser-test.mjs
```

本物の `LuminaDB.html` をヘッドレス Chrome/Edge で開き、Chrome DevTools Protocol の
`Runtime.evaluate(awaitPromise)` で `runTestSuite()` の完了を確実に待って結果を回収する。

- **DOM・IndexedDB・crypto.subtle・postMessage・clipboard がすべて本物** なので、
  UI・セキュリティ・暗号化永続化・外部 API まで含めて本番同様に検証できる。
- 終了コード: `0`=全パス / `1`=失敗あり / `2`=起動・回収エラー。CI に組み込める。
- ポート指定: `bun test/browser-test.mjs 8801`（既定 8801。デバッグは +1000 番）。
- Chrome または Edge が必要（自動検出）。静的サーバー（`python -m http.server`）は自動起動・停止。

`?autotest=1` フック（`js/main.js`）: このパラメータ付きで開くと保存データを読まずに
全テストを走らせ、結果を `#autotest-result` に base64 で書き出す。CDP ランナーとは独立の
フォールバック経路（`--dump-dom` でも回収可能）。通常起動には一切影響しない。

## 2. スイート単体ランナー（開発中の素早い確認）

```
bun test/run-suite.mjs v51             # js/tests/test-suite-v51.js の getV51Tests()
bun test/run-suite.mjs v51 v52 v53     # まとめて（それぞれ別のエンジンで）
bun test/run-suite.mjs all             # SQL だけで完結するスイートを全部
bun test/run-suite.mjs v43 --slow 50   # 50ms を超えたテストも並べる
```

エンジン群と `js/tests/test-helpers.js` を連結して**単一の間接 eval** で読み込み、
`getVxxTests()` が返すテストを `test-suite.js` の実行ループと同じ判定（`sql`+`check` / `fn`）で回す。
DOM・IndexedDB に触るスイート（v14 など）は対象外。失敗一覧と遅いテストを出し、
終了コードは `0`=全パス / `1`=失敗あり。

新しいスイートは**まずこれで単体で回してから**全体（経路 1）へ回すこと。
総当たり系は行数に比例して重くなるので、遅いテストが出たらフィクスチャの行数を削る。

## 3. ブラウザ UI から手動実行

`LuminaDB.html` を開き、クエリ欄に `runtest` と入力して実行（または `runTestSuite()` を直接呼ぶ）。
結果は `currentResultData`（TestName / Status / Error）とトーストに出る。

---

## スイートの書き方

テストは 2 つの形のどちらか。`test-suite.js` の実行ループが両方を扱う。

```js
{ name: '...', sql: 'SELECT ...', check: r => r.data[0].n === 3 }  // SQL + 判定
{ name: '...', fn: () => { ...; return true; } }                   // 関数（true で成功）
```

共通の道具立ては [`js/tests/test-helpers.js`](../js/tests/test-helpers.js) の `makeTestKit()` にある。

```js
function getV57Tests() {
  const { T, q, t, same, err, upper, spaced, wsPos, swap, tag,
          insertRows, drop, cleanup } = makeTestKit('V57');

  t('V57 fixture', () => { drop('v57_t'); q('CREATE TABLE v57_t (...)'); insertRows('v57_t', rows); return true; });
  same('V57A 大文字で書いても同じ', BASE_SQL, upper(BASE_SQL));   // 基準と変種の突き合わせ
  err('V57H この書き方は拒否される', 'SELECT ...', 'syntax');      // 拒否されるべき文
  cleanup('v57_t');                                               // 後片付け（表の残りも検査）
  return T;
}
```

66 本のスイートのうち 51 本がこれを使っている（残りは `{name, sql, check}` を並べるだけのもの）。
古いスイートは `const { T, check: push, err, t: fn } = makeTestKit('V20');` のように
**元の呼び名へ別名を付けて**受け取っているので、本文はそのまま読める。

**テストの登録**

- `t(name, fn)` … 関数で書くテスト（`true` を返せば成功）。旧 `fn`
- `check(name, sql, fn)` … SQL と判定関数。旧 `push`
- `ok(name, sql)` / `err(name, sql, frag)` … 通ればよい文 / 拒否されるべき文

**結果の取り出し**

- `rowsOf(sql)` / `valsOf(sql)` / `oneOf(sql)` … 行・値の並び・先頭 1 列（失敗は throw）。旧 `rows` / `one`
- `oneSafe` / `colSafe(sql, k)` / `idsSafe` / `keysSafe` … throw せず `{__err}` や `['ERR:...']` を返す版

**比較**

- `same(name, base, variant)` … 基準クエリの結果（キャッシュ済み）と変種の結果を突き合わせる。
  列名は書き方で変わり得るので**値の並びだけ**を比べる。
- `differs(name, a, b)` … 「同じに見えて同じではない」ことを仕様として記録する。
- `val(name, sql, want)` / `valNear(name, sql, want, eps)` … 1 行 1 列の値を直に確かめる。
- `eq` / `expect` / `expectNear` / `expectDeep` / `numEq` / `approx` … 値どうしの比較
  （`expect` は数値の最下位桁のずれを許す）。
- `mround(x, d)` … MySQL 互換 ROUND の JS 参照。

**模型（期待値）作りと後片付け**

- `sum` / `cnt` / `uniq` / `byKey` … JavaScript 側で集計の期待値を組むための小道具。
- `outside(sql, f)` … **文字列リテラルの外側だけ**を変換する（`'HR'` が `'hr'` にならないように）。
  `upper` / `lower` / `alternating` / `spaced(sql, sep)` はこの上に載っている。
- `wsPos(sql)` / `swap(sql, i, text)` … 空白 1 個ずつを改行やコメントへ差し替える総当たり用。
- `insertRows(table, rows)` / `lit(v)` / `drop(...)` / `cleanup(...)` … フィクスチャの組み立てと片付け
  （NULL と引用符の扱いを 1 か所へ寄せてある）。
- `canaryClean()` … セキュリティテスト用。接頭辞から `__v20_pwned` 等の印を組み立てて汚染が無いことを見る。

意図して違う実装を持つもの（v16 の `sum`、v23 の `val`、v35 の `col`、v40 の `expectNear` など）は
各スイートに残してある。kit と紛らわしくなるので、**同じ名前で違う意味のものを足さないこと**。

### 配列リテラルで書くスイート

`test-suite.js` や `test-suite-v2.js` 〜 `v12.js` は `return [ ... ]` に定義を並べる形で、
`makeTestKit` を使わない。定型のものは同じ `test-helpers.js` にある**工場関数**で書ける。

```js
return [
  { name: '...', sql: 'SELECT ...', check: r => r.data[0].c === 3 },   // 個別の判定はそのまま
  errCase('... は拒否される', 'SELECT ...', 'syntax'),                  // 拒否されるべき文
  successCase('表を作る', 'CREATE TABLE ...'),                          // Result: 'Success' を返す文
  okCase('通ればよい', 'PRAGMA table_list'),                            // エラーで無ければよい
  valCase('1 行 1 列の値', "SELECT 1 + 1 AS r", 2),                     // 先頭列の値を比べる
];
```

`errCase` の第 3 引数はエラー文に含まれるべき語（大小文字は無視）。
`makeTestKit` の `err` / `ok` も同じ実装を共有しているので、どちらの書き方でも判定は揃う。

新しいスイートを足したら 3 か所へ登録する:

1. `js/tests/test-suite.js` の `tests` 配列へ `...getV57Tests(),` を追加
2. `LuminaDB.html` に `<script src="js/tests/test-suite-v57.js?v=1"></script>` を追加
3. `test/run-suite.mjs` の `SQL_ONLY` へスイート名を追加（DOM 非依存なら）
