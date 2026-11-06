import { assetResourcePath } from "./asset-resource-path.mjs";
export const ANNOTATION_WRITE_PROTOCOL = "shuduo-asset-annotation-write/v2";
export const ANNOTATION_RECEIPT_PROTOCOL = "shuduo-asset-annotation-receipt/v2";
export const ANNOTATION_RESULT_PROTOCOL = "shuduo-asset-annotation-result/v2";
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const error = message => Object.assign(new Error(message), { status: 400, code: "INVALID_ANNOTATION_REQUEST" });
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const text = (value, name, min, max) => { if (typeof value !== "string" || value.trim().length < min || value.length > max) throw error(`${name}格式不合法`); return value.trim(); };
export const canonicalAnnotationJson = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function annotationRequestId(value) { if (!uuid(value)) throw error("标注请求编号不合法"); return value.toLowerCase(); }
export function annotationRequestPath(assetId, requestId) { return assetResourcePath(assetId) + "/annotation-requests" + (requestId === undefined ? "" : "/" + annotationRequestId(requestId)); }
export function normalizeAnnotationValues(value) {
  if (!keys(value, ["businessName", "description", "domain", "owner", "classification", "tags"])) throw error("标注必须包含完整字段，且不能包含未知字段");
  if (!["PUBLIC_DEMO", "INTERNAL_DEMO", "RESTRICTED_DEMO"].includes(value.classification) || !Array.isArray(value.tags) || value.tags.length > 12) throw error("标注分类或标签不合法");
  return { businessName: text(value.businessName, "业务名称", 2, 80), description: text(value.description, "说明", 4, 500), domain: text(value.domain, "业务域", 2, 40), owner: text(value.owner, "负责人", 2, 40), classification: value.classification, tags: [...new Set(value.tags.map(tag => text(tag, "标签", 1, 24)))] };
}
export function normalizeAnnotationWrite(assetId, value, headerKey) {
  assetResourcePath(assetId);
  if (!keys(value, ["protocol", "requestId", "expected", "annotation"]) || value.protocol !== ANNOTATION_WRITE_PROTOCOL || !keys(value.expected, ["revision", "evidenceHash"]) || !Number.isSafeInteger(value.expected.revision) || value.expected.revision < 0 || !hash(value.expected.evidenceHash)) throw error("标注协议或已读版本不完整");
  const requestId = annotationRequestId(value.requestId);
  if (headerKey !== undefined && annotationRequestId(headerKey) !== requestId) throw error("请求编号与幂等编号不一致");
  return { protocol: ANNOTATION_WRITE_PROTOCOL, requestId, expected: { revision: value.expected.revision, evidenceHash: value.expected.evidenceHash }, annotation: normalizeAnnotationValues(value.annotation) };
}
export function validAnnotationReceipt(value) {
  try {
    if (!keys(value, ["protocol", "requestId", "assetId", "request", "outcome", "annotation", "rejection"]) || value.protocol !== ANNOTATION_RECEIPT_PROTOCOL) return false;
    const request = normalizeAnnotationWrite(value.assetId, { protocol: ANNOTATION_WRITE_PROTOCOL, requestId: value.requestId, ...value.request });
    if (canonicalAnnotationJson(value.request) !== canonicalAnnotationJson({ expected: request.expected, annotation: request.annotation })) return false;
    if (value.outcome === "REJECTED") return value.annotation === null && keys(value.rejection, ["code", "observed"]) && value.rejection.code === "BASE_STALE" && keys(value.rejection.observed, ["revision", "evidenceHash"]) && Number.isSafeInteger(value.rejection.observed.revision) && value.rejection.observed.revision >= 0 && hash(value.rejection.observed.evidenceHash);
    const a = value.annotation;
    if (value.outcome !== "APPLIED" || value.rejection !== null || !keys(a, ["id", "revision", "evidenceHash", "businessName", "description", "domain", "owner", "classification", "tags", "createdAt"]) || !uuid(a.id) || a.revision !== request.expected.revision + 1 || a.evidenceHash !== request.expected.evidenceHash || typeof a.createdAt !== "string" || !Number.isFinite(Date.parse(a.createdAt))) return false;
    return canonicalAnnotationJson(normalizeAnnotationValues({ businessName:a.businessName, description:a.description, domain:a.domain, owner:a.owner, classification:a.classification, tags:a.tags })) === canonicalAnnotationJson(request.annotation);
  } catch { return false; }
}
