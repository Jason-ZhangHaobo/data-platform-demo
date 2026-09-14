const agentKinds = [
  "agent",
  "service_agent_plan",
  "ingestion_agent_plan",
  "realtime_agent_plan",
  "asset_agent_task",
  "quality_agent_plan",
  "security_agent_plan",
  "report_agent_plan",
  "ops_agent_diagnosis",
];

const remoteRunKinds = ["run", "delivery_verification", "release_run"];

const fail = (message, code) =>
  Object.assign(new Error(message), { status: 429, code });

const numberSetting = (value, fallback, min, max, name) => {
  const result = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max)
    throw new Error(`${name}配置不合法`);
  return result;
};

const monthKey = (value) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
};

const tokens = (usage = {}) => {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    total = Number(usage.total_tokens ?? input + output);
  return {
    input: Number.isSafeInteger(input) && input > 0 ? input : 0,
    output: Number.isSafeInteger(output) && output > 0 ? output : 0,
    total: Number.isSafeInteger(total) && total > 0 ? total : 0,
  };
};

const coderPrice = (inputTokens) => {
  if (inputTokens <= 32_000) return { input: 4, output: 16 };
  if (inputTokens <= 128_000) return { input: 6, output: 24 };
  if (inputTokens <= 256_000) return { input: 10, output: 40 };
  return { input: 20, output: 200 };
};

const modelCost = (model, usage, fallbackTokens) => {
  const measured = tokens(usage),
    total = measured.total || fallbackTokens;
  if (String(model ?? "").startsWith("qwen3-coder-plus")) {
    const price = coderPrice(measured.input || total);
    if (!measured.input && !measured.output)
      return (total * price.output) / 1_000_000;
    const inferredOutput = measured.output || Math.max(0, total - measured.input);
    return (
      (measured.input * price.input + inferredOutput * price.output) /
      1_000_000
    );
  }
  // Unknown model/version usage is charged at the highest configured Coder
  // output tier so an unrecognized model cannot silently bypass the guard.
  return (total * 200) / 1_000_000;
};

const usageEntries = (item, fallbackTokens) => {
  if (item.mode !== "LIVE_MODEL" && !item.model && !item.usage)
    return [];
  if (Array.isArray(item.attempts) && item.attempts.length)
    return item.attempts
      .filter((attempt) => attempt.model || attempt.usage)
      .map((attempt) => ({
        model: attempt.model,
        usage: attempt.usage,
        cost: modelCost(attempt.model, attempt.usage, fallbackTokens),
      }));
  if (!item.model && !tokens(item.usage).total) return [];
  return [
    {
      model: item.model,
      usage: item.usage,
      cost: modelCost(item.model, item.usage, fallbackTokens),
    },
  ];
};

export class BudgetManager {
  constructor({ store, project, env = process.env, now = Date.now }) {
    this.store = store;
    this.project = project;
    this.env = env;
    this.now = now;
    this.hardLimitCny = numberSetting(
      env.V2_HARD_MONTHLY_BUDGET_CNY,
      200,
      1,
      10_000,
      "月度硬预算",
    );
    this.modelLimitCny = numberSetting(
      env.V2_MODEL_MONTHLY_BUDGET_CNY,
      50,
      0.1,
      this.hardLimitCny,
      "模型月度预算",
    );
    this.sparkSecondsLimit = numberSetting(
      env.V2_MONTHLY_REMOTE_SPARK_SECONDS_LIMIT,
      3600,
      1,
      2_678_400,
      "远程Spark月度秒数",
    );
    this.sparkRunLimit = numberSetting(
      env.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT,
      200,
      1,
      100_000,
      "远程Spark月度运行数",
    );
    this.fallbackTokens = numberSetting(
      env.V2_MODEL_TOKEN_BUDGET,
      32_000,
      1,
      1_000_000,
      "单任务Token预算",
    );
    this.accountSpendCny =
      env.V2_ACCOUNT_MONTHLY_SPEND_CNY === undefined ||
      env.V2_ACCOUNT_MONTHLY_SPEND_CNY === ""
        ? undefined
        : numberSetting(
            env.V2_ACCOUNT_MONTHLY_SPEND_CNY,
            undefined,
            0,
            10_000_000,
            "账号月度支出",
          );
  }

