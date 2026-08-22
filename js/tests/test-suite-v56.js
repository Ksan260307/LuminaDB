    // ============================================================================
    // [Test Suite v56] - 書き味 (補遺): 実務の整形スタイルと総合シナリオ
    //
    //   受注・顧客・明細の 3 表に対する「実務でありそうな」クエリ 40 本を土台に、
    //   整形ツールが出す体裁（先頭カンマ・キーワード行頭揃え・インデント）や、
    //   空白 1 個ずつを改行／コメントへ差し替える総当たりを掛ける。
    //
    //     A. クエリ全体に効く整形スタイル
    //     B. 空白 1 個ずつを改行へ差し替える総当たり
    //     C. 空白 1 個ずつをブロックコメントへ差し替える総当たり
    //     D. 整形ツール風の体裁（先頭カンマ・句ごとの改行・インデント）
    //     E. メタ照会（SHOW / DESCRIBE / EXPLAIN / INFORMATION_SCHEMA）の書き味
    //     F. 同じ集計を別の組み立て方で書く（総合）
    //
    //   test-suite.js の tests 配列へ getV56Tests() のスプレッドで合流する
    // ============================================================================
    function getV56Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, rowsOf, valsOf, outside, upper, lower, alternating, spaced,
              wsPos, swap, tag: tag46, insertRows, drop, cleanup } = makeTestKit('V56');
      const tag = (s) => tag46(s, 44);

      // ------------------------------------------------------------
      // 0. フィクスチャ（顧客 12 / 受注 40 / 明細 60）
      // ------------------------------------------------------------
      t('V56 fixture', () => {
        drop('v56_ord', 'v56_cust', 'v56_item');
        q("CREATE TABLE v56_cust (cid INT PRIMARY KEY, cname TEXT, region TEXT, tier TEXT)");
        q("CREATE TABLE v56_ord (oid INT PRIMARY KEY, cid INT, odate DATE, amt INT, status TEXT)");
        q("CREATE TABLE v56_item (iid INT PRIMARY KEY, oid INT, sku TEXT, qty INT, price INT)");
        const regions = ['east', 'west', 'north'];
        const tiers = ['gold', 'silver', 'bronze'];
        const cust = [], ord = [], item = [];
        for (let i = 1; i <= 12; i++) cust.push([i, 'C' + i, regions[i % 3], tiers[i % 3]]);
        for (let i = 1; i <= 40; i++) {
          ord.push([i, (i % 12) + 1, `202${(i % 3) + 1}-0${(i % 9) + 1}-1${i % 10}`,
                    (i % 10 === 0) ? null : ((i * 37) % 500) + 50, ['open', 'paid', 'void'][i % 3]]);
        }
        for (let i = 1; i <= 60; i++) {
          item.push([i, (i % 40) + 1, 'S' + (i % 7), (i % 5) + 1, ((i * 13) % 90) + 10]);
        }
        insertRows('v56_cust', cust);
        insertRows('v56_ord', ord);
        insertRows('v56_item', item);
        return db.tables['v56_cust'].rowCount === 12 && db.tables['v56_ord'].rowCount === 40
          && db.tables['v56_item'].rowCount === 60;
      });

      // ------------------------------------------------------------
      // 土台のクエリ（実務でありそうな 40 本。すべて 1 行・結果は決定的）
      // ------------------------------------------------------------
      const CORPUS = [
        "WITH paid AS (SELECT * FROM v56_ord WHERE status = 'paid') SELECT c.region, COUNT(*) AS n, SUM(p.amt) AS total FROM paid p JOIN v56_cust c ON c.cid = p.cid GROUP BY c.region ORDER BY c.region",
        "SELECT c.cname, o.oid, o.amt, RANK() OVER (PARTITION BY o.cid ORDER BY o.amt DESC NULLS LAST, o.oid) AS rk FROM v56_ord o JOIN v56_cust c ON c.cid = o.cid ORDER BY o.oid",
        "SELECT o.oid, SUM(i.qty * i.price) AS gross FROM v56_ord o JOIN v56_item i ON i.oid = o.oid GROUP BY o.oid HAVING SUM(i.qty * i.price) > 500 ORDER BY o.oid",
        "SELECT c.tier, COUNT(DISTINCT o.cid) AS custs, ROUND(AVG(o.amt), 2) AS avg_amt FROM v56_cust c LEFT JOIN v56_ord o ON o.cid = c.cid GROUP BY c.tier ORDER BY c.tier",
        "WITH m AS (SELECT cid, SUM(amt) AS s FROM v56_ord GROUP BY cid), r AS (SELECT cid, s, ROW_NUMBER() OVER (ORDER BY s DESC NULLS LAST, cid) AS rn FROM m) SELECT cid, s FROM r WHERE rn <= 5 ORDER BY rn",
        "SELECT region, tier, COUNT(*) AS n FROM v56_cust GROUP BY ROLLUP(region, tier) ORDER BY region, tier",
        "SELECT o.oid, o.amt, o.amt - LAG(o.amt) OVER (ORDER BY o.oid) AS diff FROM v56_ord o WHERE o.amt IS NOT NULL ORDER BY o.oid",
        "SELECT c.cid, c.cname FROM v56_cust c WHERE EXISTS (SELECT 1 FROM v56_ord o WHERE o.cid = c.cid AND o.amt > 400) ORDER BY c.cid",
        "SELECT c.cid, (SELECT COUNT(*) FROM v56_ord o WHERE o.cid = c.cid) AS n, (SELECT MAX(amt) FROM v56_ord o WHERE o.cid = c.cid) AS mx FROM v56_cust c ORDER BY c.cid",
        "SELECT sku, SUM(qty) AS q, SUM(qty * price) AS v FROM v56_item GROUP BY sku ORDER BY v DESC, sku",
        "SELECT o.status, COUNT(*) FILTER (WHERE o.amt > 200) AS big, COUNT(*) AS all_n FROM v56_ord o GROUP BY o.status ORDER BY o.status",
        "SELECT YEAR(odate) AS y, MONTH(odate) AS m, SUM(amt) AS s FROM v56_ord GROUP BY YEAR(odate), MONTH(odate) ORDER BY y, m",
        "SELECT c.region, GROUP_CONCAT(c.cname ORDER BY c.cid SEPARATOR ', ') AS names FROM v56_cust c GROUP BY c.region ORDER BY c.region",
        "SELECT o.oid FROM v56_ord o WHERE o.amt > (SELECT AVG(amt) FROM v56_ord) ORDER BY o.oid",
        "SELECT o.cid, SUM(o.amt) AS s FROM v56_ord o WHERE o.status <> 'void' GROUP BY o.cid HAVING SUM(o.amt) > 300 ORDER BY s DESC, o.cid",
        "SELECT i.sku, i.qty, i.price, SUM(i.qty * i.price) OVER (PARTITION BY i.sku ORDER BY i.iid ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run FROM v56_item i ORDER BY i.iid",
        "SELECT c.cname, o.oid FROM v56_cust c LEFT JOIN v56_ord o ON o.cid = c.cid AND o.status = 'paid' ORDER BY c.cid, o.oid",
        "SELECT * FROM (SELECT cid, SUM(amt) AS s FROM v56_ord GROUP BY cid) t WHERE t.s IS NOT NULL AND t.s > 200 ORDER BY t.cid",
        "SELECT cid FROM v56_ord WHERE status = 'paid' INTERSECT SELECT cid FROM v56_ord WHERE amt > 300 ORDER BY cid",
        "SELECT cid FROM v56_ord EXCEPT SELECT cid FROM v56_ord WHERE amt IS NULL ORDER BY cid",
        "SELECT o.oid, CASE WHEN o.amt IS NULL THEN 'unknown' WHEN o.amt > 400 THEN 'large' WHEN o.amt > 200 THEN 'medium' ELSE 'small' END AS band FROM v56_ord o ORDER BY o.oid",
        "SELECT c.region, COUNT(*) AS n FROM v56_cust c WHERE c.tier IN ('gold', 'silver') GROUP BY c.region ORDER BY n DESC, c.region",
        "SELECT o.oid, o.amt, NTILE(4) OVER (ORDER BY o.amt DESC NULLS LAST, o.oid) AS quartile FROM v56_ord o ORDER BY o.oid",
        "SELECT i.oid, COUNT(*) AS lines, MIN(i.price) AS lo, MAX(i.price) AS hi FROM v56_item i GROUP BY i.oid ORDER BY i.oid LIMIT 10 OFFSET 5",
        "WITH t AS (SELECT o.cid, o.amt, ROW_NUMBER() OVER (PARTITION BY o.cid ORDER BY o.amt DESC NULLS LAST, o.oid) AS rn FROM v56_ord o) SELECT cid, amt FROM t WHERE rn = 1 ORDER BY cid",
        "SELECT c.cid, c.cname, COALESCE(SUM(o.amt), 0) AS total FROM v56_cust c LEFT JOIN v56_ord o ON o.cid = c.cid GROUP BY c.cid, c.cname ORDER BY c.cid",
        "SELECT o.oid, o.cid, c.tier, i.sku FROM v56_ord o JOIN v56_cust c ON c.cid = o.cid JOIN v56_item i ON i.oid = o.oid WHERE c.tier = 'gold' ORDER BY o.oid, i.iid LIMIT 20",
        "SELECT region, tier, COUNT(*) AS n FROM v56_cust GROUP BY GROUPING SETS ((region), (tier), ()) ORDER BY region, tier",
        "SELECT o.status, SUM(o.amt) AS s, SUM(SUM(o.amt)) OVER () AS grand FROM v56_ord o GROUP BY o.status ORDER BY o.status",
        "SELECT DISTINCT c.region FROM v56_cust c JOIN v56_ord o ON o.cid = c.cid WHERE o.amt > 300 ORDER BY c.region",
        "SELECT o.oid, o.amt FROM v56_ord o QUALIFY ROW_NUMBER() OVER (PARTITION BY o.status ORDER BY o.oid) <= 3 ORDER BY o.oid",
        "SELECT c.cname, o.odate, o.amt FROM v56_cust c JOIN v56_ord o ON o.cid = c.cid WHERE o.odate BETWEEN '2021-01-01' AND '2022-12-31' ORDER BY o.oid",
        "SELECT i.sku, ROUND(SUM(i.qty * i.price) * 100.0 / (SELECT SUM(qty * price) FROM v56_item), 2) AS pct FROM v56_item i GROUP BY i.sku ORDER BY i.sku",
        "SELECT o.cid, COUNT(*) AS n FROM v56_ord o GROUP BY o.cid HAVING COUNT(*) >= 3 AND SUM(COALESCE(o.amt, 0)) > 100 ORDER BY o.cid",
        "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 10) SELECT n FROM nums ORDER BY n",
        "SELECT c.tier, c.region, COUNT(*) AS n, RANK() OVER (PARTITION BY c.tier ORDER BY COUNT(*) DESC) AS rk FROM v56_cust c GROUP BY c.tier, c.region ORDER BY c.tier, c.region",
        "SELECT o.oid, o.amt, AVG(o.amt) OVER (ORDER BY o.oid ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS mv FROM v56_ord o ORDER BY o.oid",
        "SELECT * FROM v56_cust c WHERE c.cid IN (SELECT o.cid FROM v56_ord o GROUP BY o.cid HAVING SUM(o.amt) > 400) ORDER BY c.cid",
        "SELECT o.status, o.cid, SUM(o.amt) AS s FROM v56_ord o GROUP BY o.status, o.cid ORDER BY o.status, s DESC NULLS LAST, o.cid",
        "SELECT c.region, SUM(CASE WHEN o.status = 'paid' THEN o.amt ELSE 0 END) AS paid_amt, SUM(CASE WHEN o.status = 'open' THEN o.amt ELSE 0 END) AS open_amt FROM v56_cust c JOIN v56_ord o ON o.cid = c.cid GROUP BY c.region ORDER BY c.region",
      ];

      // ============================================================
      // A. クエリ全体に効く整形スタイル
      // ============================================================
      const STYLES = [
        ['大文字', upper],
        ['小文字', lower],
        ['交互の大小', alternating],
        ['すべて改行', s => spaced(s, '\n')],
        ['すべてタブ', s => spaced(s, '\t')],
        ['空白 3 個', s => spaced(s, '   ')],
        ['CRLF', s => spaced(s, '\r\n')],
        ['前後に空行とセミコロン', s => '\n\n  ' + s + '  ;\n'],
        ['見出しコメント付き', s => '-- 集計クエリ\n/* 何をするか */\n' + s],
        ['行末コメント付き', s => s + ' -- ここまで'],
      ];
      CORPUS.forEach((base, qi) => STYLES.forEach(([label, f]) => {
        same(`V56A q${qi} ${label}: ${tag(base)}`, base, f(base));
      }));

      // ============================================================
      // B・C. 空白 1 個ずつの置き換え
      // ============================================================
      CORPUS.forEach((base, qi) => {
        wsPos(base).forEach(i => {
          same(`V56B q${qi} 改行 @${i}: ${tag(base)}`, base, swap(base, i, '\n'));
          same(`V56C q${qi} コメント @${i}: ${tag(base)}`, base, swap(base, i, ' /*c*/ '));
        });
      });

      // ============================================================
      // D. 整形ツール風の体裁
      // ============================================================
      const KW = ['FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
                  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'QUALIFY'];
      const FORMATS = [
        ['先頭カンマ', s => outside(s, x => x.split(', ').join('\n  , '))],
        ['句の前で改行', s => outside(s, x => {
          let r = x;
          KW.forEach(k => { r = r.split(' ' + k + ' ').join('\n' + k + ' '); });
          return r;
        })],
        ['句の前で改行 + 先頭カンマ', s => outside(s, x => {
          let r = x.split(', ').join('\n  , ');
          KW.forEach(k => { r = r.split(' ' + k + ' ').join('\n' + k + ' '); });
          return r;
        })],
        ['全体をインデント', s => outside(s, x => '    ' + x.split(' ').join('\n    '))],
        ['句の前で改行 + コメント', s => outside(s, x => {
          let r = x;
          KW.forEach(k => { r = r.split(' ' + k + ' ').join('  -- 次の句\n' + k + ' '); });
          return r;
        })],
      ];
      CORPUS.forEach((base, qi) => FORMATS.forEach(([label, f]) => {
        same(`V56D q${qi} ${label}: ${tag(base)}`, base, f(base));
      }));

      // ============================================================
      // E. メタ照会の書き味
      // ============================================================
      const metaSame = (name, a, b) => t(name, () => {
        const x = valsOf(a), y = valsOf(b);
        if (x !== y) throw new Error(`expected ${y.slice(0, 160)} but got ${x.slice(0, 160)} :: ${a}`);
        return true;
      });
      [
        ['SHOW TABLES の大小', 'SHOW TABLES', 'show tables'],
        ['SHOW TABLES の空白', 'SHOW TABLES', 'SHOW   TABLES'],
        ['SHOW TABLES のセミコロン', 'SHOW TABLES', 'SHOW TABLES;'],
        ['DESCRIBE と DESC', 'DESCRIBE v56_ord', 'DESC v56_ord'],
        ['DESCRIBE の大小', 'DESCRIBE v56_ord', 'describe v56_ord'],
        ['DESCRIBE と SHOW COLUMNS', 'DESCRIBE v56_ord', 'SHOW COLUMNS FROM v56_ord'],
        ['DESCRIBE のバッククォート', 'DESCRIBE v56_ord', 'DESCRIBE `v56_ord`'],
        ['SHOW INDEXES と SHOW INDEX', 'SHOW INDEXES FROM v56_ord', 'SHOW INDEX FROM v56_ord'],
        ['SHOW CREATE TABLE の大小', 'SHOW CREATE TABLE v56_ord', 'show create table v56_ord'],
      ].forEach(([label, a, b], i) => metaSame(`V56E #${i} ${label}`, a, b));
      // INFORMATION_SCHEMA の書き味
      [
        ['大小文字', "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES",
         "select count(*) as n from information_schema.tables"],
        ['改行を挟む', "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'v56_ord'",
         "SELECT COUNT(*) AS n\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_NAME = 'v56_ord'"],
        ['別名を付ける', "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'v56_ord'",
         "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_NAME = 'v56_ord'"],
      ].forEach(([label, a, b], i) => same(`V56E IS #${i} ${label}`, a, b));
      // EXPLAIN は書き方を変えても同じ段数の計画を返す
      [
        ['EXPLAIN の大小', "EXPLAIN SELECT * FROM v56_ord WHERE oid = 3", "explain select * from v56_ord where oid = 3"],
        ['EXPLAIN の改行', "EXPLAIN SELECT * FROM v56_ord WHERE oid = 3", "EXPLAIN\nSELECT *\nFROM v56_ord\nWHERE oid = 3"],
      ].forEach(([label, a, b], i) => t(`V56E EXPLAIN #${i} ${label}`, () => {
        const x = rowsOf(a).length, y = rowsOf(b).length;
        if (x !== y || x === 0) throw new Error(`計画の段数が違う: ${x} / ${y}`);
        return true;
      }));

      // ============================================================
      // F. 同じ集計を別の組み立て方で書く
      // ============================================================
      const AGG = "SELECT c.region, SUM(o.amt) AS total FROM v56_cust c JOIN v56_ord o ON o.cid = c.cid "
        + "WHERE o.status = 'paid' GROUP BY c.region ORDER BY c.region";
      [
        ['CTE で絞ってから結合', "WITH paid AS (SELECT * FROM v56_ord WHERE status = 'paid') "
          + "SELECT c.region, SUM(p.amt) AS total FROM v56_cust c JOIN paid p ON p.cid = c.cid GROUP BY c.region ORDER BY c.region"],
        ['派生表で絞ってから結合', "SELECT c.region, SUM(p.amt) AS total FROM v56_cust c "
          + "JOIN (SELECT * FROM v56_ord WHERE status = 'paid') p ON p.cid = c.cid GROUP BY c.region ORDER BY c.region"],
        ['先に集計してから結合', "SELECT c.region, SUM(a.s) AS total FROM v56_cust c "
          + "JOIN (SELECT cid, SUM(amt) AS s FROM v56_ord WHERE status = 'paid' GROUP BY cid) a ON a.cid = c.cid "
          + "GROUP BY c.region ORDER BY c.region"],
        ['相関副問い合わせで集計', "SELECT region, SUM(x) AS total FROM (SELECT c.region, "
          + "(SELECT SUM(o.amt) FROM v56_ord o WHERE o.cid = c.cid AND o.status = 'paid') AS x FROM v56_cust c) t "
          + "WHERE x <> 0 GROUP BY region ORDER BY region"],
        ['カンマ結合で書く', "SELECT c.region, SUM(o.amt) AS total FROM v56_cust c, v56_ord o "
          + "WHERE o.cid = c.cid AND o.status = 'paid' GROUP BY c.region ORDER BY c.region"],
        ['FILTER で条件を畳む', "SELECT c.region, SUM(o.amt) FILTER (WHERE o.status = 'paid') AS total "
          + "FROM v56_cust c JOIN v56_ord o ON o.cid = c.cid GROUP BY c.region "
          + "HAVING COUNT(*) FILTER (WHERE o.status = 'paid') > 0 ORDER BY c.region"],
      ].forEach(([label, v], i) => same(`V56F #${i} ${label}`, AGG, v));
      const TOPN = "SELECT cid, s FROM (SELECT cid, SUM(amt) AS s, ROW_NUMBER() OVER (ORDER BY SUM(amt) DESC NULLS LAST, cid) AS rn "
        + "FROM v56_ord GROUP BY cid) t WHERE rn <= 3 ORDER BY rn";
      [
        ['ORDER BY + LIMIT で上位 3 件', "SELECT cid, SUM(amt) AS s FROM v56_ord GROUP BY cid "
          + "ORDER BY SUM(amt) DESC NULLS LAST, cid LIMIT 3"],
        ['CTE + FETCH FIRST', "WITH t AS (SELECT cid, SUM(amt) AS s FROM v56_ord GROUP BY cid) "
          + "SELECT cid, s FROM t ORDER BY s DESC NULLS LAST, cid FETCH FIRST 3 ROWS ONLY"],
        ['CTE + 派生表 + LIMIT', "WITH t AS (SELECT cid, SUM(amt) AS s FROM v56_ord GROUP BY cid) "
          + "SELECT cid, s FROM (SELECT * FROM t) u ORDER BY s DESC NULLS LAST, cid LIMIT 3"],
      ].forEach(([label, v], i) => same(`V56F 上位 3 件 #${i} ${label}`, TOPN, v));

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v56_ord', 'v56_cust', 'v56_item');

      return T;
    }
