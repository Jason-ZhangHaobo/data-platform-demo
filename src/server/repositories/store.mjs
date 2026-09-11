import { randomUUID } from "node:crypto";

export const createSeedState = () => {
  const now = new Date();
  const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const tasks = [
    {
      id: randomUUID(), name: "客户主数据每日全量同步", description: "将演示客户主数据同步至分析库，当前仅模拟执行。",
      sourceType: "MySQL", sourceName: "demo_crm.customer_master", targetType: "PostgreSQL", targetName: "demo_dw.dim_customer",
      syncMode: "FULL", schedule: "每天 02:00", owner: "产品体验组", enabled: true, status: "SUCCESS",
      createdAt: minutesAgo(4_320), updatedAt: minutesAgo(32), lastRunAt: minutesAgo(32),
    },
    {
      id: randomUUID(), name: "订单增量同步", description: "按更新时间提取新增订单并写入明细层。",
      sourceType: "PostgreSQL", sourceName: "demo_trade.orders", targetType: "MySQL", targetName: "demo_dw.dwd_order_detail",
      syncMode: "INCREMENTAL", schedule: "每 30 分钟", owner: "数据开发组", enabled: true, status: "READY",
      createdAt: minutesAgo(2_880), updatedAt: minutesAgo(85), lastRunAt: minutesAgo(85),
    },
    {
      id: randomUUID(), name: "供应商档案同步", description: "验证停用任务在调度侧不会被执行。",
      sourceType: "CSV", sourceName: "demo_supplier.csv", targetType: "MySQL", targetName: "demo_dw.dim_supplier",
      syncMode: "FULL", schedule: "每周一 04:00", owner: "采购数据组", enabled: false, status: "STOPPED",
      createdAt: minutesAgo(8_640), updatedAt: minutesAgo(720),
    },
  ];
  const devJobs = [
    {
      id: randomUUID(), name: "会员画像日汇总", description: "将演示会员明细聚合为画像宽表，当前仅模拟执行。", jobType: "SQL",
      sql: "SELECT member_level, city, COUNT(*) AS member_count\nFROM business_demo.customer_profile\nGROUP BY member_level, city\nLIMIT 1000;",
      schedule: "每天 03:00", owner: "数据开发组", enabled: false, status: "DRAFT",
      createdAt: minutesAgo(1_440), updatedAt: minutesAgo(120),
    },
  ];
  const maskingRules = [
    {
      id: randomUUID(), name: "投资者手机号脱敏", description: "客户适当性和运营分析场景使用，保留前三位与后四位。", fieldName: "investor_phone", strategy: "PHONE", sampleValue: "13812348000", owner: "数据安全组", enabled: true,
      createdAt: minutesAgo(960), updatedAt: minutesAgo(90), previewCount: 2,
    },
    {
      id: randomUUID(), name: "证券账户脱敏", description: "资产分析仅展示账户前缀和末四位。", fieldName: "security_account", strategy: "SECURITY_ACCOUNT", sampleValue: "SEC-DEMO-0001234", owner: "经纪数据组", enabled: true,
      createdAt: minutesAgo(720), updatedAt: minutesAgo(75), previewCount: 1,
    },
    {
      id: randomUUID(), name: "投资者标识脱敏", description: "合规演示中隐藏投资者身份标识，禁止使用真实证件号。", fieldName: "investor_id_card", strategy: "ID_CARD", sampleValue: "ID-DEMO-19900101-1234", owner: "数据安全组", enabled: false,
      createdAt: minutesAgo(480), updatedAt: minutesAgo(180), previewCount: 0,
    },
  ];
  const assets = [
    {
      id: randomUUID(), name: "证券主数据", physicalName: "ods_security_master", assetType: "TABLE", layer: "ODS", domain: "行情参考", owner: "行情数据组", sensitivity: "PUBLIC", tags: ["证券", "主数据", "行情"], description: "虚构证券代码、市场和交易日历的标准化主数据。", upstream: ["外部行情文件（虚构）"], fields: [
        { name: "security_code", label: "证券代码", type: "STRING", sensitivity: "PUBLIC", description: "虚构证券标识，如 SEC-DEMO-0001" },
        { name: "security_name", label: "证券简称", type: "STRING", sensitivity: "PUBLIC", description: "证券展示名称" },
        { name: "market", label: "交易市场", type: "STRING", sensitivity: "PUBLIC", description: "沪深港等市场分类的虚构值" },
        { name: "trade_date", label: "交易日", type: "DATE", sensitivity: "PUBLIC", description: "行情所属交易日" },
      ], updatedAt: minutesAgo(35), indexedAt: minutesAgo(12), status: "ACTIVE",
    },
    {
      id: randomUUID(), name: "投资者账户", physicalName: "dwd_investor_account", assetType: "TABLE", layer: "DWD", domain: "经纪业务", owner: "经纪数据组", sensitivity: "RESTRICTED", tags: ["投资者", "账户", "适当性"], description: "投资者证券账户的标准化宽表，仅用于虚构的客户资产分析。", upstream: ["ods_investor_account", "dim_branch"], fields: [
        { name: "investor_id", label: "投资者标识", type: "STRING", sensitivity: "RESTRICTED", description: "禁止写入真实证件号" },
        { name: "security_account", label: "证券账户", type: "STRING", sensitivity: "RESTRICTED", description: "需经过证券账户脱敏规则后对外展示" },
        { name: "account_status", label: "账户状态", type: "STRING", sensitivity: "INTERNAL", description: "正常、休眠等虚构状态" },
        { name: "open_date", label: "开户日期", type: "DATE", sensitivity: "INTERNAL", description: "账户开户日期" },
      ], updatedAt: minutesAgo(48), indexedAt: minutesAgo(13), status: "ACTIVE",
    },
    {
      id: randomUUID(), name: "订单成交明细", physicalName: "dwd_order_trade", assetType: "TABLE", layer: "DWD", domain: "交易清算", owner: "交易数据组", sensitivity: "SENSITIVE", tags: ["订单", "成交", "清算"], description: "订单、成交和交易方向标准化明细，供交易与清算分析使用。", upstream: ["ods_order_event", "ods_trade_event", "ods_security_master"], fields: [
        { name: "order_id", label: "订单标识", type: "STRING", sensitivity: "SENSITIVE", description: "虚构订单标识" },
        { name: "security_code", label: "证券代码", type: "STRING", sensitivity: "PUBLIC", description: "关联证券主数据" },
        { name: "side", label: "买卖方向", type: "STRING", sensitivity: "INTERNAL", description: "买入或卖出" },
        { name: "trade_quantity", label: "成交数量", type: "DECIMAL", sensitivity: "SENSITIVE", description: "成交数量" },
        { name: "trade_time", label: "成交时间", type: "TIMESTAMP", sensitivity: "SENSITIVE", description: "成交发生时间" },
      ], updatedAt: minutesAgo(62), indexedAt: minutesAgo(16), status: "ACTIVE",
    },
    {
      id: randomUUID(), name: "持仓快照", physicalName: "dws_position_snapshot", assetType: "DATASET", layer: "DWS", domain: "财富管理", owner: "资产分析组", sensitivity: "SENSITIVE", tags: ["持仓", "市值", "资产分析"], description: "按交易日汇总投资者持仓和市值的分析数据集。", upstream: ["dwd_investor_account", "dwd_order_trade", "ods_security_master"], fields: [
        { name: "security_account", label: "证券账户", type: "STRING", sensitivity: "RESTRICTED", description: "内部关联键，展示需脱敏" },
        { name: "security_code", label: "证券代码", type: "STRING", sensitivity: "PUBLIC", description: "关联证券主数据" },
        { name: "holding_quantity", label: "持仓数量", type: "DECIMAL", sensitivity: "SENSITIVE", description: "交易日持仓数量" },
        { name: "market_value", label: "持仓市值", type: "DECIMAL", sensitivity: "SENSITIVE", description: "虚构市值金额" },
      ], updatedAt: minutesAgo(72), indexedAt: minutesAgo(17), status: "ACTIVE",
    },
    {
      id: randomUUID(), name: "基金净值指标", physicalName: "ads_fund_nav_metric", assetType: "VIEW", layer: "ADS", domain: "资产管理", owner: "资管数据组", sensitivity: "INTERNAL", tags: ["基金", "净值", "指标"], description: "基金产品净值和收益指标的主题视图。", upstream: ["dwd_fund_nav", "dim_fund_product"], fields: [
        { name: "fund_code", label: "基金代码", type: "STRING", sensitivity: "PUBLIC", description: "虚构基金标识" },
        { name: "nav_date", label: "净值日期", type: "DATE", sensitivity: "PUBLIC", description: "净值所属日期" },
        { name: "unit_nav", label: "单位净值", type: "DECIMAL", sensitivity: "INTERNAL", description: "虚构单位净值" },
        { name: "return_1d", label: "日收益率", type: "DECIMAL", sensitivity: "INTERNAL", description: "日收益指标" },
      ], updatedAt: minutesAgo(88), indexedAt: minutesAgo(18), status: "ACTIVE",
    },
  ];
  const securityRoles = [
    { id: "role-platform-admin", name: "平台管理员", description: "负责平台配置、权限和审计管理。", permissions: ["asset.read", "asset.sensitive.read", "asset.restricted.read", "masking.preview", "masking.manage", "dev.write", "audit.read"], maxSensitivity: "RESTRICTED" },
    { id: "role-data-security", name: "数据安全管理员", description: "负责敏感数据规则、访问审核和安全审计。", permissions: ["asset.read", "asset.sensitive.read", "asset.restricted.read", "masking.preview", "masking.manage", "audit.read"], maxSensitivity: "RESTRICTED" },
    { id: "role-data-engineer", name: "数据开发工程师", description: "负责数据开发和受控资产检索。", permissions: ["asset.read", "asset.sensitive.read", "masking.preview", "dev.write"], maxSensitivity: "SENSITIVE" },
    { id: "role-business-analyst", name: "业务分析师", description: "只读查看公开与内部资产并使用脱敏预览。", permissions: ["asset.read", "masking.preview"], maxSensitivity: "INTERNAL" },
  ];
  const securityUsers = [
    { id: "user-investor-analyst", name: "林分析", username: "investor_analyst_demo", department: "财富管理部", roleIds: ["role-business-analyst"], status: "ACTIVE" },
    { id: "user-data-engineer", name: "周开发", username: "data_engineer_demo", department: "数据开发部", roleIds: ["role-data-engineer"], status: "ACTIVE" },
    { id: "user-data-security", name: "顾安全", username: "data_security_demo", department: "数据安全部", roleIds: ["role-data-security"], status: "ACTIVE" },
    { id: "user-platform-admin", name: "许平台", username: "platform_admin_demo", department: "平台运营部", roleIds: ["role-platform-admin"], status: "ACTIVE" },
  ];
  const auditLogs = [
    { id: randomUUID(), actorId: "user-data-engineer", actorName: "周开发", action: "asset.read", resourceType: "asset", resourceId: "dws_position_snapshot", sensitivity: "SENSITIVE", result: "ALLOW", reason: "角色允许读取敏感资产", createdAt: minutesAgo(18) },
    { id: randomUUID(), actorId: "user-investor-analyst", actorName: "林分析", action: "asset.restricted.read", resourceType: "asset", resourceId: "dwd_investor_account", sensitivity: "RESTRICTED", result: "DENY", reason: "角色最高可访问内部等级", createdAt: minutesAgo(42) },
    { id: randomUUID(), actorId: "user-data-security", actorName: "顾安全", action: "masking.preview", resourceType: "masking_rule", resourceId: "投资者手机号脱敏", sensitivity: "SENSITIVE", result: "ALLOW", reason: "安全管理员允许预览脱敏样例", createdAt: minutesAgo(65) },
  ];
  const holdingsAssetId = assets.find((asset) => asset.physicalName === "dws_position_snapshot")?.id ?? "asset-position-snapshot";
  const qualityRules = [
    { id: randomUUID(), name: "持仓客户不能为空", assetId: holdingsAssetId, ruleType: "NOT_NULL", fieldName: "client_id", threshold: 0, owner: "数据质量组", enabled: true, description: "持仓快照必须具备客户标识。", updatedAt: minutesAgo(20), lastStatus: "PASS", lastScore: 100 },
    { id: randomUUID(), name: "持仓证券代码唯一性", assetId: holdingsAssetId, ruleType: "UNIQUE", fieldName: "security_code", threshold: 0, owner: "数据质量组", enabled: true, description: "同一客户和交易日内证券代码不应重复。", updatedAt: minutesAgo(40), lastStatus: "PASS", lastScore: 98 },
    { id: randomUUID(), name: "持仓快照 T+1 时效", assetId: holdingsAssetId, ruleType: "FRESHNESS", fieldName: "trade_date", threshold: 1, owner: "数据运维组", enabled: true, description: "交易日收盘后的持仓快照应在次日 02:30 前完成。", updatedAt: minutesAgo(55), lastStatus: "WARN", lastScore: 92 },
  ];
  const streamJobs = [
    { id: randomUUID(), name: "行情事件实时同步", description: "虚构行情事件通过 Kafka 进入 Flink SQL，供财富顾问盘中分析。", engine: "FLINK_SQL", sourceTopic: "demo.market.quote", targetTable: "dws_realtime_quote", sql: "INSERT INTO dws_realtime_quote\nSELECT security_code, market, price, event_time\nFROM demo_market_quote\nWATERMARK FOR event_time AS event_time - INTERVAL '5' SECOND;", owner: "实时数据组", enabled: false, status: "STOPPED", checkpointIntervalMs: 30_000, updatedAt: minutesAgo(28), metrics: { lagMs: 0, throughput: 0, events: 0 } },
  ];
  const dataSources = [
    { id: randomUUID(), name: "证券业务 MySQL", sourceType: "MYSQL", environment: "staging", endpoint: "rm-demo.rds.aliyuncs.com:3306/business_demo", owner: "数据集成组", description: "虚构证券业务数据库，用于 CSV→MySQL 和任务验收。", enabled: true, status: "CONNECTED", lastTestAt: minutesAgo(15), metadata: { status: "COLLECTED", collectedAt: minutesAgo(10), classification: "SIMULATED", objectCount: 2, fieldCount: 9, sensitiveFieldCount: 5, assetPhysicalNames: ["dwd_investor_account", "dwd_order_trade"] }, updatedAt: minutesAgo(20) },
    { id: randomUUID(), name: "投资者持仓 CSV", sourceType: "CSV", environment: "local", endpoint: "src/shared/demo_position_snapshot.csv", owner: "经纪数据组", description: "虚构投资者持仓样例文件。", enabled: true, status: "CONNECTED", lastTestAt: minutesAgo(40), metadata: { status: "COLLECTED", collectedAt: minutesAgo(38), classification: "SIMULATED", objectCount: 1, fieldCount: 4, sensitiveFieldCount: 2, assetPhysicalNames: ["dws_position_snapshot"] }, updatedAt: minutesAgo(45) },
    { id: randomUUID(), name: "行情事件 Kafka", sourceType: "KAFKA", environment: "staging", endpoint: "demo.market.quote", owner: "实时数据组", description: "虚构行情事件 Topic，当前只做模拟。", enabled: false, status: "NOT_TESTED", lastTestAt: null, updatedAt: minutesAgo(60) },
    { id: randomUUID(), name: "证券分析数仓", sourceType: "HIVE_SPARK", environment: "staging", endpoint: "demo_dw / Spark SQL", owner: "数据开发组", description: "Hive/Spark SQL 方向的虚构数仓执行环境。", enabled: false, status: "NOT_TESTED", lastTestAt: null, updatedAt: minutesAgo(75) },
  ];
  const dataContracts = [
    { id: randomUUID(), name: "持仓快照数据契约", assetPhysicalName: "dws_position_snapshot", version: "1.0.0", status: "ACTIVE", compatibility: "BACKWARD_COMPATIBLE", owner: "资产分析组", consumers: ["财富顾问客户持仓分析", "T+1 数据质量检查"], requiredFields: ["security_account", "security_code", "holding_quantity", "market_value"], qualitySlo: "交易日 T+1 02:30 前可用；关键字段非空率 ≥ 99.9%", changePolicy: "新增字段向后兼容；删除或修改字段需先评估下游消费者。", updatedAt: minutesAgo(14) },
    { id: randomUUID(), name: "订单成交明细数据契约", assetPhysicalName: "dwd_order_trade", version: "0.9.0", status: "DRAFT", compatibility: "REVIEW_REQUIRED", owner: "交易数据组", consumers: ["交易清算分析", "持仓快照加工"], requiredFields: ["order_id", "security_code", "trade_quantity", "trade_time"], qualitySlo: "交易日内增量延迟 ≤ 30 分钟；订单标识唯一。", changePolicy: "字段类型或口径变化必须经下游开发、质量与业务负责人评审。", updatedAt: minutesAgo(32) },
  ];
  const opsIncidents = [
    {
      id: randomUUID(), title: "持仓快照 T+1 时效提醒", severity: "MEDIUM", status: "OPEN", source: "数据质量规则：持仓快照 T+1 时效",
      asset: "dws_position_snapshot", impact: "财富顾问客户持仓分析看板可能延后刷新", owner: "数据运维组", detectedAt: minutesAgo(18),
      runbook: ["确认上游持仓同步任务是否完成", "检查 trade_date 分区与数据质量检查记录", "必要时在模拟环境重跑依赖任务", "确认看板时效恢复后关闭告警"],
    },
  ];
  return {
    tasks,
    runs: [
      { id: randomUUID(), taskId: tasks[0].id, status: "SUCCESS", startedAt: minutesAgo(33), finishedAt: minutesAgo(32), rowsRead: 12_480, rowsWritten: 12_480, message: "模拟执行完成，源端与目标端记录数一致。" },
      { id: randomUUID(), taskId: tasks[1].id, status: "SUCCESS", startedAt: minutesAgo(87), finishedAt: minutesAgo(85), rowsRead: 2_316, rowsWritten: 2_316, message: "模拟增量同步完成。" },
    ],
    devJobs,
    devRuns: [],
    maskingRules,
    maskingPreviews: [],
    assets,
    securityRoles,
    securityUsers,
    auditLogs,
    agentPlans: [],
    qualityRules,
    qualityRuns: [],
    agentEvalRuns: [],
    streamJobs,
    dataSources,
    dataContracts,
    opsIncidents,
  };
};

export const summaryFromState = (state) => {
  const today = new Date().toISOString().slice(0, 10);
  const finishedRuns = state.runs.filter((run) => run.status !== "RUNNING");
  const successfulRuns = finishedRuns.filter((run) => run.status === "SUCCESS");
  return {
    totalTasks: state.tasks.length,
    enabledTasks: state.tasks.filter((task) => task.enabled).length,
    runningTasks: state.tasks.filter((task) => task.status === "RUNNING").length,
    successRate: finishedRuns.length ? Math.round((successfulRuns.length / finishedRuns.length) * 100) : 100,
    runsToday: state.runs.filter((run) => run.startedAt.startsWith(today)).length,
  };
};
