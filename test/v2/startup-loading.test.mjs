import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModuleStartup, loadStartupCore, moduleStartupPaths, startupReadCurrent } from '../../web/src/startup-loading.ts';
import { workbenchSessionScope } from '../../web/src/workbench-session-boundary.ts';
import { isAgentSampleLanding, publicAgentSamples } from '../../web/src/agent-startup-samples.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const status={mode:'PUBLIC_INVITATION',capabilities:[]};
const session=id=>({authenticated:true,user:{id},role:'ENGINEER',permissions:['DEVELOPMENT','AGENT']});
const fixtures={'/contexts':[{id:'holdings-t1',referenceSql:'SELECT 1'}],'/runs':[{id:'fictional-run'}],'/revisions':[{id:'fictional-revision',sql:'SELECT 1'}],'/agent/tasks':[{id:'fictional-task'}],'/agent/deliveries':[{id:'fictional-delivery'}]};

test('early Agent samples retain only the public picker fields and skip original task links',()=>{
  const base='https://demo.example/v2/';
  assert.equal(isAgentSampleLanding(base),true);
  assert.equal(isAgentSampleLanding(base+'?module=agent-center'),true);
  for (const suffix of ['?module=services','?module=agent-center&task=original','?revision=original','#agent-call-history'])
    assert.equal(isAgentSampleLanding(base+suffix),false);
  const sample={id:'holdings-t1',name:'客户资产 T+1',definition:'持仓和现金',businessDate:'2026-09-10'};
  const context={...sample,classification:'SYNTHETIC',referenceSql:'SELECT 1',tables:[],expected:[{test:'fixture'}]};
  assert.deepEqual(publicAgentSamples([context,{...context,classification:'PRIVATE'},{...context,capabilities:{scope:'LOCAL_ONLY'}},
    {...context,capabilities:{agentDevelopment:false}},{...context,id:'../wrong'}]),[sample]);
  assert.deepEqual(publicAgentSamples({items:[context]}),[]);
});

