import test from 'node:test';
import assert from 'node:assert/strict';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';

test('a local UI configured with a remote Worker cannot enqueue an unadapted distribution',async t=>{
 const store=new MetadataStore(':memory:');let calls=0;
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{calls++;},runnerDescriptor:{isolation:'REMOTE_FUNCTION',publicWriteEnabled:false}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 assert.equal((await(await fetch(base+'/contexts')).json()).length,10);
 const response=await fetch(base+'/revisions',{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench'},body:JSON.stringify({contextId:'holdings-industry-t1',sql:referenceSqlForContext('holdings-industry-t1')})});
 assert.equal(response.status,422);assert.equal(calls,0);assert.equal(store.list('revision',PROJECT).length,0);assert.equal(store.list('run',PROJECT).length,0);
});

test('public context catalog retains the original ten contexts without exposing unadapted distributions',async t=>{
 const store=new MetadataStore(':memory:');
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'false',V2_PUBLIC_ORIGIN:'https://example.invalid'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();});
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/contexts`);
 assert.equal(response.status,200);const contexts=await response.json();assert.equal(contexts.length,10);
 assert(contexts.every(c=>c.outputContractId===undefined&&!Object.hasOwn(c,'expected')));
 assert.equal(store.list('run',PROJECT).length,0);
});

test('classic SQL offers distribution contexts, persists one manual version/run, rejects Agent and Python before invocation',async t=>{
 const store=new MetadataStore(':memory:');let executions=0,models=0;
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:async()=>{models++;throw Error('must not call');},runner:async({context,validationContexts})=>{
  executions++;assert.equal(context.outputContractId,validationFamilyForContext(context.id).id);
  assert.equal(new Set(validationContexts.map(c=>c.id)).size,5);
  return {status:'SUCCEEDED',engine:'SYNTHETIC_NO_SPARK',rows:context.expected,columns:Object.keys(context.expected[0]).map(name=>({name,type:'synthetic'})),validation:{passed:true,assertions:[],issues:[],regressions:validationContexts.map(c=>({contextId:c.id,passed:true,name:c.name}))}};
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();});
 const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 const post=(path,body,key)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key},body:JSON.stringify(body)});
 const contexts=await(await fetch(base+'/contexts')).json();assert.equal(contexts.length,20);assert(contexts.every(c=>!Object.hasOwn(c,'expected')));
 const id='holdings-industry-t1',sql=referenceSqlForContext(id);
 const rejected=await post('/agent/tasks',{contextId:id,sql,message:'生成行业分布'},'not-agent');assert.equal(rejected.status,422);assert.equal((await rejected.json()).code,'OUTPUT_CONTRACT_CLASSIC_ONLY');
 assert.equal((await post('/python/revisions',{contextId:id,code:'print("not supported")'},'not-python')).status,422);
 const rev=await(await post('/revisions',{contextId:id,sql},'save-distribution')).json();assert(rev.id);
 assert.equal((await(await post('/revisions',{contextId:id,sql},'save-distribution')).json()).id,rev.id);
 const run=await(await post('/runs',{revisionId:rev.id},'run-distribution')).json();
 let completed;for(let i=0;i<50;i++){completed=await(await fetch(base+'/runs/'+run.id)).json();if(completed.status==='SUCCEEDED')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(completed.status,'SUCCEEDED');assert.equal(completed.rows.length,3);assert.equal(completed.validationContractId,getContext(id).outputContractId);
 assert.equal((await(await post('/runs',{revisionId:rev.id},'run-distribution')).json()).id,run.id);
 assert.equal(store.list('revision',PROJECT).length,1);assert.equal(store.list('agent',PROJECT).length,0);assert.equal(models,0);assert.equal(executions,1);
});
