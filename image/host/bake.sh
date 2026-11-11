#!/bin/bash
# image/host/bake.sh <version>: build the shared-host AMI "<prefix><version>" (ADR 0072 section 13; image/host/README.md)
# from a temporary builder. Run from the workstation, under `flock ~/work/.aws-bake.lock`.
# The builder runs the desk recipe (image/recipe/build.sh) unchanged, so its root becomes exactly a desk image, and then the
# host recipe (image/host/recipe/build.sh), which copies that root to the template on the slot store (the AMI's second
# volume) and turns the builder into the host. The AMI carries both volumes.
# Env: HOST_AMI_PREFIX (ma-desk-test-host-, so image/prune.sh can delete a test bake; ma-shared-host- for a release),
# OWNER_TAG, BUILDER_TYPE (c7g.large), ROOT_GB (16: the host and its 8 GB swap file), STORE_GB (12: the template and the
# release store; Platform launches it bigger, desk-host-boot grows it). BATCH_BASELINE (ADR 0078 1.3 step 2): the newest signed batch
# whose releases this image's pin holds, written to /etc/desk-host/batch-baseline; none, no file (0).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=$(cd "$HERE/.." && pwd)
. "$IMG/lib.sh"
VERSION=${1:-}; [[ $VERSION =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "usage: bake.sh <version>"
[ -z "${BATCH_BASELINE:-}" ] || [[ $BATCH_BASELINE =~ ^[0-9]{1,15}$ ]] || die "BATCH_BASELINE must be a batch sequence number"
PREFIX=${HOST_AMI_PREFIX:-ma-desk-test-host-}
NAME=$PREFIX$VERSION
ROOT_GB=${ROOT_GB:-16}; STORE_GB=${STORE_GB:-12}
BUILDER_TYPE=${BUILDER_TYPE:-c7g.large}
REPO=$(cd "$IMG/.." && pwd)
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

existing=$(aws ec2 describe-images --owners self --filters "Name=name,Values=$NAME" --query 'Images[].ImageId' --output text)
[ -z "$existing" ] || die "AMI $NAME already exists ($existing)"

# The desk recipe's releases, checked as image/bake.sh checks them (meta.json, .sha256, passed-test.json), before anything is launched
RELEASE_BUCKET=${RELEASE_BUCKET:-ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text)}
PINS=(); FILTER_TGZ=
while read -r comp ver sha extra; do
  case "$comp" in ''|'#'*) continue ;; esac
  if [ "$comp" = desk-agent-filter ]; then
    "$IMG/package-desk-agent-filter.sh" "$ver" arm64 >&2 || die "desk-agent-filter didn't build"
    FILTER_TGZ=$IMG/dist/$comp-$ver.tgz
    [ "$(sha256sum "$FILTER_TGZ" | cut -d' ' -f1)" = "$sha" ] || die "desk-agent-filter $ver doesn't build to releases.pin's hash"
    continue
  fi
  p="s3://$RELEASE_BUCKET/desk/$comp/$ver"
  meta=$(aws s3 cp --only-show-errors "$p/meta.json" -) || die "$comp $ver: no meta.json"
  [ "$(jq -r '.component + " " + .version + " " + .sha256 + " " + .file' <<<"$meta")" = "$comp $ver $sha $comp-$ver.tgz" ] || die "$comp $ver: releases.pin doesn't match meta.json"
  [ "$(aws s3 cp --only-show-errors "$p/$comp-$ver.tgz.sha256" - | awk 'NF{print tolower($1); exit}')" = "$sha" ] || die "$comp $ver: releases.pin doesn't match .sha256"
  passed=
  for rec in $(pass_records "$comp"); do
    aws s3api head-object --bucket "$RELEASE_BUCKET" --key "desk/$comp/$ver/$rec" >/dev/null 2>&1 && { passed=$rec; break; }
  done
  if [ -n "$passed" ]; then log "$comp $ver: $passed"
  elif [ "${ALLOW_UNPASSED:-0}" = 1 ]; then log "WARNING: $comp $ver hasn't passed on a test desk (ALLOW_UNPASSED=1)"
  else die "$comp $ver hasn't passed ($(pass_records "$comp" | paste -sd' ')); roll it to a test desk (a Guild Desk, for a guild-only component) first"; fi
  PINS+=("$comp $ver")
  log "pinned $comp $ver (sha256 ${sha:0:12})"
