    // ============================================================================
    // [UI State] - 共有状態 / DOM参照 / トースト表示
    // ============================================================================
    let db = new DatabaseEngine();
    let currentResultData = null;
    let currentSort = { col: null, asc: true };
    let isTesting = false;

    const els = {
       query: document.getElementById('queryInput'),
       hl: document.getElementById('highlightLayer'),
       suggestBox: document.getElementById('suggestBox'),
       resArea: document.getElementById('resultsArea'),
       mTime: document.getElementById('metricTime'),
       mRows: document.getElementById('metricRows'),
       dispLimit: document.getElementById('displayLimit'),
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
