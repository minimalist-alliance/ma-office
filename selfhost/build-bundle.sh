#!/usr/bin/env bash
# build-bundle.sh: the amd64 release artifacts a self-hosted desk installs (selfhost/README.md).
#
# Cloud desks are arm64, and their releases are built on the arm64 test box. A self-hosted desk runs the same five
# components, built from the same commits for amd64, with nothing patched:
#   desk-rtc       the version below    from desk-rtc/ at the commit its arm64 release was built from. Its run and
#                                       health are the release's own: they read the port from /etc/ma/desk-rtc.conf,
#                                       which install.sh writes (port=4443; no file is 443, as on a cloud desk).
#   deskd          the version below    from services/ at its commit. With desk-notebook in the bundle, its run must
#                                       mount /run/desk-notebook (checked below), so the two pins move together.
#   desk-stream    0.2.4                from image/recipe/desk-stream/ at b41eb10 (Python and confs, no arch)
#   desk-notebook  the version below    from services/notebook/ and web/notebook/src/model/ at its commit, as
#                                       services/scripts/build-image.sh builds it (Node with no native code, so the
#                                       same Dockerfile builds for amd64). Until it's pinned this script stops, as it
#                                       does for an unpinned desk-rtc.
#   desk-agent-filter the version below from image/recipe/desk-agent-filter/, the same source as a cloud desk's (ADR 0070)
# Pins can be overridden for a trial build, e.g. DESK_RTC_VERSION=0.3.2-35dev DESK_RTC_COMMIT=<commit>, never for a
# bundle members get: that one names released versions only.
#
# The Go build and the deskd image build run on an amd64 Docker host, never here: point DOCKER_HOST at it, for
# example the build server (DOCKER_HOST=ssh://<user>@<build server>). Its address isn't written here on purpose.
#
#   DOCKER_HOST=ssh://... selfhost/build-bundle.sh [outdir]      default outdir: ../build/dist beside this clone
#
# Writes, in outdir:
#   desk-rtc-<version>-amd64.tgz, deskd-<version>-amd64.tgz, desk-stream-0.2.4.tgz, desk-notebook-<version>-amd64.tgz,
#   desk-agent-filter-<version>-amd64.tgz, each with its .sha256
#   bundle.pin   one line each: component version sha256 (the format of image/recipe/releases.pin)
# Each artifact has the layout ma-update installs (docs/interfaces/desk-runtime.md section 6), the same as the arm64
# release of that version. On the Docker host it leaves nothing behind: its containers and images are removed on exit.
set -euo pipefail
umask 022

# desk-rtc 0.3.5: the first release with the port as a setting (task 35), published from main 67d1225.
DESK_RTC_VERSION=${DESK_RTC_VERSION:-0.3.5};  DESK_RTC_COMMIT=${DESK_RTC_COMMIT:-67d1225}
# deskd 2026.11.07-0e1fb6c, published from main 0e1fb6c and passed on the test desk: its run mounts /run/desk-notebook,
# and it writes the age band the teen lock reads.
DESKD_VERSION=${DESKD_VERSION:-2026.11.07-0e1fb6c};  DESKD_COMMIT=${DESKD_COMMIT:-0e1fb6c}
DESK_STREAM_VERSION=0.2.4;           DESK_STREAM_COMMIT=b41eb10
# The published arm64 desk-stream 0.2.4 (task 29, as image/recipe/releases.pin). It has no arch, so this build must come out byte for byte the same.
DESK_STREAM_SHA=58d84ce37fd2f7748ed5f76b0c9c5ad1d467ef2ad9596ab80a1603ff20d81406
# desk-agent-filter: the version in image/recipe/releases.pin, from the commit of its source.
DESK_AGENT_FILTER_VERSION=0.1.1;     DESK_AGENT_FILTER_COMMIT=b1bb36a
GO_IMAGE=${GO_IMAGE:-golang:1.25-bookworm}   # desk-rtc/go.mod says go 1.25
# desk-notebook 2026.11.07-0e1fb6c, its first release, published from main 0e1fb6c and passed on the test desk.
DESK_NOTEBOOK_VERSION=${DESK_NOTEBOOK_VERSION:-2026.11.07-0e1fb6c};  DESK_NOTEBOOK_COMMIT=${DESK_NOTEBOOK_COMMIT:-0e1fb6c}
TAG=ma-sub-selfhost   # containers on the Docker host, removed on exit

