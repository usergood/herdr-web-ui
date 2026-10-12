# Public installer CLI with an owned profile and prerequisite/tool stand-ins.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\install.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('saurons-install-fixture-' + [guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH; $originalUserProfile = $env:USERPROFILE; $originalLocalAppData = $env:LOCALAPPDATA; $originalRef = $env:HERDR_WEB_UI_REF
$state = @{ installed = $false; installs = 0; uninstalls = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false; windowsRelease = $true; hasHerdr = $true; failHerdr = $false; bootstraps = @() }
$pluginRoot = Join-Path $root 'plugin'
$launcher = Join-Path $pluginRoot 'scripts\plugin.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Command([string]$Name, [string]$ErrorAction) {
    if ($Name -eq 'herdr' -and -not $state.hasHerdr) { return $null }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction SilentlyContinue
}
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion }
    elseif ($args[-1] -eq 'status') { 'running http://127.0.0.1:7317'; 'config: none' }
    else { throw "Unexpected Bun command: $args" }
}
function herdr {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' { $plugins = @(); if ($state.installed) { $plugins = @(@{ plugin_id = 'usergood.saurons-eye'; plugin_root = $pluginRoot }) }; @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke usergood.saurons-eye.start-windows' { $state.started = $true; '{}' }
        'plugin uninstall usergood.saurons-eye' { $state.installed = $false; $state.uninstalls++; 'Uninstalled' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                Assert ($args[2] -eq 'usergood/saurons-eye') 'Install must target the renamed fork'
                $state.installed = $true; $state.installs++; $state.ref = $args[4]
                Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
                if ($state.windowsRelease) { Set-Content -LiteralPath $launcher -Value '' }
                'Installed Saurons eye'
            } else { throw "Unexpected Herdr command: $args" }
        }
    }
}
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'scripts') | Out-Null
    $installer = Join-Path $root 'install.ps1'
    Copy-Item -LiteralPath $source -Destination $installer
    @'
param($Tool)
$state.bootstraps += $Tool
if ($Tool -eq 'herdr') { if ($state.failHerdr) { throw 'Fixture Herdr prerequisite failed' }; $state.hasHerdr = $true }
else { if (-not $state.failBun) { $state.bunVersion = '1.4.2' }; $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH" }
'@ | Set-Content -LiteralPath (Join-Path $root 'scripts\install-prerequisites.ps1')
    $env:USERPROFILE = Join-Path $root 'profile'; $env:LOCALAPPDATA = Join-Path $root 'local'; $env:HERDR_WEB_UI_REF = ''
    $failed = $false; try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'reviewed Saurons eye' }
    Assert ($failed -and $state.installs -eq 0 -and $state.bootstraps.Count -eq 0) 'Missing reviewed ref must stop before prerequisites or installation'
    & $installer -Ref 'reviewed-commit'
    Assert ($state.installed -and $state.ref -eq 'reviewed-commit' -and $state.started) 'Install uses the reviewed ref and starts a running server'
    & $installer -Ref 'reviewed-commit'; Assert ($state.installs -eq 1) 'Rerun preserves the installed plugin'
    $state.bunVersion = '1.3.0'; & $installer -Ref 'reviewed-commit'
    Assert ($state.bunVersion -eq '1.4.2' -and $state.bootstraps[-1] -eq 'bun') 'Old Bun uses the pinned prerequisite command'
    Assert ($env:PATH.EndsWith($originalPath)) 'Prerequisite installation must preserve the machine PATH'
    $state.bunVersion = '1.3.0'; $state.failBun = $true; $failed = $false
    try { & $installer -Ref 'reviewed-commit' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsuccessful Bun prerequisite must stop installation'; $state.bunVersion = '1.4.2'; $state.failBun = $false
    $state.hasHerdr = $false; & $installer -Ref 'reviewed-commit'
    Assert ($state.hasHerdr -and $state.bootstraps[-1] -eq 'herdr') 'Missing Herdr uses the pinned prerequisite command'
    $state.hasHerdr = $false; $state.failHerdr = $true; $failed = $false
    try { & $installer -Ref 'reviewed-commit' } catch { $failed = $true }
    Assert $failed 'A failed Herdr prerequisite must stop'; $state.hasHerdr = $true; $state.failHerdr = $false
    $state.installed = $false; $state.running = $false; $state.started = $false; & $installer -Ref 'reviewed-branch'
    Assert ($state.ref -eq 'reviewed-branch' -and -not $state.started) 'A stopped server is not started implicitly'
    $state.installed = $false; $state.failInstall = $true; $failed = $false
    try { & $installer -Ref 'broken' } catch { $failed = $_.Exception.Message -match 'herdr failed' }
    Assert $failed 'A failed plugin install must stop'; $state.failInstall = $false
    $state.installed = $true; Remove-Item -LiteralPath $launcher -Force
    & $installer -Ref 'reviewed-commit'; Assert ($state.uninstalls -eq 1 -and (Test-Path -LiteralPath $launcher)) 'An incompatible old plugin is explicitly replaced'
    Write-Host 'PASS Windows installer: reviewed ref, pinned prerequisites, failures, retained PATH, rerun and native plugin decisions'
} finally {
    $env:PATH = $originalPath; $env:USERPROFILE = $originalUserProfile; $env:LOCALAPPDATA = $originalLocalAppData; $env:HERDR_WEB_UI_REF = $originalRef
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
