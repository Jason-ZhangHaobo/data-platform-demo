const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedAssistedDevelopmentReference(value){
  const base=['kind','sourceRunId','sourceRevisionId','sourceRevisionHash','initialSqlHash'];
  const keys=value?.kind==='RUN_COMPARISON_REFERENCE'?[...base,'baselineRunId','baselineRevisionHash','evidenceDigest']:base;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['RUN_COMPARISON_REFERENCE','FAILED_RUN_REFERENCE'].includes(value.kind)||
    Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||!uuid(value.sourceRunId)||!uuid(value.sourceRevisionId)||
    !hash(value.sourceRevisionHash)||!hash(value.initialSqlHash)||value.kind==='RUN_COMPARISON_REFERENCE'&&
    (!uuid(value.baselineRunId)||value.baselineRunId===value.sourceRunId||!hash(value.baselineRevisionHash)||!hash(value.evidenceDigest)||value.initialSqlHash!==value.sourceRevisionHash))
    throw Object.assign(new Error('人工辅助开发依据未绑定确切版本与证据'),{status:409,code:'ASSISTED_DEVELOPMENT_REFERENCE_INVALID'});
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function sameAssistedDevelopmentReference(a,b){
  if(a===undefined||b===undefined)return a===b;
  try{return JSON.stringify(checkedAssistedDevelopmentReference(a))===JSON.stringify(checkedAssistedDevelopmentReference(b));}catch{return false;}
}