done < "$IMG/recipe/releases.pin"
[ -n "$FILTER_TGZ" ] || die "releases.pin has no desk-agent-filter"
for f in desk-data:usr/local/lib/ma/desk-data desk-data.socket:etc/systemd/system/desk-data.socket \
         desk-data@.service:etc/systemd/system/desk-data@.service desk-data.tmpfiles:etc/tmpfiles.d/desk-data.conf; do
  cmp -s "$REPO/tools/desk-data/${f%%:*}" "$IMG/recipe/files/${f#*:}" || die "recipe/files/${f#*:} differs from tools/desk-data"
done

# ADR 0077 PU-9: the template signing key, before anything is launched. The committed key must be exactly its committed anchor
# (recipe/template-keys.sha256; recipe/build.sh checks it again on the builder, staged and installed) and alias/ma-host-template's
# public half as KMS's GetPublicKey gives it (compared as DER). A role without kms:GetPublicKey skips only the KMS half, loudly.
TK_DIR=$HERE/recipe/files/etc/desk-host/template-keys; TK_ANCHOR=$HERE/recipe/template-keys.sha256
python3 -I "$HERE/recipe/template-key-check" "$TK_DIR" "$TK_ANCHOR" >&2 || die "the committed template key isn't exactly its anchor (recipe/template-keys.sha256)"
TK_DER=$(mktemp); TK_ERR=$(mktemp)
if aws kms get-public-key --key-id alias/ma-host-template --query PublicKey --output text 2>"$TK_ERR" | base64 -d > "$TK_DER" 2>/dev/null \
   && [ -s "$TK_DER" ]; then
  python3 -I "$HERE/recipe/template-key-check" "$TK_DIR" "$TK_ANCHOR" --kms-der "$TK_DER" >&2 \
    || { rm -f "$TK_DER" "$TK_ERR"; die "the committed template key isn't alias/ma-host-template's public half (KMS GetPublicKey differs): no bake"; }
elif grep -q 'AccessDenied' "$TK_ERR"; then
  log "WARNING: ==== the template key was NOT compared with KMS: this role lacks kms:GetPublicKey on alias/ma-host-template. Only the committed anchor is checked in this bake ===="
else
  e=$(grep -o '[A-Za-z]*Exception' "$TK_ERR" | head -1 || true); rm -f "$TK_DER" "$TK_ERR"
  die "KMS GetPublicKey on alias/ma-host-template failed (${e:-no error class}): no bake"
fi
rm -f "$TK_DER" "$TK_ERR"

# desk-svc, built here with the pinned Go, the same bytes for the same source (process 1 of every service's sandbox)
GO=${GO:-$HOME/.local/go/bin/go}
DSVC=$(mktemp -d)
(cd "$HERE/desk-svc" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath -ldflags='-s -w -buildid=' -o "$DSVC/desk-svc" .) || die "desk-svc didn't build"
(cd "$DSVC" && sha256sum desk-svc > desk-svc.sha256)
log "desk-svc $(cut -c1-12 "$DSVC/desk-svc.sha256") ($("$GO" version | awk '{print $3}'))"
# desk-ice-demux the same way (SlotMode=port's TCP 443; on every host, started only under SlotMode=port)
DMXV=$(git -C "$HERE/desk-ice-demux" log -1 --format=%h -- . 2>/dev/null || echo unknown)   # the source's last commit: the same bytes for the same source
(cd "$HERE/desk-ice-demux" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath -ldflags="-s -w -buildid= -X main.version=$DMXV" -o "$DSVC/desk-ice-demux" .) || die "desk-ice-demux didn't build"
(cd "$DSVC" && sha256sum desk-ice-demux > desk-ice-demux.sha256)
log "desk-ice-demux $DMXV, $(cut -c1-12 "$DSVC/desk-ice-demux.sha256")"

