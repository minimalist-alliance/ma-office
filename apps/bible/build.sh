#!/usr/bin/env bash
# Builds the Bible app's packages (desk app contract §1): static linux/arm64 (desks) and linux/amd64 (tests) builds of
# bible-app, files/ assembled (bin, texts with STATEMENT.txt and SOURCE.md, view), packed with tools/pack, dev-signed
# with throwaway Ed25519 keys made fresh in a scratch folder, and checked with the contract sample's ma-app verify.
#
#   apps/bible/build.sh [--dev] [--out DIR] [--texts DIR]
#
# The view is apps/bible/view/ (the UI/UX Engineer's). Until it exists, --dev packs view-dev/, a plain test aid;
# without --dev the build refuses. The texts must be format 2 (apps/bible/texts/README.md).
#
# These packages are signed by keys that exist only for this run: no desk trusts them. A real package needs MA's
# review key, which doesn't exist yet (the contract's "For the Platform Engineer").
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
GO="${GO:-$(command -v go || echo "$HOME/.local/go/bin/go")}"
dev=0
out="$here/dist"
texts="$here/texts"
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) dev=1 ;;
    --out) out="$2"; shift ;;
    --texts) texts="$2"; shift ;;
    *) echo "usage: $0 [--dev] [--out DIR] [--texts DIR]" >&2; exit 2 ;;
  esac
  shift
done

if [ -d "$here/view" ]; then
  view="$here/view"
elif [ "$dev" = 1 ]; then
  view="$here/view-dev"
  echo "build: no view/ yet: packing view-dev/, the developer view, which is not the product view" >&2
else
  echo "build: no apps/bible/view/ (the product view). Use --dev to pack view-dev/ for testing." >&2
  exit 1
fi
for f in index.html view.js view.css; do
  [ -f "$view/$f" ] || { echo "build: $view/$f is missing" >&2; exit 1; }
done
for code in bsb web kjv asv; do
  for f in "$code.tsv" books.tsv STATEMENT.txt SOURCE.md; do
    [ -f "$texts/$code/$f" ] || { echo "build: $texts/$code/$f is missing" >&2; exit 1; }
  done
  head -1 "$texts/$code/$code.tsv" | grep -qx "# ma-bible-text 2 $code" ||
    { echo "build: $texts/$code/$code.tsv isn't format 2" >&2; exit 1; }
done

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$out"
version="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$here/ma-app.json")"
host="$("$GO" env GOARCH)"

(cd "$repo/spikes/app-contract-sample" && CGO_ENABLED=0 nice -n 10 "$GO" build -o "$scratch/ma-app" ./cmd/ma-app)
(cd "$here" && CGO_ENABLED=0 nice -n 10 "$GO" build -o "$scratch/pack" ./tools/pack)
ma_app="$scratch/ma-app"
"$ma_app" keygen -out "$scratch/dev.json"
"$ma_app" keygen -out "$scratch/review.json"
"$ma_app" trust -review "$scratch/review.json" -tier first-party -dev "$scratch/dev.json" \
  -publisher "Minimalist Alliance" -out "$scratch/trust.json"

for arch in arm64 amd64; do
  stage="$scratch/$arch/files"
  mkdir -p "$stage/bin" "$stage/view"
  (cd "$here" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" nice -n 10 "$GO" build -trimpath -ldflags "-s -w" \
    -o "$stage/bin/bible-app" ./server)
  cp "$view/index.html" "$view/view.js" "$view/view.css" "$stage/view/"
  for code in bsb web kjv asv; do
    mkdir -p "$stage/texts/$code"
    cp "$texts/$code/$code.tsv" "$texts/$code/books.tsv" "$texts/$code/STATEMENT.txt" "$texts/$code/SOURCE.md" "$stage/texts/$code/"
  done
  chmod 0644 "$stage"/view/* "$stage"/texts/*/*
  chmod 0755 "$stage/bin/bible-app"
  pkg="$out/bible-$version-$arch.maapp"
  "$scratch/pack" -manifest "$here/ma-app.json" -files "$stage" -arch "$arch" -key "$scratch/dev.json" -out "$scratch/dev-$arch.maapp"
  "$ma_app" sign -pkg "$scratch/dev-$arch.maapp" -key "$scratch/review.json" -out "$pkg"
  if [ "$arch" = "$host" ]; then
    "$ma_app" verify -pkg "$pkg" -trust "$scratch/trust.json"
  else
    # ma-app checks the package against its own arch, so the other arch's only allowed problem is that one.
    msg="$("$ma_app" verify -pkg "$pkg" -trust "$scratch/trust.json" 2>&1 || true)"
    [ "$msg" = "ma-app verify: manifest: arch: package is \"$arch\", desk is \"$host\"" ] ||
      { echo "build: $arch: $msg" >&2; exit 1; }
    echo "ok: $(basename "$pkg"): everything but the arch checked on this $host machine"
  fi
  echo "$(sha256sum "$pkg" | cut -d' ' -f1)  $(basename "$pkg")  $(stat -c %s "$pkg") bytes"
done
