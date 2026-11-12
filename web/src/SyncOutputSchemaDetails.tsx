import React from "react";
import type { SyncSqlOutputSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";

const labels = { MISSING:"缺少字段", TYPE:"类型不同", ORDER:"顺序不同", DUPLICATE:"字段重复", EXTRA:"多余字段" };

export function SyncOutputSchemaDetails({ schema, dirty }: { schema:SyncSqlOutputSchema; dirty:boolean }) {
  if (schema.status === "MATCHED") return null;
  return <section className="agent-dev-output-schema" aria-label="输出结构差异">
    <h4>输出结构差异</h4>
    <p>运行 {schema.source.runId.slice(0,8)} · 版本 {schema.source.revisionId.slice(0,8)}
      {dirty && " · 当前草稿尚未核验"}</p>
    {schema.status === "UNAVAILABLE" ? <p>原运行没有可核对的 Spark 列结构。</p> :
      <div className="agent-dev-table-scroll"><table aria-label="预期和实际 Spark 输出">
        <thead><tr><th scope="col">字段</th><th scope="col">预期类型</th><th scope="col">实际类型</th><th scope="col">差异</th></tr></thead>
        <tbody>{schema.differences.map(({ expected, actual, issues }) =>
          <tr key={`${expected?.position ?? 0}-${actual?.position ?? 0}`}>
            <th scope="row"><code>{expected?.name ?? actual?.name ?? "无法显示列名"}</code>
              <small>{issues.includes("ORDER") ? `预期第 ${expected?.position} 列 · 实际第 ${actual?.position} 列`
                : actual ? `实际第 ${actual.position} 列` : `预期第 ${expected?.position} 列`}</small></th>
            <td>{expected ? <code>{expected.type}</code> : "无"}</td>
            <td>{actual?.type ? <code>{actual.type}</code> : actual ? "无法显示类型" : "缺失"}</td>
            <td>{issues.map(issue => labels[issue]).join("、")}</td>
          </tr>)}</tbody>
      </table></div>}
  </section>;
}
