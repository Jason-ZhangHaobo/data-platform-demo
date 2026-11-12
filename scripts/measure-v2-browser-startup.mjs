import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readCheckpoint } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { inspectedControlEntryScript, WEB_INDEX_LIMIT, WEB_ENTRY_SCRIPT_LIMIT } from "./control-web-entry.mjs";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const digest = /^[a-f0-9]{64}$/;
const browserNames = new Set(["safari", "chrome"]);
const fail = code => Object.assign(Error(code), { code });
function requireCondition(condition, code) {
  if (!condition) throw fail(code);
}
function checkedOrigin(value, driver = false) {
  let url;
  try { url = new URL(value); } catch { throw fail("BROWSER_ORIGIN_INVALID"); }
  requireCondition(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "BROWSER_ORIGIN_INVALID");
  requireCondition(driver ? url.protocol === "http:" && loopback.has(url.hostname) && url.port
    : url.protocol === "https:" || url.protocol === "http:" && loopback.has(url.hostname), "BROWSER_ORIGIN_INVALID");
  return url;
}

export async function openStartupWebDriver({ driver, browser, fetchImpl = fetch }) {
  const base = checkedOrigin(driver, true).origin;
  requireCondition(browserNames.has(browser), "BROWSER_NAME_INVALID");
  const command = async (method, path, body, timeoutMs = 40000) => {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method, redirect:"error", signal:AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : {headers:{"content-type":"application/json"},body:JSON.stringify(body)}),
      });
    } catch { throw fail("WEBDRIVER_TRANSPORT_FAILED"); }
    if (method === "DELETE" && response.ok) return undefined;
    const result = await response.json().catch(() => undefined);
    requireCondition(response.ok && result && Object.hasOwn(result,"value") && !result.value?.error, "WEBDRIVER_COMMAND_FAILED");
    return result.value;
  };
  const created = await command("POST","/session",{
    capabilities:{alwaysMatch:{browserName:browser,pageLoadStrategy:"eager",acceptInsecureCerts:false}},
  });
  const {sessionId, capabilities} = created ?? {};
  requireCondition(typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(sessionId),"WEBDRIVER_SESSION_INVALID");
  const session = "/session/" + sessionId;
  const close = () => command("DELETE",session,undefined,5000);
  try {
    requireCondition(typeof capabilities?.browserName === "string" && capabilities.browserName.toLowerCase() === browser &&
      typeof capabilities.browserVersion === "string" && /^[A-Za-z0-9_. -]{1,80}$/.test(capabilities.browserVersion) &&
      capabilities.acceptInsecureCerts !== true, "WEBDRIVER_BROWSER_MISMATCH");
    await command("POST",session+"/timeouts",{script:30000,pageLoad:30000});
    return {
      browser:{name:browser,version:capabilities.browserVersion},
      navigate:url=>command("POST",session+"/url",{url}),
      refresh:()=>command("POST",session+"/refresh",{}),
      execute:(script,args)=>command("POST",session+"/execute/async",{script,args}),
      close,
    };
  } catch (error) {
    await close().catch(()=>{});
    throw error;
  }
}

function observeInPage(expectedUrl, expectedScript, previousTimeOrigin, done) {
  const deadline = performance.now() + 12000;
  const timing = performance.getEntriesByType("navigation")[0];
  const samples = { timeOrigin:performance.timeOrigin, htmlFirstByteMs:Math.round(timing?.responseStart ?? 0),
    viewport:{width:innerWidth,height:innerHeight} };
  let selected, initialDefinition;
  function tick() {
    if (location.href !== expectedUrl || performance.timeOrigin === previousTimeOrigin)
      return done({...samples,status:"NAVIGATION_NOT_CONFIRMED"});
    if (![...document.scripts].some(script => script.src === expectedScript))
      return done({...samples,status:"ENTRY_SCRIPT_MISMATCH"});
    const picker = document.querySelector('select[aria-label="Agent 验证数据"]');
    const panel = picker?.closest(".agent-startup-preview, .agent-dev");
    const task = panel && [...panel.querySelectorAll("button")].find(button => button.textContent.trim() === "新建任务");
    const preview = panel?.classList.contains("agent-startup-preview");
    const definition = (preview ? panel?.querySelector("p:last-child")
      : panel?.querySelector(".agent-dev-context > p"))?.textContent?.trim();
    if (picker && task?.disabled && definition && definition !== "正在加载数据上下文…") {
      if (!selected && !picker.disabled && scrollY === 0) {
        const box = picker.getBoundingClientRect();
        const fits = box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 &&
          box.right <= innerWidth && box.bottom <= innerHeight;
        const center = fits && document.elementFromPoint(box.left + box.width/2,box.top + box.height/2) === picker;
        const to = picker.value === "stock-cash-t1" ? "holdings-t1" : "stock-cash-t1";
        if (center && [...picker.options].some(option=>option.value===to && !option.disabled)) {
          selected = { from:picker.value,to,selectableMs:Math.round(performance.now()),stage:preview ? "PUBLIC_PREVIEW" : "WORKBENCH" };
          initialDefinition = definition;
          picker.value = to;
          picker.dispatchEvent(new Event("change",{bubbles:true}));
        }
      } else if (selected && picker.value === selected.to && definition !== initialDefinition) {
        selected.changedMs ??= Math.round(performance.now());
        if (!preview && document.body.innerText.includes("公开访客") &&
            panel.querySelector(".agent-dev-boundary")?.textContent.includes("只读验收"))
          return done({...samples,...selected,status:"OBSERVED",guestReadOnly:true,contextsEndMs:
            Math.round(performance.getEntriesByName(location.origin+"/api/v2/contexts")[0]?.responseEnd ?? 0)});
      }
    }
    if (performance.now() >= deadline) return done({...samples,...selected,status:selected ? "SELECTION_OR_GUEST_UNCONFIRMED" : "FIRST_SCREEN_UNCONFIRMED"});
    setTimeout(tick,50);
  }
  tick();
}

