#!/usr/bin/env bash
#
# Publish this working tree to a fresh revision and make the host pick it up.
#
# Two constraints shape this, and they pull in opposite directions:
#
# 1. Node's ESM module cache is keyed by resolved realpath, and the Cordis
#    profile reload does not invalidate it. Editing a plugin file in place keeps
#    serving the old module until the host restarts, so the Loader row name has
#    to change for a host-code edit to take effect. That is what the revision
#    directory is for.
#
# 2. `dsh-client-modules` snapshots the client bundle at scan time and re-reads
#    it only through the HMR watch on the path it captured. That path belongs to
#    whichever revision first registered the package, and a revision whose
#    directory has been deleted cannot be stat-ed: the watch goes permanently
#    dirty and the bundle freezes at the old snapshot. So superseded revisions
#    are NEVER removed.
#
# `lib/page.html` and `lib/client.js` are symlinked rather than copied. The host
# reads both from disk through the captured path, so linking them back to this
# working tree is what keeps viewer and browser-half edits live on a refresh.
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
entry="$dest/lib/index.js"

mkdir -p "$LIVE"
rm -rf "$dest"
cp -r "$SRC" "$dest"
rm -rf "$dest/.git" "$dest/live"
for face in page.html client.js; do
  rm -f "$dest/lib/$face"
  ln -s "$SRC/lib/$face" "$dest/lib/$face"
done

python3 - "$PATCH" "$entry" <<'PY'
import re
import sys

patch, entry = sys.argv[1], sys.argv[2]
src = open(patch, encoding='utf8').read()
src = re.sub(r"\n- insert:\n    - id: llm-trace\n      name: '[^']*'\n", "\n", src)
if "id: llm-trace" in src:
    raise SystemExit('sync: could not remove the existing llm-trace row')
with open(patch, 'w', encoding='utf8') as handle:
    handle.write(src.rstrip('\n') + f"\n\n- insert:\n    - id: llm-trace\n      name: '{entry}'\n")
print(f"sync: row now loads {entry}")
PY

echo "sync: published $dest"
echo "sync: previous revisions are kept on purpose — see the header comment"
