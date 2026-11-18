import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';import {qualityConfigDraft,qualityConfig,qualityVersionDraft,qualityVersionBody,qualityConfigProblem} from '../../web/src/quality-rule-config.ts';
import {checkedQualityVersionWrite,qualityVersionRequestPath,readQualityVersionRequest} from '../../src/v2/quality-version-request.mjs';import {V2Client} from '../../src/v2/client.mjs';import {runV2Cli} from '../../bin/shuduo.mjs';import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

test('all five editor types build editable parameters, including exact enum whitespace and empty values',()=>{
 assert.deepEqual(qualityConfig({...qualityConfigDraft('ALLOWED_VALUES'),valuesText:'沪市\n北交所\n沪市\n A ',allowEmpty:true}),{values:['沪市','北交所',' A ','']});
 assert.deepEqual(qualityConfig({...qualityConfigDraft('FRESHNESS_SECONDS'),maxAgeSeconds:'7200'}),{maxAgeSeconds:7200});
 assert.deepEqual(qualityConfig(qualityConfigDraft('NOT_NULL')) ,{});assert.deepEqual(qualityConfig(qualityConfigDraft('UNIQUE')),{});
 assert.deepEqual(qualityConfig({...qualityConfigDraft(),min:'-10.25',max:'1200.50'}),{min:'-10.25',max:'1200.50'});
 const special={values:[' a ','line1\nline2','']};assert.deepEqual(qualityConfig(qualityConfigDraft('ALLOWED_VALUES',special)),special);
 for(const maxAgeSeconds of ['0','2678401','1.5','1e3','true'])assert.notEqual(qualityConfigProblem({...qualityConfigDraft('FRESHNESS_SECONDS'),maxAgeSeconds}),'');
 for(const valuesText of ['',Array.from({length:31},(_,i)=>String(i)).join('\n'),'x'.repeat(81)])assert.notEqual(qualityConfigProblem({...qualityConfigDraft('ALLOWED_VALUES'),valuesText}),'');
 assert.notEqual(qualityConfigProblem({...qualityConfigDraft(),min:'9007199254740993.00',max:'9007199254740992.99'}),'');
});

test('version draft restores exact server parameters and keeps the reviewed base in its write body',()=>{
 const id=randomUUID(),version={id,field:'exchange',type:'ALLOWED_VALUES',config:{values:['沪市','北交所']},description:'已审阅的证券交易所范围'};
 const draft=qualityVersionDraft(version),body=qualityVersionBody({...draft,valuesText:draft.valuesText+'\n深市'});
 assert.equal(body.expectedVersionId,id);assert.deepEqual(body.config,{values:['沪市','北交所','深市']});assert.equal(draft.valuesText,'沪市\n北交所');
 assert.throws(()=>qualityVersionBody({...draft,description:'少'}));assert.throws(()=>qualityVersionRequestPath(id,'../other'));
});

async function setup(t){
 const root=mkdtempSync(join(tmpdir(),'shuduo-quality-editor-')),sources=join(root,'sources');mkdirSync(sources);let compute=0;const forbid=async()=>{compute++;throw Error('NO_MODEL_OR_SPARK_FOR_RULE_CONFIG');};
 const app=createV2Server({root,fixtureRoot:sources,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},qualityPlanner:forbid,generator:forbid,runner:forbid});
 const now=Date.now();writeFileSync(join(sources,'positions.csv'),`position_id,exchange,price,event_time,x\nPOS-001,沪市,100.00,${new Date(now-3600000).toISOString()},A\nPOS-002,北交所,200.00,${new Date(now-15000).toISOString()},B\n`);
 const source=app.ingestion.createSource({name:'虚构证券配置样例',sourceType:'LOCAL_CSV',fileName:'positions.csv'});app.ingestion.testConnection(source.id);app.ingestion.collectMetadata(source.id);const task=app.ingestion.createTask({name:'虚构证券字段落地',sourceId:source.id,targetTable:'quality_positions',mode:'FULL',mapping:Object.fromEntries(['position_id','exchange','price','event_time','x'].map(field=>[field,field])),keyFields:['position_id']});app.ingestion.runTask(task.id);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(root,{recursive:true,force:true});});
 const request=async(path,body,key=randomUUID())=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 const create=(name,type,field,config)=>app.quality.createRule({name:'虚构质量'+name,code:'rule_'+name,assetId:'landing:quality_positions',type,field,config,description:'按虚构证券字段配置质量规则'});
 return {app,base,request,create,compute:()=>compute};
}

