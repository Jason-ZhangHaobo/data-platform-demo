export const amountFields = Object.freeze(['holding_market_value', 'available_cash', 'total_assets']);

export function formatCents(cents) {
  const absolute = cents < 0n ? -cents : cents;
  return (cents < 0n ? '-' : '') + (absolute / 100n) + '.' + String(absolute % 100n).padStart(2,'0');
}