  overview() {
    const currentMonth = monthKey(this.now()),
      modelRecords = agentKinds.flatMap((kind) =>
        this.store
          .list(kind, this.project)
          .filter((item) => monthKey(item.createdAt) === currentMonth)
          .flatMap((item) => usageEntries(item, this.fallbackTokens))),
      modelCostCny = modelRecords.reduce((sum, item) => sum + item.cost, 0),
      remoteRuns = remoteRunKinds.flatMap((kind) =>
        this.store
          .list(kind, this.project)
          .filter(
            (item) =>
              monthKey(item.createdAt) === currentMonth &&
              (item.isolation === "FUNCTION_PROCESS" ||
                item.mode === "CLOUD_ISOLATED_FILE_REHEARSAL" ||
                item.adapter === "remote-spark-worker-v1"),
          )),
      remoteSparkSeconds = remoteRuns.reduce(
        (sum, item) => sum + Math.max(0, Number(item.durationMs ?? 0)) / 1000,
        0,
      );
    return {
      month: currentMonth,
      preferredTotalCny: 50,
      hardLimitCny: this.hardLimitCny,
      model: {
        estimatedCostCny: Number(modelCostCny.toFixed(6)),
        limitCny: this.modelLimitCny,
        recordedCalls: modelRecords.length,
        estimation: "TOKEN_USAGE_WITH_CONSERVATIVE_MISSING_USAGE",
      },
      remoteSpark: {
        runCount: remoteRuns.length,
        runLimit: this.sparkRunLimit,
        seconds: Number(remoteSparkSeconds.toFixed(3)),
        secondsLimit: this.sparkSecondsLimit,
      },
      account: {
        observedSpendCny: this.accountSpendCny,
        source:
          this.accountSpendCny === undefined
            ? "NOT_CONNECTED"
            : "DEPLOYMENT_VERIFIED_INPUT",
      },
      enforced:
        this.accountSpendCny !== undefined &&
        this.accountSpendCny >= this.hardLimitCny
          ? "HARD_STOP"
          : modelCostCny >= this.modelLimitCny ||
              remoteRuns.length >= this.sparkRunLimit ||
              remoteSparkSeconds >= this.sparkSecondsLimit
            ? "RESOURCE_STOP"
            : "ALLOW",
      scope:
        "模型Token与远程Spark用量门；账号账单未接入时不能证明全站费用低于硬上限",
    };
  }

  assertCanStartModel() {
    const status = this.overview();
    this.#assertAccount(status);
    const projected = modelCost(
      this.env.V2_MODEL ?? "qwen3-coder-plus",
      {},
      this.fallbackTokens,
    );
    if (status.model.estimatedCostCny + projected > status.model.limitCny)
      throw fail(
        "本月模型预算不足以启动下一次最坏情况任务",
        "MONTHLY_MODEL_BUDGET_EXCEEDED",
      );
    return status;
  }

  assertCanStartRemoteSpark() {
    const status = this.overview();
    this.#assertAccount(status);
    const projectedSeconds = numberSetting(
      this.env.V2_REMOTE_SPARK_RESERVATION_SECONDS,
      30,
      1,
      300,
      "远程Spark预留秒数",
    );
    if (
      status.remoteSpark.runCount + 1 > status.remoteSpark.runLimit ||
      status.remoteSpark.seconds + projectedSeconds >
        status.remoteSpark.secondsLimit
    )
      throw fail(
        "本月远程Spark配额不足以启动下一次任务",
        "MONTHLY_SPARK_BUDGET_EXCEEDED",
      );
    return status;
  }

  #assertAccount(status) {
    if (
      status.account.observedSpendCny !== undefined &&
      status.account.observedSpendCny >= status.hardLimitCny
    )
      throw fail(
        "账号本月支出已达到硬上限，收费操作已停止",
        "MONTHLY_HARD_BUDGET_EXCEEDED",
      );
  }
}

export const budgetAgentCreationPaths = new Set([
  "/api/v2/agent/tasks",
  "/api/v2/data-services/agent/plans",
  "/api/v2/sync/agent/plans",
  "/api/v2/streams/agent/plans",
  "/api/v2/assets/agent/tasks",
  "/api/v2/quality/agent/plans",
  "/api/v2/security/agent/plans",
  "/api/v2/reports/agent/plans",
  "/api/v2/operations/agent/diagnoses",
]);
