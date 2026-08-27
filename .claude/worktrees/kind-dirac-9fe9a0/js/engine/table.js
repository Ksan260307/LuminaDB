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
            // 名前付き制約の索引: name -> { kind: 'pk'|'unique'|'fk'|'check', cols: [...] }。
            // ALTER TABLE ... ADD CONSTRAINT <name> ... で登録し
            // DROP CONSTRAINT <name> の逆引きに使う（実体は uniqueCols/foreignKeys 側）
            this.constraintNames = Object.create(null);
            // 生成列 (GENERATED ALWAYS AS): col -> 式テキスト（STORED相当。INSERT/UPDATE時に評価）
            this.generatedCols = Object.create(null);
            // ON UPDATE CURRENT_TIMESTAMP を持つ列名（UPDATE 時に自動更新）
            this.onUpdateNowCols = [];
            // 変更世代。setValue / 列操作のたびに増える。IndexedDB の差分保存で
            // 「この表は前回保存から変わったか」を O(1) で判定するために使う
            this.version = 0;
            // CREATE TEMPORARY TABLE で作られたテーブル（IDB保存・SQLエクスポート対象外）
            this.isTemp = false;
            // AUTO_INCREMENT の採番下限。TRUNCATE ... CONTINUE IDENTITY が設定する
            // （通常は既存行の最大値+1 で決まるので 1 のまま）
            this.identityFloor = 1;
            // 列の照合順序: col -> 'NOCASE' | 'NOACCENT' | 'NUMERIC' 等。
            // 指定された列は比較・並べ替え・一意性判定で正規化した値を使う
            this.collations = Object.create(null);
            // 宣言された桁・長さ: col -> {kind:'DECIMAL', p, s} | {kind:'TEXT', len}
            // 従来は DECIMAL(10,2) / VARCHAR(3) の指定を捨てていたため、
            // 宣言が単なる飾りになっていた（CAST は正しく丸める / 切り詰めるのに、
            // 格納時は素通し）。IDB 保存・cloneFull・列の改名 / 削除に追随させる
            this.colTypeSpec = Object.create(null);
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

        // 式テキスト中の列参照だけを置換する（文字列リテラルの中身は触らない）。
        // CHECK 制約・生成列の式は復元済みの SQL テキストなので、改名に追随させないと
        // 「存在しない列」を参照し続けて、その表が挿入不能になる
        static renameColRefs(text, oldCol, newCol) {
            if (text == null) return text;
            return String(text).replace(
                /'(?:[^']|'')*'|"(?:[^"]|"")*"|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g,
                (m) => (m[0] === "'" || m[0] === '"') ? m : (m.toLowerCase() === oldCol ? newCol : m)
            );
        }

        // 式テキストがその列を参照しているか（改名・削除の依存判定用）
        static exprRefsCol(text, col) {
            if (text == null) return false;
            let hit = false;
            String(text).replace(
                /'(?:[^']|'')*'|"(?:[^"]|"")*"|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g,
                (m) => { if (m[0] !== "'" && m[0] !== '"' && m.toLowerCase() === col) hit = true; return m; }
            );
            return hit;
        }

        // キーの挿入順を保ったまま 1 つのキーだけ改名する。
        // `delete` してから代入すると末尾へ移動し、`SELECT *` や DESCRIBE の
        // 列順が変わってしまう（従来はこれで列順が壊れていた）
        // 指定位取りへゼロから遠い方向で丸める。DECIMAL(p,s) 列の格納時に使う。
        // 10^sc の乗算だと 1.005*100 が 100.49999... になる（1.005 が二進で表せない）ため、
        // 指数表記の文字列を経由して小数点を移す — engine-expression の __round_scale と
        // 同じ手順で、CAST と格納で結果が食い違わないようにしている
        // 宣言された型名を検査用の正準名へ寄せる。colTypes には書かれたままの綴りを
        // 残す（DESCRIBE で見せるため）が、値の検査はここで揃える。
        // 従来は綴りをそのまま比較していたので `INTEGER` の列だけが型検査を受け、
        // `INT` / `BIGINT` / `SMALLINT` の列は小数も文字列も素通しだった。
        // `TEXT` 以外の文字列型に '' を入れると NULL になるという食い違いもあった。
        // 日付系は DATE と DATETIME / TIMESTAMP で保持する情報が違うので分けたままにする
        static _canonType(t) {
            if (!t) return 'ANY';
            const k = String(t).toUpperCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
            return Table.TYPE_KINDS[k] || k;
        }

        static _roundScale(n, sc) {
            const str = String(n);
            if (str.indexOf('e') !== -1 || str.indexOf('E') !== -1) {
                const f = Math.pow(10, sc);
                return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
            }
            const shifted = Number(str + 'e' + sc);
            if (!isFinite(shifted)) return n;
            const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
            const back = Number(rounded + 'e' + (-sc));
            return isFinite(back) ? back : n;
        }

        static _renameKeyInPlace(dict, oldKey, newKey) {
            const out = Object.create(null);
            for (const k in dict) out[k === oldKey ? newKey : k] = dict[k];
            return out;
        }

        renameColumn(oldCol, newCol) {
            this.version++;
            oldCol = oldCol.toLowerCase();
            newCol = newCol.toLowerCase();
            if (!this.cols[oldCol] || this.cols[newCol] || oldCol === newCol) return;

            this.cols = Table._renameKeyInPlace(this.cols, oldCol, newCol);
            this.colTypes = Table._renameKeyInPlace(this.colTypes, oldCol, newCol);
            if (this.colTypeSpec && oldCol in this.colTypeSpec) {
                this.colTypeSpec = Table._renameKeyInPlace(this.colTypeSpec, oldCol, newCol);
            }
            this.strPools = Table._renameKeyInPlace(this.strPools, oldCol, newCol);
            this.strMaps = Table._renameKeyInPlace(this.strMaps, oldCol, newCol);

            if (this.indices[oldCol]) {
                this.indices = Table._renameKeyInPlace(this.indices, oldCol, newCol);
            }

            if (this.primaryKey === oldCol) this.primaryKey = newCol;
            this.uniqueCols = (this.uniqueCols || []).map(c => c === oldCol ? newCol : c);
            this.notNullCols = (this.notNullCols || []).map(c => c === oldCol ? newCol : c);
            if (this.defaults && oldCol in this.defaults) {
                this.defaults[newCol] = this.defaults[oldCol];
                delete this.defaults[oldCol];
            }
            if (this.autoIncrementCol === oldCol) this.autoIncrementCol = newCol;
            if (this.collations && oldCol in this.collations) {
                this.collations[newCol] = this.collations[oldCol];
                delete this.collations[oldCol];
            }
            if (this.generatedCols && oldCol in this.generatedCols) {
                this.generatedCols = Table._renameKeyInPlace(this.generatedCols, oldCol, newCol);
            }
            // 生成列の「式」と CHECK 制約の「式」に出てくる旧列名も書き換える。
            // ここを追随させないと `GENERATED ALWAYS AS (b*2)` / `CHECK (b > 0)` が
            // 改名後に解決できず、正しい値の INSERT まで必ず失敗するようになる
            if (this.generatedCols) {
                for (const c in this.generatedCols) {
                    this.generatedCols[c] = Table.renameColRefs(this.generatedCols[c], oldCol, newCol);
                }
            }
            this.checks = (this.checks || []).map(ck => ({ ...ck, expr: Table.renameColRefs(ck.expr, oldCol, newCol) }));
            (this.compositeKeys || []).forEach(ck => {
                ck.cols = ck.cols.map(c => c === oldCol ? newCol : c);
            });
            // 名前付き制約の台帳（DROP CONSTRAINT の逆引きに使う）の列名も追随させる
            for (const nm in (this.constraintNames || {})) {
                const rec = this.constraintNames[nm];
                if (rec && Array.isArray(rec.cols)) rec.cols = rec.cols.map(c => c === oldCol ? newCol : c);
            }
            this.onUpdateNowCols = (this.onUpdateNowCols || []).map(c => c === oldCol ? newCol : c);
            // 外部キーの参照元列名も追随させる（従来は取り残されて制約が効かなくなっていた）。
            // 単一列は { col }、複合列は { cols: [...] } の両形を持つ
            (this.foreignKeys || []).forEach(fk => {
                if (fk.cols) fk.cols = fk.cols.map(c => c === oldCol ? newCol : c);
                else if (fk.col === oldCol) fk.col = newCol;
            });
        }

        dropColumn(col) {
            col = col.toLowerCase();
            if (!this.cols[col]) return;
            delete this.cols[col];
            delete this.colTypes[col];
            if (this.colTypeSpec) delete this.colTypeSpec[col];
            delete this.strPools[col];
            delete this.strMaps[col];
            delete this.indices[col];
            this.uniqueCols = (this.uniqueCols || []).filter(c => c !== col);
            if (this.primaryKey === col) this.primaryKey = null;
            this.notNullCols = (this.notNullCols || []).filter(c => c !== col);
            if (this.defaults) delete this.defaults[col];
            if (this.autoIncrementCol === col) this.autoIncrementCol = null;
            if (this.collations) delete this.collations[col];
            if (this.generatedCols) delete this.generatedCols[col];
            // 列を含む複合キー制約は列ごと削除する（部分キーとして残すと意味が変わるため）
            this.compositeKeys = (this.compositeKeys || []).filter(ck => !ck.cols.includes(col));
            // 同じ理由で、その列を含む外部キーも落とす（残すと存在しない列を参照し続ける）
            this.foreignKeys = (this.foreignKeys || []).filter(fk => !(fk.cols || [fk.col]).includes(col));
            // その列を参照する CHECK 制約も落とす。残すと存在しない列を参照し続け、
            // 以後この表への INSERT / UPDATE が必ず失敗するようになる（孤児制約）
            this.checks = (this.checks || []).filter(ck => !Table.exprRefsCol(ck.expr, col));
            this.onUpdateNowCols = (this.onUpdateNowCols || []).filter(c => c !== col);
        }

        // transform: 行ごとの新しい値の配列（ALTER COLUMN ... USING <expr> 用）。
        // 指定時は既存値のキャストではなくこの値を格納する
        changeColumnType(col, newType, transform) {
            this.version++;
            col = col.toLowerCase();
            const c = this.cols[col];
            if (!c || (this.colTypes[col] === newType && !transform)) return;

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
                    this.setValue(col, i, transform ? transform[i] : val);
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
            const expectedType = Table._canonType(this.colTypes[col]);

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
                    // NaN だけでなく ±Infinity も拒む。1e309 のような桁あふれを黙って
                    // 受け入れると Infinity が格納され、読み出しても比較しても
                    // 実DBには無い値が出てくる（INTEGER 側は既に弾いている）
                    if (!isFinite(val)) throw new Error(`Type mismatch: Cannot cast '${val}' to FLOAT for column '${col}'`);
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
                // DATE と宣言した列は日付だけを持つ。時刻付きの値を入れると
                // そのまま保持され、同じ日が時刻ごとに別の値として扱われていた
                // （GROUP BY / DISTINCT / 等値比較が日単位にならない）
                if (/^DATE$/i.test(expectedType) && val instanceof Date && !isNaN(val.getTime())) {
                    val = new Date(Date.UTC(val.getUTCFullYear(), val.getUTCMonth(), val.getUTCDate()));
                }
            } else if (expectedType === 'TEXT') {
                val = typeof val === 'object' ? JSON.stringify(val) : String(val);
            }

            // 宣言された桁・長さを適用する。CAST は以前から正しく丸め／切り詰めていたのに
            // 格納時は素通しだったため、DECIMAL(10,2) の列に 123.4567 がそのまま入り、
            // VARCHAR(3) に 8 文字が入っていた（宣言が飾りになっていた）
            const spec = this.colTypeSpec && this.colTypeSpec[col];
            if (spec && val !== null && val !== undefined) {
                if (spec.kind === 'DECIMAL' && typeof val === 'number') {
                    if (spec.s !== null) val = Table._roundScale(val, spec.s);
                    if (spec.p !== null && spec.s !== null && Math.abs(val) >= Math.pow(10, spec.p - spec.s)) {
                        throw new Error(`Out of range value ${val} for column '${col}' DECIMAL(${spec.p},${spec.s})`);
                    }
                } else if (spec.kind === 'TEXT' && typeof val === 'string' && spec.len !== null && val.length > spec.len) {
                    throw new Error(`Data too long for column '${col}' (declared length ${spec.len}, got ${val.length})`);
                }
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
                    // 1 行は「その値の照合候補キー」全部に載る（Table.indexKeysOf を参照）。
                    // 差し引きも同じ鍵の集合で行わないと、片方の綴りだけが索引に残る
                    this._unindexRow(col, oldVal, idx);
                    this._indexRow(col, newVal, idx);
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
                const iso = new Date(this.cols[col].num[idx]).toISOString();
                // DATE と宣言した列は日付だけを返す（DATETIME / TIMESTAMP は時刻も返す）。
                // 従来は常に 'YYYY-MM-DD HH:MM:SS' を返しており、CAST(x AS DATE) が
                // 日付だけを返すのと食い違っていた（同じ日付が二通りの綴りで出る）
                return /^DATE$/i.test(this.colTypes[col] || '') ? iso.slice(0, 10)
                                                                : iso.replace('T', ' ').slice(0, 19);
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

        // 索引への 1 行ぶんの登録 / 抹消。値ひとつが複数の鍵に載るので、
        // 追加も削除も Table.indexKeysOf が出す鍵の集合ぜんぶを回す
        _indexRow(col, val, idx) {
            const keys = Table.indexKeysOf(val);
            if (!keys) return;                       // NULL は索引に載せない
            const map = this.indices[col];
            for (let ki = 0; ki < keys.length; ki++) {
                const k = keys[ki];
                let arr = map.get(k);
                if (!arr) {
                    arr = []; map.set(k, arr);
                    // 相異なりキー数は Map の大きさでは測れない（日付は UTC と現地の
                    // 2 つの鍵に載るので数え上がる）。値ごとに必ず 1 つある先頭の鍵だけ数える
                    if (ki === 0) map.distinct = (map.distinct || 0) + 1;
                }
                // バケットは行番号の昇順に保つ。結合はこの配列をそのまま候補列として
                // 回すので、UPDATE で張り直した行が末尾に付くと結合の行順が
                // 入れ子ループと食い違う（索引の有無で並びが変わる）。
                // 追記が圧倒的に多いので、末尾より大きければそのまま push する
                if (arr.length === 0 || arr[arr.length - 1] < idx) { arr.push(idx); continue; }
                let lo = 0, hi = arr.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < idx) lo = mid + 1; else hi = mid; }
                arr.splice(lo, 0, idx);
            }
        }

        _unindexRow(col, val, idx) {
            const keys = Table.indexKeysOf(val);
            if (!keys) return;
            const map = this.indices[col];
            for (let ki = 0; ki < keys.length; ki++) {
                const k = keys[ki];
                const arr = map.get(k);
                if (!arr) continue;
                const i = arr.indexOf(idx);
                if (i > -1) arr.splice(i, 1);
                // 空配列を残すと「値が存在する」と誤判定される（FK/LEFT JOIN等）ため削除
                if (arr.length === 0) {
                    map.delete(k);
                    if (ki === 0) map.distinct = (map.distinct || 1) - 1;
                }
            }
        }

        createIndex(col) {
            col = col.toLowerCase();
            if (!this.cols[col]) throw new Error(`Column '${col}' not found.`);
            const map = new Map();
            map.distinct = 0;
            this.indices[col] = map;
            for(let i=0; i<this.rowCount; i++) {
                this._indexRow(col, this.getValue(col, i), i);
            }
        }

        // 索引の相異なりキー数（選択率の代わり / SHOW INDEX の CARDINALITY）。
        // Map.size は値ひとつが複数の鍵に載るぶん数え上がるので、そちらは使わない
        indexCardinality(col) {
            const map = this.indices[String(col).toLowerCase()];
            return map ? (map.distinct || 0) : 0;
        }

        rebuildIndices() {
            let cols = Object.keys(this.indices);
            this.indices = Object.create(null);
            cols.forEach(c => this.createIndex(c));
        }

        // UNIQUE / PRIMARY KEY チェック用: 指定値を持つ行インデックスを返す。
        //
        // 索引の鍵は比較（__eq）と同じ同値類で張ってあり、'2' と 2 と ' 2 ' が
        // 同じバケットに同居する。制約の判定はあくまで**生値の一致**なので、
        // 索引は候補を絞る網としてだけ使い、拾った候補を生値で選び直す
        // （絞らないと '2' の入った列に 2 を入れられなくなる）。
        // 比較は Map と同じ SameValueZero にして、走査経路との差を作らない
        findValueRows(col, val) {
            col = col.toLowerCase();
            if (!this.cols[col]) return [];
            if (this.indices[col]) {
                const keys = Table.indexKeysOf(val);
                if (!keys) return [];
                const map = this.indices[col];
                const seen = new Set();
                for (const k of keys) {
                    const arr = map.get(k);
                    if (arr) for (const i of arr) seen.add(i);
                }
                const hits = [];
                for (const i of seen) {
                    const v = this.getValue(col, i);
                    if (v === val || (v !== v && val !== val)) hits.push(i);
                }
                return hits.sort((a, b) => a - b);
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
            t.colTypeSpec = JSON.parse(JSON.stringify(this.colTypeSpec || {}));
            t.version = this.version;
            t.compositeKeys = JSON.parse(JSON.stringify(this.compositeKeys || []));
            t.constraintNames = Object.assign(Object.create(null), JSON.parse(JSON.stringify(this.constraintNames || {})));
            t.generatedCols = Object.assign(Object.create(null), this.generatedCols || {});
            t.isTemp = !!this.isTemp;
            t.identityFloor = this.identityFloor || 1;
            t.collations = Object.assign(Object.create(null), this.collations || {});
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

    // ------------------------------------------------------------------------
    // 値ひとつぶんの「照合候補キー」を列挙する。ハッシュ索引（Table.indices）と
    // 結合ハッシュ（engine-select の _joinKeysOf）が共有する唯一の定義。
    //
    // 満たすべき性質はただ一つ: __eq(a, b) が真なら indexKeysOf(a) と
    // indexKeysOf(b) が必ず 1 個以上のキーを共有すること。これが成り立つ限り、
    // ハッシュは「候補を絞る網」として使えて真の一致を取り落とさない。逆にキーが
    // 衝突して余計な候補が出るのは構わない（引いた側が式そのもので検算する）。
    //
    // 生値をそのまま Map の鍵にしていた頃は、この性質が破れていた。__eq は
    // __cpair で型を寄せる（数値らしい文字列と数値が一致する / 日付らしい文字列は
    // 時刻値で一致する）のに索引は寄せないので、索引の有無で答えが変わっていた:
    //   CREATE TABLE t (g TEXT); INSERT INTO t VALUES (' 2 ');
    //   SELECT * FROM t WHERE g = 2      -- 索引ありで 0 件 / 索引なしで 1 件
    //
    // 逆向き（キーが同じでも __eq が偽）は普通に起きることに注意。__cpair は
    // 同型どうしを生で比べるので '2' と ' 2 ' は等しくない（どちらも 'n:2' を持つ）。
    // だから引いた候補は必ず検算する。
    //
    // NULL は等価に参加しないので null を返す（索引にも載せない）。
    // ------------------------------------------------------------------------
    Table.indexKeysOf = function (v) {
        if (v === null || v === undefined) return null;
        const keys = [];
        // 数値への寄せ（__cpair の numOf と同じ規則。定義は Table._numOf に 1 つ）
        const n = (v instanceof Date) ? v.getTime() : Table._numOf(v);
        if (!isNaN(n)) keys.push('n:' + n);
        // 日付への寄せ（__cpair の __dnum 経路）。列は日付を文字列で返すので
        // 見るのは文字列だけでよい。
        //
        // ここで Date.parse を頼れないことに注意: '2026-01-01' は UTC 深夜、
        // '2026-01-01 00:00:00' は現地深夜として解釈され得るので、同じ瞬間を指す
        // 2 つの綴りが別の数になる。__eq 側（__date_parse）がどちらの流儀でも
        // 取り落とさないよう、UTC 解釈と現地解釈の両方をキーに出す
        if (typeof v === 'string') {
            const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z?))?$/);
            if (m) {
                const y = +m[1], mo = +m[2] - 1, d = +m[3];
                const hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
                keys.push('n:' + Date.UTC(y, mo, d, hh, mi, ss));
                keys.push('n:' + new Date(y, mo, d, hh, mi, ss).getTime());
            }
        }
        // 数値にも日付にも読めない値だけが生比較用の鍵を持つ。
        //
        // 寄せた鍵があるなら 's:' は要らない——同じ 's:' を持つ 2 値は綴りが同じで、
        // 綴りが同じなら寄せ方も同じになるので、必ず同じ 'n:' も共有する。逆に
        // 'n:' を持たない値（'abc' / NaN）と 'n:' を持つ値が __eq で等しくなることは
        // ない（__cpair は数値化できない組を生で比べる）。鍵を減らしておかないと
        // 数値ひとつが 2 つのバケットに載り、引くたびに和集合を組み直す羽目になる
        if (keys.length === 0) keys.push('s:' + String(v));
        return keys.length === 1 ? keys : [...new Set(keys)];
    };

    // ------------------------------------------------------------------------
    // 2 値の等価判定。engine-expression の __cpair / __eq と同じ規則を、式コンパイラを
    // 通さずに行うためのもの。索引で拾った候補の検算に使う。
    //
    // なぜ式を回さないか: 点引き（`WHERE col = <リテラル>`）は相関副問い合わせから
    // 1 行ごとに呼ばれる。WHERE を検算のために残すと、外側の行ごとに文字列の
    // 押し下げ判定と式コンパイルが走って 4 倍遅くなった。値 2 つの比較で済ませる。
    //
    // ここが __eq とずれると「索引の有無で答えが変わる」に逆戻りするので、
    // js/tests/test-suite-v66.js の G 章が SQL の `=` と総当たりで突き合わせている。
    // ------------------------------------------------------------------------
    Table._DATEISH = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

    // __dnum 相当。日付らしい値だけを時刻へ寄せる（数値は日付として読まない）
    Table._dateNum = function (v) {
        if (v instanceof Date) return v.getTime();
        if (typeof v === 'string' && Table._DATEISH.test(v)) {
            // __date_parse と同じ解釈: 時刻を伴う綴りは UTC として読む
            let s = v.replace(' ', 'T');
            if (s.indexOf('T') !== -1 && !s.endsWith('Z')) s += 'Z';
            let d = new Date(s);
            if (isNaN(d.getTime())) d = new Date(v);
            return isNaN(d.getTime()) ? NaN : d.getTime();
        }
        return NaN;
    };

    Table.valueEq = function (a, b) {
        if (a === null || a === undefined || b === null || b === undefined) return false;
        const x = Table._dateNum(a), y = Table._dateNum(b);
        if (!isNaN(x) && !isNaN(y)) return x === y;
        if (typeof a === typeof b) return a === b;
        const na = Table._numOf(a), nb = Table._numOf(b);
        return (isNaN(na) || isNaN(nb)) ? a === b : na === nb;
    };

    // __cpair の numOf と同じ規則（空文字は数値化しない: `'' = 0` は偽のまま）
    Table._numOf = function (v) {
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string') {
            const t = v.trim();
            if (t === '') return NaN;
            const n = Number(t);
            return isFinite(n) ? n : NaN;
        }
        return NaN;
    };

    // 列の宣言型 -> 検査用の正準名（_canonType が引く）
    Table.TYPE_KINDS = {
        'INT': 'INTEGER', 'INTEGER': 'INTEGER', 'SMALLINT': 'INTEGER', 'BIGINT': 'INTEGER',
        'TINYINT': 'INTEGER', 'MEDIUMINT': 'INTEGER', 'INT2': 'INTEGER', 'INT4': 'INTEGER',
        'INT8': 'INTEGER', 'SERIAL': 'INTEGER', 'BIGSERIAL': 'INTEGER',
        'SIGNED': 'INTEGER', 'UNSIGNED': 'INTEGER',
        'FLOAT': 'FLOAT', 'REAL': 'FLOAT', 'DOUBLE': 'FLOAT', 'DOUBLE PRECISION': 'FLOAT',
        'BINARY_FLOAT': 'FLOAT', 'BINARY_DOUBLE': 'FLOAT',
        // DECIMAL 系は桁の丸めを colTypeSpec 側で行うため、値の検査は FLOAT と同じでよい
        'DECIMAL': 'FLOAT', 'NUMERIC': 'FLOAT', 'DEC': 'FLOAT', 'NUMBER': 'FLOAT',
        'MONEY': 'FLOAT', 'SMALLMONEY': 'FLOAT',
        'TEXT': 'TEXT', 'VARCHAR': 'TEXT', 'CHAR': 'TEXT', 'CHARACTER': 'TEXT',
        'CHARACTER VARYING': 'TEXT', 'VARCHAR2': 'TEXT', 'NVARCHAR': 'TEXT', 'NVARCHAR2': 'TEXT',
        'NCHAR': 'TEXT', 'STRING': 'TEXT', 'CLOB': 'TEXT', 'NCLOB': 'TEXT',
        'LONGTEXT': 'TEXT', 'MEDIUMTEXT': 'TEXT', 'TINYTEXT': 'TEXT',
        'BOOL': 'BOOLEAN', 'BOOLEAN': 'BOOLEAN',
        'DATE': 'DATE'
        // DATETIME / TIMESTAMP / TIME は文字列のまま保持する（現行の挙動を変えない）
    };
