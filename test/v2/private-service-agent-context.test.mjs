import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privateServiceContextFixture} from './fixtures/private-service-context.mjs';
import {serviceAgentContextPath} from '../../src/v2/service-plan-request.mjs';
import {checkedServiceAgentContext,readServiceAgentContext} from '../../src/v2/service-agent-context-client.mjs';
import {privateServiceRoute} from '../../src/v2/private-service-routes.mjs';
import {validatePrivateApplicationRequest} from '../../src/v2/private-application.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

test('private planning context uses authoritative package meaning and one batch, with no mutation or model call',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source(),second=f.source('cash-change'),h=await f.create(value,'context-holdings',['client_id','holding_market_value','security_count']),c=await f.create(value,'context-cash');
 await f.create(second,'context-other-source');f.store.update('agent',f.agent.id,f.project,{contextId:'cash-change'});
 const before=JSON.stringify(f.store.list('data_service',f.project)),counts=f.counts(),path=serviceAgentContextPath(value.sourceBinding);
 const result=await f.call(path,undefined,f.a);assert.equal(result.status,200,JSON.stringify(result.body));const receipt=checkedServiceAgentContext(result.body,value.sourceBinding);
 assert.equal(receipt.sourceContext.id,'stock-cash-t1','mutable task context must not replace approved manifest context');
 assert.match(receipt.sourceContext.metricLabels.total_assets,/非客户全资产/);assert.equal(receipt.sourceKind,'AGENT');assert.equal(receipt.releaseRuns.length,1);
 assert.deepEqual(receipt.services.map(item=>item.id).sort(),[h.id,c.id].sort());assert.equal(receipt.resourceVersions.find(ref=>ref.serviceId===h.id).versionId,h.publishedVersionId);
 const text=JSON.stringify(receipt);for(const secret of ['"rows"','CLIENT-001','queryTemplate','"files"','"sql"','tokenHash','password','submittedBy'])assert.equal(text.includes(secret),false,secret);
 assert.deepEqual(f.counts(),counts);assert.equal(JSON.stringify(f.store.list('data_service',f.project)),before);assert.equal(f.store.list('service_agent_plan',f.project).length,0);
 assert.equal(receipt.planning.enabled,false);assert.equal(receipt.agentIndependentE2E,false);assert.equal(receipt.publicDeployed,false);
 assert.equal((await f.call('/status',undefined,f.a)).body.dataServices.sourceBoundAgentContextEnabled,true);
 assert.notEqual((await f.call('/status',undefined,f.a)).body.dataServices.sourceBoundAgentPlansEnabled,true);
});

test('private context follows ownership including manual provenance and refuses source drift without another-source fallback',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source('stock-cash-t1',true),path=serviceAgentContextPath(value.sourceBinding);
 await f.create(value,'context-manual');assert.equal((await f.call(path)).status,401);
 assert.equal((await f.call(path,undefined,f.b)).status,403,'another ADMIN cannot inherit manual source');
 const own=await f.call(path,undefined,f.a);assert.equal(own.status,200);assert.equal(own.body.sourceAttribution,'ENGINEER_ASSISTED');
 assert.equal(checkedServiceAgentContext(own.body,value.sourceBinding).sourceKind,'MANUAL');
 for(const binding of [{...value.sourceBinding,packageDigest:'f'.repeat(64)},{...value.sourceBinding,taskId:randomUUID()},{...value.sourceBinding,releaseId:randomUUID()},{...value.sourceBinding,sourceReleaseRunId:value.sourceRun.id}])assert.ok([403,409].includes((await f.call(serviceAgentContextPath(binding),undefined,f.a)).status));
 f.store.update('release',value.release.id,f.project,{health:'NEEDS_ATTENTION'});assert.equal((await f.call(path,undefined,f.a)).status,409);
 f.store.update('release',value.release.id,f.project,{health:'HEALTHY'});assert.equal((await f.call(path,undefined,f.a)).status,200);assert.equal(f.counts().models,0);
});

test('only published, unchanged and intact candidate versions are included; reads do not rematerialize damaged snapshots',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source(),d=await f.create(value,'context-version'),path=serviceAgentContextPath(value.sourceBinding);
 const old=(await f.call(path,undefined,f.a)).body;const next=await f.call(`/data-services/dapis/${d.id}/versions`,{sourceReleaseRunId:value.run.id,fields:['client_id','holding_market_value']},f.a,'next-context-version');assert.equal(next.status,201);
 assert.equal((await f.call(path,undefined,f.a)).body.resourceVersions[0].versionId,d.publishedVersionId,'unpublished draft does not move frozen published version');
 await f.call(`/data-services/dapis/${d.id}/test`,{},f.a);assert.equal((await f.call(`/data-services/dapis/${d.id}/publish`,{configHash:next.body.configHash},f.a)).status,200);
 assert.equal((await f.call(path,undefined,f.a)).body.resourceVersions[0].versionId,next.body.id);assert.equal(old.resourceVersions[0].versionId,d.publishedVersionId);
 const version=f.store.get('data_service_version',next.body.id,f.project);f.app.businessStore.db.prepare('UPDATE customer_assets SET total_assets=? WHERE snapshot_id=?').run('9999.00',version.snapshotId);
 const before=f.counts();const bad=(await f.call(path,undefined,f.a)).body;assert.equal(bad.services.length,0);assert.equal(bad.unavailableServiceCount,1);assert.deepEqual(f.counts(),before);
 assert.equal(f.app.businessStore.snapshotEvidence(version.snapshotId).integrityVerified,false,'context read must not repair/rematerialize output');
});