test('custom enum and freshness versions really change row results; stale save/run does not mutate or execute',async t=>{
 const f=await setup(t),rule=f.create('enum','ALLOWED_VALUES','exchange',{values:['沪市']}),v1=rule.currentVersionId;
 assert.equal(f.app.quality.runRule(rule.id).run.failedCount,1);
 const key=randomUUID(),body={expectedVersionId:v1,field:'exchange',type:'ALLOWED_VALUES',config:{values:['沪市','北交所']},description:'补齐虚构北交所范围'};
 const path=`/quality/rules/${rule.id}/versions`,saved=await f.request(path,body,key);assert.equal(saved.status,201);const receipt=checkedQualityVersionWrite(saved.value,rule.id,body);assert.equal(receipt.versionNumber,2);assert.equal(saved.value.health,'PENDING');
 const replay=await f.request(path,body,key);assert.equal(replay.status,200);assert.equal(replay.value.versionWrite.versionId,receipt.versionId);assert.equal(f.app.quality.detail(rule.id).versions.length,2);
 const before=f.app.store.list('quality_run',PROJECT).length;
 const oldRun=await f.request(`/quality/rules/${rule.id}/run`,{expectedVersionId:v1});assert.equal(oldRun.status,409);assert.equal(oldRun.value.code,'QUALITY_RULE_VERSION_CHANGED');assert.equal(f.app.store.list('quality_run',PROJECT).length,before);
 const stale=await f.request(path,body);assert.equal(stale.status,409);assert.equal(f.app.quality.detail(rule.id).currentVersionId,receipt.versionId);assert.equal(f.app.quality.detail(rule.id).currentVersion.status,'ACTIVE');
 assert.equal(f.app.quality.runRule(rule.id,{expectedVersionId:receipt.versionId}).run.status,'PASSED');
 const time=f.create('fresh','FRESHNESS_SECONDS','event_time',{maxAgeSeconds:300});assert.equal(f.app.quality.runRule(time.id).run.failedCount,1);
 const newTime=f.app.quality.createVersion(time.id,{expectedVersionId:time.currentVersionId,type:'FRESHNESS_SECONDS',config:{maxAgeSeconds:7200},description:'按两小时的登记时效检测'});assert.equal(newTime.health,'PENDING');assert.equal(f.app.quality.runRule(time.id).run.status,'PASSED');
 const single=f.create('one','NOT_NULL','x',{});assert.equal(f.app.quality.runRule(single.id).run.status,'PASSED');
 for(const maxAgeSeconds of [true,[300],{}])assert.throws(()=>f.create('invalid_'+Math.random().toString(16).slice(2),'FRESHNESS_SECONDS','event_time',{maxAgeSeconds}),{code:'INVALID_INTEGER'});
 assert.equal(f.compute(),0);
});

test('original write receipt identifies V2 after another writer creates V3 and rejects mismatched draft adoption',async t=>{
 const f=await setup(t),rule=f.create('recovery','NOT_NULL','exchange',{}),body={expectedVersionId:rule.currentVersionId,field:'exchange',type:'UNIQUE',config:{},description:'切换为交易所唯一检测'},key=randomUUID();
 const first=await f.request(`/quality/rules/${rule.id}/versions`,body,key);const v2=first.value.versionWrite.versionId;
 f.app.quality.createVersion(rule.id,{type:'NOT_NULL',config:{},description:'另一工程师保存后续版本'});
 const found=await f.request(qualityVersionRequestPath(rule.id,key));assert.equal(found.status,200);assert.equal(found.value.versionWrite.versionId,v2);assert.equal(found.value.currentVersion.versionNumber,3);assert.equal(checkedQualityVersionWrite(found.value,rule.id,body).versionNumber,2);
 assert.throws(()=>checkedQualityVersionWrite(found.value,rule.id,{...body,type:'NOT_NULL'}));assert.equal((await f.request(qualityVersionRequestPath(rule.id,randomUUID()))).value.code,'QUALITY_VERSION_REQUEST_NOT_FOUND');
 const wrong=f.create('other','NOT_NULL','exchange',{});assert.equal((await f.request(qualityVersionRequestPath(wrong.id,key))).status,404);
 assert.equal((await f.request(qualityVersionRequestPath(rule.id,key)+'?actor=other')).status,422);
 assert.equal((await f.request(`/quality/rules/${rule.id}/versions`,{...body,type:'NOT_NULL'},key)).status,409);assert.equal(f.app.quality.detail(rule.id).versions.length,3);assert.equal(f.compute(),0);
});