BASE_AMI=$(aws ssm get-parameter --name /aws/service/debian/release/13/latest/arm64 --query Parameter.Value --output text)
log "base AMI $BASE_AMI ($(aws ec2 describe-images --image-ids "$BASE_AMI" --query 'Images[0].Name' --output text))"
make_temp_access "ma-host-bake-$VERSION-$$"
INSTANCE_ID=$(aws ec2 run-instances --image-id "$BASE_AMI" --instance-type "$BUILDER_TYPE" --count 1 \
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$ROOT_GB,VolumeType=gp3,DeleteOnTermination=true}" \
                          "DeviceName=/dev/sdf,Ebs={VolumeSize=$STORE_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-initiated-shutdown-behavior stop \
  --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=$NAME-builder}]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "builder $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
STORE_VOL=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='/dev/sdf'].Ebs.VolumeId|[0]" --output text)
[[ $STORE_VOL =~ ^vol- ]] || die "no slot store volume on the builder"
wait_ssh "$IP" "$KEY_FILE" || die "builder never accepted ssh"

# Stage both recipes. The host recipe gets its own copy of each release (the desk recipe deletes its own), the pin, the
# desk recipe's file list (those files leave the host) and desk-svc.
SHA=$(git -C "$REPO" rev-parse --short HEAD)   # the tree staged now, not HEAD when the bake ends (0.1.4 recorded a later commit)
git -C "$REPO" diff --quiet -- image || SHA="$SHA+dirty"
STAGE=$WORKDIR/stage; mkdir -p "$STAGE"
cp -r "$IMG/recipe" "$STAGE/ma-recipe"; cp -r "$HERE/recipe" "$STAGE/ma-host-recipe"
cp "$IMG/recipe/releases.pin" "$STAGE/ma-host-recipe/releases.pin"
(cd "$IMG/recipe/files" && find . -type f -o -type l) > "$STAGE/ma-host-recipe/desk-files.txt"
cp "$DSVC/desk-svc" "$DSVC/desk-svc.sha256" "$DSVC/desk-ice-demux" "$DSVC/desk-ice-demux.sha256" "$STAGE/ma-host-recipe/"; rm -rf "$DSVC"
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" -r "$STAGE/ma-recipe" "$STAGE/ma-host-recipe" "admin@$IP:/home/admin/" >/dev/null
fetch='set -euo pipefail; mkdir -p /home/admin/ma-recipe/releases /home/admin/ma-host-recipe/releases; cd /home/admin/ma-recipe/releases'
for cv in "${PINS[@]}"; do
  read -r comp ver <<<"$cv"
  url=$(aws s3 presign "s3://$RELEASE_BUCKET/desk/$comp/$ver/$comp-$ver.tgz" --expires-in 3600)
  fetch+=$'\n'"curl -fsS --proto =https --retry 3 -o '$comp-$ver.tgz' '$url'"
  case "$comp" in deskd|desk-agent|desk-notebook|desk-rtc|desk-stream) fetch+=$'\n'"ln '$comp-$ver.tgz' '/home/admin/ma-host-recipe/releases/$comp-$ver.tgz'" ;; esac
