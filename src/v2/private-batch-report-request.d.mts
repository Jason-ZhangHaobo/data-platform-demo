import type { PublishedReportBinding } from "./published-report-request.mjs";
export const privateBatchReportRoute: string;
export function privateBatchReportPath(source: PublishedReportBinding, downloadDigest?: string): string;
export function privateBatchReportQuery(params: URLSearchParams): {source: PublishedReportBinding; downloadDigest: string | null};
