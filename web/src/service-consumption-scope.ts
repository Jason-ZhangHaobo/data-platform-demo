export type ConsumptionPlan = {
  taskId: string; packageDigest: string; sourceReleaseRunId: string;
  dapis: { name: string; slug: string; fields: string[]; timeoutMs: number; rateLimitPerMinute: number }[];
  xapi: { name: string; slug: string; timeoutMs: number; rateLimitPerMinute: number; steps: { alias: string; dapiSlug: string }[] };
  applicationName: string;
};
export type ConsumptionScope = { pilotId?: string; taskId?: string; plan?: ConsumptionPlan; startsAt?: string; expiresAt?: string };
type Version = { id: string; sourceReleaseRunId?: string; sourcePackageDigest?: string; fields?: string[];
  timeoutMs: number; rateLimitPerMinute: number; steps?: { alias: string; dapiId: string; dapiVersionId: string }[] };
type Service = { id: string; name: string; slug: string; serviceType: string; status: string; pilotId?: string; currentVersion?: Version; publishedVersion?: Version };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function consumptionPlanAvailable(scope?: ConsumptionScope): scope is ConsumptionScope & {plan: ConsumptionPlan; pilotId: string} {
  const p=scope?.plan;
  return Boolean(scope?.pilotId && p && scope.taskId===p.taskId && p.packageDigest && p.sourceReleaseRunId &&
    Array.isArray(p.dapis)&&p.dapis.length===2&&p.dapis.every(d=>d.name&&d.slug&&Array.isArray(d.fields)&&d.fields.length)&&
    new Set(p.dapis.map(d=>d.slug)).size===2&&p.xapi?.name&&p.xapi.slug&&!p.dapis.some(d=>d.slug===p.xapi.slug)&&
    Array.isArray(p.xapi.steps)&&p.xapi.steps.length===2&&p.xapi.steps.every(s=>s.alias&&p.dapis.some(d=>d.slug===s.dapiSlug))&&
    new Set(p.xapi.steps.map(s=>s.dapiSlug)).size===2&&p.applicationName);
}
export function consumptionWindowOpen(scope?: ConsumptionScope, now=Date.now()) {
  return consumptionPlanAvailable(scope)&&Number.isFinite(now)&&now>=Date.parse(scope.startsAt??'')&&now<Date.parse(scope.expiresAt??'');
}
// UI projection only. Server-side scope checks remain authoritative.
export function consumptionServices<T extends Service>(services:T[],scope?:ConsumptionScope):T[] {
  if(!scope)return services;
  if(!consumptionPlanAvailable(scope))return [];
  const p=scope.plan;
  const dapis=services.filter(s=>{
    const definition=p.dapis.find(d=>d.slug===s.slug),v=s.currentVersion;
    return s.pilotId===scope.pilotId&&s.serviceType==='DAPI'&&definition&&s.name===definition.name&&v&&
      v.sourceReleaseRunId===p.sourceReleaseRunId&&v.sourcePackageDigest===p.packageDigest&&same(v.fields,definition.fields)&&
      v.timeoutMs===definition.timeoutMs&&v.rateLimitPerMinute===definition.rateLimitPerMinute&&(!s.publishedVersion||s.publishedVersion.id===v.id);
  });
  const xapis=services.filter(s=>{
    const v=s.currentVersion;
    if(s.pilotId!==scope.pilotId||s.serviceType!=='XAPI'||s.slug!==p.xapi.slug||s.name!==p.xapi.name||!v||v.timeoutMs!==p.xapi.timeoutMs||v.rateLimitPerMinute!==p.xapi.rateLimitPerMinute||!v.steps||v.steps.length!==2||s.publishedVersion&&s.publishedVersion.id!==v.id)return false;
    return p.xapi.steps.every((step,index)=>{
      const child=dapis.find(d=>d.slug===step.dapiSlug&&d.status==='PUBLISHED'),actual=v.steps![index];
      return child?.publishedVersion&&actual.alias===step.alias&&actual.dapiId===child.id&&actual.dapiVersionId===child.publishedVersion.id;
    });
  });
  return [...dapis,...xapis];
}
export function consumptionDapiInput(scope:ConsumptionScope,index:number) {
  if(!consumptionPlanAvailable(scope)||!Number.isInteger(index)||index<0||index>1)throw Error('当前没有可核对的服务消费计划');
  const d=scope.plan.dapis[index];return {...d,fields:[...d.fields],sourceReleaseRunId:scope.plan.sourceReleaseRunId};
}
export function consumptionXapiInput<T extends Service>(scope:ConsumptionScope,services:T[]) {
  if(!consumptionPlanAvailable(scope))throw Error('当前没有可核对的服务消费计划');
  const p=scope.plan,scoped=consumptionServices(services,scope);
  const steps=p.xapi.steps.map(step=>{
    const child=scoped.find(s=>s.serviceType==='DAPI'&&s.slug===step.dapiSlug&&s.status==='PUBLISHED');
    if(!child?.publishedVersion)throw Error('请先测试并发布本计划的两个DAPI，不能引用其他任务版本');
    return {alias:step.alias,dapiId:child.id,dapiVersionId:child.publishedVersion.id};
  });
  return {name:p.xapi.name,slug:p.xapi.slug,timeoutMs:p.xapi.timeoutMs,rateLimitPerMinute:p.xapi.rateLimitPerMinute,steps};
}
export function consumptionApplicationInput<T extends Service>(scope:ConsumptionScope,services:T[]) {
  if(!consumptionPlanAvailable(scope))throw Error('当前没有可核对的服务消费计划');
  const scoped=consumptionServices(services,scope),p=scope.plan;
  const all=[...p.dapis.map(d=>d.slug),p.xapi.slug].map(slug=>scoped.find(s=>s.slug===slug&&s.status==='PUBLISHED'&&s.publishedVersion));
  if(all.some(s=>!s))throw Error('本计划的两个DAPI及XAPI都发布后才能创建唯一测试应用');
  return {name:p.applicationName,serviceIds:[all[0]!.id,all[2]!.id]};
}
export function serviceApplicationStatus(app:{status:string;expiresAt?:string},now=Date.now()) {
  if(app.status==='REVOKED')return 'REVOKED';
  return app.status==='EXPIRED'||app.status==='ACTIVE'&&app.expiresAt&&Date.parse(app.expiresAt)<=now?'EXPIRED':app.status;
}
export function applicationStatusText(status:string,historical=false) {
  if(status==='REVOKED')return historical?'应用已撤销，历史记录保留':'已撤销';
  if(status==='EXPIRED')return historical?'应用已到期，历史记录保留':'已到期';
  if(status==='ACTIVE')return historical?'对照时有效，当前权限需重新核验':'有效';
  return '应用状态未确认';
}
