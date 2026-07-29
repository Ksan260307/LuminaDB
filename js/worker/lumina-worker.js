// ============================================================================
// [Worker] - SQL エンジンをワーカースレッドで動かす
//
// ブラウザDB最大の弱点は「クエリが UI スレッドを止める」こと。statement_timeout は
// 暴走を切れるが、正当な重いクエリ（数十万行の集計・結合）の間は画面が固まったままになる。
// このワーカーはエンジン一式（DOM 非依存）を importScripts で読み込み、
// メインスレッドとは独立した DatabaseEngine インスタンスを持つ。
//
// メインスレッド側の窓口は js/api/api.js の LuminaDB.worker.*:
//   start() でこのファイルを起動 → sync() で現在のDBを転送 → query()/exec() を await
//   → 書き込んだ場合は pull() でメインスレッドへ書き戻す
//
// プロトコル: { id, op, ... } を受け、{ id, ok, result } / { id, ok:false, error } を返す
// ============================================================================
importScripts(
    '../engine/table.js',
    '../engine/engine-core.js',
    '../engine/engine-expression.js',
    '../engine/engine-subquery.js',
    '../engine/engine-select.js',
    '../engine/engine-dml.js',
    '../engine/engine-ddl.js',
    '../engine/engine-transaction.js',
    '../engine/engine-io.js'
);

// eslint-disable-next-line no-undef
let wdb = new DatabaseEngine();

const OPS = {
    // 単文クエリ。メインスレッドと同じ { data, executionTime, scannedRows } を返す
    query: (m) => wdb.executeQuery(String(m.sql)),
    // 複数文スクリプト
    exec: (m) => wdb.executeScript(String(m.sql)),
    // メインスレッドの状態を丸ごと受け取る（構造化複製で TypedArray もそのまま渡る）
    sync: (m) => { wdb.importFromIDB(m.dump); return { tables: Object.keys(wdb.tables).length }; },
    // ワーカー側の状態をメインスレッドへ返す
    dump: () => wdb.exportForIDB(),
    // 破棄して作り直す
    reset: () => { wdb = new DatabaseEngine(); return { ok: true }; },
    tables: () => wdb.executeQuery('SHOW TABLES'),
    // 文単位タイムアウト（ワーカー側にも独立して設定できる）
    timeout: (m) => { wdb.statementTimeoutMs = Math.max(0, Math.trunc(Number(m.ms) || 0)); return { timeout: wdb.statementTimeoutMs }; },
    readOnly: (m) => { wdb.readOnly = !!m.value; return { readOnly: wdb.readOnly }; },
    ping: () => ({ pong: true, version: (typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '?') })
};

self.onmessage = (e) => {
    const m = e.data || {};
    const id = m.id;
    if (!m.op || !OPS[m.op]) {
        self.postMessage({ id, ok: false, error: `Unknown worker op '${m.op}'.` });
        return;
    }
    try {
        const result = OPS[m.op](m);
        self.postMessage({ id, ok: true, result });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
    }
};
