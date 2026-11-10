#!/bin/bash
# package-desk-agent-filter.sh <version> [arm64|amd64]: packs desk-agent-filter's release artifact for ma-update (runtime
# spec section 6), from recipe/desk-agent-filter, after its tests. Output: dist/desk-agent-filter-<version>[-amd64].tgz, .sha256.
# The same source, Go version and flags give the same bytes, so recipe/releases.pin can name them without a published
# release: bake.sh runs this and refuses a hash that isn't the pin's. amd64 is for a look here; selfhost/build-bundle.sh
# builds a self-hosted desk's.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/recipe/desk-agent-filter
GO_VERSION=go1.27.3   # the build's input: a new one changes the hash, so change the pin with it
VERSION=${1:-}; ARCH=${2:-arm64}
[[ $VERSION =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || { echo "usage: package-desk-agent-filter.sh <version> [arm64|amd64]" >&2; exit 2; }
case $ARCH in arm64) artifact=desk-agent-filter-$VERSION.tgz ;; amd64) artifact=desk-agent-filter-$VERSION-amd64.tgz ;; *) echo "bad arch $ARCH" >&2; exit 2 ;; esac
command -v go >/dev/null 2>&1 || export PATH="$HOME/.local/go/bin:$PATH"
export GOTOOLCHAIN=local
have=$(go env GOVERSION)
[ "$have" = "$GO_VERSION" ] || { echo "this needs $GO_VERSION, and go here is $have" >&2; exit 1; }
(cd "$SRC" && GOFLAGS=-p=1 nice -n 19 go test -count=1 ./... >/dev/null) || { echo "tests fail: (cd recipe/desk-agent-filter && go test ./...)" >&2; exit 1; }
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
(cd "$SRC" && CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH GOFLAGS="-p=1 -trimpath -buildvcs=false" nice -n 10 go build -ldflags "-s -w -buildid=" -o "$stage/desk-agent-filter" .)
install -m 0755 "$SRC/run" "$SRC/health" "$stage/"
chmod 0755 "$stage/desk-agent-filter"
printf '%s\n' "$VERSION" > "$stage/VERSION"; chmod 0644 "$stage/VERSION"
mkdir -p "$HERE/dist"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - VERSION run health desk-agent-filter | gzip -n > "$HERE/dist/$artifact"
(cd "$HERE/dist" && sha256sum "$artifact" > "$artifact.sha256")
echo "artifact: $HERE/dist/$artifact"
cat "$HERE/dist/$artifact.sha256"
