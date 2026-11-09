$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
& .\runtime\node.exe dist\verify-gemini.js
exit $LASTEXITCODE
