    // ============================================================================
    // [Modals] - モーダルの開閉ワイヤリング
    // ============================================================================
    const modals = [
       { btn: 'openHelpBtn', wrap: 'helpModal' },
       // v1.24: Export SQL / Import SQL / Import CSV / Test Data は dataModal のタブへ集約した
       { btn: 'openDataBtn', wrap: 'dataModal' },
       { btn: null, wrap: 'schemaModal' },
       { btn: null, wrap: 'clearConfirmModal' },
       { btn: null, wrap: 'cellModal' },
       { btn: 'openShortcutsBtn', wrap: 'shortcutModal' },
       { btn: 'openHistoryBtn', wrap: 'historyModal' },
       { btn: null, wrap: 'profileModal' },
       { btn: null, wrap: 'erModal' }
    ];

    // ボタン以外の契機（セルのクリック等）から開くための共通入口。
    // このTailwind CDNでは .hidden が .flex に勝てないためクラスの付け外しで切り替える
    function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
    function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

    // '?' でショートカット一覧、Esc で開いているモーダルを閉じる。
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
            modals.forEach(m => document.getElementById(m.wrap).classList.add('hidden'));
        }
    });
    modals.forEach(m => {
       const modalEl = document.getElementById(m.wrap);
       if(m.btn) document.getElementById(m.btn).addEventListener('click', () => modalEl.classList.remove('hidden'));
       modalEl.querySelectorAll('.closeModalBtn, .closeModalBg').forEach(el => {
         el.addEventListener('click', () => modalEl.classList.add('hidden'));
       });
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
