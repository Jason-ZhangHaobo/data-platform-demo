# 新Agent任务：工程师审阅与受治理消费链路评测

此入口从新的证券需求创建真实Agent任务，再由现有工作流生成并演练调度/部署文件。它与[历史模型代码回放](full-lifecycle-evaluation.md)分别计分。本文记录执行器合同；实际案例完成数、人工审批、模型/Spark结果与待办以当前受保护执行记录为准，不能把本文件或源码测试当作公网验收。

默认计划采用 `securities-live-agent-reviewed-lifecycle-v2`，在原开发、调度文件、部署文件、工程师审阅、发布及监控证据之外，新增 `CONSUMPTION`：核对同一原任务、包、发布和成功批次的固定 DAPI 版本组合、XAPI 及已有授权调用证据。范围为 `LOCAL_FRESH_MODEL_ENGINEER_REVIEWED_WITH_CONSUMPTION`；不等于外部系统验收、生产或公网完成。

旧 `securities-live-agent-reviewed-lifecycle-v1` 只覆盖至发布后监控，按原范围保留。其 `SUCCEEDED` 不能算作 v2 的含消费通过；不会因升级程序自动迁移、补字段或重跑旧案例。

## 计划与资源边界

使用项目要求的Node.js 24运行`node scripts/run-live-lifecycle-evaluation.mjs --plan`仅输出计划，不连接服务、不提交任务。默认1例；`V2_LIVE_EVALUATION_CASE_LIMIT`可选择1—20例。完整集合复用已登记的20个证券开发场景，覆盖4类开发意图、5套资产数据；这仍不等于所有经典模块或全部证券业务范围。

每例最坏情况为3次模型调用、3次代码Spark运行、1次文件演练、2次工程师批准后的发布批次，合计最多6个Spark运行；每例模型Token预留上限32000。20例上界为60次模型调用、120个Spark运行、640000 Token。执行前必须核对现有预算、真实授权和服务配置；这里只声明次数/Token边界，不把它换算为未经核验的费用保证。

执行器默认不执行。仅在已取得当前具体授权后设置`V2_LIVE_EVALUATION_AUTHORIZED=LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW`与`V2_LIVE_EVALUATION_AUTHORIZED_CASES`，再运行`node scripts/run-live-lifecycle-evaluation.mjs --execute`。配置标志不是人类授权的替代品，密钥不放在命令参数或报告里。

目标默认`http://127.0.0.1:3100`，可用`V2_LIVE_EVALUATION_ORIGIN`选择其他固定回环端口；拒绝非回环地址。执行前读取状态，要求真实模型、Spark、本机审阅发布可用，SQL最多3次修正、Token上限不超过32000。当前未提供云端执行、真实浏览器或多网络验收，不能用本机执行器冒充这些能力。

## 实际流程

1. 写入原案例、请求摘要和幂等编号后创建Agent任务；直接使用模型产出与独立结果核验，不导入冻结SQL。
2. 同一任务核对代码版本、实际Spark、客户结果和五套断言，再调用现有`prepare-delivery`生成标准八文件并按文件演练；文件摘要、DAG与输入契约由现有校验器复核。
3. 达到`AWAITING_ENGINEER_REVIEW`后停止，输出原任务工作台链接。工程师在现有工作台审阅精确代码、核验、包与演练，按原权限确认发布；执行器不会创建审阅、审批或发布记录。
4. 工程师操作后，用同一入口和原案例范围 `--resume 原评测编号` 恢复。沿原任务/交付/发布读取或推进，不创建替代任务；未开始的后续案例仍属于付费执行范围，所以此模式继续要求当前模型/计算授权及就绪检查。发布仍在运行则返回 `AWAITING_MONITORING`。
5. 同一包、同一代码版本、独立审阅及审批、两个真实Spark批次和同版监控齐全后，进入 `AWAITING_CONSUMPTION`，不能提前标记完整成功。前序检查包含激活/计划/开始/完成时间顺序、监控观察时间与批次对应关系。仅有 PASSED 或 HEALTHY 标签不够。
6. 工程师在已有数据服务工作台按原来源开发、测试、发布并完成授权调用后，用 `--refresh 原评测编号` 只读核对消费证据。只有 core 的同源与时序检查通过，原案例才进入 v2 `SUCCEEDED`；执行器不自动建 DAPI/XAPI、发行应用凭证、调用接口或代为审批。

