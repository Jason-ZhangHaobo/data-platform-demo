import type {CalendarSelection} from './trading-calendar-client.mjs';
export type CalendarSource={revisionId:string;revisionHash:string;runId:string;requirementBinding?:{protocol:string;taskId:string;basisDigest:string;reportDigest:string}};
export type CalendarBody={expectedSource:CalendarSource;calendarSelection:CalendarSelection};
export type CalendarPending={taskId:string;requestId:string;body:CalendarBody};
export function checkedAgentCalendarSource(taskId:string,source:CalendarSource):CalendarSource;
export function agentCalendarBody(input:{taskId:string;source:CalendarSource;calendarSelection:CalendarSelection}):CalendarBody;
export function checkedCalendarDelivery<T>(value:T,input:{taskId:string;source:CalendarSource;calendarSelection:CalendarSelection}):T;
export function prepareAgentCalendar(client:{request:(path:string,options:unknown)=>Promise<unknown>},input:{taskId:string;source:CalendarSource;calendarSelection:CalendarSelection;requestId:string;confirm:true}):Promise<unknown>;
export function agentDeliveryWorkflowPath(taskId:string,deliveryId?:string):string;
export function pendingAgentCalendar(href:string,taskId:string):CalendarPending|undefined;
export function agentCalendarLocation(href:string,pending:CalendarPending):string;
export function selectedAgentDelivery(href:string,taskId:string,source?:{revisionId:string;runId:string}):string|undefined;
export function agentDeliveryLocation(href:string,taskId:string,deliveryId:string,source?:{revisionId:string;runId:string}):string;

export function leaveAgentCalendarRecovery(href:string):string;

export function agentCalendarRequestWorkflowPath(taskId:string,requestId:string):string;
