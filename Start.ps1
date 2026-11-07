#Requires -Version 5.1
[CmdletBinding()]
param([string]$HomeDirectory=$env:VM_CONTROLLER_HOME,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$runtimePath=Join-Path $PSScriptRoot 'runtime/node.exe'
if(-not (Test-Path -LiteralPath $runtimePath)){
 $runtime=Get-Command node -ErrorAction SilentlyContinue
 if(-not $runtime){throw 'Use the Windows release ZIP; it includes the required Node.js runtime.'}
 $runtimePath=$runtime.Source
}
$runtimeVersion=(& $runtimePath --version | Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $runtimeVersion -notmatch '^v24\.\d+\.\d+$'){throw 'Node.js 24 is required. Use the Windows release ZIP.'}
foreach($name in @('PreparedBackgroundController.exe','GuestWorker.exe','GuestWgc.dll')){
 if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ('bin/'+$name)))){throw 'Native components are missing. Extract the complete Windows release ZIP.'}
}
if($CheckOnly){Write-Output 'Runtime and native components are available.';return}
$arguments=@(Join-Path $PSScriptRoot 'src/server.mjs')
if($HomeDirectory){$arguments+=@('--home',$HomeDirectory)}
& $runtimePath @arguments
if($LASTEXITCODE -ne 0){throw 'Controller service exited. Check the preceding message; run Configure.cmd before first use.'}
