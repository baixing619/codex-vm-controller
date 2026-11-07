import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
export const VM='11111111-1111-4111-8111-111111111111';
export const OTHER='22222222-2222-4222-8222-222222222222';
export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=','base64');
export const policy=Object.freeze({schemaVersion:1,vmId:VM,ownerSid:'S-1-5-21-111-222-333-1001',hostMachine:'fixture-hyperv'});
export const configuration=Object.freeze({home:'fixture-only-home',policyPath:'fixture-only-home/policy.json',policy,policySha256:'a'.repeat(64)});
export function fakeEntry(){
  let epoch=null,revision=0,closed=false,pending=false,hold=null,release=null;
  const events=[];
  const entry={
    controlState:()=>({source:'manual',controlEpoch:epoch}),
    transportStatus:()=>({ownerPid:epoch===null?null:123,actionRevision:revision,closed}),
    async start(){events.push({kind:'start'});if(closed)throw Error('entry_closed');epoch=0;return {ownerPid:123,transportAttached:true};},
    debugSnapshot:async()=>({enabled:true,capacity:256,rows:[]}),
    async executeOperator(request,{signal}={}){
      signal?.throwIfAborted();if(epoch===null||closed)throw Error('not_connected');if(pending)throw Error('pending');
      pending=true;events.push({kind:'execute',request});
      try{
        if(request.vmId!==VM)throw Error('target_mismatch');
        if(request.action!=='capture')revision++;
        if(hold===request.action){await new Promise(resolve=>{release=resolve;});release=null;hold=null;}
        signal?.throwIfAborted();
        return request.action==='capture'?{frame:{mime:'image/png',bytes:PNG,width:1,height:1}}:{receipt:{acceptedByAdapter:true}};
      }finally{pending=false;}
    },
    execute(...args){return entry.executeOperator(...args);},
    async drain(){if(pending)throw Error('pending');return {executionDrained:true,ownerWindowClosed:false};},
    async close(){events.push({kind:'close'});closed=true;epoch=null;release?.();return {resourceReleased:true};}
  };
  return {entry,events,setEpoch:value=>{epoch=value;},bump:()=>{revision++;},hold:action=>{hold=action;},
    release:()=>release?.(),async waitForHeld(){for(let i=0;i<100&&!release;i++)await tick();if(!release)throw Error('fixture_not_held');}};
}
export function fixtureConnection(baseURL='http://127.0.0.1:12345/'){
  return {schemaVersion:1,baseURL,token:'x'.repeat(43),instanceId:randomUUID(),pid:12345678,vmId:VM,policySha256:'a'.repeat(64)};
}
