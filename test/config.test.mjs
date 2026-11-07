import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {validatePolicy,validateConnection,resolveControllerHome,readPolicy,readConnection,publishConnection,removeConnection,assertPrivatePath} from '../src/config.mjs';
import {policy,configuration,fixtureConnection,OTHER} from './helpers.mjs';
const safe=async()=>({ownerSid:policy.ownerSid});
async function fixture(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'controller-config-'));await fs.chmod(home,0o700);
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  await fs.writeFile(path.join(home,'policy.json'),JSON.stringify(policy),{mode:0o600});
  return {home,env:{},securityCheck:safe,platform:'fixture'};
}
test('policy is exact, normalizes a GUID and rejects target, owner or host injection',()=>{
  assert.deepEqual(validatePolicy(policy),policy);
  for(const bad of [null,[],{...policy,schemaVersion:2},{...policy,shell:'anything'},{...policy,vmId:"x' OR 1=1"},{...policy,vmId:'00000000-0000-0000-0000-000000000000'},{...policy,ownerSid:'Everyone'},{...policy,hostMachine:'remote/host'}])assert.throws(()=>validatePolicy(bad));
  assert.equal(resolveControllerHome({home:'space 中文 home'}),path.resolve('space 中文 home'));
  assert.equal(resolveControllerHome({env:{LOCALAPPDATA:path.resolve('private-appdata')},platform:'win32'}),path.join(path.resolve('private-appdata'),'VmComputerController'));
});
test('connection permits one numeric IPv4 loopback address and this policy only',()=>{
  const connection=fixtureConnection();
  assert.deepEqual(validateConnection(connection,configuration),connection);
  for(const patch of [{baseURL:'https://127.0.0.1:12345/'},{baseURL:'http://example.com:12345/'},{baseURL:'http://localhost:12345/'},{baseURL:'http://127.0.0.1:12345/path'},{baseURL:'http://user:pass@127.0.0.1:12345/'},{token:'short'},{vmId:OTHER},{policySha256:'b'.repeat(64)},{pid:0},{extra:true}])assert.throws(()=>validateConnection({...connection,...patch},configuration));
});
test('protected policy read checks schema, owner and canonical home binding',async t=>{
  const options=await fixture(t),read=await readPolicy(options);
  assert.equal(read.policy.vmId,policy.vmId);assert.match(read.policySha256,/^[a-f0-9]{64}$/);
  await assert.rejects(readPolicy({...options,securityCheck:async()=>({ownerSid:'S-1-5-21-999'})}),/owner_mismatch/);
  await assert.rejects(readPolicy({...options,env:{VM_CONTROLLER_POLICY:path.join(options.home,'another.json')}}),/belong/);
  await fs.writeFile(path.join(options.home,'policy.json'),'{bad',{mode:0o600});await assert.rejects(readPolicy(options),/invalid_controller_json/);
});
test('connection publication is exclusive, recovers only a dead owner and cannot delete a replacement',async t=>{
  const options=await fixture(t),config=await readPolicy(options);
  const first={...fixtureConnection(),policySha256:config.policySha256};
  await publishConnection(config,first,{securityCheck:safe,isProcessAlive:()=>false});
  assert.deepEqual(await readConnection(config,{securityCheck:safe}),first);
  const next={...first,instanceId:randomUUID(),token:'y'.repeat(43)};
  await assert.rejects(publishConnection(config,next,{securityCheck:safe,isProcessAlive:()=>true}),/already_running/);
  await publishConnection(config,next,{securityCheck:safe,isProcessAlive:()=>false});
  await removeConnection(config,first,{securityCheck:safe});assert.equal((await readConnection(config,{securityCheck:safe})).instanceId,next.instanceId);
  await removeConnection(config,next,{securityCheck:safe});await assert.rejects(fs.stat(path.join(options.home,'connection.json')),{code:'ENOENT'});
});
test('real Unix permission checks refuse broad access and symlink paths',{skip:process.platform==='win32'},async t=>{
  const options=await fixture(t),file=path.join(options.home,'policy.json');
  await assertPrivatePath(file);await fs.chmod(file,0o644);await assert.rejects(assertPrivatePath(file),/permissions/);
  await fs.chmod(file,0o600);const linked=path.join(options.home,'linked.json');await fs.symlink(file,linked);await assert.rejects(assertPrivatePath(linked),/path/);
});
test('skill ships the same protected config reader, without a service-repository import',async()=>{
  const [service,skill]=await Promise.all([fs.readFile(new URL('../src/config.mjs',import.meta.url),'utf8'),fs.readFile(new URL('../skills/vm-computer-controller/scripts/config.mjs',import.meta.url),'utf8')]);
  assert.equal(skill,service);
});

