import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
test('gateway evidence recognizes documented missing Authorization, not arbitrary HTTP 400 or date errors',()=>{
 const source=String.raw`
import json, runpy
evidence=runpy.run_path('scripts/probe-v2-http-boundary.py',run_name='fixture')['response_evidence']
for code_key, message_key in [('errorCode','errorMessage'),('ErrorCode','ErrorMessage'),('code','message'),('Code','Message')]:
    value=evidence(400,json.dumps({code_key:'MissingRequiredHeader',message_key:'required HTTP header "Authorization" was not specified'}).encode())
    assert value['authenticationRejected'] is True and value['code']=='MissingRequiredHeader'
    assert 'message' not in value and 'errorMessage' not in value
for status, code, message in [(400,'InvalidArgument','required HTTP header Authorization was not specified'),(400,'MissingRequiredHeader','required HTTP header Date was not specified'),(400,'MissingRequiredHeader','SYNTHETIC_SECRET'),(500,'MissingRequiredHeader','required HTTP header Authorization was not specified')]:
    value=evidence(status,json.dumps({'errorCode':code,'errorMessage':message}).encode())
    assert value['authenticationRejected'] is False
    assert 'SYNTHETIC_SECRET' not in json.dumps(value)
assert evidence(400,b'not json')['authenticationRejected'] is False
assert evidence(200,b'shuduo-v2-private-smoke/v1')['privateProtocol'] is True
print('GATEWAY_ERROR_CLASSIFICATION_PASS')
`;
 assert.equal(execFileSync('python3',['-c',source],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim(),'GATEWAY_ERROR_CLASSIFICATION_PASS');
});
test('wire probe preserves raw path and duplicate headers, signs with STS and never logs a response body',()=>{
 const source=String.raw`
import contextlib, io, json, os, runpy, sys, types
captured = {}
class Signer:
    @staticmethod
    def get_authorization(request, method, payload, aid, secret):
        assert method == 'ACS3-HMAC-SHA256'
        assert request.headers['x-acs-security-token'] == 'synthetic-token'
        assert aid == 'synthetic-key' and secret == 'synthetic-secret'
        captured['signed_path'] = request.pathname
        return 'synthetic-signature'
client = types.ModuleType('alibabacloud_openapi_util.client'); client.Client = Signer
tea = types.ModuleType('Tea.request'); tea.TeaRequest = types.SimpleNamespace
sys.modules['alibabacloud_openapi_util'] = types.ModuleType('alibabacloud_openapi_util')
sys.modules['alibabacloud_openapi_util.client'] = client
sys.modules['Tea'] = types.ModuleType('Tea'); sys.modules['Tea.request'] = tea
class Response:
    status = 404
    def read(self, size):
        assert size == 65537
        return b'{"code":"INGRESS_DENIED","privateField":"DO_NOT_PRINT_BODY"}'
class Connection:
    def __init__(self, host, timeout):
        assert host == 'fixture.cn-hangzhou.fcapp.run' and timeout == 40
        captured['headers'] = []
    def putrequest(self, method, path, **options): captured['path'] = path
    def putheader(self, name, value): captured['headers'].append((name,value))
    def endheaders(self, body): assert json.loads(body) == {'operation':'PRIVATE_STATUS_V1'}
    def getresponse(self): return Response()
    def close(self): captured['closed'] = True
namespace = runpy.run_path('scripts/probe-v2-http-boundary.py',run_name='fixture')
namespace['main'].__globals__['http'].client.HTTPSConnection = Connection
os.environ.update(ALIBABA_CLOUD_ACCESS_KEY_ID='synthetic-key',ALIBABA_CLOUD_ACCESS_KEY_SECRET='synthetic-secret',ALIBABA_CLOUD_SECURITY_TOKEN='synthetic-token')
sys.stdin=io.StringIO(json.dumps({'url':'https://fixture.cn-hangzhou.fcapp.run','probe':{'method':'POST','path':'/./invoke','headers':[['x-fc-control-path','/invoke'],['x-fc-control-path','/http-invoke']]}}))
output=io.StringIO()
with contextlib.redirect_stdout(output): namespace['main']()
value=json.loads(output.getvalue())
assert value['status']==404 and value['code']=='INGRESS_DENIED'
assert captured['path']=='/./invoke' and captured['signed_path']=='/./invoke'
assert len([x for x in captured['headers'] if x[0]=='x-fc-control-path'])==2
assert captured['closed']
assert 'synthetic-token' not in output.getvalue() and 'DO_NOT_PRINT_BODY' not in output.getvalue()
print('WIRE_PROBE_SYNTHETIC_PASS')
`;
 const result=execFileSync('python3',['-c',source],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
 assert.equal(result.trim(),'WIRE_PROBE_SYNTHETIC_PASS');
});
