    // ============================================================================
    // [Editor] - シンタックスハイライト / オートコンプリート / Undo・Redo
    // ============================================================================
    const keywords = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'RENAME', 'TO', 'FOREIGN', 'KEY', 'REFERENCES', 'TRUNCATE', 'OPTIMIZE', 'VACUUM', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'BEGIN', 'COMMIT', 'ROLLBACK', 'JOIN', 'ON', 'INNER', 'LEFT', 'ORDER', 'BY', 'DESC', 'ASC', 'HAVING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'AND', 'OR', 'IN', 'GROUP', 'LIMIT', 'OFFSET', 'LIKE', 'NOT', 'IS', 'NULL', 'BETWEEN', 'DISTINCT', 'UPPER', 'LOWER', 'LENGTH', 'ROUND', 'COALESCE', 'SUBSTRING', 'CONCAT', 'REPLACE', 'TRIM', 'ABS', 'CEIL', 'FLOOR', 'NOW', 'LPAD', 'RPAD', 'POWER', 'SQRT', 'YEAR', 'MONTH', 'DAY', 'MOD', 'SIGN', 'RAND', 'INDEX', 'EXPLAIN', 'TRUE', 'FALSE', 'BOOLEAN', 'DATE', 'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'VIEW', 'UNION', 'ALL', 'EXISTS', 'PROCEDURE', 'CALL', 'UNIQUE', 'PRIMARY', 'RIGHT', 'SHOW', 'TABLES', 'VIEWS', 'PROCEDURES', 'DESCRIBE', 'CROSS', 'INTERSECT', 'EXCEPT', 'CAST', 'INTEGER', 'FLOAT', 'TEXT', 'SAVEPOINT', 'RELEASE', 'MODIFY', 'GROUP_CONCAT', 'SEPARATOR', 'DENSE_RANK', 'LAG', 'LEAD', 'AUTO_INCREMENT', 'DEFAULT', 'WITH', 'IF', 'IFNULL', 'NULLIF', 'INSTR', 'REVERSE', 'REPEAT', 'GREATEST', 'LEAST', 'EXP', 'LOG', 'LOG10', 'PI', 'HOUR', 'MINUTE', 'SECOND', 'DATEDIFF', 'NTILE', 'FIRST_VALUE', 'LAST_VALUE', 'INDEXES'];

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
