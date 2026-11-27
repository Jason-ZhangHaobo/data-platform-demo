export const deliveryFiles = ['main.sql','tests.sql','schedule.json','deployment.json','calendar.json','fixtures.json','validation.json','README.md'];
const canonical = value => JSON.stringify(value,(_,item)=>item && typeof item==='object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
const encoder = new TextEncoder();
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');

// Shared with the browser download view. Verify the served bytes, including
// UTF-8 lengths and the manifest, against the selected immutable development SQL.
export async function verifiedDeliveryBytes(bundle,sqlHash) {
  const entries=bundle?.manifest?.files,files=bundle?.files;
  const complete=value=>value && Object.keys(value).length===deliveryFiles.length && deliveryFiles.every(name=>Object.hasOwn(value,name));
  if (!complete(entries) || !complete(files) || entries['main.sql']?.sha256!==sqlHash) return false;
  let total=0;
  for (const name of deliveryFiles) {
    const entry=entries[name],content=files[name];
    if (!entry || typeof content!=='string' || content.length>250000) return false;
    const bytes=encoder.encode(content);
    total+=bytes.length;
    if (bytes.length>250000 || total>750000 || entry.bytes!==bytes.length || entry.sha256!==await sha256(bytes)) return false;
  }
  return await sha256(encoder.encode(canonical(bundle.manifest)))===bundle.digest;
}
