import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setImmediate as tick} from 'node:timers/promises';
import {createControllerServer} from '../src/server.mjs';
import {configuration,policy,fakeEntry,OTHER} from './helpers.mjs';
const endpoint='/api/vm-desktop/controller';
async function fixture(t){
  const f=fakeEntry();let connection,constructed=0,verified=0;
  const service=createControllerServer({configuration,
    createEntry:options=>{constructed++;assert.equal(options.vmId,policy.vmId);assert.equal(options.source,'codex');assert.equal(options.ownerContext.kind,'local_operator');assert.equal(options.policyPath,configuration.policyPath);return f.entry;},
    publish:async(_config,value)=>{connection=value;},unpublish:async()=>{connection=null;},verifyConfiguration:async()=>{verified++;}});
  assert.equal(constructed,1);assert.deepEqual(f.events,[]);
  const started=await service.start();t.after(()=>service.close());
  function raw(route,{method='GET',body,token=connection.token,headers={}}={}){
    const url=new URL(route,started.baseURL);
    return new Promise((resolve,reject)=>{
      const request=http.request(url,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'}),...headers}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:response.statusCode,value,text});});
      });
      request.on('error',reject);if(body!==undefined)request.write(typeof body==='string'?body:JSON.stringify(body));request.end();
    });
  }
  const post=(operation,args={})=>raw(endpoint+'/'+operation,{method:'POST',body:{directorToken:connection.token,...args}});
  return {...f,service,raw,post,baseURL:started.baseURL,connection:()=>connection,verified:()=>verified};
}
test('real loopback startup is read-only, authenticates status and never exposes a token endpoint',async t=>{
  const f=await fixture(t);assert.deepEqual(f.events,[]);
  const status=await f.raw(endpoint);assert.equal(status.status,200);assert.equal(status.value.connected,false);
  assert.equal((await f.raw(endpoint,{token:'invalid'})).status,403);
  const config=await f.raw('/api/config');assert.equal(config.status,404);assert.equal(config.text.includes(f.connection().token),false);
  assert.equal((await f.raw(endpoint,{headers:{origin:'https://example.invalid'}})).status,403);
  assert.equal((await f.raw(endpoint,{headers:{host:'example.invalid'}})).status,403);
  assert.equal((await f.raw(endpoint+'?vmId=anything')).status,400);assert.deepEqual(f.events,[]);
});
test('connect alone starts the native entry; same connection, frame and operator receipt are preserved',async t=>{
  const f=await fixture(t);assert.equal((await f.post('capture')).status,409);assert.deepEqual(f.events,[]);
  assert.equal((await f.post('connect')).status,200);assert.equal(f.verified(),1);
  assert.equal((await f.post('connect')).status,200);assert.equal(f.events.filter(row=>row.kind==='start').length,1);
  const before=(await f.post('capture')).value;
  assert.equal(before.vmId,policy.vmId);assert.equal(before.source,'codex');
  const result=await f.post('action',{action:'click',args:{x:0,y:0,button:'left'},frameId:before.id});
  assert.equal(result.status,200);assert.equal(result.value.acceptedByAdapter,true);assert.equal(result.value.guestEffectVerified,false);assert.notEqual(result.value.frame.id,before.id);
  assert.deepEqual(f.events.filter(row=>row.kind==='execute').map(row=>row.request.action),['capture','capture','click','capture']);
  assert.equal((await f.post('action',{action:'key',args:{key:'Enter'},frameId:before.id})).status,409);
  assert.equal((await f.post('debug')).value.capacity,256);
});
test('HTTP rejects forged VM/source/epoch, malformed roots, oversized bodies and unauthenticated mutations before dispatch',async t=>{
  const f=await fixture(t);
  for(const extra of [{vmId:OTHER},{source:'agent'},{controlEpoch:12},{consolePath:'foreign.exe'},{enabled:true}]){
    assert.equal((await f.post('connect',extra)).status,400);
  }
  assert.equal((await f.raw(endpoint+'/connect',{method:'POST',body:{directorToken:'wrong'}})).status,403);
  for(const body of ['null','[]','{}','{broken'])assert.equal((await f.raw(endpoint+'/connect',{method:'POST',body})).status,body==='{}'?403:400);
  assert.equal((await f.raw(endpoint+'/connect',{method:'POST',body:'x'.repeat(5000)})).status,413);
  assert.equal((await f.raw(endpoint+'/connect',{method:'POST',body:'{}',headers:{'content-type':'text/plain'}})).status,415);
  assert.deepEqual(f.events,[]);
});
test('HTTP cancellation holds the original slot until the fake native call actually drains',async t=>{
  const f=await fixture(t);await f.post('connect');const frame=(await f.post('capture')).value;
  f.hold('key');const action=f.post('action',{action:'key',args:{key:'Enter'},frameId:frame.id});await f.waitForHeld();
  assert.equal((await f.post('cancel')).value.cancelRequested,true);
  assert.equal((await f.raw(endpoint)).value.busy,true);
  assert.equal((await f.post('capture')).status,409);
  f.release();assert.equal((await action).status,409);
  assert.equal((await f.raw(endpoint)).value.busy,false);
  assert.equal((await f.post('capture')).status,200);
  assert.equal(f.events.filter(row=>row.kind==='execute'&&row.request.action==='key').length,1);
});
test('disconnecting an HTTP client cancels its exact in-flight operation without resending',async t=>{
  const f=await fixture(t);await f.post('connect');const frame=(await f.post('capture')).value;f.hold('key');
  const request=http.request(new URL(endpoint+'/action',f.baseURL),{method:'POST',headers:{authorization:'Bearer '+f.connection().token,'content-type':'application/json'}});
  request.on('error',()=>{});request.end(JSON.stringify({directorToken:f.connection().token,action:'key',args:{key:'Enter'},frameId:frame.id}));
  await f.waitForHeld();request.destroy();await tick();await tick();
  assert.equal((await f.raw(endpoint)).value.busy,true);f.release();
  for(let i=0;i<100;i++){if(!(await f.raw(endpoint)).value.busy)break;await tick();}
  assert.equal((await f.raw(endpoint)).value.busy,false);assert.equal(f.events.filter(row=>row.kind==='execute'&&row.request.action==='key').length,1);
});
