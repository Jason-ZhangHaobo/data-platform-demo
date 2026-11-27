export type InvitedSqlContextReceipt={
  protocol:'shuduo-invited-sql-context/v1';scope:'INVITED_TASK_READ_ONLY';taskId:string;contextId:string;message:string;
  taskStatus:string;taskStage:string;attemptCount:number;requestId?:string;readOnly:true;fullLifecycleE2E:false;
  evidenceState:'PENDING'|'RECORDED'|'UNCONFIRMED';evidenceSource:'STORED_METADATA'|'TEST_HARNESS'|'UNCONFIRMED';
  revision?:{id:string;hash:string;sql:string};
  run?:{id:string;revisionId:string;revisionHash:string;status:string;engine?:string;engineVersion?:string;
    validation:{state:'PASSED'|'FAILED'|'UNCONFIRMED';contractId:string;regressions:{contextId:string;passed:boolean}[]}};
};
export type InvitedSqlContext=InvitedSqlContextReceipt;
export function readInvitedSqlContext(client:{request(path:string):Promise<unknown>},selection:{taskId:string;requestId?:string}):Promise<InvitedSqlContextReceipt>;
