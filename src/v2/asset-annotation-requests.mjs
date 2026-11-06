import { createHash } from "node:crypto";
import { ANNOTATION_RECEIPT_PROTOCOL, ANNOTATION_RESULT_PROTOCOL, canonicalAnnotationJson, normalizeAnnotationWrite, annotationRequestId, validAnnotationReceipt } from "./asset-annotation-contract.mjs";
import { assetResourcePath } from "./asset-resource-path.mjs";
const kind = "asset_annotation_request_v2";
const digest = value => createHash("sha256").update(canonicalAnnotationJson(value)).digest("hex");
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
export function createAssetAnnotationRequests({ store, assets, project }) {
  const actor = value => { if (typeof value !== "string" || !value || value.length > 160) throw fail(401,"AUTHENTICATION_REQUIRED","标注身份尚未确认"); return value; };
  const keyFor = (assetId, requestId, actorId) => "asset-annotation-v2:" + digest([project, actor(actorId), assetId, annotationRequestId(requestId)]);
  function current(assetId) {
    try { const value = assets.detail(assetId); return { state:"AVAILABLE", revision:value.annotation?.revision??0, evidenceHash:value.evidenceHash }; }
    catch { return { state:"UNAVAILABLE" }; }
  }
  function view(record, assetId, requestId, actorId, replayed) {
    if (!record || record.actorId !== actorId || record.assetId !== assetId || record.requestId !== requestId) throw fail(404,"ANNOTATION_REQUEST_NOT_FOUND","未找到本账号的原标注请求");
    if (!validAnnotationReceipt(record.receipt) || record.receipt.assetId !== assetId || record.receipt.requestId !== requestId || digest(record.receipt) !== record.receiptHash) throw fail(409,"ANNOTATION_RECEIPT_CORRUPT","原标注回执未通过完整性核验");
    if (record.receipt.outcome === "APPLIED") {
      const row = store.get("asset_annotation",record.receipt.annotation.id,project), snapshot=record.receipt.annotation;
      if (!row || row.assetId !== assetId || ["id","revision","evidenceHash","businessName","description","domain","owner","classification","createdAt"].some(field=>row[field]!==snapshot[field]) || canonicalAnnotationJson(row.tags)!==canonicalAnnotationJson(snapshot.tags)) throw fail(409,"ANNOTATION_RECEIPT_CORRUPT","原标注版本记录与回执不一致");
    }
    const now=current(assetId), applied=record.receipt.annotation;
    return { protocol:ANNOTATION_RESULT_PROTOCOL,id:record.id,assetId,requestId,receipt:structuredClone(record.receipt),receiptHash:record.receiptHash,replayed,current:now,currentMatches:record.receipt.outcome==="APPLIED"&&now.state==="AVAILABLE"&&now.revision===applied.revision&&now.evidenceHash===applied.evidenceHash };
  }
  return {
    submit(assetId, input, actorId, headerKey) {
      actor(actorId); const body=normalizeAnnotationWrite(assetId,input,headerKey),key=keyFor(assetId,body.requestId,actorId);
      const result=store.deduplicate(key,digest(body),()=>{
        let annotation=null,rejection=null,outcome="APPLIED";
        try {
          const value=assets.annotate(assetId,body.annotation,{expected:body.expected});
          annotation={...value.annotation,evidenceHash:value.evidenceHash};
        } catch(error) {
          if(error.code!=="ASSET_ANNOTATION_BASE_STALE")throw error;
          outcome="REJECTED";rejection={code:"BASE_STALE",observed:error.observed};
        }
        const receipt={protocol:ANNOTATION_RECEIPT_PROTOCOL,requestId:body.requestId,assetId,request:{expected:body.expected,annotation:body.annotation},outcome,annotation,rejection};
        if(!validAnnotationReceipt(receipt))throw fail(500,"ANNOTATION_RECEIPT_INVALID","标注回执生成未确认，事务已停止");
        return store.create(kind,project,{actorId,assetId,requestId:body.requestId,receipt,receiptHash:digest(receipt)});
      });
      return view(store.get(kind,result.id,project),assetId,body.requestId,actorId,result.replayed);
    },
    lookup(assetId, requestId, actorId) {
      assetResourcePath(assetId);actor(actorId);requestId=annotationRequestId(requestId);
      const id=store.deduplicatedId(keyFor(assetId,requestId,actorId));
      return view(id?store.get(kind,id,project):undefined,assetId,requestId,actorId,true);
    },
  };
}
