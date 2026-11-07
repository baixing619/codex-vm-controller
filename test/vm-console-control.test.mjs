import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setImmediate as tick} from 'node:timers/promises';
import {createVmRouter} from '../src/vm-console-router.mjs';
import {createVmTaskEntry} from '../src/vm-task-entry.mjs';
const vmId='11111111-1111-4111-8111-111111111111';
function setup(t,timeoutMs=1000){
 const input=new PassThrough(),output=new PassThrough(),sent=[];
 input.on('data',data=>sent.push(JSON.parse(data.toString())));
 const router=createVmRouter({vmId,input,output,source:'agent',enabled:true,timeoutMs});
 const state=(source,controlEpoch)=>output.write(JSON.stringify({type:'control-state',source,controlEpoch})+'\n');
 const reply=(id)=>output.write(JSON.stringify({id,ok:true,result:{acceptedByAdapter:true}})+'\n');
 t.after(()=>{router.close();input.destroy();output.destroy();});
 state('agent',7);return {input,output,sent,router,state,reply};
}
const text={vmId,action:'type_text',args:{text:'finite text'}};
test('abort sends exact native cancellation but keeps request busy until its drain response',async t=>{
 const h=setup(t),controller=new AbortController();await tick();
 let settled=false;const operation=h.router.request(text,{signal:controller.signal});
 const rejection=assert.rejects(operation,error=>error.name==='AbortError');operation.finally(()=>settled=true).catch(()=>{});
 const original=h.sent[0];controller.abort();await tick();
 assert.deepEqual(h.sent[1],{type:'cancel-request',id:original.id,vmId,source:'agent',controlEpoch:7});
 assert.equal(settled,false);
 await assert.rejects(h.router.request(text),/pending/);
 h.reply(original.id);await rejection;
 const next=h.router.request(text);h.reply(h.sent.at(-1).id);await next;
});
test('already aborted signal never writes an action or cancellation',async t=>{
 const h=setup(t);await tick();const controller=new AbortController();controller.abort();
 await assert.rejects(h.router.request(text,{signal:controller.signal}),error=>error.name==='AbortError');assert.equal(h.sent.length,0);
});
test('falsy abort reasons still cancel and never turn a late reply into success',async t=>{
 for(const reason of [false,0,'']){
  const h=setup(t);await tick();const controller=new AbortController();
  const rejection=assert.rejects(h.router.request(text,{signal:controller.signal}),error=>error.name==='AbortError');
  controller.abort(reason);h.reply(h.sent[0].id);await rejection;
  assert.equal(h.sent[1].type,'cancel-request');
 }
});
test('a new epoch is published immediately but cannot bypass the old request drain',async t=>{
 const h=setup(t);await tick();const seen=[];h.router.subscribeControlState(state=>seen.push(state));
 const rejection=assert.rejects(h.router.request(text),/epoch|revoked/),id=h.sent[0].id;
 h.state('manual',8);h.state('agent',9);await tick();
 assert.deepEqual(seen.at(-1),{source:'agent',controlEpoch:9});
 await assert.rejects(h.router.request(text),/pending/);assert.equal(h.sent.length,1);
 h.reply(id);await rejection;const next=h.router.request(text);h.reply(h.sent.at(-1).id);await next;
});
test('malformed response never releases an unsafe channel for replacement',async t=>{
 for(const line of ['{broken','null','[]']){
  const h=setup(t);await tick();const rejection=assert.rejects(h.router.request(text),/invalid response/);
  h.output.write(line+'\n');await rejection;
  await assert.rejects(h.router.request(text),/closed/);
  assert.equal(h.router.executionState().releaseUnconfirmed,true);
 }
});
test('native uncertain drain stays terminal even when the model already cancelled',async t=>{
 const h=setup(t);await tick();const controller=new AbortController();
 const entry=createVmTaskEntry({vmId,router:h.router,source:'agent',enabled:true});
 const rejection=assert.rejects(entry.execute(text,{signal:controller.signal}),/drain unconfirmed/);
 controller.abort();h.output.write(JSON.stringify({id:h.sent[0].id,ok:false,error:'execution-drain-unconfirmed'})+'\n');
 await rejection;await assert.rejects(entry.drain(),/drain unconfirmed/);
 await assert.rejects(h.router.request(text),/closed/);
});
test('borrowed entry cannot claim its shared router is drained while another caller is active',async t=>{
 const h=setup(t);await tick();
 const entry=createVmTaskEntry({vmId,router:h.router,source:'agent',enabled:true});
 const external=h.router.request(text);
 await assert.rejects(entry.drain(),/pending/);h.reply(h.sent[0].id);await external;
 assert.deepEqual(await entry.drain(),{executionDrained:true,ownerWindowClosed:false});
});
test('cancel without drain becomes terminal instead of accepting a replacement',async t=>{
 const h=setup(t,30);await tick();const controller=new AbortController();
 const rejection=assert.rejects(h.router.request(text,{signal:controller.signal}),/cancel.*unconfirmed|drain.*unconfirmed/i);
 controller.abort();await rejection;
 await assert.rejects(h.router.request(text),/closed/);
});
test('trusted control subscription relays changes and terminal revocation, not duplicate states',async t=>{
 const h=setup(t);await tick();const states=[];
 const unsubscribe=h.router.subscribeControlState(state=>{states.push(state);assert.ok(Object.isFrozen(state));});
 assert.deepEqual(states,[{source:'agent',controlEpoch:7}]);
 h.state('agent',7);h.state('manual',8);await tick();
 assert.equal(states.length,2);h.router.close();assert.deepEqual(states.at(-1),{source:'manual',controlEpoch:null});
 unsubscribe();assert.equal(states.length,3);
});
test('entry forwards cancellation and publishes control grants',async t=>{
 const h=setup(t);await tick();
 const entry=createVmTaskEntry({vmId,router:h.router,source:'agent',enabled:true});
 const states=[];entry.subscribeControlState(state=>states.push(state));
 const controller=new AbortController();const rejection=assert.rejects(entry.execute(text,{signal:controller.signal}),error=>error.name==='AbortError');
 controller.abort();assert.equal(h.sent.at(-1).type,'cancel-request');
 h.reply(h.sent[0].id);await rejection;
 h.state('codex',8);await tick();assert.deepEqual(states.at(-1),{source:'codex',controlEpoch:8});
 await entry.close();assert.deepEqual(states.at(-1),{source:'manual',controlEpoch:null});
 assert.deepEqual(h.router.controlState(),{source:'codex',controlEpoch:8});
});
