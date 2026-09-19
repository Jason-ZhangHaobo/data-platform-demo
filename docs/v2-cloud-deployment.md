# V2 阿里云部署说明

日期：2026-09-18。状态：代码包与受保护手动工作流已准备；GitHub Linux x64手动CI已完成构建/Node24校验，`JASONSECRETS` bundle兼容已实现，真实RDS/OSS部分预检完成，V2专用FC/ICP备案与公网部署尚未验收。

## 为什么单独打包Node 24

V2使用`node:sqlite`作为本机和首个云试点的同步索引。阿里云FC目前列出的内置Node运行时最高为Node 20，而自定义Debian 12允许随代码包携带Linux x64解释器并配置启动命令。因此V2包自带Node 24，不依赖旧函数的`/var/fc/lang/nodejs20/bin/node`。

官方依据：

- [阿里云FC自定义运行时](https://help.aliyun.com/zh/functioncompute/custom-runtime/)
- [CreateFunctionInput运行时、角色与实例并发参数](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-createfunctioninput)
- [FC代码包和运行资源限制](https://help.aliyun.com/en/functioncompute/limits-of-usage)
- [FC环境变量与函数角色临时凭证](https://help.aliyun.com/zh/functioncompute/environment-variables)

## 包内容与门禁

`scripts/build-v2-fc-package.sh`只能在Linux x64运行，要求Node 24以上，输出路径只能位于仓库根或`/tmp`且拒绝覆盖已有ZIP。包内只包含：

- Linux x64 Node 24解释器；
- `src/`、构建后的`web-dist/`和仓库内虚构证券`fixtures/`；
- `deploy/v2/package-lock.json`锁定的mysql2及传递依赖；
- 不包含`.env`、`.env.local`、PEM或Key文件。

ZIP超过70MiB即失败，以避开FC API Base64后总请求100MB限制。GitHub主CI会在Linux实际构包并验证解释器平台、`node:sqlite`、入口、网页和fixtures；本次手动运行已通过，但不把完整包上传到额外Artifact，后续应使用受保护部署工作流在同一Runner内完成受控更新。

## 部署工作流

`.github/workflows/deploy-v2-staging.yml`只能手动触发，且使用独立GitHub Environment `v2-staging`。它不会修改现有V1函数；目标函数默认为`dataplatform-v2-staging-api`，可由同目录的预置工作流安全创建，也可由账号内操作预创建。

独立预置使用`.github/workflows/provision-v2-staging.yml`。该工作流同样只能手动触发，先做账单、角色信任/管理员级策略文本、同VPC网络和目标不存在检查，然后调用FC 3.0 `CreateFunction`；发现同名函数、未确认NotFound或任何门禁失败时不写云资源。CLI的404可能出现在stdout JSON或stderr文本，工作流通过`scripts/extract-aliyun-error-code.mjs`只提取受限字符错误码，未知响应固定失败且不打印原始消息。创建后必须把函数预留并发设为1、最小实例数设为0并再次读取验证；结合函数本身`instanceConcurrency=1`，试点最多同时运行一个实例且无请求时可缩至0。它不删除资源、不更新旧函数，也不把预置成功当成公网部署成功。

预置顺序：受保护配置校验 → GitHub OIDC换取临时身份 → 实时账单、运行角色与精确网络只读门 → 全量CI → 构建/检查ZIP → 确认目标函数不存在 → 创建独立函数并复核单实例上限/按需缩至0。云权限或配置错误会在完整构建前快速失败，函数写入仍只发生在质量门和包检查全部通过之后。

公网更新顺序：全量CI → 构建/检查ZIP → 校验配置及24小时内脱敏云审计/备案证据 → GitHub OIDC换取临时身份 → 实时账单小于200元 → 确认专用函数/VPC/单实例上限/按需缩至0/角色 → 以白名单新环境更新V2函数 → 验证HTTPS、MySQL/OSS健康、公开页面和匿名写入401。任一缺失即失败关闭。

### 部署角色最小权限

`scripts/render-v2-deploy-policy.mjs`根据受保护环境中的账号、地域、函数运行角色、vSwitch和安全组生成策略，不在仓库保存真实标识。生成结果只包含：

- 精确函数运行角色上的`ram:GetRole`、`ram:ListPoliciesForRole`和仅允许交给`fc.aliyuncs.com`的`ram:PassRole`；
- 精确vSwitch上的`vpc:DescribeVSwitchAttributes`和精确安全组上的`ecs:DescribeSecurityGroups`；列表接口`DescribeVSwitches`只支持`vswitch/*`，不用于本项目的最小权限门；
- 工作流实际使用的`fc:CreateFunction`、`fc:GetFunction`、`fc:UpdateFunction`、并发和弹性配置读写；不授予`fc:*`；
- 预算读取仍由已存在的独立`bss:DescribeBillList`策略提供，不混入资源写策略。

预览命令只输出策略模板，不调用云API：

```bash
ALIYUN_ACCOUNT_ID=... \
ALIBABA_CLOUD_REGION_ID=cn-hangzhou \
V2_FUNCTION_ROLE_ARN=... \
V2_VSW_ID=... \
V2_SECURITY_GROUP_ID=... \
node scripts/render-v2-deploy-policy.mjs
```

获明确授权后，使用同一组非秘密变量加部署角色ARN执行幂等应用器：

```bash
V2_DEPLOY_ROLE_ARN=... \
node scripts/apply-v2-deploy-policy.mjs --apply
```

应用器仅创建并附加固定名称的自定义策略；重复运行会复核默认版本正文和角色附加状态。若同名策略内容不同则返回`POLICY_DOCUMENT_MISMATCH`并停止，不自动覆盖、创建新版本或扩大权限。回滚仅需由管理员将该自定义策略从部署角色解绑；脚本本身不提供删除或解绑动作。FC 3.0文档规定本工作流使用的Create/Get/Update、并发和弹性配置接口只支持`Resource:"*"`，因此以精确动作清单而非`fc:*`限制范围；RAM角色、vSwitch和安全组继续精确到单个资源。

当前最新预置运行`35298563745`已通过配置、CI、构包、OIDC和账单检查，随后被`ram:GetRole`拒绝；函数创建步骤没有执行。必须先用上述完整策略核对现有部署角色差异，经明确批准后一次修正，不能继续按单个报错猜权限并反复运行完整部署。

运行变量：

- `V2_FUNCTION_NAME`、`V2_PUBLIC_URL`、`V2_PUBLIC_ORIGIN`、`V2_OSS_BUCKET`
- `V2_DEPLOY_ROLE_ARN`、`V2_DEPLOY_OIDC_PROVIDER_ARN`、`V2_VPC_ID`、`V2_VSW_ID`、`V2_SECURITY_GROUP_ID`：只在受保护Environment提供，仓库工作流不写真实标识
- `V2_AUDIT_EVIDENCE_FILE`：指向`docs/evidence/`内的单个脱敏JSON，必须当月、24小时内、对应专用函数和实际HTTPS域名哈希
- OSS状态对象和不可变产物前缀由工作流固定为项目隔离路径，不接受页面输入
- `V2_ACCOUNT_MONTHLY_SPEND_CNY`不再由手填变量代入；工作流用OIDC临时身份实时查询BSS税前账单，达到200元就停止，并只把脱敏金额传给函数

运行秘密：

- `V2_MYSQL_HOST`、`V2_MYSQL_PORT`、`V2_MYSQL_USER`、`V2_MYSQL_PASSWORD`、`V2_MYSQL_DATABASE`
- `V2_BOOTSTRAP_ADMIN_EMAIL`、`V2_BOOTSTRAP_ADMIN_PASSWORD_HASH`、`V2_BOOTSTRAP_ADMIN_NAME`；禁止保存管理员明文密码
- `DASHSCOPE_API_KEY`
- 可选单一秘密`JASONSECRETS`：使用白名单键组成的JSON对象或单行`KEY=VALUE`文本，可替代上述逐项Secrets；逐项Secrets与其同时存在时逐项值优先
- 可选隔离执行：变量`V2_SPARK_EXECUTOR_URL`与秘密`V2_SPARK_EXECUTOR_SECRET`；Worker未完成真实验收前保持为空

秘密只进入GitHub受保护Environment和FC加密环境变量；仓库、日志和构建产物不保存值。函数角色负责注入临时OSS凭证，不创建或手填长期AccessKey。

配置入口：在 GitHub 仓库的 **Settings → Environments → v2-staging** 中填写上述变量和秘密（[直接打开环境设置](https://github.com/Jason-ZhangHaobo/data-platform-demo/settings/environments)）。`V2_DEPLOY_ROLE_ARN`只用于GitHub Actions的OIDC部署身份，`V2_FUNCTION_ROLE_ARN`只用于FC运行时临时凭证；两者必须不同。密码、管理员哈希和百炼Key只放Secrets，不要提交仓库或发到聊天。

管理员哈希由用户在本机通过`npm run --silent v2:admin-hash`从stdin生成；不要把密码或哈希发到聊天。部署工作流不再接受`V2_BOOTSTRAP_ADMIN_PASSWORD`，云服务检测到该明文变量会拒绝启动。

## 首次云预检

在运行工作流前必须只读确认：

1. RDS规格、状态、到期/试用信息、VPC、内网地址及当前账单；
2. 独立平台数据库和最小权限账号是否存在，不复用`business_demo`业务账号；
3. 私有OSS Bucket地域、版本/生命周期和FC角色的对象权限；
4. 独立FC函数运行时、VPC、角色、实例并发1、预留并发1、最小实例0和公网HTTPS URL；
5. 以上资源在月度200元总预算内。

`scripts/verify-v2-cloud-preflight.mjs`同时校验审计文件不含账号ID、函数名、Bucket名、连接地址、凭证或公司特有环境键；当期账单、RDS/OSS、V2专用函数、同VPC、备案/域名归属/HTTPS及目标哈希须全部为真。当前真实脱敏证据失败项是专用FC、同VPC和域名备案，工作流应保持不可部署。账单快照¥0.59仅是查询当时状态，不是未来费用承诺。

官方FC SDK已用短期STS只读重试；内部凭证字段存在，但服务返回`AccessDenied`并提示缺SecurityToken。现阶段不以此推断函数不存在，不创建长期AccessKey，待FC访问边界诊断后再确认独立函数。仓库中的V1部署文件仍有历史个人测试资源标识；本次只清理V2工作流，公开推送前需另行审核当前树与历史记录，不静默改写Git历史。

## 仍然关闭的能力

公网函数已有远程Spark客户端和Worker协议，但尚无通过真实云验收的Java/PySpark执行资源，所以`publicReady=false`必须保持。公开浏览和受邀控制面可以先灰度，任意代码/SQL执行不能因协议测试或页面可点击就开放；执行层完成后另做私网/函数鉴权、故障、超时、权限、成本和回滚验收。

Worker运行时、Spark 3.5.9安全升级、大包构建和W0—W5门槛见[隔离Spark Worker](isolated-spark-worker.md)。
