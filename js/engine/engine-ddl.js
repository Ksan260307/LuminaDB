    // ============================================================================
    // [DatabaseEngine DDL] - CREATE / ALTER / DROP / TRUNCATE / プロシージャ実行
    // ============================================================================

    // SHOW FUNCTIONS 用の関数レジストリ（カテゴリ -> 空白区切りの関数名）。
    // エンジンへ関数を追加したらここにも登録する
    const LUMINA_FN_REGISTRY = {
        'String': 'UPPER LOWER LENGTH LEN CHAR_LENGTH CHARACTER_LENGTH OCTET_LENGTH BIT_LENGTH CONCAT CONCAT_WS SUBSTRING SUBSTR MID SUBSTRING_INDEX LEFT RIGHT LPAD RPAD TRIM LTRIM RTRIM REPLACE REPLICATE REVERSE REPEAT INSTR STRPOS LOCATE POSITION CHARINDEX PATINDEX ASCII CHAR CHR SPACE STRCMP ELT FIELD INITCAP UCASE LCASE FORMAT HEX UNHEX BIN OCT CONV QUOTE QUOTENAME QUOTE_IDENT QUOTE_LITERAL SPLIT_PART TRANSLATE INSERT STUFF OVERLAY PARSENAME SOUNDEX STARTS_WITH ENDS_WITH',
        'Regexp': 'REGEXP_REPLACE REGEXP_SUBSTR REGEXP_LIKE REGEXP_COUNT REGEXP_INSTR',
        'Numeric': 'ABS CEIL CEILING FLOOR ROUND TRUNCATE TRUNC MOD REMAINDER SIGN POWER POW SQUARE SQRT CBRT EXP LN LOG LOG10 LOG2 PI RAND RANDOM SIN COS TAN COT SINH COSH TANH ASIN ACOS ATAN ATAN2 DEGREES RADIANS GREATEST LEAST GCD LCM FACTORIAL WIDTH_BUCKET NANVL BITAND BITOR BITXOR BITNOT SHIFTLEFT SHIFTRIGHT ISNUMERIC BIT_COUNT CRC32 FORMAT_BYTES',
        'Date & Time': 'NOW CURRENT_TIMESTAMP SYSDATE SYSTIMESTAMP GETDATE GETUTCDATE SYSDATETIME SYSUTCDATETIME UTC_TIMESTAMP CURDATE CURRENT_DATE UTC_DATE CURTIME CURRENT_TIME DATE TIME YEAR MONTH DAY DAYOFMONTH HOUR MINUTE SECOND DAYOFWEEK DAYOFYEAR WEEKDAY WEEK WEEKOFYEAR QUARTER MONTHNAME DAYNAME LAST_DAY EOMONTH NEXT_DAY DATEDIFF DATEADD DATEPART DATENAME DATE_ADD DATE_SUB ADD_MONTHS MONTHS_BETWEEN ADDDATE SUBDATE EXTRACT DATE_PART TIMESTAMPDIFF TIMESTAMPADD DATE_FORMAT STR_TO_DATE UNIX_TIMESTAMP FROM_UNIXTIME SEC_TO_TIME TIME_TO_SEC MAKEDATE MAKETIME MAKE_DATE MAKE_TIMESTAMP TO_DAYS FROM_DAYS DATE_TRUNC',
        'JSON': 'JSON_EXTRACT JSON_VALUE JSON_ARRAY JSON_OBJECT JSON_LENGTH JSON_KEYS JSON_VALID JSON_TYPE JSON_CONTAINS JSON_SET JSON_REMOVE JSON_PRETTY JSON_QUOTE JSON_UNQUOTE JSON_ARRAY_APPEND JSON_MERGE_PATCH JSON_DEPTH',
        'Null & Flow': 'COALESCE IFNULL ISNULL NVL NVL2 ZEROIFNULL NULLIFZERO NULLIF DECODE CHOOSE IF IIF CASE CAST CONVERT TRY_CAST TRY_CONVERT',
        'Conversion': 'CAST CONVERT TRY_CAST TRY_CONVERT TO_NUMBER TO_CHAR TO_HEX TO_DATE TO_TIMESTAMP',
        'Encoding & Hash': 'MD5 SHA1 TO_BASE64 FROM_BASE64 INET_ATON INET_NTOA',
        'Aggregate': 'COUNT SUM AVG MAX MIN GROUP_CONCAT STRING_AGG LISTAGG ARRAY_AGG STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP MEDIAN BIT_AND BIT_OR BIT_XOR BOOL_AND BOOL_OR CORR COVAR_POP COVAR_SAMP ANY_VALUE JSON_ARRAYAGG JSON_OBJECTAGG MIN_BY MAX_BY COUNT_IF PERCENTILE_CONT PERCENTILE_DISC GROUPING',
        'Window': 'ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE FIRST_VALUE LAST_VALUE NTH_VALUE PERCENT_RANK CUME_DIST',
        'Sequence': 'NEXTVAL CURRVAL SETVAL',
        'Meta': 'UUID NEWID SYS_GUID VERSION DATABASE CURRENT_SCHEMA SCHEMA_NAME USER CURRENT_USER SESSION_USER SYSTEM_USER SUSER_NAME LAST_INSERT_ID TYPEOF'
    };

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
          // CURRENT_TIMESTAMP / NOW(): 挿入時に評価するマーカーとして保存する
          if (/^(?:current_timestamp|now\(\))$/i.test(raw)) return { __currentTimestamp: true };
          const strM = raw.match(/^__STR_(\d+)__$/);
          if (strM && strMap) return this._unquoteLiteral(strMap[Number(strM[1])]);
          if (raw.toLowerCase() === 'null') return null;
          if (raw.toLowerCase() === 'true') return true;
          if (raw.toLowerCase() === 'false') return false;
          if (!isNaN(raw)) return Number(raw);
          return raw;
      },

      // DEFAULT CURRENT_TIMESTAMP のマーカー判定と現在時刻文字列
      _isNowMarker(v) {
          return !!(v && typeof v === 'object' && v.__currentTimestamp === true);
      },
      _nowString() {
          return new Date().toISOString().replace('T', ' ').slice(0, 19);
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

      // SET @name = <式>[, @name2 = ...]: ユーザー変数の代入（セッション限り・保存対象外）
      _executeSetVar(sql, strMap) {
          const body = sql.replace(/^set\s+/i, '');
          const names = [];
          this.splitSelectClause(body).forEach(p => {
              const m = p.match(/^\s*@([a-zA-Z_][a-zA-Z0-9_]*)\s*:?=\s*([\s\S]+)$/);
              if (!m) throw new Error("Syntax Error in SET. Use SET @name = <expression>[, @name2 = ...].");
              const name = m[1].toLowerCase();
              const fn = this.compileCondition(m[2].trim(), strMap);
              let v = fn({}, this.tables, {});
              if (v instanceof Date) v = isNaN(v.getTime()) ? null : v.toISOString().replace('T', ' ').slice(0, 19);
              this.userVars[name] = v === undefined ? null : v;
              names.push(name);
          });
          return { data: [{ Result: "Success", Message: `Variable${names.length > 1 ? 's' : ''} @${names.join(', @')} set.` }], affectedRows: 0 };
      },

      // ============ プリペアドステートメント (PREPARE / EXECUTE / DEALLOCATE) ============

      // 保存済みSQLの '?' プレースホルダを値リテラルへ置換する（文字列リテラル内は保護）
      _bindPlaceholders(text, vals) {
          const sm = [];
          let s = this._maskStrings(text, sm);
          let idx = 0;
          s = s.replace(/\?/g, () => {
              if (idx >= vals.length) throw new Error(`EXECUTE: placeholder #${idx + 1} has no value (${vals.length} given).`);
              const v = vals[idx++];
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
              if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
              sm.push(this._quoteLiteral(String(v)));
              return `__STR_${sm.length - 1}__`;
          });
          if (idx < vals.length) throw new Error(`EXECUTE: ${vals.length} values given but only ${idx} placeholders found.`);
          return this._restoreStrings(s, sm);
      },

      // PREPARE name FROM '<sql>' / EXECUTE name [USING v1, v2, ...] / DEALLOCATE [PREPARE] name
      // ステートメントはセッション限り・非トランザクション（MySQL 互換）
      _executePrepared(sql, strMap) {
          let m = sql.match(/^prepare\s+([a-zA-Z0-9_]+)\s+from\s+__STR_(\d+)__$/i);
          if (m) {
              if (!strMap) throw new Error("Syntax Error in PREPARE.");
              const name = m[1].toLowerCase();
              const text = this._unquoteLiteral(strMap[Number(m[2])]);
              if (text.trim() === '') throw new Error("Prepared statement body is empty.");
              this.prepared[name] = text;
              return { data: [{ Result: 'Success', Message: `Statement '${name}' prepared.` }], affectedRows: 0 };
          }
          m = sql.match(/^execute\s+([a-zA-Z0-9_]+)(?:\s+using\s+([\s\S]+))?$/i);
          if (m) {
              const name = m[1].toLowerCase();
              const text = this.prepared[name];
              if (!text) {
                  const s2 = this._suggestName(name, Object.keys(this.prepared));
                  throw new Error(`Prepared statement '${name}' not found.${s2 ? ` Did you mean '${s2}'?` : ''}`);
              }
              let vals = [];
              if (m[2]) {
                  // USING の各値は定数式（リテラル / ユーザー変数 / 関数）として評価する
                  vals = this.splitSelectClause(m[2]).map(p => {
                      const fn = this.compileCondition(p.trim(), strMap);
                      const v = fn({}, this.tables, {});
                      return v === undefined ? null : v;
                  });
              }
              const bound = this._bindPlaceholders(text, vals);
              // EXECUTE が自分自身を呼ぶ再帰を深度制限で遮断する
              this._execDepth = (this._execDepth || 0) + 1;
              try {
                  if (this._execDepth > 8) throw new Error("EXECUTE nesting depth limit (8) exceeded.");
                  const r = this.executeQuery(bound);
                  if (r.error) throw new Error(`EXECUTE '${name}': ${r.error}`);
                  return { data: r.data, affectedRows: r.scannedRows || 0 };
              } finally {
                  this._execDepth--;
              }
          }
          m = sql.match(/^deallocate\s+(?:prepare\s+)?([a-zA-Z0-9_]+)$/i);
          if (m) {
              const name = m[1].toLowerCase();
              if (!this.prepared[name]) throw new Error(`Prepared statement '${name}' not found.`);
              delete this.prepared[name];
              return { data: [{ Result: 'Success', Message: `Statement '${name}' deallocated.` }], affectedRows: 0 };
          }
          throw new Error("Syntax Error. Use PREPARE name FROM '<sql>' / EXECUTE name [USING v1, ...] / DEALLOCATE PREPARE name.");
      },

      // ============ シーケンス (CREATE SEQUENCE / NEXTVAL / CURRVAL / SETVAL) ============
      // 値の採番は実DBと同様に非トランザクション（ROLLBACK しても戻らない）。
      // 定義の作成/削除のみ undo ログ対象（_logSeqState）

      _seqNext(name) {
          const s = this.sequences[String(name).toLowerCase()];
          if (!s) throw new Error(`Sequence '${name}' not found.`);
          s.value = s.value === null ? s.start : s.value + s.increment;
          return s.value;
      },

      // まだ NEXTVAL が呼ばれていないシーケンスの CURRVAL は NULL
      _seqCurr(name) {
          const s = this.sequences[String(name).toLowerCase()];
          if (!s) throw new Error(`Sequence '${name}' not found.`);
          return s.value;
      },

      _seqSet(name, v) {
          const s = this.sequences[String(name).toLowerCase()];
          if (!s) throw new Error(`Sequence '${name}' not found.`);
          const n = Math.trunc(Number(v));
          if (isNaN(n)) return null;
          s.value = n;
          return n;
      },

      // SHOW TABLES / VIEWS / PROCEDURES: メタ情報の一覧
      _executeShow(sql, strMap) {
          // SHOW MATERIALIZED VIEWS: 実体化ビューの一覧（行数と定義）
          if (/^show\s+materialized\s+views$/i.test(sql.trim())) {
              const data = Object.keys(this.matViews).map(n => ({
                  View: n,
                  Rows: this.tables[n] ? this.tables[n].rowCount : 0,
                  Definition: this.matViews[n].sql
              }));
              return { data, affectedRows: data.length };
          }
          // SHOW COMMENTS: COMMENT ON で付与した注釈の一覧
          if (/^show\s+comments$/i.test(sql.trim())) {
              const data = Object.keys(this.comments).map(k => {
                  const i = k.indexOf(':');
                  return { Kind: k.slice(0, i).toUpperCase(), Object: k.slice(i + 1), Comment: this.comments[k] };
              });
              return { data, affectedRows: data.length };
          }
          // SHOW SETTINGS: セッション設定（SET TRANSACTION 等で受理した値）
          if (/^show\s+settings$/i.test(sql.trim())) {
              const s = this.sessionSettings;
              const data = Object.keys(s).map(k => ({ Setting: k, Value: String(s[k]) }));
              data.push({ Setting: 'effective_isolation', Value: 'SERIALIZABLE' });
              return { data, affectedRows: data.length };
          }
          // SHOW STORAGE: ブラウザ内DBの実データ規模（永続化サイズの見積り）。
          // 数値列は Float64、文字列はプール実測長で概算する
          if (/^show\s+storage$/i.test(sql.trim())) {
              let totalRows = 0, totalBytes = 0, strBytes = 0;
              const names = Object.keys(this.tables).filter(t => !t.startsWith('__tmp_'));
              names.forEach(t => {
                  const tb = this.tables[t];
                  const nCols = tb.getColumnNames().length;
                  totalRows += tb.rowCount;
                  totalBytes += tb.rowCount * nCols * 8; // num(Float64)
                  totalBytes += tb.rowCount * nCols * 4; // meta(Int32)
                  for (const c in tb.strPools) {
                      (tb.strPools[c] || []).forEach(s => { strBytes += (s ? String(s).length : 0) * 2; });
                  }
              });
              totalBytes += strBytes;
              const data = [
                  { Metric: 'tables', Value: String(names.length) },
                  { Metric: 'rows', Value: String(totalRows) },
                  { Metric: 'string_pool_bytes', Value: String(strBytes) },
                  { Metric: 'estimated_bytes', Value: String(totalBytes) },
                  { Metric: 'estimated_mb', Value: (totalBytes / 1048576).toFixed(3) },
                  { Metric: 'views', Value: String(Object.keys(this.views).length) },
                  { Metric: 'materialized_views', Value: String(Object.keys(this.matViews).length) },
                  { Metric: 'sequences', Value: String(Object.keys(this.sequences).length) },
                  { Metric: 'triggers', Value: String(Object.keys(this.triggers).length) }
              ];
              return { data, affectedRows: data.length };
          }
          if (/^show\s+tables$/i.test(sql.trim())) {
              const data = Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_'))
                  .map(t => ({ Table: t, Rows: this.tables[t].rowCount, Columns: this.tables[t].getColumnNames().length, Temp: !!this.tables[t].isTemp }));
              return { data, affectedRows: data.length };
          }
          // SHOW TABLES LIKE 'pattern': % と _ をワイルドカードとして絞り込み
          const tlikeM = sql.trim().match(/^show\s+tables\s+like\s+__STR_(\d+)__$/i);
          if (tlikeM && strMap) {
              const pat = this._unquoteLiteral(strMap[Number(tlikeM[1])]);
              const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              const data = Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && re.test(t))
                  .map(t => ({ Table: t, Rows: this.tables[t].rowCount, Columns: this.tables[t].getColumnNames().length, Temp: !!this.tables[t].isTemp }));
              return { data, affectedRows: data.length };
          }
          // SHOW FUNCTIONS [LIKE 'pattern']: 対応しているSQL関数の一覧
          const fnM = sql.trim().match(/^show\s+functions(?:\s+like\s+__STR_(\d+)__)?$/i);
          if (fnM) {
              let re = null;
              if (fnM[1] !== undefined && strMap) {
                  const pat = this._unquoteLiteral(strMap[Number(fnM[1])]);
                  re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              }
              const data = [];
              Object.keys(LUMINA_FN_REGISTRY).forEach(cat => {
                  LUMINA_FN_REGISTRY[cat].split(' ').forEach(fn => {
                      if (!re || re.test(fn)) data.push({ Function: fn, Category: cat });
                  });
              });
              data.sort((a, b) => a.Function < b.Function ? -1 : (a.Function > b.Function ? 1 : 0));
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
          const trgM = sql.trim().match(/^show\s+triggers(?:\s+from\s+([a-zA-Z0-9_]+))?$/i);
          if (trgM) {
              const target = trgM[1] ? trgM[1].toLowerCase() : null;
              if (target && !this.tables[target]) throw this._tableNotFound(target);
              const data = Object.keys(this.triggers)
                  .filter(n => !target || this.triggers[n].table === target)
                  .map(n => {
                      const tg = this.triggers[n];
                      return { Trigger: n, Timing: tg.timing.toUpperCase(), Event: tg.event.toUpperCase(), Table: tg.table, Statements: tg.statements.length };
                  });
              return { data, affectedRows: data.length };
          }
          if (/^show\s+variables$/i.test(sql.trim())) {
              const data = Object.keys(this.userVars).map(k => ({ Variable: '@' + k, Value: this.userVars[k] }));
              return { data, affectedRows: data.length };
          }
          if (/^show\s+sequences$/i.test(sql.trim())) {
              const data = Object.keys(this.sequences).map(n => {
                  const s = this.sequences[n];
                  return { Sequence: n, Start: s.start, Increment: s.increment, Value: s.value };
              });
              return { data, affectedRows: data.length };
          }
          if (/^show\s+prepared$/i.test(sql.trim())) {
              const data = Object.keys(this.prepared).map(n => ({ Statement: n, Sql: this.prepared[n] }));
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
          // SHOW CHECKS [FROM table]: CHECK 制約の一覧
          const chkM = sql.trim().match(/^show\s+checks(?:\s+from\s+([a-zA-Z0-9_]+))?$/i);
          if (chkM) {
              const target = chkM[1] ? chkM[1].toLowerCase() : null;
              if (target && !this.tables[target]) throw new Error(`Table '${target}' not found.`);
              const data = [];
              Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && (!target || t === target))
                  .forEach(t => {
                      (this.tables[t].checks || []).forEach(chk => {
                          data.push({ Table: t, Name: chk.name || '', Expression: chk.expr });
                      });
                  });
              return { data, affectedRows: data.length };
          }
          const scpM = sql.trim().match(/^show\s+create\s+procedure\s+([a-zA-Z0-9_]+)$/i);
          if (scpM) {
              const name = scpM[1].toLowerCase();
              if (!this.procedures[name]) throw new Error(`Procedure '${name}' not found.`);
              return { data: [{ Procedure: name, CreateProcedure: `CREATE PROCEDURE ${name} AS BEGIN ${this.procedures[name].join('; ')} END` }], affectedRows: 1 };
          }
          // SHOW STATUS: データベース全体のサマリ（テーブル数 / 総行数 / 推定メモリ量など）
          if (/^show\s+status$/i.test(sql.trim())) {
              let totalRows = 0, totalCols = 0, idxCount = 0, memBytes = 0;
              const names = Object.keys(this.tables).filter(t => !t.startsWith('__tmp_'));
              names.forEach(tn => {
                  const t = this.tables[tn];
                  totalRows += t.rowCount;
                  const cn = t.getColumnNames().length;
                  totalCols += cn;
                  idxCount += Object.keys(t.indices).length;
                  // 列あたり Float64(8byte) + Uint32(4byte) の確保済み容量 + 文字列プール(UTF-16概算)
                  memBytes += cn * t.capacity * 12;
                  for (const c in t.strPools) t.strPools[c].forEach(s2 => { memBytes += s2.length * 2; });
              });
              const data = [
                  { Item: 'version', Value: 'LuminaDB ' + (typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '?') },
                  { Item: 'tables', Value: names.length },
                  { Item: 'views', Value: Object.keys(this.views).length },
                  { Item: 'procedures', Value: Object.keys(this.procedures).length },
                  { Item: 'total_rows', Value: totalRows },
                  { Item: 'total_columns', Value: totalCols },
                  { Item: 'indexes', Value: idxCount },
                  { Item: 'est_memory_kb', Value: Math.round(memBytes / 1024) },
                  { Item: 'in_transaction', Value: this.inTransaction },
                  { Item: 'last_insert_id', Value: this.lastInsertId || 0 }
              ];
              return { data, affectedRows: data.length };
          }
          // SHOW COLUMNS FROM t は DESCRIBE のエイリアス
          const colM = sql.trim().match(/^show\s+columns\s+from\s+([a-zA-Z0-9_]+)$/i);
          if (colM) {
              return this._executeDescribe(`DESCRIBE ${colM[1]}`);
          }
          throw new Error("Syntax Error in SHOW. Use SHOW TABLES [LIKE 'pat'] / VIEWS / PROCEDURES / TRIGGERS [FROM table] / FUNCTIONS [LIKE 'pat'] / VARIABLES / SEQUENCES / PREPARED / CHECKS [FROM table] / INDEXES [FROM table] / COLUMNS FROM <table> / STATUS / CREATE TABLE <name> / CREATE VIEW <name> / CREATE PROCEDURE <name>.");
      },

      // CHECK TABLE <t>: 全制約の整合性検査 / ANALYZE TABLE <t>: 列ごとの統計レポート
      _executeTableMaintenance(sql) {
          let m = sql.match(/^check\s+table\s+([a-zA-Z0-9_]+)$/i);
          if (m) {
              const name = m[1].toLowerCase();
              const t = this.tables[name];
              if (!t) throw this._tableNotFound(name);
              const data = [];
              const report = (constraint, problems, details) => {
                  data.push({ Table: name, Constraint: constraint, Status: problems === 0 ? 'OK' : 'FAIL', Problems: problems, Details: problems === 0 ? '' : details });
              };
              // PK / UNIQUE（単一列）: NULL（PKのみ）と重複を検査
              const checkUniqueCol = (col, isPK) => {
                  let nulls = 0, dups = 0;
                  const seen = new Set();
                  for (let i = 0; i < t.rowCount; i++) {
                      const v = t.getValue(col, i);
                      if (v === null || v === undefined) { nulls++; continue; }
                      if (seen.has(v)) dups++;
                      seen.add(v);
                  }
                  const problems = dups + (isPK ? nulls : 0);
                  report(`${isPK ? 'PRIMARY KEY' : 'UNIQUE'} (${col})`, problems, `${dups} duplicate(s)${isPK && nulls ? `, ${nulls} NULL(s)` : ''}`);
              };
              if (t.primaryKey) checkUniqueCol(t.primaryKey, true);
              (t.uniqueCols || []).forEach(c => checkUniqueCol(c, false));
              // 複合キー: 完全なタプルの重複（PK は NULL も違反）
              (t.compositeKeys || []).forEach(ck => {
                  let nulls = 0, dups = 0;
                  const seen = new Set();
                  for (let i = 0; i < t.rowCount; i++) {
                      const tup = ck.cols.map(c => t.getValue(c, i));
                      if (tup.some(v => v === null || v === undefined)) { nulls++; continue; }
                      const sig = JSON.stringify(tup);
                      if (seen.has(sig)) dups++;
                      seen.add(sig);
                  }
                  const problems = dups + (ck.isPK ? nulls : 0);
                  report(`${ck.isPK ? 'PRIMARY KEY' : 'UNIQUE'} (${ck.cols.join(', ')})`, problems, `${dups} duplicate(s)${ck.isPK && nulls ? `, ${nulls} NULL(s)` : ''}`);
              });
              // NOT NULL
              (t.notNullCols || []).forEach(col => {
                  let nulls = 0;
                  for (let i = 0; i < t.rowCount; i++) {
                      const v = t.getValue(col, i);
                      if (v === null || v === undefined) nulls++;
                  }
                  report(`NOT NULL (${col})`, nulls, `${nulls} NULL(s)`);
              });
              // FK: 参照先に存在しない値
              (t.foreignKeys || []).forEach(fk => {
                  const refTbl = this.tables[fk.refTable];
                  if (!refTbl) {
                      report(`FOREIGN KEY (${fk.col}) -> ${fk.refTable}(${fk.refCol})`, 1, `Referenced table '${fk.refTable}' not found`);
                      return;
                  }
                  let orphans = 0;
                  for (let i = 0; i < t.rowCount; i++) {
                      const v = t.getValue(fk.col, i);
                      if (v === null || v === undefined) continue;
                      if (refTbl.findValueRows(fk.refCol, v).length === 0) orphans++;
                  }
                  report(`FOREIGN KEY (${fk.col}) -> ${fk.refTable}(${fk.refCol})`, orphans, `${orphans} orphaned value(s)`);
              });
              // CHECK 制約
              const checkFns = this._compileChecks(t);
              const aliases = { [name]: name };
              checkFns.forEach(chk => {
                  let bad = 0;
                  for (let i = 0; i < t.rowCount; i++) {
                      let ok; try { ok = chk.fn({ [name]: i }, this.tables, aliases); } catch (e) { ok = false; }
                      if (!ok) bad++;
                  }
                  report(`CHECK (${chk.label})`, bad, `${bad} violating row(s)`);
              });
              if (data.length === 0) {
                  data.push({ Table: name, Constraint: '(no constraints)', Status: 'OK', Problems: 0, Details: '' });
              }
              return { data, affectedRows: data.length };
          }
          m = sql.match(/^analyze\s+table\s+([a-zA-Z0-9_]+)$/i);
          if (m) {
              const name = m[1].toLowerCase();
              const t = this.tables[name];
              if (!t) throw this._tableNotFound(name);
              const data = t.getColumnNames().map(col => {
                  let nulls = 0, min = null, max = null;
                  const distinct = new Set();
                  for (let i = 0; i < t.rowCount; i++) {
                      const v = t.getValue(col, i);
                      if (v === null || v === undefined) { nulls++; continue; }
                      distinct.add(v);
                      if (min === null || v < min) min = v;
                      if (max === null || v > max) max = v;
                  }
                  return {
                      Column: col,
                      Type: t.colTypes[col] || 'ANY',
                      Rows: t.rowCount,
                      Nulls: nulls,
                      Distinct: distinct.size,
                      Min: min,
                      Max: max
                  };
              });
              return { data, affectedRows: data.length };
          }
          throw new Error("Syntax Error. Use CHECK TABLE <name> or ANALYZE TABLE <name>.");
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
          if (!t) throw this._tableNotFound(name);
          const data = t.getColumnNames().map(c => {
              const fk = (t.foreignKeys || []).find(f => f.col === c);
              // 複合キーの構成列は '(composite)' 付きで表示する
              const ckPk = (t.compositeKeys || []).some(ck => ck.isPK && ck.cols.includes(c));
              const ckUq = (t.compositeKeys || []).some(ck => !ck.isPK && ck.cols.includes(c));
              return {
                  Column: c,
                  Type: t.colTypes[c] || 'ANY',
                  Key: t.primaryKey === c ? 'PRIMARY' : ((t.uniqueCols || []).includes(c) ? 'UNIQUE' : (ckPk ? 'PRIMARY (composite)' : (ckUq ? 'UNIQUE (composite)' : ''))),
                  Indexed: !!t.indices[c],
                  ForeignKey: fk ? `${fk.refTable}(${fk.refCol})` : '',
                  NotNull: (t.notNullCols || []).includes(c),
                  Default: (t.defaults && c in t.defaults) ? (this._isNowMarker(t.defaults[c]) ? 'CURRENT_TIMESTAMP' : String(t.defaults[c])) : '',
                  Extra: t.autoIncrementCol === c ? 'AUTO_INCREMENT' : ((t.generatedCols && c in t.generatedCols) ? `GENERATED AS (${t.generatedCols[c]})` : '')
              };
          });
          return { data, affectedRows: data.length };
      },

      // セッション制御・権限・注釈系。単一ユーザーのブラウザ内DBでは実効を持たないものが多いが、
      // 実DB向けスクリプトをそのまま流せるよう受理する。COMMENT ON だけは注釈を保存する。
      _executeSessionStatement(sql, strMap) {
          const raw = this._restoreStrings(sql, strMap);
          let m;
          if ((m = raw.match(/^comment\s+on\s+(table|column)\s+([a-zA-Z0-9_.]+)\s+is\s+([\s\S]+)$/i))) {
              const kind = m[1].toLowerCase();
              const target = m[2].toLowerCase();
              let text = m[3].trim().replace(/;$/, '');
              if (/^null$/i.test(text)) text = null;
              else text = text.replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1').replace(/''/g, "'");
              if (kind === 'table') {
                  if (!this.tables[target] && !this.views[target]) throw this._tableNotFound(target);
              } else {
                  const dot = target.indexOf('.');
                  if (dot === -1) throw new Error("COMMENT ON COLUMN requires <table>.<column>.");
                  const tn = target.slice(0, dot), cn = target.slice(dot + 1);
                  if (!this.tables[tn]) throw this._tableNotFound(tn);
                  if (!this.tables[tn].cols[cn]) throw new Error(`Column '${cn}' not found in table '${tn}'.`);
              }
              const key = kind + ':' + target;
              if (text === null) delete this.comments[key]; else this.comments[key] = text;
              return { data: [{ Result: "Success", Message: `Comment ${text === null ? 'removed' : 'set'} on ${kind} '${target}'.` }], affectedRows: 0 };
          }
          if ((m = raw.match(/^set\s+(?:session\s+|local\s+)?transaction\s+([\s\S]+)$/i))) {
              const spec = m[1].trim().replace(/;$/, '');
              const il = spec.match(/isolation\s+level\s+(read\s+uncommitted|read\s+committed|repeatable\s+read|serializable)/i);
              if (il) this.sessionSettings.isolation_level = il[1].toUpperCase().replace(/\s+/g, ' ');
              if (/read\s+only/i.test(spec)) this.sessionSettings.transaction_mode = 'READ ONLY';
              else if (/read\s+write/i.test(spec)) this.sessionSettings.transaction_mode = 'READ WRITE';
              // 単一スレッドで直列実行されるため、実効的な分離レベルは常に SERIALIZABLE
              return { data: [{ Result: "Success", Message: `Transaction settings accepted (LuminaDB executes statements serially; effective isolation is SERIALIZABLE).` }], affectedRows: 0 };
          }
          if (/^(lock|unlock)\s+tables?\b/i.test(raw)) {
              return { data: [{ Result: "Success", Message: "Lock statement accepted (no-op: LuminaDB is single-threaded)." }], affectedRows: 0 };
          }
          if (/^(grant|revoke)\b/i.test(raw)) {
              return { data: [{ Result: "Success", Message: "Privilege statement accepted (no-op: LuminaDB has no user accounts)." }], affectedRows: 0 };
          }
          if (/^analyze\b/i.test(raw)) {
              return { data: [{ Result: "Success", Message: "ANALYZE accepted (statistics are computed on demand)." }], affectedRows: 0 };
          }
          if (/^discard\b/i.test(raw)) {
              this.prepared = Object.create(null);
              this.userVars = Object.create(null);
              return { data: [{ Result: "Success", Message: "Session state discarded (prepared statements and user variables cleared)." }], affectedRows: 0 };
          }
          throw new Error("Unsupported session statement.");
      },

      // SELECT ... INTO <newtable> FROM ... : 結果セットから新テーブルを作成する
      _executeSelectInto(newName, selectSql, strMap) {
          if (this.tables[newName]) throw new Error(`Table '${newName}' already exists.`);
          if (this.views[newName]) throw new Error(`View '${newName}' already exists.`);
          const res = this.executeQuery(selectSql, true, strMap);
          if (res.error) throw new Error(res.error);
          this._logCreateTable(newName);
          this._materializeRows(newName, res.data);
          return { data: [{ Result: "Success", Message: `Table '${newName}' created with ${res.data.length} rows.` }], affectedRows: res.data.length };
      },

      // REFRESH MATERIALIZED VIEW <name>: 定義クエリを再実行して実体テーブルを差し替える
      _refreshMatView(sql, strMap) {
          const m = sql.match(/^refresh\s+materialized\s+view\s+([a-zA-Z0-9_]+)\s*$/i);
          if (!m) throw new Error("Syntax Error. Use REFRESH MATERIALIZED VIEW <name>.");
          const name = m[1].toLowerCase();
          const mv = this.matViews[name];
          if (!mv) throw new Error(`Materialized view '${name}' not found.`);
          const res = this.executeQuery(mv.sql, true, strMap);
          if (res.error) throw new Error(res.error);
          this._logTableMeta(name);
          this._materializeRows(name, res.data);
          return { data: [{ Result: "Success", Message: `Materialized view '${name}' refreshed (${res.data.length} rows).` }], affectedRows: res.data.length };
      },

      _executeDDL(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          if (/^create\s+index/i.test(sql)) {
             const m = sql.match(/create\s+index\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+on\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)/i);
             if (m) {
                const idxName = m[2].toLowerCase();
                const table = m[3].toLowerCase();
                const col = m[4].toLowerCase();
                if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                if (m[1] && this.tables[table].indices[col]) {
                    return { data: [{ Result: "Success", Message: `Index on ${table}(${col}) already exists. Skipped.` }], affectedRows: 0 };
                }
                this._logTableMeta(table);
                this.tables[table].createIndex(col);
                resultSet = [{ Result: "Success", Message: `Index '${idxName}' created on ${table}(${col}).` }];
             } else throw new Error("Syntax Error in CREATE INDEX.");
          }
          else if (/^create\s+materialized\s+view/i.test(sql)) {
             // マテリアライズドビュー: 定義時に結果を実体化し、REFRESH で明示的に再計算する。
             // 通常ビュー（クエリ書き換え）と違い、実体は独立したテーブルとして保持される。
             const m = sql.match(/^create\s+materialized\s+view\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+as\s+([\s\S]+)$/i);
             if (!m) throw new Error("Syntax Error in CREATE MATERIALIZED VIEW. Use CREATE MATERIALIZED VIEW <name> AS SELECT ...");
             const ifNotExists = !!m[1];
             const name = m[2].toLowerCase();
             const body = m[3].trim();
             if (this.matViews[name] || this.tables[name] || this.views[name]) {
                 if (ifNotExists) return { data: [{ Result: "Success", Message: `Materialized view '${name}' already exists. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Table or view '${name}' already exists.`);
             }
             if (!/^select\b/i.test(body) && !/^with\b/i.test(body)) throw new Error("MATERIALIZED VIEW definition must be a SELECT statement.");
             const res = this.executeQuery(body, true, strMap);
             if (res.error) throw new Error(res.error);
             this._logCreateTable(name);
             this._materializeRows(name, res.data);
             this.matViews[name] = { sql: this._restoreStrings(body, strMap) };
             resultSet = [{ Result: "Success", Message: `Materialized view '${name}' created with ${res.data.length} rows.` }];
          }
          else if (/^drop\s+materialized\s+view/i.test(sql)) {
             const m = sql.match(/^drop\s+materialized\s+view\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)/i);
             if (!m) throw new Error("Syntax Error in DROP MATERIALIZED VIEW.");
             const name = m[2].toLowerCase();
             if (!this.matViews[name]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Materialized view '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Materialized view '${name}' not found.`);
             }
             this._logDropTable(name);
             delete this.tables[name];
             delete this.matViews[name];
             resultSet = [{ Result: "Success", Message: `Materialized view '${name}' dropped.` }];
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
          else if (/^create\s+(?:or\s+replace\s+)?trigger/i.test(sql)) {
             // 行トリガー: CREATE TRIGGER name {BEFORE|AFTER} {INSERT|UPDATE|DELETE} ON table
             //            FOR EACH ROW <文>[; <文> ...]（BEGIN ... END で括っても良い）
             // 本文では NEW.col / OLD.col が発火行の値リテラルへ置換される
             const m = sql.match(/^create\s+(or\s+replace\s+)?trigger\s+([a-zA-Z0-9_]+)\s+(before|after)\s+(insert|update|delete)\s+on\s+([a-zA-Z0-9_]+)\s+for\s+each\s+row\s+([\s\S]+)$/i);
             if (!m) throw new Error("Syntax Error in CREATE TRIGGER. Use CREATE TRIGGER name {BEFORE|AFTER} {INSERT|UPDATE|DELETE} ON table FOR EACH ROW <statement>[; ...].");
             const orReplace = !!m[1];
             const name = m[2].toLowerCase();
             const timing = m[3].toLowerCase();
             const event = m[4].toLowerCase();
             const table = m[5].toLowerCase();
             if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
             if (this.triggers[name] && !orReplace) throw new Error(`Trigger '${name}' already exists.`);
             let body = m[6].trim();
             const beMatch = body.match(/^begin\s+([\s\S]+?)\s*end$/i);
             if (beMatch) body = beMatch[1];
             const statements = body.split(';').map(s2 => s2.trim()).filter(s2 => s2 !== '').map(s2 => this._restoreStrings(s2, strMap));
             if (statements.length === 0) throw new Error("Trigger body is empty.");
             const replaced = orReplace && !!this.triggers[name];
             this._logTriggerState(name);
             this.triggers[name] = { name, timing, event, table, statements };
             resultSet = [{ Result: "Success", Message: `Trigger '${name}' ${replaced ? 'replaced' : 'created'} (${timing.toUpperCase()} ${event.toUpperCase()} ON ${table}).` }];
          }
          else if (/^drop\s+trigger/i.test(sql)) {
             const m = sql.match(/drop\s+trigger\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)$/i);
             if (m) {
                const name = m[2].toLowerCase();
                if (!this.triggers[name]) {
                    if (m[1]) return { data: [{ Result: "Success", Message: `Trigger '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Trigger '${name}' not found.`);
                }
                this._logTriggerState(name);
                delete this.triggers[name];
                resultSet = [{Result:"Success", Message:`Trigger '${name}' dropped.`}];
             } else throw new Error("Syntax Error in DROP TRIGGER.");
          }
          else if (/^create\s+sequence/i.test(sql)) {
             // CREATE SEQUENCE [IF NOT EXISTS] name [START WITH n] [INCREMENT BY n]
             const m = sql.match(/^create\s+sequence\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)(?:\s+start\s+with\s+(-?\d+))?(?:\s+increment\s+by\s+(-?\d+))?$/i);
             if (!m) throw new Error("Syntax Error in CREATE SEQUENCE. Use CREATE SEQUENCE [IF NOT EXISTS] name [START WITH n] [INCREMENT BY n].");
             const name = m[2].toLowerCase();
             if (this.sequences[name]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Sequence '${name}' already exists. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Sequence '${name}' already exists.`);
             }
             const start = m[3] !== undefined ? parseInt(m[3], 10) : 1;
             const increment = m[4] !== undefined ? parseInt(m[4], 10) : 1;
             if (increment === 0) throw new Error("INCREMENT BY must not be 0.");
             this._logSeqState(name);
             this.sequences[name] = { start, increment, value: null };
             resultSet = [{ Result: "Success", Message: `Sequence '${name}' created (START WITH ${start}, INCREMENT BY ${increment}).` }];
          }
          else if (/^drop\s+sequence/i.test(sql)) {
             const m = sql.match(/^drop\s+sequence\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)$/i);
             if (!m) throw new Error("Syntax Error in DROP SEQUENCE.");
             const name = m[2].toLowerCase();
             if (!this.sequences[name]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Sequence '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Sequence '${name}' not found.`);
             }
             this._logSeqState(name);
             delete this.sequences[name];
             resultSet = [{ Result: "Success", Message: `Sequence '${name}' dropped.` }];
          }
          else if (/^create\s+(?:temporary\s+)?table/i.test(sql)) {
             // CREATE [TEMPORARY] TABLE。TEMPORARY はセッション限り（IDB保存・SQLエクスポート対象外）
             // CREATE TABLE new LIKE src: スキーマ（型/制約/インデックス）のみ複製（データは含まない）
             const likeM = sql.match(/^create\s+(temporary\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+like\s+([a-zA-Z0-9_]+)$/i);
             if (likeM) {
                const isTempFlag = !!likeM[1];
                const ifNotExists = !!likeM[2];
                const tableName = likeM[3].toLowerCase();
                const srcName = likeM[4].toLowerCase();
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
                t.compositeKeys = JSON.parse(JSON.stringify(src.compositeKeys || []));
                t.generatedCols = Object.assign(Object.create(null), src.generatedCols || {});
                t.isTemp = isTempFlag;
                Object.keys(src.indices).forEach(c => t.createIndex(c));
                this.tables[tableName] = t;
                return { data: [{ Result: "Success", Message: `Table '${tableName}' created like '${srcName}'.` }], affectedRows: 0 };
             }

             // CREATE TABLE ... [AS] SELECT (CTAS): SELECT 結果からテーブルを作成（AS は省略可）
             const ctasM = sql.match(/^create\s+(temporary\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+(?:as\s+)?(select\s[\s\S]+)$/i);
             if (ctasM) {
                const isTempFlag = !!ctasM[1];
                const ifNotExists = !!ctasM[2];
                const tableName = ctasM[3].toLowerCase();
                if (this.tables[tableName] || this.views[tableName]) {
                    if (ifNotExists) {
                        return { data: [{ Result: "Success", Message: `Table '${tableName}' already exists. Skipped.` }], affectedRows: 0 };
                    }
                    throw new Error(`Table '${tableName}' already exists.`);
                }
                const subRes = this.executeQuery(ctasM[4], true, strMap);
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
                t.isTemp = isTempFlag;
                this.tables[tableName] = t;
                return { data: [{ Result: "Success", Message: `Table '${tableName}' created (${t.rowCount} rows).` }], affectedRows: t.rowCount };
             }

             const m = sql.match(/create\s+(temporary\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]+)\)/i);
             if (m) {
                const isTempFlag = !!m[1];
                const ifNotExists = !!m[2];
                const tableName = m[3].toLowerCase();
                if (this.tables[tableName] || this.views[tableName]) {
                    if (ifNotExists) {
                        return { data: [{ Result: "Success", Message: `Table '${tableName}' already exists. Skipped.` }], affectedRows: 0 };
                    }
                    if (this.tables[tableName]) throw new Error(`Table '${tableName}' already exists.`);
                    throw new Error(`View '${tableName}' already exists.`);
                }
                this._logCreateTable(tableName);

                // 列定義は括弧を考慮して分割する（CHECK(x IN (1,2)) 等の内部カンマを保護）
                const defs = this.splitSelectClause(m[4]);
                const colDefs = [];
                const foreignKeys = [];
                const tableLevelPks = [];
                const tableLevelUniques = [];
                const compositeDefs = [];
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
                    // PRIMARY KEY / UNIQUE は複数列（複合キー）を受理する
                    const pkMatch = d.match(/^primary\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
                    const uqMatch = d.match(/^(?:constraint\s+[a-zA-Z0-9_]+\s+)?unique\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
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
                        const pcols = pkMatch[1].split(',').map(x => x.trim().toLowerCase());
                        if (pcols.length === 1) tableLevelPks.push(pcols[0]);
                        else compositeDefs.push({ cols: pcols, isPK: true });
                    } else if (uqMatch) {
                        const ucols = uqMatch[1].split(',').map(x => x.trim().toLowerCase());
                        if (ucols.length === 1) tableLevelUniques.push(ucols[0]);
                        else compositeDefs.push({ cols: ucols, isPK: false });
                    } else {
                        // カラム定義: 列レベルの CHECK / GENERATED / PRIMARY KEY / UNIQUE / NOT NULL / DEFAULT / AUTO_INCREMENT 修飾を解析
                        let def = d;
                        // SQL標準の識別列 GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(...)] と
                        // SQL Server の IDENTITY[(seed, incr)] を AUTO_INCREMENT へ正規化する。
                        // 本実装の採番は「既存最大値+1」なので seed/increment が 1 以外なら明示的に拒否する。
                        // （ALWAYS / BY DEFAULT の区別は設けず、いずれも明示代入可能な AUTO_INCREMENT 相当）
                        const identM = def.match(/\bgenerated\s+(always|by\s+default)\s+as\s+identity\b(\s*\(([^)]*)\))?/i)
                            || def.match(/\bidentity\b(\s*\(([^)]*)\))?/i);
                        if (identM) {
                            const optTxt = (identM[3] !== undefined ? identM[3] : identM[2]) || '';
                            const sw = optTxt.match(/start\s+with\s+(-?\d+)/i);
                            const ib = optTxt.match(/increment\s+by\s+(-?\d+)/i);
                            const plain = optTxt.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
                            const seed = sw ? Number(sw[1]) : (plain ? Number(plain[1]) : 1);
                            const incr = ib ? Number(ib[1]) : (plain ? Number(plain[2]) : 1);
                            if (seed !== 1 || incr !== 1) {
                                throw new Error("IDENTITY with a non-default seed/increment is not supported (use a SEQUENCE with DEFAULT NEXTVAL instead).");
                            }
                            def = def.replace(identM[0], ' AUTO_INCREMENT ');
                        }
                        // 生成列 [GENERATED ALWAYS] AS (expr) [STORED|VIRTUAL] を先に切り出す。
                        // STORED/VIRTUAL いずれも挿入/更新時に評価して格納する（本実装は STORED 相当）
                        let generatedExpr = null;
                        const genM = def.match(/\s+(?:generated\s+always\s+)?as\s*\(/i);
                        if (genM) {
                            const open = genM.index + genM[0].length - 1;
                            let gd = 0, close = -1;
                            for (let i = open; i < def.length; i++) {
                                if (def[i] === '(') gd++;
                                else if (def[i] === ')') { gd--; if (gd === 0) { close = i; break; } }
                            }
                            if (close === -1) throw new Error("Syntax Error in generated column expression.");
                            generatedExpr = this._restoreStrings(def.slice(open + 1, close).trim(), strMap);
                            def = (def.slice(0, genM.index) + ' ' + def.slice(close + 1)).replace(/\s+(stored|virtual)\b/i, ' ').replace(/\s+/g, ' ').trim();
                        }
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
                        colDefs.push({ name: parts[0].toLowerCase(), type: parts.length > 1 && parts[1] ? parts[1].toUpperCase() : 'ANY', isPK, isUnique, notNull, autoInc, defaultVal, hasDefault: dm !== null, generatedExpr });
                    }
                });

                if (colDefs.length === 0 || !colDefs[0].name) throw new Error("Syntax Error in CREATE TABLE.");

                const pkCandidates = [...new Set([...colDefs.filter(c => c.isPK).map(c => c.name), ...tableLevelPks])];
                const compositePkCount = compositeDefs.filter(ck => ck.isPK).length;
                if (pkCandidates.length + compositePkCount > 1) throw new Error("Multiple PRIMARY KEY definitions are not allowed.");
                const primaryKey = pkCandidates.length === 1 ? pkCandidates[0] : null;
                const uniqueCols = [...new Set([...colDefs.filter(c => c.isUnique).map(c => c.name), ...tableLevelUniques])].filter(c => c !== primaryKey);
                [...tableLevelPks, ...tableLevelUniques, ...compositeDefs.flatMap(ck => ck.cols)].forEach(c => {
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
                t.compositeKeys = compositeDefs;
                // 生成列 (GENERATED ALWAYS AS): 式を保存し、INSERT/UPDATE 時に評価する
                colDefs.forEach(cd => {
                    if (cd.generatedExpr != null) {
                        if (cd.autoInc) throw new Error(`Column '${cd.name}' cannot be both AUTO_INCREMENT and generated.`);
                        if (cd.hasDefault) throw new Error(`Generated column '${cd.name}' cannot have a DEFAULT.`);
                        t.generatedCols[cd.name] = cd.generatedExpr;
                    }
                });
                // 複合 PRIMARY KEY の構成列は暗黙 NOT NULL
                compositeDefs.filter(ck => ck.isPK).forEach(ck => ck.cols.forEach(c => {
                    if (!t.notNullCols.includes(c)) t.notNullCols.push(c);
                }));
                t.isTemp = isTempFlag;
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
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+primary\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const pcols = m[2].split(',').map(x => x.trim().toLowerCase());
                 pcols.forEach(c => { if (!t.cols[c]) throw new Error(`Column '${c}' not found.`); });
                 if (t.primaryKey) throw new Error(`Table '${table}' already has a PRIMARY KEY on '${t.primaryKey}'.`);
                 if ((t.compositeKeys || []).some(ck => ck.isPK)) throw new Error(`Table '${table}' already has a composite PRIMARY KEY.`);
                 if (pcols.length === 1) {
                     const col = pcols[0];
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
                 // 複合PK: 既存データの NULL / タプル重複を検証してから追加する
                 const seen = new Set();
                 for (let i = 0; i < t.rowCount; i++) {
                     const tup = pcols.map(c => t.getValue(c, i));
                     if (tup.some(v => v === null || v === undefined)) throw new Error(`PRIMARY KEY constraint failed: NULL not allowed in composite key (${pcols.join(', ')}).`);
                     const sig = JSON.stringify(tup);
                     if (seen.has(sig)) throw new Error(`PRIMARY KEY constraint failed: Duplicate value (${tup.join(', ')}) in (${pcols.join(', ')}).`);
                     seen.add(sig);
                 }
                 this._logTableMeta(table);
                 t.compositeKeys = (t.compositeKeys || []).concat([{ cols: pcols, isPK: true }]);
                 pcols.forEach(c => { if (!t.notNullCols.includes(c)) t.notNullCols.push(c); });
                 return { data: [{ Result: "Success", Message: `PRIMARY KEY added on ${table}(${pcols.join(', ')}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+primary\s+key$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 if (t.primaryKey) {
                     const col = t.primaryKey;
                     this._logTableMeta(table);
                     t.primaryKey = null;
                     return { data: [{ Result: "Success", Message: `PRIMARY KEY on ${table}(${col}) dropped.` }], affectedRows: 0 };
                 }
                 const ckIdx = (t.compositeKeys || []).findIndex(ck => ck.isPK);
                 if (ckIdx !== -1) {
                     const cols = t.compositeKeys[ckIdx].cols;
                     this._logTableMeta(table);
                     t.compositeKeys = t.compositeKeys.filter((ck, i) => i !== ckIdx);
                     return { data: [{ Result: "Success", Message: `PRIMARY KEY on ${table}(${cols.join(', ')}) dropped.` }], affectedRows: 0 };
                 }
                 throw new Error(`Table '${table}' has no PRIMARY KEY.`);
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+unique\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const ucols = m[2].split(',').map(x => x.trim().toLowerCase());
                 ucols.forEach(c => { if (!t.cols[c]) throw new Error(`Column '${c}' not found.`); });
                 if (ucols.length === 1) {
                     const col = ucols[0];
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
                 // 複合UNIQUE: 完全な（NULLを含まない）タプルの重複を検証してから追加する
                 const seen = new Set();
                 for (let i = 0; i < t.rowCount; i++) {
                     const tup = ucols.map(c => t.getValue(c, i));
                     if (tup.some(v => v === null || v === undefined)) continue;
                     const sig = JSON.stringify(tup);
                     if (seen.has(sig)) throw new Error(`UNIQUE constraint failed: Duplicate value (${tup.join(', ')}) in (${ucols.join(', ')}).`);
                     seen.add(sig);
                 }
                 this._logTableMeta(table);
                 t.compositeKeys = (t.compositeKeys || []).concat([{ cols: ucols, isPK: false }]);
                 return { data: [{ Result: "Success", Message: `UNIQUE constraint added on ${table}(${ucols.join(', ')}).` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+unique\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const ucols = m[2].split(',').map(x => x.trim().toLowerCase());
                 if (ucols.length === 1) {
                     const col = ucols[0];
                     if (!(t.uniqueCols || []).includes(col)) throw new Error(`UNIQUE constraint on '${col}' not found.`);
                     this._logTableMeta(table);
                     t.uniqueCols = t.uniqueCols.filter(c => c !== col);
                     return { data: [{ Result: "Success", Message: `UNIQUE constraint on ${table}(${col}) dropped.` }], affectedRows: 0 };
                 }
                 const ckIdx = (t.compositeKeys || []).findIndex(ck => !ck.isPK && ck.cols.join(',') === ucols.join(','));
                 if (ckIdx === -1) throw new Error(`UNIQUE constraint on '(${ucols.join(', ')})' not found.`);
                 this._logTableMeta(table);
                 t.compositeKeys = t.compositeKeys.filter((ck, i) => i !== ckIdx);
                 return { data: [{ Result: "Success", Message: `UNIQUE constraint on ${table}(${ucols.join(', ')}) dropped.` }], affectedRows: 0 };
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

             // CHANGE [COLUMN] old new TYPE: 改名と型変更を同時に行う（MySQL互換）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+change\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s+([a-zA-Z]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const oldCol = m[2].toLowerCase();
                 const newCol = m[3].toLowerCase();
                 const newType = m[4].toUpperCase();
                 if (!t.cols[oldCol]) throw new Error(`Column '${oldCol}' not found.`);
                 if (oldCol !== newCol && t.cols[newCol]) throw new Error(`Column '${newCol}' already exists.`);
                 const validTypes = ['INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'TEXT', 'ANY'];
                 if (!validTypes.includes(newType)) throw new Error(`Unknown type '${newType}'. Use ${validTypes.join('/')}.`);
                 this._logFullTable(table);
                 // 型変更（キャスト失敗時はここで中断）→ 改名 の順で部分適用を防ぐ
                 t.changeColumnType(oldCol, newType);
                 if (oldCol !== newCol) t.renameColumn(oldCol, newCol);
                 return { data: [{ Result: "Success", Message: `Column '${oldCol}' changed to '${newCol}' ${newType}.` }], affectedRows: 0 };
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

             // ADD COLUMN [IF NOT EXISTS] name [type] [DEFAULT lit] [NOT NULL] [FIRST | AFTER col]（修飾子は順不同）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+(?:column\s+)?([\s\S]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);

                 let def = m[2].trim();
                 let ifNotExistsCol = false;
                 const ineM = def.match(/^if\s+not\s+exists\s+/i);
                 if (ineM) { ifNotExistsCol = true; def = def.slice(ineM[0].length); }
                 // 挿入位置 (FIRST / AFTER col) は末尾指定。先に切り出す
                 let position = null;
                 const pm = def.match(/\bafter\s+([a-zA-Z0-9_]+)\s*$/i);
                 if (pm) { position = { after: pm[1].toLowerCase() }; def = def.slice(0, pm.index); }
                 else if (/\bfirst\s*$/i.test(def)) { position = { first: true }; def = def.replace(/\bfirst\s*$/i, ' '); }
                 let notNull = false, hasDefault = false, defaultVal;
                 if (/\bnot\s+null\b/i.test(def)) { notNull = true; def = def.replace(/\bnot\s+null\b/i, ' '); }
                 const dm = def.match(/\bdefault\s+(\S+)/i);
                 if (dm) {
                     hasDefault = true;
                     defaultVal = this._parseDefaultLiteral(dm[1], strMap);
                     def = def.replace(dm[0], ' ');
                 }
                 const parts = def.trim().split(/\s+/);
                 if (parts.length > 2 || !parts[0]) throw new Error("Syntax Error in ALTER TABLE ADD COLUMN. Use ADD COLUMN name [type] [DEFAULT value] [NOT NULL] [FIRST | AFTER col].");
                 const colName = parts[0].toLowerCase();
                 if (this.tables[table].cols[colName]) {
                     if (ifNotExistsCol) return { data: [{ Result: "Success", Message: `Column '${colName}' already exists. Skipped.` }], affectedRows: 0 };
                     throw new Error(`Column '${colName}' already exists.`);
                 }
                 const type = parts[1] ? parts[1].toUpperCase() : 'ANY';

                 const t = this.tables[table];
                 if (position && position.after && !t.cols[position.after]) throw new Error(`Column '${position.after}' not found.`);
                 // 既存行が残る場合、NOT NULL 列は DEFAULT なしでは全行違反となるため拒否
                 if (notNull && !hasDefault && t.rowCount > 0) {
                     throw new Error(`NOT NULL constraint failed: Cannot add NOT NULL column '${colName}' without DEFAULT to a non-empty table.`);
                 }

                 this._logFullTable(table); // 列構成が変わるため全体スナップショット
                 t.addColumn(colName, type);
                 if (hasDefault && defaultVal !== null && defaultVal !== undefined) {
                     // DEFAULT CURRENT_TIMESTAMP は追加時点の時刻で既存行を埋める
                     const fillVal = this._isNowMarker(defaultVal) ? this._nowString() : defaultVal;
                     try {
                         for (let i = 0; i < t.rowCount; i++) t.setValue(colName, i, fillVal);
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
                 // FIRST / AFTER: 列順を並べ替える
                 if (position) {
                     const order = t.getColumnNames().filter(c => c !== colName);
                     if (position.first) order.unshift(colName);
                     else order.splice(order.indexOf(position.after) + 1, 0, colName);
                     t.reorderColumns(order);
                 }
                 resultSet = [{ Result: "Success", Message: `Column '${colName}' added.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             // DROP COLUMN IF EXISTS name（専用判定。汎用 DROP COLUMN が 'if' を列名と誤認しないよう先に処理）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+(?:column\s+)?if\s+exists\s+([a-zA-Z0-9_]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const colName = m[2].toLowerCase();
                 if (!this.tables[table].cols[colName]) {
                     return { data: [{ Result: "Success", Message: `Column '${colName}' does not exist. Skipped.` }], affectedRows: 0 };
                 }
                 this._logFullTable(table);
                 this.tables[table].dropColumn(colName);
                 return { data: [{ Result: "Success", Message: `Column '${colName}' dropped.` }], affectedRows: 0 };
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
             // TABLE キーワードは省略可 (TRUNCATE t / TRUNCATE TABLE t)。
             // RESTART IDENTITY で AUTO_INCREMENT の採番を 1 から振り直す（CONTINUE IDENTITY は既定＝維持）
             const m = sql.match(/truncate\s+(?:table\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                const table = m[1].toLowerCase();
                if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                const restartIdentity = /\brestart\s+identity\b/i.test(sql);
                this._cowColumns(table, 'ALL');
                const t = this.tables[table];
                affectedRows = t.rowCount;
                t.rowCount = 0;
                if (Object.keys(t.indices).length > 0) t.rebuildIndices();
                // 採番は既存行の最大値から続くため、行を消した時点で自然に 1 から再開される。
                // CONTINUE IDENTITY 指定時に採番を維持するには最終値の保持が要るため未対応と明示する。
                if (/\bcontinue\s+identity\b/i.test(sql) && t.autoIncrementCol) {
                    throw new Error("TRUNCATE ... CONTINUE IDENTITY is not supported (identity always restarts after truncation).");
                }
                resultSet = [{Result:"Success", Message:`${affectedRows} rows truncated${restartIdentity && t.autoIncrementCol ? ' (identity restarted)' : ''}.`}];
             } else throw new Error("Syntax Error in TRUNCATE TABLE.");
          }
          else if (/^drop\s+index/i.test(sql)) {
             // CREATE INDEX と対称の構文。インデックス名は列で管理しているため省略可
             const m = sql.match(/drop\s+index\s+(if\s+exists\s+)?(?:([a-zA-Z0-9_]+)\s+)?on\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)/i);
             if (m) {
                const ifExists = !!m[1];
                const table = m[3].toLowerCase();
                const col = m[4].toLowerCase();
                if (!this.tables[table]) {
                    if (ifExists) return { data: [{ Result: "Success", Message: `Index on '${table}(${col})' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Table '${table}' not found.`);
                }
                if (!this.tables[table].indices[col]) {
                    if (ifExists) return { data: [{ Result: "Success", Message: `Index on '${table}(${col})' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Index on '${table}(${col})' not found.`);
                }
                this._logTableMeta(table);
                delete this.tables[table].indices[col];
                resultSet = [{ Result: "Success", Message: `Index on ${table}(${col}) dropped.` }];
             } else throw new Error("Syntax Error in DROP INDEX. Use DROP INDEX [IF EXISTS] [name] ON table (col).");
          }
          else if (/^drop\s+view/i.test(sql)) {
             // カンマ区切りの複数ビュー指定に対応 (DROP VIEW [IF EXISTS] a, b)
             const m = sql.match(/^drop\s+view\s+(if\s+exists\s+)?([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)$/i);
             if (m) {
                const ifExists = !!m[1];
                const names = m[2].split(',').map(s => s.trim().toLowerCase());
                if (names.length === 1) {
                    const name = names[0];
                    if (!this.views[name]) {
                        if (ifExists) return { data: [{ Result: "Success", Message: `View '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                        throw new Error(`View '${name}' not found.`);
                    }
                    this._logViewState(name);
                    delete this.views[name];
                    resultSet = [{Result:"Success", Message:`View '${name}' dropped.`}];
                } else {
                    const missing = names.filter(n => !this.views[n]);
                    if (missing.length > 0 && !ifExists) throw new Error(`View '${missing[0]}' not found.`);
                    const dropped = [];
                    names.forEach(n => {
                        if (!this.views[n]) return;
                        this._logViewState(n);
                        delete this.views[n];
                        dropped.push(n);
                    });
                    const skipNote = missing.length > 0 ? ` (${missing.length} skipped)` : '';
                    resultSet = [{ Result: "Success", Message: `${dropped.length} views dropped${dropped.length > 0 ? ` (${dropped.join(', ')})` : ''}.${skipNote}` }];
                }
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
             // カンマ区切りの複数テーブル指定に対応 (DROP TABLE [IF EXISTS] a, b, c)
             const m = sql.match(/^drop\s+table\s+(if\s+exists\s+)?([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)$/i);
             if (m) {
                const ifExists = !!m[1];
                const names = m[2].split(',').map(s => s.trim().toLowerCase());
                if (names.length === 1) {
                    const table = names[0];
                    if (!this.tables[table]) {
                        if (ifExists) return { data: [{ Result: "Success", Message: `Table '${table}' does not exist. Skipped.` }], affectedRows: 0 };
                        throw new Error(`Table '${table}' not found.`);
                    }
                    this._logDropTable(table);
                    delete this.tables[table];
                    resultSet = [{Result:"Success", Message:`Table '${table}' dropped.`}];
                } else {
                    // 原子性: IF EXISTS でなければ全テーブルの存在を先に検証してから削除する
                    const missing = names.filter(n => !this.tables[n]);
                    if (missing.length > 0 && !ifExists) throw new Error(`Table '${missing[0]}' not found.`);
                    const dropped = [];
                    names.forEach(n => {
                        if (!this.tables[n]) return;
                        this._logDropTable(n);
                        delete this.tables[n];
                        dropped.push(n);
                    });
                    const skipNote = missing.length > 0 ? ` (${missing.length} skipped)` : '';
                    resultSet = [{ Result: "Success", Message: `${dropped.length} tables dropped${dropped.length > 0 ? ` (${dropped.join(', ')})` : ''}.${skipNote}` }];
                }
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
