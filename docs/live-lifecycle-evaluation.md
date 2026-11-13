# 新Agent任务：工程师审阅与受治理消费链路评测

此入口从新的证券需求创建真实Agent任务，再由现有工作流生成并演练调度/部署文件。它与[历史模型代码回放](full-lifecycle-evaluation.md)分别计分。本文记录执行器合同；实际案例完成数、人工审批、模型/Spark结果与待办以当前受保护执行记录为准，不能把本文件或源码测试当作公网验收。

新 CLI 计划和执行默认采用 `securities-live-agent-reviewed-lifecycle-v3`：固定20例覆盖客户全品类持仓＋现金、股票持仓＋现金两组口径。每组5套数据，共创建10个基础任务，再创建10个引用本轮成功基础任务的跨组口径变更任务。20例包含所有来源任务，不另加隐藏的准备任务。范围为 `LOCAL_FRESH_MODEL_CONTEXT_CHANGE_WITH_CONSUMPTION`；不等于外部系统验收、生产或公网完成。

v3 沿用完整开发、文件、独立审阅、发布、监控和 `CONSUMPTION` 门：消费核对同一任务、包、发布与成功批次的固定 DAPI 版本、XAPI 及已有授权调用。每个基础和派生任务均须使用自己的包、审阅、批准及消费结果。

旧 `securities-live-agent-reviewed-lifecycle-v1` 只覆盖至发布后监控；v2 增加受治理消费，但仍使用旧5套口径×4类意图目录。两者均保留原案例、摘要、分母和范围，不迁移为v3，不补造历史成功。v1继续只读报告；v2可按原范围恢复与刷新。库函数原有默认v2保持兼容，新增调用可传 `{contractId:currentLiveLifecycleContract.id}`；CLI新执行默认v3。

