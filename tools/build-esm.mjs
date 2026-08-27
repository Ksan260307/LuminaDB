// dist/luminadb.mjs を組み立てる。
//
// エンジンは素のスクリプト（トップレベルの class 宣言）で、ブラウザからは
// <script> で読み込む。この形は「ビルド不要」というこのプロジェクトの前提そのもの
// なので変えていない。一方バンドラ（Vite / webpack / esbuild）は `import` できる
// 1 本のモジュールを欲しがるので、ここで生成して置いておく。
//
// 生成物はリポジトリへコミットする。利用する側にビルド手順は要らない
// （このスクリプトは、エンジンを直したときに作り直すためのもの）。
//
//   bun tools/build-esm.mjs
//
// 中身は関数スコープで包むだけで、エンジンのコードには一切手を入れない。
// window / document / self はスコープ内の const として与えるので、
// 実行環境のグローバルを書き換えない（ライブラリが勝手に汚さないため）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = [
    'table.js', 'engine-core.js', 'engine-expression.js', 'engine-subquery.js',
    'engine-select.js', 'engine-dml.js', 'engine-ddl.js', 'engine-transaction.js',
    'engine-io.js'
];

let body = '';
for (const f of ENGINE) {
    body += `\n// ---- js/engine/${f} ----\n` + readFileSync(join(ROOT, 'js/engine', f), 'utf8') + '\n';
}

const version = (readFileSync(join(ROOT, 'js/engine/engine-core.js'), 'utf8')
    .match(/LUMINA_VERSION\s*=\s*'([^']+)'/) || [, '0.0.0'])[1];

const out = `// ============================================================================
// LuminaDB ${version} — generated bundle. DO NOT EDIT.
//
// Rebuild with:  bun tools/build-esm.mjs
// Source of truth: js/engine/*.js
//
// Bundler- and browser-friendly ES module:
//     import { createDatabase } from 'luminadb';
//     const db = createDatabase();
//     db.executeQuery("CREATE TABLE t (id INT)");
// ============================================================================
const __lumina = (() => {
    // エンジンは DOM のある環境を前提に書かれている箇所がある。
    // グローバルを書き換えず、このスコープの中だけで名前を与える
    const __g = typeof globalThis !== 'undefined' ? globalThis : {};
    const window = __g;
    const self = __g;
    const document = __g.document || {
        createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
        getElementById: () => null,
        addEventListener() {},
        head: { appendChild() {} },
        body: { appendChild() {} }
    };
${body}
    return { DatabaseEngine, Table, LUMINA_VERSION };
})();

export const DatabaseEngine = __lumina.DatabaseEngine;
export const Table = __lumina.Table;
export const LUMINA_VERSION = __lumina.LUMINA_VERSION;

/**
 * 新しいインメモリのデータベースを作る。
 * @param {{ statementTimeoutMs?: number, readOnly?: boolean }} [options]
 */
export function createDatabase(options = {}) {
    const db = new __lumina.DatabaseEngine();
    if (options.statementTimeoutMs !== undefined) {
        db.statementTimeoutMs = Math.max(0, Math.trunc(Number(options.statementTimeoutMs) || 0));
    }
    if (options.readOnly !== undefined) db.readOnly = !!options.readOnly;
    return db;
}

export default { createDatabase, DatabaseEngine, Table, LUMINA_VERSION };
`;

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/luminadb.mjs'), out, 'utf8');
console.log(`dist/luminadb.mjs written (${(out.length / 1024).toFixed(0)} KB, LuminaDB ${version})`);
