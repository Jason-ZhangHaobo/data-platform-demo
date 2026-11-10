// Browser/model safe: contains schema and semantics, never independent answers.
import registry from './output-contract-metadata.json' with {type:'json'};
export function distributionMetadataForContext(id){
 const value=registry.contracts.find(c=>c.contextIds.includes(id));
 return value?structuredClone(value):undefined;
}
export function distributionMetadataById(id){
 const value=registry.contracts.find(c=>c.id===id);
 return value?structuredClone(value):undefined;
}
export function distributionGrainLabel(grain){
 return {CLIENT_TRADE_DATE_ASSET_CLASS:'每个客户 × 交易日 × 资产类别',CLIENT_TRADE_DATE_INDUSTRY:'每个客户 × 交易日 × 行业标签'}[grain]??'每个客户 × 交易日';
}
