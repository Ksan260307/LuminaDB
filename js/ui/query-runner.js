    // ============================================================================
    // [Query Runner] - クエリ実行と結果反映
    // ============================================================================
    // コンソールへ1行記録する薄いラッパ（console.js 未読込でも安全）
    // sql を渡すとコンソール上でクリック→エディタ再読込できる
    function logToConsole(type, msg, detail, sql) {
      if (typeof logConsole === 'function') logConsole(type, msg, detail, sql);
    }
    // 結果セットの書き出し系ボタンをまとめて有効/無効にする。
    // 5 つは「書き出し ▾」メニューの中にあるので、開くボタンも一緒に切り替える
    function setResultExportEnabled(on) {
      ['exportCsvBtn', 'exportJsonBtn', 'copyMdBtn', 'copyTsvBtn', 'copyInsertBtn', 'exportMenuBtn']
          .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !on; });
      if (!on && typeof closeExportMenu === 'function') closeExportMenu();
    }

    // ------------------------------------------------------------------
    // 「書き出し ▾」メニューの開閉
    // ------------------------------------------------------------------
    function closeExportMenu() {
        const menu = document.getElementById('exportMenu');
        const btn = document.getElementById('exportMenuBtn');
        if (!menu || menu.classList.contains('hidden')) return;
        const hadFocus = menu.contains(document.activeElement);
        menu.classList.add('hidden');
        if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            if (hadFocus) { try { btn.focus(); } catch (e) { /* 消えていれば何もしない */ } }
        }
    }
    (function bindExportMenu() {
        const menu = document.getElementById('exportMenu');
        const btn = document.getElementById('exportMenuBtn');
        if (!menu || !btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = menu.classList.contains('hidden');
            menu.classList.toggle('hidden', !opening);
            btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
            if (opening) {
                const first = menu.querySelector('button:not([disabled])');
                if (first) setTimeout(() => { try { first.focus(); } catch (e2) {} }, 0);
            }
        });
        // 項目を選んだら閉じる（実際の処理は data-io.js 側の個別ハンドラが行う）
        menu.addEventListener('click', (e) => { if (e.target.closest('button')) closeExportMenu(); });
        menu.addEventListener('keydown', (e) => {
            const items = [...menu.querySelectorAll('button:not([disabled])')];
            const i = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeExportMenu(); }
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest || (!e.target.closest('#exportMenu') && !e.target.closest('#exportMenuBtn'))) closeExportMenu();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportMenu(); });
    })();

    // ログ表示用にSQLを1行へ畳んで長さを制限する
    function sqlSummary(sql) {
      const one = String(sql).replace(/\s+/g, ' ').trim();
      return one.length > 120 ? one.slice(0, 117) + '...' : one;
    }

    // 「結果セット」か「DML/DDL の状態行」かを 1 か所で判定する。
    // 以前は `!res.data[0].Result` で見ていたため、`SELECT note AS Result FROM t` の
    // ように Result という列名を持つ**本物の結果セット**が状態行と誤判定され、
    // 書き出し・コピーの5ボタンが理由も出さずに無効化されていた。
    // 状態行は必ず {Result, Message} の2キーだけなので、そこまで見て判定する
    function isStatusRows(data) {
      if (!Array.isArray(data) || data.length === 0) return false;
      const k = Object.keys(data[0]);
      return k.length === 2 && k.includes('Result') && k.includes('Message');
    }
    function isResultSet(data) {
      return Array.isArray(data) && !isStatusRows(data);
    }
    window.isStatusRows = isStatusRows;
    window.isResultSet = isResultSet;

    // 複数文スクリプトの結果セット群。タブで切り替える。
    // 要素は成功なら { sql, data }、失敗なら { sql, error }。
    // 失敗した文もタブとして並べるのは、以前「1 文でも転ぶと成功分の結果を
    // 全部捨てて要約だけ出す」実装だったため。10 文中 8 文目が転ぶと
    // 1〜7 の結果がまとめて見えなくなっていた
    let scriptResultSets = [];
    let scriptActiveSet = 0;

    function renderResultTabs() {
      const wrap = document.getElementById('resultTabs');
      if (!wrap) return;
      if (scriptResultSets.length < 2) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }
      wrap.classList.remove('hidden');
      wrap.innerHTML = scriptResultSets.map((s, i) => {
        const on = i === scriptActiveSet;
        const bad = !!s.error;
        const cls = on
            ? (bad ? 'bg-white border-red-300 border-b-white text-red-700 font-semibold'
                   : 'bg-white border-gray-300 border-b-white text-blue-700 font-semibold')
            : (bad ? 'bg-red-50 border-red-200 text-red-600 hover:bg-red-100'
                   : 'bg-gray-100 border-gray-200 text-gray-600 hover:bg-gray-50');
        // 失敗した文は件数の代わりにエラー印を出す
        const tail = bad ? '⚠' : s.data.length.toLocaleString();
        const tip = bad ? `${sqlSummary(s.sql)} → ${s.error}` : sqlSummary(s.sql);
        return `<button type="button" data-set="${i}" title="${escapeHtml(tip)}"`
            + ` class="text-xs px-2.5 py-1 border rounded-t -mb-px ${cls}">`
            + `#${i + 1} · ${escapeHtml(shortLabel(s.sql))} · ${tail}</button>`;
      }).join('');
    }

    // タブに出す短い見出し（文の種類＋対象名）
    function shortLabel(sql) {
      const one = String(sql).replace(/\s+/g, ' ').trim();
      const m = one.match(/^\s*(select|with|table|values|show|describe|desc|explain|pragma)\b/i);
      const verb = m ? m[1].toUpperCase() : one.split(/\s+/)[0].toUpperCase();
      const t = one.match(/\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
      return t ? `${verb} ${t[1]}` : verb;
    }

    function showResultSet(i) {
      if (!scriptResultSets[i]) return;
      scriptActiveSet = i;
      const s = scriptResultSets[i];
      if (s.error) {
        // 「エラー」の見出しを付けて、何を読まされているのかを明示する。
        // エンジンのメッセージは英語なので、見出しが無いと結果セットとの区別が付きにくい。
        // XSS対策: SQL・エラーメッセージともユーザー入力由来なのでエスケープする
        els.resArea.innerHTML = `<div class="m-auto text-sm font-mono max-w-full overflow-auto p-4">`
            + `<div class="text-red-600 font-semibold mb-1">${escapeHtml(i18nT('エラー'))}</div>`
            + `<div class="text-red-600 font-medium mb-2">${escapeHtml(s.error)}</div>`
            + `<div class="text-gray-600 text-xs whitespace-pre-wrap">${escapeHtml(s.sql)}</div>`
            + `</div>`;
        currentResultData = [];
        setEditContext(null);
        setResultExportEnabled(false);
        els.mRows.textContent = '---';
        renderResultTabs();
        return;
      }
      currentResultData = s.data;
      currentSort = { col: null, asc: true };
      renderDisplay(true);
      setResultExportEnabled(isResultSet(s.data) && s.data.length > 0);
      els.mRows.textContent = s.data.length.toLocaleString();
      renderResultTabs();
    }
    // タブは差し替わるのでイベント委譲で拾う
    (function bindResultTabs() {
      const wrap = document.getElementById('resultTabs');
      if (!wrap) return;
      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-set]');
        if (b) showResultSet(Number(b.getAttribute('data-set')));
      });
    })();

    function clearResultTabs() {
      scriptResultSets = [];
      scriptActiveSet = 0;
      renderResultTabs();
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

    // ------------------------------------------------------------------
    // 実行中の表示。
    //
    // メインスレッドの実行は同期なので、走っている間ブラウザは何も描けない。
    // 以前はそのため進行中の合図が一切無く、重いクエリではタブが固まったまま
    // 既定 30 秒の上限まで**完全に無反応**だった（ワーカー実行という逃げ道は
    // あるのに、それが要る場面に入ってから気づく導線が無かった）。
    //
    // 「busy を描く → 1 フレーム譲る → 実行する」の順にして、
    // 少なくとも走り出したことが判るようにする。実行そのものは同期のままなので、
    // テストが呼ぶ runQuery() の契約は変えていない
    // ------------------------------------------------------------------
    const SLOW_HINT_MS = 1500;   // これを超えたらワーカー実行を案内する
    function setRunBusy(on) {
        const run = document.getElementById('executeBtn');
        const bg = document.getElementById('bgRunBtn');
        if (run) {
            run.disabled = on;
            run.textContent = on ? i18nT('実行中…') : i18nT('実行');
            run.setAttribute('aria-busy', on ? 'true' : 'false');
        }
        if (bg) bg.disabled = on;
        const area = document.getElementById('resultsContainer');
        if (area) area.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    // 画面から呼ぶ実行。busy を 1 タスク分見せてから同期実行する
    function runQueryFromUi(sqlOverride, atCursor) {
        const src = (sqlOverride === undefined ? els.query.value : sqlOverride).trim();
        const runNow = () => { if (atCursor) runQueryAtCursor(); else runQuery(sqlOverride); };
        // runtest と空文は busy を出さない（前者は自前で進行を出す）。
        //
        // テスト中も遅らせない。**executeBtn.click() の直後に結果を読む**検査が
        // 多数あり、遅らせるとそれが全部空振りする。busy 表示は人向けの演出なので、
        // 自動実行のときは素通しでよい
        if (!src || src.toLowerCase() === 'runtest' || (typeof isTesting !== 'undefined' && isTesting)) {
            runNow();
            return;
        }
        setRunBusy(true);
        // rAF は隠れたタブで発火しないので setTimeout だけで 1 タスク譲る
        setTimeout(() => {
            const t0 = performance.now();
            try {
                runNow();
            } finally {
                setRunBusy(false);
            }
            // 待たされたときだけ、次はワーカーで走らせられることを伝える。
            // 毎回出すと邪魔なので、閾値を超えたときと参照系のときに限る
            const ms = performance.now() - t0;
            if (ms >= SLOW_HINT_MS && typeof db._isReadOnlyStatement === 'function') {
                try {
                    const stmts = db.splitStatements(src);
                    if (stmts.every(st => db._isReadOnlyStatement(st))) {
                        logToConsole('info', i18nT('{0} ms かかりました', ms.toFixed(0)),
                            i18nT('Run ⧉（Ctrl+Alt+Enter）で実行すると画面が固まらず、途中で止められます。'));
                    }
                } catch (e) { /* 判定できなければ案内しないだけ */ }
            }
        }, 0);
    }

    // ------------------------------------------------------------------
    // 取り返しのつかない DML の直前に、退避を取っておく。
    //
    // WHERE なしの UPDATE / DELETE / TRUNCATE は、押した瞬間に全行が変わる。
    // エンジンは NO_WHERE 警告を出しているが、受け皿のコンソールは既定で閉じている。
    // そのうえ元に戻す手段が実質無く（トランザクションは手で開いた人だけ、
    // スナップショットは SQL からしか作れない）、自動保存が 1 秒後に確定させる。
    //
    // ここでは実行の直前に内部スナップショットを取り、成功したら
    // 「元に戻す」付きのトーストを出す。名前は '__' 始まりなので
    // SHOW SNAPSHOTS には出ない（利用者の一覧を汚さない）
    // ------------------------------------------------------------------
    const UNDO_SNAPSHOT = '__undo';
    // 退避のコストは DB の大きさに比例する。大きすぎるときは取らずに、
    // 取らなかったことを伝える（黙って諦めない）
    const UNDO_MAX_ROWS = 300000;

    // WHERE を伴わない UPDATE / DELETE と TRUNCATE。
    // 文字列リテラルの中の 'where' に反応しないよう、退避してから見る
    function isUnguardedDml(sql) {
        // 文字列リテラルと行コメントを空に潰してから見る
        // （データの中の 'where' に反応しないように）。
        // 正規表現でエスケープを重ねるより、1 文字ずつ見るほうが読み違えない
        let bare = '', inStr = false, i = 0;
        const src = String(sql);
        while (i < src.length) {
            const ch = src[i];
            if (inStr) {
                if (ch === '\\') { i += 2; continue; }
                if (ch === "'") inStr = false;
                i++;
                continue;
            }
            if (ch === "'") { inStr = true; bare += ' '; i++; continue; }
            if (ch === '-' && src[i + 1] === '-') {
                while (i < src.length && src[i] !== '\n') i++;
                bare += ' ';
                continue;
            }
            bare += ch;
            i++;
        }
        if (/^\s*truncate\s+/i.test(bare)) return true;
        if (!/^\s*(update|delete)\s+/i.test(bare)) return false;
        return !/\bwhere\b/i.test(bare);
    }

    function dbRowCount() {
        let n = 0;
        for (const t of Object.keys(db.tables)) n += db.tables[t].rowCount || 0;
        return n;
    }

    // 退避を試みる。取れたら true
    function takeUndoSnapshot() {
        if (db.inTransaction) return false;        // トランザクション中は ROLLBACK が本来の手段
        if (dbRowCount() > UNDO_MAX_ROWS) return false;
        try {
            db.executeQuery(`DROP SNAPSHOT IF EXISTS ${UNDO_SNAPSHOT}`);
            const r = db.executeQuery(`CREATE SNAPSHOT ${UNDO_SNAPSHOT}`);
            return !r.error;
        } catch (e) { return false; }
    }

    function restoreUndoSnapshot() {
        const r = db.executeQuery(`RESTORE SNAPSHOT ${UNDO_SNAPSHOT}`);
        if (r.error) { showToast(i18nT('元に戻せませんでした: {0}', r.error), true); return; }
        db.executeQuery(`DROP SNAPSHOT IF EXISTS ${UNDO_SNAPSHOT}`);
        currentResultData = null;
        setEditContext(null);
        renderTree();
        renderDisplay(true);
        triggerAutoSave();
        showToast(i18nT('実行前の状態へ戻しました。'));
    }

    // sqlOverride を渡すとエディタの内容ではなくその文を実行する
    function runQuery(sqlOverride) {
      const sql = (sqlOverride === undefined ? els.query.value : sqlOverride).trim();
      // 空のまま押されたら黙って帰らない。画面でいちばん大きいボタンが
      // 無反応なのは、初めて触った人にとって行き止まりでしかない
      if (!sql) {
        showToast(i18nT('SQL を入力してから実行してください。表をクリックすると例が入ります。'), true);
        return;
      }

      if (sql.toLowerCase() === 'runtest') {
          logToConsole('info', i18nT('runtest — テストスイートを実行'));
          // テストは製品ページに同梱していないので、初回だけ取り寄せる
          loadTestSuites()
              .then(() => runTestSuite())
              .catch(e => {
                  logToConsole('error', i18nT('テストの読み込みに失敗しました: {0}', e.message));
              });
          return;
      }

      currentSort = { col: null, asc: true }; // reset sort on new query
      hideSuggestions();
      pushQueryHistory(sql);
      clearResultTabs();

      // ';' 区切りの複数文はスクリプトとして順次実行し、最後の結果セットを表示する
      const statements = db.splitStatements(sql);
      if (statements.length > 1) {
          const script = db.executeScript(sql);
          const errors = script.results.filter(r => r.error);
          // 表示する結果セットは「最後の**結果セット**」。以前は
          // `data.length > 0` の最後を探していたため、末尾の SELECT が 0 件だと
          // 途中の別の文の結果を「答え」として出していた（0 件の DELETE の後に
          // 状態行が出る、途中の SELECT 1 が出る等）。
          // 結果セットが複数あるときはタブで全部見られるようにする。
          // **失敗した文もタブに混ぜる**（以前はエラーが 1 件でもあると
          // 成功分の結果セットを丸ごと捨てて要約だけ出していた）
          scriptResultSets = script.results
              .filter(r => r.error || isResultSet(r.data))
              .map(r => r.error ? { sql: r.sql, error: r.error } : { sql: r.sql, data: r.data });
          const okSets = scriptResultSets.filter(r => !r.error);
          const lastData = okSets.length > 0 ? okSets[okSets.length - 1] : null;
          if (errors.length > 0) {
              // 最初に転んだ文を開いておく（原因から読み始められるように）。
              // 成功分は隣のタブに残るので、そのまま見比べられる
              const firstBad = scriptResultSets.findIndex(r => r.error);
              scriptActiveSet = firstBad >= 0 ? firstBad : 0;
              showResultSet(scriptActiveSet);
              showToast(i18nT('{0} / {1} 文が成功（{2}）。タブで結果とエラーを切り替えられます。',
                  script.succeeded, script.total,
                  i18nPlural(errors.length, 'エラー', 'error', 'errors')), true);
              logToConsole('error', i18nT('Script: {0}/{1} 文成功', script.succeeded, script.total), i18nT('{0} 件のエラー: {1}', errors.length, errors[0] ? errors[0].error : ''), sql);
          } else if (lastData) {
              scriptActiveSet = scriptResultSets.length - 1;
              // 末尾の結果セットを既定で見せる（0 件でも「0 件だった」と分かるように出す）
              showResultSet(scriptActiveSet);
              const label = lastData.data.length === 0
                  ? i18nT('最終結果 0 件')
                  : i18nT('最終結果 {0} 件', lastData.data.length.toLocaleString());
              const tabs = scriptResultSets.length > 1 ? i18nT('／結果セット {0} 個', scriptResultSets.length) : '';
              showToast(i18nT('{0} / {1} 文を実行しました（{2}{3}）。', script.succeeded, script.total, label, tabs));
          } else {
              els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">${escapeHtml(i18nT('{0} / {1} 文を実行しました（返す行はありません）。', script.succeeded, script.total))}</div>`;
              clearResultTabs();
              showToast(i18nT('{0} / {1} 文を実行しました。', script.succeeded, script.total));
          }
          // 実行時間は各文の合計、件数は表示中の結果セットの件数（showResultSet が設定する）
          const totalMs = script.results.reduce((a, r) => a + (Number(r.executionTime) || 0), 0);
          els.mTime.textContent = `${totalMs.toFixed(2)} ms`;
          // 件数は表示中の結果セットのもの（showResultSet が入れる）。
          // 以前はここで**文の本数**を上書きしていたため、「件数 3」が
          // 3 行ではなく 3 文の意味になっていた
          if (!lastData && errors.length === 0) els.mRows.textContent = '---';
          // 複数文スクリプトの結果はどの文に由来するか特定できないので編集不可にする
          setEditContext(null);
          renderTree();
          if (script.results.some(r => !r.error && !/^\s*(select|explain|show|describe|desc|table)\b/i.test(r.sql))) triggerAutoSave();
          renderTxnState();
          return;
      }

      // 取り返しのつかない文なら、実行の前に退避を取る
      const guarded = isUnguardedDml(sql);
      const undoTaken = guarded ? takeUndoSnapshot() : false;

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
        const isSet = isResultSet(res.data);
        const detail = isSet
            ? i18nT('{0} 件取得 · {1} ms', res.data.length.toLocaleString(), res.executionTime)
            : i18nT('{0} 行処理 · {1} ms', (res.scannedRows || 0).toLocaleString(), res.executionTime);
        logToConsole('query', sqlSummary(sql), detail, sql);
        // 全行が変わった文は、コンソールを開いていない人にも必ず伝える。
        // 退避が取れていれば、その場で戻せるようにする
        if (guarded) {
            const affected = res.scannedRows || 0;
            const msg = i18nT('WHERE を指定していません。{0} 行すべてが対象になりました。', affected.toLocaleString());
            if (undoTaken) showToast(msg, true, { label: i18nT('元に戻す'), fn: restoreUndoSnapshot });
            else showToast(i18nT('{0} 退避が大きすぎるため取っていません。', msg), true);
        }
        // 文が出した警告（黙って無視された DDL・WHERE なしの全行更新など）を
        // コンソールへ出す。SQL からは SHOW WARNINGS でも読める
        (res.warnings || []).forEach(w => logToConsole('warn', `${w.Code}`, w.Message, sql));

        currentResultData = res.data;
        // 結果グリッドの直接編集の可否を判定してから描画する
        const isSelect = /^select\b/i.test(sql);
        setEditContext(isSelect ? sql : null);
        renderDisplay(true);

        // 書き出し・コピーは「行のある結果セット」でだけ有効。
        // Result という別名の列があるだけで無効化されないよう共通判定を使う
        setResultExportEnabled(isSet && res.data.length > 0);

        renderTree();
        if (!/^(select|explain)\s+/i.test(sql)) triggerAutoSave();
      }
      renderTxnState();
    }
    // ============================================================================
    // ワーカーで実行する（Run ⧉ / Ctrl+Alt+Enter）
    //   ※ Ctrl+Shift+Enter は「エディタ全体をメインスレッドで実行」の方
    //
    // JavaScript は単一スレッドなので、メインスレッドで走っているクエリを Cancel
    // ボタンで止めることはできない — クリックのイベントがそもそも処理されない。
    // 重いクエリを止めたいなら、実行そのものを別スレッドへ出すしかない。
    //
    // ここでは読み取り専用の文だけをワーカーへ送る。書き込みをワーカー側でやると
    // 「どちらが本物のデータか」が二つに割れるので、メインスレッドを唯一の正とし、
    // ワーカーには実行の直前に複製を渡す（前回の複製から中身が変わっていなければ省く）。
    // Cancel はワーカーを terminate する。走っている行ループごと消えるので確実に止まる
    // ============================================================================
    let bgSyncedVersion = null;      // 最後にワーカーへ渡した内容の目印
    let bgRunning = false;

    // 表ごとの変更世代を集めた目印。1 つでも変わっていれば複製し直す
    function dbStateSignature() {
        const parts = [];
        for (const n of Object.keys(db.tables)) {
            const t = db.tables[n];
            parts.push(`${n}:${t.version}:${t.rowCount}`);
        }
        return parts.join('|');
    }

    function setBgRunning(on) {
        bgRunning = on;
        const cancel = document.getElementById('cancelRunBtn');
        const bg = document.getElementById('bgRunBtn');
        const run = document.getElementById('executeBtn');
        if (cancel) cancel.classList.toggle('hidden', !on);
        if (bg) bg.disabled = on;
        if (run) run.disabled = on;
        // 実行中であることをメインスレッド側と同じ形で伝える。
        // Cancel ボタンは出るのに aria-busy が立っておらず、
        // 支援技術には二つの実行経路が違う顔に見えていた
        const area = document.getElementById('resultsContainer');
        if (area) area.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    async function runQueryInWorker(sqlOverride) {
        if (bgRunning) return;
        const sql = (sqlOverride === undefined ? els.query.value : sqlOverride).trim();
        if (!sql) return;
        if (!LuminaDB.worker.supported()) {
            showToast(i18nT('この環境では Worker を使えません。'), true);
            return;
        }
        // 書き込みはメインスレッドの担当（唯一の正を割らないため）
        const statements = db.splitStatements(sql);
        if (statements.some(st => !db._isReadOnlyStatement(st))) {
            showToast(i18nT('ワーカー実行は参照系の文だけです。書き込みは Run を使ってください。'), true);
            return;
        }
        setBgRunning(true);
        const started = performance.now();
        try {
            if (!LuminaDB.worker.running()) await LuminaDB.worker.start();
            const sig = dbStateSignature();
            if (sig !== bgSyncedVersion) {
                await LuminaDB.worker.sync();
                bgSyncedVersion = sig;
            }
            const res = await LuminaDB.worker.query(sql);
            const ms = (performance.now() - started).toFixed(2);
            els.mTime.textContent = `${ms} ms`;
            els.mRows.textContent = (res.scannedRows || 0).toLocaleString();
            const isSet = isResultSet(res.data);
            currentResultData = res.data;
            setEditContext(null);        // ワーカー由来の結果は行の直接編集に使わない
            renderDisplay(true);
            setResultExportEnabled(isSet && res.data.length > 0);
            logToConsole('query', sqlSummary(sql),
                i18nT('{0} 件取得 · {1} ms（ワーカー）', (res.data || []).length.toLocaleString(), ms), sql);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/stopped/i.test(msg)) {
                els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">${escapeHtml(i18nT('実行を中止しました。'))}</div>`;
                logToConsole('warn', sqlSummary(sql), i18nT('実行を中止しました。'), sql);
            } else {
                els.resArea.innerHTML = `<div class="m-auto text-red-600 text-sm font-mono font-medium">${escapeHtml(msg)}</div>`;
                logToConsole('error', sqlSummary(sql), msg, sql);
            }
            setEditContext(null);
        } finally {
            setBgRunning(false);
        }
    }

    function cancelWorkerRun() {
        if (!bgRunning) return;
        // terminate なので、走っている行ループごと消える。次回は起動し直す
        LuminaDB.worker.stop();
        bgSyncedVersion = null;
        setBgRunning(false);
        showToast(i18nT('実行を中止しました。'));
    }

    document.getElementById('executeBtn').addEventListener('click', () => { saveQueryState(); runQueryFromUi(); });
    document.getElementById('bgRunBtn').addEventListener('click', () => { saveQueryState(); runQueryInWorker(); });
    document.getElementById('cancelRunBtn').addEventListener('click', cancelWorkerRun);

    // ============================================================================
    // Explain: カーソル位置（無ければ全体）の SELECT の実行計画だけを見る。
    // データを書き換えないので、重い UPDATE/DELETE を「先に確かめる」用途にも使える
    // ============================================================================
    function explainCurrent() {
      const whole = els.query.value.trim().replace(/;$/, '').trim();
      const stmt = (statementAtCursor(els.query.value, els.query.selectionStart) || whole).trim();
      if (!stmt) return;
      if (/^explain\b/i.test(stmt)) { runQuery(stmt); return; }
      if (!/^(select|with|table|values)\b/i.test(stmt)) {
        showToast(i18nT('Explain は SELECT / WITH の文にだけ使えます。'), true);
        return;
      }
      runQuery(`EXPLAIN ${stmt}`);
    }
    const explainBtn = document.getElementById('explainBtn');
    if (explainBtn) explainBtn.addEventListener('click', () => { saveQueryState(); explainCurrent(); });

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
      label.textContent = inTx ? i18nT('IN TRANSACTION ({0} 変更)', db.undoLog.length) : 'AUTOCOMMIT';
      ind.className = `inline-flex items-center gap-1.5 font-semibold ${inTx ? 'text-amber-600' : 'text-gray-500'}`;
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

    // ============================================================================
    // 実行時間の上限（1 文あたり）
    // ブラウザ内 DB はクエリが UI スレッドを占有するため、書き間違えた結合ひとつで
    // タブが永久に固まる。既定で上限を掛け、必要なら画面から外せるようにする。
    // 選択はブラウザに保存する
    // ============================================================================
    (function initStatementTimeout() {
      const sel = document.getElementById('stmtTimeout');
      if (!sel) return;
      const KEY = 'luminadb_stmt_timeout';
      const apply = (ms) => {
        db.statementTimeoutMs = Number(ms) || 0;
        sel.value = String(db.statementTimeoutMs);
      };
      let saved = null;
      try { saved = localStorage.getItem(KEY); } catch (e) { /* プライベートモード等 */ }
      apply(saved !== null ? saved : sel.value);
      sel.addEventListener('change', () => {
        apply(sel.value);
        try { localStorage.setItem(KEY, String(db.statementTimeoutMs)); } catch (e) { /* 保存できなくても動く */ }
        showToast(db.statementTimeoutMs === 0
            ? i18nT('実行時間の上限を外しました。')
            : i18nT('実行時間の上限を {0} 秒にしました。', db.statementTimeoutMs / 1000));
      });
      // Clear DB などで db インスタンスが作り直されても設定を引き継ぐ
      window.reapplyStatementTimeout = () => { db.statementTimeoutMs = Number(sel.value) || 0; };
    })();

    document.getElementById('txnBeginBtn').addEventListener('click', () => runTxnCommand('BEGIN'));
    document.getElementById('txnCommitBtn').addEventListener('click', () => runTxnCommand('COMMIT'));
    document.getElementById('txnRollbackBtn').addEventListener('click', () => runTxnCommand('ROLLBACK'));
    renderTxnState();
