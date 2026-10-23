import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workbenchEnvironment,mayWriteServices} from '../../web/src/workbench-environment.ts';

const cloud={mode:'PUBLIC_INVITATION',dataServices:{privateEnabled:true,scope:'PRIVATE_CLOUD_TEST'}};
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
 // Local classic service selection remains unchanged; cloud task-scoped
 // handoff must not claim that an unfiltered local release list is scoped.
 assert.equal(local.agentServiceHandoffAvailable,false);
});
test('service write affordance uses SERVICES permission, not the parent Agent permission',()=>{
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['AGENT']}),false);
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['SERVICES']}),true);
 assert.equal(mayWriteServices(cloud,{authenticated:true,permissions:['*']}),true);
 assert.equal(mayWriteServices(cloud,{authenticated:false,permissions:['*']}),false);
 assert.equal(mayWriteServices(undefined,{authenticated:true,permissions:['*']}),false);
});
test('real app wires both service entry points to the same backend and keeps cloud manual delivery closed',()=>{
 const app=readFileSync('web/src/main.tsx','utf8'),agent=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8');
 assert.match(app,/workbenchEnvironment\(status,\{privatePreview,privateServicesPreview\}\)/);
 assert.equal((app.match(/privateCloud=\{workbench.cloudServices\}/g)||[]).length,2);
 assert.equal((app.match(/canWrite=\{servicesCanWrite\}/g)||[]).length,2);
 assert.match(app,/onOpenServices=\{workbench.agentServiceHandoffAvailable/);
 assert.match(app,/runtimeMode=\{workbench.runtimeMode\}/);
 assert.doesNotMatch(app,/privateCloud=\{privateServicesPreview\}/);
 assert.match(agent,/runtimeMode === "LOCAL_DEVELOPMENT" && !privatePreview/);
 assert.match(agent,/!localManualDelivery \?/);
 assert.match(agent,/不会回退本机交付/);
});

const compile = (name) => {
 let source=ts.transpileModule(readFileSync(`web/src/${name}.tsx`,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const pkg of ['react','react/jsx-runtime','lucide-react'])source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
 source=source.replaceAll('from "./service-composition"',`from ${JSON.stringify(new URL('../../web/src/service-composition.ts',import.meta.url).href)}`);
 if(name==='DataServicesWorkbench')source=source.replaceAll('from "./EvidenceDownload"',`from ${JSON.stringify(compile('EvidenceDownload'))}`);
 return`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
};
const {DataServicesWorkbench}=await import(compile('DataServicesWorkbench'));
test('actual cloud service view labels invited access honestly and does not perform work on render',()=>{
 const render=extra=>renderToStaticMarkup(React.createElement(DataServicesWorkbench,{api:()=>{throw Error('render must not create, fetch or execute');},canWrite:false,privateCloud:true,...extra}));
 const invited=render({cloudAccess:'invited'}),preview=render({cloudAccess:'private-preview'});
 assert.match(invited,/受邀云测试范围/);assert.doesNotMatch(invited,/当前仅私有通道|本机端点不是公网服务/);assert.match(invited,/不代表生产验收完成/);
 assert.match(preview,/私有云测试范围/);assert.match(render({privateCloud:false}),/本机端点不是公网服务/);
});
