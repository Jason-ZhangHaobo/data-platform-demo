import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const protocol='shuduo-publication-wake/v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=(status,code)=>Object.assign(Error(code),{status,code});
export const publicationWakeKey=(project,approvalId)=>`${project}:publication-wake:${approvalId}`;

export function publicationWakeView(wake) {
  return {wakeId:wake.id,state:wake.state};
}

// The existing OSS wake prefix carries a single purpose-signed object. The
// approval and exact publication window live only in the persisted binding.
export function createPublicationWakeDriver({store,project,transport,config,persist,assertScope,publish}) {
  const kind='publication_wake';
  const get=id=>store.get(kind,id,project);
  const key=id=>`${config.wakePrefix}/${id}.json`;
  const signed=wake=>{
    const body={protocol,wakeId:wake.id,projectId:project,bindingDigest:hash(JSON.stringify(wake.binding))};
    const signature=createHmac('sha256',config.secret).update(`${protocol}\n${JSON.stringify(body)}`).digest('hex');
    return JSON.stringify({body,signature});
  };
  const matches=(actual,expected)=>typeof actual==='string'&&Buffer.byteLength(actual)<=4096&&
    timingSafeEqual(Buffer.from(hash(actual),'hex'),Buffer.from(hash(expected),'hex'));
  const mark=(wake,patch)=>store.update(kind,wake.id,project,patch,{expectedVersion:wake.version});

  async function enqueue(binding) {
    assertScope(binding);
    const {id,replayed}=store.deduplicate(publicationWakeKey(project,binding.approvalId),hash(JSON.stringify(binding)),
      ()=>store.create(kind,project,{binding,state:'DELIVERY_UNKNOWN'}));
    let wake=get(id);
    if(wake.state==='QUEUED'||wake.state==='RELEASED') return;
    await persist();
    assertScope(binding);
    const body=signed(wake);
    let observed;
    if (replayed) {
      try { observed=await transport.read(key(id)); } catch { return; }
      if (observed!==undefined && !matches(observed,body)) throw invalid(409,'PUBLICATION_WAKE_OBJECT_CHANGED');
      assertScope(binding);
    }
    try {
      if (observed===undefined) await transport.create(key(id),body);
    } catch {
      // A lost acknowledgement leaves a recoverable original. Exact-byte
      // create-if-absent handles an explicitly repeated submission safely.
      return;
    }
    wake=get(id);
    if(wake.state==='DELIVERY_UNKNOWN') mark(wake,{state:'QUEUED'});
    await persist();
  }

  async function consume(object) {
    const wake=get(object.id);
    if(!wake||object.kind!=='WAKE'||object.key!==key(wake.id)) return;
    const binding=wake.binding;
    assertScope(binding);
    if(!matches(await transport.read(object.key),signed(wake))) throw invalid(401,'PUBLICATION_WAKE_SIGNATURE_INVALID');
    assertScope(binding);
    if(wake.state==='RELEASED') return {protocol,state:'REPLAYED'};
    const receipt=await publish(binding,wake.id);
    const current=get(wake.id);
    if(current.state!=='RELEASED') mark(current,{state:'RELEASED',releaseId:receipt.release.id});
    await persist();
    return {protocol,state:'RELEASED'};
  }

  return {enqueue,consume};
}
