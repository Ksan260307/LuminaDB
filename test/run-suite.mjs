// スイートを 1 本だけ回す高速ランナー（DOM / IndexedDB 不要）。
//
//   bun test/run-suite.mjs v51            … js/tests/test-suite-v51.js の getV51Tests()
//   bun test/run-suite.mjs v51 v52 v53    … まとめて（それぞれ別のエンジンで）
//   bun test/run-suite.mjs all            … SQL だけで完結するスイートを全部
//   bun test/run-suite.mjs v43 --slow 50  … 50ms を超えたテストも並べる
//
// エンジン群と js/tests/test-helpers.js を連結して**単一の間接 eval** で読み込み、
// getVxxTests() が返すテストを test-suite.js の実行ループと同じ判定（sql+check / fn）で回す。
// DOM や IndexedDB に触るスイート（v14 など）はここでは回せない。最終確認は必ず
// `bun test/browser-test.mjs`（実ブラウザ）で行うこと。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = ['table.js', 'engine-core.js', 'engine-expression.js', 'engine-subquery.js',
                'engine-select.js', 'engine-dml.js', 'engine-ddl.js', 'engine-transaction.js',
                'engine-io.js'];
// SQL だけで完結する（DOM / IndexedDB に触らない）スイート
const SQL_ONLY = ['v13', 'v15', 'v16', 'v34', 'v36', 'v37', 'v38', 'v39', 'v40', 'v41', 'v42',
                  'v43', 'v44', 'v45', 'v46', 'v47', 'v48', 'v49', 'v50',
                  'v51', 'v52', 'v53', 'v54', 'v55', 'v56',
                  'v57', 'v58', 'v59', 'v60', 'v61', 'v62', 'v65', 'v66', 'v67', 'v68', 'v69', 'v70', 'v71'];

const argv = process.argv.slice(2);
const slowAt = (() => {
  const i = argv.indexOf('--slow');
  return i === -1 ? 150 : Number(argv[i + 1]);
})();
const names = argv.filter(a => !a.startsWith('--') && !/^\d+$/.test(a));
const suites = names.length === 0 ? ['all'] : names;
const targets = suites.includes('all') ? SQL_ONLY : suites;

// DOM を使わないが、一部のコードが window / document を触ることがあるので最小スタブ
globalThis.window = globalThis;
globalThis.self = globalThis;
if (!globalThis.document) {
  globalThis.document = {
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
    getElementById: () => null, addEventListener() {}, body: { appendChild() {} }
  };
}

let failedTotal = 0, ranTotal = 0;
for (const name of targets) {
  const ver = String(name).replace(/^v/i, '');
  const file = join(ROOT, 'js/tests', `test-suite-v${ver}.js`);
  const getter = `getV${ver}Tests`;

  let src = '';
  for (const f of ENGINE) src += readFileSync(join(ROOT, 'js/engine', f), 'utf8') + '\n;\n';
  src += readFileSync(join(ROOT, 'js/tests/test-helpers.js'), 'utf8') + '\n;\n';
  try {
    src += readFileSync(file, 'utf8') + '\n;\n';
  } catch (e) {
    console.error(`[${name}] スイートが見つからない: ${file}`);
    failedTotal++;
    continue;
  }
  src += `globalThis.__mk = () => { globalThis.db = new DatabaseEngine(); return ${getter}; };\n`;

  const ev = eval;
  try { ev(src); } catch (e) { console.error(`[${name}] LOAD ERROR:`, e.message); failedTotal++; continue; }

  let tests;
  try { tests = globalThis.__mk()(); } catch (e) { console.error(`[${name}] ${getter}() が失敗:`, e.message); failedTotal++; continue; }

  let passed = 0;
  const fails = [], slow = [];
  const T0 = Date.now();
  for (const t of tests) {
    let status = 'FAIL', errMsg = '', time = 0;
    const start = performance.now();
    try {
      if (t.sql !== undefined && t.sql !== null) {
        const res = db.executeQuery(t.sql);
        time = performance.now() - start;
        if (res.error && !t.isErrorExpected) errMsg = res.error;
        else if (t.check(res)) { status = 'PASS'; passed++; }
        else errMsg = res.error || 'Assertion failed or incorrect data returned';
      } else if (t.fn) {
        const res = await t.fn();
        time = performance.now() - start;
        if (res === true) { status = 'PASS'; passed++; }
        else errMsg = 'fn returned ' + JSON.stringify(res);
      }
    } catch (e) { errMsg = e.message; time = performance.now() - start; }
    if (status !== 'PASS') fails.push([t.name, errMsg]);
    if (time > slowAt) slow.push([t.name, time.toFixed(0)]);
  }
  ranTotal += tests.length;
  failedTotal += fails.length;
  const mark = fails.length ? 'FAIL' : 'PASS';
  console.log(`${mark}  ${name.padEnd(4)}  ${passed} / ${tests.length}  (${Date.now() - T0}ms)`);
  for (const [n, e] of fails.slice(0, 40)) console.log(`      [FAIL] ${n} :: ${e}`);
  if (fails.length > 40) console.log(`      ... and ${fails.length - 40} more`);
  for (const [n, m] of slow.sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      [SLOW ${m}ms] ${n}`);
  }
}
console.log(`--- ${ranTotal} 件 / 失敗 ${failedTotal} 件`);
process.exit(failedTotal ? 1 : 0);
