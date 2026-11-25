import {createHash} from 'node:crypto';
import {qualityRuleHealth,nonemptyQualityPass} from './quality-evidence.mjs';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),text=value=>typeof value==='string'&&value.length>0;
const expiryTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)?Date.parse(value):NaN;
const syncReceiptFailures={
 SYNC_LANDING_RECEIPT_MISSING:'当前同步批次缺少原落地回执，原检测记录保留',
 SYNC_LANDING_RECEIPT_MISMATCH:'当前同步批次与原落地回执不一致，原检测记录保留',
 SYNC_LANDING_RESULT_UNCONFIRMED:'当前同步批次尚未确认完成，请先核对原同步请求，原检测记录保留',
};
export const qualityRowsHash=rows=>createHash('sha256').update(canonical(rows)).digest('hex');
export function qualityValidUntil(version,rows,result){
 if(version.type!=='FRESHNESS_SECONDS'||!nonemptyQualityPass(result))return undefined;
 const expiry=rows.reduce((min,row)=>Math.min(min,Date.parse(String(row[version.field]))),Infinity)+version.config.maxAgeSeconds*1000;
 return Number.isFinite(expiry)&&Math.abs(expiry)<=8640000000000000?new Date(expiry).toISOString():undefined;
}
// Metadata/row-digest read only: no rule evaluation, run creation or recovery.
export function currentQualityEvidence({rule,version,lastRun,readCurrent,now=Date.now()}){
 const base=qualityRuleHealth(rule,lastRun),last=lastRun?{runId:lastRun.id,status:lastRun.status,versionId:lastRun.assetVersionId,evidenceHash:lastRun.assetEvidenceHash,...(lastRun.inputRowsHash?{rowsHash:lastRun.inputRowsHash}:{}),...(Number.isFinite(expiryTime(lastRun.validUntil))?{validUntil:lastRun.validUntil}:{} )}:undefined;
 const result=(health,status,reason,current)=>({health,sourceFreshness:{status,reason,...(last?{lastDetected:last}:{}),...(current?{current}:{} )}});
 if(!version||version.id!==rule.currentVersionId)return result('UNCONFIRMED','RULE_UNPROVEN','当前规则版本无法核对，原检测记录保留');
 if(!lastRun)return result(base,'NO_RUN','当前规则尚无检测回执');
 if(lastRun.ruleVersionId!==rule.currentVersionId)return result('PENDING','RULE_CHANGED','规则版本已变化，原检测保留，当前版本待检测');
 if(lastRun.archiveSource)return result('UNCONFIRMED','HISTORY_ONLY','历史复检不能作为当前健康依据');
 if(lastRun.actualExecution!==true||lastRun.status==='UNCONFIRMED')return result('UNCONFIRMED','DETECTION_UNPROVEN','原检测执行或计数未能核对，不能作为当前健康依据');
 let input;
 try {
  input=readCurrent();
  if(!input?.asset||!Array.isArray(input.rows))throw Error('SOURCE_UNAVAILABLE');
 } catch(error) {
  if(error?.status===409&&Object.hasOwn(syncReceiptFailures,error.code)) {
   const unavailable=result('UNCONFIRMED','SOURCE_UNAVAILABLE',syncReceiptFailures[error.code]);
   unavailable.sourceFreshness.evidenceCode=error.code;
   return unavailable;
  }
  return result('UNCONFIRMED','SOURCE_UNAVAILABLE','当前数据无法核对，原检测记录保留；读取不会执行新检测');
 }
 const {asset,rows}=input,current={versionId:asset.versionId,evidenceHash:asset.evidenceHash,rowsHash:qualityRowsHash(rows),rowCount:rows.length,...(asset.syncSource?{sourceStatus:asset.syncSource.status}:{})};
 if(lastRun.assetId!==rule.assetId||asset.id!==rule.assetId||lastRun.ruleConfigHash!==version.configHash||!sha(lastRun.assetEvidenceHash)||!text(lastRun.assetVersionId)||!sha(current.evidenceHash)||!text(current.versionId))return result(base==='NO_DATA'?'NO_DATA':'UNCONFIRMED','INPUT_UNPROVEN','原检测与当前规则或数据来源尚不能完整核对',current);
 if(lastRun.assetVersionId!==current.versionId||lastRun.assetEvidenceHash!==current.evidenceHash||sha(lastRun.inputRowsHash)&&lastRun.inputRowsHash!==current.rowsHash)return result('STALE','DATA_CHANGED','当前批次或内容已变化；原结论仅属于上次数据，请显式检测当前表',current);
 if(asset.syncSource&&asset.syncSource.status!=='VERIFIED')return result(base==='NO_DATA'?'NO_DATA':'UNCONFIRMED','SOURCE_UNCONFIRMED','当前落地数据与已登记同步批次未能核对，原结论不代替当前健康',current);
 if(!sha(lastRun.inputRowsHash))return result(base==='NO_DATA'?'NO_DATA':'UNCONFIRMED','LEGACY_ROWS_UNPROVEN','旧回执未记录实际检测行摘要，需显式检测后确认当前健康',current);
 if(version.type==='FRESHNESS_SECONDS'&&nonemptyQualityPass(lastRun)){
  const expiry=expiryTime(lastRun.validUntil);if(!Number.isFinite(expiry))return result('UNCONFIRMED','VALIDITY_UNPROVEN','旧时效回执缺少可核验有效期，请显式重新检测',current);
  if(now>expiry)return result('STALE','VALIDITY_EXPIRED','时效检测证据已到期；保留原通过记录，当前需重新检测',current);
 }
 return result(base,'MATCHED','当前数据摘要、版本及原检测行一致；本次读取未执行检测',current);
}
