import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {LocalArtifactStore} from '../../../src/v2/artifact-store.mjs';
import {createPasswordHash} from '../../../src/v2/auth.mjs';
import {getContext,contextIds,validationContractId} from '../../../src/v2/context.mjs';
import {sha256} from '../../../src/v2/delivery.mjs';
import {resolveSqlRepairComparison} from '../../../src/v2/sql-repair-comparison.mjs';
import {createDurableSqlAgent} from '../../../src/v2/durable-agent.mjs';
import {createDurableAgentDelivery} from '../../../src/v2/agent-development-workflow.mjs';
import {seedRunComparison} from './run-comparison.mjs';

// Actual durable producer and immutable local artifact store, synthetic model
// and remote execution receipts. This fixture never contacts a cloud/provider.
export async function assistedDeliveryFixture({project='project-securities-lab',comparison=true,autoComplete=false,seedSource,model}={}){
  const root=mkdtempSync(join(tmpdir(),'shuduo-assisted-delivery-')),store=new MetadataStore(':memory:'),artifacts=new LocalArtifactStore(root);
  const actor=store.create('auth_user',project,{email:'assisted-owner@example.invalid',passwordHash:createPasswordHash('SyntheticAssisted!2026'),status:'ACTIVE',memberships:[{projectId:project,role:'ADMIN'}]}),
    source=seedRunComparison({store,project,author:actor.id});
  for(const side of [source.current,source.baseline])side.revision=store.update('revision',side.revision.id,project,{manualProvenance:{kind:'ENGINEER_EDIT',actorId:actor.id,agentIndependentE2E:false}});
  if(seedSource)await seedSource({store,project,source});
  const observed=[],counts={syntheticModel:0,submits:0,puts:0},prepared=new Map(),receipts=new Map();let losePut=false,loseSubmit=false,allowed=true,clock=Date.now();
  const complete=id=>{
    const p=prepared.get(id);if(!p)throw Error('unknown synthetic job');
    receipts.set(id,{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',
      rows:getContext(source.context.id).expected,validation:{passed:true,contractId:source.family.id,regressions:source.family.contextIds.map(contextId=>({contextId,passed:true}))},
      ...(p.input.testSql?{testSqlValidation:{passed:true,sqlHash:sha256(p.input.testSql)}}:{})});
  };
  const runner={prepare:(input,id)=>{const p={job:{jobId:id},input};prepared.set(id,p);return p;},submit:async p=>{counts.submits++;if(autoComplete)complete(p.job.jobId);if(loseSubmit){loseSubmit=false;throw Error('synthetic lost submit acknowledgement');}},
    read:async p=>receipts.get(p.job.jobId),cancel:async()=>{}};
  const persist=async()=>{},basis=resolveSqlRepairComparison({store,project,actorId:actor.id,sourceRunId:source.current.run.id,baselineRunId:source.baseline.run.id,currentSql:source.current.revision.sql,contextId:source.context.id});
  const agentEngine=createDurableSqlAgent({store,project,runner,persist,getContext,contextIds,contractId:validationContractId,generator:async input=>{counts.syntheticModel++;observed.push(input);return model?model(input):{sql:source.baseline.revision.sql,model:'protocol-model-provider',usage:{total_tokens:20}};}});
  let agent=await agentEngine.create({message:'参考历史依据修正虚构证券SQL',currentSql:source.current.revision.sql,contextId:source.context.id,actorId:actor.id,idempotencyKey:'synthetic-original-repair',
    sourceRunId:source.current.run.id,sourceError:String(source.current.run.error||source.current.run.validation?.issues?.join('；')||'独立业务校验未通过').slice(0,8000),...(comparison?{repairComparison:basis.binding}:{})});
  agent=await agentEngine.advance(agent.id,{expectedVersion:agent.version});agent=await agentEngine.advance(agent.id,{expectedVersion:agent.version});
  complete(agent.runId);agent=await agentEngine.advance(agent.id,{expectedVersion:agent.version});agent=store.get('agent',agent.id,project);
  const revision=store.get('revision',agent.revisionId,project),run=store.get('run',agent.runId,project),artifactStore={put:async(...args)=>{counts.puts++;const value=await artifacts.put(...args);if(losePut){losePut=false;throw Error('synthetic lost artifact acknowledgement');}return value;},verify:(...args)=>artifacts.verify(...args)},
    options={store,project,runner,artifactStore,persist,assertExecutionScope:a=>{if(!allowed||a?.id!==agent.id)throw Error('closed synthetic scope');}},
    delivery=createDurableAgentDelivery(options),input={runId:run.id,actorId:actor.id,key:'synthetic-exact-assisted-delivery'};
  return {root,store,project,actor,source,basis,agent,revision,run,runner,artifactStore,options,delivery,input,counts,prepared,complete,agentEngine,observed,
    now:()=>clock,later:(ms=15000)=>clock+=ms,losePut:()=>losePut=true,loseSubmit:()=>loseSubmit=true,closeScope:()=>allowed=false,
    dispose:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
