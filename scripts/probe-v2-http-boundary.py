"""One bounded read-only HTTP probe. Official Alibaba signer, no redirects/log bodies."""
import datetime
import hashlib
import http.client
import json
import os
import re
import sys
from urllib.parse import urlsplit, parse_qsl


def response_evidence(status, raw):
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
    return {'status': status, 'code': code, 'bytes': len(raw), 'responseHash': hashlib.sha256(raw).hexdigest(),
            'gatewayCategory': diagnostic,
            'authenticationRejected': status == 400 and code == 'MissingRequiredHeader' and missing_authorization,
            'privateProtocol': b'shuduo-v2-private-smoke' in raw}


def main():
    from alibabacloud_openapi_util.client import Client as Signer
    from Tea.request import TeaRequest
    data = json.load(sys.stdin)
    endpoint, probe = urlsplit(data['url']), data['probe']
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
        print(json.dumps({**response_evidence(response.status, raw), **tls}))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('HTTP_PROBE_UNCONFIRMED', file=sys.stderr)
        sys.exit(1)
