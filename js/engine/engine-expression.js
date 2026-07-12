    // ============================================================================
    // [DatabaseEngine Expression] - SQL式のJS関数へのコンパイル / 文字列リテラル処理
    // ============================================================================
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

      compileCondition(expr, strMap) {
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

          // Enhanced CASE WHEN to support multiple WHEN clauses
          let caseRegex = /\bCASE\b([\s\S]+?)\bEND\b/i;
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

          s = s.replace(/\bIS\s+NOT\s+NULL\b/gi, '!== null').replace(/\bIS\s+NULL\b/gi, '=== null');
          s = s.replace(/([a-zA-Z0-9_.]+)\s+(NOT\s+)?BETWEEN\s+(.+?)\s+AND\s+(.+?)(?=\s*(?:AND\b|OR\b|\)|$))/gi, (m, col, not, a, b) => `${not ? '!' : ''}(__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases) >= ${a} && __resolve('${col.toLowerCase()}', ptrs, dbTables, aliases) <= ${b})`);
          s = s.replace(/([a-zA-Z0-9_.]+)\s+(NOT\s+)?LIKE\s+(__STR_\d+__)/gi, (m, col, not, strRef) => `${not ? '!' : ''}__like(__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases), ${strRef})`);
          s = s.replace(/([a-zA-Z0-9_.]+)\s+(NOT\s+)?REGEXP\s+__STR_(\d+)__/gi, (m, col, not, strIdx) => {
              // DoSガード(ReDoS緩和): 異常に長い正規表現パターンをコンパイル時に拒否する
              const lit = strMap[Number(strIdx)];
              if (lit && lit.length > 1002) throw new Error("REGEXP pattern too long (max 1000 characters).");
              return `${not ? '!' : ''}__regexp(__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases), __STR_${strIdx}__)`;
          });

          // Execute IN / NOT IN replacements before standalone NOT replacements
          s = s.replace(/([a-zA-Z0-9_.]+)\s+NOT\s+IN\s*\(([^)]*)\)/gi, (m, col, vals) => `!([${vals}].includes(__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases)))`);
          s = s.replace(/([a-zA-Z0-9_.]+)\s+IN\s*\(([^)]*)\)/gi, (m, col, vals) => `[${vals}].includes(__resolve('${col.toLowerCase()}', ptrs, dbTables, aliases))`);

          // CAST(expr AS TYPE) -> __cast(expr, 'TYPE')（1段の括弧ネストまで対応）
          let castRegex = /\bCAST\s*\(((?:[^()]|\([^()]*\))*?)\s+AS\s+([a-zA-Z]+)\s*\)/i;
          let castM;
          while ((castM = s.match(castRegex))) {
              const inner = castM[1];
              const castType = castM[2].toUpperCase();
              s = s.replace(castM[0], () => `__cast(${inner}, '${castType}')`);
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

          const protectedKeywords = ['&&', '||', '!', 'true', 'false', 'null', 'undefined', '__cast', '__like', '__regexp', '__upper', '__lower', '__length', '__round', '__coalesce', '__substring', '__substring_index', '__concat', '__concat_ws', '__locate', '__truncate', '__replace', '__trim', '__abs', '__ceil', '__floor', '__now', '__lpad', '__rpad', '__power', '__sqrt', '__year', '__month', '__day', '__mod', '__sign', '__rand', '__date', '__datediff', '__ifnull', '__nullif', '__if', '__left', '__right', '__instr', '__reverse', '__repeat', '__greatest', '__least', '__exp', '__log', '__log10', '__pi', '__hour', '__minute', '__second', '__ltrim', '__rtrim', '__ascii', '__char', '__sin', '__cos', '__tan', '__sinh', '__asin', '__acos', '__atan', '__atan2', '__degrees', '__radians', '__ln', '__cbrt', '__date_add', '__date_sub', '__dayofweek', '__dayofyear', '__quarter', '__last_day', '__curdate', '__resolve', 'ptrs', 'dbTables', 'aliases', 'includes', 'Math', 'Date'];
          s = s.replace(/('([^'\\]|\\.)*'|"([^"\\]|\\.)*")|\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g, (m, stringLit, _1, _2, word) => {
              if (stringLit) return m;
              if (!word) return m;
              if (protectedKeywords.includes(word) || word.startsWith('__STR_')) return word;
              return `__resolve('${word.toLowerCase()}', ptrs, dbTables, aliases)`;
          });

          strMap.forEach((str, i) => {
              // 置換文字列はコールバックで返す。値に含まれる '$'（$&, $', $1 等）が
              // String.replace の特殊置換パターンとして誤解釈され、'^A$' のような
              // リテラル（末尾$や$+特殊文字）を壊すのを防ぐ
              s = s.replace(new RegExp(`__STR_${i}__`, 'g'), () => str);
          });

          return new Function('ptrs', 'dbTables', 'aliases', `
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
                  if (!tName) throw new Error("Column '" + col + "' not found.");
                  let actualTbl = als[tName] || tName;
                  if (!dbs[actualTbl] || !dbs[actualTbl].cols[cName]) throw new Error("Column '" + col + "' not found.");
                  let idx = pts[tName];
                  if (idx === undefined || idx === null || idx === -1) return null;
                  return dbs[actualTbl].getValue(cName, idx);
              };
              const __like = (val, pattern) => {
                 if(val === null || val === undefined) return false;
                 let regexPattern = '^' + pattern.replace(/[.*+?^\\$\\{\\}()|\\[\\]\\\\]/g, '\\\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$';
                 return new RegExp(regexPattern, 'i').test(String(val));
              };
              const __upper = (val) => val != null ? String(val).toUpperCase() : null;
              const __lower = (val) => val != null ? String(val).toLowerCase() : null;
              const __length = (val) => val != null ? String(val).length : null;
              const __round = (val) => val != null ? Math.round(Number(val)) : null;
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
              const __locate = (sub, str) => (sub != null && str != null) ? String(str).indexOf(String(sub)) + 1 : null;
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
              const __datediff = (a, b) => (a != null && b != null) ? Math.round((__date_parse(a).getTime() - __date_parse(b).getTime()) / 86400000) : null;
              const __date_add = (v, n) => { if (v == null || n == null) return null; const r = new Date(__date_parse(v).getTime() + Math.trunc(Number(n)) * 86400000); return isNaN(r.getTime()) ? null : r.toISOString().replace('T', ' ').slice(0, 19); };
              const __date_sub = (v, n) => { if (v == null || n == null) return null; const r = new Date(__date_parse(v).getTime() - Math.trunc(Number(n)) * 86400000); return isNaN(r.getTime()) ? null : r.toISOString().replace('T', ' ').slice(0, 19); };
              const __curdate = () => new Date().toISOString().slice(0, 10);
              const __dayofweek = (v) => v != null ? __date_parse(v).getUTCDay() + 1 : null;
              const __dayofyear = (v) => { if (v == null) return null; const d = __date_parse(v); return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000); };
              const __quarter = (v) => v != null ? Math.floor(__date_parse(v).getUTCMonth() / 3) + 1 : null;
              const __last_day = (v) => { if (v == null) return null; const d = __date_parse(v); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); return e.toISOString().slice(0, 10); };

              const __ltrim = (v) => v != null ? String(v).replace(/^\\s+/, '') : null;
              const __rtrim = (v) => v != null ? String(v).replace(/\\s+$/, '') : null;
              const __ascii = (v) => v != null ? (String(v).length > 0 ? String(v).charCodeAt(0) : 0) : null;
              const __char = (v) => v != null ? String.fromCharCode(Math.trunc(Number(v))) : null;
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
              const __if = (c, a, b) => c ? a : b;
              const __left = (s, n) => s != null ? String(s).slice(0, Math.max(0, Number(n))) : null;
              const __right = (s, n) => { if (s == null) return null; const str = String(s); const k = Math.max(0, Number(n)); return k === 0 ? '' : str.slice(-k); };
              const __instr = (s, sub) => (s != null && sub != null) ? String(s).indexOf(String(sub)) + 1 : null;
              const __reverse = (s) => s != null ? String(s).split('').reverse().join('') : null;
              const __repeat = (s, n) => (s != null && n != null && Number(n) >= 0) ? String(s).repeat(Math.floor(Number(n))) : null;
              const __greatest = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y > x ? y : x);
              const __least = (...args) => args.some(v => v === null || v === undefined) ? null : args.reduce((x, y) => y < x ? y : x);
              const __exp = (v) => v != null ? Math.exp(Number(v)) : null;
              const __log = (v) => (v != null && Number(v) > 0) ? Math.log(Number(v)) : null;
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
                      const d = v instanceof Date ? v : new Date(v);
                      return isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
                  }
                  return v;
              };
              const __mod = (a, b) => (a != null && b != null) ? Number(a) % Number(b) : null;
              const __sign = (val) => val != null ? Math.sign(Number(val)) : null;
              const __rand = () => Math.random();
              const __date = (val) => val != null ? new Date(val) : null;
              try {
                  return ${s};
              } catch(e) {
                  if (e.message && e.message.includes('not found')) throw e;
                  return null;
              }
          `);
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
