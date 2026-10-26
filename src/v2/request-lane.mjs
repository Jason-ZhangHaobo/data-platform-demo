// One stateful handler at a time per instance. Static assets and validated
// process-local subrequests do not enter this lane. No task replay/retries.
export function createRequestLane({ maxQueued = 32, waitMs = 12000 } = {}) {
  let active = false;
  const queued = [];
  const busy = () => Object.assign(new Error("服务正在处理其他请求，请稍后重试"), { status: 503, code: "REQUEST_LANE_BUSY" });
  const pump = () => {
    if (active || !queued.length) return;
    const item = queued.shift();
    active = true; item.started = true; item.detach();
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { active = false; pump(); });
  };
  return {
    run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(busy());
      if (active && queued.length >= maxQueued) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        let timer;
        const item = { task, resolve, reject, started: false, detach: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
        const cancel = () => {
          if (item.started) return;
          const index = queued.indexOf(item); if (index < 0) return;
          queued.splice(index, 1); item.detach(); reject(busy());
        };
        queued.push(item);
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, waitMs); timer.unref?.();
        pump();
      });
    },
    status: () => ({ active, queued: queued.length, maxQueued }),
  };
}
