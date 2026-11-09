$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
& .\runtime\node.exe node_modules\typescript\bin\tsc
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& .\runtime\node.exe --test --test-timeout=30000 test\*.test.mjs
exit $LASTEXITCODE
