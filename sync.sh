#!/usr/bin/env bash
#
# Publish this working tree to a fresh realpath and point the profile patch at it.
#
# Node's ESM module cache is keyed by resolved realpath, and the Cordis profile
# reload does not invalidate it. Once a plugin file has been imported, editing it
# in place keeps serving the old module until the host process restarts. Copying
# to a revision directory the Loader has never imported is what makes a host-code
# change take effect without a restart.
#
# `lib/page.html` is symlinked instead of copied, so viewer edits are read from
# this working tree on the next browser refresh and never need this script.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVE="$(dirname "$SRC")/live"
PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"

if [ ! -f "$PATCH" ]; then
  echo "sync: profile patch not found at $PATCH" >&2
  exit 1
fi

last="$(ls "$LIVE" 2>/dev/null | sed -n 's/^r\([0-9]\+\)$/\1/p' | sort -n | tail -1 || true)"
rev="$(( ${last:-0} + 1 ))"
dest="$LIVE/r$rev"

mkdir -p "$LIVE"
rm -rf "$dest"
cp -r "$SRC" "$dest"
rm -rf "$dest/.git" "$dest/live"
rm -f "$dest/lib/page.html"
ln -s "$SRC/lib/page.html" "$dest/lib/page.html"

python3 - "$PATCH" "$dest/lib/index.js" <<'PY'
import re
import sys

patch, entry = sys.argv[1], sys.argv[2]
src = open(patch, encoding='utf8').read()
new, count = re.subn(
    r"(?m)^(\s*name:\s*)'[^']*llm-trace[^']*'",
    lambda m: f"{m.group(1)}'{entry}'",
    src,
)
if count == 0:
    raise SystemExit('sync: no llm-trace entry found in the profile patch')
open(patch, 'w', encoding='utf8').write(new)
print(f"sync: profile patch now loads {entry}")
PY

echo "sync: published $dest"
