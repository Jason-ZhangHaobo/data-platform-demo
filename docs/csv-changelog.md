# 本机CSV显式变更：删除、序号与恢复

## 范围

新增独立模式`INCREMENTAL_CHANGELOG`，在本机SQLite中实际处理CSV UPSERT／DELETE。原FULL和INCREMENTAL_UPSERT保持原语义，旧水位仍只记录输入最大值；新模式使用独立的每键精确序号。它不是数据库CDC、Kafka／Flink接入，也不代表云端分布式变更流验收。

目标是处理虚构证券持仓清仓：种子批有两条仓位，DELETE关闭其中一条，后续旧UPSERT不能把它重新写回。模式仅在本机回环、LOCAL_CSV上开放，MySQL和云端入口拒绝。当前内部同步助手仍按既有范围生成草稿；GUI／API／CLI／MCP提供明确的新模式接口，不宣称真实模型已完成自动规划。

## 使用

1. 在“数据源”登记并采集`positions_change_seed.csv`，在“数据同步”选择“CSV显式变更”。使用**空且没有既有任务历史的新目标名**；首次自动生成变更代号。种子批只能UPSERT，创建草稿登记目标契约但不写业务行。
2. 选择`op`和`seq`作为操作／序号字段。它们不映射到业务目标，主键来自其他业务字段，目标字段类型基线取首个成功种子批。
3. 创建并明确实际执行。源版本、元数据、配置、变更代号和目标控制状态共同校验，结果保存原批次快照（受原留存限制）。
4. 登记`positions_change_close.csv`，在原任务点“复用此配置创建下一批”，沿用目标、变更代号、映射及主键；明确选择新CSV并创建新版本。执行后实际删除POS-002，原两行快照仍可查看。
5. `positions_change_replay.csv`包含旧UPSERT和重复DELETE，执行后分别计入旧事件跳过／重复跳过，POS-002保持关闭。

固定代号对应同一目标和映射／主键／操作及序号字段契约。更改代号或契约需使用新目标并重新种子，不能清空旧墓碑重启。新模式不会用旧FULL／UPSERT任务覆盖受控目标；旧记录无法假装已完成新模式初始化。

## 事件规则

- CSV需有原映射字段表头；DELETE只使用业务主键，其他业务值可空。
- 操作严格为`UPSERT`或`DELETE`，序号为最多40位规范非负整数文本，使用BigInt比较，避免Number精度丢失。每个主键独立排序；文件可含同键多次事件。
- 更大序号应用；更小序号跳过；相同序号且同内容幂等跳过，相同序号不同内容整批拒绝。
- 删除保留每键墓碑。即便目标中原本不存在该键，删除事件仍可登记墓碑，较老写入不能复活。
- 行变更、墓碑、提交回执、当前提交指针与留存快照在同一SQLite事务内完成，冲突／无效输入回滚整批。
- `deleted`是实际删除行数；`changeState.deleteEvents`是接受的删除事件数，可能不同。接受、重复、旧事件计数共同核对输入行数；回执与实际行及控制状态由摘要绑定。

## 请求与中断恢复

执行请求使用稳定的`Idempotency-Key`。响应未知时先GET原任务按requestKey查原运行；已完成则回读。原运行未确认时，原请求POST只核对已提交回执，或在能证明原目标未提交变化时恢复**同一运行编号**，不创建新批次。

提交后丢回执会显示UNCONFIRMED并阻止后续新请求；只有匹配原任务、配置、源摘要及原运行的提交证据才能结算。原源文件在未提交前变化则失败，不换用新文件，释放的仅是已证实未变动的原预留。界面保留原请求UUID，刷新后“核对原执行”不会盲目再次落地。

平台元数据保存目标登记和字段基线；业务状态保存变更目标、每键序号／墓碑及回执，必须一致备份恢复。数据状态新增可选`landingChangeTargets`／`landingChangeKeys`，旧v1 payload的原始形状及已支持OSS初始版本链保持兼容。有效新状态冷恢复后旧事件仍跳过；缺表、缺登记、摘要／墓碑不符时拒绝继续，不能把旧空状态当作新模式已就绪。

旧格式可继续服务旧模式；已有受控目标不能用缺少其代号／墓碑的快照覆盖。超出状态留存上限时拒绝新写，不清墓碑以腾空间。本项是小数据单工作空间验证，生产CDC、并发控制面及规模需独立适配与实测。

## API／CLI／MCP

既有POST `/api/v2/sync/tasks`可使用新模式及：

```json
{"changeConfig":{"epochId":"STREAM_UUID","operationField":"op","sequenceField":"seq"}}
```

保留原name、sourceId、targetTable、mapping、keyFields及可选成对源版本／元数据版本。删除控项须位于完整changeConfig；顶层operationField等不再被静默忽略。变更创建请求按规范化对象摘要幂等，跨工具字段顺序变化仍回读原任务。执行只接受原任务配置，运行体不得覆盖或重置控制。

```sh
shuduo sync create --name '虚构持仓变更' --source-id SOURCE_ID --target-table positions_changes --mode changelog --mapping position_id:position_id,client_id:client_id,security_code:security_code,asset_class:asset_class,industry:industry,market_value:market_value,trade_date:trade_date --keys position_id --change-epoch STREAM_UUID --operation-field op --sequence-field seq --request-id CREATE_UUID
shuduo sync run --id TASK_ID --request-id RUN_UUID
```

MCP继续使用`sync_task_create`（mode、changeConfig、可选requestId）与`sync_task_run`（taskId、可选requestId）。新控制值完整校验，所有权和项目权限仍由后端判定；变更代号是流标识，不是访问密钥。

## 验收

`test/v2/csv-changelog.test.mjs`覆盖真实CSV、删除、精确大序号、同键多事件、未知操作、事务回滚、初始化与受控目标、原请求恢复、提交前源变化、冷恢复／旧状态拒绝、缺登记、跨CLI／MCP和共享资产／质量待检测联动。旧同步、状态副本及OSS版本链继续回归。

实际浏览器完成种子→清仓→安全重放，原快照两行可回看；故意损坏一次执行响应后仅GET回读，刷新无新落地。最终界面只读复验不执行数据写。全部样例虚构，本轮模型、Spark及云操作为零，正式20例不由这些结果替代。
