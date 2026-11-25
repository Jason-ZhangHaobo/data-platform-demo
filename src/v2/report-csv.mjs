function csvCell(value) {
  const input = String(value ?? "");
  return /[",\n]/.test(input) ? `"${input.replaceAll('"', '""')}"` : input;
}

export function encodeReportCsv(rows) {
  return rows.map(row => row.map(csvCell).join(",")).join("\n") + "\n";
}
