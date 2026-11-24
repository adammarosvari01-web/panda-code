#!/usr/bin/env sh
# Installs Panda Code on macOS / Linux (needs Node.js 20.3 or newer).
#
#   curl -fsSL https://raw.githubusercontent.com/adammarosvari01-web/panda-code/main/get-panda.sh | sh
#
# Options (environment variables):
#   PANDA_REPO   GitHub "owner/name"            (default: the official repository)
#   PANDA_REF    branch or tag to install       (default: main)
#   PANDA_DIR    where the script is kept       (default: ~/.local/share/panda-code)
#   PANDA_BIN    where the commands are placed  (default: ~/.local/bin)
set -eu
REPO="${PANDA_REPO:-adammarosvari01-web/panda-code}"
REF="${PANDA_REF:-main}"
DIR="${PANDA_DIR:-$HOME/.local/share/panda-code}"
BIN="${PANDA_BIN:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then echo "Node.js 20.3+ is required: https://nodejs.org" >&2; exit 1; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=3)?0:1)' \
  || { echo "Node.js 20.3+ is required (you have $(node -v))." >&2; exit 1; }

mkdir -p "$DIR" "$BIN"
echo "Downloading Panda Code ($REPO@$REF) ..."
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/panda.js" -o "$DIR/panda.js"
printf '#!/usr/bin/env sh\nexec node "%s/panda.js" "$@"\n' "$DIR" > "$BIN/pandacode"
chmod +x "$BIN/pandacode"
cp -f "$BIN/pandacode" "$BIN/panda"
echo "Installed: $BIN/pandacode"

case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH, e.g.:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile";; esac
if ! command -v ollama >/dev/null 2>&1; then
  echo ""
  echo "Panda needs a local AI engine. Ollama is the easiest, and it is not installed. Install it with:"
  echo "  curl -fsSL https://ollama.com/install.sh | sh        (or see https://ollama.com/download)"
fi
echo ""
echo "Done. Run:  pandacode"
echo "The first time, Panda shows the AI models that suit this PC, best first, and downloads the one you pick."
