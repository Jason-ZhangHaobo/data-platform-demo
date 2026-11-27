# 基于成功版本变更已登记业务口径

工程师已经完成客户资产加工，希望沿用代码改成“股票持仓＋可用现金”。工作台允许从本人已成功且通过独立核验的原生 SQL Agent 版本准备新任务；原任务、代码、运行、交付包及发布批准保持原样。股票＋现金结果不等于客户全资产。

## 用户流程与范围

1. 在原成功任务选择“基于此版本变更口径”，读取确切任务、代码版本、运行和核验结果。
2. 选择另一种已登记口径并描述修改需求，原 SQL 作为冻结起点。草稿本身不运行计算；刷新从原版本重新读取，链接只保存来源编号、摘要与目标口径，不保存 SQL、需求或凭证。
3. 确认后提交独立新任务，模型按目标口径编写代码，沿用目标口径的五场景独立断言及调试机制。新任务重新计费与校验，不继承旧结果或批准。
4. 从新任务准备调度与部署文件；只有新包完成演练和独立审阅后，才能按既有权限发布。旧包的批准不能代替新包审阅。

目前支持已登记的客户全品类持仓＋现金、股票持仓＋现金两组口径及各组测试数据。相同口径、未知指标、Python、人工接管、失败或未完成核验来源不使用此入口。指定单任务续接、发布专用或只读窗口仍保留原限制。

## API、CLI 与 MCP

### 在原开发对话中提出修改

1. 在成功的原生 SQL 开发步骤打开「修改业务口径」，输入修改需求，核对目标口径。同一套测试数据有对应口径时，页面优先展示这项选择。例如「只统计股票持仓和现金，保留只有现金的客户」可以沿用原持仓和业务日期。
2. 点击「审阅口径变更」，查看原 SQL 版本、原批次和目标定义。点击「确认修改并运行」后，Agent 从这份 SQL 创建独立任务并校验新结果。
3. 在原对话查看各客户的前后金额、持仓、现金和证券数。展开「查看两版SQL（只读）」可核对实际保存的代码差异。可以继续打开派生任务查看运行详情。新任务有独立版本和运行批次，后续发布须审阅新交付包。

在全品类持仓切换为股票持仓的虚构测试中，客户 001 的持仓市值从 1,500 元降至 1,000 元，现金保持 300 元，证券数从 2 只变为 1 只。口径内资产从 1,800 元变为 1,300 元。客户 002 的口径内资产保持 950 元。隔离验证中，意图路由由测试提供方返回，两次 SQL 均由 Codex 会话根据实际模型请求现场生成，经本机 Spark 3.5.9 各自通过五项断言。正式环境的模型接入和自主完成率按独立评测统计。

CLI 可以先读取已保存的变更与目标选项，再提交已审阅的请求。

```sh
shuduo agent chat-changes --id INTENT_ID
shuduo agent change-chat-scope --id INTENT_ID --source-run-id ORIGINAL_RUN_ID \
  --context stock-cash-t1 --message "只统计股票持仓和现金，保留仅有现金的客户" \
  --request-id NEXT_REQUEST_ID --confirm
```

`ORIGINAL_RUN_ID` 和 `NEXT_REQUEST_ID` 分别取自首次读取的 `binding.runId` 与 `nextRequestId`。两者共同约束本次修改。对应的 MCP 工具为 `agent_chat_scope_changes` 和 `agent_change_chat_scope`。GET `/agent/intents/:id/development/changes` 从原会话找回已受理请求。查阅记录和金额只使用已保存结果。请求的收费结果未知时需先对账原编号，旧编号只对应原需求和口径。

### 在原对话准备派生版本的交付文件

在本机开发会话中选定已完成的口径变更，确认新 SQL 版本与开发批次，点击「生成交付文件并演练」。这一步复用新版本的开发结果，实际运行包内的 `main.sql` 和 `tests.sql`。原任务的交付与派生版本的交付各有独立来源。

可预览的八个文件包括加工 SQL、测试 SQL、调度文件、部署文件、交易日历、虚构输入与回归数据、源运行核验报告和使用说明。可逐个查看、下载，也可下载整个版本化交付包。演练成功后能看到实际使用的引擎、调度时刻、业务日期、节点顺序及断言结果。

