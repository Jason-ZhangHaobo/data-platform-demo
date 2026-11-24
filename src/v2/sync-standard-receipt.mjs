import { syncSnapshotDigest } from './sync-run-snapshot.mjs';

export const standardSyncReceiptProtocol = 'shuduo-standard-sync-commit/v1';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const target = /^[a-z][a-z0-9_]{0,62}$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const counts = ['readCount', 'inserted', 'updated', 'unchanged', 'deleted', 'finalCount'];
const bindingFields = ['projectId', 'taskId', 'sourceId', 'sourceRevisionId', 'metadataVersionId', 'configHash', 'sourceHash'];
const invalid = () => Object.assign(Error('原同步落地回执与任务、版本或结果不一致'), {
  status: 409, code: 'SYNC_LANDING_RECEIPT_MISMATCH',
});

export function checkedStandardSyncReceipt(row, projectId) {
  let value;
  try {
    value = JSON.parse(row.payload);
  } catch {
    throw invalid();
  }
  if (!record(value)) throw invalid();
  const binding = value.binding;
  const retained = value.snapshotStatus === 'RETAINED';
  const fields = ['protocol', 'runId', 'targetTable', 'binding', 'mode', 'sourceType', 'requestHash', 'landedAt',
    ...counts, 'targetHash', 'snapshotStatus'];
  if (retained) fields.push('landingSnapshotHash');
  if (Object.hasOwn(value, 'watermark')) fields.push('watermark');
  if (
    !exact(value, fields) || value.protocol !== standardSyncReceiptProtocol ||
    !matches(value.runId, uuid) || value.runId !== row.run_id ||
    !matches(value.targetTable, target) || value.targetTable !== row.target_table ||
    !exact(binding, bindingFields) || typeof binding.projectId !== 'string' || !binding.projectId ||
    (projectId !== undefined && binding.projectId !== projectId) ||
    !['taskId', 'sourceId', 'sourceRevisionId', 'metadataVersionId'].every(key => matches(binding[key], uuid)) ||
    !['configHash', 'sourceHash'].every(key => matches(binding[key], digest)) ||
    !['FULL', 'INCREMENTAL_UPSERT'].includes(value.mode) ||
    !['LOCAL_CSV', 'SERVER_MYSQL'].includes(value.sourceType) ||
    !matches(value.requestHash, digest) || !matches(value.targetHash, digest) ||
    typeof value.landedAt !== 'string' || !Number.isFinite(Date.parse(value.landedAt)) ||
    new Date(value.landedAt).toISOString() !== value.landedAt ||
    !counts.every(key => count(value[key])) ||
    value.readCount !== value.inserted + value.updated + value.unchanged || value.finalCount < value.readCount ||
    (value.mode === 'FULL' ? value.finalCount !== value.inserted : value.deleted !== 0) ||
    (retained ? !matches(value.landingSnapshotHash, digest) : value.snapshotStatus !== 'NOT_RETAINED_LIMIT') ||
    (Object.hasOwn(value, 'watermark') && typeof value.watermark !== 'string') ||
    !matches(row.receipt_hash, digest) || syncSnapshotDigest(value) !== row.receipt_hash
  ) throw invalid();
  return { ...value, receiptHash: row.receipt_hash };
}
