    // ============================================================================
    // [i18n / English] - 日本語（原文）→ 英語の対応表
    //
    //   キーは画面に書かれている日本語そのもの（空白を 1 個に畳んだもの）。
    //   ・HTML から拾ったものは、文中のインライン要素（<span> / <code> / <kbd>）ごと
    //     1 つの単位になる。訳文でも同じ印を同じ位置に入れること。
    //   ・JS の t() から来るものは {0} {1} … が引数の差し込み位置。
    //     訳文でも同じ番号を使う（順番は入れ替えてよい）。
    //   ここに無い語は日本語のまま表示される（壊れるより読めるほうがよい）。
    //   抜けは test-suite-v64.js が検出する（英語表示で日本語が残っていないこと）。
    // ============================================================================
    Object.assign(LUMINA_I18N_EN, {

        // ---- サイドバー / ツールバー ----
        'コマンドリファレンス': 'Command reference',
        '保存・読み込み・書き出し・テストデータ (Ctrl+Shift+D)': 'Save, load, export, and test data (Ctrl+Shift+D)',
        'データ — 保存 / 読み込み / 入出力': 'Data — save / load / import / export',
        'このブラウザへ自動保存': 'Auto-saving to this browser',
        '開いているファイル': 'Open file',
        '外部キーの関係を図で見る': 'See foreign-key relationships as a diagram',
        '表・列を検索': 'Search tables and columns',
        'クリア': 'Clear',
        'ER図': 'ER diagram',

        // ---- エディタ周り ----
        'SQLを整形 (Ctrl+Shift+F)': 'Format SQL (Ctrl+Shift+F)',
        '実行計画を見る (Ctrl+Shift+E) — 実行はしない': 'Show the query plan (Ctrl+Shift+E) — does not run it',
        '新しいタブ (Ctrl+Alt+T)': 'New tab (Ctrl+Alt+T)',
        '＋': '+',
        'ドラッグでエディタの高さを変更（ダブルクリックで既定へ戻す）': 'Drag to resize the editor (double-click to reset)',
        // 帯の右端に置く注記。英語は長くなるので折り返さない程度に詰める
        'Ctrl+Enter でカーソル位置の文だけ実行 · セルをダブルクリックで編集':
            'Ctrl+Enter: run one statement · double-click: edit cell',

        // ---- トランザクションバー / 結果ツールバー ----
        'トランザクション状態': 'Transaction state',
        'BEGIN — トランザクションを開始': 'BEGIN — start a transaction',
        'COMMIT — 変更を確定': 'COMMIT — make the changes permanent',
        'ROLLBACK — 変更を破棄': 'ROLLBACK — discard the changes',
        '結果セルをダブルクリックで直接編集できるかどうか': 'Whether double-clicking a result cell edits it in place',
        '1 文あたりの実行時間の上限。超えると中断してエラーになる':
            'Time limit per statement; going over aborts it with an error',
        '上限': 'Limit',
        'なし': 'None',
        '5秒': '5s',
        '30秒': '30s',
        '2分': '2min',
        '結果を絞り込み': 'Filter results',
        '結果を Markdown 表としてクリップボードへコピー': 'Copy the results to the clipboard as a Markdown table',
        '結果を TSV としてコピー（表計算ソフトへそのまま貼れる）': 'Copy the results as TSV (pastes straight into a spreadsheet)',
        '結果を INSERT 文としてクリップボードへコピー': 'Copy the results to the clipboard as INSERT statements',
        '基底表へ空の行を追加する': 'Add an empty row to the underlying table',
        '選択中の行を基底表から削除する': 'Delete the selected rows from the underlying table',
        'クエリ履歴': 'Query history',
        'キーボードショートカット (?)': 'Keyboard shortcuts (?)',

        // ---- ヘルプ / 履歴 / プロファイル / ER ----
        'コマンドを検索 (例: JOIN, DATE, INSERT, JSON)': 'Search commands (e.g. JOIN, DATE, INSERT, JSON)',
        '一致するコマンドがありません。': 'No matching commands.',
        '履歴を検索': 'Search history',
        '履歴を削除': 'Clear history',
        'クリックでエディタへ読み込み · Run で即実行': 'Click to load into the editor · Run executes it right away',
        '<span>列名クリックでその列の分布クエリをエディタへ</span> <span id="profileNote"></span>':
            '<span>Click a column name to put its distribution query in the editor</span> <span id="profileNote"></span>',
        '<span>実線＝外部キー（子 → 親）· 表クリックで SELECT をエディタへ</span> <span id="erNote"></span>':
            '<span>Solid line = foreign key (child → parent) · click a table to put a SELECT in the editor</span> <span id="erNote"></span>',
        'SVG をクリップボードへコピー': 'Copy the SVG to the clipboard',
        '例: sales_2026': 'e.g. sales_2026',
        'JSON整形': 'Format JSON',

        // ---- コンソール ----
        'コンソールを開く (Ctrl+`)': 'Open the console (Ctrl+`)',
        'ログをコピー': 'Copy the log',
        '閉じる (Ctrl+`)': 'Close (Ctrl+`)',

        // ---- ショートカット一覧 ----
        'カーソル位置の文だけ実行': 'Run just the statement at the cursor',
        'エディタ全体を実行': 'Run the whole editor',
        'SQL を整形': 'Format SQL',
        'クエリ履歴を遡る / 進む': 'Go back / forward through query history',
        '新しいエディタタブ': 'New editor tab',
        'エディタタブを閉じる': 'Close the editor tab',
        'n 枚目のエディタタブへ': 'Jump to the n-th editor tab',
        '<kbd class="font-mono text-xs bg-gray-100 border border-gray-300 rounded px-1.5 py-0.5">Alt + 1 〜 9</kbd>':
            '<kbd class="font-mono text-xs bg-gray-100 border border-gray-300 rounded px-1.5 py-0.5">Alt + 1 – 9</kbd>',
        '実行計画を見る（実行しない）': 'Show the query plan (without running it)',
        'データ画面（保存 / 読み込み / 入出力）': 'Data screen (save / load / import / export)',
        'このブラウザへ保存': 'Save to this browser',
        'ファイルへ保存（開いていれば上書き）': 'Save to a file (overwrites the open one)',
        'コンソールの開閉': 'Show / hide the console',
        '補完の選択 / 確定': 'Move through / accept a completion',
        'このヘルプ': 'This help',
        '結果グリッド: セルを<b>クリック</b>で値の詳細、<b>ダブルクリック</b>で直接編集（単一表の SELECT で キー列が結果に含まれる場合のみ）。列見出しのクリックで並び替え。<br> エディタタブ: 名前は SQL から自動で付き、<b>ダブルクリック</b>で任意の名前に変更できる。内容はブラウザに保存される。':
            'Result grid: <b>click</b> a cell to inspect the value, <b>double-click</b> to edit it in place (single-table SELECTs whose key columns are in the result). Click a column header to sort.<br> Editor tabs: names come from the SQL automatically; <b>double-click</b> to rename. Contents are kept in the browser.',

        // ---- データ画面: タブ ----
        'このブラウザ': 'This browser',
        'ファイル': 'File',
        '書き出し': 'Export',
        '読み込み': 'Import',
        'テストデータ': 'Test data',

        // ---- データ画面: このブラウザ ----
        '<span class="font-semibold">変更は 1 秒後にこのブラウザへ自動保存されます。</span> 下のボタンは、その保存を今すぐ行う / 保存した地点へ戻す / 消して作り直すためのものです。':
            '<span class="font-semibold">Changes auto-save to this browser one second later.</span> The buttons below run that save now, go back to the saved state, or wipe it and start over.',
        '保存先はこのブラウザのこのサイト（IndexedDB）だけです。<span class="font-medium">閲覧データを削除すると消え、他の端末やブラウザからは見えません</span>。 持ち出す・バックアップを取るなら <span class="font-medium">ファイル</span> タブか <span class="font-medium">書き出し</span> タブを使ってください。':
            'It is stored only in this browser, for this site (IndexedDB). <span class="font-medium">Clearing your browsing data deletes it, and no other device or browser can see it</span>. To take it with you or keep a backup, use the <span class="font-medium">File</span> tab or the <span class="font-medium">Export</span> tab.',
        '今すぐ保存 <span class="ml-1 font-mono text-[10px] bg-gray-100 border border-gray-300 rounded px-1 py-0.5 text-gray-600">Ctrl + S</span>':
            'Save now <span class="ml-1 font-mono text-[10px] bg-gray-100 border border-gray-300 rounded px-1 py-0.5 text-gray-600">Ctrl + S</span>',
        '現在の状態をこのブラウザへ書き込みます。<span class="font-medium">変更のあった表だけ</span>を書き直すので、 表が増えても待たされません。自動保存があるので普段は不要ですが、タブを閉じる直前など 確実に書いておきたいときに押してください。':
            'Writes the current state into this browser. Only <span class="font-medium">the tables that changed</span> are rewritten, so it stays fast as the database grows. Auto-save makes this unnecessary most of the time — press it when you want to be certain, such as just before closing the tab.',
        '保存': 'Save',
        '保存した状態を読み込む': 'Load the saved state',
        'このブラウザに保存済みの内容で、<span class="font-medium">今の内容を置き換えます</span>。 編集を捨てて最後に保存した地点へ戻したいとき、または別のタブが行った更新を取り込むときに使います。':
            '<span class="font-medium">Replaces what you have now</span> with what is saved in this browser. Use it to throw away edits and return to the last save, or to pick up an update made in another tab.',
        '読み込む': 'Load',
        '保存データを消して初期状態に戻す': 'Delete the saved data and start over',
        'このブラウザの保存データを削除し、サンプルデータだけの初期状態から作り直します。 <span class="font-medium">元に戻せません</span>。押すと確認画面が出ます。 残しておきたいものがあるなら、先に <span class="font-medium">ファイル</span> か <span class="font-medium">書き出し</span> で外へ出してください。':
            'Deletes this browser\'s saved data and rebuilds the database with nothing but the sample tables. <span class="font-medium">This cannot be undone</span>; you will be asked to confirm. If there is anything you want to keep, get it out first via <span class="font-medium">File</span> or <span class="font-medium">Export</span>.',
        '初期化': 'Reset',

        // ---- データ画面: ファイル ----
        'データベース全体を <code class="bg-white border border-gray-200 px-1 rounded">.luminadb</code> ファイルとしてディスクに置きます。 普通のアプリと同じ<span class="font-medium">「開く → 編集 → 上書き保存」</span>で、 別の端末へ持ち出す・世代のバックアップを取る・チームで共有するといった扱いができます。':
            'Keeps the whole database on disk as a <code class="bg-white border border-gray-200 px-1 rounded">.luminadb</code> file. You get the same <span class="font-medium">open → edit → save</span> cycle as any other app, so you can move it to another machine, keep dated backups, or share it with your team.',
        '中身は表・ビュー・トリガーなどを含む復元用のテキストです。SQL として読みたいだけなら <span class="font-medium">書き出し</span> タブの SQL ダンプを使ってください。':
            'The file is restore-oriented text covering tables, views, triggers and the rest. If you only want something readable as SQL, use the SQL dump on the <span class="font-medium">Export</span> tab.',
        'ファイルを開く': 'Open a file',
        '保存済みの <code class="bg-gray-100 px-1 rounded">.luminadb</code> を読み込み、 <span class="font-medium">今の内容を置き換えます</span>。以後この画面の「上書き保存」はそのファイルへ書きます。':
            'Loads a saved <code class="bg-gray-100 px-1 rounded">.luminadb</code> and <span class="font-medium">replaces what you have now</span>. From then on, "Save" on this screen writes back to that file.',
        '開く': 'Open',
        '上書き保存 <span class="ml-1 font-mono text-[10px] bg-gray-100 border border-gray-300 rounded px-1 py-0.5 text-gray-600">Ctrl + Shift + S</span>':
            'Save <span class="ml-1 font-mono text-[10px] bg-gray-100 border border-gray-300 rounded px-1 py-0.5 text-gray-600">Ctrl + Shift + S</span>',
        'いま開いているファイルへ書き戻します。<span class="font-medium">ファイルを開くか一度「名前を付けて保存」するまでは押せません</span> （どのファイルへ書くのかが決まらないため）。':
            'Writes back to the file you have open. <span class="font-medium">It stays disabled until you open a file or save one with a name</span> — until then there is no file to write to.',
        '上書き保存': 'Save',
        '名前を付けて保存': 'Save as',
        '保存先を選んで新しいファイルを作ります。日付を付けた世代バックアップを残すときにも使えます。':
            'Pick a location and create a new file. Handy for keeping dated backups too.',

        // ---- データ画面: 書き出し ----
        'SQL ダンプ (.sql)': 'SQL dump (.sql)',
        '全ての表の <code class="bg-gray-100 px-1 rounded">CREATE TABLE</code> と <code class="bg-gray-100 px-1 rounded">INSERT</code> を 1 つのテキストにします。 別のブラウザや別の DB へ移すとき、または変更をファイルとして残すときに使います。':
            'Puts the <code class="bg-gray-100 px-1 rounded">CREATE TABLE</code> and <code class="bg-gray-100 px-1 rounded">INSERT</code> statements for every table into a single text file. Use it to move to another browser or another database, or to keep a change as a file.',
        '書き出す': 'Export',
        '全ての表を <code class="bg-gray-100 px-1 rounded">{ 表名: [行, ...] }</code> の形で書き出します。 他のツールやスクリプトへ渡すとき向けです。結果セットだけが要るなら、結果ツールバーの <span class="font-medium">書き出し ▾</span> を使ってください。':
            'Exports every table as <code class="bg-gray-100 px-1 rounded">{ table: [row, ...] }</code>. Meant for handing data to another tool or script. If you only need the current result set, use <span class="font-medium">Export JSON</span> in the results toolbar.',

        // ---- データ画面: 読み込み ----
        'ここに <span class="font-medium">.sql</span> / <span class="font-medium">.csv</span> ファイルをドラッグ&amp;ドロップしても読み込めます':
            'You can also drag &amp; drop <span class="font-medium">.sql</span> / <span class="font-medium">.csv</span> files here',
        'SQL ファイル (.sql)': 'SQL file (.sql)',
        'ファイル内の SQL を <code class="bg-gray-100 px-1 rounded">;</code> で区切って上から順に実行します。 書き出した SQL ダンプを戻すときに使います。<span class="font-medium">失敗した文はエラー内容ごと下に表示します</span>。':
            'Splits the file\'s SQL on <code class="bg-gray-100 px-1 rounded">;</code> and runs the statements in order. Use it to restore a SQL dump. <span class="font-medium">Any statement that fails is listed below with its error</span>.',
        'ファイルを選ぶ': 'Choose a file',
        'CSV ファイル (.csv)': 'CSV file (.csv)',
        '1 行目をヘッダーとして読み、行を取り込みます。引用符の中のカンマ・改行にも対応します。 取り込み先に <span class="font-medium">「新しい表を作る」</span>を選ぶと、ヘッダーから列を作り型を推定します。':
            'Reads the first line as a header and imports the rows, handling commas and newlines inside quotes. Choose <span class="font-medium">"Create a new table"</span> as the destination to build the columns from the header and infer their types.',
        '取り込み先': 'Destination',
        'CSV ファイル': 'CSV file',
        '新しい表の名前': 'New table name',
        '取り込む前に既存の行を削除する': 'Delete existing rows before importing',
        '取り込む': 'Import',

        // ---- データ画面: テストデータ ----
        'ダミー行の生成': 'Generate dummy rows',
        '選んだ表の列構成に合わせてダミー行を追加します。件数を増やして、 索引の効き方や描画の速さを試すのに使います（10 万行まで）。':
            'Adds dummy rows matching the chosen table\'s columns. Turn the count up to see how indexes and rendering hold out (up to 100,000 rows).',
        '対象の表': 'Table',
        '行数': 'Rows',
        '行を追加': 'Add rows',

        // ---- 確認・警告 ----
        'IndexedDB のデータを完全に削除し、初期状態のデータベースにリセットしますか？この操作は取り消せません。':
            'Delete the IndexedDB data entirely and reset to the initial database? This cannot be undone.',
        'スタイルシート（css/tailwind.css）を読み込めませんでした。表示は簡素になりますが、SQL の実行と保存は問題なく動きます。':
            'The stylesheet (css/tailwind.css) could not be loaded. The look is plainer, but running SQL and saving work exactly as usual.',

        // ============================================================
        // JS が組み立てる文言（t() 由来）。{0} {1} は引数の差し込み位置
        // ============================================================

        // ---- 保存・読み込み（データ画面 / トースト）----
        'このブラウザへ保存中…': 'Saving to this browser…',
        '変更を検知しました。まもなくこのブラウザ（IndexedDB）へ書き込みます。Ctrl + S で今すぐ保存できます。':
            'A change was detected; it will be written to this browser (IndexedDB) shortly. Ctrl + S saves it right now.',
        '変更は 1 秒後にこのブラウザ（IndexedDB）へ自動保存されます。Ctrl + S で今すぐ保存できます。':
            'Changes auto-save to this browser (IndexedDB) one second later. Ctrl + S saves them right now.',
        '前回の保存: {0} 表中 {1} 表を書き込み（{2} 表は変更なしで省略）':
            'Last save: {1} of {0} tables written ({2} unchanged and skipped)',
        'このセッションではまだ手動保存していません（自動保存は動いています）':
            'No manual save yet this session (auto-save is running)',
        'いまのデータ: {0} 表 / {1} 行 — {2}': 'Right now: {0} tables / {1} rows — {2}',
        'IndexedDB にデータを保存しました。': 'Saved to IndexedDB.',
        '保存エラー: {0}': 'Save failed: {0}',
        'IndexedDB からデータを読み込みました。': 'Loaded from IndexedDB.',
        '保存されたデータがありません。': 'There is no saved data.',
        '読み込みエラー: {0}': 'Load failed: {0}',
        'このブラウザの保存データを削除し、初期状態へ戻しました。': 'Deleted the saved data in this browser and returned to the initial state.',
        '保存しました。': 'Saved.',

        // ---- ファイル ----
        'このブラウザはファイルへの直接保存に未対応のため、ダウンロードしました。':
            'This browser cannot write files directly, so it was downloaded instead.',
        '{0} に保存しました（{1} 文字）。': 'Saved to {0} ({1} characters).',
        'ファイルに保存できませんでした: {0}': 'Could not save the file: {0}',
        '読み込めませんでした: {0}': 'Could not load it: {0}',
        '{0} を読み込みました。': 'Loaded {0}.',
        'ファイルを開けませんでした: {0}': 'Could not open the file: {0}',
        'ファイル: {0}': 'File: {0}',
        '開いているファイル: {0}': 'Open file: {0}',
        '開いているファイルはありません（「名前を付けて保存」または「開く」から始めます）':
            'No file is open (start from "Save as" or "Open")',
        'このブラウザ（または file:// で開いた場合）はファイルを直接読み書きできません。':
            'This browser (or opening the page over file://) cannot read and write files directly.',
        '「保存」はダウンロード、「開く」はファイル選択に切り替わります。上書き保存はできないため、毎回新しいファイルになります。':
            '"Save" becomes a download and "Open" becomes a file picker. There is no overwrite, so every save creates a new file.',

        // ---- 書き出し / 取り込み ----
        '{0} 表 / {1} 文字を luminadb_export.sql として保存しました。':
            'Saved {0} tables / {1} characters as luminadb_export.sql.',
        'SQL ダンプを書き出しました（{0} 表）。': 'Exported the SQL dump ({0} tables).',
        '書き出せる表がありません。': 'There are no tables to export.',
        '{0} 表を JSON として書き出しました。': 'Exported {0} tables as JSON.',
        '{0}: {1} 件の SQL 文をすべて実行しました。': '{0}: ran all {1} SQL statements.',
        '{0} 件の SQL 文を実行しました。': 'Ran {0} SQL statements.',
        '{0}: {1} / {2} 件成功、{3} 件失敗': '{0}: {1} of {2} succeeded, {3} failed',
        '… 他 {0} 件': '… and {0} more',
        '{0} 件の SQL 文が失敗しました（詳細はモーダル内）。': '{0} SQL statements failed (details are in the panel).',
        'SQL の取り込みに失敗しました: {0}': 'SQL import failed: {0}',
        '{0}行のデータを {1} に追加しました。': 'Added {0} rows to {1}.',
        'データ生成失敗: {0}': 'Could not generate data: {0}',
        '新しい表の名前を英数字とアンダースコアで入力してください（先頭は英字か _）。':
            'Use letters, digits and underscores for the new table name (starting with a letter or _).',
        '新しい表の名前が不正です。': 'That table name is not valid.',
        '表 \'{0}\' はすでにあります。取り込み先から選ぶか、別の名前にしてください。':
            'Table \'{0}\' already exists. Pick it as the destination, or choose another name.',
        '表 \'{0}\' はすでに存在します。': 'Table \'{0}\' already exists.',
        '取り込み先の表が選ばれていません。': 'No destination table is selected.',
        '{0}: 取り込みに失敗しました。': '{0}: the import failed.',
        '取り込みに失敗しました: {0}': 'Import failed: {0}',
        '{0}: {1} 行を {2} に取り込みました{3}。': '{0}: imported {1} rows into {2}{3}.',
        '（表を新規作成）': ' (new table created)',
        '列: {0}': 'Columns: {0}',
        '{0} 行を {1} に取り込みました。': 'Imported {0} rows into {1}.',
        'CSV ファイルが選ばれていません。': 'No CSV file is selected.',
        'CSVファイルが選択されていません。': 'No CSV file is selected.',

        // ---- クリップボード ----
        'このブラウザではクリップボードを利用できません。': 'The clipboard is not available in this browser.',
        '{0} をコピーしました（{1} 文字）。': 'Copied {0} ({1} characters).',
        'クリップボードへのコピーに失敗しました。': 'Could not copy to the clipboard.',
        'Markdown 表': 'Markdown table',
        'TSV {0} 行': 'TSV, {0} rows',
        'INSERT 文 {0} 件': '{0} INSERT statements',
        'セルの値をコピーしました。': 'Copied the cell value.',
        'SVG をコピーしました。': 'Copied the SVG.',
        'コピーに失敗しました。': 'Copy failed.',
        'この環境ではコピーできません。': 'Copying is not available here.',
        '\'{0}\' をコピーしました。': 'Copied \'{0}\'.',

        // ---- コンソール ----
        'ログはまだありません。クエリを実行すると記録されます。': 'No log yet. Run a query and it will show up here.',
        'ログをコピーしました。': 'Copied the log.',
        'コンソールのクエリをエディタに読み込みました。': 'Loaded the console query into the editor.',
        'クリックでエディタに読込': 'Click to load into the editor',

        // ---- 実行 ----
        'runtest — テストスイートを実行': 'runtest — run the test suite',
        'この環境では Worker を使えません。': 'Web Workers are not available in this environment.',
        'ワーカー実行は参照系の文だけです。書き込みは Run を使ってください。':
            'Background runs are read-only. Use Run for statements that write.',
        '実行を中止しました。': 'Run cancelled.',
        '{0} 件取得 · {1} ms（ワーカー）': '{0} rows · {1} ms (worker)',
        'ワーカーで実行 (Ctrl+Alt+Enter) — 画面が固まらず、途中で止められる':
            'Run on a worker (Ctrl+Alt+Enter) — keeps the page responsive and can be cancelled',
        '実行中のクエリを止める': 'Stop the running query',
        'テストの読み込みに失敗しました: {0}': 'Could not load the test suites: {0}',
        'Script: {0}/{1} 文成功': 'Script: {0}/{1} statements succeeded',
        '{0} 件のエラー: {1}': '{0} errors: {1}',
        '最終結果 0 件': 'final result: 0 rows',
        '最終結果 {0} 件': 'final result: {0} rows',
        '／結果セット {0} 個': ' / {0} result sets',
        '{0} / {1} 文を実行しました（{2}{3}）。': 'Ran {0} of {1} statements ({2}{3}).',
        '{0} / {1} 文を実行しました。': 'Ran {0} of {1} statements.',
        '{0} 件取得 · {1} ms': '{0} rows · {1} ms',
        '{0} 行処理 · {1} ms': '{0} rows affected · {1} ms',
        'Explain は SELECT / WITH の文にだけ使えます。': 'Explain only works on SELECT / WITH statements.',
        'IN TRANSACTION ({0} 変更)': 'IN TRANSACTION ({0} changes)',
        '実行時間の上限を外しました。': 'Removed the execution time limit.',
        '実行時間の上限を {0} 秒にしました。': 'Set the execution time limit to {0} seconds.',


        // ---- v1.39: 見出し・主要ボタンの日本語化にともなう訳 ----
        // HTML に英語を直書きしていたため、**日本語表示のときだけ訳されず英語のまま**
        // 残っていた（見出しと CTA だけ英語という状態）。原文を日本語へ寄せ、
        // 英語はここで与える
        'クエリ入力欄': 'Query workspace',
        'スキーマとデータ': 'Schema and data',
        'SQL 補完候補': 'SQL suggestions',
        '表の一覧を開く': 'Open the table list',
        '表の編集:': 'Table editor:',
        '＋ 列を追加': '+ Add column',
        '生成される DDL': 'Generated DDL',
        'スキーマを保存': 'Save schema',
        '対象の表:': 'Target table:',
        'SVG をコピー': 'Copy SVG',
        '初期化の確認': 'Confirm reset',
        '初期化する': 'Reset data',
        'キャンセル': 'Cancel',
        'クエリ履歴': 'Query history',
        '列プロファイル:': 'Column profile:',
        'スキーマ図': 'Schema diagram',
        'キーボードショートカット': 'Keyboard shortcuts',
        'セルの値:': 'Cell value:',
        '実行時間': 'Time',
        '件数': 'Rows',
        '表示件数': 'Limit',

        // ---- v1.39: 結果エリアの案内 ----
        'クエリを実行すると、ここに結果が出ます。': 'Run a query to see results here.',
        '該当する行はありません。': 'No rows returned.',
        '（全 {0} 件から絞り込み）': ' (filtered from {0})',
        '{0} / {1} 件を表示{2}': 'Showing {0} of {1} rows{2}',
        '{0} / {1} 件を表示{2} — 下へスクロールすると続きを読み込みます':
            'Showing {0} of {1} rows{2} — scroll down to load more',
        '{0} / {1} 文を実行しました（返す行はありません）。': 'Ran {0} of {1} statements (no rows returned).',
        // {2} には i18nPlural が組んだ「エラー 1 件」/「1 error」がそのまま入る。
        // 助数詞をテンプレート側に書くと英語で "(1 errors)" になる
        '{0} / {1} 文が成功（{2}）。タブで結果とエラーを切り替えられます。':
            '{0} of {1} statements succeeded ({2}). Use the tabs to switch between results and errors.',

        // ---- v1.39: 表が 1 つも無いとき ----
        '表がまだありません。': 'No tables yet.',
        'CREATE TABLE で作るか、CSV / SQL を取り込むと、ここに一覧が出ます。':
            'Create one with CREATE TABLE, or import CSV / SQL, and it will be listed here.',
        'データを取り込む': 'Import data',

        // ---- v1.39: 編集可否バッジ（理由を画面に出す） ----
        '編集可: {0}': 'Editable: {0}',
        '読み取り専用': 'Read-only',
        '読み取り専用 — {0}': 'Read-only — {0}',
        '複数表の結合や集約は、行を元の表に対応付けられません':
            'joins and aggregates cannot be mapped back to a single base table',
        '複数の表を読んでいるため、更新先を決められません':
            'it reads more than one table, so there is no single update target',
        '{0} を含む結果は、行を元の表に対応付けられません':
            'results using {0} cannot be mapped back to rows in a base table',
        'この表に行を識別する主キー / UNIQUE がありません':
            'this table has no PRIMARY KEY or UNIQUE column to identify rows',
        '{0} を結果に含めると編集できます': 'include {0} in the result to edit rows',
        '計算列・別名列は直接更新できません': 'computed and aliased columns cannot be updated in place',
        '素の列が無いため更新先を決められません': 'there are no plain columns to update',
        'このビューは更新できません': 'this view is not updatable',
        '元の表が見つかりません': 'the underlying table was not found',
        'SELECT の結果ではありません': 'the result is not from a SELECT',

        // ---- v1.39: 実行中の表示 ----
        '実行中…': 'Running…',
        '{0} ms かかりました': 'took {0} ms',
        'Run ⧉（Ctrl+Alt+Enter）で実行すると画面が固まらず、途中で止められます。':
            'Run ⧉ (Ctrl+Alt+Enter) keeps the page responsive and lets you cancel.',


        // ---- v1.39: スキーマ編集の破壊的変更の予告 ----
        '保存すると元に戻せません': 'Saving cannot be undone',
        '列 {0} を削除します（{1} 行分の値が失われます）。':
            'Column {0} will be dropped ({1} rows of values will be lost).',
        '列 {0} の型を変えます。変換できない値は失われます。':
            'Column {0} will change type. Values that cannot be converted will be lost.',
        '列名を変えます: {0}。この名前を使っているビュー・トリガーは追随しません。':
            'Columns will be renamed: {0}. Views and triggers that use these names will not follow.',
        'クリックまたは Enter で並べ替え': 'Click or press Enter to sort',

        'ワーカーで実行（画面が固まらない・途中で止められる）':
            'Run on a worker (keeps the page responsive, can be cancelled)',

        'エラー': 'Error',


        // ---- v1.40: ツールバーの動詞も原文を日本語に揃えた ----
        '整形': 'Format',
        '実行計画': 'Explain',
        '⧉ ワーカー': 'Run ⧉',
        '中止': 'Cancel',
        '実行': 'Run',
        'CSV 書き出し': 'Export CSV',
        'JSON 書き出し': 'Export JSON',
        'Markdown コピー': 'Copy MD',
        'TSV コピー': 'Copy TSV',
        'INSERT コピー': 'Copy INSERT',
        '＋ 行': '+ Row',
        '－ 行': '− Row',
        '履歴': 'History',

        // ---- v1.40: セル詳細 / 列プロファイル / ER 図 ----
        '型:': 'Type:',
        '長さ:': 'Length:',
        'コピー': 'Copy',
        '閉じる': 'Close',
        '（{0} 行 × {1} 列）': '({0} rows × {1} columns)',
        '列': 'Column',
        '型': 'Type',
        'NULL': 'Nulls',
        '相異なり': 'Distinct',
        '最小': 'Min',
        '最大': 'Max',
        '平均': 'Avg',
        '長さ': 'Len',
        '多い値': 'Top values',
        '（{0} 表 / 外部キー {1} 本）': '({0} tables, {1} foreign keys)',
        '{0} 行': '{0} rows',

        // ---- v1.40: 処理中の表示と、編集内容の保護 ----
        '生成中…': 'Generating…',
        '取り込み中…': 'Importing…',
        '書き出し中…': 'Exporting…',
        '保存中…': 'Saving…',
        '読み込み中…': 'Loading…',
        'エディタの内容を置き換えました（Ctrl+Z で戻せます）。':
            'Replaced the editor contents (Ctrl+Z undoes it).',
        '新しいタブで開きました。': 'Opened in a new tab.',
        '{0}（全 {1}）': '{0} of {1}',

        '絞り込み後の全行を書き出します（表示件数の設定は影響しません）':
            'Exports every filtered row (the display limit does not apply)',
        '画面に描く件数の上限です。書き出し・コピーは常に絞り込み後の全行が対象になります':
            'How many rows to draw. Export and copy always cover every filtered row.',

        'エディタタブ': 'Editor tabs',
        '{0}{1} — ダブルクリック（または F2）で名前を変更': '{0}{1} — double-click (or F2) to rename',

        '{0} の操作': 'Actions for {0}',

        '表': 'Tables',

        '書き出し ▾': 'Export ▾',
        '絞り込み後の全行が対象です（表示件数の設定は影響しません）':
            'Covers every filtered row (the display limit does not apply)',

        'SQL を入力してから実行してください。表をクリックすると例が入ります。':
            'Type some SQL first. Clicking a table fills in an example.',
        '-- 実行（Ctrl + Enter）で結果が出ます。表をクリックしても中身を見られます。':
            '-- Run it (Ctrl + Enter) to see results. Clicking a table also shows its rows.',

        'エラー {0} 件（クリックで開く）': '{0} errors (click to open)',
        '警告 {0} 件（クリックで開く）': '{0} warnings (click to open)',

        'WHERE を指定していません。{0} 行すべてが対象になりました。':
            'No WHERE clause: all {0} rows were affected.',
        '元に戻す': 'Undo',
        '{0} 退避が大きすぎるため取っていません。': '{0} The database is too large to snapshot, so this cannot be undone.',
        '元に戻せませんでした: {0}': 'Could not undo: {0}',
        '実行前の状態へ戻しました。': 'Restored the state from before the statement.',

        'カテゴリへ移動': 'Jump to category',
        '{0} カテゴリ': '{0} categories',

        '列名が空の行があります。消したい列は削除ボタンを使ってください。':
            'A column name is empty. Use the delete button to remove a column.',
        '列名「{0}」は使えません。英数字とアンダースコアで入力してください（先頭は英字か _）。':
            'Column name "{0}" is not valid. Use letters, digits and underscores (starting with a letter or _).',
        '表には少なくとも 1 つの列が必要です。': 'A table needs at least one column.',
        '列名が重複しています。': 'Duplicate column names.',
        '列名': 'Column name',
        '英数字とアンダースコアで入力してください（先頭は英字か _）。':
            'Use letters, digits and underscores (starting with a letter or _).',

        'クエリ入力欄へ移動': 'Skip to the query editor',

        'このブラウザに保存したデータを完全に削除し、初期状態へ戻します。この操作は取り消せません。':
            'Permanently deletes the data saved in this browser and returns to the initial state. This cannot be undone.',

        // ---- 結果グリッド ----
        '「{0}」に一致する行がありません（全 {1} 件）。': 'No rows match "{0}" (out of {1}).',
        '結果セルをダブルクリックすると {0} を直接更新します（キー: {1}）':
            'Double-click a result cell to update {0} directly (key: {1})',
        '直接編集できません: {0}': 'Cannot edit in place: {0}',
        'キー列は直接編集できません。': 'Key columns cannot be edited in place.',
        '列 \'{0}\' は基底表の列ではないため編集できません。':
            'Column \'{0}\' is not a column of the underlying table, so it cannot be edited.',
        '{0}.{1} を更新しました。': 'Updated {0}.{1}.',
        '1 行処理 · セル編集': '1 row affected · cell edit',
        '{0} に行を追加しました。': 'Added a row to {0}.',
        '1 行処理 · 行追加': '1 row affected · row added',
        '{0} から 1 行削除しました。': 'Deleted 1 row from {0}.',
        '1 行処理 · 行削除': '1 row affected · row deleted',

        // ---- 表一覧 / メニュー ----
        'クリックで列名をエディタへ挿入': 'Click to insert the column name into the editor',
        '列を表示': 'Show columns',
        '列プロファイル（中身の要約）': 'Column profile (a summary of the contents)',
        '＋ 新しい表を作る': '+ Create a new table',
        '「{0}」に一致する表・列はありません（全 {1} 表）。': 'No tables or columns match "{0}" (out of {1} tables).',
        '{0} / {1} 表を表示中': 'Showing {0} of {1} tables',
        'データを見る（先頭 100 行）': 'View data (first 100 rows)',
        '件数を数える': 'Count the rows',
        'DDL を表示': 'Show the DDL',
        '列の一覧': 'List the columns',
        '列プロファイル': 'Column profile',
        'スキーマを編集': 'Edit the schema',
        '表名をコピー': 'Copy the table name',
        '表を削除': 'Drop the table',
        'DROP 文をエディタへ入れました。実行すると {0} は消えます。':
            'Put a DROP statement in the editor. Running it deletes {0}.',

        // ---- スキーマ / プロファイル / ER ----
        'PRIMARY KEY に指定できる列は 1 つだけです。': 'Only one column can be the PRIMARY KEY.',
        'AUTO_INCREMENT に指定できる列は 1 つだけです。': 'Only one column can be AUTO_INCREMENT.',
        'Table \'{0}\' のスキーマを更新しました。': 'Updated the schema of \'{0}\'.',
        'エラー: {0}': 'Error: {0}',
        '空の表です': 'This table is empty',
        'この列の分布を出すクエリをエディタへ': 'Put a query for this column\'s distribution in the editor',
        'この列の非NULL値はすべて異なる': 'Every non-NULL value in this column is distinct',
        '表 \'{0}\' がありません。': 'There is no table \'{0}\'.',
        '外部キーはまだありません': 'There are no foreign keys yet',
        '表がありません。': 'There are no tables.',
        '図がありません。': 'There is no diagram.',

        // ---- エディタタブ / 履歴 ----
        'このタブを閉じる': 'Close this tab',
        'タブは最大 {0} 枚までです。': 'You can have at most {0} tabs.',
        'タブ名': 'Tab name',
        '履歴はまだありません。': 'No history yet.',
        '一致する履歴がありません。': 'No matching history.',
        '{0} 件ヒット': '{0} matches',

        // ---- 起動 ----
        '自動読み込みに失敗しました: {0}': 'Auto-load failed: {0}',

        // ============================================================
        // コマンドリファレンス（名前と SQL 例の中の日本語）
        // ============================================================
        '日付 + 日数': 'Date + days',
        '日付 - 日数': 'Date - days',
        '日付 - 日付（日数差）': 'Date - date (difference in days)',
        '日付列の演算': 'Arithmetic on date columns',
        'INTERVAL 版（従来どおり）': 'INTERVAL form (as before)',
        'ROWNUM で上位 n 件': 'Top n rows with ROWNUM',
        'ROWNUM を列として': 'ROWNUM as a column',
        '~ 正規表現': '~ regular expression',
        '~* 大小無視の正規表現': '~* case-insensitive regular expression',
        '!~ 否定': '!~ negation',
        'TRUNCATE 複数表': 'TRUNCATE several tables',
        'ADD COLUMN の生成列': 'A generated column via ADD COLUMN',
        'COLLATE NUMERIC (自然順)': 'COLLATE NUMERIC (natural order)',
        '予約語を列名に使う': 'Reserved words as column names',
        'バッククォートで参照する': 'Referring to them with backticks',
        'ダブルクォートは文字列': 'Double quotes make a string',
        'GROUPING SETS に ROLLUP': 'ROLLUP inside GROUPING SETS',
        'GROUPING SETS に CUBE': 'CUBE inside GROUPING SETS',
        '集合の組み合わせ': 'Combining the sets',
        'SQL ダンプは全オブジェクトを含む': 'The SQL dump covers every object',
        '算術も NULL を伝播する': 'Arithmetic propagates NULL too',
        '集計は NULL を数えない': 'Aggregates do not count NULL',
        '0 除算は NULL': 'Division by zero is NULL',
        'DATE は日付だけ': 'DATE keeps only the date',
        'DATETIME / TIMESTAMP は時刻も残す': 'DATETIME / TIMESTAMP keep the time as well',
        '日次の集計': 'Daily aggregation',
        '日付の比較は時刻で行う': 'Dates compare by their instant',
        'ウィンドウの既定フレーム': 'The default window frame',
        'パーティション全体を見る': 'Looking at the whole partition',
        'NULL 比較は UNKNOWN': 'Comparing with NULL gives UNKNOWN',
        '範囲条件は NULL 行を拾わない': 'Range conditions skip NULL rows',
        'NULL を調べるのは IS NULL': 'Use IS NULL to test for NULL',
        'NOT も 3 値論理': 'NOT is three-valued too',
        'NULL を含む NOT IN は真にならない': 'NOT IN with a NULL is never true',
        'NOT LIKE も NULL を除く': 'NOT LIKE drops NULL as well',
        'CHECK は UNKNOWN を通す': 'CHECK lets UNKNOWN through',
        'IS DISTINCT FROM で NULL 込みの比較': 'IS DISTINCT FROM compares including NULL',

        'SELECT * FROM {table} /* ブロックコメント */ LIMIT 3 -- 行コメント':
            'SELECT * FROM {table} /* block comment */ LIMIT 3 -- line comment',
        'SELECT SOUNDEX(\'Robert\'), SOUNDEX(\'Rupert\') -- 発音が近い名前は同じコードになる':
            'SELECT SOUNDEX(\'Robert\'), SOUNDEX(\'Rupert\') -- names that sound alike get the same code',
        'SELECT UNHEX(HEX(\'abc\')), OCTET_LENGTH(\'こんにちは\'), BIT_LENGTH(\'ab\')':
            'SELECT UNHEX(HEX(\'abc\')), OCTET_LENGTH(\'hello\'), BIT_LENGTH(\'ab\')',
        'SHOW SEQUENCES -- 削除: DROP SEQUENCE IF EXISTS order_seq':
            'SHOW SEQUENCES -- to remove one: DROP SEQUENCE IF EXISTS order_seq',
        'SHOW PREPARED -- 解放: DEALLOCATE PREPARE find_user':
            'SHOW PREPARED -- to release one: DEALLOCATE PREPARE find_user',
        'SELECT * FROM t1 JOIN t2 USING (id) -- 共通列すべてなら: t1 NATURAL JOIN t2':
            'SELECT * FROM t1 JOIN t2 USING (id) -- for every shared column: t1 NATURAL JOIN t2',
        'SELECT v FROM t1 INTERSECT ALL SELECT v FROM t2 -- 多重集合演算（重複を保持）':
            'SELECT v FROM t1 INTERSECT ALL SELECT v FROM t2 -- multiset operation (duplicates kept)',
        'SELECT (\'がぎ\' COLLATE NOACCENT = \'かき\') AS same':
            'SELECT (\'がぎ\' COLLATE NOACCENT = \'かき\') AS same',
        'SELECT id AS "row id", name AS "名前" FROM {table}':
            'SELECT id AS "row id", name AS "full name" FROM {table}',
        'SELECT HEX(\'あ\'), UNHEX(HEX(\'あ\'))': 'SELECT HEX(\'あ\'), UNHEX(HEX(\'あ\'))',
        'SELECT ORD(\'あ\') AS code, UNISTR(CONCAT(CHAR(92), \'0041\')) AS ch, CONTAINS(name, \'a\') AS has_a FROM {table}':
            'SELECT ORD(\'あ\') AS code, UNISTR(CONCAT(CHAR(92), \'0041\')) AS ch, CONTAINS(name, \'a\') AS has_a FROM {table}',
        'SELECT * FROM {table} WHERE age < 100     -- age が NULL の行は含まれない':
            'SELECT * FROM {table} WHERE age < 100     -- rows where age IS NULL are left out',
        'SELECT * FROM {table} WHERE age NOT IN (25, NULL)   -- 常に 0 件':
            'SELECT * FROM {table} WHERE age NOT IN (25, NULL)   -- always returns nothing',

        '-- 日付型の列にもそのまま効く\n-- SELECT nm, hire + 90 AS probation_end FROM emp':
            '-- works on DATE columns just the same\n-- SELECT nm, hire + 90 AS probation_end FROM emp',
        '-- 組織図をたどる\n-- SELECT nm, LEVEL FROM emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr':
            '-- walk an org chart\n-- SELECT nm, LEVEL FROM emp START WITH mgr IS NULL CONNECT BY PRIOR id = mgr',
        '-- 同じ親の子どもの並び順を決める\n-- ... CONNECT BY PRIOR id = mgr ORDER SIBLINGS BY nm':
            '-- order the children of the same parent\n-- ... CONNECT BY PRIOR id = mgr ORDER SIBLINGS BY nm',
        '-- データが循環していても止まる\n-- ... CONNECT BY NOCYCLE PRIOR id = mgr':
            '-- terminates even when the data loops\n-- ... CONNECT BY NOCYCLE PRIOR id = mgr',
        '-- ウィンドウ関数は選択項目そのものである必要があるので、加工は副問い合わせの外で行う\nSELECT name, ROUND(r * 100, 1) AS pct FROM (SELECT name, RATIO_TO_REPORT(age) OVER () AS r FROM {table}) q':
            '-- a window function has to be the select item itself, so do the arithmetic outside the subquery\nSELECT name, ROUND(r * 100, 1) AS pct FROM (SELECT name, RATIO_TO_REPORT(age) OVER () AS r FROM {table}) q',
        '-- 指定した表をすべて空にする\n-- TRUNCATE TABLE t1, t2':
            '-- empty every listed table\n-- TRUNCATE TABLE t1, t2',
        '-- 実際に書き込んだ行だけが返る\n-- INSERT INTO t (id, nm) VALUES (1, \'a\') ON CONFLICT (id) DO NOTHING RETURNING id':
            '-- only the rows actually written come back\n-- INSERT INTO t (id, nm) VALUES (1, \'a\') ON CONFLICT (id) DO NOTHING RETURNING id',
        '-- \'Apple\' も \'APPLE\' も一致する\n-- SELECT * FROM v21_ci WHERE nm = \'APPLE\'':
            '-- matches both \'Apple\' and \'APPLE\'\n-- SELECT * FROM v21_ci WHERE nm = \'APPLE\'',
        '-- 識別列に与えた値をそのまま使う\n-- INSERT INTO t (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, \'a\')':
            '-- use the value given for the identity column as-is\n-- INSERT INTO t (id, nm) OVERRIDING SYSTEM VALUE VALUES (99, \'a\')',
        '-- 与えた値を捨てて自動採番させる\n-- INSERT INTO t (id, nm) OVERRIDING USER VALUE VALUES (99, \'b\')':
            '-- throw the given value away and let it auto-number\n-- INSERT INTO t (id, nm) OVERRIDING USER VALUE VALUES (99, \'b\')',
        '-- 循環するグラフでも上限エラーにならず、印を付けて止まる\n-- WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM g JOIN t ON g.a = t.n)\n--   CYCLE n SET is_cycle USING path\n-- SELECT n, is_cycle, path FROM t':
            '-- a cyclic graph stops with a marker instead of hitting the recursion cap\n-- WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT g.b FROM g JOIN t ON g.a = t.n)\n--   CYCLE n SET is_cycle USING path\n-- SELECT n, is_cycle, path FROM t',
        '-- バッククォートで囲むと予約語も識別子として使える\n-- CREATE TABLE t (`order` INTEGER, `select` TEXT)':
            '-- backticks let a reserved word be an identifier\n-- CREATE TABLE t (`order` INTEGER, `select` TEXT)',
        '-- MySQL 既定と同じ。識別子にはバッククォートを使う\nSELECT "plain text" AS s':
            '-- same as MySQL\'s default; use backticks for identifiers\nSELECT "plain text" AS s',
        '-- 表・データ・索引・ビュー・シーケンスに加えて\n-- トリガー・関数・プロシージャ・コメントも書き出される（Data → 書き出し）':
            '-- tables, data, indexes, views and sequences, plus\n-- triggers, functions, procedures and comments (Data → Export)',
        '-- どれか一つでも NULL なら結果は NULL（0 として扱わない）\nSELECT NULL + 10, 10 - NULL, NULL * 0':
            '-- if any operand is NULL the result is NULL (it is not treated as 0)\nSELECT NULL + 10, 10 - NULL, NULL * 0',
        '-- 式が NULL になった行は AVG の分母にも MIN の候補にも入らない\nSELECT AVG(price * stock), MIN(price * stock), COUNT(price * stock) FROM {table}':
            '-- rows where the expression is NULL count neither in AVG\'s divisor nor as a MIN candidate\nSELECT AVG(price * stock), MIN(price * stock), COUNT(price * stock) FROM {table}',
        '-- 時刻を切り捨てて 1 日にまとめる\n-- SELECT CAST(at AS DATE) AS d, COUNT(*) FROM events GROUP BY CAST(at AS DATE)':
            '-- drop the time to group by day\n-- SELECT CAST(at AS DATE) AS d, COUNT(*) FROM events GROUP BY CAST(at AS DATE)',
        '-- ORDER BY だけなら RANGE ... CURRENT ROW（同じ並び順の行はまとめて同じ値）\nSELECT age, SUM(age) OVER (ORDER BY age) FROM {table}':
            '-- ORDER BY alone means RANGE ... CURRENT ROW (ties share one value)\nSELECT age, SUM(age) OVER (ORDER BY age) FROM {table}',
        '-- 親が消えたら子を既定値へ戻す\n-- CREATE TABLE c (pid INT DEFAULT 9, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET DEFAULT)':
            '-- when the parent goes, put the child back to its default\n-- CREATE TABLE c (pid INT DEFAULT 9, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET DEFAULT)',
        '-- どちらかが NULL なら結果は真でも偽でもない（WHERE は通さない）\nSELECT NULL = NULL, 1 = NULL, 1 <> NULL':
            '-- with a NULL on either side the result is neither true nor false (WHERE drops it)\nSELECT NULL = NULL, 1 = NULL, 1 <> NULL',
        '-- NOT UNKNOWN は UNKNOWN。NULL の行は通らない\nSELECT * FROM {table} WHERE NOT (age = 25)':
            '-- NOT UNKNOWN is UNKNOWN, so NULL rows still do not pass\nSELECT * FROM {table} WHERE NOT (age = 25)',
        '-- b が NULL の行は CHECK 違反にならない（SQL 標準）\n-- CREATE TABLE t (a INT, b INT CHECK (b > 0));  INSERT INTO t (a) VALUES (1)':
            '-- a row with b NULL does not violate the CHECK (SQL standard)\n-- CREATE TABLE t (a INT, b INT CHECK (b > 0));  INSERT INTO t (a) VALUES (1)',
        '-- 同名の列は 2 つ目以降に _1, _2 … が付く（消えない）\nSELECT id, id, id FROM {table}':
            '-- duplicate column names get _1, _2 … instead of disappearing\nSELECT id, id, id FROM {table}',
        '-- 「組が一意」であって「各列が一意」ではない\nCREATE UNIQUE INDEX ux_pair ON {table} (id, name)':
            '-- the pair is unique, not each column on its own\nCREATE UNIQUE INDEX ux_pair ON {table} (id, name)',
        '-- 生成列・CHECK・索引名・列順すべて追随する\nALTER TABLE {table} RENAME COLUMN name TO nm':
            '-- generated columns, CHECKs, index names and column order all follow\nALTER TABLE {table} RENAME COLUMN name TO nm',
        '-- 期間は YYYYMM（または YYMM）\nSELECT PERIOD_ADD(202401, 3) AS moved, PERIOD_DIFF(202406, 202401) AS months':
            '-- a period is YYYYMM (or YYMM)\nSELECT PERIOD_ADD(202401, 3) AS moved, PERIOD_DIFF(202406, 202401) AS months',
        '-- \'UTC\' / \'JST\' / \'+09:00\' 形式（IANA 名は非対応）\nSELECT CONVERT_TZ(\'2026-01-01 12:00:00\', \'UTC\', \'+09:00\') AS jst':
            '-- \'UTC\' / \'JST\' / \'+09:00\' style names only (no IANA names)\nSELECT CONVERT_TZ(\'2026-01-01 12:00:00\', \'UTC\', \'+09:00\') AS jst',
        '-- MySQL と同じく NOW() と同義\nSELECT LOCALTIME AS a, LOCALTIMESTAMP AS b':
            '-- same as NOW(), following MySQL\nSELECT LOCALTIME AS a, LOCALTIMESTAMP AS b',
        '-- 同キーは配列へまとめる（MERGE_PATCH は上書き）\nSELECT JSON_MERGE_PRESERVE(\'{"a": 1}\', \'{"a": 2, "b": 3}\')':
            '-- shared keys become an array (MERGE_PATCH overwrites)\nSELECT JSON_MERGE_PRESERVE(\'{"a": 1}\', \'{"a": 2, "b": 3}\')',
        '-- 単一スキーマなので名前を記録するだけ\nCREATE DATABASE shop; USE shop; USE main; DROP DATABASE shop':
            '-- one schema only, so the name is merely recorded\nCREATE DATABASE shop; USE shop; USE main; DROP DATABASE shop',
        '-- 保存・エクスポート対象外（セッション限り）\nCREATE TEMPORARY VIEW v_session AS SELECT id FROM {table}':
            '-- never saved or exported (session only)\nCREATE TEMPORARY VIEW v_session AS SELECT id FROM {table}',
        '-- USING > は DESC、USING < は ASC\nSELECT id, age FROM {table} ORDER BY age USING >, id':
            '-- USING > means DESC, USING < means ASC\nSELECT id, age FROM {table} ORDER BY age USING >, id',

        '// JSコンソールから: LuminaDB.query(\'SELECT * FROM users WHERE id = ?\', [1])':
            '// from the JS console: LuminaDB.query(\'SELECT * FROM users WHERE id = ?\', [1])',
        '// LuminaDB.insert(\'users\', { id: 11, name: \'Ken\', age: 20 })  // 配列で複数行も可':
            '// LuminaDB.insert(\'users\', { id: 11, name: \'Ken\', age: 20 })  // an array inserts several rows',
        '// LuminaDB.transaction(api => { api.insert(\'t\', {...}); api.update(\'t\', {...}, {...}); })  // throwでROLLBACK':
            '// LuminaDB.transaction(api => { api.insert(\'t\', {...}); api.update(\'t\', {...}, {...}); })  // throw to ROLLBACK',
        '// await LuminaDB.worker.timeout(2000)   // ワーカー側の文単位タイムアウト':
            '// await LuminaDB.worker.timeout(2000)   // per-statement timeout on the worker',
        '// LuminaDB.schemaVersion()      // PRAGMA user_version と同じ値':
            '// LuminaDB.schemaVersion()      // the same value as PRAGMA user_version',
        '// LuminaDB.download(\'mydb.json\')          // ダウンロード\n// LuminaDB.restoreBackup(await file.text()) // 復元':
            '// LuminaDB.download(\'mydb.json\')          // download\n// LuminaDB.restoreBackup(await file.text()) // restore',
        '// LuminaDB.saveStats()   // { tables, written, skipped, removed } — 差分保存が効いているかの確認':
            '// LuminaDB.saveStats()   // { tables, written, skipped, removed } — is incremental saving working?',
        '// LuminaDB.autoReload(true)   // 他タブの保存を自動で読み直す':
            '// LuminaDB.autoReload(true)   // reload automatically when another tab saves',
        '// LuminaDB.cacheStats()   // { hits, misses, size, hitRate } — 同じ形のクエリの再コンパイルを省けているか':
            '// LuminaDB.cacheStats()   // { hits, misses, size, hitRate } — are same-shape queries avoiding recompilation?',
        '// const h = LuminaDB.onLeader(() => startBackgroundSync());\n// h.release();   // 別タブが自動的に昇格する':
            '// const h = LuminaDB.onLeader(() => startBackgroundSync());\n// h.release();   // another tab is promoted automatically'
    });
