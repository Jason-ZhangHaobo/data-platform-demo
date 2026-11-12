import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { fundContext, fundContextId, fundReferenceSql } from '../../src/v2/fund-lookthrough.mjs';
import { fundContextIds, isFundContext } from '../../src/v2/fund-contexts.mjs';

async function start(t, options) {
  const store = new MetadataStore(':memory:');
  const app = createV2Server({ store, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  const post = (path, body, key) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return { base, post, store };
}

test('fund development publishes scoped schema and uses the regular local version and run API', async t => {
  let executions = 0;
  const { base, post, store } = await start(t, {
    env: { V2_LOCAL_DEVELOPMENT: 'true', V2_RELEASE_SCHEDULER_MODE: 'DISABLED' },
    runner: async ({ context, validationContexts }) => {
      executions++;
      assert.equal(context.id, fundContextId);
      assert.deepEqual(validationContexts.map(item => item.id), [fundContextId]);
      assert.equal(context.expected.length, 7);
      return { status: 'VALIDATION_FAILED', validation: { passed: false } };
    },
  });
  const contexts = await (await fetch(base + '/contexts')).json();
  const context = contexts.find(item => item.id === fundContextId);
  assert.ok(context && !Object.hasOwn(context, 'expected'));
  assert.deepEqual(context.outputContract.keyFields, ['portfolio_id', 'trade_date', 'asset_class']);
  assert.deepEqual(context.tables[0].rows.map(row => row[0]), ['PORT-DEMO-A1', 'PORT-DEMO-A2']);
  assert.ok(context.tables[1].rows.every(row => row[3] === context.businessDate && row[1] !== 'PORT-DEMO-B1'));
  assert.ok(context.tables[2].rows.every(row => row[1] === context.businessDate));
  assert.equal(context.capabilities.agentDevelopment, false);
  assert.equal((await post('/python/revisions', { contextId: fundContextId, code: 'print("Unsupported fund Python")' }, 'fund-python')).status, 422);
  assert.equal((await post('/agent/tasks', { contextId: fundContextId, message: '核对基金组合', code: fundReferenceSql }, 'fund-agent')).status, 422);
  const saved = await post('/revisions', { contextId: fundContextId, sql: fundReferenceSql }, 'save-fund');
  assert.equal(saved.status, 201);
  const revision = await saved.json();
  const started = await post('/runs', { revisionId: revision.id }, 'run-fund');
  assert.equal(started.status, 202);
  const run = await started.json();
  assert.equal((await (await post('/runs', { revisionId: revision.id }, 'run-fund')).json()).id, run.id);
  assert.equal((await post('/delivery/packages', { sourceRunId: run.id }, 'fund-delivery')).status, 422);
  assert.equal(store.get('run', run.id, PROJECT).status, 'VALIDATION_FAILED');
  assert.equal(executions, 1);
  assert.equal(store.list('agent', PROJECT).length, 0);
});

test('a remote Spark profile does not advertise or run fund SQL', async t => {
  const { base, post, store } = await start(t, {
    env: { V2_LOCAL_DEVELOPMENT: 'true' },
    runnerDescriptor: { isolation: 'REMOTE_FUNCTION' },
    runner: async () => { throw Error('fund SQL must never reach the remote runner'); },
  });
  const contexts = await (await fetch(base + '/contexts')).json();
  assert.ok(!contexts.some(item => isFundContext(item.id)));
  const fundSources = await fetch(base + '/data-services/fund-sources');
  assert.equal(fundSources.status, 200);
  assert.deepEqual(await fundSources.json(), []);
  assert.equal((await post('/agent/fund-preparations', {}, randomUUID())).status, 403);
  assert.equal(store.list('agent_fund_preparation', PROJECT).length, 0);

  assert.equal((await post('/revisions', { contextId: fundContextId, sql: fundReferenceSql }, 'blocked-save')).status, 422);
  const revision = store.create('revision', PROJECT, { contextId: fundContextId, sql: fundReferenceSql });
  assert.equal((await post('/runs', { revisionId: revision.id }, 'blocked-run')).status, 403);
  assert.equal(store.list('run', PROJECT).length, 0);
});

test('fund worker preflight rejects an old oracle or old input tables under the new trading day', () => {
  const [oldId, nextId] = fundContextIds;
  const oldContext=fundContext(oldId), next=fundContext(nextId);
  const sample = [next,{...next,expected:oldContext.expected},{...next,tables:oldContext.tables}];
  const code = [
    'import json,sys',
    'sys.path.insert(0,"src/v2")',
    'from fund_lookthrough import registered_inputs',
    'for case in json.load(sys.stdin):',
    ' try:',
    '  registered_inputs(case)',
    '  print("ACCEPTED")',
    ' except ValueError as err:',
    '  print(str(err))',
  ].join('\n');
  const process = spawnSync('python3',['-c',code],{input:JSON.stringify(sample),encoding:'utf8'});
  assert.equal(process.status,0,process.stderr);
  assert.deepEqual(process.stdout.trim().split('\n'),['ACCEPTED','FUND_LOOKTHROUGH_CONTEXT_MISMATCH','FUND_LOOKTHROUGH_INPUT_MISMATCH']);
});
