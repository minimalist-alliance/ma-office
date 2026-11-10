#!/bin/bash
# package-desk-egress.sh [version]: packs desk-egress's release artifact for ma-update (runtime spec section 6).
# Budgets live in /etc/ma/egress.conf, which is the image's and not in this release. Output: dist/desk-egress-<version>.tgz and .sha256.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/recipe/desk-egress
VERSION=${1:-0.1.0-$(git -C "$HERE" log -1 --format=%h -- recipe/desk-egress)}
[[ $VERSION =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || { echo "bad version" >&2; exit 2; }
python3 -I "$HERE/tests/test_desk_egress.py" >/dev/null 2>&1 || { echo "tests fail: python3 -I tests/test_desk_egress.py" >&2; exit 1; }
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp -a "$SRC/." "$stage/"
printf '%s\n' "$VERSION" > "$stage/VERSION"
mkdir -p "$HERE/dist"
artifact=desk-egress-$VERSION.tgz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - . | gzip -n > "$HERE/dist/$artifact"
(cd "$HERE/dist" && sha256sum "$artifact" > "$artifact.sha256")
echo "artifact: $HERE/dist/$artifact"
cat "$HERE/dist/$artifact.sha256"
