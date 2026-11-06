import { ANNOTATION_RESULT_PROTOCOL, annotationRequestId, annotationRequestPath, canonicalAnnotationJson, normalizeAnnotationWrite, validAnnotationReceipt } from "./asset-annotation-contract.mjs";
export { normalizeAnnotationValues } from "./asset-annotation-contract.mjs";
export async function checkedAnnotationResult(value, assetId, requestId, expectedRequest) {
  requestId=annotationRequestId(requestId);
  const bad=()=>new Error("原标注回执尚未通过编号、版本或完整性核验，保留原请求，不自动重写");
  if(!value||Object.keys(value).sort().join(',')!==['protocol','id','assetId','requestId','receipt','receiptHash','replayed','current','currentMatches'].sort().join(','))throw bad();
  if (!value || value.protocol!==ANNOTATION_RESULT_PROTOCOL || typeof value.id!=="string" || value.assetId!==assetId || value.requestId!==requestId || !validAnnotationReceipt(value.receipt) || value.receipt.assetId!==assetId || value.receipt.requestId!==requestId || typeof value.replayed!=="boolean" || typeof value.currentMatches!=="boolean" || !value.current || !["AVAILABLE","UNAVAILABLE"].includes(value.current.state)) throw bad();
  annotationRequestId(value.id);
  if(value.current.state==="AVAILABLE"&&(!Number.isSafeInteger(value.current.revision)||value.current.revision<0||!/^[a-f0-9]{64}$/.test(value.current.evidenceHash)))throw bad();
  if(Object.keys(value.current).sort().join(',')!==(value.current.state==='AVAILABLE'?['state','revision','evidenceHash']:['state']).sort().join(','))throw bad();
  const bytes=new TextEncoder().encode(canonicalAnnotationJson(value.receipt)),hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  if(hash!==value.receiptHash)throw bad();
  const same=value.receipt.outcome==="APPLIED"&&value.current.state==="AVAILABLE"&&value.current.revision===value.receipt.annotation.revision&&value.current.evidenceHash===value.receipt.annotation.evidenceHash;
  if(same!==value.currentMatches)throw bad();
  if(expectedRequest){const expected=normalizeAnnotationWrite(assetId,expectedRequest);if(expected.requestId!==requestId||canonicalAnnotationJson(value.receipt.request)!==canonicalAnnotationJson({expected:expected.expected,annotation:expected.annotation}))throw bad();}
  return value;
}
export async function submitAssetAnnotation(client, assetId, input) {
  const body=normalizeAnnotationWrite(assetId,input);
  const value=await client.request(annotationRequestPath(assetId),{method:"POST",body,idempotencyKey:body.requestId});
  return checkedAnnotationResult(value,assetId,body.requestId,body);
}
export async function readAssetAnnotationRequest(client, assetId, requestId) {
  const value=await client.request(annotationRequestPath(assetId,requestId));
  return checkedAnnotationResult(value,assetId,requestId);
}
