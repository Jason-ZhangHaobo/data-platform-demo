import { createHash } from 'node:crypto';

export const fixtureFirstCloudIndex = '<!doctype html><title>Fictional first-case control plane</title>';

export function fixtureFirstCloudInspection(applicationSource, applicationTree) {
  return {
    protocol:'shuduo-control-artifact-inspection/v1',
    applicationSource, applicationTree,
    operatorSource:'c'.repeat(40), buildWorkflowSource:'d'.repeat(40),
    buildRunId:'101', buildAttempt:'1', artifactId:'102', inspectionRunId:'103',
    artifactDigest:'sha256:'+'a'.repeat(64), sha256:'a'.repeat(64), bytes:100,
    webIndexSha256:createHash('sha256').update(fixtureFirstCloudIndex).digest('hex'),
    webIndexBytes:Buffer.byteLength(fixtureFirstCloudIndex),
    sourceChecks:22, zipValid:true, sensitivePaths:0,
  };
}
