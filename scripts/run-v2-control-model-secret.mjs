import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {auditConfig} from './audit-v2-oidc-readonly.mjs';
import {isBeijingModelEndpoint, syncControlModelSecret} from './sync-v2-control-model-secret.mjs';
import {normalizeModelKey} from '../src/v2/model-credentials.mjs';

const fail = code => Object.assign(new Error(code), {code});
const safeCodes = new Set([
  'MODEL_SYNC_SCOPE_INVALID', 'MODEL_SYNC_IDENTITY_UNCONFIRMED', 'MODEL_SYNC_INPUT_INVALID',
  'MODEL_SYNC_BOUNDARY_MISMATCH', 'MODEL_SYNC_CONFIG_DRIFT', 'MODEL_SYNC_UNCONFIRMED',
  'MODEL_SYNC_CATALOGUE_UNCONFIRMED', 'MODEL_SYNC_NOT_MATCHED',
]);

function context(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_RUN_ATTEMPT !== '1' ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || env.GITHUB_SHA !== env.V2_EXPECTED_SOURCE ||
      !['verify','apply'].includes(env.V2_MODEL_SYNC_MODE) ||
      (env.V2_MODEL_SYNC_MODE === 'apply' && env.V2_EXCLUSIVE_CHANGE_WINDOW !== 'true') ||
      ![env.V2_BASELINE_DIGEST,env.V2_PRESERVED_DIGEST].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)) ||
      !/^dataplatform-v2-[a-z0-9-]{1,60}$/.test(env.V2_FUNCTION_NAME ?? ''))
    throw fail('MODEL_SYNC_SCOPE_INVALID');
  try { return auditConfig(env); } catch { throw fail('MODEL_SYNC_SCOPE_INVALID'); }
}

export async function probeBeijingCatalogue({baseUrl, model, modelKey}, fetchImpl = fetch) {
  try {
    if (!isBeijingModelEndpoint(baseUrl) || !/^qwen3\.7-plus(?:-\d{4}-\d{2}-\d{2})?$/.test(model) ||
        normalizeModelKey(modelKey) !== modelKey) return false;
    const url = new URL('/api/v1/models', baseUrl);
    url.search = new URLSearchParams({model, page_no:'1', page_size:'20'}).toString();
    const get = headers => fetchImpl(url, {method:'GET', headers, redirect:'error', signal:AbortSignal.timeout(20000)});
    const anonymous = await get({Accept:'application/json'});
    await anonymous.body?.cancel();
    if (![401,403].includes(anonymous.status)) return false;
    const response = await get({Accept:'application/json', Authorization:'Bearer '+modelKey});
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return false;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1024*1024) return false;
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value?.success === true && Array.isArray(value.output?.models) &&
      value.output.models.some(entry => entry?.model === model);
  } catch { return false; }
}

function cliAdapter(env, config) {
  const childEnv = {PATH:env.PATH, HOME:env.HOME, ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE', ALIBABA_CLOUD_PROFILE_MODE:'StsToken'};
  for (const name of ['ALIBABA_CLOUD_ACCESS_KEY_ID','ALIBABA_CLOUD_ACCESS_KEY_SECRET','ALIBABA_CLOUD_SECURITY_TOKEN']) {
    if (!env[name]) throw fail('MODEL_SYNC_IDENTITY_UNCONFIRMED');
    childEnv[name] = env[name];
  }
  const request = (args, endpoint, read = true) => {
    try {
      const raw = execFileSync('aliyun',[...args,'--region',config.region,'--endpoint',endpoint,
        '--connect-timeout','8','--read-timeout','25','--retry-count','0'],{
        env:childEnv,encoding:'utf8',stdio:['ignore',read?'pipe':'ignore','pipe'],maxBuffer:2097152,timeout:35000,
      });
      if (read) return JSON.parse(raw);
    } catch { throw fail('MODEL_SYNC_UNCONFIRMED'); }
  };
  const path = '/2023-03-30/functions/'+config.functionName;
  const endpoint = 'fcv3.'+config.region+'.aliyuncs.com';
  return {
    identity:() => request(['sts','GetCallerIdentity'],'sts.'+config.region+'.aliyuncs.com'),
    api(method, target, body) {
      if (target !== path) throw fail('MODEL_SYNC_SCOPE_INVALID');
      if (method === 'GET' && body === undefined) return request(['fc','GET',path],endpoint);
      if (method !== 'PUT' || !body || Object.keys(body).length !== 1 || !body.environmentVariables)
        throw fail('MODEL_SYNC_SCOPE_INVALID');
      const dir = mkdtempSync(join(tmpdir(),'shuduo-single-model-'));
      try {
        const file = join(dir,'request.json');
        writeFileSync(file,JSON.stringify(body),{flag:'wx',mode:0o600});
        request(['fc','PUT',path,'--body-file',file],endpoint,false);
      } finally { rmSync(dir,{recursive:true,force:true}); }
    },
  };
}

export async function runModelKeySync(env, injected) {
  const config = context(env);
  const io = injected ?? cliAdapter(env,config);
  let identity;
  try { identity = await io.identity(); } catch { throw fail('MODEL_SYNC_IDENTITY_UNCONFIRMED'); }
  const prefix = 'acs:ram::'+config.account+':assumed-role/'+config.role+'/';
  if (String(identity?.AccountId) !== config.account || !identity?.Arn?.startsWith(prefix) ||
      !/^[a-zA-Z0-9.@_+=,-]{1,128}$/.test(identity.Arn.slice(prefix.length)))
    throw fail('MODEL_SYNC_IDENTITY_UNCONFIRMED');
  return syncControlModelSecret({mode:env.V2_MODEL_SYNC_MODE, name:config.functionName, modelKey:env.DASHSCOPE_API_KEY,
    baselineDigest:env.V2_BASELINE_DIGEST, preservedDigest:env.V2_PRESERVED_DIGEST, api:io.api,
    probe:candidate => probeBeijingCatalogue(candidate,io.fetchImpl), readDelay:io.readDelay});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'validate-inputs') context(process.env);
    else if (process.argv.length === 2) {
      const result = await runModelKeySync(process.env);
      console.log(JSON.stringify({ok:true,status:'CONFIG_VERIFIED',putAttempts:result.putAttempts,
        configurationVerified:result.configurationVerified,catalogueVerified:result.catalogueVerified,modelInferenceVerified:false}));
    }
    else throw fail('MODEL_SYNC_SCOPE_INVALID');
  } catch (error) {
    console.log(JSON.stringify({ok:false,code:safeCodes.has(error?.code)?error.code:'MODEL_SYNC_UNCONFIRMED',
      putAttempts:[0,1].includes(error?.putAttempts) ? error.putAttempts :
        ['MODEL_SYNC_SCOPE_INVALID','MODEL_SYNC_IDENTITY_UNCONFIRMED'].includes(error?.code) ? 0 : null}));
    process.exitCode=1;
  }
}
