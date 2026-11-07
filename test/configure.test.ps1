$ErrorActionPreference='Stop'
$script=Join-Path (Split-Path $PSScriptRoot -Parent) 'Configure.ps1'
$fixture=Join-Path $env:RUNNER_TEMP ('vm-config-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$existing=Join-Path $fixture 'existing user files'
New-Item -ItemType Directory -Path $existing | Out-Null
$marker=Join-Path $existing 'keep.txt';[IO.File]::WriteAllText($marker,'preserved')
$before=(Get-Acl -LiteralPath $existing).Sddl
$rejected=$false
try{& $script -VmId '11111111-1111-4111-8111-111111111111' -HomeDirectory $existing}catch{$rejected=$true}
if(-not $rejected){throw 'Nonempty existing settings directory was accepted.'}
if((Get-Acl -LiteralPath $existing).Sddl -ne $before -or [IO.File]::ReadAllText($marker) -ne 'preserved' -or (Test-Path -LiteralPath (Join-Path $existing 'policy.json'))){throw 'Existing user data or ACL was changed.'}
$target=Join-Path $fixture '配置 空格'
& $script -VmId '11111111-1111-4111-8111-111111111111' -HomeDirectory $target
$policy=Join-Path $target 'policy.json';$hash=(Get-FileHash -LiteralPath $policy -Algorithm SHA256).Hash
$rejected=$false
try{& $script -VmId '22222222-2222-4222-8222-222222222222' -HomeDirectory $target}catch{$rejected=$true}
if(-not $rejected -or (Get-FileHash -LiteralPath $policy -Algorithm SHA256).Hash -ne $hash){throw 'Configured target binding was overwritten.'}
Write-Output 'Dedicated settings, existing-data preservation and Unicode path checks passed.'
