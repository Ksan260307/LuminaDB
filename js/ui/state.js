    // ============================================================================
    // [UI State] - 共有状態 / DOM参照 / トースト表示
    // ============================================================================
    let db = new DatabaseEngine();
    // 画面から実行する文には既定の時間上限を置く。
    //
    // JavaScript は単一スレッドなので、同期実行中のクエリを Cancel ボタンで止める
    // ことはできない（クリックのイベントがそもそも処理されない）。上限が無いと
    // 暴走したクエリでタブが固まったまま、閉じる以外の手が無くなる。
    // 30 秒あれば普通の集計・結合は通り、事故は自分で止まる。
    // 外したい / 変えたいときは `SET statement_timeout = 0` / `= 60000`。
    //
    // エンジン既定は 0（無制限）のままにしてある。ライブラリとして使う場合は
    // 上限を決めるのは呼ぶ側の仕事なので、UI の方針を押し付けない
    db.statementTimeoutMs = 30000;
    let currentResultData = null;
    let currentSort = { col: null, asc: true };
    let isTesting = false;

    // 結果グリッドの絞り込み文字列（全列を対象にした部分一致。空なら絞り込みなし）
    let resultFilter = '';
    // 結果グリッドの直接編集の可否。db.analyzeEditableSelect() の結果を保持する
    // （{ editable, table, keyCols, colMap } / { editable: false, reason }）
    let editContext = { editable: false, reason: 'the result is not from a SELECT' };

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

    // 画面右下の一時メッセージ。
    //
    // 注意が 3 つある。
    //  1. **pointer-events-none を落とさないこと**。className を丸ごと差し替える書き方で
    //     HTML 側に付けてあったこのクラスが消え、透明（opacity:0）のまま当たり判定だけが
    //     結果グリッドの右下に残り続けていた。一度トーストが出ると以降そこのセルが
    //     クリックできなくなる（見えないので原因に辿り着けない）。
    //  2. **タイマーを持ち回ること**。使い回しの 1 要素なので、前回の消灯タイマーが
    //     生きていると次のメッセージが 3 秒経たずに消える。
    //  3. **aria-live で読ませること**。保存・コピー・実行結果の通知はここにしか出ないので、
    //     これが無いと支援技術には一切届かない（HTML 側で role/aria-live を宣言してある）。
    let toastTimer = null;
    // action: { label, fn } を渡すと、押せるボタン付きのトーストになる。
    // 「全行を書き換えました → 元に戻す」のように、直後だけ意味のある操作を
    // その場で出すために使う。ボタン付きのときは長めに出し、
    // 当たり判定も戻す（通常のトーストは pointer-events-none のまま）
    function showToast(msg, isError = false, action = null) {
      const el = els.toastMsg;
      clearTimeout(toastTimer);
      el.textContent = '';
      const text = document.createElement('span');
      text.textContent = msg;
      el.appendChild(text);
      if (action && typeof action.fn === 'function') {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = action.label;
        b.className = 'ml-3 underline font-semibold hover:no-underline';
        b.addEventListener('click', () => { el.style.opacity = 0; action.fn(); });
        el.appendChild(b);
      }
      el.className = `absolute bottom-4 right-4 px-4 py-2 rounded shadow-lg transition-opacity duration-300 z-50 text-sm font-medium `
        + (action ? '' : 'pointer-events-none ')
        + (isError ? 'bg-red-100 text-red-800 border border-red-300' : 'bg-green-100 text-green-800 border border-green-300');
      // 緊急度を切り替える。エラーは読み上げ中の内容に割り込ませる
      el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
      el.style.opacity = 1;
      toastTimer = setTimeout(() => el.style.opacity = 0, action ? 12000 : 3000);
    }
