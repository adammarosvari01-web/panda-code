# Builds dist\panda.exe: bundles panda.js into a standalone Node executable and gives it the panda icon.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
node --check panda.js
if (-not $?) { throw 'panda.js has a syntax error' }
New-Item -ItemType Directory -Force dist | Out-Null
node tools\make-icon.js assets
node --build-sea sea-config.json
if (-not $?) { throw 'SEA build failed' }
& "$PSScriptRoot\tools\set-icon.ps1" -Exe dist\panda.exe -Ico assets\panda.ico
& .\dist\panda.exe --version
