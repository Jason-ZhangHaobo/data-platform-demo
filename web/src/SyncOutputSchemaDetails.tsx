import React from "react";
import type { SyncSqlOutputSchema, SyncSqlRehearsalSchema, SyncSqlScheduledSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import "./sync-output-schema.css";

const labels = { MISSING:"缺少字段", TYPE:"类型不同", ORDER:"顺序不同", DUPLICATE:"字段重复", EXTRA:"多余字段" };

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
  </section>;
}
