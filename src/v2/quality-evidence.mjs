// Read-time interpretation preserves historical rows instead of rewriting an
// old empty-input pass into evidence that was never actually collected.
export function nonemptyQualityPass(run) {
  return Boolean(run&&run.status==='PASSED'&&run.actualExecution===true&&Number.isSafeInteger(run.evaluatedCount)&&run.evaluatedCount>0&&
    run.passedCount===run.evaluatedCount&&run.failedCount===0&&run.passRate===1);
}
export function qualityRunView(run) {
  if(run.status==='PASSED'&&run.evaluatedCount===0)
    return {...run,status:'NO_DATA',passRate:null,storedStatus:'PASSED',reasonCode:'QUALITY_LEGACY_EMPTY_PASS'};
  if(run.status==='PASSED'&&!nonemptyQualityPass(run))
    return {...run,status:'UNCONFIRMED',passRate:null,storedStatus:'PASSED',reasonCode:'QUALITY_PASS_UNPROVEN'};
  return run;
}
export function qualityAlertView(alert,runFor) {
  if(alert.status!=='RESOLVED')return alert;
  const recovery=runFor(alert.recoveryRunId);
  if(nonemptyQualityPass(recovery)&&recovery.ruleId===alert.ruleId)return alert;
  return {...alert,status:'OPEN',storedStatus:'RESOLVED',recoveryUnconfirmed:true};
}
export function qualityRuleHealth(rule,lastRun) {
  if(lastRun&&lastRun.ruleVersionId!==rule.currentVersionId)return 'PENDING';
  if(lastRun?.evaluatedCount===0)return 'NO_DATA';
  if(rule.health==='HEALTHY'&&!nonemptyQualityPass(lastRun))return 'UNCONFIRMED';
  return rule.health;
}
