import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {LocalArtifactStore} from '../../../src/v2/artifact-store.mjs';
import {saveManualRevision} from '../../../src/v2/manual-revisions.mjs';
import {createPasswordHash} from '../../../src/v2/auth.mjs';
import {getContext,referenceSqlForContext,contextIds,validationContractId,validationFamilyForContext} from '../../../src/v2/context.mjs';
import {createDurableSqlAgent} from '../../../src/v2/durable-agent.mjs';
import {resolveManualContinuation} from '../../../src/v2/manual-sql-continuation.mjs';
import {sha256} from '../../../src/v2/delivery.mjs';
// Real saved-revision and durable-task producers, synthetic Spark/model only.
export function manualSuccessFixture({project='project-securities-lab',withOrigin=false,autoComplete=false}={}){
 const root=mkdtempSync(join(tmpdir(),'shuduo-manual-success-')),store=new MetadataStore(':memory:'),artifactStore=new LocalArtifactStore(root),context=getContext('holdings-t1'),family=validationFamilyForContext(context.id),
   actor=store.create('auth_user',project,{email:'manual-owner@example.invalid',passwordHash:createPasswordHash('SyntheticManual!2026'),status:'ACTIVE',memberships:[{projectId:project,role:'ADMIN'}]}),
   origin=withOrigin?store.create('agent',project,{submittedBy:actor.id,contextId:context.id,language:'SPARK_SQL',executionMode:'DURABLE_SQL_AGENT_V1',mode:'LIVE_MODEL',status:'FAILED',usedTokens:700,maxAttempts:3,attempts:[]}):undefined,
   revision=saveManualRevision({store,project,actor:actor.id,key:'synthetic-manual-save',sql:referenceSqlForContext(context.id),contextId:context.id,originAgentTaskId:origin?.id}).revision,
   validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))},
   run=store.create('run',project,{revisionId:revision.id,revisionHash:revision.hash,contextId:context.id,validationContractId:family.id,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',isolation:'LOCAL_PROCESS',mainSqlExecuted:true,rows:context.expected,validation});
 const counts={model:0,submits:0},observed=[],prepared=new Map(),receipts=new Map();let model;
 const complete=id=>{const p=prepared.get(id);receipts.set(id,{status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',isolation:'FUNCTION_PROCESS',mainSqlExecuted:true,rows:context.expected,validation,
   ...(p.input.testSql?{testSqlValidation:{passed:true,sqlHash:sha256(p.input.testSql)}}:{})});};
 const runner={prepare:(input,id)=>{const p={job:{jobId:id},input};prepared.set(id,p);return p;},submit:async p=>{counts.submits++;if(autoComplete)complete(p.job.jobId);},read:async p=>receipts.get(p.job.jobId),cancel:async()=>{}},
   generator=async input=>{counts.model++;observed.push(input);return model?model(input):{sql:input.currentSql+'\n-- 独立辅助版本',model:'protocol-model-provider',usage:{total_tokens:20}};},
   options={store,project,runner,persist:async()=>{},getContext,contextIds,contractId:validationContractId,generator},engine=createDurableSqlAgent(options);
 const proof=()=>resolveManualContinuation({store,project,actorId:actor.id,sourceRunId:run.id});
 return{root,store,project,artifactStore,context,family,actor,origin,revision,run,counts,observed,prepared,complete,runner,generator,options,engine,proof,setModel:fn=>model=fn,
   dispose:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
