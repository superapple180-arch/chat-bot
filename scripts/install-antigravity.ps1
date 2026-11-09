$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$target = Join-Path (Get-Location) 'runtime\antigravity\agy.exe'
if (Test-Path -LiteralPath $target) { Write-Host 'Project-local Antigravity CLI already present.'; exit 0 }
$platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'windows_arm64' } else { 'windows_amd64' }
$manifest = Invoke-RestMethod -Uri "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/$platform.json"
$download = [uri]$manifest.url
if ($download.Scheme -ne 'https' -or $download.Host -ne 'storage.googleapis.com' -or -not $download.AbsolutePath.StartsWith('/antigravity-public/antigravity-cli/')) { throw 'Unexpected Antigravity download URL' }
New-Item -ItemType Directory -Force 'runtime\antigravity','.cache\antigravity','artifacts' | Out-Null
$staging = Join-Path (Get-Location) '.cache\antigravity\agy.download.exe'
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $download -OutFile $staging
if ((Get-FileHash -LiteralPath $staging -Algorithm SHA512).Hash.ToLowerInvariant() -ne $manifest.sha512.ToLowerInvariant()) { throw 'Antigravity checksum mismatch' }
Move-Item -LiteralPath $staging -Destination $target
$signature = Get-AuthenticodeSignature -LiteralPath $target
[pscustomobject]@{ Version=$manifest.version; Sha512Verified=$true; Signature=[string]$signature.Status; Signer=$signature.SignerCertificate.Subject } | ConvertTo-Json | Set-Content -Encoding UTF8 'artifacts/antigravity-download.json'
Write-Host 'Antigravity CLI downloaded into this project and SHA512 verified. Run login-antigravity.cmd if sign-in is required.'
