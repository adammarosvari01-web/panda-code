# Panda Code

A terminal coding agent for **local AI models** (Ollama, LM Studio, llama.cpp, any OpenAI-compatible server).
It reads, writes and edits files, runs commands, searches the web, and works on whole projects from your terminal.

## Install

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.ps1 | iex
```
Downloads the latest `panda.exe`, adds it to your PATH, and offers to install Ollama.

**macOS / Linux** (needs Node.js 20.3+):
```sh
curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.sh | sh
```

**Any OS with Node.js and Git:**
```sh
npm install -g github:adammarosvari01-web/panda-code
```

Then open a new terminal and run `pandacode` (or `panda`).

## First run

If Ollama has no models yet, Panda shows the models that fit **this PC**, best first, least suitable last, and downloads the one you pick.
Use `/model` any time to switch. Type `/help` for everything else.

## Update

```
/update          (inside Panda)
pandacode update
```
Updates come from this repository's releases.

## Build and release (maintainers)

```powershell
.\build.ps1                # builds dist\panda.exe with the panda icon
.\release.ps1 -Version 1.0.1   # builds, writes a checksum, and publishes a GitHub release after you confirm
```
The model ranking is built in; override or extend it with `~/.panda/models.json`.
