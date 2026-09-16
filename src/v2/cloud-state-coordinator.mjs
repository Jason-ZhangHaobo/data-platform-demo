export class CloudStateCoordinator {
  constructor({ metadata, dataState }) {
    this.metadata = metadata;
    this.dataState = dataState;
    this.dirty = false;
    this.closed = false;
    this.flushQueue = Promise.resolve();
    this.lastFlushError = undefined;
    this.metadata.setMutationListener?.(() => this.#markDirty());
    this.dataState.setMutationListener?.(() => this.#markDirty());
  }

  async refresh() {
    if (this.closed) throw new Error("云端状态协调器已关闭");
    if (this.lastFlushError) {
      const dataState = await this.dataState.refresh(),
        metadata = await this.metadata.refresh();
      this.dirty = false;
      this.lastFlushError = undefined;
      return { metadata, dataState, recoveredFromConflict: true };
    }
    if (this.dirty || this.metadata.dirty || this.dataState.dirty)
      await this.flush();
    const metadata = await this.metadata.refresh(),
      dataState = await this.dataState.refresh();
    return { metadata, dataState };
  }

  async flush() {
    if (this.closed) throw new Error("云端状态协调器已关闭");
    this.flushQueue = this.flushQueue
      .catch(() => undefined)
      .then(async () => {
        while (this.dirty || this.metadata.dirty || this.dataState.dirty) {
          this.dirty = false;
          try {
            // Data first: a metadata record must never point at a state snapshot
            // that has not reached durable storage yet. A failed metadata CAS may
            // leave an unreferenced OSS revision, which is safe to overwrite after
            // refreshing in the single-instance pilot deployment.
            await this.dataState.flush();
            await this.metadata.flush();
            this.lastFlushError = undefined;
          } catch (error) {
            this.dirty = true;
            this.lastFlushError = error;
            throw error;
          }
        }
      });
    return this.flushQueue;
  }

  replicationStatus() {
    return {
      mode: "single-instance-two-store-cas",
      healthy: !this.lastFlushError,
      metadata: this.metadata.replicationStatus(),
      dataState: this.dataState.replicationStatus(),
      consistencyBoundary:
        "OSS data state is persisted before MySQL metadata; FC concurrency must remain 1 during the pilot.",
    };
  }

  async closeReplicated({ closeDataStores = true } = {}) {
    if (this.closed) return;
    if (this.dirty || this.metadata.dirty || this.dataState.dirty)
      await this.flush();
    this.closed = true;
    this.metadata.setMutationListener?.(undefined);
    this.dataState.setMutationListener?.(undefined);
    await this.dataState.closeReplicated({ closeStores: closeDataStores });
    await this.metadata.closeReplicated();
  }

  #markDirty() {
    this.dirty = true;
    queueMicrotask(() => {
      if (!this.closed)
        this.flush().catch((error) => {
          this.lastFlushError = error;
        });
    });
  }
}
