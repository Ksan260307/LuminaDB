    // ============================================================================
    // [IndexedDB Integration] - Asynchronous Storage Engine
    //
    // 保存スナップショットは AES-GCM (256bit) で暗号化する。鍵は Web Crypto API で
    // 「抽出不能 (non-extractable)」として生成し、専用ストアに CryptoKey のまま保持する。
    // これにより JS から鍵素材を取り出すことはできず、ディスク上のスナップショットは
    // 常に暗号文となる（パスワード入力なしの自動読み込みは維持される）。
    // 脅威モデル上の注意: 同一オリジンで実行されるコードは鍵を「使用」できるため、
    // XSS そのものへの防御ではなく、保存ファイルの直接閲覧・持ち出しへの対策である。
    // ============================================================================
    const IDB_NAME = 'LuminaDB';
    const IDB_STORE = 'snapshots';
    const IDB_KEY_STORE = 'keys';
    const IDB_LEGACY_NAME = 'JSLiteDB'; // 旧ブランド名のDB（初回ロード時に移行）

    function initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 2);
            req.onupgradeneeded = e => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
                if (!d.objectStoreNames.contains(IDB_KEY_STORE)) d.createObjectStore(IDB_KEY_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // --- 暗号化ヘルパー ---
    const hasSubtleCrypto = typeof crypto !== 'undefined' && !!crypto.subtle;
    let cachedCryptoKey = null;

    // 暗号鍵の取得（無ければ生成して保存）。「読んで無ければ書く」を単一トランザクションで
    // 行い、複数タブが同時に初期化しても鍵がひとつに定まるようにする
    async function getCryptoKey(idb) {
        if (cachedCryptoKey) return cachedCryptoKey;
        const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        cachedCryptoKey = await new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_KEY_STORE, 'readwrite');
            const store = tx.objectStore(IDB_KEY_STORE);
            const req = store.get('aes-key');
            req.onsuccess = () => {
                if (req.result) { resolve(req.result); }
                else { store.put(fresh, 'aes-key'); resolve(fresh); }
            };
            req.onerror = () => reject(req.error);
        });
        return cachedCryptoKey;
    }

    // TypedArray → base64（call stack 制限を避けるためチャンク処理）
    function _bufToB64(u8) {
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return btoa(s);
    }
    function _b64ToBuf(b64) {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    // 暗号化のためのシリアライズ: ダンプ中の TypedArray を base64 タグ付きオブジェクトへ変換
    function serializeDump(dump) {
        return JSON.stringify(dump, (k, v) => {
            if (v instanceof Float64Array) return { __f64: _bufToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
            if (v instanceof Uint32Array) return { __u32: _bufToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
            return v;
        });
    }
    function deserializeDump(json) {
        return JSON.parse(json, (k, v) => {
            if (v && typeof v === 'object') {
                if (typeof v.__f64 === 'string') { const u8 = _b64ToBuf(v.__f64); return new Float64Array(u8.buffer, 0, u8.byteLength / 8); }
                if (typeof v.__u32 === 'string') { const u8 = _b64ToBuf(v.__u32); return new Uint32Array(u8.buffer, 0, u8.byteLength / 4); }
            }
            return v;
        });
    }

    // 楽観ロック用: このタブが最後に読み込み/保存したスナップショットのバージョン番号
    let dbSnapshotVersion = 0;
    // 列ごとの指紋: table -> col -> fp
    let storedColFingerprints = Object.create(null);

    // 保存済みの世代番号を読む。新形式は 'meta'、旧形式は 'latest' に入っている
    function readStoredVersion(idb) {
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const mreq = store.get(META_KEY);
            mreq.onsuccess = () => {
                if (mreq.result && typeof mreq.result.__version__ === 'number') { resolve(mreq.result.__version__); return; }
                const lreq = store.get('latest');
                lreq.onsuccess = () => resolve((lreq.result && typeof lreq.result.__version__ === 'number') ? lreq.result.__version__ : 0);
                lreq.onerror = () => reject(lreq.error);
            };
            mreq.onerror = () => reject(mreq.error);
        });
    }

    // ------------------------------------------------------------------------
    // タブ間の書き込み排他 (Web Locks API)
    //
    // 楽観ロックだけだと「バージョン読み取り → 書き込み」の間に他タブが割り込む窓が残る。
    // Web Locks でオリジン単位の名前付きロックを取れば、その区間そのものを直列化できる。
    // 未対応ブラウザでは従来どおり楽観ロックだけで動く（機能低下のみ）。
    // ------------------------------------------------------------------------
    const hasWebLocks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    function withWriteLock(fn) {
        if (!hasWebLocks) return fn();
        return navigator.locks.request('luminadb-write', fn);
    }

    async function saveDB(dataObj) {
        return withWriteLock(() => saveDBLocked(dataObj));
    }

    // ------------------------------------------------------------------------
    // 差分（テーブル単位）保存
    //
    // 以前は保存のたびに DB 全体を 1 レコードへ直列化・暗号化していた。行が 1 行
    // 変わっただけでも全テーブルを書き直すため、データが増えるほど自動保存が重くなる。
    // ここではテーブルごとに 'tbl:<name>' レコードへ分け、`fp`（変更世代:行数:容量）が
    // 前回と同じテーブルは書き直さない。カタログ（ビュー/関数/シーケンス等）と
    // 指紋一覧は 'meta' に置く。
    //   旧形式（'latest' 1 レコード）も読み込みだけ引き続き対応する。
    // ------------------------------------------------------------------------
    const META_KEY = 'meta';
    const CHUNK_FORMAT = 'chunked-v1';
    // 列単位の差分保存。chunked-v1 は表 1 つを 1 レコードに書いていたので、
    // 1 列を直しただけでも全列を直列化 + 暗号化していた（20 万行 4 列で 86ms / 12.3MB）。
    // v2 は列ごとにレコードを分け、指紋の変わった列だけを書く。
    // 読み込みは v1 も受けるので、既に保存してある DB はそのまま開ける
    const CHUNK_FORMAT_V2 = 'chunked-v2';
    const tableKey = (name) => 'tbl:' + name;
    const colKey = (name, col) => 'col:' + name + '|' + col;
    // 直近に保存したテーブルの指紋（このタブが把握している保存済みの状態）
    let storedFingerprints = Object.create(null);
    // 統計（テストと SHOW STORAGE 用）: 直近保存で何テーブル書いたか
    let lastSaveStats = { tables: 0, written: 0, skipped: 0, removed: 0, full: true };

    async function encryptRecord(idb, value, version) {
        if (!hasSubtleCrypto) return { __encrypted__: false, __version__: version, plain: value };
        const key = await getCryptoKey(idb);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
            new TextEncoder().encode(serializeDump(value)));
        return { __encrypted__: true, __version__: version, iv, data: cipher };
    }

    async function decryptRecord(idb, rec) {
        if (!rec) return undefined;
        if (!rec.__encrypted__) return rec.plain !== undefined ? rec.plain : rec;
        if (!hasSubtleCrypto) throw new Error("暗号化されたスナップショットの復号には Web Crypto API（セキュアコンテキスト）が必要です。");
        const key = await getCryptoKey(idb);
        try {
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data);
            return deserializeDump(new TextDecoder().decode(plain));
        } catch (e) {
            throw new Error("保存データの復号に失敗しました（データ破損または鍵の不一致）。'Clear DB' で初期化できます。");
        }
    }

    async function saveDBLocked(dataObj) {
        const idb = await initDB();
        // 楽観ロック: 別のタブ/ウィンドウが先に保存していた場合は上書きせずエラーにする。
        // Web Locks が使える環境では、この読み取りから書き込みまでが直列化される
        const stored = await readStoredVersion(idb);
        if (stored !== dbSnapshotVersion) {
            throw new Error("保存を中止しました: 別のタブ/ウィンドウがデータベースを更新しています。ページを再読み込みして最新の状態を取得してください。");
        }
        const version = stored + 1;
        dataObj.__version__ = version;

        // テーブルとカタログに分ける
        const tableNames = Object.keys(dataObj).filter(k => !k.startsWith('__'));
        const catalog = Object.create(null);
        Object.keys(dataObj).filter(k => k.startsWith('__')).forEach(k => { catalog[k] = dataObj[k]; });

        const fps = Object.create(null);
        const changed = [];
        tableNames.forEach(n => {
            const fp = dataObj[n].fp !== undefined ? String(dataObj[n].fp) : null;
            fps[n] = fp;
            // 指紋が取れないテーブル（旧ダンプ由来）は毎回書く
            if (fp === null || storedFingerprints[n] !== fp) changed.push(n);
        });
        const removed = Object.keys(storedFingerprints).filter(n => !(n in fps));

        // 変更のあった列だけ暗号化する（暗号化は保存コストの大半を占める）。
        // 表のレコードには列データ以外（スキーマ・制約・文字列プール）を入れ、
        // 列データは 1 列 1 レコードに分ける
        const records = [];
        const colFps = Object.create(null);
        const writtenCols = [];
        for (const n of tableNames) {
            const t = dataObj[n];
            const cols = Object.keys(t.cols || {});
            colFps[n] = Object.create(null);
            let wroteAnyCol = false;
            for (const c of cols) {
                const cf = t.cols[c].fp !== undefined ? String(t.cols[c].fp) : null;
                colFps[n][c] = cf;
                const prev = storedColFingerprints[n] && storedColFingerprints[n][c];
                // 指紋が取れない列（旧ダンプ由来）は毎回書く
                if (cf === null || prev !== cf) {
                    writtenCols.push([n, c]);
                    wroteAnyCol = true;
                    // 文字列プールも列に属するので一緒に置く。表側に残すと
                    // テキスト列のある表で毎回プール全体を書き直すことになる
                    records.push([colKey(n, c), await encryptRecord(idb,
                        { num: t.cols[c].num, meta: t.cols[c].meta, pool: (t.strPools || {})[c] || [] }, version)]);
                }
            }
            // 表そのものの記述（列データ以外）を書く条件。
            //
            // 列を 1 つでも書いたなら必ず書く。ここを「表の指紋が変わったとき」だけに
            // していると、v1 で保存された DB を開いた直後の初回保存で崩れる:
            // 表の指紋は v1 の meta から引き継がれて「変わっていない」のに、列の指紋は
            // 未知なので全列が書かれる。すると tbl: レコードだけ v1 のまま残り、
            // 読み込み側が __cols__ の無い殻を v2 として読んで列が全部消える
            if (changed.includes(n) || wroteAnyCol || !storedColFingerprints[n]) {
                const shell = Object.create(null);
                for (const k of Object.keys(t)) { if (k !== 'cols' && k !== 'strPools' && k !== 'strMaps') shell[k] = t[k]; }
                shell.__cols__ = cols;
                records.push([tableKey(n), await encryptRecord(idb, shell, version)]);
            }
        }
        const metaRecord = await encryptRecord(idb, { __format__: CHUNK_FORMAT_V2, tables: fps, cols: colFps, catalog }, version);
        metaRecord.__format__ = CHUNK_FORMAT_V2;   // 復号せずに形式を判別できるよう外側にも置く

        await new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            records.forEach(([k, v]) => store.put(v, k));
            removed.forEach(n => {
                store.delete(tableKey(n));
                const cf = storedColFingerprints[n] || {};
                Object.keys(cf).forEach(c => store.delete(colKey(n, c)));
            });
            store.put(metaRecord, META_KEY);
            // 旧形式の全体レコードが残っていれば、新形式への移行後に片付ける
            store.delete('latest');
            tx.oncomplete = () => resolve();
            // クォータ超過はブラウザDB特有の失敗モードなので、原因が分かる文言へ変換する
            tx.onerror = () => {
                const err = tx.error;
                if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
                    reject(new Error("ブラウザのストレージ上限に達したため保存できません。不要なテーブルを削除するか、SQL としてエクスポートしてください。"));
                } else {
                    reject(err);
                }
            };
        });

        storedFingerprints = fps;
        storedColFingerprints = colFps;
        lastSaveStats = {
            tables: tableNames.length, written: changed.length, writtenColumns: writtenCols.length,
            skipped: tableNames.length - changed.length, removed: removed.length,
            full: changed.length === tableNames.length
        };
        dbSnapshotVersion = version;
        // 他タブへ保存を通知する（相手側は最新版の存在に気づける）
        broadcastSaved(dbSnapshotVersion);
    }

    // 直近保存で「書いたテーブル / 省いたテーブル」の内訳
    function getSaveStats() { return Object.assign({}, lastSaveStats); }

    function idbGet(idb, key) {
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function loadDB() {
        const idb = await initDB();
        // 新形式（テーブル分割）を優先して読む
        const meta = await idbGet(idb, META_KEY);
        if (meta !== undefined) {
            dbSnapshotVersion = (typeof meta.__version__ === 'number') ? meta.__version__ : 0;
            const m = await decryptRecord(idb, meta);
            const dump = Object.create(null);
            Object.keys(m.catalog || {}).forEach(k => { dump[k] = m.catalog[k]; });
            const names = Object.keys(m.tables || {});
            const isV2 = m.__format__ === CHUNK_FORMAT_V2;
            for (const n of names) {
                const rec = await idbGet(idb, tableKey(n));
                if (rec === undefined) continue;   // 破損時はその表だけ落とす（全損より良い）
                const shell = await decryptRecord(idb, rec);
                if (!isV2) { dump[n] = shell; continue; }
                // v2: 列データは 1 列 1 レコード。表のレコードには列以外が入っている
                const cols = Object.create(null);
                const pools = Object.create(null);
                let broken = false;
                for (const c of (shell.__cols__ || [])) {
                    const cr = await idbGet(idb, colKey(n, c));
                    if (cr === undefined) { broken = true; break; }
                    const dec = await decryptRecord(idb, cr);
                    cols[c] = { num: dec.num, meta: dec.meta };
                    pools[c] = dec.pool || [];
                }
                if (broken) continue;              // 列が欠けた表は落とす（半分だけ復元しない）
                delete shell.__cols__;
                shell.cols = cols;
                shell.strPools = pools;            // strMaps は取り込み側がプールから作り直す
                dump[n] = shell;
            }
            storedFingerprints = Object.assign(Object.create(null), m.tables || {});
            storedColFingerprints = Object.create(null);
            if (isV2) {
                for (const n of Object.keys(m.cols || {})) {
                    storedColFingerprints[n] = Object.assign(Object.create(null), m.cols[n]);
                }
            }
            dump.__version__ = dbSnapshotVersion;
            return dump;
        }
        // 旧形式（1 レコード）。読み込みは維持し、次回保存で新形式へ移行される
        const data = await idbGet(idb, 'latest');
        if (data !== undefined) {
            dbSnapshotVersion = (typeof data.__version__ === 'number') ? data.__version__ : 0;
            storedFingerprints = Object.create(null);
            storedColFingerprints = Object.create(null);   // 表側と必ず一緒に捨てる
            if (data.__encrypted__) return decryptRecord(idb, data);
            return data;
        }
        return migrateLegacyDB();
    }

    // 旧 'JSLiteDB' に保存されたスナップショットがあれば新DBへ移行する
    async function migrateLegacyDB() {
        try {
            const legacy = await new Promise((resolve, reject) => {
                const req = indexedDB.open(IDB_LEGACY_NAME, 1);
                req.onupgradeneeded = e => {
                    e.target.result.createObjectStore(IDB_STORE);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const legacyData = await new Promise((resolve, reject) => {
                const tx = legacy.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get('latest');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            legacy.close();
            if (legacyData !== undefined) {
                await saveDB(legacyData);
                indexedDB.deleteDatabase(IDB_LEGACY_NAME);
                console.log('Migrated legacy JSLiteDB snapshot to LuminaDB.');
            }
            return legacyData;
        } catch (e) {
            console.warn('Legacy DB migration skipped:', e);
            return undefined;
        }
    }

    async function clearDB() {
         const idb = await initDB();
         await new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readwrite');
            // 分割保存した各テーブルのレコードも残らず消す
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        dbSnapshotVersion = 0;
        storedFingerprints = Object.create(null);
        storedColFingerprints = Object.create(null);   // 表側と必ず一緒に捨てる
        lastSaveStats = { tables: 0, written: 0, skipped: 0, removed: 0, full: true };
    }

    // --- Auto Save ---
    let autoSaveTimer = null;
    function triggerAutoSave() {
        if (isTesting) return;
        // 排他制御: トランザクション中は自動保存しない（未コミット状態の永続化を防ぐ）
        if (db.inTransaction) return;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => {
            autoSaveTimer = null;
            if (db.inTransaction) return; // タイマー発火時点で開始されたトランザクションにも対応
            try {
                await saveDB(db.exportForIDB());
                if (typeof window.refreshStorageState === 'function') window.refreshStorageState();
                console.log("Database auto-saved.");
            } catch (e) {
                console.error("Auto-save error:", e);
                if (typeof showToast === 'function') showToast(`自動保存に失敗しました: ${e.message}`, true);
            }
        }, 1000);
        // サイドバーの保存状態表示（v1.34）。保存ボタンをモーダルへ移したので、
        // 「まだ書けていない変更がある」ことはこの 1 行だけが伝える
        if (typeof window.refreshStorageState === 'function') window.refreshStorageState();
    }

    // デバウンス待機中の自動保存を即時実行する（タブ非表示/クローズ間際の取りこぼし対策）。
    // 保存を開始できた場合のみ true を返す
    function flushAutoSave() {
        if (!autoSaveTimer) return false;
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
        if (isTesting || db.inTransaction) return false;
        saveDB(db.exportForIDB())
            .then(() => console.log("Database auto-saved (flush)."))
            .catch(e => console.error("Auto-save flush error:", e));
        return true;
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAutoSave();
    });

    // 未保存の変更を抱えたままタブを閉じようとしたら確認ダイアログを出す。
    // visibilitychange のフラッシュを取りこぼした場合（クラッシュ・強制終了）の最後の砦
    function hasUnsavedChanges() { return autoSaveTimer !== null; }
    window.addEventListener('beforeunload', (e) => {
        if (typeof isTesting !== 'undefined' && isTesting) return;
        if (!hasUnsavedChanges()) return;
        flushAutoSave();       // まず保存を試みる（同期的には完了しない）
        e.preventDefault();
        e.returnValue = '';    // 仕様上、離脱確認を出すには returnValue の設定が要る
    });

    // 他タブの保存に追従して自動で読み直すモード（既定は警告のみ）。
    // 「編集は 1 タブ・閲覧は複数タブ」という使い方で効く
    let autoReloadOnRemoteSave = false;
    function setAutoReload(flag) {
        if (flag === undefined) return autoReloadOnRemoteSave;
        autoReloadOnRemoteSave = !!flag;
        return autoReloadOnRemoteSave;
    }
    async function reloadFromStorage() {
        const dump = await loadDB();
        if (dump === undefined) return false;
        db.importFromIDB(dump);
        if (typeof renderTree === 'function') renderTree();
        if (typeof LuminaDB !== 'undefined' && LuminaDB._notifySubscribers) LuminaDB._notifySubscribers();
        return true;
    }

    // ========================================================================
    // [Backup] - スナップショットのファイル入出力
    //
    // IndexedDB は「ブラウザを消したら消える」保存先なので、ユーザーの手元へ
    // 取り出せる経路が要る。TypedArray を base64 化した JSON 1 ファイルで
    // 完全な状態（スキーマ・データ・ビュー・関数・シーケンス）を往復できる。
    // ========================================================================
    const BACKUP_FORMAT = 'luminadb-backup';

    // 現在のDBをバックアップ用の JSON 文字列にする
    function serializeBackup(dump) {
        const meta = {
            __format__: BACKUP_FORMAT,
            __app_version__: (typeof LUMINA_VERSION !== 'undefined') ? LUMINA_VERSION : null,
            __created_at__: new Date().toISOString(),
            payload: dump
        };
        return serializeDump(meta);
    }

    // バックアップ JSON をダンプへ戻す（形式チェック付き）
    function parseBackup(text) {
        let obj;
        try { obj = deserializeDump(String(text)); }
        catch (e) { throw new Error("バックアップの解析に失敗しました（JSON として読めません）。"); }
        if (!obj || obj.__format__ !== BACKUP_FORMAT || !obj.payload) {
            throw new Error("LuminaDB のバックアップファイルではありません。");
        }
        return obj.payload;
    }

    // バックアップをファイルとしてダウンロードさせる（ブラウザ環境のみ）
    function downloadBackup(filename) {
        const text = serializeBackup(db.exportForIDB());
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `luminadb-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { bytes: text.length, filename: a.download };
    }

    // ========================================================================
    // [Storage Quota] - ブラウザDB特有の運用情報
    //
    // ブラウザのストレージには origin 単位のクォータがあり、超過すると保存が
    // QuotaExceededError で失敗する。またベストエフォート保存の場合、ディスク
    // 逼迫時にブラウザがデータを退避（eviction）することがある。両者はサーバDBに
    // 存在しない失敗モードなので、利用状況の可視化と永続化要求の手段を提供する。
    // ========================================================================

    // 現在の使用量・クォータ・永続化状態を返す（未対応ブラウザでは supported:false）
    async function getStorageInfo() {
        const info = {
            supported: !!(navigator.storage && navigator.storage.estimate),
            usage: null, quota: null, usagePercent: null, persisted: null
        };
        if (info.supported) {
            try {
                const est = await navigator.storage.estimate();
                info.usage = est.usage != null ? est.usage : null;
                info.quota = est.quota != null ? est.quota : null;
                if (info.usage != null && info.quota) {
                    info.usagePercent = Number(((info.usage / info.quota) * 100).toFixed(2));
                }
            } catch (e) { /* 権限や実装差で失敗しても情報なしとして扱う */ }
        }
        if (navigator.storage && navigator.storage.persisted) {
            try { info.persisted = await navigator.storage.persisted(); } catch (e) { /* 同上 */ }
        }
        return info;
    }

    // 永続化ストレージ（eviction されない保存）を要求する。付与されたかを返す
    async function requestPersistence() {
        if (!(navigator.storage && navigator.storage.persist)) return false;
        try { return await navigator.storage.persist(); } catch (e) { return false; }
    }

    // ========================================================================
    // [Multi-tab Sync] - 同一オリジンの他タブへ保存を通知する
    //
    // saveDB は楽観ロックで他タブの上書きを「拒否」するが、それだけでは利用者は
    // 保存に失敗するまで競合に気づけない。保存のたびに通知を送り、他タブ側で
    // 「別タブが更新した」ことを即座に知らせる。
    // ========================================================================
    let syncChannel = null;
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            syncChannel = new BroadcastChannel('luminadb-sync');
            syncChannel.onmessage = (ev) => {
                const msg = ev && ev.data;
                if (!msg || msg.type !== 'saved') return;
                if (typeof isTesting !== 'undefined' && isTesting) return;
                // 自分より新しいスナップショットが他タブで保存された
                if (typeof msg.version === 'number' && msg.version > dbSnapshotVersion) {
                    // 自動追従モード: 手元に未保存の変更が無ければ最新を読み直す
                    if (autoReloadOnRemoteSave && !hasUnsavedChanges() && !db.inTransaction) {
                        reloadFromStorage()
                            .then(ok => { if (ok && typeof showToast === 'function') showToast(`別のタブの更新を反映しました (v${msg.version})`); })
                            .catch(e => console.error('Auto-reload failed:', e));
                        return;
                    }
                    if (typeof logConsole === 'function') {
                        logConsole('info', `別のタブがデータベースを更新しました (v${msg.version})`, 'Load DB で最新の状態を取得できます');
                    }
                    if (typeof showToast === 'function') {
                        showToast('別のタブがデータベースを更新しました。Load DB で最新を取得してください。', true);
                    }
                }
            };
        } catch (e) { syncChannel = null; }
    }
    function broadcastSaved(version) {
        if (!syncChannel) return;
        try { syncChannel.postMessage({ type: 'saved', version }); } catch (e) { /* 送信失敗は無視 */ }
    }
