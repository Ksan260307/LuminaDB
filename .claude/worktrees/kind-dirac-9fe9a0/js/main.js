    // ============================================================================
    // [Main] - 起動時の自動読み込み / ヘッドレステストランナー用フック
    // ============================================================================

    // ?autotest=1 付きで開かれた場合は、保存データを読み込まずに全テストを実行し、
    // 結果 JSON を #autotest-result へ書き出す。ヘッドレスブラウザ（--dump-dom）が
    // これを回収して CI 的に pass/fail を判定する。通常起動には一切影響しない。
    (function bootstrap() {
        const isAutoTest = (typeof location !== 'undefined') && /[?&]autotest=1\b/.test(location.search || '');

        // 表示言語を適用する（既定は日本語。選択は localStorage に残る）。
        // 画面を組み立てる前に一度当てておかないと、英語表示のまま開いても
        // 最初の 1 フレームだけ日本語が見えてしまう
        if (typeof initI18n === 'function') initI18n();

        if (isAutoTest) {
            (async function runAutoTest() {
                const el = document.createElement('pre');
                el.id = 'autotest-result';
                document.body.appendChild(el);
                // DOM ダンプ時の HTML エスケープで壊れないよう base64 で書き出す
                const write = (obj) => {
                    const json = JSON.stringify(obj);
                    el.textContent = 'AUTOTEST_B64:' + btoa(unescape(encodeURIComponent(json)));
                };
                try {
                    await runTestSuite();
                    const data = (typeof currentResultData !== 'undefined' && currentResultData) ? currentResultData : [];
                    const fails = data.filter(r => r.Status !== 'PASS');
                    write({
                        ok: fails.length === 0,
                        version: (typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '?'),
                        total: data.length,
                        pass: data.length - fails.length,
                        fails: fails.map(f => ({ name: f.TestName, error: f.Error })).slice(0, 100)
                    });
                } catch (e) {
                    write({ ok: false, error: String((e && e.message) || e) });
                }
            })();
            return;
        }

        (async function autoLoad() {
            try {
                const dump = await loadDB();
                if (dump) {
                    db.importFromIDB(dump);
                    renderTree();
                    els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">Auto-loaded previous session data.</div>`;
                }
            } catch (e) {
                console.error("Auto-load error:", e);
                // 復号失敗などをユーザーへ通知する（黙って初期データで起動すると気づけないため）
                if (typeof showToast === 'function') showToast(i18nT('自動読み込みに失敗しました: {0}', e.message), true);
            }
        })();
    })();
