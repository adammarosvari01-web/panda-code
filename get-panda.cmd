@echo off
rem Installs Panda Code from cmd.exe (this just runs the PowerShell installer for you).
rem   curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.cmd -o "%TEMP%\get-panda.cmd" && "%TEMP%\get-panda.cmd"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.ps1 | iex"
exit /b %ERRORLEVEL%
