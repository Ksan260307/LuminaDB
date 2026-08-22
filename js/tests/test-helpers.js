    // ============================================================================
    // [Test Helpers] - テストスイートが共通で使う道具立て
    //
    //   「書き味」スイート（test-suite-v51.js 〜 v56.js）は、同じ意味のクエリを
    //   書き方だけ変えて突き合わせる形が共通なので、その足回りをここへ集めてある。
    //   各スイートは先頭で
    //
    //       const K = makeTestKit('V51');
    //       const { T, q, t, same, err, outside, wsPos, swap, tag } = K;
    //
    //   のように受け取り、最後に `return T;` する。
    //   スイート固有の比較（v52 の sameWhere、v55 の dmlSame など）は
    //   この道具立ての上に 2〜3 行で書ける。
    //
    //   `db` は実行時のグローバル（ブラウザでは main.js、ヘッドレスでは
    //   test/run-suite.mjs が用意する）。ここでは呼び出し時に参照する。
    // ============================================================================
    // ------------------------------------------------------------------------
    // テスト定義そのものを作る小さな工場。
    // 配列リテラルで書くスイート（test-suite-v2.js 〜 v12.js など）は
    // makeTestKit を使わないので、こちらを直接並べる。
    //   errCase('...', 'SELECT ...', 'syntax'),
    // makeTestKit の err / ok もこの実装を共有する
    // ------------------------------------------------------------------------
    // 拒否されるべき文（frag を渡すとエラー文にその語が含まれることも見る。大小文字は無視）
    function errCase(name, sql, frag) {
      return {
        name, sql, isErrorExpected: true,
        check: r => !!r.error && (!frag || r.error.toLowerCase().includes(String(frag).toLowerCase()))
      };
    }
    // 通りさえすればよい文
    function okCase(name, sql) {
      return { name, sql, check: r => !r.error };
    }
    // DDL / DML のように `Result: 'Success'` を返す文
    function successCase(name, sql) {
      return { name, sql, check: r => !r.error && r.data[0].Result === 'Success' };
    }
    // 1 行 1 列の値を確かめる文
    function valCase(name, sql, want) {
      return {
        name, sql,
        check: r => !r.error && r.data.length > 0
          && JSON.stringify(Object.values(r.data[0])[0]) === JSON.stringify(want)
      };
    }

    function makeTestKit(prefix) {
      const T = [];
      const q = (sql) => db.executeQuery(sql);

      // ------------------------------------------------------------
      // テストの登録
      // ------------------------------------------------------------
      // 関数で書くテスト（true を返せば成功）
      const t = (name, fn) => T.push({ name, fn });
      // SQL とチェック関数で書くテスト（test-suite.js の実行ループが直接扱う形）
      const check = (name, sql, fn) => T.push({ name, sql, check: fn });
      // 成功しさえすればよい文 / 拒否されるべき文（実体は上の工場と同じ）
      const ok = (name, sql) => T.push(okCase(name, sql));
      const err = (name, sql, frag) => T.push(errCase(name, sql, frag));

      // ------------------------------------------------------------
      // 結果の取り出しと比較
      // ------------------------------------------------------------
      const rowsOf = (sql) => { const r = q(sql); if (r.error) throw new Error(r.error); return r.data || []; };
      // 列名は書き方で変わり得る（別名の付け外し）ので、値の並びだけを比べる
      const valsOf = (sql) => JSON.stringify(rowsOf(sql).map(r => Object.values(r)));
      const oneOf = (sql) => { const d = rowsOf(sql); if (!d.length) throw new Error('no rows'); return Object.values(d[0])[0]; };

      // エラーを投げずに「そのまま比べられる値」を返す版。
      // 失敗を throw ではなく値（`{__err}` / `['ERR:...']`）で受け取りたいテストが使う
      const oneSafe = (sql) => { const r = q(sql); return r.error ? { __err: r.error } : Object.values(r.data[0])[0]; };
      const colSafe = (sql, k) => { const r = q(sql); return r.error ? ['ERR:' + r.error] : r.data.map(x => x[k]); };
      const idsSafe = (sql) => colSafe(sql, 'id');
      const keysSafe = (sql) => { const r = q(sql); return r.error ? ['ERR:' + r.error] : Object.keys(r.data[0] || {}); };

      // ------------------------------------------------------------
      // 値の比較（模型側の期待値と突き合わせる差分テスト用）
      // ------------------------------------------------------------
      // JSON 文字列にして厳密比較する（配列・オブジェクトもそのまま比べられる）
      const eq = (a, b, label) => {
        const x = JSON.stringify(a), y = JSON.stringify(b);
        if (x !== y) throw new Error((label ? label + ' ' : '') + 'expected ' + y + ' but got ' + x);
        return true;
      };
      // 数値どうしは最下位桁のずれを許す（参照実装と演算順序が違うだけの差を拾わない）
      const numEq = (a, b) => (typeof a === 'number' && typeof b === 'number')
        ? Math.abs(a - b) < 1e-9 : a === b;
      const expect = (actual, want, label) => {
        if (!numEq(actual, want)) {
          throw new Error((label ? label + ' ' : '') + 'expected ' + JSON.stringify(want)
            + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectNear = (actual, want, eps, label) => {
        if (typeof actual !== 'number' || Math.abs(actual - want) > (eps === undefined ? 1e-6 : eps)) {
          throw new Error((label ? label + ' ' : '') + 'expected ~' + want + ' but got ' + JSON.stringify(actual));
        }
        return true;
      };
      const expectDeep = eq;
      const valNear = (name, sql, want, eps) => t(name, () => expectNear(oneOf(sql), want, eps));
      const approx = (a, b) => a != null && Math.abs(a - b) < 1e-6;
      // MySQL 互換 ROUND（ゼロから遠い方向へ丸める）の JS 参照
      const mround = (x, d) => { const f = Math.pow(10, d || 0); return Math.sign(x) * Math.round(Math.abs(x) * f) / f; };

      // ------------------------------------------------------------
      // 模型（JavaScript 側で組む期待値）を作るための小道具
      // ------------------------------------------------------------
      const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
      const cnt = (arr, f) => arr.filter(f).length;
      const uniq = (arr, f) => new Set(arr.map(f)).size;
      const byKey = (arr, keyf) => {
        const m = new Map();
        for (const x of arr) { const k = keyf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
        return m;
      };

      // セキュリティテストのカナリア: ペイロードが JS として評価されたら真になる印が
      // どこにも付いていないこと（グローバル・オブジェクト・配列のプロトタイプ汚染）
      const canaryClean = () => {
        const p = '__' + String(prefix).toLowerCase() + '_';
        return window[p + 'pwned'] === undefined
          && ({})[p + 'polluted'] === undefined
          && Object.prototype[p + 'polluted'] === undefined
          && [][p + 'polluted'] === undefined;
      };

      // 基準（1 行で書いた形）の結果は 1 回だけ実行して使い回す
      const canonCache = Object.create(null);
      const canon = (sql) => {
        if (!(sql in canonCache)) canonCache[sql] = valsOf(sql);
        return canonCache[sql];
      };
      // 基準と変種が同じ結果になること
      const same = (name, base, variant) => t(name, () => {
        const want = canon(base);
        const got = valsOf(variant);
        if (got !== want) {
          throw new Error('expected ' + want.slice(0, 200) + ' but got ' + got.slice(0, 200)
            + ' :: ' + variant.replace(/\s+/g, ' ').slice(0, 160));
        }
        return true;
      });
      // 「同じに見えて同じではない」ことを記録する（仕様として残す）
      const differs = (name, a, b) => t(name, () => {
        const x = valsOf(a), y = valsOf(b);
        if (x === y) throw new Error('両者は異なるはずだが同じ結果になった: ' + x.slice(0, 120));
        return true;
      });
      // 1 行 1 列の値を直に確かめる
      const val = (name, sql, want) => t(name, () => eq(oneOf(sql), want, sql));

      // ------------------------------------------------------------
      // SQL 文字列の機械的な変換（書き味テストの中核）
      // ------------------------------------------------------------
      // 文字列リテラルの外側だけに f を適用する。
      // リテラルまで変換すると 'HR' が 'hr' になって別の条件になってしまう
      const outside = (sql, f) => {
        let out = '', cur = '', inStr = false;
        for (let i = 0; i < sql.length; i++) {
          const c = sql[i];
          if (c === "'") {
            if (inStr) { out += cur + c; cur = ''; inStr = false; }
            else { out += f(cur); cur = c; inStr = true; }
            continue;
          }
          cur += c;
        }
        return out + (inStr ? cur : f(cur));
      };
      const upper = (sql) => outside(sql, x => x.toUpperCase());
      const lower = (sql) => outside(sql, x => x.toLowerCase());
      const alternating = (sql) => outside(sql,
        x => x.split('').map((c, i) => i % 2 ? c.toLowerCase() : c.toUpperCase()).join(''));
      // 語の区切りの空白をまとめて置き換える（改行・タブ・複数空白・CRLF）
      const spaced = (sql, sep) => outside(sql, x => x.split(' ').join(sep));

      // リテラルの外側にある空白の位置（1 個ずつ差し替える総当たりに使う）
      const wsPos = (sql) => {
        const p = [];
        let inStr = false;
        for (let i = 0; i < sql.length; i++) {
          const c = sql[i];
          if (c === "'") { inStr = !inStr; continue; }
          if (!inStr && c === ' ') p.push(i);
        }
        return p;
      };
      // i 文字目（空白）を text へ差し替える
      const swap = (sql, i, text) => sql.slice(0, i) + text + sql.slice(i + 1);
      // テスト名に載せる短い見出し（どのクエリで落ちたかが判るように）
      const tag = (sql, len) => sql.replace(/\s+/g, ' ').slice(0, len || 46);

      // ------------------------------------------------------------
      // フィクスチャの組み立てと片付け
      // ------------------------------------------------------------
      // JS の値を SQL リテラルへ（NULL と引用符の取り扱いを 1 か所へ寄せる）
      const lit = (v) => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return String(v);
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return "'" + String(v).split("'").join("''") + "'";
      };
      // 行の配列（各行は値の配列）を 1 本の INSERT で流し込む
      const insertRows = (table, rows) => {
        if (!rows.length) return;
        q('INSERT INTO ' + table + ' VALUES '
          + rows.map(r => '(' + r.map(lit).join(', ') + ')').join(', '));
      };
      const drop = (...names) => names.forEach(n => q('DROP TABLE IF EXISTS ' + n));
      // 最後に置く後片付け。接頭辞で始まる表が残っていないことも確かめる
      const cleanup = (...names) => t(`${prefix}Zz cleanup`, () => {
        drop(...names);
        const left = prefix.toLowerCase() + '_';
        return Object.keys(db.tables).filter(n => n.indexOf(left) === 0).length === 0;
      });

      return { T, q, t, check, ok, err, rowsOf, valsOf, oneOf, canon, same, differs, val,
               oneSafe, colSafe, idsSafe, keysSafe,
               eq, numEq, expect, expectNear, expectDeep, valNear, approx, mround,
               sum, cnt, uniq, byKey, canaryClean,
               outside, upper, lower, alternating, spaced, wsPos, swap, tag,
               lit, insertRows, drop, cleanup };
    }
