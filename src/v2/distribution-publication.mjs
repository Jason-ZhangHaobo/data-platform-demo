import {isDeepStrictEqual as same} from 'node:util';
import {createHash} from 'node:crypto';
import {distributionDeliveryBinding} from './distribution-delivery.mjs';
import {getContext,validationFamilyForContext} from './context.mjs';
import {verifyOutputRows} from './output-contracts.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>Object.assign(Error('分布测试发布须重新确认确切包、演练、契约及两个冻结样例批次；文件审阅不代替发布批准'),{status:409,code:'DISTRIBUTION_PUBLICATION_SOURCE_CHANGED'});
export function assertDistributionConsent({bundle,verification,review,consent,local,schedulerMode}){
 const source=bundle?.manifest?.source;if(!source?.outputContract){if(consent!==undefined)throw fail();return;}
 const metadata=distributionDeliveryBinding(source.contextId),family=validationFamilyForContext(source.contextId);
 if(!local||schedulerMode!=='LOCAL_TIMER'||!same(source.outputContract,metadata)||
  !exact(consent,['scope','packageDigest','verificationId','metadataHash','scheduleSpec','confirmFrozenFictionalData'])||
  consent.scope!=='LOCAL_TEST_RELEASE'||consent.packageDigest!==bundle.digest||consent.verificationId!==verification?.id||consent.metadataHash!==metadata.metadataHash||consent.confirmFrozenFictionalData!==true||
  !exact(consent.scheduleSpec,['triggerAfterSeconds','intervalSeconds','runCount'])||consent.scheduleSpec.runCount!==2||
  !['triggerAfterSeconds','intervalSeconds'].every(k=>Number.isSafeInteger(consent.scheduleSpec[k])&&consent.scheduleSpec[k]>=1&&consent.scheduleSpec[k]<=300)||
  review?.status!=='REVIEWED'||review.scope!=='LOCAL_FILE_REVIEW'||review.packageId!==bundle.id||review.packageDigest!==bundle.digest||review.verificationId!==verification.id||
  verification.status!=='SUCCEEDED'||verification.packageId!==bundle.id||verification.packageDigest!==bundle.digest||verification.engine!=='Apache Spark'||verification.mainSqlExecuted!==true||verification.testDouble===true||
  verification.testSqlValidation?.passed!==true||verification.testSqlValidation.sqlHash!==createHash('sha256').update(bundle.files['tests.sql']).digest('hex')||!verifyOutputRows(verification.rows,getContext(source.contextId))||
  verification.validation?.passed!==true||verification.validation.regressions?.length!==family.contextIds.length||!family.contextIds.every(id=>verification.validation.regressions.some(c=>c.contextId===id&&c.passed)))throw fail();
 return structuredClone(consent);
}
export function assertDistributionRelease({bundle,verification,review,approval,spec,local,schedulerMode}){
 if(!bundle?.manifest?.source?.outputContract)return;
 assertDistributionConsent({bundle,verification,review,consent:approval?.distributionConsent,local,schedulerMode});
 if(approval.status!=='APPROVED'||approval.packageId!==bundle.id||approval.packageDigest!==bundle.digest||approval.rehearsalId!==verification.id||approval.reviewId!==review.id||
   (approval.sourceCodeHash??approval.sourceSqlHash)!==bundle.manifest.source.sqlHash||!same(approval.distributionConsent.scheduleSpec,spec))throw fail();
}
// Existing customer-asset releases retain their legacy lane. New distributions
// supersede only the same registered contract, never another running pipeline.
export function sameLocalPublicationLane(previousBundle,nextBundle){
 const previous=previousBundle?.manifest?.source?.fundLookthrough,next=nextBundle?.manifest?.source?.fundLookthrough;
 if(previous||next){
  const a=previousBundle?.manifest?.source?.attribution,b=nextBundle?.manifest?.source?.attribution;
  return Boolean(previous&&next&&previous.contractId===next.contractId&&previous.managerId===next.managerId&&
    a?.kind===b?.kind&&a?.modelMode===b?.modelMode);
 }
 const a=previousBundle?.manifest?.source?.outputContract?.id,b=nextBundle?.manifest?.source?.outputContract?.id;
 return a===b;
}

export const sameDistributionConsent=(a,b)=>same(a,b);

export function assertDistributionRollback({currentBundle,targetBundle,target,consent}){
 if(!currentBundle?.manifest?.source?.outputContract&&!targetBundle?.manifest?.source?.outputContract)return;
 if(!currentBundle?.manifest?.source?.outputContract||!targetBundle?.manifest?.source?.outputContract||!sameLocalPublicationLane(currentBundle,targetBundle)||
  !exact(consent,['scope','targetPackageDigest','metadataHash','confirmFrozenFictionalData'])||consent.scope!=='LOCAL_TEST_RELEASE'||consent.targetPackageDigest!==targetBundle.digest||
  consent.metadataHash!==targetBundle.manifest.source.outputContract.metadataHash||consent.confirmFrozenFictionalData!==true||target.health!=='HEALTHY'||target.successfulRunCount<2)throw fail();
 return structuredClone(consent);
}

export const distributionRequestSignature=value=>createHash('sha256').update(JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
export function activateDistributionRollback({store,project,item,target,consent,spec,reason,key,nowMs,plannedRuns}){
 const namespace=`${project}:distribution-rollback:${item.id}:${key}`,signature=distributionRequestSignature({targetReleaseId:target.id,consent,reason});
 const result=store.deduplicate(namespace,signature,()=>{
  if(store.get('release',item.id,project)?.version!==item.version||store.get('release',target.id,project)?.version!==target.version)throw fail();
  const now=new Date(nowMs).toISOString(),targetBundle=store.get('delivery_package',target.packageId,project);
  const rollback=store.create('release_rollback',project,{fromReleaseId:item.id,toReleaseId:target.id,actor:'local-engineer',reason,status:'SCHEDULED_FOR_VERIFICATION',distributionRollback:consent,resolvedAlertIds:[]});
  store.update('release',item.id,project,{status:'ROLLED_BACK_LOCAL',rolledBackToReleaseId:target.id,rolledBackToTaskId:targetBundle.manifest.source.requirement?.taskId,rolledBackAt:now});
  store.update('release',target.id,project,{status:'ACTIVE_LOCAL',health:'OBSERVING',successfulRunCount:0,failedRunCount:0,currentRollbackId:rollback.id,restoredFromReleaseId:item.id,restoredAt:now});
  store.create('monitor_event',project,{type:'ROLLBACK_ACTIVATED',releaseId:item.id,recoveryReleaseId:target.id,rollbackId:rollback.id,observedAt:now,status:'RECOVERY_SCHEDULED'});
  for(const data of plannedRuns)store.create('release_run',project,{...data,rollbackId:rollback.id});
  return rollback;
 });
 const rollback=store.get('release_rollback',result.id,project);
 return {rollback,activeRelease:store.get('release',rollback.toReleaseId,project),runs:store.list('release_run',project).filter(r=>r.rollbackId===rollback.id),replayed:result.replayed};
}
