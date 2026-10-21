type Snapshot = { release?: { status: string }; runs: { status: string }[] };
export function publicationStopped(status?: string) {
  return ["CANCELLED", "ROLLED_BACK", "ROLLED_BACK_LOCAL", "SUPERSEDED_LOCAL", "FAILED", "FAILED_LOCAL"].includes(status ?? "");
}
export function publicationPollNeeded(value: Snapshot) {
  if (!value.release || publicationStopped(value.release.status)) return false;
  return value.runs.some(run => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status));
}

// Single-flight reads; an obsolete response must never replace a publish receipt
// or another task's state. No writes/retries are performed by this reader.
export function createPublicationReader<T>({ read, onValue, onError }: {
  read: () => Promise<T>; onValue: (value: T) => void; onError: (error: unknown) => void;
}) {
  let generation = 0, closed = false, pending: Promise<void> | undefined;
  return {
    refresh(): Promise<void> {
      if (closed) return Promise.resolve();
      if (pending) return pending;
      const stamp = generation;
      const request = Promise.resolve().then(read).then(value => {
        if (!closed && stamp === generation) onValue(value);
      }, error => { if (!closed && stamp === generation) onError(error); });
      const completion = request.finally(() => { if (pending === completion) pending = undefined; });
      pending = completion;
      return completion;
    },
    invalidate() { generation++; pending = undefined; },
    close() { generation++; closed = true; pending = undefined; },
  };
}
