#!/usr/bin/env bash
# Cut a release: copy the live skill from ~/.claude/skills into this repo,
# optionally bump the version, commit, tag, and push.
#   ./release.sh           # sync files, commit & push at current version
#   ./release.sh 1.7.0     # also bump VERSION + plugin.json to 1.7.0
set -euo pipefail
cd "$(dirname "$0")"
SRC="$HOME/.claude/skills/claude-classroom"
DST="skills/claude-classroom"
[ -f "$SRC/classroom.js" ] || { echo "✗ live skill not found at $SRC"; exit 1; }

cp "$SRC/SKILL.md" "$SRC/classroom.js" "$SRC/reference.md" "$DST/"
chmod +x "$DST/classroom.js"

NEW="${1:-}"
if [ -n "$NEW" ]; then
  perl -i -pe "s/const VERSION = '[^']*';/const VERSION = '$NEW';/" "$DST/classroom.js"
  perl -i -pe "s/(\"version\":\\s*\")[^\"]*(\")/\${1}$NEW\${2}/" .claude-plugin/plugin.json
fi
VER=$(grep -m1 "const VERSION" "$DST/classroom.js" | sed "s/.*'\(.*\)'.*/\1/")

node --check "$DST/classroom.js"
git add -A
if git diff --cached --quiet; then echo "nothing changed — already up to date (v$VER)"; exit 0; fi
git commit -m "release v$VER"
git tag "v$VER" 2>/dev/null || true
git push origin main --tags
echo "✔ released v$VER"
