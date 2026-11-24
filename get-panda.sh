#!/usr/bin/env sh
# Installs Panda Code on macOS / Linux (needs Node.js 20.3 or newer) and fixes Ollama's
# "truncating input prompt" problem that makes the AI cut off long chats and stop.
#
#   curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.sh | sh -s fix-ollama   (only the Ollama fix)
#
# Options (environment variables):
#   PANDA_REPO   GitHub "owner/name"                 (default: the official repository)
#   PANDA_REF    branch or tag to install            (default: main)
#   PANDA_DIR    where panda.js is kept              (default: ~/.local/share/panda-code)
#   PANDA_BIN    where the commands are placed       (default: ~/.local/bin)
#   PANDA_CTX    context length for Ollama           (default: 32768)
#   PANDA_YES=1  answer "yes" to every question
set -eu

REPO="${PANDA_REPO:-adammarosvari01-web/panda-code}"
REF="${PANDA_REF:-main}"
DIR="${PANDA_DIR:-$HOME/.local/share/panda-code}"
BIN="${PANDA_BIN:-$HOME/.local/bin}"
CTX="${PANDA_CTX:-32768}"
RAW="${PANDA_RAW:-https://raw.githubusercontent.com}"
OS="${PANDA_OS:-$(uname -s)}"
if [ "${PANDA_SUDO+set}" = set ]; then SUDO="$PANDA_SUDO"; elif [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi

say() { printf '%s\n' "$*"; }

# ask "question": succeeds if the user says yes. When the script is piped from curl, stdin is the script itself, so read from the terminal.
ask() {
  [ "${PANDA_YES:-}" = 1 ] && return 0
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r _answer </dev/tty || return 1
    case "$_answer" in y|Y|yes|YES|Yes) return 0 ;; esac
  fi
  return 1
}

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else say "curl or wget is required." >&2; exit 1; fi
}

# ---- Ollama: the fix for "truncating input prompt" ----------------------------------------------------------------
# A background Ollama (systemd service on Linux, the app on macOS) does not read your shell settings, so it falls back to
# a small context window. Long chats then get their beginning cut off and the AI loses its instructions and stops.
ollama_conf() { printf '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=%s"\nEnvironment="OLLAMA_NUM_PARALLEL=1"\n' "$CTX"; }

fix_ollama() {
  case "$OS" in
    Linux)
      SYSTEMCTL="${PANDA_SYSTEMCTL:-systemctl}"
      CONF_DIR="${PANDA_CONF_DIR:-/etc/systemd/system/ollama.service.d}"
      if ! command -v "$SYSTEMCTL" >/dev/null 2>&1 || ! "$SYSTEMCTL" list-unit-files ollama.service 2>/dev/null | grep -q ollama; then
        say "Ollama is not running as a systemd service on this machine."
        say "If you start it yourself, start it like this so it keeps long chats intact:"
        say "  OLLAMA_CONTEXT_LENGTH=$CTX OLLAMA_NUM_PARALLEL=1 ollama serve"
        return 0
      fi
      CONF="$CONF_DIR/panda.conf"
      if [ -f "$CONF" ] && [ "$(cat "$CONF")" = "$(ollama_conf)" ]; then say "Ollama settings are already in place ($CONF)."; return 0; fi
      say "Panda will set two things for the Ollama service:"
      say "  OLLAMA_CONTEXT_LENGTH=$CTX   (so long chats are not truncated)"
      say "  OLLAMA_NUM_PARALLEL=1        (so the context is not split between parallel requests)"
      if ask "Apply this now? It needs sudo and restarts Ollama."; then
        $SUDO mkdir -p "$CONF_DIR"
        ollama_conf | $SUDO tee "$CONF" >/dev/null
        $SUDO "$SYSTEMCTL" daemon-reload
        $SUDO "$SYSTEMCTL" restart ollama
        say "Done. Ollama was restarted with the new settings ($CONF)."
      else
        say "Skipped. To do it yourself:"
        say "  sudo systemctl edit ollama   # add the [Service] lines above, then:  sudo systemctl restart ollama"
      fi
      ;;
    Darwin)
      LAUNCHCTL="${PANDA_LAUNCHCTL:-launchctl}"
      if ! command -v "$LAUNCHCTL" >/dev/null 2>&1; then say "Run:  launchctl setenv OLLAMA_CONTEXT_LENGTH $CTX ; launchctl setenv OLLAMA_NUM_PARALLEL 1   then restart the Ollama app."; return 0; fi
      say "Panda will tell the Ollama app to use a context length of $CTX and 1 parallel request."
      if ask "Apply this now?"; then
        "$LAUNCHCTL" setenv OLLAMA_CONTEXT_LENGTH "$CTX"
        "$LAUNCHCTL" setenv OLLAMA_NUM_PARALLEL 1
        if command -v osascript >/dev/null 2>&1; then osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true; sleep 2; open -a Ollama >/dev/null 2>&1 || true; say "Done. Ollama was restarted."
        else say "Done. Quit Ollama from the menu bar and open it again."; fi
      else say "Skipped. Later, run:  launchctl setenv OLLAMA_CONTEXT_LENGTH $CTX ; launchctl setenv OLLAMA_NUM_PARALLEL 1  and restart Ollama."; fi
      ;;
    *) say "No automatic Ollama fix for $OS. Set OLLAMA_CONTEXT_LENGTH=$CTX and OLLAMA_NUM_PARALLEL=1 for the Ollama server and restart it." ;;
  esac
}

