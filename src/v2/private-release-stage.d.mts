type Batch = {status?: string; schedulerTriggered?: boolean; stage?: unknown};

export function privateReleasePendingStage(run: Batch): "SUBMITTING" | "WAITING_FOR_WORKER_RESULT" | "WORKER_RESULT_UNCONFIRMED" | "UNCONFIRMED" | undefined;
export function privateReleasePendingLabel(run: Batch): string | undefined;
