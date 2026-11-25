import {ingestionSchemaHash, ingestionTaskConfigHash} from './ingestion.mjs';
import {syncSnapshotDigest} from './sync-run-snapshot.mjs';

const textTypes = new Set(['CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT']);
const digest = /^[a-f0-9]{64}$/;

export function mysqlArchiveMetadataMatches({store, project}, task, revisionId, metadata) {
  const source = store.get('ingestion_source', task.sourceId, project);
  const revision = store.get('source_revision', revisionId, project);
  return source?.sourceType === 'SERVER_MYSQL' && source.classification === 'SERVER_CONFIGURED_SYNTHETIC_ONLY' &&
    revision?.sourceType === source.sourceType && revision.sourceId === source.id &&
    revision.connectionProfile === 'server-mysql-synthetic' && typeof revision.tableName === 'string' &&
    revision.sourceConfigHash === syncSnapshotDigest({profile:revision.connectionProfile, tableName:revision.tableName}) &&
    metadata?.classification === 'SERVER_MYSQL_SCHEMA_SCAN' && metadata.status === 'COLLECTED' &&
    metadata.sourceId === source.id && metadata.revisionId === revision.id && metadata.objectName === revision.tableName &&
    Array.isArray(metadata.columns) && metadata.columns.every((c,i) => c && typeof c.name === 'string' &&
      typeof c.type === 'string' && typeof c.nullable === 'boolean' && c.ordinal === i+1) &&
    new Set(metadata.columns.map(c => c.name)).size === metadata.columns.length &&
    metadata.schemaHash === ingestionSchemaHash(metadata.columns);
}

export function mysqlArchiveRunMatches(resources, task, run, metadata) {
  if (task.sourceType !== 'SERVER_MYSQL' || task.mode !== 'FULL' || task.targetTable !== 'raw_positions' ||
      run.sourceType !== task.sourceType || run.sourceStrategy !== 'BOUNDED_FULL_SNAPSHOT' ||
      run.standardReceiptVersion !== 1 || !digest.test(run.landingReceiptHash ?? '') ||
      task.configHash !== ingestionTaskConfigHash(task) ||
      !mysqlArchiveMetadataMatches(resources, task, task.sourceRevisionId, metadata)) return false;
  const byName = new Map(metadata.columns.map(c => [c.name, c.type]));
  return Object.entries(task.mapping).every(([from,to]) => {
    const type = byName.get(from);
    if (to === 'trade_date') return type === 'DATE';
    if (to === 'market_value') {
      const decimal = /^DECIMAL\(([1-9]\d?),([012])\)(?: UNSIGNED(?: ZEROFILL)?)?$/.exec(type ?? '');
      return decimal !== null && Number(decimal[1]) <= 65 && Number(decimal[2]) <= Number(decimal[1]);
    }
    return textTypes.has(type);
  });
}
