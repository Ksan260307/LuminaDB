    // ============================================================================
    // [Schema Editor] - テーブル定義の編集モーダル
    // ============================================================================
    let editingSchema = { tableName: '', cols: [] };

    function openSchemaEditor(tName) {
        const t = db.tables[tName];
        if(!t) return;
        editingSchema.tableName = tName;
        editingSchema.cols = t.getColumnNames().map(c => ({ oldName: c, newName: c, type: t.colTypes[c] || 'ANY', isNew: false, isDeleted: false }));
        document.getElementById('schemaTableName').textContent = tName;
        document.getElementById('schemaErrorMsg').classList.add('hidden');
        renderSchemaEditor();
        document.getElementById('schemaModal').classList.remove('hidden');
    }

    function renderSchemaEditor() {
        const listEl = document.getElementById('schemaColumnList');
        listEl.innerHTML = '';

        editingSchema.cols.forEach((col, idx) => {
            if(col.isDeleted) return;

            const row = document.createElement('div');
            row.className = "flex items-center gap-2 group p-1 bg-white hover:bg-gray-50 rounded cursor-move border border-transparent hover:border-gray-200 transition-colors";
            row.draggable = true;
            row.innerHTML = `
                <div class="text-gray-400 cursor-grab active:cursor-grabbing px-1">
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
                </div>
                <input type="text" class="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none col-name-input shadow-sm transition-all" data-idx="${idx}" value="${col.newName}" placeholder="Column Name">
                <select class="border border-gray-300 rounded px-2 py-1.5 text-sm outline-none col-type-select focus:border-blue-500 shadow-sm" data-idx="${idx}">
                    <option value="ANY" ${col.type==='ANY'?'selected':''}>ANY</option>
                    <option value="INTEGER" ${col.type==='INTEGER'?'selected':''}>INTEGER</option>
                    <option value="FLOAT" ${col.type==='FLOAT'?'selected':''}>FLOAT</option>
                    <option value="TEXT" ${col.type==='TEXT'?'selected':''}>TEXT</option>
                    <option value="BOOLEAN" ${col.type==='BOOLEAN'?'selected':''}>BOOLEAN</option>
                    <option value="DATE" ${col.type==='DATE'?'selected':''}>DATE</option>
                </select>
                <button class="text-gray-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors col-del-btn opacity-50 group-hover:opacity-100" data-idx="${idx}" title="Delete Column">
                   <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            `;

            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', idx);
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => row.classList.add('opacity-40', 'bg-blue-50'), 0);
            });
            row.addEventListener('dragend', (e) => {
                row.classList.remove('opacity-40', 'bg-blue-50');
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('border-blue-400', 'bg-blue-50');
            });
            row.addEventListener('dragleave', (e) => {
                row.classList.remove('border-blue-400', 'bg-blue-50');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('border-blue-400', 'bg-blue-50');
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = parseInt(idx);
                if (fromIdx !== toIdx && !isNaN(fromIdx)) {
                    const movedItem = editingSchema.cols.splice(fromIdx, 1)[0];
                    editingSchema.cols.splice(toIdx, 0, movedItem);
                    renderSchemaEditor();
                }
            });

            listEl.appendChild(row);
        });

        listEl.querySelectorAll('.col-name-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const idx = e.target.dataset.idx;
                editingSchema.cols[idx].newName = e.target.value.trim();
                updateSchemaPreview();
            });
        });

        listEl.querySelectorAll('.col-type-select').forEach(sel => {
            sel.addEventListener('change', (e) => {
                const idx = e.target.dataset.idx;
                editingSchema.cols[idx].type = e.target.value;
                updateSchemaPreview();
            });
        });

        listEl.querySelectorAll('.col-del-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = e.currentTarget.dataset.idx;
                editingSchema.cols[idx].isDeleted = true;
                renderSchemaEditor();
            });
        });

        updateSchemaPreview();
    }

    document.getElementById('schemaAddColBtn').addEventListener('click', () => {
        editingSchema.cols.push({ oldName: null, newName: `new_col_${editingSchema.cols.length+1}`, type: 'ANY', isNew: true, isDeleted: false });
        renderSchemaEditor();
    });

    function updateSchemaPreview() {
        const activeCols = editingSchema.cols.filter(c => !c.isDeleted && c.newName !== '').map(c => `${c.newName}${c.type !== 'ANY' ? ' ' + c.type : ''}`);
        const sql = `CREATE TABLE ${editingSchema.tableName} (\n  ${activeCols.join(',\n  ')}\n);`;

        const previewEl = document.getElementById('schemaPreviewText');

        let htmlSql = sql.replace(/CREATE TABLE/g, '<span class="text-pink-400 font-bold">CREATE TABLE</span>');
        htmlSql = htmlSql.replace(new RegExp(`\\b${editingSchema.tableName}\\b`, 'g'), `<span class="text-blue-300 font-bold">${editingSchema.tableName}</span>`);

        previewEl.innerHTML = htmlSql;
    }

    document.getElementById('execSchemaSaveBtn').addEventListener('click', () => {
        const tName = editingSchema.tableName;
        const t = db.tables[tName];
        if(!t) return;

        const errorEl = document.getElementById('schemaErrorMsg');
        errorEl.classList.add('hidden');
        errorEl.textContent = '';

        const activeCols = editingSchema.cols.filter(c => !c.isDeleted && c.newName !== '');
        if(activeCols.length === 0) {
            errorEl.textContent = "テーブルには少なくとも1つのカラムが必要です。";
            errorEl.classList.remove('hidden');
            return;
        }

        const names = activeCols.map(c => c.newName.toLowerCase());
        if(new Set(names).size !== names.length) {
            errorEl.textContent = "カラム名が重複しています。";
            errorEl.classList.remove('hidden');
            return;
        }

        // バックアップ（ロールバック用）
        const backupTableObj = new Table(t.capacity);
        backupTableObj.rowCount = t.rowCount;
        backupTableObj.foreignKeys = JSON.parse(JSON.stringify(t.foreignKeys || []));
        backupTableObj.primaryKey = t.primaryKey;
        backupTableObj.uniqueCols = [...(t.uniqueCols || [])];
        backupTableObj.colTypes = JSON.parse(JSON.stringify(t.colTypes));
        backupTableObj.strPools = JSON.parse(JSON.stringify(t.strPools));
        backupTableObj.strMaps = JSON.parse(JSON.stringify(t.strMaps));
        for (let c in t.cols) {
            backupTableObj.cols[c] = {
                num: new Float64Array(t.cols[c].num),
                meta: new Uint32Array(t.cols[c].meta)
            };
        }

        try {
            editingSchema.cols.filter(c => !c.isNew && c.isDeleted).forEach(c => t.dropColumn(c.oldName));
            editingSchema.cols.filter(c => !c.isNew && !c.isDeleted && c.oldName !== c.newName).forEach(c => t.renameColumn(c.oldName, c.newName));

            editingSchema.cols.filter(c => !c.isDeleted && c.newName !== '' && !c.isNew).forEach(c => {
                if (t.colTypes[c.newName.toLowerCase()] !== c.type) {
                    t.changeColumnType(c.newName, c.type);
                }
            });

            editingSchema.cols.filter(c => c.isNew && !c.isDeleted && c.newName !== '').forEach(c => {
                t.addColumn(c.newName, c.type);
                const colData = t.cols[c.newName.toLowerCase()];
                for(let i=0; i<t.rowCount; i++) colData.meta[i] = 0;
            });

            // ドラッグ＆ドロップなどで変更された列の順序を反映
            const finalColNames = activeCols.map(c => c.newName);
            t.reorderColumns(finalColNames);
            t.rebuildIndices();

            renderTree();
            document.getElementById('schemaModal').classList.add('hidden');
            showToast(`Table '${tName}' のスキーマを更新しました。`);
            triggerAutoSave();
        } catch (e) {
            // ロールバック
            backupTableObj.rebuildIndices();
            db.tables[tName] = backupTableObj;

            errorEl.textContent = `エラー: ${e.message}`;
            errorEl.classList.remove('hidden');
        }
    });
