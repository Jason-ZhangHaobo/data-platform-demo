"""Fixed-domain FC transport. PEM input via stdin, never argv or diagnostics."""
import datetime
import hashlib
import http.client
import json
import os
import re
import sys
import uuid


def safe_response(status, raw, operation):
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    code = next((value[k] for k in ('code', 'Code', 'errorCode', 'ErrorCode')
                 if isinstance(value.get(k), str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,99}', value[k])), '')
    result = {'status': status, 'code': code or 'UNCONFIRMED'}
    # Fixed diagnostic category only; never export a provider message, which
    # can echo certificate material, credentials or request parameters.
    message = next((value[k] for k in ('message', 'Message', 'errorMessage', 'ErrorMessage')
                    if isinstance(value.get(k), str)), '')
    if code == 'InvalidArgument' and re.search(r'\bcipherSuites\b', message, re.I):
        result['category'] = 'INVALID_CIPHER_SUITES'
    if status == 200 and operation == 'get':
        result['value'] = {k: value[k] for k in ('domainName', 'accountId', 'protocol', 'routeConfig', 'tlsConfig', 'wafConfig', 'corsConfig') if k in value}
        auth = value.get('authConfig') or {}
        cert = value.get('certConfig') or {}
        result['value']['authConfig'] = {'authType': auth.get('authType'), 'authInfo': '{}' if auth.get('authInfo') in (None, '', '{}') else 'UNEXPECTED_AUTH_CONFIG'}
        result['value']['certConfig'] = {k: cert[k] for k in ('certName', 'certificate') if k in cert}
    return result


def request_shape(data):
    opening = data.get('authorization') in ('INVITED_READ_ONLY_OPENING_V2', 'INVITED_READ_ONLY_FILING_REPAIR')
    if data.get('authorization') not in ('ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED', 'INVITED_READ_ONLY_OPENING_V2', 'INVITED_READ_ONLY_FILING_REPAIR') or data.get('domainName') != 'shuduoai.cn':
        raise ValueError('INVALID_TARGET')
    operation = data.get('operation')
    if operation not in (('get', 'update') if opening else ('get', 'create', 'delete')):
        raise ValueError('INVALID_OPERATION')
    method = {'get': 'GET', 'create': 'POST', 'delete': 'DELETE', 'update': 'PUT'}[operation]
    action = {'get': 'GetCustomDomain', 'create': 'CreateCustomDomain', 'delete': 'DeleteCustomDomain', 'update': 'UpdateCustomDomain'}[operation]
    path = '/2023-03-30/custom-domains' + ('' if operation == 'create' else '/shuduoai.cn')
    body = data.get('body')
    if operation == 'update':
        if body not in ({'authConfig': {'authType': 'anonymous', 'authInfo': '{}'}},
                        {'authConfig': {'authType': 'function', 'authInfo': '{}'}}):
            raise ValueError('INVALID_AUTH_ONLY_UPDATE')
        payload = json.dumps(body, separators=(',', ':')).encode()
    elif operation == 'create':
        if (not isinstance(body, dict) or body.get('domainName') != 'shuduoai.cn' or body.get('protocol') != 'HTTPS'
                or body.get('authConfig') != {'authType': 'function', 'authInfo': '{}'}):
            raise ValueError('INVALID_CREATE')
        payload = json.dumps(body, separators=(',', ':')).encode()
        if len(payload) > 32768:
            raise ValueError('BODY_TOO_LARGE')
    else:
        if body is not None:
            raise ValueError('BODY_NOT_ALLOWED')
        payload = b''
    return operation, method, action, path, payload


def main():
    from alibabacloud_openapi_util.client import Client as Signer
    from Tea.request import TeaRequest
    operation, method, action, path, payload = request_shape(json.load(sys.stdin))
    host = 'fcv3.cn-hangzhou.aliyuncs.com'
    payload_hash = hashlib.sha256(payload).hexdigest()
    headers = {'host': host, 'content-type': 'application/json', 'x-acs-action': action, 'x-acs-version': '2023-03-30',
               'x-acs-date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
               'x-acs-signature-nonce': str(uuid.uuid4()), 'x-acs-content-sha256': payload_hash,
               'x-acs-security-token': os.environ['ALIBABA_CLOUD_SECURITY_TOKEN']}
    request = TeaRequest()
    request.method, request.pathname, request.query, request.headers = method, path, {}, headers.copy()
    headers['authorization'] = Signer.get_authorization(request, 'ACS3-HMAC-SHA256', payload_hash,
                                                       os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'], os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'])
    connection = http.client.HTTPSConnection(host, timeout=20)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('RESPONSE_TOO_LARGE')
        print(json.dumps(safe_response(response.status, raw, operation)))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 0, 'code': 'DOMAIN_TRANSPORT_UNCONFIRMED'}))
