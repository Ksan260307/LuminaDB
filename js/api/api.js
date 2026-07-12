    // ============================================================================
    // [External API] - 外部からのクエリ受付
    //   1. window.LuminaDB      : JS API（パラメータバインド付き）
    //   2. fetch インターセプト : lumina://query 等の仮想エンドポイント
    //   3. postMessage          : iframe / 別ウィンドウからのクエリ受付
    // ============================================================================

    // '?' プレースホルダを安全なリテラルへ置換する（文字列リテラル内は無視）
    function bindQueryParams(sql, params) {
        if (!params || params.length === 0) return sql;
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
                out += ch;
                if (ch === inStr && sql[p - 1] !== '\\') inStr = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inStr = ch; out += ch; continue; }
            if (ch === '?') {
                if (idx >= params.length) throw new Error(`Parameter binding failed: placeholder #${idx + 1} has no value.`);
                out += toLiteral(params[idx++]);
                continue;
            }
            out += ch;
        }
        if (idx < params.length) throw new Error(`Parameter binding failed: ${params.length} values given but only ${idx} placeholders found.`);
        return out;
    }

    const LuminaDB = {
        name: 'LuminaDB',
        version: '1.0.0',

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
            const isReadOnly = /^\s*(select|explain|show|describe|desc)\b/i.test(bound);
            if (db.inTransaction && !isReadOnly) {
                return { error: 'Transaction in progress: external write queries are rejected until COMMIT / ROLLBACK.' };
            }
            const res = db.executeQuery(bound);
            // 更新系クエリは UI と永続化へ反映
            if (!res.error && !/^\s*(select|explain|show|describe|desc)\b/i.test(bound)) {
                if (typeof renderTree === 'function') renderTree();
                if (typeof triggerAutoSave === 'function') triggerAutoSave();
            }
            return res;
        },

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
