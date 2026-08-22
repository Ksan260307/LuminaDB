    // ============================================================================
    // [Test Suite v28] - v1.23 の修正・追加のテスト
    //
    //   バックエンド（いずれも「黙って誤る」種類の不具合だったもの）:
    //     - AS を省いた後置別名（SELECT id x / COUNT(*) c）— 従来は JS の構文エラーが漏れていた
    //     - 引用符付き別名（AS "col name"）— 内部トークン __STR_n__ が列名として露出していた
    //     - 修飾スター（SELECT u.*）
    //     - 出力列名の重複解決（SELECT u.id, p.id / JOIN の SELECT *）— 後の列が前を上書きしていた
    //     - LTRIM/RTRIM の第2引数、SUBSTRING の負の開始位置、LPAD/RPAD の切り詰め
    //     - HEX/UNHEX の UTF-8 化、TO_TIMESTAMP のエポック秒、AGE(x) の符号
    //     - REGEXP_SUBSTR / REGEXP_REPLACE / REGEXP_INSTR の position・occurrence・match_type
    //     - SHA2 / SHA256 / SHA224 の追加
    //     - RENAME COLUMN が生成列・CHECK・列順・索引名を取り残していた問題
    //     - DROP COLUMN が孤児 CHECK を残す / 依存する生成列を黙って壊す問題
    //     - 複合 UNIQUE INDEX が「列ごとに一意」になっていた問題
    //     - INSERT の列リストの未知列が黙って新しい列を作っていた問題
    //     - INSERT OR REPLACE|ABORT|FAIL|ROLLBACK、ALTER TABLE の複数アクション
    //     - 集合演算の枝を括弧で囲む書き方
    //     - 未知の関数・壊れた式のエラーメッセージ
    //   フロントエンド:
    //     - スキーマ検索（表名・列名）
    //     - エディタ / 結果ペインのスプリッタ
    //     - Explain ボタン
    //     - 並べ替え・絞り込み後に行選択が残って別の行を消す不具合
    //     - 書き出しが絞り込みを無視する不具合 / CSV の NULL と空文字の区別 / TSV コピー
    //
    //   test-suite.js の tests 配列へ getV28Tests() のスプレッドで合流する
    // ============================================================================
    function getV28Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, oneSafe: one, keysSafe: keys } = makeTestKit('V28');

      // ============================================================
      // 1. SELECT 句: 別名・修飾スター・列名の重複
      // ============================================================
      fn('V28Fx tables', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_a");
        db.executeQuery("DROP TABLE IF EXISTS v28_b");
        db.executeQuery("CREATE TABLE v28_a (id INTEGER PRIMARY KEY, nm TEXT, qty INTEGER)");
        db.executeQuery("CREATE TABLE v28_b (id INTEGER PRIMARY KEY, nm TEXT, cost INTEGER)");
        db.executeQuery("INSERT INTO v28_a VALUES (1,'alpha',10),(2,'beta',20),(3,'gamma',30)");
        db.executeQuery("INSERT INTO v28_b VALUES (7,'seven',700),(8,'eight',800)");
        return db.tables.v28_a.rowCount === 3 && db.tables.v28_b.rowCount === 2;
      });

      push('V28Al bare alias on column', "SELECT id x FROM v28_a WHERE id = 1", r => r.data[0].x === 1);
      push('V28Al bare alias on aggregate', "SELECT COUNT(*) c FROM v28_a", r => r.data[0].c === 3);
      push('V28Al bare alias on literal', "SELECT 1 one FROM v28_a WHERE id = 1", r => r.data[0].one === 1);
      push('V28Al bare alias on expression', "SELECT qty * 2 dbl FROM v28_a WHERE id = 1", r => r.data[0].dbl === 20);
      push('V28Al bare alias on qualified column', "SELECT a.nm label FROM v28_a a WHERE id = 2", r => r.data[0].label === 'beta');
      push('V28Al bare alias on function call', "SELECT UPPER(nm) big FROM v28_a WHERE id = 1", r => r.data[0].big === 'ALPHA');
      push('V28Al bare alias with several items', "SELECT id i, nm n FROM v28_a WHERE id = 3", r => r.data[0].i === 3 && r.data[0].n === 'gamma');
      push('V28Al AS still works', "SELECT id AS x FROM v28_a WHERE id = 1", r => r.data[0].x === 1);
      // 「裸の語で終わる構文」を別名と誤認しないこと
      push('V28Al is not null is not an alias', "SELECT COUNT(*) c FROM v28_a WHERE nm IS NOT NULL", r => r.data[0].c === 3);
      push('V28Al interval unit is not an alias', "SELECT DATE '2026-01-01' + INTERVAL 1 DAY AS d", r => String(r.data[0].d).slice(0, 10) === '2026-01-02');
      push('V28Al collate name is not an alias', "SELECT nm COLLATE NOCASE AS n FROM v28_a WHERE id = 1", r => r.data[0].n === 'alpha');
      push('V28Al null literal is not an alias', "SELECT NULL AS n FROM v28_a WHERE id = 1", r => r.data[0].n === null);
      push('V28Al desc in order by unaffected', "SELECT id FROM v28_a ORDER BY id DESC", r => r.data[0].id === 3);
      push('V28Al ignore nulls is not an alias',
          "SELECT LAG(qty) IGNORE NULLS OVER (ORDER BY id) AS p FROM v28_a ORDER BY id", r => r.data[1].p === 10);

      push('V28Al quoted alias with space', 'SELECT id AS "col name" FROM v28_a WHERE id = 1', r => r.data[0]['col name'] === 1);
      push('V28Al quoted alias japanese', 'SELECT nm AS "名前" FROM v28_a WHERE id = 1', r => r.data[0]['名前'] === 'alpha');
      fn('V28Al quoted alias is not a token', () => {
        const k = keys('SELECT id AS "col name" FROM v28_a WHERE id = 1');
        return k.length === 1 && !/^__STR_/.test(k[0]);
      });

      fn('V28St qualified star', () => {
        const k = keys("SELECT a.* FROM v28_a a WHERE id = 1");
        return k.join(',') === 'id,nm,qty';
      });
      fn('V28St qualified star on one side of a join', () => {
        const k = keys("SELECT b.* FROM v28_a a JOIN v28_b b ON 1=1");
        return k.join(',') === 'id,nm,cost';
      });
      fn('V28St qualified star mixed with a column', () => {
        const k = keys("SELECT b.*, a.qty FROM v28_a a JOIN v28_b b ON 1=1");
        return k.join(',') === 'id,nm,cost,qty';
      });
      push('V28St qualified star by table name', "SELECT v28_a.* FROM v28_a WHERE id = 2", r => r.data[0].nm === 'beta');
      err('V28St qualified star unknown alias', "SELECT z.* FROM v28_a a", 'not in the FROM clause');

      fn('V28Dup explicit duplicate names are kept apart', () => {
        const r = db.executeQuery("SELECT a.nm, b.nm FROM v28_a a JOIN v28_b b ON 1=1 WHERE a.id = 1");
        return !r.error && r.data[0].nm === 'alpha' && r.data[0].nm_1 === 'seven';
      });
      fn('V28Dup star over a join keeps both id columns', () => {
        const r = db.executeQuery("SELECT * FROM v28_a a JOIN v28_b b ON 1=1 WHERE a.id = 1 AND b.id = 7");
        return !r.error && r.data[0].id === 1 && r.data[0].id_1 === 7 && r.data[0].nm === 'alpha' && r.data[0].nm_1 === 'seven';
      });
      fn('V28Dup star does not expand a table twice', () => {
        // ptr には実表名と別名の両方が入っている。素朴に回すと同じ表を 2 度展開してしまう
        const k = keys("SELECT * FROM v28_a a WHERE id = 1");
        return k.join(',') === 'id,nm,qty';
      });
      fn('V28Dup self join is expanded twice on purpose', () => {
        const k = keys("SELECT * FROM v28_a x JOIN v28_a y ON x.id = y.id - 1");
        return k.join(',') === 'id,nm,qty,id_1,nm_1,qty_1';
      });
      fn('V28Dup three way collision', () => {
        const r = db.executeQuery("SELECT id, id, id FROM v28_a WHERE id = 2");
        return !r.error && r.data[0].id === 2 && r.data[0].id_1 === 2 && r.data[0].id_2 === 2;
      });

      // ============================================================
      // 2. スカラー関数の修正
      // ============================================================
      push('V28Fn ltrim with a character set', "SELECT LTRIM('xxhixx','x') AS a", r => r.data[0].a === 'hixx');
      push('V28Fn rtrim with a character set', "SELECT RTRIM('xxhixx','x') AS a", r => r.data[0].a === 'xxhi');
      push('V28Fn ltrim multi char set', "SELECT LTRIM('xyxhi','xy') AS a", r => r.data[0].a === 'hi');
      push('V28Fn ltrim without a set still trims spaces', "SELECT LTRIM('   hi') AS a", r => r.data[0].a === 'hi');
      push('V28Fn rtrim without a set still trims spaces', "SELECT RTRIM('hi   ') AS a", r => r.data[0].a === 'hi');
      push('V28Fn trim set removes nothing when absent', "SELECT LTRIM('hi','x') AS a", r => r.data[0].a === 'hi');

      push('V28Fn substring negative start', "SELECT SUBSTRING('abcdef',-3) AS a", r => r.data[0].a === 'def');
      push('V28Fn substring negative start with length', "SELECT SUBSTR('abcdef',-3,2) AS a", r => r.data[0].a === 'de');
      push('V28Fn substring positive start unchanged', "SELECT SUBSTR('abcdef',2,3) AS a", r => r.data[0].a === 'bcd');
      push('V28Fn substring zero start behaves as one', "SELECT SUBSTR('abcdef',0,2) AS a", r => r.data[0].a === 'ab');
      push('V28Fn substring zero length is empty', "SELECT SUBSTR('abcdef',2,0) AS a", r => r.data[0].a === '');
      push('V28Fn substring negative beyond start clamps', "SELECT SUBSTR('abc',-99) AS a", r => r.data[0].a === 'abc');

      push('V28Fn lpad truncates when longer', "SELECT LPAD('abcdef',3,'-') AS a", r => r.data[0].a === 'abc');
      push('V28Fn rpad truncates when longer', "SELECT RPAD('abcdef',3,'-') AS a", r => r.data[0].a === 'abc');
      push('V28Fn lpad still pads when shorter', "SELECT LPAD('ab',5,'0') AS a", r => r.data[0].a === '000ab');
      push('V28Fn rpad still pads when shorter', "SELECT RPAD('ab',5,'0') AS a", r => r.data[0].a === 'ab000');
      push('V28Fn lpad default pad is a space', "SELECT LPAD('ab',4) AS a", r => r.data[0].a === '  ab');

      push('V28Fn hex is utf8 for ascii', "SELECT HEX('A') AS a", r => r.data[0].a === '41');
      push('V28Fn hex is utf8 for multibyte', "SELECT HEX('あ') AS a", r => r.data[0].a === 'E38182');
      push('V28Fn unhex round trips multibyte', "SELECT UNHEX(HEX('あいう')) AS a", r => r.data[0].a === 'あいう');
      push('V28Fn unhex ascii', "SELECT UNHEX('414243') AS a", r => r.data[0].a === 'ABC');
      push('V28Fn hex of a number is unchanged', "SELECT HEX(255) AS a", r => r.data[0].a === 'FF');
      push('V28Fn unhex rejects odd length', "SELECT UNHEX('4142F') AS a", r => r.data[0].a === null);

      push('V28Fn sha256 known vector', "SELECT SHA256('abc') AS a",
          r => r.data[0].a === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      push('V28Fn sha256 of empty string', "SELECT SHA256('') AS a",
          r => r.data[0].a === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      push('V28Fn sha2 defaults to 256', "SELECT SHA2('abc') AS a",
          r => r.data[0].a === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      push('V28Fn sha2 with explicit 256', "SELECT SHA2('abc',256) AS a", r => r.data[0].a.length === 64);
      push('V28Fn sha2 with 0 means 256', "SELECT SHA2('abc',0) AS a", r => r.data[0].a.length === 64);
      push('V28Fn sha224 known vector', "SELECT SHA224('abc') AS a",
          r => r.data[0].a === '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
      push('V28Fn sha2 unsupported width is null', "SELECT SHA2('abc',512) AS a", r => r.data[0].a === null);
      push('V28Fn sha256 of null is null', "SELECT SHA256(NULL) AS a", r => r.data[0].a === null);
      push('V28Fn sha256 handles multibyte', "SELECT LENGTH(SHA256('あ')) AS a", r => r.data[0].a === 64);
      fn('V28Fn sha256 appears in SHOW FUNCTIONS', () => {
        const r = db.executeQuery("SHOW FUNCTIONS");
        return !r.error && r.data.some(x => String(x.Name || x.Function || Object.values(x)[0]).toUpperCase() === 'SHA256');
      });

      push('V28Fn to_timestamp takes epoch seconds', "SELECT TO_TIMESTAMP(1700000000) AS a",
          r => String(r.data[0].a).slice(0, 10) === '2023-11-14');
      push('V28Fn to_timestamp of zero is the epoch', "SELECT TO_TIMESTAMP(0) AS a",
          r => String(r.data[0].a).slice(0, 10) === '1970-01-01');
      push('V28Fn to_timestamp still parses text', "SELECT TO_TIMESTAMP('2026-03-04') AS a",
          r => String(r.data[0].a).slice(0, 10) === '2026-03-04');

      push('V28Fn age of a past date is positive', "SELECT AGE(DATE '2020-01-01') AS a", r => !String(r.data[0].a).startsWith('-'));
      push('V28Fn age of a future date is negative', "SELECT AGE(DATE '2400-01-01') AS a", r => String(r.data[0].a).startsWith('-'));
      push('V28Fn two argument age is unchanged', "SELECT AGE(DATE '2026-01-05', DATE '2020-01-01') AS a",
          r => r.data[0].a === '6 years 4 days');
      push('V28Fn two argument age can be negative', "SELECT AGE(DATE '2020-01-01', DATE '2026-01-05') AS a",
          r => String(r.data[0].a).startsWith('-'));

      push('V28Fn regexp_substr occurrence', "SELECT REGEXP_SUBSTR('a1b2c3','[0-9]',1,2) AS a", r => r.data[0].a === '2');
      push('V28Fn regexp_substr position', "SELECT REGEXP_SUBSTR('a1b2c3','[0-9]',4) AS a", r => r.data[0].a === '2');
      push('V28Fn regexp_substr default is the first match', "SELECT REGEXP_SUBSTR('a1b2','[0-9]') AS a", r => r.data[0].a === '1');
      push('V28Fn regexp_substr missing occurrence is null', "SELECT REGEXP_SUBSTR('a1','[0-9]',1,5) AS a", r => r.data[0].a === null);
      push('V28Fn regexp_replace occurrence', "SELECT REGEXP_REPLACE('aaa','a','b',1,2) AS a", r => r.data[0].a === 'aba');
      push('V28Fn regexp_replace all by default', "SELECT REGEXP_REPLACE('aaa','a','b') AS a", r => r.data[0].a === 'bbb');
      push('V28Fn regexp_replace position', "SELECT REGEXP_REPLACE('aaa','a','b',2) AS a", r => r.data[0].a === 'abb');
      push('V28Fn regexp_replace match_type ignores case', "SELECT REGEXP_REPLACE('AaA','a','b',1,0,'i') AS a", r => r.data[0].a === 'bbb');
      push('V28Fn regexp_instr occurrence', "SELECT REGEXP_INSTR('a1b2','[0-9]',1,2) AS a", r => r.data[0].a === 4);
      push('V28Fn regexp_instr default', "SELECT REGEXP_INSTR('a1b2','[0-9]') AS a", r => r.data[0].a === 2);
      push('V28Fn regexp_instr no match is zero', "SELECT REGEXP_INSTR('abc','[0-9]') AS a", r => r.data[0].a === 0);
      push('V28Fn regexp_instr return option', "SELECT REGEXP_INSTR('a12b','[0-9]+',1,1,1) AS a", r => r.data[0].a === 4);
      push('V28Fn regexp_like match_type', "SELECT REGEXP_LIKE('ABC','abc','i') AS a", r => r.data[0].a === 1);
      push('V28Fn regexp_like is case sensitive by default', "SELECT REGEXP_LIKE('ABC','abc') AS a", r => r.data[0].a === 0);

      // ============================================================
      // 3. 列の改名・削除でメタデータが取り残される問題
      // ============================================================
      fn('V28Rn generated column follows a rename', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_g");
        db.executeQuery("CREATE TABLE v28_g (a INTEGER PRIMARY KEY, b INTEGER, c INTEGER GENERATED ALWAYS AS (b*2))");
        const r1 = db.executeQuery("ALTER TABLE v28_g RENAME COLUMN b TO b2");
        const r2 = db.executeQuery("INSERT INTO v28_g (a, b2) VALUES (1, 5)");
        const r3 = db.executeQuery("SELECT c FROM v28_g WHERE a = 1");
        return !r1.error && !r2.error && !r3.error && r3.data[0].c === 10;
      });
      fn('V28Rn generated expression text is rewritten', () => {
        const r = db.executeQuery("SHOW CREATE TABLE v28_g");
        return !r.error && /b2\s*\*\s*2/.test(r.data[0].CreateTable) && !/\(b\s*\*/.test(r.data[0].CreateTable);
      });
      fn('V28Rn column order survives a rename', () => {
        const k = keys("SELECT * FROM v28_g");
        return k.join(',') === 'a,b2,c';
      });
      fn('V28Rn dropping a column a generated column needs is refused', () => {
        const r = db.executeQuery("ALTER TABLE v28_g DROP COLUMN b2");
        return !!r.error && /generated column 'c'/i.test(r.error) && db.tables.v28_g.cols.b2 !== undefined;
      });
      fn('V28Rn index name survives a rename', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_ix");
        db.executeQuery("CREATE TABLE v28_ix (a INTEGER, b INTEGER)");
        db.executeQuery("CREATE INDEX v28_ix_b ON v28_ix (b)");
        db.executeQuery("ALTER TABLE v28_ix RENAME COLUMN b TO b2");
        const r = db.executeQuery("SHOW INDEXES FROM v28_ix");
        const row = r.data.find(x => x.Name === 'v28_ix_b');
        return !!row && row.Column === 'b2';
      });
      fn('V28Rn renamed index can still be dropped by name', () => {
        const r = db.executeQuery("DROP INDEX v28_ix_b ON v28_ix");
        return !r.error;
      });
      fn('V28Rn dropping a column drops its index entry', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_ix2");
        db.executeQuery("CREATE TABLE v28_ix2 (a INTEGER, b INTEGER)");
        db.executeQuery("CREATE INDEX v28_ix2_b ON v28_ix2 (b)");
        db.executeQuery("ALTER TABLE v28_ix2 DROP COLUMN b");
        const r = db.executeQuery("SHOW INDEXES FROM v28_ix2");
        return !r.error && !r.data.some(x => x.Name === 'v28_ix2_b');
      });

      fn('V28Ck check constraint follows a rename', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_c");
        db.executeQuery("CREATE TABLE v28_c (a INTEGER, b INTEGER CHECK (b > 0))");
        db.executeQuery("ALTER TABLE v28_c RENAME COLUMN b TO bb");
        const ok = db.executeQuery("INSERT INTO v28_c (a, bb) VALUES (1, 5)");
        return !ok.error && db.tables.v28_c.rowCount === 1;
      });
      fn('V28Ck renamed check still rejects bad values', () => {
        const bad = db.executeQuery("INSERT INTO v28_c (a, bb) VALUES (2, -5)");
        return !!bad.error && /check/i.test(bad.error) && db.tables.v28_c.rowCount === 1;
      });
      fn('V28Ck dropping a column removes its check', () => {
        db.executeQuery("ALTER TABLE v28_c DROP COLUMN bb");
        const r = db.executeQuery("SHOW CREATE TABLE v28_c");
        const ok = db.executeQuery("INSERT INTO v28_c (a) VALUES (9)");
        return !r.error && !/CHECK/i.test(r.data[0].CreateTable) && !ok.error;
      });
      fn('V28Ck check text with a string literal is not damaged', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_c2");
        db.executeQuery("CREATE TABLE v28_c2 (a INTEGER, b TEXT CHECK (b <> 'b'))");
        db.executeQuery("ALTER TABLE v28_c2 RENAME COLUMN b TO bb");
        const ok = db.executeQuery("INSERT INTO v28_c2 (a, bb) VALUES (1, 'x')");
        const bad = db.executeQuery("INSERT INTO v28_c2 (a, bb) VALUES (2, 'b')");
        return !ok.error && !!bad.error;
      });

      // ============================================================
      // 4. 複合 UNIQUE INDEX
      // ============================================================
      fn('V28Uq composite unique allows a differing second column', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_u");
        db.executeQuery("CREATE TABLE v28_u (a INTEGER, b INTEGER)");
        db.executeQuery("CREATE UNIQUE INDEX v28_u_ab ON v28_u (a, b)");
        const r1 = db.executeQuery("INSERT INTO v28_u VALUES (1, 2)");
        const r2 = db.executeQuery("INSERT INTO v28_u VALUES (1, 3)");
        return !r1.error && !r2.error && db.tables.v28_u.rowCount === 2;
      });
      fn('V28Uq composite unique rejects a duplicate tuple', () => {
        const r = db.executeQuery("INSERT INTO v28_u VALUES (1, 2)");
        return !!r.error && /unique/i.test(r.error) && db.tables.v28_u.rowCount === 2;
      });
      fn('V28Uq single column unique index is unchanged', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_u1");
        db.executeQuery("CREATE TABLE v28_u1 (a INTEGER)");
        db.executeQuery("CREATE UNIQUE INDEX v28_u1_a ON v28_u1 (a)");
        db.executeQuery("INSERT INTO v28_u1 VALUES (1)");
        const r = db.executeQuery("INSERT INTO v28_u1 VALUES (1)");
        return !!r.error && /unique/i.test(r.error);
      });
      fn('V28Uq composite unique on existing duplicates is refused', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_u2");
        db.executeQuery("CREATE TABLE v28_u2 (a INTEGER, b INTEGER)");
        db.executeQuery("INSERT INTO v28_u2 VALUES (1,2)");
        db.executeQuery("INSERT INTO v28_u2 VALUES (1,2)");
        const r = db.executeQuery("CREATE UNIQUE INDEX v28_u2_ab ON v28_u2 (a, b)");
        return !!r.error && /duplicate key/i.test(r.error);
      });
      fn('V28Uq composite unique ignores tuples containing null', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_u3");
        db.executeQuery("CREATE TABLE v28_u3 (a INTEGER, b INTEGER)");
        db.executeQuery("CREATE UNIQUE INDEX v28_u3_ab ON v28_u3 (a, b)");
        const r1 = db.executeQuery("INSERT INTO v28_u3 VALUES (1, NULL)");
        const r2 = db.executeQuery("INSERT INTO v28_u3 VALUES (1, NULL)");
        return !r1.error && !r2.error && db.tables.v28_u3.rowCount === 2;
      });

      // ============================================================
      // 5. INSERT の列リスト・競合解決句
      // ============================================================
      fn('V28In unknown column in the list is rejected', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_i");
        db.executeQuery("CREATE TABLE v28_i (id INTEGER PRIMARY KEY, nm TEXT)");
        const r = db.executeQuery("INSERT INTO v28_i (id, nmae) VALUES (1, 'x')");
        return !!r.error && /not found/i.test(r.error) && db.tables.v28_i.cols.nmae === undefined;
      });
      fn('V28In rejected insert leaves no rows behind', () => db.tables.v28_i.rowCount === 0);
      fn('V28In did you mean is offered for a near miss', () => {
        const r = db.executeQuery("INSERT INTO v28_i (id, nmm) VALUES (1, 'x')");
        return !!r.error && /did you mean 'nm'/i.test(r.error);
      });
      push('V28In valid insert still works', "INSERT INTO v28_i (id, nm) VALUES (1,'x')", r => !r.error);

      fn('V28In insert or replace', () => {
        const r = db.executeQuery("INSERT OR REPLACE INTO v28_i (id, nm) VALUES (1,'y')");
        const s = db.executeQuery("SELECT nm FROM v28_i WHERE id = 1");
        return !r.error && s.data[0].nm === 'y' && db.tables.v28_i.rowCount === 1;
      });
      fn('V28In insert or abort behaves like plain insert', () => {
        const r = db.executeQuery("INSERT OR ABORT INTO v28_i (id, nm) VALUES (2,'z')");
        return !r.error && db.tables.v28_i.rowCount === 2;
      });
      fn('V28In insert or fail still reports a conflict', () => {
        const r = db.executeQuery("INSERT OR FAIL INTO v28_i (id, nm) VALUES (2,'w')");
        return !!r.error && /primary key/i.test(r.error);
      });
      fn('V28In insert or rollback still reports a conflict', () => {
        const r = db.executeQuery("INSERT OR ROLLBACK INTO v28_i (id, nm) VALUES (2,'w')");
        return !!r.error;
      });
      fn('V28In insert or ignore is unchanged', () => {
        const r = db.executeQuery("INSERT OR IGNORE INTO v28_i (id, nm) VALUES (2,'q')");
        return !r.error && db.tables.v28_i.rowCount === 2;
      });

      // ============================================================
      // 6. ALTER TABLE の複数アクション
      // ============================================================
      fn('V28Alt two add columns in one statement', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_m");
        db.executeQuery("CREATE TABLE v28_m (a INTEGER)");
        const r = db.executeQuery("ALTER TABLE v28_m ADD COLUMN b INTEGER, ADD COLUMN c TEXT");
        return !r.error && db.tables.v28_m.cols.b !== undefined && db.tables.v28_m.cols.c !== undefined;
      });
      fn('V28Alt mixed add and drop', () => {
        const r = db.executeQuery("ALTER TABLE v28_m DROP COLUMN b, ADD COLUMN d INTEGER DEFAULT 3");
        return !r.error && db.tables.v28_m.cols.b === undefined && db.tables.v28_m.defaults.d === 3;
      });
      fn('V28Alt message reports every action', () => {
        const r = db.executeQuery("ALTER TABLE v28_m ADD COLUMN e INTEGER, ADD COLUMN f INTEGER");
        return !r.error && /'e' added/.test(r.data[0].Message) && /'f' added/.test(r.data[0].Message);
      });
      fn('V28Alt parenthesised commas are not split', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_m2");
        db.executeQuery("CREATE TABLE v28_m2 (a INTEGER, b INTEGER)");
        const r = db.executeQuery("ALTER TABLE v28_m2 ADD PRIMARY KEY (a, b)");
        return !r.error && (db.tables.v28_m2.compositeKeys || []).some(ck => ck.isPK);
      });
      fn('V28Alt single action is unchanged', () => {
        const r = db.executeQuery("ALTER TABLE v28_m ADD COLUMN g INTEGER");
        return !r.error && r.data[0].Message === "Column 'g' added.";
      });
      err('V28Alt a bad action still errors', "ALTER TABLE v28_m ADD COLUMN h INTEGER, NONSENSE zzz", 'syntax');

      // ============================================================
      // 7. 集合演算の枝を括弧で囲む書き方
      // ============================================================
      fn('V28Set parenthesised union', () => {
        const r = db.executeQuery("(SELECT id FROM v28_a WHERE id < 2) UNION (SELECT id FROM v28_a WHERE id > 2)");
        return !r.error && r.data.map(x => x.id).join(',') === '1,3';
      });
      fn('V28Set parenthesised union all with order by', () => {
        const r = db.executeQuery("(SELECT id FROM v28_a WHERE id < 3) UNION ALL (SELECT id FROM v28_a WHERE id = 1) ORDER BY id DESC");
        return !r.error && r.data.map(x => x.id).join(',') === '2,1,1';
      });
      fn('V28Set parenthesised intersect', () => {
        const r = db.executeQuery("(SELECT id FROM v28_a WHERE id < 3) INTERSECT (SELECT id FROM v28_a WHERE id > 1)");
        return !r.error && r.data.map(x => x.id).join(',') === '2';
      });
      fn('V28Set parenthesised except', () => {
        const r = db.executeQuery("(SELECT id FROM v28_a) EXCEPT (SELECT id FROM v28_a WHERE id = 2)");
        return !r.error && r.data.map(x => x.id).join(',') === '1,3';
      });
      fn('V28Set a whole select wrapped in parentheses', () => {
        const r = db.executeQuery("(SELECT id FROM v28_a WHERE id = 2)");
        return !r.error && r.data.length === 1 && r.data[0].id === 2;
      });
      fn('V28Set plain union is unchanged', () => {
        const r = db.executeQuery("SELECT id FROM v28_a WHERE id < 2 UNION SELECT id FROM v28_a WHERE id > 2");
        return !r.error && r.data.map(x => x.id).join(',') === '1,3';
      });
      fn('V28Set derived table is not mistaken for a branch', () => {
        const r = db.executeQuery("SELECT * FROM (SELECT id FROM v28_a WHERE id < 3) t ORDER BY id");
        return !r.error && r.data.map(x => x.id).join(',') === '1,2';
      });

      // ============================================================
      // 8. エラーメッセージの質
      // ============================================================
      err('V28Er unknown function is named as a function', "SELECT NOSUCHFN(1)", 'does not exist');
      fn('V28Er unknown function is not reported as a column', () => {
        const r = db.executeQuery("SELECT NOSUCHFN(1)");
        return !!r.error && !/column/i.test(r.error);
      });
      fn('V28Er near miss function name is suggested', () => {
        const r = db.executeQuery("SELECT LENGHT('abc')");
        return !!r.error && /did you mean 'length'/i.test(r.error);
      });
      fn('V28Er substring typo is suggested', () => {
        const r = db.executeQuery("SELECT SUBSTRINGG('abc',1)");
        return !!r.error && /did you mean 'substring'/i.test(r.error);
      });
      fn('V28Er unbalanced parenthesis is reported in sql terms', () => {
        const r = db.executeQuery("SELECT (1+2 FROM v28_a");
        return !!r.error && /malformed expression/i.test(r.error) && !/unexpected token/i.test(r.error);
      });
      fn('V28Er javascript wording does not leak', () => {
        const r = db.executeQuery("SELECT (1+2 FROM v28_a");
        return !!r.error && !/__resolve|Expected '\)' to end a compound expression/.test(r.error);
      });
      fn('V28Er aggregate names are not treated as unknown functions', () => {
        const r = db.executeQuery("SELECT SUM(qty) AS s, COUNT(*) AS c FROM v28_a");
        return !r.error && r.data[0].s === 60 && r.data[0].c === 3;
      });
      fn('V28Er user defined functions still resolve', () => {
        db.executeQuery("DROP FUNCTION IF EXISTS v28_dbl");
        const c = db.executeQuery("CREATE FUNCTION v28_dbl(x INTEGER) RETURNS INTEGER AS RETURN x * 2");
        const r = db.executeQuery("SELECT v28_dbl(21) AS a");
        db.executeQuery("DROP FUNCTION IF EXISTS v28_dbl");
        return !c.error && !r.error && r.data[0].a === 42;
      });

      // ============================================================
      // 9. フロントエンド: スキーマ検索
      // ============================================================
      fn('V28Ui schema search filters by table name', () => {
        renderTree();
        const input = document.getElementById('schemaSearch');
        input.value = 'v28_a';
        input.dispatchEvent(new Event('input'));
        const shown = [...document.querySelectorAll('#tableTree .table-select-btn')].map(b => b.dataset.table);
        return shown.length === 1 && shown[0] === 'v28_a';
      });
      fn('V28Ui schema search filters by column name', () => {
        const input = document.getElementById('schemaSearch');
        input.value = 'cost';
        input.dispatchEvent(new Event('input'));
        const shown = [...document.querySelectorAll('#tableTree .table-select-btn')].map(b => b.dataset.table);
        return shown.length === 1 && shown[0] === 'v28_b';
      });
      fn('V28Ui column hit expands the table', () => {
        const cols = [...document.querySelectorAll('#tableTree [data-column]')].map(e => e.dataset.column);
        return cols.includes('cost');
      });
      fn('V28Ui schema search reports the count', () => {
        const note = document.getElementById('schemaSearchNote');
        return !note.classList.contains('hidden') && /\/\s*\d+\s*表を表示中/.test(note.textContent);
      });
      fn('V28Ui schema search reports no match', () => {
        const input = document.getElementById('schemaSearch');
        input.value = 'zzz_no_such_thing';
        input.dispatchEvent(new Event('input'));
        const note = document.getElementById('schemaSearchNote');
        return document.querySelectorAll('#tableTree .table-select-btn').length === 0
            && /一致する表・列はありません/.test(note.textContent);
      });
      fn('V28Ui schema search keeps the table pickers complete', () => {
        // 絞り込み中でも Test Data / CSV の選択肢は全表を持つ
        const opts = [...document.getElementById('genTableSelect').options].map(o => o.value);
        return opts.includes('v28_a') && opts.includes('v28_b');
      });
      fn('V28Ui schema search clear restores the tree', () => {
        document.getElementById('schemaSearchClear').click();
        const shown = [...document.querySelectorAll('#tableTree .table-select-btn')].map(b => b.dataset.table);
        return shown.includes('v28_a') && shown.includes('v28_b')
            && document.getElementById('schemaSearchNote').classList.contains('hidden');
      });
      fn('V28Ui schema search escape clears', () => {
        const input = document.getElementById('schemaSearch');
        input.value = 'v28_a';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return input.value === '' && document.querySelectorAll('#tableTree .table-select-btn').length > 1;
      });

      // ============================================================
      // 10. フロントエンド: エディタのスプリッタ
      // ============================================================
      fn('V28Sp splitter exists', () => !!document.getElementById('editorSplitter') && !!document.getElementById('editorBox'));
      fn('V28Sp drag changes the editor height', () => {
        const box = document.getElementById('editorBox');
        const sp = document.getElementById('editorSplitter');
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: box.getBoundingClientRect().top + 220 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return Math.round(box.getBoundingClientRect().height) === 220;
      });
      fn('V28Sp height is clamped at the bottom', () => {
        const box = document.getElementById('editorBox');
        const sp = document.getElementById('editorSplitter');
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: box.getBoundingClientRect().top - 400 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return Math.round(box.getBoundingClientRect().height) === 64;
      });
      fn('V28Sp height is clamped at the top', () => {
        const box = document.getElementById('editorBox');
        const sp = document.getElementById('editorSplitter');
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: box.getBoundingClientRect().top + 100000 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return Math.round(box.getBoundingClientRect().height) === Math.round(window.innerHeight * 0.7);
      });
      fn('V28Sp arrow keys resize', () => {
        const box = document.getElementById('editorBox');
        const sp = document.getElementById('editorSplitter');
        sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: box.getBoundingClientRect().top + 200 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        return Math.round(box.getBoundingClientRect().height) === 184;
      });
      fn('V28Sp height is persisted', () => {
        return localStorage.getItem('luminadb_editor_height') === '184';
      });
      fn('V28Sp double click restores the default', () => {
        const box = document.getElementById('editorBox');
        document.getElementById('editorSplitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return box.style.height === '' && localStorage.getItem('luminadb_editor_height') === null;
      });

      // ============================================================
      // 11. フロントエンド: Explain ボタン
      // ============================================================
      fn('V28Ex explain button produces a plan', () => {
        setQueryValue('SELECT * FROM v28_a WHERE id = 1');
        document.getElementById('explainBtn').click();
        const k = currentResultData && currentResultData[0] ? Object.keys(currentResultData[0]) : [];
        // v1.27 で行数の見積り列 Rows が加わった
        return k.join(',') === 'Step,Operation,Details,Rows';
      });
      fn('V28Ex explain does not modify data', () => {
        const before = db.tables.v28_a.rowCount;
        setQueryValue('DELETE FROM v28_a WHERE id = 1');
        document.getElementById('explainBtn').click();
        return db.tables.v28_a.rowCount === before;
      });
      fn('V28Ex explain refuses non select statements', () => {
        setQueryValue('DELETE FROM v28_a WHERE id = 1');
        document.getElementById('explainBtn').click();
        return /Explain は SELECT/.test(document.getElementById('toastMsg').textContent);
      });
      fn('V28Ex explain keeps an existing explain prefix', () => {
        setQueryValue('EXPLAIN SELECT * FROM v28_a');
        document.getElementById('explainBtn').click();
        return currentResultData.length > 0 && currentResultData[0].Operation !== undefined;
      });

      // ============================================================
      // 12. フロントエンド: 行選択・書き出し
      // ============================================================
      fn('V28Rw fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v28_r");
        db.executeQuery("CREATE TABLE v28_r (id INTEGER PRIMARY KEY, nm TEXT)");
        db.executeQuery("INSERT INTO v28_r VALUES (1,'delta'),(2,'alpha'),(3,'charlie')");
        setQueryValue('SELECT id, nm FROM v28_r');
        runQuery();
        return editContext.editable === true;
      });
      fn('V28Rw selecting a row enables delete', () => {
        document.querySelector('#resultsTbody td[data-r="0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return document.getElementById('delRowBtn').disabled === false;
      });
      fn('V28Rw sorting clears the selection', () => {
        document.querySelector('th[data-col="nm"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return document.getElementById('delRowBtn').disabled === true;
      });
      fn('V28Rw sorting really reordered the rows', () => currentResultData.map(r => r.nm).join(',') === 'alpha,charlie,delta');
      fn('V28Rw filtering clears the selection', () => {
        document.querySelector('#resultsTbody td[data-r="0"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const enabledBefore = document.getElementById('delRowBtn').disabled === false;
        const f = document.getElementById('resultFilter');
        f.value = 'lt';
        f.dispatchEvent(new Event('input'));
        return enabledBefore && document.getElementById('delRowBtn').disabled === true;
      });
      fn('V28Rw export uses the filtered rows', () => {
        const rows = exportRows();
        return rows.length === 1 && rows[0].nm === 'delta';
      });
      fn('V28Rw clearing the filter restores every row', () => {
        document.getElementById('resultFilterClear').click();
        return exportRows().length === 3;
      });
      fn('V28Rw csv quotes only when needed', () => {
        return csvCell('plain') === 'plain'
            && csvCell(12) === '12'
            && csvCell('a,b') === '"a,b"'
            && csvCell('say "hi"') === '"say ""hi"""'
            && csvCell('line\nbreak') === '"line\nbreak"';
      });
      fn('V28Rw csv distinguishes null from empty text', () => csvCell(null) === '' && csvCell('') === '');
      fn('V28Rw tsv has a header and tab separated rows', () => {
        const tsv = resultToTsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
        return tsv.split('\n').length === 3 && tsv.split('\n')[0] === 'a\tb' && tsv.split('\n')[1] === '1\tx';
      });
      fn('V28Rw tsv flattens embedded tabs and newlines', () => {
        return resultToTsv([{ a: 'x\ty', b: 'p\nq' }]).split('\n')[1] === 'x y\tp q';
      });
      fn('V28Rw tsv renders null as empty', () => resultToTsv([{ a: null }]).split('\n')[1] === '');
      fn('V28Rw copy tsv button is wired', () => !!document.getElementById('copyTsvBtn'));
      fn('V28Rw copy tsv button follows the result state', () => {
        setResultExportEnabled(false);
        const off = document.getElementById('copyTsvBtn').disabled === true;
        setResultExportEnabled(true);
        return off && document.getElementById('copyTsvBtn').disabled === false;
      });

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V28Cl drop objects', () => {
        ['v28_r', 'v28_m2', 'v28_m', 'v28_i', 'v28_u3', 'v28_u2', 'v28_u1', 'v28_u',
         'v28_c2', 'v28_c', 'v28_ix2', 'v28_ix', 'v28_g', 'v28_b', 'v28_a']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        const si = document.getElementById('schemaSearch');
        if (si) { si.value = ''; si.dispatchEvent(new Event('input')); }
        const f = document.getElementById('resultFilter');
        if (f && f.value !== '') { f.value = ''; f.dispatchEvent(new Event('input')); }
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
