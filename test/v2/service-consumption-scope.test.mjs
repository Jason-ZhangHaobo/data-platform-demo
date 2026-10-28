import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationStatusText, consumptionApplicationInput, consumptionDapiInput, consumptionPlanAvailable, consumptionServices, consumptionWindowOpen, consumptionXapiInput, serviceApplicationStatus } from '../../web/src/service-consumption-scope.ts';
const now=Date.parse('2026-10-28T04:00:00Z');
function fixture(){
 const plan={taskId:'task-fixture',packageDigest:'package-fixture',sourceReleaseRunId:'release-run-fixture',dapis:[{name:'合成持仓',slug:'fixture-holdings',fields:['client_id','holding_market_value','security_count'],timeoutMs:1500,rateLimitPerMinute:10},{name:'合成现金',slug:'fixture-cash',fields:['client_id','available_cash','total_assets'],timeoutMs:1500,rateLimitPerMinute:10}],xapi:{name:'合成资产',slug:'fixture-assets',timeoutMs:2500,rateLimitPerMinute:5,steps:[{alias:'positions',dapiSlug:'fixture-holdings'},{alias:'cash',dapiSlug:'fixture-cash'}]},applicationName:'合成应用'};
 const scope={pilotId:'pilot-fixture',taskId:plan.taskId,plan,startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
 const dapis=plan.dapis.map((d,i)=>{const v={id:`version-${i}`,fields:[...d.fields],sourceReleaseRunId:plan.sourceReleaseRunId,sourcePackageDigest:plan.packageDigest,timeoutMs:d.timeoutMs,rateLimitPerMinute:d.rateLimitPerMinute};return{id:`service-${i}`,name:d.name,slug:d.slug,serviceType:'DAPI',status:'PUBLISHED',pilotId:scope.pilotId,currentVersion:v,publishedVersion:v};});
 const xv={id:'version-x',timeoutMs:plan.xapi.timeoutMs,rateLimitPerMinute:plan.xapi.rateLimitPerMinute,steps:plan.xapi.steps.map((s,i)=>({alias:s.alias,dapiId:dapis[i].id,dapiVersionId:dapis[i].publishedVersion.id}))};
 const xapi={id:'service-x',name:plan.xapi.name,slug:plan.xapi.slug,serviceType:'XAPI',status:'PUBLISHED',pilotId:scope.pilotId,currentVersion:xv,publishedVersion:xv};
 return{scope,plan,dapis,xapi,services:[...dapis,xapi]};
}
test('consumption window requires a complete selected plan and fails closed at expiry',()=>{
 const {scope}=fixture();assert.equal(consumptionPlanAvailable(scope),true);assert.equal(consumptionWindowOpen(scope,now),true);
 for(const value of [undefined,{...scope,pilotId:undefined},{...scope,taskId:'other'},{...scope,plan:undefined},{...scope,startsAt:new Date(now+1).toISOString()},{...scope,expiresAt:new Date(now).toISOString()}])assert.equal(consumptionWindowOpen(value,now),false);
});
test('only pilot-tagged services matching every frozen definition are presented',()=>{
 const {scope,services}=fixture();assert.deepEqual(consumptionServices(services,scope).map(s=>s.id),['service-0','service-1','service-x']);
 for(const change of [s=>{s.pilotId='old-pilot';},s=>{s.currentVersion.fields=['client_id'];},s=>{s.currentVersion.sourceReleaseRunId='old-run';},s=>{s.currentVersion.sourcePackageDigest='old-package';},s=>{s.currentVersion.timeoutMs++;},s=>{s.currentVersion.rateLimitPerMinute++;},s=>{s.name='other';}]){
   const altered=structuredClone(services);change(altered[0]);assert.deepEqual(consumptionServices(altered,scope).map(s=>s.id),['service-1']);
 }
 const drifted=structuredClone(services);drifted[2].currentVersion.steps[0].dapiVersionId='old-version';assert.deepEqual(consumptionServices(drifted,scope).map(s=>s.id),['service-0','service-1']);
 const duplicate=[...services,{...services[0],id:'old-same-name',pilotId:'other'}];assert.equal(consumptionServices(duplicate,scope).length,3);
 assert.deepEqual(consumptionServices(services,{...scope,plan:undefined}),[]);assert.deepEqual(consumptionServices(services),services);
});
test('request builders preserve exact definitions and never follow unapproved child versions',()=>{
 const {scope,plan,services}=fixture();
 for(let i=0;i<2;i++)assert.deepEqual(consumptionDapiInput(scope,i),{...plan.dapis[i],sourceReleaseRunId:plan.sourceReleaseRunId});
 assert.throws(()=>consumptionDapiInput(scope,2));
 const composition=consumptionXapiInput(scope,services);assert.deepEqual(composition.steps,[{alias:'positions',dapiId:'service-0',dapiVersionId:'version-0'},{alias:'cash',dapiId:'service-1',dapiVersionId:'version-1'}]);
 const missing=structuredClone(services);missing[1].status='DRAFT';assert.throws(()=>consumptionXapiInput(scope,missing));
 assert.equal(composition.timeoutMs,plan.xapi.timeoutMs);assert.equal(composition.rateLimitPerMinute,plan.xapi.rateLimitPerMinute);
 const immutable=consumptionDapiInput(scope,0);immutable.fields.push('foreign');assert.equal(plan.dapis[0].fields.length,3);
});
test('the one application requires all three published services but grants only holdings and XAPI',()=>{
 const {scope,services}=fixture();assert.deepEqual(consumptionApplicationInput(scope,services),{name:'合成应用',serviceIds:['service-0','service-x']});
 assert.throws(()=>consumptionApplicationInput(scope,services.slice(0,2)));
 const draft=structuredClone(services);draft[2].status='DRAFT';assert.throws(()=>consumptionApplicationInput(scope,draft));
 assert(!consumptionApplicationInput(scope,services).serviceIds.includes('service-1'));
});
test('expired credentials preserve historical evidence wording without claiming current authority',()=>{
 assert.equal(serviceApplicationStatus({status:'ACTIVE',expiresAt:new Date(now).toISOString()},now),'EXPIRED');
 assert.equal(serviceApplicationStatus({status:'REVOKED',expiresAt:new Date(now).toISOString()},now),'REVOKED');
 assert.equal(applicationStatusText('EXPIRED',true),'应用已到期，历史记录保留');
 assert.equal(applicationStatusText('REVOKED',true),'应用已撤销，历史记录保留');
 assert.match(applicationStatusText('ACTIVE',true),/当前权限需重新核验/);assert.equal(applicationStatusText('UNKNOWN'),'应用状态未确认');
});
