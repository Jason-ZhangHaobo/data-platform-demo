import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFundSignedReceipts, readPrivateFundReceipt } from "../src/v2/fund-signed-receipts.mjs";
import { MetadataStore } from "../src/v2/store.mjs";
import { PROJECT } from "../src/v2/server.mjs";

const [preflightFile, jobFile, resultFile, ...extra] = process.argv.slice(2);
const root = process.cwd();
let store;
try {
  if (!preflightFile || !jobFile || !resultFile || extra.length || process.env.V2_LOCAL_DEVELOPMENT === "false")
    throw Object.assign(new Error("Expected three protected local files"), { code: "INVALID_LOCAL_REGISTRATION_ARGUMENTS" });
  const preflight = JSON.parse(readPrivateFundReceipt(preflightFile));
  const { taskId, requestId, revisionId, runId, basisDigest } = preflight.source;
  const serializedJob = readPrivateFundReceipt(jobFile).toString("utf8");
  const envelope = JSON.parse(readPrivateFundReceipt(resultFile));
  const metadata = join(root, ".data/v2-platform.sqlite");
  if (!existsSync(metadata)) throw Object.assign(new Error("Expected existing local metadata"), { code: "LOCAL_METADATA_NOT_FOUND" });
  store = new MetadataStore(metadata);
  const receipts = createFundSignedReceipts({ store, project: PROJECT, root, env: process.env });
  const registration = receipts.register({ selection: { taskId, requestId, revisionId, runId, basisDigest },
    preflightDigest: preflight.preflightDigest, jobId: JSON.parse(serializedJob).jobId, serializedJob, envelope });
  console.log(JSON.stringify(registration));
} catch (error) {
  console.error(JSON.stringify({ registered: false, code: error.code ?? "FUND_SIGNED_REGISTRATION_FAILED" }));
  process.exitCode = 1;
} finally { store?.close(); }
