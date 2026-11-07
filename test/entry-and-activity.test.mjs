import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate as tick} from 'node:timers/promises';
import {createVmTaskEntry} from '../src/vm-task-entry.mjs';
import {createSharedVmActivity} from '../src/shared-vm-activity.mjs';
import {VM,OTHER,fakeEntry} from './helpers.mjs';
test('entry is lazy, preserves protected policy environment and only starts the background executable',async()=>{
  const child=new EventEmitter();child.pid=123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin.on('finish',()=>{child.stdout.end();child.emit('exit',0,null);});
  const calls=[],directory=path.resolve('installation space 中文','bin'),policyPath=path.resolve('private home','policy.json');
  const entry=createVmTaskEntry({vmId:VM,source:'codex',enabled:true,ownerContext:{kind:'local_operator'},
    consolePath:path.join(directory,'PreparedBackgroundController.exe'),backgroundConsolePath:path.join(directory,'PreparedBackgroundController.exe'),policyPath,
    spawnOwner:(executable,args,options)=>{calls.push({executable,args,options});queueMicrotask(()=>child.emit('spawn'));setImmediate(()=>child.stdout.write(JSON.stringify({type:'control-state',source:'manual',controlEpoch:0})+'\n'));return child;}});
  assert.deepEqual(calls,[]);await entry.start();await tick();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['--background-protocol']);assert.equal(calls[0].options.shell,false);assert.equal(calls[0].options.windowsHide,true);
  assert.equal(calls[0].options.env.VM_CONTROLLER_POLICY,policyPath);assert.equal(entry.controlState().controlEpoch,0);
  await assert.rejects(entry.executeOperator({vmId:OTHER,action:'capture',args:{}}),/target mismatch/);
  await entry.close();
});
test('operator identity is required before starting native control',async()=>{
  const entry=createVmTaskEntry({vmId:VM,source:'codex',enabled:true,consolePath:path.resolve('PreparedBackgroundController.exe')});
  await assert.rejects(entry.start(),/operator identity/);
});
test('VM activity leases require a real epoch, exact generation and confirmed drain',async()=>{
  const f=fakeEntry(),shared=createSharedVmActivity(f.entry);assert.equal(shared.available('vm'),false);await f.entry.start();
  assert.equal(shared.available('vm'),true);await shared.runVm(async()=>{});const lease=shared.status();
  await assert.rejects(shared.finishVm({...lease,generation:lease.generation+1}),/stale/);
  const drained=await shared.finishVm(lease);assert.equal(drained.executionDrained,true);assert.equal(shared.status().kind,null);
});
test('epoch revocation during a task rejects its late result and retains release semantics',async()=>{
  const f=fakeEntry(),shared=createSharedVmActivity(f.entry);await f.entry.start();
  await assert.rejects(shared.runVm(async()=>{f.setEpoch(1);return 'late';}),/unavailable/);
  await shared.finishVm(shared.status());assert.equal(shared.status().kind,null);
});
