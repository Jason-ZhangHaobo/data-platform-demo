import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {listTradingCalendars,readTradingCalendar,resolveTradingCalendar,registeredDeliveryCalendar,calendarDate} from '../../src/v2/trading-calendar.mjs';
import {createDeliveryPackage,validateDeliveryPackage,computeManifestDigest,resolveDeliverySchedule,sha256} from '../../src/v2/delivery.mjs';
import {referenceSql,validationContractId,contextIds} from '../../src/v2/context.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {readTradingDay} from '../../src/v2/trading-calendar-client.mjs';
const id='sse-equities-2025-2026-v1',selection=()=>({calendarId:id,calendarDigest:readTradingCalendar(id).digest});
function source(){const revision={id:'revision-calendar',projectId:PROJECT,contextId:'holdings-t1',sql:referenceSql,hash:sha256(referenceSql)};return {revision,run:{id:'run-calendar',projectId:PROJECT,revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:{passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))}}};}
test('exchange calendar independently covers named holidays, working weekends and cross-year T+1',()=>{
 for(const calendar of listTradingCalendars()){
  const full=readTradingCalendar(calendar.id);assert.equal(calendar.tradingDayCount,485);assert.equal(full.tradingDays.filter(d=>d.startsWith('2025')).length,243);assert.equal(full.tradingDays.filter(d=>d.startsWith('2026')).length,242);
  for(const [day,business] of [['2025-02-05','2025-01-27'],['2025-06-03','2025-05-30'],['2025-10-09','2025-09-30'],['2026-01-05','2025-12-31'],['2026-02-24','2026-02-13'],['2026-04-07','2026-04-03'],['2026-05-06','2026-04-30'],['2026-06-22','2026-06-18'],['2026-09-28','2026-09-24'],['2026-10-08','2026-09-30']])assert.equal(resolveTradingCalendar(calendar.id,day).t1.businessDate,business);
  for(const day of ['2025-01-26','2025-02-08','2025-04-27','2025-09-28','2025-10-11','2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']){const r=resolveTradingCalendar(calendar.id,day);assert.equal(r.classification,'WEEKEND');assert.equal(r.t1.eligible,false);}
  for(const day of ['2025-01-01','2025-02-04','2025-06-02','2025-10-08','2026-02-23','2026-05-05','2026-09-25','2026-10-07'])assert.equal(resolveTradingCalendar(calendar.id,day).classification,'HOLIDAY');
 }
});
test('calendar coverage, invalid dates and stale version fail closed; returned data cannot mutate registry',()=>{
 assert.equal(resolveTradingCalendar(id,'2025-01-02').t1.status,'PREVIOUS_NOT_COVERED');assert.equal(resolveTradingCalendar(id,'2026-12-31').next.status,'OUT_OF_RANGE');
 for(const date of ['2024-12-31','2027-01-04'])assert.throws(()=>resolveTradingCalendar(id,date),{code:'CALENDAR_DATE_OUT_OF_RANGE'});
 for(const date of ['2026-02-30','2026-2-03','2025-02-29','2026-01-01T00:00:00Z',null,{},'2026-13-01'])assert.throws(()=>calendarDate(date),{code:'CALENDAR_DATE_INVALID'});
 assert.throws(()=>resolveTradingCalendar('other','2026-01-05'),{code:'CALENDAR_NOT_REGISTERED'});assert.throws(()=>resolveTradingCalendar(id,'2026-01-05','0'.repeat(64)),{code:'CALENDAR_VERSION_CHANGED'});
 const full=readTradingCalendar(id);full.tradingDays.push('2026-02-23');full.sources[0].url='https://invalid.example';assert.equal(readTradingCalendar(id).tradingDays.includes('2026-02-23'),false);assert.match(readTradingCalendar(id).sources[0].url,/sse\.com\.cn/);
 for(const extra of [{},{calendarId:id}, {...selection(),extra:true},null])assert.throws(()=>registeredDeliveryCalendar(extra),{code:'CALENDAR_SELECTION_INVALID'});
});
test('selected calendar is frozen in real file plan; legacy bytes survive, rehashed holiday tampering is rejected',()=>{
 const old=createDeliveryPackage(source()),before=JSON.stringify(old),bundle=createDeliveryPackage({...source(),calendarSelection:selection()}),plan=validateDeliveryPackage(bundle,bundle.digest);
 assert.equal(Object.keys(bundle.files).length,8);assert.equal(plan.calendar.schema,'shuduo-calendar/v2');assert.equal(plan.calendar.reference.digest,selection().calendarDigest);assert.equal(resolveDeliverySchedule(plan,'2026-02-24T09:00:00+08:00').businessDate,'2026-02-13');assert.equal(resolveDeliverySchedule(plan,'2026-01-05T09:00:00+08:00').businessDate,'2025-12-31');assert.equal(resolveDeliverySchedule(plan,'2026-10-10T09:00:00+08:00').eligible,false);
 assert.throws(()=>resolveDeliverySchedule(plan,'2027-01-04T09:00:00+08:00'));assert.throws(()=>resolveDeliverySchedule(plan,'2026-02-24T09:00:00Z'));assert.throws(()=>resolveDeliverySchedule(plan,'2025-01-02T09:00:00+08:00'));
 const tampered=structuredClone(bundle),calendar=JSON.parse(bundle.files['calendar.json']);calendar.tradingDays.push('2026-02-23');calendar.tradingDays.sort();tampered.files['calendar.json']=JSON.stringify(calendar,null,2)+'\n';tampered.manifest.files['calendar.json']={sha256:sha256(tampered.files['calendar.json']),bytes:Buffer.byteLength(tampered.files['calendar.json'])};tampered.digest=computeManifestDigest(tampered.manifest);assert.throws(()=>validateDeliveryPackage(tampered,tampered.digest),{code:'CALENDAR_CONTENT_MISMATCH'});
 assert.equal(JSON.stringify(old),before);assert.equal(JSON.parse(old.files['calendar.json']).schema,'shuduo-calendar/v1');assert.equal(resolveDeliverySchedule(validateDeliveryPackage(old,old.digest),'2026-09-11T09:00:00+08:00').businessDate,'2026-09-10');
 const cloud=source();cloud.run.isolation='FUNCTION_PROCESS';assert.throws(()=>createDeliveryPackage({...cloud,calendarSelection:selection()}));
});
async function setup(t,local=true){const root=mkdtempSync(join(tmpdir(),'shuduo-calendar-')),app=createV2Server({root,env:{V2_LOCAL_DEVELOPMENT:String(local),V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.releaseScheduler.shutdown();app.store.close();rmSync(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+app.server.address().port+'/api/v2';return {app,base,request:async(path,body,key=randomUUID())=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}};}
test('calendar APIs reject unknown/stale queries and preserve exact calendar idempotency before artifact writes',async t=>{
 const f=await setup(t),original=source(),revision=f.app.store.create('revision',PROJECT,original.revision),run=f.app.store.create('run',PROJECT,{...original.run,revisionId:revision.id});
 let artifactWrites=0;const originalPut=f.app.artifactStore.put.bind(f.app.artifactStore);f.app.artifactStore.put=async(...args)=>{artifactWrites++;return originalPut(...args);};
 const count=()=>f.app.store.list('delivery_package',PROJECT).length;
 assert.equal((await f.request('/calendars')).body.length,2);assert.equal((await f.request('/calendars/'+id+'/resolve?date=2026-01-05')).body.t1.businessDate,'2025-12-31');
 for(const query of ['date=2026-01-05&date=2026-02-24','date=2026-01-05&extra=1','date=2026-02-30','date=2027-01-01'])assert.equal((await f.request('/calendars/'+id+'/resolve?'+query)).status,422);
 assert.equal((await f.request('/calendars?extra=1')).status,422);assert.equal(count(),0);
 const body={sourceRunId:run.id,name:'虚构证券公告日历交付',calendarSelection:selection()},key=randomUUID();
 const first=await f.request('/delivery/packages',body,key);assert.equal(first.status,201);assert.equal((await f.request('/delivery/packages',body,key)).body.id,first.body.id);assert.equal(count(),1);assert.equal(artifactWrites,1);
 assert.equal((await f.request('/delivery/packages',{...body,calendarSelection:{calendarId:'szse-equities-2025-2026-v1',calendarDigest:readTradingCalendar('szse-equities-2025-2026-v1').digest}},key)).status,409);assert.equal(count(),1);
 assert.equal((await f.request('/delivery/packages',{...body,calendarSelection:{...selection(),calendarDigest:'0'.repeat(64)}})).status,409);assert.equal(count(),1);
 const legacy=await f.request('/delivery/packages',{sourceRunId:run.id,name:'保留样例'});assert.equal(legacy.status,201);assert.equal(artifactWrites,2);assert.equal(JSON.parse(legacy.body.files['calendar.json']).schema,'shuduo-calendar/v1');
});
test('GUI helpers, CLI and MCP share the readonly resolution and reject mismatched receipts',async t=>{
 const f=await setup(t),client=new V2Client({baseUrl:f.base});let result;
 assert.equal(await runV2Cli(['calendars','resolve','--id',id,'--date','2026-02-24','--digest',selection().calendarDigest],{},{client,output:text=>{result=JSON.parse(text);},error:()=>{}}),0);assert.equal(result.t1.businessDate,'2026-02-13');
 const m=JSON.parse(await handleV2Mcp({id:1,method:'tools/call',params:{name:'trading_calendar_resolve',arguments:{calendarId:id,date:'2026-02-24',calendarDigest:selection().calendarDigest}}},{client}));assert.deepEqual(m.result.structuredContent,result);
 await assert.rejects(()=>readTradingDay({request:async()=>({...result,date:'2026-01-05'})},{calendarId:id,date:'2026-02-24'}));assert.equal(f.app.store.list('delivery_package',PROJECT).length,0);
 let posts=0;assert.equal(await runV2Cli(['delivery','create','--source-run-id','run-1','--name','虚构交付','--calendar-id',id],{},{client:{request:async()=>{posts++;}},output:()=>{},error:()=>{}}),1);assert.equal(posts,0);
});
test('non-local ingress does not expose the calendar pilot',async t=>{const f=await setup(t,false);assert.notEqual((await f.request('/calendars')).status,200);});
