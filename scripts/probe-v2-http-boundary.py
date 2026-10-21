"""One bounded read-only HTTP probe. Official Alibaba signer, no redirects/log bodies."""
import datetime
import hashlib
import http.client
import json
import os
import sys
from urllib.parse import urlsplit, parse_qsl


def main():
    from alibabacloud_openapi_util.client import Client as Signer
    from Tea.request import TeaRequest
    data = json.load(sys.stdin)
    endpoint, probe = urlsplit(data['url']), data['probe']
    if (endpoint.scheme != 'https' or not endpoint.hostname.endswith('.cn-hangzhou.fcapp.run')
            or endpoint.username or endpoint.password or endpoint.port or endpoint.path not in ('', '/')
            or endpoint.query or endpoint.fragment):
        raise ValueError('INVALID_ENDPOINT')
    method, path = probe['method'], probe['path']
    if method not in ('GET', 'POST') or not path.startswith('/') or any(c in path for c in '\r\n'):
        raise ValueError('INVALID_PROBE')
    body = b'{"operation":"PRIVATE_STATUS_V1"}' if method == 'POST' else b''
    headers = {'host': endpoint.hostname, 'content-type': 'application/octet-stream', 'content-length': str(len(body))}
    if probe.get('signed', True):
        aid, secret, token = (os.environ[name] for name in ('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'))
        headers.update({'x-acs-date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'x-acs-security-token': token})
        request = TeaRequest()
        request.method = method
        request.pathname = path.split('?', 1)[0]
        request.query = dict(parse_qsl(path.split('?', 1)[1] if '?' in path else ''))
        request.headers = headers.copy()
        headers['authorization'] = Signer.get_authorization(request, 'ACS3-HMAC-SHA256', '', aid, secret)
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=40)
    try:
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for key, value in list(headers.items()) + probe.get('headers', []):
            connection.putheader(key, value)
        connection.endheaders(body)
        response = connection.getresponse()
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('RESPONSE_TOO_LARGE')
        try:
            parsed = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        code = parsed.get('code', parsed.get('Code', ''))
        if not isinstance(code, str) or not 0 < len(code) <= 80 or not all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789' for c in code):
            code = 'UNCONFIRMED'
        print(json.dumps({'status': response.status, 'code': code, 'bytes': len(raw), 'responseHash': hashlib.sha256(raw).hexdigest(), 'privateProtocol': parsed.get('protocol') == 'shuduo-v2-private-smoke/v1' or b'shuduo-v2-private-smoke' in raw}))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('HTTP_PROBE_UNCONFIRMED', file=sys.stderr)
        sys.exit(1)
