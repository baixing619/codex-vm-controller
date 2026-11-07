// Owned host entry. Construction never launches; only explicit start()
// may own the configured background controller.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createVmRouter} from './vm-console-router.mjs';
import {normalizeVmId} from './config.mjs';
export function createVmTaskEntry({vmId,router,source,enabled=false,ownerContext,consolePath,backgroundConsolePath,policyPath,spawnOwner=spawn}={}) {
  const TARGET=normalizeVmId(vmId);
  let closed=false,terminated=false,busy=false,owner=null,starting=null,stopped=null,closing=null,lastOwnerExit=null;
  let idle=Promise.resolve();
  let actionRevision=0;
  const controlListeners=new Set();let unsubscribeRouter=null;
  const controlState=()=>!closed&&router?.controlState?.()||{source:'manual',controlEpoch:null};
  function publishControl(){
    const state=Object.freeze({...controlState()});
    for(const listener of [...controlListeners]){try{listener(state);}catch{}}
  }
  function attachControl(){unsubscribeRouter?.();unsubscribeRouter=router?.subscribeControlState?.(()=>publishControl())??null;}
  attachControl();
  function assertEnabled(){
    if(closed)throw new Error('VM task entry closed');
    if(enabled!==true)throw new Error('VM task entry disabled');
    if(source==='codex'&&(!ownerContext||ownerContext.kind!=='local_operator'))throw new Error('Explicit local operator identity required');
    if(!['codex','agent'].includes(source))throw new Error('Explicit VM source required');
    if(router&&router.source!==source)throw new Error('VM router source mismatch');
  }
  async function start(){
    if(closed&&!terminated){
      const execution=router?.executionState?.();
      if(lastOwnerExit?.clean!==true||busy||execution?.pending||execution?.releaseUnconfirmed)
        throw new Error('VM previous owner release unconfirmed; no replacement launched');
      // Only a confirmed normal user-window exit permits a later explicit start.
      // A service close(), failed launch or uncertain native drain remains terminal.
      unsubscribeRouter?.();unsubscribeRouter=null;
      router=null;owner=null;starting=null;stopped=null;closing=null;lastOwnerExit=null;closed=false;
      publishControl();
    }
    assertEnabled();
    if(starting)return starting;
    if(router)throw new Error('VM transport already supplied; no owner launched');
    if(typeof consolePath!=='string'||!path.isAbsolute(consolePath)||!consolePath.toLowerCase().endsWith('.exe'))
      throw new Error('Configured absolute VM console executable required');
    starting=(async()=>{
      const executable=backgroundConsolePath??consolePath;
      if(backgroundConsolePath&&(!path.isAbsolute(backgroundConsolePath)||path.basename(backgroundConsolePath)!=='PreparedBackgroundController.exe'||path.dirname(backgroundConsolePath)!==path.dirname(consolePath)))
        throw new Error('Fixed background VM controller required');
      owner=spawnOwner(executable,[backgroundConsolePath?'--background-protocol':'--protocol'],{cwd:path.dirname(executable),shell:false,
        windowsHide:Boolean(backgroundConsolePath),stdio:['pipe','pipe','pipe'],
        ...(policyPath?{env:{...process.env,VM_CONTROLLER_POLICY:policyPath}}:{})});
      stopped=new Promise((resolve,reject)=>{
        owner.once('error',reject);owner.once('exit',(code,signal)=>resolve({code,signal}));
      });
      // A launch error is also observed by start(); retain its stop evidence
      // without an unhandled rejection if the caller has not closed yet.
      stopped.catch(()=>{});
      owner.once('exit',(code,signal)=>{
        const execution=router?.executionState?.();
        const clean=code===0&&signal===null&&!busy&&execution?.pending===false&&execution?.releaseUnconfirmed===false;
        closed=true;router?.close();lastOwnerExit={code,signal,clean};publishControl();
      });
      owner.stderr.resume(); // Never log private native output.
      await new Promise((resolve,reject)=>{owner.once('spawn',resolve);owner.once('error',reject);});
      if(closed)throw new Error('VM task entry closed during launch');
      router=createVmRouter({vmId:TARGET,input:owner.stdin,output:owner.stdout,source,enabled:true,timeoutMs:8000});
      attachControl();
      return {ownerPid:owner.pid,transportAttached:true,guestReadinessVerified:false};
    })().catch(error=>{closed=true;throw error;});
    return starting;
  }
  function close(){
    terminated=true;closed=true;
    if(closing)return closing;
    unsubscribeRouter?.();unsubscribeRouter=null;publishControl();controlListeners.clear();
    if(!owner)return Promise.resolve({entryClosed:true});
    router?.close();
    // readline.close pauses its input. Keep discarding this owned stdout so a
    // large in-flight PNG cannot block the child before it can observe EOF.
    owner.stdout.resume();
    if(!owner.stdin.destroyed&&!owner.stdin.writableEnded)owner.stdin.end();
    closing=(async()=>{
      let timer;
      try{
        const result=await Promise.race([stopped,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('VM owner release unconfirmed; no replacement launched')),5000);
        })]);
        if(result.code!==0||result.signal!==null)throw new Error('VM owner did not exit normally; release unconfirmed');
        return {resourceReleased:true,ownerStopped:result};
      }finally{clearTimeout(timer);}
    })();
    return closing;
  }
  return Object.freeze({
    source,start,close,controlState,
    transportStatus:()=>({ownerPid:owner?.pid??null,background:Boolean(backgroundConsolePath),busy,closed,actionRevision,lastOwnerExit,execution:router?.executionState?.()??null}),
    debugSnapshot:()=>{assertEnabled();if(typeof router?.debugSnapshot!=='function')throw new Error('VM debug unavailable');return router.debugSnapshot();},
    async drain(){
      await idle;
      const execution=router?.executionState?.();
      if(execution?.releaseUnconfirmed)throw new Error('VM execution drain unconfirmed');
      if(busy||execution?.pending)throw new Error('VM execution still pending');
      return {executionDrained:true,ownerWindowClosed:false};
    },subscribeControlState(listener){
      if(typeof listener!=='function')throw new TypeError('VM control listener required');
      controlListeners.add(listener);
      try{listener(Object.freeze({...controlState()}));}catch(error){controlListeners.delete(listener);throw error;}
      return ()=>controlListeners.delete(listener);
    },
    execute:(request,options)=>executeBound(request,options,false),
    executeOperator:(request,options)=>executeBound(request,options,true)
  });
  async function executeBound(request,{signal}={},operator=false) {
      assertEnabled();
      if(request&&(Object.hasOwn(request,'source')||Object.hasOwn(request,'controlEpoch')))throw new Error('VM control fields are host-bound');
      if(request?.vmId!==TARGET)throw new Error('VM target mismatch');
      if(!['capture','key','click','type_text'].includes(request.action))throw new Error('VM capability not prepared');
      signal?.throwIfAborted();
      if(busy)throw new Error('VM task already pending');
      if(typeof router?.request!=='function')throw new Error('VM transport unavailable');
      const {controlEpoch}=router.controlState?.()??{};
      if(!Number.isSafeInteger(controlEpoch)||controlEpoch<0)
        throw new Error('VM console connection unavailable');
      busy=true;
      if(request.action!=='capture')actionRevision++;
      let resolveIdle;idle=new Promise(resolve=>{resolveIdle=resolve;});
      try {
        const result=await (operator?router.requestAsOperator(request,{signal}):router.request(request,{signal}));
        signal?.throwIfAborted();
        if(closed)throw new Error('VM task entry closed');
        const current=router.controlState?.();
        if(current?.controlEpoch!==controlEpoch)
          throw new Error('VM cancellation epoch changed; task cancelled');
        return {summary:`VM ${request.action} adapter receipt; guest effect requires visual verification`,
          ...(request.action==='capture'?{frame:result}:{receipt:result}),source:operator?'codex':source};
      } finally {busy=false;resolveIdle();}
  }
}
