# LuminaDB テスト実行

LuminaDB は 2000 件超の自己完結テスト（`js/tests/test-suite*.js`）を持つ。実行経路は2つ。

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

## 2. ブラウザ UI から手動実行

`LuminaDB.html` を開き、クエリ欄に `runtest` と入力して実行（または `runTestSuite()` を直接呼ぶ）。
結果は `currentResultData`（TestName / Status / Error）とトーストに出る。

## 3. bun スタブ版ハーネス（高速な事前チェック・低信頼）

開発中の素早い回帰確認用。DOM/IndexedDB/postMessage 等をスタブ化するため、
それらに依存する約 41 件は「既知失敗」として `EXPECTED_FAIL` で除外される。
**最終確認は必ず経路 1（実ブラウザ）で行うこと。**
（ハーネス本体は各セッションのスクラッチパッドに `run-all.js` として置かれる）
