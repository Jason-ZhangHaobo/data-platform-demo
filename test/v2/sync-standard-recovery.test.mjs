import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IngestionManager, LandingStore } from '../../src/v2/ingestion.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { snapshotDataStores, replaceDataStores, validateDataState } from '../../src/v2/data-state-replica.mjs';
import { StreamStateStore } from '../../src/v2/realtime.mjs';
import { BusinessQueryStore } from '../../src/v2/data-services.mjs';
import { ReportDataStore } from '../../src/v2/reports.mjs';

const project = 'fictional-standard-recovery';
const mapping = { holding_id: 'position_id', holding_value: 'amount', customer_id: 'client_id', biz_date: 'trade_date' };
function requestFor(task, requestKey = randomUUID()) {
  const requestSignature = createHash('sha256').update(JSON.stringify({
    taskId: task.id, configHash: task.configHash, sourceRevisionId: task.sourceRevisionId,
  })).digest('hex');
  return { requestKey, requestSignature };
}

function setup(t, fixtureRoot = resolve('fixtures/sources')) {
  const dir = mkdtempSync(join(tmpdir(), 'shuduo-standard-recovery-'));
  const state = { dir };
  const open = () => {
    state.store = new MetadataStore(join(dir, 'metadata.sqlite'));
    state.landing = new LandingStore(join(dir, 'landing.sqlite'));
    state.manager = new IngestionManager({ store: state.store, landingStore: state.landing, project, fixtureRoot });
  };
  const close = () => { state.landing.close(); state.store.close(); };
  open();
  t.after(() => { close(); rmSync(dir, { recursive: true, force: true }); });
  return Object.assign(state, {
    reopen() { close(); open(); },
    source(fileName = 'positions_aliased.csv') {
      const source = state.manager.createSource({ name: '虚构证券原批次数据源', sourceType: 'LOCAL_CSV', fileName });
      state.manager.testConnection(source.id);
      state.manager.collectMetadata(source.id);
      return source;
    },
    task(source, mode = 'FULL') {
      return state.manager.createTask({ name: '虚构证券原批次任务', sourceId: source.id, targetTable: 'synthetic_holdings',
        mode, mapping, keyFields: ['position_id'], watermarkField: 'trade_date' });
    },
    change(source, fileName) {
      state.manager.createSourceRevision(source.id, { fileName });
      state.manager.testConnection(source.id);
      state.manager.collectMetadata(source.id);
    },
  });
}

function loseFirstTerminalWrite(store, targetKind = 'offline_sync_run') {
  const update = store.update.bind(store);
  let lost = false;
  store.update = (kind, id, projectId, patch, options) => {
    if (!lost && kind === targetKind && patch.status === 'SUCCEEDED') {
      lost = true;
      throw Error('Fictional metadata update failure');
    }
    return update(kind, id, projectId, patch, options);
  };
}

