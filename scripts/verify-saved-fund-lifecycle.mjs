#!/usr/bin/env node
import { parseArgs } from "node:util";
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { ReportDataStore } from "../src/v2/reports.mjs";
import { verifySavedFundLifecycle } from "../src/v2/fund-saved-lifecycle.mjs";
import { verifySavedFundAgentLifecycle } from "../src/v2/fund-agent-saved-lifecycle.mjs";
import { createFundSignedReceipts } from "../src/v2/fund-signed-receipts.mjs";

const common = ["active-metadata", "business-snapshots", "request-id"];
const manual = ["history-metadata", "report-snapshots"];
const agent = ["task-id", "release-id", "package-digest"];
const agentReport = ["report-request-id", "report-snapshots"];
const localAgentEvidence = ["signed-receipt-root", "test-clock-unit-ms"];
const stores = [];
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries([...common, ...manual, ...agent, ...localAgentEvidence, "report-request-id"].map(name => [name, { type: "string" }])),
    agent: { type: "boolean", default: false },
    "dapi-call-id": { type: "string", multiple: true, default: [] },
    "xapi-call-id": { type: "string", multiple: true, default: [] },
    project: { type: "string", default: "project-securities-lab" },
    actor: { type: "string", default: "local-engineer" },
  } });
  const includeAgentReport = values.agent && [...agentReport, "history-metadata"].some(key => values[key] !== undefined);
  const required = [...common, ...(values.agent ? agent : manual), ...(includeAgentReport ? agentReport : [])];
  const forbidden = values.agent ? [] : [...agent, ...localAgentEvidence, "report-request-id"];
  const dapiCallIds = values["dapi-call-id"], xapiCallIds = values["xapi-call-id"];
  const receiptRoot = values["signed-receipt-root"], clockArgument = values["test-clock-unit-ms"];
  const timeUnitMs = clockArgument === undefined ? undefined : Number(clockArgument);
  if (required.some(key => !values[key]?.trim()) || forbidden.some(key => values[key] !== undefined) ||
      includeAgentReport && values["history-metadata"] !== undefined && !values["history-metadata"].trim() ||
      receiptRoot !== undefined && !receiptRoot.trim() ||
      clockArgument !== undefined && (!/^[1-9]\d{0,3}$/.test(clockArgument) || timeUnitMs > 1000) ||
      !values.project.trim() || !values.actor.trim() || [dapiCallIds, xapiCallIds].some(ids => !ids.length || ids.some(id => !id.trim())) ||
      !values.agent && (dapiCallIds.length !== 1 || xapiCallIds.length !== 1))
    throw Object.assign(new Error("FUND_EVIDENCE_ARGUMENTS_REQUIRED"), { code: "FUND_EVIDENCE_ARGUMENTS_REQUIRED" });
  const open = (Store, path) => {
    const store = new Store(path, { readOnly: true });
    stores.push(store);
    store.db.exec("BEGIN");
    return store;
  };
  const activeStore = open(MetadataStore, values["active-metadata"]);
  const signingResolver = store => {
    if (receiptRoot === undefined) return;
    const receipts = createFundSignedReceipts({ store, project: values.project, root: receiptRoot, env: process.env });
    return bundle => receipts.read(bundle.manifest.source.runId);
  };
  const scope = { businessStore: open(BusinessQueryStore, values["business-snapshots"]), project: values.project,
    actor: values.actor, requestId: values["request-id"] };
  const reportMetadata = includeAgentReport && (values["history-metadata"] ? open(MetadataStore, values["history-metadata"]) : activeStore);
  const reportEvidence = includeAgentReport ? {
    store: reportMetadata, reportStore: open(ReportDataStore, values["report-snapshots"]), requestId: values["report-request-id"],
    fundSignedExecutionFor: signingResolver(reportMetadata),
  } : undefined;
  const result = values.agent
    ? await verifySavedFundAgentLifecycle({ ...scope, store: activeStore, taskId: values["task-id"],
      releaseId: values["release-id"], packageDigest: values["package-digest"], dapiCallIds, xapiCallIds, reportEvidence,
      fundSignedExecutionFor: signingResolver(activeStore), timeUnitMs })
    : await verifySavedFundLifecycle({ ...scope, activeStore, historyStore: open(MetadataStore, values["history-metadata"]),
      reportStore: open(ReportDataStore, values["report-snapshots"]), dapiCallId: dapiCallIds[0], xapiCallId: xapiCallIds[0] });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (["INCOMPLETE", "QUALITY_FAILED"].includes(result.status)) process.exitCode = 2;
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code : "FUND_SAVED_LIFECYCLE_VERIFICATION_FAILED";
  process.stderr.write(JSON.stringify({ status: "FAILED", code }) + "\n");
  process.exitCode = 1;
} finally {
  for (const store of stores.reverse()) {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    store.close();
  }
}
