import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readPolicy,readConnection,normalizeVmId} from './config.mjs';

const endpoint='/api/vm-desktop/controller';
const allowed={status:[],connect:[],debug:[],cancel:[],capture:['--directory'],click:['--directory','--x','--y','--button'],key:['--directory','--key'],type:['--directory','--text','--text-file']};
function parse(argv){
  const args=[...argv],command=args.shift(),options={};
  if(!Object.hasOwn(allowed,command))throw Error('Use status/connect/capture/click/key/type/debug/cancel');
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!key?.startsWith('--')||value===undefined||Object.hasOwn(options,key)||!['--home',...allowed[command]].includes(key))throw Error('Invalid options');
    options[key]=value;
  }
  return {command,options};
}
// This skill is self-contained. Its protected configuration reader is shipped beside it.
export async function runController(argv,{
  env=process.env,loadPolicy=readPolicy,loadConnection=readConnection,fetchImpl=fetch,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now
}={}){
  const {command,options}=parse(argv);
  const configuration=await loadPolicy({home:options['--home'],env});
  const connection=await loadConnection(configuration);
  const VM=configuration.policy.vmId;
  const directory=options['--directory']?path.resolve(options['--directory']):null;
  function requireDirectory(){if(!directory)throw Error('--directory is required');}
  async function request(route,body){
    const response=await fetchImpl(new URL(route,connection.baseURL),{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{authorization:'Bearer '+connection.token,...(body===undefined?{}:{'content-type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify({directorToken:connection.token,...body})}),signal:AbortSignal.timeout(30000)});
    let value;try{value=await response.json();}catch{throw Error('Controller returned invalid JSON');}
    if(!response.ok)throw Error(typeof value.error==='string'?value.error:'Controller request failed');
    return value;
  }
  async function saveFrame(frame){
    requireDirectory();
    if(frame?.vmId!==VM||frame.source!=='codex'||!['image/png','image/jpeg'].includes(frame.mime)||
      !Number.isSafeInteger(frame.controlEpoch)||frame.controlEpoch<0||!Number.isSafeInteger(frame.actionRevision)||frame.actionRevision<0||
      !Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||frame.width>8192||frame.height>8192||
      !Number.isSafeInteger(frame.capturedAtMs)||typeof frame.sha256!=='string'||!/^[a-f0-9]{64}$/.test(frame.sha256)||
      typeof frame.data!=='string'||frame.data.length>4300000)throw Error('Invalid guest frame');
    normalizeVmId(frame.id);
    const bytes=Buffer.from(frame.data,'base64');
    if(bytes.toString('base64')!==frame.data||!bytes.length||bytes.length>3*1024*1024||createHash('sha256').update(bytes).digest('hex')!==frame.sha256)throw Error('Invalid frame bytes');
    const framePath=path.join(directory,'current-frame.'+(frame.mime==='image/png'?'png':'jpg'));
    const metadataPath=path.join(directory,'current-frame.json');
    let previous;try{previous=JSON.parse(await fs.readFile(metadataPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const metadata={id:frame.id,vmId:VM,source:'codex',controlEpoch:frame.controlEpoch,width:frame.width,height:frame.height,
      capturedAtMs:frame.capturedAtMs,sha256:frame.sha256,actionRevision:frame.actionRevision,mime:frame.mime,
      serviceInstanceId:connection.instanceId,framePath};
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(framePath,bytes);await fs.writeFile(metadataPath,JSON.stringify(metadata,null,2)+'\n');
    if(previous?.vmId===VM&&previous.framePath&&previous.framePath!==framePath&&['current-frame.png','current-frame.jpg'].includes(path.basename(previous.framePath))&&path.dirname(previous.framePath)===directory)
      await fs.unlink(previous.framePath).catch(error=>{if(error.code!=='ENOENT')throw error;});
    return metadata;
  }
  let value,exitCode=0;
  if(command==='status')value=await request(endpoint);
  else if(command==='connect'){
    value=await request(endpoint+'/connect',{});const deadline=now()+35000;
    while(!value.connected&&now()<deadline&&!value.transport?.closed){await sleep(500);value=await request(endpoint);}
    if(!value.connected)exitCode=1;
  }else if(command==='debug'||command==='cancel')value=await request(endpoint+'/'+command,{});
  else if(command==='capture')value=await saveFrame(await request(endpoint+'/capture',{}));
  else{
    requireDirectory();
    const previous=JSON.parse(await fs.readFile(path.join(directory,'current-frame.json'),'utf8'));
    if(previous.vmId!==VM||previous.serviceInstanceId!==connection.instanceId||typeof previous.id!=='string')throw Error('View a current guest frame first');
    let action,args;
    if(command==='click'){
      if(!/^\d+$/.test(options['--x']??'')||!/^\d+$/.test(options['--y']??''))throw Error('Integer guest coordinates are required');
      action='click';args={x:Number(options['--x']),y:Number(options['--y']),button:options['--button']??'left'};
    }else if(command==='key'){action='key';args={key:options['--key']};}
    else{
      action='type_text';
      if((options['--text']===undefined)===(options['--text-file']===undefined))throw Error('Choose --text or --text-file');
      if(options['--text-file']!==undefined){
        const textPath=path.resolve(options['--text-file']);
        if((await fs.stat(textPath)).size>4000)throw Error('Text file is too large');
        args={text:await fs.readFile(textPath,'utf8')};
      }else args={text:options['--text']};
    }
    const result=await request(endpoint+'/action',{action,args,frameId:previous.id});
    const {frame,...receipt}=result;value={...receipt,frame:await saveFrame(frame)};
  }
  return {value,exitCode};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runController(process.argv.slice(2));if(result.value)console.log(JSON.stringify(result.value));process.exitCode=result.exitCode;}
  catch(error){
    const message=error.code==='ENOENT'?'Controller is not configured or running. Use Configure.ps1 and Start.cmd first.':String(error.message??'Controller failed');
    console.error(/^[a-zA-Z0-9 _:.\/-]{1,180}$/.test(message)?message:'Controller request failed');process.exitCode=1;
  }
}
