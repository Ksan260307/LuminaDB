    // ============================================================================
    // [Test Suite v29] - v1.24 の修正・追加のテスト
    //
    //   バックエンド:
    //     - NULL の 3 値論理（この回の中心）。比較・NOT・IN / NOT IN・CHECK 制約が
    //       すべて「NULL が絡めば UNKNOWN」になる。v1.23 までは素の JS 演算子に
    //       落ちていたため `v < 100` が NULL 行を拾い、`x = NULL` が一致し、
    //       `CHECK (b > 0)` が NULL を違反と判定していた
    //     - LIKE / ILIKE / REGEXP / SIMILAR TO の NULL と NOT の 3 値論理
    //     - IS [NOT] NULL / IS [NOT] UNKNOWN は述語として据え置き（比較へ畳まれない）
    //     - 外部結合の SELECT * が未マッチ側の列を NULL で埋める（従来は列ごと欠落）
    //     - ALTER TABLE ... MODIFY / ALTER COLUMN の括弧付き型と方言別名
    //     - '__' で始まる表名の拒否（保存時に消えるため）
    //     - LuminaDB.transaction() の async コールバック拒否 / insert() の列は全行の和集合
    //   フロントエンド:
    //     - Export SQL / Import SQL / Import CSV / Test Data を Data モーダルへ集約
    //     - SQL インポートが失敗した文とエラーを表示する（従来は件数だけ）
    //     - CSV インポートが RFC 4180 パーサを使う（引用符内の改行・カンマ）
    //     - CSV から新しい表を作れる / 取り込み前に既存行を消せる
    //     - .sql / .csv のドラッグ&ドロップ
    //     - 全テーブルの JSON 書き出し
    //
    //   test-suite.js の tests 配列へ getV29Tests() のスプレッドで合流する
    // ============================================================================
    function getV29Tests() {
      // 道具立ては js/tests/test-helpers.js の makeTestKit から受け取る
      const { T, check: push, err, t: fn, idsSafe: ids, oneSafe: one } = makeTestKit('V29');

      // ------------------------------------------------------------
      // 0. フィクスチャ
      // ------------------------------------------------------------
      fn('V29Fx tables', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_n");
        db.executeQuery("CREATE TABLE v29_n (id INTEGER PRIMARY KEY, v INTEGER, s TEXT)");
        db.executeQuery("INSERT INTO v29_n VALUES (1,10,'x'),(2,NULL,NULL),(3,20,'y')");
        return db.tables.v29_n.rowCount === 3;
      });

      // ============================================================
      // 1. 比較の 3 値論理
      // ============================================================
      fn('V29Nl less than excludes null', () => ids("SELECT id FROM v29_n WHERE v < 100 ORDER BY id").join() === '1,3');
      fn('V29Nl greater equal excludes null', () => ids("SELECT id FROM v29_n WHERE v >= 0 ORDER BY id").join() === '1,3');
      fn('V29Nl less equal excludes null', () => ids("SELECT id FROM v29_n WHERE v <= 0 ORDER BY id").join() === '');
      fn('V29Nl greater excludes null', () => ids("SELECT id FROM v29_n WHERE v > 0 ORDER BY id").join() === '1,3');
      fn('V29Nl equals null literal matches nothing', () => ids("SELECT id FROM v29_n WHERE v = NULL").join() === '');
      fn('V29Nl not equals null literal matches nothing', () => ids("SELECT id FROM v29_n WHERE v <> NULL").join() === '');
      fn('V29Nl inequality excludes null', () => ids("SELECT id FROM v29_n WHERE v <> 10 ORDER BY id").join() === '3');
      fn('V29Nl not of equality excludes null', () => ids("SELECT id FROM v29_n WHERE NOT (v = 10) ORDER BY id").join() === '3');
      fn('V29Nl between excludes null', () => ids("SELECT id FROM v29_n WHERE v BETWEEN -5 AND 5").join() === '');
      fn('V29Nl between still works for real values', () => ids("SELECT id FROM v29_n WHERE v BETWEEN 5 AND 15").join() === '1');
      push('V29Nl null equals null is unknown', "SELECT NULL = NULL AS a", r => r.data[0].a === null);
      push('V29Nl value equals null is unknown', "SELECT 1 = NULL AS a", r => r.data[0].a === null);
      push('V29Nl value differs from null is unknown', "SELECT 1 <> NULL AS a", r => r.data[0].a === null);
      push('V29Nl comparison of two values still boolean', "SELECT 1 = 1 AS a, 1 <> 2 AS b, 2 > 1 AS c", r => r.data[0].a === true && r.data[0].b === true && r.data[0].c === true);
      fn('V29Nl and combines normally', () => ids("SELECT id FROM v29_n WHERE v > 5 AND id < 3").join() === '1');
      fn('V29Nl or combines normally', () => ids("SELECT id FROM v29_n WHERE v = 10 OR id = 3 ORDER BY id").join() === '1,3');

      // IS [NOT] NULL / UNKNOWN は述語であって比較ではない（3 値論理へ畳んではいけない）
      fn('V29Nl is null still works', () => ids("SELECT id FROM v29_n WHERE v IS NULL").join() === '2');
      fn('V29Nl is not null still works', () => ids("SELECT id FROM v29_n WHERE v IS NOT NULL ORDER BY id").join() === '1,3');
      push('V29Nl is null as a value', "SELECT v IS NULL AS a, v IS NOT NULL AS b FROM v29_n WHERE id = 2", r => r.data[0].a === true && r.data[0].b === false);
      fn('V29Nl is unknown still works', () => ids("SELECT id FROM v29_n WHERE v IS UNKNOWN").join() === '2');
      fn('V29Nl is not unknown still works', () => ids("SELECT id FROM v29_n WHERE v IS NOT UNKNOWN ORDER BY id").join() === '1,3');
      push('V29Nl is not unknown on a true expression', "SELECT (1 = 1) IS NOT UNKNOWN AS x", r => r.data[0].x === true);

      // 反結合（NOT EXISTS）が NULL で潰れないこと
      fn('V29Nl anti join with a null key', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_o");
        db.executeQuery("DROP TABLE IF EXISTS v29_c");
        db.executeQuery("CREATE TABLE v29_o (id INTEGER, coupon TEXT)");
        db.executeQuery("CREATE TABLE v29_c (code TEXT)");
        db.executeQuery("INSERT INTO v29_o VALUES (1,'A'),(2,NULL)");
        db.executeQuery("INSERT INTO v29_c VALUES ('A')");
        // 相関の外側列は別名で修飾する（内側の表に無い名前は明示が要る）
        return ids("SELECT o.id FROM v29_o o WHERE NOT EXISTS (SELECT 1 FROM v29_c c WHERE c.code = o.coupon)").join() === '2';
      });

      // ============================================================
      // 2. CHECK 制約と NULL
      // ============================================================
      fn('V29Ck null passes a check', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_ck");
        db.executeQuery("CREATE TABLE v29_ck (a INTEGER, b INTEGER CHECK (b > 0))");
        const r = db.executeQuery("INSERT INTO v29_ck (a) VALUES (1)");
        return !r.error && db.tables.v29_ck.rowCount === 1;
      });
      fn('V29Ck a false check still fails', () => {
        const r = db.executeQuery("INSERT INTO v29_ck VALUES (2, -1)");
        return !!r.error && /check/i.test(r.error) && db.tables.v29_ck.rowCount === 1;
      });
      fn('V29Ck a true check still passes', () => {
        const r = db.executeQuery("INSERT INTO v29_ck VALUES (3, 5)");
        return !r.error && db.tables.v29_ck.rowCount === 2;
      });
      fn('V29Ck update to null passes', () => {
        const r = db.executeQuery("UPDATE v29_ck SET b = NULL WHERE a = 3");
        return !r.error && one("SELECT COUNT(*) FROM v29_ck WHERE b IS NULL") === 2;
      });
      fn('V29Ck update to a bad value still fails', () => {
        const r = db.executeQuery("UPDATE v29_ck SET b = -9 WHERE a = 1");
        return !!r.error && /check/i.test(r.error);
      });

      // ============================================================
      // 3. IN / NOT IN の 3 値論理
      // ============================================================
      fn('V29In in with a null in the list', () => ids("SELECT id FROM v29_n WHERE v IN (10, NULL)").join() === '1');
      fn('V29In not in a list containing null is never true', () => ids("SELECT id FROM v29_n WHERE v NOT IN (10, NULL)").join() === '');
      fn('V29In not in a clean list excludes null rows', () => ids("SELECT id FROM v29_n WHERE v NOT IN (10)").join() === '3');
      fn('V29In in a clean list is unchanged', () => ids("SELECT id FROM v29_n WHERE v IN (10,20) ORDER BY id").join() === '1,3');
      push('V29In in is unknown for a null left side', "SELECT NULL IN (1,2) AS a", r => r.data[0].a === null);
      push('V29In in is false when absent', "SELECT 3 IN (1,2) AS a", r => r.data[0].a === false);
      push('V29In in is unknown when absent but the list has null', "SELECT 3 IN (1,NULL) AS a", r => r.data[0].a === null);

      // ============================================================
      // 4. パターン照合の NULL
      // ============================================================
      fn('V29Pt not like excludes null', () => ids("SELECT id FROM v29_n WHERE s NOT LIKE 'x' ORDER BY id").join() === '3');
      fn('V29Pt like excludes null', () => ids("SELECT id FROM v29_n WHERE s LIKE 'x'").join() === '1');
      fn('V29Pt not ilike excludes null', () => ids("SELECT id FROM v29_n WHERE s NOT ILIKE 'X'").join() === '3');
      fn('V29Pt not regexp excludes null', () => ids("SELECT id FROM v29_n WHERE s NOT REGEXP 'x'").join() === '3');
      fn('V29Pt not similar excludes null', () => ids("SELECT id FROM v29_n WHERE s NOT SIMILAR TO 'x'").join() === '3');
      push('V29Pt null like is unknown', "SELECT NULL LIKE 'x' AS a", r => r.data[0].a === null);
      push('V29Pt like of a value is still boolean', "SELECT 'abc' LIKE 'a%' AS a, 'abc' LIKE 'z%' AS b", r => r.data[0].a === true && r.data[0].b === false);

      // ============================================================
      // 5. 外部結合の SELECT *
      // ============================================================
      fn('V29Oj fixture', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_l");
        db.executeQuery("DROP TABLE IF EXISTS v29_r");
        db.executeQuery("CREATE TABLE v29_l (id INTEGER, k INTEGER)");
        db.executeQuery("CREATE TABLE v29_r (rk INTEGER, val TEXT)");
        db.executeQuery("INSERT INTO v29_l VALUES (1,1),(2,2)");
        db.executeQuery("INSERT INTO v29_r VALUES (1,'x')");
        return db.tables.v29_l.rowCount === 2;
      });
      fn('V29Oj unmatched rows keep every column', () => {
        const r = db.executeQuery("SELECT * FROM v29_l LEFT JOIN v29_r ON k = rk ORDER BY id");
        if (r.error) return false;
        const k0 = Object.keys(r.data[0]).join(), k1 = Object.keys(r.data[1]).join();
        return k0 === k1 && k0 === 'id,k,rk,val';
      });
      fn('V29Oj unmatched values are null', () => {
        const r = db.executeQuery("SELECT * FROM v29_l LEFT JOIN v29_r ON k = rk ORDER BY id");
        return r.data[1].rk === null && r.data[1].val === null && r.data[0].val === 'x';
      });
      fn('V29Oj matched rows are unaffected', () => {
        const r = db.executeQuery("SELECT * FROM v29_l LEFT JOIN v29_r ON k = rk WHERE id = 1");
        return r.data[0].id === 1 && r.data[0].rk === 1;
      });

      // ============================================================
      // 6. ALTER TABLE の型指定
      // ============================================================
      fn('V29Ty parameterised type is accepted', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_t");
        db.executeQuery("CREATE TABLE v29_t (a INTEGER, b INTEGER)");
        const r = db.executeQuery("ALTER TABLE v29_t MODIFY COLUMN a VARCHAR(50)");
        return !r.error && db.tables.v29_t.colTypes.a === 'TEXT';
      });
      fn('V29Ty decimal with precision maps to float', () => {
        const r = db.executeQuery("ALTER TABLE v29_t MODIFY COLUMN b DECIMAL(12,4)");
        return !r.error && db.tables.v29_t.colTypes.b === 'FLOAT';
      });
      fn('V29Ty canonical types still work', () => {
        const r = db.executeQuery("ALTER TABLE v29_t ALTER COLUMN b TYPE INTEGER");
        return !r.error && db.tables.v29_t.colTypes.b === 'INTEGER';
      });
      err('V29Ty unknown type is still refused', "ALTER TABLE v29_t MODIFY COLUMN b NOSUCHTYPE", 'unknown type');

      // ============================================================
      // 7. 予約された表名
      // ============================================================
      err('V29Rs reserved table prefix is refused', "CREATE TABLE __secret (a INTEGER)", 'reserved');
      fn('V29Rs the reserved table was not created', () => db.tables.__secret === undefined);
      fn('V29Rs ordinary names still work', () => {
        const r = db.executeQuery("CREATE TABLE v29_ok (a INTEGER)");
        db.executeQuery("DROP TABLE IF EXISTS v29_ok");
        return !r.error;
      });

      // ============================================================
      // 8. 外部 API
      // ============================================================
      fn('V29Api transaction refuses an async callback', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_tx");
        db.executeQuery("CREATE TABLE v29_tx (a INTEGER)");
        const r = LuminaDB.transaction(async () => { LuminaDB.query("INSERT INTO v29_tx VALUES (1)"); });
        return !!(r && r.error) && /synchronous/i.test(r.error) && !db.inTransaction;
      });
      fn('V29Api transaction still commits a sync callback', () => {
        const r = LuminaDB.transaction((t) => { t.query("INSERT INTO v29_tx VALUES (2)"); return 'done'; });
        return !r.error && r.value === 'done' && db.tables.v29_tx.rowCount === 1;
      });
      fn('V29Api insert uses the union of every row key', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_u");
        db.executeQuery("CREATE TABLE v29_u (a INTEGER, b INTEGER, c INTEGER)");
        const r = LuminaDB.insert('v29_u', [{ a: 1 }, { a: 2, b: 20 }, { a: 3, c: 30 }]);
        if (r.error) return false;
        const rows = db.executeQuery("SELECT a, b, c FROM v29_u ORDER BY a").data;
        return rows.length === 3 && rows[1].b === 20 && rows[2].c === 30 && rows[0].b === null;
      });

      // ============================================================
      // 9. フロントエンド: Data モーダルへの集約
      // ============================================================
      fn('V29Ui the four old buttons are gone from the sidebar', () => {
        const ids2 = [...document.querySelectorAll('aside button')].map(b => b.id);
        return !ids2.includes('exportSqlBtn') && !ids2.includes('importSqlBtn')
            && !ids2.includes('openCsvBtn') && !ids2.includes('openGeneratorBtn');
      });
      fn('V29Ui one data button replaces them', () => !!document.getElementById('openDataBtn'));
      // v1.34: 保存系の 3 つもモーダルへ移した（サイドバーの入口はボタン 1 つだけ）
      fn('V29Ui the storage buttons moved into the modal', () => {
        const side = [...document.querySelectorAll('aside button')].map(b => b.id);
        const inModal = [...document.querySelectorAll('#dataModal button')].map(b => b.id);
        return !side.includes('saveIdbBtn') && !side.includes('loadIdbBtn') && !side.includes('clearIdbBtn')
            && inModal.includes('saveIdbBtn') && inModal.includes('loadIdbBtn') && inModal.includes('clearIdbBtn');
      });
      fn('V29Ui the data button opens the modal', () => {
        document.getElementById('openDataBtn').click();
        return !document.getElementById('dataModal').classList.contains('hidden');
      });
      fn('V29Ui the modal has five tabs', () => {
        return document.querySelectorAll('#dataModal .dataTabBtn').length === 5;
      });
      fn('V29Ui this-browser is the default tab', () => {
        const shown = [...document.querySelectorAll('#dataModal .dataPane')].filter(p => !p.classList.contains('hidden')).map(p => p.id);
        return shown.length === 1 && shown[0] === 'dataPaneBrowser';
      });
      fn('V29Ui switching tabs shows one pane at a time', () => {
        document.querySelector('#dataModal .dataTabBtn[data-pane="dataPaneImport"]').click();
        const shown = [...document.querySelectorAll('#dataModal .dataPane')].filter(p => !p.classList.contains('hidden')).map(p => p.id);
        return shown.length === 1 && shown[0] === 'dataPaneImport';
      });
      fn('V29Ui every control explains itself', () => {
        // 説明文が無いまま並んでいたのが元の問題。各セクションに説明段落があること
        return document.querySelectorAll('#dataPaneExport p').length >= 2
            && document.querySelectorAll('#dataPaneImport p').length >= 2
            && document.querySelectorAll('#dataPaneGen p').length >= 1
            && document.querySelectorAll('#dataPaneBrowser p').length >= 4
            && document.querySelectorAll('#dataPaneFile p').length >= 4;
      });
      fn('V29Ui the generator tab is still reachable by its old id', () => {
        document.getElementById('openGeneratorBtn').click();
        const shown = [...document.querySelectorAll('#dataModal .dataPane')].filter(p => !p.classList.contains('hidden')).map(p => p.id);
        return shown.length === 1 && shown[0] === 'dataPaneGen';
      });
      fn('V29Ui escape closes the data modal', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return document.getElementById('dataModal').classList.contains('hidden');
      });

      // ============================================================
      // 10. フロントエンド: SQL / CSV の取り込み
      // ============================================================
      fn('V29Io sql import reports the failing statements', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_si");
        const res = runSqlImport("CREATE TABLE v29_si (a INTEGER);\nINSERT INTO v29_si VALUES (1);\nINSERT INTO nosuch_tbl VALUES (2);", 'x.sql');
        const log = document.getElementById('dataImportLog');
        return res.successCount === 2 && res.failed === 1
            && !log.classList.contains('hidden')
            && log.textContent.includes('nosuch_tbl')
            && /not found/i.test(log.textContent);
      });
      fn('V29Io sql import applies the good statements', () => db.tables.v29_si.rowCount === 1);
      fn('V29Io a clean sql import reports success', () => {
        const res = runSqlImport("INSERT INTO v29_si VALUES (9);", 'ok.sql');
        const log = document.getElementById('dataImportLog');
        return res.failed === 0 && log.textContent.includes('すべて実行');
      });
      fn('V29Io csv import handles quoted newlines and commas', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_csv");
        db.executeQuery("CREATE TABLE v29_csv (id INTEGER, note TEXT)");
        renderTree();
        document.getElementById('csvTableSelect').value = 'v29_csv';
        const r = runCsvImport('id,note\n1,"line1\nline2"\n2,"a,b"\n', 'q.csv');
        if (r && r.error) return false;
        const rows = db.executeQuery("SELECT note FROM v29_csv ORDER BY id").data;
        return rows.length === 2 && rows[0].note === 'line1\nline2' && rows[1].note === 'a,b';
      });
      fn('V29Io csv import can create a new table', () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_new");
        renderTree();
        document.getElementById('csvTableSelect').value = '__new__';
        document.getElementById('csvNewTableName').value = 'v29_new';
        const r = runCsvImport('code,qty\nA,10\nB,20\n', 'n.csv');
        if (r && r.error) return false;
        const rows = db.executeQuery("SELECT code, qty FROM v29_new ORDER BY code").data;
        return rows.length === 2 && rows[0].code === 'A' && rows[1].qty === 20;
      });
      fn('V29Io the created table infers column types', () => {
        return db.tables.v29_new.colTypes.code === 'TEXT' && db.tables.v29_new.colTypes.qty === 'FLOAT';
      });
      fn('V29Io creating an existing table is refused', () => {
        document.getElementById('csvTableSelect').value = '__new__';
        document.getElementById('csvNewTableName').value = 'v29_new';
        const r = runCsvImport('code,qty\nC,1\n', 'n.csv');
        return !!(r && r.error) && db.tables.v29_new.rowCount === 2;
      });
      fn('V29Io an invalid new table name is refused', () => {
        document.getElementById('csvTableSelect').value = '__new__';
        document.getElementById('csvNewTableName').value = '1 bad name';
        const r = runCsvImport('code\nA\n', 'n.csv');
        return !!(r && r.error);
      });
      fn('V29Io the replace option clears existing rows first', () => {
        renderTree();
        document.getElementById('csvTableSelect').value = 'v29_new';
        document.getElementById('csvReplaceChk').checked = true;
        const r = runCsvImport('code,qty\nZ,99\n', 'r.csv');
        document.getElementById('csvReplaceChk').checked = false;
        return !(r && r.error) && db.tables.v29_new.rowCount === 1
            && db.executeQuery("SELECT code FROM v29_new").data[0].code === 'Z';
      });
      fn('V29Io the target list offers a new table option', () => {
        renderTree();
        const opts = [...document.getElementById('csvTableSelect').options].map(o => o.value);
        return opts[opts.length - 1] === '__new__';
      });
      fn('V29Io the new table name box follows the selection', () => {
        const sel = document.getElementById('csvTableSelect');
        sel.value = '__new__';
        sel.dispatchEvent(new Event('change'));
        const shown = !document.getElementById('csvNewTableRow').classList.contains('hidden');
        sel.value = 'v29_new';
        sel.dispatchEvent(new Event('change'));
        return shown && document.getElementById('csvNewTableRow').classList.contains('hidden');
      });
      fn('V29Io a drop zone exists for files', () => !!document.getElementById('dataDropZone'));
      fn('V29Io dropping a csv file imports it', async () => {
        db.executeQuery("DROP TABLE IF EXISTS v29_drop");
        db.executeQuery("CREATE TABLE v29_drop (id INTEGER, nm TEXT)");
        renderTree();
        document.getElementById('csvTableSelect').value = 'v29_drop';
        const dt = new DataTransfer();
        dt.items.add(new File(["id,nm\n5,five\n"], 'd.csv', { type: 'text/csv' }));
        const ev = new Event('drop', { bubbles: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        document.getElementById('dataDropZone').dispatchEvent(ev);
        await new Promise(r => setTimeout(r, 300));
        return db.tables.v29_drop.rowCount === 1;
      });
      fn('V29Io a json export button exists for the whole database', () => !!document.getElementById('exportJsonAllBtn'));

      // ------------------------------------------------------------
      // 後片付け
      // ------------------------------------------------------------
      fn('V29Cl drop objects', () => {
        ['v29_drop', 'v29_new', 'v29_csv', 'v29_si', 'v29_u', 'v29_tx', 'v29_t', 'v29_r', 'v29_l',
         'v29_ck', 'v29_c', 'v29_o', 'v29_n']
            .forEach(t => db.executeQuery(`DROP TABLE IF EXISTS ${t}`));
        const log = document.getElementById('dataImportLog');
        if (log) { log.classList.add('hidden'); log.innerHTML = ''; }
        const nm = document.getElementById('csvNewTableName');
        if (nm) nm.value = '';
        setQueryValue('');
        renderTree();
        return true;
      });

      return T;
    }
