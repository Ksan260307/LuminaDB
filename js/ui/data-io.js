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

    document.getElementById('saveIdbBtn').addEventListener('click', async () => {
      try {
        await saveDB(db.exportForIDB());
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
      currentResultData = null;
      renderTree();
      els.resArea.innerHTML = `<div class="m-auto text-gray-400 text-sm">Run a query to see results.</div>`;
      showToast('IndexedDB のデータを削除し、初期状態にリセットしました。');
      document.getElementById('clearConfirmModal').classList.add('hidden');
    });

    document.getElementById('exportSqlBtn').addEventListener('click', () => {
        const sqlStr = db.exportSQL();
        const blob = new Blob([sqlStr], { type: 'text/sql;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `luminadb_export.sql`;
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('importSqlBtn').addEventListener('click', () => {
        document.getElementById('sqlFileInput').click();
    });

    document.getElementById('sqlFileInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target.result;
                const statements = splitSqlStatements(text);

                let successCount = 0;
                statements.forEach(stmt => {
                    const res = db.executeQuery(stmt);
                    if (!res.error) successCount++;
                });

                renderTree();
                showToast(`${successCount} / ${statements.length} 件のSQL文を実行しました。`);
                if (successCount > 0) triggerAutoSave();
            } catch(err) { showToast(`SQLインポート失敗: ${err.message}`, true); }
        };
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
       document.getElementById('generatorModal').classList.add('hidden');
    });

    document.getElementById('execCsvImportBtn').addEventListener('click', () => {
        const fileInput = document.getElementById('csvFileInput');
        const file = fileInput.files[0];
        const tableName = document.getElementById('csvTableSelect').value;
        document.getElementById('csvModal').classList.add('hidden');

        if (!file) return showToast("CSVファイルが選択されていません。", true);

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target.result;
                const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
                if (lines.length < 2) throw new Error("CSVにはヘッダー行とデータ行が必要です。");

                const parseLine = (line) => {
                    let ret = [], inQuote = false, value = "";
                    for (let i = 0; i < line.length; i++) {
                        let char = line[i];
                        if (inQuote) {
                            if (char === '"' && line[i+1] === '"') { value += '"'; i++; }
                            else if (char === '"') inQuote = false;
                            else value += char;
                        } else {
                            if (char === '"') inQuote = true;
                            else if (char === ',') { ret.push(value); value = ""; }
                            else value += char;
                        }
                    }
                    ret.push(value);
                    return ret.map(v => v.trim());
                };

                const targetTable = db.tables[tableName];
                const tableCols = targetTable.getColumnNames();

                // 全行を先にパースしてから insertRows で一括投入する。
                // これにより NOT NULL / UNIQUE / PK / FK 制約が適用され、
                // かつ途中でエラーが起きても部分的にインポートされない（原子性）。
                let skipped = 0;
                const valuesList = [];
                for (let i = 1; i < lines.length; i++) {
                    const vals = parseLine(lines[i]);
                    if(vals.length !== tableCols.length) { skipped++; continue; }
                    valuesList.push(tableCols.map((colName, idx) => {
                        let v = (vals[idx] !== undefined) ? vals[idx] : null;
                        if (v !== null && v !== '') {
                            if (!isNaN(v) && !isNaN(parseFloat(v))) v = Number(v);
                        } else v = null;
                        return v;
                    }));
                }

                const importedCount = db.insertRows(tableName, tableCols, valuesList);
                renderTree();
                const skipNote = skipped > 0 ? `（列数不一致で ${skipped} 行スキップ）` : '';
                showToast(`${importedCount} 行を ${tableName} にインポートしました。${skipNote}`);
                if (importedCount > 0) triggerAutoSave();
            } catch(err) { showToast(`インポート失敗: ${err.message}`, true); }
        };
        reader.readAsText(file);
        fileInput.value = '';
    });

    document.getElementById('exportCsvBtn').addEventListener('click', () => {
        if (!currentResultData || currentResultData.length === 0) return;
        const headers = Object.keys(currentResultData[0]);
        const csvRows = [headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(',')];
        for (const row of currentResultData) {
            csvRows.push(headers.map(h => {
                let val = row[h];
                return val === null || val === undefined ? '""' : `"${String(val).replace(/"/g, '""')}"`;
            }).join(','));
        }
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `luminadb_export.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
