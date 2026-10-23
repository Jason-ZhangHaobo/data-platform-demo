"""One FC domain GET using the pinned official ACS3 signer; never print PEMs."""
import datetime
import hashlib
import http.client
import json
import os
import re
import sys
import uuid


def response_evidence(status, raw, target):
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    if status != 200:
        code = next((value[k] for k in ('Code', 'code', 'ErrorCode', 'errorCode') if isinstance(value.get(k), str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,99}', value[k])), '')
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,99}', code):
            code = 'DOMAIN_HTTP_UNCONFIRMED'
        return {'ok': False, 'status': status, 'code': code}
    route_config = value.get('routeConfig') or {}
    routes = route_config.get('routes') if isinstance(route_config, dict) else None
    if (value.get('domainName') != target['domainName'] or str(value.get('accountId')) != target['account']
            or not isinstance(routes, list) or len(routes) > 100):
        return {'ok': False, 'status': status, 'code': 'DOMAIN_RESPONSE_MISMATCH'}
    return {'ok': True, 'status': status, 'protocol': value.get('protocol') if value.get('protocol') in ('HTTP', 'HTTPS', 'HTTP,HTTPS') else 'UNCONFIRMED',
            'hasCertificate': isinstance(value.get('certConfig'), dict) and bool(value['certConfig'].get('certificate')), 'routeCount': len(routes),
            'allRoutesTargetConfiguredFunction': bool(routes) and all(isinstance(r, dict) and r.get('functionName') == target['functionName'] for r in routes)}


def main():
    from alibabacloud_openapi_util.client import Client as Signer
    from Tea.request import TeaRequest
    target = json.load(sys.stdin)
    if (target.get('domainName') != 'shuduoai.cn' or target.get('region') != 'cn-hangzhou'
            or not re.fullmatch(r'\d{12,20}', target.get('account', ''))
            or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{1,127}', target.get('functionName', ''))):
        raise ValueError('INVALID_TARGET')
    host = 'fcv3.cn-hangzhou.aliyuncs.com'
    path = '/2023-03-30/custom-domains/shuduoai.cn'
    payload_hash = hashlib.sha256(b'').hexdigest()
    headers = {'host': host, 'content-type': 'application/json', 'x-acs-action': 'GetCustomDomain', 'x-acs-version': '2023-03-30',
               'x-acs-date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'x-acs-signature-nonce': str(uuid.uuid4()), 'x-acs-content-sha256': payload_hash,
               'x-acs-security-token': os.environ['ALIBABA_CLOUD_SECURITY_TOKEN']}
    request = TeaRequest()
    request.method = 'GET'
    request.pathname = path
    request.query = {}
    request.headers = headers.copy()
    headers['authorization'] = Signer.get_authorization(request, 'ACS3-HMAC-SHA256', payload_hash,
                                                       os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'], os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'])
    connection = http.client.HTTPSConnection(host, timeout=20)
    try:
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('RESPONSE_TOO_LARGE')
        print(json.dumps(response_evidence(response.status, raw, target)))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'status': 0, 'code': 'DOMAIN_TRANSPORT_UNCONFIRMED'}))
