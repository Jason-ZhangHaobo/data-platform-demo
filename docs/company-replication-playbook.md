# 将“Agent原生数据中台”复刻到成熟企业平台

版本 1.2 · 2026-11-12。用于将数舵 V2 的任务流程、证据和验收方法接入已有企业平台。

本手册只使用虚构证券案例和通用系统代号，不包含公司截图、地址、账号、架构细节或数据。

## 一、先明确复刻的对象

值得复刻的不是“做一个聊天框”，而是以下闭环：

> 用户意图 → 受治理上下文 → Agent计划 → 代码/配置Diff → 隔离执行 → 独立断言 → 版本包 → 审批 → 发布/调度 → 监控/恢复 → DAPI/XAPI授权消费 → 反馈评测

经典中台仍是能力底座。Agent、GUI、CLI和MCP调用同一套版本化API；权限、数据口径、版本和运行证据不会因为入口改变而改变。

公司已有成熟平台时，优先复用已有数据源、计算引擎、调度、元数据、审批、安全和监控。数舵V2提供产品模式、接口契约、验收方法和参考实现，不建议把本机SQLite或样例调度器迁入生产。

## 二、参考架构映射

| 数舵V2概念 | 企业平台应映射到 | 复刻重点 |
|---|---|---|
| Project/Context | 工作空间、项目、环境、数据域 | 每次Agent任务固定项目、环境和业务日期 |
| Auth/Role | 企业SSO、IAM、项目成员、数据权限 | Agent使用发起人的身份，不拥有隐形超级权限 |
| Asset/Metric/Standard/Contract | 元数据目录、指标平台、标准与契约中心 | 给Agent可引用的稳定ID、版本和责任人 |
| CodeRevision | 现有SQL/脚本节点和Git版本 | 模型修改以Diff呈现，旧验证随代码变化失效 |
| ExecutionRun | Hive/Spark/Flink/SQL执行引擎 | 隔离、限时、限资源，保存引擎错误和结果摘要 |
| DeliveryPackage | 调度DAG、参数、资源、部署清单 | 同一摘要绑定代码、测试、日历、依赖和目标环境 |
| Approval/Release | 现有审批、发布中心、调度平台 | 批准精确版本；变更后必须重新审阅 |
| Quality/Security | 质量平台、数据安全、脱敏和审计 | 质量可阻断发布；Agent继承行列权限 |
| DAPI/XAPI | 数据服务/API网关/应用授权 | 参数、版本、Scope、限流、日志和消费血缘同源 |
| Operations | 日志、指标、Trace、告警和工单 | 诊断引用真实证据，确认不等于恢复 |
| AgentTask/Trace/Evaluation | 企业模型网关、Agent编排与评测平台 | 记录每步工具、模型、Token、批准、失败和反馈 |

## 三、两条协作路线

### 数据产品经理路线

1. 选择高频、痛点强、结果可断言的证券任务，不先追求覆盖所有模块。
2. 固化业务口径、输入/输出契约、权限边界、交易日规则和失败标准。
3. 盘点公司现有API、元数据ID、审批、调度和监控接口；标记缺口和负责人。
4. 审阅Agent计划、代码Diff、测试证据和发布摘要；不代替Agent写关键产物。
5. 组织工程师完成同任务手工/Agent对照，收集耗时、点击数、返工、正确率和信任反馈。
6. 根据失败类型排序迭代：上下文缺失、工具缺失、模型错误、执行错误、权限拒绝、体验问题分别处理。
7. 只把有证据的能力带入公司试点；形成培训、制度和推广范围。

### Codex/研发实现路线

1. 把现有平台原子能力封装为版本化API，先补幂等、错误结构、权限和审计。
2. 建立只读上下文工具，再建立草稿/执行/发布等有风险工具；为每类工具定义批准策略。
3. 实现任务状态机和持久化Trace，页面关闭后任务仍可恢复。
4. 将聊天意图、全局任务面板与代码编辑器Diff连通，允许用户随时接管。
5. 建立真实执行和独立断言，不让模型自评或HTTP 200充当完成证据。
6. 按模块接入Agent：先人工/API验收经典能力，再开放相同能力给Agent、CLI和MCP。
7. 建立冻结评测、成本门、发布门和回滚；每次发布同步代码、接口、文档和证据。

