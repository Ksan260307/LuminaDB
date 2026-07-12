    // ============================================================================
    // [Query Runner] - クエリ実行と結果反映
    // ============================================================================
    function runQuery() {
      const sql = els.query.value.trim();
      if (!sql) return;

      if (sql.toLowerCase() === 'runtest') {
          runTestSuite();
          return;
      }

      currentSort = { col: null, asc: true }; // reset sort on new query
      hideSuggestions();

      const res = db.executeQuery(sql);
      if (res.error) {
        // XSS対策: エラーメッセージにはユーザー入力由来の値が含まれるためエスケープする
        els.resArea.innerHTML = `<div class="m-auto text-red-600 text-sm font-mono font-medium">${escapeHtml(res.error)}</div>`;
      } else {
        els.mTime.textContent = `${res.executionTime} ms`;
        els.mRows.textContent = res.scannedRows.toLocaleString();

        currentResultData = res.data;
        renderDisplay(true);

        const isObservation = res.data && res.data.length > 0 && !res.data[0].Result;
        document.getElementById('exportCsvBtn').disabled = !isObservation;

        renderTree();
        if (!/^(select|explain)\s+/i.test(sql)) triggerAutoSave();
      }
    }
    document.getElementById('executeBtn').addEventListener('click', () => { saveQueryState(); runQuery(); });