test('identity and status become usable while historical inputs are still pending or later fail',async()=>{
  const pending=deferred(),coreEvents=[],legacyEvents=[],requests=[];
  const read=path=>{requests.push(path);return path==='/status'?Promise.resolve(status):path==='/auth/session'?Promise.resolve(session('user-a')):pending.promise;};
  const legacy=loadModuleStartup({read,module:'development',isCurrent:()=>true,accept:value=>legacyEvents.push(value)});
  const rejected=assert.rejects(legacy,/history unavailable/);
  assert.equal(await loadStartupCore({read,isCurrent:()=>true,accept:value=>coreEvents.push(value)}),true);
  assert.deepEqual(coreEvents,[{status,session:session('user-a')}]);assert.equal(legacyEvents.length,0);
  pending.reject(Error('history unavailable'));await rejected;
  assert.equal(coreEvents.length,1);assert.equal(legacyEvents.length,0);
  assert.equal(requests.filter(path=>path==='/status').length,1);assert.equal(requests.filter(path=>path==='/auth/session').length,1);
});
test('Agent startup reads context only, settings/services make no parent history requests, classic development keeps its full inputs',async()=>{
  for(const [module,paths] of [['agent-center',['/contexts']],['settings',[]],['services',[]],['schedules',['/runs']],['development',Object.keys(fixtures)]]){
    const requests=[],accepted=[];await loadModuleStartup({module,read:async path=>{requests.push(path);return fixtures[path];},isCurrent:()=>true,accept:value=>accepted.push(value)});
    assert.deepEqual(requests,paths);assert.equal(accepted.length,1);
    if(module==='development')assert.deepEqual(accepted[0],{contexts:fixtures['/contexts'],runs:fixtures['/runs'],revisions:fixtures['/revisions'],agents:fixtures['/agent/tasks'],deliveries:fixtures['/agent/deliveries']});
  }
  assert.deepEqual(moduleStartupPaths('development',true),['/contexts','/runs','/revisions']);
});
test('combined core accepts one identity snapshot and old servers need only the session fallback', async () => {
  for (const legacy of [false, true]) {
    const requests = [], views = [], actor = session('user-a');
    await loadStartupCore({
      combined: true, isCurrent: () => true, accept: value => views.push(value),
      read: async path => {
        requests.push(path);
        return path === '/auth/session' ? actor : legacy ? status : {status, session:actor};
      },
    });
    assert.deepEqual(views, [{status, session:actor}]);
    assert.deepEqual(requests, ['/status?include=session', ...(legacy ? ['/auth/session'] : [])]);
  }
});
test('partial, failed or stale combined responses never unlock the view or trigger the legacy fallback', async () => {
  const load = read => loadStartupCore({
    combined:true, isCurrent:()=>true,
    read: path => { assert.equal(path, '/status?include=session'); return read(); },
    accept: () => assert.fail('startup must remain unverified'),
  });
  for (const value of [{status}, {...status,session:null}, {status,session:{authenticated:true}}, {}]) {
    await assert.rejects(load(async () => value), /响应尚未确认/);
  }
  await assert.rejects(load(async () => { throw new Error('request unavailable'); }), /request unavailable/);
  const pending = deferred();
  let current = true;
  const stale = loadStartupCore({
    combined:true, isCurrent:()=>current,
    read: path => { assert.equal(path, '/status?include=session'); return pending.promise; },
    accept: () => assert.fail('superseded startup must stay hidden'),
  });
  current = false;
  pending.resolve(status);
  assert.equal(await stale, false);
});
test('an account downgrade during legacy fallback cannot expose earlier administrator status', async () => {
  const adminStatus = {...status, budget:{account:{observedSpendCny:42}}};
  for (const actor of [session('user-b'), {authenticated:false}]) {
    await assert.rejects(loadStartupCore({
      combined:true, isCurrent:()=>true,
      read:async path=>path==='/auth/session' ? actor : adminStatus,
      accept:value=>workbenchSessionScope(value.status,value.session),
    }), /状态与当前身份不一致/);
  }
});
test('failed or malformed core reads retain the prior account view and never manufacture anonymous success',async()=>{
  for(const read of [async path=>{if(path==='/status')throw Error('unavailable');return session('user-b');},async path=>path==='/status'?status:{},async path=>path==='/status'?status:{authenticated:true},async path=>path==='/status'?{mode:'UNKNOWN',capabilities:[]}:session('user-b')]){
    const view={status,session:session('user-a')};let accepted=false;
    await assert.rejects(loadStartupCore({read,isCurrent:()=>true,accept:value=>{accepted=true;Object.assign(view,value);}}));
    assert.equal(accepted,false);assert.deepEqual(view.session,session('user-a'));
  }
});
test('old-account core success or failure cannot replace a newer authenticated view',async()=>{
  for(const fail of [false,true]){
    let live={authEpoch:1,coreRequest:1};const pending=deferred(),view=[];
    const expected={...live},old=loadStartupCore({read:()=>pending.promise,isCurrent:()=>startupReadCurrent(expected,live),accept:v=>view.push(v)});
    live={authEpoch:2,coreRequest:2};const next={...live};
    await loadStartupCore({read:async path=>path==='/status'?status:session('user-b'),isCurrent:()=>startupReadCurrent(next,live),accept:v=>view.push(v)});
    if(fail)pending.reject(Error('late old-account failure'));else pending.resolve({unexpected:'late response'});
    assert.equal(await old,false);assert.deepEqual(view,[{status,session:session('user-b')}]);
  }
});
test('manual retry accepts only its latest response and a failed module read keeps saved inputs',async()=>{
  const first=deferred(),oldView=structuredClone(fixtures['/contexts']);let live={authEpoch:1,coreRequest:1,moduleRequest:1,module:'agent-center'},view=oldView;
  const expected={...live},old=loadModuleStartup({module:'agent-center',read:()=>first.promise,isCurrent:()=>startupReadCurrent(expected,live),accept:value=>{view=value.contexts;}});
  const failed=assert.rejects(old,/context unavailable/);first.reject(Error('context unavailable'));await failed;assert.deepEqual(view,oldView);
  live={...live,moduleRequest:2};const retryIdentity={...live};
  await loadModuleStartup({module:'agent-center',read:async()=>[{id:'retried-context'}],isCurrent:()=>startupReadCurrent(retryIdentity,live),accept:value=>{view=value.contexts;}});
  assert.deepEqual(view,[{id:'retried-context'}]);
});
test('late module data and polling receipts are rejected after navigation, logout, refresh, or a newer module request',async()=>{
  const expected={authEpoch:1,coreRequest:1,moduleRequest:1,module:'development'};
  for(const change of [{module:'settings'},{authEpoch:2},{coreRequest:2},{moduleRequest:2}]){
    let live={...expected};const pending=deferred();let writes=0;
    const loading=loadModuleStartup({module:'development',read:()=>pending.promise,isCurrent:()=>startupReadCurrent(expected,live),accept:()=>writes++});
    live={...live,...change};pending.resolve([]);assert.equal(await loading,false);assert.equal(writes,0);
    assert.equal(startupReadCurrent(expected,live),false,'the same guard protects each legacy polling await');
  }
});
test('empty verified contexts are distinct from failed context responses',async()=>{
  const accepted=[];await loadModuleStartup({module:'agent-center',read:async()=>[],isCurrent:()=>true,accept:v=>accepted.push(v)});
  assert.deepEqual(accepted[0].contexts,[]);
  await assert.rejects(loadModuleStartup({module:'agent-center',read:async()=>({error:'bad result'}),isCurrent:()=>true,accept:()=>{throw Error('must not accept malformed data');}}),/响应格式未确认/);
});
test('prefetched public Agent contexts reuse one read and obey the current identity guard', async () => {
  const read = async () => assert.fail('initial Agent contexts must reuse the original read');
  const pending = deferred(), accepted = [];
  let current = true;
  const load = prefetchedContexts => loadModuleStartup({
    read, module: 'agent-center', prefetchedContexts, isCurrent: () => current,
    accept: value => accepted.push(value.contexts),
  });
  const stale = load(pending.promise);
  current = false;
  pending.resolve(fixtures['/contexts']);
  assert.equal(await stale, false);
  assert.deepEqual(accepted, []);
  current = true;
  assert.equal(await load(pending.promise), true);
  assert.deepEqual(accepted, [fixtures['/contexts']]);
  await assert.rejects(load(Promise.reject(Error('fixture unavailable'))), /fixture unavailable/);
  await assert.rejects(load(Promise.resolve({})), /响应格式未确认/);
});
test('actual app wires guarded loading, explicit retry and no-context write gates without remounting on refresh',()=>{
  const source=readFileSync(new URL('../../web/src/main.tsx',import.meta.url),'utf8');
  assert.match(source,/loadStartupCore<Status, AuthSession>/);assert.match(source,/loadModuleStartup<Context, Run, Revision, AgentTask, AgentDeliveryTask>/);
  assert.match(source,/ready=\{coreReady && contextsReady && agentDevelopmentReadiness\(status\).ready\}/);
  assert.match(source,/\) && startupWritable/);assert.match(source,/重新读取服务与身份/);assert.match(source,/重新读取当前模块/);
  assert.match(source,/!coreSnapshotKnown \?/);assert.match(source,/<Suspense key=\{viewEpoch\}/);assert.match(source,/workbenchSessionScope\(nextStatus, nextSession\)/);
  assert.match(source,/const currentView = \(\) => active && startupReadCurrent/);
  assert.ok((source.match(/if \(!currentView\(\)\) return/g)||[]).length>=6);
  assert.match(source,/active = false; clearInterval\(interval\)/);
  assert.match(source,/core === 1 && !openingContexts\.current\.consumed \? openingContexts\.current\.request/);
  assert.match(source,/<AgentStartupPreview read=\{readOpeningContexts\}/);
  assert.match(source,/void readOpeningContexts\(\)\.catch/);
  assert.match(source,/!privatePreview && inputModule === "agent-center" && agentWorkspaceMode === "development"/);
});
