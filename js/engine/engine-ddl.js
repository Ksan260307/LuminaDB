    // ============================================================================
    // [DatabaseEngine DDL] - CREATE / ALTER / DROP / TRUNCATE / プロシージャ実行
    // ============================================================================

    // SHOW FUNCTIONS 用の関数レジストリ（カテゴリ -> 空白区切りの関数名）。
    // エンジンへ関数を追加したらここにも登録する
    const LUMINA_FN_REGISTRY = {
        'String': 'UPPER LOWER LENGTH LEN CHAR_LENGTH CHARACTER_LENGTH OCTET_LENGTH BIT_LENGTH CONCAT CONCAT_WS SUBSTRING SUBSTR MID SUBSTRING_INDEX LEFT RIGHT LPAD RPAD TRIM LTRIM RTRIM REPLACE REPLICATE REVERSE REPEAT INSTR STRPOS LOCATE POSITION CHARINDEX PATINDEX ASCII CHAR CHR SPACE STRCMP ELT FIELD INITCAP UCASE LCASE FORMAT HEX UNHEX BIN OCT CONV QUOTE QUOTENAME QUOTE_IDENT QUOTE_LITERAL SPLIT_PART TRANSLATE INSERT STUFF OVERLAY PARSENAME SOUNDEX STARTS_WITH ENDS_WITH BTRIM ENCODE ORD UNISTR CONTAINS',
        'Regexp': 'REGEXP_REPLACE REGEXP_SUBSTR REGEXP_LIKE REGEXP_COUNT REGEXP_INSTR',
        'Numeric': 'ABS CEIL CEILING FLOOR ROUND TRUNCATE TRUNC MOD REMAINDER SIGN POWER POW SQUARE SQRT CBRT EXP LN LOG LOG10 LOG2 PI RAND RANDOM SIN COS TAN COT SINH COSH TANH ASIN ACOS ATAN ATAN2 DEGREES RADIANS GREATEST LEAST GCD LCM FACTORIAL WIDTH_BUCKET NANVL BITAND BITOR BITXOR BITNOT SHIFTLEFT SHIFTRIGHT ISNUMERIC BIT_COUNT CRC32 FORMAT_BYTES',
        'Date & Time': 'NOW CURRENT_TIMESTAMP SYSDATE SYSTIMESTAMP GETDATE GETUTCDATE SYSDATETIME SYSUTCDATETIME UTC_TIMESTAMP CURDATE CURRENT_DATE UTC_DATE CURTIME CURRENT_TIME DATE TIME YEAR MONTH DAY DAYOFMONTH HOUR MINUTE SECOND DAYOFWEEK DAYOFYEAR WEEKDAY WEEK WEEKOFYEAR QUARTER MONTHNAME DAYNAME LAST_DAY EOMONTH NEXT_DAY DATEDIFF DATEADD DATEPART DATENAME DATE_ADD DATE_SUB ADD_MONTHS MONTHS_BETWEEN ADDDATE SUBDATE EXTRACT DATE_PART TIMESTAMPDIFF TIMESTAMPADD DATE_FORMAT STR_TO_DATE UNIX_TIMESTAMP FROM_UNIXTIME SEC_TO_TIME TIME_TO_SEC MAKEDATE MAKETIME MAKE_DATE MAKE_TIMESTAMP TO_DAYS FROM_DAYS DATE_TRUNC LOCALTIME LOCALTIMESTAMP TIMEDIFF YEARWEEK PERIOD_ADD PERIOD_DIFF JULIAN_DAY JULIANDAY CONVERT_TZ',
        'JSON': 'JSON_EXTRACT JSON_VALUE JSON_ARRAY JSON_OBJECT JSON_LENGTH JSON_KEYS JSON_VALID JSON_TYPE JSON_CONTAINS JSON_CONTAINS_PATH JSON_SET JSON_INSERT JSON_REPLACE JSON_REMOVE JSON_PRETTY JSON_QUOTE JSON_UNQUOTE JSON_ARRAY_APPEND JSON_ARRAY_INSERT JSON_MERGE_PATCH JSON_DEPTH JSON_SEARCH JSON_MERGE_PRESERVE',
        'Array': 'ARRAY_LENGTH ARRAY_POSITION ARRAY_CONTAINS ARRAY_APPEND ARRAY_PREPEND ARRAY_REMOVE ARRAY_TO_STRING STRING_TO_ARRAY ARRAY_DISTINCT ARRAY_CAT ARRAY_REVERSE',
        'Null & Flow': 'COALESCE IFNULL ISNULL NVL NVL2 ZEROIFNULL NULLIFZERO NULLIF DECODE CHOOSE IF IIF CASE CAST CONVERT TRY_CAST TRY_CONVERT',
        'Conversion': 'CAST CONVERT TRY_CAST TRY_CONVERT TO_NUMBER TO_CHAR TO_HEX TO_DATE TO_TIMESTAMP',
        'Encoding & Hash': 'MD5 SHA1 SHA2 SHA256 SHA224 TO_BASE64 FROM_BASE64 INET_ATON INET_NTOA',
        'Aggregate': 'COUNT SUM AVG MAX MIN GROUP_CONCAT STRING_AGG LISTAGG ARRAY_AGG STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP MEDIAN BIT_AND BIT_OR BIT_XOR BOOL_AND BOOL_OR CORR COVAR_POP COVAR_SAMP ANY_VALUE JSON_ARRAYAGG JSON_OBJECTAGG MIN_BY MAX_BY COUNT_IF PERCENTILE_CONT PERCENTILE_DISC GROUPING EVERY PRODUCT APPROX_COUNT_DISTINCT',
        'Window': 'ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE FIRST_VALUE LAST_VALUE NTH_VALUE PERCENT_RANK CUME_DIST',
        'Sequence': 'NEXTVAL CURRVAL SETVAL',
        'Meta': 'UUID NEWID SYS_GUID VERSION DATABASE CURRENT_SCHEMA SCHEMA_NAME USER CURRENT_USER SESSION_USER SYSTEM_USER SUSER_NAME LAST_INSERT_ID TYPEOF'
    };

    // 組み込み関数名の集合（CREATE FUNCTION による上書きを禁じるための照合用）。
    // 式コンパイラは組み込み名を固定の写像で置換するため、同名のUDFは到達不能になる
    const LUMINA_BUILTIN_FN_NAMES = new Set(
        Object.keys(LUMINA_FN_REGISTRY)
            .reduce((acc, cat) => acc.concat(LUMINA_FN_REGISTRY[cat].split(' ')), [])
            .map(n => n.toLowerCase())
    );

    Object.assign(DatabaseEngine.prototype, {

      _isBuiltinFunctionName(name) {
          return LUMINA_BUILTIN_FN_NAMES.has(String(name).toLowerCase());
      },

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
      // 未指定は RESTRICT（既定）。対応: CASCADE / SET NULL / SET DEFAULT / RESTRICT / NO ACTION
      // （SET DEFAULT は v1.25 で追加。従来は綴りが解釈されず黙って RESTRICT に落ちていた）
      _parseFkActions(tail) {
          tail = tail || '';
          const dm = tail.match(/on\s+delete\s+(cascade|set\s+null|set\s+default|no\s+action|restrict)/i);
          const um = tail.match(/on\s+update\s+(cascade|set\s+null|set\s+default|no\s+action|restrict)/i);
          const norm = (mm) => mm ? mm[1].toUpperCase().replace(/\s+/g, ' ') : 'RESTRICT';
          return { onDelete: norm(dm), onUpdate: norm(um) };
      },

      // ADD CONSTRAINT <name> で付いた名前を表へ登録する（DROP CONSTRAINT の逆引き用）。
      // 実体は uniqueCols / compositeKeys / foreignKeys 側にあり、ここは索引だけを持つ
      // 名前付き索引の台帳（this.indexNames）を列の改名・削除に追随させる。
      // 台帳は Table.indices とは別管理なので、ここを忘れると
      // 「SHOW INDEXES の名前が消える」「DROP INDEX で消せない索引が残る」ことになる。
      // newCol が null のときは削除（その列を含む索引定義ごと落とす）
      _syncIndexNamesOnColumnChange(table, oldCol, newCol) {
          if (!this.indexNames) return;
          for (const nm of Object.keys(this.indexNames)) {
              const rec = this.indexNames[nm];
              if (!rec || rec.table !== table) continue;
              const cols = rec.cols || [];
              if (!cols.some(c => String(c).toLowerCase() === oldCol)) continue;
              if (newCol === null) delete this.indexNames[nm];
              else rec.cols = cols.map(c => String(c).toLowerCase() === oldCol ? newCol : c);
          }
      },

      // 削除しようとしている列に依存する生成列があれば明示的に拒否する。
      // 黙って落とすと「その表へ挿入できない」状態になるだけで原因が判らない
      _assertNoGeneratedDependents(t, table, col) {
          for (const g in (t.generatedCols || {})) {
              if (g === col) continue;
              if (Table.exprRefsCol(t.generatedCols[g], col)) {
                  throw new Error(`Cannot drop column '${col}': generated column '${g}' of '${table}' depends on it. Drop '${g}' first.`);
              }
          }
      },

      _recordConstraintName(t, name, kind, cols) {
          if (!name) return;
          t.constraintNames = t.constraintNames || Object.create(null);
          if (t.constraintNames[name]) throw new Error(`Constraint '${name}' already exists.`);
          t.constraintNames[name] = { kind, cols: [...cols] };
      },

      // 名前で引いた制約の実体を外す。単一列と複合で保持場所が違うため両方を掃除する
      _dropNamedConstraint(t, name, entry) {
          const cols = entry.cols || [];
          if (entry.kind === 'fk') {
              t.foreignKeys = (t.foreignKeys || []).filter(fk => !(fk.name === name || (!fk.name && this._fkCols(fk).join(',') === cols.join(','))));
          } else if (entry.kind === 'unique') {
              if (cols.length === 1) t.uniqueCols = (t.uniqueCols || []).filter(c => c !== cols[0]);
              t.compositeKeys = (t.compositeKeys || []).filter(ck => ck.isPK || ck.cols.join(',') !== cols.join(','));
          } else if (entry.kind === 'pk') {
              if (cols.length === 1 && t.primaryKey === cols[0]) t.primaryKey = null;
              t.compositeKeys = (t.compositeKeys || []).filter(ck => !(ck.isPK && ck.cols.join(',') === cols.join(',')));
          }
          delete t.constraintNames[name];
      },

      // DEFAULT 句のリテラルトークンを JS 値へ解釈する
      // （CREATE TABLE / ALTER ... SET DEFAULT / ADD COLUMN DEFAULT で共用）
      _parseDefaultLiteral(raw, strMap) {
          raw = String(raw).trim();
          // CURRENT_TIMESTAMP / NOW(): 挿入時に評価するマーカーとして保存する
          if (/^(?:current_timestamp|now\(\))$/i.test(raw)) return { __currentTimestamp: true };
          const strM = raw.match(/^__STR_(\d+)__$/);
          if (strM && strMap) return this._unquoteLiteral(strMap[Number(strM[1])]);
          if (raw.toLowerCase() === 'null') return null;
          if (raw.toLowerCase() === 'true') return true;
          if (raw.toLowerCase() === 'false') return false;
          if (!isNaN(raw)) return Number(raw);
          // 関数呼び出し / 括弧式は「挿入時に評価する式」として保存する
          // （NEXTVAL('s') / UUID() / (1+2) など。以前はテキストのまま格納され、
          //   挿入時に型変換エラーになるか文字列がそのまま入っていた）
          if (raw.indexOf('(') !== -1) {
              const expr = strMap ? this._restoreStrings(raw, strMap) : raw;
              // 定義時に構文と関数名を検証する。実行時の未知関数は行評価の catch に
              // 飲まれて黙って NULL になるため、ここで名前を照合しておく
              const sm = [];
              const masked = this._maskStrings(expr, sm);
              let fm;
              const fnRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
              while ((fm = fnRe.exec(masked))) {
                  const fname = fm[1].toLowerCase();
                  if (LUMINA_BUILTIN_FN_NAMES.has(fname)) continue;
                  if (this.functions && this.functions[fname]) continue;
                  if (['case', 'cast', 'convert', 'if', 'iif', 'coalesce', 'array'].includes(fname)) continue;
                  throw new Error(`Unknown function '${fm[1]}' in DEFAULT expression.`);
              }
              this.compileCondition(masked, sm);
              return { __expr: expr };
          }
          return raw;
      },

      // DEFAULT CURRENT_TIMESTAMP のマーカー判定と現在時刻文字列
      _isNowMarker(v) {
          return !!(v && typeof v === 'object' && v.__currentTimestamp === true);
      },

      // DEFAULT に式（関数呼び出しや括弧式）が指定されているか。
      // `DEFAULT NEXTVAL('s')` / `DEFAULT UUID()` / `DEFAULT (1+2)` を挿入時に評価するため、
      // 定義時はテキストのまま保持しておく
      _isExprDefault(v) {
          return !!(v && typeof v === 'object' && typeof v.__expr === 'string');
      },

      // CREATE VIEW v (c1, c2) AS SELECT ... の列リストを本体の別名として畳み込む。
      // 派生表で包むと更新可能ビューでなくなってしまうため、SELECT 句の各項目へ
      // 直接 AS を付け替える。列数は本体を 1 度実行して確認する
      _applyViewColumnList(body, colList, strMap) {
          const probe = this.executeQuery(`SELECT * FROM (${this._restoreStrings(body, strMap)}) __vcl LIMIT 0`);
          if (probe.error) throw new Error(`VIEW body failed: ${probe.error}`);
          const produced = probe.columns || (probe.data[0] ? Object.keys(probe.data[0]) : null);
          // LIMIT 0 で行が無い場合は SELECT 句の項目数で代用する
          const selEnd = this._topLevelKeyword(body, 'from');
          const selClause = selEnd === -1 ? body.replace(/^select\s+/i, '') : body.slice(0, selEnd).replace(/^select\s+/i, '');
          const items = this.splitSelectClause(selClause).map(x => x.trim()).filter(x => x !== '');
          // '*' は位置で別名を付けられない（展開後の列数が定義時に確定しない）ので先に弾く
          if (items.some(x => x === '*' || /\.\s*\*$/.test(x))) {
              throw new Error("A view column list cannot be combined with SELECT * — list the columns explicitly.");
          }
          const arity = produced ? produced.length : items.length;
          if (arity !== colList.length) {
              throw new Error(`View column list has ${colList.length} names but the query returns ${arity} columns.`);
          }
          if (items.length !== colList.length) {
              throw new Error(`View column list has ${colList.length} names but the SELECT clause has ${items.length} items.`);
          }
          const renamed = items.map((item, i) => `${item.replace(/\s+as\s+[a-zA-Z0-9_]+$/i, '')} AS ${colList[i]}`);
          const rebuilt = `SELECT ${renamed.join(', ')}` + (selEnd === -1 ? '' : ' ' + body.slice(selEnd));
          // 付け替えた結果が本当にその列名を返すか確かめる（AS 無しの別名などを取りこぼさない）
          const check = this.executeQuery(`SELECT * FROM (${this._restoreStrings(rebuilt, strMap)}) __vcl LIMIT 1`);
          if (check.error) throw new Error(`View column list could not be applied: ${check.error}`);
          const got = check.columns || (check.data[0] ? Object.keys(check.data[0]) : colList);
          if (got.join(',') !== colList.join(',')) {
              throw new Error(`View column list could not be applied (got ${got.join(', ')}). Use explicit 'expr AS name' items.`);
          }
          return rebuilt;
      },

      // `DEFAULT <値>` の値部分を切り出す。関数呼び出しや括弧式も 1 トークンとして
      // 取れるよう、空白ではなく括弧の対応で終端を決める。
      // 見つからなければ null、見つかれば { raw, start, end }（end は値の直後）
      _takeDefaultToken(text) {
          const dm = text.match(/\bdefault\s+/i);
          if (!dm) return null;
          let e = dm.index + dm[0].length, depth = 0;
          while (e < text.length) {
              const ch = text[e];
              if (ch === '(') depth++;
              else if (ch === ')') { if (depth === 0) break; depth--; }
              else if (/\s/.test(ch) && depth === 0) {
                  // 空白の次が '(' なら関数名と引数の間の空白なので続行する
                  if (!/^\s*\(/.test(text.slice(e))) break;
              }
              e++;
          }
          return { raw: text.slice(dm.index + dm[0].length, e), start: dm.index, end: e };
      },

      // DEFAULT の保存形を DDL 表示用のテキストへ戻す（SHOW CREATE TABLE / DESCRIBE / メタデータ共用）
      _defaultToText(dv) {
          if (dv === undefined) return null;
          if (this._isNowMarker(dv)) return 'CURRENT_TIMESTAMP';
          if (this._isExprDefault(dv)) return dv.__expr;
          return dv;
      },

      // DEFAULT の保存形（リテラル / CURRENT_TIMESTAMP マーカー / 式マーカー）を実値へ解決する。
      // 式は行ごとに呼ばれるので NEXTVAL のように毎回違う値を返すものも正しく働く
      _resolveDefaultValue(dv) {
          if (this._isNowMarker(dv)) return this._nowString();
          if (this._isExprDefault(dv)) {
              const sm = [];
              const fn = this.compileCondition(this._maskStrings(dv.__expr, sm), sm);
              return fn({}, this.tables, {});
          }
          return dv;
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

      // ============ ストアドプロシージャの手続き型制御構造 ============
      // DECLARE / SET / IF..ELSEIF..ELSE..END IF / WHILE..DO..END WHILE /
      // [label:] LOOP..END LOOP / REPEAT..UNTIL..END REPEAT / LEAVE / ITERATE / RETURN
      // をサポートする。ローカル変数は呼び出しスコープに持ち、埋め込み SQL 文へは
      // 実行直前にリテラルとして差し込む（同名の列があるとローカルが優先される点は
      // 実 DB のルーチンと同じ挙動）。

      // 本文を文単位へ分割する。';' で切るが、IF / WHILE / LOOP / REPEAT / BEGIN / CASE
      // のブロックは丸ごと 1 つの要素として保つ（'END IF' の IF を開始と誤認しないよう、
      // END は直後のキーワードごと消費する）
      _splitProcBody(text) {
          const parts = [];
          const isW = (ch) => /[a-zA-Z0-9_]/.test(ch);
          const OPENERS = ['IF', 'WHILE', 'LOOP', 'REPEAT', 'BEGIN', 'CASE'];
          let cur = '', depth = 0, block = 0, i = 0;
          while (i < text.length) {
              const c = text[i];
              if (c === "'" || c === '"') {
                  let j = i + 1;
                  while (j < text.length) {
                      if (text[j] === '\\') { j += 2; continue; }
                      if (text[j] === c) { j++; break; }
                      j++;
                  }
                  cur += text.slice(i, j); i = j; continue;
              }
              if (c === '(') { depth++; cur += c; i++; continue; }
              if (c === ')') { depth--; cur += c; i++; continue; }
              if (isW(c) && (i === 0 || !isW(text[i - 1]))) {
                  let j = i;
                  while (j < text.length && isW(text[j])) j++;
                  const w = text.slice(i, j).toUpperCase();
                  if (depth === 0) {
                      if (w === 'END') {
                          block--;
                          const em = /^\s+(IF|WHILE|LOOP|REPEAT|CASE)\b/i.exec(text.slice(j));
                          if (em) { cur += text.slice(i, j + em[0].length); i = j + em[0].length; continue; }
                      } else if (OPENERS.includes(w)) {
                          block++;
                      }
                  }
                  cur += text.slice(i, j); i = j; continue;
              }
              if (c === ';' && depth === 0 && block <= 0) { parts.push(cur.trim()); cur = ''; i++; continue; }
              cur += c; i++;
          }
          if (cur.trim() !== '') parts.push(cur.trim());
          return parts.filter(p => p !== '');
      },

      // 制御構造ブロックの形が正しいかを定義時に検査する（再帰的に中身も見る）
      _validateProcBody(stmts) {
          stmts.forEach(st => {
              const t = st.trim();
              if (/^if\b/i.test(t)) {
                  if (!/\bend\s+if$/i.test(t)) throw new Error('Syntax Error in IF: missing END IF.');
                  const parsed = this._parseIfStatement(t);
                  parsed.conds.forEach(b => this._validateProcBody(this._splitProcBody(b.body)));
                  if (parsed.elseBody) this._validateProcBody(this._splitProcBody(parsed.elseBody));
              } else if (/^while\b/i.test(t)) {
                  const m = t.match(/^while\s+([\s\S]+?)\s+do\s+([\s\S]+?)\s+end\s+while$/i);
                  if (!m) throw new Error('Syntax Error in WHILE. Use WHILE <cond> DO ... END WHILE.');
                  this._validateProcBody(this._splitProcBody(m[2]));
              } else if (/^repeat\b/i.test(t)) {
                  const m = t.match(/^repeat\s+([\s\S]+?)\s+until\s+([\s\S]+?)\s+end\s+repeat$/i);
                  if (!m) throw new Error('Syntax Error in REPEAT. Use REPEAT ... UNTIL <cond> END REPEAT.');
                  this._validateProcBody(this._splitProcBody(m[1]));
              } else if (/^case\b/i.test(t)) {
                  if (!/\bend\s+case$/i.test(t)) throw new Error('Syntax Error in CASE statement: missing END CASE.');
                  const c = this._parseCaseStatement(t);
                  c.branches.forEach(b => this._validateProcBody(this._splitProcBody(b.body)));
                  if (c.elseBody) this._validateProcBody(this._splitProcBody(c.elseBody));
              } else if (/^declare\s+(?:continue|exit)\s+handler\b/i.test(t)) {
                  if (!/^declare\s+(?:continue|exit)\s+handler\s+for\s+(?:not\s+found|sqlexception|sqlwarning|sqlstate\s+(?:value\s+)?'[^']*')\s+[\s\S]+$/i.test(t)) {
                      throw new Error("Syntax Error in DECLARE HANDLER. Use DECLARE {CONTINUE|EXIT} HANDLER FOR {NOT FOUND|SQLEXCEPTION|SQLSTATE 'xxxxx'} <statement>.");
                  }
              } else if (/^fetch\b/i.test(t)) {
                  if (!/^fetch\s+(?:next\s+from\s+|from\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s+into\s+[\s\S]+$/i.test(t)) {
                      throw new Error('Syntax Error in FETCH. Use FETCH [NEXT FROM] <cursor> INTO <var>[, ...].');
                  }
              } else if (/^(?:[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*)?loop\b/i.test(t)) {
                  const m = t.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*)?loop\s+([\s\S]+?)\s+end\s+loop(?:\s+[a-zA-Z_][a-zA-Z0-9_]*)?$/i);
                  if (!m) throw new Error('Syntax Error in LOOP. Use [label:] LOOP ... END LOOP.');
                  this._validateProcBody(this._splitProcBody(m[2]));
              }
          });
      },

      // JS 値を SQL リテラルへ
      _procLiteral(v) {
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          return this._quoteLiteral(String(v));
      },

      // ローカル変数（および @名 での参照）をリテラルへ差し替える。文字列リテラル内は保護する
      _substProcLocals(text, scope) {
          const names = Object.keys(scope);
          if (names.length === 0 || !/[a-zA-Z_@]/.test(text)) return text;
          const sm = [];
          let s = this._maskStrings(text, sm);
          names.sort((a, b) => b.length - a.length).forEach(n => {
              const lit = this._procLiteral(scope[n]);
              s = s.replace(new RegExp('@?\\b' + n + '\\b', 'gi'), () => lit);
          });
          return this._restoreStrings(s, sm);
      },

      // 制御構造の条件式・代入式をスコープ込みで評価する
      _evalProcExpr(text, scope) {
          const sm = [];
          const masked = this._maskStrings(this._substProcLocals(text, scope), sm);
          const v = this.compileCondition(masked, sm)({}, this.tables, {});
          return v === undefined ? null : v;
      },

      // 条件（NOT FOUND / SQLEXCEPTION / SQLSTATE）に一致するハンドラを探す。
      // SQL 標準どおり SQLEXCEPTION は「'00'/'01'/'02' で始まらない SQLSTATE」を捕まえる
      _findProcHandler(ctx, e) {
          // 文単位タイムアウトや反復回数上限は「保証」なのでハンドラでは捕まえない
          if (e && e.__fatal) return null;
          const cond = e && e.sqlCondition ? e.sqlCondition : 'SQLEXCEPTION';
          const state = e && e.sqlstate ? e.sqlstate : '45000';
          for (let i = ctx.handlers.length - 1; i >= 0; i--) {
              const h = ctx.handlers[i];
              if (h.cond === 'SQLSTATE:' + state) return h;
              if (h.cond === 'NOTFOUND' && cond === 'NOTFOUND') return h;
              if (h.cond === 'SQLWARNING' && /^01/.test(state)) return h;
              if (h.cond === 'SQLEXCEPTION' && cond !== 'NOTFOUND' && !/^(00|01|02)/.test(state)) return h;
          }
          return null;
      },

      // 文のリストを順に実行する。戻り値 { last, signal } の signal は
      // LEAVE / ITERATE / RETURN / EXIT（EXIT HANDLER によるブロック脱出）
      _runProcBlock(stmts, ctx) {
          let last = null;
          for (const raw of stmts) {
              this._checkDeadline();
              const st = raw.trim();
              if (st === '') continue;
              let m;
              try {

              // DECLARE <name> CURSOR FOR <select>: 結果集合を 1 行ずつ手続き的に読む
              if ((m = st.match(/^declare\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+cursor\s+for\s+([\s\S]+)$/i))) {
                  ctx.cursors[m[1].toLowerCase()] = { sql: m[2].trim(), rows: null, pos: 0, open: false };
                  continue;
              }
              // DECLARE {CONTINUE|EXIT} HANDLER FOR {NOT FOUND|SQLEXCEPTION|SQLSTATE 'xxxxx'} <statement>
              if ((m = st.match(/^declare\s+(continue|exit)\s+handler\s+for\s+([\s\S]+)$/i))) {
                  const kind = m[1].toUpperCase();
                  const rest = m[2].trim();
                  const cm = rest.match(/^(not\s+found|sqlexception|sqlwarning|sqlstate\s+(?:value\s+)?'([^']*)')\s+([\s\S]+)$/i);
                  if (!cm) throw new Error("Syntax Error in DECLARE HANDLER. Use DECLARE {CONTINUE|EXIT} HANDLER FOR {NOT FOUND|SQLEXCEPTION|SQLSTATE 'xxxxx'} <statement>.");
                  const head = cm[1].toUpperCase().replace(/\s+/g, ' ');
                  const cond = cm[2] ? 'SQLSTATE:' + cm[2] : (head.indexOf('NOT FOUND') === 0 ? 'NOTFOUND' : head);
                  ctx.handlers.push({ kind, cond, body: cm[3].trim() });
                  continue;
              }
              if ((m = st.match(/^open\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i))) {
                  const cur = ctx.cursors[m[1].toLowerCase()];
                  if (!cur) throw new Error(`Cursor '${m[1]}' is not declared.`);
                  const res = this.executeQuery(this._substProcLocals(cur.sql, ctx.scope));
                  if (res.error) throw new Error(res.error);
                  cur.rows = res.data || [];
                  cur.pos = 0;
                  cur.open = true;
                  continue;
              }
              if ((m = st.match(/^close\s+([a-zA-Z_][a-zA-Z0-9_]*)$/i))) {
                  const cur = ctx.cursors[m[1].toLowerCase()];
                  if (!cur) throw new Error(`Cursor '${m[1]}' is not declared.`);
                  cur.open = false; cur.rows = null; cur.pos = 0;
                  continue;
              }
              if ((m = st.match(/^fetch\s+(?:next\s+from\s+|from\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+into\s+([\s\S]+)$/i))) {
                  const cur = ctx.cursors[m[1].toLowerCase()];
                  if (!cur) throw new Error(`Cursor '${m[1]}' is not declared.`);
                  if (!cur.open) throw new Error(`Cursor '${m[1]}' is not open.`);
                  const targets = m[2].split(',').map(x => x.trim().replace(/^@/, '').toLowerCase());
                  if (cur.pos >= cur.rows.length) {
                      // 行が尽きた: NOT FOUND 条件（ハンドラがなければエラー）
                      const e = new Error('No data - zero rows fetched, selected, or processed.');
                      e.sqlCondition = 'NOTFOUND';
                      e.sqlstate = '02000';
                      throw e;
                  }
                  const row = cur.rows[cur.pos++];
                  const keys = Object.keys(row);
                  if (targets.length !== keys.length) {
                      throw new Error(`FETCH: cursor returns ${keys.length} column(s) but ${targets.length} variable(s) were given.`);
                  }
                  targets.forEach((tv, k) => { ctx.scope[tv] = row[keys[k]]; });
                  continue;
              }
              // SIGNAL / RESIGNAL: 手続きから明示的にエラーを起こす
              if ((m = st.match(/^(re)?signal(?:\s+sqlstate\s+(?:value\s+)?'([^']*)')?(?:\s+set\s+([\s\S]+))?$/i))) {
                  let msg = 'Unhandled user-defined exception.';
                  if (m[3]) {
                      const tm = m[3].match(/message_text\s*=\s*([\s\S]+)$/i);
                      if (tm) {
                          const v = this._evalProcExpr(tm[1].trim().replace(/,\s*[a-zA-Z_]+\s*=[\s\S]*$/, ''), ctx.scope);
                          if (v !== null && v !== undefined) msg = String(v);
                      }
                  }
                  const e = new Error(msg);
                  e.sqlstate = m[2] || '45000';
                  e.sqlCondition = 'SQLEXCEPTION';
                  throw e;
              }
              // CASE 文（式の CASE ... END とは別物。END CASE で閉じる）
              if (/^case\b[\s\S]*\bend\s+case$/i.test(st)) {
                  const parsed = this._parseCaseStatement(st);
                  let taken = null;
                  for (const b of parsed.branches) {
                      const hit = parsed.operand === null
                          ? this._truthy(this._evalProcExpr(b.when, ctx.scope))
                          : this._evalProcExpr(`(${parsed.operand}) = (${b.when})`, ctx.scope) === true;
                      if (hit) { taken = b.body; break; }
                  }
                  if (taken === null) taken = parsed.elseBody;
                  if (taken === null || taken === undefined) {
                      const e = new Error('Case not found for CASE statement.');
                      e.sqlstate = '20000';
                      e.sqlCondition = 'SQLEXCEPTION';
                      throw e;
                  }
                  const r = this._runProcBlock(this._splitProcBody(taken), ctx);
                  if (r.last) last = r.last;
                  if (r.signal) return { last, signal: r.signal };
                  continue;
              }

              if ((m = st.match(/^declare\s+([\s\S]+)$/i))) {
                  // DECLARE a [, b] [type] [DEFAULT expr]
                  let rest = m[1];
                  let defExpr = null;
                  const dm = rest.match(/\bdefault\s+([\s\S]+)$/i);
                  if (dm) { defExpr = dm[1].trim(); rest = rest.slice(0, dm.index).trim(); }
                  rest = rest.replace(/\s+[a-zA-Z][a-zA-Z0-9_]*(\s*\(\s*\d+\s*(,\s*\d+\s*)?\))?\s*$/, '');
                  const names = rest.split(',').map(x => x.trim().replace(/^@/, '').toLowerCase()).filter(x => x !== '');
                  if (names.length === 0 || names.some(n => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n))) {
                      throw new Error(`Syntax Error in DECLARE near '${st.slice(0, 40)}'.`);
                  }
                  const v = defExpr === null ? null : this._evalProcExpr(defExpr, ctx.scope);
                  names.forEach(n => { ctx.scope[n] = v; });
                  continue;
              }

              if ((m = st.match(/^set\s+@?([a-zA-Z_][a-zA-Z0-9_]*)\s*:?=\s*([\s\S]+)$/i))
                  && Object.prototype.hasOwnProperty.call(ctx.scope, m[1].toLowerCase())) {
                  ctx.scope[m[1].toLowerCase()] = this._evalProcExpr(m[2].trim(), ctx.scope);
                  continue;
              }

              if (/^if\b/i.test(st)) {
                  const branches = this._parseIfStatement(st);
                  let taken = null;
                  for (const b of branches.conds) {
                      if (this._truthy(this._evalProcExpr(b.cond, ctx.scope))) { taken = b.body; break; }
                  }
                  if (taken === null) taken = branches.elseBody;
                  if (taken) {
                      const r = this._runProcBlock(this._splitProcBody(taken), ctx);
                      if (r.last) last = r.last;
                      if (r.signal) return { last, signal: r.signal };
                  }
                  continue;
              }

              if ((m = st.match(/^while\s+([\s\S]+?)\s+do\s+([\s\S]+?)\s+end\s+while$/i))) {
                  const body = this._splitProcBody(m[2]);
                  let n = 0;
                  while (this._truthy(this._evalProcExpr(m[1], ctx.scope))) {
                      if (++n > 1000000) throw this._fatalError("WHILE loop exceeded 1,000,000 iterations.");
                      this._checkDeadline();
                      const r = this._runProcBlock(body, ctx);
                      if (r.last) last = r.last;
                      if (r.signal) {
                          if (r.signal.type === 'return') return { last, signal: r.signal };
                          if (r.signal.type === 'leave' && (!r.signal.label || r.signal.label === ctx.label)) break;
                          if (r.signal.type === 'iterate' && (!r.signal.label || r.signal.label === ctx.label)) continue;
                          return { last, signal: r.signal };
                      }
                  }
                  continue;
              }

              if ((m = st.match(/^repeat\s+([\s\S]+?)\s+until\s+([\s\S]+?)\s+end\s+repeat$/i))) {
                  const body = this._splitProcBody(m[1]);
                  let n = 0;
                  do {
                      if (++n > 1000000) throw this._fatalError("REPEAT loop exceeded 1,000,000 iterations.");
                      this._checkDeadline();
                      const r = this._runProcBlock(body, ctx);
                      if (r.last) last = r.last;
                      if (r.signal) {
                          if (r.signal.type === 'return') return { last, signal: r.signal };
                          if (r.signal.type === 'leave') break;
                          return { last, signal: r.signal };
                      }
                  } while (!this._truthy(this._evalProcExpr(m[2], ctx.scope)));
                  continue;
              }

              if ((m = st.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*)?loop\s+([\s\S]+?)\s+end\s+loop(?:\s+[a-zA-Z_][a-zA-Z0-9_]*)?$/i))) {
                  const label = m[1] ? m[1].toLowerCase() : null;
                  const body = this._splitProcBody(m[2]);
                  const inner = { scope: ctx.scope, cursors: ctx.cursors, handlers: ctx.handlers, label };
                  let n = 0, done = false;
                  while (!done) {
                      if (++n > 1000000) throw this._fatalError("LOOP exceeded 1,000,000 iterations (add a LEAVE).");
                      this._checkDeadline();
                      const r = this._runProcBlock(body, inner);
                      if (r.last) last = r.last;
                      if (r.signal) {
                          if (r.signal.type === 'return') return { last, signal: r.signal };
                          if (r.signal.type === 'leave' && (!r.signal.label || r.signal.label === label)) done = true;
                          else if (r.signal.type === 'iterate' && (!r.signal.label || r.signal.label === label)) continue;
                          else return { last, signal: r.signal };
                      }
                  }
                  continue;
              }

              if ((m = st.match(/^(leave|iterate)(?:\s+([a-zA-Z_][a-zA-Z0-9_]*))?$/i))) {
                  return { last, signal: { type: m[1].toLowerCase(), label: m[2] ? m[2].toLowerCase() : null } };
              }
              if ((m = st.match(/^return(?:\s+([\s\S]+))?$/i))) {
                  const v = m[1] ? this._evalProcExpr(m[1].trim(), ctx.scope) : null;
                  return { last, signal: { type: 'return', value: v } };
              }
              if (/^begin\s+[\s\S]*\s+end$/i.test(st)) {
                  const bm = st.match(/^begin\s+([\s\S]*)\s+end$/i);
                  const r = this._runProcBlock(this._splitProcBody(bm[1]), ctx);
                  if (r.last) last = r.last;
                  if (r.signal) return { last, signal: r.signal };
                  continue;
              }

              // 通常の SQL 文: ローカル変数をリテラルへ差し込んでから実行する
              const sqlText = this._substProcLocals(st, ctx.scope);
              const res = this.executeQuery(sqlText);
              if (res.error) throw new Error(res.error);
              last = res;
              } catch (e) {
                  // DECLARE HANDLER が宣言されていれば条件を捕まえる。
                  // CONTINUE は次の文へ、EXIT は囲みブロックを抜ける
                  const h = this._findProcHandler(ctx, e);
                  if (!h) throw e;
                  const hr = this._runProcBlock(this._splitProcBody(h.body), ctx);
                  if (hr.last) last = hr.last;
                  if (hr.signal) return { last, signal: hr.signal };
                  if (h.kind === 'EXIT') return { last, signal: { type: 'exit' } };
              }
          }
          return { last, signal: null };
      },

      // CASE 文（CASE <expr> WHEN v THEN ... / CASE WHEN cond THEN ...、END CASE で閉じる）
      _parseCaseStatement(st) {
          const body = st.replace(/^case\b/i, '').replace(/\s*end\s+case$/i, '');
          const isW = (ch) => /[a-zA-Z0-9_]/.test(ch);
          const marks = [];
          let depth = 0, block = 0;
          for (let i = 0; i < body.length; i++) {
              const c = body[i];
              if (c === "'" || c === '"') {
                  let j = i + 1;
                  while (j < body.length) { if (body[j] === '\\') { j += 2; continue; } if (body[j] === c) break; j++; }
                  i = j; continue;
              }
              if (c === '(') { depth++; continue; }
              if (c === ')') { depth--; continue; }
              if (!isW(c) || (i > 0 && isW(body[i - 1]))) continue;
              let j = i;
              while (j < body.length && isW(body[j])) j++;
              const w = body.slice(i, j).toUpperCase();
              if (depth !== 0) { i = j - 1; continue; }
              if (w === 'END') { block--; i = j - 1; continue; }
              if (['IF', 'WHILE', 'LOOP', 'REPEAT', 'BEGIN', 'CASE'].includes(w)) { block++; i = j - 1; continue; }
              if (block === 0 && (w === 'WHEN' || w === 'THEN' || w === 'ELSE')) marks.push({ w, start: i, end: j });
              i = j - 1;
          }
          if (marks.length === 0 || marks[0].w !== 'WHEN') {
              throw new Error("Syntax Error in CASE statement. Use CASE [expr] WHEN ... THEN ... [ELSE ...] END CASE.");
          }
          const operandText = body.slice(0, marks[0].start).trim();
          const operand = operandText === '' ? null : operandText;
          const branches = [];
          let elseBody = null;
          for (let k = 0; k < marks.length; k++) {
              if (marks[k].w !== 'WHEN') continue;
              const thenM = marks[k + 1];
              if (!thenM || thenM.w !== 'THEN') throw new Error("Syntax Error in CASE statement: WHEN requires THEN.");
              const nxt = marks[k + 2];
              branches.push({
                  when: body.slice(marks[k].end, thenM.start).trim(),
                  body: body.slice(thenM.end, nxt ? nxt.start : body.length).trim()
              });
              k++;
          }
          const elseMark = marks.find(x => x.w === 'ELSE');
          if (elseMark) {
              const after = marks.filter(x => x.start > elseMark.start)[0];
              elseBody = body.slice(elseMark.end, after ? after.start : body.length).trim();
          }
          return { operand, branches, elseBody };
      },

      // ハンドラで捕まえられない致命的エラー（時間上限・反復回数上限）
      _fatalError(msg) {
          const e = new Error(msg);
          e.__fatal = true;
          return e;
      },

      _truthy(v) {
          if (v === null || v === undefined) return false;
          if (typeof v === 'number') return v !== 0;
          if (typeof v === 'string') return v !== '' && v !== '0';
          return !!v;
      },

      // IF cond THEN ... [ELSEIF cond THEN ...]* [ELSE ...] END IF を分解する
      _parseIfStatement(st) {
          const body = st.replace(/^if\s+/i, '').replace(/\s+end\s+if$/i, '');
          const conds = [];
          let elseBody = null;
          // トップレベル（ネストした IF/CASE/LOOP の外側）の ELSEIF / ELSE / THEN を探す
          const marks = [];
          const isW = (ch) => /[a-zA-Z0-9_]/.test(ch);
          let depth = 0, block = 0;
          for (let i = 0; i < body.length; i++) {
              const c = body[i];
              if (c === "'" || c === '"') {
                  let j = i + 1;
                  while (j < body.length) { if (body[j] === '\\') { j += 2; continue; } if (body[j] === c) break; j++; }
                  i = j; continue;
              }
              if (c === '(') { depth++; continue; }
              if (c === ')') { depth--; continue; }
              if (!isW(c) || (i > 0 && isW(body[i - 1]))) continue;
              let j = i;
              while (j < body.length && isW(body[j])) j++;
              const w = body.slice(i, j).toUpperCase();
              if (depth !== 0) { i = j - 1; continue; }
              if (w === 'END') { block--; i = j - 1; continue; }
              if (['IF', 'WHILE', 'LOOP', 'REPEAT', 'BEGIN', 'CASE'].includes(w)) { block++; i = j - 1; continue; }
              if (block === 0 && (w === 'THEN' || w === 'ELSEIF' || w === 'ELSE')) marks.push({ w, start: i, end: j });
              i = j - 1;
          }
          if (marks.length === 0 || marks[0].w !== 'THEN') throw new Error("Syntax Error in IF. Use IF <cond> THEN ... [ELSEIF <cond> THEN ...] [ELSE ...] END IF.");
          let cond = body.slice(0, marks[0].start).trim();
          let cursor = marks[0].end;
          for (let k = 1; k <= marks.length; k++) {
              const mk = marks[k];
              const seg = body.slice(cursor, mk ? mk.start : body.length).trim();
              if (cond !== null) conds.push({ cond, body: seg });
              else elseBody = seg;
              if (!mk) break;
              if (mk.w === 'ELSE') { cond = null; cursor = mk.end; }
              else if (mk.w === 'ELSEIF') {
                  const nxt = marks[k + 1];
                  if (!nxt || nxt.w !== 'THEN') throw new Error("Syntax Error in IF: ELSEIF requires THEN.");
                  cond = body.slice(mk.end, nxt.start).trim();
                  cursor = nxt.end;
                  k++;
              } else throw new Error("Syntax Error in IF near THEN.");
          }
          return { conds, elseBody };
      },

      // ストアドプロシージャの実行 (CALL name [(args)])
      _executeCall(sql, strMap) {
          const m = sql.match(/^call\s+([a-zA-Z0-9_]+)\s*(?:\(([\s\S]*)\))?$/i);
          if (!m) throw new Error("Syntax Error in CALL.");
          const name = m[1].toLowerCase();
          const proc = this.procedures[name];
          if (!proc) {
              const s2 = this._suggestName(name, Object.keys(this.procedures));
              throw new Error(`Procedure '${name}' not found.${s2 ? ` Did you mean '${s2}'?` : ''}`);
          }
          const params = (this.procParams && this.procParams[name]) || [];
          const argText = (m[2] || '').trim();
          const args = argText === '' ? [] : this.splitSelectClause(argText);
          if (args.length !== params.length) {
              throw new Error(`Procedure '${name}' expects ${params.length} argument(s), got ${args.length}.`);
          }
          const scope = Object.create(null);
          params.forEach((p, i) => {
              const fn = this.compileCondition(args[i].trim(), strMap || []);
              const v = fn({}, this.tables, {});
              scope[p] = v === undefined ? null : v;
          });
          this._procDepth = (this._procDepth || 0) + 1;
          try {
              if (this._procDepth > 16) throw new Error("Procedure call depth limit exceeded.");
              let r;
              try {
                  r = this._runProcBlock(proc, { scope, cursors: Object.create(null), handlers: [], label: null });
              } catch (e) {
                  throw new Error(`Procedure '${name}': ${e.message}`);
              }
              const lastRes = r.last;
              if (r.signal && r.signal.type === 'return' && r.signal.value !== null && r.signal.value !== undefined) {
                  return { data: [{ Result: r.signal.value }], affectedRows: 0 };
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
          // EXECUTE IMMEDIATE '<sql>' [USING v1, ...]（Oracle / PostgreSQL / SQL標準）:
          // PREPARE を挟まずにその場で組み立てた SQL を実行する
          m = sql.match(/^execute\s+immediate\s+__STR_(\d+)__(?:\s+using\s+([\s\S]+))?$/i);
          if (m) {
              if (!strMap) throw new Error("Syntax Error in EXECUTE IMMEDIATE. Use EXECUTE IMMEDIATE '<sql>' [USING v1, ...].");
              const text = this._unquoteLiteral(strMap[Number(m[1])]);
              if (text.trim() === '') throw new Error("EXECUTE IMMEDIATE: the statement text is empty.");
              let vals = [];
              if (m[2]) {
                  vals = this.splitSelectClause(m[2]).map(p => {
                      const v = this.compileCondition(p.trim(), strMap)({}, this.tables, {});
                      return v === undefined ? null : v;
                  });
              }
              const bound = this._bindPlaceholders(text, vals);
              this._execDepth = (this._execDepth || 0) + 1;
              try {
                  if (this._execDepth > 8) throw new Error("EXECUTE nesting depth limit (8) exceeded.");
                  const r = this.executeQuery(bound);
                  if (r.error) throw new Error(`EXECUTE IMMEDIATE: ${r.error}`);
                  return { data: r.data, affectedRows: r.scannedRows || 0 };
              } finally {
                  this._execDepth--;
              }
          }
          if (/^execute\s+immediate\b/i.test(sql)) {
              throw new Error("EXECUTE IMMEDIATE takes a quoted SQL string: EXECUTE IMMEDIATE '<sql>' [USING v1, ...].");
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

      // CREATE / ALTER SEQUENCE のオプション句を解釈する。
      // 対応: START WITH / INCREMENT BY / MINVALUE / MAXVALUE / NO MINVALUE / NO MAXVALUE /
      //       CYCLE / NO CYCLE / CACHE n（CACHE は単一プロセスなので受理して無視）
      _parseSeqOptions(text) {
          const opts = {};
          let rest = ' ' + (text || '').trim() + ' ';
          const take = (re, apply) => {
              const m = rest.match(re);
              if (m) { apply(m); rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); }
              return !!m;
          };
          take(/\s(?:start\s+with|start)\s+(-?\d+)\s/i, m => { opts.start = parseInt(m[1], 10); });
          take(/\s(?:increment\s+by|increment)\s+(-?\d+)\s/i, m => { opts.increment = parseInt(m[1], 10); });
          take(/\sno\s+minvalue\s/i, () => { opts.minValue = null; })
              || take(/\sminvalue\s+(-?\d+)\s/i, m => { opts.minValue = parseInt(m[1], 10); });
          take(/\sno\s+maxvalue\s/i, () => { opts.maxValue = null; })
              || take(/\smaxvalue\s+(-?\d+)\s/i, m => { opts.maxValue = parseInt(m[1], 10); });
          take(/\sno\s+cycle\s/i, () => { opts.cycle = false; })
              || take(/\scycle\s/i, () => { opts.cycle = true; });
          // CACHE は「何個先まで採番を確保するか」の性能ヒント。単一プロセスでは意味を持たない
          take(/\scache\s+(\d+)\s/i, m => { opts.cache = parseInt(m[1], 10); });
          take(/\sowned\s+by\s+[a-zA-Z0-9_.]+\s/i, () => {});
          if (rest.trim() !== '') opts.__leftover = rest.trim();
          return opts;
      },

      _seqNext(name) {
          const s = this.sequences[String(name).toLowerCase()];
          if (!s) throw new Error(`Sequence '${name}' not found.`);
          if (s.value === null) { s.value = s.start; return s.value; }
          const next = s.value + s.increment;
          // 上限/下限に達したら CYCLE なら反対端へ折り返し、そうでなければエラー
          const overMax = s.maxValue !== undefined && s.maxValue !== null && next > s.maxValue;
          const underMin = s.minValue !== undefined && s.minValue !== null && next < s.minValue;
          if (overMax || underMin) {
              if (!s.cycle) {
                  throw new Error(`Sequence '${name}' reached its ${overMax ? 'MAXVALUE' : 'MINVALUE'} (${overMax ? s.maxValue : s.minValue}).`);
              }
              s.value = overMax
                  ? (s.minValue !== undefined && s.minValue !== null ? s.minValue : s.start)
                  : (s.maxValue !== undefined && s.maxValue !== null ? s.maxValue : s.start);
              return s.value;
          }
          s.value = next;
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
          // SHOW SCHEMAS / DATABASES: 単一スキーマ構成だが、CREATE SCHEMA で記録した名前も出す
          if (/^show\s+(schemas|databases)$/i.test(sql.trim())) {
              const names = ['main'].concat(Object.keys(this.schemas || {}).filter(n => n !== 'main'));
              const data = names.map(n => ({ Schema: n, Note: n === 'main' ? 'all objects live here' : 'accepted for compatibility' }));
              return { data, affectedRows: data.length };
          }
          // SHOW TRANSACTION ISOLATION LEVEL（PostgreSQL）: 実効レベルは常に SERIALIZABLE
          if (/^show\s+transaction\s+isolation\s+level$/i.test(sql.trim())) {
              const requested = (this.sessionSettings || {})['transaction isolation level'];
              return { data: [{ 'transaction_isolation': 'SERIALIZABLE', Requested: requested ? String(requested) : 'SERIALIZABLE' }], affectedRows: 1 };
          }
          // SHOW WARNINGS / SHOW COUNT(*) WARNINGS（MySQL）: 直前の文が出した警告を読む。
          // 警告は致命的でない問題（黙って無視された操作・切り捨て等）の記録
          if (/^show\s+warnings(?:\s+limit\s+\d+)?$/i.test(sql.trim())) {
              const lim = sql.match(/limit\s+(\d+)/i);
              const all = this._warnings || [];
              const data = lim ? all.slice(0, parseInt(lim[1], 10)) : all.slice();
              return { data, affectedRows: data.length };
          }
          if (/^show\s+count\s*\(\s*\*\s*\)\s+warnings$/i.test(sql.trim())) {
              return { data: [{ 'Warnings': (this._warnings || []).length }], affectedRows: 1 };
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
          // SHOW SNAPSHOTS: メモリ内スナップショットの一覧。
          // '__' で始まる名前は画面が内部で使う退避（WHERE なしの UPDATE / DELETE の
          // 直前に取る取り消し用）なので、利用者の一覧には混ぜない
          if (/^show\s+snapshots$/i.test(sql.trim())) {
              const data = Object.keys(this.snapshots).filter(n => !n.startsWith('__')).map(n => ({
                  Snapshot: n, TakenAt: this.snapshots[n].at,
                  Tables: Object.keys(this.snapshots[n].tables).length, Rows: this.snapshots[n].rows
              }));
              return { data, affectedRows: data.length };
          }
          // SHOW PROFILE: 直前に完了したクエリの実測値
          if (/^show\s+profile$/i.test(sql.trim())) {
              const p = this.lastProfile;
              const data = p ? [{ Statement: p.sql, DurationMs: p.ms, Rows: p.rows, Error: p.error }] : [];
              return { data, affectedRows: data.length };
          }
          // SHOW SLOW QUERIES: 閾値（slow_query_threshold, 既定 50ms）を超えたクエリの履歴
          if (/^show\s+slow\s+queries$/i.test(sql.trim())) {
              const data = this.slowLog.slice().reverse()
                  .map((p, i) => ({ '#': i + 1, Statement: p.sql, DurationMs: p.ms, Rows: p.rows, Error: p.error }));
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
              // CREATE FUNCTION で定義したユーザー定義関数も一覧へ含める
              Object.keys(this.functions).forEach(fn => {
                  const label = `${fn.toUpperCase()}(${this.functions[fn].params.join(', ')})`;
                  if (!re || re.test(fn)) data.push({ Function: label, Category: 'User-defined' });
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
              // INSTEAD OF トリガーはビューに付くので、対象にビュー名も許す
              if (target && !this.tables[target] && !this.views[target]) throw this._tableNotFound(target);
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
                  return { Sequence: n, Start: s.start, Increment: s.increment, Value: s.value,
                           MinValue: s.minValue === undefined ? null : s.minValue,
                           MaxValue: s.maxValue === undefined ? null : s.maxValue,
                           Cycle: !!s.cycle };
              });
              return { data, affectedRows: data.length };
          }
          if (/^show\s+prepared$/i.test(sql.trim())) {
              const data = Object.keys(this.prepared).map(n => ({ Statement: n, Sql: this.prepared[n] }));
              return { data, affectedRows: data.length };
          }
          // SHOW INDEXES / SHOW INDEX / SHOW KEYS [FROM table]（後2つは MySQL の綴り）
          const idxM = sql.trim().match(/^show\s+(?:indexes|index|keys)(?:\s+from\s+([a-zA-Z0-9_]+))?$/i);
          if (idxM) {
              const target = idxM[1] ? idxM[1].toLowerCase() : null;
              if (target && !this.tables[target]) throw new Error(`Table '${target}' not found.`);
              const named = this.indexNames || Object.create(null);
              const data = [];
              Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && (!target || t === target))
                  .forEach(t => {
                      const tbl = this.tables[t];
                      // 列ハッシュを持つ索引（PK/UNIQUE 由来の暗黙索引も含む）
                      Object.keys(tbl.indices).forEach(c => {
                          // その列を含む名前付き索引があれば名前・並び順を添える
                          let nm = '', dir = 'ASC', uniq = tbl.primaryKey === c || (tbl.uniqueCols || []).includes(c);
                          for (const k of Object.keys(named)) {
                              const ix = named[k];
                              if (ix.table !== t) continue;
                              const key = (ix.keys || []).find(kk => kk.col === c);
                              if (!key && !(ix.cols || []).includes(c)) continue;
                              nm = k; dir = key ? key.dir : 'ASC'; uniq = uniq || !!ix.unique;
                              break;
                          }
                          data.push({ Table: t, Name: nm, Column: c, Expression: '', Direction: dir, Unique: uniq, Keys: tbl.indices[c].size });
                      });
                      // 式キー（対応する列が無いのでメタデータとしてのみ存在する）
                      Object.keys(named).forEach(k => {
                          if (named[k].table !== t) return;
                          (named[k].keys || []).filter(kk => kk.expr).forEach(kk => {
                              data.push({ Table: t, Name: k, Column: '', Expression: kk.expr, Direction: kk.dir, Unique: !!named[k].unique, Keys: 0 });
                          });
                      });
                  });
              return { data, affectedRows: data.length };
          }
          // SHOW DOMAINS / TYPES: ユーザー定義ドメインと列挙型の一覧
          if (/^show\s+(domains|types)$/i.test(sql.trim())) {
              const data = Object.keys(this.domains || {}).map(n => {
                  const d = this.domains[n];
                  return { Name: n, Kind: d.kind.toUpperCase(), BaseType: d.base,
                           NotNull: !!d.notNull, Default: d.defaultText,
                           Constraint: d.values ? `IN (${d.values.join(', ')})` : (d.check || null) };
              });
              return { data, affectedRows: data.length };
          }
          // SHOW GRANTS / USERS / ROLES: 権限は強制していないので名簿を返すだけ
          if (/^show\s+grants(?:\s+for\s+[a-zA-Z0-9_]+)?$/i.test(sql.trim())) {
              const data = Object.keys(this.roles || {}).map(n => ({
                  Grantee: n, Kind: this.roles[n].kind.toUpperCase(), Privileges: 'ALL',
                  Note: 'LuminaDB does not enforce privileges; GRANT/REVOKE are accepted for script compatibility.'
              }));
              return { data, affectedRows: data.length };
          }
          if (/^show\s+(users|roles)$/i.test(sql.trim())) {
              const want = /users/i.test(sql) ? 'user' : 'role';
              const data = Object.keys(this.roles || {}).filter(n => this.roles[n].kind === want)
                  .map(n => ({ Name: n, Kind: want.toUpperCase() }));
              return { data, affectedRows: data.length };
          }
          // SHOW TABLE STATUS [LIKE 'pat'] (MySQL): 表ごとの行数・列数・制約の概況
          const tstM = sql.trim().match(/^show\s+table\s+status(?:\s+like\s+(__STR_\d+__|'[^']*'))?$/i);
          if (tstM) {
              let pat = null;
              if (tstM[1]) {
                  const sm2 = tstM[1].match(/^__STR_(\d+)__$/);
                  const lit = sm2 ? this._unquoteLiteral(strMap[Number(sm2[1])]) : tstM[1].slice(1, -1);
                  pat = new RegExp('^' + String(lit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              }
              const data = Object.keys(this.tables)
                  .filter(t => !t.startsWith('__tmp_') && (!pat || pat.test(t)))
                  .map(t => {
                      const tbl = this.tables[t];
                      const compPk = (tbl.compositeKeys || []).find(ck => ck.isPK);
                      return {
                          Name: t, Engine: 'Lumina', Rows: tbl.rowCount, Columns: Object.keys(tbl.cols).length,
                          Indexes: Object.keys(tbl.indices).length,
                          ForeignKeys: (tbl.foreignKeys || []).length,
                          Checks: (tbl.checks || []).length,
                          PrimaryKey: tbl.primaryKey || (compPk ? compPk.cols.join(', ') : null),
                          AutoIncrement: tbl.autoIncrementCol || null,
                          Temporary: !!tbl.isTemp,
                          Comment: this.comments['table:' + t] || null
                      };
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
              const vco = (this.viewMeta && this.viewMeta[name]) ? ` WITH ${this.viewMeta[name].checkOption} CHECK OPTION` : '';
              return { data: [{ View: name, CreateView: `CREATE VIEW ${name} AS ${this.views[name]}${vco}` }], affectedRows: 1 };
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
              const ps = (this.procParams && this.procParams[name]) || [];
              return { data: [{ Procedure: name, CreateProcedure: `CREATE PROCEDURE ${name}${ps.length ? '(' + ps.join(', ') + ')' : ''} AS BEGIN ${this.procedures[name].join('; ')} END` }], affectedRows: 1 };
          }
          const scfM = sql.trim().match(/^show\s+create\s+function\s+([a-zA-Z0-9_]+)$/i);
          if (scfM) {
              const name = scfM[1].toLowerCase();
              if (!this.functions[name]) throw new Error(`Function '${name}' not found.`);
              const f = this.functions[name];
              return { data: [{ Function: name, CreateFunction: `CREATE FUNCTION ${name}(${f.params.join(', ')}) RETURNS ${f.returns} AS RETURN ${f.body}` }], affectedRows: 1 };
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
          // SHOW COLUMNS FROM t [LIKE 'pat'] は DESCRIBE のエイリアス（LIKE は列名で絞る）
          const colM = sql.trim().match(/^show\s+(?:full\s+)?columns\s+(?:from|in)\s+([a-zA-Z0-9_]+)(?:\s+like\s+__STR_(\d+)__)?$/i);
          if (colM) {
              const res = this._executeDescribe(`DESCRIBE ${colM[1]}`);
              if (colM[2] === undefined) return res;
              if (!strMap) throw new Error("Syntax Error in SHOW COLUMNS.");
              const pat = this._unquoteLiteral(strMap[Number(colM[2])]);
              const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              const data = res.data.filter(r => re.test(String(r.Column === undefined ? '' : r.Column)));
              return { data, affectedRows: data.length };
          }
          // SHOW ENGINES（MySQL）: 単一のインメモリエンジンだけを持つ
          if (/^show\s+engines$/i.test(sql.trim())) {
              const data = [{ Engine: 'LUMINA', Support: 'DEFAULT', Comment: 'In-memory columnar tables (the only engine)', Transactions: 'YES', Savepoints: 'YES' }];
              return { data, affectedRows: data.length };
          }
          // SHOW CREATE INDEX <name>: インデックスの定義を再構成して返す
          const ciM = sql.trim().match(/^show\s+create\s+index\s+([a-zA-Z0-9_]+)$/i);
          if (ciM) {
              const iname = ciM[1].toLowerCase();
              const ix = (this.indexNames || {})[iname];
              if (!ix) {
                  const s2 = this._suggestName(iname, Object.keys(this.indexNames || {}));
                  throw new Error(`Index '${iname}' not found.${s2 ? ` Did you mean '${s2}'?` : ''} Use SHOW INDEXES [FROM <table>] to list them.`);
              }
              const keys = (ix.keys && ix.keys.length)
                  ? ix.keys.map(k => `${k.expr ? `(${k.expr})` : k.col}${k.dir === 'DESC' ? ' DESC' : ''}`)
                  : (ix.cols || []);
              return {
                  data: [{ Index: iname, Table: ix.table, CreateIndex: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${iname} ON ${ix.table} (${keys.join(', ')})` }],
                  affectedRows: 1
              };
          }
          throw new Error("Syntax Error in SHOW. Use SHOW TABLES [LIKE 'pat'] / VIEWS / PROCEDURES / TRIGGERS [FROM table] / FUNCTIONS [LIKE 'pat'] / VARIABLES / SEQUENCES / PREPARED / CHECKS [FROM table] / INDEXES [FROM table] / COLUMNS FROM <table> [LIKE 'pat'] / ENGINES / STATUS / CREATE TABLE <name> / CREATE VIEW <name> / CREATE INDEX <name> / CREATE PROCEDURE <name>.");
      },

      // CHECK TABLE <t>: 全制約の整合性検査 / ANALYZE TABLE <t>: 列ごとの統計レポート
      _executeTableMaintenance(sql) {
          // CHECKSUM TABLE t[, t2 ...]（MySQL）: 内容から決定的なチェックサムを出す。
          // 同じ内容なら同じ値になるので、取り込み前後の突き合わせに使える
          let cs = sql.trim().replace(/;$/, '').match(/^checksum\s+table\s+([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)(?:\s+(?:quick|extended))?$/i);
          if (cs) {
              const data = cs[1].split(',').map(s => s.trim().toLowerCase()).map(name => {
                  const t = this.tables[name];
                  if (!t) throw this._tableNotFound(name);
                  const cols = t.getColumnNames();
                  // FNV-1a（32bit）。列名と全セルを型付きで畳み込む
                  let h = 0x811c9dc5;
                  const feed = (str) => {
                      for (let i = 0; i < str.length; i++) {
                          h ^= str.charCodeAt(i);
                          h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
                      }
                  };
                  feed(cols.join(''));
                  for (let r = 0; r < t.rowCount; r++) {
                      for (let c = 0; c < cols.length; c++) {
                          const v = t.getValue(cols[c], r);
                          feed('' + (v === null || v === undefined ? '\0' : (typeof v) + ':' + String(v)));
                      }
                  }
                  return { Table: name, Checksum: h >>> 0, Rows: t.rowCount };
              });
              return { data, affectedRows: data.length };
          }
          // REPAIR TABLE t（MySQL）: 壊れ得るファイル構造を持たないので受理のみ
          const rp = sql.trim().replace(/;$/, '').match(/^repair\s+table\s+([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)(?:\s+(?:quick|extended|use_frm))?$/i);
          if (rp) {
              const data = rp[1].split(',').map(s => s.trim().toLowerCase()).map(name => {
                  if (!this.tables[name]) throw this._tableNotFound(name);
                  return { Table: name, Op: 'repair', Msg_type: 'status', Msg_text: 'OK (no-op: LuminaDB tables live in memory and cannot be corrupted on disk; use CHECK TABLE to verify constraints).' };
              });
              return { data, affectedRows: data.length };
          }
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
                  const fkCols = this._fkCols(fk), refCols = this._fkRefCols(fk);
                  const label = `FOREIGN KEY (${fkCols.join(', ')}) -> ${this._fkLabel(fk)}`;
                  const refTbl = this.tables[fk.refTable];
                  if (!refTbl) {
                      report(label, 1, `Referenced table '${fk.refTable}' not found`);
                      return;
                  }
                  let orphans = 0;
                  for (let i = 0; i < t.rowCount; i++) {
                      const tuple = this._fkTupleOrNull((c) => t.getValue(c, i), fkCols);
                      if (tuple === null) continue;
                      if (this._fkMatchRows(refTbl, refCols, tuple).length === 0) orphans++;
                  }
                  report(label, orphans, `${orphans} orphaned value(s)`);
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
          // DESCRIBE t <col> は 1 列だけに絞る（MySQL は列名パターンを受ける）
          const m = sql.trim().replace(/;$/, '').match(/^(?:describe|desc)\s+([a-zA-Z0-9_]+)(?:\s+([a-zA-Z0-9_%]+))?$/i);
          if (!m) throw new Error("Syntax Error in DESCRIBE. Use DESCRIBE <table> [<column>].");
          if (m[2] !== undefined) {
              const res = this._executeDescribe(`DESCRIBE ${m[1]}`);
              if (!Array.isArray(res.data) || res.data.length === 0 || res.data[0].Column === undefined) return res;
              const re = new RegExp('^' + m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
              const data = res.data.filter(r => re.test(String(r.Column)));
              if (data.length === 0) throw new Error(`Column '${m[2].toLowerCase()}' not found in '${m[1].toLowerCase()}'.`);
              return { data, affectedRows: data.length };
          }
          const name = m[1].toLowerCase();
          if (this.views[name]) {
              return { data: [{ View: name, Definition: this.views[name] }], affectedRows: 1 };
          }
          const t = this.tables[name];
          if (!t) throw this._tableNotFound(name);
          const data = t.getColumnNames().map(c => {
              // 複合 FK では対応する参照先列を位置で引く
              const fk = (t.foreignKeys || []).find(f => this._fkCols(f).includes(c));
              const fkRef = fk ? this._fkRefCols(fk)[this._fkCols(fk).indexOf(c)] : null;
              // 複合キーの構成列は '(composite)' 付きで表示する
              const ckPk = (t.compositeKeys || []).some(ck => ck.isPK && ck.cols.includes(c));
              const ckUq = (t.compositeKeys || []).some(ck => !ck.isPK && ck.cols.includes(c));
              return {
                  Column: c,
                  Type: t.colTypes[c] || 'ANY',
                  Key: t.primaryKey === c ? 'PRIMARY' : ((t.uniqueCols || []).includes(c) ? 'UNIQUE' : (ckPk ? 'PRIMARY (composite)' : (ckUq ? 'UNIQUE (composite)' : ''))),
                  Indexed: !!t.indices[c],
                  Collation: (t.collations && t.collations[c]) || '',
                  ForeignKey: fk ? `${fk.refTable}(${fkRef})` : '',
                  NotNull: (t.notNullCols || []).includes(c),
                  Default: (t.defaults && c in t.defaults) ? String(this._defaultToText(t.defaults[c])) : '',
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
              this._logCommentState(key);
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

      // ============ セッション変数 (SET [SESSION] name = value) ============
      // 実DB向けスクリプトの互換のため未知の名前も受理して記録するが、
      // LuminaDB が実際に解釈する変数は下表のものだけ。
      _SESSION_VARS: {
          statement_timeout: 'int',      // 文単位の実行時間上限 (ms)。0 で無制限
          read_only: 'bool',             // 読み取り専用モード
          slow_query_threshold: 'int',   // SHOW SLOW QUERIES に記録する閾値 (ms)
          seed: 'float'                  // RAND()/RANDOM() の決定的な種（NULL で解除）
      },

      // 全表の外部キーを走査し、親の無い子行の説明を配列で返す（空なら整合している）。
      // SET FOREIGN_KEY_CHECKS = 1 に戻すときの検証に使う
      _revalidateForeignKeys() {
          const problems = [];
          for (const tname in this.tables) {
              if (tname.startsWith('__')) continue;
              const t = this.tables[tname];
              if (!t || !t.foreignKeys || t.foreignKeys.length === 0) continue;
              for (const fk of t.foreignKeys) {
                  const cols = this._fkCols(fk);
                  const refCols = this._fkRefCols(fk);
                  const refTbl = this.tables[fk.refTable];
                  if (!refTbl) { problems.push(`${tname}: referenced table '${fk.refTable}' is missing`); continue; }
                  for (let i = 0; i < t.rowCount; i++) {
                      const tuple = this._fkTupleOrNull((c) => t.getValue(c, i), cols);
                      if (tuple === null) continue;   // NULL を含むタプルは検査対象外
                      const norm = tuple.map((v, j) => this._normalizeByColType(t, cols[j], v));
                      if (this._fkMatchRows(refTbl, refCols, norm).length === 0) {
                          problems.push(`${tname}(${cols.join(', ')}) = (${norm.join(', ')}) has no parent in ${fk.refTable}`);
                          if (problems.length >= 50) return problems;   // 上限で打ち切る
                          break;   // 同じ FK で延々報告しない
                      }
                  }
              }
          }
          return problems;
      },

      _executeSetSessionVar(sql, strMap) {
          const raw = this._restoreStrings(sql, strMap).replace(/;$/, '');
          // SET CONSTRAINTS { ALL | name[, ...] } { DEFERRED | IMMEDIATE }（SQL標準）。
          // LuminaDB の制約検査は文の完了時点で必ず走る（＝常に IMMEDIATE）ため、
          // DEFERRED は受理したうえで「遅延しない」ことを警告で伝える
          const scM = raw.match(/^set\s+constraints\s+(all|[a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s+(deferred|immediate)$/i);
          if (scM) {
              const mode = scM[2].toUpperCase();
              this.sessionSettings['constraints'] = mode;
              if (mode === 'DEFERRED') {
                  this._warn('CONSTRAINTS_IMMEDIATE', 'SET CONSTRAINTS ... DEFERRED is accepted but constraints are always checked immediately in LuminaDB. For mutually-referencing tables, use SET FOREIGN_KEY_CHECKS = 0 during the load and set it back to 1 afterwards (which re-validates every table).');
              }
              return { data: [{ Result: 'Success', Message: `Constraints set to ${mode} for ${scM[1]}.` }], affectedRows: 0 };
          }
          // SET FOREIGN_KEY_CHECKS = 0|1（MySQL）/ PRAGMA foreign_keys 相当。
          // 相互参照する 2 表（社員↔部署のような定番の形）は、検査が常に即時だと
          // どちらにも最初の 1 行を入れられない。取り込み・移行のための逃げ道として
          // セッション単位で検査を止められるようにする。
          // **再開時に全表を検査し直す**ので、黙って不整合が残ることはない（MySQL より厳しい）
          const fkcM = raw.match(/^set\s+(?:session\s+|global\s+)?foreign_key_checks\s*(?::=|=|\s+to\s+)\s*(0|1|on|off|true|false)$/i);
          if (fkcM) {
              const v = fkcM[1].toLowerCase();
              const on = !(v === '0' || v === 'off' || v === 'false');
              this.fkChecksEnabled = on;
              if (!on) {
                  return { data: [{ Result: 'Success', Message: 'FOREIGN_KEY_CHECKS = 0. Foreign keys are not enforced until you set it back to 1 (which re-validates every table).' }], affectedRows: 0 };
              }
              const orphans = this._revalidateForeignKeys();
              if (orphans.length > 0) {
                  this.fkChecksEnabled = false;
                  throw new Error(`Cannot re-enable FOREIGN_KEY_CHECKS: ${orphans.length} orphaned row(s) found — ${orphans.slice(0, 3).join('; ')}${orphans.length > 3 ? ' ...' : ''}. Fix the data first; FOREIGN_KEY_CHECKS is still 0.`);
              }
              return { data: [{ Result: 'Success', Message: 'FOREIGN_KEY_CHECKS = 1. All foreign keys re-validated.' }], affectedRows: 0 };
          }
          // 名前は @@var / @@session.var / @@global.var（MySQL）も受ける
          const m = raw.match(/^set\s+(?:session\s+|local\s+|global\s+)?(@@)?((?:session\.|global\.|local\.)?[a-zA-Z_][a-zA-Z0-9_.]*)\s*(?::=|=|\s+to\s+)\s*([\s\S]+)$/i);
          if (!m) throw new Error("Syntax Error in SET. Use SET [SESSION] <name> = <value>.");
          const name = m[2].toLowerCase().replace(/^(?:session|global|local)\./, '');
          let text = m[3].trim().replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
          const kind = this._SESSION_VARS[name];
          const asBool = () => {
              const t = text.toLowerCase();
              if (['on', 'true', '1', 'yes'].includes(t)) return true;
              if (['off', 'false', '0', 'no'].includes(t)) return false;
              throw new Error(`SET ${name}: expected ON/OFF, got '${text}'.`);
          };
          const asNum = (intOnly) => {
              if (/^null$/i.test(text)) return null;
              const n = Number(text);
              if (!isFinite(n) || (intOnly && (n < 0 || Math.trunc(n) !== n))) {
                  throw new Error(`SET ${name}: expected a ${intOnly ? 'non-negative integer' : 'number'}, got '${text}'.`);
              }
              return n;
          };
          if (kind === 'int') {
              const n = asNum(true);
              if (name === 'statement_timeout') this.statementTimeoutMs = n || 0;
              else this.slowLogThresholdMs = n || 0;
          } else if (kind === 'bool') {
              this.readOnly = asBool();
          } else if (kind === 'float') {
              // RAND() の種。式ライブラリ側の状態を切り替える
              const fn = this.compileCondition(`SETSEED(${/^null$/i.test(text) ? 'NULL' : asNum(false)})`, []);
              fn({}, this.tables, {});
          }
          this.sessionSettings[name] = text;
          return { data: [{ Result: "Success", Message: `Session variable '${name}' set to ${text}.` }], affectedRows: 0 };
      },

      // RESET ALL / RESET <name>（PostgreSQL）: セッション変数を既定へ戻す。
      // read_only だけは対象外にする（外部公開時の保護を RESET で外せてしまうため。
      // 解除は SET read_only = OFF で明示的に行う）
      _executeReset(sql) {
          const m = sql.trim().replace(/;$/, '').match(/^reset\s+(all|[a-zA-Z_][a-zA-Z0-9_.]*)$/i);
          if (!m) throw new Error("Syntax Error. Use RESET ALL or RESET <name>.");
          const target = m[1].toLowerCase().replace(/^@@/, '');
          this.sessionSettings = this.sessionSettings || Object.create(null);
          const defaults = (name) => {
              if (name === 'statement_timeout') this.statementTimeoutMs = 0;
              else if (name === 'slow_query_threshold') this.slowLogThresholdMs = 0;
              else if (name === 'seed') { const fn = this.compileCondition('SETSEED(NULL)', []); fn({}, this.tables, {}); }
          };
          if (target === 'all') {
              const kept = this.sessionSettings['read_only'];
              const names = Object.keys(this.sessionSettings);
              names.forEach(n => { if (n !== 'read_only') defaults(n); });
              this.sessionSettings = Object.create(null);
              if (kept !== undefined) this.sessionSettings['read_only'] = kept;
              defaults('statement_timeout');
              defaults('slow_query_threshold');
              defaults('seed');
              return { data: [{ Result: 'Success', Message: `All session variables reset to their defaults (read_only is left as it is; use SET read_only = OFF to change it).` }], affectedRows: 0 };
          }
          if (target === 'read_only') {
              throw new Error("RESET read_only is not allowed. Use SET read_only = OFF so the change is explicit.");
          }
          defaults(target);
          delete this.sessionSettings[target];
          return { data: [{ Result: 'Success', Message: `Session variable '${target}' reset to its default.` }], affectedRows: 0 };
      },

      // DO <expr>[, <expr> ...]（MySQL）: 式を評価して結果を捨てる。
      // 副作用のある式（NEXTVAL / SETVAL / SETSEED）を投げるための入口として使う
      _executeDoStatement(sql, strMap) {
          const body = sql.trim().replace(/;$/, '').replace(/^do\s+/i, '').trim();
          if (body === '') throw new Error("Syntax Error. Use DO <expression>[, <expression> ...].");
          const parts = this.splitSelectClause(body).map(p => p.trim()).filter(p => p !== '');
          if (parts.length === 0) throw new Error("Syntax Error. Use DO <expression>[, <expression> ...].");
          parts.forEach(p => {
              const fn = this.compileCondition(p, strMap);
              fn({}, this.tables, {});
          });
          return { data: [{ Result: 'Success', Message: `DO evaluated ${parts.length} expression(s); results discarded.` }], affectedRows: 0 };
      },

      // ============ スナップショット（メモリ内タイムトラベル） ============
      // CREATE SNAPSHOT n / RESTORE SNAPSHOT n / DROP SNAPSHOT n。
      // ブラウザDBでは「壊す前に戻せる」ことが実用上の安全弁になる（BEGIN/ROLLBACK と違い
      // 複数文・複数トランザクションをまたいで保持できる）。セッション限りで IDB へは保存しない。
      _snapshotState() {
          const tables = Object.create(null);
          for (const tn in this.tables) {
              if (tn.startsWith('__tmp_')) continue;
              tables[tn] = this.tables[tn].cloneFull();
          }
          return {
              tables,
              views: Object.assign(Object.create(null), this.views),
              procedures: JSON.parse(JSON.stringify(this.procedures)),
              procParams: JSON.parse(JSON.stringify(this.procParams || {})),
              userVersion: this.userVersion || 0,
              triggers: JSON.parse(JSON.stringify(this.triggers)),
              sequences: JSON.parse(JSON.stringify(this.sequences)),
              comments: Object.assign(Object.create(null), this.comments),
              matViews: JSON.parse(JSON.stringify(this.matViews)),
              functions: JSON.parse(JSON.stringify(this.functions)),
              rows: Object.keys(tables).reduce((s, k) => s + tables[k].rowCount, 0)
          };
      },

      _executeSnapshot(sql) {
          const m = sql.match(/^(create|drop|restore)\s+snapshot\s+(if\s+not\s+exists\s+|if\s+exists\s+)?([a-zA-Z0-9_]+)\s*$/i);
          if (!m) throw new Error("Syntax Error. Use CREATE|RESTORE|DROP SNAPSHOT <name>.");
          const verb = m[1].toLowerCase();
          const name = m[3].toLowerCase();
          if (verb === 'create') {
              if (this.snapshots[name] && /if\s+not\s+exists/i.test(m[2] || '')) {
                  return { data: [{ Result: "Success", Message: `Snapshot '${name}' already exists. Skipped.` }], affectedRows: 0 };
              }
              if (this.inTransaction) throw new Error("CREATE SNAPSHOT cannot run inside a transaction.");
              const st = this._snapshotState();
              st.at = this._nowString();
              this.snapshots[name] = st;
              return { data: [{ Result: "Success", Message: `Snapshot '${name}' created (${Object.keys(st.tables).length} tables, ${st.rows} rows).` }], affectedRows: 0 };
          }
          if (verb === 'drop') {
              if (!this.snapshots[name]) {
                  if (/if\s+exists/i.test(m[2] || '')) return { data: [{ Result: "Success", Message: `Snapshot '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                  throw new Error(`Snapshot '${name}' not found.`);
              }
              delete this.snapshots[name];
              return { data: [{ Result: "Success", Message: `Snapshot '${name}' dropped.` }], affectedRows: 0 };
          }
          const st = this.snapshots[name];
          if (!st) {
              const s2 = this._suggestName(name, Object.keys(this.snapshots));
              throw new Error(`Snapshot '${name}' not found.${s2 ? ` Did you mean '${s2}'?` : ''}`);
          }
          if (this.inTransaction) throw new Error("RESTORE SNAPSHOT cannot run inside a transaction (COMMIT or ROLLBACK first).");
          this.tables = Object.create(null);
          this._attachEngineRef();
          for (const tn in st.tables) this.tables[tn] = st.tables[tn].cloneFull();
          // JSON.parse は通常のプロトタイプを持つオブジェクトを返すので、
          // SQL 由来のキーを入れる辞書は必ず null プロトタイプへ移し替える
          const nullDict = (o) => Object.assign(Object.create(null), JSON.parse(JSON.stringify(o)));
          this.views = Object.assign(Object.create(null), st.views);
          this.procedures = nullDict(st.procedures);
          this.procParams = nullDict(st.procParams || {});
          this.userVersion = st.userVersion || 0;
          this.triggers = nullDict(st.triggers);
          this.sequences = nullDict(st.sequences);
          this.comments = Object.assign(Object.create(null), st.comments);
          this.matViews = nullDict(st.matViews);
          this.functions = nullDict(st.functions);
          this.undoLog = [];
          return { data: [{ Result: "Success", Message: `Snapshot '${name}' restored (${Object.keys(st.tables).length} tables, ${st.rows} rows, taken at ${st.at}).` }], affectedRows: st.rows };
      },

      // ============ PRAGMA（SQLite 互換のイントロスペクション） ============
      // ブラウザDBは SQLite 系ツールと同じ語彙で扱えると便利なので、よく使う
      // table_info / table_list / index_list / foreign_key_list / user_version に対応する。
      // user_version はスキーマのマイグレーション管理に使う（IDB保存対象）。
      _executePragma(sql, strMap) {
          const m = this._restoreStrings(sql, strMap).match(/^pragma\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\s*([a-zA-Z0-9_]+)\s*\)|=\s*([\s\S]+?))?\s*$/i);
          if (!m) throw new Error("Syntax Error in PRAGMA. Use PRAGMA <name>[(<table>)] or PRAGMA <name> = <value>.");
          const name = m[1].toLowerCase();
          const arg = m[2] ? m[2].toLowerCase() : null;
          const assign = m[3] !== undefined ? String(m[3]).trim().replace(/^'([\s\S]*)'$/, '$1') : null;

          if (name === 'user_version') {
              if (assign !== null) {
                  const n = Number(assign);
                  if (!isFinite(n) || Math.trunc(n) !== n) throw new Error("PRAGMA user_version requires an integer.");
                  this.userVersion = n;
                  return { data: [{ Result: 'Success', Message: `user_version set to ${n}.` }], affectedRows: 0 };
              }
              return { data: [{ user_version: this.userVersion || 0 }], affectedRows: 1 };
          }
          // PRAGMA foreign_keys [= ON|OFF]: SET FOREIGN_KEY_CHECKS と同じ切り替え。
          // 読み出しは SQLite に合わせて 0/1 の 1 行で返す
          if (name === 'foreign_keys') {
              if (assign === null) {
                  return { data: [{ foreign_keys: this.fkChecksEnabled === false ? 0 : 1 }], affectedRows: 1 };
              }
              if (!/^(0|1|on|off|true|false|yes|no)$/i.test(assign)) {
                  throw new Error(`PRAGMA foreign_keys: expected ON/OFF, got '${assign}'.`);
              }
              return this._executeSetSessionVar(`SET FOREIGN_KEY_CHECKS = ${/^(0|off|false|no)$/i.test(assign) ? 0 : 1}`, null);
          }
          if (name === 'table_list') {
              const data = Object.keys(this.tables).filter(t => !t.startsWith('__tmp_')).map(t => ({
                  schema: 'main', name: t, type: this.matViews[t] ? 'view' : 'table',
                  ncol: this.tables[t].getColumnNames().length, wr: 0, strict: 0
              }));
              return { data, affectedRows: data.length };
          }
          const TABLE_PRAGMAS = ['table_info', 'index_list', 'foreign_key_list'];
          if (!TABLE_PRAGMAS.includes(name)) {
              throw new Error(`Unsupported PRAGMA '${name}'. Supported: table_info / table_list / index_list / foreign_key_list / user_version.`);
          }
          if (!arg) throw new Error(`PRAGMA ${name} requires a table name, e.g. PRAGMA ${name}(users).`);
          const t = this.tables[arg];
          if (!t) throw this._tableNotFound(arg);
          if (name === 'table_info') {
              const pks = (t.compositeKeys || []).filter(ck => ck.isPK).flatMap(ck => ck.cols)
                  .concat(t.primaryKey ? [t.primaryKey] : []);
              const data = t.getColumnNames().map((c, i) => ({
                  cid: i, name: c, type: (t.colTypes && t.colTypes[c]) ? t.colTypes[c] : 'ANY',
                  notnull: (t.notNullCols.includes(c) || pks.includes(c)) ? 1 : 0,
                  dflt_value: this._defaultToText(t.defaults[c]),
                  pk: pks.includes(c) ? pks.indexOf(c) + 1 : 0
              }));
              return { data, affectedRows: data.length };
          }
          if (name === 'index_list') {
              const data = Object.keys(t.indices).map((c, i) => ({
                  seq: i, name: `idx_${arg}_${c}`, unique: (t.uniqueCols.includes(c) || t.primaryKey === c) ? 1 : 0,
                  origin: t.primaryKey === c ? 'pk' : (t.uniqueCols.includes(c) ? 'u' : 'c'), partial: 0
              }));
              return { data, affectedRows: data.length };
          }
          if (name === 'foreign_key_list') {
              const data = [];
              (t.foreignKeys || []).forEach((fk, i) => {
                  const fc = this._fkCols(fk), rc = this._fkRefCols(fk);
                  fc.forEach((c, j) => data.push({
                      id: i, seq: j, table: fk.refTable, from: c, to: rc[j],
                      on_update: fk.onUpdate || 'RESTRICT', on_delete: fk.onDelete || 'RESTRICT', match: 'NONE'
                  }));
              });
              return { data, affectedRows: data.length };
          }
          throw new Error(`Unsupported PRAGMA '${name}'. Supported: table_info / table_list / index_list / foreign_key_list / user_version.`);
      },

      // ============ INFORMATION_SCHEMA（標準のカタログビュー） ============
      // information_schema.<name> を参照するクエリの FROM を一時テーブルへ差し替える。
      // expandViews より前に呼ばれる（ビュー本文からの参照も同じ経路を通る）
      _INFO_SCHEMA_VIEWS: ['tables', 'columns', 'views', 'key_column_usage', 'table_constraints', 'schemata', 'routines', 'sequences',
                           'referential_constraints', 'check_constraints', 'statistics', 'triggers', 'parameters'],

      expandInfoSchema(sql) {
          // sqlite_master（SQLite 互換のカタログ表）も同じ仕組みで実体化する
          if (/\bsqlite_master\b/i.test(sql) && !this.tables['sqlite_master']) {
              const rows = [];
              Object.keys(this.tables).filter(t => !t.startsWith('__tmp_')).forEach(t => rows.push({
                  type: this.matViews[t] ? 'view' : 'table', name: t, tbl_name: t, rootpage: 0,
                  sql: this.buildCreateTableSQL ? this.buildCreateTableSQL(t) : `CREATE TABLE ${t}`
              }));
              Object.keys(this.views).forEach(v => rows.push({
                  type: 'view', name: v, tbl_name: v, rootpage: 0, sql: `CREATE VIEW ${v} AS ${this.views[v]}`
              }));
              Object.keys(this.tables).filter(t => !t.startsWith('__tmp_')).forEach(t =>
                  Object.keys(this.tables[t].indices).forEach(c => rows.push({
                      type: 'index', name: `idx_${t}_${c}`, tbl_name: t, rootpage: 0,
                      sql: `CREATE INDEX idx_${t}_${c} ON ${t} (${c})`
                  })));
              this._materializeRows('__tmp_is_sqlite_master', rows);
              sql = sql.replace(/\bsqlite_master\b/gi, '__tmp_is_sqlite_master');
          }
          if (!/information_schema\s*\./i.test(sql)) return sql;
          return sql.replace(/\binformation_schema\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/gi, (m, name) => {
              const key = name.toLowerCase();
              if (!this._INFO_SCHEMA_VIEWS.includes(key)) {
                  throw new Error(`INFORMATION_SCHEMA.${name.toUpperCase()} is not available. Supported: ${this._INFO_SCHEMA_VIEWS.map(v => v.toUpperCase()).join(', ')}.`);
              }
              const tmp = `__tmp_is_${key}`;
              this._materializeRows(tmp, this._buildInfoSchemaRows(key));
              return tmp;
          });
      },

      _buildInfoSchemaRows(kind) {
          const rows = [];
          const SCHEMA = 'main';
          const userTables = Object.keys(this.tables).filter(t => !t.startsWith('__tmp_'));
          if (kind === 'schemata') {
              return [{ CATALOG_NAME: 'lumina', SCHEMA_NAME: SCHEMA, DEFAULT_CHARACTER_SET_NAME: 'utf8' }];
          }
          if (kind === 'tables') {
              userTables.forEach(tn => {
                  const t = this.tables[tn];
                  rows.push({
                      TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn,
                      TABLE_TYPE: this.matViews[tn] ? 'MATERIALIZED VIEW' : (t.isTemp ? 'LOCAL TEMPORARY' : 'BASE TABLE'),
                      TABLE_ROWS: t.rowCount, TABLE_COMMENT: this.comments['table:' + tn] || null
                  });
              });
              Object.keys(this.views).forEach(vn => rows.push({
                  TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: vn,
                  TABLE_TYPE: 'VIEW', TABLE_ROWS: null, TABLE_COMMENT: this.comments['table:' + vn] || null
              }));
              return rows;
          }
          if (kind === 'views') {
              Object.keys(this.views).forEach(vn => rows.push({
                  TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: vn,
                  VIEW_DEFINITION: this.views[vn],
                  IS_UPDATABLE: this._analyzeUpdatableView(vn).updatable ? 'YES' : 'NO',
                  CHECK_OPTION: (this.viewMeta && this.viewMeta[vn]) ? this.viewMeta[vn].checkOption : 'NONE'
              }));
              return rows;
          }
          if (kind === 'columns') {
              userTables.forEach(tn => {
                  const t = this.tables[tn];
                  let pos = 0;
                  for (const c in t.cols) {
                      pos++;
                      const isPk = t.primaryKey === c || (t.compositeKeys || []).includes(c);
                      rows.push({
                          TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn, COLUMN_NAME: c,
                          ORDINAL_POSITION: pos,
                          COLUMN_DEFAULT: this._defaultToText(t.defaults[c]),
                          COLLATION_NAME: (t.collations && t.collations[c]) || null,
                          IS_NULLABLE: (t.notNullCols.includes(c) || isPk) ? 'NO' : 'YES',
                          DATA_TYPE: (t.colTypes && t.colTypes[c]) ? t.colTypes[c] : 'TEXT',
                          COLUMN_KEY: isPk ? 'PRI' : (t.uniqueCols.includes(c) ? 'UNI' : (t.indices[c] ? 'MUL' : '')),
                          EXTRA: t.autoIncrementCol === c ? 'auto_increment' : ((t.generatedCols && t.generatedCols[c]) ? 'GENERATED' : ''),
                          COLUMN_COMMENT: this.comments[`column:${tn}.${c}`] || null
                      });
                  }
              });
              return rows;
          }
          if (kind === 'key_column_usage') {
              userTables.forEach(tn => {
                  const t = this.tables[tn];
                  const pks = t.compositeKeys && t.compositeKeys.length ? t.compositeKeys : (t.primaryKey ? [t.primaryKey] : []);
                  pks.forEach((c, i) => rows.push({
                      CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: 'PRIMARY', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn,
                      COLUMN_NAME: c, ORDINAL_POSITION: i + 1, REFERENCED_TABLE_NAME: null, REFERENCED_COLUMN_NAME: null
                  }));
                  (t.foreignKeys || []).forEach(fk => {
                      const fc = this._fkCols(fk), rc = this._fkRefCols(fk);
                      fc.forEach((c, j) => rows.push({
                          CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: fk.name || `fk_${tn}_${fc.join('_')}`, TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn,
                          COLUMN_NAME: c, ORDINAL_POSITION: j + 1, REFERENCED_TABLE_NAME: fk.refTable, REFERENCED_COLUMN_NAME: rc[j]
                      }));
                  });
              });
              return rows;
          }
          if (kind === 'table_constraints') {
              userTables.forEach(tn => {
                  const t = this.tables[tn];
                  if (t.primaryKey || (t.compositeKeys || []).length) {
                      rows.push({ CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: 'PRIMARY', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn, CONSTRAINT_TYPE: 'PRIMARY KEY' });
                  }
                  t.uniqueCols.forEach(c => rows.push({ CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: `uq_${tn}_${c}`, TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn, CONSTRAINT_TYPE: 'UNIQUE' }));
                  (t.foreignKeys || []).forEach(fk => rows.push({ CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: fk.name || `fk_${tn}_${this._fkCols(fk).join('_')}`, TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn, CONSTRAINT_TYPE: 'FOREIGN KEY' }));
                  (t.checks || []).forEach((ck, i) => rows.push({ CONSTRAINT_SCHEMA: SCHEMA, CONSTRAINT_NAME: ck.name || `chk_${tn}_${i + 1}`, TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn, CONSTRAINT_TYPE: 'CHECK' }));
              });
              return rows;
          }
          if (kind === 'routines') {
              Object.keys(this.procedures).forEach(p => rows.push({
                  ROUTINE_CATALOG: 'lumina', ROUTINE_SCHEMA: SCHEMA, ROUTINE_NAME: p,
                  ROUTINE_TYPE: 'PROCEDURE', DATA_TYPE: null, ROUTINE_DEFINITION: this.procedures[p].join('; ')
              }));
              Object.keys(this.functions).forEach(f => rows.push({
                  ROUTINE_CATALOG: 'lumina', ROUTINE_SCHEMA: SCHEMA, ROUTINE_NAME: f,
                  ROUTINE_TYPE: 'FUNCTION', DATA_TYPE: this.functions[f].returns, ROUTINE_DEFINITION: this.functions[f].body
              }));
              return rows;
          }
          // REFERENTIAL_CONSTRAINTS: FK ごとの参照アクション一覧（マイグレーション検証で使う）
          if (kind === 'referential_constraints') {
              userTables.forEach(tn => {
                  (this.tables[tn].foreignKeys || []).forEach(fk => rows.push({
                      CONSTRAINT_CATALOG: 'lumina', CONSTRAINT_SCHEMA: SCHEMA,
                      CONSTRAINT_NAME: fk.name || `fk_${tn}_${this._fkCols(fk).join('_')}`,
                      UNIQUE_CONSTRAINT_SCHEMA: SCHEMA, UNIQUE_CONSTRAINT_NAME: 'PRIMARY',
                      MATCH_OPTION: 'NONE',
                      UPDATE_RULE: fk.onUpdate || 'RESTRICT', DELETE_RULE: fk.onDelete || 'RESTRICT',
                      TABLE_NAME: tn, REFERENCED_TABLE_NAME: fk.refTable
                  }));
              });
              return rows;
          }
          // CHECK_CONSTRAINTS: CHECK 制約の式（SQL標準）
          if (kind === 'check_constraints') {
              userTables.forEach(tn => {
                  (this.tables[tn].checks || []).forEach((ck, i) => rows.push({
                      CONSTRAINT_CATALOG: 'lumina', CONSTRAINT_SCHEMA: SCHEMA,
                      CONSTRAINT_NAME: ck.name || `chk_${tn}_${i + 1}`,
                      TABLE_NAME: tn, CHECK_CLAUSE: ck.expr
                  }));
              });
              return rows;
          }
          // STATISTICS: 索引の一覧（MySQL 互換の列名）。SEQ_IN_INDEX はキー内の位置
          if (kind === 'statistics') {
              const named = this.indexNames || Object.create(null);
              userTables.forEach(tn => {
                  const t = this.tables[tn];
                  Object.keys(named).filter(k => named[k].table === tn).forEach(k => {
                      (named[k].keys || (named[k].cols || []).map(c => ({ col: c, dir: 'ASC' }))).forEach((key, i) => rows.push({
                          TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn,
                          NON_UNIQUE: named[k].unique ? 0 : 1, INDEX_NAME: k,
                          SEQ_IN_INDEX: i + 1, COLUMN_NAME: key.col || null, EXPRESSION: key.expr || null,
                          COLLATION: key.dir === 'DESC' ? 'D' : 'A', INDEX_TYPE: 'HASH',
                          CARDINALITY: key.col && t.indices[key.col] ? t.indices[key.col].size : null
                      }));
                  });
                  // PRIMARY KEY / UNIQUE 由来の暗黙索引（名前付き索引に含まれないもの）
                  const covered = new Set();
                  Object.keys(named).filter(k => named[k].table === tn)
                      .forEach(k => (named[k].cols || []).forEach(c => covered.add(c)));
                  const implicit = [...(t.primaryKey ? [t.primaryKey] : []), ...(t.uniqueCols || [])];
                  [...new Set(implicit)].filter(c => !covered.has(c) && t.indices[c]).forEach(c => rows.push({
                      TABLE_CATALOG: 'lumina', TABLE_SCHEMA: SCHEMA, TABLE_NAME: tn,
                      NON_UNIQUE: 0, INDEX_NAME: t.primaryKey === c ? 'PRIMARY' : `uq_${tn}_${c}`,
                      SEQ_IN_INDEX: 1, COLUMN_NAME: c, EXPRESSION: null,
                      COLLATION: 'A', INDEX_TYPE: 'HASH', CARDINALITY: t.indices[c].size
                  }));
              });
              return rows;
          }
          // TRIGGERS: トリガー定義の一覧（SQL標準）
          if (kind === 'triggers') {
              Object.keys(this.triggers || {}).forEach(tg => {
                  const d = this.triggers[tg];
                  rows.push({
                      TRIGGER_CATALOG: 'lumina', TRIGGER_SCHEMA: SCHEMA, TRIGGER_NAME: tg,
                      EVENT_MANIPULATION: String(d.event || '').toUpperCase(),
                      EVENT_OBJECT_SCHEMA: SCHEMA, EVENT_OBJECT_TABLE: d.table,
                      ACTION_TIMING: String(d.timing || '').toUpperCase(),
                      ACTION_ORIENTATION: 'ROW',
                      ACTION_STATEMENT: Array.isArray(d.statements) ? d.statements.join('; ') : String(d.statements || '')
                  });
              });
              return rows;
          }
          // PARAMETERS: ストアドプロシージャ / UDF の仮引数一覧
          if (kind === 'parameters') {
              Object.keys(this.procParams || {}).forEach(p => {
                  (this.procParams[p] || []).forEach((prm, i) => rows.push({
                      SPECIFIC_CATALOG: 'lumina', SPECIFIC_SCHEMA: SCHEMA, SPECIFIC_NAME: p,
                      ORDINAL_POSITION: i + 1, PARAMETER_MODE: 'IN',
                      PARAMETER_NAME: typeof prm === 'string' ? prm : (prm && prm.name) || null,
                      DATA_TYPE: (prm && prm.type) || null, ROUTINE_TYPE: 'PROCEDURE'
                  }));
              });
              Object.keys(this.functions).forEach(f => {
                  (this.functions[f].params || []).forEach((prm, i) => rows.push({
                      SPECIFIC_CATALOG: 'lumina', SPECIFIC_SCHEMA: SCHEMA, SPECIFIC_NAME: f,
                      ORDINAL_POSITION: i + 1, PARAMETER_MODE: 'IN',
                      PARAMETER_NAME: typeof prm === 'string' ? prm : (prm && prm.name) || null,
                      DATA_TYPE: (prm && prm.type) || null, ROUTINE_TYPE: 'FUNCTION'
                  }));
              });
              return rows;
          }
          // sequences
          Object.keys(this.sequences).forEach(s => {
              const q = this.sequences[s];
              rows.push({ SEQUENCE_CATALOG: 'lumina', SEQUENCE_SCHEMA: SCHEMA, SEQUENCE_NAME: s,
                          START_VALUE: q.start, INCREMENT: q.increment, LAST_VALUE: q.value,
                          MINIMUM_VALUE: q.minValue === undefined ? null : q.minValue,
                          MAXIMUM_VALUE: q.maxValue === undefined ? null : q.maxValue,
                          CYCLE_OPTION: q.cycle ? 'YES' : 'NO' });
          });
          return rows;
      },

      // SELECT ... INTO <newtable> FROM ... : 結果セットから新テーブルを作成する
      _executeSelectInto(newName, selectSql, strMap) {
          if (this.tables[newName]) throw new Error(`Table '${newName}' already exists.`);
          if (this.views[newName]) throw new Error(`View '${newName}' already exists.`);
          const res = this.executeQuery(selectSql, true, strMap);
          if (res.error) throw new Error(res.error);
          this._logCreateTable(newName);
          // 0 行でも列名は伝える（列の無い表ができるのを防ぐ）
          this._materializeRows(newName, res.data,
              (!res.data || res.data.length === 0) ? (res.columns || null) : null);
          return { data: [{ Result: "Success", Message: `Table '${newName}' created with ${res.data.length} rows.` }], affectedRows: res.data.length };
      },

      // REFRESH MATERIALIZED VIEW <name>: 定義クエリを再実行して実体テーブルを差し替える
      _refreshMatView(sql, strMap) {
          // CONCURRENTLY / WITH [NO] DATA は受理する（単一スレッドなので同時実行の
          // 区別は無く、WITH NO DATA は「中身を空にする」指定として効かせる）
          const m = sql.match(/^refresh\s+materialized\s+view\s+(?:concurrently\s+)?([a-zA-Z0-9_]+)(?:\s+with\s+(no\s+)?data)?\s*$/i);
          if (!m) throw new Error("Syntax Error. Use REFRESH MATERIALIZED VIEW [CONCURRENTLY] <name> [WITH [NO] DATA].");
          const name = m[1].toLowerCase();
          const mv = this.matViews[name];
          if (!mv) throw new Error(`Materialized view '${name}' not found.`);
          const res = this.executeQuery(mv.sql, true, strMap);
          if (res.error) throw new Error(res.error);
          const rows = m[2] ? [] : res.data;   // WITH NO DATA: 列だけ残して空にする
          this._logTableMeta(name);
          this._materializeRows(name, rows);
          return { data: [{ Result: "Success", Message: `Materialized view '${name}' refreshed (${rows.length} rows).` }], affectedRows: rows.length };
      },

      _executeDDL(sql, strMap) {
          let resultSet = [];
          let affectedRows = 0;
          // --- 実DBの綴りを受けるための前処理（意味を変えない語を落とす） ---
          // UNLOGGED / LOGGED: WAL を書くかの指定。全てメモリ上の本実装では区別が無い
          sql = sql.replace(/^(create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+)?)(?:un)?logged\s+(table\b)/i, '$1$2');
          // CREATE INDEX ... USING BTREE|HASH ...: 索引の実装方式の指定。
          // LuminaDB の索引は列単位ハッシュの 1 種類だけなので受理して落とす
          // （PostgreSQL は表名の後、MySQL は列リストの後に置く。両方の位置を受ける）
          if (/^create\s+(?:unique\s+)?index\b/i.test(sql)) {
              sql = sql.replace(/(\bon\s+[a-zA-Z0-9_]+)\s+using\s+(?:btree|hash|gin|gist|brin|spgist|rtree|fulltext)\b/i, '$1');
              sql = sql.replace(/\s+using\s+(?:btree|hash|gin|gist|brin|spgist|rtree|fulltext)\s*$/i, '');
          }
          // ALTER VIEW v AS SELECT ...: 既存ビューの再定義（CREATE OR REPLACE VIEW と同じ）。
          // 存在しない名前は「作られたつもり」にならないよう拒否する
          if (/^alter\s+view\b/i.test(sql)) {
              const am = sql.match(/^alter\s+view\s+([a-zA-Z0-9_]+)\s*(?:\([\s\S]*?\)\s*)?as\s+[\s\S]+$/i);
              if (!am) throw new Error("Syntax Error. Use ALTER VIEW <name> [(c1, ...)] AS SELECT ....");
              const vn = am[1].toLowerCase();
              if (!this.views[vn]) {
                  if (this.matViews[vn]) throw new Error(`'${vn}' is a materialized view. Drop and recreate it to change its definition.`);
                  throw new Error(`View '${vn}' not found. Use CREATE VIEW to create it.`);
              }
              sql = 'CREATE OR REPLACE VIEW ' + sql.replace(/^alter\s+view\s+/i, '');
          }
          // CREATE FULLTEXT INDEX <name> ON <table>(<col>[, ...])
          //
          // 従来は構文エラーだった。MATCH ... AGAINST は索引を持たず毎回全行を
          // 語へ切って走査していたので、全文検索が表の大きさに正比例していた。
          // ここで登録した列に対して Table.ftPostings が語 -> 行の対応を作る
          if (/^create\s+fulltext\s+index\b/i.test(sql)) {
             const m = sql.match(/^create\s+fulltext\s+index\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+on\s+([a-zA-Z0-9_]+)\s*\(([^()]+)\)\s*$/i);
             if (!m) throw new Error("Syntax Error in CREATE FULLTEXT INDEX. Use CREATE FULLTEXT INDEX [IF NOT EXISTS] name ON table (col[, col...]).");
             const ifNotExists = !!m[1];
             const idxName = m[2].toLowerCase();
             const table = m[3].toLowerCase();
             const t = this.tables[table];
             if (!t) throw this._tableNotFound(table);
             const cols = m[4].split(',').map(c => c.trim().toLowerCase()).filter(c => c !== '');
             if (cols.length === 0) throw new Error("Syntax Error in CREATE FULLTEXT INDEX: no columns given.");
             cols.forEach(c => {
                 if (!t.cols[c]) throw new Error(`Column '${c}' not found in table '${table}'.`);
             });
             this.indexNames = this.indexNames || Object.create(null);
             if (t.ftIndexes[idxName] || this.indexNames[idxName]) {
                 if (ifNotExists) return { data: [{ Result: "Success", Message: `Index '${idxName}' already exists. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Index '${idxName}' already exists.`);
             }
             t.ftIndexes[idxName] = { cols };
             t.version++;                       // 転置索引の作り直しを促す
             this.indexNames[idxName] = { table, cols, keys: cols.map(c => ({ col: c })), unique: false, where: null, include: null, fulltext: true };
             resultSet = [{ Result: "Success", Message: `Fulltext index '${idxName}' created on ${table}(${cols.join(', ')}).` }];
          }
          else if (/^create\s+(unique\s+)?index/i.test(sql)) {
             // 複数列指定に対応する。LuminaDB のインデックスは単一列ハッシュなので、
             // 複合指定は各列に個別のインデックスを張る（先頭列で絞れれば十分効く）
             // 末尾の WHERE 句は部分インデックス（PostgreSQL / SQLite）。
             // LuminaDB のインデックスは列単位ハッシュなので、条件は「この索引が使える行の
             // 絞り込み条件」として記録し、一致するクエリでのみ利用する
             let partialWhere = null;
             {
                 const pw = sql.match(/\s+where\s+([\s\S]+)$/i);
                 if (pw && /^create\s+(unique\s+)?index/i.test(sql)) {
                     partialWhere = pw[1].trim();
                     sql = sql.slice(0, pw.index);
                 }
             }
             // INCLUDE (col, ...): 被覆索引の付加列（PostgreSQL / SQL Server）。
             // LuminaDB の索引は列単位ハッシュで、結果は必ず実表から読むため付加列は不要。
             // 列名だけ検証して記録し、警告で「効果は無い」ことを伝える
             let includeCols = null;
             {
                 const inc = sql.match(/\s+include\s*\(\s*([a-zA-Z0-9_\s,]+?)\s*\)\s*$/i);
                 if (inc) {
                     includeCols = inc[1].split(',').map(x => x.trim().toLowerCase()).filter(x => x !== '');
                     sql = sql.slice(0, inc.index);
                 }
             }
             // CONCURRENTLY は「他の書き込みを止めずに張る」指定。単一スレッドの本実装では
             // 常に即時完了なので受理して無視する（移行スクリプトをそのまま通すため）
             const concurrently = /\bcreate\s+(?:unique\s+)?index\s+concurrently\b/i.test(sql);
             if (concurrently) sql = sql.replace(/(\bindex)\s+concurrently\b/i, '$1');
             // 列リストは `col [ASC|DESC] [NULLS FIRST|LAST]` と関数式 `LOWER(nm)` を受ける
             const m = sql.match(/create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+on\s+([a-zA-Z0-9_]+)\s*\(\s*([\s\S]+?)\s*\)\s*$/i);
             if (m) {
                const idxName = m[3].toLowerCase();
                const table = m[4].toLowerCase();
                const t = this.tables[table];
                if (!t) throw this._tableNotFound(table);
                // 索引キーを解析する。並び順（ASC/DESC/NULLS）はハッシュ索引には影響しないため
                // メタデータとして記録するだけ。式キーは対応する列が無いのでハッシュを張らない
                const keys = this.splitSelectClause(m[5]).map(raw => {
                    const item = raw.trim();
                    if (item === '') throw new Error("Syntax Error in CREATE INDEX: empty index key.");
                    const km = item.match(/^([a-zA-Z0-9_]+)(?:\s+(asc|desc))?(?:\s+nulls\s+(first|last))?$/i);
                    if (km) {
                        const col = km[1].toLowerCase();
                        if (!t.cols[col]) throw new Error(`Column '${col}' not found in table '${table}'.`);
                        return { col, dir: (km[2] || 'ASC').toUpperCase(), nulls: km[3] ? km[3].toUpperCase() : null };
                    }
                    // 式インデックス: 構文と列名を検証する（実データ1行で評価して誤りを弾く）。
                    // 列単位ハッシュでは加速できないので式テキストの記録に留める
                    const dm = item.match(/^([\s\S]+?)(?:\s+(asc|desc))?(?:\s+nulls\s+(first|last))?$/i);
                    const exprText = dm[1].trim();
                    const ef = this.compileCondition(exprText, strMap);
                    if (t.rowCount > 0) ef({ [table]: 0 }, this.tables, { [table]: table });
                    return { expr: this._restoreStrings(exprText, strMap), dir: (dm[2] || 'ASC').toUpperCase(), nulls: dm[3] ? dm[3].toUpperCase() : null };
                });
                const cols = keys.filter(k => k.col).map(k => k.col);
                const exprKeys = keys.filter(k => k.expr);
                if (m[2] && cols.length > 0 && exprKeys.length === 0 && cols.every(c => t.indices[c])) {
                    return { data: [{ Result: "Success", Message: `Index on ${table}(${cols.join(', ')}) already exists. Skipped.` }], affectedRows: 0 };
                }
                this._logTableMeta(table);
                // UNIQUE INDEX は一意制約としても登録する（既存の重複は検出してエラー）。
                // **複数列の UNIQUE INDEX は「組（タプル）が一意」** であって
                // 「各列がそれぞれ一意」ではない。従来は列ごとに uniqueCols へ入れていたため、
                // (1,2) の後に (1,3) を入れられない＝正しい行が拒否される誤りだった
                if (m[1] && cols.length > 1 && exprKeys.length === 0) {
                    const seen = new Set();
                    for (let r = 0; r < t.rowCount; r++) {
                        const vals = cols.map(c => t.getValue(c, r));
                        if (vals.some(v => v === null || v === undefined)) continue;   // NULL を含む組は検査しない
                        const k = vals.map(v => String(v)).join('\0');
                        if (seen.has(k)) throw new Error(`Cannot create UNIQUE index '${idxName}': duplicate key (${vals.join(', ')}) in ${table}(${cols.join(', ')}).`);
                        seen.add(k);
                    }
                    const already = (t.compositeKeys || []).some(ck => !ck.isPK && ck.cols.length === cols.length && ck.cols.every((c, i) => c === cols[i]));
                    if (!already) t.compositeKeys.push({ cols: cols.slice(), isPK: false });
                } else if (m[1]) {
                    cols.forEach(c => {
                        const seen = new Set();
                        for (let r = 0; r < t.rowCount; r++) {
                            const v = t.getValue(c, r);
                            if (v === null || v === undefined) continue;
                            const k = String(v);
                            if (seen.has(k)) throw new Error(`Cannot create UNIQUE index '${idxName}': duplicate value '${v}' in column '${c}'.`);
                            seen.add(k);
                        }
                        if (!t.uniqueCols.includes(c)) t.uniqueCols.push(c);
                    });
                }
                // 部分インデックスの WHERE は構文として受理し、述語を記録する。
                // 実体は全行インデックス — 条件を満たす行だけを持つ真の部分インデックスの
                // 上位互換（同じクエリに常に正しく使える。差はメモリ使用量だけ）なので、
                // 挿入・更新時の索引保守を複雑にせずに済む
                if (partialWhere) {
                    // 構文だけでなく列名も検証する（未知の列は行評価まで気づけないため、
                    // 実データが 1 行でもあればそこで評価して確かめる）
                    const pf = this.compileCondition(partialWhere, strMap);
                    if (t.rowCount > 0) pf({ [table]: 0 }, this.tables, { [table]: table });
                }
                cols.forEach(c => t.createIndex(c));
                const whereText = partialWhere ? this._restoreStrings(partialWhere, strMap) : null;
                this.indexNames = this.indexNames || Object.create(null);
                const keyText = keys.map(k => `${k.col || k.expr}${k.dir === 'DESC' ? ' DESC' : ''}${k.nulls ? ' NULLS ' + k.nulls : ''}`).join(', ');
                if (includeCols) {
                    includeCols.forEach(c => {
                        if (!t.cols[c]) throw new Error(`Column '${c}' not found in table '${table}' (INCLUDE list).`);
                    });
                    this._warn('INDEX_INCLUDE', `INCLUDE columns on '${idxName}' are recorded only: LuminaDB always reads matched rows from the table, so a covering index has no effect.`);
                }
                if (concurrently) {
                    this._warn('INDEX_CONCURRENTLY', `CONCURRENTLY on '${idxName}' is accepted and ignored: index creation is always immediate in LuminaDB.`);
                }
                this.indexNames[idxName] = { table, cols, keys, unique: !!m[1], where: whereText, include: includeCols };
                const notes = [];
                if (whereText) notes.push(`partial predicate '${whereText}' recorded; a full index is built`);
                if (exprKeys.length > 0) notes.push('expression keys are recorded as metadata only (hash indexes are per column)');
                if (includeCols) notes.push(`INCLUDE (${includeCols.join(', ')}) recorded`);
                resultSet = [{ Result: "Success", Message: `Index '${idxName}' created on ${table}(${keyText})${notes.length ? ` (${notes.join('; ')})` : ''}.` }];
             } else throw new Error("Syntax Error in CREATE INDEX. Use CREATE [UNIQUE] INDEX [IF NOT EXISTS] [CONCURRENTLY] name ON table (key[, key...]) [INCLUDE (col, ...)] [WHERE pred], where key is col [ASC|DESC] [NULLS FIRST|LAST] or an expression.");
          }
          else if (/^create\s+(?:or\s+replace\s+)?function\b/i.test(sql)) {
             // ユーザー定義スカラー関数。本体は単一の式（RETURN <expr>）に限定する。
             // 呼び出し時に式へインライン展開されるため実行コストは組み込み関数と同等。
             const m = sql.match(/^create\s+(or\s+replace\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:returns\s+([a-zA-Z][a-zA-Z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)\s*)?(?:as\s+)?(?:begin\s+)?return\s+([\s\S]+?)\s*(?:;\s*end)?\s*$/i);
             if (!m) throw new Error("Syntax Error in CREATE FUNCTION. Use CREATE [OR REPLACE] FUNCTION name(p1 [type], ...) RETURNS type AS RETURN <expression>.");
             const name = m[2].toLowerCase();
             if (!m[1] && this.functions[name]) throw new Error(`Function '${name}' already exists. Use CREATE OR REPLACE FUNCTION.`);
             // 組み込み関数の上書きは禁止（式コンパイラの写像と衝突するため）
             if (this._isBuiltinFunctionName(name)) throw new Error(`'${name.toUpperCase()}' is a built-in function and cannot be redefined.`);
             const params = (m[3] || '').trim() === '' ? [] : this.splitSelectClause(m[3]).map(p => {
                 const pm = p.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+[a-zA-Z][a-zA-Z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)?$/);
                 if (!pm) throw new Error(`Invalid parameter declaration '${p.trim()}' in CREATE FUNCTION.`);
                 return pm[1].toLowerCase();
             });
             if (new Set(params).size !== params.length) throw new Error("Duplicate parameter name in CREATE FUNCTION.");
             const body = this._restoreStrings(m[5].trim().replace(/;$/, ''), strMap);
             if (body === '') throw new Error("Function body is empty.");
             this._logFunctionState(name);
             this.functions[name] = { params, body, returns: m[4] ? m[4].toUpperCase() : 'TEXT' };
             // 定義時に式としてコンパイルできるか検証する（引数はダミーの 0 で置換）
             try {
                 this.compileCondition(params.reduce((b, p) => b.replace(new RegExp('\\b' + p + '\\b', 'gi'), '0'), body), []);
             } catch (e) {
                 delete this.functions[name];
                 throw new Error(`Invalid function body: ${e.message}`);
             }
             resultSet = [{ Result: "Success", Message: `Function '${name}' created (${params.length} parameter(s)).` }];
          }
          else if (/^drop\s+function\b/i.test(sql)) {
             const m = sql.match(/^drop\s+function\s+(if\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\s*\))?\s*$/i);
             if (!m) throw new Error("Syntax Error in DROP FUNCTION. Use DROP FUNCTION [IF EXISTS] name.");
             const name = m[2].toLowerCase();
             if (!this.functions[name]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Function '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Function '${name}' not found.`);
             }
             this._logFunctionState(name);
             delete this.functions[name];
             resultSet = [{ Result: "Success", Message: `Function '${name}' dropped.` }];
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
          else if (/^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?view/i.test(sql)) {
             // CREATE [OR REPLACE] [TEMPORARY] VIEW name [(c1, c2, ...)] AS SELECT ...
             // 列リストを付けると本体の出力列を位置で改名する（SQL標準）
             // TEMPORARY はセッション限り（IDB保存・SQLエクスポート対象外）
             const m = sql.match(/^create\s+(or\s+replace\s+)?(temp(?:orary)?\s+)?view\s+([a-zA-Z0-9_]+)\s*(?:\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\)\s*)?as\s+([\s\S]+)$/i);
             if (m) {
                const orReplace = !!m[1];
                const isTempView = !!m[2];
                const name = m[3].toLowerCase();
                const colList = m[4] ? m[4].split(',').map(c => c.trim().toLowerCase()) : null;
                if (this.tables[name]) throw new Error(`Table '${name}' already exists.`);
                if (this.views[name] && !orReplace) throw new Error(`View '${name}' already exists.`);
                let body = m[5].trim().replace(/;$/, '');
                // WITH [LOCAL|CASCADED] CHECK OPTION: このビュー経由の書き込みが
                // ビューの WHERE を満たすことを強制する（更新可能ビューのガード）
                let checkOption = null;
                const coM = body.match(/\s+with\s+(local\s+|cascaded\s+)?check\s+option\s*$/i);
                if (coM) {
                    checkOption = coM[1] ? coM[1].trim().toUpperCase() : 'CASCADED';
                    body = body.slice(0, coM.index).trim();
                }
                if (!/^select\b/i.test(body)) throw new Error("VIEW definition must be a SELECT statement.");
                if (new RegExp(`\\b(from|join)\\s+${name}\\b`, 'i').test(body)) throw new Error("View cannot reference itself.");
                if (colList) body = this._applyViewColumnList(body, colList, strMap);
                const replaced = orReplace && this.views[name];
                this._logViewState(name);
                this.views[name] = this._restoreStrings(body, strMap);
                this.viewMeta = this.viewMeta || Object.create(null);
                if (checkOption || isTempView) {
                    this.viewMeta[name] = {};
                    if (checkOption) this.viewMeta[name].checkOption = checkOption;
                    if (isTempView) this.viewMeta[name].temp = true;
                } else delete this.viewMeta[name];
                resultSet = [{ Result: "Success", Message: `${isTempView ? 'Temporary view' : 'View'} '${name}' ${replaced ? 'replaced' : 'created'}${checkOption ? ' WITH CHECK OPTION' : ''}${isTempView ? ' (session only: not saved and not exported)' : ''}.` }];
             } else throw new Error("Syntax Error in CREATE VIEW.");
          }
          else if (/^create\s+(?:or\s+replace\s+)?procedure/i.test(sql)) {
             // CREATE [OR REPLACE] PROCEDURE name [(p1 [type], ...)] [AS] BEGIN ... END
             const m = sql.match(/^create\s+(or\s+replace\s+)?procedure\s+([a-zA-Z0-9_]+)\s*(?:\(([\s\S]*?)\))?\s*(?:as\s+)?([\s\S]+)$/i);
             if (m) {
                const orReplace = !!m[1];
                const name = m[2].toLowerCase();
                if (this.procedures[name] && !orReplace) throw new Error(`Procedure '${name}' already exists.`);
                const replaced = orReplace && !!this.procedures[name];
                const params = (m[3] || '').trim() === '' ? [] : this.splitSelectClause(m[3]).map(p => {
                    // IN/OUT/INOUT の修飾と型は受理して名前だけ使う（値渡しのみ対応）
                    const pm = p.trim().match(/^(?:(?:in|out|inout)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+[a-zA-Z][a-zA-Z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)?$/i);
                    if (!pm) throw new Error(`Invalid parameter declaration '${p.trim()}' in CREATE PROCEDURE.`);
                    return pm[1].toLowerCase();
                });
                if (new Set(params).size !== params.length) throw new Error("Duplicate parameter name in CREATE PROCEDURE.");
                let body = this._restoreStrings(m[4].trim(), strMap);
                // 'AS' だけで本体が続かない場合（AS を任意にしたぶん明示的に弾く）
                if (/^as$/i.test(body)) throw new Error("Procedure body is empty.");
                const beMatch = body.match(/^begin\s+([\s\S]+?)\s*end\s*;?$/i);
                if (beMatch) body = beMatch[1];
                // IF / WHILE / LOOP / REPEAT / BEGIN / CASE のブロックを保ったまま文へ分割する
                const statements = this._splitProcBody(body);
                if (statements.length === 0) throw new Error("Procedure body is empty.");
                // 制御構造の構文誤りは CALL 時ではなく定義時に知らせる
                this._validateProcBody(statements);
                this._logProcState(name);
                this.procedures[name] = statements;
                this.procParams = this.procParams || Object.create(null);
                this.procParams[name] = params;
                resultSet = [{ Result: "Success", Message: `Procedure '${name}' ${replaced ? 'replaced' : 'created'} (${statements.length} statements).` }];
             } else throw new Error("Syntax Error in CREATE PROCEDURE.");
          }
          else if (/^create\s+(?:or\s+replace\s+)?trigger/i.test(sql)) {
             // 行トリガー: CREATE TRIGGER name {BEFORE|AFTER} {INSERT|UPDATE|DELETE} ON table
             //            FOR EACH ROW <文>[; <文> ...]（BEGIN ... END で括っても良い）
             // 本文では NEW.col / OLD.col が発火行の値リテラルへ置換される
             // INSTEAD OF はビュー専用（更新不可なビューを書き込み可能にする常用手段）
             const m = sql.match(/^create\s+(or\s+replace\s+)?trigger\s+([a-zA-Z0-9_]+)\s+(before|after|instead\s+of)\s+(insert|update|delete)\s+on\s+([a-zA-Z0-9_]+)\s+for\s+each\s+row\s+([\s\S]+)$/i);
             if (!m) throw new Error("Syntax Error in CREATE TRIGGER. Use CREATE TRIGGER name {BEFORE|AFTER|INSTEAD OF} {INSERT|UPDATE|DELETE} ON {table|view} FOR EACH ROW <statement>[; ...].");
             const orReplace = !!m[1];
             const name = m[2].toLowerCase();
             const timing = m[3].toLowerCase().replace(/\s+/g, ' ');
             const event = m[4].toLowerCase();
             const table = m[5].toLowerCase();
             if (timing === 'instead of') {
                 if (!this.views[table]) throw new Error(`INSTEAD OF triggers can only be created on views ('${table}' is not a view).`);
             } else if (!this.tables[table]) {
                 if (this.views[table]) throw new Error(`'${table}' is a view; use CREATE TRIGGER ... INSTEAD OF ... ON ${table}.`);
                 throw new Error(`Table '${table}' not found.`);
             }
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
          else if (/^create\s+domain\b/i.test(sql)) {
             // CREATE DOMAIN name [AS] <型> [DEFAULT v] [NOT NULL] [CHECK (VALUE ...)]
             // 列の型として使うと基底型へ展開し、CHECK は VALUE を列名に置き換えて
             // 列レベル CHECK として付ける（PostgreSQL のドメインと同じ運用感）
             const m = sql.match(/^create\s+domain\s+([a-zA-Z0-9_]+)\s+(?:as\s+)?([\s\S]+)$/i);
             if (!m) throw new Error("Syntax Error in CREATE DOMAIN. Use CREATE DOMAIN name AS <type> [DEFAULT v] [NOT NULL] [CHECK (VALUE ...)].");
             const name = m[1].toLowerCase();
             if (this.domains[name]) throw new Error(`Domain or type '${name}' already exists.`);
             let rest = m[2].trim();
             let check = null;
             const ck = this._extractCheck(rest);
             if (ck) { check = this._restoreStrings(ck.expr, strMap); rest = ck.rest; }
             let notNull = false;
             if (/\bnot\s+null\b/i.test(rest)) { notNull = true; rest = rest.replace(/\bnot\s+null\b/i, ' '); }
             let defaultText = null;
             const dt = this._takeDefaultToken(rest);
             if (dt) { defaultText = this._restoreStrings(dt.raw, strMap); rest = rest.slice(0, dt.start) + ' ' + rest.slice(dt.end); }
             const base = rest.trim().split(/\s+/)[0];
             if (!base) throw new Error("CREATE DOMAIN requires a base type.");
             if (check && !/\bVALUE\b/i.test(check)) throw new Error("A domain CHECK must reference VALUE.");
             this._logDomainState(name);
             this.domains[name] = { name, kind: 'domain', base: base.toUpperCase(), check, notNull, defaultText, values: null };
             resultSet = [{ Result: "Success", Message: `Domain '${name}' created (${base.toUpperCase()}).` }];
          }
          else if (/^create\s+type\b/i.test(sql)) {
             // CREATE TYPE name AS ENUM ('a', 'b', ...): 値集合を CHECK として強制する
             const m = sql.match(/^create\s+type\s+([a-zA-Z0-9_]+)\s+as\s+enum\s*\(([\s\S]*)\)$/i);
             if (!m) throw new Error("Syntax Error in CREATE TYPE. Use CREATE TYPE name AS ENUM ('a', 'b', ...).");
             const name = m[1].toLowerCase();
             if (this.domains[name]) throw new Error(`Domain or type '${name}' already exists.`);
             const rawValues = this.splitSelectClause(m[2]).map(v => v.trim()).filter(v => v !== '');
             if (rawValues.length === 0) throw new Error("CREATE TYPE ... AS ENUM requires at least one value.");
             const values = rawValues.map(t => {
                 const sm2 = t.match(/^__STR_(\d+)__$/);
                 if (!sm2) throw new Error("ENUM values must be string literals.");
                 return this._unquoteLiteral(strMap[Number(sm2[1])]);
             });
             this._logDomainState(name);
             this.domains[name] = { name, kind: 'enum', base: 'TEXT', check: null, notNull: false, defaultText: null, values };
             resultSet = [{ Result: "Success", Message: `Type '${name}' created (ENUM with ${values.length} values).` }];
          }
          else if (/^drop\s+(domain|type)\b/i.test(sql)) {
             const m = sql.match(/^drop\s+(domain|type)\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)$/i);
             if (!m) throw new Error("Syntax Error in DROP DOMAIN/TYPE.");
             const name = m[3].toLowerCase();
             if (!this.domains[name]) {
                 if (m[2]) return { data: [{ Result: "Success", Message: `${m[1].toUpperCase()} '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`${m[1].toUpperCase()} '${name}' not found.`);
             }
             this._logDomainState(name);
             delete this.domains[name];
             resultSet = [{ Result: "Success", Message: `${m[1].toUpperCase()} '${name}' dropped.` }];
          }
          else if (/^create\s+(user|role)\b/i.test(sql)) {
             // LuminaDB に認証機構は無い。移行スクリプトをそのまま流せるよう名簿だけ持つ
             const m = sql.match(/^create\s+(user|role)\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)([\s\S]*)$/i);
             if (!m) throw new Error("Syntax Error in CREATE USER/ROLE.");
             const kind = m[1].toLowerCase(), name = m[3].toLowerCase();
             if (this.roles[name]) {
                 if (m[2]) return { data: [{ Result: "Success", Message: `${kind} '${name}' already exists. Skipped.` }], affectedRows: 0 };
                 throw new Error(`${kind === 'user' ? 'User' : 'Role'} '${name}' already exists.`);
             }
             this.roles[name] = { name, kind };
             resultSet = [{ Result: "Success", Message: `${kind === 'user' ? 'User' : 'Role'} '${name}' created (accepted for script compatibility; LuminaDB does not enforce privileges).` }];
          }
          else if (/^drop\s+(user|role)\b/i.test(sql)) {
             const m = sql.match(/^drop\s+(user|role)\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)$/i);
             if (!m) throw new Error("Syntax Error in DROP USER/ROLE.");
             const kind = m[1].toLowerCase();
             const label = kind === 'user' ? 'User' : 'Role';
             const name = m[3].toLowerCase();
             if (!this.roles[name]) {
                 if (m[2]) return { data: [{ Result: "Success", Message: `${label} '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`${label} '${name}' not found.`);
             }
             delete this.roles[name];
             resultSet = [{ Result: "Success", Message: `${label} '${name}' dropped.` }];
          }
          else if (/^create\s+sequence/i.test(sql)) {
             // CREATE SEQUENCE [IF NOT EXISTS] name [START WITH n] [INCREMENT BY n]
             //   [MINVALUE n | NO MINVALUE] [MAXVALUE n | NO MAXVALUE] [CYCLE | NO CYCLE] [CACHE n]
             const m = sql.match(/^create\s+sequence\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)([\s\S]*)$/i);
             if (!m) throw new Error("Syntax Error in CREATE SEQUENCE. Use CREATE SEQUENCE [IF NOT EXISTS] name [START WITH n] [INCREMENT BY n] [MINVALUE n] [MAXVALUE n] [CYCLE] [CACHE n].");
             const name = m[2].toLowerCase();
             const opts = this._parseSeqOptions(m[3]);
             if (opts.__leftover) throw new Error(`Syntax Error in CREATE SEQUENCE near '${opts.__leftover}'. Supported: START WITH / INCREMENT BY / MINVALUE / MAXVALUE / CYCLE / NO CYCLE / CACHE.`);
             if (this.sequences[name]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Sequence '${name}' already exists. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Sequence '${name}' already exists.`);
             }
             const increment = opts.increment !== undefined ? opts.increment : 1;
             if (increment === 0) throw new Error("INCREMENT BY must not be 0.");
             // START 未指定時は昇順なら MINVALUE（既定 1）、降順なら MAXVALUE から始める
             const minValue = opts.minValue !== undefined ? opts.minValue : null;
             const maxValue = opts.maxValue !== undefined ? opts.maxValue : null;
             let start = opts.start;
             if (start === undefined) start = increment > 0 ? (minValue !== null ? minValue : 1) : (maxValue !== null ? maxValue : -1);
             if (minValue !== null && maxValue !== null && minValue > maxValue) throw new Error("MINVALUE must not exceed MAXVALUE.");
             if ((minValue !== null && start < minValue) || (maxValue !== null && start > maxValue)) {
                 throw new Error(`START WITH ${start} is outside the sequence range.`);
             }
             this._logSeqState(name);
             this.sequences[name] = { start, increment, value: null, minValue, maxValue, cycle: !!opts.cycle, cache: opts.cache || 1 };
             const extra = [minValue !== null ? `MINVALUE ${minValue}` : '', maxValue !== null ? `MAXVALUE ${maxValue}` : '', opts.cycle ? 'CYCLE' : ''].filter(Boolean);
             resultSet = [{ Result: "Success", Message: `Sequence '${name}' created (START WITH ${start}, INCREMENT BY ${increment}${extra.length ? ', ' + extra.join(', ') : ''}).` }];
          }
          else if (/^alter\s+sequence/i.test(sql)) {
             // ALTER SEQUENCE name [RESTART [WITH n]] [その他のオプション]
             const m = sql.match(/^alter\s+sequence\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)([\s\S]*)$/i);
             if (!m) throw new Error("Syntax Error in ALTER SEQUENCE. Use ALTER SEQUENCE name [RESTART [WITH n]] [INCREMENT BY n] [MINVALUE n] [MAXVALUE n] [CYCLE].");
             const name = m[2].toLowerCase();
             const s = this.sequences[name];
             if (!s) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Sequence '${name}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Sequence '${name}' not found.`);
             }
             let tail = m[3] || '';
             // RESTART [WITH n]: 次の NEXTVAL が n（省略時は START）を返すよう value を未採番へ戻す
             let restartTo;
             const rm = tail.match(/\srestart(?:\s+with\s+(-?\d+))?\b/i);
             if (rm) { restartTo = rm[1] !== undefined ? parseInt(rm[1], 10) : null; tail = tail.slice(0, rm.index) + ' ' + tail.slice(rm.index + rm[0].length); }
             const opts = this._parseSeqOptions(tail);
             if (opts.__leftover) throw new Error(`Syntax Error in ALTER SEQUENCE near '${opts.__leftover}'.`);
             if (opts.increment === 0) throw new Error("INCREMENT BY must not be 0.");
             this._logSeqState(name);
             if (opts.start !== undefined) s.start = opts.start;
             if (opts.increment !== undefined) s.increment = opts.increment;
             if (opts.minValue !== undefined) s.minValue = opts.minValue;
             if (opts.maxValue !== undefined) s.maxValue = opts.maxValue;
             if (opts.cycle !== undefined) s.cycle = opts.cycle;
             if (opts.cache !== undefined) s.cache = opts.cache;
             if (rm) { if (restartTo !== null) s.start = restartTo; s.value = null; }
             resultSet = [{ Result: "Success", Message: `Sequence '${name}' altered${rm ? ` (restarts at ${s.start})` : ''}.` }];
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
          else if (/^create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+)?table/i.test(sql)) {
             // 先頭が '__' の名前はエンジンの内部枠（カタログ項目 __views__ 等・一時表 __tmp_）と
             // 衝突する。作れてしまうと SHOW TABLES に出ず、保存時にカタログ扱いされて
             // **黙って消える**ため、作成時に明示的に拒否する
             const resM = sql.match(/^create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?(__[a-zA-Z0-9_]*)/i);
             if (resM) {
                 // ダブルクォートは（MySQL 既定と同じく）文字列リテラルなので、
                 // 表名の位置に来ると退避トークンのまま届く。区切り識別子はバッククォート
                 if (/^__STR_\d+__$/i.test(resM[1])) {
                     throw new Error("A double-quoted value is a string literal, not a table name. Use backticks for a quoted identifier: CREATE TABLE `my table` (...).");
                 }
                 throw new Error(`Table name '${resM[1]}' is reserved: names beginning with '__' are used internally by LuminaDB. Choose another name.`);
             }
             // CREATE [TEMPORARY] TABLE。TEMPORARY はセッション限り（IDB保存・SQLエクスポート対象外）
             // CREATE TABLE new LIKE src: スキーマ（型/制約/インデックス）のみ複製（データは含まない）
             const likeM = sql.match(/^create\s+(?:(?:global|local)\s+)?(temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+like\s+([a-zA-Z0-9_]+)$/i);
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
                t.onUpdateNowCols = [...(src.onUpdateNowCols || [])];
                t.isTemp = isTempFlag;
                Object.keys(src.indices).forEach(c => t.createIndex(c));
                this.tables[tableName] = t;
                return { data: [{ Result: "Success", Message: `Table '${tableName}' created like '${srcName}'.` }], affectedRows: 0 };
             }

             // CREATE TABLE ... [AS] SELECT (CTAS): SELECT 結果からテーブルを作成（AS は省略可）
             // 本体は SELECT のほか WITH ... SELECT（CTE 付き）も受ける
             const ctasM = sql.match(/^create\s+(?:(?:global|local)\s+)?(temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s+(?:as\s+)?((?:select|with)\s[\s\S]+?)(\s+with\s+(?:no\s+)?data)?$/i);
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
                // WITH NO DATA: 列構成だけ作って行はコピーしない（SQL標準）
                const withNoData = !!(ctasM[5] && /no\s+data/i.test(ctasM[5]));
                this._logCreateTable(tableName);
                const t = new Table();
                if (withNoData && subRes.data && subRes.data.length > 0) {
                    Object.keys(subRes.data[0]).forEach(k => t.addColumn(k));
                } else if ((!subRes.data || subRes.data.length === 0) && subRes.columns) {
                    // 0 行でも列は作る。従来は列すら無い表ができてしまい、
                    // 直後の SELECT が「列が見つからない」で落ちていた
                    subRes.columns.forEach(k => t.addColumn(k));
                } else if (subRes.data && subRes.data.length > 0) {
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

             const m = sql.match(/create\s+(?:(?:global|local)\s+)?(temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]+)\)([\s\S]*)$/i);
             if (m) {
                // 列定義の括弧は「最初の ( に対応する )」で閉じる。
                //
                // 上の正規表現は `\(([\s\S]+)\)` と貪欲なので、文末の ) まで飲み込む。
                // 列定義しか無い普通の CREATE TABLE では結果的に正しいが、括弧を含む
                // 後置オプションがあると壊れていた:
                //   CREATE TABLE t (id INT) PARTITION BY RANGE (id)
                // では列定義が `id INT) PARTITION BY RANGE (id` になり、後置オプションは
                // 空になる。そのため下の警告は一度も出たことが無く（括弧の無い
                // ENGINE=... だけが引っかかっていた）、PARTITION BY は文字どおり
                // 黙って捨てられていた。対応する括弧を数えて切り直す
                const pm = sql.match(/create\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?[a-zA-Z0-9_]+\s*\(/i);
                let colsText = m[4], tailText = m[5] || '';
                if (pm) {
                    const open = pm.index + pm[0].length - 1;
                    let depth = 0, close = -1, quote = null;
                    for (let i = open; i < sql.length; i++) {
                        const ch = sql[i];
                        if (quote) { if (ch === quote) quote = null; continue; }
                        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
                        if (ch === '(') depth++;
                        else if (ch === ')') { depth--; if (depth === 0) { close = i; break; } }
                    }
                    if (close !== -1) {
                        colsText = sql.slice(open + 1, close);
                        tailText = sql.slice(close + 1);
                    }
                }
                // 列定義の閉じ括弧より後ろ（ENGINE=... / WITH SYSTEM VERSIONING / PARTITION BY ...）は
                // 実装が無いので黙って捨てていた。受理はするが「効いていない」ことを警告に残す
                const tailOpts = tailText.trim().replace(/;$/, '').trim();
                if (tailOpts !== '') {
                    if (/^with\s+system\s+versioning$/i.test(tailOpts)) {
                        this._warn('NO_SYSTEM_VERSIONING', `WITH SYSTEM VERSIONING on '${m[3].toLowerCase()}' is accepted but no row history is kept; FOR SYSTEM_TIME queries are not supported.`);
                    } else if (/^partition\s+by\b/i.test(tailOpts)) {
                        this._warn('NO_PARTITIONING', `PARTITION BY on '${m[3].toLowerCase()}' is accepted and ignored; the table is stored as a single partition.`);
                    } else {
                        this._warn('TABLE_OPTIONS_IGNORED', `Table options after the column list are ignored: '${tailOpts.slice(0, 60)}'.`);
                    }
                }
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
                const defs = this.splitSelectClause(colsText);
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
                    // 複数列の FOREIGN KEY（複合主キーを参照する定番形）。
                    // 単一列 FK は { col, refCol }、複合は { cols, refCols } で保持する
                    const fkMulti = d.match(/^(?:constraint\s+([a-zA-Z0-9_]+)\s+)?foreign\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)+)\s*\)\s*references\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)([\s\S]*)$/i);
                    if (fkMulti) {
                        const mcols = fkMulti[2].split(',').map(x => x.trim().toLowerCase());
                        const mrefs = fkMulti[4].split(',').map(x => x.trim().toLowerCase());
                        if (mcols.length !== mrefs.length) {
                            throw new Error(`FOREIGN KEY (${mcols.join(', ')}) has ${mcols.length} columns but references ${mrefs.length}.`);
                        }
                        const macts = this._parseFkActions(fkMulti[5]);
                        foreignKeys.push({
                            cols: mcols, refTable: fkMulti[3].toLowerCase(), refCols: mrefs,
                            onDelete: macts.onDelete, onUpdate: macts.onUpdate,
                            name: fkMulti[1] ? fkMulti[1].toLowerCase() : null
                        });
                        return;
                    }
                    const fkMatch = d.match(/^(?:constraint\s+([a-zA-Z0-9_]+)\s+)?foreign\s+key\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*references\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+)\s*\)([\s\S]*)$/i);
                    // FOREIGN KEY だが上のどちらの形にも当てはまらない → 列定義として扱わず明示エラー
                    if (!fkMatch && /^(?:constraint\s+[a-zA-Z0-9_]+\s+)?foreign\s+key\b/i.test(d)) {
                        throw new Error(`Syntax Error in FOREIGN KEY definition near '${d.slice(0, 60)}'. Use FOREIGN KEY (col) REFERENCES table (col) [ON DELETE/UPDATE ...].`);
                    }
                    // PRIMARY KEY / UNIQUE は複数列（複合キー）を受理する
                    // CONSTRAINT <name> PRIMARY KEY (...) の名前付き形も受ける。
                    // 受けていなかったため、名前を付けた主キー宣言が列定義として解析され、
                    // `constraint` という幻の列が増えて表そのものが壊れていた
                    // （INSERT が「列数と値の数が合わない」で通らなくなる）
                    const pkMatch = d.match(/^(?:constraint\s+[a-zA-Z0-9_]+\s+)?primary\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
                    const uqMatch = d.match(/^(?:constraint\s+[a-zA-Z0-9_]+\s+)?unique\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
                    if (fkMatch) {
                        const acts = this._parseFkActions(fkMatch[5]);
                        foreignKeys.push({
                            col: fkMatch[2].toLowerCase(),
                            refTable: fkMatch[3].toLowerCase(),
                            refCol: fkMatch[4].toLowerCase(),
                            onDelete: acts.onDelete,
                            onUpdate: acts.onUpdate,
                            name: fkMatch[1] ? fkMatch[1].toLowerCase() : null
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
                        // 列レベルの REFERENCES（`pid INTEGER REFERENCES parent(id) ON DELETE CASCADE`）。
                        // 商用DBで最も普通の外部キー宣言なので、表レベルの FOREIGN KEY と同じ扱いにする。
                        // 参照列を省略した形（PostgreSQL）は参照先の主キーへ解決する。
                        // 他の修飾子より先に消費すること（ON DELETE SET DEFAULT の 'DEFAULT' や
                        // ON UPDATE CASCADE の 'ON UPDATE' を後続の解析に拾わせないため）
                        let colRef = null;
                        const refM = def.match(/\breferences\s+([a-zA-Z0-9_]+)\s*(?:\(\s*([a-zA-Z0-9_]+)\s*\))?((?:\s+on\s+(?:delete|update)\s+(?:cascade|set\s+null|no\s+action|restrict))*)((?:\s+(?:not\s+deferrable|deferrable|initially\s+(?:deferred|immediate)|match\s+(?:full|partial|simple)))*)/i);
                        if (refM) {
                            colRef = { refTable: refM[1].toLowerCase(), refCol: refM[2] ? refM[2].toLowerCase() : null, actions: refM[3] || '' };
                            def = def.replace(refM[0], ' ');
                        }
                        // 列レベルの COLLATE。以前は型の後ろの余分な語として捨てられ、
                        // DDL は通るのに比較・並べ替え・一意性のどれにも効いていなかった
                        let colCollation = null;
                        const collM = def.match(/\bcollate\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
                        if (collM) {
                            colCollation = collM[1].toUpperCase();
                            if (!this._COLLATIONS.has(colCollation)) {
                                throw new Error(`Unknown collation '${collM[1]}'. Use NOCASE / BINARY / NOACCENT / NUMERIC.`);
                            }
                            def = def.slice(0, collM.index) + ' ' + def.slice(collM.index + collM[0].length);
                        }
                        let isPK = false, isUnique = false, notNull = false, autoInc = false;
                        let defaultVal; // undefined = DEFAULT 指定なし
                        // ON UPDATE CURRENT_TIMESTAMP (MySQL): UPDATE のたびに現在時刻へ更新する列。
                        // FK の ON UPDATE 参照アクションとは別物なので、REFERENCES を含む定義では拾わない
                        let onUpdateNow = false;
                        if (!/\breferences\b/i.test(def) && /\bon\s+update\s+(?:current_timestamp|now\s*\(\s*\))\b/i.test(def)) {
                            onUpdateNow = true;
                            def = def.replace(/\bon\s+update\s+(?:current_timestamp|now\s*\(\s*\))\b/i, ' ');
                        }
                        if (/\bprimary\s+key\b/i.test(def)) { isPK = true; def = def.replace(/\bprimary\s+key\b/i, ' '); }
                        if (/\bunique\b/i.test(def)) { isUnique = true; def = def.replace(/\bunique\b/i, ' '); }
                        if (/\bauto_increment\b/i.test(def)) { autoInc = true; def = def.replace(/\bauto_increment\b/i, ' '); }
                        if (/\bnot\s+null\b/i.test(def)) { notNull = true; def = def.replace(/\bnot\s+null\b/i, ' '); }
                        // DEFAULT の値はリテラルのほか関数呼び出し・括弧式も取り得るので、
                        // 空白で切らず括弧の対応を見て 1 トークン分を切り出す
                        const dm = this._takeDefaultToken(def);
                        if (dm) {
                            defaultVal = this._parseDefaultLiteral(dm.raw, strMap);
                            def = def.slice(0, dm.start) + ' ' + def.slice(dm.end);
                        }
                        let parts = def.trim().split(/\s+/);
                        const colName0 = parts[0].toLowerCase();
                        let declType = parts.length > 1 && parts[1] ? parts[1].toUpperCase() : 'ANY';
                        // ユーザー定義ドメイン / 列挙型は基底型へ展開し、付随する制約を列へ移す
                        const dom = this.domains ? this.domains[declType.toLowerCase()] : null;
                        if (dom) {
                            declType = dom.base;
                            if (dom.notNull) notNull = true;
                            if (dom.check) checks.push({ name: null, expr: dom.check.replace(/\bVALUE\b/gi, colName0) });
                            if (dom.values) {
                                const list = dom.values.map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ');
                                checks.push({ name: null, expr: `${colName0} IN (${list})` });
                            }
                            if (dom.defaultText !== null && dm === null) {
                                const sm3 = [];
                                defaultVal = this._parseDefaultLiteral(this._maskStrings(dom.defaultText, sm3), sm3);
                            }
                        }
                        colDefs.push({ name: colName0, type: declType, isPK, isUnique, notNull, autoInc, defaultVal, hasDefault: dm !== null || (dom && dom.defaultText !== null), generatedExpr, onUpdateNow, colRef, collation: colCollation });
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

                // 列レベル REFERENCES を表レベル FOREIGN KEY と同じ配列へ合流させる。
                // 参照先の存在は宣言時に検証する（黙って制約を落とすと後で気づけない）
                // 自己参照（`REFERENCES <この表>`）は作成中でまだ this.tables に無いため、
                // 参照先の列は colDefs 側で確かめる
                const selfPk = pkCandidates.length === 1 ? pkCandidates[0] : null;
                const hasRefCol = (refTable, col) => refTable === tableName
                    ? colDefs.some(cd => cd.name === col)
                    : !!(this.tables[refTable] && this.tables[refTable].cols[col]);
                const refTableExists = (refTable) => refTable === tableName || !!this.tables[refTable];
                const refPkOf = (refTable) => refTable === tableName ? selfPk : (this.tables[refTable] || {}).primaryKey;

                colDefs.filter(c => c.colRef).forEach(cd => {
                    const r = cd.colRef;
                    if (!refTableExists(r.refTable)) throw new Error(`Table '${r.refTable}' not found for REFERENCES on column '${cd.name}'.`);
                    let refCol = r.refCol;
                    if (!refCol) {
                        // 参照列の省略時は参照先の主キー（単一列のみ）
                        refCol = refPkOf(r.refTable);
                        if (!refCol) throw new Error(`REFERENCES ${r.refTable} omits the column list but '${r.refTable}' has no single-column PRIMARY KEY.`);
                    }
                    if (!hasRefCol(r.refTable, refCol)) throw new Error(`Column '${refCol}' not found in table '${r.refTable}'.`);
                    if (foreignKeys.some(fk => (fk.cols || [fk.col]).length === 1 && (fk.cols ? fk.cols[0] : fk.col) === cd.name)) throw new Error(`Multiple FOREIGN KEY definitions on column '${cd.name}'.`);
                    const acts = this._parseFkActions(r.actions);
                    foreignKeys.push({ col: cd.name, refTable: r.refTable, refCol, onDelete: acts.onDelete, onUpdate: acts.onUpdate });
                });
                // 表レベル FOREIGN KEY の参照先も同じ規則で検証する（複合列も同じ経路）
                foreignKeys.forEach(fk => {
                    const fkCols = fk.cols || [fk.col];
                    const refCols = fk.refCols || [fk.refCol];
                    if (!refTableExists(fk.refTable)) throw new Error(`Table '${fk.refTable}' not found for FOREIGN KEY on column '${fkCols.join(', ')}'.`);
                    refCols.forEach(rc => { if (!hasRefCol(fk.refTable, rc)) throw new Error(`Column '${rc}' not found in table '${fk.refTable}'.`); });
                    fkCols.forEach(c => { if (!colDefs.some(cd => cd.name === c)) throw new Error(`Column '${c}' not found for FOREIGN KEY constraint.`); });
                    // 参照先には PRIMARY KEY か UNIQUE が要る（SQL 標準 / PostgreSQL / InnoDB）。
                    // 一意でない列を参照できてしまうと、親に同じ値の行が複数あるとき
                    // ON DELETE CASCADE が「まだ親が残っている子」まで消す。
                    // 自己参照は作成中で this.tables に無いので、いま組み立てている定義側を見る
                    const selfRef = fk.refTable === tableName;
                    const refIsUnique = (() => {
                        if (selfRef) {
                            if (refCols.length === 1) {
                                return primaryKey === refCols[0] || uniqueCols.includes(refCols[0])
                                    || compositeDefs.some(ck => ck.cols.length === 1 && ck.cols[0] === refCols[0]);
                            }
                            return compositeDefs.some(ck => ck.cols.length === refCols.length
                                && ck.cols.every(c => refCols.includes(c)));
                        }
                        const rt = this.tables[fk.refTable];
                        if (!rt) return true;   // ここまで来ないが、存在検証は上で済んでいる
                        if (refCols.length === 1) {
                            return rt.primaryKey === refCols[0] || (rt.uniqueCols || []).includes(refCols[0])
                                || (rt.compositeKeys || []).some(ck => ck.cols.length === 1 && ck.cols[0] === refCols[0]);
                        }
                        if ((rt.compositeKeys || []).some(ck => ck.cols.length === refCols.length
                                && ck.cols.every(c => refCols.includes(c)))) return true;
                        // 単一列 PK / UNIQUE の組み合わせでは複合参照を満たせない
                        return false;
                    })();
                    if (!refIsUnique) {
                        throw new Error(`FOREIGN KEY (${fkCols.join(', ')}) requires a PRIMARY KEY or UNIQUE constraint on ${fk.refTable}(${refCols.join(', ')}).`);
                    }
                });

                const aiCols = colDefs.filter(c => c.autoInc);
                if (aiCols.length > 1) throw new Error("Multiple AUTO_INCREMENT columns are not allowed.");
                // 同じ列名を二度書いても addColumn が二度目を黙って捨てるため、
                // 宣言した列数より少ない表が「成功」で作られていた
                {
                    const seen = Object.create(null);
                    for (const cd of colDefs) {
                        const k = String(cd.name).toLowerCase();
                        if (seen[k]) throw new Error(`Duplicate column name '${cd.name}'.`);
                        seen[k] = true;
                    }
                }

                const t = new Table();
                colDefs.forEach(cd => t.addColumn(cd.name, cd.type));
                // 桁指定・長さ指定を覚えておく。従来は「内部表現に影響しない」として
                // 捨てていたため、DECIMAL(10,2) や VARCHAR(3) が単なる飾りで、
                // 123.4567 や 8 文字がそのまま入っていた（CAST では正しく丸め・切り詰めるので
                // 同じ規則を格納時にも適用する）
                colDefs.forEach(cd => {
                    const spec = this._normalizeCastType(cd.type);
                    if (!spec.name) return;
                    if (spec.name === 'DECIMAL' && spec.s !== null) t.colTypeSpec[cd.name] = { kind: 'DECIMAL', p: spec.p, s: spec.s };
                    else if ((spec.name === 'TEXT' || spec.name === 'CHAR') && spec.p !== null) t.colTypeSpec[cd.name] = { kind: 'TEXT', len: spec.p };
                });
                t.foreignKeys = foreignKeys;
                t.primaryKey = primaryKey;
                t.uniqueCols = uniqueCols;
                t.notNullCols = colDefs.filter(c => c.notNull).map(c => c.name);
                t.defaults = {};
                colDefs.forEach(cd => { if (cd.hasDefault) t.defaults[cd.name] = cd.defaultVal; });
                t.autoIncrementCol = aiCols.length === 1 ? aiCols[0].name : null;
                t.checks = checks.map(c => ({ name: c.name || null, expr: c.expr }));
                t.compositeKeys = compositeDefs;
                // ON UPDATE CURRENT_TIMESTAMP 指定列（UPDATE のたびに現在時刻を書き込む）
                t.onUpdateNowCols = colDefs.filter(c => c.onUpdateNow).map(c => c.name);
                // 列の照合順序（BINARY は既定なので保持しない）
                colDefs.forEach(cd => { if (cd.collation && cd.collation !== 'BINARY' && cd.collation !== 'CS') t.collations[cd.name] = cd.collation; });
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
                 this._syncIndexNamesOnColumnChange(table, oldCol, newCol);
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

             // `ADD CONSTRAINT <name> PRIMARY KEY|UNIQUE|FOREIGN KEY ...`（マイグレーションで
             // 最も一般的な書き方）を、名前を控えたうえで無名形へ正規化する。こうすることで
             // 以下の各分岐は「CONSTRAINT 付き / 無し」を意識せずに済む。CHECK は元から
             // 名前を受けているので触らない
             let constraintName = null;
             const cnM = sql.match(/^(alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+)constraint\s+([a-zA-Z0-9_]+)\s+((?:primary\s+key|unique|foreign\s+key)\b[\s\S]*)$/i);
             if (cnM) {
                 constraintName = cnM[3].toLowerCase();
                 // 名前の重複はここで弾く。制約を張ってから名前を登録する順序だと、
                 // 名前だけ衝突したときに制約本体が付いたまま残ってしまう
                 const cnTable = this.tables[cnM[2].toLowerCase()];
                 if (cnTable && cnTable.constraintNames && cnTable.constraintNames[constraintName]) {
                     throw new Error(`Constraint '${constraintName}' already exists.`);
                 }
                 sql = cnM[1] + cnM[4];
             }

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
                     this._recordConstraintName(t, constraintName, 'pk', [col]);
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
                 this._recordConstraintName(t, constraintName, 'pk', pcols);
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
                     this._recordConstraintName(t, constraintName, 'unique', [col]);
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
                 this._recordConstraintName(t, constraintName, 'unique', ucols);
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

             // ADD FOREIGN KEY (col[, col...]) REFERENCES t (col[, col...]) — 単一列と複合列を同じ経路で扱う
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+add\s+foreign\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)\s*references\s+([a-zA-Z0-9_]+)\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)([\s\S]*)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const cols = m[2].split(',').map(x => x.trim().toLowerCase());
                 const refTable = m[3].toLowerCase();
                 const refCols = m[4].split(',').map(x => x.trim().toLowerCase());
                 const acts = this._parseFkActions(m[5]);
                 if (cols.length !== refCols.length) {
                     throw new Error(`FOREIGN KEY (${cols.join(', ')}) has ${cols.length} columns but references ${refCols.length}.`);
                 }
                 cols.forEach(c => { if (!t.cols[c]) throw new Error(`Column '${c}' not found.`); });
                 if (!this.tables[refTable]) throw new Error(`Table '${refTable}' not found.`);
                 const refTbl = this.tables[refTable];
                 refCols.forEach(c => { if (!refTbl.cols[c]) throw new Error(`Column '${c}' not found in table '${refTable}'.`); });
                 if ((t.foreignKeys || []).some(fk => this._fkCols(fk).join(',') === cols.join(','))) {
                     throw new Error(`FOREIGN KEY on '${cols.join(', ')}' already exists.`);
                 }
                 // 既存データ検証: NULL を含まないタプルが参照先に存在すること
                 for (let i = 0; i < t.rowCount; i++) {
                     const tuple = this._fkTupleOrNull((c) => t.getValue(c, i), cols);
                     if (tuple === null) continue;
                     if (this._fkMatchRows(refTbl, refCols, tuple).length === 0) {
                         throw new Error(`Foreign key constraint failed: Value '${tuple.join(', ')}' not found in ${refTable}(${refCols.join(', ')})`);
                     }
                 }
                 this._logTableMeta(table);
                 const entry = cols.length === 1
                     ? { col: cols[0], refTable, refCol: refCols[0], onDelete: acts.onDelete, onUpdate: acts.onUpdate, name: constraintName || null }
                     : { cols, refTable, refCols, onDelete: acts.onDelete, onUpdate: acts.onUpdate, name: constraintName || null };
                 t.foreignKeys = (t.foreignKeys || []).concat([entry]);
                 this._recordConstraintName(t, constraintName, 'fk', cols);
                 return { data: [{ Result: "Success", Message: `FOREIGN KEY added: ${table}(${cols.join(', ')}) -> ${refTable}(${refCols.join(', ')}).` }], affectedRows: 0 };
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
                     // NULL を含む行の評価は UNKNOWN(null) になる。SQL 標準では
                     // CHECK は「偽のときだけ違反」なので UNKNOWN は満たしたものとして通す。
                     // INSERT 側（_validateChecksAt / _validateChecksForChanges）は v1.24 で
                     // そう直っていたが、この ALTER 側だけ取り残されており、
                     // 「同じ制約を INSERT では通すのに、後から付けようとすると拒否される」
                     // ＝ NULL を含む列へ CHECK を追加できない状態だった
                     if (ok === null || ok === undefined) continue;
                     if (!ok) throw new Error(`CHECK constraint failed: existing data violates CHECK (${expr}).`);
                 }
                 this._logTableMeta(table);
                 t.checks = (t.checks || []).concat([{ name, expr }]);
                 return { data: [{ Result: "Success", Message: `CHECK constraint added on '${table}'.` }], affectedRows: 0 };
             }

             // ALTER TABLE ... DROP {CHECK|CONSTRAINT} name
             // DROP {CHECK|CONSTRAINT} <name>: CHECK に加えて、名前付きで追加された
             // PRIMARY KEY / UNIQUE / FOREIGN KEY も名前で外せる（マイグレーションの逆操作）
             m = sql.match(/^alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+(check|constraint)\s+([a-zA-Z0-9_]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const name = m[3].toLowerCase();
                 if ((t.checks || []).some(c => c.name === name)) {
                     this._logTableMeta(table);
                     t.checks = t.checks.filter(c => c.name !== name);
                     delete t.constraintNames[name];
                     return { data: [{ Result: "Success", Message: `CHECK constraint '${name}' dropped.` }], affectedRows: 0 };
                 }
                 // DROP CHECK は CHECK 専用（MySQL と同じ）。DROP CONSTRAINT は種別を問わない
                 const entry = /^constraint$/i.test(m[2]) ? (t.constraintNames || Object.create(null))[name] : undefined;
                 if (entry) {
                     this._logTableMeta(table);
                     this._dropNamedConstraint(t, name, entry);
                     const label = { pk: 'PRIMARY KEY', unique: 'UNIQUE', fk: 'FOREIGN KEY' }[entry.kind] || entry.kind.toUpperCase();
                     return { data: [{ Result: "Success", Message: `${label} constraint '${name}' dropped.` }], affectedRows: 0 };
                 }
                 throw new Error(`Constraint '${name}' not found on '${table}'.`);
             }

             // DROP FOREIGN KEY <name> (MySQL、括弧なし): 制約名または列名で解決する
             m = sql.match(/^alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+foreign\s+key\s+([a-zA-Z0-9_]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const key = m[2].toLowerCase();
                 const fk = (t.foreignKeys || []).find(f => f.name === key) || (t.foreignKeys || []).find(f => f.col === key);
                 if (!fk) throw new Error(`FOREIGN KEY '${key}' not found on '${table}'.`);
                 this._logTableMeta(table);
                 t.foreignKeys = t.foreignKeys.filter(f => f !== fk);
                 if (fk.name) delete t.constraintNames[fk.name];
                 return { data: [{ Result: "Success", Message: `FOREIGN KEY on ${table}(${fk.col}) dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+foreign\s+key\s*\(\s*([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)\s*\)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const cols = m[2].split(',').map(x => x.trim().toLowerCase());
                 const key = cols.join(',');
                 const hit = (t.foreignKeys || []).find(fk => this._fkCols(fk).join(',') === key);
                 if (!hit) throw new Error(`FOREIGN KEY on '${cols.join(', ')}' not found.`);
                 this._logTableMeta(table);
                 t.foreignKeys = t.foreignKeys.filter(fk => fk !== hit);
                 if (hit.name && t.constraintNames) delete t.constraintNames[hit.name];
                 return { data: [{ Result: "Success", Message: `FOREIGN KEY on ${table}(${cols.join(', ')}) dropped.` }], affectedRows: 0 };
             }

             // --- 列属性の変更 (SET/DROP DEFAULT / SET/DROP NOT NULL) ---
             // 値は空白を含む括弧式もあり得るので '(...)' ごと受けてから解釈する
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:alter|modify)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+set\s+default\s+([\s\S]+)$/i);
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

             // RENAME CONSTRAINT old TO new（SQL標準）: 制約名だけを付け替える
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+rename\s+constraint\s+([a-zA-Z0-9_]+)\s+to\s+([a-zA-Z0-9_]+)$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const oldName = m[2].toLowerCase(), newName = m[3].toLowerCase();
                 const names = t.constraintNames || Object.create(null);
                 // CHECK は t.checks 側に名前を持つので、両方の台帳を見る
                 const isCheck = (t.checks || []).some(c => c.name === oldName);
                 if (!names[oldName] && !isCheck) throw new Error(`Constraint '${m[2]}' not found on table '${table}'.`);
                 if (oldName !== newName && (names[newName] || (t.checks || []).some(c => c.name === newName))) {
                     throw new Error(`Constraint '${m[3]}' already exists on table '${table}'.`);
                 }
                 this._logTableMeta(table);
                 t.constraintNames = t.constraintNames || Object.create(null);
                 if (oldName !== newName) {
                     if (t.constraintNames[oldName]) {
                         t.constraintNames[newName] = t.constraintNames[oldName];
                         delete t.constraintNames[oldName];
                     }
                     // 名前を控えている実体（FK / CHECK）側も追従させる
                     (t.foreignKeys || []).forEach(fk => { if (fk.name === oldName) fk.name = newName; });
                     (t.checks || []).forEach(ck => { if (ck.name === oldName) ck.name = newName; });
                 }
                 return { data: [{ Result: "Success", Message: `Constraint '${oldName}' renamed to '${newName}'.` }], affectedRows: 0 };
             }

             // MODIFY COLUMN / ALTER COLUMN: 既存カラムの型を変更（データは changeColumnType がキャスト）。
             // TYPE / SET DATA TYPE（SQL標準）の両綴りを受け、USING <expr> で変換式を与えられる
             // 型は VARCHAR(50) / DECIMAL(12,4) のような桁指定付きも受ける。
             // 従来は `[a-zA-Z]+` しか許さず、`MODIFY COLUMN a VARCHAR(50)` が
             // 「Syntax Error in ALTER TABLE.」になっていた（CAST 側は既に対応済みだった）
             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+(?:modify|alter)\s+(?:column\s+)?([a-zA-Z0-9_]+)\s+(?:set\s+data\s+type\s+|type\s+)?([a-zA-Z][a-zA-Z0-9_]*(?:\s+[a-zA-Z][a-zA-Z0-9_]*)?\s*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)(?:\s+using\s+([\s\S]+?))?$/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const t = this.tables[table];
                 const colName = m[2].toLowerCase();
                 if (!t.cols[colName]) throw new Error(`Column '${colName}' not found.`);
                 // 方言別名（VARCHAR / INT / NUMBER ...）を正準名へ寄せる。桁指定は
                 // 内部表現に影響しないので受理して捨てる（CAST と同じ扱い）
                 const rawType = m[3].trim();
                 const norm = this._normalizeCastType(rawType);
                 const CANON = { INTEGER: 'INTEGER', DECIMAL: 'FLOAT', FLOAT: 'FLOAT', DOUBLE: 'FLOAT',
                                 BOOLEAN: 'BOOLEAN', DATEONLY: 'DATE', DATE: 'DATE', DATETIME: 'DATE', TIME: 'TEXT',
                                 TEXT: 'TEXT', CHAR: 'TEXT', JSON: 'TEXT', BLOB: 'TEXT' };
                 const validTypes = ['INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'TEXT', 'ANY'];
                 let newType = rawType.replace(/\s*\([\s\S]*$/, '').toUpperCase();
                 if (validTypes.includes(newType)) { /* そのまま */ }
                 else if (norm.name && CANON[norm.name]) newType = CANON[norm.name];
                 else throw new Error(`Unknown type '${rawType}'. Use ${validTypes.join('/')} or a standard alias (VARCHAR, INT, DECIMAL, ...).`);

                 // USING <expr>: 旧行の値で式を評価してから新しい型で格納する（PostgreSQL 互換）
                 let transform = null;
                 if (m[4]) {
                     const uf = this.compileCondition(m[4].trim(), strMap);
                     transform = new Array(t.rowCount);
                     for (let i = 0; i < t.rowCount; i++) {
                         transform[i] = uf({ [table]: i }, this.tables, { [table]: table });
                     }
                 }

                 // 型変更は文字列プールを作り直すため列 COW では巻き戻せない → 全体スナップショット
                 this._logFullTable(table);
                 const before = [];
                 for (let i = 0; i < t.rowCount; i++) before.push(t.getValue(colName, i));
                 t.changeColumnType(colName, newType, transform);
                 // 値が変質した行（小数の切り捨て等）は成功メッセージからは分からないので警告に残す
                 if (!transform) {
                     let lost = 0;
                     for (let i = 0; i < t.rowCount; i++) {
                         const a = before[i], b = t.getValue(colName, i);
                         if (a === null || a === undefined) continue;
                         if (String(a) !== String(b)) lost++;
                     }
                     if (lost > 0) {
                         this._warn('TYPE_CONVERSION', `Changing '${table}.${colName}' to ${newType} altered ${lost} value(s) (data was rounded or reformatted).`);
                     }
                 }
                 resultSet = [{ Result: "Success", Message: `Column '${colName}' type changed to ${newType}.` }];
                 return { data: resultSet, affectedRows: 0 };
             }

             // 制約キーワードを含む ADD/DROP が上記の専用構文に一致しなかった場合は構文エラー。
             // 汎用 ADD/DROP COLUMN に落ちて 'unique' 等の偽カラムが作られるのを防ぐ
             if (/^alter\s+table\s+[a-zA-Z0-9_]+\s+(?:add|drop)\s+(?:primary|unique|foreign|constraint|check)\b/i.test(sql)) {
                 throw new Error("Syntax Error in ALTER TABLE constraint clause. Supported: ADD [CONSTRAINT name] {PRIMARY KEY (col...) | UNIQUE (col...) | FOREIGN KEY (col) REFERENCES t(col) [ON DELETE/UPDATE ...] | CHECK (expr)} / DROP {PRIMARY KEY | UNIQUE (col...) | FOREIGN KEY (col) | FOREIGN KEY name | CHECK name | CONSTRAINT name}.");
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
                 // GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]: 生成列を後から足す
                 let genExpr = null;
                 {
                     const gm = def.match(/\s*(?:generated\s+always\s+)as\s*\(([\s\S]+?)\)\s*(?:stored|virtual)?\s*$/i);
                     if (gm) {
                         genExpr = this._restoreStrings(gm[1].trim(), strMap);
                         def = def.slice(0, gm.index);
                     }
                 }
                 let notNull = false, hasDefault = false, defaultVal;
                 if (/\bnot\s+null\b/i.test(def)) { notNull = true; def = def.replace(/\bnot\s+null\b/i, ' '); }
                 // CREATE TABLE と同じく、値は括弧の対応で切り出す（`DEFAULT (3 + 4)` 対応）
                 const dm = this._takeDefaultToken(def);
                 if (dm) {
                     hasDefault = true;
                     defaultVal = this._parseDefaultLiteral(dm.raw, strMap);
                     def = def.slice(0, dm.start) + ' ' + def.slice(dm.end);
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
                     const fillVal = this._resolveDefaultValue(defaultVal);
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
                 // 生成列: 式を記録し、既存行の値もその場で埋める
                 if (genExpr) {
                     const sm2 = [];
                     const gf = this.compileCondition(this._maskStrings(genExpr, sm2), sm2);
                     const aliases2 = { [table]: table };
                     try {
                         for (let i = 0; i < t.rowCount; i++) t.setValue(colName, i, gf({ [table]: i }, this.tables, aliases2));
                     } catch (e) {
                         t.dropColumn(colName);
                         throw new Error(`GENERATED AS expression failed: ${e.message}`);
                     }
                     t.generatedCols = t.generatedCols || Object.create(null);
                     t.generatedCols[colName] = genExpr;
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
                 this._assertNoGeneratedDependents(this.tables[table], table, colName);
                 this._logFullTable(table);
                 this.tables[table].dropColumn(colName);
                 this._syncIndexNamesOnColumnChange(table, colName, null);
                 return { data: [{ Result: "Success", Message: `Column '${colName}' dropped.` }], affectedRows: 0 };
             }

             m = sql.match(/alter\s+table\s+([a-zA-Z0-9_]+)\s+drop\s+(?:column\s+)?([a-zA-Z0-9_]+)/i);
             if (m) {
                 const table = m[1].toLowerCase();
                 if (!this.tables[table]) throw new Error(`Table '${table}' not found.`);
                 const colName = m[2].toLowerCase();
                 if (!this.tables[table].cols[colName]) throw new Error(`Column '${colName}' not found.`);

                 this._assertNoGeneratedDependents(this.tables[table], table, colName);
                 this._logFullTable(table); // 列構成が変わるため全体スナップショット
                 this.tables[table].dropColumn(colName);
                 this._syncIndexNamesOnColumnChange(table, colName, null);
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
             // 表名はカンマ区切りで複数指定できる（SQL標準 / PostgreSQL）。
             // 以前は先頭の 1 表だけを空にして「成功」を返しており、残りが黙って残っていた
             const m = sql.match(/^truncate\s+(?:table\s+)?([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)((?:\s+[\s\S]*)?)$/i);
             if (m) {
                const opts = (m[2] || '').trim();
                if (opts !== '' && !/^(?:restart|continue)\s+identity(?:\s+(?:cascade|restrict))?$|^(?:cascade|restrict)$/i.test(opts)) {
                    throw new Error("Syntax Error in TRUNCATE TABLE. Use TRUNCATE [TABLE] name[, name...] [RESTART|CONTINUE IDENTITY] [CASCADE|RESTRICT].");
                }
                const names = m[1].split(',').map(x => x.trim().toLowerCase());
                const dup = names.find((n, i) => names.indexOf(n) !== i);
                if (dup) throw new Error(`Table '${dup}' is listed more than once in TRUNCATE.`);
                names.forEach(n => { if (!this.tables[n]) throw new Error(`Table '${n}' not found.`); });
                const restartIdentity = /\brestart\s+identity\b/i.test(sql);
                const continueIdentity = /\bcontinue\s+identity\b/i.test(sql);
                // 外部キーの検査。TRUNCATE は DELETE と違って参照を一切見ておらず、
                // 直前の DELETE が拒否される表でも丸ごと空にできてしまい、
                // 子行が親の無い状態で残った（黙って参照整合性が壊れる）。
                // PostgreSQL に合わせて既定 RESTRICT ＝拒否、CASCADE なら子表も空にする。
                // 変更を始める前に対象集合を確定させ、文全体を all-or-nothing に保つ
                const cascade = /(?:^|\s)cascade\s*$/i.test(opts);
                const truncSet = new Set(names);
                if (this.fkChecksEnabled !== false) {
                    const queue = [...names];
                    while (queue.length > 0) {
                        const parent = queue.shift();
                        for (const otherName in this.tables) {
                            const other = this.tables[otherName];
                            if (!other || !other.foreignKeys) continue;
                            const refs = other.foreignKeys.some(fk => String(fk.refTable).toLowerCase() === parent);
                            if (!refs || truncSet.has(otherName)) continue;
                            // 自表を参照する FK（自己参照）は行を全部消せば矛盾しないので許す
                            if (otherName === parent) continue;
                            if (!cascade) {
                                throw new Error(`Table '${parent}' cannot be truncated: it is referenced by a foreign key on '${otherName}'. Use TRUNCATE ${parent} CASCADE, or delete the referencing rows first.`);
                            }
                            truncSet.add(otherName);
                            queue.push(otherName);
                        }
                    }
                }
                const truncNames = [...truncSet];
                const notes = [];
                affectedRows = 0;
                truncNames.forEach(table => {
                    this._cowColumns(table, 'ALL');
                    const t = this.tables[table];
                    // 採番は既存行の最大値から続く実装なので、行を消すと自然に 1 へ戻る。
                    // CONTINUE IDENTITY（SQL標準の既定）では消す前の最大値を下限として覚えておく
                    if (continueIdentity && t.autoIncrementCol) {
                        let maxId = 0;
                        for (let i = 0; i < t.rowCount; i++) {
                            const v = t.getValue(t.autoIncrementCol, i);
                            if (typeof v === 'number' && v > maxId) maxId = v;
                        }
                        t.identityFloor = Math.max(t.identityFloor || 1, maxId + 1);
                    }
                    if (restartIdentity) t.identityFloor = 1;
                    affectedRows += t.rowCount;
                    t.rowCount = 0;
                    t.version++;   // 派生構造の作り直しを促す
                    if (Object.keys(t.indices).length > 0) t.rebuildIndices();
                    if (t.autoIncrementCol && continueIdentity) notes.push(`${table} identity continues at ${t.identityFloor}`);
                    else if (t.autoIncrementCol && restartIdentity) notes.push(`${table} identity restarted`);
                });
                const idNote = notes.length > 0 ? ` (${notes.join('; ')})` : '';
                resultSet = [{Result:"Success", Message:`${affectedRows} rows truncated${idNote}.`}];
             } else throw new Error("Syntax Error in TRUNCATE TABLE.");
          }
          else if (/^alter\s+index/i.test(sql)) {
             // ALTER INDEX name RENAME TO new — 索引名はメタデータなので付け替えるだけ
             const m = sql.match(/^alter\s+index\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)\s+rename\s+to\s+([a-zA-Z0-9_]+)$/i);
             if (!m) throw new Error("Syntax Error in ALTER INDEX. Use ALTER INDEX [IF EXISTS] name RENAME TO new_name.");
             const oldName = m[2].toLowerCase(), newName = m[3].toLowerCase();
             this.indexNames = this.indexNames || Object.create(null);
             if (!this.indexNames[oldName]) {
                 if (m[1]) return { data: [{ Result: "Success", Message: `Index '${oldName}' does not exist. Skipped.` }], affectedRows: 0 };
                 throw new Error(`Index '${oldName}' not found.`);
             }
             if (this.indexNames[newName]) throw new Error(`Index '${newName}' already exists.`);
             this.indexNames[newName] = this.indexNames[oldName];
             delete this.indexNames[oldName];
             resultSet = [{ Result: "Success", Message: `Index '${oldName}' renamed to '${newName}'.` }];
          }
          else if (/^drop\s+index/i.test(sql)) {
             // CREATE INDEX と対称の構文。インデックス名は列で管理しているため省略可。
             // 列リストを省いた DROP INDEX name [ON table]（MySQL / SQL Server / PostgreSQL 形式）は
             // CREATE INDEX で記録した名前→列の対応から解決する
             const byName = sql.match(/^drop\s+index\s+(if\s+exists\s+)?([a-zA-Z0-9_]+)(?:\s+on\s+([a-zA-Z0-9_]+))?\s*$/i);
             if (byName) {
                const ifExists2 = !!byName[1];
                const idxName = byName[2].toLowerCase();
                const rec = (this.indexNames || {})[idxName];
                if (!rec || (byName[3] && rec.table !== byName[3].toLowerCase())) {
                    if (ifExists2) return { data: [{ Result: "Success", Message: `Index '${idxName}' does not exist. Skipped.` }], affectedRows: 0 };
                    throw new Error(`Index '${idxName}' not found. Use DROP INDEX [IF EXISTS] name ON table (col) to drop an unnamed index.`);
                }
                const t2 = this.tables[rec.table];
                if (!t2) throw this._tableNotFound(rec.table);
                this._logTableMeta(rec.table);
                rec.cols.forEach(c => { delete t2.indices[c]; });
                delete this.indexNames[idxName];
                return { data: [{ Result: "Success", Message: `Index '${idxName}' on ${rec.table}(${rec.cols.join(', ')}) dropped.` }], affectedRows: 0 };
             }
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
             const m = sql.match(/^drop\s+view\s+(if\s+exists\s+)?([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)(?:\s+(cascade|restrict))?$/i);
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
                    if (this.viewMeta) delete this.viewMeta[name];
                    resultSet = [{Result:"Success", Message:`View '${name}' dropped.`}];
                } else {
                    const missing = names.filter(n => !this.views[n]);
                    if (missing.length > 0 && !ifExists) throw new Error(`View '${missing[0]}' not found.`);
                    const dropped = [];
                    names.forEach(n => {
                        if (!this.views[n]) return;
                        this._logViewState(n);
                        delete this.views[n];
                        if (this.viewMeta) delete this.viewMeta[n];
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
             const m = sql.match(/^drop\s+table\s+(if\s+exists\s+)?([a-zA-Z0-9_]+(?:\s*,\s*[a-zA-Z0-9_]+)*)(?:\s+(cascade|restrict))?$/i);
             if (m) {
                const ifExists = !!m[1];
                const names = m[2].split(',').map(s => s.trim().toLowerCase());
                // CASCADE: 消す表を参照している他表の外部キー定義も一緒に取り除く。
                // RESTRICT（既定）は参照が残っていれば拒否する
                const dropMode = (m[3] || 'RESTRICT').toUpperCase();
                const refsTo = (tn) => Object.keys(this.tables).filter(o => o !== tn
                    && (this.tables[o].foreignKeys || []).some(fk => fk.refTable === tn));
                names.forEach(tn => {
                    if (!this.tables[tn]) return;
                    const dependents = refsTo(tn);
                    if (dependents.length === 0) return;
                    if (dropMode !== 'CASCADE') {
                        throw new Error(`Cannot drop table '${tn}': it is referenced by a foreign key on '${dependents[0]}'. Use DROP TABLE ${tn} CASCADE.`);
                    }
                    dependents.forEach(o => {
                        this._logTableMeta(o);
                        this.tables[o].foreignKeys = this.tables[o].foreignKeys.filter(fk => fk.refTable !== tn);
                    });
                });
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
          else {
             // 未知の DDL を黙って成功させない（対応漏れがサイレントな no-op になるのを防ぐ）
             throw new Error("Syntax Error or Unsupported Command.");
          }
          return { data: resultSet, affectedRows };
      }
    });
