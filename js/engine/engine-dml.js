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
              if (cols.indexOf(col) === -1) extraCols.push({ col, val: defaults[col] });
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

      // INSERT 時の UNIQUE / PRIMARY KEY 制約チェック（適用前に一括検証）
      _checkInsertConstraints(tData, cols, valuesList) {
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

      // INSERT の値トークン（リテラル）を JS 値へ解釈する（VALUES 句 / SET 句共用）
      _parseValueToken(raw, strMap) {
          let val = raw.trim();
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
          return isNaN(val) || val === '' ? val : Number(val);
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

          // 行の一意キー値（数値型の文字列は数値へ正規化）を取り出す
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
              // ON DUPLICATE KEY UPDATE: 衝突行へ SET を適用する
              // （FK 存在 / NOT NULL / UNIQUE の検証は UPDATE と共通の _validatePendingChanges に委譲）
              conflicts.forEach(idx => {
                  const changes = {};
                  updates.forEach(u => { changes[u.col] = u.evalFunc({ [table]: idx }, this.tables, aliases); });
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

          return valuesList.length;
      },

      _executeInsert(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;

          // 挿入モード: REPLACE INTO / INSERT (OR) IGNORE / ON DUPLICATE KEY UPDATE
          const isReplaceStmt = /^replace\s+into\b/i.test(sql);
          const isIgnore = /^insert\s+(?:or\s+)?ignore\s+into\b/i.test(sql);
          let odkuStr = null;
          const odkuM = sql.match(/\s+on\s+duplicate\s+key\s+update\s+([\s\S]+)$/i);
          if (odkuM) { odkuStr = odkuM[1].trim(); sql = sql.slice(0, odkuM.index); }

          // INSERT INTO t DEFAULT VALUES: 全列を DEFAULT / AUTO_INCREMENT / NULL で補完した1行を挿入
          const defaultValuesMatch = sql.match(/^insert\s+into\s+([a-zA-Z0-9_]+)\s+default\s+values$/i);
          if (defaultValuesMatch) {
              const table = defaultValuesMatch[1].toLowerCase();
              if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
              const affected = this.insertRows(table, [], [[]]);
              return { data: [{ Result: "Success", Message: `${affected} rows inserted.` }], affectedRows: affected };
          }

          // カラムリストは省略可（省略時はテーブル定義順の全カラムを対象とする）
          const insertSelectMatch = sql.match(/^insert\s+into\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]+)\))?\s*(select\s+[\s\S]+)$/i);
          const insertValuesMatch = sql.match(/^(?:insert\s+(?:(?:or\s+)?ignore\s+)?into|replace\s+into)\s+([a-zA-Z0-9_]+)\s*(?:\(([^)]+)\))?\s*values\s*([\s\S]+)$/i);
          // MySQL互換の INSERT INTO t SET col = val, ... 形式（REPLACE / IGNORE / ODKU とも併用可）
          const insertSetMatch = sql.match(/^(?:insert\s+(?:(?:or\s+)?ignore\s+)?into|replace\s+into)\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+)$/i);
          if (odkuStr && insertSelectMatch) throw new Error("ON DUPLICATE KEY UPDATE is not supported with INSERT ... SELECT.");

          if (insertSelectMatch) {
              const table = insertSelectMatch[1].toLowerCase();
              if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
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
                  affectedRows = this.insertRows(table, cols, valuesList);
              }
              resultSet = [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
          } else if (insertValuesMatch) {
              const table = insertValuesMatch[1].toLowerCase();
              if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
              const cols = insertValuesMatch[2]
                  ? insertValuesMatch[2].split(',').map(c => c.trim().toLowerCase())
                  : this.tables[table].getColumnNames();
              const valStr = insertValuesMatch[3];
              const valMatchStrings = valStr.match(/\((?:[^)(]+|\([^)(]*\))*\)/g) || [];
              const valMatches = valMatchStrings.map(s => [s, s.slice(1, -1)]);
              if(valMatches.length === 0) throw new Error("Syntax Error in INSERT.");

              let parsedValsList = [];
              valMatches.forEach(vm => {
                  let vals = vm[1].split(',').map(v => this._parseValueToken(v, strMap));
                  if (cols.length !== vals.length) throw new Error("Column count doesn't match value count.");
                  parsedValsList.push(vals);
              });

              if (isReplaceStmt || isIgnore || odkuStr) {
                  const res = this._executeUpsertRows(table, cols, parsedValsList, { replace: isReplaceStmt, ignore: isIgnore, odkuStr }, strMap);
                  affectedRows = res.affectedRows;
                  resultSet = [{Result:"Success", Message: res.message}];
              } else {
                  affectedRows = this.insertRows(table, cols, parsedValsList);
                  resultSet = [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
              }
          } else if (insertSetMatch) {
              const table = insertSetMatch[1].toLowerCase();
              if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
              const cols = [];
              const vals = [];
              this.splitSelectClause(insertSetMatch[2]).forEach(p => {
                  const eqIdx = p.indexOf('=');
                  if (eqIdx === -1) throw new Error("Syntax Error in INSERT ... SET.");
                  cols.push(p.substring(0, eqIdx).trim().toLowerCase());
                  vals.push(this._parseValueToken(p.substring(eqIdx + 1), strMap));
              });
              if (isReplaceStmt || isIgnore || odkuStr) {
                  const res = this._executeUpsertRows(table, cols, [vals], { replace: isReplaceStmt, ignore: isIgnore, odkuStr }, strMap);
                  affectedRows = res.affectedRows;
                  resultSet = [{Result:"Success", Message: res.message}];
              } else {
                  affectedRows = this.insertRows(table, cols, [vals]);
                  resultSet = [{Result:"Success", Message:`${affectedRows} rows inserted.`}];
              }
          } else throw new Error("Syntax Error in INSERT.");

          return { data: resultSet, affectedRows };
      },

      _executeUpdate(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          // MySQL 互換の UPDATE ... [WHERE ...] LIMIT n（格納順で先頭 n 行のみ更新）
          let limitN = null;
          const lm = sql.match(/\s+limit\s+(\d+)\s*$/i);
          if (lm) { limitN = parseInt(lm[1], 10); sql = sql.slice(0, lm.index); }
          const m = sql.match(/update\s+([a-zA-Z0-9_]+)\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);

             let setStr = m[2];
             let whereStr = m[3];

             let setParts = this.splitSelectClause(setStr);
             let setEvaluators = setParts.map(s => {
                 let eqIdx = s.indexOf('=');
                 if(eqIdx === -1) throw new Error("Syntax Error in SET clause.");
                 let col = s.substring(0, eqIdx).trim().toLowerCase();
                 if (!this.tables[table].cols[col]) throw new Error(`Column '${col}' not found.`);
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

             // Phase 2: 検証を全て通過した後にまとめて適用する
             pending.forEach(({ idx, changes }) => {
                 Object.keys(changes).forEach(c => {
                     tData.setValue(c, idx, changes[c]);
                 });
             });

             // Phase 3: FK ON UPDATE の子テーブル波及を適用する（子テーブルは COW してから）
             if (childUpdates.length > 0) {
                 const cowed = new Set();
                 childUpdates.forEach(u => {
                     if (!cowed.has(u.table)) { this._cowColumns(u.table, 'ALL'); cowed.add(u.table); }
                     this.tables[u.table].setValue(u.col, u.idx, u.val);
                 });
             }

             affectedRows = targetIndices.length;
             resultSet = [{Result:"Success", Message:`${affectedRows} rows updated.`}];
          } else throw new Error("Syntax Error in UPDATE.");

          return { data: resultSet, affectedRows };
      },

      _executeDelete(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          // MySQL 互換の DELETE ... [WHERE ...] LIMIT n（格納順で先頭 n 行のみ削除）
          let limitN = null;
          const lm = sql.match(/\s+limit\s+(\d+)\s*$/i);
          if (lm) { limitN = parseInt(lm[1], 10); sql = sql.slice(0, lm.index); }
          const m = sql.match(/delete\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([\s\S]+))?$/i);
          if (m) {
             const table = m[1].toLowerCase();
             if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
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
             if (limitN !== null) targetIndices = targetIndices.slice(0, limitN);

             // FK 参照アクション（RESTRICT / CASCADE / SET NULL）を計画・適用（物理削除込み）
             this._applyDeleteReferentialActions(table, targetIndices);
             affectedRows = targetIndices.length;
             resultSet = [{Result:"Success", Message:`${affectedRows} rows deleted.`}];
          } else throw new Error("Syntax Error in DELETE.");

          return { data: resultSet, affectedRows };
      }
    });
