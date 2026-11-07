$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$metadata=Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$name='codex-vm-controller-v'+$metadata.version+'-win-x64'
$zip=Join-Path $root ('dist/'+$name+'.zip')
$sum=([IO.File]::ReadAllText((Join-Path $root 'dist/SHA256SUMS.txt')) -split '\s+')[0]
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sum){throw 'Release ZIP digest mismatch.'}
$expected=@(
 'Configure.ps1','Configure.cmd','Start.ps1','Start.cmd','README.md','LICENSE','THIRD_PARTY_NOTICES.md',
 'bin/PreparedBackgroundController.exe','bin/GuestWorker.exe','bin/GuestWgc.dll',
 'runtime/node.exe','runtime/LICENSE','runtime/VERSION',
 'skills/vm-computer-controller/SKILL.md','skills/vm-computer-controller/agents/openai.yaml',
 'skills/vm-computer-controller/scripts/controller.mjs','skills/vm-computer-controller/scripts/config.mjs',
 'src/config.mjs','src/exclusive-activity-owner.mjs','src/server.mjs','src/shared-vm-activity.mjs',
 'src/vm-computer-controller.mjs','src/vm-console-router.mjs','src/vm-jpeg-frame.mjs','src/vm-task-entry.mjs'
) | Sort-Object
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($zip)
try{
 $actual=@($archive.Entries | Where-Object {$_.Name} | ForEach-Object {
  $entry=$_.FullName.Replace('\','/')
  if(-not $entry.StartsWith($name+'/')){throw 'Unexpected package root.'}
  $entry.Substring($name.Length+1)
 } | Sort-Object)
 if(Compare-Object $expected $actual){throw 'ZIP contains missing, renamed or unnecessary files.'}
}finally{$archive.Dispose()}
$fixture=Join-Path $env:RUNNER_TEMP ('vm-package-test-'+[guid]::NewGuid().ToString('N'))
$destination=Join-Path $fixture '包 解压'
Expand-Archive -LiteralPath $zip -DestinationPath $destination
$installed=Join-Path $destination $name
foreach($relative in $expected | Where-Object {-not $_.StartsWith('runtime/')}){
 if((Get-FileHash -LiteralPath (Join-Path $installed $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $root $relative)).Hash){throw "Packaged file differs: $relative"}
}
& (Join-Path $installed 'Start.ps1') -CheckOnly
$settingsDirectory=Join-Path $fixture '设置 space'
& (Join-Path $installed 'Configure.ps1') -VmId '11111111-1111-4111-8111-111111111111' -HomeDirectory $settingsDirectory
& (Join-Path $installed 'runtime/node.exe') (Join-Path $PSScriptRoot 'package-smoke.mjs') $installed $settingsDirectory
if($LASTEXITCODE -ne 0){throw 'Extracted package service/CLI smoke check failed.'}
Write-Output ('Verified '+$expected.Count+' release files, checksum, Unicode path, bundled runtime and isolated first-use service.')
