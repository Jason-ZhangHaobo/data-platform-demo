import { isDeepStrictEqual as same } from 'node:util';
import { inferCsvSchema, ingestionSchemaHash, parseCsv } from './ingestion.mjs';
import { changeSpecHash, normalizeChangeConfig } from './csv-changelog.mjs';
import { checkedSyncSnapshot } from './sync-run-snapshot.mjs';
import { publishedReportHash } from './published-report-source.mjs';
import { syncSqlLandingContext, validateSyncSqlDeliveryContext } from './sync-sql-input.mjs';
import { materializedSyncInputKind, syncSqlSelectionFromBinding } from './sync-sql-selection.mjs';
import { createHash } from 'node:crypto';

const requireEvidence = (condition, stage) => {
  if (!condition) throw Object.assign(Error('SYNC_SAVED_' + stage), { code: 'SYNC_SAVED_' + stage });
};
const hash = value => createHash('sha256').update(value).digest('hex');
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

// Verifies the archived target state, not an event-log replay or upstream coverage.
// readSnapshot returns the exact retained record from a caller-owned read-only view.
export function verifySavedMaterializedInput({ read, readSnapshot, input, context, csv }) {
  requireEvidence(input?.kind === materializedSyncInputKind, 'INPUT_CHANGED');
  try { validateSyncSqlDeliveryContext(input, context); }
  catch { requireEvidence(false, 'INPUT_PROJECTION_CHANGED'); }
  requireEvidence(typeof readSnapshot === 'function', 'TARGET_SNAPSHOT_REQUIRED');
  const source = read('offline_sync_run', input.runId), task = read('offline_sync_task', input.taskId);
  const metadata = read('source_metadata', input.metadataVersionId), revision = read('source_revision', input.sourceRevisionId);
  const frozen = read('sync_sql_input', input.snapshotId);
  requireEvidence(source && task && metadata && revision && frozen, 'RECORD_MISSING');
  const records = [[source, input.runId], [task, input.taskId], [metadata, input.metadataVersionId],
    [revision, input.sourceRevisionId], [frozen, input.snapshotId]];
  requireEvidence(records.every(([record, id]) => record.id === id && record.projectId === task.projectId) &&
    typeof task.projectId === 'string' && task.projectId.length > 0, 'INPUT_CHANGED');
  const selection = syncSqlSelectionFromBinding(input);
  const frozenSource = { taskId: input.taskId, sourceRevisionId: input.sourceRevisionId,
    metadataVersionId: input.metadataVersionId, rowCount: input.rowCount };
  requireEvidence(frozen.contentHash === input.snapshotHash && same(frozen.payload,
    { actorId: input.actorId, selection, source: frozenSource, context }), 'INPUT_PROJECTION_CHANGED');
  const change = input.mode === 'INCREMENTAL_CHANGELOG';
  const config = Object.fromEntries(['sourceRevisionId', 'sourceType', 'metadataVersionId', 'targetTable', 'mode',
    'mapping', 'keyFields', 'watermarkField', ...(change ? ['changeConfig', 'changeSpecHash'] : [])].map(key => [key, task[key]]));
  const parsed = parseCsv(csv), columns = inferCsvSchema(parsed), contentHash = hash(csv);
  requireEvidence(task.sourceType === 'LOCAL_CSV' && revision.sourceType === 'LOCAL_CSV' && task.mode === input.mode &&
    task.sourceRevisionId === revision.id && task.metadataVersionId === metadata.id && metadata.revisionId === revision.id &&
    task.sourceId === revision.sourceId && metadata.sourceId === revision.sourceId &&
    source.taskId === task.id && source.status === 'SUCCEEDED' && source.actualExecution === true &&
    source.snapshotStatus === 'RETAINED' && source.sourceRevisionId === revision.id && source.metadataVersionId === metadata.id &&
    source.targetTable === input.targetTable && task.targetTable === input.targetTable &&
    task.configHash === publishedReportHash(config) && source.configHash === task.configHash &&
    metadata.contentHash === contentHash && source.sourceHash === contentHash && metadata.bytes === Buffer.byteLength(csv) &&
    metadata.rowCount === parsed.rows.length && source.readCount === parsed.rows.length && source.finalCount === input.rowCount &&
    source.targetHash === input.targetHash && source.landingSnapshotHash === input.landingSnapshotHash &&
    same(columns, metadata.columns) && metadata.schemaHash === ingestionSchemaHash(columns) &&
    Number.isFinite(time(source.finishedAt)), 'INPUT_CHANGED');
  if (change) {
    let normalized;
    try { normalized = normalizeChangeConfig(task.changeConfig, task.mapping, task.keyFields); }
    catch { requireEvidence(false, 'CHANGE_BINDING_CHANGED'); }
    const state = source.changeState;
    requireEvidence(same(normalized, task.changeConfig) && task.changeSpecHash === changeSpecHash(normalized, task.mapping, task.keyFields) &&
      normalized.epochId === input.changeEpochId && state?.epochId === input.changeEpochId && state.specHash === task.changeSpecHash &&
      state.changeStateHash === input.changeStateHash, 'CHANGE_BINDING_CHANGED');
    requireEvidence(['appliedEvents', 'deleteEvents', 'duplicateEvents', 'staleEvents'].every(k => Number.isSafeInteger(state[k]) && state[k] >= 0) &&
      ['inserted', 'updated', 'unchanged', 'deleted'].every(k => Number.isSafeInteger(source[k]) && source[k] >= 0) &&
      source.readCount === state.appliedEvents + state.duplicateEvents + state.staleEvents && state.deleteEvents <= state.appliedEvents &&
      source.inserted + source.updated + source.unchanged === state.appliedEvents - state.deleteEvents && source.deleted <= state.deleteEvents,
    'CHANGE_BINDING_CHANGED');
  }
  let archived;
  try {
    archived = checkedSyncSnapshot(readSnapshot(source.id), { runId: source.id, targetTable: task.targetTable,
      binding: { projectId: task.projectId, taskId: task.id, sourceId: task.sourceId, sourceRevisionId: revision.id,
        metadataVersionId: metadata.id, configHash: task.configHash, sourceHash: contentHash },
      targetHash: input.targetHash, rowCount: input.rowCount, snapshotHash: input.landingSnapshotHash });
  } catch { requireEvidence(false, 'TARGET_SNAPSHOT_CHANGED'); }
  const fields = Object.values(task.mapping);
  requireEvidence(archived.rows.every(row => row && !Array.isArray(row) && same(Object.keys(row).sort(), [...fields, 'rowKey'].sort()) &&
      row.rowKey === task.keyFields.map(key => String(row[key] ?? '')).join('\u001f')) &&
    Number.isFinite(time(archived.createdAt)) && time(archived.createdAt) <= time(source.finishedAt), 'TARGET_SNAPSHOT_CHANGED');
  const reconstructed = syncSqlLandingContext(archived.rows, fields);
  requireEvidence(same(reconstructed, context), 'INPUT_PROJECTION_CHANGED');
  return { syncRunId: source.id, metadataVersionId: metadata.id, sourceRevisionId: revision.id, snapshotHash: input.snapshotHash,
    contentHash, targetHash: source.targetHash, rows: input.rowCount, finishedAt: source.finishedAt,
    proof: { protocol: 'shuduo-materialized-input-proof/v1', scope: 'RETAINED_TARGET_SNAPSHOT', targetTable: input.targetTable,
      mode: input.mode, landingSnapshotHash: input.landingSnapshotHash, snapshotCreatedAt: archived.createdAt,
      sourceCsvRows: parsed.rows.length, targetRows: input.rowCount,
      ...(change ? { changeEpochId: input.changeEpochId, changeStateHash: input.changeStateHash, historicalControlReplayVerified: false } : {}),
      upstreamCoverageVerified: false, eventReplayVerified: false } };
}
