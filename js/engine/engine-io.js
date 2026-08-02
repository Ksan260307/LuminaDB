    // ============================================================================
    // [DatabaseEngine IO] - IndexedDB 用ダンプ / SQL エクスポート / ダミーデータ生成
    // ============================================================================
    Object.assign(DatabaseEngine.prototype, {

      exportForIDB() {
        let dump = Object.create(null); // キーはテーブル名（SQL由来）のため null プロトタイプ
        // 列名も SQL 由来なので '__proto__' という列名を持つ表が存在し得る。
        // for..in と素の {} を使うと (a) 汚染済み Object.prototype の余計なキーを拾い、
        // (b) cols['__proto__'] = x がプロトタイプ差し替えになって列が消えるため、
        // Object.keys と null プロトタイプ辞書で組み立てる
        for(const tName of Object.keys(this.tables)) {
          const t = this.tables[tName];
          if (t.isTemp) continue; // TEMPORARY テーブルは永続化しない
          dump[tName] = {
            rowCount: t.rowCount, capacity: t.capacity,
            strPools: t.strPools, strMaps: t.strMaps, cols: Object.create(null),
            colTypes: t.colTypes,
            foreignKeys: t.foreignKeys,
            primaryKey: t.primaryKey,
            uniqueCols: t.uniqueCols,
            notNullCols: t.notNullCols,
            defaults: t.defaults,
            autoIncrementCol: t.autoIncrementCol,
            checks: t.checks,
            compositeKeys: t.compositeKeys,
            constraintNames: t.constraintNames,
            generatedCols: t.generatedCols,
            onUpdateNowCols: t.onUpdateNowCols || [],
            identityFloor: t.identityFloor || 1,
            collations: t.collations,
            // 差分保存用の指紋。前回保存時と同じなら中身は書き直さない
            // （変更世代・行数・容量の3点。値の上書きは version、行の増減は rowCount が拾う）
            fp: `${t.version || 0}:${t.rowCount}:${t.capacity}`,
            indexCols: Object.keys(t.indices)
          };
          for(const c of Object.keys(t.cols)) {
            dump[tName].cols[c] = {
              num: t.cols[c].num.slice(0, t.rowCount),
              meta: t.cols[c].meta.slice(0, t.rowCount)
            };
          }
        }
        dump.__views__ = Object.assign(Object.create(null), this.views);
        dump.__viewmeta__ = JSON.parse(JSON.stringify(this.viewMeta || {}));
        dump.__domains__ = JSON.parse(JSON.stringify(this.domains || {}));
        dump.__procedures__ = JSON.parse(JSON.stringify(this.procedures));
        dump.__triggers__ = JSON.parse(JSON.stringify(this.triggers));
        dump.__sequences__ = JSON.parse(JSON.stringify(this.sequences));
        dump.__comments__ = Object.assign(Object.create(null), this.comments);
        dump.__matviews__ = JSON.parse(JSON.stringify(this.matViews));
        dump.__functions__ = JSON.parse(JSON.stringify(this.functions));
        dump.__procparams__ = JSON.parse(JSON.stringify(this.procParams || {}));
        dump.__userversion__ = this.userVersion || 0;
        return dump;
      },

      importFromIDB(dump) {
        // 復元データのキーはユーザーデータ由来のため、null プロトタイプの辞書へコピーする
        this.tables = Object.create(null);
        this._attachEngineRef(); // 相関サブクエリ用のエンジン参照を張り直す
        this.views = Object.assign(Object.create(null), (dump && dump.__views__) || {});
        this.viewMeta = Object.assign(Object.create(null), (dump && dump.__viewmeta__) ? JSON.parse(JSON.stringify(dump.__viewmeta__)) : {});
        this.domains = Object.assign(Object.create(null), (dump && dump.__domains__) ? JSON.parse(JSON.stringify(dump.__domains__)) : {});
        this.procedures = Object.assign(Object.create(null), (dump && dump.__procedures__) ? JSON.parse(JSON.stringify(dump.__procedures__)) : {});
        this.triggers = Object.assign(Object.create(null), (dump && dump.__triggers__) ? JSON.parse(JSON.stringify(dump.__triggers__)) : {});
        this.sequences = Object.assign(Object.create(null), (dump && dump.__sequences__) ? JSON.parse(JSON.stringify(dump.__sequences__)) : {});
        this.comments = Object.assign(Object.create(null), (dump && dump.__comments__) || {});
        this.matViews = Object.assign(Object.create(null), (dump && dump.__matviews__) ? JSON.parse(JSON.stringify(dump.__matviews__)) : {});
        this.functions = Object.assign(Object.create(null), (dump && dump.__functions__) ? JSON.parse(JSON.stringify(dump.__functions__)) : {});
        this.procParams = Object.assign(Object.create(null), (dump && dump.__procparams__) ? JSON.parse(JSON.stringify(dump.__procparams__)) : {});
        this.userVersion = (dump && typeof dump.__userversion__ === 'number') ? dump.__userversion__ : 0;
        // for..in ではなく Object.keys（汚染された Object.prototype のキーを拾わないため）
        for(const tName of Object.keys(dump)) {
          if (tName.startsWith('__')) continue;
          const dt = dump[tName];
          const t = new Table(Math.max(dt.capacity, dt.rowCount));
          t.rowCount = dt.rowCount;
          for(const c of Object.keys(dt.cols || {})) {
            t.addColumn(c, dt.colTypes && dt.colTypes[c] ? dt.colTypes[c] : 'ANY');
            t.cols[c].num.set(dt.cols[c].num);
            t.cols[c].meta.set(dt.cols[c].meta);
          }
          // strPools はコピーし、strMaps は保存データを信用せずプールから再構築する
          t.strPools = Object.create(null);
          t.strMaps = Object.create(null);
          for (const c of Object.keys(dt.strPools || {})) {
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
          t.onUpdateNowCols = Array.isArray(dt.onUpdateNowCols) ? [...dt.onUpdateNowCols] : [];
          t.constraintNames = Object.assign(Object.create(null), dt.constraintNames || {});
          t.identityFloor = dt.identityFloor || 1;
          t.collations = Object.assign(Object.create(null), dt.collations || {});
          t.rebuildIndices();
          // PK / UNIQUE の自動インデックスに加え、ユーザー作成インデックスも復元する
          [...(t.primaryKey ? [t.primaryKey] : []), ...t.uniqueCols, ...(dt.indexCols || [])].forEach(c => { if (t.cols[c]) t.createIndex(c); });
          this.tables[tName] = t;
        }
      },

      // SQLテキストを ';' 区切りで文へ分割する（エンジン内蔵版）。
      // 文字列リテラル内の ';' は保護し、引用符二重化 ('') とバックスラッシュ
      // エスケープ (\') の両方を認識する。コメント (-- 行 / ブロック) 内も区切らない
      // ルーチン定義 (CREATE PROCEDURE / TRIGGER / FUNCTION) の本体は ';' を含むので、
      // BEGIN...END や IF...END IF のブロックが閉じるまで文を切らない。
      // トランザクションの BEGIN と取り違えないよう、「今組み立て中の文がルーチン定義か」
      // で判定する（素の BEGIN; INSERT; COMMIT; は従来どおり 3 文に割れる）
      _isRoutineDef(text) {
          return /^\s*create\s+(?:or\s+replace\s+)?(?:procedure|trigger|function)\b/i.test(text);
      },

      splitStatements(text) {
          const statements = [];
          let currentStmt = '';
          let inString = false;
          let stringChar = '';
          let blockDepth = 0;
          const isWordChar = (ch) => /[a-zA-Z0-9_]/.test(ch);
          for (let i = 0; i < text.length; i++) {
              const char = text[i];
              // ルーチン定義の中だけブロックの開閉を数える
              if (!inString && isWordChar(char) && (i === 0 || !isWordChar(text[i - 1])) && this._isRoutineDef(currentStmt)) {
                  let j = i;
                  while (j < text.length && isWordChar(text[j])) j++;
                  const w = text.slice(i, j).toUpperCase();
                  if (w === 'END') {
                      blockDepth--;
                      const em = /^\s+(IF|WHILE|LOOP|REPEAT|CASE)\b/i.exec(text.slice(j));
                      if (em) { currentStmt += text.slice(i, j + em[0].length); i = j + em[0].length - 1; continue; }
                  } else if (['BEGIN', 'IF', 'WHILE', 'LOOP', 'REPEAT', 'CASE'].includes(w)) {
                      blockDepth++;
                  }
                  currentStmt += text.slice(i, j);
                  i = j - 1;
                  continue;
              }
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
                  } else if (char === ';' && blockDepth <= 0) {
                      if (currentStmt.trim() !== '') statements.push(currentStmt.trim());
                      currentStmt = '';
                      blockDepth = 0;
                  } else if (char === ';') {
                      // ルーチン本体の中の ';' は文の区切りではないのでそのまま取り込む
                      currentStmt += char;
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
              if (t.collations && t.collations[c]) def += ` COLLATE ${t.collations[c]}`;
              if (t.primaryKey === c) def += ' PRIMARY KEY';
              else if (t.uniqueCols && t.uniqueCols.includes(c)) def += ' UNIQUE';
              if (t.autoIncrementCol === c) def += ' AUTO_INCREMENT';
              if (t.notNullCols && t.notNullCols.includes(c)) def += ' NOT NULL';
              if (t.defaults && c in t.defaults) {
                  const dv = t.defaults[c];
                  // 式 DEFAULT はテキストのまま、文字列リテラルは引用して出す
                  def += ` DEFAULT ${this._isNowMarker(dv) ? 'CURRENT_TIMESTAMP'
                      : (this._isExprDefault(dv) ? dv.__expr : (typeof dv === 'string' ? this._quoteLiteral(dv) : dv))}`;
              }
              return def;
          });

          if (t.foreignKeys && t.foreignKeys.length > 0) {
              t.foreignKeys.forEach(fk => {
                  // 複合 FK は { cols, refCols }、単一列は { col, refCol }
                  const fkCols = (fk.cols || [fk.col]).join(', ');
                  const refCols = (fk.refCols || [fk.refCol]).join(', ');
                  let def = `${fk.name ? `CONSTRAINT ${fk.name} ` : ''}FOREIGN KEY (${fkCols}) REFERENCES ${fk.refTable}(${refCols})`;
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
              const vm = (this.viewMeta && this.viewMeta[vName]) ? ` WITH ${this.viewMeta[vName].checkOption} CHECK OPTION` : '';
              sqlLines.push(`CREATE VIEW ${vName} AS ${this.views[vName]}${vm};`);
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
