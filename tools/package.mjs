import {mkdir,mkdtemp,readFile,writeFile,cp,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),dist=join(root,'dist');
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(process.platform!=='win32'||process.arch!=='x64'||process.versions.node.split('.')[0]!=='24')throw Error('Package on Windows x64 with Node.js 24.');
await mkdir(dist,{recursive:true});
const work=await mkdtemp(join(dist,'.package-')),name='codex-vm-controller-v'+version+'-win-x64',stage=join(work,name);
await mkdir(stage);
const runtimeFiles=['src','skills','Configure.ps1','Configure.cmd','Start.ps1','Start.cmd','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
for(const name of runtimeFiles)await cp(join(root,name),join(stage,name),{recursive:true});
await mkdir(join(stage,'bin'));
for(const name of ['PreparedBackgroundController.exe','GuestWorker.exe','GuestWgc.dll'])await cp(join(root,'bin',name),join(stage,'bin',name));
const nodeVersion='v'+process.versions.node,archive='node-'+nodeVersion+'-win-x64.zip',base='https://nodejs.org/dist/'+nodeVersion+'/';
async function download(name){
 const response=await fetch(base+name,{redirect:'error',signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('Official Node.js download failed: '+response.status);
 return Buffer.from(await response.arrayBuffer());
}
const sums=(await download('SHASUMS256.txt')).toString('utf8');
const expected=sums.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===archive)?.[0];
if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Official Node.js archive checksum was not found.');
const archiveBytes=await download(archive),digest=createHash('sha256').update(archiveBytes).digest('hex');
if(digest!==expected)throw Error('Official Node.js archive checksum mismatch.');
const archivePath=join(work,archive),expanded=join(work,'node');
await writeFile(archivePath,archiveBytes);
function powershell(command,env){
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,...env},stdio:'inherit'});
}
powershell('Expand-Archive -LiteralPath $env:VM_PACKAGE_ARCHIVE -DestinationPath $env:VM_PACKAGE_EXPANDED',{VM_PACKAGE_ARCHIVE:archivePath,VM_PACKAGE_EXPANDED:expanded});
const sourceRuntime=join(expanded,'node-'+nodeVersion+'-win-x64'),runtime=join(stage,'runtime');
await mkdir(runtime);
for(const name of ['node.exe','LICENSE'])await cp(join(sourceRuntime,name),join(runtime,name));
await writeFile(join(runtime,'VERSION'),nodeVersion+'\n');
const zip=join(dist,name+'.zip');
powershell('Compress-Archive -LiteralPath $env:VM_PACKAGE_STAGE -DestinationPath $env:VM_PACKAGE_ZIP -Force',{VM_PACKAGE_STAGE:stage,VM_PACKAGE_ZIP:zip});
const bytes=await readFile(zip);
await writeFile(join(dist,'SHA256SUMS.txt'),createHash('sha256').update(bytes).digest('hex')+'  '+basename(zip)+'\n');
console.log(JSON.stringify({zip:basename(zip),bytes:bytes.length,nodeVersion,nodeArchiveSha256:digest}));
