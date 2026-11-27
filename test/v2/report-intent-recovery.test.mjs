import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {V2Client} from '../../src/v2/client.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {readReportIntent} from '../../src/v2/report-intent-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {seedLocalServiceSource} from './fixtures/local-service-sources.mjs';

test('a source-bound chat can be found by its original request across interfaces only by its owner',async t=>{
  const store=new MetadataStore(':memory:');
  let calls=0;
  const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},
    intentPlanner:async({pinnedReportBatch})=>{
      calls++;assert.equal(pinnedReportBatch,true);
      return {mode:'TEST_DOUBLE',model:'synthetic-intent',usage:{total_tokens:5},route:{
        destinationId:'reports',summary:'创建已选批次的报表',rationale:'使用已选批次完成客户资产报表',confidence:0.9,
        steps:[{destinationId:'reports',objective:'基于选定批次生成报表'}]
      }};
    }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.dispose();store.close();});
  const baseUrl='http://127.0.0.1:'+app.server.address().port+'/api/v2';
  const client=new V2Client({baseUrl});
  const f=seedLocalServiceSource({store,project:PROJECT});
  const source={kind:'AGENT',taskId:f.agent.id,releaseId:f.release.id,packageDigest:f.bundle.digest,
    revisionId:f.revision.id,runId:f.codeRun.id,batchId:f.batches[1].id};
  const message='生成所选第二批的客户资产报表', key=randomUUID();
  const post=(body,id=key)=>client.request('/agent/intents',{method:'POST',idempotencyKey:id,body});
  const original=await post({message,reportSource:source,approvalMode:'REQUEST_APPROVAL'});
  const recovered=await readReportIntent(client,{requestId:key,source});
  assert.equal(recovered.id,original.id);assert.equal(recovered.requestId,key);
  assert.equal(recovered.messageHash,createHash('sha256').update(message).digest('hex'));
  assert.equal(Object.hasOwn(recovered,'message'),false);
  let output;
  assert.equal(await runV2Cli(['agent','intent-request','--request-id',key],{},
    {client,output:value=>{output=JSON.parse(value);},error:()=>{}}),0);
  assert.equal(output.id,original.id);
  const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{
    name:'agent_report_intent_request',arguments:{requestId:key,source}
  }},{client}));
  assert.equal(reply.result.structuredContent.id,original.id);
  assert.equal((await post({message,reportSource:source,approvalMode:'REQUEST_APPROVAL'})).id,original.id);
  await assert.rejects(post({message,reportSource:{...source,batchId:f.batches[0].id},approvalMode:'REQUEST_APPROVAL'}),e=>e.status===409);
  await assert.rejects(readReportIntent(client,{requestId:key,source:{...source,batchId:f.batches[0].id}}));
  const account=app.auth.bootstrapAdmin({email:'fixture@example.invalid',displayName:'虚构管理员',password:'FictionalAdmin#1207'});
  const session=app.auth.login({email:account.email,password:'FictionalAdmin#1207'});
  const as=cookie=>new V2Client({baseUrl,fetchImpl:(url,init)=>fetch(url,{...init,headers:{...init.headers,cookie:'shuduo_session='+cookie}})});
  for(const token of [session.rawToken,'expired']){
    assert.equal((await as(token).request('/agent/intents')).some(item=>item.id===original.id),false);
    await assert.rejects(as(token).request('/agent/intents/'+original.id+'/graph'),e=>e.status===403);
    await assert.rejects(readReportIntent(as(token),{requestId:key}),e=>e.status===403||e.status===404);
  }
  assert.equal(calls,1);
  assert.equal(store.list('report_agent_plan',PROJECT).length,0);
});
