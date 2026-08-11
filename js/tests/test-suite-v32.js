    // ============================================================================
    // [Test Suite v32] - v1.27 の修正・追加のテスト
    //
    //   この回の主題は「エラーにならず黙って壊す／黙って誤る」箇所の一斉修正。
    //   12 方向の監査で再現できた欠陥だけを対象にしている。
    //
    //   A. データを失う・原子性が壊れる
    //     A1 失敗した REPLACE INTO が「削除だけ」を残していた
    //     A2 TRUNCATE が外部キーを一切見ず、子行を親の無い状態にできた
    //     A3 UPDATE の undo ログが ON UPDATE CURRENT_TIMESTAMP と生成列を
    //        退避しておらず、ROLLBACK で値が消える／古い値が残る
    //     A4 AFTER トリガーの失敗で「文はエラーなのに変更は残る」
    //     A5 FK ON UPDATE CASCADE の波及値が子表の CHECK/UNIQUE/NOT NULL を
    //        通っていなかった
    //
    //   B. 問い合わせ・型の誤り
    //     B1 EXPLAIN が SELECT 以外を **実行** していた（EXPLAIN DELETE でデータが消える）
    //     B2 JOIN の ON に無い列を書いても検証されず 0 件／右側全 NULL になった
    //     B3 別名の無い式の列名に内部トークン __STR_n__ が露出した
    //     B4 スカラーサブクエリが 2 行以上返しても先頭行を黙って採用した
    //     B5 サブクエリを畳んだ IN の値リストから NULL が消え、`NOT IN` が
    //        SQL 標準と違う行を返した（リテラル形は正しかった）
    //     B6 相関 NOT IN が 3 値論理になっていなかった
    //     B7 AVG が常に小数 2 桁へ丸められ、小さい値が 0 になった
    //     B8 SUM/AVG が BOOLEAN と数値文字列を黙って 0 として扱った
    //     B9 DATE(x) が時刻を落とさず、ローカル時刻解釈で日付境界がずれた
    //     B10 TIME 値を HOUR/MINUTE/SECOND/EXTRACT が読めなかった
    //     B11 `=`/`<>` だけが型変換をせず、`<`/`>` と食い違った（索引経路も）
    //     B12 CHAR_LENGTH/SUBSTRING/LEFT/RIGHT/REVERSE がサロゲートペアを割った
    //     B13 サブクエリの列数不一致を黙って捨てた
    //     B14 空の WHERE と WHERE 内の集計が判らないエラーになっていた
    //     B15 CHECK の中のサブクエリが定義時の結果へ凍結された
    //     B16 一意でない列を参照する FK を許し、CASCADE が生きた子行を消した
    //
    //   C. トランザクション文
    //     C1 ROLLBACK WORK / ROLLBACK TRANSACTION を拒否した上に開いたままにした
    //     C2 RELEASE SAVEPOINT が後続のセーブポイントを消さなかった
    //
    //   D. ブラウザ DB として足りなかったもの
    //     D1 SET FOREIGN_KEY_CHECKS（相互参照する表への初回投入・一括取り込み）
    //     D2 ディスク上のファイルとして開く / 保存する（File System Access API）
    //
    //   E. 画面
    //     E1 Tailwind CDN が読めないと全モーダルが開いた状態で積まれ操作不能になった
    //     E2 複数文スクリプトで別の文の結果を「答え」として出した
    //     E3 Result という別名の列があるだけで書き出しが無効化された
    //     E4 補完が `t.` の後ろで何も出さず、無関係な表の列を混ぜた
    //     E5 編集可セルのダブルクリックで詳細モーダルが編集を壊した
    //     E6 セルの文字列内容で「状態色」を塗り、ただのデータを成功/失敗色にした
    //
    //   test-suite.js の tests 配列へ getV32Tests() のスプレッドで合流する
    // ============================================================================
    function getV32Tests() {
      const T = [];
      const push = (name, sql, check) => T.push({ name, sql, check });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const fn = (name, f) => T.push({ name, fn: f });
      const one = (sql) => { const r = db.executeQuery(sql); return r.error ? { __err: r.error } : Object.values(r.data[0])[0]; };
      const col = (sql, k) => { const r = db.executeQuery(sql); return r.error ? ['ERR:' + r.error] : r.data.map(x => x[k]); };
      const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
      const q = (sql) => db.executeQuery(sql);

      // ============================================================
      // A1. 失敗した REPLACE INTO は表を変えない
      // ============================================================
      fn('V32Rep failed REPLACE keeps the old row (CHECK)', () => {
        q("DROP TABLE IF EXISTS v32_rep");
        q("CREATE TABLE v32_rep (id INT PRIMARY KEY, v INT CHECK (v > 0))");
        q("INSERT INTO v32_rep VALUES (1,5),(2,6)");
        const bad = q("REPLACE INTO v32_rep VALUES (1,-9)");
        const rows = col("SELECT v FROM v32_rep ORDER BY id", 'v');
        return !!bad.error && rows.join() === '5,6';
      });
      fn('V32Rep failed REPLACE keeps the old row (FK)', () => {
        q("DROP TABLE IF EXISTS v32_rf"); q("DROP TABLE IF EXISTS v32_rp");
        q("CREATE TABLE v32_rp (id INT PRIMARY KEY)");
        q("INSERT INTO v32_rp VALUES (7)");
        q("CREATE TABLE v32_rf (id INT PRIMARY KEY, pid INT REFERENCES v32_rp(id))");
        q("INSERT INTO v32_rf VALUES (1,7)");
        const bad = q("REPLACE INTO v32_rf VALUES (1,999)");
        const rows = col("SELECT pid FROM v32_rf", 'pid');
        return !!bad.error && rows.join() === '7';
      });
      fn('V32Rep successful REPLACE still replaces', () => {
        q("DROP TABLE IF EXISTS v32_rep2");
        q("CREATE TABLE v32_rep2 (id INT PRIMARY KEY, v INT CHECK (v > 0))");
        q("INSERT INTO v32_rep2 VALUES (1,5),(2,6)");
        const ok = q("REPLACE INTO v32_rep2 VALUES (1,77)");
        return !ok.error && col("SELECT v FROM v32_rep2 ORDER BY id", 'v').join() === '77,6';
      });

      // ============================================================
      // A2. TRUNCATE と外部キー（既定 RESTRICT / CASCADE / 自己参照）
      // ============================================================
      fn('V32Trn TRUNCATE is refused while a child references the table', () => {
        q("DROP TABLE IF EXISTS v32_tc"); q("DROP TABLE IF EXISTS v32_tp");
        q("CREATE TABLE v32_tp (id INT PRIMARY KEY)");
        q("INSERT INTO v32_tp VALUES (1),(2)");
        q("CREATE TABLE v32_tc (id INT PRIMARY KEY, pid INT REFERENCES v32_tp(id))");
        q("INSERT INTO v32_tc VALUES (10,1),(20,2)");
        const bad = q("TRUNCATE TABLE v32_tp");
        return !!bad.error && /referenced by a foreign key/i.test(bad.error)
            && one("SELECT COUNT(*) FROM v32_tp") === 2
            && one("SELECT COUNT(*) FROM v32_tc") === 2;
      });
      fn('V32Trn TRUNCATE CASCADE empties the children too', () => {
        const ok = q("TRUNCATE TABLE v32_tp CASCADE");
        return !ok.error && one("SELECT COUNT(*) FROM v32_tp") === 0
            && one("SELECT COUNT(*) FROM v32_tc") === 0;
      });
      fn('V32Trn a self-referencing table can still be truncated', () => {
        q("DROP TABLE IF EXISTS v32_ts");
        q("CREATE TABLE v32_ts (id INT PRIMARY KEY, par INT REFERENCES v32_ts(id))");
        q("INSERT INTO v32_ts VALUES (1,NULL),(2,1)");
        const ok = q("TRUNCATE TABLE v32_ts");
        return !ok.error && one("SELECT COUNT(*) FROM v32_ts") === 0;
      });

      // ============================================================
      // A3. ROLLBACK が ON UPDATE CURRENT_TIMESTAMP と生成列も戻す
      // ============================================================
      fn('V32Undo ROLLBACK restores an ON UPDATE CURRENT_TIMESTAMP column', () => {
        q("DROP TABLE IF EXISTS v32_ts2");
        q("CREATE TABLE v32_ts2 (id INT PRIMARY KEY, v INT, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)");
        q("INSERT INTO v32_ts2 (id,v,ts) VALUES (1,1,'2000-01-01 00:00:00')");
        q("BEGIN"); q("UPDATE v32_ts2 SET v = 99 WHERE id = 1"); q("ROLLBACK");
        return one("SELECT ts FROM v32_ts2") === '2000-01-01 00:00:00' && one("SELECT v FROM v32_ts2") === 1;
      });
      fn('V32Undo ROLLBACK restores a generated column consistently', () => {
        q("DROP TABLE IF EXISTS v32_gen");
        q("CREATE TABLE v32_gen (id INT PRIMARY KEY, a INT, b INT UNIQUE GENERATED ALWAYS AS (a*2))");
        q("INSERT INTO v32_gen (id,a) VALUES (1,5),(2,7)");
        q("BEGIN"); q("UPDATE v32_gen SET a = 7 WHERE id = 1"); q("ROLLBACK");
        const r = q("SELECT a, b FROM v32_gen ORDER BY id");
        return !r.error && r.data.length === 2
            && r.data[0].a === 5 && r.data[0].b === 10
            && r.data[1].a === 7 && r.data[1].b === 14;
      });
      fn('V32Undo ROLLBACK TO SAVEPOINT restores the touch column too', () => {
        q("DROP TABLE IF EXISTS v32_ts3");
        q("CREATE TABLE v32_ts3 (id INT PRIMARY KEY, v INT, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)");
        q("INSERT INTO v32_ts3 (id,v,ts) VALUES (1,1,'2000-01-01 00:00:00')");
        q("BEGIN"); q("SAVEPOINT sp");
        q("UPDATE v32_ts3 SET v = 99 WHERE id = 1");
        q("ROLLBACK TO SAVEPOINT sp"); q("COMMIT");
        return one("SELECT ts FROM v32_ts3") === '2000-01-01 00:00:00';
      });

      // ============================================================
      // A4. AFTER トリガーの失敗で文全体が巻き戻る
      // ============================================================
      fn('V32Trg a failing AFTER UPDATE trigger rolls the UPDATE back', () => {
        q("DROP TRIGGER IF EXISTS v32_au");
        q("DROP TABLE IF EXISTS v32_tt"); q("DROP TABLE IF EXISTS v32_ta");
        q("CREATE TABLE v32_tt (id INT PRIMARY KEY, v INT)");
        q("INSERT INTO v32_tt VALUES (1,10),(2,20)");
        q("CREATE TABLE v32_ta (id INT PRIMARY KEY, note TEXT)");
        q("INSERT INTO v32_ta VALUES (99,'seed')");
        q("CREATE TRIGGER v32_au AFTER UPDATE ON v32_tt FOR EACH ROW BEGIN INSERT INTO v32_ta VALUES (99,'dup'); END");
        const bad = q("UPDATE v32_tt SET v = v + 1 WHERE id = 1");
        const kept = col("SELECT v FROM v32_tt ORDER BY id", 'v').join() === '10,20';
        const audit = one("SELECT COUNT(*) FROM v32_ta") === 1;
        q("DROP TRIGGER v32_au");
        return !!bad.error && kept && audit;
      });
      fn('V32Trg a failing AFTER INSERT trigger rolls the INSERT back', () => {
        q("DROP TRIGGER IF EXISTS v32_ai");
        q("DROP TABLE IF EXISTS v32_it"); q("DROP TABLE IF EXISTS v32_ia");
        q("CREATE TABLE v32_it (id INT PRIMARY KEY, v INT)");
        q("CREATE TABLE v32_ia (id INT PRIMARY KEY, note TEXT)");
        q("INSERT INTO v32_ia VALUES (99,'seed')");
        q("CREATE TRIGGER v32_ai AFTER INSERT ON v32_it FOR EACH ROW BEGIN INSERT INTO v32_ia VALUES (99,'dup'); END");
        const bad = q("INSERT INTO v32_it VALUES (1,10)");
        const empty = one("SELECT COUNT(*) FROM v32_it") === 0;
        const audit = one("SELECT COUNT(*) FROM v32_ia") === 1;
        q("DROP TRIGGER v32_ai");
        return !!bad.error && empty && audit;
      });
      fn('V32Trg a succeeding AFTER trigger still commits both writes', () => {
        q("DROP TRIGGER IF EXISTS v32_ok");
        q("DROP TABLE IF EXISTS v32_okt"); q("DROP TABLE IF EXISTS v32_oka");
        q("CREATE TABLE v32_okt (id INT PRIMARY KEY, v INT)");
        q("CREATE TABLE v32_oka (id INT PRIMARY KEY AUTO_INCREMENT, note TEXT)");
        q("CREATE TRIGGER v32_ok AFTER INSERT ON v32_okt FOR EACH ROW BEGIN INSERT INTO v32_oka (note) VALUES ('ins'); END");
        const ok = q("INSERT INTO v32_okt VALUES (1,10)");
        const res = !ok.error && one("SELECT COUNT(*) FROM v32_okt") === 1 && one("SELECT COUNT(*) FROM v32_oka") === 1;
        q("DROP TRIGGER v32_ok");
        return res;
      });

      // ============================================================
      // A5. FK ON UPDATE CASCADE の波及値も子表の制約を通る
      // ============================================================
      fn('V32Csc CASCADE that breaks a child CHECK is refused atomically', () => {
        q("DROP TABLE IF EXISTS v32_cc"); q("DROP TABLE IF EXISTS v32_cp");
        q("CREATE TABLE v32_cp (id INT PRIMARY KEY)");
        q("INSERT INTO v32_cp VALUES (1),(2)");
        q("CREATE TABLE v32_cc (cid INT PRIMARY KEY, pid INT CHECK (pid < 100), FOREIGN KEY (pid) REFERENCES v32_cp(id) ON UPDATE CASCADE)");
        q("INSERT INTO v32_cc VALUES (10,1),(20,2)");
        const bad = q("UPDATE v32_cp SET id = 500 WHERE id = 1");
        // 親も子も変わっていないこと（後から throw して親だけ書き換わるのは不可）
        return !!bad.error
            && col("SELECT id FROM v32_cp ORDER BY id", 'id').join() === '1,2'
            && col("SELECT pid FROM v32_cc ORDER BY cid", 'pid').join() === '1,2';
      });
      fn('V32Csc a CASCADE within the CHECK still propagates', () => {
        const ok = q("UPDATE v32_cp SET id = 50 WHERE id = 1");
        return !ok.error
            && col("SELECT id FROM v32_cp ORDER BY id", 'id').join() === '2,50'
            && col("SELECT pid FROM v32_cc ORDER BY cid", 'pid').join() === '50,2';
      });

      // ============================================================
      // B1. EXPLAIN は SELECT 以外を実行しない
      // ============================================================
      fn('V32Exp EXPLAIN DELETE does not delete', () => {
        q("DROP TABLE IF EXISTS v32_ex");
        q("CREATE TABLE v32_ex (id INT, amount INT)");
        q("INSERT INTO v32_ex VALUES (1,10),(2,20),(3,30)");
        const bad = q("EXPLAIN DELETE FROM v32_ex WHERE id=1");
        return !!bad.error && /select statements only/i.test(bad.error)
            && one("SELECT COUNT(*) FROM v32_ex") === 3;
      });
      err('V32Exp EXPLAIN DROP TABLE is refused', "EXPLAIN DROP TABLE v32_ex", 'select statements only');
      err('V32Exp EXPLAIN UPDATE is refused', "EXPLAIN UPDATE v32_ex SET amount = 0", 'select statements only');
      err('V32Exp EXPLAIN INSERT is refused', "EXPLAIN INSERT INTO v32_ex VALUES (9,9)", 'select statements only');
      err('V32Exp EXPLAIN TRUNCATE is refused', "EXPLAIN TRUNCATE TABLE v32_ex", 'select statements only');
      fn('V32Exp the table survived every refused EXPLAIN', () =>
        one("SELECT COUNT(*) FROM v32_ex") === 3);
      fn('V32Exp EXPLAIN SELECT still returns a plan', () => {
        const r = q("EXPLAIN SELECT * FROM v32_ex");
        return !r.error && r.data.length > 0 && r.data[0].Operation === 'TABLE SCAN';
      });

      // ============================================================
      // B2. JOIN の ON に無い列はエラー
      // ============================================================
      fn('V32On an unknown column in an equi-join ON is rejected', () => {
        q("DROP TABLE IF EXISTS v32_j1"); q("DROP TABLE IF EXISTS v32_j2");
        q("CREATE TABLE v32_j1 (id INT, v INT)");
        q("CREATE TABLE v32_j2 (id INT, w INT)");
        q("INSERT INTO v32_j1 VALUES (1,10),(2,20)");
        q("INSERT INTO v32_j2 VALUES (1,7),(2,8)");
        const bad = q("SELECT * FROM v32_j1 a JOIN v32_j2 b ON a.id = b.typo_id");
        return !!bad.error && /typo_id/.test(bad.error);
      });
      err('V32On an unknown left column in ON is rejected',
        "SELECT * FROM v32_j1 a JOIN v32_j2 b ON a.nosuch = b.id", 'nosuch');
      fn('V32On LEFT JOIN with a bad ON column errors instead of all-NULL rows', () => {
        const bad = q("SELECT * FROM v32_j1 a LEFT JOIN v32_j2 b ON a.id = b.typo_id");
        return !!bad.error;
      });
      fn('V32On a valid equi-join still works', () => {
        const r = q("SELECT a.v, b.w FROM v32_j1 a JOIN v32_j2 b ON a.id = b.id ORDER BY a.v");
        return !r.error && r.data.length === 2 && r.data[0].v === 10 && r.data[0].w === 7;
      });

      // ============================================================
      // B3. 別名の無い式の列名に内部トークンを出さない
      // ============================================================
      fn('V32Hdr an unaliased expression header keeps its string literal', () => {
        q("DROP TABLE IF EXISTS v32_h");
        q("CREATE TABLE v32_h (f TEXT, l TEXT)");
        q("INSERT INTO v32_h VALUES ('Ada','Lovelace')");
        const r = q("SELECT CONCAT(f, ' ', l) FROM v32_h");
        const k = Object.keys(r.data[0])[0];
        return !/__STR_/.test(k) && k === "CONCAT(f, ' ', l)";
      });
      fn('V32Hdr CASE / COALESCE / concat headers have no token', () => {
        const ks = ["SELECT CASE WHEN f='Ada' THEN 'yes' ELSE 'no' END FROM v32_h",
                    "SELECT COALESCE(f,'none') FROM v32_h",
                    "SELECT f || ' ' || l FROM v32_h",
                    "SELECT UPPER('abc') FROM v32_h"]
            .map(s => Object.keys(q(s).data[0])[0]);
        return ks.every(k => !/__STR_/.test(k));
      });
      fn('V32Hdr a bare string literal column is still columnN', () =>
        Object.keys(q("SELECT 'lit' FROM v32_h").data[0])[0] === 'column1');

      // ============================================================
      // B4/B13. スカラーサブクエリの行数・列数
      // ============================================================
      fn('V32Sub a scalar subquery returning 2 rows errors', () => {
        q("DROP TABLE IF EXISTS v32_s");
        q("CREATE TABLE v32_s (a INT, b INT)");
        q("INSERT INTO v32_s VALUES (1,10),(2,20),(3,NULL)");
        const bad = q("SELECT (SELECT a FROM v32_s) AS s");
        return !!bad.error && /more than 1 row/i.test(bad.error);
      });
      fn('V32Sub a correlated scalar subquery returning 2 rows errors', () => {
        const bad = q("SELECT a, (SELECT b FROM v32_s x WHERE x.a >= v32_s.a) AS m FROM v32_s");
        return !!bad.error && /more than 1 row/i.test(bad.error);
      });
      fn('V32Sub a one-row scalar subquery still works', () =>
        one("SELECT (SELECT a FROM v32_s WHERE a=1) AS s") === 1);
      fn('V32Sub an empty scalar subquery is NULL', () =>
        one("SELECT (SELECT a FROM v32_s WHERE a=99) AS s") === null);
      err('V32Sub a 2-column subquery in IN is rejected',
        "SELECT * FROM v32_s WHERE a IN (SELECT a, b FROM v32_s)", 'should contain 1 column');
      err('V32Sub a 2-column scalar subquery is rejected',
        "SELECT (SELECT a, b FROM v32_s LIMIT 1) AS s", 'should contain 1 column');
      fn('V32Sub a row constructor IN still accepts 2 columns', () => {
        // (3, NULL) を含む行は 3 値論理で UNKNOWN になるので一致しない（SQL 標準）。
        // 列数チェックが行コンストラクタ形を誤って弾いていないことがここの主眼
        const r = q("SELECT * FROM v32_s WHERE (a,b) IN (SELECT a,b FROM v32_s) ORDER BY a");
        return !r.error && r.data.length === 2 && r.data[0].a === 1 && r.data[1].a === 2;
      });

      // ============================================================
      // B5/B6. サブクエリ由来の IN リストの NULL と 3 値論理
      // ============================================================
      fn('V32Nin NOT IN over a subquery containing NULL returns no rows', () => {
        q("DROP TABLE IF EXISTS v32_n1"); q("DROP TABLE IF EXISTS v32_n2");
        q("CREATE TABLE v32_n1 (a INT)"); q("CREATE TABLE v32_n2 (b INT)");
        q("INSERT INTO v32_n1 VALUES (1),(2),(3)");
        q("INSERT INTO v32_n2 VALUES (2),(NULL)");
        const r = q("SELECT a FROM v32_n1 WHERE a NOT IN (SELECT b FROM v32_n2)");
        return !r.error && r.data.length === 0;
      });
      fn('V32Nin the literal form already agreed and still does', () =>
        q("SELECT a FROM v32_n1 WHERE a NOT IN (2, NULL)").data.length === 0);
      fn('V32Nin IN over the same subquery matches the non-NULL value', () =>
        col("SELECT a FROM v32_n1 WHERE a IN (SELECT b FROM v32_n2)", 'a').join() === '2');
      fn('V32Nin NOT IN without NULLs behaves normally', () =>
        col("SELECT a FROM v32_n1 WHERE a NOT IN (SELECT b FROM v32_n2 WHERE b IS NOT NULL)", 'a').join() === '1,3');
      fn('V32Nin quantified comparison over the subquery still works', () =>
        col("SELECT a FROM v32_n1 WHERE a > ALL (SELECT b FROM v32_n2 WHERE b IS NOT NULL)", 'a').join() === '3');

      // ============================================================
      // B7/B8. AVG の精度と SUM/AVG の型変換
      // ============================================================
      fn('V32Agg AVG keeps full double precision', () => {
        q("DROP TABLE IF EXISTS v32_a");
        q("CREATE TABLE v32_a (x FLOAT)");
        q("INSERT INTO v32_a VALUES (1),(2),(2)");
        return near(one("SELECT AVG(x) FROM v32_a"), 5 / 3);
      });
      fn('V32Agg tiny values no longer collapse to 0', () => {
        q("DROP TABLE IF EXISTS v32_a2");
        q("CREATE TABLE v32_a2 (x FLOAT)");
        q("INSERT INTO v32_a2 VALUES (0.000001),(0.000002)");
        return near(one("SELECT AVG(x) FROM v32_a2"), 0.0000015);
      });
      fn('V32Agg ROUND(AVG(x),2) is how you ask for 2 decimals', () =>
        one("SELECT ROUND(AVG(x),2) FROM v32_a") === 1.67);
      fn('V32Agg a window AVG is full precision too', () => {
        const v = col("SELECT AVG(x) OVER () AS w FROM v32_a", 'w');
        return v.length === 3 && v.every(x => near(x, 5 / 3));
      });
      fn('V32Agg SUM/AVG count BOOLEAN as 1/0', () => {
        q("DROP TABLE IF EXISTS v32_b");
        q("CREATE TABLE v32_b (id INT, ok BOOLEAN)");
        q("INSERT INTO v32_b VALUES (1,TRUE),(2,TRUE),(3,FALSE)");
        return one("SELECT SUM(ok) FROM v32_b") === 2
            && near(one("SELECT AVG(ok) FROM v32_b"), 2 / 3)
            && one("SELECT COUNT(ok) FROM v32_b") === 3;
      });
      fn('V32Agg SUM/AVG read numeric strings (typical after CSV import)', () => {
        q("DROP TABLE IF EXISTS v32_t");
        q("CREATE TABLE v32_t (v TEXT)");
        q("INSERT INTO v32_t VALUES ('10'),('20'),('30')");
        return one("SELECT SUM(v) FROM v32_t") === 60 && one("SELECT AVG(v) FROM v32_t") === 20;
      });
      fn('V32Agg non-numeric text is still skipped, not counted as 0', () => {
        q("DROP TABLE IF EXISTS v32_t2");
        q("CREATE TABLE v32_t2 (v TEXT)");
        q("INSERT INTO v32_t2 VALUES ('10'),('abc'),(''),(NULL),('20')");
        return one("SELECT SUM(v) FROM v32_t2") === 30 && one("SELECT AVG(v) FROM v32_t2") === 15;
      });

      // ============================================================
      // B9/B10. DATE() の切り捨てと TIME 値の読み取り
      // ============================================================
      fn('V32Dt DATE(x) truncates to a date', () =>
        one("SELECT DATE('2024-03-15 23:30:00') AS d") === '2024-03-15');
      fn('V32Dt DATE(x) on a date-only value is unchanged', () =>
        one("SELECT DATE('2024-03-15') AS d") === '2024-03-15');
      fn('V32Dt GROUP BY DATE(ts) buckets by calendar day, not local time', () => {
        q("DROP TABLE IF EXISTS v32_o");
        q("CREATE TABLE v32_o (ts DATETIME, amt FLOAT)");
        q("INSERT INTO v32_o VALUES ('2024-03-15 08:00:00',10),('2024-03-15 23:30:00',20),('2024-03-16 01:00:00',30)");
        const r = q("SELECT DATE(ts) AS d, SUM(amt) AS s FROM v32_o GROUP BY DATE(ts) ORDER BY d");
        return !r.error && r.data.length === 2
            && r.data[0].d === '2024-03-15' && r.data[0].s === 30
            && r.data[1].d === '2024-03-16' && r.data[1].s === 30;
      });
      fn('V32Tm HOUR/MINUTE/SECOND read a TIME value', () => {
        const r = q("SELECT HOUR('12:34:56') AS h, MINUTE('12:34:56') AS mi, SECOND('12:34:56') AS s");
        return !r.error && r.data[0].h === 12 && r.data[0].mi === 34 && r.data[0].s === 56;
      });
      fn('V32Tm EXTRACT(HOUR FROM time) works', () =>
        one("SELECT EXTRACT(HOUR FROM '12:34:56') AS e") === 12);
      fn('V32Tm HOUR(SEC_TO_TIME(x)) round-trips', () =>
        one("SELECT HOUR(SEC_TO_TIME(45296)) AS h") === 12);
      fn('V32Tm a TIME column is readable', () => {
        q("DROP TABLE IF EXISTS v32_tm");
        q("CREATE TABLE v32_tm (t TIME)");
        q("INSERT INTO v32_tm VALUES ('12:34:56')");
        return one("SELECT HOUR(t) FROM v32_tm") === 12;
      });
      fn('V32Tm YEAR of a time-only value is NULL (MySQL)', () =>
        one("SELECT YEAR('12:34:56') AS y") === null);
      fn('V32Tm dates still report their fields', () => {
        const r = q("SELECT YEAR('2024-03-15') AS y, MONTH('2024-03-15') AS m, HOUR('2024-03-15 08:00:00') AS h");
        return r.data[0].y === 2024 && r.data[0].m === 3 && r.data[0].h === 8;
      });

      // ============================================================
      // B11. 6 つの比較演算子が同じ型変換をする
      // ============================================================
      fn('V32Cmp boolean column = 1 matches the true rows', () => {
        q("DROP TABLE IF EXISTS v32_c");
        q("CREATE TABLE v32_c (id INT, ok BOOLEAN)");
        q("INSERT INTO v32_c VALUES (1,TRUE),(2,TRUE),(3,FALSE)");
        return one("SELECT COUNT(*) FROM v32_c WHERE ok = 1") === 2
            && one("SELECT COUNT(*) FROM v32_c WHERE ok = 0") === 1
            && one("SELECT COUNT(*) FROM v32_c WHERE ok = TRUE") === 2;
      });
      fn('V32Cmp the indexed path agrees with the scan path', () => {
        q("CREATE INDEX v32_ix_ok ON v32_c(ok)");
        const res = one("SELECT COUNT(*) FROM v32_c WHERE ok = 1") === 2
            && one("SELECT COUNT(*) FROM v32_c WHERE ok = 0") === 1;
        q("DROP INDEX v32_ix_ok");
        return res;
      });
      fn('V32Cmp = and >= agree on a numeric string', () => {
        const r = q("SELECT '10' = 10 AS eq, '10' >= 10 AS ge, TRUE = 1 AS beq, TRUE > 0 AS bgt");
        return r.data[0].eq === true && r.data[0].ge === true && r.data[0].beq === true && r.data[0].bgt === true;
      });
      fn('V32Cmp empty string is not equal to 0', () => {
        const r = q("SELECT '' = 0 AS e0, 'abc' = 0 AS t0");
        return r.data[0].e0 === false && r.data[0].t0 === false;
      });
      fn('V32Cmp same-type comparisons are unchanged', () => {
        const r = q("SELECT 'a' = 'a' AS s1, 'a' = 'b' AS s2, 1 = 1 AS n1, 'b' > 'a' AS s3");
        return r.data[0].s1 === true && r.data[0].s2 === false && r.data[0].n1 === true && r.data[0].s3 === true;
      });
      fn('V32Cmp NULL comparison is still UNKNOWN', () =>
        one("SELECT NULL = NULL AS n") === null);

      // ============================================================
      // B12. サロゲートペア（絵文字）を割らない
      // ============================================================
      fn('V32Uni CHAR_LENGTH counts an emoji as one character', () =>
        one("SELECT CHAR_LENGTH('\u{1F600}') AS c") === 1);
      fn('V32Uni LENGTH still reports UTF-16 units', () =>
        one("SELECT LENGTH('\u{1F600}') AS c") === 2);
      fn('V32Uni SUBSTRING steps over an emoji', () =>
        one("SELECT SUBSTRING('\u{1F600}abc',2,1) AS s") === 'a');
      fn('V32Uni REVERSE keeps the emoji intact', () =>
        one("SELECT REVERSE('ab\u{1F600}cd') AS r") === 'dc\u{1F600}ba');
      fn('V32Uni LEFT/RIGHT count characters', () => {
        const r = q("SELECT LEFT('\u{1F600}\u{1F600}abc',2) AS l, RIGHT('abc\u{1F600}',2) AS rr");
        return r.data[0].l === '\u{1F600}\u{1F600}' && r.data[0].rr === 'c\u{1F600}';
      });
      fn('V32Uni ASCII and Japanese are unaffected', () => {
        const r = q("SELECT CHAR_LENGTH('abc') AS a, CHAR_LENGTH('日本語') AS j, SUBSTRING('日本語テスト',2,2) AS s, REVERSE('abc') AS r");
        return r.data[0].a === 3 && r.data[0].j === 3 && r.data[0].s === '本語' && r.data[0].r === 'cba';
      });

      // ============================================================
      // B14. 空の WHERE / WHERE 内の集計
      // ============================================================
      fn('V32Whr an empty WHERE is a syntax error, not "all rows"', () => {
        q("DROP TABLE IF EXISTS v32_w");
        q("CREATE TABLE v32_w (a INT, b INT)");
        q("INSERT INTO v32_w VALUES (1,10),(2,20)");
        const bad = q("SELECT * FROM v32_w WHERE");
        return !!bad.error && /where has no condition/i.test(bad.error);
      });
      err('V32Whr an aggregate in WHERE names the real mistake',
        "SELECT * FROM v32_w WHERE SUM(b) > 5", 'aggregate function');
      err('V32Whr COUNT(*) in WHERE points at HAVING',
        "SELECT * FROM v32_w WHERE COUNT(*) > 1", 'having');
      fn('V32Whr HAVING with the same aggregate still works', () => {
        const r = q("SELECT a FROM v32_w GROUP BY a HAVING SUM(b) > 5 ORDER BY a");
        return !r.error && r.data.length === 2;
      });
      fn('V32Whr a normal WHERE is unaffected', () =>
        col("SELECT a FROM v32_w WHERE a > 1", 'a').join() === '2');

      // ============================================================
      // B15. CHECK の中のサブクエリは定義時に拒否
      // ============================================================
      fn('V32Chk a subquery in a column CHECK is rejected at CREATE', () => {
        q("DROP TABLE IF EXISTS v32_cs"); q("DROP TABLE IF EXISTS v32_cp2");
        q("CREATE TABLE v32_cp2 (id INT PRIMARY KEY)");
        q("INSERT INTO v32_cp2 VALUES (1)");
        const bad = q("CREATE TABLE v32_cs (v INT CHECK (v IN (SELECT id FROM v32_cp2)))");
        return !!bad.error && /cannot contain a subquery/i.test(bad.error) && !db.tables['v32_cs'];
      });
      fn('V32Chk a subquery in ALTER ... ADD CHECK is rejected', () => {
        q("DROP TABLE IF EXISTS v32_ca");
        q("CREATE TABLE v32_ca (v INT, w INT)");
        const bad = q("ALTER TABLE v32_ca ADD CONSTRAINT v32_k CHECK (w IN (SELECT id FROM v32_cp2))");
        return !!bad.error && /cannot contain a subquery/i.test(bad.error);
      });
      fn('V32Chk an ordinary CHECK still works', () => {
        const ok = q("ALTER TABLE v32_ca ADD CONSTRAINT v32_k2 CHECK (w < 100)");
        const good = q("INSERT INTO v32_ca VALUES (1, 50)");
        const bad = q("INSERT INTO v32_ca VALUES (2, 500)");
        return !ok.error && !good.error && !!bad.error;
      });
      fn('V32Chk CREATE TABLE AS SELECT is unaffected', () => {
        q("DROP TABLE IF EXISTS v32_ctas");
        const ok = q("CREATE TABLE v32_ctas AS SELECT id FROM v32_cp2");
        return !ok.error && one("SELECT COUNT(*) FROM v32_ctas") === 1;
      });

      // ============================================================
      // B16. FK の参照先には PK / UNIQUE が必要
      // ============================================================
      fn('V32Fk a FK to a non-unique column is rejected', () => {
        q("DROP TABLE IF EXISTS v32_fc"); q("DROP TABLE IF EXISTS v32_fp");
        q("CREATE TABLE v32_fp (x INT, tag TEXT)");
        q("INSERT INTO v32_fp VALUES (5,'a'),(5,'b')");
        const bad = q("CREATE TABLE v32_fc (y INT REFERENCES v32_fp(x) ON DELETE CASCADE)");
        return !!bad.error && /PRIMARY KEY or UNIQUE/i.test(bad.error) && !db.tables['v32_fc'];
      });
      fn('V32Fk a FK to a PRIMARY KEY is accepted', () => {
        q("DROP TABLE IF EXISTS v32_gc"); q("DROP TABLE IF EXISTS v32_gp");
        q("CREATE TABLE v32_gp (id INT PRIMARY KEY)");
        return !q("CREATE TABLE v32_gc (pid INT REFERENCES v32_gp(id))").error;
      });
      fn('V32Fk a FK to a UNIQUE column is accepted', () => {
        q("DROP TABLE IF EXISTS v32_uc"); q("DROP TABLE IF EXISTS v32_up");
        q("CREATE TABLE v32_up (u INT UNIQUE)");
        return !q("CREATE TABLE v32_uc (v INT REFERENCES v32_up(u))").error;
      });
      fn('V32Fk a self-referencing FK to its own PK is accepted', () => {
        q("DROP TABLE IF EXISTS v32_sr");
        return !q("CREATE TABLE v32_sr (id INT PRIMARY KEY, par INT REFERENCES v32_sr(id))").error;
      });
      fn('V32Fk a composite FK to a composite PK is accepted', () => {
        q("DROP TABLE IF EXISTS v32_kc"); q("DROP TABLE IF EXISTS v32_kp");
        q("CREATE TABLE v32_kp (a INT, b INT, PRIMARY KEY (a,b))");
        return !q("CREATE TABLE v32_kc (x INT, y INT, FOREIGN KEY (x,y) REFERENCES v32_kp(a,b))").error;
      });
      fn('V32Fk a composite FK to non-key columns is rejected', () => {
        q("DROP TABLE IF EXISTS v32_kc2"); q("DROP TABLE IF EXISTS v32_kp2");
        q("CREATE TABLE v32_kp2 (a INT PRIMARY KEY, b INT)");
        const bad = q("CREATE TABLE v32_kc2 (x INT, y INT, FOREIGN KEY (x,y) REFERENCES v32_kp2(a,b))");
        return !!bad.error && /PRIMARY KEY or UNIQUE/i.test(bad.error);
      });

      // ============================================================
      // C1/C2. トランザクション文
      // ============================================================
      fn('V32Tx ROLLBACK WORK rolls back', () => {
        q("DROP TABLE IF EXISTS v32_tx");
        q("CREATE TABLE v32_tx (id INT PRIMARY KEY)");
        q("INSERT INTO v32_tx VALUES (1)");
        q("BEGIN"); q("INSERT INTO v32_tx VALUES (2)");
        const r = q("ROLLBACK WORK");
        return !r.error && one("SELECT COUNT(*) FROM v32_tx") === 1 && !db.inTransaction;
      });
      fn('V32Tx ROLLBACK TRANSACTION rolls back', () => {
        q("BEGIN"); q("INSERT INTO v32_tx VALUES (3)");
        const r = q("ROLLBACK TRANSACTION");
        return !r.error && one("SELECT COUNT(*) FROM v32_tx") === 1 && !db.inTransaction;
      });
      fn('V32Tx COMMIT WORK commits', () => {
        q("BEGIN"); q("INSERT INTO v32_tx VALUES (4)");
        const r = q("COMMIT WORK");
        return !r.error && one("SELECT COUNT(*) FROM v32_tx") === 2 && !db.inTransaction;
      });
      fn('V32Tx an invalid transaction command says the tx is still open', () => {
        q("BEGIN");
        const bad = q("ROLLBACK NONSENSE");
        const stillOpen = db.inTransaction;
        q("ROLLBACK");
        return !!bad.error && /still active/i.test(bad.error) && stillOpen;
      });
      fn('V32Sp RELEASE SAVEPOINT destroys savepoints made after it', () => {
        q("DROP TABLE IF EXISTS v32_sp");
        q("CREATE TABLE v32_sp (id INT PRIMARY KEY)");
        q("INSERT INTO v32_sp VALUES (1)");
        q("BEGIN"); q("SAVEPOINT sp1"); q("INSERT INTO v32_sp VALUES (2)");
        q("SAVEPOINT sp2"); q("INSERT INTO v32_sp VALUES (3)");
        const rel = q("RELEASE SAVEPOINT sp1");
        const bad = q("ROLLBACK TO SAVEPOINT sp2");
        q("ROLLBACK");
        return !rel.error && !!bad.error && /not found/i.test(bad.error);
      });
      fn('V32Sp a plain RELEASE + outer ROLLBACK still unwinds everything', () => {
        q("BEGIN"); q("SAVEPOINT s1"); q("INSERT INTO v32_sp VALUES (5)");
        q("RELEASE SAVEPOINT s1"); q("ROLLBACK");
        return one("SELECT COUNT(*) FROM v32_sp") === 1;
      });

      // ============================================================
      // D1. SET FOREIGN_KEY_CHECKS
      // ============================================================
      fn('V32Fkc mutually referencing tables can be populated with checks off', () => {
        q("DROP TABLE IF EXISTS v32_ma"); q("DROP TABLE IF EXISTS v32_mb");
        q("CREATE TABLE v32_ma (id INT PRIMARY KEY, bid INT)");
        q("CREATE TABLE v32_mb (id INT PRIMARY KEY, aid INT REFERENCES v32_ma(id))");
        q("ALTER TABLE v32_ma ADD CONSTRAINT v32_mfk FOREIGN KEY (bid) REFERENCES v32_mb(id)");
        q("SET FOREIGN_KEY_CHECKS = 0");
        const a = q("INSERT INTO v32_ma VALUES (1,1)");
        const b = q("INSERT INTO v32_mb VALUES (1,1)");
        const back = q("SET FOREIGN_KEY_CHECKS = 1");
        return !a.error && !b.error && !back.error
            && one("SELECT COUNT(*) FROM v32_ma") === 1 && one("SELECT COUNT(*) FROM v32_mb") === 1;
      });
      fn('V32Fkc enforcement resumes after setting it back to 1', () => {
        const bad = q("INSERT INTO v32_ma VALUES (2,999)");
        return !!bad.error && /foreign key/i.test(bad.error);
      });
      fn('V32Fkc re-enabling refuses while an orphan exists', () => {
        q("DROP TABLE IF EXISTS v32_oc"); q("DROP TABLE IF EXISTS v32_op");
        q("CREATE TABLE v32_op (id INT PRIMARY KEY)");
        q("CREATE TABLE v32_oc (pid INT REFERENCES v32_op(id))");
        q("INSERT INTO v32_op VALUES (1)");
        q("SET FOREIGN_KEY_CHECKS = 0");
        q("INSERT INTO v32_oc VALUES (42)");
        const bad = q("SET FOREIGN_KEY_CHECKS = 1");
        // 直して戻せることも確かめる（後続テストのために必ず 1 へ戻す）
        q("DELETE FROM v32_oc WHERE pid = 42");
        const ok = q("SET FOREIGN_KEY_CHECKS = 1");
        return !!bad.error && /orphaned/i.test(bad.error) && !ok.error && db.fkChecksEnabled === true;
      });
      fn('V32Fkc OFF/ON spellings are accepted', () => {
        const a = q("SET FOREIGN_KEY_CHECKS = OFF");
        const off = db.fkChecksEnabled === false;
        const b = q("SET FOREIGN_KEY_CHECKS = ON");
        return !a.error && off && !b.error && db.fkChecksEnabled === true;
      });

      // ============================================================
      // D2. ディスクのファイルとして開く / 保存する（API の存在と土台）
      // ============================================================
      fn('V32File the file open/save API is exposed', () =>
        typeof window.saveDbToFile === 'function'
        && typeof window.openDbFromFile === 'function'
        && typeof window.luminaFsSupported === 'function');
      fn('V32File the sidebar has Open / Save / Save As', () =>
        !!document.getElementById('fileOpenBtn')
        && !!document.getElementById('fileSaveBtn')
        && !!document.getElementById('fileSaveAsBtn'));
      fn('V32File Save is disabled until a file is opened', () =>
        document.getElementById('fileSaveBtn').disabled === true);
      fn('V32File the backup text the file path writes round-trips', () => {
        const text = LuminaDB.backup();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { return false; }
        return !!parsed && parsed.__format__ === 'luminadb-backup' && !!parsed.payload;
      });

      // ============================================================
      // E1. Tailwind CDN が読めないときのフォールバック
      // ============================================================
      fn('V32Css the offline fallback keeps .hidden working', () => {
        // 大きい方（Tailwind が注入した）シートだけ止めて、インラインの
        // フォールバック規則だけでモーダルが隠れることを確かめる
        const sheets = [...document.styleSheets];
        let tw = null;
        for (const s of sheets) {
            let n = -1;
            try { n = s.cssRules ? s.cssRules.length : -1; } catch (e) { n = -1; }
            if (n > 100) tw = s;
        }
        if (!tw) return true;   // CDN 自体が無い環境ならこのテストは意味を持たない
        tw.disabled = true;
        const hidden = ['helpModal', 'dataModal', 'consolePanel', 'schemaModal']
            .every(id => {
                const el = document.getElementById(id);
                return !el || getComputedStyle(el).display === 'none';
            });
        tw.disabled = false;
        return hidden;
      });
      fn('V32Css the CDN warning band exists and is hidden while styles load', () => {
        const el = document.getElementById('tailwindWarning');
        return !!el && getComputedStyle(el).display === 'none';
      });

      // ============================================================
      // E2. 複数文スクリプトの結果選択とタブ
      // ============================================================
      fn('V32Ui a 0-row final SELECT is shown, not an earlier statement', () => {
        q("DROP TABLE IF EXISTS v32_ui");
        q("CREATE TABLE v32_ui (id INT PRIMARY KEY, v INT)");
        q("INSERT INTO v32_ui VALUES (1,10),(2,20),(3,30)");
        els.query.value = "SELECT * FROM v32_ui;\nSELECT 1 AS x;\nSELECT * FROM v32_ui WHERE id = 999;";
        runQuery();
        return Array.isArray(currentResultData) && currentResultData.length === 0;
      });
      fn('V32Ui every result set gets a tab', () => {
        const tabs = document.querySelectorAll('#resultTabs button[data-set]');
        return tabs.length === 3;
      });
      fn('V32Ui clicking a tab shows that statement result', () => {
        // タブは選択のたびに作り直されるので、押すたびに DOM を引き直す
        const tab = (i) => document.querySelectorAll('#resultTabs button[data-set]')[i];
        if (document.querySelectorAll('#resultTabs button[data-set]').length !== 3) return false;
        tab(0).click();
        const first = Array.isArray(currentResultData) && currentResultData.length === 3;
        tab(1).click();
        const second = Array.isArray(currentResultData) && currentResultData.length === 1
            && currentResultData[0].x === 1;
        tab(2).click();
        const third = Array.isArray(currentResultData) && currentResultData.length === 0;
        return first && second && third;
      });
      fn('V32Ui a DML status row is not offered as the answer', () => {
        els.query.value = "SELECT * FROM v32_ui WHERE id=1;\nDELETE FROM v32_ui WHERE id=1;\nSELECT * FROM v32_ui WHERE id=1;";
        runQuery();
        return Array.isArray(currentResultData) && currentResultData.length === 0;
      });
      fn('V32Ui a single statement clears the tab strip', () => {
        els.query.value = "SELECT * FROM v32_ui";
        runQuery();
        return document.getElementById('resultTabs').classList.contains('hidden');
      });

      // ============================================================
      // E3. Result という別名の列で書き出しが無効化されない
      // ============================================================
      fn('V32Ui a column aliased Result keeps export enabled', () => {
        q("DROP TABLE IF EXISTS v32_res");
        q("CREATE TABLE v32_res (note TEXT)");
        q("INSERT INTO v32_res VALUES ('a'),('b')");
        els.query.value = "SELECT note AS Result FROM v32_res";
        runQuery();
        return currentResultData.length === 2
            && document.getElementById('exportCsvBtn').disabled === false;
      });
      fn('V32Ui a real DML status row still disables export', () => {
        els.query.value = "INSERT INTO v32_res VALUES ('c')";
        runQuery();
        return document.getElementById('exportCsvBtn').disabled === true;
      });
      fn('V32Ui the status-shape predicate is exposed and correct', () =>
        window.isStatusRows([{ Result: 'Success', Message: 'ok' }]) === true
        && window.isStatusRows([{ Result: 'a' }]) === false
        && window.isStatusRows([{ Result: 'a', Message: 'b', Extra: 'c' }]) === false
        && window.isResultSet([{ note: 'x' }]) === true);

      // ============================================================
      // E4. 文脈を見る補完
      // ============================================================
      fn('V32Ac `alias.` completes that table columns', () => {
        q("DROP TABLE IF EXISTS v32_ac");
        q("CREATE TABLE v32_ac (ac_id INT PRIMARY KEY, ac_name TEXT)");
        const text = "SELECT * FROM v32_ac c WHERE c.";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions.length === 2
            && currentSuggestions.includes('ac_id') && currentSuggestions.includes('ac_name');
      });
      fn('V32Ac `table.` completes its columns too', () => {
        const text = "SELECT v32_ac.";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions.includes('ac_id') && currentSuggestions.includes('ac_name');
      });
      fn('V32Ac a partial qualified column is filtered', () => {
        const text = "SELECT * FROM v32_ac c WHERE c.ac_n";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions.join() === 'ac_name';
      });
      fn('V32Ac columns of unrelated tables are not offered', () => {
        q("DROP TABLE IF EXISTS v32_ac2");
        q("CREATE TABLE v32_ac2 (zz_other INT)");
        const text = "SELECT * FROM v32_ac WHERE zz_";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions.length === 0;
      });
      fn('V32Ac the context table columns rank before keywords', () => {
        const text = "SELECT * FROM v32_ac WHERE ac_";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions[0] === 'ac_id' || currentSuggestions[0] === 'ac_name';
      });
      fn('V32Ac table names are still completed after FROM', () => {
        const text = "SELECT * FROM v32_a";
        els.query.value = text;
        els.query.selectionStart = els.query.selectionEnd = text.length;
        showSuggestions();
        return currentSuggestions.some(s => s === 'v32_ac');
      });

      // ============================================================
      // E5. ダブルクリック編集がセル詳細に壊されない
      // ============================================================
      fn('V32Ui double-clicking an editable cell does not open the cell modal', () => {
        q("DROP TABLE IF EXISTS v32_ed");
        q("CREATE TABLE v32_ed (id INT PRIMARY KEY, nm TEXT)");
        q("INSERT INTO v32_ed VALUES (1,'a'),(2,'b')");
        els.query.value = "SELECT * FROM v32_ed";
        runQuery();
        const td = els.resArea.querySelector('td[data-r="0"][data-c="1"]');
        if (!td) return false;
        // 本物のダブルクリック列（click, click, dblclick）を再現する
        td.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        td.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const editorOpen = !!els.resArea.querySelector('input,textarea');
        const modalHidden = document.getElementById('cellModal').classList.contains('hidden');
        // 後片付け（編集を確定させない）
        const inp = els.resArea.querySelector('input,textarea');
        if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return editorOpen && modalHidden;
      });

      // ============================================================
      // E6. 状態色は「結果の形」で決める（セルの文字列内容では決めない）
      // ============================================================
      fn('V32Ui data that reads like a status message is not coloured', () => {
        q("DROP TABLE IF EXISTS v32_notes");
        q("CREATE TABLE v32_notes (id INT, note TEXT)");
        q("INSERT INTO v32_notes VALUES (1,'record deleted by ops'),(2,'customer not found in CRM')");
        els.query.value = "SELECT * FROM v32_notes";
        runQuery();
        const tds = [...els.resArea.querySelectorAll('td[data-c="1"]')];
        if (tds.length < 2) return false;
        return tds.every(td => !/text-green-600|text-red-600|bg-red-50/.test(td.className));
      });
      fn('V32Ui a real status row is still coloured', () => {
        els.query.value = "INSERT INTO v32_notes VALUES (3,'x')";
        runQuery();
        const td = els.resArea.querySelector('td[data-c="0"]');
        return !!td && /text-green-600/.test(td.className);
      });
      fn('V32Ui NULL and the string "null" and empty string look different', () => {
        q("DROP TABLE IF EXISTS v32_nul");
        q("CREATE TABLE v32_nul (id INT, v TEXT)");
        q("INSERT INTO v32_nul (id, v) VALUES (1, NULL),(2,'null'),(3,'')");
        els.query.value = "SELECT v FROM v32_nul ORDER BY id";
        runQuery();
        const txt = [...els.resArea.querySelectorAll('td[data-c="0"]')].map(td => td.textContent);
        return txt.length === 3 && txt[0] === '[NULL]' && txt[1] === 'null' && txt[2] === '[empty]';
      });

      // ============================================================
      // 片付け（共有フィクスチャを汚さないよう自前の表だけを消す）
      // ============================================================
      fn('V32Zz cleanup', () => {
        ['v32_rep','v32_rep2','v32_rf','v32_rp','v32_tc','v32_tp','v32_ts','v32_ts2','v32_ts3',
         'v32_gen','v32_tt','v32_ta','v32_it','v32_ia','v32_okt','v32_oka','v32_cc','v32_cp',
         'v32_ex','v32_j1','v32_j2','v32_h','v32_s','v32_n1','v32_n2','v32_a','v32_a2','v32_b',
         'v32_t','v32_t2','v32_o','v32_tm','v32_c','v32_w','v32_cs','v32_cp2','v32_ca','v32_ctas',
         'v32_fc','v32_fp','v32_gc','v32_gp','v32_uc','v32_up','v32_sr','v32_kc','v32_kp',
         'v32_kc2','v32_kp2','v32_tx','v32_sp','v32_ma','v32_mb','v32_oc','v32_op','v32_ui',
         'v32_res','v32_ac','v32_ac2','v32_ed','v32_notes','v32_nul']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        return true;
      });

      return T;
    }
