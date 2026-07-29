    // ============================================================================
    // [Table] - Zero Allocation & TypedArray Columnar Storage
    // ============================================================================
    class Table {
        constructor(capacity = 10000) {
            this.capacity = capacity;
            this.rowCount = 0;
            // データ由来の文字列（列名・格納値）をキーにする辞書は null プロトタイプで生成する。
            // 通常の {} だと '__proto__' や 'constructor' というキーがプロトタイプ汚染や
            // Object.prototype 由来の誤ヒットを引き起こすため
            this.cols = Object.create(null);
            this.colTypes = Object.create(null); // データ型の保持用
            this.strPools = Object.create(null);
            this.strMaps = Object.create(null);
            this.indices = Object.create(null);
            this.foreignKeys = [];
            this.uniqueCols = [];
            this.primaryKey = null;
            this.notNullCols = [];
            this.defaults = Object.create(null);
            this.autoIncrementCol = null;
            // CHECK 制約: [{ name, expr }]（expr は復元済みの真偽式テキスト）
            this.checks = [];
            // 複合 UNIQUE / PRIMARY KEY: [{ cols: [...], isPK }]
            this.compositeKeys = [];
            // 生成列 (GENERATED ALWAYS AS): col -> 式テキスト（STORED相当。INSERT/UPDATE時に評価）
            this.generatedCols = Object.create(null);
            // ON UPDATE CURRENT_TIMESTAMP を持つ列名（UPDATE 時に自動更新）
            this.onUpdateNowCols = [];
            // 変更世代。setValue / 列操作のたびに増える。IndexedDB の差分保存で
            // 「この表は前回保存から変わったか」を O(1) で判定するために使う
            this.version = 0;
            // CREATE TEMPORARY TABLE で作られたテーブル（IDB保存・SQLエクスポート対象外）
            this.isTemp = false;
        }

        addColumn(col, type = 'ANY') {
            col = col.toLowerCase();
            if (this.cols[col]) return;
            this.version++;
            this.colTypes[col] = type;
            // 32-bit packing for Memory efficiency and Cache Locality
            // Type(8bit) + String Index(24bit) packed into a single Uint32Array
            // Type: 0=Null, 1=Number, 2=String, 3=Boolean, 4=Date
            this.cols[col] = {
                num: new Float64Array(this.capacity),
                meta: new Uint32Array(this.capacity)
            };
            this.strPools[col] = [];
            this.strMaps[col] = Object.create(null);
        }

        renameColumn(oldCol, newCol) {
            this.version++;
            oldCol = oldCol.toLowerCase();
            newCol = newCol.toLowerCase();
            if (!this.cols[oldCol] || this.cols[newCol] || oldCol === newCol) return;

            this.cols[newCol] = this.cols[oldCol];
            delete this.cols[oldCol];

            this.colTypes[newCol] = this.colTypes[oldCol];
            delete this.colTypes[oldCol];

            this.strPools[newCol] = this.strPools[oldCol];
            delete this.strPools[oldCol];

            this.strMaps[newCol] = this.strMaps[oldCol];
            delete this.strMaps[oldCol];

            if (this.indices[oldCol]) {
                this.indices[newCol] = this.indices[oldCol];
                delete this.indices[oldCol];
            }

            if (this.primaryKey === oldCol) this.primaryKey = newCol;
            this.uniqueCols = (this.uniqueCols || []).map(c => c === oldCol ? newCol : c);
            this.notNullCols = (this.notNullCols || []).map(c => c === oldCol ? newCol : c);
            if (this.defaults && oldCol in this.defaults) {
                this.defaults[newCol] = this.defaults[oldCol];
                delete this.defaults[oldCol];
            }
            if (this.autoIncrementCol === oldCol) this.autoIncrementCol = newCol;
            if (this.generatedCols && oldCol in this.generatedCols) {
                this.generatedCols[newCol] = this.generatedCols[oldCol];
                delete this.generatedCols[oldCol];
            }
            (this.compositeKeys || []).forEach(ck => {
                ck.cols = ck.cols.map(c => c === oldCol ? newCol : c);
            });
        }

        dropColumn(col) {
            col = col.toLowerCase();
            if (!this.cols[col]) return;
            delete this.cols[col];
            delete this.colTypes[col];
            delete this.strPools[col];
            delete this.strMaps[col];
            delete this.indices[col];
            this.uniqueCols = (this.uniqueCols || []).filter(c => c !== col);
            if (this.primaryKey === col) this.primaryKey = null;
            this.notNullCols = (this.notNullCols || []).filter(c => c !== col);
            if (this.defaults) delete this.defaults[col];
            if (this.autoIncrementCol === col) this.autoIncrementCol = null;
            if (this.generatedCols) delete this.generatedCols[col];
            // 列を含む複合キー制約は列ごと削除する（部分キーとして残すと意味が変わるため）
            this.compositeKeys = (this.compositeKeys || []).filter(ck => !ck.cols.includes(col));
        }

        changeColumnType(col, newType) {
            this.version++;
            col = col.toLowerCase();
            const c = this.cols[col];
            if (!c || this.colTypes[col] === newType) return;

            const oldType = this.colTypes[col] || 'ANY';

            // Backup before cast
            const backupNum = new Float64Array(c.num);
            const backupMeta = new Uint32Array(c.meta);
            const backupStrPools = [...this.strPools[col]];
            const backupStrMaps = Object.assign(Object.create(null), this.strMaps[col]);

            this.colTypes[col] = newType;
            this.strPools[col] = [];
            this.strMaps[col] = Object.create(null);

            try {
                for (let i = 0; i < this.rowCount; i++) {
                    const meta = backupMeta[i];
                    const type = meta >>> 24;
                    let val = null;
                    if (type !== 0) {
                        if (type === 1) val = backupNum[i];
                        else if (type === 3) val = backupNum[i] === 1;
                        else if (type === 4) {
                            let d = new Date(backupNum[i]);
                            val = d.toISOString().replace('T', ' ').slice(0, 19);
                        } else {
                            val = backupStrPools[meta & 0xFFFFFF];
                        }
                    }
                    this.setValue(col, i, val);
                }

                if (this.indices[col]) {
                    this.createIndex(col);
                }
            } catch (e) {
                // Rollback on failure
                this.colTypes[col] = oldType;
                c.num.set(backupNum);
                c.meta.set(backupMeta);
                this.strPools[col] = backupStrPools;
                this.strMaps[col] = backupStrMaps;
                throw e;
            }
        }

        grow() {
            this.version++;
            const newCap = this.capacity === 0 ? 10000 : this.capacity * 2;
            for (let col in this.cols) {
                const c = this.cols[col];
                const newNum = new Float64Array(newCap); newNum.set(c.num); c.num = newNum;
                const newMeta = new Uint32Array(newCap); newMeta.set(c.meta); c.meta = newMeta;
            }
            this.capacity = newCap;
        }

        setValue(col, idx, val) {
            col = col.toLowerCase();
            const c = this.cols[col];
            if (!c) return;
            this.version++;   // 差分保存用の変更世代（整数 1 加算のみ）
            const expectedType = this.colTypes[col] || 'ANY';

            // Type Checking & Casting
            if (val === null || val === undefined || (val === '' && expectedType !== 'TEXT' && expectedType !== 'ANY')) {
                val = null;
            } else if (expectedType === 'INTEGER') {
                if (typeof val === 'number') {
                    if (!Number.isInteger(val)) throw new Error(`Type mismatch: Cannot cast '${val}' to INTEGER for column '${col}'`);
                } else if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) {
                    val = parseInt(val, 10);
                } else {
                    throw new Error(`Type mismatch: Cannot cast '${val}' to INTEGER for column '${col}'`);
                }
            } else if (expectedType === 'FLOAT') {
                if (typeof val === 'number') {
                    if (isNaN(val)) throw new Error(`Type mismatch: Cannot cast '${val}' to FLOAT for column '${col}'`);
                } else if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim())) {
                    val = parseFloat(val);
                } else {
                    throw new Error(`Type mismatch: Cannot cast '${val}' to FLOAT for column '${col}'`);
                }
            } else if (expectedType === 'BOOLEAN') {
                if (typeof val === 'boolean') {
                    // pass
                } else if (val === 1 || val === 0) {
                    val = val === 1;
                } else if (typeof val === 'string' && (val.trim().toLowerCase() === 'true' || val.trim().toLowerCase() === 'false' || val.trim() === '1' || val.trim() === '0')) {
                    const s = val.trim().toLowerCase();
                    val = s === 'true' || s === '1';
                } else {
                    throw new Error(`Type mismatch: Cannot cast '${val}' to BOOLEAN for column '${col}'`);
                }
            } else if (expectedType === 'DATE') {
                if (val instanceof Date) {
                    if (isNaN(val.getTime())) throw new Error(`Type mismatch: Invalid DATE for column '${col}'`);
                } else if (typeof val === 'string') {
                    const s = val.trim();
                    // Basic ISO or SQL date format check
                    if (!/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(s)) {
                        throw new Error(`Type mismatch: Cannot cast '${val}' to DATE for column '${col}'. Format must be YYYY-MM-DD`);
                    }
                    let dStr = s.replace(' ', 'T');
                    if (dStr.indexOf('T') !== -1 && !dStr.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(dStr)) dStr += 'Z';
                    let d = new Date(dStr);
                    if (isNaN(d.getTime())) {
                        d = new Date(val); // fallback
                        if (isNaN(d.getTime())) throw new Error(`Type mismatch: Cannot cast '${val}' to DATE for column '${col}'`);
                    }
                    val = d;
                } else {
                    throw new Error(`Type mismatch: Cannot cast '${val}' to DATE for column '${col}'`);
                }
            } else if (expectedType === 'TEXT') {
                val = typeof val === 'object' ? JSON.stringify(val) : String(val);
            }

            // rowCount 以降は未使用領域（行削除後の残留データを含む）であり、
            // 新規行への書き込みでは「旧値なし」として扱う。残留値と新値が偶然一致すると
            // 下のインデックス差分更新がスキップされ、新行がインデックスから漏れるため
            let oldVal = idx < this.rowCount ? this.getValue(col, idx) : null;

            if (val === null || val === undefined) {
                c.meta[idx] = 0; // type 0 = Null
            } else if (typeof val === 'boolean') {
                c.meta[idx] = 3 << 24; // type 3 = Boolean
                c.num[idx] = val ? 1 : 0;
            } else if (val instanceof Date) {
                c.meta[idx] = 4 << 24; // type 4 = Date
                c.num[idx] = val.getTime();
            } else if (typeof val === 'number') {
                c.meta[idx] = 1 << 24; // type 1 = Number
                c.num[idx] = val;
            } else {
                const s = String(val);
                let sIdx = this.strMaps[col][s];
                if (sIdx === undefined) {
                    sIdx = this.strPools[col].length;
                    // meta の文字列インデックスは 24bit 幅。超過すると別の文字列を指して
                    // データが静かに壊れるため、上限到達時は明示的にエラーにする
                    if (sIdx > 0xFFFFFF) throw new Error(`String pool overflow: column '${col}' exceeds 16,777,215 distinct strings. Run VACUUM to reclaim unused entries.`);
                    this.strPools[col].push(s);
                    this.strMaps[col][s] = sIdx;
                }
                c.meta[idx] = (2 << 24) | (sIdx & 0xFFFFFF); // type 2 = String + 24bit index
            }

            // Update Index if exists
            if (this.indices[col]) {
                let newVal = this.getValue(col, idx);
                if (oldVal !== newVal) {
                    if (oldVal !== null && oldVal !== undefined) {
                        let arr = this.indices[col].get(oldVal);
                        if(arr) {
                            let i = arr.indexOf(idx);
                            if(i > -1) arr.splice(i, 1);
                            // 空配列を残すと「値が存在する」と誤判定される（FK/LEFT JOIN等）ため削除
                            if(arr.length === 0) this.indices[col].delete(oldVal);
                        }
                    }
                    if (newVal !== null && newVal !== undefined) {
                        let arr = this.indices[col].get(newVal);
                        if(!arr) { arr = []; this.indices[col].set(newVal, arr); }
                        arr.push(idx);
                    }
                }
            }
        }

        getValue(col, idx) {
            col = col.toLowerCase();
            if (!this.cols[col]) return null;
            const meta = this.cols[col].meta[idx];
            const type = meta >>> 24;
            if (type === 0) return null;
            if (type === 1) return this.cols[col].num[idx];
            if (type === 3) return this.cols[col].num[idx] === 1;
            if (type === 4) {
                let d = new Date(this.cols[col].num[idx]);
                return d.toISOString().replace('T', ' ').slice(0, 19);
            }
            return this.strPools[col][meta & 0xFFFFFF];
        }

        getColumnNames() {
            return Object.keys(this.cols);
        }

        reorderColumns(newOrder) {
            const newCols = Object.create(null);
            const newColTypes = Object.create(null);
            const newStrPools = Object.create(null);
            const newStrMaps = Object.create(null);
            const newIndices = Object.create(null);

            newOrder.forEach(col => {
                col = col.toLowerCase();
                if (this.cols[col]) {
                    newCols[col] = this.cols[col];
                    newColTypes[col] = this.colTypes[col] || 'ANY';
                    newStrPools[col] = this.strPools[col];
                    newStrMaps[col] = this.strMaps[col];
                    if (this.indices[col]) newIndices[col] = this.indices[col];
                }
            });

            this.cols = newCols;
            this.colTypes = newColTypes;
            this.strPools = newStrPools;
            this.strMaps = newStrMaps;
            this.indices = newIndices;
        }

        createIndex(col) {
            col = col.toLowerCase();
            if (!this.cols[col]) throw new Error(`Column '${col}' not found.`);
            this.indices[col] = new Map();
            for(let i=0; i<this.rowCount; i++) {
                let val = this.getValue(col, i);
                if(val !== null && val !== undefined) {
                    let arr = this.indices[col].get(val);
                    if(!arr) { arr = []; this.indices[col].set(val, arr); }
                    arr.push(i);
                }
            }
        }

        rebuildIndices() {
            let cols = Object.keys(this.indices);
            this.indices = Object.create(null);
            cols.forEach(c => this.createIndex(c));
        }

        // UNIQUE / PRIMARY KEY チェック用: 指定値を持つ行インデックスを返す
        findValueRows(col, val) {
            col = col.toLowerCase();
            if (!this.cols[col]) return [];
            if (this.indices[col]) {
                return this.indices[col].get(val) || [];
            }
            const rows = [];
            for (let i = 0; i < this.rowCount; i++) {
                if (this.getValue(col, i) === val) rows.push(i);
            }
            return rows;
        }

        // 構造変更（ADD/DROP/RENAME COLUMN・型変更）のロールバック用の完全クローン。
        // cloneData() が列データのみ複製するのに対し、列構成・型・制約・インデックスを
        // 含むテーブル全体を独立したオブジェクトとして複製する
        cloneFull() {
            const t = new Table(this.capacity);
            t.rowCount = this.rowCount;
            for (const col in this.cols) {
                t.cols[col] = {
                    num: new Float64Array(this.cols[col].num),
                    meta: new Uint32Array(this.cols[col].meta)
                };
                t.colTypes[col] = this.colTypes[col] || 'ANY';
                t.strPools[col] = [...this.strPools[col]];
                t.strMaps[col] = Object.assign(Object.create(null), this.strMaps[col]);
            }
            t.foreignKeys = JSON.parse(JSON.stringify(this.foreignKeys || []));
            t.uniqueCols = [...(this.uniqueCols || [])];
            t.primaryKey = this.primaryKey;
            t.notNullCols = [...(this.notNullCols || [])];
            t.defaults = Object.assign(Object.create(null), this.defaults || {});
            t.autoIncrementCol = this.autoIncrementCol;
            t.checks = JSON.parse(JSON.stringify(this.checks || []));
            t.onUpdateNowCols = [...(this.onUpdateNowCols || [])];
            t.version = this.version;
            t.compositeKeys = JSON.parse(JSON.stringify(this.compositeKeys || []));
            t.generatedCols = Object.assign(Object.create(null), this.generatedCols || {});
            t.isTemp = !!this.isTemp;
            Object.keys(this.indices).forEach(c => t.createIndex(c));
            return t;
        }

        // Deep copy for Copy-on-Write transaction snapshots
        cloneData() {
            const clonedCols = Object.create(null);
            for (let col in this.cols) {
                clonedCols[col] = {
                    num: new Float64Array(this.cols[col].num),
                    meta: new Uint32Array(this.cols[col].meta)
                };
            }
            const strPoolsSizes = Object.create(null);
            for (let col in this.strPools) {
                strPoolsSizes[col] = this.strPools[col].length;
            }
            return {
                capacity: this.capacity,
                rowCount: this.rowCount,
                cols: clonedCols,
                strPoolsSizes: strPoolsSizes,
                foreignKeys: JSON.parse(JSON.stringify(this.foreignKeys))
            };
        }

        // 未参照文字列のGCと予約容量の縮小（VACUUM / OPTIMIZE 用）
        vacuum() {
            this.version++;
            let freedStrings = 0;
            for (const col in this.cols) {
                const oldPool = this.strPools[col];
                if (oldPool.length > 0) {
                    const newPool = [];
                    const newMap = Object.create(null);
                    const meta = this.cols[col].meta;
                    for (let i = 0; i < this.rowCount; i++) {
                        if ((meta[i] >>> 24) !== 2) continue;
                        const s = oldPool[meta[i] & 0xFFFFFF];
                        let idx = newMap[s];
                        if (idx === undefined) { idx = newPool.length; newPool.push(s); newMap[s] = idx; }
                        meta[i] = (2 << 24) | (idx & 0xFFFFFF);
                    }
                    freedStrings += oldPool.length - newPool.length;
                    this.strPools[col] = newPool;
                    this.strMaps[col] = newMap;
                }
            }
            let freedCapacity = 0;
            const newCap = Math.max(1024, this.rowCount);
            if (newCap < this.capacity) {
                for (const col in this.cols) {
                    const c = this.cols[col];
                    const num = new Float64Array(newCap); num.set(c.num.subarray(0, this.rowCount)); c.num = num;
                    const m2 = new Uint32Array(newCap); m2.set(c.meta.subarray(0, this.rowCount)); c.meta = m2;
                }
                freedCapacity = this.capacity - newCap;
                this.capacity = newCap;
            }
            return { freedStrings, freedCapacity };
        }

        // Restore from snapshot for ROLLBACK
        restoreData(snapshot) {
            this.capacity = snapshot.capacity;
            this.rowCount = snapshot.rowCount;
            this.cols = snapshot.cols;
            for (let col in snapshot.strPoolsSizes) {
                const size = snapshot.strPoolsSizes[col];
                if (this.strPools[col].length > size) {
                    const removed = this.strPools[col].splice(size);
                    removed.forEach(s => delete this.strMaps[col][s]);
                }
            }
            this.foreignKeys = snapshot.foreignKeys || [];
            this.rebuildIndices();
        }
    }
