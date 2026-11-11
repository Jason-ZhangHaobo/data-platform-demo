import { assetResourcePath, isAssetResourceId } from "../../src/v2/asset-resource-path.mjs";
import {sqlValueLineageValid} from './sql-column-lineage.ts';
export { assetResourcePath } from "../../src/v2/asset-resource-path.mjs";
export type AssetCriteria = { query: string; kind: string };
type Failure = { state: "ERROR"; message: string; loginRequired: boolean };
export type AssetCatalogRead<A, M, S, Q> =
  | { state: "LOADING"; criteria: AssetCriteria }
  | Failure & { criteria: AssetCriteria }
  | { state: "READY"; criteria: AssetCriteria; assets: A[]; metrics: M[]; standards: S[]; tasks: Q[] };
export type AssetDetailRead<D> = { state: "EMPTY"; id: "" } | { state: "LOADING"; id: string; value?: D } | Failure & { id: string; value?: D } | { state: "READY"; id: string; value: D };
type Api = <T>(path: string) => Promise<T>;
const failure = (cause: unknown): Failure => {
  const error = cause as { message?: unknown; status?: unknown; code?: unknown } | undefined;
  return { state: "ERROR", message: typeof error?.message === "string" ? error.message : "资产读取尚未确认，请重新读取。", loginRequired: error?.status === 401 || error?.code === "AUTHENTICATION_REQUIRED" };
};
export function createAssetReader<A extends { id: string }, M, S, Q, D extends { id: string }>({ api, initialId, validAsset, validDetail, isOlder = () => false, onCatalog, onDetail }: {
  api: Api; initialId?: string; validAsset: (value: unknown) => boolean; validDetail: (value: unknown, id: string) => boolean;
  isOlder?: (value: D, known: D) => boolean;
  onCatalog: (result: AssetCatalogRead<A, M, S, Q>) => void; onDetail: (result: AssetDetailRead<D>) => void;
}) {
  let live = true, catalogSequence = 0, detailSequence = 0, selectionEpoch = 0, selectedId = initialId ?? "";
  let criteria: AssetCriteria = { query: "", kind: "" }, initialPending = Boolean(initialId);
  let inFlight: { key: string; promise: Promise<boolean> } | undefined;
  const cached = new Map<string, D>();
  async function request<T>(path: string) { return api<T>(path); }
  async function select(id: string) {
    if (!live) return false;
    selectedId = id; selectionEpoch++; const sequence = ++detailSequence;
    if (!id) { onDetail({ state: "EMPTY", id: "" }); return true; }
    const current = () => live && sequence === detailSequence && selectedId === id;
    onDetail({ state: "LOADING", id, value: cached.get(id) });
    try {
      const value = await api<D>(assetResourcePath(id));
      if (!current()) return false;
      if (!validDetail(value, id)) throw Error("资产详情或版本回执不完整，未采用其他资产的结果。");
      if (cached.has(id) && isOlder(value, cached.get(id)!)) throw Error("详情早于已确认版本；保留已读快照，请重新核对。");
      cached.set(id, value); onDetail({ state: "READY", id, value }); return true;
    } catch (cause) {
      if (current()) {
        const error = cause as {status?:number;code?:string} | undefined;
        if (error?.code === "WORKBENCH_SESSION_CHANGED" || [401,403,404].some(status => status === error?.status))
          cached.delete(id);
        onDetail({ ...failure(cause), id, value: cached.get(id) });
      }
      return false;
    }
  }
  async function performSearch(input: AssetCriteria) {
    if (!live) return false;
    const scope = { query: input.query.trim(), kind: input.kind }, sequence = ++catalogSequence, epoch = selectionEpoch;
    criteria = scope;
    const current = () => live && sequence === catalogSequence;
    onCatalog({ state: "LOADING", criteria: scope });
    try {
      const params = new URLSearchParams({ ...(scope.query ? { q: scope.query } : {}), ...(scope.kind ? { kind: scope.kind } : {}) });
      const catalog = Promise.all([
        request<A[]>(`/assets${params.size ? `?${params}` : ""}`), request<M[]>("/metrics"), request<S[]>("/standards"), request<Q[]>("/assets/agent/tasks"),
      ]);
      if (initialPending) { initialPending = false; void select(initialId!); }
      const [assets, metrics, standards, tasks] = await catalog;
      if (!current()) return false;
      if (![assets, metrics, standards, tasks].every(Array.isArray) || !assets.every(validAsset)) throw Error("资产目录响应不完整，数量和空结果尚未确认。");
      onCatalog({ state: "READY", criteria: scope, assets, metrics, standards, tasks });
      if (epoch === selectionEpoch) {
        const next = assets.find(asset => asset.id === selectedId)?.id ?? assets.find(asset => asset.id === initialId)?.id ?? assets.find(asset => asset.id === "landing:raw_positions")?.id ?? assets[0]?.id ?? "";
        void select(next);
      }
      return true;
    } catch (cause) { if (current()) onCatalog({ ...failure(cause), criteria: scope }); return false; }
  }
  async function search(input = criteria) {
    if (!live) return false;
    const scope = { query: input.query.trim(), kind: input.kind }, key = JSON.stringify(scope);
    if (inFlight?.key === key) return inFlight.promise;
    const promise = performSearch(scope); inFlight = { key, promise };
    try { return await promise; } finally { if (inFlight?.promise === promise) inFlight = undefined; }
  }
  function confirmDetail(id: string, value: D) {
    if (!live || value.id !== id || !validDetail(value, id) || cached.has(id) && isOlder(value, cached.get(id)!)) return false;
    cached.set(id, value);
    if (selectedId === id) { detailSequence++; onDetail({ state: "READY", id, value }); }
    return true;
  }
  return { search, select, confirmDetail, refreshDetail: () => select(selectedId), close() { live = false; catalogSequence++; detailSequence++; selectionEpoch++; cached.clear(); } };
}

