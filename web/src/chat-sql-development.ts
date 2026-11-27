export type ChatSqlBinding = {
  intentId:string;
  taskId:string;
  contextId:string;
  revisionId:string;
  runId:string;
  revisionHash:string;
};

export type ChatSqlDevelopment = {
  protocol:'shuduo-chat-sql-development/v1';
  binding:ChatSqlBinding;
  sql:string;
  codeSource:'SYNTHETIC_MODEL'|'RECORDED_MODEL'|'UNCONFIRMED';
  taskStatus:string;
  runStatus:string;
  engine:string|null;
  engineVersion:string|null;
  testDouble:boolean|null;
  attempts:{attempt:number;status:string;revisionId?:string;runId?:string;failedChecks?:string[]}[];
  validation:{
    state:'PASSED'|'FAILED'|'UNCONFIRMED';
    contractId:string|null;
    regressions:{contextId:string;name?:string;passed:boolean}[];
  };
};

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v);
const optionalText=(v:unknown)=>v===null||typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f\u007f]/.test(v);
const mismatch=()=>Error('当前回执与原对话、代码版本或运行记录不一致。');
const bindingFields=['intentId','taskId','contextId','revisionId','runId','revisionHash'] as const;
export const sameChatSqlBinding=(a:ChatSqlBinding,b:ChatSqlBinding)=>bindingFields.every(key=>a[key]===b[key]);

export async function readChatSqlDevelopment(
  api:<T>(path:string)=>Promise<T>,
  intentId:string,
  expected?:ChatSqlBinding,
):Promise<ChatSqlDevelopment> {
  if(!uuid(intentId)||expected&&expected.intentId!==intentId)throw mismatch();
  const value=await api<unknown>('/agent/intents/'+intentId+'/development');
  if(!object(value)||value.protocol!=='shuduo-chat-sql-development/v1')throw mismatch();
  const binding=value.binding;
  if(!object(binding)||binding.intentId!==intentId||!uuid(binding.taskId)||!uuid(binding.revisionId)||
      !uuid(binding.runId)||!identifier(binding.contextId)||typeof binding.revisionHash!=='string'||
      !/^[0-9a-f]{64}$/.test(binding.revisionHash))throw mismatch();
  if(typeof value.sql!=='string'||!value.sql.trim()||value.sql.length>20000||
      !['RECORDED_MODEL','SYNTHETIC_MODEL','UNCONFIRMED'].includes(String(value.codeSource))||
      !['SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED','INTERRUPTED'].includes(String(value.taskStatus))||
      !['SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED'].includes(String(value.runStatus))||
      !optionalText(value.engine)||!optionalText(value.engineVersion)||
      value.testDouble!==null&&typeof value.testDouble!=='boolean')throw mismatch();

  const attempts=value.attempts;
  if(!Array.isArray(attempts)||!attempts.length||attempts.some(a=>
    !object(a)||!Number.isSafeInteger(a.attempt)||Number(a.attempt)<1||!identifier(a.status)||
    a.runId!==undefined&&!uuid(a.runId)||a.revisionId!==undefined&&!uuid(a.revisionId)||
    a.failedChecks!==undefined&&(!Array.isArray(a.failedChecks)||a.failedChecks.some(label=>typeof label!=='string'||!optionalText(label)))
  ))throw mismatch();
  const last=attempts.at(-1);
  if(last.runId!==binding.runId||last.revisionId!==binding.revisionId||last.status!==value.runStatus||
      new Set(attempts.map(a=>a.attempt)).size!==attempts.length)throw mismatch();

  const validation=value.validation;
  if(!object(validation)||!['PASSED','FAILED','UNCONFIRMED'].includes(String(validation.state))||
      validation.contractId!==null&&!identifier(validation.contractId)||!Array.isArray(validation.regressions))throw mismatch();
  if(validation.regressions.some(r=>!object(r)||!identifier(r.contextId)||typeof r.passed!=='boolean'||
      r.name!==undefined&&(typeof r.name!=='string'||!optionalText(r.name))))throw mismatch();
  if(validation.state==='PASSED'&&(value.runStatus!=='SUCCEEDED'||validation.regressions.some(r=>!r.passed)))throw mismatch();

  const result=value as unknown as ChatSqlDevelopment;
  if(expected&&!sameChatSqlBinding(result.binding,expected))throw mismatch();
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.sql));
  const hash=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==result.binding.revisionHash)throw mismatch();
  return result;
}

export async function recordChatSqlTakeover(
  api:<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>,
  binding:ChatSqlBinding,
  isCurrent:()=>boolean,
) {
  await readChatSqlDevelopment(api,binding.intentId,binding);
  if(!isCurrent())return false;
  const path='/agent/intents/'+binding.intentId+'/handoffs';
  const confirmed=(receipt:unknown)=>object(receipt)&&uuid(receipt.id)&&receipt.intentId===binding.intentId&&
    receipt.destinationId==='development'&&receipt.status==='HANDED_OFF'&&!receipt.specialistTaskId;
  try{
    const saved=await api(path,{destinationId:'development'},{idempotencyKey:'chat-editor-'+binding.intentId});
    if(confirmed(saved))return isCurrent();
  }catch(error){
    const status=(error as {status?:number})?.status;
    if(status&&status>=400&&status<500)throw error;
  }
  // The write may have succeeded. Read the original human handoff without
  // resubmitting; the specialist binding has a different record on this list.
  if(!isCurrent())return false;
  const saved=await api<unknown>(path);
  if(!Array.isArray(saved)||!saved.some(confirmed))throw Error('人工接管记录尚未确认，请重新核对后打开原版本。');
  return isCurrent();
}
