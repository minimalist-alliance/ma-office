#!/usr/bin/env bash
# build-bundle.sh: the amd64 release artifacts a self-hosted desk installs (selfhost/README.md).
#
# Cloud desks are arm64, and their releases are built on the arm64 test box. A self-hosted desk runs the same six
# components, built from the same commits for amd64, with nothing patched:
#   desk-rtc       the version below    from desk-rtc/ at the commit its arm64 release was built from. Its run and
#                                       health are the release's own: they read the port from /etc/ma/desk-rtc.conf,
#                                       which install.sh writes (port=4443; no file is 443, as on a cloud desk).
#   deskd          the version below    from services/ at its commit. With desk-notebook in the bundle, its run must
#                                       mount /run/desk-notebook (checked below), so the two pins move together.
#   desk-agent     the version below    from services/ at its commit, as deskd (ADR 0040's Java service; its SQLite
#                                       library is taken for the build machine's arch, so amd64 here).
#   desk-stream    the version below    from image/recipe/desk-stream/ at its commit (Python, confs, and deskcap for both
#                                       arches, which run picks by machine), byte for byte the published artifact
#   desk-notebook  the version below    from services/notebook/ and web/notebook/src/model/ at its commit, as
#                                       services/scripts/build-image.sh builds it (Node with no native code, so the
#                                       same Dockerfile builds for amd64). Until it's pinned this script stops, as it
#                                       does for an unpinned desk-rtc.
#   desk-agent-filter the version below from image/recipe/desk-agent-filter/, the same source as a cloud desk's (ADR 0070)
# Not here: commons-server, which runs only on a Guild Desk (image/README.md, "Guild Desk"); a self-hosted desk is a
# member's own.
# Pins can be overridden for a trial build, e.g. DESK_RTC_VERSION=0.3.2-35dev DESK_RTC_COMMIT=<commit>, never for a
# bundle members get: that one names released versions only.
#
# The Go build and the deskd image build run on an amd64 Docker host, never here: point DOCKER_HOST at it, for
# example the build server (DOCKER_HOST=ssh://<user>@<build server>). Its address isn't written here on purpose.
#
#   DOCKER_HOST=ssh://... selfhost/build-bundle.sh [outdir]      default outdir: ../build/dist beside this clone
#   selfhost/build-bundle.sh --sign <outdir>     sign a bundle built here with alias/ma-selfhost-release (below)
#
# Writes, in outdir:
#   desk-rtc-<version>-amd64.tgz, deskd-<version>-amd64.tgz, desk-agent-<version>-amd64.tgz, desk-stream-<version>.tgz,
#   desk-notebook-<version>-amd64.tgz, desk-agent-filter-<version>-amd64.tgz, each with its .sha256
#   bundle.pin   "# ma-selfhost-bundle/1" (install.sh takes nothing else), a header line "# bundle <commit>" naming the
#                commit of this clone, which install.sh puts in /etc/ma-release, then one line each: component version
#                sha256 (the format of image/recipe/releases.pin), and "installer <commit> <sha256 of installer.sha256>",
#                and "batch-baseline <seq> <sha256>" with a baseline
#   installer.sha256  sha256sum's format: every file of selfhost/ (less e2e/, lab/ and tests/) and image/recipe/ at that
#                commit, as git has them. install.sh refuses a folder whose files differ, or that has any other file in
#                selfhost/files/ or image/recipe/
#   batch-baseline  only with BATCH_BASELINE=<seq>: {"seq": <seq>}, the newest desk batch whose amd64 releases this bundle
#                already holds. install.sh puts it in /opt/ma/etc/batch-baseline, so desk-batch refuses older batches
#   bundle.pin.sig  with BUNDLE_KMS_KEY_ID set for the build, or later with --sign: the signature install.sh requires (EXP-10)
#
# Signing (EXP-10, README.md "A signed bundle"). install.sh installs only a bundle whose bundle.pin is signed by the
# self-hosted release key: on a first install the key in the installer's selfhost/files/opt/ma/etc/selfhost-release-keys/
# (which must be exactly what selfhost/release-keys.sha256 names), on an update the one the desk already holds, which must
# be the same. That key is KMS alias/ma-selfhost-release (BUNDLE_KMS_KEY_ID, the default), the channel's own: never the
# update batches' alias/ma-desk-batch, whose public half in image/recipe/.../batch-keys/ no longer vouches for a bundle.
# ECDSA P-256 SHA-256 over the file's exact bytes, DER, MessageType RAW, at most 4096 bytes, from the credentials the key
# policy allows kms:Sign. pin-release-key.sh pins the key's public half and its anchor. --sign refuses a bundle from a
# clone with changes ("-dirty"), one whose commit's installer has no release key matching its anchor, one whose
# installer.sha256 isn't its commit's, one whose files don't match bundle.pin, one naming a release with no
# passed-test.json (only desk-agent-filter, which isn't published, is built from its pinned source), and the batch key. It
# checks the signature with the installer's own check before it keeps it. A signature is the go-ahead for every member
# who gets the bundle: sign only what you'll prove on a test machine next, and publish only what passed there.
# Each artifact has the layout ma-update installs (docs/interfaces/desk-runtime.md section 6), the same as the arm64
# release of that version. On the Docker host it leaves nothing behind: its containers and images are removed on exit.
set -euo pipefail
umask 022

