import test from "node:test";
import assert from "node:assert/strict";
import { extractAliyunErrorCode } from "../../scripts/extract-aliyun-error-code.mjs";

test("extracts FunctionNotFound from Alibaba CLI stderr without returning surrounding details", () => {
  const stderr = [
    "ERROR: SDK.ServerError",
    "ErrorCode: FunctionNotFound",
    "RequestId: synthetic-request-id",
    "Message: function private-name does not exist",
  ].join("\n");
  assert.equal(extractAliyunErrorCode("", stderr), "FunctionNotFound");
});

test("extracts supported JSON error fields from stdout or stderr", () => {
  assert.equal(extractAliyunErrorCode('{"Code":"FunctionNotFound","RequestId":"hidden"}', ""), "FunctionNotFound");
  assert.equal(extractAliyunErrorCode("", '{"error_code":"AccessDenied","message":"hidden"}'), "AccessDenied");
});

test("unknown or unsafe error text is reduced to a fixed non-sensitive code", () => {
  assert.equal(extractAliyunErrorCode("", "password=secret\nMessage: private endpoint"), "UNKNOWN_ALIYUN_ERROR");
  assert.equal(extractAliyunErrorCode("", "ErrorCode: bad/code"), "UNKNOWN_ALIYUN_ERROR");
});
