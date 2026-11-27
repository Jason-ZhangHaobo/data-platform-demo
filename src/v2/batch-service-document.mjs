import {serviceSourceReadPath} from './service-source-request.mjs';
import {assetQueryDocument,boundAssetQueryContract} from './asset-query-contract.mjs';
import {uuid,digest} from './chat-change-resource.mjs';

export async function readBatchServiceDocument(client,input){
  const keys=['taskId','packageDigest','releaseId','batchId','serviceId','versionId'];
  if(!input || Object.keys(input).length!==keys.length || !keys.every(key=>Object.hasOwn(input,key)) ||
    !digest(input.packageDigest) || !keys.filter(k=>k!=='packageDigest').every(k=>uuid(input[k])))
    throw Error('请指定原任务、包摘要、发布、批次和接口版本。');
  const {taskId,packageDigest,releaseId,batchId,serviceId,versionId}=input;
  const result=await client.request(serviceSourceReadPath('task-evidence',{agentTaskId:taskId,packageDigest,releaseId,batchId}));
  if(result?.protocol!=='shuduo-private-task-consumption/v1'||result.scope!=='PRIVATE_CLOUD_TEST'||result.taskId!==taskId||
    result.sourceKind!=='AGENT'||result.releaseId!==releaseId||result.packageDigest!==packageDigest||result.sourceReleaseRunId!==batchId||
    !Array.isArray(result.services))throw Error('接口文档与所选发布批次不一致。');
  const selected=result.services.filter(s=>s.serviceId===serviceId && s.versionId===versionId);
  const entry=selected.length===1?selected[0]:undefined;
  const contract=boundAssetQueryContract(entry,batchId);
  if(!contract || !contract.current || entry.source?.taskId!==taskId || entry.releaseId!==releaseId || entry.source.packageDigest!==packageDigest)
    throw Error('未能确认该批次当前在服的指定接口版本。');
  return assetQueryDocument(contract,client.baseUrl?new URL(client.baseUrl).origin:'/');
}
