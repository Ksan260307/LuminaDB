    // ============================================================================
    // [Test Suite v55] - 書き味 (5/5): DML・DDL・トランザクション
    //
    //   書き換え系の文も「書き方を変えても同じ状態になる」ことを確かめる。
    //   各テストはフィクスチャを作り直してから 1 文を実行し、実行後の表の中身
    //   （DDL はスキーマ）を、1 行で書いた基準の形と突き合わせる。
    //
    //     A. INSERT の書き方（列リスト・複数行・SELECT 挿入・SET 形・UPSERT）
    //     B. UPDATE の書き方（SET の並び・別名・副問い合わせ・FROM 併用）
    //     C. DELETE の書き方
    //     D. DDL の書き方（列定義・制約・ALTER・索引）
    //     E. トランザクション文の綴り
    //     F. 書き換え系の字句変換（大小文字・空白・改行・コメント・セミコロン）
    //     G. 空白 1 個ずつを改行 / ブロックコメントへ差し替える総当たり
    //     H. 受け付けない書き方
    //
    //   test-suite.js の tests 配列へ getV55Tests() のスプレッドで合流する
    // ============================================================================
    function getV55Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, valsOf, outside, upper, lower, spaced,
              wsPos, swap, tag, insertRows, drop, cleanup } = makeTestKit('V55');

      // ------------------------------------------------------------
      // 0. フィクスチャ（毎テスト作り直す。行数を絞って作り直しを軽くする）
      // ------------------------------------------------------------
      const BASE_ROWS = [
        [1, 'ann', 'X', 100, true], [2, 'bob', 'Y', 200, false],
        [3, 'cid', 'X', 300, true], [4, 'dee', 'Z', null, true],
        [5, 'eve', 'Y', 500, false], [6, 'fay', null, 600, true]
      ];
      const reset = () => {
        q('DELETE FROM v55_t');
        insertRows('v55_t', BASE_ROWS);
      };
      const stateOf = () => valsOf('SELECT id, name, dept, sal, active FROM v55_t ORDER BY id');
      t('V55 fixture', () => {
        drop('v55_t', 'v55_src');
        q("CREATE TABLE v55_t (id INT PRIMARY KEY, name TEXT, dept TEXT, sal INT, active BOOLEAN DEFAULT TRUE)");
        q("CREATE TABLE v55_src (id INT PRIMARY KEY, name TEXT, dept TEXT, sal INT)");
        insertRows('v55_src', [[11, 'kim', 'Z', 900], [12, 'lee', 'Z', 800]]);
        reset();
        return db.tables['v55_t'].rowCount === 6 && db.tables['v55_src'].rowCount === 2;
      });

      // 書き換え文を実行して、実行後の表の中身を基準の形と比べる
      const stateCache = Object.create(null);
      const baseState = (sql) => {
        if (!(sql in stateCache)) {
          reset();
          const r = q(sql);
          if (r.error) throw new Error('基準の文が失敗した: ' + r.error);
          stateCache[sql] = stateOf();
        }
        return stateCache[sql];
      };
      const dmlSame = (name, base, variant) => t(name, () => {
        const want = baseState(base);
        reset();
        const r = q(variant);
        if (r.error) throw new Error(r.error + ' :: ' + variant.replace(/\s+/g, ' ').slice(0, 150));
        const got = stateOf();
        if (got !== want) {
          throw new Error('expected ' + want.slice(0, 200) + ' but got ' + got.slice(0, 200)
            + ' :: ' + variant.replace(/\s+/g, ' ').slice(0, 150));
        }
        return true;
      });

      // ============================================================
      // A〜C. 書き換え文の基準形（この一覧に F・G の機械変換を掛ける）
      // ============================================================
      const STMTS = [
        // INSERT
        ['A', "INSERT INTO v55_t VALUES (7, 'gil', 'X', 700, TRUE)"],
        ['A', "INSERT INTO v55_t (id, name, dept, sal, active) VALUES (7, 'gil', 'X', 700, TRUE)"],
        ['A', "INSERT INTO v55_t (dept, id, name) VALUES ('X', 7, 'gil')"],
        ['A', "INSERT INTO v55_t (id, name) VALUES (7, 'gil'), (8, 'hal'), (9, 'ivy')"],
        ['A', "INSERT INTO v55_t SET id = 7, name = 'gil', dept = 'X'"],
        ['A', "INSERT INTO v55_t (id, name, dept, sal) SELECT id, name, dept, sal FROM v55_src"],
        ['A', "INSERT INTO v55_t (id, name) SELECT 21, 'x' UNION ALL SELECT 22, 'y'"],
        ['A', "INSERT INTO v55_t (id, name, sal) VALUES (7, 'gil', 100 + 600)"],
        ['A', "INSERT INTO v55_t (id, name, active) VALUES (7, 'gil', DEFAULT)"],
        ['A', "REPLACE INTO v55_t (id, name, dept, sal, active) VALUES (1, 'ANN', 'X', 111, TRUE)"],
        ['A', "INSERT INTO v55_t (id, name) VALUES (1, 'zz') ON DUPLICATE KEY UPDATE name = 'zz'"],
        ['A', "INSERT INTO v55_t (id, name) VALUES (1, 'zz') ON CONFLICT (id) DO UPDATE SET name = 'zz'"],
        ['A', "INSERT INTO v55_t (id, name) VALUES (1, 'zz') ON CONFLICT DO NOTHING"],
        ['A', "INSERT IGNORE INTO v55_t (id, name) VALUES (1, 'zz')"],
        // UPDATE
        ['B', "UPDATE v55_t SET sal = 111 WHERE id = 2"],
        ['B', "UPDATE v55_t SET sal = sal + 1, name = UPPER(name) WHERE id = 2"],
        ['B', "UPDATE v55_t SET name = UPPER(name), sal = sal + 1 WHERE id = 2"],
        ['B', "UPDATE v55_t AS x SET x.sal = 5 WHERE x.id = 3"],
        ['B', "UPDATE v55_t x SET sal = 5 WHERE x.id = 3"],
        ['B', "UPDATE v55_t SET sal = (SELECT MAX(sal) FROM v55_src) WHERE id = 3"],
        ['B', "UPDATE v55_t SET sal = CASE WHEN sal > 200 THEN sal * 2 ELSE 0 END"],
        ['B', "UPDATE v55_t SET sal = 1 WHERE dept IN ('X', 'Y')"],
        ['B', "UPDATE v55_t SET sal = 1 WHERE EXISTS (SELECT 1 FROM v55_src s WHERE s.dept = v55_t.dept)"],
        ['B', "UPDATE v55_t SET active = NOT active WHERE sal IS NOT NULL"],
        ['B', "UPDATE v55_t SET sal = 9 ORDER BY id LIMIT 2"],
        ['B', "UPDATE v55_t SET dept = COALESCE(dept, 'W')"],
        // DELETE
        ['C', "DELETE FROM v55_t WHERE id = 3"],
        ['C', "DELETE FROM v55_t WHERE sal IS NULL"],
        ['C', "DELETE FROM v55_t WHERE dept IN ('X', 'Y')"],
        ['C', "DELETE FROM v55_t WHERE id IN (SELECT id - 8 FROM v55_src)"],
        ['C', "DELETE FROM v55_t WHERE EXISTS (SELECT 1 FROM v55_src s WHERE s.dept = v55_t.dept)"],
        ['C', "DELETE FROM v55_t ORDER BY id DESC LIMIT 2"],
        ['C', "DELETE FROM v55_t WHERE NOT active"],
        ['C', "DELETE FROM v55_t"],
      ];

      // 意味は同じで組み立て方が違う書き方
      [
        ['A INSERT の列リストを並べ替える',
         "INSERT INTO v55_t (id, name, dept) VALUES (7, 'gil', 'X')",
         "INSERT INTO v55_t (dept, name, id) VALUES ('X', 'gil', 7)"],
        ['A 複数行 INSERT は 1 行ずつと同じ',
         "INSERT INTO v55_t (id, name) VALUES (7, 'g'), (8, 'h')",
         "INSERT INTO v55_t (id, name) SELECT 7, 'g' UNION ALL SELECT 8, 'h'"],
        ['A SET 形は列リスト形と同じ',
         "INSERT INTO v55_t (id, name, dept) VALUES (7, 'gil', 'X')",
         "INSERT INTO v55_t SET id = 7, name = 'gil', dept = 'X'"],
        ['A SELECT 挿入は VALUES 挿入と同じ',
         "INSERT INTO v55_t (id, name, dept, sal) VALUES (11, 'kim', 'Z', 900), (12, 'lee', 'Z', 800)",
         "INSERT INTO v55_t (id, name, dept, sal) SELECT id, name, dept, sal FROM v55_src"],
        ['A REPLACE は DELETE + INSERT と同じ',
         "REPLACE INTO v55_t (id, name, dept, sal, active) VALUES (1, 'ANN', 'X', 111, TRUE)",
         "INSERT INTO v55_t (id, name, dept, sal, active) VALUES (1, 'ANN', 'X', 111, TRUE) "
         + "ON DUPLICATE KEY UPDATE name = 'ANN', dept = 'X', sal = 111, active = TRUE"],
        ['A ON CONFLICT DO NOTHING は INSERT IGNORE と同じ',
         "INSERT INTO v55_t (id, name) VALUES (1, 'zz') ON CONFLICT DO NOTHING",
         "INSERT IGNORE INTO v55_t (id, name) VALUES (1, 'zz')"],
        ['B SET の並び順は結果に影響しない',
         "UPDATE v55_t SET dept = 'Q', sal = 1 WHERE id = 2",
         "UPDATE v55_t SET sal = 1, dept = 'Q' WHERE id = 2"],
        ['B 別名を付けても同じ',
         "UPDATE v55_t SET sal = 5 WHERE id = 3",
         "UPDATE v55_t AS x SET x.sal = 5 WHERE x.id = 3"],
        ['B IN と OR は同じ',
         "UPDATE v55_t SET sal = 1 WHERE dept IN ('X', 'Y')",
         "UPDATE v55_t SET sal = 1 WHERE dept = 'X' OR dept = 'Y'"],
        ['B 相関 EXISTS と IN は同じ',
         "UPDATE v55_t SET sal = 1 WHERE dept IN (SELECT dept FROM v55_src)",
         "UPDATE v55_t SET sal = 1 WHERE EXISTS (SELECT 1 FROM v55_src s WHERE s.dept = v55_t.dept)"],
        ['B CASE と WHERE 二本立ては同じ',
         "UPDATE v55_t SET sal = CASE WHEN dept = 'X' THEN 1 ELSE sal END",
         "UPDATE v55_t SET sal = 1 WHERE dept = 'X'"],
        ['C 条件なし DELETE は全件',
         "DELETE FROM v55_t",
         "DELETE FROM v55_t WHERE 1 = 1"],
        ['C NOT IN と NOT EXISTS は同じ（NULL を除いておく）',
         "DELETE FROM v55_t WHERE dept IS NOT NULL AND dept NOT IN (SELECT dept FROM v55_src WHERE dept IS NOT NULL)",
         "DELETE FROM v55_t WHERE dept IS NOT NULL AND NOT EXISTS (SELECT 1 FROM v55_src s WHERE s.dept = v55_t.dept)"],
        ['C IS NULL と COALESCE は同じ',
         "DELETE FROM v55_t WHERE sal IS NULL",
         "DELETE FROM v55_t WHERE COALESCE(sal, -1) = -1"],
      ].forEach(([label, a, b]) => dmlSame(`V55 ${label}`, a, b));

      // ============================================================
      // F. 字句変換（すべての基準文に掛ける）
      // ============================================================
      const LEX = [
        ['大文字', upper],
        ['小文字', lower],
        ['空白を改行に', s => spaced(s, '\n')],
        ['空白をタブに', s => spaced(s, '\t')],
        ['空白を 3 個に', s => spaced(s, '   ')],
        ['末尾にセミコロン', s => s + ';'],
        ['前後に空行', s => '\n\n  ' + s + '  \n'],
        ['先頭に行コメント', s => '-- 書き換え\n' + s],
        ['末尾に行コメント', s => s + ' -- 書き換え'],
        ['先頭にブロックコメント', s => '/* 書き換え\n   する */ ' + s],
      ];
      STMTS.forEach(([sec, sql], si) => LEX.forEach(([label, f]) => {
        dmlSame(`V55F${sec} #${si} ${label}: ${tag(sql)}`, sql, f(sql));
      }));

      // ============================================================
      // G. 空白 1 個ずつの置き換え（改行 / ブロックコメント）
      // ============================================================
      STMTS.forEach(([sec, sql], si) => {
        const positions = wsPos(sql);
        positions.forEach(i => {
          dmlSame(`V55G${sec} #${si} 改行 @${i}: ${tag(sql)}`, sql, swap(sql, i, '\n'));
          dmlSame(`V55G${sec} #${si} コメント @${i}: ${tag(sql)}`, sql, swap(sql, i, ' /*c*/ '));
        });
      });

      // ============================================================
      // D. DDL の書き方
      //   作られた表のスキーマ（列・型・NULL 可否・既定値・鍵）を突き合わせる
      // ============================================================
      // 型名は書いた綴りのまま保たれる（INT / INTEGER / VARCHAR(255)）ので、
      // 構造の比較では列名・NULL 可否・鍵・既定値だけを見る。
      // 別名の型が同じ振る舞いをすることは下の往復テストで別に確かめる
      const schemaOf = (name) => {
        const tbl = db.tables[name];
        if (!tbl) throw new Error(`表 ${name} が無い`);
        return JSON.stringify({
          cols: Object.keys(tbl.colTypes || {}),
          notNull: tbl.notNullCols ? [...tbl.notNullCols].sort() : null,
          pk: tbl.primaryKey || null,
          composite: tbl.compositeKeys ? JSON.parse(JSON.stringify(tbl.compositeKeys)) : null,
          unique: tbl.uniqueCols ? [...tbl.uniqueCols].sort() : null,
          defaults: tbl.defaults || null
        });
      };
      const ddlSame = (name, baseDdl, varDdl) => t(name, () => {
        q('DROP TABLE IF EXISTS v55_d');
        let r = q(baseDdl);
        if (r.error) throw new Error('基準の DDL が失敗した: ' + r.error);
        const want = schemaOf('v55_d');
        q('DROP TABLE IF EXISTS v55_d');
        r = q(varDdl);
        if (r.error) throw new Error(r.error + ' :: ' + varDdl.replace(/\s+/g, ' ').slice(0, 140));
        const got = schemaOf('v55_d');
        q('DROP TABLE IF EXISTS v55_d');
        if (got !== want) throw new Error('expected ' + want.slice(0, 220) + ' but got ' + got.slice(0, 220));
        return true;
      });
      const DDL_BASE = "CREATE TABLE v55_d (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
        + "sal INTEGER DEFAULT 0, code TEXT UNIQUE)";
      [
        ['列ごとに改行', "CREATE TABLE v55_d (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  sal INTEGER DEFAULT 0,\n  code TEXT UNIQUE\n)"],
        ['小文字で書く', "create table v55_d (id integer primary key, name text not null, sal integer default 0, code text unique)"],
        ['型の別名（INT）', "CREATE TABLE v55_d (id INT PRIMARY KEY, name TEXT NOT NULL, sal INT DEFAULT 0, code TEXT UNIQUE)"],
        ['型の別名（VARCHAR）', "CREATE TABLE v55_d (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, sal INTEGER DEFAULT 0, code VARCHAR(255) UNIQUE)"],
        ['表制約として書く', "CREATE TABLE v55_d (id INTEGER, name TEXT NOT NULL, sal INTEGER DEFAULT 0, code TEXT, PRIMARY KEY (id), UNIQUE (code))"],
        ['制約に名前を付ける', "CREATE TABLE v55_d (id INTEGER, name TEXT NOT NULL, sal INTEGER DEFAULT 0, code TEXT, CONSTRAINT pk_v55d PRIMARY KEY (id), CONSTRAINT uq_v55d UNIQUE (code))"],
        ['修飾子の順を入れ替える', "CREATE TABLE v55_d (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sal INTEGER DEFAULT 0, code TEXT UNIQUE)"],
        ['カンマの前で改行', "CREATE TABLE v55_d (id INTEGER PRIMARY KEY\n, name TEXT NOT NULL\n, sal INTEGER DEFAULT 0\n, code TEXT UNIQUE)"],
        ['コメントを挟む', "CREATE TABLE v55_d ( -- 表\n id INTEGER PRIMARY KEY, /* 主キー */ name TEXT NOT NULL, sal INTEGER DEFAULT 0, code TEXT UNIQUE)"],
        ['IF NOT EXISTS を付ける', "CREATE TABLE IF NOT EXISTS v55_d (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sal INTEGER DEFAULT 0, code TEXT UNIQUE)"],
        ['バッククォートで囲む', "CREATE TABLE `v55_d` (`id` INTEGER PRIMARY KEY, `name` TEXT NOT NULL, `sal` INTEGER DEFAULT 0, `code` TEXT UNIQUE)"],
        ['末尾にセミコロン', DDL_BASE + ';'],
        ['空白を多めに', "CREATE   TABLE   v55_d  (  id  INTEGER  PRIMARY KEY ,  name  TEXT  NOT NULL ,  sal  INTEGER  DEFAULT 0 ,  code  TEXT  UNIQUE  )"],
      ].forEach(([label, v], i) => ddlSame(`V55D #${i} ${label}`, DDL_BASE, v));
      // 型の別名は同じ値を出し入れできる（宣言の綴りは保たれるが振る舞いは同じ）
      [
        ['INT と INTEGER', 'INT', 'INTEGER'],
        ['VARCHAR と TEXT', 'VARCHAR(50)', 'TEXT'],
        ['DEC と DECIMAL', 'DEC(18,4)', 'DECIMAL(18,4)'],
        ['BOOL と BOOLEAN', 'BOOL', 'BOOLEAN'],
        ['DOUBLE PRECISION と DOUBLE', 'DOUBLE PRECISION', 'DOUBLE'],
      ].forEach(([label, ta, tb], i) => t(`V55D 型の別名 #${i} ${label}`, () => {
        const roundTrip = (ty) => {
          q('DROP TABLE IF EXISTS v55_d');
          const r = q(`CREATE TABLE v55_d (id INTEGER PRIMARY KEY, v ${ty})`);
          if (r.error) throw new Error(r.error + ' :: ' + ty);
          q("INSERT INTO v55_d VALUES (1, 12), (2, NULL)");
          const s = valsOf('SELECT id, v FROM v55_d ORDER BY id');
          q('DROP TABLE IF EXISTS v55_d');
          return s;
        };
        const a = roundTrip(ta), b = roundTrip(tb);
        if (a !== b) throw new Error(`${ta} と ${tb} で結果が違う: ${a} / ${b}`);
        return true;
      }));
      // ALTER で列を足しても、はじめから書いた形と同じ構造になる
      t('V55D ALTER ADD COLUMN は最初から書いた形と同じ', () => {
        q('DROP TABLE IF EXISTS v55_d');
        let r = q("CREATE TABLE v55_d (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sal INTEGER DEFAULT 0, memo TEXT)");
        if (r.error) throw new Error(r.error);
        const want = schemaOf('v55_d');
        q('DROP TABLE IF EXISTS v55_d');
        q("CREATE TABLE v55_d (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sal INTEGER DEFAULT 0)");
        r = q("ALTER TABLE v55_d ADD COLUMN memo TEXT");
        if (r.error) throw new Error(r.error);
        const got = schemaOf('v55_d');
        q('DROP TABLE IF EXISTS v55_d');
        if (got !== want) throw new Error('expected ' + want.slice(0, 220) + ' but got ' + got.slice(0, 220));
        return true;
      });
      t('V55D ALTER TABLE の綴り違いは同じ結果になる', () => {
        const build = (addSql) => {
          q('DROP TABLE IF EXISTS v55_d');
          q("CREATE TABLE v55_d (id INTEGER PRIMARY KEY)");
          const r = q(addSql);
          if (r.error) throw new Error(r.error + ' :: ' + addSql);
          const s = JSON.stringify(db.tables['v55_d'].columns);
          q('DROP TABLE IF EXISTS v55_d');
          return s;
        };
        const a = build("ALTER TABLE v55_d ADD COLUMN memo TEXT");
        const b = build("ALTER TABLE v55_d ADD memo TEXT");
        const c = build("alter table v55_d\n  add column memo text");
        if (a !== b || a !== c) throw new Error(`綴りで結果が変わった: ${a} / ${b} / ${c}`);
        return true;
      });

      // ============================================================
      // E. トランザクション文の綴り
      // ============================================================
      const txSame = (name, beginSql, endSql, expectRollback) => t(name, () => {
        reset();
        q(beginSql);
        q("UPDATE v55_t SET sal = 999 WHERE id = 1");
        q(endSql);
        const got = valsOf('SELECT sal FROM v55_t WHERE id = 1');
        const want = expectRollback ? '[[100]]' : '[[999]]';
        if (got !== want) throw new Error(`${beginSql} / ${endSql}: expected ${want} but got ${got}`);
        return true;
      });
      const BEGINS = ['BEGIN', 'BEGIN WORK', 'BEGIN TRANSACTION', 'START TRANSACTION', 'begin', 'start transaction'];
      const COMMITS = ['COMMIT', 'COMMIT WORK', 'COMMIT TRANSACTION', 'commit'];
      const ROLLBACKS = ['ROLLBACK', 'ROLLBACK WORK', 'ROLLBACK TRANSACTION', 'rollback'];
      BEGINS.forEach(b => COMMITS.forEach(c => txSame(`V55E ${b} + ${c}`, b, c, false)));
      BEGINS.forEach(b => ROLLBACKS.forEach(r => txSame(`V55E ${b} + ${r}`, b, r, true)));
      t('V55E SAVEPOINT の綴り違い', () => {
        const run = (rollbackSql, releaseSql) => {
          reset();
          q('BEGIN');
          q("UPDATE v55_t SET sal = 111 WHERE id = 1");
          q('SAVEPOINT sp1');
          q("UPDATE v55_t SET sal = 222 WHERE id = 1");
          q(rollbackSql);
          if (releaseSql) q(releaseSql);
          q('COMMIT');
          return valsOf('SELECT sal FROM v55_t WHERE id = 1');
        };
        const a = run('ROLLBACK TO SAVEPOINT sp1', 'RELEASE SAVEPOINT sp1');
        const b = run('ROLLBACK TO sp1', 'RELEASE SAVEPOINT sp1');
        const c = run('rollback to savepoint sp1', null);
        if (a !== '[[111]]' || a !== b || a !== c) {
          throw new Error(`セーブポイントの綴りで結果が変わった: ${a} / ${b} / ${c}`);
        }
        return true;
      });

      // ============================================================
      // H. 受け付けない書き方
      // ============================================================
      err('V55H 行値の SET は未対応',
          "UPDATE v55_t SET (name, dept) = ('q', 'Q') WHERE id = 3", 'not found');
      err('V55H SET x = DEFAULT は未対応',
          "UPDATE v55_t SET sal = DEFAULT WHERE id = 3", 'not found');
      err('V55H MySQL の複数表 DELETE 構文は未対応',
          "DELETE v55_t FROM v55_t WHERE id = 3", 'syntax');
      err('V55H 列数の合わない INSERT SELECT は拒否される',
          "INSERT INTO v55_t SELECT * FROM v55_src", "column count");
      err('V55H 存在しない列への INSERT は拒否される',
          "INSERT INTO v55_t (nope) VALUES (1)", 'not found');
      err('V55H 主キーの重複は拒否される',
          "INSERT INTO v55_t (id, name) VALUES (1, 'dup')", 'primary key');
      err('V55H ADD COLUMN に UNIQUE は書けない（索引で付ける）',
          "ALTER TABLE v55_t ADD COLUMN memo TEXT UNIQUE", 'syntax');

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v55_t', 'v55_src', 'v55_d');

      return T;
    }
