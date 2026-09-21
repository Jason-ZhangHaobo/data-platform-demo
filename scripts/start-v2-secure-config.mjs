import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPasswordHash } from "../src/v2/auth.mjs";

const DEFAULT_REPO = "Jason-ZhangHaobo/data-platform-demo";
const DEFAULT_ENVIRONMENT = "v2-staging";
const MAX_BODY_BYTES = 8192;
const KNOWN_ERRORS = new Set([
  "GitHub命令不可用",
  "GitHub加密保存失败，请稍后重试",
  "输入超出长度限制",
  "数据库密码格式不正确",
  "邮箱格式不正确",
  "两次登录密码不一致",
]);

export function validateSecureConfig(input = {}) {
  if (
    typeof input.mysql !== "string" ||
    input.mysql.length < 8 ||
    input.mysql.length > 256 ||
    /[\r\n\u0000]/.test(input.mysql)
  )
    throw new Error("数据库密码格式不正确");
  if (
    typeof input.email !== "string" ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
  )
    throw new Error("邮箱格式不正确");
  if (input.password !== input.confirm) throw new Error("两次登录密码不一致");
  return {
    V2_MYSQL_PASSWORD: input.mysql,
    V2_BOOTSTRAP_ADMIN_EMAIL: input.email.trim().toLowerCase(),
    V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: createPasswordHash(input.password),
  };
}

function realGhRunner(args, value = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => reject(new Error("GitHub命令不可用")));
    child.stdin.on("error", () => {});
    child.stdin.end(value);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("GitHub加密保存失败，请稍后重试")),
    );
  });
}

function page({ completed, nonce, token }) {
  const body = completed
    ? `<h1>已加密保存</h1><p>三项配置已提交，受保护配置校验已自动启动。可以返回数舵继续后续部署。</p>`
    : `<span class="eyebrow">本机临时页面 · 仅用于本次部署</span>
      <h1>补齐最后三项账号信息</h1>
      <p>内容仅通过本机 GitHub CLI 写入 <strong>v2-staging 加密 Secrets</strong>，不会进入聊天、Git 或浏览器历史。</p>
      <form id="setup">
        <label for="mysql">已有 platform_app 数据库密码</label><input id="mysql" type="password" autocomplete="off" minlength="8" maxlength="256" required>
        <small>填写此前为 platform_app 设置的密码；不会重置数据库账号。</small>
        <label for="email">数舵管理员邮箱</label><input id="email" type="email" autocomplete="email" maxlength="254" required>
        <label for="password">设置数舵登录密码</label><input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
        <small>至少12位，包含大小写字母、数字、符号中的至少三类；与数据库密码分开。</small>
        <label for="confirm">再次输入数舵登录密码</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
        <button id="save" type="submit">加密保存并校验</button>
      </form><p id="result" role="status" aria-live="polite"></p>`;
  const script = completed
    ? ""
    : `<script nonce="${nonce}">
      const form=document.getElementById('setup'),save=document.getElementById('save'),result=document.getElementById('result');
      form.addEventListener('submit',async(event)=>{event.preventDefault();const mysql=document.getElementById('mysql'),email=document.getElementById('email'),password=document.getElementById('password'),confirm=document.getElementById('confirm');if(password.value!==confirm.value){result.textContent='两次登录密码不一致';return}save.disabled=true;result.textContent='正在加密保存，请稍候…';try{const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify({mysql:mysql.value,email:email.value,password:password.value,confirm:confirm.value})});const value=await response.json();if(!response.ok)throw new Error(value.error||'保存失败');mysql.value='';password.value='';confirm.value='';form.hidden=true;result.textContent='已加密保存，配置校验已启动。';result.append(document.createElement('br'),document.createTextNode('可以返回数舵，后续部署会自动继续。'))}catch(error){result.textContent=error.message;save.disabled=false}});
    </script>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数舵 · 部署凭证</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f3f5f1;color:#18352d;font:16px system-ui,sans-serif}main{max-width:650px;margin:6vh auto;padding:36px;background:white;border:1px solid #dce4dc;border-radius:20px}h1{margin:10px 0 16px;font-size:30px}p,small{line-height:1.7;color:#53665c}.eyebrow{font-size:13px;color:#367958}label{display:block;margin:24px 0 8px;font-weight:600}input{width:100%;padding:13px;border:1px solid #b9cbbf;border-radius:9px;font:inherit}button{margin-top:28px;background:#14694c;color:white;border:0;border-radius:10px;padding:14px 20px;font:inherit;cursor:pointer}button:disabled{opacity:.55}#result{white-space:pre-line;margin-top:20px}</style><main>${body}</main>${script}</html>`;
}

function reply(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export function createSecureConfigServer({
  ghRunner = realGhRunner,
  repo = DEFAULT_REPO,
  environment = DEFAULT_ENVIRONMENT,
  random = randomBytes,
} = {}) {
  const token = random(32).toString("hex");
  const nonce = random(18).toString("base64");
  let origin = "";
  let completed = false;
  let saving = false;
  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url ?? "").split("?")[0];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    if (req.headers.host !== new URL(origin).host)
      return reply(res, 403, { error: "只允许本机直接访问" });
    if (req.method === "GET" && pathname === "/") {
      res.setHeader("Set-Cookie", `shuduo_setup=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page({ completed, nonce, token }));
      return;
    }
    if (req.method !== "POST" || pathname !== "/save")
      return reply(res, 404, { error: "页面不存在" });
    if (saving || completed)
      return reply(res, 409, { error: completed ? "凭证已保存" : "正在保存，请稍候" });
    if (
      req.headers.origin !== origin ||
      req.headers["x-setup-token"] !== token ||
      !req.headers.cookie?.split("; ").includes(`shuduo_setup=${token}`)
    )
      return reply(res, 403, { error: "请从本机页面提交" });
    if (req.headers["content-type"] !== "application/json")
      return reply(res, 415, { error: "请求格式错误" });
    saving = true;
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error("输入超出长度限制");
      }
      const values = validateSecureConfig(JSON.parse(raw));
      for (const [name, value] of Object.entries(values))
        await ghRunner(["secret", "set", name, "--repo", repo, "--env", environment], value);
      await ghRunner(["workflow", "run", "validate-v2-protected-config.yml", "--repo", repo, "--ref", "main"]);
      completed = true;
      reply(res, 200, { ok: true });
    } catch (error) {
      reply(res, 400, {
        error: KNOWN_ERRORS.has(error.message)
          ? error.message
          : "登录密码至少12位，且需包含至少三类字符",
      });
    } finally {
      saving = false;
    }
  });
  return {
    server,
    listen() {
      return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          origin = `http://127.0.0.1:${server.address().port}`;
          resolve({ url: origin, expiresInMinutes: 120, containsSecrets: false });
        }),
      );
    },
  };
}

async function run() {
  const entry = createSecureConfigServer();
  const result = await entry.listen();
  process.stdout.write(JSON.stringify(result) + "\n");
  setTimeout(() => {
    entry.server.close();
    entry.server.closeAllConnections();
  }, 120 * 60 * 1000).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
