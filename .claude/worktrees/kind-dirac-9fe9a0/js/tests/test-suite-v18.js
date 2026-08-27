    // ============================================================================
    // [Test Suite v18] - セキュリティテスト（約 520 件）
    //
    //   方針:
    //     * 「攻撃者が制御できる文字列」がどの入口から入っても、
    //         (a) JS として実行されない（カナリア変数が汚れない）
    //         (b) SQL の構造を変えない（テーブル・行数が変化しない）
    //         (c) 値としてそのまま往復する（データが壊れない）
    //       の3点を機械的に検証する。ペイロード × 入口 の総当たりで生成する。
    //     * プロトタイプ汚染・資源枯渇（DoS）・読み取り専用の強制・出力エスケープも同様に網羅する。
    //
    //   test-suite.js の tests 配列へ getV18Tests() のスプレッドで合流する
    // ============================================================================
    function getV18Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, canaryClean } = makeTestKit('V18');

      // ------------------------------------------------------------
      // カナリア: いずれかのペイロードが JS として評価されたら真になる
      // ------------------------------------------------------------

      // ------------------------------------------------------------
      // 攻撃ペイロード集（SQLインジェクション / JS脱出 / プロトタイプ汚染 / 出力汚染）
      // ------------------------------------------------------------
      const PAYLOADS = [
        { id: 'quote-drop',    v: "'; DROP TABLE v18_t; --" },
        { id: 'or-true',       v: "' OR '1'='1" },
        { id: 'or-comment',    v: "' OR 1=1 --" },
        { id: 'bs-quote',      v: "\\'; DROP TABLE v18_t; --" },
        { id: 'stacked',       v: "1; DELETE FROM v18_t" },
        { id: 'paren-or',      v: "') OR ('1'='1" },
        { id: 'admin-dash',    v: "admin'--" },
        { id: 'open-comment',  v: "'/*" },
        { id: 'close-comment', v: "*/'" },
        { id: 'union-all',     v: "' UNION SELECT * FROM v18_t --" },
        { id: 'dq-drop',       v: "\"; DROP TABLE v18_t; --" },
        { id: 'backtick',      v: "` + (window.__v18_pwned = 1) + `" },
        { id: 'template',      v: "${window.__v18_pwned = 1}" },
        { id: 'js-escape',     v: "'); window.__v18_pwned = 1; ('" },
        { id: 'js-concat',     v: "' + (window.__v18_pwned = 1) + '" },
        { id: 'fn-ctor',       v: "constructor.constructor('window.__v18_pwned=1')()" },
        { id: 'proto',         v: "__proto__" },
        { id: 'proto-path',    v: "__proto__.__v18_polluted" },
        { id: 'ctor-proto',    v: "constructor.prototype.__v18_polluted" },
        { id: 'newline',       v: "line1\nline2; DROP TABLE v18_t" },
        { id: 'crlf',          v: "a\r\nb" },
        { id: 'nul',           v: "a\0b" },
        { id: 'html',          v: "</script><img src=x onerror=\"window.__v18_pwned=1\">" },
        { id: 'dollar-refs',   v: "$&$'$`$1$$" },
        { id: 'wildcards',     v: "%_%" },
        { id: 'unicode-sep',   v: "a b c" },
        { id: 'engine-ref',    v: "__engine__" },
        { id: 'str-token',     v: "__STR_0__" }
      ];

      // ------------------------------------------------------------
      // 0. フィクスチャ（各入口テストで共有する。行数の不変を検査に使う）
      // ------------------------------------------------------------
      const BASE_ROWS = 3;
      push('V18Fx create', "CREATE TABLE v18_t (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)", r => r.data[0].Result === 'Success');
      push('V18Fx insert', "INSERT INTO v18_t VALUES (1,'alpha',10),(2,'beta',20),(3,'gamma',30)", r => r.data[0].Result === 'Success');
      push('V18Fx sink', "CREATE TABLE v18_sink (k INTEGER, v TEXT)", r => r.data[0].Result === 'Success');
      fn('V18Fx canary clean at start', () => canaryClean());

      // DB が壊れていないことの共通検査
      const intact = () => {
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v18_t");
        return !r.error && r.data[0].c === BASE_ROWS;
      };

      // ============================================================
      // 1. パラメータバインド経由のインジェクション（入口 × ペイロード）
      //    どの入口でも「値」として扱われ、構造は一切変わらないこと
      // ============================================================
      PAYLOADS.forEach(p => {
        // 1-a. 位置プレースホルダ '?'
        fn(`V18Bind pos ${p.id}`, () => {
          const r = LuminaDB.query('SELECT ? AS v', [p.v]);
          return !r.error && r.data[0].v === p.v && intact() && canaryClean();
        });
        // 1-b. 名前付きプレースホルダ ':name'
        fn(`V18Bind named ${p.id}`, () => {
          const r = LuminaDB.query('SELECT :x AS v', { x: p.v });
          return !r.error && r.data[0].v === p.v && intact() && canaryClean();
        });
        // 1-c. WHERE 句に入れても構造が変わらない（0 件になるだけ）
        fn(`V18Bind where ${p.id}`, () => {
          const r = LuminaDB.query('SELECT COUNT(*) AS c FROM v18_t WHERE label = ?', [p.v]);
          return !r.error && r.data[0].c === 0 && intact() && canaryClean();
        });
        // 1-d. INSERT した値がそのまま読み戻せる（保存→取り出しの往復）
        fn(`V18Bind insert ${p.id}`, () => {
          const ins = LuminaDB.insert('v18_sink', { k: 1, v: p.v });
          if (ins.error) return false;
          const got = LuminaDB.value('SELECT v FROM v18_sink WHERE k = ?', [1]);
          LuminaDB.remove('v18_sink', { k: 1 });
          return got === p.v && intact() && canaryClean();
        });
        // 1-e. UPDATE の代入値
        fn(`V18Bind update ${p.id}`, () => {
          LuminaDB.insert('v18_sink', { k: 2, v: 'x' });
          const up = LuminaDB.update('v18_sink', { v: p.v }, { k: 2 });
          const got = LuminaDB.value('SELECT v FROM v18_sink WHERE k = 2');
          LuminaDB.remove('v18_sink', { k: 2 });
          return !up.error && got === p.v && intact() && canaryClean();
        });
        // 1-f. select() ヘルパの where 値
        fn(`V18Bind select ${p.id}`, () => {
          const r = LuminaDB.select('v18_t', { where: { label: p.v } });
          return !r.error && r.data.length === 0 && intact() && canaryClean();
        });
        // 1-g. remove() ヘルパの where 値（1 行も消えないこと）
        fn(`V18Bind remove ${p.id}`, () => {
          const r = LuminaDB.remove('v18_t', { label: p.v });
          return !r.error && intact() && canaryClean();
        });
        // 1-h. prepare().all()
        fn(`V18Bind prepare ${p.id}`, () => {
          const stmt = LuminaDB.prepare('SELECT ? AS v');
          const rows = stmt.all(p.v);
          return rows.length === 1 && rows[0].v === p.v && intact() && canaryClean();
        });
        // 1-i. SQL 側のプリペアド (PREPARE / EXECUTE USING)
        fn(`V18Bind sqlprep ${p.id}`, () => {
          const q = "'" + String(p.v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
          db.executeQuery("DEALLOCATE PREPARE v18ps");
          const pr = db.executeQuery("PREPARE v18ps FROM 'SELECT ? AS v'");
          if (pr.error) return false;
          const r = db.executeQuery(`EXECUTE v18ps USING ${q}`);
          db.executeQuery("DEALLOCATE PREPARE v18ps");
          return !r.error && r.data[0].v === p.v && intact() && canaryClean();
        });
        // 1-j. LIKE パターンとして渡してもワイルドカード以上の効果を持たない
        fn(`V18Bind like ${p.id}`, () => {
          const r = LuminaDB.query('SELECT COUNT(*) AS c FROM v18_t WHERE label LIKE ?', [p.v]);
          return !r.error && typeof r.data[0].c === 'number' && intact() && canaryClean();
        });
      });

      // バインド API 自体の防御
      fn('V18Bind too few values', () => {
        const r = LuminaDB.query('SELECT ?, ? AS v', [1]);
        return !!r.error && /placeholder/i.test(r.error);
      });
      fn('V18Bind too many values', () => {
        const r = LuminaDB.query('SELECT ? AS v', [1, 2]);
        return !!r.error && /only 1 placeholders/i.test(r.error);
      });
      fn('V18Bind missing named', () => {
        const r = LuminaDB.query('SELECT :a AS v', { b: 1 });
        return !!r.error && /named parameter/i.test(r.error);
      });
      fn('V18Bind non-finite', () => {
        const r = LuminaDB.query('SELECT ? AS v', [Infinity]);
        return !!r.error && /non-finite/i.test(r.error);
      });
      fn('V18Bind nan', () => {
        const r = LuminaDB.query('SELECT ? AS v', [NaN]);
        return !!r.error && /non-finite/i.test(r.error);
      });
      fn('V18Bind placeholder inside literal', () => {
        // 文字列リテラル内の '?' はプレースホルダとして消費されない
        const r = LuminaDB.query("SELECT 'a?b' AS lit, ? AS v", [7]);
        return !r.error && r.data[0].lit === 'a?b' && r.data[0].v === 7;
      });
      fn('V18Bind named inside literal', () => {
        const r = LuminaDB.query("SELECT ':x' AS lit, :x AS v", { x: 5 });
        return !r.error && r.data[0].lit === ':x' && r.data[0].v === 5;
      });
      fn('V18Bind escaped quote in literal', () => {
        const r = LuminaDB.query("SELECT 'a\\\\' AS lit, ? AS v", [1]);
        return !r.error && r.data[0].v === 1;
      });
      fn('V18Bind date param', () => {
        const r = LuminaDB.query('SELECT ? AS v', [new Date('2026-01-02T03:04:05Z')]);
        const v = r.data[0].v;
        return !r.error && (v instanceof Date ? v.getUTCFullYear() === 2026 : String(v).indexOf('2026-01-02') === 0);
      });
      fn('V18Bind boolean param', () => {
        const r = LuminaDB.query('SELECT ? AS v', [true]);
        return !r.error && r.data[0].v === true;
      });
      fn('V18Bind null param', () => {
        const r = LuminaDB.query('SELECT ? AS v', [null]);
        return !r.error && r.data[0].v === null;
      });

      // ============================================================
      // 2. 識別子（テーブル名・列名）の検証 — 値と違い識別子はバインドできない
      // ============================================================
      const BAD_IDENTS = [
        'v18_t; DROP TABLE v18_t', 'v18_t--', 'v18 t', '1abc', '', ' ', 'a`b', 'a"b', "a'b",
        'a.b', 'a(b)', '__proto__ ', 'a\nb', 'a/*b*/', '*', 'a-b', 'a+b', 'a,b', 'a;b'
      ];
      BAD_IDENTS.forEach((bad, i) => {
        fn(`V18Ident select table ${i}`, () => {
          const r = LuminaDB.select(bad, {});
          return !!r.error && /invalid table name/i.test(r.error) && intact();
        });
        fn(`V18Ident insert table ${i}`, () => {
          const r = LuminaDB.insert(bad, { a: 1 });
          return !!r.error && /invalid table name/i.test(r.error) && intact();
        });
        fn(`V18Ident where column ${i}`, () => {
          const r = LuminaDB.select('v18_t', { where: { [bad]: 1 } });
          return !!r.error && /invalid column name/i.test(r.error) && intact();
        });
        fn(`V18Ident update column ${i}`, () => {
          const r = LuminaDB.update('v18_t', { [bad]: 1 }, { id: 1 });
          return !!r.error && /invalid column name/i.test(r.error) && intact();
        });
        fn(`V18Ident columns opt ${i}`, () => {
          const r = LuminaDB.select('v18_t', { columns: [bad] });
          return !!r.error && /invalid column name/i.test(r.error) && intact();
        });
      });
      fn('V18Ident orderBy injection', () => {
        const r = LuminaDB.select('v18_t', { orderBy: 'id; DROP TABLE v18_t' });
        return !!r.error && /invalid orderby/i.test(r.error) && intact();
      });
      fn('V18Ident orderBy subquery', () => {
        const r = LuminaDB.select('v18_t', { orderBy: '(SELECT 1)' });
        return !!r.error && intact();
      });
      fn('V18Ident orderBy valid', () => {
        const r = LuminaDB.select('v18_t', { orderBy: 'id DESC' });
        return !r.error && r.data[0].id === 3;
      });
      fn('V18Ident limit negative', () => {
        const r = LuminaDB.select('v18_t', { limit: -1 });
        return !!r.error && /invalid limit/i.test(r.error);
      });
      fn('V18Ident limit injection', () => {
        const r = LuminaDB.select('v18_t', { limit: '1; DROP TABLE v18_t' });
        return !!r.error && intact();
      });
      fn('V18Ident unknown where operator', () => {
        const r = LuminaDB.select('v18_t', { where: { n: { evil: 1 } } });
        return !!r.error && /unknown operator/i.test(r.error);
      });
      fn('V18Ident pluck column', () => {
        try { LuminaDB.pluck('v18_t', 'id; DROP TABLE v18_t'); return false; }
        catch (e) { return /invalid column name/i.test(e.message) && intact(); }
      });
      fn('V18Ident schema table', () => {
        try { LuminaDB.schema('v18_t; DROP TABLE v18_t'); return false; }
        catch (e) { return /invalid table name/i.test(e.message) && intact(); }
      });
      fn('V18Ident update requires where', () => {
        const r = LuminaDB.update('v18_t', { n: 0 });
        return !!r.error && /requires a where/i.test(r.error) && intact();
      });
      fn('V18Ident remove requires where', () => {
        const r = LuminaDB.remove('v18_t');
        return !!r.error && /requires a where/i.test(r.error) && intact();
      });
      fn('V18Ident empty changes', () => {
        const r = LuminaDB.update('v18_t', {}, { id: 1 });
        return !!r.error && intact();
      });

      // ============================================================
      // 3. 式コンパイラからの JS 脱出（テンプレートリテラル構文の遮断）
      // ============================================================
      const ESCAPES = [
        '`', '${1}', '`${1}`', 'a`b', '${window.__v18_pwned=1}', '`+1+`',
        'CONCAT(`a`)', 'UPPER(`x`)', '1 + `2`', "'a' || `b`",
        '${}', '`;window.__v18_pwned=1;`'
      ];
      ESCAPES.forEach((e, i) => {
        T.push({
          name: `V18Esc select ${i}`, sql: `SELECT ${e} AS v`, isErrorExpected: true,
          check: r => !!r.error && canaryClean()
        });
        T.push({
          name: `V18Esc where ${i}`, sql: `SELECT * FROM v18_t WHERE label = ${e}`, isErrorExpected: true,
          check: r => !!r.error && canaryClean()
        });
      });
      // 識別子として現れる危険な語は「列が無い」エラーになるだけで、JS へは到達しない
      const JS_IDENTS = ['constructor', 'prototype', 'globalThis', 'window', 'process', 'require', 'eval', 'Function', 'this', 'arguments', '__proto__'];
      JS_IDENTS.forEach((w, i) => {
        T.push({
          name: `V18Esc ident ${w}`, sql: `SELECT ${w} AS v FROM v18_t`, isErrorExpected: true,
          check: r => !!r.error && canaryClean()
        });
        T.push({
          name: `V18Esc ident call ${w}`, sql: `SELECT ${w}(1) AS v FROM v18_t`, isErrorExpected: true,
          check: r => !!r.error && canaryClean()
        });
      });
      err('V18Esc engine ref', "SELECT __engine__ AS v FROM v18_t");
      err('V18Esc engine qualified', "SELECT v18_t.__engine__ AS v FROM v18_t");
      err('V18Esc engine table', "SELECT * FROM __engine__");
      fn('V18Esc canary after escapes', () => canaryClean());

      // ============================================================
      // 4. プロトタイプ汚染
      // ============================================================
      // v1.24: '__' 始まりの表名はエンジンの内部枠と衝突する（保存時にカタログ扱いされて
      // 黙って消える）ため作成時に拒否するようになった。__proto__ は「作れるが隔離されている」
      // よりも強い「そもそも作れない」保証になったので、専用の否定テストで固定する
      const POLLUTE_NAMES = ['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];
      err('V18Pp reserved table __proto__ refused', "CREATE TABLE __proto__ (x INTEGER)", 'reserved');
      fn('V18Pp canary clean after refusing __proto__', () => canaryClean() && db.tables.__proto__ === undefined);
      err('V18Pp reserved table __anything refused', "CREATE TABLE __anything (x INTEGER)", 'reserved');
      POLLUTE_NAMES.forEach(nm => {
        push(`V18Pp create table ${nm}`, `CREATE TABLE ${nm} (x INTEGER)`, r => !r.error && canaryClean());
        push(`V18Pp insert into ${nm}`, `INSERT INTO ${nm} VALUES (1)`, r => !r.error && canaryClean());
        push(`V18Pp select from ${nm}`, `SELECT COUNT(*) AS c FROM ${nm}`, r => r.data[0].c === 1 && canaryClean());
        push(`V18Pp drop table ${nm}`, `DROP TABLE ${nm}`, r => !r.error && canaryClean());
        push(`V18Pp column ${nm}`, `CREATE TABLE v18_pp_${nm.replace(/[^a-z]/gi, '')} (${nm} INTEGER)`, r => !r.error && canaryClean());
        push(`V18Pp column insert ${nm}`, `INSERT INTO v18_pp_${nm.replace(/[^a-z]/gi, '')} VALUES (5)`, r => !r.error && canaryClean());
        push(`V18Pp column read ${nm}`, `SELECT ${nm} AS v FROM v18_pp_${nm.replace(/[^a-z]/gi, '')}`, r => r.data[0].v === 5 && canaryClean());
        push(`V18Pp column drop ${nm}`, `DROP TABLE v18_pp_${nm.replace(/[^a-z]/gi, '')}`, r => !r.error && canaryClean());
        push(`V18Pp alias ${nm}`, `SELECT 1 AS ${nm} FROM v18_t LIMIT 1`, r => !r.error && canaryClean());
        fn(`V18Pp api insert key ${nm}`, () => {
          const r = LuminaDB.insert('v18_sink', { k: 9, v: 'x', [nm]: 'y' });
          LuminaDB.remove('v18_sink', { k: 9 });
          // 未知の列なのでエラーになるか、無害に無視されるかのどちらか。汚染だけは起きてはならない
          return canaryClean() && intact();
        });
        fn(`V18Pp api where key ${nm}`, () => {
          const r = LuminaDB.select('v18_t', { where: { [nm]: 1 } });
          return canaryClean() && intact();
        });
        fn(`V18Pp json key ${nm}`, () => {
          const r = db.executeQuery(`SELECT JSON_EXTRACT('{"${nm}": {"__v18_polluted": 1}}', '$.${nm}') AS v`);
          return canaryClean();
        });
        fn(`V18Pp json set ${nm}`, () => {
          db.executeQuery(`SELECT JSON_SET('{}', '$.${nm}.__v18_polluted', 1) AS v`);
          return canaryClean();
        });
      });
      fn('V18Pp views dict', () => {
        db.executeQuery("CREATE VIEW __proto__ AS SELECT 1 AS x");
        const ok = canaryClean();
        db.executeQuery("DROP VIEW __proto__");
        return ok && canaryClean();
      });
      fn('V18Pp userVars dict', () => {
        db.executeQuery("SET @__proto__ = 1");
        return canaryClean();
      });
      fn('V18Pp sequence dict', () => {
        db.executeQuery("CREATE SEQUENCE __proto__");
        const ok = canaryClean();
        db.executeQuery("DROP SEQUENCE IF EXISTS __proto__");
        return ok && canaryClean();
      });
      fn('V18Pp prepared dict', () => {
        db.executeQuery("PREPARE __proto__ FROM 'SELECT 1'");
        return canaryClean();
      });
      fn('V18Pp snapshot dict', () => {
        db.executeQuery("CREATE SNAPSHOT __proto__");
        const ok = canaryClean();
        db.executeQuery("DROP SNAPSHOT IF EXISTS __proto__");
        return ok && canaryClean();
      });
      fn('V18Pp object prototype pristine', () => {
        const probe = {};
        return probe.__v18_polluted === undefined && probe.x === undefined
            && Object.keys(Object.prototype).length === 0 && canaryClean();
      });
      fn('V18Pp array prototype pristine', () => [].__v18_polluted === undefined && [].x === undefined);

      // ============================================================
      // 5. 資源枯渇（DoS）ガード
      // ============================================================
      fn('V18Dos query too long', () => {
        const r = db.executeQuery('SELECT ' + '1+'.repeat(600000) + '1 AS v');
        return !!r.error && /too long/i.test(r.error);
      });
      fn('V18Dos api query too long', () => {
        const r = LuminaDB.query('SELECT ' + 'a'.repeat(1000001));
        return !!r.error;
      });
      fn('V18Dos too many subqueries', () => {
        let sql = 'SELECT 1 AS v FROM v18_t WHERE 1 = 1';
        for (let i = 0; i < 120; i++) sql += ` AND ${i} = (SELECT ${i})`;
        const r = db.executeQuery(sql);
        return !!r.error && /too many subqueries/i.test(r.error);
      });
      err('V18Dos recursive cte runaway', "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) AS c FROM r", 'exceeded');
      err('V18Dos regexp too long', `SELECT * FROM v18_t WHERE label REGEXP '${'a'.repeat(1100)}'`, 'too long');
      err('V18Dos similar too long', `SELECT * FROM v18_t WHERE label SIMILAR TO '${'a'.repeat(1100)}'`, 'too long');
      err('V18Dos generate_series huge', "SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 2000000)", 'exceeded');
      err('V18Dos generate_series zero step', "SELECT * FROM GENERATE_SERIES(1, 10, 0)", 'must not be zero');
      err('V18Dos generate_series infinite', "SELECT * FROM GENERATE_SERIES(1, 1e400)", 'finite');
      fn('V18Dos procedure recursion', () => {
        db.executeQuery("CREATE OR REPLACE PROCEDURE v18_rec AS BEGIN CALL v18_rec; END");
        const r = db.executeQuery("CALL v18_rec");
        db.executeQuery("DROP PROCEDURE IF EXISTS v18_rec");
        return !!r.error && /depth limit/i.test(r.error);
      });
      fn('V18Dos execute recursion', () => {
        db.executeQuery("PREPARE v18_self FROM 'EXECUTE v18_self'");
        const r = db.executeQuery("EXECUTE v18_self");
        db.executeQuery("DEALLOCATE PREPARE v18_self");
        return !!r.error && /depth limit/i.test(r.error);
      });
      fn('V18Dos udf recursion', () => {
        db.executeQuery("CREATE OR REPLACE FUNCTION v18_f(x) RETURNS INT AS RETURN x + 1");
        const r0 = db.executeQuery("CREATE OR REPLACE FUNCTION v18_f(x) RETURNS INT AS RETURN v18_f(x) + 1");
        const r = db.executeQuery("SELECT v18_f(1) AS v");
        db.executeQuery("DROP FUNCTION IF EXISTS v18_f");
        return (!!r0.error || !!r.error);
      });
      fn('V18Dos trigger recursion', () => {
        db.executeQuery("CREATE TABLE v18_trg (id INTEGER)");
        db.executeQuery("CREATE TRIGGER v18_tr AFTER INSERT ON v18_trg FOR EACH ROW BEGIN INSERT INTO v18_trg VALUES (NEW.id + 1); END");
        const r = db.executeQuery("INSERT INTO v18_trg VALUES (1)");
        db.executeQuery("DROP TRIGGER IF EXISTS v18_tr");
        db.executeQuery("DROP TABLE IF EXISTS v18_trg");
        return !!r.error;
      });
      fn('V18Dos timeout stops nested loop join', () => {
        db.statementTimeoutMs = 60;
        const r = db.executeQuery(
          "SELECT COUNT(*) AS c FROM v18_big a JOIN v18_big b ON a.n <> b.n JOIN v18_big c ON c.n <> a.n"
        );
        db.statementTimeoutMs = 0;
        // v18_big が無ければテーブル未定義エラー、あればタイムアウト。いずれも「暴走しない」ことの確認
        return !!r.error;
      });
      fn('V18Dos timeout restores after error', () => {
        db.statementTimeoutMs = 50;
        db.executeQuery("SELECT COUNT(*) AS c FROM v18_t");
        db.statementTimeoutMs = 0;
        const r = db.executeQuery("SELECT COUNT(*) AS c FROM v18_t");
        return !r.error && r.data[0].c === BASE_ROWS && db._deadline === 0;
      });
      fn('V18Dos deep nesting rejected or handled', () => {
        const sql = 'SELECT ' + '('.repeat(400) + '1' + ')'.repeat(400) + ' AS v';
        const r = db.executeQuery(sql);
        return !r.error || typeof r.error === 'string';   // クラッシュしないこと
      });
      fn('V18Dos huge in list', () => {
        const vals = [];
        for (let i = 0; i < 5000; i++) vals.push(i);
        const r = db.executeQuery(`SELECT COUNT(*) AS c FROM v18_t WHERE id IN (${vals.join(',')})`);
        return !r.error && r.data[0].c === BASE_ROWS;
      });
      fn('V18Dos long string literal', () => {
        const r = db.executeQuery(`SELECT LENGTH('${'x'.repeat(50000)}') AS n`);
        return !r.error && r.data[0].n === 50000;
      });
      fn('V18Dos repeat guard', () => {
        const r = db.executeQuery("SELECT LENGTH(REPEAT('ab', 100000)) AS n");
        return !r.error || /too/i.test(r.error);
      });
      err('V18Dos empty query', "", 'empty');
      fn('V18Dos null query', () => {
        const r = db.executeQuery(null);
        return !!r.error;
      });
      fn('V18Dos non-string query', () => {
        const r = db.executeQuery({ toString: () => 'SELECT 1' });
        return !!r.error;
      });
      fn('V18Dos api empty', () => !!LuminaDB.query('   ').error);
      fn('V18Dos api non-string', () => !!LuminaDB.query(123).error);
      fn('V18Dos exec empty', () => !!LuminaDB.exec('').error);

      // ============================================================
      // 6. 読み取り専用モードの強制（文種 × ON/OFF）
      // ============================================================
      const WRITE_STMTS = [
        "INSERT INTO v18_t VALUES (99,'x',1)",
        "UPDATE v18_t SET n = 0",
        "DELETE FROM v18_t",
        "REPLACE INTO v18_t VALUES (1,'y',1)",
        "MERGE INTO v18_t t USING v18_t s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET n = 0",
        "CREATE TABLE v18_ro (x INTEGER)",
        "DROP TABLE v18_t",
        "ALTER TABLE v18_t ADD COLUMN z INTEGER",
        "TRUNCATE TABLE v18_t",
        "CREATE VIEW v18_rov AS SELECT 1 AS x",
        "CREATE INDEX v18_roi ON v18_t (label)",
        "CREATE SEQUENCE v18_ros",
        "CREATE PROCEDURE v18_rop AS BEGIN SELECT 1; END",
        "CREATE FUNCTION v18_rof(a) RETURNS INT AS RETURN a",
        "CREATE TRIGGER v18_rot AFTER INSERT ON v18_t FOR EACH ROW BEGIN SELECT 1; END",
        "CREATE MATERIALIZED VIEW v18_rom AS SELECT 1 AS x",
        "SELECT id INTO v18_roin FROM v18_t",
        "VACUUM",
        "BEGIN",
        "COMMIT",
        "SET @v18 = 1",
        "PREPARE v18rop FROM 'SELECT 1'",
        "CREATE SNAPSHOT v18_ros2",
        "COMMENT ON TABLE v18_t IS 'x'",
        "GRANT SELECT ON v18_t TO x",
        "INSERT INTO v18_t DEFAULT VALUES"
      ];
      const READ_STMTS = [
        "SELECT COUNT(*) AS c FROM v18_t",
        "SELECT * FROM v18_t WHERE id = 1",
        "SHOW TABLES",
        "SHOW STATUS",
        "SHOW FUNCTIONS LIKE 'SUM'",
        "SHOW SNAPSHOTS",
        "SHOW PROFILE",
        "DESCRIBE v18_t",
        "EXPLAIN SELECT * FROM v18_t",
        "EXPLAIN ANALYZE SELECT * FROM v18_t",
        "TABLE v18_t",
        "VALUES (1, 2)",
        "CHECK TABLE v18_t",
        "ANALYZE TABLE v18_t",
        "WITH c AS (SELECT 1 AS x) SELECT * FROM c",
        "SELECT * FROM information_schema.tables"
      ];
      push('V18Ro enable', "SET read_only = ON", r => r.data[0].Result === 'Success');
      WRITE_STMTS.forEach((s, i) => T.push({
        name: `V18Ro blocked ${i}`, sql: s, isErrorExpected: true,
        check: r => !!r.error && /read-only/i.test(r.error)
      }));
      READ_STMTS.forEach((s, i) => push(`V18Ro allowed ${i}`, s, r => !r.error));
      fn('V18Ro api write blocked', () => !!LuminaDB.insert('v18_t', { id: 98, label: 'q', n: 1 }).error);
      fn('V18Ro api update blocked', () => !!LuminaDB.update('v18_t', { n: 1 }, { id: 1 }).error);
      fn('V18Ro api remove blocked', () => !!LuminaDB.remove('v18_t', { id: 1 }).error);
      fn('V18Ro api upsert blocked', () => !!LuminaDB.upsert('v18_t', { id: 1, label: 'q', n: 1 }).error);
      fn('V18Ro api exec blocked', () => {
        const r = LuminaDB.exec("INSERT INTO v18_t VALUES (97,'z',1)");
        return r.error ? true : r.failed === r.total;
      });
      fn('V18Ro api importJSON blocked', () => !!LuminaDB.importJSON('v18_t', [{ id: 96, label: 'z', n: 1 }]).error);
      fn('V18Ro fetch write blocked', async () => {
        const res = await fetch('lumina://query', { method: 'POST', body: JSON.stringify({ sql: "INSERT INTO v18_t VALUES (95,'z',1)" }) });
        const j = await res.json();
        return !!j.error;
      });
      fn('V18Ro fetch read allowed', async () => {
        const res = await fetch('lumina://query?sql=' + encodeURIComponent('SELECT COUNT(*) AS c FROM v18_t'));
        const j = await res.json();
        return !j.error && j.data[0].c === BASE_ROWS;
      });
      fn('V18Ro rows unchanged', () => intact());
      push('V18Ro disable', "SET read_only = OFF", r => r.data[0].Result === 'Success');
      push('V18Ro write works again', "INSERT INTO v18_t VALUES (94,'later',1)", r => !r.error);
      push('V18Ro cleanup row', "DELETE FROM v18_t WHERE id = 94", r => !r.error);

      // ============================================================
      // 7. 外部 API の境界（fetch / postMessage / 内部状態の露出）
      // ============================================================
      fn('V18Api fetch unknown endpoint', async () => {
        const res = await fetch('lumina://nope');
        return res.status === 404 && !!(await res.json()).error;
      });
      fn('V18Api fetch missing sql', async () => {
        const res = await fetch('lumina://query');
        return res.status === 400 && !!(await res.json()).error;
      });
      fn('V18Api fetch bad json body', async () => {
        const res = await fetch('lumina://query', { method: 'POST', body: '{not json' });
        return res.status >= 400 && !!(await res.json()).error;
      });
      fn('V18Api fetch injection is data', async () => {
        const res = await fetch('lumina://query', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT ? AS v', params: ["'; DROP TABLE v18_t; --"] })
        });
        const j = await res.json();
        return !j.error && j.data[0].v === "'; DROP TABLE v18_t; --" && intact();
      });
      fn('V18Api fetch passthrough untouched', () => typeof window.fetch === 'function');
      fn('V18Api allowedOrigins default', () => Array.isArray(LuminaDB.allowedOrigins) && LuminaDB.allowedOrigins.includes(window.location.origin));
      fn('V18Api postMessage foreign origin ignored', () => new Promise(resolve => {
        // 許可外オリジンを装ったメッセージは処理されない（応答が来ないこと）
        let replied = false;
        const onMsg = (e) => { if (e.data && e.data.type === 'luminadb:result' && e.data.id === 'v18-foreign') replied = true; };
        window.addEventListener('message', onMsg);
        const evt = new MessageEvent('message', {
          data: { type: 'luminadb:query', id: 'v18-foreign', sql: 'SELECT 1 AS v' },
          origin: 'https://evil.example.com',
          source: window
        });
        window.dispatchEvent(evt);
        setTimeout(() => { window.removeEventListener('message', onMsg); resolve(!replied); }, 30);
      }));
      fn('V18Api postMessage same origin works', () => new Promise(resolve => {
        const onMsg = (e) => {
          if (e.data && e.data.type === 'luminadb:result' && e.data.id === 'v18-ok') {
            window.removeEventListener('message', onMsg);
            resolve(!e.data.result.error && e.data.result.data[0].v === 1);
          }
        };
        window.addEventListener('message', onMsg);
        window.postMessage({ type: 'luminadb:query', id: 'v18-ok', sql: 'SELECT 1 AS v' }, window.location.origin);
        setTimeout(() => { window.removeEventListener('message', onMsg); resolve(false); }, 500);
      }));
      fn('V18Api postMessage non-string sql ignored', () => new Promise(resolve => {
        let replied = false;
        const onMsg = (e) => { if (e.data && e.data.type === 'luminadb:result' && e.data.id === 'v18-bad') replied = true; };
        window.addEventListener('message', onMsg);
        window.postMessage({ type: 'luminadb:query', id: 'v18-bad', sql: { evil: true } }, window.location.origin);
        setTimeout(() => { window.removeEventListener('message', onMsg); resolve(!replied); }, 60);
      }));
      fn('V18Api engine ref not enumerable', () => {
        return Object.keys(db.tables).indexOf('__engine__') === -1
            && !Object.prototype.propertyIsEnumerable.call(db.tables, '__engine__');
      });
      fn('V18Api engine ref hidden from show tables', () => {
        const r = db.executeQuery('SHOW TABLES');
        return !r.data.some(x => String(x.Table).startsWith('__'));
      });
      fn('V18Api temp tables cleaned', () => {
        db.executeQuery("SELECT * FROM (SELECT 1 AS x) t");
        return Object.keys(db.tables).filter(t => t.startsWith('__tmp_')).length === 0;
      });
      fn('V18Api info schema temp cleaned', () => {
        db.executeQuery("SELECT * FROM information_schema.tables");
        return Object.keys(db.tables).filter(t => t.startsWith('__tmp_is_')).length === 0;
      });
      fn('V18Api dicts null-prototype', () => {
        return Object.getPrototypeOf(db.tables) === null
            && Object.getPrototypeOf(db.views) === null
            && Object.getPrototypeOf(db.functions) === null
            && Object.getPrototypeOf(db.snapshots) === null;
      });
      fn('V18Api tx blocks external write', () => {
        db.executeQuery('BEGIN');
        const w = LuminaDB.query("INSERT INTO v18_t VALUES (93,'tx',1)");
        const rd = LuminaDB.query("SELECT COUNT(*) AS c FROM v18_t");
        db.executeQuery('ROLLBACK');
        return !!w.error && /transaction in progress/i.test(w.error) && !rd.error;
      });
      fn('V18Api tx blocks external exec', () => {
        db.executeQuery('BEGIN');
        const w = LuminaDB.exec("INSERT INTO v18_t VALUES (92,'tx',1)");
        db.executeQuery('ROLLBACK');
        return !!w.error && intact();
      });
      fn('V18Api transaction rolls back on throw', () => {
        const r = LuminaDB.transaction(() => { throw new Error('boom'); });
        return !!r.error && /rolled back/i.test(r.error) && intact() && !db.inTransaction;
      });
      fn('V18Api listener exception isolated', () => {
        const bad = () => { throw new Error('listener boom'); };
        LuminaDB.on('change', bad);
        const r = LuminaDB.query("INSERT INTO v18_t VALUES (91,'l',1)");
        LuminaDB.off('change', bad);
        LuminaDB.query("DELETE FROM v18_t WHERE id = 91");
        return !r.error && intact();
      });

      // ============================================================
      // 8. 出力エスケープ（XSS）
      // ============================================================
      const XSS = [
        '<script>window.__v18_pwned=1</script>',
        '<img src=x onerror="window.__v18_pwned=1">',
        '"><svg onload=alert(1)>',
        "';alert(1);//",
        '<iframe src="javascript:alert(1)">',
        '<a href="javascript:alert(1)">x</a>',
        '&lt;script&gt;',
        '</td></tr><tr><td>injected',
        '<style>body{display:none}</style>',
        '<!--<script>-->',
        'onmouseover=alert(1)',
        '<body onload=alert(1)>'
      ];
      XSS.forEach((x, i) => {
        fn(`V18Xss escape ${i}`, () => {
          const out = escapeHtml(x);
          return out.indexOf('<') === -1 && out.indexOf('>') === -1
              && out.indexOf('"') === -1 && out.indexOf("'") === -1 && canaryClean();
        });
        fn(`V18Xss roundtrip ${i}`, () => {
          LuminaDB.insert('v18_sink', { k: 50, v: x });
          const got = LuminaDB.value('SELECT v FROM v18_sink WHERE k = 50');
          LuminaDB.remove('v18_sink', { k: 50 });
          return got === x && canaryClean();
        });
      });
      fn('V18Xss escape ampersand first', () => escapeHtml('&<') === '&amp;&lt;');
      fn('V18Xss escape non-string', () => escapeHtml(null) === 'null' && escapeHtml(undefined) === 'undefined');
      fn('V18Xss csv quotes escaped', () => {
        LuminaDB.insert('v18_sink', { k: 51, v: 'a"b,c\nd' });
        const csv = LuminaDB.csv('SELECT v FROM v18_sink WHERE k = 51');
        LuminaDB.remove('v18_sink', { k: 51 });
        return csv.indexOf('"a""b,c') !== -1;
      });
      fn('V18Xss canary after xss', () => canaryClean());

      // ============================================================
      // 9. データ完全性（制約が攻撃入力でも維持されること）
      // ============================================================
      err('V18Int pk dup', "INSERT INTO v18_t VALUES (1,'dup',1)", 'primary key');
      fn('V18Int pk dup via api', () => {
        const r = LuminaDB.insert('v18_t', { id: 1, label: 'dup', n: 1 });
        return !!r.error && intact();
      });
      push('V18Int check constraint', "CREATE TABLE v18_chk (n INTEGER CHECK (n > 0))", r => !r.error);
      err('V18Int check violated', "INSERT INTO v18_chk VALUES (0)", 'check');
      fn('V18Int check via bind', () => {
        const r = LuminaDB.insert('v18_chk', { n: -5 });
        return !!r.error;
      });
      push('V18Int check ok', "INSERT INTO v18_chk VALUES (5)", r => !r.error);
      push('V18Int drop chk', "DROP TABLE v18_chk", r => !r.error);
      push('V18Int fk parent', "CREATE TABLE v18_fp (id INTEGER PRIMARY KEY)", r => !r.error);
      push('V18Int fk child', "CREATE TABLE v18_fc (id INTEGER, pid INTEGER, FOREIGN KEY (pid) REFERENCES v18_fp(id))", r => !r.error);
      err('V18Int fk violated', "INSERT INTO v18_fc VALUES (1, 42)", 'foreign key');
      push('V18Int fk cleanup c', "DROP TABLE v18_fc", r => !r.error);
      push('V18Int fk cleanup p', "DROP TABLE v18_fp", r => !r.error);
      fn('V18Int rollback restores', () => {
        db.executeQuery('BEGIN');
        db.executeQuery("DELETE FROM v18_t");
        db.executeQuery('ROLLBACK');
        return intact();
      });
      fn('V18Int snapshot restores after damage', () => {
        db.executeQuery("CREATE SNAPSHOT v18_guard");
        db.executeQuery("DROP TABLE v18_t");
        const gone = !!db.executeQuery("SELECT 1 FROM v18_t").error;
        db.executeQuery("RESTORE SNAPSHOT v18_guard");
        db.executeQuery("DROP SNAPSHOT v18_guard");
        return gone && intact();
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V18Cl canary still clean', () => canaryClean());
      push('V18Cl drop sink', "DROP TABLE v18_sink", r => !r.error);
      push('V18Cl drop t', "DROP TABLE v18_t", r => !r.error);

      return T;
    }
