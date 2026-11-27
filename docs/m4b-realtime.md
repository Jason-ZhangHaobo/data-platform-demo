# M4b：实时事件处理、Checkpoint与恢复

实时同步支持仓库内虚构行情的 JSONL 逐事件处理，以及可选的本机 Kafka / Flink 保存点验收。两种作业共用实时任务与监控接口。

## 本机真实 Kafka 与 Flink 保存点

独立验收程序使用 Java 17、Kafka 4.1.2、Flink 1.20.5 和 Kafka SQL Connector 3.4.0。在回环启动一台临时 Kafka Broker 和嵌入式 Flink 集群，使用仓库的虚构行情。Flink SQL 以事件编号去重，过滤非正价格，按每只证券最高序号更新行情。输出按证券代码写入 Kafka，开启事务写入，验收客户端按 `read_committed` 读取。[Flink Kafka 事务输出](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/table/upsert-kafka/#consistency-guarantees) · [Kafka 快速开始](https://kafka.apache.org/41/getting-started/quickstart/)

在第 4 条输入落地后停止原作业并保存状态。在 Kafka 追加一条已处理事件、一条低序号行情、一条负价格行情和两条相同的新行情。用原保存点启动另一份作业。Broker 确认输入偏移连续，共 9 条。输出保留原 4 条已提交更新且只追加 1 条。独立程序按源事件复算三条最新行情，逐字段核对。该过程有真实保存点、两个不同的 Flink 作业编号及事务消费证据。[Flink 保存点](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/savepoints/)

在仓库根目录用以下命令复跑。指定已有 Java 17 和 Maven 3.9，默认在所选运行目录缓存 Maven 依赖，可通过 `MAVEN_BIN` 指定 Maven 路径。脚本为本次运行创建独立目录，退出后可查看 `run/evidence.json`、`engine.log`、Broker 日志和原保存点。

```sh
mkdir -p -m 700 .runtime/realtime-lab
JAVA_HOME=/absolute/path/to/jdk17 bash scripts/realtime-lab/run.sh .runtime/realtime-lab
```

## 在数舵实时任务中启动引擎验收

先完成一次上述脚本以准备 Maven 依赖，然后在常用本机 V2 启动命令前设置 `V2_LOCAL_KAFKA_FLINK_ENABLED=true`、`JAVA_HOME` 和 `SHUDUO_REALTIME_MAVEN_REPO`。后两项使用绝对路径，Maven 缓存默认为前一步运行目录中的 `maven-repo`。可用 `MAVEN_BIN` 指定 Maven 3.9。任务由本机控制面离线调用 Maven，所需依赖从已准备的缓存读取。

打开「数据同步 → 实时同步」，选择「证券行情 · Kafka / Flink」，点击「启动本机验收」。返回运行编号后可关闭页面。同一详情读回 Kafka 实际输入条数、事务输出条数、两个 Flink 作业及各自保存点摘要、最终行情和运行记录。当前运行失败时保留上次已核验结果。相同幂等编号只返回原运行。CLI 和 MCP 复用已有实时任务启动、状态与保存点工具。[接口约定](v2-api.md)

该任务使用本机隔离的 Kafka 与 Flink 和受控虚构输入。可用时监控返回 `kafkaFlinkLocalReady`，表示可以发起本机验收。每次运行拥有独立引擎进程和保存点。持续运行、生产连接和公网权限另行验收。

### 从进程异常退出前的检查点恢复

在本机工作台加设 `V2_LOCAL_KAFKA_FLINK_CHECKPOINT_CRASH=true`，再选择「启动异常恢复验收」。也可给复跑脚本追加 `--checkpoint-crash`。两种入口都使用同一受控虚构输入。

验收进程以 Flink REST 的 `COMPLETED` 状态核对原作业的周期检查点，保存编号及元数据摘要。Kafka 确认接收偏移 4 后，验收程序只终止本次启动的 Flink 子进程。确认退出码 137、原检查点摘要和原事务输出后，保持同一 Broker，从原检查点启动另一个 Flink 作业。恢复统计须给出相同编号和路径，之后只允许追加一次有效更新。[Flink 检查点](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/checkpoints/) · [Flink REST](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/rest_api/#jobs-jobid-checkpoints)

此处按原作业的完成记录确认检查点类型。Flink 的 `NO_CLAIM` 恢复会把外部状态按类保存点属性载入，原路径、编号及元数据摘要可用来比对读回的确切状态。[Flink 1.20.5 恢复实现](https://github.com/apache/flink/blob/release-1.20.5/flink-runtime/src/main/java/org/apache/flink/runtime/checkpoint/CheckpointCoordinator.java#L1749) · [状态属性](https://github.com/apache/flink/blob/release-1.20.5/flink-runtime/src/main/java/org/apache/flink/runtime/checkpoint/CheckpointProperties.java#L286)

详情、CLI 和 MCP 显示原检查点及恢复后保存点。任务详情的 `engineEvidence.checkpointRecovery` 保存原编号、实际恢复编号、退出码、退出前 Kafka 偏移和已提交条数。从异常模式重放旧保存点模式的启动请求时，服务返回幂等冲突。该方案针对本机故障验收，实际集群的自动重启和高可用仍需核验。

### 双分区 Watermark 与事件时间窗口

本机工作台设置 `V2_LOCAL_KAFKA_FLINK_WINDOW_CRASH=true` 后选择「启动双分区验收」。复跑脚本对应参数为 `--window-crash`。此模式使用两个实际 Kafka 分区，以 UTC 事件时间聚合十秒窗口，每个分区的 Watermark 取观测到的最大事件时间减两秒。按证券输出窗口事件数和成交量。输出主题启用 Kafka 事务，验收以 `read_committed` 读取。[跨分区 Watermark](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/table/kafka/#source-per-partition-watermarks) · [Flink SQL 滚动窗口](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/sql/queries/window-tvf/#tumble)

分区 0 先推进，分区 1 含乱序事件。Kafka 已确认两边各读取两条，输出仍为零。慢分区推进后，第一个窗口产生两条证券结果，其中包含先到八秒、后到四秒的乱序输入。随后从实际周期检查点恢复新 Flink 作业，将失败前 Kafka 已接收的分区 0 偏移 2 纳入第二个窗口。第三个窗口提交后，再核对已关闭窗口及 Kafka 输出前缀，确认迟到行情未改写结果。最终两分区共 11 条输入，输出 6 条，涉及 3 个窗口、2 只证券。

任务详情与 `shuduo streams jobs` 的 `engineEvidence.windowRows` 返回窗口结果。MCP 可使用 `stream_job_list` 读同一回执。此处仍为本机单 Broker，生产多实例、分区变化及持续运行另行验收。

### 三 Broker 的 Kafka Leader 切换

本机工作台设置 `V2_LOCAL_KAFKA_FLINK_BROKER_CRASH=true` 后选择「启动副本切换验收」。复跑脚本对应参数为 `--broker-crash`。在同一台机器的回环网络启动三个隔离 Broker，输入与输出主题配置三个副本，最低同步副本数为两个，禁用非同步副本当选。输入使用 `acks=all`。[Kafka 副本与写入确认](https://kafka.apache.org/41/configuration/topic-configs/#min.insync.replicas)

两分区窗口共用上面的事件时间口径。核对切换前的两条已提交窗口结果后，发送分区 0 的偏移 2。收到 Kafka 确认后只终止本次验收启动的当前 Leader。Kafka Admin 必须从原主题读到新 Leader 和两个存活同步副本。同一个 Flink 作业继续处理，验收重读原输出前缀并对照后续四条结果。退出前的最后一笔已确认输入计入第二个窗口，最终六条结果分别通过独立断言。

任务详情返回 `engineEvidence.brokerFailover`，包含切换前后 Leader、同步副本数、退出码以及切换前最后一个已确认偏移。保存点仍来自同一个 Flink 作业。验收只覆盖同一主机上的单 Broker 故障，跨主机高可用与两个以上 Broker 同时故障另行验收。

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
- `shuduo` CLI与`shuduo-mcp`覆盖实时源、版本、任务、启动/停止、恢复、状态、Checkpoint、监控和Agent方案，调用同一`/api/v2/streams`资源；旧V1命令不计入证据。
- 工作台显示事件日志已连接，Kafka/Flink/公网未连接；有效1280与768宽度均无页面级横向溢出，窄屏仍可选择任务和启动。

以上 JSONL 记录属于 M4b 本机首版。生产 Kafka / Flink、外部 Schema Registry、真实 CDC、生产检查点存储及多实例恢复另行验收。
