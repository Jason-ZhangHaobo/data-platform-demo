import type {PublishedReportBinding} from "./published-report-request.mjs";
export type PrivateBatchSummary = {
  protocol: string; scope: string; source: PublishedReportBinding; digest: string; reportReview: string;
  context: {id: string; name: string; definition: string};
  provenance: {publicationReviewDigest: string; codeDigest: string; monitorEventId: string; observedAt: string;
    businessDate: string; snapshotId: string; snapshotDigest: string; rowCount: number};
  metrics: {id: string; title: string; value: string; field: string; type: string; aggregation: string; evaluatedCount: number}[];
};
export function checkedPrivateBatchReport(value: unknown, expected?: {source?: PublishedReportBinding; downloadDigest?: string}): Promise<PrivateBatchSummary>;
export function readPrivateBatchSummary(client: {request(path: string): Promise<unknown>}, input: {source: PublishedReportBinding; downloadDigest?: string}): Promise<PrivateBatchSummary>;