test('CLI/MCP share expected versions, request identifiers and read-only recovery',async t=>{
 const f=await setup(t),rule=f.create('clients','NOT_NULL','exchange',{}),client=new V2Client({baseUrl:f.base}),key=randomUUID();let result;
 assert.equal(await runV2Cli(['quality','version','--id',rule.id,'--type','freshness-seconds','--field','event_time','--max-age-seconds','7200','--description','客户端时效新版本','--expected-version-id',rule.currentVersionId,'--request-id',key],{},{client,output:text=>{result=JSON.parse(text);},error:()=>{}}),0);
 assert.equal(result.currentVersion.config.maxAgeSeconds,7200);assert.equal(result.currentVersion.field,'event_time');assert.equal(result.currentVersion.basedOnVersionId,rule.currentVersionId);
 const fetched=await readQualityVersionRequest(client,{ruleId:rule.id,requestId:key});assert.equal(fetched.versionWrite.versionId,result.versionWrite.versionId);
 const read=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'quality_rule_version_request',arguments:{ruleId:rule.id,requestId:key}}},{client}));assert.equal(read.result.structuredContent.versionWrite.versionId,result.versionWrite.versionId);
 const rejected=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'quality_rule_run',arguments:{ruleId:rule.id,expectedVersionId:rule.currentVersionId}}},{client}));assert.equal(rejected.error.data.code,'QUALITY_RULE_VERSION_CHANGED');
 const invalid=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'quality_rule_run',arguments:{ruleId:rule.id,expectedVersionId:''}}},{client}));assert.equal(invalid.error.data.code,'QUALITY_VERSION_BASIS_INVALID');
 assert.equal(f.app.quality.detail(rule.id).runs.length,0);assert.equal(f.compute(),0);
});

test('a passing new field or type does not resolve an unrelated prior quality alert',async t=>{
 const f=await setup(t),rule=f.create('meaning','ALLOWED_VALUES','exchange',{values:['沪市']});const failure=f.app.quality.runRule(rule.id);assert.equal(failure.run.status,'FAILED');
 f.app.operations.refresh();const incident=f.app.operations.listIncidents().find(item=>item.sourceId===failure.run.id);
 f.app.quality.createVersion(rule.id,{expectedVersionId:rule.currentVersionId,field:'event_time',type:'FRESHNESS_SECONDS',config:{maxAgeSeconds:7200},description:'改为时效并不修复原交易所问题'});
 const pass=f.app.quality.runRule(rule.id);assert.equal(pass.run.status,'PASSED');assert.equal(pass.rule.alerts[0].status,'OPEN');f.app.operations.refresh();assert.equal(f.app.operations.incidentDetail(incident.id).status,'OPEN');
 assert.throws(()=>f.app.operations.resolve(incident.id,{evidenceKind:'quality_run',evidenceId:pass.run.id,actor:'local-operator',note:'不同字段不能作为原故障恢复'}),{code:'QUALITY_RECOVERY_UNPROVEN'});
 const current=f.app.quality.detail(rule.id);f.app.quality.createVersion(rule.id,{expectedVersionId:current.currentVersionId,field:'exchange',type:'ALLOWED_VALUES',config:{values:['沪市','北交所']},description:'原字段与规则类型下校准允许范围'});
 const restored=f.app.quality.runRule(rule.id);assert.equal(restored.rule.alerts[0].status,'RESOLVED');assert.equal(restored.rule.alerts[0].recoveryRunId,restored.run.id);assert.equal(f.compute(),0);
});
