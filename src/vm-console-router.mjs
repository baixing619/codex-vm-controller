// Stream adapter for the existing owned VM console. Construction never opens a VM.
// Operator display is informational; the epoch only invalidates cancelled work.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readVmJpegDimensions } from './vm-jpeg-frame.mjs';

import {normalizeVmId} from './config.mjs';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function actionArgs(action, args) {
  if (action === 'capture') {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new Error('capture does not take arguments');
    return {};
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid action arguments');
  if (action === 'click') {
    if (Object.keys(args).sort().join(',') !== 'button,x,y' || !Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.y < 0 || !['left', 'right'].includes(args.button)) throw new Error('invalid click');
    return { x: args.x, y: args.y, button: args.button };
  }
  if (action === 'key') {
    if (Object.keys(args).join(',') !== 'key' || typeof args.key !== 'string' || !/^(Shift|Space|Enter|Escape|Tab|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(args.key)) throw new Error('invalid key');
    return { key: args.key };
  }
  if (action === 'type_text') {
    if (Object.keys(args).join(',') !== 'text' || typeof args.text !== 'string' || !args.text || args.text.length > 1000) throw new Error('invalid text');
    return { text: args.text };
  }
  throw new Error('unknown action');
}

function decodeFrame(result) {
  if (!result || !['image/png','image/jpeg'].includes(result.mime) || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192 || typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)) throw new Error('invalid frame');
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.length < PNG.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('invalid frame');
  if(result.mime==='image/png'){
    if(!bytes.subarray(0,PNG.length).equals(PNG))throw new Error('invalid frame');
  }else{
    const dimensions=readVmJpegDimensions(bytes);
    if(result.width!==dimensions.width||result.height!==dimensions.height)throw new Error('invalid frame dimensions');
  }
  return { mime: result.mime, width: result.width, height: result.height, bytes };
}

export function createVmRouter({ vmId, input, output, source, enabled=false, enabledForFixture = false, timeoutMs = 3000 } = {}) {
  const TARGET=normalizeVmId(vmId);
  if (!input || !output) throw new Error('streams required');
  if (!['codex','agent'].includes(source)) throw new Error('Explicit VM source required');
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let pending = null;
  let closed = false;
  let control = {source:'manual',controlEpoch:null};
  let lastNumericEpoch = null;
  let releaseUnconfirmed=false;
  let debugPending=null;
  const controlListeners=new Set();
  function publishControl(){
    const snapshot=Object.freeze({...control});
    for(const listener of [...controlListeners]){try{listener(snapshot);}catch{}}
  }
  function finish(error, result) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.signal?.removeEventListener('abort',current.onAbort);
    if (error) current.reject(error); else current.resolve(result);
  }
  function terminate(error){
    if(pending)releaseUnconfirmed=true;
    const changed=!closed;closed=true;control={source:'manual',controlEpoch:null};finish(error);
    if(changed)publishControl();
    if(debugPending){clearTimeout(debugPending.timer);debugPending.reject(error);debugPending=null;}
  }
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { terminate(new Error('invalid response; adapter closed')); return; }
    if (!message || typeof message!=='object' || Array.isArray(message)) {terminate(new Error('invalid response; adapter closed'));return;}
    if(message.type==='debug-snapshot'){
      if(!debugPending||message.id!==debugPending.id)return;
      const p=debugPending;debugPending=null;clearTimeout(p.timer);
      if(message.vmId!==TARGET||message.capacity!==256||typeof message.enabled!=='boolean'||
        !Array.isArray(message.rows)||message.rows.length>256||message.rows.some(row=>typeof row!=='string'||row.length>8192))
        p.reject(new Error('invalid VM debug snapshot'));
      else p.resolve({enabled:message.enabled,capacity:256,revision:message.revision,rows:[...message.rows]});
      return;
    }
    if (message.type==='control-state') {
      if (closed) return;
      const disconnected=message.controlEpoch===null;
      if (Object.keys(message).length!==3 || !['manual','codex','agent'].includes(message.source)
        || (disconnected ? message.source!=='manual' : !Number.isSafeInteger(message.controlEpoch) || message.controlEpoch<0)
        || !disconnected && lastNumericEpoch!==null &&
          (message.controlEpoch<lastNumericEpoch || control.controlEpoch===null && message.controlEpoch===lastNumericEpoch)) {
        terminate(new Error('invalid control state; adapter closed'));return;
      }
      // Null means not connected, not a new grant or a reset of old epochs.
      // A reconnect may never make a pre-disconnect observation current again.
      if(!disconnected)lastNumericEpoch=message.controlEpoch;
      if (message.controlEpoch!==control.controlEpoch || message.source!==control.source) {
        const cancelled=message.controlEpoch!==control.controlEpoch;
        control={source:message.source,controlEpoch:message.controlEpoch};
        if(cancelled&&pending)pending.revocationError=new Error('VM cancellation epoch changed; pending request cancelled');
        publishControl();
      }
      return;
    }
    if (!pending || message.id !== pending.id) return;
    if(message.ok!==true&&message.error==='execution-drain-unconfirmed'){
      terminate(new Error('VM execution drain unconfirmed; adapter closed'));return;
    }
    // Cancellation is not drained until the native request returns. Keep the
    // slot occupied even if the requesting model turn has already been aborted.
    if(pending.revocationError||pending.aborted){finish(pending.revocationError??pending.abortError);return;}
    if (message.ok !== true) { finish(new Error('adapter rejected request: '+(typeof message.error==='string'&&/^[A-Za-z0-9_:.-]{1,100}$/.test(message.error)?message.error:'request-failed')+(typeof message.hresult==='string'&&/^0x[0-9A-F]{8}$/.test(message.hresult)?' '+message.hresult:''))); return; }
    try { finish(null, pending.action === 'capture' ? decodeFrame(message.result) : message.result); }
    catch (error) { finish(error); }
  });
  lines.on('close', () => terminate(new Error('adapter closed')));
  lines.on('error', () => terminate(new Error('adapter output failed')));
  input.on('error', () => terminate(new Error('adapter input failed')));

  async function request(request = {},{signal}={},requestSource=source) {
    if(!['codex','agent'].includes(requestSource))throw new Error('invalid VM operator source');
    signal?.throwIfAborted();
    if (enabled!==true&&!enabledForFixture) throw new Error('VM protocol is disabled');
    if (!request || typeof request!=='object' || Array.isArray(request)) throw new Error('invalid VM request');
    if (Object.hasOwn(request,'source') || Object.hasOwn(request,'controlEpoch')) throw new Error('VM control fields are host-bound');
    const {vmId,action,args}=request;
    if (vmId !== TARGET) throw new Error('VM target mismatch');
    const normalized = actionArgs(action, args);
    if (closed) throw new Error('adapter closed');
    if (control.controlEpoch===null) throw new Error('VM console connection unavailable');
    if (pending) throw new Error('another request is pending');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const epoch=control.controlEpoch;
      const timer = setTimeout(() => {
        const wasAborted=pending?.id===id&&(pending.aborted||pending.revocationError);
        terminate(new Error(wasAborted?'VM cancellation drain unconfirmed; adapter closed':'adapter timeout'));
      }, timeoutMs);
      const onAbort=()=>{
        if(pending?.id!==id||pending.aborted)return;
        pending.aborted=true;
        pending.abortError=signal.reason instanceof Error?signal.reason:new DOMException('VM request aborted','AbortError');
        try{
          input.write(JSON.stringify({type:'cancel-request',id,vmId:TARGET,source:requestSource,controlEpoch:epoch})+'\n',error=>{
            if(error&&pending?.id===id)terminate(new Error('VM cancellation delivery failed; adapter closed'));
          });
        }catch{terminate(new Error('VM cancellation delivery failed; adapter closed'));}
      };
      pending = { id, action, resolve, reject, timer,signal,onAbort,aborted:false,abortError:null,revocationError:null };
      try{
        input.write(JSON.stringify({ id, vmId: TARGET, action, args: normalized, source:requestSource, controlEpoch:epoch,
          expiresAtUtcMs:Date.now()+Math.min(timeoutMs,10000) }) + '\n', (error) => {
          if (error && pending?.id === id) terminate(new Error('adapter input failed'));
        });
      }catch{terminate(new Error('adapter input failed'));}
      if(pending?.id===id){
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
      }
    });
  }

  function debugSnapshot(){
    if(closed)throw new Error('adapter closed');
    if(debugPending)throw new Error('VM debug query pending');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{if(debugPending?.id===id){debugPending=null;reject(new Error('VM debug query timeout'));}},3000);
      debugPending={id,timer,resolve,reject};
      input.write(JSON.stringify({type:'debug-snapshot',id,vmId:TARGET})+'\n',error=>{
        if(error&&debugPending?.id===id){clearTimeout(timer);debugPending=null;reject(new Error('VM debug query failed'));}
      });
    });
  }
  return Object.freeze({source,request:(requestValue,options)=>request(requestValue,options),
    requestAsOperator:(requestValue,options)=>request(requestValue,options,'codex'),debugSnapshot,
    controlState:()=>({...control}),executionState:()=>Object.freeze({pending:Boolean(pending),closed,releaseUnconfirmed}),subscribeControlState(listener){
    if(typeof listener!=='function')throw new TypeError('VM control listener required');
    controlListeners.add(listener);
    try{listener(Object.freeze({...control}));}catch(error){controlListeners.delete(listener);throw error;}
    return ()=>controlListeners.delete(listener);
  },close(){
    terminate(new Error('adapter closed'));lines.close();
    controlListeners.clear();
  }});
}
