#!/usr/bin/env node
import { parseArgs } from "node:util";
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { ReportDataStore } from "../src/v2/reports.mjs";
import { verifySavedFundLifecycle } from "../src/v2/fund-saved-lifecycle.mjs";
import { verifySavedFundAgentLifecycle } from "../src/v2/fund-agent-saved-lifecycle.mjs";

const common = ["active-metadata", "business-snapshots", "request-id"];
const manual = ["history-metadata", "report-snapshots"];
const agent = ["task-id", "release-id", "package-digest"];
const stores = [];
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries([...common, ...manual, ...agent].map(name => [name, { type: "string" }])),
    agent: { type: "boolean", default: false },
    "dapi-call-id": { type: "string", multiple: true, default: [] },
    "xapi-call-id": { type: "string", multiple: true, default: [] },
    project: { type: "string", default: "project-securities-lab" },
    actor: { type: "string", default: "local-engineer" },
  } });
  const required = [...common, ...(values.agent ? agent : manual)];
  const forbidden = values.agent ? manual : agent;
  const dapiCallIds = values["dapi-call-id"], xapiCallIds = values["xapi-call-id"];
  if (required.some(key => !values[key]?.trim()) || forbidden.some(key => values[key] !== undefined) ||
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
  const scope = { businessStore: open(BusinessQueryStore, values["business-snapshots"]), project: values.project,
    actor: values.actor, requestId: values["request-id"] };
  const result = values.agent
    ? await verifySavedFundAgentLifecycle({ ...scope, store: activeStore, taskId: values["task-id"],
      releaseId: values["release-id"], packageDigest: values["package-digest"], dapiCallIds, xapiCallIds })
    : await verifySavedFundLifecycle({ ...scope, activeStore, historyStore: open(MetadataStore, values["history-metadata"]),
      reportStore: open(ReportDataStore, values["report-snapshots"]), dapiCallId: dapiCallIds[0], xapiCallId: xapiCallIds[0] });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
