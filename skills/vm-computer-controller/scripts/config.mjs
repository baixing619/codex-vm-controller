import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const execFileAsync=promisify(execFile);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function normalizeVmId(value){
  if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value))fail('invalid_vm_id');
  return value.toLowerCase();
}
export function validatePolicy(value){
  if(!exact(value,['schemaVersion','vmId','ownerSid','hostMachine'])||value.schemaVersion!==1)fail('invalid_policy');
  const vmId=normalizeVmId(value.vmId);
  if(typeof value.ownerSid!=='string'||!/^S-1-\d+(?:-\d+){1,14}$/.test(value.ownerSid))fail('invalid_policy_owner');
  if(typeof value.hostMachine!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value.hostMachine))fail('invalid_policy_host');
  return Object.freeze({...value,vmId});
}
export function resolveControllerHome({home,env=process.env,platform=process.platform}={}){
  const selected=home??env.VM_CONTROLLER_HOME;
  if(selected!==undefined){
    if(typeof selected!=='string'||!selected.trim())fail('controller_home_required');
    return path.resolve(selected);
  }
  if(platform==='win32'){
    if(!env.LOCALAPPDATA||!path.isAbsolute(env.LOCALAPPDATA))fail('controller_home_required');
    return path.join(env.LOCALAPPDATA,'VmComputerController');
  }
  return path.join(os.homedir(),'.local','share','VmComputerController');
}
const aclScript="$ErrorActionPreference='Stop'\n$p=$env:VM_CONTROLLER_CHECK_PATH\n$attributes=[IO.File]::GetAttributes($p)\nif(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}\n$isDirectory=($attributes -band [IO.FileAttributes]::Directory) -ne 0\n$identity=[Security.Principal.WindowsIdentity]::GetCurrent()\n$current=$identity.User.Value\n$acl=if($isDirectory){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}\n$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value\nif($owner -ne $current){throw 'owner'}\nif($isDirectory -and -not $acl.AreAccessRulesProtected){throw 'inheritance'}\n$allowed=@($current,'S-1-5-18','S-1-5-32-544')\nforeach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){\n if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value){throw 'access'}\n}\n[Console]::Write($current)";
export async function assertPrivatePath(filePath,{directory=false,platform=process.platform,env=process.env}={}){
  const absolute=path.resolve(filePath);
  const parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);const item=await fs.lstat(cursor);
    if(item.isSymbolicLink())fail('unsafe_controller_path');
  }
  const item=await fs.lstat(absolute);
  if(directory?!item.isDirectory():!item.isFile())fail('unsafe_controller_path');
  if(platform==='win32'){
    const systemRoot=env.SystemRoot??env.WINDIR;
    if(!systemRoot||!path.isAbsolute(systemRoot))fail('windows_security_unavailable');
    const shell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    try{
      const {stdout}=await execFileAsync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',aclScript],{
        windowsHide:true,timeout:10000,maxBuffer:8192,env:{...env,VM_CONTROLLER_CHECK_PATH:absolute}
      });
      const sid=stdout.trim();
      if(!/^S-1-\d+(?:-\d+){1,14}$/.test(sid))fail('unsafe_controller_permissions');
      return {ownerSid:sid};
    }catch{fail('unsafe_controller_permissions');}
  }
  if(typeof process.getuid==='function'&&item.uid!==process.getuid()||(item.mode&0o077)!==0)fail('unsafe_controller_permissions');
  return {ownerSid:null};
}
async function readProtectedJson(filePath,{home,securityCheck=assertPrivatePath,maxBytes=16384}={}){
  const homeIdentity=await securityCheck(home,{directory:true});
  const identity=await securityCheck(filePath);
  const handle=await fs.open(filePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size<2||stat.size>maxBytes)fail('invalid_controller_file');
    const content=await handle.readFile({encoding:'utf8'});
    if(Buffer.byteLength(content)>maxBytes)fail('invalid_controller_file');
    let value;try{value=JSON.parse(content);}catch{fail('invalid_controller_json');}
    return {value,content,ownerSid:identity?.ownerSid??homeIdentity?.ownerSid??null};
  }finally{await handle.close();}
}
export async function readPolicy({home,env=process.env,securityCheck=assertPrivatePath,platform=process.platform,hostname=os.hostname()}={}){
  home=resolveControllerHome({home,env});
  const expected=path.join(home,'policy.json');
  const policyPath=env.VM_CONTROLLER_POLICY?path.resolve(env.VM_CONTROLLER_POLICY):expected;
  if(policyPath!==expected)fail('policy_must_belong_to_controller_home');
  const read=await readProtectedJson(policyPath,{home,securityCheck});
  const policy=validatePolicy(read.value);
  if(read.ownerSid&&policy.ownerSid!==read.ownerSid)fail('policy_owner_mismatch');
  if(platform==='win32'&&policy.hostMachine.toLowerCase()!==hostname.toLowerCase())fail('policy_host_mismatch');
  return Object.freeze({home,policyPath,policy,policySha256:createHash('sha256').update(read.content).digest('hex')});
}
export function validateConnection(value,configuration){
  if(!exact(value,['schemaVersion','baseURL','token','instanceId','pid','vmId','policySha256'])||value.schemaVersion!==1)fail('invalid_controller_connection');
  let url;try{url=new URL(value.baseURL);}catch{fail('invalid_controller_connection');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1||Number(url.port)>65535||url.pathname!=='/'||url.username||url.password||url.search||url.hash||url.href!==value.baseURL)fail('invalid_controller_connection');
  if(typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||!Number.isSafeInteger(value.pid)||value.pid<1)fail('invalid_controller_connection');
  normalizeVmId(value.instanceId);
  if(value.vmId!==configuration.policy.vmId||value.policySha256!==configuration.policySha256)fail('controller_binding_mismatch');
  return Object.freeze({...value});
}
export async function readConnection(configuration,{securityCheck=assertPrivatePath}={}){
  const read=await readProtectedJson(path.join(configuration.home,'connection.json'),{home:configuration.home,securityCheck});
  if(read.ownerSid&&read.ownerSid!==configuration.policy.ownerSid)fail('connection_owner_mismatch');
  return validateConnection(read.value,configuration);
}
const createdConnectionAclScript="$ErrorActionPreference='Stop'\n$p=$env:VM_CONTROLLER_CREATED_PATH\n$file=[IO.FileInfo]::new($p)\nif(-not $file.Exists -or $file.Length -ne 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'created-file-invalid'}\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User\n$acl=[Security.AccessControl.FileSecurity]::new()\n$acl.SetAccessRuleProtection($true,$false)\n$acl.SetOwner($sid)\nforeach($who in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))){\n $rule=[Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)\n $acl.AddAccessRule($rule)\n}\n[IO.File]::SetAccessControl($p,$acl)\n[Console]::Write('private-empty-file')";
async function protectCreatedConnection(filePath,{platform=process.platform,env=process.env}={}){
  if(platform!=='win32')return;
  const systemRoot=env.SystemRoot??env.WINDIR;
  if(!systemRoot||!path.isAbsolute(systemRoot))fail('windows_security_unavailable');
  const shell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  try{
    const {stdout}=await execFileAsync(shell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(createdConnectionAclScript,'utf16le').toString('base64')],{
      windowsHide:true,timeout:10000,maxBuffer:8192,env:{...env,VM_CONTROLLER_CREATED_PATH:path.resolve(filePath)}
    });
    if(stdout.trim()!=='private-empty-file')fail('controller_file_protection_failed');
  }catch{fail('controller_file_protection_failed');}
}
export async function publishConnection(configuration,connection,{securityCheck=assertPrivatePath,isProcessAlive=pid=>{
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}}={}){
  validateConnection(connection,configuration);
  await securityCheck(configuration.home,{directory:true});
  const lockPath=path.join(configuration.home,'.connection-publication.lock');
  try{await fs.mkdir(lockPath,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('controller_connection_publication_locked');throw error;}
  try{
    const destination=path.join(configuration.home,'connection.json');
    let previous;
    try{previous=await readConnection(configuration,{securityCheck});}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous){
      if(isProcessAlive(previous.pid))fail('controller_already_running');
      const unchanged=await readConnection(configuration,{securityCheck});
      if(unchanged.instanceId!==previous.instanceId||unchanged.token!==previous.token)fail('controller_connection_changed');
      await fs.unlink(destination);
    }
    const handle=await fs.open(destination,'wx',0o600);
    let created;
    async function isCreatedFile(){
      if(!created)return false;
      try{
        const current=await fs.lstat(destination,{bigint:true});
        return current.isFile()&&current.dev===created.dev&&current.ino===created.ino;
      }catch(error){if(error.code==='ENOENT')return false;throw error;}
    }
    async function requireCreatedFile(){if(!await isCreatedFile())fail('controller_connection_file_changed');}
    try{
      try{
        created=await handle.stat({bigint:true});
        if(!created.isFile()||created.ino===0n)fail('controller_file_identity_unavailable');
        await requireCreatedFile();
        await protectCreatedConnection(destination);
        await requireCreatedFile();await securityCheck(destination);await requireCreatedFile();
        await handle.writeFile(JSON.stringify(connection)+'\n');await handle.sync();
      }finally{await handle.close();}
      await requireCreatedFile();await securityCheck(destination);
    }catch(error){
      if(await isCreatedFile().catch(()=>false))await fs.unlink(destination).catch(()=>{});
      throw error;
    }
  }finally{await fs.rmdir(lockPath);}

}
export async function removeConnection(configuration,connection,{securityCheck=assertPrivatePath}={}){
  try{
    const current=await readConnection(configuration,{securityCheck});
    if(current.instanceId===connection.instanceId&&current.token===connection.token)await fs.unlink(path.join(configuration.home,'connection.json'));
  }catch(error){if(error.code!=='ENOENT')throw error;}
}
