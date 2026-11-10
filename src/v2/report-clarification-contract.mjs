export const reportClarificationProtocol='shuduo-report-clarification/v1';
export const reportClarificationKind='REPORT_CLARIFICATION_V1';
export const reportClarificationUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export const reportClarificationDigest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function reportClarificationAnswer(value){if(typeof value!=='string'||!value.trim()||value.length>1000)throw Object.assign(Error('回答须为1—1000字'),{status:422,code:'REPORT_CLARIFICATION_INPUT_INVALID'});return value.trim();}

export function reportClarificationRequestId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw Error('原回答请求编号不合法');return value;}
