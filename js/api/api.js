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
        // 戻り値はエンジンと同じ { data, executionTime, scannedRows } または { error }
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

        _writeRows(verb, table, rows) {
            if (!_validIdent(table)) return { error: 'Invalid table name.' };
            const list = Array.isArray(rows) ? rows : [rows];
            if (list.length === 0 || list.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
                return { error: `${verb === 'INSERT INTO' ? 'insert' : 'upsert'}() requires a row object or a non-empty array of row objects.` };
            }
            const cols = Object.keys(list[0]);
            if (cols.length === 0) return { error: 'Row object has no columns.' };
            if (!cols.every(_validIdent)) return { error: 'Invalid column name.' };
            const params = [];
            const groups = list.map(r => {
                cols.forEach(c => params.push(r[c] === undefined ? null : r[c]));
                return `(${cols.map(() => '?').join(', ')})`;
            });
            const sql = `${verb} ${table} (${cols.join(', ')}) VALUES ${groups.join(', ')}`;
            return this.query(sql, params);
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
                const c = db.executeQuery('COMMIT');
                if (c.error) return { error: c.error };
                if (typeof renderTree === 'function') renderTree();
                if (typeof triggerAutoSave === 'function') triggerAutoSave();
                return { data: [{ Result: 'Success', Message: 'Transaction committed.' }], value };
            } catch (e) {
                db.executeQuery('ROLLBACK');
                if (typeof renderTree === 'function') renderTree();
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
