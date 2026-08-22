    // ============================================================================
    // [Test Suite v33] - v1.27 の後半（v32 で「未着手」として残した項目の消化）
    //
    //   A. 修飾なしの曖昧な列名を拒否する（実DB互換）
    //      `SELECT SUM(amount) FROM orders o JOIN payments p ON ...` は、どちらの
    //      amount を足したのか書き手に判らないまま左側の表を採っていた
    //   B. 組み込み関数の引数個数を検査する
    //      誤った個数が黙って NULL / 変な値 / 列そのものの消失になっていた
    //   C. 16 進リテラル X'..' / 0x..
    //      綴りを知らず「X」＋文字列に割れ、ソーステキストが列へ入っていた
    //   D. ALTER TABLE ADD CHECK の 3 値論理
    //      NULL を含む行を違反と判定し、INSERT では通る制約を後から付けられなかった
    //   E. EXPLAIN の充実（行数見積り / DISTINCT・WINDOW・AGGREGATE 段 /
    //      一時表の判る名前 / Details の内部トークン除去）
    //
    //   test-suite.js の tests 配列へ getV33Tests() のスプレッドで合流する
    // ============================================================================
    function getV33Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, err, t: fn, q, oneSafe: one } = makeTestKit('V33');
      const plan = (sql) => { const r = q(sql); return r.error ? null : r.data; };
      const ops = (sql) => { const p = plan(sql); return p ? p.map(x => x.Operation) : ['ERR']; };

      // ============================================================
      // A. 修飾なしの曖昧な列名
      // ============================================================
      fn('V33Amb setup', () => {
        q("DROP TABLE IF EXISTS v33_o"); q("DROP TABLE IF EXISTS v33_p");
        q("CREATE TABLE v33_o (id INT, amount INT)");
        q("CREATE TABLE v33_p (id INT, amount INT)");
        q("INSERT INTO v33_o VALUES (1,100),(2,200)");
        q("INSERT INTO v33_p VALUES (1,5),(2,6)");
        return db.tables['v33_o'].rowCount === 2 && db.tables['v33_p'].rowCount === 2;
      });
      err('V33Amb an ambiguous column in the select list is rejected',
        "SELECT SUM(amount) FROM v33_o o JOIN v33_p p ON o.id = p.id", 'ambiguous');
      err('V33Amb an ambiguous bare column is rejected',
        "SELECT amount FROM v33_o o JOIN v33_p p ON o.id = p.id", 'ambiguous');
      err('V33Amb an ambiguous column in WHERE is rejected',
        "SELECT * FROM v33_o o JOIN v33_p p ON o.id = p.id WHERE amount > 50", 'ambiguous');
      err('V33Amb an ambiguous column in HAVING is rejected',
        "SELECT o.id FROM v33_o o JOIN v33_p p ON o.id = p.id GROUP BY o.id HAVING SUM(amount) > 1", 'ambiguous');
      err('V33Amb an ambiguous column in the ON clause is rejected',
        "SELECT * FROM v33_o o JOIN v33_p p ON amount = amount", 'ambiguous');
      fn('V33Amb the error names both tables', () => {
        const r = q("SELECT amount FROM v33_o o JOIN v33_p p ON o.id = p.id");
        return !!r.error && r.error.includes('v33_o') && r.error.includes('v33_p');
      });
      fn('V33Amb qualifying the column resolves it', () => {
        const r = q("SELECT SUM(o.amount) AS s FROM v33_o o JOIN v33_p p ON o.id = p.id");
        return !r.error && r.data[0].s === 300;
      });
      fn('V33Amb a column unique to one side needs no qualifier', () => {
        q("DROP TABLE IF EXISTS v33_q");
        q("CREATE TABLE v33_q (id INT, only_here INT)");
        q("INSERT INTO v33_q VALUES (1,7),(2,8)");
        const r = q("SELECT SUM(only_here) AS s FROM v33_o o JOIN v33_q z ON o.id = z.id");
        return !r.error && r.data[0].s === 15;
      });
      fn('V33Amb a single-table query is unaffected', () => {
        const r = q("SELECT amount FROM v33_o WHERE amount > 50 ORDER BY amount");
        return !r.error && r.data.length === 2 && r.data[0].amount === 100;
      });
      fn('V33Amb three tables still detect the clash', () => {
        const r = q("SELECT amount FROM v33_o o JOIN v33_q z ON o.id = z.id JOIN v33_p p ON o.id = p.id");
        return !!r.error && /ambiguous/i.test(r.error);
      });

      // ============================================================
      // B. 組み込み関数の引数個数
      // ============================================================
      err('V33Ar ABS with no argument', "SELECT ABS() AS x", 'parameter count');
      err('V33Ar ABS with three arguments', "SELECT ABS(1,2,3) AS x", 'parameter count');
      err('V33Ar POWER with one argument', "SELECT POWER(2) AS x", 'parameter count');
      err('V33Ar NULLIF with one argument', "SELECT NULLIF(1) AS x", 'parameter count');
      err('V33Ar LEFT with one argument', "SELECT LEFT('abc') AS x", 'parameter count');
      err('V33Ar DATEDIFF with one argument', "SELECT DATEDIFF('2020-01-01') AS x", 'parameter count');
      err('V33Ar REPLACE with two arguments', "SELECT REPLACE('a','b') AS x", 'parameter count');
      err('V33Ar CONCAT_WS with only a separator', "SELECT CONCAT_WS('-') AS x", 'parameter count');
      fn('V33Ar the message names the function and the expected count', () => {
        const r = q("SELECT POWER(2) AS x");
        return !!r.error && r.error.includes("'POWER'") && /expected 2/.test(r.error);
      });
      fn('V33Ar correct calls are unaffected', () => {
        const r = q("SELECT ABS(-5) AS a, POWER(2,3) AS b, ROUND(1.234) AS c, ROUND(1.234,2) AS d, COALESCE(NULL,1) AS e, LEFT('abc',2) AS f");
        return !r.error && r.data[0].a === 5 && r.data[0].b === 8 && r.data[0].c === 1
            && r.data[0].d === 1.23 && r.data[0].e === 1 && r.data[0].f === 'ab';
      });
      fn('V33Ar variadic functions accept many arguments', () => {
        const r = q("SELECT COALESCE(NULL,NULL,3) AS a, GREATEST(1,5,3) AS b, LEAST(4,2,9) AS c, CONCAT_WS('-','a','b','c') AS d");
        return !r.error && r.data[0].a === 3 && r.data[0].b === 5 && r.data[0].c === 2 && r.data[0].d === 'a-b-c';
      });
      fn('V33Ar keyword-argument spellings are exempt', () => {
        const r = q("SELECT EXTRACT(YEAR FROM '2024-01-02') AS a, CAST(1 AS TEXT) AS b, TRIM(BOTH ' ' FROM ' x ') AS c, SUBSTRING('abcdef' FROM 2 FOR 3) AS d");
        return !r.error && r.data[0].a === 2024 && r.data[0].b === '1' && r.data[0].c === 'x' && r.data[0].d === 'bcd';
      });
      fn('V33Ar an optional trailing argument is allowed', () => {
        const r = q("SELECT JSON_TYPE('{\"a\":1}') AS a, JSON_TYPE('{\"a\":1}','$.a') AS b, LPAD('x',3) AS c, LPAD('x',3,'-') AS d");
        return !r.error && r.data[0].a === 'OBJECT' && r.data[0].b === 'INTEGER' && r.data[0].d === '--x';
      });
      fn('V33Ar aggregates and window functions are not arity-checked here', () => {
        q("DROP TABLE IF EXISTS v33_ag");
        q("CREATE TABLE v33_ag (v INT)");
        q("INSERT INTO v33_ag VALUES (1),(2)");
        // 集計とウィンドウを別々に確かめる（同じ SELECT に混ぜると
        // 「集計後の行に生の列が無い」という別の理由で落ちる）
        const a = q("SELECT COUNT(*) AS c, SUM(v) AS s FROM v33_ag");
        const w = q("SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn FROM v33_ag");
        return !a.error && !w.error && a.data[0].c === 2 && a.data[0].s === 3 && w.data.length === 2;
      });
      fn('V33Ar a nested wrong call is still caught', () => {
        const r = q("SELECT ABS(POWER(2)) AS x");
        return !!r.error && /parameter count/i.test(r.error);
      });
      fn('V33Ar a column named like a function is unaffected', () => {
        q("DROP TABLE IF EXISTS v33_cn");
        q("CREATE TABLE v33_cn (left_ INT, abs INT)");
        q("INSERT INTO v33_cn VALUES (1,2)");
        const r = q("SELECT abs, left_ FROM v33_cn");
        return !r.error && r.data[0].abs === 2 && r.data[0].left_ === 1;
      });

      // ============================================================
      // C. 16 進リテラル
      // ============================================================
      fn('V33Hex X and 0x literals decode to their bytes', () => {
        const r = q("SELECT X'41' AS a, 0x42 AS b, X'48656C6C6F' AS h");
        return !r.error && r.data[0].a === 'A' && r.data[0].b === 'B' && r.data[0].h === 'Hello';
      });
      fn('V33Hex HEX round-trips a hex literal', () =>
        one("SELECT HEX(X'48656C6C6F') AS r") === '48656C6C6F');
      fn('V33Hex a hex literal stores its bytes, not the source text', () => {
        q("DROP TABLE IF EXISTS v33_bx");
        q("CREATE TABLE v33_bx (b TEXT)");
        q("INSERT INTO v33_bx VALUES (X'48656C6C6F')");
        const r = q("SELECT b, HEX(b) AS h, LENGTH(b) AS l FROM v33_bx");
        return !r.error && r.data[0].b === 'Hello' && r.data[0].h === '48656C6C6F' && r.data[0].l === 5;
      });
      fn('V33Hex an odd digit count is an error result, not a raw exception', () => {
        let r;
        try { r = q("SELECT X'4' AS odd"); } catch (e) { return false; }   // 生の例外は不可
        return !!r.error && /odd number of digits/i.test(r.error);
      });
      fn('V33Hex X is equivalent to UNHEX', () => {
        const r = q("SELECT X'48656C6C6F' = UNHEX('48656C6C6F') AS same");
        return !r.error && r.data[0].same === true;
      });
      fn('V33Hex ordinary strings and numbers are untouched', () => {
        const r = q("SELECT 'x' AS a, \"y\" AS b, 0 AS c, 10 AS d, 0.5 AS e");
        return !r.error && r.data[0].a === 'x' && r.data[0].b === 'y'
            && r.data[0].c === 0 && r.data[0].d === 10 && r.data[0].e === 0.5;
      });
      fn('V33Hex a string containing an x-quote pattern is not reinterpreted', () => {
        q("DROP TABLE IF EXISTS v33_sx");
        q("CREATE TABLE v33_sx (s TEXT)");
        q("INSERT INTO v33_sx VALUES ('X''41''')");
        return one("SELECT s FROM v33_sx") === "X'41'";
      });

      // ============================================================
      // D. ALTER TABLE ADD CHECK と NULL（3 値論理）
      // ============================================================
      fn('V33Chk ADD CHECK accepts rows whose value is NULL', () => {
        q("DROP TABLE IF EXISTS v33_ck");
        q("CREATE TABLE v33_ck (a INT)");
        q("INSERT INTO v33_ck VALUES (1),(NULL),(2)");
        const r = q("ALTER TABLE v33_ck ADD CONSTRAINT v33_c1 CHECK (a < 100)");
        return !r.error;
      });
      fn('V33Chk the added CHECK is then enforced', () => {
        const bad = q("INSERT INTO v33_ck VALUES (500)");
        const nul = q("INSERT INTO v33_ck VALUES (NULL)");
        return !!bad.error && !nul.error;
      });
      fn('V33Chk ADD CHECK still refuses genuinely violating data', () => {
        q("DROP TABLE IF EXISTS v33_ck2");
        q("CREATE TABLE v33_ck2 (a INT)");
        q("INSERT INTO v33_ck2 VALUES (500)");
        const r = q("ALTER TABLE v33_ck2 ADD CONSTRAINT v33_c2 CHECK (a < 100)");
        return !!r.error && /existing data violates/i.test(r.error);
      });
      fn('V33Chk the refused CHECK was not recorded', () => {
        const t = db.tables['v33_ck2'];
        return !(t.checks || []).some(c => c.name === 'v33_c2');
      });
      fn('V33Chk a CHECK over a NULL column matches the CREATE TABLE behaviour', () => {
        // 同じ制約を CREATE 時に付けた表と、後から付けた表で挙動が一致すること
        q("DROP TABLE IF EXISTS v33_ck3");
        q("CREATE TABLE v33_ck3 (a INT CHECK (a < 100))");
        const nul = q("INSERT INTO v33_ck3 VALUES (NULL)");
        const bad = q("INSERT INTO v33_ck3 VALUES (500)");
        return !nul.error && !!bad.error;
      });

      // ============================================================
      // E. EXPLAIN の充実
      // ============================================================
      fn('V33Exp setup', () => {
        q("DROP TABLE IF EXISTS v33_e");
        q("CREATE TABLE v33_e (id INT PRIMARY KEY, v INT, s TEXT)");
        q("INSERT INTO v33_e SELECT n, n*2, 'x' FROM GENERATE_SERIES(1,100) AS t(n)");
        q("CREATE INDEX v33_e_ix ON v33_e(v)");
        return db.tables['v33_e'].rowCount === 100;
      });
      fn('V33Exp every step carries a row estimate', () => {
        const p = plan("EXPLAIN SELECT * FROM v33_e WHERE s = 'x' ORDER BY v LIMIT 10");
        return !!p && p.length >= 3 && p.every(x => typeof x.Rows === 'number');
      });
      fn('V33Exp a full scan estimates the table row count', () => {
        const p = plan("EXPLAIN SELECT * FROM v33_e");
        return !!p && p[0].Operation === 'TABLE SCAN' && p[0].Rows === 100;
      });
      fn('V33Exp an index lookup estimates far fewer rows than a scan', () => {
        const p = plan("EXPLAIN SELECT * FROM v33_e WHERE v = 20");
        return !!p && p[0].Operation === 'INDEX SCAN' && p[0].Rows < 100;
      });
      fn('V33Exp LIMIT caps the estimate', () => {
        const p = plan("EXPLAIN SELECT * FROM v33_e ORDER BY v LIMIT 10");
        const last = p[p.length - 1];
        return last.Operation === 'LIMIT' && last.Rows === 10;
      });
      fn('V33Exp DISTINCT appears as its own step', () =>
        ops("EXPLAIN SELECT DISTINCT s FROM v33_e").includes('DISTINCT'));
      fn('V33Exp a window function appears as its own step', () =>
        ops("EXPLAIN SELECT v, ROW_NUMBER() OVER (ORDER BY v) FROM v33_e").includes('WINDOW'));
      fn('V33Exp an ungrouped aggregate appears as its own step and yields 1 row', () => {
        const p = plan("EXPLAIN SELECT COUNT(*) FROM v33_e");
        const agg = p.find(x => x.Operation === 'AGGREGATE');
        return !!agg && agg.Rows === 1;
      });
      fn('V33Exp a derived table is named, not exposed as __tmp_N', () => {
        const p = plan("EXPLAIN SELECT * FROM (SELECT * FROM v33_e WHERE v > 5) x");
        return !!p && /derived table/.test(p[0].Details) && !/__tmp_/.test(p[0].Details);
      });
      fn('V33Exp a CTE is named', () => {
        const p = plan("EXPLAIN WITH c AS (SELECT * FROM v33_e) SELECT * FROM c");
        return !!p && /CTE 'c'/.test(p[0].Details) && !/__tmp_/.test(p[0].Details);
      });
      fn('V33Exp Details has no internal string token', () => {
        const p = plan("EXPLAIN SELECT * FROM v33_e WHERE s = 'x'");
        return !!p && p.every(x => !/__STR_\d+__/.test(x.Details))
            && p.some(x => x.Details.includes("'x'"));
      });
      fn('V33Exp GROUP BY / HAVING / ORDER BY steps are still produced', () => {
        const o = ops("EXPLAIN SELECT s, COUNT(*) AS c FROM v33_e GROUP BY s HAVING COUNT(*) > 1 ORDER BY s");
        return o.includes('GROUP BY') && o.includes('HAVING') && o.includes('ORDER BY');
      });
      fn('V33Exp EXPLAIN still refuses non-SELECT statements', () => {
        const before = db.tables['v33_e'].rowCount;
        const r = q("EXPLAIN DELETE FROM v33_e WHERE id = 1");
        return !!r.error && db.tables['v33_e'].rowCount === before;
      });

      // ============================================================
      // F. DECIMAL(p,s) / VARCHAR(n) を格納時にも適用する
      // ============================================================
      fn('V33Dec DECIMAL(p,s) rounds on insert like CAST does', () => {
        q("DROP TABLE IF EXISTS v33_d");
        q("CREATE TABLE v33_d (price DECIMAL(10,2), code VARCHAR(3))");
        q("INSERT INTO v33_d VALUES (123.4567,'abc')");
        const stored = one("SELECT price FROM v33_d");
        const cast = one("SELECT CAST(123.4567 AS DECIMAL(10,2)) AS c");
        return stored === 123.46 && stored === cast;
      });
      fn('V33Dec the half-way case matches MySQL (1.005 -> 1.01)', () => {
        q("DROP TABLE IF EXISTS v33_d2");
        q("CREATE TABLE v33_d2 (v DECIMAL(10,2))");
        q("INSERT INTO v33_d2 VALUES (1.005)");
        return one("SELECT v FROM v33_d2") === 1.01;
      });
      fn('V33Dec a value beyond the declared precision is refused', () => {
        const r = q("INSERT INTO v33_d VALUES (99999999999.99,'z')");
        return !!r.error && /out of range/i.test(r.error);
      });
      fn('V33Dec text longer than the declared length is refused', () => {
        const r = q("INSERT INTO v33_d VALUES (1,'abcdefgh')");
        return !!r.error && /too long/i.test(r.error);
      });
      fn('V33Dec a refused row is not stored', () =>
        one("SELECT COUNT(*) FROM v33_d") === 1);
      fn('V33Dec UPDATE is held to the same rules', () => {
        const ok = q("UPDATE v33_d SET price = 9.999");
        const bad = q("UPDATE v33_d SET code = 'abcdefgh'");
        return !ok.error && one("SELECT price FROM v33_d") === 10
            && !!bad.error && one("SELECT code FROM v33_d") === 'abc';
      });
      fn('V33Dec the declared spec survives a column rename', () => {
        q("ALTER TABLE v33_d RENAME COLUMN price TO cost");
        q("UPDATE v33_d SET cost = 2.345");
        return one("SELECT cost FROM v33_d") === 2.35;
      });
      fn('V33Dec the declared spec survives snapshot / restore', () => {
        q("DROP TABLE IF EXISTS v33_d3");
        q("CREATE TABLE v33_d3 (v DECIMAL(6,1))");
        q("CREATE SNAPSHOT v33_snap");
        q("INSERT INTO v33_d3 VALUES (1.26)");
        q("RESTORE SNAPSHOT v33_snap");
        q("INSERT INTO v33_d3 VALUES (1.26)");
        return one("SELECT v FROM v33_d3") === 1.3;
      });
      fn('V33Dec the declared spec survives an IDB export / import round trip', () => {
        q("DROP TABLE IF EXISTS v33_d4");
        q("CREATE TABLE v33_d4 (v DECIMAL(8,3))");
        const dump = db.exportForIDB();
        const probe = new DatabaseEngine();
        probe.importFromIDB(dump);
        probe.executeQuery("INSERT INTO v33_d4 VALUES (1.23456)");
        const r = probe.executeQuery("SELECT v FROM v33_d4");
        return !r.error && r.data[0].v === 1.235;
      });
      fn('V33Dec columns without a spec are unaffected', () => {
        q("DROP TABLE IF EXISTS v33_d5");
        q("CREATE TABLE v33_d5 (a FLOAT, b TEXT, c DECIMAL)");
        const long = 'a very long piece of text indeed';
        q(`INSERT INTO v33_d5 VALUES (1.23456789,'${long}',9.87654)`);
        const r = q("SELECT a, b, c FROM v33_d5");
        return !r.error && r.data[0].a === 1.23456789
            && r.data[0].b === long && r.data[0].c === 9.87654;
      });

      // ============================================================
      // G. 述語の押し下げ（結合より前に基底表を絞る）
      // ============================================================
      fn('V33Pd setup', () => {
        q("DROP TABLE IF EXISTS v33_l"); q("DROP TABLE IF EXISTS v33_r");
        q("CREATE TABLE v33_l (id INT PRIMARY KEY, k INT, lv TEXT)");
        q("CREATE TABLE v33_r (id INT PRIMARY KEY, k INT, rv TEXT)");
        q("INSERT INTO v33_l VALUES (1,10,'a'),(2,20,'b'),(3,30,'c'),(4,NULL,'d')");
        q("INSERT INTO v33_r VALUES (1,10,'x'),(2,20,'y'),(5,50,'z')");
        return db.tables['v33_l'].rowCount === 4;
      });
      fn('V33Pd EXPLAIN shows the base predicate pushed before the join', () => {
        const p = plan("EXPLAIN SELECT v33_l.id FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3");
        return !!p && p.some(x => x.Operation === 'FILTER (pushed down)');
      });
      fn('V33Pd a predicate on the joined table stays after the join', () => {
        const o = ops("EXPLAIN SELECT v33_l.id FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_r.rv = 'y'");
        return o.includes('FILTER') && !o.includes('FILTER (pushed down)');
      });
      fn('V33Pd a mixed predicate splits into both steps', () => {
        const o = ops("EXPLAIN SELECT v33_l.id FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3 AND v33_r.rv = 'y'");
        return o.includes('FILTER (pushed down)') && o.includes('FILTER');
      });
      fn('V33Pd a top-level OR is not pushed down', () => {
        const o = ops("EXPLAIN SELECT v33_l.id FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3 OR v33_r.rv = 'y'");
        return !o.includes('FILTER (pushed down)');
      });
      fn('V33Pd RIGHT / FULL joins are never pushed down', () => {
        const a = ops("EXPLAIN SELECT v33_l.id FROM v33_l RIGHT JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3");
        const b = ops("EXPLAIN SELECT v33_l.id FROM v33_l FULL JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3");
        return !a.includes('FILTER (pushed down)') && !b.includes('FILTER (pushed down)');
      });
      // 結果が押し下げで変わらないこと（INNER / LEFT / RIGHT / FULL の 4 通り）
      fn('V33Pd INNER join results are unchanged', () => {
        const r = q("SELECT v33_l.id AS lid, v33_r.id AS rid FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3 ORDER BY lid");
        return !r.error && JSON.stringify(r.data) === JSON.stringify([{ lid: 1, rid: 1 }, { lid: 2, rid: 2 }]);
      });
      fn('V33Pd LEFT join keeps unmatched left rows', () => {
        const r = q("SELECT v33_l.id AS lid, v33_r.id AS rid FROM v33_l LEFT JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.lv = 'c' ORDER BY lid");
        return !r.error && JSON.stringify(r.data) === JSON.stringify([{ lid: 3, rid: null }]);
      });
      fn('V33Pd RIGHT join results are unchanged', () => {
        const r = q("SELECT v33_l.id AS lid, v33_r.id AS rid FROM v33_l RIGHT JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id < 3 ORDER BY lid");
        return !r.error && JSON.stringify(r.data) === JSON.stringify([{ lid: 1, rid: 1 }, { lid: 2, rid: 2 }]);
      });
      fn('V33Pd a correlated subquery in WHERE is not pushed down', () => {
        const r = q("SELECT v33_l.id AS lid FROM v33_l JOIN v33_r ON v33_l.k = v33_r.k WHERE v33_l.id IN (SELECT id FROM v33_r WHERE v33_r.k = v33_l.k) ORDER BY lid");
        return !r.error && r.data.length === 2;
      });
      fn('V33Pd an ambiguous column is still rejected (checked before the split)', () => {
        q("DROP TABLE IF EXISTS v33_amb1"); q("DROP TABLE IF EXISTS v33_amb2");
        q("CREATE TABLE v33_amb1 (id INT, amount INT)");
        q("CREATE TABLE v33_amb2 (id INT, amount INT)");
        q("INSERT INTO v33_amb1 VALUES (1,100)");
        q("INSERT INTO v33_amb2 VALUES (1,5)");
        const r = q("SELECT * FROM v33_amb1 a JOIN v33_amb2 b ON a.id = b.id WHERE amount > 50");
        return !!r.error && /ambiguous/i.test(r.error);
      });
      fn('V33Pd pushdown makes a selective join dramatically cheaper', () => {
        q("DROP TABLE IF EXISTS v33_big");
        q("CREATE TABLE v33_big (id INTEGER PRIMARY KEY, k INTEGER)");
        q("INSERT INTO v33_big SELECT n, n % 500 FROM GENERATE_SERIES(1, 20000) AS t(n)");
        q("CREATE INDEX v33_big_k ON v33_big(k)");
        const t0 = performance.now();
        const r = q("SELECT COUNT(*) AS c FROM v33_big a JOIN v33_big b ON a.k = b.k WHERE a.id < 50");
        const ms = performance.now() - t0;
        // id < 50 は 49 行、k = n % 500 なので同じキーの相手は 20000/500 = 40 行。
        // 49 * 40 = 1960。押し下げ前は 20000 行すべてを結合していたので桁違いに遅かった。
        // 環境差を吸収するため緩い上限（2 秒）だけを見る
        return !r.error && r.data[0].c === 1960 && ms < 2000;
      });

      // ============================================================
      // H. 空の結果でも列名の誤りを検出する
      // ============================================================
      fn('V33Col a bad column on an empty table errors instead of returning 0 rows', () => {
        q("DROP TABLE IF EXISTS v33_em");
        q("CREATE TABLE v33_em (a INT, b TEXT)");
        const r = q("SELECT nosuchcol FROM v33_em");
        return !!r.error && /not found/i.test(r.error);
      });
      fn('V33Col a bad column inside an aggregate is caught too', () => {
        const r = q("SELECT SUM(nosuchcol) AS s FROM v33_em");
        return !!r.error && /not found/i.test(r.error);
      });
      fn('V33Col a bad column is caught when a filter empties the result', () => {
        q("INSERT INTO v33_em VALUES (1,'x')");
        const r = q("SELECT nosuchcol FROM v33_em WHERE a > 99");
        return !!r.error && /not found/i.test(r.error);
      });
      fn('V33Col valid columns on an empty result still return 0 rows', () => {
        const r = q("SELECT a, b, UPPER(b) AS u FROM v33_em WHERE a > 99");
        return !r.error && r.data.length === 0;
      });
      fn('V33Col an aggregate over an empty result still returns its row', () => {
        const r = q("SELECT COUNT(*) AS c, COALESCE(SUM(a), 0) AS s FROM v33_em WHERE a > 99");
        return !r.error && r.data[0].c === 0 && r.data[0].s === 0;
      });

      // ============================================================
      // I. エラーメッセージに内部トークンを出さない
      // ============================================================
      fn('V33Err a double-quoted table name explains itself', () => {
        const r = q('SELECT * FROM "some table"');
        return !!r.error && !/__str_/i.test(r.error)
            && r.error.includes('some table') && /backtick/i.test(r.error);
      });
      fn('V33Err a genuinely missing table keeps the plain message', () => {
        const r = q("SELECT * FROM v33_definitely_missing");
        return !!r.error && /not found/i.test(r.error) && !/backtick/i.test(r.error);
      });
      fn('V33Err backticks let a reserved word be an identifier', () => {
        q("DROP TABLE IF EXISTS v33_bq");
        const c = q("CREATE TABLE v33_bq (`order` INT, `select` TEXT)");
        const i = q("INSERT INTO v33_bq (`order`, `select`) VALUES (1,'x')");
        const s = q("SELECT `order` FROM v33_bq");
        q("DROP TABLE IF EXISTS v33_bq");
        return !c.error && !i.error && !s.error && s.data[0].order === 1;
      });
      fn('V33Err a name with a space is refused with an explanation', () => {
        // バックティックは予約語のためのもので、空白入りの名前は許さない
        const r = q("CREATE TABLE `v33 spaced` (a INT)");
        return !!r.error && /only letters, digits and underscores/i.test(r.error);
      });

      // ============================================================
      // 片付け
      // ============================================================
      fn('V33Zz cleanup', () => {
        ['v33_o','v33_p','v33_q','v33_ag','v33_cn','v33_bx','v33_sx',
         'v33_ck','v33_ck2','v33_ck3','v33_e',
         'v33_d','v33_d2','v33_d3','v33_d4','v33_d5',
         'v33_l','v33_r','v33_amb1','v33_amb2','v33_big','v33_em']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        db.executeQuery("DROP SNAPSHOT v33_snap");
        return true;
      });

      return T;
    }
