import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("ingestion UI reflects actual server MySQL capability and never labels snapshot diff as CDC", async () => {
  const workbench = await readFile(
      new URL("../../web/src/IngestionWorkbench.tsx", import.meta.url),
      "utf8",
    ),
    main = await readFile(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /serverMysqlSyncEnabled=\{status\?\.ingestion\?\.serverMysql\?\.supportsOfflineSync === true\}/);
  assert.match(workbench, /source\.currentMetadataId && source\.supportsOfflineSync/);
  assert.match(workbench, /快照差异UPSERT（非CDC）/);
  assert.match(workbench, /可创建离线同步/);
  assert.match(workbench, /仅连接与元数据/);
  assert.doesNotMatch(workbench, /首期仅测试连接和采集元数据，不开放同步执行/);
});
