// ============================================================================
// css/tailwind.css を組み立てる（Tailwind CDN を外すための生成器）
//
// LuminaDB.html は見た目に Tailwind を使っているが、読み込み先が
// https://cdn.tailwindcss.com だった。あの CDN は「静的な CSS」ではなく
// 実行時にクラス名を見て CSS を作る JIT コンパイラなので、単に落としてくる
// ことができない。「依存ゼロ・オフラインで完結」を掲げているのに、
// 初回表示にネットワークが要り、file:// や社内閉域網・厳しい CSP で崩れていた。
//
// ここでは実ブラウザ（ヘッドレス）で 1 度だけ CDN を動かし、
//   1. ソースから集めたクラス名を全部ぶつけて JIT に規則を作らせ
//   2. 生成された стylesheet を丸ごと取り出して
//   3. css/tailwind.css として書き出す
// という手順を自動化する。生成物はコミットするので、利用者側にビルドは要らない。
//
//   bun tools/build-tailwind.mjs
//
// クラス名を新しく使い始めたら、このスクリプトを回し直すこと
// （回し忘れるとその要素だけ素のまま表示される）。候補の一覧は
// tools/tailwind-classes.json に出るので、差分を見れば気づける。
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8802;
const DEBUG_PORT = PORT + 1000;
const PAGE = `http://localhost:${PORT}/LuminaDB.html`;

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

