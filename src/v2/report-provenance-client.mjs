const bad=()=>{throw Error('报表溯源文件、审阅摘要或所选版本不一致');};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const keys=(v,allowed)=>obj(v)&&Object.keys(v).every(k=>allowed.includes(k));
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export async function reportEvidenceDigest(v){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v)));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
const provider=p=>keys(p,['model','mode','usage','estimated','unknown'])&&text(p.model,200)&&text(p.mode,100)&&typeof p.estimated==='boolean'&&typeof p.unknown==='boolean'&&(p.usage===null||keys(p.usage,['prompt_tokens','completion_tokens','total_tokens'])&&Object.values(p.usage).every(n=>Number.isSafeInteger(n)&&n>=0));
export async function checkedReportProvenance(value,expected={}) {
 if(!keys(value,['protocol','scope','creationId','capturedAt','review','artifacts','agentIndependentE2E','publicDeployed','integrity','digest'])||value.protocol!=='shuduo-report-provenance/v1'||value.scope!=='LOCAL_TEST_ONLY'||value.agentIndependentE2E!==false||value.publicDeployed!==false||value.integrity!=='SHA256_LOCAL_RECORD_NOT_THIRD_PARTY_SIGNATURE'||!hash(value.digest)||!id(value.creationId)||!Number.isFinite(Date.parse(value.capturedAt))||JSON.stringify(value).length>40000)bad();
 const {digest:claimed,...body}=value,r=value.review,a=value.artifacts;
 if(!keys(r,['protocol','planId','requestId','originalRequest','finalRequest','clarificationDigest','turns','source','sourceEvidenceHash','contextHash','proposal','proposalHash','provider','captureMode','originalAppliedAt'])||r.protocol!=='shuduo-report-review-basis/v1'||!id(r.planId)||!text(r.requestId,100)||!text(r.originalRequest,2000)||!text(r.finalRequest,2000)||!['AT_APPLICATION','EXISTING_APPLICATION_RECHECK'].includes(r.captureMode)||r.originalAppliedAt!==null&&!Number.isFinite(Date.parse(r.originalAppliedAt))||![r.sourceEvidenceHash,r.contextHash,r.proposalHash].every(hash)||!Array.isArray(r.turns)||r.turns.length>3||!provider(r.provider)||r.turns.some(t=>!keys(t,['question','answer','provider'])||!text(t.question,300)||!text(t.answer,1000)||!provider(t.provider)))bad();
 if(r.turns.length?(!hash(r.clarificationDigest)||r.finalRequest!==r.turns.at(-1).answer):(r.clarificationDigest!==null||r.originalRequest!==r.finalRequest))bad();
 const s=r.source,p=r.proposal;
 if(!keys(s,['kind','releaseId','packageDigest','revisionId','runId','batchId','taskId'])||!['AGENT','MANUAL'].includes(s.kind)||![s.releaseId,s.revisionId,s.runId,s.batchId].every(id)||!hash(s.packageDigest)||(s.kind==='AGENT'?!id(s.taskId):s.taskId!==undefined)||!keys(p,['kind','name','metricIds','widgets'])||p.kind!=='PUBLISHED_REPORT'||!text(p.name,80)||!Array.isArray(p.metricIds)||!p.metricIds.length||p.metricIds.length>5||new Set(p.metricIds).size!==p.metricIds.length||!Array.isArray(p.widgets)||p.widgets.length!==p.metricIds.length)bad();
 if(!keys(a,['reportId','reportVersionId','versionNumber','reportRunId','datasetId','snapshotId','sourceBatchId','contentHash','configHash','resultHash','outputContractId','rowCount'])||![a.reportId,a.reportVersionId,a.reportRunId,a.datasetId,a.snapshotId,a.sourceBatchId].every(id)||![a.contentHash,a.configHash,a.resultHash].every(hash)||!Number.isSafeInteger(a.versionNumber)||a.versionNumber<1||!Number.isSafeInteger(a.rowCount)||a.rowCount<0||a.sourceBatchId!==s.batchId||a.outputContractId!==null&&!text(a.outputContractId,150))bad();
 const proposalBinding=r.turns.length?{source:s,contextHash:r.contextHash,proposal:p,planId:r.planId,requestId:r.requestId,message:r.finalRequest,clarificationDigest:r.clarificationDigest}:{source:s,contextHash:r.contextHash,proposal:p};
 if(await reportEvidenceDigest(body)!==claimed||await reportEvidenceDigest(proposalBinding)!==r.proposalHash)bad();
 for(const [k,v]of Object.entries(expected))if(k==='source'?canonical(v)!==canonical(s):a[k]!==v)bad();
 return value;
}
export async function readReportProvenance(client,{reportId,runId}) {
 if(!id(reportId)||!id(runId))bad();return checkedReportProvenance(await client.request(`/reports/${reportId}/provenance?run_id=${runId}`),{reportId,reportRunId:runId});
}
