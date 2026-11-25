import { inputEvidencePath } from './input-evidence-client.mjs';
import { inputEvidenceCanonical } from './input-evidence-contract.mjs';

export const packageInputCheckPath = input => inputEvidencePath(input).replace('/input-evidence?', '/input-check?');

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (obj, fields) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === fields.length && fields.every(key => Object.hasOwn(obj,key));
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validProof(proof, rows) {
  if (proof === undefined) return true; // The original full CSV replay uses the v1 input fields alone.
  if (proof?.protocol === 'shuduo-mysql-archive-input-proof/v1') {
    return exact(proof, ['protocol','scope','sourceType','mode','targetTable','syncTaskId','landingReceiptHash',
      'landingSnapshotHash','targetRows','upstreamCoverageVerified']) &&
      proof.scope === 'RETAINED_MYSQL_FULL_SNAPSHOT' && proof.sourceType === 'SERVER_MYSQL' &&
      proof.mode === 'FULL' && proof.targetTable === 'raw_positions' &&
      uuid(proof.syncTaskId) && sha(proof.landingReceiptHash) && sha(proof.landingSnapshotHash) &&
      rows > 0 && proof.targetRows === rows && proof.upstreamCoverageVerified === false;
  }
  if (proof?.protocol !== 'shuduo-materialized-input-proof/v1') return false;
  const changelog = proof.mode === 'INCREMENTAL_CHANGELOG';
  return exact(proof, ['protocol','scope','targetTable','mode','landingSnapshotHash','snapshotCreatedAt',
    'sourceCsvRows','targetRows','upstreamCoverageVerified','eventReplayVerified',
    ...(changelog ? ['changeEpochId','changeStateHash','historicalControlReplayVerified'] : [])]) &&
    proof.scope === 'RETAINED_TARGET_SNAPSHOT' && ['FULL','INCREMENTAL_UPSERT','INCREMENTAL_CHANGELOG'].includes(proof.mode) &&
    typeof proof.targetTable === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(proof.targetTable) &&
    validDate(proof.snapshotCreatedAt) && proof.targetRows === rows && Number.isInteger(proof.sourceCsvRows) &&
    proof.sourceCsvRows >= 0 && sha(proof.landingSnapshotHash) && proof.upstreamCoverageVerified === false &&
    proof.eventReplayVerified === false &&
    (!changelog || uuid(proof.changeEpochId) && sha(proof.changeStateHash) && proof.historicalControlReplayVerified === false);
}

function validProvenance(value) {
  return exact(value, ['developmentMode','newSparkRuns','newModelCalls','cloudRequests','publicDeployed',
    'countsTowardLiveEvaluation','agentIndependentE2E','fullLifecycleE2E']) &&
    ['LIVE_MODEL','SYNTHETIC_MODEL','MANUAL'].includes(value.developmentMode) &&
    value.newSparkRuns === 0 && value.newModelCalls === 0 && value.cloudRequests === 0 && value.publicDeployed === false &&
    value.countsTowardLiveEvaluation === false && value.agentIndependentE2E === false && value.fullLifecycleE2E === false;
}

function matchesFrozenInput(origin, expected) {
  if (!expected) return true;
  for (const [field, observed] of Object.entries({
    runId:origin.syncRunId, metadataVersionId:origin.metadataVersionId, sourceRevisionId:origin.sourceRevisionId,
    targetHash:origin.targetHash, snapshotHash:origin.snapshotHash, rowCount:origin.rows,
  })) {
    if (expected[field] !== undefined && expected[field] !== observed) return false;
  }
  // Plain CSV replay predates retained-snapshot evidence. Only compare the
  // extra bindings carried by each proof variant.
  const proof = origin.proof;
  if (proof && expected.landingSnapshotHash !== undefined && expected.landingSnapshotHash !== proof.landingSnapshotHash) return false;
  return proof?.sourceType !== 'SERVER_MYSQL' || expected.taskId === undefined || expected.taskId === proof.syncTaskId;
}

export async function checkedPackageInputCheck(value, expected) {
  const origin = value?.input;
  if (!exact(value, ['status','scope','packageDigest','input','provenance','protocol','readOnly','binding',
        'sourceCsvExposed','evidenceDigest']) || value.protocol !== 'shuduo-package-input-check/v1' ||
      value.status !== 'VERIFIED' || value.scope !== 'LOCAL_SAVED_INPUT_ONLY' || value.readOnly !== true ||
      value.sourceCsvExposed !== false || !exact(value.binding,['packageId','packageDigest']) ||
      !uuid(expected?.packageId) || !sha(expected.packageDigest) || value.binding.packageId !== expected.packageId ||
      value.packageDigest !== expected.packageDigest || value.binding.packageDigest !== expected.packageDigest ||
      !sha(value.evidenceDigest) || !validProvenance(value.provenance) ||
      !exact(origin,['syncRunId','metadataVersionId','sourceRevisionId','snapshotHash','contentHash','targetHash',
        'rows','finishedAt',...(origin?.proof === undefined ? [] : ['proof'])]) ||
      ![origin.syncRunId,origin.metadataVersionId,origin.sourceRevisionId].every(uuid) ||
      ![origin.snapshotHash,origin.contentHash,origin.targetHash].every(sha) ||
      !Number.isInteger(origin.rows) || origin.rows < 0 || origin.rows > 500 || !validDate(origin.finishedAt) ||
      !validProof(origin.proof,origin.rows) ||
      expected.sourceType !== undefined && (expected.sourceType !== 'SERVER_MYSQL' || origin.proof?.sourceType !== expected.sourceType) ||
      !matchesFrozenInput(origin,expected.expectedSyncInput))
    throw Error('原包输入核验回执未确认，请重新核验同一版本');

  const {evidenceDigest, ...body} = value;
  const bytes = new TextEncoder().encode(inputEvidenceCanonical(body));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const digest = Array.from(hash,n => n.toString(16).padStart(2,'0')).join('');
  if (digest !== evidenceDigest) throw Error('原包输入核验摘要不一致，请重新读取');
  return value;
}

export async function readPackageInputCheck(client, input) {
  return checkedPackageInputCheck(await client.request(packageInputCheckPath(input)), input);
}
