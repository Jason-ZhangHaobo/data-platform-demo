#!/usr/bin/env node
import { createPasswordHash } from "../src/v2/auth.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > 512) {
    process.stderr.write("密码输入超过安全上限\n");
    process.exit(1);
  }
}
const password = input.replace(/\r?\n$/, "");
try {
  process.stdout.write(createPasswordHash(password) + "\n");
} catch (error) {
  process.stderr.write((error.message ?? "密码不符合要求") + "\n");
  process.exit(1);
}
