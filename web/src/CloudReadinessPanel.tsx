import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, CircleDollarSign, Cloud, ShieldAlert } from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Readiness = {
  evidenceAvailable: boolean;
  ready: boolean;
  checks: Record<string, boolean>;
  failedChecks: string[];
  scope: string;
  notice: string;
  evidence?: {
    generatedAt: string;
    billingCycle: string;
    bill: { available: boolean; pretaxAmount: number | null };
  };
};
const labels: Record<string, string> = {
  sanitizedFormat: "脱敏审计格式",
  sanitizedEvidence: "审计内容未含敏感信息",
  region: "杭州地域",
  freshEvidence: "24小时内审计",
  currentBillingCycle: "当前计费周期",
  billAvailable: "账单读取可用",
  belowHardBudget: "账单低于200元硬上限",
  mysqlReady: "独立MySQL元数据库账号",
  privateOssReady: "私有OSS状态存储",
  dedicatedFunctionVerified: "专用FC函数、角色与单并发",
  functionTargetMatches: "函数目标与部署配置匹配",
  sameVpc: "FC与RDS同VPC",
  domainFiledAndOwned: "域名备案、归属与HTTPS",
  publicHostMatches: "公网域名与备案证据匹配",
};

export function CloudReadinessPanel({ api }: { api: Api }) {
  const [value, setValue] = useState<Readiness>(),
    [error, setError] = useState("");
  const load = async () => {
    setError("");
    try {
      setValue(await api<Readiness>("/cloud/readiness"));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  useEffect(() => { load(); }, []);
  return <section className="cloud-readiness-v2">
    <header><div><span className="eyebrow">PUBLIC DEPLOYMENT GATE</span><h3>公网部署前置</h3><p>只展示脱敏布尔证据与账单摘要；资源名称、地址、账号和凭证永不显示。</p></div><span className={`status-pill ${value?.ready ? "succeeded" : "queued"}`}>{value?.ready ? "可进入部署验证" : "部署保持阻断"}</span></header>
    {error ? <div className="cloud-readiness-error-v2" role="alert">{error}</div> : value ? <><div className="cloud-readiness-meta-v2"><div><Cloud size={15} /><span>审计</span><strong>{value.evidenceAvailable ? value.evidence?.generatedAt ?? "已读取" : "尚无可用证据"}</strong></div><div><CircleDollarSign size={15} /><span>本期账单</span><strong>{value.evidence?.bill.available ? `¥${value.evidence.bill.pretaxAmount ?? "—"}` : "未连接"}</strong></div><div><ShieldAlert size={15} /><span>当前结论</span><strong>{value.ready ? "前置齐备" : `${value.failedChecks.length}项待补齐`}</strong></div></div><div className="cloud-readiness-checks-v2">{Object.entries(value.checks).map(([key, passed]) => <div key={key} className={passed ? "passed" : "waiting"}>{passed ? <CheckCircle2 size={14} /> : <span />}{labels[key] ?? key}</div>)}</div><footer><span>{value.notice}</span>{!value.ready && <a className="button" href="https://github.com/Jason-ZhangHaobo/data-platform-demo/settings/environments" target="_blank" rel="noreferrer">配置 v2-staging <ArrowUpRight size={14} /></a>}<a className="button" href="https://shell.aliyun.com/" target="_blank" rel="noreferrer">打开 Cloud Shell <ArrowUpRight size={14} /></a><button className="button" onClick={load}>刷新脱敏状态</button></footer></> : <p>正在读取脱敏部署状态…</p>}
  </section>;
}
