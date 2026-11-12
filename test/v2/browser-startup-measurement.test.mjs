import assert from "node:assert/strict";
import test from "node:test";
import { measureAgentStartup, openStartupWebDriver } from "../../scripts/measure-v2-browser-startup.mjs";

const driver = "http://127.0.0.1:9515";
const origin = "https://example.test";
const page = origin + "/v2/?module=agent-center";
const entry = {
  source: "a".repeat(40),
  html: { bytes: 470, digest: "b".repeat(64) },
  script: { path: "/v2/assets/index-fixture.js", bytes: 245000, digest: "c".repeat(64) },
};

function driverFixture(reportedBrowser) {
  const requests = [];
  const fetchImpl = async (url, { method, body }) => {
    const path = new URL(url).pathname;
    requests.push([method, path, body && JSON.parse(body)]);
    const value = path === "/session" ? {
      sessionId: "browser-fixture",
      capabilities: { browserName: reportedBrowser, browserVersion: "26.5", acceptInsecureCerts: false },
    } : null;
    return Response.json({ value });
  };
  return { fetchImpl, requests };
}

test("startup WebDriver uses an isolated local session with certificate validation", async () => {
  const { fetchImpl, requests } = driverFixture("Safari");
  const session = await openStartupWebDriver({ driver, browser: "safari", fetchImpl });
  assert.deepEqual(session.browser, { name: "safari", version: "26.5" });
  await session.navigate(page);
  await session.refresh();
  await session.execute("return arguments[0]", ["fixture"]);
  await session.close();
  assert.deepEqual(requests, [
    ["POST", "/session", { capabilities: { alwaysMatch: {
      browserName: "safari", pageLoadStrategy: "eager", acceptInsecureCerts: false,
    } } }],
    ["POST", "/session/browser-fixture/timeouts", { script: 30000, pageLoad: 30000 }],
    ["POST", "/session/browser-fixture/url", { url: page }],
    ["POST", "/session/browser-fixture/refresh", {}],
    ["POST", "/session/browser-fixture/execute/async", { script: "return arguments[0]", args: ["fixture"] }],
    ["DELETE", "/session/browser-fixture", undefined],
  ]);
});

test("wrong browser is closed and remote WebDriver never contacted", async () => {
  const { fetchImpl, requests } = driverFixture("chrome");
  await assert.rejects(openStartupWebDriver({ driver, browser: "safari", fetchImpl }), {
    code: "WEBDRIVER_BROWSER_MISMATCH",
  });
  assert.deepEqual(requests.map(([method, path]) => [method, path]), [
    ["POST", "/session"], ["DELETE", "/session/browser-fixture"],
  ]);
  await assert.rejects(openStartupWebDriver({ driver: "http://example.test:9515", browser: "chrome", fetchImpl }), {
    code: "BROWSER_ORIGIN_INVALID",
  });
  assert.equal(requests.length, 2);
});

const first = {
  status: "OBSERVED", timeOrigin: 100000, htmlFirstByteMs: 100, viewport: { width: 1200, height: 800 },
  from: "holdings-t1", to: "stock-cash-t1", selectableMs: 500, changedMs: 550, stage: "PUBLIC_PREVIEW",
  guestReadOnly: true, contextsEndMs: 320,
};
const revisit = { ...first, timeOrigin: 101000, stage: "WORKBENCH" };
const readback = { status: "MATCHED", requests: 2, htmlMatches: true, scriptMatches: true };

function sampleFixture(responses = [first, revisit, readback]) {
  const steps = [];
  const session = {
    browser: { name: "chrome", version: "152.0" },
    navigate: async url => { steps.push(["navigate", url]); },
    refresh: async () => { steps.push(["refresh"]); },
    execute: async (script, args) => {
      steps.push(["execute", args]);
      return responses.shift();
    },
  };
  return { session, steps };
}

test("both document visits use the same exact entry and only a readback match can pass", async () => {
  const { session, steps } = sampleFixture();
  const sample = await measureAgentStartup(session, { origin, networkLabel: "wifi", entry });
  assert.equal(sample.scope, "HTTPS_TIMING_SAMPLE");
  assert.equal(sample.threeSecondTargetMet, true);
  assert.deepEqual(sample.reads.map(view => [view.visit, view.stage]), [
    ["FIRST", "PUBLIC_PREVIEW"], ["REVISIT", "WORKBENCH"],
  ]);
  assert.deepEqual(steps.slice(0, 4), [
    ["navigate", page], ["execute", [page, origin + entry.script.path, null]],
    ["refresh"], ["execute", [page, origin + entry.script.path, first.timeOrigin]],
  ]);
  assert.deepEqual(steps[4][1].slice(0, 2), [page, entry]);
});

test("slow, incomplete, and wrong-byte samples do not pass the startup target", async () => {
  for (const responses of [
    [first, { ...revisit, changedMs: 3001 }, readback],
    [first, { ...revisit, status: "SELECTION_OR_GUEST_UNCONFIRMED" }, readback],
    [first, revisit, { ...readback, status: "MISMATCH", scriptMatches: false }],
    [first, revisit, { ...readback, requests: 1 }],
  ]) {
    const { session } = sampleFixture(responses);
    assert.equal((await measureAgentStartup(session, { origin, networkLabel: "wifi", entry })).threeSecondTargetMet, false);
  }
});

test("invalid navigation evidence and arbitrary entry paths are rejected", async () => {
  const { session, steps } = sampleFixture([first, first]);
  await assert.rejects(measureAgentStartup(session, { origin, networkLabel: "wifi", entry: {
    ...entry, script: { ...entry.script, path: "/v2/assets/../../api" },
  } }), { code: "BROWSER_INSPECTION_INVALID" });
  assert.equal(steps.length, 0);
  await assert.rejects(measureAgentStartup(session, { origin, networkLabel: "wifi", entry }), {
    code: "BROWSER_SAMPLE_INVALID",
  });
});
