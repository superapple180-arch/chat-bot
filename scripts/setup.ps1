$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Force runtime,state,artifacts | Out-Null
if (-not (Test-Path 'runtime\node.exe')) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Copy-Item -LiteralPath $node -Destination runtime\node.exe
    $npmSource = Join-Path (Split-Path $node) 'node_modules\npm'
    Copy-Item -LiteralPath $npmSource -Destination runtime\npm -Recurse
}
if (-not (Test-Path 'runtime\npm\bin\npm-cli.js')) { throw 'Project-local npm missing; install Node.js 24 LTS then rerun setup.' }
$env:PATH = (Join-Path $root 'runtime') + ';' + $env:PATH
& .\runtime\node.exe runtime\npm\bin\npm-cli.js ci --ignore-scripts --no-audit --no-fund --userconfig .npmrc --cache .cache\npm --fetch-timeout=30000 --fetch-retries=1
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& .\runtime\node.exe node_modules\typescript\bin\tsc
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
& "$PSScriptRoot\build-driver.ps1"
if (-not (Test-Path 'config.local.json')) { Copy-Item config.example.json config.local.json }
Write-Host 'Setup complete. Edit config.local.json before starting. Real sending defaults to false.'
