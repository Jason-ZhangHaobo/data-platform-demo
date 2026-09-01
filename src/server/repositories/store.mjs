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
  return {
    tasks,
    runs: [
      { id: randomUUID(), taskId: tasks[0].id, status: "SUCCESS", startedAt: minutesAgo(33), finishedAt: minutesAgo(32), rowsRead: 12_480, rowsWritten: 12_480, message: "模拟执行完成，源端与目标端记录数一致。" },
      { id: randomUUID(), taskId: tasks[1].id, status: "SUCCESS", startedAt: minutesAgo(87), finishedAt: minutesAgo(85), rowsRead: 2_316, rowsWritten: 2_316, message: "模拟增量同步完成。" },
    ],
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
