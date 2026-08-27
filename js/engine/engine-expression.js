    // ============================================================================
    // [DatabaseEngine Expression] - SQL式のJS関数へのコンパイル / 文字列リテラル処理
    // ============================================================================
    // ------------------------------------------------------------------------
    // 式評価ヘルパーライブラリ（モジュール読込時に1度だけ生成される共有オブジェクト）。
    // 以前は compileCondition が生成する関数の本体に全ヘルパーを文字列として埋め込み、
    // 「行評価のたびに」約190個のクロージャを再生成していた（大規模スキャンの主要コスト）。
    // 現在はコンパイル時に一度だけ分割代入で束縛し、行評価は式本体のみを実行する。
    // 注意: ヘルパーは全て状態を持たない（相関サブクエリは ptrs/dbTables/aliases を
    // 引数で受け取り、シーケンス等は dbTables.__engine__ 経由でエンジンへ到達する）
    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // 組み込み関数の引数個数（[最小, 最大]。最大 null は可変長）。
    //
    // ここに載せるのは「カンマ区切りの引数しか取らない」関数だけ。
    // EXTRACT / CAST / TRIM / SUBSTRING / POSITION / OVERLAY のように
    // キーワードで引数を区切る綴りを持つ関数は、1 引数と数えてしまうため載せない。
    // 集計・ウィンドウ・ユーザー定義関数も対象外（_checkBuiltinArity 側で除外）。
    // 表に無い名前は従来どおり寛容なままなので、この表は「増やすほど厳しくなる」だけで
    // 既存の動作を狭めることはない
    // ------------------------------------------------------------------------
    // `IN (...)` の照合を O(1) にするための、リストごとの索引。
    //
    // __in はリストを線形に走査していた。`IN (1, 2, 3)` なら何でもないが、
    // `WHERE k IN (SELECT g FROM t)` は同じ 20 万件の配列を 1 行ごとに舐めるので
    // 外側 400 行 × 20 万件 = 8,000 万回の比較になっていた（実測 810ms。
    // 同じ意味を JOIN で書くと 3ms なので、書き方だけで 270 倍違っていた）。
    //
    // WeakMap のキーはリスト配列そのものなので、その配列が生きている間だけ索引も残る。
    // ヘルパーは状態を持たない方針だが、これは配列の同一性に紐づく純粋なメモなので
    // クエリ間へ漏れることはない
    // 全文検索の語切り。転置索引（Table.ftPostings）と照合（__match_against）が
    // 同じ規則で切らないと、索引で拾えない行が出て「索引の有無で答えが変わる」。
    // 1 箇所に置いて両方から使う
    const LUMINA_DEC_PLACES = (v) => {
        if (!isFinite(v)) return -1;
        if (Number.isInteger(v)) return 0;
        const s = String(v);
        const e = s.indexOf('e') !== -1 ? s.indexOf('e') : s.indexOf('E');
        if (e !== -1) {
            const exp = Number(s.slice(e + 1));
            const mant = s.slice(0, e);
            const dot = mant.indexOf('.');
            const mantDec = dot === -1 ? 0 : mant.length - dot - 1;
            const d = mantDec - exp;
            return d > 0 ? d : 0;
        }
        const dot = s.indexOf('.');
        return dot === -1 ? 0 : s.length - dot - 1;
    };
    const LUMINA_FT_TOKENS = (s) => {
        if (s == null) return [];
        return String(s).toLowerCase()
            .replace(/[　-〿・]/g, ' ')
            .split(/[^0-9a-z_À-ɏ぀-ヿ一-鿿]+/)
            .filter(t => t !== '');
    };

    // 検索語の切り出し。転置索引で候補を絞る側（engine-select）と、実際に一致を判定する
    // 側（__match_against）が同じ解釈をしないと、索引経路だけ取りこぼす行が出る
    const LUMINA_FT_PARSE = (query, mode) => {
        const raw = String(query == null ? '' : query);
        const boolean = /bool/i.test(String(mode || ''));
        const terms = [];
        const re = /([+-]?)(?:"([^"]*)"|(\S+))/g;
        let m;
        while ((m = re.exec(raw))) {
            const body = m[2] !== undefined ? m[2] : m[3];
            const toks = LUMINA_FT_TOKENS(body);
            if (toks.length === 0) continue;
            terms.push({ sign: boolean ? m[1] : '', phrase: ' ' + toks.join(' '), prefix: /\*$/.test(body), toks });
        }
        return { boolean, terms };
    };

    const LUMINA_IN_SETS = new WeakMap();

    const LUMINA_FN_ARITY = {
        // 数値
        ABS: [1, 1], SIGN: [1, 1], CEIL: [1, 1], CEILING: [1, 1], FLOOR: [1, 1],
        SQRT: [1, 1], EXP: [1, 1], LN: [1, 1], LOG2: [1, 1], LOG10: [1, 1], LOG: [1, 2],
        POWER: [2, 2], POW: [2, 2], MOD: [2, 2], ROUND: [1, 2], SQUARE: [1, 1],
        GCD: [2, 2], LCM: [2, 2], FACTORIAL: [1, 1], CBRT: [1, 1],
        SIN: [1, 1], COS: [1, 1], TAN: [1, 1], ASIN: [1, 1], ACOS: [1, 1], ATAN: [1, 1],
        ATAN2: [2, 2], DEGREES: [1, 1], RADIANS: [1, 1], PI: [0, 0],
        // 文字列
        LOWER: [1, 1], UPPER: [1, 1], LCASE: [1, 1], UCASE: [1, 1],
        LENGTH: [1, 1], CHAR_LENGTH: [1, 1], CHARACTER_LENGTH: [1, 1], OCTET_LENGTH: [1, 1],
        LEFT: [2, 2], RIGHT: [2, 2], REVERSE: [1, 1], REPEAT: [2, 2], SPACE: [1, 1],
        REPLACE: [3, 3], LPAD: [2, 3], RPAD: [2, 3], CONCAT_WS: [2, null],
        INSTR: [2, 2], STRCMP: [2, 2], INITCAP: [1, 1], ASCII: [1, 1],
        STARTS_WITH: [2, 2], ENDS_WITH: [2, 2], CHARINDEX: [2, 3], SPLIT_PART: [3, 3],
        LEVENSHTEIN: [2, 2], TRANSLATE: [3, 3],
        // 条件・NULL
        NULLIF: [2, 2], IFNULL: [2, 2], ISNULL: [2, 2], NVL: [2, 2], NVL2: [3, 3],
        COALESCE: [1, null], GREATEST: [1, null], LEAST: [1, null],
        ZEROIFNULL: [1, 1], NULLIFZERO: [1, 1],
        // 日付
        YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], HOUR: [1, 1], MINUTE: [1, 1], SECOND: [1, 1],
        QUARTER: [1, 1], DAYOFWEEK: [1, 1], DAYOFYEAR: [1, 1], WEEKOFYEAR: [1, 1],
        LAST_DAY: [1, 1], MONTHNAME: [1, 1], DAYNAME: [1, 1], DATEDIFF: [2, 3],
        ADD_MONTHS: [2, 2], MONTHS_BETWEEN: [2, 2], DATE_FORMAT: [2, 2],
        SEC_TO_TIME: [1, 1], TIME_TO_SEC: [1, 1], FROM_UNIXTIME: [1, 2],
        // ハッシュ・符号化
        MD5: [1, 1], SHA1: [1, 1], SHA256: [1, 1], SHA224: [1, 1], CRC32: [1, 1],
        HEX: [1, 1], UNHEX: [1, 1], TO_BASE64: [1, 1], FROM_BASE64: [1, 1],
        BIN: [1, 1], OCT: [1, 1], CONV: [3, 3],
        // JSON
        // JSON_TYPE は省略可能なパスを取る 2 引数形も受ける（実装に合わせる）
        JSON_VALID: [1, 1], JSON_TYPE: [1, 2], JSON_DEPTH: [1, 1], JSON_LENGTH: [1, 2],
        JSON_KEYS: [1, 2], JSON_PRETTY: [1, 1], JSON_QUOTE: [1, 1], JSON_UNQUOTE: [1, 1],
        JSON_EXTRACT: [2, null], JSON_CONTAINS: [2, 3], JSON_SET: [3, null],
        JSON_REMOVE: [2, null], JSON_ARRAY: [0, null], JSON_OBJECT: [0, null],
        // --- v1.30 追加: 引数個数が決まっているのに未登録だった関数 ---
        // 未登録の関数は個数を間違えても黙って NULL を返していた
        // （WIDTH_BUCKET(1, 0, 10) が誤りと分からず NULL になっていた）。
        // なお SUBSTRING / TRIM / POSITION / OVERLAY はカンマを使わない
        // キーワード構文（FROM / FOR / PLACING）も取るため、ここには載せない
        BITAND: [2, 2], BITOR: [2, 2], BITXOR: [2, 2], BITNOT: [1, 1], BIT_COUNT: [1, 1],
        SHIFTLEFT: [2, 2], SHIFTRIGHT: [2, 2], TRUNC: [1, 2], TRUNCATE: [1, 2],
        REMAINDER: [2, 2], NANVL: [2, 2], WIDTH_BUCKET: [4, 4], SINH: [1, 1], COSH: [1, 1],
        TANH: [1, 1], COT: [1, 1], ISNUMERIC: [1, 1], FORMAT_BYTES: [1, 1],
        LEN: [1, 1], LTRIM: [1, 2], RTRIM: [1, 2], SUBSTRING_INDEX: [3, 3], LOCATE: [2, 3],
        PATINDEX: [2, 2], STRPOS: [2, 2], REPLICATE: [2, 2], SOUNDEX: [1, 1], QUOTE: [1, 1],
        QUOTENAME: [1, 2], QUOTE_IDENT: [1, 1], QUOTE_LITERAL: [1, 1], STUFF: [4, 4],
        FORMAT: [1, 2], PARSENAME: [2, 2], BIT_LENGTH: [1, 1], CHR: [1, 1],
        DAYOFMONTH: [1, 1], WEEKDAY: [1, 1], WEEK: [1, 2], NEXT_DAY: [2, 2],
        TO_DAYS: [1, 1], FROM_DAYS: [1, 1], MAKEDATE: [2, 2], MAKETIME: [3, 3],
        MAKE_DATE: [3, 3], MAKE_TIMESTAMP: [6, 6], DATE_TRUNC: [2, 2], DATE_PART: [2, 2],
        DATE_ADD: [2, 2], DATE_SUB: [2, 2], ADDDATE: [2, 2], SUBDATE: [2, 2],
        STR_TO_DATE: [2, 2], TO_DATE: [1, 2], TO_TIMESTAMP: [1, 2], TO_CHAR: [1, 2],
        TO_NUMBER: [1, 2], SHA2: [1, 2], INET_ATON: [1, 1], INET_NTOA: [1, 1],
        TO_HEX: [1, 1], TYPEOF: [1, 1], JSON_VALUE: [2, 2], JSON_CONTAINS_PATH: [3, null],
        JSON_MERGE_PATCH: [2, null], JSON_ARRAY_APPEND: [3, null], JSON_ARRAY_INSERT: [3, null],
        // --- v1.33 追加 ---
        BTRIM: [1, 2], ENCODE: [2, 2], ORD: [1, 1], UNISTR: [1, 1], CONTAINS: [2, 2],
        TIMEDIFF: [2, 2], YEARWEEK: [1, 1], PERIOD_ADD: [2, 2], PERIOD_DIFF: [2, 2],
        JULIAN_DAY: [1, 1], JULIANDAY: [1, 1], CONVERT_TZ: [3, 3],
        JSON_SEARCH: [3, 3], JSON_MERGE_PRESERVE: [2, null],
        ARRAY_DISTINCT: [1, 1], ARRAY_CAT: [2, 2], ARRAY_REVERSE: [1, 1],
        JSON_INSERT: [3, null], JSON_REPLACE: [3, null],
        // REGEXP 系は MySQL 同様 pos / occurrence / return_option / match_type を後置できる
        REGEXP_LIKE: [2, 3], REGEXP_REPLACE: [3, 6], REGEXP_SUBSTR: [2, 6],
        REGEXP_INSTR: [2, 6], REGEXP_COUNT: [2, 4], IIF: [3, 3], NULLIF: [2, 2]
    };

    // 「AS を省いた後置別名」の判定に使う語彙（_trailingAlias）。
    // ここに載る語が SELECT 項目の末尾に来ても別名とは見なさない。
    // 例: `a IS NULL` の NULL / `INTERVAL 1 DAY` の DAY / `x COLLATE NOCASE` の NOCASE は
    // 直前語判定で弾かれるが、`... IGNORE NULLS` の NULLS のように語自体で弾く必要もある
    const LUMINA_NON_ALIAS_WORDS = new Set([
        'null', 'true', 'false', 'unknown', 'not', 'and', 'or', 'is', 'in', 'like', 'ilike', 'rlike',
        'regexp', 'similar', 'to', 'escape', 'collate', 'between', 'from', 'over', 'filter', 'within',
        'group', 'by', 'keep', 'respect', 'ignore', 'nulls', 'first', 'last', 'desc', 'asc', 'distinct',
        'all', 'any', 'some', 'end', 'then', 'else', 'when', 'case', 'zone', 'time', 'at', 'using',
        'prior', 'interval', 'exists', 'unbounded', 'preceding', 'following', 'current', 'row', 'rows',
        'range', 'groups', 'exclude', 'replace', 'ties', 'only', 'partition', 'separator', 'on', 'as',
        'into', 'where', 'having', 'qualify', 'order', 'limit', 'offset', 'fetch', 'join', 'inner',
        'left', 'right', 'full', 'cross', 'natural', 'outer', 'union', 'intersect', 'except', 'window',
        'day', 'days', 'month', 'months', 'year', 'years', 'hour', 'hours', 'minute', 'minutes',
        'second', 'seconds', 'week', 'weeks', 'quarter', 'quarters', 'microsecond', 'microseconds',
        'millisecond', 'milliseconds', 'decade', 'century', 'millennium', 'epoch', 'dow', 'doy',
        'timezone_hour', 'timezone_minute', 'isoyear', 'isodow', 'value', 'siblings', 'connect', 'start'
    ]);
    // 「語 + 空白 + 開き括弧」の空白を詰めてよいかの判定に使う語彙。
    // 関数名の写像は `\bNAME\(` の形で行うため、`ABS (x)` のように空白を挟むと
    // 名前が未変換のまま残ってしまう。ここに載る語は括弧を伴う SQL の構文なので詰めない
    const LUMINA_PAREN_KEYWORDS = new Set([
        'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'ANY', 'SOME', 'ALL', 'LIKE', 'ILIKE', 'RLIKE', 'REGEXP',
        'SIMILAR', 'TO', 'IS', 'DISTINCT', 'FROM', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BETWEEN',
        'ESCAPE', 'COLLATE', 'INTERVAL', 'ARRAY', 'OVER', 'PARTITION', 'BY', 'FILTER', 'WHERE',
        'SELECT', 'VALUES', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'ORDER', 'GROUP', 'HAVING',
        'LIMIT', 'OFFSET', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'ROW', 'ROWS', 'RANGE', 'GROUPS',
        'PRECEDING', 'FOLLOWING', 'CURRENT', 'UNBOUNDED', 'USING', 'JOIN', 'ON', 'AS', 'AT',
        'ZONE', 'MATCH', 'AGAINST', 'RETURNING', 'INTO', 'SET', 'WITH', 'RECURSIVE', 'FOR', 'PLACING',
        'LEADING', 'TRAILING', 'BOTH', 'IGNORE', 'RESPECT', 'NULL', 'TRUE', 'FALSE', 'WITHIN', 'KEEP',
        'EXCLUDE', 'TABLE', 'LATERAL', 'APPLY', 'PIVOT', 'UNPIVOT', 'PRIOR', 'CONNECT', 'START',
        'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'REFERENCES', 'CONSTRAINT', 'INDEX'
        // TIME / IF は関数名でもある（AT TIME ZONE の後ろに括弧は来ない）ので詰める側に置く
    ]);
    // 直後に被演算子が来る語。これが直前にあれば末尾の語は別名ではない
    const LUMINA_OPERAND_EXPECTING_WORDS = new Set([
        'not', 'and', 'or', 'is', 'in', 'like', 'ilike', 'rlike', 'regexp', 'similar', 'to', 'escape',
        'collate', 'between', 'when', 'then', 'else', 'case', 'by', 'separator', 'from', 'at', 'zone',
        'all', 'any', 'some', 'exists', 'prior', 'interval', 'distinct', 'over', 'filter', 'within',
        'using', 'on', 'as', 'partition', 'order', 'group', 'where', 'having', 'select', 'preceding',
        'following', 'unbounded', 'row', 'rows', 'range', 'groups', 'exclude', 'keep', 'respect', 'ignore'
    ]);

    // CAST / CONVERT / '::' が受け付ける型名 -> __cast の正準名。
    // 商用DBの型名は方言ごとに別名が多い（INT4/INT8/NUMBER/VARCHAR2/NVARCHAR ...）ため
    // ここへ寄せる。ここに無い型名は「変換せず素通し」になる
    const CAST_TYPE_ALIASES = {
        'INT': 'INTEGER', 'INTEGER': 'INTEGER', 'INT2': 'INTEGER', 'INT4': 'INTEGER', 'INT8': 'INTEGER',
        'SMALLINT': 'INTEGER', 'TINYINT': 'INTEGER', 'MEDIUMINT': 'INTEGER', 'BIGINT': 'INTEGER',
        'SERIAL': 'INTEGER', 'BIGSERIAL': 'INTEGER', 'SIGNED': 'INTEGER', 'UNSIGNED': 'INTEGER',
        'DECIMAL': 'DECIMAL', 'DEC': 'DECIMAL', 'NUMERIC': 'DECIMAL', 'NUMBER': 'DECIMAL',
        'MONEY': 'DECIMAL', 'SMALLMONEY': 'DECIMAL',
        'FLOAT': 'FLOAT', 'REAL': 'FLOAT', 'DOUBLE': 'FLOAT', 'DOUBLE PRECISION': 'FLOAT',
        'BINARY_FLOAT': 'FLOAT', 'BINARY_DOUBLE': 'FLOAT',
        'TEXT': 'TEXT', 'CHAR': 'TEXT', 'CHARACTER': 'TEXT', 'CHARACTER VARYING': 'TEXT',
        'VARCHAR': 'TEXT', 'VARCHAR2': 'TEXT', 'NVARCHAR': 'TEXT', 'NVARCHAR2': 'TEXT', 'NCHAR': 'TEXT',
        'STRING': 'TEXT', 'CLOB': 'TEXT', 'NCLOB': 'TEXT',
        'LONGTEXT': 'TEXT', 'MEDIUMTEXT': 'TEXT', 'TINYTEXT': 'TEXT',
        'BOOL': 'BOOLEAN', 'BOOLEAN': 'BOOLEAN',
        // DATE は「日付だけ」、DATETIME / TIMESTAMP は「日付＋時刻」。同じ正準名にすると
        // CAST(x AS DATE) が時刻を残してしまい、日次 GROUP BY が 1 日を時刻ごとに割ってしまう
        'DATE': 'DATEONLY',
        'DATETIME': 'DATE', 'DATETIME2': 'DATE', 'SMALLDATETIME': 'DATE', 'TIMESTAMP': 'DATE',
        'TIME': 'TIME'
    };

    const __EXPR_LIB = (function () {

              // 列名タイプミスの提案（エラー経路のみで実行される）
              const __colSuggest = (cName, pts, dbs, als) => {
                  const dist = (a, b) => {
                      if (Math.abs(a.length - b.length) > 2) return 99;
                      const dp = [];
                      for (let j = 0; j <= b.length; j++) dp[j] = j;
                      for (let i = 1; i <= a.length; i++) {
                          let prev = dp[0]; dp[0] = i;
                          for (let j = 1; j <= b.length; j++) {
                              const t = dp[j];
                              dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
                              prev = t;
                          }
                      }
                      return dp[b.length];
                  };
                  let best = null, bestD = 3;
                  for (const alias in pts) {
                      const tbl = als[alias];
                      if (!tbl || !dbs[tbl] || !dbs[tbl].cols) continue;
                      for (const c in dbs[tbl].cols) {
                          const d = dist(cName, c);
                          if (d < bestD) { bestD = d; best = c; }
                      }
                  }
                  return best ? " Did you mean '" + best + "'?" : "";
              };
              const __resolve = (col, pts, dbs, als) => {
                  let tName, cName;
                  if (col.includes('.')) {
                      let parts = col.split('.');
                      tName = parts[0].toLowerCase(); cName = parts[1].toLowerCase();
                  } else {
                      cName = col.toLowerCase();
                      for (let alias in pts) {
                          let tbl = als[alias];
                          // HAVING等でダミーテーブルを使用する場合への対応
                          if (tbl && dbs[tbl] && dbs[tbl].cols && dbs[tbl].cols[cName]) {
                              tName = alias; break;
                          }
                      }
                  }
                  if (!tName) throw new Error("Column '" + col + "' not found." + __colSuggest(cName, pts, dbs, als));
                  let actualTbl = als[tName] || tName;
                  if (!dbs[actualTbl] || !dbs[actualTbl].cols[cName]) throw new Error("Column '" + col + "' not found." + __colSuggest(cName, pts, dbs, als));
                  let idx = pts[tName];
                  if (idx === undefined || idx === null || idx === -1) return null;
                  return dbs[actualTbl].getValue(cName, idx);
              };
              // 3値論理の NOT。UNKNOWN(null) の否定は UNKNOWN のまま。
              // `NOT LIKE` などで `!null === true` になると、値が NULL の行まで
              // 拾ってしまう（実DBは NULL 行を返さない）
              const __not3 = (v) => (v === null || v === undefined) ? null : !v;
              // SQL の 3 値論理。NULL は「不明」であって偽ではない
              //   偽が一つでもあれば AND は偽 / 真が一つでもあれば OR は真
              // 右辺は関数で受け取り、左辺だけで答が決まるときは評価しない
              // （相関サブクエリを右辺に置いた WHERE を無駄に実行しないため）
              const __b3 = (v) => (v === null || v === undefined) ? null : !!v;
              const __and3 = (a0, bf) => {
                  const a = __b3(a0);
                  if (a === false) return false;
                  const b = __b3(typeof bf === 'function' ? bf() : bf);
                  if (b === false) return false;
                  return (a === null || b === null) ? null : true;
              };
              const __or3 = (a0, bf) => {
                  const a = __b3(a0);
                  if (a === true) return true;
                  const b = __b3(typeof bf === 'function' ? bf() : bf);
                  if (b === true) return true;
                  return (a === null || b === null) ? null : false;
              };
              // 3値論理の比較。どちらかが NULL / undefined なら UNKNOWN(null)。
              // WHERE / ON / HAVING / CHECK はいずれも「真のときだけ通す」ので、
              // null が返れば自然に「その行は対象外」になる
              const __nul = (v) => v === null || v === undefined;
              // IN の 3 値論理: 左辺が NULL なら UNKNOWN。一致が無くてもリストに
              // NULL が含まれていれば UNKNOWN（NOT IN が真にならない＝実DBと同じ）
              // ある値と __eq が「等しい」と見なす候補値を並べる。
              // 生値をキーにした集合・索引を引くとき、寄せたぶんを取り落とさないために使う
              const __eq_probe_values = (v) => {
                  const out = [];
                  if (typeof v === 'number') {
                      out.push(String(v));
                      if (v === 0) out.push(false);
                      if (v === 1) out.push(true);
                  } else if (typeof v === 'boolean') {
                      out.push(v ? 1 : 0, v ? '1' : '0');
                  } else if (typeof v === 'string') {
                      const t = v.trim();
                      if (t !== '') {
                          const n = Number(t);
                          if (isFinite(n)) {
                              out.push(n);
                              if (n === 0) out.push(false);
                              if (n === 1) out.push(true);
                          }
                      }
                  }
                  return out;
              };
              const __in = (v, list) => {
                  if (v === null || v === undefined) return null;
                  // 長いリストは 1 度だけ集合へ起こして使い回す（副問い合わせの IN が効く）。
                  // 短いリストは線形のままにする — 集合を作る方が高くつく
                  if (Array.isArray(list) && list.length >= 32) {
                      let ix = LUMINA_IN_SETS.get(list);
                      if (ix === undefined) {
                          const set = new Set();
                          let hasNull = false;
                          for (const x of list) {
                              if (x === null || x === undefined) hasNull = true; else set.add(x);
                          }
                          ix = { set, hasNull };
                          LUMINA_IN_SETS.set(list, ix);
                      }
                      // Set は NaN を「同じ」と見るが、元の実装は `x === v` なので
                      // NaN はどの要素にも一致しなかった。そこだけ合わせる
                      if (typeof v === 'number' && Number.isNaN(v)) return ix.hasNull ? null : false;
                      if (ix.set.has(v)) return true;
                      return ix.hasNull ? null : false;
                  }
                  let sawNull = false;
                  for (const x of list) {
                      if (x === null || x === undefined) { sawNull = true; continue; }
                      if (x === v) return true;
                  }
                  return sawNull ? null : false;
              };
              // 算術の NULL 伝播。SQL では被演算子に NULL があれば結果は NULL
              const __num = (v) => (typeof v === 'number') ? v : Number(v);
              // 十進の値どうしの加減乗は、二進小数の誤差を持ち込まずに返す。
              //
              // SUM は桁をずらした整数で足すことで既に十進で合っていたが、式の中の
              // 演算は素の倍精度のままだった（`0.1 + 0.2` が 0.30000000000000004、
              // `price * 3` が 0.30000000000000004 のような値になる）。
              //
              // 十進で s1 桁と s2 桁の値なら、真の答えの桁数は加減で max(s1, s2)、
              // 乗で s1 + s2 に必ず収まる。倍精度の計算結果はその桁数へ丸めれば
              // 真の十進値へ戻る（誤差は最下位よりはるかに小さい）。
              // 桁が深い / 大きすぎて丸めが効かない場合は素の結果をそのまま返す
              const __dec_fix = (r, a, b, mul) => {
                  if (!isFinite(r)) return r;
                  const sa = LUMINA_DEC_PLACES(a), sb = LUMINA_DEC_PLACES(b);
                  if (sa < 0 || sb < 0) return r;
                  const sc = mul ? sa + sb : (sa > sb ? sa : sb);
                  if (sc === 0 || sc > 12) return r;             // 整数だけ / 深すぎる桁
                  // 桁をずらした値が正確な整数の範囲に収まらないと、丸めが逆に値を壊す。
                  // 例: 999999999999999.5 を 1 桁へ丸めようとすると 10 倍した
                  // 9999999999999995 が倍精度で表せず、999999999999999.6 になっていた
                  if (!(Math.abs(r) * Math.pow(10, sc) <= Number.MAX_SAFE_INTEGER)) return r;
                  return __round_scale(r, sc);
              };
              const __add = (a, b) => { if (__nul(a) || __nul(b)) return null; const x = __num(a), y = __num(b); return __dec_fix(x + y, x, y, false); };
              const __sub = (a, b) => { if (__nul(a) || __nul(b)) return null; const x = __num(a), y = __num(b); return __dec_fix(x - y, x, y, false); };
              const __mul = (a, b) => { if (__nul(a) || __nul(b)) return null; const x = __num(a), y = __num(b); return __dec_fix(x * y, x, y, true); };
              // 0 除算は MySQL 同様 NULL（例外にすると行評価の catch に飲まれて判らなくなる）
              const __divf = (a, b) => (__nul(a) || __nul(b) || __num(b) === 0) ? null : __num(a) / __num(b);
              const __modf = (a, b) => (__nul(a) || __nul(b) || __num(b) === 0) ? null : __num(a) % __num(b);
              const __neg = (a) => __nul(a) ? null : -__num(a);
              const __isnull = (v) => v === null || v === undefined;
              const __notnull = (v) => !(v === null || v === undefined);
              // 日付・日時の比較は「文字列としての並び」ではなく時刻で行う。
              // '2026-01-02'（DATE 列 / CAST(x AS DATE)）と '2026-01-02 00:00:00'
              // （DATETIME 列 / TIMESTAMP リテラル）は同じ瞬間を指すが、素の文字列比較では
              // 長さの違いで不一致になってしまう
              const __DATEISH = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
              const __dnum = (v) => {
                  if (v instanceof Date) return v.getTime();
                  if (typeof v === 'string' && __DATEISH.test(v)) {
                      const d = __date_parse(v);
                      return (d && !isNaN(d.getTime())) ? d.getTime() : NaN;
                  }
                  return NaN;
              };
              // 両辺が日付らしければ時刻へ寄せた組を返す。そうでなければ型の混在を揃える。
              //
              // `=` / `<>` は `===` / `!==` を使うため型が違うと必ず不一致になる一方、
              // `<` `<=` `>` `>=` は JS の関係演算子が暗黙変換するので、同じ 2 値に対して
              // 6 つの比較演算子が食い違っていた（`ok = 1` が 0 件なのに `ok > 0` は真、
              // `'10' = 10` が偽なのに `'10' >= 10` は真）。MySQL に合わせて数値へ寄せる。
              // 空文字は数値化しない（`'' = 0` は偽のまま）
              const __cpair = (a, b) => {
                  const x = __dnum(a), y = __dnum(b);
                  if (!isNaN(x) && !isNaN(y)) return [x, y];
                  if (typeof a === typeof b) return [a, b];
                  const numOf = (v) => {
                      if (typeof v === 'number') return v;
                      if (typeof v === 'boolean') return v ? 1 : 0;
                      if (typeof v === 'string') {
                          const t = v.trim();
                          if (t === '') return NaN;
                          const n = Number(t);
                          return isFinite(n) ? n : NaN;
                      }
                      return NaN;
                  };
                  const na = numOf(a), nb = numOf(b);
                  return (isNaN(na) || isNaN(nb)) ? [a, b] : [na, nb];
              };
              const __eq = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] === p[1]; };
              const __ne = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] !== p[1]; };
              const __lt = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] < p[1]; };
              const __le = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] <= p[1]; };
              const __gt = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] > p[1]; };
              const __ge = (a, b) => { if (__nul(a) || __nul(b)) return null; const p = __cpair(a, b); return p[0] >= p[1]; };
              const __like = (val, pattern, esc) => {
                 // LIKE パターン照合。esc 指定時（LIKE ... ESCAPE 'c'）はエスケープ文字の
                 // 直後の1文字（% _ エスケープ文字自身など）をリテラルとして扱う
                 // 値かパターンが NULL なら結果は UNKNOWN(null)。WHERE では偽として扱う
                 if (val === null || val === undefined || pattern == null) return null;
                 const p = String(pattern);
                 const e = esc != null ? String(esc) : null;
                 const quote = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                 let re = '^';
                 for (let i = 0; i < p.length; i++) {
                     const c = p[i];
                     if (e !== null && c === e && i + 1 < p.length) { re += quote(p[++i]); continue; }
                     if (c === '%') re += '.*';
                     else if (c === '_') re += '.';
                     else re += quote(c);
                 }
                 return new RegExp(re + '$', 'i').test(String(val));
              };
              // ILIKE (PostgreSQL): LIKE の大文字小文字非依存版。__like は元々 'i' フラグで
              // 照合するため実装を共用できるが、将来 LIKE を照合順依存にしても壊れないよう分離する
              // PostgreSQL の照合演算子。NULL が絡む比較は NULL のまま返す（3値論理）
              const __op_like  = (a, b) => (a == null || b == null) ? null : __like(a, b);
              const __op_nlike = (a, b) => { const r = __op_like(a, b); return r === null ? null : !r; };
              const __op_ilike = (a, b) => (a == null || b == null) ? null : __ilike(a, b);
              const __op_nilike = (a, b) => { const r = __op_ilike(a, b); return r === null ? null : !r; };
              const __op_regex = (a, b) => (a == null || b == null) ? null : __regexp_like(a, b);
              const __op_iregex = (a, b) => {
                  if (a == null || b == null) return null;
                  __regexp_guard(b);
                  try { return new RegExp(String(b), 'i').test(String(a)) ? 1 : 0; } catch (e) { return 0; }
              };
              const __op_nregex = (a, b) => { const r = __op_regex(a, b); return r === null ? null : !r; };
              const __op_niregex = (a, b) => { const r = __op_iregex(a, b); return r === null ? null : !r; };
              const __ilike = (val, pattern, esc) => {
                 // NULL は UNKNOWN(null)。__like と揃える（NOT ILIKE が NULL 行を拾わないように）
                 if (val === null || val === undefined || pattern == null) return null;
                 const p = String(pattern);
                 const e = esc != null ? String(esc) : null;
                 const quote = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                 let re = '^';
                 for (let i = 0; i < p.length; i++) {
                     const c = p[i];
                     if (e !== null && c === e && i + 1 < p.length) { re += quote(p[++i]); continue; }
                     if (c === '%') re += '.*';
                     else if (c === '_') re += '.';
                     else re += quote(c);
                 }
                 return new RegExp(re + '$', 'i').test(String(val));
              };
              // SIMILAR TO (SQL標準): LIKE のワイルドカード (% _) と正規表現のメタ文字
              // (| * + ? {} () []) を併用するパターン。全体一致で判定する。
              // '.' や '^' '$' はリテラル扱い（標準では正規表現メタ文字ではない）
              const __similar = (val, pattern) => {
                  if (val === null || val === undefined || pattern == null) return null;
                  const p = String(pattern);
                  if (p.length > 1000) throw new Error("SIMILAR TO pattern too long (max 1000 characters).");
                  let re = '', i = 0;
                  while (i < p.length) {
                      const c = p[i];
                      if (c === '\\' && i + 1 < p.length) { re += '\\' + p[++i]; i++; continue; }
                      if (c === '%') re += '[\\s\\S]*';
                      else if (c === '_') re += '[\\s\\S]';
                      else if ('|*+?{}()[]'.indexOf(c) !== -1) re += c;
                      else re += c.replace(/[.^$\\]/g, '\\$&');
                      i++;
                  }
                  try { return new RegExp('^(?:' + re + ')$').test(String(val)); }
                  catch (e) { throw new Error('Invalid SIMILAR TO pattern.'); }
              };
              // '||' 連結演算子（SQL標準 / PostgreSQL / Oracle）。標準どおり NULL は伝播する
              // （CONCAT() は NULL を空文字として扱うので挙動が異なる点に注意）
              const __concat_op = (...args) => {
                  for (const a of args) if (a === null || a === undefined) return null;
                  return args.map(String).join('');
              };
              const __upper = (val) => val != null ? String(val).toUpperCase() : null;
              const __lower = (val) => val != null ? String(val).toLowerCase() : null;
              // サロゲートペア（絵文字など BMP 外の文字）を含むか。
              // 含まない文字列（ASCII / 日本語などの BMP）は従来どおり符号単位の
              // 高速経路を通すので、性能は変わらない
              const __HAS_SURROGATE = /[\uD800-\uDBFF]/;
              const __length = (val) => val != null ? String(val).length : null;
              // CHAR_LENGTH / CHARACTER_LENGTH は「文字数」。符号単位で数えると
              // 絵文字 1 個が 2 と数えられていた（MySQL utf8mb4 は 1 と数える）
              const __char_length = (val) => {
                  if (val == null) return null;
                  const cs = String(val);
                  return __HAS_SURROGATE.test(cs) ? Array.from(cs).length : cs.length;
              };
              // ROUND(x [, d]): 精度指定付き・ゼロから遠い方向への丸め（MySQL互換。JSのMath.roundは負数で挙動が異なる）
              const __round = (val, d) => {
                  if (val == null) return null;
                  // 桁数が NULL なら結果も NULL。`Number(null) || 0` で 0 に潰していたため
                  // ROUND(2.567, NULL) が 3 を返していた（実DBはどれも NULL）
                  if (d === null) return null;
                  const f = Math.pow(10, Math.trunc(Number(d) || 0));
                  const n = Number(val);
                  return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
              };
              const __coalesce = (...args) => {
                  for(let i=0; i<args.length; i++) {
                      if(args[i] !== null && args[i] !== undefined) return args[i];
                  }
                  return null;
              };
              const __substring = (val, start, len) => {
                  if (val == null) return null;
                  let str = String(val);
                  // 位置・長さはコードポイントで数える（符号単位で切るとサロゲートペアが
                  // 半分に割れ、絵文字が単独のサロゲート＝文字化けとして出ていた）
                  const cps = __HAS_SURROGATE.test(str) ? Array.from(str) : null;
                  const total = cps ? cps.length : str.length;
                  // 開始位置は 1 始まり。負値は末尾から数える（MySQL / Oracle / SQLite 互換）。
                  // 従来は負値を 0 に丸めていたため `SUBSTRING('abcdef', -3)` が全文を返していた
                  let n = Math.trunc(Number(start));
                  if (!isFinite(n)) n = 1;
                  let s;
                  if (n > 0) s = n - 1;
                  else if (n < 0) s = Math.max(0, total + n);
                  else s = 0;   // 0 は 1 と同じ扱い
                  if (len !== undefined && len !== null) {
                      const L = Math.trunc(Number(len));
                      if (!isFinite(L) || L <= 0) return '';
                      return cps ? cps.slice(s, s + L).join('') : str.substr(s, L);
                  }
                  return cps ? cps.slice(s).join('') : str.substr(s);
              };
              const __concat = (...args) => args.map(a => a != null ? String(a) : '').join('');
              const __concat_ws = (sep, ...args) => sep == null ? null : args.filter(a => a !== null && a !== undefined).map(String).join(String(sep));
              const __substring_index = (str, delim, cnt) => {
                  if (str == null || delim == null || cnt == null) return null;
                  const s0 = String(str), d = String(delim), n = Math.trunc(Number(cnt));
                  if (d === '' || n === 0 || isNaN(n)) return '';
                  const parts = s0.split(d);
                  return n > 0 ? parts.slice(0, n).join(d) : parts.slice(Math.max(0, parts.length + n)).join(d);
              };
              const __locate = (sub, str, pos) => {
                  if (sub == null || str == null) return null;
                  const start = pos != null ? Math.max(0, Math.trunc(Number(pos)) - 1) : 0;
                  return String(str).indexOf(String(sub), start) + 1;
              };
              const __truncate = (v, digits) => {
                  if (v == null) return null;
                  if (digits === null) return null;   // ROUND と同じ理由（NULL 桁数は NULL）
                  const f = Math.pow(10, Math.trunc(Number(digits) || 0));
                  return Math.trunc(Number(v) * f) / f;
              };
              const __regexp = (val, pattern) => {
                  if (val === null || val === undefined || pattern == null) return null;
                  try { return new RegExp(pattern).test(String(val)); } catch(e) { return false; }
              };
              const __replace = (val, search, replace) => val != null ? String(val).split(search).join(replace) : null;
              const __trim = (val) => val != null ? String(val).trim() : null;
              const __abs = (val) => val != null ? Math.abs(Number(val)) : null;
              const __ceil = (val) => val != null ? Math.ceil(Number(val)) : null;
              const __floor = (val) => val != null ? Math.floor(Number(val)) : null;
              const __now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
              // LPAD / RPAD は「目的の長さちょうど」にする関数なので、元が長ければ切り詰める
              // （MySQL / PostgreSQL / Oracle いずれも切り詰める。padStart/padEnd だけでは
              //   長い文字列がそのまま返り、桁揃えが崩れていた）
              const __lpad = (str, len, pad) => {
                  if (str == null || len == null) return null;   // 長さが NULL なら NULL（'' ではない）
                  const n = Math.trunc(Number(len));
                  if (!isFinite(n) || n < 0) return null;
                  const s0 = String(str);
                  if (s0.length >= n) return s0.slice(0, n);
                  const p0 = pad != null ? String(pad) : ' ';
                  return p0 === '' ? s0 : s0.padStart(n, p0);
              };
              const __rpad = (str, len, pad) => {
                  if (str == null || len == null) return null;   // LPAD と同じ
                  const n = Math.trunc(Number(len));
                  if (!isFinite(n) || n < 0) return null;
                  const s0 = String(str);
                  if (s0.length >= n) return s0.slice(0, n);
                  const p0 = pad != null ? String(pad) : ' ';
                  return p0 === '' ? s0 : s0.padEnd(n, p0);
              };
              // 定義域の外（SQRT(-1) / ASIN(2) / MOD(x,0)）や桁あふれ（EXP(1000)）は
              // JS では NaN / Infinity になる。これをそのまま返すと JSON 上は null に見えるのに
              // IS NULL では捕まらず、COUNT には数えられて SUM には無視されるという
              // 食い違いが起きる。実DBはどれも NULL にするのでここで揃える
              const __fin = (v) => (typeof v === 'number' && !isFinite(v)) ? null : v;
              const __power = (base, exp) => (base != null && exp != null) ? __fin(Math.pow(Number(base), Number(exp))) : null;
              const __sqrt = (val) => val != null ? __fin(Math.sqrt(Number(val))) : null;

              const __date_parse = (val) => {
                  if (val == null) return null;
                  if (typeof val === 'string') {
                      // 時刻だけの値 'HH:MM[:SS[.mmm]]'（TIME 列 / SEC_TO_TIME の出力）。
                      // new Date('12:34:56') は Invalid Date なので、以前は
                      // HOUR/MINUTE/SECOND/EXTRACT がすべて NULL を返していた
                      // （TIME は列型として受理され TIME_TO_SEC も解釈できるのに、
                      //   自分が作った TIME 値を自分で読めない状態だった）。
                      // 1970-01-01 を土台に UTC で組む＝タイムゾーンに依らない
                      const tm = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(val.trim());
                      if (tm) {
                          const d0 = new Date(Date.UTC(1970, 0, 1, +tm[1], +tm[2], +(tm[3] || 0), +((tm[4] || '0') + '00').slice(0, 3)));
                          // YEAR/MONTH/DAY は時刻値に対して NULL を返すべきなので目印を付ける
                          d0.__timeOnly = true;
                          return d0;
                      }
                      let s = val.replace(' ', 'T');
                      if (s.indexOf('T') !== -1 && !s.endsWith('Z')) s += 'Z';
                      let d = new Date(s);
                      if (!isNaN(d.getTime())) return d;
                  }
                  return new Date(val);
              };
              // 時刻のみの値に対する日付フィールドは NULL（MySQL と同じ）
              const __dateFieldOf = (val, get) => {
                  if (val == null) return null;
                  const d = __date_parse(val);
                  if (!d || isNaN(d.getTime()) || d.__timeOnly) return null;
                  return get(d);
              };
              const __year = (val) => __dateFieldOf(val, d => d.getUTCFullYear());
              const __month = (val) => __dateFieldOf(val, d => d.getUTCMonth() + 1);
              const __day = (val) => __dateFieldOf(val, d => d.getUTCDate());
              const __hour = (val) => val != null ? __date_parse(val).getUTCHours() : null;
              const __minute = (val) => val != null ? __date_parse(val).getUTCMinutes() : null;
              const __second = (val) => val != null ? __date_parse(val).getUTCSeconds() : null;
              const __datediff = (a, b, c) => {
                  // 3引数: SQL Server 形式 DATEDIFF(datepart, start, end) = end - start（単位差）
                  if (c !== undefined) return __timestampdiff(__normDatePart(a), b, c);
                  // 2引数: MySQL 形式 DATEDIFF(end, start) = 日数差
                  return (a != null && b != null) ? Math.round((__date_parse(a).getTime() - __date_parse(b).getTime()) / 86400000) : null;
              };
              // DATE_ADD / DATE_SUB: 数値（日数）と INTERVAL n unit の両方を受け付ける。
              // 月・年の加算は月末を丸める（1/31 + 1 MONTH = 2/28|29）
              const __interval = (n, unit) => ({ __interval: Math.trunc(Number(n)), unit });
              const __add_interval = (v, n, sign) => {
                  if (v == null || n == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  let r;
                  if (typeof n === 'object' && n.__interval !== undefined) {
                      const k = sign * n.__interval;
                      const u = n.unit;
                      if (u === 'YEAR' || u === 'QUARTER' || u === 'MONTH') {
                          const mo = u === 'YEAR' ? k * 12 : (u === 'QUARTER' ? k * 3 : k);
                          r = new Date(d.getTime());
                          const day = r.getUTCDate();
                          r.setUTCDate(1);
                          r.setUTCMonth(r.getUTCMonth() + mo);
                          const dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
                          r.setUTCDate(Math.min(day, dim));
                      } else {
                          const msPer = u === 'WEEK' ? 604800000 : u === 'DAY' ? 86400000 : u === 'HOUR' ? 3600000 : u === 'MINUTE' ? 60000 : 1000;
                          r = new Date(d.getTime() + k * msPer);
                      }
                  } else {
                      r = new Date(d.getTime() + sign * Math.trunc(Number(n)) * 86400000);
                  }
                  return isNaN(r.getTime()) ? null : r.toISOString().replace('T', ' ').slice(0, 19);
              };
              const __date_add = (v, n) => __add_interval(v, n, 1);
              // 日付型の列への参照に付く目印。値はそのまま返し、'+'/'-' の
              // 書き換え（_rewriteDateArith）がコンパイル時に日付だと判るようにするだけ
              const __datecol = (v) => v;
              const __date_sub = (v, n) => __add_interval(v, n, -1);
              // (s1, e1) OVERLAPS (s2, e2): 期間の重なり判定（SQL標準。端点は半開区間で扱う）
              const __overlaps = (a1, a2, b1, b2) => {
                  const t = (v) => { if (v == null) return null; const d = __date_parse(v); return isNaN(d.getTime()) ? null : d.getTime(); };
                  let s1 = t(a1), e1 = t(a2), s2 = t(b1), e2 = t(b2);
                  if (s1 === null || s2 === null) return null;
                  if (e1 === null) e1 = s1;
                  if (e2 === null) e2 = s2;
                  if (s1 > e1) { const x = s1; s1 = e1; e1 = x; }
                  if (s2 > e2) { const x = s2; s2 = e2; e2 = x; }
                  // 退化した期間（1 点）はその点を含むかどうかで判定する
                  if (s1 === e1 && s2 === e2) return s1 === s2;
                  if (s1 === e1) return s1 >= s2 && s1 < e2;
                  if (s2 === e2) return s2 >= s1 && s2 < e1;
                  return s1 < e2 && s2 < e1;
              };
              // DATE_BIN / TIME_BUCKET: 時刻を一定幅の区間へ丸める（時系列の集計単位づくり）
              const __date_bin = (iv, v, origin) => {
                  if (v == null || iv == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  const unit = (typeof iv === 'object' && iv.unit) ? iv.unit : null;
                  const n = (typeof iv === 'object' && iv.__interval !== undefined) ? iv.__interval : Number(iv);
                  if (!n || !isFinite(n) || n <= 0) throw new Error('DATE_BIN requires a positive interval.');
                  // 月・年は日数が一定でないのでカレンダー単位で丸める
                  if (unit === 'MONTH' || unit === 'QUARTER' || unit === 'YEAR') {
                      const per = unit === 'YEAR' ? n * 12 : (unit === 'QUARTER' ? n * 3 : n);
                      const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
                      const binned = Math.floor(months / per) * per;
                      const out = new Date(Date.UTC(Math.floor(binned / 12), binned % 12, 1));
                      return out.toISOString().replace('T', ' ').slice(0, 19);
                  }
                  const MS = { WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000 };
                  const w = (MS[unit] || MS.SECOND) * n;
                  const org = origin != null ? __date_parse(origin) : null;
                  const base = (org && !isNaN(org.getTime())) ? org.getTime() : 0;
                  const t0 = base + Math.floor((d.getTime() - base) / w) * w;
                  return new Date(t0).toISOString().replace('T', ' ').slice(0, 19);
              };
              // AGE(a, b): 2 つの日時の差を 'Y years M mons D days' 形式で返す（PostgreSQL）
              const __age = (a, b) => {
                  if (a == null) return null;
                  // 1 引数形 AGE(x) は PostgreSQL では current_date - x（過去日なら正）。
                  // 従来は x - now として計算していたため符号が逆になっていた
                  const d1 = b == null ? new Date() : __date_parse(a);
                  const d2 = b == null ? __date_parse(a) : __date_parse(b);
                  if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
                  let hi = d1, lo = d2, sign = '';
                  if (d1.getTime() < d2.getTime()) { hi = d2; lo = d1; sign = '-'; }
                  let y = hi.getUTCFullYear() - lo.getUTCFullYear();
                  let mo = hi.getUTCMonth() - lo.getUTCMonth();
                  let dd = hi.getUTCDate() - lo.getUTCDate();
                  if (dd < 0) { mo--; dd += new Date(Date.UTC(hi.getUTCFullYear(), hi.getUTCMonth(), 0)).getUTCDate(); }
                  if (mo < 0) { y--; mo += 12; }
                  const parts = [];
                  if (y) parts.push(y + ' year' + (y === 1 ? '' : 's'));
                  if (mo) parts.push(mo + ' mon' + (mo === 1 ? '' : 's'));
                  parts.push(dd + ' day' + (dd === 1 ? '' : 's'));
                  return sign + parts.join(' ');
              };
              // --- 配列（PostgreSQL 風）。式レベルの値として扱い、列へ格納するときは
              //     ARRAY_TO_STRING / JSON_ARRAY で文字列化する ---
              const __array = (...items) => items.map(v => v === undefined ? null : v);
              const __toArray = (v) => {
                  if (v === null || v === undefined) return null;
                  if (Array.isArray(v)) return v;
                  // JSON 配列の文字列も受け付ける（JSON 列との相互運用のため）
                  if (typeof v === 'string') {
                      const t = v.trim();
                      if (t[0] === '[') { try { const p = JSON.parse(t); if (Array.isArray(p)) return p; } catch (e) { /* 通常の文字列 */ } }
                  }
                  return [v];
              };
              const __array_length = (a) => { const x = __toArray(a); return x === null ? null : x.length; };
              const __array_position = (a, v) => {
                  const x = __toArray(a);
                  if (x === null) return null;
                  const i = x.findIndex(e => e === v);
                  return i === -1 ? null : i + 1;   // SQL の配列は 1 始まり
              };
              const __array_contains = (a, v) => { const x = __toArray(a); return x === null ? null : x.some(e => e === v); };
              // a[n]: 配列・JSON 配列は 1 始まりの要素、文字列は 1 始まりの 1 文字、
              // オブジェクト（JSON）は添字をキーとして引く。範囲外は NULL
              const __subscript = (a, i) => {
                  if (a === null || a === undefined || i === null || i === undefined) return null;
                  if (typeof a === 'object' && !Array.isArray(a)) return a[i] === undefined ? null : a[i];
                  if (typeof a === 'string') {
                      const t = a.trim();
                      if (t[0] === '{' ) { try { const p = JSON.parse(t); if (p && typeof p === 'object' && !Array.isArray(p)) return p[i] === undefined ? null : p[i]; } catch (e) { /* 通常の文字列 */ } }
                      if (t[0] !== '[') { const n = Number(i); return (n >= 1 && n <= a.length) ? a[n - 1] : null; }
                  }
                  const x = __toArray(a);
                  const n = Number(i);
                  if (x === null || !Number.isFinite(n)) return null;
                  return (n >= 1 && n <= x.length) ? x[n - 1] : null;
              };
              // a[lo:hi]: 1 始まり・両端を含む。境界の省略は先頭 / 末尾を意味する
              const __array_slice = (a, lo, hi) => {
                  if (a === null || a === undefined) return null;
                  const isStr = typeof a === 'string' && a.trim()[0] !== '[';
                  const x = isStr ? a : __toArray(a);
                  if (x === null) return null;
                  const from = (lo === null || lo === undefined) ? 1 : Number(lo);
                  const to = (hi === null || hi === undefined) ? x.length : Number(hi);
                  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
                  return x.slice(Math.max(0, from - 1), Math.max(0, to));
              };
              const __array_append = (a, v) => { const x = __toArray(a); return x === null ? [v] : x.concat([v]); };
              const __array_prepend = (v, a) => { const x = __toArray(a); return x === null ? [v] : [v].concat(x); };
              const __array_remove = (a, v) => { const x = __toArray(a); return x === null ? null : x.filter(e => e !== v); };
              const __array_to_string = (a, sep, nullStr) => {
                  const x = __toArray(a);
                  if (x === null || sep == null) return null;
                  return x.filter(e => e !== null && e !== undefined ? true : nullStr != null)
                          .map(e => (e === null || e === undefined) ? String(nullStr) : String(e))
                          .join(String(sep));
              };
              const __string_to_array = (s0, sep) => {
                  if (s0 == null || sep == null) return null;
                  return String(sep) === '' ? [...String(s0)] : String(s0).split(String(sep));
              };
              const __array_agg_sort = (a) => { const x = __toArray(a); return x === null ? null : x.slice().sort(); };

              // --- あいまい文字列照合（検索・名寄せ用） ---
              const __levenshtein = (a, b) => {
                  if (a == null || b == null) return null;
                  const s1 = String(a), s2 = String(b);
                  if (s1.length > 2000 || s2.length > 2000) throw new Error('LEVENSHTEIN inputs are limited to 2000 characters.');
                  const m = s1.length, n = s2.length;
                  if (m === 0) return n;
                  if (n === 0) return m;
                  let prev = new Array(n + 1);
                  for (let j = 0; j <= n; j++) prev[j] = j;
                  for (let i = 1; i <= m; i++) {
                      let cur = [i];
                      for (let j = 1; j <= n; j++) {
                          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1));
                      }
                      prev = cur;
                  }
                  return prev[n];
              };
              // 0〜1 の類似度（編集距離を長さで正規化）
              const __similarity = (a, b) => {
                  if (a == null || b == null) return null;
                  const s1 = String(a), s2 = String(b);
                  const len = Math.max(s1.length, s2.length);
                  if (len === 0) return 1;
                  return Number((1 - __levenshtein(s1, s2) / len).toFixed(6));
              };
              // SOUNDEX 同士の一致文字数（0〜4）。SQL Server / PostgreSQL の DIFFERENCE
              const __difference = (a, b) => {
                  if (a == null || b == null) return null;
                  const x = __soundex(a), y = __soundex(b);
                  if (x == null || y == null) return null;
                  let n = 0;
                  for (let i = 0; i < 4; i++) if (x[i] === y[i]) n++;
                  return n;
              };

              // --- 正規表現の追加 ---
              const __regexp_matches = (s0, pat, flags) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try {
                      const g = String(flags || '').indexOf('g') !== -1;
                      const re = new RegExp(String(pat), g ? 'g' : '');
                      if (!g) { const m = String(s0).match(re); return m ? m.slice(0) : null; }
                      return String(s0).match(re) || null;
                  } catch (e) { return null; }
              };
              const __regexp_split_to_array = (s0, pat) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try { return String(s0).split(new RegExp(String(pat))); } catch (e) { return null; }
              };

              // --- 数値の追加 ---
              const __div = (a, b) => (a == null || b == null) ? null : (Number(b) === 0 ? null : Math.trunc(Number(a) / Number(b)));
              const __safe_divide = (a, b) => (a == null || b == null || Number(b) === 0) ? null : Number(a) / Number(b);

              // --- AT TIME ZONE: UTC 基準の時刻をオフセット付きで読み替える ---
              // ブラウザは IANA タイムゾーン DB を持つが、ここでは 'UTC' / '+09:00' 形式と
              // 主要な別名だけを扱う（実行環境差で結果がぶれないようにするため）
              const __TZ_OFFSETS = { UTC: 0, GMT: 0, Z: 0, JST: 540, KST: 540, IST: 330, CET: 60, EET: 120, EST: -300, CST: -360, MST: -420, PST: -480 };
              // IANA 名（'Asia/Tokyo'）は Intl から引く。'JST' のような略称は上の固定表を
              // 使い続ける（略称は地域によって指す時刻が違うので、固定値のままにする）。
              //
              // 夏時間があるので、オフセットは「その瞬間」に対して求めなければならない。
              // 固定値を持つと 'America/New_York' が年間ずっと -5 時間になり、夏の
              // 時刻が 1 時間ずれる。DateTimeFormat は生成が重いので名前ごとに使い回す
              const __tzFmtCache = Object.create(null);
              const __tz_fmt = (name) => {
                  if (name in __tzFmtCache) return __tzFmtCache[name];
                  let f = null;
                  try {
                      f = new Intl.DateTimeFormat('en-US', {
                          timeZone: name, hour12: false,
                          year: 'numeric', month: '2-digit', day: '2-digit',
                          hour: '2-digit', minute: '2-digit', second: '2-digit'
                      });
                  } catch (e) { f = null; }        // 未知の地名は null を覚えて二度試さない
                  __tzFmtCache[name] = f;
                  return f;
              };
              const __tz_iana_minutes = (name, atMs) => {
                  const f = __tz_fmt(name);
                  if (!f) return null;
                  const p = Object.create(null);
                  for (const part of f.formatToParts(new Date(atMs))) p[part.type] = part.value;
                  if (!p.year || !p.hour) return null;
                  // その地域の壁時計を UTC として読み直し、実際の瞬間との差を取る
                  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                                        Number(p.hour) % 24, Number(p.minute), Number(p.second));
                  return Math.round((wall - atMs) / 60000);
              };
              // タイムゾーン名 → UTC からの分。AT TIME ZONE と CONVERT_TZ で共有する。
              // atMs はオフセットを求める瞬間（夏時間の判定に使う）
              const __tz_minutes = (tz, atMs) => {
                  const raw = String(tz).trim();
                  const name = raw.toUpperCase();
                  const om = name.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
                  if (om) return (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
                  if (Object.prototype.hasOwnProperty.call(__TZ_OFFSETS, name)) return __TZ_OFFSETS[name];
                  const at = (atMs === undefined || atMs === null || isNaN(atMs)) ? Date.now() : atMs;
                  const ia = __tz_iana_minutes(raw, at);
                  if (ia !== null) return ia;
                  throw new Error(`Unknown time zone '${tz}'. Use an IANA name like 'Asia/Tokyo', 'UTC', '+09:00' or a common abbreviation.`);
              };
              const __at_time_zone = (v, tz) => {
                  if (v == null || tz == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  return new Date(d.getTime() + __tz_minutes(tz, d.getTime()) * 60000).toISOString().replace('T', ' ').slice(0, 19);
              };
              // CONVERT_TZ(ts, from, to): MySQL。from の壁時計を to の壁時計へ読み替える
              const __convert_tz = (v, from, to) => {
                  if (v == null || from == null || to == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  const diff = __tz_minutes(to, d.getTime()) - __tz_minutes(from, d.getTime());
                  return new Date(d.getTime() + diff * 60000).toISOString().replace('T', ' ').slice(0, 19);
              };

              // IS JSON 述語 / JSON_EXISTS / JSON_QUERY（SQL:2016 の JSON 述語群）
              const __is_json = (v, kind) => {
                  if (v == null) return null;
                  let parsed;
                  try { parsed = JSON.parse(String(v)); } catch (e) { return false; }
                  const k = String(kind || 'VALUE').toUpperCase();
                  if (k === 'OBJECT') return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
                  if (k === 'ARRAY') return Array.isArray(parsed);
                  if (k === 'SCALAR') return parsed === null || typeof parsed !== 'object';
                  return true;
              };
              const __json_exists = (v, path) => {
                  const r = __json_get(v, path);
                  return r !== undefined;
              };
              const __json_query = (v, path) => {
                  const r = __json_get(v, path);
                  if (r === undefined || r === null) return null;
                  // JSON_QUERY はオブジェクト/配列だけを返す（スカラーは NULL）
                  return typeof r === 'object' ? JSON.stringify(r) : null;
              };
              // 照合順の指定 (expr COLLATE name)。比較・並べ替え用に正規化した値を返す。
              //   NOCASE / CI      : 大文字小文字を無視
              //   BINARY / CS      : 既定（変換なし）
              //   NOACCENT / AI    : 濁点・アクセントを除去（NFD 分解して結合文字を落とす）
              //   NUMERIC / NATURAL: 数値部分を桁揃えして「自然順」で比較できるようにする
              const __collate = (v, name) => {
                  if (v === null || v === undefined) return null;
                  const c = String(name || '').toUpperCase();
                  let s = String(v);
                  if (c === 'BINARY' || c === 'CS') return s;
                  if (c === 'NOACCENT' || c === 'AI') return s.normalize('NFD').replace(/[\u0300-\u036f\u3099-\u309c]/g, '');
                  if (c === 'NUMERIC' || c === 'NATURAL') {
                      return s.replace(/\d+/g, (d) => d.padStart(20, '0'));
                  }
                  if (c === 'NOCASE' || c === 'CI' || c === '') return s.toLowerCase();
                  throw new Error(`Unknown collation '${name}'. Use NOCASE / BINARY / NOACCENT / NUMERIC.`);
              };
              // 全文検索 MATCH(cols) AGAINST(query [IN BOOLEAN MODE])。
              // 語単位（英数字と CJK は文字単位）に分解し、真偽値または簡易スコアを返す。
              // ブール記法: +必須 / -除外 / "句" / 語末 *（前方一致）
              const __ft_tokens = LUMINA_FT_TOKENS;
              const __match_against = (haystack, query, mode) => {
                  const text = ' ' + __ft_tokens(haystack).join(' ') + ' ';
                  const parsed = LUMINA_FT_PARSE(query, mode);
                  const boolean = parsed.boolean;
                  const terms = parsed.terms;
                  if (terms.length === 0) return 0;
                  let hits = 0;
                  for (const t of terms) {
                      const pat = t.phrase + (t.prefix ? '' : ' ');
                      const found = text.indexOf(pat) !== -1;
                      if (t.sign === '-') { if (found) return 0; continue; }
                      if (t.sign === '+') { if (!found) return 0; }
                      if (found) hits++;
                  }
                  const wanted = terms.filter(t => t.sign !== '-').length;
                  if (wanted === 0) return 1;
                  // ブールモードは +/- を満たせば一致、自然文モードは 1 語でも一致すればスコアを返す
                  return boolean ? (hits > 0 || terms.every(t => t.sign === '+') ? Math.max(hits, 1) : 0) : hits;
              };
              const __curdate = () => new Date().toISOString().slice(0, 10);
              const __dayofweek = (v) => v != null ? __date_parse(v).getUTCDay() + 1 : null;
              const __dayofyear = (v) => { if (v == null) return null; const d = __date_parse(v); return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000); };
              const __quarter = (v) => v != null ? Math.floor(__date_parse(v).getUTCMonth() / 3) + 1 : null;
              const __last_day = (v) => { if (v == null) return null; const d = __date_parse(v); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); return e.toISOString().slice(0, 10); };

              // LTRIM/RTRIM は第2引数で「取り除く文字の集合」を受け取る（Oracle / PostgreSQL）。
              // 従来は第2引数が黙って捨てられ、空白しか落とさずに誤った文字列を返していた
              const __trim_set = (s0, chars, left, right) => {
                  const set = new Set(String(chars));
                  let a = 0, b = s0.length;
                  if (left) while (a < b && set.has(s0[a])) a++;
                  if (right) while (b > a && set.has(s0[b - 1])) b--;
                  return s0.slice(a, b);
              };
              const __ltrim = (v, chars) => v == null ? null
                  : (chars == null ? String(v).replace(/^\s+/, '') : __trim_set(String(v), chars, true, false));
              const __rtrim = (v, chars) => v == null ? null
                  : (chars == null ? String(v).replace(/\s+$/, '') : __trim_set(String(v), chars, false, true));
              const __ascii = (v) => v != null ? (String(v).length > 0 ? String(v).charCodeAt(0) : 0) : null;
              const __char = (...vs) => (vs.length === 0 || vs.some(v => v == null)) ? null : vs.map(v => String.fromCharCode(Math.trunc(Number(v)))).join('');
              const __sin = (v) => v != null ? Math.sin(Number(v)) : null;
              const __cos = (v) => v != null ? Math.cos(Number(v)) : null;
              const __tan = (v) => v != null ? __fin(Math.tan(Number(v))) : null;
              const __sinh = (v) => v != null ? __fin(Math.sinh(Number(v))) : null;
              const __asin = (v) => v != null ? __fin(Math.asin(Number(v))) : null;
              const __acos = (v) => v != null ? __fin(Math.acos(Number(v))) : null;
              const __atan = (v) => v != null ? Math.atan(Number(v)) : null;
              const __atan2 = (y, x) => (y != null && x != null) ? Math.atan2(Number(y), Number(x)) : null;
              const __degrees = (v) => v != null ? Number(v) * 180 / Math.PI : null;
              const __radians = (v) => v != null ? Number(v) * Math.PI / 180 : null;
              const __ln = (v) => (v != null && Number(v) > 0) ? Math.log(Number(v)) : null;
              const __cbrt = (v) => v != null ? Math.cbrt(Number(v)) : null;

              const __ifnull = (a, b) => (a === null || a === undefined) ? b : a;
              const __nullif = (a, b) => (a === b) ? null : a;
              // IS DISTINCT FROM: NULL を値として扱う比較（両方 NULL は「差がない」）
              const __is_distinct = (a, b) => {
                  const an = (a === null || a === undefined), bn = (b === null || b === undefined);
                  if (an && bn) return false;
                  if (an !== bn) return true;
                  return a !== b;
              };
              const __if = (c, a, b) => c ? a : b;
              // LEFT / RIGHT もコードポイント単位で切る（符号単位で切ると
              // サロゲートペアが半分に割れて文字化けする）
              const __left = (s, n) => {
                  if (s == null || n == null) return null;   // 長さが NULL なら NULL（'' ではない）
                  const str = String(s), k = Math.max(0, Number(n));
                  return __HAS_SURROGATE.test(str) ? Array.from(str).slice(0, k).join('') : str.slice(0, k);
              };
              const __right = (s, n) => {
                  if (s == null || n == null) return null;   // LEFT と同じ
                  const str = String(s); const k = Math.max(0, Number(n));
                  if (k === 0) return '';
                  return __HAS_SURROGATE.test(str) ? Array.from(str).slice(-k).join('') : str.slice(-k);
              };
              const __instr = (s, sub) => (s != null && sub != null) ? String(s).indexOf(String(sub)) + 1 : null;
              // split('') は符号単位で割るのでサロゲートペアが壊れる（絵文字が文字化けする）。
              // Array.from はコードポイント単位
              const __reverse = (s) => s != null ? Array.from(String(s)).reverse().join('') : null;
              const __repeat = (s, n) => (s != null && n != null && Number(n) >= 0) ? String(s).repeat(Math.floor(Number(n))) : null;
              const __greatest = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y > x ? y : x);
              const __least = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y < x ? y : x);
              const __exp = (v) => v != null ? __fin(Math.exp(Number(v))) : null;
              const __log = (a, b) => {
                  // 1引数: 自然対数 LOG(x)（MySQL） / 2引数: 指定底の対数 LOG(base, x)（Oracle/MySQL/PG）
                  if (b === undefined) return (a != null && Number(a) > 0) ? Math.log(Number(a)) : null;
                  if (a == null || b == null || Number(a) <= 0 || Number(a) === 1 || Number(b) <= 0) return null;
                  return Math.log(Number(b)) / Math.log(Number(a));
              };
              const __log10 = (v) => (v != null && Number(v) > 0) ? Math.log10(Number(v)) : null;
              const __pi = () => Math.PI;

              // 指定位取りへゼロから遠い方向で丸める。10^sc の乗算は 1.005*100 が
              // 100.49999... になる（1.005 が二進で表せない）ため、指数表記の文字列を
              // 経由して小数点を移す — こうすると "1.005e2" が正確に 100.5 へパースされ、
              // MySQL の DECIMAL 丸めと一致する。指数表記の値だけ乗算へ退避する
              const __round_scale = (n, sc) => {
                  const str = String(n);
                  if (str.indexOf('e') !== -1 || str.indexOf('E') !== -1) {
                      const f = Math.pow(10, sc);
                      return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
                  }
                  const shifted = Number(str + 'e' + sc);
                  if (!isFinite(shifted)) return n;
                  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
                  const back = Number(rounded + 'e' + (-sc));
                  return isFinite(back) ? back : n;
              };

              // 型名は正規化済みの正準名（INTEGER/FLOAT/DECIMAL/TEXT/BOOLEAN/DATE/TIME）で渡され、
              // p/s は DECIMAL(p,s) や VARCHAR(n) の桁指定（未指定なら null）。
              // 正規化と別名解決はコンパイル時（_normalizeCastType）に済んでいるため、
              // 行評価ごとの型名パースは発生しない
              const __cast = (v, t, p, s) => {
                  if (v === null || v === undefined) return null;
                  if (t === 'INTEGER') {
                      const n = Math.trunc(Number(v));
                      if (isNaN(n)) return null;
                      // 2^53 を超える整数は float64 で表しきれないので、丸めた値を返さず
                      // NULL にする。CAST('9223372036854775807' AS BIGINT) は
                      // 9223372036854776000 という「入力に無い数」を返していた。
                      // 変換不能を NULL で表すのは下の DECIMAL / BOOLEAN 分岐と同じ規約
                      // （式評価中の throw は行単位の catch に飲まれて結局 NULL になる）
                      if (!Number.isSafeInteger(n)) return null;
                      return n;
                  }
                  if (t === 'FLOAT') { const n = Number(v); return isNaN(n) ? null : n; }
                  if (t === 'DECIMAL') {
                      const n = Number(v);
                      if (isNaN(n)) return null;
                      // 位取り指定があればそこへ丸める（MySQL 同様ゼロから遠い方向）。
                      // 桁数のみなら位取り 0、どちらも無ければ値をそのまま通す
                      if (p == null) return n;
                      const sc = s == null ? 0 : s;
                      const r = __round_scale(n, sc);
                      // 整数部が精度に収まらない場合は NULL（式評価中の throw は行単位の
                      // catch に飲まれて結局 NULL になるため、最初から NULL で一貫させる。
                      // 変換不能を NULL で表すのは他の __cast 分岐と同じ規約）
                      if (Math.abs(r) >= Math.pow(10, p - sc)) return null;
                      return r;
                  }
                  if (t === 'TEXT') {
                      const sv = String(v);
                      // CHAR(n)/VARCHAR(n) は長さ超過分を切り捨てる（MySQL の CAST と同じ挙動）
                      return (p == null || sv.length <= p) ? sv : sv.slice(0, p);
                  }
                  if (t === 'BOOLEAN') {
                      if (typeof v === 'boolean') return v;
                      if (v === 1 || v === 0) return v === 1;
                      const sv = String(v).toLowerCase();
                      if (sv === 'true' || sv === '1') return true;
                      if (sv === 'false' || sv === '0') return false;
                      return null;
                  }
                  if (t === 'DATE') {
                      // __date_parse を使う（素の new Date は 'YYYY-MM-DD HH:MM:SS' をローカル時刻として
                      // 解釈するため、直後の toISOString でタイムゾーン分ずれる）
                      const d = v instanceof Date ? v : __date_parse(v);
                      return (!d || isNaN(d.getTime())) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
                  }
                  if (t === 'DATEONLY') {
                      // CAST(x AS DATE) は時刻を切り捨てる（DATETIME / TIMESTAMP は残す）
                      const d = v instanceof Date ? v : __date_parse(v);
                      return (!d || isNaN(d.getTime())) ? null : d.toISOString().slice(0, 10);
                  }
                  if (t === 'TIME') {
                      const d = v instanceof Date ? v : __date_parse(v);
                      if (d && !isNaN(d.getTime())) return d.toISOString().slice(11, 19);
                      // 'HH:MM[:SS]' 単体の文字列も受ける
                      const tm = String(v).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
                      if (!tm) return null;
                      return `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}`;
                  }
                  return v;
              };
              const __mod = (a, b) => (a != null && b != null) ? __fin(Number(a) % Number(b)) : null;
              const __sign = (val) => val != null ? Math.sign(Number(val)) : null;
              // RAND()/RANDOM() は既定で Math.random。SETSEED(x) を呼ぶと決定的な
              // Lehmer 生成器（MINSTD）へ切り替わり、同じ種から同じ系列を再現できる
              // （テストデータ生成やスナップショット比較のため）。SETSEED(NULL) で解除。
              let __seedState = null;
              const __setseed = (v) => {
                  if (v === null || v === undefined) { __seedState = null; return 0; }
                  const n = Number(v);
                  if (!isFinite(n)) throw new Error('SETSEED requires a finite number.');
                  __seedState = (Math.abs(Math.trunc(n * 2147483646)) % 2147483646) + 1;
                  return __seedState;
              };
              const __rand = () => {
                  if (__seedState === null) return Math.random();
                  __seedState = (__seedState * 48271) % 2147483647;
                  return (__seedState - 1) / 2147483646;
              };
              // DATE(x) は「日付部分だけを取り出す」関数（MySQL）。
              // 以前は new Date(val) をそのまま返していたため、(1) 時刻が切り落とされず、
              // (2) 'YYYY-MM-DD HH:MM:SS' がローカル時刻として解釈されて JST では
              // 9 時間ずれ、`GROUP BY DATE(ts)` の日付境界が 1 日手前へ寄っていた。
              // __date_parse は 'Z' を補うのでタイムゾーンに依らない
              const __date = (val) => {
                  if (val == null) return null;
                  const d = __date_parse(val);
                  return (d && !isNaN(d.getTime())) ? d.toISOString().slice(0, 10) : null;
              };

              // --- v1.1 追加関数群: 数値 / 文字列 ---
              const __log2 = (v) => (v != null && Number(v) > 0) ? Math.log2(Number(v)) : null;
              const __cot = (v) => v != null ? __fin(1 / Math.tan(Number(v))) : null;
              const __format = (n, d) => {
                  if (n == null) return null;
                  const dd = Math.max(0, Math.trunc(Number(d) || 0));
                  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dd, maximumFractionDigits: dd });
              };
              const __hex = (v) => {
                  if (v == null) return null;
                  if (typeof v === 'number') return (v < 0 ? BigInt.asUintN(64, BigInt(Math.trunc(v))).toString(16) : Math.trunc(v).toString(16)).toUpperCase();
                  // 文字列は UTF-8 バイト列を 16 進化する（MySQL 互換）。
                  // 従来は UTF-16 コードポイントを 2 桁で書いていたため、非 ASCII が
                  // 1 バイトに潰れて UNHEX(HEX(x)) が元へ戻らなかった
                  let out = '';
                  for (const b of __utf8_bytes(String(v))) out += b.toString(16).toUpperCase().padStart(2, '0');
                  return out;
              };
              const __bin = (v) => {
                  if (v == null) return null;
                  const n = Math.trunc(Number(v));
                  if (isNaN(n)) return null;
                  return n < 0 ? BigInt.asUintN(64, BigInt(n)).toString(2) : n.toString(2);
              };
              const __oct = (v) => {
                  if (v == null) return null;
                  const n = Math.trunc(Number(v));
                  if (isNaN(n)) return null;
                  return n < 0 ? BigInt.asUintN(64, BigInt(n)).toString(8) : n.toString(8);
              };
              const __conv = (n, from, to) => {
                  if (n == null || from == null || to == null) return null;
                  const v = parseInt(String(n), Math.trunc(Number(from)));
                  if (isNaN(v)) return null;
                  return v.toString(Math.trunc(Number(to))).toUpperCase();
              };
              const __space = (n) => n != null ? ' '.repeat(Math.max(0, Math.trunc(Number(n)))) : null;
              const __strcmp = (a, b) => (a == null || b == null) ? null : (String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0));
              const __elt = (n, ...args) => {
                  if (n == null) return null;
                  const i = Math.trunc(Number(n));
                  return (i >= 1 && i <= args.length) ? args[i - 1] : null;
              };
              const __field = (v, ...args) => {
                  if (v == null) return 0;
                  for (let i = 0; i < args.length; i++) {
                      if (args[i] != null && String(args[i]) === String(v)) return i + 1;
                  }
                  return 0;
              };
              // INITCAP: 語の先頭だけ大文字、残りは小文字。語の区切りは「英数字以外すべて」で、
              // 空白だけではない（PostgreSQL / Oracle いずれもそう定める）。
              // 従来は \S* が区切り記号を語に含めてしまい、'a,b,c' が 'A,b,c'、
              // 'foo-bar' が 'Foo-bar' になっていた（正しくは 'A,B,C' / 'Foo-Bar'）
              const __initcap = (v) => v != null
                  ? String(v).toLowerCase().replace(/[a-z0-9]+/g, w => w[0].toUpperCase() + w.slice(1))
                  : null;

              // --- v1.1 追加関数群: 日付 ---
              const __MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
              const __DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const __monthname = (v) => v != null ? __MONTH_NAMES[__date_parse(v).getUTCMonth()] : null;
              const __dayname = (v) => v != null ? __DAY_NAMES[__date_parse(v).getUTCDay()] : null;
              const __weekday = (v) => v != null ? (__date_parse(v).getUTCDay() + 6) % 7 : null;
              const __week = (v) => {
                  // MySQL WEEK(d) 既定モード0: 日曜始まり、年初〜最初の日曜までは第0週
                  if (v == null) return null;
                  const d = __date_parse(v);
                  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
                  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
                  const firstSunday = yearStart + ((7 - new Date(yearStart).getUTCDay()) % 7) * 86400000;
                  if (day < firstSunday) return 0;
                  return Math.floor((day - firstSunday) / 604800000) + 1;
              };
              const __weekofyear = (v) => {
                  // ISO 8601 週番号 (MySQL WEEKOFYEAR 互換)
                  if (v == null) return null;
                  const d0 = __date_parse(v);
                  const t = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
                  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
                  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
                  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
                  return 1 + Math.round((t.getTime() - ft.getTime()) / 604800000);
              };
              const __unix_timestamp = (v) => {
                  if (v === undefined) return Math.floor(Date.now() / 1000);
                  if (v == null) return null;
                  const t = __date_parse(v).getTime();
                  return isNaN(t) ? null : Math.floor(t / 1000);
              };
              const __from_unixtime = (n) => {
                  if (n == null) return null;
                  const d = new Date(Math.trunc(Number(n)) * 1000);
                  return isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
              };
              const __date_format = (v, fmt) => {
                  if (v == null || fmt == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  const p2 = (x) => String(x).padStart(2, '0');
                  const H = d.getUTCHours(), h12 = H % 12 === 0 ? 12 : H % 12;
                  const ord = (x) => { const sfx = ['th','st','nd','rd'], m100 = x % 100; return x + (sfx[(m100 - 20) % 10] || sfx[m100] || sfx[0]); };
                  return String(fmt).replace(/%([a-zA-Z%])/g, (mm, c) => {
                      switch (c) {
                          case 'Y': return String(d.getUTCFullYear());
                          case 'y': return p2(d.getUTCFullYear() % 100);
                          case 'm': return p2(d.getUTCMonth() + 1);
                          case 'c': return String(d.getUTCMonth() + 1);
                          case 'd': return p2(d.getUTCDate());
                          case 'e': return String(d.getUTCDate());
                          case 'H': return p2(H);
                          case 'k': return String(H);
                          case 'h': case 'I': return p2(h12);
                          case 'l': return String(h12);
                          case 'i': return p2(d.getUTCMinutes());
                          case 's': case 'S': return p2(d.getUTCSeconds());
                          case 'p': return H < 12 ? 'AM' : 'PM';
                          case 'M': return __MONTH_NAMES[d.getUTCMonth()];
                          case 'b': return __MONTH_NAMES[d.getUTCMonth()].slice(0, 3);
                          case 'W': return __DAY_NAMES[d.getUTCDay()];
                          case 'a': return __DAY_NAMES[d.getUTCDay()].slice(0, 3);
                          case 'D': return ord(d.getUTCDate());
                          case 'w': return String(d.getUTCDay());
                          case 'j': return String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000)).padStart(3, '0');
                          case 'T': return p2(H) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
                          case 'r': return p2(h12) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ' ' + (H < 12 ? 'AM' : 'PM');
                          case '%': return '%';
                          default: return mm;
                      }
                  });
              };
              // 単位名の誤りを黙って NULL にせず知らせる。EXTRACT / DATE_PART / DATEPART は
              // 綴り違い（'dayofyear' を PostgreSQL 系へ渡す等）が起きやすく、
              // NULL を返すと「その日付には値が無い」との区別が付かない
              const __EXTRACT_UNITS = ['YEAR','QUARTER','MONTH','WEEK','DAY','HOUR','MINUTE','SECOND','EPOCH','DOW','DOY'];
              // 式の実行時エラーは既定では NULL に丸められる（型違いや不正な正規表現で
              // クエリ全体を落とさないための設計）。だが「単位名が違う」のように
              // 利用者へ必ず伝えるべき誤りまで NULL になると、値が無いのか綴りが違うのか
              // 区別できない。__sqlError を立てた例外だけは丸めずに外へ出す
              const __raise = (msg) => { const e = new Error(msg); e.__sqlError = true; throw e; };
              const __badUnit = (fn, unit, allowed) => {
                  __raise(`Unsupported date unit '${unit}' in ${fn}. Supported: ${allowed.join(', ')}.`);
              };
              const __extract = (unit, v) => {
                  if (__EXTRACT_UNITS.indexOf(unit) === -1) __badUnit('EXTRACT / DATE_PART', unit, __EXTRACT_UNITS);
                  if (v == null) return null;
                  switch (unit) {
                      case 'YEAR': return __year(v);
                      case 'QUARTER': return __quarter(v);
                      case 'MONTH': return __month(v);
                      case 'WEEK': return __weekofyear(v);
                      case 'DAY': return __day(v);
                      case 'HOUR': return __hour(v);
                      case 'MINUTE': return __minute(v);
                      case 'SECOND': return __second(v);
                      case 'EPOCH': { const d = __date_parse(v); return (!d || isNaN(d.getTime())) ? null : Math.floor(d.getTime() / 1000); }
                      case 'DOW': return __dayofweek(v) - 1;
                      case 'DOY': return __dayofyear(v);
                  }
                  return null;
              };
              const __timestampdiff = (unit, a, b) => {
                  // MySQL 互換: TIMESTAMPDIFF(unit, start, end) = end - start
                  if (a == null || b == null) return null;
                  const d1 = __date_parse(a), d2 = __date_parse(b);
                  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
                  const ms = d2.getTime() - d1.getTime();
                  if (unit === 'SECOND') return Math.trunc(ms / 1000);
                  if (unit === 'MINUTE') return Math.trunc(ms / 60000);
                  if (unit === 'HOUR') return Math.trunc(ms / 3600000);
                  if (unit === 'DAY') return Math.trunc(ms / 86400000);
                  if (unit === 'WEEK') return Math.trunc(ms / 604800000);
                  // 月単位系: 暦上の月差を求め、日・時刻の端数で満たない分を調整する
                  let months = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
                  const anchor = new Date(d1.getTime());
                  anchor.setUTCMonth(anchor.getUTCMonth() + months);
                  if (ms >= 0 && anchor.getTime() > d2.getTime()) months--;
                  if (ms < 0 && anchor.getTime() < d2.getTime()) months++;
                  if (unit === 'MONTH') return months;
                  if (unit === 'QUARTER') return Math.trunc(months / 3);
                  if (unit === 'YEAR') return Math.trunc(months / 12);
                  return null;
              };

              // --- v1.1 追加関数群: JSON ---
              // 値は TEXT 列に格納された JSON 文字列を想定。パス構文は $.key / $[n] / $."quoted key"
              const __json_parse = (v) => {
                  if (v == null) return undefined;
                  if (typeof v !== 'string') return v;
                  try { return JSON.parse(v); } catch (e) { return undefined; }
              };
              const __json_path = (path) => {
                  if (path == null) return null;
                  const p = String(path).trim();
                  if (p[0] !== '$') return null;
                  const parts = [];
                  const re = /\.([a-zA-Z_][a-zA-Z0-9_]*)|\[(\d+)\]|\."([^"]+)"/g;
                  re.lastIndex = 1;
                  let consumed = 1, mm;
                  while ((mm = re.exec(p))) {
                      if (mm.index !== consumed) return null;
                      consumed = re.lastIndex;
                      if (mm[1] !== undefined) parts.push(mm[1]);
                      else if (mm[2] !== undefined) parts.push(Number(mm[2]));
                      else parts.push(mm[3]);
                  }
                  return consumed === p.length ? parts : null;
              };
              // プロトタイプ汚染ガード: JSON のパス / キーはユーザー入力なので、
              // 書き込み先として '__proto__' 等が現れたら拒否する。
              // （JSON.parse 自体は __proto__ を通常のキーとして読むので安全だが、
              //   パース結果へ obj['__proto__'].x = v と書くと Object.prototype が汚れる）
              // 注: オブジェクトリテラルの '__proto__:' はプロトタイプ指定になり
              //     own key にならないため、集合は配列/Set で持つ
              const __UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
              const __json_safe_key = (k) => {
                  if (typeof k === 'string' && __UNSAFE_KEYS.has(k)) {
                      throw new Error(`JSON key '${k}' is not allowed (prototype pollution guard).`);
                  }
                  return k;
              };
              const __json_get = (v, path) => {
                  const obj = __json_parse(v);
                  const parts = __json_path(path);
                  if (obj === undefined || parts === null) return undefined;
                  let cur = obj;
                  for (const k of parts) {
                      if (cur === null || typeof cur !== 'object') return undefined;
                      cur = cur[k];
                      if (cur === undefined) return undefined;
                  }
                  return cur;
              };
              const __json_extract = (v, path) => {
                  const r = __json_get(v, path);
                  if (r === undefined || r === null) return null;
                  return typeof r === 'object' ? JSON.stringify(r) : r;
              };
              const __json_array = (...args) => JSON.stringify(args.map(a => a === undefined ? null : a));
              const __json_object = (...kv) => {
                  if (kv.length % 2 !== 0) return null;
                  const o = {};
                  for (let i = 0; i < kv.length; i += 2) {
                      if (kv[i] == null) return null;
                      // キーは呼び出し側の値なので '__proto__' 等はここでも拒否する
                      Object.defineProperty(o, __json_safe_key(String(kv[i])), {
                          value: kv[i + 1] === undefined ? null : kv[i + 1],
                          enumerable: true, writable: true, configurable: true
                      });
                  }
                  return JSON.stringify(o);
              };
              const __json_length = (v, path) => {
                  const t = path !== undefined ? __json_get(v, path) : __json_parse(v);
                  if (t === undefined) return null;
                  if (Array.isArray(t)) return t.length;
                  if (t !== null && typeof t === 'object') return Object.keys(t).length;
                  return 1;
              };
              const __json_keys = (v, path) => {
                  const t = path !== undefined ? __json_get(v, path) : __json_parse(v);
                  if (t === undefined || t === null || typeof t !== 'object' || Array.isArray(t)) return null;
                  return JSON.stringify(Object.keys(t));
              };
              const __json_valid = (v) => {
                  if (v == null) return null;
                  if (typeof v !== 'string') return 0;
                  try { JSON.parse(v); return 1; } catch (e) { return 0; }
              };
              const __json_type = (v, path) => {
                  const t = path !== undefined ? __json_get(v, path) : __json_parse(v);
                  if (t === undefined) return null;
                  if (t === null) return 'NULL';
                  if (Array.isArray(t)) return 'ARRAY';
                  if (typeof t === 'object') return 'OBJECT';
                  if (typeof t === 'string') return 'STRING';
                  if (typeof t === 'boolean') return 'BOOLEAN';
                  return Number.isInteger(t) ? 'INTEGER' : 'DOUBLE';
              };
              const __json_contains_deep = (target, cand) => {
                  if (Array.isArray(target)) {
                      if (Array.isArray(cand)) return cand.every(c => target.some(t => __json_contains_deep(t, c)));
                      return target.some(t => __json_contains_deep(t, cand));
                  }
                  if (target !== null && typeof target === 'object') {
                      if (cand === null || typeof cand !== 'object' || Array.isArray(cand)) return false;
                      return Object.keys(cand).every(k => k in target && __json_contains_deep(target[k], cand[k]));
                  }
                  return target === cand;
              };
              const __json_contains = (v, cand, path) => {
                  const t = path !== undefined ? __json_get(v, path) : __json_parse(v);
                  if (t === undefined || cand == null) return null;
                  let c = cand;
                  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { /* 素の文字列として比較 */ } }
                  return __json_contains_deep(t, c) ? 1 : 0;
              };
              const __json_set = (v, path, val) => {
                  const obj = __json_parse(v);
                  const parts = __json_path(path);
                  if (obj === undefined || parts === null || parts.length === 0) return null;
                  parts.forEach(__json_safe_key);
                  let cur = obj;
                  for (let i = 0; i < parts.length - 1; i++) {
                      const k = parts[i];
                      if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
                          cur[k] = typeof parts[i + 1] === 'number' ? [] : {};
                      }
                      cur = cur[k];
                  }
                  const leaf = parts[parts.length - 1];
                  if (Array.isArray(cur) && typeof leaf === 'number' && leaf > cur.length) cur.push(val === undefined ? null : val);
                  else cur[leaf] = val === undefined ? null : val;
                  return JSON.stringify(obj);
              };
              const __json_remove = (v, path) => {
                  const obj = __json_parse(v);
                  const parts = __json_path(path);
                  if (obj === undefined || parts === null || parts.length === 0) return null;
                  let cur = obj;
                  for (let i = 0; i < parts.length - 1; i++) {
                      cur = (cur !== null && typeof cur === 'object') ? cur[parts[i]] : undefined;
                      if (cur === undefined || cur === null) return JSON.stringify(obj);
                  }
                  const leaf = parts[parts.length - 1];
                  if (Array.isArray(cur) && typeof leaf === 'number') cur.splice(leaf, 1);
                  else if (cur !== null && typeof cur === 'object') delete cur[leaf];
                  return JSON.stringify(obj);
              };

              // --- v1.18 追加: JSON の部分更新（MySQL 互換）と演算子形アクセス ---
              // JSON_INSERT は「存在しないパスだけ」書く。JSON_REPLACE は「存在するパスだけ」書く。
              // JSON_SET は両方。3者は書き込み条件だけが違うので判定を共有する
              const __json_write = (v, path, val, mode) => {
                  const obj = __json_parse(v);
                  const parts = __json_path(path);
                  if (obj === undefined || parts === null || parts.length === 0) return null;
                  parts.forEach(__json_safe_key);
                  let cur = obj;
                  for (let i = 0; i < parts.length - 1; i++) {
                      const k = parts[i];
                      if (cur === null || typeof cur !== 'object') return JSON.stringify(obj);
                      if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
                          // 中間ノードが無い場合、REPLACE は何もしない（対象パスが存在しないため）
                          if (mode === 'replace') return JSON.stringify(obj);
                          cur[k] = typeof parts[i + 1] === 'number' ? [] : {};
                      }
                      cur = cur[k];
                  }
                  if (cur === null || typeof cur !== 'object') return JSON.stringify(obj);
                  const leaf = parts[parts.length - 1];
                  const exists = Array.isArray(cur) ? (typeof leaf === 'number' && leaf < cur.length) : (leaf in cur);
                  if (mode === 'insert' && exists) return JSON.stringify(obj);
                  if (mode === 'replace' && !exists) return JSON.stringify(obj);
                  if (Array.isArray(cur) && typeof leaf === 'number' && leaf >= cur.length) cur.push(val === undefined ? null : val);
                  else cur[leaf] = val === undefined ? null : val;
                  return JSON.stringify(obj);
              };
              const __json_insert = (v, path, val) => __json_write(v, path, val, 'insert');
              const __json_replace = (v, path, val) => __json_write(v, path, val, 'replace');
              // JSON_ARRAY_INSERT('[1,2]', '$[0]', 9) -> '[9,1,2]'（指定位置へ挿入。末尾超過は追記）
              const __json_array_insert = (v, path, val) => {
                  const obj = __json_parse(v);
                  const parts = __json_path(path);
                  if (obj === undefined || parts === null || parts.length === 0) return null;
                  if (typeof parts[parts.length - 1] !== 'number') return null;
                  parts.forEach(__json_safe_key);
                  let cur = obj;
                  for (let i = 0; i < parts.length - 1; i++) {
                      if (cur === null || typeof cur !== 'object') return JSON.stringify(obj);
                      cur = cur[parts[i]];
                      if (cur === undefined) return JSON.stringify(obj);
                  }
                  if (!Array.isArray(cur)) return JSON.stringify(obj);
                  const idx = parts[parts.length - 1];
                  cur.splice(Math.min(idx, cur.length), 0, val === undefined ? null : val);
                  return JSON.stringify(obj);
              };
              // '->' / '->>' のキー引数は '$.a' 形のパスでも 'a' / 配列添字の数値でも来る。
              // PostgreSQL/MySQL 双方の書き方を受けられるようここで正規化する
              const __json_key_path = (k) => {
                  if (k === null || k === undefined) return null;
                  if (typeof k === 'number') return '$[' + Math.trunc(k) + ']';
                  const sk = String(k);
                  if (sk[0] === '$') return sk;
                  if (/^-?\d+$/.test(sk)) return '$[' + sk + ']';
                  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sk) ? '$.' + sk : '$."' + sk.replace(/"/g, '') + '"';
              };
              // '->' は JSON を JSON のまま返す（オブジェクト/配列は文字列化、スカラーは JSON 表記）
              const __json_arrow = (v, k) => {
                  const p = __json_key_path(k);
                  if (p === null) return null;
                  const r = __json_get(v, p);
                  if (r === undefined) return null;
                  return JSON.stringify(r);
              };
              // '->>' は取り出した値をテキストとして返す（文字列は引用符なし）
              const __json_arrow_text = (v, k) => {
                  const p = __json_key_path(k);
                  if (p === null) return null;
                  const r = __json_get(v, p);
                  if (r === undefined || r === null) return null;
                  return typeof r === 'object' ? JSON.stringify(r) : String(r);
              };
              // '#>' / '#>>' のパスは '{a,b}' 形（PostgreSQL）または JSON 配列 '["a","b"]'
              const __json_path_list = (spec) => {
                  if (spec == null) return null;
                  const t = String(spec).trim();
                  let keys;
                  if (t[0] === '{' && t[t.length - 1] === '}') {
                      const body = t.slice(1, -1).trim();
                      keys = body === '' ? [] : body.split(',').map(x => x.trim());
                  } else {
                      const parsed = __json_parse(t);
                      if (!Array.isArray(parsed)) return null;
                      keys = parsed.map(x => String(x));
                  }
                  return '$' + keys.map(k => /^-?\d+$/.test(k) ? '[' + k + ']' : (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? '.' + k : '."' + k.replace(/"/g, '') + '"')).join('');
              };
              const __json_hash_arrow = (v, spec) => {
                  const p = __json_path_list(spec);
                  return p === null ? null : __json_arrow(v, p);
              };
              const __json_hash_arrow_text = (v, spec) => {
                  const p = __json_path_list(spec);
                  return p === null ? null : __json_arrow_text(v, p);
              };
              // トップレベルにそのキー（配列なら要素）が存在するか
              const __json_has_key = (v, k) => {
                  const t = __json_parse(v);
                  if (t === undefined || t === null || k == null) return null;
                  if (Array.isArray(t)) return t.some(x => String(x) === String(k));
                  if (typeof t !== 'object') return false;
                  return Object.keys(t).indexOf(String(k)) !== -1;
              };
              // JSON_CONTAINS_PATH(json, 'one'|'all', path, ...) — MySQL 互換
              const __json_contains_path = (v, oneOrAll, ...paths) => {
                  if (v == null || oneOrAll == null || paths.length === 0) return null;
                  const all = String(oneOrAll).toLowerCase() === 'all';
                  const hits = paths.map(p => __json_get(v, p) !== undefined);
                  return (all ? hits.every(Boolean) : hits.some(Boolean)) ? 1 : 0;
              };
              // SQL 標準の真偽述語 IS [NOT] TRUE|FALSE。NULL(UNKNOWN) は TRUE でも FALSE でもない
              const __is_bool = (v, want, negate) => {
                  let b;
                  if (v === null || v === undefined) b = false;
                  else if (typeof v === 'boolean') b = (v === want);
                  else if (typeof v === 'number') b = ((v !== 0) === want);
                  else {
                      const sv = String(v).toLowerCase();
                      if (sv === 'true' || sv === '1') b = (want === true);
                      else if (sv === 'false' || sv === '0' || sv === '') b = (want === false);
                      else b = (want === true);
                  }
                  return negate ? !b : b;
              };

              // --- v1.2 追加関数群: 正規表現 / 文字列 / ビット / 時刻 ---
              const __regexp_guard = (p) => {
                  if (p != null && String(p).length > 1000) throw new Error("REGEXP pattern too long (max 1000 characters).");
                  return p;
              };
              // match_type（'i' 大小無視 / 'c' 区別 / 'm' 複数行 / 'n' ドットが改行に一致）を
              // JS の正規表現フラグへ写す。MySQL / Oracle の第5引数に相当する
              const __regexp_flags = (mt, base) => {
                  let f = base || '';
                  if (mt == null) return f;
                  const t = String(mt);
                  if (t.includes('i') && !f.includes('i')) f += 'i';
                  if (t.includes('m') && !f.includes('m')) f += 'm';
                  if (t.includes('n') && !f.includes('s')) f += 's';
                  if (t.includes('c')) f = f.replace('i', '');
                  return f;
              };
              // 第4引数 position（1 始まりの開始位置）と第5引数 occurrence（何個目）は
              // 従来まったく解釈されず、指定しても常に「最初の一致」を返していた
              const __regexp_nth = (str, re, occ) => {
                  let m2, n = 0;
                  const rg = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
                  while ((m2 = rg.exec(str)) !== null) {
                      n++;
                      if (n === occ) return m2;
                      if (m2.index === rg.lastIndex) rg.lastIndex++;
                  }
                  return null;
              };
              const __regexp_replace = (s0, pat, rep, pos, occ, mt) => {
                  if (s0 == null || pat == null || rep == null) return null;
                  __regexp_guard(pat);
                  try {
                      const str = String(s0);
                      const p = pos == null ? 1 : Math.trunc(Number(pos));
                      if (!isFinite(p) || p < 1) return null;
                      const head = str.slice(0, p - 1), tail = str.slice(p - 1);
                      const o = occ == null ? 0 : Math.trunc(Number(occ));
                      if (o === 0) return head + tail.replace(new RegExp(String(pat), __regexp_flags(mt, 'g')), String(rep));
                      const re = new RegExp(String(pat), __regexp_flags(mt, ''));
                      const m2 = __regexp_nth(tail, re, o);
                      if (!m2) return str;
                      return head + tail.slice(0, m2.index) + String(rep) + tail.slice(m2.index + m2[0].length);
                  } catch (e) { return null; }
              };
              const __regexp_substr = (s0, pat, pos, occ, mt) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try {
                      const str = String(s0);
                      const p = pos == null ? 1 : Math.trunc(Number(pos));
                      if (!isFinite(p) || p < 1) return null;
                      const tail = str.slice(p - 1);
                      const re = new RegExp(String(pat), __regexp_flags(mt, ''));
                      const o = occ == null ? 1 : Math.trunc(Number(occ));
                      if (o < 1) return null;
                      const m2 = __regexp_nth(tail, re, o);
                      return m2 ? m2[0] : null;
                  } catch (e) { return null; }
              };
              const __regexp_like = (s0, pat, mt) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try { return new RegExp(String(pat), __regexp_flags(mt, '')).test(String(s0)) ? 1 : 0; } catch (e) { return 0; }
              };
              const __split_part = (s0, d, n) => {
                  if (s0 == null || d == null || n == null) return null;
                  const parts = String(s0).split(String(d));
                  const i2 = Math.trunc(Number(n));
                  if (i2 === 0 || isNaN(i2)) return null;
                  const idx = i2 > 0 ? i2 - 1 : parts.length + i2;
                  return (idx >= 0 && idx < parts.length) ? parts[idx] : '';
              };
              const __quote = (v) => {
                  if (v == null) return 'NULL';
                  const BS = String.fromCharCode(92);
                  return "'" + String(v).split(BS).join(BS + BS).split("'").join(BS + "'") + "'";
              };
              const __bit_count = (v) => {
                  if (v == null) return null;
                  let n = BigInt.asUintN(64, BigInt(Math.trunc(Number(v))));
                  let c = 0;
                  while (n > 0n) { c += Number(n & 1n); n >>= 1n; }
                  return c;
              };
              const __sec_to_time = (v) => {
                  if (v == null) return null;
                  let n = Math.trunc(Number(v));
                  const sign = n < 0 ? '-' : '';
                  n = Math.abs(n);
                  const p2 = (x) => String(x).padStart(2, '0');
                  return sign + p2(Math.floor(n / 3600)) + ':' + p2(Math.floor((n % 3600) / 60)) + ':' + p2(n % 60);
              };
              const __time_to_sec = (v) => {
                  if (v == null) return null;
                  const m2 = String(v).trim().match(/^(-)?(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
                  if (!m2) {
                      const d = __date_parse(v);
                      return isNaN(d.getTime()) ? null : d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
                  }
                  const t = Number(m2[2]) * 3600 + Number(m2[3]) * 60 + Number(m2[4] || 0);
                  return m2[1] ? -t : t;
              };
              const __makedate = (y, doy) => {
                  if (y == null || doy == null) return null;
                  const n = Math.trunc(Number(doy));
                  if (n < 1) return null;
                  const d = new Date(Date.UTC(Math.trunc(Number(y)), 0, n));
                  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
              };
              const __str_to_date = (s0, fmt) => {
                  // DATE_FORMAT の逆変換（%Y %y %m %c %d %e %H %h %i %s %M %b %% に対応）
                  if (s0 == null || fmt == null) return null;
                  const src = String(s0), f = String(fmt);
                  let i2 = 0, j2 = 0;
                  const parts = { Y: null, m: null, d: null, H: 0, i: 0, s: 0, hasTime: false };
                  const readNum = (maxLen) => {
                      const st = j2;
                      while (j2 < src.length && j2 - st < maxLen && src[j2] >= '0' && src[j2] <= '9') j2++;
                      return j2 > st ? Number(src.slice(st, j2)) : null;
                  };
                  while (i2 < f.length) {
                      if (f[i2] === '%' && i2 + 1 < f.length) {
                          const c = f[i2 + 1];
                          i2 += 2;
                          let v;
                          if (c === 'Y') { v = readNum(4); if (v === null) return null; parts.Y = v; }
                          else if (c === 'y') { v = readNum(2); if (v === null) return null; parts.Y = v + (v < 70 ? 2000 : 1900); }
                          else if (c === 'm' || c === 'c') { v = readNum(2); if (v === null) return null; parts.m = v; }
                          else if (c === 'd' || c === 'e') { v = readNum(2); if (v === null) return null; parts.d = v; }
                          else if (c === 'H' || c === 'h' || c === 'k') { v = readNum(2); if (v === null) return null; parts.H = v; parts.hasTime = true; }
                          else if (c === 'i') { v = readNum(2); if (v === null) return null; parts.i = v; parts.hasTime = true; }
                          else if (c === 's' || c === 'S') { v = readNum(2); if (v === null) return null; parts.s = v; parts.hasTime = true; }
                          else if (c === 'M' || c === 'b') {
                              const rest = src.slice(j2).toLowerCase();
                              const mi = __MONTH_NAMES.findIndex(nm => rest.startsWith(nm.toLowerCase()));
                              if (mi !== -1) { j2 += __MONTH_NAMES[mi].length; parts.m = mi + 1; }
                              else {
                                  const ai = __MONTH_NAMES.findIndex(nm => rest.startsWith(nm.slice(0, 3).toLowerCase()));
                                  if (ai === -1) return null;
                                  j2 += 3; parts.m = ai + 1;
                              }
                          }
                          else if (c === '%') { if (src[j2] !== '%') return null; j2++; }
                          else return null;
                      } else {
                          if (src[j2] !== f[i2]) return null;
                          i2++; j2++;
                      }
                  }
                  if (parts.Y === null || parts.m === null || parts.d === null) return null;
                  const dt = new Date(Date.UTC(parts.Y, parts.m - 1, parts.d, parts.H, parts.i, parts.s));
                  if (isNaN(dt.getTime())) return null;
                  return parts.hasTime ? dt.toISOString().replace('T', ' ').slice(0, 19) : dt.toISOString().slice(0, 10);
              };
              const __time = (v) => {
                  if (v == null) return null;
                  const d = __date_parse(v);
                  return isNaN(d.getTime()) ? null : d.toISOString().slice(11, 19);
              };
              const __trim_dir = (dir, chars, s0) => {
                  if (s0 == null) return null;
                  const ch = (chars === null || chars === undefined) ? ' ' : String(chars);
                  let out = String(s0);
                  if (ch.length === 0) return out;
                  if (dir === 'L' || dir === 'B') { while (out.startsWith(ch)) out = out.slice(ch.length); }
                  if (dir === 'R' || dir === 'B') { while (out.endsWith(ch)) out = out.slice(0, -ch.length); }
                  return out;
              };

              // --- v1.5 追加関数群: ハッシュ / エンコード / ネットワーク / 文字列 / 日付 / JSON ---
              const __utf8_bytes = (str) => {
                  const bytes = [];
                  for (let i = 0; i < str.length; i++) {
                      let c = str.codePointAt(i);
                      if (c > 0xFFFF) i++;
                      if (c < 0x80) bytes.push(c);
                      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63));
                      else if (c < 0x10000) bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                      else bytes.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                  }
                  return bytes;
              };
              const __md5 = (input) => {
                  if (input == null) return null;
                  const bytes = __utf8_bytes(String(input));
                  const origLen = bytes.length;
                  bytes.push(0x80);
                  while (bytes.length % 64 !== 56) bytes.push(0);
                  const bitLen = origLen * 8;
                  for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xFF);
                  const K = new Array(64);
                  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
                  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
                  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
                  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
                  for (let ch = 0; ch < bytes.length; ch += 64) {
                      const M = new Array(16);
                      for (let i = 0; i < 16; i++) M[i] = bytes[ch + 4 * i] | (bytes[ch + 4 * i + 1] << 8) | (bytes[ch + 4 * i + 2] << 16) | (bytes[ch + 4 * i + 3] << 24);
                      let A = a0, B = b0, C = c0, D = d0;
                      for (let i = 0; i < 64; i++) {
                          let F, g;
                          if (i < 16) { F = (B & C) | (~B & D); g = i; }
                          else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                          else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
                          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
                          F = (F + A + K[i] + M[g]) | 0;
                          A = D; D = C; C = B;
                          B = (B + rotl(F, S[Math.floor(i / 16) * 4 + i % 4])) | 0;
                      }
                      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
                  }
                  const hx = (n) => { let o = ''; for (let i = 0; i < 4; i++) o += ((n >>> (8 * i)) & 0xFF).toString(16).padStart(2, '0'); return o; };
                  return hx(a0) + hx(b0) + hx(c0) + hx(d0);
              };
              const __crc32 = (v) => {
                  if (v == null) return null;
                  const bytes = __utf8_bytes(String(v));
                  let crc = -1;
                  for (let i = 0; i < bytes.length; i++) {
                      crc ^= bytes[i];
                      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
                  }
                  return (crc ^ -1) >>> 0;
              };
              const __B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
              const __to_base64 = (v) => {
                  if (v == null) return null;
                  const bytes = __utf8_bytes(String(v));
                  let out = '';
                  for (let i = 0; i < bytes.length; i += 3) {
                      const b1 = bytes[i], b2 = bytes[i + 1], b3 = bytes[i + 2];
                      out += __B64_ALPHA[b1 >> 2];
                      out += __B64_ALPHA[((b1 & 3) << 4) | ((b2 === undefined ? 0 : b2) >> 4)];
                      out += b2 === undefined ? '=' : __B64_ALPHA[((b2 & 15) << 2) | ((b3 === undefined ? 0 : b3) >> 6)];
                      out += b3 === undefined ? '=' : __B64_ALPHA[b3 & 63];
                  }
                  return out;
              };
              const __from_base64 = (v) => {
                  if (v == null) return null;
                  const s0 = String(v).replace(/\s+/g, '');
                  if (s0.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s0)) return null;
                  const bytes = [];
                  for (let i = 0; i < s0.length; i += 4) {
                      const n = [0, 1, 2, 3].map(k => { const c = s0[i + k]; return (c === '=' || c === undefined) ? 0 : __B64_ALPHA.indexOf(c); });
                      bytes.push((n[0] << 2) | (n[1] >> 4));
                      if (s0[i + 2] !== '=' && s0[i + 2] !== undefined) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
                      if (s0[i + 3] !== '=' && s0[i + 3] !== undefined) bytes.push(((n[2] & 3) << 6) | n[3]);
                  }
                  let out = '';
                  for (let i = 0; i < bytes.length;) {
                      const b = bytes[i];
                      if (b < 0x80) { out += String.fromCharCode(b); i++; }
                      else if (b < 0xE0) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
                      else if (b < 0xF0) { out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
                      else { out += String.fromCodePoint(((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)); i += 4; }
                  }
                  return out;
              };
              const __inet_aton = (v) => {
                  if (v == null) return null;
                  const m0 = String(v).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
                  if (!m0) return null;
                  const p4 = [m0[1], m0[2], m0[3], m0[4]].map(Number);
                  if (p4.some(x => x > 255)) return null;
                  return p4[0] * 16777216 + p4[1] * 65536 + p4[2] * 256 + p4[3];
              };
              const __inet_ntoa = (v) => {
                  if (v == null) return null;
                  const n = Math.trunc(Number(v));
                  if (isNaN(n) || n < 0 || n > 4294967295) return null;
                  return [(n >>> 24), (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
              };
              const __soundex = (v) => {
                  if (v == null) return null;
                  const s0 = String(v).toUpperCase().replace(/[^A-Z]/g, '');
                  if (!s0) return '';
                  const code = (c) => 'BFPV'.includes(c) ? '1' : 'CGJKQSXZ'.includes(c) ? '2' : 'DT'.includes(c) ? '3' : c === 'L' ? '4' : 'MN'.includes(c) ? '5' : c === 'R' ? '6' : '';
                  let out = s0[0];
                  let prev = code(s0[0]);
                  for (let i = 1; i < s0.length && out.length < 4; i++) {
                      const c = code(s0[i]);
                      if (c && c !== prev) out += c;
                      if (s0[i] !== 'H' && s0[i] !== 'W') prev = c;
                  }
                  return out.padEnd(4, '0');
              };
              const __translate = (s0, from, to) => {
                  if (s0 == null || from == null || to == null) return null;
                  const f = String(from), t = String(to);
                  let out = '';
                  for (const ch of String(s0)) {
                      const i = f.indexOf(ch);
                      if (i === -1) out += ch;
                      else if (i < t.length) out += t[i];
                      // from の方が長い分は削除（PostgreSQL 互換）
                  }
                  return out;
              };
              const __str_insert = (s0, pos, len, ns) => {
                  // MySQL INSERT(str, pos, len, newstr): pos は 1 始まり。範囲外の pos は元の文字列を返す
                  if (s0 == null || pos == null || len == null || ns == null) return null;
                  const str = String(s0);
                  const p = Math.trunc(Number(pos));
                  let l = Math.trunc(Number(len));
                  if (isNaN(p) || p < 1 || p > str.length) return str;
                  if (isNaN(l) || l < 0 || l > str.length - p + 1) l = str.length - p + 1;
                  return str.slice(0, p - 1) + String(ns) + str.slice(p - 1 + l);
              };
              const __cosh = (v) => v != null ? __fin(Math.cosh(Number(v))) : null;
              const __tanh = (v) => v != null ? Math.tanh(Number(v)) : null;
              const __to_days = (v) => {
                  if (v == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  // 年0からの日数（MySQL互換: TO_DAYS('1970-01-01') = 719528）
                  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000) + 719528;
              };
              const __from_days = (n) => {
                  if (n == null) return null;
                  const d = new Date((Math.trunc(Number(n)) - 719528) * 86400000);
                  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
              };
              const __maketime = (h, mi, se) => {
                  if (h == null || mi == null || se == null) return null;
                  const hh = Math.trunc(Number(h)), mm = Math.trunc(Number(mi)), ss = Math.trunc(Number(se));
                  if (isNaN(hh) || isNaN(mm) || isNaN(ss) || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
                  const sign = hh < 0 ? '-' : '';
                  const p2 = (x) => String(x).padStart(2, '0');
                  return sign + p2(Math.abs(hh)) + ':' + p2(mm) + ':' + p2(ss);
              };
              const __curtime = () => new Date().toISOString().slice(11, 19);
              const __format_bytes = (v) => {
                  if (v == null) return null;
                  const x = Number(v);
                  if (isNaN(x)) return null;
                  const a = Math.abs(x);
                  if (a < 1024) return Math.trunc(x) + ' bytes';
                  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
                  let u = -1, val = a;
                  while (val >= 1024 && u < units.length - 1) { val /= 1024; u++; }
                  return (x < 0 ? '-' : '') + val.toFixed(2) + ' ' + units[u];
              };
              const __timestampadd = (unit, n, v) => (n == null) ? null : __add_interval(v, __interval(n, unit), 1);
              const __json_pretty = (v) => {
                  const o = __json_parse(v);
                  return o === undefined ? null : JSON.stringify(o, null, 2);
              };
              const __json_quote = (v) => v == null ? null : JSON.stringify(String(v));
              const __json_unquote = (v) => {
                  if (v == null) return null;
                  const s0 = String(v);
                  if (s0.length >= 2 && s0[0] === '"' && s0[s0.length - 1] === '"') {
                      try { const r = JSON.parse(s0); if (typeof r === 'string') return r; } catch (e) { /* 引用符付きでなければそのまま */ }
                  }
                  return s0;
              };
              const __json_depth = (v) => {
                  const o = __json_parse(v);
                  if (o === undefined) return null;
                  const depth = (x) => {
                      if (x === null || typeof x !== 'object') return 1;
                      const vals = Array.isArray(x) ? x : Object.values(x);
                      if (vals.length === 0) return 1;
                      let mx = 0;
                      vals.forEach(y => { const d = depth(y); if (d > mx) mx = d; });
                      return 1 + mx;
                  };
                  return depth(o);
              };
              const __json_array_append = (v, path, val) => {
                  const obj = __json_parse(v);
                  const parts = path == null ? null : __json_path(path);
                  if (obj === undefined || parts === null) return null;
                  parts.forEach(__json_safe_key);
                  let cur = obj, parent = null, leafKey = null;
                  for (const k of parts) {
                      if (cur === null || typeof cur !== 'object') return null;
                      parent = cur; leafKey = k; cur = cur[k];
                      if (cur === undefined) return null;
                  }
                  const w = val === undefined ? null : val;
                  if (Array.isArray(cur)) { cur.push(w); return JSON.stringify(obj); }
                  // 対象が配列でない場合は [対象, 追加値] の配列で置き換える（MySQL互換）
                  if (parent === null) return JSON.stringify([cur, w]);
                  parent[leafKey] = [cur, w];
                  return JSON.stringify(obj);
              };
              const __json_merge_patch = (a, b) => {
                  // RFC 7396: パッチ側の null はキー削除、オブジェクト同士は再帰マージ、それ以外は置換
                  const pa = __json_parse(a), pb = __json_parse(b);
                  if (pa === undefined || pb === undefined) return null;
                  const merge = (t, p) => {
                      if (p === null || typeof p !== 'object' || Array.isArray(p)) return p;
                      const r = (t !== null && typeof t === 'object' && !Array.isArray(t)) ? t : {};
                      for (const k of Object.keys(p)) {
                          __json_safe_key(k);   // パッチ側のキーで Object.prototype を汚させない
                          if (p[k] === null) delete r[k];
                          else r[k] = merge(r[k] === undefined ? null : r[k], p[k]);
                      }
                      return r;
                  };
                  return JSON.stringify(merge(pa, pb));
              };

              // --- v1.6 追加関数群: ハッシュ / バイト長 / 日付切り捨て / 型 / シーケンス ---
              const __sha1 = (input) => {
                  if (input == null) return null;
                  const bytes = __utf8_bytes(String(input));
                  const ml = bytes.length;
                  bytes.push(0x80);
                  while (bytes.length % 64 !== 56) bytes.push(0);
                  const bitLen = ml * 8;
                  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xFF);
                  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
                  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
                  for (let ch = 0; ch < bytes.length; ch += 64) {
                      const w = new Array(80);
                      for (let i = 0; i < 16; i++) w[i] = (bytes[ch + 4 * i] << 24) | (bytes[ch + 4 * i + 1] << 16) | (bytes[ch + 4 * i + 2] << 8) | bytes[ch + 4 * i + 3];
                      for (let i = 16; i < 80; i++) w[i] = rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1);
                      let a = h0, b = h1, c = h2, d = h3, e = h4;
                      for (let i = 0; i < 80; i++) {
                          let f, k;
                          if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
                          else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
                          else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
                          else { f = b ^ c ^ d; k = 0xCA62C1D6; }
                          const t = (rotl(a, 5) + (f >>> 0) + e + k + (w[i] >>> 0)) >>> 0;
                          e = d; d = c; c = rotl(b, 30); b = a; a = t;
                      }
                      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
                  }
                  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
              };
              // SHA-2 系（SHA-256 / SHA-224）。crypto.subtle は非同期なので式評価では使えず、
              // 同期実装を持つ。MySQL の SHA2(str, 224|256|0) と PostgreSQL/一般の SHA256() 相当。
              // 384/512 は 64bit 演算が必要なため対応せず、明示的に NULL を返す
              const __SHA256_K = [
                  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
                  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
                  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
                  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
                  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
                  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
                  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
                  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
              ];
              const __sha2_core = (input, h) => {
                  const bytes = __utf8_bytes(String(input));
                  const ml = bytes.length;
                  bytes.push(0x80);
                  while (bytes.length % 64 !== 56) bytes.push(0);
                  const bitLen = ml * 8;
                  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xFF);
                  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
                  const H = h.slice();
                  const w = new Array(64);
                  for (let ch = 0; ch < bytes.length; ch += 64) {
                      for (let i = 0; i < 16; i++) {
                          w[i] = ((bytes[ch + 4 * i] << 24) | (bytes[ch + 4 * i + 1] << 16) | (bytes[ch + 4 * i + 2] << 8) | bytes[ch + 4 * i + 3]) >>> 0;
                      }
                      for (let i = 16; i < 64; i++) {
                          const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
                          const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
                          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
                      }
                      let [a, b, c, d, e, f, g, hh] = H;
                      for (let i = 0; i < 64; i++) {
                          const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
                          const chx = ((e & f) ^ (~e & g)) >>> 0;
                          const t1 = (hh + S1 + chx + __SHA256_K[i] + w[i]) >>> 0;
                          const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
                          const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
                          const t2 = (S0 + maj) >>> 0;
                          hh = g; g = f; f = e; e = (d + t1) >>> 0;
                          d = c; c = b; b = a; a = (t1 + t2) >>> 0;
                      }
                      const upd = [a, b, c, d, e, f, g, hh];
                      for (let i = 0; i < 8; i++) H[i] = (H[i] + upd[i]) >>> 0;
                  }
                  return H;
              };
              const __sha256 = (input) => {
                  if (input == null) return null;
                  const H = __sha2_core(input, [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
                  return H.map(x => x.toString(16).padStart(8, '0')).join('');
              };
              const __sha224 = (input) => {
                  if (input == null) return null;
                  const H = __sha2_core(input, [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]);
                  return H.slice(0, 7).map(x => x.toString(16).padStart(8, '0')).join('');
              };
              const __sha2 = (input, bits) => {
                  if (input == null) return null;
                  const n = bits == null ? 256 : Math.trunc(Number(bits));
                  if (n === 224) return __sha224(input);
                  if (n === 0 || n === 256) return __sha256(input);
                  return null;   // 384 / 512 は未対応（MySQL も未サポート幅は NULL を返す）
              };
              const __octet_length = (v) => v != null ? __utf8_bytes(String(v)).length : null;
              const __bit_length = (v) => v != null ? __utf8_bytes(String(v)).length * 8 : null;
              const __unhex = (v) => {
                  if (v == null) return null;
                  const s0 = String(v);
                  if (s0.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s0)) return null;
                  const bytes = [];
                  for (let i = 0; i < s0.length; i += 2) bytes.push(parseInt(s0.slice(i, i + 2), 16));
                  // HEX と対になるよう UTF-8 として復号する（不正なバイト列は
                  // Latin-1 相当の 1 バイト 1 文字へ落として往復を壊さない）
                  try {
                      if (typeof TextDecoder !== 'undefined') {
                          return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
                      }
                  } catch (e) { /* 不正な UTF-8 は下のフォールバックへ */ }
                  return bytes.map(b => String.fromCharCode(b)).join('');
              };
              const __date_trunc = (unit, v) => {
                  // PostgreSQL 互換の DATE_TRUNC('unit', date)。WEEK は月曜始まり（ISO）
                  if (unit == null || v == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  const u = String(unit).toUpperCase();
                  let y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
                  let h = d.getUTCHours(), mi = d.getUTCMinutes(), se = d.getUTCSeconds();
                  if (u === 'YEAR') { mo = 0; day = 1; h = mi = se = 0; }
                  else if (u === 'QUARTER') { mo = Math.floor(mo / 3) * 3; day = 1; h = mi = se = 0; }
                  else if (u === 'MONTH') { day = 1; h = mi = se = 0; }
                  else if (u === 'WEEK') {
                      const t = new Date(Date.UTC(y, mo, day));
                      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
                      y = t.getUTCFullYear(); mo = t.getUTCMonth(); day = t.getUTCDate();
                      h = mi = se = 0;
                  }
                  else if (u === 'DAY') { h = mi = se = 0; }
                  else if (u === 'HOUR') { mi = se = 0; }
                  else if (u === 'MINUTE') { se = 0; }
                  else if (u !== 'SECOND') {
                      // 単位名が誤りなら NULL を返さず知らせる（PostgreSQL も同様に拒否する）
                      __raise(`Unsupported date unit '${unit}' in DATE_TRUNC. `
                          + `Supported: year, quarter, month, week, day, hour, minute, second.`);
                  }
                  return new Date(Date.UTC(y, mo, day, h, mi, se)).toISOString().replace('T', ' ').slice(0, 19);
              };
              const __typeof = (v) => {
                  if (v === null || v === undefined) return 'null';
                  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'real';
                  if (typeof v === 'boolean') return 'boolean';
                  return 'text';
              };
              const __regexp_count = (s0, pat) => {
                  if (s0 == null || pat == null) return null;
                  if (String(pat).length > 1000) throw new Error("REGEXP pattern too long (max 1000 characters).");
                  try {
                      const re = new RegExp(String(pat), 'g');
                      let cnt = 0, m0;
                      const str = String(s0);
                      while ((m0 = re.exec(str)) !== null) {
                          cnt++;
                          if (m0[0] === '') re.lastIndex++; // 空マッチの無限ループ防止
                      }
                      return cnt;
                  } catch (e) { return null; }
              };
              // シーケンス関数: dbTables.__engine__ 経由でエンジンの採番状態へ到達する
              const __nextval = (dbTables, name) => {
                  const eng = dbTables.__engine__;
                  if (!eng || name == null) return null;
                  return eng._seqNext(String(name));
              };
              const __currval = (dbTables, name) => {
                  const eng = dbTables.__engine__;
                  if (!eng || name == null) return null;
                  return eng._seqCurr(String(name));
              };
              const __setval = (dbTables, name, v) => {
                  const eng = dbTables.__engine__;
                  if (!eng || name == null) return null;
                  return eng._seqSet(String(name), v);
              };

              // --- v1.2: 相関サブクエリ（外側の行の値でサブクエリを実行。値の組み合わせでメモ化） ---
              const __corr_run = (k, ptrs, dbTables, aliases) => {
                  const eng = dbTables.__engine__;
                  const spec = (eng && eng._corrSubs) ? eng._corrSubs[k] : null;
                  if (!spec) throw new Error("Correlated subqueries are not supported in this context.");
                  const vals = spec.refs.map(r => __resolve(r, ptrs, dbTables, aliases));
                  const key = JSON.stringify(vals);
                  let res = spec.cache.get(key);
                  if (res === undefined) {
                      let sql = spec.sql;
                      vals.forEach((v, i2) => {
                          let lit;
                          if (v === null || v === undefined) lit = 'NULL';
                          else if (typeof v === 'number') lit = String(v);
                          else if (typeof v === 'boolean') lit = v ? 'TRUE' : 'FALSE';
                          else {
                              const sv = String(v);
                              let tok = spec.litCache.get(sv);
                              if (tok === undefined) {
                                  spec.strMap.push(eng._quoteLiteral(sv));
                                  tok = '__STR_' + (spec.strMap.length - 1) + '__';
                                  spec.litCache.set(sv, tok);
                              }
                              lit = tok;
                          }
                          sql = sql.split('__OREF_' + i2 + '__').join(lit);
                      });
                      const r = eng.executeQuery(sql, true, spec.strMap);
                      if (r.error) throw new Error('Correlated subquery failed: ' + r.error);
                      const firstKey = r.data.length > 0 ? Object.keys(r.data[0])[0] : null;
                      res = { n: r.data.length, first: firstKey !== null ? r.data.map(row => row[firstKey]) : [] };
                      spec.cache.set(key, res);
                  }
                  return res;
              };
              // 相関 EXISTS のうち「内側が 1 表の等価 1 本だけ」という形は、
              // 値ごとに問い合わせを回さずに済む。
              //
              // __corr_run は相異なる相関値ごとに結果を覚えるが、覚えるだけで
              // 1 回目は内側を実行する。内側の列に索引が無いとそれが毎回の全表走査になり、
              // 相異なり 400 通り × 20 万行で 4.8 秒かかっていた（索引があれば 21ms）。
              //
              // 形が合えば、その列の値の集合を文の中で 1 度だけ作って所属を見る。
              // 集合は「その列に現れる値」そのものなので、EXISTS の答えと一致する
              const __corr_exists_set = (spec, eng, dbTables) => {
                  if (spec.existsSet !== undefined) return spec.existsSet;
                  spec.existsSet = null;                       // 既定は「使えない」
                  if (!spec.refs || spec.refs.length !== 1) return null;
                  // SELECT ... FROM <表> [AS <別名>] WHERE <表|別名>.<列> = __OREF_0__
                  const m = String(spec.sql).match(
                      /^\s*select\s+[\s\S]+?\s+from\s+([a-zA-Z0-9_]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?\s+where\s+(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s*=\s*__OREF_0__\s*$/i);
                  if (!m) return null;
                  const tbl = m[1].toLowerCase(), alias = (m[2] || m[1]).toLowerCase();
                  const qual = m[3] ? m[3].toLowerCase() : null;
                  const col = m[4].toLowerCase();
                  if (qual && qual !== alias && qual !== tbl) return null;
                  const t = dbTables[tbl];
                  if (!t || !t.cols || !t.cols[col]) return null;
                  // 照合順序付きの列は生値の集合では判定できない
                  if (t.collations && t.collations[col]) return null;
                  const set = new Set();
                  if (t.indices && t.indices[col]) {
                      for (const key of t.indices[col].keys()) { if (key !== null && key !== undefined) set.add(key); }
                  } else {
                      for (let i = 0; i < t.rowCount; i++) {
                          const v = t.getValue(col, i);
                          if (v !== null && v !== undefined) set.add(v);
                      }
                  }
                  spec.existsSet = set;
                  return set;
              };
              const __corr_exists = (k, ptrs, dbTables, aliases) => {
                  const eng = dbTables.__engine__;
                  const spec = (eng && eng._corrSubs) ? eng._corrSubs[k] : null;
                  if (spec) {
                      const set = __corr_exists_set(spec, eng, dbTables);
                      if (set) {
                          const v = __resolve(spec.refs[0], ptrs, dbTables, aliases);
                          if (v === null || v === undefined) return false;   // NULL = NULL は真にならない
                          if (set.has(v)) return true;
                          // 比較側は型を寄せるので、寄せた候補も引く（__in と同じ考え方）
                          for (const cand of __eq_probe_values(v)) { if (set.has(cand)) return true; }
                          return false;
                      }
                  }
                  return __corr_run(k, ptrs, dbTables, aliases).n > 0;
              };
              // 相関スカラーサブクエリ。2 行以上返したらエラー（非相関側と同じ規則）。
              // 行評価の catch に飲まれて NULL に化けないよう __fatal を立てて上位へ伝播させる
              const __corr_scalar = (k, ptrs, dbTables, aliases) => {
                  const r = __corr_run(k, ptrs, dbTables, aliases);
                  if (r.n > 1) {
                      const e = new Error(`Subquery returned more than 1 row (${r.n} rows). A scalar subquery must return at most one row — add a WHERE, LIMIT 1, or an aggregate.`);
                      e.__fatal = true;
                      throw e;
                  }
                  return r.n > 0 ? r.first[0] : null;
              };
              // 相関 IN も 3 値論理（v1.24 で素の IN を直したときに、こちらが取り残されていた）。
              // includes は SameValueZero なので NULL 同士が一致し、左辺 NULL で false を返すと
              // `NOT IN` が NULL 行を拾ってしまう
              const __corr_in = (k, lhs, ptrs, dbTables, aliases) => __in(lhs, __corr_run(k, ptrs, dbTables, aliases).first);

              // --- v1.1 追加関数群: メタ情報 ---
              const __uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
                  ? crypto.randomUUID()
                  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
              const __version = () => 'LuminaDB ' + (typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '1.1.0');
              const __database = () => 'lumina';

              // --- v1.8 追加関数群: 商用DB(Oracle / SQL Server / PostgreSQL)で頻用のスカラー関数 ---
              // 条件・NULL処理
              const __decode = (...args) => {
                  // Oracle DECODE(expr, s1, r1, [s2, r2, ...], [default])。NULL 同士も一致とみなす
                  if (args.length < 3) return null;
                  const expr = args[0];
                  let i = 1;
                  for (; i + 1 < args.length; i += 2) {
                      if (expr === args[i] || ((expr === null || expr === undefined) && (args[i] === null || args[i] === undefined))) return args[i + 1];
                  }
                  return i < args.length ? args[i] : null; // 余った末尾1個が既定値
              };
              const __nvl2 = (a, b, c) => (a !== null && a !== undefined) ? b : c;
              const __zeroifnull = (x) => (x === null || x === undefined) ? 0 : x;
              const __nullifzero = (x) => (x !== null && x !== undefined && Number(x) === 0) ? null : x;
              const __choose = (idx, ...vals) => { const i = Math.trunc(Number(idx)); return (i >= 1 && i <= vals.length) ? vals[i - 1] : null; };
              // 文字列
              const __starts_with = (s, p) => (s == null || p == null) ? null : String(s).startsWith(String(p));
              const __ends_with = (s, p) => (s == null || p == null) ? null : String(s).endsWith(String(p));
              const __charindex = (sub, s, start) => {
                  // SQL Server CHARINDEX(substr, str [, start])。1始まり、無ければ0
                  if (sub == null || s == null) return null;
                  const from = start != null ? Math.max(0, Math.trunc(Number(start)) - 1) : 0;
                  return String(s).indexOf(String(sub), from) + 1;
              };
              const __len = (s) => s != null ? String(s).replace(/ +$/, '').length : null; // SQL Server: 末尾空白は数えない
              const __stuff = (s, start, len, ins) => {
                  // SQL Server STUFF: start(1始まり)からlen文字を削除しinsを挿入
                  if (s == null || start == null || len == null) return null;
                  const str = String(s), st = Math.trunc(Number(start)), l = Math.trunc(Number(len));
                  if (st < 1 || st > str.length || l < 0) return null;
                  return str.slice(0, st - 1) + (ins != null ? String(ins) : '') + str.slice(st - 1 + l);
              };
              const __regexp_instr = (s, pat, pos, occ, retOpt, mt) => {
                  if (s == null || pat == null) return null;
                  __regexp_guard(pat);
                  try {
                      const str = String(s);
                      const p = pos == null ? 1 : Math.trunc(Number(pos));
                      if (!isFinite(p) || p < 1) return null;
                      const tail = str.slice(p - 1);
                      const o = occ == null ? 1 : Math.trunc(Number(occ));
                      if (o < 1) return null;
                      const m = __regexp_nth(tail, new RegExp(String(pat), __regexp_flags(mt, '')), o);
                      if (!m) return 0;
                      // return_option 1 は「一致の直後の位置」（MySQL / Oracle）
                      const base = p - 1 + m.index + 1;
                      return (retOpt != null && Math.trunc(Number(retOpt)) === 1) ? base + m[0].length : base;
                  } catch (e) { return null; }
              };
              // 数値
              const __square = (x) => x != null ? __fin(Number(x) * Number(x)) : null;
              const __gcd = (a, b) => {
                  if (a == null || b == null) return null;
                  let x = Math.abs(Math.trunc(Number(a))), y = Math.abs(Math.trunc(Number(b)));
                  while (y) { const t = y; y = x % y; x = t; }
                  return x;
              };
              const __lcm = (a, b) => {
                  if (a == null || b == null) return null;
                  const x = Math.abs(Math.trunc(Number(a))), y = Math.abs(Math.trunc(Number(b)));
                  if (x === 0 || y === 0) return 0;
                  return x / __gcd(x, y) * y;
              };
              const __factorial = (n) => {
                  if (n == null) return null;
                  n = Math.trunc(Number(n));
                  if (n < 0) return null;
                  let r = 1; for (let i = 2; i <= n; i++) r *= i;
                  return r;
              };
              const __width_bucket = (v, lo, hi, cnt) => {
                  // Oracle / PostgreSQL WIDTH_BUCKET。範囲外は 0 または cnt+1
                  if (v == null || lo == null || hi == null || cnt == null) return null;
                  v = Number(v); lo = Number(lo); hi = Number(hi); cnt = Math.trunc(Number(cnt));
                  if (cnt <= 0 || lo === hi) return null;
                  if (lo < hi) {
                      if (v < lo) return 0;
                      if (v >= hi) return cnt + 1;
                      return Math.floor((v - lo) / (hi - lo) * cnt) + 1;
                  }
                  if (v > lo) return 0;
                  if (v <= hi) return cnt + 1;
                  return Math.floor((lo - v) / (lo - hi) * cnt) + 1;
              };
              // 日付（Oracle系）
              const __add_months = (v, n) => {
                  if (v == null || n == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  const day = d.getUTCDate();
                  const r = new Date(d.getTime());
                  r.setUTCDate(1);
                  r.setUTCMonth(r.getUTCMonth() + Math.trunc(Number(n)));
                  const dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
                  r.setUTCDate(Math.min(day, dim)); // 月末を超える日付は月末へ丸める
                  return r.toISOString().replace('T', ' ').slice(0, 19);
              };
              const __months_between = (a, b) => {
                  if (a == null || b == null) return null;
                  const d1 = __date_parse(a), d2 = __date_parse(b);
                  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
                  const months = (d1.getUTCFullYear() - d2.getUTCFullYear()) * 12 + (d1.getUTCMonth() - d2.getUTCMonth());
                  return months + (d1.getUTCDate() - d2.getUTCDate()) / 31; // Oracle は端数を /31
              };
              const __date_part = (unit, v) => {
                  // PostgreSQL DATE_PART('unit', ts)
                  if (unit == null || v == null) return null;
                  const u = String(unit).toUpperCase();
                  if (u === 'DOW') return __dayofweek(v) - 1; // 0=日曜
                  if (u === 'DOY') return __dayofyear(v);
                  if (u === 'EPOCH') return Math.trunc(__date_parse(v).getTime() / 1000);
                  return __extract(u, v);
              };

              // --- v1.9 追加関数群: さらに商用DB(Oracle / SQL Server / PostgreSQL / Snowflake)頻用 ---
              const __quotename = (s, q) => {
                  // SQL Server QUOTENAME。既定は角括弧で囲む。第2引数で区切り文字を指定可
                  if (s == null) return null;
                  const str = String(s);
                  const d = q != null ? String(q) : '[';
                  if (d === '[' || d === ']') return '[' + str.replace(/]/g, ']]') + ']';
                  if (d === '"') return '"' + str.replace(/"/g, '""') + '"';
                  if (d === "'") return "'" + str.replace(/'/g, "''") + "'";
                  if (d === '(' || d === ')') return '(' + str + ')';
                  return d + str + d;
              };
              const __patindex = (pat, s) => {
                  // SQL Server PATINDEX: LIKE パターン(% _ [])の最初の一致位置(1始まり、無ければ0)。
                  // 先頭 % は「任意位置検索」、末尾 % は「末尾以降は任意」を意味するため位置計算から除外する。
                  // 先頭 % が無い場合は文字列先頭にアンカーする。
                  if (pat == null || s == null) return null;
                  let p = String(pat);
                  let anchored = true;
                  if (p.startsWith('%')) { anchored = false; p = p.slice(1); }
                  if (p.endsWith('%')) p = p.slice(0, -1);
                  let re = anchored ? '^' : '';
                  for (let i = 0; i < p.length; i++) {
                      const c = p[i];
                      if (c === '%') re += '[\\s\\S]*';
                      else if (c === '_') re += '[\\s\\S]';
                      else if (c === '[') { let cls = '['; i++; while (i < p.length && p[i] !== ']') { cls += p[i]; i++; } cls += ']'; re += cls; }
                      else re += c.replace(/[.*+?^${}()|\\]/g, '\\$&');
                  }
                  try { const m = String(s).match(new RegExp(re)); return m ? m.index + 1 : 0; } catch (e) { return null; }
              };
              const __bitand = (a, b) => (a == null || b == null) ? null : (Math.trunc(Number(a)) & Math.trunc(Number(b)));
              const __bitor = (a, b) => (a == null || b == null) ? null : (Math.trunc(Number(a)) | Math.trunc(Number(b)));
              const __bitxor = (a, b) => (a == null || b == null) ? null : (Math.trunc(Number(a)) ^ Math.trunc(Number(b)));
              const __bitnot = (a) => (a == null) ? null : (~Math.trunc(Number(a)));
              const __isnumeric = (x) => {
                  // SQL Server ISNUMERIC: 数値変換可能なら1、不可なら0
                  if (x == null) return 0;
                  if (typeof x === 'number') return isFinite(x) ? 1 : 0;
                  if (typeof x === 'boolean') return 1;
                  const s = String(x).trim();
                  return (s !== '' && !isNaN(Number(s))) ? 1 : 0;
              };
              const __eomonth = (v, n) => {
                  // SQL Server EOMONTH(date [, month_offset]): 当月(±offset月)の月末日
                  if (v == null) return null;
                  const base = (n != null) ? __add_months(v, n) : v;
                  if (base == null) return null;
                  return __last_day(base);
              };
              const __make_date = (y, mo, d) => {
                  // PostgreSQL MAKE_DATE(year, month, day)
                  if (y == null || mo == null || d == null) return null;
                  const dt = new Date(Date.UTC(Math.trunc(Number(y)), Math.trunc(Number(mo)) - 1, Math.trunc(Number(d))));
                  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
              };
              const __make_timestamp = (y, mo, d, h, mi, se) => {
                  if (y == null || mo == null || d == null || h == null || mi == null || se == null) return null;
                  const dt = new Date(Date.UTC(Math.trunc(Number(y)), Math.trunc(Number(mo)) - 1, Math.trunc(Number(d)), Math.trunc(Number(h)), Math.trunc(Number(mi)), Math.trunc(Number(se))));
                  return isNaN(dt.getTime()) ? null : dt.toISOString().replace('T', ' ').slice(0, 19);
              };
              const __to_number = (s) => {
                  // Oracle/PostgreSQL TO_NUMBER: 数値へ変換（カンマ区切りは除去）。不可なら null
                  if (s == null) return null;
                  if (typeof s === 'number') return s;
                  const n = Number(String(s).replace(/,/g, '').trim());
                  return isNaN(n) ? null : n;
              };
              const __to_date = (s) => {
                  if (s == null) return null;
                  const d = __date_parse(s);
                  return (d && !isNaN(d.getTime())) ? d.toISOString().slice(0, 10) : null;
              };
              const __to_timestamp = (s) => {
                  if (s == null) return null;
                  // PostgreSQL / Oracle の TO_TIMESTAMP(数値) は **エポック秒**。
                  // 従来は __date_parse がミリ秒として解釈し、2023年が 1970年台になっていた
                  if (typeof s === 'number' && isFinite(s)) {
                      const dn = new Date(Math.round(s * 1000));
                      return isNaN(dn.getTime()) ? null : dn.toISOString().replace('T', ' ').slice(0, 19);
                  }
                  const d = __date_parse(s);
                  return (d && !isNaN(d.getTime())) ? d.toISOString().replace('T', ' ').slice(0, 19) : null;
              };

              // ================================================================
              // v1.11 追加: 商用DB(Oracle / SQL Server / PostgreSQL / DB2)頻用関数
              // ================================================================
              // SQL Server / Oracle の datepart キーワードを内部単位へ正規化する
              const __DATEPART_UNITS = {
                  year: 'YEAR', yyyy: 'YEAR', yy: 'YEAR', ybyy: 'YEAR',
                  quarter: 'QUARTER', qq: 'QUARTER', q: 'QUARTER',
                  month: 'MONTH', mm: 'MONTH', m: 'MONTH',
                  dayofyear: 'DOY', dy: 'DOY', doy: 'DOY',
                  day: 'DAY', dd: 'DAY', d: 'DAY',
                  week: 'WEEK', wk: 'WEEK', ww: 'WEEK', woy: 'WEEK',
                  weekday: 'WEEKDAY', dw: 'WEEKDAY', w: 'WEEKDAY',
                  hour: 'HOUR', hh: 'HOUR',
                  minute: 'MINUTE', mi: 'MINUTE', n: 'MINUTE',
                  second: 'SECOND', ss: 'SECOND', s: 'SECOND'
              };
              const __normDatePart = (u) => {
                  if (u == null) return null;
                  const k = String(u).toLowerCase().trim();
                  return __DATEPART_UNITS[k] || String(u).toUpperCase().trim();
              };
              // DATEADD(datepart, n, date): 指定単位で日付を加算（SQL Server 互換）
              const __dateadd = (unit, n, v) => {
                  if (v == null || n == null) return null;
                  const k = Math.trunc(Number(n));
                  if (isNaN(k)) return null;
                  let u = __normDatePart(unit);
                  if (u === 'DOY' || u === 'WEEKDAY') u = 'DAY';
                  return __add_interval(v, __interval(k, u), 1);
              };
              // DATEPART(datepart, date): 日付の指定部分を数値で返す（SQL Server 互換）
              const __datepart = (unit, v) => {
                  const nu = __normDatePart(unit);
                  if (__EXTRACT_UNITS.indexOf(nu) === -1 && nu !== 'WEEKDAY')
                      __badUnit('DATEPART / DATENAME', unit, Object.keys(__DATEPART_UNITS));
                  if (v == null) return null;
                  switch (nu) {
                      case 'YEAR': return __year(v);
                      case 'QUARTER': return __quarter(v);
                      case 'MONTH': return __month(v);
                      case 'DAY': return __day(v);
                      case 'DOY': return __dayofyear(v);
                      case 'WEEK': return __weekofyear(v);
                      case 'WEEKDAY': return __dayofweek(v);
                      case 'HOUR': return __hour(v);
                      case 'MINUTE': return __minute(v);
                      case 'SECOND': return __second(v);
                      case 'EPOCH': { const d = __date_parse(v); return (!d || isNaN(d.getTime())) ? null : Math.floor(d.getTime() / 1000); }
                      case 'DOW': return __dayofweek(v) - 1;
                      case 'DOY': return __dayofyear(v);
                  }
                  return null;
              };
              // DATENAME(datepart, date): 日付の指定部分を文字列で返す（月名・曜日名は名称）
              const __datename = (unit, v) => {
                  if (v == null) return null;
                  const u = __normDatePart(unit);
                  if (u === 'MONTH') return __monthname(v);
                  if (u === 'WEEKDAY') return __dayname(v);
                  const p = __datepart(unit, v);
                  return p == null ? null : String(p);
              };
              // NEXT_DAY(date, weekday): 指定日より後で最初にその曜日となる日付（Oracle）
              const __next_day = (v, dname) => {
                  if (v == null || dname == null) return null;
                  const d = __date_parse(v);
                  if (isNaN(d.getTime())) return null;
                  const key = String(dname).toLowerCase().trim().slice(0, 3);
                  let target = -1;
                  for (let i = 0; i < __DAY_NAMES.length; i++) {
                      if (__DAY_NAMES[i].toLowerCase().slice(0, 3) === key) target = i;
                  }
                  if (target < 0) return null;
                  let add = (target - d.getUTCDay() + 7) % 7;
                  if (add === 0) add = 7; // 厳密に「より後」
                  return new Date(d.getTime() + add * 86400000).toISOString().slice(0, 10);
              };
              // NANVL(n, alt): n が非数(NaN)なら alt を返す（Oracle）
              const __nanvl = (n, alt) => (typeof n === 'number' && isNaN(n)) ? alt : n;
              // REMAINDER(a, b): IEEE 剰余 a - b*ROUND_HALF_EVEN(a/b)（Oracle）。MOD とは丸め方向が異なる
              const __remainder = (a, b) => {
                  if (a == null || b == null) return null;
                  const x = Number(a), y = Number(b);
                  if (isNaN(x) || isNaN(y) || y === 0) return null;
                  const q = x / y;
                  const fl = Math.floor(q), diff = q - fl;
                  let nq;
                  if (diff < 0.5) nq = fl;
                  else if (diff > 0.5) nq = fl + 1;
                  else nq = (fl % 2 === 0) ? fl : fl + 1;
                  return x - y * nq;
              };
              // SHIFTLEFT / SHIFTRIGHT: 整数のビットシフト
              const __shiftleft = (n, k) => (n == null || k == null) ? null : (Math.trunc(Number(n)) << Math.trunc(Number(k)));
              const __shiftright = (n, k) => (n == null || k == null) ? null : (Math.trunc(Number(n)) >> Math.trunc(Number(k)));
              // TO_HEX(n): 整数を16進文字列へ（PostgreSQL、小文字）
              const __to_hex = (v) => {
                  if (v == null) return null;
                  const n = Math.trunc(Number(v));
                  if (isNaN(n)) return null;
                  return n < 0 ? BigInt.asUintN(64, BigInt(n)).toString(16) : n.toString(16);
              };
              // PARSENAME('a.b.c.d', part): ドット区切り名を右から part 番目(1..4)で取り出す（SQL Server）
              const __parsename = (s, part) => {
                  if (s == null || part == null) return null;
                  const p = Math.trunc(Number(part));
                  if (p < 1 || p > 4) return null;
                  const segs = String(s).split('.');
                  const idx = segs.length - p;
                  return (idx >= 0 && idx < segs.length) ? segs[idx] : null;
              };
              // QUOTE_IDENT / QUOTE_LITERAL: PostgreSQL の識別子・リテラル引用
              const __quote_ident = (s) => s == null ? null : '"' + String(s).replace(/"/g, '""') + '"';
              const __quote_literal = (s) => s == null ? null : "'" + String(s).replace(/'/g, "''") + "'";
              // OVERLAY(str, replacement, start [, length]): start(1始まり)から length 文字を置換（SQL標準）
              const __overlay = (str, repl, start, length) => {
                  if (str == null || repl == null || start == null) return null;
                  const s = String(str), r = String(repl);
                  const st = Math.trunc(Number(start));
                  if (isNaN(st) || st < 1) return null;
                  const len = (length == null) ? r.length : Math.trunc(Number(length));
                  return s.slice(0, st - 1) + r + s.slice(st - 1 + Math.max(0, len));
              };
              // USER / CURRENT_USER / SESSION_USER / SYSTEM_USER: 固定セッションユーザー
              const __sys_user = () => 'lumina';
              // CURRENT_SCHEMA / SCHEMA_NAME: 固定スキーマ名
              const __current_schema = () => 'main';
              // NEWID(): SQL Server 形式の GUID（大文字、ハイフン付き）
              const __newid = () => String(__uuid()).toUpperCase();
              // SYS_GUID(): Oracle 形式の GUID（大文字、ハイフン無しの32桁）
              const __sys_guid = () => String(__uuid()).replace(/-/g, '').toUpperCase();
              // TO_CHAR: 数値/日付を書式文字列で整形（Oracle / PostgreSQL）
              const __to_char_number = (v, fmt) => {
                  let n = Number(v);
                  if (isNaN(n)) return null;
                  let f = String(fmt);
                  const fill = /^FM/i.test(f);
                  if (fill) f = f.slice(2);
                  const hasDollar = f.indexOf('$') !== -1;
                  f = f.replace(/\$/g, '');
                  let intPart = f, fracPart = '';
                  const di = f.search(/[.D]/i);
                  if (di !== -1) { intPart = f.slice(0, di); fracPart = f.slice(di + 1); }
                  const fracDigits = (fracPart.match(/[09]/g) || []).length;
                  const zeroPad = (intPart.match(/0/g) || []).length;
                  const grouping = /[,G]/i.test(intPart);
                  const neg = n < 0;
                  let numStr = Math.abs(n).toFixed(fracDigits);
                  let parts = numStr.split('.');
                  let ip = parts[0], fp = parts[1] || '';
                  if (ip.length < zeroPad) ip = ip.padStart(zeroPad, '0');
                  if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
                  let out = ip + (fracDigits > 0 ? '.' + fp.padEnd(fracDigits, '0') : '');
                  if (hasDollar) out = '$' + out;
                  if (neg) out = '-' + out;
                  return out;
              };
              const __to_char_date = (v, fmt) => {
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  const p2 = (x) => String(x).padStart(2, '0');
                  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth() + 1, D = d.getUTCDate();
                  const H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds();
                  const h12 = (H % 12) || 12;
                  const map = {
                      'YYYY': String(Y), 'YY': String(Y).slice(-2),
                      'MONTH': __MONTH_NAMES[Mo - 1].toUpperCase(),
                      'MON': __MONTH_NAMES[Mo - 1].slice(0, 3).toUpperCase(),
                      'MM': p2(Mo),
                      'DAY': __DAY_NAMES[d.getUTCDay()].toUpperCase(),
                      'DY': __DAY_NAMES[d.getUTCDay()].slice(0, 3).toUpperCase(),
                      'DDD': String(__dayofyear(v)).padStart(3, '0'),
                      'DD': p2(D),
                      'HH24': p2(H), 'HH12': p2(h12), 'HH': p2(h12),
                      'MI': p2(Mi), 'SS': p2(S),
                      'AM': H < 12 ? 'AM' : 'PM', 'PM': H < 12 ? 'AM' : 'PM'
                  };
                  return String(fmt).replace(/YYYY|YY|MONTH|MON|MM|DAY|DY|DDD|DD|HH24|HH12|HH|MI|SS|AM|PM/gi, (t) => {
                      const key = t.toUpperCase();
                      return map[key] !== undefined ? map[key] : t;
                  });
              };
              const __to_char = (v, fmt) => {
                  if (v == null) return null;
                  if (fmt == null) {
                      if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
                      return String(v);
                  }
                  const f = String(fmt);
                  // 数値書式に見える書式（9 0 . , $ G D）でも、値が数値でなければ日付として整形する。
                  // D は小数点、G は桁区切りも表すため 'DD' が丸ごと数値書式と判定され、
                  // TO_CHAR(ts, 'DD') だけが NULL になっていた（'DD-MM' は英字混じりなので通っていた）
                  const numericFmt = /^(FM)?[90.,$GD]+$/i.test(f);
                  const isNum = typeof v === 'number'
                      || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
                  if (numericFmt && isNum) return __to_char_number(v, f);
                  if (/[A-Za-z]/.test(f)) return __to_char_date(v, f);
                  return __to_char_number(v, f);
              };

              // ----------------------------------------------------------------
              // v1.33 追加: 他DBで一般的なのに未実装だったスカラー関数
              // ----------------------------------------------------------------
              // BTRIM(s [, chars]): PostgreSQL。両端から chars に含まれる文字を全て落とす
              // 第2引数を省いたとき（undefined）は空白類を落とす。
              // 明示的に NULL を渡したときは PostgreSQL と同じく結果も NULL
              const __btrim = (s, chars) => {
                  if (s == null || chars === null) return null;
                  const str = String(s);
                  const set = chars === undefined ? ' \t\n\r\f\v' : String(chars);
                  if (set === '') return str;
                  let i = 0, j = str.length;
                  while (i < j && set.indexOf(str[i]) !== -1) i++;
                  while (j > i && set.indexOf(str[j - 1]) !== -1) j--;
                  return str.slice(i, j);
              };
              // ENCODE(s, fmt): PostgreSQL。base64 / hex / escape
              const __encode = (s, fmt) => {
                  if (s == null || fmt == null) return null;
                  const f = String(fmt).trim().toLowerCase();
                  if (f === 'base64') return __to_base64(s);
                  if (f === 'hex') return String(__hex(String(s))).toLowerCase();
                  if (f === 'escape') return String(s);
                  throw new Error(`ENCODE: unsupported format '${fmt}'. Use 'base64', 'hex' or 'escape'.`);
              };
              // ORD(s): MySQL。先頭文字が多バイトなら UTF-8 バイト列を 256 進で畳んだ値
              const __ord = (s) => {
                  if (s == null) return null;
                  const str = String(s);
                  if (str === '') return 0;
                  const bytes = __utf8_bytes(Array.from(str)[0]);
                  let v = 0;
                  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes[i];
                  return v;
              };
              // UNISTR(s): Oracle/DuckDB。\XXXX と \+XXXXXX のエスケープを文字へ戻す
              const __unistr = (s) => {
                  if (s == null) return null;
                  return String(s).replace(/\\(\\|\+[0-9a-fA-F]{6}|[0-9a-fA-F]{4})/g, (m, g) => {
                      if (g === '\\') return '\\';
                      return g[0] === '+'
                          ? String.fromCodePoint(parseInt(g.slice(1), 16))
                          : String.fromCharCode(parseInt(g, 16));
                  });
              };
              // CONTAINS(s, sub): 部分文字列を含むか（SQL Server / Snowflake 系）
              const __contains = (s, sub) => (s == null || sub == null) ? null : String(s).indexOf(String(sub)) !== -1;
              // TIMEDIFF(a, b): MySQL。差を 'HH:MM:SS'（負なら先頭に -、時は 2 桁を超えてよい）
              const __timediff = (a, b) => {
                  if (a == null || b == null) return null;
                  const da = __date_parse(a), db = __date_parse(b);
                  if (!da || !db || isNaN(da.getTime()) || isNaN(db.getTime())) return null;
                  let ms = da.getTime() - db.getTime();
                  const sign = ms < 0 ? '-' : '';
                  ms = Math.abs(ms);
                  const total = Math.floor(ms / 1000);
                  const p2 = (n) => String(n).padStart(2, '0');
                  return sign + p2(Math.floor(total / 3600)) + ':' + p2(Math.floor((total % 3600) / 60)) + ':' + p2(total % 60);
              };
              // YEARWEEK(d): MySQL の既定モード 0。第 0 週は前年の最終週として返す
              const __yearweek = (v) => {
                  if (v == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  const w = __week(v);
                  if (w === null) return null;
                  if (w !== 0) return d.getUTCFullYear() * 100 + w;
                  const y = d.getUTCFullYear() - 1;
                  return y * 100 + __week(y + '-12-31');
              };
              // PERIOD_ADD / PERIOD_DIFF: MySQL。期間は YYMM か YYYYMM の整数
              const __period_norm = (p) => {
                  const n = Math.trunc(Number(p));
                  if (!isFinite(n) || n <= 0) return null;
                  let y = Math.floor(n / 100);
                  const m = n % 100;
                  if (m < 1 || m > 12) return null;
                  if (y < 70) y += 2000; else if (y < 100) y += 1900;
                  return y * 12 + (m - 1);
              };
              const __period_add = (p, n) => {
                  if (p == null || n == null) return null;
                  const base = __period_norm(p);
                  if (base === null) return null;
                  const t = base + Math.trunc(Number(n));
                  const m = ((t % 12) + 12) % 12;
                  return Math.floor(t / 12) * 100 + (m + 1);
              };
              const __period_diff = (a, b) => {
                  if (a == null || b == null) return null;
                  const x = __period_norm(a), y = __period_norm(b);
                  if (x === null || y === null) return null;
                  return x - y;
              };
              // JULIAN_DAY(d): SQLite julianday 相当（1970-01-01 00:00 = 2440587.5）
              const __julian_day = (v) => {
                  if (v == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  return d.getTime() / 86400000 + 2440587.5;
              };
              // JSON_SEARCH(doc, 'one'|'all', pat): 値が LIKE で一致するパスを返す
              const __json_search = (v, mode, needle) => {
                  if (v == null || needle == null) return null;
                  let doc;
                  try { doc = (typeof v === 'object') ? v : JSON.parse(String(v)); } catch (e) { return null; }
                  const m = String(mode == null ? 'one' : mode).trim().toLowerCase();
                  if (m !== 'one' && m !== 'all') throw new Error("JSON_SEARCH: the second argument must be 'one' or 'all'.");
                  const all = m === 'all';
                  const pat = String(needle);
                  const hits = [];
                  const walk = (node, path) => {
                      if (hits.length && !all) return;
                      if (Array.isArray(node)) node.forEach((x, i) => walk(x, path + '[' + i + ']'));
                      else if (node !== null && typeof node === 'object') Object.keys(node).forEach(k => walk(node[k], path + '.' + k));
                      else if (typeof node === 'string' && __like(node, pat) === true) hits.push(path);
                  };
                  walk(doc, '$');
                  if (!hits.length) return null;
                  return all ? JSON.stringify(hits) : JSON.stringify(hits[0]);
              };
              // JSON_MERGE_PRESERVE(a, b, ...): 配列は連結、オブジェクトは同キーを配列へまとめる
              const __json_merge_preserve = (...args) => {
                  if (!args.length) return null;
                  if (args.some(a => a == null)) return null;
                  const parse = (x) => {
                      if (typeof x === 'object') return x;
                      try { return JSON.parse(String(x)); } catch (e) { return String(x); }
                  };
                  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
                  const merge = (a, b) => {
                      if (isObj(a) && isObj(b)) {
                          const out = {};
                          Object.keys(a).forEach(k => { out[k] = a[k]; });
                          Object.keys(b).forEach(k => {
                              out[k] = Object.prototype.hasOwnProperty.call(out, k) ? merge(out[k], b[k]) : b[k];
                          });
                          return out;
                      }
                      const toArr = (x) => Array.isArray(x) ? x.slice() : [x];
                      return toArr(a).concat(toArr(b));
                  };
                  let acc = parse(args[0]);
                  for (let i = 1; i < args.length; i++) acc = merge(acc, parse(args[i]));
                  return JSON.stringify(acc);
              };
              // 配列: 重複除去 / 連結 / 反転
              const __array_key = (x) => (x === null || x === undefined) ? '\0n' : (typeof x) + ':' + String(x);
              const __array_distinct = (a) => {
                  const arr = __toArray(a);
                  if (arr == null) return null;
                  const out = [], seen = {};
                  for (let i = 0; i < arr.length; i++) {
                      const k = __array_key(arr[i]);
                      if (!Object.prototype.hasOwnProperty.call(seen, k)) { seen[k] = 1; out.push(arr[i]); }
                  }
                  return out;
              };
              const __array_cat = (a, b) => {
                  const x = __toArray(a), y = __toArray(b);
                  if (x == null) return y;
                  if (y == null) return x;
                  return x.concat(y);
              };
              const __array_reverse = (a) => {
                  const arr = __toArray(a);
                  return arr == null ? null : arr.slice().reverse();
              };

        return { __btrim, __encode, __ord, __unistr, __contains, __timediff, __yearweek,
                 __period_norm, __period_add, __period_diff, __julian_day, __convert_tz, __tz_minutes,
                 __json_search, __json_merge_preserve, __array_key, __array_distinct, __array_cat, __array_reverse,
                 __op_like, __op_nlike, __op_ilike, __op_nilike,
                 __op_regex, __op_iregex, __op_nregex, __op_niregex,
                 __ilike, __similar, __concat_op, __setseed, __collate, __ft_tokens, __match_against,
                 __overlaps, __date_bin, __age, __is_json, __json_exists, __json_query,
                 __json_insert, __json_replace, __json_array_insert, __json_arrow, __json_arrow_text,
                 __json_hash_arrow, __json_hash_arrow_text, __json_has_key, __json_contains_path, __is_bool, __not3, __and3, __or3, __b3, __nul, __in, __DATEISH, __dnum, __cpair, __num, __add, __sub, __mul, __divf, __modf, __neg, __isnull, __notnull, __eq, __ne, __lt, __le, __gt, __ge,
                 __datecol,
                 __array, __toArray, __array_length, __array_position, __array_contains, __array_append,
                 __subscript, __array_slice,
                 __array_prepend, __array_remove, __array_to_string, __string_to_array, __array_agg_sort,
                 __levenshtein, __similarity, __difference, __regexp_matches, __regexp_split_to_array,
                 __div, __safe_divide, __at_time_zone,
                 __dateadd, __datepart, __datename, __next_day, __nanvl, __remainder, __shiftleft, __shiftright, __to_hex, __parsename, __quote_ident, __quote_literal, __overlay, __sys_user, __current_schema, __newid, __sys_guid, __to_char, __to_char_number, __to_char_date, __normDatePart, __DATEPART_UNITS,
                 __quotename, __patindex, __bitand, __bitor, __bitxor, __bitnot, __isnumeric, __eomonth, __make_date, __make_timestamp, __to_number, __to_date, __to_timestamp,
                 __decode, __nvl2, __zeroifnull, __nullifzero, __choose, __starts_with, __ends_with, __charindex, __len, __stuff, __regexp_instr, __square, __gcd, __lcm, __factorial, __width_bucket, __add_months, __months_between, __date_part, __sha1, __sha2, __sha256, __sha224, __octet_length, __bit_length, __char_length, __unhex, __date_trunc, __typeof, __regexp_count, __nextval, __currval, __setval, __colSuggest, __resolve, __like, __upper, __lower, __length, __round, __coalesce, __substring, __concat, __concat_ws, __substring_index, __locate, __truncate, __regexp, __replace, __trim, __abs, __ceil, __floor, __now, __lpad, __rpad, __power, __sqrt, __date_parse, __year, __month, __day, __hour, __minute, __second, __datediff, __interval, __add_interval, __date_add, __date_sub, __curdate, __dayofweek, __dayofyear, __quarter, __last_day, __ltrim, __rtrim, __ascii, __char, __sin, __cos, __tan, __sinh, __asin, __acos, __atan, __atan2, __degrees, __radians, __ln, __cbrt, __ifnull, __nullif, __is_distinct, __if, __left, __right, __instr, __reverse, __repeat, __greatest, __least, __exp, __log, __log10, __pi, __cast, __mod, __sign, __rand, __date, __log2, __cot, __format, __hex, __bin, __oct, __conv, __space, __strcmp, __elt, __field, __initcap, __MONTH_NAMES, __DAY_NAMES, __monthname, __dayname, __weekday, __week, __weekofyear, __unix_timestamp, __from_unixtime, __date_format, __extract, __timestampdiff, __json_parse, __json_path, __json_get, __json_extract, __json_array, __json_object, __json_length, __json_keys, __json_valid, __json_type, __json_contains_deep, __json_contains, __json_set, __json_remove, __regexp_guard, __regexp_replace, __regexp_substr, __regexp_like, __split_part, __quote, __bit_count, __sec_to_time, __time_to_sec, __makedate, __str_to_date, __time, __trim_dir, __utf8_bytes, __md5, __crc32, __B64_ALPHA, __to_base64, __from_base64, __inet_aton, __inet_ntoa, __soundex, __translate, __str_insert, __cosh, __tanh, __to_days, __from_days, __maketime, __curtime, __format_bytes, __timestampadd, __json_pretty, __json_quote, __json_unquote, __json_depth, __json_array_append, __json_merge_patch, __corr_run, __corr_exists, __corr_scalar, __corr_in, __uuid, __version, __database };
    })();
    // コンパイル済み関数の先頭でヘルパーを一括束縛する分割代入文
    const __EXPR_PRELUDE = 'const { ' + Object.keys(__EXPR_LIB).join(', ') + ' } = __L;';

    // コンパイル済み式の LRU キャッシュ（全エンジンインスタンスで共有。
    // 生成コードはテーブル辞書を引数で受け取るだけなので、インスタンスに依存しない）
    DatabaseEngine._exprCache = new Map();
    DatabaseEngine._exprCacheMax = 500;
    DatabaseEngine._exprCacheStats = { hit: 0, miss: 0 };

    Object.assign(DatabaseEngine.prototype, {

      // 文字列リテラルを __STR_N__ トークンへ退避（strMapへ追記）
      // SQL標準の引用符二重化 ('' / "") も受理し、内部表現はバックスラッシュ
      // エスケープへ正規化する（JSソースへの再挿入時に安全な形式で統一するため）
      _maskStrings(sql, strMap) {
          // 16 進リテラル `X'4869'` / `0x4869` を先に処理する。
          // 従来はこの綴りを知らず、`X'DEADBEEF'` が「X」＋文字列リテラルに割れて
          // **ソーステキストがそのまま列へ入り**（HEX() がその文字列を再符号化して
          // 別の値を返す＝黙って壊れる）、裸の `SELECT X'41'` は
          // "Column 'x__str_0__' not found." になっていた。
          // MySQL と同じく `X'h'` は `UNHEX('h')` と同義に落とす（HEX との往復も成立する）
          sql = sql.replace(/(^|[^a-zA-Z0-9_.$'"])(?:[xX]'([0-9a-fA-F]*)'|0[xX]([0-9a-fA-F]+))(?![0-9a-zA-Z_])/g,
              (m, pre, q1, q2) => {
                  const digits = (q1 !== undefined ? q1 : q2);
                  if (digits.length % 2 !== 0) {
                      throw new Error(`Invalid hex literal: '${digits}' has an odd number of digits.`);
                  }
                  strMap.push(`'${digits}'`);
                  return `${pre}__unhex(__STR_${strMap.length - 1}__)`;
              });
          return sql.replace(/('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")/g, match => {
              const q = match[0];
              const inner = match.slice(1, -1).replace(q === "'" ? /''/g : /""/g, '\\' + q);
              strMap.push(q + inner + q);
              return `__STR_${strMap.length - 1}__`;
          });
      },

      // 退避済みリテラル（引用符付き・バックスラッシュエスケープ）から生の文字列値を取り出す
      _unquoteLiteral(lit) {
          return lit.slice(1, -1).replace(/\\(['"\\])/g, '$1');
      },

      // 生の文字列値を、パーサが安全に受理できる引用符付きリテラルへ変換する
      _quoteLiteral(v) {
          return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      },

      // __STR_N__ トークンを元の文字列リテラルへ復元
      _restoreStrings(sql, strMap) {
          if (!strMap) return sql;
          return sql.replace(/__STR_(\d+)__/g, (m, i) => strMap[Number(i)] !== undefined ? strMap[Number(i)] : m);
      },

      // ユーザー定義スカラー関数 (CREATE FUNCTION) をコンパイル前に本体へ展開する。
      // 実行時ディスパッチではなく「呼び出し箇所への式の埋め込み」なので、
      // 行評価コストは組み込み関数と変わらない。再帰は深度制限で遮断する。
      _inlineUserFunctions(s, strMap, depth) {
          const fns = this.functions;
          if (!fns) return s;
          const names = Object.keys(fns);
          if (names.length === 0 || !/[a-zA-Z_]/.test(s)) return s;
          if ((depth || 0) > 8) throw new Error('User-defined function nesting depth limit (8) exceeded.');
          const re = new RegExp('\\b(' + names.map(n => n.replace(/[^a-zA-Z0-9_]/g, '')).join('|') + ')\\s*\\(', 'gi');
          let out = '', last = 0, m, found = false;
          re.lastIndex = 0;
          while ((m = re.exec(s))) {
              const name = m[1].toLowerCase();
              const fn = fns[name];
              if (!fn) continue;
              // 直前が識別子文字なら別名の一部（my_add2( 等）なので触らない
              const prev = m.index > 0 ? s[m.index - 1] : '';
              if (/[a-zA-Z0-9_.]/.test(prev)) continue;
              const open = m.index + m[0].length - 1;
              const close = this._scanBalanced(s, open);
              if (close === -1) throw new Error(`Syntax Error in call to function '${name}'.`);
              const argStr = s.slice(open + 1, close).trim();
              const args = argStr === '' ? [] : this.splitSelectClause(argStr);
              if (args.length !== fn.params.length) {
                  throw new Error(`Function '${name}' expects ${fn.params.length} argument(s), got ${args.length}.`);
              }
              // 本体の文字列リテラルを退避してから仮引数を実引数へ置換する
              let body = this._maskStrings(fn.body, strMap);
              fn.params.forEach((p, i) => {
                  body = body.replace(new RegExp('\\b' + p + '\\b', 'gi'), () => `(${args[i]})`);
              });
              out += s.slice(last, m.index) + '(' + body + ')';
              last = close + 1;
              re.lastIndex = last;
              found = true;
          }
          if (!found) return s;
          out += s.slice(last);
          return this._inlineUserFunctions(out, strMap, (depth || 0) + 1);
      },

      // '::' / COLLATE のように「直前の 1 単位」を被演算子に取る後置演算子の共通処理。
      // 位置 at の直前を後方走査して被演算子の開始位置を返す（括弧・関数呼び出しも 1 単位）
      _operandStartBefore(s, at, what) {
          let i = at - 1;
          while (i >= 0 && /\s/.test(s[i])) i--;
          if (i < 0) throw new Error(`Syntax Error near '${what}'.`);
          if (s[i] === ')') {
              let d = 0, j = i;
              for (; j >= 0; j--) {
                  if (s[j] === ')') d++;
                  else if (s[j] === '(') { d--; if (d === 0) break; }
              }
              if (j < 0) throw new Error(`Syntax Error near '${what}': unbalanced parentheses.`);
              let k = j - 1;
              while (k >= 0 && /[a-zA-Z0-9_.]/.test(s[k])) k--;
              return { start: k + 1, end: i };
          }
          let k = i;
          while (k >= 0 && /[a-zA-Z0-9_.]/.test(s[k])) k--;
          if (k === i) throw new Error(`Syntax Error near '${what}'.`);
          if (k >= 0 && s[k] === '-' && (k === 0 || !/[a-zA-Z0-9_.)]/.test(s[k - 1]))) k--;
          return { start: k + 1, end: i };
      },

      // JSON アクセス演算子を関数呼び出しへ畳む（PostgreSQL / MySQL 共通の書き方）。
      //   j -> 'a'    要素を JSON のまま      j ->> 'a'   要素をテキストで
      //   j #> '{a,b}' パス配列で JSON       j #>> '{a,b}' パス配列でテキスト
      //   a @> b      a が b を含む          a <@ b      a が b に含まれる
      // 左辺は _operandStartBefore で後方走査、右辺は前方の1プライマリだけを取る。
      // これにより比較演算子より強く結合し（`j->>'a' = 'x'` が正しく割れる）、
      // `j->'a'->>'b'` の連鎖も左から順に畳める
      _JSON_OPS: [
          ['#>>', '__json_hash_arrow_text'],
          ['#>', '__json_hash_arrow'],
          ['->>', '__json_arrow_text'],
          ['->', '__json_arrow'],
          ['@>', '__json_contains_op'],
          ['<@', '__json_contained_op']
      ],

      // PostgreSQL の照合演算子。~ 系は正規表現、~~ 系は LIKE の別綴り。
      // 長い綴りを先に並べる（'!~~*' が '!~' で切れないように）
      _MATCH_OPS: [
          ['!~~*', '__op_nilike'],
          ['!~~', '__op_nlike'],
          ['~~*', '__op_ilike'],
          ['~~', '__op_like'],
          ['!~*', '__op_niregex'],
          ['!~', '__op_nregex'],
          ['~*', '__op_iregex'],
          ['~', '__op_regex']
      ],

      // <left> <op> <right> を関数呼び出しへ畳む（左は後方走査、右は 1 プライマリ）
      _rewriteMatchOps(s) {
          if (s.indexOf('~') === -1) return s;
          for (let guard = 0; guard < 128; guard++) {
              let best = -1, op = null, fn = null;
              for (const [sym, f] of this._MATCH_OPS) {
                  const at = s.indexOf(sym);
                  if (at === -1) continue;
                  if (best === -1 || at < best || (at === best && sym.length > op.length)) { best = at; op = sym; fn = f; }
              }
              if (best === -1) return s;
              const { start, end } = this._operandStartBefore(s, best, op);
              const right = this._primaryAfter(s, best + op.length, op);
              s = s.slice(0, start) + `${fn}(${s.slice(start, end + 1)}, ${s.slice(right.start, right.end + 1)})` + s.slice(right.end + 1);
          }
          return s;
      },

      _rewriteJsonOps(s) {
          if (!/->|#>|@>|<@/.test(s)) return s;
          for (let guard = 0; guard < 128; guard++) {
              // 最も左に現れる演算子を選ぶ（同位置なら長い綴りを優先）
              let best = -1, op = null, fn = null;
              for (const [sym, f] of this._JSON_OPS) {
                  const at = s.indexOf(sym);
                  if (at === -1) continue;
                  if (best === -1 || at < best || (at === best && sym.length > op.length)) { best = at; op = sym; fn = f; }
              }
              if (best === -1) return s;
              const { start, end } = this._operandStartBefore(s, best, op);
              const right = this._primaryAfter(s, best + op.length, op);
              const args = `${s.slice(start, end + 1)}, ${s.slice(right.start, right.end + 1)}`;
              // @> / <@ は __json_contains の引数順（対象, 候補）に合わせる
              let rep;
              if (fn === '__json_contains_op') rep = `(__json_contains(${args}) === 1)`;
              else if (fn === '__json_contained_op') rep = `(__json_contains(${s.slice(right.start, right.end + 1)}, ${s.slice(start, end + 1)}) === 1)`;
              else rep = `${fn}(${args})`;
              s = s.slice(0, start) + rep + s.slice(right.end + 1);
          }
          return s;
      },

      // 位置 at 以降の「1プライマリ」（括弧グループ / 関数呼び出し / 識別子 / トークン / 数値）
      // の範囲を返す。_operandStartBefore の前方版
      _primaryAfter(s, at, what) {
          let i = at;
          while (i < s.length && /\s/.test(s[i])) i++;
          if (i >= s.length) throw new Error(`Syntax Error near '${what}': missing right operand.`);
          const start = i;
          if (s[i] === '-' || s[i] === '+') i++;
          if (s[i] === '(') {
              let d = 0;
              for (; i < s.length; i++) {
                  if (s[i] === '(') d++;
                  else if (s[i] === ')') { d--; if (d === 0) return { start, end: i }; }
              }
              throw new Error(`Syntax Error near '${what}': unbalanced parentheses.`);
          }
          let j = i;
          while (j < s.length && /[a-zA-Z0-9_.$]/.test(s[j])) j++;
          if (j === i) throw new Error(`Syntax Error near '${what}': missing right operand.`);
          // 関数呼び出しなら引数の括弧まで取り込む
          let k = j;
          while (k < s.length && /\s/.test(s[k])) k++;
          if (s[k] === '(') {
              let d = 0;
              for (let m = k; m < s.length; m++) {
                  if (s[m] === '(') d++;
                  else if (s[m] === ')') { d--; if (d === 0) return { start, end: m }; }
              }
              throw new Error(`Syntax Error near '${what}': unbalanced parentheses.`);
          }
          return { start, end: j - 1 };
      },

      // MySQL の中置整数除算 `a DIV b` を __div(a, b) へ畳む。
      // 左辺は後方走査、右辺は前方の1プライマリ（`7 DIV 2 DIV 2` の連鎖も左から畳める）
      _rewriteDivOp(s) {
          if (!/\bDIV\b/i.test(s)) return s;
          let from = 0;
          for (let guard = 0; guard < 64; guard++) {
              const rel = s.slice(from).match(/\bDIV\b/i);
              if (!rel) return s;
              const at = from + rel.index;
              // 直前が識別子文字なら関数名の一部（既に __div( へ畳まれた形）なので飛ばす
              if (at > 0 && /[a-zA-Z0-9_]/.test(s[at - 1])) { from = at + 3; continue; }
              if (/^\s*\(/.test(s.slice(at + 3))) { from = at + 3; continue; }
              const { start, end } = this._operandStartBefore(s, at, 'DIV');
              const right = this._primaryAfter(s, at + 3, 'DIV');
              const rep = `__div(${s.slice(start, end + 1)}, ${s.slice(right.start, right.end + 1)})`;
              s = s.slice(0, start) + rep + s.slice(right.end + 1);
              from = start + rep.length;
          }
          return s;
      },

      // <expr> IS [NOT] TRUE|FALSE を __is_bool(expr, want, negate) へ書き換える。
      // 左辺は `(sal > 150)` のような括弧式が主なので、正規表現で切るのではなく
      // _operandStartBefore で対応括弧まで後方走査する（入れ子の深さに依存しない）
      _rewriteIsBool(s) {
          if (!/\bIS\s+(?:NOT\s+)?(?:TRUE|FALSE)\b/i.test(s)) return s;
          let from = 0;
          for (let guard = 0; guard < 128; guard++) {
              const rel = s.slice(from).match(/\bIS\s+(NOT\s+)?(TRUE|FALSE)\b/i);
              if (!rel) return s;
              const at = from + rel.index;
              const { start, end } = this._operandStartBefore(s, at, 'IS TRUE/FALSE');
              const want = rel[2].toUpperCase() === 'TRUE' ? 'true' : 'false';
              const neg = rel[1] ? 'true' : 'false';
              const rep = `__is_bool(${s.slice(start, end + 1)}, ${want}, ${neg})`;
              s = s.slice(0, start) + rep + s.slice(at + rel[0].length);
              from = start + rep.length;
          }
          return s;
      },

      _COLLATIONS: new Set(['NOCASE', 'CI', 'BINARY', 'CS', 'NOACCENT', 'AI', 'NUMERIC', 'NATURAL']),

      // 照合順序を適用した比較用の値を返す（コンパイル済み式の外——並べ替え・
      // グループ化・DISTINCT・一意性検査——から使う。中身は __collate と同じ規則）
      _collateValue(v, name) {
          if (v === null || v === undefined) return v;
          const c = String(name || '').toUpperCase();
          const s = String(v);
          if (!c || c === 'BINARY' || c === 'CS') return s;
          if (c === 'NOACCENT' || c === 'AI') return s.normalize('NFD').replace(/[̀-゙ͯ-゜]/g, '');
          if (c === 'NUMERIC' || c === 'NATURAL') return s.replace(/\d+/g, (d) => d.padStart(20, '0'));
          if (c === 'NOCASE' || c === 'CI') return s.toLowerCase();
          throw new Error(`Unknown collation '${name}'. Use NOCASE / BINARY / NOACCENT / NUMERIC.`);
      },

      // 式テキストが「照合順序付きの実列そのもの」を指していれば照合名を返す。
      // 関数呼び出しや演算を含む式は対象外（値が列そのものではないため）
      _collationOfExpr(text, aliases) {
          if (!text) return null;
          const m = String(text).trim().match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
          if (!m) return null;
          const qual = m[1] ? m[1].toLowerCase() : null;
          const col = m[2].toLowerCase();
          let found = null;
          for (const a in aliases) {
              if (qual && a.toLowerCase() !== qual) continue;
              const t = this.tables[aliases[a]];
              if (!t || !t.collations || !t.collations[col]) continue;
              if (found && found !== t.collations[col]) return null; // 曖昧
              found = t.collations[col];
          }
          return found;
      },

      // 列に照合順序が指定されている場合、その列への参照へ暗黙の COLLATE を挿す。
      // 既存の `_rewriteCollate` が比較の右辺にも同じ照合を伝播させるので、
      // `WHERE nm = 'APPLE'` が NOCASE 列で正しく一致するようになる。
      // aliases: { 別名 -> 実表名 }。SELECT 句ではなく条件・並べ替え・グループ化に使う
      // 修飾なしの列名が、いま見えている 2 つ以上の表に存在していたら拒否する。
      //
      // __resolve は `for (let alias in pts)` の**最初に見つかった表**を採って break する。
      // つまり `SELECT SUM(amount) FROM orders o JOIN payments p ON ...` は、どちらの
      // amount を足したのか書き手に判らないまま o.amount の合計を返していた。実DB
      // （MySQL 1052 / PostgreSQL / SQLite）はいずれも「曖昧」として拒否する。
      //
      // __resolve は行ごとに走るホットパスなので、そこでは検査しない。別名 -> 実表の
      // 対応が判っているコンパイル時に 1 度だけ見る。表が 1 つだけの問い合わせは
      // そもそも曖昧になり得ないので即 return する（既存の大多数のクエリは無コスト）
      // ignoreNames: SELECT の出力名（別名）。HAVING / ORDER BY / QUALIFY はこれらでも
      // 解決できるので、同名の基底列が複数あっても曖昧ではない
      _assertNoAmbiguousColumns(text, aliases, ignoreNames) {
          if (!text || !aliases) return text;
          // 別名と実表名の両方がキーとして入っているので、実表名の集合で数える
          const tableSet = new Set();
          for (const a in aliases) if (aliases[a]) tableSet.add(String(aliases[a]).toLowerCase());
          if (tableSet.size < 2) return text;

          // 列名 -> それを持つ表名の一覧
          const owners = Object.create(null);
          for (const tn of tableSet) {
              const t = this.tables[tn];
              if (!t || !t.cols) continue;
              for (const c in t.cols) {
                  if (!owners[c]) owners[c] = [];
                  if (!owners[c].includes(tn)) owners[c].push(tn);
              }
          }

          const sm = [];
          const s = this._maskStrings(text, sm);
          // 修飾子つき (`a.col`)、関数呼び出し (`f(`)、内部トークンは対象外
          const re = /\b([a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?/g;
          let m;
          while ((m = re.exec(s))) {
              if (m[1] || m[3]) continue;                       // 修飾済み / 関数呼び出し
              const name = m[2];
              if (name.startsWith('__')) continue;              // 内部トークン
              const lc = name.toLowerCase();
              if (ignoreNames && ignoreNames.has(lc)) continue; // SELECT の出力名
              const own = owners[lc];
              if (!own || own.length < 2) continue;
              throw new Error(`Column '${name}' is ambiguous: it exists in ${own.join(' and ')}. Qualify it with a table name or alias.`);
          }
          return text;
      },

      // 条件式を「深さ 0 の AND」で分割する（述語の押し下げ用）。
      // OR が深さ 0 に 1 つでもあれば分割しない（`a AND b OR c` は
      // `a` だけを先に適用すると結果が変わるため）。文字列は退避してから見る
      _splitTopLevelAnd(text) {
          if (!text) return [];
          const sm = [];
          const s = this._maskStrings(text, sm);
          const parts = [];
          let depth = 0, last = 0;
          const isWordBoundary = (i, len) => {
              const before = i === 0 ? ' ' : s[i - 1];
              const after = i + len >= s.length ? ' ' : s[i + len];
              return !/[a-zA-Z0-9_]/.test(before) && !/[a-zA-Z0-9_]/.test(after);
          };
          // BETWEEN a AND b の AND は「述語の区切り」ではない。数えずに割ると
          // `d BETWEEN '2021-01-01'` と `'2022-12-31'` という壊れた断片になり、
          // 押し下げ先が分かれた瞬間に「Malformed expression」で落ちていた
          let pendingBetween = 0;
          for (let i = 0; i < s.length; i++) {
              const ch = s[i];
              if (ch === '(' || ch === '[') depth++;
              else if (ch === ')' || ch === ']') depth--;
              else if (depth === 0) {
                  const rest = s.slice(i, i + 3).toLowerCase();
                  if (rest === 'or ' && isWordBoundary(i, 2)) return [];   // 深さ0の OR があれば分割しない
                  if (s.slice(i, i + 7).toLowerCase() === 'between' && isWordBoundary(i, 7)) {
                      pendingBetween++;
                      i += 6;
                      continue;
                  }
                  if (s.slice(i, i + 3).toLowerCase() === 'and' && isWordBoundary(i, 3)) {
                      if (pendingBetween > 0) { pendingBetween--; i += 2; continue; }
                      parts.push(s.slice(last, i));
                      last = i + 3;
                      i += 2;
                  }
              }
          }
          parts.push(s.slice(last));
          return parts.map(p => this._restoreStrings(p, sm).trim()).filter(p => p !== '');
      },

      _applyColumnCollations(text, aliases) {
          if (!text) return text;
          // 対象になる列名 -> 照合名（複数表で衝突する列名は曖昧なので対象外にする）
          const map = Object.create(null);
          const ambiguous = new Set();
          for (const a in aliases) {
              const t = this.tables[aliases[a]];
              if (!t || !t.collations) continue;
              for (const c in t.collations) {
                  if (map[c] !== undefined && map[c] !== t.collations[c]) ambiguous.add(c);
                  map[c] = t.collations[c];
              }
          }
          if (Object.keys(map).length === 0) return text;
          const sm = [];
          let s = this._maskStrings(text, sm);
          // 既に COLLATE が書かれている参照は触らない（明示指定を優先する）
          s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?(\s+collate\b)?/gi,
              (m, qual, name, call, already) => {
                  if (call || already) return m;
                  const lc = name.toLowerCase();
                  if (!map[lc] || ambiguous.has(lc)) return m;
                  return `${m} COLLATE ${map[lc]}`;
              });
          return this._restoreStrings(s, sm);
      },

      // 配列・JSON 配列・文字列の添字とスライス（PostgreSQL 互換の 1 始まり）。
      //   a[2]     2 番目の要素        a[2:3]  2〜3 番目（両端を含む）
      //   a[:2]    先頭から 2 番目まで  a[2:]   2 番目から末尾まで
      // 生の JS 添字（0 始まり）が漏れないよう、必ず関数呼び出しへ畳む
      _rewriteSubscripts(s) {
          if (s.indexOf('[') === -1) return s;
          for (let guard = 0; guard < 128; guard++) {
              const at = s.indexOf('[');
              if (at === -1) break;
              // 直前が被演算子でない '[' は書き換えようがないので構文エラーにする
              const prev = s.slice(0, at).replace(/\s+$/, '').slice(-1);
              if (!/[a-zA-Z0-9_.)\]]/.test(prev)) {
                  throw new Error("Syntax Error near '[': a subscript must follow an array, JSON or string value.");
              }
              let depth = 0, close = -1;
              for (let i = at; i < s.length; i++) {
                  if (s[i] === '[') depth++;
                  else if (s[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
              }
              if (close === -1) throw new Error("Syntax Error in subscript: missing ']'.");
              const inner = s.slice(at + 1, close);
              const { start, end } = this._operandStartBefore(s, at, '[');
              const operand = s.slice(start, end + 1);
              // ':' で分けるとスライス。括弧の外側にあるものだけを区切りとみなす
              let cut = -1, d = 0;
              for (let i = 0; i < inner.length; i++) {
                  const ch = inner[i];
                  if (ch === '(' || ch === '[') d++;
                  else if (ch === ')' || ch === ']') d--;
                  else if (ch === ':' && d === 0) { cut = i; break; }
              }
              let call;
              if (cut === -1) {
                  if (inner.trim() === '') throw new Error("Syntax Error: empty subscript '[]'.");
                  call = `__subscript(${operand}, ${inner})`;
              } else {
                  const lo = inner.slice(0, cut).trim() || 'null';
                  const hi = inner.slice(cut + 1).trim() || 'null';
                  call = `__array_slice(${operand}, ${lo}, ${hi})`;
              }
              s = s.slice(0, start) + call + s.slice(close + 1);
          }
          return s;
      },

      // <expr> COLLATE <name> を __collate(expr, 'NAME') へ（比較・ORDER BY 用の正規化）。
      // 比較演算子が続く場合は右辺にも同じ照合を適用する（SQL の COLLATE は比較全体に効くため。
      // これがないと `col COLLATE NOCASE = 'ABC'` が左辺だけ小文字化されて必ず偽になる）
      _rewriteCollate(s) {
          if (!/\bCOLLATE\b/i.test(s)) return s;
          let from = 0;
          for (let guard = 0; guard < 64; guard++) {
              const rel = s.slice(from).match(/\bCOLLATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
              if (!rel) return s;
              const at = from + rel.index;
              const coll = rel[1].toUpperCase();
              if (!this._COLLATIONS.has(coll)) {
                  throw new Error(`Unknown collation '${rel[1]}'. Use NOCASE / BINARY / NOACCENT / NUMERIC.`);
              }
              const { start, end } = this._operandStartBefore(s, at, 'COLLATE');
              const left = `__collate(${s.slice(start, end + 1)}, '${coll}')`;
              let tail = s.slice(at + rel[0].length);
              // 直後が比較演算子なら、その右辺にも同じ照合を掛ける（右辺が自前の COLLATE を
              // 持つ場合はそちらを優先してここでは触らない）
              const opM = tail.match(/^(\s*(?:<=|>=|<>|!=|=|<|>)\s*)/);
              if (opM) {
                  const rest = tail.slice(opM[0].length);
                  const om = rest.match(/^(\([^()]*\)|[a-zA-Z_][a-zA-Z0-9_.]*\s*\((?:[^()]|\([^()]*\))*\)|__STR_\d+__|-?[a-zA-Z0-9_.]+)/);
                  if (om && !/^\s*COLLATE\b/i.test(rest.slice(om[0].length))) {
                      tail = opM[0] + `__collate(${om[1]}, '${coll}')` + rest.slice(om[0].length);
                  }
              } else {
                  // IN (...) / BETWEEN a AND b も比較なので、右辺の各項にも同じ照合を掛ける
                  const inM = tail.match(/^(\s*(?:not\s+)?in\s*)\(([^()]*)\)/i);
                  const btM = inM ? null : tail.match(/^(\s*(?:not\s+)?between\s+)(__STR_\d+__|-?[a-zA-Z0-9_.]+)(\s+and\s+)(__STR_\d+__|-?[a-zA-Z0-9_.]+)/i);
                  if (inM) {
                      const items = this.splitSelectClause(inM[2]).map(x => `__collate(${x.trim()}, '${coll}')`);
                      tail = inM[1] + '(' + items.join(', ') + ')' + tail.slice(inM[0].length);
                  } else if (btM) {
                      tail = btM[1] + `__collate(${btM[2]}, '${coll}')` + btM[3]
                           + `__collate(${btM[4]}, '${coll}')` + tail.slice(btM[0].length);
                  }
              }
              s = s.slice(0, start) + left + tail;
              from = start + left.length;
          }
          return s;
      },

      // 日付 ± INTERVAL の算術。INTERVAL は既に __interval(n, 'UNIT') へ畳まれているので、
      // その直前/直後の '+' '-' を見て __date_add / __date_sub の呼び出しへ組み替える。
      // （素の '+' だとオブジェクトが文字列連結され '...[object Object]' になっていた）
      _rewriteIntervalMath(s) {
          if (s.indexOf('__interval(') === -1) return s;
          // 演算子と結び付かない裸の INTERVAL（DATE_ADD の第2引数など）は飛ばして次を探す
          let from = 0;
          for (let guard = 0; guard < 64; guard++) {
              const at = s.indexOf('__interval(', from);
              if (at === -1) return s;
              const close = this._scanBalanced(s, s.indexOf('(', at));
              if (close === -1) throw new Error("Syntax Error in INTERVAL.");
              const iv = s.slice(at, close + 1);
              // 左側に演算子があるか（date + INTERVAL ... / date - INTERVAL ...）
              let p = at - 1;
              while (p >= 0 && /\s/.test(s[p])) p--;
              if (p >= 0 && (s[p] === '+' || s[p] === '-')) {
                  const sign = s[p];
                  const { start, end } = this._operandStartBefore(s, p, 'INTERVAL');
                  const left = s.slice(start, end + 1);
                  const fn = sign === '+' ? '__date_add' : '__date_sub';
                  s = s.slice(0, start) + `${fn}(${left}, ${iv})` + s.slice(close + 1);
                  from = start;
                  continue;
              }
              // 右側の場合 (INTERVAL ... + date)。加算のみ意味を持つ
              const tail = s.slice(close + 1);
              const rm = tail.match(/^\s*\+\s*/);
              if (rm) {
                  const rest = tail.slice(rm[0].length);
                  const om = rest.match(/^(\([^()]*\)|[a-zA-Z_][a-zA-Z0-9_.]*\s*\((?:[^()]|\([^()]*\))*\)|__STR_\d+__|[a-zA-Z0-9_.]+)/);
                  if (om) {
                      s = s.slice(0, at) + `__date_add(${om[1]}, ${iv})` + rest.slice(om[0].length);
                      from = at;
                      continue;
                  }
              }
              from = close + 1;
          }
          return s;
      },

      // 「結果が日付になる」ことがコンパイル時に判る呼び出し。この直後・直前の
      // '+' / '-' は文字列連結ではなく日付演算として畳む（_rewriteDateArith が使う）
      _DATE_PRODUCERS: ['__datecol', '__curdate', '__now', '__sysdate', '__to_date', '__to_timestamp',
          '__date_add', '__date_sub', '__date_trunc', '__date_bin', '__make_date', '__make_timestamp',
          '__last_day', '__eomonth', '__add_months', '__next_day', '__dateadd', '__from_unixtime', '__from_days',
          // DATE(x) / STR_TO_DATE / MAKEDATE も日付を返す。ここに無いと DATE(x) + 1 が
          // 文字列と数値の加算になり、v1.25 の NULL 伝播で黙って NULL に落ちていた
          '__date', '__str_to_date', '__makedate'],

      // 日付が絡む '+' / '-' を日付演算へ畳む。
      //   date + n / n + date -> __date_add(date, n)     n 日後
      //   date - n           -> __date_sub(date, n)      n 日前
      //   date - date        -> __datediff(date, date)   日数差（SQL標準 / PostgreSQL）
      // これが無いと JS の '+' に落ちて `DATE '2026-01-01' + 1` が
      // '2026-01-01 00:00:001' という文字列連結になり、日付差は NULL になっていた。
      // INTERVAL 版（_rewriteIntervalMath）の後に走らせること
      _rewriteDateArith(s) {
          // CAST(x AS DATE) 由来のものも日付として扱う
          const isDateAt = (txt, i) => {
              for (const p of this._DATE_PRODUCERS) {
                  if (txt.startsWith(p + '(', i)) return p.length;
              }
              if (txt.startsWith('__cast(', i)) {
                  const close = this._scanBalanced(txt, i + 6);
                  // __cast(x, 'DATE') と __cast(x, 'DATE', null, null) の両形
                  if (close !== -1 && /,\s*'(?:DATEONLY|DATE|DATETIME|TIMESTAMP)'\s*(?:,[^()]*)?\)$/i.test(txt.slice(i, close + 1))) return 6;
              }
              return 0;
          };
          const producerEnd = (txt, i) => {
              const nameLen = isDateAt(txt, i);
              if (!nameLen) return -1;
              const close = this._scanBalanced(txt, i + nameLen);
              return close;
          };
          for (let guard = 0; guard < 128; guard++) {
              let done = true;
              for (let i = 0; i < s.length; i++) {
                  if (s[i] !== '_') continue;
                  // 識別子の途中（__date_add の中の文字など）を拾わない
                  if (i > 0 && /[a-zA-Z0-9_.$]/.test(s[i - 1])) continue;
                  const end = producerEnd(s, i);
                  if (end === -1) continue;
                  let p = end + 1;
                  while (p < s.length && /\s/.test(s[p])) p++;
                  if (s[p] === '+' || s[p] === '-') {
                      // '+=' のような複合や '->' は対象外（この段階では既に畳まれているが念のため）
                      if (s[p + 1] === '=' || s[p + 1] === '>' || s[p + 1] === s[p]) continue;
                      const sign = s[p];
                      const right = this._primaryAfter(s, p + 1, sign);
                      const rhs = s.slice(right.start, right.end + 1);
                      const lhs = s.slice(i, end + 1);
                      const rhsIsDate = producerEnd(rhs, 0) === rhs.length - 1;
                      const call = (sign === '-' && rhsIsDate)
                          ? `__datediff(${lhs}, ${rhs})`
                          : `${sign === '+' ? '__date_add' : '__date_sub'}(${lhs}, ${rhs})`;
                      s = s.slice(0, i) + call + s.slice(right.end + 1);
                      done = false;
                      break;
                  }
                  // n + date（加算のみ意味を持つ。減算は「数値 - 日付」で無意味）
                  let q = i - 1;
                  while (q >= 0 && /\s/.test(s[q])) q--;
                  if (q >= 0 && s[q] === '+' && s[q - 1] !== '+') {
                      const { start } = this._operandStartBefore(s, q, '+');
                      const left = s.slice(start, q).trim();
                      // 左が日付ならそちら側の走査で畳まれるのでここでは触らない
                      if (left !== '' && producerEnd(left, 0) !== left.length - 1) {
                          s = s.slice(0, start) + `__date_add(${s.slice(i, end + 1)}, ${left})` + s.slice(end + 1);
                          done = false;
                          break;
                      }
                  }
              }
              if (done) break;
          }
          return s;
      },

      // 日付型の列への参照を __datecol(...) で包み、'+' / '-' を日付演算として
      // 畳めるようにする（__datecol 自体は値をそのまま返す目印）。
      // aliases が判る呼び出し元（_executeSelectPlan）から句ごとに適用する
      _applyDateColumns(text, aliases) {
          if (!text) return text;
          if (text.indexOf('+') === -1 && text.indexOf('-') === -1) return text;
          const dateCols = new Set();
          for (const a in aliases) {
              const t = this.tables[aliases[a]];
              if (!t || !t.colTypes) continue;
              for (const c in t.colTypes) if (t.colTypes[c] === 'DATE') dateCols.add(c);
          }
          if (dateCols.size === 0) return text;
          const sm = [];
          let s = this._maskStrings(text, sm);
          s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\()?/g,
              (m, qual, name, call) => (call || !dateCols.has(name.toLowerCase())) ? m : `__datecol(${m})`);
          // MAX/MIN は引数の型をそのまま返すので、日付列に対する結果も日付として扱う
          s = s.replace(/\b(?:MAX|MIN)\s*\(\s*__datecol\(\s*[a-zA-Z0-9_.]+\s*\)\s*\)/gi, (m) => `__datecol(${m})`);
          return this._restoreStrings(s, sm);
      },

      // 行コンストラクタの直前に現れ得る語（この語のあとの '(' は関数呼び出しではない）
      _ROW_CTX_KEYWORDS: new Set(['where', 'and', 'or', 'not', 'on', 'having', 'when', 'then', 'else',
                                  'select', 'by', 'is', 'in', 'row', 'case', 'qualify', 'set', 'returns']),

      // 行コンストラクタ比較 (a, b) = (c, d) / <> / IN ((1,2),(3,4)) を
      // 列ごとの比較の AND / OR へ展開する（JS のカンマ演算子として潰れるのを防ぐ）
      _rewriteRowConstructors(s) {
          if (s.indexOf('(') === -1) return s;
          for (let guard = 0; guard < 64; guard++) {
              let hit = false;
              for (let i = 0; i < s.length; i++) {
                  if (s[i] !== '(') continue;
                  // 関数呼び出しの引数リストと区別する。直前が識別子/閉じ括弧なら呼び出し。
                  // 空白を挟む場合は、直前の語が「値が来る位置を作るキーワード」のときだけ
                  // 行コンストラクタとみなす（`IFNULL (a, b)` のような空白付き呼び出し対策）
                  if (i > 0 && /[a-zA-Z0-9_.)\]]/.test(s[i - 1])) continue;
                  const before = s.slice(0, i).replace(/\s+$/, '');
                  const wm = before.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);
                  if (wm && !this._ROW_CTX_KEYWORDS.has(wm[1].toLowerCase())) continue;
                  const close = this._scanBalanced(s, i);
                  if (close === -1) continue;
                  const lhsItems = this.splitSelectClause(s.slice(i + 1, close));
                  if (lhsItems.length < 2) continue;
                  const tail = s.slice(close + 1);
                  const opM = tail.match(/^\s*(=|<>|!=)\s*\(/);
                  const inM = tail.match(/^\s+(NOT\s+)?IN\s*\(/i);
                  if (!opM && !inM) continue;
                  // tail は s.slice(close + 1) なので、tail 内の '(' 位置は close + 1 + (len - 1)
                  const open2 = close + (opM ? opM[0].length : inM[0].length);
                  const close2 = this._scanBalanced(s, open2);
                  if (close2 === -1) continue;
                  const inner2 = s.slice(open2 + 1, close2);
                  let repl;
                  if (opM) {
                      const rhsItems = this.splitSelectClause(inner2);
                      if (rhsItems.length !== lhsItems.length) {
                          throw new Error(`Row constructor comparison requires equal arity (${lhsItems.length} vs ${rhsItems.length}).`);
                      }
                      const eq = '(' + lhsItems.map((l, k) => `(${l}) = (${rhsItems[k]})`).join(' AND ') + ')';
                      repl = opM[1] === '=' ? eq : `NOT ${eq}`;
                  } else {
                      const groups = this.splitSelectClause(inner2).map(g => g.trim()).filter(g => g !== '');
                      if (groups.length === 0) { repl = inM[1] ? 'TRUE' : 'FALSE'; }
                      else {
                          const ors = groups.map(g => {
                              const gm = g.match(/^\(([\s\S]*)\)$/);
                              if (!gm) throw new Error('Row constructor IN requires parenthesized value groups.');
                              const vals = this.splitSelectClause(gm[1]);
                              if (vals.length !== lhsItems.length) {
                                  throw new Error(`Row constructor IN requires equal arity (${lhsItems.length} vs ${vals.length}).`);
                              }
                              return '(' + lhsItems.map((l, k) => `(${l}) = (${vals[k]})`).join(' AND ') + ')';
                          });
                          repl = (inM[1] ? 'NOT ' : '') + '(' + ors.join(' OR ') + ')';
                      }
                  }
                  s = s.slice(0, i) + repl + s.slice(close2 + 1);
                  hit = true;
                  break;
              }
              if (!hit) break;
          }
          return s;
      },

      // CAST/CONVERT/'::' が受け取る型名を正準名＋桁指定へ正規化する。
      // 商用DBの型名は方言差が大きく別名も多いので、ここで一箇所に寄せてから
      // __cast へ渡す（行評価ごとの型名パースを避けるためコンパイル時に解く）。
      // 未知の型名は正準名を null にして「変換せず素通し」にする（従来挙動）
      _normalizeCastType(raw) {
          const m = String(raw).match(/^\s*([a-zA-Z][a-zA-Z0-9_]*(?:\s+[a-zA-Z][a-zA-Z0-9_]*)?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/);
          if (!m) return { name: null, p: null, s: null };
          const key = m[1].replace(/\s+/g, ' ').toUpperCase();
          const p = m[2] === undefined ? null : parseInt(m[2], 10);
          const s = m[3] === undefined ? null : parseInt(m[3], 10);
          const name = CAST_TYPE_ALIASES[key] || null;
          return { name, p, s, raw: key };
      },

      // 正規化した型を __cast の引数リストへ落とす。
      // 知らない型名は拒否する。従来は素通し（値をそのまま返す）だったため、
      // CAST(x AS INTEGR) のような綴り違いが何も変換せずに成功し、
      // 変換したつもりの値がそのまま流れていた。CREATE DOMAIN / CREATE TYPE で
      // 定義した名前は基底型として通す
      _castArgs(raw) {
          const t = this._normalizeCastType(raw);
          if (!t.name) {
              const key = (t.raw || String(raw).replace(/\s+/g, ' ').toUpperCase()).replace(/'/g, '');
              const dom = this.domains && this.domains[key.toLowerCase()];
              if (dom) {
                  const base = this._normalizeCastType(dom.base || 'TEXT');
                  return `'${base.name || 'TEXT'}', ${base.p === null ? 'null' : base.p}, ${base.s === null ? 'null' : base.s}`;
              }
              throw new Error(`Unknown type '${key}' in CAST/CONVERT. `
                  + `Use INTEGER, DECIMAL, FLOAT, TEXT, BOOLEAN, DATE, DATETIME, TIMESTAMP or TIME `
                  + `(dialect aliases such as INT, VARCHAR, NUMBER are accepted).`);
          }
          return `'${t.name}', ${t.p === null ? 'null' : t.p}, ${t.s === null ? 'null' : t.s}`;
      },

      // 関数呼び出し fname(...) の実引数を、括弧の対応を見ながら全ての出現について取り出す。
      // 「キーワード引数（'base64' / 'one' / タイムゾーン名など）が正しいか」を
      // **コンパイル時に**検査するために使う。実行時 throw は行評価の catch に
      // 飲まれて黙って NULL になるので、綴りの誤りはここで弾く
      _scanCallArgs(s, fname) {
          const head = new RegExp('(^|[^A-Za-z0-9_.])' + fname + '\\s*\\(', 'gi');
          const out = [];
          let m;
          while ((m = head.exec(s))) {
              let depth = 1, i = m.index + m[0].length;
              const start = i;
              for (; i < s.length && depth > 0; i++) {
                  if (s[i] === '(') depth++;
                  else if (s[i] === ')') depth--;
              }
              if (depth !== 0) continue;   // 括弧が閉じていない形には触れない
              const body = s.slice(start, i - 1);
              out.push(body.trim() === '' ? [] : this.splitSelectClause(body).map(x => x.trim()));
          }
          return out;
      },

      // 実引数が文字列リテラルならその中身を返す（リテラルでなければ null）。
      // _scanCallArgs と組で「綴りのコンパイル時検査」に使う
      _argLiteralText(tok, strMap) {
          const t = String(tok || '').trim();
          const m = /^__STR_(\d+)__$/.exec(t);
          if (m) return strMap ? this._unquoteLiteral(strMap[Number(m[1])]) : null;
          if (/^'[\s\S]*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
          return null;
      },

      // CAST(expr AS TYPE) / CONVERT(expr, TYPE) / CONVERT(TYPE, expr) を、括弧の対応を
      // 見ながら「最も後ろ（＝最も内側）」から順に __cast(...) へ書き換える。
      // 深さ制限つきの正規表現で切っていたため、`CAST(SUBSTRING(CAST(d AS TEXT), 1, 4) AS INT)`
      // のように 2 段以上ネストした形はどの位置にも一致せず、CAST がそのまま残って
      // 「関数 CAST は存在しません。CAST の間違いでは？」という意味不明なエラーになっていた。
      // 形が読めないものには触れない（後段の構文エラーに任せる）
      _rewriteCastCalls(s, fname, form) {
          const head = new RegExp('\\b' + fname + '\\s*\\(', 'gi');
          for (let guard = 0; guard < 500; guard++) {
              head.lastIndex = 0;
              let m, start = -1, open = -1;
              while ((m = head.exec(s)) !== null) { start = m.index; open = m.index + m[0].length - 1; }
              if (open === -1) return s;
              const close = this._scanBalanced(s, open);
              if (close === -1) return s;
              const parts = this._splitCastBody(s.slice(open + 1, close), form);
              if (!parts) return s;
              s = s.slice(0, start) + `__cast(${parts.expr}, ${this._castArgs(parts.type)})` + s.slice(close + 1);
          }
          return s;
      },

      // CAST/CONVERT の括弧の中身を「値の式」と「型名」へ切り分ける。
      // 区切り（AS / カンマ）は括弧の外側にあるものだけを見る
      _splitCastBody(body, form) {
          const TYPE_RE = /^\s*[a-zA-Z][a-zA-Z0-9_]*(?:\s+[a-zA-Z][a-zA-Z0-9_]*)?\s*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?\s*$/;
          const depths = [];
          let d = 0;
          for (let i = 0; i < body.length; i++) {
              const c = body[i];
              if (c === '(') d++;
              else if (c === ')') d--;
              depths.push(d);
          }
          const cut = (at, len) => ({ head: body.slice(0, at), tail: body.slice(at + len) });
          if (form === 'as') {
              const re = /\s+AS\s+/gi;
              let mm, last = null;
              while ((mm = re.exec(body)) !== null) if (depths[mm.index] === 0) last = mm;
              if (!last) return null;
              const p = cut(last.index, last[0].length);
              return TYPE_RE.test(p.tail) ? { expr: p.head.trim(), type: p.tail.trim() } : null;
          }
          const commas = [];
          for (let i = 0; i < body.length; i++) if (body[i] === ',' && depths[i] === 0) commas.push(i);
          if (commas.length === 0) return null;
          if (form === 'expr,type') {
              const p = cut(commas[commas.length - 1], 1);
              return TYPE_RE.test(p.tail) ? { expr: p.head.trim(), type: p.tail.trim() } : null;
          }
          // 'type,expr'（SQL Server 形の CONVERT）
          const p = cut(commas[0], 1);
          return TYPE_RE.test(p.head) ? { expr: p.tail.trim(), type: p.head.trim() } : null;
      },

      // PostgreSQL の '::' キャスト演算子を __cast(expr, 'TYPE') へ書き換える。
      // 被演算子は '::' の左を後方走査して決める（`(a+b)::INT` / `f(x)::TEXT` /
      // `x::INT::TEXT` の連鎖も 1 単位ずつ正しく取れる）
      _rewriteCastOp(s) {
          if (s.indexOf('::') === -1) return s;
          for (let guard = 0; guard < 256; guard++) {
              const at = s.indexOf('::');
              if (at === -1) return s;
              const tm = s.slice(at + 2).match(/^\s*([a-zA-Z][a-zA-Z0-9_]*(?:\s+(?:PRECISION|VARYING))?)(\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?/);
              if (!tm) throw new Error("Syntax Error near '::'. Use <expr>::<type>.");
              let i = at - 1;
              while (i >= 0 && /\s/.test(s[i])) i--;
              if (i < 0) throw new Error("Syntax Error near '::'. Use <expr>::<type>.");
              let start;
              if (s[i] === ')') {
                  // 対応する開き括弧まで戻り、直前に識別子があれば関数呼び出しとして取り込む
                  let d = 0, j = i;
                  for (; j >= 0; j--) {
                      if (s[j] === ')') d++;
                      else if (s[j] === '(') { d--; if (d === 0) break; }
                  }
                  if (j < 0) throw new Error("Syntax Error near '::': unbalanced parentheses.");
                  let k = j - 1;
                  while (k >= 0 && /[a-zA-Z0-9_.]/.test(s[k])) k--;
                  start = k + 1;
              } else {
                  let k = i;
                  while (k >= 0 && /[a-zA-Z0-9_.]/.test(s[k])) k--;
                  if (k === i) throw new Error("Syntax Error near '::'. Use <expr>::<type>.");
                  if (k >= 0 && s[k] === '-' && (k === 0 || !/[a-zA-Z0-9_.)]/.test(s[k - 1]))) k--;
                  start = k + 1;
              }
              const operand = s.slice(start, i + 1);
              s = s.slice(0, start) + `__cast(${operand}, ${this._castArgs(tm[1] + (tm[2] || ''))})` + s.slice(at + 2 + tm[0].length);
          }
          return s;
      },

      // '||' 連結演算子を __concat_op(...) へ畳む。括弧グループを内側から処理し、
      // 引数リストのトップレベルのカンマ区切りは保ったまま各要素を個別に畳む
      // （f(a || b, c) の展開で引数の切れ目を失わないため）
      // 算術演算子を NULL 伝播するヘルパ呼び出しへ畳む。
      //   a + b -> __add(a, b) / a - b -> __sub(a, b) / a * b -> __mul(a, b)
      //   a / b -> __divf(a, b) / a % b -> __modf(a, b) / -a -> __neg(a)
      // SQL では被演算子に NULL があれば結果は NULL。素の JS 演算子は null を 0 として
      // 扱うため、`amt - qty` が qty=NULL のときに amt を返し、`amt * qty` が 0 を返して
      // いた（その 0 が MIN に選ばれ、AVG の分母にも数えられる＝集計まで静かに狂う）。
      // 比較の畳み込み（_rewriteCompareOps）より前に置くこと（算術のほうが強く結合する）
      _rewriteArithOps(s) {
          if (!/[+\-*/%]/.test(s)) return s;
          const PREC = [['*', '/', '%'], ['+', '-']];
          const FN = { '+': '__add', '-': '__sub', '*': '__mul', '/': '__divf', '%': '__modf' };
          // 算術より優先順位の低い区切り。ここを跨いで畳んではいけない
          const SEP = ['===', '!==', '<=', '>=', '&&', '||', '<', '>', '?', ':', ','];

          // 単項マイナスの付いた被演算子を包む（数値リテラルはそのまま）
          const unaryNeg = (atom) => {
              const m = atom.match(/^(\s*)([+-])([\s\S]+)$/);
              if (!m) return atom;
              const inner = unaryNeg(m[2] === '-' ? m[3] : m[3]);
              if (m[2] === '+') return m[1] + inner;
              if (/^\s*\d/.test(m[3])) return atom;          // -3 / -1.5 はリテラルのまま
              return `${m[1]}__neg(${inner.trim()})`;
          };

          // 1 つのオペランド領域（比較・論理を含まない範囲）の中で算術を畳む
          const foldRegion = (text) => {
              if (!/[+\-*/%]/.test(text)) return text;
              const atoms = [], ops = [];
              let cur = '', depth = 0;
              for (let i = 0; i < text.length; i++) {
                  const c = text[i];
                  if (c === '(' || c === '[') { depth++; cur += c; continue; }
                  if (c === ')' || c === ']') { depth--; cur += c; continue; }
                  if (depth === 0 && (c === '+' || c === '-' || c === '*' || c === '/' || c === '%')) {
                      // 指数表記の符号（1e-5 / 1E+5）は数値リテラルの一部
                      if ((c === '+' || c === '-') && /\d[eE]$/.test(cur)) { cur += c; continue; }
                      // 直前が空＝単項。被演算子側へ付ける
                      if (cur.trim() === '') { cur += c; continue; }
                      atoms.push(cur); ops.push(c); cur = '';
                      continue;
                  }
                  cur += c;
              }
              atoms.push(cur);
              if (ops.length === 0) return unaryNeg(atoms[0]);
              if (atoms.some(a => a.trim() === '')) return text;   // 壊れた式は触らない

              let a = atoms.map(unaryNeg), o = ops.slice();
              for (const level of PREC) {
                  const na = [a[0]], no = [];
                  for (let i = 0; i < o.length; i++) {
                      if (level.includes(o[i])) {
                          const left = na.pop();
                          na.push(`${FN[o[i]]}(${left.trim()}, ${a[i + 1].trim()})`);
                      } else { no.push(o[i]); na.push(a[i + 1]); }
                  }
                  a = na; o = no;
              }
              let out = a[0];
              for (let i = 0; i < o.length; i++) out += o[i] + a[i + 1];
              return out;
          };

          // 深さ 0 を比較・論理で区切ってから、各領域を畳む
          const foldLevel = (str) => {
              const out = [];
              let cur = '', depth = 0, i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') { depth++; cur += c; i++; continue; }
                  if (c === ')' || c === ']') { depth--; cur += c; i++; continue; }
                  if (depth === 0) {
                      const sep = SEP.find(op => str.startsWith(op, i));
                      if (sep) { out.push(foldRegion(cur)); out.push(sep); cur = ''; i += sep.length; continue; }
                      if (c === '!' && str[i + 1] !== '=') { out.push(foldRegion(cur)); out.push('!'); cur = ''; i++; continue; }
                  }
                  cur += c; i++;
              }
              out.push(foldRegion(cur));
              return out.join('');
          };

          const proc = (str) => {
              let out = '', i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') {
                      const close = c === '(' ? ')' : ']';
                      let d = 0, j = i;
                      for (; j < str.length; j++) {
                          if (str[j] === c) d++;
                          else if (str[j] === close) { d--; if (d === 0) break; }
                      }
                      if (j >= str.length) { out += str.slice(i); break; }
                      out += c + proc(str.slice(i + 1, j)) + close;
                      i = j + 1;
                      continue;
                  }
                  out += c; i++;
              }
              return foldLevel(out);
          };
          try { return proc(s); } catch (e) { return s; }
      },

      // JS の比較演算子を 3 値論理のヘルパ呼び出しへ畳む。
      //   a === b -> __eq(a, b) / a !== b -> __ne(a, b) / a < b -> __lt(a, b) ...
      //   !X      -> __not3(X)
      // SQL では「どちらかが NULL なら結果は UNKNOWN」だが、素の JS 演算子は
      // null を 0 や null と突き合わせてしまう（`v < 100` が NULL 行を拾う、
      // `x = NULL` が NULL 同士で真になる、`NOT (a = 1)` が NULL 行を拾う、
      // `CHECK (b > 0)` が NULL を違反と判定する、等）。
      // 括弧の内側から再帰的に処理し、各深さでは論理演算子・三項・カンマで
      // オペランドへ切り分けてから、その境界にある比較演算子だけを畳む
      _rewriteCompareOps(s) {
          if (!/[<>=!]/.test(s)) return s;
          const CMP = ['===', '!==', '<=', '>=', '<', '>'];
          const FN = { '===': '__eq', '!==': '__ne', '<=': '__le', '>=': '__ge', '<': '__lt', '>': '__gt' };
          const SEP = ['&&', '||', '?', ':', ','];

          // 1 つの深さの中を畳む。括弧の中身は処理済みで、ここでは不可分な塊として扱う
          const foldLevel = (str) => {
              const toks = [];              // { t: 'operand'|'sep'|'cmp', v }
              let cur = '', depth = 0, i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') { depth++; cur += c; i++; continue; }
                  if (c === ')' || c === ']') { depth--; cur += c; i++; continue; }
                  if (depth === 0) {
                      const sep = SEP.find(o => str.startsWith(o, i));
                      if (sep) { toks.push({ t: 'operand', v: cur }); toks.push({ t: 'sep', v: sep }); cur = ''; i += sep.length; continue; }
                      const cmp = CMP.find(o => str.startsWith(o, i));
                      if (cmp) { toks.push({ t: 'operand', v: cur }); toks.push({ t: 'cmp', v: cmp }); cur = ''; i += cmp.length; continue; }
                  }
                  cur += c; i++;
              }
              toks.push({ t: 'operand', v: cur });

              // オペランドの先頭に付いた NOT(`!`) は 3 値論理の否定へ回す。
              // `!null === true` のままだと `WHERE NOT (v = 10)` が v IS NULL の行まで拾う
              const unary = (txt) => {
                  const m = txt.match(/^(\s*)!(?!=)([\s\S]*)$/);
                  if (!m) return txt;
                  const inner = unary(m[2]);
                  return `${m[1]}__not3(${inner.trim()})`;
              };
              if (!toks.some(t => t.t === 'cmp')) {
                  return toks.map(t => (t.t === 'operand' ? unary(t.v) : t.v)).join('');
              }
              // 左から順に比較を畳む（SQL では比較の連鎖は書けないので実質 1 個）
              const out = [];
              for (let k = 0; k < toks.length; k++) {
                  const t = toks[k];
                  if (t.t !== 'cmp') { out.push(t); continue; }
                  const left = out.pop();
                  const right = toks[k + 1];
                  k++;
                  if (!left || !right || left.v.trim() === '' || right.v.trim() === '') {
                      // 片側が空（`a = ` のような壊れた式）はそのまま返して既存の
                      // 構文エラー経路に委ねる
                      if (left) out.push(left);
                      out.push({ t: 'operand', v: t.v });
                      if (right) out.push(right);
                      continue;
                  }
                  // SQL の NOT は比較より結合が弱い（`NOT a = b` は `NOT (a = b)`）。
                  // 左オペランドの頭に付いた `!`（NOT 由来）は、比較を畳んでから
                  // 外側に掛け直す。そうしないと `NOT v <> 10` が `__ne(!v, 10)` になり、
                  // 「!v は真偽値、10 と等しくない」＝常に真として全行が通っていた
                  let lv = left.v, negs = 0, um;
                  while ((um = lv.match(/^\s*!(?!=)([\s\S]*)$/))) { negs++; lv = um[1]; }
                  let folded = `${FN[t.v]}(${lv.trim()}, ${right.v.trim()})`;
                  for (let n = 0; n < negs; n++) folded = `__not3(${folded})`;
                  out.push({ t: 'operand', v: `${left.v.match(/^\s*/)[0]}${folded}` });
              }
              return out.map(t => (t.t === 'operand' ? unary(t.v) : t.v)).join('');
          };

          const proc = (str) => {
              let out = '', i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') {
                      const close = c === '(' ? ')' : ']';
                      let d = 0, j = i;
                      for (; j < str.length; j++) {
                          if (str[j] === c) d++;
                          else if (str[j] === close) { d--; if (d === 0) break; }
                      }
                      if (j >= str.length) { out += str.slice(i); break; }
                      out += c + proc(str.slice(i + 1, j)) + close;
                      i = j + 1;
                      continue;
                  }
                  out += c; i++;
              }
              return foldLevel(out);
          };
          try { return proc(s); } catch (e) { return s; }
      },

      // AND / OR を 3 値論理のヘルパ呼び出しへ畳む。
      //   a && b -> __and3(a, b) / a || b -> __or3(a, b)
      // JS の && / || は「左が偽なら左を返す」ので、左辺が NULL のとき SQL と食い違う。
      //   NULL AND FALSE : SQL は FALSE（片方が偽なら偽）だが JS は null
      //   NULL OR  FALSE : SQL は NULL（真と言い切れない）だが JS は false
      // 右辺が NULL の場合はたまたま一致していたため、左辺だけが NULL のときに
      // 静かに誤った真偽値が出ていた。とくに NOT で包むと真偽が反転し、
      // 本来除かれる行が WHERE を通ってしまう
      _rewriteLogicOps(s) {
          if (s.indexOf('&&') === -1 && s.indexOf('||') === -1) return s;
          // 1 つの深さを畳む。括弧の中身は処理済みで、ここでは不可分な塊として扱う。
          // カンマ・三項は演算子の対象外なので、その区切りごとに独立して畳む
          const foldLevel = (str) => {
              const SEG = [',', '?', ':'];
              const parts = [], seps = [];
              let cur = '', depth = 0, i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') { depth++; cur += c; i++; continue; }
                  if (c === ')' || c === ']') { depth--; cur += c; i++; continue; }
                  if (depth === 0 && SEG.indexOf(c) !== -1) {
                      parts.push(cur); seps.push(c); cur = ''; i++; continue;
                  }
                  cur += c; i++;
              }
              parts.push(cur);
              const folded = parts.map(seg => {
                  if (seg.indexOf('&&') === -1 && seg.indexOf('||') === -1) return seg;
                  // OR のほうが弱いので先に切る
                  const splitTop = (text, op) => {
                      const out = []; let buf = '', d = 0, k = 0;
                      while (k < text.length) {
                          const ch = text[k];
                          if (ch === '(' || ch === '[') { d++; buf += ch; k++; continue; }
                          if (ch === ')' || ch === ']') { d--; buf += ch; k++; continue; }
                          if (d === 0 && text.startsWith(op, k)) { out.push(buf); buf = ''; k += 2; continue; }
                          buf += ch; k++;
                      }
                      out.push(buf);
                      return out;
                  };
                  const build = (text, op, fn, next) => {
                      const items = splitTop(text, op);
                      if (items.length === 1) return next ? next(text) : text;
                      const mapped = items.map(x => (next ? next(x) : x));
                      if (mapped.some(x => x.trim() === '')) return text;   // 壊れた式は触らない
                      const lead = mapped[0].match(/^\s*/)[0];
                      // 右辺は矢印関数で包む（左辺だけで決まるときに評価しないため）
                      return lead + mapped.map(x => x.trim()).reduce((a, b) => `${fn}(${a}, () => (${b}))`);
                  };
                  return build(seg, '||', '__or3', (x) => build(x, '&&', '__and3', null));
              });
              let out = folded[0];
              for (let k = 0; k < seps.length; k++) out += seps[k] + folded[k + 1];
              return out;
          };
          const proc = (str) => {
              let out = '', i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(' || c === '[') {
                      const close = c === '(' ? ')' : ']';
                      let d = 0, j = i;
                      for (; j < str.length; j++) {
                          if (str[j] === c) d++;
                          else if (str[j] === close) { d--; if (d === 0) break; }
                      }
                      if (j >= str.length) { out += str.slice(i); break; }
                      out += c + proc(str.slice(i + 1, j)) + close;
                      i = j + 1;
                      continue;
                  }
                  out += c; i++;
              }
              return foldLevel(out);
          };
          try { return proc(s); } catch (e) { return s; }
      },

      _rewriteConcatOp(s) {
          if (s.indexOf('||') === -1) return s;
          // 1 つのオペランド（比較・論理演算子を含まない範囲）の中の '||' だけを畳む
          const foldOperand = (text) => {
              if (text.indexOf('||') === -1) return text;
              const parts = [];
              let cur = '', depth = 0;
              for (let i = 0; i < text.length; i++) {
                  const c = text[i];
                  if (c === '(') depth++;
                  else if (c === ')') depth--;
                  if (depth === 0 && c === '|' && text[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
                  cur += c;
              }
              parts.push(cur);
              if (parts.length < 2) return text;
              if (parts.some(p => p.trim() === '')) throw new Error("Syntax Error: '||' requires operands on both sides.");
              // 前後の空白は元のまま残す（隣接するキーワードとくっつかないように）
              const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
              return lead + '__concat_op(' + parts.map(p => p.trim()).join(', ') + ')' + trail;
          };
          // SQL の優先順位では '||' は比較・論理演算子より強く結合する。
          // そこで低優先度の演算子でオペランドへ切り分け、その内側でだけ畳む
          // （`name || dept = 'x'` を `__concat_op(name, dept = 'x')` にしないため）
          const SYM_OPS = ['===', '!==', '<=', '>=', '<>', '!=', '=', '<', '>', '?', ':'];
          const WORD_OPS = /^(AND|OR|NOT|IN|IS|LIKE|ILIKE|BETWEEN|SIMILAR)\b/i;
          const foldTop = (str) => {
              if (str.indexOf('||') === -1) return str;
              const out = [];
              let cur = '', depth = 0, i = 0;
              while (i < str.length) {
                  const c = str[i];
                  if (c === '(') { depth++; cur += c; i++; continue; }
                  if (c === ')') { depth--; cur += c; i++; continue; }
                  if (depth === 0) {
                      if (c === '|' && str[i + 1] === '|') { cur += '||'; i += 2; continue; }
                      if (c === ':' && str[i + 1] === ':') { cur += '::'; i += 2; continue; }
                      const sym = SYM_OPS.find(op => str.startsWith(op, i));
                      if (sym) { out.push(foldOperand(cur)); out.push(sym); cur = ''; i += sym.length; continue; }
                      if (i === 0 || !/[a-zA-Z0-9_]/.test(str[i - 1])) {
                          const wm = WORD_OPS.exec(str.slice(i));
                          if (wm) { out.push(foldOperand(cur)); out.push(wm[0]); cur = ''; i += wm[0].length; continue; }
                      }
                  }
                  cur += c;
                  i++;
              }
              out.push(foldOperand(cur));
              return out.join('');
          };
          const scan = (str) => {
              let out = '', i = 0;
              while (i < str.length) {
                  if (str[i] === '(') {
                      const close = this._scanBalanced(str, i);
                      if (close === -1) { out += str.slice(i); return foldTop(out); }
                      const inner = str.slice(i + 1, close);
                      out += '(' + this.splitSelectClause(inner).map(scan).join(', ') + ')';
                      i = close + 1;
                      continue;
                  }
                  out += str[i++];
              }
              return foldTop(out);
          };
          return scan(s);
      },

      // ------------------------------------------------------------------
      // コンパイル済み式のキャッシュ
      //
      // compileCondition は正規表現を数百本かけてから new Function する。1 行の
      // 評価は速くても「小さいクエリを何百回も投げる」アプリ側の使い方では
      // コンパイルが支配的になる。式テキスト（文字列リテラル復元後）をキーに
      // LRU で持ち回すことで、同じ形のクエリの 2 回目以降を丸ごと省ける。
      //
      // 注意: 生成コードには userVars / LAST_INSERT_ID / UDF 定義がリテラルとして
      // 畳み込まれるため、それらが絡む式はキャッシュしない（値が古くなるため）。
      // ------------------------------------------------------------------
      _exprCacheGet(key) {
        const c = DatabaseEngine._exprCache;
        const hit = c.get(key);
        if (hit === undefined) { DatabaseEngine._exprCacheStats.miss++; return undefined; }
        // LRU: 参照したものを末尾へ移す
        c.delete(key); c.set(key, hit);
        DatabaseEngine._exprCacheStats.hit++;
        return hit;
      },
      _exprCachePut(key, fn) {
        const c = DatabaseEngine._exprCache;
        c.set(key, fn);
        if (c.size > DatabaseEngine._exprCacheMax) c.delete(c.keys().next().value);
      },
      // この式をキャッシュしてよいか（実行時点の状態を畳み込む構文が無いこと）
      _isCacheableExpr(text) {
        if (/@|\bLAST_INSERT_ID\b|\bNEXTVAL\b|\bCURRVAL\b|\bSETVAL\b|\bSETSEED\b/i.test(text)) return false;
        // ユーザー定義関数は定義変更で意味が変わるので、定義が 1 つでもあれば見送る
        if (this.functions && Object.keys(this.functions).length > 0) return false;
        // 相関サブクエリのトークンは文ごとに採番されるためキャッシュ不可
        if (/__CORR(?:EX|SC|IN)_\d+__/.test(text)) return false;
        return true;
      },

      compileCondition(expr, strMap) {
          // 文字列リテラルを戻したテキストをキーにする（__STR_n__ の採番は文ごとに変わるため）
          let cacheKey = null;
          if (typeof expr === 'string' && expr.length <= 4000 && this._isCacheableExpr(expr)) {
              cacheKey = this._restoreStrings(expr, strMap);
              const hit = this._exprCacheGet(cacheKey);
              if (hit !== undefined) return hit;
          }
          const compiled = this._compileConditionUncached(expr, strMap);
          if (cacheKey !== null) this._exprCachePut(cacheKey, compiled);
          return compiled;
      },

      // 組み込み関数の引数個数の検査。
      //
      // 対象は「カンマ区切りの引数しか取らない」関数だけに絞ってある。
      // `EXTRACT(YEAR FROM d)` / `CAST(x AS INT)` / `TRIM(BOTH 'x' FROM y)` /
      // `SUBSTRING(s FROM 2 FOR 3)` / `POSITION(a IN b)` のような**キーワード区切りの
      // 引数を持つ綴りは表に入れない**（1 引数と数えて誤って弾いてしまう）。
      // 集計関数・ウィンドウ関数・ユーザー定義関数も対象外（別経路で検証済み）。
      // 表に無い名前は従来どおり寛容なままなので、この検査は純粋な追加で既存の
      // 動作を狭めない
      _checkBuiltinArity(expr) {
          if (!expr || expr.indexOf('(') === -1) return;
          const re = /(^|[^a-zA-Z0-9_.$])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
          let m;
          while ((m = re.exec(expr))) {
              const name = m[2].toUpperCase();
              const spec = LUMINA_FN_ARITY[name];
              if (!spec) continue;
              // ユーザー定義関数が同名を持つなら触らない
              if (this.functions && this.functions[name.toLowerCase()]) continue;
              const open = m.index + m[0].length - 1;
              let depth = 0, close = -1;
              for (let i = open; i < expr.length; i++) {
                  const ch = expr[i];
                  if (ch === '(' || ch === '[') depth++;
                  else if (ch === ')' || ch === ']') { depth--; if (depth === 0) { close = i; break; } }
              }
              if (close === -1) continue;   // 括弧が閉じていない → 別の経路のエラーに任せる
              const inner = expr.slice(open + 1, close);
              // キーワード区切りの綴りが混ざっていたら数え方が変わるので見送る
              if (/(^|\s)(from|for|as|in|using|placing|both|leading|trailing|order\s+by|separator)(\s|$)/i.test(inner)) continue;
              const args = inner.trim() === '' ? [] : this.splitSelectClause(inner);
              const n = args.length;
              if (n < spec[0] || (spec[1] !== null && n > spec[1])) {
                  const want = spec[1] === null
                      ? `at least ${spec[0]}`
                      : (spec[0] === spec[1] ? `${spec[0]}` : `${spec[0]} to ${spec[1]}`);
                  throw new Error(`Incorrect parameter count in the call to native function '${name}': got ${n}, expected ${want}.`);
              }
              // 次の走査は開き括弧の位置から続ける（入れ子の呼び出しも個別に検査する）。
              // open + 1 にすると、正規表現が要求する「名前の直前の区切り文字」を
              // 消費できず入れ子が丸ごと読み飛ばされる（ABS(POWER(2)) が通ってしまう）
              re.lastIndex = open;
          }
      },

      _compileConditionUncached(expr, strMap) {
          // 防御的措置: 式は new Function でJSへコンパイルされる。識別子は __resolve() へ
          // ラップされ文字列リテラルは退避されるため通常のSQLは安全だが、本方言が使わない
          // テンプレートリテラル構文(バックティック / ${...})はそのままJSソースへ紛れ込み
          // 任意コード実行の足がかりになり得るため、コンパイル前に拒否する。
          if (/[`]|\$\{/.test(expr)) {
              throw new Error("Syntax Error: unsupported characters in expression.");
          }
          // 組み込み関数の引数個数を検査する（誤った個数は黙って NULL / 変な値 /
          // 列の消失になっていた）。名前だけの正規表現写像で JS 関数へ落とすため、
          // JS の「足りない引数は undefined・余った引数は無視」がそのまま漏れていた
          this._checkBuiltinArity(expr);
          let s = expr;

          // 関数名と開き括弧の間の空白・改行を詰める（`ABS (x)` / `COUNT (\n *\n )`）。
          // 関数の写像は `\bNAME\(` の形なので、空白が挟まると名前が変換されないまま残り
          // 「関数 ABS は存在しません。ABS の間違いでは？」という意味不明なエラーになっていた。
          // 括弧を伴う構文語（IN / EXISTS / NOT / CASE ...）はそのままにする
          if (/[a-zA-Z_]\s+\(/.test(s)) {
              s = s.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+\(/g,
                  (m, name) => LUMINA_PAREN_KEYWORDS.has(name.toUpperCase()) ? m : name + '(');
          }
          // 中身が空白だけの括弧は空の引数リストとして扱う（`PI( )` / `NOW(\n)`）
          if (/\(\s+\)/.test(s)) s = s.replace(/\(\s+\)/g, '()');

          // 連続ハイフン (5--3 のような二重否定) は JS のデクリメント演算子として
          // 誤解釈され構文エラーになるため空白で分割する（コメントは除去済み）
          s = s.replace(/--/g, '- -');

          // ユーザー定義関数 (CREATE FUNCTION) を本体へ展開する（CASE を含み得るので最初に）
          s = this._inlineUserFunctions(s, strMap, 0);

          // Enhanced CASE WHEN to support multiple WHEN clauses
          // ネストした CASE に対応するため、本体に CASE を含まない最内側のブロックから
          // 置換する（外側は次のループ反復で処理される）
          let caseRegex = /\bCASE\b((?:(?!\bCASE\b)[\s\S])+?)\bEND\b/i;
          let cm;
          while((cm = s.match(caseRegex))) {
              let body = cm[1];
              // 複数行に整形した CASE（WHEN ごとに改行する書き方）を受けるため [\s\S] で受ける。
              // `.` は改行に一致しないので、以前は WHEN 節が 1 つも取れずに ELSE だけの式へ、
              // ELSE 値の後ろで改行すると ELSE 自体が消えて NULL へと、いずれも黙って誤答していた
              let whenRegex = /WHEN\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)(?=\s+WHEN\b|\s+ELSE\b|$)/gi;
              let wm;
              let elseStr = 'null';
              let elseMatch = body.match(/ELSE\s+([\s\S]+?)\s*$/i);
              if(elseMatch) {
                  elseStr = elseMatch[1].trim();
                  body = body.substring(0, elseMatch.index);
              }
              // 簡易CASE (CASE <expr> WHEN <val> THEN ...): CASE と最初の WHEN の間の式を
              // 演算対象として取り出し、各 WHEN 値との等価比較へ展開する
              let operand = null;
              const firstWhen = body.search(/\bWHEN\b/i);
              if (firstWhen > 0) {
                  const op = body.slice(0, firstWhen).trim();
                  if (op) operand = op;
              }
              let conditions = [];
              while((wm = whenRegex.exec(body))) {
                  conditions.push({ cond: wm[1].trim(), res: wm[2].trim() });
              }
              let resStr = elseStr;
              for(let i = conditions.length - 1; i >= 0; i--) {
                  const condExpr = operand ? `(${operand}) = (${conditions[i].cond})` : conditions[i].cond;
                  resStr = `((${condExpr}) ? (${conditions[i].res}) : (${resStr}))`;
              }
              s = s.replace(cm[0], resStr);
          }

          // 特殊構文の前処理（キーワード引数を文字列リテラル化して通常の関数呼び出しへ正規化する）
          // POSITION(sub IN str) は IN リスト置換より先に処理する必要がある
          s = s.replace(/\bPOSITION\s*\(([^()]+?)\s+IN\s+/gi, (m, sub) => `__locate(${sub}, `);
          s = s.replace(/\bEXTRACT\s*\(\s*(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND|EPOCH|DOW|DOY)\s*(?:FROM\b|,)/gi, (m, unit) => `__extract('${unit.toUpperCase()}', `);
          s = s.replace(/\bTIMESTAMPDIFF\s*\(\s*(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND)\s*,/gi, (m, unit) => `__timestampdiff('${unit.toUpperCase()}',`);
          s = s.replace(/\bTIMESTAMPADD\s*\(\s*(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND)\s*,/gi, (m, unit) => `__timestampadd('${unit.toUpperCase()}',`);
          // INTERVAL '1 day' / INTERVAL '2 hours'（PostgreSQL の文字列形式）を数値形式へ正規化する
          s = s.replace(/\bINTERVAL\s+__STR_(\d+)__/gi, (m, idx) => {
              const lit = this._unquoteLiteral(strMap[Number(idx)]).trim();
              const im = lit.match(/^(-?\d+)\s*(year|quarter|month|week|day|hour|minute|second)s?$/i);
              if (!im) throw new Error(`Invalid interval literal '${lit}'. Use INTERVAL '<n> <unit>' (year/quarter/month/week/day/hour/minute/second).`);
              return `INTERVAL ${im[1]} ${im[2].toUpperCase()}`;
          });
          s = s.replace(/\bINTERVAL\s+(.+?)\s+(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR|MINUTE|SECOND)S?\b/gi, (m, n, unit) => `__interval((${n}), '${unit.toUpperCase()}')`);
          // SQL Server 系 DATEADD / DATEPART / DATENAME / 3引数 DATEDIFF: 先頭の datepart
          // キーワード（バREワード）を文字列リテラル化し、__resolve による列誤認を防ぐ。
          // 長い綴りを先に並べ、末尾を \s*, で固定して関数呼び出し先頭のみ一致させる。
          const __DP = 'DAYOFYEAR|WEEKDAY|QUARTER|MINUTE|SECOND|MONTH|YEAR|WEEK|HOUR|DAY|YYYY|DOY|WOY|QQ|MM|WK|WW|HH|MI|SS|DW|DY|DD|YY|Q|M|W|D|N|Y|S';
          s = s.replace(new RegExp('\\bDATEADD\\s*\\(\\s*(' + __DP + ')\\s*,', 'gi'), (m, u) => `__dateadd('${u.toUpperCase()}',`);
          s = s.replace(new RegExp('\\bDATEPART\\s*\\(\\s*(' + __DP + ')\\s*,', 'gi'), (m, u) => `__datepart('${u.toUpperCase()}',`);
          s = s.replace(new RegExp('\\bDATENAME\\s*\\(\\s*(' + __DP + ')\\s*,', 'gi'), (m, u) => `__datename('${u.toUpperCase()}',`);
          s = s.replace(new RegExp('\\bDATEDIFF\\s*\\(\\s*(' + __DP + ')\\s*,', 'gi'), (m, u) => `__datediff('${u.toUpperCase()}',`);
          // 単位キーワードが綴り違いだと上の置換が働かず、素の関数呼び出しとして残る。
          // すると「関数 DATEPART は存在しません。DATEPART の間違いでは？」という
          // 自分自身を候補に挙げる意味不明なエラーになっていた。ここで単位名を名指しして知らせる
          {
              const leftover = s.match(/\b(DATEADD|DATEPART|DATENAME|TIMESTAMPADD|TIMESTAMPDIFF)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/i);
              if (leftover) {
                  throw new Error(`Unsupported date unit '${leftover[2]}' in ${leftover[1].toUpperCase()}. `
                      + `Supported: year, quarter, month, week, day, dayofyear, weekday, hour, minute, second `
                      + `(and the usual abbreviations yy, qq, mm, dd, wk, hh, mi, ss).`);
              }
          }
          // TRIM([LEADING|TRAILING|BOTH] [chars] FROM str) — SQL標準構文（_parseSelect 側でも
          // FROM 句誤認防止のためカンマ形式へ正規化されるので、FROM とカンマの両形式を受理する）
          // 方向コード: LEADING→L / TRAILING→R / BOTH→B
          const _trimDir = (dir) => /^t/i.test(dir) ? 'R' : dir[0].toUpperCase();
          s = s.replace(/\bTRIM\s*\(\s*(LEADING|TRAILING|BOTH)\s*(?:FROM\b|,)\s*/gi, (m, dir) => `__trim_dir('${_trimDir(dir)}', null, `);
          s = s.replace(/\bTRIM\s*\(\s*(LEADING|TRAILING|BOTH)\s+((?:[^()]|\([^()]*\))+?)\s*(?:FROM\b|,)\s*/gi, (m, dir, ch) => `__trim_dir('${_trimDir(dir)}', ${ch}, `);
          s = s.replace(/\bTRIM\s*\(\s*(__STR_\d+__)\s*(?:\s+FROM\s+|,\s*)/gi, (m, ch) => `__trim_dir('B', ${ch}, `);
          // SUBSTRING(str FROM pos [FOR len]) — SQL標準構文をカンマ形式へ
          s = s.replace(/\bSUBSTRING\s*\(((?:[^()]|\([^()]*\))+?)\s+FROM\s+/gi, (m, pre) => `SUBSTRING(${pre}, `);
          s = s.replace(/\bSUBSTRING\s*\(((?:[^()]|\([^()]*\))+?)\s+FOR\s+/gi, (m, pre) => `SUBSTRING(${pre}, `);
          // DATE '2026-01-01' / TIMESTAMP '...' 日付リテラル（格納形式の文字列へ正規化して比較可能に）
          // 型付きリテラル: DATE '...' は日付だけ、TIMESTAMP '...' は日付＋時刻
          s = s.replace(/\b(DATE|TIMESTAMP)\s+(__STR_\d+__)/gi,
              (m, kw, tok) => `__cast(${tok}, '${/^date$/i.test(kw) ? 'DATEONLY' : 'DATE'}')`);
          // LAST_INSERT_ID() はクエリ実行時点の値へ定数畳み込みする
          // （コンパイル済み関数からはエンジンインスタンスへ到達できないため）
          s = s.replace(/\bLAST_INSERT_ID\s*\(\s*\)/gi, () => `(${Number(this.lastInsertId) || 0})`);

          // システム変数 @@name（MySQL / SQL Server 形式）をコンパイル時に畳み込む。
          // ユーザー変数 @name の処理より前に消費する必要がある（'@@x' が '@' + '@x' に割れるため）
          s = s.replace(/@@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, nm) => {
              const key = nm.toLowerCase();
              if (key === 'version' || key === 'lumina_version') {
                  strMap.push(this._quoteLiteral(typeof LUMINA_VERSION !== 'undefined' ? LUMINA_VERSION : '0'));
                  return `__STR_${strMap.length - 1}__`;
              }
              if (key === 'identity' || key === 'last_insert_id') return `(${Number(this.lastInsertId) || 0})`;
              if (key === 'rowcount') return `(${Number(this._lastRowCount) || 0})`;
              const sv = this.sessionSettings ? this.sessionSettings[key] : undefined;
              if (sv === undefined) throw new Error(`Unknown system variable '@@${nm}'.`);
              if (!isNaN(sv) && String(sv).trim() !== '') return `(${Number(sv)})`;
              strMap.push(this._quoteLiteral(String(sv)));
              return `__STR_${strMap.length - 1}__`;
          });

          // ユーザー変数 @name をコンパイル時に現在値のリテラルへ畳み込む（未定義は NULL）。
          // 文字列リテラル内の '@' はマスク済みのため影響しない
          s = s.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, nm) => {
              const v = this.userVars ? this.userVars[nm.toLowerCase()] : undefined;
              if (v === undefined || v === null) return 'null';
              if (typeof v === 'number') return isFinite(v) ? `(${v})` : 'null';
              if (typeof v === 'boolean') return v ? 'true' : 'false';
              strMap.push(this._quoteLiteral(String(v)));
              return `__STR_${strMap.length - 1}__`;
          });

          // JSON アクセス演算子（-> ->> #> #>> @> <@）。
          // ユーザー変数の畳み込みより後に置くこと（`a < @lim` が '<@' に見えてしまうため）。
          // 比較演算子より強く結合するので、比較・論理の書き換えより前に畳む
          s = this._rewriteJsonOps(s);
          // PostgreSQL の ~ / ~* / !~ / !~* / ~~ / ~~* / !~~ / !~~*
          s = this._rewriteMatchOps(s);

          // LHS が数値リテラル / 文字列トークンの場合は列解決せずそのまま比較し、
          // 関数呼び出し（括弧を含む: UPPER(name) LIKE ... 等）はそのまま式として残す
          // （後続の関数マッピングと識別子解決が中身を処理する）
          const _lhs = (col) => {
              if (col.indexOf('(') !== -1) return col;
              // NULL / TRUE / FALSE はリテラル。列名として解決しようとすると
              // `NULL LIKE 'x'` が "Column 'null' not found." になっていた
              if (/^(null|true|false)$/i.test(col)) return col.toLowerCase();
              return (/^\d+(?:\.\d+)?$/.test(col) || /^__STR_\d+__$/.test(col))
                  ? col
                  : `__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases)`;
          };
          // LIKE / BETWEEN / IN / REGEXP の左辺: 識別子・リテラル、または関数呼び出し
          // （引数の括弧は1段のネストまで対応）
          const LHS = '([a-zA-Z0-9_.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)';
          // BETWEEN / IN の左辺は算術式まで取れる必要がある。
          // 識別子だけを拾っていたため `-1 BETWEEN 0 AND 10` が `-(1 >= 0 && 1 <= 10)`、
          // `a - b IN (...)` が `a - __in(b, ...)` と解釈され、
          // 真偽値ではなく数値が返っていた（WHERE では -1 が真扱いになり行が通る）。
          // 「被演算子（符号・括弧・関数呼び出しを含む）を算術演算子でつないだ並び」を
          // 貪欲に取る。比較・論理演算子やカンマは含めないので句の境界は越えない
          // 先頭に空白を含めないこと。含めると直前の語との間の空白まで飲み込み、
          // 置換後に `AND__not3(...)` のように語が繋がってしまう
          const _OPD = '-?(?:\\((?:[^()]|\\([^()]*\\))*\\)|[a-zA-Z0-9_.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)';
          const ALHS = '((?:' + _OPD + '\\s*(?:[-+*/%]|\\|\\|)\\s*)*' + _OPD + ')';
          // 左辺が単なる識別子・リテラルでないときは式としてそのまま埋め込む
          const _alhs = (col) => {
              const c = String(col).trim();
              return /^[a-zA-Z0-9_.]+$/.test(c) ? _lhs(c) : `(${c})`;
          };

          // 全文検索 MATCH (col, ...) AGAINST ('query' [IN BOOLEAN|NATURAL LANGUAGE MODE])。
          // 対象列を空白連結した1本のテキストに対して語照合する。真偽値としても
          // スコア（一致語数）としても使える。IN の書き換えより前に消すこと
          s = s.replace(/\bMATCH\s*\(([^()]*)\)\s+AGAINST\s*\(\s*((?:[^()]|\([^()]*\))*?)\s*\)/gi, (m, cols, arg) => {
              const parts = this.splitSelectClause(cols).map(c => c.trim()).filter(c => c !== '');
              if (parts.length === 0) throw new Error("MATCH requires at least one column.");
              const mm = arg.match(/^([\s\S]+?)\s+IN\s+(BOOLEAN|NATURAL\s+LANGUAGE)\s+MODE\s*$/i);
              const q = (mm ? mm[1] : arg).trim();
              const mode = mm ? mm[2].toUpperCase().replace(/\s+/g, ' ') : 'NATURAL LANGUAGE';
              return `__match_against(__concat_ws(' ', ${parts.join(', ')}), ${q}, '${mode}')`;
          });

          // ARRAY[...] コンストラクタ（PostgreSQL）。'ANY(ARRAY[...])' は量化比較が
          // 値リストとして扱えるよう、括弧付きのリストへ落とす
          if (/\bARRAY\s*\[/i.test(s)) {
              for (let g = 0; g < 64; g++) {
                  const am = s.match(/\bARRAY\s*\[/i);
                  if (!am) break;
                  const open = am.index + am[0].length - 1;
                  let depth = 0, close = -1;
                  for (let i = open; i < s.length; i++) {
                      if (s[i] === '[') depth++;
                      else if (s[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
                  }
                  if (close === -1) throw new Error("Syntax Error in ARRAY[...]: missing ']'.");
                  const items = s.slice(open + 1, close);
                  // 直前が ANY/SOME/ALL の開き括弧なら、量化比較が読める素の値リストにする
                  const before = s.slice(0, am.index).replace(/\s+$/, '');
                  const quant = /\b(?:ANY|SOME|ALL)\s*\($/i.test(before);
                  s = s.slice(0, am.index) + (quant ? items : `__array(${items})`) + s.slice(close + 1);
              }
          }

          // 添字・スライス a[n] / a[lo:hi]（SQL は 1 始まり）。ARRAY[...] を畳んだ後なので、
          // ここに残る '[' は必ず「直前の 1 単位」に対する後置演算子である
          s = this._rewriteSubscripts(s);

          // (s1, e1) OVERLAPS (s2, e2): 期間の重なり。行コンストラクタの書き換えより前に消す
          s = s.replace(/\(((?:[^()]|\([^()]*\))*)\)\s*OVERLAPS\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (m, a, b) => {
              const l = this.splitSelectClause(a), r = this.splitSelectClause(b);
              if (l.length !== 2 || r.length !== 2) throw new Error("OVERLAPS requires two (start, end) pairs.");
              return `__overlaps(${l[0]}, ${l[1]}, ${r[0]}, ${r[1]})`;
          });

          // BETWEEN SYMMETRIC: 境界の大小が逆でも受け付ける（SQL標準）
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?BETWEEN\\s+SYMMETRIC\\s+(.+?)\\s+AND\\s+(.+?)(?=\\s*(?:AND\\b|OR\\b|\\)|$))', 'gi'),
              (m, col, not, a, b) => `${not ? '!' : ''}((${_lhs(col)} >= __least(${a}, ${b})) && (${_lhs(col)} <= __greatest(${a}, ${b})))`);

          // 行コンストラクタ比較 (a, b) = (c, d) / (a, b) IN ((1,2),(3,4)) を
          // 列ごとの比較へ展開する（IN / 比較演算子の書き換えより前に行う）
          s = s.replace(/\bROW\s*\(/gi, '(');
          s = this._rewriteRowConstructors(s);

          // <expr> AT TIME ZONE <tz>: 後置演算子なので COLLATE と同じ後方走査で被演算子を取る
          if (/\bAT\s+TIME\s+ZONE\b/i.test(s)) {
              for (let g = 0; g < 32; g++) {
                  const tm = s.match(/\bAT\s+TIME\s+ZONE\s+(__STR_\d+__|'[^']*'|[a-zA-Z_][a-zA-Z0-9_]*)/i);
                  if (!tm) break;
                  const { start, end } = this._operandStartBefore(s, tm.index, 'AT TIME ZONE');
                  const operand = s.slice(start, end + 1);
                  const tz = /^[a-zA-Z_]/.test(tm[1]) && !/^__STR_/.test(tm[1]) ? `'${tm[1]}'` : tm[1];
                  // タイムゾーン名がリテラルなら妥当性をコンパイル時に検査する
                  // （実行時 throw は行評価の catch に飲まれて黙って NULL になるため）
                  {
                      const lit = /^__STR_(\d+)__$/.exec(tm[1]);
                      const nameText = lit ? this._unquoteLiteral(strMap[Number(lit[1])])
                                           : (/^'/.test(tm[1]) ? tm[1].slice(1, -1) : tm[1]);
                      __EXPR_LIB.__at_time_zone('1970-01-01 00:00:00', nameText);
                  }
                  s = s.slice(0, start) + `__at_time_zone(${operand}, ${tz})` + s.slice(tm.index + tm[0].length);
              }
          }

          // <expr> COLLATE <name>: 比較・並べ替え用の正規化（キャストと同じく後置で最も強く結合）
          s = this._rewriteCollate(s);

          // PostgreSQL のキャスト演算子 expr::TYPE。最も強く結合するので連結より先に畳む
          // （被演算子は '::' の直前から後方走査。関数呼び出しや括弧も 1 単位で拾える）
          s = this._rewriteCastOp(s);

          // 日付 ± INTERVAL（キャスト後・連結前。DATE '...' は既に __cast(...) になっている）
          s = this._rewriteIntervalMath(s);

          // '||' 連結演算子 → __concat_op(...)。
          // LIKE / BETWEEN / IN の左辺として使えるよう、それらの書き換えより前に畳む
          // （'OR' が '||' へ写像されるのはさらに後なので、ここで見える '||' は連結だけ）
          s = this._rewriteConcatOp(s);

          // 量化比較: <expr> <op> ANY|SOME|ALL (v1, v2, ...) を OR / AND へ分配する。
          // サブクエリは expandSubqueries が既に値リストへ畳み込んでいる。
          // 空リストは ANY→FALSE（どれとも一致しない）/ ALL→TRUE（反例なし）が SQL 標準。
          s = s.replace(new RegExp(LHS + '\\s*(=|<>|!=|>=|<=|>|<)\\s*(ANY|SOME|ALL)\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'),
              (m, col, op, quant, listStr) => {
                  const items = this.splitSelectClause(listStr).map(x => x.trim()).filter(x => x !== '');
                  const isAll = quant.toUpperCase() === 'ALL';
                  if (items.length === 0) return isAll ? 'TRUE' : 'FALSE';
                  const joiner = isAll ? ' AND ' : ' OR ';
                  return '(' + items.map(v => `${_lhs(col)} ${op} ${v}`).join(joiner) + ')';
              });

          // IS [NOT] DISTINCT FROM / <=> の左辺は NULL・TRUE・FALSE や負数リテラルも取り得る。
          // 通常の LHS（列・関数呼び出し向け）だと '-1' の符号が落ち NULL が列名扱いになるため、
          // これらの演算子には符号とキーワードリテラルを許す専用パターンを使う。
          const NDL = '(-?[a-zA-Z0-9_.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)';
          const _ndl = (col) => (/^-?\d+(?:\.\d+)?$/.test(col) || /^__STR_\d+__$/.test(col) || /^(null|true|false)$/i.test(col))
              ? col
              : `__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases)`;
          // IS [NOT] DISTINCT FROM: NULL を値として扱う比較（NULL IS DISTINCT FROM NULL は偽）。
          // IS NULL 変換より前に処理する（'IS NOT' の部分一致を避ける）
          s = s.replace(new RegExp(NDL + '\\s+IS\\s+(NOT\\s+)?DISTINCT\\s+FROM\\s+(.+?)(?=\\s*(?:AND\\b|OR\\b|\\)|$))', 'gi'),
              (m, col, not, rhs) => `${not ? '!' : ''}__is_distinct(${_ndl(col)}, ${rhs})`);
          // MySQL の NULL 安全等価演算子 <=>
          s = s.replace(new RegExp(NDL + '\\s*<=>\\s*(.+?)(?=\\s*(?:AND\\b|OR\\b|\\)|$))', 'gi'),
              (m, col, rhs) => `!__is_distinct(${_ndl(col)}, ${rhs})`);

          // <expr> IS [NOT] JSON [VALUE|OBJECT|ARRAY|SCALAR]（SQL:2016）。
          // 左辺に NULL / TRUE / FALSE / 負数リテラルが来るので NDL 側のパターンを使う。
          // IS NULL / IS UNKNOWN の変換より前に消すこと
          // 左辺は括弧で包まれた式も取り得る（(NULL) IS JSON など）ので専用パターンを使う
          const JLHS = '(\\((?:[^()]|\\([^()]*\\))*\\)|-?[a-zA-Z0-9_.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)';
          s = s.replace(new RegExp(JLHS + '\\s+IS\\s+(NOT\\s+)?JSON(?:\\s+(VALUE|OBJECT|ARRAY|SCALAR))?\\b', 'gi'),
              (m, col, not, kind) => {
                  // 関数呼び出し（JSON_OBJECT(...) IS JSON など）は列名ではないので
                  // そのまま式として残す。_ndl に通すと '__json_object(...)' という
                  // 名前の列を探しに行って「見つからない」と言われていた
                  const isCall = /^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(col);
                  const operand = (col[0] === '(' || isCall) ? col : _ndl(col);
                  return `${not ? '!' : ''}__is_json(${operand}, '${(kind || 'VALUE').toUpperCase()}')`;
              });

          // <expr> IS [NOT] TRUE|FALSE (SQL標準の真偽述語)。
          // NULL に対しては IS TRUE / IS FALSE がどちらも偽、IS NOT TRUE / IS NOT FALSE が
          // どちらも真になる（3値論理）ため、単純な `=== true` 比較では表せず専用ヘルパーを使う。
          // IS NULL / IS UNKNOWN の変換より前に置くこと（`IS NOT TRUE` の NOT を取り違えないため）
          s = this._rewriteIsBool(s);

          // IS [NOT] UNKNOWN (SQL標準): 3値論理の UNKNOWN 判定。ブール式に対する IS NULL と同義
          // IS [NOT] UNKNOWN も IS [NOT] NULL と同じ述語（比較ではない）ので専用トークンへ
          s = s.replace(/\bIS\s+NOT\s+UNKNOWN\b/gi, ' __ISNOTNULL__').replace(/\bIS\s+UNKNOWN\b/gi, ' __ISNULL__');
          // IS [NOT] NULL は「NULL かどうか」を真偽で返す述語であって比較ではない。
          // そのまま `=== null` にすると、後段の 3 値論理の畳み込み（_rewriteCompareOps）が
          // __eq(x, null) へ変えてしまい必ず UNKNOWN になる。専用の後置トークンへ退避し、
          // 畳み込みの直後にヘルパ呼び出しへ直す
          s = s.replace(/\bIS\s+NOT\s+NULL\b/gi, ' __ISNOTNULL__').replace(/\bIS\s+NULL\b/gi, ' __ISNULL__');
          s = s.replace(new RegExp(ALHS + '\\s+(NOT\\s+)?BETWEEN\\s+(.+?)\\s+AND\\s+(.+?)(?=\\s*(?:AND\\b|OR\\b|\\)|$))', 'gi'), (m, col, not, a, b) => `${not ? '!' : ''}(${_alhs(col)} >= ${a} && ${_alhs(col)} <= ${b})`);
          // LIKE ANY / ALL (pat1, pat2, ...): 複数パターンの OR / AND（Snowflake / Teradata）
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?(?:LIKE|ILIKE)\\s+(ANY|SOME|ALL)\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'),
              (m, col, not, quant, listStr) => {
                  const ci = /ilike/i.test(m);
                  const items = this.splitSelectClause(listStr).map(x => x.trim()).filter(x => x !== '');
                  const isAll = quant.toUpperCase() === 'ALL';
                  if (items.length === 0) return isAll ? 'TRUE' : 'FALSE';
                  const body = '(' + items.map(v => `${ci ? '__ilike' : '__like'}(${_lhs(col)}, ${v})`).join(isAll ? ' && ' : ' || ') + ')';
                  return not ? `!${body}` : body;
              });
          // LIKE ... ESCAPE 'c'（エスケープ文字は1文字。ESCAPE 付きを先に処理する）
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?LIKE\\s+(__STR_\\d+__)\\s+ESCAPE\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strRef, escIdx) => {
              const escLit = this._unquoteLiteral(strMap[Number(escIdx)]);
              if (escLit.length !== 1) throw new Error("ESCAPE clause requires a single character.");
              return not ? `__not3(__like(${_lhs(col)}, ${strRef}, __STR_${escIdx}__))` : `__like(${_lhs(col)}, ${strRef}, __STR_${escIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?LIKE\\s+(__STR_\\d+__)', 'gi'), (m, col, not, strRef) => not ? `__not3(__like(${_lhs(col)}, ${strRef}))` : `__like(${_lhs(col)}, ${strRef})`);
          // ILIKE (PostgreSQL): 大文字小文字を区別しない LIKE
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?ILIKE\\s+(__STR_\\d+__)\\s+ESCAPE\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strRef, escIdx) => {
              const escLit = this._unquoteLiteral(strMap[Number(escIdx)]);
              if (escLit.length !== 1) throw new Error("ESCAPE clause requires a single character.");
              return not ? `__not3(__ilike(${_lhs(col)}, ${strRef}, __STR_${escIdx}__))` : `__ilike(${_lhs(col)}, ${strRef}, __STR_${escIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?ILIKE\\s+(__STR_\\d+__)', 'gi'), (m, col, not, strRef) => not ? `__not3(__ilike(${_lhs(col)}, ${strRef}))` : `__ilike(${_lhs(col)}, ${strRef})`);
          // 右辺がリテラルでない LIKE / ILIKE（`name LIKE '%' || key || '%'` /
          // `LIKE pat_col` / `LIKE CONCAT(a, '%')`）。リテラル形は上で処理済みなので
          // ここへ来るのは列・関数呼び出し・連結などの式だけ。以前はどれも
          // 「Malformed expression」になり、絞り込み条件を式で組めなかった。
          // 右辺は「被演算子を算術・連結演算子でつないだ並び」(ALHS) までを取るので、
          // 後続の AND / OR / ORDER BY といった句の境界は越えない
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?(LIKE|ILIKE)\\s+' + ALHS
                  + '(?:\\s+ESCAPE\\s+(__STR_\\d+__))?', 'gi'),
              (m, col, not, kw, pat, escRef) => {
                  const fn = kw.toUpperCase() === 'ILIKE' ? '__ilike' : '__like';
                  const body = `${fn}(${_lhs(col)}, ${_alhs(pat)}${escRef ? ', ' + escRef : ''})`;
                  return not ? `__not3(${body})` : body;
              });
          // SIMILAR TO (SQL標準): LIKE のワイルドカードと正規表現メタ文字を併用するパターン
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?SIMILAR\\s+TO\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strIdx) => {
              // ReDoS 緩和: 実行時 throw は行評価の catch に飲まれるのでコンパイル時に弾く
              const lit = strMap[Number(strIdx)];
              if (lit && lit.length > 1002) throw new Error("SIMILAR TO pattern too long (max 1000 characters).");
              return not ? `__not3(__similar(${_lhs(col)}, __STR_${strIdx}__))` : `__similar(${_lhs(col)}, __STR_${strIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?REGEXP\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strIdx) => {
              // DoSガード(ReDoS緩和): 異常に長い正規表現パターンをコンパイル時に拒否する
              const lit = strMap[Number(strIdx)];
              if (lit && lit.length > 1002) throw new Error("REGEXP pattern too long (max 1000 characters).");
              return not ? `__not3(__regexp(${_lhs(col)}, __STR_${strIdx}__))` : `__regexp(${_lhs(col)}, __STR_${strIdx}__)`;
          });

          // Execute IN / NOT IN replacements before standalone NOT replacements
          // リストは1段の括弧ネストまで対応（IN (ROUND(1.4), 2) 等の関数呼び出しを許容）
          s = s.replace(new RegExp(ALHS + '\\s+NOT\\s+IN\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'), (m, col, vals) => `__not3(__in(${_alhs(col)}, [${vals}]))`);
          s = s.replace(new RegExp(ALHS + '\\s+IN\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'), (m, col, vals) => `__in(${_alhs(col)}, [${vals}])`);

          // 相関サブクエリのトークン（expandSubqueries が登録）を実行時評価の呼び出しへ変換する
          // 3 値論理の否定。素の `!` だと UNKNOWN(null) が true に化けて、
          // NOT IN が NULL を含むリストの行まで拾う（v1.24 で素の IN 側だけ直っていた）
          s = s.replace(new RegExp(LHS + '\\s+NOT\\s+IN\\s+__CORRIN_(\\d+)__', 'gi'), (m, col, k) => `__not3(__corr_in(${k}, ${_lhs(col)}, ptrs, dbTables, aliases))`);
          s = s.replace(new RegExp(LHS + '\\s+IN\\s+__CORRIN_(\\d+)__', 'gi'), (m, col, k) => `__corr_in(${k}, ${_lhs(col)}, ptrs, dbTables, aliases)`);
          s = s.replace(/__CORREX_(\d+)__/g, (m, k) => `__corr_exists(${k}, ptrs, dbTables, aliases)`);
          s = s.replace(/__CORRSC_(\d+)__/g, (m, k) => `__corr_scalar(${k}, ptrs, dbTables, aliases)`);

          // CAST(expr AS TYPE) -> __cast(expr, 'TYPE', p, s)。括弧の対応を見て内側から畳む。
          // 型名は 'DECIMAL(10,2)' / 'DOUBLE PRECISION' / 'VARCHAR(20)' の各形を受ける。
          // TRY_CAST / TRY_CONVERT（SQL Server の安全変換）は __cast が変換不可時に
          // null を返すので実装を共用する。TRY_ 付きを先に畳むこと
          // （CAST の頭一致が TRY_CAST の中を先に食わないよう、\b で語頭を固定してある）
          s = this._rewriteCastCalls(s, 'TRY_CAST', 'as');
          s = this._rewriteCastCalls(s, 'TRY_CONVERT', 'type,expr');
          s = this._rewriteCastCalls(s, 'CAST', 'as');
          // CONVERT(expr, TYPE) は CAST の別形（MySQL互換）。
          // SQL Server 形 CONVERT(TYPE, expr) は引数順が逆なので型名が先頭に来る形も受ける
          s = this._rewriteCastCalls(s, 'CONVERT', 'expr,type');
          s = this._rewriteCastCalls(s, 'CONVERT', 'type,expr');

          // String/Math/Date/Logic Functions mapping
          s = s.replace(/\bUPPER\(/gi, '__upper(');
          s = s.replace(/\bLOWER\(/gi, '__lower(');
          s = s.replace(/\bLENGTH\(/gi, '__length(');
          s = s.replace(/\bROUND\(/gi, '__round(');
          s = s.replace(/\bCOALESCE\(/gi, '__coalesce(');
          s = s.replace(/\bSUBSTRING_INDEX\(/gi, '__substring_index(');
          s = s.replace(/\bSUBSTRING\(/gi, '__substring(');
          s = s.replace(/\bCONCAT_WS\(/gi, '__concat_ws(');
          s = s.replace(/\bCONCAT\(/gi, '__concat(');
          s = s.replace(/\bLOCATE\(/gi, '__locate(');
          s = s.replace(/\bCEILING\(/gi, '__ceil(');
          s = s.replace(/\bTRUNCATE\(/gi, '__truncate(');
          s = s.replace(/\bREPLACE\(/gi, '__replace(');
          s = s.replace(/\bTRIM\(/gi, '__trim(');
          s = s.replace(/\bABS\(/gi, '__abs(');
          s = s.replace(/\bCEIL\(/gi, '__ceil(');
          s = s.replace(/\bFLOOR\(/gi, '__floor(');
          s = s.replace(/\bNOW\(\)/gi, '__now()');
          s = s.replace(/\bLPAD\(/gi, '__lpad(');
          s = s.replace(/\bRPAD\(/gi, '__rpad(');
          s = s.replace(/\bPOWER\(/gi, '__power(');
          s = s.replace(/\bSQRT\(/gi, '__sqrt(');
          s = s.replace(/\bYEAR\(/gi, '__year(');
          s = s.replace(/\bMONTH\(/gi, '__month(');
          s = s.replace(/\bDAY\(/gi, '__day(');
          s = s.replace(/\bMOD\(/gi, '__mod(');
          s = s.replace(/\bSIGN\(/gi, '__sign(');
          s = s.replace(/\bRAND\(\)/gi, '__rand()');
          s = s.replace(/\bDATEDIFF\(/gi, '__datediff(');
          s = s.replace(/\bDATE\(/gi, '__date(');
          s = s.replace(/\bIFNULL\(/gi, '__ifnull(');
          s = s.replace(/\bNULLIF\(/gi, '__nullif(');
          s = s.replace(/\bIF\(/gi, '__if(');
          s = s.replace(/\bLEFT\(/gi, '__left(');
          s = s.replace(/\bRIGHT\(/gi, '__right(');
          s = s.replace(/\bINSTR\(/gi, '__instr(');
          s = s.replace(/\bREVERSE\(/gi, '__reverse(');
          s = s.replace(/\bREPEAT\(/gi, '__repeat(');
          s = s.replace(/\bGREATEST\(/gi, '__greatest(');
          s = s.replace(/\bLEAST\(/gi, '__least(');
          s = s.replace(/\bEXP\(/gi, '__exp(');
          s = s.replace(/\bLOG10\(/gi, '__log10(');
          s = s.replace(/\bLOG\(/gi, '__log(');
          s = s.replace(/\bPI\(\)/gi, '__pi()');
          s = s.replace(/\bHOUR\(/gi, '__hour(');
          s = s.replace(/\bMINUTE\(/gi, '__minute(');
          s = s.replace(/\bSECOND\(/gi, '__second(');
          // 追加関数: 文字列 / 三角関数 / 追加日付関数
          s = s.replace(/\bLTRIM\(/gi, '__ltrim(');
          s = s.replace(/\bRTRIM\(/gi, '__rtrim(');
          s = s.replace(/\bASCII\(/gi, '__ascii(');
          s = s.replace(/\bCHAR\(/gi, '__char(');
          s = s.replace(/\bSINH\(/gi, '__sinh(');
          s = s.replace(/\bASIN\(/gi, '__asin(');
          s = s.replace(/\bACOS\(/gi, '__acos(');
          s = s.replace(/\bATAN2\(/gi, '__atan2(');
          s = s.replace(/\bATAN\(/gi, '__atan(');
          s = s.replace(/\bSIN\(/gi, '__sin(');
          s = s.replace(/\bCOS\(/gi, '__cos(');
          s = s.replace(/\bTAN\(/gi, '__tan(');
          s = s.replace(/\bDEGREES\(/gi, '__degrees(');
          s = s.replace(/\bRADIANS\(/gi, '__radians(');
          s = s.replace(/\bLN\(/gi, '__ln(');
          s = s.replace(/\bCBRT\(/gi, '__cbrt(');
          s = s.replace(/\bDATE_ADD\(/gi, '__date_add(');
          s = s.replace(/\bDATE_SUB\(/gi, '__date_sub(');
          s = s.replace(/\bDAYOFWEEK\(/gi, '__dayofweek(');
          s = s.replace(/\bDAYOFYEAR\(/gi, '__dayofyear(');
          s = s.replace(/\bQUARTER\(/gi, '__quarter(');
          s = s.replace(/\bLAST_DAY\(/gi, '__last_day(');
          s = s.replace(/\bCURDATE\(\)/gi, '__curdate()');
          s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, '__now()');
          s = s.replace(/\bCURRENT_DATE\b/gi, '__curdate()');
          // v1.1 追加関数: 数値 / 文字列 / 日付 / JSON / メタ情報
          s = s.replace(/\bPOW\(/gi, '__power(');
          s = s.replace(/\bLOG2\(/gi, '__log2(');
          s = s.replace(/\bCOT\(/gi, '__cot(');
          s = s.replace(/\bDATE_FORMAT\(/gi, '__date_format(');
          s = s.replace(/\bFORMAT\(/gi, '__format(');
          s = s.replace(/\bHEX\(/gi, '__hex(');
          s = s.replace(/\bBIN\(/gi, '__bin(');
          s = s.replace(/\bOCT\(/gi, '__oct(');
          s = s.replace(/\bCONV\(/gi, '__conv(');
          s = s.replace(/\bSPACE\(/gi, '__space(');
          s = s.replace(/\bSTRCMP\(/gi, '__strcmp(');
          s = s.replace(/\bELT\(/gi, '__elt(');
          s = s.replace(/\bFIELD\(/gi, '__field(');
          s = s.replace(/\bMID\(/gi, '__substring(');
          s = s.replace(/\bUCASE\(/gi, '__upper(');
          s = s.replace(/\bLCASE\(/gi, '__lower(');
          s = s.replace(/\bINITCAP\(/gi, '__initcap(');
          s = s.replace(/\bMONTHNAME\(/gi, '__monthname(');
          s = s.replace(/\bDAYNAME\(/gi, '__dayname(');
          s = s.replace(/\bWEEKOFYEAR\(/gi, '__weekofyear(');
          s = s.replace(/\bWEEKDAY\(/gi, '__weekday(');
          s = s.replace(/\bWEEK\(/gi, '__week(');
          s = s.replace(/\bUNIX_TIMESTAMP\(/gi, '__unix_timestamp(');
          s = s.replace(/\bFROM_UNIXTIME\(/gi, '__from_unixtime(');
          s = s.replace(/\bADDDATE\(/gi, '__date_add(');
          s = s.replace(/\bSUBDATE\(/gi, '__date_sub(');
          s = s.replace(/\bJSON_EXTRACT\(/gi, '__json_extract(');
          s = s.replace(/\bJSON_VALUE\(/gi, '__json_extract(');
          s = s.replace(/\bJSON_ARRAY\(/gi, '__json_array(');
          s = s.replace(/\bJSON_OBJECT\(/gi, '__json_object(');
          s = s.replace(/\bJSON_LENGTH\(/gi, '__json_length(');
          s = s.replace(/\bJSON_KEYS\(/gi, '__json_keys(');
          s = s.replace(/\bJSON_VALID\(/gi, '__json_valid(');
          s = s.replace(/\bJSON_TYPE\(/gi, '__json_type(');
          s = s.replace(/\bJSON_CONTAINS\(/gi, '__json_contains(');
          s = s.replace(/\bJSON_SET\(/gi, '__json_set(');
          s = s.replace(/\bJSON_REMOVE\(/gi, '__json_remove(');
          s = s.replace(/\bUUID\(\)/gi, '__uuid()');
          s = s.replace(/\bVERSION\(\)/gi, '__version()');
          s = s.replace(/\bDATABASE\(\)/gi, '__database()');
          // CURRENT_CATALOG / CURRENT_DATABASE（SQL標準 / PostgreSQL）は DATABASE() と同義
          s = s.replace(/\bCURRENT_CATALOG\b(?:\s*\(\s*\))?/gi, '__database()');
          s = s.replace(/\bCURRENT_DATABASE\s*\(\s*\)/gi, '__database()');
          // v1.2 追加関数: 正規表現 / 文字列 / ビット / 時刻
          s = s.replace(/\bREGEXP_REPLACE\(/gi, '__regexp_replace(');
          s = s.replace(/\bREGEXP_SUBSTR\(/gi, '__regexp_substr(');
          s = s.replace(/\bREGEXP_LIKE\(/gi, '__regexp_like(');
          s = s.replace(/\bSPLIT_PART\(/gi, '__split_part(');
          s = s.replace(/\bQUOTE\(/gi, '__quote(');
          s = s.replace(/\bBIT_COUNT\(/gi, '__bit_count(');
          s = s.replace(/\bSEC_TO_TIME\(/gi, '__sec_to_time(');
          s = s.replace(/\bTIME_TO_SEC\(/gi, '__time_to_sec(');
          s = s.replace(/\bMAKEDATE\(/gi, '__makedate(');
          s = s.replace(/\bSTR_TO_DATE\(/gi, '__str_to_date(');
          // v1.3 追加: 別名・時刻部分抽出
          s = s.replace(/\bCHAR_LENGTH\(/gi, '__char_length(');
          s = s.replace(/\bCHARACTER_LENGTH\(/gi, '__char_length(');
          s = s.replace(/\bUTC_TIMESTAMP\(\)/gi, '__now()');
          s = s.replace(/\bSYSDATE\(\)/gi, '__now()');
          s = s.replace(/\bTIME\(/gi, '__time(');
          // v1.5 追加関数: ハッシュ / エンコード / ネットワーク / 文字列 / 日付 / JSON
          s = s.replace(/\bMD5\(/gi, '__md5(');
          s = s.replace(/\bCRC32\(/gi, '__crc32(');
          s = s.replace(/\bTO_BASE64\(/gi, '__to_base64(');
          s = s.replace(/\bFROM_BASE64\(/gi, '__from_base64(');
          s = s.replace(/\bINET_ATON\(/gi, '__inet_aton(');
          s = s.replace(/\bINET_NTOA\(/gi, '__inet_ntoa(');
          s = s.replace(/\bSOUNDEX\(/gi, '__soundex(');
          s = s.replace(/\bTRANSLATE\(/gi, '__translate(');
          // MySQL の文字列関数 INSERT(str, pos, len, newstr)。INSERT 文はこの層に来ないため衝突しない
          s = s.replace(/\bINSERT\(/gi, '__str_insert(');
          s = s.replace(/\bCOSH\(/gi, '__cosh(');
          s = s.replace(/\bTANH\(/gi, '__tanh(');
          s = s.replace(/\bTO_DAYS\(/gi, '__to_days(');
          s = s.replace(/\bFROM_DAYS\(/gi, '__from_days(');
          s = s.replace(/\bMAKETIME\(/gi, '__maketime(');
          s = s.replace(/\bCURTIME\(\)/gi, '__curtime()');
          s = s.replace(/\bCURRENT_TIME\b/gi, '__curtime()');
          s = s.replace(/\bUTC_DATE(?:\(\))?/gi, '__curdate()');
          s = s.replace(/\bDAYOFMONTH\(/gi, '__day(');
          s = s.replace(/\bTRUNC\(/gi, '__truncate(');
          s = s.replace(/\bRANDOM\(\)/gi, '__rand()');
          s = s.replace(/\bNVL\(/gi, '__ifnull(');
          s = s.replace(/\bFORMAT_BYTES\(/gi, '__format_bytes(');
          s = s.replace(/\bJSON_PRETTY\(/gi, '__json_pretty(');
          s = s.replace(/\bJSON_QUOTE\(/gi, '__json_quote(');
          s = s.replace(/\bJSON_UNQUOTE\(/gi, '__json_unquote(');
          s = s.replace(/\bJSON_ARRAY_APPEND\(/gi, '__json_array_append(');
          s = s.replace(/\bJSON_ARRAY_INSERT\(/gi, '__json_array_insert(');
          s = s.replace(/\bJSON_MERGE_PATCH\(/gi, '__json_merge_patch(');
          // v1.33 追加関数: 他DBで一般的なのに未実装だったスカラー関数
          s = s.replace(/\bBTRIM\(/gi, '__btrim(');
          if (/\bENCODE\s*\(/i.test(s)) {
              this._scanCallArgs(s, 'ENCODE').forEach(args => {
                  if (args.length !== 2) return;
                  const fmt = this._argLiteralText(args[1], strMap);
                  if (fmt !== null) __EXPR_LIB.__encode('', fmt);
              });
          }
          s = s.replace(/\bENCODE\(/gi, '__encode(');
          s = s.replace(/\bORD\(/gi, '__ord(');
          s = s.replace(/\bUNISTR\(/gi, '__unistr(');
          s = s.replace(/\bCONTAINS\(/gi, '__contains(');
          s = s.replace(/\bTIMEDIFF\(/gi, '__timediff(');
          s = s.replace(/\bYEARWEEK\(/gi, '__yearweek(');
          s = s.replace(/\bPERIOD_ADD\(/gi, '__period_add(');
          s = s.replace(/\bPERIOD_DIFF\(/gi, '__period_diff(');
          s = s.replace(/\bJULIAN_DAY\(/gi, '__julian_day(');
          s = s.replace(/\bJULIANDAY\(/gi, '__julian_day(');
          // キーワード引数の綴りはコンパイル時に検査する（実行時 throw は行評価の
          // catch に飲まれて黙って NULL になるため。AT TIME ZONE と同じ扱い）
          if (/\bCONVERT_TZ\s*\(/i.test(s)) {
              this._scanCallArgs(s, 'CONVERT_TZ').forEach(args => {
                  if (args.length !== 3) return;   // 引数個数の誤りは arity 検査に任せる
                  [1, 2].forEach(k => {
                      const nm = this._argLiteralText(args[k], strMap);
                      if (nm !== null) __EXPR_LIB.__tz_minutes(nm);
                  });
              });
          }
          s = s.replace(/\bCONVERT_TZ\(/gi, '__convert_tz(');
          if (/\bJSON_SEARCH\s*\(/i.test(s)) {
              this._scanCallArgs(s, 'JSON_SEARCH').forEach(args => {
                  if (args.length !== 3) return;
                  const mode = this._argLiteralText(args[1], strMap);
                  if (mode !== null) __EXPR_LIB.__json_search('{}', mode, 'x');
              });
          }
          s = s.replace(/\bJSON_SEARCH\(/gi, '__json_search(');
          s = s.replace(/\bJSON_MERGE_PRESERVE\(/gi, '__json_merge_preserve(');
          s = s.replace(/\bARRAY_DISTINCT\(/gi, '__array_distinct(');
          s = s.replace(/\bARRAY_CAT\(/gi, '__array_cat(');
          s = s.replace(/\bARRAY_REVERSE\(/gi, '__array_reverse(');
          // LOCALTIME / LOCALTIMESTAMP は MySQL に合わせて NOW() と同義（括弧は任意）
          s = s.replace(/\bLOCALTIMESTAMP\b(\s*\(\s*\))?/gi, '__now()');
          s = s.replace(/\bLOCALTIME\b(\s*\(\s*\))?/gi, '__now()');
          s = s.replace(/\bJSON_DEPTH\(/gi, '__json_depth(');
          // 部分更新（MySQL）: INSERT は無いパスだけ / REPLACE は有るパスだけ書く
          s = s.replace(/\bJSON_INSERT\(/gi, '__json_insert(');
          s = s.replace(/\bJSON_REPLACE\(/gi, '__json_replace(');
          s = s.replace(/\bJSON_CONTAINS_PATH\(/gi, '__json_contains_path(');
          // v1.6 追加関数: ハッシュ / バイト長 / 日付切り捨て / 型 / 別名 / シーケンス
          s = s.replace(/\bSHA1\(/gi, '__sha1(');
          s = s.replace(/\bSHA\(/gi, '__sha1(');
          // SHA-2 系（長い綴りから順に置換する）
          s = s.replace(/\bSHA256\(/gi, '__sha256(');
          s = s.replace(/\bSHA224\(/gi, '__sha224(');
          s = s.replace(/\bSHA2\(/gi, '__sha2(');
          s = s.replace(/\bSUBSTR\(/gi, '__substring(');
          s = s.replace(/\bIIF\(/gi, '__if(');
          s = s.replace(/\bOCTET_LENGTH\(/gi, '__octet_length(');
          s = s.replace(/\bBIT_LENGTH\(/gi, '__bit_length(');
          s = s.replace(/\bUNHEX\(/gi, '__unhex(');
          s = s.replace(/\bDATE_TRUNC\(/gi, '__date_trunc(');
          s = s.replace(/\bTYPEOF\(/gi, '__typeof(');
          s = s.replace(/\bREGEXP_COUNT\(/gi, '__regexp_count(');
          // シーケンス関数はエンジン到達用に dbTables を第1引数として注入する
          s = s.replace(/\bNEXTVAL\s*\(/gi, '__nextval(dbTables, ');
          s = s.replace(/\bCURRVAL\s*\(/gi, '__currval(dbTables, ');
          s = s.replace(/\bSETVAL\s*\(/gi, '__setval(dbTables, ');
          // v1.8 追加関数: 商用DB(Oracle / SQL Server / PostgreSQL)頻用のスカラー関数と別名
          s = s.replace(/\bDECODE\(/gi, '__decode(');
          s = s.replace(/\bNVL2\(/gi, '__nvl2(');
          s = s.replace(/\bZEROIFNULL\(/gi, '__zeroifnull(');
          s = s.replace(/\bNULLIFZERO\(/gi, '__nullifzero(');
          s = s.replace(/\bCHOOSE\(/gi, '__choose(');
          s = s.replace(/\bISNULL\(/gi, '__ifnull(');
          s = s.replace(/\bSTARTS_WITH\(/gi, '__starts_with(');
          s = s.replace(/\bENDS_WITH\(/gi, '__ends_with(');
          s = s.replace(/\bCHARINDEX\(/gi, '__charindex(');
          s = s.replace(/\bLEN\(/gi, '__len(');
          s = s.replace(/\bSTUFF\(/gi, '__stuff(');
          s = s.replace(/\bREGEXP_INSTR\(/gi, '__regexp_instr(');
          s = s.replace(/\bSQUARE\(/gi, '__square(');
          s = s.replace(/\bPOW\(/gi, '__power(');
          s = s.replace(/\bGCD\(/gi, '__gcd(');
          s = s.replace(/\bLCM\(/gi, '__lcm(');
          s = s.replace(/\bFACTORIAL\(/gi, '__factorial(');
          s = s.replace(/\bWIDTH_BUCKET\(/gi, '__width_bucket(');
          s = s.replace(/\bADD_MONTHS\(/gi, '__add_months(');
          s = s.replace(/\bMONTHS_BETWEEN\(/gi, '__months_between(');
          s = s.replace(/\bDATE_PART\(/gi, '__date_part(');
          s = s.replace(/\bGETDATE\(\)/gi, '__now()');
          s = s.replace(/\bSYSTIMESTAMP\b(?:\(\))?/gi, '__now()');
          // v1.9 追加関数: 変換 / 文字列 / ビット演算 / 日付ビルダー
          s = s.replace(/\bQUOTENAME\(/gi, '__quotename(');
          s = s.replace(/\bPATINDEX\(/gi, '__patindex(');
          s = s.replace(/\bBITAND\(/gi, '__bitand(');
          s = s.replace(/\bBITOR\(/gi, '__bitor(');
          s = s.replace(/\bBITXOR\(/gi, '__bitxor(');
          s = s.replace(/\bBITNOT\(/gi, '__bitnot(');
          s = s.replace(/\bISNUMERIC\(/gi, '__isnumeric(');
          s = s.replace(/\bEOMONTH\(/gi, '__eomonth(');
          s = s.replace(/\bMAKE_DATE\(/gi, '__make_date(');
          s = s.replace(/\bMAKE_TIMESTAMP\(/gi, '__make_timestamp(');
          s = s.replace(/\bTO_NUMBER\(/gi, '__to_number(');
          s = s.replace(/\bTO_TIMESTAMP\(/gi, '__to_timestamp(');
          s = s.replace(/\bTO_DATE\(/gi, '__to_date(');
          s = s.replace(/\bCHR\(/gi, '__char(');
          s = s.replace(/\bSTRPOS\(/gi, '__instr(');
          s = s.replace(/\bREPLICATE\(/gi, '__repeat(');
          // v1.11 追加関数: 商用DB(Oracle / SQL Server / PostgreSQL / DB2)頻用
          s = s.replace(/\bTO_CHAR\(/gi, '__to_char(');
          s = s.replace(/\bTO_HEX\(/gi, '__to_hex(');
          s = s.replace(/\bNEXT_DAY\(/gi, '__next_day(');
          s = s.replace(/\bNANVL\(/gi, '__nanvl(');
          s = s.replace(/\bREMAINDER\(/gi, '__remainder(');
          s = s.replace(/\bSHIFTLEFT\(/gi, '__shiftleft(');
          s = s.replace(/\bSHIFTRIGHT\(/gi, '__shiftright(');
          s = s.replace(/\bPARSENAME\(/gi, '__parsename(');
          s = s.replace(/\bQUOTE_IDENT\(/gi, '__quote_ident(');
          s = s.replace(/\bQUOTE_LITERAL\(/gi, '__quote_literal(');
          // OVERLAY: SQL標準の PLACING ... FROM ... [FOR ...] 構文をカンマ形式へ正規化してから写像
          s = s.replace(/\bOVERLAY\s*\(([^()]*?)\s+PLACING\s+([^()]*?)\s+FROM\s+([^()]*?)\s+FOR\s+([^()]*?)\)/gi, (m, a, b, c, d) => `__overlay(${a}, ${b}, ${c}, ${d})`);
          s = s.replace(/\bOVERLAY\s*\(([^()]*?)\s+PLACING\s+([^()]*?)\s+FROM\s+([^()]*?)\)/gi, (m, a, b, c) => `__overlay(${a}, ${b}, ${c})`);
          s = s.replace(/\bOVERLAY\(/gi, '__overlay(');
          s = s.replace(/\bSYSDATETIME\(\)/gi, '__now()');
          s = s.replace(/\bSYSUTCDATETIME\(\)/gi, '__now()');
          s = s.replace(/\bGETUTCDATE\(\)/gi, '__now()');
          s = s.replace(/\bNEWID\(\)/gi, '__newid()');
          s = s.replace(/\bSYS_GUID\(\)/gi, '__sys_guid()');
          s = s.replace(/\b(?:CURRENT_USER|SESSION_USER|SYSTEM_USER)\b(?:\s*\(\s*\))?/gi, '__sys_user()');
          s = s.replace(/\b(?:USER|SUSER_NAME|SUSER_SNAME)\s*\(\s*\)/gi, '__sys_user()');
          s = s.replace(/\bCURRENT_SCHEMA\b(?:\s*\(\s*\))?/gi, '__current_schema()');
          s = s.replace(/\bSCHEMA_NAME\s*\(\s*\)/gi, '__current_schema()');
          // v1.14: 決定的乱数の種（テストデータ生成の再現性のため）
          s = s.replace(/\bSETSEED\s*\(/gi, '__setseed(');
          // v1.16: 時系列バケット / 期間差 / JSON 述語
          s = s.replace(/\bDATE_BIN\s*\(/gi, '__date_bin(');
          s = s.replace(/\bTIME_BUCKET\s*\(/gi, '__date_bin(');
          {
              // 0 以下の固定間隔はコンパイル時に弾く（実行時 throw は行評価の catch に飲まれ、
              // 黙って NULL が返ってしまうため）
              const zeroIv = s.match(/__date_bin\(\s*__interval\(\((-?\d+(?:\.\d+)?)\)/);
              if (zeroIv && Number(zeroIv[1]) <= 0) throw new Error('DATE_BIN requires a positive interval.');
          }
          s = s.replace(/\bAGE\s*\(/gi, '__age(');
          s = s.replace(/\bJSON_EXISTS\s*\(/gi, '__json_exists(');
          s = s.replace(/\bJSON_QUERY\s*\(/gi, '__json_query(');
          // v1.17: 配列 / あいまい照合 / 正規表現 / 数値 / タイムゾーン
          s = s.replace(/\bARRAY_LENGTH\s*\(/gi, '__array_length(');
          s = s.replace(/\bARRAY_POSITION\s*\(/gi, '__array_position(');
          s = s.replace(/\bARRAY_CONTAINS\s*\(/gi, '__array_contains(');
          s = s.replace(/\bARRAY_APPEND\s*\(/gi, '__array_append(');
          s = s.replace(/\bARRAY_PREPEND\s*\(/gi, '__array_prepend(');
          s = s.replace(/\bARRAY_REMOVE\s*\(/gi, '__array_remove(');
          s = s.replace(/\bARRAY_TO_STRING\s*\(/gi, '__array_to_string(');
          s = s.replace(/\bSTRING_TO_ARRAY\s*\(/gi, '__string_to_array(');
          s = s.replace(/\bARRAY_SORT\s*\(/gi, '__array_agg_sort(');
          s = s.replace(/\bLEVENSHTEIN\s*\(/gi, '__levenshtein(');
          s = s.replace(/\bEDIT_DISTANCE\s*\(/gi, '__levenshtein(');
          s = s.replace(/\bSIMILARITY\s*\(/gi, '__similarity(');
          s = s.replace(/\bDIFFERENCE\s*\(/gi, '__difference(');
          s = s.replace(/\bREGEXP_MATCHES\s*\(/gi, '__regexp_matches(');
          s = s.replace(/\bREGEXP_SPLIT_TO_ARRAY\s*\(/gi, '__regexp_split_to_array(');
          s = s.replace(/\bSAFE_DIVIDE\s*\(/gi, '__safe_divide(');
          s = s.replace(/\bDIV\s*\(/gi, '__div(');
          // MySQL の中置整数除算 `a DIV b`。関数形 DIV(a, b) を先に潰してから、
          // 残った中置形を関数呼び出しへ畳む（被演算子は前後の1プライマリ）
          s = this._rewriteDivOp(s);
          // 日付 ± 数値 / 日付 - 日付。CAST(... AS DATE) や CURRENT_DATE が
          // 関数呼び出しへ畳まれた後でないと「日付である」と判らないのでここで行う
          s = this._rewriteDateArith(s);

          s = s.replace(/\bTRUE\b/gi, 'true');
          s = s.replace(/\bFALSE\b/gi, 'false');
          // 単独の NULL リテラル（大文字含む）を JS の null へ正規化する。
          // IS [NOT] NULL は既に上で変換済みのため、ここに残るのは値としての NULL。
          // （パラメータバインドは null を 'NULL' として埋め込むため、これが無いと
          //   SELECT ? / WHERE col = ? に null を渡すと列名誤認識でエラーになる）
          s = s.replace(/\bNULL\b/gi, 'null');

          s = s.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||').replace(/\bNOT\b/gi, '!')
               .replace(/!==/g, '__NEQ__').replace(/===/g, '=')
               .replace(/<=/g, '__LTE__').replace(/>=/g, '__GTE__').replace(/<>/g, '__NEQ__').replace(/!=/g, '__NEQ__')
               .replace(/</g, '__LT__').replace(/>/g, '__GT__')
               .replace(/=/g, '===')
               .replace(/__LTE__/g, '<=').replace(/__GTE__/g, '>=').replace(/__NEQ__/g, '!==').replace(/__LT__/g, '<').replace(/__GT__/g, '>');

          // IS [NOT] NULL の後置トークンを述語ヘルパへ直す（比較の畳み込みより前）。
          // 被演算子は後方走査で取る（`__cast(x, 'DATE') IS NULL` のような呼び出しも拾う）
          while (/__IS(?:NOT)?NULL__/.test(s)) {
              const at = s.search(/__IS(?:NOT)?NULL__/);
              const tok = s.slice(at).match(/^__IS(NOT)?NULL__/);
              const neg = !!tok[1];
              const { start, end } = this._operandStartBefore(s, at, tok[0]);
              const operand = s.slice(start, end + 1).trim();
              s = s.slice(0, start) + `${neg ? '__notnull' : '__isnull'}(${operand})` + s.slice(at + tok[0].length);
          }

          // 算術の NULL 伝播（比較より前。算術のほうが強く結合する）
          s = this._rewriteArithOps(s);

          // 比較を 3 値論理のヘルパへ畳む（識別子解決より前に置くこと）
          s = this._rewriteCompareOps(s);

          // AND / OR も 3 値論理へ。比較の畳み込みの後に置く（先に置くと
          // 比較の両辺が矢印関数の中へ入り、境界の判定が変わる）。
          // 連結の '||' は _rewriteConcatOp で既に __concat_op へ直っているので
          // ここに残る '||' は論理和だけ
          s = this._rewriteLogicOps(s);

          const protectedKeywords = ['&&', '||', '!', 'true', 'false', 'null', 'undefined', '__cast', '__like', '__regexp', '__upper', '__lower', '__length', '__round', '__coalesce', '__substring', '__substring_index', '__concat', '__concat_ws', '__locate', '__truncate', '__replace', '__trim', '__abs', '__ceil', '__floor', '__now', '__lpad', '__rpad', '__power', '__sqrt', '__year', '__month', '__day', '__mod', '__sign', '__rand', '__date', '__datediff', '__ifnull', '__nullif', '__is_distinct', '__if', '__left', '__right', '__instr', '__reverse', '__repeat', '__greatest', '__least', '__exp', '__log', '__log10', '__pi', '__hour', '__minute', '__second', '__ltrim', '__rtrim', '__ascii', '__char', '__sin', '__cos', '__tan', '__sinh', '__asin', '__acos', '__atan', '__atan2', '__degrees', '__radians', '__ln', '__cbrt', '__datecol', '__date_add', '__date_sub', '__dayofweek', '__dayofyear', '__quarter', '__last_day', '__curdate', '__log2', '__cot', '__format', '__hex', '__bin', '__oct', '__conv', '__space', '__strcmp', '__elt', '__field', '__initcap', '__monthname', '__dayname', '__week', '__weekday', '__weekofyear', '__unix_timestamp', '__from_unixtime', '__date_format', '__extract', '__timestampdiff', '__interval', '__json_extract', '__json_array', '__json_object', '__json_length', '__json_keys', '__json_valid', '__json_type', '__json_contains', '__json_set', '__json_remove', '__uuid', '__version', '__database', '__regexp_replace', '__regexp_substr', '__regexp_like', '__split_part', '__quote', '__bit_count', '__sec_to_time', '__time_to_sec', '__makedate', '__str_to_date', '__trim_dir', '__corr_exists', '__corr_scalar', '__corr_in', '__time', '__md5', '__crc32', '__to_base64', '__from_base64', '__inet_aton', '__inet_ntoa', '__soundex', '__translate', '__str_insert', '__cosh', '__tanh', '__to_days', '__from_days', '__maketime', '__curtime', '__format_bytes', '__timestampadd', '__json_pretty', '__json_quote', '__json_unquote', '__json_array_append', '__json_merge_patch', '__json_depth', '__sha1', '__sha2', '__sha256', '__sha224', '__octet_length', '__bit_length', '__char_length', '__unhex', '__date_trunc', '__typeof', '__regexp_count', '__nextval', '__currval', '__setval', '__decode', '__nvl2', '__zeroifnull', '__nullifzero', '__choose', '__starts_with', '__ends_with', '__charindex', '__len', '__stuff', '__regexp_instr', '__square', '__gcd', '__lcm', '__factorial', '__width_bucket', '__add_months', '__months_between', '__date_part', '__quotename', '__patindex', '__bitand', '__bitor', '__bitxor', '__bitnot', '__isnumeric', '__eomonth', '__make_date', '__make_timestamp', '__to_number', '__to_date', '__to_timestamp', '__dateadd', '__datepart', '__datename', '__next_day', '__nanvl', '__remainder', '__shiftleft', '__shiftright', '__to_hex', '__parsename', '__quote_ident', '__quote_literal', '__overlay', '__sys_user', '__current_schema', '__newid', '__sys_guid', '__to_char', '__op_like', '__op_nlike', '__op_ilike', '__op_nilike', '__op_regex', '__op_iregex', '__op_nregex', '__op_niregex', '__ilike', '__similar', '__concat_op', '__setseed', '__collate', '__match_against', '__ft_tokens', '__overlaps', '__date_bin', '__age', '__is_json', '__json_exists', '__json_query', '__array', '__subscript', '__array_slice', '__toArray', '__array_length', '__array_position', '__array_contains', '__array_append', '__array_prepend', '__array_remove', '__array_to_string', '__string_to_array', '__array_agg_sort', '__levenshtein', '__similarity', '__difference', '__regexp_matches', '__regexp_split_to_array', '__div', '__safe_divide', '__at_time_zone', '__tz_minutes', '__convert_tz', '__btrim', '__encode', '__ord', '__unistr', '__contains', '__timediff', '__yearweek', '__period_add', '__period_diff', '__julian_day', '__json_search', '__json_merge_preserve', '__array_distinct', '__array_cat', '__array_reverse', '__json_insert', '__json_replace', '__json_array_insert', '__json_arrow', '__json_arrow_text', '__json_hash_arrow', '__json_hash_arrow_text', '__json_has_key', '__json_contains_path', '__is_bool', '__not3', '__and3', '__or3', '__b3', '__nul', '__in', '__DATEISH', '__dnum', '__cpair', '__num', '__add', '__sub', '__mul', '__divf', '__modf', '__neg', '__isnull', '__notnull', '__eq', '__ne', '__lt', '__le', '__gt', '__ge', '__resolve', 'ptrs', 'dbTables', 'aliases', 'includes', 'Math', 'Date'];
          s = s.replace(/('([^'\\]|\\.)*'|"([^"\\]|\\.)*")|\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g, (m, stringLit, _1, _2, word, offset, whole) => {
              if (stringLit) return m;
              if (!word) return m;
              if (protectedKeywords.includes(word) || word.startsWith('__STR_')) return word;
              // ここまでのどの関数写像にも当たらなかった名前が `(` を伴っていれば「未知の関数」。
              // 従来は列参照として解決され、実行時に "Column 'foo' not found." になっていて
              // 「関数名が間違っている」と気づけなかった
              if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(word) && /^\s*\(/.test(String(whole).slice(offset + word.length))) {
                  const lw = word.toLowerCase();
                  const isAgg = new RegExp('^(?:' + LUMINA_AGG_NAMES + ')$', 'i').test(word);
                  const isWin = typeof LUMINA_WINDOW_FN_NAMES !== 'undefined' && LUMINA_WINDOW_FN_NAMES.has(word.toUpperCase());
                  const isUdf = this.functions && this.functions[lw];
                  if (!isAgg && !isWin && !isUdf) {
                      const names = (typeof LUMINA_BUILTIN_FN_NAMES !== 'undefined') ? [...LUMINA_BUILTIN_FN_NAMES] : [];
                      const sug = this._suggestName ? this._suggestName(lw, names) : null;
                      throw new Error(`Function '${word}' does not exist.${sug ? ` Did you mean '${sug.toUpperCase()}'?` : ''}`);
                  }
                  // ウィンドウ専用の関数がここへ来たということは OVER が付いていない。
                  // そのまま列参照へ落とすと "Column 'lag' not found." という
                  // 見当違いのエラーになり、書き忘れに気づけない
                  if (isWin && !isAgg && !isUdf) {
                      throw new Error(`Window function ${word.toUpperCase()}() requires an OVER clause, `
                          + `for example ${word.toUpperCase()}(...) OVER (ORDER BY <column>).`);
                  }
              }
              return `__resolve('${word.toLowerCase()}', ptrs, dbTables, aliases)`;
          });

          strMap.forEach((str, i) => {
              // 生の改行（および U+2028 / U+2029）は JS のシングルクォート文字列内に
              // そのまま置けず new Function が構文エラーになるため、エスケープ列へ直す。
              // 対象は「実際の制御文字」だけなので、SQL 中の 2 文字の '\n' 表記には触れない
              const safe = /[\n\r\u2028\u2029]/.test(str)
                  ? str.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
                  : str;
              // 置換文字列はコールバックで返す。値に含まれる '$'（$&, $', $1 等）が
              // String.replace の特殊置換パターンとして誤解釈され、'^A$' のような
              // リテラル（末尾$や$+特殊文字）を壊すのを防ぐ
              s = s.replace(new RegExp(`__STR_${i}__`, 'g'), () => safe);
          });

          // new Function は JS としての構文エラーを投げる。そのまま外へ出すと
          // "Unexpected token ';'. Expected ')' ..." のような JS の言い回しが
          // ユーザーへ届いてしまうので、SQL 側の言葉へ言い換える
          try {
          return new Function('__L', __EXPR_PRELUDE +
              '\nreturn function(ptrs, dbTables, aliases) {' +
              '\n    try {' +
              // 個別の関数で拾いきれなかった NaN / Infinity もここで NULL へ揃える
              '\n        var __r = (' + s + ');' +
              '\n        return (typeof __r === "number" && !isFinite(__r)) ? null : __r;' +
              '\n    } catch (e) {' +
              // __sqlError: 利用者へ必ず伝える誤り（単位名の綴り違い等）。
              // __fatal: 文の実行時間上限。どちらも NULL へ丸めてはならない
              '\n        if (e && (e.__sqlError || e.__fatal)) throw e;' +
              "\n        if (e.message && e.message.includes('not found')) throw e;" +
              '\n        return null;' +
              '\n    }' +
              '\n};')(__EXPR_LIB);
          } catch (e) {
              if (e instanceof SyntaxError) {
                  const src = (strMap && this._restoreStrings) ? this._restoreStrings(expr, strMap) : expr;
                  throw new Error(`Malformed expression: ${String(src).trim().slice(0, 120)} — check for unbalanced parentheses, an unclosed quote, or a missing operand.`);
              }
              throw e;
          }
      },

      // 句をトップレベルのカンマで分割する。括弧に加えて角括弧も数える
      // （`ARRAY[1, 2]` の内側のカンマで割れてしまわないように。文字列リテラルは
      //   呼び出し前に __STR_n__ へ退避済みなので引用符は考慮しなくてよい）
      splitSelectClause(clause) {
          let parts = [], current = "", depth = 0;
          for (let i = 0; i < clause.length; i++) {
              let c = clause[i];
              if (c === '(' || c === '[') depth++;
              if (c === ')' || c === ']') depth--;
              if (c === ',' && depth === 0) { parts.push(current.trim()); current = ""; }
              else { current += c; }
          }
          parts.push(current.trim());
          return parts;
      },

      // SELECT 項目の「AS を省いた後置別名」を切り出す。
      //   'id x' -> { expr: 'id', alias: 'x' } / 'COUNT(*) c' -> { expr: 'COUNT(*)', alias: 'c' }
      // 末尾が裸の語になる構文（`a IS NULL` / `INTERVAL 1 DAY` / `x COLLATE NOCASE` /
      // `LAG(x) IGNORE NULLS OVER (...)`）を別名と誤認しないよう、
      //   (a) 別名になり得ない語の集合、(b) 直前の語が被演算子を要求するか、
      //   (c) 直前が演算子記号か
      // の 3 条件で保守的に弾く。判定できないときは null（＝従来どおり別名なし）を返す
      _trailingAlias(part) {
          const m = part.match(/^([\s\S]*[^\s,])\s+([a-zA-Z_][a-zA-Z0-9_]*)$/);
          if (!m) return null;
          const head = m[1].trim();
          const cand = m[2];
          if (head === '') return null;
          if (LUMINA_NON_ALIAS_WORDS.has(cand.toLowerCase())) return null;
          // 直前の語が「次に被演算子が来る」種類なら、cand は別名ではなく被演算子
          const prevWord = (head.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/) || [])[1];
          if (prevWord && LUMINA_OPERAND_EXPECTING_WORDS.has(prevWord.toLowerCase())) return null;
          // 直前が演算子記号（`a +` など）なら式の途中
          if (/[+\-*/%=<>!&|^~,.(]$/.test(head)) return null;
          // 括弧の対応が取れていない断片は式として壊れているので触らない
          let depth = 0;
          for (const ch of head) { if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--; }
          if (depth !== 0) return null;
          return { expr: head, alias: cand };
      }
    });