async function checkEntryInPage(expectedUrl, entry, htmlLimit, scriptLimit, done) {
  if (location.href !== expectedUrl) return done({status:"NAVIGATION_NOT_CONFIRMED",requests:0});
  let requests = 0;
  const matches = async (path, limit, expected, mime) => {
    requests++;
    const response = await fetch(path,{credentials:"omit",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000)});
    if (response.status !== 200 || !mime.test(response.headers.get("content-type") ?? "") ||
        Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      return false;
    }
    const buffer = new Uint8Array(limit), reader=response.body?.getReader();
    let bytes = 0;
    if (!reader) return false;
    try {
      for (;;) {
        const {done:ended,value} = await reader.read();
        if (ended) break;
        if (bytes + value.length > limit) { await reader.cancel(); return false; }
        buffer.set(value,bytes); bytes += value.length;
      }
    } finally { reader.releaseLock(); }
    if (bytes !== expected.bytes) return false;
    const hash = await crypto.subtle.digest("SHA-256",buffer.subarray(0,bytes));
    return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,"0")).join("") === expected.digest;
  };
  try {
    const htmlMatches = await matches("/v2/",htmlLimit,entry.html,/^text\/html(?:;|$)/i);
    const scriptMatches = htmlMatches && await matches(entry.script.path,scriptLimit,entry.script,/^(?:text|application)\/javascript(?:;|$)/i);
    done({status:htmlMatches && scriptMatches ? "MATCHED" : "MISMATCH",requests,htmlMatches,scriptMatches});
  } catch { done({status:"UNCONFIRMED",requests}); }
}

