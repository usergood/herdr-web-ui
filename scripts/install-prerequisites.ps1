# Reviewed Windows prerequisites. Every downloaded script/archive is verified before use.
param([Parameter(Mandatory = $true)][ValidateSet('herdr', 'bun')][string]$Tool, [switch]$NoPathUpdate)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('saurons-prerequisite-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$download = Join-Path $PSScriptRoot 'download-pinned.ps1'
try {
    if ($Tool -eq 'herdr') {
        $script = Join-Path $root 'install.ps1'
        $archive = Join-Path $root 'herdr.zip'
        & $download -Uri 'https://raw.githubusercontent.com/herdrdev/herdr/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1' -Sha256 '369e0d2b5a5f976e11b512f3c4b610a2eba6119732b292a2f587ca8f80fe0baf' -OutFile $script | Out-Null
        & $download -Uri 'https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-windows-x86_64.zip' -Sha256 'c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795' -OutFile $archive | Out-Null
        $global:LASTEXITCODE = 0
        & $script -Channel stable -LocalPackagePath $archive -LocalPackageFormat zip -LocalPackageIdentity '0.9.3' -LocalPackageSha256 'c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795'
        if ($LASTEXITCODE -ne 0) { throw 'Pinned Herdr installer did not finish' }
        $directory = Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin'
    } else {
        # Baseline retains support for x64 CPUs without AVX2.
        $archive = Join-Path $root 'bun.zip'
        & $download -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64-baseline.zip' -Sha256 '78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6' -OutFile $archive | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $root
        $directory = Join-Path $env:USERPROFILE '.bun\bin'
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
        $target = Join-Path $directory 'bun.exe'
        $backup = Join-Path $directory ('bun.previous-' + [guid]::NewGuid().ToString('N') + '.exe')
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
        try { Move-Item -LiteralPath (Join-Path $root 'bun-windows-x64-baseline\bun.exe') -Destination $target }
        catch { if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target }; throw }
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
        if (-not $NoPathUpdate) {
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            if ($directory -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', "$directory;$userPath", 'User') }
        }
    }
    $env:PATH = "$directory;$env:PATH"
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
