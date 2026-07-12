    // ============================================================================
    // [DatabaseEngine DDL] - CREATE / ALTER / DROP / TRUNCATE / プロシージャ実行
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      // テーブル名の変更（ALTER TABLE ... RENAME TO / RENAME TABLE 共用）
      _renameTable(oldName, newName) {
          if (!this.tables[oldName]) throw new Error(`Table '${oldName}' not found.`);
          if (this.tables[newName]) throw new Error(`Table '${newName}' already exists.`);
          if (this.views[newName]) throw new Error(`View '${newName}' already exists.`);

          // ROLLBACK 用: 逆順再生で newName の削除 → oldName の復元となる
          this._logDropTable(oldName);
          this._logCreateTable(newName);
          this.tables[newName] = this.tables[oldName];
          delete this.tables[oldName];

          // 他テーブルからの FK 参照先を追従させる
          for (const tn in this.tables) {
              (this.tables[tn].foreignKeys || []).forEach(fk => {
                  if (fk.refTable === oldName) fk.refTable = newName;
              });
          }
      },

      // FK 定義末尾の ON DELETE / ON UPDATE 参照アクションを解釈する。
      // 未指定は RESTRICT（既定）。対応: CASCADE / SET NULL / RESTRICT / NO ACTION
      _parseFkActions(tail) {
          tail = tail || '';
          const dm = tail.match(/on\s+delete\s+(cascade|set\s+null|no\s+action|restrict)/i);
          const um = tail.match(/on\s+update\s+(cascade|set\s+null|no\s+action|restrict)/i);
          const norm = (mm) => mm ? mm[1].toUpperCase().replace(/\s+/g, ' ') : 'RESTRICT';
          return { onDelete: norm(dm), onUpdate: norm(um) };
      },

      // DEFAULT 句のリテラルトークンを JS 値へ解釈する
      // （CREATE TABLE / ALTER ... SET DEFAULT / ADD COLUMN DEFAULT で共用）
      _parseDefaultLiteral(raw, strMap) {
          const strM = raw.match(/^__STR_(\d+)__$/);
          if (strM && strMap) return this._unquoteLiteral(strMap[Number(strM[1])]);
          if (raw.toLowerCase() === 'null') return null;
          if (raw.toLowerCase() === 'true') return true;
          if (raw.toLowerCase() === 'false') return false;
          if (!isNaN(raw)) return Number(raw);
          return raw;
      },

      // def 文字列から CHECK ( ... ) を括弧の対応を取りつつ抜き出す。
      // 戻り値 { expr, rest }（rest は CHECK 句を除いた残り）。無ければ null。
      _extractCheck(def) {
          const m = def.match(/\bcheck\s*\(/i);
          if (!m) return null;
          const open = m.index + m[0].length - 1;
          let depth = 0, close = -1;
          for (let i = open; i < def.length; i++) {
              if (def[i] === '(') depth++;
              else if (def[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
          }
          if (close === -1) return null;
          const expr = def.slice(open + 1, close).trim();
          const rest = (def.slice(0, m.index) + ' ' + def.slice(close + 1)).replace(/\s+/g, ' ').trim();
          return { expr, rest };
      },

      // ストアドプロシージャの実行 (CALL name)
      _executeCall(sql) {
          const m = sql.match(/^call\s+([a-zA-Z0-9_]+)\s*(?:\(\s*\))?$/i);
          if (!m) throw new Error("Syntax Error in CALL.");
          const name = m[1].toLowerCase();
          const proc = this.procedures[name];
          if (!proc) throw new Error(`Procedure '${name}' not found.`);
          this._procDepth = (this._procDepth || 0) + 1;
          try {
              if (this._procDepth > 16) throw new Error("Procedure call depth limit exceeded.");
              let lastRes = null;
              for (const stmt of proc) {
                  const res = this.executeQuery(stmt);
                  if (res.error) throw new Error(`Procedure '${name}': ${res.error}`);
                  lastRes = res;
              }
              const data = (lastRes && lastRes.data && lastRes.data.length > 0)
                  ? lastRes.data
                  : [{ Result: "Success", Message: `Procedure '${name}' executed (${proc.length} statements).` }];
              return { data, affectedRows: lastRes ? (lastRes.scannedRows || 0) : 0 };
          } finally {
              this._procDepth--;
          }
      },

      // SHOW TABLES / VIEWS / PROCEDURES: メタ情報の一覧
      _executeShow(sql, strMap) {
          if (/^show\s+tables$/i.test(sql.trim())) {
              const data = Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_'))
                  .map(t => ({ Table: t, Rows: this.tables[t].rowCount, Columns: this.tables[t].getColumnNames().length }));
              return { data, affectedRows: data.length };
          }
          // SHOW TABLES LIKE 'pattern': % と _ をワイルドカードとして絞り込み
          const tlikeM = sql.trim().match(/^show\s+tables\s+like\s+__STR_(\d+)__$/i);
          if (tlikeM && strMap) {
              const pat = this._unquoteLiteral(strMap[Number(tlikeM[1])]);
              const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              const data = Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && re.test(t))
                  .map(t => ({ Table: t, Rows: this.tables[t].rowCount, Columns: this.tables[t].getColumnNames().length }));
              return { data, affectedRows: data.length };
          }
          if (/^show\s+views$/i.test(sql.trim())) {
              const data = Object.keys(this.views).map(v => ({ View: v, Definition: this.views[v] }));
              return { data, affectedRows: data.length };
          }
          if (/^show\s+procedures$/i.test(sql.trim())) {
              const data = Object.keys(this.procedures).map(p => ({ Procedure: p, Statements: this.procedures[p].length }));
              return { data, affectedRows: data.length };
          }
          const idxM = sql.trim().match(/^show\s+indexes(?:\s+from\s+([a-zA-Z0-9_]+))?$/i);
          if (idxM) {
              const target = idxM[1] ? idxM[1].toLowerCase() : null;
              if (target && !this.tables[target]) throw new Error(`Table '${target}' not found.`);
              const data = [];
              Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && (!target || t === target))
                  .forEach(t => {
                      Object.keys(this.tables[t].indices).forEach(c => {
                          data.push({ Table: t, Column: c, Keys: this.tables[t].indices[c].size });
                      });
                  });
              return { data, affectedRows: data.length };
          }
          const sctM = sql.trim().match(/^show\s+create\s+table\s+([a-zA-Z0-9_]+)$/i);
          if (sctM) {
              const name = sctM[1].toLowerCase();
              if (!this.tables[name]) throw new Error(`Table '${name}' not found.`);
              return { data: [{ Table: name, CreateTable: this.buildCreateTableSQL(name) }], affectedRows: 1 };
          }
          const scvM = sql.trim().match(/^show\s+create\s+view\s+([a-zA-Z0-9_]+)$/i);
          if (scvM) {
              const name = scvM[1].toLowerCase();
              if (!this.views[name]) throw new Error(`View '${name}' not found.`);
              return { data: [{ View: name, CreateView: `CREATE VIEW ${name} AS ${this.views[name]}` }], affectedRows: 1 };
          }
          // SHOW COLUMNS FROM t は DESCRIBE のエイリアス
          const colM = sql.trim().match(/^show\s+columns\s+from\s+([a-zA-Z0-9_]+)$/i);
          if (colM) {
              return this._executeDescribe(`DESCRIBE ${colM[1]}`);
          }
          throw new Error("Syntax Error in SHOW. Use SHOW TABLES [LIKE 'pat'] / VIEWS / PROCEDURES / INDEXES [FROM table] / COLUMNS FROM <table> / CREATE TABLE <name> / CREATE VIEW <name>.");
      },

      // DESCRIBE / DESC name: テーブルのカラム定義（ビューなら定義SQL）を返す
      _executeDescribe(sql) {
          const m = sql.match(/^(?:describe|desc)\s+([a-zA-Z0-9_]+)$/i);
          if (!m) throw new Error("Syntax Error in DESCRIBE.");
          const name = m[1].toLowerCase();
          if (this.views[name]) {
              return { data: [{ View: name, Definition: this.views[name] }], affectedRows: 1 };
          }
          const t = this.tables[name];
          if (!t) throw new Error(`Table '${name}' not found.`);
          const data = t.getColumnNames().map(c => {
              const fk = (t.foreignKeys || []).find(f => f.col === c);
              return {
                  Column: c,
                  Type: t.colTypes[c] || 'ANY',
                  Key: t.primaryKey === c ? 'PRIMARY' : ((t.uniqueCols || []).includes(c) ? 'UNIQUE' : ''),
                  Indexed: !!t.indices[c],
                  ForeignKey: fk ? `${fk.refTable}(${fk.refCol})` : '',
                  NotNull: (t.notNullCols || []).includes(c),
                  Default: (t.defaults && c in t.defaults) ? String(t.defaults[c]) : '',
                  Extra: t.autoIncrementCol === c ? 'AUTO_INCREMENT' : ''
              };
          });
          return { data, affectedRows: data.length };
      },

      _executeDDL(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          if (/^create\s+index/i.test(sql)) {
             const m = sql.match(/create\s+index\s+([a-zA-Z0-9_]+)\s+on\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)/i);
             if (m) {
                const idxName = m[1].toLowerCase();
                const table = m[2].toLowerCase();
                const col = m[3].toLowerCase();
                if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                this._logTableMeta(table);
                this.tables[table].createIndex(col);
                resultSet = [{ Result: "Success", Message: `Index '${idxName}' created on ${table}(${col}).` }];
             } else throw new Error("Syntax Error in CREATE INDEX.");
          }
          else if (/^create\s+(?:or\s+replace\s+)?view/i.test(sql)) {
             const m = sql.match(/^create\s+(or\s+replace\s+)?view\s+([a-zA-Z0-9_]+)\s+as\s+([\s\S]+)$/i);
             if (m) {
                const orReplace = !!m[1];
                const name = m[2].toLowerCase();
                if (this.tables[name]) throw new Error(`Table '${name}' already exists.`);
                if (this.views[name] && !orReplace) throw new Error(`View '${name}' already exists.`);
                let body = m[3].trim().replace(/;$/, '');
                if (!/^select\b/i.test(body)) throw new Error("VIEW definition must be a SELECT statement.");
                if (new RegExp(`\\b(from|join)\\s+${name}\\b`, 'i').test(body)) throw new Error("View cannot reference itself.");
                const replaced = orReplace && this.views[name];
                this._logViewState(name);
                this.views[name] = this._restoreStrings(body, strMap);
                resultSet = [{ Result: "Success", Message: `View '${name}' ${replaced ? 'replaced' : 'created'}.` }];
             } else throw new Error("Syntax Error in CREATE VIEW.");
          }
          else if (/^create\s+(?:or\s+replace\s+)?procedure/i.test(sql)) {
             const m = sql.match(/^create\s+(or\s+replace\s+)?procedure\s+([a-zA-Z0-9_]+)\s+as\s+([\s\S]+)$/i);
             if (m) {
                const orReplace = !!m[1];
                const name = m[2].toLowerCase();
                if (this.procedures[name] && !orReplace) throw new Error(`Procedure '${name}' already exists.`);
                const replaced = orReplace && !!this.procedures[name];
                let body = m[3].trim();
                const beMatch = body.match(/^begin\s+([\s\S]+?)\s*end$/i);
                if (beMatch) body = beMatch[1];
                const statements = body.split(';').map(s => s.trim()).filter(s => s !== '').map(s => this._restoreStrings(s, strMap));
                if (statements.length === 0) throw new Error("Procedure body is empty.");
                this._logProcState(name);
                this.procedures[name] = statements;
                resultSet = [{ Result: "Success", Message: `Procedure '${name}' ${replaced ? 'replaced' : 'created'} (${statements.length} statements).` }];
             } else throw new Error("Syntax Error in CREATE PROCEDURE.");
          }
          else if (/^create\s+table/i.test(sql)) {
             // CREATE TABLE new LIKE src: スキーマ（型/制約/インデックス）のみ複製（データは含まない）
             const likeM = sql.match(/^create\s+table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+like\s+([a-zA-Z0-9_]+)$/i);
             if (likeM) {
                const ifNotExists = !!likeM[1];
                const tableName = likeM[2].toLowerCase();
                const srcName = likeM[3].toLowerCase();
                if (this.tables[tableName] || this.views[tableName]) {
                    if (ifNotExists) {
                        return { data: [{ Result: "Success", Message: `Table '${tableName}' already exists. Skipped.` }], affectedRows: 0 };
                    }
                    throw new Error(`Table '${tableName}' already exists.`);
                }
                const src = this.tables[srcName];
                if (!src) throw new Error(`Table '${srcName}' not found.`);
                this._logCreateTable(tableName);
                const t = new Table();
                src.getColumnNames().forEach(c => t.addColumn(c, src.colTypes[c] || 'ANY'));
                t.primaryKey = src.primaryKey;
                t.uniqueCols = [...(src.uniqueCols || [])];
                t.notNullCols = [...(src.notNullCols || [])];
                t.defaults = Object.assign(Object.create(null), src.defaults || {});
                t.autoIncrementCol = src.autoIncrementCol;
                t.foreignKeys = JSON.parse(JSON.stringify(src.foreignKeys || []));
                t.checks = JSON.parse(JSON.stringify(src.checks || []));
                Object.keys(src.indices).forEach(c => t.createIndex(c));
                this.tables[tableName] = t;
                return { data: [{ Result: "Success", Message: `Table '${tableName}' created like '${srcName}'.` }], affectedRows: 0 };
             }

             // CREATE TABLE ... AS SELECT (CTAS): SELECT 結果からテーブルを作成
             const ctasM = sql.match(/^create\s+table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+as\s+(select\s[\s\S]+)$/i);
             if (ctasM) {
                const ifNotExists = !!ctasM[1];
                const tableName = ctasM[2].toLowerCase();
                if (this.tables[tableName] || this.views[tableName]) {
                    if (ifNotExists) {
                        return { data: [{ Result: "Success", Message: `Table '${tableName}' already exists. Skipped.` }], affectedRows: 0 };
                    }
                    throw new Error(`Table '${tableName}' already exists.`);
                }
                const subRes = this.executeQuery(ctasM[3], true, strMap);
                if (subRes.error) throw new Error(subRes.error);
                this._logCreateTable(tableName);
                const t = new Table();
                if (subRes.data && subRes.data.length > 0) {
                    const keys = Object.keys(subRes.data[0]);
                    keys.forEach(k => t.addColumn(k));
                    while (t.capacity < subRes.data.length) t.grow();
                    subRes.data.forEach((row, i) => keys.forEach(k => t.setValue(k, i, row[k])));
                    t.rowCount = subRes.data.length;
                }
                this.tables[tableName] = t;
                return { data: [{ Result: "Success", Message: `Table '${tableName}' created (${t.rowCount} rows).` }], affectedRows: t.rowCount };
             }

             const m = sql.match(/create\s+table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]+)\)/i);
             if (m) {
                const ifNotExists = !!m[1];
                const tableName = m[2].toLowerCase();
                if (this.tables[tableName] || this.views[tableName]) {
                    if (ifNotExists) {
                        return { data: [{ Result: "Success", Message: `Table '${tableName}' already exists. Skipped.` }], affectedRows: 0 };
                    }
                    if (this.tables[tableName]) throw new Error(`Table '${tableName}' already exists.`);
                    throw new Error(`View '${tableName}' already exists.`);
                }
                this._logCreateTable(tableName);

                // 列定義は括弧を考慮して分割する（CHECK(x IN (1,2)) 等の内部カンマを保護）
                const defs = this.splitSelectClause(m[3]);
                const colDefs = [];
                const foreignKeys = [];
                const tableLevelPks = [];
                const tableLevelUniques = [];
                const checks = [];

                defs.forEach(d => {
                    // テーブルレベル CHECK（列定義より先に判定）: [CONSTRAINT name] CHECK (expr)
                    const tlChk = d.match(/^\s*(?:constraint\s+([a-zA-Z0-9_]+)\s+)?check\s*\(/i);
                    if (tlChk) {
                        const ex = this._extractCheck(d);
                        if (!ex) throw new Error("Syntax Error in CHECK constraint.");
                        checks.push({ name: tlChk[1] ? tlChk[1].toLowerCase() : null, expr: this._restoreStrings(ex.expr, strMap) });
                        return;
                    }
                    const fkMatch = d.match(/^foreign\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*references\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)([\s\S]*)$/i);
                    const pkMatch = d.match(/^primary\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
                    const uqMatch = d.match(/^unique\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
                    if (fkMatch) {
                        const acts = this._parseFkActions(fkMatch[4]);
                        foreignKeys.push({
                            col: fkMatch[1].toLowerCase(),
                            refTable: fkMatch[2].toLowerCase(),
                            refCol: fkMatch[3].toLowerCase(),
                            onDelete: acts.onDelete,
                            onUpdate: acts.onUpdate
                        });
                    } else if (pkMatch) {
                        tableLevelPks.push(pkMatch[1].toLowerCase());
                    } else if (uqMatch) {
                        tableLevelUniques.push(uqMatch[1].toLowerCase());
                    } else {
                        // カラム定義: 列レベルの CHECK / PRIMARY KEY / UNIQUE / NOT NULL / DEFAULT / AUTO_INCREMENT 修飾を解析
                        let def = d;
                        // 列レベル CHECK を先に切り出す（式内の括弧・キーワードが後続解析を汚さないように）
                        const cchk = this._extractCheck(def);
                        if (cchk) { checks.push({ name: null, expr: this._restoreStrings(cchk.expr, strMap) }); def = cchk.rest; }
                        let isPK = false, isUnique = false, notNull = false, autoInc = false;
                        let defaultVal; // undefined = DEFAULT 指定なし
                        if (/\bprimary\s+key\b/i.test(def)) { isPK = true; def = def.replace(/\bprimary\s+key\b/i, ' '); }
                        if (/\bunique\b/i.test(def)) { isUnique = true; def = def.replace(/\bunique\b/i, ' '); }
                        if (/\bauto_increment\b/i.test(def)) { autoInc = true; def = def.replace(/\bauto_increment\b/i, ' '); }
                        if (/\bnot\s+null\b/i.test(def)) { notNull = true; def = def.replace(/\bnot\s+null\b/i, ' '); }
                        const dm = def.match(/\bdefault\s+(\S+)/i);
                        if (dm) {
                            defaultVal = this._parseDefaultLiteral(dm[1], strMap);
                            def = def.replace(dm[0], ' ');
                        }
                        let parts = def.trim().split(/\s+/);
                        colDefs.push({ name: parts[0].toLowerCase(), type: parts.length > 1 && parts[1] ? parts[1].toUpperCase() : 'ANY', isPK, isUnique, notNull, autoInc, defaultVal, hasDefault: dm !== null });
                    }
                });

                if (colDefs.length === 0 || !colDefs[0].name) throw new Error("Syntax Error in CREATE TABLE.");

                const pkCandidates = [...new Set([...colDefs.filter(c => c.isPK).map(c => c.name), ...tableLevelPks])];
                if (pkCandidates.length > 1) throw new Error("Multiple PRIMARY KEY definitions are not allowed.");
                const primaryKey = pkCandidates.length === 1 ? pkCandidates[0] : null;
                const uniqueCols = [...new Set([...colDefs.filter(c => c.isUnique).map(c => c.name), ...tableLevelUniques])].filter(c => c !== primaryKey);
                [...tableLevelPks, ...tableLevelUniques].forEach(c => {
                    if (!colDefs.some(cd => cd.name === c)) throw new Error(`Column '${c}' not found for PRIMARY KEY/UNIQUE constraint.`);
                });

                const aiCols = colDefs.filter(c => c.autoInc);
                if (aiCols.length > 1) throw new Error("Multiple AUTO_INCREMENT columns are not allowed.");

                const t = new Table();
                colDefs.forEach(cd => t.addColumn(cd.name, cd.type));
                t.foreignKeys = foreignKeys;
                t.primaryKey = primaryKey;
                t.uniqueCols = uniqueCols;
                t.notNullCols = colDefs.filter(c => c.notNull).map(c => c.name);
                t.defaults = {};
                colDefs.forEach(cd => { if (cd.hasDefault) t.defaults[cd.name] = cd.defaultVal; });
                t.autoIncrementCol = aiCols.length === 1 ? aiCols[0].name : null;
                t.checks = checks.map(c => ({ name: c.name || null, expr: c.expr }));
                // 制約チェック高速化のため PK / UNIQUE 列へ自動でインデックスを作成
                [...(primaryKey ? [primaryKey] : []), ...uniqueCols].forEach(c => t.createIndex(c));
                this.tables[tableName] = t;
                resultSet = [{Result:"Success", Message:`Table '${tableName}' created.`}];
             } else throw new Error("Syntax Error in CREATE TABLE.");
          }
          else if (/^alter\s+table/i.test(sql)) {
             let m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+rename\s+column\s+([a-zA-Z0-9_]+)\s+to\s+([a-zA-Z0-9_]+)/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const oldCol = m[2].toLowerCase();
                 const newCol = m[3].toLowerCase();
                 if (!this.tables[table].cols[oldCol]) throw new Error(`Column '${oldCol}' not found.`);
                 if (this.tables[table].cols[newCol]) throw new Error(`Column '${newCol}' already exists.`);

                 this._logFullTable(table);
                 this.tables[table].renameColumn(oldCol, newCol);
                 resultSet = [{ Result: "Success", Message: `Column '${oldCol}' renamed to '${newCol}'.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+rename\s+to\s+([a-zA-Z0-9_]+)/i);
             if (m) {
                 const oldName = m[1].toLowerCase();
                 const newName = m[2].toLowerCase();
                 this._renameTable(oldName, newName);
                 resultSet = [{ Result: "Success", Message: `Table '${oldName}' renamed to '${newName}'.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             // --- 制約の追加/削除 (ADD/DROP PRIMARY KEY / UNIQUE / FOREIGN KEY) ---
             // 注意: 汎用の ADD/DROP COLUMN 正規表現より先に判定する必要がある
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+primary\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 if (t.primaryKey) throw new Error(`Table '${table}' already has a PRIMARY KEY on '${t.primaryKey}'.`);
                 // 既存データ検証: NULL と重複を拒否
                 const seen = new Set();
                 for (let i = 0; i < t.rowCount; i++) {
                     const v = t.getValue(col, i);
                     if (v === null || v === undefined) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in column '${col}'.`);
                     if (seen.has(v)) throw new Error(`PRIMARY KEY constraint failed: Duplicate value '${v}' in column '${col}'.`);
                     seen.add(v);
                 }
                 this._logTableMeta(table);
                 t.primaryKey = col;
                 t.uniqueCols = (t.uniqueCols || []).filter(c => c !== col);
                 t.createIndex(col);
                 return { data: [{ Result: "Success", Message: `PRIMARY KEY added on ${table}(${col}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+primary\s+key$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 if (!t.primaryKey) throw new Error(`Table '${table}' has no PRIMARY KEY.`);
                 const col = t.primaryKey;
                 this._logTableMeta(table);
                 t.primaryKey = null;
                 return { data: [{ Result: "Success", Message: `PRIMARY KEY on ${table}(${col}) dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+unique\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 // 既存データ検証: 非NULL値の重複を拒否
                 const seen = new Set();
                 for (let i = 0; i < t.rowCount; i++) {
                     const v = t.getValue(col, i);
                     if (v === null || v === undefined) continue;
                     if (seen.has(v)) throw new Error(`UNIQUE constraint failed: Duplicate value '${v}' in column '${col}'.`);
                     seen.add(v);
                 }
                 this._logTableMeta(table);
                 if (t.primaryKey !== col && !(t.uniqueCols || []).includes(col)) {
                     t.uniqueCols = (t.uniqueCols || []).concat([col]);
                 }
                 t.createIndex(col);
                 return { data: [{ Result: "Success", Message: `UNIQUE constraint added on ${table}(${col}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+unique\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!(t.uniqueCols || []).includes(col)) throw new Error(`UNIQUE constraint on '${col}' not found.`);
                 this._logTableMeta(table);
                 t.uniqueCols = t.uniqueCols.filter(c => c !== col);
                 return { data: [{ Result: "Success", Message: `UNIQUE constraint on ${table}(${col}) dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+foreign\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*references\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)([\s\S]*)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 const refTable = m[3].toLowerCase();
                 const refCol = m[4].toLowerCase();
                 const acts = this._parseFkActions(m[5]);
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 if (!this.tables[refTable]) throw new Error(`Table '${refTable}' not found.`);
                 if (!this.tables[refTable].cols[refCol]) throw new Error(`Column '${refCol}' not found in table '${refTable}'.`);
                 if ((t.foreignKeys || []).some(fk => fk.col === col)) throw new Error(`FOREIGN KEY on '${col}' already exists.`);
                 // 既存データ検証: 非NULL値が参照先に存在すること
                 const refTbl = this.tables[refTable];
                 for (let i = 0; i < t.rowCount; i++) {
                     const v = t.getValue(col, i);
                     if (v === null || v === undefined) continue;
                     if (refTbl.findValueRows(refCol, v).length === 0) {
                         throw new Error(`Foreign key constraint failed: Value '${v}' not found in ${refTable}(${refCol})`);
                     }
                 }
                 this._logTableMeta(table);
                 t.foreignKeys = (t.foreignKeys || []).concat([{ col, refTable, refCol, onDelete: acts.onDelete, onUpdate: acts.onUpdate }]);
                 return { data: [{ Result: "Success", Message: `FOREIGN KEY added: ${table}(${col}) -> ${refTable}(${refCol}).` }], affectedRows: 0 };
             }

             // ALTER TABLE ... ADD [CONSTRAINT name] CHECK (expr)
             m = sql.match(/^alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+(?:constraint\s+([a-zA-Z0-9_]+)\s+)?check\s*\(([\s\S]+)\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const name = m[2] ? m[2].toLowerCase() : null;
                 const expr = this._restoreStrings(m[3].trim(), strMap);
                 // 既存データ検証: 全行が CHECK を満たすこと
                 const sm = [];
                 const fn = this.compileCondition(this._maskStrings(expr, sm), sm);
                 const aliases = { [table]: table };
                 for (let i = 0; i < t.rowCount; i++) {
                     let ok; try { ok = fn({ [table]: i }, this.tables, aliases); } catch (e) { ok = false; }
                     if (!ok) throw new Error(`CHECK constraint failed: existing data violates CHECK (${expr}).`);
                 }
                 this._logTableMeta(table);
                 t.checks = (t.checks || []).concat([{ name, expr }]);
                 return { data: [{ Result: "Success", Message: `CHECK constraint added on '${table}'.` }], affectedRows: 0 };
             }

             // ALTER TABLE ... DROP {CHECK|CONSTRAINT} name
             m = sql.match(/^alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+(?:check|constraint)\s+([a-zA-Z0-9_]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const name = m[2].toLowerCase();
                 if (!(t.checks || []).some(c => c.name === name)) throw new Error(`CHECK constraint '${name}' not found.`);
                 this._logTableMeta(table);
                 t.checks = t.checks.filter(c => c.name !== name);
                 return { data: [{ Result: "Success", Message: `CHECK constraint '${name}' dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+foreign\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!(t.foreignKeys || []).some(fk => fk.col === col)) throw new Error(`FOREIGN KEY on '${col}' not found.`);
                 this._logTableMeta(table);
                 t.foreignKeys = t.foreignKeys.filter(fk => fk.col !== col);
                 return { data: [{ Result: "Success", Message: `FOREIGN KEY on ${table}(${col}) dropped.` }], affectedRows: 0 };
             }

             // --- 列属性の変更 (SET/DROP DEFAULT / SET/DROP NOT NULL) ---
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:alter|modify)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+set\s+default\s+(\S+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 // CREATE TABLE の DEFAULT と同じリテラル解釈
                 const defaultVal = this._parseDefaultLiteral(m[3], strMap);
                 this._logTableMeta(table);
                 t.defaults = t.defaults || {};
                 t.defaults[col] = defaultVal;
                 return { data: [{ Result: "Success", Message: `DEFAULT set on ${table}(${col}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:alter|modify)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+drop\s+default$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 this._logTableMeta(table);
                 if (t.defaults) delete t.defaults[col];
                 return { data: [{ Result: "Success", Message: `DEFAULT on ${table}(${col}) dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:alter|modify)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+set\s+not\s+null$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 // 既存データ検証: NULL が含まれていたら拒否
                 for (let i = 0; i < t.rowCount; i++) {
                     const v = t.getValue(col, i);
                     if (v === null || v === undefined) {
                         throw new Error(`NOT NULL constraint failed: Column '${col}' contains NULL values.`);
                     }
                 }
                 this._logTableMeta(table);
                 if (!(t.notNullCols || []).includes(col)) t.notNullCols = (t.notNullCols || []).concat([col]);
                 return { data: [{ Result: "Success", Message: `NOT NULL set on ${table}(${col}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:alter|modify)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+drop\s+not\s+null$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const col = m[2].toLowerCase();
                 if (!t.cols[col]) throw new Error(`Column '${col}' not found.`);
                 this._logTableMeta(table);
                 t.notNullCols = (t.notNullCols || []).filter(c => c !== col);
                 return { data: [{ Result: "Success", Message: `NOT NULL on ${table}(${col}) dropped.` }], affectedRows: 0 };
             }

             // MODIFY COLUMN / ALTER COLUMN: 既存カラムの型を変更（データは changeColumnType がキャスト）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:modify|alter)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+(?:type\s+)?([a-zA-Z]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const colName = m[2].toLowerCase();
                 if (!this.tables[table].cols[colName]) throw new Error(`Column '${colName}' not found.`);
                 const newType = m[3].toUpperCase();
                 const validTypes = ['INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'TEXT', 'ANY'];
                 if (!validTypes.includes(newType)) throw new Error(`Unknown type '${newType}'. Use ${validTypes.join('/')}.`);

                 // 型変更は文字列プールを作り直すため列 COW では巻き戻せない → 全体スナップショット
                 this._logFullTable(table);
                 this.tables[table].changeColumnType(colName, newType);
                 resultSet = [{ Result: "Success", Message: `Column '${colName}' type changed to ${newType}.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             // 制約キーワードを含む ADD/DROP が上記の専用構文に一致しなかった場合は構文エラー。
             // 汎用 ADD/DROP COLUMN に落ちて 'unique' 等の偽カラムが作られるのを防ぐ
             if (/^alter\s+table\s+[a-zA-Z0-9_]+\s+(?:add|drop)\s+(?:primary|unique|foreign|constraint|check)\b/i.test(sql)) {
                 throw new Error("Syntax Error in ALTER TABLE constraint clause. Supported: ADD/DROP PRIMARY KEY (col) / UNIQUE (col) / FOREIGN KEY (col) REFERENCES t(col) [ON DELETE/UPDATE ...] / ADD [CONSTRAINT name] CHECK (expr) / DROP CHECK name. Multi-column constraints are not supported.");
             }

             // ADD COLUMN name [type] [DEFAULT lit] [NOT NULL]（修飾子は順不同）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+(?:column\s+)?([\s\S]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);

                 let def = m[2].trim();
                 let notNull = false, hasDefault = false, defaultVal;
                 if (/\bnot\s+null\b/i.test(def)) { notNull = true; def = def.replace(/\bnot\s+null\b/i, ' '); }
                 const dm = def.match(/\bdefault\s+(\S+)/i);
                 if (dm) {
                     hasDefault = true;
                     defaultVal = this._parseDefaultLiteral(dm[1], strMap);
                     def = def.replace(dm[0], ' ');
                 }
                 const parts = def.trim().split(/\s+/);
                 if (parts.length > 2 || !parts[0]) throw new Error("Syntax Error in ALTER TABLE ADD COLUMN. Use ADD COLUMN name [type] [DEFAULT value] [NOT NULL].");
                 const colName = parts[0].toLowerCase();
                 if (this.tables[table].cols[colName]) throw new Error(`Column '${colName}' already exists.`);
                 const type = parts[1] ? parts[1].toUpperCase() : 'ANY';

                 const t = this.tables[table];
                 // 既存行が残る場合、NOT NULL 列は DEFAULT なしでは全行違反となるため拒否
                 if (notNull && !hasDefault && t.rowCount > 0) {
                     throw new Error(`NOT NULL constraint failed: Cannot add NOT NULL column '${colName}' without DEFAULT to a non-empty table.`);
                 }

                 this._logFullTable(table); // 列構成が変わるため全体スナップショット
                 t.addColumn(colName, type);
                 if (hasDefault && defaultVal !== null && defaultVal !== undefined) {
                     try {
                         for (let i = 0; i < t.rowCount; i++) t.setValue(colName, i, defaultVal);
                     } catch (e) {
                         // DEFAULT 値が型に合わない場合は列追加ごと取り消す
                         t.dropColumn(colName);
                         throw e;
                     }
                 }
                 if (hasDefault) {
                     t.defaults = t.defaults || {};
                     t.defaults[colName] = defaultVal;
                 }
                 if (notNull && !(t.notNullCols || []).includes(colName)) {
                     t.notNullCols = (t.notNullCols || []).concat([colName]);
                 }
                 resultSet = [{ Result: "Success", Message: `Column '${colName}' added.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+(?:column\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const colName = m[2].toLowerCase();
                 if (!this.tables[table].cols[colName]) throw new Error(`Column '${colName}' not found.`);

                 this._logFullTable(table); // 列構成が変わるため全体スナップショット
                 this.tables[table].dropColumn(colName);
                 resultSet = [{ Result: "Success", Message: `Column '${colName}' dropped.` }];
                 return { data: resultSet, affectedRows: 0 };
             }
             throw new Error("Syntax Error in ALTER TABLE.");
          }
          else if (/^rename\s+table/i.test(sql)) {
             const m = sql.match(/^rename\s+table\s+([a-zA-Z0-9_]+)\s+to\s+([a-zA-Z0-9_]+)$/i);
             if (!m) throw new Error("Syntax Error in RENAME TABLE. Use RENAME TABLE old TO new.");
             const oldName = m[1].toLowerCase();
             const newName = m[2].toLowerCase();
             this._renameTable(oldName, newName);
             resultSet = [{ Result: "Success", Message: `Table '${oldName}' renamed to '${newName}'.` }];
          }
          else if (/^truncate\b/i.test(sql)) {
             // TABLE キーワードは省略可 (TRUNCATE t / TRUNCATE TABLE t)
             const m = sql.match(/truncate\s+(?:table\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                const table = m[1].toLowerCase();
                if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                this._cowColumns(table, 'ALL');
                const t = this.tables[table];
                affectedRows = t.rowCount;
                t.rowCount = 0;
                if (Object.keys(t.indices).length > 0) t.rebuildIndices();
                resultSet = [{Result:"Success", Message:`${affectedRows} rows truncated.`}];
             } else throw new Error("Syntax Error in TRUNCATE TABLE.");
          }
          else if (/^drop\s+index/i.test(sql)) {
             // CREATE INDEX と対称の構文。インデックス名は列で管理しているため省略可
             const m = sql.match(/drop\s+index\s+(?:([a-zA-Z0-9_]+)\s+)?on\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)/i);
             if (m) {
                const table = m[2].toLowerCase();
                const col = m[3].toLowerCase();
                if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                if (!this.tables[table].indices[col]) throw new Error(`Index on '${table}(${col})' not found.`);
                this._logTableMeta(table);
                delete this.tables[table].indices[col];
                resultSet = [{ Result: "Success", Message: `Index on ${table}(${col}) dropped.` }];
             } else throw new Error("Syntax Error in DROP INDEX. Use DROP INDEX [name] ON table (col).");
          }
          else if (/^drop\s+view/i.test(sql)) {
             const m = sql.match(/drop\s+view\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                const name = m[2].toLowerCase();
                if (!this.views[name]) {
                    if (m[1]) return { data: [{ Result: "Success", Message: `View '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`View '${name}' not found.`);
                }
                this._logViewState(name);
                delete this.views[name];
                resultSet = [{Result:"Success", Message:`View '${name}' dropped.`}];
             } else throw new Error("Syntax Error in DROP VIEW.");
          }
          else if (/^drop\s+procedure/i.test(sql)) {
             const m = sql.match(/drop\s+procedure\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                const name = m[2].toLowerCase();
                if (!this.procedures[name]) {
                    if (m[1]) return { data: [{ Result: "Success", Message: `Procedure '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Procedure '${name}' not found.`);
                }
                this._logProcState(name);
                delete this.procedures[name];
                resultSet = [{Result:"Success", Message:`Procedure '${name}' dropped.`}];
             } else throw new Error("Syntax Error in DROP PROCEDURE.");
          }
          else if (/^drop\s+table/i.test(sql)) {
             const m = sql.match(/drop\s+table\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                const table = m[2].toLowerCase();
                if (!this.tables[table]) {
                    if (m[1]) return { data: [{ Result: "Success", Message: `Table '${table}' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Table '${table}' not found.`);
                }
                this._logDropTable(table);
                delete this.tables[table];
                resultSet = [{Result:"Success", Message:`Table '${table}' dropped.`}];
             } else throw new Error("Syntax Error in DROP TABLE.");
          }
          else if (/^(optimize|vacuum)/i.test(sql)) {
             // 実処理: 各テーブルの未参照文字列をGCし、予約容量を実データ量まで縮小する。
             // 文字列プールのインデックスを振り直すため、COWスナップショットと矛盾しないよう
             // トランザクション中は拒否する
             if (this.inTransaction) throw new Error("VACUUM/OPTIMIZE cannot run inside a transaction.");
             let freedStrings = 0;
             let freedCapacity = 0;
             for (const tn in this.tables) {
                 if (tn.startsWith('__tmp_')) continue;
                 const res = this.tables[tn].vacuum();
                 freedStrings += res.freedStrings;
                 freedCapacity += res.freedCapacity;
             }
             resultSet = [{Result:"Success", Message:`Database optimized. (${freedStrings} unused strings freed, capacity reduced by ${freedCapacity} slots)`}];
          }
          return { data: resultSet, affectedRows };
      }
    });
