const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function syncRunSnapshotPath({taskId,runId,page=1,pageSize=50}) {
  if (typeof taskId!=='string'||taskId.length!==36||!uuid.test(taskId)||typeof runId!=='string'||runId.length!==36||!uuid.test(runId)||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)
    throw Error('快照须使用原任务、原运行UUID及有效页码（每页1—100行）');
  return `/sync/tasks/${taskId}/runs/${runId}/snapshot?page=${page}&pageSize=${pageSize}`;
}
