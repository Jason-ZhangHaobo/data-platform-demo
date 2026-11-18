import { createHash } from 'node:crypto';

// Bounded preview retention, separate from the mutable landing table. Never
// evict an earlier receipt to make a later run appear complete.
export const syncSnapshotLimits = Object.freeze({ rows: 10_000, bytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, JSON.parse(canonical(value[key]))]))
  : value);
export const syncSnapshotDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const syncLandingRows = rows => rows.map(({sourceHash: _source, syncedAt: _time, ...row}) => row);
const invalid = () => Object.assign(Error('原批次快照与运行证据不一致；未使用当前表替代'), {status:409, code:'SYNC_SNAPSHOT_MISMATCH'});
export function buildSyncSnapshot({runId,targetTable,binding,targetHash,rows,createdAt}) {
  const value = {format:'shuduo-sync-run/v1',runId,targetTable,binding,targetHash,createdAt,rows:syncLandingRows(rows)};
  const payload = canonical(value);
  return {payload, snapshotHash:syncSnapshotDigest(value), bytes:Buffer.byteLength(payload)};
}
export function checkedSyncSnapshot(record, {runId,targetTable,binding,targetHash,rowCount,snapshotHash}) {
  try {
    const value = JSON.parse(record.payload);
    if (value.format !== 'shuduo-sync-run/v1' || value.runId !== runId || value.targetTable !== targetTable ||
      !Array.isArray(value.rows) || value.rows.length !== rowCount || value.rows.length > syncSnapshotLimits.rows ||
      Buffer.byteLength(record.payload) !== record.byte_count || record.byte_count > syncSnapshotLimits.bytes ||
      syncSnapshotDigest(value.binding) !== syncSnapshotDigest(binding) || value.targetHash !== targetHash ||
      syncSnapshotDigest(value.rows) !== targetHash || syncSnapshotDigest(value) !== snapshotHash ||
      record.snapshot_hash !== snapshotHash || record.run_id !== runId || record.target_table !== targetTable) throw invalid();
    return value;
  } catch { throw invalid(); }
}
