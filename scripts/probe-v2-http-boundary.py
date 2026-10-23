"""One bounded read-only HTTP probe. Official Alibaba signer, no redirects/log bodies."""
import datetime
import hashlib
import http.client
import json
import os
import re
import sys
from urllib.parse import urlsplit, parse_qsl


def gateway_diagnostic(status, parsed, secrets=()):
    """Opt-in, bounded gateway error detail for encrypted diagnostic evidence."""
    allowed = {'errorCode', 'ErrorCode', 'code', 'Code', 'errorMessage', 'ErrorMessage', 'message', 'Message', 'RequestId', 'requestId', 'requestID'}
    if status not in (400, 401, 403) or not set(parsed).issubset(allowed):
        return None
    message = next((parsed[k] for k in ('errorMessage', 'ErrorMessage', 'message', 'Message') if isinstance(parsed.get(k), str)), '')
    if not message or 'PRIVATE KEY' in message or 'shuduo-v2-private-smoke' in message:
        return None
    for value in secrets:
        if value:
            message = message.replace(value, '[REDACTED]')
    message = re.sub(r'https?://[^\s<>"\']+|acs:[^\s<>"\']+', '[RESOURCE]', message, flags=re.I)
    message = re.sub(r'[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[EMAIL]', message)
    message = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b|\b\d{12,}\b|[A-Za-z0-9_+/=-]{32,}', '[IDENTIFIER]', message)
    message = re.sub(r'(?i)\b(password|secret|token|accesskeyid|accesskeysecret)\s*[:=]\s*[^\s,;]+', r'\1=[REDACTED]', message)
    message = re.sub(r'[\x00-\x1f\x7f]', ' ', message)
    request_id = next((parsed[k] for k in ('RequestId', 'requestId', 'requestID') if isinstance(parsed.get(k), str)), '')
    return {'message': message[:512], 'truncated': len(message) > 512,
            'requestIdHash': hashlib.sha256(request_id.encode()).hexdigest() if request_id else None}


def response_evidence(status, raw, include_diagnostic=False, secrets=()):
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    code = next((parsed[key] for key in ('errorCode', 'ErrorCode', 'code', 'Code') if isinstance(parsed.get(key), str)), '')
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,79}', code):
        code = 'UNCONFIRMED'
    message = next((parsed[key] for key in ('errorMessage', 'ErrorMessage', 'message', 'Message') if isinstance(parsed.get(key), str)), '')
    # FC documents HTTP 400 for MissingRequiredHeader. Recognize only the
    # missing Authorization header, never a generic 400 or malformed request.
    missing_authorization = bool(re.fullmatch(r'''required HTTP header ["'`]?Authorization["'`]? was not specified\.?''', message.strip(), re.IGNORECASE))
    # Fixed diagnostic categories only; never persist a message, header value,
    # URL, credential or a private application body. Categories do not relax
    # the acceptance predicate for InvalidArgument responses.
    diagnostic = 'UNCLASSIFIED'
    if re.search(r'(invalid|malformed|incorrect|parse|format).{0,50}(date|timestamp)|(date|timestamp).{0,50}(invalid|malformed|incorrect|parse|format)', message, re.IGNORECASE):
        diagnostic = 'INVALID_TIMESTAMP'
    elif re.search(r'(signature|signedheaders).{0,50}(invalid|mismatch|incorrect)|(invalid|mismatch|incorrect).{0,50}(signature|signedheaders)', message, re.IGNORECASE):
        diagnostic = 'INVALID_SIGNATURE'
    elif code == 'MissingRequiredHeader':
        diagnostic = 'MISSING_AUTHORIZATION' if missing_authorization else 'OTHER_REQUIRED_HEADER'
    elif re.search(r'(header|request|body).{0,50}(too (?:large|long)|exceed)', message, re.IGNORECASE):
        diagnostic = 'REQUEST_LIMIT'
    result = {'status': status, 'code': code, 'bytes': len(raw), 'responseHash': hashlib.sha256(raw).hexdigest(),
            'gatewayCategory': diagnostic,
            'authenticationRejected': status == 400 and code == 'MissingRequiredHeader' and missing_authorization,
            'privateProtocol': b'shuduo-v2-private-smoke' in raw}
    if include_diagnostic:
        result['gatewayDiagnostic'] = gateway_diagnostic(status, parsed, secrets)
    return result


def main():
    from alibabacloud_openapi_util.client import Client as Signer
    from Tea.request import TeaRequest
    data = json.load(sys.stdin)
    endpoint, probe = urlsplit(data['url']), data['probe']
    diagnose = data.get('diagnosticAuthorization') == 'THREE_READONLY_GATEWAY_PROBES' and os.environ.get('V2_HTTP_DIAGNOSTIC_AUTHORIZED') == 'THREE_READONLY_GATEWAY_PROBES'
    if probe.get('timestampMode') is not None and not (diagnose and probe.get('signed') is False and probe['timestampMode'] == 'omit'):
        raise ValueError('TIMESTAMP_DIAGNOSTIC_NOT_AUTHORIZED')
    custom_domain = (data.get('domainAuthorization') == 'ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED'
                     and endpoint.hostname == 'shuduoai.cn')
    if (endpoint.scheme != 'https' or not endpoint.hostname or not (endpoint.hostname.endswith('.cn-hangzhou.fcapp.run') or custom_domain)
            or endpoint.username or endpoint.password or endpoint.port or endpoint.path not in ('', '/')
            or endpoint.query or endpoint.fragment):
        raise ValueError('INVALID_ENDPOINT')
    method, path = probe['method'], probe['path']
    if method not in ('GET', 'POST') or not path.startswith('/') or any(c in path for c in '\r\n'):
        raise ValueError('INVALID_PROBE')
    body = b'{"operation":"PRIVATE_STATUS_V1"}' if method == 'POST' else b''
    headers = {'host': endpoint.hostname, 'content-type': 'application/octet-stream', 'content-length': str(len(body))}
    if probe.get('signed', True) is False:
        # Match the official ACS3 HTTP-trigger request shape: x-acs-date only.
        # Do not mix the legacy Date header with the modern timestamp scheme.
        now = datetime.datetime.now(datetime.timezone.utc)
        if probe.get('timestampMode') != 'omit':
            headers['x-acs-date'] = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    if probe.get('signed', True):
        aid, secret, token = (os.environ[name] for name in ('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'))
        headers.update({'x-acs-date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'x-acs-security-token': token})
        request = TeaRequest()
        request.method = method
        request.pathname = path.split('?', 1)[0]
        request.query = dict(parse_qsl(path.split('?', 1)[1] if '?' in path else ''))
        # Use the official HTTP-trigger signing input, separate from transport
        # Host/content headers. OpenAPI control-plane calls use a different,
        # fully hashed request construction in their dedicated transport.
        request.headers = {name: headers[name] for name in ('x-acs-date', 'x-acs-security-token')}
        headers['authorization'] = Signer.get_authorization(request, 'ACS3-HMAC-SHA256', '', aid, secret)
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=40)
    try:
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in list(headers.items()) + probe.get('headers', []):
            connection.putheader(key, value)
        connection.endheaders(body)
        tls = {'certificateSha256': hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest(),
               'tlsVersion': connection.sock.version()}
        response = connection.getresponse()
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('RESPONSE_TOO_LARGE')
        secrets = tuple(os.environ.get(name, '') for name in ('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'))
        print(json.dumps({**response_evidence(response.status, raw, diagnose, secrets), **tls}))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('HTTP_PROBE_UNCONFIRMED', file=sys.stderr)
        sys.exit(1)
