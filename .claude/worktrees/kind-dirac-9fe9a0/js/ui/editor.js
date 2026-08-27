    // ============================================================================
    // [Editor] - シンタックスハイライト / オートコンプリート / Undo・Redo
    // ============================================================================
    const keywords = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'RENAME', 'TO', 'FOREIGN', 'KEY', 'REFERENCES', 'TRUNCATE', 'OPTIMIZE', 'VACUUM', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'BEGIN', 'COMMIT', 'ROLLBACK', 'JOIN', 'ON', 'INNER', 'LEFT', 'ORDER', 'BY', 'DESC', 'ASC', 'HAVING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'AND', 'OR', 'IN', 'GROUP', 'LIMIT', 'OFFSET', 'LIKE', 'NOT', 'IS', 'NULL', 'BETWEEN', 'DISTINCT', 'UPPER', 'LOWER', 'LENGTH', 'ROUND', 'COALESCE', 'SUBSTRING', 'CONCAT', 'REPLACE', 'TRIM', 'ABS', 'CEIL', 'FLOOR', 'NOW', 'LPAD', 'RPAD', 'POWER', 'SQRT', 'YEAR', 'MONTH', 'DAY', 'MOD', 'SIGN', 'RAND', 'INDEX', 'EXPLAIN', 'TRUE', 'FALSE', 'BOOLEAN', 'DATE', 'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'VIEW', 'UNION', 'ALL', 'EXISTS', 'PROCEDURE', 'CALL', 'UNIQUE', 'PRIMARY', 'RIGHT', 'SHOW', 'TABLES', 'VIEWS', 'PROCEDURES', 'DESCRIBE', 'CROSS', 'INTERSECT', 'EXCEPT', 'CAST', 'INTEGER', 'FLOAT', 'TEXT', 'SAVEPOINT', 'RELEASE', 'MODIFY', 'GROUP_CONCAT', 'SEPARATOR', 'DENSE_RANK', 'LAG', 'LEAD', 'AUTO_INCREMENT', 'DEFAULT', 'WITH', 'IF', 'IFNULL', 'NULLIF', 'INSTR', 'REVERSE', 'REPEAT', 'GREATEST', 'LEAST', 'EXP', 'LOG', 'LOG10', 'PI', 'HOUR', 'MINUTE', 'SECOND', 'DATEDIFF', 'NTILE', 'FIRST_VALUE', 'LAST_VALUE', 'INDEXES',
    // v1.1〜1.3 で追加された構文・関数
    'RETURNING', 'TEMPORARY', 'RECURSIVE', 'TRIGGER', 'TRIGGERS', 'BEFORE', 'AFTER', 'FOR', 'EACH', 'ROW',
    'USING', 'NATURAL', 'ROWS', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'NULLS', 'FIRST', 'LAST',
    'FETCH', 'NEXT', 'ONLY', 'CHECK', 'CONSTRAINT', 'CASCADE', 'CHANGE', 'VARIABLES', 'STATUS', 'CHECKS',
    'INTERVAL', 'EXTRACT', 'TIMESTAMPDIFF', 'CURRENT_TIMESTAMP', 'CONVERT', 'CHAR_LENGTH', 'TIME',
    'DATE_FORMAT', 'STR_TO_DATE', 'DATE_ADD', 'DATE_SUB', 'MONTHNAME', 'DAYNAME', 'WEEK', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
    'JSON_EXTRACT', 'JSON_VALUE', 'JSON_ARRAY', 'JSON_OBJECT', 'JSON_SET', 'JSON_REMOVE', 'JSON_KEYS', 'JSON_LENGTH', 'JSON_VALID', 'JSON_CONTAINS', 'JSON_TYPE',
    'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'REGEXP_REPLACE', 'REGEXP_SUBSTR', 'REGEXP_LIKE', 'SPLIT_PART', 'QUOTE',
    'STDDEV', 'VARIANCE', 'MEDIAN', 'STDDEV_SAMP', 'VAR_SAMP', 'BIT_AND', 'BIT_OR', 'BIT_XOR', 'ANY_VALUE',
    'PERCENT_RANK', 'CUME_DIST', 'NTH_VALUE', 'FORMAT', 'UUID', 'VERSION', 'DATABASE', 'LAST_INSERT_ID',
    'REGEXP', 'IGNORE', 'DUPLICATE', 'POSITION', 'LEADING', 'TRAILING', 'BOTH',
    // v1.5 で追加された構文・関数
    'MD5', 'CRC32', 'TO_BASE64', 'FROM_BASE64', 'INET_ATON', 'INET_NTOA', 'SOUNDEX', 'TRANSLATE',
    'COSH', 'TANH', 'TO_DAYS', 'FROM_DAYS', 'TIMESTAMPADD', 'MAKETIME', 'CURTIME', 'CURRENT_TIME', 'UTC_DATE',
    'DAYOFMONTH', 'TRUNC', 'RANDOM', 'NVL', 'FORMAT_BYTES',
    'JSON_PRETTY', 'JSON_QUOTE', 'JSON_UNQUOTE', 'JSON_ARRAY_APPEND', 'JSON_MERGE_PATCH', 'JSON_DEPTH',
    'MIN_BY', 'MAX_BY', 'COUNT_IF', 'PERCENTILE_CONT', 'PERCENTILE_DISC',
    'ROLLUP', 'FUNCTIONS', 'ANALYZE', 'DUAL',
    // v1.6 で追加された構文・関数
    'QUALIFY', 'ESCAPE', 'GROUPING', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'PREPARED',
    'SEQUENCE', 'SEQUENCES', 'NEXTVAL', 'CURRVAL', 'SETVAL', 'START', 'INCREMENT',
    'SHA1', 'SHA2', 'SHA256', 'SHA224', 'SUBSTR', 'OCTET_LENGTH', 'BIT_LENGTH', 'UNHEX', 'DATE_TRUNC', 'TYPEOF', 'IIF', 'REGEXP_COUNT',
    'STRING_AGG', 'ARRAY_AGG', 'BOOL_AND', 'BOOL_OR', 'CORR', 'COVAR_POP', 'COVAR_SAMP',
    // v1.8 で追加された商用DB頻用の関数（Oracle / SQL Server / PostgreSQL）
    'DECODE', 'NVL2', 'ISNULL', 'ZEROIFNULL', 'NULLIFZERO', 'CHOOSE', 'STARTS_WITH', 'ENDS_WITH',
    'CHARINDEX', 'LEN', 'STUFF', 'REGEXP_INSTR', 'SQUARE', 'POW', 'GCD', 'LCM', 'FACTORIAL',
    'WIDTH_BUCKET', 'ADD_MONTHS', 'MONTHS_BETWEEN', 'DATE_PART', 'GETDATE', 'SYSTIMESTAMP',
    // v1.9 で追加された商用DB頻用の関数
    'QUOTENAME', 'PATINDEX', 'BITAND', 'BITOR', 'BITXOR', 'BITNOT', 'ISNUMERIC', 'EOMONTH',
    'MAKE_DATE', 'MAKE_TIMESTAMP', 'TO_NUMBER', 'TO_DATE', 'TO_TIMESTAMP', 'CHR', 'STRPOS',
    'REPLICATE', 'LISTAGG',
    // v1.11 で追加された商用DB頻用の関数・コマンド
    'TO_CHAR', 'TO_HEX', 'TRY_CAST', 'TRY_CONVERT', 'DATEADD', 'DATEPART', 'DATENAME', 'NEXT_DAY',
    'NANVL', 'REMAINDER', 'SHIFTLEFT', 'SHIFTRIGHT', 'PARSENAME', 'QUOTE_IDENT', 'QUOTE_LITERAL',
    'OVERLAY', 'PLACING', 'NEWID', 'SYS_GUID', 'CURRENT_SCHEMA', 'CURRENT_USER', 'SESSION_USER',
    'SYSTEM_USER', 'SYSDATETIME', 'MERGE', 'MATCHED', 'USING', 'TOP', 'PERCENT', 'CONFLICT', 'EXCLUDED',
    // v1.14 で追加された構文・関数
    'ILIKE', 'SIMILAR', 'UNKNOWN', 'MINUS', 'EXCLUDE', 'TIES', 'SNAPSHOT', 'SNAPSHOTS', 'RESTORE',
    'FUNCTION', 'FUNCTIONS', 'RETURNS', 'RETURN', 'INFORMATION_SCHEMA', 'STRING_SPLIT', 'UNNEST',
    'SETSEED', 'PROFILE', 'SLOW', 'QUERIES', 'STATEMENT_TIMEOUT', 'READ_ONLY', 'SESSION', 'GLOBAL', 'ROW',
    // v1.15 で追加された構文
    'COLLATE', 'NOCASE', 'NOACCENT', 'MATCH', 'AGAINST', 'BOOLEAN', 'MODE', 'NATURAL', 'LANGUAGE',
    'IGNORE', 'RESPECT', 'NULLS', 'JSON_TABLE', 'TABLESAMPLE', 'BERNOULLI', 'SYSTEM', 'REPEATABLE',
    'DECLARE', 'ELSEIF', 'ENDIF', 'WHILE', 'DO', 'LOOP', 'REPEAT', 'UNTIL', 'LEAVE', 'ITERATE',
    'PRAGMA', 'USER_VERSION', 'TABLE_INFO', 'FORMAT', 'CASCADE', 'RESTRICT', 'PATH', 'COLUMNS',
    // v1.16 で追加された構文
    'CURSOR', 'OPEN', 'CLOSE', 'FETCH', 'HANDLER', 'CONTINUE', 'EXIT', 'SQLEXCEPTION', 'SQLWARNING',
    'SQLSTATE', 'SIGNAL', 'RESIGNAL', 'MESSAGE_TEXT', 'FOUND', 'OVERLAPS', 'SYMMETRIC',
    'JSON_EXISTS', 'JSON_QUERY', 'DATE_BIN', 'TIME_BUCKET', 'AGE', 'EPOCH', 'SCHEMA',
    'MATERIALIZED', 'PLAN', 'QUERY', 'SHARE', 'NOWAIT', 'LOCKED', 'SKIP',
    // v1.17 で追加された構文・関数
    'ARRAY', 'ARRAY_LENGTH', 'ARRAY_POSITION', 'ARRAY_CONTAINS', 'ARRAY_APPEND', 'ARRAY_PREPEND',
    'ARRAY_REMOVE', 'ARRAY_TO_STRING', 'STRING_TO_ARRAY', 'ARRAY_SORT', 'ORDINALITY', 'EXCLUDE',
    'OTHERS', 'TIES', 'REGR_SLOPE', 'REGR_INTERCEPT', 'REGR_R2', 'REGR_COUNT', 'REGR_AVGX', 'REGR_AVGY',
    'REGR_SXX', 'REGR_SYY', 'REGR_SXY', 'MODE', 'LEVENSHTEIN', 'SIMILARITY', 'EDIT_DISTANCE',
    'REGEXP_MATCHES', 'REGEXP_SPLIT_TO_ARRAY', 'SAFE_DIVIDE', 'DIV', 'ZONE', 'REINDEX', 'CHECKPOINT',
    // v1.18 で追加された構文・関数
    'INSTEAD', 'OPTION', 'CASCADED', 'LOCAL', 'DEFERRABLE', 'DEFERRED', 'IMMEDIATE', 'INITIALLY',
    'CONSTRAINT', 'DECIMAL', 'NUMERIC', 'VARCHAR', 'BIGINT', 'SMALLINT', 'PRECISION', 'STATISTICS',
    'JSON_INSERT', 'JSON_REPLACE', 'JSON_ARRAY_INSERT', 'JSON_CONTAINS_PATH', 'KEYS',
    // v1.19 で追加された構文
    'MINVALUE', 'MAXVALUE', 'CACHE', 'CYCLE', 'RESTART', 'SOURCE', 'TARGET', 'STATUS',
    // v1.20 で追加された構文
    'DOMAIN', 'DOMAINS', 'TYPE', 'TYPES', 'ENUM', 'USER', 'USERS', 'ROLE', 'ROLES', 'GRANTS',
    'SEARCH', 'DEPTH', 'BREADTH', 'FIRST', 'CONTINUE', 'IDENTITY', 'DIV', 'VALUE',
    // v1.21 で追加された構文
    'GROUPING_ID', 'OVERRIDING', 'LATERAL', 'WARNINGS', 'BINARY', 'NUMERIC', 'DATA',
    // v1.22 で追加された構文
    'CONNECT', 'PRIOR', 'LEVEL', 'SIBLINGS', 'NOCYCLE', 'ROWNUM', 'SYS_CONNECT_BY_PATH',
    'CONNECT_BY_ROOT', 'CONNECT_BY_ISLEAF', 'RATIO_TO_REPORT', 'KEEP', 'INCLUDE',
    'CONCURRENTLY', 'CONSTRAINTS', 'DEFERRED', 'IMMEDIATE', 'SCHEMAS', 'ISOLATION',
    'CURRENT_CATALOG', 'CURRENT_DATABASE',
    // v1.33 で追加された構文・関数
    'BTRIM', 'ENCODE', 'ORD', 'UNISTR', 'CONTAINS', 'TIMEDIFF', 'YEARWEEK',
    'PERIOD_ADD', 'PERIOD_DIFF', 'JULIAN_DAY', 'JULIANDAY', 'CONVERT_TZ',
    'LOCALTIME', 'LOCALTIMESTAMP', 'JSON_SEARCH', 'JSON_MERGE_PRESERVE',
    'ARRAY_DISTINCT', 'ARRAY_CAT', 'ARRAY_REVERSE',
    'EVERY', 'PRODUCT', 'APPROX_COUNT_DISTINCT',
    'DATABASE', 'DATABASES', 'UNLOGGED', 'VERBOSE', 'CHECKSUM', 'REPAIR', 'RESET'];

    // --- SQL 整形（純粋関数。文字列リテラル/コメントを保護して主要句を改行する） ---
    // 完全なパーサではなく単文の可読性向上を狙う軽量フォーマッタ。括弧内（サブクエリ）は
    // トップレベル改行の対象外とし、SELECT/SET のカラムはカンマ後で改行してインデントする。
    function formatSql(sql) {
        if (typeof sql !== 'string' || sql.trim() === '') return '';
        // 文字列リテラルとコメントを退避（\x00N\x00 プレースホルダ）
        const lits = [];
        let s = sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, m => {
            lits.push(m); return `\x00${lits.length - 1}\x00`;
        });
        s = s.replace(/\s+/g, ' ').trim();
        const NL_BEFORE = ['FROM', 'WHERE', 'GROUP BY', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET',
            'UNION ALL', 'UNION', 'INTERSECT ALL', 'INTERSECT', 'EXCEPT ALL', 'EXCEPT',
            'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'JOIN', 'ON',
            'VALUES', 'SET'];
        let out = '';
        let depth = 0;
        const upper = s.toUpperCase();
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth = Math.max(0, depth - 1);
            if (depth === 0 && (i === 0 || s[i - 1] === ' ')) {
                let matched = null;
                for (const kw of NL_BEFORE) {
                    if (upper.startsWith(kw, i) && (i + kw.length >= s.length || s[i + kw.length] === ' ')) { matched = kw; break; }
                }
                if (matched && i > 0) out += '\n';
            }
            out += ch;
        }
        let lines = out.split('\n').map(line => {
            let l = line.trim();
            if (/^(SELECT|SET)\b/i.test(l)) {
                let d = 0, res = '';
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c === '(') d++;
                    else if (c === ')') d = Math.max(0, d - 1);
                    res += c;
                    if (c === ',' && d === 0) res += '\n  ';
                }
                l = res;
            }
            return l;
        });
        let result = lines.join('\n').replace(/\x00(\d+)\x00/g, (m, i) => lits[Number(i)]);
        return result;
    }

    function updateHighlight() {
      let text = els.query.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      text = text.replace(/('[^']*')|("[^"]*")/g, '<span class="hl-string">$1$2</span>');
      text = text.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="hl-number">$1</span>');
      text = text.replace(new RegExp(`\\b(${keywords.join('|')})\\b`, 'gi'), '<span class="hl-keyword">$&</span>');
      if(text[text.length-1] === '\n') text += ' ';
      els.hl.innerHTML = text;
    }

    // --- Autocomplete Logic ---
    let suggestIndex = -1;
    let currentSuggestions = [];

    function getDynamicKeywords() {
        let all = [...keywords];
        Object.keys(db.tables).forEach(t => {
            if(!t.startsWith('__')) {
                all.push(t);
                db.tables[t].getColumnNames().forEach(c => all.push(c));
            }
        });
        return [...new Set(all)];
    }

    // カーソル直前の語。`u.` のように修飾子が付いている場合は qualifier も返す。
    // 以前は /[a-zA-Z0-9_]+$/ だけを見ていたため、'.' の直後は match が null になり
    // `u.` と打っても候補が一切出なかった（列名補完が効かない最大の原因）
    function getCurrentWord() {
        const val = els.query.value;
        const cursor = els.query.selectionStart;
        const textBefore = val.slice(0, cursor);
        const qm = textBefore.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z0-9_]*)$/);
        if (qm) {
            return { qualifier: qm[1], word: qm[2], start: cursor - qm[2].length, end: cursor };
        }
        const match = textBefore.match(/[a-zA-Z0-9_]+$/);
        return match ? { qualifier: null, word: match[0], start: match.index, end: cursor } : null;
    }

    // いま編集している文に出てくる表と別名を集める（alias -> 実表名）。
    // FROM / JOIN / UPDATE / INTO の直後の名前を拾う
    function statementTableMap() {
        const map = Object.create(null);
        let stmt = els.query.value;
        try {
            if (typeof statementAtCursor === 'function') {
                stmt = statementAtCursor(els.query.value, els.query.selectionStart) || els.query.value;
            }
        } catch (e) { /* 解析できなければ全文で代用する */ }
        const re = /\b(?:from|join|update|into)\s+([a-zA-Z_]\w*)(?:\s+(?:as\s+)?([a-zA-Z_]\w*))?/gi;
        const NOT_ALIAS = new Set(['where', 'on', 'using', 'set', 'group', 'order', 'having', 'limit',
            'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'values', 'select', 'as', 'qualify', 'window']);
        let m;
        while ((m = re.exec(stmt))) {
            const tbl = m[1].toLowerCase();
            if (!db.tables[tbl]) continue;
            map[tbl] = tbl;
            if (m[2] && !NOT_ALIAS.has(m[2].toLowerCase())) map[m[2].toLowerCase()] = tbl;
        }
        return map;
    }

    function hideSuggestions() {
        els.suggestBox.classList.add('hidden');
    }

    function renderSuggestBox() {
        els.suggestBox.innerHTML = currentSuggestions.map((s, i) => `
            <div class="px-3 py-1.5 cursor-pointer ${i === suggestIndex ? 'bg-blue-100 text-blue-800 font-semibold' : 'hover:bg-gray-50 text-gray-600'}" data-index="${i}">${s}</div>
        `).join('');
    }

    function showSuggestions() {
        const wordInfo = getCurrentWord();
        // 修飾子付き（`u.`）は語が空でも候補を出す。素の語は 1 文字以上必要
        if (!wordInfo || (!wordInfo.qualifier && wordInfo.word.length < 1)) {
            hideSuggestions();
            return;
        }
        const lowerWord = wordInfo.word.toLowerCase();
        const tblMap = statementTableMap();
        let pool;
        if (wordInfo.qualifier) {
            // `alias.` / `table.` の後ろは、その表の列だけを出す
            const t = tblMap[wordInfo.qualifier.toLowerCase()] || wordInfo.qualifier.toLowerCase();
            pool = db.tables[t] ? db.tables[t].getColumnNames() : [];
        } else {
            // 修飾子なし: この文で使っている表の列 → 表名 → キーワードの順に並べる。
            // 以前はキーワードと全表の全列をまとめて並べていたため、無関係な表の列が
            // 先に来て本当に欲しい名前が 10 件の枠から押し出されていた
            const ctxCols = [];
            Object.keys(tblMap).forEach(a => {
                const t = tblMap[a];
                if (db.tables[t]) db.tables[t].getColumnNames().forEach(c => ctxCols.push(c));
            });
            const tableNames = Object.keys(db.tables).filter(t => !t.startsWith('__'));
            pool = [...ctxCols, ...tableNames, ...keywords];
        }
        currentSuggestions = [...new Set(pool)]
            .filter(s => s.toLowerCase().startsWith(lowerWord) && s.toLowerCase() !== lowerWord)
            .slice(0, 20);

        if (currentSuggestions.length === 0) {
            hideSuggestions();
            return;
        }

        suggestIndex = 0;

        // Calculate coordinate using dummy span
        const textBefore = els.query.value.slice(0, wordInfo.start);
        els.hl.innerHTML = textBefore.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '<span id="caret-pos" class="inline-block w-px"></span>';
        const caretSpan = document.getElementById('caret-pos');
        if (caretSpan) {
            let top = caretSpan.offsetTop + 20 - els.query.scrollTop;
            let left = caretSpan.offsetLeft - els.query.scrollLeft;
            if (top > els.query.clientHeight - 80) top -= 100; // prevent overflow

            els.suggestBox.style.top = `${top}px`;
            els.suggestBox.style.left = `${left}px`;
            els.suggestBox.classList.remove('hidden');
            renderSuggestBox();
        }
        updateHighlight(); // restore syntax highlighting
    }

    function insertSuggestion(word) {
        const wordInfo = getCurrentWord();
        if (wordInfo) {
            const val = els.query.value;
            const newVal = val.slice(0, wordInfo.start) + word + val.slice(wordInfo.end);
            setQueryValue(newVal);
            els.query.selectionStart = els.query.selectionEnd = wordInfo.start + word.length;
        }
        hideSuggestions();
    }

    els.suggestBox.addEventListener('click', (e) => {
        const div = e.target.closest('div');
        if (div && div.dataset.index !== undefined) {
            insertSuggestion(currentSuggestions[div.dataset.index]);
            els.query.focus();
        }
    });

    els.query.addEventListener('blur', () => setTimeout(hideSuggestions, 200));

    // --- クエリ履歴 (localStorage 永続化 / Ctrl+↑↓ で巡回) ---
    const HISTORY_KEY = 'luminadb_query_history';
    const HISTORY_MAX = 50;
    let historyIndex = -1; // -1 = 履歴外（現在の入力）
    let historyDraft = '';

    function loadQueryHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
    }

    // 実行したクエリを履歴へ積む（重複は最新位置へ移動、最大50件）
    function pushQueryHistory(sql) {
        historyIndex = -1;
        if (isTesting) return;
        try {
            const h = loadQueryHistory().filter(q => q !== sql);
            h.push(sql);
            while (h.length > HISTORY_MAX) h.shift();
            localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
        } catch (e) { /* localStorage が使えない環境では履歴なしで続行 */ }
    }

    // dir: -1 = 過去へ / +1 = 新しい方へ（履歴の先を越えると編集中の下書きに戻る）
    // ============================================================================
    // クエリ履歴パネル: Ctrl+↑↓ の巡回だけでは「少し前に書いたあの1文」に戻れないので、
    // 検索して読み込み・実行できる一覧を用意する
    // ============================================================================
    function renderHistoryList() {
        const list = document.getElementById('historyList');
        const q = (document.getElementById('historySearch').value || '').trim().toLowerCase();
        // 新しいものを上に出す
        const all = loadQueryHistory().slice().reverse();
        const items = q === '' ? all : all.filter(s => s.toLowerCase().includes(q));
        document.getElementById('historyCount').textContent = q === ''
            ? `(${all.length})`
            : `(${items.length} / ${all.length})`;
        list.innerHTML = '';
        if (items.length === 0) {
            list.innerHTML = `<div class="text-sm text-gray-400 text-center py-10">${all.length === 0 ? i18nT('履歴はまだありません。') : i18nT('一致する履歴がありません。')}</div>`;
            return;
        }
        items.forEach(sql => {
            const row = document.createElement('div');
            row.className = 'flex items-start gap-2 py-2 group';
            const btn = document.createElement('button');
            btn.className = 'flex-1 text-left font-mono text-xs text-gray-700 hover:text-blue-700 whitespace-pre-wrap break-all';
            btn.textContent = sql;   // textContent 経由なのでエスケープ不要
            btn.addEventListener('click', () => {
                setQueryValue(sql);
                closeModal('historyModal');
                els.query.focus();
            });
            const run = document.createElement('button');
            run.className = 'shrink-0 text-xs border border-blue-300 bg-blue-50 hover:bg-blue-100 text-blue-700 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity';
            run.textContent = 'Run';
            run.addEventListener('click', () => {
                setQueryValue(sql);
                closeModal('historyModal');
                runQuery();
            });
            row.appendChild(btn);
            row.appendChild(run);
            list.appendChild(row);
        });
    }

    document.getElementById('openHistoryBtn').addEventListener('click', () => {
        document.getElementById('historySearch').value = '';
        renderHistoryList();
        document.getElementById('historySearch').focus();
    });
    document.getElementById('historySearch').addEventListener('input', renderHistoryList);
    document.getElementById('historyClearBtn').addEventListener('click', () => {
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* localStorage 無効環境 */ }
        historyIndex = -1;
        renderHistoryList();
    });

    function navigateHistory(dir) {
        const h = loadQueryHistory();
        if (h.length === 0) return;
        if (historyIndex === -1) {
            if (dir > 0) return;
            historyDraft = els.query.value;
            historyIndex = h.length - 1;
        } else {
            historyIndex += dir;
            if (historyIndex >= h.length) {
                historyIndex = -1;
                setQueryValue(historyDraft);
                return;
            }
            if (historyIndex < 0) historyIndex = 0;
        }
        setQueryValue(h[historyIndex]);
    }

    // --- Undo / Redo ---
    let undoStack = [];
    let redoStack = [];
    let saveTimeout;

    function saveQueryState() {
        if (isTesting) return;
        const val = els.query.value;
        if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== val) {
            undoStack.push(val);
            redoStack = [];
        }
    }

    // ============================================================================
    // エディタタブ: 複数のクエリを並行して書き溜める（商用クライアントと同じ操作体系）。
    //   ・タブごとに本文と undo/redo 履歴を持つ
    //   ・localStorage へ保存し、リロードしても書きかけが残る
    //   ・ラベルは SQL から自動生成（ダブルクリックで手動命名も可）
    // ============================================================================
    const TABS_KEY = 'luminadb_editor_tabs';
    const TABS_MAX = 12;
    let tabs = [];
    let activeTabId = null;
    let tabSeq = 0;

    // SQL から短いタブ名を作る（'SELECT users' 等）。空なら 'Untitled'
    function deriveTabName(sql) {
        const t = String(sql || '').trim().replace(/\s+/g, ' ');
        if (t === '') return 'Untitled';
        const vm = t.match(/^([a-zA-Z_]+)/);
        if (!vm) return t.slice(0, 18);
        const verb = vm[1].toUpperCase();
        // UPDATE / MERGE は動詞の直後が対象表。その他は FROM / INTO / TABLE 等の後ろを見る
        const direct = t.match(/^(?:update|merge\s+into|merge)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
        const kw = direct ? null : t.match(/\b(?:from|into|table|view|index)\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
        const target = direct ? direct[1] : (kw ? kw[1] : null);
        return (target ? `${verb} ${target}` : verb).slice(0, 22);
    }

    const activeTab = () => tabs.find(t => t.id === activeTabId) || null;

    // 現在の入力をタブへ反映して保存する（input イベントが飛ばない
    // プログラム由来の書き換え — 履歴読込・整形・Clear などから呼ぶ）
    function touchActiveTab() {
        if (tabs.length === 0) return;
        syncActiveTab();
        renderTabs();
        persistTabs();
    }

    function persistTabs() {
        if (isTesting) return;
        try {
            localStorage.setItem(TABS_KEY, JSON.stringify({
                activeTabId,
                tabs: tabs.map(t => ({ id: t.id, name: t.name, custom: !!t.custom, sql: t.sql }))
            }));
        } catch (e) { /* localStorage が使えない環境ではセッション限りで続行 */ }
    }

    // 現在の入力内容と undo/redo を、いま開いているタブへ書き戻す
    function syncActiveTab() {
        const t = activeTab();
        if (!t) return;
        t.sql = els.query.value;
        t.undoStack = undoStack;
        t.redoStack = redoStack;
        if (!t.custom) t.name = deriveTabName(t.sql);
    }

    function renderTabs() {
        const wrap = document.getElementById('editorTabs');
        if (!wrap) return;
        wrap.innerHTML = '';
        // 仮引数は tab（i18nT と紛れないよう t を避ける）
        tabs.forEach((tab, i) => {
            const on = tab.id === activeTabId;
            const el = document.createElement('div');
            el.className = 'shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-t border-b-2 text-xs cursor-pointer select-none transition-colors '
                + (on ? 'bg-white border-blue-500 text-gray-800 font-medium shadow-sm'
                      : 'bg-gray-50 border-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-700');
            el.dataset.tabId = tab.id;
            el.title = i18nT('{0}{1} — ダブルクリックで名前を変更', tab.name, i < 9 ? ` (Alt+${i + 1})` : '');
            const label = document.createElement('span');
            label.className = 'truncate max-w-[10rem]';
            label.textContent = tab.name;
            el.appendChild(label);
            if (tabs.length > 1) {
                const x = document.createElement('button');
                x.className = 'text-gray-400 hover:text-red-600 leading-none px-0.5';
                x.textContent = '×';
                x.title = i18nT('このタブを閉じる');
                x.dataset.closeId = tab.id;
                el.appendChild(x);
            }
            wrap.appendChild(el);
        });
    }

    // タブを切り替える（現在の内容を保存してから、対象タブの内容を復元する）
    function selectTab(id) {
        if (id === activeTabId) return;
        const target = tabs.find(t => t.id === id);
        if (!target) return;
        clearTimeout(saveTimeout);
        syncActiveTab();
        activeTabId = id;
        undoStack = target.undoStack && target.undoStack.length > 0 ? target.undoStack : [target.sql];
        redoStack = target.redoStack || [];
        els.query.value = target.sql;
        updateHighlight();
        renderTabs();
        persistTabs();
        els.query.focus();
    }

    function addTab(sql) {
        if (tabs.length >= TABS_MAX) { showToast(i18nT('タブは最大 {0} 枚までです。', TABS_MAX), true); return; }
        clearTimeout(saveTimeout);
        syncActiveTab();
        const t = { id: ++tabSeq, name: deriveTabName(sql), custom: false, sql: sql || '', undoStack: [sql || ''], redoStack: [] };
        tabs.push(t);
        activeTabId = t.id;
        undoStack = t.undoStack;
        redoStack = [];
        els.query.value = t.sql;
        updateHighlight();
        renderTabs();
        persistTabs();
        els.query.focus();
    }

    function closeTab(id) {
        if (tabs.length <= 1) return;
        const i = tabs.findIndex(t => t.id === id);
        if (i === -1) return;
        const wasActive = tabs[i].id === activeTabId;
        tabs.splice(i, 1);
        if (wasActive) {
            const next = tabs[Math.min(i, tabs.length - 1)];
            activeTabId = next.id;
            undoStack = next.undoStack && next.undoStack.length > 0 ? next.undoStack : [next.sql];
            redoStack = next.redoStack || [];
            els.query.value = next.sql;
            updateHighlight();
        }
        renderTabs();
        persistTabs();
    }

    function renameTab(id) {
        const tab = tabs.find(x => x.id === id);
        if (!tab) return;
        const name = window.prompt(i18nT('タブ名'), tab.name);
        if (name === null) return;
        const trimmed = name.trim();
        if (trimmed === '') { tab.custom = false; tab.name = deriveTabName(tab.sql); }
        else { tab.custom = true; tab.name = trimmed.slice(0, 40); }
        renderTabs();
        persistTabs();
    }

    function initTabs() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null'); } catch (e) { saved = null; }
        if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
            tabs = saved.tabs.slice(0, TABS_MAX).map(t => ({
                id: ++tabSeq,
                name: typeof t.name === 'string' && t.name !== '' ? t.name : deriveTabName(t.sql),
                custom: !!t.custom,
                sql: typeof t.sql === 'string' ? t.sql : '',
                undoStack: [typeof t.sql === 'string' ? t.sql : ''],
                redoStack: []
            }));
            // 保存時の activeTabId は採番し直した id と対応しないため、位置で復元する
            const idx = Math.max(0, (saved.tabs || []).findIndex(t => t.id === saved.activeTabId));
            activeTabId = tabs[Math.min(idx, tabs.length - 1)].id;
        } else {
            // 初回起動: 現在エディタに入っている内容をそのまま 1 枚目のタブにする
            const cur = els.query.value;
            tabs = [{ id: ++tabSeq, name: deriveTabName(cur), custom: false, sql: cur, undoStack: [cur], redoStack: [] }];
            activeTabId = tabs[0].id;
        }
        const act = activeTab();
        els.query.value = act.sql;
        undoStack = act.undoStack;
        redoStack = [];
        updateHighlight();
        renderTabs();
    }

    document.getElementById('editorTabs').addEventListener('click', (e) => {
        const closeBtn = e.target.closest('[data-close-id]');
        if (closeBtn) { e.stopPropagation(); closeTab(Number(closeBtn.dataset.closeId)); return; }
        const tab = e.target.closest('[data-tab-id]');
        if (tab) selectTab(Number(tab.dataset.tabId));
    });
    document.getElementById('editorTabs').addEventListener('dblclick', (e) => {
        const tab = e.target.closest('[data-tab-id]');
        if (tab) renameTab(Number(tab.dataset.tabId));
    });
    document.getElementById('tabAddBtn').addEventListener('click', () => addTab(''));

    function setQueryValue(val) {
        els.query.value = val;
        updateHighlight();
        saveQueryState();
        touchActiveTab();
    }

    // カーソル位置へテキストを挿入する（サイドバーのカラム名クリック等から使う）。
    // 直前が識別子文字なら区切りの空白を足し、挿入後はカーソルを末尾へ送る
    function insertAtCursor(text) {
        const el = els.query;
        const pos = el.selectionStart === null ? el.value.length : el.selectionStart;
        const end = el.selectionEnd === null ? pos : el.selectionEnd;
        const before = el.value.slice(0, pos);
        const sep = (before !== '' && /[a-zA-Z0-9_.]$/.test(before)) ? ' ' : '';
        const ins = sep + text;
        el.value = before + ins + el.value.slice(end);
        el.selectionStart = el.selectionEnd = pos + ins.length;
        updateHighlight();
        saveQueryState();
        touchActiveTab();
        el.focus();
    }

    // カーソル位置を含む 1 文だけを切り出す（商用クライアントの
    // 「カーソル位置の文を実行」相当）。';' 区切りで、文字列リテラル内は無視する。
    // 見つからなければ null を返す（呼び出し側は全文実行へ落とす）
    function statementAtCursor(text, caret) {
        if (!text || text.trim() === '') return null;
        const bounds = [];
        let start = 0, inStr = false, quote = '';
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (c === '\\') { i++; continue; }
                if (c === quote) {
                    // '' / "" は引用符のエスケープなので閉じたと見なさない
                    if (text[i + 1] === quote) { i++; continue; }
                    inStr = false;
                }
                continue;
            }
            if (c === "'" || c === '"') { inStr = true; quote = c; continue; }
            if (c === ';') { bounds.push([start, i]); start = i + 1; }
        }
        bounds.push([start, text.length]);
        const pos = Math.max(0, Math.min(caret === null || caret === undefined ? text.length : caret, text.length));
        // カーソルがちょうど ';' の直後にある場合は「直前の文」を選ぶのが自然
        for (const [s, e] of bounds) {
            if (pos >= s && pos <= e) {
                const seg = text.slice(s, e).trim();
                if (seg !== '') return seg;
            }
        }
        // 空セグメント上にいるときは前方の直近の非空文を返す
        for (let i = bounds.length - 1; i >= 0; i--) {
            const seg = text.slice(bounds[i][0], bounds[i][1]).trim();
            if (seg !== '' && bounds[i][0] <= pos) return seg;
        }
        return null;
    }

    initTabs();
    saveQueryState();
    updateHighlight();

    els.query.addEventListener('input', () => {
        updateHighlight();
        showSuggestions();
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveQueryState();
            // 入力が落ち着いたところでタブ本文とラベルを更新して保存する
            syncActiveTab();
            renderTabs();
            persistTabs();
        }, 400);
    });

    els.query.addEventListener('scroll', () => {
        els.hl.scrollTop = els.query.scrollTop;
        els.hl.scrollLeft = els.query.scrollLeft;
        hideSuggestions();
    });

    els.query.addEventListener('keydown', (e) => {
        if (!els.suggestBox.classList.contains('hidden') && currentSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                suggestIndex = (suggestIndex + 1) % currentSuggestions.length;
                renderSuggestBox();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                suggestIndex = (suggestIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
                renderSuggestBox();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertSuggestion(currentSuggestions[suggestIndex]);
                return;
            }
            if (e.key === 'Escape') {
                hideSuggestions();
                return;
            }
        }

        const cmdKey = e.metaKey || e.ctrlKey;
        // エディタタブ: Ctrl+Alt+T 新規 / Ctrl+Alt+W 閉じる / Alt+1..9 で切替。
        // Ctrl+T / Ctrl+W はブラウザ自身が奪うので Alt を足している
        if (cmdKey && e.altKey && e.key.toLowerCase() === 't') {
            e.preventDefault(); addTab(''); return;
        }
        if (cmdKey && e.altKey && e.key.toLowerCase() === 'w') {
            e.preventDefault(); closeTab(activeTabId); return;
        }
        if (e.altKey && !cmdKey && /^[1-9]$/.test(e.key)) {
            const t = tabs[Number(e.key) - 1];
            if (t) { e.preventDefault(); selectTab(t.id); }
            return;
        }
        if (e.key === 'Enter' && cmdKey) {
            e.preventDefault();
            clearTimeout(saveTimeout); saveQueryState();
            // Ctrl+Enter はカーソル位置の 1 文だけ、Ctrl+Shift+Enter は全文を実行する。
            // 複数文を書き溜めたスクラッチパッドから 1 文ずつ試せるようにするため
            if (e.shiftKey) runQuery();
            else runQueryAtCursor();
            return;
        }
        // Ctrl+↑ / Ctrl+↓: クエリ履歴の巡回
        if (cmdKey && e.key === 'ArrowUp') {
            e.preventDefault();
            navigateHistory(-1);
            return;
        }
        if (cmdKey && e.key === 'ArrowDown') {
            e.preventDefault();
            navigateHistory(1);
            return;
        }
        if (cmdKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault();
            clearTimeout(saveTimeout);
            if (els.query.value !== undoStack[undoStack.length - 1]) redoStack.push(els.query.value);
            else if (undoStack.length > 1) redoStack.push(undoStack.pop());
            if (undoStack.length > 0) { els.query.value = undoStack[undoStack.length - 1]; updateHighlight(); }
        }
        if ((cmdKey && e.key.toLowerCase() === 'y') || (cmdKey && e.key.toLowerCase() === 'z' && e.shiftKey)) {
            e.preventDefault();
            clearTimeout(saveTimeout);
            if (redoStack.length > 0) {
                const val = redoStack.pop();
                undoStack.push(val);
                els.query.value = val;
                updateHighlight();
            }
        }
    });

    document.getElementById('clearBtn').addEventListener('click', () => { setQueryValue(''); els.query.focus(); });

    // Format ボタン / Ctrl+Shift+F: 現在のクエリを整形して置き換える
    function applyFormat() {
        const cur = els.query.value;
        if (!cur.trim()) return;
        clearTimeout(saveTimeout); saveQueryState();
        setQueryValue(formatSql(cur));
        els.query.focus();
    }
    document.getElementById('formatBtn').addEventListener('click', applyFormat);
    els.query.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            applyFormat();
        }
        // Ctrl+Shift+E: 実行せずに実行計画だけ見る
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
            e.preventDefault();
            const btn = document.getElementById('explainBtn');
            if (btn) btn.click();
        }
    });

    // ============================================================================
    // エディタと結果ペインの境界（スプリッタ）
    // 従来はエディタの高さが 128px 固定で、長い SQL が数行しか見えなかった。
    // 高さは localStorage に残し、次回起動でも保つ
    // ============================================================================
    (function initSplitter() {
        const splitter = document.getElementById('editorSplitter');
        const box = document.getElementById('editorBox');
        if (!splitter || !box) return;
        const KEY = 'luminadb_editor_height';
        const MIN = 64, MAX_RATIO = 0.7;
        const clamp = (h) => Math.max(MIN, Math.min(Math.round(window.innerHeight * MAX_RATIO), Math.round(h)));
        const apply = (h) => { box.style.height = clamp(h) + 'px'; };
        // 起動時に前回の高さを戻す（localStorage が使えない環境でも落ちないように）
        try {
            const saved = parseInt(localStorage.getItem(KEY) || '', 10);
            if (!isNaN(saved)) apply(saved);
        } catch (err) { /* プライベートモード等では既定の高さのまま */ }

        let dragging = false;
        const onMove = (ev) => {
            if (!dragging) return;
            const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
            apply(y - box.getBoundingClientRect().top);
            ev.preventDefault();
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            try { localStorage.setItem(KEY, String(parseInt(box.style.height, 10) || MIN)); } catch (err) { /* 保存できなくても動作は続く */ }
        };
        const onDown = (ev) => {
            dragging = true;
            document.body.style.userSelect = 'none';
            ev.preventDefault();
        };
        splitter.addEventListener('mousedown', onDown);
        splitter.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);
        // ダブルクリックで既定（8rem）へ戻す
        splitter.addEventListener('dblclick', () => {
            box.style.height = '';
            try { localStorage.removeItem(KEY); } catch (err) { /* 何もしない */ }
        });
        // キーボードでも操作できるようにする（矢印で 16px ずつ）
        splitter.addEventListener('keydown', (ev) => {
            if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
            ev.preventDefault();
            const cur = box.getBoundingClientRect().height;
            apply(cur + (ev.key === 'ArrowDown' ? 16 : -16));
            try { localStorage.setItem(KEY, String(parseInt(box.style.height, 10) || MIN)); } catch (err) { /* 保存できなくても動作は続く */ }
        });
    })();