for (const mode of ['FULL', 'INCREMENTAL_UPSERT']) {
  test(`real CSV ${mode} recovers an original atomic commit after SQLite reopen and later overwrite`, t => {
    const f = setup(t), source = f.source();
    if (mode !== 'FULL') {
      f.manager.runTask(f.task(source).id);
      f.change(source, 'positions_aliased_incremental.csv');
    }
    const task = f.task(source, mode), request = requestFor(task);
    loseFirstTerminalWrite(f.store);
    assert.throws(() => f.manager.runTask(task.id, request), { code: 'SYNC_RESULT_UNCONFIRMED' });
    const pending = f.manager.taskDetail(task.id).runs[0];
    assert.equal(pending.status, 'UNCONFIRMED');
    assert.equal(f.landing.inspectTarget(task.targetTable).runId, pending.id);
    const initial = f.manager.taskRunRequest(task.id, request.requestKey);
    assert.equal(initial.state, 'LANDING_COMMITTED');
    assert.equal(initial.run.id, pending.id);
    assert.ok(!Object.hasOwn(initial.run, 'error') && !Object.hasOwn(initial.run, 'requestSignature'));
    const expected = mode === 'FULL'
      ? { inserted: 3, updated: 0, unchanged: 0, readCount: 3, finalCount: 3, amount: '500.00' }
      : { inserted: 1, updated: 1, unchanged: 0, readCount: 2, finalCount: 4, amount: '650.00' };
    for (const key of ['inserted', 'updated', 'unchanged', 'readCount', 'finalCount'])
      assert.equal(initial.landingEvidence[key], expected[key]);

    f.reopen();
    f.change(source, mode === 'FULL' ? 'positions_aliased_incremental.csv' : 'positions_aliased.csv');
    const laterTask = f.task(source, 'FULL'), later = f.manager.runTask(laterTask.id);
    const current = f.landing.inspectTarget(task.targetTable), runsBefore = f.store.list('offline_sync_run', project);
    const readback = f.manager.taskRunRequest(task.id, request.requestKey);
    assert.deepEqual(readback, initial);
    assert.deepEqual(f.store.list('offline_sync_run', project), runsBefore);
    assert.throws(() => f.manager.taskRunRequest(laterTask.id, request.requestKey), { status: 404 });
    assert.throws(() => f.manager.taskRunRequest(task.id, randomUUID()), { code: 'SYNC_RUN_REQUEST_NOT_FOUND' });
    assert.throws(() => f.manager.runTask(task.id, { ...request, requestSignature: 'different' }), { code: 'SYNC_IDEMPOTENCY_CONFLICT' });

    let writes = 0;
    const sync = f.landing.sync.bind(f.landing);
    f.landing.sync = (...args) => { writes++; return sync(...args); };
    const original = f.manager.runTask(task.id, request);
    assert.equal(original.id, pending.id);
    assert.equal(original.reconciled, true);
    assert.equal(original.replayed, true);
    assert.equal(original.landingReceiptHash, readback.landingEvidence.receiptHash);
    assert.equal(original.finishedAt, readback.landingEvidence.landedAt);
    assert.equal(writes, 0);
    assert.equal(f.manager.taskRunRequest(task.id, request.requestKey).state, 'SUCCEEDED');
    assert.equal(f.store.list('offline_sync_run', project).length, runsBefore.length);
    assert.equal(f.landing.inspectTarget(task.targetTable).runId, later.id);
    assert.deepEqual(f.landing.inspectTarget(task.targetTable), current);
    const archive = f.manager.previewRunSnapshot(task.id, original.id);
    assert.equal(archive.currentTarget.matchesOriginalRun, false);
    assert.equal(archive.rows.find(row => row.position_id === 'POS-002').amount, expected.amount);
  });
}

test('explicit settlement validates the exact basis before metadata-only recovery and reads the original archive', t => {
  const f = setup(t), source = f.source(), task = f.task(source), request = requestFor(task);
  loseFirstTerminalWrite(f.store);
  assert.throws(() => f.manager.runTask(task.id, request), { code: 'SYNC_RESULT_UNCONFIRMED' });
  const pending = f.manager.taskRunRequest(task.id, request.requestKey);
  const basis = { runId: pending.run.id, receiptHash: pending.landingEvidence.receiptHash };

  f.reopen();
  f.change(source, 'positions_aliased_incremental.csv');
  const laterTask = f.task(source), later = f.manager.runTask(laterTask.id);
  assert.equal(f.landing.inspectTarget(task.targetTable).runId, later.id);
  const runs = f.store.list('offline_sync_run', project);
  const tasks = f.store.list('offline_sync_task', project);
  const target = f.landing.inspectTarget(task.targetTable);
  f.manager.fixtureRoot = join(f.dir, 'no-source-files');
  f.landing.sync = () => assert.fail('settlement must not write landing rows');
  const create = f.store.create.bind(f.store), update = f.store.update.bind(f.store);
  let metadataWrites = 0;
  f.store.create = (kind, ...args) => {
    assert.notEqual(kind, 'offline_sync_run', 'settlement must not create a run');
    return create(kind, ...args);
  };
  f.store.update = (...args) => { metadataWrites++; return update(...args); };

  assert.throws(() => f.manager.settleTaskRunRequest(task.id, randomUUID(), basis), { code: 'SYNC_RUN_REQUEST_NOT_FOUND' });
  assert.throws(() => f.manager.settleTaskRunRequest(laterTask.id, request.requestKey, basis), { code: 'SYNC_RUN_REQUEST_NOT_FOUND' });
  assert.throws(() => f.manager.settleTaskRunRequest(task.id, request.requestKey, { ...basis, runId: later.id }),
    { code: 'SYNC_SETTLEMENT_BASIS_MISMATCH' });
  assert.throws(() => f.manager.settleTaskRunRequest(task.id, request.requestKey, { ...basis, receiptHash: later.landingReceiptHash }),
    { code: 'SYNC_SETTLEMENT_BASIS_MISMATCH' });
  assert.throws(() => f.manager.settleTaskRunRequest(task.id, request.requestKey, { ...basis, targetTable: task.targetTable }),
    { code: 'INVALID_SYNC_SETTLEMENT_BASIS' });
  assert.equal(metadataWrites, 0);
  assert.deepEqual(f.store.list('offline_sync_run', project), runs);
  assert.deepEqual(f.store.list('offline_sync_task', project), tasks);
  assert.deepEqual(f.manager.taskRunRequest(task.id, request.requestKey), pending);

  const settled = f.manager.settleTaskRunRequest(task.id, request.requestKey, basis);
  assert.equal(settled.state, 'SUCCEEDED');
  assert.equal(settled.run.id, basis.runId);
  assert.equal(settled.landingEvidence.receiptHash, basis.receiptHash);
  assert.equal(metadataWrites, 2);
  assert.deepEqual(f.manager.settleTaskRunRequest(task.id, request.requestKey, basis), settled);
  assert.equal(metadataWrites, 2);
  assert.deepEqual(f.landing.inspectTarget(task.targetTable), target);
  const archive = f.manager.previewRunSnapshot(task.id, basis.runId);
  assert.equal(archive.rows.find(row => row.position_id === 'POS-002').amount, '500.00');
  assert.equal(archive.currentTarget.matchesOriginalRun, false);
});

