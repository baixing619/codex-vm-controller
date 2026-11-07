import {ExclusiveActivityOwner} from './exclusive-activity-owner.mjs';
const fault=code=>Object.assign(new Error(code),{code});
// One VM lease, shared by every local operator.
export function createSharedVmActivity(entry){
  const owner=new ExclusiveActivityOwner();
  const epoch=expected=>{
    const state=entry.controlState();
    if(!Number.isSafeInteger(state?.controlEpoch)||state.controlEpoch<0||expected!==undefined&&state.controlEpoch!==expected)throw fault('vm_control_unavailable');
    return state.controlEpoch;
  };
  function assertLease(expected){
    const current=owner.status();
    if(!expected||current.kind!=='vm'||current.state!=='active'||current.id!==expected.id||current.generation!==expected.generation)throw fault('vm_lease_stale');
    if(current.pending!==0)throw fault('vm_execution_pending');
  }
  return Object.freeze({
    status:()=>owner.status(),
    available:kind=>{if(kind!=='vm')return false;try{epoch();const s=owner.status();return !s.kind||s.kind==='vm'&&s.state==='active';}catch{return false;}},
    async runVm(operation,{signal}={}){
      signal?.throwIfAborted();const expected=epoch();
      return owner.run('vm',async capability=>{
        const combined=signal?AbortSignal.any([signal,capability.signal]):capability.signal;
        combined.throwIfAborted();epoch(expected);
        const result=await operation({...capability,signal:combined,entry,controlEpoch:expected});
        capability.assertCurrent();combined.throwIfAborted();epoch(expected);return result;
      });
    },
    async finishVm(lease){
      assertLease(lease);const drained=await entry.drain();assertLease(lease);
      const result=await owner.stop('vm',async()=>({released:drained?.executionDrained===true&&drained.ownerWindowClosed===false,value:drained}));
      return result.value;
    }
  });
}
