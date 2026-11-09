import {resolveManualContinuation} from './manual-sql-continuation.mjs';
import {standaloneManualDeliveryMode} from './agent-development-workflow.mjs';
import {validateDeliveryPackage,validationMatchesFamily,sha256} from './delivery.mjs';
import {sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const invalid=()=>Object.assign(Error('独立手工发布须绑定本人成功来源、确切交付包与文件演练'),{status:409,code:'MANUAL_PUBLICATION_SOURCE_INVALID'});
export function standaloneManualPublicationSource({store,project,manualDeliveryTaskId,sourceRunId,packageDigest,verificationId,actorId}){
 const delivery=store.get('manual_delivery_task',manualDeliveryTaskId,project);
 if(!delivery||delivery.submittedBy!==actorId)throw Object.assign(Error('无权审阅此独立手工交付'),{status:403});
 if(delivery.mode!==standaloneManualDeliveryMode||delivery.status!=='SUCCEEDED'||delivery.actualExecution!==true||delivery.sourceKind!=='MANUAL'||delivery.sourceAttribution!=='ENGINEER_AUTHORED'||delivery.agentIndependentE2E!==false||delivery.modelRequired!==false||delivery.sourceAgentTaskId!==undefined||delivery.verificationId!==verificationId||delivery.packageDigest!==packageDigest||delivery.sourceRunId!==sourceRunId)throw invalid();
 const proof=resolveManualContinuation({store,project,actorId,sourceRunId,binding:delivery.sourceBinding}),run=store.get('run',sourceRunId,project),revision=store.get('revision',proof.binding.revisionId,project),item=store.get('delivery_package',delivery.packageId,project),verification=store.get('delivery_verification',verificationId,project);
 if(!item||!verification)throw invalid();const plan=validateDeliveryPackage(item,packageDigest),a=plan.source.attribution;
 if(delivery.source?.kind!=='MANUAL_RUN'||delivery.source.runId!==run.id||delivery.source.revisionId!==revision.id||delivery.source.revisionHash!==revision.hash||delivery.sourceRevisionId!==revision.id||delivery.sourceSqlHash!==revision.hash||
   item.manualDeliveryTaskId!==delivery.id||item.agentDeliveryTaskId!==undefined||item.sourceKind!=='MANUAL'||item.agentIndependentE2E!==false||item.sourceRunId!==run.id||plan.source.runId!==run.id||plan.source.revisionId!==revision.id||plan.source.sqlHash!==revision.hash||plan.source.contextId!==revision.contextId||plan.source.validationContractId!==run.validationContractId||
   a?.kind!=='ENGINEER_AUTHORED'||a.actorId!==actorId||a.agentIndependentE2E!==false||a.originAgentTaskId!==undefined||!sameAssistedDevelopmentReference(a.developmentReference,proof.developmentReference)||!sameAssistedDevelopmentReference(delivery.developmentReference,proof.developmentReference)||
   verification.manualDeliveryTaskId!==delivery.id||verification.agentDeliveryTaskId!==undefined||verification.packageId!==item.id||verification.packageDigest!==packageDigest||verification.status!=='SUCCEEDED'||verification.actualExecution!==true||verification.isolation!=='FUNCTION_PROCESS'||verification.mode!=='CLOUD_ISOLATED_FILE_REHEARSAL'||
   verification.engine!=='Apache Spark'||verification.engineVersion!=='3.5.9'||verification.mainSqlExecuted!==true||verification.testDouble===true||verification.testSqlValidation?.passed!==true||verification.testSqlValidation.sqlHash!==sha256(item.files['tests.sql'])||!validationMatchesFamily(verification.validation,{id:plan.source.validationContractId,contextIds:plan.fixtures.validationContexts.map(c=>c.id)}))throw invalid();
 return{delivery,item,verification,plan,run,revision,sourceRunId:run.id};
}
