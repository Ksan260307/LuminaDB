// ============================================================================
// LuminaDB 実ブラウザ・ヘッドレステストランナー (bun + Chrome DevTools Protocol)
//
// 本物の LuminaDB.html を実ブラウザ（ヘッドレス Chrome/Edge）で開き、CDP の
// Runtime.evaluate(awaitPromise) で runTestSuite() の完了を「確実に」待って結果を
// 取得する。DOM・IndexedDB・crypto.subtle・postMessage・clipboard がすべて本物なので、
// bun スタブ版ハーネスで「既知失敗」だった UI・セキュリティ系テストも本番同様に検証できる。
//
// 使い方:  bun test/browser-test.mjs
// 終了コード: 0=全パス / 1=失敗あり / 2=起動・回収エラー
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8801;
const DEBUG_PORT = PORT + 1000;
const URL = `http://localhost:${PORT}/LuminaDB.html`;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BROWSER = existsSync(CHROME) ? CHROME : (existsSync(EDGE) ? EDGE : null);
if (!BROWSER) { console.error('ERROR: Chrome も Edge も見つかりません。'); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let server, browser, profile;
function cleanup() {
    try { browser && browser.kill(); } catch {}
    try { server && server.kill(); } catch {}
    try { profile && rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(2); });

async function waitFor(fn, tries, delay) {
    for (let i = 0; i < tries; i++) {
        try { const v = await fn(); if (v) return v; } catch {}
        await sleep(delay);
    }
    return null;
}

async function main() {
    // 1) 静的サーバー起動（python -m http.server）
    server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: PROJECT_DIR, stdio: 'ignore' });
    const up = await waitFor(async () => (await fetch(URL)).ok, 30, 300);
    if (!up) { console.error('ERROR: 静的サーバーが起動しませんでした。'); process.exit(2); }

    // 2) ヘッドレスブラウザ起動（about:blank・リモートデバッグ有効）。
    //    URL を引数で渡すと接続前にナビゲーションが走りコンテキストが破棄されるため、
    //    起動後に CDP の Page.navigate で明示的に遷移し、読込完了を待ってから評価する。
    profile = mkdtempSync(join(tmpdir(), 'luminadb-test-'));
    browser = spawn(BROWSER, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });

    // 3) CDP ターゲット（ページ）の WebSocket URL を取得
    const target = await waitFor(async () => {
        const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json();
        return list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    }, 40, 300);
    if (!target) { console.error('ERROR: ブラウザのデバッグターゲットに接続できませんでした。'); process.exit(2); }

    // 4) CDP 接続。id ベースの request/response と、イベント購読を扱うディスパッチャ
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws open timeout')), 10000); });

    let msgId = 0;
    const pending = new Map();
    const eventWaiters = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method) {
            for (let i = eventWaiters.length - 1; i >= 0; i--) {
                if (eventWaiters[i].method === msg.method) { eventWaiters[i].resolve(msg.params); eventWaiters.splice(i, 1); }
            }
        }
    };
    const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, timeoutMs);
    });
    const waitEvent = (method, ms) => new Promise((resolve, reject) => {
        const w = { method, resolve };
        eventWaiters.push(w);
        setTimeout(() => { const i = eventWaiters.indexOf(w); if (i !== -1) { eventWaiters.splice(i, 1); reject(new Error(method + ' event timeout')); } }, ms);
    });

    // ページを読み込み、load イベント完了を待つ
    await send('Page.enable');
    const loaded = waitEvent('Page.loadEventFired', 60000);
    await send('Page.navigate', { url: URL });
    await loaded;

    // 5) awaitPromise で runTestSuite の完了を待って結果を取得
    const EXPR = `(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // テストは製品ページに同梱していないので、まず取り寄せる（js/tests/manifest.js）
        for (let i = 0; i < 300 && typeof loadTestSuites !== 'function'; i++) await wait(50);
        if (typeof loadTestSuites !== 'function') return { ok: false, error: 'loadTestSuites not loaded (js/tests/manifest.js)' };
        try { await loadTestSuites(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        if (typeof runTestSuite !== 'function') return { ok: false, error: 'runTestSuite not loaded' };
        await runTestSuite();
        const d = (typeof currentResultData !== 'undefined' && currentResultData) ? currentResultData : [];
        const fails = d.filter(r => r.Status !== 'PASS');
        return { ok: fails.length === 0, version: (typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '?'),
            total: d.length, pass: d.length - fails.length,
            fails: fails.map(f => ({ name: f.TestName, error: String(f.Error) })).slice(0, 100) };
    })()`;

    // 実行時間の上限。件数が増えるほど伸びるので広めに取る（既定 3 分では足りなくなった）
    const evalRes = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true }, 900000);
    if (evalRes.exceptionDetails) { console.error('RUN ERROR:', evalRes.exceptionDetails.text); process.exit(2); }
    const result = evalRes.result && evalRes.result.value;
    ws.close();

    // 6) 結果表示と終了コード
    if (!result) { console.error('ERROR: 結果が空でした。'); process.exit(2); }
    if (result.error) { console.error('RUN ERROR:', result.error); process.exit(2); }
    console.log(`LuminaDB v${result.version}  TOTAL: ${result.total}  PASS: ${result.pass}  FAIL: ${result.total - result.pass}  (real browser: DOM/IndexedDB/crypto/postMessage 本物)`);
    if (!result.ok) {
        console.log('--- failures ---');
        for (const f of result.fails) console.log(`[FAIL] ${f.name} :: ${f.error}`);
        process.exit(1);
    }
    console.log('ALL PASS ✓');
    process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
