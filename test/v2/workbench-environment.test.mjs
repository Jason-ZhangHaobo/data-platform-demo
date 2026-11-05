import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workbenchEnvironment,mayWriteServices} from '../../web/src/workbench-environment.ts';

const cloud={mode:'PUBLIC_INVITATION',dataServices:{privateEnabled:true,scope:'PRIVATE_CLOUD_TEST'}};
const scopedLocal={mode:'LOCAL_DEVELOPMENT',dataServices:{localSourcesEnabled:true,scope:'LOCAL_TEST_ONLY'}};
test('invited cloud service handoff is selected by server capability without preview metadata',()=>{
 const state=workbenchEnvironment(cloud);
 assert.equal(state.servicesAvailable,true);assert.equal(state.cloudServices,true);assert.equal(state.agentServiceHandoffAvailable,true);
 assert.equal(state.cloudAccess,'invited');assert.equal(state.runtimeMode,'PUBLIC_INVITATION');assert.equal(state.localManualDeliveryAvailable,false);
});
test('unknown or unavailable cloud services do not fall back to local APIs',()=>{
 for(const status of [undefined,{mode:'UNKNOWN'},{mode:'PUBLIC_INVITATION'},{...cloud,dataServices:{privateEnabled:false,scope:'PRIVATE_CLOUD_TEST'}},{...cloud,dataServices:{privateEnabled:true,scope:'LOCAL_TEST_ONLY'}}]){
  const state=workbenchEnvironment(status);assert.equal(state.servicesAvailable,false);assert.equal(state.agentServiceHandoffAvailable,false);assert.equal(state.localManualDeliveryAvailable,false);
 }
});
test('temporary preview restrictions cannot invent backend capabilities or change local delivery scope',()=>{
 const preview={privatePreview:true,privateServicesPreview:true};
 assert.equal(workbenchEnvironment(cloud,preview).cloudAccess,'private-preview');assert.equal(workbenchEnvironment(cloud,preview).servicesAvailable,true);
 assert.equal(workbenchEnvironment(cloud,{...preview,privateServicesPreview:false}).servicesAvailable,false);
 assert.equal(workbenchEnvironment(undefined,preview).servicesAvailable,false);
 assert.equal(workbenchEnvironment({mode:'LOCAL_DEVELOPMENT'},preview).localManualDeliveryAvailable,false);
 const local=workbenchEnvironment({mode:'LOCAL_DEVELOPMENT'});assert.equal(local.servicesAvailable,true);assert.equal(local.cloudServices,false);assert.equal(local.localManualDeliveryAvailable,true);
 // Old local backends still offer their classic directory, but must not
 // imply that exact task/package/release lookup exists without its flag.
 assert.equal(local.agentServiceHandoffAvailable,false);
});
test('exact local service handoff needs explicit capability, matching scope and a local backend outside preview',()=>{
 const local=workbenchEnvironment(scopedLocal);
 assert.equal(local.servicesAvailable,true);assert.equal(local.agentServiceHandoffAvailable,true);
 assert.equal(local.cloudServices,false);assert.equal(local.runtimeMode,'LOCAL_DEVELOPMENT');
 for(const status of [
  {mode:'LOCAL_DEVELOPMENT'},
  {...scopedLocal,dataServices:{scope:'LOCAL_TEST_ONLY'}},
  {...scopedLocal,dataServices:{localSourcesEnabled:false,scope:'LOCAL_TEST_ONLY'}},
  {...scopedLocal,dataServices:{localSourcesEnabled:'true',scope:'LOCAL_TEST_ONLY'}},
  {...scopedLocal,dataServices:{localSourcesEnabled:true,scope:'PRIVATE_CLOUD_TEST'}},
  {...scopedLocal,dataServices:{localSourcesEnabled:true}},
  {...scopedLocal,mode:'UNKNOWN'},
  {...scopedLocal,mode:'PUBLIC_INVITATION'},
 ])assert.equal(workbenchEnvironment(status).agentServiceHandoffAvailable,false);
 for(const privateServicesPreview of [false,true]){
  const state=workbenchEnvironment(scopedLocal,{privatePreview:true,privateServicesPreview});
  assert.equal(state.agentServiceHandoffAvailable,false);assert.equal(state.servicesAvailable,false);
 }
});
test('service write affordance uses SERVICES permission, not the parent Agent permission',()=>{
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['AGENT']}),false);
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['SERVICES']}),true);
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['*']}),true);
 assert.equal(mayWriteServices(cloud,{authenticated:false,permissions:['*']}),false);
 assert.equal(mayWriteServices(undefined,{authenticated:true,permissions:['*']}),false);
});
test('real app keeps local delivery separate and routes verified manual cloud sources through their run',()=>{
 const app=readFileSync('web/src/main.tsx','utf8'),agent=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8'),panel=readFileSync('web/src/AgentDeliveryPanel.tsx','utf8');
 assert.match(app,/workbenchEnvironment\(status,\{privatePreview,privateServicesPreview\}\)/);
 assert.equal((app.match(/privateCloud=\{workbench.cloudServices\}/g)||[]).length,2);
 assert.equal((app.match(/canWrite=\{servicesCanWrite\}/g)||[]).length,2);
 assert.match(app,/onOpenServices=\{workbench.agentServiceHandoffAvailable/);
 assert.match(app,/runtimeMode=\{workbench.runtimeMode\}/);
 assert.doesNotMatch(app,/privateCloud=\{privateServicesPreview\}/);
 assert.match(agent,/runtimeMode === "LOCAL_DEVELOPMENT" && !privatePreview/);
 assert.match(agent,/!localManualDelivery \? originTaskId && run\?\.id \? <AgentDeliveryPanel/);
 assert.match(agent,/manual api=\{api\} taskId=\{originTaskId\}/);
 assert.match(agent,/canWrite=\{canWrite&&!manualUnconfirmed&&!pendingSaveKey\} canPublish=\{canPublish\} publicationTarget=\{publicationTarget\}/);
 assert.match(agent,/!task && !dirty && mayReuseManualRevision/);
 assert.match(agent,/originAgentTaskId:origin/);
 assert.match(agent,/打开本机人工交付流程/);
 assert.match(panel,/manual \? `\/runs\/\$\{runId\}\/prepare-delivery`/);
 assert.match(panel,/publicationSelector\(\{taskId,manual,runId,revisionId,contextId\}/);
 assert.match(panel,/if\(!key\)\{setPublicationReadKey\(""\);setPublicationRead\("READY"\);return;\}/);
 assert.match(panel,/selector\?publicationReadPath\(taskId,selector,pinned\)/);
 assert.match(panel,/publicationWriteAllowed\(\{manual,canPublish,canWrite,cloud/);
 assert.match(panel,/!publicationKey \|\| working \|\| publicationRead === "LOADING"/);
 assert.match(panel,/\{\.\.\.selector,releaseId:selectedReleaseId\}/);
});

const compile = (name, initialWorkflow) => {
 let input=readFileSync(`web/src/${name}.tsx`,'utf8');
 // Supply only the already-read workflow state; SSR never runs effects or API calls.
 if(initialWorkflow&&name==='AgentDeliveryPanel')input=input.replace('useState<Workflow>()',`useState<Workflow>(${JSON.stringify(initialWorkflow)})`);
 let source=ts.transpileModule(input,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const pkg of ['react','react/jsx-runtime','lucide-react'])source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`).replaceAll(`from '${pkg}'`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
 source=source.replace(/from (["'])\.\/([^"'.]+)\1/g,(_match,_quote,dependency)=>`from ${JSON.stringify(existsSync(`web/src/${dependency}.tsx`)?compile(dependency):new URL(`../../web/src/${dependency}.ts`,import.meta.url).href)}`);
 source=source.replace(/import "\.\/[^"\n]+\.css";/g,'');
 return`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
};
const {DataServicesWorkbench}=await import(compile('DataServicesWorkbench'));
const {AgentDeliveryPanel}=await import(compile('AgentDeliveryPanel',{
 report:{taskId:'synthetic-task',revisionId:'synthetic-revision',runId:'synthetic-run',status:'NEEDS_ATTENTION',summary:'合成历史核验',checks:[],rowCount:0,notice:'仅用于入口渲染回归'},
 publication:{available:false,scope:'LOCAL_TEST_RELEASE',reason:'未准备完整发布证据'},
}));
test('actual delivery panel exposes local handoff only with the capability and keeps unconfirmed-source action disabled',()=>{
 let calls=0;
 const render=(status,preview)=>{
  const environment=workbenchEnvironment(status,preview);
  return renderToStaticMarkup(React.createElement(AgentDeliveryPanel,{api:()=>{calls++;throw Error('render must not request or mutate');},taskId:'synthetic-task',revisionId:'synthetic-revision',runId:'synthetic-run',dirty:false,canWrite:false,codeBusy:false,
   onOpenServices:environment.agentServiceHandoffAvailable?()=>{calls++;}:undefined}));
 };
 const available=render(scopedLocal);
 assert.match(available,/<button[^>]*disabled=""[^>]*>继续此任务的接口交付<\/button>/);
 assert.doesNotMatch(available,/当前环境尚未开放服务接管/);
 assert.match(available,/请先核对当前包的确切发布记录/);
 for(const html of [render({mode:'LOCAL_DEVELOPMENT'}),render({...scopedLocal,mode:'UNKNOWN'}),render(scopedLocal,{privatePreview:true,privateServicesPreview:true})]){
  assert.match(html,/当前环境尚未开放服务接管/);assert.doesNotMatch(html,/继续此任务的接口交付/);
 }
 assert.equal(calls,0,'capability and render never create services, credentials or invocations');
});
test('actual cloud service view labels invited access honestly and does not perform work on render',()=>{
 const render=extra=>renderToStaticMarkup(React.createElement(DataServicesWorkbench,{api:()=>{throw Error('render must not create, fetch or execute');},canWrite:false,privateCloud:true,...extra}));
 const invited=render({cloudAccess:'invited'}),preview=render({cloudAccess:'private-preview'});
 assert.match(invited,/受邀云测试范围/);assert.doesNotMatch(invited,/当前仅私有通道|本机端点不是公网服务/);assert.match(invited,/不代表生产验收完成/);
 assert.match(preview,/私有云测试范围/);assert.match(render({privateCloud:false}),/本机端点不是公网服务/);
});
test('actual consumption view shows immutable plan fields, limited authorization and no model planning',()=>{
 const now=Date.now(),scope={pilotId:'fictional-pilot',taskId:'fictional-task',startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),plan:{taskId:'fictional-task',packageDigest:'fictional-package',sourceReleaseRunId:'fictional-release-run',dapis:[{name:'合成持仓',slug:'fictional-holdings',fields:['client_id','holding_market_value','security_count'],timeoutMs:1500,rateLimitPerMinute:10},{name:'合成现金',slug:'fictional-cash',fields:['client_id','available_cash','total_assets'],timeoutMs:1500,rateLimitPerMinute:10}],xapi:{name:'合成资产组合',slug:'fictional-assets',timeoutMs:2500,rateLimitPerMinute:5,steps:[{alias:'positions',dapiSlug:'fictional-holdings'},{alias:'cash',dapiSlug:'fictional-cash'}]},applicationName:'合成消费应用'}};
 const render=s=>renderToStaticMarkup(React.createElement(DataServicesWorkbench,{api:()=>{throw Error('render must not write or query');},canWrite:true,privateCloud:true,cloudAccess:'invited',sourceAgentTaskId:scope.taskId,consumptionScope:s}));
 const html=render(scope);
 assert.match(html,/仅本次冻结接口计划/);assert.match(html,/合成持仓/);assert.match(html,/fictional-release-run/);assert.match(html,/fictional-package/);
 assert.match(html,/readOnly=""[^>]*value="合成持仓"|value="合成持仓"[^>]*readOnly=""/);
 assert.match(html,/现金接口未单独授权/);assert.match(html,/凭证到期后失效，历史调用证据保留/);
 assert.doesNotMatch(html,/用自然语言规划数据服务|生成受治理方案|新建版本<|确认切换版本/);
 assert.match(render({...scope,expiresAt:new Date(now-1).toISOString()}),/当前消费窗口未开放、已到期或计划不可用/);
 assert.match(render({...scope,plan:undefined}),/当前消费窗口未开放、已到期或计划不可用/);
 const source=readFileSync('web/src/DataServicesWorkbench.tsx','utf8');
 assert.match(source,/if\(!selected\?\.currentVersion\|\|!canWrite\|\|consumptionScope\)return/);
 assert.match(source,/if\(!versionReview\?\.accepted\|\|!canWrite\|\|consumptionScope\)return/);
 assert.match(source,/consumptionScope\?consumptionApplicationInput\(consumptionScope,services\)/);
 assert.match(source,/appAlreadyExists \|\| consumptionScope&&!plannedApplicationBody/);
 assert.match(source,/serviceApplicationStatus\(app,scopeClock\)!=="ACTIVE"/);
});
