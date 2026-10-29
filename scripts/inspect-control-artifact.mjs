// Inspect an existing CI artifact; never build, execute its code, or contact a cloud provider.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const check=(v,c)=>{if(!v)throw Error(c);};
const sha=b=>createHash('sha256').update(b).digest('hex');
export const controlArtifactSources=Object.freeze(['fc-ingress','server','cloud-server','public-status','auth','private-application','request-lane','static-response','cloud-state-coordinator','public-development-access','public-publication-access','cloud-publication','private-release-timer','public-service-access','private-data-services','data-services','private-task-consumption','budget','durable-agent','model-diagnostics','agent-event-driver','agent-development-workflow'].map(n=>`src/v2/${n}.mjs`));
export function validateArtifactIdentity(run,artifact,{source,buildRunId,artifactId}){
 check(/^[a-f0-9]{40}$/.test(source)&&/^\d+$/.test(buildRunId)&&/^\d+$/.test(artifactId),'IDENTITY_INVALID');
 check(String(run.id)===buildRunId&&run.name==='Build V2 control plane package'&&run.head_sha===source&&run.conclusion==='success'&&run.status==='completed','BUILD_NOT_VERIFIED');
 check(String(artifact.id)===artifactId&&!artifact.expired&&String(artifact.workflow_run?.id)===buildRunId&&artifact.name===`shuduo-v2-control-${source}`&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??''),'ARTIFACT_NOT_VERIFIED');
}
export async function inspectControlArtifact(env=process.env){
 check(env.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main'&&/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY??''),'PROTECTED_INSPECTION_REQUIRED');
 const identity={source:env.V2_INSPECT_SOURCE,buildRunId:env.V2_INSPECT_BUILD,artifactId:env.V2_INSPECT_ARTIFACT};
 check(/^[a-f0-9]{40}$/.test(identity.source??'')&&/^\d+$/.test(identity.buildRunId??'')&&/^\d+$/.test(identity.artifactId??''),'IDENTITY_INVALID');
 const api=async path=>{const r=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`,{headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});check(r.ok,'BUILD_READ_FAILED');return r.json();};
 const run=await api(`actions/runs/${identity.buildRunId}`),artifact=await api(`actions/artifacts/${identity.artifactId}`);
 validateArtifactIdentity(run,artifact,identity);
 const path='.artifact-package/v2-function.zip',bytes=readFileSync(path);check(bytes.length>0&&bytes.length<73400320,'PACKAGE_SIZE_INVALID');
 execFileSync('unzip',['-tq',path],{stdio:'pipe',timeout:30000});
 const names=execFileSync('unzip',['-Z1',path],{encoding:'utf8'}).trim().split('\n');
 check(!names.some(n=>/(^|\/)(\.env(?:\..*)?|[^/]+\.(?:pem|key))$/.test(n)||n.startsWith('/')||n.split('/').includes('..')),'UNSAFE_PACKAGE');
 const extract=name=>execFileSync('unzip',['-p',path,name],{maxBuffer:10000000});
 const sources=controlArtifactSources;
 for(const name of sources)check(sha(extract(name))===sha(readFileSync(resolve('.artifact-source',name))),'SOURCE_MISMATCH');
 const index=extract('web-dist/index.html');
 const report={protocol:'shuduo-control-artifact-inspection/v1',operatorSource:env.GITHUB_SHA,inspectionRunId:env.GITHUB_RUN_ID,applicationSource:identity.source,buildRunId:identity.buildRunId,artifactId:identity.artifactId,artifactDigest:artifact.digest,sha256:sha(bytes),bytes:bytes.length,webIndexSha256:sha(index),webIndexBytes:index.length,sourceChecks:sources.length,zipValid:true,sensitivePaths:0};
 writeFileSync('control-artifact-inspection.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))inspectControlArtifact().catch(()=>{console.error('ARTIFACT_INSPECTION_FAILED');process.exitCode=1;});
