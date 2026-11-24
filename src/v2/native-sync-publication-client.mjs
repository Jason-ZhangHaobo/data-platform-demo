import {nativeSyncReviewPath,readNativeSyncReview} from './native-sync-review-client.mjs';
import {inputEvidenceCanonical} from './input-evidence-contract.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function publicationBinding(request){const {requestId,reviewId,syncRehearsalDigest,...binding}=request;nativeSyncReviewPath(binding);if(!uuid(requestId)||!uuid(reviewId)||!sha(syncRehearsalDigest))throw Error('本机发布须绑定原请求、本人文件审阅和演练摘要');return binding;}
export function nativeSyncReceiptPath(request){publicationBinding(request);const {taskId,requestId,...query}=request;return '/agent/tasks/'+taskId+'/sync-publication/requests/'+requestId+'?'+new URLSearchParams(query);}
export async function readNativeSyncPublication(client,request){
 const value=await client.request(nativeSyncReceiptPath(request)),m=value?.monitor,a=value?.approval;
 if(!exact(value,['protocol','scope','readOnly','binding','phase','publicDeployed','fullLifecycleE2E','evidenceDigest',...(a?['approval']:[]),...(m?['monitor']:[])])||value.protocol!=='shuduo-native-sync-publication/v1'||value.scope!=='LOCAL_TEST_RELEASE'||value.readOnly!==true||value.publicDeployed!==false||value.fullLifecycleE2E!==false||!exact(value.binding,Object.keys(request))||Object.keys(request).some(k=>value.binding[k]!==request[k])||!['NOT_FOUND','APPROVED','EXPIRED','RELEASED'].includes(value.phase)||
  (value.phase==='NOT_FOUND'?a!==undefined:!exact(a,['id','expiresAt'])||!uuid(a.id)||!Number.isFinite(Date.parse(a.expiresAt)))||
  (value.phase==='RELEASED'? !exact(m,['releaseId','status','health','businessDate','runs','monitorEventCount','openAlertCount','completed'])||!uuid(m.releaseId)||!['ACTIVE_LOCAL','CANCELLED'].includes(m.status)||!['HEALTHY','RESULT_UNKNOWN','FAILED','CANCELLED','OBSERVING'].includes(m.health)||!/^\d{4}-\d{2}-\d{2}$/.test(m.businessDate)||!Array.isArray(m.runs)||m.runs.length!==2||typeof m.completed!=='boolean'||!Number.isInteger(m.monitorEventCount)||m.monitorEventCount<0||!Number.isInteger(m.openAlertCount)||m.openAlertCount<0||m.runs.some((r,i)=>!exact(r,['id','sequence','status','scheduledTriggerAt','schedulerTriggered','resultUnknown',...(r.triggeredAt?['triggeredAt']:[]),...(r.finishedAt?['finishedAt']:[]),...(r.status==='SUCCEEDED'?['rowCount','regressionCount']:[])])||!uuid(r.id)||r.sequence!==i+1||!['SCHEDULED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED'].includes(r.status)||typeof r.schedulerTriggered!=='boolean'||typeof r.resultUnknown!=='boolean'||!Number.isFinite(Date.parse(r.scheduledTriggerAt))||r.triggeredAt!==undefined&&!Number.isFinite(Date.parse(r.triggeredAt))||r.finishedAt!==undefined&&!Number.isFinite(Date.parse(r.finishedAt))||r.status==='SUCCEEDED'&&(!r.schedulerTriggered||r.resultUnknown||!Number.isInteger(r.rowCount)||r.rowCount<0||r.regressionCount!==5))||(m.health==='HEALTHY')!==m.completed||m.completed!==(m.status==='ACTIVE_LOCAL'&&m.runs.every(r=>r.status==='SUCCEEDED'))||m.completed&&(m.health!=='HEALTHY'||m.openAlertCount!==0||m.monitorEventCount!==2):m!==undefined)||!sha(value.evidenceDigest))throw Error('本机发布回执或监控未能核对，请查询原请求');
 const {evidenceDigest,...body}=value,digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(inputEvidenceCanonical(body))))].map(v=>v.toString(16).padStart(2,'0')).join('');if(digest!==evidenceDigest)throw Error('本机发布回执摘要不一致');return value;
}
export async function submitNativeSyncPublication(client,request,{confirm=false,activateOnly=false}={}){
 if(confirm!==true||typeof activateOnly!=='boolean')throw Error('必须本人明确批准此版本的两批本机测试');
 let writeAttempted=false;try{
 const binding=publicationBinding(request),before=await readNativeSyncPublication(client,request);
 if(before.phase==='RELEASED')return before;if(before.phase==='EXPIRED')throw Error('原批准已到期，不能启动或自动重新批准');
 const fresh=await readNativeSyncReview(client,binding);
 if(!fresh.schedulerEnabled||fresh.review.status!=='REVIEWED'||fresh.review.id!==request.reviewId||fresh.evidence.syncRehearsalDigest!==request.syncRehearsalDigest)throw Error('原文件审阅、演练或本机调度条件已变化');
 if(before.phase==='NOT_FOUND'){
  if(activateOnly)throw Error('原批准尚未找到，不能激活');
  writeAttempted=true;await client.request('/delivery/packages/'+binding.packageId+'/approve',{method:'POST',idempotencyKey:request.requestId,body:{packageDigest:binding.packageDigest,reviewId:request.reviewId,expectedSyncRehearsalDigest:request.syncRehearsalDigest,syncConsent:{...fresh.consentBasis,confirmFrozenFictionalData:true}}});
 }
 const approved=await readNativeSyncPublication(client,request);if(approved.phase==='RELEASED')return approved;if(approved.phase!=='APPROVED')throw Error('原批准尚未确认或已到期，未激活');
 writeAttempted=true;await client.request('/releases',{method:'POST',idempotencyKey:request.requestId+'-activate',body:{approvalId:approved.approval.id,...fresh.consentBasis.scheduleSpec}});
 return await readNativeSyncPublication(client,request);
 }catch(cause){const error=cause instanceof Error?cause:Error('本机发布请求未确认');error.publicationWriteAttempted=writeAttempted;throw error;}
}
export function nativePublicationLocation(href,request){publicationBinding(request);const url=new URL(href);url.searchParams.set('sync_release',JSON.stringify(request));return url.pathname+url.search+url.hash;}
export function pendingNativePublication(href,binding){try{const url=new URL(href);if(url.searchParams.getAll('sync_release').length!==1)return;const raw=url.searchParams.get('sync_release');if(!raw||raw.length>2048)return;const r=JSON.parse(raw);const b=publicationBinding(r);if(Object.keys(b).some(k=>b[k]!==binding[k]))return;return r;}catch{return;}}
