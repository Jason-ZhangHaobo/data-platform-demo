import {AsyncLocalStorage} from 'node:async_hooks';

// One metadata owner at a time. A bounded provider wait may yield ownership,
// but must reacquire it before either its success or failure reaches the caller.
// This never retries work, and ordinary run() callers keep the original policy.
export function createRequestLane({ maxQueued = 32, waitMs = 12000 } = {}) {
  let active;
  const queued = [];
  const context=new AsyncLocalStorage();
  const busy = () => Object.assign(new Error("服务正在处理其他请求，请稍后重试"), { status: 503, code: "REQUEST_LANE_BUSY" });
  const ownershipError=()=>Object.assign(new Error('元数据操作不持有原请求通道'),{code:'REQUEST_LANE_OWNER_REQUIRED'});
  const pump = () => {
    if (active || !queued.length) return;
    const item = queued.shift();
    if(item.resume){
      if(item.owner.closed){item.reject(ownershipError());pump();return;}
      active=item.owner;item.owner.waiting=false;item.resolve();return;
    }
    active=item.owner;item.started = true; item.detach();
    Promise.resolve().then(()=>context.run(item.owner,item.task)).then(item.resolve, item.reject).finally(() => {
      item.owner.closed=true;if(active===item.owner)active=undefined;pump();
    });
  };
  return {
    run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(busy());
      if (active && queued.length >= maxQueued) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        let timer;
        const item = { task, resolve, reject, owner:{closed:false,waiting:false},started: false, detach: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
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
    async waitForProvider(start) {
      const owner=context.getStore();
      if(typeof start!=='function'||!owner||owner.closed||owner.waiting||active!==owner)throw ownershipError();
      // Start synchronously under ownership: reservation/budget/lease checks
      // run before yielding. Only the returned provider promise may be pending.
      const pending=Promise.resolve(start()).then(value=>({value}),error=>({error,failed:true}));
      owner.waiting=true;active=undefined;pump();
      const result=await pending;
      // Resumes cannot time out or be dropped with a disconnected waiter:
      // the engine must regain ownership to record an unknown paid outcome.
      await new Promise((resolve,reject)=>{queued.push({resume:true,owner,resolve,reject});pump();});
      if(result.failed)throw result.error;
      return result.value;
    },
    status: () => ({ active:Boolean(active), queued: queued.length, maxQueued }),
  };
}
