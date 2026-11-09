$root = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force (Join-Path $root state) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'state\pause.flag'), 'pause')
Write-Host 'Pause requested. Already-dispatched QQ messages cannot be recalled.'