## 四、里程碑与产物

| 里程碑 | 生成物 | 为什么重要 | 验收门槛 |
|---|---|---|---|
| R0 现状基线 | 用户旅程、接口盘点、手工耗时、错误分类、数据边界 | 没有基线就无法证明Agent真的赋能 | 同一任务可重复，指标定义一致 |
| R1 原子能力层 | OpenAPI、CLI、MCP工具、资源ID/版本、错误码、审计 | 让人和Agent使用同一能力，避免两套系统 | API与GUI结果一致，越权失败关闭 |
| R2 代码开发Agent | 上下文包、计划、SQL/Python Diff、运行、测试、修复Trace | 首先解决工程师最高频痛点 | 新数据/新口径能生成新结果；失败可解释 |
| R3 调度发布闭环 | DAG、日历、部署清单、摘要审批、版本、批次、回滚 | 从“写代码助手”升级为真实交付助手 | 发布版本与批准/批次/结果一一对应 |
| R4 数据服务消费 | DAPI/XAPI、OpenAPI、应用Scope、限流、日志 | 证明加工结果能被外部系统实际消费 | 授权应用取得实际结果，撤销立即生效 |
| R5 跨模块治理 | 资产/血缘/质量/安全/报表/运维与Agent | 让智能化进入整个平台而非孤岛 | 每模块人工/API/Agent至少1条真实用例 |
| R6 试点评测 | ≥20完整任务、手工对照、反馈、成本和故障演练 | 决定是否扩大投入 | 完整E2E≥85%，失败/救援不删除 |
| R7 规模化 | SSO、HA/DR、容量、SLA、推广和培训 | 从个人验证变成企业产品 | 安全/运维/成本委员会认可，SLA达标 |

## 五、第一条公司试点旅程

建议仍采用“财富顾问查询客户持仓，理解字段后生成资产分析报表”，因为结果可核验、业务价值直观，又能串联开发与消费：

1. 工程师在项目中选择经授权的账户、持仓和现金表，固定业务日期和字段口径。
2. 描述T+1客户资产需求；Agent引用表/字段/指标/交易日规则并生成计划。
3. 编辑器显示SQL Diff；工程师接受、局部修改或拒绝。
4. Agent在隔离Spark环境运行并读取错误，最多限定次数修复。
5. 独立测试检查客户编号、持仓市值、可用现金、口径内总资产及去重证券数量，尤其防止现金因持仓关联重复累计。仅股票持仓加现金的结果应显示该口径。资产类别和行业分布使用另立的字段契约及断言。
6. 生成DAG、部署清单和测试报告；审批人确认不可变摘要。
7. 发布后由真实调度触发；监控时效、质量、资源和失败信号。
8. 生成持仓报表及DAPI，再由XAPI组合持仓与现金；示例外部系统使用自己的应用身份调用。
9. 保存任务Trace和用户反馈，与工程师手工过程比较。

这一条走通前，不建议同时铺开十个业务场景。走通后按基金组合穿透、适当性标签、行情迟到修正和运营报表逐步扩展。

## 六、API、CLI、MCP的产品要求

API是原子能力和治理契约；GUI、CLI、MCP是不同使用入口，不应重新实现业务规则。

- API：稳定资源模型、版本、幂等、Scope、错误码、异步任务、Webhook/轮询、审计。
- GUI：适合非技术用户和复杂审阅，清楚展示上下文、Diff、证据、风险和下一步。
- CLI：适合工程师脚本、CI/CD和批量操作；秘密从环境/凭证库读取，不进入参数历史。
- MCP：适合Agent发现与调用工具；描述必须包含副作用、权限、是否需要批准和返回证据。

验收不是“命令存在”，而是四个入口命中同一资源ID、同一权限判断、同一版本和同一运行记录。

## 七、Agent安全与信任设计