// ---------------------------------------------------------------------------
// 1. ソースからクラス名の候補を集める
//    class="..." だけでなく、JS が classList や文字列で組む断片も拾う。
//    テストは画面の見た目に関係しないので除く
// ---------------------------------------------------------------------------
const UTIL = /^-?(?:[a-z][a-z0-9]*:)*[a-z][a-z0-9]*(?:-[a-z0-9./%[\]#()]+)*$/i;
const PREFIX = ['bg-', 'text-', 'border', 'rounded', 'p-', 'px-', 'py-', 'pt-', 'pb-', 'pl-', 'pr-', 'm-', 'mx-', 'my-',
    'mt-', 'mb-', 'ml-', 'mr-', 'w-', 'h-', 'min-', 'max-', 'flex', 'grid', 'gap-', 'items-', 'justify-', 'self-',
    'col-', 'row-', 'space-', 'divide-', 'font-', 'leading-', 'tracking-', 'shadow', 'opacity-', 'z-', 'top-',
    'bottom-', 'left-', 'right-', 'inset-', 'overflow', 'whitespace', 'truncate', 'absolute', 'relative', 'fixed',
    'sticky', 'hidden', 'block', 'inline', 'table', 'hover:', 'focus:', 'active:', 'disabled:', 'group-', 'sm:',
    'md:', 'lg:', 'xl:', 'cursor-', 'select-', 'pointer-', 'transition', 'duration-', 'ease-', 'transform',
    'translate-', 'scale-', 'rotate-', 'animate-', 'ring', 'outline', 'resize', 'list-', 'align-', 'order-',
    'backdrop-', 'filter', 'blur', 'object-', 'aspect-', 'float-', 'clear-', 'box-', 'appearance-', 'underline',
    'uppercase', 'lowercase', 'capitalize', 'antialiased', 'sr-only', 'placeholder', 'caret-', 'accent-', 'fill-',
    'stroke-', 'snap-', 'touch-', 'break-', 'indent-', 'italic', 'normal-', 'file:', 'last:', 'focus-within:'];

function collectClasses() {
    const found = new Set();
    const addWord = (w) => { if (UTIL.test(w) && w.length <= 60) found.add(w); };
    const scan = (text) => {
        for (const m of text.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]*)["'`]/g)) {
            for (const w of m[1].split(/\s+/)) if (w) addWord(w);
        }
        for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
            for (const s of m[1].matchAll(/["']([^"']+)["']/g)) {
                for (const w of s[1].split(/\s+/)) if (w) addWord(w);
            }
        }
        // テンプレートリテラルや連結で組まれる断片
        for (const m of text.matchAll(/["'`]([^"'`\n]{2,200})["'`]/g)) {
            const s = m[1];
            if (!s.includes('-') && !s.includes(':')) continue;
            for (const w of s.split(/\s+/)) {
                if (PREFIX.some(p => w.startsWith(p))) addWord(w);
            }
        }
    };
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            if (name === '.git' || name === 'node_modules' || name === 'tests' || name === 'dist' || name === '.claude') continue;
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { walk(p); continue; }
            if (/\.(html|js)$/.test(name)) scan(readFileSync(p, 'utf8'));
        }
    };
    walk(ROOT);
    return [...found].sort();
}

async function main() {
    const classes = collectClasses();
    mkdirSync(join(ROOT, 'tools'), { recursive: true });
    writeFileSync(join(ROOT, 'tools/tailwind-classes.json'), JSON.stringify(classes, null, 0) + '\n', 'utf8');
    console.log(`候補クラス ${classes.length} 個を集めました`);

    server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 30; i++) { try { if ((await fetch(PAGE)).ok) break; } catch {} await sleep(300); }

    profile = mkdtempSync(join(tmpdir(), 'luminadb-tw-'));
    browser = spawn(BROWSER, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json();
            target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (target) break;
        } catch {}
        await sleep(300);
    }
    if (!target) { console.error('ERROR: デバッグターゲットに接続できませんでした。'); process.exit(2); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws open timeout')), 10000); });
    let msgId = 0;
    const pending = new Map();
    const waiters = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== undefined && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        } else if (m.method) {
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].method === m.method) { waiters[i].resolve(m.params); waiters.splice(i, 1); }
            }
        }
    };
    const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, ms);
    });
    const waitEvent = (method, ms) => new Promise((resolve, reject) => {
        const w = { method, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); reject(new Error(method + ' timeout')); } }, ms);
    });

    await send('Page.enable');
    const loaded = waitEvent('Page.loadEventFired', 60000);
    await send('Page.navigate', { url: PAGE });
    await loaded;

    // 集めたクラスを全部ぶつけて JIT に規則を作らせ、生成された stylesheet を取り出す。
    // ページ自身の <style>（規則数が少ない方）は HTML に残るので混ぜない
    const EXPR = `(async () => {
        const classes = ${JSON.stringify(classes)};
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
        probe.className = classes.join(' ');
        document.body.appendChild(probe);
        await new Promise(r => setTimeout(r, 1500));
        let best = null;
        for (const s of Array.from(document.styleSheets)) {
            let rules; try { rules = s.cssRules; } catch (e) { continue; }
            if (!rules) continue;
            if (!best || rules.length > best.length) best = rules;
        }
        if (!best) return null;
        return Array.from(best).map(r => r.cssText).join('\\n');
    })()`;
    const res = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true }, 120000);
    if (res.exceptionDetails) { console.error('ERROR:', res.exceptionDetails.text); process.exit(2); }
    const css = res.result && res.result.value;
    if (!css || css.length < 5000) { console.error('ERROR: 生成された CSS が小さすぎます。'); process.exit(2); }
    ws.close();

    const header = `/* ============================================================================\n`
        + ` * Tailwind — generated. DO NOT EDIT.\n`
        + ` *\n`
        + ` * Rebuild with:  bun tools/build-tailwind.mjs\n`
        + ` * Covers the ${classes.length} utility classes used by LuminaDB.html and js/**.\n`
        + ` * New classes need a rebuild, or they will render unstyled.\n`
        + ` * ============================================================================ */\n`;
    mkdirSync(join(ROOT, 'css'), { recursive: true });
    writeFileSync(join(ROOT, 'css/tailwind.css'), header + css + '\n', 'utf8');
    console.log(`css/tailwind.css written (${(css.length / 1024).toFixed(0)} KB, ${css.split('\n').length} rules)`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
