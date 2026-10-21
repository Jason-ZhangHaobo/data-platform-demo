// Read-only projection. The route must check task ownership before calling it.
const pick = (record, keys) => Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
export function localTaskPublication(store, project, agent) {
  const deliveries = store.list("agent_delivery_task", project).filter(d => d.sourceAgentTaskId === agent.id);
  const candidates = store.list("release", project).filter(release => {
    if (release.mode === "DURABLE_PRIVATE_RELEASE_V1") return false;
    const bundle = store.get("delivery_package", release.packageId, project);
    if (!bundle?.manifest?.source?.revisionId || !bundle.manifest.source.runId) return false;
    return bundle && bundle.digest === release.packageDigest && release.sourceRevisionId === bundle.manifest?.source?.revisionId && deliveries.some(d => d.packageId === bundle.id && d.packageDigest === bundle.digest && d.sourceRevisionId === bundle.manifest?.source?.revisionId && d.sourceRunId === bundle.manifest?.source?.runId);
  });
  const attempt = agent.attempts?.at(-1);
  const selected = candidates.find(r => {
    const bundle = store.get("delivery_package", r.packageId, project);
    return bundle.manifest.source.revisionId === attempt?.revisionId && bundle.manifest.source.runId === attempt?.runId;
  }) ?? candidates[0];
  if (!selected) return { scope:"LOCAL_TEST_RELEASE", runs:[], alerts:[], events:[] };
  return {
    scope:"LOCAL_TEST_RELEASE",
    release: {...pick(selected, ["id","status","health","packageId","packageDigest","sourceRevisionId"]), runCount:selected.scheduleSpec?.runCount},
    runs:store.list("release_run",project).filter(r => r.releaseId === selected.id).sort((a,b) => a.sequence-b.sequence).map(r => pick(r,["id","status","sequence","schedulerTriggered","durationMs","triggeredAt","finishedAt"])),
    alerts:store.list("monitor_alert",project).filter(a => a.releaseId === selected.id).map(a => pick(a,["id","status","message","recoveryRunId"])),
    events:store.list("monitor_event",project).filter(e => e.releaseId === selected.id).map(e => pick(e,["id","type","observedAt","releaseId","releaseRunId","packageDigest"])),
  };
}
