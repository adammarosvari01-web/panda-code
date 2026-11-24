# Installs Panda Code on a Windows PC.
#
#   irm https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.ps1 | iex
#
# Options are read from environment variables so the one-liner above works as is:
#   PANDA_REPO         GitHub "owner/name" that publishes the releases   (default: the official repository)
#   PANDA_SOURCE       install this panda.exe (a local path or a URL) instead of the latest release
#   PANDA_INSTALL_DIR  where to install (default: %LOCALAPPDATA%\Programs\PandaCode)
#   PANDA_NO_PATH=1    don't touch the PATH
#   PANDA_SKIP_OLLAMA=1  don't offer to install Ollama
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower in Windows PowerShell 5.1
$Repo       = if ($env:PANDA_REPO) { $env:PANDA_REPO } else { 'adammarosvari01-web/panda-code' }
$Source     = $env:PANDA_SOURCE
$InstallDir = if ($env:PANDA_INSTALL_DIR) { $env:PANDA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\PandaCode' }

Write-Host ''
Write-Host 'Panda Code installer' -ForegroundColor Green

# 1. get panda.exe
$tmp = Join-Path $env:TEMP ("panda-" + [guid]::NewGuid().ToString('N') + '.exe')
if ($Source) {
  if ($Source -match '^https?://') { Invoke-WebRequest -UseBasicParsing $Source -OutFile $tmp } else { Copy-Item -LiteralPath $Source $tmp }
} else {
  Write-Host "Finding the latest release of $Repo ..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'panda-code' }
  $asset = $rel.assets | Where-Object { $_.name -eq 'panda.exe' } | Select-Object -First 1
  if (-not $asset) { throw "Release $($rel.tag_name) has no panda.exe file attached." }
  Write-Host "Downloading panda.exe $($rel.tag_name) ($([math]::Round($asset.size / 1MB)) MB) ..."
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $tmp
  $shaAsset = $rel.assets | Where-Object { $_.name -eq 'panda.exe.sha256' } | Select-Object -First 1
  if ($shaAsset) {
    $want = ((Invoke-RestMethod $shaAsset.browser_download_url).ToString().Trim() -split '\s+')[0].ToLower()
    $got  = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { Remove-Item $tmp -Force; throw 'The download does not match the published checksum. Nothing was installed.' }
    Write-Host 'Checksum OK.'
  } else { Write-Warning 'This release publishes no checksum, so the download could not be verified.' }
}

# 2. install (a running exe can be renamed but not overwritten, so move old copies aside)
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Get-ChildItem $InstallDir -Filter '*.old-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }
foreach ($name in 'panda.exe', 'pandacode.exe') {
  $p = Join-Path $InstallDir $name
  if (Test-Path $p) {
    try { Remove-Item $p -Force -ErrorAction Stop }
    catch { Rename-Item $p ("{0}.old-{1}.exe" -f [IO.Path]::GetFileNameWithoutExtension($name), [DateTime]::Now.Ticks) }
  }
}
Move-Item $tmp (Join-Path $InstallDir 'panda.exe') -Force
try { New-Item -ItemType HardLink -Path (Join-Path $InstallDir 'pandacode.exe') -Target (Join-Path $InstallDir 'panda.exe') | Out-Null }
catch { Copy-Item (Join-Path $InstallDir 'panda.exe') (Join-Path $InstallDir 'pandacode.exe') -Force }
Write-Host "Installed to $InstallDir" -ForegroundColor Green

# 3. PATH (user level, no admin needed)
if (-not $env:PANDA_NO_PATH) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(); if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ } }
  if ($parts -notcontains $InstallDir) { [Environment]::SetEnvironmentVariable('Path', (($parts + $InstallDir) -join ';'), 'User'); Write-Host 'Added to your PATH.' }
}

# 4. the local AI engine
if (-not $env:PANDA_SKIP_OLLAMA -and -not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host 'Panda needs a local AI engine. Ollama is the easiest one, and it is not installed on this PC.' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $a = Read-Host 'Install Ollama now with winget? [Y/n]'
    if ($a -eq '' -or $a -match '^[yY]') { winget install -e --id Ollama.Ollama }
  } else { Write-Host 'Download it from https://ollama.com/download' }
}

Write-Host ''
Write-Host 'Done. Open a NEW terminal and type:  pandacode' -ForegroundColor Green
Write-Host 'The first time, Panda shows the AI models that suit this PC, best first, and downloads the one you pick.'
