    // ============================================================================
    // [Test Suite v53] - 書き味 (3/5): 句の組み合わせと組み立て方
    //
    //   SELECT の句（DISTINCT / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET）を
    //   有無で総当たりし、同じ組み合わせを「1 行」「整形」「派生表」「CTE」「別名・序数」で
    //   書き分けても結果が変わらないことを確かめる。結合の順序・ウィンドウ句の書き方・
    //   まとめ方（ROLLUP / GROUPING SETS）・集合演算の括り方も同じやり方で見る。
    //
    //     A. 句の有無の総当たり × 書き方
    //     B. 結合の並べ替え（内部結合は順序を変えても同じ）
    //     C. ウィンドウ句の書き分け（インライン / WINDOW 句 / フレームの綴り）
    //     D. まとめ方の書き分け（ROLLUP / CUBE / GROUPING SETS / UNION ALL）
    //     E. 集合演算の括り方と ORDER BY / LIMIT の位置
    //     F. FROM の書き分け（表 / 派生表 / CTE / VALUES）
    //
    //   test-suite.js の tests 配列へ getV53Tests() のスプレッドで合流する
    // ============================================================================
    function getV53Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, q, t, same, upper, lower, insertRows, drop, cleanup } = makeTestKit('V53');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      t('V53 fixture', () => {
        drop('v53_emp', 'v53_dept', 'v53_sale');
        q("CREATE TABLE v53_dept (dname TEXT PRIMARY KEY, floor INT)");
        q("CREATE TABLE v53_emp (id INT PRIMARY KEY, name TEXT, dept TEXT, sal INT, hired DATE)");
        q("CREATE TABLE v53_sale (sid INT PRIMARY KEY, eid INT, amt INT)");
        insertRows('v53_dept', [['Sales', 1], ['Tech', 2], ['HR', 3], ['Ops', 2]]);
        const dn = ['Sales', 'Tech', 'HR', 'Ops'];
        const emp = [];
        for (let i = 1; i <= 24; i++) {
          emp.push([i, 'N' + i, dn[i % 4], (i % 9 === 0) ? null : 200 + ((i * 3) % 8) * 25,
                    `20${20 + (i % 4)}-0${(i % 8) + 1}-1${i % 10}`]);
        }
        insertRows('v53_emp', emp);
        const sale = [];
        for (let i = 1; i <= 30; i++) sale.push([i, ((i * 5) % 24) + 1, ((i * 7) % 90) + 10]);
        insertRows('v53_sale', sale);
        return db.tables['v53_emp'].rowCount === 24 && db.tables['v53_sale'].rowCount === 30;
      });

      // ============================================================
      // A. 句の有無の総当たり
      // ============================================================
      // 句ごとの中身。GROUP BY の有無で SELECT 句と ORDER BY の中身も変わる
      const combos = [];
      [false, true].forEach(distinct =>
        [false, true].forEach(joined =>
          ['none', 'simple', 'compound'].forEach(where =>
            ['none', 'group', 'group+having'].forEach(grp =>
              ['none', 'order', 'order+limit', 'order+limit+offset'].forEach(ord => {
                combos.push({ distinct, joined, where, grp, ord });
              })))));
      const WHERE_TEXT = { simple: 'sal > 250', compound: "sal > 250 AND (dept <> 'HR' OR sal IS NULL)" };
      const build = (c, style) => {
        const grouped = c.grp !== 'none';
        const cols = grouped
          ? (c.joined ? 'e.dept, COUNT(*) AS c, SUM(e.sal) AS s' : 'dept, COUNT(*) AS c, SUM(sal) AS s')
          : (c.joined ? 'e.id, e.dept, e.sal, d.floor' : 'id, dept, sal');
        const pre = c.joined ? 'e.' : '';
        const parts = [];
        parts.push(`SELECT ${c.distinct ? 'DISTINCT ' : ''}${cols}`);
        parts.push(c.joined ? 'FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname' : 'FROM v53_emp');
        if (c.where !== 'none') parts.push('WHERE ' + WHERE_TEXT[c.where].split('sal').join(pre + 'sal').split('dept').join(pre + 'dept'));
        if (grouped) parts.push(`GROUP BY ${pre}dept`);
        if (c.grp === 'group+having') parts.push('HAVING COUNT(*) >= 2');
        if (c.ord !== 'none') parts.push(grouped ? `ORDER BY ${pre}dept` : `ORDER BY ${pre}id`);
        if (c.ord.indexOf('limit') !== -1) parts.push('LIMIT 3');
        if (c.ord.indexOf('offset') !== -1) parts.push('OFFSET 1');
        const one = parts.join(' ');
        switch (style) {
          case 'formatted': return parts.join('\n  ');
          case 'commented': return parts.map((p, i) => `${p} -- 句 ${i}`).join('\n');
          // 大小の変換は文字列リテラルの中身に触れないこと（'HR' が 'hr' になると別条件になる）
          case 'upper': return upper(one);
          case 'lower': return lower(one);
          case 'tabs': return parts.join('\t');
          case 'blocks': return parts.join(' /* 次の句 */ ');
          case 'semicolon': return '  ' + one + ' ;';
          default: return one;
        }
      };
      combos.forEach((c, ci) => {
        const base = build(c, 'oneline');
        const label = `${c.distinct ? 'DISTINCT ' : ''}${c.joined ? 'JOIN ' : ''}`
          + `WHERE:${c.where} ${c.grp} ${c.ord}`;
        ['formatted', 'commented', 'upper', 'lower', 'tabs', 'blocks', 'semicolon'].forEach(style =>
          same(`V53A #${ci} ${label} を ${style} で書く`, base, build(c, style)));
        // WHERE を派生表・CTE へ押し込む
        if (c.where !== 'none' && !c.joined) {
          const cond = WHERE_TEXT[c.where];
          const inner = `SELECT * FROM v53_emp WHERE ${cond}`;
          same(`V53A #${ci} ${label} の WHERE を派生表へ`, base,
               base.replace(`FROM v53_emp WHERE ${cond}`, `FROM (${inner}) v53_emp`));
          same(`V53A #${ci} ${label} の WHERE を CTE へ`, base,
               `WITH src AS (${inner}) ` + base.replace(`FROM v53_emp WHERE ${cond}`, 'FROM src'));
        }
        // 並べ替えを序数で書く
        if (c.ord !== 'none') {
          same(`V53A #${ci} ${label} の ORDER BY を序数で`, base,
               base.replace(/ORDER BY (e\.)?(dept|id)/, 'ORDER BY 1'));
        }
        // 全体を派生表・CTE で包む（LIMIT/OFFSET が無い形だけ）
        if (c.ord === 'none') {
          same(`V53A #${ci} ${label} を派生表で包む`, base, `SELECT * FROM (${base}) w`);
          same(`V53A #${ci} ${label} を CTE で包む`, base, `WITH w AS (${base}) SELECT * FROM w`);
        }
      });

      // ============================================================
      // B. 結合の並べ替え
      //   内部結合は表の並べ方・ON の書き方を変えても結果は同じ
      // ============================================================
      const J3 = "SELECT e.id, d.floor, s.amt FROM v53_emp e "
        + "JOIN v53_dept d ON e.dept = d.dname JOIN v53_sale s ON s.eid = e.id ORDER BY e.id, s.sid";
      [
        ['結合の順を入れ替える', "SELECT e.id, d.floor, s.amt FROM v53_emp e JOIN v53_sale s ON s.eid = e.id JOIN v53_dept d ON e.dept = d.dname ORDER BY e.id, s.sid"],
        ['sale を先に置く', "SELECT e.id, d.floor, s.amt FROM v53_sale s JOIN v53_emp e ON s.eid = e.id JOIN v53_dept d ON e.dept = d.dname ORDER BY e.id, s.sid"],
        ['dept を先に置く', "SELECT e.id, d.floor, s.amt FROM v53_dept d JOIN v53_emp e ON e.dept = d.dname JOIN v53_sale s ON s.eid = e.id ORDER BY e.id, s.sid"],
        ['すべてカンマ結合', "SELECT e.id, d.floor, s.amt FROM v53_emp e, v53_dept d, v53_sale s WHERE e.dept = d.dname AND s.eid = e.id ORDER BY e.id, s.sid"],
        ['カンマと JOIN の混在', "SELECT e.id, d.floor, s.amt FROM v53_emp e, v53_dept d JOIN v53_sale s ON 1 = 1 WHERE e.dept = d.dname AND s.eid = e.id ORDER BY e.id, s.sid"],
        ['ON の条件を WHERE へ', "SELECT e.id, d.floor, s.amt FROM v53_emp e JOIN v53_dept d ON 1 = 1 JOIN v53_sale s ON 1 = 1 WHERE e.dept = d.dname AND s.eid = e.id ORDER BY e.id, s.sid"],
        ['派生表を挟む', "SELECT e.id, d.floor, s.amt FROM (SELECT * FROM v53_emp) e JOIN v53_dept d ON e.dept = d.dname JOIN (SELECT * FROM v53_sale) s ON s.eid = e.id ORDER BY e.id, s.sid"],
        ['CTE を挟む', "WITH ee AS (SELECT * FROM v53_emp), ss AS (SELECT * FROM v53_sale) SELECT e.id, d.floor, s.amt FROM ee e JOIN v53_dept d ON e.dept = d.dname JOIN ss s ON s.eid = e.id ORDER BY e.id, s.sid"],
        ['改行して整形', "SELECT e.id, d.floor, s.amt\nFROM v53_emp e\n  JOIN v53_dept d\n    ON e.dept = d.dname\n  JOIN v53_sale s\n    ON s.eid = e.id\nORDER BY e.id, s.sid"],
      ].forEach(([label, variant]) => same(`V53B ${label}`, J3, variant));
      // USING / NATURAL と ON の対応
      same('V53B USING は ON と同じ（列は 1 本になる）',
           "SELECT e.id, s.amt FROM v53_emp e JOIN v53_sale s ON s.eid = e.id ORDER BY e.id, s.sid",
           "SELECT e.id, s.amt FROM v53_emp e JOIN (SELECT sid, eid AS id, amt FROM v53_sale) s USING (id) ORDER BY e.id, s.sid");
      // 外部結合は向きで結果が変わる（左右を入れ替えたら型も入れ替える）
      const LJ = "SELECT e.id, d.floor FROM v53_emp e LEFT JOIN v53_dept d ON e.dept = d.dname ORDER BY e.id";
      [
        ['LEFT OUTER と書く', "SELECT e.id, d.floor FROM v53_emp e LEFT OUTER JOIN v53_dept d ON e.dept = d.dname ORDER BY e.id"],
        ['RIGHT で左右を入れ替える', "SELECT e.id, d.floor FROM v53_dept d RIGHT JOIN v53_emp e ON e.dept = d.dname ORDER BY e.id"],
        ['FULL JOIN + 片側の絞り込み', "SELECT e.id, d.floor FROM v53_emp e FULL OUTER JOIN v53_dept d ON e.dept = d.dname WHERE e.id IS NOT NULL ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V53B 外部結合: ${label}`, LJ, variant));

      // ============================================================
      // C. ウィンドウ句の書き分け
      // ============================================================
      const WIN = "SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS w FROM v53_emp ORDER BY id";
      [
        ['WINDOW 句で名前を付ける', "SELECT id, SUM(sal) OVER w AS w FROM v53_emp WINDOW w AS (PARTITION BY dept ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) ORDER BY id"],
        ['フレームを短く書く', "SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id ROWS UNBOUNDED PRECEDING) AS w FROM v53_emp ORDER BY id"],
        ['OVER 句を複数行で書く', "SELECT id,\n  SUM(sal) OVER (\n    PARTITION BY dept\n    ORDER BY id\n    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\n  ) AS w\nFROM v53_emp\nORDER BY id"],
        ['小文字で書く', "select id, sum(sal) over (partition by dept order by id rows between unbounded preceding and current row) as w from v53_emp order by id"],
        ['派生表で包む', "SELECT id, w FROM (SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS w FROM v53_emp) t ORDER BY id"],
        ['相関副問い合わせで書く', "SELECT e.id, (SELECT SUM(x.sal) FROM v53_emp x WHERE x.dept = e.dept AND x.id <= e.id) AS w FROM v53_emp e ORDER BY e.id"],
      ].forEach(([label, variant]) => same(`V53C 累計: ${label}`, WIN, variant));
      const RN = "SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY sal DESC NULLS LAST, id) AS rn FROM v53_emp ORDER BY id";
      [
        ['WINDOW 句', "SELECT id, ROW_NUMBER() OVER w AS rn FROM v53_emp WINDOW w AS (PARTITION BY dept ORDER BY sal DESC NULLS LAST, id) ORDER BY id"],
        ['PARTITION と ORDER の間で改行', "SELECT id, ROW_NUMBER() OVER (PARTITION BY dept\n ORDER BY sal DESC NULLS LAST, id) AS rn FROM v53_emp ORDER BY id"],
        ['別名を付けずに派生表で名付ける', "SELECT id, rn FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY sal DESC NULLS LAST, id) AS rn FROM v53_emp) t ORDER BY id"],
      ].forEach(([label, variant]) => same(`V53C 連番: ${label}`, RN, variant));
      // 既定フレームと明示フレームの対応
      same('V53C ORDER BY だけの OVER は RANGE UNBOUNDED PRECEDING と同じ',
           "SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY sal) AS w FROM v53_emp ORDER BY id",
           "SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY sal RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS w FROM v53_emp ORDER BY id");
      same('V53C ORDER BY 無しの OVER はパーティション全体',
           "SELECT id, SUM(sal) OVER (PARTITION BY dept) AS w FROM v53_emp ORDER BY id",
           "SELECT e.id, (SELECT SUM(x.sal) FROM v53_emp x WHERE x.dept = e.dept) AS w FROM v53_emp e ORDER BY e.id");
      same('V53C OVER () は表全体',
           "SELECT id, SUM(sal) OVER () AS w FROM v53_emp ORDER BY id",
           "SELECT e.id, (SELECT SUM(sal) FROM v53_emp) AS w FROM v53_emp e ORDER BY e.id");

      // ============================================================
      // D. まとめ方の書き分け
      // ============================================================
      same('V53D ROLLUP は UNION ALL で書ける',
           "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY ROLLUP(dept) ORDER BY dept",
           "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY dept "
           + "UNION ALL SELECT NULL, COUNT(*) FROM v53_emp ORDER BY dept");
      same('V53D GROUPING SETS は ROLLUP と同じ形に書ける',
           "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY ROLLUP(dept) ORDER BY dept",
           "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY GROUPING SETS ((dept), ()) ORDER BY dept");
      same('V53D GROUP BY の並び順は結果に影響しない',
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname GROUP BY dept, floor ORDER BY dept, floor",
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname GROUP BY floor, dept ORDER BY dept, floor");
      same('V53D 序数と列名を混ぜてまとめる',
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname GROUP BY dept, floor ORDER BY dept, floor",
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname GROUP BY 1, floor ORDER BY 1, 2");
      same('V53D CUBE は GROUPING SETS で書ける',
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname GROUP BY CUBE(dept, floor) ORDER BY dept, floor",
           "SELECT dept, floor, COUNT(*) AS c FROM v53_emp e JOIN v53_dept d ON e.dept = d.dname "
           + "GROUP BY GROUPING SETS ((dept, floor), (dept), (floor), ()) ORDER BY dept, floor");

      // ============================================================
      // E. 集合演算の括り方
      // ============================================================
      const S1 = "SELECT id FROM v53_emp WHERE sal > 350";
      const S2 = "SELECT id FROM v53_emp WHERE dept = 'HR'";
      const S3 = "SELECT id FROM v53_emp WHERE id < 5";
      same('V53E UNION は括弧の付け方で変わらない',
           `${S1} UNION ${S2} UNION ${S3} ORDER BY id`,
           `(${S1}) UNION (${S2}) UNION (${S3}) ORDER BY id`);
      same('V53E UNION は結合順で変わらない',
           `${S1} UNION ${S2} UNION ${S3} ORDER BY id`,
           `${S3} UNION ${S1} UNION ${S2} ORDER BY id`);
      same('V53E UNION ALL + DISTINCT は UNION と同じ',
           `${S1} UNION ${S2} ORDER BY id`,
           `SELECT DISTINCT id FROM (${S1} UNION ALL ${S2}) t ORDER BY id`);
      same('V53E 集合演算に ORDER BY と LIMIT を付ける',
           `${S1} UNION ${S2} ORDER BY id LIMIT 3`,
           `SELECT * FROM (${S1} UNION ${S2}) t ORDER BY id LIMIT 3`);
      same('V53E 枝ごとに改行して整形する',
           `${S1} UNION ${S2} ORDER BY id`,
           `${S1}\nUNION\n${S2}\nORDER BY id`);
      same('V53E EXCEPT は左右を入れ替えられない（明示的に書き分ける）',
           `${S1} EXCEPT ${S2} ORDER BY id`,
           `SELECT id FROM v53_emp WHERE sal > 350 AND (dept <> 'HR' OR dept IS NULL) ORDER BY id`);
      same('V53E INTERSECT は AND と同じ',
           `${S1} INTERSECT ${S2} ORDER BY id`,
           `SELECT id FROM v53_emp WHERE sal > 350 AND dept = 'HR' ORDER BY id`);

      // ============================================================
      // F. FROM の書き分け
      // ============================================================
      const FROMS = [
        ['表をそのまま', 'v53_emp'],
        ['別名を付ける', 'v53_emp AS e2'],
        ['派生表', '(SELECT * FROM v53_emp) e2'],
        ['列を絞った派生表', '(SELECT id, dept, sal FROM v53_emp) e2'],
        ['UNION ALL した派生表', '(SELECT * FROM v53_emp WHERE id <= 12 UNION ALL SELECT * FROM v53_emp WHERE id > 12) e2'],
      ];
      FROMS.forEach(([label, src], i) => {
        if (i === 0) return;
        same(`V53F ${label}`,
             "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY dept ORDER BY dept",
             `SELECT dept, COUNT(*) AS c FROM ${src} GROUP BY dept ORDER BY dept`);
      });
      same('V53F CTE で組み立てる',
           "SELECT dept, COUNT(*) AS c FROM v53_emp GROUP BY dept ORDER BY dept",
           "WITH e2 AS (SELECT * FROM v53_emp) SELECT dept, COUNT(*) AS c FROM e2 GROUP BY dept ORDER BY dept");
      same('V53F VALUES を表として使う',
           "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v",
           "WITH v(c1, c2) AS (SELECT 1, 'a' UNION ALL SELECT 2, 'b') SELECT * FROM v");

      // ============================================================
      // 片付け
      // ============================================================
      cleanup('v53_emp', 'v53_dept', 'v53_sale');

      return T;
    }