# The set image 0.3.5 bakes (image/recipe/releases.pin), less commons-server. Each version is the one published and passed
# on the test desk; each commit is the one its arm64 release was built from.
# desk-rtc 0.5.1: published at 03:35 MT Nov 11 from c7ad6af (S-29), the commit before it. Later commits change only deskctl
# and the README, which the release doesn't carry. On a self-hosted desk it reads no allowance profile (no desk-egress, so
# no /run/desk-egress/profile), and the shared-host settings come only from a host's slot.
DESK_RTC_VERSION=${DESK_RTC_VERSION:-0.5.1};  DESK_RTC_COMMIT=${DESK_RTC_COMMIT:-c7ad6af}
# deskd 2026.11.11-90528b5: its run mounts /run/desk-notebook, it writes the age band the teen lock reads, and it writes
# /run/desk/idle.json, which desk-batch reads (docs/interfaces/desk-runtime.md section 6.1).
DESKD_VERSION=${DESKD_VERSION:-2026.11.11-90528b5};  DESKD_COMMIT=${DESKD_COMMIT:-90528b5}
# desk-agent 2026.11.11-90528b5: the Agent, which deskd relays to.
DESK_AGENT_VERSION=${DESK_AGENT_VERSION:-2026.11.11-90528b5};  DESK_AGENT_COMMIT=${DESK_AGENT_COMMIT:-90528b5}
# desk-stream 0.3.5, published from 8e6aca1 at 03:57 MT Nov 11 (the image's pin). It has no arch (deskcap for both is
# committed), so this must come out byte for byte the published one. It's packed from a checkout made under umask 022
# (0.2.4 was under 002), so that's pinned too.
DESK_STREAM_VERSION=0.3.5;           DESK_STREAM_COMMIT=8e6aca1;   DESK_STREAM_UMASK=022
DESK_STREAM_SHA=88f54a854e5f5f482731b0ae90a38f3c82c1cccfbf69d01db965a13ec10d78c7
# desk-agent-filter: the version in image/recipe/releases.pin. Its source is b1bb36a's; d92410a changed only two tests (two
# races that failed a test bake), so the binary is the same and its tests are the ones the image's bake runs.
DESK_AGENT_FILTER_VERSION=0.1.1;     DESK_AGENT_FILTER_COMMIT=d92410a
GO_IMAGE=${GO_IMAGE:-golang:1.25-bookworm}   # desk-rtc/go.mod says go 1.25
# desk-notebook 2026.11.11-90528b5, published from 90528b5 and passed on the test desk.
DESK_NOTEBOOK_VERSION=${DESK_NOTEBOOK_VERSION:-2026.11.11-90528b5};  DESK_NOTEBOOK_COMMIT=${DESK_NOTEBOOK_COMMIT:-90528b5}
# Optional: the newest desk batch (its seq) whose amd64 releases are exactly these. Empty writes no batch-baseline.
BATCH_BASELINE=${BATCH_BASELINE:-}
TAG=ma-sub-selfhost   # containers on the Docker host, removed on exit

