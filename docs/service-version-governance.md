# DAPI/XAPI版本治理与受控回滚

范围为通用实现和虚构测试。真实环境的升级/回滚是否部署及通过，只看受保护验收记录；本机流程不能改称公网验收。

## 用户旅程

1. 读取服务详情，区分当前草稿与线上版本。创建新草稿不会替换线上端点。
2. DAPI复用既有已核验发布结果，调整输出字段、限流或超时；XAPI未修改steps时继续固定原子版本。不重新生成代码或提交Spark。
3. 对当前草稿实际查询测试；测试回执同时绑定版本ID和配置摘要。切换服务/新建版本后旧界面回执失效。
4. 发布请求必须携带当前configHash；后端重新检查版本正文摘要、成功测试与实际快照，不能靠旧哈希或损坏数据发布。
5. 切换/回滚只选择已测试发布过的目标。界面明确展示线上版本、目标版本和目标摘要；核对影响后才能确认。
6. 后端同时校验expectedPublishedVersionId及目标configHash，保存切换回执。查看历史不会触发执行。

## API与恢复

- `POST /data-services/{dapis|xapis}/:id/versions`：创建不可变草稿。
- `POST .../:id/publish`：`{configHash}`；无当前审阅摘要失败关闭，本机与私有控制面保持一致。
- `POST .../:id/activate`：`{versionId, expectedPublishedVersionId, configHash}`，必须提供稳定Idempotency-Key。由服务端继承现有身份、项目权限和CSRF。
- `GET .../:id/history`：版本切换回执；私有接口按原Owner/Admin过滤。

回执包括fromVersionId、toVersionId、目标摘要和执行人。不包含凭证。原请求重放返回同一回执，不再更改端点；如果之后另有版本切换，返回targetStillActive=false，不能把历史请求成功说成当前仍运行该目标。结果未知时先读详情/回执，再复用原请求标识，不盲目换键重提。

版本配置每次使用都会重新计算摘要；生命周期状态和时间不参与配置哈希。改字段、限流、步骤或来源却保留旧摘要时，执行/发布/切换拒绝409 SERVICE_VERSION_CORRUPT，恢复报告也明确失败。重复发布同一已上线版本保留首次发布时间。

XAPI在运行时继续读取创建时固定的DAPI版本，即使子服务升级到V2。创建新编排若显式指定的子版本与已审阅线上版本不符，则拒绝而不静默替换；克隆现有XAPI而不传steps则保留原固定版本。

## CLI/MCP

```sh
shuduo services show --type dapi --id SERVICE_ID
shuduo services new-version --type dapi --id SERVICE_ID --source-run-id RUN_ID --fields client_id,total_assets --rate-limit 60
shuduo services publish --type dapi --id SERVICE_ID --config-hash REVIEWED_SHA256
shuduo services activate --type dapi --id SERVICE_ID --version-id TARGET_ID --expected-version LIVE_ID --config-hash TARGET_SHA256 --request-id ORIGINAL_REQUEST_KEY --confirm
shuduo services history --type dapi --id SERVICE_ID
```

MCP为data_service_detail、data_service_new_version、data_service_publish、data_service_activate和data_service_history；切换必须confirm=true及稳定requestId。确认参数不替代服务端身份或当前版本校验。管理端真实会话未接入时返回401，不通过应用查询令牌扩大管理权限。

## 验收门槛

正常V1→V2→V1、旧审阅拒绝、他人服务拒绝、草稿不可激活、重复请求和历史重放、版本配置漂移、XAPI子版本固定、发布后实际行变化拒绝、首次发布时间保留、独立后端进程后的回执/去重恢复。CI用合成输入和真实本机SQLite，文件CAS仅替代远端传输，不计FC/MySQL/OSS验收。
