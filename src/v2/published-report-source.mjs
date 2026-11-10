import {resolveDistributionReportSource} from './distribution-reports.mjs';
import {isDeepStrictEqual as same} from 'node:util';
import {createHash} from 'node:crypto';
import {validateDeliveryPackage,validationMatchesFamily,sha256} from './delivery.mjs';
import {developmentVerificationReport} from './agent-development-workflow.mjs';
import {localServiceSources} from './local-service-sources.mjs';
import {getContext} from './context.mjs';
import {publishedReportSource} from './published-report-request.mjs';
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export const publishedReportHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function resolvePublishedReportSource({store,project,source,actorId}){
 source=publishedReportSource(source);
 const read=(kind,id)=>{const value=store.get(kind,id,project);if(!value||value.projectId!==project)throw fail(409,'REPORT_SOURCE_UNAVAILABLE','原发布来源缺失，未改用其他批次');return value;};
 const revision=read('revision',source.revisionId),code=read('run',source.runId),release=read('release',source.releaseId),bundle=read('delivery_package',release.packageId),batch=read('release_run',source.batchId);
 if(bundle.manifest?.source?.outputContract)return resolveDistributionReportSource({store,project,source,actorId,hash:publishedReportHash});
 if(source.kind==='MANUAL'){
  if(revision.source!=='MANUAL'||revision.author!==actorId||revision.manualProvenance?.actorId!==actorId)throw fail(403,'REPORT_SOURCE_OWNER','手工报表来源须属于当前工程师');
 }else{
  const agent=read('agent',source.taskId);
  if(agent.submittedBy!==actorId&&!(actorId==='local-engineer'&&agent.submittedBy===undefined))throw fail(403,'REPORT_SOURCE_OWNER','报表来源不属于当前任务发起人');
  if(!localServiceSources({store,project,selection:{taskId:source.taskId,releaseId:source.releaseId,packageDigest:source.packageDigest}}).some(r=>r.id===source.batchId))throw fail(409,'REPORT_SOURCE_UNPROVEN','原Agent发布批次尚未通过完整来源核验');
 }
 const plan=validateDeliveryPackage(bundle,source.packageDigest),p=plan.source,family={id:p.validationContractId,contextIds:plan.fixtures.validationContexts.map(c=>c.id)},
  approval=read('release_approval',release.approvalId),review=read('delivery_review',approval.reviewId),verification=read('delivery_verification',approval.rehearsalId);
 const files=r=>r.status==='SUCCEEDED'&&r.testDouble!==true&&r.engine==='Apache Spark'&&r.engineVersion===plan.deployment.runtime.version&&r.mainSqlExecuted===true&&r.packageId===bundle.id&&r.packageDigest===bundle.digest&&same(r.source,p)&&
  same(r.fileHashes,Object.fromEntries(Object.entries(bundle.manifest.files).map(([k,v])=>[k,v.sha256])))&&r.testSqlValidation?.passed===true&&r.testSqlValidation.sqlHash===sha256(bundle.files['tests.sql'])&&validationMatchesFamily(r.validation,family);
 if(bundle.digest!==source.packageDigest||release.packageDigest!==source.packageDigest||p.projectId!==project||p.contextId!==revision.contextId||p.revisionId!==revision.id||p.runId!==code.id||
  p.sqlHash!==revision.hash||sha256(revision.sql)!==revision.hash||bundle.files['main.sql']!==revision.sql||release.sourceRevisionId!==revision.id||(release.sourceCodeHash??release.sourceSqlHash)!==revision.hash||
  developmentVerificationReport({id:source.taskId??code.id,contextId:revision.contextId},code,revision).status!=='PASSED'||release.publicDeployed!==false||release.mode!==undefined||release.adapter!=='local-spark-v1'||release.environment!=='local-rehearsal'||
  approval.status!=='APPROVED'||approval.packageId!==bundle.id||approval.packageDigest!==bundle.digest||approval.scope!=='LOCAL_TEST_RELEASE'||approval.publicDeploymentApproved!==false||approval.consumedByReleaseId!==release.id||
  review.status!=='REVIEWED'||review.packageId!==bundle.id||review.packageDigest!==bundle.digest||review.verificationId!==verification.id||review.scope!=='LOCAL_TEST_RELEASE'||review.publicDeploymentApproved!==false||!['code','assertions','deliveryFiles','localScope'].every(k=>review.attestations?.[k]===true)||!files(verification)||
  batch.releaseId!==release.id||batch.mode!=='LOCAL_SCHEDULED_RELEASE'||batch.clockMode!=='WALL_CLOCK_TIMER'||!files(batch)||batch.published!==true||batch.publicDeployed!==false||batch.schedulerTriggered!==true||
  !Array.isArray(batch.rows)||batch.rows.length>1000||!developmentVerificationReport({contextId:revision.contextId},{rows:batch.rows},revision).checks.find(c=>c.id==='results')?.passed||
  !store.list('monitor_event',project).some(e=>e.type==='BATCH_SUCCEEDED'&&e.releaseId===release.id&&e.releaseRunId===batch.id&&e.packageDigest===bundle.digest&&e.schedulerTriggered===true&&e.status==='SUCCEEDED'&&Number.isFinite(Date.parse(e.observedAt))&&Date.parse(e.observedAt)>=Date.parse(batch.finishedAt)))
   throw fail(409,'REPORT_SOURCE_UNPROVEN','报表的代码、审阅或成功批次证据未确认；未创建新快照');
 const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
 if(batch.rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)||fields.some(f=>!Object.hasOwn(r,f))))throw fail(409,'REPORT_SOURCE_FIELDS','已发布结果缺少证券客户资产字段');
 const rows=batch.rows.map(r=>Object.fromEntries(fields.map(f=>[f,r[f]]))),evidenceHash=publishedReportHash(rows),context=getContext(revision.contextId);
 return{asset:{id:'dataset:customer_assets_t1',versionId:batch.id,evidenceHash,fields:fields.map(name=>({name,type:name==='client_id'?'STRING':'DECIMAL'}))},rows:structuredClone(rows),context:{id:context.id,name:context.name,definition:context.definition},source};
}
