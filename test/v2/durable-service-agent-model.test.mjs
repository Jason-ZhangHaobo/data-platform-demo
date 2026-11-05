import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDataServicePlan,ModelUnavailable} from '../../src/v2/model.mjs';
import {safeModelDiagnostic} from '../../src/v2/model-diagnostics.mjs';
const input={message:'生成虚构股票与现金DAPI',services:[],releaseRuns:[{id:'synthetic-published-batch',releaseId:'synthetic-release',rows:[{secret:'DO_NOT_SEND_ROWS'}]}],remainingBudget:8000,modelBudgetReservation:{leaseToken:'DO_NOT_SEND_LEASE'}},
 env={DASHSCOPE_API_KEY:'SYNTHETIC_KEY_NOT_REAL',V2_MODEL:'qwen3.7-plus',V2_MODEL_BASE_URL:'https://example.invalid/compatible-mode/v1'};
test('private service model preflight distinguishes unsent key, endpoint and context failures without network',async()=>{
 let calls=0;const never=async()=>{calls++;throw Error('must not send');};
 for(const [value,settings,code] of [[input,{},'MODEL_KEY_MISSING'],[input,{...env,V2_MODEL_BASE_URL:'http://example.invalid'},'MODEL_CONFIG_INVALID'],[{...input,remainingBudget:300},env,'MODEL_CONTEXT_BUDGET']]){
  await assert.rejects(()=>generateDataServicePlan(value,settings,never),error=>{const diagnostic=safeModelDiagnostic(error);assert.equal(diagnostic.phase,'PREPARE');assert.equal(diagnostic.requestMayHaveBeenSent,false);assert.equal(diagnostic.code,code);if(code==='MODEL_KEY_MISSING')assert.ok(error instanceof ModelUnavailable);return true;});
 }
 assert.equal(calls,0);
});
test('provider response and parse failures remain possibly sent, while diagnostics never preserve raw secrets',async()=>{
 for(const [fetchImpl,phase,code]of [[async()=>new Response('DO_NOT_PERSIST_PROVIDER_BODY',{status:429}),'RESPONSE','MODEL_HTTP_ERROR'],[async()=>new Response('{"choices":[{"message":{"content":"DO_NOT_PERSIST_PROVIDER_BODY"}}]}'),'PARSE','MODEL_RESPONSE_INVALID'],[async()=>{throw Object.assign(Error('DO_NOT_PERSIST_PROVIDER_BODY'),{cause:{code:'ECONNRESET'}});},'REQUEST','MODEL_TRANSPORT_ERROR']]){
  await assert.rejects(()=>generateDataServicePlan(input,env,fetchImpl),error=>{const diagnostic=safeModelDiagnostic(error);assert.equal(diagnostic.phase,phase);assert.equal(diagnostic.code,code);assert.equal(diagnostic.requestMayHaveBeenSent,true);assert.equal(JSON.stringify(diagnostic).includes('DO_NOT_PERSIST'),false);assert.equal(error.message.includes('DO_NOT_PERSIST'),false);if(code==='MODEL_RESPONSE_INVALID')assert.match(error.message,/数据服务方案/);return true;});
 }
});
test('actual adapter request bounds output in its reservation and sends no rows or internal lease',async()=>{
 let sent;const generated=await generateDataServicePlan(input,env,async(url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({serviceType:'DAPI',name:'证券查询',slug:'synthetic-planner',sourceReleaseRunId:'synthetic-published-batch',fields:['client_id'],explanation:'仅读取该批次'})}}],usage:{total_tokens:700,prompt_tokens:500,completion_tokens:200}}));});
 assert.equal(generated.plan.slug,'synthetic-planner');assert.ok(sent.max_tokens>=256&&sent.max_tokens<=1800);assert.ok(Buffer.byteLength(JSON.stringify(sent.messages),'utf8')+sent.max_tokens+256<=8000);
 for(const key of ['DO_NOT_SEND_ROWS','DO_NOT_SEND_LEASE','SYNTHETIC_KEY_NOT_REAL','modelBudgetReservation'])assert.equal(JSON.stringify(sent).includes(key),false,key);
});
