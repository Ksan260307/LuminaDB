    // ============================================================================
    // [DatabaseEngine IO] - IndexedDB 用ダンプ / SQL エクスポート / ダミーデータ生成
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      exportForIDB() {
        let dump = Object.create(null); // キーはテーブル名（SQL由来）のため null プロトタイプ
        for(let tName in this.tables) {
          const t = this.tables[tName];
          if (t.isTemp) continue; // TEMPORARY テーブルは永続化しない
          dump[tName] = {
            rowCount: t.rowCount, capacity: t.capacity,
            strPools: t.strPools, strMaps: t.strMaps, cols: {},
            colTypes: t.colTypes,
            foreignKeys: t.foreignKeys,
            primaryKey: t.primaryKey,
            uniqueCols: t.uniqueCols,
            notNullCols: t.notNullCols,
            defaults: t.defaults,
            autoIncrementCol: t.autoIncrementCol,
            checks: t.checks,
            compositeKeys: t.compositeKeys,
            generatedCols: t.generatedCols,
            indexCols: Object.keys(t.indices)
          };
          for(let c in t.cols) {
            dump[tName].cols[c] = {
              num: t.cols[c].num.slice(0, t.rowCount),
              meta: t.cols[c].meta.slice(0, t.rowCount)
            };
          }
        }
        dump.__views__ = Object.assign({}, this.views);
        dump.__procedures__ = JSON.parse(JSON.stringify(this.procedures));
        dump.__triggers__ = JSON.parse(JSON.stringify(this.triggers));
        dump.__sequences__ = JSON.parse(JSON.stringify(this.sequences));
        dump.__comments__ = Object.assign({}, this.comments);
        dump.__matviews__ = JSON.parse(JSON.stringify(this.matViews));
        return dump;
      },

      importFromIDB(dump) {
        // 復元データのキーはユーザーデータ由来のため、null プロトタイプの辞書へコピーする
        this.tables = Object.create(null);
        this._attachEngineRef(); // 相関サブクエリ用のエンジン参照を張り直す
        this.views = Object.assign(Object.create(null), (dump && dump.__views__) || {});
        this.procedures = Object.assign(Object.create(null), (dump && dump.__procedures__) ? JSON.parse(JSON.stringify(dump.__procedures__)) : {});
        this.triggers = Object.assign(Object.create(null), (dump && dump.__triggers__) ? JSON.parse(JSON.stringify(dump.__triggers__)) : {});
        this.sequences = Object.assign(Object.create(null), (dump && dump.__sequences__) ? JSON.parse(JSON.stringify(dump.__sequences__)) : {});
        this.comments = Object.assign(Object.create(null), (dump && dump.__comments__) || {});
        this.matViews = Object.assign(Object.create(null), (dump && dump.__matviews__) ? JSON.parse(JSON.stringify(dump.__matviews__)) : {});
        for(let tName in dump) {
          if (tName.startsWith('__')) continue;
          const dt = dump[tName];
          const t = new Table(Math.max(dt.capacity, dt.rowCount));
          t.rowCount = dt.rowCount;
          for(let c in dt.cols) {
            t.addColumn(c, dt.colTypes && dt.colTypes[c] ? dt.colTypes[c] : 'ANY');
            t.cols[c].num.set(dt.cols[c].num);
            t.cols[c].meta.set(dt.cols[c].meta);
          }
          // strPools はコピーし、strMaps は保存データを信用せずプールから再構築する
          t.strPools = Object.create(null);
          t.strMaps = Object.create(null);
          for (const c in dt.strPools) {
            t.strPools[c] = [...dt.strPools[c]];
            const map = Object.create(null);
            t.strPools[c].forEach((s, i) => { map[s] = i; });
            t.strMaps[c] = map;
          }
          t.colTypes = Object.assign(Object.create(null), dt.colTypes || {});
          t.foreignKeys = dt.foreignKeys || [];
          t.primaryKey = dt.primaryKey || null;
          t.uniqueCols = dt.uniqueCols || [];
          t.notNullCols = dt.notNullCols || [];
          t.defaults = Object.assign(Object.create(null), dt.defaults || {});
          t.autoIncrementCol = dt.autoIncrementCol || null;
          t.checks = Array.isArray(dt.checks) ? dt.checks.map(c => ({ name: c.name || null, expr: c.expr })) : [];
          t.compositeKeys = Array.isArray(dt.compositeKeys) ? dt.compositeKeys.map(ck => ({ cols: [...ck.cols], isPK: !!ck.isPK })) : [];
          t.generatedCols = Object.assign(Object.create(null), dt.generatedCols || {});
          t.rebuildIndices();
          // PK / UNIQUE の自動インデックスに加え、ユーザー作成インデックスも復元する
          [...(t.primaryKey ? [t.primaryKey] : []), ...t.uniqueCols, ...(dt.indexCols || [])].forEach(c => { if (t.cols[c]) t.createIndex(c); });
          this.tables[tName] = t;
        }
      },

      // SQLテキストを ';' 区切りで文へ分割する（エンジン内蔵版）。
      // 文字列リテラル内の ';' は保護し、引用符二重化 ('') とバックスラッシュ
      // エスケープ (\') の両方を認識する。コメント (-- 行 / ブロック) 内も区切らない
      splitStatements(text) {
          const statements = [];
          let currentStmt = '';
          let inString = false;
          let stringChar = '';
          for (let i = 0; i < text.length; i++) {
              const char = text[i];
              if (inString) {
                  if (char === '\\') {
                      currentStmt += char;
                      if (i + 1 < text.length) { currentStmt += text[i + 1]; i++; }
                      continue;
                  }
                  if (char === stringChar) {
                      if (text[i + 1] === stringChar) {
                          currentStmt += char; i++;
                      } else {
                          inString = false;
                      }
                  }
                  currentStmt += char;
              } else {
                  if (char === '-' && text[i + 1] === '-') {
                      while (i < text.length && text[i] !== '\n') i++;
                      currentStmt += ' ';
                      continue;
                  }
                  if (char === '/' && text[i + 1] === '*') {
                      i += 2;
                      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                      i++;
                      currentStmt += ' ';
                      continue;
                  }
                  if (char === "'" || char === '"') {
                      inString = true;
                      stringChar = char;
                      currentStmt += char;
                  } else if (char === ';') {
                      if (currentStmt.trim() !== '') statements.push(currentStmt.trim());
                      currentStmt = '';
                  } else {
                      currentStmt += char;
                  }
              }
          }
          if (currentStmt.trim() !== '') statements.push(currentStmt.trim());
          return statements;
      },

      // 複数文をまとめて実行する（スクリプト実行）。エラーがあっても後続の文を実行し、
      // 文ごとの結果と成功/失敗数を返す
      executeScript(sqlText) {
          const statements = this.splitStatements(String(sqlText == null ? '' : sqlText));
          const results = statements.map(stmt => {
              const res = this.executeQuery(stmt);
              return { sql: stmt, ...res };
          });
          const succeeded = results.filter(r => !r.error).length;
          return { results, total: statements.length, succeeded, failed: statements.length - succeeded };
      },

      // 単一テーブルの CREATE TABLE 文を組み立てる（SHOW CREATE TABLE / exportSQL 共用）
      buildCreateTableSQL(tName) {
          const t = this.tables[tName];
          const cols = t.getColumnNames();
          const colDefs = cols.map(c => {
              let def = c + (t.colTypes[c] && t.colTypes[c] !== 'ANY' ? ` ${t.colTypes[c]}` : '');
              // 生成列は型のみ + GENERATED ALWAYS AS (expr) STORED（他の修飾は付かない）
              if (t.generatedCols && c in t.generatedCols) {
                  return def + ` GENERATED ALWAYS AS (${t.generatedCols[c]}) STORED`;
              }
              if (t.primaryKey === c) def += ' PRIMARY KEY';
              else if (t.uniqueCols && t.uniqueCols.includes(c)) def += ' UNIQUE';
              if (t.autoIncrementCol === c) def += ' AUTO_INCREMENT';
              if (t.notNullCols && t.notNullCols.includes(c)) def += ' NOT NULL';
              if (t.defaults && c in t.defaults) {
                  const dv = t.defaults[c];
                  def += ` DEFAULT ${this._isNowMarker(dv) ? 'CURRENT_TIMESTAMP' : (typeof dv === 'string' ? this._quoteLiteral(dv) : dv)}`;
              }
              return def;
          });

          if (t.foreignKeys && t.foreignKeys.length > 0) {
              t.foreignKeys.forEach(fk => {
                  let def = `FOREIGN KEY (${fk.col}) REFERENCES ${fk.refTable}(${fk.refCol})`;
                  // 既定(RESTRICT)以外の参照アクションのみ明示的に出力する
                  if (fk.onDelete && fk.onDelete !== 'RESTRICT') def += ` ON DELETE ${fk.onDelete}`;
                  if (fk.onUpdate && fk.onUpdate !== 'RESTRICT') def += ` ON UPDATE ${fk.onUpdate}`;
                  colDefs.push(def);
              });
          }
          if (t.compositeKeys && t.compositeKeys.length > 0) {
              t.compositeKeys.forEach(ck => {
                  colDefs.push(`${ck.isPK ? 'PRIMARY KEY' : 'UNIQUE'} (${ck.cols.join(', ')})`);
              });
          }
          if (t.checks && t.checks.length > 0) {
              t.checks.forEach(chk => {
                  colDefs.push(`${chk.name ? `CONSTRAINT ${chk.name} ` : ''}CHECK (${chk.expr})`);
              });
          }
          return `CREATE ${t.isTemp ? 'TEMPORARY ' : ''}TABLE ${tName} (${colDefs.join(', ')})`;
      },

      exportSQL() {
          let sqlLines = [];
          for (let tName in this.tables) {
              if (tName.startsWith('__tmp_')) continue;
              if (this.tables[tName].isTemp) continue; // TEMPORARY テーブルはエクスポート対象外
              const t = this.tables[tName];
              const cols = t.getColumnNames();
              sqlLines.push(`${this.buildCreateTableSQL(tName)};`);

              if (t.rowCount > 0) {
                  for (let i = 0; i < t.rowCount; i += 100) {
                      let values = [];
                      for (let j = i; j < Math.min(i + 100, t.rowCount); j++) {
                          let rowVals = cols.map(c => {
                              let meta = t.cols[c].meta[j];
                              let type = meta >>> 24;
                              if (type === 0) return 'NULL';
                              if (type === 1) return t.cols[c].num[j];
                              if (type === 3) return t.cols[c].num[j] === 1 ? 'TRUE' : 'FALSE';
                              if (type === 4) {
                                  let d = new Date(t.cols[c].num[j]);
                                  return `DATE('${d.toISOString().replace('T', ' ').slice(0, 19)}')`;
                              }
                              // 自パーサで再インポート可能なバックスラッシュ形式でエスケープする
                              let str = t.strPools[c][meta & 0xFFFFFF];
                              return this._quoteLiteral(str);
                          });
                          values.push(`(${rowVals.join(', ')})`);
                      }
                      sqlLines.push(`INSERT INTO ${tName} (${cols.join(', ')}) VALUES ${values.join(', ')};`);
                  }
              }

              for (let c in t.indices) {
                  sqlLines.push(`CREATE INDEX idx_${tName}_${c} ON ${tName} (${c});`);
              }
          }
          // ビュー定義を出力（プロシージャは本体に';'を含むためSQLエクスポート対象外）
          for (let vName in this.views) {
              sqlLines.push(`CREATE VIEW ${vName} AS ${this.views[vName]};`);
          }
          // シーケンス定義と現在値（SETVAL で再インポート時に採番位置を復元する）
          for (const sn in this.sequences) {
              const s = this.sequences[sn];
              sqlLines.push(`CREATE SEQUENCE ${sn} START WITH ${s.start} INCREMENT BY ${s.increment};`);
              if (s.value !== null) sqlLines.push(`SELECT SETVAL('${sn}', ${s.value});`);
          }
          return sqlLines.join('\n');
      },

      // ダミーデータ生成: 制約（PK/UNIQUE/FK/NOT NULL/型）を尊重した値を組み立て、
      // insertRows 経由で検証込みの一括挿入を行う（違反時は例外を送出）
      generateDummyData(tableName, count = 10000) {
        tableName = tableName.toLowerCase();
        const data = this.tables[tableName];
        if (!data) return 0;
        const cols = data.getColumnNames();
        if (cols.length === 0 || count <= 0) return 0;
        // FK列は「id系の名前」でも連番採番の対象にしない（参照先の実在値から選ぶ必要があるため）
        const fkColSet = new Set((data.foreignKeys || []).map(fk => fk.col));
        const idCol = cols.find(c => c.toLowerCase().includes('id') && !fkColSet.has(c));

        // 一意性が必要な列（PK / UNIQUE / AUTO_INCREMENT / id系）は連番採番で重複を防ぐ
        const uniqueCols = new Set(data.uniqueCols || []);
        if (data.primaryKey) uniqueCols.add(data.primaryKey);
        if (data.autoIncrementCol) uniqueCols.add(data.autoIncrementCol);
        if (idCol) uniqueCols.add(idCol);

        const seqState = Object.create(null);
        uniqueCols.forEach(c => {
            if (!cols.includes(c)) return;
            let maxId = 0;
            const existing = new Set();
            for (let i = 0; i < data.rowCount; i++) {
                const v = data.getValue(c, i);
                if (v !== null && v !== undefined) existing.add(v);
                if (typeof v === 'number' && v > maxId) maxId = v;
            }
            seqState[c] = { next: maxId + 1, existing };
        });

        // FK列は参照先の実在値から選ぶ（参照先が空だとFKを満たせないため生成不可）
        const fkPick = Object.create(null);
        for (const fk of (data.foreignKeys || [])) {
            if (seqState[fk.col]) continue; // 一意列は連番採番を優先
            const refTbl = this.tables[fk.refTable];
            if (!refTbl) return 0;
            const vals = [];
            for (let i = 0; i < refTbl.rowCount; i++) {
                const v = refTbl.getValue(fk.refCol, i);
                if (v !== null && v !== undefined) vals.push(v);
            }
            if (vals.length === 0) return 0;
            fkPick[fk.col] = vals;
        }

        const valuesList = [];
        for (let i = 0; i < count; i++) {
            valuesList.push(cols.map(col => {
                const type = data.colTypes[col] || 'ANY';
                if (seqState[col]) {
                    const st = seqState[col];
                    let v;
                    do {
                        const seq = st.next++;
                        if (type === 'TEXT') v = `Uniq_${seq}`;
                        else if (type === 'DATE') v = new Date(Date.UTC(2000, 0, 1) + seq * 86400000);
                        else v = seq;
                    } while (st.existing.has(v));
                    st.existing.add(v);
                    return v;
                }
                if (fkPick[col]) return fkPick[col][Math.floor(Math.random() * fkPick[col].length)];
                if (type === 'INTEGER') return Math.floor(Math.random() * 1000);
                if (type === 'FLOAT') return Math.round(Math.random() * 100000) / 100;
                if (type === 'BOOLEAN') return Math.random() < 0.5;
                if (type === 'DATE') return new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 2000) * 86400000);
                if (col === 'name') return "Dummy_" + Math.floor(Math.random() * 100000);
                if (col === 'age') return 20 + Math.floor(Math.random() * 50);
                if (col === 'price') return Math.floor(Math.random() * 1000) * 10;
                if (col === 'stock' || col === 'amount') return Math.floor(Math.random() * 100);
                return "Data_" + Math.floor(Math.random() * 1000);
            }));
        }

        return this.insertRows(tableName, cols, valuesList);
      }
    });
