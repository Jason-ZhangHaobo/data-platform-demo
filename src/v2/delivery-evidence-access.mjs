// Authorization follows stored source records. An evidence ID, digest,
// reviewer name or association asserted by a caller never grants access.
const present = value => typeof value === "string" && value.length > 0;
const consistent = (claimed, actual) => claimed === undefined || claimed === actual;
const boundToPackage = (item, pack) => Boolean(item && pack && item.packageId === pack.id &&
  present(pack.digest) && item.packageDigest === pack.digest);

export function createDeliveryEvidenceAccess({store, project, local, session}) {
  const admin = session?.role === "ADMIN";
  const actor = session?.user?.id;
  const mayReview = Boolean(actor && session?.permissions?.includes("DELIVERY"));
  const read = (kind, id) => present(id) ? store.get(kind, id, project) : undefined;

  function sourceOwner(run, revision, taskId=run?.agentTaskId) {
    if (!run || !revision || run.revisionId !== revision.id ||
        !present(revision.hash ?? revision.codeHash) || run.revisionHash !== (revision.hash ?? revision.codeHash) ||
        !consistent(run.contextId, revision.contextId) || !consistent(run.agentTaskId, taskId)) return undefined;
    if (taskId === undefined) return present(revision.author) ? revision.author : undefined;
    const task = read("agent", taskId);
    if (!present(task?.submittedBy) || task.contextId !== revision.contextId ||
        !consistent(revision.author, task.submittedBy) ||
        !Array.isArray(task.attempts) ||
        !task.attempts.some(attempt => attempt?.revisionId === revision.id && attempt?.runId === run.id)) return undefined;
    return task.submittedBy;
  }

  function deliveryParent(item) {
    if (item.agentDeliveryTaskId !== undefined && item.manualDeliveryTaskId !== undefined) return undefined;
    if (item.agentDeliveryTaskId !== undefined) return read("agent_delivery_task", item.agentDeliveryTaskId);
    return read("manual_delivery_task", item.manualDeliveryTaskId);
  }

  function packageSource(pack) {
    const source = pack?.manifest?.source;
    if (!present(source?.runId) || !consistent(pack.sourceRunId, source.runId) ||
        !consistent(source.projectId, project)) return undefined;
    const python = pack.manifest.format === "shuduo-python-delivery/v1";
    const run = read(python ? "python_run" : "run", source.runId);
    const revision = read(python ? "python_revision" : "revision", source.revisionId);
    if (!run || !revision || (source.sqlHash ?? source.codeHash) !== run.revisionHash ||
        !consistent(source.contextId, revision.contextId)) return undefined;
    const delivery = deliveryParent(pack);
    if ((pack.agentDeliveryTaskId !== undefined || pack.manualDeliveryTaskId !== undefined) && !delivery) return undefined;
    const taskId = run.agentTaskId ?? delivery?.sourceAgentTaskId;
    const owner = sourceOwner(run, revision, taskId);
    if (!owner || !consistent(source.attribution?.actorId, owner)) return undefined;
    const binding = {pack, run, revision, taskId, owner};
    return delivery && !matchesDelivery(delivery, binding) ? undefined : binding;
  }

  function matchesDelivery(delivery, {pack, run, revision, taskId, owner}) {
    return Boolean(delivery && boundToPackage(delivery, pack) && delivery.sourceRunId === run.id &&
      delivery.sourceRevisionId === revision.id &&
      consistent(delivery.sourceSqlHash ?? delivery.sourceCodeHash, run.revisionHash) &&
      consistent(delivery.sourceAgentTaskId, taskId) && consistent(delivery.submittedBy, owner));
  }

  function sourceMatches(item, binding) {
    return consistent(item.sourceRunId, binding.run.id) &&
      consistent(item.sourceRevisionId, binding.revision.id) &&
      consistent(item.sourceSqlHash ?? item.sourceCodeHash, binding.run.revisionHash) &&
      consistent(item.sourceAgentTaskId, binding.taskId);
  }

  function verificationMatches(item, binding) {
    if (!boundToPackage(item, binding.pack) || !sourceMatches(item, binding)) return false;
    if (item.agentDeliveryTaskId === undefined && item.manualDeliveryTaskId === undefined) return true;
    return matchesDelivery(deliveryParent(item), binding);
  }

  function reviewMatches(item, binding) {
    return boundToPackage(item, binding.pack) && sourceMatches(item, binding) &&
      verificationMatches(read("delivery_verification", item.verificationId), binding);
  }

  function approvalMatches(item, binding) {
    if (!boundToPackage(item, binding.pack) || !sourceMatches(item, binding)) return false;
    const review = read("delivery_review", item.reviewId);
    return reviewMatches(review, binding) && item.rehearsalId === review.verificationId;
  }

  function releaseMatches(item, binding) {
    return boundToPackage(item, binding.pack) &&
      approvalMatches(read("release_approval", item.approvalId), binding) && sourceMatches(item, binding) &&
      consistent(item.manualDeliveryTaskId, binding.pack.manualDeliveryTaskId);
  }

  function releaseRunMatches(item, release, binding) {
    return boundToPackage(item, binding.pack) && item.releaseId === release.id && sourceMatches(item, binding) &&
      consistent(item.manualDeliveryTaskId, binding.pack.manualDeliveryTaskId);
  }

  function canRead(kind, item) {
    if (!item) return false;
    if (local || admin) return true;
    if (!mayReview) return false;
    const monitor = kind === "monitor_alert" || kind === "monitor_event";
    const release = kind === "release" ? item : (monitor || kind === "release_run" ? read("release", item.releaseId) : undefined);
    const pack = kind === "delivery_package" ? item : read("delivery_package", release?.packageId ?? item.packageId);
    const binding = packageSource(pack);
    if (binding?.owner !== actor) return false;
    switch (kind) {
      case "delivery_package": return true;
      case "delivery_verification": return verificationMatches(item, binding);
      case "delivery_review": return reviewMatches(item, binding);
      case "release_approval": return approvalMatches(item, binding);
      case "release": return releaseMatches(item, binding);
      case "release_run": return releaseMatches(release, binding) && releaseRunMatches(item, release, binding);
      case "monitor_alert":
      case "monitor_event": {
        if (!releaseMatches(release, binding) || !consistent(item.packageDigest, pack.digest)) return false;
        const recovery = item.recoveryReleaseId === undefined ? undefined : read("release", item.recoveryReleaseId);
        if (item.recoveryReleaseId !== undefined && !canRead("release", recovery)) return false;
        const runId = item.releaseRunId ?? item.runId;
        if (runId === undefined) return true;
        const run = read("release_run", runId);
        return releaseRunMatches(run, release, binding) || Boolean(recovery && run?.releaseId === recovery.id && canRead("release_run", run));
      }
      default: return false;
    }
  }

  return {
    canRead,
    canPrepare(run, revision) {
      return local || admin || (mayReview && sourceOwner(run, revision) === actor);
    },
  };
}
