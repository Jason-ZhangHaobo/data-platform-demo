import { createHash } from "node:crypto";
import { getContext, validationFamilyForContext } from "./context.mjs";

const schema = "shuduo-validation-details/v1";
const fields = ["holding_market_value", "available_cash", "total_assets", "security_count"];
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : "";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
const decimal = value => {
  if (typeof value !== "string" || value.length > 64 || !/^-?\d{1,38}(?:\.\d{1,18})?$/.test(value)) return undefined;
  const negative = value.startsWith("-"), [whole, part = ""] = (negative ? value.slice(1) : value).split(".");
  const integer = whole.replace(/^0+(?=\d)/, ""), fraction = part.replace(/0+$/, "");
  return `${negative && (integer !== "0" || fraction) ? "-" : ""}${integer}${fraction ? "." + fraction : ""}`;
};
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
export function equalValidationNumber(left, right) {
  if (!["string", "number"].includes(typeof left) || !["string", "number"].includes(typeof right)) return false;
  const a = decimal(String(left).trim()), b = decimal(String(right).trim());
  return a !== undefined && b !== undefined && a === b;
}
const exact = (value, allowed, required = allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));

function mismatch(value, expected) {
  if (!value || typeof value !== "object") return undefined;
  const client = expected.get(value.clientId);
  switch (value.kind) {
    case "VALUE_MISMATCH":
    case "INVALID_VALUE": {
      const keys = value.kind === "VALUE_MISMATCH" ? ["kind", "clientId", "field", "expected", "actual"] : ["kind", "clientId", "field", "expected"];
      if (!exact(value, keys) || !client || !fields.includes(value.field) || !id(value.clientId)) return undefined;
      const want = decimal(value.expected), canonicalWant = decimal(String(client[value.field]));
      if (want === undefined || canonicalWant === undefined || want !== canonicalWant) return undefined;
      if (value.field === "security_count" && !/^\d+$/.test(value.expected)) return undefined;
      if (value.kind === "VALUE_MISMATCH") {
        const actual = decimal(value.actual);
        if (actual === undefined || actual === want) return undefined;
        return { kind: value.kind, clientId: value.clientId, field: value.field, expected: value.expected, actual: value.actual };
      }
      return { kind: value.kind, clientId: value.clientId, field: value.field, expected: value.expected };
    }
    case "MISSING_CLIENT":
      return exact(value, ["kind", "clientId"]) && client && id(value.clientId) ? { kind: value.kind, clientId: value.clientId } : undefined;
    case "DUPLICATE_CLIENT":
      return exact(value, ["kind", "clientId", "actualCount"]) && client && id(value.clientId) && count(value.actualCount) && value.actualCount >= 2
        ? { kind: value.kind, clientId: value.clientId, actualCount: value.actualCount } : undefined;
    case "CLIENT_COUNT":
      return exact(value, ["kind", "expectedCount", "actualCount"]) && count(value.expectedCount) && value.expectedCount === expected.size &&
        count(value.actualCount) && value.actualCount !== value.expectedCount ? { kind: value.kind, expectedCount: value.expectedCount, actualCount: value.actualCount } : undefined;
    case "OUT_OF_SCOPE_CLIENTS":
      return exact(value, ["kind", "actualCount"]) && count(value.actualCount) && value.actualCount > 0 ? { kind: value.kind, actualCount: value.actualCount } : undefined;
    case "OUTPUT_FIELDS":
      return exact(value, ["kind"]) ? { kind: value.kind } : undefined;
    default: return undefined;
  }
}

function scenarioDetails(row, context) {
  const base = { contextId: context.id, name: context.name, passed: row.passed, mismatches: [], totalMismatches: 0, truncated: false };
  if (row.comparison === undefined) return { ...base, detailsStatus: "LEGACY_UNAVAILABLE" };
  const details = row.comparison;
  const invalid = () => ({ ...base, detailsStatus: "INVALID" });
  if (!exact(details, ["schema", "mismatches", "totalMismatches", "truncated"]) || details.schema !== "shuduo-result-comparison/v1" ||
      !Array.isArray(details.mismatches) || details.mismatches.length > 20 || !Number.isSafeInteger(details.totalMismatches) ||
      details.totalMismatches < 0 || details.totalMismatches > 10000 || typeof details.truncated !== "boolean" ||
      details.totalMismatches < details.mismatches.length || details.truncated !== (details.totalMismatches > details.mismatches.length) ||
      row.passed && details.totalMismatches !== 0 || !row.passed && details.totalMismatches === 0) return invalid();
  const expected = new Map(context.expected.map(value => [value.client_id, value]));
  const projected = details.mismatches.map(value => mismatch(value, expected));
  if (projected.some(value => !value) || new Set(projected.map(value => `${value.kind}:${value.clientId ?? ""}:${value.field ?? ""}`)).size !== projected.length)
    return invalid();
  return { ...base, detailsStatus: "AVAILABLE", mismatches: projected, totalMismatches: details.totalMismatches, truncated: details.truncated };
}

// Presentation evidence only. This never changes stored validation, starts work
// or upgrades a failed result. The original revision must still prove the source.
export function validationDetails(run, revision, contextId = run?.contextId) {
  const family = validationFamilyForContext(contextId);
  const source = { runId: id(run?.id), revisionId: id(run?.revisionId), revisionHash: digest(run?.revisionHash),
    contextId: id(contextId), contractId: family?.id ?? "" };
  const unavailable = status => ({ schema, status, source, scenarios: [] });
  if (!run || !["SUCCEEDED", "VALIDATION_FAILED"].includes(run.status) || run.engine !== "Apache Spark" || run.mainSqlExecuted !== true || run.testDouble === true || !family)
    return unavailable("UNVERIFIED");
  const cases = run.validation?.regressions;
  if (!Array.isArray(cases) || cases.length !== family.contextIds.length || new Set(cases.map(row => row?.contextId)).size !== cases.length ||
      cases.some(row => !row || !family.contextIds.includes(row.contextId) || typeof row.passed !== "boolean")) return unavailable("UNVERIFIED");
  // Old receipts remain readable without fabricating missing details. No values
  // can be disclosed on this path, even if older metadata lacks full binding.
  if (cases.every(row => row.comparison === undefined)) return unavailable("LEGACY_UNAVAILABLE");
  if (!source.runId || !source.revisionId || !source.revisionHash || !revision || !id(run.projectId) || run.projectId !== revision.projectId ||
      revision.id !== run.revisionId || revision.hash !== run.revisionHash || typeof revision.sql !== "string" ||
      createHash("sha256").update(revision.sql).digest("hex") !== revision.hash || revision.contextId !== contextId || run.contextId !== contextId ||
      run.validationContractId !== family.id || run.validation?.contractId !== family.id) return unavailable("UNVERIFIED");
  const scenarios = family.contextIds.map(key => scenarioDetails(cases.find(row => row.contextId === key), getContext(key)));
  return { schema, status: "AVAILABLE", source, scenarios };
}

// A malformed comparison must not bypass the checked projection through the old
// raw validation property. Leave the existing verdicts and error summaries intact.
export function validationWithoutRawComparisons(validation) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return validation;
  const { comparison, ...summary } = validation;
  if (!Array.isArray(summary.regressions)) return summary;
  return { ...summary, regressions: summary.regressions.map(row => {
    if (!row || typeof row !== "object") return row;
    const { comparison, ...legacy } = row;
    return legacy;
  }) };
}
