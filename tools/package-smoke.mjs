import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
const execute=promisify(execFile),[root,home]=process.argv.slice(2);
assert.ok(root&&home);
const {startControllerServer}=await import(pathToFileURL(path.join(root,'src/server.mjs')));
const service=await startControllerServer({home});
try{
 const {stdout}=await execute(path.join(root,'runtime/node.exe'),[path.join(root,'skills/vm-computer-controller/scripts/controller.mjs'),'status','--home',home],{windowsHide:true,timeout:15000});
 const status=JSON.parse(stdout);
 assert.equal(status.vmId,'11111111-1111-4111-8111-111111111111');
 assert.equal(status.connected,false);
 assert.equal(status.transport.ownerPid,null);
 assert.equal(status.configured,true);
}finally{await service.close();}
await assert.rejects(fs.stat(path.join(home,'connection.json')),{code:'ENOENT'});
console.log('Extracted bundled runtime, real local service and independent skill CLI passed; no VM connection or input.');
