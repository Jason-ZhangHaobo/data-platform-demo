// Display/protocol coverage only; no model, Spark or cloud execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {allContextIds,validationFamilyForContext} from '../../src/v2/context.mjs';
import {validationFamilyForContextId,regressionsMatchFamily} from '../../web/src/validation-family.ts';
import {agentJourney} from '../../web/src/agent-journey.ts';
import {deliveryFiles} from '../../src/v2/delivery.mjs';
function fixture(contextId){
 const family=validationFamilyForContext(contextId);
 return{taskId:'synthetic-task',contextId,revisionId:'revision-one',runId:'run-one',dirty:false,
 report:{taskId:'synthetic-task',contextId,validationContractId:family.id,revisionId:'revision-one',runId:'run-one',status:'PASSED',checks:['revision','execution','results','regressions'].map(id=>({id,passed:true}))},
 delivery:{status:'SUCCEEDED',packageId:'package-one',packageDigest:'digest-one',verificationId:'verify-one',sourceRevisionId:'revision-one',sourceRunId:'run-one'},
 bundle:{id:'package-one',digest:'digest-one',files:Object.fromEntries(deliveryFiles.map(name=>[name,'synthetic fixture']))},
 verification:{id:'verify-one',status:'SUCCEEDED',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:{passed:true,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))}}};
}
test('browser-known contract scopes match every server context without importing server filesystem code',()=>{
 for(const id of allContextIds){const actual=validationFamilyForContextId(id),server=validationFamilyForContext(id);assert.equal(actual.id,server.id);assert.deepEqual(actual.contextIds,server.contextIds);}
 assert.equal(validationFamilyForContextId('unknown-context'),undefined);
});
test('stock file rehearsal can pass only its own complete five-case scope',()=>{
 const stock=fixture('stock-cash-t1');assert.equal(agentJourney(stock).fileVerified,true);
 const legacy=fixture('holdings-t1');assert.equal(agentJourney({...stock,verification:legacy.verification}).fileVerified,false);
 for(const change of [f=>f.verification.validation.regressions.pop(),f=>f.verification.validation.regressions.push({contextId:'cash-change',passed:true}),
  f=>f.verification.validation.regressions[1]=f.verification.validation.regressions[0],f=>f.report.validationContractId=legacy.report.validationContractId,
  f=>f.report.contextId='holdings-t1',f=>f.contextId='unknown-context']){
  const f=structuredClone(stock);change(f);assert.equal(agentJourney(f).fileVerified,false);
 }
});
test('explicitly foreign, blank or malformed validation cannot become a green family check',()=>{
 const family=validationFamilyForContextId('stock-cash-t1'),validation=fixture('stock-cash-t1').verification.validation;
 assert.equal(regressionsMatchFamily(validation,family),true);
 for(const contractId of ['securities-assets-five-fixtures-2026-09-14','',null])assert.equal(regressionsMatchFamily({...validation,contractId},family),false);
 assert.equal(regressionsMatchFamily({...validation,regressions:[null,...validation.regressions.slice(1)]},family),false);
});
