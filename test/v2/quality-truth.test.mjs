import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {nonemptyQualityPass,qualityRunView} from '../../src/v2/quality-evidence.mjs';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'shuduo-quality-truth-')),sources=join(root,'sources');mkdirSync(sources);let compute=0;
 const forbidden=async()=>{compute++;throw Error('NO_MODEL_OR_SPARK_IN_QUALITY_CHECK');};
 const app=createV2Server({root,fixtureRoot:sources,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},qualityPlanner:forbidden,generator:forbidden,runner:forbidden});
 t.after(async()=>{if(app.server.listening){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}app.dispose();app.store.close();rmSync(root,{recursive:true,force:true});});
 const sync=(name,value,missing=false)=>{
  writeFileSync(join(sources,name+'.csv'),missing?'position_id\nPOS-001\n':`position_id,security_code\nPOS-001,${value}\n`);
  const source=app.ingestion.createSource({name:'虚构证券'+name,sourceType:'LOCAL_CSV',fileName:name+'.csv'});app.ingestion.testConnection(source.id);app.ingestion.collectMetadata(source.id);
  const task=app.ingestion.createTask({name:'虚构同步'+name,sourceId:source.id,targetTable:'quality_positions',mode:'FULL',mapping:missing?{position_id:'position_id'}:{position_id:'position_id',security_code:'security_code'},keyFields:['position_id']});
  return app.ingestion.runTask(task.id);
 };
 sync('baseline','SEC-DEMO-001');const rule=app.quality.createRule({name:'证券代码必须存在',code:'security_code_required',assetId:'landing:quality_positions',field:'security_code',type:'NOT_NULL',config:{},description:'虚构证券代码不能为空'});
 const empty=()=>app.landingStore.sync({targetTable:'quality_positions',mode:'FULL',rows:[],mapping:{position_id:'position_id',security_code:'security_code'},keyFields:['position_id'],sourceHash:'synthetic-empty',syncedAt:new Date().toISOString()});
 return {app,rule,sync,empty,compute:()=>compute};
}

test('missing fields fail all row constraints and null cannot match a literal allowed value',t=>{
 const f=setup(t),rows=[{}, {security_code:undefined}];
 for(const [type,config] of [['NOT_NULL',{}],['UNIQUE',{}],['ALLOWED_VALUES',{values:['undefined','null']}],['VALUE_RANGE',{min:'0',max:'100'}],['FRESHNESS_SECONDS',{maxAgeSeconds:300}]]){
  const result=f.app.quality.evaluateRows({field:'security_code',type,config},rows,{includeInvalidRowHashes:true});assert.equal(result.status,'FAILED');assert.equal(result.failedCount,2,type);assert.equal(result.missingFieldCount,2);
 }
 const allowed=f.app.quality.evaluateRows({field:'security_code',type:'ALLOWED_VALUES',config:{values:['null','undefined']}},[{security_code:null},{security_code:'null'},{security_code:'undefined'}]);assert.equal(allowed.failedCount,1);assert.equal(Object.hasOwn(allowed,'missingFieldCount'),false);
 for(const change of [{actualExecution:false},{passedCount:0},{passRate:0.5}]){const stored={status:'PASSED',actualExecution:true,evaluatedCount:1,passedCount:1,failedCount:0,passRate:1,...change};const before=JSON.stringify(stored);assert.equal(qualityRunView(stored).status,'UNCONFIRMED');assert.equal(JSON.stringify(stored),before);}
 assert.throws(()=>f.app.quality.evaluateRows({field:'security_code',type:'NOT_NULL'},[null]),{code:'QUALITY_ROWS_REQUIRED'});
 const source=f.sync('missing','',true),result=f.app.quality.runRule(f.rule.id);assert.equal(result.run.status,'FAILED');assert.equal(result.run.failedCount,1);assert.equal(result.run.missingFieldCount,1);assert.equal(result.run.syncRunId,source.id);assert.equal(result.run.assetEvidenceHash,source.targetHash);assert.equal(result.rule.alerts[0].status,'OPEN');
 assert.doesNotMatch(JSON.stringify(result.run),/POS-001/);assert.equal(f.compute(),0);
});

test('empty input is NO_DATA, leaves alerts open, and only a real nonempty pass resolves them',t=>{
 const f=setup(t);f.sync('bad','');const failure=f.app.quality.runRule(f.rule.id);f.empty();const noData=f.app.quality.runRule(f.rule.id);
 assert.equal(noData.run.status,'NO_DATA');assert.equal(noData.run.passRate,null);assert.equal(noData.run.evaluatedCount,0);assert.equal(noData.rule.health,'NO_DATA');assert.equal(noData.rule.alerts[0].status,'OPEN');assert.equal(noData.run.syncRunId,undefined);
 const overview=f.app.quality.overview();assert.equal(overview.counts.healthy,0);assert.equal(overview.counts.noData,1);assert.equal(overview.counts.openAlerts,1);assert.equal(overview.counts.resolvedAlerts,0);
 f.app.operations.refresh();const incident=f.app.operations.listIncidents().find(i=>i.sourceId===failure.run.id);assert.equal(incident.status,'OPEN');
 assert.throws(()=>f.app.operations.resolve(incident.id,{evidenceKind:'quality_run',evidenceId:noData.run.id,actor:'local-operator',note:'空表不能恢复质量故障'}),{code:'RECOVERY_EVIDENCE_NOT_SUCCESSFUL'});
 const restored=f.sync('restored','SEC-DEMO-001'),passed=f.app.quality.runRule(f.rule.id);assert.equal(passed.run.status,'PASSED');assert.equal(passed.run.syncRunId,restored.id);assert.equal(passed.rule.health,'HEALTHY');assert.equal(passed.rule.alerts[0].recoveryRunId,passed.run.id);
 f.app.operations.refresh();assert.equal(f.app.operations.incidentDetail(incident.id).status,'RESOLVED');assert.equal(f.compute(),0);
});

