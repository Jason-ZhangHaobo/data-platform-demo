import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createOssRequest } from "../../src/v2/oss-client.mjs";
test("OSS create-only PUT signs the native no-overwrite header, including temporary-token ordering",()=>{
  const r=createOssRequest({method:"PUT",bucket:"synthetic",key:"jobs/one.json",endpoint:"oss-cn-hangzhou.aliyuncs.com",body:"{}",ifNoneMatch:"*",credentials:{accessKeyId:"id",accessKeySecret:"secret",securityToken:"token"}});
  assert.equal(r.options.headers["x-oss-forbid-overwrite"],"true");
  assert.equal(r.options.headers["If-None-Match"],undefined);
  const expected=`PUT\n\napplication/json; charset=utf-8\n${r.options.headers.Date}\nx-oss-forbid-overwrite:true\nx-oss-security-token:token\n/synthetic/jobs/one.json`;
  assert.equal(r.options.headers.Authorization,`OSS id:${createHmac("sha1","secret").update(expected).digest("base64")}`);
});

test("OSS create-only signing works without an STS token", () => {
  const request = createOssRequest({
    method: "PUT", bucket: "synthetic", key: "jobs/one.json",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com/", body: "{}",
    ifNoneMatch: "*", credentials: { accessKeyId: "id", accessKeySecret: "secret" },
  });
  assert.equal(request.options.headers["x-oss-forbid-overwrite"], "true");
  assert.equal(request.options.headers["x-oss-security-token"], undefined);
  assert.match(request.stringToSign, /\nx-oss-forbid-overwrite:true\n\/synthetic\/jobs\/one.json$/);
});

test("OSS reads retain conditional GET semantics without a write header", () => {
  const request = createOssRequest({
    method: "GET", bucket: "synthetic", key: "jobs/one.json",
    endpoint: "oss-cn-hangzhou.aliyuncs.com", ifNoneMatch: '"cached"',
    credentials: { accessKeyId: "id", accessKeySecret: "secret" },
  });
  assert.equal(request.options.headers["If-None-Match"], '"cached"');
  assert.equal(request.options.headers["x-oss-forbid-overwrite"], undefined);
});
