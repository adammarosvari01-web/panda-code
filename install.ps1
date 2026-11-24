# Installs panda.exe to %LOCALAPPDATA%\Programs\PandaCode and adds it to your user PATH,
# so you can type `panda` in any new terminal.
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'dist\panda.exe'
if (-not (Test-Path $src)) { throw "Build first: .\build.ps1" }
$dir = Join-Path $env:LOCALAPPDATA 'Programs\PandaCode'
New-Item -ItemType Directory -Force $dir | Out-Null
# A running exe can't be overwritten, but it can be renamed: move old copies aside, clean up stale ones.
Get-ChildItem $dir -Filter '*.old-*.exe' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }
foreach ($name in 'panda.exe', 'pandacode.exe') {
  $p = Join-Path $dir $name
  if (Test-Path $p) {
    try { Remove-Item $p -Force -ErrorAction Stop }
    catch { Rename-Item $p ("{0}.old-{1}.exe" -f [IO.Path]::GetFileNameWithoutExtension($name), [DateTime]::Now.Ticks) }
  }
}
Copy-Item $src (Join-Path $dir 'panda.exe') -Force
# `pandacode` command: a hard link to the same exe (no extra disk space, works in cmd and PowerShell)
$alias = Join-Path $dir 'pandacode.exe'
try { New-Item -ItemType HardLink -Path $alias -Target (Join-Path $dir 'panda.exe') | Out-Null }
catch { Copy-Item $src $alias -Force }
Copy-Item (Join-Path $PSScriptRoot 'assets\panda.ico') (Join-Path $dir 'panda.ico') -Force -ErrorAction SilentlyContinue

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @(); if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ } }
if ($parts -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
  Write-Host "Added $dir to your user PATH."
} else {
  Write-Host "$dir is already on your user PATH."
}
Write-Host "Installed panda.exe to $dir"
Write-Host "Open a NEW terminal (cmd or PowerShell) and type: pandacode   (or just: panda)"
