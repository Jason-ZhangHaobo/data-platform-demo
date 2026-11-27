import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invitedBatchAssertions,invitedPublicationMonitor} from '../../web/src/invited-publication-monitor.ts';
import {validationFamilyForContextId} from '../../web/src/validation-family.ts';

test('registered, scheduled and independently monitored invited test releases remain distinct',()=>{
  const release={id:randomUUID(),packageId:randomUUID(),packageDigest:'d'.repeat(64),reviewDigest:'b'.repeat(64),
    runCount:2,sourceAgentTaskId:randomUUID(),sourceRunId:randomUUID(),status:'COMPLETED_CLOUD_TEST',health:'HEALTHY'};
  const runs=[1,2].map(sequence=>({...release,id:randomUUID(),releaseId:release.id,sequence,status:'SUCCEEDED',schedulerTriggered:true}));
  const events=runs.map(r=>({type:'BATCH_SUCCEEDED',releaseId:release.id,releaseRunId:r.id,packageDigest:release.packageDigest}));
  const history={release,runs,alerts:[],events,monitoringVerified:true};
  assert.equal(invitedPublicationMonitor(history).complete,true);
  for(const patch of [{release:{...release,health:'PENDING'}},{monitoringVerified:undefined},{alerts:[{status:'OPEN'}]},
    {runs:[runs[0],{...runs[1],status:'SCHEDULED',schedulerTriggered:false}]},
    {events:[events[0],{...events[1],releaseRunId:runs[0].id}]},{events:[events[0],{...events[1],packageDigest:'e'.repeat(64)}]},
    {runs:[runs[0],{...runs[1],reviewDigest:'a'.repeat(64)}]}])
    assert.equal(invitedPublicationMonitor({...history,...patch}).complete,false);
  const waiting=invitedPublicationMonitor({...history,runs:runs.map(r=>({...r,status:'SCHEDULED',schedulerTriggered:false})),events:[],monitoringVerified:false});
  assert.equal(waiting.pair.triggered,0);assert.equal(waiting.complete,false);
});

test('only a triggered Spark batch supplies its own complete registered assertion count',()=>{
  const family=validationFamilyForContextId('cash-change'),regressions=family.contextIds.map((contextId,i)=>({contextId,passed:i>0}));
  const batch={status:'FAILED',schedulerTriggered:true,engine:'Apache Spark',mainSqlExecuted:true,testSqlValidation:{passed:false},
    validation:{contractId:family.id,regressions}};
  assert.deepEqual(invitedBatchAssertions(batch,'cash-change'),{testSql:false,regression:{passed:4,total:5}});
  assert.equal(invitedBatchAssertions({...batch,schedulerTriggered:false},'cash-change'),undefined);
  for(const validation of [{contractId:'other',regressions},{contractId:family.id,regressions:regressions.slice(1)},
    {contractId:family.id,regressions:[regressions[1],...regressions.slice(1)]}])
    assert.equal(invitedBatchAssertions({...batch,validation},'cash-change').regression,undefined);
});
