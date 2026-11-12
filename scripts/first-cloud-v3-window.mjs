import { sha256 } from '../src/v2/delivery.mjs';
import { readCheckpoint, uuid } from '../src/v2/live-lifecycle-checkpoint.mjs';
import { cloudV3CheckpointCase, validCloudV3DerivationSource, validCloudV3Predecessor } from '../src/v2/cloud-v3-case-selection.mjs';
import { currentLiveLifecycleContract, liveLifecycleCases, liveLifecyclePlan } from '../src/v2/live-lifecycle-evaluation.mjs';
import { normalizeSessionBase } from '../src/v2/session-credential.mjs';

export const firstCloudDevelopmentScope = 'INVITED_FIRST_V3_DEVELOPMENT_WINDOW_V1';
export const firstCloudDevelopmentModes = ['activate','close','rollback'];
export const firstCloudWindowReceiptProtocol = 'SHUDUO_FIRST_V3_WINDOW_RECEIPT_V2';
export const nextCloudDevelopmentScope = 'INVITED_NEXT_V3_DEVELOPMENT_WINDOW_V1';
export const nextCloudWindowReceiptProtocol = 'SHUDUO_NEXT_V3_WINDOW_RECEIPT_V1';
export const cloudV3DevelopmentScope = scope => scope === firstCloudDevelopmentScope || scope === nextCloudDevelopmentScope;
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

function validCloudBinding(value, next) {
  const fields=['protocol','evaluationRunId','caseId','contextId','caseSetDigest','projectId','origin','sourceRevision',
    'checkpointDigest','requestBodyHash','requestKeyHash'];
  if (value?.applicationTree !== undefined) fields.push('applicationTree');
  if (next) fields.push('previousCase');
  const cases=liveLifecycleCases(currentLiveLifecycleContract.id), index=next?cases.findIndex(item=>item.id===value?.caseId):0;
  const definition=cases[index], derived=definition?.kind==="DERIVED";
  if (derived) fields.push("derivationSource");
  return definition && (!next || index>0) && value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===fields.length &&
    fields.every(key=>Object.hasOwn(value,key)) &&
    value.protocol===(next?'SHUDUO_V3_NEXT_CHECKPOINT_BINDING_V1':'SHUDUO_V3_FIRST_CHECKPOINT_BINDING_V1') &&
    typeof value.evaluationRunId==='string' && uuid.test(value.evaluationRunId) && value.caseId===definition.id &&
    value.contextId===definition.contextId && value.caseSetDigest===first().caseSetDigest &&
    typeof value.projectId==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.projectId) &&
    validOrigin(value.origin) &&
    (!next || validCloudV3Predecessor(value.previousCase,value.origin,index+1,derived)) &&
    hex(value.sourceRevision,40) && (value.applicationTree===undefined || hex(value.applicationTree,40)) && hex(value.checkpointDigest,64) &&
    (derived ? validCloudV3DerivationSource(definition,value.derivationSource) && hex(value.requestBodyHash,64)
      : value.requestBodyHash===requestHash(definition)) && hex(value.requestKeyHash,64);
}
export const validFirstCloudBinding = value => validCloudBinding(value,false);
export const validNextCloudBinding = value => validCloudBinding(value,true);

export function firstCloudApplicationBinding(inspection, checkpoint) {
  if (!validFirstCloudBinding(checkpoint)) return;
  return cloudWindowApplicationBinding(inspection,checkpoint);
}

export function cloudWindowApplicationBinding(inspection, checkpoint) {
  if (!(validFirstCloudBinding(checkpoint)||validNextCloudBinding(checkpoint)) || inspection?.protocol !== 'shuduo-control-artifact-inspection/v1' ||
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
  if (state?.caseLimit!==1) throw Object.assign(new Error('须使用原未提交的云端首例检查点'),{safeCode:'FIRST_CLOUD_CHECKPOINT_INVALID'});
  return preparedCloudBinding(state,text);
}

export function cloudWindowCheckpointBinding(path) {
  const {state,text}=readCheckpoint(path,{privateFile:true});
  return preparedCloudBinding(state,text);
}

function preparedCloudBinding(state,text) {
  const {definition,item}=cloudV3CheckpointCase(state), action=item.actions?.agent;
  const next=state.caseLimit>1;
  const history = state.sourceRebinds ?? [];
  const rebind = Array.isArray(history) ? history.at(-1) : undefined;
  const binding={protocol:next?'SHUDUO_V3_NEXT_CHECKPOINT_BINDING_V1':'SHUDUO_V3_FIRST_CHECKPOINT_BINDING_V1',evaluationRunId:state.evaluationRunId,
    caseId:item?.caseId,contextId:definition.contextId,caseSetDigest:state.caseSetDigest,projectId:state.projectId,origin:state.origin,
    sourceRevision:state.reviewedSource,...(rebind ? {applicationTree:rebind.applicationTree} : {}),
    checkpointDigest:sha256(text),requestBodyHash:action?.bodyHash,
    requestKeyHash:typeof action?.key==='string'&&uuid.test(action.key)?sha256(action.key):undefined,
    ...(next?{previousCase:state.previousCase}:{}),
    ...(item.derivationSource?{derivationSource:item.derivationSource}:{})};
  if (action?.status!=='PREPARED' || action.id!==undefined || item.taskId!==undefined || state.submission!==undefined ||
      !Array.isArray(history) || (history.length>0 && (rebind?.to!==state.reviewedSource || !hex(rebind?.applicationTree,40))) ||
      !validCloudBinding(binding,next))
    throw Object.assign(new Error('须使用原未提交的云端案例检查点'),{safeCode:next?'NEXT_CLOUD_CHECKPOINT_INVALID':'FIRST_CLOUD_CHECKPOINT_INVALID'});
  return binding;
}
