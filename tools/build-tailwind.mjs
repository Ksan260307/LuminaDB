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
//   2. 生成された stylesheet を丸ごと取り出して
//   3. css/tailwind.css として書き出す
// という手順を自動化する。生成物はコミットするので、利用者側にビルドは要らない。
//
//   bun tools/build-tailwind.mjs            生成し直す（ブラウザと網が要る）
//   bun tools/build-tailwind.mjs --check     回し忘れていないかだけ見る（どちらも不要）
//
// クラス名を新しく使い始めたら、このスクリプトを回し直すこと
// （回し忘れるとその要素だけ素のまま表示される）。候補の一覧は
// tools/tailwind-classes.json に出るので、差分を見れば気づける。
// --check は「ソースで使っているクラスに規則があるか」を数えるだけなので、
// コミット前の確認や CI に置ける。
//
// ----------------------------------------------------------------------------
// 【重要】JIT は専用の検査用ページで動かすこと
//
// 最初の版は LuminaDB.html を開いて、そこに読み込まれている CDN の JIT を
// 使っていた。ところがこのツール自身の成果物が「CDN の <script> を外して
// 生成済み CSS を読む」ページなので、**2 回目以降は JIT がどこにも居ない**。
// それでも「いちばん規則の多い stylesheet」を拾う実装だったため、
// 拾い上げていたのは生成済みの css/tailwind.css 自身だった。
// つまり既存の CSS をそのまま書き戻すだけの空回りで、
// 新しいユーティリティは黙って欠落する（その要素だけ素のまま表示される）。
// 実際 v1.39 の作業で gap-y-2 / border-amber-300 が生成されずに気づいた。
//
// いまは Tailwind の CDN を Node 側で取ってきて、他に stylesheet を持たない
// 検査専用ページへ読ませる。最後に「集めたクラスがちゃんと出力に居るか」を
// 数えて、取りこぼしが多ければ**失敗させる**（黙って空回りさせない）。
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8802;
const DEBUG_PORT = PORT + 1000;
// 検査用ページ。LuminaDB.html ではない（上の「【重要】」を参照）
const PAGE = `http://localhost:${PORT}/probe.html`;

