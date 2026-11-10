#!/usr/bin/env bash
# Installs the latest Temurin 21 JDK for this machine and links it as
# $HOME/.local/share/ma-desk-toolchain/jdk-21. No sudo, no system packages.
# Safe to run again: a release already on disk is only relinked, and if the
# Adoptium API can't be reached an existing install is kept.
#
# Needs curl, python3, sha256sum, tar and flock.
set -euo pipefail

root="$HOME/.local/share/ma-desk-toolchain"
link="$root/jdk-21"

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *)
    echo "bootstrap-toolchain: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$root"
# Other sessions on this machine share the toolchain directory.
exec 9>"$root/.lock"
flock 9

work="$(mktemp -d "$root/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

api="https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=$arch&image_type=jdk&os=linux&vendor=eclipse"
if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/assets.json" "$api"; then
  if [ -x "$link/bin/java" ]; then
    echo "bootstrap-toolchain: Adoptium API unreachable, keeping the existing JDK" >&2
    "$link/bin/java" -version
    exit 0
  fi
  echo "bootstrap-toolchain: Adoptium API unreachable and no JDK installed" >&2
  exit 1
fi

# The response names a path and a URL below, so check its shape before using it.
fields="$(python3 -I - "$work/assets.json" <<'EOF'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    assets = json.load(f)
if len(assets) != 1:
    sys.exit(f"expected one asset from the API, got {len(assets)}")
release = assets[0]["release_name"]
package = assets[0]["binary"]["package"]
if not re.fullmatch(r"jdk-21[A-Za-z0-9.+_-]*", release):
    sys.exit(f"unexpected release name: {release!r}")
if not re.fullmatch(r"[0-9a-f]{64}", package["checksum"]):
    sys.exit("unexpected checksum format")
if not package["link"].startswith("https://"):
    sys.exit("download link is not https")
print(release, package["checksum"], package["link"])
EOF
)"
read -r release checksum url <<<"$fields"

target="$root/$release"
if [ ! -x "$target/bin/java" ]; then
  echo "bootstrap-toolchain: downloading $release for $arch"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$work/jdk.tar.gz" "$url"
  echo "$checksum  $work/jdk.tar.gz" | sha256sum --check --quiet -

  mkdir "$work/unpacked"
  tar -xzf "$work/jdk.tar.gz" -C "$work/unpacked" --strip-components=1 --no-same-owner
  "$work/unpacked/bin/java" -version >/dev/null 2>&1

  # A partial attempt can't leave a directory behind: the move is the last step.
  rm -rf "$target"
  mv -T "$work/unpacked" "$target"
fi

ln -sfn "$target" "$work/link"
mv -T "$work/link" "$link"

echo "bootstrap-toolchain: $link -> $target"
"$link/bin/java" -version
