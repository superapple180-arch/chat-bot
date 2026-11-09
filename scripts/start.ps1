$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
if (-not (Test-Path runtime\node.exe) -or -not (Test-Path dist\cli.js)) { throw 'Run install-dependencies.cmd first.' }
& .\runtime\node.exe dist\cli.js
exit $LASTEXITCODE
