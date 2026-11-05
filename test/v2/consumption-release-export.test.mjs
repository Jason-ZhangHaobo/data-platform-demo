import test from 'node:test';
import assert from 'node:assert/strict';
import {privateEvidenceExport,exportedEvidence,privatePayload} from '../../scripts/run-v2-cloudshell-preview.mjs';
const task='00000000-0000-4000-8000-000000000001',release='00000000-0000-4000-8000-000000000002',digest='a'.repeat(64);
test('private consumption download preserves exact release selection and rejects mismatched evidence without new writes',()=>{
 const path=`/api/v2/evidence-export?kind=consumption&id=${task}&digest=${digest}&releaseId=${release}`,
  request=privateEvidenceExport(path),body={protocol:'shuduo-private-task-consumption/v1',scope:'PRIVATE_CLOUD_TEST',publicDeployed:false,taskId:task,packageDigest:digest,releaseId:release,sourceKind:'MANUAL',agentIndependentE2E:false};
 assert.equal(request.path,`/api/v2/data-services/task-evidence?agent_task_id=${task}&package_digest=${digest}&release_id=${release}`);
 const payload=privatePayload('GET',request.path,{},undefined,{allowDataServices:true});assert.equal(payload.method,'GET');assert.equal(payload.body,undefined);
 assert.equal(JSON.parse(exportedEvidence({body},request).text).releaseId,release);
 for(const changed of [undefined,task])assert.throws(()=>exportedEvidence({body:{...body,releaseId:changed}},request),{status:502});
 for(const suffix of ['&releaseId='+release,'&actorId=other'])assert.throws(()=>privateEvidenceExport(path+suffix),{status:422});
 assert.throws(()=>privateEvidenceExport(path.replace(release,'bad/id')),{status:422});
 const legacy=privateEvidenceExport(path.replace('&releaseId='+release,''));assert.equal(legacy.releaseId,undefined);assert.doesNotThrow(()=>exportedEvidence({body:{...body,releaseId:undefined}},legacy));
});
