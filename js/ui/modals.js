    // ============================================================================
    // [Modals] - モーダルの開閉ワイヤリング
    // ============================================================================
    // autoFocus: 開いた直後にフォーカスを置く要素。
    //   検索欄を持つモーダルは必ずそこへ。Help を開いてから
    //   コマンド名を打ち始めるまでに、背後の 592 個のボタンを Tab で
    //   通り抜けさせられていた
    const modals = [
       { btn: 'openHelpBtn', wrap: 'helpModal', autoFocus: 'helpSearchInput' },
       // v1.24: Export SQL / Import SQL / Import CSV / Test Data は dataModal のタブへ集約した
       { btn: 'openDataBtn', wrap: 'dataModal' },
       { btn: null, wrap: 'schemaModal' },
       { btn: null, wrap: 'clearConfirmModal' },
       { btn: null, wrap: 'cellModal' },
       { btn: 'openShortcutsBtn', wrap: 'shortcutModal' },
       { btn: 'openHistoryBtn', wrap: 'historyModal', autoFocus: 'historySearch' },
       { btn: null, wrap: 'profileModal' },
       { btn: null, wrap: 'erModal' }
    ];
    const modalById = Object.create(null);
    modals.forEach(m => { modalById[m.wrap] = m; });

    // ------------------------------------------------------------------
    // フォーカス管理
    //
    // 以前はクラスの付け外しだけで、フォーカスをまったく動かしていなかった。
    // そのため
    //   ・モーダルを開いてもフォーカスはエディタに残ったまま
    //   ・Tab で背後のサイドバー・ツールバーへ出て行ける（閉じ込めが無い）
    //   ・閉じてもどこへ戻るか決まっていない
    // となり、キーボードだけでは実質使えなかった。
    // 開いた元の要素を控えて、閉じたら必ずそこへ返す
    // ------------------------------------------------------------------
    const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),'
        + ' select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let focusReturnTo = null;

    function isOpen(el) { return !el.classList.contains('hidden'); }
    function openModalEls() { return modals.map(m => document.getElementById(m.wrap)).filter(isOpen); }
    // いちばん後に開いた（＝最前面の）モーダル。Esc とフォーカス閉じ込めの対象
    function topModal() {
        const open = openModalEls();
        return open.length ? open[open.length - 1] : null;
    }
    function visibleFocusables(el) {
        return [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
    }

    function openModal(id) {
        const el = document.getElementById(id);
        if (!el || isOpen(el)) return;
        // 最初の 1 枚を開くときだけ戻り先を控える（確認ダイアログの重ね開きで上書きしない）
        if (openModalEls().length === 0) focusReturnTo = document.activeElement;
        el.classList.remove('hidden');
        const spec = modalById[id];
        const target = (spec && spec.autoFocus && document.getElementById(spec.autoFocus))
            || visibleFocusables(el)[0]
            || el;
        // 表示直後はレイアウトが確定していないことがあるので 1 タスク後に当てる。
        // requestAnimationFrame は**隠れたタブでは発火しない**ので使わない
        // （ヘッドレスの検査でモーダルのフォーカスが当たらなくなる）
        setTimeout(() => { try { target.focus(); } catch (e) { /* 消えていれば何もしない */ } }, 0);
    }
    function closeModal(id) {
        const el = document.getElementById(id);
        if (!el || !isOpen(el)) return;
        // 閉じる前に、中にフォーカスが残っていないかを見る（残ったまま display:none にすると
        // フォーカスが body へ落ちて、キーボード操作の現在地が判らなくなる）
        const hadFocus = el.contains(document.activeElement);
        el.classList.add('hidden');
        if (openModalEls().length === 0) {
            if (hadFocus && focusReturnTo && document.contains(focusReturnTo)) {
                try { focusReturnTo.focus(); } catch (e) { /* 消えていれば何もしない */ }
            }
            focusReturnTo = null;
        }
    }
    // '?' でショートカット一覧、Esc で最前面のモーダルを閉じる。
    // 入力欄にフォーカスがあるときは '?' を打てなくなるので拾わない
    document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) || '';
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
        if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            openModal('shortcutModal');
            return;
        }
        if (e.key === 'Escape') {
            // 以前は開いている全モーダルを一度に閉じていたため、確認ダイアログを
            // 1 回 Esc しただけで、その下で編集中だった画面まで巻き添えで消えていた。
            // 1 回の Esc で 1 枚だけ閉じる
            const top = topModal();
            if (top) { e.preventDefault(); closeModal(top.id); return; }
            if (document.body.dataset.sidebar === 'open') { closeSidebar(); return; }
        }
        // フォーカスの閉じ込め。モーダルの外へ Tab で出させない
        if (e.key === 'Tab') {
            const top = topModal();
            if (!top) return;
            const items = visibleFocusables(top);
            if (items.length === 0) { e.preventDefault(); return; }
            const first = items[0], last = items[items.length - 1];
            if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    modals.forEach(m => {
       const modalEl = document.getElementById(m.wrap);
       if(m.btn) document.getElementById(m.btn).addEventListener('click', () => openModal(m.wrap));
       modalEl.querySelectorAll('.closeModalBtn, .closeModalBg').forEach(el => {
         el.addEventListener('click', () => closeModal(m.wrap));
       });
    });

    // ------------------------------------------------------------------
    // サイドバーの引き出し（狭い画面のみ。CSS 側のメディアクエリと対で動く）
    // ------------------------------------------------------------------
    const sidebarEl = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    function openSidebar() {
        document.body.dataset.sidebar = 'open';
        if (sidebarToggle) sidebarToggle.setAttribute('aria-expanded', 'true');
        const first = sidebarEl && sidebarEl.querySelector(FOCUSABLE);
        if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 0);
    }
    function closeSidebar() {
        if (document.body.dataset.sidebar !== 'open') return;
        const hadFocus = sidebarEl && sidebarEl.contains(document.activeElement);
        delete document.body.dataset.sidebar;
        if (sidebarToggle) {
            sidebarToggle.setAttribute('aria-expanded', 'false');
            if (hadFocus) { try { sidebarToggle.focus(); } catch (e) {} }
        }
    }
    function toggleSidebar() {
        if (document.body.dataset.sidebar === 'open') closeSidebar(); else openSidebar();
    }
    if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);
    // 表を選ぶ・データ画面を開くといった「用が済む」操作の後は自動で畳む。
    // 狭い画面では引き出しが本文を覆っているので、開いたままだと結果が見えない
    if (sidebarEl) sidebarEl.addEventListener('click', (e) => {
        if (document.body.dataset.sidebar !== 'open') return;
        if (e.target.closest('button, a')) closeSidebar();
    });
    // 画面が広がったら引き出しの状態は無意味になる（CSS 側で常時表示に戻る）
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 768) closeSidebar();
    });

    // データモーダルのタブ切り替え。タブのボタンを（モーダルを開かずに）押した場合でも
    // 対応するペインが表になるので、テストや外部からの呼び出しでも状態が揃う
    function showDataTab(paneId) {
        document.querySelectorAll('#dataModal .dataPane').forEach(p => {
            const on = p.id === paneId;
            p.classList.toggle('hidden', !on);
            p.classList.toggle('flex', on);
        });
        document.querySelectorAll('#dataModal .dataTabBtn').forEach(b => {
            const on = b.dataset.pane === paneId;
            b.classList.toggle('border-blue-600', on);
            b.classList.toggle('text-blue-700', on);
            b.classList.toggle('border-transparent', !on);
            b.classList.toggle('text-gray-500', !on);
        });
    }
    document.querySelectorAll('#dataModal .dataTabBtn').forEach(b => {
        b.addEventListener('click', () => showDataTab(b.dataset.pane));
    });

    // データモーダルを指定タブで開く（他所からの入口）。
    // 開くたびに保存状態の表示を作り直す（前回開いたときの数字が残らないように）
    function openDataModal(paneId) {
        if (paneId) showDataTab(paneId);
        if (typeof refreshStorageInfo === 'function') refreshStorageInfo();
        openModal('dataModal');
    }
    // サイドバーのボタンからは必ず先頭タブ（このブラウザ）で開く。
    // 前回どのタブを見ていたかで入口の見た目が変わらないようにする
    const openDataBtnEl = document.getElementById('openDataBtn');
    if (openDataBtnEl) openDataBtnEl.addEventListener('click', () => {
        showDataTab('dataPaneBrowser');
        if (typeof refreshStorageInfo === 'function') refreshStorageInfo();
    });
    // Ctrl+Shift+D で開く
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            openDataModal('dataPaneBrowser');
        }
    });
