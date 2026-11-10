export type DistributionMetadata={id:string;name:string;dimension:string;grain:string;definition:string;definitionVersion:number;contextIds:string[];keyFields:string[];
 fields:{name:string;type:string;label:string;scale?:number;min?:string;max?:string}[];metrics:{field:string;label:string;sourceFields:string[]}[];constraints:string[]};
export function distributionMetadataForContext(id?:string):DistributionMetadata|undefined;
export function distributionMetadataById(id?:string):DistributionMetadata|undefined;
export function distributionGrainLabel(grain:string):string;
