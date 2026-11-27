const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const key = /^[A-Za-z0-9_-]{1,100}$/;
const pins = ['invited_context','invited_revision','invited_hash','invited_run'];
const deliveryFields=['invited_package_request','invited_rehearsal'];
const allowedFields=['module','task','invited_request',...pins,...deliveryFields];

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
  return selected && (![...pins,...deliveryFields].some(k=>q.has(k))||invitedEditorSource(href)) ? selected : null;
}
export function invitedEditorSource(href:string):InvitedEditorSource|null|undefined {
  const q=new URL(href).searchParams;
  if(![...pins,...deliveryFields].some(k=>q.has(k)))return;
  const selected=selectedTask(q),contextId=q.get('invited_context'),revisionId=q.get('invited_revision'),revisionHash=q.get('invited_hash'),runId=q.get('invited_run');
  if(!selected||[...q.keys()].some(k=>!allowedFields.includes(k))||
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
      for(const k of deliveryFields){const value=original.get(k);if(value)url.searchParams.set(k,value);}
    }
  }
  if(!invitedTaskSelection(url.href))throw Error('受邀任务链接不完整');
  return url;
}
export function clearInvitedEditorSource(url:URL){
  for(const p of [...pins,...deliveryFields,'invited_request'])url.searchParams.delete(p);
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
