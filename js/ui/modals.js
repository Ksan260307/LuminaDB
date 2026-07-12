    // ============================================================================
    // [Modals] - モーダルの開閉ワイヤリング
    // ============================================================================
    const modals = [
       { btn: 'openHelpBtn', wrap: 'helpModal' },
       { btn: 'openGeneratorBtn', wrap: 'generatorModal' },
       { btn: 'openCsvBtn', wrap: 'csvModal' },
       { btn: null, wrap: 'schemaModal' },
       { btn: null, wrap: 'clearConfirmModal' }
    ];
    modals.forEach(m => {
       const modalEl = document.getElementById(m.wrap);
       if(m.btn) document.getElementById(m.btn).addEventListener('click', () => modalEl.classList.remove('hidden'));
       modalEl.querySelectorAll('.closeModalBtn, .closeModalBg').forEach(el => {
         el.addEventListener('click', () => modalEl.classList.add('hidden'));
       });
    });
