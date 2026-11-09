export const sqlClarificationProtocol='shuduo-sql-clarification/v1';
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const clarificationUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
export function validSqlClarification(value){
 return Boolean(exact(value,['protocol','originalTaskId','originalRequest','contextId','sourceSqlHash','turns','depth','digest'])&&
  value.protocol===sqlClarificationProtocol&&clarificationUuid(value.originalTaskId)&&text(value.originalRequest,2000)&&text(value.contextId,80)&&hash(value.sourceSqlHash)&&hash(value.digest)&&
  Number.isSafeInteger(value.depth)&&value.depth>=1&&value.depth<=3&&Array.isArray(value.turns)&&value.turns.length===value.depth&&
  value.turns[0]?.taskId===value.originalTaskId&&new Set(value.turns.map(t=>t?.taskId)).size===value.depth&&value.turns.every(t=>
   exact(t,['taskId','sourceDigest','question','answer','usedTokens','usageEstimated','attemptCount'])&&clarificationUuid(t.taskId)&&hash(t.sourceDigest)&&text(t.question,300)&&text(t.answer,1000)&&
   Number.isSafeInteger(t.usedTokens)&&t.usedTokens>=0&&t.usedTokens<=1000000000&&typeof t.usageEstimated==='boolean'&&Number.isSafeInteger(t.attemptCount)&&t.attemptCount>=1&&t.attemptCount<=3));
}
export function clarificationAttribution(task){
 const originalTaskId=task?.clarification?.originalTaskId??task?.clarificationOriginTaskId;
 return task?.clarification!==undefined||task?.humanClarified===true?{humanClarified:true,directAutonomousEligible:false,clarificationOriginTaskId:originalTaskId}:{};
}
export function clarificationReplyReason(task){
 if(task?.stage!=='REQUIREMENT_CLARIFICATION_REQUIRED')return '当前任务没有可答复的澄清问题。';
 if(task.sourceKind==='MANUAL'||[task.sourceAttribution,task.manualContinuation,task.assistedContinuation,task.repairComparison,task.sourceRunId,task.derivedFrom].some(v=>v!==undefined))return '此来源暂不支持原问题续接；请保留历史并新建完整需求。';
 if((task.clarification?.depth??0)>=3)return '已保留三轮澄清，请整理已确认需求后新建任务。';
 if(typeof(task.sql??task.initialSql)!=='string'||!(task.sql??task.initialSql).trim())return '原任务未保存代码输入，不能猜造原输入；请保留历史并新建完整需求。';
 return undefined;
}
export function clarificationReceiptMatches(task,body){
 if(body?.clarification===undefined&&task?.clarification===undefined)return true;
 const c=task?.clarification;if(!validSqlClarification(c)||!clarificationUuid(task.id)||c.turns.some(t=>t.taskId===task.id)||
  task.humanClarified!==true||task.directAutonomousEligible!==false||task.clarificationOriginTaskId!==c.originalTaskId||task.contextId!==c.contextId||
  task.message!==c.turns.at(-1).answer||typeof task.initialSql!=='string')return false;
 if(body!==undefined&&(!body||typeof body!=='object'||!body.clarification))return false;
 return body===undefined||task.initialSql===body.sql&&task.message===body.message&&task.contextId===body.contextId&&
  c.turns.at(-1).taskId===body.clarification.taskId&&c.turns.at(-1).sourceDigest===body.clarification.evidenceDigest;
}
