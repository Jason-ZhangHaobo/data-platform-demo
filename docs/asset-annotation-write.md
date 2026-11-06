# 资产说明条件保存与原请求恢复

状态：源码与本机隔离验收；没有因此部署云端、开放公网写入或新增模型／Spark执行。

## 用户流程

工程师读取资产说明后编辑。保存绑定已读说明版本和资产证据摘要；后台在同一事务中核对基线、写入新版本及保存原请求回执。其他人已修改说明或资产证据变化时，本次请求明确拒绝，不新增说明版本。界面保留草稿，先对照，再由工程师决定是否沿用当前版本重新保存。

保存回执丢失时保留原编号和原内容，先查询原请求。明确重试仍先查询；只有原请求不存在且本页仍持有原内容时，才按相同编号与冻结内容提交。刷新后的恢复链接只有资产编号和请求UUID，不含业务说明；正文缺失时只读查询，不能从新草稿重建旧请求。

查回的原结果与当前资产分别显示：原V3不会因为后来已有V4而被替换为V4；恢复也不覆盖保存后继续编辑的草稿。已确认保存设置读取版本下限，详情仍须独立重读，不凭原回执制造最新血缘或统计。

## API与多端

新协议 `shuduo-asset-annotation-write/v2`，路径：

- `POST /api/v2/assets/:id/annotation-requests`：完整字段、请求UUID、已读版本和证据摘要。`Idempotency-Key`如提供必须与正文编号一致。
- `GET /api/v2/assets/:id/annotation-requests/:requestId`：只读查原请求；账号、项目和资产范围由后端绑定。

示例正文（摘要需替换为实际已读值）：

```json
{
  "protocol": "shuduo-asset-annotation-write/v2",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "expected": {"revision": 2, "evidenceHash": "实际已读的64位小写十六进制摘要"},
  "annotation": {
    "businessName": "虚构证券持仓", "description": "虚构财富管理持仓口径",
    "domain": "财富管理", "owner": "虚构负责人",
    "classification": "INTERNAL_DEMO", "tags": ["证券"]
  }
}
```

首次保存请求回执为HTTP 201，重放为200；**这表示请求记录已保存，业务是否应用必须检查 `receipt.outcome`**。`APPLIED`包含原说明快照，`REJECTED`包含`BASE_STALE`与拒绝时观察到的基线。两者均不可由同编号改写；相同账号／项目／资产的同编号换内容为409。其他账号查该编号为404。

原回执有SHA-256摘要，读取时核对原说明记录；损坏拒绝，不修复或重算。当前资产读失败不妨碍查询已核对的原回执，当前投影标为`UNAVAILABLE`。摘要是完整性检查，不是不可篡改审计签名。

CLI：`shuduo assets annotation-submit --id fixture:positions --file request.json`；查询为`assets annotation-request --id fixture:positions --request-id UUID`。提交被拒绝时保留结构化回执并返回退出码2；只读查询拒绝回执仍返回0。

MCP工具：`asset_annotation_submit`与`asset_annotation_request`。提交的业务拒绝标记`isError:true`，查询返回原记录。GUI、CLI及MCP共用校验与规范路径，冒号保留原样。

旧 `POST /assets/:id/annotation`、旧CLI／MCP及历史去重空间保持原语义；不能把它们称为已具备新条件写保证。新协议不扩大只读入口、项目角色或CSRF权限。

## 验收范围

19项定向回归覆盖事务回滚、SQLite关闭重开、身份与项目边界、CAS拒绝、旧协议兼容、回执损坏、详情不可用、未知恢复、冻结重试和CLI／MCP一致性。真实本机HTTP验证认证、只读拒绝和身份伪造拒绝。

实际源码界面以临时内存SQLite和虚构证券元数据验证：旧V1被V2拒绝、丢失成功回执恢复原V3／当前V4、重新打开链接只查不写、恢复保留新草稿、未送达请求以原编号及冻结内容显式重试为V5。历史问答、丢包和服务故障为合成。完整CI 1562项：1561通过、0失败、1既有跳过；不计完整Agent E2E或真实云恢复。
