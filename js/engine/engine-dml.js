    // ============================================================================
    // [DatabaseEngine DML] - INSERT / UPDATE / DELETE と制約チェック
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

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
                  // DEFAULT CURRENT_TIMESTAMP は挿入時点の時刻へ解決する
                  extraCols.push({ col, val: this._isNowMarker(dv) ? this._nowString() : dv });
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
              aiNext = maxId + 1;
              if (cols.indexOf(ai) === -1 && !extraCols.some(e => e.col === ai)) {
                  extraCols.push({ col: ai, val: null });
              }
          }
          const newCols = cols.concat(extraCols.map(e => e.col));
          const aiIdx = ai ? newCols.indexOf(ai) : -1;
          valuesList.forEach(vals => {
              extraCols.forEach(e => vals.push(e.val));
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

      // INSERT 時の FK 存在チェック（INSERT VALUES / INSERT SELECT 共用）
      _checkInsertFKs(tData, cols, valuesList) {
          if (!tData.foreignKeys || tData.foreignKeys.length === 0) return;
          tData.foreignKeys.forEach(fk => {
              const refTbl = this.tables[fk.refTable];
              if (!refTbl) throw new Error(`Foreign key constraint failed: Table '${fk.refTable}' not found.`);
              const colIdx = cols.indexOf(fk.col);
              if (colIdx === -1) return;
              // 自己参照 FK: 同一バッチ内で挿入される refCol 値も有効とみなす。
              // （ツリー/階層データを 1 文でまとめて投入するケースに対応）
              let batchRefVals = null;
              if (refTbl === tData) {
                  const refIdx = cols.indexOf(fk.refCol);
                  batchRefVals = new Set();
                  if (refIdx !== -1) valuesList.forEach(vals => {
                      const rv = vals[refIdx];
                      if (rv !== null && rv !== undefined) batchRefVals.add(rv);
                  });
              }
              valuesList.forEach(vals => {
                  let val = vals[colIdx];
                  if (val === null || val === undefined) return;
                  val = this._normalizeByColType(tData, fk.col, val);
                  if (refTbl.findValueRows(fk.refCol, val).length > 0) return;
                  if (batchRefVals && batchRefVals.has(val)) return;
                  throw new Error(`Foreign key constraint failed: Value '${val}' not found in ${fk.refTable}(${fk.refCol})`);
              });
          });
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
                  existing.add(JSON.stringify(tup));
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
                  const sig = JSON.stringify(tup);
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
                  if (batchSeen.has(val)) throw new Error(`${label} constraint failed: Duplicate value '${val}' in column '${col}'.`);
                  batchSeen.add(val);
                  if (tData.findValueRows(col, val).length > 0) {
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
          const getDel = (t) => deletePlan[t] || (deletePlan[t] = new Set());
          const getNull = (t) => nullPlan[t] || (nullPlan[t] = new Map());

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
                      const vals = new Set();
                      indices.forEach(idx => {
                          const v = tData.getValue(fk.refCol, idx);
                          if (v !== null && v !== undefined) vals.add(v);
                      });
                      if (vals.size === 0) continue;
                      const childRows = [];
                      vals.forEach(v => child.findValueRows(fk.col, v).forEach(r => childRows.push(r)));
                      if (childRows.length === 0) continue;
                      if (action === 'CASCADE') {
                          const dset = getDel(otherName);
                          const newly = [];
                          childRows.forEach(r => { if (!dset.has(r)) { dset.add(r); newly.push(r); } });
                          if (newly.length > 0) queue.push([otherName, newly]);
                      } else if (action === 'SET NULL') {
                          // NOT NULL 列への SET NULL は矛盾するため、変更前（計画段階）に拒否する
                          if ((child.notNullCols || []).includes(fk.col)) {
                              throw new Error(`Foreign key constraint failed: ON DELETE SET NULL conflicts with NOT NULL on ${otherName}(${fk.col})`);
                          }
                          const nmap = getNull(otherName);
                          childRows.forEach(r => {
                              let s = nmap.get(r); if (!s) { s = new Set(); nmap.set(r, s); }
                              s.add(fk.col);
                          });
                      } else {
                          throw new Error(`Foreign key constraint failed: Cannot delete record referenced by ${otherName}(${fk.col})`);
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
      _validatePendingChanges(tData, pending) {
          // FK 存在チェック
          if (tData.foreignKeys && tData.foreignKeys.length > 0) {
              pending.forEach(({ changes }) => {
                  tData.foreignKeys.forEach(fk => {
                      if (changes[fk.col] === undefined || changes[fk.col] === null) return;
                      const refTbl = this.tables[fk.refTable];
                      if (!refTbl) throw new Error(`Foreign key constraint failed: Table '${fk.refTable}' not found.`);
                      const fkVal = this._normalizeByColType(tData, fk.col, changes[fk.col]);
                      if (refTbl.findValueRows(fk.refCol, fkVal).length === 0) {
                          throw new Error(`Foreign key constraint failed: Value '${fkVal}' not found in ${fk.refTable}(${fk.refCol})`);
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
                  existing.add(JSON.stringify(tup));
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
                  const sig = JSON.stringify(tup);
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
                  if (tData.findValueRows(col, v).some(r => r !== idx)) {
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
                  if (!valToRow.has(v)) valToRow.set(v, i);
              }
              pending.forEach(({ idx, changes }) => {
                  const v = this._normalizeByColType(tData, col, (col in changes) ? changes[col] : tData.getValue(col, idx));
                  if (v === null || v === undefined) {
                      if (col === pkCol && (col in changes)) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${col}'.`);
                      return;
                  }
                  if (valToRow.has(v) && valToRow.get(v) !== idx) {
                      throw new Error(`${label} constraint failed: Value '${v}' already exists in column '${col}'.`);
                  }
                  valToRow.set(v, idx);
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
                      let dv = (tData && tData.defaults && col in tData.defaults) ? tData.defaults[col] : null;
                      if (this._isNowMarker(dv)) dv = this._nowString();
                      vals[i] = dv;
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
          for (const otherTblName in this.tables) {
              const otherTbl = this.tables[otherTblName];
              if (!otherTbl.foreignKeys || otherTbl.foreignKeys.length === 0) continue;
              otherTbl.foreignKeys.forEach(fk => {
                  if (fk.refTable !== table) return;
                  targetIndices.forEach(idx => {
                      const delVal = tData.getValue(fk.refCol, idx);
                      if (delVal === null || delVal === undefined) return;
                      if (otherTbl.findValueRows(fk.col, delVal).length > 0) {
                          throw new Error(`Foreign key constraint failed: Cannot delete record referenced by ${otherTblName}(${fk.col})`);
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
          if (mode.odkuStr) {
              updates = this.splitSelectClause(mode.odkuStr).map(s => {
                  const eqIdx = s.indexOf('=');
                  if (eqIdx === -1) throw new Error("Syntax Error in ON DUPLICATE KEY UPDATE.");
                  const col = s.substring(0, eqIdx).trim().toLowerCase();
                  if (!tData.cols[col]) throw new Error(`Column '${col}' not found.`);
                  return { col, evalFunc: this.compileCondition(s.substring(eqIdx + 1).trim(), strMap) };
              });
          }

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
          const flush = () => {
              if (deleteSet.size > 0) {
                  const delIdx = [...deleteSet];
                  this._checkDeleteRestrict(table, tData, delIdx);
                  this._removeRows(tData, delIdx);
                  replaced += delIdx.length;
                  deleteSet.clear();
              }
              const rows = pending.filter(Boolean).map(p => p.vals);
              pending = [];
              pendingVals = new Map();
              if (rows.length === 0) return;
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
                  updated++;
              });
          });
          flush();

          const parts = [`${inserted} rows inserted`];
          if (replaced) parts.push(`${replaced} replaced`);
          if (updated) parts.push(`${updated} updated`);
          if (ignored) parts.push(`${ignored} ignored`);
          return { affectedRows: inserted + replaced + updated, message: parts.join(', ') + '.' };
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
              this._fireTriggers('before', 'insert', tableName, beforeRows);
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
              tData.rowCount = startRowCount;
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

          // AFTER INSERT トリガー（NEW = 実際に書き込まれたキャスト後の値）
          if (fireInsertTriggers) {
              const afterRows = [];
              const colNames = tData.getColumnNames();
              for (let i = tData.rowCount - valuesList.length; i < tData.rowCount; i++) {
                  const nr = Object.create(null);
                  colNames.forEach(c => { nr[c] = tData.getValue(c, i); });
                  afterRows.push({ oldRow: null, newRow: nr });
              }
              this._fireTriggers('after', 'insert', tableName, afterRows);
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

          let matchedUpdate = null, matchedDelete = false, notMatchedInsert = null;
          clauses.forEach(cl => {
              let m;
              if ((m = cl.match(/^when\s+matched\s+then\s+update\s+set\s+([\s\S]+)$/i))) {
                  matchedUpdate = m[1].trim();
              } else if (/^when\s+matched\s+then\s+delete$/i.test(cl)) {
                  matchedDelete = true;
              } else if ((m = cl.match(/^when\s+not\s+matched(?:\s+by\s+target)?\s+then\s+insert\s*\(([^)]*)\)\s*values\s*\(([\s\S]+)\)$/i))) {
                  notMatchedInsert = { colsStr: m[1].trim(), valsExpr: m[2].trim() };
              } else {
                  throw new Error("Unsupported MERGE WHEN clause: " + cl.slice(0, 60));
              }
          });
          if (!matchedUpdate && !matchedDelete && !notMatchedInsert) {
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
          for (const srcRow of srcRows) {
              const rowLC = Object.create(null);
              for (const k in srcRow) rowLC[k.toLowerCase()] = srcRow[k];
              const cond = stripTargetQ(substSrc(onCond, rowLC));
              const cntRes = this.executeQuery(`SELECT COUNT(*) AS __mc FROM ${target} WHERE ${cond}`);
              if (cntRes.error) throw new Error("MERGE ON condition failed: " + cntRes.error);
              const matched = (cntRes.data[0].__mc || 0) > 0;

              if (matched) {
                  if (matchedUpdate) {
                      const setStr = stripTargetQ(substSrc(matchedUpdate, rowLC));
                      const uRes = this.executeQuery(`UPDATE ${target} SET ${setStr} WHERE ${cond}`);
                      if (uRes.error) throw new Error("MERGE UPDATE failed: " + uRes.error);
                      updated += uRes.scannedRows || 0;
                  } else if (matchedDelete) {
                      const dRes = this.executeQuery(`DELETE FROM ${target} WHERE ${cond}`);
                      if (dRes.error) throw new Error("MERGE DELETE failed: " + dRes.error);
                      deleted += dRes.scannedRows || 0;
                  }
              } else if (notMatchedInsert) {
                  const valsExpr = substSrc(notMatchedInsert.valsExpr, rowLC);
                  const iRes = this.executeQuery(`INSERT INTO ${target} (${notMatchedInsert.colsStr}) VALUES (${valsExpr})`);
                  if (iRes.error) throw new Error("MERGE INSERT failed: " + iRes.error);
                  inserted += iRes.scannedRows || 0;
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

          // 挿入モード: REPLACE INTO / INSERT (OR) IGNORE / ON DUPLICATE KEY UPDATE / ON CONFLICT
          const isReplaceStmt = /^replace\s+into\b/i.test(sql);
          let isIgnore = /^insert\s+(?:or\s+)?ignore\s+into\b/i.test(sql);
          let odkuStr = null;
          let useExcluded = false;
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
              }
              sql = sql.slice(0, confM.index);
          }

          // 衝突時に挿入されない/置換される行があり「挿入した行」を一意に定められないため拒否する
          if (ret.returning && (isReplaceStmt || isIgnore || odkuStr)) {
              throw new Error("RETURNING is not supported with REPLACE / INSERT IGNORE / ON DUPLICATE KEY UPDATE / ON CONFLICT.");
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
                  if (isReplaceStmt || isIgnore || odkuStr) {
                      const res = this._executeUpsertRows(table, cols, valuesList, { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded }, strMap);
                      affectedRows = res.affectedRows;
                      resultSet = [{Result:"Success", Message: res.message}];
                      return { data: resultSet, affectedRows };
                  }
                  affectedRows = this.insertRows(table, cols, valuesList);
              } else if (isReplaceStmt || isIgnore || odkuStr) {
                  return { data: [{Result:"Success", Message:"0 rows inserted."}], affectedRows: 0 };
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

              if (isReplaceStmt || isIgnore || odkuStr) {
                  const res = this._executeUpsertRows(table, cols, parsedValsList, { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded }, strMap);
                  affectedRows = res.affectedRows;
                  resultSet = [{Result:"Success", Message: res.message}];
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
                  const res = this._executeUpsertRows(table, cols, [vals], { replace: isReplaceStmt, ignore: isIgnore, odkuStr, excluded: useExcluded }, strMap);
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
          const m = sql.match(/update\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw this._tableNotFound(table);

             let setStr = m[2];
             let whereStr = m[3];

             let setParts = this.splitSelectClause(setStr);
             let setEvaluators = setParts.map(s => {
                 let eqIdx = s.indexOf('=');
                 if(eqIdx === -1) throw new Error("Syntax Error in SET clause.");
                 let col = s.substring(0, eqIdx).trim().toLowerCase();
                 if (!this.tables[table].cols[col]) throw new Error(`Column '${col}' not found.`);
                 if (this.tables[table].generatedCols && col in this.tables[table].generatedCols) throw new Error(`Cannot assign to generated column '${col}'.`);
                 let expr = s.substring(eqIdx + 1).trim();
                 let evalFunc = this.compileCondition(expr, strMap);
                 return { col, evalFunc };
             });

             const affectedCols = setEvaluators.map(ev => ev.col);
             this._cowColumns(table, affectedCols);

             const tData = this.tables[table];
             const rowCount = tData.rowCount;
             let targetIndices = [];
             let aliases = { [table]: table };

             if (whereStr) {
                let whereFunc = this.compileCondition(whereStr, strMap);
                for (let i = 0; i < rowCount; i++) {
                    if (whereFunc({ [table]: i }, this.tables, aliases)) targetIndices.push(i);
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
                     targetIndices.forEach(idx => {
                         const oldVal = tData.getValue(fk.refCol, idx);
                         if (oldVal === null || oldVal === undefined) return;
                         let willChange = false, newVal = oldVal;
                         setEvaluators.forEach(ev => {
                             if (ev.col === fk.refCol) {
                                 newVal = ev.evalFunc({ [table]: idx }, this.tables, aliases);
                                 if (newVal !== oldVal) willChange = true;
                             }
                         });
                         if (!willChange) return;
                         const rows = otherTbl.findValueRows(fk.col, oldVal);
                         if (rows.length === 0) return;
                         if (action === 'CASCADE') rows.forEach(r => childUpdates.push({ table: otherTblName, idx: r, col: fk.col, val: newVal }));
                         else if (action === 'SET NULL') {
                             // NOT NULL 列への SET NULL は矛盾するため、変更前（計画段階）に拒否する
                             if ((otherTbl.notNullCols || []).includes(fk.col)) {
                                 throw new Error(`Foreign key constraint failed: ON UPDATE SET NULL conflicts with NOT NULL on ${otherTblName}(${fk.col})`);
                             }
                             rows.forEach(r => childUpdates.push({ table: otherTblName, idx: r, col: fk.col, val: null }));
                         }
                         else throw new Error(`Foreign key constraint failed: Cannot update record referenced by ${otherTblName}(${fk.col})`);
                     });
                 });
             }

             // Phase 1: 全対象行の変更値を先に計算し、制約を検証する（この時点では一切変更しない）
             // FK 存在 / NOT NULL / UNIQUE(PK) の検証は ON DUPLICATE KEY UPDATE と共通の
             // _validatePendingChanges へ委譲する（バッチ内重複の検出を含む）
             const pending = targetIndices.map(idx => {
                 let ptr = { [table]: idx };
                 let changes = {};
                 setEvaluators.forEach(ev => {
                     changes[ev.col] = ev.evalFunc(ptr, this.tables, aliases);
                 });
                 return { idx, changes };
             });
             this._validatePendingChanges(tData, pending);
             this._validateChecksForChanges(table, pending);

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
                 this._fireTriggers('before', 'update', table, beforeRows);
                 // 行の追加/削除はインデックスを狂わせるため禁止（同一テーブルの setValue は許容）
                 if (tData.rowCount !== rcGuard) throw new Error("Trigger added/removed rows of the target table during UPDATE; this is not supported.");
             }

             // Phase 2: 検証を全て通過した後にまとめて適用する
             pending.forEach(({ idx, changes }) => {
                 Object.keys(changes).forEach(c => {
                     tData.setValue(c, idx, changes[c]);
                 });
             });

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

             affectedRows = targetIndices.length;
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
          const m = sql.match(/delete\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw this._tableNotFound(table);
             this._cowColumns(table, 'ALL');
             const whereStr = m[2];
             const tData = this.tables[table];
             const rowCount = tData.rowCount;
             let targetIndices = [];
             let aliases = { [table]: table };

             if (whereStr) {
                let whereFunc = this.compileCondition(whereStr, strMap);
                for (let i = 0; i < rowCount; i++) {
                    if (whereFunc({ [table]: i }, this.tables, aliases)) targetIndices.push(i);
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
