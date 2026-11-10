#!/usr/bin/env bash
# Builds ma-move as static binaries for the self-hosted desk.
#
#   ./build.sh                 version from git: 0.1.0-<short sha of tools/desk-move/>[-dirty]
#   VERSION=0.1.0 ./build.sh   explicit version
#
# Output: dist/amd64/ma-move, dist/arm64/ma-move and dist/SHA256SUMS.
# On the shared workstation, run it as: flock ~/work/.build.lock nice -n 10 ./build.sh
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  export PATH="$HOME/.local/go/bin:$PATH"
fi

if [ -z "${VERSION:-}" ]; then
  sha=$(git log -1 --format=%h -- . 2>/dev/null || true)
  VERSION="0.1.0-${sha:-uncommitted}"
  if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then
    VERSION="$VERSION-dirty"
  fi
fi

# Static: no cgo, so it runs on any Linux the self-hosted desk has.
export CGO_ENABLED=0 GOOS=linux GOFLAGS="-p=1 -trimpath -buildvcs=false"
ldflags="-s -w -X github.com/minimalist-alliance/ma-desk/tools/desk-move/internal/move.Version=$VERSION"

rm -rf dist
for arch in amd64 arm64; do
  mkdir -p "dist/$arch"
  echo "build $arch/ma-move $VERSION"
  GOARCH=$arch nice -n 10 go build -ldflags "$ldflags" -o "dist/$arch/ma-move" ./cmd/ma-move
done
(cd dist && sha256sum amd64/ma-move arm64/ma-move > SHA256SUMS)
cat dist/SHA256SUMS
