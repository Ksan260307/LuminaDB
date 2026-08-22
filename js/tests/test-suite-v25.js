    // ============================================================================
    // [Test Suite v25] - v1.20 で追加した商用DB互換機能のテスト
    //
    //   バックエンド:
    //     - 連結系集計の引数内 ORDER BY（STRING_AGG / ARRAY_AGG / LISTAGG）
    //     - ORDER BY へのウィンドウ関数の直書き、WHERE/GROUP BY での明示拒否
    //     - UPDATE/DELETE の派生表ソース（FROM (VALUES ...) / FROM (SELECT ...)）
    //     - SELECT 句の集合返し関数（UNNEST / STRING_SPLIT / GENERATE_SERIES）
    //     - 中置整数除算 a DIV b
    //     - CREATE DOMAIN / CREATE TYPE AS ENUM（列制約として強制）
    //     - CREATE/DROP USER・ROLE と SHOW GRANTS（スクリプト互換）
    //     - TRUNCATE ... CONTINUE IDENTITY
    //     - 再帰CTE の SEARCH / CYCLE
    //     - IN (...) のインデックス活用
    //     - 別名なし定数列の命名（列順の入れ替わりと内部トークン露出の修正）
    //   フロントエンド:
    //     - 結果グリッドの行追加・行削除
    //     - クエリ履歴パネル（検索・読み込み）
    //
    //   test-suite.js の tests 配列へ getV25Tests() のスプレッドで合流する
    // ============================================================================
    function getV25Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one } = makeTestKit('V25');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V25Fx tables', () => {
        db.executeQuery("CREATE TABLE v25_e (id INTEGER PRIMARY KEY, dept TEXT, nm TEXT, sal INTEGER)");
        db.executeQuery("INSERT INTO v25_e VALUES (1,'Eng','a',100),(2,'Eng','b',300),(3,'Sales','c',200)");
        db.executeQuery("CREATE TABLE v25_tree (id INTEGER, pid INTEGER, nm TEXT)");
        db.executeQuery("INSERT INTO v25_tree VALUES (1,NULL,'root'),(2,1,'a'),(3,1,'b'),(4,2,'a1'),(5,2,'a2')");
        db.executeQuery("CREATE TABLE v25_g (a INTEGER, b INTEGER)");
        db.executeQuery("INSERT INTO v25_g VALUES (1,2),(2,3),(3,1)");
        return true;
      });

      // ============================================================
      // 1. 連結系集計の引数内 ORDER BY
      // ============================================================
      push('V25Agg string_agg ordered', "SELECT STRING_AGG(nm, ',' ORDER BY nm DESC) AS s FROM v25_e", r => r.data[0].s === 'c,b,a');
      push('V25Agg string_agg unordered', "SELECT STRING_AGG(nm, '-') AS s FROM v25_e", r => r.data[0].s === 'a-b-c');
      push('V25Agg string_agg order by other column', "SELECT STRING_AGG(nm, ',' ORDER BY sal DESC) AS s FROM v25_e", r => r.data[0].s === 'b,c,a');
      push('V25Agg array_agg ordered', "SELECT ARRAY_AGG(nm ORDER BY sal DESC) AS s FROM v25_e", r => r.data[0].s === '["b","c","a"]');
      push('V25Agg listagg ordered', "SELECT LISTAGG(nm, ',' ORDER BY nm DESC) AS s FROM v25_e", r => r.data[0].s === 'c,b,a');
      push('V25Agg group_concat separator still works', "SELECT GROUP_CONCAT(nm ORDER BY nm DESC SEPARATOR '|') AS s FROM v25_e", r => r.data[0].s === 'c|b|a');
      push('V25Agg ordered agg per group', "SELECT dept, STRING_AGG(nm, ',' ORDER BY sal) AS s FROM v25_e GROUP BY dept ORDER BY dept",
        r => r.data.length === 2 && r.data[0].s === 'a,b' && r.data[1].s === 'c');
      push('V25Agg statement order by unaffected', "SELECT STRING_AGG(nm, ',' ORDER BY nm) AS s FROM v25_e ORDER BY s", r => r.data[0].s === 'a,b,c');
      push('V25Agg within group still works', "SELECT LISTAGG(nm, '-') WITHIN GROUP (ORDER BY nm DESC) AS s FROM v25_e", r => r.data[0].s === 'c-b-a');

      // ============================================================
      // 2. ウィンドウ関数の位置
      // ============================================================
      push('V25Win order by window fn', "SELECT nm FROM v25_e ORDER BY ROW_NUMBER() OVER (ORDER BY sal DESC)",
        r => r.data.map(x => x.nm).join(',') === 'b,c,a');
      push('V25Win order by window fn then column', "SELECT nm FROM v25_e ORDER BY RANK() OVER (ORDER BY sal DESC), nm",
        r => r.data.map(x => x.nm).join(',') === 'b,c,a');
      // 並べ替えのための隠し列は出力に出さない
      push('V25Win hidden order column not exposed', "SELECT nm FROM v25_e ORDER BY ROW_NUMBER() OVER (ORDER BY sal)",
        r => Object.keys(r.data[0]).length === 1 && Object.keys(r.data[0])[0] === 'nm');
      push('V25Win alias order still works', "SELECT nm, ROW_NUMBER() OVER (ORDER BY sal) AS rn FROM v25_e ORDER BY rn DESC",
        r => r.data[0].rn === 3 && r.data[2].rn === 1);
      err('V25Win in where rejected', "SELECT nm FROM v25_e WHERE ROW_NUMBER() OVER () = 1", "not allowed in WHERE");
      err('V25Win in group by rejected', "SELECT dept FROM v25_e GROUP BY ROW_NUMBER() OVER ()", "not allowed in GROUP BY");
      err('V25Win distinct rejected', "SELECT COUNT(DISTINCT dept) OVER () AS c FROM v25_e", "DISTINCT is not supported inside a window function");
      push('V25Win distinct aggregate still works', "SELECT COUNT(DISTINCT dept) AS c FROM v25_e", r => r.data[0].c === 2);
      push('V25Win qualify still works', "SELECT nm FROM v25_e QUALIFY ROW_NUMBER() OVER (ORDER BY sal DESC) = 1", r => r.data.length === 1 && r.data[0].nm === 'b');
      // 未対応のウィンドウ関数は評価側の分岐に当たらず黙って NULL になっていた
      err('V25Win unsupported window fn rejected', "SELECT STRING_AGG(nm, ',') OVER () AS v FROM v25_e", "not supported as a window function");
      err('V25Win unknown window fn rejected', "SELECT NOPE_FN(nm) OVER () AS v FROM v25_e", "not supported as a window function");
      push('V25Win supported window aggregates still work', "SELECT SUM(sal) OVER () AS s, COUNT(*) OVER () AS c FROM v25_e",
        r => r.data[0].s === 600 && r.data[0].c === 3);
      push('V25Win ranking functions still work', "SELECT NTILE(2) OVER (ORDER BY sal) AS n FROM v25_e", r => r.data.length === 3);

      // ============================================================
      // 3. UPDATE / DELETE の派生表ソース
      // ============================================================
      fn('V25Dml update from values', () => {
        db.executeQuery("CREATE TABLE v25_u (id INTEGER, sal INTEGER)");
        db.executeQuery("INSERT INTO v25_u VALUES (1,100),(2,200),(3,300)");
        const r = db.executeQuery("UPDATE v25_u SET sal = v.s FROM (VALUES (1, 111), (2, 222)) AS v(i, s) WHERE v25_u.id = v.i");
        const rows = db.executeQuery("SELECT id, sal FROM v25_u ORDER BY id").data;
        return !r.error && rows[0].sal === 111 && rows[1].sal === 222 && rows[2].sal === 300;
      });
      fn('V25Dml update from select', () => {
        const r = db.executeQuery("UPDATE v25_u SET sal = s.v FROM (SELECT 3 AS i, 999 AS v) AS s WHERE v25_u.id = s.i");
        return !r.error && db.executeQuery("SELECT sal FROM v25_u WHERE id = 3").data[0].sal === 999;
      });
      fn('V25Dml delete using values', () => {
        const r = db.executeQuery("DELETE FROM v25_u USING (VALUES (3)) AS d(i) WHERE v25_u.id = d.i");
        return !r.error && db.executeQuery("SELECT COUNT(*) AS c FROM v25_u").data[0].c === 2;
      });
      fn('V25Dml plain update unaffected', () => {
        const r = db.executeQuery("UPDATE v25_u SET sal = 1 WHERE id = 1");
        return !r.error && db.executeQuery("SELECT sal FROM v25_u WHERE id = 1").data[0].sal === 1;
      });
      err('V25Dml derived source needs an alias', "UPDATE v25_u SET sal = 1 FROM (VALUES (1)) WHERE id = 1", "alias");

      // ============================================================
      // 4. SELECT 句の集合返し関数と DIV 演算子
      // ============================================================
      push('V25Srf unnest in select', "SELECT UNNEST(ARRAY[1,2,3]) AS v", r => r.data.length === 3 && r.data[2].v === 3);
      push('V25Srf unnest default name', "SELECT UNNEST(ARRAY['a','b'])", r => r.data.length === 2 && r.data[0].value === 'a');
      push('V25Srf string_split in select', "SELECT STRING_SPLIT('a,b,c', ',') AS part", r => r.data.length === 3 && r.data[1].part === 'b');
      push('V25Srf generate_series in select', "SELECT GENERATE_SERIES(1, 4) AS n", r => r.data.length === 4 && r.data[3].n === 4);
      fn('V25Srf usable through a derived table', () => {
        const r = db.executeQuery("SELECT SUM(v) AS s FROM (SELECT UNNEST(ARRAY[1,2,3]) AS v) t");
        return !r.error && r.data[0].s === 6;
      });
      err('V25Srf with FROM rejected', "SELECT UNNEST(ARRAY[1,2]) AS v FROM v25_e", "only supported without a FROM clause");
      err('V25Srf with another item rejected', "SELECT UNNEST(ARRAY[1,2]) AS v, 5 AS x", "must be the only select item");
      push('V25Srf from-clause form still works', "SELECT SUM(v) AS s FROM UNNEST(ARRAY[1,2,3]) AS t(v)", r => r.data[0].s === 6);
      push('V25Div infix', "SELECT 7 DIV 2 AS a", r => r.data[0].a === 3);
      push('V25Div negative truncates toward zero', "SELECT -7 DIV 2 AS a", r => r.data[0].a === -3);
      push('V25Div chained', "SELECT 7 DIV 2 DIV 2 AS a", r => r.data[0].a === 1);
      push('V25Div parenthesised left', "SELECT (10 + 4) DIV 3 AS a", r => r.data[0].a === 4);
      push('V25Div on a column', "SELECT sal DIV 100 AS h FROM v25_e WHERE id = 2", r => r.data[0].h === 3);
      push('V25Div by zero is null', "SELECT 5 DIV 0 AS a", r => r.data[0].a === null);
      push('V25Div function form still works', "SELECT DIV(7, 2) AS a", r => r.data[0].a === 3);

      // ============================================================
      // 5. 別名なし定数列の命名
      // ============================================================
      // 従来は '0' というキーになり、JS の整数風キー順序で列が先頭へ回っていた
      push('V25Col constant keeps position', "SELECT id, name, 0 FROM users WHERE id = 1",
        r => Object.keys(r.data[0]).join(',') === 'id,name,column3' && r.data[0].column3 === 0);
      push('V25Col string constant not a token', "SELECT id, 'x' FROM users WHERE id = 1",
        r => Object.keys(r.data[0]).join(',') === 'id,column2' && r.data[0].column2 === 'x');
      push('V25Col all constants', "SELECT 1, 2, 3", r => Object.keys(r.data[0]).join(',') === 'column1,column2,column3');
      push('V25Col explicit alias wins', "SELECT id, 0 AS z FROM users WHERE id = 1", r => Object.keys(r.data[0]).join(',') === 'id,z');
      push('V25Col expression name unchanged', "SELECT id + 1 FROM users WHERE id = 1", r => Object.keys(r.data[0])[0] === 'id + 1');

      // ============================================================
      // 6. ドメインと列挙型
      // ============================================================
      push('V25Dom create domain', "CREATE DOMAIN v25_pos AS INTEGER CHECK (VALUE > 0)", r => !r.error);
      push('V25Dom use as column type', "CREATE TABLE v25_d1 (id INTEGER, qty v25_pos)", r => !r.error);
      push('V25Dom expands to base type', "SHOW CREATE TABLE v25_d1",
        r => r.data[0].CreateTable.includes('qty INTEGER') && r.data[0].CreateTable.includes('CHECK (qty > 0)'));
      push('V25Dom accepts valid value', "INSERT INTO v25_d1 VALUES (1, 5)", r => !r.error);
      err('V25Dom rejects invalid value', "INSERT INTO v25_d1 VALUES (2, -3)", "CHECK constraint failed");
      fn('V25Dom not null and default carried over', () => {
        db.executeQuery("CREATE DOMAIN v25_code AS TEXT NOT NULL DEFAULT 'n/a'");
        db.executeQuery("CREATE TABLE v25_d2 (id INTEGER, c v25_code)");
        const i = db.executeQuery("INSERT INTO v25_d2 (id) VALUES (1)");
        const got = db.executeQuery("SELECT c FROM v25_d2").data[0].c;
        const nullTry = db.executeQuery("INSERT INTO v25_d2 VALUES (2, NULL)");
        return !i.error && got === 'n/a' && nullTry.error !== undefined;
      });
      err('V25Dom check must use VALUE', "CREATE DOMAIN v25_bad AS INTEGER CHECK (x > 0)", "must reference VALUE");
      err('V25Dom duplicate name', "CREATE DOMAIN v25_pos AS INTEGER", "already exists");
      push('V25Enum create type', "CREATE TYPE v25_mood AS ENUM ('sad','ok','happy')", r => !r.error);
      push('V25Enum use as column type', "CREATE TABLE v25_d3 (id INTEGER, m v25_mood)", r => !r.error);
      push('V25Enum accepts a listed value', "INSERT INTO v25_d3 VALUES (1, 'ok')", r => !r.error);
      err('V25Enum rejects other values', "INSERT INTO v25_d3 VALUES (2, 'angry')", "CHECK constraint failed");
      err('V25Enum needs values', "CREATE TYPE v25_empty AS ENUM ()", "at least one value");
      fn('V25Dom listed by SHOW DOMAINS', () => {
        const r = db.executeQuery("SHOW DOMAINS");
        const d = r.data.find(x => x.Name === 'v25_pos');
        const e = r.data.find(x => x.Name === 'v25_mood');
        return d && d.BaseType === 'INTEGER' && e && e.Kind === 'ENUM';
      });
      fn('V25Dom survives IDB round trip', () => {
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        return e2.domains.v25_pos && e2.domains.v25_pos.check.includes('VALUE');
      });
      fn('V25Dom drop', () => {
        const r = db.executeQuery("DROP DOMAIN v25_pos");
        const gone = db.domains.v25_pos === undefined;
        // 既に作った表の制約は残る（PostgreSQL は使用中のドメインを落とせないが、
        // ここでは列へ展開済みなので表側は影響を受けない）
        const stillChecked = db.executeQuery("INSERT INTO v25_d1 VALUES (3, -1)");
        return !r.error && gone && stillChecked.error !== undefined;
      });
      push('V25Dom drop if exists skips', "DROP TYPE IF EXISTS v25_nope", r => !r.error && r.data[0].Message.includes('Skipped'));

      // ============================================================
      // 7. ユーザーとロール（権限は強制しない）
      // ============================================================
      push('V25Usr create user', "CREATE USER v25_app", r => !r.error && r.data[0].Message.includes('does not enforce privileges'));
      push('V25Usr create role', "CREATE ROLE v25_reader", r => !r.error);
      err('V25Usr duplicate user', "CREATE USER v25_app", "already exists");
      push('V25Usr if not exists skips', "CREATE USER IF NOT EXISTS v25_app", r => !r.error && r.data[0].Message.includes('Skipped'));
      fn('V25Usr show users and roles', () => {
        const u = db.executeQuery("SHOW USERS");
        const ro = db.executeQuery("SHOW ROLES");
        return u.data.some(x => x.Name === 'v25_app') && ro.data.some(x => x.Name === 'v25_reader');
      });
      fn('V25Usr show grants', () => {
        const r = db.executeQuery("SHOW GRANTS");
        return r.data.some(x => x.Grantee === 'v25_app') && r.data[0].Note.includes('does not enforce');
      });
      push('V25Usr grant still accepted', "GRANT SELECT ON users TO v25_app", r => !r.error);
      push('V25Usr drop user', "DROP USER v25_app", r => !r.error && r.data[0].Message.startsWith('User'));
      push('V25Usr drop role', "DROP ROLE v25_reader", r => !r.error && r.data[0].Message.startsWith('Role'));
      err('V25Usr drop unknown', "DROP USER v25_nobody", "not found");

      // ============================================================
      // 8. TRUNCATE ... CONTINUE IDENTITY
      // ============================================================
      fn('V25Tr continue identity keeps numbering', () => {
        db.executeQuery("CREATE TABLE v25_ti (id INTEGER AUTO_INCREMENT, v TEXT)");
        db.executeQuery("INSERT INTO v25_ti (v) VALUES ('a'),('b'),('c')");
        const t = db.executeQuery("TRUNCATE TABLE v25_ti CONTINUE IDENTITY");
        db.executeQuery("INSERT INTO v25_ti (v) VALUES ('z')");
        return !t.error && db.executeQuery("SELECT id FROM v25_ti").data[0].id === 4;
      });
      fn('V25Tr restart identity resets', () => {
        db.executeQuery("TRUNCATE TABLE v25_ti RESTART IDENTITY");
        db.executeQuery("INSERT INTO v25_ti (v) VALUES ('y')");
        return db.executeQuery("SELECT id FROM v25_ti").data[0].id === 1;
      });
      fn('V25Tr plain truncate restarts', () => {
        db.executeQuery("TRUNCATE TABLE v25_ti");
        db.executeQuery("INSERT INTO v25_ti (v) VALUES ('x')");
        return db.executeQuery("SELECT id FROM v25_ti").data[0].id === 1;
      });
      fn('V25Tr identity floor survives IDB round trip', () => {
        db.executeQuery("INSERT INTO v25_ti (v) VALUES ('w'),('v')");
        db.executeQuery("TRUNCATE TABLE v25_ti CONTINUE IDENTITY");
        const e2 = new DatabaseEngine();
        e2.importFromIDB(db.exportForIDB());
        return e2.tables.v25_ti.identityFloor === 4;
      });

      // ============================================================
      // 9. 再帰CTE の SEARCH / CYCLE
      // ============================================================
      fn('V25Rec search adds an ordering column', () => {
        const r = db.executeQuery(
          "WITH RECURSIVE t(id, nm) AS (SELECT id, nm FROM v25_tree WHERE pid IS NULL "
          + "UNION ALL SELECT e.id, e.nm FROM v25_tree e JOIN t s ON e.pid = s.id) "
          + "SEARCH DEPTH FIRST BY id SET ord SELECT id, ord FROM t ORDER BY ord");
        return !r.error && r.data.length === 5 && r.data[0].ord === 1 && r.data[4].ord === 5;
      });
      fn('V25Rec breadth first ordering', () => {
        const r = db.executeQuery(
          "WITH RECURSIVE t(id, nm) AS (SELECT id, nm FROM v25_tree WHERE pid IS NULL "
          + "UNION ALL SELECT e.id, e.nm FROM v25_tree e JOIN t s ON e.pid = s.id) "
          + "SEARCH BREADTH FIRST BY id SET ord SELECT id, ord FROM t ORDER BY ord");
        // 幅優先は生成順そのもの: root(1) → その子(2,3) → 孫(4,5)
        return !r.error && r.data.map(x => x.id).join(',') === '1,2,3,4,5';
      });
      // 循環するグラフは従来 500 回上限のエラーになっていた
      err('V25Rec cycle without CYCLE clause errors',
        "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM v25_g g JOIN t ON g.a = t.n) SELECT COUNT(*) AS c FROM t",
        "exceeded 500 iterations");
      fn('V25Rec cycle clause terminates', () => {
        const r = db.executeQuery(
          "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM v25_g g JOIN t ON g.a = t.n) "
          + "CYCLE n SET is_cyc USING path SELECT n, is_cyc FROM t");
        return !r.error && r.data.length === 4 && r.data.some(x => x.is_cyc === true);
      });
      fn('V25Rec cycle path column', () => {
        const r = db.executeQuery(
          "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM v25_g g JOIN t ON g.a = t.n) "
          + "CYCLE n SET is_cyc USING path SELECT n, path FROM t");
        return !r.error && r.data.every(x => typeof x.path === 'string' && x.path.startsWith('['));
      });
      err('V25Rec search needs RECURSIVE', "WITH t(a) AS (SELECT 1) SEARCH DEPTH FIRST BY a SET o SELECT * FROM t", "require WITH RECURSIVE");
      fn('V25Rec plain recursive cte unaffected', () => {
        const r = db.executeQuery("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT SUM(n) AS s FROM t");
        return !r.error && r.data[0].s === 15;
      });

      // ============================================================
      // 10. IN (...) のインデックス活用
      // ============================================================
      fn('V25Ix in uses the index', () => {
        const r = db.executeQuery("EXPLAIN SELECT * FROM v25_e WHERE id IN (1, 3)");
        return r.data[0].Operation === 'INDEX SCAN' && r.data[0].Details.includes('lookup of 2 value(s)');
      });
      push('V25Ix in returns rows in table order', "SELECT id FROM v25_e WHERE id IN (3, 1)", r => r.data.map(x => x.id).join(',') === '1,3');
      push('V25Ix duplicate values counted once', "SELECT id FROM v25_e WHERE id IN (1, 1, 2)", r => r.data.length === 2);
      push('V25Ix missing value yields nothing', "SELECT COUNT(*) AS c FROM v25_e WHERE id IN (99)", r => r.data[0].c === 0);
      push('V25Ix not in still scans', "SELECT id FROM v25_e WHERE id NOT IN (1,2)", r => r.data.length === 1 && r.data[0].id === 3);
      fn('V25Ix string index in', () => {
        db.executeQuery("CREATE INDEX v25_ixnm ON v25_e (nm)");
        const p = db.executeQuery("EXPLAIN SELECT * FROM v25_e WHERE nm IN ('a','c')");
        const r = db.executeQuery("SELECT id FROM v25_e WHERE nm IN ('a','c')");
        return p.data[0].Operation === 'INDEX SCAN' && r.data.map(x => x.id).join(',') === '1,3';
      });
      fn('V25Ix unindexed column falls back to a scan', () => {
        const r = db.executeQuery("EXPLAIN SELECT * FROM v25_e WHERE sal IN (100, 200)");
        return r.data[0].Operation === 'TABLE SCAN';
      });
      push('V25Ix equality index scan unchanged', "EXPLAIN SELECT * FROM v25_e WHERE id = 1", r => r.data[0].Operation === 'INDEX SCAN');

      // ============================================================
      // 11. フロントエンド: 行の追加・削除
      // ============================================================
      const runGrid = (sql) => { setQueryValue(sql); document.getElementById('executeBtn').click(); };
      const clickCell = (r, c) => {
        const td = els.resArea.querySelector(`#resultsTbody td[data-r="${r}"][data-c="${c}"]`);
        if (td) td.click();
        return !!td;
      };

      fn('V25Row fixture', () => {
        db.executeQuery("CREATE TABLE v25_ui (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT, salary INTEGER)");
        db.executeQuery("INSERT INTO v25_ui (name, salary) VALUES ('Alice',9200),('Bob',7100),('Carol',6800)");
        renderTree();
        return true;
      });
      fn('V25Row buttons follow editability', () => {
        runGrid("SELECT id, name, salary FROM v25_ui ORDER BY id");
        const addOn = !document.getElementById('addRowBtn').disabled;
        const delOffNoSel = document.getElementById('delRowBtn').disabled;
        clickCell(1, 1);
        const delOnSel = !document.getElementById('delRowBtn').disabled;
        runGrid("SELECT COUNT(*) AS n FROM v25_ui");
        const bothOff = document.getElementById('addRowBtn').disabled && document.getElementById('delRowBtn').disabled;
        return addOn && delOffNoSel && delOnSel && bothOff;
      });
      fn('V25Row selection is highlighted', () => {
        runGrid("SELECT id, name, salary FROM v25_ui ORDER BY id");
        clickCell(1, 1);
        return els.resArea.querySelectorAll('#resultsTbody tr.bg-blue-50\\/60').length === 1;
      });
      fn('V25Row delete removes the selected row only', () => {
        runGrid("SELECT id, name, salary FROM v25_ui ORDER BY id");
        clickCell(1, 1);   // Bob
        document.getElementById('delRowBtn').click();
        const names = db.executeQuery("SELECT name FROM v25_ui ORDER BY id").data.map(r => r.name);
        return names.join(',') === 'Alice,Carol';
      });
      fn('V25Row delete clears the selection', () => document.getElementById('delRowBtn').disabled === true);
      fn('V25Row add inserts a default row', () => {
        runGrid("SELECT id, name, salary FROM v25_ui ORDER BY id");
        const before = db.executeQuery("SELECT COUNT(*) AS c FROM v25_ui").data[0].c;
        document.getElementById('addRowBtn').click();
        const after = db.executeQuery("SELECT COUNT(*) AS c FROM v25_ui").data[0].c;
        const newest = db.executeQuery("SELECT name FROM v25_ui ORDER BY id DESC").data[0].name;
        return after === before + 1 && newest === null;
      });
      fn('V25Row add assigns the next identity', () => {
        const ids = db.executeQuery("SELECT id FROM v25_ui ORDER BY id").data.map(r => r.id);
        return ids[ids.length - 1] === 4;
      });
      // 削除もキー値をバインドする（値に引用符が含まれても SQL にならない）
      fn('V25Row delete binds the key value', () => {
        db.executeQuery("CREATE TABLE v25_kq (k TEXT PRIMARY KEY, v INTEGER)");
        db.executeQuery("INSERT INTO v25_kq VALUES ('a''; DROP TABLE v25_kq; --', 1), ('safe', 2)");
        runGrid("SELECT k, v FROM v25_kq ORDER BY v");
        clickCell(0, 0);
        document.getElementById('delRowBtn').click();
        const left = db.executeQuery("SELECT k FROM v25_kq");
        const ok = db.tables.v25_kq !== undefined && left.data.length === 1 && left.data[0].k === 'safe';
        db.executeQuery("DROP TABLE v25_kq");
        return ok;
      });
      fn('V25Row read-only grid ignores row buttons', () => {
        runGrid("SELECT name, salary FROM v25_ui");   // キー列が無い＝読み取り専用
        const before = db.executeQuery("SELECT COUNT(*) AS c FROM v25_ui").data[0].c;
        document.getElementById('addRowBtn').click();
        const after = db.executeQuery("SELECT COUNT(*) AS c FROM v25_ui").data[0].c;
        return document.getElementById('addRowBtn').disabled && before === after;
      });

      // ============================================================
      // 12. フロントエンド: クエリ履歴パネル
      // ============================================================
      fn('V25Hist panel lists entries', () => {
        // isTesting 中は pushQueryHistory が抑制されるので、localStorage を直接用意する
        localStorage.setItem('luminadb_query_history', JSON.stringify([
          'SELECT 1 AS one', 'SELECT * FROM v25_ui', 'UPDATE v25_ui SET salary = 1'
        ]));
        document.getElementById('openHistoryBtn').click();
        const items = document.querySelectorAll('#historyList button').length;
        // 各エントリは「読み込み」と「Run」の2ボタン
        return items === 6 && document.getElementById('historyCount').textContent === '(3)';
      });
      fn('V25Hist newest first', () => {
        const first = document.querySelector('#historyList button');
        return first.textContent === 'UPDATE v25_ui SET salary = 1';
      });
      fn('V25Hist search filters', () => {
        const s = document.getElementById('historySearch');
        s.value = 'v25_ui';
        s.dispatchEvent(new Event('input'));
        const n = document.querySelectorAll('#historyList button').length;
        return n === 4 && document.getElementById('historyCount').textContent === '(2 / 3)';
      });
      fn('V25Hist no match message', () => {
        const s = document.getElementById('historySearch');
        s.value = 'zzzzz';
        s.dispatchEvent(new Event('input'));
        return document.getElementById('historyList').textContent.includes('一致する履歴がありません');
      });
      fn('V25Hist click loads into the editor', () => {
        const s = document.getElementById('historySearch');
        s.value = 'one';
        s.dispatchEvent(new Event('input'));
        const bk = els.query.value;
        document.querySelector('#historyList button').click();
        const loaded = els.query.value;
        const closed = document.getElementById('historyModal').classList.contains('hidden');
        setQueryValue(bk);
        return loaded === 'SELECT 1 AS one' && closed;
      });
      fn('V25Hist clear empties the list', () => {
        document.getElementById('openHistoryBtn').click();
        document.getElementById('historyClearBtn').click();
        const empty = document.getElementById('historyList').textContent.includes('履歴はまだありません');
        document.querySelector('#historyModal .closeModalBtn').click();
        return empty;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V25Cl drop objects', () => {
        ['v25_mood', 'v25_code'].forEach(d => db.executeQuery(`DROP TYPE IF EXISTS ${d}`));
        db.executeQuery("DROP DOMAIN IF EXISTS v25_code");
        ['v25_ui', 'v25_ti', 'v25_d3', 'v25_d2', 'v25_d1', 'v25_u', 'v25_g', 'v25_tree', 'v25_e']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        try { localStorage.removeItem('luminadb_query_history'); } catch (e) { /* 無効環境 */ }
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
