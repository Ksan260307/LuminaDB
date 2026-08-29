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
        btn.title = i18nT('クリックで列名をエディタへ挿入');

        const nameEl = document.createElement('span');
        nameEl.className = 'text-xs text-gray-700 font-mono truncate';
        nameEl.textContent = col; // textContent 経由なのでエスケープ不要
        btn.appendChild(nameEl);

        const typeEl = document.createElement('span');
        typeEl.className = 'text-[10px] text-gray-500 uppercase shrink-0';
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
          <button class="text-gray-500 hover:text-gray-800 px-1 shrink-0 tree-toggle-btn" data-table="${tbl}" aria-label="${i18nT('列を表示')}" title="${i18nT('列を表示')}">
            <svg class="w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M9 5l7 7-7 7"></path></svg>
          </button>
          <button class="text-gray-600 hover:text-blue-600 text-sm flex justify-between flex-1 text-left px-1.5 py-1.5 rounded hover:bg-gray-100 font-medium transition-colors table-select-btn" data-table="${tbl}">
            <span>${tbl}</span>
            <span class="text-xs text-gray-600 bg-gray-50 border border-gray-200 px-1.5 rounded-full">${db.tables[tbl].rowCount}</span>
          </button>
          <!-- 行ごとの操作は 1 つの「⋯」へ寄せる。
               以前は列プロファイルとスキーマ編集を icon 2 個で常時出していたが、
               表 1 つにつき 4 個の操作になり、表が増えるほど密度が上がっていた
               （20 表で 80 個超）。同じ内容は右クリックメニューに 8 項目あるのに、
               そちらは見つけようが無かった。⋯ にまとめると、操作は 1 つ減って
               届く機能は 2 → 8 に増え、隠れていたメニューが表から見えるようになる -->
          <button class="text-gray-500 hover:text-blue-600 p-1.5 tree-row-action row-menu-btn" data-table="${tbl}" aria-haspopup="menu" aria-label="${i18nT('{0} の操作', tbl)}" title="${i18nT('{0} の操作', tbl)}">
             <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01"></path></svg>
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

      // 表が 1 つも無いとき。
      // 上の案内は検索中（q !== ''）にしか出ないので、**DB が本当に空のとき**は
      // 検索欄だけが浮いた無言の空欄になっていた。初期化直後や全 DROP の後に
      // 必ず通る道なので、次に何をすればよいかをここで示す
      if (totalTables === 0 && q === '') {
        const li = document.createElement('li');
        li.className = 'px-3 py-2 text-xs text-gray-600 leading-relaxed';
        li.innerHTML = `<p class="mb-2">${escapeHtml(i18nT('表がまだありません。'))}</p>`
            + `<p class="mb-4 text-gray-500">${escapeHtml(i18nT('CREATE TABLE で作るか、CSV / SQL を取り込むと、ここに一覧が出ます。'))}</p>`
            + `<button type="button" id="emptyTreeDataBtn" class="w-full bg-white hover:bg-gray-100 border border-gray-300 py-1.5 rounded text-blue-600 font-medium transition-colors shadow-sm">`
            + `${escapeHtml(i18nT('データを取り込む'))}</button>`;
        tree.appendChild(li);
        const btn = li.querySelector('#emptyTreeDataBtn');
        if (btn) btn.addEventListener('click', () => {
            if (typeof openDataModal === 'function') openDataModal('dataPaneImport');
        });
      }

      // ビュー / トリガー等のセクション（存在する場合のみ表示）。
      // makeQuery が null の項目はクリックしても何もしない（純粋な一覧表示）
      const addSection = (title, names, makeQuery, subtitle) => {
          if (names.length === 0) return;
          const header = document.createElement('li');
          header.innerHTML = `<div class="text-xs font-semibold text-gray-500 uppercase tracking-widest mt-4 mb-1 px-3">${title}</div>`;
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
                  sub.className = 'text-[10px] text-gray-500 ml-auto shrink-0';
                  sub.textContent = subtitle(n);
                  btn.appendChild(sub);
              }
              btn.addEventListener('click', () => {
                  loadIntoEditor(makeQuery(n));
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

      // 表をクリックしたら中身まで出す。
      // 以前は SQL を入れるだけで実行せず、いちばん見つけやすい操作が
      // 「途中まで」で止まっていた（一方で見つけにくい右クリックの
      // 「データを見る」は実行まで済ませていて、順序が逆だった）。
      // 生成する SQL も右クリック側と同じ LIMIT 100 に揃える
      tree.querySelectorAll('.table-select-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          loadIntoEditor(`SELECT * FROM ${e.currentTarget.dataset.table} LIMIT 100`);
          if (typeof runQueryFromUi === 'function') runQueryFromUi();
          else runQuery();
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

      // 行の「⋯」は右クリックと同じメニューを、ボタンの真下に開く
      tree.querySelectorAll('.row-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openTreeMenu(e.currentTarget.dataset.table, r.left, r.bottom + 2);
        });
      });

      renderHelpCommands();
    }

    // ============================================================================
    // 表の右クリックメニュー
    // DDL の確認・データの閲覧・件数・削除は、これまで SQL を手で書くしか
    // 到達手段が無かった。実 DB クライアントと同じくツリーから辿れるようにする
    // ============================================================================
    // 右クリックメニューを開いた元の要素（閉じたらここへフォーカスを返す）
    let treeMenuReturnTo = null;

    function closeTreeMenu() {
        const m = document.getElementById('treeMenu');
        if (!m || m.classList.contains('hidden')) return;
        // 中にフォーカスが残ったまま隠すと現在地が body へ落ちるので、
        // 開いた場所（表のボタン）へ返す
        const hadFocus = m.contains(document.activeElement);
        m.classList.add('hidden');
        m.innerHTML = '';
        if (hadFocus && treeMenuReturnTo && document.contains(treeMenuReturnTo)) {
            try { treeMenuReturnTo.focus(); } catch (e) { /* 消えていれば何もしない */ }
        }
        treeMenuReturnTo = null;
    }

    function openTreeMenu(table, x, y) {
        const menu = document.getElementById('treeMenu');
        if (!menu) return;
        const run = (sql) => { loadIntoEditor(sql); runQuery(); };
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
                loadIntoEditor(`DROP TABLE ${table}`);
                showToast(i18nT('DROP 文をエディタへ入れました。実行すると {0} は消えます。', table), true);
            } }
        ];
        menu.innerHTML = '';
        // メニューとして宣言する。以前は div にボタンを並べただけで、
        // 開いてもフォーカスが移らず矢印キーでも辿れなかった
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', i18nT('{0} の操作', table));
        items.forEach(it => {
            if (it.sep) {
                const hr = document.createElement('div');
                hr.className = 'my-1 border-t border-gray-100';
                hr.setAttribute('role', 'separator');
                menu.appendChild(hr);
                return;
            }
            const b = document.createElement('button');
            b.className = `w-full text-left px-3 py-1.5 hover:bg-gray-100 transition-colors ${it.danger ? 'text-red-600' : 'text-gray-700'}`;
            b.setAttribute('role', 'menuitem');
            b.textContent = it.label;   // textContent なのでエスケープ不要
            b.addEventListener('click', () => { closeTreeMenu(); it.act(); });
            menu.appendChild(b);
        });
        menu.classList.remove('hidden');
        // 画面からはみ出さない位置へ寄せる
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
        // 開いた元の要素を控えて先頭項目へフォーカスを移す（閉じたら戻す）
        treeMenuReturnTo = document.activeElement;
        const first = menu.querySelector('button');
        if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 0);
    }

    // 上下で項目を辿る
    document.getElementById('treeMenu').addEventListener('keydown', (e) => {
        const items = [...document.querySelectorAll('#treeMenu button')];
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });

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
