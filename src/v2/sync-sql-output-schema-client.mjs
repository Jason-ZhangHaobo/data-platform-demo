const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const token = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const type = /^(?:[a-z_]{1,24}|decimal\(\d{1,2},\d{1,2}\))$/;
const statuses = ["MATCHED", "MISMATCH", "UNAVAILABLE"];
const issueCodes = ["MISSING", "TYPE", "ORDER", "DUPLICATE", "EXTRA"];
const invalid = () => new Error("输出结构与原运行、代码或快照未核对一致");
const record = value => value && typeof value === "object" && !Array.isArray(value);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const column = (value, limit, nullable) => record(value) &&
  (nullable && value.name === null || matches(token, value.name)) &&
  (nullable && value.type === null || matches(type, value.type)) &&
  Number.isInteger(value.position) && value.position >= 1 && value.position <= limit;

export function checkedSyncSqlOutputSchema(value, expected) {
  const source = value?.source, differences = value?.differences;
  if (value?.protocol !== "shuduo-sync-sql-output-schema/v1" || value.readOnly !== true ||
      !record(source) || !matches(identifier, source.runId) || !matches(identifier, source.revisionId) ||
      !matches(digest, source.revisionHash) || !matches(digest, source.snapshotHash) ||
      source.runId !== expected.runId ||
      ["revisionId", "revisionHash", "snapshotHash"].some(key => expected[key] !== undefined && expected[key] !== source[key]) ||
      !statuses.includes(value.status) || !Array.isArray(differences) || differences.length > 30 ||
      (value.status === "MISMATCH") !== (differences.length > 0)) throw invalid();
  for (const change of differences) {
    if (!record(change) || change.expected !== null && !column(change.expected, 5, false) ||
        change.actual !== null && !column(change.actual, 25, true) || !Array.isArray(change.issues) ||
        change.issues.length === 0 || new Set(change.issues).size !== change.issues.length ||
        change.issues.some(issue => !issueCodes.includes(issue)) ||
        (change.expected === null) !== change.issues.includes("EXTRA") ||
        (change.actual === null) !== change.issues.includes("MISSING")) throw invalid();
  }
  const pick = item => item && { name:item.name, type:item.type, position:item.position };
  return {
    protocol: value.protocol, readOnly: true, status: value.status,
    source: { runId:source.runId, revisionId:source.revisionId, revisionHash:source.revisionHash, snapshotHash:source.snapshotHash },
    differences: differences.map(change => ({
      expected:pick(change.expected), actual:pick(change.actual), issues:[...change.issues],
    })),
  };
}

export async function readSyncSqlOutputSchema(client, { runId }) {
  if (!matches(identifier, runId)) throw invalid();
  return checkedSyncSqlOutputSchema(await client.request("/runs/" + runId + "/output-schema"), { runId });
}
