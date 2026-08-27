    // ============================================================================
    // [Test Suite V64] - 画面表示の日本語 / 英語切り替え
    //
    //   v1.35 で入れた i18n の検査。狙いは 3 つ。
    //     1. **既定が日本語**であること（何もしなければ今までと同じ画面）
    //     2. 英語にしたとき **訳し漏れが無い**こと
    //        — 画面を歩いて日本語が残っていないかを機械的に見る。
    //          辞書へ足し忘れた文言はここで落ちる
    //     3. 何度切り替えても **原文へ戻せる**こと
    //        — 英語にした要素は「日本語らしさ」では見つからないので、
    //          原文を控えて往復する作りが要る（そこが壊れやすい）
    //   利用者のデータ（表名・結果・ログ）と SQL エンジンのエラーは訳さない。
    //   DOM に触るのでブラウザでのみ実行される（run-suite.mjs の対象外）。
    // ============================================================================
    function getV64Tests() {
      const { T, t, q, eq, expect } = makeTestKit('V64');

      const $ = (id) => document.getElementById(id);
      const JP = /[　-ヿ一-鿿]/;
      const norm = (s) => luminaI18nKey(s);
      // 訳した結果に日本語が残るのが正しいもの（日本語そのものを見せる SQL 例）
      const INTENDED_JP = new Set(Object.values(luminaI18nDict).filter(v => JP.test(v)).map(norm));

      // 画面に残っている日本語を集める（data-i18n-skip の領域と言語切替は対象外）
      const leftoverJa = () => {
        const out = [];
        const walk = (el) => {
          if (!el || el.nodeType !== 1) return;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) return;
          if (el.hasAttribute('data-i18n-skip')) return;
          ['title', 'placeholder', 'aria-label'].forEach(a => {
            const v = el.getAttribute(a);
            if (v && JP.test(v) && !INTENDED_JP.has(norm(v))) out.push(a + '=' + norm(v));
          });
          for (const n of el.childNodes) {
            if (n.nodeType === 3) {
              const s = norm(n.nodeValue);
              if (s && JP.test(s) && !INTENDED_JP.has(s)) out.push(s);
            } else if (n.nodeType === 1) walk(n);
          }
        };
        walk(document.body);
        return [...new Set(out)];
      };

      // 言語を元へ戻すための控え（テストが利用者の設定を書き換えたままにしない）
      let savedLang = 'ja';
      t('V64 fixture: 現在の言語を控える', () => {
        savedLang = luminaGetLang();
        return savedLang === 'ja' || savedLang === 'en';
      });

      // ----------------------------------------------------------------
      // 1. 既定と切り替えの土台
      // ----------------------------------------------------------------
      t('V64Ini 既定は日本語', () => {
        // localStorage に選択が無ければ日本語。ここでは「en 以外は ja」を確かめる
        let stored = null;
        try { stored = localStorage.getItem('luminadb_lang'); } catch (e) { stored = null; }
        if (stored === null) return luminaGetLang() === 'ja';
        return stored === 'ja' || stored === 'en';
      });
      t('V64Ini 入口の関数が揃っている', () =>
        typeof window.luminaSetLang === 'function'
        && typeof window.luminaGetLang === 'function'
        && typeof window.luminaApplyLang === 'function'
        && typeof window.i18nT === 'function');
      t('V64Ini 切り替えは 2 つのボタン', () => {
        const box = $('langToggle');
        const btns = box ? [...box.querySelectorAll('button[data-lang]')].map(b => b.dataset.lang) : [];
        return eq(btns, ['ja', 'en'], '切り替えボタン');
      });
      t('V64Ini 切り替え自体は訳さない', () => {
        // JP / EN はどちらの言語でも同じに見えないと、英語表示から日本語へ戻せない
        const label = (lang) => {
          luminaSetLang(lang);
          return [...$('langToggle').querySelectorAll('button[data-lang]')].map(b => b.textContent.trim());
        };
        const inJa = label('ja'), inEn = label('en');
        eq(inJa, ['JP', 'EN'], '日本語表示でのラベル');
        return eq(inEn, ['JP', 'EN'], '英語表示でのラベル');
      });
      t('V64Ini 切り替えの説明は両言語を併記する', () => {
        const titles = [...$('langToggle').querySelectorAll('button[data-lang]')].map(b => b.getAttribute('title') || '');
        // 片方の言語しか読めない利用者にも、どちらのボタンが何かが判ること
        return titles.every(x => /[　-ヿ一-鿿]/.test(x) && /[A-Za-z]/.test(x));
      });
      t('V64Ini 選んだ言語が強調される', () => {
        luminaSetLang('en');
        const en = $('langToggle').querySelector('button[data-lang="en"]');
        const ja = $('langToggle').querySelector('button[data-lang="ja"]');
        if (!en.classList.contains('bg-blue-600')) throw new Error('EN が強調されていない');
        if (ja.classList.contains('bg-blue-600')) throw new Error('日本語が強調されたまま');
        return en.getAttribute('aria-pressed') === 'true' && ja.getAttribute('aria-pressed') === 'false';
      });
      t('V64Ini html の lang 属性が変わる', () => {
        luminaSetLang('en');
        const en = document.documentElement.lang;
        luminaSetLang('ja');
        return en === 'en' && document.documentElement.lang === 'ja';
      });
      t('V64Ini 選択は localStorage に残る', () => {
        luminaSetLang('en');
        let v = null;
        try { v = localStorage.getItem('luminadb_lang'); } catch (e) { return true; }   // 使えない環境は対象外
        return v === 'en';
      });
      t('V64Ini 知らない言語は無視される', () => {
        luminaSetLang('ja');
        luminaSetLang('fr');
        return luminaGetLang() === 'ja';
      });

      // ----------------------------------------------------------------
      // 2. 訳し漏れが無いこと（この検査がこの機能の本体）
      // ----------------------------------------------------------------
      t('V64Cov 英語表示で日本語が残らない（通常画面）', () => {
        luminaSetLang('en');
        const left = leftoverJa();
        if (left.length) throw new Error(`${left.length} 件残っている: ` + left.slice(0, 3).join(' / '));
        return true;
      });
      t('V64Cov 英語表示で日本語が残らない（モーダルを開いた状態）', () => {
        ['dataModal', 'helpModal', 'shortcutModal', 'historyModal', 'clearConfirmModal'].forEach(id => {
          const el = $(id); if (el) el.classList.remove('hidden');
        });
        if (typeof showDataTab === 'function') showDataTab('dataPaneBrowser');
        luminaSetLang('en');
        const left = leftoverJa();
        ['dataModal', 'helpModal', 'shortcutModal', 'historyModal', 'clearConfirmModal'].forEach(id => {
          const el = $(id); if (el) el.classList.add('hidden');
        });
        if (left.length) throw new Error(`${left.length} 件残っている: ` + left.slice(0, 3).join(' / '));
        return true;
      });
      t('V64Cov データ画面の全タブに漏れが無い', () => {
        $('dataModal').classList.remove('hidden');
        const panes = ['dataPaneBrowser', 'dataPaneFile', 'dataPaneExport', 'dataPaneImport', 'dataPaneGen'];
        const bad = [];
        panes.forEach(p => {
          showDataTab(p);
          luminaSetLang('en');
          leftoverJa().forEach(s => bad.push(p + ': ' + s));
        });
        showDataTab('dataPaneBrowser');
        $('dataModal').classList.add('hidden');
        if (bad.length) throw new Error(bad.slice(0, 3).join(' / '));
        return true;
      });
      t('V64Cov コマンドリファレンスも訳される', () => {
        luminaSetLang('en');
        if (typeof renderHelpCommands === 'function') renderHelpCommands();
        const enValues = new Set(Object.values(luminaI18nDict).map(norm));
        const left = [...document.querySelectorAll('#helpContent span')]
          .map(s => norm(s.textContent))
          // {table} は表名へ差し替わって出るので、辞書の値と完全一致しないものだけを見る
          .filter(s => JP.test(s) && !enValues.has(s) && !INTENDED_JP.has(s)
                       && ![...INTENDED_JP].some(v => v.indexOf('{table}') !== -1));
        if (left.length) throw new Error(left.slice(0, 2).join(' / '));
        return true;
      });

      // ----------------------------------------------------------------
      // 3. 往復できること
      // ----------------------------------------------------------------
      const ROUND = [
        ['openDataBtn', el => el.textContent.trim()],
        ['openHelpBtn', el => el.getAttribute('title')],
        ['schemaSearch', el => el.getAttribute('placeholder')],
        ['storageStateLine', el => el.textContent.trim()]
      ];
      t('V64Rt 日本語 → 英語 → 日本語 で原文へ戻る', () => {
        luminaSetLang('ja');
        const before = ROUND.map(([id, f]) => $(id) ? f($(id)) : null);
        luminaSetLang('en');
        const mid = ROUND.map(([id, f]) => $(id) ? f($(id)) : null);
        luminaSetLang('ja');
        const after = ROUND.map(([id, f]) => $(id) ? f($(id)) : null);
        ROUND.forEach(([id], i) => {
          if (before[i] === mid[i]) throw new Error(`${id} が英語で変わっていない`);
          if (before[i] !== after[i]) throw new Error(`${id} が戻らない: ${before[i]} → ${after[i]}`);
        });
        return true;
      });
      t('V64Rt 何度往復しても崩れない', () => {
        luminaSetLang('ja');
        const first = $('openDataBtn').innerHTML;
        for (let i = 0; i < 5; i++) { luminaSetLang('en'); luminaSetLang('ja'); }
        return eq($('openDataBtn').innerHTML, first, '5 往復後の中身');
      });
      t('V64Rt 同じ言語を続けて指定しても壊れない', () => {
        luminaSetLang('en');
        const a = $('openDataBtn').textContent.trim();
        luminaSetLang('en');
        return eq($('openDataBtn').textContent.trim(), a, '同じ言語を 2 回');
      });
      t('V64Rt 文中の印（span / code）が残る', () => {
        luminaSetLang('en');
        const box = $('dataPaneBrowser');
        if (!box.querySelector('span.font-semibold')) throw new Error('英語で強調の span が消えた');
        luminaSetLang('ja');
        if (!box.querySelector('span.font-semibold')) throw new Error('日本語へ戻したとき span が消えた');
        return true;
      });

      // ----------------------------------------------------------------
      // 4. i18nT（JS が組み立てる文言）
      // ----------------------------------------------------------------
      t('V64Fn 辞書にある語は訳される', () => {
        luminaSetLang('en');
        return i18nT('保存') === 'Save';
      });
      t('V64Fn 日本語表示ではそのまま', () => {
        luminaSetLang('ja');
        return i18nT('保存') === '保存';
      });
      t('V64Fn 辞書に無い語はそのまま返る', () => {
        luminaSetLang('en');
        return i18nT('__v64_未登録の文言__') === '__v64_未登録の文言__';
      });
      t('V64Fn {0} に引数が入る', () => {
        luminaSetLang('en');
        return i18nT('保存エラー: {0}', 'disk full') === 'Save failed: disk full';
      });
      t('V64Fn 引数は順番を入れ替えられる', () => {
        luminaSetLang('en');
        // 英語では「{1} of {0} tables written」と語順が変わる
        const s = i18nT('前回の保存: {0} 表中 {1} 表を書き込み（{2} 表は変更なしで省略）', 9, 2, 7);
        return /2 of 9/.test(s) && /7 unchanged/.test(s);
      });
      t('V64Fn 足りない引数は {n} のまま残す', () => {
        luminaSetLang('en');
        return i18nT('保存エラー: {0}') === 'Save failed: {0}';
      });
      t('V64Fn 空白の揺れを吸収する', () => {
        luminaSetLang('en');
        return i18nT('  保存 ') === 'Save';
      });
      t('V64Fn null / undefined でも落ちない', () => {
        luminaSetLang('en');
        return i18nT(null) === null && i18nT(undefined) === undefined;
      });

      // ----------------------------------------------------------------
      // 5. 辞書そのものの健全性
      // ----------------------------------------------------------------
      t('V64Dic 空の訳が無い', () => {
        const bad = Object.keys(luminaI18nDict).filter(k => !String(luminaI18nDict[k] || '').trim());
        if (bad.length) throw new Error('空の訳: ' + bad.slice(0, 3).join(' / '));
        return true;
      });
      t('V64Dic {0} の個数が原文と訳で合う', () => {
        const bad = [];
        Object.keys(luminaI18nDict).forEach(k => {
          const a = (k.match(/\{\d+\}/g) || []).sort().join(',');
          const b = (String(luminaI18nDict[k]).match(/\{\d+\}/g) || []).sort().join(',');
          if (a !== b) bad.push(k.slice(0, 40) + ' :: ' + a + ' vs ' + b);
        });
        if (bad.length) throw new Error(bad.slice(0, 3).join(' / '));
        return true;
      });
      t('V64Dic 畳んだキーでも引ける', () => {
        // 辞書は読みやすさのため改行を含んだまま書いてある。
        // 畳んだ形の別名が無いと、複数行の SQL 例だけが黙って訳されない
        const multi = Object.keys(luminaI18nDict).filter(k => /\n/.test(k));
        const missing = multi.filter(k => luminaI18nDict[norm(k)] === undefined);
        if (missing.length) throw new Error(`${missing.length} 件が畳んだ形で引けない`);
        return true;
      });
      t('V64Dic 英訳に全角の句読点が紛れていない', () => {
        const bad = Object.keys(luminaI18nDict).filter(k => {
          const v = String(luminaI18nDict[k]);
          return /[、。（）「」]/.test(v) && !JP.test(k.replace(/[^　-ヿ一-鿿]/g, '')) === false && !/[ぁ-ヿ一-鿿]/.test(v);
        });
        if (bad.length) throw new Error(bad.slice(0, 3).join(' / '));
        return true;
      });

      // ----------------------------------------------------------------
      // 6. 訳さないもの
      // ----------------------------------------------------------------
      t('V64Skip 表名は訳されない（利用者のデータ）', () => {
        luminaSetLang('en');
        if (typeof renderTree === 'function') renderTree();
        const names = [...document.querySelectorAll('#tableTree .table-select-btn')].map(b => b.textContent.trim());
        // サンプルの users / products / orders がそのまま出ていること
        return names.some(n => n.indexOf('users') === 0);
      });
      t('V64Skip SQL エンジンのエラーは英語のまま', () => {
        luminaSetLang('ja');
        const r = q('SELECT * FROM v64_nosuch_table');
        if (!r.error) throw new Error('エラーにならなかった');
        if (JP.test(r.error)) throw new Error('日本語が混ざっている: ' + r.error);
        return /not found/i.test(r.error);
      });
      t('V64Skip 英語表示でもエラー文言は同じ', () => {
        luminaSetLang('ja');
        const a = q('SELECT * FROM v64_nosuch_table').error;
        luminaSetLang('en');
        const b = q('SELECT * FROM v64_nosuch_table').error;
        return eq(a, b, 'エラー文言');
      });
      t('V64Skip 結果セルは訳されない', () => {
        luminaSetLang('en');
        q('DROP TABLE IF EXISTS v64_t');
        q("CREATE TABLE v64_t (a TEXT)");
        q("INSERT INTO v64_t VALUES ('保存')");   // 辞書にある語をデータとして入れる
        const v = q('SELECT a FROM v64_t').data[0].a;
        q('DROP TABLE v64_t');
        return eq(v, '保存', '結果の値');
      });

      // ----------------------------------------------------------------
      // 7. 後始末（利用者の選択を戻す）
      // ----------------------------------------------------------------
      t('V64Zz 言語を元へ戻す', () => {
        luminaSetLang(savedLang);
        return luminaGetLang() === savedLang;
      });

      return T;
    }
