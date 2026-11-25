import {amountFields, formatCents} from './derived-amounts.mjs';

const protocol = 'shuduo-derived-result-comparison/v1';
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x,fields) => record(x) && Object.keys(x).length === fields.length && fields.every(k=>Object.hasOwn(x,k));
const refFields = ['taskId','revisionId','runId','revisionHash','contextId','validationContractId'];
const values = [...amountFields,'security_count'];
const unavailability = new Set(['NOT_DERIVED','UNSUPPORTED_GRAIN','SCOPE_CHANGED','SOURCE_UNCONFIRMED','CHILD_UNCONFIRMED','INVALID_ROWS','CUSTOMER_SCOPE_CHANGED']);
function invalid() { throw Error('派生任务、原运行或金额回执未能核对，请重新读取原任务。'); }

function checkedSide(side, expected) {
  if (!exact(side,[...refFields,'contextName']) || ![side.taskId,side.revisionId,side.runId].every(uuid) ||
      typeof side.revisionHash !== 'string' || !/^[a-f0-9]{64}$/.test(side.revisionHash) ||
      ![side.contextId,side.validationContractId].every(x=>typeof x==='string' && /^[a-z][a-z0-9-]{0,159}$/.test(x)) ||
      typeof side.contextName !== 'string' || !side.contextName.trim() || side.contextName.length > 200 ||
      (expected && refFields.some(k=>expected[k] !== undefined && expected[k] !== side[k]))) invalid();
}

function checkedValues(item, signedCount) {
  if (!exact(item,values) || !Number.isSafeInteger(item.security_count) || (!signedCount && item.security_count < 0)) invalid();
  for (const key of amountFields) {
    const value=item[key];
    if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,41})\.\d{2}$/.test(value) || value==='-0.00') invalid();
  }
}

const cents = value => BigInt(value.replace('.',''));
function checkObservation({before,after,delta}) {
  checkedValues(before,false);
  checkedValues(after,false);
  checkedValues(delta,true);
  for (const side of [before,after]) {
    if (cents(side.total_assets) !== cents(side.holding_market_value) + cents(side.available_cash)) invalid();
  }
  if (delta.security_count !== after.security_count - before.security_count ||
      amountFields.some(k=>formatCents(cents(after[k])-cents(before[k])) !== delta[k])) invalid();
}

export function checkedDerivedComparison(value, {taskId, parent, child}) {
  if (!uuid(taskId) || !record(value) || value.protocol !== protocol || value.taskId !== taskId) invalid();
  if (value.state !== 'MATCHED') {
    if (!exact(value,['protocol','taskId','state','reason']) ||
        !(value.state==='PENDING' && value.reason==='CHILD_RUNNING' ||
          value.state==='UNAVAILABLE' && unavailability.has(value.reason))) invalid();
    return value;
  }
  if (!exact(value,['protocol','taskId','state','parent','child','rows','totals'])) invalid();
  checkedSide(value.parent,parent);
  checkedSide(value.child,child);
  if (value.child.taskId!==taskId || ['taskId','runId','revisionId','contextId'].some(k=>value.parent[k]===value.child[k]) ||
      !Array.isArray(value.rows) || !value.rows.length || value.rows.length>1000 || !exact(value.totals,['before','after','delta'])) invalid();
  const customers=new Set();
  for (const row of value.rows) {
    if (!exact(row,['clientId','before','after','delta']) || typeof row.clientId!=='string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.clientId) || customers.has(row.clientId)) invalid();
    customers.add(row.clientId);
    checkObservation(row);
  }
  checkObservation(value.totals);
  for (const side of ['before','after']) {
    for (const key of values) {
      const units=value=>key==='security_count' ? BigInt(value) : cents(value);
      const sum=value.rows.reduce((total,row)=>total+units(row[side][key]),0n);
      if (sum!==units(value.totals[side][key])) invalid();
    }
  }
  return value;
}

export async function readDerivedComparison(client, args) {
  if (!exact(args,['taskId']) || !uuid(args.taskId)) throw Error('需要提供确切的派生任务编号。');
  return checkedDerivedComparison(await client.request('/agent/tasks/'+args.taskId+'/derivation-comparison'),args);
}
