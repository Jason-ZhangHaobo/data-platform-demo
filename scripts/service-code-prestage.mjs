// One exact code object, uploaded by an already-authorized local caller.
// No credentials, network, CLI or filesystem IO on import. The private owner
// verifies the human approval and persists counters before supplying this IO.
import {createHash} from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), {safeCode: code});
const check = (value, code) => { if (!value) throw fail(code); };
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const digest = value => hash(canonical(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const phases = ['READY','READ_REQUESTED','PUT_REQUESTED','PUT_UNCONFIRMED','ACL_REQUESTED','FAILED','VERIFIED'];
const diagnostic = error => error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' ? 'TRANSFER_TIMEOUT'
  : ['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code ?? error?.code) ? 'TRANSFER_UNAVAILABLE'
    : 'TRANSFER_UNCONFIRMED';

export function validateServicePrestagePlan(plan, bytes, now=Date.now()) {
  check(plan?.protocol === 'SERVICE_CODE_PRESTAGE_V1' && plan.authorized === true && [2, 3].includes(plan.attemptNumber) &&
    typeof plan.operationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.operationId) &&
    sha(plan.approvalDigest) && sha(plan.closedAttemptDigest), 'APPROVED_PRESTAGE_REQUIRED');
  check(plan.candidate && Object.keys(plan.candidate).sort().join(',') === 'bytes,sha256' && sha(plan.candidate.sha256) &&
    Number.isSafeInteger(plan.candidate.bytes) && plan.candidate.bytes > 0 && plan.candidate.bytes <= 67108864 &&
    Buffer.isBuffer(bytes) && bytes.length === plan.candidate.bytes && hash(bytes) === plan.candidate.sha256, 'EXACT_LOCAL_PACKAGE_REQUIRED');
  check(Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.deadline) && plan.issuedAt <= now &&
    plan.deadline > now && plan.deadline - plan.issuedAt <= 1200000, 'PRESTAGE_WINDOW_INVALID');
  check(plan.maxPuts === 1 && plan.maxObjectReads === 3 && plan.maxAclReads === 2 && plan.priorReserveCny === (plan.attemptNumber === 3 ? 41 : 39) &&
    plan.maxIncrementCny === 2 && plan.monthlyCny === 200 && Number.isFinite(plan.billCny) && plan.billCny >= 0 &&
    plan.billCny + plan.priorReserveCny + plan.maxIncrementCny < 200, 'PRESTAGE_BUDGET_INVALID');
  check(plan.bucketPrivacy?.aclPrivate === true && plan.bucketPrivacy.policyNotPublic === true && plan.bucketPrivacy.publicAccessBlocked === true &&
    sha(plan.bucketPrivacy.bucketHash) && Date.parse(plan.bucketPrivacy.checkedAt) <= now && now - Date.parse(plan.bucketPrivacy.checkedAt) < 600000,
  'PRESTAGE_PRIVATE_BUCKET_REQUIRED');
  return digest(plan);
}

export async function runServiceCodePrestage({plan,bytes,checkpoint,io,now=Date.now}) {
  const planDigest=validateServicePrestagePlan(plan,bytes,now());
  check(io && ['save','readObject','readAcl','putObject'].every(key => typeof io[key] === 'function'), 'PRESTAGE_IO_REQUIRED');
  let state=checkpoint ? structuredClone(checkpoint) : {protocol:'SERVICE_CODE_PRESTAGE_CHECKPOINT_V1',planDigest,
    operationId:plan.operationId,phase:'READY',putAttempts:0,objectReads:0,aclReads:0,failures:[]};
  check(state.protocol==='SERVICE_CODE_PRESTAGE_CHECKPOINT_V1' && state.planDigest===planDigest && state.operationId===plan.operationId &&
    phases.includes(state.phase) && [[state.putAttempts,1],[state.objectReads,3],[state.aclReads,2]].every(([n,max])=>Number.isSafeInteger(n)&&n>=0&&n<=max) &&
    Array.isArray(state.failures) && state.failures.every(code=>typeof code==='string'&&/^[A-Z_]{3,80}$/.test(code)), 'PRESTAGE_CHECKPOINT_CHANGED');
  check(!['PUT_REQUESTED','PUT_UNCONFIRMED'].includes(state.phase) || state.putAttempts===1&&state.objectReads>=1,
    'PRESTAGE_WRITE_CHECKPOINT_INCONSISTENT');
  check(state.phase!=='READ_REQUESTED'||state.objectReads>=1,'PRESTAGE_READ_CHECKPOINT_INCONSISTENT');
  check(state.phase!=='ACL_REQUESTED'||state.objectReads>=1&&state.aclReads>=1,'PRESTAGE_ACL_CHECKPOINT_INCONSISTENT');
  check(state.phase!=='READY'||state.putAttempts===0&&state.objectReads===0&&state.aclReads===0&&state.failures.length===0,
    'PRESTAGE_INITIAL_CHECKPOINT_INCONSISTENT');
  const save=async()=>io.save(structuredClone(state));
  const inWindow=()=>check(now()>=plan.issuedAt&&now()<plan.deadline,'PRESTAGE_WINDOW_EXPIRED');
  if(state.phase==='VERIFIED'){
    check(state.objectReads>=1&&state.aclReads>=1&&state.receipt?.protocol==='VERIFIED_PRIVATE_CODE_OBJECT_V1' && state.receipt.sha256===plan.candidate.sha256 &&
      state.receipt.bytes===plan.candidate.bytes && state.receipt.putAttempts===state.putAttempts &&
      /^\d+$/.test(state.receipt.crc64??'') && Number.isFinite(Date.parse(state.receipt.verifiedAt)) &&
      Date.parse(state.receipt.verifiedAt)>=plan.issuedAt&&Date.parse(state.receipt.verifiedAt)<plan.deadline&&Date.parse(state.receipt.verifiedAt)<=now(), 'VERIFIED_PRESTAGE_CHANGED');
    return {receipt:state.receipt,checkpoint:state,reused:true};
  }
  const read=async()=>{
    inWindow();check(state.objectReads<plan.maxObjectReads,'PRESTAGE_READ_LIMIT');state.objectReads++;state.phase='READ_REQUESTED';await save();
    inWindow();return io.readObject(plan.candidate,{deadline:plan.deadline,maxBytes:plan.candidate.bytes});
  };
  try{
    let object=await read();
    if(object?.status===404 && object.serviceCode==='NoSuchKey'){
      // An unknown or failed previous PUT consumes its sole allowance. Even a
      // fresh 404 must never cause an automatic retransmission after a restart.
      check(state.putAttempts===0,'PRESTAGE_UPLOAD_ALREADY_ATTEMPTED');inWindow();
      state.putAttempts=1;state.phase='PUT_REQUESTED';await save();inWindow();
      try{const result=await io.putObject(plan.candidate,bytes,{forbidOverwrite:true,deadline:plan.deadline});
        if(result?.status!==200){state.phase='PUT_UNCONFIRMED';state.failures.push('UPLOAD_RESPONSE_UNCONFIRMED');await save();}}
      catch(error){state.phase='PUT_UNCONFIRMED';state.failures.push(diagnostic(error));await save();}
      object=await read();
    }
    check(object?.status===200 && Buffer.isBuffer(object.bytes) && object.bytes.length===plan.candidate.bytes &&
      hash(object.bytes)===plan.candidate.sha256 && /^\d+$/.test(object.crc64??''), 'PRESTAGE_OBJECT_NOT_VERIFIED');
    inWindow();check(state.aclReads<plan.maxAclReads,'PRESTAGE_ACL_LIMIT');state.aclReads++;state.phase='ACL_REQUESTED';await save();
    inWindow();const acl=await io.readAcl(plan.candidate,{deadline:plan.deadline});
    check(acl?.status===200 && ['private','default'].includes(acl.grant),'PRESTAGE_ACL_NOT_PRIVATE');
    inWindow();state.receipt={protocol:'VERIFIED_PRIVATE_CODE_OBJECT_V1',...plan.candidate,crc64:object.crc64,
      verifiedAt:new Date(now()).toISOString(),putAttempts:state.putAttempts};state.phase='VERIFIED';await save();
    return {receipt:state.receipt,checkpoint:state,reused:false};
  }catch(error){state.phase='FAILED';const code=error?.safeCode??diagnostic(error);state.failures.push(code);await save();throw fail(code);}
}
