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
              const __like = (val, pattern, esc) => {
                 // LIKE パターン照合。esc 指定時（LIKE ... ESCAPE 'c'）はエスケープ文字の
                 // 直後の1文字（% _ エスケープ文字自身など）をリテラルとして扱う
                 if (val === null || val === undefined || pattern == null) return false;
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
              const __ilike = (val, pattern, esc) => {
                 if (val === null || val === undefined || pattern == null) return false;
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
                  if (val === null || val === undefined || pattern == null) return false;
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
              const __length = (val) => val != null ? String(val).length : null;
              // ROUND(x [, d]): 精度指定付き・ゼロから遠い方向への丸め（MySQL互換。JSのMath.roundは負数で挙動が異なる）
              const __round = (val, d) => {
                  if (val == null) return null;
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
                  let s = start > 0 ? start - 1 : 0;
                  if (len !== undefined) return str.substr(s, len);
                  return str.substr(s);
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
                  const f = Math.pow(10, Math.trunc(Number(digits) || 0));
                  return Math.trunc(Number(v) * f) / f;
              };
              const __regexp = (val, pattern) => {
                  if (val === null || val === undefined || pattern == null) return false;
                  try { return new RegExp(pattern).test(String(val)); } catch(e) { return false; }
              };
              const __replace = (val, search, replace) => val != null ? String(val).split(search).join(replace) : null;
              const __trim = (val) => val != null ? String(val).trim() : null;
              const __abs = (val) => val != null ? Math.abs(Number(val)) : null;
              const __ceil = (val) => val != null ? Math.ceil(Number(val)) : null;
              const __floor = (val) => val != null ? Math.floor(Number(val)) : null;
              const __now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
              const __lpad = (str, len, pad) => str != null ? String(str).padStart(Number(len), pad != null ? String(pad) : ' ') : null;
              const __rpad = (str, len, pad) => str != null ? String(str).padEnd(Number(len), pad != null ? String(pad) : ' ') : null;
              const __power = (base, exp) => (base != null && exp != null) ? Math.pow(Number(base), Number(exp)) : null;
              const __sqrt = (val) => val != null ? Math.sqrt(Number(val)) : null;

              const __date_parse = (val) => {
                  if (val == null) return null;
                  if (typeof val === 'string') {
                      let s = val.replace(' ', 'T');
                      if (s.indexOf('T') !== -1 && !s.endsWith('Z')) s += 'Z';
                      let d = new Date(s);
                      if (!isNaN(d.getTime())) return d;
                  }
                  return new Date(val);
              };
              const __year = (val) => val != null ? __date_parse(val).getUTCFullYear() : null;
              const __month = (val) => val != null ? __date_parse(val).getUTCMonth() + 1 : null;
              const __day = (val) => val != null ? __date_parse(val).getUTCDate() : null;
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
                  const d1 = __date_parse(a);
                  const d2 = b == null ? new Date() : __date_parse(b);
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
              const __at_time_zone = (v, tz) => {
                  if (v == null || tz == null) return null;
                  const d = __date_parse(v);
                  if (!d || isNaN(d.getTime())) return null;
                  const name = String(tz).trim().toUpperCase();
                  let mins;
                  const om = name.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
                  if (om) mins = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] || 0));
                  else if (Object.prototype.hasOwnProperty.call(__TZ_OFFSETS, name)) mins = __TZ_OFFSETS[name];
                  else throw new Error(`Unknown time zone '${tz}'. Use 'UTC', '+09:00' or a common abbreviation.`);
                  return new Date(d.getTime() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
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
              const __ft_tokens = (s) => {
                  if (s == null) return [];
                  return String(s).toLowerCase()
                      .replace(/[　-〿・]/g, ' ')
                      .split(/[^0-9a-z_À-ɏ぀-ヿ一-鿿]+/)
                      .filter(t => t !== '');
              };
              const __match_against = (haystack, query, mode) => {
                  const text = ' ' + __ft_tokens(haystack).join(' ') + ' ';
                  const raw = String(query == null ? '' : query);
                  const boolean = /bool/i.test(String(mode || ''));
                  const terms = [];
                  const re = /([+-]?)(?:"([^"]*)"|(\S+))/g;
                  let m;
                  while ((m = re.exec(raw))) {
                      const body = m[2] !== undefined ? m[2] : m[3];
                      const toks = __ft_tokens(body);
                      if (toks.length === 0) continue;
                      terms.push({ sign: boolean ? m[1] : '', phrase: ' ' + toks.join(' '), prefix: /\*$/.test(body) });
                  }
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

              const __ltrim = (v) => v != null ? String(v).replace(/^\s+/, '') : null;
              const __rtrim = (v) => v != null ? String(v).replace(/\s+$/, '') : null;
              const __ascii = (v) => v != null ? (String(v).length > 0 ? String(v).charCodeAt(0) : 0) : null;
              const __char = (...vs) => (vs.length === 0 || vs.some(v => v == null)) ? null : vs.map(v => String.fromCharCode(Math.trunc(Number(v)))).join('');
              const __sin = (v) => v != null ? Math.sin(Number(v)) : null;
              const __cos = (v) => v != null ? Math.cos(Number(v)) : null;
              const __tan = (v) => v != null ? Math.tan(Number(v)) : null;
              const __sinh = (v) => v != null ? Math.sinh(Number(v)) : null;
              const __asin = (v) => v != null ? Math.asin(Number(v)) : null;
              const __acos = (v) => v != null ? Math.acos(Number(v)) : null;
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
              const __left = (s, n) => s != null ? String(s).slice(0, Math.max(0, Number(n))) : null;
              const __right = (s, n) => { if (s == null) return null; const str = String(s); const k = Math.max(0, Number(n)); return k === 0 ? '' : str.slice(-k); };
              const __instr = (s, sub) => (s != null && sub != null) ? String(s).indexOf(String(sub)) + 1 : null;
              const __reverse = (s) => s != null ? String(s).split('').reverse().join('') : null;
              const __repeat = (s, n) => (s != null && n != null && Number(n) >= 0) ? String(s).repeat(Math.floor(Number(n))) : null;
              const __greatest = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y > x ? y : x);
              const __least = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y < x ? y : x);
              const __exp = (v) => v != null ? Math.exp(Number(v)) : null;
              const __log = (a, b) => {
                  // 1引数: 自然対数 LOG(x)（MySQL） / 2引数: 指定底の対数 LOG(base, x)（Oracle/MySQL/PG）
                  if (b === undefined) return (a != null && Number(a) > 0) ? Math.log(Number(a)) : null;
                  if (a == null || b == null || Number(a) <= 0 || Number(a) === 1 || Number(b) <= 0) return null;
                  return Math.log(Number(b)) / Math.log(Number(a));
              };
              const __log10 = (v) => (v != null && Number(v) > 0) ? Math.log10(Number(v)) : null;
              const __pi = () => Math.PI;

              const __cast = (v, t) => {
                  if (v === null || v === undefined) return null;
                  if (t === 'INTEGER') { const n = Math.trunc(Number(v)); return isNaN(n) ? null : n; }
                  if (t === 'FLOAT') { const n = Number(v); return isNaN(n) ? null : n; }
                  if (t === 'TEXT') return String(v);
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
                  return v;
              };
              const __mod = (a, b) => (a != null && b != null) ? Number(a) % Number(b) : null;
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
              const __date = (val) => val != null ? new Date(val) : null;

              // --- v1.1 追加関数群: 数値 / 文字列 ---
              const __log2 = (v) => (v != null && Number(v) > 0) ? Math.log2(Number(v)) : null;
              const __cot = (v) => v != null ? 1 / Math.tan(Number(v)) : null;
              const __format = (n, d) => {
                  if (n == null) return null;
                  const dd = Math.max(0, Math.trunc(Number(d) || 0));
                  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dd, maximumFractionDigits: dd });
              };
              const __hex = (v) => {
                  if (v == null) return null;
                  if (typeof v === 'number') return (v < 0 ? BigInt.asUintN(64, BigInt(Math.trunc(v))).toString(16) : Math.trunc(v).toString(16)).toUpperCase();
                  let out = '';
                  for (const ch of String(v)) out += ch.codePointAt(0).toString(16).toUpperCase().padStart(2, '0');
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
              const __initcap = (v) => v != null ? String(v).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) : null;

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
              const __extract = (unit, v) => {
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

              // --- v1.2 追加関数群: 正規表現 / 文字列 / ビット / 時刻 ---
              const __regexp_guard = (p) => {
                  if (p != null && String(p).length > 1000) throw new Error("REGEXP pattern too long (max 1000 characters).");
                  return p;
              };
              const __regexp_replace = (s0, pat, rep) => {
                  if (s0 == null || pat == null || rep == null) return null;
                  __regexp_guard(pat);
                  try { return String(s0).replace(new RegExp(String(pat), 'g'), String(rep)); } catch (e) { return null; }
              };
              const __regexp_substr = (s0, pat) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try { const m2 = String(s0).match(new RegExp(String(pat))); return m2 ? m2[0] : null; } catch (e) { return null; }
              };
              const __regexp_like = (s0, pat) => {
                  if (s0 == null || pat == null) return null;
                  __regexp_guard(pat);
                  try { return new RegExp(String(pat)).test(String(s0)) ? 1 : 0; } catch (e) { return 0; }
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
              const __cosh = (v) => v != null ? Math.cosh(Number(v)) : null;
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
              const __octet_length = (v) => v != null ? __utf8_bytes(String(v)).length : null;
              const __bit_length = (v) => v != null ? __utf8_bytes(String(v)).length * 8 : null;
              const __unhex = (v) => {
                  if (v == null) return null;
                  const s0 = String(v);
                  if (s0.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s0)) return null;
                  let out = '';
                  for (let i = 0; i < s0.length; i += 2) out += String.fromCharCode(parseInt(s0.slice(i, i + 2), 16));
                  return out;
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
                  else if (u !== 'SECOND') return null;
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
              const __corr_exists = (k, ptrs, dbTables, aliases) => __corr_run(k, ptrs, dbTables, aliases).n > 0;
              const __corr_scalar = (k, ptrs, dbTables, aliases) => { const r = __corr_run(k, ptrs, dbTables, aliases); return r.n > 0 ? r.first[0] : null; };
              const __corr_in = (k, lhs, ptrs, dbTables, aliases) => (lhs === null || lhs === undefined) ? false : __corr_run(k, ptrs, dbTables, aliases).first.includes(lhs);

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
              const __regexp_instr = (s, pat) => {
                  if (s == null || pat == null) return null;
                  __regexp_guard(pat);
                  try { const m = String(s).match(new RegExp(String(pat))); return m ? m.index + 1 : 0; } catch (e) { return null; }
              };
              // 数値
              const __square = (x) => x != null ? Number(x) * Number(x) : null;
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
                  if (v == null) return null;
                  switch (__normDatePart(unit)) {
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
                  // 書式に日付トークン用の英字が含まれ、数値書式文字だけでない場合は日付整形
                  if (/[A-Za-z]/.test(f) && !/^(FM)?[90.,$GD]+$/i.test(f)) return __to_char_date(v, f);
                  return __to_char_number(v, f);
              };

        return { __ilike, __similar, __concat_op, __setseed, __collate, __ft_tokens, __match_against,
                 __overlaps, __date_bin, __age, __is_json, __json_exists, __json_query,
                 __array, __toArray, __array_length, __array_position, __array_contains, __array_append,
                 __array_prepend, __array_remove, __array_to_string, __string_to_array, __array_agg_sort,
                 __levenshtein, __similarity, __difference, __regexp_matches, __regexp_split_to_array,
                 __div, __safe_divide, __at_time_zone,
                 __dateadd, __datepart, __datename, __next_day, __nanvl, __remainder, __shiftleft, __shiftright, __to_hex, __parsename, __quote_ident, __quote_literal, __overlay, __sys_user, __current_schema, __newid, __sys_guid, __to_char, __to_char_number, __to_char_date, __normDatePart, __DATEPART_UNITS,
                 __quotename, __patindex, __bitand, __bitor, __bitxor, __bitnot, __isnumeric, __eomonth, __make_date, __make_timestamp, __to_number, __to_date, __to_timestamp,
                 __decode, __nvl2, __zeroifnull, __nullifzero, __choose, __starts_with, __ends_with, __charindex, __len, __stuff, __regexp_instr, __square, __gcd, __lcm, __factorial, __width_bucket, __add_months, __months_between, __date_part, __sha1, __octet_length, __bit_length, __unhex, __date_trunc, __typeof, __regexp_count, __nextval, __currval, __setval, __colSuggest, __resolve, __like, __upper, __lower, __length, __round, __coalesce, __substring, __concat, __concat_ws, __substring_index, __locate, __truncate, __regexp, __replace, __trim, __abs, __ceil, __floor, __now, __lpad, __rpad, __power, __sqrt, __date_parse, __year, __month, __day, __hour, __minute, __second, __datediff, __interval, __add_interval, __date_add, __date_sub, __curdate, __dayofweek, __dayofyear, __quarter, __last_day, __ltrim, __rtrim, __ascii, __char, __sin, __cos, __tan, __sinh, __asin, __acos, __atan, __atan2, __degrees, __radians, __ln, __cbrt, __ifnull, __nullif, __is_distinct, __if, __left, __right, __instr, __reverse, __repeat, __greatest, __least, __exp, __log, __log10, __pi, __cast, __mod, __sign, __rand, __date, __log2, __cot, __format, __hex, __bin, __oct, __conv, __space, __strcmp, __elt, __field, __initcap, __MONTH_NAMES, __DAY_NAMES, __monthname, __dayname, __weekday, __week, __weekofyear, __unix_timestamp, __from_unixtime, __date_format, __extract, __timestampdiff, __json_parse, __json_path, __json_get, __json_extract, __json_array, __json_object, __json_length, __json_keys, __json_valid, __json_type, __json_contains_deep, __json_contains, __json_set, __json_remove, __regexp_guard, __regexp_replace, __regexp_substr, __regexp_like, __split_part, __quote, __bit_count, __sec_to_time, __time_to_sec, __makedate, __str_to_date, __time, __trim_dir, __utf8_bytes, __md5, __crc32, __B64_ALPHA, __to_base64, __from_base64, __inet_aton, __inet_ntoa, __soundex, __translate, __str_insert, __cosh, __tanh, __to_days, __from_days, __maketime, __curtime, __format_bytes, __timestampadd, __json_pretty, __json_quote, __json_unquote, __json_depth, __json_array_append, __json_merge_patch, __corr_run, __corr_exists, __corr_scalar, __corr_in, __uuid, __version, __database };
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

      _COLLATIONS: new Set(['NOCASE', 'CI', 'BINARY', 'CS', 'NOACCENT', 'AI', 'NUMERIC', 'NATURAL']),

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

      // PostgreSQL の '::' キャスト演算子を __cast(expr, 'TYPE') へ書き換える。
      // 被演算子は '::' の左を後方走査して決める（`(a+b)::INT` / `f(x)::TEXT` /
      // `x::INT::TEXT` の連鎖も 1 単位ずつ正しく取れる）
      _rewriteCastOp(s) {
          if (s.indexOf('::') === -1) return s;
          for (let guard = 0; guard < 256; guard++) {
              const at = s.indexOf('::');
              if (at === -1) return s;
              const tm = s.slice(at + 2).match(/^\s*([a-zA-Z][a-zA-Z0-9_]*)(\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?/);
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
              s = s.slice(0, start) + `__cast(${operand}, '${tm[1].toUpperCase()}')` + s.slice(at + 2 + tm[0].length);
          }
          return s;
      },

      // '||' 連結演算子を __concat_op(...) へ畳む。括弧グループを内側から処理し、
      // 引数リストのトップレベルのカンマ区切りは保ったまま各要素を個別に畳む
      // （f(a || b, c) の展開で引数の切れ目を失わないため）
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

      _compileConditionUncached(expr, strMap) {
          // 防御的措置: 式は new Function でJSへコンパイルされる。識別子は __resolve() へ
          // ラップされ文字列リテラルは退避されるため通常のSQLは安全だが、本方言が使わない
          // テンプレートリテラル構文(バックティック / ${...})はそのままJSソースへ紛れ込み
          // 任意コード実行の足がかりになり得るため、コンパイル前に拒否する。
          if (/[`]|\$\{/.test(expr)) {
              throw new Error("Syntax Error: unsupported characters in expression.");
          }
          let s = expr;

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
              let whenRegex = /WHEN\s+(.+?)\s+THEN\s+(.+?)(?=\s+WHEN|\s+ELSE|$)/gi;
              let wm;
              let elseStr = 'null';
              let elseMatch = body.match(/ELSE\s+(.+?)$/i);
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
          s = s.replace(/\b(?:DATE|TIMESTAMP)\s+(__STR_\d+__)/gi, (m, tok) => `__cast(${tok}, 'DATE')`);
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

          // LHS が数値リテラル / 文字列トークンの場合は列解決せずそのまま比較し、
          // 関数呼び出し（括弧を含む: UPPER(name) LIKE ... 等）はそのまま式として残す
          // （後続の関数マッピングと識別子解決が中身を処理する）
          const _lhs = (col) => {
              if (col.indexOf('(') !== -1) return col;
              return (/^\d+(?:\.\d+)?$/.test(col) || /^__STR_\d+__$/.test(col))
                  ? col
                  : `__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases)`;
          };
          // LIKE / BETWEEN / IN / REGEXP の左辺: 識別子・リテラル、または関数呼び出し
          // （引数の括弧は1段のネストまで対応）
          const LHS = '([a-zA-Z0-9_.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?)';

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
                  const operand = col[0] === '(' ? col : _ndl(col);
                  return `${not ? '!' : ''}__is_json(${operand}, '${(kind || 'VALUE').toUpperCase()}')`;
              });

          // IS [NOT] UNKNOWN (SQL標準): 3値論理の UNKNOWN 判定。ブール式に対する IS NULL と同義
          s = s.replace(/\bIS\s+NOT\s+UNKNOWN\b/gi, '!== null').replace(/\bIS\s+UNKNOWN\b/gi, '=== null');
          s = s.replace(/\bIS\s+NOT\s+NULL\b/gi, '!== null').replace(/\bIS\s+NULL\b/gi, '=== null');
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?BETWEEN\\s+(.+?)\\s+AND\\s+(.+?)(?=\\s*(?:AND\\b|OR\\b|\\)|$))', 'gi'), (m, col, not, a, b) => `${not ? '!' : ''}(${_lhs(col)} >= ${a} && ${_lhs(col)} <= ${b})`);
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
              return `${not ? '!' : ''}__like(${_lhs(col)}, ${strRef}, __STR_${escIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?LIKE\\s+(__STR_\\d+__)', 'gi'), (m, col, not, strRef) => `${not ? '!' : ''}__like(${_lhs(col)}, ${strRef})`);
          // ILIKE (PostgreSQL): 大文字小文字を区別しない LIKE
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?ILIKE\\s+(__STR_\\d+__)\\s+ESCAPE\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strRef, escIdx) => {
              const escLit = this._unquoteLiteral(strMap[Number(escIdx)]);
              if (escLit.length !== 1) throw new Error("ESCAPE clause requires a single character.");
              return `${not ? '!' : ''}__ilike(${_lhs(col)}, ${strRef}, __STR_${escIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?ILIKE\\s+(__STR_\\d+__)', 'gi'), (m, col, not, strRef) => `${not ? '!' : ''}__ilike(${_lhs(col)}, ${strRef})`);
          // SIMILAR TO (SQL標準): LIKE のワイルドカードと正規表現メタ文字を併用するパターン
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?SIMILAR\\s+TO\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strIdx) => {
              // ReDoS 緩和: 実行時 throw は行評価の catch に飲まれるのでコンパイル時に弾く
              const lit = strMap[Number(strIdx)];
              if (lit && lit.length > 1002) throw new Error("SIMILAR TO pattern too long (max 1000 characters).");
              return `${not ? '!' : ''}__similar(${_lhs(col)}, __STR_${strIdx}__)`;
          });
          s = s.replace(new RegExp(LHS + '\\s+(NOT\\s+)?REGEXP\\s+__STR_(\\d+)__', 'gi'), (m, col, not, strIdx) => {
              // DoSガード(ReDoS緩和): 異常に長い正規表現パターンをコンパイル時に拒否する
              const lit = strMap[Number(strIdx)];
              if (lit && lit.length > 1002) throw new Error("REGEXP pattern too long (max 1000 characters).");
              return `${not ? '!' : ''}__regexp(${_lhs(col)}, __STR_${strIdx}__)`;
          });

          // Execute IN / NOT IN replacements before standalone NOT replacements
          // リストは1段の括弧ネストまで対応（IN (ROUND(1.4), 2) 等の関数呼び出しを許容）
          s = s.replace(new RegExp(LHS + '\\s+NOT\\s+IN\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'), (m, col, vals) => `!([${vals}].includes(${_lhs(col)}))`);
          s = s.replace(new RegExp(LHS + '\\s+IN\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'gi'), (m, col, vals) => `[${vals}].includes(${_lhs(col)})`);

          // 相関サブクエリのトークン（expandSubqueries が登録）を実行時評価の呼び出しへ変換する
          s = s.replace(new RegExp(LHS + '\\s+NOT\\s+IN\\s+__CORRIN_(\\d+)__', 'gi'), (m, col, k) => `!__corr_in(${k}, ${_lhs(col)}, ptrs, dbTables, aliases)`);
          s = s.replace(new RegExp(LHS + '\\s+IN\\s+__CORRIN_(\\d+)__', 'gi'), (m, col, k) => `__corr_in(${k}, ${_lhs(col)}, ptrs, dbTables, aliases)`);
          s = s.replace(/__CORREX_(\d+)__/g, (m, k) => `__corr_exists(${k}, ptrs, dbTables, aliases)`);
          s = s.replace(/__CORRSC_(\d+)__/g, (m, k) => `__corr_scalar(${k}, ptrs, dbTables, aliases)`);

          // CAST(expr AS TYPE) -> __cast(expr, 'TYPE')（1段の括弧ネストまで対応）
          let castRegex = /\bCAST\s*\(((?:[^()]|\([^()]*\))*?)\s+AS\s+([a-zA-Z]+)\s*\)/i;
          let castM;
          while ((castM = s.match(castRegex))) {
              const inner = castM[1];
              const castType = castM[2].toUpperCase();
              s = s.replace(castM[0], () => `__cast(${inner}, '${castType}')`);
          }
          // CONVERT(expr, TYPE) は CAST の別形（MySQL互換）
          let convRegex = /\bCONVERT\s*\(((?:[^()]|\([^()]*\))*?),\s*([a-zA-Z]+)\s*\)/i;
          let convM;
          while ((convM = s.match(convRegex))) {
              const inner2 = convM[1];
              const convType = convM[2].toUpperCase();
              s = s.replace(convM[0], () => `__cast(${inner2}, '${convType}')`);
          }
          // TRY_CAST(expr AS TYPE) / TRY_CONVERT(TYPE, expr): SQL Server の安全変換。
          // __cast は変換不可時に null を返す（例外を投げない）ため実装を共用する。
          let tryCastRegex = /\bTRY_CAST\s*\(((?:[^()]|\([^()]*\))*?)\s+AS\s+([a-zA-Z]+)\s*\)/i;
          let tcM;
          while ((tcM = s.match(tryCastRegex))) {
              const innerT = tcM[1];
              const typeT = tcM[2].toUpperCase();
              s = s.replace(tcM[0], () => `__cast(${innerT}, '${typeT}')`);
          }
          let tryConvRegex = /\bTRY_CONVERT\s*\(\s*([a-zA-Z]+)\s*,((?:[^()]|\([^()]*\))*?)\)/i;
          let tvM;
          while ((tvM = s.match(tryConvRegex))) {
              const typeV = tvM[1].toUpperCase();
              const innerV = tvM[2];
              s = s.replace(tvM[0], () => `__cast(${innerV}, '${typeV}')`);
          }

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
          s = s.replace(/\bCHAR_LENGTH\(/gi, '__length(');
          s = s.replace(/\bCHARACTER_LENGTH\(/gi, '__length(');
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
          s = s.replace(/\bJSON_MERGE_PATCH\(/gi, '__json_merge_patch(');
          s = s.replace(/\bJSON_DEPTH\(/gi, '__json_depth(');
          // v1.6 追加関数: ハッシュ / バイト長 / 日付切り捨て / 型 / 別名 / シーケンス
          s = s.replace(/\bSHA1\(/gi, '__sha1(');
          s = s.replace(/\bSHA\(/gi, '__sha1(');
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

          const protectedKeywords = ['&&', '||', '!', 'true', 'false', 'null', 'undefined', '__cast', '__like', '__regexp', '__upper', '__lower', '__length', '__round', '__coalesce', '__substring', '__substring_index', '__concat', '__concat_ws', '__locate', '__truncate', '__replace', '__trim', '__abs', '__ceil', '__floor', '__now', '__lpad', '__rpad', '__power', '__sqrt', '__year', '__month', '__day', '__mod', '__sign', '__rand', '__date', '__datediff', '__ifnull', '__nullif', '__is_distinct', '__if', '__left', '__right', '__instr', '__reverse', '__repeat', '__greatest', '__least', '__exp', '__log', '__log10', '__pi', '__hour', '__minute', '__second', '__ltrim', '__rtrim', '__ascii', '__char', '__sin', '__cos', '__tan', '__sinh', '__asin', '__acos', '__atan', '__atan2', '__degrees', '__radians', '__ln', '__cbrt', '__date_add', '__date_sub', '__dayofweek', '__dayofyear', '__quarter', '__last_day', '__curdate', '__log2', '__cot', '__format', '__hex', '__bin', '__oct', '__conv', '__space', '__strcmp', '__elt', '__field', '__initcap', '__monthname', '__dayname', '__week', '__weekday', '__weekofyear', '__unix_timestamp', '__from_unixtime', '__date_format', '__extract', '__timestampdiff', '__interval', '__json_extract', '__json_array', '__json_object', '__json_length', '__json_keys', '__json_valid', '__json_type', '__json_contains', '__json_set', '__json_remove', '__uuid', '__version', '__database', '__regexp_replace', '__regexp_substr', '__regexp_like', '__split_part', '__quote', '__bit_count', '__sec_to_time', '__time_to_sec', '__makedate', '__str_to_date', '__trim_dir', '__corr_exists', '__corr_scalar', '__corr_in', '__time', '__md5', '__crc32', '__to_base64', '__from_base64', '__inet_aton', '__inet_ntoa', '__soundex', '__translate', '__str_insert', '__cosh', '__tanh', '__to_days', '__from_days', '__maketime', '__curtime', '__format_bytes', '__timestampadd', '__json_pretty', '__json_quote', '__json_unquote', '__json_array_append', '__json_merge_patch', '__json_depth', '__sha1', '__octet_length', '__bit_length', '__unhex', '__date_trunc', '__typeof', '__regexp_count', '__nextval', '__currval', '__setval', '__decode', '__nvl2', '__zeroifnull', '__nullifzero', '__choose', '__starts_with', '__ends_with', '__charindex', '__len', '__stuff', '__regexp_instr', '__square', '__gcd', '__lcm', '__factorial', '__width_bucket', '__add_months', '__months_between', '__date_part', '__quotename', '__patindex', '__bitand', '__bitor', '__bitxor', '__bitnot', '__isnumeric', '__eomonth', '__make_date', '__make_timestamp', '__to_number', '__to_date', '__to_timestamp', '__dateadd', '__datepart', '__datename', '__next_day', '__nanvl', '__remainder', '__shiftleft', '__shiftright', '__to_hex', '__parsename', '__quote_ident', '__quote_literal', '__overlay', '__sys_user', '__current_schema', '__newid', '__sys_guid', '__to_char', '__ilike', '__similar', '__concat_op', '__setseed', '__collate', '__match_against', '__ft_tokens', '__overlaps', '__date_bin', '__age', '__is_json', '__json_exists', '__json_query', '__array', '__toArray', '__array_length', '__array_position', '__array_contains', '__array_append', '__array_prepend', '__array_remove', '__array_to_string', '__string_to_array', '__array_agg_sort', '__levenshtein', '__similarity', '__difference', '__regexp_matches', '__regexp_split_to_array', '__div', '__safe_divide', '__at_time_zone', '__resolve', 'ptrs', 'dbTables', 'aliases', 'includes', 'Math', 'Date'];
          s = s.replace(/('([^'\\]|\\.)*'|"([^"\\]|\\.)*")|\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g, (m, stringLit, _1, _2, word) => {
              if (stringLit) return m;
              if (!word) return m;
              if (protectedKeywords.includes(word) || word.startsWith('__STR_')) return word;
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

          return new Function('__L', __EXPR_PRELUDE +
              '\nreturn function(ptrs, dbTables, aliases) {' +
              '\n    try {' +
              '\n        return (' + s + ');' +
              '\n    } catch (e) {' +
              "\n        if (e.message && e.message.includes('not found')) throw e;" +
              '\n        return null;' +
              '\n    }' +
              '\n};')(__EXPR_LIB);
      },

      splitSelectClause(clause) {
          let parts = [], current = "", depth = 0;
          for (let i = 0; i < clause.length; i++) {
              let c = clause[i];
              if (c === '(') depth++;
              if (c === ')') depth--;
              if (c === ',' && depth === 0) { parts.push(current.trim()); current = ""; }
              else { current += c; }
          }
          parts.push(current.trim());
          return parts;
      }
    });
