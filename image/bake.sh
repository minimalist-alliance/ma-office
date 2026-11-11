#!/bin/bash
# bake.sh <version>: build AMI "ma-desk-<version>" from a temporary c7g.large builder. Run from the workstation.
# Needs: aws CLI (default profile), ssh, scp, curl. Creates only tagged temporary resources and removes them on exit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
VERSION=${1:-}; [[ $VERSION =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "usage: bake.sh <version>"
ROOT_GB=${ROOT_GB:-10}                    # design 10.4: 10 GB root on every class
BUILDER_TYPE=${BUILDER_TYPE:-c7g.large}
REPO=$(cd "$HERE/.." && pwd)
INSTANCE_ID=; AMI_ID=; BAKE_OK=0; SG_ID=; KEY_NAME=; WORKDIR=

cleanup() {
  local rc=$?
  trap - EXIT
  log "cleanup (exit code $rc)"
  destroy_temp_access "$INSTANCE_ID"
  if [ "$BAKE_OK" != 1 ] && [ -n "$AMI_ID" ]; then delete_ami "$AMI_ID" || true; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

existing=$(aws ec2 describe-images --owners self --filters "Name=name,Values=ma-desk-$VERSION" --query 'Images[].ImageId' --output text)
[ -z "$existing" ] || die "AMI ma-desk-$VERSION already exists ($existing)"

# The releases baked in (recipe/releases.pin), checked before anything is launched: each line must match the meta.json
# and .sha256 that scripts/desk-service-release.sh published, and must have passed on a test desk (passed-test.json).
# ALLOW_UNPASSED=1 skips only that last check, for a test bake. Read-only: this never publishes or changes a release.
RELEASE_BUCKET=${RELEASE_BUCKET:-ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text)}
PINS=()
FILTER_TGZ=
while read -r comp ver sha extra; do
  case "$comp" in ''|'#'*) continue ;; esac
  # desk-agent-filter isn't published: this builds it from the recipe, the same bytes for the same source and Go (ADR 0070).
  if [ "$comp" = desk-agent-filter ]; then
    "$HERE/package-desk-agent-filter.sh" "$ver" arm64 >&2 || die "desk-agent-filter didn't build, or its tests fail"
    FILTER_TGZ=$HERE/dist/$comp-$ver.tgz
    got=$(sha256sum "$FILTER_TGZ" | cut -d' ' -f1)
    [ "$got" = "$sha" ] || die "desk-agent-filter $ver builds as ${got:0:12}, and releases.pin says ${sha:0:12}: if recipe/desk-agent-filter changed on purpose, give it a new version and pin that hash"
    log "built $comp $ver (sha256 ${sha:0:12}, matches releases.pin)"
    continue
  fi
  p="s3://$RELEASE_BUCKET/desk/$comp/$ver"
  meta=$(aws s3 cp --only-show-errors "$p/meta.json" -) || die "$comp $ver: no meta.json in $p (not published?)"
  [ "$(jq -r '.component + " " + .version + " " + .sha256 + " " + .file' <<<"$meta")" = "$comp $ver $sha $comp-$ver.tgz" ] \
    || die "$comp $ver: releases.pin doesn't match $p/meta.json"
  [ "$(aws s3 cp --only-show-errors "$p/$comp-$ver.tgz.sha256" - | awk 'NF{print tolower($1); exit}')" = "$sha" ] \
    || die "$comp $ver: releases.pin doesn't match $p/$comp-$ver.tgz.sha256"
  passed=
  for rec in $(pass_records "$comp"); do
    aws s3api head-object --bucket "$RELEASE_BUCKET" --key "desk/$comp/$ver/$rec" >/dev/null 2>&1 && { passed=$rec; break; }
  done
  if [ -n "$passed" ]; then log "$comp $ver: $passed"
  elif [ "${ALLOW_UNPASSED:-0}" = 1 ]; then log "WARNING: $comp $ver hasn't passed on a test desk (ALLOW_UNPASSED=1)"
  else die "$comp $ver hasn't passed ($(pass_records "$comp" | paste -sd' ')); roll it to a test desk (a Guild Desk, for a guild-only component) first"; fi
  PINS+=("$comp $ver")
  log "pinned $comp $ver (sha256 ${sha:0:12}, matches meta.json and .sha256)"
done < "$HERE/recipe/releases.pin"
# The four an image can't boot without go by name: with desk-notebook's line, a count of four would let one of them be
# missing. desk-notebook and commons-server (a Guild Desk's, image/README.md "Guild Desk") are optional: with no line the
# unit is skipped, and with one it's checked above like the rest.
pinned() { local p; for p in "${PINS[@]}"; do [ "${p%% *}" = "$1" ] && return 0; done; return 1; }
for c in desk-rtc desk-stream deskd desk-agent; do
  pinned "$c" || die "releases.pin has no $c; desk-rtc, desk-stream, deskd and desk-agent are all required"
done
# desk-agent-filter is required too, and built above rather than published (ADR 0070).
[ -n "$FILTER_TGZ" ] || die "releases.pin has no desk-agent-filter"

# desk-data's files are tools/desk-data's (task 32), copied into the recipe so build.sh needs nothing outside it. A bake
# copies tools/desk-data over any recipe copy that differs (and says so); change tools/desk-data, run its tests, and commit the copies.
for f in desk-data:usr/local/lib/ma/desk-data desk-data.socket:etc/systemd/system/desk-data.socket \
         desk-data@.service:etc/systemd/system/desk-data@.service desk-data.tmpfiles:etc/tmpfiles.d/desk-data.conf; do
  # A copy that differs is copied over here (it was a manual step that every bake had to remember), and said loudly: the
  # bake's Git SHA then carries "+dirty" until the copy is committed.
  if ! cmp -s "$REPO/tools/desk-data/${f%%:*}" "$HERE/recipe/files/${f#*:}"; then
    cp -p "$REPO/tools/desk-data/${f%%:*}" "$HERE/recipe/files/${f#*:}" \
      || die "couldn't copy tools/desk-data/${f%%:*} over recipe/files/${f#*:}"
    log "desk-data: copied tools/desk-data/${f%%:*} over recipe/files/${f#*:} (commit it)"
  fi
done
[ -x "$HERE/recipe/files/usr/local/lib/ma/desk-data" ] || die "recipe/files/usr/local/lib/ma/desk-data isn't executable"
log "desk-data: the recipe's four files match tools/desk-data"
# Links out (runtime spec section 8.11): the xdg-open stand-in and its socket directory's tmpfiles line are deskd's
# (services/deskd/desk-tools), copied into the recipe the same way. deskd's release doesn't carry them (package-release.sh
# ships run, health, the env and the image), and a program Chromium runs as kiosk from PATH belongs to the root.
for f in xdg-open:usr/local/bin/xdg-open desk-links.tmpfiles:etc/tmpfiles.d/desk-links.conf; do
  if ! cmp -s "$REPO/services/deskd/desk-tools/${f%%:*}" "$HERE/recipe/files/${f#*:}"; then
    cp -p "$REPO/services/deskd/desk-tools/${f%%:*}" "$HERE/recipe/files/${f#*:}" \
      || die "couldn't copy services/deskd/desk-tools/${f%%:*} over recipe/files/${f#*:}"
    log "links out: copied services/deskd/desk-tools/${f%%:*} over recipe/files/${f#*:} (commit it)"
  fi
done
[ -x "$HERE/recipe/files/usr/local/bin/xdg-open" ] || die "recipe/files/usr/local/bin/xdg-open isn't executable"
[ -z "$(find "$HERE/recipe" -type l -print -quit)" ] || die "recipe/ holds a link, which the self-hosted bundle can't name: make it in build.sh"
log "links out: the recipe's stand-in and tmpfiles line match services/deskd/desk-tools"

BASE_AMI=$(aws ssm get-parameter --name /aws/service/debian/release/13/latest/arm64 --query Parameter.Value --output text)
log "base AMI $BASE_AMI ($(aws ec2 describe-images --image-ids "$BASE_AMI" --query 'Images[0].Name' --output text))"

make_temp_access "ma-desk-bake-$VERSION-$$"
INSTANCE_ID=$(aws ec2 run-instances --image-id "$BASE_AMI" --instance-type "$BUILDER_TYPE" --count 1 \
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$ROOT_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-initiated-shutdown-behavior stop \
  --tag-specifications "$(tagspec instance)" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "builder $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
wait_ssh "$IP" "$KEY_FILE" || die "builder never accepted ssh"

# Stage the recipe. desk-rtc comes from releases.pin now, never from a local desk-rtc/dist build.
STAGE=$WORKDIR/ma-recipe; cp -r "$HERE/recipe" "$STAGE"
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" -r "$STAGE" "admin@$IP:/home/admin/ma-recipe" >/dev/null
# The builder fetches the pinned artifacts straight from S3 with 1-hour presigned URLs. They go over ssh's stdin, so
# they're in no argument list, log or file; build.sh checks each hash against releases.pin and deletes the artifact.
fetch='set -euo pipefail; mkdir -p /home/admin/ma-recipe/releases; cd /home/admin/ma-recipe/releases'
for cv in "${PINS[@]}"; do
  read -r comp ver <<<"$cv"
  url=$(aws s3 presign "s3://$RELEASE_BUCKET/desk/$comp/$ver/$comp-$ver.tgz" --expires-in 3600)
  fetch+=$'\n'"curl -fsS --proto =https --retry 3 -o '$comp-$ver.tgz' '$url'"
done
printf '%s\n' "$fetch" | ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" 'bash -s' || die "the builder couldn't fetch the releases"
fetch=; url=
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$FILTER_TGZ" "admin@$IP:/home/admin/ma-recipe/releases/" >/dev/null || die "couldn't copy desk-agent-filter to the builder"
log "builder fetched: $(ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" 'cd /home/admin/ma-recipe/releases && ls -s --block-size=M | tail -n +2 | paste -sd" "')"
BUILD_LOG=$WORKDIR/build.log
log "running build.sh (log: $BUILD_LOG)"
ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "sudo bash /home/admin/ma-recipe/build.sh '$VERSION'" 2>&1 | tee "$BUILD_LOG" >&2
grep -q "^build.sh: done" "$BUILD_LOG" || die "build.sh did not finish"
DISK=$(grep '^DISK:' "$BUILD_LOG" | tail -1 | sed 's/^DISK: //')
cp "$BUILD_LOG" "$HERE/last-build.txt"
CHROMIUM=$(grep '^CHROMIUM_VERSION:' "$BUILD_LOG" | tail -1 | sed 's/^CHROMIUM_VERSION: //' | tr -d '[:space:]')
[[ $CHROMIUM =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "build.sh gave no Chromium version"
# The baked releases go on the AMI as tags too, so a root swap can be compared with what a desk runs before it happens.
BAKED_TAGS=""; BAKED=""
for t in desk-rtc:DeskRtcVersion desk-stream:DeskStreamVersion deskd:DeskdVersion desk-agent:DeskAgentVersion desk-agent-filter:DeskAgentFilterVersion desk-notebook:DeskNotebookVersion commons-server:CommonsServerVersion; do
  v=$(awk -v c="${t%%:*}" '$1=="BAKED:" && $2==c {print $3}' "$BUILD_LOG" | tail -1)
  # Only an unpinned desk-notebook or commons-server goes untagged, and only if build.sh really baked none.
  case "${t%%:*}" in desk-notebook|commons-server)
    if ! pinned "${t%%:*}"; then
      [ -z "$v" ] || die "build.sh baked a ${t%%:*} that releases.pin doesn't name"
      continue
    fi ;;
  esac
  [[ $v =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "build.sh baked no ${t%%:*}"
  BAKED_TAGS+=",{Key=${t#*:},Value=$v}"; BAKED+="${BAKED:+, }${t%%:*} $v"
done

# A teen's desk may only ever be on an image with the lock (image/README.md, Teen Browser lock), so the AMI says so.
grep -q '^TEEN_LOCK: 1$' "$BUILD_LOG" || die "build.sh didn't report the teen lock"
BAKED_TAGS+=",{Key=DeskTeenLock,Value=1}"

log "stopping builder"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"

SHA=$(git -C "$REPO" rev-parse --short HEAD)
git -C "$REPO" diff --quiet -- image || SHA="$SHA+dirty"
AMI_ID=$(aws ec2 create-image --instance-id "$INSTANCE_ID" --name "ma-desk-$VERSION" \
  --description "Minimalist Alliance desk image $VERSION (ma-desk@$SHA)" \
  --tag-specifications "$(tagspec image | sed "s/}]\$/},{Key=ChromiumVersion,Value=$CHROMIUM}$BAKED_TAGS]/")" "$(tagspec snapshot)" --query ImageId --output text)