test('shared private allowlist admits only an exact read context and never planner writes or bearer/actor forwarding',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source(),path='/api/v2'+serviceAgentContextPath(value.sourceBinding),input={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path,headers:{cookie:f.a.cookie}};
 assert.equal(privateServiceRoute('GET',path),true);assert.equal(validatePrivateApplicationRequest(input,{allowDataServices:true}).path,path);
 for(const suffix of ['', '&actorId=other','&package_digest='+value.bundle.digest,'&sql=SELECT%201']){
  const candidate=suffix?path+suffix:'/api/v2/data-services/agent/context';assert.equal(privateServiceRoute('GET',candidate),false);
 }
 for(const method of ['POST','PUT','DELETE'])assert.equal(privateServiceRoute(method,path),false);
 assert.throws(()=>validatePrivateApplicationRequest({...input,headers:{authorization:'Bearer synthetic'}},{allowDataServices:true}));
 assert.throws(()=>validatePrivateApplicationRequest(input));
 for(const endpoint of ['/data-services/agent/plans','/data-services/agent/plans/'+randomUUID()+'/apply'])assert.equal((await f.call(endpoint,{},f.a)).status,404);
 assert.equal((await f.call(serviceAgentContextPath(value.sourceBinding),{},f.a)).status,404);assert.equal(f.counts().models,0);
});

test('CLI and MCP read the same private context, validate fixed references, and reject extra input before network',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source(),d=await f.create(value,'context-tools'),seen=[];
 const client=new V2Client({baseUrl:f.base+'/api/v2',fetchImpl:async(url,options)=>{seen.push({path:new URL(url).pathname,method:options.method});return fetch(url,{...options,headers:{...options.headers,...f.a}});}});
 const flags=['--task-id',f.agent.id,'--package-digest',value.bundle.digest,'--release-id',value.release.id,'--source-run-id',value.run.id];let output;
 assert.equal(await runV2Cli(['services','plan-context',...flags],{}, {client,output:value=>{output=JSON.parse(value);},error:()=>{}}),0);assert.equal(output.resourceVersions[0].versionId,d.publishedVersionId);
 const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'service_agent_context',arguments:{sourceBinding:value.sourceBinding}}},{client}));
 assert.equal(mcp.error,undefined);assert.deepEqual(JSON.parse(mcp.result.content[0].text),output);assert.equal(seen.length,2);assert.ok(seen.every(call=>call.method==='GET'&&call.path.endsWith('/agent/context')));
 assert.equal(await runV2Cli(['services','plan-context',...flags,'--actor-id',f.other.id],{}, {client,output:()=>{},error:()=>{}}),1);
 await assert.rejects(()=>readServiceAgentContext(client,{sourceBinding:value.sourceBinding,confirm:true}));assert.equal(seen.length,2);
 for(const mutate of [data=>{data.planning.enabled=true;},data=>{data.resourceVersions[0].versionId=randomUUID();},data=>{data.sourceBinding.releaseId=randomUUID();},data=>{data.releaseRuns[0].rows=[];},data=>{data.services[0].publishedVersion.queryTemplate='SELECT 1';}]){
  const bad=structuredClone(output);mutate(bad);assert.throws(()=>checkedServiceAgentContext(bad,value.sourceBinding));
 }
 assert.equal(f.counts().models,0);assert.equal(f.counts().compute,0);
});

test('candidate metadata is deterministically bounded and cannot include another creator or a corrupt config',async t=>{
 const f=await privateServiceContextFixture(t),value=f.source(),d=await f.create(value,'context-bounded'),v=f.store.get('data_service_version',d.publishedVersionId,f.project);
 for(let n=0;n<101;n++){
  const service=f.store.create('data_service',f.project,{scope:'PRIVATE_CLOUD_TEST',createdBy:f.owner.id,name:`合成批量接口${n}`,slug:'context-bounded-'+n,serviceType:'DAPI',status:'PUBLISHED'});
  const {id,version,projectId,createdAt,updatedAt,...config}=v;
  const child=f.store.create('data_service_version',f.project,{...config,serviceId:service.id});
  f.store.update('data_service',service.id,f.project,{currentVersionId:child.id,publishedVersionId:child.id});
 }
 const path=serviceAgentContextPath(value.sourceBinding),first=(await f.call(path,undefined,f.a)).body,second=(await f.call(path,undefined,f.a)).body;
 assert.equal(first.services.length,100);assert.equal(first.resourcesTruncated,true);assert.deepEqual(second,first);
 const item=first.services[0];f.store.update('data_service',item.id,f.project,{createdBy:f.other.id});
 const next=(await f.call(path,undefined,f.a)).body;assert.equal(next.services.some(value=>value.id===item.id),false);
 const ref=next.resourceVersions[0];f.store.update('data_service_version',ref.versionId,f.project,{fields:['client_id']});
 const damaged=(await f.call(path,undefined,f.a)).body;assert.equal(damaged.services.some(value=>value.id===ref.serviceId),false);assert.equal(damaged.unavailableServiceCount,1);
 assert.equal(f.counts().models,0);
});
