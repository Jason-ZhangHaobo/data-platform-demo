#!/usr/bin/env node
import {inputEvidenceReaders} from '../src/v2/input-evidence.mjs';
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DatabaseSync } from 'node:sqlite';
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { ReportDataStore } from "../src/v2/reports.mjs";
import { verifySavedSyncSqlLifecycle, verifySavedSyncSqlPackageInput } from "../src/v2/sync-sql-saved-lifecycle.mjs";

const required = ["metadata", "business-snapshots", "report-snapshots", "source-csv", "package-file",
  "release-id", "package-digest", "agent-request-id"];
const stores = [];
const invalid = () => Object.assign(Error("SYNC_SAVED_ARGUMENTS_REQUIRED"), { code: "SYNC_SAVED_ARGUMENTS_REQUIRED" });
try {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(required.map(key => [key, { type: "string" }])),
    lineage: { type: "string", multiple: true, default: [] },
    "consumption-only": { type: "boolean", default: false },
    "input-only": { type: "boolean", default: false },
    "input-evidence": { type: "string" },
    "landing-snapshots": { type: "string" },
    "verify-quality": { type: "boolean", default: false },
    "quality-receipt": { type: "string", multiple: true, default: [] },
    project: { type: "string", default: "project-securities-lab" },
    actor: { type: "string", default: "local-engineer" },
    "test-clock-unit-ms": { type: "string", default: "1000" },
  } });
  const consumptionOnly=values["consumption-only"],inputOnly=values['input-only'],evidenceFile=values['input-evidence'];
  const selectedRequired=inputOnly?[...(evidenceFile===undefined?['metadata']:['input-evidence']),'source-csv','package-file','package-digest']:consumptionOnly?required.filter(key=>key!=="report-snapshots"):required;
  if (evidenceFile!==undefined&&(!inputOnly||values.metadata!==undefined||values['landing-snapshots']!==undefined)||[...selectedRequired,"project","actor"].some(key => !values[key]?.trim()) ||
      (inputOnly ? consumptionOnly || ['business-snapshots','report-snapshots','release-id','agent-request-id'].some(key=>values[key]!==undefined) || values.lineage.length>0 || values['verify-quality']
        : consumptionOnly ? values["report-snapshots"]!==undefined || values.lineage.length>0 || values["verify-quality"]
        : values.lineage.length!==2) ||
      values["quality-receipt"].length > 2 || (!values["verify-quality"] && values["quality-receipt"].length > 0) ||
      !/^[1-9]\d*$/.test(values["test-clock-unit-ms"])) throw invalid();
  const open = (Store, key) => {
    if (!lstatSync(values[key]).isFile()) throw invalid();
    const db = new Store(values[key], { readOnly: true });
    stores.push(db);
    db.db.exec("BEGIN");
    return db;
  };
  const text = (path,maxBytes=4*1024*1024) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw invalid();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  };
  let readSnapshot;
  if(values['landing-snapshots']!==undefined){
    if(!values['landing-snapshots'].trim()||!lstatSync(values['landing-snapshots']).isFile())throw invalid();
    const db=new DatabaseSync(values['landing-snapshots'],{readOnly:true});
    stores.push({db,close:()=>db.close()});db.exec('BEGIN');
    readSnapshot=runId=>db.prepare('SELECT * FROM landing_run_snapshots WHERE run_id=?').get(runId);
  }
  const originalPackage=JSON.parse(text(values['package-file']));
  const readers=evidenceFile===undefined?{store:open(MetadataStore,'metadata'),readSnapshot}:inputEvidenceReaders(JSON.parse(text(evidenceFile)),{bundle:originalPackage,project:values.project,actor:values.actor});
  const common={...readers,project:values.project,actor:values.actor,packageDigest:values['package-digest'],csv:text(values['source-csv'],5_000_000),originalPackage};
  const result = inputOnly?verifySavedSyncSqlPackageInput(common):await verifySavedSyncSqlLifecycle({ ...common,
    businessStore: open(BusinessQueryStore,"business-snapshots"),
    ...(consumptionOnly ? {consumptionOnly} : {reportStore:open(ReportDataStore,"report-snapshots")}),
    releaseId: values["release-id"], requestId: values["agent-request-id"], timeUnitMs: Number(values["test-clock-unit-ms"]),
    lineages: values.lineage.map(path => JSON.parse(text(path))),
    ...(values["verify-quality"] ? { qualityReceipts: values["quality-receipt"].map(path => JSON.parse(text(path))) } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.status === "PENDING") process.exitCode = 2;
  if (result.status === "FAILED") process.exitCode = 1;
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
