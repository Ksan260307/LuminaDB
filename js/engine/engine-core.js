    // ============================================================================
    // [DatabaseEngine Core] - コンストラクタ / 初期データ / クエリディスパッチ
    // 各機能メソッドは engine-*.js で prototype 拡張として定義される
    // ============================================================================
    class DatabaseEngine {
      constructor() {
        // テーブル/ビュー/プロシージャ名（SQL由来の文字列）をキーにするため null プロトタイプで
        // 生成する（'__proto__' や 'constructor' という名前による汚染・誤ヒットを防ぐ）
        this.tables = Object.create(null);
        this.views = Object.create(null);
        this.procedures = Object.create(null);
        this.inTransaction = false;
        this.undoLog = [];
        this._initDefaultData();
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
            sql = this._maskStrings(sql, strMap);
        }

        let isExplain = false;
        if (/^explain\s+/i.test(sql)) {
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

          // CREATE VIEW / PROCEDURE の本体は定義として保存するため事前展開しない
          if (!isSubquery && !/^create\s+(or\s+replace\s+)?(view|procedure)\b/i.test(sql)) {
              sql = this.expandViews(sql, strMap);
              sql = this.expandSubqueries(sql, strMap);
          }

          if (/^(begin|start|commit|rollback|savepoint|release)/i.test(sql)) {
             const res = this._executeTransaction(sql);
             resultSet = res.data;
          }
          else if (/^select/i.test(sql)) {
             const unionSegments = this._splitUnion(sql);
             let res;
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
