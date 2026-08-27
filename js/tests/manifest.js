    // ============================================================================
    // [Tests manifest] - テストスイートを必要になってから読み込む
    //
    // 以前は 72 本すべてを LuminaDB.html の <script> で静的に読んでいた。
    // js/tests は 2.56MB / 38,594 行あり、製品コード（1.59MB）より大きいので、
    // 画面を開いた人全員がペイロードの 6 割をテストのために払っていた。
    //
    // ここでは並びだけを持ち、実際の読み込みは runtest / ?autotest=1 のときに行う。
    // 並び順は依存関係そのもの: test-helpers が先、test-suite.js が最後
    // （getVxxTests() を全部参照するため）。
    // ============================================================================
    const LUMINA_TEST_FILES = [
        'js/tests/test-helpers.js?v=2',
        'js/tests/test-suite-extra.js?v=16',
        'js/tests/test-suite-features.js?v=5',
        'js/tests/test-suite-fixes.js?v=2',
        'js/tests/test-suite-v2.js?v=4',
        'js/tests/test-suite-v3.js?v=2',
        'js/tests/test-suite-v4.js?v=2',
        'js/tests/test-suite-v5.js?v=2',
        'js/tests/test-suite-v6.js?v=3',
        'js/tests/test-suite-v7.js?v=3',
        'js/tests/test-suite-v8.js?v=2',
        'js/tests/test-suite-v9.js?v=1',
        'js/tests/test-suite-v10.js?v=2',
        'js/tests/test-suite-v11.js?v=1',
        'js/tests/test-suite-v12.js?v=3',
        'js/tests/test-suite-v13.js?v=5',
        'js/tests/test-suite-v14.js?v=6',
        'js/tests/test-suite-v15.js?v=2',
        'js/tests/test-suite-v16.js?v=3',
        'js/tests/test-suite-v17.js?v=5',
        'js/tests/test-suite-v18.js?v=4',
        'js/tests/test-suite-v19.js?v=3',
        'js/tests/test-suite-v20.js?v=4',
        'js/tests/test-suite-v21.js?v=2',
        'js/tests/test-suite-v22.js?v=3',
        'js/tests/test-suite-v23.js?v=5',
        'js/tests/test-suite-v24.js?v=3',
        'js/tests/test-suite-v25.js?v=4',
        'js/tests/test-suite-v26.js?v=4',
        'js/tests/test-suite-v27.js?v=6',
        'js/tests/test-suite-v28.js?v=4',
        'js/tests/test-suite-v29.js?v=5',
        'js/tests/test-suite-v30.js?v=4',
        'js/tests/test-suite-v31.js?v=4',
        'js/tests/test-suite-v32.js?v=5',
        'js/tests/test-suite-v33.js?v=8',
        'js/tests/test-suite-v34.js?v=3',
        'js/tests/test-suite-v35.js?v=2',
        'js/tests/test-suite-v36.js?v=2',
        'js/tests/test-suite-v37.js?v=2',
        'js/tests/test-suite-v38.js?v=2',
        'js/tests/test-suite-v39.js?v=2',
        'js/tests/test-suite-v40.js?v=2',
        'js/tests/test-suite-v41.js?v=2',
        'js/tests/test-suite-v42.js?v=2',
        'js/tests/test-suite-v43.js?v=2',
        'js/tests/test-suite-v44.js?v=2',
        'js/tests/test-suite-v45.js?v=2',
        'js/tests/test-suite-v46.js?v=2',
        'js/tests/test-suite-v47.js?v=2',
        'js/tests/test-suite-v48.js?v=2',
        'js/tests/test-suite-v49.js?v=2',
        'js/tests/test-suite-v50.js?v=2',
        'js/tests/test-suite-v51.js?v=2',
        'js/tests/test-suite-v52.js?v=2',
        'js/tests/test-suite-v53.js?v=2',
        'js/tests/test-suite-v54.js?v=2',
        'js/tests/test-suite-v55.js?v=2',
        'js/tests/test-suite-v56.js?v=2',
        'js/tests/test-suite-v57.js?v=1',
        'js/tests/test-suite-v58.js?v=1',
        'js/tests/test-suite-v59.js?v=1',
        'js/tests/test-suite-v60.js?v=1',
        'js/tests/test-suite-v61.js?v=1',
        'js/tests/test-suite-v62.js?v=2',
        'js/tests/test-suite-v63.js?v=1',
        'js/tests/test-suite-v64.js?v=2',
        'js/tests/test-suite-v65.js?v=1',
        'js/tests/test-suite-v66.js?v=1',
        'js/tests/test-suite-v67.js?v=1',
        'js/tests/test-suite-v68.js?v=2',
        'js/tests/test-suite-v69.js?v=1',
        'js/tests/test-suite-v70.js?v=2',
        'js/tests/test-suite-v71.js?v=2',
        'js/tests/test-suite.js?v=54',
    ];

    // 冪等。二度呼んでも読み込みは 1 回で、同じ Promise を返す
    let __luminaTestsPromise = null;
    function loadTestSuites() {
        if (__luminaTestsPromise) return __luminaTestsPromise;
        __luminaTestsPromise = (async () => {
            for (const src of LUMINA_TEST_FILES) {
                await new Promise((resolve, reject) => {
                    const el = document.createElement('script');
                    el.src = src;
                    el.onload = resolve;
                    el.onerror = () => reject(new Error('Failed to load ' + src));
                    document.head.appendChild(el);
                });
            }
            if (typeof runTestSuite !== 'function') throw new Error('runTestSuite did not load');
            return true;
        })();
        return __luminaTestsPromise;
    }
