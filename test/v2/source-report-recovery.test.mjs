import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{distributionPublicationFixture}from'./fixtures/distribution-publication.mjs';import{createV2Server,PROJECT}from'../../src/v2/server.mjs';import{generateReportPlan}from'../../src/v2/model.mjs';import{BudgetManager}from'../../src/v2/budget.mjs';
import{publishedReportPlanningContext,publishedReportPlanHash}from'../../src/v2/published-report-plan.mjs';import{resolvePublishedReportSource,publishedReportHash}from'../../src/v2/published-report-source.mjs';
const generated=()=>({plan:{kind:'PUBLISHED_REPORT',name:'合成分类持仓分析',metricIds:['asset_class_distribution','distribution_security_count','distribution_ratio']},model:'SYNTHETIC_REPORT_RECOVERY',mode:'TEST_DOUBLE',usage:{total_tokens:50}});
async function ready(t,options={}){const f=await distributionPublicationFixture(t,options),p=await f.packageSource('holdings-asset-class-t1','local-engineer'),{release}=await f.publish(p);await f.runNext(release.id);await f.runNext(release.id);const batch=f.store.list('release_run',PROJECT).find(r=>r.releaseId===release.id),source={kind:'AGENT',taskId:p.agent.id,releaseId:release.id,packageDigest:p.pkg.digest,revisionId:p.revision.id,runId:p.run.id,batchId:batch.id};return{...f,p,source};}
async function settled(call,id){for(let i=0;i<100;i++){const r=await call('/reports/agent/plans/'+id);if(!['QUEUED','RUNNING'].includes(r.body.status))return r.body;await new Promise(r=>setTimeout(r,5));}throw Error('synthetic source report did not settle');}
async function listener(t,f,planner){const app=createV2Server({store:f.store,reportStore:f.app.reportStore,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},reportPlanner:planner});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});const origin='http://127.0.0.1:'+app.server.address().port;return async(path,body)=>{const r=await fetch(origin+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};}

test('another process view retains unknown in-flight usage and resumes only the same never-invoked queued plan; late old queue cannot duplicate it',async t=>{
 let entered,release,oldCalls=0,newCalls=0;const inModel=new Promise(r=>{entered=r}),hold=new Promise(r=>{release=r});
 const f=await ready(t,{reportPlanner:async()=>{oldCalls++;entered();await hold;return generated();}}),firstKey=randomUUID(),first=await f.call('/reports/agent/plans',{message:'第一个合成报告规划',source:f.source},firstKey);await inModel;
 const queuedKey=randomUUID(),queued=await f.call('/reports/agent/plans',{message:'第二个合成报告规划',source:f.source},queuedKey);assert.equal(f.store.get('report_agent_plan',queued.body.id,PROJECT).providerPhase,'NOT_STARTED');
 const other=await listener(t,f,async input=>{newCalls++;assert(!JSON.stringify(input.publication).includes('CLIENT-001'));return generated();});
 const unknown=(await other('/reports/agent/requests/'+firstKey)).body;assert.equal(unknown.status,'INTERRUPTED');assert.equal(unknown.recovery.state,'MODEL_RESULT_UNKNOWN');assert.equal(unknown.usageEstimated,true);assert.equal(unknown.usageUnknown,true);assert(unknown.usage.total_tokens>0);
 assert.equal((await other('/reports/agent/plans/'+first.body.id+'/resume',{})).status,409);
 const waiting=(await other('/reports/agent/requests/'+queuedKey)).body;assert.equal(waiting.recovery.canResume,true);assert.equal(waiting.status,'INTERRUPTED');
 const outcomes=await Promise.all([other('/reports/agent/plans/'+queued.body.id+'/resume',{}),other('/reports/agent/plans/'+queued.body.id+'/resume',{})]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[202,409]);
 const done=await settled(other,queued.body.id);assert.equal(done.status,'SUCCEEDED');assert.equal(done.requestId,queuedKey);assert.equal(done.usageEstimated,false);assert.equal(done.usage.total_tokens,50);assert.equal(newCalls,1);
 f.store.update('report_agent_plan',queued.body.id,PROJECT,{providerPhase:'STARTED'});assert.equal((await other('/reports/agent/plans/'+queued.body.id+'/apply',{proposalHash:done.proposalHash})).status,409);assert.equal(f.store.list('report',PROJECT).length,0);f.store.update('report_agent_plan',queued.body.id,PROJECT,{providerPhase:'RECORDED'});
 await other('/reports/agent/plans/'+first.body.id+'/cancel',{});assert.equal((await other('/reports/agent/requests/'+firstKey)).body.recovery.state,'MODEL_RESULT_UNKNOWN');release();await new Promise(r=>setTimeout(r,15));assert.equal(oldCalls,1);assert.equal(newCalls,1);assert.equal(f.store.get('report_agent_plan',first.body.id,PROJECT).status,'CANCELLED');assert.equal(f.store.get('report_agent_plan',first.body.id,PROJECT).usage.total_tokens,50);assert.equal(f.store.get('report_agent_plan',queued.body.id,PROJECT).status,'SUCCEEDED');
});

