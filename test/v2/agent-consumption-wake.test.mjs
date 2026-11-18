import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createAgentConsumptionWake,readAgentConsumptionReceipt} from '../../src/v2/agent-consumption-wake.mjs';

for(const scenario of ['unsure','assertion'])test(`an Agent consumption with ${scenario} outcome is not executed again`,async t=>{
  const store=new MetadataStore(':memory:'),project='fictional',objects=new Map();
  t.after(()=>store.close());
  const binding={actorId:randomUUID(),requestId:randomUUID(),applicationId:randomUUID(),pilotId:'fictional',
    sourceBinding:{taskId:randomUUID(),releaseId:randomUUID(),sourceReleaseRunId:randomUUID(),packageDigest:'a'.repeat(64)},
    dapiVersionId:randomUUID(),xapiVersionId:randomUUID()};
  const targets={DAPI:{id:binding.dapiVersionId,serviceId:randomUUID()},XAPI:{id:binding.xapiVersionId,serviceId:randomUUID()}};
  const expected={DAPI:{data:[{client_id:'FICTIONAL-1'}],pagination:{page:1,pageSize:100,total:1,totalPages:1}}};
  let calls=0;
  const options={store,project,authorize:()=>({targets,expected}),config:{wakePrefix:'fictional-wakes',secret:'fictional-test-signing-key'},
    transport:{async create(key,value){objects.set(key,value);},async read(key){return objects.get(key);}},
    manager:{async invokeDelegated(_version,_query,{assertResult}){calls++;assertResult({data:[],pagination:expected.DAPI.pagination});}}};
  const initial=createAgentConsumptionWake({...options,persist:async()=>{
    if(scenario==='unsure'&&store.list('agent_consumption_step',project).length)throw Error('Synthetic lost reservation acknowledgement');
  }});
  await initial.enqueue(binding);
  const view=readAgentConsumptionReceipt(store,project,binding.actorId,binding.requestId);
  const event={kind:'WAKE',id:view.wakeId,key:`fictional-wakes/${view.wakeId}.json`};
  await assert.rejects(initial.consume(event),scenario==='unsure'?/lost reservation acknowledgement/:{code:'AGENT_CONSUMPTION_ASSERTION_FAILED'});
  const restarted=createAgentConsumptionWake({...options,persist:async()=>{}});
  await assert.rejects(restarted.consume(event),{code:scenario==='unsure'?'AGENT_CONSUMPTION_OUTCOME_UNCONFIRMED':'AGENT_CONSUMPTION_ASSERTION_FAILED'});
  assert.equal(calls,scenario==='unsure'?0:1);
  assert.equal(store.list('agent_consumption_step',project).length,1);
  const recovered=readAgentConsumptionReceipt(store,project,binding.actorId,binding.requestId);
  assert.equal(recovered.state,scenario==='unsure'?'RESULT_UNCONFIRMED':'FAILED');
  assert.equal(recovered.agentInitiated,false);
  assert.deepEqual(recovered.calls,[]);
});
