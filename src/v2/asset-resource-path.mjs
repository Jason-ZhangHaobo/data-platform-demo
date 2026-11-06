export const isAssetResourceId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,159}$/.test(value);

// Colons are valid path-segment characters in the platform's technical IDs.
// Keep their canonical form; encoded paths remain rejected by FC ingress.
export function assetResourcePath(id, action) {
  if (!isAssetResourceId(id)) throw new Error("资产编号格式不合法，未发送请求");
  if (action !== undefined && !["annotation", "lineage", "impact"].includes(action)) throw new Error("资产操作不受支持");
  return `/assets/${id}${action ? `/${action}` : ""}`;
}
