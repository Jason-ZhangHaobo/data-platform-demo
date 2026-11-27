import {publishedReportSource} from './published-report-request.mjs';

export async function readReportIntent(client,{requestId,source}) {
  if (typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw Error('请使用原报表会话请求编号');
  const expected=source===undefined ? undefined : publishedReportSource(source);
  const intent=await client.request('/agent/intent-requests/'+requestId);
  if (intent?.requestId!==requestId || typeof intent.id!=='string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.id) ||
      typeof intent.messageHash!=='string' || !/^[a-f0-9]{64}$/.test(intent.messageHash) ||
      !['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(intent.status) ||
      !['PLAN_ONLY','REQUEST_APPROVAL'].includes(intent.approvalMode))
    throw Error('原报表会话回执未确认');
  const observed=publishedReportSource(intent.reportSource);
  if (expected && JSON.stringify(expected)!==JSON.stringify(observed)) throw Error('原报表会话的发布批次不匹配');
  return intent;
}
