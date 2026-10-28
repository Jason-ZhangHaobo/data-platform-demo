import { validationFamilyForContextId } from "./validation-family.ts";

type DeliverySourceRun = {
  id: string;
  status: string;
  contextId?: string;
  validationContractId?: string;
  validation?: { contractId?: string };
};
type SourceOptions = {
  contractId?: string;
  sourceRunId?: string;
  lockSource?: boolean;
  currentSource?: string;
};

export function deliverySourceSelection<T extends DeliverySourceRun>(runs: T[], options: SourceOptions = {}) {
  const { contractId, sourceRunId, lockSource = false, currentSource = "" } = options;
  const locked = lockSource || sourceRunId !== undefined;
  const eligible = runs.filter(run => {
    if (run.status !== "SUCCEEDED" || (locked && run.id !== sourceRunId)) return false;
    // Both entry points resolve the run's family independently; a locked handoff
    // must additionally match its explicitly supplied contract.
    const expectedContract = validationFamilyForContextId(run.contextId)?.id;
    if (!expectedContract || run.validationContractId !== expectedContract) return false;
    if (lockSource && contractId !== expectedContract) return false;
    // Missing legacy context metadata is accepted only with the explicit known legacy contract.
    // A missing/unknown stock context cannot be silently reclassified as legacy.
    return run.validation?.contractId === undefined || run.validation.contractId === expectedContract;
  });
  const source = locked
    ? eligible.find(run => run.id === sourceRunId)?.id ?? ""
    : currentSource
      ? eligible.find(run => run.id === currentSource)?.id ?? ""
      : eligible[0]?.id ?? "";
  const issue = locked && !source
    ? "指定来源不存在或未通过其业务口径验证；已锁定该来源，不会改选其他运行。"
    : currentSource && !source
      ? "原选择已不符合业务口径验证，请明确重新选择来源。"
      : "";
  return { eligible, source, locked, issue };
}
