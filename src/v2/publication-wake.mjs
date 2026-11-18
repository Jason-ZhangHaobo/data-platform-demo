import {createSignedTaskWakeDriver,signedTaskWakeView} from './signed-task-wake.mjs';

export const publicationWakeKey=(project,approvalId)=>`${project}:publication-wake:${approvalId}`;
export const publicationWakeView=signedTaskWakeView;

export function createPublicationWakeDriver({project,publish,...options}) {
  return createSignedTaskWakeDriver({...options,project,kind:'publication_wake',protocol:'shuduo-publication-wake/v1',
    codePrefix:'PUBLICATION_WAKE',completedState:'RELEASED',bindingKey:binding=>publicationWakeKey(project,binding.approvalId),
    execute:async(binding,wakeId)=>({releaseId:(await publish(binding,wakeId)).release.id})});
}
