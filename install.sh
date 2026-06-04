#!/usr/bin/env bash
# Claude Classroom installer.
# Works two ways:
#   • git clone … && ./install.sh        (copies local files)
#   • curl -fsSL <raw>/install.sh | bash (downloads files)
set -euo pipefail

REPO="${CLASSROOM_REPO:-Manueldav2/claude-classroom}"
BRANCH="${CLASSROOM_BRANCH:-main}"
DEST="$HOME/.claude/skills/claude-classroom"
FILES="SKILL.md classroom.js reference.md"

command -v node >/dev/null 2>&1 || { echo "✗ node is required (>=16). Install Node, then re-run."; exit 1; }

echo "Installing Claude Classroom → $DEST"
mkdir -p "$DEST"

# Prefer local files (clone case); otherwise download from the repo.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
LOCAL="$SELF_DIR/skills/claude-classroom"
if [ -f "$LOCAL/classroom.js" ]; then
  for f in $FILES; do cp "$LOCAL/$f" "$DEST/$f"; done
  echo "  copied from local checkout"
else
  command -v curl >/dev/null 2>&1 || { echo "✗ curl needed to download files"; exit 1; }
  BASE="https://raw.githubusercontent.com/$REPO/$BRANCH/skills/claude-classroom"
  for f in $FILES; do
    echo "  fetching $f"
    curl -fsSL "$BASE/$f" -o "$DEST/$f"
  done
fi
chmod +x "$DEST/classroom.js"

# Short `classroom` launcher on PATH (points at the engine wherever it landed).
LAUNCH=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then
    printf '#!/bin/sh\nif [ $# -eq 0 ]; then set -- status; fi\nexec node "%s/classroom.js" "$@"\n' "$DEST" > "$d/classroom"
    chmod +x "$d/classroom"
    LAUNCH="$d/classroom"
    break
  fi
done

echo ""
echo "✔ Installed."
echo "  Skill:  /claude-classroom   (invoke it once in any git repo — it self-installs hooks so"
echo "          every future Claude Code session there auto-coordinates, forever)"
[ -n "$LAUNCH" ] && echo "  CLI:    classroom watch   (live dashboard)   ·   classroom   (snapshot)" \
                 || echo "  CLI:    node \"$DEST/classroom.js\" watch   (add a bin dir to PATH for the short 'classroom' command)"
echo ""
echo "Try it: open two Claude Code sessions in the same repo and run /claude-classroom in each."
