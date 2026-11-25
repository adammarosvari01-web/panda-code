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

## Copy and paste

Drag with the mouse to copy: you get plain text only, without colours, symbols or false line breaks. Right-click pastes. Pasted text is always inserted as plain text, and a multi-line paste goes in as one block that is sent when you press Enter. `/copy` copies the last reply and `/copy code` its last code block. `/mouse off` gives the mouse back to your terminal.

You can keep typing while Panda works; press Enter to queue the message.

## Memory

Say `remember that I prefer short answers` and Panda keeps it for every future conversation. It also saves lasting preferences you mention. `/memory` lists what it knows, `/memory forget 2` removes one, `/memory off` switches it off. It is stored in `~/.panda/memory.json`, and Panda refuses to store things that look like passwords or keys.

## Computer control (Windows)

```
/bypasspermissions
control my computer to open Notepad and write a shopping list
```

Needs a model that can see images (marked "vision" in `/model`) and **bypass permissions** on. With it off, Panda says it cannot do it.

1. Panda repeats your request and its plan, and waits for your yes.
2. It shares your screen with the local model (captured at 30 fps, seen at 480p, with no border on screen), minimises its own window, then clicks and types. The model looks at the newest frame at every step; no local model can process all 30 frames each second.
3. Items Windows can describe are clicked at their exact centre. Anything else is checked in a full-resolution close-up before the click.
4. **Press Esc at any time, in any window**, and everything stops at once.

`/computer screen 2|all`, `/computer res 720` (sharper, slower), `/computer window keep`.

**Be careful:** a model controlling your PC can make mistakes. Close anything sensitive, stay nearby, and do not use it for payments or irreversible actions. Panda will not type into password boxes. Esc and clicks may not reach programs running as administrator.

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
### Build a whole server

`/discord server` previews, and `/discord server setup` builds, an organised community server using your bot: roles (**Panda Team**, **Panda Bot Access**), information, community, support, bot and private team channels, server rules, and a pinned note in each channel. Nothing that already exists is deleted or changed.

Information channels are read-only. The bot answers only in `#ask-panda`, only to members with one of the two roles (and the server owner), and direct messages are off. Adjust with `/discord role <id|clear>`, `/discord channel <id>` and `/discord dm on|off`.

After setup you can remove the bot's Manage Channels and Manage Roles permissions in Discord's role settings; chatting does not need them.
## Learn mode

```
/learn python to beginner
/learn spanish A2
/learn organic chemistry to university level
/learn                  (continue where you left off)
/learn list
```

Panda plans a short course, then asks multiple-choice questions (press A-D). Get one wrong and it teaches you the idea. You can choose **Teach me this** before answering, **ask your tutor** anything, or challenge an answer you think is wrong, which makes it re-check carefully. Two right in a row masters a lesson, progress is saved, and a mixed final test sends missed lessons back into practice.

Questions and explanations come from your local model, so they can be wrong. Panda has the model solve each question a second time without seeing the answer key and discards questions where the two disagree, but check anything important against a trusted source.
## Build and release (maintainers)

```powershell
.\build.ps1                # builds dist\panda.exe with the panda icon
.\release.ps1 -Version 1.0.1   # builds, writes a checksum, and publishes a GitHub release after you confirm
```
The model ranking is built in; override or extend it with `~/.panda/models.json`.