export type AnnotationValues = { businessName: string; description: string; domain: string; owner: string; tagText: string };
export type AnnotationDraft = { assetId: string; key: string; revision: number; base: AnnotationValues; baseTags: string[]; values: AnnotationValues };
type AnnotationAsset = { id: string; evidenceHash: string; businessName: string; description: string; domain: string; owner?: string; tags: string[]; annotation?: { revision: number } };
const fields = ["businessName", "description", "domain", "owner", "tagText"] as const;
export const annotationKey = (asset: AnnotationAsset) => JSON.stringify([asset.id, asset.evidenceHash, asset.annotation?.revision ?? 0]);
export const annotationValues = (asset: AnnotationAsset): AnnotationValues => ({ businessName: asset.businessName, description: asset.description, domain: asset.domain, owner: asset.owner ?? "数据产品负责人", tagText: asset.tags.join(",") });
export const annotationDirty = (draft: AnnotationDraft) => fields.some(field => draft.values[field] !== draft.base[field]);
export function reconcileAnnotation(draft: AnnotationDraft | undefined, asset: AnnotationAsset, confirmed = true): AnnotationDraft {
  if (draft?.assetId === asset.id && (!confirmed || annotationDirty(draft))) return draft;
  const values = annotationValues(asset); return { assetId: asset.id, key: annotationKey(asset), revision: asset.annotation?.revision ?? 0, base: values, baseTags: [...asset.tags], values: { ...values } };
}
export function rebaseAnnotation(draft: AnnotationDraft, asset: AnnotationAsset): AnnotationDraft {
  if (draft.assetId !== asset.id) throw Error("草稿与所选资产不一致，未切换基线。");
  const base = annotationValues(asset), values = { ...base };
  for (const field of fields) if (draft.values[field] !== draft.base[field]) values[field] = draft.values[field];
  return { assetId: asset.id, key: annotationKey(asset), revision: asset.annotation?.revision ?? 0, base, baseTags: [...asset.tags], values };
}
export const annotationTags = (draft: AnnotationDraft) => draft.values.tagText === draft.base.tagText ? [...draft.baseTags] : [...new Set(draft.values.tagText.split(",").map(tag => tag.trim()).filter(Boolean))];
export const annotationReceiptMatches = (asset: AnnotationAsset, draft: AnnotationDraft) => {
  const current = annotationValues(asset);
  return asset.id === draft.assetId && (asset.annotation?.revision ?? 0) > draft.revision && ["businessName", "description", "domain", "owner"].every(field => current[field as keyof AnnotationValues] === draft.values[field as keyof AnnotationValues].trim()) && JSON.stringify(asset.tags) === JSON.stringify(annotationTags(draft));
};

export const assetSummaryValid = (value: unknown): boolean => {
  const v = value as Record<string, unknown> | null;
  return Boolean(v && isAssetResourceId(v.id) && ["kind", "name", "businessName", "domain", "description", "status", "system"].every(key => typeof v[key] === "string") &&
    typeof v.evidenceHash === "string" && /^[a-f0-9]{64}$/.test(v.evidenceHash) && Array.isArray(v.tags) && v.tags.every(tag => typeof tag === "string") &&
    Array.isArray(v.fields) && v.fields.every(field => field && typeof field.name === "string" && typeof field.type === "string" && typeof field.nullable === "boolean") &&
    (!v.annotation || typeof v.annotation === "object" && Number.isSafeInteger((v.annotation as { revision?: unknown }).revision) && Number((v.annotation as { revision: number }).revision) >= 0));
};
export const assetDetailValid = (value: unknown, id: string): boolean => {
  const v = value as { id?: string; lineage?: { focusAssetId?: string; nodes?: unknown[]; columnLineages?:unknown[];sqlColumnLineageParsed?:boolean;edges?: { id?: unknown; from?: unknown; to?: unknown; type?: unknown; fieldMappings?: unknown[] }[] }; metrics?: unknown[]; standards?: unknown[] } | null;
  return Boolean(assetSummaryValid(value) && v?.id === id && v.lineage?.focusAssetId === id && Array.isArray(v.lineage.nodes) && v.lineage.nodes.every(assetSummaryValid) &&
    Array.isArray(v.lineage.edges) && v.lineage.edges.every(edge => edge && [edge.id, edge.from, edge.to, edge.type].every(text => typeof text === "string") && Array.isArray(edge.fieldMappings)) && Array.isArray(v.metrics) && Array.isArray(v.standards)&&
    (v.lineage.columnLineages===undefined||Array.isArray(v.lineage.columnLineages)&&v.lineage.columnLineages.every(item=>sqlValueLineageValid(item,v.lineage!.nodes!))&&new Set(v.lineage.columnLineages.map(item=>(item as {assetId:string}).assetId)).size===v.lineage.columnLineages.length&&
    v.lineage.sqlColumnLineageParsed===(v.lineage.columnLineages.length>0&&v.lineage.columnLineages.every(item=>(item as {status:string}).status==='COMPLETE'))));
};
