import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';import {createV2Server,PROJECT} from '../../src/v2/server.mjs';import {createPasswordHash} from '../../src/v2/auth.mjs';
import {referenceSql,getContext} from '../../src/v2/context.mjs';import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
import {readSqlClarification,createSqlClarification,sqlClarificationBody,verifiedClarificationReceipt} from '../../src/v2/sql-clarification-client.mjs';
import {verifiedSqlRequirementReport} from '../../src/v2/sql-requirements.mjs';import {createAgentSubmission} from '../../web/src/agent-submission.ts';
import {runV2Cli} from '../../bin/shuduo.mjs';import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {generateSql} from '../../src/v2/model.mjs';import {liveEvidenceProvenance} from '../../src/v2/live-lifecycle-provenance.mjs';
import {createDeliveryPackage,validateDeliveryPackage} from '../../src/v2/delivery.mjs';

// Only synthetic model/Worker callbacks; actual loopback HTTP and SQLite.
async function setup(t,{local=false}={}){
 const root=mkdtempSync(join(tmpdir(),'shuduo-clarification-api-')),store=new MetadataStore(join(root,'metadata.sqlite'));let models=0,jobs=0,posts=0;
 const receipts=new Map(),result=input=>({status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,rows:input.context.expected,
  validation:{passed:true,regressions:input.validationContexts.map(c=>({contextId:c.id,passed:true}))}});
 const runner=async input=>{jobs++;return result(input);};runner.descriptor={engine:'Apache Spark',isolation:'REMOTE_FUNCTION',publicWriteEnabled:true,healthVerified:true};
 runner.durable={prepare:(input,id)=>({job:{jobId:id},input}),submit:async p=>{jobs++;receipts.set(p.job.jobId,result(p.input));},read:async p=>receipts.get(p.job.jobId),cancel:async()=>{}};
 const app=createV2Server({store,runner,generator:async input=>{models++;return {sql:input.clarification?referenceSql:null,model:'qwen3.7-plus',usage:{total_tokens:20},
  ...syntheticSqlRequirement(input,{clarification:!input.clarification})};},env:{V2_LOCAL_DEVELOPMENT:local?'true':'false',V2_DURABLE_SQL_AGENT_ENABLED:local?'false':'true',V2_PUBLIC_ORIGIN:'https://fixture.invalid'}});
 app.server.on('request',r=>{if(r.method==='POST')posts++;});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.server.address().port}`,call=async(path,body,session={},key=randomUUID())=>{
  const r=await fetch(origin+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':key,...(local?{}:{origin:'https://fixture.invalid'}),...session},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};
 };
 const sessions={};if(!local)for(const [name,role] of [['owner','ENGINEER'],['other','ADMIN'],['viewer','VIEWER']]){
  store.create('auth_user',PROJECT,{email:name+'@example.invalid',displayName:name,status:'ACTIVE',passwordHash:createPasswordHash('SyntheticOnly!2026'),memberships:[{projectId:PROJECT,role}]});
  const logged=await call('/auth/login',{email:name+'@example.invalid',password:'SyntheticOnly!2026'});assert.equal(logged.status,200);sessions[name]={cookie:logged.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':logged.body.csrfToken};
 }
 const owner=local?{}:sessions.owner,client={request:async(path,options={})=>{const r=await call(path,options.method==='POST'?options.body:undefined,owner,options.idempotencyKey);if(r.status>=400)throw Object.assign(Error(r.body.message),{status:r.status,code:r.body.code});return r.body;}};
 async function advance(id){const current=await client.request('/agent/tasks/'+id);return client.request('/agent/tasks/'+id+'/advance',{method:'POST',body:{expectedVersion:current.version}});}
 async function parent(){let p=await client.request('/agent/tasks',{method:'POST',body:{message:'原需求：分析虚构证券客户资产，并解释行业分布边界',contextId:'holdings-t1',sql:referenceSql},idempotencyKey:randomUUID()});
  if(local){for(let n=0;n<50;n++){p=await client.request('/agent/tasks/'+p.id);if(p.status==='FAILED')break;await new Promise(r=>setTimeout(r,5));}}
  else p=await advance(p.id);assert.equal(p.stage,'REQUIREMENT_CLARIFICATION_REQUIRED');assert.equal(typeof p.initialSql,'string');return p;}
 return {store,call,client,parent,advance,sessions,counts:()=>({models,jobs,posts})};
}
test('owner-only source reads and CSRF protect clarification; child preserves original question/input/usage without approving anything',async t=>{
 const f=await setup(t),p=await f.parent(),before=structuredClone(f.store.get('agent',p.id,PROJECT)),source=await readSqlClarification(f.client,{taskId:p.id});
 assert.equal((await f.call(`/agent/tasks/${p.id}/clarification-source`)).status,401);
 assert.equal((await f.call(`/agent/tasks/${p.id}/clarification-source`,undefined,f.sessions.other)).status,403);
 const body=sqlClarificationBody(source,'先计算现有五项指标');
 assert.equal((await f.call('/agent/tasks',body,{cookie:f.sessions.owner.cookie})).status,403);
 assert.equal((await f.call('/agent/tasks',body,f.sessions.other)).status,403);
 const requestId=randomUUID(),child=await createSqlClarification(f.client,{taskId:p.id,answer:body.message,evidenceDigest:source.binding.evidenceDigest,requestId,confirm:true});
 assert.equal((await createSqlClarification(f.client,{taskId:p.id,answer:body.message,evidenceDigest:source.binding.evidenceDigest,requestId,confirm:true})).id,child.id);
 assert.equal(child.humanClarified,true);assert.equal(child.directAutonomousEligible,false);assert.equal(child.clarification.originalRequest,p.message);assert.equal(child.initialSql,source.sql);
 assert.deepEqual(f.counts().models,1);let current=await f.advance(child.id);assert.equal(current.stage,'READY_FOR_RUN');assert.equal(verifiedSqlRequirementReport(current.requirements,current),true);
 current=await f.advance(child.id);if(current.status!=='SUCCEEDED')current=await f.advance(child.id);assert.equal(current.status,'SUCCEEDED');assert.equal(f.counts().models,2);assert.equal(f.counts().jobs,1);
 assert.deepEqual(f.store.get('agent',p.id,PROJECT),before);assert.equal(f.store.list('release_approval',PROJECT).length,0);assert.equal(liveEvidenceProvenance(current).nonNative,true);
 const bundle=createDeliveryPackage({agent:f.store.get('agent',current.id,PROJECT),run:f.store.get('run',current.runId,PROJECT),revision:f.store.get('revision',current.revisionId,PROJECT)});
 assert.equal(validateDeliveryPackage(bundle,bundle.digest).requirements.clarification.originalRequest,p.message);
 assert.equal(validateDeliveryPackage(bundle,bundle.digest).requirements.humanClarified,true);
});
test('ordinary HTTP saves original input and sends root request/question/answer in the existing single model step',async t=>{
 const f=await setup(t,{local:true}),p=await f.parent(),source=await readSqlClarification(f.client,{taskId:p.id}),child=await createSqlClarification(f.client,{taskId:p.id,evidenceDigest:source.binding.evidenceDigest,answer:'先计算当前五项',requestId:randomUUID(),confirm:true});
 let saved;for(let n=0;n<50;n++){saved=await f.client.request('/agent/tasks/'+child.id);if(saved.status==='SUCCEEDED')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(saved.status,'SUCCEEDED');assert.equal(saved.attempts.length,1);assert.equal(saved.requirements.clarification.originalRequest,p.message);
 assert.equal(saved.clarification.turns[0].question,source.question);assert.equal(saved.usedTokens,20);assert.equal(f.store.get('agent',p.id,PROJECT).usedTokens,20);assert.equal(f.counts().models,2);assert.equal(f.counts().jobs,1);
});
test('lost POST replies recover the original child by request key without changing parent or creating another task',async t=>{
 const f=await setup(t),p=await f.parent(),source=await readSqlClarification(f.client,{taskId:p.id}),key=randomUUID(),body=sqlClarificationBody(source,'当前五项即可');let pending,lose=true;
 const api=async(path,value,options)=>{const result=await f.client.request(path,value===undefined?{}:{method:'POST',body:value,idempotencyKey:options?.idempotencyKey});if(value&&lose){lose=false;throw Error('synthetic lost ACK');}return result;};
 const controller=createAgentSubmission({api,onPending:k=>{pending=k;},makeKey:()=>key});await assert.rejects(controller.submit(body));assert.equal(pending,key);
 const before=f.counts().posts,recovered=await controller.recover();assert.equal(await verifiedClarificationReceipt(recovered,body),true);assert.equal(f.counts().posts,before);
 controller.acknowledge(key);assert.equal(pending,undefined);assert.equal(f.store.list('agent',PROJECT).length,2);assert.equal(f.counts().models,1);assert.equal(f.counts().jobs,0);
});
test('CLI and MCP use the same read/reply API, explicit digest and request identity; rejected confirmation performs no writes',async t=>{
 const f=await setup(t),p=await f.parent(),source=await readSqlClarification(f.client,{taskId:p.id}),output=[],errors=[];
 assert.equal(await runV2Cli(['agent','clarification','--id',p.id],{},{client:f.client,output:v=>output.push(JSON.parse(v)),error:v=>errors.push(v)}),0);assert.equal(output.at(-1).binding.evidenceDigest,source.binding.evidenceDigest);
 const key=randomUUID(),args=['agent','clarify','--id',p.id,'--answer','当前五项','--evidence-digest',source.binding.evidenceDigest,'--request-id',key,'--confirm'];
 assert.equal(await runV2Cli(args,{},{client:f.client,output:v=>output.push(JSON.parse(v)),error:v=>errors.push(v)}),0);const child=output.at(-1);
 const response=JSON.parse(await handleV2Mcp({id:1,method:'tools/call',params:{name:'agent_clarification_reply',arguments:{taskId:p.id,evidenceDigest:source.binding.evidenceDigest,answer:'当前五项',requestId:key,confirm:true}}},{client:f.client}));
 assert.ok(response.result,JSON.stringify(response.error));assert.equal(response.result.structuredContent.id,child.id);const count=f.counts().posts;
 await assert.rejects(createSqlClarification(f.client,{taskId:p.id,evidenceDigest:source.binding.evidenceDigest,answer:'答复',requestId:randomUUID(),confirm:false}));assert.equal(f.counts().posts,count);
 assert.equal(f.counts().models,1);assert.equal(f.counts().jobs,0);
});
test('production SQL prompt includes business dialogue without internal task IDs, source digests or usage',async t=>{
 const f=await setup(t),p=await f.parent(),source=await readSqlClarification(f.client,{taskId:p.id}),child=await createSqlClarification(f.client,{taskId:p.id,evidenceDigest:source.binding.evidenceDigest,answer:'当前五项即可',requestId:randomUUID(),confirm:true});
 let prompt,calls=0;const input={message:child.message,context:getContext(child.contextId),currentSql:child.initialSql,clarification:child.clarification};
 await generateSql(input,{DASHSCOPE_API_KEY:'SYNTHETIC_ONLY'},async(_url,options)=>{calls++;prompt=JSON.parse(JSON.parse(options.body).messages[1].content);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:referenceSql,requirement:syntheticSqlRequirement(input).requirement})}}],usage:{total_tokens:20}}));});
 assert.equal(calls,1);assert.equal(prompt.clarification.originalRequest,p.message);assert.equal(prompt.clarification.turns[0].answer,child.message);
 assert.equal(prompt.requirementBasis.clarificationDigest,child.clarification.digest);assert.equal(JSON.stringify(prompt).includes(p.id),false);assert.equal(JSON.stringify(prompt).includes(source.binding.evidenceDigest),false);
 assert.equal(JSON.stringify(prompt).includes('usedTokens'),false);assert.equal(JSON.stringify(prompt).includes('"expected"'),false);
});
