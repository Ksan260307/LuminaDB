    // ============================================================================
    // [Console] - 画面左下の実行ログコンソール（表示/非表示を任意にトグル可能）
    //   実行したクエリ・行数・実行時間・エラー・システムイベントを時系列で記録する。
    //   query-runner の runQuery と showToast から logConsole() で書き込まれる。
    // ============================================================================
    (function () {
        const STORE_KEY = 'luminadb_console_visible';
        const MAX_ENTRIES = 300;
        let entries = [];
        let visible = false;

        const $ = (id) => document.getElementById(id);
        const pad2 = (n) => String(n).padStart(2, '0');
        const nowStr = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

        const typeClass = (type) => ({
            error: 'text-red-400',
            success: 'text-green-400',
            query: 'text-sky-400',
            warn: 'text-amber-400',
            info: 'text-gray-300'
        }[type] || 'text-gray-300');

        const typeLabel = (type) => ({
            error: 'ERR', success: 'OK ', query: 'SQL', warn: 'WRN', info: 'LOG'
        }[type] || 'LOG');

        function render() {
            const body = $('consoleBody');
            if (!body) return;
            if (entries.length === 0) {
                body.innerHTML = `<div class="text-gray-600 italic">${i18nT('ログはまだありません。クエリを実行すると記録されます。')}</div>`;
            } else {
                body.innerHTML = entries.map((e, i) => {
                    const detail = e.detail ? ` <span class="text-gray-500">— ${escapeHtml(e.detail)}</span>` : '';
                    // SQL を持つ行はクリックでエディタへ再読込できる
                    const attrs = e.sql
                        ? ` data-cidx="${i}" title="${i18nT('クリックでエディタに読込')}" class="leading-relaxed whitespace-pre-wrap break-words cursor-pointer hover:bg-gray-800 rounded px-1 -mx-1"`
                        : ` class="leading-relaxed whitespace-pre-wrap break-words"`;
                    return `<div${attrs}>`
                        + `<span class="text-gray-600">${e.time}</span> `
                        + `<span class="${typeClass(e.type)} font-semibold">[${typeLabel(e.type)}]</span> `
                        + `<span class="${typeClass(e.type)}">${escapeHtml(e.msg)}</span>${detail}</div>`;
                }).join('');
            }
            body.scrollTop = body.scrollHeight;
            const cnt = $('consoleCount');
            if (cnt) cnt.textContent = String(entries.length);
        }

        // ランチャーは「何件あるか」ではなく「何が起きたか」を出す。
        //
        // WHERE なしの UPDATE / DELETE は NO_WHERE 警告を出しており、
        // その警告はちゃんとここへ届いていた。ところがパネルは既定で閉じていて、
        // ランチャーは通常ログ 5 件でもエラーでも全行削除でも同じ濃いグレーのまま
        // （変わるのは数字だけ）だったので、**誰も見ていない場所にだけ**出ていた。
        // 未読のエラー・警告があるあいだは色と件数でそれを示す
        let seenCount = 0;
        function unseen() {
            const rest = entries.slice(seenCount);
            return {
                errors: rest.filter(e => e.type === 'error').length,
                warns: rest.filter(e => e.type === 'warn').length
            };
        }
        function updateBadge() {
            const badge = $('consoleBadge');
            const launcher = $('consoleLauncher');
            const { errors, warns } = unseen();
            if (badge) {
                badge.textContent = errors > 0 ? String(errors) : (warns > 0 ? String(warns) : String(entries.length));
                badge.className = 'text-[10px] px-1.5 py-0.5 rounded-full min-w-[1.25rem] text-center '
                    + (errors > 0 ? 'bg-red-500 text-white'
                       : warns > 0 ? 'bg-amber-400 text-amber-900'
                       : 'bg-gray-700 text-gray-400');
            }
            if (launcher) {
                launcher.className = 'fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 text-xs font-medium pl-3 pr-2.5 py-2 rounded-full shadow-lg border transition-colors '
                    + (visible ? 'hidden ' : '')
                    + (errors > 0 ? 'bg-red-700 hover:bg-red-600 text-red-50 border-red-500'
                       : warns > 0 ? 'bg-amber-600 hover:bg-amber-500 text-amber-50 border-amber-400'
                       : 'bg-gray-800 hover:bg-gray-700 text-gray-100 border-gray-700');
                launcher.title = errors > 0 ? i18nT('エラー {0} 件（クリックで開く）', errors)
                    : warns > 0 ? i18nT('警告 {0} 件（クリックで開く）', warns)
                    : i18nT('コンソールを開く (Ctrl+`)');
            }
        }

        function setVisible(v) {
            visible = v;
            const panel = $('consolePanel');
            const launcher = $('consoleLauncher');
            if (panel) panel.classList.toggle('hidden', !v);
            if (launcher) launcher.classList.toggle('hidden', v);
            try { localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (e) { /* private mode 等は無視 */ }
            // 開いた時点で未読は解消（閉じている間に増えた分だけを色で示す）
            if (v) { seenCount = entries.length; render(); }
            updateBadge();
        }

        // 他モジュールから記録するためのグローバル関数（sql を渡すとクリックで再読込可能に）
        window.logConsole = function (type, msg, detail, sql) {
            entries.push({ time: nowStr(), type: type || 'info', msg: msg == null ? '' : String(msg), detail: detail == null ? '' : String(detail), sql: sql != null ? String(sql) : '' });
            if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
            if (visible) { seenCount = entries.length; render(); }
            updateBadge();
        };
        window.clearConsole = function () { entries = []; seenCount = 0; render(); updateBadge(); };

        // --- ワイヤリング（DOM は本スクリプトより前に定義済み。他UIモジュールと同じ即時初期化） ---
        const launcher = $('consoleLauncher');
        const closeBtn = $('consoleCloseBtn');
        const clearBtn = $('consoleClearBtn');
        const copyBtn = $('consoleCopyBtn');
        const bodyEl = $('consoleBody');
        if (launcher) launcher.addEventListener('click', () => setVisible(true));
        if (closeBtn) closeBtn.addEventListener('click', () => setVisible(false));
        if (clearBtn) clearBtn.addEventListener('click', () => window.clearConsole());

        // ログ全体をクリップボードへコピー
        if (copyBtn) copyBtn.addEventListener('click', () => {
            const text = entries.map(e => `${e.time} [${typeLabel(e.type)}] ${e.msg}${e.detail ? ' — ' + e.detail : ''}`).join('\n');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => showToast(i18nT('ログをコピーしました。'))).catch(() => showToast(i18nT('コピーに失敗しました。'), true));
            } else {
                showToast(i18nT('この環境ではコピーできません。'), true);
            }
        });

        // ログ行のクリックで元クエリをエディタへ読み込む（イベント委譲）
        if (bodyEl) bodyEl.addEventListener('click', (e) => {
            const line = e.target.closest('[data-cidx]');
            if (!line) return;
            const entry = entries[+line.getAttribute('data-cidx')];
            if (entry && entry.sql && typeof els !== 'undefined' && els.query) {
                // setQueryValue はエディタタブへの反映も行う（未定義環境では直接代入に落とす）
                if (typeof setQueryValue === 'function') setQueryValue(entry.sql);
                else els.query.value = entry.sql;
                if (typeof updateHighlight === 'function') updateHighlight();
                els.query.focus();
                showToast(i18nT('コンソールのクエリをエディタに読み込みました。'));
            }
        });

        // Ctrl+` でトグル
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); setVisible(!visible); }
        });

        // showToast をラップしてシステムメッセージもコンソールへ流す（テスト実行中は抑制）
        if (typeof showToast === 'function') {
            const __origShowToast = showToast;
            // 引数はそのまま素通しすること。action（「元に戻す」ボタン）を
            // 落としてしまうと、押せるはずのトーストがただの文言になる
            showToast = function (msg, isError, action) {
                try { if (typeof isTesting === 'undefined' || !isTesting) window.logConsole(isError ? 'error' : 'info', String(msg)); } catch (e) { /* noop */ }
                return __origShowToast(msg, isError, action);
            };
        }

        // 初期表示状態を復元（既定は非表示 = ランチャーのみ表示）
        let init = false;
        try { init = localStorage.getItem(STORE_KEY) === '1'; } catch (e) { init = false; }
        window.logConsole('info', 'LuminaDB console ready');
        setVisible(init);
        updateBadge();
    })();
