    // ============================================================================
    // [Test Suite v31] - v1.26 の修正・追加のテスト
    //
    //   v1.25 で「未対応」として残した 2 件を片付けた回:
    //     1. 区切り識別子。バッククォート `x` を MySQL 形式の識別子として受理する
    //        （従来は素通しで、`` `order` `` という列名が作られたり
    //          `` `col name` `` が `` `col `` に切れたりしていた＝黙って壊れる）。
    //        ダブルクォートは MySQL 既定どおり文字列リテラルのままで、
    //        表名の位置に来たときは「バッククォートを使え」と案内する
    //     2. GROUPING SETS の中の ROLLUP / CUBE / 入れ子 GROUPING SETS
    //   加えて:
    //     - exportSQL がトリガー・関数・プロシージャ・コメントを落としていた
    //       （SQL ダンプがスキーマの完全なバックアップになっていなかった）
    //     - 索引は登録名で書き出し、PK/UNIQUE 由来の暗黙索引は重ねて出さない
    //   フロントエンド:
    //     - スキーマツリーの右クリックメニュー（データ閲覧 / 件数 / DDL / 列一覧 /
    //       プロファイル / スキーマ編集 / 表名コピー / 削除の下書き）
    //
    //   test-suite.js の tests 配列へ getV31Tests() のスプレッドで合流する
    // ============================================================================
    function getV31Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one } = makeTestKit('V31');
      const cols = (t) => db.tables[t].getColumnNames();

      // ============================================================
      // 1. バッククォートの区切り識別子
      // ============================================================
      fn('V31Id reserved words become usable as column names', () => {
        db.executeQuery("DROP TABLE IF EXISTS v31_q");
        const r = db.executeQuery("CREATE TABLE v31_q (`order` INTEGER, `select` TEXT, plain INTEGER)");
        return !r.error && cols('v31_q').join(',') === 'order,select,plain';
      });
      fn('V31Id backticks are stripped from the stored name', () =>
        db.tables.v31_q.cols['order'] !== undefined && db.tables.v31_q.cols['`order`'] === undefined);
      fn('V31Id insert and select through backticks', () => {
        const i = db.executeQuery("INSERT INTO v31_q (`order`, `select`) VALUES (1, 'a')");
        const s = db.executeQuery("SELECT `order`, `select` FROM v31_q");
        return !i.error && !s.error && s.data[0]['order'] === 1 && s.data[0]['select'] === 'a';
      });
      fn('V31Id backticks work in where clauses', () =>
        one("SELECT COUNT(*) FROM v31_q WHERE `order` = 1") === 1);
      fn('V31Id backticked table names work', () => {
        db.executeQuery("DROP TABLE IF EXISTS v31_bt");
        const c = db.executeQuery("CREATE TABLE `v31_bt` (a INTEGER)");
        const i = db.executeQuery("INSERT INTO `v31_bt` VALUES (7)");
        return !c.error && !i.error && one("SELECT a FROM `v31_bt`") === 7;
      });
      fn('V31Id doubled backticks are one character', () => {
        // `` は名前中の 1 文字。ここでは識別子として不正なので明示エラーになる
        const r = db.executeQuery("CREATE TABLE v31_dbl (`a``b` INTEGER)");
        return !!r.error && /not usable/i.test(r.error);
      });
      err('V31Id names with spaces are refused', "CREATE TABLE v31_sp (`col name` INTEGER)", 'not usable');
      err('V31Id names starting with a digit are refused', "SELECT `1col` FROM v31_q", 'not usable');
      err('V31Id an unterminated backtick is reported', "SELECT `order FROM v31_q", 'not closed');
      fn('V31Id backticks inside string literals are untouched', () =>
        one("SELECT 'has ` tick' AS s") === 'has ` tick');
      fn('V31Id a double quoted value is still a string', () =>
        one('SELECT "plain text" AS s') === 'plain text');
      err('V31Id a double quoted table name is explained', 'CREATE TABLE "my tbl" (a INTEGER)', 'backticks');
      fn('V31Id an invalid identifier does not throw out of executeQuery', () => {
        // 例外ではなく結果オブジェクトのエラーとして返ること（呼び出し側が壊れない）
        let threw = false;
        let r;
        try { r = db.executeQuery("SELECT `bad name` FROM v31_q"); } catch (e) { threw = true; }
        return !threw && !!r.error;
      });

      // ============================================================
      // 2. GROUPING SETS の入れ子
      // ============================================================
      fn('V31Gs fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v31_gs");
        db.executeQuery("CREATE TABLE v31_gs (a TEXT, b TEXT, v INTEGER)");
        db.executeQuery("INSERT INTO v31_gs VALUES ('x','p',1),('x','q',2),('y','p',3)");
        return db.tables.v31_gs.rowCount === 3;
      });
      const sig = (sql) => {
        const r = db.executeQuery(sql);
        if (r.error) return 'ERR:' + r.error;
        return r.data.map(x => `${x.a === null ? '-' : x.a}/${x.b === undefined ? '' : (x.b === null ? '-' : x.b)}=${x.s}`).join(' ');
      };
      fn('V31Gs rollup nested in grouping sets', () => {
        const s = sig("SELECT a, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS (ROLLUP(a)) ORDER BY a");
        return s === '-/=6 x/=3 y/=3';
      });
      fn('V31Gs cube nested in grouping sets', () => {
        const r = db.executeQuery("SELECT a, b, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS (CUBE(a,b))");
        // {a,b}=3 行 + {a}=2 + {b}=2 + {}=1 の計 8 行
        return !r.error && r.data.length === 8;
      });
      fn('V31Gs a plain set combined with rollup', () => {
        const r = db.executeQuery("SELECT a, b, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS ((a,b), ROLLUP(a))");
        // (a,b) の 3 行 + ROLLUP(a) の {a} 2 行と {} 1 行
        return !r.error && r.data.length === 6 && r.data.some(x => x.a === null && x.b === null && x.s === 6);
      });
      fn('V31Gs grouping sets nested in grouping sets', () => {
        const s = sig("SELECT a, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS (GROUPING SETS ((a)), ()) ORDER BY a");
        return s === '-/=6 x/=3 y/=3';
      });
      fn('V31Gs plain grouping sets still work', () => {
        const s = sig("SELECT a, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS ((a), ()) ORDER BY a");
        return s === '-/=6 x/=3 y/=3';
      });
      fn('V31Gs plain rollup and cube still work', () => {
        const r1 = db.executeQuery("SELECT a, SUM(v) AS s FROM v31_gs GROUP BY ROLLUP(a)");
        const r2 = db.executeQuery("SELECT a, b, SUM(v) AS s FROM v31_gs GROUP BY CUBE(a,b)");
        return !r1.error && r1.data.length === 3 && !r2.error && r2.data.length === 8;
      });
      fn('V31Gs grouping() still reports the nulled columns', () => {
        const r = db.executeQuery("SELECT a, GROUPING(a) AS g, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS (ROLLUP(a)) ORDER BY g, a");
        return !r.error && r.data.some(x => x.g === 1 && x.a === null) && r.data.some(x => x.g === 0);
      });
      err('V31Gs an empty rollup inside is refused', "SELECT a, SUM(v) AS s FROM v31_gs GROUP BY GROUPING SETS (ROLLUP())", 'requires at least one');

      // ============================================================
      // 3. SQL ダンプの完全性
      // ============================================================
      fn('V31Ex fixture with every kind of object', () => {
        ['v31_x'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        db.executeQuery("DROP VIEW IF EXISTS v31_view");
        db.executeQuery("DROP SEQUENCE IF EXISTS v31_seq");
        db.executeQuery("DROP TRIGGER IF EXISTS v31_trig");
        db.executeQuery("DROP FUNCTION IF EXISTS v31_fn");
        db.executeQuery("DROP PROCEDURE IF EXISTS v31_proc");
        db.executeQuery("CREATE TABLE v31_x (id INTEGER PRIMARY KEY, v INTEGER)");
        db.executeQuery("INSERT INTO v31_x VALUES (1,10)");
        db.executeQuery("CREATE INDEX v31_ix ON v31_x (v)");
        db.executeQuery("CREATE VIEW v31_view AS SELECT id FROM v31_x");
        db.executeQuery("CREATE SEQUENCE v31_seq START 5");
        db.executeQuery("CREATE TRIGGER v31_trig AFTER INSERT ON v31_x FOR EACH ROW UPDATE v31_x SET v = v");
        db.executeQuery("CREATE FUNCTION v31_fn(x INTEGER) RETURNS INTEGER AS RETURN x * 2");
        db.executeQuery("CREATE PROCEDURE v31_proc() BEGIN SELECT 1; END");
        db.executeQuery("COMMENT ON TABLE v31_x IS 'note'");
        return !!db.tables.v31_x && !!db.triggers.v31_trig;
      });
      fn('V31Ex dump contains triggers', () => db.exportSQL().includes('CREATE TRIGGER v31_trig'));
      fn('V31Ex dump contains functions', () => db.exportSQL().includes('CREATE FUNCTION v31_fn'));
      fn('V31Ex dump contains procedures', () => db.exportSQL().includes('CREATE PROCEDURE v31_proc'));
      fn('V31Ex dump contains comments', () => /COMMENT ON TABLE v31_x IS/.test(db.exportSQL()));
      fn('V31Ex dump keeps views and sequences', () => {
        const d = db.exportSQL();
        return d.includes('CREATE VIEW v31_view') && d.includes('CREATE SEQUENCE v31_seq');
      });
      fn('V31Ex dump uses the real index name', () => db.exportSQL().includes('CREATE INDEX v31_ix ON v31_x'));
      fn('V31Ex dump omits the implicit primary key index', () => !db.exportSQL().includes('idx_v31_x_id'));
      fn('V31Ex the dump replays into a clean database', () => {
        // 共有 DB には他スイートの表が積み上がっているので、往復は
        // 「この回で作った種類のオブジェクトだけを持つ専用エンジン」で検証する
        const src = new DatabaseEngine();
        [
          "CREATE TABLE rx (id INTEGER PRIMARY KEY, v INTEGER)",
          "INSERT INTO rx VALUES (1,10)",
          "CREATE INDEX rx_ix ON rx (v)",
          "CREATE VIEW rx_view AS SELECT id FROM rx",
          "CREATE SEQUENCE rx_seq START 5",
          "CREATE TRIGGER rx_trig AFTER INSERT ON rx FOR EACH ROW UPDATE rx SET v = v",
          "CREATE FUNCTION rx_fn(x INTEGER) RETURNS INTEGER AS RETURN x * 2",
          "CREATE PROCEDURE rx_proc() BEGIN SELECT 1; END",
          "COMMENT ON TABLE rx IS 'note'"
        ].forEach(s => src.executeQuery(s));
        const dump = src.exportSQL();
        const fresh = new DatabaseEngine();
        // 依存の子から先に落とす。orders が users / products を参照しているので、
        // 親から落とすと外部キーに阻まれて残り、ダンプの CREATE TABLE が衝突する
        ['orders', 'users', 'products'].forEach(t => fresh.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        const res = fresh.executeScript(dump);
        return res.succeeded === res.total
            && !!fresh.views.rx_view && !!fresh.sequences.rx_seq && !!fresh.triggers.rx_trig
            && !!fresh.functions.rx_fn && !!fresh.procedures.rx_proc
            && fresh.comments['table:rx'] === 'note'
            && fresh.executeQuery("SELECT v FROM rx WHERE id = 1").data[0].v === 10;
      });

      // ============================================================
      // 4. フロントエンド: 表の右クリックメニュー
      // ============================================================
      const ctxOpen = (t) => {
        renderTree();
        const btn = document.querySelector(`.table-select-btn[data-table="${t}"]`);
        btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
        return [...document.querySelectorAll('#treeMenu button')];
      };
      fn('V31Ui right click opens a menu', () => {
        const items = ctxOpen('v31_x');
        return items.length >= 7 && !document.getElementById('treeMenu').classList.contains('hidden');
      });
      fn('V31Ui the menu offers the expected actions', () => {
        const labels = ctxOpen('v31_x').map(b => b.textContent);
        return labels.some(l => l.includes('データを見る')) && labels.some(l => l.includes('件数'))
            && labels.some(l => l.includes('DDL')) && labels.some(l => l.includes('表を削除'));
      });
      fn('V31Ui show ddl runs and closes the menu', () => {
        ctxOpen('v31_x').find(b => b.textContent.indexOf('DDL') !== -1).click();
        const k = currentResultData && currentResultData[0] ? Object.keys(currentResultData[0]) : [];
        return k.join(',') === 'Table,CreateTable'
            && document.getElementById('treeMenu').classList.contains('hidden');
      });
      fn('V31Ui count rows runs the query', () => {
        ctxOpen('v31_x').find(b => b.textContent.indexOf('件数') !== -1).click();
        return currentResultData[0].rows === 1;
      });
      fn('V31Ui browse data runs a limited select', () => {
        ctxOpen('v31_x').find(b => b.textContent.indexOf('データを見る') !== -1).click();
        return currentResultData.length === 1 && currentResultData[0].id === 1;
      });
      fn('V31Ui describe lists the columns', () => {
        ctxOpen('v31_x').find(b => b.textContent.indexOf('列の一覧') !== -1).click();
        return currentResultData.length === 2 && currentResultData[0].Column === 'id';
      });
      fn('V31Ui drop only stages the statement', () => {
        ctxOpen('v31_x').find(b => b.textContent.indexOf('表を削除') !== -1).click();
        // エディタへ入れるだけで実行はしない（取り返しのつかない操作なので）
        return els.query.value === 'DROP TABLE v31_x' && !!db.tables.v31_x;
      });
      fn('V31Ui escape closes the menu', () => {
        ctxOpen('v31_x');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return document.getElementById('treeMenu').classList.contains('hidden');
      });
      fn('V31Ui clicking elsewhere closes the menu', () => {
        ctxOpen('v31_x');
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return document.getElementById('treeMenu').classList.contains('hidden');
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V31Cl drop objects', () => {
        db.executeQuery("DROP TRIGGER IF EXISTS v31_trig");
        db.executeQuery("DROP FUNCTION IF EXISTS v31_fn");
        db.executeQuery("DROP PROCEDURE IF EXISTS v31_proc");
        db.executeQuery("DROP VIEW IF EXISTS v31_view");
        db.executeQuery("DROP SEQUENCE IF EXISTS v31_seq");
        ['v31_x', 'v31_gs', 'v31_bt', 'v31_q'].forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        // COMMENT ON は表を消しても台帳に残るので明示的に外す
        db.executeQuery("COMMENT ON TABLE v31_x IS NULL");
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
