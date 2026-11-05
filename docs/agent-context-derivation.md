# 基于成功版本变更已登记业务口径

工程师已经完成客户资产加工，希望沿用代码改成“股票持仓＋可用现金”。工作台允许从本人已成功且通过独立核验的原生 SQL Agent 版本准备新任务；原任务、代码、运行、交付包及发布批准保持原样。股票＋现金结果不等于客户全资产。

## 用户流程与范围

1. 在原成功任务选择“基于此版本变更口径”，读取确切任务、代码版本、运行和核验结果。
2. 选择另一种已登记口径并描述修改需求，原 SQL 作为冻结起点。草稿本身不运行计算；刷新从原版本重新读取，链接只保存来源编号、摘要与目标口径，不保存 SQL、需求或凭证。
3. 确认后提交独立新任务，模型按目标口径编写代码，沿用目标口径的五场景独立断言及调试机制。新任务重新计费与校验，不继承旧结果或批准。
4. 从新任务准备调度与部署文件；只有新包完成演练和独立审阅后，才能按既有权限发布。旧包的批准不能代替新包审阅。

目前支持已登记的客户全品类持仓＋现金、股票持仓＋现金两组口径及各组测试数据。相同口径、未知指标、Python、人工接管、失败或未完成核验来源不使用此入口。指定单任务续接、发布专用或只读窗口仍保留原限制。

## API、CLI 与 MCP

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

## 验收边界

必须验证准确目标与原 SQL、刷新后的来源恢复、提交前无计算、未知响应找回、重复提交不重复任务、来源和权限反例、原历史不变及新交付包重新绑定。合成模型/Spark与本机 HTTP/SQLite 可证明接口和流程，不证明真实模型改写正确率、云端部署或整体 85% 完成率。固定历史评测集与分母不因增加此入口而自动改变。
