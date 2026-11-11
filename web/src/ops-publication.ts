type MonitorTarget = {
  taskId: string;
  releaseId: string;
  revisionId: string;
  firstBatchId: string;
  secondBatchId: string;
};

const fields = ["taskId", "releaseId", "revisionId", "firstBatchId", "secondBatchId"] as const;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const valid = (target: Partial<MonitorTarget>): target is MonitorTarget =>
  fields.every(field => uuid(target[field])) && target.firstBatchId !== target.secondBatchId;

export function opsPublicationTarget(href: string): MonitorTarget | undefined | null {
  const url = new URL(href);
  const query = url.searchParams;
  if (query.get("module") !== "ops" || !fields.some(field => query.has(field))) return undefined;
  if (url.pathname !== "/v2/" || query.size !== fields.length + 1 ||
      !fields.every(field => query.getAll(field).length === 1)) return null;
  const target = Object.fromEntries(fields.map(field => [field, query.get(field) ?? ""]));
  return valid(target) ? target : null;
}

type SavedRelease = {
  id?: string; sourceAgentTaskId?: string; sourceRevisionId?: string;
  sourceRunId?: string; scope?: string; sourceKind?: string; reviewDigest?: string;
  packageId?: string; packageDigest?: string; runCount?: number;
  status?: string; health?: string;
};
type SavedBatch = {
  id?: string; releaseId?: string; sourceAgentTaskId?: string; sourceRunId?: string;
  sourceKind?: string; reviewDigest?: string; packageId?: string; packageDigest?: string;
  sequence?: number; status?: string; schedulerTriggered?: boolean;
};
type Reader = <T>(path: string) => Promise<T>;

export async function readOpsPublication(api: Reader, target: MonitorTarget) {
  const [release, first, second] = await Promise.all([
    api<SavedRelease>("/releases/" + target.releaseId),
    api<SavedBatch>("/release/runs/" + target.firstBatchId),
    api<SavedBatch>("/release/runs/" + target.secondBatchId),
  ]);
  if (release?.id !== target.releaseId || release.sourceAgentTaskId !== target.taskId ||
      release.sourceRevisionId !== target.revisionId || release.scope !== "PRIVATE_CLOUD_TEST" ||
      release.sourceKind !== "AGENT" || release.runCount !== 2 || !uuid(release.sourceRunId) ||
      !uuid(release.packageId) || !hash(release.packageDigest) || !hash(release.reviewDigest) ||
      ![first, second].every((batch, index) => batch?.id === (index === 0 ? target.firstBatchId : target.secondBatchId) &&
        batch.sequence === index + 1 && batch.releaseId === release.id &&
        batch.sourceAgentTaskId === release.sourceAgentTaskId && batch.sourceRunId === release.sourceRunId &&
        batch.sourceKind === release.sourceKind && batch.reviewDigest === release.reviewDigest &&
        batch.packageId === release.packageId && batch.packageDigest === release.packageDigest))
    throw new Error("原发布、代码版本或两个批次的来源不一致。");
  return {status:release.status, health:release.health,
    batches:[first, second].map(({id, sequence, status, schedulerTriggered}) => ({id, sequence, status, schedulerTriggered}))};
}
