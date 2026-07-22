    // ============================================================================
    // [Table Tree] - サイドバーのテーブル一覧描画
    // ============================================================================
    function renderTree() {
      const tree = document.getElementById('tableTree');
      const genSel = document.getElementById('genTableSelect');
      const helpSel = document.getElementById('helpTableSelect');
      const csvSel = document.getElementById('csvTableSelect');

      tree.innerHTML = '';
      [genSel, helpSel, csvSel].forEach(s => s.innerHTML = '');

      Object.keys(db.tables).forEach(tbl => {
        if(tbl.startsWith('__tmp_')) return;

        const li = document.createElement('li');
        li.innerHTML = `
        <div class="flex justify-between items-center group">
          <button class="text-gray-600 hover:text-blue-600 text-sm flex justify-between flex-1 text-left px-3 py-1.5 rounded hover:bg-gray-100 font-medium transition-colors table-select-btn" data-table="${tbl}">
            <span>${tbl}</span>
            <span class="text-[10px] text-gray-400 bg-gray-50 border border-gray-200 px-1.5 rounded-full">${db.tables[tbl].rowCount}</span>
          </button>
          <button class="text-gray-400 hover:text-blue-600 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity edit-schema-btn" data-table="${tbl}" title="Edit Schema">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          </button>
        </div>`;
        tree.appendChild(li);

        [genSel, helpSel, csvSel].forEach(s => {
          const opt = document.createElement('option');
          opt.value = tbl; opt.textContent = tbl;
          s.appendChild(opt);
        });
      });

      // ビュー / トリガーのセクション（存在する場合のみ表示）
      const addSection = (title, names, makeQuery) => {
          if (names.length === 0) return;
          const header = document.createElement('li');
          header.innerHTML = `<div class="text-xs font-semibold text-gray-400 uppercase tracking-widest mt-4 mb-1 px-3">${title}</div>`;
          tree.appendChild(header);
          names.forEach(n => {
              const li = document.createElement('li');
              const btn = document.createElement('button');
              btn.className = 'text-gray-600 hover:text-blue-600 text-sm w-full text-left px-3 py-1 rounded hover:bg-gray-100 transition-colors';
              btn.textContent = n; // textContent 経由のため名前はエスケープ不要
              btn.addEventListener('click', () => {
                  setQueryValue(makeQuery(n));
                  els.query.focus();
              });
              li.appendChild(btn);
              tree.appendChild(li);
          });
      };
      addSection('Views', Object.keys(db.views), (n) => `SELECT * FROM ${n}`);
      addSection('Triggers', Object.keys(db.triggers || {}), () => 'SHOW TRIGGERS');

      tree.querySelectorAll('.table-select-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          setQueryValue(`SELECT * FROM ${e.currentTarget.dataset.table}`);
          els.query.focus();
        });
      });

      tree.querySelectorAll('.edit-schema-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          openSchemaEditor(e.currentTarget.dataset.table);
        });
      });

      renderHelpCommands();
    }
    renderTree();
