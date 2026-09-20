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

test("extracts only the bounded code from an OSS XML error", () => {
  const error = "<Error><Code>NoSuchKey</Code><Message>private</Message><RequestId>hidden</RequestId></Error>";
  assert.equal(extractAliyunErrorCode("", error), "NoSuchKey");
});

test("unknown or unsafe error text is reduced to a fixed non-sensitive code", () => {
  assert.equal(extractAliyunErrorCode("", "password=secret\nMessage: private endpoint"), "UNKNOWN_ALIYUN_ERROR");
  assert.equal(extractAliyunErrorCode("", "ErrorCode: bad/code"), "UNKNOWN_ALIYUN_ERROR");
});

test("extracts ossutil inline codes without disclosing messages or identifiers", () => {
  assert.equal(extractAliyunErrorCode("", "Error: operation error HeadObject: Error returned by Service.\nHttp Status Code: 404.\nError Code: NoSuchKey.\nRequest Id: hidden.\nMessage: private.\n"), "NoSuchKey");
  assert.equal(extractAliyunErrorCode("", "Error: operation error HeadObject: Status Code: 404, Code: NoSuchKey., Request Id: hidden, Message: private"), "NoSuchKey");
  assert.equal(extractAliyunErrorCode("", "Status Code: 403, Code: AccessDenied, Request Id: hidden"), "AccessDenied");
  for (const separator of [":", "="]) {
    assert.equal(extractAliyunErrorCode("", `Error: operation error HeadObject: StatusCode${separator}403, ErrorCode${separator}AccessDenied, ErrorMessage: private, RequestId: hidden`), "AccessDenied");
    assert.equal(extractAliyunErrorCode("", `StatusCode${separator}404, ErrorCode${separator}NoSuchKey`), "NoSuchKey");
  }
  assert.equal(extractAliyunErrorCode("ErrorCode=bad/code, Message: private"), "UNKNOWN_ALIYUN_ERROR");
});