| 风险级别 | 示例 | 默认策略 |
|---|---|---|
| 只读 | 查表结构、血缘、日志摘要、运行状态 | 可自动执行，仍记录Trace |
| 草稿 | 生成SQL、映射、规则、DAG、DAPI定义 | 可自动生成，必须以Diff供审阅 |
| 受控执行 | 运行测试、读取有限样例、创建临时计算 | 在沙箱和预算内自动或一次批准 |
| 环境变更 | 发布、回滚、授权、审批、启动实时任务 | 绑定摘要并明确批准；不能复用旧批准 |
| 高风险/破坏 | 删除、扩大权限、真实生产写入、大额资源 | 默认禁止或双人审批，不支持模糊长期授权 |

模型只获得完成任务所需的最小上下文。业务行、日志原文、客户信息和公司内部资料默认不发送外部模型；若必须外发，先经过分类、脱敏、用户授权和审计。

## 八、评测方法

每条任务固定需求、输入版本、输出契约、目标环境、最大模型和计算预算及成功断言。记录需求理解、代码、调试与独立核验、调度文件、部署文件、精确版本审阅、发布、监控及授权消费。

核心指标：

- 完整E2E完成率，而非SQL编译率；
- 首个正确结果时间、人工操作数、批准数和返工数；
- 断言正确率、权限拒绝正确率、恢复成功率；
- Token、计算和存储成本；
- 用户接受Diff比例、接管率、信任评分和问题归因。

同一任务的有限修正沿用原案例编号。人工代写关键产物记为救援，阻塞、取消和失败保留。当前 [v3 评测](live-lifecycle-evaluation.md)固定 20 例，完整目标至少 17 例自主完成，每例须核对同一版本的结果与授权调用。[历史本机回放](full-lifecycle-evaluation.md)和本手册的保存证据复核各有独立范围。实际公网验收进度以[当前续接清单](goal-mode-next.md)为准。

## 九、90天公司试点建议

时间只是上限，可提前完成：

- 第1—2周：R0基线和接口盘点，冻结第一批5个任务。
- 第3—5周：R1原子API与只读/草稿工具，打通SSO和审计。
- 第6—8周：R2代码Agent真实执行、Diff、修复和独立测试。
- 第9—10周：R3调度发布与监控最小闭环。
- 第11—12周：扩充到20条，做手工对照、故障演练和产品复盘。

如果现有平台API完整，可显著提前；若权限、元数据ID或执行接口缺失，先补底座，不用UI演示掩盖。

## 十、交付和复现入口

### 交接资料

先记录源码提交 SHA、评测契约、案例口径和执行环境，再交接下表材料。SQLite 用于验证站留存。企业侧对应材料由项目成员在现有受控存储和审批系统中保留。

| 材料 | 由谁准备 | 工程师接手后检查 |
|---|---|---|
| 输入快照、输出字段、业务日期、独立预期 | 数据产品经理、数据责任人 | 持仓与现金口径、基金组合粒度、T+1 和金额精度 |
| 平台元数据、查询快照、报表快照 | 执行及数据服务工程师 | 每个案例的 `metadata.sqlite`、`business.sqlite`、`reports.sqlite` 是一致的留存副本，可在受保护目录中只读打开 |
| 案例和消费编号 | 执行及数据服务工程师 | 财富案例保留发布、包摘要、原批次、原报表与运行、DAPI/XAPI 调用编号。基金另保留原准备请求、Agent 任务及报表创建请求 |
| 审阅、恢复和权限记录 | 审阅人、运维与安全人员 | 包摘要、原审批、批次监控、调用授权与撤销、未知结果对应的原编号 |

资料包含标识和业务快照时，按授权在受保护目录交接。原始凭证从企业凭证库分配，复核报告只留必要编号、摘要、计数及归因。保持业务版本、报告及分页调用编号原样，遇到缺项回查原记录。

### 在新目录走查本机留存证据