基金 Agent 的[保存证据复核](acceptance.md#复核已保存的基金-agent-端到端证据)可按原编号对照从需求到授权消费的完整本机链路。报告保留模型来源、已记录的审阅和本机执行范围。此复核使用独立协议，真实评测继续沿用上述固定目录与计分口径。

## 计划与资源边界

使用项目要求的Node.js 24运行`node scripts/run-live-lifecycle-evaluation.mjs --plan`仅输出计划，不连接服务、不提交任务。默认1例；`V2_LIVE_EVALUATION_CASE_LIMIT`可选择固定目录的前1—20例。完整v3包括两组共10套上下文的基础开发及其10个跨组变更，覆盖重复持仓、现金变化、同额不同持仓、仅有现金客户、字段范围、金额精度及口径变更；这仍不等于所有经典模块或全部证券业务范围。完整计划可设置案例数20后查看，`willExecute=false`不构成执行授权。

每例最坏情况为3次模型调用、3次代码Spark运行、1次文件演练、2次工程师批准后的发布批次，合计最多6个Spark运行；每例模型Token预留上限32000。20例上界为60次模型调用、120个Spark运行、640000 Token。执行前必须核对现有预算、真实授权和服务配置；这里只声明次数/Token边界，不把它换算为未经核验的费用保证。

冻结目录的独立预期以顾问归属、交易日、持仓编号、证券代码、股票分类和现金金额为依据，从虚构输入表按分复算。基础与派生案例各自绑定请求摘要，目标口径相同时可使用同一计算预期。复用原本机 Spark 回执时，同时比对参考 SQL、实际输入指纹和断言指纹，区分原主结果行与同族回归断言。真实评测仍按各自原任务验证独立结果、审批、调度、监控及消费。

本机运维逐例视图中，选择「核对预期」可查看该案例的交易日、业务口径、虚构客户的持仓与现金预期，以及同一次评测里的父案例状态。预期由固定目录提供。运行状态和计分继续取自原检查点及其证据，提交派生前仍须复核父案例的原任务。

执行器默认不执行。仅在已取得当前具体授权后设置`V2_LIVE_EVALUATION_AUTHORIZED=LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW`与`V2_LIVE_EVALUATION_AUTHORIZED_CASES`，再运行`node scripts/run-live-lifecycle-evaluation.mjs --execute`。配置标志不是人类授权的替代品，密钥不放在命令参数或报告里。

目标默认`http://127.0.0.1:3100`，可用`V2_LIVE_EVALUATION_ORIGIN`选择其他固定回环端口；拒绝非回环地址。执行前读取状态，要求真实模型、Spark、本机审阅发布可用，SQL最多3次修正、Token上限不超过32000。当前未提供云端执行、真实浏览器或多网络验收，不能用本机执行器冒充这些能力。

## 实际流程

1. 写入原案例、请求摘要和幂等编号后创建Agent任务；直接使用模型产出与独立结果核验，不导入冻结SQL。
2. 同一任务核对代码版本、实际Spark、客户结果和五套断言，再调用现有`prepare-delivery`生成标准八文件并按文件演练；文件摘要、DAG与输入契约由现有校验器复核。
3. 达到`AWAITING_ENGINEER_REVIEW`后停止，输出原任务工作台链接。工程师在现有工作台审阅精确代码、核验、包与演练，按原权限确认发布；执行器不会创建审阅、审批或发布记录。
4. 工程师操作后，用同一入口和原案例范围 `--resume 原评测编号` 恢复。沿原任务/交付/发布读取或推进，不创建替代任务；未开始的后续案例仍属于付费执行范围，所以此模式继续要求当前模型/计算授权及就绪检查。发布仍在运行则返回 `AWAITING_MONITORING`。
5. 同一包、同一代码版本、独立审阅及审批、两个真实Spark批次和同版监控齐全后，进入 `AWAITING_CONSUMPTION`，不能提前标记完整成功。前序检查包含激活/计划/开始/完成时间顺序、监控观察时间与批次对应关系。仅有 PASSED 或 HEALTHY 标签不够。
6. 工程师在已有数据服务工作台按原来源开发、测试、发布并完成授权调用后，用 `--refresh 原评测编号` 只读核对消费证据。只有 core 的同源与时序检查通过，原案例才进入相应含消费契约的 `SUCCEEDED`；执行器不自动建 DAPI/XAPI、发行应用凭证、调用接口或代为审批。

v3 派生案例只能引用固定 `sourceCaseId` 对应的本轮已完成基础案例。检查点冻结原任务、代码、运行、摘要、源口径、验证契约与父证据摘要；同一评测UUID和开始时间必须一致。提交前只读原版本SQL并核实际父任务与独立断言，再使用平台既有 `derivation` 创建接口。原SQL不进入评测报告，父任务的费用、批准、结果不能转移给子任务。子回执必须绑定原谱系及目标口径，结果未知只查询原请求编号。

来源未完成时记 `AWAITING_SOURCE`，来源失败时记 `BLOCKED_SOURCE`；不换来源、重建父任务或缩小分母。失败来源的子案例保持未完成，同时仍可推进其他已授权且来源有效的案例。每个目标按自己的验证族核对代码、文件演练和两批发布；旧族五场景不能替代股票族五场景。

## 命令与恢复边界

| 命令 | 作用 | 授权与写入边界 |
|---|---|---|
| `--plan` | 默认输出 v3 计划、固定来源依赖与资源上界 | 无服务请求、无评测文件写入，不代表已获费用授权 |
| `--execute` | 默认开始新的 v3 评测 | 保留原模型/计算授权、案例数与本机就绪门；不代为审阅或发布 |
| `--resume <原编号>` | 按原文件的 v2/v3 契约继续 | 仍检查当前授权及模型/Spark就绪；旧 v1 仅返回历史范围说明，不迁移、不重跑 |
| `--refresh <原编号>` | 只核对已处于 `AWAITING_CONSUMPTION` 或 `PAUSED + phase=CONSUMPTION` 的原案例 | 不要求付费 `AUTHORIZED` 标志或模型/Spark仍可用；adapter 拒绝任何 POST，只允许已保存同源 `GET /data-services/task-evidence?agent_task_id=…&package_digest=…&release_id=…` |
| `--reconcile <原编号>` | 对账 v3 中提交待确认的 Agent 或交付创建回执 | 仅读原请求账本，核对后更新本机原检查点。原任务仍由后续步骤推进 |
| `--inspect <原编号>` | 核对 v3 已受理任务的模型用量、原代码版本及 Spark 阶段 | 对照同一检查点的摘要，只读取本机已保存元数据 |
| `--report <原编号>` | 只读取新/旧原检查点，按对应契约整理已有阶段和统计 | 不访问服务，不创建锁，不修改原文件；标记 `recorded:true`、`RECORDED_CHECKPOINT_ONLY` 和 `externalTruthReverified:false` |

### 启动云端首例

启动前可用独立验包回执检查正式入口。检查点须处于未提交状态，入口、项目和验包须与原检查点绑定。需要评估待审候选时，只在隔离副本进行源码换绑对照。

```sh
node bin/shuduo.mjs agent v3-entry-preflight \
  --base-url "$V2_API_BASE" --checkpoint "$FIRST_CASE_CHECKPOINT" \
  --application-file "$FIRST_CASE_APPLICATION_INSPECTION"
```

`MATCHED` 表示返回 HTML 与验包摘要和字节数相同。`APPLICATION_BINDING_MISMATCH` 在发送请求前返回。`ENTRY_CONTENT_MISMATCH` 表示已读取 HTML、版本未匹配。`ENTRY_TIMEOUT` 表示在读取期限内未确认。命令最多发送一个匿名 GET，保留原检查点及原请求编号。响应头耗时用于诊断，交互性能继续按浏览器验收。实际开窗和提交仍使用下列独立回执和预算检查。


要同时检查浏览器启动脚本，可追加 `--zip-file /private/v2-function.zip`。命令先按独立验包核对本机 ZIP 字节和摘要，从相同 HTML 提取唯一的同源 Vite 入口脚本，再比对脚本 MIME、字节数与 SHA-256。ZIP 不匹配或入口无法解析时不发送请求。HTML 通过才请求脚本，两次匿名 GET 共用读取期限。报告的 `htmlStatus` 与 `script` 分别记录结果，`entryRequests` 与 `scriptRequests` 分别计数。成功范围为这两个静态文件。Safari／Chrome 控件时间、登录和实际任务仍按各自验收执行。

使用绑定原 V2 入口和项目的 CLI 配置。先准备受保护的检查点，再按现有新任务开发授权核对实际部署版本、当前账单及受邀会话。

控制面构建可从主分支选择已经合入的完整应用 SHA。构建在该应用提交上安装锁定依赖、跑 CI、生成 Linux ZIP 并校验重复打包的字节一致性。构建回执分别记录工作流提交、应用提交及树、运行次数、ZIP 摘要和大小。包的独立检查同时验证 GitHub 运行与产物编号、原应用检出和 ZIP 内容。旧的同提交构建仍按原方式校验。构建产物有效期一天，下载保留的 ZIP 可用于离线验真，实际部署仍需可用产物及单独有效的部署授权。

```sh
shuduo agent v3-start --checkpoint /private/first-case.json --source-revision REVIEWED_GIT_SHA
shuduo agent v3-start --checkpoint /private/first-case.json --window-binding
shuduo agent v3-start --checkpoint /private/first-case.json --window-file /private/opened-window.json --application-file /private/control-artifact-inspection.json --bill-file /private/current-bill.json --confirm
shuduo agent v3-start --checkpoint /private/first-case.json --reconcile
```

准备命令固定首例、项目、入口、已审阅源码版本、请求体摘要及原幂等编号。它只创建当前用户所有的 0600 检查点。源码版本由已核验的部署记录提供，命令不证明云端已运行该版本。

### 未提交首例更换审阅源码

首例仍为 `PREPARED` 时，在代码仓库内核对已合入本机 `origin/main` 的完整源码 SHA，导出仅供审阅的 0600 文件。审阅内容绑定原检查点、原请求摘要和目标 Git 树。确认该文件后，显式传入它的 SHA-256。

```sh
shuduo agent v3-rebind-source --checkpoint /private/first-case.json --source-revision REVIEWED_GIT_SHA --out-file /private/source-review.json
shuduo agent v3-rebind-source --checkpoint /private/first-case.json --review-file /private/source-review.json --review-digest CONFIRMED_SHA256
```

应用在原检查点锁内核对审阅内容，原子更新源码版本并追加审阅记录。评测、案例、请求编号、请求体及既有用量保留，账单文件继续独立使用。再次确认同一份已应用审阅可只读确认本机结果。已提交或结果待确认的请求继续按原编号对账。应用后旧窗口回执失效，新窗口与真实部署继续使用各自的确切授权。

### 独立开发窗口与提交

窗口绑定命令从同一未提交检查点导出首例、源码版本、文件、请求体和原编号摘要，保留原始请求编号在检查点内。换绑后的检查点也包含已审阅 Git 树。独立开窗使用受保护主分支运维流程和单独批准的 `INVITED_FIRST_V3_DEVELOPMENT_WINDOW_V1` 计划。计划的 `applicationInspection` 使用独立控制面验包结果，批准绑定中的 `applicationInspectionDigest` 固定其制品身份。开窗前核对 Git 来源、包 SHA-256、大小和控制面的 CRC64。运维流程读取完整当月账单，连同原未结算预留和本次增量核对预算，最多写入一次开发环境、一次恢复原只读环境。运行时起止时间、控制面回读和就绪状态核对后，从加密回执提取 V2 `firstCaseReceipt`，保存为当前用户所有的 0600 窗口文件。已有旧窗口仍可按原授权恢复只读。

HTTPS 提交使用 V2 独立窗口回执、原独立验包文件和 0600 账单文件。账单文件包含采集时间 `checkedAt`、完整当月账单原始页 `pages`、未结算预留 `unsettledReserveCny` 和本次费用上界 `maxIncrementCny`。命令先核对原检查点、包回执及账单，再验证实际窗口起止时间和权限。提交前增加一次无凭证的正式入口 HTML GET，校对验包记录的字节和摘要。任一校验失败时保留检查点。通过后保存会话所属人、窗口批准摘要、包身份、账单和用量基线，沿原幂等编号提交一次。服务端继续执行管理员身份、窗口时间和新任务数限制。任务创建与模型调用、Spark 执行、交付和发布各有独立边界。

首例和后续案例的新开发窗口均要求运行时支持请求绑定，开窗时按原请求正文及幂等编号生成摘要。游客只能看到绑定已开启，获准管理员的会话才能核对确切摘要。CLI 在入口探测和提交前确认摘要。历史首例若开窗时尚无此约束，仍可沿原回执查找已受理任务，或按原快照关闭和回滚；新的提交须使用已经生效的绑定窗口。

响应丢失或无法确认时，使用 `--reconcile` 和原创建者会话。它只读取身份和原请求回执，开发写入窗口关闭后仍可对账。缺少原回执时保留待定状态。

任务受理确认后，`v3-start` 返回原任务的 `taskUrl`。用原受邀账号打开链接，核对需求和检查点，再选择「委托后台继续」。页面显示「已委托」后可关闭浏览器，稍后打开同一链接读取原批次。链接只用于定位任务，打开时不会提交模型或 Spark。仍待对账的创建结果不返回任务链接。

CLI 被强制终止后，`--reconcile` 可在同一系统启动会话和进程命名空间内核实原进程已退出，重新取得检查点锁后按原编号对账。仍在运行的进程保留独占锁。旧版锁、跨机器或系统重启后遗留的锁须先人工核对进程和原检查点。发布的 `--reconcile` 也使用这一恢复方式。分母仍为20例，创建回执只证明受理。

### 核对云端首例执行阶段

```sh
shuduo agent v3-inspect --checkpoint /private/first-case.json
shuduo agent execution-evidence --request-id ORIGINAL_REQUEST_ID
```

API 为 `GET /agent/requests/{key}/execution-evidence`，MCP 对应 `agent_execution_evidence`。只允许原创建者按原幂等编号读取。接口投影已保存阶段和摘要，区分供应方已报告 Token、估算预留和未归属差额，并区分 Spark 批次等待、结果待确认及已入账。读取不协调 Worker。

带检查点的命令核对原任务、创建时间、需求和种子 SQL 摘要。只有同一代码版本与批次通过独立预期和回归断言，才保存开发来源。若检查点已有原交付创建编号，再读取同一回执并核对代码、批次、需求绑定和交付编号。待确认或不匹配的证据保留现状。此命令只写入原本机检查点，远端均为 GET。交付或演练命令被强制终止后，`v3-inspect` 可在同一启动会话内确认原进程已退出，接管检查点锁并核对原回执。开发写入窗口关闭后仍可查询已保存的回执。交付演练、工程师审阅和完整验收分别推进。

### 准备云端首例的确切版本交付

```sh
shuduo agent v3-prepare-delivery --checkpoint /private/first-case.json --bill-file /private/current-bill.json --confirm
```

使用已绑定开发结果的检查点、原创建者会话和有效开发写入窗口。命令校验完整当前月账单并保留原未结算预留，先保存交付请求的幂等编号和摘要，再提交一次 `POST /agent/tasks/{id}/prepare-delivery`。

请求的 `expectedSource` 包含 `revisionId`、`revisionHash`、`runId` 和源任务存在时的 `requirementBinding`。服务端核对原创建者、代码、实际批次与独立验证，再保存八文件及其摘要。原空对象请求仍可使用。

在受邀工作台重开绑定原请求的首例或派生任务后，「生成交付并演练」沿同一协议提交已核验的代码和批次。另一标签更新来源后，旧页面的提交会被拒绝。确切演练继续核对原交付、包摘要和批次。准备请求结果不明时，「查询原交付」先读取原请求回执，再核对当前显示的交付来源。

响应丢失后执行 `v3-inspect`，只查原请求回执。若回执显示 `storagePending`，说明该版本文件已保存到交付记录，产物存储尚待确认。在有效窗口对原交付版本执行一次 `advance-delivery` 可恢复同一文件摘要。对这一阶段的推进只恢复存储，后续 Spark 演练另行提交。两种推进均沿用原任务的审批与预算边界。

### 从工作台续接同一评测

```sh
shuduo agent v3-inspect --checkpoint /private/first-case.json --workbench
shuduo agent v3-publish --checkpoint /private/first-case.json --reconcile --workbench
shuduo agent v3-publish --checkpoint /private/first-case.json --reconcile
```

原创建者用同一受保护检查点续接。第一条通过原任务找到已保存的交付请求，再核对需求、代码版本、运行、八文件包及演练编号。历史记录未保留可查的原请求时，可追加 `--delivery-request-id ORIGINAL_UUID` 指定此前保存的原编号。缺少回执、来源不一致或同来源存在多份交付时需要人工核对原编号。

第二条按原包和演练推导工作台发布请求编号，核对存档审阅摘要和原批准。已收录后，第三条持续读取同一发布的两个原批次和运维证据。收录和复查只有 GET，不新增批准、调度、模型调用或 Spark 计算。监控确认后，校验并保存项目月度用量读数，保留原未结算预留，在下一案例沿用。用量未确认时保留已有检查点，等待同一回执复查。随后按原批次走 `v3-consumption` 和 `v3-complete`。

### 派生任务在客户端离线后继续开发

确切开发窗口绑定原派生请求正文。按原请求创建任务后，使用原任务编号和当前版本执行 `shuduo agent enable-background --id TASK_ID --version CURRENT_VERSION --confirm`，委托现有事件后台。原创建请求保持原字节，后台委托单独绑定同一授权窗口。发起后的 `shuduo agent background --id TASK_ID` 只读状态。若响应丢失，先查原任务和已有委托状态。模型或计算用量仍记在原任务上。

也可以在独立 Data Agent 工作台打开原任务，确认已保存的检查点，选择「委托后台继续」。界面沿用 `POST /agent/tasks/{id}/background`，发送原任务的当前版本，随后读取同一任务确认状态。界面提示「已委托」后可以关页，稍后打开原链接查看同一批次。请求结果不明时，先「核对原后台委托」；只有服务端返回「唤醒投递待确认」且原窗口有效时，才可明确选择「重新投递原唤醒」。

本机隔离验收在客户端断开后只投递原事件。控制面两次重开同一 SQLite，分别接续模型唤醒及 Worker 结果通知。重复事件只产生一次模型替身调用和一次 Spark 队列提交。开发窗口关闭后，按原创建请求核对同一派生任务、父代码版本、开发批次和独立校验。正式环境的浏览器关页、云实例恢复及真实模型仍按实际验收记录。

有本机 Spark 3.5.9 时可重验原事件链及真实计算：

```sh
SHUDUO_TEST_LOCAL_SPARK_DERIVATION_RECOVERY=true node --test \
  --test-name-pattern 'original events after client disconnect' test/v2/public-development-journey.test.mjs
```

### 演练云端首例的原交付包

开启 OSS 事件推进时，原创建者提交确切文件演练后可以关闭工作台。控制面只用既有 Worker 结果通知结算该交付的原批次，核对原对象路径、签名、任务正文摘要和文件断言。提交确认丢失时，同一签名结果仍可结算原批次。重复通知只读取已保存的状态。开发窗口到期后，已提交的演练可结算到待审阅；实际发布仍需独立窗口和工程师批准。

页面等待期间只读取当前演练状态，也可主动刷新。开发写入窗口有效时可单次核对原结果。文件演练尚未提交时，仍须由原创建者操作。回环验收可关闭客户端、重开控制面并投递同一结果两次，检查原包、原批次和单次计算。正式 OSS 投递和实际云实例恢复需实测。

```sh
shuduo agent v3-rehearse --checkpoint /private/first-case.json --bill-file /private/current-bill.json --confirm
shuduo agent v3-inspect --checkpoint /private/first-case.json
shuduo agent v3-rehearse --checkpoint /private/first-case.json --settle
```

首次演练使用原创建者和有效开发窗口，核对当月完整账单、未结算预留、隔离 Spark 就绪及原交付包。客户端先保存包、交付版本和用量基线。服务端将原演练批次和计算预留一并持久化，再提交冻结的主 SQL、测试 SQL 和交易日输入。

响应丢失时用 `v3-inspect` 读取原交付的已保存批次和费用预留。签名结果尚未入账时，`--settle` 在有效窗口核对同一批次，只读该 Worker 结果。缺少结果时保留原批次及预留，即使越过原执行期限也不新增提交或写取消标记。结果经测试 SQL 摘要和独立场景核验后进入待工程师审阅。

API 沿用 `POST /agent/deliveries/{id}/advance`。确切请求包含 `expectedVersion` 以及 `rehearsal.packageId`、`rehearsal.packageDigest`，对账另带 `rehearsal.verificationId`。读取原交付请求回执可取得已保存演练状态、预留毫秒数和已核验实际耗时。

### 读取云端待审阅证据

拿到原任务、确切交付编号和冻结需求的 SHA-256 后，可读取：

```sh
shuduo agent review-evidence --id TASK_ID --delivery-id DELIVERY_ID --request-sha256 SHA256
```

API 为 `GET /agent/tasks/{id}/review-evidence?delivery_id={id}&request_sha256={digest}`，MCP 对应 `agent_review_evidence`。接口沿用受邀账号和原交付权限。它读取当前已保存的模型、代码、Spark 独立核验、交付包和演练记录，只返回来源、摘要、状态与计数。

未结算的 Worker 回执保留待定状态。结算后可核对确切需求、版本、开发批次、八文件摘要及演练编号。损坏或来源不一致的记录显示待核验。该入口属于私有云已保存证据，文件正式审阅、发布和完整 v3 计分继续走原流程。

对已有的 v3 首例检查点，可以用同一入口和原创建者会话核对：

```sh
shuduo agent v3-review --checkpoint /private/original-checkpoint.json
```

检查点使用当前用户所有的绝对路径和 0600 权限，原入口须与 CLI 配置一致。命令先用原幂等编号读任务与交付创建回执。云端交付回执要求原创建者身份。只有原任务的需求、种子 SQL、创建时间、代码和已结算交付一致时，才读取第三份待审阅证据。缺回执或等待演练时保留待定或待核验结果。命令保持检查点及20例分母，后续执行和审阅沿用原权限流程。

### 导出确切版本审阅与提交发布记录

```sh
shuduo agent v3-publication-review --checkpoint /private/first-case.json --out-file /private/review.json
shuduo agent v3-publish --checkpoint /private/first-case.json --review-file /private/review.json --bill-file /private/current-bill.json --confirm
shuduo agent v3-publish --checkpoint /private/first-case.json --reconcile
```

审阅文件通过 `GET /agent/tasks/{id}/publication/preflight` 读取。按原开发批次、包摘要及演练选择，复核实际存储的八个文件、原需求、独立断言、冻结交易日期及两个计划批次。对已绑定的演练，另核对结果摘要是否登记于同一 Worker 批次。文件为当前用户所有的 0600 JSON，四项人工确认初始均为 `false`。

工程师逐项确认后，提交命令重新核对审阅文件、当月完整账单、未结算预留和独立发布窗口。先保存确切审阅摘要和原幂等编号，再向已有发布接口发出一次请求。服务端复核同一审阅摘要后创建审阅、批准、一个发布和两个待调度批次。状态为 `WAITING_SCHEDULER` 时表示发布记录已受理。

绑定原请求的首例与派生任务在独立发布窗口内均可从工作台打开「审阅并发布测试任务」。页面读取同一预检，显示冻结业务日、调度时间和审阅摘要，四项确认初始为空。点击确认时重新读取预检，依据变化会清除旧勾选。通过后提交所审阅的确切摘要；响应丢失时优先按原请求编号核对发布与两个待调度批次。

响应丢失或 CLI 被强制终止时，用 `--reconcile` 沿原创建者和原请求读取 `GET /agent/tasks/{id}/publication/requests/{key}`。在同一系统启动会话确认原进程已退出后，可接管遗留的检查点锁。回执核对同一发布、原审阅及批准和两个原批次。该读取不协调 Worker，窗口关闭后也可读取已保存的回执。实际调度、监控和消费分别验收。

只读入口或发布执行器未配置时，`GET /agent/tasks/{id}/publication` 以 `SAVED_HISTORY` 返回已保存的同源发布、批次和运维证据。所属人、确切交付包、演练、批准和批次须一致。有效交付尚无发布时返回空记录；证据错配时返回 `PUBLICATION_HISTORY_UNCONFIRMED`。工作台在此模式手动刷新，原请求回执仍可读回，监控存疑时保留 `UNCONFIRMED` 状态。该读取不访问 Worker 队列，也不推进发布或结算。

### 核对同一发布的签名调度与监控

确切审阅的发布沿用私有签名定时入口。每个新签名事件最多认领一个原批次，认领事务先保存原 Worker 编号、冻结 SQL 摘要和计算预留。提交前再次核对发布窗口、审阅摘要和预算。已有批次待确认时，后续事件先核对原签名结果，原批次未结算则下一批保持待调度。

有效的原签名事件可继续核对它认领的 Worker 回执。此前重放查不到结果时，即使已保存事件摘要，回执迟到后仍能核对。重放只读原 Worker 结果，确认通过后记录原批次及监控事件。它不会再提交 Worker、补写取消或读取其他批次的 Worker 回执。签名有效期和新批次的发布窗口保持独立校验。

启用现有 OSS 结果通知时，已认领的确切 Agent 发布批次也可凭原 Worker 回执结算。控制面核对通知来源、原定时器认领、发布批准、原批次和已签名的任务正文摘要。定时事件过期、发布窗口关闭或定时器移除后，仍可在受保护入口结算原批次。通知重复时返回已结算，监控事件只登记一次。后续批次须在有效发布窗口由原定时器认领。活动发布窗口与原任务、包或演练不符时，事件在读取 Worker 前被拒绝。

控制面重启时，如果 Worker 就绪回执过期，已有 OSS 队列只保留读取原签名结果的能力。它可以在私有事件入口结算已登记的确切演练或发布批次。新模型任务、Spark 提交、定时调度及取消保持关闭，恢复结算不延长就绪回执或授权期限。隔离验收使用相同的云启动代码和持久元数据恢复协议，正式环境的 Worker 与 OSS 仍需实测。

`shuduo agent v3-publish --checkpoint /private/first-case.json --reconcile` 读取原发布、两个原批次及已存预留。只读查询不触发 Worker。签名调度结算时将批次结果和监控事件一起落盘。两个原批次均须核对原 Worker 编号、结果登记、Spark、测试 SQL 和独立断言，各有同包、完成时间之后的成功事件且无开放告警，才返回 `monitoringStatus: VERIFIED`。Worker 签名结果带原任务正文摘要时，队列还核对该摘要。摘要错配或缺少已登记的原结果时，保留现有批次及用量，暂停确认运维和消费。

在原 Agent 任务的「审阅发布与运行监控」中，确切发布通过核对后可打开「在运维监控查看原批次」。目标页用现有发布和批次权限读取原记录，并核对代码版本、交付包摘要、审阅摘要及两个批次的顺序。页面显示保存状态及调度是否触发，可重新读取或返回原任务。

运维中的「查看原任务的发布证据」回到独立工作台的只读历史，保留原发布、开发批次、演练、交付包、审阅摘要和两个调度批次。原任务后来修改时，历史仍按所选发布查证。整次发布虽保存为健康但缺少匹配监控事件时，显示原记录待核对，接口与报表入口暂不可用。

从原发布或运维选择「查看第 1 批接口」或「查看第 2 批接口」，可读取所选批次的 DAPI、XAPI 固定版本和历史授权结果。切换批次或返回会保留原发布和审阅摘要。浏览器使用 `GET /data-services/task-evidence` 加 `release_batch_id`，服务端先核对原发布及监控，再筛选该批的版本和调用。原应用撤销后可继续核验已有记录。若服务工作区已启用，可另外打开同一批次的接口目录。

已触发但未结算的批次会显示「提交待确认」或「等待 Worker 结果」。提交确认仅表示队列写入已得到回执。到达原 Worker 时限仍无结算记录时，界面显示「结果待核对」，CLI 的 `v3-publish --reconcile` 返回 `WORKER_RESULT_UNCONFIRMED`。旧记录缺少可核对的阶段时，界面显示「运行阶段待确认」。

工作台、运维、CLI 和 MCP 按保存的原批次计算显示状态。结果待核对期间保留原批次和计算预留，不增加失败数。刷新或重开页面只读原记录。迟到的签名结果通过原定时入口结算后，界面可读回同一批次的完成状态。接口和报表入口仍须通过原双批核验。

本机测试可用 `SHUDUO_TEST_LOCAL_SPARK_RELEASE=true` 执行同一包的两个真实 Spark 批次。签名入口、队列和数据仍在隔离本机环境，真实云调度、付费执行与授权消费需分别验收。

已在独立本机进程验收提交确认丢失。队列写入并落盘后结束原控制器，新进程沿原签名事件和原批次核对迟到结果。第一批结算后，新的签名事件只认领一次第二批。发布窗口关闭后，仍可核对已提交的第二批。错批次结果被拒，两批各执行一次真实本机 Spark，各有一条对应的监控事件。此验收使用隔离 SQLite、文件队列和虚构数据。

### 核对两个原发布批次的授权消费

从运维监控的「查看第 1 批接口」或「查看第 2 批接口」进入数据服务。整次发布完成且健康，并且两个批次均已实际执行、通过 SQL 测试与独立结果验证后，页面才显示入口。数据服务重新核对任务、版本、包和批次，按本批次显示 DAPI、XAPI、应用授权与调用记录。批次错误或不在当前授权范围时提示回到原发布核对。本机 Chrome 测试版已用同一虚构发布的两个批次验证该交接。

```sh
shuduo agent v3-consumption --checkpoint /private/first-case.json --batch-id ORIGINAL_BATCH_ID --out-file /private/consumer-source.json
shuduo agent v3-consumption --checkpoint /private/first-case.json --plan /private/consumer-plan.json --call-id-digest ORIGINAL_XAPI_CALL_SHA256
```

导出前按原发布编号复核同一包、两个成功批次和监控事件，并核对私有数据服务返回的同源批次。每个服务消费窗口仍绑定一个选定批次。DAPI 与 XAPI 沿已有受邀授权和固定版本执行，独立消费者复用既有请求预算、分页、拒绝、限流及撤销断言。

核验命令读取已保存的 V2 计划和报告。独立预期须与原证券口径的登记数据一致。命令分别读取原 DAPI 与 XAPI 成功调用，核对同一应用、固定版本、结果摘要和撤销状态，再把两个调用摘要写入原检查点。重复核验可读回同一证明。每个批次单独保留证据。回环报告为 `MATCHED_ONLY`，真实外部验收与端到端计分另行核验。

受保护的只读入口可在关闭发布和数据服务执行器后，通过 `GET /data-services/task-evidence` 核对已保存消费。请求须同时指定 `agent_task_id`、`package_digest` 和 `release_id`，也可加 `call_id_digest` 找回原调用。仅原任务所属人可访问。服务端先核对同一发布、演练和监控，再沿原服务版本及快照核对已保存调用。撤销应用显示撤销状态；历史读取不创建调用、应用或任务。

服务换版后，带 `call_id_digest` 的查询仍按原调用绑定的已发布版本及其固定 DAPI 子版本核验。核验包括调用发生时的应用授权、版本和快照摘要。省略调用摘要时，页面与接口仍展示当前已发布版本的消费证据。

原生 Agent 私有测试发布的已核验调用提供「查看原调用」和「复制原调用链接」。原任务所属人打开链接，可核对同一调用的接口版本、发布批次、结果摘要和应用状态。链接定位使用调用摘要，页面经 `GET /agent/tasks/{id}/publication/history` 先核对保存的发布与批次，再读取指定消费回执。错任务、批次或调用显示核验失败。

### 核验原案例并查看 20 例续接状态

```sh
shuduo agent v3-complete --checkpoint "$FIRST_CASE_CHECKPOINT" \
  --first-plan "$FIRST_CONSUMER_PLAN" --second-plan "$SECOND_CONSUMER_PLAN" --out-file "$CASE_COMPLETION"
shuduo agent v3-run --checkpoint "$FIRST_CASE_CHECKPOINT" --completion-file "$CASE_COMPLETION"
```

完成核验沿原检查点顺序重读开发、八文件、演练、确切发布和监控。分别用两个原消费计划和报告重新核对 DAPI、XAPI 调用，再核对独立业务预期及原检查点。最多十次受邀 GET，可在只读窗口执行。缺批、错序、摘要变化或回执未匹配均不能生成完成回执。新回执以 0600 保存，绑定原检查点的原字节，原请求编号和检查点保留。

`v3-run` 可省略完成回执，离线查看原评测编号下的 20 个固定案例。有回执时核对原检查点与确切案例，回环匹配只记本机证据。受邀 HTTPS 完成还须绑定原开发窗口、独立验包、已登记的结构化需求、已结算的模型用量、原演练、确切审阅批准、双批监控和两个匹配的消费批次。完成记录列出从演练就绪到工程师批准的等待时间。缺少时间证据时先用 `v3-publish --reconcile` 核对原发布，保留同一批准与批次。

报告的 `score` 固定以 20 例为分母，列出已核验的受邀云端通过、已结算失败、来源阻塞、待结算、本机结果、替身和人工介入或非原生记录。取消与结果不明单独显示，保留在分母。完整受邀评测至少需要 17 例通过且 20 例均有确定结果。未跑完时展示已覆盖比例及还差多少个成功，最终完成率为 `null`。来源失败的派生项留在分母并单独显示。人工代写或代调仍不能进入原生完成回执。审批后的受邀评测与自主完成率独立，`directAutonomousCompletionRate` 保持未测，`fullGoalTargetMet` 不由此报告判定。

报告读取已有证据，不重查远端。报告中的 `willExecute:false` 和 `executionAuthorized:false` 分别表示未执行与未授权。

### 逐例续接固定基础案例

```sh
shuduo agent v3-prepare-next --checkpoint "$NEXT_CASE_CHECKPOINT" \
  --first-checkpoint "$FIRST_CASE_CHECKPOINT" --completion-file "$CASE_COMPLETION" \
  --source-revision "$REVIEWED_GIT_SHA"
shuduo agent v3-start --checkpoint "$NEXT_CASE_CHECKPOINT" --window-binding
shuduo agent v3-run --checkpoint "$FIRST_CASE_CHECKPOINT" --completion-file "$CASE_COMPLETION" \
  --case-records "$BASE_CASE_RECORDS"
```

首例之后按固定顺序续接其余九个基础案例。准备沿原评测编号和开始时间保存独立检查点，同一次评测的同一案例始终使用同一幂等键。第二例可直接使用上例命令。第三例起给准备命令添加 `--case-records "$BASE_CASE_RECORDS"`。该文件为权限 0600 的 JSON 数组，从第二例起按目录顺序排列，每项为 `{"checkpoint":"/private/case.json","completion":"/private/completion.json"}`，尚待核验的最后一例可省略 `completion`。续接准备接受上一例完成或开发失败结算回执。跨案例复用任务、批次、调用回执或审批均会被拒绝。

窗口使用 `INVITED_NEXT_V3_DEVELOPMENT_WINDOW_V1` 和确切验包，独立批准后才生成 `nextCaseReceipt`。续接保留历次预留，校验当前完整账单及配额。第三例起还会核对当月已记录的模型和 Spark 用量。开启前在只读状态核对控制面能力，开启后核对确切请求绑定。

提交与恢复沿用 `v3-start --confirm` 和 `v3-start --reconcile`。运行时限定受邀管理员的确切需求、SQL、口径与幂等键，丢失响应后只用原编号查询。后续各阶段沿原案例检查点处理。第二例旧报告参数 `--next-checkpoint`、`--next-completion-file` 仍可使用。

### 续接基于已核验父版本的派生案例

基础案例结算后，沿同一 `v3-prepare-next` 和 `--case-records` 顺序准备目录中的派生案例。仅选择各自父案例已核验成功的条目。父案例确认失败时，报告仍保留对应派生案例及其来源状态，随后选择其他有成功父版本的案例。

准备由原创建者只读重验父任务、代码、Spark 核验和 SQL 摘要，并将父版本标识、完成回执摘要及新请求摘要存入检查点。SQL 正文在请求进程内读取。独立窗口在启用前须核对控制面支持确切派生请求；提交时再读原 SQL，服务端按原账号、项目、版本和批次复核。原请求恢复核对回执中的父版本，新案例单独生成和核验目标口径的 Spark、交付包及演练。

隔离 HTTP 回归覆盖确切窗口、父版本变化拒绝、新口径执行和八文件回读。本机已配置 Spark 时可用 `SHUDUO_TEST_LOCAL_SPARK_DERIVATION=true` 在该回归中执行派生开发及文件演练。模型替身与本机 Spark 证据分别记录。

新派生交付把父任务、版本、批次、SQL 摘要和验证契约纳入清单。审阅、签名调度和两个服务消费批次都沿用该包摘要。即使另一父版本拥有相同 SQL，已审阅的发布也会拒绝切换来源。派生的消费断言按目标口径核对。股票持仓与现金的回归拒绝借用全品类持仓与现金的预期。

在同一个回归设置 `SHUDUO_TEST_LOCAL_SPARK_DERIVATION_RELEASE=true` 可实际运行两个签名发布批次的本机 Spark，再经运维定位、DAPI／XAPI 调用和原报告完成回执。工程师批准和授权窗口在隔离夹具中建立。本机运行、替身及正式云端按各自证据记录。

### 结算已确认的案例失败

```sh
shuduo agent v3-settle-failure --checkpoint "$CASE_CHECKPOINT" --out-file "$FAILURE_RECEIPT"
```

命令以原创建者身份做两次只读 GET，沿原检查点选择开发、文件演练或发布阶段的原请求。开发失败核对所有模型尝试用量与 Spark 批次。确切演练失败须能核对原 Worker 结果登记；确切发布失败还须两批均已收到原 Worker 结果，至少一批失败，且各自运维事件与结果对应。已结算时另存权限 0600 的失败回执。

模型用量待核对、Worker 结果未知、只有超时标志或旧记录缺少原结果登记时保留原状态。已收到明确 Worker 结果但缺少实际耗时的批次，沿用原账本预留时长。读回不触发新计算，也不改原检查点。

受邀 Agent 的「调度与部署交付」可重新读取原演练，显示 Worker 回执已确认失败或待核对。运维的「原发布批次」分别显示各批回执和整次发布的失败核验。第一批已确认、第二批未返回时，整次发布仍待核对。两处刷新只读取原记录。

用失败回执代替 `--completion-file` 或案例列表中的 `completion` 后，可准备下一独立案例，继续保留历史未结算预留和同月已确认用量。云端确认失败仍在 20 例分母中，依赖该案例的派生标为 `SOURCE_FAILED`。本机失败回执只记本机验证范围。

### 读取原任务的执行阶段

在本机运维监控展开已受理案例的模型与 Spark 状态，或执行 `node scripts/run-live-lifecycle-evaluation.mjs --inspect 原评测UUID`。CLI 与页面共用原评测记录，CLI 额外核对本机检查点文件摘要。已冻结的案例始终展示原代码版本和批次，尚未冻结的案例只读最近尝试已关联的版本及批次。

用量分别展示供应方已报告的 Token、估算预留、账本总额与暂未分配的差额。模型身份未知或请求结果待确认时保留对应的预留。读取只投影已保存元数据，未触发模型、Spark 或 Worker 对账，结果状态独立于端到端验收得分。

### 创建回执丢失时

运行 `node scripts/run-live-lifecycle-evaluation.mjs --reconcile 原评测UUID`。命令使用原运行的回环入口和幂等编号。Agent 原回执经 `GET /api/v2/agent/requests/{key}` 查询，交付原回执经 `GET /api/v2/agent/tasks/{taskId}/delivery-requests/{key}` 查询。交付读取从请求账本和已存元数据返回，不进入执行器的协调步骤。带幂等编号复用既有交付时，也记录该编号所对应的原交付。

对账成功后在同一检查点保存已确认的任务或交付编号，评测留在暂停状态。缺少记录、身份或来源不符、网络不确定时保留原记录。返回码 0 表示待对账项已找回或没有待对账项，2 表示仍有待确认项，1 表示本次输入或检查点无法处理。回到运维逐例验收读取记录，可打开原任务。后续模型、文件演练或发布按原有授权流程推进。

`--refresh` 不执行后续尚未开始的案例，不创建任务，也不把已过期的付费窗口用于重新推进模型、SQL、演练或发布。它沿用原编号、入口、案例集摘要和案例数，并取得原运行的串行锁；只读 GET 的结果可以原子更新**同一份本机检查点**，因此“只读”指远端业务操作，不是禁止保存本机核验状态。没有待消费案例时只给说明，不改写检查点。网络或证据读取未确认时保留原案例为消费阶段暂停，不自动重试。

恢复时默认取原报告的回环入口和案例数；若另行设置 `V2_LIVE_EVALUATION_ORIGIN` 或 `V2_LIVE_EVALUATION_CASE_LIMIT`，必须与原记录一致。所有入口仍拒绝云 origin、非回环地址、任意路径和符号链接检查点；命令只接受原 UUID，不接受文件路径。

输出包含 core 返回的阶段、统计及 `waitingConsumptionCount`（对应 `awaitingConsumptionCaseCount`），消费阶段暂停另外保留 `pausedCaseCount`。`taskUrl` 指向已存在的原任务。只有 v2/v3 检查点中任务、代码版本/摘要、开发运行、包、演练、发布及两个成功批次与已通过的监控证据一致时，才生成精确本机 `servicesUrl`；v3派生还要核对本轮成功父案例。链接携带 `source_task`、`source_package`、`source_release`、`source_kind=AGENT`、`source_scope=LOCAL_TEST_ONLY`、`source_revision` 和 `source_run`，标记 `navigationOnly:true`、`sourceSelection:EXACT_LOCAL_RELEASE`；`consumptionTarget` 保留原包、发布和成功批次编号。

深链只定位来源，不赋予权限、不自动创建或调用接口。页面必须实际回读原任务、包、发布与成功批次并核对一致后，才能在既有权限内操作；返回代码沿原版本和开发运行恢复。缺失或矛盾来源不生成服务入口，也不退回全项目目录猜选。旧 v1 没有此来源时只提供原任务链接，不能伪造 v2 预选。本机「运维监控 → 新任务端到端验收 · v3」提供同一组检查点的逐例视图。默认读取最新 v3，也可选原编号。固定显示 20 例，标记未执行、未纳入本轮、提交待确认、待审阅、待监控、待消费和记录核验结果。打开「原任务」或「同源接口」继续查看，目标模块重新核对已有证据。原评测入口与当前页面不同的记录会提示切回原入口。

`--report` 的统计只从已记录内容按相应契约核对，不重新核验服务、账单、实际模型或计算真实性。`currentContractTargetMet` 只指当前v3，旧v1/v2按自己的原契约统计，不能表示新覆盖已达标。报告读取不会升级历史证据。恢复默认按文件中的契约选择目录；可用 `V2_LIVE_EVALUATION_CONTRACT` 显式指定完整契约ID，若与原文件不同则拒绝，不迁移。v2新计划可显式选择其ID；不新增v1执行。

普通代码运行由平台在`validation.contractId`记录验证契约；文件演练/发布回执从不可变包读取`source.validationContractId`、源版本/运行/SQL摘要和`fileHashes`。评测分别校验这两种协议，不要求底层Spark原始输出包含平台附加字段；缺少源绑定或文件摘要仍须拒绝。

检查点保存于`.v2-artifacts/live-lifecycle/原评测编号/checkpoint.json`，原始SQL、业务行和模型原始错误不进入报告；元数据库与原文件仍是复核依据。本机文件按受保护目录保存，不提交Git。检查点以临时文件原子替换，同一运行使用排他锁；强制杀进程留下锁时，先核实其中原PID确已结束，再处理该运行的锁，保留检查点，不新建另一个评测编号绕行。

本机接口为 `GET /api/v2/evaluations/live-lifecycle/overview`，可选 `run_id`。读取固定检查点目录，不启动评测或更新检查点。旧版记录按原口径保留，测试记录与证据未确认的案例显示各自状态。已核验数属于原本机运行的已保存证据，自主完成率保持未测。

## 中断、失败与计分

### 来源反例与报告口径（2026-11-10）

运行时、只读消费刷新与已保存报告共用受限的回执元数据检查。检查任务尝试、代码、演练、包来源、审阅、发布批次、监控事件、消费接口版本与调用；明确的`testDouble`／`synthetic`、`TEST_HARNESS`或mock／synthetic等模型标签不能计作真实成功。排队期间出现过替身标记，终态回执不再包含该字段也不能洗去历史；父案例及恢复检查点的标记同样保留。

人工成功引用、辅助续改、修正对照、`manualDeliveryTaskId`／`MANUAL_RUN`、人工归因及仅限服务设计的规划任务，不能因外层写成`AGENT`而进入原生开发成功数。运行链在发现明确非原生来源时停止，消费刷新保留待核并说明证据无效；已保存报告重新核对后不计成功。元数据超过检查上界视为未确认，不能默认通过。

检查不遍历业务行、虚构输入、预期答案、SQL、提示词和文件正文。因此虚构证券数据与必要的工程师审阅本身不会被当作替身执行或人工补救。没有上述负面标记只表示未发现这一类矛盾，不证明模型提供方、外部系统或云端真实性。

报告新增`measurementStatus`：无创建记录为`NOT_RUN`，含替身为`TEST_HARNESS`，其余为`RECORDED_EVIDENCE_ONLY`；`rejectedProvenanceCaseCount`单列非原生／未确认来源。保留各历史契约的固定20例、分母、原`completionRate`及`targetMet`字段语义；加强来源拒绝不补造或迁移历史成功。`autonomousCompletionRate=null`表示该执行器没有测量完整自主率，`fullGoalTargetMet=false`明确本机审阅链不能决定公网总目标达标；不能把零、未测和历史代码阶段成功率混用。

回归用合成回执复现并封堵五类误计：嵌套模型尝试替身、synthetic模型名、人工成功引用、服务规划模式、嵌套消费调用替身。测试还覆盖九阶段来源、临时排队、只读刷新及CLI原文件不改写；全部属于计分器回归，不产生真实模型／Spark验收。入口：`test/v2/live-lifecycle-provenance.test.mjs`。

- 创建响应丢失：按原创建者和原请求编号只读查询；结果未确认则`PAUSED`，不会重发需求。交付响应丢失按同任务/同版本/同运行查找，歧义同样暂停。
- 持久推进仅使用已读版本；写入响应未知后先回读。版本未推进时停止，不重复提交该写入；未知模型结果不自动确认重试。
- 已确认失败保留在原案例，后续可继续其他已授权案例；未知结果、等待审阅、监控或消费会保留恢复点并停止付费执行脚本。恢复不清零次数或新建替代模型任务。错误报告只记录固定错误码与阶段。
- 分母固定20例，17例及以上成功且全部案例形成确定结果，才达到对应契约的85%门槛。v2/v3成功必须含消费证据；v3另核原父案例成功、原谱系及验证族。未执行、待来源、来源失败、待审阅、待监控、待消费、暂停和未知提交分别展示，版本不混算，不能借其他评测运行或重复任务补足成功数。
- `agentIndependentE2E=false`：报告属于真实新任务加工程师审阅的本机链路，不是Agent无人工批准的自主发布，也不是公网完成率。测试替身标记会持久保留；任何混入替身的结果都不计真实成功。
- 检查点及API回执的关联校验不是独立的外部真实性证明；正式验收仍须核对原服务、版本文件、元数据库、运行与监控证据。不能手工补字段把模拟检查点升级为真实运行。

独立消费者另有 V2 文件绑定入口，核对冻结来源、独立预期和确切 API 调用回执，见 [数据服务说明](m3-data-services.md)。其结果只证明报告与平台回执一致，不自动修改本评测检查点、旧成功记录或 `externalSystemVerified`；本机和人工结果继续单独标记。

## 原创建请求恢复接口

`GET /api/v2/agent/requests/:requestId`只读返回原任务。本机查询本机幂等记录；受邀模式只查当前创建者的持久任务命名空间，匿名403、其他创建者或缺失404、跨项目403。读取不创建任务、不启动模型或Spark；元数据库重开后仍按原编号查找。

CLI：`shuduo agent request --request-id 原请求编号`。MCP：`agent_request_lookup`，参数`requestId`，声明为只读工具，复用相同API及身份检查。云端部署、MCP实际注册连接及私有传输适配另行验收。

开发工作台也在首次POST前保留`agent_request`恢复编号。原页重试会先查询，只在当前账号明确返回404且原内容仍在该页时，按同编号提交冻结的原内容。刷新后的页面没有保存需求/SQL副本，只提供查询；找到任务后保留用户当前编辑，不自动继续模型步骤。待确认时不会静默新建第二个编号；可保留恢复链接并另开工作台查看其他任务。错误与部分回执不得清除恢复标记，过期页面/身份的异步结果不得继续发写请求。

工作台本机就绪取决于模型配置与Spark可用，私有云额外要求持久Agent启用；“尚未配置模型”不再误写为“必须云部署”。模型暂不可用时仍能读取历史，执行中断记录不会显示成自动恢复成功。

本机回归入口：`test/v2/live-lifecycle.test.mjs`、`test/v2/live-lifecycle-cli.test.mjs`、`test/v2/agent-request-recovery.test.mjs`。CLI 回归仅使用受保护的合成临时目录和注入式假 transport，覆盖只读刷新、旧报告不迁移、原范围与锁、拒绝 POST 和导航边界，不读取真实运行目录或凭证。其中替身只验证流程与报告一致性，不是新的模型、Spark或完整业务E2E证据。
