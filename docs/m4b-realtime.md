# M4b：实时事件处理、Checkpoint与恢复

日期：2026-09-14。当前使用仓库内虚构证券行情JSONL和`local-event-log-v1`；这是实际逐事件处理，不是Kafka/Flink连接，接口始终返回`kafkaConnected=false`、`flinkConnected=false`、`publicDeployed=false`。

## 实现语义

1. 实时源和事件日志版本保存行数与内容SHA-256；只允许合成目录普通JSONL，拒绝任意路径与符号链接。
2. 行情事件严格校验event_id、sequence、security_code、UTC event_time、正价格和非负成交量，不接受额外字段。
3. 独立状态库保存已处理事件、按证券最新状态和Checkpoint；event_id重复只计重复数，不重复更新。
4. Checkpoint每N个源offset保存事件数、重复数、Watermark、源前缀摘要和状态摘要。
5. 运行后台逐条处理并持续保存offset、延迟和吞吐；启动接口先返回运行号，页面刷新可恢复记录。
6. 故障保留已处理事件和最近Checkpoint，并创建开放告警。恢复日志在Checkpoint之前必须逐字一致，否则拒绝跳过。
7. 合法恢复从`lastOffset+1`继续；成功后告警关联recoveryRunId并解除。
8. 同一幂等键重放原运行；本机预算模式同时只运行一个实时任务。

## 实际本机证据

- 实时源`30a21430-0cdc-48fd-808d-1b38a8de3d64`，V1 `82e0b7e9-c6f0-480e-a5b8-d1439a2832b8`，6行，第三行价格-1.00为受控故障。
- 任务`b2a4de4f-d15c-44cd-9742-686d09bf5047`：目标realtime_quotes，每2个offset做Checkpoint，允许2秒乱序。
- 首次运行`82e2e00d-f808-4fc2-b1b7-d62eba75259a`处理2个事件，在offset2以INVALID_QUOTE_PRICE失败；Checkpoint`cf9dc417-b2de-43ec-bf24-df7209c2c35c`停在offset1，事件数2。
- 告警`d04c5796-8537-4606-97f0-040bc8e226e5`记录失败offset和错误码。
- 修正V2 `38463510-ff54-413a-af91-7a8387f21384`保持Checkpoint前两行一致，将价格修正为10.20。
- 恢复运行`0d66632e-6890-4fee-a8bd-3f05cd209f3d`从offset2开始，处理3个新事件、识别1个重复事件，最终唯一事件5、证券状态3、Checkpoint总数3。
- 最终SEC-DEMO-001=10.20、SEC-DEMO-002=101.80、SEC-DEMO-003=20.00；Watermark=2026-09-14T09:30:02Z，状态摘要`580a91a4…3b99`。
- 失败告警已以恢复运行ID解除；监控为1个CAUGHT_UP任务、1次失败运行、0开放/1已恢复告警。

## 测试与待办

11项实时/Agent针对性测试覆盖事件契约、真实fixture、Checkpoint失败恢复、重复事件、前缀冲突、停止、服务重启中断、路径/符号链接、V2 API公开只读边界、Agent人工应用和模型输入边界；与5项接口回归组合运行16/16。全量`npm run ci`为116/116，源码检查与两个前端构建通过。

## Data Agent与多端证据

- 真实模型方案`51b93236-d1e0-4b2c-a80e-0e434266a65a`使用`qwen3-coder-plus`，508 Token；只接收实时源摘要和固定事件契约，未发送事件行。
- 后端把方案重新绑定源`30a21430-0cdc-48fd-808d-1b38a8de3d64`的V2版本并生成配置摘要`56e5fdf…ca7f`；人工应用为任务`c3d20a2b-c40a-478c-a3ac-e2638a43db5d`时运行数为0。
- GUI显式启动后，运行`d445ee9a-8837-4476-8595-88d8f3ceb991`用265ms消费6行：5个唯一事件、1个重复、3个Checkpoint、3只证券最新状态，Watermark为`2026-09-14T09:30:02Z`。
- `shuzhan` CLI与`shuzhan-mcp`覆盖实时源、版本、任务、启动/停止、恢复、状态、Checkpoint、监控和Agent方案，调用同一`/api/v2/streams`资源；旧V1命令不计入证据。
- 工作台显示事件日志已连接，Kafka/Flink/公网未连接；有效1280与768宽度均无页面级横向溢出，窄屏仍可选择任务和启动。

M4b本机范围已验收。仍未连接Kafka/Flink、外部Schema Registry、真实CDC或生产Checkpoint存储，也没有完成公网身份、隔离执行与多实例恢复；这些不能由本机事件日志证据替代。
