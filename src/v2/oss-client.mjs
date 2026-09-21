import { createHmac } from "node:crypto";

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export function createOssRequest({
  method,
  bucket,
  key,
  endpoint,
  credentials,
  body,
  etag,
  ifNoneMatch,
}) {
  const date = new Date().toUTCString();
  const contentType = body === undefined ? "" : "application/json; charset=utf-8";
  const securityHeader = credentials.securityToken ? `x-oss-security-token:${credentials.securityToken}\n` : "";
  const canonicalResource = `/${bucket}/${key}`;
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${securityHeader}${canonicalResource}`;
  const signature = createHmac("sha1", credentials.accessKeySecret).update(stringToSign, "utf8").digest("base64");
  const headers = { Date: date, Authorization: `OSS ${credentials.accessKeyId}:${signature}` };
  if (contentType) headers["Content-Type"] = contentType;
  if (credentials.securityToken) headers["x-oss-security-token"] = credentials.securityToken;
  if (etag) headers["If-Match"] = etag;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { url: `https://${bucket}.${host}/${encodeKey(key)}`, options: { method, headers, body }, stringToSign };
}

export function ossConfigFromEnvironment(env = process.env) {
  const required = ["OSS_BUCKET", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`OSS 配置缺失：${missing.join(", ")}`);
  const region = env.FC_REGION ?? env.OSS_REGION ?? "cn-hangzhou";
  return {
    bucket: env.OSS_BUCKET,
    endpoint: env.OSS_ENDPOINT ?? `oss-${region}-internal.aliyuncs.com`,
    key: env.OSS_OBJECT_KEY ?? "data-platform-demo/store.json",
    credentials: {
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN,
    },
  };
}
