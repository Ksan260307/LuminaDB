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
    'SHA1', 'SUBSTR', 'OCTET_LENGTH', 'BIT_LENGTH', 'UNHEX', 'DATE_TRUNC', 'TYPEOF', 'IIF', 'REGEXP_COUNT',
    'STRING_AGG', 'ARRAY_AGG', 'BOOL_AND', 'BOOL_OR', 'CORR', 'COVAR_POP', 'COVAR_SAMP'];

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

    function getCurrentWord() {
        const val = els.query.value;
        const cursor = els.query.selectionStart;
        const textBefore = val.slice(0, cursor);
        const match = textBefore.match(/[a-zA-Z0-9_]+$/);
        return match ? { word: match[0], start: match.index, end: cursor } : null;
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
        if (!wordInfo || wordInfo.word.length < 1) {
            hideSuggestions();
            return;
        }
        const lowerWord = wordInfo.word.toLowerCase();
        const allKw = getDynamicKeywords();
        currentSuggestions = allKw.filter(s => s.toLowerCase().startsWith(lowerWord) && s.toLowerCase() !== lowerWord).slice(0, 10);

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

    function setQueryValue(val) {
        els.query.value = val;
        updateHighlight();
        saveQueryState();
    }

    saveQueryState();
    updateHighlight();

    els.query.addEventListener('input', () => {
        updateHighlight();
        showSuggestions();
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveQueryState, 400);
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
        if (e.key === 'Enter' && cmdKey) {
            e.preventDefault();
            clearTimeout(saveTimeout); saveQueryState();
            runQuery();
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
    });
