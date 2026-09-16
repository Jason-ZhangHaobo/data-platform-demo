import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const invalid = (code, message) =>
  Object.assign(new Error(message), { status: 400, code });

// Check transport/storage safety, not provider authenticity. A key is opaque:
// do not infer its plan, permissions or validity from its length or segments.
export function normalizeModelKey(value) {
  if (typeof value !== "string" || !value.trim())
    throw invalid(
      "MODEL_KEY_EMPTY",
      "未保存：输入框为空，请粘贴完整的模型 API Key。",
    );
  let key = value.trim();
  if (key.length > 8192)
    throw invalid(
      "MODEL_KEY_TOO_LONG",
      "未保存：内容超过安全输入上限。请只复制 API Key，不要复制整页或整段配置。",
    );
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  )
    key = key.slice(1, -1).trim();
  if (/[*•●…]/.test(key) || key.includes("..."))
    throw invalid(
      "MODEL_KEY_MASKED",
      "未保存：输入含星号或省略号，看起来是脱敏展示值。请使用创建成功时保存的完整密钥，不要复制列表中的掩码。",
    );
  if (key.startsWith("LTAI"))
    throw invalid(
      "MODEL_KEY_WRONG_KIND",
      "未保存：这是云账号 AccessKey ID，不是百炼模型 API Key。请打开下方百炼 API Key 页面获取模型密钥。",
    );
  if (!key.startsWith("sk-"))
    throw invalid(
      "MODEL_KEY_PREFIX",
      "未保存：内容不是以 sk- 开头的模型密钥。请只粘贴 Key 本身，不要附带 API Host、Bearer、curl 或整段 JSON。",
    );
  if (/[\s\u200B-\u200D\u2060\uFEFF]/.test(key))
    throw invalid(
      "MODEL_KEY_WHITESPACE",
      "未保存：密钥中间含空白、换行或不可见字符。首尾空白会自动清理，请重新复制完整的单行 Key。",
    );
  if (!/^sk-[A-Za-z0-9._~+/=-]+$/.test(key))
    throw invalid(
      "MODEL_KEY_CHARACTERS",
      "未保存：输入含密钥之外的符号。请只复制完整 Key；若带有引号，请确认没有混入说明文字。",
    );
  return key;
}

// Local developer setup only. The cloud identity/secret manager is a separate gate.
export async function saveLocalModelKey(root, env, key) {
  key = normalizeModelKey(key);
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
