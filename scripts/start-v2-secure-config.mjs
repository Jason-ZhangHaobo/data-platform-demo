import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPasswordHash } from "../src/v2/auth.mjs";
import { normalizeModelKey } from "../src/v2/model-credentials.mjs";

const DEFAULT_REPO = "Jason-ZhangHaobo/data-platform-demo";
const DEFAULT_ENVIRONMENT = "v2-staging";
const MAX_BODY_BYTES = 8192;
const PREPARE_MAX_BODY_BYTES = 16 * 1024;
const PREPARE_TTL_MS = 15 * 60 * 1000;
const PREPARE_FIELDS = ["mysql", "currentPassword", "password", "confirm", "modelKey"];
const PREPARE_NOTICE = "只准备，未修改数据库、登录密码、Secret 或云端配置，模型未调用。";
const prepareFailure = (message, status = 400) => Object.assign(new Error(message), { prepareMessage: message, status });
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

export function validatePreparedConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== PREPARE_FIELDS.length ||
      PREPARE_FIELDS.some(key => !Object.hasOwn(input, key) || typeof input[key] !== "string"))
    throw prepareFailure("只能填写数据库密码、当前登录密码、新登录密码及确认值、模型 Key，不能更改账号或提交其他字段");
  const categories = value => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(rule => rule.test(value)).length;
  if (!/^[\x21-\x7e]{8,32}$/.test(input.mysql) || categories(input.mysql) < 3)
    throw prepareFailure("数据库密码须为8—32位可见字符，包含大小写字母、数字、符号中的至少三类，不能含空白");
  if (input.currentPassword.length < 1 || input.currentPassword.length > 128)
    throw prepareFailure("当前登录密码须为1—128位，首尾空格会原样保留");
  if (input.password !== input.confirm) throw prepareFailure("两次登录密码不一致");
  if (input.password === input.currentPassword) throw prepareFailure("新登录密码不能与当前密码相同");
  if (input.mysql === input.password || input.mysql === input.currentPassword)
    throw prepareFailure("数据库新密码不能与当前或新的登录密码相同");
  let bootstrapPasswordHash;
  try { bootstrapPasswordHash = createPasswordHash(input.password); }
  catch { throw prepareFailure("新登录密码须为12—128位，至少包含三类字符，不能含控制字符"); }
  let modelKey;
  try { modelKey = normalizeModelKey(input.modelKey); }
  catch { throw prepareFailure("模型 Key 格式未通过；请填写完整 Key，不能使用掩码、云账号 AccessKey 或附带说明"); }
  return { mysql: input.mysql, currentPassword: input.currentPassword, password: input.password, modelKey, bootstrapPasswordHash };
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

function page({ completed, nonce, token, mysqlOnly, workflowStarted }) {
  const body = completed
    ? `<h1>已加密保存</h1><p>${mysqlOnly ? `数据库密码已提交，${workflowStarted ? "控制面同步已启动" : "但同步任务未启动，请返回对话继续，不必重复填写"}；保存成功不等于数据库连接已验证。数舵登录账号未改动。` : "三项配置已提交，受保护配置校验已自动启动。"}可以返回数舵继续后续部署。</p>`
    : `<span class="eyebrow">本机临时页面 · 仅用于本次部署</span>
      <h1>${mysqlOnly ? "更新数据库连接密码" : "补齐最后三项账号信息"}</h1>
      <p>内容仅通过本机 GitHub CLI 写入 <strong>v2-staging 加密 Secrets</strong>，不会进入聊天、Git 或浏览器历史。</p>
      ${mysqlOnly ? '<p>仅同步已有账号的连接密码，不会重置 RDS 密码，也不会更改你的数舵登录账号。</p>' : ''}
      <form id="setup">
        <label for="mysql">已有 platform_app 数据库密码</label><input id="mysql" type="password" autocomplete="off" minlength="8" maxlength="256" required>
        <small>填写此前为 platform_app 设置的密码；不会重置数据库账号。</small>
        ${mysqlOnly ? '' : `<label for="email">数舵管理员邮箱</label><input id="email" type="email" autocomplete="email" maxlength="254" required>
        <label for="password">设置数舵登录密码</label><input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
        <small>至少12位，包含大小写字母、数字、符号中的至少三类；与数据库密码分开。</small>
        <label for="confirm">再次输入数舵登录密码</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>`}
        <button id="save" type="submit">${mysqlOnly ? '加密保存并同步' : '加密保存并校验'}</button>
      </form><p id="result" role="status" aria-live="polite"></p>`;
  const script = completed
    ? ""
    : `<script nonce="${nonce}">
      const form=document.getElementById('setup'),save=document.getElementById('save'),result=document.getElementById('result');
      form.addEventListener('submit',async(event)=>{event.preventDefault();const mysql=document.getElementById('mysql'),email=document.getElementById('email'),password=document.getElementById('password'),confirm=document.getElementById('confirm');if(password&&password.value!==confirm.value){result.textContent='两次登录密码不一致';return}save.disabled=true;result.textContent='正在加密保存，请稍候…';try{const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify({mysql:mysql.value,...(email?{email:email.value,password:password.value,confirm:confirm.value}:{})})});const value=await response.json();if(!response.ok)throw new Error(value.error||'保存失败');mysql.value='';if(password)password.value='';if(confirm)confirm.value='';form.hidden=true;result.textContent=value.workflowStarted===false?'数据库密码已加密保存，但同步任务未启动。请返回对话继续，不必重复填写。':${JSON.stringify(mysqlOnly ? '数据库密码已加密保存，控制面同步已启动。连接结果仍待验证；数舵登录账号未改动。' : '已加密保存，配置校验已启动。')};result.append(document.createElement('br'),document.createTextNode('可以返回数舵继续后续验证。'))}catch(error){result.textContent=error instanceof TypeError?'无法连接本机配置服务，请回到对话获取仍有效的页面。不要将密码发到聊天。':error.message;save.disabled=false}});
    </script>`;
  return renderPage(body, script, nonce);
}

