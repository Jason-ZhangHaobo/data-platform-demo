import {deliveryFiles,verifiedDeliveryBytes} from './delivery-file-bytes.mjs';
import {uuid,digest} from './chat-change-resource.mjs';

export const maxReviewJsonBytes=6*1024*1024;

async function checkBundle(bundle,expectedDigest){
  const source=bundle?.manifest?.source;
  if(!bundle || (bundle.id!==undefined && !uuid(bundle.id)) || !digest(bundle.digest) || bundle.manifest?.format!=='shuduo-delivery/v1' ||
    bundle.manifest.releaseState!=='NOT_PUBLISHED' || !source || typeof source.projectId!=='string' || !source.projectId ||
    typeof source.contextId!=='string' || !source.contextId || !uuid(source.revisionId) || !uuid(source.runId) ||
    !digest(source.sqlHash) || (expectedDigest!==undefined && bundle.digest!==expectedDigest) ||
    !await verifiedDeliveryBytes(bundle,source.sqlHash)) throw Error('交付包的来源、文件或摘要未能核对。');
  return {...(bundle.id===undefined?{}:{packageId:bundle.id}),packageDigest:bundle.digest,projectId:source.projectId,
    revisionId:source.revisionId,runId:source.runId,contextId:source.contextId};
}

// Both inputs stay on the reviewer's device. The optional supplied hashes
// allow a caller to pin a previously recorded identity independently.
export async function comparePublicationFiles(baseline,current,{baselineDigest,currentDigest}={}){
  const earlier=await checkBundle(baseline,baselineDigest);
  const selected=await checkBundle(current,currentDigest);
  if(earlier.projectId!==selected.projectId)throw Error('请选取同一项目的交付包进行对照。');
  const files=deliveryFiles.map(name=>{
    const before=baseline.manifest.files[name],after=current.manifest.files[name];
    return {name,changed:before.sha256!==after.sha256,baselineBytes:before.bytes,currentBytes:after.bytes,
      baselineHash:before.sha256,currentHash:after.sha256};
  });
  return {baseline:earlier,current:selected,files};
}
