import {uuid} from './live-lifecycle-checkpoint.mjs';
import {sqlRequirementProtocol} from './sql-requirement-contract.mjs';
import {validStoredCloudV3DevelopmentDrivers} from './cloud-v3-development-drivers.mjs';
import {validBackgroundPreparationEvidence} from './delivery-preparation-evidence.mjs';
import {validPublicationInitiation} from './publication-initiation-evidence.mjs';
import {validStoredPublicationSchedule} from './cloud-release-evidence.mjs';
import {validBatchConsumptionAttribution} from './service-consumption-attribution.mjs';
import {liveEvidenceAttribution} from './live-lifecycle-provenance.mjs';
import {validBackgroundRehearsalEvidence} from './rehearsal-wake.mjs';

const id=value=>typeof value==='string'&&uuid.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const unrecorded='ORIGIN_UNCONFIRMED';
const pending='EVIDENCE_PENDING';
const signed='SIGNED_BACKGROUND_EVENT';

function executionOrigin(triggers) {
  const types=new Set(triggers);
  if (types.size===0 || types.has('UNRECORDED')) return unrecorded;
  return types.size===1 ? triggers[0] : 'MULTIPLE_DRIVERS_RECORDED';
}

function consumptionOrigin(item, publication) {
  const ids=publication?.batchIds;
  if (!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2||!ids.every(id))return pending;
  const proofs=ids.map(batchId=>item.consumption?.[batchId]);
  if (!proofs.every((proof,index)=>proof?.batchId===ids[index]&&['MATCHED','MATCHED_ONLY'].includes(proof.status)&&
      digest(proof.dapiCallIdDigest)&&digest(proof.xapiCallIdDigest))) return pending;
  if (new Set(proofs.flatMap(proof=>[proof.dapiCallIdDigest,proof.xapiCallIdDigest])).size!==4)return unrecorded;
  return proofs.every(proof=>validBatchConsumptionAttribution(proof.attribution,proof)&&
    ['dapi','xapi'].every(type=>proof.attribution[type].evidence.channel==='BEARER_HTTP'))
    ? 'AUTHENTICATED_HTTP_CALLER_UNCONFIRMED' : 'MATCHED_RESULTS_CALLER_UNCONFIRMED';
}

export function cloudV3PhaseAttribution(item, {approvalTimingVerified=false}={}) {
  const {code,developmentDriverEvidence:drivers,rehearsal,actions={}}=item;
  const {agent,delivery,publication}=actions;
  if (agent?.status!=='CONFIRMED' || !id(item.taskId) || agent.id!==item.taskId) return;
  const provenance=liveEvidenceAttribution(item);
  const nativeCode=code?.taskId===item.taskId && code.sourceKind==='AGENT';
  const recorded=Boolean(nativeCode && validStoredCloudV3DevelopmentDrivers(drivers,code));
  const attempts=recorded?drivers.attempts:[];
  const triggers=attempts.flatMap(attempt=>[attempt.modelTrigger,...(attempt.spark?.submissionTriggers??[])]);
  const prepared=Boolean(nativeCode && delivery?.status==='CONFIRMED' && validBackgroundPreparationEvidence(delivery.preparationEvidence,code,delivery));
  const exactPublication=nativeCode && publication?.status==='CONFIRMED' && id(publication.id) && id(publication.verificationId) && delivery?.status==='CONFIRMED' &&
    id(delivery.packageId) && digest(delivery.packageDigest) && publication.packageId===delivery.packageId && publication.packageDigest===delivery.packageDigest &&
    rehearsal?.id===publication.verificationId && publication.sourceRunId===code.runId;
  const published=Boolean(exactPublication && validPublicationInitiation(publication.initiationEvidence,code,publication));
  const scheduled=exactPublication&&validStoredPublicationSchedule(publication.scheduledBatches,publication);
  const verifiedRehearsal=rehearsal?.status==='SUCCEEDED'&&rehearsal.stage==='AWAITING_ENGINEER_REVIEW'&&id(rehearsal.id);
  const requirement=code?.requirementBinding;
  const phases={
    requirements: nativeCode && requirement?.protocol===sqlRequirementProtocol && requirement.taskId===item.taskId &&
      digest(requirement.basisDigest)&&digest(requirement.reportDigest) ? 'STRUCTURED_MODEL_RESULT' : code?unrecorded:pending,
    code: recorded?executionOrigin(attempts.map(attempt=>attempt.modelTrigger)):code?unrecorded:pending,
    sparkDebugging: recorded?executionOrigin(attempts.flatMap(attempt=>attempt.spark?.submissionTriggers??[])):code?unrecorded:pending,
    deliveryFiles: prepared?signed:delivery?.status==='CONFIRMED'?unrecorded:pending,
    fileRehearsal: nativeCode&&validBackgroundRehearsalEvidence(rehearsal?.initiationEvidence,code,delivery,rehearsal)?signed:verifiedRehearsal?unrecorded:pending,
    publication: published?publication.initiationEvidence.trigger:publication?.status==='CONFIRMED'?unrecorded:pending,
    schedulingAndMonitoring: scheduled?'FC_TIMER_AND_SIGNED_WORKER_RESULT':publication?.monitoring?unrecorded:pending,
    authorizedConsumption: exactPublication?consumptionOrigin(item,publication):pending,
  };
  const expectedOrigins={requirements:'STRUCTURED_MODEL_RESULT',code:signed,sparkDebugging:signed,deliveryFiles:signed,
    fileRehearsal:signed,publication:'SIGNED_PUBLICATION_WAKE',schedulingAndMonitoring:'FC_TIMER_AND_SIGNED_WORKER_RESULT'};
  const unconfirmedAutonomousStages=[...Object.keys(expectedOrigins).filter(stage=>phases[stage]!==expectedOrigins[stage]),'authorizedConsumption'];
  return {phases,executionEvidence:provenance.synthetic||item.developmentObservation?.provenance==='TEST_HARNESS'?'TEST_HARNESS':provenance.unconfirmed?'UNCONFIRMED':'STORED',
    intervention:provenance.engineerRescue?'ENGINEER_RESCUE':provenance.humanClarification?'BUSINESS_CLARIFICATION':
    provenance.nonNative?'NON_NATIVE_SOURCE':'NO_RESCUE_RECORDED',
    businessClarificationRecorded:provenance.humanClarification,
    ownerAdvanceRecorded:triggers.includes('OWNER_ADVANCE'),
    approval:exactPublication&&approvalTimingVerified?{status:'RECORDED',waitMs:Date.parse(publication.approvalTiming.approvedAt)-Date.parse(publication.approvalTiming.readyAt)}:{status:'UNCONFIRMED'},
    unconfirmedAutonomousStages,directAutonomousEligible:false};
}
