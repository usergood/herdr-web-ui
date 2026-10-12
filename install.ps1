# Native Windows install from the reviewed checkout: ./install.ps1 -Ref <commit or tag>
param([string]$Ref = $env:HERDR_WEB_UI_REF)

& {
$ErrorActionPreference = 'Stop'
if (-not $Ref) { throw 'Set -Ref or HERDR_WEB_UI_REF to a reviewed Saurons eye commit or tag before installing.' }
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'herdr web ui supports Windows x64. Use install.sh on Linux or macOS.'
}

function Run-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed (exit $LASTEXITCODE). Fix the error above and run this again." }
}
# The official installers keep these user-local directories on PATH for future terminals.
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    Write-Host 'herdr web ui: installing herdr for your user'
    & (Join-Path $PSScriptRoot 'scripts\install-prerequisites.ps1') -Tool herdr
}
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr and run this again."
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'herdr web ui: installing Bun 1.4.2 for your user'
    & (Join-Path $PSScriptRoot 'scripts\install-prerequisites.ps1') -Tool bun
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$pluginId = 'usergood.saurons-eye'
function Find-Plugin {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
}
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
$plugin = Find-Plugin
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    # A copy from a release older than Windows support never starts here, so no in-app update reaches it.
    Write-Host 'herdr web ui: replacing an installed copy that has no Windows support'
    Run-Tool herdr @('plugin', 'uninstall', $pluginId) | Out-Null
    $plugin = $null
}
if (-not $plugin) {
    Write-Host "herdr web ui: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'usergood/saurons-eye', '--ref', $Ref, '--yes')
    $plugin = Find-Plugin
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "herdr web ui $Ref does not support Windows yet. Run this again after the next release." }
} else { Write-Host 'herdr web ui: already installed; Settings > Updates keeps it current' }

$server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
if ($server.running) {
    Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
    $script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $status = Run-Tool bun @($script, 'status')
        if ($status -match '^running ') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        # The start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal.
        $why = ''
        try {
            $failed = (& herdr plugin log list | ConvertFrom-Json).result.logs |
                Where-Object { $_.plugin_id -eq $pluginId -and $_.stderr } | Select-Object -Last 1
            if ($failed) { $why = "`n" + $failed.stderr.Trim() }
        } catch { $why = '' } # the reason is a help, not a step: without it the pointer below still stands
        throw "The app did not start within 25 seconds.$why`nSee: herdr plugin log list"
    }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
} else { Write-Host 'herdr web ui: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'herdr web ui: open Phone setup in herdr for phone access.'

}
