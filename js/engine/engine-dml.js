    // ============================================================================
    // [DatabaseEngine DML] - INSERT / UPDATE / DELETE と制約チェック
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      // ============ 更新可能ビュー (INSERT / UPDATE / DELETE ON VIEW) ============
      // 商用DBはいずれも「単一表に対する射影＋選択だけのビュー」を更新可能として扱う。
      // ここも同じ方針で、ビューへの DML を基底表への DML へ書き換えて実行する。
      // 集約・結合・DISTINCT 等を含むビューは更新不可として理由付きで拒否し、
      // INSTEAD OF トリガーが定義されている場合はそちらへ委譲する。

      // DML の対象がビューかどうかを判定する（ディスパッチ前の安価な判定）。
      // ビュー名なら true。テーブル名や未知の名前なら false（従来のエラー経路へ）
      _viewDmlTarget(kind, sql) {
          if (!this.views || Object.keys(this.views).length === 0) return false;
          const m = kind === 'insert'
              ? sql.match(/^(?:insert|replace)\s+(?:ignore\s+)?into\s+([a-zA-Z0-9_]+)/i)
              : (kind === 'update' ? sql.match(/^update\s+([a-zA-Z0-9_]+)/i) : sql.match(/^delete\s+from\s+([a-zA-Z0-9_]+)/i));
          if (!m) return false;
          const n = m[1].toLowerCase();
          // 同名のテーブルがあればテーブルを優先（マテリアライズドビューは実表なので通常経路）
          return !this.tables[n] && !!this.views[n];
      },

      // 「単一表への射影＋選択だけの SELECT」を解析して基底表・列対応・選択条件を返す。
      // 更新可能ビューの判定と、結果グリッドの直接編集の判定で共有する。
      // opts.allowLimit を立てると LIMIT/OFFSET を許す（並び替えや件数制限は
      // 行と基底行の対応を壊さないため、グリッド編集では問題にならない）
      _analyzeSimpleSelect(body, opts) {
          const o = opts || {};
          const sm = [];
          let s = this._maskStrings(String(body).trim().replace(/;$/, ''), sm).trim();
          // ORDER BY は結果の並びだけを決めるので更新可能性に影響しない（実DBと同じ）
          const obAt = this._topLevelKeyword(s, 'ORDER BY');
          if (obAt !== -1) s = s.slice(0, obAt).trim();
          if (o.allowLimit) {
              s = s.replace(/\s+limit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\s*$/i, '')
                   .replace(/\s+offset\s+\d+(?:\s+rows?)?(?:\s+fetch\s+(?:first|next)\s+\d+\s+rows?\s+only)?\s*$/i, '')
                   .replace(/\s+fetch\s+(?:first|next)\s+\d+\s+rows?\s+(?:only|with\s+ties)\s*$/i, '')
                   .trim();
          }
          const blockers = [
              [/\bunion\b|\bintersect\b|\bexcept\b|\bminus\b/i, 'set operators'],
              [/^select\s+distinct\b/i, 'DISTINCT'],
              [/\bgroup\s+by\b/i, 'GROUP BY'],
              [/\bhaving\b/i, 'HAVING'],
              [/\bqualify\b/i, 'QUALIFY'],
              [/\bwindow\b/i, 'WINDOW'],
              [/\bjoin\b/i, 'JOIN'],
              [/\bover\s*\(/i, 'window functions']
          ];
          if (!o.allowLimit) blockers.push([/\blimit\b|\boffset\b|\bfetch\s+first\b/i, 'LIMIT/OFFSET']);
          for (const [re, what] of blockers) {
              if (re.test(s)) return { ok: false, reason: `it uses ${what}` };
          }
          const m = s.match(/^select\s+([\s\S]+?)\s+from\s+([a-zA-Z0-9_]+)\s*(?:(?:as\s+)?([a-zA-Z0-9_]+))?\s*(?:where\s+([\s\S]+))?$/i);
          if (!m) return { ok: false, reason: 'it is not a simple SELECT ... FROM <table> [WHERE ...]' };
          const selectClause = m[1].trim();
          const table = m[2].toLowerCase();
          const alias = m[3] && !/^where$/i.test(m[3]) ? m[3].toLowerCase() : null;
          const whereMasked = m[4] ? m[4].trim() : null;
          if (this.views[table] && !o.allowView) return { ok: false, reason: `nested views are not updatable ('${table}' is a view)` };
          const t = this.tables[table];
          if (!t && !(o.allowView && this.views[table])) return { ok: false, reason: `base table '${table}' not found` };
          // カンマ区切りの FROM（暗黙の結合）は単一表ではない
          if (/,/.test(m[2] + (m[3] || ''))) return { ok: false, reason: 'it reads multiple base tables' };
          // ビュー宛の編集はビュー側の列で判定する（実体は更新可能ビュー経路が処理する）
          const cols = t ? t.cols : null;

          // 列対応: 出力名 -> 基底表の列名。式・集約・定数は編集不可
          const colMap = Object.create(null);
          const items = this.splitSelectClause(selectClause).map(x => x.trim()).filter(x => x !== '');
          for (const item of items) {
              if (item === '*' || /^[a-zA-Z0-9_]+\s*\.\s*\*$/.test(item)) {
                  if (!cols) return { ok: false, reason: 'SELECT * over a view cannot be mapped' };
                  Object.keys(cols).forEach(c => { colMap[c] = c; });
                  continue;
              }
              const am = item.match(/^([\s\S]+?)(?:\s+as\s+([a-zA-Z0-9_]+)|\s+([a-zA-Z0-9_]+))?$/i);
              let expr = am[1].trim();
              const outName = (am[2] || am[3] || '').toLowerCase();
              // `t.col` / `alias.col` の修飾は剥がす
              const qm = expr.match(/^([a-zA-Z0-9_]+)\s*\.\s*([a-zA-Z0-9_]+)$/);
              if (qm) {
                  if (qm[1].toLowerCase() !== table && qm[1].toLowerCase() !== alias) {
                      return { ok: false, reason: `unknown table qualifier '${qm[1]}'` };
                  }
                  expr = qm[2];
              }
              if (!/^[a-zA-Z0-9_]+$/.test(expr) || (cols && !cols[expr.toLowerCase()])) {
                  return { ok: false, reason: `column '${item}' is not a plain base-table column` };
              }
              colMap[outName || expr.toLowerCase()] = expr.toLowerCase();
          }
          if (Object.keys(colMap).length === 0) return { ok: false, reason: 'there are no plain columns' };

          // WHERE 句の別名修飾は基底表名へ揃える（書き換え後の文で解決できるように）
          let where = whereMasked;
          if (where && alias) where = where.replace(new RegExp(`\\b${alias}\\s*\\.`, 'gi'), `${table}.`);
          if (where) where = this._restoreStrings(where, sm);
          return { ok: true, table, alias, colMap, where };
      },

      // ビュー定義を解析して基底表・列対応・選択条件を得る。
      // 更新できない形なら { updatable: false, reason } を返す（呼び出し側がエラー文にする）
      _analyzeUpdatableView(name) {
          const body = this.views[name];
          if (body === undefined) return { updatable: false, reason: `View '${name}' not found.` };
          const r = this._analyzeSimpleSelect(body);
          if (!r.ok) return { updatable: false, reason: r.reason.replace(/^it /, 'the view ') };
          const meta = (this.viewMeta && this.viewMeta[name]) || null;
          return { updatable: true, view: name, table: r.table, colMap: r.colMap, where: r.where,
                   checkOption: meta ? meta.checkOption : null };
      },

      // 結果グリッドの直接編集が可能かを判定する（UI から呼ぶ）。
      // 可能なら { editable: true, table, keyCols, colMap }、不可なら理由を返す。
      // 行を一意に特定できる列（主キー、単一列 UNIQUE、複合主キー）が結果に
      // 含まれていることを要求する — これが無いと UPDATE の対象行を決められない
      analyzeEditableSelect(sql) {
          const s = String(sql || '').trim().replace(/;$/, '');
          if (!/^select\b/i.test(s)) return { editable: false, reason: 'the result is not from a SELECT' };
          const r = this._analyzeSimpleSelect(s, { allowLimit: true, allowView: true });
          if (!r.ok) return { editable: false, reason: r.reason };
          // ビュー宛なら更新可能ビューかどうかを続けて確かめる
          let table = r.table, colMap = r.colMap;
          if (this.views[table]) {
              const vi = this._analyzeUpdatableView(table);
              if (!vi.updatable) return { editable: false, reason: vi.reason };
          }
          const t = this.tables[table] || this.tables[(this._analyzeUpdatableView(table) || {}).table];
          if (!t) return { editable: false, reason: `base table '${table}' not found` };
          // 出力名 -> 基底列名 の逆引き（キー列が結果に載っているか調べる）
          const outOf = (baseCol) => Object.keys(colMap).find(k => colMap[k] === baseCol);
          const compPk = (t.compositeKeys || []).find(ck => ck.isPK);
          let keyBase = null;
          if (t.primaryKey) keyBase = [t.primaryKey];
          else if (compPk) keyBase = [...compPk.cols];
          else if ((t.uniqueCols || []).length > 0) keyBase = [t.uniqueCols[0]];
          if (!keyBase) return { editable: false, reason: `'${table}' has no PRIMARY KEY or UNIQUE column to identify rows` };
          const keyCols = keyBase.map(outOf);
          if (keyCols.some(k => k === undefined)) {
              return { editable: false, reason: `include ${keyBase.join(', ')} in the result to edit rows` };
          }
          return { editable: true, table, keyCols, keyBase, colMap };
      },

      // ビュー列名 -> 基底表列名。未知の列名はビューに存在しないのでエラーにする
      _mapViewColumn(info, col) {
          const key = String(col).toLowerCase();
          const base = info.colMap[key];
          if (!base) throw new Error(`Column '${col}' not found in view '${info.view}'.`);
          return base;
      },

      // ビュー宛の式（WHERE / SET の右辺）に現れるビュー列名を基底表の列名へ置き換える。
      // `SELECT nm AS ename ...` のビューに `WHERE ename = 'x'` と書けるようにするため。
      // 1 回の replace で解決するので `SELECT b AS a, a AS b` のような入れ替えでも壊れない
      _mapViewExpr(info, text) {
          if (!text) return text;
          // 別名と基底名が全て同じなら書き換え不要
          const needs = Object.keys(info.colMap).some(k => info.colMap[k] !== k);
          if (!needs) return text;
          const sm = [];
          let s = this._maskStrings(text, sm);
          s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\b|\b([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?/g,
              (m, q, qc, bare, call) => {
                  if (q !== undefined) {
                      // ビュー名で修飾された参照は基底表名＋基底列名へ
                      if (q.toLowerCase() !== info.view) return m;
                      const base = info.colMap[qc.toLowerCase()];
                      return base ? `${info.table}.${base}` : m;
                  }
                  if (call) return m;   // 関数呼び出し名は触らない
                  const base = info.colMap[bare.toLowerCase()];
                  return (base && base !== bare.toLowerCase()) ? base : m;
              });
          return this._restoreStrings(s, sm);
      },

      // 二つの条件を AND で結ぶ（片方が無ければもう片方をそのまま返す）
      _andConditions(a, b) {
          if (!a) return b || null;
          if (!b) return a;
          return `(${a}) AND (${b})`;
      },

      // WITH CHECK OPTION: 変更後の行がビューの WHERE を満たすか検証する。
      // 満たさない行が 1 つでもあれば、基底表を変更前のクローンへ戻して失敗させる
      // （式評価は行単位でしか行えないため、事前検証ではなく「実行して検証して戻す」方式。
      //   クローンのコストは CHECK OPTION 付きビューへの書き込み時だけ発生する）
      _assertViewCheckOption(info, savedClone) {
          if (!info.checkOption || !info.where) return;
          const t = this.tables[info.table];
          const sm = [];
          const fn = this.compileCondition(this._maskStrings(info.where, sm), sm);
          const aliases = { [info.table]: info.table };
          for (let i = 0; i < t.rowCount; i++) {
              let ok;
              try { ok = fn({ [info.table]: i }, this.tables, aliases); } catch (e) { ok = false; }
              if (!ok) {
                  // ビュー外の行が「元からあった行」なら違反ではない。変更前と同じ行数・
                  // 同じ値なら触っていないので、クローンと突き合わせて判定する
                  if (savedClone && i < savedClone.rowCount && this._rowsEqual(savedClone, t, i)) continue;
                  if (savedClone) this.tables[info.table] = savedClone;
                  throw new Error(`CHECK OPTION failed for view '${info.view}': the resulting row is outside the view definition.`);
              }
          }
      },

      // 2つの表オブジェクトの同一行インデックスの内容が等しいか（CHECK OPTION 判定用）
      _rowsEqual(a, b, idx) {
          for (const c of Object.keys(b.cols)) {
            if (!a.cols[c]) return false;
            const va = a.getValue(c, idx), vb = b.getValue(c, idx);
            if (va !== vb && !(va === null && vb === null)) return false;
          }
          return true;
      },

      // ビューに対する INSTEAD OF トリガーがあれば発火して true を返す。
      // これがあるビューは（集約や結合を含んでいても）書き込み可能になる
      _fireInsteadOfTriggers(event, view, rows) {
          if (!this.triggers) return false;
          const list = [];
          for (const nm in this.triggers) {
              const tg = this.triggers[nm];
              if (tg.table === view && tg.timing === 'instead of' && tg.event === event) list.push(tg);
          }
          if (list.length === 0) return false;
          this._fireTriggers('instead of', event, view, rows);
          return true;
      },

      // ビュー宛の INSERT / UPDATE / DELETE を基底表宛へ書き換えて実行する。
      // 呼び出し元（executeQuery のディスパッチ）は対象がビューのときだけここへ来る
      _executeViewDml(kind, sql, strMap) {
          const nameM = kind === 'insert'
              ? sql.match(/^(?:insert|replace)\s+(?:ignore\s+)?into\s+([a-zA-Z0-9_]+)/i)
              : (kind === 'update' ? sql.match(/^update\s+([a-zA-Z0-9_]+)/i) : sql.match(/^delete\s+from\s+([a-zA-Z0-9_]+)/i));
          const view = nameM[1].toLowerCase();
          const info = this._analyzeUpdatableView(view);

          // INSTEAD OF トリガーがあれば、更新可能性を問わずそちらへ委譲する
          const io = this._insteadOfRowsFor(kind, view, sql, info, strMap);
          if (io) return io;

          if (!info.updatable) {
              throw new Error(`View '${view}' is not updatable: ${info.reason}. Define an INSTEAD OF trigger to make it writable.`);
          }
          const needsCheck = !!(info.checkOption && info.where);
          const saved = needsCheck ? this.tables[info.table].cloneFull() : null;
          let rewritten;
          if (kind === 'insert') {
              rewritten = this._rewriteViewInsert(sql, info);
          } else if (kind === 'update') {
              rewritten = this._rewriteViewUpdate(sql, info);
          } else {
              rewritten = this._rewriteViewDelete(sql, info);
          }
          const res = kind === 'insert' ? this._executeInsert(rewritten, strMap)
                    : (kind === 'update' ? this._executeUpdate(rewritten, strMap) : this._executeDelete(rewritten, strMap));
          // DELETE は行がビューから出るだけなので CHECK OPTION の検証は不要
          if (needsCheck && kind !== 'delete') this._assertViewCheckOption(info, saved);
          return res;
      },

      // INSTEAD OF トリガー用に「発火行」を組み立てて発火する。
      // 定義が無ければ null を返す（通常の書き換え経路へ進む）
      _insteadOfRowsFor(kind, view, sql, info, strMap) {
          const has = Object.keys(this.triggers || {}).some(nm => {
              const tg = this.triggers[nm];
              return tg.table === view && tg.timing === 'instead of' && tg.event === kind;
          });
          if (!has) return null;
          let rows;
          if (kind === 'insert') {
              // VALUES の各行を NEW として渡す（列名はビューの列名のまま）
              const parsed = this._parseInsertValuesForTrigger(sql, strMap);
              rows = parsed.map(r => ({ oldRow: null, newRow: r }));
          } else {
              // 対象行はビューを SELECT して取り出す（更新不可なビューでも SELECT はできる）。
              // ビュー展開はトップレベルの executeQuery でしか走らないため、文字列リテラルを
              // 戻してから独立した文として実行する。外側の文が持つ相関レジストリは退避する
              const whereM = sql.match(/\swhere\s+([\s\S]+)$/i);
              const q = `SELECT * FROM ${view}` + (whereM ? ` WHERE ${this._restoreStrings(whereM[1], strMap)}` : '');
              const savedCorr = this._corrSubs;
              let sel;
              try { sel = this.executeQuery(q); } finally { this._corrSubs = savedCorr; }
              if (sel.error) throw new Error(sel.error);
              if (kind === 'delete') {
                  rows = sel.data.map(r => ({ oldRow: r, newRow: null }));
              } else {
                  // UPDATE: SET 句を適用した予定値を NEW として渡す
                  const setM = sql.match(/^update\s+[a-zA-Z0-9_]+\s+set\s+([\s\S]+?)(?:\s+where\s+[\s\S]+)?$/i);
                  if (!setM) throw new Error("Syntax Error in UPDATE.");
                  const assigns = this.splitSelectClause(setM[1]).map(part => {
                      const eq = part.indexOf('=');
                      if (eq === -1) throw new Error("Syntax Error in SET clause.");
                      return { col: part.slice(0, eq).trim().replace(/^[a-zA-Z0-9_]+\s*\.\s*/, '').toLowerCase(), expr: part.slice(eq + 1).trim() };
                  });
                  rows = sel.data.map(r => {
                      const nr = Object.assign(Object.create(null), r);
                      // 右辺はビュー行の現在値を差し込んで評価する（`qty = qty + 1` も書ける）
                      assigns.forEach(a => { nr[a.col] = this._constExprValue(a.expr, strMap, r); });
                      return { oldRow: r, newRow: nr };
                  });
              }
          }
          if (rows.length === 0) return { data: [{ Result: 'Success', Message: '0 rows affected (INSTEAD OF trigger).' }], affectedRows: 0 };
          this._fireInsteadOfTriggers(kind, view, rows);
          return { data: [{ Result: 'Success', Message: `${rows.length} rows affected (INSTEAD OF trigger).` }], affectedRows: rows.length };
      },

      // INSTEAD OF UPDATE の SET 式を、対象行の値を差し込んだうえで評価する
      _constExprValue(expr, strMap, row) {
          const sm = [];
          let text = this._maskStrings(expr, sm);
          // 式に現れる列名はビュー行の現在値へ置換する（NEW.x の算出に使う）
          text = text.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (mm, id) => {
              const k = id.toLowerCase();
              if (!(k in row)) return mm;
              const v = row[k];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return `(${v})`;
              if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
              sm.push(this._quoteLiteral(String(v)));
              return `__STR_${sm.length - 1}__`;
          });
          const fn = this.compileCondition(text, sm);
          return fn({}, this.tables, {});
      },

      // INSTEAD OF INSERT 用に VALUES 句を行オブジェクトへ展開する
      _parseInsertValuesForTrigger(sql, strMap) {
          const m = sql.match(/^(?:insert|replace)\s+(?:ignore\s+)?into\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?\s*values\s*([\s\S]+)$/i);
          if (!m) throw new Error("INSTEAD OF INSERT triggers require INSERT ... VALUES (...).");
          const view = m[1].toLowerCase();
          let cols = m[2] ? m[2].split(',').map(c => c.trim().toLowerCase()) : null;
          if (!cols) {
              const info = this._analyzeUpdatableView(view);
              cols = info.updatable ? Object.keys(info.colMap) : null;
              if (!cols) throw new Error(`INSERT into view '${view}' requires an explicit column list.`);
          }
          const rows = [];
          let rest = m[3].trim();
          for (let guard = 0; guard < 10000 && rest.length > 0; guard++) {
              const open = rest.indexOf('(');
              if (open === -1) break;
              const close = this._scanBalanced(rest, open);
              if (close === -1) throw new Error("Syntax Error in VALUES clause.");
              const vals = this.splitSelectClause(rest.slice(open + 1, close));
              if (vals.length !== cols.length) throw new Error(`VALUES has ${vals.length} values but ${cols.length} columns were given.`);
              const row = Object.create(null);
              cols.forEach((c, i) => { row[c] = this.compileCondition(vals[i].trim(), strMap)({}, this.tables, {}); });
              rows.push(row);
              rest = rest.slice(close + 1).replace(/^\s*,\s*/, '');
          }
          return rows;
      },

      // INSERT INTO view (a, b) VALUES ... -> INSERT INTO base (mapped_a, mapped_b) VALUES ...
      _rewriteViewInsert(sql, info) {
          const m = sql.match(/^((?:insert|replace)\s+(?:ignore\s+)?into\s+)([a-zA-Z0-9_]+)(\s*)(?:\(([^)]*)\))?([\s\S]*)$/i);
          if (!m) throw new Error("Syntax Error in INSERT.");
          let colList;
          if (m[4]) {
              colList = this.splitSelectClause(m[4]).map(c => this._mapViewColumn(info, c.trim()));
          } else {
              // 列リスト省略時はビューの列順を使う（基底表の全列ではない）
              colList = Object.keys(info.colMap).map(c => info.colMap[c]);
          }
          return `${m[1]}${info.table} (${colList.join(', ')})${m[5]}`;
      },

      // UPDATE view SET a = x WHERE p -> UPDATE base SET mapped_a = x WHERE (view where) AND (p)
      _rewriteViewUpdate(sql, info) {
          const m = sql.match(/^update\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i);
          if (!m) throw new Error("Syntax Error in UPDATE.");
          const setParts = this.splitSelectClause(m[2]).map(part => {
              const eq = part.indexOf('=');
              if (eq === -1) throw new Error("Syntax Error in SET clause.");
              const col = part.slice(0, eq).trim().replace(/^[a-zA-Z0-9_]+\s*\.\s*/, '');
              // 右辺の式にもビュー列名が現れ得る（`SET ename = ename || '!'`）
              return `${this._mapViewColumn(info, col)} = ${this._mapViewExpr(info, part.slice(eq + 1).trim())}`;
          });
          const where = this._andConditions(info.where, m[3] ? this._mapViewExpr(info, m[3].trim()) : null);
          return `UPDATE ${info.table} SET ${setParts.join(', ')}` + (where ? ` WHERE ${where}` : '');
      },

      // DELETE FROM view WHERE p -> DELETE FROM base WHERE (view where) AND (p)
      _rewriteViewDelete(sql, info) {
          const m = sql.match(/^delete\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([\s\S]+))?$/i);
          if (!m) throw new Error("Syntax Error in DELETE.");
          const where = this._andConditions(info.where, m[2] ? this._mapViewExpr(info, m[2].trim()) : null);
          return `DELETE FROM ${info.table}` + (where ? ` WHERE ${where}` : '');
      },

      // 制約検証用の値正規化: 数値型列に与えられた数値文字列は setValue で数値へ
      // キャストされて格納されるため、検証時も同じ表現（数値）へ揃える。
      // （揃えないと '2' と 2 が別値と判定され、UNIQUE すり抜けや FK 誤検出が起きる）
      _normalizeByColType(tData, col, v) {
          const ct = tData.colTypes[col];
          if ((ct === 'INTEGER' || ct === 'FLOAT') && typeof v === 'string' && v.trim() !== '' && !isNaN(v)) return Number(v);
          return v;
      },

      // INSERT 前処理: DEFAULT 補完 / AUTO_INCREMENT 採番 / NOT NULL 検証
      // cols を拡張した新しい配列を返し、valuesList の各行を同じ長さに拡張する
      _applyRowDefaults(tData, cols, valuesList) {
          const extraCols = [];
          const defaults = tData.defaults || {};
          for (const col in defaults) {
              if (cols.indexOf(col) === -1) {
                  const dv = defaults[col];
                  // DEFAULT CURRENT_TIMESTAMP / 式 DEFAULT は挿入時点で解決する。
                  // 式は行ごとに評価する必要がある（NEXTVAL は行ごとに違う値を返す）
                  extraCols.push({ col, val: dv, perRow: this._isNowMarker(dv) || this._isExprDefault(dv) });
              }
          }
          const ai = tData.autoIncrementCol;
          let aiNext = null;
          if (ai) {
              let maxId = 0;
              for (let i = 0; i < tData.rowCount; i++) {
                  const v = tData.getValue(ai, i);
                  if (typeof v === 'number' && v > maxId) maxId = v;
              }
              // TRUNCATE ... CONTINUE IDENTITY で覚えた下限があればそちらを優先する
              aiNext = Math.max(maxId + 1, tData.identityFloor || 1);
              if (cols.indexOf(ai) === -1 && !extraCols.some(e => e.col === ai)) {
                  extraCols.push({ col: ai, val: null });
              }
          }
          const newCols = cols.concat(extraCols.map(e => e.col));
          const aiIdx = ai ? newCols.indexOf(ai) : -1;
          valuesList.forEach(vals => {
              extraCols.forEach(e => vals.push(e.perRow ? this._resolveDefaultValue(e.val) : e.val));
              if (aiIdx !== -1) {
                  if (vals[aiIdx] === null || vals[aiIdx] === undefined) vals[aiIdx] = aiNext++;
                  else if (typeof vals[aiIdx] === 'number' && vals[aiIdx] >= aiNext) aiNext = vals[aiIdx] + 1;
              }
              (tData.notNullCols || []).forEach(nc => {
                  const i = newCols.indexOf(nc);
                  const v = i === -1 ? null : vals[i];
                  if (v === null || v === undefined) throw new Error(`NOT NULL constraint failed: Column '${nc}' cannot be NULL.`);
              });
          });
          return newCols;
      },

      // ============ 外部キー: 単一列と複合列を同じ経路で扱うための補助 ============
      // FK は単一列のとき { col, refCol }、複合列のとき { cols: [...], refCols: [...] } を
      // 持つ。既存のダンプ（単一列形）をそのまま読めるよう、参照側は必ずこの2つを通す
      _fkCols(fk) { return fk.cols || [fk.col]; },
      _fkRefCols(fk) { return fk.refCols || [fk.refCol]; },
      _fkLabel(fk) { return `${fk.refTable}(${this._fkRefCols(fk).join(', ')})`; },
      _fkChildLabel(tblName, fk) { return `${tblName}(${this._fkCols(fk).join(', ')})`; },

      // 参照先で「タプルが一致する行」を探す。先頭列はインデックスで絞り、
      // 残りの列は取得した候補行だけを突き合わせる（複合でも索引が効く）
      _fkMatchRows(refTbl, refCols, vals) {
          const rows = refTbl.findValueRows(refCols[0], vals[0]);
          if (refCols.length === 1 || rows.length === 0) return rows;
          return rows.filter(r => refCols.every((c, i) => refTbl.getValue(c, r) === vals[i]));
      },

      // FK のタプル。いずれかが NULL なら制約は満たされたものとする（SQL標準の MATCH SIMPLE）
      _fkTupleOrNull(get, cols) {
          const out = [];
          for (const c of cols) {
              const v = get(c);
              if (v === null || v === undefined) return null;
              out.push(v);
          }
          return out;
      },

      // INSERT 時の FK 存在チェック（INSERT VALUES / INSERT SELECT 共用）
      _checkInsertFKs(tData, cols, valuesList) {
          // SET FOREIGN_KEY_CHECKS = 0 のあいだは検査しない（取り込み・相互参照の逃げ道）
          if (this.fkChecksEnabled === false) return;
          if (!tData.foreignKeys || tData.foreignKeys.length === 0) return;
          tData.foreignKeys.forEach(fk => {
              const refTbl = this.tables[fk.refTable];
              if (!refTbl) throw new Error(`Foreign key constraint failed: Table '${fk.refTable}' not found.`);
              const fkCols = this._fkCols(fk), refCols = this._fkRefCols(fk);
              const colIdxs = fkCols.map(c => cols.indexOf(c));
              // 1列も指定されていなければ全て既定値（＝NULL 扱い）なので検査不要
              if (colIdxs.every(i => i === -1)) return;
              // 自己参照 FK: 同一バッチ内で挿入される参照先タプルも有効とみなす。
              // （ツリー/階層データを 1 文でまとめて投入するケースに対応）
              let batchRefVals = null;
              if (refTbl === tData) {
                  const refIdxs = refCols.map(c => cols.indexOf(c));
                  batchRefVals = new Set();
                  if (refIdxs.every(i => i !== -1)) valuesList.forEach(vals => {
                      const tup = refIdxs.map(i => vals[i]);
                      if (tup.every(v => v !== null && v !== undefined)) batchRefVals.add(JSON.stringify(tup));
                  });
              }
              valuesList.forEach(vals => {
                  const tuple = this._fkTupleOrNull(
                      (c) => { const i = cols.indexOf(c); return i === -1 ? null : vals[i]; }, fkCols);
                  if (tuple === null) return;   // NULL を含むタプルは検査対象外
                  const norm = tuple.map((v, i) => this._normalizeByColType(tData, fkCols[i], v));
                  if (this._fkMatchRows(refTbl, refCols, norm).length > 0) return;
                  if (batchRefVals && batchRefVals.has(JSON.stringify(norm))) return;
                  throw new Error(`Foreign key constraint failed: Value '${norm.join(', ')}' not found in ${this._fkLabel(fk)}`);
              });
          });
      },

      // 一意性検査で使う「比較用の値」。列に照合順序があれば正規化する
      _uniqKey(tData, col, val) {
          const coll = tData.collations && tData.collations[col];
          return coll ? this._collateValue(val, coll) : val;
      },
      // col = val に一致する行番号。照合順序がある列は索引が生値で作られているため
      // 索引を使わず全走査して正規化後の値どうしで突き合わせる
      _uniqRows(tData, col, val) {
          const coll = tData.collations && tData.collations[col];
          if (!coll) return tData.findValueRows(col, val);
          const target = this._collateValue(val, coll);
          const out = [];
          for (let i = 0; i < tData.rowCount; i++) {
              const v = tData.getValue(col, i);
              if (v === null || v === undefined) continue;
              if (this._collateValue(v, coll) === target) out.push(i);
          }
          return out;
      },

      // 複合 UNIQUE / PRIMARY KEY のタプル重複チェック（INSERT 用）。
      // タプルのいずれかが NULL の行は UNIQUE では対象外（SQL標準）、PK では拒否
      _checkCompositeInsert(tData, cols, valuesList) {
          (tData.compositeKeys || []).forEach(ck => {
              const label = ck.isPK ? 'PRIMARY KEY' : 'UNIQUE';
              const idxs = ck.cols.map(c => cols.indexOf(c));
              const existing = new Set();
              for (let i = 0; i < tData.rowCount; i++) {
                  const tup = ck.cols.map(c => tData.getValue(c, i));
                  if (tup.some(v => v === null || v === undefined)) continue;
                  existing.add(JSON.stringify(tup.map((v, j) => this._uniqKey(tData, ck.cols[j], v))));
              }
              const batchSeen = new Set();
              valuesList.forEach(vals => {
                  const tup = ck.cols.map((c, j) => {
                      let v = idxs[j] === -1 ? null : vals[idxs[j]];
                      if (v !== null && v !== undefined) v = this._normalizeByColType(tData, c, v);
                      return v;
                  });
                  if (tup.some(v => v === null || v === undefined)) {
                      if (ck.isPK) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in composite key (${ck.cols.join(', ')}).`);
                      return;
                  }
                  const sig = JSON.stringify(tup.map((v, j) => this._uniqKey(tData, ck.cols[j], v)));
                  if (batchSeen.has(sig) || existing.has(sig)) {
                      throw new Error(`${label} constraint failed: Duplicate value (${tup.join(', ')}) in (${ck.cols.join(', ')}).`);
                  }
                  batchSeen.add(sig);
              });
          });
      },

      // INSERT 時の UNIQUE / PRIMARY KEY 制約チェック（適用前に一括検証）
      _checkInsertConstraints(tData, cols, valuesList) {
          this._checkCompositeInsert(tData, cols, valuesList);
          const pk = tData.primaryKey;
          const uniqueSet = new Set(tData.uniqueCols || []);
          if (pk) uniqueSet.add(pk);
          if (uniqueSet.size === 0) return;
          // AUTO_INCREMENT の PK は自動採番されるため必須チェックを免除
          if (valuesList.length > 0 && pk && cols.indexOf(pk) === -1 && pk !== tData.autoIncrementCol) {
              throw new Error(`PRIMARY KEY constraint failed: Column '${pk}' is required.`);
          }
          uniqueSet.forEach(col => {
              const colIdx = cols.indexOf(col);
              if (colIdx === -1) return;
              const label = col === pk ? 'PRIMARY KEY' : 'UNIQUE';
              const batchSeen = new Set();
              valuesList.forEach(vals => {
                  let val = vals[colIdx];
                  if (val === null || val === undefined) {
                      if (col === pk) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${col}'.`);
                      return;
                  }
                  const cType = tData.colTypes[col];
                  if ((cType === 'INTEGER' || cType === 'FLOAT') && typeof val === 'string' && val.trim() !== '' && !isNaN(val)) val = Number(val);
                  const ukey = this._uniqKey(tData, col, val);
                  if (batchSeen.has(ukey)) throw new Error(`${label} constraint failed: Duplicate value '${val}' in column '${col}'.`);
                  batchSeen.add(ukey);
                  if (this._uniqRows(tData, col, val).length > 0) {
                      throw new Error(`${label} constraint failed: Value '${val}' already exists in column '${col}'.`);
                  }
              });
          });
      },

      // 生成列 (GENERATED ALWAYS AS) の式を1度コンパイルする。
      // insertCols/changeCols に生成列が含まれていたら「明示指定不可」としてエラーにする
      _compileGeneratedCols(tData, providedCols) {
          if (!tData.generatedCols) return [];
          const names = Object.keys(tData.generatedCols);
          if (names.length === 0) return [];
          if (providedCols) {
              names.forEach(gc => {
                  if (providedCols.indexOf(gc) !== -1) throw new Error(`Cannot assign to generated column '${gc}'.`);
              });
          }
          return names.map(gc => {
              const sm = [];
              return { col: gc, fn: this.compileCondition(this._maskStrings(tData.generatedCols[gc], sm), sm) };
          });
      },

      // 指定行 idx の生成列を評価して書き込む（他の列が確定した後に呼ぶ）
      _applyGeneratedCols(table, tData, genFns, idx) {
          if (!genFns || genFns.length === 0) return;
          const aliases = { [table]: table };
          genFns.forEach(g => {
              let v;
              try { v = g.fn({ [table]: idx }, this.tables, aliases); }
              catch (e) { throw new Error(`Generated column '${g.col}': ${e.message}`); }
              tData.setValue(g.col, idx, v === undefined ? null : v);
          });
      },

      // CHECK 制約をコンパイルする（保存済みの式テキストを都度マスクして compileCondition へ）
      _compileChecks(tData) {
          if (!tData.checks || tData.checks.length === 0) return [];
          return tData.checks.map(chk => {
              const sm = [];
              const fn = this.compileCondition(this._maskStrings(chk.expr, sm), sm);
              return { label: chk.name || chk.expr, fn };
          });
      },

      // 指定行 idx が全 CHECK を満たすか検証する（式が真値でなければ違反として throw）
      _validateChecksAt(table, tData, checkFns, idx) {
          if (!checkFns || checkFns.length === 0) return;
          const aliases = { [table]: table };
          for (const chk of checkFns) {
              let ok; try { ok = chk.fn({ [table]: idx }, this.tables, aliases); } catch (e) { ok = false; }
              // SQL の CHECK は「偽のときだけ」違反。UNKNOWN(NULL) は通す。
              // 従来は NULL を偽として扱っていたため、`b INT CHECK (b > 0)` の b を
              // 省略した INSERT が必ず失敗し、NULL 可の CHECK 列が使えなかった
              if (ok === null || ok === undefined) continue;
              if (!ok) throw new Error(`CHECK constraint failed: '${chk.label}'`);
          }
      },

      // UPDATE / ODKU 用: pending の変更を一時適用して CHECK を検証し、必ず元へ戻す。
      // （compileCondition が列値を getValue 経由で読むため、値を一時反映して評価する）
      _validateChecksForChanges(table, pending) {
          const tData = this.tables[table];
          const checkFns = this._compileChecks(tData);
          if (checkFns.length === 0) return;
          const aliases = { [table]: table };
          for (const { idx, changes } of pending) {
              const prev = {};
              for (const c in changes) prev[c] = tData.getValue(c, idx);
              let violated = null;
              try {
                  for (const c in changes) tData.setValue(c, idx, changes[c]);
                  for (const chk of checkFns) {
                      let ok; try { ok = chk.fn({ [table]: idx }, this.tables, aliases); } catch (e) { ok = false; }
                      // INSERT 側と同じく UNKNOWN(NULL) は違反にしない
                      if (ok === null || ok === undefined) continue;
                      if (!ok) { violated = chk.label; break; }
                  }
              } finally {
                  for (const c in prev) tData.setValue(c, idx, prev[c]);
              }
              if (violated !== null) throw new Error(`CHECK constraint failed: '${violated}'`);
          }
      },

      // DELETE に伴う FK 参照アクション（ON DELETE）を計画・適用する。
      // rootTable の rootIndices 削除を起点に子へ CASCADE / SET NULL を再帰的に波及させ、
      // RESTRICT / NO ACTION 違反があれば一切変更せず throw する（原子性）。
      // rootTable 自身の物理削除もここで行う（呼び出し側で COW 済みであること）。
      _applyDeleteReferentialActions(rootTable, rootIndices) {
          const deletePlan = Object.create(null); // table -> Set(rowIdx)
          const nullPlan = Object.create(null);   // table -> Map(rowIdx -> Set(col))
          const defaultPlan = Object.create(null); // table -> Map(rowIdx -> Map(col -> value))
          const getDel = (t) => deletePlan[t] || (deletePlan[t] = new Set());
          const getNull = (t) => nullPlan[t] || (nullPlan[t] = new Map());
          const getDefault = (t) => defaultPlan[t] || (defaultPlan[t] = new Map());

          rootIndices.forEach(i => getDel(rootTable).add(i));
          const queue = [[rootTable, rootIndices]];
          let guard = 0;
          while (queue.length > 0) {
              if (++guard > 1000000) throw new Error("Referential cascade too deep or cyclic.");
              const [tbl, indices] = queue.shift();
              const tData = this.tables[tbl];
              for (const otherName in this.tables) {
                  const child = this.tables[otherName];
                  if (!child.foreignKeys || child.foreignKeys.length === 0) continue;
                  for (const fk of child.foreignKeys) {
                      if (fk.refTable !== tbl) continue;
                      const action = (fk.onDelete || 'RESTRICT').toUpperCase();
                      const fkCols = this._fkCols(fk), refCols = this._fkRefCols(fk);
                      // 削除される親行のタプル一覧（NULL を含むものは参照され得ない）
                      const tuples = [];
                      indices.forEach(idx => {
                          const t = this._fkTupleOrNull((c) => tData.getValue(c, idx), refCols);
                          if (t !== null) tuples.push(t);
                      });
                      if (tuples.length === 0) continue;
                      const childRows = [];
                      tuples.forEach(t => this._fkMatchRows(child, fkCols, t).forEach(r => childRows.push(r)));
                      if (childRows.length === 0) continue;
                      if (action === 'CASCADE') {
                          const dset = getDel(otherName);
                          const newly = [];
                          childRows.forEach(r => { if (!dset.has(r)) { dset.add(r); newly.push(r); } });
                          if (newly.length > 0) queue.push([otherName, newly]);
                      } else if (action === 'SET NULL') {
                          // NOT NULL 列への SET NULL は矛盾するため、変更前（計画段階）に拒否する
                          const nn = fkCols.find(c => (child.notNullCols || []).includes(c));
                          if (nn) {
                              throw new Error(`Foreign key constraint failed: ON DELETE SET NULL conflicts with NOT NULL on ${otherName}(${nn})`);
                          }
                          const nmap = getNull(otherName);
                          childRows.forEach(r => {
                              let s = nmap.get(r); if (!s) { s = new Set(); nmap.set(r, s); }
                              fkCols.forEach(c => s.add(c));
                          });
                      } else if (action === 'SET DEFAULT') {
                          // 既定値へ戻す。戻した値自体が親に無ければ参照が壊れるので計画段階で拒否する
                          const hasDef = fkCols.map(c => (child.defaults || {})[c] !== undefined);
                          const defs = fkCols.map((c, i) => hasDef[i] ? this._resolveDefaultValue(child.defaults[c]) : undefined);
                          if (defs.some(v => v === undefined)) {
                              const miss = fkCols[defs.findIndex(v => v === undefined)];
                              throw new Error(`Foreign key constraint failed: ON DELETE SET DEFAULT requires a DEFAULT on ${otherName}(${miss})`);
                          }
                          if (!defs.every(v => v === null)) {
                              const parent = this.tables[fk.refTable];
                              const norm = defs.map((v, i) => this._normalizeByColType(child, fkCols[i], v));
                              if (parent && this._fkMatchRows(parent, refCols, norm).length === 0) {
                                  throw new Error(`Foreign key constraint failed: ON DELETE SET DEFAULT would leave '${norm.join(', ')}' unmatched in ${this._fkLabel(fk)}`);
                              }
                          }
                          const dmap = getDefault(otherName);
                          childRows.forEach(r => {
                              let m2 = dmap.get(r); if (!m2) { m2 = new Map(); dmap.set(r, m2); }
                              fkCols.forEach((c, i) => m2.set(c, defs[i]));
                          });
                      } else {
                          throw new Error(`Foreign key constraint failed: Cannot delete record referenced by ${this._fkChildLabel(otherName, fk)}`);
                      }
                  }
              }
          }

          // 適用1: SET NULL（削除予定でない行のみ）
          for (const t in nullPlan) {
              const tData = this.tables[t];
              const dset = deletePlan[t];
              let cowed = false;
              nullPlan[t].forEach((cols, r) => {
                  if (dset && dset.has(r)) return;
                  if (!cowed) { this._cowColumns(t, 'ALL'); cowed = true; }
                  cols.forEach(c => tData.setValue(c, r, null));
              });
          }
          // 適用1b: SET DEFAULT（削除予定でない行のみ）
          for (const t in defaultPlan) {
              const tData = this.tables[t];
              const dset = deletePlan[t];
              let cowed2 = false;
              defaultPlan[t].forEach((cols, r) => {
                  if (dset && dset.has(r)) return;
                  if (!cowed2) { this._cowColumns(t, 'ALL'); cowed2 = true; }
                  cols.forEach((v, c) => tData.setValue(c, r, this._normalizeByColType(tData, c, v)));
              });
          }
          // 適用2: 物理削除（root 以外は COW してから）
          for (const t in deletePlan) {
              const idxs = [...deletePlan[t]];
              if (idxs.length === 0) continue;
              if (t !== rootTable) this._cowColumns(t, 'ALL');
              this._removeRows(this.tables[t], idxs);
          }
      },

      // UPDATE / ON DUPLICATE KEY UPDATE 共用の変更検証。
      // pending: [{ idx, changes }] を FK 存在 / NOT NULL / UNIQUE(PK) について適用前に検証する。
      // バッチ内で複数行が同じ一意値へ更新される衝突も検出する
      // opts.skipFk: FK 存在チェックだけを飛ばす。FK ON UPDATE CASCADE の波及値を
      // 「親を書く前に」子の CHECK / NOT NULL / UNIQUE へ通したいときに使う
      // （親の新しい値はまだ存在しないので、FK 存在チェックだけは必ず失敗してしまう。
      //   波及値は定義上その親を指すので、FK は検査しなくても壊れない）
      _validatePendingChanges(tData, pending, opts) {
          // FK 存在チェック。複合 FK では「変更後の行のタプル全体」で参照先を引く必要があるため、
          // changes に無い列は現在値を使って組み立てる（idx が無い経路では検査を単一列に留める）
          if (!(opts && opts.skipFk) && this.fkChecksEnabled !== false
              && tData.foreignKeys && tData.foreignKeys.length > 0) {
              pending.forEach(({ idx, changes }) => {
                  tData.foreignKeys.forEach(fk => {
                      const fkCols = this._fkCols(fk);
                      // FK を構成する列が1つも変わらないなら参照は壊れない
                      if (!fkCols.some(c => c in changes)) return;
                      const refTbl = this.tables[fk.refTable];
                      if (!refTbl) throw new Error(`Foreign key constraint failed: Table '${fk.refTable}' not found.`);
                      const tuple = this._fkTupleOrNull(
                          (c) => (c in changes) ? changes[c] : (idx === undefined ? null : tData.getValue(c, idx)), fkCols);
                      if (tuple === null) return;   // NULL を含むタプルは検査対象外
                      const norm = tuple.map((v, i) => this._normalizeByColType(tData, fkCols[i], v));
                      if (this._fkMatchRows(refTbl, this._fkRefCols(fk), norm).length === 0) {
                          throw new Error(`Foreign key constraint failed: Value '${norm.join(', ')}' not found in ${this._fkLabel(fk)}`);
                      }
                  });
              });
          }

          // NOT NULL チェック
          pending.forEach(({ changes }) => {
              (tData.notNullCols || []).forEach(nc => {
                  if (nc in changes && (changes[nc] === null || changes[nc] === undefined)) {
                      throw new Error(`NOT NULL constraint failed: Column '${nc}' cannot be NULL.`);
                  }
              });
          });

          // 複合 UNIQUE / PRIMARY KEY チェック（更新後の最終状態で一意性を検証する）
          (tData.compositeKeys || []).forEach(ck => {
              if (!pending.some(p => ck.cols.some(c => c in p.changes))) return;
              const label = ck.isPK ? 'PRIMARY KEY' : 'UNIQUE';
              const targetSet2 = new Set(pending.map(p => p.idx));
              const existing = new Set();
              for (let i = 0; i < tData.rowCount; i++) {
                  if (targetSet2.has(i)) continue;
                  const tup = ck.cols.map(c => tData.getValue(c, i));
                  if (tup.some(v => v === null || v === undefined)) continue;
                  existing.add(JSON.stringify(tup.map((v, j) => this._uniqKey(tData, ck.cols[j], v))));
              }
              pending.forEach(({ idx, changes }) => {
                  const tup = ck.cols.map(c => {
                      let v = (c in changes) ? changes[c] : tData.getValue(c, idx);
                      if (v !== null && v !== undefined) v = this._normalizeByColType(tData, c, v);
                      return v;
                  });
                  if (tup.some(v => v === null || v === undefined)) {
                      if (ck.isPK && ck.cols.some(c => c in changes)) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in composite key (${ck.cols.join(', ')}).`);
                      return;
                  }
                  const sig = JSON.stringify(tup.map((v, j) => this._uniqKey(tData, ck.cols[j], v)));
                  if (existing.has(sig)) throw new Error(`${label} constraint failed: Duplicate value (${tup.join(', ')}) in (${ck.cols.join(', ')}).`);
                  existing.add(sig);
              });
          });

          // UNIQUE / PRIMARY KEY チェック（更新後の最終状態で一意性を検証する）
          const pkCol = tData.primaryKey;
          const uniqueCheckCols = new Set(tData.uniqueCols || []);
          if (pkCol) uniqueCheckCols.add(pkCol);
          const targetSet = new Set(pending.map(p => p.idx));
          uniqueCheckCols.forEach(col => {
              if (!pending.some(p => col in p.changes)) return;
              const label = col === pkCol ? 'PRIMARY KEY' : 'UNIQUE';

              // 単一行の検証はインデックスを活かせる findValueRows で行う
              if (pending.length === 1) {
                  const { idx, changes } = pending[0];
                  const v = this._normalizeByColType(tData, col, (col in changes) ? changes[col] : tData.getValue(col, idx));
                  if (v === null || v === undefined) {
                      if (col === pkCol && (col in changes)) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${col}'.`);
                      return;
                  }
                  if (this._uniqRows(tData, col, v).some(r => r !== idx)) {
                      throw new Error(`${label} constraint failed: Value '${v}' already exists in column '${col}'.`);
                  }
                  return;
              }

              // バッチ検証: 対象外の既存行の値を登録してから、各行の更新後の値を突き合わせる
              const valToRow = new Map();
              for (let i = 0; i < tData.rowCount; i++) {
                  if (targetSet.has(i)) continue;
                  const v = tData.getValue(col, i);
                  if (v === null || v === undefined) continue;
                  const k0 = this._uniqKey(tData, col, v);
                  if (!valToRow.has(k0)) valToRow.set(k0, i);
              }
              pending.forEach(({ idx, changes }) => {
                  const v = this._normalizeByColType(tData, col, (col in changes) ? changes[col] : tData.getValue(col, idx));
                  if (v === null || v === undefined) {
                      if (col === pkCol && (col in changes)) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${col}'.`);
                      return;
                  }
                  const k = this._uniqKey(tData, col, v);
                  if (valToRow.has(k) && valToRow.get(k) !== idx) {
                      throw new Error(`${label} constraint failed: Value '${v}' already exists in column '${col}'.`);
                  }
                  valToRow.set(k, idx);
              });
          });
      },

      // ============ トリガー (CREATE TRIGGER) ============

      // 指定テーブル・イベントのトリガーが存在するか（発火前の安価な判定用）
      _hasTriggers(event, table) {
          for (const name in this.triggers) {
              if (this.triggers[name].table === table && this.triggers[name].event === event) return true;
          }
          return false;
      },

      // トリガー本文の NEW.col / OLD.col を対象行の値リテラルへ置換する。
      // 文字列リテラル内の 'NEW.x' を壊さないよう、マスクしてから置換する
      _substituteTriggerRefs(stmt, row) {
          const sm = [];
          let s = this._maskStrings(stmt, sm);
          s = s.replace(/\b(NEW|OLD)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/gi, (m, kind, col) => {
              const isNew = kind.toUpperCase() === 'NEW';
              const src = isNew ? row.newRow : row.oldRow;
              if (!src) throw new Error(`${kind.toUpperCase()}.${col} is not available in this trigger context.`);
              const key = col.toLowerCase();
              if (!(key in src)) throw new Error(`Unknown column '${kind}.${col}' in trigger statement.`);
              const v = src[key];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return `(${v})`;
              if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
              sm.push(this._quoteLiteral(String(v)));
              return `__STR_${sm.length - 1}__`;
          });
          return this._restoreStrings(s, sm);
      },

      // トリガーを発火する。rows: [{ oldRow, newRow }]（null は該当なし）。
      // 各文は独立した executeQuery として実行される（トランザクション中は undo 対象）。
      // 再帰は深さ8まで。文のエラーは呼び出し元の DML を失敗させる
      _fireTriggers(timing, event, table, rows) {
          if (!this.triggers || !rows || rows.length === 0) return;
          const list = [];
          for (const name in this.triggers) {
              const tg = this.triggers[name];
              if (tg.table === table && tg.timing === timing && tg.event === event) list.push(tg);
          }
          if (list.length === 0) return;
          this._triggerDepth = (this._triggerDepth || 0) + 1;
          try {
              if (this._triggerDepth > 8) throw new Error("Trigger cascade depth limit (8) exceeded.");
              for (const tg of list) {
                  for (const row of rows) {
                      for (const stmt of tg.statements) {
                          // BEFORE トリガーの `SET NEW.col = <式>` は「これから書く行」への代入。
                          // 通常の文として実行すると左辺まで現在値へ置換され、
                          // `SET NULL = 'x'` のような無意味な文になって黙って捨てられていた
                          const setNew = String(stmt).match(
                              /^\s*set\s+new\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]+?)\s*;?\s*$/i);
                          if (setNew && timing === 'before') {
                              if (!row.newRow) throw new Error(`Trigger '${tg.name}': NEW is not available in a ${timing} ${event} trigger.`);
                              const col = setNew[1].toLowerCase();
                              if (!(col in row.newRow)) throw new Error(`Trigger '${tg.name}': unknown column 'NEW.${setNew[1]}'.`);
                              const exprSql = this._substituteTriggerRefs(`SELECT ${setNew[2]} AS __tgv`, row);
                              const savedCorr2 = this._corrSubs;
                              let er;
                              try { er = this.executeQuery(exprSql); } finally { this._corrSubs = savedCorr2; }
                              if (er.error) throw new Error(`Trigger '${tg.name}': ${er.error}`);
                              row.newRow[col] = (er.data && er.data.length) ? er.data[0].__tgv : null;
                              continue;
                          }
                          const sql = this._substituteTriggerRefs(stmt, row);
                          // 外側の文が保持する相関レジストリをトリガー文の実行から保護する
                          const savedCorr = this._corrSubs;
                          let res;
                          try {
                              res = this.executeQuery(sql);
                          } finally {
                              this._corrSubs = savedCorr;
                          }
                          if (res.error) throw new Error(`Trigger '${tg.name}': ${res.error}`);
                      }
                  }
              }
          } finally {
              this._triggerDepth--;
          }
      },

      // ============ RETURNING / ORDER BY 付き DML の共通ヘルパー ============

      // 文末の RETURNING 句を切り出す。戻り値 { sql, returning }（無ければ returning: null）。
      // 直後に '=' が続く場合は 'returning' という名前の列への代入とみなして無視する
      _extractReturning(sql) {
          const m = sql.match(/\s+returning\s+(?!=)([\s\S]+)$/i);
          if (!m) return { sql, returning: null };
          return { sql: sql.slice(0, m.index), returning: m[1].trim() };
      },

      // RETURNING 式リストを指定行インデックスへ適用して結果行を組み立てる。
      // '*' は全列、式は AS 別名に対応（SELECT 句と同じ流儀）
      _evalReturning(table, indices, returning, strMap) {
          const tData = this.tables[table];
          const aliases = { [table]: table };
          const sels = [];
          this.splitSelectClause(returning).forEach(p => {
              const asMatch = p.match(/(.+?)\s+AS\s+([a-zA-Z0-9_]+)$/i);
              const expr = (asMatch ? asMatch[1] : p).trim();
              const alias = asMatch ? asMatch[2] : expr.replace(/^[a-zA-Z0-9_]+\./, '');
              if (expr === '*') {
                  tData.getColumnNames().forEach(c => sels.push({ col: c, alias: c }));
              } else {
                  sels.push({ fn: this.compileCondition(expr, strMap), alias });
              }
          });
          return indices.map(idx => {
              const ptr = { [table]: idx };
              const row = {};
              sels.forEach(sel => {
                  row[sel.alias] = sel.col !== undefined ? tData.getValue(sel.col, idx) : sel.fn(ptr, this.tables, aliases);
              });
              return row;
          });
      },

      // INSERT 用 RETURNING: テーブル末尾へ追記された count 行分を評価する
      _returningForAppended(table, count, returning, strMap) {
          const t = this.tables[table];
          const idxs = [];
          for (let i = Math.max(0, t.rowCount - count); i < t.rowCount; i++) idxs.push(i);
          return this._evalReturning(table, idxs, returning, strMap);
      },

      // UPDATE / DELETE の ORDER BY: 対象行インデックスを式の値で並べ替える（LIMIT と併用）
      _sortIndicesByOrderBy(table, indices, orderByStr, strMap) {
          const items = this.splitSelectClause(orderByStr).map(s => {
              let e = s.trim();
              let desc = false;
              const dm = e.match(/\s+(asc|desc)$/i);
              if (dm) { desc = dm[1].toLowerCase() === 'desc'; e = e.slice(0, dm.index).trim(); }
              return { fn: this.compileCondition(e, strMap), desc };
          });
          const aliases = { [table]: table };
          indices.sort((a, b) => {
              for (const it of items) {
                  const va = it.fn({ [table]: a }, this.tables, aliases);
                  const vb = it.fn({ [table]: b }, this.tables, aliases);
                  if (va === vb) continue;
                  if (va === null || va === undefined) return it.desc ? 1 : -1;
                  if (vb === null || vb === undefined) return it.desc ? -1 : 1;
                  if (va < vb) return it.desc ? 1 : -1;
                  return it.desc ? -1 : 1;
              }
              return 0;
          });
          return indices;
      },

      // INSERT の値トークンを JS 値へ解釈する（VALUES 句 / SET 句共用）。
      // リテラル（文字列/数値/真偽/NULL/DATE()）はそのまま、DEFAULT はマーカーを返し、
      // それ以外は定数式としてコンパイル・評価する（1+1, UPPER('a'), NOW() 等。列参照は不可）。
      // 裸の単語 1 個は従来互換で文字列として扱う
      _parseValueToken(raw, strMap) {
          const masked = raw.trim();
          if (/^default$/i.test(masked)) return this._DEFAULT_MARKER;
          let val = masked;
          // 置換文字列はコールバックで返す。値の '$'（$&, $', $1 等）が String.replace の
          // 特殊置換パターンとして誤解釈され INSERT 値が壊れるのを防ぐ（例: '100$' → '100'）
          strMap.forEach((str, i) => { val = val.replace(new RegExp(`__STR_${i}__`, 'g'), () => str); });
          // 文字列リテラル: 引用符を外し、バインド時に付与されたエスケープ(\' \" \\)を復元する
          if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) return val.slice(1, -1).replace(/\\(['"\\])/g, '$1');
          if (val.toLowerCase() === 'null') return null;
          if (val.toLowerCase() === 'true') return true;
          if (val.toLowerCase() === 'false') return false;
          const dm = val.match(/^DATE\((.*)\)$/i);
          if (dm) return new Date(dm[1].replace(/['"]/g, ''));
          if (val !== '' && !isNaN(val)) return Number(val);
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(masked)) return val;
          try {
              const fn = this.compileCondition(masked, strMap);
              const r = fn({}, this.tables, {});
              return r === undefined ? null : r;
          } catch (e) {
              // 式として解釈できない場合は従来通り生の文字列として扱う
              return val;
          }
      },

      // VALUES 句の DEFAULT キーワード用マーカー（_parseValueToken → _resolveDefaultMarkers）
      _DEFAULT_MARKER: { __useDefault: true },

      // DEFAULT マーカーを列の DEFAULT 値（未定義なら NULL。AUTO_INCREMENT 列の NULL は
      // insertRows 側で自動採番される）へ解決する
      _resolveDefaultMarkers(table, cols, valuesList) {
          const tData = this.tables[table];
          valuesList.forEach(vals => {
              vals.forEach((v, i) => {
                  if (v === this._DEFAULT_MARKER) {
                      const col = cols[i];
                      const dv = (tData && tData.defaults && col in tData.defaults) ? tData.defaults[col] : null;
                      vals[i] = this._resolveDefaultValue(dv);
                  }
              });
          });
      },

      // PK / UNIQUE 列の値が既存行と衝突する行インデックスを返す（昇順・重複なし）
      // REPLACE INTO / INSERT IGNORE / ON DUPLICATE KEY UPDATE の衝突判定に使用
      _findConflictRows(tData, cols, vals) {
          const uniqueSet = new Set(tData.uniqueCols || []);
          if (tData.primaryKey) uniqueSet.add(tData.primaryKey);
          const hits = new Set();
          uniqueSet.forEach(col => {
              const ci = cols.indexOf(col);
              if (ci === -1) return;
              let v = vals[ci];
              if (v === null || v === undefined) return;
              const cType = tData.colTypes[col];
              if ((cType === 'INTEGER' || cType === 'FLOAT') && typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v);
              tData.findValueRows(col, v).forEach(i => hits.add(i));
          });
          // 複合キーの衝突（全列が一致する既存行）
          (tData.compositeKeys || []).forEach(ck => {
              const tup = ck.cols.map(c => {
                  const ci = cols.indexOf(c);
                  let v = ci === -1 ? null : vals[ci];
                  if (v !== null && v !== undefined) v = this._normalizeByColType(tData, c, v);
                  return v;
              });
              if (tup.some(v => v === null || v === undefined)) return;
              const sig = JSON.stringify(tup);
              for (let i = 0; i < tData.rowCount; i++) {
                  if (JSON.stringify(ck.cols.map(c => tData.getValue(c, i))) === sig) hits.add(i);
              }
          });
          return [...hits].sort((a, b) => a - b);
      },

      // 削除対象行が他テーブルのFKから参照されていないか検査する (RESTRICT)
      _checkDeleteRestrict(table, tData, targetIndices) {
          if (this.fkChecksEnabled === false) return;
          for (const otherTblName in this.tables) {
              const otherTbl = this.tables[otherTblName];
              if (!otherTbl.foreignKeys || otherTbl.foreignKeys.length === 0) continue;
              otherTbl.foreignKeys.forEach(fk => {
                  if (fk.refTable !== table) return;
                  const fkCols = this._fkCols(fk), refCols = this._fkRefCols(fk);
                  targetIndices.forEach(idx => {
                      const tuple = this._fkTupleOrNull((c) => tData.getValue(c, idx), refCols);
                      if (tuple === null) return;
                      if (this._fkMatchRows(otherTbl, fkCols, tuple).length > 0) {
                          throw new Error(`Foreign key constraint failed: Cannot delete record referenced by ${this._fkChildLabel(otherTblName, fk)}`);
                      }
                  });
              });
          }
      },

      // 対象行を単一パス圧縮で物理削除する（インデックス再構築込み）
      _removeRows(tData, targetIndices) {
          if (targetIndices.length === 0) return;
          const delSet = new Set(targetIndices);
          const rowCount = tData.rowCount;
          let w = 0;
          for (let r = 0; r < rowCount; r++) {
              if (delSet.has(r)) continue;
              if (w !== r) {
                  for (let c in tData.cols) {
                      const col = tData.cols[c];
                      col.num[w] = col.num[r];
                      col.meta[w] = col.meta[r];
                  }
              }
              w++;
          }
          tData.rowCount = w;
          // 行を詰めたら変更世代を進める。従来ここが抜けていたため、世代で無効化する
          // 派生構造（並べたキー・転置索引）が DELETE 後も古いままになり、
          // 消したはずの行が全文検索に出ていた
          tData.version++;
          if (Object.keys(tData.indices).length > 0) tData.rebuildIndices();
      },

      // REPLACE INTO / INSERT IGNORE / ON DUPLICATE KEY UPDATE の共通処理。
      // 行ごとに PK/UNIQUE 衝突を判定し、モードに応じて 置換 / スキップ / 更新 / 挿入 を行う。
      // 非衝突行は pending バッチへ溜めて一括 insertRows する（1行ずつ挿入すると
      // AUTO_INCREMENT 最大値の再走査などで O(行数 × 既存行数) に劣化するため）
      _executeUpsertRows(table, cols, valuesList, mode, strMap) {
          const tData = this.tables[table];
          this._cowColumns(table, 'ALL');

          let updates = null;
          // MySQL の VALUES(col) は「挿入されようとした値」を指す。ON CONFLICT の
          // EXCLUDED.col と同じ意味なので、疑似テーブル参照へ書き換えて経路を共有する
          const rewriteValuesFn = (txt) => txt.replace(/\bVALUES\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/gi, (m, c) => `excluded.${c}`);
          if (mode.odkuStr) {
              const setText = rewriteValuesFn(mode.odkuStr);
              if (setText !== mode.odkuStr) mode.excluded = true;
              updates = this.splitSelectClause(setText).map(s => {
                  const eqIdx = s.indexOf('=');
                  if (eqIdx === -1) throw new Error("Syntax Error in ON DUPLICATE KEY UPDATE.");
                  const col = s.substring(0, eqIdx).trim().toLowerCase();
                  if (!tData.cols[col]) throw new Error(`Column '${col}' not found.`);
                  return { col, evalFunc: this.compileCondition(s.substring(eqIdx + 1).trim(), strMap) };
              });
          }
          // DO UPDATE ... WHERE の述語（衝突行と挿入予定値の両方を参照できる）
          const whereFn = mode.odkuWhere ? this.compileCondition(rewriteValuesFn(mode.odkuWhere), strMap) : null;
          if (mode.odkuWhere && /\bexcluded\s*\./i.test(mode.odkuWhere)) mode.excluded = true;

          const aliases = { [table]: table };
          const uniqueSet = new Set(tData.uniqueCols || []);
          if (tData.primaryKey) uniqueSet.add(tData.primaryKey);

          let inserted = 0, replaced = 0, updated = 0, ignored = 0;
          let pending = [];             // { vals, keyVals }（null はバッチ内で置換済みの行）
          let pendingVals = new Map();  // col -> Map(値 -> pending 添字)
          const deleteSet = new Set();  // REPLACE: フラッシュ時に削除する既存行の添字

          // 行の一意キー値（数値型の文字列は数値へ正規化）を取り出す。
          // 複合キーは全列が揃ったタプルのシグネチャを疑似キー __ck_i として扱う
          const keyValsOf = (vals) => {
              const kv = {};
              uniqueSet.forEach(col => {
                  const ci = cols.indexOf(col);
                  if (ci === -1) return;
                  let v = vals[ci];
                  if (v === null || v === undefined) return;
                  const cType = tData.colTypes[col];
                  if ((cType === 'INTEGER' || cType === 'FLOAT') && typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v);
                  kv[col] = v;
              });
              (tData.compositeKeys || []).forEach((ck, i) => {
                  const tup = ck.cols.map(c => {
                      const ci = cols.indexOf(c);
                      let v = ci === -1 ? null : vals[ci];
                      if (v !== null && v !== undefined) v = this._normalizeByColType(tData, c, v);
                      return v;
                  });
                  if (tup.some(v => v === null || v === undefined)) return;
                  kv['__ck_' + i] = JSON.stringify(tup);
              });
              return kv;
          };
          const findPendingConflict = (kv) => {
              for (const col in kv) {
                  const valMap = pendingVals.get(col);
                  if (valMap && valMap.has(kv[col]) && pending[valMap.get(kv[col])]) return valMap.get(kv[col]);
              }
              return -1;
          };
          const addPending = (vals, kv) => {
              const pi = pending.length;
              pending.push({ vals, keyVals: kv });
              for (const col in kv) {
                  let valMap = pendingVals.get(col);
                  if (!valMap) { valMap = new Map(); pendingVals.set(col, valMap); }
                  valMap.set(kv[col], pi);
              }
          };
          const dropPending = (pi) => {
              const kv = pending[pi].keyVals;
              for (const col in kv) {
                  const valMap = pendingVals.get(col);
                  if (valMap && valMap.get(kv[col]) === pi) valMap.delete(kv[col]);
              }
              pending[pi] = null;
          };
          // 溜めた削除（REPLACE）と挿入をまとめて適用する
          // RETURNING 用に、実際に挿入・更新した行の物理索引を控える。
          // REPLACE は削除で索引がずれるため対象外（呼び出し側で拒否している）
          const touched = [];
          const flush = () => {
              // REPLACE は「既存行を消してから入れ直す」ので、入れ直しが制約で失敗すると
              // 削除だけが残る（＝黙ってデータが消える）。削除を伴うときだけ暗黙
              // セーブポイントで囲い、失敗時に消した行を戻す。実DBの REPLACE は
              // 文単位で原子的で、失敗した REPLACE は表を変えない
              let replMark = null;
              if (deleteSet.size > 0) {
                  const delIdx = [...deleteSet];
                  this._checkDeleteRestrict(table, tData, delIdx);
                  replMark = this._stmtBegin();
                  this._cowColumns(table, 'ALL');
                  this._removeRows(tData, delIdx);
                  replaced += delIdx.length;
                  deleteSet.clear();
              }
              try {
                  flushInsert();
                  if (replMark !== null) this._stmtCommit(replMark);
              } catch (e) {
                  if (replMark !== null) { try { this._stmtRollback(replMark); } catch (e2) { /* 元の例外を隠さない */ } }
                  throw e;
              }
          };

          // 溜めた挿入だけを適用する（flush から呼ばれる。REPLACE の削除は flush 側で扱う）
          const flushInsert = () => {
              const rows = pending.filter(Boolean).map(p => p.vals);
              pending = [];
              pendingVals = new Map();
              if (rows.length === 0) return;
              const beforeCount = tData.rowCount;
              try {
                  // insertRows は行配列へ DEFAULT/AUTO_INCREMENT 列を追記するためコピーを渡す
                  inserted += this.insertRows(table, cols, rows.map(r => [...r]));
              } catch (e) {
                  if (!mode.ignore || !/constraint failed/i.test(e.message)) throw e;
                  // IGNORE: バッチ内に制約違反行（FK / NOT NULL 等）が混在 → 1行ずつ再試行して違反行のみ除外
                  rows.forEach(r => {
                      try { inserted += this.insertRows(table, cols, [[...r]]); }
                      catch (e2) {
                          if (/constraint failed/i.test(e2.message)) ignored++;
                          else throw e2;
                      }
                  });
              }
              for (let i = beforeCount; i < tData.rowCount; i++) touched.push(i);
          };

          valuesList.forEach(vals => {
              const kv = keyValsOf(vals);
              const pi = findPendingConflict(kv);
              if (pi !== -1) {
                  if (mode.ignore) { ignored++; return; }
                  if (mode.replace) {
                      // バッチ内の先行行を後行で置き換える（MySQL REPLACE 互換）
                      dropPending(pi);
                      replaced++;
                  } else {
                      // ODKU: 先行 pending 行を実体化してから通常の衝突処理に載せる
                      flush();
                  }
              }
              const conflicts = this._findConflictRows(tData, cols, vals);
              if (conflicts.length === 0) {
                  addPending(vals, kv);
                  return;
              }
              if (mode.ignore) { ignored++; return; }
              if (mode.replace) {
                  conflicts.forEach(i => deleteSet.add(i));
                  addPending(vals, kv);
                  return;
              }
              // ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE: 衝突行へ SET を適用する
              // （FK 存在 / NOT NULL / UNIQUE の検証は UPDATE と共通の _validatePendingChanges に委譲）
              // ON CONFLICT の EXCLUDED.col は挿入予定値を参照するため、疑似テーブル __excluded を注入する。
              conflicts.forEach(idx => {
                  const changes = {};
                  let ptrs = { [table]: idx };
                  let dbs = this.tables;
                  if (mode.excluded) {
                      const exRow = Object.create(null);
                      cols.forEach((c, ci) => { exRow[c] = vals[ci] === undefined ? null : vals[ci]; });
                      const exTbl = { cols: Object.create(null), _row: exRow, getValue(c) { const v = this._row[c]; return v === undefined ? null : v; } };
                      cols.forEach(c => { exTbl.cols[c] = true; });
                      // __resolve は ptrs をエイリアス名で、dbTables を実テーブル名で引く。
                      // EXCLUDED.<col> → alias 'excluded' → 実体 '__excluded'
                      ptrs = { [table]: idx, excluded: 0 };
                      dbs = Object.assign(Object.create(null), this.tables, { __excluded: exTbl });
                      aliases['excluded'] = '__excluded';
                  }
                  // DO UPDATE ... WHERE: 条件を満たさない衝突行は更新しない（PostgreSQL）
                  if (whereFn && !whereFn(ptrs, dbs, aliases)) return;
                  updates.forEach(u => { changes[u.col] = u.evalFunc(ptrs, dbs, aliases); });
                  this._validatePendingChanges(tData, [{ idx, changes }]);
                  this._validateChecksForChanges(table, [{ idx, changes }]);
                  // 未フラッシュの pending 行との一意衝突も検査する
                  uniqueSet.forEach(uc => {
                      if (!(uc in changes)) return;
                      const v = changes[uc];
                      if (v === null || v === undefined) return;
                      const pm = pendingVals.get(uc);
                      if (pm && pm.has(v) && pending[pm.get(v)]) {
                          throw new Error(`${uc === tData.primaryKey ? 'PRIMARY KEY' : 'UNIQUE'} constraint failed: Value '${v}' already exists in column '${uc}'.`);
                      }
                  });
                  Object.keys(changes).forEach(c => tData.setValue(c, idx, changes[c]));
                  touched.push(idx);
                  updated++;
              });
          });
          flush();

          const parts = [`${inserted} rows inserted`];
          if (replaced) parts.push(`${replaced} replaced`);
          if (updated) parts.push(`${updated} updated`);
          if (ignored) parts.push(`${ignored} ignored`);
          return { affectedRows: inserted + replaced + updated, message: parts.join(', ') + '.',
                   touched: [...new Set(touched)].sort((a, b) => a - b) };
      },

      // 制約検証を通した上で行を原子的に挿入する共通処理
      // （INSERT VALUES / INSERT SELECT / CSVインポートで共用）
      // DEFAULT/AUTO_INCREMENT補完 → FK/UNIQUE/PK/NOT NULL検証 → 一括適用の順に行い、
      // 適用中の型キャスト失敗時は挿入済みの行を巻き戻して部分適用を防ぐ。
      insertRows(tableName, cols, valuesList) {
          tableName = tableName.toLowerCase();
          const tData = this.tables[tableName];
          if (!tData) throw new Error(`Table '${tableName}' not found.`);
          if (valuesList.length === 0) return 0;

          // 列リストに存在しない列名があれば拒否する。
          // 従来は書き込み時に addColumn で黙って列を作っていたため、
          // `INSERT INTO t(id, nmae) ...` のような打ち間違いがエラーにならず、
          // スキーマに空列が増えていく（無言のスキーマドリフト）だけだった
          if (cols && cols.length > 0) {
              const unknown = cols.filter(c => c && !tData.cols[c]);
              if (unknown.length > 0) {
                  const s = this._suggestName(unknown[0], tData.getColumnNames());
                  throw new Error(`Column '${unknown[0]}' not found in table '${tableName}'.${s ? ` Did you mean '${s}'?` : ''}`);
              }
          }

          this._cowColumns(tableName, []);

          const insertCols = this._applyRowDefaults(tData, cols, valuesList);
          this._checkInsertFKs(tData, insertCols, valuesList);
          this._checkInsertConstraints(tData, insertCols, valuesList);
          const checkFns = this._compileChecks(tData);

          // 生成列 (GENERATED ALWAYS AS): 明示挿入を拒否し、式を1度コンパイルしておく
          const genFns = this._compileGeneratedCols(tData, insertCols);

          // BEFORE INSERT トリガー（NEW = 挿入予定の値。キャスト前の生値）
          const fireInsertTriggers = this._hasTriggers('insert', tableName);
          if (fireInsertTriggers) {
              const beforeRows = valuesList.map(vals => {
                  const nr = Object.create(null);
                  tData.getColumnNames().forEach(c => { nr[c] = null; });
                  insertCols.forEach((c, i) => { nr[c] = vals[i] === undefined ? null : vals[i]; });
                  return { oldRow: null, newRow: nr };
              });
              const tgSnaps = beforeRows.map(r => Object.assign(Object.create(null), r.newRow));
              this._fireTriggers('before', 'insert', tableName, beforeRows);
              // BEFORE トリガーが NEW.col を書き換えていたら、その値を実際に挿入する。
              // 変わった列だけを反映する（全列を書き戻すと、既定値を持つ未指定列が
              // NULL で上書きされてしまう）
              beforeRows.forEach((r, i) => {
                  for (const c in r.newRow) {
                      if (r.newRow[c] === tgSnaps[i][c]) continue;
                      let at = insertCols.indexOf(c);
                      if (at === -1) {
                          insertCols.push(c);
                          at = insertCols.length - 1;
                          valuesList.forEach((vl, k) => { vl[at] = tgSnaps[k][c]; });
                      }
                      valuesList[i][at] = r.newRow[c];
                  }
              });
          }

          // INSERT で値を指定しない既存列には明示的に NULL を書き込む。
          // （DELETE / TRUNCATE 後の領域には旧行のデータが残っており、書き込みを
          //   省略すると削除済みの値が新しい行に「復活」してしまうため）
          const missingCols = tData.getColumnNames().filter(c => insertCols.indexOf(c) === -1);

          // 原子的適用: 型キャスト失敗などで途中中断した場合に備えて開始位置を記録
          const startRowCount = tData.rowCount;
          const startPoolSizes = {};
          for (const c in tData.strPools) startPoolSizes[c] = tData.strPools[c].length;

          try {
              valuesList.forEach(vals => {
                  while (tData.capacity <= tData.rowCount) tData.grow();
                  const idx = tData.rowCount;
                  insertCols.forEach((col, i) => {
                      if (!tData.cols[col]) tData.addColumn(col);
                      tData.setValue(col, idx, vals[i]);
                  });
                  missingCols.forEach(col => tData.setValue(col, idx, null));
                  // 生成列を評価（他の列が確定した後・CHECK の前）
                  this._applyGeneratedCols(tableName, tData, genFns, idx);
                  // CHECK 制約検証（行を書き込んだ直後・rowCount 確定前に評価）
                  this._validateChecksAt(tableName, tData, checkFns, idx);
                  tData.rowCount++;
              });
          } catch (e) {
              // 部分挿入のロールバック
              tData.rowCount = startRowCount; tData.version++;
              for (const c in startPoolSizes) {
                  if (tData.strPools[c] && tData.strPools[c].length > startPoolSizes[c]) {
                      const removed = tData.strPools[c].splice(startPoolSizes[c]);
                      removed.forEach(s => delete tData.strMaps[c][s]);
                  }
              }
              if (Object.keys(tData.indices).length > 0) tData.rebuildIndices();
              throw e;
          }

          // LAST_INSERT_ID(): AUTO_INCREMENT 列へ採番/指定された値の最大値を記録する
          const aiCol = tData.autoIncrementCol;
          if (aiCol) {
              const aiIdx = insertCols.indexOf(aiCol);
              if (aiIdx !== -1) {
                  let maxAi = 0;
                  valuesList.forEach(vals => {
                      const v = vals[aiIdx];
                      if (typeof v === 'number' && v > maxAi) maxAi = v;
                  });
                  if (maxAi > 0) this.lastInsertId = maxAi;
              }
          }

          // AFTER INSERT トリガー（NEW = 実際に書き込まれたキャスト後の値）。
          // トリガーが失敗したら挿入も取り消す（文単位の原子性）。トリガーが
          // 他の表へ書いた分は暗黙セーブポイントで巻き戻す
          if (fireInsertTriggers) {
              const afterRows = [];
              const colNames = tData.getColumnNames();
              for (let i = tData.rowCount - valuesList.length; i < tData.rowCount; i++) {
                  const nr = Object.create(null);
                  colNames.forEach(c => { nr[c] = tData.getValue(c, i); });
                  afterRows.push({ oldRow: null, newRow: nr });
              }
              const insMark = this._stmtBegin();
              try {
                  this._fireTriggers('after', 'insert', tableName, afterRows);
                  this._stmtCommit(insMark);
              } catch (e) {
                  try { this._stmtRollback(insMark); } catch (e2) { /* 元の例外を隠さない */ }
                  // 自表へ書き込んだ行を取り消す（上の部分挿入ロールバックと同じ手順）
                  tData.rowCount = startRowCount; tData.version++;
                  for (const c in startPoolSizes) {
                      if (tData.strPools[c] && tData.strPools[c].length > startPoolSizes[c]) {
                          const removed = tData.strPools[c].splice(startPoolSizes[c]);
                          removed.forEach(s => delete tData.strMaps[c][s]);
                      }
                  }
                  if (Object.keys(tData.indices).length > 0) tData.rebuildIndices();
                  throw e;
              }
          }

          return valuesList.length;
      },

      // 値を SQL リテラルへ変換（MERGE のソース値埋め込み用）
      _literalOf(v) {
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return String(v);
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          return this._quoteLiteral(String(v));
      },

      // 文字列中の指定キーワードを括弧深度0で最初に見つけた位置を返す（大文字小文字無視）。無ければ -1
      _findKwDepth0(str, kw) {
          let depth = 0;
          const re = new RegExp('^' + kw + '\\b', 'i');
          for (let i = 0; i < str.length; i++) {
              const c = str[i];
              if (c === '(') depth++;
              else if (c === ')') depth--;
              else if (depth === 0 && (c === kw[0] || c === kw[0].toUpperCase()) && re.test(str.slice(i))) return i;
          }
          return -1;
      },

      // MERGE INTO ... USING ... ON ... WHEN MATCHED / NOT MATCHED（Oracle / SQL Server / SQL標準 UPSERT）
      // ソース行を1行ずつ評価し、一致すれば UPDATE / DELETE、非一致なら INSERT を通常のエンジン経路で実行する。
      // 制約 / トリガー / 型検査は下位の UPDATE / INSERT / DELETE に委譲される。
      // 簡略化: マッチ判定と適用を行単位で逐次実行する（集合ベースではない）。ソースキーは一意である前提。
      _executeMerge(sql, strMap) {
          const raw = this._restoreStrings(sql, strMap);
          const head = raw.match(/^\s*merge\s+into\s+([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?(?!using\b)([a-zA-Z0-9_]+))?\s+using\s+/i);
          if (!head) throw new Error("Syntax Error in MERGE. Use: MERGE INTO t USING src [s] ON (cond) WHEN MATCHED THEN UPDATE SET ... WHEN NOT MATCHED THEN INSERT (...) VALUES (...).");
          const target = head[1].toLowerCase();
          const talias = (head[2] || head[1]).toLowerCase();
          if (!this.tables[target]) throw this._tableNotFound(target);

          let rest = raw.slice(head[0].length).replace(/^\s+/, '');
          let sourceSql, salias;
          if (rest[0] === '(') {
              let depth = 0, end = -1;
              for (let i = 0; i < rest.length; i++) {
                  if (rest[i] === '(') depth++;
                  else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
              }
              if (end === -1) throw new Error("Syntax Error in MERGE: unbalanced parentheses in USING source.");
              sourceSql = rest.slice(1, end).trim();
              rest = rest.slice(end + 1);
              const am = rest.match(/^\s+(?:as\s+)?(?!on\b)([a-zA-Z0-9_]+)/i);
              if (!am) throw new Error("MERGE USING (subquery) requires an alias.");
              salias = am[1].toLowerCase();
              rest = rest.slice(am[0].length);
          } else {
              const sm = rest.match(/^([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?(?!on\b)([a-zA-Z0-9_]+))?/i);
              if (!sm) throw new Error("Syntax Error in MERGE USING clause.");
              const srcTable = sm[1].toLowerCase();
              if (!this.tables[srcTable] && !this.views[srcTable]) throw this._tableNotFound(srcTable);
              sourceSql = `SELECT * FROM ${srcTable}`;
              salias = (sm[2] || sm[1]).toLowerCase();
              rest = rest.slice(sm[0].length);
          }

          const onM = rest.match(/^\s*on\s+/i);
          if (!onM) throw new Error("Syntax Error in MERGE: missing ON clause.");
          rest = rest.slice(onM[0].length);
          const whenPos = this._findKwDepth0(rest, 'when');
          if (whenPos === -1) throw new Error("Syntax Error in MERGE: at least one WHEN clause is required.");
          let onCond = rest.slice(0, whenPos).trim();
          if (onCond.startsWith('(') && onCond.endsWith(')')) {
              let d = 0, strip = true;
              for (let i = 0; i < onCond.length; i++) {
                  if (onCond[i] === '(') d++;
                  else if (onCond[i] === ')') { d--; if (d === 0 && i !== onCond.length - 1) { strip = false; break; } }
              }
              if (strip) onCond = onCond.slice(1, -1).trim();
          }

          // WHEN 節を深度0の WHEN で分割
          let whenStr = rest.slice(whenPos);
          const clauses = [];
          while (whenStr.length) {
              const nextRel = this._findKwDepth0(whenStr.slice(4), 'when'); // 先頭 WHEN を飛ばす
              if (nextRel === -1) { clauses.push(whenStr.trim()); break; }
              const cut = nextRel + 4;
              clauses.push(whenStr.slice(0, cut).trim());
              whenStr = whenStr.slice(cut);
          }

          // WHEN 節は「順序付きの候補リスト」として持つ。同じ種別が複数あってもよく、
          // 最初に条件を満たしたものだけが適用される（SQL Server / Oracle と同じ規則）
          const matchedClauses = [];          // WHEN MATCHED [AND c] THEN UPDATE|DELETE
          const notMatchedClauses = [];       // WHEN NOT MATCHED [BY TARGET] [AND c] THEN INSERT
          const bySourceClauses = [];         // WHEN NOT MATCHED BY SOURCE [AND c] THEN UPDATE|DELETE
          // 'AND <条件> THEN' の条件部分を切り出す（THEN は深度0のものを使う）
          const splitAndThen = (text) => {
              const t = text.replace(/^\s+/, '');
              const am = t.match(/^and\s+/i);
              if (!am) {
                  const tm = t.match(/^then\s+([\s\S]+)$/i);
                  if (!tm) return null;
                  return { cond: null, body: tm[1].trim() };
              }
              const after = t.slice(am[0].length);
              const tp = this._findKwDepth0(after, 'then');
              if (tp === -1) return null;
              return { cond: after.slice(0, tp).trim(), body: after.slice(tp + 4).trim() };
          };
          clauses.forEach(cl => {
              let head, rest2;
              if ((head = cl.match(/^when\s+not\s+matched\s+by\s+source\b/i))) rest2 = cl.slice(head[0].length);
              else if ((head = cl.match(/^when\s+not\s+matched(?:\s+by\s+target)?\b/i))) rest2 = cl.slice(head[0].length);
              else if ((head = cl.match(/^when\s+matched\b/i))) rest2 = cl.slice(head[0].length);
              else throw new Error("Unsupported MERGE WHEN clause: " + cl.slice(0, 60));
              const parsed = splitAndThen(rest2);
              if (!parsed) throw new Error("Unsupported MERGE WHEN clause: " + cl.slice(0, 60));
              const kind = /by\s+source/i.test(head[0]) ? 'bysource' : (/not\s+matched/i.test(head[0]) ? 'notmatched' : 'matched');
              const body = parsed.body;
              let um, im;
              if ((um = body.match(/^update\s+set\s+([\s\S]+)$/i))) {
                  if (kind === 'notmatched') throw new Error("WHEN NOT MATCHED [BY TARGET] supports INSERT only (use BY SOURCE for UPDATE/DELETE).");
                  (kind === 'matched' ? matchedClauses : bySourceClauses).push({ cond: parsed.cond, action: 'update', setStr: um[1].trim() });
              } else if (/^delete$/i.test(body)) {
                  if (kind === 'notmatched') throw new Error("WHEN NOT MATCHED [BY TARGET] supports INSERT only (use BY SOURCE for UPDATE/DELETE).");
                  (kind === 'matched' ? matchedClauses : bySourceClauses).push({ cond: parsed.cond, action: 'delete' });
              } else if ((im = body.match(/^insert\s*\(([^)]*)\)\s*values\s*\(([\s\S]+)\)$/i))) {
                  if (kind !== 'notmatched') throw new Error("INSERT is only allowed in WHEN NOT MATCHED [BY TARGET].");
                  notMatchedClauses.push({ cond: parsed.cond, colsStr: im[1].trim(), valsExpr: im[2].trim() });
              } else if (/^insert\s+default\s+values$/i.test(body)) {
                  if (kind !== 'notmatched') throw new Error("INSERT is only allowed in WHEN NOT MATCHED [BY TARGET].");
                  notMatchedClauses.push({ cond: parsed.cond, colsStr: null, valsExpr: null });
              } else {
                  throw new Error("Unsupported MERGE WHEN clause: " + cl.slice(0, 60));
              }
          });
          if (matchedClauses.length === 0 && notMatchedClauses.length === 0 && bySourceClauses.length === 0) {
              throw new Error("MERGE requires at least one actionable WHEN clause.");
          }

          // ソース行を実体化（トップレベル実行で文字列は再マスクされる）
          const srcRes = this.executeQuery(sourceSql);
          if (srcRes.error) throw new Error("MERGE source query failed: " + srcRes.error);
          const srcRows = Array.isArray(srcRes.data) ? srcRes.data : [];

          // <alias>. 修飾子を除去（対象列はベア参照に。UPDATE/SELECT は単一表なのでベアで解決される）
          const stripTargetQ = (expr) => expr
              .replace(new RegExp('\\b' + talias + '\\.', 'gi'), '')
              .replace(new RegExp('\\b' + target + '\\.', 'gi'), '');
          // <salias>.<col> をソース行の値リテラルへ置換
          const substSrc = (expr, row) => expr.replace(
              new RegExp('\\b' + salias + '\\.([a-zA-Z0-9_]+)\\b', 'gi'),
              (m, col) => this._literalOf(row[col] !== undefined ? row[col] : row[col.toLowerCase()])
          );

          let affected = 0, inserted = 0, updated = 0, deleted = 0;
          const onConds = [];   // WHEN NOT MATCHED BY SOURCE 用に「どれかの source 行に一致する条件」を集める
          // ソース列を含まない条件（NOT MATCHED 側の AND 条件）を単体で評価する
          const evalStandalone = (condText) => {
              const r = this.executeQuery(`SELECT 1 AS __ok WHERE ${condText}`);
              if (r.error) throw new Error("MERGE WHEN condition failed: " + r.error);
              return r.data.length > 0;
          };
          for (const srcRow of srcRows) {
              const rowLC = Object.create(null);
              for (const k in srcRow) rowLC[k.toLowerCase()] = srcRow[k];
              const cond = stripTargetQ(substSrc(onCond, rowLC));
              onConds.push(cond);
              const cntRes = this.executeQuery(`SELECT COUNT(*) AS __mc FROM ${target} WHERE ${cond}`);
              if (cntRes.error) throw new Error("MERGE ON condition failed: " + cntRes.error);
              const matched = (cntRes.data[0].__mc || 0) > 0;

              if (matched) {
                  // 追加条件は対象行にも依存し得るので、UPDATE/DELETE の WHERE へ畳み込む。
                  // 先に条件を満たす節が見つかった時点で確定する（後続の節は評価しない）
                  for (const mc of matchedClauses) {
                      const extra = mc.cond ? stripTargetQ(substSrc(mc.cond, rowLC)) : null;
                      const where = extra ? `(${cond}) AND (${extra})` : cond;
                      if (extra) {
                          const chk = this.executeQuery(`SELECT COUNT(*) AS __mc FROM ${target} WHERE ${where}`);
                          if (chk.error) throw new Error("MERGE WHEN MATCHED condition failed: " + chk.error);
                          if ((chk.data[0].__mc || 0) === 0) continue;
                      }
                      if (mc.action === 'update') {
                          const setStr = stripTargetQ(substSrc(mc.setStr, rowLC));
                          const uRes = this.executeQuery(`UPDATE ${target} SET ${setStr} WHERE ${where}`);
                          if (uRes.error) throw new Error("MERGE UPDATE failed: " + uRes.error);
                          updated += uRes.scannedRows || 0;
                      } else {
                          const dRes = this.executeQuery(`DELETE FROM ${target} WHERE ${where}`);
                          if (dRes.error) throw new Error("MERGE DELETE failed: " + dRes.error);
                          deleted += dRes.scannedRows || 0;
                      }
                      break;
                  }
              } else {
                  for (const nc of notMatchedClauses) {
                      // 一致する対象行が無いので、追加条件はソース行の値だけで判定できる
                      if (nc.cond && !evalStandalone(substSrc(nc.cond, rowLC))) continue;
                      const iSql = nc.colsStr === null
                          ? `INSERT INTO ${target} DEFAULT VALUES`
                          : `INSERT INTO ${target} (${nc.colsStr}) VALUES (${substSrc(nc.valsExpr, rowLC)})`;
                      const iRes = this.executeQuery(iSql);
                      if (iRes.error) throw new Error("MERGE INSERT failed: " + iRes.error);
                      inserted += iRes.scannedRows || 0;
                      break;
                  }
              }
          }

          // WHEN NOT MATCHED BY SOURCE: どの source 行とも一致しなかった対象行に作用する。
          // 「いずれかの ON 条件に一致する」の否定で対象を絞る（条件は行ごとに実体化済み）
          if (bySourceClauses.length > 0) {
              const uniq = [...new Set(onConds)];
              if (uniq.length > 500) {
                  throw new Error("WHEN NOT MATCHED BY SOURCE supports up to 500 distinct source rows in this implementation.");
              }
              const unmatched = uniq.length === 0 ? 'TRUE' : `NOT (${uniq.map(c => `(${c})`).join(' OR ')})`;
              for (const bc of bySourceClauses) {
                  const where = bc.cond ? `(${unmatched}) AND (${stripTargetQ(bc.cond)})` : unmatched;
                  if (bc.action === 'update') {
                      const uRes = this.executeQuery(`UPDATE ${target} SET ${stripTargetQ(bc.setStr)} WHERE ${where}`);
                      if (uRes.error) throw new Error("MERGE (BY SOURCE) UPDATE failed: " + uRes.error);
                      updated += uRes.scannedRows || 0;
                  } else {
                      const dRes = this.executeQuery(`DELETE FROM ${target} WHERE ${where}`);
                      if (dRes.error) throw new Error("MERGE (BY SOURCE) DELETE failed: " + dRes.error);
                      deleted += dRes.scannedRows || 0;
                  }
              }
          }
          affected = inserted + updated + deleted;
          return {
              data: [{ Result: "Success", Message: `${affected} rows merged (${inserted} inserted, ${updated} updated, ${deleted} deleted).` }],
              affectedRows: affected
          };
      },

      _executeInsert(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;

          // RETURNING 句（挿入した行を結果セットとして返す）を末尾から切り出す
          const ret = this._extractReturning(sql);
          sql = ret.sql;

          // INSERT INTO t DEFAULT VALUES (SQL標準 / PostgreSQL): 全列を DEFAULT で1行挿入する
          const dvM = sql.match(/^(insert(?:\s+(?:or\s+)?ignore)?\s+into\s+([a-zA-Z0-9_]+))\s+default\s+values\s*$/i);
          if (dvM) {
              const tName = dvM[2].toLowerCase();
              if (!this.tables[tName]) throw this._tableNotFound(tName);
              const cols = this.tables[tName].getColumnNames();
              if (cols.length === 0) throw new Error(`Table '${tName}' has no columns.`);
              sql = `${dvM[1]} (${cols.join(', ')}) VALUES (${cols.map(() => 'DEFAULT').join(', ')})`;
          }

          // OVERRIDING { SYSTEM | USER } VALUE（SQL標準）: 識別列に値を明示した時の扱いを選ぶ。
          //   SYSTEM VALUE = 与えた値をそのまま採用する（本実装の既定動作）
          //   USER VALUE   = 与えた値を捨てて自動採番させる
          let overridingUser = false;
          const ovM = sql.match(/\s+overriding\s+(system|user)\s+value\s+(?=values\b|select\b|\()/i);
          if (ovM) {
              overridingUser = /^user$/i.test(ovM[1]);
              sql = sql.slice(0, ovM.index) + ' ' + sql.slice(ovM.index + ovM[0].length);
          }
          // 識別列に与えられた値を捨てる（後段の自動採番に任せる）
          const applyOverriding = (table, cols, valuesList) => {
              if (!overridingUser) return;
              const ai = this.tables[table] && this.tables[table].autoIncrementCol;
              if (!ai) return;
              const at = cols.indexOf(ai);
              if (at === -1) return;
              valuesList.forEach(vals => { vals[at] = null; });
          };

          // SQLite の競合解決句 INSERT OR <action> INTO。
          //   REPLACE  → REPLACE INTO と同義
          //   IGNORE   → INSERT IGNORE と同義（下の判定が拾う）
          //   ABORT / FAIL / ROLLBACK → 「エラーで中止」＝ LuminaDB の既定動作
          // 従来は OR IGNORE 以外すべて構文エラーだった
          const orActM = sql.match(/^insert\s+or\s+(replace|abort|fail|rollback)\s+into\b/i);
          if (orActM) {
              const act = orActM[1].toLowerCase();
              if (act === 'replace') sql = 'REPLACE INTO' + sql.slice(orActM[0].length);
              else sql = 'INSERT INTO' + sql.slice(orActM[0].length);
          }

          // 挿入モード: REPLACE INTO / INSERT (OR) IGNORE / ON DUPLICATE KEY UPDATE / ON CONFLICT
          const isReplaceStmt = /^replace\s+into\b/i.test(sql);
          let isIgnore = /^insert\s+(?:or\s+)?ignore\s+into\b/i.test(sql);
          let odkuStr = null;
          let useExcluded = false;
          let odkuWhere = null;
          const odkuM = sql.match(/\s+on\s+duplicate\s+key\s+update\s+([\s\S]+)$/i);
          if (odkuM) { odkuStr = odkuM[1].trim(); sql = sql.slice(0, odkuM.index); }
          // PostgreSQL ON CONFLICT [(cols) | ON CONSTRAINT name] { DO NOTHING | DO UPDATE SET ... }
          //   DO NOTHING → INSERT IGNORE 相当 / DO UPDATE SET → ODKU 相当（EXCLUDED.col で挿入値を参照）
          //   衝突対象列（target）は PK/UNIQUE 全体で判定するため解釈のみ行い無視する。
          const confM = sql.match(/\s+on\s+conflict\b\s*(?:\(\s*[a-zA-Z0-9_,\s]*\)|on\s+constraint\s+[a-zA-Z0-9_]+)?\s*do\s+(nothing|update\s+set\s+([\s\S]+))$/i);
          if (confM) {
              if (/^nothing/i.test(confM[1])) {
                  isIgnore = true;
              } else {
                  odkuStr = confM[2].trim();
                  useExcluded = true;
                  // DO UPDATE SET ... WHERE cond: 衝突行のうち条件を満たすものだけ更新する。
                  // 深度0の WHERE で切る（SET 式に含まれる括弧内の WHERE に反応しないため）
                  const wp = this._topLevelKeyword(odkuStr, 'where');
                  if (wp !== -1) {
                      odkuWhere = odkuStr.slice(wp + 5).trim();
                      odkuStr = odkuStr.slice(0, wp).trim();
                  }
              }
              sql = sql.slice(0, confM.index);
          }

          // REPLACE は行の削除で物理索引がずれるため「返す行」を特定できない。
          // IGNORE / ON CONFLICT は実際に書き込んだ行だけを返す（PostgreSQL と同じ）
          if (ret.returning && isReplaceStmt) {
              throw new Error("RETURNING is not supported with REPLACE INTO (rows are deleted and re-inserted). Use INSERT ... ON CONFLICT instead.");
          }

          // INSERT INTO t DEFAULT VALUES: 全列を DEFAULT / AUTO_INCREMENT / NULL で補完した1行を挿入
          const defaultValuesMatch = sql.match(/^insert\s+into\s+([a-zA-Z0-9_]+)\s+default\s+values$/i);
          if (defaultValuesMatch) {
              const table = defaultValuesMatch[1].toLowerCase();
              if (!this.tables[table]) throw this._tableNotFound(table);
              const affected = this.insertRows(table, [], [[]]);
              if (ret.returning) {
                  return { data: this._returningForAppended(table, affected, ret.returning, strMap), affectedRows: affected };
              }
              return { data: [{ Result: "Success", Message: `${affected} rows inserted.` }], affectedRows: affected };
          }

          // カラムリストは省略可（省略時はテーブル定義順の全カラムを対象とする）
          // INSERT [IGNORE] / REPLACE ... SELECT および ON DUPLICATE KEY UPDATE ... SELECT に対応
          const insertSelectMatch = sql.match(/^(?:insert\s+(?:(?:or\s+)?ignore\s+)?into|replace\s+into)\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]+)\))?\s*(select\s+[\s\S]+)$/i);
          const insertValuesMatch = sql.match(/^(?:insert\s+(?:(?:or\s+)?ignore\s+)?into|replace\s+into)\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]+)\))?\s*values\s*([\s\S]+)$/i);
          // MySQL互換の INSERT INTO t SET col = val, ... 形式（REPLACE / IGNORE / ODKU とも併用可）
          const insertSetMatch = sql.match(/^(?:insert\s+(?:(?:or\s+)?ignore\s+)?into|replace\s+into)\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+)$/i);

          if (insertSelectMatch) {
              const table = insertSelectMatch[1].toLowerCase();
              if (!this.tables[table]) throw this._tableNotFound(table);
              const cols = insertSelectMatch[2]
                  ? insertSelectMatch[2].split(',').map(c => c.trim().toLowerCase())
                  : this.tables[table].getColumnNames();
              const selectSql = insertSelectMatch[3];

              const subRes = this.executeQuery(selectSql, true, strMap);
              if (subRes.error) throw new Error(subRes.error);

              const insertData = subRes.data;

              if (insertData.length > 0) {
                  const selectCols = Object.keys(insertData[0]);
                  if (cols.length !== selectCols.length) throw new Error("Column count doesn't match select count.");

                  const valuesList = insertData.map(row => selectCols.map(sc => row[sc]));
                  applyOverriding(table, cols, valuesList);
                  if (isReplaceStmt || isIgnore || odkuStr) {
                      const res = this._executeUpsertRows(table, cols, valuesList, { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded, odkuWhere }, strMap);
                      affectedRows = res.affectedRows;
                      resultSet = ret.returning
                          ? this._evalReturning(table, res.touched || [], ret.returning, strMap)
                          : [{Result:"Success", Message: res.message}];
                      return { data: resultSet, affectedRows };
                  }
                  affectedRows = this.insertRows(table, cols, valuesList);
              } else if (isReplaceStmt || isIgnore || odkuStr) {
                  return { data: ret.returning ? [] : [{Result:"Success", Message:"0 rows inserted."}], affectedRows: 0 };
              }
              resultSet = ret.returning
                  ? this._returningForAppended(table, affectedRows, ret.returning, strMap)
                  : [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
          } else if (insertValuesMatch) {
              const table = insertValuesMatch[1].toLowerCase();
              if (!this.tables[table]) throw this._tableNotFound(table);
              const cols = insertValuesMatch[2]
                  ? insertValuesMatch[2].split(',').map(c => c.trim().toLowerCase())
                  : this.tables[table].getColumnNames();
              const valStr = insertValuesMatch[3];
              // 値グループは2段の括弧ネストまで対応（VALUES (ROUND(ABS(-2.7)), ...) 等の式を許容）
              const valGroupRe = /\((?:[^)(]|\((?:[^)(]|\([^)(]*\))*\))*\)/g;
              const valMatchStrings = valStr.match(valGroupRe) || [];
              // 値グループとカンマ・空白以外の残余（タイプミス等）は従来無言で無視されていた → 構文エラーに
              const residual = valStr.replace(valGroupRe, '').replace(/[\s,]+/g, '');
              if (residual !== '') throw new Error(`Syntax Error in INSERT VALUES near '${residual.slice(0, 20)}'.`);
              const valMatches = valMatchStrings.map(s => [s, s.slice(1, -1)]);
              if(valMatches.length === 0) throw new Error("Syntax Error in INSERT.");

              let parsedValsList = [];
              valMatches.forEach(vm => {
                  // 括弧内カンマを保護して分割する（VALUES (CONCAT('a','b'), 1+1) 等の式を許容）
                  let vals = this.splitSelectClause(vm[1]).map(v => this._parseValueToken(v, strMap));
                  if (cols.length !== vals.length) throw new Error("Column count doesn't match value count.");
                  parsedValsList.push(vals);
              });
              this._resolveDefaultMarkers(table, cols, parsedValsList);
              applyOverriding(table, cols, parsedValsList);

              if (isReplaceStmt || isIgnore || odkuStr) {
                  const res = this._executeUpsertRows(table, cols, parsedValsList, { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded, odkuWhere }, strMap);
                  affectedRows = res.affectedRows;
                  resultSet = ret.returning
                      ? this._evalReturning(table, res.touched || [], ret.returning, strMap)
                      : [{Result:"Success", Message: res.message}];
              } else {
                  affectedRows = this.insertRows(table, cols, parsedValsList);
                  resultSet = ret.returning
                      ? this._returningForAppended(table, affectedRows, ret.returning, strMap)
                      : [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
              }
          } else if (insertSetMatch) {
              const table = insertSetMatch[1].toLowerCase();
              if (!this.tables[table]) throw this._tableNotFound(table);
              const cols = [];
              const vals = [];
              this.splitSelectClause(insertSetMatch[2]).forEach(p => {
                  const eqIdx = p.indexOf('=');
                  if (eqIdx === -1) throw new Error("Syntax Error in INSERT ... SET.");
                  cols.push(p.substring(0, eqIdx).trim().toLowerCase());
                  vals.push(this._parseValueToken(p.substring(eqIdx + 1), strMap));
              });
              this._resolveDefaultMarkers(table, cols, [vals]);
              if (isReplaceStmt || isIgnore || odkuStr) {
                  const res = this._executeUpsertRows(table, cols, [vals], { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded, odkuWhere }, strMap);
                  affectedRows = res.affectedRows;
                  resultSet = [{Result:"Success", Message: res.message}];
              } else {
                  affectedRows = this.insertRows(table, cols, [vals]);
                  resultSet = ret.returning
                      ? this._returningForAppended(table, affectedRows, ret.returning, strMap)
                      : [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
              }
          } else throw new Error("Syntax Error in INSERT.");

          return { data: resultSet, affectedRows };
      },

      // ============ 複数表 UPDATE / DELETE ============
      // UPDATE t SET ... FROM s WHERE ...        (PostgreSQL / SQL Server)
      // UPDATE t JOIN s ON ... SET ... [WHERE]   (MySQL)
      // DELETE FROM t USING s WHERE ...          (PostgreSQL)
      // DELETE t FROM t JOIN s ON ... [WHERE]    (MySQL)
      // を、既存の相関サブクエリ機構で実行できる単一表の形へ書き換える。
      //   代入値  : (SELECT <式> FROM s WHERE <条件>)     … 相関スカラサブクエリ
      //   対象絞込: EXISTS (SELECT 1 FROM s WHERE <条件>) … 相関 EXISTS
      // 文字列は既に __STR_N__ へ退避済みなのでリテラル中のキーワードには反応しない。
      // expandSubqueries より前（executeQuery のディスパッチ直前）に呼ぶこと。
      // 括弧の外（トップレベル）に現れる最初のキーワード位置を返す。無ければ -1。
      // サブクエリ内の FROM / WHERE を句の区切りと誤認しないために必要
      // 2 語以上のキーワード（'order by'）は、語の間の空白を \s+ で受ける。
      // 単純な substr 比較だと `ORDER\nBY` や `ORDER  BY` が一致せず、
      // GROUP_CONCAT(x ORDER\nBY y) の ORDER BY が引数の一部として扱われていた
      _topLevelKeyword(sql, word, startAt) {
          const w = word.trim().toLowerCase(), len = w.length;
          const multi = /\s/.test(w);
          const re = multi ? new RegExp(w.split(/\s+/).join('\\s+'), 'iy') : null;
          let depth = 0;
          for (let i = 0; i < sql.length; i++) {
              const c = sql[i];
              if (c === '(') { depth++; continue; }
              if (c === ')') { depth--; continue; }
              if (depth !== 0 || i < (startAt || 0)) continue;
              let mlen = len;
              if (multi) {
                  re.lastIndex = i;
                  if (!re.test(sql)) continue;
                  mlen = re.lastIndex - i;
              } else if (sql.substr(i, len).toLowerCase() !== w) continue;
              if (i > 0 && /[a-zA-Z0-9_]/.test(sql[i - 1])) continue;
              const after = sql[i + mlen];
              if (after !== undefined && /[a-zA-Z0-9_]/.test(after)) continue;
              return i;
          }
          return -1;
      },

      // _topLevelKeyword が見つけた位置のキーワード長（語間の空白を含む実長）を返す。
      // 'order by' のように語数が固定でも空白幅が可変な語で、直後の本文を切り出すのに使う
      _keywordLenAt(sql, at, word) {
          const re = new RegExp(word.trim().toLowerCase().split(/\s+/).join('\\s+'), 'iy');
          re.lastIndex = at;
          return re.test(sql) ? re.lastIndex - at : word.length;
      },

      // 複数表 UPDATE/DELETE のソースが派生表（`FROM (VALUES ...)` / `FROM (SELECT ...)`）の
      // 場合に、先に一時表へ実体化して「ただの表名」にする。
      // これにより _rewriteMultiTableDml の既存経路（単一表＋相関サブクエリ）へそのまま載る。
      // 一括更新を値の並びで書く `UPDATE t SET ... FROM (VALUES (..),(..)) AS v(a, b)` は
      // 移行スクリプトの定番なので、ここを通せるようにしておく
      _materializeDmlSources(sql, strMap) {
          if (!/^(update|delete)\b/i.test(sql)) return sql;
          if (!/\b(from|using|join)\s*\(/i.test(sql)) return sql;
          for (let guard = 0; guard < 8; guard++) {
              const m = sql.match(/\b(FROM|USING|JOIN)\s*\(/i);
              if (!m) break;
              const open = sql.indexOf('(', m.index + m[1].length);
              const close = this._scanBalanced(sql, open);
              if (close === -1) throw new Error("Syntax Error: unbalanced parentheses in the DML source.");
              const body = sql.slice(open + 1, close).trim();
              let rows;
              if (/^values\b/i.test(body)) {
                  const res = this._executeValuesStatement(body, strMap);
                  rows = res.data;
              } else if (/^select\b/i.test(body)) {
                  const res = this.executeQuery(this._restoreStrings(body, strMap));
                  if (res.error) throw new Error(`DML source query failed: ${res.error}`);
                  rows = res.data;
              } else {
                  break;   // 派生表ではない（部分式など）ので触らない
              }
              let after = sql.slice(close + 1);
              let alias = null, colNames = null;
              // 別名は必須。後続の句キーワードを別名と取り違えないよう明示的に除外する
              const alM = after.match(/^\s*(?:AS\s+)?(?!where\b|set\b|on\b|join\b|using\b|order\b|limit\b|returning\b)([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\))?/i);
              if (!alM) throw new Error("A derived table in UPDATE/DELETE requires an alias.");
              alias = alM[1];
              if (alM[2]) colNames = alM[2].split(',').map(c => c.trim().toLowerCase());
              after = after.slice(alM[0].length);
              const tmpName = '__tmp_dmlsrc_' + (this._tmpCounter = (this._tmpCounter || 0) + 1);
              this._materializeRows(tmpName, rows, colNames);
              sql = sql.slice(0, m.index) + `${m[1]} ${tmpName} ${alias}` + after;
          }
          return sql;
      },

      _rewriteMultiTableDml(sql) {
          if (!/\b(using|join)\b/i.test(sql) && !/^update\b/i.test(sql)) return sql;
          // 末尾の RETURNING / ORDER BY / LIMIT は書き換え対象外なので退避して後で戻す
          let tail = '';
          const grab = (re) => { const mm = sql.match(re); if (mm) { tail = mm[0] + tail; sql = sql.slice(0, mm.index); } };
          grab(/\s+returning\s+[\s\S]+$/i);
          grab(/\s+limit\s+\d+\s*$/i);
          grab(/\s+order\s+by\s+[\s\S]+$/i);

          const qual = (text, alias, table) => (alias === table) ? text
              : text.replace(new RegExp('\\b' + alias + '\\s*\\.', 'gi'), table + '.');

          const build = (tgt, tAlias, src, sAlias, cond, setStr) => {
              if (tgt === src) throw new Error("Multi-table UPDATE/DELETE requires two different tables (self-join is not supported).");
              const tTbl = this.tables[tgt], sTbl = this.tables[src];
              if (!tTbl) throw this._tableNotFound(tgt);
              if (!sTbl) throw this._tableNotFound(src);
              // サブクエリ内では FROM が src なので、対象表の列を修飾なしで書かれると
              // 解決できない。src に無い名前だけを <target>. で明示的に修飾する
              const IDENT = /__STR_\d+__|\b[a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*|\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(|\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
              const qualifyTarget = (text) => text.replace(IDENT, (mm, bare) => {
                  if (!bare) return mm;
                  const lc = bare.toLowerCase();
                  return (tTbl.cols[lc] && !sTbl.cols[lc]) ? `${tgt}.${bare}` : mm;
              });
              let c = qualifyTarget(qual(qual(cond.trim(), tAlias, tgt), sAlias, src));
              const exists = `EXISTS (SELECT 1 FROM ${src} WHERE ${c})`;
              if (setStr === null) return `DELETE FROM ${tgt} WHERE ${exists}${tail}`;
              const sets = this.splitSelectClause(setStr).map(part => {
                  const eq = part.indexOf('=');
                  if (eq === -1) throw new Error("Syntax Error in SET clause.");
                  const col = qual(part.slice(0, eq).trim(), tAlias, tgt).replace(new RegExp('^' + tgt + '\\s*\\.', 'i'), '');
                  const expr = qual(part.slice(eq + 1).trim(), sAlias, src);
                  // ソース表を参照する代入だけを相関スカラサブクエリへ包む
                  const usesSrc = new RegExp('\\b' + src + '\\s*\\.', 'i').test(expr);
                  return `${col} = ${usesSrc ? `(SELECT ${qualifyTarget(expr)} FROM ${src} WHERE ${c})` : expr}`;
              });
              return `UPDATE ${tgt} SET ${sets.join(', ')} WHERE ${exists}${tail}`;
          };

          // 「テーブル名 [AS] 別名」を切り出す（余分な語が残る場合は対象外＝書き換えない）
          const nameAlias = (text) => {
              const mm = text.trim().match(/^([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?$/i);
              return mm ? { table: mm[1].toLowerCase(), alias: (mm[2] || mm[1]).toLowerCase() } : null;
          };
          const TL = (w, from) => this._topLevelKeyword(sql, w, from);

          if (/^update\b/i.test(sql)) {
              const setIdx = TL('set', 0);
              if (setIdx === -1) return sql + tail;
              const joinIdx = TL('join', 0);
              // UPDATE t [a] [INNER|LEFT|...] JOIN s [b] ON <cond> SET <sets> [WHERE <w>]
              if (joinIdx !== -1 && joinIdx < setIdx) {
                  const onIdx = TL('on', joinIdx + 4);
                  if (onIdx === -1 || onIdx > setIdx) return sql + tail;
                  const head = sql.slice(6, joinIdx).replace(/\s+(inner|left|right|cross)\s*$/i, '');
                  const tgt = nameAlias(head);
                  const src = nameAlias(sql.slice(joinIdx + 4, onIdx));
                  if (!tgt || !src) return sql + tail;
                  const whereIdx = TL('where', setIdx + 3);
                  const sets = sql.slice(setIdx + 3, whereIdx === -1 ? sql.length : whereIdx);
                  const on = sql.slice(onIdx + 2, setIdx);
                  const cond = whereIdx === -1 ? on : `(${on}) AND (${sql.slice(whereIdx + 5)})`;
                  return build(tgt.table, tgt.alias, src.table, src.alias, cond, sets);
              }
              // UPDATE t [a] SET <sets> FROM s [b] WHERE <cond>
              const fromIdx = TL('from', setIdx + 3);
              if (fromIdx === -1) return sql + tail;
              const whereIdx = TL('where', fromIdx + 4);
              if (whereIdx === -1) throw new Error("UPDATE ... FROM requires a WHERE clause that joins the two tables.");
              const tgt = nameAlias(sql.slice(6, setIdx));
              const src = nameAlias(sql.slice(fromIdx + 4, whereIdx));
              if (!tgt || !src) return sql + tail;
              return build(tgt.table, tgt.alias, src.table, src.alias, sql.slice(whereIdx + 5), sql.slice(setIdx + 3, fromIdx));
          }

          // DELETE FROM t [a] USING s [b] WHERE <cond>
          const usingIdx = TL('using', 0);
          if (usingIdx !== -1) {
              const fromIdx = TL('from', 0);
              if (fromIdx === -1 || fromIdx > usingIdx) return sql + tail;
              const whereIdx = TL('where', usingIdx + 5);
              if (whereIdx === -1) throw new Error("DELETE ... USING requires a WHERE clause that joins the two tables.");
              const tgt = nameAlias(sql.slice(fromIdx + 4, usingIdx));
              const src = nameAlias(sql.slice(usingIdx + 5, whereIdx));
              if (!tgt || !src) return sql + tail;
              return build(tgt.table, tgt.alias, src.table, src.alias, sql.slice(whereIdx + 5), null);
          }
          // DELETE t FROM t [a] JOIN s [b] ON <cond> [WHERE <w>]
          const jIdx = TL('join', 0);
          if (jIdx !== -1) {
              const fromIdx = TL('from', 0);
              const onIdx = TL('on', jIdx + 4);
              if (fromIdx === -1 || fromIdx > jIdx || onIdx === -1) return sql + tail;
              const lead = sql.slice(6, fromIdx).trim();
              const head = sql.slice(fromIdx + 4, jIdx).replace(/\s+(inner|left|right|cross)\s*$/i, '');
              const tgt = nameAlias(head);
              const src = nameAlias(sql.slice(jIdx + 4, onIdx));
              if (!tgt || !src) return sql + tail;
              if (lead !== '' && lead.toLowerCase() !== tgt.table && lead.toLowerCase() !== tgt.alias) {
                  throw new Error(`Multi-table DELETE can only delete from the first table ('${tgt.table}').`);
              }
              const whereIdx = TL('where', onIdx + 2);
              const on = sql.slice(onIdx + 2, whereIdx === -1 ? sql.length : whereIdx);
              const cond = whereIdx === -1 ? on : `(${on}) AND (${sql.slice(whereIdx + 5)})`;
              return build(tgt.table, tgt.alias, src.table, src.alias, cond, null);
          }
          return sql + tail;
      },

      _executeUpdate(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          // RETURNING 句（更新後の行を結果セットとして返す）を末尾から切り出す
          const ret = this._extractReturning(sql);
          sql = ret.sql;
          // MySQL 互換の UPDATE ... [WHERE ...] [ORDER BY ...] LIMIT n
          let limitN = null;
          const lm = sql.match(/\s+limit\s+(\d+)\s*$/i);
          if (lm) { limitN = parseInt(lm[1], 10); sql = sql.slice(0, lm.index); }
          let orderByStr = null;
          const om = sql.match(/\s+order\s+by\s+([\s\S]+)$/i);
          if (om) { orderByStr = om[1].trim(); sql = sql.slice(0, om.index); }
          // UPDATE t [AS] alias SET ... （エイリアス修飾は商用DBで常用される）
          const m = sql.match(/update\s+([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?(?!set\b)([a-zA-Z0-9_]+))?\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw this._tableNotFound(table);

             const alias = m[2] ? m[2].toLowerCase() : null;
             let setStr = m[3];
             let whereStr = m[4];

             let setParts = this.splitSelectClause(setStr);
             let setEvaluators = setParts.map(s => {
                 let eqIdx = s.indexOf('=');
                 if(eqIdx === -1) throw new Error("Syntax Error in SET clause.");
                 let col = s.substring(0, eqIdx).trim().toLowerCase();
                 // 代入先は `alias.col` / `table.col` の修飾付きでも書ける
                 const dot = col.indexOf('.');
                 if (dot !== -1) {
                     const q = col.slice(0, dot);
                     if (q !== table && q !== alias) throw new Error(`Unknown table qualifier '${q}' in SET clause.`);
                     col = col.slice(dot + 1);
                 }
                 if (!this.tables[table].cols[col]) throw new Error(`Column '${col}' not found.`);
                 if (this.tables[table].generatedCols && col in this.tables[table].generatedCols) throw new Error(`Cannot assign to generated column '${col}'.`);
                 let expr = s.substring(eqIdx + 1).trim();
                 let evalFunc = this.compileCondition(expr, strMap);
                 return { col, evalFunc };
             });

             const affectedCols = setEvaluators.map(ev => ev.col);
             // COW は「この文が書き込み得る列すべて」を対象にする。SET 句の列だけを
             // 退避していると、Phase 2a（ON UPDATE CURRENT_TIMESTAMP）と Phase 2b
             // （生成列）が退避されていない列を書き換えるため、ROLLBACK で戻らない。
             // 文字列型の列では、さらに strPools が savepoint 時点まで切り詰められる
             // 一方で meta が残るので、切り離されたプール位置を指したまま NULL に化ける
             this._cowColumns(table, affectedCols
                 .concat(this.tables[table].onUpdateNowCols || [])
                 .concat(Object.keys(this.tables[table].generatedCols || {})));

             const tData = this.tables[table];
             const rowCount = tData.rowCount;
             let targetIndices = [];
             // ptrs / aliases はどちらも「別名 -> 実表」で引かれるので、別名と実名の両方を張る
             let aliases = alias ? { [alias]: table, [table]: table } : { [table]: table };
             const mkPtrs = alias ? (i) => ({ [alias]: i, [table]: i }) : (i) => ({ [table]: i });

             if (whereStr) {
                let whereFunc = this.compileCondition(whereStr, strMap);
                for (let i = 0; i < rowCount; i++) {
                    if (whereFunc(mkPtrs(i), this.tables, aliases)) targetIndices.push(i);
                }
             } else {
                 for (let i = 0; i < rowCount; i++) targetIndices.push(i);
             }
             if (orderByStr) this._sortIndicesByOrderBy(table, targetIndices, orderByStr, strMap);
             if (limitN !== null) targetIndices = targetIndices.slice(0, limitN);

             // FK 参照アクション (ON UPDATE): 参照される列が変わる行について、子テーブルへの
             // 波及（CASCADE / SET NULL）を計画する。RESTRICT / NO ACTION は変更前に throw。
             const childUpdates = [];
             for (const otherTblName in this.tables) {
                 const otherTbl = this.tables[otherTblName];
                 if (!otherTbl.foreignKeys) continue;
                 otherTbl.foreignKeys.forEach(fk => {
                     if (fk.refTable !== table) return;
                     const action = (fk.onUpdate || 'RESTRICT').toUpperCase();
                     const fkCols = this._fkCols(fk), refCols = this._fkRefCols(fk);
                     targetIndices.forEach(idx => {
                         const oldTuple = this._fkTupleOrNull((c) => tData.getValue(c, idx), refCols);
                         if (oldTuple === null) return;
                         // 参照される列のうち 1 つでも実際に値が変わるなら波及の対象
                         let willChange = false;
                         const newTuple = refCols.map((c, i) => {
                             let v = oldTuple[i];
                             setEvaluators.forEach(ev => {
                                 if (ev.col !== c) return;
                                 v = ev.evalFunc(mkPtrs(idx), this.tables, aliases);
                                 if (v !== oldTuple[i]) willChange = true;
                             });
                             return v;
                         });
                         if (!willChange) return;
                         const rows = this._fkMatchRows(otherTbl, fkCols, oldTuple);
                         if (rows.length === 0) return;
                         if (action === 'CASCADE') {
                             rows.forEach(r => fkCols.forEach((c, i) => childUpdates.push({ table: otherTblName, idx: r, col: c, val: newTuple[i] })));
                         } else if (action === 'SET NULL') {
                             // NOT NULL 列への SET NULL は矛盾するため、変更前（計画段階）に拒否する
                             const nn = fkCols.find(c => (otherTbl.notNullCols || []).includes(c));
                             if (nn) {
                                 throw new Error(`Foreign key constraint failed: ON UPDATE SET NULL conflicts with NOT NULL on ${otherTblName}(${nn})`);
                             }
                             rows.forEach(r => fkCols.forEach(c => childUpdates.push({ table: otherTblName, idx: r, col: c, val: null })));
                         }
                         else throw new Error(`Foreign key constraint failed: Cannot update record referenced by ${this._fkChildLabel(otherTblName, fk)}`);
                     });
                 });
             }

             // Phase 1: 全対象行の変更値を先に計算し、制約を検証する（この時点では一切変更しない）
             // FK 存在 / NOT NULL / UNIQUE(PK) の検証は ON DUPLICATE KEY UPDATE と共通の
             // _validatePendingChanges へ委譲する（バッチ内重複の検出を含む）
             const pending = targetIndices.map(idx => {
                 let ptr = mkPtrs(idx);
                 let changes = {};
                 setEvaluators.forEach(ev => {
                     changes[ev.col] = ev.evalFunc(ptr, this.tables, aliases);
                 });
                 return { idx, changes };
             });
             this._validatePendingChanges(tData, pending);
             this._validateChecksForChanges(table, pending);

             // FK ON UPDATE の波及値も、適用前に子テーブルの制約を通す。
             // 直接 UPDATE なら弾かれる値が CASCADE 経由では素通りしていた
             // （CHECK / UNIQUE / NOT NULL とも）。ON UPDATE SET NULL 側は
             // NOT NULL を手検査していたが、CASCADE 側に相当する検査が無かった。
             // Phase 2 より前に置くこと — 後ろだと親の書き込みが済んだ状態で
             // throw して、参照整合性の壊れた DB が残る
             if (childUpdates.length > 0) {
                 const byTable = new Map();
                 childUpdates.forEach(u => {
                     if (!byTable.has(u.table)) byTable.set(u.table, new Map());
                     const rows = byTable.get(u.table);
                     if (!rows.has(u.idx)) rows.set(u.idx, {});
                     rows.get(u.idx)[u.col] = u.val;
                 });
                 for (const [tbl, rows] of byTable) {
                     const pend = [...rows].map(([idx, changes]) => ({ idx, changes }));
                     this._validatePendingChanges(this.tables[tbl], pend, { skipFk: true });
                     this._validateChecksForChanges(tbl, pend);
                 }
             }

             // BEFORE UPDATE トリガー（OLD = 現値 / NEW = 変更適用後の予定値）
             const fireUpdTriggers = this._hasTriggers('update', table);
             let updOldRows = null;
             if (fireUpdTriggers) {
                 const colNames = tData.getColumnNames();
                 updOldRows = pending.map(({ idx }) => {
                     const or = Object.create(null);
                     colNames.forEach(c => { or[c] = tData.getValue(c, idx); });
                     return or;
                 });
                 const beforeRows = pending.map(({ changes }, i) => {
                     const nr = Object.assign(Object.create(null), updOldRows[i]);
                     for (const c in changes) nr[c] = changes[c];
                     return { oldRow: updOldRows[i], newRow: nr };
                 });
                 const rcGuard = tData.rowCount;
                 const tgSnaps = beforeRows.map(r => Object.assign(Object.create(null), r.newRow));
                 this._fireTriggers('before', 'update', table, beforeRows);
                 // BEFORE トリガーが NEW.col を書き換えていたら、その列も更新対象に加える
                 beforeRows.forEach((r, i) => {
                     for (const c in r.newRow) {
                         if (r.newRow[c] !== tgSnaps[i][c]) pending[i].changes[c] = r.newRow[c];
                     }
                 });
                 // 行の追加/削除はインデックスを狂わせるため禁止（同一テーブルの setValue は許容）
                 if (tData.rowCount !== rcGuard) throw new Error("Trigger added/removed rows of the target table during UPDATE; this is not supported.");
             }

             // AFTER トリガーは「適用後」に走るので、その中で失敗すると
             // 「文はエラーなのに変更は残る」状態になる。トリガーを持つ表に限り
             // 適用区間を暗黙セーブポイントで囲い、途中失敗を巻き戻す。
             // トリガーの無い表では従来どおりコピーを一切取らない（性能を保つ）
             const stmtMark = fireUpdTriggers ? this._stmtBegin() : null;
             if (stmtMark !== null) this._cowColumns(table, 'ALL');
             try {
                 // Phase 2: 検証を全て通過した後にまとめて適用する
                 pending.forEach(({ idx, changes }) => {
                     Object.keys(changes).forEach(c => {
                         tData.setValue(c, idx, changes[c]);
                     });
                 });

                 // Phase 2a: ON UPDATE CURRENT_TIMESTAMP の列を現在時刻へ（明示代入があればそちらを優先）
                 const touchCols = (tData.onUpdateNowCols || []).filter(c => tData.cols[c] && !setEvaluators.some(ev => ev.col === c));
                 if (touchCols.length > 0 && pending.length > 0) {
                     const now = this._nowString();
                     pending.forEach(({ idx }) => touchCols.forEach(c => tData.setValue(c, idx, now)));
                 }

                 // Phase 2b: 生成列を再評価する（依存元の列が更新された後）
                 const updGenFns = this._compileGeneratedCols(tData, null);
                 if (updGenFns.length > 0) {
                     targetIndices.forEach(idx => this._applyGeneratedCols(table, tData, updGenFns, idx));
                 }

                 // Phase 3: FK ON UPDATE の子テーブル波及を適用する（子テーブルは COW してから）
                 if (childUpdates.length > 0) {
                     const cowed = new Set();
                     childUpdates.forEach(u => {
                         if (!cowed.has(u.table)) { this._cowColumns(u.table, 'ALL'); cowed.add(u.table); }
                         this.tables[u.table].setValue(u.col, u.idx, u.val);
                     });
                 }

                 // AFTER UPDATE トリガー（NEW = 適用後の実値）
                 if (fireUpdTriggers) {
                     const colNames = tData.getColumnNames();
                     const afterRows = pending.map(({ idx }, i) => {
                         const nr = Object.create(null);
                         colNames.forEach(c => { nr[c] = tData.getValue(c, idx); });
                         return { oldRow: updOldRows[i], newRow: nr };
                     });
                     this._fireTriggers('after', 'update', table, afterRows);
                 }
                 if (stmtMark !== null) this._stmtCommit(stmtMark);
             } catch (e) {
                 if (stmtMark !== null) { try { this._stmtRollback(stmtMark); } catch (e2) { /* 元の例外を隠さない */ } }
                 throw e;
             }

             affectedRows = targetIndices.length;
             // WHERE なしの全行更新は取り違えが致命的になりやすいので警告に残す
             if (!whereStr && affectedRows > 0) {
                 this._warn('NO_WHERE', `UPDATE on '${table}' had no WHERE clause: all ${affectedRows} rows were updated.`);
             }
             resultSet = ret.returning
                 ? this._evalReturning(table, targetIndices, ret.returning, strMap)
                 : [{Result:"Success", Message:`${affectedRows} rows updated.`}];
          } else throw new Error("Syntax Error in UPDATE.");

          return { data: resultSet, affectedRows };
      },

      _executeDelete(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          // RETURNING 句（削除した行を結果セットとして返す）を末尾から切り出す
          const ret = this._extractReturning(sql);
          sql = ret.sql;
          // MySQL 互換の DELETE ... [WHERE ...] [ORDER BY ...] LIMIT n
          let limitN = null;
          const lm = sql.match(/\s+limit\s+(\d+)\s*$/i);
          if (lm) { limitN = parseInt(lm[1], 10); sql = sql.slice(0, lm.index); }
          let orderByStr = null;
          const om = sql.match(/\s+order\s+by\s+([\s\S]+)$/i);
          if (om) { orderByStr = om[1].trim(); sql = sql.slice(0, om.index); }
          // DELETE FROM t [AS] alias WHERE alias.col ... （エイリアス修飾は商用DBで常用される）。
          // 別名候補は WHERE 等のキーワードを除外して拾う
          const m = sql.match(/delete\s+from\s+([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|using\b|returning\b)([a-zA-Z0-9_]+))?(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw this._tableNotFound(table);
             this._cowColumns(table, 'ALL');
             const alias = m[2] ? m[2].toLowerCase() : null;
             const whereStr = m[3];
             const tData = this.tables[table];
             const rowCount = tData.rowCount;
             let targetIndices = [];
             // ptrs / aliases はどちらも「別名 -> 実表」で引かれるので、別名と実名の両方を張る
             let aliases = alias ? { [alias]: table, [table]: table } : { [table]: table };
             const mkPtrs = alias ? (i) => ({ [alias]: i, [table]: i }) : (i) => ({ [table]: i });

             if (whereStr) {
                let whereFunc = this.compileCondition(whereStr, strMap);
                for (let i = 0; i < rowCount; i++) {
                    if (whereFunc(mkPtrs(i), this.tables, aliases)) targetIndices.push(i);
                }
             } else {
                 for (let i = 0; i < rowCount; i++) targetIndices.push(i);
             }
             if (orderByStr) this._sortIndicesByOrderBy(table, targetIndices, orderByStr, strMap);
             if (limitN !== null) targetIndices = targetIndices.slice(0, limitN);

             // RETURNING は削除前に評価する（削除後は行が存在しないため）
             const returningRows = ret.returning ? this._evalReturning(table, targetIndices, ret.returning, strMap) : null;

             // BEFORE DELETE トリガー（OLD = 削除予定行）。行の増減は行インデックスを
             // 狂わせ誤った行を削除してしまうため、同一テーブルの行数変化を禁止する
             const fireDelTriggers = this._hasTriggers('delete', table);
             let delOldRows = null;
             if (fireDelTriggers) {
                 const colNames = tData.getColumnNames();
                 delOldRows = targetIndices.map(idx => {
                     const or = Object.create(null);
                     colNames.forEach(c => { or[c] = tData.getValue(c, idx); });
                     return { oldRow: or, newRow: null };
                 });
                 const rcGuard = tData.rowCount;
                 this._fireTriggers('before', 'delete', table, delOldRows);
                 if (tData.rowCount !== rcGuard) throw new Error("Trigger added/removed rows of the target table during DELETE; this is not supported.");
             }

             // FK 参照アクション（RESTRICT / CASCADE / SET NULL）を計画・適用（物理削除込み）
             this._applyDeleteReferentialActions(table, targetIndices);

             // AFTER DELETE トリガー（OLD = 削除された行の値）
             if (fireDelTriggers) this._fireTriggers('after', 'delete', table, delOldRows);

             affectedRows = targetIndices.length;
             // WHERE なしの全行削除も同様（TRUNCATE との取り違えを可視化する）
             if (!m[3] && affectedRows > 0) {
                 this._warn('NO_WHERE', `DELETE on '${table}' had no WHERE clause: all ${affectedRows} rows were deleted.`);
             }
             resultSet = returningRows || [{Result:"Success", Message:`${affectedRows} rows deleted.`}];
          } else throw new Error("Syntax Error in DELETE.");

          return { data: resultSet, affectedRows };
      },

      // 表値コンストラクタ文 (VALUES (1, 'a'), (2, 'b'))。列名は column1..N（PostgreSQL 互換）。
      // 値には INSERT の VALUES 句と同じ定数式（CONCAT / 1+1 / スカラサブクエリ展開済み等）が使える
      _executeValuesStatement(sql, strMap) {
          const m = sql.match(/^values\s*([\s\S]+)$/i);
          if (!m) throw new Error("Syntax Error in VALUES.");
          const valStr = m[1];
          const valGroupRe = /\((?:[^)(]|\((?:[^)(]|\([^)(]*\))*\))*\)/g;
          const groupStrings = valStr.match(valGroupRe) || [];
          const residual = valStr.replace(valGroupRe, '').replace(/[\s,]+/g, '');
          if (groupStrings.length === 0 || residual !== '') {
              throw new Error("Syntax Error in VALUES. Use VALUES (v1, v2), (v1, v2), ...");
          }
          let width = null;
          const rows = groupStrings.map(g => {
              const vals = this.splitSelectClause(g.slice(1, -1)).map(v => {
                  const parsed = this._parseValueToken(v, strMap);
                  if (parsed === this._DEFAULT_MARKER) throw new Error("DEFAULT is not allowed in a VALUES statement.");
                  return parsed;
              });
              if (width === null) width = vals.length;
              else if (vals.length !== width) throw new Error("VALUES rows must all have the same number of columns.");
              const row = {};
              vals.forEach((v, i) => { row[`column${i + 1}`] = v; });
              return row;
          });
          return { data: rows, affectedRows: rows.length };
      }
    });
