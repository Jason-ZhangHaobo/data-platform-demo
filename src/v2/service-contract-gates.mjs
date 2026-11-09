import {serviceHash,normalizedServiceSourceRows,serviceVersionConfigValid} from './data-services.mjs';
const fail=(message,code='CONTRACT_GATE_BLOCKED')=>Object.assign(Error(message),{status:409,code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const basis=v=>{const value=v??'SOURCE_ROWS';if(!['SOURCE_ROWS','PUBLICATION_FINISHED'].includes(value))throw Object.assign(Error('时间依据必须为源行时间或发布完成时间'),{status:422});return value;};
export function createServiceContractGates({store,project,contracts,businessStore,now=()=>Date.now()}){
 const read=(kind,id)=>store.get(kind,id,project),bindingsFor=id=>store.list('service_contract_gate',project).filter(b=>b.serviceId===id),version=b=>read('service_contract_gate_version',b.currentVersionId);
 const detail=b=>({...b,currentVersion:version(b),versions:store.list('service_contract_gate_version',project).filter(v=>v.bindingId===b.id)});
 const rules=contract=>serviceHash({assetId:contract.assetId,fields:contract.currentVersion.fields,schemaHash:contract.currentVersion.schemaHash,qualitySlo:contract.qualitySlo,compatibility:contract.compatibility});
 const configuration=(bindingId,number,contract,input)=>{
  if(input.contractVersionId!==contract.currentVersion.id)throw fail('契约版本已变化，请重新审阅','CONTRACT_GATE_STALE_CONTRACT');
  if(contract.assetId!=='dataset:customer_assets_t1')throw fail('此门禁仅支持已发布客户资产数据集，不使用其他资产替代','CONTRACT_GATE_ASSET_MISMATCH');
  return{bindingId,versionNumber:number,contractId:contract.id,contractVersionId:contract.currentVersion.id,rulesHash:rules(contract),freshnessBasis:basis(input.freshnessBasis),changeReason:input.changeReason??'首次绑定'};
 };
 const stateHash=id=>serviceHash(bindingsFor(id).map(b=>({id:b.id,currentVersionId:b.currentVersionId,configHash:version(b)?.configHash??'MISSING'})).sort((a,b)=>a.id.localeCompare(b.id)));
 const writeKey=(serviceId,actor,key)=>`${project}:service-contract-gate-write:${actor}:${serviceId}:${key}`;
 const requestKey=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw Object.assign(Error('缺少门禁原请求编号'),{status:422});return value;};
 const writeView=(r,replayed)=>{
  if(!r)throw Object.assign(Error('未找到本账号的原门禁保存请求'),{status:404,code:'CONTRACT_GATE_REQUEST_NOT_FOUND'});
  const applied=read('service_contract_gate_version',r.appliedVersion.id),current=read('service_contract_gate',r.bindingId);
  if(!applied||!current||serviceHash(applied)!==serviceHash(r.appliedVersion))throw fail('原门禁保存回执与不可变版本不一致，未采用新版本替代','CONTRACT_GATE_RECEIPT_CHANGED');
  return{protocol:'shuduo-service-contract-gate-write/v1',receipt:{id:r.id,serviceId:r.serviceId,bindingId:r.bindingId,requestId:r.requestId,operation:r.operation,bindingRevisionAtApply:r.bindingRevisionAtApply,appliedVersion:r.appliedVersion},current:detail(current),currentMatches:current.currentVersionId===r.appliedVersion.id,replayed};
 };
 function evidenceFor(v){
  const snapshot=businessStore.snapshotEvidence(v.snapshotId),run=read('release_run',v.sourceReleaseRunId);
  if(!serviceVersionConfigValid(v)||!snapshot?.integrityVerified||snapshot.contentHash!==v.snapshotHash||!run||run.releaseId!==v.sourceReleaseId||run.status!=='SUCCEEDED'||run.published!==true||run.schedulerTriggered!==true||!Array.isArray(run.columns)||!run.columns.length)throw fail('绑定源快照或字段证据缺失，门禁未放行','CONTRACT_GATE_SOURCE_UNAVAILABLE');
  const normalized=normalizedServiceSourceRows(run.rows);if(serviceHash(normalized)!==snapshot.contentHash)throw fail('发布源与实际服务快照不一致，门禁未放行','CONTRACT_GATE_SOURCE_CHANGED');
  const fields=run.columns.map(c=>Array.isArray(c)?{name:c[0],type:c[1],nullable:true}:{name:c.name,type:c.type,nullable:c.nullable!==false});
  if(fields.length>200||fields.some(f=>typeof f.name!=='string'||typeof f.type!=='string'))throw fail('缺少可核验的冻结字段类型','CONTRACT_GATE_SCHEMA_UNAVAILABLE');
  const fingerprint=serviceHash({versionId:v.id,configHash:v.configHash,snapshotId:v.snapshotId,snapshotHash:snapshot.contentHash,sourceId:run.id,fields,rows:run.rows,finishedAt:run.finishedAt});
  return{fingerprint,ref:{versionId:v.id,sourceRunId:run.id,snapshotId:v.snapshotId,snapshotHash:snapshot.contentHash},asset:{id:'dataset:customer_assets_t1',versionId:run.id,fields,evidenceHash:fingerprint},rows:structuredClone(run.rows),publicationFinishedAt:run.finishedAt};
 }
 function evaluate({service,version:target,dataVersions,action}){
  const bindings=bindingsFor(service.id);if(!bindings.length)return{decision:'NOT_CONFIGURED',configured:false};
  const configHash=stateHash(service.id),checks=[],sources=[];
  for(const binding of bindings){const cfg=version(binding);
   try{
    if(!cfg)throw fail('门禁版本记录缺失','CONTRACT_GATE_CONFIG_UNAVAILABLE');
    const contract=contracts.detail(binding.contractId);
    if(contract.currentVersion.id!==cfg.contractVersionId||rules(contract)!==cfg.rulesHash)throw fail('契约已更新，请重新确认门禁版本','CONTRACT_GATE_STALE_CONTRACT');
    const seen=new Set();
    for(const v of dataVersions){const evidence=evidenceFor(v);if(!sources.some(s=>s.versionId===v.id))sources.push({versionId:v.id,fingerprint:evidence.fingerprint});if(seen.has(evidence.fingerprint))continue;seen.add(evidence.fingerprint);
     const result=contracts.check(binding.contractId,{evidence:{...evidence,freshnessBasis:cfg.freshnessBasis}}).check;
     checks.push({bindingId:binding.id,bindingVersionId:cfg.id,contractId:contract.id,contractVersionId:cfg.contractVersionId,source:evidence.ref,checkId:result.id,status:result.status,
      missing:result.missing,typeMismatch:result.typeMismatch,nullViolations:result.nullViolations,evaluatedRows:result.evaluatedRows,rowPassRate:result.rowPassRate,minPassRate:result.minPassRate,requiredFieldCount:result.requiredFieldCount,
      freshnessBasis:cfg.freshnessBasis,freshnessMeasured:result.freshnessMeasured,freshnessSeconds:result.freshnessSeconds,maxFreshnessSeconds:result.maxFreshnessSeconds,freshnessClockSkewDetected:result.freshnessClockSkewDetected,
      reason:result.status==='PARTIAL'?'实际行或时间证据未完整测量；未用其他来源替代':result.status==='FAILED'?'字段、必填或时效约束不符合契约':undefined});
    }
   }catch(error){checks.push({bindingId:binding.id,bindingVersionId:cfg?.id,contractId:binding.contractId,status:'UNAVAILABLE',reasonCode:error.code??'CONTRACT_GATE_CHECK_UNAVAILABLE',reason:error.status===409?error.message:'契约检查未能确认，未放行'});}
  }
  const decision=checks.length>0&&checks.every(c=>c.status==='PASSED')?'ALLOW':'BLOCK';
  const receipt=store.create('service_contract_gate_decision',project,{serviceId:service.id,serviceVersionId:target.id,serviceConfigHash:target.configHash,action,scope:target.scope,decision,configured:true,bindingStateHash:configHash,
   sourceFingerprint:serviceHash(sources.sort((a,b)=>a.versionId.localeCompare(b.versionId))),checks,checkedAt:new Date(now()).toISOString(),notice:'只证明本次冻结来源的字段、必填与所选时间依据，不替代金融口径断言；下次发布或切换重新检查'});
  if(decision==='BLOCK'){const error=fail('数据契约门禁阻断：'+(checks.find(c=>c.status!=='PASSED')?.reason??'证据未确认'));error.gateDecisionId=receipt.id;throw error;}
  return receipt;
 }
 const api={
  list(serviceId,{versionId}={}){
   if(!read('data_service',serviceId))throw fail('未找到数据服务','SERVICE_NOT_FOUND');
   const target=versionId===undefined?undefined:read('data_service_version',versionId);
   if(versionId!==undefined&&(!uuid(versionId)||!target||target.serviceId!==serviceId||!serviceVersionConfigValid(target)))throw fail('门禁查询版本与服务不一致或配置未确认','CONTRACT_GATE_VERSION_MISMATCH');
   return{serviceId,...(target?{serviceVersion:{id:target.id,configHash:target.configHash}}:{}),bindingStateHash:stateHash(serviceId),bindings:bindingsFor(serviceId).map(detail),decisions:store.list('service_contract_gate_decision',project).filter(d=>d.serviceId===serviceId&&(!target||d.serviceVersionId===target.id)).slice(0,30),notice:'历史放行不代表当前时效，发布与切换将重新检查；发布完成时间不代表行情或业务日新鲜度'};
  },
  create(serviceId,input,actor){
   const service=read('data_service',serviceId);if(!service)throw fail('未找到数据服务','SERVICE_NOT_FOUND');
   if(!uuid(input.contractId))throw Object.assign(Error('需要契约编号'),{status:422});if(bindingsFor(serviceId).length>=10)throw fail('每个服务最多绑定10个契约');
   if(bindingsFor(serviceId).some(b=>b.contractId===input.contractId))throw fail('此契约已绑定，请更新原门禁版本');
   const contract=contracts.detail(input.contractId),config=configuration('pending',1,contract,input),b=store.create('service_contract_gate',project,{serviceId,contractId:contract.id,createdBy:actor,status:'ENFORCED'});
   const value={...config,bindingId:b.id},v=store.create('service_contract_gate_version',project,{...value,configHash:serviceHash(value),createdBy:actor});store.update('service_contract_gate',b.id,project,{currentVersionId:v.id});return detail(read('service_contract_gate',b.id));
  },
  update(serviceId,bindingId,input,actor){
   const b=read('service_contract_gate',bindingId);if(!b||b.serviceId!==serviceId)throw fail('未找到此服务的门禁');
   if(b.version!==input.expectedBindingVersion)throw fail('门禁已被更新，请重新读取','CONTRACT_GATE_STALE_BINDING');
   if(typeof input.changeReason!=='string'||input.changeReason.trim().length<4||input.changeReason.length>300)throw Object.assign(Error('请说明门禁变更理由（4—300字）'),{status:422});
   const value=configuration(b.id,version(b).versionNumber+1,contracts.detail(b.contractId),input),v=store.create('service_contract_gate_version',project,{...value,configHash:serviceHash(value),createdBy:actor});
   store.update('service_contract_gate',b.id,project,{currentVersionId:v.id},{expectedVersion:input.expectedBindingVersion});return detail(read('service_contract_gate',b.id));
  },
  evaluate,
  verifyPrepared({service,version:target,dataVersions,receipt,action}){
   const current=stateHash(service.id);if(receipt?.decision==='NOT_CONFIGURED'&&!bindingsFor(service.id).length)return receipt;
   const stored=receipt?.id?read('service_contract_gate_decision',receipt.id):undefined;
   if(!stored||stored.decision!=='ALLOW'||stored.serviceId!==service.id||stored.serviceVersionId!==target.id||stored.serviceConfigHash!==target.configHash||stored.action!==action||stored.bindingStateHash!==current||now()-Date.parse(stored.checkedAt)>30_000||now()<Date.parse(stored.checkedAt))throw fail('门禁预检或版本已变化，请重新审阅后执行','CONTRACT_GATE_PREFLIGHT_CHANGED');
   const sources=[...new Map(dataVersions.map(v=>[v.id,v])).values()].map(v=>({versionId:v.id,fingerprint:evidenceFor(v).fingerprint})).sort((a,b)=>a.versionId.localeCompare(b.versionId));
   if(serviceHash(sources)!==stored.sourceFingerprint)throw fail('门禁预检后源数据已变化','CONTRACT_GATE_PREFLIGHT_CHANGED');return stored;
  },
 };
 api.submit=(serviceId,bindingId,input,actor,key)=>{
  key=requestKey(key);const operation=bindingId?'VERSION':'CREATE';
  const d=store.deduplicate(writeKey(serviceId,actor,key),serviceHash({operation,bindingId:bindingId??null,input}),()=>{
   const result=bindingId?api.update(serviceId,bindingId,input,actor):api.create(serviceId,input,actor);
   return store.create('service_contract_gate_write',project,{serviceId,bindingId:result.id,requestId:key,actorId:actor,operation,bindingRevisionAtApply:result.version,appliedVersion:result.currentVersion});
  });
  return writeView(read('service_contract_gate_write',d.id),d.replayed);
 };
 api.lookup=(serviceId,actor,key)=>{
  key=requestKey(key);const id=store.deduplicatedId(writeKey(serviceId,actor,key));return writeView(id?read('service_contract_gate_write',id):undefined,true);
 };
 return api;
}
