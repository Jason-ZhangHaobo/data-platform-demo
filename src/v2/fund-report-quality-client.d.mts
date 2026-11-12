import type { PublishedReportLineage } from './published-report-client.mjs';

type Client = { request: (path: string, options?: { method: string; body: unknown }) => Promise<unknown> };
type Binding = Pick<PublishedReportLineage, 'requestId' | 'source' | 'report'> & {
  snapshot: Pick<PublishedReportLineage['snapshot'], 'id' | 'contentHash' | 'rowCount'>;
  release: Pick<PublishedReportLineage['release'], 'businessDate'>;
};
type QualityCheck = {
  id: string; status: 'PASSED' | 'FAILED'; evaluatedCount: number; passedCount: number; failedCount: number;
  passRate: number; durationMs: number; actualExecution: true; fullLifecycleE2E: false;
};
export type FundReportQuality = Omit<Binding, 'release'> & {
  protocol: 'shuduo-fund-report-quality/v1'; scope: 'LOCAL_TEST_ONLY'; ruleSet: 'fund-snapshot-quality/v1';
  businessDate: string; basisDigest: string; publicDeployed: false;
} & ({ status: 'PENDING'; actualExecution: false } | {
  status: 'PASSED' | 'FAILED'; actualExecution: true; checkId: string; receiptDigest: string;
  checkedAt: string; checks: QualityCheck[];
});
export function fundQualityRules(businessDate: string): { id: string; name: string; field: string; type: string; config: object }[];
export function checkedFundReportQuality(value: unknown, expected?: { requestId?: string; lineage?: Binding }): FundReportQuality;
export function readFundReportQuality(client: Client, input: { requestId: string; lineage?: Binding }): Promise<FundReportQuality>;
export function runFundReportQuality(client: Client, reviewed: { requestId: string; snapshotId: string; basisDigest: string; confirm: boolean }, lineage?: Binding): Promise<FundReportQuality>;
