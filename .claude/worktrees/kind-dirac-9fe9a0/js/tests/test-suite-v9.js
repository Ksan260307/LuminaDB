    // ============================================================================
    // [Test Suite v9] - v1.8 機能追加の回帰テスト
    //   1. V9Search     : Command Reference（コマンドリファレンス）の検索機能
    //   2. V9Edit       : Table Editor の制約編集（PK / NOT NULL / UNIQUE / AUTO_INC / DEFAULT）
    //   3. V9Consistency: Table Editor の「編集」と「実装コマンド(生成DDL)」の整合性
    //        → エディタ保存後のスキーマ が、プレビューの CREATE TABLE を実行した結果と一致することを検証
    //   test-suite.js の tests 配列へ getV9Tests() のスプレッドで合流する
    // ============================================================================
    function getV9Tests() {

      // テーブルのスキーマ・メタデータを正規化した署名文字列にする。
      // 「エディタで編集した表」と「等価DDLで作った表」を同一基準で比較するために使う。
      // （行データではなく列構成・型・制約のみを対象にする）
      function schemaSig(t) {
        const names = t.getColumnNames();
        const def = {};
        names.forEach(c => { if (t.defaults && c in t.defaults) def[c] = t.defaults[c]; });
        return JSON.stringify({
          cols: names,
          types: names.map(c => t.colTypes[c] || 'ANY'),
          pk: t.primaryKey || null,
          nn: [...(t.notNullCols || [])].sort(),
          uq: [...(t.uniqueCols || [])].sort(),
          ai: t.autoIncrementCol || null,
          def: def
        });
      }

      // 現在のエディタプレビュー（生成DDL）を取り出し、テーブル名を差し替えて別テーブルとして実行する。
      // 戻り値: 実行された CREATE TABLE の結果オブジェクト
      function runPreviewAs(newName, srcName) {
        const ddl = document.getElementById('schemaPreviewText').textContent;
        const cmd = ddl.replace(new RegExp('\\b' + srcName + '\\b', 'g'), newName);
        return { cmd, res: db.executeQuery(cmd) };
      }

      return [
        // ============================================================
        // 1. Command Reference 検索 (V9Search)
        // ============================================================
        { name: "V9Search: Filter Narrows Results", fn: () => {
            document.getElementById('openHelpBtn').click();
            const input = document.getElementById('helpSearchInput');
            input.value = 'JOIN';
            input.dispatchEvent(new Event('input'));
            const html = document.getElementById('helpContent').innerHTML;
            const noRes = document.getElementById('helpNoResults');
            const ok = html.includes('JOIN') && !html.includes('MD5(') && noRes.classList.contains('hidden');
            input.value = ''; input.dispatchEvent(new Event('input'));
            document.getElementById('helpModal').classList.add('hidden');
            return ok;
        }},
        { name: "V9Search: No Match Shows Message", fn: () => {
            document.getElementById('openHelpBtn').click();
            const input = document.getElementById('helpSearchInput');
            input.value = 'zzz_no_such_command_zzz';
            input.dispatchEvent(new Event('input'));
            const content = document.getElementById('helpContent');
            const noRes = document.getElementById('helpNoResults');
            const ok = content.children.length === 0 && !noRes.classList.contains('hidden');
            input.value = ''; input.dispatchEvent(new Event('input'));
            document.getElementById('helpModal').classList.add('hidden');
            return ok;
        }},
        { name: "V9Search: Clear Button Restores All", fn: () => {
            document.getElementById('openHelpBtn').click();
            const input = document.getElementById('helpSearchInput');
            input.value = 'INSERT';
            input.dispatchEvent(new Event('input'));
            const narrowed = document.getElementById('helpContent').querySelectorAll('.copy-cmd-btn').length;
            document.getElementById('helpSearchClear').click();
            const full = document.getElementById('helpContent').querySelectorAll('.copy-cmd-btn').length;
            document.getElementById('helpModal').classList.add('hidden');
            return input.value === '' && full > narrowed && narrowed > 0;
        }},
        { name: "V9Search: Matches By Command Name (not just SQL)", fn: () => {
            // 「Base64 Roundtrip」は名前に 'Roundtrip' を含むが SQL には含まない。
            // 名前でもヒットすることを確認する。
            document.getElementById('openHelpBtn').click();
            const input = document.getElementById('helpSearchInput');
            input.value = 'Roundtrip';
            input.dispatchEvent(new Event('input'));
            const html = document.getElementById('helpContent').innerHTML;
            const ok = html.includes('TO_BASE64') && document.getElementById('helpContent').querySelectorAll('.copy-cmd-btn').length === 1;
            input.value = ''; input.dispatchEvent(new Event('input'));
            document.getElementById('helpModal').classList.add('hidden');
            return ok;
        }},
        { name: "V9Search: Highlight Wraps Match", fn: () => {
            document.getElementById('openHelpBtn').click();
            const input = document.getElementById('helpSearchInput');
            input.value = 'DISTINCT';
            input.dispatchEvent(new Event('input'));
            const html = document.getElementById('helpContent').innerHTML;
            const ok = html.includes('<mark');
            input.value = ''; input.dispatchEvent(new Event('input'));
            document.getElementById('helpModal').classList.add('hidden');
            return ok;
        }},

        // ============================================================
        // 2. Table Editor の制約編集 (V9Edit)
        // ============================================================
        { name: "V9Edit: Reads Existing Constraints", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS ve_read");
            db.executeQuery("CREATE TABLE ve_read (id INTEGER PRIMARY KEY AUTO_INCREMENT, email TEXT UNIQUE NOT NULL, st TEXT DEFAULT 'ok')");
            openSchemaEditor('ve_read');
            const cols = editingSchema.cols;
            const idc = cols.find(c => c.oldName === 'id');
            const emc = cols.find(c => c.oldName === 'email');
            const stc = cols.find(c => c.oldName === 'st');
            const ok = idc.pk === true && idc.autoInc === true &&
                       emc.unique === true && emc.notNull === true &&
                       stc.defaultText === "'ok'";
            document.getElementById('schemaModal').classList.add('hidden');
            db.executeQuery("DROP TABLE IF EXISTS ve_read");
            return ok;
        }},
        { name: "V9Edit: Add PK + NOT NULL Via Editor", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS ve_add");
            db.executeQuery("CREATE TABLE ve_add (id INTEGER, name TEXT)");
            db.executeQuery("INSERT INTO ve_add (id, name) VALUES (1, 'a'), (2, 'b')");
            openSchemaEditor('ve_add');
            editingSchema.cols[0].pk = true;
            editingSchema.cols[1].notNull = true;
            document.getElementById('execSchemaSaveBtn').click();
            const t = db.tables['ve_add'];
            const modalClosed = document.getElementById('schemaModal').classList.contains('hidden');
            const ok = t.primaryKey === 'id' && t.notNullCols.includes('name') && !!t.indices['id'] && modalClosed;
            db.executeQuery("DROP TABLE IF EXISTS ve_add");
            return ok;
        }},
        { name: "V9Edit: New Column DEFAULT Backfills Existing Rows", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS ve_def");
            db.executeQuery("CREATE TABLE ve_def (id INTEGER)");
            db.executeQuery("INSERT INTO ve_def (id) VALUES (1), (2), (3)");
            openSchemaEditor('ve_def');
            editingSchema.cols.push({ oldName: null, newName: 'status', type: 'TEXT', isNew: true, isDeleted: false, pk: false, notNull: true, unique: false, autoInc: false, defaultText: "'active'" });
            document.getElementById('execSchemaSaveBtn').click();
            const t = db.tables['ve_def'];
            const modalClosed = document.getElementById('schemaModal').classList.contains('hidden');
            const allActive = t.getValue('status', 0) === 'active' && t.getValue('status', 1) === 'active' && t.getValue('status', 2) === 'active';
            const ok = modalClosed && allActive && t.notNullCols.includes('status') && t.defaults['status'] === 'active';
            db.executeQuery("DROP TABLE IF EXISTS ve_def");
            return ok;
        }},
        { name: "V9Edit: PK On Duplicate Data Rejected + Rollback", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS ve_dup");
            db.executeQuery("CREATE TABLE ve_dup (id INTEGER, name TEXT)");
            db.executeQuery("INSERT INTO ve_dup (id, name) VALUES (1, 'a'), (1, 'b')");
            openSchemaEditor('ve_dup');
            editingSchema.cols[0].pk = true;
            document.getElementById('execSchemaSaveBtn').click();
            const t = db.tables['ve_dup'];
            const errEl = document.getElementById('schemaErrorMsg');
            const errShown = !errEl.classList.contains('hidden') && /PRIMARY KEY/i.test(errEl.textContent);
            // ロールバックにより PK は付いていない & 行データは保持
            const ok = errShown && t.primaryKey === null && t.rowCount === 2;
            document.getElementById('schemaModal').classList.add('hidden');
            db.executeQuery("DROP TABLE IF EXISTS ve_dup");
            return ok;
        }},
        { name: "V9Edit: Single PK Enforced In UI", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS ve_one");
            db.executeQuery("CREATE TABLE ve_one (a INTEGER, b INTEGER, c INTEGER)");
            openSchemaEditor('ve_one');
            let pk = document.querySelectorAll('#schemaColumnList .col-pk');
            pk[0].checked = true; pk[0].dispatchEvent(new Event('change'));
            pk = document.querySelectorAll('#schemaColumnList .col-pk'); // 再描画後に取り直す
            pk[1].checked = true; pk[1].dispatchEvent(new Event('change'));
            const ok = editingSchema.cols[0].pk === false && editingSchema.cols[1].pk === true && editingSchema.cols[2].pk === false;
            document.getElementById('schemaModal').classList.add('hidden');
            db.executeQuery("DROP TABLE IF EXISTS ve_one");
            return ok;
        }},

        // ============================================================
        // 3. 編集 ⇔ 実装コマンド(生成DDL) の整合性 (V9Consistency)
        //    エディタ保存の結果スキーマ と プレビューDDLを CREATE TABLE 実行した結果が一致すること
        // ============================================================
        { name: "V9Consistency: Editor Save == CREATE TABLE (constraints)", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS cc_src");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd");
            db.executeQuery("CREATE TABLE cc_src (id INTEGER, uname TEXT, status TEXT)");
            db.executeQuery("INSERT INTO cc_src (id, uname, status) VALUES (1, 'a', 'x'), (2, 'b', 'y'), (3, 'c', 'z')");
            openSchemaEditor('cc_src');
            // id: PK + AUTO_INC / uname: NOT NULL + UNIQUE / status: DEFAULT 'active'
            editingSchema.cols[0].pk = true; editingSchema.cols[0].autoInc = true;
            editingSchema.cols[1].notNull = true; editingSchema.cols[1].unique = true;
            editingSchema.cols[2].defaultText = "'active'";
            updateSchemaPreview();
            const { cmd, res } = runPreviewAs('cc_cmd', 'cc_src');
            document.getElementById('execSchemaSaveBtn').click();
            const editorSig = schemaSig(db.tables['cc_src']);
            const cmdSig = db.tables['cc_cmd'] ? schemaSig(db.tables['cc_cmd']) : '(no cmd table)';
            db.executeQuery("DROP TABLE IF EXISTS cc_src");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd");
            if (res.error) throw new Error("生成DDL実行エラー: " + res.error + " | DDL=" + cmd);
            if (editorSig !== cmdSig) throw new Error("不一致\n editor=" + editorSig + "\n cmd   =" + cmdSig);
            return true;
        }},
        { name: "V9Consistency: Editor Save == CREATE TABLE (column ops)", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS cc_src2");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd2");
            db.executeQuery("CREATE TABLE cc_src2 (col1 INTEGER, col2 TEXT, col3 TEXT)");
            db.executeQuery("INSERT INTO cc_src2 (col1, col2, col3) VALUES (1, 'a', 'x')");
            openSchemaEditor('cc_src2');
            // col1 -> pid(FLOAT), col2削除, col4追加, 並べ替え(col3を先頭)
            editingSchema.cols[0].newName = 'pid'; editingSchema.cols[0].type = 'FLOAT';
            editingSchema.cols[1].isDeleted = true;
            editingSchema.cols.push({ oldName: null, newName: 'col4', type: 'DATE', isNew: true, isDeleted: false, pk: false, notNull: false, unique: false, autoInc: false, defaultText: '' });
            const moved = editingSchema.cols.splice(2, 1)[0]; // col3
            editingSchema.cols.unshift(moved);
            updateSchemaPreview();
            const { cmd, res } = runPreviewAs('cc_cmd2', 'cc_src2');
            document.getElementById('execSchemaSaveBtn').click();
            const editorSig = schemaSig(db.tables['cc_src2']);
            const cmdSig = db.tables['cc_cmd2'] ? schemaSig(db.tables['cc_cmd2']) : '(no cmd table)';
            db.executeQuery("DROP TABLE IF EXISTS cc_src2");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd2");
            if (res.error) throw new Error("生成DDL実行エラー: " + res.error + " | DDL=" + cmd);
            if (editorSig !== cmdSig) throw new Error("不一致\n editor=" + editorSig + "\n cmd   =" + cmdSig);
            return true;
        }},
        { name: "V9Consistency: Editor Save == CREATE TABLE (default CURRENT_TIMESTAMP + number)", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS cc_src3");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd3");
            db.executeQuery("CREATE TABLE cc_src3 (id INTEGER, qty INTEGER, created TEXT)");
            db.executeQuery("INSERT INTO cc_src3 (id, qty, created) VALUES (1, 5, '2026-01-01 00:00:00')");
            openSchemaEditor('cc_src3');
            editingSchema.cols[0].pk = true;
            editingSchema.cols[1].defaultText = '0';
            editingSchema.cols[2].defaultText = 'CURRENT_TIMESTAMP';
            updateSchemaPreview();
            const { cmd, res } = runPreviewAs('cc_cmd3', 'cc_src3');
            document.getElementById('execSchemaSaveBtn').click();
            const editorSig = schemaSig(db.tables['cc_src3']);
            const cmdSig = db.tables['cc_cmd3'] ? schemaSig(db.tables['cc_cmd3']) : '(no cmd table)';
            db.executeQuery("DROP TABLE IF EXISTS cc_src3");
            db.executeQuery("DROP TABLE IF EXISTS cc_cmd3");
            if (res.error) throw new Error("生成DDL実行エラー: " + res.error + " | DDL=" + cmd);
            if (editorSig !== cmdSig) throw new Error("不一致\n editor=" + editorSig + "\n cmd   =" + cmdSig);
            return true;
        }},
        { name: "V9Consistency: Preview DDL Contains Constraint Tokens", fn: () => {
            db.executeQuery("DROP TABLE IF EXISTS cc_tok");
            db.executeQuery("CREATE TABLE cc_tok (id INTEGER, code TEXT)");
            openSchemaEditor('cc_tok');
            editingSchema.cols[0].pk = true; editingSchema.cols[0].autoInc = true;
            editingSchema.cols[1].unique = true; editingSchema.cols[1].notNull = true; editingSchema.cols[1].defaultText = "'n/a'";
            updateSchemaPreview();
            const ddl = document.getElementById('schemaPreviewText').textContent;
            const ok = /PRIMARY KEY/.test(ddl) && /AUTO_INCREMENT/.test(ddl) && /NOT NULL/.test(ddl) && /UNIQUE/.test(ddl) && /DEFAULT 'n\/a'/.test(ddl);
            document.getElementById('schemaModal').classList.add('hidden');
            db.executeQuery("DROP TABLE IF EXISTS cc_tok");
            return ok;
        }}
      ];
    }
