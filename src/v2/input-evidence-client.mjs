import {checkInputEvidenceShape,inputEvidenceCanonical} from './input-evidence-contract.mjs';
export function inputEvidencePath({packageId,packageDigest}){
 if(typeof packageId!=='string'||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).test(packageId)||typeof packageDigest!=='string'||!(/^[a-f0-9]{64}$/).test(packageDigest))throw Error('请使用原交付包编号和完整摘要');
 return `/delivery/packages/${packageId}/input-evidence?packageDigest=${packageDigest}`;
}
export async function readInputEvidence(client,input){
 const value=checkInputEvidenceShape(await client.request(inputEvidencePath(input)),input),{evidenceHash,...body}=value;
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(inputEvidenceCanonical(body))))].map(n=>n.toString(16).padStart(2,'0')).join('');
 if(digest!==evidenceHash)throw Error('输入证明摘要不一致，请重读原包；未采用旧结果');return value;
}
