// ============================================================================
// [Package entry] - `import` でエンジンを使う
//
// 実体は dist/luminadb.mjs（js/engine/*.js から生成した 1 本のモジュール）。
// バンドラ（Vite / webpack / esbuild）からも、Node / Bun からも、ブラウザの
// <script type="module"> からも、同じものを読める。
//
//     import { createDatabase } from 'luminadb';
//     const db = createDatabase();
//     db.executeQuery("CREATE TABLE t (id INTEGER, name TEXT)");
//     db.executeQuery("INSERT INTO t VALUES (1, 'a')");
//     console.log(db.executeQuery('SELECT * FROM t').data);
//
// ブラウザで画面ごと使う場合は従来どおり LuminaDB.html を開く（<script> 読み込み・
// ビルド不要）。生成物の作り直しは `bun tools/build-esm.mjs`。
// ============================================================================
export { DatabaseEngine, Table, LUMINA_VERSION, createDatabase } from './dist/luminadb.mjs';
export { default } from './dist/luminadb.mjs';
