import { sha256 } from '../src/v2/delivery.mjs';
import { checkpointCaseScope, readCheckpoint, uuid } from '../src/v2/live-lifecycle-checkpoint.mjs';
import { currentLiveLifecycleContract, liveLifecyclePlan } from '../src/v2/live-lifecycle-evaluation.mjs';
import { normalizeSessionBase } from '../src/v2/session-credential.mjs';

export const firstCloudDevelopmentScope = 'INVITED_FIRST_V3_DEVELOPMENT_WINDOW_V1';
export const firstCloudDevelopmentModes = ['activate','close','rollback'];
export const firstCloudWindowReceiptProtocol = 'SHUDUO_FIRST_V3_WINDOW_RECEIPT_V2';
const hex = (value,length) => typeof value==='string' && value.length===length && /^[a-f0-9]+$/.test(value);
const first = () => liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id});
const requestHash = definition => sha256(JSON.stringify({message:definition.request,sql:definition.seedSql,contextId:definition.contextId}));

function validOrigin(value) {
  try {
    return typeof value === 'string' && new URL(value).origin === value && normalizeSessionBase(value) === value;
  } catch {
    return false;
  }
}

export function validFirstCloudBinding(value) {
  const fields=['protocol','evaluationRunId','caseId','contextId','caseSetDigest','projectId','origin','sourceRevision',
    'checkpointDigest','requestBodyHash','requestKeyHash'];
  if (value?.applicationTree !== undefined) fields.push('applicationTree');
  const plan=first(),[definition]=plan.selectedCases;
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===fields.length &&
    fields.every(key=>Object.hasOwn(value,key)) && value.protocol==='SHUDUO_V3_FIRST_CHECKPOINT_BINDING_V1' &&
    typeof value.evaluationRunId==='string' && uuid.test(value.evaluationRunId) && value.caseId===definition.id &&
    value.contextId===definition.contextId && value.caseSetDigest===plan.caseSetDigest &&
    typeof value.projectId==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.projectId) &&
    validOrigin(value.origin) &&
    hex(value.sourceRevision,40) && (value.applicationTree===undefined || hex(value.applicationTree,40)) && hex(value.checkpointDigest,64) &&
    value.requestBodyHash===requestHash(definition) && hex(value.requestKeyHash,64);
}

export function firstCloudApplicationBinding(inspection, checkpoint) {
  if (!validFirstCloudBinding(checkpoint) || inspection?.protocol !== 'shuduo-control-artifact-inspection/v1' ||
      inspection.applicationSource !== checkpoint.sourceRevision || !hex(inspection.applicationTree,40) ||
      (checkpoint.applicationTree !== undefined && inspection.applicationTree !== checkpoint.applicationTree) ||
      !hex(inspection.operatorSource,40) || !hex(inspection.buildWorkflowSource,40) ||
      !hex(inspection.sha256,64) || !hex(inspection.webIndexSha256,64) ||
      !Number.isSafeInteger(inspection.bytes) || inspection.bytes < 1 || inspection.bytes > 67108864 ||
      !Number.isSafeInteger(inspection.webIndexBytes) || inspection.webIndexBytes < 1 || inspection.webIndexBytes > 300000 ||
      inspection.zipValid !== true || inspection.sensitivePaths !== 0 ||
      !Number.isSafeInteger(inspection.sourceChecks) || inspection.sourceChecks < 1 ||
      !['buildRunId','inspectionRunId','artifactId','buildAttempt'].every(key => typeof inspection[key]==='string' && /^\d+$/.test(inspection[key])) ||
      typeof inspection.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(inspection.artifactDigest)) return undefined;
  const identity = Object.fromEntries(['applicationSource','applicationTree','sha256','bytes','webIndexSha256','webIndexBytes',
    'operatorSource','buildWorkflowSource','buildRunId','inspectionRunId','artifactId','buildAttempt','artifactDigest','sourceChecks'].map(key => [key, inspection[key]]));
  return {...identity, inspectionDigest:sha256(JSON.stringify(identity))};
}

// Project the existing, unsubmitted request. The original key stays in the
// local checkpoint and is never put into a rollout plan or its public output.
export function firstCloudCheckpointBinding(path) {
  const {state,text}=readCheckpoint(path,{privateFile:true});
  return preparedFirstCloudBinding(state,text);
}

export function preparedFirstCloudBinding(state,text) {
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [definition]=plan.selectedCases,[item]=state.outcomes,action=item?.actions?.agent;
  const history = state.sourceRebinds ?? [];
  const rebind = Array.isArray(history) ? history.at(-1) : undefined;
  const binding={protocol:'SHUDUO_V3_FIRST_CHECKPOINT_BINDING_V1',evaluationRunId:state.evaluationRunId,
    caseId:item?.caseId,contextId:definition.contextId,caseSetDigest:state.caseSetDigest,projectId:state.projectId,origin:state.origin,
    sourceRevision:state.reviewedSource,...(rebind ? {applicationTree:rebind.applicationTree} : {}),
    checkpointDigest:sha256(text),requestBodyHash:action?.bodyHash,
    requestKeyHash:typeof action?.key==='string'&&uuid.test(action.key)?sha256(action.key):undefined};
  if (contractId!==currentLiveLifecycleContract.id || state.caseLimit!==1 || state.outcomes.length!==1 ||
      action?.status!=='PREPARED' || action.id!==undefined || item.taskId!==undefined || state.submission!==undefined ||
      !Array.isArray(history) || (history.length>0 && (rebind?.to!==state.reviewedSource || !hex(rebind?.applicationTree,40))) ||
      !validFirstCloudBinding(binding))
    throw Object.assign(new Error('须使用原未提交的云端首例检查点'),{safeCode:'FIRST_CLOUD_CHECKPOINT_INVALID'});
  return binding;
}
