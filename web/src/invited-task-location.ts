const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const key = /^[A-Za-z0-9_-]{1,100}$/;
const pins = ['invited_context','invited_revision','invited_hash','invited_run'];
const deliveryFields=['invited_package_request','invited_rehearsal'];
const approvalFields=['invited_approval','invited_review','invited_starts','invited_expires'];
const publicationFields=[...approvalFields,'invited_release'];
const consumptionFields=['invited_batch','invited_consume_request'];
const pinnedFields=[...pins,...deliveryFields,...publicationFields,...consumptionFields];
const allowedFields=['module','task','invited_request',...pinnedFields];
export type InvitedApprovalPin={requestId:string;reviewDigest:string;startsAt:string;expiresAt:string};
export function invitedPublicationPin(href:string):{approval?:InvitedApprovalPin;releaseId?:string}|null {
  const q=new URL(href).searchParams;
  if(!publicationFields.some(k=>q.has(k)))return {};
  const releaseId=q.get('invited_release');
  if(!uuid.test(q.get('invited_rehearsal')??'')||(releaseId!==null&&!uuid.test(releaseId))||
    publicationFields.some(k=>q.getAll(k).length>1))return null;
  let approval:InvitedApprovalPin|undefined;
  if(approvalFields.some(k=>q.has(k))){
    const requestId=q.get('invited_approval'),reviewDigest=q.get('invited_review'),startsAt=q.get('invited_starts'),expiresAt=q.get('invited_expires');
    if(!requestId||!/^approval-[a-f0-9]{64}$/.test(requestId)||!reviewDigest||!hash.test(reviewDigest)||
      !startsAt||!expiresAt||!(Date.parse(startsAt)<Date.parse(expiresAt))||new Date(startsAt).toISOString()!==startsAt||
      new Date(expiresAt).toISOString()!==expiresAt)return null;
    approval={requestId,reviewDigest,startsAt,expiresAt};
  }
  return {...(approval?{approval}:{}),...(releaseId?{releaseId}:{})};
}

export type InvitedTaskSelection = {taskId:string;requestId?:string};
export type InvitedEditorSource = InvitedTaskSelection & {contextId:string;revisionId:string;revisionHash:string;runId?:string};

function selectedTask(q:URLSearchParams):InvitedTaskSelection|null {
  const taskId=q.get('task'),requestId=q.get('invited_request');
  if(q.get('module')!=='agent-center'||!taskId||!uuid.test(taskId)||
    (requestId!==null&&!key.test(requestId))||new Set(q.keys()).size!==q.size)return null;
  return {taskId,...(requestId?{requestId}:{})};
}
export function invitedTaskSelection(href:string):InvitedTaskSelection|null {
  const q=new URL(href).searchParams;
  if([...q.keys()].some(k=>!allowedFields.includes(k)))return null;
  const selected=selectedTask(q);
  return selected && (!pinnedFields.some(k=>q.has(k))||invitedEditorSource(href)) ? selected : null;
}
export function invitedEditorSource(href:string):InvitedEditorSource|null|undefined {
  const q=new URL(href).searchParams;
  if(!pinnedFields.some(k=>q.has(k)))return;
  const selected=selectedTask(q),contextId=q.get('invited_context'),revisionId=q.get('invited_revision'),revisionHash=q.get('invited_hash'),runId=q.get('invited_run');
  if(!selected||[...q.keys()].some(k=>!allowedFields.includes(k))||
    !invitedPublicationPin(href)||consumptionFields.some(k=>q.has(k)&&!uuid.test(q.get(k)??''))||
    q.has('invited_batch')&&!q.has('invited_release')||q.has('invited_consume_request')&&!q.has('invited_batch')||
    deliveryFields.some(k=>q.has(k)&&(!runId||!uuid.test(q.get(k)??'')))||
    !contextId||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(contextId)||
    !revisionId||!uuid.test(revisionId)||!revisionHash||!hash.test(revisionHash)||(runId!==null&&!uuid.test(runId)))return null;
  return {...selected,contextId,revisionId,revisionHash,...(runId?{runId}:{})};
}
export function invitedEditorLocation(href:string,selection:InvitedTaskSelection,source?:InvitedEditorSource) {
  const url=new URL(href);url.search='';url.hash='agent-code';
  url.searchParams.set('module','agent-center');url.searchParams.set('task',selection.taskId);
  if(selection.requestId)url.searchParams.set('invited_request',selection.requestId);
  if(source){
    if(source.taskId!==selection.taskId||source.requestId!==selection.requestId)throw Error('编辑器来源与原任务不一致');
    url.searchParams.set('invited_context',source.contextId);url.searchParams.set('invited_revision',source.revisionId);
    url.searchParams.set('invited_hash',source.revisionHash);if(source.runId)url.searchParams.set('invited_run',source.runId);
    const old=invitedEditorSource(href);
    if(old&&old.taskId===source.taskId&&old.requestId===source.requestId&&old.contextId===source.contextId&&
      old.revisionId===source.revisionId&&old.revisionHash===source.revisionHash&&old.runId===source.runId){
      const original=new URL(href).searchParams;
      for(const k of [...deliveryFields,...publicationFields,...consumptionFields]){const value=original.get(k);if(value)url.searchParams.set(k,value);}
    }
  }
  if(!invitedTaskSelection(url.href))throw Error('受邀任务链接不完整');
  return url;
}
export function clearInvitedEditorSource(url:URL){
  for(const p of [...pinnedFields,'invited_request'])url.searchParams.delete(p);
  return url;
}

