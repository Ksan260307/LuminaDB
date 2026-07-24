    // ============================================================================
    // [Query Runner] - クエリ実行と結果反映
    // ============================================================================
    // コンソールへ1行記録する薄いラッパ（console.js 未読込でも安全）
    // sql を渡すとコンソール上でクリック→エディタ再読込できる
    function logToConsole(type, msg, detail, sql) {
      if (typeof logConsole === 'function') logConsole(type, msg, detail, sql);
    }
    // ログ表示用にSQLを1行へ畳んで長さを制限する
    function sqlSummary(sql) {
      const one = String(sql).replace(/\s+/g, ' ').trim();
      return one.length > 120 ? one.slice(0, 117) + '...' : one;
    }

    function runQuery() {
      const sql = els.query.value.trim();
      if (!sql) return;

      if (sql.toLowerCase() === 'runtest') {
          logToConsole('info', 'runtest — テストスイートを実行');
          runTestSuite();
          return;
      }

      currentSort = { col: null, asc: true }; // reset sort on new query
      hideSuggestions();
      pushQueryHistory(sql);

      // ';' 区切りの複数文はスクリプトとして順次実行し、最後の結果セットを表示する
      const statements = db.splitStatements(sql);
      if (statements.length > 1) {
          const script = db.executeScript(sql);
          const errors = script.results.filter(r => r.error);
          const lastData = [...script.results].reverse().find(r => !r.error && r.data && r.data.length > 0);
          if (errors.length > 0) {
              // XSS対策: SQL・エラーメッセージともユーザー入力由来のためエスケープする
              els.resArea.innerHTML = `<div class="m-auto text-sm font-mono max-w-full overflow-auto p-4">`
                  + `<div class="text-red-600 font-medium mb-2">${script.succeeded} / ${script.total} 文が成功（エラー ${errors.length} 件）</div>`
                  + errors.map(e2 => `<div class="text-red-500 text-xs mb-1">${escapeHtml(e2.sql.slice(0, 80))} → ${escapeHtml(e2.error)}</div>`).join('')
                  + `</div>`;
              document.getElementById('exportCsvBtn').disabled = true;
              document.getElementById('exportJsonBtn').disabled = true;
              logToConsole('error', `Script: ${script.succeeded}/${script.total} 文成功`, `${errors.length} 件のエラー: ${errors[0] ? errors[0].error : ''}`, sql);
          } else if (lastData) {
              currentResultData = lastData.data;
              renderDisplay(true);
              const isObservation = lastData.data.length > 0 && !lastData.data[0].Result;
              document.getElementById('exportCsvBtn').disabled = !isObservation;
              document.getElementById('exportJsonBtn').disabled = !isObservation;
              showToast(`${script.succeeded} / ${script.total} 文を実行しました（最終結果 ${lastData.data.length.toLocaleString()} 件）。`);
          } else {
              els.resArea.innerHTML = `<div class="m-auto text-gray-400 text-sm">${script.succeeded} / ${script.total} statements executed.</div>`;
              showToast(`${script.succeeded} / ${script.total} 文を実行しました。`);
          }
          els.mTime.textContent = '---';
          els.mRows.textContent = String(script.total);
          renderTree();
          if (script.results.some(r => !r.error && !/^\s*(select|explain|show|describe|desc|table)\b/i.test(r.sql))) triggerAutoSave();
          return;
      }

      const res = db.executeQuery(sql);
      if (res.error) {
        // XSS対策: エラーメッセージにはユーザー入力由来の値が含まれるためエスケープする
        els.resArea.innerHTML = `<div class="m-auto text-red-600 text-sm font-mono font-medium">${escapeHtml(res.error)}</div>`;
        logToConsole('error', sqlSummary(sql), res.error, sql);
      } else {
        els.mTime.textContent = `${res.executionTime} ms`;
        els.mRows.textContent = res.scannedRows.toLocaleString();
        // 結果セット(SELECT等)は取得件数、DML/DDLは処理行数を表示する
        const isResultSet = Array.isArray(res.data) && (res.data.length === 0 || !res.data[0].Result);
        const detail = isResultSet
            ? `${res.data.length.toLocaleString()} 件取得 · ${res.executionTime} ms`
            : `${(res.scannedRows || 0).toLocaleString()} 行処理 · ${res.executionTime} ms`;
        logToConsole('query', sqlSummary(sql), detail, sql);

        currentResultData = res.data;
        renderDisplay(true);

        const isObservation = res.data && res.data.length > 0 && !res.data[0].Result;
        document.getElementById('exportCsvBtn').disabled = !isObservation;
        document.getElementById('exportJsonBtn').disabled = !isObservation;

        renderTree();
        if (!/^(select|explain)\s+/i.test(sql)) triggerAutoSave();
      }
    }
    document.getElementById('executeBtn').addEventListener('click', () => { saveQueryState(); runQuery(); });
