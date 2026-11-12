#!/usr/bin/env node
import { parseArgs } from "node:util";
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { ReportDataStore } from "../src/v2/reports.mjs";
import { verifySavedFundLifecycle } from "../src/v2/fund-saved-lifecycle.mjs";

const required = ["active-metadata", "business-snapshots", "history-metadata", "report-snapshots",
  "request-id", "dapi-call-id", "xapi-call-id"];
const stores = [];
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(required.map(name => [name, { type: "string" }])),
    project: { type: "string", default: "project-securities-lab" },
    actor: { type: "string", default: "local-engineer" },
  } });
  if (required.some(key => !values[key]?.trim()) || !values.project.trim() || !values.actor.trim())
    throw Object.assign(new Error("FUND_EVIDENCE_ARGUMENTS_REQUIRED"), { code: "FUND_EVIDENCE_ARGUMENTS_REQUIRED" });
  const open = (Store, path) => {
    const store = new Store(path, { readOnly: true });
    stores.push(store);
    return store;
  };
  const result = await verifySavedFundLifecycle({
    activeStore: open(MetadataStore, values["active-metadata"]),
    historyStore: open(MetadataStore, values["history-metadata"]),
    businessStore: open(BusinessQueryStore, values["business-snapshots"]),
    reportStore: open(ReportDataStore, values["report-snapshots"]),
    project: values.project, actor: values.actor, requestId: values["request-id"],
    dapiCallId: values["dapi-call-id"], xapiCallId: values["xapi-call-id"],
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code : "FUND_SAVED_LIFECYCLE_VERIFICATION_FAILED";
  process.stderr.write(JSON.stringify({ status: "FAILED", code }) + "\n");
  process.exitCode = 1;
} finally {
  for (const store of stores.reverse()) store.close();
}