export function pinInvitedBatch(href:string,releaseId:string,batchIds:string[],batchId:string,requestId?:string){
  const url=new URL(href),q=url.searchParams;
  if(!invitedTaskSelection(href)||!uuid.test(releaseId)||q.get('invited_release')!==releaseId||
    batchIds.length!==2||new Set(batchIds).size!==2||!batchIds.every(id=>uuid.test(id))||!batchIds.includes(batchId)||
    requestId!==undefined&&!uuid.test(requestId))throw Error('所选批次或消费请求与原发布不符。');
  if(q.get('invited_batch')!==batchId)q.delete('invited_consume_request');
  q.set('invited_batch',batchId);
  if(requestId){
    if(q.has('invited_consume_request')&&q.get('invited_consume_request')!==requestId)throw Error('请先核对已保存的原消费请求。');
    q.set('invited_consume_request',requestId);
  }
  return url;
}

export function pinInvitedPublication(href:string,source:InvitedEditorSource,deliveryId:string,approval?:InvitedApprovalPin,releaseId?:string){
  const old=new URL(href).searchParams;
  if(old.has('invited_rehearsal')&&old.get('invited_rehearsal')!==deliveryId)throw Error('原链接指向另一交付。');
  const url=pinInvitedDelivery(href,source,'rehearse',deliveryId);
  if(approval){
    url.searchParams.set('invited_approval',approval.requestId);url.searchParams.set('invited_review',approval.reviewDigest);
    url.searchParams.set('invited_starts',approval.startsAt);url.searchParams.set('invited_expires',approval.expiresAt);
  }
  if(releaseId){
    if(old.has('invited_release') && old.get('invited_release')!==releaseId)throw Error('已保存的发布编号发生变化。');
    url.searchParams.set('invited_release',releaseId);
  }
  if(!invitedTaskSelection(url.href))throw Error('发布来源或原请求信息不完整。');
  return url;
}

export function pinInvitedDelivery(href:string,source:InvitedEditorSource,action:'prepare'|'rehearse',id:string){
  const selected=invitedTaskSelection(href),pin=invitedEditorSource(href);
  if(!uuid.test(id)||!source.runId||selected?.taskId!==source.taskId||selected.requestId!==source.requestId||
    pin&&(pin.contextId!==source.contextId||pin.revisionId!==source.revisionId||pin.revisionHash!==source.revisionHash||pin.runId!==source.runId))throw Error('交付链接与原任务不符');
  const url=invitedEditorLocation(href,source,source);
  url.searchParams.set(action==='prepare'?'invited_package_request':'invited_rehearsal',id);
  url.hash='agent-chat';
  return url;
}
