import type { PublishedReportBinding } from './published-report-request.mjs';
type Expected = { reportId: string; runId: string; versionId?: string; resultHash?: string };
export type WealthReportConsumption = {
  protocol: 'shuduo-wealth-report-consumption/v1'; scope: 'LOCAL_TEST_ONLY'; sourceAttribution: 'ENGINEER_AUTHORED';
  status: 'VERIFIED' | 'UNCONFIRMED' | 'PENDING'; source: PublishedReportBinding;
  report: { id: string; runId: string; versionId: string; resultHash: string };
  snapshot: { id: string; contentHash: string; rowCount: number; fields: string[] };
  context: { id: string; name: string };
  services: { type: 'DAPI' | 'XAPI'; serviceId: string; versionId: string; versionNumber: number;
    fields: string[]; childVersionIds: string[]; completePagination: boolean;
    calls: { callId: string; applicationId: string; applicationStatus: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
      page: number; pageSize: number; filtered: boolean; rowCount: number; resultHash: string; finishedAt: string }[] }[];
  verifiedCalls: number; unconfirmedCalls: number; truncated: boolean; publicDeployed: false; agentIndependentE2E: false;
};
export function checkedWealthReportConsumption(value: unknown, expected?: Expected): WealthReportConsumption;
export function readWealthConsumption(client: { request: (path: string) => Promise<unknown> }, expected: Expected): Promise<WealthReportConsumption>;
