    // ============================================================================
    // [DatabaseEngine Core] - コンストラクタ / 初期データ / クエリディスパッチ
    // 各機能メソッドは engine-*.js で prototype 拡張として定義される
    // ============================================================================
    // エンジンバージョン（VERSION() 関数 / SHOW STATUS / 外部APIが参照する）
    var LUMINA_VERSION = '1.27.0';

    class DatabaseEngine {
      constructor() {
        // テーブル/ビュー/プロシージャ名（SQL由来の文字列）をキーにするため null プロトタイプで
        // 生成する（'__proto__' や 'constructor' という名前による汚染・誤ヒットを防ぐ）
        this.tables = Object.create(null);
        this.views = Object.create(null);
        this.procedures = Object.create(null);
        // トリガー定義: name -> { name, timing, event, table, statements }
        this.triggers = Object.create(null);
        // ビューの付随情報: name -> { checkOption: 'LOCAL'|'CASCADED' }。
        // 本体（SELECT文）は views 側に持つ。IDB保存対象
        this.viewMeta = Object.create(null);
        // ユーザー定義ドメイン / 列挙型: name -> { base, check, values }。
        // 列の型として使うと基底型へ展開し、CHECK / 値集合を列制約として付ける。IDB保存対象
        this.domains = Object.create(null);
        // ロール・ユーザー（LuminaDB に認証機構は無い。移行スクリプトを通すための名簿）。
        // IDB保存対象外（セッション限り）
        this.roles = Object.create(null);
        // 外部キー検査の有効/無効（SET FOREIGN_KEY_CHECKS = 0|1）。セッション限りで
        // IDB 保存対象外。相互参照する表への初回投入や一括取り込みのための逃げ道で、
        // 1 に戻すときに全表を検査し直すので不整合が残ったままにはならない
        this.fkChecksEnabled = true;
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
        // 文単位の警告。SHOW WARNINGS がこれを読む（その文自身ではリセットしない）
        this._warnings = [];
        this._isShowWarnings = false;
        this._attachEngineRef();
        this._initDefaultData();
      }

      // バッククォート識別子 `x` を素の x へ戻す（MySQL 形式の区切り識別子）。
      // 主用途は「予約語を列名・表名に使う」こと（`order` / `select` など）。
      // LuminaDB の識別子は英数字とアンダースコアなので、それ以外の文字を含む名前は
      // 受理せず明示エラーにする（黙って別名を作るより判るほうがよい）。
      // 二重バッククォート ``` `` ``` は名前中の 1 文字として扱う（MySQL と同じ）
      // エラーメッセージに内部トークンが残っていたら、人が読める形へ直す。
      //
      // 文字列を退避した後の SQL でエラーを組み立てる箇所が多数あるため、
      // `SELECT * FROM "some table"` が `Table '__str_0__' not found.` になっていた
      // （ダブルクォートは MySQL 既定どおり文字列リテラルなので表名にはならない）。
      // 個々の throw を全部直すのは漏れるので、最後の出口で一括して言い換える
      _humanizeError(msg, strMap) {
          if (!msg || msg.indexOf('__str_') === -1 && msg.indexOf('__STR_') === -1) return msg;
          let out = msg.replace(/__STR_(\d+)__/gi, (m, i) => {
              const lit = strMap && strMap[Number(i)];
              return lit === undefined ? m : this._unquoteLiteral(lit);
          });
          // ダブルクォートの意味を説明する。バックティックは「予約語を識別子として
          // 使う」ためのもので、空白入りの名前を許すわけではない（識別子は
          // [a-zA-Z_][a-zA-Z0-9_]* のみ）ので、そこまで含めて正確に案内する
          if (/not found/i.test(msg)) {
              out += ' (Note: "..." is a string literal in LuminaDB, as in MySQL — it is not an identifier.'
                  + ' Use a bare name, or backticks if the name is a reserved word (`order`).'
                  + ' Identifiers may contain only letters, digits and underscores.)';
          }
          return out;
      }

      _unquoteBacktickIdents(sql) {
          let out = '', i = 0;
          while (i < sql.length) {
              if (sql[i] !== '`') { out += sql[i]; i++; continue; }
              let j = i + 1, name = '';
              for (; j < sql.length; j++) {
                  if (sql[j] !== '`') { name += sql[j]; continue; }
                  if (sql[j + 1] === '`') { name += '`'; j++; continue; }
                  break;
              }
              if (j >= sql.length) throw new Error("Unterminated quoted identifier: a '`' is not closed.");
              if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                  throw new Error(`Quoted identifier '${name}' is not usable: LuminaDB identifiers may contain only letters, digits and underscores, and cannot start with a digit.`);
              }
              out += name;
              i = j + 1;
          }
          return out;
      }

      // `ALTER TABLE t <action>, <action>` を個別の ALTER 文の配列へ分解する。
      // 分解できない（単一アクション／すべての断片がアクション動詞で始まらない）ときは
      // null を返し、従来どおり 1 文として処理させる。
      // カンマは括弧の外側だけを数える（`ADD PRIMARY KEY (a, b)` を割らないため）
      _splitAlterActions(sql) {
          const head = sql.match(/^alter\s+table\s+(?:if\s+exists\s+)?[a-zA-Z0-9_]+\s+/i);
          if (!head) return null;
          const body = sql.slice(head[0].length);
          const parts = [];
          let cur = '', depth = 0;
          for (const ch of body) {
              if (ch === '(' || ch === '[') depth++;
              else if (ch === ')' || ch === ']') depth--;
              if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
              else cur += ch;
          }
          parts.push(cur.trim());
          if (parts.length < 2) return null;
          const ACTION = /^(add|drop|modify|change|alter|rename|set|reset|enable|disable|validate|owner|inherit|no)\b/i;
          if (!parts.every(p => p !== '' && ACTION.test(p))) return null;
          return parts.map(p => head[0] + p);
      }

      // 致命的でない問題を「警告」として記録する。エラーと違い実行は続行し、
      // 直後の SHOW WARNINGS と結果オブジェクトの warnings で確認できる
      // （黙って成功したように見える操作を可視化するのが狙い）
      _warn(code, message) {
          if (!this._warnings) this._warnings = [];
          // 同一文中の重複は 1 件にまとめ、総数は上限で打ち切る（暴走防止）
          if (this._warnings.length >= 64) return;
          if (this._warnings.some(w => w.Code === code && w.Message === message)) return;
          this._warnings.push({ Level: 'Warning', Code: code, Message: message });
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
            // 警告も文単位。ただし SHOW WARNINGS / SHOW COUNT(*) WARNINGS は
            // 「直前の文」の警告を読む文なので、この 2 つだけはリセットしない（MySQL と同じ）
            this._isShowWarnings = /^\s*show\s+(?:count\s*\(\s*\*\s*\)\s+)?warnings\b/i.test(sql);
            if (!this._isShowWarnings) this._warnings = [];
            // ここはまだ try の外なので、投げると呼び出し側へ生の JS 例外が漏れる。
            // _maskStrings は 16 進リテラルの桁数不正で throw し得るため包む
            try { sql = this._maskStrings(sql, strMap); }
            catch (e) { return { error: e.message }; }
            // バッククォートで囲んだ識別子（MySQL 形式）を素の識別子へ戻す。
            // 文字列を退避した後に行うので、データ中のバッククォートには触らない。
            // 従来は素通しで、`` `order` `` という列名がそのまま作られたり
            // `` `col name` `` が `` `col `` に切れたりしていた（黙って壊れる）
            // 不正な区切り識別子はエラー結果として返す（この時点はまだ try の外なので、
            // 例外のまま投げると呼び出し側へ生の JS 例外として漏れる）
            if (sql.indexOf('`') !== -1) {
                try { sql = this._unquoteBacktickIdents(sql); }
                catch (e) { return { error: e.message }; }
            }
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
          // 集合演算の枝を括弧で包む書き方 `(SELECT ...) UNION (SELECT ...)` や、
          // 文全体を括弧で包んだ `(SELECT ...)` を括弧無しの等価な形へ正規化する。
          // サブクエリ展開より前に行うこと（後だと枝が派生表として実体化されてしまう）
          if (!isSubquery && /^\(\s*(?:select|with)\b/i.test(sql)) {
              const segs0 = this._splitUnion(sql);
              sql = segs0.map((s2, i) => (i === 0 ? '' : s2.op + ' ') + s2.sql).join(' ').trim();
          }

          // 単一スキーマ (main / public) の修飾は取り除いて素の表名にする
          if (/\b(?:main|public)\s*\.\s*[a-zA-Z_]/i.test(sql)) {
              sql = sql.replace(/\b(?:main|public)\s*\.\s*(?=[a-zA-Z_])/gi, '');
          }

          // 複数表 UPDATE/DELETE（... FROM src / ... USING src / ... JOIN src）は
          // サブクエリ展開の前に単一表＋相関サブクエリの形へ書き換える
          if (!isSubquery && /^(update|delete)\b/i.test(sql)) {
              // 派生表のソース（FROM (VALUES ...) / FROM (SELECT ...)）を先に実体化してから
              // 単一表＋相関サブクエリの形へ書き換える
              sql = this._materializeDmlSources(sql, strMap);
              sql = this._rewriteMultiTableDml(sql);
          }

          // SHOW 文の FROM はメタデータの対象指定（`SHOW COLUMNS FROM v` / `SHOW TRIGGERS FROM v`）
          // であってクエリのデータ源ではない。ビュー展開に通すと名前が SELECT へ
          // 書き換わって対象が特定できなくなるため除外する
          // CHECK 制約・DEFAULT 式の中のサブクエリは、この後の expandSubqueries が
          // 「定義した瞬間の結果」へ畳み込んでしまう。畳み込まれた式はそのまま
          // スキーマへ保存されるので、後から親表が変わっても追従せず、
          // 正しい行を拒否し・不正な行を通す（両方向に誤る）。実DBはどれも
          // 定義時に拒否するので、こちらも拒否する。CTAS の AS SELECT は対象外
          if (!isSubquery
              && /^create\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+)?table\b/i.test(sql)
              && !/\bas\s+select\b/i.test(sql)
              && /\(\s*select\b/i.test(sql)) {
              throw new Error("A CHECK constraint or DEFAULT expression cannot contain a subquery. Use a FOREIGN KEY constraint or a trigger instead.");
          }
          if (!isSubquery
              && /^alter\s+table\b/i.test(sql)
              && /\bcheck\s*\([\s\S]*\(\s*select\b/i.test(sql)) {
              throw new Error("A CHECK constraint cannot contain a subquery. Use a FOREIGN KEY constraint or a trigger instead.");
          }
          if (!isSubquery
              && !/^create\s+(or\s+replace\s+)?(view|procedure|trigger|function)\b/i.test(sql)
              && !/^show\b/i.test(sql)
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
          // 素の EXPLAIN も SELECT 以外は拒否する。isExplain は SELECT の分岐でしか
          // 見ていなかったため、`EXPLAIN DELETE FROM t` や `EXPLAIN DROP TABLE t` が
          // **計画ではなく本体を実行**していた（実DBはどれも実行しない）。
          // ここは各ディスパッチ分岐より前なので、まだ何も書き換わっていない
          if (isExplain && !/^select/i.test(sql) && !/^\(\s*(?:select|with)\b/i.test(sql)) {
              throw new Error("EXPLAIN supports SELECT statements only.");
          }

          if (/^(begin|start|commit|rollback|savepoint|release)/i.test(sql)) {
             const res = this._executeTransaction(sql);
             resultSet = res.data;
          }
          else if (/^select/i.test(sql) || /^\(\s*(?:select|with)\b/i.test(sql)) {
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
             // 対象がビューなら基底表への書き換え経路（更新可能ビュー）へ回す
             const res = this._viewDmlTarget('insert', sql)
                 ? this._executeViewDml('insert', sql, strMap)
                 : this._executeInsert(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^update/i.test(sql)) {
             const res = this._viewDmlTarget('update', sql)
                 ? this._executeViewDml('update', sql, strMap)
                 : this._executeUpdate(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows;
          }
          else if (/^delete/i.test(sql)) {
             const res = this._viewDmlTarget('delete', sql)
                 ? this._executeViewDml('delete', sql, strMap)
                 : this._executeDelete(sql, strMap);
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
             // ALTER TABLE t <action>, <action>, ... （カンマ区切りの複数アクション）は
             // 標準・MySQL・PostgreSQL いずれも認める形。個別アクションへ分解して順に適用する。
             // 従来は 1 つ目しか見ないか構文エラーになっていた
             const multi = this._splitAlterActions(sql);
             if (multi) {
                 const msgs = [];
                 for (const one of multi) {
                     const r = this._executeDDL(one, strMap);
                     (r.data || []).forEach(d => { if (d && d.Message) msgs.push(d.Message); });
                 }
                 resultSet = [{ Result: "Success", Message: msgs.join(' ') }];
                 affectedRows = 0;
             } else {
             const res = this._executeDDL(sql, strMap);
             resultSet = res.data;
             affectedRows = res.affectedRows || 0;
             // IF EXISTS / IF NOT EXISTS で何もしなかった DDL は「成功」を返すが、
             // 移行スクリプトでは取りこぼしに気づけない。警告として残す
             if (resultSet && resultSet.length === 1 && typeof resultSet[0].Message === 'string'
                 && /\bSkipped\.$/.test(resultSet[0].Message)) {
                 this._warn('DDL_NOOP', resultSet[0].Message);
             }
             }
          }
          else {
             throw new Error("Syntax Error or Unsupported Command.");
          }

        } catch (e) {
          if (!isSubquery) this.cleanupTempTables();
          const msg = this._humanizeError(e.message, strMap);
          if (isTopLevel) { this._deadline = 0; this._recordProfile(rawSql, startTime, -1, msg); }
          return this._warnings && this._warnings.length > 0
              ? { error: msg, warnings: this._warnings.slice() }
              : { error: msg };
        }

        if (!isSubquery) this.cleanupTempTables();

        const executionTime = performance.now() - startTime;
        if (isTopLevel) { this._deadline = 0; this._recordProfile(rawSql, startTime, resultSet ? resultSet.length : 0, null); }
        const out = {
          data: resultSet,
          executionTime: Math.max(0.01, executionTime).toFixed(2),
          scannedRows: affectedRows
        };
        // SHOW WARNINGS 自身の結果には（読み取った）警告を重ねて付けない
        if (!this._isShowWarnings && this._warnings && this._warnings.length > 0) out.warnings = this._warnings.slice();
        return out;
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
