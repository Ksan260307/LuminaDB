    // ============================================================================
    // [Results] - 結果テーブルの描画 / ソート / 無限スクロール
    // ============================================================================
    let currentDisplayOffset = 0;
    const CHUNK_SIZE = 50;

    // --- Interactive Sorting ---
    els.resArea.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th || !currentResultData || currentResultData.length === 0) return;

        const col = th.dataset.col;
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

        renderDisplay(true);
    });

    function renderDisplay(reset = true) {
       if (reset) {
           els.resArea.innerHTML = '';
           currentDisplayOffset = 0;
           document.getElementById('resultsContainer').scrollTop = 0;
       }

       if (!currentResultData || currentResultData.length === 0) {
          if (reset) els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">No rows returned.</div>`;
          return;
       }

       const limitVal = els.dispLimit.value;
       const limit = limitVal === 'all' ? currentResultData.length : parseInt(limitVal, 10);
       const targetData = currentResultData.slice(0, limit);

       if (currentDisplayOffset >= targetData.length) return;

       const chunk = targetData.slice(currentDisplayOffset, currentDisplayOffset + CHUNK_SIZE);

       const keys = Object.keys(currentResultData[0]);
       let ths = `<tr>${keys.map(k => {
           let sortIcon = '<span class="text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity ml-1">⇅</span>';
           if (currentSort.col === k) {
               sortIcon = currentSort.asc
                   ? '<span class="text-blue-500 ml-1 inline-block transform">↑</span>'
                   : '<span class="text-blue-500 ml-1 inline-block transform">↓</span>';
           }
           return `<th class="px-4 py-2 font-semibold border-r border-gray-200 last:border-0 sticky top-0 bg-gray-100 shadow-sm z-20 cursor-pointer hover:bg-gray-200 select-none group" data-col="${escapeHtml(k)}">${escapeHtml(k)}${sortIcon}</th>`;
       }).join('')}</tr>`;

       let trs = chunk.map(row => {
          let tds = Object.values(row).map(v => {
             // XSS対策: セル値は必ずエスケープしてから innerHTML へ挿入する
             const esc = escapeHtml(v);
             if(v==="Success"||v==="PASS"||(typeof v==='string' && (v.includes("inserted")||v.includes("updated")||v.includes("deleted")))){
                 return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-green-600 font-medium">${esc}</td>`;
             }
             if(v==="FAIL"||(typeof v==='string' && v.includes("Assertion") && !v.includes("not found"))){
                 return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-red-600 font-medium">${esc}</td>`;
             }
             if(typeof v==='number') return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-blue-600">${v}</td>`;
             if(typeof v==='boolean') return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-purple-600 font-semibold">${v}</td>`;
             if(v===null) return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-gray-400 italic">null</td>`;
             // エラーメッセージの特別なハイライト
             if(typeof v==='string' && (v.includes("not found") || v.includes("Type mismatch") || v.includes("Foreign key constraint failed"))) return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-red-600 font-bold bg-red-50">${esc}</td>`;
             return `<td class="px-4 py-1.5 border-r border-gray-200 last:border-0 text-gray-700">${esc}</td>`;
          }).join('');
          return `<tr class="hover:bg-gray-50 border-b border-gray-100 last:border-0">${tds}</tr>`;
       }).join('');

       if (reset) {
           els.resArea.innerHTML = `
              <div class="rounded-lg border border-gray-200 overflow-hidden bg-white w-fit min-w-full shadow-sm relative z-10 flex flex-col h-full">
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

       const noteEl = els.resArea.querySelector('#resultsNote');
       if (noteEl) {
           if (currentDisplayOffset >= targetData.length) {
               noteEl.innerHTML = `Showing top ${targetData.length.toLocaleString()} rows out of ${currentResultData.length.toLocaleString()}.`;
               noteEl.classList.remove('hidden');
           } else {
               noteEl.classList.add('hidden');
           }
       }
    }

    // データセルのクリックでその値をクリップボードへコピーする（ヘッダーのソートとは別経路）
    els.resArea.addEventListener('click', (e) => {
        const td = e.target.closest('td');
        if (!td) return;
        const text = td.textContent === 'null' ? '' : td.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => showToast('セルの値をコピーしました。')).catch(() => {});
        }
    });

    els.dispLimit.addEventListener('change', () => renderDisplay(true));

    document.getElementById('resultsContainer').addEventListener('scroll', function(e) {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        if (scrollTop + clientHeight >= scrollHeight - 50) {
            renderDisplay(false);
        }
    });
