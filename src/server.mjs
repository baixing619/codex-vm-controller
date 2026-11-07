import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readPolicy,validatePolicy,publishConnection,removeConnection} from './config.mjs';
import {createVmTaskEntry} from './vm-task-entry.mjs';
import {createVmComputerController} from './vm-computer-controller.mjs';
import {createSharedVmActivity} from './shared-vm-activity.mjs';

const prefix='/api/vm-desktop/controller';
const sameSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function send(response,status,payload){
  if(response.destroyed||response.writableEnded)return;
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(JSON.stringify(payload));
}
async function bodyJson(request){
  if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){
    request.resume();throw Object.assign(new Error('json_required'),{status:415});
  }
  return new Promise((resolve,reject)=>{
    let count=0,settled=false;const chunks=[];
    const refuse=error=>{if(!settled){settled=true;reject(error);}};
    request.on('data',chunk=>{
      count+=chunk.length;
      if(count>4096){chunks.length=0;refuse(Object.assign(new Error('request_too_large'),{status:413}));}
      else if(!settled)chunks.push(chunk);
    });
    request.once('aborted',()=>refuse(Object.assign(new Error('request_aborted'),{status:400})));
    request.once('error',()=>refuse(Object.assign(new Error('request_failed'),{status:400})));
    request.once('end',()=>{
      if(settled)return;
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse(Object.assign(new Error('invalid_json'),{status:400}));return;}
      if(!value||typeof value!=='object'||Array.isArray(value)){refuse(Object.assign(new Error('invalid_arguments'),{status:400}));return;}
      settled=true;resolve(value);
    });
  });
}
// Construction and import never load a real policy, create a connection or launch a process.
export function createControllerServer({
  configuration,createEntry=createVmTaskEntry,nativeDirectory=fileURLToPath(new URL('../bin/',import.meta.url)),
  publish=publishConnection,unpublish=removeConnection,verifyConfiguration=async()=>{},
  securityCheck,token=randomBytes(32).toString('base64url'),instanceId=randomUUID()
}={}){
  if(!configuration||typeof configuration.home!=='string'||typeof configuration.policyPath!=='string'||!/^[a-f0-9]{64}$/.test(configuration.policySha256??''))throw Error('invalid_configuration');
  const policy=validatePolicy(configuration.policy);
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('invalid_server_token');
  let active=true,started=false,closing=null,connection=null;
  const executable=path.resolve(nativeDirectory,'PreparedBackgroundController.exe');
  const entry=createEntry({vmId:policy.vmId,source:'codex',enabled:true,
    ownerContext:Object.freeze({kind:'local_operator',ownerSid:policy.ownerSid,instanceId}),
    consolePath:executable,backgroundConsolePath:executable,policyPath:configuration.policyPath});
  const sharedActivity=createSharedVmActivity(entry);
  const controller=createVmComputerController({vmId:policy.vmId,entry,sharedActivity,canOperate:()=>active});
  const server=http.createServer(async(request,response)=>{
    let url;
    try{url=new URL(request.url,'http://127.0.0.1');}catch{send(response,400,{error:'invalid_url'});return;}
    const address=server.address();
    const expectedHost=address&&typeof address==='object'?'127.0.0.1:'+address.port:null;
    if(!expectedHost||request.headers.host!==expectedHost||request.headers.origin||request.headers['sec-fetch-site']==='cross-site'||
      !['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)){
      send(response,403,{error:'loopback_client_required'});return;
    }
    if(!sameSecret(request.headers.authorization,'Bearer '+token)){send(response,403,{error:'vm_controller_owner_required'});return;}
    if(url.search||url.hash){send(response,400,{error:'invalid_url'});return;}
    if(url.pathname===prefix&&request.method==='GET'){
      send(response,200,{configured:true,...controller.status(),instanceId});return;
    }
    if(!url.pathname.startsWith(prefix+'/')||request.method!=='POST'){send(response,404,{error:'not_found'});return;}
    const operation=url.pathname.slice((prefix+'/').length);
    if(!['connect','capture','action','debug','cancel'].includes(operation)){send(response,404,{error:'not_found'});return;}
    const requestAbort=new AbortController();
    const abort=()=>requestAbort.abort(new Error('vm_operator_client_disconnected'));
    const responseClosed=()=>{if(!response.writableEnded)abort();};
    request.once('aborted',abort);response.once('close',responseClosed);
    try{
      if(!active)throw Error('controller_stopping');
      const body=await bodyJson(request);
      if(!sameSecret(body.directorToken,token)){send(response,403,{error:'vm_controller_owner_required'});return;}
      const fields=operation==='action'?['directorToken','action','args','frameId']:['directorToken'];
      if(Object.keys(body).length!==fields.length||Object.keys(body).some(key=>!fields.includes(key))){
        send(response,400,{error:'vm_controller_invalid_args'});return;
      }
      if(request.aborted||response.destroyed)abort();
      let result;
      if(operation==='connect'){
        await verifyConfiguration(configuration);
        result=await controller.connect({signal:requestAbort.signal});
      }else if(operation==='capture')result=await controller.capture({signal:requestAbort.signal});
      else if(operation==='action')result=await controller.action({action:body.action,args:body.args,frameId:body.frameId},{signal:requestAbort.signal});
      else if(operation==='debug')result=await controller.debug();
      else result=controller.cancel();
      send(response,operation==='connect'&&!result.connected?202:200,result);
    }catch(error){
      const message=String(error?.message??'vm_controller_failed');
      send(response,error?.status??409,{error:/^[a-zA-Z0-9 _:.\/-]{1,180}$/.test(message)?message:'vm_controller_failed'});
    }finally{request.off('aborted',abort);response.off('close',responseClosed);}
  });
  server.requestTimeout=35000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
  return Object.freeze({
    async start(){
      if(started||!active)throw Error('controller_already_started');
      started=true;
      await new Promise((resolve,reject)=>{
        const failed=error=>{server.off('listening',resolve);reject(error);};
        server.once('error',failed);
        server.listen(0,'127.0.0.1',()=>{server.off('error',failed);resolve();});
      });
      const baseURL='http://127.0.0.1:'+server.address().port+'/';
      connection=Object.freeze({schemaVersion:1,baseURL,token,instanceId,pid:process.pid,vmId:policy.vmId,policySha256:configuration.policySha256});
      try{await publish(configuration,connection,{securityCheck});}
      catch(error){active=false;await new Promise(resolve=>server.close(resolve));throw error;}
      return {baseURL,instanceId};
    },
    close(){
      if(closing)return closing;
      active=false;controller.cancel();
      closing=(async()=>{
        const httpClosed=new Promise(resolve=>{if(!server.listening)resolve();else server.close(resolve);});
        const stopped=await Promise.allSettled([entry.close(),httpClosed]);
        if(connection)await unpublish(configuration,connection,{securityCheck});
        if(stopped[0].status==='rejected')throw stopped[0].reason;
        return {closed:true,owner:stopped[0].value};
      })();
      return closing;
    }
  });
}
export async function startControllerServer({home,env=process.env,securityCheck,createEntry,...options}={}){
  const configuration=await readPolicy({home,env,securityCheck});
  const service=createControllerServer({...options,configuration,createEntry,securityCheck,
    verifyConfiguration:async expected=>{
      const current=await readPolicy({home:expected.home,env:{...env,VM_CONTROLLER_POLICY:expected.policyPath},securityCheck});
      if(current.policySha256!==expected.policySha256)throw Error('controller_policy_changed_restart_required');
    }});
  await service.start();return service;
}
function mainOptions(argv){
  if(argv.length===0)return {};
  if(argv.length===2&&argv[0]==='--home'&&argv[1].trim())return {home:argv[1]};
  throw Error('Use server.mjs [--home directory]');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const service=await startControllerServer(mainOptions(process.argv.slice(2)));
    console.log('VM computer controller is listening on loopback. Native control starts only on connect.');
    const stop=async()=>{try{await service.close();}catch{console.error('controller_shutdown_unconfirmed');process.exitCode=1;}};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }catch(error){
    const code=error.code==='ENOENT'?'controller_not_configured_run_Configure_ps1':String(error.code??error.message??'controller_start_failed');
    console.error(/^[a-zA-Z0-9_ .:-]{1,180}$/.test(code)?code:'controller_start_failed');process.exitCode=1;
  }
}
