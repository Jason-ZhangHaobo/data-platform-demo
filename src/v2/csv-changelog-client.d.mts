export type CsvChangeConfig={epochId:string;operationField:string;sequenceField:string};
export const csvChangeMode:string;
export function csvChangeConfig(value:unknown):CsvChangeConfig;
export function csvChangeRequestId(value:string):string;
