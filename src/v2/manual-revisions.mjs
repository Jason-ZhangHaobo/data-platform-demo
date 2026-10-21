import { createHash } from "node:crypto";
const hash = value => createHash("sha256").update(value).digest("hex");
const prefix = (project, actor, key) => `${project}:manual-revision:${actor}:${key}`;
export function saveManualRevision({store, project, actor, key, sql, contextId, originAgentTaskId}) {
  const create = () => store.create("revision",project,{
    sql, contextId, source:"MANUAL", hash:hash(sql), author:actor,
    manualProvenance:{kind:"ENGINEER_EDIT", actorId:actor, ...(originAgentTaskId ? {originAgentTaskId} : {}), agentIndependentE2E:false, recordedAt:new Date().toISOString()},
  });
  if (!key) return {revision:create(),replayed:false};
  const result=store.deduplicate(prefix(project,actor,key),hash(JSON.stringify({sql,contextId,originAgentTaskId:originAgentTaskId ?? null})),create);
  return {revision:store.get("revision",result.id,project),replayed:result.replayed};
}
export function savedManualRevision({store,project,actor,key}) {
  const id=store.deduplicatedId(prefix(project,actor,key));
  return id ? store.get("revision",id,project) : undefined;
}
