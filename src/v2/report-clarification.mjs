import{createHash}from'node:crypto';import{isDeepStrictEqual as same}from'node:util';
import{publishedReportSource}from'./published-report-request.mjs';import{publishedReportHash}from'./published-report-source.mjs';import{publishedReportPlanHash}from'./published-report-plan.mjs';
import{reportClarificationProtocol as protocol,reportClarificationKind as kind,reportClarificationUuid as uuid,reportClarificationDigest as hash,reportClarificationAnswer}from'./report-clarification-contract.mjs';
const fail=(message='原报表问题、需求、用量或来源已变化；保留原记录，不重新调用模型',code='REPORT_CLARIFICATION_SOURCE_CHANGED',status=409)=>Object.assign(Error(message),{status,code});
const hasFrame=p=>p.clarification!==undefined||p.originPlanId!==undefined||p.derivationKind!==undefined;
export function reportProposalHash(p,proposal){return hasFrame(p)?publishedReportHash({source:publishedReportSource(p.sourceBinding),contextHash:p.contextHash,proposal,planId:p.id,requestId:p.requestId,message:p.message,clarificationDigest:p.clarification?.digest}):publishedReportPlanHash(p.sourceBinding,p.contextHash,proposal);}
export const reportClarificationSignature=(id,digest,answer)=>publishedReportHash({kind,originPlanId:id,evidenceDigest:digest,answer:reportClarificationAnswer(answer)});
function assertLedger(p,{store,project}){
 const key=`${project}:source-report-plan:${p.submittedBy}:${p.requestId}`,r=store.db.prepare('SELECT signature,result_id FROM idempotency WHERE key=?').get(key);
 const signature=hasFrame(p)?reportClarificationSignature(p.originPlanId,p.clarification?.turns?.at(-1)?.parentDigest,p.message):createHash('sha256').update(JSON.stringify({message:p.message,source:publishedReportSource(p.sourceBinding)})).digest('hex');
 if(!r||r.result_id!==p.id||r.signature!==signature)throw fail('原报表规划创建依据未确认，未生成后续方案');
}
const usageTokens=p=>{const u=p.usage??{},total=u.total_tokens??((u.prompt_tokens??0)+(u.completion_tokens??0));return Number.isSafeInteger(total)&&total>0?total:0;};
const usageFlags=p=>({usageEstimated:p.usageEstimated??!usageTokens(p),usageUnknown:p.usageUnknown??!usageTokens(p)});
function evidence(p){return publishedReportHash({id:p.id,actor:p.submittedBy,projectId:p.projectId,requestId:p.requestId,message:p.message,sourceBinding:p.sourceBinding,sourceEvidenceHash:p.sourceEvidenceHash,contextHash:p.contextHash,status:p.status,proposal:p.proposal,proposalHash:p.proposalHash,providerPhase:p.providerPhase??null,model:p.model??null,usage:p.usage??null,...usageFlags(p),planningMode:p.planningMode??'UNRECORDED',clarificationDigest:p.clarification?.digest??null});}
function append(parent,answer){
 const p=parent.record,prior=p.clarification,turn={planId:p.id,requestId:p.requestId,parentDigest:parent.evidenceDigest,question:p.proposal.question,answer,model:p.model??'UNRECORDED',usage:p.usage??null,...usageFlags(p),planningMode:p.planningMode??'UNRECORDED'};
 const frame={protocol,rootPlanId:prior?.rootPlanId??p.id,originalRequest:prior?.originalRequest??p.message,sourceBinding:p.sourceBinding,contextHash:p.contextHash,depth:(prior?.depth??0)+1,turns:[...(prior?.turns??[]),turn]};return{...frame,digest:publishedReportHash(frame)};
}
function read(id,actor,env,seen){
 if(!uuid(id)||seen.has(id)||seen.size>3)throw fail();seen.add(id);const p=env.store.get('report_agent_plan',id,env.project);
 if(!p||p.projectId!==env.project)throw fail('未找到原报表澄清任务','REPORT_CLARIFICATION_NOT_FOUND',404);
 if(p.submittedBy!==actor)throw fail('仅原创建者可回答此报表问题','REPORT_CLARIFICATION_OWNER',403);
 assertPlan(p,env,seen);
 if(p.planMode!=='PUBLISHED_SOURCE_REPORT_V1'||p.status!=='NEEDS_CLARIFICATION'||p.proposal?.kind!=='CLARIFICATION_REQUIRED'||typeof p.proposal.question!=='string'||p.proposal.question.trim().length<4||p.proposal.question.length>300||p.executionMode==='SOURCE_BOUND_REPORT_AGENT_V1'&&p.providerPhase!=='RECORDED'||reportProposalHash(p,p.proposal)!==p.proposalHash)throw fail();
 if(p.executionMode==='SOURCE_BOUND_REPORT_AGENT_V1'&&!p.usageEstimated&&!p.usageUnknown&&!usageTokens(p))throw fail('原报表用量回执未确认');
 const context=env.contextFor(p.sourceBinding,actor);if(publishedReportHash(context)!==p.contextHash||context.sourceEvidenceHash!==p.sourceEvidenceHash)throw fail();
 return{record:p,evidenceDigest:evidence(p),context};
}
function assertPlan(p,env,seen=new Set()){
 assertLedger(p,env);if(!hasFrame(p))return;
 const c=p.clarification,last=c?.turns?.at(-1);if(p.derivationKind!==kind||!uuid(p.originPlanId)||!c||c.protocol!==protocol||!Number.isSafeInteger(c.depth)||c.depth<1||c.depth>3||c.turns?.length!==c.depth||!last||p.originPlanId!==last.planId||p.message!==last.answer||!hash(c.digest))throw fail();
 const parent=read(p.originPlanId,p.submittedBy,env,seen),expected=append(parent,reportClarificationAnswer(p.message));if(!same(expected,c)||!same(c.sourceBinding,p.sourceBinding)||c.contextHash!==p.contextHash)throw fail();
}
export function assertReportClarificationPlan(p,env){assertPlan(p,env,new Set([p.id]));}
export function readReportClarification({store,project,planId,actorId,contextFor}){
 const r=read(planId,actorId,{store,project,contextFor},new Set()),p=r.record,depth=p.clarification?.depth??0;
 const turns=p.clarification?.turns??[],knownTokens=turns.reduce((n,t)=>n+(!t.usageEstimated&&!t.usageUnknown?usageTokens(t):0),0)+(!usageFlags(p).usageEstimated&&!usageFlags(p).usageUnknown?usageTokens(p):0),unknownUsage=turns.some(t=>t.usageUnknown)||usageFlags(p).usageUnknown;
 return{protocol,planId:p.id,evidenceDigest:r.evidenceDigest,question:p.proposal.question,originalRequest:p.clarification?.originalRequest??p.message,sourceBinding:p.sourceBinding,contextHash:p.contextHash,depth,canReply:depth<3,historicalCalls:turns.length+1,knownTokens,unknownUsage};
}
export function deriveReportClarification({store,project,planId,actorId,contextFor,evidenceDigest,answer}){
 if(!hash(evidenceDigest))throw fail('原问题摘要格式不合法','REPORT_CLARIFICATION_INPUT_INVALID',422);answer=reportClarificationAnswer(answer);const r=read(planId,actorId,{store,project,contextFor},new Set());if(r.evidenceDigest!==evidenceDigest)throw fail();if((r.record.clarification?.depth??0)>=3)throw fail('最多三轮报表澄清，请整理已确认需求后显式新建规划','REPORT_CLARIFICATION_DEPTH_LIMIT');return{frame:append(r,answer),parent:r.record,context:r.context,answer};
}
