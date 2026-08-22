    // ============================================================================
    // [Test Suite v57] - 特殊なクエリ構成 (1/4): 深さと幅
    //
    //   「普通は書かないが書ける」構造を、深さ・幅を変えながら機械的に組み立てて、
    //   素直に書いた同じ意味のクエリと結果が一致することを確かめる。
    //   壊れ方が「途中で切れる」「黙って別の式になる」形で出るため、
    //   段数を 1 つずつ変えて掃引するのが効く。
    //
    //     A. 入れ子の深さ（派生表 / CTE 連鎖 / 関数 / 括弧 / CASE / 副問い合わせ）
    //     B. 句の幅（SELECT 項目 / IN リスト / 演算項 / WHEN / GROUP BY / ORDER BY / JOIN 表数）
    //     C. 深い構造 × 外側の句（WHERE / GROUP BY / ORDER BY / ウィンドウ）
    //     D. 集合演算の枝数と括り方
    //     E. 深い構造を整形して書く（改行・コメントを挟む）
    //     F. 限界（受け付けない深さ・大きさ）
    //
    //   test-suite.js の tests 配列へ getV57Tests() のスプレッドで合流する
    // ============================================================================
    function getV57Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, same, valsOf, spaced, insertRows, drop, cleanup } = makeTestKit('V57');

      // ------------------------------------------------------------
      // 0. フィクスチャ（12 行。深い構造を何段重ねても軽いように小さく保つ）
      // ------------------------------------------------------------
      t('V57 fixture', () => {
        drop('v57_t', 'v57_u', 'v57_s');
        q("CREATE TABLE v57_t (id INT PRIMARY KEY, g TEXT, v INT, w INT)");
        q("CREATE TABLE v57_u (id INT PRIMARY KEY, tag TEXT)");
        // 表数・段数の指数で効く形（カンマ結合の多重・相関 EXISTS の入れ子）用の 3 行表
        q("CREATE TABLE v57_s (id INT PRIMARY KEY, v INT)");
        insertRows('v57_s', [[1, 10], [2, 20], [3, 30]]);
        const rows = [];
        for (let i = 1; i <= 12; i++) {
          rows.push([i, ['a', 'b', 'c'][i % 3], (i % 5 === 0) ? null : (i * 7) % 40, i * 3]);
        }
        insertRows('v57_t', rows);
        insertRows('v57_u', [[1, 'x'], [2, 'y'], [3, 'x'], [4, 'z'], [5, 'y'], [6, 'x']]);
        return db.tables['v57_t'].rowCount === 12 && db.tables['v57_u'].rowCount === 6 && db.tables['v57_s'].rowCount === 3;
      });

      // ============================================================
      // A. 入れ子の深さ
      // ============================================================
      // 深さ n の構造を組み立てる関数。base と同じ結果になるはず
      // 1 段ずつ掃引する（「n 段で急に壊れる」形の欠陥を取り逃さないため）
      const DEPTHS = Array.from({ length: 80 }, (_, i) => i + 1);
      const BASE_SEL = "SELECT id, v FROM v57_t ORDER BY id";

      // A1. 派生表を n 段重ねる
      DEPTHS.forEach(n => {
        let inner = 'SELECT id, v FROM v57_t';
        for (let i = 0; i < n; i++) inner = `SELECT id, v FROM (${inner}) d${i}`;
        same(`V57A 派生表 ${n} 段`, BASE_SEL, inner + ' ORDER BY id');
      });
      // A2. CTE を n 本つなぐ
      DEPTHS.forEach(n => {
        let head = '', prev = 'v57_t';
        for (let i = 0; i < n; i++) {
          head += `${i ? ', ' : 'WITH '}c${i} AS (SELECT id, v FROM ${prev})`;
          prev = 'c' + i;
        }
        same(`V57A CTE ${n} 本の連鎖`, BASE_SEL, `${head} SELECT id, v FROM ${prev} ORDER BY id`);
      });
      // A3. 関数を n 段重ねる（値は変わらない関数を選ぶ）
      DEPTHS.forEach(n => {
        let e = 'v';
        for (let i = 0; i < n; i++) e = `COALESCE(${e}, NULL)`;
        same(`V57A COALESCE ${n} 段`, BASE_SEL, `SELECT id, ${e} AS v FROM v57_t ORDER BY id`);
        let e2 = 'v';
        for (let i = 0; i < n; i++) e2 = `ABS(${e2})`;
        same(`V57A ABS ${n} 段`, "SELECT id, ABS(v) AS v FROM v57_t ORDER BY id",
             `SELECT id, ${e2} AS v FROM v57_t ORDER BY id`);
      });
      // A4. 括弧を n 重にする
      [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 60, 80, 120, 160, 240, 320].forEach(n => {
        same(`V57A 括弧 ${n} 重（式）`, BASE_SEL,
             `SELECT id, ${'('.repeat(n)}v${')'.repeat(n)} AS v FROM v57_t ORDER BY id`);
        same(`V57A 括弧 ${n} 重（条件）`, "SELECT id, v FROM v57_t WHERE v > 10 ORDER BY id",
             `SELECT id, v FROM v57_t WHERE ${'('.repeat(n)}v > 10${')'.repeat(n)} ORDER BY id`);
      });
      // A5. CASE を n 段入れ子にする（内側ほど先に効くので、外側は常に内側へ流す）
      DEPTHS.forEach(n => {
        let e = 'v';
        for (let i = 0; i < n; i++) e = `CASE WHEN 1 = 0 THEN -1 ELSE ${e} END`;
        same(`V57A CASE ${n} 段`, BASE_SEL, `SELECT id, ${e} AS v FROM v57_t ORDER BY id`);
      });
      // A6. 副問い合わせを n 段入れ子にする（IN は 1 段ごとに全行走査が増えるので浅めに）
      [1, 2, 3, 4, 5, 6, 8, 10].forEach(n => {
        let inner = 'SELECT id FROM v57_t WHERE v > 10';
        for (let i = 0; i < n; i++) inner = `SELECT id FROM v57_t WHERE id IN (${inner})`;
        same(`V57A IN の入れ子 ${n} 段`, "SELECT id FROM v57_t WHERE v > 10 ORDER BY id", inner + ' ORDER BY id');
      });
      // 非相関 EXISTS を n 段入れ子にする（相関どうしの入れ子は非対応 → F 節で記録）。
      // 行数の積で効くので 3 行の表で 5 段まで
      [1, 2, 3, 4, 5].forEach(n => {
        let ex = 'SELECT 1 FROM v57_s z0 WHERE z0.id = 1';
        for (let i = 1; i <= n; i++) ex = `SELECT 1 FROM v57_s z${i} WHERE EXISTS (${ex})`;
        same(`V57A 非相関 EXISTS の入れ子 ${n} 段`, "SELECT id FROM v57_s ORDER BY id",
             `SELECT id FROM v57_s WHERE EXISTS (${ex}) ORDER BY id`);
      });
      // 相関 EXISTS の中へ非相関 EXISTS を n 個並べる（入れ子ではなく横並び）
      [1, 2, 3, 5, 8].forEach(n => {
        const inner = Array.from({ length: n },
          (_, i) => `EXISTS (SELECT 1 FROM v57_s y${i} WHERE y${i}.id = ${(i % 3) + 1})`).join(' AND ');
        same(`V57A 相関 EXISTS + 非相関 ${n} 個`, "SELECT id FROM v57_s ORDER BY id",
             `SELECT id FROM v57_s e WHERE EXISTS (SELECT 1 FROM v57_s x WHERE x.id = e.id AND ${inner}) ORDER BY id`);
      });

      // ============================================================
      // B. 句の幅
      // ============================================================
      const WIDTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 80, 96, 120, 160, 200, 240, 320];
      // B1. SELECT 項目を n 個並べる（最後の項目だけを見る）
      WIDTHS.forEach(n => {
        const items = Array.from({ length: n }, (_, i) => `${i} AS c${i}`).join(', ');
        t(`V57B SELECT 項目 ${n} 個`, () => {
          const got = valsOf(`SELECT ${items}`);
          const want = JSON.stringify([Array.from({ length: n }, (_, i) => i)]);
          if (got !== want) throw new Error('expected ' + want.slice(0, 120) + ' but got ' + got.slice(0, 120));
          return true;
        });
      });
      // B2. IN リストを n 個にする
      WIDTHS.forEach(n => {
        const list = Array.from({ length: n }, (_, i) => i + 1).join(', ');
        same(`V57B IN リスト ${n} 個`,
             `SELECT id FROM v57_t WHERE id <= ${n} ORDER BY id`,
             `SELECT id FROM v57_t WHERE id IN (${list}) ORDER BY id`);
      });
      // B3. 演算項を n 個つなぐ
      WIDTHS.forEach(n => {
        same(`V57B 加算 ${n} 項`,
             `SELECT id, v * ${n} AS s FROM v57_t ORDER BY id`,
             `SELECT id, ${Array.from({ length: n }, () => 'v').join(' + ')} AS s FROM v57_t ORDER BY id`);
        same(`V57B 連結 ${n} 項`,
             `SELECT id, REPEAT(g, ${n}) AS s FROM v57_t ORDER BY id`,
             `SELECT id, ${Array.from({ length: n }, () => 'g').join(' || ')} AS s FROM v57_t ORDER BY id`);
      });
      // B4. CASE の WHEN を n 個並べる（どれにも当たらない ELSE へ落とす）
      WIDTHS.forEach(n => {
        const whens = Array.from({ length: n }, (_, i) => `WHEN ${-(i + 1)} THEN ${i}`).join(' ');
        same(`V57B WHEN ${n} 個`, BASE_SEL,
             `SELECT id, CASE v ${whens} ELSE v END AS v FROM v57_t ORDER BY id`);
      });
      // B5. ORDER BY のキーを n 本にする（先頭が効くので結果は同じ）
      [1, 2, 3, 5, 10, 20, 40].forEach(n => {
        const keys = ['id'].concat(Array.from({ length: n - 1 }, () => 'v')).join(', ');
        same(`V57B ORDER BY ${n} キー`, BASE_SEL, `SELECT id, v FROM v57_t ORDER BY ${keys}`);
      });
      // B6. GROUP BY の列数を増やす（一意な列を混ぜるので 1 行 1 グループ）
      [1, 2, 3, 5, 8].forEach(n => {
        const cols = ['id'].concat(Array.from({ length: n - 1 }, (_, i) => (i % 2 ? 'g' : 'v'))).join(', ');
        same(`V57B GROUP BY ${n} 列`,
             "SELECT id, COUNT(*) AS c FROM v57_t GROUP BY id ORDER BY id",
             `SELECT id, COUNT(*) AS c FROM v57_t GROUP BY ${cols} ORDER BY id`);
      });
      // B7. 同じ表を n 回結合する（1 対 1 なので行数は変わらない）。
      //     カンマ結合は組み合わせが表数の指数で増えるため、小さい表（3 行）で回す
      [2, 3, 4, 5, 6, 8, 10].forEach(n => {
        const joins = Array.from({ length: n - 1 }, (_, i) => `JOIN v57_t y${i + 1} ON y${i + 1}.id = y0.id`).join(' ');
        same(`V57B 自己結合 ${n} 表（JOIN）`,
             "SELECT id, v FROM v57_t ORDER BY id",
             `SELECT y0.id, y0.v FROM v57_t y0 ${joins} ORDER BY y0.id`);
      });
      [2, 3, 4, 5, 6].forEach(n => {
        const tables = Array.from({ length: n }, (_, i) => `v57_s x${i}`).join(', ');
        const on = Array.from({ length: n - 1 }, (_, i) => `x${i}.id = x${i + 1}.id`).join(' AND ');
        same(`V57B 自己結合 ${n} 表（カンマ）`,
             "SELECT id, v FROM v57_s ORDER BY id",
             `SELECT x0.id, x0.v FROM ${tables} WHERE ${on} ORDER BY x0.id`);
      });

      // ============================================================
      // C. 深い構造 × 外側の句
      // ============================================================
      const nest = (n) => {
        let s = 'SELECT id, g, v FROM v57_t';
        for (let i = 0; i < n; i++) s = `SELECT id, g, v FROM (${s}) n${i}`;
        return s;
      };
      const OUTER = [
        ['WHERE', "SELECT id FROM {SRC} WHERE v > 10 ORDER BY id", "SELECT id FROM v57_t WHERE v > 10 ORDER BY id"],
        ['GROUP BY', "SELECT g, COUNT(*) AS c FROM {SRC} GROUP BY g ORDER BY g", "SELECT g, COUNT(*) AS c FROM v57_t GROUP BY g ORDER BY g"],
        ['HAVING', "SELECT g, SUM(v) AS s FROM {SRC} GROUP BY g HAVING SUM(v) > 20 ORDER BY g", "SELECT g, SUM(v) AS s FROM v57_t GROUP BY g HAVING SUM(v) > 20 ORDER BY g"],
        ['ORDER BY + LIMIT', "SELECT id FROM {SRC} ORDER BY v DESC NULLS LAST, id LIMIT 4", "SELECT id FROM v57_t ORDER BY v DESC NULLS LAST, id LIMIT 4"],
        ['DISTINCT', "SELECT DISTINCT g FROM {SRC} ORDER BY g", "SELECT DISTINCT g FROM v57_t ORDER BY g"],
        ['ウィンドウ', "SELECT id, SUM(v) OVER (PARTITION BY g ORDER BY id) AS s FROM {SRC} ORDER BY id", "SELECT id, SUM(v) OVER (PARTITION BY g ORDER BY id) AS s FROM v57_t ORDER BY id"],
        ['集合演算', "SELECT id FROM {SRC} WHERE v > 20 UNION SELECT id FROM {SRC} WHERE v < 10 ORDER BY id", "SELECT id FROM v57_t WHERE v > 20 UNION SELECT id FROM v57_t WHERE v < 10 ORDER BY id"],
        ['相関副問い合わせ', "SELECT id, (SELECT COUNT(*) FROM v57_u u WHERE u.id = src.id) AS c FROM {SRC} ORDER BY id", "SELECT id, (SELECT COUNT(*) FROM v57_u u WHERE u.id = src.id) AS c FROM v57_t src ORDER BY id"],
      ];
      [1, 2, 4, 8, 16, 24].forEach(n => {
        const src = `(${nest(n)}) src`;
        OUTER.forEach(([label, tmpl, base]) => {
          same(`V57C 派生表 ${n} 段 + ${label}`, base, tmpl.split('{SRC}').join(src));
        });
      });
      // CTE 版でも同じことを見る
      [1, 2, 4, 8, 16].forEach(n => {
        let head = '', prev = 'v57_t';
        for (let i = 0; i < n; i++) {
          head += `${i ? ', ' : 'WITH '}k${i} AS (SELECT id, g, v FROM ${prev})`;
          prev = 'k' + i;
        }
        OUTER.forEach(([label, tmpl, base]) => {
          same(`V57C CTE ${n} 本 + ${label}`, base, head + ' ' + tmpl.split('{SRC}').join(`${prev} src`));
        });
      });

      // ============================================================
      // D. 集合演算の枝数と括り方
      // ============================================================
      Array.from({ length: 39 }, (_, i) => i + 2).forEach(n => {
        const branches = Array.from({ length: n }, (_, i) => `SELECT ${i} AS x`);
        same(`V57D UNION ALL ${n} 枝`,
             `SELECT x FROM GENERATE_SERIES(0, ${n - 1}) g(x) ORDER BY x`,
             branches.join(' UNION ALL ') + ' ORDER BY x');
        same(`V57D UNION ${n} 枝（重複あり）`,
             `SELECT x FROM GENERATE_SERIES(0, ${n - 1}) g(x) ORDER BY x`,
             branches.concat(branches).join(' UNION ') + ' ORDER BY x');
        // 括弧で括った枝
        same(`V57D 括弧付き ${n} 枝`,
             `SELECT x FROM GENERATE_SERIES(0, ${n - 1}) g(x) ORDER BY x`,
             branches.map(b => `(${b})`).join(' UNION ALL ') + ' ORDER BY x');
      });
      // 同じ表を n 回 UNION ALL する（行数が n 倍になる）
      [2, 3, 5, 10, 20].forEach(n => {
        t(`V57D 同じ表を ${n} 回 UNION ALL`, () => {
          const sql = Array.from({ length: n }, () => 'SELECT id FROM v57_t').join(' UNION ALL ');
          const got = valsOf(`SELECT COUNT(*) AS c FROM (${sql}) x`);
          const want = JSON.stringify([[12 * n]]);
          if (got !== want) throw new Error('expected ' + want + ' but got ' + got);
          return true;
        });
      });

      // ============================================================
      // E. 深い構造を整形して書く
      // ============================================================
      [2, 4, 8, 16].forEach(n => {
        const deep = nest(n) + ' ORDER BY id';
        const baseline = "SELECT id, g, v FROM v57_t ORDER BY id";
        same(`V57E 派生表 ${n} 段を改行で整形`, baseline, spaced(deep, '\n'));
        same(`V57E 派生表 ${n} 段にコメントを挟む`, baseline, spaced(deep, ' /*d*/ '));
        same(`V57E 派生表 ${n} 段を大文字で`, baseline, deep.toUpperCase());
        same(`V57E 派生表 ${n} 段をタブで`, baseline, spaced(deep, '\t'));
      });
      [2, 4, 8, 16].forEach(n => {
        let e = 'v';
        for (let i = 0; i < n; i++) e = `COALESCE(\n${e},\nNULL)`;
        same(`V57E 関数 ${n} 段を複数行で`, BASE_SEL, `SELECT id,\n${e} AS v\nFROM v57_t\nORDER BY id`);
      });

      // ============================================================
      // F. 限界（受け付けない深さ・大きさ）
      // ============================================================
      err('V57F 再帰 CTE の反復上限を超えると止まる',
          "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 5000) SELECT COUNT(*) FROM r",
          'exceeded');
      err('V57F 終了条件のない再帰は止まる',
          "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x FROM r) SELECT COUNT(*) FROM r",
          'exceeded');
      err('V57F 括弧が閉じていない', "SELECT (((1 + 1) AS r", '');
      err('V57F 相関副問い合わせの入れ子は非対応',
          "SELECT id FROM v57_s e WHERE EXISTS (SELECT 1 FROM v57_s x WHERE x.id = e.id "
          + "AND EXISTS (SELECT 1 FROM v57_s y WHERE y.id = x.id))", 'nested correlated');
      // 空の IN リストはエラーではなく「どれにも当たらない」（NOT IN は全件）
      same('V57F 空の IN リストは 0 件', "SELECT id FROM v57_t WHERE 1 = 0",
           "SELECT id FROM v57_t WHERE id IN ()");
      same('V57F 空の NOT IN リストは全件', "SELECT id FROM v57_t ORDER BY id",
           "SELECT id FROM v57_t WHERE id NOT IN () ORDER BY id");
      t('V57F 深さ 500 の再帰 CTE は通る', () => {
        const got = valsOf("WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 500) "
          + "SELECT COUNT(*) AS c, MAX(x) AS m FROM r");
        if (got !== '[[500,500]]') throw new Error('expected [[500,500]] but got ' + got);
        return true;
      });
      t('V57F 1 万行の表関数は通る', () => {
        const got = valsOf("SELECT COUNT(*) AS c FROM GENERATE_SERIES(1, 10000)");
        if (got !== '[[10000]]') throw new Error('expected [[10000]] but got ' + got);
        return true;
      });
      t('V57F 200 列の表を作って読み書きできる', () => {
        drop('v57_wide');
        q(`CREATE TABLE v57_wide (${Array.from({ length: 200 }, (_, i) => `c${i} INT`).join(', ')})`);
        q(`INSERT INTO v57_wide VALUES (${Array.from({ length: 200 }, (_, i) => i).join(', ')})`);
        const got = valsOf("SELECT c0, c99, c199 FROM v57_wide");
        drop('v57_wide');
        if (got !== '[[0,99,199]]') throw new Error('expected [[0,99,199]] but got ' + got);
        return true;
      });

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v57_t', 'v57_u', 'v57_s', 'v57_wide');

      return T;
    }
