#!/bin/bash
# package-desk-stream.sh [version]: packs desk-stream's release artifact for ma-update (runtime spec section 6).
# To change encoder settings: edit recipe/desk-stream/stream.conf, run this, hand the artifact to the rollout.
# A gst-plugins/ directory next to stream.conf is packed too: from 0.3.0 it holds deskcap (ADR 0073) in aarch64/ (cloud
# desks) and x86_64/ (self-hosted ones), each built from src/deskcap.c on Debian 13 with the gcc line in its BUILD, which
# also names the source's hash. run picks the folder for the machine. Output: dist/desk-stream-<version>.tgz and .sha256.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/recipe/desk-stream
VERSION=${1:-0.2.0-$(git -C "$HERE" log -1 --format=%h -- recipe/desk-stream)}
[[ $VERSION =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || { echo "bad version" >&2; exit 2; }
# A plugin built from other source than the one beside it would ship code nobody reviewed: refuse it.
if [ -f "$SRC/src/deskcap.c" ]; then
  for arch in aarch64:'ARM aarch64' x86_64:'x86-64'; do
    dir=$SRC/gst-plugins/${arch%%:*} so=$SRC/gst-plugins/${arch%%:*}/libgstdeskcap.so build=$SRC/gst-plugins/${arch%%:*}/BUILD
    [ -f "$so" ] && [ -f "$build" ] || { echo "no $dir/libgstdeskcap.so and BUILD: build it first" >&2; exit 1; }
    [ "$(awk '$1 == "source-sha256" {print $2}' "$build")" = "$(sha256sum "$SRC/src/deskcap.c" | cut -d' ' -f1)" ] \
      || { echo "$so was built from another deskcap.c: build it again" >&2; exit 1; }
    [ "$(awk '$1 == "so-sha256" {print $2}' "$build")" = "$(sha256sum "$so" | cut -d' ' -f1)" ] \
      || { echo "$so isn't the one its BUILD names" >&2; exit 1; }
    file -b "$so" | grep -q "${arch#*:}" || { echo "$so isn't ${arch%%:*}" >&2; exit 1; }
  done
fi
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp -a "$SRC/." "$stage/"
printf '%s\n' "$VERSION" > "$stage/VERSION"
mkdir -p "$HERE/dist"
artifact=desk-stream-$VERSION.tgz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - . | gzip -n > "$HERE/dist/$artifact"
(cd "$HERE/dist" && sha256sum "$artifact" > "$artifact.sha256")
echo "artifact: $HERE/dist/$artifact"
cat "$HERE/dist/$artifact.sha256"
