#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serviceHash } from '../src/v2/data-services.mjs';

export function compareServiceRecovery(before,after) {
  const valid=r=>r?.protocol==='shuduo-private-service-recovery/v1' &&
    r.scope==='PRIVATE_CLOUD_TEST' && r.publicDeployed===false && r.healthy===true &&
    /^[a-f0-9-]{36}$/.test(r.bootId??'') && /^[a-f0-9]{64}$/.test(r.fingerprint??'') &&
    r.state?.serviceId && r.state.evidence?.length>0 &&
    r.state.evidence.every(e=>e.verified===true) && serviceHash(r.state)===r.fingerprint;
  const checks={validBefore:Boolean(valid(before)),validAfter:Boolean(valid(after)),
    sameService:before?.state?.serviceId===after?.state?.serviceId,
    differentReportedBoot:before?.bootId!==after?.bootId,
    unchangedState:before?.fingerprint===after?.fingerprint};
  return{protocol:'shuduo-service-recovery-comparison/v1',checks,
    passed:Object.values(checks).every(Boolean),verificationScope:'REPORT_COMPARISON_ONLY',
    cloudRestartVerified:false,
    notice:'报告对照通过仍须配对实际进程/实例终止与新启动证据；不能单独声明FC冷启动验收。'};
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  try {
    if(process.argv.length!==4)throw Error('USAGE_BEFORE_AFTER_JSON');
    const buffers=process.argv.slice(2).map(p=>readFileSync(p));
    if(buffers.some(b=>b.length>8*1024*1024))throw Error('REPORT_TOO_LARGE');
    const result=compareServiceRecovery(...buffers.map(b=>JSON.parse(b)));
    console.log(JSON.stringify({...result,evidenceSha256:buffers.map(b=>createHash('sha256').update(b).digest('hex'))}));
    if(!result.passed)process.exitCode=1;
  }catch{console.log(JSON.stringify({passed:false,code:'INVALID_RECOVERY_REPORT_OR_ARGUMENTS'}));process.exitCode=1;}
}
