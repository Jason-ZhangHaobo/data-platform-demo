# 20条完整生命周期评测

日期：2026-09-15。正式运行ID：`5db021f8-2efd-4599-848e-25fe29611559`。部署范围：`LOCAL_ACTUAL`；公网：未部署。

## 结论

- 冻结任务20，已执行20，完整成功20，失败0，未执行0。
- 本机完整生命周期率100%，目标≥85%，门槛通过。
- 实际调度上线批次40；每条任务两个墙上时钟触发的Spark3.5.7批次，均通过测试SQL与5套独立回归。
- 受控绕行：3次BLOCKED、1次CANCELLED、4次RESCUED；全部保留在逐例报告，没有增加评测分母。
- `fullLifecycleE2E=true`只表示当前本机范围六个阶段全部有证据；`publicDeployed=false`，不能改称公网或生产完成。

## 证据来源与防冒充

正式M1运行`a6ccf750-836d-4f1b-8e73-a66da710e1bb`的20条真实Qwen代码阶段证据仍存在原临时数据库。导出脚本逐一验证Agent/Revision/Run关系、SQL SHA-256、Apache Spark 3.5.7、五场景断言和1—3次修正上限，然后生成`fixtures/e2e/m1-code-evidence.json`。

冻结清单源报告SHA-256为`8da9a47f1f1ebc081e7c781000a3f6b77c322cede18fac62092aaf1677b5a32b`；不含Spark日志、本机绝对路径、密钥或公司资料。完整评测复用的是原模型产物，不是参考SQL。

每条任务的通过条件：

1. 需求理解：原真实Agent任务和需求摘要存在。
2. 代码与调试：SQL哈希一致，原Spark运行和五套回归通过。
3. 调度文件：版本包包含schedule、calendar和独立manifest，DAG可解析。
4. 部署文件：main.sql、tests.sql、deployment.json齐全，并由Spark实际演练成功。
5. 本机上线：审批绑定包摘要，版本实际激活，两个调度批次由墙上时钟触发并成功。
6. 上线后监控：发布健康HEALTHY、至少两个成功事件、开放告警0。

## 失败、取消与救援

- 第1例先提交非交易日，平台422阻止执行；改用样例交易日后完成。
- 第6例主动取消一次文件演练并保留CANCELLED；使用新幂等键重新演练后完成。
- 第11例用错误包摘要审批，平台409拒绝；使用正确摘要后完成。
- 第16例复用幂等键却更换包名称，平台409拒绝；保持原请求语义后继续完成。

这些绕行属于同一任务内部救援，不新增分母。当前没有最终失败例，但并未删除中间失败状态。

## 复现与边界

- 冻结证据校验：`node --test test/v2/lifecycle-evaluation.test.mjs`
- 单例烟雾：`V2_E2E_CASE_LIMIT=1 node scripts/run-full-lifecycle-evaluation.mjs`
- 正式20例：`node scripts/run-full-lifecycle-evaluation.mjs`
- 最新报告：`.v2-artifacts/full-lifecycle/latest.json`（本机忽略文件）；API为`GET /api/v2/evaluations/full-lifecycle/latest`。

20条由4类客户资产开发意图×5套输入构成，覆盖现金变化、重复持仓、同额不同持仓、纯现金客户、字段/范围错误和多轮修正。它尚未覆盖不同输出契约、所有经典模块、权限型任务、跨模块Agent自主编排、公网认证、云隔离或生产SLA，因此100%不可外推为平台总体成功率。
