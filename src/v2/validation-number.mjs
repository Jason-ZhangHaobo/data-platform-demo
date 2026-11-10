const decimal = value => {
  if (typeof value !== "string" || value.length > 64 || !/^-?\d{1,38}(?:\.\d{1,18})?$/.test(value)) return undefined;
  const negative = value.startsWith("-"), [whole, part = ""] = (negative ? value.slice(1) : value).split(".");
  const integer = whole.replace(/^0+(?=\d)/, ""), fraction = part.replace(/0+$/, "");
  return `${negative && (integer !== "0" || fraction) ? "-" : ""}${integer}${fraction ? "." + fraction : ""}`;
};
export function equalValidationNumber(left, right) {
  if (!["string", "number"].includes(typeof left) || !["string", "number"].includes(typeof right)) return false;
  const a = decimal(String(left).trim()), b = decimal(String(right).trim());
  return a !== undefined && b !== undefined && a === b;
}
