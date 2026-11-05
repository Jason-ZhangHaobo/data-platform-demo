import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDataServicePlan} from '../../src/v2/model.mjs';
test('source-bound provider prompt carries registered field meaning without data rows or arbitrary source properties',async()=>{
 let prompt;
 const result=await generateDataServicePlan({message:'生成当前来源的接口',services:[],releaseRuns:[{id:'synthetic-batch',releaseId:'synthetic-release',rows:[{client_id:'DO_NOT_SEND_CUSTOMER'}]}],
  sourceContext:{id:'stock-cash-t1',name:'股票持仓与可用现金',definition:'仅股票持仓加现金，不等于客户全资产',validationContractId:'securities-stock-cash-five-fixtures-v1',metricLabels:{total_assets:'股票持仓＋可用现金'},rows:['DO_NOT_SEND_CUSTOMER'],token:'DO_NOT_SEND_KEY'}},
  {DASHSCOPE_API_KEY:'synthetic-provider-key'},async(url,options)=>{
   prompt=JSON.parse(JSON.parse(options.body).messages[1].content);
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({serviceType:'DAPI',name:'合成查询',slug:'synthetic-current',sourceReleaseRunId:'synthetic-batch',fields:['client_id','total_assets'],explanation:'只做方案'})}}],usage:{total_tokens:10}}));
  });
 assert.match(prompt.sourceContext.definition,/不等于客户全资产/);assert.equal(prompt.sourceContext.metricLabels.total_assets,'股票持仓＋可用现金');
 assert.equal(JSON.stringify(prompt).includes('DO_NOT_SEND_CUSTOMER'),false);assert.equal(JSON.stringify(prompt).includes('DO_NOT_SEND_KEY'),false);
 assert.equal(prompt.eligibleReleaseRuns[0].id,'synthetic-batch');assert.equal(result.plan.sourceReleaseRunId,'synthetic-batch');
});