die() { echo "build-bundle: $*" >&2; exit 1; }
log() { echo "build-bundle: $*"; }
MAGIC='# ma-selfhost-bundle/1'
RELEASE_BUCKET=${RELEASE_BUCKET:-}   # where the pass records are; with none, the account's release bucket (read at --sign)
# The key bundles are signed with: the self-hosted release key, never the batch key. Set for a build, it also signs at its end.
SIGN_AT_END=${BUNDLE_KMS_KEY_ID:+1}
BUNDLE_KMS_KEY_ID=${BUNDLE_KMS_KEY_ID:-alias/ma-selfhost-release}
KEYS_DIR=selfhost/files/opt/ma/etc/selfhost-release-keys   # the key's public half in the installer; its anchor: selfhost/release-keys.sha256
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

# installer_manifest <commit>: installer.sha256 for that commit's installer, from git's own tree, never the working copy.
installer_manifest() {
  local t; t=$(mktemp -d)
  git -C "$REPO" archive --format=tar "$1" selfhost image/recipe | tar -x -C "$t"
  [ -z "$(find "$t" -type l -print -quit)" ] || { rm -rf "$t"; die "the installer at $1 has a symlink, which installer.sha256 can't name"; }
  (cd "$t" && find selfhost image/recipe -type f ! -path 'selfhost/e2e/*' ! -path 'selfhost/lab/*' ! -path 'selfhost/tests/*' -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum)
  rm -rf "$t"
}

# sign_bundle <dir>: bundle.pin.sig, with KMS BUNDLE_KMS_KEY_ID, after every check above.
sign_bundle() {
  local d=$1 t commit c v sha
  [ "$BUNDLE_KMS_KEY_ID" != alias/ma-desk-batch ] || die "alias/ma-desk-batch signs update batches only; bundles are signed with the self-hosted release key (alias/ma-selfhost-release)"
  [ -n "$RELEASE_BUCKET" ] || RELEASE_BUCKET=ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text) \
    || die "can't read the account, to find the release bucket; set RELEASE_BUCKET"
  [ -f "$d/bundle.pin" ] || die "no $d/bundle.pin"
  [ "$(head -1 "$d/bundle.pin")" = "$MAGIC" ] || die "$d/bundle.pin isn't this script's"
  [ "$(stat -c %s "$d/bundle.pin")" -le 4096 ] || die "bundle.pin is over 4096 bytes, KMS's limit for a RAW message"
  commit=$(sed -n 's/^# bundle \([0-9a-f]\{7,40\}\)$/\1/p' "$d/bundle.pin")
  [ -n "$commit" ] || die "bundle.pin names no clean commit: a bundle from a clone with changes is never signed"
  t=$(mktemp -d)
  # That commit's installer, as install.sh will check it: first its release key against its anchor (pin-release-key.sh).
  mkdir "$t/folder" && git -C "$REPO" archive --format=tar "$commit" selfhost image/recipe | tar -x -C "$t/folder"
  python3 -I "$t/folder/selfhost/files/usr/local/lib/ma/selfhost/ma-selfhost-bundle" keys "$t/folder" \
    || { rm -rf "$t"; die "$commit's installer has no release key that matches its anchor ($KEYS_DIR/, selfhost/release-keys.sha256): pin it with selfhost/pin-release-key.sh and commit"; }
  installer_manifest "$commit" > "$t/installer.sha256"
  cmp -s "$t/installer.sha256" "$d/installer.sha256" || { rm -rf "$t"; die "installer.sha256 isn't $commit's installer"; }
  while read -r c v sha; do
    case "$c" in ''|'#'*) continue ;; esac
    [ "$c" != installer ] || { [ "$sha" = "$(sha256sum < "$d/installer.sha256" | cut -c1-64)" ] || die "installer.sha256 isn't the one bundle.pin names"; continue; }
    [ "$c" != batch-baseline ] || { [ "$sha" = "$(sha256sum < "$d/batch-baseline" | cut -c1-64)" ] || die "batch-baseline isn't the one bundle.pin names"; continue; }
    f=$(ls "$d/$c-$v-amd64.tgz" "$d/$c-$v.tgz" 2>/dev/null | head -1 || true)
    [ -n "$f" ] && [ "$(sha256sum < "$f" | cut -c1-64)" = "$sha" ] || die "$c $v: the bundle's file isn't the one bundle.pin names"
    if [ "$c" != desk-agent-filter ]; then
      aws s3api head-object --bucket "$RELEASE_BUCKET" --key "desk/$c/$v/passed-test.json" >/dev/null 2>&1 \
        || die "$c $v has no passed-test.json: a bundle carries released versions that passed on the test desk only"
    fi
  done < "$d/bundle.pin"
  aws kms sign --key-id "$BUNDLE_KMS_KEY_ID" --message "fileb://$d/bundle.pin" --message-type RAW --signing-algorithm ECDSA_SHA_256 \
    --query Signature --output text | base64 -d > "$t/sig" || { rm -rf "$t"; die "KMS didn't sign"; }
  # Checked as install.sh checks a first install: the release key in this commit's installer, and every file of it.
  install -m 0644 "$t/sig" "$d/bundle.pin.sig"
  if ! python3 -I "$t/folder/selfhost/files/usr/local/lib/ma/selfhost/ma-selfhost-bundle" verify "$t/folder" --bundle "$d"; then
    rm -f "$d/bundle.pin.sig" "$t/sig"; rm -rf "$t"; die "the signature doesn't pass the installer's own check (is $BUNDLE_KMS_KEY_ID the key in $KEYS_DIR/?)"
  fi
  rm -rf "$t"
  log "signed: $d/bundle.pin.sig ($(stat -c %s "$d/bundle.pin.sig") bytes, DER), checked with the installer's own check"
}

