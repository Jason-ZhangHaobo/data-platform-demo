# V2 隔离Spark Worker

日期：2026-09-20。状态：协议、客户端、Worker服务和版本化交付已本机验收；W1 Linux大包已在GitHub Runner真实构建并从包内运行Spark；W2云部署计划已按官方限制生成但尚未创建FC。

## 设计目标

公网控制面保持轻量，不在处理登录、资产查询或页面请求的进程内运行Spark。只有通过身份、项目权限和代码安全检查的任务，才将有限合成上下文发送给单独执行函数。

这不是通用任意代码沙箱。第一版只执行本项目允许的单条Spark SQL，并只接收`accounts`、`positions`、`cash`三张虚构证券表；Python、外部文件、任意JAR/UDF和公司数据均不在范围内。

## 调用协议

控制面发送`shuduo-spark-execution/v1` JSON：请求ID、提交时间、SQL、一个主上下文、最多五个回归上下文和可选测试SQL。

应用层签名：

`HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + SHA256(body))`

- 时间戳为13位毫秒，默认允许60秒偏差；
- Nonce为24字节随机值，Worker在有效窗口内拒绝重复；
- 签名绑定完整正文，修改SQL、数据或断言都会失败；
- 默认请求/响应各2MiB，执行最长120秒，单Worker同时只运行1项；
- 非回环地址必须HTTPS，重定向被拒绝；
- Worker返回`SUCCEEDED`但独立断言未通过时，控制面仍按无效结果拒绝。

HMAC是应用层纵深防御，不足以单独抵御恶意流量带来的函数调用费用。真实部署还必须使用FC私网、函数级鉴权或其他账号级调用保护，不能开放匿名公网Worker。

## 运行时与安全升级

本机历史验收使用Spark 3.5.7，相关证据保持不可变。2026-09-15检查发现PyPI为3.5.7列出已在3.5.8修复的安全问题，而Apache已经发布3.5.9稳定维护版。因此：

- 历史3.5.7只保留为本机既有证据，不打入新云Worker；
- 新Worker锁定`pyspark==3.5.9`和`py4j==0.10.9.9`，requirements包含PyPI文件SHA-256；
- Worker执行器实际依赖`sqlglot==27.14.0`做Spark SQL AST安全检查；首次包级冒烟暴露其未进入云requirements，现已按PyPI wheel SHA-256补齐，不能只检查Spark JAR便声称运行时完整；
- 云交付包必须由实际3.5.9 Worker运行产生，并把引擎版本、`FUNCTION_PROCESS`隔离和2GiB内存写入版本化部署清单；
- 远程运行如果报告3.5.7，交付包生成失败关闭；本机历史3.5.7包仍可复验，不被改写。

同日已把项目隔离的本机运行时升级为Spark3.5.9/py4j0.10.9.9，并在新版本重新执行35项引擎、交叉口径与测试SQL用例，35/35通过、耗时23.891秒。该证据仍属于本机，不替代W1—W5云端门槛。

