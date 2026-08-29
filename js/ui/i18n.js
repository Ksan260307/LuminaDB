    // ============================================================================
    // [i18n] - 画面表示の日本語 / 英語切り替え（既定は日本語）
    //
    //   方針:
    //   ・**日本語を原文**として扱う。HTML には日本語がそのまま書いてあり、
    //     英語表示のときだけ辞書で差し替える。JS が無効でも日本語は読める。
    //   ・辞書のキーは日本語の原文そのもの（正規化して空白を畳んだもの）。
    //     キー名を別に発明すると、HTML と辞書の二重管理になって必ずずれる。
    //   ・静的な画面（HTML に直接書かれた文言）は DOM を歩いて拾う。
    //     JS が組み立てる文言は i18nT('日本語') で包む。
    //   ・原文は WeakMap に退避してから差し替えるので、切り替えは何度でも往復できる。
    //
    //   翻訳の単位:
    //     子要素が inline（span / code / kbd / b / a など）だけの要素は innerHTML ごと。
    //     そうでない要素は、直下のテキストノードを 1 つずつ。
    //     これで「文の途中に <code> が挟まる」文章を切らずに訳せる。
    //
    //   訳さないもの:
    //     ・利用者のデータ（表名・列名・結果セル・履歴・ログ・ER 図）
    //       → data-i18n-skip を付けた領域は歩かない。
    //     ・SQL エンジンのエラーメッセージ（元から英語）。
    // ============================================================================

    const LUMINA_LANGS = ['ja', 'en'];
    const LUMINA_LANG_KEY = 'luminadb_lang';

    // 日本語（原文）→ 英語。生成物ではなく人が読む表なので、画面の並び順に近い形で持つ
    const LUMINA_I18N_EN = Object.create(null);

    // 全角・半角の揺れと連続空白を畳んでキーにする（HTML の改行やインデントを無視するため）
    function i18nKey(s) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    // 現在の言語。localStorage に無ければ日本語
    let luminaLang = 'ja';
    try {
        const saved = localStorage.getItem(LUMINA_LANG_KEY);
        if (LUMINA_LANGS.includes(saved)) luminaLang = saved;
    } catch (e) { /* プライベートモード等で localStorage が使えない場合は既定のまま */ }

    function getLang() { return luminaLang; }

    // JS が組み立てる文言の翻訳。
    //   i18nT('保存しました。')
    //   i18nT('保存エラー: {0}', e.message)   // {0} {1} ... に引数を埋める
    // 辞書に無い語はそのまま返す（＝日本語のまま出る。壊れるより読めるほうがよい）
    function i18nT(ja, ...args) {
        const key = i18nKey(ja);
        let out = (luminaLang === 'en' && LUMINA_I18N_EN[key] !== undefined) ? LUMINA_I18N_EN[key] : ja;
        if (args.length) out = String(out).replace(/\{(\d+)\}/g, (m, i) => {
            const v = args[Number(i)];
            return v === undefined ? m : String(v);
        });
        return out;
    }

    // 数えられる名詞の単複。
    //   i18nPlural(1, 'エラー', 'error', 'errors')  -> ja: 'エラー 1 件' / en: '1 error'
    // 日本語には単複が無いので助数詞を付けるだけ、英語だけ 1 とそれ以外で語を替える。
    // 「(1 errors)」のような崩れを一箇所で防ぐ
    function i18nPlural(n, jaNoun, enOne, enMany, jaCounter = '件') {
        const c = Number(n);
        if (luminaLang === 'en') return `${c.toLocaleString()} ${c === 1 ? enOne : enMany}`;
        return `${jaNoun} ${c.toLocaleString()} ${jaCounter}`;
    }

    // ------------------------------------------------------------------
    // DOM 走査
    // ------------------------------------------------------------------
    // 日本語らしさの判定。かな・カナ・漢字に加え、句読点や全角記号（「」、。・）も見る
    const I18N_JP = /[　-ヿ一-鿿＀-￯]/;
    // 文章の途中に置ける要素。これだけで構成される要素は innerHTML ごと訳す
    const I18N_INLINE = new Set(['SPAN', 'CODE', 'KBD', 'B', 'STRONG', 'EM', 'I', 'U', 'A',
                                 'SMALL', 'BR', 'SUP', 'SUB', 'ABBR', 'MARK', 'SVG', 'PATH', 'G']);
    // 中に入れ替えてはいけないもの（状態を持つ / JS が参照する）
    const I18N_STATEFUL = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'CANVAS', 'IFRAME']);
    // 表示されない・触ってはいけない要素（中の日本語はコメントや設定値）
    const I18N_OPAQUE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
    const I18N_ATTRS = ['title', 'placeholder', 'aria-label'];

    // 原文の退避先。要素・テキストノードごとに 1 回だけ記録する
    const i18nOriginalHtml = new WeakMap();   // Element -> innerHTML
    const i18nOriginalText = new WeakMap();   // Text    -> nodeValue
    const i18nOriginalAttr = new WeakMap();   // Element -> { attr: value }

    // 訳す単位かどうか。
    // **一度訳した要素は英語になっているので「日本語らしさ」では見つからない**。
    // 原文を控えてある要素は、いまの中身が何語でも対象として扱う（往復できるように）
    function i18nIsUnit(el) {
        if (I18N_STATEFUL.has(el.tagName)) return false;
        if (el.querySelector && el.querySelector('input, select, textarea, canvas, iframe')) return false;
        // 中に「訳さない領域」を含む要素は単位にしない。
        //
        // 単位は innerHTML ごと差し替えるので、実行時に中身が変わる span
        // （件数・表名・セル値など）を巻き込むと
        //   ・辞書のキーにその span のマークアップまで入り、書き換えのたびにずれる
        //   ・見出しの文言が「訳せない単位」の一部になって永久に日本語のまま残る
        // ということが起きる。実際、モーダル見出しを日本語化したときに
        // 「クエリ履歴」「列プロファイル:」「スキーマ図」「セルの値:」と
        // メトリクスの「実行時間」「件数」が、辞書にキーがあるのに訳されなかった。
        // ここで壁にすると走査が中へ入り、見出しの文字だけがテキストノードとして訳される
        if (el.querySelector && el.querySelector('[data-i18n-skip]')) return false;
        for (const c of el.children) if (!I18N_INLINE.has(c.tagName)) return false;
        return i18nOriginalHtml.has(el) || I18N_JP.test(el.textContent || '');
    }

    // 訳す対象（要素の innerHTML / テキストノード / 属性）を集める。
    // 集めるだけで書き換えない（原文の退避と差し替えは applyLang が行う）
    function i18nCollect(root) {
        const units = [], texts = [], attrs = [];
        const walk = (el) => {
            if (!el || el.nodeType !== 1) return;
            if (I18N_OPAQUE.has(el.tagName)) return;
            if (el.hasAttribute('data-i18n-skip')) return;
            const savedAttrs = i18nOriginalAttr.get(el);
            I18N_ATTRS.forEach(a => {
                const v = el.getAttribute(a);
                if (v && (I18N_JP.test(v) || (savedAttrs && savedAttrs[a] !== undefined))) attrs.push({ el, attr: a });
            });
            if (i18nIsUnit(el)) { units.push(el); return; }
            for (const node of el.childNodes) {
                if (node.nodeType === 3) {
                    if (I18N_JP.test(node.nodeValue || '') || i18nOriginalText.has(node)) texts.push(node);
                } else if (node.nodeType === 1) {
                    walk(node);
                }
            }
        };
        walk(root || document.body);
        return { units, texts, attrs };
    }

    // 前後の空白を保ったまま中身だけ差し替える（インライン要素の間隔を崩さないため）
    function i18nSwapText(original, lang) {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
        const body = m[2];
        const key = i18nKey(body);
        const en = LUMINA_I18N_EN[key];
        const next = (lang === 'en' && en !== undefined) ? en : body;
        return m[1] + next + m[3];
    }

    // 画面全体を指定の言語で描き直す
    function applyLang(lang, root) {
        if (!LUMINA_LANGS.includes(lang)) return;
        luminaLang = lang;
        const { units, texts, attrs } = i18nCollect(root);
        units.forEach(el => {
            if (!i18nOriginalHtml.has(el)) i18nOriginalHtml.set(el, el.innerHTML);
            const ja = i18nOriginalHtml.get(el);
            const en = LUMINA_I18N_EN[i18nKey(ja)];
            const next = (lang === 'en' && en !== undefined) ? en : ja;
            if (el.innerHTML !== next) el.innerHTML = next;
        });
        texts.forEach(node => {
            if (!i18nOriginalText.has(node)) i18nOriginalText.set(node, node.nodeValue);
            const next = i18nSwapText(i18nOriginalText.get(node), lang);
            if (node.nodeValue !== next) node.nodeValue = next;
        });
        attrs.forEach(({ el, attr }) => {
            let saved = i18nOriginalAttr.get(el);
            if (!saved) { saved = Object.create(null); i18nOriginalAttr.set(el, saved); }
            if (saved[attr] === undefined) saved[attr] = el.getAttribute(attr);
            const ja = saved[attr];
            const en = LUMINA_I18N_EN[i18nKey(ja)];
            el.setAttribute(attr, (lang === 'en' && en !== undefined) ? en : ja);
        });
        document.documentElement.lang = lang;
        i18nUpdateToggle();
        i18nRerender();
        return { units: units.length, texts: texts.length, attrs: attrs.length };
    }

    // JS が描いている領域を描き直す。DOM 走査では拾えない（原文が残っていない）ので、
    // それぞれの描画関数をもう一度呼ぶ。存在しない段階でも落ちないように守る
    function i18nRerender() {
        [
            'renderTree',            // 表一覧（⚙ などのラベル）
            'renderHelpCommands',    // コマンドリファレンス
            'renderConsole',         // 実行ログ
            'refreshStorageInfo',    // データ画面の保存状態
            'renderEditorTabs'       // エディタタブ
        ].forEach(fn => {
            try { if (typeof window[fn] === 'function') window[fn](); } catch (e) { /* 描画前なら何もしない */ }
        });
    }

    function setLang(lang) {
        if (!LUMINA_LANGS.includes(lang)) return getLang();
        try { localStorage.setItem(LUMINA_LANG_KEY, lang); } catch (e) { /* 保存できなくても切り替えは効く */ }
        applyLang(lang);
        return getLang();
    }

    // ------------------------------------------------------------------
    // 切り替えボタン（サイドバー見出しの「日本語 / EN」）
    // ------------------------------------------------------------------
    function i18nUpdateToggle() {
        const box = document.getElementById('langToggle');
        if (!box) return;
        box.querySelectorAll('button[data-lang]').forEach(b => {
            const on = b.dataset.lang === luminaLang;
            b.classList.toggle('bg-blue-600', on);
            b.classList.toggle('text-white', on);
            b.classList.toggle('text-gray-500', !on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    // 辞書のキーを引きやすい形へ揃える。
    // 辞書は読みやすさのために改行や連続空白を含んだまま書いてあるが、
    // 引くときは i18nKey で畳んだ形になる。畳んだ別名を足しておかないと、
    // **複数行の SQL 例だけが黙って訳されない**（画面では気づきにくい）
    function i18nNormalizeDict() {
        Object.keys(LUMINA_I18N_EN).forEach(k => {
            const norm = i18nKey(k);
            if (norm !== k && LUMINA_I18N_EN[norm] === undefined) LUMINA_I18N_EN[norm] = LUMINA_I18N_EN[k];
        });
    }

    function initI18n() {
        i18nNormalizeDict();
        const box = document.getElementById('langToggle');
        if (box) {
            box.querySelectorAll('button[data-lang]').forEach(b => {
                b.addEventListener('click', () => setLang(b.dataset.lang));
            });
        }
        applyLang(luminaLang);
    }

    window.luminaSetLang = setLang;
    window.luminaGetLang = getLang;
    window.luminaApplyLang = applyLang;
    window.luminaI18nCollect = i18nCollect;
    window.luminaI18nDict = LUMINA_I18N_EN;
    window.luminaI18nKey = i18nKey;
    window.i18nT = i18nT;
