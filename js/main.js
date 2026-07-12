    // ============================================================================
    // [Main] - 起動時の自動読み込み
    // ============================================================================
    (async function autoLoad() {
        try {
            const dump = await loadDB();
            if (dump) {
                db.importFromIDB(dump);
                renderTree();
                els.resArea.innerHTML = `<div class="m-auto text-gray-500 text-sm">Auto-loaded previous session data.</div>`;
            }
        } catch(e) {
            console.error("Auto-load error:", e);
            // 復号失敗などをユーザーへ通知する（黙って初期データで起動すると気づけないため）
            if (typeof showToast === 'function') showToast(`自動読み込みに失敗しました: ${e.message}`, true);
        }
    })();
