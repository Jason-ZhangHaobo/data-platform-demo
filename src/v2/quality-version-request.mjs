const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export function qualityVersionRequestPath(ruleId,requestId){if(!uuid(ruleId)||!uuid(requestId))throw Error('规则保存回读须使用原规则及请求UUID');return `/quality/rules/${ruleId}/version-requests/${requestId}`;}
export function checkedQualityVersionWrite(value,ruleId,body){
 const id=value?.versionWrite?.versionId,version=value?.versions?.find(item=>item.id===id);
 if(value?.id!==ruleId||!uuid(id)||!uuid(value.currentVersionId)||!version||!Number.isInteger(version.versionNumber)||version.versionNumber<2||version.ruleId!==ruleId||version.basedOnVersionId!==body.expectedVersionId||version.field!==body.field||version.type!==body.type||version.description!==body.description||canonical(version.config)!==canonical(body.config))throw Error('保存回执与原版本或草稿不一致；保留原请求编号');
 return {versionId:id,versionNumber:version.versionNumber,currentVersionId:value.currentVersionId};
}
export async function readQualityVersionRequest(client,{ruleId,requestId}){return client.request(qualityVersionRequestPath(ruleId,requestId));}
