import {getContext,validationFamilyForContext} from './context.mjs';
import {validationMatchesFamily} from './delivery.mjs';
import {equalValidationNumber} from './validation-details.mjs';
export function successfulRegisteredSqlRun(run,contextId){
  const context=getContext(contextId),family=validationFamilyForContext(contextId);
  return !!context&&!!family&&run?.contextId===contextId&&run.status==='SUCCEEDED'&&run.engine==='Apache Spark'&&run.engineVersion==='3.5.9'&&run.mainSqlExecuted===true&&run.testDouble!==true&&
    run.validationContractId===family.id&&validationMatchesFamily(run.validation,family,{requireContract:true})&&Array.isArray(run.rows)&&run.rows.length===context.expected.length&&
    context.expected.every(want=>{const matches=run.rows.filter(row=>row?.client_id===want.client_id);return matches.length===1&&['holding_market_value','available_cash','total_assets','security_count'].every(k=>equalValidationNumber(matches[0][k],want[k]));});
}
