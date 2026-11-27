export const amountFields = Object.freeze(['holding_market_value', 'available_cash', 'total_assets']);

export function formatCents(cents) {
  const absolute = cents < 0n ? -cents : cents;
  return (cents < 0n ? '-' : '') + (absolute / 100n) + '.' + String(absolute % 100n).padStart(2,'0');
}

export function amountInCents(value) {
  if (typeof value !== "number" && typeof value !== "string") return;
  const match = /^(-?)(\d{1,38})(?:\.(\d{1,38}))?$/.exec(String(value));
  if (!match || /[1-9]/.test((match[3] ?? "").slice(2))) return;
  const magnitude = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").slice(0, 2).padEnd(2, "0"));
  if (typeof value === "number" && magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return match[1] ? -magnitude : magnitude;
}
