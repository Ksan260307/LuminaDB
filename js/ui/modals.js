    // ============================================================================
    // [Modals] - モーダルの開閉ワイヤリング
    // ============================================================================
    const modals = [
       { btn: 'openHelpBtn', wrap: 'helpModal' },
       { btn: 'openGeneratorBtn', wrap: 'generatorModal' },
       { btn: 'openCsvBtn', wrap: 'csvModal' },
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
