import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const kinds=new Set(['vm']);
function fault(code,message){return Object.assign(new Error(message),{code});}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return{promise,resolve,reject};}

// Serial execution leases remain held until native execution has drained.
export class ExclusiveActivityOwner {
  #scope=new AsyncLocalStorage();
  #owner=null;
  #generation=0;
  constructor({onTransition=async()=>{},clock=()=>Date.now()}={}){
    this.onTransition=onTransition;this.clock=clock;
  }
  status(){
    const o=this.#owner;
    return o?{kind:o.kind,id:o.id,generation:o.generation,state:o.state,pending:o.tasks.size,startedAt:o.startedAt}:
      {kind:null,id:null,generation:this.#generation,state:'idle',pending:0,startedAt:null};
  }
  #assert(o){
    if(this.#owner!==o||o.controller.signal.aborted||o.state!=='active')
      throw fault('activity_cancelled','这轮活动已停止，迟到结果不能重新启动活动');
  }
  #newOwner(kind,{closing=false}={}){
    if(!kinds.has(kind))throw fault('invalid_activity','未知活动');
    const o={kind,id:randomUUID(),generation:++this.#generation,state:'active',controller:new AbortController(),
      tasks:new Set(),tail:Promise.resolve(),startedAt:this.clock(),release:deferred(),closeTask:null,
      releaseProof:false,closeSettled:false,releasing:null,releaseSettled:false,recordStarted:false};
    this.#owner=o;
    // An untracked cleanup needs the same release gate, but it is not evidence
    // that a virtual machine action was admitted or actually happened.
    o.ready=closing?Promise.resolve():Promise.resolve().then(async()=>{
      try{await this.#record(o,'active');o.recordStarted=true;}
      catch(error){o.controller.abort(fault('activity_cancelled','活动记录失败，未开始执行'));o.state='release_unknown';throw error;}
    });
    o.ready.catch(()=>{});
    return o;
  }
  #record(o,status){
    return this.onTransition({externalId:`exclusive:${o.id}`,type:o.kind,
      label:'虚拟机活动占用',status,source:'exclusive_activity_owner',
      occurredAt:this.clock(),reasonCode:status==='active'?'activity_acquired':'activity_physically_released',
      reason:status==='active'?'开始占用同一活动通道':'操作已排空且资源释放已确认'});
  }
  async run(kind,operation){
    if(typeof operation!=='function'||!kinds.has(kind))throw fault('invalid_activity','活动调用无效');
    const nested=this.#scope.getStore();
    if(nested)this.#assert(nested.owner);
    let o=this.#owner;
    if(o&&(o.kind!==kind||o.state!=='active'))throw fault('activity_busy','另一项活动尚未结束或释放未确认');
    if(!o)o=this.#newOwner(kind);
    const inline=nested?.owner===o&&nested.active;
    const before=inline?nested.tail:o.tail;
    const executing=before.catch(()=>{}).then(async()=>{
      await o.ready;this.#assert(o);
      const capability=Object.freeze({id:o.id,generation:o.generation,signal:o.controller.signal,assertCurrent:()=>this.#assert(o)});
      const scope={owner:o,active:true,tail:Promise.resolve()};
      return this.#scope.run(scope,async()=>{
        let value,error,failed=false;
        try{value=await operation(capability);}catch(e){failed=true;error=e;}
        try{
          for(;;){
            const tail=scope.tail;
            try{await tail;}catch(e){if(!failed){failed=true;error=e;}}
            if(tail===scope.tail)break;
          }
        }finally{scope.active=false;}
        if(failed)throw error;
        return value;
      });
    });
    let tracked;
    tracked=executing.finally(async()=>{o.tasks.delete(tracked);await this.#maybeRelease(o);});
    o.tasks.add(tracked);
    if(inline)nested.tail=tracked.catch(()=>{});else o.tail=tracked.catch(()=>{});
    return tracked;
  }
  async stop(kind,closeAndVerify){
    if(!kinds.has(kind)||typeof closeAndVerify!=='function')throw fault('invalid_activity','活动停止调用无效');
    const nested=this.#scope.getStore();
    if(nested&&this.#owner!==nested.owner)throw fault('activity_cancelled','旧活动不能关闭新一轮活动');
    const o=this.#owner??this.#newOwner(kind,{closing:true});
    if(o.kind!==kind)throw fault('activity_busy','不会关闭另一项活动');
    if(o.releaseSettled){o.release=deferred();o.releaseSettled=false;o.releasing=null;}
    o.state='stopping';o.controller.abort(fault('activity_cancelled','活动已停止'));
    if(!o.closeTask){
      o.closeTask=Promise.resolve().then(closeAndVerify).then(result=>{
        o.closeSettled=true;
        if(result?.released!==true)throw fault('activity_release_unknown','资源释放未确认，继续保留活动占用');
        o.releaseProof=true;o.closeResult=result.value;return result;
      }).catch(error=>{o.closeSettled=true;o.state='release_unknown';o.closeTask=null;throw error;});
    }
    await o.closeTask;
    await o.ready.catch(()=>{});
    await this.#maybeRelease(o);
    if(this.#scope.getStore()?.owner===o&&o.tasks.size>0)return {released:false,pending:true,value:o.closeResult};
    return o.release.promise;
  }
  async #maybeRelease(o){
    if(!o.releaseProof||!o.closeSettled||o.tasks.size||o.state==='active')return;
    if(o.releasing)return o.releasing;
    o.releasing=Promise.resolve().then(async()=>{
      try{
        if(o.recordStarted)await this.#record(o,'completed');
        if(this.#owner===o)this.#owner=null;
        o.releaseSettled=true;o.release.resolve({released:true,pending:false,value:o.closeResult});
      }catch(error){
        o.state='release_unknown';o.releaseSettled=true;o.releasing=null;o.release.reject(error);throw error;
      }
    });
    return o.releasing;
  }
}
