import {serviceHash} from './data-services.mjs';
import {servicePlanSourceBinding} from './service-plan-request.mjs';
import {modelSettings} from './model.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const money=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=(code,message,status=403)=>Object.assign(Error(message),{status,code});
export const privateServiceAgentMode='DURABLE_PRIVATE_SERVICE_AGENT_V1';
export const serviceAgentMonth=now=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).formatToParts(new Date(now));return parts.find(part=>part.type==='year').value+'-'+parts.find(part=>part.type==='month').value;};

// Trusted operator configuration only. No request body can activate this scope.
export function privateServiceAgentProfile(env){
 if(env.V2_PRIVATE_SERVICE_AGENT_PROFILE===undefined||env.V2_PRIVATE_SERVICE_AGENT_PROFILE==='')return;
 try{
  if(env.V2_LOCAL_DEVELOPMENT!=='false'||env.V2_PRIVATE_SMOKE_ENABLED!=='true'||env.V2_PRIVATE_DATA_SERVICES_ENABLED!=='true'||
   env.V2_FC_PUBLIC_READ_ONLY==='false'||env.V2_FC_PUBLIC_WRITE_SCOPE||typeof env.V2_PRIVATE_SERVICE_AGENT_PROFILE!=='string'||env.V2_PRIVATE_SERVICE_AGENT_PROFILE.length>4096)throw Error();
  const value=JSON.parse(env.V2_PRIVATE_SERVICE_AGENT_PROFILE);
  if(!exact(value,['id','actorId','sourceBinding','startsAt','expiresAt','maxPlans','maxModelCalls','requestTokenLimit','tokenBudget','maxModelCostCny','bill'])||
   !uuid(value.id)||!uuid(value.actorId)||!date(value.startsAt)||!date(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.startsAt)||Date.parse(value.expiresAt)-Date.parse(value.startsAt)>7200000||
   !integer(value.maxPlans,1,3)||!integer(value.maxModelCalls,1,3)||!integer(value.requestTokenLimit,1024,24000)||!integer(value.tokenBudget,value.requestTokenLimit,24000)||!money(value.maxModelCostCny,0.01,5)||
   !exact(value.bill,['month','observedAt','spendCny','unsettledReserveCny'])||!/^\d{4}-\d{2}$/.test(value.bill.month)||!date(value.bill.observedAt)||
   !money(value.bill.spendCny,0,200)||!money(value.bill.unsettledReserveCny,0,200))throw Error();
  value.sourceBinding=servicePlanSourceBinding(value.sourceBinding);
  const settings=modelSettings(env),endpoint=new URL(settings.baseUrl);
  if(typeof settings.model!=='string'||!/^[A-Za-z0-9_.:/-]{1,100}$/.test(settings.model)||endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error();
  const {bill,...boundary}=value;
  // A trusted bill refresh may update observed spend/time, but cannot renew a
  // window, lower its unsettled reserve or reset calls/tokens under the same id.
  const endpointHash=serviceHash(endpoint.href.replace(/\/$/,'')),model=settings.model;
  const profile={...value,scope:'PRIVATE_SERVICE_AGENT_PLANNING',model,endpointHash,fingerprint:serviceHash({...boundary,billMonth:bill.month,unsettledReserveCny:bill.unsettledReserveCny,model,endpointHash})};
  // Copy before freezing so neither caller nor a mutable env object can change
  // an in-flight profile. A changed profile needs a different reviewed identity.
  const freeze=v=>{for(const child of Object.values(v))if(child&&typeof child==='object')freeze(child);return Object.freeze(v);};
  return freeze(profile);
 }catch{throw Error('PRIVATE_SERVICE_AGENT_PROFILE_INVALID');}
}

export function assertServiceAgentActor(config,actorId,store,project){
 const actor=store.get('auth_user',actorId,project),role=actor?.memberships?.find(item=>item.projectId===project)?.role;
 if(!config||actorId!==config.actorId||actor?.status!=='ACTIVE'||!['ADMIN','ENGINEER','PRODUCT_MANAGER'].includes(role))
  throw fail('SERVICE_AGENT_ACTOR_DENIED','当前账号未获准执行此服务规划');
 return {user:actor,role};
}
export function assertServiceAgentIngress(config,ingress){
 if(config&&(ingress?.status?.mode!=='FC_CONTROL_PATH'||ingress.status.publicReadOnly!==true))
  throw Error('PRIVATE_SERVICE_AGENT_READONLY_INGRESS_REQUIRED');
}
export function serviceAgentSession(config,identity,store,project,now=Date.now()){
 if(!config)return;
 let selected=false;try{assertServiceAgentActor(config,identity?.user?.id,store,project);selected=true;}catch{}
 const windows=store.list('service_agent_window',project).filter(item=>item.profileId===config.id),
  reason=windows.length>1||windows[0]&&windows[0].fingerprint!==config.fingerprint?'BOUNDARY_CHANGED':now<Date.parse(config.startsAt)?'NOT_STARTED':now>=Date.parse(config.expiresAt)?'EXPIRED':undefined;
 return {servicePlanningOnly:true,readOnly:!selected,permissions:selected?['SESSION','SERVICES']:['SESSION'],
  servicePlanning:selected?{enabled:reason===undefined,...(reason?{reason}:{}),id:config.id,sourceBinding:config.sourceBinding,model:config.model,
   startsAt:config.startsAt,expiresAt:config.expiresAt,maxPlans:config.maxPlans,maxModelCalls:config.maxModelCalls,tokenBudget:config.tokenBudget}:{enabled:false}};
}
export function assertServiceAgentWindow(config,now){
 if(!config||!Number.isFinite(now)||now<Date.parse(config.startsAt)||now>=Date.parse(config.expiresAt))
  throw fail('SERVICE_AGENT_WINDOW_CLOSED','私有服务规划窗口未开放或已到期；原任务仍可读取或取消');
}
export function assertServiceAgentBill(config,now,overview,reservedCostCny){
 const bill=config.bill,observed=Date.parse(bill.observedAt);
 if(bill.month!==serviceAgentMonth(now)||observed>now||now-observed>1800000||overview.account.observedSpendCny===undefined||
  !Number.isFinite(overview.account.observedSpendCny))throw fail('SERVICE_AGENT_BILL_STALE','当前月完整账单快照未就绪或已过期，未发送模型请求',429);
 const spend=Math.max(bill.spendCny,overview.account.observedSpendCny);
 // Adding the monthly model estimate can double-count already billed usage;
 // this deliberately stops early rather than dropping unsettled reservations.
 if(spend+bill.unsettledReserveCny+overview.model.estimatedCostCny+reservedCostCny>Math.min(200,overview.hardLimitCny))
  throw fail('MONTHLY_HARD_BUDGET_EXCEEDED','完整账单、未结算预留和模型最坏估算将超过月预算，未发送模型请求',429);
}
export function assertServiceAgentMutation(config,session,method,path){
 if(!config||method==='GET'||method==='POST'&&['/api/v2/auth/login','/api/v2/auth/logout','/api/v2/auth/password'].includes(path))return;
 const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
 const allowed=path==='/api/v2/data-services/agent/plans'||new RegExp(`^/api/v2/data-services/agent/plans/${uuid}/(advance|apply|cancel)$`).test(path);
 if(method!=='POST'||!allowed||session?.user?.id!==config.actorId)
  throw fail('PRIVATE_SERVICE_AGENT_SCOPE_DENIED','本窗口仅允许指定来源的服务规划与草稿确认；开发计算、发布、凭证和其他写入保持关闭');
}
