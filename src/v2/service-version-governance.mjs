import { serviceHash } from './data-services.mjs';
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const only=(body,keys)=>{
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!keys.includes(k)))
    throw fail(422,'服务版本请求包含未支持字段','INVALID_SERVICE_VERSION_INPUT');
};
export function publishServiceReviewed(manager,serviceId,body){
  only(body,['configHash']);
  const service=manager.detail(serviceId);
  if(body.configHash!==service.currentVersion?.configHash)
    throw fail(409,'草稿版本摘要已变化，请重新审阅并测试','STALE_SERVICE_VERSION');
  return manager.publish(serviceId);
}

// Callers must authenticate and authorize the service before invoking this.
// A durable receipt distinguishes historical application from current state.
export function activateServiceReviewed({manager,store,project,serviceId,actorId,key,body}){
  only(body,['versionId','expectedPublishedVersionId','configHash']);
  if(typeof key!=='string'||key.length<1||key.length>100)
    throw fail(422,'缺少版本切换幂等键','IDEMPOTENCY_KEY_REQUIRED');
  const record=store.deduplicate(`${project}:service-switch:${manager.scope}:${actorId}:${serviceId}:${key}`,serviceHash(body),()=>{
    const current=manager.detail(serviceId),target=current.versions.find(v=>v.id===body.versionId);
    if(!target || body.configHash!==target.configHash || !body.expectedPublishedVersionId || body.expectedPublishedVersionId!==current.publishedVersionId)
      throw fail(409,'线上版本或目标摘要已变化，请重新审阅后切换','STALE_SERVICE_VERSION');
    manager.activate(serviceId,target.id);
    return store.create('service_version_switch',project,{serviceId,serviceType:current.serviceType,
      fromVersionId:current.publishedVersionId,toVersionId:target.id,targetConfigHash:target.configHash,
      performedBy:actorId,scope:manager.scope,status:'APPLIED'});
  });
  const receipt=store.get('service_version_switch',record.id,project),service=manager.detail(serviceId);
  return{receipt,service,replayed:Boolean(record.replayed),
    targetStillActive:service.publishedVersionId===receipt.toVersionId};
}