## 命令与恢复边界

| 命令 | 作用 | 授权与写入边界 |
|---|---|---|
| `--plan` | 默认输出 v2 计划、选定案例与资源上界 | 无服务请求、无评测文件写入，不代表已获费用授权 |
| `--execute` | 开始一份新的 v2 评测 | 保留原模型/计算授权、案例数与本机就绪门；默认不执行 |
| `--resume <原编号>` | 继续原 v2 执行范围 | 仍检查当前授权及模型/Spark就绪；旧 v1 仅返回历史范围说明，不迁移、不重跑 |
| `--refresh <原编号>` | 只核对已处于 `AWAITING_CONSUMPTION` 或 `PAUSED + phase=CONSUMPTION` 的原案例 | 不要求付费 `AUTHORIZED` 标志或模型/Spark仍可用；adapter 拒绝任何 POST，只允许已保存同源 `GET /data-services/task-evidence?agent_task_id=…&package_digest=…&release_id=…` |
| `--report <原编号>` | 只读取新/旧原检查点，按对应契约整理已有阶段和统计 | 不访问服务，不创建锁，不修改原文件；标记 `recorded:true`、`RECORDED_CHECKPOINT_ONLY` 和 `externalTruthReverified:false` |

`--refresh` 不执行后续尚未开始的案例，不创建任务，也不把已过期的付费窗口用于重新推进模型、SQL、演练或发布。它沿用原编号、入口、案例集摘要和案例数，并取得原运行的串行锁；只读 GET 的结果可以原子更新**同一份本机检查点**，因此“只读”指远端业务操作，不是禁止保存本机核验状态。没有待消费案例时只给说明，不改写检查点。网络或证据读取未确认时保留原案例为消费阶段暂停，不自动重试。

恢复时默认取原报告的回环入口和案例数；若另行设置 `V2_LIVE_EVALUATION_ORIGIN` 或 `V2_LIVE_EVALUATION_CASE_LIMIT`，必须与原记录一致。所有入口仍拒绝云 origin、非回环地址、任意路径和符号链接检查点；命令只接受原 UUID，不接受文件路径。

输出包含 core 返回的阶段、统计及 `waitingConsumptionCount`（对应 `awaitingConsumptionCaseCount`），消费阶段暂停另外保留 `pausedCaseCount`。`taskUrl` 指向已存在的原任务。只有 v2 检查点中任务、代码版本/摘要、开发运行、包、演练、发布及两个成功批次与已通过的监控证据一致时，才生成精确本机 `servicesUrl`：携带 `source_task`、`source_package`、`source_release`、`source_kind=AGENT`、`source_scope=LOCAL_TEST_ONLY`、`source_revision` 和 `source_run`。输出标记 `navigationOnly:true`、`sourceSelection:EXACT_LOCAL_RELEASE`；`consumptionTarget` 保留原包、发布和成功批次编号。

深链只定位来源，不赋予权限、不自动创建或调用接口。页面必须实际回读原任务、包、发布与成功批次并核对一致后，才能在既有权限内操作；返回代码沿原版本和开发运行恢复。缺失或矛盾来源不生成服务入口，也不退回全项目目录猜选。旧 v1 没有此来源时只提供原任务链接，不能伪造 v2 预选。当前不新增 GUI 评测页面；原任务已有的消费证据区用于查看同源记录。

`--report` 的统计只从已记录内容按相应契约核对，不重新核验服务、账单、实际模型或计算真实性。旧 v1 输出明确不含消费，`currentContractTargetMet` 不会因旧 v1 达标而变为 true。报告读取不会把历史记录升级为新证据。

