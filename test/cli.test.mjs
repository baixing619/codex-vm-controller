import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createControllerServer} from '../src/server.mjs';
import {runController} from '../skills/vm-computer-controller/scripts/controller.mjs';
import {configuration,fakeEntry,VM} from './helpers.mjs';
async function fixture(t){
  const f=fakeEntry();let connection;
  const service=createControllerServer({configuration,createEntry:()=>f.entry,publish:async(_c,value)=>{connection=value;},unpublish:async()=>{}});
  await service.start();t.after(()=>service.close());
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'controller-cli-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const options={loadPolicy:async()=>configuration,loadConnection:async()=>connection};
  return {...f,directory,options,run:args=>runController(args,options),connection};
}
test('self-contained CLI uses authenticated real loopback requests, saves only the current frame and checks service instance',async t=>{
  const f=await fixture(t);assert.equal((await f.run(['status'])).value.connected,false);assert.deepEqual(f.events,[]);
  await f.run(['connect']);
  const capture=(await f.run(['capture','--directory',f.directory])).value;
  assert.equal(capture.vmId,VM);assert.equal((await fs.readFile(capture.framePath)).length>0,true);
  assert.equal(capture.serviceInstanceId,f.connection.instanceId);
  const key=(await f.run(['key','--key','Enter','--directory',f.directory])).value;
  assert.equal(key.acceptedByAdapter,true);assert.equal(key.guestEffectVerified,false);assert.notEqual(key.frame.id,capture.id);
  assert.deepEqual((await fs.readdir(f.directory)).sort(),['current-frame.json','current-frame.png']);
  const metadataPath=path.join(f.directory,'current-frame.json'),metadata=JSON.parse(await fs.readFile(metadataPath,'utf8'));
  await fs.writeFile(metadataPath,JSON.stringify({...metadata,serviceInstanceId:randomUUID()}));
  const before=f.events.length;
  await assert.rejects(f.run(['key','--key','Enter','--directory',f.directory]),/current guest frame/);assert.equal(f.events.length,before);
});
test('CLI refuses arbitrary target/source/epoch/URL options before reading any configuration',async()=>{
  for(const extra of ['--vm','--vmId','--source','--epoch','--url','--shell']){
    let loads=0;
    await assert.rejects(runController(['status',extra,'injected'],{loadPolicy:async()=>{loads++;throw Error('must not load');}}),/Invalid options/);
    assert.equal(loads,0);
  }
  await assert.rejects(runController(['status','--home','a','--home','b']),/Invalid options/);
});
test('CLI custom home is forwarded only to the protected configuration loader',async()=>{
  let selected,request;
  const connection={baseURL:'http://127.0.0.1:12345/',token:'x'.repeat(43),instanceId:randomUUID()};
  const result=await runController(['status','--home','home space 中文'],{
    loadPolicy:async options=>{selected=options.home;return configuration;},loadConnection:async()=>connection,
    fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({connected:false}),{status:200});}
  });
  assert.equal(selected,'home space 中文');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.authorization,'Bearer '+connection.token);
  assert.equal(result.value.connected,false);assert.equal(JSON.stringify(result).includes(connection.token),false);
});
test('CLI refuses corrupt frame bytes before creating a screenshot directory',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'controller-corrupt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'must-not-exist');
  await assert.rejects(runController(['capture','--directory',directory],{loadPolicy:async()=>configuration,
    loadConnection:async()=>({baseURL:'http://127.0.0.1:12345/',token:'x'.repeat(43),instanceId:randomUUID()}),
    fetchImpl:async()=>new Response(JSON.stringify({vmId:VM,source:'codex',id:randomUUID(),mime:'image/png',controlEpoch:0,actionRevision:0,width:1,height:1,capturedAtMs:Date.now(),sha256:'a'.repeat(64),data:'AA=='}),{status:200})
  }),/Invalid frame bytes/);
  await assert.rejects(fs.stat(directory),{code:'ENOENT'});
});
test('ASCII file input reaches the one operator while Unicode is rejected before dispatch',async t=>{
  const f=await fixture(t);await f.run(['connect']);await f.run(['capture','--directory',f.directory]);
  await assert.rejects(f.run(['type','--text','你好','--directory',f.directory]),/vm_action_invalid/);
  assert.equal(f.events.some(row=>row.request?.action==='type_text'),false);
  const file=path.join(f.directory,'text.txt');await fs.writeFile(file,'hello from fixture');
  await f.run(['type','--text-file',file,'--directory',f.directory]);
  const sent=f.events.filter(row=>row.request?.action==='type_text');assert.equal(sent.length,1);assert.equal(sent[0].request.args.text,'hello from fixture');
});
