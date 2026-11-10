import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{MetadataStore}from'../../src/v2/store.mjs';import{ReportDataStore}from'../../src/v2/reports.mjs';import{createV2Server,PROJECT}from'../../src/v2/server.mjs';import{V2Client}from'../../src/v2/client.mjs';import{seedLocalServiceSource}from'./fixtures/local-service-sources.mjs';
import{publicAgentToolCatalog}from'../../src/v2/agent-router.mjs';
import{generateReportPlan}from'../../src/v2/model.mjs';
async function fixture(t,planner){
 const store=new MetadataStore(':memory:'),data=new ReportDataStore(),f=seedLocalServiceSource({store,project:PROJECT});let calls=0,engine=0;
 const app=createV2Server({store,reportStore:data,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},reportPlanner:async input=>{calls++;return planner(input);},runner:()=>{engine++;throw Error('NO_COMPUTE');}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));data.close();store.close();});
 const client=new V2Client({baseUrl:'http://127.0.0.1:'+app.server.address().port+'/api/v2'}),source={kind:'AGENT',taskId:f.agent.id,releaseId:f.release.id,packageDigest:f.bundle.digest,revisionId:f.revision.id,runId:f.codeRun.id,batchId:f.batches[0].id};
 return{...f,store,data,client,source,get calls(){return calls;},get engine(){return engine;}};
}
async function wait(f,id){for(let n=0;n<100;n++){const p=await f.client.request('/reports/agent/plans/'+id);if(!['QUEUED','RUNNING'].includes(p.status))return p;await new Promise(r=>setTimeout(r,10));}throw Error('PLAN_WAIT_EXPIRED');}
const generated=()=>({plan:{kind:'PUBLISHED_REPORT',name:'虚构持仓与现金报告',metricIds:['holding_value','available_cash']},explanation:'只选择已登记的持仓与现金指标',model:'SYNTHETIC_REPORT_PLANNER',mode:'TEST_DOUBLE',usage:{total_tokens:50}});
test('source-bound planning sees metadata only, review applies selected metrics once, and legacy list stays separate',async t=>{
 let input;const f=await fixture(t,async v=>{input=v;return generated();}),key=randomUUID(),body={message:'生成持仓市值和现金分析报告',source:f.source};
 const first=await f.client.request('/reports/agent/plans',{method:'POST',body,idempotencyKey:key}),p=await wait(f,first.id);assert.equal(p.status,'SUCCEEDED');assert.equal(f.calls,1);
 assert.equal(input.publication.source.batchId,f.source.batchId);assert(!JSON.stringify(input).includes('CLIENT-001'));assert.equal(input.publication.rows,undefined);assert.equal(f.store.list('report',PROJECT).length,0);
 assert.equal((await f.client.request('/reports/agent/plans')).length,0);assert.equal((await f.client.request('/reports/agent/plans?source_batch_id='+f.source.batchId)).length,1);
 assert.equal((await f.client.request('/reports/agent/requests/'+key)).id,p.id);assert.equal((await f.client.request('/reports/agent/plans',{method:'POST',body,idempotencyKey:key})).id,p.id);assert.equal(f.calls,1);
 await assert.rejects(f.client.request('/reports/agent/plans',{method:'POST',body:{...body,message:'修改了原请求目标'},idempotencyKey:key}),e=>e.status===409);
 await assert.rejects(f.client.request(`/reports/agent/plans/${p.id}/apply`,{method:'POST',body:{proposalHash:'a'.repeat(64)}}),e=>e.status===409);
 const created=await f.client.request(`/reports/agent/plans/${p.id}/apply`,{method:'POST',body:{proposalHash:p.proposalHash}});assert.equal(created.status,'SUCCEEDED');assert.equal(created.widgetCount,2);assert.deepEqual([...created.metricIds].sort(),['available_cash','holding_value']);
 assert.equal((await f.client.request(`/reports/agent/plans/${p.id}/apply`,{method:'POST',body:{proposalHash:p.proposalHash}})).reportRunId,created.reportRunId);assert.equal(f.store.list('report_run',PROJECT).length,1);assert.equal(f.calls,1);assert.equal(f.engine,0);
 await assert.rejects(f.client.request(`/reports/agent/plans/${p.id}/cancel`,{method:'POST',body:{}}),e=>e.status===409);assert.equal((await f.client.request('/reports/agent/plans/'+p.id)).status,'APPLIED');
});
test('provider adapter prompts for exact metadata and clarification without customer rows',async()=>{
 let prompt;
 const publication={source:{kind:'MANUAL',batchId:randomUUID()},context:{definition:'股票持仓加现金，非客户全资产'},fields:[{name:'available_cash',type:'DECIMAL'}],rowCount:2,availableWidgets:[{id:'available_cash',title:'可用现金'}],missingDimensions:['缺少行业字段']};
 const result=await generateReportPlan({message:'请生成行业分布',publication},{DASHSCOPE_API_KEY:'synthetic-not-a-provider-credential'},async(url,options)=>{prompt=JSON.parse(options.body);return{ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({kind:'CLARIFICATION_REQUIRED',question:'当前没有行业字段，是否先分析现金？',explanation:'字段缺失'})}}],usage:{total_tokens:10}})};});
 assert.equal(result.plan.kind,'CLARIFICATION_REQUIRED');assert.equal(result.explanation,'字段缺失');const content=JSON.parse(prompt.messages[1].content);assert.deepEqual(content.publishedSource,publication);assert.match(content.contract.clarification,/不得用其他指标冒充/);assert(!JSON.stringify(prompt).includes('CLIENT-001'));
});
test('invalid proposed fields and changed source cannot reach report creation',async t=>{
 const f=await fixture(t,async()=>({plan:{kind:'PUBLISHED_REPORT',name:'虚构行业报告',metricIds:['industry_distribution']},model:'SYNTHETIC_REPORT_PLANNER',mode:'TEST_DOUBLE'}));
 const created=await f.client.request('/reports/agent/plans',{method:'POST',body:{message:'生成行业分布报告',source:f.source}}),p=await wait(f,created.id);assert.equal(p.status,'FAILED');assert.match(p.error,/未登记指标|此发布结果不支持/);assert.equal(f.store.list('report',PROJECT).length,0);
 f.store.update('report_agent_plan',p.id,PROJECT,{submittedBy:'other-owner'});await assert.rejects(f.client.request('/reports/agent/plans/'+p.id),e=>e.status===404);
});
test('missing industry requests ask for clarification and never create reports',async t=>{
 const f=await fixture(t,async()=>({plan:{kind:'CLARIFICATION_REQUIRED',question:'当前结果没有行业字段，是否先生成持仓与现金报告？'},model:'SYNTHETIC_REPORT_PLANNER',mode:'TEST_DOUBLE'}));
 const first=await f.client.request('/reports/agent/plans',{method:'POST',body:{message:'生成证券行业分布',source:f.source}}),p=await wait(f,first.id);assert.equal(p.status,'NEEDS_CLARIFICATION');
 await assert.rejects(f.client.request(`/reports/agent/plans/${p.id}/apply`,{method:'POST',body:{proposalHash:p.proposalHash}}),e=>e.status===409);assert.equal(f.store.list('report',PROJECT).length,0);
 assert.equal((await f.client.request(`/reports/agent/plans/${p.id}/cancel`,{method:'POST',body:{}})).status,'CANCELLED');
});
test('existing internal Agent tool invocation binds its saved publication context and reuses the child',async t=>{
 const f=await fixture(t,async()=>generated()),message='生成持仓市值和现金分析报告',catalog=publicAgentToolCatalog();
 const intent=f.store.create('agent_intent',PROJECT,{status:'SUCCEEDED',submittedBy:'local-engineer',approvalMode:'REQUEST_APPROVAL',reportSource:f.source,mode:'SYNTHETIC_TEST_INTENT',route:{steps:[{destinationId:'reports',objective:message}]}});
 const{createHash}=await import('node:crypto');const approval=f.store.create('agent_intent_approval',PROJECT,{intentId:intent.id,destinationId:'reports',objectiveHash:createHash('sha256').update(message).digest('hex'),status:'APPROVED',risk:'LOW',submittedBy:'local-engineer'});
 const body={catalogVersion:catalog.version,contractDigest:catalog.contractDigest,approvalId:approval.id,input:{message,source:f.source}};
 const invoked=await f.client.request(`/agent/intents/${intent.id}/tools/reports/invoke`,{method:'POST',body});const plan=await wait(f,invoked.specialist.id);assert.equal(plan.planMode,'PUBLISHED_SOURCE_REPORT_V1');
 assert.equal((await f.client.request(`/agent/intents/${intent.id}/tools/reports/invoke`,{method:'POST',body})).specialist.id,plan.id);assert.equal(f.calls,1);
 await assert.rejects(f.client.request(`/agent/intents/${intent.id}/tools/reports/invoke`,{method:'POST',body:{...body,input:{message,source:{...f.source,batchId:randomUUID()}}}}),e=>e.code==='AGENT_REPORT_SOURCE_MISMATCH');
});
