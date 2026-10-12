#!/usr/bin/env python3
"""Independent query client: application token only; no cookies, IAM or model key."""
import argparse, json, os, re, sys, urllib.error, urllib.parse, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.URLError('Redirects are not permitted')

def main():
    parser=argparse.ArgumentParser(description='Query a registered Shuduo DAPI or XAPI')
    parser.add_argument('--base-url',required=True)
    parser.add_argument('--type',choices=['dapi','xapi'],required=True)
    parser.add_argument('--slug',required=True)
    parser.add_argument('--token-file',required=True)
    parser.add_argument('--client-id')
    parser.add_argument('--page',type=int,default=1)
    parser.add_argument('--page-size',type=int,default=20)
    parser.add_argument('--private-preview',action='store_true',help='Loopback-only transport marker for an account-restricted preview')
    args=parser.parse_args()
    base=urllib.parse.urlsplit(args.base_url)
    if base.scheme not in ['http','https'] or base.username or base.password or base.query or base.fragment or base.path not in ['', '/'] or (base.scheme=='http' and base.hostname not in ['127.0.0.1','localhost','::1']):
        raise ValueError('INVALID_ORIGIN')
    if not re.fullmatch('[a-z][a-z0-9-]{2,47}',args.slug) or not 1<=args.page<=10000 or not 1<=args.page_size<=100: raise ValueError('INVALID_QUERY')
    if args.client_id and not re.fullmatch('[A-Z0-9][A-Z0-9-]{2,63}',args.client_id): raise ValueError('INVALID_CLIENT_ID')
    stat=os.stat(args.token_file)
    if stat.st_mode & 0o077 or stat.st_size>256: raise ValueError('TOKEN_FILE_NOT_PRIVATE')
    with open(args.token_file) as source: token=source.read().strip()
    if not re.fullmatch('sz_(?:private|local)_[A-Za-z0-9_-]{32}',token): raise ValueError('TOKEN_FORMAT_INVALID')
    params={'page':str(args.page),'page_size':str(args.page_size)}
    if args.client_id: params['client_id']=args.client_id
    url=args.base_url.rstrip('/')+'/api/v2/open/'+args.type+'s/'+args.slug+'?'+urllib.parse.urlencode(params)
    headers={'Authorization':'Bearer '+token,'Accept':'application/json'}
    if args.private_preview:
        if base.scheme!='http' or base.hostname!='127.0.0.1': raise ValueError('PRIVATE_PREVIEW_REQUIRES_LOOPBACK')
        headers['X-Forwarded-Proto']='https'
    req=urllib.request.Request(url,headers=headers,method='GET')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=45) as response:
            body=response.read(1048577)
            if len(body)>1048576 or response.headers.get_content_type()!='application/json': raise ValueError('INVALID_RESPONSE')
            data=json.loads(body.decode('utf-8'))
            if not isinstance(data.get('data'),list) or not data.get('callId') or not data.get('service',{}).get('versionId'): raise ValueError('INVALID_RESPONSE')
            return {'ok':True,'status':response.status,'response':data,'authentication':'APPLICATION_BEARER_ONLY'}
    except urllib.error.HTTPError as error:
        try: code=json.loads(error.read(4096).decode('utf-8')).get('code','HTTP_ERROR')
        except Exception: code='HTTP_ERROR'
        return {'ok':False,'status':error.code,'code':code}

if __name__=='__main__':
    try:
        result=main();print(json.dumps(result,ensure_ascii=False));sys.exit(0 if result['ok'] else 1)
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[A-Z_]+',code) else 'QUERY_CLIENT_FAILED'}));sys.exit(1)
