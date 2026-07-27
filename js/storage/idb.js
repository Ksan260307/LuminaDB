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

    function readStoredVersion(idb) {
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get('latest');
            req.onsuccess = () => resolve((req.result && typeof req.result.__version__ === 'number') ? req.result.__version__ : 0);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveDB(dataObj) {
        const idb = await initDB();
        // 楽観ロック: 別のタブ/ウィンドウが先に保存していた場合は上書きせずエラーにする
        // （読み取り→書き込み間の競合窓は残るが、タブ間の意図しない相互上書きを実用上防げる）
        const stored = await readStoredVersion(idb);
        if (stored !== dbSnapshotVersion) {
            throw new Error("保存を中止しました: 別のタブ/ウィンドウがデータベースを更新しています。ページを再読み込みして最新の状態を取得してください。");
        }
        dataObj.__version__ = stored + 1;

        // AES-GCM で暗号化して保存する。バージョン番号は楽観ロックが復号なしで
        // 参照できるよう、暗号文の外側（ラッパー）にも平文で持たせる
        let record = dataObj;
        if (hasSubtleCrypto) {
            const key = await getCryptoKey(idb);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const plain = new TextEncoder().encode(serializeDump(dataObj));
            const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
            record = { __encrypted__: true, __version__: dataObj.__version__, iv, data: cipher };
        } else {
            console.warn('Web Crypto API が利用できないため、スナップショットは平文で保存されます。');
        }

        await new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(record, 'latest');
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
        dbSnapshotVersion = dataObj.__version__;
        // 他タブへ保存を通知する（相手側は最新版の存在に気づける）
        broadcastSaved(dbSnapshotVersion);
    }

    async function loadDB() {
        const idb = await initDB();
        const data = await new Promise((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get('latest');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (data !== undefined) {
            dbSnapshotVersion = (typeof data.__version__ === 'number') ? data.__version__ : 0;
            if (data.__encrypted__) {
                if (!hasSubtleCrypto) {
                    throw new Error("暗号化されたスナップショットの復号には Web Crypto API（セキュアコンテキスト）が必要です。");
                }
                const key = await getCryptoKey(idb);
                try {
                    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.iv }, key, data.data);
                    return deserializeDump(new TextDecoder().decode(plain));
                } catch (e) {
                    throw new Error("保存データの復号に失敗しました（データ破損または鍵の不一致）。'Clear DB' で初期化できます。");
                }
            }
            // 旧形式（平文）はそのまま読み込む。次回の保存時に暗号化形式へ移行される
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
            tx.objectStore(IDB_STORE).delete('latest');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        dbSnapshotVersion = 0;
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
                console.log("Database auto-saved.");
            } catch (e) {
                console.error("Auto-save error:", e);
                if (typeof showToast === 'function') showToast(`自動保存に失敗しました: ${e.message}`, true);
            }
        }, 1000);
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
