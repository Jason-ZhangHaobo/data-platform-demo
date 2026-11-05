// Pure request syntax only. Identity, ownership, approval and expiry remain
// server-side checks. Keep this helper compatible with Node 14 transports.
const keys = ["sourceKind", "sourceRunId", "packageDigest", "verificationId", "releaseId"];
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const invalid = () => Object.assign(new Error("发布选择参数不合法；仅允许指定来源、运行、包摘要、演练和发布编号"), { status: 422, code: "PUBLICATION_SELECTOR_INVALID" });

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
      !/^\/api\/v2\/agent\/tasks\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/publication(?:\?[^#]*)?$/.test(path)) return false;
  try { publicationSelectorFromUrl(path); return true; } catch { return false; }
}
