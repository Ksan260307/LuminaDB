    // ============================================================================
    // [Table Tree] - サイドバーのスキーマツリー描画
    // テーブルは展開してカラム（型・制約バッジ）を確認できる。
    // Views / Triggers / Indexes / Sequences / Procedures / Functions も一覧する
    // ============================================================================

    // 展開中のテーブル名。renderTree() はクエリ実行ごとに呼ばれるため、
    // 展開状態はここで保持して描き直しても畳まれないようにする
    const expandedTables = new Set();

    // スキーマ検索の入力値（表名・列名の部分一致で絞り込む）。
    // renderTree() は毎回作り直すので、状態はここに持つ
    let schemaSearchText = '';

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
        btn.title = i18nT('クリックでカラム名をエディタへ挿入');

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

      // スキーマ検索: 表名か列名に部分一致（大小無視）する表だけを出す。
      // 列名で当たった表は自動的に展開して、どの列が当たったかすぐ判るようにする
      const q = (schemaSearchText || '').trim().toLowerCase();
      const colHit = (tbl) => q !== '' && db.tables[tbl].getColumnNames().some(c => c.toLowerCase().includes(q));
      const tableMatches = (tbl) => q === '' || tbl.toLowerCase().includes(q) || colHit(tbl);
      let shownTables = 0, totalTables = 0;

      Object.keys(db.tables).forEach(tbl => {
        if(tbl.startsWith('__tmp_')) return;
        totalTables++;
        // 選択肢（Test Data / Help / CSV）は検索に関わらず全表を載せる
        [genSel, helpSel, csvSel].forEach(s => {
          const opt = document.createElement('option');
          opt.value = tbl; opt.textContent = tbl;
          s.appendChild(opt);
        });
        if (!tableMatches(tbl)) return;
        shownTables++;

        const isOpen = expandedTables.has(tbl) || colHit(tbl);
        const li = document.createElement('li');
        li.innerHTML = `
        <div class="flex justify-between items-center group">
          <button class="text-gray-400 hover:text-gray-700 px-1 shrink-0 tree-toggle-btn" data-table="${tbl}" title="${i18nT('カラムを表示')}">
            <svg class="w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7"></path></svg>
          </button>
          <button class="text-gray-600 hover:text-blue-600 text-sm flex justify-between flex-1 text-left px-1.5 py-1.5 rounded hover:bg-gray-100 font-medium transition-colors table-select-btn" data-table="${tbl}">
            <span>${tbl}</span>
            <span class="text-[10px] text-gray-400 bg-gray-50 border border-gray-200 px-1.5 rounded-full">${db.tables[tbl].rowCount}</span>
          </button>
          <button class="text-gray-400 hover:text-blue-600 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity profile-btn" data-table="${tbl}" title="${i18nT('列プロファイル（中身の要約）')}">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
          </button>
          <button class="text-gray-400 hover:text-blue-600 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity edit-schema-btn" data-table="${tbl}" title="${i18nT('スキーマを編集')}">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          </button>
        </div>`;
        if (isOpen) li.appendChild(buildColumnList(tbl));
        tree.appendChild(li);
      });

      // CSV の取り込み先には「新しい表を作る」を先頭に足す。
      // 既存表が 1 つも無いときでも CSV から始められるようにするため
      if (csvSel) {
          const opt = document.createElement('option');
          opt.value = '__new__';
          opt.textContent = i18nT('＋ 新しい表を作る');
          // 末尾に置く（既存表を既定の取り込み先にしたいので先頭にはしない）
          csvSel.appendChild(opt);
          if (typeof syncCsvNewTableRow === 'function') syncCsvNewTableRow();
      }

      // 検索中は「何件に絞られているか」を出す（0 件のときの無言の空欄を避ける）
      const note = document.getElementById('schemaSearchNote');
      if (note) {
        if (q === '') { note.classList.add('hidden'); note.textContent = ''; }
        else {
          note.classList.remove('hidden');
          note.textContent = shownTables === 0
              ? i18nT('「{0}」に一致する表・列はありません（全 {1} 表）。', schemaSearchText, totalTables)
              : i18nT('{0} / {1} 表を表示中', shownTables, totalTables);
        }
      }

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

    // ============================================================================
    // 表の右クリックメニュー
    // DDL の確認・データの閲覧・件数・削除は、これまで SQL を手で書くしか
    // 到達手段が無かった。実 DB クライアントと同じくツリーから辿れるようにする
    // ============================================================================
    function closeTreeMenu() {
        const m = document.getElementById('treeMenu');
        if (m) { m.classList.add('hidden'); m.innerHTML = ''; }
    }

    function openTreeMenu(table, x, y) {
        const menu = document.getElementById('treeMenu');
        if (!menu) return;
        const run = (sql) => { setQueryValue(sql); runQuery(); };
        const items = [
            { label: i18nT('データを見る（先頭 100 行）'), act: () => run(`SELECT * FROM ${table} LIMIT 100`) },
            { label: i18nT('件数を数える'), act: () => run(`SELECT COUNT(*) AS rows FROM ${table}`) },
            { label: i18nT('DDL を表示'), act: () => run(`SHOW CREATE TABLE ${table}`) },
            { label: i18nT('列の一覧'), act: () => run(`DESCRIBE ${table}`) },
            { label: i18nT('列プロファイル'), act: () => { if (typeof openProfile === 'function') openProfile(table); } },
            { label: i18nT('スキーマを編集'), act: () => openSchemaEditor(table) },
            { label: i18nT('表名をコピー'), act: () => {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(table).then(() => showToast(i18nT('\'{0}\' をコピーしました。', table))).catch(() => {});
                }
            } },
            { sep: true },
            { label: i18nT('表を削除'), danger: true, act: () => {
                // 破壊的操作なのでエディタへ置くだけにし、実行はユーザーに委ねる
                setQueryValue(`DROP TABLE ${table}`);
                showToast(i18nT('DROP 文をエディタへ入れました。実行すると {0} は消えます。', table), true);
            } }
        ];
        menu.innerHTML = '';
        items.forEach(it => {
            if (it.sep) {
                const hr = document.createElement('div');
                hr.className = 'my-1 border-t border-gray-100';
                menu.appendChild(hr);
                return;
            }
            const b = document.createElement('button');
            b.className = `w-full text-left px-3 py-1.5 hover:bg-gray-100 transition-colors ${it.danger ? 'text-red-600' : 'text-gray-700'}`;
            b.textContent = it.label;   // textContent なのでエスケープ不要
            b.addEventListener('click', () => { closeTreeMenu(); it.act(); });
            menu.appendChild(b);
        });
        menu.classList.remove('hidden');
        // 画面からはみ出さない位置へ寄せる
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest || !e.target.closest('#treeMenu')) closeTreeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTreeMenu(); });
    document.getElementById('tableTree').addEventListener('contextmenu', (e) => {
        const btn = e.target.closest('.table-select-btn');
        if (!btn) return;
        e.preventDefault();
        openTreeMenu(btn.dataset.table, e.clientX, e.clientY);
    });

    // スキーマ検索の入力配線（要素が無い環境でも落ちないよう存在確認する）
    (function initSchemaSearch() {
      const input = document.getElementById('schemaSearch');
      const clear = document.getElementById('schemaSearchClear');
      if (!input) return;
      input.addEventListener('input', () => { schemaSearchText = input.value; renderTree(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; schemaSearchText = ''; renderTree(); }
      });
      if (clear) clear.addEventListener('click', () => {
        input.value = ''; schemaSearchText = ''; renderTree(); input.focus();
      });
    })();

    renderTree();
