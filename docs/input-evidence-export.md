# 从原交付包下载最小输入证明

## 使用目的

工程师无需整理整个元数据库和落地数据库，就能核对交付所用输入。在独立 Agent 的原交付文件区点击“读取原包输入证明”，确认原版本、目标表、目标行数和原 CSV 行数，再下载证明 JSON。该文件与原包摘要绑定，是独立侧包，不改变八文件交付、原包摘要或审阅批准。

材料只包含所选输入所需的五类记录和确切留存快照：同步运行、同步配置、采集元数据、源版本、冻结输入。字段按白名单导出，源文件路径、账号、会话、凭证、其他用户及其他任务不会随全库带出。文件仍含所选虚构持仓和必要标识，应按对应项目的共享范围使用。

原 CSV 不嵌入侧包，因为它可能还有未映射字段。使用者在本机另行提供原 CSV；核验会检查其字节摘要、结构及计数，不用一个 DELETE/增量文件替代完整目标。

## 三个文件的离线输入检查

保留同一版本的交付包 JSON、输入证明 JSON 和原 CSV，以及从原审阅版本记录的可信包摘要。

```sh
node scripts/verify-saved-sync-sql-lifecycle.mjs \
  --input-only \
  --input-evidence /path/to/shuduo-input-evidence.json \
  --package-file /path/to/shuduo-delivery-package.json \
  --package-digest <ORIGINAL_SHA256> \
  --source-csv /path/to/original-source.csv \
  --project project-securities-lab \
  --actor local-engineer
```

项目和作者必须对应原包。上述身份是虚构本机示例，不是公网访问凭证。JSON 模式不接受 `--metadata`、`--landing-snapshots` 或消费/发布/报表/质量参数；原数据库模式及完整生命周期命令保持。

成功结果仍为 `LOCAL_SAVED_INPUT_ONLY`，不表示已经生成代码、发布、调度、消费或完成自主 E2E。缺失、错批、损坏、跨身份或跨项目必须拒绝，不回退当前表或其他包。

## API、CLI 与 MCP

- `GET /api/v2/delivery/packages/:id/input-evidence?packageDigest=<SHA256>`：沿用原包所有权、原版本和本机回环边界；只接受唯一完整摘要。
- `node bin/shuduo.mjs delivery input-evidence --id <PACKAGE_UUID> --package-digest <SHA256>`：输出同一份 JSON，可保存到项目自己的受保护文件。
- MCP 工具 `delivery_input_evidence`：只读，参数 `packageId`、`packageDigest`，不创建任务或授予权限。

协议为 `shuduo-sync-input-evidence/v1`，大小上限 3 MiB。离线原 CSV 上限与现有接入一致为 5,000,000 字节，其他文件读取上限保持。包含原包编号/摘要、来源绑定摘要、最小记录、原快照和内容摘要；原 CSV 及原文件路径不包含。GUI 读取并核对结构、范围及内容摘要后才允许下载。失败清除旧材料，切换版本不会把迟到响应当成新版本。

`evidenceHash` 用于内容完整性检查，不是数字签名或不可篡改生产审计。`immutableAuditVerified:false`、`sourceCsvIncluded:false`、`fullLifecycleE2E:false` 为协议固定边界。离线检查同时使用原包内容、可信原包摘要和原 CSV；不能仅凭侧包自己声明的摘要信任未知来源文件。

## 兼容与验收

当前表、旧归档全量和新物化来源均可使用最小记录；旧全量 CSV 重放保持。新物化来源要求确切留存目标；旧全量若本来未留存快照，只能依原 CSV 重放核对，不补造历史归档。

本机实际 API/CLI/MCP 核对相同输出，覆盖零行清仓、旧来源、额外字段、嵌套对象、缺快照、摘要/项目/作者失配。导出不会运行模型、Spark、准备制品、审阅或发布。实际 Chrome 已下载文件并用该文件执行离线 CLI，桌面/420px、失败后下载撤下和原八文件保留已分别验证。Safari 下载方式复用原生 Blob 保存和文本备用，正式 Safari/公网验收仍单列，不以本机 Chrome 代替。