export async function measureAgentStartup(session, { origin, networkLabel, entry }) {
  const url = checkedOrigin(origin), expectedUrl = url.origin + "/v2/?module=agent-center";
  requireCondition(typeof networkLabel === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(networkLabel),"BROWSER_NETWORK_LABEL_INVALID");
  requireCondition(/^\/v2\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(entry?.script?.path) &&
    /^[a-f0-9]{40}$/.test(entry?.source) &&
    [ [entry?.html, WEB_INDEX_LIMIT], [entry?.script, WEB_ENTRY_SCRIPT_LIMIT] ].every(([file, limit]) =>
      digest.test(file?.digest) && Number.isSafeInteger(file?.bytes) && file.bytes > 0 && file.bytes <= limit),
    "BROWSER_INSPECTION_INVALID");
  const invoke = (fn,args) => session.execute(`(${fn.toString()})(...arguments)`,args);
  const reads = [];
  await session.navigate(expectedUrl);
  for (const visit of ["FIRST","REVISIT"]) {
    if (visit === "REVISIT") await session.refresh();
    const view = await invoke(observeInPage,[expectedUrl,url.origin+entry.script.path,reads.at(-1)?.timeOrigin ?? null]);
    requireCondition(view && ["OBSERVED","NAVIGATION_NOT_CONFIRMED","ENTRY_SCRIPT_MISMATCH",
      "SELECTION_OR_GUEST_UNCONFIRMED","FIRST_SCREEN_UNCONFIRMED"].includes(view.status),"BROWSER_SAMPLE_INVALID");
    const {status,timeOrigin,htmlFirstByteMs,viewport,from,to,selectableMs,changedMs,stage,guestReadOnly,contextsEndMs}=view;
    requireCondition(Number.isFinite(timeOrigin) && timeOrigin>0 && Number.isFinite(htmlFirstByteMs) && htmlFirstByteMs>=0 &&
      Number.isInteger(viewport?.width) && viewport.width>0 && Number.isInteger(viewport?.height) && viewport.height>0 &&
      (status!=="OBSERVED" || timeOrigin!==reads.at(-1)?.timeOrigin && guestReadOnly===true &&
        typeof from==="string" && /^[a-z0-9-]{1,100}$/.test(from) &&
        ["stock-cash-t1","holdings-t1"].includes(to) && from!==to && ["PUBLIC_PREVIEW","WORKBENCH"].includes(stage) &&
        Number.isFinite(selectableMs) && selectableMs>=htmlFirstByteMs && Number.isFinite(changedMs) && changedMs>=selectableMs &&
        Number.isFinite(contextsEndMs) && contextsEndMs>=0),
    "BROWSER_SAMPLE_INVALID");
    reads.push({visit,status,timeOrigin,htmlFirstByteMs,viewport:{width:viewport?.width,height:viewport?.height},
      from,to,selectableMs,changedMs,stage,guestReadOnly,contextsEndMs});
  }
  const checked = await invoke(checkEntryInPage,[expectedUrl,entry,WEB_INDEX_LIMIT,WEB_ENTRY_SCRIPT_LIMIT]);
  requireCondition(checked && ["MATCHED","MISMATCH","UNCONFIRMED","NAVIGATION_NOT_CONFIRMED"].includes(checked.status) &&
    Number.isInteger(checked.requests) && checked.requests >= 0 && checked.requests <= 2,"BROWSER_SAMPLE_INVALID");
  const entryReadback = {status:checked.status,requests:checked.requests,htmlMatches:checked.htmlMatches,scriptMatches:checked.scriptMatches};
  const targetMet = entryReadback.status==="MATCHED" && entryReadback.requests===2 &&
    entryReadback.htmlMatches===true && entryReadback.scriptMatches===true &&
    reads.every(view=>view.status==="OBSERVED" &&
    view.guestReadOnly===true && Number.isFinite(view.changedMs) && view.changedMs>0 && view.changedMs<=3000);
  return {
    protocol:"shuduo-v2-browser-startup-sample/v1",scope:loopback.has(url.hostname)?"LOOPBACK_DIAGNOSTIC":"HTTPS_TIMING_SAMPLE",
    browser:session.browser,origin:url.origin,networkLabel,entry,reads,entryReadback,threeSecondTargetMet:targetMet,
  };
}

function verifiedEntry(inspectionFile, zipFile) {
  const {state:inspection} = readCheckpoint(inspectionFile,{privateFile:true});
  requireCondition(inspection?.protocol==="shuduo-control-artifact-inspection/v1" && inspection.zipValid===true &&
    inspection.sensitivePaths===0 && digest.test(inspection.sha256) && digest.test(inspection.webIndexSha256) &&
    /^[a-f0-9]{40}$/.test(inspection.applicationSource) &&
    Number.isSafeInteger(inspection.bytes) && inspection.bytes>0 && inspection.bytes<=67108864 &&
    Number.isSafeInteger(inspection.webIndexBytes) && inspection.webIndexBytes>0 && inspection.webIndexBytes<=WEB_INDEX_LIMIT,"BROWSER_INSPECTION_INVALID");
  return {source:inspection.applicationSource,html:{bytes:inspection.webIndexBytes,digest:inspection.webIndexSha256},
    script:inspectedControlEntryScript(zipFile,inspection)};
}

async function main() {
  const { values }=parseArgs({options:Object.fromEntries(
    ["driver","browser","origin","network-label","inspection-file","zip-file","out"].map(name=>[name,{type:"string"}]))});
  requireCondition(isAbsolute(values.out ?? "") && !existsSync(values.out),"BROWSER_REPORT_PATH_INVALID");
  checkedOrigin(values.origin);
  requireCondition(/^[A-Za-z0-9_-]{1,32}$/.test(values["network-label"] ?? ""),"BROWSER_NETWORK_LABEL_INVALID");
  const entry=verifiedEntry(values["inspection-file"],values["zip-file"]);
  const session=await openStartupWebDriver({driver:values.driver,browser:values.browser});
  let result;
  try { result=await measureAgentStartup(session,{origin:values.origin,networkLabel:values["network-label"],entry}); }
  finally { await session.close(); }
  writeFileSync(values.out,JSON.stringify(result,null,2)+"\n",{mode:0o600,flag:"wx"});
  process.stdout.write(JSON.stringify({scope:result.scope,browser:result.browser,threeSecondTargetMet:result.threeSecondTargetMet})+"\n");
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{process.stderr.write((error.code??"BROWSER_STARTUP_MEASUREMENT_FAILED")+"\n");process.exitCode=1;});
