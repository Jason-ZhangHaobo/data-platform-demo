const fail = (message) => Object.assign(new Error(message), { status: 422 });

export const agentIntentDestinations = Object.freeze([
  { id: "development", label: "数据开发", action: "生成或修正 Spark SQL，并进入真实运行与断言", risk: "MEDIUM" },
  { id: "sources", label: "数据源与离线同步", action: "设计连接、元数据采集或离线同步草稿", risk: "MEDIUM" },
  { id: "sync", label: "实时同步", action: "设计受限实时任务草稿，不启动消费", risk: "MEDIUM" },
  { id: "assets", label: "数据资产与契约", action: "找数据、解释口径或评估版本影响", risk: "LOW" },
  { id: "quality", label: "数据质量", action: "设计规则草稿并说明实际检测范围", risk: "MEDIUM" },
  { id: "security", label: "安全与脱敏", action: "设计最小权限策略；不查询、不审批", risk: "HIGH" },
  { id: "services", label: "数据服务", action: "设计 DAPI/XAPI 草稿；不发布、不发令牌", risk: "MEDIUM" },
  { id: "reports", label: "数据报表", action: "设计受治理数据集或报表草稿", risk: "LOW" },
  { id: "schedules", label: "调度与发布", action: "查看交付包、审阅与调度证据；不自动审批或发布", risk: "HIGH" },
  { id: "ops", label: "运维监控", action: "基于事故摘要提出不可执行诊断建议", risk: "HIGH" },
]);

const byId = new Map(agentIntentDestinations.map((item) => [item.id, item]));

export function validateAgentIntentMessage(value) {
  if (typeof value !== "string" || value.trim().length < 4 || value.length > 2000)
    throw fail("Agent任务描述长度不合法");
  const message = value.trim();
  if (
    /(?:\b(?:access[_-]?key|secret|password|token)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{8,}|jdbc:(?:mysql|postgresql):|oss:\/\/|aliyuncs\.com|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(
      message,
    )
  )
    throw fail("Agent任务描述不得包含密钥、密码、令牌、连接串或私钥");
  return message;
}

export const publicAgentIntentDestinations = () =>
  agentIntentDestinations.map(({ id, label, action, risk }) => ({ id, label, action, risk }));

export function validateAgentIntentRoute(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("模型未返回可解析的跨模块任务路由");
  const destinationId = String(value.destinationId ?? ""),
    destination = byId.get(destinationId),
    summary = String(value.summary ?? "").trim(),
    rationale = String(value.rationale ?? "").trim(),
    confidence = Number(value.confidence);
  if (!destination) throw fail("模型推荐了未受支持的数据中台模块");
  if (summary.length < 4 || summary.length > 240)
    throw fail("模型任务摘要长度不合法");
  if (rationale.length < 4 || rationale.length > 800)
    throw fail("模型路由说明长度不合法");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw fail("模型路由置信度不合法");
  const rawSteps = Array.isArray(value.steps)
      ? value.steps
      : [{ destinationId, objective: summary }],
    steps = rawSteps.map((step) => {
      const stepDestinationId = String(step?.destinationId ?? ""),
        stepDestination = byId.get(stepDestinationId),
        objective = String(step?.objective ?? "").trim();
      if (!stepDestination || objective.length < 4 || objective.length > 240)
        throw fail("模型跨模块建议步骤不合法");
      return {
        destinationId: stepDestinationId,
        label: stepDestination.label,
        risk: stepDestination.risk,
        objective,
      };
    });
  if (
    steps.length < 1 ||
    steps.length > 3 ||
    steps[0].destinationId !== destinationId ||
    new Set(steps.map((step) => step.destinationId)).size !== steps.length
  )
    throw fail("模型跨模块建议必须从主推荐开始，且最多三步不重复");
  return {
    destinationId,
    destination: { ...destination },
    summary,
    rationale,
    confidence,
    steps,
    execution: "NO_EXECUTION",
    requiresHumanReview: steps.some((step) => step.risk !== "LOW"),
    notice:
      "仅完成任务理解与模块推荐；不会执行同步、查询、审批、发布、发令牌或修改权限。",
  };
}
