import test from 'node:test';
import assert from 'node:assert/strict';
import {createServicePlanSubmission,sourcePlanReceiptValid,servicePlanMarker,servicePlanLocation,boundServicePlansPath,servicePlanRecoverySource} from '../../web/src/service-plan-source.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,source={taskId:id(1),packageDigest:'a'.repeat(64),releaseId:id(2),sourceReleaseRunId:id(3)};
const plan={id:id(4),requestId:id(5),sourceBinding:source,message:'只规划当前发布的持仓接口',status:'SUCCEEDED',scope:'LOCAL_TEST_ONLY',completionScope:'DATA_SERVICE_DESIGN',fullLifecycleE2E:false,agentIndependentE2E:false,publicDeployed:false,
 proposal:{serviceType:'DAPI',name:'持仓查询',slug:'scoped-holdings',sourceReleaseRunId:id(3),fields:['client_id','holding_market_value'],timeoutMs:1500,rateLimitPerMinute:60}};
test('planner recovery URLs retain only stable source metadata and never copy demand, SQL or credentials',()=>{
 const href='http://127.0.0.1:3100/v2/?module=agent-center&source_task='+id(1)+'&source_package='+source.packageDigest;
 const url=servicePlanLocation(href,{batchId:id(3),requestId:id(5)});assert.equal(url.searchParams.get('source_task'),id(1));assert.equal(url.searchParams.get('source_package'),source.packageDigest);
 assert.deepEqual(servicePlanMarker(url.toString()),{invalid:false,batchId:id(3),requestId:id(5),planId:undefined});
 assert.deepEqual(servicePlanRecoverySource(source,url.toString()),source);assert.equal(servicePlanRecoverySource(source,href),undefined);
 const completed=servicePlanLocation(url.toString(),{batchId:id(3),planId:id(4)});assert.equal(completed.searchParams.has('service_plan_request'),false);assert.equal(completed.searchParams.get('service_plan'),id(4));
 assert.equal(servicePlanMarker(completed+'&service_plan_request='+id(5)).invalid,true);assert.equal(servicePlanMarker(url+'&service_plan_request='+id(5)).invalid,true);
 assert.equal(new URL(boundServicePlansPath(source),'http://127.0.0.1').searchParams.get('source_release_run_id'),id(3));
 for(const key of ['message','sql','token','actorId'])assert.equal(url.searchParams.has(key),false);
});
test('only complete same-source plan receipts can clear an original pending identifier',()=>{
 assert.equal(sourcePlanReceiptValid(plan,source),true);
 for(const patch of [{id:'bad'},{scope:'PRIVATE_CLOUD_TEST'},{requestId:undefined},{sourceBinding:{...source,releaseId:id(8)}},{error:{}},{proposal:undefined},
  {proposal:{...plan.proposal,sourceReleaseRunId:id(9)}},{proposal:{...plan.proposal,name:{}}},{proposal:{...plan.proposal,fields:['client_id','unknown']}},
  {sourceCheck:'UNCONFIRMED'},{status:'APPLIED',serviceId:id(6),appliedVersionId:undefined}])assert.equal(sourcePlanReceiptValid({...plan,...patch},source),false);
 assert.equal(sourcePlanReceiptValid({...plan,sourceCheck:'UNAVAILABLE'},source),true,'owned historical metadata stays readable but is never an execution grant');
});
test('same submission controller freezes the original service body, queries before explicit retry and never invents a new request',async()=>{
 const calls=[],pending=[];let found=false;
 const api=async(path,body,options)=>{calls.push({path,body,options});if(body!==undefined)throw Error('synthetic reply lost');if(!found)throw Object.assign(Error('not found'),{status:404});return plan;};
 const controller=createServicePlanSubmission({api,makeKey:()=>id(5),onPending:key=>pending.push(key)}),body={message:plan.message,sourceBinding:{...source}};
 await assert.rejects(controller.submit(body));body.message='不应替换的编辑';await assert.rejects(controller.retry());
 assert.deepEqual(calls.map(call=>call.path),['/data-services/agent/plans','/data-services/agent/requests/'+id(5),'/data-services/agent/plans']);
 assert.equal(calls[2].body.message,plan.message);assert.equal(calls[2].options.idempotencyKey,id(5));assert.equal(controller.snapshot().key,id(5));
 found=true;const receipt=await controller.recover();assert.equal(sourcePlanReceiptValid(receipt,source),true);controller.acknowledge(id(5));assert.deepEqual(pending,[id(5),undefined]);
 const reads=[];const restored=createServicePlanSubmission({initialKey:id(5),onPending:()=>{},api:async(path)=>{reads.push(path);return plan;}});
 await restored.recover();await assert.rejects(restored.retry(),/仅可查询/);assert.deepEqual(reads,['/data-services/agent/requests/'+id(5)]);
});
