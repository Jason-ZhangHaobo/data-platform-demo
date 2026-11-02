// Conservative lexical comparison, not SQL equivalence or validation. Keep
// token text/case, quoted content, comments and compound operators intact.
// Ambiguous/incomplete input is comparable only when its original bytes match.
function layoutTokens(sql) {
  const tokens = [];
  let offset = 0, previousQuoted = false;
  while (offset < sql.length) {
    const start = offset;
    while (/[ \t\r\n]/.test(sql[offset] ?? "") && offset < sql.length) offset++;
    const separated = offset > start;
    if (offset === sql.length) break;
    const tokenStart = offset, quote = sql[offset], quoted = ["'", '"', "`"].includes(quote);
    if (quoted) {
      offset++; let closed = false;
      while (offset < sql.length) {
        if (quote !== "`" && sql[offset] === "\\") { offset += 2; continue; }
        if (sql[offset] === quote) {
          if (sql[offset + 1] === quote) { offset += 2; continue; }
          offset++; closed = true; break;
        }
        offset++;
      }
      if (!closed) return undefined;
    } else if (sql.startsWith("--", offset)) {
      offset += 2;
      while (offset < sql.length && !/[\r\n]/.test(sql[offset])) offset++;
    } else if (sql.startsWith("/*", offset)) {
      offset += 2; let depth = 1;
      while (offset < sql.length && depth) {
        if (sql.startsWith("/*", offset)) { depth++; offset += 2; }
        else if (sql.startsWith("*/", offset)) { depth--; offset += 2; }
        else offset++;
      }
      if (depth) return undefined;
    } else {
      const remaining = sql.slice(offset);
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:[bB][dD]|[dDfFlLsSyY])?/.exec(remaining)?.[0];
      if (number && !/[\p{L}\p{N}_$]/u.test(sql[offset + number.length] ?? "")) offset += number.length;
      else if (/[\p{L}\p{N}_$]/u.test(sql[offset])) {
        while (offset < sql.length && /[\p{L}\p{N}_$]/u.test(sql[offset])) offset++;
      } else {
        const operator = /^(?:<=>|>>>|<=|>=|!=|<>|==|=>|\|\||&&|::|->|<<|>>)/.exec(remaining)?.[0];
        offset += operator?.length ?? 1;
      }
    }
    // Preserve adjacency beside quoted values: r'raw' must not collapse to
    // r 'raw', and quoted identifiers/literals must never be rewritten.
    tokens.push([sql.slice(tokenStart, offset), (quoted || previousQuoted) && separated]);
    previousQuoted = quoted;
  }
  return tokens;
}

export function sameSqlIgnoringLayout(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left.trim() || !right.trim() || left.length > 20000 || right.length > 20000) return false;
  if (left === right) return true;
  const a = layoutTokens(left), b = layoutTokens(right);
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
