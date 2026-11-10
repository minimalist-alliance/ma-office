#!/usr/bin/env bash
# One distiller, not two (task 47): deskd's distiller.js is the prototype's extract.js, byte for byte, at a pinned
# commit. This copies it and pins it; DistillerPinTest fails if deskd's copy and the pin ever disagree, or if the copy
# differs from the prototype at the pinned commit. What deskd must do differently (no click path, its own entry points,
# its built-in cosmetic rules) it does as it loads the file (Scripts.java), never by editing it.
#
# The distiller's security test pages come with it, into deskd's test resources.
#
#   services/scripts/sync-distiller.sh [<commit or ref>]     # default: origin/sub/distiller-v2
set -euo pipefail
ref="${1:-origin/sub/distiller-v2}"
root="$(git rev-parse --show-toplevel)"
src="spikes/browser-bench/minified-proto/server/extract.js"
dst="$root/services/deskd/src/main/resources/com/minimalistalliance/desk/deskd/browser/minified"
git -C "$root" fetch -q origin 2>/dev/null || true
commit="$(git -C "$root" rev-parse --verify "$ref^{commit}")"
git -C "$root" show "$commit:$src" > "$dst/distiller.js.tmp"
mv "$dst/distiller.js.tmp" "$dst/distiller.js"
sum="$(sha256sum "$dst/distiller.js" | cut -d' ' -f1)"
printf 'commit=%s\npath=%s\nsha256=%s\n' "$commit" "$src" "$sum" > "$dst/distiller.pin"
echo "distiller.js is $src at $commit ($sum)"

# The distiller's security test pages (T47X), byte for byte, for MinifiedChromiumIT to run through deskd's own path.
pages="spikes/browser-bench/minified-proto/tests/security"
tests="$root/services/deskd/src/test/resources/minified/security"
mkdir -p "$tests"
rm -f "$tests"/*.html
for page in $(git -C "$root" ls-tree --name-only "$commit" "$pages/" | grep '\.html$'); do
  git -C "$root" show "$commit:$page" > "$tests/$(basename "$page")"
done
printf 'commit=%s\npath=%s\n' "$commit" "$pages" > "$tests/pages.pin"
echo "security pages: $(ls "$tests"/*.html | wc -l) from $pages at $commit"
