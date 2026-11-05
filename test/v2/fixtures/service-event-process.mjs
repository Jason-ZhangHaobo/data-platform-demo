import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {BusinessQueryStore} from '../../../src/v2/data-services.mjs';
import {createV2Server} from '../../../src/v2/server.mjs';
import {createFcIngress} from '../../../src/v2/fc-ingress.mjs';
import {AGENT_WAKE_PREFIX} from '../../../src/v2/agent-event-driver.mjs';

// Test-only process. Never loads .env.local, real credentials or a real cloud
// transport. Its only model is an explicit synthetic provider below.
export async function startSyntheticServiceProcess(configPath){
 const config=JSON.parse(await readFile(configPath,'utf8'));
 if(config.schema!=='shuduo-synthetic-service-process/v1'||!['SUCCEED','BLOCK'].includes(config.modelMode)||
  config.env?.OSS_BUCKET!=='fictional-service-events'||config.env.V2_AGENT_EVENT_ACCOUNT_ID!=='111122223333'||
  !config.env.V2_SPARK_EXECUTOR_SECRET?.startsWith('synthetic-')||config.env.DASHSCOPE_API_KEY||
  await readFile(join(config.root,'synthetic-process-marker'),'utf8')!==config.schema)
  throw Error('SYNTHETIC_PROCESS_CONFIG_REQUIRED');
 const env={...config.env},root=resolve(config.root),objectRoot=join(root,'synthetic-oss'),journal=join(root,'synthetic-model-starts.ndjson');
 await mkdir(objectRoot,{recursive:true,mode:0o700});
 const objectPath=key=>{
  const id=key.startsWith(AGENT_WAKE_PREFIX+'/')?key.slice(AGENT_WAKE_PREFIX.length+1):'';
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(id))throw Error('SYNTHETIC_OBJECT_PATH_DENIED');
  return join(objectRoot,id);
 };
 const transport={create:async(key,body)=>{
  const path=objectPath(key);try{await writeFile(path,body,{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST'||await readFile(path,'utf8')!==body)throw Error('SYNTHETIC_OBJECT_CHANGED');}
 },read:async key=>{try{return await readFile(objectPath(key),'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}}};
 const store=new MetadataStore(join(root,'platform.sqlite')),businessStore=new BusinessQueryStore(join(root,'business.sqlite'));
 const app=createV2Server({root,store,businessStore,env,ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:true}),
  stateCoordinator:{refresh:async()=>{},flush:async()=>{}},agentWakeTransport:transport,serviceAgentModelLeaseMs:config.modelLeaseMs??90000,
  servicePlanner:async input=>{
   const row={pid:process.pid,taskId:input.modelBudgetReservation.taskId,attempt:input.modelBudgetReservation.attempt};
   await appendFile(journal,JSON.stringify(row)+'\n',{mode:0o600});process.stdout.write(JSON.stringify({kind:'model-started',...row})+'\n');
   if(config.modelMode==='BLOCK')await new Promise(()=>{});
   return {plan:{serviceType:'DAPI',name:'虚构财富客户资产进程恢复查询',slug:'synthetic-process-assets',sourceReleaseRunId:input.releaseRuns[0].id,fields:['client_id','total_assets']},
    explanation:'仅合成模型；按原股票持仓与现金口径生成方案。',model:'qwen3.7-plus',usage:{total_tokens:700}};
  },runner:async()=>{throw Error('SYNTHETIC_PROCESS_COMPUTE_DISABLED');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));env.V2_PUBLIC_ORIGIN=`http://127.0.0.1:${app.server.address().port}`;
 process.stdout.write(JSON.stringify({kind:'ready',pid:process.pid,port:app.server.address().port})+'\n');
 let closing=false;
 process.once('SIGTERM',()=>{if(closing)return;closing=true;void(async()=>{
  app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));businessStore.close();store.close();process.exit(0);
 })().catch(()=>process.exit(1));});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--synthetic-service-worker'){
 startSyntheticServiceProcess(process.argv[3]).catch(()=>{process.stderr.write('SYNTHETIC_PROCESS_START_FAILED\n');process.exit(1);});
}
