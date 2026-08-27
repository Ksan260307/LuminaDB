    // ============================================================================
    // [Schema Editor] - テーブル定義の編集モーダル（列名・型・並び順に加え
    //   PRIMARY KEY / NOT NULL / UNIQUE / AUTO_INCREMENT / DEFAULT を編集）
    // ============================================================================
    let editingSchema = { tableName: '', cols: [] };

    // 属性/本文へ埋め込むテキストのHTMLエスケープ
    function escapeHtmlSchema(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // DEFAULT 値（JS値）→ SQLリテラル表記。生成DDLへそのまま埋め込める形にする。
    // engine-ddl の _parseDefaultLiteral と逆変換の関係にある（往復で同値になる）
    function defaultValueToText(v) {
        if (v && typeof v === 'object' && v.__currentTimestamp === true) return 'CURRENT_TIMESTAMP';
        if (v === null) return 'NULL';
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        if (typeof v === 'number') return String(v);
        return `'${String(v).replace(/'/g, "''")}'`;
    }

    // DEFAULT 入力欄のテキスト → JS値。engine-ddl の _parseDefaultLiteral と同じ規則。
    // これにより「エディタ保存」と「生成DDLの CREATE TABLE 実行」が同一の defaults を作る。
    function parseDefaultText(raw) {
        raw = String(raw).trim();
        if (/^(?:current_timestamp|now\(\))$/i.test(raw)) return { __currentTimestamp: true };
        if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") return raw.slice(1, -1).replace(/''/g, "'");
        if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') return raw.slice(1, -1);
        if (/^null$/i.test(raw)) return null;
        if (/^true$/i.test(raw)) return true;
        if (/^false$/i.test(raw)) return false;
        if (raw !== '' && !isNaN(raw)) return Number(raw);
        return raw;
    }

    function openSchemaEditor(tName) {
        const t = db.tables[tName];
        if(!t) return;
        editingSchema.tableName = tName;
        editingSchema.cols = t.getColumnNames().map(c => ({
            oldName: c,
            newName: c,
            type: t.colTypes[c] || 'ANY',
            isNew: false,
            isDeleted: false,
            pk: t.primaryKey === c,
            notNull: (t.notNullCols || []).includes(c),
            unique: (t.uniqueCols || []).includes(c),
            autoInc: t.autoIncrementCol === c,
            defaultText: (t.defaults && c in t.defaults) ? defaultValueToText(t.defaults[c]) : ''
        }));
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
            row.className = "group p-2 bg-white hover:bg-gray-50 rounded cursor-move border border-transparent hover:border-gray-200 transition-colors";
            row.draggable = true;
            const opt = (v) => `<option value="${v}" ${col.type === v ? 'selected' : ''}>${v}</option>`;
            row.innerHTML = `
                <div class="flex items-center gap-2">
                    <div class="text-gray-400 cursor-grab active:cursor-grabbing px-1">
                       <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"></path></svg>
                    </div>
                    <input type="text" class="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none col-name-input shadow-sm transition-all" data-idx="${idx}" value="${escapeHtmlSchema(col.newName)}" placeholder="Column Name">
                    <select class="border border-gray-300 rounded px-2 py-1.5 text-sm outline-none col-type-select focus:border-blue-500 shadow-sm" data-idx="${idx}">
                        ${['ANY','INTEGER','FLOAT','TEXT','BOOLEAN','DATE'].map(opt).join('')}
                    </select>
                    <button class="text-gray-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors col-del-btn opacity-50 group-hover:opacity-100" data-idx="${idx}" title="Delete Column">
                       <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
                <div class="flex items-center gap-3 flex-wrap mt-1.5 pl-8 text-[11px] text-gray-500">
                    <label class="flex items-center gap-1 cursor-pointer select-none" title="PRIMARY KEY"><input type="checkbox" class="col-pk accent-blue-600" data-idx="${idx}" ${col.pk ? 'checked' : ''}><span class="font-semibold">PK</span></label>
                    <label class="flex items-center gap-1 cursor-pointer select-none" title="NOT NULL"><input type="checkbox" class="col-nn accent-blue-600" data-idx="${idx}" ${col.notNull ? 'checked' : ''}>NOT NULL</label>
                    <label class="flex items-center gap-1 cursor-pointer select-none" title="UNIQUE"><input type="checkbox" class="col-uq accent-blue-600" data-idx="${idx}" ${col.unique ? 'checked' : ''}>UNIQUE</label>
                    <label class="flex items-center gap-1 cursor-pointer select-none" title="AUTO_INCREMENT"><input type="checkbox" class="col-ai accent-blue-600" data-idx="${idx}" ${col.autoInc ? 'checked' : ''}>AUTO_INC</label>
                    <span class="flex items-center gap-1">DEFAULT<input type="text" class="col-def w-28 border border-gray-300 rounded px-1.5 py-0.5 text-[11px] focus:border-blue-500 outline-none" data-idx="${idx}" value="${escapeHtmlSchema(col.defaultText || '')}" placeholder="—"></span>
                </div>
            `;

            row.addEventListener('dragstart', (e) => {
                // フォーム部品からのドラッグ開始は無視（列の並べ替えはハンドル/行余白から）
                if (e.target.closest('input, select, button')) { e.preventDefault(); return; }
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

        // 制約チェックボックス。PK / AUTO_INCREMENT は単一カラム制限（他を解除して再描画）
        listEl.querySelectorAll('.col-pk').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = +e.target.dataset.idx;
                editingSchema.cols[idx].pk = e.target.checked;
                if (e.target.checked) editingSchema.cols.forEach((c, i) => { if (i !== idx) c.pk = false; });
                renderSchemaEditor();
            });
        });
        listEl.querySelectorAll('.col-ai').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = +e.target.dataset.idx;
                editingSchema.cols[idx].autoInc = e.target.checked;
                if (e.target.checked) editingSchema.cols.forEach((c, i) => { if (i !== idx) c.autoInc = false; });
                renderSchemaEditor();
            });
        });
        listEl.querySelectorAll('.col-nn').forEach(cb => {
            cb.addEventListener('change', (e) => {
                editingSchema.cols[+e.target.dataset.idx].notNull = e.target.checked;
                updateSchemaPreview();
            });
        });
        listEl.querySelectorAll('.col-uq').forEach(cb => {
            cb.addEventListener('change', (e) => {
                editingSchema.cols[+e.target.dataset.idx].unique = e.target.checked;
                updateSchemaPreview();
            });
        });
        listEl.querySelectorAll('.col-def').forEach(inp => {
            inp.addEventListener('input', (e) => {
                editingSchema.cols[+e.target.dataset.idx].defaultText = e.target.value;
                updateSchemaPreview();
            });
        });

        updateSchemaPreview();
    }

    document.getElementById('schemaAddColBtn').addEventListener('click', () => {
        editingSchema.cols.push({ oldName: null, newName: `new_col_${editingSchema.cols.length+1}`, type: 'ANY', isNew: true, isDeleted: false, pk: false, notNull: false, unique: false, autoInc: false, defaultText: '' });
        renderSchemaEditor();
    });

    // 1カラム定義を CREATE TABLE の列定義DDLへ変換する。
    // engine-ddl の列レベル修飾パーサ（PRIMARY KEY/UNIQUE/NOT NULL/AUTO_INCREMENT/DEFAULT）が
    // そのまま解釈できる形にする（PK列は UNIQUE を重ねない = CREATE TABLE の正規化に一致）
    function colToDDL(c) {
        let s = c.newName;
        if (c.type && c.type !== 'ANY') s += ' ' + c.type;
        if (c.pk) s += ' PRIMARY KEY';
        if (c.autoInc) s += ' AUTO_INCREMENT';
        if (c.notNull) s += ' NOT NULL';
        if (c.unique && !c.pk) s += ' UNIQUE';
        if (c.defaultText && c.defaultText.trim() !== '') s += ' DEFAULT ' + c.defaultText.trim();
        return s;
    }

    function updateSchemaPreview() {
        const activeCols = editingSchema.cols.filter(c => !c.isDeleted && c.newName !== '');
        const sql = `CREATE TABLE ${editingSchema.tableName} (\n  ${activeCols.map(colToDDL).join(',\n  ')}\n);`;

        const previewEl = document.getElementById('schemaPreviewText');

        let html = escapeHtmlSchema(sql);
        html = html.replace(/\b(CREATE TABLE)\b/g, '<span class="text-pink-400 font-bold">$1</span>');
        html = html.replace(/\b(PRIMARY KEY|NOT NULL|UNIQUE|AUTO_INCREMENT|DEFAULT)\b/g, '<span class="text-purple-300 font-semibold">$1</span>');
        const tn = editingSchema.tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (tn) html = html.replace(new RegExp(`(\\(\\s*|\\s)(${tn})\\b`, 'g'), `$1<span class="text-blue-300 font-bold">$2</span>`);

        previewEl.innerHTML = html;
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
            errorEl.textContent = i18nT('テーブルには少なくとも1つのカラムが必要です。');
            errorEl.classList.remove('hidden');
            return;
        }

        const names = activeCols.map(c => c.newName.toLowerCase());
        if(new Set(names).size !== names.length) {
            errorEl.textContent = i18nT('カラム名が重複しています。');
            errorEl.classList.remove('hidden');
            return;
        }

        // バックアップ（ロールバック用）。cloneFull は列データに加え型・制約
        // （NOT NULL / DEFAULT / AUTO_INCREMENT / CHECK / 複合キー / FK / インデックス）まで
        // 完全複製するため、保存失敗時に元のスキーマを漏れなく差し戻せる
        const backupTableObj = t.cloneFull();

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
                const colName = c.newName.toLowerCase();
                const colData = t.cols[colName];
                const hasDef = c.defaultText && c.defaultText.trim() !== '';
                let defVal = hasDef ? parseDefaultText(c.defaultText) : null;
                // 新規列に DEFAULT があれば既存行へバックフィル（ADD COLUMN ... DEFAULT 相当）
                if (defVal && typeof defVal === 'object' && defVal.__currentTimestamp) {
                    defVal = new Date().toISOString().replace('T', ' ').slice(0, 19);
                }
                for (let i = 0; i < t.rowCount; i++) {
                    if (hasDef && defVal !== null) t.setValue(colName, i, defVal);
                    else colData.meta[i] = 0;
                }
            });

            // ドラッグ＆ドロップなどで変更された列の順序を反映
            const finalColNames = activeCols.map(c => c.newName);
            t.reorderColumns(finalColNames);

            // --- 制約の適用（engine-ddl の CREATE TABLE / ADD 制約と同じ正規化・検証） ---
            const lc = s => s.toLowerCase();
            const pks = activeCols.filter(c => c.pk);
            if (pks.length > 1) throw new Error(i18nT('PRIMARY KEY は1カラムのみ指定できます。'));
            const pkCol = pks.length === 1 ? lc(pks[0].newName) : null;

            const ais = activeCols.filter(c => c.autoInc);
            if (ais.length > 1) throw new Error(i18nT('AUTO_INCREMENT は1カラムのみ指定できます。'));
            const aiCol = ais.length === 1 ? lc(ais[0].newName) : null;

            // CREATE TABLE と同様に PK 列は uniqueCols から除外する
            const uniqueSet = activeCols.filter(c => c.unique && !c.pk).map(c => lc(c.newName));
            const notNullSet = activeCols.filter(c => c.notNull).map(c => lc(c.newName));
            const newDefaults = Object.create(null);
            activeCols.forEach(c => {
                if (c.defaultText && c.defaultText.trim() !== '') newDefaults[lc(c.newName)] = parseDefaultText(c.defaultText);
            });

            // 既存データ検証（ADD PRIMARY KEY / ADD UNIQUE / SET NOT NULL と同一規則）
            if (pkCol) {
                const seen = new Set();
                for (let i = 0; i < t.rowCount; i++) {
                    const v = t.getValue(pkCol, i);
                    if (v === null || v === undefined) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${pkCol}'.`);
                    if (seen.has(v)) throw new Error(`PRIMARY KEY constraint failed: Duplicate value '${v}' in column '${pkCol}'.`);
                    seen.add(v);
                }
            }
            uniqueSet.forEach(col => {
                const seen = new Set();
                for (let i = 0; i < t.rowCount; i++) {
                    const v = t.getValue(col, i);
                    if (v === null || v === undefined) continue;
                    if (seen.has(v)) throw new Error(`UNIQUE constraint failed: Duplicate value '${v}' in column '${col}'.`);
                    seen.add(v);
                }
            });
            notNullSet.forEach(col => {
                for (let i = 0; i < t.rowCount; i++) {
                    const v = t.getValue(col, i);
                    if (v === null || v === undefined) throw new Error(`NOT NULL constraint failed: Column '${col}' contains NULL values.`);
                }
            });

            t.primaryKey = pkCol;
            t.uniqueCols = uniqueSet;
            t.notNullCols = notNullSet;
            t.autoIncrementCol = aiCol;
            t.defaults = newDefaults;

            t.rebuildIndices();
            // 制約チェック高速化のため PK / UNIQUE 列へインデックスを張る（CREATE TABLE と同じ）
            [...(pkCol ? [pkCol] : []), ...uniqueSet].forEach(c => { if (!t.indices[c]) t.createIndex(c); });

            renderTree();
            document.getElementById('schemaModal').classList.add('hidden');
            showToast(i18nT('Table \'{0}\' のスキーマを更新しました。', tName));
            triggerAutoSave();
        } catch (e) {
            // ロールバック
            backupTableObj.rebuildIndices();
            db.tables[tName] = backupTableObj;

            errorEl.textContent = i18nT('エラー: {0}', e.message);
            errorEl.classList.remove('hidden');
        }
    });
