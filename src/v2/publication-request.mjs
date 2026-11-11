// Pure request syntax only. Identity, ownership, approval and expiry remain
// server-side checks. Keep this helper compatible with Node 14 transports.
const keys = ["sourceKind", "sourceRunId", "packageDigest", "verificationId", "releaseId"];
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const invalid = () => Object.assign(new Error("发布选择参数不合法；仅允许指定来源、运行、包摘要、演练和发布编号"), { status: 422, code: "PUBLICATION_SELECTOR_INVALID" });
export const publicationAttestationKeys = Object.freeze(["code","assertions","deliveryFiles","cloudScope"]);

function exactPreflightSelector(selector) {
  return selector.sourceKind === "AGENT" && selector.sourceRunId && selector.packageDigest &&
    selector.verificationId && !selector.releaseId;
}

export function publicationSelectorInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw invalid();
  const selector = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(input, key)) {
    const value = input[key];
    if (key === "sourceKind" ? !["AGENT", "MANUAL"].includes(value) : key === "packageDigest" ? typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) : !safeId(value)) throw invalid();
    selector[key] = value;
  }
  if (selector.sourceKind === "MANUAL" && (!selector.sourceRunId || !selector.packageDigest || !selector.verificationId)) throw invalid();
  return selector;
}

export function publicationReadPath(taskId, selector = {}) {
  if (!safeId(taskId)) throw invalid();
  const query = new URLSearchParams(publicationSelectorInput(selector)).toString();
  return `/agent/tasks/${taskId}/publication${query ? `?${query}` : ""}`;
}

export function publicationPreflightPath(taskId, selector) {
  if (!exactPreflightSelector(publicationSelectorInput(selector))) throw invalid();
  return publicationReadPath(taskId,selector).replace("/publication?","/publication/preflight?");
}

export function publicationRequestReceiptPath(taskId, requestId) {
  if (!safeId(taskId) || !safeId(requestId)) throw invalid();
  return `/agent/tasks/${taskId}/publication/requests/${requestId}`;
}

export function publicationSelectorFromUrl(input) {
  let url;
  if (typeof input !== "string" && !(input instanceof URL) || /[\\#\s\u0000-\u001f\u007f]/.test(String(input))) throw invalid();
  try { url = new URL(String(input), "http://publication.invalid"); } catch { throw invalid(); }
  if (url.hash) throw invalid();
  const selector = {};
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || Object.prototype.hasOwnProperty.call(selector, key)) throw invalid();
    selector[key] = value;
  }
  return publicationSelectorInput(selector);
}

export function privatePublicationReadRoute(method, path) {
  if (method !== "GET" || typeof path !== "string" || path.length > 700 || /[\\#\s\u0000-\u001f\u007f]/.test(path) ||
      !/^\/api\/v2\/agent\/tasks\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/publication(?:\/preflight\?[^#]*|\/requests\/[A-Za-z0-9_-]{1,100}|\?[^#]*)?$/.test(path)) return false;
  try {
    const selector = publicationSelectorFromUrl(path);
    return !path.includes("/publication/preflight?") || Boolean(exactPreflightSelector(selector));
  } catch { return false; }
}

const reviewUuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const reviewHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function parseAgentReviewEvidencePath(path) {
  if (typeof path !== "string" || path.length > 320 || /[\\#\s\u0000-\u001f\u007f]/.test(path)) return;
  const route = path.split("?", 1)[0].match(new RegExp(`^/api/v2/agent/tasks/(${reviewUuid})/review-evidence$`));
  if (!route) return;
  const params = new URL(path, "http://review.invalid").searchParams;
  const deliveryId = params.get("delivery_id"), requestSha256 = params.get("request_sha256");
  if ([...params].length !== 2 || !new RegExp(`^${reviewUuid}$`).test(deliveryId ?? "") || !reviewHash(requestSha256)) return;
  return {taskId:route[1],deliveryId,requestSha256};
}

export function agentReviewEvidencePath({taskId,deliveryId,requestSha256}) {
  const query = new URLSearchParams({delivery_id:deliveryId,request_sha256:requestSha256});
  const path = `/agent/tasks/${taskId}/review-evidence?${query}`;
  if (!parseAgentReviewEvidencePath("/api/v2" + path)) throw new Error("需提供原任务、交付编号与需求摘要");
  return path;
}

// Separate explicit transport capability; legacy Agent permissions do not
// imply access to standalone manual publication endpoints.
export function standaloneManualPublicationRoute(method,path){
  if(typeof path!=='string'||!path.startsWith('/api/v2/')||path.length>700||/[\\#\s\u0000-\u001f\u007f]/.test(path))return false;
  const u=new URL(path,'http://publication.invalid'),p=u.pathname,id='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  if(p!==path.split('?')[0])return false;
  if(method==='GET'&&new RegExp(`^/api/v2/delivery/manual/(?:source/)?${id}$`).test(p))return !u.search;
  if(!new RegExp(`^/api/v2/delivery/manual/${id}/publication(?:/cancel)?$`).test(p))return false;
  if(method==='POST')return !u.search;
  if(method!=='GET'||p.endsWith('/cancel'))return false;
  try{const s=publicationSelectorFromUrl(path);return s.sourceKind==='MANUAL'&&Boolean(s.sourceRunId&&s.packageDigest&&s.verificationId);}catch{return false;}
}
