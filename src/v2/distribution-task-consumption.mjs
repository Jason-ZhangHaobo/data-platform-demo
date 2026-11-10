import {isDeepStrictEqual as same} from 'node:util';
import {distributionServiceSources,certifiedDistributionSource} from './distribution-service-source.mjs';
import {distributionMetadataById} from './output-contract-metadata.mjs';
import {distributionFields,distributionComposition} from './distribution-services.mjs';
import {serviceVersionConfigValid,serviceHash} from './data-services.mjs';
const failure=()=>Object.assign(Error('分布消费来源、版本或历史调用未确认'),{status:409,code:'DISTRIBUTION_CONSUMPTION_SOURCE_CHANGED'});
const get=(store,project,kind,id)=>typeof id==='string'?store.get(kind,id,project):undefined;
const legalErrors=[400,403,404,409,422,504];
const provenance=proof=>({modelClassification:proof.modelClassification,engineClassification:proof.engineClassification,agentIndependentE2E:false});

// Rebuild a bounded report from original stored IDs. No rematerialization,
// applications, call logs, model jobs, Spark jobs or persisted mutations.
export async function distributionTaskConsumption({store,project,agent,packageDigest,releaseId,manager}){
 const selected=get(store,project,'release',releaseId),bundle=get(store,project,'delivery_package',selected?.packageId),contract=distributionMetadataById(bundle?.manifest?.source?.outputContract?.id);
 if(!contract||!selected||bundle.digest!==packageDigest||bundle.manifest.source.requirement?.taskId!==agent.id)throw failure();
 const sources=distributionServiceSources({store,project,selection:{taskId:agent.id,packageDigest,releaseId}}),sourceIds=new Set(sources.map(s=>s.id));if(sources.length!==2)throw failure();
 const stableSourceHash=serviceHash(sources),entries=[];let matchingCount=0;
 const sourceFor=v=>{
  const run=get(store,project,'release_run',v?.sourceReleaseRunId),proof=run&&certifiedDistributionSource({store,project,run});
  if(!sourceIds.has(run?.id)||v.sourceReleaseId!==releaseId||v.sourcePackageDigest!==packageDigest||v.outputContractId!==contract.id||!proof||!same(v.sourceEvidence,proof.sourceEvidence)||!same(v.fields,distributionFields(contract.id,v.fields)))throw failure();
  return run;
 };
 for(const service of manager.list()){
  const root=service.publishedVersion;if(service.status!=='PUBLISHED'||!root)continue;
  const childRefs=root.serviceType==='DAPI'?[root]:(root.steps??[]).map(step=>get(store,project,'data_service_version',step.dapiVersionId));
  if(!childRefs.some(v=>v?.sourceReleaseId===releaseId&&v.sourcePackageDigest===packageDigest&&v.outputContractId===contract.id))continue;
  matchingCount++;if(entries.length>=20)continue;
  const entry={serviceId:service.id,serviceType:service.serviceType,name:service.name,versionId:root.id,configHash:root.configHash,outputContractId:contract.id,releaseId,sourceKind:'AGENT',agentIndependentE2E:false,status:'PENDING',sourceRunIds:[],fullAssetComposition:false,distributionComposition:false,notice:'尚无当前固定版本的非空授权调用；页面查询测试不算外部消费。'};
  try{
   const owned=manager.detail(service.id);if(owned.publishedVersion?.id!==root.id||!serviceVersionConfigValid(root)||root.scope!=='LOCAL_TEST_ONLY'||root.serviceType!==service.serviceType||!childRefs.length||childRefs.some(v=>!v||!serviceVersionConfigValid(v)||v.scope!=='LOCAL_TEST_ONLY'||v.outputContractId!==contract.id))throw failure();
   const children=root.serviceType==='DAPI'?[root]:root.steps.map((step,i)=>{const child=childRefs[i];manager.detail(step.dapiId);if(child.serviceId!==step.dapiId)throw failure();return child;});
   if(root.serviceType==='XAPI'){
    if(children.length<2||children.length>5||!same(distributionComposition(children,root.steps),Object.fromEntries(['sourceEvidence','outputContractId','composition','groupKeys','joinKeys'].map(k=>[k,root[k]]))))throw failure();
   }
   const runs=children.map(sourceFor);
   entry.sourceRunIds=[...new Set(runs.map(r=>r.id))];
   entry.sourceVersions=children.map(v=>({serviceId:v.serviceId,versionId:v.id,configHash:v.configHash,sourceReleaseRunId:v.sourceReleaseRunId,snapshotHash:v.snapshotHash,packageDigest,fields:v.fields}));
   entry.source={revisionId:bundle.manifest.source.revisionId,developmentRunId:bundle.manifest.source.runId,contextId:bundle.manifest.source.contextId,metadataHash:bundle.manifest.source.outputContract.metadataHash,...provenance(children[0].sourceEvidence)};
   entry.distributionComposition=root.serviceType==='XAPI'&&contract.fields.every(f=>children.some(v=>v.fields.includes(f.name)));
   const candidates=manager.listCalls(service.id).filter(c=>c.serviceVersionId===root.id&&c.outcome==='SUCCEEDED'&&c.statusCode===200).sort((a,b)=>String(b.finishedAt).localeCompare(String(a.finishedAt))||a.id.localeCompare(b.id));
   entry.callsTruncated=candidates.length>10;entry.checkedCalls=[];
   for(const call of candidates.slice(0,10)){
    const app=manager.application(call.applicationId);
    if(app.scope!=='LOCAL_TEST_ONLY'||!app.serviceIds.includes(service.id)||!['ACTIVE','REVOKED','EXPIRED'].includes(app.status))throw failure();
    const proof=await manager.recheckDistributionCall(service.id,call.id);
    if(!proof.verified||!proof.independentResultVerified)throw failure();
    const after=manager.application(app.id);if(after.scope!==app.scope||!after.serviceIds.includes(service.id))throw failure();
    entry.checkedCalls.push({...proof,applicationId:app.id,applicationStatus:after.status,finishedAt:call.finishedAt});
   }
   const nonempty=entry.checkedCalls.find(c=>c.rowCount>0);
   if(nonempty){entry.call=nonempty;entry.status=entry.callsTruncated?'NEEDS_ATTENTION':'VERIFIED';entry.code=entry.callsTruncated?'CALL_EVIDENCE_TRUNCATED':'OK';entry.notice='历史授权调用的分类、金额、占比、分页及摘要与独立依据对照通过；凭证状态仅为本次读取时的状态。';}
   if(entry.callsTruncated){entry.status='NEEDS_ATTENTION';entry.code='CALL_EVIDENCE_TRUNCATED';entry.notice='历史调用超过本次核验上限，不能标记本次消费完成。';}
   const current=manager.detail(service.id).publishedVersion;if(current?.id!==root.id||!serviceVersionConfigValid(current)||current.configHash!==root.configHash||serviceHash(distributionServiceSources({store,project,selection:{taskId:agent.id,packageDigest,releaseId}}))!==stableSourceHash)throw failure();
  }catch(e){if(!legalErrors.includes(e.status))throw e;entry.status='NEEDS_ATTENTION';entry.code=e.code??'DISTRIBUTION_CONSUMPTION_UNCONFIRMED';entry.notice='来源、固定版本、应用或独立结果未确认；不借用其他版本的历史通过。';}
  entries.push(entry);
 }
 const truncated=matchingCount>20,verified=!truncated&&entries.some(e=>e.status==='VERIFIED'&&e.distributionComposition&&e.call?.verified&&e.call.independentResultVerified);
 return{protocol:'shuduo-local-distribution-consumption/v1',scope:'LOCAL_TEST_ONLY',taskId:agent.id,packageDigest,releaseId,sourceKind:'AGENT',outputContractId:contract.id,metadataHash:bundle.manifest.source.outputContract.metadataHash,status:verified?'VERIFIED':'PENDING',checkedAt:new Date().toISOString(),matchingCount,truncated,services:entries,publicDeployed:false,externalSystemVerified:false,agentIndependentE2E:false,notice:'只读重核已保存的授权调用及不可变结果，不新建调用或计算。仅覆盖这些历史请求，不代表所有客户、外部系统独立验收或真实模型完整自主E2E。'};
}