股票持仓示例的调度时刻为北京时间 2026 年 9 月 11 日 09:00，冻结业务日为前一个交易日 9 月 10 日。Spark 3.5.9 按文件先执行加工，再执行断言，最后记录结果。客户 001 的口径内资产为 1,300 元，客户 002 为 950 元，五组回归全部通过。这是一次本机文件演练，工程师仍需审阅该版交付包后才能进入发布流程。

CLI 使用原对话编号和所选变更的 `changeRequestId` 读取交付状态。准备前请核对回执的 `source.runId` 和 `requestId`。

```sh
shuduo agent chat-delivery --id INTENT_ID --change-request-id CHANGE_ID
shuduo agent prepare-chat-delivery --id INTENT_ID --change-request-id CHANGE_ID \
  --source-run-id CHILD_RUN_ID --request-id PREPARATION_UUID --confirm
```

MCP 对应 `agent_chat_change_delivery` 和 `agent_prepare_chat_change_delivery`。提交应答丢失后按原对话和变更编号读取，保留同一份包和演练记录。离线检查可用已核对的 `packageDigest` 和浏览器下载的 JSON。

```sh
node bin/shuduo-package.mjs unpack shuduo-delivery-package.json --output selected-delivery --digest PACKAGE_DIGEST
node bin/shuduo-package.mjs plan selected-delivery --digest PACKAGE_DIGEST --scheduled-for 2026-09-11T09:00:00+08:00
```

### 审阅派生版本并查看两批测试

文件演练通过后，在同一变更的发布区打开版本审阅。核对所选子任务的代码版本、开发批次、包摘要、文件演练和业务日期，分别确认代码、独立断言、调度部署文件和本机测试范围。四项默认留空。明确提交后，平台在一次事务中记录审阅、批准、发布及两条计划批次。重复提交只查回原发布。

测试使用同一冻结业务日的虚构持仓结果。默认本机调度器在发布后 5 秒触发第一批，在其计划触发时间的 30 秒后触发第二批。界面分别显示计划和实际时间。浏览器可以关闭，本机调度服务需要保持运行。重新打开时，可按原包和运行编号查看每批的测试 SQL、断言、行数、资产合计、完成事件和开放告警。只有两次实际执行及相应监控证据都通过时，界面才显示“两批运行与监控已核验”。

CLI 先读取原会话的发布预检，保存到文件供工程师审阅。

```sh
shuduo agent chat-publication --id INTENT_ID --change-request-id CHANGE_ID > reviewed-publication.json
```

工程师核对文件并同意其中的测试范围后，可以提交该预检。CLI 会再次核对服务端的原版本与审阅摘要。提交应答丢失时，读取同一原请求可找回两批，刷新不会重发批准。

```sh
shuduo agent publish-chat-change --review-file reviewed-publication.json \
  --attest-code --attest-assertions --attest-delivery-files --attest-local-scope --confirm
```

MCP 对应 `agent_chat_change_publication` 和 `agent_publish_chat_change`。本机验收由虚构工程师在隔离浏览器明确勾选并提交一次，关闭浏览器后两批分别执行真实 Spark 3.5.9，各有两行、合计 2,250 元及五项通过的断言。此结果属于本机测试发布，公网业务验收单独记录。

### 从同一发布的两批结果查询客户资产

在隔离本机验收中，每批的持仓 DAPI 返回客户、持仓市值及证券数，现金 DAPI 返回现金与口径内资产，组合 XAPI 固定这两个 DAPI 的版本。通过两套独立的短期调用应用，用回环 HTTP 分页核对两批已发布的结果。每个应用仅获持仓 DAPI 和本批组合 XAPI 的服务授权，能通过组合接口取回现金，直接请求未授权的现金 DAPI 则得到 403。

服务端为两个应用各设置 300 秒有效期。每批实际发出 15 个请求，覆盖金额、两页数据、无效参数、缺少或无效凭证、授权、限流和撤销后拒绝。六个接口版本均在调用记录中按批次核对。两个应用均已撤销，活动应用数为零。此用例证明测试期间实际调用的版本和结果，未验证普通应用在服务换版后的版本授权行为。

### 从已知开发版本创建派生任务

沿用 `POST /api/v2/agent/tasks`，新增可选来源对象：