function renderPage(body, script, nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数舵 · 部署凭证</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f3f5f1;color:#18352d;font:16px system-ui,sans-serif}main{max-width:650px;margin:6vh auto;padding:36px;background:white;border:1px solid #dce4dc;border-radius:20px}h1{margin:10px 0 16px;font-size:30px}p,small{line-height:1.7;color:#53665c}.eyebrow{font-size:13px;color:#367958}label{display:block;margin:24px 0 8px;font-weight:600}input{width:100%;padding:13px;border:1px solid #b9cbbf;border-radius:9px;font:inherit}button{margin-top:28px;background:#14694c;color:white;border:0;border-radius:10px;padding:14px 20px;font:inherit;cursor:pointer}button:disabled{opacity:.55}#result{white-space:pre-line;margin-top:20px}</style><main>${body}</main>${script}</html>`;
}

function preparePage({ nonce, token, plannedEmail, status, preparedTtlMs }) {
  const escape = value => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const finished = status !== "EMPTY";
  const body = `<span class="eyebrow">本机临时页面 · 凭证轮换准备</span><h1>集中准备凭证</h1>
    <p>${PREPARE_NOTICE}</p><p>固定账号：<strong id="planned-email">${escape(plannedEmail)}</strong>。本页不创建或修改账号邮箱。</p>
    <p>内容仅在本进程内暂存，提交后最多保留${Math.ceil(preparedTtlMs / 60000)}分钟；过期或关闭服务后失效，不会永久保存。Worker 密钥不在此收取或生成。</p>
    ${finished ? `<p role="status">${status === "EXPIRED" ? "暂存已过期，内容已释放。" : status === "CONSUMED" ? "暂存已由进程内驱动领取，不能再次领取。" : "已在本机暂存，等待独立的执行授权。"}</p>` : `<form id="setup">
      <label for="mysql">自选数据库新密码</label><input id="mysql" type="password" autocomplete="new-password" minlength="8" maxlength="32" required><small>8—32位，至少三类字符；与登录密码分开。</small>
      <label for="currentPassword">当前数舵登录密码</label><input id="currentPassword" type="password" autocomplete="current-password" maxlength="128" required><small>首尾空格原样保留，仅在后续获准改密时使用。</small>
      <label for="password">自选数舵新登录密码</label><input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
      <label for="confirm">再次输入新登录密码</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
      <label for="modelKey">模型新 Key</label><input id="modelKey" type="password" autocomplete="off" maxlength="8192" required><small>只检查格式，不调用模型验证。</small>
      <button id="save" type="submit">仅校验并暂存本机</button></form><p id="result" role="status" aria-live="polite"></p>`}`;
  const script = finished ? "" : `<script nonce="${nonce}">
    const form=document.getElementById('setup'),save=document.getElementById('save'),result=document.getElementById('result');
    form.addEventListener('submit',async event=>{event.preventDefault();const fields=${JSON.stringify(PREPARE_FIELDS)},input=Object.fromEntries(fields.map(key=>[key,document.getElementById(key).value]));if(input.password!==input.confirm){result.textContent='两次登录密码不一致';return}save.disabled=true;result.textContent='正在本机校验…';try{const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${token}'},body:JSON.stringify(input)});const receipt=await response.json();if(!response.ok)throw new Error(receipt.error||'本机准备失败');for(const key of fields)document.getElementById(key).value='';form.hidden=true;result.textContent='已在本机暂存，等待独立的执行授权。${PREPARE_NOTICE} 暂存到期时间：'+receipt.expiresAt;}catch(error){result.textContent=error instanceof TypeError?'本机准备服务已停止，请返回对话。不要将密码发到聊天。':error.message;save.disabled=false}});
    </script>`;
  return renderPage(body, script, nonce);
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
  mysqlOnly = false,
  prepareOnly = false,
  plannedEmail,
  preparedTtlMs = PREPARE_TTL_MS,
  now = Date.now,
} = {}) {
  if (prepareOnly && (mysqlOnly || typeof plannedEmail !== "string" || plannedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plannedEmail) || !Number.isSafeInteger(preparedTtlMs) || preparedTtlMs < 1 || preparedTtlMs > 120 * 60 * 1000))
    throw new Error("准备模式必须指定固定账号和有效暂存期限，且不能同时启用数据库同步模式");
  const targetEmail = prepareOnly ? plannedEmail.toLowerCase() : undefined;
  const token = random(32).toString("hex");
  const nonce = random(18).toString("base64");
  let origin = "";
  let completed = false;
  let workflowStarted = false;
  let saving = false;
  let prepared, preparedReceipt, preparedStatus = "EMPTY", expirationTimer, closed = false;
  let responseSent = false;
  const preparedWaiters = new Set();
  const preparationUnavailable = () => new Error("本机准备已过期或服务已关闭，暂存不可领取");
  const releasePrepared = status => {
    prepared = undefined;
    clearTimeout(expirationTimer);
    expirationTimer = undefined;
    preparedStatus = status;
    responseSent = false;
    if (status === "EXPIRED") {
      for (const waiter of preparedWaiters) waiter.reject(preparationUnavailable());
      preparedWaiters.clear();
    }
  };
  const expirePrepared = () => {
    if (preparedStatus === "PREPARED" && now() >= Date.parse(preparedReceipt.expiresAt)) releasePrepared("EXPIRED");
  };
  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url ?? "").split("?")[0];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    if (req.headers.host !== new URL(origin).host)
      return reply(res, 403, { error: "只允许本机直接访问" });
    if (prepareOnly) expirePrepared();
    if (req.method === "GET" && pathname === "/") {
      res.setHeader("Set-Cookie", `shuduo_setup=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(prepareOnly ? preparePage({ nonce, token, plannedEmail: targetEmail, status: preparedStatus, preparedTtlMs }) :
        page({ completed, nonce, token, mysqlOnly, workflowStarted }));
      return;
    }
    if (req.method !== "POST" || pathname !== "/save")
      return reply(res, 404, { error: "页面不存在" });
    if (prepareOnly && preparedStatus === "EXPIRED") return reply(res, 410, { error: "本机暂存已过期，请重新启动准备入口" });
    if (saving || completed)
      return reply(res, 409, { error: prepareOnly ? "本次准备已提交或正在处理，不能重复提交" : completed ? "凭证已保存" : "正在保存，请稍候" });
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
        if (Buffer.byteLength(raw) > (prepareOnly ? PREPARE_MAX_BODY_BYTES : MAX_BODY_BYTES))
          throw prepareOnly ? prepareFailure("输入超出16 KiB限制", 413) : new Error("输入超出长度限制");
      }
      const input = JSON.parse(raw);
      if (prepareOnly) {
        prepared = { email: targetEmail, ...validatePreparedConfig(input) };
        const preparedAt = now();
        preparedReceipt = { ok: true, mode: "PREPARE_ONLY", status: "PREPARED_IN_MEMORY",
          fields: ["mysql", "currentPassword", "password", "modelKey"], preparedAt: new Date(preparedAt).toISOString(),
          expiresAt: new Date(preparedAt + preparedTtlMs).toISOString(), databaseChanged: false, loginChanged: false,
          secretsChanged: false, cloudChanged: false, modelCalled: false, workerSecretGenerated: false };
        preparedStatus = "PREPARED";
        expirationTimer = setTimeout(() => releasePrepared("EXPIRED"), preparedTtlMs);
        expirationTimer.unref();
        expirePrepared();
        if (closed || !server.listening || preparedStatus !== "PREPARED") throw prepareFailure("本机暂存已过期或服务已关闭", 410);
        completed = true;
        saving = false;
        // Notify only after the success response has been sent and the in-process
        // consumer is ready. Consumer failures cannot roll back a completed POST.
        res.once("finish", () => {
          expirePrepared();
          if (closed || preparedStatus !== "PREPARED") return;
          responseSent = true;
          for (const waiter of preparedWaiters) waiter.resolve(structuredClone(preparedReceipt));
          preparedWaiters.clear();
        });
        res.once("close", () => { if (!res.writableFinished) releasePrepared("EXPIRED"); });
        return reply(res, 200, preparedReceipt);
      }
      let values;
      if (mysqlOnly) {
        if (!input || typeof input.mysql !== 'string' || input.mysql.length < 8 || input.mysql.length > 256 || /[\r\n\u0000]/.test(input.mysql) || Object.keys(input).some(key => key !== 'mysql'))
          throw new Error('数据库密码格式不正确');
        values = { V2_MYSQL_PASSWORD: input.mysql };
      } else values = validateSecureConfig(input);
      for (const [name, value] of Object.entries(values))
        await ghRunner(["secret", "set", name, "--repo", repo, "--env", environment], value);
      if (mysqlOnly) {
        completed = true;
        try {
          await ghRunner(["workflow", "run", "sync-v2-control-mysql-secret.yml", "--repo", repo, "--ref", "main"]);
          workflowStarted = true;
        } catch { /* The secret is already saved; do not ask the user to re-enter it. */ }
        reply(res, 200, { ok: true, workflowStarted });
        return;
      }
      await ghRunner(["workflow", "run", "validate-v2-protected-config.yml", "--repo", repo, "--ref", "main"]);
      workflowStarted = true;
      completed = true;
      reply(res, 200, { ok: true });
    } catch (error) {
      if (prepareOnly) {
        releasePrepared(preparedStatus === "EXPIRED" || closed ? "EXPIRED" : "EMPTY");
        preparedReceipt = undefined;
        return reply(res, error.prepareMessage ? error.status : 400, { error: error.prepareMessage ?? "本机准备失败，请检查输入格式；未提交任何云端操作" });
      }
      reply(res, 400, {
        error: KNOWN_ERRORS.has(error.message)
          ? error.message
          : "登录密码至少12位，且需包含至少三类字符",
      });
    } finally {
      saving = false;
    }
  });
  server.once("close", () => { closed = true; releasePrepared("EXPIRED"); preparedReceipt = undefined; });
  return {
    server,
    waitUntilPrepared() {
      expirePrepared();
      if (!prepareOnly || closed || !server.listening || preparedStatus === "EXPIRED" || preparedStatus === "CONSUMED")
        return Promise.reject(preparationUnavailable());
      if (completed && !saving && responseSent && preparedStatus === "PREPARED") return Promise.resolve(structuredClone(preparedReceipt));
      return new Promise((resolve, reject) => preparedWaiters.add({ resolve, reject }));
    },
    consumePrepared() {
      expirePrepared();
      if (!prepareOnly || !completed || saving || !responseSent || closed || !server.listening || preparedStatus !== "PREPARED") {
        if (prepareOnly && !server.listening) releasePrepared("EXPIRED");
        throw new Error("没有可领取的本机暂存，内容可能已领取、过期或随服务关闭释放");
      }
      const value = prepared;
      releasePrepared("CONSUMED");
      return value;
    },
    listen() {
      return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          origin = `http://127.0.0.1:${server.address().port}`;
          resolve({ url: origin, expiresInMinutes: 120, containsSecrets: false,
            ...(prepareOnly ? { mode: "PREPARE_ONLY", preparedExpiresInMinutes: preparedTtlMs / 60000, cloudWrites: 0 } : {}) });
        }),
      );
    },
  };
}

async function run() {
  if (process.argv.includes('--prepare-only')) {
    process.stderr.write("准备模式仅供已审阅的同进程驱动通过 createSecureConfigServer 启动；独立 CLI 没有消费端，未启动填写页面。\n");
    process.exitCode = 1;
    return;
  }
  const entry = createSecureConfigServer({ mysqlOnly: process.argv.includes('--mysql-only') });
  const result = await entry.listen();
  process.stdout.write(JSON.stringify(result) + "\n");
  setTimeout(() => {
    entry.server.close();
    entry.server.closeAllConnections();
  }, 120 * 60 * 1000).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
