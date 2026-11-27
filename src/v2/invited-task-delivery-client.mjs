import {uuid,digest} from './chat-change-resource.mjs';
import {verifiedDeliveryBytes} from './delivery-file-bytes.mjs';
import {invitedTaskDeliveryPath,invitedTaskDeliveryRequestId} from './invited-task-delivery.mjs';

const states=new Set(['QUEUED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED']);
const mismatch=()=>Error('原任务、SQL 版本、运行批次或交付文件不一致，请重新读取所选版本。');

export async function readInvitedTaskDelivery(client,selection){
  const value=await client.request(invitedTaskDeliveryPath(selection));
  const {report,delivery,package:bundle,verification}=value??{};
  if(report?.schema!=='shuduo-development-verification/v1' || report.taskId!==selection.taskId ||
    report.revisionId!==selection.revisionId || report.revisionHash!==selection.revisionHash || report.runId!==selection.runId ||
    report.sourceKind==='MANUAL' || value.publication?.scope!=='PRIVATE_CLOUD_TEST' ||
    !['PENDING','PASSED','NEEDS_ATTENTION'].includes(report.status))throw mismatch();
  const sourceForPreparation=value.preparationSource;
  if(sourceForPreparation && (report.status!=='PASSED' || sourceForPreparation.revisionId!==selection.revisionId ||
    sourceForPreparation.revisionHash!==selection.revisionHash || sourceForPreparation.runId!==selection.runId))throw mismatch();
  if(selection.deliveryId!==undefined && delivery?.id!==selection.deliveryId)throw mismatch();
  if(delivery!==undefined && (!uuid(delivery?.id) || !states.has(delivery.status) || delivery.sourceAgentTaskId!==selection.taskId ||
    delivery.sourceRevisionId!==selection.revisionId || delivery.sourceRunId!==selection.runId ||
    delivery.sourceSqlHash!==selection.revisionHash || delivery.sourceKind==='MANUAL'))throw mismatch();
  if(bundle!==undefined || delivery?.packageId!==undefined){
    const source=bundle?.manifest?.source;
    if(!delivery || !uuid(bundle?.id) || bundle.id!==delivery.packageId || !digest(bundle.digest) ||
      bundle.digest!==delivery.packageDigest || bundle.manifest?.format!=='shuduo-delivery/v1' || bundle.manifest.releaseState!=='NOT_PUBLISHED' ||
      source?.revisionId!==selection.revisionId || source.runId!==selection.runId || source.sqlHash!==selection.revisionHash ||
      source.contextId!==report.contextId || source.validationContractId!==report.validationContractId ||
      !await verifiedDeliveryBytes(bundle,selection.revisionHash))throw mismatch();
  }
  if(verification!==undefined || delivery?.verificationId!==undefined){
    if(!bundle || !uuid(verification?.id) || verification.id!==delivery?.verificationId || !states.has(verification.status))throw mismatch();
  }
  if(delivery?.status==='SUCCEEDED' && !verification)throw mismatch();
  const evidence=value.invitedRehearsalEvidence;
  if(verification?!['VERIFIED','FAILED','PENDING','UNCONFIRMED'].includes(evidence):evidence!==undefined)throw mismatch();
  if(evidence==='VERIFIED'){
    const expected=JSON.parse(bundle.files['fixtures.json']).validationContexts?.map(c=>c.id);
    const checks=verification.validation?.regressions;
    if(report.status!=='PASSED' || verification.status!=='SUCCEEDED' || delivery.status!=='SUCCEEDED' ||
      verification.engine!=='Apache Spark' || verification.mainSqlExecuted!==true || verification.testSqlValidation?.passed!==true ||
      verification.validation?.passed!==true || !Array.isArray(expected) || expected.length===0 || new Set(expected).size!==expected.length ||
      !Array.isArray(checks) || checks.length!==expected.length || !expected.every(id=>checks.some(c=>c.contextId===id && c.passed===true)))throw mismatch();
  }
  if(evidence==='FAILED' && verification.status!=='FAILED' ||
    evidence==='PENDING' && !['QUEUED','RUNNING'].includes(verification.status))throw mismatch();
  const settled=verification?.settlementEvidence;
  if(settled && (settled.deliveryId!==delivery.id || settled.packageId!==bundle.id || settled.packageDigest!==bundle.digest ||
    settled.verificationId!==verification.id || !digest(settled.workerResultDigest)))throw mismatch();
  return sourceForPreparation ? {...value,preparationRequestId:await invitedTaskDeliveryRequestId(selection)} : value;
}
