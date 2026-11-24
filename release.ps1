# Builds a release and (after you confirm) publishes it to GitHub so other PCs can install and /update.
#   .\release.ps1 -Version 1.0.1
# Needs the GitHub CLI (https://cli.github.com), logged in with `gh auth login`, run inside your cloned repository.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a version like 1.0.1' }

# keep the version in panda.js and package.json in step
$js = [IO.File]::ReadAllText("$PSScriptRoot\panda.js")
$js = [regex]::Replace($js, "const VERSION = '[^']*';", "const VERSION = '$Version';")
[IO.File]::WriteAllText("$PSScriptRoot\panda.js", $js, (New-Object Text.UTF8Encoding $false))
$pj = [IO.File]::ReadAllText("$PSScriptRoot\package.json")
$pj = [regex]::Replace($pj, '"version":\s*"[^"]*"', "`"version`": `"$Version`"", 1)
[IO.File]::WriteAllText("$PSScriptRoot\package.json", $pj, (New-Object Text.UTF8Encoding $false))

& "$PSScriptRoot\build.ps1"

$hash = (Get-FileHash dist\panda.exe -Algorithm SHA256).Hash.ToLower()
"$hash  panda.exe" | Set-Content dist\panda.exe.sha256 -Encoding ascii
Write-Host "Built dist\panda.exe  sha256 $hash"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host 'GitHub CLI not found. Publish by hand: create a release tagged v'$Version' on GitHub and attach'
  Write-Host '  dist\panda.exe and dist\panda.exe.sha256'
  return
}
$a = Read-Host "Publish release v$Version to GitHub now? [y/N]"
if ($a -match '^[yY]') {
  gh release create "v$Version" dist\panda.exe dist\panda.exe.sha256 --title "Panda Code $Version" --generate-notes
} else { Write-Host 'Not published. Commit the version change, then run again when ready.' }
