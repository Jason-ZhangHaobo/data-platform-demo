import type {PublishedReportBinding} from './published-report-request.mjs';
export function readReportIntent(client:{request:(path:string)=>Promise<unknown>},input:{requestId:string;source?:PublishedReportBinding}):
  Promise<{id:string;requestId:string;messageHash:string;reportSource:PublishedReportBinding;
    status:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'INTERRUPTED';approvalMode:'PLAN_ONLY'|'REQUEST_APPROVAL'}>;
