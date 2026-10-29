// Display-side known contracts. Server-side family and artifact checks remain authoritative.
export type ValidationFamily = {id:string;contextIds:string[];name?:string;definitionVersion?:number;metricLabels?:Record<string,string>};
const legacyIds=["holdings-t1","cash-change","duplicate-position","equal-value-positions","cash-only-client"];
const stockIds=["stock-cash-t1","stock-cash-cash-change","stock-cash-duplicate-position","stock-cash-equal-value-positions","stock-cash-cash-only-client"];
export function validationFamilyForContextId(contextId?:string):ValidationFamily|undefined{
  if(contextId===undefined||legacyIds.includes(contextId))return{id:"securities-assets-five-fixtures-2026-09-14",contextIds:[...legacyIds]};
  if(stockIds.includes(contextId))return{id:"securities-stock-cash-five-fixtures-v1",contextIds:[...stockIds]};
  return undefined;
}
export function regressionsMatchFamily(validation:{passed?:boolean;contractId?:string;regressions?:{contextId:string;passed:boolean}[]}|undefined,family:ValidationFamily|undefined):boolean{
  const cases=validation?.regressions;
  return Boolean(family&&validation?.passed===true&&(validation.contractId===undefined||validation.contractId===family.id)&&
    Array.isArray(cases)&&cases.length===family.contextIds.length&&cases.every(c=>c&&typeof c.contextId==="string")&&new Set(cases.map(c=>c.contextId)).size===family.contextIds.length&&
    family.contextIds.every(id=>cases.some(c=>c.contextId===id&&c.passed===true)));
}
