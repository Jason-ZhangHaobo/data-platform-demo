import {validateDeliveryPackage} from './delivery.mjs';
import {verifySavedSyncSqlPackageInput} from './sync-sql-saved-lifecycle.mjs';
import {publishedReportHash} from './published-report-source.mjs';

export function checkRegisteredPackageInput({store,project,actor,bundle,ingestion,readSnapshot}) {
 const plan=validateDeliveryPackage(bundle,bundle.digest),input=plan.source.syncInput;
 if(!input)throw Object.assign(Error('此原包没有已登记的冻结持仓输入'),{status:409,code:'INPUT_CHECK_SOURCE_UNAVAILABLE'});
 if(input.actorId!==actor||plan.source.projectId!==project)throw Object.assign(Error('当前身份无权核验此原包输入'),{status:403,code:'INPUT_CHECK_ACCESS_DENIED'});
 const task=store.get('offline_sync_task',input.taskId,project),metadata=store.get('source_metadata',input.metadataVersionId,project);
 if(!task||!metadata||task.metadataVersionId!==metadata.id||task.sourceRevisionId!==input.sourceRevisionId)throw Object.assign(Error('原输入版本或元数据不完整'),{status:409,code:'INPUT_CHECK_SOURCE_UNAVAILABLE'});
 const csv=ingestion.readRegisteredCsv({sourceId:task.sourceId,sourceRevisionId:input.sourceRevisionId,metadataVersionId:input.metadataVersionId,contentHash:metadata.contentHash});
 let checked;
 try{checked=verifySavedSyncSqlPackageInput({store,project,actor,originalPackage:bundle,packageDigest:bundle.digest,csv,readSnapshot});}
 catch(cause){if(/^SYNC_SAVED_[A-Z_]+$/.test(cause.code??''))throw Object.assign(Error('原包输入证据未能全部核对；原文件与批准保留'),{status:409,code:cause.code});throw cause;}
 const {protocol:_protocol,evidenceDigest:_digest,...stage}=checked;
 const result={...stage,protocol:'shuduo-package-input-check/v1',readOnly:true,binding:{packageId:bundle.id,packageDigest:bundle.digest},sourceCsvExposed:false};
 return {...result,evidenceDigest:publishedReportHash(result)};
}
