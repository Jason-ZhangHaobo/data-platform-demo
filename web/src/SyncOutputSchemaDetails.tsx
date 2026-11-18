import React from "react";
import type { SyncSqlOutputSchema, SyncSqlRehearsalSchema, SyncSqlScheduledSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import "./sync-output-schema.css";

const labels = { MISSING:"缺少字段", TYPE:"类型不同", ORDER:"顺序不同", DUPLICATE:"字段重复", EXTRA:"多余字段" };
const fieldType = (field: NonNullable<SyncSqlOutputSchema["inputMetadata"]>["frozen"]["columns"][number]) =>
  `${field.type.toUpperCase()} · 第 ${field.position} 列 · ${field.nullable ? "可空" : "非空"}`;

function FrozenSourceSchema({ evidence }: { evidence: SyncSqlOutputSchema["inputMetadata"] }) {
  if (evidence === undefined) return null;
  if (evidence === null) return <p role="status">原输入元数据未能核对，保留本次输出差异。</p>;
  const { frozen, current, differences } = evidence;
  const summary = current === null ? "当前源版本尚无可核对的元数据。"
    : differences.length ? `${differences.length} 个源字段与当前采集版本不同。本次执行使用冻结输入。`
      : "冻结输入与当前已采集源的字段结构一致。";
  return <details className="agent-dev-source-schema" open={differences.length > 0 || undefined}>
    <summary>冻结输入元数据</summary>
    <p>同步批次 <code title={evidence.syncRunId}>{evidence.syncRunId.slice(0,8)}</code> · 原元数据 <code title={frozen.metadataVersionId}>{frozen.metadataVersionId.slice(0,8)}</code>
      {current && current.metadataVersionId !== frozen.metadataVersionId && <> · 当前元数据 <code title={current.metadataVersionId}>{current.metadataVersionId.slice(0,8)}</code></>}</p>
    <p>{summary}</p>
    <div className="agent-dev-table-scroll"><table aria-label={differences.length ? "原冻结源与当前源字段差异" : "冻结源字段"}>
      <thead><tr><th scope="col">字段</th><th scope="col">冻结输入</th>{differences.length > 0 && <th scope="col">当前已采集源</th>}</tr></thead>
      <tbody>{differences.length ? differences.map(({name,before,after}) => <tr key={name}>
        <th scope="row"><code>{name}</code></th><td>{before ? fieldType(before) : "原结构无此字段"}</td><td>{after ? fieldType(after) : "当前结构无此字段"}</td>
      </tr>) : frozen.columns.map(field => <tr key={field.name}><th scope="row"><code>{field.name}</code></th><td>{fieldType(field)}</td></tr>)}</tbody>
    </table></div>
  </details>;
}

export function SyncOutputSchemaDetails({ schema, dirty = false }: { schema:SyncSqlOutputSchema|SyncSqlRehearsalSchema|SyncSqlScheduledSchema; dirty?:boolean }) {
  if (schema.status === "MATCHED") return null;
  const origin = schema.protocol === "shuduo-sync-sql-scheduled-schema/v1"
    ? { label:"批次", id:schema.source.batchId }
    : schema.protocol === "shuduo-sync-sql-rehearsal-schema/v1"
      ? { label:"演练", id:schema.source.verificationId }
      : { label:"运行", id:schema.source.runId };
  return <section className="agent-dev-output-schema" aria-label="输出结构差异">
    <h4>输出结构差异</h4>
    <p>{origin.label} {origin.id.slice(0,8)}
      {schema.protocol !== "shuduo-sync-sql-output-schema/v1" && ` · 包 ${schema.source.packageDigest.slice(0,8)}`} · 版本 {schema.source.revisionId.slice(0,8)}
      {dirty && " · 当前草稿尚未核验"}</p>
    {schema.status === "UNAVAILABLE" ? <p>原{origin.label}没有可核对的 Spark 列结构。</p> :
      <div className="agent-dev-table-scroll"><table aria-label="预期和实际 Spark 输出">
        <thead><tr><th scope="col">字段</th><th scope="col">预期类型</th><th scope="col">实际类型</th><th scope="col">差异</th></tr></thead>
        <tbody>{schema.differences.map(({ expected, actual, issues }) =>
          <tr key={`${expected?.position ?? 0}-${actual?.position ?? 0}`}>
            <th scope="row"><code>{expected?.name ?? actual?.name ?? "无法显示列名"}</code>
              <small>{issues.includes("ORDER") ? `预期第 ${expected?.position} 列 · 实际第 ${actual?.position} 列`
                : actual ? `实际第 ${actual.position} 列` : `预期第 ${expected?.position} 列`}</small></th>
            <td data-label="预期类型">{expected ? <code>{expected.type}</code> : "无"}</td>
            <td data-label="实际类型">{actual?.type ? <code>{actual.type}</code> : actual ? "无法显示类型" : "缺失"}</td>
            <td data-label="差异">{issues.map(issue => labels[issue]).join("、")}</td>
          </tr>)}</tbody>
      </table></div>}
    {schema.protocol === "shuduo-sync-sql-output-schema/v1" && <FrozenSourceSchema evidence={schema.inputMetadata} />}
  </section>;
}
