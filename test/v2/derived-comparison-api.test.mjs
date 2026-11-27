import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MetadataStore } from '../../src/v2/store.mjs';
import { BusinessQueryStore } from '../../src/v2/data-services.mjs';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { V2Client } from '../../src/v2/client.mjs';
import { runV2Cli } from '../../bin/shuduo.mjs';
import { handleV2Mcp } from '../../bin/shuduo-mcp.mjs';
import { checkedDerivedComparison, readDerivedComparison } from '../../src/v2/derived-comparison-client.mjs';
import { readComparisonSql } from '../../src/v2/run-comparison-client.mjs';
import { seedContextDerivation } from './fixtures/agent-context-derivation.mjs';

test('owner reads the same saved parent and child via invited HTTP, CLI and MCP', async t => {
  const store = new MetadataStore(':memory:');
  const businessStore = new BusinessQueryStore();
  let executions = 0;
  function unexpectedExecution() { executions++; throw Error('Unexpected compute'); }
  const app = createV2Server({ store, businessStore, runner: unexpectedExecution, modelRunner: unexpectedExecution,
    env: { V2_LOCAL_DEVELOPMENT: 'false', V2_RELEASE_SCHEDULER_MODE: 'DISABLED' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    businessStore.close();
    store.close();
  });
  const password = 'SyntheticLocalTest#1217';
  const admin = app.auth.bootstrapAdmin({ email: 'admin@example.invalid', displayName: '虚构管理员', password });
  const adminSession = app.auth.login({ email: admin.email, password });
  const issuer = app.auth.sessionFromHeaders({cookie: 'shuduo_session='+adminSession.rawToken});
  function engineer(email) {
    const invitation = app.auth.createInvitation(issuer, {email, role: 'ENGINEER'});
    return app.auth.redeemInvitation({inviteCode: invitation.inviteCode, displayName: '虚构工程师', password});
  }
  const owner = engineer('owner@example.invalid'), other = engineer('other@example.invalid');
  const baseUrl = 'http://127.0.0.1:'+app.server.address().port+'/api/v2';
  function as(session) {
    return new V2Client({baseUrl, fetchImpl: (url, init) => fetch(url, {...init, headers: {
      ...init.headers, ...(session && {cookie: 'shuduo_session='+session.rawToken})
    }})});
  }
  const parent = seedContextDerivation(store, PROJECT, {actorId:owner.user.id});
  const child = seedContextDerivation(store, PROJECT, {actorId:owner.user.id, contextId:'cash-change'});
  store.update('agent', child.task.id, PROJECT, {initialSql:parent.sql, derivedFrom:{
    ...parent.derivation, contextId:parent.task.contextId, validationContractId:parent.family.id
  }});
  const snapshot = () => createHash('sha256').update(JSON.stringify(
    store.db.prepare('SELECT data FROM documents ORDER BY id').all())).digest('hex');
  const start = snapshot(), client = as(owner), args = {taskId:child.task.id};
  const receipt = await readDerivedComparison(client,args);
  assert.equal(receipt.state,'MATCHED');
  assert.equal(receipt.parent.runId,parent.run.id);
  assert.equal(receipt.child.runId,child.run.id);
  assert.deepEqual(receipt.rows.map(row => [row.clientId,row.before.total_assets,row.after.total_assets,row.delta.available_cash]),[
    ['CLIENT-001','1800.00','2300.00','500.00'], ['CLIENT-002','950.00','950.00','0.00']
  ]);
  assert.equal(receipt.totals.after.total_assets,'3250.00');
  assert.deepEqual(await readComparisonSql(client,{derived:receipt}),{baselineSql:parent.sql,currentSql:child.sql});
  await assert.rejects(readComparisonSql({request:async path=>({...await client.request(path),sql:'SELECT 9'})},{derived:receipt}));
  let cli;
  assert.equal(await runV2Cli(['agent','compare-derived','--id',child.task.id], {}, {
    client, output: value => {cli=JSON.parse(value);}, error: () => {}
  }),0);
  assert.deepEqual(cli,receipt);
  const tool = 'agent_derived_result_comparison';
  const listing = JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'}));
  assert.equal(listing.result.tools.find(item=>item.name===tool).annotations.readOnlyHint,true);
  const mcp = async input => JSON.parse(await handleV2Mcp({
    jsonrpc:'2.0',id:2,method:'tools/call',params:{name:tool,arguments:input}
  },{client}));
  assert.deepEqual(JSON.parse((await mcp(args)).result.content[0].text),receipt);
  assert.ok((await mcp({...args,parentId:parent.task.id})).error);
  for (const session of [other,adminSession]) {
    await assert.rejects(readDerivedComparison(as(session),args), e=>e.status===403);
  }
  await assert.rejects(readDerivedComparison(as(),args), e=>e.status===401);
  const path='/agent/tasks/'+child.task.id+'/derivation-comparison';
  await assert.rejects(client.request(path+'?parentId='+parent.task.id), e=>e.status===422);
  const unrelated=await readDerivedComparison(client,{taskId:parent.task.id});
  assert.equal(unrelated.reason,'NOT_DERIVED');
  await assert.rejects(readComparisonSql({request:()=>assert.fail('Unexpected SQL read')},{derived:unrelated}),/待核对/);
  assert.equal(Object.hasOwn(unrelated,'rows'),false);
  assert.equal(snapshot(),start);
  assert.equal(executions,0);

  await t.test('client discards stale bindings, customer duplicates and inconsistent amounts',() => {
    assert.throws(()=>checkedDerivedComparison(receipt,{...args,parent:{runId:child.run.id}}));
    assert.throws(()=>checkedDerivedComparison({...unrelated,rows:receipt.rows},{taskId:parent.task.id}));
    for (const mutate of [
      r=>{r.rows=[];}, r=>{r.rows[0].delta.available_cash='0.00';},
      r=>{r.rows[0].clientId=r.rows[1].clientId;}, r=>{r.totals.before.security_count++;},
      r=>{r.rows[0].before.total_assets='1700.00';}
    ]) {
      const copy=structuredClone(receipt);
      mutate(copy);
      assert.throws(()=>checkedDerivedComparison(copy,args));
    }
  });
});