test('a receipt insert failure rolls back rows, latest commit and archive with the failed original request', t => {
  const f = setup(t), source = f.source(), task = f.task(source), request = requestFor(task);
  const before = f.landing.inspectTarget(task.targetTable);
  f.landing.db.exec("CREATE TEMP TRIGGER reject_commit_receipt BEFORE INSERT ON landing_run_receipts BEGIN SELECT RAISE(ABORT, 'fictional receipt fault'); END");
  assert.throws(() => f.manager.runTask(task.id, request));
  const value = f.manager.taskRunRequest(task.id, request.requestKey);
  assert.equal(value.state, 'FAILED');
  assert.equal(value.landingEvidence, undefined);
  assert.deepEqual(f.landing.inspectTarget(task.targetTable), before);
  assert.equal(f.landing.db.prepare('SELECT count(*) AS n FROM landing_run_snapshots').get().n, 0);
  assert.equal(f.landing.db.prepare('SELECT count(*) AS n FROM landing_run_receipts').get().n, 0);
  assert.throws(() => f.manager.settleTaskRunRequest(task.id, request.requestKey, {
    runId: value.run.id, receiptHash: 'f'.repeat(64),
  }), { code: 'SYNC_LANDING_RECEIPT_MISSING' });
  f.landing.db.exec('DROP TRIGGER reject_commit_receipt');
  assert.equal(f.manager.runTask(task.id, request).id, value.run.id);
  assert.deepEqual(f.landing.inspectTarget(task.targetTable), before);
});

test('a lost task summary write leaves a confirmed run intact and older reconciliation cannot replace a later task run', t => {
  const f = setup(t), task = f.task(f.source()), request = requestFor(task);
  loseFirstTerminalWrite(f.store, 'offline_sync_task');
  assert.throws(() => f.manager.runTask(task.id, request), { code: 'SYNC_RESULT_UNCONFIRMED' });
  const confirmed = f.manager.taskRunRequest(task.id, request.requestKey);
  assert.equal(confirmed.state, 'SUCCEEDED');
  const original = f.manager.settleTaskRunRequest(task.id, request.requestKey, {
    runId: confirmed.run.id, receiptHash: confirmed.landingEvidence.receiptHash,
  });
  assert.deepEqual(original, confirmed);
  assert.equal(f.manager.taskDetail(task.id).status, 'SUCCEEDED');
  loseFirstTerminalWrite(f.store);
  const secondRequest = requestFor(task);
  assert.throws(() => f.manager.runTask(task.id, secondRequest), { code: 'SYNC_RESULT_UNCONFIRMED' });
  const latest = f.manager.runTask(task.id, requestFor(task));
  const recovered = f.manager.runTask(task.id, secondRequest);
  assert.notEqual(recovered.id, original.run.id);
  assert.equal(f.manager.taskDetail(task.id).lastRunId, latest.id);
  assert.equal(f.landing.inspectTarget(task.targetTable).runId, latest.id);
});

