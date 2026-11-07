#Requires -Version 5.1
[CmdletBinding()]
param([string]$VmId,[string]$HomeDirectory=$env:VM_CONTROLLER_HOME)
$ErrorActionPreference='Stop'
if(-not $VmId){$VmId=Read-Host 'Enter the GUID of the Hyper-V VM you want to bind'}
$target=[guid]::Empty
if(-not [guid]::TryParseExact($VmId,'D',[ref]$target) -or $target -eq [guid]::Empty){throw 'A non-empty Hyper-V VM GUID is required.'}
if(-not $HomeDirectory){$HomeDirectory=Join-Path $env:LOCALAPPDATA 'VmComputerController'}
$HomeDirectory=[IO.Path]::GetFullPath($HomeDirectory)
if($HomeDirectory -eq [IO.Path]::GetPathRoot($HomeDirectory) -or $HomeDirectory.StartsWith('\\')){throw 'Choose a dedicated local settings directory.'}
if(Test-Path -LiteralPath $HomeDirectory){
 $existing=Get-Item -LiteralPath $HomeDirectory -Force
 if(-not $existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Choose a dedicated local directory.'}
 if(Test-Path -LiteralPath (Join-Path $HomeDirectory 'policy.json')){throw 'Installation already configured; do not replace a live binding.'}
 if(@(Get-ChildItem -LiteralPath $HomeDirectory -Force).Count -ne 0){throw 'Settings directory must be empty; existing files and permissions were not changed.'}
}
New-Item -ItemType Directory -Path $HomeDirectory -Force | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid)
foreach($who in @($sid,$system,$admins)){
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($HomeDirectory,$acl)
$policyPath=Join-Path $HomeDirectory 'policy.json'
$data=@{schemaVersion=1;vmId=$target.ToString('D');ownerSid=$sid.Value;hostMachine=[Environment]::MachineName}
[IO.File]::WriteAllText($policyPath,($data | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$fileAcl=New-Object Security.AccessControl.FileSecurity
$fileAcl.SetAccessRuleProtection($true,$false);$fileAcl.SetOwner($sid)
foreach($who in @($sid,$system,$admins)){$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','Allow')))}
[IO.File]::SetAccessControl($policyPath,$fileAcl)
Write-Output 'Configured one local VM binding. No VM was connected and no input was sent.'
