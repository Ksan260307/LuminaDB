    // ============================================================================
    // [External API] - 外部からのクエリ受付
    //   1. window.LuminaDB      : JS API（パラメータバインド付き）
    //   2. fetch インターセプト : lumina://query 等の仮想エンドポイント
    //   3. postMessage          : iframe / 別ウィンドウからのクエリ受付
    // ============================================================================

    // プレースホルダを安全なリテラルへ置換する（文字列リテラル内は無視）。
    //   - 配列       : '?' を順番にバインドする
    //   - オブジェクト: ':name' / '@name' を名前でバインドする
    function bindQueryParams(sql, params) {
        if (params == null) return sql;
        const isNamed = !Array.isArray(params) && typeof params === 'object' && !(params instanceof Date);
        if (!isNamed && params.length === 0) return sql;
        const toLiteral = (v) => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') {
                if (!isFinite(v)) throw new Error('Cannot bind non-finite number parameter.');
                return String(v);
            }
            if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
            if (v instanceof Date) return `DATE('${v.toISOString().replace('T', ' ').slice(0, 19)}')`;
            return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        };
        let out = '';
        let inStr = null;
        let idx = 0;
        for (let p = 0; p < sql.length; p++) {
            const ch = sql[p];
            if (inStr) {
                // バックスラッシュエスケープは次の1文字ごと取り込む
                // （'\\' の直後の引用符を「エスケープ済み」と誤認して文字列が閉じなくなるのを防ぐ）
                if (ch === '\\') {
                    out += ch;
                    if (p + 1 < sql.length) { out += sql[p + 1]; p++; }
                    continue;
                }
                out += ch;
                if (ch === inStr) inStr = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inStr = ch; out += ch; continue; }
            if (!isNamed && ch === '?') {
                if (idx >= params.length) throw new Error(`Parameter binding failed: placeholder #${idx + 1} has no value.`);
                out += toLiteral(params[idx++]);
                continue;
            }
            if (isNamed && (ch === ':' || ch === '@')) {
                const nm = sql.slice(p).match(/^[:@]([a-zA-Z_][a-zA-Z0-9_]*)/);
                if (nm) {
                    const key = nm[1];
                    if (!(key in params)) throw new Error(`Parameter binding failed: no value for named parameter '${ch}${key}'.`);
                    out += toLiteral(params[key]);
                    p += nm[0].length - 1;
                    continue;
                }
            }
            out += ch;
        }
        if (!isNamed && idx < params.length) throw new Error(`Parameter binding failed: ${params.length} values given but only ${idx} placeholders found.`);
        return out;
    }

    // オブジェクトCRUDヘルパー共用: 識別子検証 / WHERE句の組み立て
    const _validIdent = (s) => typeof s === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);

    // RFC 4180 の CSV パーサ（引用符内の区切り・改行・二重引用符に対応）。
    // 行末は CRLF / LF の両方を受け、末尾の空行は捨てる
    function parseCsv(text, delim) {
        const rows = [];
        let row = [], field = '', inQuotes = false;
        const s = String(text).replace(/^﻿/, '');   // BOM を落とす
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (s[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else field += ch;
                continue;
            }
            if (ch === '"' && field === '') { inQuotes = true; continue; }
            if (ch === delim) { row.push(field); field = ''; continue; }
            if (ch === '\r') { if (s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; continue; }
            if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
            field += ch;
        }
        if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
        return rows.filter(r => !(r.length === 1 && r[0] === ''));
    }

    // where の演算子オブジェクト（{gt: 30, lte: 50} 等）で使えるキー → SQL演算子
    const _WHERE_OPS = { gt: '>', gte: '>=', lt: '<', lte: '<=', ne: '<>', like: 'LIKE' };

    // where オブジェクトから句を組み立てる。値は '?' プレースホルダで params へ積む。
    //   スカラー        : 等価条件（null は IS NULL）
    //   配列            : IN (...)（空配列は常に偽）
    //   演算子オブジェクト: { gt, gte, lt, lte, ne, like, in } を AND 結合
    //     例) { age: { gte: 20, lt: 30 }, name: { like: 'A%' }, id: [1, 2, 3] }
    function buildWhereClause(where, params) {
        if (where == null) return '';
        if (typeof where !== 'object' || Array.isArray(where)) throw new Error('where must be a plain object.');
        const keys = Object.keys(where);
        if (keys.length === 0) return '';
        const condFor = (k, v) => {
            if (v === null || v === undefined) return `${k} IS NULL`;
            if (Array.isArray(v)) {
                if (v.length === 0) return '1 = 0';
                v.forEach(x => params.push(x));
                return `${k} IN (${v.map(() => '?').join(', ')})`;
            }
            if (typeof v === 'object' && !(v instanceof Date)) {
                const opKeys = Object.keys(v);
                if (opKeys.length === 0) throw new Error(`Empty operator object for column '${k}'.`);
                const conds = opKeys.map(op => {
                    if (op === 'in') return condFor(k, Array.isArray(v[op]) ? v[op] : [v[op]]);
                    const sqlOp = _WHERE_OPS[op];
                    if (!sqlOp) throw new Error(`Unknown operator '${op}' in where. Use ${Object.keys(_WHERE_OPS).join('/')}/in.`);
                    if (v[op] === null || v[op] === undefined) throw new Error(`Operator '${op}' requires a non-null value.`);
                    params.push(v[op]);
                    return `${k} ${sqlOp} ?`;
                });
                return conds.join(' AND ');
            }
            params.push(v);
            return `${k} = ?`;
        };
        const parts = keys.map(k => {
            if (!_validIdent(k)) throw new Error(`Invalid column name in where: '${k}'`);
            return condFor(k, where[k]);
        });
        return ' WHERE ' + parts.join(' AND ');
    }

    // 読み取り専用文の判定。WITH 句 (CTE) は定義部を読み飛ばして本体の文種で判定する
    // （文字列リテラル内の括弧・引用符も考慮する。判定不能な場合は保守的に false = 書き込み扱い）
    function isReadOnlySql(sql) {
        let s = String(sql).trim();
        if (/^with\b/i.test(s)) {
            let i = s.match(/^with\s+(recursive\s+)?/i)[0].length;
            while (true) {
                const m = s.slice(i).match(/^([a-zA-Z0-9_]+)\s*(?:\(\s*[a-zA-Z0-9_\s,]+?\s*\))?\s+as\s*\(/i);
                if (!m) return false;
                let depth = 0, j = i + m[0].length - 1, end = -1, inStr = null;
                for (; j < s.length; j++) {
                    const ch = s[j];
                    if (inStr) {
                        if (ch === '\\') { j++; continue; }
                        if (ch === inStr) inStr = null;
                        continue;
                    }
                    if (ch === "'" || ch === '"') { inStr = ch; continue; }
                    if (ch === '(') depth++;
                    else if (ch === ')') { depth--; if (depth === 0) { end = j; break; } }
                }
                if (end === -1) return false;
                let k = end + 1;
                while (k < s.length && /\s/.test(s[k])) k++;
                if (s[k] === ',') { i = k + 1; while (i < s.length && /\s/.test(s[i])) i++; continue; }
                s = s.slice(k);
                break;
            }
        }
        return /^(select|explain|show|describe|desc|table|values|check|analyze)\b/i.test(s);
    }

    const LuminaDB = {
        name: 'LuminaDB',
        version: (typeof LUMINA_VERSION !== 'undefined') ? LUMINA_VERSION : '1.5.0',

        // postMessage API の許可オリジン。既定は自オリジンのみ。
        // 外部サイトからの接続を許可する場合は
        // LuminaDB.allowedOrigins.push('https://example.com') を実行する。
        allowedOrigins: [window.location.origin],

        // クエリ実行。params 指定時は '?' プレースホルダをバインドする
        // 戻り値はエンジンと同じ { data, executionTime, scannedRows } または { error }。
        // 警告が出た文では warnings: [{ Level, Code, Message }] が付く（SHOW WARNINGS と同じ内容）
        query(sql, params) {
            if (typeof sql !== 'string' || sql.trim() === '') return { error: 'Empty query' };
            let bound;
            try {
                bound = bindQueryParams(sql, params);
            } catch (e) {
                return { error: e.message };
            }
            // 排他制御: UI側のトランザクション進行中は外部からの書き込みを拒否する。
            // （書き込みを許すとUIのundoログへ合流し、COMMIT/ROLLBACKの対象が汚染されるため。
            //   読み取り系は許可するが、未コミットの変更が見える点に注意）
            // LuminaDB.transaction(fn) が自ら開始したトランザクション中は許可する
            const isReadOnly = isReadOnlySql(bound);
            if (db.inTransaction && !isReadOnly && !this._ownsTx) {
                return { error: 'Transaction in progress: external write queries are rejected until COMMIT / ROLLBACK.' };
            }
            const res = db.executeQuery(bound);
            // 更新系クエリは UI と永続化へ反映し、'change' イベントを発火する
            if (!res.error && !isReadOnly) {
                if (typeof renderTree === 'function') renderTree();
                if (typeof triggerAutoSave === 'function') triggerAutoSave();
                this._emit('change', { sql: bound, scannedRows: res.scannedRows });
            }
            return res;
        },

        // 複数文スクリプトの実行（';' 区切り）。エラー文があっても後続を実行し、
        // { results, total, succeeded, failed } を返す
        exec(script) {
            if (typeof script !== 'string' || script.trim() === '') return { error: 'Empty script' };
            // スクリプトには書き込み文が混在し得るため、UI側トランザクション中は全体を拒否する
            // （transaction(fn) が自ら開始したトランザクション中は許可する）
            if (db.inTransaction && !this._ownsTx) {
                return { error: 'Transaction in progress: external scripts are rejected until COMMIT / ROLLBACK.' };
            }
            const res = db.executeScript(script);
            if (res.succeeded > 0) {
                if (typeof renderTree === 'function') renderTree();
                if (typeof triggerAutoSave === 'function') triggerAutoSave();
                this._emit('change', { sql: script, succeeded: res.succeeded, failed: res.failed });
            }
            return res;
        },

        // 行オブジェクト（または配列）を挿入する。値は '?' バインド経由で安全に埋め込む。
        //   LuminaDB.insert('users', { id: 11, name: 'Ken', age: 20 })
        //   LuminaDB.insert('users', [{...}, {...}])
        insert(table, rows) {
            return this._writeRows('INSERT INTO', table, rows);
        },

        // PK / UNIQUE 衝突時は置換する挿入（REPLACE INTO 相当）
        //   LuminaDB.upsert('users', { id: 1, name: 'Alice2', age: 26 })
        upsert(table, rows) {
            return this._writeRows('REPLACE INTO', table, rows);
        },

        // 1 文へ詰め込む値の最大文字数。
        // エンジンの受け付ける文は 1,000,000 文字までなので、表名・列名の分と
        // 余白を見て 80% を目安にする。ここを超える行数は複数文へ分ける
        _MAX_VALUES_CHARS: 800000,

        _writeRows(verb, table, rows) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            const list = Array.isArray(rows) ? rows : [rows];
            if (list.length === 0 || list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
                return { error: `${verb === 'INSERT INTO' ? 'insert' : 'upsert'}() requires a row object or a non-empty array of row objects.` };
            }
            // 列は全行のキーの和集合。先頭行のキーだけを見ると、後続行にしか無い
            // 項目が無警告で捨てられていた（行ごとに項目が違う JSON の取り込みで実害）
            const cols = [];
            const seenCol = new Set();
            for (const r of list) {
                for (const k of Object.keys(r)) {
                    if (!seenCol.has(k)) { seenCol.add(k); cols.push(k); }
                }
            }
            if (cols.length === 0) return { error: 'Row object has no columns.' };
            if (!cols.every(_validIdent)) return { error: 'Invalid column name.' };

            // ------------------------------------------------------------------
            // 行数に応じて複数の文へ分ける。
            //
            // 以前は全行を 1 本の INSERT に畳んでいたため、プレースホルダの
            // 並び `(?, ?, ?), (?, ?, ?), ...` が 100 万文字の上限に達し、
            //   3 列で約 90,900 行 / 10 列で約 31,200 行 / 40 列で約 8,200 行
            // を超えると `Query too long` で丸ごと失敗していた。
            // CSV 取り込み（importCSV → insert）も同じ天井を持っていて、
            // 1MB 程度の CSV が「クエリが長すぎる」という、取り込みとは
            // 関係の無い文言で拒否されていた。
            // ------------------------------------------------------------------
            // 長さは **バインド後** で見ること。query() は '?' を実際の値の
            // リテラルへ置き換えてから文を組み立てるので、プレースホルダの数で
            // 区切ると、値の長い表で結局 100 万文字を超える
            const litLen = (v) => {
                if (v === null || v === undefined) return 4;             // NULL
                if (typeof v === 'number') return String(v).length;
                if (typeof v === 'boolean') return v ? 4 : 5;
                if (v instanceof Date) return 30;                        // DATE('....')
                const t = String(v);
                // ' と \ は 2 文字へ膨らむ。前後の引用符で +2
                let extra = 0;
                for (let i = 0; i < t.length; i++) {
                    const c = t.charCodeAt(i);
                    if (c === 39 || c === 92) extra++;
                }
                return t.length + extra + 2;
            };
            const group = `(${cols.map(() => '?').join(', ')})`;
            const head = `${verb} ${table} (${cols.join(', ')}) VALUES `;
            const sep = group.length - cols.length + 2;   // 括弧・カンマ・", " の固定分
            const runChunk = (slice) => {
                const params = [];
                for (const r of slice) {
                    for (const c of cols) params.push(r[c] === undefined ? null : r[c]);
                }
                return this.query(head + Array(slice.length).fill(group).join(', '), params);
            };

            // 各行のバインド後の長さを積み上げて、上限に届く手前で切る
            const budget = this._MAX_VALUES_CHARS;
            const chunks = [];
            let start = 0, acc = 0;
            for (let i = 0; i < list.length; i++) {
                let rowLen = sep;
                for (const c of cols) rowLen += litLen(list[i][c]);
                // 1 行だけで上限を超える場合はその 1 行で 1 文にする（分けようがない）
                if (acc > 0 && acc + rowLen > budget) { chunks.push([start, i]); start = i; acc = 0; }
                acc += rowLen;
            }
            chunks.push([start, list.length]);

            if (chunks.length === 1) return runChunk(list);

            // 複数文になるときは、途中で転んで半端に入るのを避けるため 1 つの
            // トランザクションで包む（1 文だったころの「全部入るか、何も入らないか」を保つ）。
            // 呼び出し側が既にトランザクション中なら、そちらに任せて何も足さない
            const ownTx = !db.inTransaction;
            if (ownTx) {
                const b = db.executeQuery('BEGIN');
                if (b.error) return b;
                this._ownsTx = true;
            }
            let written = 0, last = null;
            try {
                for (const [from, to] of chunks) {
                    last = runChunk(list.slice(from, to));
                    if (last.error) {
                        if (ownTx) { db.executeQuery('ROLLBACK'); this._ownsTx = false; }
                        return last;
                    }
                    written += to - from;
                }
            } catch (e) {
                if (ownTx) { db.executeQuery('ROLLBACK'); this._ownsTx = false; }
                return { error: e.message };
            }
            if (ownTx) {
                const c = db.executeQuery('COMMIT');
                this._ownsTx = false;
                if (c.error) return { error: c.error };
            }
            // 戻り値の形は 1 文のときと揃える（最後の結果に合計件数を載せる）
            return Object.assign({}, last, {
                data: [{ Result: 'Success', Message: db._rowsMsg(written, verb === 'INSERT INTO' ? 'inserted' : 'replaced') }],
                scannedRows: written,
                rows: written
            });
        },

        // SHOW STATUS をオブジェクト形式で返す（result.status.version 等でアクセス）
        status() {
            const r = db.executeQuery('SHOW STATUS');
            if (r.error) return r;
            const obj = {};
            r.data.forEach(row => { obj[row.Item] = row.Value; });
            r.status = obj;
            return r;
        },

        // ブラウザのストレージ使用量・クォータ・永続化状態と、DB自身の概算サイズを返す。
        // クォータ超過は保存失敗の原因になるため、書き込み前の確認に使える（非同期）。
        //   const s = await LuminaDB.storage();  // { usage, quota, usagePercent, persisted, estimatedBytes }
        async storage() {
            const info = (typeof getStorageInfo === 'function')
                ? await getStorageInfo()
                : { supported: false, usage: null, quota: null, usagePercent: null, persisted: null };
            const s = db.executeQuery('SHOW STORAGE');
            const own = {};
            if (!s.error) s.data.forEach(row => { own[row.Metric] = row.Value; });
            return {
                supported: info.supported,
                usage: info.usage,
                quota: info.quota,
                usagePercent: info.usagePercent,
                persisted: info.persisted,
                estimatedBytes: own.estimated_bytes !== undefined ? Number(own.estimated_bytes) : null,
                tables: own.tables !== undefined ? Number(own.tables) : null,
                rows: own.rows !== undefined ? Number(own.rows) : null
            };
        },

        // 永続化ストレージ（ディスク逼迫時に退避されない保存）をブラウザへ要求する。
        // 付与可否はブラウザの裁量（利用頻度やユーザー操作）で決まる。
        async persist() {
            if (typeof requestPersistence !== 'function') return { granted: false, error: 'Persistence API unavailable.' };
            const granted = await requestPersistence();
            return { granted };
        },

        // 同期コールバックをトランザクションで包む。fn が throw すると ROLLBACK、
        // 正常終了で COMMIT する。fn の戻り値は result.value に入る。
        //   LuminaDB.transaction(api => { api.insert('t', {...}); api.update('t', ...); })
        transaction(fn) {
            if (typeof fn !== 'function') return { error: 'transaction() requires a function.' };
            if (db.inTransaction) return { error: 'Transaction already active.' };
            const begin = db.executeQuery('BEGIN');
            if (begin.error) return begin;
            this._ownsTx = true;
            try {
                const value = fn(this);
                // async 関数を渡されると fn() は Promise を返すだけで、中の書き込みは
                // まだ走っていない。そのまま COMMIT すると「空のトランザクション」を
                // 確定し、以降の書き込みは保護されない（原子性が無い・例外も失われる）。
                // 同期実行しかできない設計なので、黙って壊れるより明示的に拒否する
                if (value && typeof value.then === 'function') {
                    db.executeQuery('ROLLBACK');
                    this._ownsTx = false;
                    return { error: 'transaction() requires a synchronous callback. An async function returns before its writes run, so the transaction cannot be atomic. Await your work first, then call transaction() with a synchronous function.' };
                }
                const c = db.executeQuery('COMMIT');
                if (c.error) return { error: c.error };
                if (typeof renderTree === 'function') renderTree();
                if (typeof triggerAutoSave === 'function') triggerAutoSave();
                // COMMIT 後に確定状態で通知する（_ownsTx を先に落とす。落とす前だと抑制される）
                this._ownsTx = false;
                this._emit('change', { sql: 'COMMIT', transaction: true });
                return { data: [{ Result: 'Success', Message: 'Transaction committed.' }], value };
            } catch (e) {
                db.executeQuery('ROLLBACK');
                if (typeof renderTree === 'function') renderTree();
                this._ownsTx = false;
                this._notifySubscribers();
                return { error: 'Transaction rolled back: ' + (e && e.message ? e.message : String(e)) };
            } finally {
                this._ownsTx = false;
            }
        },

        // 行の取得。opts: { columns: ['a','b'], where: {col: val}, orderBy: 'col DESC', limit: n }
        //   LuminaDB.select('users', { where: { age: 25 }, orderBy: 'id DESC', limit: 5 })
        select(table, opts) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            opts = opts || {};
            let colStr = '*';
            if (Array.isArray(opts.columns) && opts.columns.length > 0) {
                if (!opts.columns.every(_validIdent)) return { error: 'Invalid column name in columns.' };
                colStr = opts.columns.join(', ');
            }
            const params = [];
            let sql = `SELECT ${colStr} FROM ${table}`;
            try { sql += buildWhereClause(opts.where, params); } catch (e) { return { error: e.message }; }
            if (opts.orderBy != null) {
                const ob = String(opts.orderBy);
                if (!/^\s*[a-zA-Z_][a-zA-Z0-9_]*(\s+(asc|desc))?(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*(\s+(asc|desc))?)*\s*$/i.test(ob)) {
                    return { error: "Invalid orderBy. Use 'col [ASC|DESC][, ...]'." };
                }
                sql += ` ORDER BY ${ob}`;
            }
            if (opts.limit != null) {
                const n = Math.trunc(Number(opts.limit));
                if (!(n >= 0)) return { error: 'Invalid limit.' };
                sql += ` LIMIT ${n}`;
            }
            return this.query(sql, params);
        },

        // 件数の取得。結果に count フィールドを付与する
        count(table, where) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            const params = [];
            let sql = `SELECT COUNT(*) AS c FROM ${table}`;
            try { sql += buildWhereClause(where, params); } catch (e) { return { error: e.message }; }
            const r = this.query(sql, params);
            if (!r.error) r.count = r.data[0].c;
            return r;
        },

        // --- v1.5 追加: 結果を直接受け取るショートカット（エラー時は throw する点に注意） ---

        // 行オブジェクト配列を返す。エラーは throw
        //   const users = LuminaDB.rows('SELECT * FROM users WHERE age > ?', [25])
        rows(sql, params) {
            const r = this.query(sql, params);
            if (r.error) throw new Error(r.error);
            return r.data;
        },

        // 最初の1行を返す（結果が空なら null）。エラーは throw
        row(sql, params) {
            const data = this.rows(sql, params);
            return data.length > 0 ? data[0] : null;
        },

        // 最初の行の最初の列値を返す（結果が空なら null）。エラーは throw
        //   const n = LuminaDB.value('SELECT COUNT(*) FROM users')
        value(sql, params) {
            const first = this.row(sql, params);
            if (first === null) return null;
            const keys = Object.keys(first);
            return keys.length > 0 ? first[keys[0]] : null;
        },

        // 1行取得。where はオブジェクト、またはスカラー（PRIMARY KEY 値の短縮形）。
        //   LuminaDB.get('users', 1) / LuminaDB.get('users', { name: 'Alice' })
        get(table, where) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            if (where !== null && typeof where !== 'object') {
                const t = db.tables[String(table).toLowerCase()];
                if (!t) return { error: `Table '${table}' not found.` };
                if (!t.primaryKey) return { error: `Table '${table}' has no PRIMARY KEY. Pass a where object instead.` };
                where = { [t.primaryKey]: where };
            }
            const r = this.select(table, { where, limit: 1 });
            if (r.error) return r;
            r.rowData = r.data.length > 0 ? r.data[0] : null;
            return r;
        },

        // 単一列の値配列を返す。エラーは throw
        //   LuminaDB.pluck('users', 'name', { where: { age: { gte: 30 } } })
        pluck(table, column, opts) {
            if (!_validIdent(table)) throw new Error('Invalid table name.');
            if (!_validIdent(column)) throw new Error('Invalid column name.');
            const r = this.select(table, Object.assign({}, opts, { columns: [column] }));
            if (r.error) throw new Error(r.error);
            return r.data.map(row => row[column]);
        },

        // クエリ結果を CSV 文字列で返す（ヘッダー行付き / RFC 4180 引用）。エラーは throw
        //   const csv = LuminaDB.csv('SELECT * FROM users')
        csv(sql, params) {
            const data = this.rows(sql, params);
            if (data.length === 0) return '';
            const esc = (v) => {
                if (v === null || v === undefined) return '';
                const s = String(v);
                return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            const cols = Object.keys(data[0]);
            const lines = [cols.map(esc).join(',')];
            data.forEach(row => lines.push(cols.map(c => esc(row[c])).join(',')));
            return lines.join('\n');
        },

        // テーブル定義を DESCRIBE 相当のオブジェクト配列で返す。エラーは throw
        schema(table) {
            if (!_validIdent(table)) throw new Error('Invalid table name.');
            const r = db.executeQuery(`DESCRIBE ${table}`);
            if (r.error) throw new Error(r.error);
            return r.data;
        },

        // --- v1.7 追加 ---

        // クエリの実行計画（EXPLAIN）を配列で返す。エラーは throw
        explain(sql, params) {
            if (typeof sql !== 'string' || sql.trim() === '') throw new Error('explain() requires a non-empty SQL string.');
            let bound;
            try { bound = bindQueryParams(sql, params); } catch (e) { throw new Error(e.message); }
            const r = db.executeQuery('EXPLAIN ' + bound);
            if (r.error) throw new Error(r.error);
            return r.data;
        },

        // 各行をコールバックへ順に渡す（大きな結果の逐次処理向け）。処理した行数を返す。
        //   LuminaDB.each('SELECT * FROM users WHERE age > ?', [25], row => ...)
        //   LuminaDB.each('SELECT * FROM users', row => ...)   // params 省略可
        each(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = undefined; }
            if (typeof cb !== 'function') throw new Error('each() requires a callback function.');
            const data = this.rows(sql, params);
            for (let i = 0; i < data.length; i++) cb(data[i], i);
            return data.length;
        },

        // --- v1.6 追加: プリペアドステートメント（better-sqlite3 風） ---
        // 引数は可変長・配列・名前付きオブジェクトのいずれでも渡せる:
        //   const stmt = LuminaDB.prepare('SELECT * FROM users WHERE age > ?')
        //   stmt.all(25) / stmt.get([25]) / stmt.value(25) / stmt.run(...)
        prepare(sql) {
            if (typeof sql !== 'string' || sql.trim() === '') throw new Error('prepare() requires a non-empty SQL string.');
            const self = this;
            const norm = (args) => (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !(args[0] instanceof Date))
                ? args[0]
                : args;
            return {
                sql,
                all(...args) { return self.rows(sql, norm(args)); },
                get(...args) { return self.row(sql, norm(args)); },
                value(...args) { return self.value(sql, norm(args)); },
                run(...args) {
                    const r = self.query(sql, norm(args));
                    if (r.error) throw new Error(r.error);
                    return { changes: r.scannedRows || 0, data: r.data };
                }
            };
        },

        // --- v1.6 追加: 変更イベント ---
        // LuminaDB.query / exec / insert / update / remove 等の「API経由の書き込み成功時」に
        // 'change' イベントを発火する（UI操作や db.executeQuery 直接呼び出しは対象外）。
        //   LuminaDB.on('change', e => console.log(e.sql, e.scannedRows))
        _listeners: {},
        on(event, handler) {
            if (typeof handler !== 'function') throw new Error('on() requires a handler function.');
            (this._listeners[event] || (this._listeners[event] = [])).push(handler);
            return this;
        },
        off(event, handler) {
            const list = this._listeners[event];
            if (!list) return this;
            if (!handler) { delete this._listeners[event]; return this; }
            const i = list.indexOf(handler);
            if (i !== -1) list.splice(i, 1);
            return this;
        },
        _emit(event, payload) {
            // 書き込みイベントはライブクエリ（subscribe）の再評価契機でもある
            if (event === 'change') this._notifySubscribers();
            const list = this._listeners[event];
            if (!list) return;
            // リスナー内の例外・リスト変更に影響されないようコピーへ発火する
            list.slice().forEach(fn => { try { fn(payload); } catch (e) { /* リスナーの例外は無視 */ } });
        },

        // 行の更新。誤操作防止のため where は必須（全行更新は明示的に null を渡す）
        //   LuminaDB.update('users', { age: 26 }, { id: 1 })
        update(table, changes, where) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
                return { error: 'update() requires a non-empty changes object.' };
            }
            if (where === undefined) return { error: 'update() requires a where object (pass null to update all rows).' };
            const cols = Object.keys(changes);
            if (!cols.every(_validIdent)) return { error: 'Invalid column name in changes.' };
            const params = [];
            const setParts = cols.map(c => { params.push(changes[c] === undefined ? null : changes[c]); return `${c} = ?`; });
            let sql = `UPDATE ${table} SET ${setParts.join(', ')}`;
            try { sql += buildWhereClause(where, params); } catch (e) { return { error: e.message }; }
            return this.query(sql, params);
        },

        // 行の削除。誤操作防止のため where は必須（全行削除は明示的に null を渡す）
        //   LuminaDB.remove('users', { id: 1 })  /  LuminaDB.delete(...) も同じ
        remove(table, where) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            if (where === undefined) return { error: 'remove() requires a where object (pass null to delete all rows).' };
            const params = [];
            let sql = `DELETE FROM ${table}`;
            try { sql += buildWhereClause(where, params); } catch (e) { return { error: e.message }; }
            return this.query(sql, params);
        },
        'delete'(table, where) { return this.remove(table, where); },

        tables() {
            return db.executeQuery('SHOW TABLES');
        },

        exportSQL() {
            return db.exportSQL();
        },

        // ================= v1.14: ブラウザDBとしての運用機能 =================

        // --- 読み取り専用モード ---
        // 埋め込み先（iframe / 外部スクリプト）へ DB を公開するとき、書き込みを一括で塞ぐ。
        // エンジン側で判定するので UI 操作・postMessage・fetch も同時に読み取り専用になる。
        //   LuminaDB.readOnly(true)  → 以降 SELECT / SHOW / EXPLAIN 等だけ通す
        //   LuminaDB.readOnly(true, { lock: true }) にすると SQL の SET read_only = OFF では
        //   解除できなくなる（解除できるのはホストアプリからの readOnly(false) だけ）
        readOnly(flag, opts) {
            if (flag === undefined) return db.readOnly;
            db.readOnly = !!flag;
            db.readOnlyLocked = !!flag && !!(opts && opts.lock);
            this._emit('readonly', { readOnly: db.readOnly, locked: db.readOnlyLocked });
            return db.readOnly;
        },

        // --- 文単位のタイムアウト ---
        // ブラウザではクエリが UI スレッドを止めるため、暴走クエリを時間で切れることが重要。
        //   LuminaDB.timeout(500) → 以降の文は 500ms を超えるとエラーで中断（0 で解除）
        timeout(ms) {
            if (ms === undefined) return db.statementTimeoutMs;
            const n = Math.trunc(Number(ms));
            if (!(n >= 0)) throw new Error('timeout() requires a non-negative number of milliseconds.');
            db.statementTimeoutMs = n;
            return n;
        },

        // --- スナップショット（メモリ内タイムトラベル） ---
        // トランザクションと違い複数文・複数トランザクションをまたいで保持できる。
        //   const s = LuminaDB.snapshot('before-import');  … 取得
        //   LuminaDB.restore('before-import');             … 巻き戻し
        snapshot(name) {
            if (!_validIdent(name)) return { error: 'Invalid snapshot name.' };
            return this.query(`CREATE SNAPSHOT ${name}`);
        },
        restore(name) {
            if (!_validIdent(name)) return { error: 'Invalid snapshot name.' };
            const r = this.query(`RESTORE SNAPSHOT ${name}`);
            if (!r.error) {
                if (typeof renderTree === 'function') renderTree();
                this._notifySubscribers(null);
            }
            return r;
        },
        snapshots() {
            const r = db.executeQuery('SHOW SNAPSHOTS');
            return r.error ? [] : r.data;
        },
        dropSnapshot(name) {
            if (!_validIdent(name)) return { error: 'Invalid snapshot name.' };
            return this.query(`DROP SNAPSHOT ${name}`);
        },

        // --- ライブクエリ（購読） ---
        // SQL の結果を購読し、API 経由の書き込みで結果が変わったときだけ再通知する。
        // UI を DB に追従させる用途（ブラウザDBならではの使い方）。
        //   const sub = LuminaDB.subscribe('SELECT COUNT(*) AS c FROM users', rows => render(rows));
        //   sub.unsubscribe();
        // 注意: 通知は API 経由（query/exec/insert/update/remove/transaction）の書き込みが
        // 契機。db.executeQuery を直接呼んだ場合は refresh() で明示的に更新する。
        _subs: [],
        _subSeq: 0,
        subscribe(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = undefined; }
            if (typeof sql !== 'string' || sql.trim() === '') throw new Error('subscribe() requires a non-empty SQL string.');
            if (typeof cb !== 'function') throw new Error('subscribe() requires a callback function.');
            if (!isReadOnlySql(sql)) throw new Error('subscribe() only accepts read-only statements.');
            const self = this;
            const sub = {
                id: ++this._subSeq, sql, params, cb, lastSig: null,
                unsubscribe() { const i = self._subs.indexOf(sub); if (i !== -1) self._subs.splice(i, 1); return true; }
            };
            this._subs.push(sub);
            // 初回は現在値で即座に通知する（購読側が初期表示を別途書かなくてよい）
            this._runSub(sub, true);
            return sub;
        },
        unsubscribe(sub) {
            if (!sub) { this._subs = []; return true; }
            return typeof sub.unsubscribe === 'function' ? sub.unsubscribe() : false;
        },
        // 購読しているクエリを再評価する（外部で DB を直接変更した場合の手動トリガ）
        refresh() { this._notifySubscribers(null); return this._subs.length; },

        _runSub(sub, force) {
            const r = this.query(sub.sql, sub.params);
            if (r.error) { sub.lastSig = null; try { sub.cb(null, r.error); } catch (e) { /* 購読側の例外は無視 */ } return; }
            // 前回と同じ結果なら通知しない（無関係なテーブルへの書き込みで再描画しない）
            const sig = JSON.stringify(r.data);
            if (!force && sig === sub.lastSig) return;
            sub.lastSig = sig;
            try { sub.cb(r.data, null); } catch (e) { /* 購読側の例外は無視 */ }
        },
        _notifySubscribers() {
            // 購読コールバック内での書き込みによる再入を防ぐ（1段で打ち切る）。
            // transaction(fn) の実行中は未コミットの中間状態を配らず、COMMIT / ROLLBACK 後にまとめて通知する
            if (this._subs.length === 0 || this._notifying || this._ownsTx) return;
            this._notifying = true;
            try { this._subs.slice().forEach(s => this._runSub(s, false)); }
            finally { this._notifying = false; }
        },

        // --- JSON 入出力 ---
        // CSV / SQL ダンプに加えて、アプリの JS データ構造と直接やり取りする経路。
        importJSON(table, rows, opts) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            if (!Array.isArray(rows)) return { error: 'importJSON() requires an array of row objects.' };
            if (rows.length === 0) return { data: [], scannedRows: 0 };
            opts = opts || {};
            if (!db.tables[String(table).toLowerCase()]) {
                if (!opts.create) return { error: `Table '${table}' not found. Pass { create: true } to create it from the data.` };
                const cols = Object.keys(rows[0]);
                if (cols.length === 0 || !cols.every(_validIdent)) return { error: 'Cannot infer a valid schema from the first row.' };
                const typeOf = (v) => typeof v === 'number' ? 'FLOAT' : (typeof v === 'boolean' ? 'BOOLEAN' : 'TEXT');
                const c = db.executeQuery(`CREATE TABLE ${table} (${cols.map(k => `${k} ${typeOf(rows[0][k])}`).join(', ')})`);
                if (c.error) return c;
            }
            return this.insert(table, rows);
        },
        exportJSON(tables) {
            const names = Array.isArray(tables) ? tables : Object.keys(db.tables).filter(t => !t.startsWith('__tmp_'));
            const out = {};
            names.forEach(t => {
                if (!_validIdent(t)) throw new Error(`Invalid table name '${t}'.`);
                const r = db.executeQuery(`SELECT * FROM ${t}`);
                if (r.error) throw new Error(r.error);
                out[t] = r.data;
            });
            return out;
        },

        // --- 計測 ---
        profile() { const r = db.executeQuery('SHOW PROFILE'); return r.error ? null : (r.data[0] || null); },
        slowQueries() { const r = db.executeQuery('SHOW SLOW QUERIES'); return r.error ? [] : r.data; },

        // ================= v1.15: ブラウザDBの必須機能 =================

        // --- スキーマ版数とマイグレーション ---
        // ブラウザDBは「利用者の端末に古いスキーマが残り続ける」のが常態なので、
        // 起動時に版数を見て差分だけ適用する仕組みが要る。PRAGMA user_version を版数に使う。
        //   LuminaDB.migrate([
        //     { version: 1, up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)' },
        //     { version: 2, up: api => api.exec('ALTER TABLE notes ADD COLUMN tag TEXT') }
        //   ])
        schemaVersion(v) {
            if (v === undefined) {
                const r = db.executeQuery('PRAGMA user_version');
                return r.error ? 0 : r.data[0].user_version;
            }
            const n = Math.trunc(Number(v));
            if (!(n >= 0)) throw new Error('schemaVersion() requires a non-negative integer.');
            const r = db.executeQuery(`PRAGMA user_version = ${n}`);
            if (r.error) throw new Error(r.error);
            return n;
        },

        migrate(steps) {
            if (!Array.isArray(steps) || steps.length === 0) return { error: 'migrate() requires a non-empty array of steps.' };
            const sorted = steps.slice().sort((a, b) => a.version - b.version);
            for (const s of sorted) {
                if (!Number.isInteger(s.version) || s.version < 1) return { error: 'Each migration step needs an integer version >= 1.' };
                if (typeof s.up !== 'string' && typeof s.up !== 'function') return { error: `Migration ${s.version}: 'up' must be a SQL string or a function.` };
            }
            const dup = sorted.map(s => s.version).find((v, i, a) => a.indexOf(v) !== i);
            if (dup !== undefined) return { error: `Duplicate migration version ${dup}.` };
            const from = this.schemaVersion();
            const pending = sorted.filter(s => s.version > from);
            if (pending.length === 0) return { applied: [], from, to: from };
            // 途中で失敗しても元へ戻せるよう、開始前にスナップショットを取る
            const guard = '__migrate_guard';
            db.executeQuery(`DROP SNAPSHOT IF EXISTS ${guard}`);
            const snap = db.executeQuery(`CREATE SNAPSHOT ${guard}`);
            const applied = [];
            try {
                for (const s of pending) {
                    const r = typeof s.up === 'string' ? db.executeScript(s.up) : s.up(this);
                    if (r && r.error) throw new Error(r.error);
                    if (r && typeof r.failed === 'number' && r.failed > 0) {
                        const bad = (r.results || []).find(x => x.error);
                        throw new Error(bad ? bad.error : `${r.failed} statement(s) failed.`);
                    }
                    this.schemaVersion(s.version);
                    applied.push(s.version);
                }
            } catch (e) {
                if (!snap.error) { db.executeQuery(`RESTORE SNAPSHOT ${guard}`); db.executeQuery(`DROP SNAPSHOT ${guard}`); }
                if (typeof renderTree === 'function') renderTree();
                return { error: `Migration to version ${pending[applied.length] ? pending[applied.length].version : '?'} failed and was rolled back: ${e.message}`, from, to: this.schemaVersion(), applied };
            }
            if (!snap.error) db.executeQuery(`DROP SNAPSHOT ${guard}`);
            if (typeof renderTree === 'function') renderTree();
            if (typeof triggerAutoSave === 'function') triggerAutoSave();
            this._emit('change', { sql: 'MIGRATE', applied });
            return { applied, from, to: this.schemaVersion() };
        },

        // --- バックアップ（完全な状態をファイル 1 個で往復させる） ---
        backup() { return serializeBackup(db.exportForIDB()); },
        download(filename) { return downloadBackup(filename); },
        restoreBackup(text) {
            let dump;
            try { dump = parseBackup(text); } catch (e) { return { error: e.message }; }
            if (db.inTransaction) return { error: 'Cannot restore a backup while a transaction is active.' };
            db.importFromIDB(dump);
            if (typeof renderTree === 'function') renderTree();
            if (typeof triggerAutoSave === 'function') triggerAutoSave();
            this._emit('change', { sql: 'RESTORE BACKUP' });
            this._notifySubscribers();
            return { data: [{ Result: 'Success', Message: `Backup restored (${Object.keys(db.tables).length} tables).` }] };
        },

        // --- 大きな結果のページ処理（ピークメモリを抑える） ---
        // rows() は全件を一度に配列へ載せるので、数十万行だとメモリが跳ねる。
        // eachBatch は LIMIT/OFFSET で切って渡すため、常に batch 件ぶんしか保持しない。
        // 一貫した結果になるよう、SQL には安定した ORDER BY を付けること。
        //   LuminaDB.eachBatch('SELECT * FROM big ORDER BY id', [], 1000, rows => render(rows))
        eachBatch(sql, params, batch, cb) {
            if (typeof params === 'function') { cb = params; batch = 1000; params = undefined; }
            else if (typeof batch === 'function') { cb = batch; batch = 1000; }
            if (typeof sql !== 'string' || sql.trim() === '') throw new Error('eachBatch() requires a non-empty SQL string.');
            if (typeof cb !== 'function') throw new Error('eachBatch() requires a callback function.');
            const size = Math.max(1, Math.trunc(Number(batch) || 1000));
            if (!isReadOnlySql(sql)) throw new Error('eachBatch() only accepts read-only statements.');
            if (/\blimit\b|\boffset\b/i.test(sql)) throw new Error('eachBatch() adds its own LIMIT/OFFSET; remove them from the query.');
            let offset = 0, total = 0, batches = 0;
            for (;;) {
                const r = this.query(`${sql.trim().replace(/;\s*$/, '')} LIMIT ${size} OFFSET ${offset}`, params);
                if (r.error) throw new Error(r.error);
                const rows = r.data;
                if (rows.length === 0) break;
                total += rows.length;
                if (cb(rows, batches++) === false) break;   // false を返すと打ち切り
                if (rows.length < size) break;
                offset += size;
            }
            return { rows: total, batches };
        },

        // 反復子として取り出す形（for...of で回せる）
        *cursor(sql, params, batch) {
            const size = Math.max(1, Math.trunc(Number(batch) || 1000));
            if (!isReadOnlySql(sql)) throw new Error('cursor() only accepts read-only statements.');
            if (/\blimit\b|\boffset\b/i.test(sql)) throw new Error('cursor() adds its own LIMIT/OFFSET; remove them from the query.');
            let offset = 0;
            for (;;) {
                const r = this.query(`${String(sql).trim().replace(/;\s*$/, '')} LIMIT ${size} OFFSET ${offset}`, params);
                if (r.error) throw new Error(r.error);
                if (r.data.length === 0) return;
                for (const row of r.data) yield row;
                if (r.data.length < size) return;
                offset += size;
            }
        },

        // --- 永続化の状態 ---
        // 直近の自動保存で「何テーブル書いて、何テーブル省いたか」。差分保存が効いているかの確認用
        saveStats() { return (typeof getSaveStats === 'function') ? getSaveStats() : null; },
        // 他タブの保存へ自動追従するか（既定は警告のみ）
        autoReload(flag) {
            if (typeof setAutoReload !== 'function') return false;
            return flag === undefined ? setAutoReload(undefined) : setAutoReload(flag);
        },

        // --- CSV 取り込み（RFC 4180。File / fetch のテキストをそのまま渡せる） ---
        //   LuminaDB.importCSV(text, 'sales', { create: true })
        // opts: { create, header (既定 true), delimiter (既定 ','), replace, types }
        importCSV(text, table, opts) {
            if (typeof text !== 'string') return { error: 'importCSV() requires the CSV text as a string.' };
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            opts = opts || {};
            const delim = String(opts.delimiter || ',');
            if (delim.length !== 1) return { error: 'delimiter must be a single character.' };
            const rowsRaw = parseCsv(text, delim);
            if (rowsRaw.length === 0) return { error: 'CSV is empty.' };
            const header = opts.header !== false;
            let cols;
            if (header) {
                cols = rowsRaw[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
                rowsRaw.shift();
            } else {
                cols = rowsRaw[0].map((_, i) => 'column' + (i + 1));
            }
            if (cols.length === 0 || !cols.every(_validIdent)) return { error: 'Cannot derive valid column names from the CSV header.' };
            if (new Set(cols).size !== cols.length) return { error: 'Duplicate column names in the CSV header.' };
            // 値の型は列ごとに推定する（全行が数値なら数値、真偽なら真偽、空欄は NULL）
            const isNum = (v) => v !== '' && !isNaN(Number(v));
            const isBool = (v) => /^(true|false)$/i.test(v);
            const kinds = cols.map((_, i) => {
                let num = true, bool = true, seen = false;
                for (const r of rowsRaw) {
                    const v = r[i];
                    if (v === undefined || v === '') continue;
                    seen = true;
                    if (!isNum(v)) num = false;
                    if (!isBool(v)) bool = false;
                    if (!num && !bool) break;
                }
                return !seen ? 'TEXT' : (num ? 'FLOAT' : (bool ? 'BOOLEAN' : 'TEXT'));
            });
            const conv = (v, k) => {
                if (v === undefined || v === '') return null;
                if (k === 'FLOAT') return Number(v);
                if (k === 'BOOLEAN') return /^true$/i.test(v);
                return v;
            };
            const exists = !!db.tables[String(table).toLowerCase()];
            if (!exists) {
                if (!opts.create) return { error: `Table '${table}' not found. Pass { create: true } to create it from the CSV header.` };
                const c = db.executeQuery(`CREATE TABLE ${table} (${cols.map((n, i) => `${n} ${kinds[i]}`).join(', ')})`);
                if (c.error) return c;
            } else if (opts.replace) {
                const d = this.query(`DELETE FROM ${table}`);
                if (d.error) return d;
            }
            const objs = rowsRaw.map(r => {
                const o = {};
                cols.forEach((n, i) => { o[n] = conv(r[i], kinds[i]); });
                return o;
            });
            if (objs.length === 0) return { data: [], scannedRows: 0, rows: 0, columns: cols };
            const r = this.insert(table, objs);
            if (r.error) return r;
            r.rows = objs.length;
            r.columns = cols;
            return r;
        },

        // 表または任意のクエリを CSV 文字列で返す（csv() の表版）
        exportCSV(table) {
            if (!_validIdent(table)) throw new Error('Invalid table name.');
            return this.csv(`SELECT * FROM ${table}`);
        },

        // --- リーダー選出（Web Locks）---
        // 複数タブが開いていても「定期集計・同期などの重い仕事は 1 タブだけ」にしたい。
        // ロックを保持し続けるタブがリーダーで、閉じると次のタブが自動的に昇格する。
        _leader: false,
        isLeader() { return this._leader; },
        onLeader(cb) {
            if (typeof cb !== 'function') throw new Error('onLeader() requires a callback function.');
            if (!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request)) {
                // Web Locks が無い環境では単独タブとみなして即リーダーにする
                this._leader = true;
                try { cb(); } catch (e) { /* 呼び出し側の例外は無視 */ }
                return { release() { return false; } };
            }
            const self2 = this;
            let releaseFn = null;
            const held = new Promise(res => { releaseFn = res; });
            navigator.locks.request('luminadb-leader', () => {
                self2._leader = true;
                try { cb(); } catch (e) { /* 同上 */ }
                return held;   // 解放されるまでロックを保持し続ける
            }).then(() => { self2._leader = false; });
            return { release() { if (releaseFn) { releaseFn(); releaseFn = null; return true; } return false; } };
        },

        // --- 式コンパイルキャッシュの状態（性能診断用） ---
        cacheStats() {
            const st = DatabaseEngine._exprCacheStats;
            const total = st.hit + st.miss;
            return { hits: st.hit, misses: st.miss, size: DatabaseEngine._exprCache.size,
                     max: DatabaseEngine._exprCacheMax,
                     hitRate: total ? Number((st.hit / total).toFixed(4)) : 0 };
        },
        clearCache() {
            DatabaseEngine._exprCache.clear();
            DatabaseEngine._exprCacheStats.hit = 0;
            DatabaseEngine._exprCacheStats.miss = 0;
            return true;
        },

        // --- ワーカー実行（UI スレッドを止めない） ---
        // 重いクエリは別スレッドの複製 DB で実行する。使い方:
        //   await LuminaDB.worker.start();
        //   await LuminaDB.worker.sync();                    // 現在の DB を転送
        //   const r = await LuminaDB.worker.query('SELECT ...');
        //   await LuminaDB.worker.pull();                    // 書き込んだ場合は書き戻す
        worker: {
            _w: null, _seq: 0, _pending: null, url: 'js/worker/lumina-worker.js',
            supported() { return typeof Worker !== 'undefined'; },
            running() { return !!this._w; },
            start(url) {
                if (this._w) return Promise.resolve({ started: false, reason: 'already running' });
                if (!this.supported()) return Promise.reject(new Error('Web Workers are not available in this environment.'));
                const self2 = this;
                return new Promise((resolve, reject) => {
                    let w;
                    try { w = new Worker(url || this.url); }
                    catch (e) { reject(new Error(`Failed to start the worker (${e.message}). file:// では Worker を起動できません。ローカルサーバー経由で開いてください。`)); return; }
                    self2._pending = new Map();
                    w.onmessage = (e) => {
                        const m = e.data || {};
                        const p = self2._pending.get(m.id);
                        if (!p) return;
                        self2._pending.delete(m.id);
                        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
                    };
                    w.onerror = (e) => {
                        const err = new Error(`Worker error: ${e.message || 'failed to load'}`);
                        self2._pending.forEach(p => p.reject(err));
                        self2._pending.clear();
                        if (self2._w === w) { try { w.terminate(); } catch (e2) {} self2._w = null; }
                        reject(err);
                    };
                    self2._w = w;
                    // 起動確認まで待ってから解決する（読み込み失敗をここで検出する）
                    self2._call('ping', {}).then(r => resolve({ started: true, version: r.version })).catch(reject);
                });
            },
            stop() {
                if (!this._w) return false;
                try { this._w.terminate(); } catch (e) { /* 既に停止 */ }
                if (this._pending) { this._pending.forEach(p => p.reject(new Error('Worker stopped.'))); this._pending.clear(); }
                this._w = null;
                return true;
            },
            _call(op, msg) {
                if (!this._w) return Promise.reject(new Error('Worker is not running. Call LuminaDB.worker.start() first.'));
                const id = ++this._seq;
                const self2 = this;
                return new Promise((resolve, reject) => {
                    self2._pending.set(id, { resolve, reject });
                    self2._w.postMessage(Object.assign({ id, op }, msg));
                });
            },
            // メインスレッドの現在の状態をワーカーへ複製する
            sync() { return this._call('sync', { dump: db.exportForIDB() }); },
            // ワーカー側の状態をメインスレッドへ書き戻す
            pull() {
                const self2 = this;
                return this._call('dump', {}).then(dump => {
                    if (db.inTransaction) throw new Error('Cannot pull into the main thread while a transaction is active.');
                    db.importFromIDB(dump);
                    if (typeof renderTree === 'function') renderTree();
                    if (typeof triggerAutoSave === 'function') triggerAutoSave();
                    LuminaDB._emit('change', { sql: 'WORKER PULL' });
                    return { tables: Object.keys(db.tables).length };
                });
            },
            query(sql, params) {
                let bound;
                try { bound = bindQueryParams(sql, params); } catch (e) { return Promise.reject(new Error(e.message)); }
                return this._call('query', { sql: bound });
            },
            exec(script) { return this._call('exec', { sql: String(script) }); },
            rows(sql, params) {
                return this.query(sql, params).then(r => { if (r.error) throw new Error(r.error); return r.data; });
            },
            timeout(ms) { return this._call('timeout', { ms }); },
            readOnly(v) { return this._call('readOnly', { value: !!v }); },
            reset() { return this._call('reset', {}); },
            tables() { return this._call('tables', {}); }
        }
    };
    window.LuminaDB = LuminaDB;

    // --- fetch インターセプト ---
    // 対応URL: lumina://<endpoint> または /api/lumina/<endpoint>
    //   query  : GET ?sql=... / POST {sql, params}
    //   tables : テーブル一覧
    //   export : SQLダンプ
    async function handleLuminaApiRequest(endpoint, queryString, init) {
        const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
        try {
            if (endpoint === 'query') {
                let sql = null, params = null;
                if (init && init.body) {
                    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
                    sql = body.sql;
                    params = body.params;
                } else {
                    const qp = new URLSearchParams(queryString.replace(/^\?/, ''));
                    sql = qp.get('sql');
                }
                if (!sql) return jsonResponse({ error: "Missing 'sql'. Use GET ?sql=... or POST {sql, params}." }, 400);
                const res = LuminaDB.query(sql, params);
                return jsonResponse(res, res.error ? 400 : 200);
            }
            if (endpoint === 'tables') return jsonResponse(LuminaDB.tables());
            if (endpoint === 'export') return jsonResponse({ sql: LuminaDB.exportSQL() });
            return jsonResponse({ error: `Unknown endpoint '${endpoint}'. Use query / tables / export.` }, 404);
        } catch (e) {
            return jsonResponse({ error: e.message }, 500);
        }
    }

    (function interceptFetch() {
        const origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : ((input && input.url) || '');
                const m = url.match(/^lumina:\/\/([a-zA-Z]+)(\?[\s\S]*)?$/) || url.match(/^\/api\/lumina\/([a-zA-Z]+)(\?[\s\S]*)?$/);
                if (m) return handleLuminaApiRequest(m[1].toLowerCase(), m[2] || '', init);
            } catch (e) {
                // 解析に失敗した場合は通常の fetch へフォールバック
            }
            return origFetch(input, init);
        };
    })();

    // --- postMessage API ---
    // 受信: { type: 'luminadb:query', id, sql, params }
    // 送信: { type: 'luminadb:result', id, result }
    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.type !== 'luminadb:query' || typeof msg.sql !== 'string') return;
        // オリジン検証: 許可されていないサイト（iframe埋め込み元・別ウィンドウ等）
        // からのクエリは無視する。file:// 環境では双方 'null' となり自己送信は通る。
        if (!LuminaDB.allowedOrigins.includes(e.origin)) return;
        // 'null' オリジン（file:// やサンドボックス化された iframe）は自ウィンドウからの
        // 送信のみ許可する。file:// 同士の他ページやサンドボックス iframe からの
        // なりすましクエリを遮断するため
        if (e.origin === 'null' && e.source !== window) return;
        const result = LuminaDB.query(msg.sql, msg.params);
        const reply = { type: 'luminadb:result', id: msg.id !== undefined ? msg.id : null, result };
        const target = e.source || window;
        target.postMessage(reply, (e.origin && e.origin !== 'null') ? e.origin : '*');
    });
