    // ============================================================================
    // [Test Suite V63] - データ画面（保存 / 読み込み / 入出力）の再編
    //
    //   v1.34 でサイドバーに並んでいた 6 つのボタン
    //   （Save DB / Load DB / Clear DB / Open File / Save / Save As）を
    //   データモーダルの「このブラウザ」「ファイル」タブへ移した。
    //   ボタン名だけでは「どこに残るのか」が読み取れなかったので、
    //   移した先では 1 件ずつ説明を付けている。
    //
    //   ここで見るのは
    //     ・サイドバーの入口が 1 つになっていること（迷う入口を増やしていない）
    //     ・移した操作がすべてモーダルの中から届くこと
    //     ・**すべての操作に説明が付いていること**（この再編の目的そのもの）
    //     ・押したときに実際に動くこと（配線が切れていないこと）
    //     ・保存状態の表示が実態を映すこと
    //   DOM に触るのでブラウザでのみ実行される（run-suite.mjs の対象外）。
    // ============================================================================
    function getV63Tests() {
      const { T, t, q, eq, expect, drop } = makeTestKit('V63');

      const $ = (id) => document.getElementById(id);
      const ids = (sel) => [...document.querySelectorAll(sel)].map(e => e.id);
      const openModalAt = (pane) => {
        if (typeof showDataTab === 'function') showDataTab(pane);
        $('dataModal').classList.remove('hidden');
      };
      const closeDataModal = () => $('dataModal').classList.add('hidden');
      // 移設した操作の一覧（ボタン id → どのタブに居るべきか）
      const MOVED = [
        ['saveIdbBtn', 'dataPaneBrowser'],
        ['loadIdbBtn', 'dataPaneBrowser'],
        ['clearIdbBtn', 'dataPaneBrowser'],
        ['fileOpenBtn', 'dataPaneFile'],
        ['fileSaveBtn', 'dataPaneFile'],
        ['fileSaveAsBtn', 'dataPaneFile']
      ];

      // ----------------------------------------------------------------
      // 1. サイドバー: 入口は 1 つだけになった
      // ----------------------------------------------------------------
      t('V63Nav サイドバーの入口はデータボタン 1 つ', () => {
        const side = ids('aside .p-2.border-b button');
        return eq(side, ['openDataBtn'], 'サイドバーのツールバーにあるボタン');
      });
      MOVED.forEach(([id]) => {
        t(`V63Nav ${id} はサイドバーから消えている`, () => !ids('aside button').includes(id));
      });
      t('V63Nav 入口のボタンには説明（title）が付いている', () => {
        const ttl = $('openDataBtn').getAttribute('title') || '';
        if (!/保存/.test(ttl) || !/Ctrl/.test(ttl)) throw new Error('title が説明になっていない: ' + ttl);
        return true;
      });
      t('V63Nav 入口のボタンは何の画面か文言で判る', () => {
        const txt = $('openDataBtn').textContent;
        return /保存/.test(txt) && /読み込み/.test(txt);
      });

      // ----------------------------------------------------------------
      // 2. モーダル: 5 つのタブと、移した操作の置き場所
      // ----------------------------------------------------------------
      t('V63Tab タブは 5 枚', () => document.querySelectorAll('#dataModal .dataTabBtn').length === 5);
      t('V63Tab タブとペインが 1 対 1 で対応する', () => {
        const panes = ids('#dataModal .dataPane');
        const tabs = [...document.querySelectorAll('#dataModal .dataTabBtn')].map(b => b.dataset.pane);
        return eq(tabs, panes, 'タブの data-pane とペインの id');
      });
      t('V63Tab 並びは このブラウザ → ファイル → 書き出し → 読み込み → テストデータ', () => {
        return eq(ids('#dataModal .dataPane'),
          ['dataPaneBrowser', 'dataPaneFile', 'dataPaneExport', 'dataPaneImport', 'dataPaneGen'], 'ペインの並び');
      });
      MOVED.forEach(([id, pane]) => {
        t(`V63Tab ${id} は ${pane} にある`, () => ids(`#${pane} button`).includes(id));
      });
      t('V63Tab 入口のボタンは「このブラウザ」で開く', () => {
        closeDataModal();
        $('openDataBtn').click();
        const shown = ids('#dataModal .dataPane').filter(id => !$(id).classList.contains('hidden'));
        const open = !$('dataModal').classList.contains('hidden');
        closeDataModal();
        return open && eq(shown, ['dataPaneBrowser'], '開いた直後に見えているペイン');
      });
      t('V63Tab どのタブへ切り替えても 1 枚だけ見える', () => {
        ids('#dataModal .dataPane').forEach(pane => {
          showDataTab(pane);
          const shown = ids('#dataModal .dataPane').filter(id => !$(id).classList.contains('hidden'));
          eq(shown, [pane], `${pane} を選んだとき`);
        });
        showDataTab('dataPaneBrowser');
        return true;
      });
      t('V63Tab 選んだタブだけが強調される', () => {
        showDataTab('dataPaneFile');
        const on = [...document.querySelectorAll('#dataModal .dataTabBtn')]
          .filter(b => b.classList.contains('border-blue-600')).map(b => b.dataset.pane);
        showDataTab('dataPaneBrowser');
        return eq(on, ['dataPaneFile'], '強調されているタブ');
      });
      t('V63Tab Esc で閉じられる', () => {
        $('dataModal').classList.remove('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return $('dataModal').classList.contains('hidden');
      });

      // ----------------------------------------------------------------
      // 3. 説明: すべての操作に「何をするのか」が書いてある
      //    （ボタンを移した理由そのものなので、機械的に全件を見る）
      // ----------------------------------------------------------------
      MOVED.forEach(([id]) => {
        t(`V63Doc ${id} には説明文が添えてある`, () => {
          const box = $(id).closest('div.border');
          if (!box) throw new Error('説明枠が見つからない');
          const p = box.querySelector('p');
          if (!p) throw new Error('説明段落が無い');
          const text = p.textContent.replace(/\s+/g, '');
          if (text.length < 30) throw new Error('説明が短すぎる: ' + text);
          return true;
        });
        t(`V63Doc ${id} には見出しが付いている`, () => {
          const box = $(id).closest('div.border');
          const head = box && box.querySelector('.font-semibold');
          return !!head && head.textContent.trim().length > 0;
        });
      });
      t('V63Doc このブラウザのタブに前置きがある', () => {
        const text = $('dataPaneBrowser').textContent;
        // 「どこに残るのか」「自動保存があること」「持ち出せないこと」を伝える
        return /自動保存/.test(text) && /IndexedDB/.test(text) && /他の端末/.test(text);
      });
      t('V63Doc ファイルのタブに前置きがある', () => {
        const text = $('dataPaneFile').textContent;
        return /\.luminadb/.test(text) && /持ち出/.test(text);
      });
      t('V63Doc 破壊的な操作は赤で、戻せないと書いてある', () => {
        const box = $('clearIdbBtn').closest('div.border');
        return /border-red/.test(box.className) && /元に戻せません/.test(box.textContent);
      });
      t('V63Doc 保存の近道（Ctrl+S）が画面に書いてある', () => {
        return /Ctrl \+ S/.test($('dataPaneBrowser').textContent)
            && /Ctrl \+ Shift \+ S/.test($('dataPaneFile').textContent);
      });
      t('V63Doc ショートカット一覧にも載っている', () => {
        const text = $('shortcutModal').textContent;
        return /Ctrl \+ S/.test(text) && /Ctrl \+ Shift \+ S/.test(text);
      });

      // ----------------------------------------------------------------
      // 4. 保存状態の表示
      // ----------------------------------------------------------------
      t('V63St サイドバーに保存状態の 1 行がある', () => {
        const line = $('storageStateLine');
        return !!line && /自動保存|保存中/.test(line.textContent);
      });
      t('V63St 保存状態には説明（title）が付く', () => {
        refreshStorageState();
        return /IndexedDB/.test($('storageStateLine').getAttribute('title') || '');
      });
      t('V63St モーダルを開くと今の規模が出る', () => {
        refreshStorageInfo();
        const text = $('idbStatusLine').textContent;
        if (!/いまのデータ:/.test(text)) throw new Error('規模が出ていない: ' + text);
        const tables = Object.keys(db.tables).filter(n => !n.startsWith('__tmp_') && !db.tables[n].isTemp).length;
        if (text.indexOf(`${tables} 表`) === -1) throw new Error(`${tables} 表 が出ていない: ` + text);
        return true;
      });
      t('V63St 表を足すと表示も増える', () => {
        drop('v63_tmp');
        refreshStorageInfo();
        const before = $('idbStatusLine').textContent;
        q('CREATE TABLE v63_tmp (a INT)');
        q('INSERT INTO v63_tmp VALUES (1), (2)');
        refreshStorageInfo();
        const after = $('idbStatusLine').textContent;
        drop('v63_tmp');
        refreshStorageInfo();
        if (before === after) throw new Error('表を足しても表示が変わらない');
        return true;
      });
      t('V63St 開いているファイルの有無が書いてある', () => {
        updateFileLabel();
        const text = $('openFileName').textContent;
        return /開いているファイル/.test(text);
      });
      t('V63St ファイルを開いていなければサイドバーの行は隠れる', () => {
        updateFileLabel();
        // テスト環境ではファイルを開いていないので隠れているのが正しい
        return $('openFileLabel').classList.contains('hidden');
      });
      t('V63St 未対応ブラウザ向けの注意書きは対応状況で切り替わる', () => {
        updateFileLabel();
        const hidden = $('fileApiNote').classList.contains('hidden');
        return hidden === !!luminaFsSupported();
      });

      // ----------------------------------------------------------------
      // 5. 配線: 押したときに実際に動く
      // ----------------------------------------------------------------
      t('V63Act 初期化ボタンは確認画面を出す（すぐには消さない）', () => {
        $('clearConfirmModal').classList.add('hidden');
        $('clearIdbBtn').click();
        const shown = !$('clearConfirmModal').classList.contains('hidden');
        $('clearConfirmModal').classList.add('hidden');
        return shown;
      });
      t('V63Act 上書き保存はファイルを開くまで押せない', () => $('fileSaveBtn').disabled === true);
      t('V63Act 保存・読み込みの入口は関数として生きている', () =>
        typeof window.saveDbToFile === 'function'
        && typeof window.openDbFromFile === 'function'
        && typeof window.refreshStorageInfo === 'function'
        && typeof window.refreshStorageState === 'function');
      t('V63Act Ctrl+S はブラウザ既定の動作を止める', () => {
        const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      t('V63Act Ctrl+Shift+D でデータ画面が開く', () => {
        closeDataModal();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        const open = !$('dataModal').classList.contains('hidden');
        const shown = ids('#dataModal .dataPane').filter(id => !$(id).classList.contains('hidden'));
        closeDataModal();
        return open && eq(shown, ['dataPaneBrowser'], 'Ctrl+Shift+D で見えるペイン');
      });
      t('V63Act 修飾キー無しの s は何も起こさない', () => {
        const ev = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        return !ev.defaultPrevented;
      });

      // ----------------------------------------------------------------
      // 6. 元からあった 3 タブが壊れていないこと
      // ----------------------------------------------------------------
      ['exportSqlBtn', 'exportJsonAllBtn'].forEach(id => {
        t(`V63Keep ${id} は書き出しタブに残っている`, () => ids('#dataPaneExport button').includes(id));
      });
      ['importSqlBtn', 'execCsvImportBtn'].forEach(id => {
        t(`V63Keep ${id} は読み込みタブに残っている`, () => ids('#dataPaneImport button').includes(id));
      });
      t('V63Keep テストデータの生成ボタンは残っている', () => ids('#dataPaneGen button').includes('generateBtn'));
      t('V63Keep 旧 id の openGeneratorBtn からテストデータタブへ行ける', () => {
        $('openGeneratorBtn').click();
        const shown = ids('#dataModal .dataPane').filter(id => !$(id).classList.contains('hidden'));
        showDataTab('dataPaneBrowser');
        return eq(shown, ['dataPaneGen'], 'openGeneratorBtn の行き先');
      });
      t('V63Zz 後始末', () => {
        closeDataModal();
        showDataTab('dataPaneBrowser');
        return !Object.keys(db.tables).some(n => n.indexOf('v63_') === 0);
      });

      return T;
    }
