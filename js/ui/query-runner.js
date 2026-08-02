    // ============================================================================
    // [Query Runner] - クエリ実行と結果反映
    // ============================================================================
    // コンソールへ1行記録する薄いラッパ（console.js 未読込でも安全）
    // sql を渡すとコンソール上でクリック→エディタ再読込できる
    function logToConsole(type, msg, detail, sql) {
      if (typeof logConsole === 'function') logConsole(type, msg, detail, sql);
    }
    // 結果セットの書き出し系ボタンをまとめて有効/無効にする
    function setResultExportEnabled(on) {
      ['exportCsvBtn', 'exportJsonBtn', 'copyMdBtn', 'copyInsertBtn']
          .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !on; });
    }

    // ログ表示用にSQLを1行へ畳んで長さを制限する
    function sqlSummary(sql) {
      const one = String(sql).replace(/\s+/g, ' ').trim();
      return one.length > 120 ? one.slice(0, 117) + '...' : one;
    }

    // カーソル位置の 1 文だけを実行する（Ctrl+Enter）。
    // エディタの内容は変えず、その文を一時的に渡して runQuery を再利用する
    function runQueryAtCursor() {
      const stmt = statementAtCursor(els.query.value, els.query.selectionStart);
      if (!stmt) { runQuery(); return; }
      // 全文と同じなら通常実行（絞り込みの表示ノイズを出さない）
      if (stmt === els.query.value.trim().replace(/;$/, '').trim()) { runQuery(); return; }
      runQuery(stmt);
    }

    // sqlOverride を渡すとエディタの内容ではなくその文を実行する
    function runQuery(sqlOverride) {
      const sql = (sqlOverride === undefined ? els.query.value : sqlOverride).trim();
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
              setResultExportEnabled(false);
              logToConsole('error', `Script: ${script.succeeded}/${script.total} 文成功`, `${errors.length} 件のエラー: ${errors[0] ? errors[0].error : ''}`, sql);
          } else if (lastData) {
              currentResultData = lastData.data;
              renderDisplay(true);
              const isObservation = lastData.data.length > 0 && !lastData.data[0].Result;
              setResultExportEnabled(isObservation);
              showToast(`${script.succeeded} / ${script.total} 文を実行しました（最終結果 ${lastData.data.length.toLocaleString()} 件）。`);
          } else {
              els.resArea.innerHTML = `<div class="m-auto text-gray-400 text-sm">${script.succeeded} / ${script.total} statements executed.</div>`;
              showToast(`${script.succeeded} / ${script.total} 文を実行しました。`);
          }
          els.mTime.textContent = '---';
          els.mRows.textContent = String(script.total);
          // 複数文スクリプトの結果はどの文に由来するか特定できないので編集不可にする
          setEditContext(null);
          renderTree();
          if (script.results.some(r => !r.error && !/^\s*(select|explain|show|describe|desc|table)\b/i.test(r.sql))) triggerAutoSave();
          renderTxnState();
          return;
      }

      const res = db.executeQuery(sql);
      if (res.error) {
        // XSS対策: エラーメッセージにはユーザー入力由来の値が含まれるためエスケープする
        els.resArea.innerHTML = `<div class="m-auto text-red-600 text-sm font-mono font-medium">${escapeHtml(res.error)}</div>`;
        setEditContext(null);
        logToConsole('error', sqlSummary(sql), res.error, sql);
        (res.warnings || []).forEach(w => logToConsole('warn', `${w.Code}`, w.Message, sql));
      } else {
        els.mTime.textContent = `${res.executionTime} ms`;
        els.mRows.textContent = res.scannedRows.toLocaleString();
        // 結果セット(SELECT等)は取得件数、DML/DDLは処理行数を表示する
        const isResultSet = Array.isArray(res.data) && (res.data.length === 0 || !res.data[0].Result);
        const detail = isResultSet
            ? `${res.data.length.toLocaleString()} 件取得 · ${res.executionTime} ms`
            : `${(res.scannedRows || 0).toLocaleString()} 行処理 · ${res.executionTime} ms`;
        logToConsole('query', sqlSummary(sql), detail, sql);
        // 文が出した警告（黙って無視された DDL・WHERE なしの全行更新など）を
        // コンソールへ出す。SQL からは SHOW WARNINGS でも読める
        (res.warnings || []).forEach(w => logToConsole('warn', `${w.Code}`, w.Message, sql));

        currentResultData = res.data;
        // 結果グリッドの直接編集の可否を判定してから描画する
        const isSelect = /^select\b/i.test(sql);
        setEditContext(isSelect ? sql : null);
        renderDisplay(true);

        const isObservation = res.data && res.data.length > 0 && !res.data[0].Result;
        setResultExportEnabled(isObservation);

        renderTree();
        if (!/^(select|explain)\s+/i.test(sql)) triggerAutoSave();
      }
      renderTxnState();
    }
    document.getElementById('executeBtn').addEventListener('click', () => { saveQueryState(); runQuery(); });

    // ============================================================================
    // トランザクション操作バー
    // 明示的な境界を UI から扱えるようにする（実DBクライアントと同じ操作体系）。
    // 自動保存はトランザクション中に走らせない（未確定の状態を永続化しないため）
    // ============================================================================
    function renderTxnState() {
      const inTx = !!(db && db.inTransaction);
      const dot = document.getElementById('txnDot');
      const label = document.getElementById('txnLabel');
      const ind = document.getElementById('txnIndicator');
      if (!dot || !label || !ind) return;
      dot.className = `w-2 h-2 rounded-full ${inTx ? 'bg-amber-500 animate-pulse' : 'bg-gray-300'}`;
      label.textContent = inTx ? `IN TRANSACTION (${db.undoLog.length} 変更)` : 'AUTOCOMMIT';
      ind.className = `inline-flex items-center gap-1.5 font-semibold ${inTx ? 'text-amber-600' : 'text-gray-400'}`;
      document.getElementById('txnBeginBtn').disabled = inTx;
      document.getElementById('txnCommitBtn').disabled = !inTx;
      document.getElementById('txnRollbackBtn').disabled = !inTx;
    }

    // トランザクション文をエディタを経由せず直接実行する（履歴も汚さない）
    function runTxnCommand(sql) {
      const res = db.executeQuery(sql);
      if (res.error) {
        showToast(res.error, true);
        logToConsole('error', sqlSummary(sql), res.error, sql);
      } else {
        showToast(res.data[0].Message || sql);
        logToConsole('query', sqlSummary(sql), res.data[0].Message || '', sql);
        renderTree();
        // COMMIT / ROLLBACK でメモリ上の状態が確定したので永続化を促す
        if (/^(commit|rollback)/i.test(sql)) triggerAutoSave();
      }
      renderTxnState();
    }

    document.getElementById('txnBeginBtn').addEventListener('click', () => runTxnCommand('BEGIN'));
    document.getElementById('txnCommitBtn').addEventListener('click', () => runTxnCommand('COMMIT'));
    document.getElementById('txnRollbackBtn').addEventListener('click', () => runTxnCommand('ROLLBACK'));
    renderTxnState();