使用仓库对应源码和 Node.js 24。只读复核直接打开保存库，可在没有运行中的数舵服务和模型凭证时执行。先把授权提供的两组证据存入独立目录，设置 `WEALTH_DIR`、`FUND_DIR` 和尚无同名报告的受保护目录 `ACCEPTANCE_OUT`。命令中的其他变量为交接表所列原编号或 SHA-256。缺少留存库时，先按[本机启动与参考流程](v2-quickstart.md#在空目录复刻并读回证据)准备样例，再按[财富管理原生集成](local-real-spark-service-integration.md)或[基金保存证据复核](acceptance.md#复核已保存的基金-agent-端到端证据)走对应流程。

在仓库根目录复核财富管理。两个 DAPI 固定版本分别保存两页，XAPI 保存完整查询和两页调用。

```sh
(
  set -euC
  umask 077
  mkdir -p "$ACCEPTANCE_OUT"
  node scripts/verify-saved-wealth-lifecycle.mjs \
    --metadata "$WEALTH_DIR/metadata.sqlite" --business-snapshots "$WEALTH_DIR/business.sqlite" \
    --report-snapshots "$WEALTH_DIR/reports.sqlite" --release-id "$WEALTH_RELEASE_ID" \
    --package-digest "$WEALTH_PACKAGE_DIGEST" --batch-id "$WEALTH_BATCH_ID" \
    --report-id "$WEALTH_REPORT_ID" --run-id "$WEALTH_REPORT_RUN_ID" \
    --dapi-call-id "$WEALTH_DAPI_CALL_1" --dapi-call-id "$WEALTH_DAPI_CALL_2" \
    --dapi-call-id "$WEALTH_DAPI_CALL_3" --dapi-call-id "$WEALTH_DAPI_CALL_4" \
    --xapi-call-id "$WEALTH_XAPI_CALL_1" --xapi-call-id "$WEALTH_XAPI_CALL_2" \
    --xapi-call-id "$WEALTH_XAPI_CALL_3" > "$ACCEPTANCE_OUT/wealth.json"
)
```

复核基金时，原准备请求和原报表创建请求是两个不同的编号。此例的基金报表和质量回执保存在同一元数据副本。若使用单独的历史元数据库，按[基金报表扩展参数](acceptance.md#加入原报表与质量回执)指定。

```sh
(
  set -euC
  umask 077
  mkdir -p "$ACCEPTANCE_OUT"
  node scripts/verify-saved-fund-lifecycle.mjs --agent \
    --active-metadata "$FUND_DIR/metadata.sqlite" --business-snapshots "$FUND_DIR/business.sqlite" \
    --request-id "$FUND_PREPARATION_ID" --task-id "$FUND_TASK_ID" --release-id "$FUND_RELEASE_ID" \
    --package-digest "$FUND_PACKAGE_DIGEST" --dapi-call-id "$FUND_DAPI_CALL_1" \
    --xapi-call-id "$FUND_XAPI_CALL_1" --xapi-call-id "$FUND_XAPI_CALL_2" \
    --report-request-id "$FUND_REPORT_REQUEST_ID" --report-snapshots "$FUND_DIR/reports.sqlite" \
    > "$ACCEPTANCE_OUT/fund.json"
)
```

两个报告都应返回 `VERIFIED` 和 `LOCAL_SAVED_EVIDENCE`。财富报告核对手工开发、两个真实本机 Spark 批次、原报表两行和七条历史授权回执。基金报告核对模型替身驱动的本机 Spark 过程、原报表七行和三条质量规则的独立计数。缺少基金质量记录时返回 `INCOMPLETE`，退出码为 2。错批次、错版本、缺少分页或证据被改写时，按错误码回查留存资料。归因和环境随报告交接，正式 v3 以真实执行及独立断言计分。

### 复核带 Worker 签名的基金发布

记录生成原证据的应用版本及离线复核器的源码 SHA。离线复核器须支持[签名基金链路](acceptance.md#复核已登记的签名基金链路)，应用部署候选仍按自身的验包和审批记录核对。

在仅复核人员可访问的 `FUND_SIGNED_DIR` 交接三份保存库和原 `.data/fund-signed-receipts/`。保留原件文件名与字节、元数据里的登记关联及原调用编号。原件目录使用 0700，原件文件使用 0600。使用凭证库交接的原验签材料准备 0600 环境文件 `FUND_SIGNED_ENV`，其中提供 `V2_SPARK_EXECUTOR_SECRET`。有自定义队列配置时沿用原运行所需配置。`FUND_PROJECT_ID` 与 `FUND_ACTOR_ID` 分别取原项目和任务所属人。签名场景下各 `FUND_*` 编号取这一组签名留存记录。

```sh
(
  set -euC
  umask 077
  mkdir -p "$ACCEPTANCE_OUT"
  node --env-file "$FUND_SIGNED_ENV" scripts/verify-saved-fund-lifecycle.mjs --agent \
    --project "$FUND_PROJECT_ID" --actor "$FUND_ACTOR_ID" \
    --active-metadata "$FUND_SIGNED_DIR/metadata.sqlite" --business-snapshots "$FUND_SIGNED_DIR/business.sqlite" \
    --request-id "$FUND_PREPARATION_ID" --task-id "$FUND_TASK_ID" --release-id "$FUND_RELEASE_ID" \
    --package-digest "$FUND_PACKAGE_DIGEST" --signed-receipt-root "$FUND_SIGNED_DIR" \
    --test-clock-unit-ms "$FUND_TEST_CLOCK_UNIT_MS" --dapi-call-id "$FUND_DAPI_CALL_1" \
    --xapi-call-id "$FUND_XAPI_CALL_1" --xapi-call-id "$FUND_XAPI_CALL_2" \
    --report-request-id "$FUND_REPORT_REQUEST_ID" --report-snapshots "$FUND_SIGNED_DIR/reports.sqlite" \
    > "$ACCEPTANCE_OUT/fund-signed.json"
)
```

`FUND_TEST_CLOCK_UNIT_MS` 使用原留存刻度。普通本机调度为 1000，本手册走查的隔离样例为 500。报表保存在另一份历史元数据库时，追加 `--history-metadata` 并保留其中的原签名登记。

| 报告字段 | 工程师核对内容 |
| --- | --- |
| `requirement`、`development` | 原需求摘要、输入和断言摘要，以及确切代码版本与原运行 |
| `rehearsal`、`review` | 八文件、测试 SQL、Worker 验签结果、原演练摘要及对应审批记录 |
| `publication`、`consumption` | 原发布的两批调度与成功事件，固定接口版本和撤权后的历史分页 |
| `report`、`quality`、`provenance` | 同批报表和质量独立计数，以及本机、模型来源和评测归因 |

已在不含 `.runtime` 和 `node_modules` 的源码副本中用 Node.js 24.19.0 走查。财富、基金及签名基金报告分别与各自原报告逐字节一致。错批次、缺少质量回执、缺签名原件与错时钟均按对应路径提示。每次交接先核对退出码和报告状态，再归档证据摘要。

### 离线复核冻结持仓链路

在受保护目录 `SYNC_DIR` 交接以下原件。复制 SQLite 前停止写入，并确认 WAL 已完整检查点化，避免把未落盘的历史调用丢在侧文件。使用原任务、原发布和原批准留存的编号。

| 原件 | 校验内容 |
| --- | --- |
| `metadata.sqlite` | 原同步、元数据、Agent 请求、代码、演练、审阅、批准、两批调度与接口版本 |
| `business.sqlite`、`reports.sqlite` | 接口不可变快照、固定报表快照及内容摘要 |
| `positions.csv`、`delivery-package.json` | 原 CSV 字节、冻结字段映射及原八文件 |
| `batch-1-lineage.json`、`batch-2-lineage.json` | 各批报表的原编号、结果和历史授权调用摘要 |

在仓库根目录用 Node.js 24 执行。三个选择量从原留存记录取得，依次为发布编号、原包摘要和 Agent 提交的幂等编号。项目和工程师 ID 与本机默认值不同时，分别传入 `--project` 和 `--actor`。保留原调度刻度，默认每秒 1000 毫秒。

```sh
(
  set -euC
  umask 077
  mkdir -p "$ACCEPTANCE_OUT"
  node scripts/verify-saved-sync-sql-lifecycle.mjs \
    --metadata "$SYNC_DIR/metadata.sqlite" --business-snapshots "$SYNC_DIR/business.sqlite" \
    --report-snapshots "$SYNC_DIR/reports.sqlite" --source-csv "$SYNC_DIR/positions.csv" \
    --package-file "$SYNC_DIR/delivery-package.json" --release-id "$SYNC_RELEASE_ID" \
    --package-digest "$SYNC_PACKAGE_DIGEST" --agent-request-id "$SYNC_AGENT_REQUEST_ID" \
    --lineage "$SYNC_DIR/batch-1-lineage.json" --lineage "$SYNC_DIR/batch-2-lineage.json" \
    > "$ACCEPTANCE_OUT/frozen-holdings.json"
)
```

通过时报告返回 `VERIFIED` 和 `LOCAL_SAVED_EVIDENCE`。复核器在内存重放 CSV 字段映射，检查冻结快照和原开发断言。它核对同包批准、双批监控、完整分页、固定接口版本、撤权历史及两份独立聚合报表，输出必要编号和摘要。缺失或错误的原件以非零退出码终止。两批记录属于同一发布，计分继续按正式 v3 固定案例独立记录。运行复核命令只读留存库，无需运行数舵服务、Spark 或模型。

### 启动真实试点前

| 接手检查 | 执行负责人 | 进入下一步的证据 |
|---|---|---|
| 项目访问、计算和凭证 | 云运维及安全负责人 | 域名与 HTTPS 可信，受邀身份和项目隔离实测通过，Worker 与持久存储就绪。模型凭证由本人在受保护入口交接 |
| 具体版本与执行预算 | 工程师及审批人 | 核对冻结源码、部署和回滚制品、月度账单与预留。部署、模型、计算、发布、消费各按已批准范围执行 |
| 新任务及中断恢复 | 发起人、工程师、运维 | 保留原请求和检查点，关闭浏览器后仍能推进。发生实例变化或回执未知时核对同任务的执行与费用记录 |
| 正式入口和消费 | 产品经理、受邀用户、外部调用方 | 同一版本的真实发布、监控及授权 DAPI/XAPI 独立断言通过。实际 Safari、Chrome 和两种网络分别记录从导航到可操作的时延，首屏目标 3 秒 |

先核对待部署包、现网指纹和原回滚包，再按当前批准验收受邀只读入口。首例开发窗口绑定原请求、已验部署版本、当前账单与受邀会话。进入发布时，工程师按同一代码、独立结果、八文件和演练摘要提交人审，消费方再按原批次核对应用授权及撤销。

可先运行下列计划检查，再按[真实评测合同](live-lifecycle-evaluation.md#实际流程)及[正式入口验收](domain-binding-acceptance.md#正式浏览器首屏验收)准备各自的实际执行范围。

```sh
V2_LIVE_EVALUATION_CASE_LIMIT=20 node scripts/run-live-lifecycle-evaluation.mjs --plan
```

该命令输出固定 20 例、最大资源需求、人工审阅要求及 `willExecute=false`。实际执行从一条已授权用例开始。

### 其他资料

- 需求边界：[PRD](PRD.md)
- 决策与替代关系：[decisions.md](decisions.md)
- 架构：[architecture.md](architecture.md)
- 演进路线与Gap：[second-goal-gap-and-roadmap.md](second-goal-gap-and-roadmap.md)
- 本机启动：[v2-quickstart.md](v2-quickstart.md)
- API契约：[v2-api.md](v2-api.md)
- 云端部署：[v2-cloud-deployment.md](v2-cloud-deployment.md)
- 费用停损：[cost-controls.md](cost-controls.md)
- 全部验收：[acceptance.md](acceptance.md)

最终PPT应把本手册压缩成“总路线 + 产品经理路线 + Codex/研发路线 + 里程碑产物/意义 + 实测证据 + 公司复刻建议”。在公网与最终范围完成或用户明确要求时再生成正式版，避免把中途状态写成最终结论。