done
printf '%s\n' "$fetch" | ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" 'bash -s' || die "the builder couldn't fetch the releases"
fetch=; url=
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$FILTER_TGZ" "admin@$IP:/home/admin/ma-recipe/releases/" >/dev/null || die "couldn't copy desk-agent-filter"
BUILD_LOG=$WORKDIR/build.log
log "running the desk recipe, then the host recipe (log: $BUILD_LOG)"
# One session: the desk recipe's last step removes the builder's SSH keys, and the session it runs in stays.
ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "sudo bash /home/admin/ma-recipe/build.sh '$VERSION' && sudo ${BATCH_BASELINE:+BATCH_BASELINE=$BATCH_BASELINE} bash /home/admin/ma-host-recipe/build.sh '$VERSION' '$STORE_VOL'; sudo rm -rf /home/admin/ma-host-recipe" 2>&1 | tee "$BUILD_LOG" >&2
grep -q "^build.sh: done" "$BUILD_LOG" || die "the desk recipe did not finish"
grep -q "^host build.sh: done" "$BUILD_LOG" || die "the host recipe did not finish"
cp "$BUILD_LOG" "$HERE/last-build.txt"
CHROMIUM=$(grep '^CHROMIUM_VERSION:' "$BUILD_LOG" | tail -1 | sed 's/^CHROMIUM_VERSION: //' | tr -d '[:space:]')
KVER=$(grep '^HOST_KERNEL:' "$BUILD_LOG" | tail -1 | sed 's/^HOST_KERNEL: //' | tr -d '[:space:]')
BAKED_TAGS=""; BAKED=""
for t in desk-rtc:DeskRtcVersion desk-stream:DeskStreamVersion deskd:DeskdVersion desk-agent:DeskAgentVersion desk-agent-filter:DeskAgentFilterVersion desk-notebook:DeskNotebookVersion; do
  v=$(awk -v c="${t%%:*}" '$1=="BAKED:" && $2==c {print $3}' "$BUILD_LOG" | tail -1)
  [[ $v =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "the desk recipe baked no ${t%%:*}"
  BAKED_TAGS+=",{Key=${t#*:},Value=$v}"; BAKED+="${BAKED:+, }${t%%:*} $v"
done
grep -q '^TEEN_LOCK: 1$' "$BUILD_LOG" || die "the desk recipe didn't report the teen lock"
# DeskSizeClasses=1 (S-119, ADR 0072 "Container sizes by tier"): the placer puts a free desk only on a host launched from an
# image with this tag (ma-platform services/desks/lifecycle hosts.ts, scripts/host-image-set.sh --size-classes). Set only
# when the recipe's class table names both standard and free; verify.sh's classes and class-applied checks then prove it.
CLASSES="$HERE/recipe/files/etc/desk-host/classes.conf"
awk '!/^#/ && NF {print $1}' "$CLASSES" | grep -qx standard && awk '!/^#/ && NF {print $1}' "$CLASSES" | grep -qx free \
  || die "classes.conf must name standard and free"
BAKED_TAGS+=",{Key=DeskTeenLock,Value=1},{Key=DeskSizeClasses,Value=1},{Key=HostKind,Value=shared},{Key=HostKernel,Value=$KVER},{Key=Name,Value=$NAME}"

log "stopping builder"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
AMI_ID=$(aws ec2 create-image --instance-id "$INSTANCE_ID" --name "$NAME" \
  --description "Minimalist Alliance shared desk host $VERSION (ma-desk@$SHA)" \
  --tag-specifications "$(tagspec image | sed "s/}]\$/},{Key=ChromiumVersion,Value=$CHROMIUM}$BAKED_TAGS]/")" "$(tagspec snapshot)" --query ImageId --output text)
log "creating $AMI_ID"
for _ in $(seq 1 180); do
  st=$(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].State' --output text)
  [ "$st" = available ] && break; [ "$st" = failed ] && die "AMI creation failed"; sleep 10
done
[ "$st" = available ] || die "AMI not available after 30 minutes"
aws ec2 modify-image-attribute --image-id "$AMI_ID" --imds-support v2.0
read -r ARCH ENA NBD < <(aws ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].[Architecture,EnaSupport,length(BlockDeviceMappings)]' --output text)
[ "$ARCH" = arm64 ] && [ "$ENA" = True ] && [ "$NBD" = 2 ] || die "AMI is not arm64 + ENA with two volumes ($ARCH $ENA $NBD)"
destroy_temp_access "$INSTANCE_ID"; INSTANCE_ID=
R=$HERE/RELEASES.md
[ -f "$R" ] || printf '# Shared-host image releases\n\n| Version | AMI | Date (UTC) | Git SHA | Kernel | Chromium | Baked releases |\n|---|---|---|---|---|---|---|\n' > "$R"
row="| $VERSION | $AMI_ID | $(date -u +%F\ %H:%M) | $SHA | $KVER | $CHROMIUM | $BAKED |"
awk -v row="$row" '{ if (prev ~ /^\|/ && $0 !~ /^\|/ && !done) { print row; done = 1 } print; prev = $0 } END { if (!done) print row }' "$R" > "$R.tmp" && mv "$R.tmp" "$R"
BAKE_OK=1
echo "AMI_ID=$AMI_ID"
echo "NAME=$NAME"
echo "HOST_KERNEL=$KVER"
echo "CHROMIUM_VERSION=$CHROMIUM"
echo "BAKED_RELEASES=$BAKED"
