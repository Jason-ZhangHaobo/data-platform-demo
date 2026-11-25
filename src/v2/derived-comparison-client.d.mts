export type DerivedRunReference = {
  taskId:string; revisionId:string; runId:string; revisionHash:string; contextId:string; validationContractId:string;
};
type Amounts = {
  holding_market_value:string; available_cash:string; total_assets:string; security_count:number;
};
type Observation = {before:Amounts;after:Amounts;delta:Amounts};
type Source = DerivedRunReference & {contextName:string};
export type DerivedResultComparison =
  | {protocol:'shuduo-derived-result-comparison/v1';taskId:string;state:'PENDING';reason:'CHILD_RUNNING'}
  | {protocol:'shuduo-derived-result-comparison/v1';taskId:string;state:'UNAVAILABLE';reason:'NOT_DERIVED'|'UNSUPPORTED_GRAIN'|'SCOPE_CHANGED'|'SOURCE_UNCONFIRMED'|'CHILD_UNCONFIRMED'|'INVALID_ROWS'|'CUSTOMER_SCOPE_CHANGED'}
  | {protocol:'shuduo-derived-result-comparison/v1';taskId:string;state:'MATCHED';parent:Source;child:Source;
     rows:Array<Observation & {clientId:string}>;totals:Observation};
export function checkedDerivedComparison(value:unknown, expected:{taskId:string;parent?:Partial<DerivedRunReference>;child?:Partial<DerivedRunReference>}):DerivedResultComparison;
export function readDerivedComparison(client:{request(path:string):Promise<unknown>},args:{taskId:string}):Promise<DerivedResultComparison>;