if [ "${1:-}" = --sign ]; then
  [ $# = 2 ] || die "usage: [BUNDLE_KMS_KEY_ID=alias/ma-selfhost-release] build-bundle.sh --sign <outdir>"
  sign_bundle "$(cd "$2" && pwd)"
  exit 0
fi

[ -n "$DESK_RTC_VERSION" ] && [ -n "$DESK_RTC_COMMIT" ] || die "no desk-rtc pinned yet: set DESK_RTC_VERSION and DESK_RTC_COMMIT"
case $DESK_RTC_VERSION in *-sh[0-9]*) die "desk-rtc $DESK_RTC_VERSION is a patched self-hosted build; bundles carry released versions only" ;; esac
# A bundle without desk-notebook would leave a self-hosted desk with no Notebook, so there's no building one: the same
# rule as an unpinned desk-rtc.
[ -n "$DESK_NOTEBOOK_VERSION" ] && [ -n "$DESK_NOTEBOOK_COMMIT" ] \
  || die "no desk-notebook pinned yet: set DESK_NOTEBOOK_VERSION and DESK_NOTEBOOK_COMMIT, with a deskd whose run mounts /run/desk-notebook"
# The version rule install.sh reads bundle.pin with.
for v in "$DESK_RTC_VERSION" "$DESKD_VERSION" "$DESK_AGENT_VERSION" "$DESK_STREAM_VERSION" "$DESK_NOTEBOOK_VERSION"; do
  [[ $v =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad version: $v"
done
[ -z "$BATCH_BASELINE" ] || [[ $BATCH_BASELINE =~ ^[1-9][0-9]{0,15}$ ]] || die "BATCH_BASELINE must be a whole number from 1"
OUT=${1:-$REPO/../build/dist}
for c in "$DESK_RTC_COMMIT" "$DESKD_COMMIT" "$DESK_AGENT_COMMIT" "$DESK_STREAM_COMMIT" "$DESK_NOTEBOOK_COMMIT" "$DESK_AGENT_FILTER_COMMIT"; do
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
# desk-agent's run must keep uid 1103 and the host network: the firewall's agent_redirect keys on uid 1103 (ADR 0070).
agent_run=$(git -C "$REPO" show "$DESK_AGENT_COMMIT:services/desk-agent/docker/run") || die "no services/desk-agent/docker/run at $DESK_AGENT_COMMIT"
for want in '--network host' '--user 1103:1103' '-v /run/desk-agent:/run/desk-agent' '-v /data/agent:/data/agent'; do
  grep -q -- "$want" <<<"$agent_run" || die "desk-agent's run at $DESK_AGENT_COMMIT has no '$want'; a self-hosted desk relies on it"
done
# The installer and bundle this names: the clone's commit, "-dirty" when it has changes (as bake.sh marks an image).
BUNDLE_COMMIT=$(git -C "$REPO" rev-parse --short=7 HEAD)
[ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] || BUNDLE_COMMIT=$BUNDLE_COMMIT-dirty
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
agent_img=ma-sub/selfhost-desk-agent:$DESK_AGENT_VERSION
agent_save_tag=ma/desk-agent:$DESK_AGENT_VERSION
nb_save_tag=ma/desk-notebook:$DESK_NOTEBOOK_VERSION
cleanup() {
  "$DOCKER" rm -f "$rtc_ctr" >/dev/null 2>&1 || true
  "$DOCKER" rm -f "$filter_ctr" >/dev/null 2>&1 || true
  # The ma/deskd, ma/desk-agent and ma/desk-notebook tags exist only for docker save, so the desk loads each image under the name
  # ma-update and run expect.
  "$DOCKER" image rm "$save_tag" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$deskd_img" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$nb_save_tag" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$nb_img" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$agent_save_tag" >/dev/null 2>&1 || true
  "$DOCKER" image rm "$agent_img" >/dev/null 2>&1 || true
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
# The flags of image/package-desk-agent-filter.sh. Its tests go first, as they do there. In the host's network namespace,
# as there: one test reads /proc/sys/net/core/rmem_max, which a container's own namespace doesn't have.
"$DOCKER" create --name "$filter_ctr" --network host --cpus=6 --memory=5g -w /src/image/recipe/desk-agent-filter \
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

# ---------- desk-agent ----------
log "desk-agent $DESK_AGENT_VERSION from $DESK_AGENT_COMMIT, amd64 image on the Docker host"
# As deskd: services/ at its commit is the context (services/scripts/build-image.sh desk-agent), the legacy builder with
# the caps and host networking. The Dockerfile takes SQLite's native library for $(uname -m) of the build, so x86_64 here.
export_tree "$DESK_AGENT_COMMIT" services "$work/a"
"$DOCKER" image inspect "$agent_save_tag" >/dev/null 2>&1 && die "the Docker host already has $agent_save_tag; it isn't ours, so stop"
DOCKER_BUILDKIT=0 "$DOCKER" build --network host --cpu-period=100000 --cpu-quota=600000 --memory=5g \
  --file "$work/a/services/desk-agent/Dockerfile" --build-arg "VERSION=$DESK_AGENT_VERSION" --tag "$agent_img" "$work/a/services"
img_arch=$("$DOCKER" image inspect --format '{{.Architecture}}' "$agent_img")
[ "$img_arch" = amd64 ] || die "desk-agent's image is $img_arch, not amd64"
"$DOCKER" tag "$agent_img" "$agent_save_tag"
stage=$work/agent-stage; mkdir -p "$stage"
printf '%s\n' "$DESK_AGENT_VERSION" > "$stage/VERSION"
install -m 0755 "$work/a/services/desk-agent/docker/run" "$work/a/services/desk-agent/docker/health" "$stage/"
install -m 0644 "$work/a/services/desk-agent/docker/desk-agent.env" "$stage/"
"$DOCKER" save -o "$stage/image.tar" "$agent_save_tag"
[ -s "$stage/image.tar" ] || die "docker save wrote nothing"
chmod 0644 "$stage/image.tar"
manifest=$(tar -xOf "$stage/image.tar" manifest.json); grep -q "\"$agent_save_tag\"" <<<"$manifest" || die "image.tar's manifest doesn't name $agent_save_tag"
"$DOCKER" image rm "$agent_save_tag" "$agent_img" >/dev/null
agent_art=desk-agent-$DESK_AGENT_VERSION-amd64.tgz
# The layout of services/scripts/package-release.sh desk-agent.
tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$OUT/$agent_art" VERSION run health desk-agent.env image.tar
agent_sha=$(sha_line "$agent_art")

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
# As image/package-desk-stream.sh packs it, from a checkout made under the umask its publisher's had (pinned above): 0.2.4's
# files were group-writable (0664 and 0775, which ma-update clears with chmod -R go-w), 0.3.3's aren't. The same umask
# gives the same bytes.
stream_art=desk-stream-$DESK_STREAM_VERSION.tgz
(
  umask "$DESK_STREAM_UMASK"
  export_tree "$DESK_STREAM_COMMIT" image/recipe/desk-stream "$work/s"
  stage=$work/stream-stage; mkdir -p "$stage"; chmod "$(printf '%o' $((0777 & ~8#$DESK_STREAM_UMASK)))" "$stage"
  cp -a "$work/s/image/recipe/desk-stream/." "$stage/"
  printf '%s\n' "$DESK_STREAM_VERSION" > "$stage/VERSION"
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$stage" -cf - . | gzip -n > "$OUT/$stream_art"
)
stream_sha=$(sha_line "$stream_art")
[ "$stream_sha" = "$DESK_STREAM_SHA" ] || die "desk-stream $DESK_STREAM_VERSION came out as $stream_sha, not the published $DESK_STREAM_SHA"
log "desk-stream matches the published $DESK_STREAM_VERSION byte for byte"

# ---------- the installer it goes with ----------
# Every installer file, as git has it at this clone's commit (a clone with changes gets a "-dirty" bundle, never signed).
installer_manifest "$(git -C "$REPO" rev-parse HEAD)" > "$OUT/installer.sha256"
installer_sha=$(sha256sum < "$OUT/installer.sha256" | cut -c1-64)
rm -f "$OUT/batch-baseline" "$OUT/bundle.pin.sig"
[ -z "$BATCH_BASELINE" ] || printf '{"seq": %s}\n' "$BATCH_BASELINE" > "$OUT/batch-baseline"

# ---------- pin ----------
{
  echo "$MAGIC"
  echo "# amd64 releases for a self-hosted desk, from selfhost/build-bundle.sh: component version sha256, as releases.pin;"
  echo "# then the installer's files (installer.sha256) and the batch baseline. Signed in bundle.pin.sig (EXP-10)."
  echo "# bundle $BUNDLE_COMMIT"
  printf '%-14s %-20s %s\n' desk-rtc "$DESK_RTC_VERSION" "$rtc_sha"
  printf '%-14s %-20s %s\n' desk-stream "$DESK_STREAM_VERSION" "$stream_sha"
  printf '%-14s %-20s %s\n' deskd "$DESKD_VERSION" "$deskd_sha"
  printf '%-14s %-20s %s\n' desk-agent "$DESK_AGENT_VERSION" "$agent_sha"
  printf '%-14s %-20s %s\n' desk-notebook "$DESK_NOTEBOOK_VERSION" "$nb_sha"
  printf '%-14s %-20s %s\n' desk-agent-filter "$DESK_AGENT_FILTER_VERSION" "$filter_sha"
  printf '%-14s %-20s %s\n' installer "$BUNDLE_COMMIT" "$installer_sha"
  [ -z "$BATCH_BASELINE" ] || printf '%-14s %-20s %s\n' batch-baseline "$BATCH_BASELINE" "$(sha256sum < "$OUT/batch-baseline" | cut -c1-64)"
} > "$OUT/bundle.pin"
log "done, in $OUT:"
(cd "$OUT" && ls -l "$rtc_art" "$deskd_art" "$agent_art" "$nb_art" "$stream_art" "$filter_art" | awk '{print "  " $5 "  " $9}')
cat "$OUT/bundle.pin"
if [ -n "$SIGN_AT_END" ]; then
  sign_bundle "$OUT"
else
  log "not signed: install.sh refuses it until it is. $0 --sign $OUT (with $BUNDLE_KMS_KEY_ID)"
fi
