import { isDeepStrictEqual as same } from "node:util";
import { frozenQualityProtocol, frozenQualityRuleSet, frozenQualityRules, checkedFrozenAssetQuality } from "./frozen-asset-quality-client.mjs";
import { publishedReportHash } from "./published-report-source.mjs";

const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const invalid=()=>fail(409,"FROZEN_ASSET_QUALITY_UNPROVEN","原发布资产或保存的质量回执待核对");

export function frozenAssetQuality({store,project,quality,asset,batch,source,confirmation}) {
  const rows=batch.rows, rules=frozenQualityRules();
  if (!Array.isArray(rows) || rows.length<1 || rows.length>1000 || rows.length!==asset.rowCount ||
      publishedReportHash(rows)!==asset.evidenceHash) throw invalid();
  const basis={protocol:frozenQualityProtocol,scope:"LOCAL_TEST_ONLY",publicDeployed:false,ruleSet:frozenQualityRuleSet,
    assetId:asset.id,batchId:batch.id,releaseId:batch.releaseId,snapshotHash:source.snapshotHash,evidenceHash:asset.evidenceHash,rowCount:asset.rowCount};
  const basisDigest=publishedReportHash({basis,rules}), key=`${project}:${frozenQualityRuleSet}:${asset.id}`, kind="quality_frozen_asset_check";
  if (confirmation!==undefined) {
    if (!same(confirmation,{confirm:true,basisDigest}))
      throw fail(409,"FROZEN_ASSET_QUALITY_CONFIRMATION_REQUIRED","请按已核对的原资产和规则确认检测");
    store.deduplicate(key,basisDigest,()=>{
      const checks=rules.map(rule=>({id:rule.id,...quality.evaluateRows(rule,rows)}));
      const receipt={basisDigest,checks,actualExecution:true,checkedAt:new Date().toISOString(),
        status:checks.every(check=>check.status==="PASSED")?"PASSED":"FAILED"};
      return store.create(kind,project,{basis,receipt,receiptDigest:publishedReportHash(receipt)});
    });
  }
  const entry=store.db.prepare("SELECT signature,result_id FROM idempotency WHERE key=?").get(key);
  if (!entry) return {...basis,basisDigest,status:"PENDING",actualExecution:false};
  const record=store.get(kind,entry.result_id,project);
  if (!record?.receipt || entry.signature!==basisDigest || !same(record.basis,basis) ||
      record.receipt.basisDigest!==basisDigest || record.receiptDigest!==publishedReportHash(record.receipt)) throw invalid();
  try {
    return checkedFrozenAssetQuality({...basis,...record.receipt,checkId:record.id,receiptDigest:record.receiptDigest},
      {assetId:asset.id,evidenceHash:asset.evidenceHash,rowCount:asset.rowCount});
  } catch { throw invalid(); }
}