test('provider-compatible adapter records measured usage when returned JSON is invalid',async t=>{
 let captured;const f=await ready(t,{reportPlanner:async input=>{const result=await generateReportPlan(input,{DASHSCOPE_API_KEY:'synthetic-not-a-provider-credential'},async(_url,options)=>{captured=JSON.parse(options.body);return{ok:true,json:async()=>({choices:[{message:{content:'not json'}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}});return result;}});
 const task=await f.call('/reports/agent/plans',{message:'生成资产类别占比报告',source:f.source}),done=await settled(f.call,task.body.id);assert.equal(done.status,'FAILED');assert.equal(done.providerPhase,'RECORDED');assert.equal(done.usage.total_tokens,30);assert.equal(done.usageEstimated,false);assert.equal(done.usageUnknown,false);assert(!JSON.stringify(captured).includes('CLIENT-001'));assert.equal(f.store.list('report',PROJECT).length,0);
});

test('timeout retains conservative reservation and budget replacement requires the exact active source report invocation',async t=>{
 let reservation,entered;const began=new Promise(r=>{entered=r}),f=await ready(t,{reportPlanningTimeoutMs:100,reportPlanner:async input=>{reservation=input.sourceReservation;entered();await new Promise(()=>{});}}),task=await f.call('/reports/agent/plans',{message:'合成超时报告规划',source:f.source});await began;
 const budget=new BudgetManager({store:f.store,project:PROJECT,env:{},now:Date.now});assert(budget.assertCanStartReportModel(reservation));assert.throws(()=>budget.assertCanStartReportModel({...reservation,invocationId:randomUUID()}));
 const done=await settled(f.call,task.body.id);assert.equal(done.status,'FAILED');assert.equal(done.providerPhase,'STARTED');assert.equal(done.recovery.state,'MODEL_RESULT_UNKNOWN');assert.equal(done.usageEstimated,true);assert(done.usage.total_tokens>0);assert.throws(()=>budget.assertCanStartReportModel(reservation));
 assert.equal((await f.call('/reports/agent/plans/'+task.body.id+'/resume',{})).status,409);
});

test('source change after the provider response retains usage but cannot apply the stale proposal',async t=>{
 let f;f=await ready(t,{reportPlanner:async()=>{const a=f.store.get('agent',f.p.agent.id,PROJECT),r=structuredClone(a.requirements);r.interpretation.summary+=' changed';f.store.update('agent',a.id,PROJECT,{requirements:r});return generated();}});
 const created=await f.call('/reports/agent/plans',{message:'合成来源变化检查',source:f.source}),done=await settled(f.call,created.body.id);assert.equal(done.status,'FAILED');assert.equal(done.providerPhase,'RECORDED');assert.equal(done.usage.total_tokens,50);assert.equal(done.usageEstimated,false);assert.equal(done.proposal,undefined);assert.equal(f.store.list('report',PROJECT).length,0);
});

test('the default provider adapter passes the exact report reservation gate and sees only governed distribution metadata',async t=>{
 const original=globalThis.fetch;let providerCalls=0,gateCalls=0;
 const gate=BudgetManager.prototype.assertCanStartReportModel;t.mock.method(BudgetManager.prototype,'assertCanStartReportModel',function(input){gateCalls++;return gate.call(this,input)});
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).startsWith('http://127.0.0.1:'))return original(url,options);providerCalls++;const prompt=JSON.parse(options.body),content=JSON.parse(prompt.messages[1].content);assert.equal(content.publishedSource.fields.length,6);assert(!JSON.stringify(prompt).includes('CLIENT-001'));assert(!JSON.stringify(prompt).includes('expected'));return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...generated().plan,explanation:'synthetic provider response'})}}],usage:{total_tokens:35}})};});
 const f=await ready(t,{env:{DASHSCOPE_API_KEY:'synthetic-not-a-provider-credential'}}),created=await f.call('/reports/agent/plans',{message:'合成生产适配层兼容检查',source:f.source}),done=await settled(f.call,created.body.id);assert.equal(done.status,'SUCCEEDED');assert.equal(providerCalls,1);assert.equal(gateCalls,1);assert.equal(done.providerPhase,'RECORDED');assert.equal(done.usage.total_tokens,35);assert.equal(done.usageEstimated,false);assert.equal(f.calls(),2);
});

