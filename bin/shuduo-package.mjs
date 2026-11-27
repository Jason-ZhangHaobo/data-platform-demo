#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  unpackDeliveryPackage,
  loadDeliveryDirectory,
  resolveDeliverySchedule,
} from "../src/v2/delivery.mjs";
import { verifyDeliveryDirectory } from "../src/v2/delivery-runner.mjs";
import { runtimeConfig } from "../src/v2/spark.mjs";
import { comparePublicationFiles, maxReviewJsonBytes } from "../src/v2/publication-file-comparison.mjs";

const args = process.argv.slice(2),
  command = args[0],
  target = args[1];
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
try {
  if (!["unpack", "plan", "run", "compare"].includes(command) || !target) {
    console.log(
      "交付包 CLI（只做本机演练，不发布）\n" +
        "compare 本次包.json --baseline 对照包.json [--digest 本次摘要] [--baseline-digest 对照摘要]\n" +
        "unpack bundle.json --output 新目录 --digest 可信摘要\n" +
        "plan 交付目录 --digest 可信摘要 --scheduled-for 2026-09-11T09:00:00+08:00\n" +
        "run 交付目录 --digest 可信摘要 --scheduled-for 2026-09-11T09:00:00+08:00\n" +
        "可信摘要从本机平台的交付包记录取得；本工具不会创建云资源。",
    );
    process.exitCode = command === "help" || !command ? 0 : 2;
  } else {
    const digest = option("--digest"),
      directory = resolve(target);
    if (command === "compare") {
      const allowed=new Set(["--baseline","--digest","--baseline-digest"]);
      for(let index=2;index<args.length;index+=2){
        if(!allowed.delete(args[index]) || !args[index+1] || args[index+1].startsWith("--"))
          throw Error("请提供对照包路径和可选的完整摘要");
      }
      const baseline=option("--baseline");
      if(!baseline)throw Error("请选择 --baseline 对照包 JSON");
      const read=path=>{
        const info=statSync(path);
        if(!info.isFile() || info.size>maxReviewJsonBytes)throw Error("请选择不超过 6 MiB 的交付包 JSON 文件");
        const content=readFileSync(path,"utf8");
        try{return JSON.parse(content);}
        catch{throw Error("无法解析所选文件，请选择数舵导出的交付包 JSON");}
      };
      console.log(JSON.stringify(await comparePublicationFiles(read(baseline),read(target),
        {baselineDigest:option("--baseline-digest"),currentDigest:digest}),null,2));
    } else if (command === "unpack") {
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
