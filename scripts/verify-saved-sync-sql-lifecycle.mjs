#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { ReportDataStore } from "../src/v2/reports.mjs";
import { verifySavedSyncSqlLifecycle } from "../src/v2/sync-sql-saved-lifecycle.mjs";

const required = ["metadata", "business-snapshots", "report-snapshots", "source-csv", "package-file",
  "release-id", "package-digest", "agent-request-id"];
const stores = [];
const invalid = () => Object.assign(Error("SYNC_SAVED_ARGUMENTS_REQUIRED"), { code: "SYNC_SAVED_ARGUMENTS_REQUIRED" });
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(required.map(key => [key, { type: "string" }])),
    lineage: { type: "string", multiple: true, default: [] },
    project: { type: "string", default: "project-securities-lab" },
    actor: { type: "string", default: "local-engineer" },
    "test-clock-unit-ms": { type: "string", default: "1000" },
  } });
  if ([...required,"project","actor"].some(key => !values[key]?.trim()) || values.lineage.length !== 2 ||
      !/^[1-9]\d*$/.test(values["test-clock-unit-ms"])) throw invalid();
  const open = (Store, key) => {
    if (!lstatSync(values[key]).isFile()) throw invalid();
    const db = new Store(values[key], { readOnly: true });
    stores.push(db);
    db.db.exec("BEGIN");
    return db;
  };
  const text = path => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1024 * 1024) throw invalid();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  };
  const result = await verifySavedSyncSqlLifecycle({ store: open(MetadataStore,"metadata"),
    businessStore: open(BusinessQueryStore,"business-snapshots"), reportStore: open(ReportDataStore,"report-snapshots"),
    project: values.project, actor: values.actor, releaseId: values["release-id"], packageDigest: values["package-digest"],
    requestId: values["agent-request-id"], timeUnitMs: Number(values["test-clock-unit-ms"]), csv: text(values["source-csv"]),
    originalPackage: JSON.parse(text(values["package-file"])), lineages: values.lineage.map(path => JSON.parse(text(path))),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code : "SYNC_SAVED_VERIFICATION_FAILED";
  process.stderr.write(JSON.stringify({ status: "FAILED", code }) + "\n");
  process.exitCode = 1;
} finally {
  for (const store of stores.reverse()) {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    store.close();
  }
}
