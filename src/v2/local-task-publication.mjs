import { fundAgentAttributionKind } from "./fund-delivery.mjs";

// Read-only projection. The route must check task ownership before calling it.
const pick = (record, keys) => Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
export function localTaskPublication(store, project, agent, selector, verify) {
  const deliveries = store.list("agent_delivery_task", project).filter(d => d.sourceAgentTaskId === agent.id);
  const candidates = store.list("release", project).filter(release => {
    if (release.mode === "DURABLE_PRIVATE_RELEASE_V1") return false;
    const bundle = store.get("delivery_package", release.packageId, project);
    if (!bundle?.manifest?.source?.revisionId || !bundle.manifest.source.runId) return false;
    return bundle && bundle.digest === release.packageDigest && release.sourceRevisionId === bundle.manifest?.source?.revisionId && deliveries.some(d => d.packageId === bundle.id && d.packageDigest === bundle.digest && d.sourceRevisionId === bundle.manifest?.source?.revisionId && d.sourceRunId === bundle.manifest?.source?.runId);
  });
  const attempt = agent.attempts?.at(-1);
  const exact = selector ? candidates.filter(release => {
    const bundle=store.get("delivery_package",release.packageId,project),approval=store.get("release_approval",release.approvalId,project);
    const attribution = bundle?.manifest?.source?.attribution;
    const sourceMatches = agent.fundPreparation
      ? attribution?.kind === fundAgentAttributionKind && attribution.originAgentTaskId === agent.id &&
        attribution.actorId === agent.submittedBy && attribution.modelMode === agent.mode
      : attribution === undefined;
    return selector.sourceKind==="AGENT"&&[undefined,"AGENT"].includes(release.sourceKind)&&[undefined,"AGENT"].includes(bundle?.sourceKind)&&
      release.sourceAttribution===undefined&&bundle.sourceAttribution===undefined&&sourceMatches&&
      deliveries.some(delivery=>[undefined,"AGENT"].includes(delivery.sourceKind)&&delivery.sourceAttribution===undefined&&
        delivery.packageId===bundle.id&&delivery.packageDigest===bundle.digest&&delivery.sourceRevisionId===bundle.manifest.source.revisionId&&delivery.sourceRunId===bundle.manifest.source.runId)&&
      (!selector.releaseId||release.id===selector.releaseId)&&(!selector.packageDigest||release.packageDigest===selector.packageDigest)&&
      (!selector.sourceRunId||bundle.manifest.source.runId===selector.sourceRunId)&&(!selector.verificationId||approval?.rehearsalId===selector.verificationId);
  }) : undefined;
  if(exact&&exact.length>1)throw Object.assign(Error("存在多个本机发布版本，请指定确切发布编号"),{status:409,code:"PUBLICATION_SELECTOR_AMBIGUOUS"});
  const selected = exact ? exact[0] : candidates.find(r => {
    const bundle = store.get("delivery_package", r.packageId, project);
    return bundle.manifest.source.revisionId === attempt?.revisionId && bundle.manifest.source.runId === attempt?.runId;
  }) ?? candidates[0];
  if (!selected) return { scope:"LOCAL_TEST_RELEASE", runs:[], alerts:[], events:[] };
  const allRuns=store.list('release_run',project).filter(r=>r.releaseId===selected.id),currentRuns=selected.outputContract&&selected.currentRollbackId?allRuns.filter(r=>r.rollbackId===selected.currentRollbackId):allRuns;
  const events = store.list("monitor_event", project).filter(event => event.releaseId === selected.id);
  const alerts = store.list("monitor_alert", project).filter(alert => alert.releaseId === selected.id);
  verify?.(selected, currentRuns, events, alerts);
  const rollbackTargets=selected.outputContract?store.list('release',project).filter(r=>r.id!==selected.id&&['SUPERSEDED_LOCAL','ROLLED_BACK_LOCAL'].includes(r.status)&&r.health==='HEALTHY'&&r.successfulRunCount>=2&&r.outputContract?.id===selected.outputContract.id).slice(0,10).map(r=>{
    const b=store.get('delivery_package',r.packageId,project);
    return {id:r.id,packageDigest:r.packageDigest,metadataHash:r.outputContract.metadataHash,sourceRevisionId:r.sourceRevisionId,successfulRunCount:r.successfulRunCount,...(b?.manifest?.source?.requirement?.taskId?{taskId:b.manifest.source.requirement.taskId}:{})};
  }):undefined;
  return {
    scope:"LOCAL_TEST_RELEASE",
    ...(rollbackTargets?{rollbackTargets,historyRunCount:allRuns.length-currentRuns.length}:{}),
    release: {...pick(selected, ["id","status","health","packageId","packageDigest","sourceRevisionId","outputContract","rolledBackToReleaseId","rolledBackToTaskId","restoredAt"]), runCount:selected.scheduleSpec?.runCount,
      ...(agent.fundPreparation ? { modelMode: agent.mode, agentIndependentE2E: false } : {}),
      ...(selector?{sourceKind:"AGENT",sourceAgentTaskId:agent.id,sourceRunId:store.get("delivery_package",selected.packageId,project).manifest.source.runId,
        verificationId:store.get("release_approval",selected.approvalId,project)?.rehearsalId}:{})},
    runs:currentRuns.sort((a,b) => a.sequence-b.sequence).map(r => pick(r,["id","status","sequence","schedulerTriggered","resultUnknown","durationMs","triggeredAt","finishedAt",
      ...(agent.fundPreparation ? ["executionEvidenceMode"] : [])])),
    alerts:alerts.map(a => pick(a,["id","status","message","recoveryRunId"])),
    events:events.filter(e => !selected.outputContract||!selected.currentRollbackId||!e.releaseRunId||currentRuns.some(r=>r.id===e.releaseRunId)).map(e => pick(e,["id","type","observedAt","releaseId","releaseRunId","packageDigest"])),
  };
}
