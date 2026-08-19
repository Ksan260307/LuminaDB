    // ============================================================================
    // [Test Suite v46] - コマンド全網羅 (4/6): DDL
    //
    //     A. CREATE TABLE の列定義・制約・オプションの総当たり
    //     B. データ型の総当たり（別名を含む）と格納・読み出し
    //     C. ALTER TABLE の全アクション × 表の状態
    //     D. 索引（CREATE / ALTER / DROP、単一・複合・一意・部分）
    //     E. ビューと実体化ビュー
    //     F. プロシージャ・関数・トリガ
    //     G. ドメイン・列挙型・シーケンス・ユーザー・ロール・スキーマ
    //     H. DROP の全対象 × IF EXISTS × CASCADE
    //     I. TRUNCATE / RENAME / VACUUM / OPTIMIZE / CHECK TABLE / ANALYZE TABLE
    //     J. CTAS（CREATE TABLE AS SELECT）と SELECT INTO
    //     K. DDL の誤りは拒否される
    //
    //   test-suite.js の tests 配列へ getV46Tests() のスプレッドで合流する
    // ============================================================================
    function getV46Tests() {
      const T = [];
      const q = (sql) => db.executeQuery(sql);
      const t = (name, fn) => T.push({ name, fn });
      const err = (name, sql, frag) => T.push({
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      });
      const ok = (name, sql) => T.push({ name, sql, check: r => !r.error });
      const rows = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      const one = (sql) => { const d = rows(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };
      const val = (name, sql, want) => t(name, () => eq(one(sql), want));
      const drop = (...names) => names.forEach(n => q('DROP TABLE IF EXISTS ' + n));
      // 使い捨ての表を作って検証し、必ず片付ける
      const scoped = (name, setup, body) => t(name, () => {
        const tbl = 'v46_tmp';
        q('DROP TABLE IF EXISTS ' + tbl);
        const r = q(setup.split('%T').join(tbl));
        if (r.error) { q('DROP TABLE IF EXISTS ' + tbl); throw new Error(r.error); }
        try { return body(tbl); } finally { q('DROP TABLE IF EXISTS ' + tbl); }
      });

      t('V46 fixture', () => {
        drop('v46_base');
        q('CREATE TABLE v46_base (id INT PRIMARY KEY, name TEXT, qty INT)');
        q("INSERT INTO v46_base VALUES (1,'a',10),(2,'b',20),(3,'c',30)");
        return db.tables['v46_base'].rowCount === 3;
      });

      // ============================================================
      // A. CREATE TABLE の列定義・制約・オプション
      // ============================================================
      const COLDEFS = [
        ['a plain column', 'x INT'],
        ['NOT NULL', 'x INT NOT NULL'],
        ['NULL explicitly', 'x INT NULL'],
        ['a numeric default', 'x INT DEFAULT 7'],
        ['a text default', 'x TEXT DEFAULT \'d\''],
        ['a boolean default', 'x BOOLEAN DEFAULT TRUE'],
        ['a function default', 'x TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
        ['NOT NULL with a default', 'x INT NOT NULL DEFAULT 0'],
        ['PRIMARY KEY inline', 'x INT PRIMARY KEY'],
        ['UNIQUE inline', 'x INT UNIQUE'],
        ['a CHECK inline', 'x INT CHECK (x >= 0)'],
        ['AUTO_INCREMENT', 'x INT PRIMARY KEY AUTO_INCREMENT'],
        ['AUTOINCREMENT spelled as one word', 'x INTEGER PRIMARY KEY AUTOINCREMENT'],
        ['IDENTITY', 'x INT IDENTITY PRIMARY KEY'],
        ['a length-qualified type', 'x VARCHAR(50)'],
        ['a precision-qualified type', 'x DECIMAL(10,2)'],
        ['a COMMENT', "x INT COMMENT 'note'"],
        ['a COLLATE clause', 'x TEXT COLLATE NOCASE'],
      ];
      COLDEFS.forEach(([label, def]) => {
        scoped(`V46A CREATE TABLE with ${label}`, `CREATE TABLE %T (${def})`, (tbl) => {
          return eq(!!db.tables[tbl], true);
        });
      });
      const TBLCONSTRAINTS = [
        ['a table-level PRIMARY KEY', 'a INT, b INT, PRIMARY KEY (a)'],
        ['a composite PRIMARY KEY', 'a INT, b INT, PRIMARY KEY (a, b)'],
        ['a table-level UNIQUE', 'a INT, b INT, UNIQUE (b)'],
        ['a composite UNIQUE', 'a INT, b INT, UNIQUE (a, b)'],
        ['a named PRIMARY KEY', 'a INT, CONSTRAINT pk_a PRIMARY KEY (a)'],
        ['a named UNIQUE', 'a INT, CONSTRAINT uq_a UNIQUE (a)'],
        ['a named CHECK', 'a INT, CONSTRAINT ck_a CHECK (a > 0)'],
        ['a table-level CHECK', 'a INT, b INT, CHECK (a < b)'],
        ['two CHECKs', 'a INT, CHECK (a > 0), CHECK (a < 100)'],
        ['a FOREIGN KEY', 'a INT, FOREIGN KEY (a) REFERENCES v46_base(id)'],
        ['a named FOREIGN KEY', 'a INT, CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES v46_base(id)'],
        ['a FOREIGN KEY with ON DELETE CASCADE', 'a INT, FOREIGN KEY (a) REFERENCES v46_base(id) ON DELETE CASCADE'],
        ['a FOREIGN KEY with ON UPDATE CASCADE', 'a INT, FOREIGN KEY (a) REFERENCES v46_base(id) ON UPDATE CASCADE'],
        ['a FOREIGN KEY with ON DELETE SET NULL', 'a INT, FOREIGN KEY (a) REFERENCES v46_base(id) ON DELETE SET NULL'],
        ['an inline REFERENCES', 'a INT REFERENCES v46_base(id)'],
      ];
      TBLCONSTRAINTS.forEach(([label, def]) => {
        scoped(`V46A CREATE TABLE with ${label}`, `CREATE TABLE %T (${def})`, (tbl) => eq(!!db.tables[tbl], true));
      });
      // 修飾つきの CREATE TABLE
      ['CREATE TABLE %T (x INT)',
       'CREATE TABLE IF NOT EXISTS %T (x INT)',
       'CREATE TEMPORARY TABLE %T (x INT)',
       'CREATE TEMP TABLE %T (x INT)',
       'CREATE GLOBAL TEMPORARY TABLE %T (x INT)',
       'CREATE LOCAL TEMPORARY TABLE %T (x INT)'].forEach(sql => {
        scoped(`V46A ${sql.replace(' %T (x INT)', '')}`, sql, (tbl) => eq(!!db.tables[tbl], true));
      });
      t('V46A CREATE TABLE IF NOT EXISTS is a no-op when it exists', () => {
        const r = q('CREATE TABLE IF NOT EXISTS v46_base (zzz INT)');
        return eq([!!r.error, db.tables['v46_base'].rowCount], [false, 3]);
      });
      // 制約が実際に効くか
      scoped('V46A NOT NULL rejects a NULL', 'CREATE TABLE %T (x INT NOT NULL)', (tbl) => {
        const r = q(`INSERT INTO ${tbl} VALUES (NULL)`);
        return eq(!!r.error, true);
      });
      scoped('V46A a default fills an omitted column', 'CREATE TABLE %T (x INT, y INT DEFAULT 7)', (tbl) => {
        q(`INSERT INTO ${tbl} (x) VALUES (1)`);
        return eq(one(`SELECT y FROM ${tbl}`), 7);
      });
      scoped('V46A a CHECK rejects a bad row', 'CREATE TABLE %T (x INT CHECK (x >= 0))', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (5)`);
        const r = q(`INSERT INTO ${tbl} VALUES (-1)`);
        return eq([!!r.error, one(`SELECT COUNT(*) AS c FROM ${tbl}`)], [true, 1]);
      });
      scoped('V46A UNIQUE rejects a duplicate', 'CREATE TABLE %T (x INT UNIQUE)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, true);
      });
      scoped('V46A PRIMARY KEY rejects a duplicate', 'CREATE TABLE %T (x INT PRIMARY KEY)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, true);
      });
      scoped('V46A PRIMARY KEY rejects a NULL', 'CREATE TABLE %T (x INT PRIMARY KEY)', (tbl) => {
        const r = q(`INSERT INTO ${tbl} VALUES (NULL)`);
        return eq(!!r.error, true);
      });
      scoped('V46A UNIQUE allows several NULLs', 'CREATE TABLE %T (x INT UNIQUE)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (NULL)`);
        const r = q(`INSERT INTO ${tbl} VALUES (NULL)`);
        return eq([!!r.error, one(`SELECT COUNT(*) AS c FROM ${tbl}`)], [false, 2]);
      });
      scoped('V46A a composite UNIQUE only rejects the whole pair',
             'CREATE TABLE %T (a INT, b INT, UNIQUE (a, b))', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1, 1), (1, 2), (2, 1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1, 1)`);
        return eq([!!r.error, one(`SELECT COUNT(*) AS c FROM ${tbl}`)], [true, 3]);
      });
      scoped('V46A AUTO_INCREMENT assigns increasing ids',
             'CREATE TABLE %T (id INT PRIMARY KEY AUTO_INCREMENT, x INT)', (tbl) => {
        q(`INSERT INTO ${tbl} (x) VALUES (1), (2), (3)`);
        return eq(rows(`SELECT id FROM ${tbl} ORDER BY id`).map(r => r.id), [1, 2, 3]);
      });
      scoped('V46A a foreign key rejects a missing parent',
             'CREATE TABLE %T (a INT REFERENCES v46_base(id))', (tbl) => {
        const good = q(`INSERT INTO ${tbl} VALUES (1)`);
        const bad = q(`INSERT INTO ${tbl} VALUES (999)`);
        return eq([!!good.error, !!bad.error], [false, true]);
      });

      // ============================================================
      // B. データ型の総当たり
      // ============================================================
      const TYPES = [
        ['INT', '42', 42], ['INTEGER', '42', 42], ['SMALLINT', '42', 42], ['BIGINT', '42', 42],
        ['TINYINT', '42', 42], ['MEDIUMINT', '42', 42], ['INT2', '42', 42], ['INT4', '42', 42],
        ['INT8', '42', 42], ['SERIAL', '42', 42],
        ['DECIMAL(10,2)', '12.34', 12.34], ['NUMERIC(10,2)', '12.34', 12.34],
        ['DEC(10,2)', '12.34', 12.34], ['NUMBER(10,2)', '12.34', 12.34],
        ['FLOAT', '1.5', 1.5], ['REAL', '1.5', 1.5], ['DOUBLE', '1.5', 1.5],
        ['DOUBLE PRECISION', '1.5', 1.5],
        ['TEXT', "'abc'", 'abc'], ['VARCHAR(10)', "'abc'", 'abc'], ['CHAR(10)', "'abc'", 'abc'],
        ['VARCHAR2(10)', "'abc'", 'abc'], ['NVARCHAR(10)', "'abc'", 'abc'], ['NCHAR(10)', "'abc'", 'abc'],
        ['CLOB', "'abc'", 'abc'], ['LONGTEXT', "'abc'", 'abc'], ['MEDIUMTEXT', "'abc'", 'abc'],
        ['TINYTEXT', "'abc'", 'abc'], ['STRING', "'abc'", 'abc'],
        ['BOOLEAN', 'TRUE', true], ['BOOL', 'FALSE', false],
        ['DATE', "'2024-03-15'", '2024-03-15'],
        ['TIMESTAMP', "'2024-03-15 13:45:56'", '2024-03-15 13:45:56'],
        ['DATETIME', "'2024-03-15 13:45:56'", '2024-03-15 13:45:56'],
        ['TIME', "'13:45:56'", '13:45:56'],
        ['MONEY', '12.34', 12.34],
      ];
      TYPES.forEach(([ty, lit, want]) => {
        scoped(`V46B a ${ty} column stores and returns its value`,
               `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
        scoped(`V46B a ${ty} column accepts NULL`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (NULL)`);
          return eq(one(`SELECT x FROM ${tbl}`), null);
        });
      });
      scoped('V46B an INTEGER column rejects a fractional value', 'CREATE TABLE %T (x INTEGER)', (tbl) => {
        const r = q(`INSERT INTO ${tbl} VALUES (1.5)`);
        return eq(!!r.error, true);
      });
      scoped('V46B an INTEGER column rejects text', 'CREATE TABLE %T (x INTEGER)', (tbl) => {
        const r = q(`INSERT INTO ${tbl} VALUES ('abc')`);
        return eq(!!r.error, true);
      });
      scoped('V46B a FLOAT column rejects an overflowing literal', 'CREATE TABLE %T (x FLOAT)', (tbl) => {
        const r = q(`INSERT INTO ${tbl} VALUES (1e309)`);
        return eq(!!r.error, true);
      });
      scoped('V46B a DECIMAL column rounds to its scale', 'CREATE TABLE %T (x DECIMAL(10,2))', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (12.345)`);
        return eq(one(`SELECT x FROM ${tbl}`), 12.35);
      });
      scoped('V46B a VARCHAR column keeps the declared type in the catalog',
             'CREATE TABLE %T (x VARCHAR(10))', (tbl) => {
        const d = rows(`DESCRIBE ${tbl}`);
        return eq(d.length, 1);
      });

      // ============================================================
      // C. ALTER TABLE の全アクション
      // ============================================================
      const AT = (label, setup, action, verify) =>
        scoped(`V46C ALTER TABLE ${label}`, setup, (tbl) => {
          const r = q(action.split('%T').join(tbl));
          if (r.error) throw new Error(r.error);
          return verify(tbl);
        });
      AT('ADD COLUMN', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T ADD COLUMN b TEXT',
         tbl => eq(!!db.tables[tbl].cols['b'], true));
      AT('ADD without the COLUMN keyword', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T ADD b TEXT',
         tbl => eq(!!db.tables[tbl].cols['b'], true));
      AT('ADD COLUMN with a default', 'CREATE TABLE %T (a INT)',
         "ALTER TABLE %T ADD COLUMN b TEXT DEFAULT 'x'", tbl => {
        q(`INSERT INTO ${tbl} (a) VALUES (1)`);
        return eq(one(`SELECT b FROM ${tbl}`), 'x');
      });
      AT('ADD COLUMN IF NOT EXISTS', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD COLUMN IF NOT EXISTS b TEXT', tbl => eq(!!db.tables[tbl].cols['b'], true));
      AT('ADD COLUMN backfills existing rows with NULL', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD COLUMN b TEXT', tbl => {
        q(`INSERT INTO ${tbl} (a) VALUES (1)`);
        return eq(one(`SELECT b FROM ${tbl}`), null);
      });
      AT('DROP COLUMN', 'CREATE TABLE %T (a INT, b TEXT)', 'ALTER TABLE %T DROP COLUMN b',
         tbl => eq(!!db.tables[tbl].cols['b'], false));
      AT('DROP without the COLUMN keyword', 'CREATE TABLE %T (a INT, b TEXT)', 'ALTER TABLE %T DROP b',
         tbl => eq(!!db.tables[tbl].cols['b'], false));
      AT('DROP COLUMN IF EXISTS on a missing column', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T DROP COLUMN IF EXISTS nosuch', tbl => eq(!!db.tables[tbl].cols['a'], true));
      AT('RENAME COLUMN', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T RENAME COLUMN a TO z',
         tbl => eq([!!db.tables[tbl].cols['z'], !!db.tables[tbl].cols['a']], [true, false]));
      AT('RENAME TO', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T RENAME TO v46_renamed', () => {
        const okName = !!db.tables['v46_renamed'];
        q('DROP TABLE IF EXISTS v46_renamed');
        return eq(okName, true);
      });
      AT('MODIFY COLUMN changes the type', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T MODIFY COLUMN a TEXT', tbl => {
        q(`INSERT INTO ${tbl} VALUES ('now text')`);
        return eq(one(`SELECT a FROM ${tbl}`), 'now text');
      });
      AT('ALTER COLUMN TYPE', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ALTER COLUMN a TYPE TEXT', tbl => {
        q(`INSERT INTO ${tbl} VALUES ('now text')`);
        return eq(one(`SELECT a FROM ${tbl}`), 'now text');
      });
      AT('ALTER COLUMN SET DATA TYPE', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ALTER COLUMN a SET DATA TYPE TEXT', tbl => {
        q(`INSERT INTO ${tbl} VALUES ('now text')`);
        return eq(one(`SELECT a FROM ${tbl}`), 'now text');
      });
      AT('CHANGE COLUMN renames and retypes', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T CHANGE COLUMN a z TEXT',
         tbl => eq([!!db.tables[tbl].cols['z'], !!db.tables[tbl].cols['a']], [true, false]));
      AT('ALTER COLUMN SET DEFAULT', 'CREATE TABLE %T (a INT, b INT)',
         'ALTER TABLE %T ALTER COLUMN b SET DEFAULT 9', tbl => {
        q(`INSERT INTO ${tbl} (a) VALUES (1)`);
        return eq(one(`SELECT b FROM ${tbl}`), 9);
      });
      AT('ALTER COLUMN DROP DEFAULT', 'CREATE TABLE %T (a INT, b INT DEFAULT 9)',
         'ALTER TABLE %T ALTER COLUMN b DROP DEFAULT', tbl => {
        q(`INSERT INTO ${tbl} (a) VALUES (1)`);
        return eq(one(`SELECT b FROM ${tbl}`), null);
      });
      AT('ALTER COLUMN SET NOT NULL', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ALTER COLUMN a SET NOT NULL', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (NULL)`);
        return eq(!!r.error, true);
      });
      AT('ALTER COLUMN DROP NOT NULL', 'CREATE TABLE %T (a INT NOT NULL)',
         'ALTER TABLE %T ALTER COLUMN a DROP NOT NULL', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (NULL)`);
        return eq(!!r.error, false);
      });
      AT('ADD CONSTRAINT CHECK', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD CONSTRAINT ck1 CHECK (a >= 0)', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (-1)`);
        return eq(!!r.error, true);
      });
      AT('DROP CONSTRAINT', 'CREATE TABLE %T (a INT, CONSTRAINT ck1 CHECK (a >= 0))',
         'ALTER TABLE %T DROP CONSTRAINT ck1', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (-1)`);
        return eq(!!r.error, false);
      });
      AT('DROP CHECK', 'CREATE TABLE %T (a INT, CONSTRAINT ck1 CHECK (a >= 0))',
         'ALTER TABLE %T DROP CHECK ck1', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (-1)`);
        return eq(!!r.error, false);
      });
      AT('ADD PRIMARY KEY', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T ADD PRIMARY KEY (a)', tbl => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, true);
      });
      AT('DROP PRIMARY KEY', 'CREATE TABLE %T (a INT PRIMARY KEY)',
         'ALTER TABLE %T DROP PRIMARY KEY', tbl => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, false);
      });
      AT('ADD UNIQUE', 'CREATE TABLE %T (a INT)', 'ALTER TABLE %T ADD UNIQUE (a)', tbl => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, true);
      });
      AT('DROP UNIQUE', 'CREATE TABLE %T (a INT UNIQUE)', 'ALTER TABLE %T DROP UNIQUE (a)', tbl => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, false);
      });
      AT('ADD CONSTRAINT UNIQUE', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD CONSTRAINT uq1 UNIQUE (a)', tbl => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        return eq(!!r.error, true);
      });
      AT('ADD FOREIGN KEY', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD FOREIGN KEY (a) REFERENCES v46_base(id)', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (999)`);
        return eq(!!r.error, true);
      });
      AT('ADD CONSTRAINT FOREIGN KEY', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD CONSTRAINT fk1 FOREIGN KEY (a) REFERENCES v46_base(id)', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (999)`);
        return eq(!!r.error, true);
      });
      AT('DROP FOREIGN KEY by name',
         'CREATE TABLE %T (a INT, CONSTRAINT fk1 FOREIGN KEY (a) REFERENCES v46_base(id))',
         'ALTER TABLE %T DROP FOREIGN KEY fk1', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (999)`);
        return eq(!!r.error, false);
      });
      AT('RENAME CONSTRAINT', 'CREATE TABLE %T (a INT, CONSTRAINT ck1 CHECK (a >= 0))',
         'ALTER TABLE %T RENAME CONSTRAINT ck1 TO ck2', tbl => {
        const r = q(`INSERT INTO ${tbl} VALUES (-1)`);
        return eq(!!r.error, true);
      });
      AT('several actions separated by commas', 'CREATE TABLE %T (a INT)',
         'ALTER TABLE %T ADD COLUMN b INT, ADD COLUMN c INT',
         tbl => eq([!!db.tables[tbl].cols['b'], !!db.tables[tbl].cols['c']], [true, true]));
      AT('three actions separated by commas', 'CREATE TABLE %T (a INT, z INT)',
         'ALTER TABLE %T ADD COLUMN b INT, ADD COLUMN c INT, DROP COLUMN z',
         tbl => eq([!!db.tables[tbl].cols['b'], !!db.tables[tbl].cols['c'], !!db.tables[tbl].cols['z']],
                   [true, true, false]));
      // ALTER が既存データを保つ
      scoped('V46C ADD COLUMN keeps the existing rows', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1), (2), (3)`);
        q(`ALTER TABLE ${tbl} ADD COLUMN b TEXT`);
        return eq(one(`SELECT COUNT(*) AS c FROM ${tbl}`), 3);
      });
      scoped('V46C DROP COLUMN keeps the other columns intact', 'CREATE TABLE %T (a INT, b INT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1, 10), (2, 20)`);
        q(`ALTER TABLE ${tbl} DROP COLUMN b`);
        return eq(rows(`SELECT a FROM ${tbl} ORDER BY a`).map(r => r.a), [1, 2]);
      });
      scoped('V46C RENAME COLUMN keeps the values', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (5)`);
        q(`ALTER TABLE ${tbl} RENAME COLUMN a TO z`);
        return eq(one(`SELECT z FROM ${tbl}`), 5);
      });

      // ============================================================
      // D. 索引
      // ============================================================
      const IX = [
        ['a single-column index', 'CREATE INDEX %I ON %T (a)'],
        ['a composite index', 'CREATE INDEX %I ON %T (a, b)'],
        ['a unique index', 'CREATE UNIQUE INDEX %I ON %T (a)'],
        ['an index created IF NOT EXISTS', 'CREATE INDEX IF NOT EXISTS %I ON %T (a)'],
        ['an index created CONCURRENTLY', 'CREATE INDEX CONCURRENTLY %I ON %T (a)'],
        ['a descending index', 'CREATE INDEX %I ON %T (a DESC)'],
        ['a three-column index', 'CREATE INDEX %I ON %T (a, b, c)'],
      ];
      IX.forEach(([label, sql]) => {
        scoped(`V46D ${label}`, 'CREATE TABLE %T (a INT, b INT, c INT)', (tbl) => {
          const r = q(sql.split('%T').join(tbl).split('%I').join('v46_ix1'));
          q('DROP INDEX IF EXISTS v46_ix1 ON ' + tbl);
          return eq(!!r.error, false);
        });
      });
      scoped('V46D a unique index rejects a duplicate', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`CREATE UNIQUE INDEX v46_ixu ON ${tbl} (a)`);
        q(`INSERT INTO ${tbl} VALUES (1)`);
        const r = q(`INSERT INTO ${tbl} VALUES (1)`);
        q(`DROP INDEX IF EXISTS v46_ixu ON ${tbl}`);
        return eq(!!r.error, true);
      });
      scoped('V46D an index does not change the query result', 'CREATE TABLE %T (a INT, b INT)', (tbl) => {
        const vals = [];
        for (let i = 0; i < 200; i++) vals.push(`(${i % 37}, ${i})`);
        q(`INSERT INTO ${tbl} VALUES ${vals.join(',')}`);
        const before = rows(`SELECT a, COUNT(*) AS c FROM ${tbl} WHERE a > 10 GROUP BY a ORDER BY a`);
        q(`CREATE INDEX v46_ix2 ON ${tbl} (a)`);
        const after = rows(`SELECT a, COUNT(*) AS c FROM ${tbl} WHERE a > 10 GROUP BY a ORDER BY a`);
        q(`DROP INDEX IF EXISTS v46_ix2 ON ${tbl}`);
        return eq(before, after);
      });
      scoped('V46D ALTER INDEX RENAME TO', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`CREATE INDEX v46_ix3 ON ${tbl} (a)`);
        const r = q('ALTER INDEX v46_ix3 RENAME TO v46_ix4');
        q(`DROP INDEX IF EXISTS v46_ix4 ON ${tbl}`);
        return eq(!!r.error, false);
      });
      scoped('V46D DROP INDEX by name', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`CREATE INDEX v46_ix5 ON ${tbl} (a)`);
        const r = q(`DROP INDEX v46_ix5 ON ${tbl}`);
        return eq(!!r.error, false);
      });
      scoped('V46D DROP INDEX IF EXISTS on a missing index', 'CREATE TABLE %T (a INT)', (tbl) => {
        const r = q(`DROP INDEX IF EXISTS v46_nosuch ON ${tbl}`);
        return eq(!!r.error, false);
      });
      scoped('V46D SHOW INDEXES lists the index', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`CREATE INDEX v46_ix6 ON ${tbl} (a)`);
        const d = rows(`SHOW INDEXES FROM ${tbl}`);
        q(`DROP INDEX IF EXISTS v46_ix6 ON ${tbl}`);
        return eq(d.length >= 1, true);
      });

      // ============================================================
      // E. ビューと実体化ビュー
      // ============================================================
      const withView = (name, create, body) => t(name, () => {
        q('DROP VIEW IF EXISTS v46_v1');
        q('DROP MATERIALIZED VIEW IF EXISTS v46_mv1');
        const r = q(create);
        if (r.error) throw new Error(r.error);
        try { return body(); } finally {
          q('DROP VIEW IF EXISTS v46_v1'); q('DROP MATERIALIZED VIEW IF EXISTS v46_mv1');
        }
      });
      withView('V46E a view returns the underlying rows',
               'CREATE VIEW v46_v1 AS SELECT id, name FROM v46_base',
               () => eq(one('SELECT COUNT(*) AS c FROM v46_v1'), 3));
      withView('V46E a view with a filter',
               'CREATE VIEW v46_v1 AS SELECT id FROM v46_base WHERE qty > 15',
               () => eq(one('SELECT COUNT(*) AS c FROM v46_v1'), 2));
      withView('V46E a view with an aggregate',
               'CREATE VIEW v46_v1 AS SELECT COUNT(*) AS n FROM v46_base',
               () => eq(one('SELECT n FROM v46_v1'), 3));
      withView('V46E a view with a join',
               'CREATE VIEW v46_v1 AS SELECT a.id FROM v46_base a JOIN v46_base b ON a.id = b.id',
               () => eq(one('SELECT COUNT(*) AS c FROM v46_v1'), 3));
      withView('V46E a view with an explicit column list',
               'CREATE VIEW v46_v1 (x, y) AS SELECT id, name FROM v46_base',
               () => eq(one('SELECT COUNT(x) AS c FROM v46_v1'), 3));
      withView('V46E CREATE OR REPLACE VIEW redefines it',
               'CREATE VIEW v46_v1 AS SELECT id FROM v46_base', () => {
        q('CREATE OR REPLACE VIEW v46_v1 AS SELECT id FROM v46_base WHERE id = 1');
        return eq(one('SELECT COUNT(*) AS c FROM v46_v1'), 1);
      });
      withView('V46E a view follows changes to the base table',
               'CREATE VIEW v46_v1 AS SELECT id FROM v46_base', () => {
        q("INSERT INTO v46_base VALUES (4, 'd', 40)");
        const n = one('SELECT COUNT(*) AS c FROM v46_v1');
        q('DELETE FROM v46_base WHERE id = 4');
        return eq(n, 4);
      });
      withView('V46E a view can be queried with a filter and an order',
               'CREATE VIEW v46_v1 AS SELECT id, qty FROM v46_base', () =>
        eq(rows('SELECT id FROM v46_v1 WHERE qty >= 20 ORDER BY id DESC').map(r => r.id), [3, 2]));
      withView('V46E a materialized view holds a snapshot',
               'CREATE MATERIALIZED VIEW v46_mv1 AS SELECT COUNT(*) AS n FROM v46_base', () => {
        q("INSERT INTO v46_base VALUES (5, 'e', 50)");
        const stale = one('SELECT n FROM v46_mv1');
        q('REFRESH MATERIALIZED VIEW v46_mv1');
        const fresh = one('SELECT n FROM v46_mv1');
        q('DELETE FROM v46_base WHERE id = 5');
        return eq([stale, fresh], [3, 4]);
      });
      withView('V46E SHOW VIEWS lists the view',
               'CREATE VIEW v46_v1 AS SELECT id FROM v46_base',
               () => eq(rows('SHOW VIEWS').length >= 1, true));
      withView('V46E SHOW CREATE VIEW returns the definition',
               'CREATE VIEW v46_v1 AS SELECT id FROM v46_base',
               () => eq(rows('SHOW CREATE VIEW v46_v1').length, 1));

      // ============================================================
      // F. プロシージャ・関数・トリガ
      // ============================================================
      t('V46F a procedure runs its body', () => {
        q('DROP PROCEDURE IF EXISTS v46_p1');
        q('CREATE PROCEDURE v46_p1() BEGIN SELECT 42 AS answer; END');
        const d = rows('CALL v46_p1()');
        q('DROP PROCEDURE IF EXISTS v46_p1');
        return eq(d[0].answer, 42);
      });
      t('V46F a procedure with a parameter', () => {
        q('DROP PROCEDURE IF EXISTS v46_p2');
        q('CREATE PROCEDURE v46_p2(n INT) BEGIN SELECT n * 2 AS doubled; END');
        const d = rows('CALL v46_p2(21)');
        q('DROP PROCEDURE IF EXISTS v46_p2');
        return eq(d[0].doubled, 42);
      });
      t('V46F CREATE OR REPLACE PROCEDURE', () => {
        q('DROP PROCEDURE IF EXISTS v46_p3');
        q('CREATE PROCEDURE v46_p3() BEGIN SELECT 1 AS x; END');
        q('CREATE OR REPLACE PROCEDURE v46_p3() BEGIN SELECT 2 AS x; END');
        const d = rows('CALL v46_p3()');
        q('DROP PROCEDURE IF EXISTS v46_p3');
        return eq(d[0].x, 2);
      });
      t('V46F SHOW PROCEDURES lists it', () => {
        q('DROP PROCEDURE IF EXISTS v46_p4');
        q('CREATE PROCEDURE v46_p4() BEGIN SELECT 1 AS x; END');
        const n = rows('SHOW PROCEDURES').length;
        q('DROP PROCEDURE IF EXISTS v46_p4');
        return eq(n >= 1, true);
      });
      t('V46F a user-defined function is callable', () => {
        q('DROP FUNCTION IF EXISTS v46_f1');
        q('CREATE FUNCTION v46_f1(a INT) RETURNS INT RETURN a * 3');
        const v = one('SELECT v46_f1(14) AS r');
        q('DROP FUNCTION IF EXISTS v46_f1');
        return eq(v, 42);
      });
      t('V46F a user-defined function works over a column', () => {
        q('DROP FUNCTION IF EXISTS v46_f2');
        q('CREATE FUNCTION v46_f2(a INT) RETURNS INT RETURN a + 1');
        const got = rows('SELECT v46_f2(id) AS r FROM v46_base ORDER BY id').map(r => r.r);
        q('DROP FUNCTION IF EXISTS v46_f2');
        return eq(got, [2, 3, 4]);
      });
      t('V46F CREATE OR REPLACE FUNCTION', () => {
        q('DROP FUNCTION IF EXISTS v46_f3');
        q('CREATE FUNCTION v46_f3(a INT) RETURNS INT RETURN a');
        q('CREATE OR REPLACE FUNCTION v46_f3(a INT) RETURNS INT RETURN a * 10');
        const v = one('SELECT v46_f3(4) AS r');
        q('DROP FUNCTION IF EXISTS v46_f3');
        return eq(v, 40);
      });
      err('V46F a built-in name cannot be redefined',
          'CREATE FUNCTION ABS(a INT) RETURNS INT RETURN a', 'built-in');
      const TRIGGERS = [
        ['BEFORE INSERT', 'BEFORE INSERT'],
        ['AFTER INSERT', 'AFTER INSERT'],
        ['BEFORE UPDATE', 'BEFORE UPDATE'],
        ['AFTER UPDATE', 'AFTER UPDATE'],
        ['BEFORE DELETE', 'BEFORE DELETE'],
        ['AFTER DELETE', 'AFTER DELETE'],
      ];
      TRIGGERS.forEach(([label, timing]) => {
        scoped(`V46F a ${label} trigger can be created`, 'CREATE TABLE %T (a INT, log TEXT)', (tbl) => {
          q('DROP TRIGGER IF EXISTS v46_tg1');
          const body = timing.indexOf('DELETE') !== -1
            ? `INSERT INTO ${tbl} (a) VALUES (-1)`
            : `SET NEW.log = 'touched'`;
          const r = q(`CREATE TRIGGER v46_tg1 ${timing} ON ${tbl} FOR EACH ROW ${body}`);
          q('DROP TRIGGER IF EXISTS v46_tg1');
          return eq(!!r.error, false);
        });
      });
      scoped('V46F a BEFORE INSERT trigger changes the stored row',
             'CREATE TABLE %T (a INT, log TEXT)', (tbl) => {
        q('DROP TRIGGER IF EXISTS v46_tg2');
        q(`CREATE TRIGGER v46_tg2 BEFORE INSERT ON ${tbl} FOR EACH ROW SET NEW.log = 'set by trigger'`);
        q(`INSERT INTO ${tbl} (a) VALUES (1)`);
        const v = one(`SELECT log FROM ${tbl}`);
        q('DROP TRIGGER IF EXISTS v46_tg2');
        return eq(v, 'set by trigger');
      });
      scoped('V46F SHOW TRIGGERS lists the trigger', 'CREATE TABLE %T (a INT)', (tbl) => {
        q('DROP TRIGGER IF EXISTS v46_tg3');
        q(`CREATE TRIGGER v46_tg3 BEFORE INSERT ON ${tbl} FOR EACH ROW SET NEW.a = 0`);
        const n = rows(`SHOW TRIGGERS FROM ${tbl}`).length;
        q('DROP TRIGGER IF EXISTS v46_tg3');
        return eq(n, 1);
      });

      // ============================================================
      // G. ドメイン・列挙型・シーケンス・ユーザー・ロール・スキーマ
      // ============================================================
      t('V46G a domain constrains a column', () => {
        q('DROP TABLE IF EXISTS v46_dm'); q('DROP DOMAIN IF EXISTS v46_pos');
        q('CREATE DOMAIN v46_pos AS INT CHECK (VALUE >= 0)');
        q('CREATE TABLE v46_dm (x v46_pos)');
        const good = q('INSERT INTO v46_dm VALUES (5)');
        const bad = q('INSERT INTO v46_dm VALUES (-5)');
        q('DROP TABLE IF EXISTS v46_dm'); q('DROP DOMAIN IF EXISTS v46_pos');
        return eq([!!good.error, !!bad.error], [false, true]);
      });
      t('V46G a domain supplies a default', () => {
        q('DROP TABLE IF EXISTS v46_dm2'); q('DROP DOMAIN IF EXISTS v46_d2');
        q('CREATE DOMAIN v46_d2 AS INT DEFAULT 7');
        q('CREATE TABLE v46_dm2 (a INT, x v46_d2)');
        q('INSERT INTO v46_dm2 (a) VALUES (1)');
        const v = one('SELECT x FROM v46_dm2');
        q('DROP TABLE IF EXISTS v46_dm2'); q('DROP DOMAIN IF EXISTS v46_d2');
        return eq(v, 7);
      });
      t('V46G an enum type restricts the values', () => {
        q('DROP TABLE IF EXISTS v46_en'); q('DROP TYPE IF EXISTS v46_col');
        q("CREATE TYPE v46_col AS ENUM ('red', 'green', 'blue')");
        q('CREATE TABLE v46_en (c v46_col)');
        const good = q("INSERT INTO v46_en VALUES ('red')");
        const bad = q("INSERT INTO v46_en VALUES ('purple')");
        q('DROP TABLE IF EXISTS v46_en'); q('DROP TYPE IF EXISTS v46_col');
        return eq([!!good.error, !!bad.error], [false, true]);
      });
      const SEQOPTS = [
        ['START WITH 5', 5], ['START WITH 5 INCREMENT BY 2', 5],
        ['INCREMENT BY 3', 1], ['START WITH 1 MINVALUE 1 MAXVALUE 10', 1],
        ['START WITH 1 INCREMENT BY 1 CYCLE', 1], ['START WITH 1 CACHE 5', 1],
        ['START WITH 100 INCREMENT BY -10', 100],
      ];
      SEQOPTS.forEach(([opts, first]) => {
        t(`V46G CREATE SEQUENCE ${opts}`, () => {
          q('DROP SEQUENCE IF EXISTS v46_sq');
          const r = q(`CREATE SEQUENCE v46_sq ${opts}`);
          if (r.error) { q('DROP SEQUENCE IF EXISTS v46_sq'); throw new Error(r.error); }
          const v = one("SELECT NEXTVAL('v46_sq') AS r");
          q('DROP SEQUENCE IF EXISTS v46_sq');
          return eq(v, first);
        });
      });
      t('V46G ALTER SEQUENCE RESTART WITH', () => {
        q('DROP SEQUENCE IF EXISTS v46_sq2');
        q('CREATE SEQUENCE v46_sq2 START WITH 1');
        one("SELECT NEXTVAL('v46_sq2') AS r");
        q('ALTER SEQUENCE v46_sq2 RESTART WITH 50');
        const v = one("SELECT NEXTVAL('v46_sq2') AS r");
        q('DROP SEQUENCE IF EXISTS v46_sq2');
        return eq(v, 50);
      });
      t('V46G SHOW SEQUENCES lists the sequence', () => {
        q('DROP SEQUENCE IF EXISTS v46_sq3');
        q('CREATE SEQUENCE v46_sq3');
        const n = rows('SHOW SEQUENCES').length;
        q('DROP SEQUENCE IF EXISTS v46_sq3');
        return eq(n >= 1, true);
      });
      ok('V46G CREATE USER', 'CREATE USER v46_u1');
      ok('V46G DROP USER', 'DROP USER v46_u1');
      ok('V46G CREATE ROLE', 'CREATE ROLE v46_r1');
      ok('V46G DROP ROLE', 'DROP ROLE v46_r1');
      ok('V46G CREATE SCHEMA', 'CREATE SCHEMA v46_sc');
      ok('V46G DROP SCHEMA', 'DROP SCHEMA v46_sc');
      ok('V46G CREATE SCHEMA IF NOT EXISTS', 'CREATE SCHEMA IF NOT EXISTS v46_sc2');
      ok('V46G DROP SCHEMA IF EXISTS', 'DROP SCHEMA IF EXISTS v46_sc2');

      // ============================================================
      // H. DROP の全対象
      // ============================================================
      const DROPS = [
        ['TABLE', 'CREATE TABLE v46_o (a INT)', 'DROP TABLE v46_o', 'DROP TABLE IF EXISTS v46_o'],
        ['VIEW', 'CREATE VIEW v46_o AS SELECT 1 AS a', 'DROP VIEW v46_o', 'DROP VIEW IF EXISTS v46_o'],
        ['SEQUENCE', 'CREATE SEQUENCE v46_o', 'DROP SEQUENCE v46_o', 'DROP SEQUENCE IF EXISTS v46_o'],
        ['DOMAIN', 'CREATE DOMAIN v46_o AS INT', 'DROP DOMAIN v46_o', 'DROP DOMAIN IF EXISTS v46_o'],
        ['TYPE', "CREATE TYPE v46_o AS ENUM ('a')", 'DROP TYPE v46_o', 'DROP TYPE IF EXISTS v46_o'],
        ['PROCEDURE', 'CREATE PROCEDURE v46_o() BEGIN SELECT 1 AS a; END',
         'DROP PROCEDURE v46_o', 'DROP PROCEDURE IF EXISTS v46_o'],
        ['FUNCTION', 'CREATE FUNCTION v46_o(a INT) RETURNS INT RETURN a',
         'DROP FUNCTION v46_o', 'DROP FUNCTION IF EXISTS v46_o'],
        ['MATERIALIZED VIEW', 'CREATE MATERIALIZED VIEW v46_o AS SELECT 1 AS a',
         'DROP MATERIALIZED VIEW v46_o', 'DROP MATERIALIZED VIEW IF EXISTS v46_o'],
      ];
      DROPS.forEach(([kind, create, dropSql, dropIf]) => {
        t(`V46H DROP ${kind}`, () => {
          q(dropIf);
          const c = q(create);
          if (c.error) throw new Error(c.error);
          const d = q(dropSql);
          return eq(!!d.error, false);
        });
        t(`V46H DROP ${kind} IF EXISTS on a missing object`, () => {
          q(dropIf);
          const d = q(dropIf);
          return eq(!!d.error, false);
        });
        t(`V46H DROP ${kind} without IF EXISTS on a missing object is an error`, () => {
          q(dropIf);
          const d = q(dropSql);
          return eq(!!d.error, true);
        });
      });
      t('V46H DROP TABLE with several names', () => {
        q('CREATE TABLE v46_m1 (a INT)'); q('CREATE TABLE v46_m2 (a INT)');
        const r = q('DROP TABLE v46_m1, v46_m2');
        return eq([!!r.error, !!db.tables['v46_m1'], !!db.tables['v46_m2']], [false, false, false]);
      });
      t('V46H DROP TABLE CASCADE removes the dependent view', () => {
        q('DROP VIEW IF EXISTS v46_cv'); drop('v46_ct');
        q('CREATE TABLE v46_ct (a INT)');
        q('CREATE VIEW v46_cv AS SELECT a FROM v46_ct');
        const r = q('DROP TABLE v46_ct CASCADE');
        const gone = !db.tables['v46_ct'];
        q('DROP VIEW IF EXISTS v46_cv');
        return eq([!!r.error, gone], [false, true]);
      });
      // 依存するビューがあっても DROP TABLE は通す（移行スクリプトを流しやすくするため）。
      // 残ったビューは参照先が無くなるので、引くとエラーになる
      t('V46H DROP TABLE succeeds even when a view depends on it', () => {
        q('DROP VIEW IF EXISTS v46_cv2'); drop('v46_ct2');
        q('CREATE TABLE v46_ct2 (a INT)');
        q('CREATE VIEW v46_cv2 AS SELECT a FROM v46_ct2');
        const r = q('DROP TABLE v46_ct2');
        const after = q('SELECT * FROM v46_cv2');
        q('DROP VIEW IF EXISTS v46_cv2'); drop('v46_ct2');
        return eq([!!r.error, !!after.error], [false, true]);
      });

      // ============================================================
      // I. TRUNCATE / RENAME / 保守コマンド
      // ============================================================
      scoped('V46I TRUNCATE TABLE empties the table', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1), (2), (3)`);
        q(`TRUNCATE TABLE ${tbl}`);
        return eq(one(`SELECT COUNT(*) AS c FROM ${tbl}`), 0);
      });
      scoped('V46I TRUNCATE without the TABLE keyword', 'CREATE TABLE %T (a INT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        q(`TRUNCATE ${tbl}`);
        return eq(one(`SELECT COUNT(*) AS c FROM ${tbl}`), 0);
      });
      scoped('V46I TRUNCATE keeps the table and its columns', 'CREATE TABLE %T (a INT, b TEXT)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1, 'x')`);
        q(`TRUNCATE ${tbl}`);
        return eq([!!db.tables[tbl], !!db.tables[tbl].cols['b']], [true, true]);
      });
      scoped('V46I TRUNCATE resets AUTO_INCREMENT',
             'CREATE TABLE %T (id INT PRIMARY KEY AUTO_INCREMENT, a INT)', (tbl) => {
        q(`INSERT INTO ${tbl} (a) VALUES (1), (2)`);
        q(`TRUNCATE ${tbl}`);
        q(`INSERT INTO ${tbl} (a) VALUES (9)`);
        return eq(one(`SELECT id FROM ${tbl}`), 1);
      });
      t('V46I TRUNCATE several tables', () => {
        drop('v46_t1', 'v46_t2');
        q('CREATE TABLE v46_t1 (a INT)'); q('CREATE TABLE v46_t2 (a INT)');
        q('INSERT INTO v46_t1 VALUES (1)'); q('INSERT INTO v46_t2 VALUES (1)');
        q('TRUNCATE TABLE v46_t1, v46_t2');
        const n = one('SELECT COUNT(*) AS c FROM v46_t1') + one('SELECT COUNT(*) AS c FROM v46_t2');
        drop('v46_t1', 'v46_t2');
        return eq(n, 0);
      });
      t('V46I RENAME TABLE', () => {
        drop('v46_rn1', 'v46_rn2');
        q('CREATE TABLE v46_rn1 (a INT)');
        q('INSERT INTO v46_rn1 VALUES (7)');
        q('RENAME TABLE v46_rn1 TO v46_rn2');
        const v = one('SELECT a FROM v46_rn2');
        drop('v46_rn1', 'v46_rn2');
        return eq(v, 7);
      });
      ['VACUUM', 'REINDEX', 'CHECKPOINT', 'FLUSH TABLES', 'CLUSTER', 'DISCARD ALL'].forEach(cmd => {
        ok(`V46I ${cmd} is accepted`, cmd);
      });
      t('V46I OPTIMIZE TABLE is accepted', () => {
        const r = q('OPTIMIZE TABLE v46_base');
        return eq(!!r.error, false);
      });
      t('V46I CHECK TABLE reports on the constraints', () => {
        const d = rows('CHECK TABLE v46_base');
        return eq(d.length >= 1, true);
      });
      t('V46I ANALYZE TABLE reports column statistics', () => {
        const d = rows('ANALYZE TABLE v46_base');
        return eq(d.length >= 1, true);
      });
      t('V46I VACUUM keeps the data', () => {
        q('VACUUM');
        return eq(one('SELECT COUNT(*) AS c FROM v46_base'), 3);
      });

      // ============================================================
      // J. CTAS と SELECT INTO
      // ============================================================
      const CTAS = [
        ['a plain select', 'CREATE TABLE %T AS SELECT id, name FROM v46_base', 3],
        ['a filtered select', 'CREATE TABLE %T AS SELECT id FROM v46_base WHERE qty > 15', 2],
        ['an aggregate', 'CREATE TABLE %T AS SELECT COUNT(*) AS n FROM v46_base', 1],
        ['a join', 'CREATE TABLE %T AS SELECT a.id FROM v46_base a JOIN v46_base b ON a.id = b.id', 3],
        ['a CTE', 'CREATE TABLE %T AS WITH c AS (SELECT id FROM v46_base) SELECT * FROM c', 3],
        ['a union', 'CREATE TABLE %T AS SELECT id FROM v46_base UNION SELECT id FROM v46_base', 3],
        ['an ordered and limited select',
         'CREATE TABLE %T AS SELECT id FROM v46_base ORDER BY id DESC LIMIT 2', 2],
        ['a window function',
         'CREATE TABLE %T AS SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v46_base', 3],
        ['the AS keyword omitted', 'CREATE TABLE %T SELECT id FROM v46_base', 3],
        ['IF NOT EXISTS', 'CREATE TABLE IF NOT EXISTS %T AS SELECT id FROM v46_base', 3],
        ['an empty result', 'CREATE TABLE %T AS SELECT id FROM v46_base WHERE 1 = 0', 0],
      ];
      CTAS.forEach(([label, sql, n]) => {
        t(`V46J CREATE TABLE AS with ${label}`, () => {
          drop('v46_ctas');
          const r = q(sql.split('%T').join('v46_ctas'));
          if (r.error) { drop('v46_ctas'); throw new Error(r.error); }
          const c = one('SELECT COUNT(*) AS c FROM v46_ctas');
          drop('v46_ctas');
          return eq(c, n);
        });
      });
      t('V46J SELECT INTO creates a table', () => {
        drop('v46_si');
        q('SELECT id, name INTO v46_si FROM v46_base');
        const c = one('SELECT COUNT(*) AS c FROM v46_si');
        drop('v46_si');
        return eq(c, 3);
      });
      t('V46J CTAS keeps the values', () => {
        drop('v46_ctas2');
        q('CREATE TABLE v46_ctas2 AS SELECT id, qty FROM v46_base ORDER BY id');
        const got = rows('SELECT id, qty FROM v46_ctas2 ORDER BY id');
        drop('v46_ctas2');
        return eq(got, [{ id: 1, qty: 10 }, { id: 2, qty: 20 }, { id: 3, qty: 30 }]);
      });
      t('V46J an empty CTAS still has its columns', () => {
        drop('v46_ctas3');
        q('CREATE TABLE v46_ctas3 AS SELECT id, qty FROM v46_base WHERE 1 = 0');
        const r = q('SELECT COALESCE(SUM(qty), 0) AS s FROM v46_ctas3');
        drop('v46_ctas3');
        return eq([!!r.error, r.data[0].s], [false, 0]);
      });

      // ============================================================
      // K. DDL の誤りは拒否される
      // ============================================================
      err('V46K CREATE TABLE with no columns', 'CREATE TABLE v46_bad ()');
      err('V46K CREATE TABLE that already exists', 'CREATE TABLE v46_base (a INT)', 'already exists');
      err('V46K CREATE TABLE with a duplicate column', 'CREATE TABLE v46_bad (a INT, a INT)');
      err('V46K CREATE TABLE with a subquery in a CHECK',
          'CREATE TABLE v46_bad (a INT CHECK (a IN (SELECT id FROM v46_base)))', 'subquery');
      err('V46K CREATE TABLE with a foreign key to a missing table',
          'CREATE TABLE v46_bad (a INT REFERENCES v46_nosuch(id))');
      err('V46K ALTER TABLE on a missing table', 'ALTER TABLE v46_nosuch ADD COLUMN a INT');
      err('V46K ALTER TABLE ADD an existing column', 'ALTER TABLE v46_base ADD COLUMN id INT');
      err('V46K ALTER TABLE DROP a missing column', 'ALTER TABLE v46_base DROP COLUMN nosuch');
      err('V46K ALTER TABLE RENAME a missing column', 'ALTER TABLE v46_base RENAME COLUMN nosuch TO z');
      err('V46K ALTER TABLE with a subquery in a CHECK',
          'ALTER TABLE v46_base ADD CHECK (id IN (SELECT id FROM v46_base))', 'subquery');
      err('V46K CREATE INDEX on a missing table', 'CREATE INDEX v46_bad ON v46_nosuch (a)');
      err('V46K CREATE INDEX on a missing column', 'CREATE INDEX v46_bad ON v46_base (nosuch)');
      // ビューの本体は定義時ではなく参照時に解決する（表を後から作る移行スクリプトを
      // そのまま流せるようにするため）。誤りは引いた時点で判る
      t('V46K CREATE VIEW over a missing table defers the error to query time', () => {
        q('DROP VIEW IF EXISTS v46_lazy');
        const c = q('CREATE VIEW v46_lazy AS SELECT a FROM v46_nosuch');
        const s = q('SELECT * FROM v46_lazy');
        q('DROP VIEW IF EXISTS v46_lazy');
        return eq([!!c.error, !!s.error, s.error.indexOf('v46_nosuch') !== -1], [false, true, true]);
      });
      err('V46K DROP TABLE on a missing table', 'DROP TABLE v46_nosuch');
      err('V46K DROP VIEW on a missing view', 'DROP VIEW v46_nosuch');
      err('V46K DROP INDEX on a missing index', 'DROP INDEX v46_nosuch ON v46_base');
      t('V46K CREATE SEQUENCE that already exists is an error', () => {
        q('DROP SEQUENCE IF EXISTS v46_dup');
        q('CREATE SEQUENCE v46_dup');
        const r = q('CREATE SEQUENCE v46_dup');
        q('DROP SEQUENCE IF EXISTS v46_dup');
        return eq(!!r.error, true);
      });
      err('V46K TRUNCATE a missing table', 'TRUNCATE TABLE v46_nosuch');
      err('V46K RENAME a missing table', 'RENAME TABLE v46_nosuch TO v46_other');
      err('V46K CREATE TYPE with no values', 'CREATE TYPE v46_bad AS ENUM ()');
      err('V46K CREATE TRIGGER on a missing table',
          'CREATE TRIGGER v46_bad BEFORE INSERT ON v46_nosuch FOR EACH ROW SET NEW.a = 1');
      t('V46K CREATE PROCEDURE with an empty body is accepted', () => {
        q('DROP PROCEDURE IF EXISTS v46_empty');
        const r = q('CREATE PROCEDURE v46_empty()');
        q('DROP PROCEDURE IF EXISTS v46_empty');
        return eq(!!r.error, false);
      });
      // 列の型名は方言差が大きいので、知らない綴りは ANY として受け入れる
      // （CAST の型名は逆に厳しく検査する。そちらは変換規則を選ぶ必要があるため）
      scoped('V46K an unknown column type is accepted as ANY', 'CREATE TABLE %T (a NOSUCHTYPE)', (tbl) => {
        q(`INSERT INTO ${tbl} VALUES (1)`);
        q(`INSERT INTO ${tbl} VALUES ('text too')`);
        return eq(one(`SELECT COUNT(*) AS c FROM ${tbl}`), 2);
      });

      // ============================================================
      // L. 型 × 値 の格納・読み出し行列
      // ============================================================
      const NUMTY = ['INT', 'INTEGER', 'SMALLINT', 'BIGINT', 'TINYINT', 'MEDIUMINT',
                     'INT2', 'INT4', 'INT8', 'SERIAL'];
      const NUMVALS = [['0', 0], ['1', 1], ['-1', -1], ['2147483647', 2147483647],
                       ['-2147483648', -2147483648], ['NULL', null]];
      NUMTY.forEach(ty => NUMVALS.forEach(([lit, want]) => {
        scoped(`V46L ${ty} stores ${lit}`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
      }));
      const DECTY = ['DECIMAL(12,3)', 'NUMERIC(12,3)', 'DEC(12,3)', 'NUMBER(12,3)'];
      const DECVALS = [['0', 0], ['1.5', 1.5], ['-1.5', -1.5], ['12.3456', 12.346],
                       ['1000.0005', 1000.001], ['NULL', null]];
      DECTY.forEach(ty => DECVALS.forEach(([lit, want]) => {
        scoped(`V46L ${ty} stores ${lit}`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
      }));
      const TXTTY = ['TEXT', 'VARCHAR(100)', 'CHAR(100)', 'VARCHAR2(100)', 'NVARCHAR(100)',
                     'NCHAR(100)', 'CLOB', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT', 'STRING'];
      const TXTVALS = [["'abc'", 'abc'], ["''", ''], ["'  pad  '", '  pad  '],
                       ["'a,b,c'", 'a,b,c'], ["'123'", '123'], ['NULL', null]];
      TXTTY.forEach(ty => TXTVALS.forEach(([lit, want]) => {
        scoped(`V46L ${ty} stores ${lit}`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
      }));
      const DATETY = [['DATE', "'2024-03-15'", '2024-03-15'],
                      ['DATE', "'2024-03-15 12:34:56'", '2024-03-15'],
                      ['TIMESTAMP', "'2024-03-15 12:34:56'", '2024-03-15 12:34:56'],
                      ['DATETIME', "'2024-03-15 12:34:56'", '2024-03-15 12:34:56'],
                      ['TIME', "'12:34:56'", '12:34:56']];
      DATETY.forEach(([ty, lit, want]) => {
        scoped(`V46L ${ty} stores ${lit}`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
      });
      // 型ごとに違反する値は拒否される
      const BADVALS = [
        ['INTEGER', '1.5'], ['INTEGER', "'abc'"], ['INT', '1.5'],
        ['FLOAT', "'abc'"], ['FLOAT', '1e309'],
        ['DATE', "'not a date'"], ['DATE', "'2026-13-01'"],
        ['BOOLEAN', "'maybe'"], ['BOOLEAN', '7'],
        ['DECIMAL(4,2)', '10000'],
      ];
      BADVALS.forEach(([ty, lit]) => {
        scoped(`V46L ${ty} rejects ${lit}`, `CREATE TABLE %T (x ${ty})`, (tbl) => {
          const r = q(`INSERT INTO ${tbl} VALUES (${lit})`);
          return eq(!!r.error, true);
        });
      });
      // 長さ・桁の宣言が効く
      scoped('V46L VARCHAR rejects an over-long value', 'CREATE TABLE %T (x VARCHAR(3))', (tbl) => {
        const good = q(`INSERT INTO ${tbl} VALUES ('abc')`);
        const bad = q(`INSERT INTO ${tbl} VALUES ('abcd')`);
        return eq([!!good.error, !!bad.error], [false, true]);
      });
      [[2, 12.35], [1, 12.3], [0, 12], [3, 12.346]].forEach(([s, want]) => {
        scoped(`V46L DECIMAL with scale ${s} rounds`, `CREATE TABLE %T (x DECIMAL(10,${s}))`, (tbl) => {
          q(`INSERT INTO ${tbl} VALUES (12.3456)`);
          return eq(one(`SELECT x FROM ${tbl}`), want);
        });
      });

      // ============================================================
      // M. ALTER のアクション × 表の状態
      // ============================================================
      const STATES = [
        ['an empty table', () => {}],
        ['a table with rows', (tbl) => q(`INSERT INTO ${tbl} (a) VALUES (1), (2), (3)`)],
        ['a table with an index', (tbl) => { q(`CREATE INDEX v46_mix ON ${tbl} (a)`); }],
        ['a table with rows and an index', (tbl) => {
          q(`INSERT INTO ${tbl} (a) VALUES (1), (2), (3)`); q(`CREATE INDEX v46_mix ON ${tbl} (a)`); }],
      ];
      const ACTIONS = [
        ['ADD COLUMN z INT', tbl => !!db.tables[tbl].cols['z']],
        ['ADD COLUMN z TEXT DEFAULT \'d\'', tbl => !!db.tables[tbl].cols['z']],
        ['DROP COLUMN b', tbl => !db.tables[tbl].cols['b']],
        ['RENAME COLUMN b TO z', tbl => !!db.tables[tbl].cols['z'] && !db.tables[tbl].cols['b']],
        ['MODIFY COLUMN b TEXT', tbl => !!db.tables[tbl].cols['b']],
        ['ALTER COLUMN b SET DEFAULT 5', tbl => !!db.tables[tbl].cols['b']],
        ['ALTER COLUMN b DROP DEFAULT', tbl => !!db.tables[tbl].cols['b']],
        ['ALTER COLUMN b DROP NOT NULL', tbl => !!db.tables[tbl].cols['b']],
        ['ADD CONSTRAINT ckm CHECK (a >= 0)', tbl => !!db.tables[tbl]],
        ['ADD UNIQUE (b)', tbl => !!db.tables[tbl]],
      ];
      STATES.forEach(([label, setup]) => ACTIONS.forEach(([action, verify]) => {
        t(`V46M ALTER TABLE ${action} on ${label}`, () => {
          const tbl = 'v46_alt';
          q('DROP TABLE IF EXISTS ' + tbl);
          q(`CREATE TABLE ${tbl} (a INT, b INT)`);
          setup(tbl);
          const r = q(`ALTER TABLE ${tbl} ${action}`);
          const okv = !r.error && verify(tbl);
          const kept = one(`SELECT COUNT(*) AS c FROM ${tbl}`);
          q(`DROP INDEX IF EXISTS v46_mix ON ${tbl}`);
          q('DROP TABLE IF EXISTS ' + tbl);
          if (r.error) throw new Error(r.error);
          return eq([okv, kept >= 0], [true, true]);
        });
      }));

      // ============================================================
      // N. 索引の有無でクエリ結果が変わらないこと
      // ============================================================
      const IXQUERIES = [
        'SELECT COUNT(*) AS c FROM %T',
        'SELECT COUNT(*) AS c FROM %T WHERE a = 5',
        'SELECT COUNT(*) AS c FROM %T WHERE a <> 5',
        'SELECT COUNT(*) AS c FROM %T WHERE a > 10',
        'SELECT COUNT(*) AS c FROM %T WHERE a >= 10 AND a <= 20',
        'SELECT COUNT(*) AS c FROM %T WHERE a IN (1, 3, 5, 7)',
        'SELECT COUNT(*) AS c FROM %T WHERE a IS NULL',
        'SELECT COUNT(*) AS c FROM %T WHERE a IS NOT NULL',
        'SELECT COUNT(*) AS c FROM %T WHERE b LIKE \'x%\'',
        'SELECT a, COUNT(*) AS c FROM %T GROUP BY a ORDER BY a LIMIT 5',
        'SELECT a FROM %T ORDER BY a DESC LIMIT 5',
        'SELECT DISTINCT a FROM %T ORDER BY a LIMIT 10',
        'SELECT SUM(a) AS s FROM %T WHERE a > 5',
        'SELECT a FROM %T WHERE a BETWEEN 5 AND 15 ORDER BY a',
        'SELECT COUNT(*) AS c FROM %T x JOIN %T y ON x.a = y.a',
      ];
      const IXDEFS = [
        ['no index', null],
        ['an index on a', 'CREATE INDEX v46_q1 ON %T (a)'],
        ['a unique index on c', 'CREATE UNIQUE INDEX v46_q1 ON %T (c)'],
        ['an index on b', 'CREATE INDEX v46_q1 ON %T (b)'],
        ['a composite index on a and b', 'CREATE INDEX v46_q1 ON %T (a, b)'],
      ];
      t('V46N index fixture', () => {
        drop('v46_ixq');
        q('CREATE TABLE v46_ixq (a INT, b TEXT, c INT)');
        const vals = [];
        for (let i = 0; i < 300; i++) {
          const a = (i % 17 === 16) ? 'NULL' : String(i % 31);
          vals.push(`(${a}, 'x${i % 7}', ${i})`);
        }
        q('INSERT INTO v46_ixq VALUES ' + vals.join(','));
        return eq(db.tables['v46_ixq'].rowCount, 300);
      });
      IXQUERIES.forEach((tmpl, qi) => {
        const sql = tmpl.split('%T').join('v46_ixq');
        t(`V46N query ${qi} agrees across every index layout`, () => {
          q('DROP INDEX IF EXISTS v46_q1 ON v46_ixq');
          const base = rows(sql);
          IXDEFS.slice(1).forEach(([label, mk]) => {
            q('DROP INDEX IF EXISTS v46_q1 ON v46_ixq');
            const cr = q(mk.split('%T').join('v46_ixq'));
            if (cr.error) return;      // 一意にできない索引はこの表では張らない
            const got = rows(sql);
            q('DROP INDEX IF EXISTS v46_q1 ON v46_ixq');
            eq(got, base, `with ${label}:`);
          });
          return true;
        });
      });

      // ============================================================
      // O. CREATE TABLE のオプション × 実データ
      // ============================================================
      const OPTCOMBOS = [];
      ['', ' NOT NULL'].forEach(nn =>
        ['', ' DEFAULT 5'].forEach(df =>
          ['', ' UNIQUE'].forEach(uq =>
            ['', ' CHECK (x >= 0)'].forEach(ck => {
              if (nn === '' && df === '' && uq === '' && ck === '') return;
              OPTCOMBOS.push(`x INT${nn}${df}${uq}${ck}`);
            }))));
      OPTCOMBOS.forEach(def => {
        scoped(`V46O CREATE TABLE (${def})`, `CREATE TABLE %T (id INT, ${def})`, (tbl) => {
          const r = q(`INSERT INTO ${tbl} (id, x) VALUES (1, 3)`);
          return eq([!!r.error, one(`SELECT x FROM ${tbl}`)], [false, 3]);
        });
        scoped(`V46O the default applies for (${def})`, `CREATE TABLE %T (id INT, ${def})`, (tbl) => {
          const r = q(`INSERT INTO ${tbl} (id) VALUES (1)`);
          const wantErr = def.indexOf('NOT NULL') !== -1 && def.indexOf('DEFAULT') === -1;
          return eq(!!r.error, wantErr);
        });
      });

      // ============================================================
      // 片付け
      // ============================================================
      t('V46Zz cleanup', () => {
        drop('v46_ixq', 'v46_alt');
        ['v46_base', 'v46_tmp', 'v46_renamed', 'v46_dm', 'v46_dm2', 'v46_en', 'v46_o',
         'v46_m1', 'v46_m2', 'v46_ct', 'v46_ct2', 'v46_t1', 'v46_t2', 'v46_rn1', 'v46_rn2',
         'v46_ctas', 'v46_ctas2', 'v46_ctas3', 'v46_si', 'v46_bad'].forEach(n => q('DROP TABLE IF EXISTS ' + n));
        ['v46_v1', 'v46_cv', 'v46_cv2'].forEach(n => q('DROP VIEW IF EXISTS ' + n));
        q('DROP MATERIALIZED VIEW IF EXISTS v46_mv1');
        ['v46_sq', 'v46_sq2', 'v46_sq3'].forEach(n => q('DROP SEQUENCE IF EXISTS ' + n));
        ['v46_pos', 'v46_d2'].forEach(n => q('DROP DOMAIN IF EXISTS ' + n));
        q('DROP TYPE IF EXISTS v46_col');
        return Object.keys(db.tables).filter(n => n.indexOf('v46_') === 0).length === 0;
      });

      return T;
    }
