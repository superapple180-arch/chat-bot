$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$refs = @('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $framework "WPF\$_") }
New-Item -ItemType Directory -Force (Join-Path $root 'bin') | Out-Null
$name = if ($args -contains '-Probe') { 'Probe' } else { 'GeminiDriver' }
& (Join-Path $framework 'csc.exe') /nologo /target:exe "/out:$root\bin\$name.exe" @refs /reference:System.Web.Extensions.dll "$root\desktop\$name.cs"
if ($LASTEXITCODE -ne 0) { throw 'C# driver build failed' }
