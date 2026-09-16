# Agent受控交付准备：真实模型SQL到可审阅文件包

日期：2026-09-15。范围：本机虚构中国证券财富管理T+1任务；公网/公司系统均未接入。

## 用户旅程与责任

工程师明确客户总资产、现金独立聚合和持仓去重口径 → 代码Agent用真实Qwen生成SQL → Spark实际执行并独立验证 → 工程师可点击“Agent继续准备并演练” → 平台标准生成器固定SQL、tests.sql、schedule.json、deployment.json、日历/输入/验证报告 → 后台重新读取文件并在Spark上演练 → 停在工程师审阅包摘要。审批、计时发布、运维和公网部署不自动进行。

模型负责代码；调度/部署文件来自受控标准生成器，不声称模型原创。Agent在本阶段负责编排、绑定和实际验证。

## 本次真实证据

- 源委托`4a412b2e-d479-4130-bd30-04f6a307d1ca`：qwen3-coder-plus一次生成，输入927/输出390/总1317 Token；`completionScope=SQL_DEVELOPMENT`。
- 代码运行`4b8d0597-449d-4825-b715-586f1b9cbc2a`：Apache Spark3.5.9，9,395ms，五套独立回归5/5通过，非测试替身。
- 准备任务`c7a89142-a796-4850-ad0b-feb4fa14b17e`：后台从QUEUED→PACKAGE_READY→FILE_REHEARSAL_RUNNING→AWAITING_ENGINEER_REVIEW，`actualExecution=true`。
- 不可变包`e5d7f494-2889-48ed-b70f-d744de820637`：8个文件，包摘要`c61d82de64ad3f798b790da7f87a7db6241c7ed0fa601865d754e264b94efc9f`；本机不可变对象在元数据外保存。
- 文件演练`9cd8b4e6-8396-4f9b-884f-1b6bf79dce9f`：9,345ms，实际读取文件执行main.sql与tests.sql；测试SQL哈希`0e0c0c072173e01398061e519cb917088326e4426afa7c411bad1e23c4030277`与包清单一致，五套回归5/5；DAG的execute/validate/evidence三节点均SUCCEEDED。
- 新包审批数0、发布数0、`published=false`、`schedulerTriggered=false`。同任务旅程前五阶段真实完成，发布/监控待工程师审阅；`agentIndependentE2E=false`、`fullLifecycleE2E=false`、`publicDeployed=false`。
- GUI实际从开发Agent面板的“审阅交付包再决定审批”进入调度工作台，准确选中该包、显示Spark3.5.9演练通过和“未审批发布”；当前其他健康发布版本不再占用所选包的监控步骤。
- 主页面重新加载后，七阶段前五步分别标注真实Qwen/Spark和Agent受控生成/文件演练；后两步标为工程师审批与调度器监控待完成。V2 CLI和MCP只读同一任务结果，未复制第二套状态。
- 模型预算页从此前估算¥0.146488变为¥0.156436/¥50，新增一次调用按927输入和390输出Token估算¥0.009948。远程Spark仍0/200次；两次本机Spark真实执行不计远程云计算费用。账号账单仍是NOT_CONNECTED，不能由应用估算断言全站月费。

## 自动化安全回归

- 假模型、假Spark回执不能启动或通过交付准备；若文件演练不合格，保留包/演练失败编号，审批数仍为0。
- 同源运行若已有审批包，Agent不会复用旧包；生成新的不可变包，旧批准只留在原包，新包审批数仍为0。
- 匿名公网POST返回401；取消运行中任务后演练为CANCELLED且不能转成功；重启把未完成准备转为INTERRUPTED，不静默重放。
- GUI/API/CLI/MCP同源；MCP取消操作明确要求用户确认。全部只处理仓库虚构证券数据，任务接口不返回业务行、凭证或原始错误。

## 下一阶段

工程师必须审阅SQL与包摘要后决定是否批准；受控发布Agent需要新审批绑定、版本一致性、计时批次、监控和故障恢复证据。当前M2b/M2c人工/API流程已存在，但本任务尚未自动串入，不能用历史冻结20例的本机100%推断新Agent自主完成率或公网能力。
