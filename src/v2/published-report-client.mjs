import {publishedReportInput,publishedReportSource,reportRequestId} from './published-report-request.mjs';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedPublishedReportReceipt(value,{requestId,source,name,metricIds}={}){
 const bad=()=>{throw Error('原报表请求的来源或产物回执尚未确认；保留原编号，不重新创建');};
 if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!=='shuduo-published-report-creation/v1'||value.scope!=='LOCAL_TEST_ONLY'||!['PREPARING','PARTIAL','SUCCEEDED'].includes(value.status)||value.agentIndependentE2E!==false||value.publicDeployed!==false||typeof value.name!=='string'||!value.name||!hash(value.sourceEvidenceHash))bad();
 try{reportRequestId(value.id);reportRequestId(value.requestId);publishedReportSource(value.source);for(const k of ['datasetId','snapshotId','reportId','reportVersionId','reportRunId'])if(value[k]!==undefined)reportRequestId(value[k]);}catch{bad();}
 if(requestId&&value.requestId!==requestId||name!==undefined&&value.name!==name||source&&JSON.stringify(publishedReportSource(value.source))!==JSON.stringify(publishedReportSource(source)))bad();
 if(metricIds&&JSON.stringify([...metricIds].sort())!==JSON.stringify([...(value.metricIds??[])].sort()))bad();
 if(typeof value.stage!=='string'||!['SOURCE_CONFIRMED','dataset','snapshot','report','reportRun','COMPLETE'].includes(value.stage)||value.status==='PARTIAL'&&(!value.error||typeof value.error.code!=='string'||typeof value.error.message!=='string'))bad();
 if(value.status==='SUCCEEDED'&&(!['datasetId','snapshotId','reportId','reportVersionId','reportRunId'].every(k=>typeof value[k]==='string')||value.stage!=='COMPLETE'||!hash(value.resultHash)||!Number.isSafeInteger(value.rowCount)||value.rowCount<0||!Number.isSafeInteger(value.widgetCount)||value.widgetCount<1||value.widgetCount>8))bad();
 return value;
}
export async function submitPublishedReport(client,args){
 const body=publishedReportInput({name:args.name,source:args.source,...(args.metricIds===undefined?{}:{metricIds:args.metricIds})}),requestId=reportRequestId(args.requestId);
 return checkedPublishedReportReceipt(await client.request('/reports/published',{method:'POST',body,idempotencyKey:requestId}),{requestId,source:body.source,name:body.name,metricIds:body.metricIds});
}
export async function lookupPublishedReport(client,args){
 const requestId=reportRequestId(args.requestId);
 return checkedPublishedReportReceipt(await client.request('/reports/published/requests/'+requestId),{requestId,source:args.source,name:args.name});
}
export async function resumePublishedReport(client,args){
 const id=reportRequestId(args.id);
 const value=checkedPublishedReportReceipt(await client.request(`/reports/published/${id}/advance`,{method:'POST',body:{}}),{requestId:args.requestId,source:args.source});
 if(value.id!==id)throw Error('续接回执不是原报表任务，未采用其他结果');return value;
}
