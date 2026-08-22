    // ============================================================================
    // [Test Suite v59] - 特殊なクエリ構成 (3/4): 句とスコープの相互作用
    //
    //   副問い合わせをどこに置けるか、名前が衝突したときにどちらが見えるか、
    //   句を同時に使ったときに評価の順番が守られるか——といった
    //   「単体では動くが組み合わせると崩れやすい」ところを総当たりする。
    //
    //     A. 副問い合わせの置き場所 × 形（スカラー / IN / EXISTS / 相関）
    //     B. 名前の衝突とスコープ（別名・CTE・派生表・シャドーイング）
    //     C. 句の同時使用（DISTINCT / GROUP BY / HAVING / QUALIFY / ORDER BY / LIMIT）
    //     D. 相関の位置（SELECT / WHERE / HAVING / ORDER BY / JOIN ON）
    //     E. 集合演算と句の相互作用
    //     F. 結合条件の特殊形（定数 / NULL / OR / 不等号 / 関数 / 副問い合わせ）
    //     G. ウィンドウ関数と GROUP BY・QUALIFY の相互作用
    //     H. 受け付けない組み合わせ
    //
    //   test-suite.js の tests 配列へ getV59Tests() のスプレッドで合流する
    // ============================================================================
    function getV59Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, err, same, valsOf, eq, insertRows, drop, cleanup } = makeTestKit('V59');

      // ------------------------------------------------------------
      // 0. フィクスチャ（親 12 行・子 20 行・小さい 4 行）
      // ------------------------------------------------------------
      const P = [], C = [];
      for (let i = 1; i <= 12; i++) {
        P.push([i, ['a', 'b', 'c'][i % 3], (i % 5 === 0) ? null : (i * 7) % 40]);
      }
      for (let i = 1; i <= 20; i++) {
        C.push([i, (i % 13) + 1, (i % 4 === 3) ? null : (i * 11) % 60]);
      }
      t('V59 fixture', () => {
        drop('v59_p', 'v59_c', 'v59_s');
        q("CREATE TABLE v59_p (id INT PRIMARY KEY, g TEXT, v INT)");
        q("CREATE TABLE v59_c (cid INT PRIMARY KEY, id INT, amt INT)");
        q("CREATE TABLE v59_s (id INT PRIMARY KEY, v INT)");
        insertRows('v59_p', P);
        insertRows('v59_c', C);
        insertRows('v59_s', [[1, 10], [2, 20], [3, 30], [4, 40]]);
        return db.tables['v59_p'].rowCount === 12 && db.tables['v59_c'].rowCount === 20;
      });

      // ============================================================
      // A. 副問い合わせの置き場所 × 形
      //    「副問い合わせを使った形」と「使わない素直な形」が一致することを見る
      // ============================================================
      const SUBFORMS = [
        // ラベル, 副問い合わせ, 同じ意味の定数・式
        ['定数', '(SELECT 5)', '5'],
        ['集約', '(SELECT MAX(v) FROM v59_s)', '40'],
        ['1 行 1 列の表から', '(SELECT v FROM v59_s WHERE id = 2)', '20'],
        ['CASE を含む', '(SELECT CASE WHEN COUNT(*) > 0 THEN 5 ELSE 0 END FROM v59_s)', '5'],
        ['入れ子', '(SELECT (SELECT 5))', '5'],
        ['集合演算', '(SELECT 5 UNION SELECT 5)', '5'],
        ['派生表から', '(SELECT MAX(x) FROM (SELECT 5 AS x) d)', '5'],
      ];
      const PLACES = [
        ['SELECT 句', "SELECT id, {E} AS r FROM v59_p ORDER BY id"],
        ['WHERE 句', "SELECT id FROM v59_p WHERE v > {E} ORDER BY id"],
        ['WHERE の左辺', "SELECT id FROM v59_p WHERE {E} < v ORDER BY id"],
        ['HAVING 句', "SELECT g, COUNT(*) AS c FROM v59_p GROUP BY g HAVING COUNT(*) > {E} / 5 ORDER BY g"],
        // 裸の数値は序数と解釈されるので、式にして「並べ替えのキー」として使う
        ['ORDER BY 句', "SELECT id FROM v59_p ORDER BY {E} + id"],
        ['JOIN の ON', "SELECT p.id FROM v59_p p JOIN v59_c c ON c.id = p.id AND c.amt > {E} ORDER BY p.id, c.cid"],
        ['CASE の中', "SELECT id, CASE WHEN v > {E} THEN 1 ELSE 0 END AS r FROM v59_p ORDER BY id"],
        ['関数の引数', "SELECT id, COALESCE(v, {E}) AS r FROM v59_p ORDER BY id"],
        ['算術式の中', "SELECT id, v + {E} AS r FROM v59_p ORDER BY id"],
        ['IN リストの中', "SELECT id FROM v59_p WHERE v IN ({E}, 10, 20) ORDER BY id"],
        ['BETWEEN の境界', "SELECT id FROM v59_p WHERE v BETWEEN {E} AND 40 ORDER BY id"],
        ['集約の引数', "SELECT SUM(v + {E}) AS r FROM v59_p"],
        ['COALESCE の 2 番目', "SELECT id, COALESCE(NULL, {E}) AS r FROM v59_p ORDER BY id"],
        ['CASE の THEN', "SELECT id, CASE WHEN v > 10 THEN {E} ELSE 0 END AS r FROM v59_p ORDER BY id"],
        ['CASE の ELSE', "SELECT id, CASE WHEN v > 10 THEN 0 ELSE {E} END AS r FROM v59_p ORDER BY id"],
        ['GROUP BY した結果の HAVING', "SELECT g, SUM(v) AS s FROM v59_p GROUP BY g HAVING SUM(v) > {E} ORDER BY g"],
        ['ウィンドウのフレーム外の式', "SELECT id, SUM(v) OVER (ORDER BY id) + {E} AS r FROM v59_p ORDER BY id"],
      ];
      PLACES.forEach(([place, tmpl]) => SUBFORMS.forEach(([label, sub, plain]) => {
        same(`V59A ${place}に${label}の副問い合わせ`,
             tmpl.split('{E}').join(plain), tmpl.split('{E}').join(sub));
      }));
      // IN / EXISTS の形（相関あり・なし）
      const SEMI = [
        ['IN 非相関', "SELECT id FROM v59_p WHERE id IN (SELECT id FROM v59_c) ORDER BY id"],
        ['= ANY 非相関', "SELECT id FROM v59_p WHERE id = ANY (SELECT id FROM v59_c) ORDER BY id"],
        ['EXISTS 相関', "SELECT id FROM v59_p p WHERE EXISTS (SELECT 1 FROM v59_c c WHERE c.id = p.id) ORDER BY id"],
        ['COUNT > 0 相関', "SELECT id FROM v59_p p WHERE (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) > 0 ORDER BY id"],
        ['JOIN + DISTINCT', "SELECT DISTINCT p.id FROM v59_p p JOIN v59_c c ON c.id = p.id ORDER BY p.id"],
        ['集約した派生表と結合', "SELECT p.id FROM v59_p p JOIN (SELECT id FROM v59_c GROUP BY id) c ON c.id = p.id ORDER BY p.id"],
        ['IN + 派生表', "SELECT id FROM v59_p WHERE id IN (SELECT id FROM (SELECT id FROM v59_c) x) ORDER BY id"],
        ['IN + CTE', "WITH k AS (SELECT id FROM v59_c) SELECT id FROM v59_p WHERE id IN (SELECT id FROM k) ORDER BY id"],
      ];
      SEMI.forEach(([label, sql], i) => {
        if (i === 0) return;
        same(`V59A 準結合の書き方: ${label}`, SEMI[0][1], sql);
      });
      const ANTI = [
        ['NOT IN', "SELECT id FROM v59_p WHERE id NOT IN (SELECT id FROM v59_c WHERE id IS NOT NULL) ORDER BY id"],
        ['NOT EXISTS', "SELECT id FROM v59_p p WHERE NOT EXISTS (SELECT 1 FROM v59_c c WHERE c.id = p.id) ORDER BY id"],
        ['LEFT JOIN + IS NULL', "SELECT p.id FROM v59_p p LEFT JOIN v59_c c ON c.id = p.id WHERE c.cid IS NULL ORDER BY p.id"],
        ['COUNT = 0', "SELECT id FROM v59_p p WHERE (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) = 0 ORDER BY id"],
        ['EXCEPT', "SELECT id FROM v59_p EXCEPT SELECT id FROM v59_c ORDER BY id"],
      ];
      ANTI.forEach(([label, sql], i) => {
        if (i === 0) return;
        same(`V59A 反結合の書き方: ${label}`, ANTI[0][1], sql);
      });

      // ============================================================
      // B. 名前の衝突とスコープ
      // ============================================================
      const SHADOW = [
        ['列の別名が元の列名と同じ', "SELECT v AS v FROM v59_p ORDER BY id", "SELECT v FROM v59_p ORDER BY id"],
        ['列の別名が他の列名と同じ', "SELECT v AS g FROM v59_p ORDER BY id", "SELECT v FROM v59_p ORDER BY id"],
        ['列の別名が表名と同じ', "SELECT v AS v59_p FROM v59_p ORDER BY id", "SELECT v FROM v59_p ORDER BY id"],
        ['表の別名が他の表名と同じ', "SELECT c.v FROM v59_p c ORDER BY c.id", "SELECT v FROM v59_p ORDER BY id"],
        ['CTE 名が実表と同じ', "WITH v59_s AS (SELECT id, v FROM v59_p) SELECT id, v FROM v59_s ORDER BY id",
         "SELECT id, v FROM v59_p ORDER BY id"],
        ['派生表の別名が実表と同じ', "SELECT v59_s.id, v59_s.v FROM (SELECT id, v FROM v59_p) v59_s ORDER BY v59_s.id",
         "SELECT id, v FROM v59_p ORDER BY id"],
        ['CTE 名を派生表で上書き', "WITH k AS (SELECT 1 AS id) SELECT x.id FROM (SELECT id FROM v59_p) x ORDER BY x.id",
         "SELECT id FROM v59_p ORDER BY id"],
        ['内側と外側で同じ別名', "SELECT p.id FROM v59_p p WHERE EXISTS (SELECT 1 FROM v59_c p2 WHERE p2.id = p.id) ORDER BY p.id",
         "SELECT id FROM v59_p WHERE id IN (SELECT id FROM v59_c) ORDER BY id"],
        ['修飾ありと修飾なしの混在', "SELECT v59_p.id, v FROM v59_p ORDER BY v59_p.id",
         "SELECT id, v FROM v59_p ORDER BY id"],
        ['別名を付けた表の元名は使わない', "SELECT p.id FROM v59_p p ORDER BY p.id", "SELECT id FROM v59_p ORDER BY id"],
      ];
      SHADOW.forEach(([label, variant, base]) => same(`V59B ${label}`, base, variant));
      // 出力名を各句から参照する
      const OUTREF = [
        ['ORDER BY', "SELECT v AS w FROM v59_p ORDER BY w, id", "SELECT v AS w FROM v59_p ORDER BY v, id"],
        ['GROUP BY', "SELECT v AS w, COUNT(*) AS c FROM v59_p GROUP BY w ORDER BY w",
         "SELECT v AS w, COUNT(*) AS c FROM v59_p GROUP BY v ORDER BY v"],
        // GROUP BY した結果は出力名で持つので、HAVING からは別名 w が見える（元の v は見えない）
        ['HAVING', "SELECT v AS w, COUNT(*) AS c FROM v59_p GROUP BY w HAVING w > 10 ORDER BY w",
         "SELECT * FROM (SELECT v AS w, COUNT(*) AS c FROM v59_p GROUP BY v) x WHERE w > 10 ORDER BY w"],
        ['ORDER BY 序数', "SELECT v AS w, id FROM v59_p ORDER BY 1, 2", "SELECT v AS w, id FROM v59_p ORDER BY v, id"],
        ['QUALIFY', "SELECT id, v AS w FROM v59_p QUALIFY ROW_NUMBER() OVER (ORDER BY id) <= 3 ORDER BY id",
         "SELECT id, v AS w FROM v59_p ORDER BY id LIMIT 3"],
      ];
      OUTREF.forEach(([label, variant, base]) => same(`V59B 出力名を ${label} で使う`, base, variant));

      // ============================================================
      // C. 句の同時使用
      // ============================================================
      // 同じ集計を「句の使い方を変えた 6 通り」で書いて一致を見る。
      // グループ列 × 集約 × 絞り込みで総当たりする
      const GCOLS = ["g", "v", "id % 3", "v IS NULL", "COALESCE(g, 'z')"];
      const AGGS = ['COUNT(*)', 'SUM(v)', 'MIN(v)', 'MAX(v)', 'COUNT(DISTINCT v)', 'COUNT(v)', 'MAX(v) - MIN(v)'];
      const FILTERS = ['1 = 1', 'v > 10', 'v IS NOT NULL', "g <> 'a' OR g IS NULL", 'id % 2 = 0'];
      GCOLS.forEach(gc => AGGS.forEach(agg => FILTERS.forEach(f => {
        const label = `${gc} / ${agg} / ${f}`;
        const base = `SELECT ${gc} AS k, ${agg} AS a FROM v59_p WHERE ${f} GROUP BY ${gc} ORDER BY k`;
        same(`V59C 派生表で先に絞る: ${label}`, base,
             `SELECT ${gc} AS k, ${agg} AS a FROM (SELECT * FROM v59_p WHERE ${f}) x GROUP BY ${gc} ORDER BY k`);
        same(`V59C CTE で先に絞る: ${label}`, base,
             `WITH x AS (SELECT * FROM v59_p WHERE ${f}) SELECT ${gc} AS k, ${agg} AS a FROM x GROUP BY ${gc} ORDER BY k`);
        same(`V59C 別名でまとめる: ${label}`, base,
             `SELECT ${gc} AS k, ${agg} AS a FROM v59_p WHERE ${f} GROUP BY k ORDER BY k`);
        same(`V59C 序数でまとめる: ${label}`, base,
             `SELECT ${gc} AS k, ${agg} AS a FROM v59_p WHERE ${f} GROUP BY 1 ORDER BY 1`);
        same(`V59C 外側で並べ替える: ${label}`, base,
             `SELECT * FROM (SELECT ${gc} AS k, ${agg} AS a FROM v59_p WHERE ${f} GROUP BY ${gc}) y ORDER BY k`);
      })));
      // DISTINCT × GROUP BY × HAVING × ORDER BY × LIMIT の同時使用
      const CLAUSE_MIX = [];
      [false, true].forEach(distinct =>
        [false, true].forEach(having =>
          [false, true].forEach(limit =>
            ['g', 'v'].forEach(gc => CLAUSE_MIX.push({ distinct, having, limit, gc })))));
      CLAUSE_MIX.forEach((c, i) => {
        const parts = [`SELECT ${c.distinct ? 'DISTINCT ' : ''}${c.gc} AS k, COUNT(*) AS n`,
                       'FROM v59_p', `GROUP BY ${c.gc}`];
        if (c.having) parts.push('HAVING COUNT(*) >= 2');
        parts.push('ORDER BY k');
        if (c.limit) parts.push('LIMIT 2');
        const base = parts.join(' ');
        same(`V59C 句の組み合わせ #${i} を派生表で包む`, base, `SELECT * FROM (${base}) z`);
        same(`V59C 句の組み合わせ #${i} を CTE で包む`, base, `WITH z AS (${base}) SELECT * FROM z`);
      });

      // ============================================================
      // D. 相関の位置
      // ============================================================
      const CORR = [
        ['SELECT 句', "SELECT p.id, (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) AS n FROM v59_p p ORDER BY p.id",
         "SELECT p.id, COUNT(c.cid) AS n FROM v59_p p LEFT JOIN v59_c c ON c.id = p.id GROUP BY p.id ORDER BY p.id"],
        ['WHERE 句', "SELECT p.id FROM v59_p p WHERE (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) >= 2 ORDER BY p.id",
         "SELECT p.id FROM v59_p p JOIN (SELECT id, COUNT(*) AS n FROM v59_c GROUP BY id) k ON k.id = p.id WHERE k.n >= 2 ORDER BY p.id"],
        ['HAVING 句', "SELECT p.g, COUNT(*) AS c FROM v59_p p GROUP BY p.g HAVING COUNT(*) > (SELECT 1) ORDER BY p.g",
         "SELECT p.g, COUNT(*) AS c FROM v59_p p GROUP BY p.g HAVING COUNT(*) > 1 ORDER BY p.g"],
        ['ORDER BY 句', "SELECT p.id FROM v59_p p ORDER BY (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) DESC, p.id",
         "SELECT k.id FROM (SELECT p.id AS id, (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) AS n FROM v59_p p) k ORDER BY k.n DESC, k.id"],
        ['CASE の中', "SELECT p.id, CASE WHEN (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) > 1 THEN 'many' ELSE 'few' END AS b FROM v59_p p ORDER BY p.id",
         "SELECT k.id, CASE WHEN k.n > 1 THEN 'many' ELSE 'few' END AS b FROM (SELECT p.id AS id, (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) AS n FROM v59_p p) k ORDER BY k.id"],
        ['算術式の中', "SELECT p.id, (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) * 2 AS n2 FROM v59_p p ORDER BY p.id",
         "SELECT k.id, k.n * 2 AS n2 FROM (SELECT p.id AS id, (SELECT COUNT(*) FROM v59_c c WHERE c.id = p.id) AS n FROM v59_p p) k ORDER BY k.id"],
      ];
      CORR.forEach(([label, a, b]) => same(`V59D 相関を ${label} に置く`, b, a));
      // 相関する列を変えて同じことを見る
      ['id', 'g', 'v'].forEach(col => {
        const sql = `SELECT p.id FROM v59_p p WHERE EXISTS (SELECT 1 FROM v59_p x WHERE x.${col} IS NOT DISTINCT FROM p.${col} AND x.id <> p.id) ORDER BY p.id`;
        const alt = `SELECT p.id FROM v59_p p WHERE (SELECT COUNT(*) FROM v59_p x WHERE x.${col} IS NOT DISTINCT FROM p.${col}) > 1 ORDER BY p.id`;
        same(`V59D 相関列 ${col}: EXISTS と COUNT`, alt, sql);
      });

      // ============================================================
      // E. 集合演算と句の相互作用
      // ============================================================
      const S1 = "SELECT id FROM v59_p WHERE v > 20";
      const S2 = "SELECT id FROM v59_p WHERE g = 'a'";
      [
        ['外側の ORDER BY', `${S1} UNION ${S2} ORDER BY id`, `SELECT * FROM (${S1} UNION ${S2}) x ORDER BY id`],
        ['外側の LIMIT', `${S1} UNION ${S2} ORDER BY id LIMIT 3`, `SELECT * FROM (${S1} UNION ${S2}) x ORDER BY id LIMIT 3`],
        ['枝を括弧で包む', `${S1} UNION ${S2} ORDER BY id`, `(${S1}) UNION (${S2}) ORDER BY id`],
        ['枝が派生表', `${S1} UNION ${S2} ORDER BY id`,
         `SELECT * FROM (${S1}) a UNION SELECT * FROM (${S2}) b ORDER BY id`],
        ['枝が CTE', `${S1} UNION ${S2} ORDER BY id`,
         `WITH a AS (${S1}), b AS (${S2}) SELECT * FROM a UNION SELECT * FROM b ORDER BY id`],
        ['UNION ALL + DISTINCT', `${S1} UNION ${S2} ORDER BY id`,
         `SELECT DISTINCT id FROM (${S1} UNION ALL ${S2}) x ORDER BY id`],
        ['枝に DISTINCT', `${S1} UNION ${S2} ORDER BY id`,
         `SELECT DISTINCT id FROM v59_p WHERE v > 20 UNION SELECT DISTINCT id FROM v59_p WHERE g = 'a' ORDER BY id`],
        ['集合演算の結果を集約', `SELECT COUNT(*) AS c FROM (${S1} UNION ${S2}) x`,
         `SELECT COUNT(DISTINCT id) AS c FROM (${S1} UNION ALL ${S2}) y`],
        ['集合演算の結果と結合', `SELECT COUNT(*) AS c FROM (${S1} UNION ${S2}) x JOIN v59_p p ON p.id = x.id`,
         `SELECT COUNT(*) AS c FROM (${S1} UNION ${S2}) x`],
        ['集合演算を IN の中で使う', "SELECT COUNT(*) AS c FROM v59_p WHERE id IN (" + S1 + " UNION " + S2 + ")",
         `SELECT COUNT(*) AS c FROM (${S1} UNION ${S2}) x`],
      ].forEach(([label, base, variant]) => same(`V59E ${label}`, base, variant));

      // ============================================================
      // F. 結合条件の特殊形
      // ============================================================
      const JOINKINDS = ['JOIN', 'LEFT JOIN', 'RIGHT JOIN'];
      const ONCONDS = [
        ['等値', 'c.id = p.id'],
        ['等値 + 定数', 'c.id = p.id AND 1 = 1'],
        ['定数だけ（真）', '1 = 1'],
        ['定数だけ（偽）', '1 = 0'],
        ['不等号', 'c.id < p.id'],
        ['OR で 2 条件', 'c.id = p.id OR c.id = p.id + 1'],
        ['関数を挟む', 'ABS(c.id) = ABS(p.id)'],
        ['NULL 安全比較', 'c.id IS NOT DISTINCT FROM p.id'],
        ['副問い合わせを含む', 'c.id = p.id AND c.amt > (SELECT 0)'],
        ['CASE を含む', "c.id = p.id AND CASE WHEN c.amt IS NULL THEN 0 ELSE 1 END = 1"],
      ];
      JOINKINDS.forEach(kind => ONCONDS.forEach(([label, cond]) => {
        // 行数だけを見る（結合の意味が変わらないことの確認は行数で足りる）
        t(`V59F ${kind} の ON が ${label}`, () => {
          const got = valsOf(`SELECT COUNT(*) AS c FROM v59_p p ${kind} v59_c c ON ${cond}`);
          const alt = valsOf(`SELECT COUNT(*) AS c FROM (SELECT p.id AS pid, c.cid AS ccid FROM v59_p p ${kind} v59_c c ON ${cond}) x`);
          return eq(got, alt, `${kind} / ${cond}`);
        });
      }));
      // ON と WHERE の違い（内部結合では同じ・外部結合では違う）
      ONCONDS.forEach(([label, cond]) => {
        same(`V59F 内部結合は ON と WHERE が同じ: ${label}`,
             `SELECT COUNT(*) AS c FROM v59_p p JOIN v59_c c ON ${cond}`,
             `SELECT COUNT(*) AS c FROM v59_p p, v59_c c WHERE ${cond}`);
      });

      // ============================================================
      // G. ウィンドウ関数と GROUP BY・QUALIFY の相互作用
      // ============================================================
      [
        ['GROUP BY の結果に窓', "SELECT g, COUNT(*) AS c, SUM(COUNT(*)) OVER () AS total FROM v59_p GROUP BY g ORDER BY g",
         "SELECT g, COUNT(*) AS c, (SELECT COUNT(*) FROM v59_p) AS total FROM v59_p GROUP BY g ORDER BY g"],
        ['GROUP BY の結果に順位', "SELECT g, COUNT(*) AS c, RANK() OVER (ORDER BY COUNT(*) DESC) AS rk FROM v59_p GROUP BY g ORDER BY g",
         "SELECT k.g, k.c, RANK() OVER (ORDER BY k.c DESC) AS rk FROM (SELECT g, COUNT(*) AS c FROM v59_p GROUP BY g) k ORDER BY k.g"],
        ['QUALIFY と派生表 + WHERE', "SELECT id FROM v59_p QUALIFY ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) = 1 ORDER BY id",
         "SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) AS rn FROM v59_p) x WHERE rn = 1 ORDER BY id"],
        ['窓 + DISTINCT', "SELECT DISTINCT g, COUNT(*) OVER (PARTITION BY g) AS c FROM v59_p ORDER BY g",
         "SELECT g, COUNT(*) AS c FROM v59_p GROUP BY g ORDER BY g"],
        ['窓 + ORDER BY + LIMIT', "SELECT id, ROW_NUMBER() OVER (ORDER BY v DESC NULLS LAST, id) AS rn FROM v59_p ORDER BY rn LIMIT 3",
         "SELECT id, ROW_NUMBER() OVER (ORDER BY v DESC NULLS LAST, id) AS rn FROM v59_p ORDER BY v DESC NULLS LAST, id LIMIT 3"],
        ['窓を 2 段重ねる', "SELECT id, SUM(rn) OVER () AS s FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM v59_p) x ORDER BY id",
         "SELECT id, (SELECT COUNT(*) * (COUNT(*) + 1) / 2 FROM v59_p) AS s FROM v59_p ORDER BY id"],
        ['窓の中で集約を使う', "SELECT g, SUM(SUM(v)) OVER (ORDER BY g) AS running FROM v59_p GROUP BY g ORDER BY g",
         "SELECT k.g, SUM(k.s) OVER (ORDER BY k.g) AS running FROM (SELECT g, SUM(v) AS s FROM v59_p GROUP BY g) k ORDER BY k.g"],
      ].forEach(([label, a, b]) => same(`V59G ${label}`, b, a));

      // ============================================================
      // H. 受け付けない組み合わせ
      // ============================================================
      err('V59H WHERE では列の別名を使えない',
          "SELECT v AS w FROM v59_p WHERE w > 10", 'not found');
      err('V59H WHERE に集約は書けない',
          "SELECT id FROM v59_p WHERE COUNT(*) > 1", '');
      err('V59H 相関副問い合わせの入れ子は非対応',
          "SELECT id FROM v59_p p WHERE EXISTS (SELECT 1 FROM v59_c c WHERE c.id = p.id "
          + "AND EXISTS (SELECT 1 FROM v59_s s WHERE s.id = c.cid))", 'nested correlated');
      err('V59H GROUP BY に副問い合わせは書けない',
          "SELECT COUNT(*) AS c FROM v59_p GROUP BY (SELECT 1)", '');
      err('V59H 集約の入れ子は書けない',
          "SELECT SUM(COUNT(*)) AS c FROM v59_p", '');
      err('V59H FROM に相関副問い合わせは置けない',
          "SELECT p.id FROM v59_p p, (SELECT * FROM v59_c c WHERE c.id = p.id) x", '');

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v59_p', 'v59_c', 'v59_s');

      return T;
    }
