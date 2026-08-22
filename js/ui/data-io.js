    // ============================================================================
    // [Data IO] - DB保存/読込/クリア、SQL・CSVのインポート/エクスポート、テストデータ生成
    // ============================================================================

    // SQLテキストを ';' 区切りで文へ分割する。
    // 文字列リテラル内の ';' は保護し、エスケープは SQL標準の引用符二重化 ('')
    // と exportSQL が出力するバックスラッシュ形式 (\') の両方を認識する。
    // コメント (-- 行 / ブロック) 内の ';' も区切りとして扱わない。
    function splitSqlStatements(text) {
        const statements = [];
        let currentStmt = '';
        let inString = false;
        let stringChar = '';
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (char === '\\') {
                    // バックスラッシュエスケープ: 次の1文字を文字列の一部として取り込む
                    currentStmt += char;
                    if (i + 1 < text.length) { currentStmt += text[i + 1]; i++; }
                    continue;
                }
                if (char === stringChar) {
                    if (text[i + 1] === stringChar) {
                        currentStmt += char; i++;
                    } else {
                        inString = false;
                    }
                }
                currentStmt += char;
            } else {
                if (char === '-' && text[i + 1] === '-') {
                    while (i < text.length && text[i] !== '\n') i++;
                    currentStmt += ' ';
                    continue;
                }
                if (char === '/' && text[i + 1] === '*') {
                    i += 2;
                    while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                    i++; // 閉じの '/' を消費（forの i++ で次文字へ）
                    currentStmt += ' ';
                    continue;
                }
                if (char === "'" || char === '"') {
                    inString = true;
                    stringChar = char;
                    currentStmt += char;
                } else if (char === ';') {
                    if (currentStmt.trim() !== '') statements.push(currentStmt.trim());
                    currentStmt = '';
                } else {
                    currentStmt += char;
                }
            }
        }
        if (currentStmt.trim() !== '') statements.push(currentStmt.trim());
        return statements;
    }

    // ------------------------------------------------------------------
    // 保存状態の表示（v1.34）
    //
    // 保存系のボタンをモーダルへ移したぶん、「今どこに何が残っているのか」は
    // 画面から読み取れないといけない。ここでは
    //   ・いま抱えているデータの規模（表数・行数）
    //   ・前回このブラウザへ書き込んだときの結果（差分保存なので「書いた表数」が出る）
    //   ・開いているファイル
    // を組み立てる。数値は表示専用で、これ自体は何も保存しない
    // ------------------------------------------------------------------
    function currentDbScale() {
        const names = Object.keys(db.tables).filter(t => !t.startsWith('__tmp_') && !db.tables[t].isTemp);
        return { tables: names.length, rows: names.reduce((s, t) => s + db.tables[t].rowCount, 0) };
    }
    // サイドバーの 1 行。保存待ちがあるかどうかで色と文言を変える。
    // 保存ボタンをモーダルへ移したので、「まだ書けていない変更があるか」は
    // ここだけが伝える情報になる
    function refreshStorageState() {
        const line = document.getElementById('storageStateLine');
        if (!line) return;
        const pending = (typeof hasUnsavedChanges === 'function') && hasUnsavedChanges();
        const dot = line.querySelector('span');
        const text = line.querySelector('span:last-child');
        if (dot) dot.className = `inline-block w-1.5 h-1.5 rounded-full shrink-0 ${pending ? 'bg-amber-500' : 'bg-green-500'}`;
        if (text) text.textContent = pending ? 'このブラウザへ保存中…' : 'このブラウザへ自動保存';
        line.title = pending
            ? '変更を検知しました。まもなくこのブラウザ（IndexedDB）へ書き込みます。Ctrl + S で今すぐ保存できます。'
            : '変更は 1 秒後にこのブラウザ（IndexedDB）へ自動保存されます。Ctrl + S で今すぐ保存できます。';
    }
    window.refreshStorageState = refreshStorageState;

    function refreshStorageInfo() {
        refreshStorageState();
        const line = document.getElementById('idbStatusLine');
        if (line) {
            const { tables, rows } = currentDbScale();
            const st = (typeof getSaveStats === 'function') ? getSaveStats() : null;
            const saved = st && st.tables
                ? `前回の保存: ${st.tables} 表中 ${st.written} 表を書き込み（${st.skipped} 表は変更なしで省略）`
                : 'このセッションではまだ手動保存していません（自動保存は動いています）';
            line.textContent = `いまのデータ: ${tables} 表 / ${rows.toLocaleString()} 行 — ${saved}`;
        }
        updateFileLabel();
    }
    window.refreshStorageInfo = refreshStorageInfo;

    document.getElementById('saveIdbBtn').addEventListener('click', async () => {
      try {
        await saveDB(db.exportForIDB());
        refreshStorageInfo();
        showToast('IndexedDB にデータを保存しました。');
      } catch (e) {
        showToast(`保存エラー: ${e.message}`, true);
      }
    });

    document.getElementById('loadIdbBtn').addEventListener('click', async () => {
      try {
        const dump = await loadDB();
        if (dump) {
            db.importFromIDB(dump);
            renderTree();
            refreshStorageInfo();
            showToast('IndexedDB からデータを読み込みました。');
        } else {
            showToast('保存されたデータがありません。', true);
        }
      } catch(e) { showToast(`読み込みエラー: ${e.message}`, true); }
    });

    document.getElementById('clearIdbBtn').addEventListener('click', () => {
      document.getElementById('clearConfirmModal').classList.remove('hidden');
    });

    document.getElementById('execClearIdbBtn').addEventListener('click', async () => {
      await clearDB();
      db = new DatabaseEngine();
      // エンジンを作り直すと実行時間の上限が既定へ戻るので、画面の設定を貼り直す
      if (typeof reapplyStatementTimeout === 'function') reapplyStatementTimeout();
      currentResultData = null;
      renderTree();
      els.resArea.innerHTML = `<div class="m-auto text-gray-400 text-sm">Run a query to see results.</div>`;
      showToast('IndexedDB のデータを削除し、初期状態にリセットしました。');
      document.getElementById('clearConfirmModal').classList.add('hidden');
    });

    // ファイルを 1 本のヘルパーで落とす（従来は書き出しごとに同じ 5 行を書いていた）
    function downloadText(text, filename, mime) {
        const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ------------------------------------------------------------------
    // ディスク上のファイルとして開く / 保存する（File System Access API）
    //
    // ブラウザ内 DB の弱点は「データがそのブラウザのそのオリジンに閉じている」こと。
    // IndexedDB はサイトデータを消せば消えるし、別の PC へ持って行けない。
    // ファイルハンドルを保持すれば、通常のアプリと同じく「開いて編集して上書き保存」
    // ができ、バックアップも共有も OS 側の道具で扱える。
    // 未対応ブラウザ（Firefox / Safari / file://）ではダウンロード＋ファイル選択に落とす
    // ------------------------------------------------------------------
    const fsSupported = () => typeof window.showSaveFilePicker === 'function'
        && typeof window.showOpenFilePicker === 'function';
    window.luminaFsSupported = fsSupported;

    // 「上書き保存」用に、いま開いているファイルのハンドルを覚えておく
    let currentFileHandle = null;
    window.luminaCurrentFileName = () => (currentFileHandle && currentFileHandle.name) || null;

    const DB_FILE_TYPES = [{
        description: 'LuminaDB database (JSON)',
        accept: { 'application/json': ['.luminadb', '.json'] }
    }];

    function dbFileText() {
        // バックアップ形式（api.js の backup と同じ土台）をそのまま使う。
        // 表・ビュー・トリガー・シーケンス等を含む完全なスナップショット
        return LuminaDB.backup();
    }

    async function saveDbToFile(useExisting) {
        const text = dbFileText();
        if (!fsSupported()) {
            downloadText(text, 'luminadb.luminadb.json', 'application/json');
            showToast('このブラウザはファイルへの直接保存に未対応のため、ダウンロードしました。');
            return { fallback: true };
        }
        try {
            let handle = useExisting ? currentFileHandle : null;
            if (!handle) {
                handle = await window.showSaveFilePicker({
                    suggestedName: 'luminadb.luminadb',
                    types: DB_FILE_TYPES
                });
            }
            const w = await handle.createWritable();
            await w.write(text);
            await w.close();
            currentFileHandle = handle;
            updateFileLabel();
            showToast(`${handle.name} に保存しました（${text.length.toLocaleString()} 文字）。`);
            return { name: handle.name, bytes: text.length };
        } catch (e) {
            // ユーザーがダイアログを閉じただけならエラー扱いにしない
            if (e && e.name === 'AbortError') return { cancelled: true };
            showToast(`ファイルに保存できませんでした: ${e && e.message}`, true);
            return { error: String(e && e.message) };
        }
    }

    async function openDbFromFile() {
        const load = (text, name) => {
            const res = LuminaDB.restoreBackup(text);
            if (res && res.error) { showToast(`読み込めませんでした: ${res.error}`, true); return false; }
            renderTree();
            if (typeof reapplyStatementTimeout === 'function') reapplyStatementTimeout();
            showToast(`${name} を読み込みました。`);
            return true;
        };
        if (!fsSupported()) {
            // ファイル選択にフォールバック（ハンドルは持てないので上書き保存はできない）
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.luminadb,.json';
            input.addEventListener('change', () => {
                const f = input.files && input.files[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = () => load(String(r.result), f.name);
                r.readAsText(f);
            });
            input.click();
            return { fallback: true };
        }
        try {
            const [handle] = await window.showOpenFilePicker({ types: DB_FILE_TYPES, multiple: false });
            const file = await handle.getFile();
            const text = await file.text();
            if (!load(text, handle.name)) return { error: 'restore failed' };
            currentFileHandle = handle;
            updateFileLabel();
            return { name: handle.name, bytes: text.length };
        } catch (e) {
            if (e && e.name === 'AbortError') return { cancelled: true };
            showToast(`ファイルを開けませんでした: ${e && e.message}`, true);
            return { error: String(e && e.message) };
        }
    }

    // 開いているファイル名をサイドバーとモーダルに出し、「上書き保存」の可否を切り替える。
    // 未対応ブラウザでは代わりに何が起きるのかもモーダル側で伝える
    function updateFileLabel() {
        const el = document.getElementById('openFileLabel');
        const saveBtn = document.getElementById('fileSaveBtn');
        if (el) {
            el.textContent = currentFileHandle ? `ファイル: ${currentFileHandle.name}` : '';
            el.classList.toggle('hidden', !currentFileHandle);
        }
        if (saveBtn) saveBtn.disabled = !currentFileHandle;
        const name = document.getElementById('openFileName');
        if (name) {
            name.textContent = currentFileHandle
                ? `開いているファイル: ${currentFileHandle.name}`
                : '開いているファイルはありません（「名前を付けて保存」または「開く」から始めます）';
        }
        const note = document.getElementById('fileApiNote');
        if (note) {
            const unsupported = !fsSupported();
            note.classList.toggle('hidden', !unsupported);
            if (unsupported) {
                note.textContent = 'このブラウザ（または file:// で開いた場合）はファイルを直接読み書きできません。'
                    + '「保存」はダウンロード、「開く」はファイル選択に切り替わります。上書き保存はできないため、毎回新しいファイルになります。';
            }
        }
    }

    window.saveDbToFile = saveDbToFile;
    window.openDbFromFile = openDbFromFile;

    (function initFileButtons() {
        const openBtn = document.getElementById('fileOpenBtn');
        const saveAsBtn = document.getElementById('fileSaveAsBtn');
        const saveBtn = document.getElementById('fileSaveBtn');
        if (openBtn) openBtn.addEventListener('click', () => openDbFromFile());
        if (saveAsBtn) saveAsBtn.addEventListener('click', () => saveDbToFile(false));
        if (saveBtn) saveBtn.addEventListener('click', () => saveDbToFile(true));
        updateFileLabel();
        refreshStorageState();
    })();

    // 保存の 2 つはモーダルを開かずに呼べるようにする（v1.34 でボタンを移したぶんの代替）。
    //   Ctrl + S        … このブラウザ（IndexedDB）へ保存
    //   Ctrl + Shift + S … 開いているファイルへ上書き保存（無ければ名前を付けて保存）
    // ブラウザ既定の「ページを保存」は意味がないので preventDefault する
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.key.toLowerCase() !== 's') return;
        e.preventDefault();
        if (e.shiftKey) {
            saveDbToFile(!!currentFileHandle);
            return;
        }
        saveDB(db.exportForIDB())
            .then(() => { refreshStorageInfo(); showToast('IndexedDB にデータを保存しました。'); })
            .catch(err => showToast(`保存エラー: ${err.message}`, true));
    });

    // 取り込み結果をモーダル内に出す。従来は件数だけをトーストで流していたため、
    // 「何件か失敗した」ことは判っても、どの文がなぜ落ちたのかを追えなかった
    function showImportLog(lines, isError) {
        const box = document.getElementById('dataImportLog');
        if (!box) return;
        box.classList.remove('hidden');
        box.className = `text-xs border rounded p-3 max-h-40 overflow-y-auto font-mono ${
            isError ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-800'}`;
        // XSS対策: SQL とエラーはファイル由来なので必ずエスケープする
        box.innerHTML = lines.map(l => `<div class="whitespace-pre-wrap break-all">${escapeHtml(l)}</div>`).join('');
    }
    function clearImportLog() {
        const box = document.getElementById('dataImportLog');
        if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    }

    document.getElementById('exportSqlBtn').addEventListener('click', () => {
        const sqlStr = db.exportSQL();
        downloadText(sqlStr, 'luminadb_export.sql', 'text/sql');
        const info = document.getElementById('exportSqlInfo');
        const tables = Object.keys(db.tables).filter(t => !t.startsWith('__tmp_') && !db.tables[t].isTemp).length;
        if (info) info.textContent = `${tables} 表 / ${sqlStr.length.toLocaleString()} 文字を luminadb_export.sql として保存しました。`;
        showToast(`SQL ダンプを書き出しました（${tables} 表）。`);
    });

    // 全テーブルを JSON で書き出す（結果セットではなくデータベース全体）
    const exportJsonAllBtn = document.getElementById('exportJsonAllBtn');
    if (exportJsonAllBtn) exportJsonAllBtn.addEventListener('click', () => {
        const out = {};
        Object.keys(db.tables).forEach(t => {
            if (t.startsWith('__tmp_') || db.tables[t].isTemp) return;
            const r = db.executeQuery(`SELECT * FROM ${t}`);
            out[t] = r.error ? { __error: r.error } : r.data;
        });
        const names = Object.keys(out);
        if (names.length === 0) { showToast('書き出せるテーブルがありません。', true); return; }
        downloadText(JSON.stringify(out, null, 2), 'luminadb_export.json', 'application/json');
        showToast(`${names.length} 表を JSON として書き出しました。`);
    });

    document.getElementById('importSqlBtn').addEventListener('click', () => {
        document.getElementById('sqlFileInput').click();
    });

    // SQL テキストを取り込む。ファイル選択とドラッグ&ドロップの共通経路
    function runSqlImport(text, label) {
        try {
            const statements = splitSqlStatements(text);
            let successCount = 0;
            const failures = [];
            statements.forEach(stmt => {
                const res = db.executeQuery(stmt);
                if (res.error) failures.push({ sql: stmt, error: res.error });
                else successCount++;
            });

            renderTree();
            if (failures.length === 0) {
                showImportLog([`${label}: ${successCount} 件の SQL 文をすべて実行しました。`], false);
                showToast(`${successCount} 件の SQL 文を実行しました。`);
            } else {
                // 失敗した文は「何行目のどの文がなぜ落ちたか」まで出す（最大 20 件）
                const head = `${label}: ${successCount} / ${statements.length} 件成功、${failures.length} 件失敗`;
                const lines = [head].concat(
                    failures.slice(0, 20).map(f => `✕ ${f.sql.replace(/\s+/g, ' ').slice(0, 100)}\n   → ${f.error}`)
                );
                if (failures.length > 20) lines.push(`… 他 ${failures.length - 20} 件`);
                showImportLog(lines, true);
                showToast(`${failures.length} 件の SQL 文が失敗しました（詳細はモーダル内）。`, true);
            }
            if (successCount > 0) triggerAutoSave();
            return { successCount, failed: failures.length };
        } catch (err) {
            showImportLog([`SQL インポート失敗: ${err.message}`], true);
            showToast(`SQLインポート失敗: ${err.message}`, true);
            return { successCount: 0, failed: 1 };
        }
    }

    document.getElementById('sqlFileInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => runSqlImport(event.target.result, file.name);
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('generateBtn').addEventListener('click', () => {
       const tbl = document.getElementById('genTableSelect').value;
       const inputVal = parseInt(document.getElementById('genRowCount').value, 10);
       const count = isNaN(inputVal) || inputVal < 1 ? 10000 : inputVal;

       try {
           const generatedCount = db.generateDummyData(tbl, count);
           renderTree();
           showToast(`${generatedCount.toLocaleString()}行のデータを ${tbl} に追加しました。`);
           triggerAutoSave();
       } catch (err) {
           showToast(`データ生成失敗: ${err.message}`, true);
       }
       closeModal('dataModal');
    });

    // CSV の取り込み先セレクトで「新しい表を作る」を選んだときだけ表名の入力欄を出す
    const CSV_NEW_TABLE = '__new__';
    function syncCsvNewTableRow() {
        const row = document.getElementById('csvNewTableRow');
        const sel = document.getElementById('csvTableSelect');
        if (!row || !sel) return;
        const on = sel.value === CSV_NEW_TABLE;
        row.classList.toggle('hidden', !on);
        row.classList.toggle('flex', on);
    }
    const csvSelEl = document.getElementById('csvTableSelect');
    if (csvSelEl) csvSelEl.addEventListener('change', syncCsvNewTableRow);

    // CSV テキストを取り込む。ファイル選択とドラッグ&ドロップの共通経路。
    // パーサは LuminaDB.importCSV（RFC 4180 準拠。引用符内のカンマ・改行を正しく扱い、
    // 列ごとに型を推定する）へ委ねる。従来この画面は独自の簡易パーサを持っており、
    // 引用符の中に改行があると行が壊れていた
    function runCsvImport(text, label, forcedTable) {
        const sel = document.getElementById('csvTableSelect');
        const chosen = forcedTable || (sel ? sel.value : '');
        const replace = !!(document.getElementById('csvReplaceChk') || {}).checked;
        let table = chosen, create = false;
        if (chosen === CSV_NEW_TABLE) {
            const nameEl = document.getElementById('csvNewTableName');
            table = (nameEl ? nameEl.value : '').trim();
            create = true;
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
                showImportLog(['新しい表の名前を英数字とアンダースコアで入力してください（先頭は英字か _）。'], true);
                showToast('新しい表の名前が不正です。', true);
                return { error: 'invalid table name' };
            }
            if (db.tables[table.toLowerCase()]) {
                showImportLog([`表 '${table}' はすでにあります。取り込み先から選ぶか、別の名前にしてください。`], true);
                showToast(`表 '${table}' はすでに存在します。`, true);
                return { error: 'table exists' };
            }
        }
        if (!table) {
            showImportLog(['取り込み先の表が選ばれていません。'], true);
            showToast('取り込み先の表が選ばれていません。', true);
            return { error: 'no table' };
        }

        const res = LuminaDB.importCSV(text, table, { create, replace });
        renderTree();
        if (res && res.error) {
            showImportLog([`${label}: 取り込みに失敗しました。`, `→ ${res.error}`], true);
            showToast(`インポート失敗: ${res.error}`, true);
            return res;
        }
        const n = (res && res.rows) || 0;
        const cols = (res && res.columns) ? res.columns.join(', ') : '';
        showImportLog([
            `${label}: ${n.toLocaleString()} 行を ${table} に取り込みました${create ? '（表を新規作成）' : ''}。`,
            cols ? `列: ${cols}` : ''
        ].filter(Boolean), false);
        showToast(`${n.toLocaleString()} 行を ${table} にインポートしました。`);
        if (n > 0) triggerAutoSave();
        return res;
    }

    document.getElementById('execCsvImportBtn').addEventListener('click', () => {
        const fileInput = document.getElementById('csvFileInput');
        const file = fileInput.files[0];
        clearImportLog();
        if (!file) {
            showImportLog(['CSV ファイルが選ばれていません。'], true);
            return showToast("CSVファイルが選択されていません。", true);
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            runCsvImport(event.target.result, file.name);
            fileInput.value = '';
        };
        reader.readAsText(file);
    });

    // ============================================================================
    // ドラッグ&ドロップ取り込み（.sql / .csv）
    // ファイル選択ダイアログを開かずに済ませるための入口。拡張子で経路を振り分ける
    // ============================================================================
    (function initDropZone() {
        const zone = document.getElementById('dataDropZone');
        if (!zone) return;
        const hot = (on) => {
            zone.classList.toggle('border-blue-400', on);
            zone.classList.toggle('bg-blue-50', on);
        };
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); hot(true);
        }));
        ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); hot(false);
        }));
        zone.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            clearImportLog();
            const reader = new FileReader();
            reader.onload = (ev) => {
                if (/\.csv$/i.test(file.name)) runCsvImport(ev.target.result, file.name);
                else runSqlImport(ev.target.result, file.name);
            };
            reader.readAsText(file);
        });
    })();

    // 書き出し対象の行。画面に絞り込みが掛かっているときは「見えている行」を出す
    // （従来は常に絞り込み前の全行を書き出しており、画面と食い違っていた）
    function exportRows() {
        if (typeof filteredResultData === 'function') {
            const f = filteredResultData();
            if (Array.isArray(f)) return f;
        }
        return currentResultData || [];
    }

    // RFC 4180: 引用符が要るのは 区切り文字 / 引用符 / 改行 を含むときだけ。
    // NULL は「引用符なしの空欄」、空文字は `""` として書き分ける（往復で区別が付く）
    function csvCell(v) {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    document.getElementById('exportCsvBtn').addEventListener('click', () => {
        const rows = exportRows();
        if (!rows || rows.length === 0) return;
        const headers = Object.keys(rows[0]);
        const csvRows = [headers.map(csvCell).join(',')];
        for (const row of rows) csvRows.push(headers.map(h => csvCell(row[h])).join(','));
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `luminadb_export.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // ============================================================================
    // 結果セットを他所へ貼るための書式化（クリップボードへコピー）
    // Markdown 表は課題票やレビューへ、INSERT 文は別のDBへ移す用途
    // ============================================================================
    function resultToMarkdown(rows) {
        const headers = Object.keys(rows[0]);
        // '|' は表の区切りなのでエスケープし、改行はセル内改行の記法へ置き換える
        const cell = (v) => (v === null || v === undefined ? '' : String(v))
            .replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
        const lines = [
            `| ${headers.map(cell).join(' | ')} |`,
            `| ${headers.map(() => '---').join(' | ')} |`
        ];
        rows.forEach(r => lines.push(`| ${headers.map(h => cell(r[h])).join(' | ')} |`));
        return lines.join('\n');
    }

    // 値を SQL リテラルへ。文字列は引用符を二重化して閉じる（インジェクション回避）
    function sqlLiteral(v) {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return `'${String(v).replace(/'/g, "''")}'`;
    }

    function resultToInserts(rows, table) {
        const headers = Object.keys(rows[0]);
        const cols = headers.map(h => String(h).replace(/[^a-zA-Z0-9_]/g, '_')).join(', ');
        return rows.map(r => `INSERT INTO ${table} (${cols}) VALUES (${headers.map(h => sqlLiteral(r[h])).join(', ')});`).join('\n');
    }

    function copyToClipboard(text, label) {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            showToast('このブラウザではクリップボードを利用できません。', true);
            return;
        }
        navigator.clipboard.writeText(text)
            .then(() => showToast(`${label} をコピーしました（${text.length.toLocaleString()} 文字）。`))
            .catch(() => showToast('クリップボードへのコピーに失敗しました。', true));
    }

    // 表計算ソフトへそのまま貼れる TSV。値中のタブ・改行は空白へ畳む
    // （TSV には引用の仕組みが無いため、含めると列がずれる）
    function resultToTsv(rows) {
        const headers = Object.keys(rows[0]);
        const cell = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[\t\r\n]+/g, ' ');
        return [headers.map(cell).join('\t')]
            .concat(rows.map(r => headers.map(h => cell(r[h])).join('\t')))
            .join('\n');
    }

    document.getElementById('copyMdBtn').addEventListener('click', () => {
        const rows = exportRows();
        if (!rows || rows.length === 0) return;
        copyToClipboard(resultToMarkdown(rows), 'Markdown 表');
    });

    const copyTsvBtn = document.getElementById('copyTsvBtn');
    if (copyTsvBtn) copyTsvBtn.addEventListener('click', () => {
        const rows = exportRows();
        if (!rows || rows.length === 0) return;
        copyToClipboard(resultToTsv(rows), `TSV ${rows.length} 行`);
    });

    document.getElementById('copyInsertBtn').addEventListener('click', () => {
        const rows = exportRows();
        if (!rows || rows.length === 0) return;
        // 基底表が判っていればその名前を、判らなければ汎用の名前を使う
        const table = (typeof editContext !== 'undefined' && editContext.editable) ? editContext.table : 'target_table';
        copyToClipboard(resultToInserts(rows, table), `INSERT 文 ${rows.length} 件`);
    });

    // 結果セットを JSON ファイルとしてダウンロードする（行オブジェクトの配列 / 整形出力）
    document.getElementById('exportJsonBtn').addEventListener('click', () => {
        const rows = exportRows();
        if (!rows || rows.length === 0) return;
        const json = JSON.stringify(rows, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `luminadb_export.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
