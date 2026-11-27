import {reviewedBatchPair,type Publication} from './agent-delivery-evidence-read.ts';
import {validationFamilyForContextId} from './validation-family.ts';

export function invitedPublicationMonitor(history:Publication){
  const {release,runs,events,alerts}=history;
  const pair=reviewedBatchPair(release,runs);
  const complete=Boolean(release&&pair&&release.runCount===2&&release.health==='HEALTHY'&&
    release.status==='COMPLETED_CLOUD_TEST'&&history.monitoringVerified===true&&!alerts.some(alert=>alert.status==='OPEN')&&
    runs.every(batch=>batch.status==='SUCCEEDED'&&batch.schedulerTriggered===true&&events.some(event=>
      event.type==='BATCH_SUCCEEDED'&&event.releaseId===release.id&&event.releaseRunId===batch.id&&event.packageDigest===release.packageDigest)));
  return {pair,complete};
}

type BatchChecks={status:string;schedulerTriggered?:boolean;engine?:unknown;mainSqlExecuted?:unknown;
  testSqlValidation?:{passed?:unknown};validation?:{contractId?:unknown;regressions?:{contextId:string;passed:boolean}[]}};
export function invitedBatchAssertions(batch:BatchChecks,contextId:string){
  if(!['SUCCEEDED','FAILED'].includes(batch.status)||batch.schedulerTriggered!==true||batch.engine!=='Apache Spark'||batch.mainSqlExecuted!==true)return;
  const validation=batch.validation,rows=validation?.regressions;
  const family=validationFamilyForContextId(contextId);
  const regression=family&&(validation?.contractId===undefined||validation.contractId===family.id)&&
    Array.isArray(rows)&&rows.length===family.contextIds.length&&rows.every(row=>typeof row?.passed==='boolean')&&
    family.contextIds.every(id=>rows.some(row=>row.contextId===id))?{passed:rows.filter(row=>row.passed).length,total:rows.length}:undefined;
  const tests=batch.testSqlValidation?.passed;
  return {testSql:typeof tests==='boolean'?tests:undefined,regression};
}
