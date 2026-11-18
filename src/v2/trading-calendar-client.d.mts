export type CalendarSelection={calendarId:string;calendarDigest:string};
export type TradingCalendar={id:string;name:string;market:string;version:string;digest:string;timezone:string;range:{start:string;end:string};checkedOn:string;notice:string;tradingDayCount?:number;tradingDays?:string[];sources:{year:number;publishedOn:string;publisher:string;url:string}[]};
export type TradingDayResolution={protocol:string;readOnly:true;calendarId:string;calendarDigest:string;date:string;timezone:string;isTradingDay:boolean;classification:'TRADING_DAY'|'HOLIDAY'|'WEEKEND';holidayCode?:string;previous:{status:string;date?:string};next:{status:string;date?:string};t1:{eligible:boolean;status:string;businessDate:string|null};notice:string};
type Client={request:(path:string)=>Promise<unknown>};
export function calendarPath(calendarId:string):string;
export function calendarResolutionPath(input:{calendarId:string;date:string;calendarDigest?:string}):string;
export function readTradingCalendars(client:Client):Promise<TradingCalendar[]>;
export function readTradingCalendarVersion(client:Client,id:string):Promise<TradingCalendar>;
export function readTradingDay(client:Client,input:{calendarId:string;date:string;calendarDigest?:string}):Promise<TradingDayResolution>;
