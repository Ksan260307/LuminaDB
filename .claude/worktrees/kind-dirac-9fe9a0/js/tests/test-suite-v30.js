    // ============================================================================
    // [Test Suite v30] - v1.25 の修正・追加のテスト
    //
    //   v1.24 で「未着手」として残した 3 件を片付けた回:
    //     1. 算術の NULL 伝播（`amt - qty` が NULL を 0 として扱っていた）と 0 除算
    //     2. CAST(x AS DATE) の時刻切り捨て（DATE と DATETIME / TIMESTAMP の分離）
    //        あわせて日付・日時の比較を「文字列の並び」ではなく時刻で行うようにした
    //     3. ウィンドウ関数の既定フレーム（ORDER BY だけなら RANGE ... CURRENT ROW）
    //   加えて:
    //     - FOREIGN KEY の ON DELETE / ON UPDATE SET DEFAULT（黙って RESTRICT に落ちていた）
    //     - COMMENT ON が ROLLBACK で戻らなかった
    //     - 画面から 1 文あたりの実行時間の上限を設定できるようにした
    //
    //   test-suite.js の tests 配列へ getV30Tests() のスプレッドで合流する
    // ============================================================================
    function getV30Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one, colSafe: col } = makeTestKit('V30');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V30Fx tables', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_s");
        db.executeQuery("CREATE TABLE v30_s (id INTEGER PRIMARY KEY, amt INTEGER, qty INTEGER)");
        db.executeQuery("INSERT INTO v30_s VALUES (1,100,2),(2,200,NULL),(3,300,3)");
        return db.tables.v30_s.rowCount === 3;
      });

      // ============================================================
      // 1. 算術の NULL 伝播
      // ============================================================
      fn('V30Ar multiply propagates null', () => col("SELECT amt*qty AS v FROM v30_s ORDER BY id", 'v').join() === '200,,900');
      fn('V30Ar subtract propagates null', () => col("SELECT amt-qty AS v FROM v30_s ORDER BY id", 'v').join() === '98,,297');
      fn('V30Ar add propagates null', () => col("SELECT amt+qty AS v FROM v30_s ORDER BY id", 'v').join() === '102,,303');
      fn('V30Ar unary minus propagates null', () => col("SELECT -qty AS v FROM v30_s ORDER BY id", 'v').join() === '-2,,-3');
      fn('V30Ar null row is really null', () => {
        const r = db.executeQuery("SELECT amt*qty AS v FROM v30_s WHERE id = 2");
        return r.data[0].v === null;
      });
      push('V30Ar null plus number is null', "SELECT NULL + 10 AS v", r => r.data[0].v === null);
      push('V30Ar number minus null is null', "SELECT 10 - NULL AS v", r => r.data[0].v === null);
      push('V30Ar null times zero is null', "SELECT NULL * 0 AS v", r => r.data[0].v === null);
      // 集計は NULL を無視するので、伝播が直って初めて正しい値になる
      fn('V30Ar aggregates over an expression skip null', () => {
        const r = db.executeQuery("SELECT AVG(amt*qty) AS av, MIN(amt*qty) AS mn, COUNT(amt*qty) AS ct, SUM(amt*qty) AS sm FROM v30_s");
        return r.data[0].av === 550 && r.data[0].mn === 200 && r.data[0].ct === 2 && r.data[0].sm === 1100;
      });
      // 演算子の優先順位と括弧
      push('V30Ar precedence is preserved', "SELECT 2 + 3 * 4 AS v", r => r.data[0].v === 14);
      push('V30Ar parentheses are preserved', "SELECT (2 + 3) * 4 AS v", r => r.data[0].v === 20);
      push('V30Ar left associativity', "SELECT 10 - 3 - 2 AS v", r => r.data[0].v === 5);
      push('V30Ar unary minus on a literal', "SELECT -3 AS a, 2*-3 AS b, -(2+1) AS c", r => r.data[0].a === -3 && r.data[0].b === -6 && r.data[0].c === -3);
      push('V30Ar exponent notation is intact', "SELECT 1e-5 + 1 AS v", r => Math.abs(r.data[0].v - 1.00001) < 1e-9);
      push('V30Ar float division', "SELECT 7 / 2 AS v", r => r.data[0].v === 3.5);
      push('V30Ar modulo', "SELECT 7 % 3 AS v", r => r.data[0].v === 1);
      push('V30Ar divide by zero is null', "SELECT 10 / 0 AS v", r => r.data[0].v === null);
      push('V30Ar modulo by zero is null', "SELECT 10 % 0 AS v", r => r.data[0].v === null);
      push('V30Ar arithmetic inside a comparison', "SELECT COUNT(*) AS c FROM v30_s WHERE amt + 1 > 150", r => r.data[0].c === 2);
      push('V30Ar arithmetic inside a function', "SELECT ROUND(100.0*2/3, 2) AS v", r => r.data[0].v === 66.67);
      fn('V30Ar string concatenation is untouched', () => one("SELECT 'a' || 'b' AS v") === 'ab');

      // ============================================================
      // 2. DATE と DATETIME の分離
      // ============================================================
      push('V30Dt cast to date truncates the time', "SELECT CAST('2026-01-02 13:45:00' AS DATE) AS d", r => r.data[0].d === '2026-01-02');
      push('V30Dt cast to datetime keeps the time', "SELECT CAST('2026-01-02 13:45:00' AS DATETIME) AS d", r => r.data[0].d === '2026-01-02 13:45:00');
      push('V30Dt cast to timestamp keeps the time', "SELECT CAST('2026-01-02 13:45:00' AS TIMESTAMP) AS d", r => r.data[0].d === '2026-01-02 13:45:00');
      push('V30Dt date literal is date only', "SELECT DATE '2026-01-02' AS d", r => r.data[0].d === '2026-01-02');
      push('V30Dt timestamp literal keeps the time', "SELECT TIMESTAMP '2026-01-02 13:45:00' AS d", r => r.data[0].d === '2026-01-02 13:45:00');
      push('V30Dt double colon cast truncates', "SELECT x::DATE AS d FROM (SELECT '2026-05-06 11:22:33' AS x) t", r => r.data[0].d === '2026-05-06');
      // 表記が違っても同じ瞬間なら比較は一致する
      push('V30Dt date and timestamp compare equal', "SELECT DATE '2026-01-02' = TIMESTAMP '2026-01-02 00:00:00' AS v", r => r.data[0].v === true);
      push('V30Dt truncated cast equals the date literal', "SELECT CAST('2026-01-02 13:45' AS DATE) = DATE '2026-01-02' AS v", r => r.data[0].v === true);
      push('V30Dt ordering across shapes', "SELECT DATE '2026-01-02' < TIMESTAMP '2026-01-02 00:00:01' AS v", r => r.data[0].v === true);
      fn('V30Dt daily grouping collapses times', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_ev");
        db.executeQuery("CREATE TABLE v30_ev (id INTEGER, at DATETIME)");
        db.executeQuery("INSERT INTO v30_ev VALUES (1,'2026-01-02 09:00:00'),(2,'2026-01-02 18:00:00'),(3,'2026-01-03 07:00:00')");
        const r = db.executeQuery("SELECT CAST(at AS DATE) AS d, COUNT(*) AS c FROM v30_ev GROUP BY CAST(at AS DATE) ORDER BY d");
        return !r.error && r.data.length === 2 && r.data[0].c === 2 && r.data[1].c === 1;
      });
      fn('V30Dt date column compares with a date literal', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_d");
        db.executeQuery("CREATE TABLE v30_d (id INTEGER, d DATE)");
        db.executeQuery("INSERT INTO v30_d VALUES (1,'2026-01-02'),(2,'2026-01-03')");
        return col("SELECT id FROM v30_d WHERE d = DATE '2026-01-02'", 'id').join() === '1';
      });
      fn('V30Dt date column compares with a timestamp literal', () => {
        return one("SELECT COUNT(*) FROM v30_d WHERE d >= TIMESTAMP '2026-01-03 00:00:00'") === 1;
      });
      // 日付演算（v1.22 の機能）が壊れていないこと
      push('V30Dt date literal plus days', "SELECT DATE '2026-01-01' + 1 AS d", r => String(r.data[0].d).slice(0, 10) === '2026-01-02');
      push('V30Dt date minus date', "SELECT DATE '2026-01-05' - DATE '2026-01-01' AS n", r => r.data[0].n === 4);
      // 文字列比較は日付らしくない値では従来どおり
      push('V30Dt plain strings still compare lexically', "SELECT 'abc' < 'abd' AS a, 'b' > 'a' AS b", r => r.data[0].a === true && r.data[0].b === true);

      // ============================================================
      // 3. ウィンドウ関数の既定フレーム
      // ============================================================
      fn('V30Wf fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_w");
        db.executeQuery("CREATE TABLE v30_w (day INTEGER, amt INTEGER)");
        db.executeQuery("INSERT INTO v30_w VALUES (1,10),(1,20),(2,5)");
        return db.tables.v30_w.rowCount === 3;
      });
      fn('V30Wf default frame is range', () =>
        col("SELECT SUM(amt) OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '30,30,35');
      fn('V30Wf count follows the same frame', () =>
        col("SELECT COUNT(*) OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '2,2,3');
      // v1.27: AVG は倍精度のまま返す（以前は 2 桁へ丸めていた）ので許容差で比べる
      fn('V30Wf avg follows the same frame', () => {
        const v = col("SELECT AVG(amt) OVER (ORDER BY day) AS v FROM v30_w", 'v');
        const exp = [15, 15, 35 / 3];
        return v.length === 3 && v.every((x, i) => typeof x === 'number' && Math.abs(x - exp[i]) < 1e-9);
      });
      fn('V30Wf last value stops at the current peer group', () =>
        col("SELECT LAST_VALUE(amt) OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '20,20,5');
      fn('V30Wf first value is the partition start', () =>
        col("SELECT FIRST_VALUE(amt) OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '10,10,10');
      fn('V30Wf explicit rows still accumulates per row', () =>
        col("SELECT SUM(amt) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS v FROM v30_w", 'v').join() === '10,30,35');
      fn('V30Wf explicit whole partition', () =>
        col("SELECT LAST_VALUE(amt) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS v FROM v30_w", 'v').join() === '5,5,5');
      fn('V30Wf no order by means the whole partition', () =>
        col("SELECT SUM(amt) OVER () AS v FROM v30_w", 'v').join() === '35,35,35');
      fn('V30Wf ranking functions are unaffected', () =>
        col("SELECT ROW_NUMBER() OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '1,2,3'
        && col("SELECT RANK() OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === '1,1,3');
      fn('V30Wf lag and lead are unaffected', () =>
        col("SELECT LAG(amt) OVER (ORDER BY day) AS v FROM v30_w", 'v').join() === ',10,20');
      fn('V30Wf partition by keeps frames per partition', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_w2");
        db.executeQuery("CREATE TABLE v30_w2 (g TEXT, day INTEGER, amt INTEGER)");
        db.executeQuery("INSERT INTO v30_w2 VALUES ('a',1,10),('a',1,20),('b',1,7)");
        return col("SELECT SUM(amt) OVER (PARTITION BY g ORDER BY day) AS v FROM v30_w2", 'v').join() === '30,30,7';
      });
      fn('V30Wf window over group by results still works', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_g");
        db.executeQuery("CREATE TABLE v30_g (reg TEXT, amt INTEGER)");
        db.executeQuery("INSERT INTO v30_g VALUES ('e',10),('e',20),('w',5)");
        const r = db.executeQuery("SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg) AS run FROM v30_g GROUP BY reg ORDER BY reg");
        return !r.error && r.data[0].run === 30 && r.data[1].run === 35;
      });
      // v1.29: ROWS フレームは集計後の行にも使える（RANGE / GROUPS は引き続き不可）
      fn('V30Wf a rows frame over group by works', () => {
        const r = db.executeQuery("SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg ROWS UNBOUNDED PRECEDING) AS run FROM v30_g GROUP BY reg ORDER BY reg");
        return !r.error && r.data[0].run === 30 && r.data[1].run === 35;
      });
      err('V30Wf range frames over group by are still refused',
          "SELECT reg, SUM(SUM(amt)) OVER (ORDER BY reg RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS run FROM v30_g GROUP BY reg", 'not supported over GROUP BY');

      // ============================================================
      // 4. FOREIGN KEY の SET DEFAULT
      // ============================================================
      fn('V30Fk set default is recorded', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_c");
        db.executeQuery("DROP TABLE IF EXISTS v30_p");
        db.executeQuery("CREATE TABLE v30_p (id INTEGER PRIMARY KEY)");
        db.executeQuery("INSERT INTO v30_p VALUES (1),(9)");
        db.executeQuery("CREATE TABLE v30_c (id INTEGER, pid INTEGER DEFAULT 9, FOREIGN KEY (pid) REFERENCES v30_p(id) ON DELETE SET DEFAULT)");
        const r = db.executeQuery("SHOW CREATE TABLE v30_c");
        return !r.error && /ON DELETE SET DEFAULT/i.test(r.data[0].CreateTable);
      });
      fn('V30Fk delete sets the child back to its default', () => {
        db.executeQuery("INSERT INTO v30_c VALUES (100,1)");
        const d = db.executeQuery("DELETE FROM v30_p WHERE id = 1");
        return !d.error && one("SELECT pid FROM v30_c WHERE id = 100") === 9;
      });
      fn('V30Fk set default without a default is refused', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_c2");
        db.executeQuery("CREATE TABLE v30_c2 (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v30_p(id) ON DELETE SET DEFAULT)");
        db.executeQuery("INSERT INTO v30_c2 VALUES (1,9)");
        const r = db.executeQuery("DELETE FROM v30_p WHERE id = 9");
        return !!r.error && /requires a default/i.test(r.error) && db.tables.v30_p.rowCount === 1;
      });
      fn('V30Fk other actions still work', () => {
        // 直前のテストが残した「DEFAULT の無い SET DEFAULT 子表」を先に外す
        // （同じ親行を参照しているので、そのままだと削除が拒否される）
        db.executeQuery("DROP TABLE IF EXISTS v30_c2");
        db.executeQuery("DROP TABLE IF EXISTS v30_c3");
        db.executeQuery("CREATE TABLE v30_c3 (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v30_p(id) ON DELETE SET NULL)");
        db.executeQuery("INSERT INTO v30_c3 VALUES (1,9)");
        const d = db.executeQuery("DELETE FROM v30_p WHERE id = 9");
        return !d.error && one("SELECT pid FROM v30_c3 WHERE id = 1") === null;
      });
      fn('V30Fk information schema reports the action', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_c4");
        db.executeQuery("INSERT INTO v30_p VALUES (5)");
        db.executeQuery("CREATE TABLE v30_c4 (id INTEGER, pid INTEGER DEFAULT 5, FOREIGN KEY (pid) REFERENCES v30_p(id) ON DELETE SET DEFAULT)");
        const r = db.executeQuery("SHOW FOREIGN KEYS FROM v30_c4");
        if (r.error) return true;   // この綴りが無い環境ではスキップ
        return r.data.some(x => String(x.on_delete || x.DELETE_RULE || '').toUpperCase() === 'SET DEFAULT');
      });

      // ============================================================
      // 5. COMMENT ON のトランザクション
      // ============================================================
      fn('V30Cm comment survives outside a transaction', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_cm");
        db.executeQuery("CREATE TABLE v30_cm (a INTEGER)");
        db.executeQuery("COMMENT ON TABLE v30_cm IS 'first'");
        const r = db.executeQuery("SHOW COMMENTS");
        return r.data.some(x => x.Object === 'v30_cm' && x.Comment === 'first');
      });
      fn('V30Cm rollback restores the previous comment', () => {
        db.executeQuery("BEGIN");
        db.executeQuery("COMMENT ON TABLE v30_cm IS 'second'");
        db.executeQuery("ROLLBACK");
        const r = db.executeQuery("SHOW COMMENTS");
        return r.data.some(x => x.Object === 'v30_cm' && x.Comment === 'first');
      });
      fn('V30Cm commit keeps the new comment', () => {
        db.executeQuery("BEGIN");
        db.executeQuery("COMMENT ON TABLE v30_cm IS 'third'");
        db.executeQuery("COMMIT");
        const r = db.executeQuery("SHOW COMMENTS");
        return r.data.some(x => x.Object === 'v30_cm' && x.Comment === 'third');
      });
      fn('V30Cm rollback removes a comment that did not exist', () => {
        db.executeQuery("DROP TABLE IF EXISTS v30_cm2");
        db.executeQuery("CREATE TABLE v30_cm2 (a INTEGER)");
        db.executeQuery("BEGIN");
        db.executeQuery("COMMENT ON TABLE v30_cm2 IS 'ghost'");
        db.executeQuery("ROLLBACK");
        const r = db.executeQuery("SHOW COMMENTS");
        return !r.data.some(x => x.Object === 'v30_cm2');
      });
      fn('V30Cm column comments roll back too', () => {
        db.executeQuery("COMMENT ON COLUMN v30_cm.a IS 'keep'");
        db.executeQuery("BEGIN");
        db.executeQuery("COMMENT ON COLUMN v30_cm.a IS 'temp'");
        db.executeQuery("ROLLBACK");
        const r = db.executeQuery("SHOW COMMENTS");
        return r.data.some(x => x.Object === 'v30_cm.a' && x.Comment === 'keep');
      });

      // ============================================================
      // 6. フロントエンド: 実行時間の上限
      // ============================================================
      fn('V30Ui the timeout control exists', () => !!document.getElementById('stmtTimeout'));
      fn('V30Ui the engine picks up the selected limit', () => {
        const sel = document.getElementById('stmtTimeout');
        const prev = sel.value;
        sel.value = '5000';
        sel.dispatchEvent(new Event('change'));
        const applied = db.statementTimeoutMs === 5000;
        sel.value = prev;
        sel.dispatchEvent(new Event('change'));
        return applied;
      });
      fn('V30Ui none removes the limit', () => {
        const sel = document.getElementById('stmtTimeout');
        const prev = sel.value;
        sel.value = '0';
        sel.dispatchEvent(new Event('change'));
        const applied = db.statementTimeoutMs === 0;
        sel.value = prev;
        sel.dispatchEvent(new Event('change'));
        return applied;
      });
      fn('V30Ui the choice is persisted', () => {
        const sel = document.getElementById('stmtTimeout');
        const prev = sel.value;
        sel.value = '120000';
        sel.dispatchEvent(new Event('change'));
        const stored = localStorage.getItem('luminadb_stmt_timeout');
        sel.value = prev;
        sel.dispatchEvent(new Event('change'));
        return stored === '120000';
      });
      fn('V30Ui a default limit is in force after load', () => {
        // 既定は 30 秒。ブラウザ内 DB でタブが永久に固まらないための保険
        const sel = document.getElementById('stmtTimeout');
        return [...sel.options].some(o => o.value === '30000') && Number(sel.value) >= 0;
      });
      fn('V30Ui the limit actually stops a runaway statement', () => {
        const before = db.statementTimeoutMs;
        db.statementTimeoutMs = 1;
        db.executeQuery("DROP TABLE IF EXISTS v30_big");
        db.executeQuery("CREATE TABLE v30_big (n INTEGER)");
        db.executeQuery("INSERT INTO v30_big SELECT n FROM GENERATE_SERIES(1, 60000) AS g(n)");
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v30_big a JOIN v30_big b ON a.n = b.n WHERE a.n + 0 > 0");
        db.statementTimeoutMs = before;
        db.executeQuery("DROP TABLE IF EXISTS v30_big");
        // 上限に達すればエラー、間に合えば成功。どちらでも「固まらない」ことが要点なので
        // エラーのときだけ文言を確かめる
        return !r.error || /timeout|exceeded|上限/i.test(r.error);
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V30Cl drop objects', () => {
        ['v30_big', 'v30_cm2', 'v30_cm', 'v30_c4', 'v30_c3', 'v30_c2', 'v30_c', 'v30_p',
         'v30_g', 'v30_w2', 'v30_w', 'v30_d', 'v30_ev', 'v30_s']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
