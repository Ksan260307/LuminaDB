    // ============================================================================
    // [DatabaseEngine Transaction] - BEGIN / COMMIT / ROLLBACK と Undo ログ
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      _cowColumns(tableName, cols) {
          tableName = tableName.toLowerCase();
          if (!this.inTransaction) return;
          // SAVEPOINT より後のフレーム内でのみ既存ログへ合流させる
          // （SAVEPOINT を跨いで合流すると部分ロールバックが過去まで戻ってしまうため）
          let lastSp = -1;
          for (let i = this.undoLog.length - 1; i >= 0; i--) {
              if (this.undoLog[i].type === 'SAVEPOINT') { lastSp = i; break; }
          }
          let log = null;
          for (let i = this.undoLog.length - 1; i > lastSp; i--) {
              const l = this.undoLog[i];
              if (l.type === 'TABLE_COW' && l.table === tableName) { log = l; break; }
          }
          const table = this.tables[tableName];

          if (!log) {
              log = {
                  type: 'TABLE_COW',
                  table: tableName,
                  rowCount: table.rowCount,
                  cols: Object.create(null),
                  strPoolsSizes: Object.create(null)
              };
              for (let c in table.strPools) {
                  log.strPoolsSizes[c] = table.strPools[c].length;
              }
              this.undoLog.push(log);
          }

          if (cols === 'ALL') {
              cols = table.getColumnNames();
          } else if (!cols) {
              cols = [];
          }

          cols.forEach(col => {
              col = col.toLowerCase();
              if (!log.cols[col] && table.cols[col]) {
                  log.cols[col] = {
                      num: new Float64Array(table.cols[col].num),
                      meta: new Uint32Array(table.cols[col].meta)
                  };
              }
          });
      },

      _logDropTable(tableName) {
          tableName = tableName.toLowerCase();
          if (!this.inTransaction) return;
          this.undoLog.push({ type: 'DROP_TABLE', table: tableName, tableObj: this.tables[tableName] });
      },

      // 制約メタデータ変更（ALTER TABLE の ADD/DROP PK/UNIQUE/FK, SET/DROP DEFAULT/NOT NULL）の
      // undo ログ。変更前のスナップショットを保存し、ROLLBACK で丸ごと復元する
      _logTableMeta(tableName) {
          tableName = tableName.toLowerCase();
          if (!this.inTransaction) return;
          const t = this.tables[tableName];
          if (!t) return;
          this.undoLog.push({
              type: 'TABLE_META',
              table: tableName,
              primaryKey: t.primaryKey,
              uniqueCols: [...(t.uniqueCols || [])],
              notNullCols: [...(t.notNullCols || [])],
              defaults: Object.assign(Object.create(null), t.defaults || {}),
              foreignKeys: JSON.parse(JSON.stringify(t.foreignKeys || [])),
              autoIncrementCol: t.autoIncrementCol,
              checks: JSON.parse(JSON.stringify(t.checks || [])),
              compositeKeys: JSON.parse(JSON.stringify(t.compositeKeys || [])),
              indexCols: Object.keys(t.indices)
          });
      },

      _logCreateTable(tableName) {
          tableName = tableName.toLowerCase();
          if (!this.inTransaction) return;
          this.undoLog.push({ type: 'CREATE_TABLE', table: tableName });
      },

      // 構造変更（ADD/DROP/RENAME COLUMN・型変更）の undo ログ。
      // 列データの COW では列構成の変化を巻き戻せないため、変更前のテーブル全体を
      // 完全クローンとして保存し、ROLLBACK ではオブジェクトごと差し戻す
      _logFullTable(tableName) {
          tableName = tableName.toLowerCase();
          if (!this.inTransaction) return;
          const t = this.tables[tableName];
          if (!t) return;
          this.undoLog.push({ type: 'FULL_TABLE', table: tableName, tableObj: t.cloneFull() });
      },

      // CREATE/DROP VIEW の undo ログ（変更前の定義を保存。未定義なら undefined）
      _logViewState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          this.undoLog.push({ type: 'VIEW_STATE', name, prev: this.views[name],
                             prevMeta: (this.viewMeta && this.viewMeta[name]) ? Object.assign({}, this.viewMeta[name]) : undefined });
      },

      // CREATE/DROP PROCEDURE の undo ログ（変更前の文リストを保存）
      _logProcState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          const cur = this.procedures[name];
          this.undoLog.push({ type: 'PROC_STATE', name, prev: cur ? [...cur] : undefined });
      },

      // CREATE/DROP FUNCTION の undo ログ（変更前の定義を保存）
      _logFunctionState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          const cur = this.functions[name];
          this.undoLog.push({ type: 'FUNC_STATE', name, prev: cur ? JSON.parse(JSON.stringify(cur)) : undefined });
      },

      // CREATE/DROP TRIGGER の undo ログ（変更前の定義を保存）
      _logTriggerState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          const cur = this.triggers[name];
          this.undoLog.push({ type: 'TRIGGER_STATE', name, prev: cur ? JSON.parse(JSON.stringify(cur)) : undefined });
      },

      // CREATE/DROP SEQUENCE の undo ログ（定義のみ。NEXTVAL の採番値は非トランザクション）
      _logSeqState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          const cur = this.sequences[name];
          this.undoLog.push({ type: 'SEQ_STATE', name, prev: cur ? { ...cur } : undefined });
      },

      // COMMENT ON の undo ログ（従来は記録されず ROLLBACK で戻らなかった）
      _logCommentState(key) {
          if (!this.inTransaction) return;
          this.comments = this.comments || Object.create(null);
          this.undoLog.push({ type: 'COMMENT_STATE', key, prev: this.comments[key] });
      },

      // CREATE/DROP DOMAIN・TYPE の undo ログ
      _logDomainState(name) {
          name = name.toLowerCase();
          if (!this.inTransaction) return;
          const cur = this.domains ? this.domains[name] : undefined;
          this.undoLog.push({ type: 'DOMAIN_STATE', name, prev: cur ? JSON.parse(JSON.stringify(cur)) : undefined });
      },

      // Undo ログ 1 エントリを逆再生する（ROLLBACK / ROLLBACK TO SAVEPOINT 共用）
      _applyUndoEntry(log) {
          if (log.type === 'TABLE_COW') {
              const table = this.tables[log.table];
              if (table) {
                  table.rowCount = log.rowCount;
                  table.version++;   // 巻き戻しも「内容が変わった」ので世代を進める
                  for (let col in log.cols) {
                      if (!table.cols[col]) continue;
                      table.cols[col].num.set(log.cols[col].num);
                      table.cols[col].meta.set(log.cols[col].meta);
                  }
                  for (let col in log.strPoolsSizes) {
                      const size = log.strPoolsSizes[col];
                      if (table.strPools[col] && table.strPools[col].length > size) {
                          const removed = table.strPools[col].splice(size);
                          removed.forEach(s => delete table.strMaps[col][s]);
                      }
                  }
                  table.rebuildIndices();
              }
          } else if (log.type === 'DROP_TABLE') {
              this.tables[log.table] = log.tableObj;
          } else if (log.type === 'CREATE_TABLE') {
              delete this.tables[log.table];
          } else if (log.type === 'TABLE_META') {
              const table = this.tables[log.table];
              if (table) {
                  table.primaryKey = log.primaryKey;
                  table.uniqueCols = [...log.uniqueCols];
                  table.notNullCols = [...log.notNullCols];
                  table.defaults = Object.assign(Object.create(null), log.defaults);
                  table.foreignKeys = JSON.parse(JSON.stringify(log.foreignKeys));
                  table.autoIncrementCol = log.autoIncrementCol;
                  table.checks = JSON.parse(JSON.stringify(log.checks || []));
                  table.compositeKeys = JSON.parse(JSON.stringify(log.compositeKeys || []));
                  // ADD PK/UNIQUE / CREATE INDEX で追加されたインデックスを巻き戻す
                  Object.keys(table.indices).forEach(c => {
                      if (!log.indexCols.includes(c)) delete table.indices[c];
                  });
                  // DROP INDEX で削除されたインデックスを復元する
                  log.indexCols.forEach(c => {
                      if (!table.indices[c] && table.cols[c]) table.createIndex(c);
                  });
              }
          } else if (log.type === 'FULL_TABLE') {
              this.tables[log.table] = log.tableObj;
          } else if (log.type === 'VIEW_STATE') {
              if (log.prev === undefined) delete this.views[log.name];
              else this.views[log.name] = log.prev;
              this.viewMeta = this.viewMeta || Object.create(null);
              if (log.prevMeta === undefined) delete this.viewMeta[log.name];
              else this.viewMeta[log.name] = Object.assign({}, log.prevMeta);
          } else if (log.type === 'PROC_STATE') {
              if (log.prev === undefined) delete this.procedures[log.name];
              else this.procedures[log.name] = [...log.prev];
          } else if (log.type === 'TRIGGER_STATE') {
              if (log.prev === undefined) delete this.triggers[log.name];
              else this.triggers[log.name] = JSON.parse(JSON.stringify(log.prev));
          } else if (log.type === 'DOMAIN_STATE') {
              this.domains = this.domains || Object.create(null);
              if (log.prev === undefined) delete this.domains[log.name];
              else this.domains[log.name] = JSON.parse(JSON.stringify(log.prev));
          } else if (log.type === 'COMMENT_STATE') {
              this.comments = this.comments || Object.create(null);
              if (log.prev === undefined) delete this.comments[log.key];
              else this.comments[log.key] = log.prev;
          } else if (log.type === 'SEQ_STATE') {
              if (log.prev === undefined) delete this.sequences[log.name];
              else this.sequences[log.name] = { ...log.prev };
          } else if (log.type === 'FUNC_STATE') {
              if (log.prev === undefined) delete this.functions[log.name];
              else this.functions[log.name] = JSON.parse(JSON.stringify(log.prev));
          }
          // type === 'SAVEPOINT' はマーカーのため何もしない
      },

      // ------------------------------------------------------------------
      // 文単位のロールバック（内部用の暗黙 SAVEPOINT）
      //
      // 検証を通した後で throw する箇所（AFTER トリガーの失敗など）があると、
      // 「文はエラーを返したのに変更は残っている」状態になる。実DBはどれも
      // 文単位で原子的なので、書き込み文を _stmtBegin / _stmtRollback で囲って
      // 途中失敗を巻き戻す。明示トランザクションの外でも一時的に undo ログを
      // 立ち上げるため、単発の文でも原子性が得られる
      // ------------------------------------------------------------------
      _stmtBegin() {
          if (!this.inTransaction) {
              this.inTransaction = true;
              this.undoLog = [];
              this._implicitStmtTx = (this._implicitStmtTx || 0) + 1;
          }
          this.undoLog.push({ type: 'SAVEPOINT', name: '__stmt__' });
          return this.undoLog.length - 1;
      },

      // mark 以降の変更を巻き戻す（mark 位置の SAVEPOINT マーカーごと捨てる）
      _stmtRollback(mark) {
          if (mark === null || mark === undefined) return;
          for (let i = this.undoLog.length - 1; i >= mark; i--) {
              this._applyUndoEntry(this.undoLog[i]);
          }
          this.undoLog.length = mark;
          this._stmtEndImplicit();
      },

      // 成功時: マーカーだけ外して、変更は外側のトランザクションへ残す
      _stmtCommit(mark) {
          if (mark === null || mark === undefined) return;
          if (this.undoLog[mark] && this.undoLog[mark].type === 'SAVEPOINT' && this.undoLog[mark].name === '__stmt__') {
              this.undoLog.splice(mark, 1);
          }
          this._stmtEndImplicit();
      },

      // 暗黙で立ち上げたトランザクションを畳む（明示 BEGIN 中なら何もしない）
      _stmtEndImplicit() {
          if (this._implicitStmtTx > 0) {
              this._implicitStmtTx--;
              if (this._implicitStmtTx === 0) {
                  this.inTransaction = false;
                  this.undoLog = [];
              }
          }
      },

      // fn を文単位で原子的に実行する。throw したら変更を巻き戻して再 throw する
      _atomicStatement(fn) {
          const mark = this._stmtBegin();
          try {
              const r = fn();
              this._stmtCommit(mark);
              return r;
          } catch (e) {
              try { this._stmtRollback(mark); } catch (e2) { /* 巻き戻しの失敗で元の例外を隠さない */ }
              throw e;
          }
      },

      _executeTransaction(sql) {
          if (/^(begin|start\s+transaction)/i.test(sql)) {
             if(this.inTransaction) throw new Error("Transaction already active.");
             this.inTransaction = true;
             this.undoLog = [];
             return { data: [{ Result: "Success", Message: "Transaction Started" }] };
          }
          else if (/^commit/i.test(sql)) {
             if(!this.inTransaction) throw new Error("No active transaction.");
             this.inTransaction = false;
             this.undoLog = [];
             return { data: [{ Result: "Success", Message: "Transaction Committed" }] };
          }
          else if (/^savepoint\s+([a-zA-Z0-9_]+)$/i.test(sql)) {
             if(!this.inTransaction) throw new Error("No active transaction.");
             const name = sql.match(/^savepoint\s+([a-zA-Z0-9_]+)$/i)[1].toLowerCase();
             this.undoLog.push({ type: 'SAVEPOINT', name });
             return { data: [{ Result: "Success", Message: `Savepoint '${name}' created.` }] };
          }
          else if (/^release\s+(?:savepoint\s+)?([a-zA-Z0-9_]+)$/i.test(sql)) {
             if(!this.inTransaction) throw new Error("No active transaction.");
             const name = sql.match(/^release\s+(?:savepoint\s+)?([a-zA-Z0-9_]+)$/i)[1].toLowerCase();
             let idx = -1;
             for (let i = this.undoLog.length - 1; i >= 0; i--) {
                 if (this.undoLog[i].type === 'SAVEPOINT' && this.undoLog[i].name === name) { idx = i; break; }
             }
             if (idx === -1) throw new Error(`Savepoint '${name}' not found.`);
             // 解放したセーブポイントより後に作られたセーブポイントも一緒に消える
             // （SQL 標準。残しておくと入れ子の内側へ後から戻れてしまう）。
             // undo エントリ本体は外側の ROLLBACK が必要とするので順序ごと残す
             this.undoLog.splice(idx, 1);
             for (let i = this.undoLog.length - 1; i >= idx; i--) {
                 if (this.undoLog[i].type === 'SAVEPOINT') this.undoLog.splice(i, 1);
             }
             return { data: [{ Result: "Success", Message: `Savepoint '${name}' released.` }] };
          }
          else if (/^rollback\s+to\s+(?:savepoint\s+)?([a-zA-Z0-9_]+)$/i.test(sql)) {
             if(!this.inTransaction) throw new Error("No active transaction.");
             const name = sql.match(/^rollback\s+to\s+(?:savepoint\s+)?([a-zA-Z0-9_]+)$/i)[1].toLowerCase();
             let idx = -1;
             for (let i = this.undoLog.length - 1; i >= 0; i--) {
                 if (this.undoLog[i].type === 'SAVEPOINT' && this.undoLog[i].name === name) { idx = i; break; }
             }
             if (idx === -1) throw new Error(`Savepoint '${name}' not found.`);
             for (let i = this.undoLog.length - 1; i > idx; i--) {
                 this._applyUndoEntry(this.undoLog[i]);
             }
             // SAVEPOINT マーカー自体は残す（同じ名前へ再ロールバック可能）
             this.undoLog.length = idx + 1;
             return { data: [{ Result: "Success", Message: `Rolled back to savepoint '${name}'.` }] };
          }
          // ROLLBACK / ROLLBACK WORK / ROLLBACK TRANSACTION（標準のノイズ語）。
          // 以前は素の ROLLBACK だけを受け、他は「Invalid transaction command.」で
          // 弾いた上に**トランザクションを開いたまま**にしていたため、
          // 「ロールバックしたつもりで続きを書く」という最悪の取り違えが起きた
          else if (/^rollback(\s+(work|transaction))?$/i.test(sql.trim())) {
             if(!this.inTransaction) throw new Error("No active transaction.");
             for (let i = this.undoLog.length - 1; i >= 0; i--) {
                 this._applyUndoEntry(this.undoLog[i]);
             }
             this.inTransaction = false;
             this.undoLog = [];
             return { data: [{ Result: "Success", Message: "Transaction Rolled Back" }] };
          }
          throw new Error(this.inTransaction
              ? "Invalid transaction command. A transaction is still active — use COMMIT or ROLLBACK."
              : "Invalid transaction command.");
      }
    });
