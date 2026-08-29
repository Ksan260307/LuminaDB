    // ============================================================================
    // [Results] - 結果テーブルの描画 / ソート / 無限スクロール
    // ============================================================================
    let currentDisplayOffset = 0;
    const CHUNK_SIZE = 50;

    // --- Interactive Sorting ---
    // 列見出しは tabindex="0" + role="button" の th。
    // 以前は素の th に cursor-pointer を当てただけで、並べ替えは
    // マウス専用だった（キーボードでは到達も実行もできない）
    function sortByColumn(col) {
        if (!col || !currentResultData || currentResultData.length === 0) return;
        if (currentSort.col === col) {
            currentSort.asc = !currentSort.asc;
        } else {
            currentSort.col = col;
            currentSort.asc = true;
        }

        currentResultData.sort((a, b) => {
            let va = a[col]; let vb = b[col];
            if (va === vb) return 0;
            if (va === null || va === undefined) return currentSort.asc ? 1 : -1;
            if (vb === null || vb === undefined) return currentSort.asc ? -1 : 1;
            if (va < vb) return currentSort.asc ? -1 : 1;
            return currentSort.asc ? 1 : -1;
        });

        // 並べ替えで行の位置が変わるので選択を解除する。
        // 解除しないと「− Row」が選んだのとは別の行を削除する（データ破壊）
        clearRowSelection();
        renderDisplay(true);
        // 描き直しでフォーカスが飛ぶので、同じ列の見出しへ戻す。
        // 列名は任意の文字を含みうるので、属性セレクタを組み立てずに走査して照合する
        const again = [...els.resArea.querySelectorAll('th[data-col]')]
            .find(th => th.dataset.col === col);
        if (again) { try { again.focus(); } catch (e) { /* 消えていれば何もしない */ } }
    }

    els.resArea.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (th) sortByColumn(th.dataset.col);
    });
    // Enter / Space で並べ替える（見出しは role="button" として宣言している）
    els.resArea.addEventListener('keydown', (e) => {
        const el = e.target.closest && e.target.closest('th[data-col], td[data-r]');
        if (!el) return;
        // 列見出し: Enter / Space で並べ替え
        if (el.tagName === 'TH') {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            sortByColumn(el.dataset.col);
            return;
        }
        // データセル: 矢印で移動 / Enter で値の詳細 / F2 で編集。
        // クリックとダブルクリックしか入口が無く、キーボードだけでは
        // 値を読むことも直すこともできなかった
        const moveTo = (r, c) => {
            const next = els.resArea.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
            if (next) { e.preventDefault(); next.focus(); }
        };
        const r = Number(el.dataset.r), c = Number(el.dataset.c);
        if (e.key === 'ArrowRight') return moveTo(r, c + 1);
        if (e.key === 'ArrowLeft')  return moveTo(r, c - 1);
        if (e.key === 'ArrowDown')  return moveTo(r + 1, c);
        if (e.key === 'ArrowUp')    return moveTo(r - 1, c);
        if (e.key === 'F2') { e.preventDefault(); beginCellEdit(el); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            const rows = filteredResultData();
            const row = rows[r];
            if (!row) return;
            const col = Object.keys(row)[c];
            openCellModal(col, row[col]);
        }
    });

    // 行の選択を解除する。表示順が変わる操作（並べ替え・絞り込み・再実行）の直後に
    // 必ず呼ぶこと。選択は「絞り込み後の配列の添字」なので、順序が変われば別の行を指す
    function clearRowSelection() {
        selectedRowIdx = null;
        if (typeof setRowActionsEnabled === 'function') setRowActionsEnabled();
    }

    // 絞り込み後の行配列を返す。どの列でも部分一致（大文字小文字を無視）すれば残す。
    // 商用DBクライアントのグリッドフィルタと同じ「まず全部取ってから目で探す」用途
    function filteredResultData() {
        if (!currentResultData) return currentResultData;
        const q = resultFilter.trim().toLowerCase();
        if (q === '') return currentResultData;
        return currentResultData.filter(row => Object.values(row).some(v => {
            if (v === null || v === undefined) return 'null'.includes(q);
            return String(v).toLowerCase().includes(q);
        }));
    }

    function renderDisplay(reset = true) {
       if (reset) {
           els.resArea.innerHTML = '';
           currentDisplayOffset = 0;
           document.getElementById('resultsContainer').scrollTop = 0;
       }

       if (!currentResultData || currentResultData.length === 0) {
          if (reset) els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">${i18nT('該当する行はありません。')}</div>`;
          return;
       }

       // 列見出しは元データ由来（絞り込みで 0 件になっても列は保つ）
       const keys = Object.keys(currentResultData[0]);
       // この結果は「エンジンが出した状態行」か。
       //   - DML/DDL の結果: {Result, Message} の2キーだけ
       //   - テストスイートの結果: {TestName, Status, Error}
       // 状態色を塗るかどうかをここで一度だけ決め、セルの文字列内容では判定しない
       const statusShape = (keys.length === 2 && keys.includes('Result') && keys.includes('Message'))
           || (keys.includes('TestName') && keys.includes('Status'));
       const filtered = filteredResultData();
       if (filtered.length === 0) {
          if (reset) {
              els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">`
                  + `${i18nT('「{0}」に一致する行がありません（全 {1} 件）。', escapeHtml(resultFilter), currentResultData.length.toLocaleString())}</div>`;
          }
          return;
       }

       const limitVal = els.dispLimit.value;
       const limit = limitVal === 'all' ? filtered.length : parseInt(limitVal, 10);
       const targetData = filtered.slice(0, limit);

       if (currentDisplayOffset >= targetData.length) return;

       const chunk = targetData.slice(currentDisplayOffset, currentDisplayOffset + CHUNK_SIZE);
       const chunkStart = currentDisplayOffset;

       // 行を識別する列は横スクロールしても残す。
       // 40 列の表は内容 3,400px に対して表示が 1,000px ほどしかなく、
       // 右へ送るとキー列が画面外へ出て「これはどの行か」が判らなくなっていた
       // （列見出しは sticky top で縦には残るが、横には何も残らなかった）。
       // 編集可のときは基底表のキー列、そうでなければ先頭列を固定する
       const freezeCol = (editContext.editable && editContext.keyCols && editContext.keyCols.length === 1)
           ? editContext.keyCols[0]
           : keys[0];
       const freezeIdx = keys.indexOf(freezeCol);
       // 1 列しか無い結果で固定しても意味が無い（かつ影が邪魔になる）
       const useFreeze = keys.length > 3 && freezeIdx === 0;

       let ths = `<tr>${keys.map((k, ki) => {
           let sortIcon = '<span class="text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity ml-1">⇅</span>';
           if (currentSort.col === k) {
               sortIcon = currentSort.asc
                   ? '<span class="text-blue-500 ml-1 inline-block transform">↑</span>'
                   : '<span class="text-blue-500 ml-1 inline-block transform">↓</span>';
           }
           // aria-sort は「いまこの列で並んでいるか、向きはどちらか」を支援技術へ伝える
           const ariaSort = currentSort.col === k ? (currentSort.asc ? 'ascending' : 'descending') : 'none';
           // 固定列の見出しは縦横どちらにも残る（z を上げて他の sticky より前に出す）
           const frozen = useFreeze && ki === freezeIdx;
           const pos = frozen ? ' sticky -top-4 -left-4 z-30' : ' sticky -top-4 z-20';
           return `<th scope="col" role="button" tabindex="0" aria-sort="${ariaSort}"`
               + ` title="${escapeHtml(i18nT('クリックまたは Enter で並べ替え'))}"`
               + ` class="px-4 py-2 font-semibold border-r border-gray-200 last:border-0${pos} bg-gray-100 shadow-sm cursor-pointer hover:bg-gray-200 select-none group" data-col="${escapeHtml(k)}">${escapeHtml(k)}${sortIcon}</th>`;
       }).join('')}</tr>`;

       let trs = chunk.map((row, ri) => {
          // data-r / data-c は「クリックされたセルの元の値」を引くための座標。
          // 属性なので td の子要素は増えない（セル値のエスケープ検証テストが要求する）
          const rowIdx = chunkStart + ri;
          let tds = Object.values(row).map((v, ci) => {
             // data-r / data-c に加えて tabindex / role を持たせる。
             // セルの詳細（クリック）と編集（ダブルクリック）はマウス専用で、
             // キーボードだけでは触れなかった。Enter で詳細・F2 で編集を受ける
             // 省略されたときに中身が判るよう、長い値だけ title を付ける
             //（短い値にまで付けるとツールチップが鬱陶しい）
             const raw = v === null || v === undefined ? '' : String(v);
             const tip = raw.length > 40 ? ` title="${escapeHtml(raw.slice(0, 400))}"` : '';
             const attr = ` data-r="${rowIdx}" data-c="${ci}" tabindex="0" role="gridcell"${tip}`;
             // 固定列は横スクロールしても残す。透けないよう背景を敷く
             const frozen = useFreeze && ci === freezeIdx;
             // 列幅に上限を置いて、超えたぶんは省略する。
             //
             // 上限が無かったので、400 文字のセル 1 つで列が 4,833px に広がり、
             // 表全体が 4,976px（横スクロール約 4,950px）になって 3 列目が
             // 画面外へ出ていた。説明欄・JSON・ログ行なら普通にある長さで、
             // テキスト列を含む実データではグリッドが用を成さなくなる。
             // 全文はセルの詳細（クリック / Enter）で読めるので、
             // ここは「一覧できること」を優先する
             const cell = (extra) => 'px-4 py-1.5 border-r border-gray-200 last:border-0 max-w-md truncate'
                 + (frozen ? ' sticky -left-4 z-10 bg-white' : '') + ' ' + extra;
             // XSS対策: セル値は必ずエスケープしてから innerHTML へ挿入する
             const esc = escapeHtml(v);
             // 緑/赤の「状態色」は **結果の形** で決める（statusShape）。
             // 以前はセルの文字列に 'deleted' や 'not found' が含まれるかどうかで
             // 塗っていたため、'record deleted by ops' のような**ただのデータ**が
             // 成功メッセージのように緑になり、'customer not found in CRM' が
             // エラー扱いの赤地になっていた
             if (statusShape) {
                 if(v==="Success"||v==="PASS"||(typeof v==='string' && (v.includes("inserted")||v.includes("updated")||v.includes("deleted")))){
                     return `<td${attr} class="${cell('text-green-600 font-medium')}">${esc}</td>`;
                 }
                 if(v==="FAIL"||(typeof v==='string' && v.includes("Assertion") && !v.includes("not found"))){
                     return `<td${attr} class="${cell('text-red-600 font-medium')}">${esc}</td>`;
                 }
                 if(typeof v==='string' && (v.includes("not found") || v.includes("Type mismatch") || v.includes("Foreign key constraint failed"))) return `<td${attr} class="${cell('text-red-600 font-bold bg-red-50')}">${esc}</td>`;
             }
             if(typeof v==='number') return `<td${attr} class="${cell('text-blue-600')}">${v}</td>`;
             if(typeof v==='boolean') return `<td${attr} class="${cell('text-purple-600 font-semibold')}">${v}</td>`;
             // NULL と文字列 'null' と空文字が同じ見た目だったので区別できる印にする
             // 白地で gray-400 は約 2.6:1、gray-300 は約 1.5:1 しかなく、
             // NULL と空文字を区別する印そのものが読めなかった
             if(v===null||v===undefined) return `<td${attr} class="${cell('text-gray-500 italic')}">[NULL]</td>`;
             if(v==='') return `<td${attr} class="${cell('text-gray-500 italic')}">[empty]</td>`;
             return `<td${attr} class="${cell('text-gray-700')}">${esc}</td>`;
          }).join('');
          return `<tr class="hover:bg-gray-50 border-b border-gray-100 last:border-0">${tds}</tr>`;
       }).join('');

       if (reset) {
           els.resArea.innerHTML = `
              <!-- overflow-hidden を置かないこと。
                   overflow が visible 以外の要素は「スクロールの入れ物」になるので、
                   中の position:sticky はスクロールしない**この div** に貼り付き、
                   実際にスクロールしている #resultsContainer に対しては効かない。
                   そのため列見出しの sticky top-0 は当たっているのに一度も機能しておらず、
                   300 行の結果を少し下げるだけで列名が消えていた（角の丸めのために
                   付いていたクラスが、そのまま固定表示を殺していた） -->
              <div class="rounded-lg border border-gray-200 bg-white w-fit min-w-full shadow-sm relative z-10 flex flex-col h-full">
                <table class="w-full text-left text-sm whitespace-nowrap">
                  <thead class="bg-gray-100 text-gray-600 text-xs border-b border-gray-200">${ths}</thead>
                  <tbody id="resultsTbody" class="font-mono text-xs">${trs}</tbody>
                </table>
              </div>
              <div id="resultsNote" class="text-xs text-gray-500 p-3 text-center bg-gray-50 border-t border-gray-200 w-full hidden"></div>
           `;
       } else {
           const tbody = els.resArea.querySelector('#resultsTbody');
           if (tbody) tbody.insertAdjacentHTML('beforeend', trs);
       }

       currentDisplayOffset += chunk.length;

       // 脚注。以前は「全部描き切ったとき」だけ出していたため、描画途中は
       // **続きがあることを示す表示が画面上に一つも無かった**。
       // 5 万行の結果でも最初は 50 行しか出ず、件数メトリクスだけが 50,000 を指すので、
       // 「50 件しか返っていない」と読み違えるほかなかった。
       // 途中なら「いくつまで出していて、あと何件あるのか」を出す
       const noteEl = els.resArea.querySelector('#resultsNote');
       if (noteEl) {
           const shown = Math.min(currentDisplayOffset, targetData.length);
           const filteredNote = resultFilter.trim() === ''
               ? ''
               : i18nT('（全 {0} 件から絞り込み）', currentResultData.length.toLocaleString());
           if (currentDisplayOffset >= targetData.length) {
               noteEl.textContent = i18nT('{0} / {1} 件を表示{2}',
                   shown.toLocaleString(), filtered.length.toLocaleString(), filteredNote);
           } else {
               noteEl.textContent = i18nT('{0} / {1} 件を表示{2} — 下へスクロールすると続きを読み込みます',
                   shown.toLocaleString(), targetData.length.toLocaleString(), filteredNote);
           }
           noteEl.classList.remove('hidden');
       }
    }

    // データセルのクリックで詳細モーダルを開く（長いテキストや JSON をそのまま読むため）。
    // ヘッダーのソートは別のリスナーが担当する
    // シングルクリックは詳細表示、ダブルクリックはセル編集。ダブルクリックの
    // 1 打目でモーダルが開いてしまわないよう、詳細表示は少し遅らせて出す
    let cellClickTimer = null;
    els.resArea.addEventListener('click', (e) => {
        const td = e.target.closest('td');
        if (!td || td.dataset.r === undefined) return;
        // 保留中の詳細表示は、編集が始まっていても必ず取り消す。
        // 以前は activeEditor の early return が clearTimeout より前にあったため、
        // ダブルクリックの 1 打目で仕掛けたタイマーが生き残り、開いた編集欄の上に
        // 詳細モーダルが被さって入力が失われていた
        clearTimeout(cellClickTimer);
        if (activeEditor) return;   // 編集中は詳細を開かない
        const show = () => {
            // 遅延実行の間に編集が始まっている可能性があるのでもう一度見る
            if (activeEditor) return;
            const rows = filteredResultData();
            const row = rows[Number(td.dataset.r)];
            if (!row) return;
            const keys = Object.keys(row);
            const col = keys[Number(td.dataset.c)];
            openCellModal(col, row[col]);
        };
        // 編集可のときだけ待つ（ダブルクリックの1打目で詳細が開かないように）。
        // 読み取り専用ならダブルクリックの用途が無いので即座に開く
        if (editContext.editable) cellClickTimer = setTimeout(show, 220);
        else show();
    });

    // セル詳細モーダル: 型・長さ・生の値を出し、JSON ならワンクリックで整形できる
    function openCellModal(col, value) {
        const raw = value === null || value === undefined ? '' : String(value);
        document.getElementById('cellModalCol').textContent = col === undefined ? '' : col;
        document.getElementById('cellModalType').textContent = value === null ? 'null' : typeof value;
        document.getElementById('cellModalLen').textContent = String(raw.length);
        const pre = document.getElementById('cellModalValue');
        pre.textContent = value === null ? 'NULL' : raw;
        const prettyBtn = document.getElementById('cellModalPretty');
        let parsed;
        try { parsed = (raw.trim()[0] === '{' || raw.trim()[0] === '[') ? JSON.parse(raw) : undefined; } catch (err) { parsed = undefined; }
        prettyBtn.classList.toggle('hidden', parsed === undefined);
        prettyBtn.onclick = () => { pre.textContent = JSON.stringify(parsed, null, 2); };
        document.getElementById('cellModalCopy').onclick = () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(pre.textContent).then(() => showToast(i18nT('セルの値をコピーしました。'))).catch(() => {});
            }
        };
        openModal('cellModal');
    }

    // ============================================================================
    // 結果グリッドの直接編集
    // 単一表への単純な SELECT で、行を特定できる列（PK / UNIQUE）が結果に載っている
    // ときだけ有効。セルをダブルクリックすると入力欄になり、Enter で基底表へ
    // UPDATE を発行する。値は必ずプレースホルダでバインドする（SQL 組み立てを避ける）
    // ============================================================================
    // 「なぜ編集できないのか」を短い日本語にする。
    //
    // 理由の文言はエンジン（analyzeEditableSelect）が英語で返す。エンジンの
    // エラーは英語のままにする方針なので、UI 側でだけ言い換える。
    // 既定値も 'run a SELECT first' だったが、これは **SELECT を実行した直後にも出る**
    // ので明確な誤案内だった（JOIN の結果は単一の基底表へ対応付けられない、が真の理由）。
    // 対応表に無い理由は英語のまま出す（黙って消すより読めるほうがよい）
    const EDIT_REASON_JA = [
        [/not a simple SELECT/i,                  '複数表の結合や集約は、行を元の表に対応付けられません'],
        [/reads multiple base tables/i,           '複数の表を読んでいるため、更新先を決められません'],
        // `it uses JOIN` / `it uses GROUP BY` 等。構文名をそのまま見せたほうが、
        // なぜ編集できないのかが一目で判る
        [/it uses (.+)/i,                         '{0} を含む結果は、行を元の表に対応付けられません'],
        [/has no PRIMARY KEY or UNIQUE/i,         'この表に行を識別する主キー / UNIQUE がありません'],
        [/include (.+) in the result/i,           '{0} を結果に含めると編集できます'],
        [/is not a plain base-table column/i,     '計算列・別名列は直接更新できません'],
        [/there are no plain columns/i,           '素の列が無いため更新先を決められません'],
        [/not updatable|nested views/i,           'このビューは更新できません'],
        [/base table .* not found/i,              '元の表が見つかりません'],
        [/is not from a SELECT/i,                 'SELECT の結果ではありません'],
    ];
    function editReasonText(reason) {
        const raw = String(reason || '');
        for (const [re, ja] of EDIT_REASON_JA) {
            const m = re.exec(raw);
            // 捕獲がある対応表は、拾った構文名を {0} に差し込む
            if (m) return m[1] !== undefined ? i18nT(ja, m[1]) : i18nT(ja);
        }
        return raw;
    }

    function setEditContext(sql) {
        editContext = sql
            ? db.analyzeEditableSelect(sql)
            : { editable: false, reason: 'the result is not from a SELECT' };
        renderEditBadge();
        // 新しい結果セットでは行選択を解除する（行番号が別の行を指してしまうため）
        selectedRowIdx = null;
        setRowActionsEnabled();
    }

    function renderEditBadge() {
        const badge = document.getElementById('editBadge');
        const text = document.getElementById('editBadgeText');
        if (!badge || !text) return;
        if (editContext.editable) {
            // 青は「主要操作の地色」と「数値セルの文字色」で既に 2 つの意味を
            // 持っている。状態を示すバッジまで青にすると、グリッドを眺めたときに
            // 型の表現と状態の表現が混ざるので、こちらは緑系に分ける
            badge.className = 'inline-flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded border text-xs font-medium border-green-300 bg-green-50 text-green-800';
            text.textContent = i18nT('編集可: {0}', editContext.table);
            badge.title = i18nT('結果セルをダブルクリックすると {0} を直接更新します（キー: {1}）', editContext.table, editContext.keyCols.join(', '));
        } else {
            // 理由をバッジ本体に出す。以前は 'Read-only' の 3 語だけで、
            // なぜ編集できないのかは hover しないと読めなかった（タッチ環境では読めない）
            badge.className = 'inline-flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded border text-xs font-medium border-gray-200 bg-gray-50 text-gray-600';
            const why = editReasonText(editContext.reason);
            text.textContent = why ? i18nT('読み取り専用 — {0}', why) : i18nT('読み取り専用');
            badge.title = i18nT('直接編集できません: {0}', why);
        }
    }

    // 編集中のセルはひとつだけ。多重に開かないよう参照を持つ
    let activeEditor = null;

    function closeCellEditor(restore) {
        if (!activeEditor) return;
        const { td, original } = activeEditor;
        activeEditor = null;
        if (restore) { td.textContent = original.text; td.classList.remove('bg-blue-50'); }
    }

    function beginCellEdit(td) {
        if (!editContext.editable || activeEditor) return;
        // 保留中のセル詳細表示を取り消す（編集欄の上にモーダルが被るのを防ぐ）
        clearTimeout(cellClickTimer);
        const rows = filteredResultData();
        const row = rows[Number(td.dataset.r)];
        if (!row) return;
        const keys = Object.keys(row);
        const col = keys[Number(td.dataset.c)];
        // キー列そのものの編集は行の同定を壊すので許さない（実クライアントも同様）
        if (editContext.keyCols.includes(col)) { showToast(i18nT('キー列は直接編集できません。'), true); return; }
        const baseCol = editContext.colMap[col];
        if (!baseCol) { showToast(i18nT('列 \'{0}\' は基底表の列ではないため編集できません。', col), true); return; }

        const original = { text: td.textContent, value: row[col] };
        const input = document.createElement('input');
        input.type = 'text';
        input.value = row[col] === null || row[col] === undefined ? '' : String(row[col]);
        input.className = 'w-full bg-white border border-blue-400 rounded px-1 py-0.5 font-mono text-xs outline-none';
        td.textContent = '';
        td.classList.add('bg-blue-50');
        td.appendChild(input);
        activeEditor = { td, original, row, col, baseCol };
        input.focus();
        input.select();

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCellEdit(input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); closeCellEditor(true); }
        });
        input.addEventListener('blur', () => { if (activeEditor) closeCellEditor(true); });
    }

    // 入力文字列を列の型に合わせた値へ寄せる。空欄は NULL 扱い
    function coerceCellInput(text, prev) {
        if (text === '') return null;
        if (typeof prev === 'number' && text.trim() !== '' && !isNaN(text)) return Number(text);
        if (typeof prev === 'boolean') {
            const t = text.trim().toLowerCase();
            if (t === 'true' || t === '1') return true;
            if (t === 'false' || t === '0') return false;
        }
        return text;
    }

    function commitCellEdit(text) {
        if (!activeEditor) return;
        const { td, original, row, col, baseCol } = activeEditor;
        const newVal = coerceCellInput(text, original.value);
        activeEditor = null;
        td.classList.remove('bg-blue-50');
        if (newVal === original.value) { td.textContent = original.text; return; }

        // 値もキーもすべてプレースホルダでバインドする（文字列連結による SQL 組み立てを避ける）
        const keyBase = editContext.keyBase;
        const where = keyBase.map(c => `${c} = ?`).join(' AND ');
        const params = [newVal, ...editContext.keyCols.map(k => row[k])];
        const sql = `UPDATE ${editContext.table} SET ${baseCol} = ? WHERE ${where}`;
        let res;
        try { res = LuminaDB.query(sql, params); } catch (e) { res = { error: e.message }; }
        if (res && res.error) {
            td.textContent = original.text;
            showToast(res.error, true);
            logToConsole('error', sqlSummary(sql), res.error, sql);
            return;
        }
        row[col] = newVal;
        renderDisplay(true);
        renderTree();
        triggerAutoSave();
        showToast(i18nT('{0}.{1} を更新しました。', editContext.table, baseCol));
        logToConsole('query', sqlSummary(sql), i18nT('1 行処理 · セル編集'), sql);
    }

    els.resArea.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td');
        if (td && td.dataset.r !== undefined) beginCellEdit(td);
    });

    // ============================================================================
    // 行の追加・削除（編集可能なグリッドのみ）
    // 対象行はセルのクリックで選ばれた行。実DBクライアントと同じく、
    // 削除はキー列で 1 行だけを狙い撃ちする
    // ============================================================================
    let selectedRowIdx = null;

    function highlightSelectedRow() {
        els.resArea.querySelectorAll('#resultsTbody tr').forEach(tr => tr.classList.remove('bg-blue-50/60'));
        if (selectedRowIdx === null) return;
        const td = els.resArea.querySelector(`#resultsTbody td[data-r="${selectedRowIdx}"]`);
        if (td && td.parentElement) td.parentElement.classList.add('bg-blue-50/60');
    }

    function setRowActionsEnabled() {
        const add = document.getElementById('addRowBtn');
        const del = document.getElementById('delRowBtn');
        if (!add || !del) return;
        add.disabled = !editContext.editable;
        del.disabled = !editContext.editable || selectedRowIdx === null;
    }

    els.resArea.addEventListener('click', (e) => {
        const td = e.target.closest('td');
        if (!td || td.dataset.r === undefined) return;
        selectedRowIdx = Number(td.dataset.r);
        highlightSelectedRow();
        setRowActionsEnabled();
    });

    document.getElementById('addRowBtn').addEventListener('click', () => {
        if (!editContext.editable) return;
        // 空行を1つ足す。既定値・AUTO_INCREMENT はエンジン側が埋める
        const res = LuminaDB.query(`INSERT INTO ${editContext.table} DEFAULT VALUES`);
        if (res && res.error) { showToast(res.error, true); return; }
        showToast(i18nT('{0} に行を追加しました。', editContext.table));
        logToConsole('query', `INSERT INTO ${editContext.table} DEFAULT VALUES`, i18nT('1 行処理 · 行追加'), `INSERT INTO ${editContext.table} DEFAULT VALUES`);
        renderTree();
        triggerAutoSave();
        runQuery();   // 追加行を含めて取り直す
    });

    document.getElementById('delRowBtn').addEventListener('click', () => {
        if (!editContext.editable || selectedRowIdx === null) return;
        const rows = filteredResultData();
        const row = rows[selectedRowIdx];
        if (!row) return;
        const where = editContext.keyBase.map(c => `${c} = ?`).join(' AND ');
        const params = editContext.keyCols.map(k => row[k]);
        const sql = `DELETE FROM ${editContext.table} WHERE ${where}`;
        let res;
        try { res = LuminaDB.query(sql, params); } catch (err) { res = { error: err.message }; }
        if (res && res.error) { showToast(res.error, true); logToConsole('error', sqlSummary(sql), res.error, sql); return; }
        selectedRowIdx = null;
        showToast(i18nT('{0} から 1 行削除しました。', editContext.table));
        logToConsole('query', sqlSummary(sql), i18nT('1 行処理 · 行削除'), sql);
        renderTree();
        triggerAutoSave();
        runQuery();
    });

    els.dispLimit.addEventListener('change', () => renderDisplay(true));

    // 「件数」の表示を、いま画面が対象にしている行数へ合わせる。
    // 絞り込みで 15 件になっているのに件数は 5,000 のままで、
    // 脚注（15 / 15 件を表示）と画面の中で食い違っていた
    function refreshRowMetric() {
        if (!els.mRows || !currentResultData) return;
        const total = currentResultData.length;
        const shown = (typeof filteredResultData === 'function' ? filteredResultData() : currentResultData).length;
        els.mRows.textContent = shown === total
            ? total.toLocaleString()
            : i18nT('{0}（全 {1}）', shown.toLocaleString(), total.toLocaleString());
    }

    // 絞り込み入力: 入力のたびに再描画する（元データは保持したまま表示だけ絞る）
    if (els.resFilter) {
        els.resFilter.addEventListener('input', () => {
            resultFilter = els.resFilter.value;
            clearRowSelection();   // 絞り込みで添字の指す行が変わるため
            renderDisplay(true);
            refreshRowMetric();
        });
        document.getElementById('resultFilterClear').addEventListener('click', () => {
            els.resFilter.value = ''; resultFilter = ''; clearRowSelection(); renderDisplay(true);
            refreshRowMetric(); els.resFilter.focus();
        });
    }

    document.getElementById('resultsContainer').addEventListener('scroll', function(e) {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        if (scrollTop + clientHeight >= scrollHeight - 50) {
            renderDisplay(false);
        }
    });
