import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeVmId} from './config.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function createVmComputerController({vmId,entry,sharedActivity,canOperate=()=>true,now=Date.now}={}){
  const VM=normalizeVmId(vmId);
  if(typeof entry?.executeOperator!=='function'||typeof entry?.execute!=='function'||!sharedActivity)throw Error('VM controller integration required');
  let active=null,lastFrame=null,lastError=null;
  const status=()=>({vmId:VM,enabled:canOperate()===true,connected:Number.isSafeInteger(entry.controlState()?.controlEpoch),
    control:entry.controlState(),transport:entry.transportStatus(),busy:Boolean(active),activeSource:active?'codex':null,
    debug:{capacity:256,storage:'memory',shared:true},lastError});
  function assertOpen(){if(canOperate()!==true)fail('vm_controller_paused');}
  async function connect({signal}={}){signal?.throwIfAborted();assertOpen();const transport=entry.transportStatus();
    if(transport.ownerPid||Number.isSafeInteger(entry.controlState()?.controlEpoch))return status();
    await entry.start();return status();}
  async function withLease(operation,{signal}={}){
    signal?.throwIfAborted();
    assertOpen();if(active)fail('vm_controller_busy');
    if(!Number.isSafeInteger(entry.controlState()?.controlEpoch))fail('vm_controller_not_connected');
    if(!sharedActivity.available('vm'))fail('vm_activity_busy');
    const controller=new AbortController();active=controller;lastError=null;
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const running=sharedActivity.runVm(({signal})=>operation(signal),{signal:combined});
    const admitted=sharedActivity.status(),lease=admitted.kind==='vm'?{id:admitted.id,generation:admitted.generation}:null;
    try{return await running;}catch(error){lastError=/^[a-zA-Z0-9 _:.\/-]{1,180}$/.test(error?.message??'')?error.message:'vm_controller_failed';throw error;}
    finally{
      try{
        const current=sharedActivity.status();
        if(lease&&current.kind==='vm'&&current.state==='active'&&current.pending===0&&current.id===lease.id&&current.generation===lease.generation)
          await sharedActivity.finishVm(lease);
      }finally{if(active===controller)active=null;}
    }
  }
  async function captureFrame(signal){
    const epoch=entry.controlState()?.controlEpoch;
    const result=await entry.executeOperator({vmId:VM,action:'capture',args:{}},{signal});
    const frame=result?.frame;
    if(!frame||!Buffer.isBuffer(frame.bytes)||!['image/png','image/jpeg'].includes(frame.mime)||!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.bytes.length>3*1024*1024)
      fail('vm_frame_invalid');
    if(epoch!==entry.controlState()?.controlEpoch)fail('vm_frame_revoked');
    const metadata={id:randomUUID(),vmId:VM,source:'codex',controlEpoch:epoch,width:frame.width,height:frame.height,
      capturedAtMs:now(),sha256:createHash('sha256').update(frame.bytes).digest('hex'),actionRevision:entry.transportStatus().actionRevision};
    lastFrame=metadata;
    return {...metadata,mime:frame.mime,data:frame.bytes.toString('base64')};
  }
  const capture=options=>withLease(signal=>captureFrame(signal),options);
  function validateAction(action,args){
    if(action==='click'&&exact(args,['x','y','button'])&&Number.isInteger(args.x)&&Number.isInteger(args.y)&&args.x>=0&&args.y>=0&&['left','right'].includes(args.button))return;
    if(action==='key'&&exact(args,['key'])&&['Shift','Space','Enter','Escape','Tab','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(args.key))return;
    if(action==='type_text'&&exact(args,['text'])&&typeof args.text==='string'&&/^[\x20-\x7e]{1,1000}$/.test(args.text))return;
    fail('vm_action_invalid');
  }
  async function action({action,args,frameId}={},options={}){
    options.signal?.throwIfAborted();
    validateAction(action,args);
    const viewed=lastFrame;
    if(!viewed||viewed.id!==frameId||now()-viewed.capturedAtMs>120000||now()<viewed.capturedAtMs)fail('vm_viewed_frame_required');
    if(viewed.actionRevision!==entry.transportStatus().actionRevision)fail('vm_viewed_frame_changed');
    lastFrame=null;
    return withLease(async signal=>{
      const fresh=await captureFrame(signal);lastFrame=null;
      if(fresh.controlEpoch!==viewed.controlEpoch||fresh.width!==viewed.width||fresh.height!==viewed.height||fresh.actionRevision!==viewed.actionRevision)fail('vm_frame_geometry_changed');
      if(action==='click'&&(args.x>=fresh.width||args.y>=fresh.height))fail('vm_click_out_of_bounds');
      assertOpen();
      const result=await entry.executeOperator({vmId:VM,action,args},{signal});
      if(result.receipt?.acceptedByAdapter!==true)fail('vm_input_unconfirmed');
      await delay(180,undefined,{signal});
      const after=await captureFrame(signal);
      return {vmId:VM,source:'codex',action,acceptedByAdapter:true,guestEffectVerified:false,frame:after};
    },options);
  }
  function cancel(){const pending=Boolean(active);lastFrame=null;active?.abort(new Error('vm_operator_cancelled'));return {vmId:VM,cancelRequested:pending};}
  async function debug(){assertOpen();return {vmId:VM,storage:'memory',...(await entry.debugSnapshot())};}
  return Object.freeze({status,connect,capture,action,cancel,debug});
}
