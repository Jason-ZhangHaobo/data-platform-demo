const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function invitedChatScreen(href:string,developmentOnly:boolean):'start'|'task'|undefined {
  const query=new URL(href).searchParams;
  if(query.has('agent_request'))return 'start';
  if([...query.keys()].some(k=>k==='task'||k.startsWith('invited_')))return 'task';
  if(developmentOnly && (query.size===0 || (query.size===1 && query.get('module')==='agent-center')))return 'start';
}

// A pending native creation carries only its original request key. Reject
// mixed task, derived-source and planner URLs instead of opening a blank form.
export function invitedPendingRequest(href:string):string|null|undefined {
  const query=new URL(href).searchParams;
  if(!query.has('agent_request'))return;
  const key=query.get('agent_request');
  return query.size===2 && query.get('module')==='agent-center' && key && uuid.test(key)?key:null;
}

export function invitedChatStartLocation(href:string,planning=false) {
  const url=new URL(href);
  url.search='';url.hash='agent-chat';
  url.searchParams.set('module','agent-center');
  if(planning)url.searchParams.set('view','planning');
  return url;
}

export function invitedWindowTaskLocation(href:string,taskId?:string) {
  if(!taskId||!uuid.test(taskId))return;
  const url=invitedChatStartLocation(href);
  url.searchParams.set('task',taskId);
  return url;
}

type Context={id:string;name:string;definition:string;capabilities?:{agentDevelopment?:boolean;scope?:string;fundPreparation?:boolean}};
export type InvitedStartWindow={developmentOnly:boolean;taskOnly:boolean;requestOnly:boolean;canWrite:boolean;ready:boolean;
  startsAt?:string;expiresAt?:string;sessionExpiresAt?:string;windowTaskId?:string;used?:boolean;backgroundAvailable:boolean;contexts:Context[];
  deliverySupported?:boolean;targetTaskId?:string;publicationSupported?:boolean;publicationTarget?:import('./AuthDialog').PublicationTarget;
  consumptionSupported?:boolean;canConsume?:boolean;consumptionScope?:import('./service-consumption-window').ConsumptionScope};

export function invitedStartReason(authenticated:boolean,access:InvitedStartWindow|undefined,now=Date.now()){
  if(!authenticated)return '请使用本次受邀账号登录。';
  if(!access?.developmentOnly)return '当前为只读入口。';
  if(access.taskOnly)return '本次窗口仅允许续接指定的原任务。';
  if(access.requestOnly)return '本次窗口已绑定原创建请求，请从原请求入口继续。';
  const start=Date.parse(access.startsAt??''),end=Date.parse(access.expiresAt??''),sessionEnd=Date.parse(access.sessionExpiresAt??'');
  if(!Number.isFinite(start)||!Number.isFinite(end)||now<start||now>=end)return '本次受邀开发窗口尚未开放或已到期。';
  if(!Number.isFinite(sessionEnd)||now>=sessionEnd)return '会话已到期或尚未核实，请重新登录。';
  if(access.used||access.windowTaskId)return '本窗口的新任务名额已使用，请通过原任务链接查看。';
  if(!access.ready)return '等待开发上下文、模型与 Spark 就绪。';
  if(!access.canWrite)return '当前账号没有本窗口的开发权限。';
  if(!access.backgroundAvailable)return '签名后台尚未就绪，当前无法从对话委托开发。';
}
