#!/usr/bin/env bash
# ============================================================================
# LuminaDB 実ブラウザ・ヘッドレステストランナー
#
# 本物の LuminaDB.html を実ブラウザ（ヘッドレス Chrome/Edge）で起動し、
# ?autotest=1 フックで全テスト（runTestSuite）を実行、結果を回収して
# pass/fail を終了コードで返す。DOM・IndexedDB・crypto.subtle・postMessage・
# clipboard などが本物なので、bun ハーネスで「既知失敗」扱いだった UI・
# セキュリティ系テストも本番同様に検証できる。
#
# 使い方:  bash test/run-browser-tests.sh
#          bash test/run-browser-tests.sh 8801   # ポート指定
# 終了コード: 0=全パス / 1=失敗あり / 2=起動・回収エラー
# ============================================================================
set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-8801}"

CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
if [ -f "$CHROME" ]; then BROWSER="$CHROME"
elif [ -f "$EDGE" ]; then BROWSER="$EDGE"
else echo "ERROR: Chrome も Edge も見つかりません。" >&2; exit 2; fi

# 静的サーバーを起動（このスクリプト専用ポート）
( cd "$PROJECT_DIR" && python -m http.server "$PORT" >/dev/null 2>&1 ) &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null; [ -n "${PROFILE:-}" ] && rm -rf "$PROFILE" 2>/dev/null; }
trap cleanup EXIT

# サーバー起動待ち
for i in $(seq 1 20); do
  if curl -s "http://localhost:$PORT/LuminaDB.html" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

PROFILE="$(mktemp -d)"
URL="http://localhost:$PORT/LuminaDB.html?autotest=1"

# --virtual-time-budget で非同期（setTimeout / IDB 等）を早送りしつつ完了を待ち、
# --dump-dom で最終 DOM を標準出力へ。#autotest-result の base64 を回収する。
DOM="$("$BROWSER" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --user-data-dir="$PROFILE" --virtual-time-budget=300000 \
  --dump-dom "$URL" 2>/dev/null)"

B64="$(printf '%s' "$DOM" | grep -o 'AUTOTEST_B64:[A-Za-z0-9+/=]*' | head -1 | sed 's/^AUTOTEST_B64://')"

if [ -z "$B64" ]; then
  echo "ERROR: テスト結果を回収できませんでした（ページ実行が完了しなかった可能性）。" >&2
  exit 2
fi

JSON="$(printf '%s' "$B64" | base64 -d 2>/dev/null)"
if [ -z "$JSON" ]; then echo "ERROR: 結果のデコードに失敗しました。" >&2; exit 2; fi

# bun で整形出力し、ok に応じて終了コードを決める
printf '%s' "$JSON" | bun -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (j.error) { console.log("RUN ERROR:", j.error); process.exit(2); }
  console.log(`LuminaDB v${j.version}  TOTAL: ${j.total}  PASS: ${j.pass}  FAIL: ${j.total - j.pass}`);
  if (!j.ok) {
    console.log("--- failures ---");
    for (const f of j.fails) console.log(`[FAIL] ${f.name} :: ${f.error}`);
    process.exit(1);
  }
  console.log("ALL PASS (real browser environment)");
  process.exit(0);
'
