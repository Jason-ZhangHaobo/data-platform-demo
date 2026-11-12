import { sha256 } from "./delivery.mjs";
import { fundRunMatchesRegisteredResult } from "./fund-delivery.mjs";
import { resolveFundExecutionCandidate } from "./fund-execution-preflight.mjs";
import { verifyQueuedSparkJob, verifyQueuedSparkResult } from "./remote-spark-queue.mjs";

const mismatch = () => Object.assign(new Error("签名 Worker 回执与原基金预检或独立断言不一致"), {
  status: 409, code: "FUND_SIGNED_EXECUTION_MISMATCH",
});

// Pure verification of a previously recorded queue job and its result. The
// caller keeps the expected job ID and immutable bytes from the submission.
export function verifyFundSignedExecution({ source, preflightDigest, jobId, serializedJob, envelope, queueConfig, now = Date.now() }) {
  const { preflight } = resolveFundExecutionCandidate(source, preflightDigest);
  if (typeof jobId !== "string" || jobId === preflight.source.runId ||
      typeof serializedJob !== "string" || queueConfig?.projectId !== source.project) throw mismatch();
  let job;
  try { job = JSON.parse(serializedJob); } catch { throw mismatch(); }
  if (job?.jobId !== jobId) throw mismatch();
  const { sql, context, validationContexts, testSql } = verifyQueuedSparkJob(job, queueConfig, now, { allowExpired: true });
  const requestDigest = sha256(JSON.stringify({ sql, context, validationContexts, testSql }));
  if (requestDigest !== preflight.candidate.requestDigest) throw mismatch();

  if (envelope === undefined) return;
  const result = verifyQueuedSparkResult(envelope, jobId, queueConfig);
  const queueJobDigest = sha256(serializedJob);
  if (result?.queueJobDigest !== queueJobDigest || result.engineVersion !== preflight.candidate.engineVersion ||
      result.testSqlValidation?.passed !== true || result.testSqlValidation.sqlHash !== preflight.candidate.testSqlDigest ||
      !fundRunMatchesRegisteredResult(result, preflight.source.contextId)) throw mismatch();

  return { protocol: "shuduo-fund-signed-execution/v1", status: "VERIFIED", preflightDigest, jobId, queueJobDigest,
    resultDigest: sha256(JSON.stringify(result)), source: preflight.source, requestDigest,
    sqlDigest: preflight.candidate.sqlDigest, testSqlDigest: preflight.candidate.testSqlDigest, rowCount: result.rows.length,
    engine: result.engine, engineVersion: result.engineVersion, approved: false, publicDeployed: false,
    agentIndependentE2E: false };
}
