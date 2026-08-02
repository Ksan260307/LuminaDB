    // ============================================================================
    // [Table Tree] - サイドバーのスキーマツリー描画
    // テーブルは展開してカラム（型・制約バッジ）を確認できる。
    // Views / Triggers / Indexes / Sequences / Procedures / Functions も一覧する
    // ============================================================================

    // 展開中のテーブル名。renderTree() はクエリ実行ごとに呼ばれるため、
    // 展開状態はここで保持して描き直しても畳まれないようにする
    const expandedTables = new Set();

    // 列の制約バッジ。実DBクライアントと同じく一目で鍵と NULL 可否が分かるようにする
    function columnBadges(t, col) {
      const badges = [];
      const isCompositePk = (t.compositeKeys || []).some(ck => ck.isPK && ck.cols.includes(col));
      if (t.primaryKey === col || isCompositePk) badges.push(['PK', 'bg-amber-100 text-amber-700 border-amber-200']);
      if ((t.foreignKeys || []).some(fk => fk.col === col)) badges.push(['FK', 'bg-sky-100 text-sky-700 border-sky-200']);
      if ((t.uniqueCols || []).includes(col)) badges.push(['UQ', 'bg-violet-100 text-violet-700 border-violet-200']);
      if ((t.notNullCols || []).includes(col)) badges.push(['NN', 'bg-gray-100 text-gray-600 border-gray-200']);
      if (t.autoIncrementCol === col) badges.push(['AI', 'bg-green-100 text-green-700 border-green-200']);
      if (t.generatedCols && t.generatedCols[col]) badges.push(['GEN', 'bg-teal-100 text-teal-700 border-teal-200']);
      return badges;
    }

    // 1テーブル分のカラム一覧を組み立てる（展開時のみ描画される）
    function buildColumnList(tbl) {
      const t = db.tables[tbl];
      const ul = document.createElement('ul');
      ul.className = 'ml-4 mt-0.5 mb-1 space-y-0.5 border-l border-gray-200 pl-2';
      Object.keys(t.cols).forEach(col => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'w-full text-left px-2 py-0.5 rounded hover:bg-gray-100 transition-colors flex items-center gap-1.5 group/col column-insert-btn';
        btn.dataset.column = col;
        btn.title = 'クリックでカラム名をエディタへ挿入';

        const nameEl = document.createElement('span');
        nameEl.className = 'text-xs text-gray-700 font-mono truncate';
        nameEl.textContent = col; // textContent 経由なのでエスケープ不要
        btn.appendChild(nameEl);

        const typeEl = document.createElement('span');
        typeEl.className = 'text-[10px] text-gray-400 uppercase shrink-0';
        typeEl.textContent = (t.colTypes && t.colTypes[col]) ? t.colTypes[col] : 'ANY';
        btn.appendChild(typeEl);

        const badgeWrap = document.createElement('span');
        badgeWrap.className = 'ml-auto flex gap-0.5 shrink-0';
        columnBadges(t, col).forEach(([label, cls]) => {
          const b = document.createElement('span');
          b.className = `text-[9px] leading-none px-1 py-0.5 rounded border font-semibold ${cls}`;
          b.textContent = label;
          badgeWrap.appendChild(b);
        });
        btn.appendChild(badgeWrap);

        li.appendChild(btn);
        ul.appendChild(li);
      });
      return ul;
    }

    function renderTree() {
      const tree = document.getElementById('tableTree');
      const genSel = document.getElementById('genTableSelect');
      const helpSel = document.getElementById('helpTableSelect');
      const csvSel = document.getElementById('csvTableSelect');

      tree.innerHTML = '';
      [genSel, helpSel, csvSel].forEach(s => s.innerHTML = '');

      Object.keys(db.tables).forEach(tbl => {
        if(tbl.startsWith('__tmp_')) return;

        const isOpen = expandedTables.has(tbl);
        const li = document.createElement('li');
        li.innerHTML = `
        <div class="flex justify-between items-center group">
          <button class="text-gray-400 hover:text-gray-700 px-1 shrink-0 tree-toggle-btn" data-table="${tbl}" title="カラムを表示">
            <svg class="w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7"></path></svg>
          </button>
          <button class="text-gray-600 hover:text-blue-600 text-sm flex justify-between flex-1 text-left px-1.5 py-1.5 rounded hover:bg-gray-100 font-medium transition-colors table-select-btn" data-table="${tbl}">
            <span>${tbl}</span>
            <span class="text-[10px] text-gray-400 bg-gray-50 border border-gray-200 px-1.5 rounded-full">${db.tables[tbl].rowCount}</span>
          </button>
          <button class="text-gray-400 hover:text-blue-600 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity profile-btn" data-table="${tbl}" title="列プロファイル（中身の要約）">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
          </button>
          <button class="text-gray-400 hover:text-blue-600 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity edit-schema-btn" data-table="${tbl}" title="Edit Schema">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          </button>
        </div>`;
        if (isOpen) li.appendChild(buildColumnList(tbl));
        tree.appendChild(li);

        [genSel, helpSel, csvSel].forEach(s => {
          const opt = document.createElement('option');
          opt.value = tbl; opt.textContent = tbl;
          s.appendChild(opt);
        });
      });

      // ビュー / トリガー等のセクション（存在する場合のみ表示）。
      // makeQuery が null の項目はクリックしても何もしない（純粋な一覧表示）
      const addSection = (title, names, makeQuery, subtitle) => {
          if (names.length === 0) return;
          const header = document.createElement('li');
          header.innerHTML = `<div class="text-xs font-semibold text-gray-400 uppercase tracking-widest mt-4 mb-1 px-3">${title}</div>`;
          tree.appendChild(header);
          names.forEach(n => {
              const li = document.createElement('li');
              const btn = document.createElement('button');
              btn.className = 'text-gray-600 hover:text-blue-600 text-sm w-full text-left px-3 py-1 rounded hover:bg-gray-100 transition-colors flex items-center gap-2';
              const label = document.createElement('span');
              label.className = 'truncate';
              label.textContent = n; // textContent 経由のため名前はエスケープ不要
              btn.appendChild(label);
              if (subtitle) {
                  const sub = document.createElement('span');
                  sub.className = 'text-[10px] text-gray-400 ml-auto shrink-0';
                  sub.textContent = subtitle(n);
                  btn.appendChild(sub);
              }
              btn.addEventListener('click', () => {
                  setQueryValue(makeQuery(n));
                  els.query.focus();
              });
              li.appendChild(btn);
              tree.appendChild(li);
          });
      };
      addSection('Views', Object.keys(db.views), (n) => `SELECT * FROM ${n}`,
                 (n) => (db.viewMeta && db.viewMeta[n]) ? 'CHECK' : '');
      addSection('Triggers', Object.keys(db.triggers || {}), () => 'SHOW TRIGGERS',
                 (n) => db.triggers[n] ? `${db.triggers[n].timing.toUpperCase()} ${db.triggers[n].event.toUpperCase()}` : '');
      addSection('Indexes', Object.keys(db.indexNames || {}), () => 'SHOW INDEXES',
                 (n) => db.indexNames[n] ? db.indexNames[n].table : '');
      addSection('Sequences', Object.keys(db.sequences || {}), (n) => `SELECT NEXTVAL('${n}') AS next_value`,
                 (n) => db.sequences[n] ? String(db.sequences[n].value) : '');
      addSection('Procedures', Object.keys(db.procedures || {}), (n) => `CALL ${n}()`);
      addSection('Functions', Object.keys(db.functions || {}), () => 'SHOW FUNCTIONS');

      tree.querySelectorAll('.table-select-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          setQueryValue(`SELECT * FROM ${e.currentTarget.dataset.table}`);
          els.query.focus();
        });
      });

      // 展開トグル: 展開状態を覚えたまま再描画する
      tree.querySelectorAll('.tree-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const name = e.currentTarget.dataset.table;
          if (expandedTables.has(name)) expandedTables.delete(name);
          else expandedTables.add(name);
          renderTree();
        });
      });

      // カラム名をエディタのカーソル位置へ挿入する（列名の打ち間違い防止）
      tree.querySelectorAll('.column-insert-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          insertAtCursor(e.currentTarget.dataset.column);
        });
      });

      tree.querySelectorAll('.edit-schema-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          openSchemaEditor(e.currentTarget.dataset.table);
        });
      });

      // 列プロファイル（schema-insight.js。読み込み順の都合で存在確認してから呼ぶ）
      tree.querySelectorAll('.profile-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          if (typeof openProfile === 'function') openProfile(e.currentTarget.dataset.table);
        });
      });

      renderHelpCommands();
    }
    renderTree();
