    // ============================================================================
    // [DatabaseEngine Core] - コンストラクタ / 初期データ / クエリディスパッチ
    // 各機能メソッドは engine-*.js で prototype 拡張として定義される
    // ============================================================================
    // エンジンバージョン（VERSION() 関数 / SHOW STATUS / 外部APIが参照する）
    var LUMINA_VERSION = '1.17.0';

    class DatabaseEngine {
      constructor() {
        // テーブル/ビュー/プロシージャ名（SQL由来の文字列）をキーにするため null プロトタイプで
        // 生成する（'__proto__' や 'constructor' という名前による汚染・誤ヒットを防ぐ）
        this.tables = Object.create(null);
        this.views = Object.create(null);
        this.procedures = Object.create(null);
        // トリガー定義: name -> { name, timing, event, table, statements }
        this.triggers = Object.create(null);
        // ユーザー変数 (SET @name = ...)。セッション限り（IDB保存対象外）
        this.userVars = Object.create(null);
        // プリペアドステートメント (PREPARE name FROM '...')。セッション限り・非トランザクション
        this.prepared = Object.create(null);
        // シーケンス (CREATE SEQUENCE): name -> { start, increment, value }。IDB保存対象。
        // 値の採番 (NEXTVAL) は実DB同様に非トランザクション（ROLLBACKで巻き戻らない）
        this.sequences = Object.create(null);
        // COMMENT ON で付与した注釈: 'table:t' / 'column:t.c' -> 文字列。IDB保存対象。
        this.comments = Object.create(null);
        // マテリアライズドビュー: name -> { sql }。実体は tables[name] に持ち、
        // REFRESH MATERIALIZED VIEW で再計算する（通常ビューと違い自動更新されない）
        this.matViews = Object.create(null);
        // スキーマ版数 (PRAGMA user_version)。マイグレーション管理用・IDB保存対象
        this.userVersion = 0;
        // ストアドプロシージャの仮引数: name -> [p1, p2, ...]（本体は procedures 側）
        this.procParams = Object.create(null);
        // ユーザー定義スカラー関数 (CREATE FUNCTION): name -> { params: [...], body, returns }
        // 呼び出し箇所へ式として展開される（IDB保存対象）
        this.functions = Object.create(null);
        // 名前付きスナップショット (CREATE SNAPSHOT): name -> { at, tables, ... }。
        // メモリ内タイムトラベル用。IDB保存対象外（セッション限り）
        this.snapshots = Object.create(null);
        // セッション設定（SET TRANSACTION ISOLATION LEVEL 等）。表示・互換用でセッション限り
        this.sessionSettings = Object.create(null);
        // 文単位の実行時間上限 (ms)。0/未設定なら無制限。
        // ブラウザではクエリがUIスレッドを占有するため、暴走クエリの保険として使う
        this.statementTimeoutMs = 0;
        // 直近クエリのプロファイル（SHOW PROFILE）と遅いクエリのリングバッファ
        this.lastProfile = null;
        this.slowLog = [];
        this.slowLogThresholdMs = 50;
        // 読み取り専用モード。ON の間は DML/DDL を拒否する（外部APIの安全な公開用）。
        // readOnlyLocked が真だと SQL 側（SET read_only = OFF）からは解除できず、
        // ホストアプリの LuminaDB.readOnly(false) だけが解除できる
        this.readOnly = false;
        this.readOnlyLocked = false;
        this.inTransaction = false;
        this.undoLog = [];
        // 直近の INSERT で AUTO_INCREMENT 列へ採番された最終値（LAST_INSERT_ID() が返す）
        this.lastInsertId = 0;
        // 相関サブクエリの文単位レジストリ（executeQuery のトップレベルでリセット）
        this._corrSubs = [];
        this._attachEngineRef();
        this._initDefaultData();
      }

      // タイプミス提案用の簡易編集距離（挿入/削除/置換）。長さ差2超は早期棄却
      _editDistance(a, b) {
          if (Math.abs(a.length - b.length) > 2) return 99;
          const dp = new Array(b.length + 1);
          for (let j = 0; j <= b.length; j++) dp[j] = j;
          for (let i = 1; i <= a.length; i++) {
              let prev = dp[0];
              dp[0] = i;
              for (let j = 1; j <= b.length; j++) {
                  const tmp = dp[j];
                  dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
                  prev = tmp;
              }
          }
          return dp[b.length];
      }

      // 候補から編集距離2以内で最も近い名前を返す（無ければ null）
      _suggestName(name, candidates) {
          let best = null, bestD = 3;
          const lower = String(name).toLowerCase();
          for (const c of candidates) {
              if (c.startsWith('__')) continue;
              const d = this._editDistance(lower, c.toLowerCase());
              if (d < bestD) { bestD = d; best = c; }
          }
          return best;
      }

      // 「テーブルが見つからない」エラーをタイプミス提案付きで生成する
      _tableNotFound(name, label = 'Table') {
          const s = this._suggestName(name, Object.keys(this.tables).concat(Object.keys(this.views)));
          return new Error(`${label} '${name}' not found.${s ? ` Did you mean '${s}'?` : ''}`);
      }

      // コンパイル済み式（new Function）から相関サブクエリを実行できるよう、
      // tables 辞書へエンジン自身への非列挙参照を張る。非列挙のため for..in /
      // Object.keys のテーブル走査（FK検査・SHOW TABLES・ダンプ）には現れない。
      _attachEngineRef() {
        Object.defineProperty(this.tables, '__engine__', {
          value: this, enumerable: false, configurable: true, writable: true
        });
      }

      _initDefaultData() {
        const createTableFromData = (name, dataObj) => {
            const t = new Table();
            const cols = Object.keys(dataObj);
            if(cols.length === 0) return t;
            cols.forEach(c => t.addColumn(c));
            const rows = dataObj[cols[0]].length;
            while(t.capacity < rows) t.grow();
            for(let i=0; i<rows; i++) {
                cols.forEach(c => t.setValue(c, i, dataObj[c][i]));
            }
            t.rowCount = rows;
            this.tables[name.toLowerCase()] = t;
        };

        createTableFromData('users', {
            id: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            name: ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy"],
            age: [25, 30, 22, 35, 28, 40, 29, 31, 24, 27]
        });

        createTableFromData('products', {
            id: [101, 102, 103, 104, 105],
            name: ["Laptop", "Monitor", "Mouse", "Keyboard", "Router"],
            price: [1500, 800, 120, 250, 400],
            stock: [45, 12, 100, 80, 0]
        });

        createTableFromData('orders', {
            order_id: [1001, 1002, 1003, 1004, 1005],
            user_id: [1, 2, 1, 3, 4],
            product_id: [101, 103, 105, 102, 104],
            amount: [1, 2, 1, 5, 1]
        });
      }

      cleanupTempTables() {
          Object.keys(this.tables).forEach(tbl => {
              if (tbl.startsWith('__tmp_')) delete this.tables[tbl];
          });
      }

      executeQuery(rawSql, isSubquery = false, externalStrMap = null) {
        const startTime = performance.now();
        if (!rawSql || typeof rawSql !== 'string' || rawSql.trim() === '') {
            return { error: "Empty query" };
        }
        // DoSガード: 異常に長いクエリ（外部API経由を含む）を拒否する
        if (rawSql.length > 1000000) {
            return { error: "Query too long (max 1,000,000 characters)." };
        }
        let sql = rawSql;
        // SQLコメントを除去（-- 行コメント / C形式ブロックコメント）。
        // 文字列リテラルは代替パターンで先にマッチさせて保護する。
        // 行コメントは MySQL 同様 '--' の直後が空白または行末の場合のみ（'5--3' 等の演算は対象外）
        if (!isSubquery && !externalStrMap) {
            sql = sql.replace(/('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")|--(?=\s|$)[^\n]*|\/\*[\s\S]*?\*\//g,
                (m, str) => str !== undefined ? m : ' ');
        }
        sql = sql.trim().replace(/;$/, '');
        if (sql === '') return { error: "Empty query" };

        let strMap = externalStrMap;
        const isTopLevel = !isSubquery && !externalStrMap;
        if (isTopLevel) {
            strMap = [];
            // 相関サブクエリのレジストリは文単位（コンパイル済み式が実行中に参照する）
            this._corrSubs = [];
            sql = this._maskStrings(sql, strMap);
            // 文単位の実行時間上限。ネストした executeQuery は最上位の期限を引き継ぐ
            this._deadline = this.statementTimeoutMs > 0 ? (startTime + this.statementTimeoutMs) : 0;
        }
        // エンジン参照は tables 辞書の非列挙プロパティなので、SQL の識別子として
        // 書かれると「テーブルとして見つかってしまう」。予約語として明示的に弾く
        // （文字列リテラルは退避済みなので、データ中の同名文字列には反応しない）
        if (/\b__engine__\b/.test(sql)) {
            return { error: "Identifier '__engine__' is reserved." };
        }
        // 読み取り専用モード: 参照系以外を実行前に拒否する（外部公開時の保護）。
        // 解除は SET read_only = OFF か LuminaDB.readOnly(false)。ただし
        // LuminaDB.readOnly(true, { lock: true }) でロックした場合は SQL からは解除できない
        if (this.readOnly && !this._isReadOnlyStatement(sql)) {
            const unlock = !this.readOnlyLocked && /^set\s+(?:session\s+|local\s+|global\s+)?read_only\b/i.test(sql);
            if (!unlock) return { error: "Database is in read-only mode: this statement is not allowed." };
        }

        let isExplain = false;
        let isAnalyze = false;
        // EXPLAIN (FORMAT JSON|TEXT) ... : オプション括弧を受理する（PostgreSQL 形式）
        let explainJson = false;
        const exOpt = sql.match(/^explain\s*\(\s*([\s\S]*?)\s*\)\s+/i);
        if (exOpt) {
            const opts = exOpt[1].split(',').map(o => o.trim().toUpperCase());
            const fmt = opts.find(o => /^FORMAT\s+/.test(o));
            if (fmt) {
                const f = fmt.replace(/^FORMAT\s+/, '');
                if (f !== 'JSON' && f !== 'TEXT') {
                    return { error: `Unsupported EXPLAIN format '${f}'. Use FORMAT JSON or FORMAT TEXT.` };
                }
                explainJson = f === 'JSON';
            }
            sql = 'EXPLAIN ' + sql.slice(exOpt[0].length);
        }
        // SQLite の EXPLAIN QUERY PLAN は通常の EXPLAIN と同義に扱う
        sql = sql.replace(/^explain\s+query\s+plan\s+/i, 'EXPLAIN ');
        if (/^explain\s+analyze\s+/i.test(sql)) {
            // EXPLAIN ANALYZE: 実行計画に加えてクエリを実際に実行し、実測値を付記する
            isAnalyze = true;
            sql = sql.replace(/^explain\s+analyze\s+/i, '').trim();
        } else if (/^explain\s+/i.test(sql)) {
            isExplain = true;
            sql = sql.replace(/^explain\s+/i, '').trim();
        }

        let resultSet = [];
        let affectedRows = 0;

        try {
          // WITH 句 (CTE): 各CTEを一時テーブルへ実体化し、本体クエリに書き換える
          if (!isSubquery && /^with\s/i.test(sql)) {
              sql = this._expandCTEs(sql, strMap);
          }

          // CREATE VIEW / PROCEDURE / TRIGGER の本体は定義として保存するため事前展開しない。
          // MERGE は USING (サブクエリ) を自前で解釈するため、ここでの一括展開対象から除外する
          // （下位の SELECT / UPDATE / INSERT 再実行時に個別展開される）。
          // ロック句 FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE は受理して無視する
          // （LuminaDB は文を直列実行するので行ロックは意味を持たない）
          if (/^select/i.test(sql)) {
              sql = sql.replace(/\s+FOR\s+(?:UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)(?:\s+OF\s+[a-zA-Z0-9_,\s]+?)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\s*$/i, '');
          }
          // 単一スキーマ (main / public) の修飾は取り除いて素の表名にする
          if (/\b(?:main|public)\s*\.\s*[a-zA-Z_]/i.test(sql)) {
              sql = sql.replace(/\b(?:main|public)\s*\.\s*(?=[a-zA-Z_])/gi, '');
          }

          // 複数表 UPDATE/DELETE（... FROM src / ... USING src / ... JOIN src）は
          // サブクエリ展開の前に単一表＋相関サブクエリの形へ書き換える
          if (!isSubquery && /^(update|delete)\b/i.test(sql)) {
              sql = this._rewriteMultiTableDml(sql);
          }

          if (!isSubquery
              && !/^create\s+(or\s+replace\s+)?(view|procedure|trigger|function)\b/i.test(sql)
              && !/^merge\s+into\b/i.test(sql)) {
              sql = this.expandInfoSchema(sql);
              sql = this.expandViews(sql, strMap);
              sql = this.expandTableFunctions(sql, strMap);
              sql = this.expandRelationalOps(sql, strMap);
              sql = this.expandSubqueries(sql, strMap);
          }

          if (isAnalyze && !/^select/i.test(sql)) {
              throw new Error("EXPLAIN ANALYZE supports SELECT statements only.");
          }

          if (/^(begin|start|commit|rollback|savepoint|release)/i.test(sql)) {
             const res = this._executeTransaction(sql);
             resultSet = res.data;
          }
          else if (/^select/i.test(sql)) {
             // SQL Server の SELECT ... INTO <newtable> FROM ...: 結果から新テーブルを作る
             // （CREATE TABLE ... AS SELECT と同義）。INTO を外して本体を実行し実体化する。
             const intoM = sql.match(/^([\s\S]*?)\s+INTO\s+([a-zA-Z0-9_]+)\s+(FROM\b[\s\S]*)$/i);
             if (intoM && /^select/i.test(intoM[1])) {
                 const res = this._executeSelectInto(intoM[2].toLowerCase(), `${intoM[1]} ${intoM[3]}`, strMap);
                 if (!isSubquery) this.cleanupTempTables();
                 return { data: res.data, executionTime: Math.max(0.01, performance.now() - startTime).toFixed(2), scannedRows: res.affectedRows };
             }
             const unionSegments = this._splitUnion(sql);
             let res;
             if (isAnalyze) {
                 // EXPLAIN ANALYZE: 計画ステップ + 実行の実測値（行数・時間）を返す
                 if (unionSegments.length > 1) throw new Error("EXPLAIN ANALYZE supports a single SELECT statement (no UNION).");
                 const parsed = this._parseSelect(sql);
                 const planX = this._optimizeSelect(parsed, true, strMap);
                 const t0 = performance.now();
                 const planR = this._optimizeSelect(parsed, false, strMap);
                 const resR = this._executeSelectPlan(planR, strMap);
                 const ms = performance.now() - t0;
                 const rows = planX.explainPlan.slice();
                 rows.push({ Step: rows.length + 1, Operation: 'ACTUAL', Details: `${resR.data.length} row(s) returned in ${ms.toFixed(2)} ms` });
                 if (!isSubquery) this.cleanupTempTables();
                 return { data: rows, executionTime: (performance.now() - startTime).toFixed(2), scannedRows: resR.data.length };
             }
             if (unionSegments.length > 1) {
                 res = this._executeUnion(unionSegments, isExplain, strMap);
             } else {
                 const parsed = this._parseSelect(sql);
                 const plan = this._optimizeSelect(parsed, isExplain, strMap);
                 res = this._executeSelectPlan(plan, strMap);
             }
             if (isExplain) {
                 // FORMAT JSON: 計画を 1 行の JSON 文字列で返す（ツール連携向け）
                 const out = explainJson ? [{ QUERY_PLAN: JSON.stringify(res.data) }] : res.data;
                 return { data: out, executionTime: (performance.now() - startTime).toFixed(2), scannedRows: res.affectedRows };
             }
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(insert|replace)\b/i.test(sql)) {
             const res = this._executeInsert(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^update/i.test(sql)) {
             const res = this._executeUpdate(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^delete/i.test(sql)) {
             const res = this._executeDelete(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^merge\s+into\b/i.test(sql)) {
             // MERGE INTO ... USING ... ON ... WHEN MATCHED/NOT MATCHED（Oracle/SQL Server/標準 UPSERT）
             const res = this._executeMerge(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^call\b/i.test(sql)) {
             const res = this._executeCall(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^show\b/i.test(sql)) {
             const res = this._executeShow(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(describe|desc)\b/i.test(sql)) {
             const res = this._executeDescribe(sql);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^set\s+@/i.test(sql)) {
             const res = this._executeSetVar(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(create|drop)\s+schema\b/i.test(sql)) {
             // 単一スキーマ (main) のみのため、CREATE/DROP SCHEMA は受理して記録するに留める。
             // 実DB向けスクリプトをそのまま流せるようにするための互換措置
             const sm = sql.match(/^(create|drop)\s+schema\s+(if\s+not\s+exists\s+|if\s+exists\s+)?([a-zA-Z0-9_]+)/i);
             if (!sm) throw new Error("Syntax Error. Use CREATE|DROP SCHEMA [IF [NOT] EXISTS] <name>.");
             const nm = sm[3].toLowerCase();
             this.schemas = this.schemas || Object.create(null);
             if (sm[1].toLowerCase() === 'create') this.schemas[nm] = true; else delete this.schemas[nm];
             resultSet = [{ Result: "Success", Message: `Schema '${nm}' ${sm[1].toLowerCase() === 'create' ? 'created' : 'dropped'} (LuminaDB uses a single schema; objects live in 'main').` }];
          }
          else if (/^pragma\b/i.test(sql)) {
             // SQLite 互換の PRAGMA（table_info / index_list / user_version 等）
             const res = this._executePragma(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^declare\s+@/i.test(sql)) {
             // T-SQL の DECLARE @x [type] [= 値]: ユーザー変数の宣言（初期値なしは NULL）
             const dm = sql.match(/^declare\s+@([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+[a-zA-Z][a-zA-Z0-9_]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)?(?:\s*=\s*([\s\S]+))?$/i);
             if (!dm) throw new Error("Syntax Error in DECLARE. Use DECLARE @name [type] [= <expression>].");
             const res = this._executeSetVar(`SET @${dm[1]} = ${dm[2] !== undefined ? dm[2] : 'NULL'}`, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(create|drop|restore)\s+snapshot\b/i.test(sql)) {
             // メモリ内スナップショット（タイムトラベル）: CREATE / RESTORE / DROP SNAPSHOT
             const res = this._executeSnapshot(sql);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          // 否定先読みは修飾語の前に置く（後ろに置くと SET SESSION TRANSACTION ... のとき
          // 「修飾語なし」へバックトラックして一致してしまう）
          else if (/^set\s+(?!(?:session\s+|local\s+|global\s+)?transaction\b)(?:session\s+|local\s+|global\s+)?[a-zA-Z_@]/i.test(sql)) {
             // セッション変数: SET [SESSION] statement_timeout = 500 / read_only = ON など
             const res = this._executeSetSessionVar(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(reindex|checkpoint|flush|cluster|deallocate\s+all)\b/i.test(sql)) {
             // 保守系コマンド。LuminaDB はインメモリなので実効を持たないが、
             // 実DB向けスクリプトをそのまま流せるよう受理する（VACUUM だけは実処理あり）
             const verb = sql.match(/^[a-zA-Z_]+/)[0].toUpperCase();
             resultSet = [{ Result: "Success", Message: `${verb} accepted (no-op: LuminaDB keeps everything in memory; use VACUUM to compact).` }];
          }
          else if (/^(set\s+(session\s+|local\s+)?transaction\b|lock\s+tables?\b|unlock\s+tables?\b|grant\b|revoke\b|comment\s+on\b|analyze\b(?!\s+table)|discard\b)/i.test(sql)) {
             // セッション制御・権限系: 単一ユーザーのブラウザ内DBでは意味を持たないが、
             // 実DB向けスクリプトをそのまま流せるよう受理して記録のみ行う（COMMENT ON は保存する）
             const res = this._executeSessionStatement(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^values\s*\(/i.test(sql)) {
             // 表値コンストラクタ (VALUES (1, 'a'), (2, 'b')): 列名は column1..N
             const res = this._executeValuesStatement(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(prepare|execute|deallocate)\b/i.test(sql)) {
             // プリペアドステートメント: PREPARE name FROM '...' / EXECUTE name [USING ...] / DEALLOCATE
             const res = this._executePrepared(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(check|analyze)\s+table\b/i.test(sql)) {
             // CHECK TABLE: 制約の整合性検査 / ANALYZE TABLE: 列統計レポート
             const res = this._executeTableMaintenance(sql);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^table\s+/i.test(sql)) {
             // MySQL 8 の TABLE 文: SELECT * FROM の短縮形（ORDER BY / LIMIT / OFFSET 可）
             const tm = sql.match(/^table\s+([a-zA-Z0-9_]+)([\s\S]*)$/i);
             const tail = tm ? tm[2] : null;
             if (!tm || !/^(\s+order\s+by\s+[a-zA-Z0-9_\s,]+?)?(\s+limit\s+\d+(?:\s*,\s*\d+)?)?(\s+offset\s+\d+)?\s*$/i.test(tail)) {
                 throw new Error("Syntax Error in TABLE. Use TABLE <name> [ORDER BY col [ASC|DESC]] [LIMIT n] [OFFSET n].");
             }
             let tsql = this.expandViews(`SELECT * FROM ${tm[1]}${tail}`, strMap);
             tsql = this.expandSubqueries(tsql, strMap);
             const parsed = this._parseSelect(tsql);
             const plan = this._optimizeSelect(parsed, false, strMap);
             const res = this._executeSelectPlan(plan, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^refresh\s+materialized\s+view\b/i.test(sql)) {
             // REFRESH MATERIALIZED VIEW <name>: 定義クエリを再実行して実体を差し替える
             const res = this._refreshMatView(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^(create|truncate|drop|alter|rename|optimize|vacuum)/i.test(sql)) {
             const res = this._executeDDL(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows || 0;
          }
          else {
             throw new Error("Syntax Error or Unsupported Command.");
          }

        } catch (e) {
          if (!isSubquery) this.cleanupTempTables();
          if (isTopLevel) { this._deadline = 0; this._recordProfile(rawSql, startTime, -1, e.message); }
          return { error: e.message };
        }

        if (!isSubquery) this.cleanupTempTables();

        const executionTime = performance.now() - startTime;
        if (isTopLevel) { this._deadline = 0; this._recordProfile(rawSql, startTime, resultSet ? resultSet.length : 0, null); }
        return {
          data: resultSet,
          executionTime: Math.max(0.01, executionTime).toFixed(2),
          scannedRows: affectedRows
        };
      }

      // 実行時間の上限チェック。行ループの内側から一定間隔で呼ばれる。
      // ブラウザではクエリが UI スレッドを止めるため、暴走を確実に切る手段が要る
      _checkDeadline() {
          if (this._deadline && performance.now() > this._deadline) {
              const ms = this.statementTimeoutMs;
              this._deadline = 0;
              const e = new Error(`Statement timeout: query exceeded ${ms} ms (SET statement_timeout = 0 to disable).`);
              e.__fatal = true;   // DECLARE HANDLER で捕まえられない（時間上限の保証を守るため）
              throw e;
          }
      }

      // 行ループ用の軽量な期限チェッカを作る。statement_timeout 未設定なら
      // 何もしないクロージャを返すので、既定経路のコストは実質ゼロ。
      // 1024 行ごとにだけ時刻を読む（performance.now() を毎行呼ぶと逆に遅くなる）
      _mkTick() {
          const dl = this._deadline;
          if (!dl) return function () {};
          const ms = this.statementTimeoutMs;
          let n = 0;
          return function () {
              if ((++n & 1023) !== 0) return;
              if (performance.now() > dl) {
                  const e = new Error(`Statement timeout: query exceeded ${ms} ms (SET statement_timeout = 0 to disable).`);
                  e.__fatal = true;
                  throw e;
              }
          };
      }

      // 読み取り専用モードで許可する文かどうか（WITH 句は本体の文種で判定する）
      _isReadOnlyStatement(sql) {
          let s = String(sql).trim();
          if (/^with\s/i.test(s)) {
              const bodyIdx = s.toLowerCase().lastIndexOf(')');
              if (bodyIdx !== -1) s = s.slice(bodyIdx + 1).trim();
          }
          // PRAGMA は参照形（'=' を含まない）だけ許可する（PRAGMA user_version = n は書き込み）
          if (/^pragma\b/i.test(s)) return !/=/.test(s);
          // SELECT ... INTO <table> は新しい表を作るので参照系ではない
          if (/^select\b[\s\S]*?\s+into\s+[a-zA-Z0-9_]+\s+from\b/i.test(s)) return false;
          return /^(select|explain|show|describe|desc|table|values|check|analyze\s+table|use\b)/i.test(s);
      }

      // 直近クエリのプロファイルを記録し、閾値を超えたものは slowLog へ積む
      _recordProfile(sql, startTime, rows, error) {
          const ms = performance.now() - startTime;
          const text = String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
          this.lastProfile = { sql: text, ms: Number(ms.toFixed(3)), rows, error: error || null };
          if (ms >= this.slowLogThresholdMs || error) {
              this.slowLog.push(this.lastProfile);
              if (this.slowLog.length > 100) this.slowLog.shift();
          }
      }
    }
