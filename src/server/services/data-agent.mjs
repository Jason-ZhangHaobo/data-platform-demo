const includesAny = (text, words) => words.some((word) => text.includes(word));

const commonSteps = [
  "识别业务意图和涉及的数据中台模块",
  "补齐数据范围、敏感等级和影响范围",
  "展示执行计划，等待用户明确确认",
  "执行后写入审计并返回结果",
];

export function planAgentRequest(message) {
  const text = String(message ?? "").trim();
  const isAsset = includesAny(text, ["找表", "资产", "字段", "血缘", "元数据"]);
  const isMasking = includesAny(text, ["脱敏", "手机号", "证件", "证券账户", "银行卡"]);
  const isDevelopment = includesAny(text, ["SQL", "sql", "数据开发", "指标", "宽表", "查询"]);
  const isSync = includesAny(text, ["同步", "CSV", "持仓", "订单", "成交", "行情", "MySQL", "数据库"]);
  let intent = "UNKNOWN";
  if (isAsset) intent = "ASSET_SEARCH";
  else if (isMasking) intent = "MASKING_RULE";
  else if (isSync) intent = "SYNC_TASK";
  else if (isDevelopment) intent = "DEV_JOB";

  if (intent === "UNKNOWN") return {
    intent, title: "需要补充业务意图", summary: "我暂时无法判断这是同步、开发、脱敏还是资产检索需求。",
    questions: ["请说明你要处理的是数据同步、数据开发、数据脱敏还是数据资产查询？"], steps: commonSteps,
    draft: {}, risks: ["未识别到可执行模块，暂不创建或修改任何资源。"], requiresConfirmation: true,
  };

  if (intent === "ASSET_SEARCH") return {
    intent, title: "证券数据资产检索计划", summary: `根据你的描述检索证券数据资产：${text}`,
    questions: [], steps: ["在证券资产目录中搜索资产、字段、标签和血缘", "展示候选资产及敏感等级", "用户确认后返回可引用的资产上下文"],
    draft: { query: ["持仓", "投资者", "订单", "成交", "基金", "净值", "证券"].find((keyword) => text.includes(keyword)) ?? text }, risks: ["检索结果可能包含敏感资产，仅展示元数据，不返回业务数据。"], requiresConfirmation: true,
  };

  if (intent === "MASKING_RULE") {
    const strategy = text.includes("手机号") ? "PHONE" : text.includes("证券账户") ? "SECURITY_ACCOUNT" : text.includes("银行卡") ? "BANK_CARD" : text.includes("姓名") ? "NAME" : "ID_CARD";
    const fieldName = strategy === "PHONE" ? "investor_phone" : strategy === "SECURITY_ACCOUNT" ? "security_account" : strategy === "BANK_CARD" ? "bank_card" : strategy === "NAME" ? "investor_name" : "investor_id";
    return {
      intent, title: "证券敏感字段脱敏计划", summary: `为 ${fieldName} 生成 ${strategy} 脱敏规则草稿。`, questions: [],
      steps: ["确认字段敏感等级和展示范围", "生成脱敏规则草稿", "预览虚构样例", "用户确认后保存规则并记录审计"],
      draft: { name: `${fieldName} 脱敏规则`, description: "由 Data Agent 根据证券行业场景生成的虚构演示规则。", fieldName, strategy, sampleValue: strategy === "PHONE" ? "13812348000" : strategy === "SECURITY_ACCOUNT" ? "SEC-DEMO-0001234" : "ID-DEMO-19900101-1234", owner: "数据安全组", enabled: false },
      risks: ["不会读取或处理真实客户、证件、账户或银行卡数据。", "规则保存前需要用户确认。"], requiresConfirmation: true,
    };
  }

  if (intent === "DEV_JOB") return {
    intent, title: "证券数据开发任务计划", summary: "生成一个只读、带 LIMIT 的 SQL 开发任务草稿。", questions: [],
    steps: ["识别指标和数据范围", "生成 SQL 草稿并执行静态校验", "创建为未发布的开发任务", "用户确认后再进入模拟运行"],
    draft: { name: "证券指标分析 SQL", description: "Data Agent 生成的虚构证券行业 SQL 草稿。", jobType: "SQL", sql: "SELECT security_code, SUM(market_value) AS total_market_value\nFROM dws_position_snapshot\nGROUP BY security_code\nLIMIT 1000;", schedule: "手动", owner: "数据开发组", enabled: false },
    risks: ["仅创建未发布 SQL 草稿，不执行真实生产查询。"], requiresConfirmation: true,
  };

  const syncMode = text.includes("全量") ? "FULL" : "INCREMENTAL";
  const questions = [];
  if (!includesAny(text, ["每天", "每小时", "每周", "工作日", "凌晨", "手动"])) questions.push("请确认调度周期，例如每个工作日 02:00 或手动执行。");
  if (!includesAny(text, ["MySQL", "PostgreSQL", "Oracle"])) questions.push("请确认目标业务数据库类型。");
  return {
    intent, title: "证券数据同步任务计划", summary: "生成一个面向证券业务数据的离线同步任务草稿。", questions,
    steps: ["确认源端文件/表、目标业务表、同步模式和调度周期", "生成字段与风险摘要", "创建为未启用的同步任务", "用户确认后再进入模拟或真实受控执行"],
    draft: { name: text.includes("持仓") ? "投资者持仓同步" : "证券业务数据同步", description: "Data Agent 生成的虚构证券行业同步任务草稿。", sourceType: "CSV", sourceName: text.includes("订单") ? "demo_order_trade.csv" : "demo_position_snapshot.csv", targetType: text.includes("PostgreSQL") ? "PostgreSQL" : "MySQL", targetName: text.includes("持仓") ? "demo_dw.position_snapshot" : "demo_dw.security_business", syncMode, schedule: "每个工作日 02:00", owner: "数据集成组", enabled: false },
    risks: ["任务默认为未启用，不会自动执行。", "真实 CSV→MySQL 仅在明确配置并通过安全检查后运行。"], requiresConfirmation: true,
  };
}
