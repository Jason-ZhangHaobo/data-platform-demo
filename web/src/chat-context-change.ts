import {contextDerivationBody} from './agent-context-derivation.ts';
import {readChatSqlDevelopment,sameChatSqlBinding,type ChatSqlBinding} from './chat-sql-development.ts';

export type ChangeApi=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Scope={id:string;name:string;definition:string};
export type ChangeTarget=Scope & {recommended:boolean};
export type ChatChange={
  requestId:string; taskId:string; contextId:string; message:string; status:string;
  revisionId?:string; runId?:string; revisionHash?:string;
};
export type Changes={
  protocol:'shuduo-chat-sql-changes/v1'; binding:ChatSqlBinding; source:Scope; targets:ChangeTarget[];
  eligible:boolean; reason?:string; nextRequestId:string|null; changes:ChatChange[];
};
export type ChangeReview={binding:ChatSqlBinding;source:Scope;target:ChangeTarget;message:string;requestId:string};
const obj=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const digest=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const key=(x:unknown)=>typeof x==='string'&&/^chat-derive-v1-[a-f0-9]{64}$/.test(x);
const identifier=(x:unknown)=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,127}$/.test(x);
const text=(x:unknown,max:number)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const scope=(x:unknown)=>obj(x)&&identifier(x.id)&&text(x.name,200)&&text(x.definition,2000);
const invalid=()=>Error('口径变更的来源或请求回执无法核对，请重新读取原对话。');
export const changeIsRunning=(status:string)=>status==='QUEUED'||status==='RUNNING';
export function recommendedTarget(targets:ChangeTarget[]) {
  const candidates=targets.filter(t=>t.recommended);
  return candidates.length===1 ? candidates[0].id : '';
}

export async function readChanges(api:ChangeApi,intentId:string,taskId:string):Promise<Changes>{
  if(!uuid(intentId)||!uuid(taskId))throw invalid();
  const v=await api<unknown>('/agent/intents/'+intentId+'/development/changes');
  if(!obj(v)||v.protocol!=='shuduo-chat-sql-changes/v1'||!obj(v.binding)||
    v.binding.intentId!==intentId||v.binding.taskId!==taskId||!uuid(v.binding.revisionId)||
    !uuid(v.binding.runId)||!digest(v.binding.revisionHash)||!identifier(v.binding.contextId)||
    !scope(v.source)||(v.source as Scope).id!==v.binding.contextId||typeof v.eligible!=='boolean'||
    v.reason!==undefined&&!text(v.reason,1000)||v.nextRequestId!==null&&!key(v.nextRequestId)||
    !Array.isArray(v.targets)||!Array.isArray(v.changes))throw invalid();
  const snapshot=v as unknown as Changes;
  if(snapshot.targets.some(t=>!scope(t)||typeof t.recommended!=='boolean'||t.id===snapshot.source.id)||
    new Set(snapshot.targets.map(t=>t.id)).size!==snapshot.targets.length)throw invalid();
  for(const change of snapshot.changes){
    if(!obj(change)||!key(change.requestId)||!uuid(change.taskId)||change.taskId===taskId||
      !identifier(change.contextId)||change.contextId===snapshot.source.id||!text(change.message,2000)||
      !/^[A-Z][A-Z_]{1,79}$/.test(change.status)||change.revisionId!==undefined&&!uuid(change.revisionId)||
      change.runId!==undefined&&!uuid(change.runId)||change.revisionHash!==undefined&&!digest(change.revisionHash))throw invalid();
  }
  if(new Set(snapshot.changes.map(c=>c.requestId)).size!==snapshot.changes.length||
    new Set(snapshot.changes.map(c=>c.taskId)).size!==snapshot.changes.length||
    snapshot.changes.some(c=>c.requestId===snapshot.nextRequestId))throw invalid();
  return snapshot;
}

export function reviewChange(snapshot:Changes,targetId:string,input:string):ChangeReview {
  const target=snapshot.targets.find(t=>t.id===targetId),message=input.trim();
  if(!snapshot.eligible||!snapshot.nextRequestId||!target||message.length<4||message.length>2000)
    throw Error('请选择可用的目标口径，并描述修改需求。');
  return {binding:snapshot.binding,source:snapshot.source,target,message,requestId:snapshot.nextRequestId};
}

export function acceptedChange(snapshot:Changes,review:ChangeReview) {
  if(!sameChatSqlBinding(snapshot.binding,review.binding))throw invalid();
  const existing=snapshot.changes.find(c=>c.requestId===review.requestId);
  if(existing&&(existing.message!==review.message||existing.contextId!==review.target.id))
    throw Error('这个请求编号已登记了另一项修改，请查看原会话中的变更记录。');
  return existing;
}

export async function submitReviewedChange(api:ChangeApi,review:ChangeReview,isCurrent:()=>boolean,onPost?:()=>void){
  const b=review.binding;
  const snapshot=await readChanges(api,b.intentId,b.taskId);
  if(acceptedChange(snapshot,review)||!isCurrent())return;
  const target=snapshot.targets.find(t=>t.id===review.target.id);
  if(!target||!snapshot.eligible||snapshot.nextRequestId!==review.requestId||
    snapshot.source.definition!==review.source.definition||target.definition!==review.target.definition||
    target.name!==review.target.name||snapshot.source.name!==review.source.name)throw Error('来源、目标口径或请求编号已变化，请重新审阅。');
  const proof=await readChatSqlDevelopment(api,b.intentId,b);
  if(proof.taskStatus!=='SUCCEEDED'||proof.runStatus!=='SUCCEEDED'||proof.validation.state!=='PASSED'||
    !proof.validation.contractId)throw Error('原 SQL 运行或独立断言尚未核实。');
  if(!isCurrent())return;
  const source={kind:'REGISTERED_CONTEXT_CHANGE' as const,taskId:b.taskId,revisionId:b.revisionId,revisionHash:b.revisionHash,runId:b.runId};
  const body=contextDerivationBody({source,targetContextId:target.id},
    {source,contextId:b.contextId,validationContractId:proof.validation.contractId,sql:proof.sql},review.message);
  onPost?.();
  await api('/agent/tasks',{...body,language:'SPARK_SQL',chatChange:{intentId:b.intentId}},{idempotencyKey:review.requestId});
}