test('legacy zero-row passes are read as unconfirmed quality, without rewriting history or accepting recovery',t=>{
 const f=setup(t);f.sync('bad','');const failure=f.app.quality.runRule(f.rule.id);f.empty();const empty=f.app.quality.runRule(f.rule.id),alert=failure.rule.alerts[0];
 f.app.store.update('quality_run',empty.run.id,PROJECT,{status:'PASSED',passRate:1});f.app.store.update('quality_rule',f.rule.id,PROJECT,{health:'HEALTHY'});
 f.app.store.update('quality_alert',alert.id,PROJECT,{status:'RESOLVED',recoveryRunId:empty.run.id});
 const before=JSON.stringify(['quality_run','quality_alert','quality_rule'].map(kind=>f.app.store.list(kind,PROJECT)));
 const read=f.app.quality.detail(f.rule.id);assert.equal(read.health,'NO_DATA');const historic=read.runs.find(r=>r.id===empty.run.id);assert.equal(historic.status,'NO_DATA');assert.equal(historic.storedStatus,'PASSED');assert.equal(historic.passRate,null);assert.equal(read.alerts[0].status,'OPEN');assert.equal(read.alerts[0].storedStatus,'RESOLVED');assert.equal(read.alerts[0].recoveryUnconfirmed,true);
 assert.equal(f.app.quality.overview().counts.resolvedAlerts,0);assert.equal(before,JSON.stringify(['quality_run','quality_alert','quality_rule'].map(kind=>f.app.store.list(kind,PROJECT))));
 f.app.operations.refresh();const incident=f.app.operations.listIncidents().find(i=>i.sourceId===failure.run.id);assert.equal(incident.status,'OPEN');
 assert.throws(()=>f.app.operations.resolve(incident.id,{evidenceKind:'quality_run',evidenceId:empty.run.id,actor:'local-operator',note:'旧零行通过也不能恢复'}),{code:'QUALITY_RECOVERY_UNPROVEN'});
 assert.equal(f.app.operations.overview().domainCounts['数据质量'].succeeded,0);
 f.sync('restored','SEC-DEMO-001');const good=f.app.quality.runRule(f.rule.id);assert.equal(good.rule.alerts[0].status,'RESOLVED');assert.equal(good.rule.alerts[0].recoveryRunId,good.run.id);assert.equal(good.rule.alerts[0].previousRecoveryRunId,empty.run.id);assert.equal(f.app.store.get('quality_run',empty.run.id,PROJECT).status,'PASSED');
 assert.equal(nonemptyQualityPass(f.app.store.get('quality_run',empty.run.id,PROJECT)),false);
});

test('a new version does not inherit old health and historical runs retain their original version',t=>{
 const f=setup(t),first=f.app.quality.runRule(f.rule.id);assert.equal(first.rule.health,'HEALTHY');
 const changed=f.app.quality.createVersion(f.rule.id,{type:'ALLOWED_VALUES',config:{values:['SEC-DEMO-OTHER']},description:'新证券范围尚未检测'});assert.equal(changed.health,'PENDING');assert.equal(changed.runs[0].ruleVersionId,first.run.ruleVersionId);
 // Emulate an old writer that carried HEALTHY into the new version.
 f.app.store.update('quality_rule',f.rule.id,PROJECT,{health:'HEALTHY'});assert.equal(f.app.quality.detail(f.rule.id).health,'PENDING');assert.equal(f.app.quality.overview().counts.healthy,0);
 const failed=f.app.quality.runRule(f.rule.id);assert.equal(failed.run.status,'FAILED');assert.notEqual(failed.run.ruleVersionId,first.run.ruleVersionId);assert.equal(failed.rule.runs.find(run=>run.id===first.run.id).status,'PASSED');
});

test('API replay, CLI and MCP expose the same NO_DATA result and source evidence without model or Spark',async t=>{
 const f=setup(t);f.sync('bad','');f.app.quality.runRule(f.rule.id);f.empty();await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${f.app.server.address().port}/api/v2`,url=base+'/quality/rules/'+f.rule.id+'/run';
 const post=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':'same-empty-check'},body:'{}'});
 const first=await post();assert.equal(first.status,201);const saved=await first.json();assert.equal(saved.health,'NO_DATA');const again=await post();assert.equal(again.status,200);assert.deepEqual(await again.json(),saved);assert.equal(f.app.store.list('quality_run',PROJECT).length,2);
 const client=new V2Client({baseUrl:base});let cli;assert.equal(await runV2Cli(['quality','list'],{},{client,output:text=>{cli=JSON.parse(text);},error:()=>{}}),0);assert.deepEqual(cli,[saved]);
 const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'quality_rule_list',arguments:{}}},{client}));assert.deepEqual(mcp.result.structuredContent,[saved]);assert.equal(f.compute(),0);
});
