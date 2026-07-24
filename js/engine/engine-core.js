    // ============================================================================
    // [DatabaseEngine Core] - コンストラクタ / 初期データ / クエリディスパッチ
    // 各機能メソッドは engine-*.js で prototype 拡張として定義される
    // ============================================================================
    // エンジンバージョン（VERSION() 関数 / SHOW STATUS / 外部APIが参照する）
    var LUMINA_VERSION = '1.10.0';

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
        if (!isSubquery && !strMap) {
            strMap = [];
            // 相関サブクエリのレジストリは文単位（コンパイル済み式が実行中に参照する）
            this._corrSubs = [];
            sql = this._maskStrings(sql, strMap);
        }

        let isExplain = false;
        let isAnalyze = false;
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

          // CREATE VIEW / PROCEDURE / TRIGGER の本体は定義として保存するため事前展開しない
          if (!isSubquery && !/^create\s+(or\s+replace\s+)?(view|procedure|trigger)\b/i.test(sql)) {
              sql = this.expandViews(sql, strMap);
              sql = this.expandTableFunctions(sql, strMap);
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
                 return { data: res.data, executionTime: (performance.now() - startTime).toFixed(2), scannedRows: res.affectedRows };
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
          else if (/^call\b/i.test(sql)) {
             const res = this._executeCall(sql);
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
          return { error: e.message };
        }

        if (!isSubquery) this.cleanupTempTables();

        const executionTime = performance.now() - startTime;
        return {
          data: resultSet,
          executionTime: Math.max(0.01, executionTime).toFixed(2),
          scannedRows: affectedRows
        };
      }
    }
