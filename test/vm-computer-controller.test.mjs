import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createVmRouter} from '../src/vm-console-router.mjs';
import {createVmComputerController} from '../src/vm-computer-controller.mjs';
const VM='11111111-1111-4111-8111-111111111111';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=','base64');
function fixture(){
 let revision=0,width=1,epoch=2,running=false;
 const actions=[];
 const entry={controlState:()=>({source:'manual',controlEpoch:epoch}),transportStatus:()=>({actionRevision:revision,ownerPid:123}),
  start:async()=>{},debugSnapshot:async()=>({enabled:true,capacity:256,rows:[]}),execute:async()=>{},
  executeOperator:async request=>{actions.push(request.action);return request.action==='capture'?{frame:{mime:'image/png',bytes:png,width,height:1}}:
    (revision++,{receipt:{acceptedByAdapter:true}});}};
 const shared={available:()=>!running,status:()=>running?{kind:'vm',state:'active',pending:0,id:'lease',generation:1}:{kind:null},
  runVm(operation,{signal}){running=true;return Promise.resolve().then(()=>{signal.throwIfAborted();return operation({signal});});},
  async finishVm(){running=false;}};
 const controller=createVmComputerController({vmId:VM,entry,sharedActivity:shared});
 return{controller,entry,actions,bump(){revision++;},resize(){width=2;},changeEpoch(){epoch++;},shared};
}
test('operator capture and input return a new real frame with no role identity',async()=>{
 const f=fixture(),frame=await f.controller.capture();
 assert.equal(frame.vmId,VM);assert.equal(frame.source,'codex');assert.equal(Buffer.from(frame.data,'base64').equals(png),true);
 const result=await f.controller.action({action:'click',args:{x:0,y:0,button:'left'},frameId:frame.id});
 assert.equal(result.acceptedByAdapter,true);assert.equal(result.guestEffectVerified,false);assert.notEqual(result.frame.id,frame.id);
 assert.deepEqual(f.actions,['capture','capture','click','capture']);assert.equal('identity' in result,false);
 await assert.rejects(f.controller.action({action:'key',args:{key:'Enter'},frameId:frame.id}),/viewed_frame_required/);
});
test('another caller input invalidates an old frame before dispatch',async()=>{
 const f=fixture(),frame=await f.controller.capture();f.bump();
 await assert.rejects(f.controller.action({action:'key',args:{key:'Enter'},frameId:frame.id}),/viewed_frame_changed/);
 assert.deepEqual(f.actions,['capture']);
});
test('fresh geometry or epoch change rejects input and releases activity',async()=>{
 for(const change of ['resize','changeEpoch']){
  const f=fixture(),frame=await f.controller.capture();f[change]();
  await assert.rejects(f.controller.action({action:'click',args:{x:0,y:0,button:'left'},frameId:frame.id}),/geometry_changed/);
  assert.deepEqual(f.actions,['capture','capture']);assert.equal(f.controller.status().busy,false);assert.equal(f.shared.status().kind,null);
 }
});
test('invalid coordinates, fields or unsupported keys never dispatch an input',async()=>{
 const f=fixture(),frame=await f.controller.capture();
 await assert.rejects(f.controller.action({action:'click',args:{x:1,y:0,button:'left'},frameId:frame.id}),/out_of_bounds/);
 for(const args of [{key:'Power'},{key:'Enter',command:'anything'}])await assert.rejects(f.controller.action({action:'key',args,frameId:frame.id}),/invalid/);
 assert.equal(f.actions.includes('click'),false);assert.equal(f.actions.includes('key'),false);
});
function wire(){
 const input=new PassThrough(),output=new PassThrough(),requests=[];
 const router=createVmRouter({vmId:VM,input,output,source:'agent',enabled:true,timeoutMs:1000});
 input.on('data',chunk=>requests.push(JSON.parse(chunk.toString())));
 output.write(JSON.stringify({type:'control-state',source:'manual',controlEpoch:0})+'\n');
 return{router,input,output,requests,reply(q,result){output.write(JSON.stringify({id:q.id,ok:true,result})+'\n');}};
}
test('role and Codex requests retain distinct attribution and one shared slot',async()=>{
 const f=wire(),a=f.router.request({vmId:VM,action:'key',args:{key:'Enter'}});
 await assert.rejects(f.router.requestAsOperator({vmId:VM,action:'key',args:{key:'Space'}}),/another request/);
 assert.equal(f.requests[0].source,'agent');f.reply(f.requests[0],{acceptedByAdapter:true});await a;
 const b=f.router.requestAsOperator({vmId:VM,action:'key',args:{key:'Enter'}});assert.equal(f.requests[1].source,'codex');f.reply(f.requests[1],{acceptedByAdapter:true});await b;f.router.close();
});
test('debug accepts at most 256 rows and cannot become an input request',async()=>{
 const f=wire();
 for(const n of [256,257]){
  const pending=f.router.debugSnapshot(),q=f.requests.at(-1);assert.equal(q.type,'debug-snapshot');assert.equal(q.vmId,VM);assert.equal('action' in q,false);
  f.output.write(JSON.stringify({type:'debug-snapshot',id:q.id,vmId:VM,enabled:true,capacity:256,revision:1,rows:Array(n).fill('bounded')})+'\n');
  if(n===256)assert.equal((await pending).rows.length,256);else await assert.rejects(pending,/invalid VM debug/);
 }
 f.router.close();
});
test('operator cancellation uses the real operator attribution and awaits its terminal response',async()=>{
 const f=wire(),c=new AbortController();
 const pending=f.router.requestAsOperator({vmId:VM,action:'key',args:{key:'Enter'}},{signal:c.signal});c.abort(new Error('operator-stop'));
 assert.equal(f.requests[1].type,'cancel-request');assert.equal(f.requests[1].source,'codex');
 assert.equal(f.router.executionState().pending,true);f.reply(f.requests[0],{acceptedByAdapter:true});
 await assert.rejects(pending,/operator-stop/);assert.equal(f.router.executionState().pending,false);f.router.close();
});
