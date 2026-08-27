    // ============================================================================
    // [Test Suite v71] - 全文検索の転置索引
    //
    //   MATCH ... AGAINST は行ごとに本文を語へ切って走査する関数で、索引が無く
    //   表の大きさに正比例していた（4 万行で毎回 65ms）。CREATE FULLTEXT INDEX を
    //   受け付け、語 -> 行の対応から候補を絞るようにした（作成済みなら 7.2ms）。
    //
    //   索引は候補を絞る網としてだけ使い、一致の判定は MATCH 式そのもので行う。
    //   だから見るべきは「索引の有無で答えが変わらないこと」— 索引側が 1 行でも
    //   取りこぼすと、検索結果から黙って行が消える。
    //
    //     A. 索引の有無で答えが一致する（語・句・前方一致・ブール演算子）
    //     B. 候補を作れない問い合わせは全表走査へ落とす
    //     C. 索引の DDL（重複・IF NOT EXISTS・存在しない列）
    //     D. データを変えたら索引も追随する
    //     E. 語の切り方が照合側と一致している
    //
    //   test-suite.js の tests 配列へ getV71Tests() のスプレッドで合流する
    // ============================================================================
    function getV71Tests() {
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V71');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      //    同じ中身を 2 つの表に入れ、片方にだけ索引を張って突き合わせる
      // ------------------------------------------------------------
      const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
      const ROWS = [];
      for (let i = 1; i <= 300; i++) {
        const a = W[i % 8], b = W[(i * 3) % 8], c = W[(i * 5) % 8];
        ROWS.push([
          i,
          `${a} ${b}`,
          (i % 17 === 0) ? null : `${c} note ${i % 23} tail`
        ]);
      }
      t('V71 fixture', () => {
        drop('v71_idx', 'v71_raw');
        q("CREATE TABLE v71_idx (id INT PRIMARY KEY, title TEXT, body TEXT)");
        q("CREATE TABLE v71_raw (id INT PRIMARY KEY, title TEXT, body TEXT)");
        insertRows('v71_idx', ROWS);
        insertRows('v71_raw', ROWS);
        q("CREATE FULLTEXT INDEX v71_ft ON v71_idx(title, body)");
        return db.tables['v71_idx'].rowCount === 300 && db.tables['v71_raw'].rowCount === 300;
      });

      // ============================================================
      // A. 索引の有無で答えが一致する
      // ============================================================
      const QUERIES = [
        // 自然文モード
        ["'alpha'", ''],
        ["'hotel'", ''],
        ["'alpha bravo'", ''],
        ["'note'", ''],
        ["'tail'", ''],
        ["'zzznotpresent'", ''],
        ["'alpha zzznotpresent'", ''],
        ["'7'", ''],
        // ブールモード
        ["'+alpha'", ' IN BOOLEAN MODE'],
        ["'+alpha +bravo'", ' IN BOOLEAN MODE'],
        ["'+alpha -bravo'", ' IN BOOLEAN MODE'],
        ["'alpha bravo'", ' IN BOOLEAN MODE'],
        ["'+note +tail'", ' IN BOOLEAN MODE'],
        ["'+alpha +zzznotpresent'", ' IN BOOLEAN MODE'],
        // 句
        ['\'"alpha bravo"\'', ' IN BOOLEAN MODE'],
        ['\'"bravo alpha"\'', ' IN BOOLEAN MODE'],
        ['\'"note 7"\'', ' IN BOOLEAN MODE'],
        // 前方一致
        ["'alph*'", ' IN BOOLEAN MODE'],
        ["'ho*'", ' IN BOOLEAN MODE'],
        ["'zzz*'", ' IN BOOLEAN MODE'],
        ["'+alph* +brav*'", ' IN BOOLEAN MODE'],
        // 自然言語モードの明示
        ["'alpha'", ' IN NATURAL LANGUAGE MODE']
      ];

      QUERIES.forEach(([qs, mode]) => {
        t(`A MATCH AGAINST (${qs}${mode})`, () => {
          const idx = valsOf(`SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST (${qs}${mode}) ORDER BY id`);
          const raw = valsOf(`SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST (${qs}${mode}) ORDER BY id`);
          return eq(idx, raw, '索引あり / 索引なし');
        });
      });

      // スコア（MATCH を選択リストに書く形）も一致すること
      t('A スコアも一致する', () => {
        const idx = valsOf("SELECT id, MATCH(title, body) AGAINST ('alpha bravo') AS sc FROM v71_idx ORDER BY id");
        const raw = valsOf("SELECT id, MATCH(title, body) AGAINST ('alpha bravo') AS sc FROM v71_raw ORDER BY id");
        return eq(idx, raw, 'スコア');
      });

      t('A 他の条件と併用しても一致する', () => {
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha') AND id < 100 ORDER BY id");
        const raw = valsOf("SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST ('alpha') AND id < 100 ORDER BY id");
        return eq(idx, raw, 'MATCH + 範囲');
      });

      t('A 集計と併用しても一致する', () => {
        const idx = valsOf("SELECT COUNT(*) AS c FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha')");
        const raw = valsOf("SELECT COUNT(*) AS c FROM v71_raw WHERE MATCH(title, body) AGAINST ('alpha')");
        return eq(idx, raw, '件数');
      });

      t('A NULL の本文があっても取りこぼさない', () => {
        // body が NULL の行（i % 17 === 0）でも title だけで一致する
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha') AND body IS NULL ORDER BY id");
        const raw = valsOf("SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST ('alpha') AND body IS NULL ORDER BY id");
        return eq(idx, raw, 'NULL 本文');
      });

      // ============================================================
      // B. 候補を作れない問い合わせは全表走査
      // ============================================================
      const planOf = (sql) => q(sql).data.map(r => r.Operation);

      t('B 語があれば転置索引を使う', () =>
        eq(planOf("EXPLAIN SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha')")
            .includes('FULLTEXT INDEX SCAN'), true, '計画'));

      t('B 除外だけの問い合わせは全表走査', () =>
        eq(planOf("EXPLAIN SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('-alpha' IN BOOLEAN MODE)")
            .includes('TABLE SCAN'), true, '正の語が無いので候補を作れない'));

      t('B 除外だけでも答えは一致する', () => {
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('-alpha' IN BOOLEAN MODE) ORDER BY id");
        const raw = valsOf("SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST ('-alpha' IN BOOLEAN MODE) ORDER BY id");
        return eq(idx, raw, '除外のみ');
      });

      t('B 索引の無い表は全表走査', () =>
        eq(planOf("EXPLAIN SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST ('alpha')")
            .includes('TABLE SCAN'), true, '計画'));

      t('B 列の組み合わせが違えば使わない', () => {
        // 索引は (title, body)。title だけの MATCH には使わない（MySQL と同じ規則）
        const ops = planOf("EXPLAIN SELECT id FROM v71_idx WHERE MATCH(title) AGAINST ('alpha')");
        return eq(ops.includes('FULLTEXT INDEX SCAN'), false, '列が一致しない索引は使わない');
      });

      t('B 列の組み合わせが違っても答えは正しい', () => {
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title) AGAINST ('alpha') ORDER BY id");
        const raw = valsOf("SELECT id FROM v71_raw WHERE MATCH(title) AGAINST ('alpha') ORDER BY id");
        return eq(idx, raw, 'title だけの MATCH');
      });

      // ============================================================
      // C. DDL
      // ============================================================
      t('C 索引が登録されている', () => {
        const ft = db.tables['v71_idx'].ftIndexes;
        return eq(Object.keys(ft), ['v71_ft'], '登録名') && eq(ft['v71_ft'].cols, ['title', 'body'], '対象列');
      });

      err('C 同じ名前は作れない', "CREATE FULLTEXT INDEX v71_ft ON v71_idx(title)", 'already exists');

      t('C IF NOT EXISTS なら黙って成功', () => {
        const r = q("CREATE FULLTEXT INDEX IF NOT EXISTS v71_ft ON v71_idx(title)");
        return eq(/Skipped/.test(r.data[0].Message), true, r.data[0].Message);
      });

      err('C 存在しない列は断る', "CREATE FULLTEXT INDEX v71_bad ON v71_idx(nope)", "not found");

      err('C 存在しない表は断る', "CREATE FULLTEXT INDEX v71_bad2 ON v71_nosuch(title)", 'v71_nosuch');

      err('C 構文が違えば案内を出す', "CREATE FULLTEXT INDEX v71_bad3 ON v71_idx", 'CREATE FULLTEXT INDEX');

      // ============================================================
      // D. データを変えたら索引も追随する
      // ============================================================
      t('D INSERT した行が検索に出る', () => {
        q("INSERT INTO v71_idx VALUES (1001, 'zulu yankee', 'fresh row')");
        q("INSERT INTO v71_raw VALUES (1001, 'zulu yankee', 'fresh row')");
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('zulu') ORDER BY id");
        const raw = valsOf("SELECT id FROM v71_raw WHERE MATCH(title, body) AGAINST ('zulu') ORDER BY id");
        return eq(idx, raw, '追加後') && eq(idx, '[[1001]]', '新しい行が出る');
      });

      t('D UPDATE した語が検索に反映される', () => {
        q("UPDATE v71_idx SET title = 'whiskey' WHERE id = 1001");
        q("UPDATE v71_raw SET title = 'whiskey' WHERE id = 1001");
        const gone = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('zulu') ORDER BY id");
        const found = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('whiskey') ORDER BY id");
        return eq(gone, '[]', '古い語では出ない') && eq(found, '[[1001]]', '新しい語で出る');
      });

      t('D DELETE した行が検索から消える', () => {
        q("DELETE FROM v71_idx WHERE id = 1001");
        q("DELETE FROM v71_raw WHERE id = 1001");
        const idx = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('whiskey') ORDER BY id");
        return eq(idx, '[]', '削除後');
      });

      t('D ROLLBACK すると検索結果も戻る', () => {
        const before = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha') ORDER BY id");
        q("BEGIN");
        q("INSERT INTO v71_idx VALUES (2002, 'alpha inserted', 'x')");
        const during = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha') ORDER BY id");
        q("ROLLBACK");
        const after = valsOf("SELECT id FROM v71_idx WHERE MATCH(title, body) AGAINST ('alpha') ORDER BY id");
        if (during === before) throw new Error('トランザクション中の追加が見えていない');
        return eq(after, before, 'ROLLBACK 後');
      });

      // ============================================================
      // E. 語の切り方が照合側と一致している
      //    索引側と照合側で語の切り方が違うと、索引経路だけ取りこぼす
      // ============================================================
      t('E 記号・大小・全角の扱いが一致する', () => {
        drop('v71_tok');
        q("CREATE TABLE v71_tok (id INT PRIMARY KEY, s TEXT)");
        insertRows('v71_tok', [
          [1, 'Hello, World!'],
          [2, 'UPPER lower MiXeD'],
          [3, 'snake_case value'],
          [4, 'hyphen-separated words'],
          [5, '日本語 の 文字'],
          [6, 'number42 and 42number']
        ]);
        q("CREATE FULLTEXT INDEX v71_ft_tok ON v71_tok(s)");
        const probes = ['hello', 'world', 'upper', 'mixed', 'snake_case', 'hyphen', 'separated', '日本語', '文字', 'number42', '42number'];
        for (const w of probes) {
          const withIdx = valsOf(`SELECT id FROM v71_tok WHERE MATCH(s) AGAINST ('${w}') ORDER BY id`);
          // 索引を消して同じ問い合わせを引き直す
          const tb = db.tables['v71_tok'];
          const saved = tb.ftIndexes;
          tb.ftIndexes = Object.create(null);
          const without = valsOf(`SELECT id FROM v71_tok WHERE MATCH(s) AGAINST ('${w}') ORDER BY id`);
          tb.ftIndexes = saved;
          if (withIdx !== without) {
            throw new Error(`語 '${w}' で索引の有無が食い違う: ${withIdx} vs ${without}`);
          }
        }
        q("DROP TABLE v71_tok");
        return true;
      });

      // ============================================================
      // F. 相関 EXISTS の非相関化
      //    内側が「1 表の等価 1 本」なら、値ごとに問い合わせを回さず
      //    その列の値の集合で所属を見る（索引の無い列で 4.8 秒 -> 4.4ms）。
      //    `AND 1=1` を足すと形が崩れて従来経路に落ちるので、突き合わせの基準に使う
      // ============================================================
      t('F fixture', () => {
        drop('v71_in', 'v71_out');
        q("CREATE TABLE v71_in (id INT PRIMARY KEY, g ANY, coll TEXT COLLATE NOCASE)");
        insertRows('v71_in', [[1, 5, 'AAA'], [2, '7', 'bbb'], [3, null, 'CCC'],
                              [4, 1, 'ddd'], [5, true, 'eee'], [6, 'x', 'fff']]);
        q("CREATE TABLE v71_out (id INT PRIMARY KEY, k ANY, c TEXT)");
        insertRows('v71_out', [[1, 5, 'aaa'], [2, 7, 'BBB'], [3, null, 'ccc'], [4, '1', 'DDD'],
                               [5, '5', 'eee'], [6, 'zz', 'ggg'], [7, 0, 'hhh'], [8, 'x', 'fff']]);
        q("CREATE TABLE v71_empty (id INT, g INT)");
        return db.tables['v71_in'].rowCount === 6 && db.tables['v71_out'].rowCount === 8;
      });

      const CORR = [
        ['素の EXISTS',        'EXISTS (SELECT 1 FROM v71_in WHERE v71_in.g = o.k)'],
        ['別名つき',            'EXISTS (SELECT 1 FROM v71_in i WHERE i.g = o.k)'],
        ['NOT EXISTS',         'NOT EXISTS (SELECT 1 FROM v71_in WHERE v71_in.g = o.k)'],
        ['SELECT *',           'EXISTS (SELECT * FROM v71_in WHERE v71_in.g = o.k)'],
        ['照合順序つきの列',    'EXISTS (SELECT 1 FROM v71_in WHERE v71_in.coll = o.c)'],
        ['空の内側',            'EXISTS (SELECT 1 FROM v71_empty WHERE v71_empty.g = o.k)']
      ];
      CORR.forEach(([label, pred]) => {
        t(`F ${label}`, () => {
          // AND 1=1 を足した形は非相関化されない（従来どおり値ごとに実行する）
          const ref = pred.replace(/\)$/, ' AND 1=1)');
          const fast = valsOf(`SELECT id FROM v71_out o WHERE ${pred} ORDER BY id`);
          const slow = valsOf(`SELECT id FROM v71_out o WHERE ${ref} ORDER BY id`);
          return eq(fast, slow, '非相関化あり / なし');
        });
      });

      t('F 型を寄せた一致も拾う', () => {
        // 外側 7（数値）が内側 '7'（文字列）に、外側 '1' が内側 1 に一致する
        const d = q("SELECT id FROM v71_out o WHERE EXISTS (SELECT 1 FROM v71_in WHERE v71_in.g = o.k) ORDER BY id").data.map(r => r.id);
        return eq(d, [1, 2, 4, 5, 8], '寄せた一致を含む');
      });

      t('F NULL の相関値は一致しない', () => {
        const d = q("SELECT id FROM v71_out o WHERE EXISTS (SELECT 1 FROM v71_in WHERE v71_in.g = o.k) AND o.k IS NULL").data;
        return eq(d.length, 0, 'NULL = NULL は真にならない');
      });

      t('F 内側を変えたら結果も変わる', () => {
        q("INSERT INTO v71_in VALUES (7, 'zz', 'ggg')");
        const d = q("SELECT id FROM v71_out o WHERE EXISTS (SELECT 1 FROM v71_in WHERE v71_in.g = o.k) ORDER BY id").data.map(r => r.id);
        q("DELETE FROM v71_in WHERE id = 7");
        return eq(d.includes(6), true, "'zz' が一致するようになる");
      });

      cleanup('v71_idx', 'v71_raw', 'v71_in', 'v71_out', 'v71_empty');
      return T;
    }