test('interrupted and legacy failed runs lacking a new exact receipt are not rerun or promoted', t => {
  const f = setup(t), firstTask = f.task(f.source()), request = requestFor(firstTask);
  const pending = f.store.create('offline_sync_run', project, { taskId: firstTask.id,
    configHash: firstTask.configHash, sourceRevisionId: firstTask.sourceRevisionId, metadataVersionId: firstTask.metadataVersionId,
    ...request, standardReceiptVersion: 1, actualExecution: true, startedAt: new Date().toISOString(), status: 'INTERRUPTED' });
  const view = f.manager.taskRunRequest(firstTask.id, request.requestKey);
  assert.equal(view.run.id, pending.id);
  assert.equal(view.state, 'UNCONFIRMED');
  assert.equal(view.landingEvidence, undefined);
  assert.throws(() => f.manager.runTask(firstTask.id, request), { code: 'SYNC_RUN_UNCERTAIN' });
  assert.equal(f.landing.inspectTarget(firstTask.targetTable).rowCount, 0);

  const failed = f.manager.runTask(firstTask.id, requestFor(firstTask));
  f.store.update('offline_sync_run', failed.id, project, { status: 'FAILED', standardReceiptVersion: undefined, landingReceiptHash: undefined });
  f.landing.db.prepare('DELETE FROM landing_run_receipts WHERE run_id=?').run(failed.id);
  const legacy = f.manager.taskRunRequest(firstTask.id, failed.requestKey);
  assert.equal(legacy.state, 'FAILED');
  assert.equal(legacy.landingEvidence, undefined);
  assert.throws(() => f.manager.previewRunSnapshot(firstTask.id, failed.id), { code: 'SYNC_RUN_NOT_SUCCEEDED' });
  assert.equal(f.manager.runTask(firstTask.id, requestFor(firstTask, failed.requestKey)).status, 'FAILED');
});

test('new execution receipt survives the archive byte cap and validates across state replay without reconstructing an archive', t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'shuduo-standard-cap-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fictionalClient = 'CUST-FICTIONAL-' + 'X'.repeat(400);
  const rows = Array.from({ length: 3000 }, (_, i) => `POS-${i},${fictionalClient},1.00,2026-09-10`);
  writeFileSync(join(fixtureRoot, 'positions_cap.csv'), `holding_id,customer_id,holding_value,biz_date\n${rows.join('\n')}\n`);
  const f = setup(t, fixtureRoot), task = f.task(f.source('positions_cap.csv')), request = requestFor(task);
  loseFirstTerminalWrite(f.store);
  assert.throws(() => f.manager.runTask(task.id, request), { code: 'SYNC_RESULT_UNCONFIRMED' });
  const evidence = f.manager.taskRunRequest(task.id, request.requestKey);
  assert.equal(evidence.state, 'LANDING_COMMITTED');
  assert.equal(evidence.landingEvidence.snapshotStatus, 'NOT_RETAINED_LIMIT');
  assert.equal(evidence.landingEvidence.readCount, 3000);
  assert.equal(evidence.landingEvidence.watermark, '2026-09-10');

  const otherStores = { streamStateStore: new StreamStateStore(), businessStore: new BusinessQueryStore(), reportStore: new ReportDataStore() };
  const cold = new LandingStore();
  t.after(() => { cold.close(); for (const store of Object.values(otherStores)) store.close(); });
  const originalPayload = snapshotDataStores({ landingStore: f.landing, ...otherStores }, project);
  assert.equal(originalPayload.tables.landingRunReceipts.length, 1);
  assert.equal(originalPayload.tables.landingRunSnapshots.length, 0);
  const tampered = structuredClone(originalPayload);
  tampered.tables.landingRunReceipts[0].receipt_hash = '0'.repeat(64);
  assert.throws(() => validateDataState(tampered, project), { code: 'CLOUD_DATA_STATE_INVALID' });
  const legacy = structuredClone(originalPayload);
  delete legacy.tables.landingRunReceipts;
  const wire = JSON.stringify(legacy);
  assert.equal(JSON.stringify(validateDataState(legacy, project)), wire);

  replaceDataStores({ landingStore: cold, ...otherStores }, originalPayload, project);
  const reopened = new IngestionManager({ store: f.store, landingStore: cold, project, fixtureRoot });
  assert.deepEqual(reopened.taskRunRequest(task.id, request.requestKey), evidence);
  const settled = reopened.runTask(task.id, request);
  assert.equal(settled.snapshotStatus, 'NOT_RETAINED_LIMIT');
  const archive = reopened.previewRunSnapshot(task.id, settled.id);
  assert.equal(archive.status, 'NOT_RETAINED');
  assert.equal(archive.reason, 'RETENTION_LIMIT');
  assert.equal(archive.rows, undefined);
});

