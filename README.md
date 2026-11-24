# Panda Code

A terminal coding agent for **local AI models** (Ollama, LM Studio, llama.cpp, any OpenAI-compatible server).
It reads, writes and edits files, runs commands, searches the web, and works on whole projects from your terminal.

## Install

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.ps1 | iex
```
Downloads the latest `panda.exe`, adds it to your PATH, and offers to install Ollama.

**Windows, from cmd.exe** (the line above is PowerShell syntax and does not work in cmd):
```bat
curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.cmd -o "%TEMP%\get-panda.cmd" && "%TEMP%\get-panda.cmd"
```

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

## If the AI stops or Ollama says "truncating input prompt"

Ollama gives a model a small context window unless it is told otherwise, so long chats get cut off at the start and the AI loses its instructions.
Panda notices this and recovers, and `pandacode doctor` (or `/doctor` inside Panda) shows what Ollama really uses and how to fix it.
On Linux and macOS the installer can apply the fix for you: `curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.sh | sh -s fix-ollama`.

## Discord bot

`/discord` lets people on a Discord server @mention Panda (or DM it) and get answers from the model Panda is currently using. Panda needs a free **bot** for this: webhooks can only send messages, they cannot listen.

1. Create an application at https://discord.com/developers/applications, open its **Bot** tab and copy the token.
2. In Panda: `/discord token <token>`, then `/discord on`. Panda prints an invite link; open it to add the bot to your server.
3. `/discord off` turns it off. `/discord status` shows what it is doing.

It is chat-only: people on Discord get no access to your files, shell or anything else on your PC. Each person can ask once every 10 seconds (`/discord cooldown <seconds>`), and `/discord channel <id>` limits it to one channel. With a webhook (`/discord webhook <url>`) you can also post announcements: `/discord say <text>`.
## Build and release (maintainers)

```powershell
.\build.ps1                # builds dist\panda.exe with the panda icon
.\release.ps1 -Version 1.0.1   # builds, writes a checksum, and publishes a GitHub release after you confirm
```
The model ranking is built in; override or extend it with `~/.panda/models.json`.