if [ "${1:-}" = "fix-ollama" ]; then fix_ollama; exit 0; fi

# ---- Panda Code ----------------------------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  say "Node.js 20.3 or newer is required, and it was not found." >&2
  case "$OS" in
    Darwin) say "  Install it with:  brew install node     (or download from https://nodejs.org)" >&2 ;;
    *) say "  Install it from https://nodejs.org, or with your package manager (for example: sudo apt install nodejs npm)." >&2 ;;
  esac
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=3)?0:1)' \
  || { say "Node.js 20.3 or newer is required (you have $(node -v))." >&2; exit 1; }

mkdir -p "$DIR" "$BIN"
say "Downloading Panda Code ($REPO @ $REF) ..."
fetch "$RAW/$REPO/$REF/panda.js" "$DIR/panda.new.js" \
  || { say "Could not download Panda Code from $RAW/$REPO/$REF. Check the repository name, the branch, and your internet connection." >&2; exit 1; }
[ "$(head -c 2 "$DIR/panda.new.js")" = "#!" ] || { rm -f "$DIR/panda.new.js"; say "The download is not Panda Code (wrong repository or branch?)." >&2; exit 1; }
node --check "$DIR/panda.new.js" || { rm -f "$DIR/panda.new.js"; say "The download is damaged. Nothing was installed." >&2; exit 1; }
mv -f "$DIR/panda.new.js" "$DIR/panda.js"
printf '#!/usr/bin/env sh\nexec node "%s/panda.js" "$@"\n' "$DIR" > "$BIN/pandacode"
chmod +x "$BIN/pandacode"
cp -f "$BIN/pandacode" "$BIN/panda"
say "Installed: $BIN/pandacode  (also: panda)"

# make sure the commands are on the PATH
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    case "$(basename "${SHELL:-sh}")" in zsh) RC="$HOME/.zshrc" ;; bash) RC="$HOME/.bashrc" ;; *) RC="$HOME/.profile" ;; esac
    say "$BIN is not on your PATH."
    if ask "Add it to $RC?"; then printf '\nexport PATH="%s:$PATH"\n' "$BIN" >> "$RC"; say "Added. Open a new terminal to use it."
    else say "Add this line to your shell profile:  export PATH=\"$BIN:\$PATH\""; fi
    ;;
esac

# ---- the AI engine -------------------------------------------------------------------------------------------------
if ! command -v "${PANDA_OLLAMA:-ollama}" >/dev/null 2>&1; then
  say ""
  say "Panda needs a local AI engine. Ollama is the easiest one, and it is not installed."
  case "$OS" in
    Linux)
      say "Ollama's official installer is:  curl -fsSL https://ollama.com/install.sh | sh"
      if ask "Run it now? (it asks for sudo)"; then sh -c "${PANDA_OLLAMA_INSTALL_CMD:-curl -fsSL https://ollama.com/install.sh | sh}"; fi ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        if ask "Install Ollama now with Homebrew?"; then sh -c "${PANDA_OLLAMA_INSTALL_CMD:-brew install --cask ollama}"; fi
      else say "Download it from https://ollama.com/download"; fi ;;
    *) say "Download it from https://ollama.com/download" ;;
  esac
fi
if command -v "${PANDA_OLLAMA:-ollama}" >/dev/null 2>&1; then say ""; fix_ollama; fi

say ""
say "Done. Run:  pandacode"
say "The first time, Panda shows the AI models that suit this machine, best first, and downloads the one you pick."
say "If the AI ever stops or says it truncated the prompt, run:  pandacode doctor"
