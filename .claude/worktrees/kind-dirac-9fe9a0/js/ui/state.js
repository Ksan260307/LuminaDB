    // ============================================================================
    // [UI State] - 共有状態 / DOM参照 / トースト表示
    // ============================================================================
    let db = new DatabaseEngine();
    let currentResultData = null;
    let currentSort = { col: null, asc: true };
    let isTesting = false;

    // 結果グリッドの絞り込み文字列（全列を対象にした部分一致。空なら絞り込みなし）
    let resultFilter = '';
    // 結果グリッドの直接編集の可否。db.analyzeEditableSelect() の結果を保持する
    // （{ editable, table, keyCols, colMap } / { editable: false, reason }）
    let editContext = { editable: false, reason: 'run a SELECT first' };

    const els = {
       query: document.getElementById('queryInput'),
       hl: document.getElementById('highlightLayer'),
       suggestBox: document.getElementById('suggestBox'),
       resArea: document.getElementById('resultsArea'),
       mTime: document.getElementById('metricTime'),
       mRows: document.getElementById('metricRows'),
       dispLimit: document.getElementById('displayLimit'),
       resFilter: document.getElementById('resultFilter'),
       toastMsg: document.getElementById('toastMsg')
    };

    // XSS対策: ユーザー由来の値を innerHTML へ挿入する前に必ずエスケープする
    function escapeHtml(v) {
      return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function showToast(msg, isError = false) {
      els.toastMsg.textContent = msg;
      els.toastMsg.className = `absolute bottom-4 right-4 px-4 py-2 rounded shadow-lg transition-opacity duration-300 z-50 text-sm font-medium ${isError ? 'bg-red-100 text-red-800 border border-red-300' : 'bg-green-100 text-green-800 border border-green-300'}`;
      els.toastMsg.style.opacity = 1;
      setTimeout(() => els.toastMsg.style.opacity = 0, 3000);
    }