官方依据：[Apache Spark 3.5.9发布](https://spark.apache.org/news/)、[Apache Spark下载与安全提示](https://spark.apache.org/downloads)、[PySpark 3.5.9 PyPI元数据](https://pypi.org/pypi/pyspark/3.5.9/json)。

## 构建包

`scripts/build-v2-spark-worker-package.sh`要求Linux x64与Python3.10，安装哈希锁定依赖，复制最小Node Worker和Python执行器，拒绝秘密文件与覆盖已有ZIP。包最大480MiB；PySpark源码包约303MiB，不能通过FC API的Base64代码字段上传，应先放入私有OSS，再由FC代码位置引用。阿里云官方限制显示杭州通过OSS引用的ZIP上限为500MB，而API Base64请求体上限为100MB；FC 3.0 `InputCodeLocation`明确支持`ossBucketName`与`ossObjectName`。[FC配额与限制](https://help.aliyun.com/en/functioncompute/limits-of-usage)、[OSS代码位置结构](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-inputcodelocation)

手动GitHub工作流`.github/workflows/build-v2-spark-worker.yml`将：

1. 运行协议测试；
2. 构建并检查Spark 3.5.9 JAR、包完整性和秘密文件；
3. 上传仅保留1天的GitHub构建产物，供受控云验证。

2026-09-19首次真实运行`35427706320`在GitHub Linux Runner完成Python3.10哈希依赖安装、协议测试、Spark3.5.9 JAR检查、秘密文件检查和短期Artifact上传。后续双构建证明了确定性ZIP，但包级真实执行进一步发现云requirements遗漏`sqlglot`。按PyPI wheel哈希补齐后，独立运行`35430365703`和`35430441817`均生成318,911,849字节的内部ZIP，SHA-256同为`2ba7c6f649396109d08cf33c0eb2dfd9d320c4c4a9f24ed702d6e2a753fc53e0`；两次均从解压后的包启动Java17/Python3.10 Worker，使用Spark3.5.9实际执行标杆证券SQL、测试SQL和5套独立回归并通过。W1的可复现性和Linux包级运行通过；该证据仍不是FC云健康W2。

## W2部署计划（未部署）

`scripts/render-v2-spark-worker-w2-plan.mjs`只生成脱敏、失败关闭的W2计划，不上传包或创建函数。它把包摘要固定为私有OSS精确对象`data-platform-demo/v2/spark-worker/<sha256>.zip`，要求单次禁止覆盖上传，并给出单独的最小权限差异：部署角色只新增该对象的`oss:GetObject`与`oss:PutObject`，没有List/Delete、Bucket管理或FC Invoke权限。

上传后必须使用`scripts/verify-v2-spark-worker-oss-object.mjs`读取`ossutil api head-object --output-format json`证据，核对实际Content-Length、`x-oss-meta-shuduo-sha256`和ETag。验证器只输出对象键哈希和固定检查项，不输出Bucket/Object原值。HeadObject只能证明当前对象内容与元数据匹配，不能单独证明Bucket非公开或历史上从未覆盖，因此证据明确保留`publicAccessVerified=false`与`overwriteProtectionVerified=false`，这两项须由独立Bucket审计和上传日志补齐。[HeadObject命令与权限](https://help.aliyun.com/en/oss/developer-reference/head-object)

`scripts/verify-v2-spark-worker-oss-privacy.mjs`独立核对四项访问证据：Bucket ACL必须private、Object ACL必须private/default、Bucket Policy Status必须`IsPublic=false`、Bucket级Block Public Access必须开启。任一证据缺失均失败关闭；输出不包含Owner、Bucket或Object名称。对象ACL优先于Bucket ACL，不能只查Bucket；Bucket Policy和Public Access Block也参与匿名访问决策。[Bucket ACL](https://help.aliyun.com/en/oss/developer-reference/get-bucket-acl)、[Object ACL](https://help.aliyun.com/en/oss/developer-reference/manage-the-acl-of-an-object)、[Bucket Policy公开状态](https://help.aliyun.com/en/oss/developer-reference/get-bucket-policy-status)、[Bucket公共访问阻断](https://help.aliyun.com/en/oss/developer-reference/get-bucket-public-access-block)

函数创建后必须把GetFunction、GetConcurrencyConfig和GetScalingConfig原始响应送入`scripts/verify-v2-spark-worker-function.mjs`。验收同时核对Active/Successful状态、代码字节、Custom Debian、CPU/内存/磁盘/超时、三层ARN与路径、VPC绑定、Worker密钥摘要、无运行角色、无公网出站、实例并发1、预留1和最小实例0。输出只包含布尔检查；即使全部通过也固定`publicDeployed=false`、`controlPlaneConnected=false`，只能作为W2规格证据，不能代替真实Spark调用。

官方公共层文档确认`custom.debian10`需要显式挂载并配置路径，不能把GitHub Runner上的系统Node/Python/Java误认为FC自带：

- Node20：`acs:fc:cn-hangzhou:official:layers/Nodejs20/versions/3`，PATH前置`/opt/nodejs20/bin`；
- Python3.10：`acs:fc:cn-hangzhou:official:layers/Python310/versions/3`，PATH前置`/opt/python3.10/bin`；
- Java17：`acs:fc:cn-hangzhou:official:layers/Java17/versions/3`，`JAVA_HOME=/opt/java17`。

依据：[官方公共层](https://help.aliyun.com/en/functioncompute/configure-common-layers-for-a-function-1)、[Node20层说明](https://github.com/awesome-fc/awesome-layers/blob/main/docs/Nodejs20/README.md)、[Python310层说明](https://github.com/awesome-fc/awesome-layers/blob/main/docs/Python310/README.md)、[Java17层说明](https://github.com/awesome-fc/awesome-layers/blob/main/docs/Java17/README.md)。

W2仍使用Cloud Shell主账号做私有手工Invoke，不给GitHub部署角色增加`fc:InvokeFunction`。控制面自动调用Worker属于W3，需要另行诊断并批准控制面运行角色的最小Invoke权限，当前计划明确标记`authorized=false`。

## 目标FC规格（待账号核验）

- 独立函数，不与V2控制面共进程；
- Custom Debian 10，显式挂载官方Node20、Python3.10和Java17公共层；
- Node/Python/Java路径使用官方层文档值，真实FC启动后仍须逐项核验；
- 1 vCPU、2GiB内存、实例并发1、最大实例1、最小实例0；
- 无公网出站需求；临时目录`/tmp`，运行后删除输入/输出；
- Worker触发器不得匿名公网开放；控制面使用受保护调用路径；
- 共享密钥只存云秘密配置，控制面和Worker两端一致，仓库不保存。

环境键：`V2_SPARK_WORKER_SECRET`、`V2_SPARK_WORKER_RUN_TIMEOUT_MS`、`V2_SPARK_WORKER_MAX_BODY_BYTES`、`V2_SPARK_WORKER_MAX_SKEW_MS`、`V2_ARTIFACT_ROOT=/tmp`、`V2_RETAIN_SPARK_ARTIFACTS=false`、`V2_PYTHON`、`JAVA_HOME`、`PYTHONPATH=/code/python`。

## 分级验收

| 等级 | 门槛 | 当前状态 |
|---|---|---|
| W0 协议 | HMAC、篡改、重放、白名单、大小、超时、错误结果 | 已本机验收 |
| W1 Linux包 | Python3.10构建、哈希依赖、ZIP<480MiB、Spark3.5.9 JAR、包级真实SQL冒烟 | 已验收；双构建摘要及两次5套回归一致 |
| W2 云健康 | Java/Python/Spark可启动，私网/函数鉴权，最小实例0 | 部署计划/精确权限差异已生成；待真实FC |
| W3 单任务 | 标杆SQL+测试SQL+五回归真实执行，控制面保存结果 | 待真实FC |
| W4 故障恢复 | 篡改、超时、取消、并发、Worker冷启动和失败重试 | 待真实FC |
| W5 公网E2E | 受邀用户从需求到发布监控，至少20条且≥85% | 待公网评测 |

只有W2—W4通过后，控制面设置中的Spark才可显示“云端已验证”；只有W5通过后，才可把本机完整E2E结论升级为公网结论。
