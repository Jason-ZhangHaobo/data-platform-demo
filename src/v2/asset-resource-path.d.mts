export function isAssetResourceId(value: unknown): value is string;
export function assetResourcePath(id: unknown, action?: "annotation" | "lineage" | "impact"): string;
