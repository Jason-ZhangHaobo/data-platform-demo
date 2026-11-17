import { assetResourcePath } from "./asset-resource-path.mjs";

const prefix="dataset:sync-holdings:";
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=value=>typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
export const frozenQualityProtocol="shuduo-frozen-asset-quality/v1";
export const frozenQualityRuleSet="frozen-holdings-quality/v1";

export function frozenQualityRules() {
  return [
    { id:"client-present", name:"客户编号非空", field:"client_id", type:"NOT_NULL", config:{} },
    { id:"client-unique", name:"同批客户编号唯一", field:"client_id", type:"UNIQUE", config:{} },
    { id:"total-precision", name:"资产合计符合两位小数精度", field:"total_assets", type:"VALUE_RANGE",
      config:{min:"-999999999999999999.99",max:"999999999999999999.99"} },
  ];
}

export function frozenQualityPath(assetId) {
  if (typeof assetId!=="string" || !assetId.startsWith(prefix) || !uuid.test(assetId.slice(prefix.length)))
    throw Error("请选择一个冻结持仓发布资产");
  return assetResourcePath(assetId,"quality");
}

export function checkedFrozenAssetQuality(value, expected={}) {
  const invalid=()=>{throw Error("原批次、资产摘要或质量回执未通过核对");};
  if (value?.protocol!==frozenQualityProtocol || value.scope!=="LOCAL_TEST_ONLY" ||
      value.ruleSet!==frozenQualityRuleSet || value.publicDeployed!==false ||
      !uuid.test(value.batchId ?? "") || !uuid.test(value.releaseId ?? "") || value.assetId!==prefix+value.batchId ||
      ![value.basisDigest,value.evidenceHash,value.snapshotHash].every(digest) ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount<1 || value.rowCount>1000 ||
      !["PENDING","PASSED","FAILED"].includes(value.status) ||
      ["assetId","evidenceHash","rowCount"].some(key=>expected[key]!==undefined&&expected[key]!==value[key])) invalid();
  const keys=["protocol","scope","publicDeployed","ruleSet","assetId","batchId","releaseId","snapshotHash","evidenceHash",
    "rowCount","basisDigest","status","actualExecution"];
  if(value.status!=="PENDING") keys.push("checks","checkId","checkedAt","receiptDigest");
  if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))) invalid();
  if (value.status==="PENDING") {
    if (value.actualExecution!==false || ["checks","checkId","checkedAt","receiptDigest"].some(key=>Object.hasOwn(value,key))) invalid();
    return value;
  }
  const rules=frozenQualityRules();
  if (value.actualExecution!==true || !uuid.test(value.checkId ?? "") || !digest(value.receiptDigest) ||
      !Number.isFinite(Date.parse(value.checkedAt)) || !Array.isArray(value.checks) || value.checks.length!==rules.length ||
      value.checks.some((check,i)=>!check||Object.keys(check).length!==9||check.id!==rules[i].id||
        check.evaluatedCount!==value.rowCount||!Number.isSafeInteger(check.failedCount)||check.failedCount<0||check.failedCount>value.rowCount||
        check.passedCount!==value.rowCount-check.failedCount||check.passRate!==Number((check.passedCount/value.rowCount).toFixed(4))||
        check.actualExecution!==true||check.fullLifecycleE2E!==false||!Number.isSafeInteger(check.durationMs)||check.durationMs<0||
        check.status!==(check.failedCount?"FAILED":"PASSED")) ||
      (value.status==="PASSED")!==value.checks.every(check=>check.status==="PASSED")) invalid();
  return value;
}

export async function readFrozenAssetQuality(client, expected) {
  return checkedFrozenAssetQuality(await client.request(frozenQualityPath(expected.assetId)),expected);
}
