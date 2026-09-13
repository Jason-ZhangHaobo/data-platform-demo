import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Local developer setup only. The cloud identity/secret manager is a separate gate.
export async function saveLocalModelKey(root, env, key) {
  // Clipboard selections often include outer whitespace; never strip characters
  // inside a credential or permit multiline environment-variable injection.
  if (typeof key === "string") key = key.trim();
  if (typeof key !== "string" || !/^sk-[A-Za-z0-9_-]{20,240}$/.test(key)) {
    throw Object.assign(
      new Error(
        "未保存：请粘贴完整的百炼 API Key（sk- 开头），不要附带引号、说明文字或中间空白；云账号 AccessKey 不能代替模型 API Key",
      ),
      { status: 400 },
    );
  }
  const target = join(root, ".env.local");
  let existing = "";
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw Object.assign(new Error("本地配置必须是普通文件"), { status: 409 });
    }
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = existing
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?DASHSCOPE_API_KEY\s*=/.test(line));
  while (lines.at(-1) === "") lines.pop();
  lines.push("DASHSCOPE_API_KEY=" + key, "");
  const temporary = join(root, ".env.local." + randomUUID() + ".tmp");
  await writeFile(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
  env.DASHSCOPE_API_KEY = key;
  return { configured: true, connectionVerified: false };
}