```json
{
  "derivation": {
    "kind": "REGISTERED_CONTEXT_CHANGE",
    "taskId": "原任务 UUID",
    "revisionId": "原代码 UUID",
    "runId": "原运行 UUID",
    "revisionHash": "原代码 SHA-256"
  },
  "contextId": "stock-cash-t1",
  "language": "SPARK_SQL",
  "sql": "原版本的完整 SQL",
  "message": "改为股票持仓加可用现金，保留仅有现金客户"
}
```

示例 UUID/摘要为说明文字，实际调用必须使用真实版本编号。`derivation` 只接受这五个字段，与失败修正 `sourceRunId`／`sourceError` 互斥。后端从当前项目与用户重新核对原任务、版本、运行、SQL 摘要、实际执行和五场景断言；不能由客户端指定执行者、成功状态、预算或批准。

新任务的 `derivedFrom` 保留上述五字段以及原 `contextId`、`validationContractId`，仅表示谱系；顶层 `contextId` 和验证契约属于新目标。幂等摘要包含来源和目标，同编号换来源会冲突。持久任务在首次调用模型前再次核对来源。

CLI 用原版本回读 SQL，不需要把代码放进命令参数：

```sh
shuduo agent derive --task-id TASK_ID --revision-id REVISION_ID \
  --run-id RUN_ID --revision-hash SHA256 --context stock-cash-t1 \
  --message "改为股票持仓加可用现金" --request-id UUID --confirm
```

MCP 工具 `agent_context_derive` 接收 `derivation`、`contextId`、`message`、`requestId`、`confirm:true`。CLI/MCP 都只读原代码后提交一次相同 API，不自动推进持久任务、审批或发布；本机新任务的既有执行器可能立即开始模型与Spark，所以这不是只读操作。结果未知时先用 `shuduo agent request --request-id UUID` 或 `agent_request_lookup` 找回原任务，不换编号重提。

## 查看派生前后的金额

在派生任务中选择 **查看金额对照**。先看合计，再按客户核对口径内资产、持仓市值、可用现金和证券数量。展开「查看运行来源」可找到两次保存的运行编号。

| 虚构客户 | 原可用现金 | 新可用现金 | 原口径内资产 | 新口径内资产 | 资产差额 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CLIENT-001 | 300.00 | 800.00 | 1,800.00 | 2,300.00 | +500.00 |
| CLIENT-002 | 200.00 | 200.00 | 950.00 | 950.00 | 0.00 |
| 合计 | 500.00 | 1,000.00 | 2,750.00 | 3,250.00 | +500.00 |

金额单位为元。示例中可用现金贡献了全部资产差额。两侧数值来自保存的结果行，变化的业务原因需结合源数据另行确认。证券数量合计按各客户统计数求和，同一证券在两位客户的持仓中可各计一次。

| 入口 | 使用方式 |
| --- | --- |
| HTTP | `GET /api/v2/agent/tasks/{派生任务编号}/derivation-comparison` |
| CLI | `shuduo agent compare-derived --id DERIVED_TASK_ID` |
| MCP | `agent_derived_result_comparison`，参数为 `{"taskId":"派生任务 UUID"}` |

三个入口都从派生任务登记的来源查回本人、当前项目下的原任务。返回金额前，两侧分别核对代码摘要、原运行、独立断言，以及同一交易日期、顾问范围和客户集合。已核验返回 `MATCHED`；派生任务运行中可返回 `PENDING`；缺少原运行、客户范围变更或无法确认来源时返回 `UNAVAILABLE` 及原因。后两种状态均应清除上次显示的金额。读取对照只使用已保存的结果。

本机真实 Spark 的复核命令如下，开发模型使用本机合成实现。

```sh
SHUDUO_TEST_LOCAL_SPARK_DERIVED_AMOUNTS=true node --test \
  --test-name-pattern='owner reads exact cash-change amounts' test/v2/public-development-journey.test.mjs
```

## 验收边界

必须验证准确目标与原 SQL、刷新后的来源恢复、提交前无计算、未知响应找回、重复提交不重复任务、来源和权限反例、原历史不变及新交付包重新绑定。合成模型/Spark与本机 HTTP/SQLite 可证明接口和流程，不证明真实模型改写正确率、云端部署或整体 85% 完成率。固定历史评测集与分母不因增加此入口而自动改变。
