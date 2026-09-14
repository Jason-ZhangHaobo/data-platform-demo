#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  unpackDeliveryPackage,
  loadDeliveryDirectory,
  resolveDeliverySchedule,
} from "../src/v2/delivery.mjs";
import { verifyDeliveryDirectory } from "../src/v2/delivery-runner.mjs";
import { runtimeConfig } from "../src/v2/spark.mjs";

const args = process.argv.slice(2),
  command = args[0],
  target = args[1];
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
try {
  if (!["unpack", "plan", "run"].includes(command) || !target) {
    console.log(
      "交付包 CLI（只做本机演练，不发布）\n" +
        "unpack bundle.json --output 新目录 --digest 可信摘要\n" +
        "plan 交付目录 --digest 可信摘要 --scheduled-for 2026-09-11T09:00:00+08:00\n" +
        "run 交付目录 --digest 可信摘要 --scheduled-for 2026-09-11T09:00:00+08:00\n" +
        "可信摘要从本机平台的交付包记录取得；本工具不会创建云资源。",
    );
    process.exitCode = command === "help" || !command ? 0 : 2;
  } else {
    const digest = option("--digest"),
      directory = resolve(target);
    if (command === "unpack") {
      const output = option("--output");
      if (!output) throw new Error("需要 --output 新目录；不会覆盖现有目录");
      const bundle = JSON.parse(readFileSync(directory, "utf8"));
      console.log(
        JSON.stringify({
          directory: unpackDeliveryPackage(bundle, output, digest),
          digest,
          published: false,
        }),
      );
    } else if (command === "plan") {
      const { plan } = loadDeliveryDirectory(directory, digest);
      console.log(
        JSON.stringify(
          {
            occurrence: resolveDeliverySchedule(
              plan,
              option("--scheduled-for"),
            ),
            order: plan.order,
            adapter: plan.deployment.adapter,
            executed: false,
            published: false,
          },
          null,
          2,
        ),
      );
    } else {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      const result = await verifyDeliveryDirectory(
        {
          directory,
          expectedDigest: digest,
          scheduledFor: option("--scheduled-for"),
        },
        { runtime: runtimeConfig(process.env, root) },
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "SUCCEEDED") process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
