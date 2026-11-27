import type {ChatSqlBinding} from './chat-sql-development';

const fields = {
  intentId:'chat_editor', taskId:'task', contextId:'chat_context', revisionId:'chat_revision',
  runId:'chat_run', revisionHash:'chat_hash',
} as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keys = Object.keys(fields) as (keyof ChatSqlBinding)[];
const markers = keys.filter(key=>key!=='taskId').map(key=>fields[key]);
function valid(binding:ChatSqlBinding) {
  return [binding.intentId,binding.taskId,binding.revisionId,binding.runId].every(id=>uuid.test(id)) &&
    typeof binding.contextId==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(binding.contextId) &&
    /^[a-f0-9]{64}$/.test(binding.revisionHash);
}
export function chatEditorLocation(href:string,binding:ChatSqlBinding) {
  if(!valid(binding)) throw Error('会话的代码版本或运行编号不完整');
  const url=new URL(href);
  url.username='';url.password='';url.search='';url.hash='agent-code';
  url.searchParams.set('module','agent-center');
  for(const key of keys) url.searchParams.set(fields[key],binding[key]);
  return url;
}
// Missing markers mean ordinary task navigation. A partial link must stay on
// the error screen instead of falling through to the ordinary history loader.
export function chatEditorSource(href:string): ChatSqlBinding | null | undefined {
  const url=new URL(href), q=url.searchParams;
  if(!markers.some(key=>q.has(key))) return undefined;
  const allowed=new Set<string>(['module',...Object.values(fields)]);
  if(q.get('module')!=='agent-center'||q.size!==allowed.size||
    [...q.keys()].some(key=>!allowed.has(key)||q.getAll(key).length!==1)) return null;
  const binding=Object.fromEntries(keys.map(key=>[key,q.get(fields[key])])) as ChatSqlBinding;
  return valid(binding)?binding:null;
}
export function clearChatEditorSource(url:URL) {
  for(const key of markers) url.searchParams.delete(key);
  return url;
}
