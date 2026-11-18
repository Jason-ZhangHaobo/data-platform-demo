export type DevelopmentFeedback = {id:string;status:string;tab:string;manual:boolean};

export function developmentValidationScenarios<T extends {passed:boolean}>(scenarios:readonly T[]|undefined):T[] {
  return [...(scenarios??[])].sort((a,b)=>Number(a.passed)-Number(b.passed));
}

export function nextDevelopmentFeedback(
  current:DevelopmentFeedback|undefined,
  run:{id:string;status:string}|undefined,
):DevelopmentFeedback|undefined {
  if(!run)return current;
  const manual=current?.id===run.id&&current.manual;
  return {id:run.id,status:run.status,manual,
    tab:manual?current.tab:run.status==='VALIDATION_FAILED'?'校验':run.status==='FAILED'?'日志':'结果'};
}