普通代码运行由平台在`validation.contractId`记录验证契约；文件演练/发布回执从不可变包读取`source.validationContractId`、源版本/运行/SQL摘要和`fileHashes`。评测分别校验这两种协议，不要求底层Spark原始输出包含平台附加字段；缺少源绑定或文件摘要仍须拒绝。

检查点保存于`.v2-artifacts/live-lifecycle/原评测编号/checkpoint.json`，原始SQL、业务行和模型原始错误不进入报告；元数据库与原文件仍是复核依据。本机文件按受保护目录保存，不提交Git。检查点以临时文件原子替换，同一运行使用排他锁；强制杀进程留下锁时，先核实其中原PID确已结束，再处理该运行的锁，保留检查点，不新建另一个评测编号绕行。

## 中断、失败与计分

- 创建响应丢失：按原创建者和原请求编号只读查询；结果未确认则`PAUSED`，不会重发需求。交付响应丢失按同任务/同版本/同运行查找，歧义同样暂停。
- 持久推进仅使用已读版本；写入响应未知后先回读。版本未推进时停止，不重复提交该写入；未知模型结果不自动确认重试。
- 已确认失败保留在原案例，后续可继续其他已授权案例；未知结果、等待审阅、监控或消费会保留恢复点并停止付费执行脚本。恢复不清零次数或新建替代模型任务。错误报告只记录固定错误码与阶段。
- 分母固定20例，17例及以上成功且全部案例形成确定结果，才达到对应契约的85%门槛。v2 成功必须含消费证据；未执行、待审阅、待监控、待消费、暂停和未知提交分别展示，v1/v2 不混算。
- `agentIndependentE2E=false`：报告属于真实新任务加工程师审阅的本机链路，不是Agent无人工批准的自主发布，也不是公网完成率。测试替身标记会持久保留；任何混入替身的结果都不计真实成功。
- 检查点及API回执的关联校验不是独立的外部真实性证明；正式验收仍须核对原服务、版本文件、元数据库、运行与监控证据。不能手工补字段把模拟检查点升级为真实运行。

## 原创建请求恢复接口

`GET /api/v2/agent/requests/:requestId`只读返回原任务。本机查询本机幂等记录；受邀模式只查当前创建者的持久任务命名空间，匿名403、其他创建者或缺失404、跨项目403。读取不创建任务、不启动模型或Spark；元数据库重开后仍按原编号查找。

CLI：`shuduo agent request --request-id 原请求编号`。MCP：`agent_request_lookup`，参数`requestId`，声明为只读工具，复用相同API及身份检查。云端部署、MCP实际注册连接及私有传输适配另行验收。

开发工作台也在首次POST前保留`agent_request`恢复编号。原页重试会先查询，只在当前账号明确返回404且原内容仍在该页时，按同编号提交冻结的原内容。刷新后的页面没有保存需求/SQL副本，只提供查询；找到任务后保留用户当前编辑，不自动继续模型步骤。待确认时不会静默新建第二个编号；可保留恢复链接并另开工作台查看其他任务。错误与部分回执不得清除恢复标记，过期页面/身份的异步结果不得继续发写请求。

工作台本机就绪取决于模型配置与Spark可用，私有云额外要求持久Agent启用；“尚未配置模型”不再误写为“必须云部署”。模型暂不可用时仍能读取历史，执行中断记录不会显示成自动恢复成功。

本机回归入口：`test/v2/live-lifecycle.test.mjs`、`test/v2/live-lifecycle-cli.test.mjs`、`test/v2/agent-request-recovery.test.mjs`。CLI 回归仅使用受保护的合成临时目录和注入式假 transport，覆盖只读刷新、旧报告不迁移、原范围与锁、拒绝 POST 和导航边界，不读取真实运行目录或凭证。其中替身只验证流程与报告一致性，不是新的模型、Spark或完整业务E2E证据。
