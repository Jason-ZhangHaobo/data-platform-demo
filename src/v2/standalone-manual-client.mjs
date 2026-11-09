import {checkedManualContinuationBinding} from './manual-continuation-binding.mjs';
import {checkedAssistedDevelopmentReference,sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bad=()=>new Error('手工交付回执与指定来源、版本或文件字节未确认；保留原记录和请求编号，不自动重提');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))),b=>b.toString(16).padStart(2,'0')).join('');
const selected=(s,detail=false)=>s&&Object.keys(s).every(k=>['sourceRunId','revisionId','revisionHash','taskId','sourceBinding'].includes(k))&&uuid(s.sourceRunId)&&(!detail||uuid(s.taskId));
const names=['main.sql','tests.sql','schedule.json','deployment.json','calendar.json','fixtures.json','validation.json','README.md'];
export function checkedStandaloneTask(task,selection){
  const b=checkedManualContinuationBinding(task?.sourceBinding),r=checkedAssistedDevelopmentReference(task?.developmentReference);
  if(!uuid(task.id)||task.mode!=='DURABLE_MANUAL_DELIVERY_V1'||task.sourceKind!=='MANUAL'||task.sourceAttribution!=='ENGINEER_AUTHORED'||task.modelRequired!==false||task.agentIndependentE2E!==false||task.fullLifecycleE2E!==false||task.publicDeployed!==false||
    task.sourceAgentTaskId!==undefined||task.agentTaskId!==undefined||!Number.isSafeInteger(task.version)||task.version<1||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(task.status)||
    task.source?.kind!=='MANUAL_RUN'||task.source.runId!==b.runId||task.source.revisionId!==b.revisionId||task.source.revisionHash!==b.revisionHash||task.sourceRunId!==b.runId||task.sourceRevisionId!==b.revisionId||task.sourceSqlHash!==b.revisionHash||
    r.kind!=='MANUAL_SUCCESS_REFERENCE'||r.sourceRunId!==b.runId||r.sourceRevisionId!==b.revisionId||r.sourceRevisionHash!==b.revisionHash||r.evidenceDigest!==b.evidenceDigest||
    selection.sourceRunId!==b.runId||selection.revisionId!==undefined&&selection.revisionId!==b.revisionId||selection.revisionHash!==undefined&&selection.revisionHash!==b.revisionHash||
    selection.taskId!==undefined&&task.id!==selection.taskId||selection.sourceBinding!==undefined&&canonical(b)!==canonical(checkedManualContinuationBinding(selection.sourceBinding)))throw bad();
  return task;
}
async function checkedFiles(value,task){
  const b=value.package;if(b===undefined){if(task?.packageId)throw bad();return;}
  if(!task||b.id!==task.packageId||b.digest!==task.packageDigest||!hash(b.digest)||b.manifest?.format!=='shuduo-delivery/v1'||b.manifest.releaseState!=='NOT_PUBLISHED'||
    b.manifest.source?.runId!==task.sourceRunId||b.manifest.source.revisionId!==task.sourceRevisionId||b.manifest.source.sqlHash!==task.sourceSqlHash||
    b.manifest.source.attribution?.kind!=='ENGINEER_AUTHORED'||b.manifest.source.attribution.agentIndependentE2E!==false||b.manifest.source.attribution.originAgentTaskId!==undefined||
    !sameAssistedDevelopmentReference(b.manifest.source.attribution.developmentReference,task.developmentReference)||canonical(Object.keys(b.files??{}).sort())!==canonical([...names].sort())||canonical(Object.keys(b.manifest.files??{}).sort())!==canonical([...names].sort()))throw bad();
  let total=0;for(const name of names){const text=b.files[name],entry=b.manifest.files[name];if(typeof text!=='string')throw bad();const bytes=new TextEncoder().encode(text).length;total+=bytes;if(bytes>250000||entry.bytes!==bytes||entry.sha256!==await digest(text))throw bad();}
  if(total>750000||await digest(canonical(b.manifest))!==b.digest||await digest(b.files['main.sql'])!==task.sourceSqlHash)throw bad();
}
async function checkedValue(value,selection,workflow){
  if(value?.protocol!==(workflow?'shuduo-standalone-manual-workflow/v1':'shuduo-standalone-manual-detail/v1')||value.modelRequired!==false)throw bad();
  const task=value.delivery===undefined?undefined:checkedStandaloneTask(value.delivery,selection);if(!workflow&&!task)throw bad();
  if(workflow){
    const b=checkedManualContinuationBinding(value.sourceBinding),ref=checkedAssistedDevelopmentReference(value.developmentReference),r=value.report;
    if(value.source?.kind!=='MANUAL_RUN'||value.source.runId!==selection.sourceRunId||value.source.revisionId!==b.revisionId||value.source.revisionHash!==b.revisionHash||
      r?.runId!==b.runId||r.revisionId!==b.revisionId||r.revisionHash!==b.revisionHash||r.sourceKind!=='MANUAL'||r.sourceAttribution!=='ENGINEER_AUTHORED'||r.agentIndependentE2E!==false||r.taskId!==undefined||
      !Array.isArray(r.checks)||canonical(r.checks.map(c=>c.id).sort())!==canonical(['revision','execution','results','regressions'].sort())||r.status!=='PASSED'||r.checks.some(c=>c.passed!==true)||typeof value.sourceCurrent!=='boolean'||typeof value.executionAvailable!=='boolean'||
      ref.kind!=='MANUAL_SUCCESS_REFERENCE'||ref.evidenceDigest!==b.evidenceDigest||ref.sourceRunId!==b.runId||ref.sourceRevisionId!==b.revisionId||ref.sourceRevisionHash!==b.revisionHash||ref.originAgentTaskId!==b.originAgentTaskId||typeof value.publication?.available!=='boolean'||!['NOT_IMPLEMENTED','PRIVATE_CLOUD_TEST'].includes(value.publication.scope)||
      selection.revisionId!==undefined&&b.revisionId!==selection.revisionId||selection.revisionHash!==undefined&&b.revisionHash!==selection.revisionHash||
      value.sourceCurrent!==(!task||task.sourceBinding.evidenceDigest===b.evidenceDigest))throw bad();
  }
  const window=value.publication?.window;
  if(window&&(!task||window.manualDeliveryTaskId!==task.id||window.packageDigest!==task.packageDigest||window.verificationId!==task.verificationId||!Number.isFinite(Date.parse(window.startsAt))||!Number.isFinite(Date.parse(window.expiresAt))||Date.parse(window.expiresAt)<=Date.parse(window.startsAt)||Date.parse(window.expiresAt)-Date.parse(window.startsAt)>7200000))throw bad();
  if(value.publication?.available&&(!window||value.publication.scope!=='PRIVATE_CLOUD_TEST'))throw bad();
  await checkedFiles(value,task);
  const v=value.verification;if(v!==undefined&&(!task||v.id!==task.verificationId||v.manualDeliveryTaskId!==task.id||v.packageId!==task.packageId||v.packageDigest!==task.packageDigest||v.agentDeliveryTaskId!==undefined||
    !['RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(v.status)||v.status==='SUCCEEDED'&&(v.engine!=='Apache Spark'||v.engineVersion!=='3.5.9'||v.mainSqlExecuted!==true||v.testSqlValidation?.passed!==true||v.validation?.passed!==true)))throw bad();
  if(v?.status==='SUCCEEDED'){
    const ids=JSON.parse(value.package.files['fixtures.json']).validationContexts.map(c=>c.id),checks=v.validation.regressions;
    if(ids.length!==5||new Set(ids).size!==5||!Array.isArray(checks)||checks.length!==5||new Set(checks.map(c=>c.contextId)).size!==5||
      !ids.every(id=>checks.some(c=>c.contextId===id&&c.passed===true))||v.testSqlValidation.sqlHash!==await digest(value.package.files['tests.sql'])||
      v.validation.contractId!==undefined&&v.validation.contractId!==value.package.manifest.source.validationContractId)throw bad();
  }
  if(task?.status==='SUCCEEDED'&&v?.status!=='SUCCEEDED')throw bad();return value;
}
export async function readStandaloneWorkflow(client,selection){if(!selected(selection))throw bad();return checkedValue(await client.request(`/delivery/manual/source/${selection.sourceRunId}`),selection,true);}
export async function readStandaloneDetail(client,selection){if(!selected(selection,true))throw bad();return checkedValue(await client.request(`/delivery/manual/${selection.taskId}`),selection,false);}
export async function prepareStandaloneManual(client,input){
  if(!input||Object.keys(input).some(k=>!['sourceRunId','requestId','confirm'].includes(k))||input.confirm!==true||!uuid(input.requestId))throw bad();
  const before=await readStandaloneWorkflow(client,{sourceRunId:input.sourceRunId});
  return checkedStandaloneTask(await client.request('/delivery/manual',{method:'POST',body:{sourceBinding:before.sourceBinding},idempotencyKey:input.requestId}),{sourceRunId:input.sourceRunId,sourceBinding:before.sourceBinding});
}
export async function mutateStandaloneManual(client,input){
  if(!input||Object.keys(input).some(k=>!['sourceRunId','taskId','expectedVersion','operation','confirm'].includes(k))||input.confirm!==true||!uuid(input.sourceRunId)||!uuid(input.taskId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!['advance','cancel'].includes(input.operation))throw bad();
  return checkedStandaloneTask(await client.request(`/delivery/manual/${input.taskId}/${input.operation}`,{method:'POST',body:{expectedVersion:input.expectedVersion}}),{sourceRunId:input.sourceRunId,taskId:input.taskId});
}
