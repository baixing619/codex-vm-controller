[CmdletBinding()]
param([switch]$RunTests)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$out=Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$source=Join-Path $PSScriptRoot 'source'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $compiler)){throw '.NET Framework 4.x x64 compiler is required on Windows.'}
$names=@('InstallationPolicy.cs','Program.cs','BackgroundProtocol.cs','ConsoleProtocol.cs','HyperVGuestChannel.cs','HyperVGuestWorker.cs','InputDebug.cs','WgcFrame.cs')
$sources=@($names | ForEach-Object {Join-Path $source $_})
$references=@('/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.Management.dll')
foreach($entry in @(@('Program','PreparedBackgroundController.exe'),@('HyperVGuestWorker','GuestWorker.exe'))){
 & $compiler /nologo /codepage:65001 /platform:x64 /target:winexe "/main:$($entry[0])" "/win32manifest:$source\Console.manifest" "/out:$out\$($entry[1])" @references @sources
 if($LASTEXITCODE -ne 0){throw "Native compilation failed: $($entry[0])"}
}
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if(-not (Test-Path -LiteralPath $vswhere)){throw 'Visual Studio C++ tools and Windows SDK are required.'}
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars=Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
if(-not (Test-Path -LiteralPath $vcvars)){throw 'MSVC x64 environment not found.'}
$buildCommand=Join-Path $out 'build-encoder.cmd'
$cmd="@echo off`r`ncall `"%VM_BUILD_VCVARS%`" >nul`r`nif errorlevel 1 exit /b 1`r`ncl /nologo /std:c++17 /EHsc /O2 /MT /LD /Fo:`"%VM_BUILD_OUT%\GuestWgc.obj`" /Fe:`"%VM_BUILD_OUT%\GuestWgc.dll`" `"%VM_BUILD_SOURCE%\GuestWgc.cpp`" /link /IMPLIB:`"%VM_BUILD_OUT%\GuestWgc.lib`" windowsapp.lib ole32.lib`r`nexit /b %errorlevel%`r`n"
[IO.File]::WriteAllText($buildCommand,$cmd,[Text.Encoding]::ASCII)
$previous=@{}
foreach($entry in (@{VM_BUILD_VCVARS=$vcvars;VM_BUILD_OUT=$out;VM_BUILD_SOURCE=$source}).GetEnumerator()){
 $previous[$entry.Key]=[Environment]::GetEnvironmentVariable($entry.Key,'Process')
 [Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process')
}
try{
 & $buildCommand
 if($LASTEXITCODE -ne 0){throw 'Guest pixel encoder compilation failed.'}
}finally{
 foreach($entry in $previous.GetEnumerator()){[Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process')}
}
if($RunTests){
 $fixture=Join-Path ([IO.Path]::GetTempPath()) ('vm-policy-fixture-'+[guid]::NewGuid().ToString('N'))
 & (Join-Path $root 'Configure.ps1') -VmId '11111111-1111-4111-8111-111111111111' -HomeDirectory $fixture
 $oldPolicy=$env:VM_CONTROLLER_POLICY;$env:VM_CONTROLLER_POLICY=Join-Path $fixture 'policy.json'
 try{
  foreach($name in @('RequestCancellationTests','HyperVWorkerTests','HyperVCodecTests','HyperVFreshnessTests','PolicyTests','BackgroundLifecycleTests')){
   $test=Join-Path $out ($name+'.exe')
   & $compiler /nologo /codepage:65001 /platform:x64 "/main:$name" "/out:$test" @references @sources (Join-Path $PSScriptRoot ('test/'+$name+'.cs'))
   if($LASTEXITCODE -ne 0){throw "Test compilation failed: $name"}
   & $test
   if($LASTEXITCODE -ne 0){throw "Test failed: $name"}
  }
 } finally {
  $env:VM_CONTROLLER_POLICY=$oldPolicy
  if([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $fixture -Recurse -Force}
 }
}
Write-Output 'Built and checked native components without connecting a real Hyper-V VM.'