log "creating $AMI_ID"
for _ in $(seq 1 180); do   # snapshots of a 10 GB root can take over 10 minutes; the CLI waiter gives up too early
  st=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].State' --output text)
  [ "$st" = available ] && break; [ "$st" = failed ] && die "AMI creation failed"; sleep 10
done
[ "$st" = available ] || die "AMI not available after 30 minutes"
aws ec2 modify-image-attribute --image-id "$AMI_ID" --imds-support v2.0
read -r ARCH BOOT ENA SIZE < <(aws ec2 describe-images --image-ids "$AMI_ID" \
  --query 'Images[0].[Architecture,BootMode||`none`,EnaSupport,BlockDeviceMappings[0].Ebs.VolumeSize]' --output text)
log "AMI $AMI_ID arch=$ARCH boot=$BOOT ena=$ENA root=${SIZE}GB"
[ "$ARCH" = arm64 ] && [ "$ENA" = True ] || die "AMI is not arm64+ENA"

destroy_temp_access "$INSTANCE_ID"; INSTANCE_ID=
[ -f "$HERE/RELEASES.md" ] || printf '# Desk image releases\n\n| Version | AMI | Date (UTC) | Root GB | Boot mode | Git SHA | Chromium | Baked releases |\n|---|---|---|---|---|---|---|---|\n' > "$HERE/RELEASES.md"
# The new row goes at the end of the table, above the notes.
row="| $VERSION | $AMI_ID | $(date -u +%F\ %H:%M) | $SIZE | $BOOT | $SHA | $CHROMIUM | $BAKED |"
awk -v row="$row" '{ if (prev ~ /^\|/ && $0 !~ /^\|/ && !done) { print row; done = 1 } print; prev = $0 } END { if (!done) print row }' "$HERE/RELEASES.md" > "$HERE/RELEASES.md.tmp"
mv "$HERE/RELEASES.md.tmp" "$HERE/RELEASES.md"
BAKE_OK=1
echo "AMI_ID=$AMI_ID"
echo "CHROMIUM_VERSION=$CHROMIUM"
echo "BAKED_RELEASES=$BAKED"
echo "ROOT_GB=$SIZE BOOT_MODE=$BOOT"
echo "ROOT_FS_USAGE: $DISK"
