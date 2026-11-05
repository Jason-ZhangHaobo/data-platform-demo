import {privateTaskConsumption} from './private-task-consumption.mjs';
import {validateDeliveryPackage} from './delivery.mjs';
import {localServiceSources} from './local-service-sources.mjs';
const fail=()=>Object.assign(new Error('任务、交付包与本机发布来源不一致'),{status:409,code:'LOCAL_CONSUMPTION_SOURCE_MISMATCH'});
const agentSource=record=>record&&[undefined,'AGENT'].includes(record.sourceKind)&&record.sourceAttribution===undefined;

// The HTTP route is local-only; every relationship is rebuilt from stored records.
// No mutations, credential creation, model calls or Spark execution occur here.
export async function localTaskConsumption({store,project,agent,packageDigest,releaseId,manager}) {
 if(releaseId!==undefined){
  const stored=store.get('agent',agent.id,project);
  if(!stored||agent.status!=='SUCCEEDED'||!agentSource(agent)||JSON.stringify(agent.attempts)!==JSON.stringify(stored.attempts))throw fail();
  const selection={taskId:agent.id,packageDigest,releaseId},sources=localServiceSources({store,project,selection}),ids=new Set(sources.map(source=>source.id));
  const getRelease=id=>id===releaseId&&sources.length?{...store.get('release',id,project),sourceAgentTaskId:agent.id,sourceKind:'AGENT'}:undefined;
  return privateTaskConsumption({taskId:agent.id,packageDigest,releaseId,scope:'LOCAL_TEST_ONLY',services:manager.list(),
   getPackage:id=>store.get('delivery_package',id,project),
   ownedService:id=>manager.detail(id),getVersion:id=>store.get('data_service_version',id,project),getRelease,
   source:id=>{if(!ids.has(id))throw fail();return store.get('release_run',id,project);},
   application:id=>store.get('service_app',id,project),calls:id=>manager.listCalls(id),recheckCall:(id,callId)=>manager.recheckCall(id,callId)});
 }
 const attempt=agent.attempts?.at(-1);
 const deliveries=store.list('agent_delivery_task',project).filter(d=>d.sourceAgentTaskId===agent.id&&d.packageDigest===packageDigest&&d.sourceRevisionId===attempt?.revisionId&&d.sourceRunId===attempt?.runId);
 if(agent.status!=='SUCCEEDED'||!agentSource(agent)||releaseId!==undefined&&deliveries.length!==1)throw fail();
 const delivery=deliveries[0];
 const bundle=delivery&&store.get('delivery_package',delivery.packageId,project);
 if(!bundle||bundle.digest!==packageDigest||bundle.manifest.source.revisionId!==attempt.revisionId||bundle.manifest.source.runId!==attempt.runId||
   !agentSource(delivery)||!agentSource(bundle)||bundle.manifest.source.attribution!==undefined)throw fail();
 validateDeliveryPackage(bundle,packageDigest);
 const getRelease=id=>{
  const release=store.get('release',id,project),approval=release&&store.get('release_approval',release.approvalId,project);
  if(!release||release.mode==='DURABLE_PRIVATE_RELEASE_V1'||!agentSource(release)||!agentSource(approval)||release.packageId!==bundle.id||release.packageDigest!==packageDigest||release.sourceRevisionId!==attempt.revisionId||approval?.status!=='APPROVED'||approval.packageDigest!==packageDigest||approval.packageId!==bundle.id)return undefined;
  return {...release,sourceAgentTaskId:agent.id,sourceKind:'AGENT'};
 };
 const source=id=>{
  const run=store.get('release_run',id,project),release=run&&getRelease(run.releaseId);
  if(!release||!agentSource(run)||run.status!=='SUCCEEDED'||!run.published||!run.schedulerTriggered||run.engine!=='Apache Spark'||run.mainSqlExecuted!==true||run.testDouble===true||!run.validation?.passed||!run.testSqlValidation?.passed||run.packageDigest!==packageDigest||run.source?.revisionId!==attempt.revisionId||run.source?.runId!==attempt.runId)throw fail();
  return run;
 };
 return privateTaskConsumption({taskId:agent.id,packageDigest,releaseId,scope:'LOCAL_TEST_ONLY',services:manager.list(),
  getPackage:id=>store.get('delivery_package',id,project),
  ownedService:id=>manager.detail(id),getVersion:id=>store.get('data_service_version',id,project),source,getRelease,
  application:id=>store.get('service_app',id,project),calls:id=>manager.listCalls(id),recheckCall:(id,callId)=>manager.recheckCall(id,callId)});
}
