#!/usr/bin/env bash
# Builds commons-server and packs the release artifact that ma-update installs (docs/interfaces/desk-runtime.md
# section 6), as desk-rtc/build.sh does for its static Go binary and services/scripts/package-release.sh for
# desk-notebook: VERSION, run, health and the env file at the archive's root, then the binary.
#
#   apps/commons/release.sh                  version from git: 0.2.0-<short sha of apps/commons/>[-dirty]
#   VERSION=0.2.0 apps/commons/release.sh    explicit version
#
# Output in apps/commons/dist/:
#   arm64/commons-server, amd64/commons-server (Guild Desks are Graviton; amd64 is for the load test and labs)
#   commons-server-<version>.tgz and .tgz.sha256 (arm64)
#
# The units (deploy/commons-server.service and deploy/commons-server-address.service) go in the image recipe, with user commons (uid 1110); see README, "Running
# on a guild desk". Publishing and pinning are scripts/desk-service-release.sh and image/recipe/releases.pin, as for
# every component. Heavy on the shared machine: run it under flock ~/work/.build.lock nice -n 10.
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
[[ $VERSION =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "release: bad version: $VERSION" >&2; exit 1; }

export CGO_ENABLED=0 GOOS=linux GOFLAGS="-p=1 -trimpath -buildvcs=false"
for arch in arm64 amd64; do
  mkdir -p "dist/$arch"
  echo "build $arch/commons-server"
  (cd server && GOARCH=$arch nice -n 10 go build -ldflags "-s -w" -o "../dist/$arch/commons-server" ./cmd/commons-server)
done

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -m 0755 dist/arm64/commons-server "$stage/commons-server"
install -m 0755 deploy/run "$stage/run"
install -m 0755 deploy/health "$stage/health"
install -m 0755 deploy/address "$stage/address"
install -m 0644 deploy/commons-server.env "$stage/commons-server.env"
printf '%s\n' "$VERSION" > "$stage/VERSION"
chmod 0644 "$stage/VERSION"

artifact="commons-server-$VERSION.tgz"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' \
  -C "$stage" -cf - VERSION run health address commons-server.env commons-server | gzip -n > "dist/$artifact"
(cd dist && sha256sum "$artifact" > "$artifact.sha256")

echo
echo "version:  $VERSION"
echo "artifact: apps/commons/dist/$artifact"
cat "dist/$artifact.sha256"