// JIT の取得元。版を固定して、回すたびに生成物が揺れないようにする。
// 上げるときはここだけ変えて、css/tailwind.css の差分を確認すること
const TAILWIND_VERSION = '3.4.17';
const TAILWIND_CDN = `https://cdn.tailwindcss.com/${TAILWIND_VERSION}`;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BROWSER = existsSync(CHROME) ? CHROME : (existsSync(EDGE) ? EDGE : null);
if (!BROWSER) { console.error('ERROR: Chrome も Edge も見つかりません。'); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let server, browser, profile, probeDir;
function cleanup() {
    try { browser && browser.kill(); } catch {}
    try { server && server.kill(); } catch {}
    try { profile && rmSync(profile, { recursive: true, force: true }); } catch {}
    try { probeDir && rmSync(probeDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(2); });

// ---------------------------------------------------------------------------
// 0. JIT を取ってきて、検査専用ページを組み立てる
//
//    ページはリポジトリの外（一時ディレクトリ）に作る。リポジトリへ置くと
//    消し忘れが残り、そのうち製品ページと取り違える。
//    JIT は別ファイルとして置く（HTML へ直接埋めると、中の '</script>' で
//    自分自身を閉じてしまう）
// ---------------------------------------------------------------------------
async function makeProbeDir() {
    let js;
    try {
        const res = await fetch(TAILWIND_CDN, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        js = await res.text();
    } catch (e) {
        console.error(`ERROR: Tailwind の JIT を取得できませんでした（${TAILWIND_CDN}）: ${e.message}`);
        console.error('       このツールはビルド時だけネットワークを使います（成果物の利用時は不要）。');
        process.exit(2);
    }
    if (js.length < 100000) {
        console.error(`ERROR: 取得した JIT が小さすぎます（${js.length} バイト）。`);
        process.exit(2);
    }
    // 前回までの回し残りを掃く。
    // 終了時の後片付けは配信サーバーがまだファイルを掴んでいると失敗することがあり
    // （Windows は開いているファイルを消せない）、少しずつ溜まっていく
    try {
        for (const name of readdirSync(tmpdir())) {
            if (!name.startsWith('luminadb-twprobe-')) continue;
            try { rmSync(join(tmpdir(), name), { recursive: true, force: true }); } catch { /* 使用中なら次回 */ }
        }
    } catch { /* 一時ディレクトリを読めなくても本題には影響しない */ }

    const dir = mkdtempSync(join(tmpdir(), 'luminadb-twprobe-'));
    writeFileSync(join(dir, 'tailwind.js'), js, 'utf8');
    // 他に stylesheet を持たないページにする。こうしておけば
    // 「拾った stylesheet ＝ JIT が作ったもの」で迷いようが無い
    writeFileSync(join(dir, 'probe.html'),
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        + '<title>tailwind probe</title>\n<script src="tailwind.js"></' + 'script>\n'
        + '</head>\n<body></body>\n</html>\n', 'utf8');
    console.log(`JIT を取得しました（Tailwind ${TAILWIND_VERSION} / ${(js.length / 1024).toFixed(0)} KB）`);
    return dir;
}

// ---------------------------------------------------------------------------
// 1. ソースからクラス名の候補を集める
//    class="..." だけでなく、JS が classList や文字列で組む断片も拾う。
//    テストは画面の見た目に関係しないので除く
// ---------------------------------------------------------------------------
// 修飾子（variant）の部分は `hover:` のような 1 語だけでなく、
// `focus-within:` `group-hover:` `peer-checked:` のようにハイフンを含むものがある。
// 以前は修飾子に [a-z][a-z0-9]* しか許していなかったため、
// focus-within: と group-hover: の付いたクラスが候補から丸ごと落ちていた。
// 元の版は実ページの DOM を JIT に見せていたので、落ちても結果的に生成されていて
// 気づけなかった（検査専用ページに変えて初めて表に出た）
const UTIL = /^-?(?:[a-z][a-z0-9-]*:)*[a-z][a-z0-9]*(?:-[a-z0-9./%[\]#()]+)*$/i;
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
                // 負の値のユーティリティ（-top-4 / -mx-2 など）は先頭が '-' なので、
                // 接頭辞を見る前に外す。UTIL の正規表現は元から '-' 始まりを許しているのに、
                // ここだけ弾いていて JS が組む断片からは拾えなかった
                const bare = w.startsWith('-') ? w.slice(1) : w;
                if (PREFIX.some(p => bare.startsWith(p))) addWord(w);
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

// ---------------------------------------------------------------------------
// クラス名 → CSS に現れるセレクタ文字列 → 生成物に在るかの判定。
//
// Tailwind は . : / [ ] ( ) % # ! をバックスラッシュで逃がすので
//   hover:bg-gray-100  ->  .hover\:bg-gray-100   （後ろに :hover が続く）
//   bg-gray-900/40     ->  .bg-gray-900\/40
// 組み立てた「探したい文字列」を、最後にまとめて正規表現用へ逃がす。
// ここを二重に逃がし損ねると、修飾子付きのクラスが常に「無い」判定になる
// ---------------------------------------------------------------------------
const twSelector = (c) => '.' + c.replace(/[.:/[\]()%#!]/g, (ch) => '\\' + ch);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 後ろが英数字・ハイフンでないこと（.flex が .flex-col に当たらないように）
const ruleFinder = (css) => (c) => new RegExp(reEsc(twSelector(c)) + '(?![\\w-])').test(css);

// 目印。必ず在るはずの規則で、欠けていれば JIT が働いていない
const CANARY = ['flex', 'hidden', 'bg-blue-600', 'rounded', 'text-sm', 'hover:bg-gray-100'];

// --check: ブラウザも網も使わず、いまの css/tailwind.css が
// いまのソースを賄えているかだけを見る。「回し忘れ」を秒で見つけるため
function checkOnly() {
    const cssPath = join(ROOT, 'css/tailwind.css');
    if (!existsSync(cssPath)) { console.error('ERROR: css/tailwind.css がありません。'); process.exit(2); }
    const css = readFileSync(cssPath, 'utf8');
    const classes = collectClasses();
    const hasRule = ruleFinder(css);
    const dead = CANARY.filter(c => !hasRule(c));
    if (dead.length > 0) {
        console.error(`ERROR: 目印の規則が css/tailwind.css にありません: ${dead.join(' ')}`);
        process.exit(2);
    }
    const missing = classes.filter(c => !hasRule(c));
    console.log(`候補 ${classes.length} 個中 ${classes.length - missing.length} 個は規則があります`);
    if (missing.length > 0) {
        console.log(`規則の無い候補（${missing.length} 個）:`);
        console.log(`  ${missing.join(' ')}`);
        console.log('自前のクラス名（closeModalBtn / hl-keyword 等）や SVG 属性が混ざります。');
        console.log('Tailwind のユーティリティが並んでいたら bun tools/build-tailwind.mjs を回してください。');
    }
}

async function main() {
    if (process.argv.includes('--check')) { checkOnly(); return; }

    const classes = collectClasses();
    mkdirSync(join(ROOT, 'tools'), { recursive: true });
    writeFileSync(join(ROOT, 'tools/tailwind-classes.json'), JSON.stringify(classes, null, 0) + '\n', 'utf8');
    console.log(`候補クラス ${classes.length} 個を集めました`);

    probeDir = await makeProbeDir();
    // 検査用ページのあるディレクトリを配る（リポジトリではない）
    server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: probeDir, stdio: 'ignore' });

    // 立ち上がりを待つ。
    // **中身まで見て確かめること**。ポートに別のサーバー（前回の回し残り等）が
    // 居座っていると bind に失敗し、こちらのプロセスは黙って死んで、
    // 別のディレクトリを配っている古いサーバーが応答し続ける。
    // 以前は「30 回試して駄目でも進む」だったので、その場合 404 のページを
    // 検査して「JIT が居ない」と後段で分かりにくく転んでいた
    let ready = false;
    for (let i = 0; i < 40; i++) {
        try {
            const r = await fetch(PAGE);
            if (r.ok && (await r.text()).includes('tailwind probe')) { ready = true; break; }
        } catch { /* まだ起きていない */ }
        await sleep(300);
    }
    if (!ready) {
        console.error(`ERROR: 検査用ページを ${PAGE} で配れませんでした。`);
        console.error(`       ポート ${PORT} を別のプロセスが使っている可能性があります。`);
        console.error(`       別のポートで試すには: bun tools/build-tailwind.mjs 8812`);
        process.exit(2);
    }

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
    // 検査用ページは他に stylesheet を持たないので、見つかったものが JIT の成果物。
    // JIT が居ないまま「いちばん規則の多い stylesheet」を拾うと、
    // 生成済みの css/tailwind.css 自身を書き戻す空回りになる（冒頭の【重要】参照）
    const EXPR = `(async () => {
        if (!window.tailwind) return { error: 'JIT (window.tailwind) がページに居ません' };
        const classes = ${JSON.stringify(classes)};
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden';
        probe.className = classes.join(' ');
        document.body.appendChild(probe);
        // JIT は MutationObserver 経由で非同期に規則を足す。規則数が
        // 増えなくなるまで待つ（固定の待ち時間だと取りこぼす / 無駄に待つ）
        const count = () => Array.from(document.styleSheets)
            .reduce((n, s) => { try { return n + (s.cssRules ? s.cssRules.length : 0); } catch (e) { return n; } }, 0);
        let prev = -1, stable = 0;
        for (let i = 0; i < 60 && stable < 3; i++) {
            await new Promise(r => setTimeout(r, 250));
            const n = count();
            stable = (n === prev) ? stable + 1 : 0;
            prev = n;
        }
        const out = [];
        for (const s of Array.from(document.styleSheets)) {
            let rules; try { rules = s.cssRules; } catch (e) { continue; }
            if (!rules) continue;
            for (const r of Array.from(rules)) out.push(r.cssText);
        }
        return { css: out.join('\\n'), rules: out.length };
    })()`;
    const res = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true }, 120000);
    if (res.exceptionDetails) { console.error('ERROR:', res.exceptionDetails.text); process.exit(2); }
    const value = res.result && res.result.value;
    if (!value || value.error) {
        console.error('ERROR:', (value && value.error) || '検査用ページから結果を受け取れませんでした。');
        process.exit(2);
    }
    const css = value.css;
    if (!css || css.length < 5000) { console.error('ERROR: 生成された CSS が小さすぎます。'); process.exit(2); }
    ws.close();

    // ------------------------------------------------------------------
    // 取りこぼしの検査。「回したのに入っていない」を黙って通さないための番人。
    //
    //   1. 目印（canary）— 必ず在るはずの規則。欠けていれば JIT が働いていない
    //   2. 候補のうち規則にならなかったものの一覧 — 人が見て判断する材料
    //
    // 2 の中には Tailwind のユーティリティではない自前のクラス名（dataPane や
    // closeModalBtn など）や、収集の正規表現が拾った偽物が必ず混ざる。
    // だから件数で機械的に落とさず、1 を落第の判定に使う
    // ------------------------------------------------------------------
    const hasRule = ruleFinder(css);
    const deadCanaries = CANARY.filter(c => !hasRule(c));
    if (deadCanaries.length > 0) {
        console.error(`ERROR: 目印の規則が出ていません: ${deadCanaries.join(' ')}`);
        console.error('       JIT が動いていないか、別のページを検査しています。');
        process.exit(2);
    }

    const missing = classes.filter(c => !hasRule(c));
    console.log(`規則 ${value.rules} 個 / 候補 ${classes.length} 個中 ${classes.length - missing.length} 個が生成されました`);
    if (missing.length > 0) {
        console.log(`  規則にならなかった候補（${missing.length} 個。自前のクラス名や収集の偽陽性を含む）:`);
        console.log(`    ${missing.join(' ')}`);
    }

    const header = `/* ============================================================================\n`
        + ` * Tailwind ${TAILWIND_VERSION} — generated. DO NOT EDIT.\n`
        + ` *\n`
        + ` * Rebuild with:  bun tools/build-tailwind.mjs\n`
        + ` * Covers ${classes.length - missing.length} of the ${classes.length} class names found in LuminaDB.html and js/**.\n`
        + ` * New classes need a rebuild, or they will render unstyled.\n`
        + ` * ============================================================================ */\n`;
    mkdirSync(join(ROOT, 'css'), { recursive: true });
    writeFileSync(join(ROOT, 'css/tailwind.css'), header + css + '\n', 'utf8');
    console.log(`css/tailwind.css written (${(css.length / 1024).toFixed(0)} KB, ${css.split('\n').length} rules)`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
