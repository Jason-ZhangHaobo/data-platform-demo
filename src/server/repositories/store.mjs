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
