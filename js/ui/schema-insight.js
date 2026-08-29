    // ============================================================================
    // [Schema Insight] - 列プロファイルと ER 図
    //   商用DBクライアント（DBeaver / pgAdmin / SSMS）にある「中身をざっと掴む」機能。
    //   ・列プロファイル: 行数 / NULL 数 / 相異なり数 / 最小・最大 / 上位の値
    //   ・ER 図: 外部キーの親子関係を SVG で俯瞰する（外部ライブラリ非依存）
    // ============================================================================

    // --- 列プロファイル -------------------------------------------------------
    // 1 列分の要約を作る。文字列も数値も同じ枠で扱えるよう、比較は値の型で分ける
    function profileColumn(t, col) {
        const n = t.rowCount;
        const counts = new Map();       // 値 -> 出現数（上位の値と相異なり数に使う）
        let nulls = 0, min = null, max = null, numCount = 0, sum = 0;
        let minLen = null, maxLen = null;
        for (let i = 0; i < n; i++) {
            const v = t.getValue(col, i);
            if (v === null || v === undefined) { nulls++; continue; }
            const key = typeof v === 'object' ? JSON.stringify(v) : v;
            counts.set(key, (counts.get(key) || 0) + 1);
            if (typeof v === 'number') { numCount++; sum += v; }
            if (min === null || v < min) min = v;
            if (max === null || v > max) max = v;
            const len = String(v).length;
            if (minLen === null || len < minLen) minLen = len;
            if (maxLen === null || len > maxLen) maxLen = len;
        }
        // 出現数の多い順に上位 3 件（同数のときは先に見つかった順）
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
        return {
            column: col,
            type: (t.colTypes && t.colTypes[col]) ? t.colTypes[col] : 'ANY',
            rows: n,
            nulls,
            nullPct: n === 0 ? 0 : Math.round((nulls / n) * 1000) / 10,
            distinct: counts.size,
            unique: counts.size > 0 && counts.size === n - nulls,
            min, max,
            avg: numCount > 0 ? Math.round((sum / numCount) * 1000) / 1000 : null,
            minLen, maxLen,
            top
        };
    }

    function profileTable(tbl) {
        const t = db.tables[tbl];
        if (!t) return null;
        return Object.keys(t.cols).map(c => profileColumn(t, c));
    }

    // 値を 1 行に収まる長さで表示する（NULL と空文字を見分けられるようにする）
    function profileCell(v) {
        if (v === null || v === undefined) return '—';
        const s = String(v);
        if (s === '') return '(empty)';
        return s.length > 40 ? s.slice(0, 40) + '…' : s;
    }

    function renderProfile(tbl) {
        const body = document.getElementById('profileBody');
        const stats = profileTable(tbl);
        document.getElementById('profileTable').textContent = tbl;
        const t = db.tables[tbl];
        document.getElementById('profileRows').textContent = i18nT('（{0} 行 × {1} 列）', t.rowCount.toLocaleString(), stats.length);
        document.getElementById('profileNote').textContent = t.rowCount === 0 ? i18nT('空の表です') : '';

        const table = document.createElement('table');
        table.className = 'w-full text-xs border-collapse';
        const head = document.createElement('thead');
        head.innerHTML = `<tr class="bg-gray-50 sticky top-0">
            ${[i18nT('列'), i18nT('型'), i18nT('NULL'), i18nT('相異なり'), i18nT('最小'), i18nT('最大'), i18nT('平均'), i18nT('長さ'), i18nT('多い値')]
              .map(h => `<th class="text-left font-semibold text-gray-500 px-2 py-1.5 border-b border-gray-200 whitespace-nowrap">${h}</th>`).join('')}
        </tr>`;
        table.appendChild(head);

        const tbody = document.createElement('tbody');
        stats.forEach(st => {
            const tr = document.createElement('tr');
            tr.className = 'border-b border-gray-100 hover:bg-blue-50/40';

            const nameTd = document.createElement('td');
            nameTd.className = 'px-2 py-1.5 whitespace-nowrap';
            const nameBtn = document.createElement('button');
            nameBtn.className = 'font-mono text-blue-600 hover:underline profile-col-btn';
            nameBtn.dataset.column = st.column;
            nameBtn.textContent = st.column;
            nameBtn.title = i18nT('この列の分布を出すクエリをエディタへ');
            nameTd.appendChild(nameBtn);
            if (st.unique && st.rows > 0) {
                const b = document.createElement('span');
                b.className = 'ml-1 text-[9px] px-1 py-0.5 rounded border font-semibold bg-violet-100 text-violet-700 border-violet-200';
                b.textContent = 'UQ';
                b.title = i18nT('この列の非NULL値はすべて異なる');
                nameTd.appendChild(b);
            }
            tr.appendChild(nameTd);

            const cells = [
                st.type,
                st.nulls === 0 ? '0' : `${st.nulls} (${st.nullPct}%)`,
                String(st.distinct),
                profileCell(st.min),
                profileCell(st.max),
                st.avg === null ? '—' : String(st.avg),
                st.minLen === null ? '—' : (st.minLen === st.maxLen ? String(st.minLen) : `${st.minLen}–${st.maxLen}`)
            ];
            cells.forEach((c, i) => {
                const td = document.createElement('td');
                td.className = 'px-2 py-1.5 text-gray-700 whitespace-nowrap' + (i === 1 && st.nulls > 0 ? ' text-amber-700' : '');
                td.textContent = c;
                tr.appendChild(td);
            });

            const topTd = document.createElement('td');
            topTd.className = 'px-2 py-1.5 text-gray-500';
            topTd.textContent = st.top.length === 0 ? '—'
                : st.top.map(([v, c]) => `${profileCell(v)} ×${c}`).join(', ');
            tr.appendChild(topTd);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        body.innerHTML = '';
        body.appendChild(table);

        // 列名クリックで「その列の値ごとの件数」を出すクエリをエディタへ
        body.querySelectorAll('.profile-col-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const c = e.currentTarget.dataset.column;
                loadIntoEditor(`SELECT ${c}, COUNT(*) AS n FROM ${tbl} GROUP BY ${c} ORDER BY n DESC`);
                closeModal('profileModal');
                els.query.focus();
            });
        });
    }

    function openProfile(tbl) {
        if (!db.tables[tbl]) { showToast(i18nT('表 \'{0}\' がありません。', tbl), true); return; }
        renderProfile(tbl);
        openModal('profileModal');
    }

    // --- ER 図 ----------------------------------------------------------------
    // 外部キーの親子関係を層（親を上、子を下）に並べた SVG で描く。
    // 循環参照や自己参照があっても止まらないよう、深さは訪問済み集合で打ち切る
    function buildErModel() {
        const names = Object.keys(db.tables).filter(n => !n.startsWith('__tmp_'));
        const edges = [];
        names.forEach(child => {
            const t = db.tables[child];
            (t.foreignKeys || []).forEach(fk => {
                const cols = fk.cols || [fk.col];
                const refCols = fk.refCols || [fk.refCol];
                if (!fk.refTable || !db.tables[fk.refTable]) return;
                edges.push({ child, parent: fk.refTable, cols, refCols });
            });
        });
        // 層の割り当て: 親を持たない表を第 0 層にし、子を 1 つ下へ送る
        const depth = Object.create(null);
        names.forEach(n => depth[n] = 0);
        for (let pass = 0; pass < names.length; pass++) {
            let moved = false;
            edges.forEach(e => {
                if (e.child === e.parent) return;   // 自己参照は層を下げない
                if (depth[e.child] <= depth[e.parent]) { depth[e.child] = depth[e.parent] + 1; moved = true; }
            });
            if (!moved) break;
        }
        return { names, edges, depth };
    }

    function renderEr() {
        const body = document.getElementById('erBody');
        const { names, edges, depth } = buildErModel();
        document.getElementById('erCount').textContent = i18nT('（{0} 表 / 外部キー {1} 本）', names.length, edges.length);
        document.getElementById('erNote').textContent = edges.length === 0 ? i18nT('外部キーはまだありません') : '';
        if (names.length === 0) {
            body.innerHTML = `<div class="p-8 text-center text-gray-500 text-sm">${i18nT('表がありません。')}</div>`;
            return;
        }

        // 層ごとに横並びに配置する
        const byDepth = new Map();
        names.forEach(n => {
            const d = depth[n];
            if (!byDepth.has(d)) byDepth.set(d, []);
            byDepth.get(d).push(n);
        });
        const layers = [...byDepth.keys()].sort((a, b) => a - b);

        const BOX_W = 190, ROW_H = 16, HEAD_H = 26, PAD = 8, GAP_X = 46, GAP_Y = 60, MAX_COLS = 8;
        const pos = Object.create(null);
        let y = PAD;
        let maxX = 0;
        layers.forEach(d => {
            const row = byDepth.get(d);
            let x = PAD;
            let rowH = 0;
            row.forEach(n => {
                const t = db.tables[n];
                const shown = Math.min(Object.keys(t.cols).length, MAX_COLS);
                const h = HEAD_H + shown * ROW_H + 6;
                pos[n] = { x, y, w: BOX_W, h };
                x += BOX_W + GAP_X;
                rowH = Math.max(rowH, h);
            });
            maxX = Math.max(maxX, x);
            y += rowH + GAP_Y;
        });
        const width = Math.max(maxX, 320), height = y;

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('xmlns', svgNs);
        svg.style.maxWidth = 'none';

        // 矢じり
        const defs = document.createElementNS(svgNs, 'defs');
        defs.innerHTML = '<marker id="erArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            + '<path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"></path></marker>';
        svg.appendChild(defs);

        const mk = (tag, attrs, text) => {
            const el = document.createElementNS(svgNs, tag);
            Object.keys(attrs).forEach(k => el.setAttribute(k, String(attrs[k])));
            if (text !== undefined) el.textContent = text;   // textContent なのでエスケープ不要
            return el;
        };

        // 先に線を描く（箱の下へ回す）
        edges.forEach(e => {
            const c = pos[e.child], p = pos[e.parent];
            if (!c || !p) return;
            const label = e.cols.join(', ');
            if (e.child === e.parent) {
                // 自己参照は右側にループを描く
                const x0 = c.x + c.w, y0 = c.y + c.h / 2;
                svg.appendChild(mk('path', {
                    d: `M ${x0} ${y0 - 8} C ${x0 + 30} ${y0 - 24}, ${x0 + 30} ${y0 + 24}, ${x0} ${y0 + 8}`,
                    fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.4, 'marker-end': 'url(#erArrow)'
                }));
                svg.appendChild(mk('text', { x: x0 + 34, y: y0 + 3, 'font-size': 9, fill: '#64748b' }, label));
                return;
            }
            const x1 = c.x + c.w / 2, y1 = c.y;
            const x2 = p.x + p.w / 2, y2 = p.y + p.h;
            const my = (y1 + y2) / 2;
            svg.appendChild(mk('path', {
                d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
                fill: 'none', stroke: '#94a3b8', 'stroke-width': 1.4, 'marker-end': 'url(#erArrow)'
            }));
            svg.appendChild(mk('text', {
                x: (x1 + x2) / 2 + 4, y: my - 2, 'font-size': 9, fill: '#64748b'
            }, label));
        });

        // 表の箱
        names.forEach(n => {
            const t = db.tables[n];
            const b = pos[n];
            const g = mk('g', { class: 'er-table', 'data-table': n, style: 'cursor:pointer' });
            g.appendChild(mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 5,
                fill: '#ffffff', stroke: '#cbd5e1', 'stroke-width': 1 }));
            g.appendChild(mk('rect', { x: b.x, y: b.y, width: b.w, height: HEAD_H, rx: 5,
                fill: '#eff6ff', stroke: '#cbd5e1', 'stroke-width': 1 }));
            g.appendChild(mk('text', { x: b.x + PAD, y: b.y + 17, 'font-size': 12, 'font-weight': 600, fill: '#1d4ed8' }, n));
            g.appendChild(mk('text', { x: b.x + b.w - PAD, y: b.y + 17, 'font-size': 9, fill: '#94a3b8', 'text-anchor': 'end' },
                i18nT('{0} 行', t.rowCount)));

            const cols = Object.keys(t.cols);
            cols.slice(0, MAX_COLS).forEach((c, i) => {
                const ty = b.y + HEAD_H + 12 + i * ROW_H;
                const isPk = t.primaryKey === c || (t.compositeKeys || []).some(ck => ck.isPK && ck.cols.includes(c));
                const isFk = (t.foreignKeys || []).some(fk => (fk.cols || [fk.col]).includes(c));
                const mark = isPk ? '🔑' : (isFk ? '↗' : '');
                g.appendChild(mk('text', { x: b.x + PAD, y: ty, 'font-size': 10,
                    fill: isPk ? '#b45309' : (isFk ? '#0369a1' : '#475569'),
                    'font-family': 'ui-monospace, monospace' }, `${mark ? mark + ' ' : ''}${c}`));
                g.appendChild(mk('text', { x: b.x + b.w - PAD, y: ty, 'font-size': 9, fill: '#94a3b8', 'text-anchor': 'end' },
                    (t.colTypes && t.colTypes[c]) ? t.colTypes[c] : 'ANY'));
            });
            if (cols.length > MAX_COLS) {
                g.appendChild(mk('text', { x: b.x + PAD, y: b.y + HEAD_H + 12 + MAX_COLS * ROW_H, 'font-size': 9, fill: '#94a3b8' },
                    `… +${cols.length - MAX_COLS} more`));
            }
            svg.appendChild(g);
        });

        body.innerHTML = '';
        body.appendChild(svg);
        svg.querySelectorAll('.er-table').forEach(g => {
            g.addEventListener('click', (e) => {
                loadIntoEditor(`SELECT * FROM ${e.currentTarget.dataset.table}`);
                closeModal('erModal');
                els.query.focus();
            });
        });
    }

    function openEr() {
        renderEr();
        openModal('erModal');
    }

    // --- ワイヤリング ---------------------------------------------------------
    document.getElementById('openErBtn').addEventListener('click', openEr);
    document.getElementById('erCopyBtn').addEventListener('click', () => {
        const svg = document.querySelector('#erBody svg');
        if (!svg) { showToast(i18nT('図がありません。'), true); return; }
        const text = new XMLSerializer().serializeToString(svg);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => showToast(i18nT('SVG をコピーしました。')))
                .catch(() => showToast(i18nT('コピーに失敗しました。'), true));
        } else {
            showToast(i18nT('この環境ではコピーできません。'), true);
        }
    });
