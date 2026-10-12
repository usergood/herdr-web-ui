# Download to a staging file and publish it only after its reviewed digest matches.
param(
    [Parameter(Mandatory = $true)][uri]$Uri,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
    [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
if ($Uri.UserInfo -or $Uri.Fragment -or ($Uri.Scheme -ne 'https' -and -not ($Uri.Scheme -eq 'http' -and $Uri.IsLoopback))) { throw 'Use an HTTPS prerequisite URL without embedded credentials' }
$target = [IO.Path]::GetFullPath($OutFile)
if (Test-Path -LiteralPath $target) { throw 'Refusing to replace an existing prerequisite download' }
$temporary = $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
try {
    Invoke-WebRequest $Uri.AbsoluteUri -UseBasicParsing -TimeoutSec 120 -OutFile $temporary
    if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Sha256) { throw 'Checksum mismatch for prerequisite download' }
    Move-Item -LiteralPath $temporary -Destination $target
    Write-Output $target
} finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