async function syntheticMysqlTask(f) {
  const rows = [{ position_id: 'POS-FICTIONAL', amount: '100.00', trade_date: '2026-09-10' }];
  let reads = 0;
  f.manager.serverMysqlAdapter = {
    profileId: 'fictional-server-mysql', allowTables: ['synthetic_positions'], supportsOfflineSync: true,
    async probe() { return { status: 'CONNECTED', serverVersion: '8.0.synthetic' }; },
    async describe(tableName) {
      return { tableName, rowCount: 1, columns: [
        { name: 'position_id', type: 'VARCHAR', nullable: false },
        { name: 'amount', type: 'DECIMAL', nullable: false },
        { name: 'trade_date', type: 'DATE', nullable: false },
      ] };
    },
    async readRows() { reads++; return { rows }; },
  };
  const source = f.manager.createSource({ name: '虚构 MySQL 持仓', sourceType: 'SERVER_MYSQL', tableName: 'synthetic_positions' });
  await f.manager.testServerMysqlConnection(source.id);
  await f.manager.collectServerMysqlMetadata(source.id);
  const task = f.manager.createTask({ name: '虚构 MySQL 原批次', sourceId: source.id, targetTable: 'synthetic_holdings',
    mode: 'FULL', mapping: { position_id: 'position_id', amount: 'amount', trade_date: 'trade_date' },
    keyFields: ['position_id'], watermarkField: 'trade_date' });
  return { task, readCount: () => reads };
}

test('a committed MySQL adapter batch settles after the adapter is disabled without reconnecting', async t => {
  const f = setup(t), { task, readCount } = await syntheticMysqlTask(f);
  const request = requestFor(task);
  loseFirstTerminalWrite(f.store);
  await assert.rejects(f.manager.runServerMysqlTask(task.id, request), { code: 'SYNC_RESULT_UNCONFIRMED' });
  const original = f.manager.taskRunRequest(task.id, request.requestKey);
  assert.equal(original.state, 'LANDING_COMMITTED');
  f.reopen();
  const settled = await f.manager.runServerMysqlTask(task.id, request);
  assert.equal(settled.id, original.run.id);
  assert.equal(settled.sourceType, 'SERVER_MYSQL');
  assert.equal(settled.sourceStrategy, 'BOUNDED_FULL_SNAPSHOT');
  assert.equal(settled.watermark, '2026-09-10');
  assert.equal(readCount(), 1);
  assert.equal(f.manager.taskRunRequest(task.id, request.requestKey).state, 'SUCCEEDED');
});

for (const sourceType of ['LOCAL_CSV', 'SERVER_MYSQL']) {
  test(`a ${sourceType} start pointer failure records only the new failure and preserves the previous task summary`, async t => {
    const f = setup(t), mysql = sourceType === 'SERVER_MYSQL' ? await syntheticMysqlTask(f) : undefined;
    const task = mysql?.task ?? f.task(f.source());
    const execute = async request => mysql
      ? f.manager.runServerMysqlTask(task.id, request) : f.manager.runTask(task.id, request);
    const previous = await execute(requestFor(task)), priorSummary = f.store.get('offline_sync_task', task.id, project);
    const priorTarget = f.landing.inspectTarget(task.targetTable);
    const request = requestFor(task);
    const update = f.store.update.bind(f.store);
    f.store.update = (kind, id, projectId, patch, options) => {
      if (kind === 'offline_sync_task' && patch.status === 'RUNNING')
        throw Object.assign(Error('Fictional task pointer failure before write'), { code: 'SYNTHETIC_TASK_START_FAILED' });
      return update(kind, id, projectId, patch, options);
    };
    f.landing.sync = () => assert.fail('a failed task pointer must precede the landing transaction');
    const readReceipt = f.landing.readStandardRunReceipt.bind(f.landing);
    f.landing.readStandardRunReceipt = () => assert.fail('a known prelanding failure needs no landing evidence');

    await assert.rejects(execute(request), { code: 'SYNTHETIC_TASK_START_FAILED' });
    f.landing.readStandardRunReceipt = readReceipt;
    const failed = f.manager.taskRunRequest(task.id, request.requestKey);
    assert.equal(failed.state, 'FAILED');
    assert.notEqual(failed.run.id, previous.id);
    assert.equal(failed.run.errorCode, 'SYNTHETIC_TASK_START_FAILED');
    assert.equal(failed.landingEvidence, undefined);
    assert.equal((await execute(request)).id, failed.run.id);
    assert.deepEqual(f.store.get('offline_sync_task', task.id, project), priorSummary);
    assert.deepEqual(f.landing.inspectTarget(task.targetTable), priorTarget);
    assert.equal(f.landing.db.prepare('SELECT count(*) AS n FROM landing_run_receipts').get().n, 1);
    if (mysql) assert.equal(mysql.readCount(), 1);
  });
}
