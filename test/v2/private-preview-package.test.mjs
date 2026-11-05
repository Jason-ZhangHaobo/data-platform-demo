import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

test('the isolated private preview archive includes its pure route dependencies and imports without checkout or cloud access',t=>{
 const directory=mkdtempSync(join(tmpdir(),'shuduo-preview-package-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const workflow=readFileSync('.github/workflows/ci.yml','utf8');
 const line=workflow.split('\n').find(value=>value.includes('run: zip -qr'));
 assert.ok(line,'CI must retain the account-restricted preview package');
 const files=line.slice(line.indexOf('web-dist')).trim().split(/\s+/).filter(value=>value!=='web-dist');
 assert.deepEqual(files,['scripts/run-v2-cloudshell-preview.mjs','src/v2/private-service-routes.mjs','src/v2/publication-request.mjs']);
 const archive=join(directory,'preview.zip'),unpacked=join(directory,'unpacked');
 execFileSync('zip',['-q',archive,...files],{timeout:10000,stdio:'pipe'});
 execFileSync('unzip',['-q',archive,'-d',unpacked],{timeout:10000,stdio:'pipe'});
 const script=`const bridge=await import(${JSON.stringify(pathToFileURL(join(unpacked,files[0])).href)});if(typeof bridge.privatePayload!=='function')throw Error('PREVIEW_IMPORT_FAILED');process.stdout.write('IMPORTED_WITHOUT_CLOUD');`;
 const output=execFileSync(process.execPath,['--input-type=module','-e',script],{timeout:10000,encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(output,'IMPORTED_WITHOUT_CLOUD');
});
