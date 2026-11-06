const bad=()=>Object.assign(Error('报表需指定确切发布、包、代码与成功批次'),{status:422,code:'INVALID_PUBLISHED_REPORT_REQUEST'});
export const reportRequestId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw bad();return value;};
export function publishedReportSource(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['kind','releaseId','packageDigest','revisionId','runId','taskId','batchId'].includes(k))||!['AGENT','MANUAL'].includes(input.kind)||typeof input.packageDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.packageDigest))throw bad();
 const result={kind:input.kind,releaseId:reportRequestId(input.releaseId),packageDigest:input.packageDigest,revisionId:reportRequestId(input.revisionId),runId:reportRequestId(input.runId),batchId:reportRequestId(input.batchId)};
 if(input.kind==='AGENT')result.taskId=reportRequestId(input.taskId);else if(input.taskId!==undefined)throw bad();
 return result;
}
export function publishedReportInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','source'].includes(k))||typeof input.name!=='string'||input.name.trim().length<2||input.name.length>80)throw bad();
 return{name:input.name.trim(),source:publishedReportSource(input.source)};
}
