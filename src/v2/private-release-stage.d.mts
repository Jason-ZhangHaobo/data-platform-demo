type Batch = {status?: string; schedulerTriggered?: boolean; stage?: unknown};

export function privateReleasePendingStage(run: Batch): "SUBMITTING" | "WAITING_FOR_WORKER_RESULT" | "UNCONFIRMED" | undefined;
export function privateReleasePendingLabel(run: Batch): string | undefined;
