#!/usr/bin/env bash
# Cross-compiles desk-rtc and its dev tools, and packs the release artifact that ma-update installs
# (docs/interfaces/desk-runtime.md section 6).
#
#   ./build.sh                 version from git: 0.2.0-<short sha of desk-rtc/>[-dirty]
#   VERSION=0.2.0 ./build.sh   explicit version
#
# Output in dist/:
#   arm64/{desk-rtc,deskctl,gateway-shim,fake-deskd}
#   amd64/{desk-rtc,deskctl,gateway-shim,fake-deskd}
#   desk-rtc-<version>.tgz and .tgz.sha256
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  export PATH="$HOME/.local/go/bin:$PATH"
fi

if [ -z "${VERSION:-}" ]; then
  sha=$(git log -1 --format=%h -- . 2>/dev/null || echo unknown)
  VERSION="0.2.0-$sha"
  if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
    VERSION="$VERSION-dirty"
  fi
fi

# The workstation is shared: one package at a time, at low priority.
export CGO_ENABLED=0 GOOS=linux GOFLAGS="-p=1 -trimpath -buildvcs=false"
ldflags="-s -w -X main.version=$VERSION"

for arch in arm64 amd64; do
  mkdir -p "dist/$arch"
  for cmd in desk-rtc deskctl gateway-shim fake-deskd; do
    echo "build $arch/$cmd"
    GOARCH=$arch nice -n 10 go build -ldflags "$ldflags" -o "dist/$arch/$cmd" "./cmd/$cmd"
  done
done

# The release artifact holds only what runs on a desk. The dev tools never ship.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -m 0755 dist/arm64/desk-rtc "$stage/desk-rtc"
install -m 0755 release/run "$stage/run"
install -m 0755 release/health "$stage/health"
printf '%s\n' "$VERSION" > "$stage/VERSION"
chmod 0644 "$stage/VERSION"

artifact="desk-rtc-$VERSION.tgz"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' \
  -C "$stage" -cf - VERSION run health desk-rtc | gzip -n > "dist/$artifact"
(cd dist && sha256sum "$artifact" > "$artifact.sha256")

echo
echo "version:  $VERSION"
echo "artifact: dist/$artifact"
cat "dist/$artifact.sha256"