test('concurrent publication is serialized and a stale publication lock fails closed',async t=>{
  const options=await fixture(t),config=await readPolicy(options);
  await fs.mkdir(path.join(config.home,'.connection-publication.lock'));
  const value={...fixtureConnection(),policySha256:config.policySha256};
  await assert.rejects(publishConnection(config,value,{securityCheck:safe,isProcessAlive:()=>false}),/publication_locked/);
  await assert.rejects(fs.stat(path.join(config.home,'connection.json')),{code:'ENOENT'});
});

test('real Windows publication sets the exact owner and still rejects foreign ownership and broad access',{skip:process.platform!=='win32'},async t=>{
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const {fileURLToPath}=await import('node:url');
  const execute=promisify(execFile),shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const settingsDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'controller-windows-owner-'));
  t.after(()=>fs.rm(settingsDirectory,{recursive:true,force:true}));
  await execute(shell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../Configure.ps1',import.meta.url)),'-VmId',policy.vmId,'-HomeDirectory',settingsDirectory],{windowsHide:true});
  const config=await readPolicy({home:settingsDirectory});
  const value={...fixtureConnection(),vmId:config.policy.vmId,policySha256:config.policySha256};
  await publishConnection(config,value,{isProcessAlive:()=>false});
  assert.deepEqual(await readConnection(config),value);
  const connectionPath=path.join(settingsDirectory,'connection.json');
  async function changeAcl(body){
    const script="$ErrorActionPreference='Stop';$p=$env:VM_TEST_CREATED_PATH;$a=[IO.File]::GetAccessControl($p);"+body+";[IO.File]::SetAccessControl($p,$a)";
    await execute(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,VM_TEST_CREATED_PATH:connectionPath}});
  }
  const worldRule="$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow);";
  await changeAcl(worldRule+"$a.AddAccessRule($rule)");
  await assert.rejects(readConnection(config),/unsafe_controller_permissions/);
  await changeAcl(worldRule+"$a.RemoveAccessRuleAll($rule)");
  await changeAcl("$a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))");
  await assert.rejects(readConnection(config),/unsafe_controller_permissions/);
  await changeAcl("$a.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)");
  assert.deepEqual(await readConnection(config),value);
  await removeConnection(config,value);
  await assert.rejects(fs.stat(connectionPath),{code:'ENOENT'});
});

test('failed publication preserves a connection path replaced by another writer',async t=>{
  const options=await fixture(t),config=await readPolicy(options),destination=path.join(config.home,'connection.json');
  let replaced=false;
  const check=async(file)=>{
    if(file===destination&&!replaced){
      try{await fs.stat(file);}catch(error){if(error.code==='ENOENT')throw error;throw error;}
      await fs.rename(file,path.join(config.home,'original-empty-file'));
      await fs.writeFile(file,'replacement owned by another writer',{mode:0o600});
      replaced=true;throw Error('simulated-publication-failure');
    }
    return {ownerSid:policy.ownerSid};
  };
  const value={...fixtureConnection(),policySha256:config.policySha256};
  await assert.rejects(publishConnection(config,value,{securityCheck:check,isProcessAlive:()=>false}),/simulated-publication-failure/);
  assert.equal(replaced,true);
  assert.equal(await fs.readFile(destination,'utf8'),'replacement owned by another writer');
  assert.equal((await fs.stat(path.join(config.home,'original-empty-file'))).size,0);
});