test('source report usage does not understate provider input/output tokens when total is inconsistent',async()=>{
 const{sourceReportUsage}=await import('../../src/v2/source-report-execution.mjs');const result=sourceReportUsage({model:'synthetic',usage:{prompt_tokens:20,completion_tokens:10,total_tokens:5}},32000);assert.equal(result.usage.total_tokens,30);assert.equal(result.usageEstimated,false);
});

test('a NOT_STARTED label cannot erase an existing model invocation or usage reservation',async()=>{
 const{sourceReportProjection,sourceReportInitial}=await import('../../src/v2/source-report-execution.mjs'),bootId=randomUUID(),plan={...sourceReportInitial(bootId),status:'QUEUED',sourceBinding:{},providerInvocationId:randomUUID(),usageEstimated:true};const view=sourceReportProjection(plan,{bootId:randomUUID(),active:false});assert.equal(view.recovery.state,'MODEL_RESULT_UNKNOWN');assert.equal(view.recovery.canResume,false);assert.equal(view.usageUnknown,true);
});

test('malformed provider content retains the decoded response usage and never exposes response text',async()=>{
 for(const content of [null,{},'null','[]'])await assert.rejects(generateReportPlan({message:'合成报表需求',publication:{}},{DASHSCOPE_API_KEY:'synthetic-not-a-provider-credential'},async()=>({ok:true,json:async()=>({choices:[{message:{content}}],usage:{total_tokens:23}})})),e=>e.modelResultRecorded===true&&e.usage.total_tokens===23&&e.message==='模型未返回可解析的报表方案');
});

test('a late failure from the previous execution owner cannot overwrite a plan acquired by another process',async t=>{
 let calls=0;const f=await ready(t,{reportPlanner:async()=>{calls++;return generated();}}),original=f.app.budget.assertCanStartModel.bind(f.app.budget),newOwner=randomUUID();let moved=false;
 f.app.budget.assertCanStartModel=(...args)=>{const task=f.store.list('report_agent_plan',PROJECT).find(p=>p.status==='RUNNING'&&p.providerPhase==='NOT_STARTED');if(task&&!moved){moved=true;f.store.update('report_agent_plan',task.id,PROJECT,{executionBootId:newOwner,status:'QUEUED'});throw Error('synthetic stale owner failure');}return original(...args);};
 const created=await f.call('/reports/agent/plans',{message:'合成旧执行者迟到失败',source:f.source});await new Promise(r=>setTimeout(r,15));const current=f.store.get('report_agent_plan',created.body.id,PROJECT);assert.equal(moved,true);assert.equal(current.executionBootId,newOwner);assert.equal(current.status,'QUEUED');assert.equal(current.providerPhase,'NOT_STARTED');assert.equal(calls,0);
});
