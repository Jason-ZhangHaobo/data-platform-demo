import {getContext} from './context.mjs';
import {verifiedSqlRequirementReport,sqlRequirementBasis} from './sql-requirements.mjs';
import {clarificationHash,verifiedSqlClarification,appendSqlClarification} from './sql-clarification-snapshot.mjs';
import {sqlClarificationProtocol,clarificationUuid} from './sql-clarification-contract.mjs';
const fail=(code='CLARIFICATION_SOURCE_CHANGED',message='原澄清问题、输入或归属已变化；保留原任务和回答，不自动重试',status=409)=>Object.assign(Error(message),{code,status});
export function readSqlClarificationSource({store,project,taskId,actorId}){
 if(!clarificationUuid(taskId))throw fail('CLARIFICATION_INPUT_INVALID','澄清任务编号不合法',422);
 const parent=store.get('agent',taskId,project);
 if(!parent)throw fail('CLARIFICATION_SOURCE_NOT_FOUND','未找到当前项目的原澄清任务',404);
 if(!actorId||parent.submittedBy!==actorId)throw fail('CLARIFICATION_SOURCE_OWNER','仅原任务创建者可回答此澄清问题',403);
 if(parent.syncInput)throw fail('CLARIFICATION_SYNC_INPUT_UNSUPPORTED','同步批次的多轮澄清尚未接入，请整理完整需求后显式选择批次');
 const r=parent.requirements,last=parent.attempts?.at(-1),sql=parent.sql??parent.initialSql;
 if(parent.language!=='SPARK_SQL'||parent.mode!=='LIVE_MODEL'||parent.status!=='FAILED'||parent.stage!=='REQUIREMENT_CLARIFICATION_REQUIRED'||
  parent.sourceKind==='MANUAL'||[parent.sourceAttribution,parent.manualContinuation,parent.assistedContinuation,parent.repairComparison,parent.sourceRunId,parent.derivedFrom].some(v=>v!==undefined)||
  r?.status!=='CLARIFICATION_REQUIRED'||r.attempt!==parent.attempts.length||last?.status!=='REQUIREMENT_CLARIFICATION_REQUIRED'||last.computationSkipped!==true||
  !Number.isSafeInteger(parent.usedTokens)||parent.usedTokens<0||parent.usedTokens>1000000000||parent.attempts.length>3||typeof sql!=='string'||!sql.trim()||sql.length>20000||!verifiedSqlRequirementReport(r,parent)||
  parent.clarification!==undefined&&!verifiedSqlClarification(parent.clarification,parent))throw fail();
 if((parent.clarification?.depth??0)>=3)throw fail('CLARIFICATION_DEPTH_LIMIT','当前最多保留三轮澄清；请整理已确认需求后显式新建任务');
 const context=getContext(parent.contextId);if(!context)throw fail();
 const basis=sqlRequirementBasis(parent.message,context,parent.clarification);
 if(clarificationHash(basis)!==clarificationHash(r.basis))throw fail();
 const evidenceDigest=clarificationHash({taskId:parent.id,actorId:parent.submittedBy,projectId:parent.projectId,contextId:parent.contextId,message:parent.message,
  sqlHash:clarificationHash(sql),requirementDigest:clarificationHash(r),usedTokens:parent.usedTokens,attempts:parent.attempts,clarificationDigest:parent.clarification?.digest??null});
 return {protocol:sqlClarificationProtocol,binding:{taskId:parent.id,evidenceDigest},contextId:parent.contextId,sql,
  question:r.interpretation.question,originalRequest:parent.clarification?.originalRequest??parent.message,depth:parent.clarification?.depth??0,
  historicalTokens:(parent.clarification?.turns??[]).reduce((n,t)=>n+t.usedTokens,0)+parent.usedTokens};
}
export function resolveSqlClarification({store,project,actorId,binding,contextId,currentSql,answer}){
 if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==2||!['taskId','evidenceDigest'].every(k=>Object.hasOwn(binding,k))||!clarificationUuid(binding.taskId)||
  typeof binding.evidenceDigest!=='string'||!/^[a-f0-9]{64}$/.test(binding.evidenceDigest)||typeof answer!=='string'||!answer.trim()||answer.length>1000)throw fail('CLARIFICATION_INPUT_INVALID','回答须为1—1000字并绑定原问题摘要',422);
 const source=readSqlClarificationSource({store,project,taskId:binding.taskId,actorId});
 if(source.binding.evidenceDigest!==binding.evidenceDigest||source.contextId!==contextId||source.sql!==currentSql)throw fail();
 return appendSqlClarification(store.get('agent',binding.taskId,project),source,answer);
}
export function assertSqlClarificationTask(task,{store,project}){
 if(task.clarification===undefined)return;
 const c=task.clarification,last=c.turns?.at(-1);
 if(!verifiedSqlClarification(c,task)||clarificationHash(task.initialSql)!==c.sourceSqlHash)throw fail();
 const resolved=resolveSqlClarification({store,project,actorId:task.submittedBy,binding:{taskId:last.taskId,evidenceDigest:last.sourceDigest},contextId:task.contextId,currentSql:task.initialSql,answer:task.message});
 if(clarificationHash(resolved)!==clarificationHash(c))throw fail();
}
