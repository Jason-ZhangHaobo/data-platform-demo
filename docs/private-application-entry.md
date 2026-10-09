# 数舵私有应用任务入口

当前用于备案前的私有任务验收。入口需要已有阿里云IAM调用身份，且仅在控制面V2_PROVISIONING_ONLY和V2_PRIVATE_SMOKE_ENABLED同时开启时有效。部署记录：[37867687484](https://github.com/Jason-ZhangHaobo/data-platform-demo/actions/runs/37867687484)。

## 应用调用

PRIVATE_APPLICATION_HTTP_V1只转发列出的状态、上下文、登录、代码版本和运行API。目标固定为当前进程的回环HTTP服务；外部地址、未列出路径及注入请求头均拒绝。写操作继续使用原有应用会话、CSRF、项目和角色校验。它不增加公开HTTP触发器或IAM动作。

PRIVATE_APPLICATION_TASK_V1是两个虚构证券用例的验收驱动。它生成临时ENGINEER身份，通过普通登录API、POST /revisions、POST /runs、GET /runs/:id完成任务，检查相同请求去重，最后禁用验收身份并撤销会话。它使用已确认的参考SQL，尚未调用Data Agent生成代码。

## 可复刻命令

在已登录的Cloud Shell中运行项目中的脚本：

```sh
python3 scripts/run-v2-private-application.py --case holdings-t1 --output p1-holdings.json
python3 scripts/run-v2-private-application.py --case cash-change --output p1-cash.json
python3 scripts/run-v2-private-application.py --restore-from p1-cash.json
```

脚本只输出非秘密验收摘要，完整结果保存在指定报告文件中。首次已提交任务若遭客户端断线，先通过HTTP适配入口GET原任务记录，不盲目再提交。脚本有有界超时且禁用自动调用重试。

## 2026-10-09实际结果

| 用例 | 客户总资产 | Spark | 独立证券场景 | 独立调用重读 |
|---|---:|---|---:|---|
| 基础客户持仓与现金 | 1800.00 | 3.5.9成功 | 5个通过 | 完整结果一致 |
| 同客户现金变更为800.00 | 2300.00 | 3.5.9成功 | 5个通过 | 完整结果一致 |

结果差500.00，与实际输入现金差一致；两份完整行结果摘要与独立本地预期完全一致。首次响应因Cloud Shell断线丢失，之后从已完成任务恢复；第二份任务的去重回执实际取得。证据见[evidence/v2-private-application-20261009.json](evidence/v2-private-application-20261009.json)。

## 尚未验收

本次通过的是私有CLI/应用API任务链路。浏览器工作台直接操作云端任务、控制进程冷重启、断开客户端后的后台推进、超时/取消/恢复、跨用户权限，以及完整Agent七环节均需独立验收。验收驱动保持一次调用活动直至计算结束，不能据此宣称无人轮询时异步任务仍可靠运行。本次不计入完整Agent的20例与85%目标。
