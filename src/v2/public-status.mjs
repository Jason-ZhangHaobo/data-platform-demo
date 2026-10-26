const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));

// Public capability discovery is not an operational report. No bill, user
// statistics, snapshot hashes, table counts, endpoints or cloud identifiers.
export function publicCapabilityStatus(status){
 return {
  ...pick(status,['projectId','mode','capabilities','publicReady']),
  site:pick(status.site,['registeredName','icpNumber','icpUrl']),
  model:pick(status.model,['configured','model','connectionVerified']),
  spark:pick(status.spark,['available','engine','isolation','transport','healthVerified','publicWriteEnabled']),
  python:pick(status.python,['available','engine','isolation','memoryLimitRequired','cloudVerified','publicWriteEnabled']),
  metadata:pick(status.metadata,['driver','cloudVerified']),
  persistence:{...pick(status.persistence,['mode','healthy']),dataState:pick(status.persistence?.dataState,['driver','healthy'])},
  artifacts:pick(status.artifacts,['driver','durable','cloudVerified']),
  agentDevelopment:pick(status.agentDevelopment,['durableEnabled','durableDeliveryEnabled','eventBackgroundAvailable','publishAvailable','sqlMaxAttempts','sqlTokenBudget']),
  validationContract:pick(status.validationContract,['id','fixtureCount']),
  dataServices:pick(status.dataServices,['privateEnabled','scope']),
  ingestion:{...pick(status.ingestion,['sourceType','availableSourceTypes']),serverMysql:pick(status.ingestion?.serverMysql,['configured','supportsOfflineSync','credentialMode'])},
  authentication:pick(status.authentication,['mode','publicSessionEnforced']),
  scheduler:pick(status.scheduler,['mode','durableTickConfigured','publicDeployed']),
 };
}
