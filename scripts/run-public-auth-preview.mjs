#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetadataStore } from "../src/v2/store.mjs";
import { createV2Server } from "../src/v2/server.mjs";

const password = process.env.V2_PREVIEW_ADMIN_PASSWORD;
if (!password)
  throw new Error("请通过V2_PREVIEW_ADMIN_PASSWORD提供仅本次预览使用的强密码");
const port = Number(process.env.V2_PREVIEW_PORT ?? 3200),
  origin = `http://127.0.0.1:${port}`,
  tempRoot = mkdtempSync(join(tmpdir(), "shuzhan-public-auth-preview-")),
  store = new MetadataStore(join(tempRoot, "platform.sqlite")),
  app = createV2Server({
    root: resolve(process.cwd()),
    store,
    env: {
      ...process.env,
      V2_HOST: "127.0.0.1",
      V2_LOCAL_DEVELOPMENT: "false",
      V2_PUBLIC_ORIGIN: origin,
      V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true",
      V2_BOOTSTRAP_ADMIN_EMAIL: "admin@preview.local",
      V2_BOOTSTRAP_ADMIN_PASSWORD: password,
      V2_BOOTSTRAP_ADMIN_NAME: "预览管理员",
    },
  });
app.server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`Public auth preview ready on ${origin}/v2/\n`),
);
const close = () =>
  app.server.close(() => {
    store.close();
    process.exit(0);
  });
process.on("SIGINT", close);
process.on("SIGTERM", close);
