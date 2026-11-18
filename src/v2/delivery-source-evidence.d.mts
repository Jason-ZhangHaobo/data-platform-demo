export type DeliveryExecutionSource = {
  testDouble?:boolean;mainSqlExecuted?:boolean;engine?:string;engineVersion?:string;isolation?:string;
};
export function supportedDeliverySparkVersion(version:unknown,remote?:boolean):boolean;
export function deliverySourceExecutionIssue(run:DeliveryExecutionSource|null|undefined):{code:string;message:string}|undefined;