die() { echo "build-bundle: $*" >&2; exit 1; }
log() { echo "build-bundle: $*"; }

[ -n "$DESK_RTC_VERSION" ] && [ -n "$DESK_RTC_COMMIT" ] || die "no desk-rtc pinned yet: set DESK_RTC_VERSION and DESK_RTC_COMMIT"
case $DESK_RTC_VERSION in *-sh[0-9]*) die "desk-rtc $DESK_RTC_VERSION is a patched self-hosted build; bundles carry released versions only" ;; esac
# A bundle without desk-notebook would leave a self-hosted desk with no Notebook, so there's no building one: the same
# rule as an unpinned desk-rtc.
[ -n "$DESK_NOTEBOOK_VERSION" ] && [ -n "$DESK_NOTEBOOK_COMMIT" ] \
  || die "no desk-notebook pinned yet: set DESK_NOTEBOOK_VERSION and DESK_NOTEBOOK_COMMIT, with a deskd whose run mounts /run/desk-notebook"
# The version rule install.sh reads bundle.pin with.
for v in "$DESK_RTC_VERSION" "$DESKD_VERSION" "$DESK_STREAM_VERSION" "$DESK_NOTEBOOK_VERSION"; do
  [[ $v =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad version: $v"
done
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
OUT=${1:-$REPO/../build/dist}
for c in "$DESK_RTC_COMMIT" "$DESKD_COMMIT" "$DESK_STREAM_COMMIT" "$DESK_NOTEBOOK_COMMIT" "$DESK_AGENT_FILTER_COMMIT"; do
  git -C "$REPO" cat-file -e "$c^{commit}" 2>/dev/null || die "commit $c isn't in $REPO (fetch it)"
done
# Before any build: the pair has to fit. deskd reaches desk-notebook only through /run/desk-notebook, which its run
# mounts from the release that relays to it. desk-notebook's run must keep --network none and uid 1105: a self-hosted
# desk's firewall, like a cloud desk's, has no rule for uid 1105 because that container has no network at all.
deskd_run=$(git -C "$REPO" show "$DESKD_COMMIT:services/deskd/docker/run") || die "no services/deskd/docker/run at $DESKD_COMMIT"
grep -q -- '-v /run/desk-notebook:/run/desk-notebook' <<<"$deskd_run" \
  || die "deskd at $DESKD_COMMIT doesn't mount /run/desk-notebook, so it can't reach desk-notebook; pin a deskd whose run does"
nb_run=$(git -C "$REPO" show "$DESK_NOTEBOOK_COMMIT:services/notebook/docker/run") || die "no services/notebook/docker/run at $DESK_NOTEBOOK_COMMIT"
for want in '--network none' '--user 1105:1105' '-v /run/desk-notebook:/run/desk-notebook' '-v /data/notebook:/data/notebook'; do
  grep -q -- "$want" <<<"$nb_run" || die "desk-notebook's run at $DESK_NOTEBOOK_COMMIT has no '$want'; a self-hosted desk relies on it"
done
DOCKER=${DOCKER:-docker}
command -v "$DOCKER" >/dev/null || [ -x "$DOCKER" ] || die "no docker client ($DOCKER); set DOCKER"
[ -n "${DOCKER_HOST:-}" ] || die "set DOCKER_HOST to an amd64 Docker host (the build server), never this machine"
arch=$("$DOCKER" info --format '{{.Architecture}}') || die "can't reach the Docker host"
case $arch in x86_64 | amd64) ;; *) die "the Docker host is $arch, not amd64" ;; esac

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
work=$(mktemp -d)
rtc_ctr=$TAG-rtc-build-$$
filter_ctr=$TAG-filter-build-$$
deskd_img=ma-sub/selfhost-deskd:$DESKD_VERSION
save_tag=ma/deskd:$DESKD_VERSION
nb_img=ma-sub/selfhost-desk-notebook:$DESK_NOTEBOOK_VERSION
nb_save_tag=ma/desk-notebook:$DESK_NOTEBOOK_VERSION
cleanup() {
  "$DOCKER" rm -f "$rtc_ctr" >/dev/null 2>&1 || true
  "$DOCKER" rm -f "$filter_ctr" >/dev/null 2>&1 || true
  # The ma/deskd and ma/desk-notebook tags exist only for docker save, so the desk loads each image under the name
  # ma-update and run expect.
  "$DOCKER" image rm "$save_tag" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$deskd_img" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$nb_save_tag" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$nb_img" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

export_tree() { # commit path dest: the tree at that commit, nothing from the working copy
  mkdir -p "$3"
  git -C "$REPO" archive --format=tar "$1" "$2" | tar -x -C "$3"
}

sha_line() { (cd "$OUT" && sha256sum "$1" > "$1.sha256" && cut -d' ' -f1 "$1.sha256"); }

# ---------- desk-rtc ----------
log "desk-rtc $DESK_RTC_VERSION from $DESK_RTC_COMMIT, amd64, in $GO_IMAGE"
export_tree "$DESK_RTC_COMMIT" desk-rtc "$work/src"
# The flags of desk-rtc/build.sh, for one arch and the one command that ships.
"$DOCKER" create --name "$rtc_ctr" --cpus=6 --memory=5g -w /src/desk-rtc \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 -e "GOFLAGS=-p=4 -trimpath -buildvcs=false" \
  "$GO_IMAGE" go build -ldflags "-s -w -X main.version=$DESK_RTC_VERSION" -o /src/desk-rtc/desk-rtc.bin ./cmd/desk-rtc >/dev/null
"$DOCKER" cp "$work/src/." "$rtc_ctr:/src"
"$DOCKER" start -a "$rtc_ctr"
"$DOCKER" cp "$rtc_ctr:/src/desk-rtc/desk-rtc.bin" "$work/desk-rtc.bin"
"$DOCKER" rm -f "$rtc_ctr" >/dev/null
file "$work/desk-rtc.bin" | grep -q 'ELF 64-bit LSB executable, x86-64.*statically linked' || die "desk-rtc isn't a static x86-64 binary: $(file -b "$work/desk-rtc.bin")"
stage=$work/rtc-stage; mkdir -p "$stage"
install -m 0755 "$work/desk-rtc.bin" "$stage/desk-rtc"
install -m 0755 "$work/src/desk-rtc/release/run" "$stage/run"
install -m 0755 "$work/src/desk-rtc/release/health" "$stage/health"
# The release's own run and health, as build.sh packs them. A self-hosted desk needs one that takes its port from the
# desk's config (README.md, "The port"): Chrome refuses a home-network ICE candidate on a port below 1024.
grep -q -- '--config "${DESK_RTC_CONF:-/etc/ma/desk-rtc.conf}"' "$stage/run" && grep -q -- '--print-port' "$stage/health" \
  || die "desk-rtc at $DESK_RTC_COMMIT doesn't take its port from the desk's config; a self-hosted desk needs one that does"
printf '%s\n' "$DESK_RTC_VERSION" > "$stage/VERSION"; chmod 0644 "$stage/VERSION"
rtc_art=desk-rtc-$DESK_RTC_VERSION-amd64.tgz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - VERSION run health desk-rtc | gzip -n > "$OUT/$rtc_art"
rtc_sha=$(sha_line "$rtc_art")

# ---------- desk-agent-filter ----------
log "desk-agent-filter $DESK_AGENT_FILTER_VERSION from $DESK_AGENT_FILTER_COMMIT, amd64, in $GO_IMAGE"
export_tree "$DESK_AGENT_FILTER_COMMIT" image/recipe/desk-agent-filter "$work/f"
# The flags of image/package-desk-agent-filter.sh. Its tests go first, as they do there.
"$DOCKER" create --name "$filter_ctr" --cpus=6 --memory=5g -w /src/image/recipe/desk-agent-filter \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 -e "GOFLAGS=-p=4 -trimpath -buildvcs=false" \
  "$GO_IMAGE" sh -c 'go test -count=1 ./... && go build -ldflags "-s -w -buildid=" -o desk-agent-filter.bin .' >/dev/null
"$DOCKER" cp "$work/f/." "$filter_ctr:/src"
"$DOCKER" start -a "$filter_ctr"
"$DOCKER" cp "$filter_ctr:/src/image/recipe/desk-agent-filter/desk-agent-filter.bin" "$work/desk-agent-filter.bin"
"$DOCKER" rm -f "$filter_ctr" >/dev/null
file "$work/desk-agent-filter.bin" | grep -q 'ELF 64-bit LSB executable, x86-64.*statically linked' || die "desk-agent-filter isn't a static x86-64 binary: $(file -b "$work/desk-agent-filter.bin")"
stage=$work/filter-stage; mkdir -p "$stage"
install -m 0755 "$work/desk-agent-filter.bin" "$stage/desk-agent-filter"
install -m 0755 "$work/f/image/recipe/desk-agent-filter/run" "$work/f/image/recipe/desk-agent-filter/health" "$stage/"
printf '%s\n' "$DESK_AGENT_FILTER_VERSION" > "$stage/VERSION"; chmod 0644 "$stage/VERSION"
filter_art=desk-agent-filter-$DESK_AGENT_FILTER_VERSION-amd64.tgz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - VERSION run health desk-agent-filter | gzip -n > "$OUT/$filter_art"
filter_sha=$(sha_line "$filter_art")

# ---------- deskd ----------
log "deskd $DESKD_VERSION from $DESKD_COMMIT, amd64 image on the Docker host"
export_tree "$DESKD_COMMIT" services "$work/d"
"$DOCKER" image inspect "$save_tag" >/dev/null 2>&1 && die "the Docker host already has $save_tag; it isn't ours, so stop"
# The legacy builder takes the caps; the Dockerfile uses no BuildKit-only syntax. Host networking as build-image.sh does.
DOCKER_BUILDKIT=0 "$DOCKER" build --network host --cpu-period=100000 --cpu-quota=600000 --memory=5g \
  --file "$work/d/services/deskd/Dockerfile" --build-arg "VERSION=$DESKD_VERSION" --tag "$deskd_img" "$work/d/services"
img_arch=$("$DOCKER" image inspect --format '{{.Architecture}}' "$deskd_img")
[ "$img_arch" = amd64 ] || die "deskd's image is $img_arch, not amd64"
"$DOCKER" tag "$deskd_img" "$save_tag"
stage=$work/deskd-stage; mkdir -p "$stage"
printf '%s\n' "$DESKD_VERSION" > "$stage/VERSION"
install -m 0755 "$work/d/services/deskd/docker/run" "$work/d/services/deskd/docker/health" "$stage/"
install -m 0644 "$work/d/services/deskd/docker/deskd.env" "$stage/"
"$DOCKER" save -o "$stage/image.tar" "$save_tag"
[ -s "$stage/image.tar" ] || die "docker save wrote nothing"
chmod 0644 "$stage/image.tar"
manifest=$(tar -xOf "$stage/image.tar" manifest.json); grep -q "\"$save_tag\"" <<<"$manifest" || die "image.tar's manifest doesn't name $save_tag"
"$DOCKER" image rm "$save_tag" "$deskd_img" >/dev/null
deskd_art=deskd-$DESKD_VERSION-amd64.tgz
# The layout of services/scripts/package-release.sh.
tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$OUT/$deskd_art" VERSION run health deskd.env image.tar
deskd_sha=$(sha_line "$deskd_art")

# ---------- desk-notebook ----------
log "desk-notebook $DESK_NOTEBOOK_VERSION from $DESK_NOTEBOOK_COMMIT, amd64 image on the Docker host"
# services/scripts/build-image.sh notebook's context: services/notebook and web/notebook/src/model from the repo's root,
# as the service bundles the Notebook's model as source. Its Dockerfile pins node:24-bookworm-slim by its multi-arch
# digest, so an amd64 host builds the amd64 image from the same lines.
export_tree "$DESK_NOTEBOOK_COMMIT" services/notebook "$work/n"
export_tree "$DESK_NOTEBOOK_COMMIT" web/notebook/src/model "$work/n"
"$DOCKER" image inspect "$nb_save_tag" >/dev/null 2>&1 && die "the Docker host already has $nb_save_tag; it isn't ours, so stop"
# As deskd's: the legacy builder with the caps (the Dockerfile has no BuildKit-only syntax), host networking for npm ci.
DOCKER_BUILDKIT=0 "$DOCKER" build --network host --cpu-period=100000 --cpu-quota=600000 --memory=5g \
  --file "$work/n/services/notebook/Dockerfile" --build-arg "VERSION=$DESK_NOTEBOOK_VERSION" --tag "$nb_img" "$work/n"
img_arch=$("$DOCKER" image inspect --format '{{.Architecture}}' "$nb_img")
[ "$img_arch" = amd64 ] || die "desk-notebook's image is $img_arch, not amd64"
"$DOCKER" tag "$nb_img" "$nb_save_tag"
stage=$work/nb-stage; mkdir -p "$stage"
printf '%s\n' "$DESK_NOTEBOOK_VERSION" > "$stage/VERSION"
install -m 0755 "$work/n/services/notebook/docker/run" "$work/n/services/notebook/docker/health" "$stage/"
install -m 0644 "$work/n/services/notebook/docker/desk-notebook.env" "$stage/"
"$DOCKER" save -o "$stage/image.tar" "$nb_save_tag"
[ -s "$stage/image.tar" ] || die "docker save wrote nothing"
chmod 0644 "$stage/image.tar"
manifest=$(tar -xOf "$stage/image.tar" manifest.json); grep -q "\"$nb_save_tag\"" <<<"$manifest" || die "image.tar's manifest doesn't name $nb_save_tag"
"$DOCKER" image rm "$nb_save_tag" "$nb_img" >/dev/null
nb_art=desk-notebook-$DESK_NOTEBOOK_VERSION-amd64.tgz
# The layout of services/scripts/package-release.sh notebook.
tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$OUT/$nb_art" VERSION run health desk-notebook.env image.tar
nb_sha=$(sha_line "$nb_art")

# ---------- desk-stream ----------
log "desk-stream $DESK_STREAM_VERSION from $DESK_STREAM_COMMIT (no arch)"
# As image/package-desk-stream.sh packs it, from a checkout made under umask 002: the published artifact's files are
# group-writable (0664 and 0775, which ma-update clears with chmod -R go-w), so the same umask gives the same bytes.
stream_art=desk-stream-$DESK_STREAM_VERSION.tgz
(
  umask 002
  export_tree "$DESK_STREAM_COMMIT" image/recipe/desk-stream "$work/s"
  stage=$work/stream-stage; mkdir -p "$stage"; chmod 0775 "$stage"
  cp -a "$work/s/image/recipe/desk-stream/." "$stage/"
  printf '%s\n' "$DESK_STREAM_VERSION" > "$stage/VERSION"
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - . | gzip -n > "$OUT/$stream_art"
)
stream_sha=$(sha_line "$stream_art")
[ "$stream_sha" = "$DESK_STREAM_SHA" ] || die "desk-stream $DESK_STREAM_VERSION came out as $stream_sha, not the published $DESK_STREAM_SHA"
log "desk-stream matches the published $DESK_STREAM_VERSION byte for byte"

# ---------- pin ----------
{
  echo "# amd64 releases for a self-hosted desk, from selfhost/build-bundle.sh. component version sha256, as releases.pin."
  printf '%-14s %-20s %s\n' desk-rtc "$DESK_RTC_VERSION" "$rtc_sha"
  printf '%-14s %-20s %s\n' desk-stream "$DESK_STREAM_VERSION" "$stream_sha"
  printf '%-14s %-20s %s\n' deskd "$DESKD_VERSION" "$deskd_sha"
  printf '%-14s %-20s %s\n' desk-notebook "$DESK_NOTEBOOK_VERSION" "$nb_sha"
  printf '%-14s %-20s %s\n' desk-agent-filter "$DESK_AGENT_FILTER_VERSION" "$filter_sha"
} > "$OUT/bundle.pin"
log "done, in $OUT:"
(cd "$OUT" && ls -l "$rtc_art" "$deskd_art" "$nb_art" "$stream_art" "$filter_art" | awk '{print "  " $5 "  " $9}')
cat "$OUT/bundle.pin"
