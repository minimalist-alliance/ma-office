#!/usr/bin/env bash
# image/host/template-build.sh <host AMI> [options]: build one template generation for a shared-host image on a temporary
# builder (ADR 0077 sections 1.2 and 1.3; runbook docs/runbooks/host-template-build.md). Run from the workstation; it takes
# ~/work/.aws-bake.lock for its whole run. The builder is an m7g.xlarge launched from the host AMI itself, tagged
# Purpose=desk-image-build (and Owner=$OWNER_TAG), with no instance role, no KMS permission and SSH from this workstation
# only; it powers itself off after --keep-minutes whatever happens (instance-initiated shutdown terminates it), and this
# script terminates it on exit, even on failure, then checks by tag that nothing it made is left.
# On the builder (image/host/template-builder/tb.py and slot.sh, copied for this run, never on a member host):
#   1. g1 against its manifest  2. (no fleet generation yet: g1 is current)  3. g1 copied  4. apt from trixie-security only,
#   Debian's signatures, kernel/bootloader/initramfs pinned -1, the plan (an empty plan stops here and says so)
#   5. the install in its sandbox  6. 1.3's checks on the sealed tree, then a real slot: started on g1 by the fake Platform's
#   start_slot, seeded by e2e/tests/browser-session.spec.ts (SESSION_SLOT=1), stopped, re-rooted to the new generation,
#   started, read back; the host checks, the wall's settings, WR2-02 and desk-stream on it  7. packed, round-tripped
#   through the host's checks, passed-build.json; uploaded through presigned PUT URLs that carry each file's SHA-256.
# Signing is the workstation's: tools/template/template-sign (KMS, alias/ma-host-template), or --dev-key here for a test.
#
# Options:
#   --gen <gN>            the generation's number for this host image (default g2; the bake is g1)
#   --urgent              header.urgent true (ADR 0077 section 5)
#   --test-archive        if trixie-security has nothing newer for the template, prove the full path with section 7's local
#                         test archive instead (one small package repacked at a higher version, signed by a throwaway key
#                         only this builder trusts). Its artifact goes under the test prefix and is never a release.
#   --mutations           then section 7's builder mutation pass, on this builder after the build (its two package mutations
#                         build their own test archive in a directory of their own; the rest use the generation just built)
#   --prefix <prefix>     the bucket prefix (default desk/host-template; desk/host-template-test for a test-archive build)
#   --no-upload           build and check only
#   --dev-key <pem>       after the upload, sign with this dev P-256 key (template-sign --key) and check it (template-verify);
#                         and, with --mutations, the upload's mutation (an edited header refused by template-sign)
#   --keep-minutes <n>    the builder's own power-off (default 150)
#   --evidence <dir>      where the run's records go (default image/host/evidence/template-build-<ami>-<gen>/)
# Env: OWNER_TAG, BUILDER_TYPE (m7g.xlarge), STORE_GB (40), RELEASE_BUCKET, NODE_BIN (~/.local/node-v24/bin), TB_HOLD=1 (a lab
# only: leave the builder for its power-off instead of terminating at exit).
# Exit 0 built (and uploaded), 3 the plan is empty (nothing to build), 1 failed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/../lib.sh"
LOCK=$HOME/work/.aws-bake.lock
if [ -z "${TB_LOCKED:-}" ]; then exec env TB_LOCKED=1 flock -w 3600 "$LOCK" "$0" "$@"; fi
AMI=${1:-}; [[ $AMI =~ ^ami-[0-9a-f]+$ ]] || { sed -n '2,36p' "$0" >&2; exit 2; }; shift
GEN=g2; URGENT=; TEST_ARCHIVE=0; MUTATIONS=0; PREFIX=; UPLOAD=1; DEV_KEY=; KEEP=150; EVD=
while [ $# -gt 0 ]; do
  case "$1" in
    --gen) GEN=$2; shift 2 ;; --urgent) URGENT=--urgent; shift ;; --test-archive) TEST_ARCHIVE=1; shift ;;
    --mutations) MUTATIONS=1; shift ;; --prefix) PREFIX=$2; shift 2 ;; --no-upload) UPLOAD=0; shift ;;
    --dev-key) DEV_KEY=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;; --keep-minutes) KEEP=$2; shift 2 ;;
    --evidence) EVD=$2; shift 2 ;; *) die "unknown option $1" ;;
  esac
done
[[ $GEN =~ ^g([2-9]|[1-9][0-9]{1,5})$ ]] || die "--gen must be g2 or later"
[[ $KEEP =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 30 ] && [ "$KEEP" -le 300 ] || die "--keep-minutes: 30 to 300"
TYPE=${BUILDER_TYPE:-m7g.xlarge}; STORE_GB=${STORE_GB:-40}
BUCKET=${RELEASE_BUCKET:-ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text)}   # the components' release bucket
NODE_BIN=${NODE_BIN:-$HOME/.local/node-v24/bin}
T_START=$(date +%s)
# an artifact is never replaced: its prefix must be empty (checked again just before the upload)
prefix_empty() { [ "$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1/" --query 'length(Contents || `[]`)' --output text)" = 0 ]; }
INSTANCE_ID=; SG_ID=; KEY_NAME=; WORKDIR=; VOL=
read -r AMI_NAME HOSTKIND < <(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].[Name,Tags[?Key==`HostKind`]|[0].Value]' --output text)
[ "$HOSTKIND" = shared ] || die "$AMI ($AMI_NAME) isn't a shared-host image (HostKind=$HOSTKIND)"
HOSTV=${AMI_NAME##*host-}
[[ $HOSTV =~ ^[0-9][A-Za-z0-9._-]*$ ]] || die "can't read the host image version from $AMI_NAME"
if [ -n "$PREFIX" ] && [ "$UPLOAD" = 1 ]; then prefix_empty "$PREFIX/$HOSTV/$GEN" || die "s3://$BUCKET/$PREFIX/$HOSTV/$GEN/ isn't empty: an artifact is never replaced"; fi
EVD=${EVD:-$HERE/evidence/template-build-$AMI-$GEN}
mkdir -p "$EVD"; EV=$EVD/run.txt; : > "$EV"
scrub() { python3 -I -c '
import re, sys
keep = re.compile(r"^(127\.|10\.98\.|169\.254\.|0\.0\.0\.0|255\.|999\.)")   # 999.0.0.0: the carry check'"'"'s faked Chromium version
t = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", lambda m: m.group(0) if keep.match(m.group(0)) else "<addr>", sys.stdin.read())
import os
t = t.replace(os.environ.get("HOME", "/nonexistent"), "~")
sys.stdout.write(re.sub(r"ma-lambda-artifacts-[0-9]+", "<release bucket>", t))'; }   # no address, account number or home path in the evidence
say() { echo "$*" | scrub | tee -a "$EV" >&2; }
R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "$@"; }
TBX() { R "sudo env ${TBENV:-} python3 -I /var/lib/ma-tb/tools/tb.py $*" 2>&1 | scrub | tee -a "$EV" >&2; return "${PIPESTATUS[0]}"; }
SLOT() { R "sudo bash /var/lib/ma-tb/tools/slot.sh $*" 2>&1 | scrub | tee -a "$EV" >&2; return "${PIPESTATUS[0]}"; }
REC() { R "sudo python3 -I /var/lib/ma-tb/tools/tb.py record $(printf '%q ' "$@")" >/dev/null; }
SPEC() {   # SPEC <env...>: browser-session.spec.ts in slot mode, from this workstation, against this run's builder only
  local out=$WORKDIR/spec.$RANDOM.txt rc=0
  (cd "$REPO/e2e" && env PATH="$NODE_BIN:$PATH" SESSION_SLOT=1 SESSION_SLOT_SSH="admin@$IP" SESSION_SLOT_KEY="$KEY_FILE" "$@" \
     npx playwright test tests/browser-session.spec.ts --output "$WORKDIR/pw") > "$out" 2>&1 || rc=$?
  scrub < "$out" | grep -E '\[session\]|✓|✘|passed|failed|Error|expect' | head -40 | tee -a "$EV" >&2
  return $rc
}

cleanup() {
  local rc=$?; trap - EXIT; set +e
  if [ "${TB_HOLD:-0}" = 1 ] && [ -n "$INSTANCE_ID" ]; then
    # a lab only: everything to reach and later remove it, in a file beside the key (never in the evidence)
    printf 'INSTANCE_ID=%s\nIP=%s\nKEY_FILE=%s\nSG_ID=%s\nKEY_NAME=%s\nVOL=%s\nWORKDIR=%s\n' "$INSTANCE_ID" "${IP:-}" "$KEY_FILE" "$SG_ID" "$KEY_NAME" "$VOL" "$WORKDIR" > "$WORKDIR/hold.env"
    log "TB_HOLD=1: leaving $INSTANCE_ID for its own power-off (${KEEP} min after boot); $WORKDIR/hold.env says how to reach and remove it"
    exit "$rc"
  fi
  if [ -n "$VOL" ]; then aws ec2 detach-volume --volume-id "$VOL" --force >/dev/null 2>&1; fi
  destroy_temp_access "$INSTANCE_ID"
  if [ -n "$VOL" ]; then aws ec2 wait volume-available --volume-ids "$VOL" 2>/dev/null; aws ec2 delete-volume --volume-id "$VOL" >/dev/null 2>&1 && log "deleted $VOL"; fi
  if [ -n "${OWNER_TAG:-}" ]; then
    left=$(aws ec2 describe-instances --filters "Name=tag:Owner,Values=$OWNER_TAG" Name=tag:Purpose,Values=desk-image-build \
      Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
    lv=$(aws ec2 describe-volumes --filters "Name=tag:Owner,Values=$OWNER_TAG" --query 'Volumes[].VolumeId' --output text)
    log "removal check by tag Owner=$OWNER_TAG: instances [${left}], volumes [${lv}]"
  fi
  say "builder time: $(( ($(date +%s) - T_START) / 60 )) min from the start of this run"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

say "template build: $AMI ($AMI_NAME), host image $HOSTV, $GEN, on $TYPE; $(date -u +%FT%TZ)"
make_temp_access "ma-template-build-$$"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET=
for az in $(aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=instance-type,Values=$TYPE" --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' '\n' | sort); do
  SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true "Name=availability-zone,Values=$az" --query 'Subnets[0].SubnetId' --output text)
  [[ $SUBNET == subnet-* ]] && break
done
[[ $SUBNET == subnet-* ]] || die "no default subnet offers $TYPE"
PUB=$(ssh-keygen -y -f "$KEY_FILE")
UD=$WORKDIR/userdata.sh
cat > "$UD" <<EOF
#!/bin/bash
# A TEMPLATE BUILDER (image/host/template-build.sh), never a member's host: it powers itself off in $KEEP minutes whatever
# happens, and its instance-initiated shutdown terminates it. Temporary SSH for this run (one key, admin; port 22 opened by
# the group to the workstation only); ssh is started, never enabled.
shutdown -P +$KEEP "template builder: the run's time is up" || true
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$PUB' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
systemctl is-active --quiet nftables.service || systemctl start nftables.service
nft add rule inet host input tcp dport 22 accept
systemctl start ssh
EOF
INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 \
  --network-interfaces "DeviceIndex=0,SubnetId=$SUBNET,Groups=$SG_ID,AssociatePublicIpAddress=true" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled,InstanceMetadataTags=enabled \
  --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=$STORE_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-initiated-shutdown-behavior terminate --user-data "file://$UD" \
  --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=ma-template-builder-$HOSTV-$GEN},{Key=DesksPerHost,Value=6},{Key=SlotsPerHost,Value=6},{Key=HostingVersion,Value=template-builder},{Key=SlotMode,Value=port}]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "builder $INSTANCE_ID ($TYPE)"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
T_RUNNING=$(date +%s)
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
VOL=$(aws ec2 create-volume --availability-zone "$AZ" --size 4 --volume-type gp3 --tag-specifications "$(tagspec volume | sed "s/}]\$/},{Key=Name,Value=ma-template-builder-test-volume}]/")" --query VolumeId --output text)
wait_ssh "$IP" "$KEY_FILE" 600 || die "ssh never came up"
say "builder up: ssh $(( $(date +%s) - T_START )) s after the start"
R 'sudo cloud-init status --wait >/dev/null 2>&1; true'
aws ec2 wait volume-available --volume-ids "$VOL"
aws ec2 attach-volume --volume-id "$VOL" --instance-id "$INSTANCE_ID" --device /dev/sdg >/dev/null
aws ec2 wait volume-in-use --volume-ids "$VOL"
DESK=d-testbuilderz   # hostmeta.py DESK_ID: d- and 12 of [a-z2-7]
aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskSlot1,Value=$DESK/$VOL/-/-/1"

# the builder's tools, for this run only
ST=$WORKDIR/tbtools; mkdir -p "$ST"
cp "$HERE/template-builder/tb.py" "$HERE/template-builder/slot.sh" "$REPO/tools/template/tmpl.py" "$HERE/tests/fake_platform.py" \
   "$REPO/spikes/shared-host-wall-3/tools/units.py" "$REPO/spikes/shared-host-wall-3/tools/cdp_forward.py" "$ST/"
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$ST"/* "admin@$IP:/home/admin/" >/dev/null
R 'sudo install -d -m 700 /var/lib/ma-tb /var/lib/ma-tb/tools && cd /home/admin && sudo install -m 700 tb.py slot.sh tmpl.py fake_platform.py units.py cdp_forward.py /var/lib/ma-tb/tools/ && rm -f tb.py slot.sh tmpl.py fake_platform.py units.py cdp_forward.py'
R "sudo bash -c 'for i in \$(seq 1 60); do systemctl is-active --quiet desk-host-boot && break; sleep 2; done; systemctl is-active desk-host-boot; df -h /srv/desk-host / | tail -2'" | scrub | tee -a "$EV" >&2

stop_after() { [ "${TB_STOP_AFTER:-}" != "$1" ] || { log "TB_STOP_AFTER=$1"; exit 0; }; }   # a lab's way to stop part-way (with TB_HOLD=1)
stop_after launch

# ---- 1 to 4: the base, the copy, the plan
TBX base --host-image "$HOSTV" || die "the base failed"
TBX copy --gen "$GEN" || die "the copy failed"
SOURCE=security; rc=0
TBX plan --gen "$GEN" --source security || rc=$?
if [ "$rc" = 3 ]; then
  say "PLAN EMPTY: trixie-security has nothing newer for the template than host image $HOSTV's bake ($(date -u +%FT%TZ))"
  [ "$TEST_ARCHIVE" = 1 ] || exit 3
  say "--test-archive: proving the full path with the local test archive (section 7), under the test prefix"
  SOURCE=test
  R "sudo mv /var/lib/ma-tb/run/checks.jsonl /var/lib/ma-tb/run/checks-security-plan.jsonl"
  TBX reset-build --gen "$GEN"
  TBX testrepo || die "the test archive failed"
  TBX copy --gen "$GEN" || die "the copy failed"
  TBX plan --gen "$GEN" --source test || die "the test plan failed"
elif [ "$rc" != 0 ]; then
  die "the plan failed"
fi
PREFIX=${PREFIX:-$([ "$SOURCE" = test ] && echo desk/host-template-test || echo desk/host-template)}
[ "$SOURCE" = security ] || [[ $PREFIX == *-test* ]] || die "a test-archive build never goes under $PREFIX"

stop_after plan

# ---- 5, 6: install, seal, 1.3's checks
TBX install --gen "$GEN" || die "the install failed"
TBX seal --gen "$GEN" || die "the seal failed"
TBX check --gen "$GEN" || die "1.3's checks failed"

stop_after check

# ---- 1.3 items 8 and 9: a real slot, started on g1, seeded, stopped, re-rooted to $GEN, started, read back
T0=$(date +%s)
SLOT setup "$DESK" "$VOL" "$IP" || die "the test host's setup failed"
ok=1
SLOT start && SLOT browser || ok=0
[ $ok = 1 ] && { SPEC SESSION_KEEP=1 || ok=0; }
[ $ok = 1 ] && { SLOT stop && SLOT reroot "$GEN" && SLOT start && SLOT browser || ok=0; }
REC slot-start "$([ $ok = 1 ] && echo pass || echo fail)" "slot 1 started on g1 by the fake Platform's start_slot, seeded by browser-session.spec.ts (SESSION_SLOT=1), stopped (desk-init's close), re-rooted to $GEN (desk-host prepare after the template swap: host $HOSTV has no desk-host reroot), started again by start_slot"
rb=1; [ $ok = 1 ] && { SPEC SESSION_KEEP=1 SESSION_CHECK=stop-wake || rb=0; } || rb=0
REC slot-readback "$([ $rb = 1 ] && echo pass || echo fail)" "browser-session.spec.ts SESSION_CHECK=stop-wake on $GEN: both cookies, history, the two tabs and the saved password (decrypted) read back"
if [ $ok = 1 ]; then SLOT checks "$GEN" || true; fi   # with no slot running on $GEN they'd prove nothing: passed-build.json says they never ran
REC slot-carry-refusal skip "Chromium unchanged: the forced re-root back to the current generation's refusal runs only when Chromium changed"
SLOT stop || true
SLOT template g1 || die "couldn't put g1 back as the template"
say "slot start and checks: $(( $(date +%s) - T0 )) s"

# ---- 7: pack, round trip, passed-build.json
TBX pack --gen "$GEN" $URGENT || die "the pack or its round trip failed"
R "sudo bash -c 'cd /var/lib/ma-tb/out && sha256sum * && stat -c \"%s %n\" *'" | scrub | tee -a "$EV" >&2

# ---- the upload, through presigned PUTs that only S3's checksum of each file's own SHA-256 lets through
if [ "$UPLOAD" = 1 ]; then
  T0=$(date +%s)
  KEYP="$PREFIX/$HOSTV/$GEN"
  prefix_empty "$KEYP" || die "s3://$BUCKET/$KEYP/ isn't empty: an artifact is never replaced"
  R "sudo bash -c 'cd /var/lib/ma-tb/out && sha256sum template.tar.zst manifest.json plan.txt passed-build.json header.json'" > "$WORKDIR/sums"
  aws configure export-credentials --format process > "$WORKDIR/creds.json"; chmod 600 "$WORKDIR/creds.json"
  python3 -I - "$REPO/tools/template" "$BUCKET" "$KEYP" "$WORKDIR/sums" "$WORKDIR/creds.json" > "$WORKDIR/urls.json" <<'P'
import json, sys
sys.path.insert(0, sys.argv[1])
import tmpl
creds = json.load(open(sys.argv[5]))
out = {}
for line in open(sys.argv[4]):
    sha, name = line.split()
    out[name] = tmpl.presign_put(sys.argv[2], f"{sys.argv[3]}/{name}", sha, creds, expires=3600)
print(json.dumps(out))
P
  shred -u "$WORKDIR/creds.json"
  R "sudo python3 -I /var/lib/ma-tb/tools/tb.py upload" < "$WORKDIR/urls.json" 2>&1 | grep -v 'X-Amz' | scrub | tee -a "$EV" >&2 || die "the upload failed"
  shred -u "$WORKDIR/urls.json"
  say "uploaded s3://$BUCKET/$KEYP/ in $(( $(date +%s) - T0 )) s"
fi
T_BUILT=$(date +%s)

# ---- the records, kept here (small files only; the archive stays in S3)
for f in header.json plan.txt passed-build.json; do R "sudo cat /var/lib/ma-tb/out/$f" > "$EVD/$f"; done
R "sudo cat /var/lib/ma-tb/run/state.json" > "$EVD/state.json"
R "sudo cat /var/lib/ma-tb/run/checks.jsonl /var/lib/ma-tb/run/checks-security-plan.jsonl 2>/dev/null" | scrub > "$EVD/checks.jsonl" || true

# ---- section 7's builder mutation pass
if [ "$MUTATIONS" = 1 ]; then
  say "== mutation pass"
  M() { R "sudo bash -c 'rm -rf /var/lib/ma-tb/mut-$1 && mkdir -p /var/lib/ma-tb/mut-$1/run /var/lib/ma-tb/mut-$1/out && cp /var/lib/ma-tb/run/g1.json /var/lib/ma-tb/run/state.json /var/lib/ma-tb/mut-$1/run/ && cp /var/lib/ma-tb/out/manifest.json /var/lib/ma-tb/mut-$1/out/'"; TBENV="TB_DIR=/var/lib/ma-tb/mut-$1"; }
  MREC() { TBENV=; REC "$@"; }
  # template-apt: a stable line, the kernel pin removed
  TBENV= TBX template-apt || true
  # the round trip: one byte of the archive changed after the header
  TBENV= TBX roundtrip --gen "$GEN" --flip-byte || true
  # Debian's signature: the test archive signed again by another key
  M sig; TBX testrepo --resign-other-key || true
  TBX copy --gen g90 >/dev/null 2>&1 || true
  if TBX plan --gen g90 --source test; then MREC mutation-debian-signature fail "apt-get update TOOK an archive signed by another key"
  else MREC mutation-debian-signature pass "an archive signed by another key: apt-get update refused it, nothing planned, installed or packed"; fi
  # nothing else changed: the test package's postinst also writes /etc/ma/egress.conf
  M nothing; TBX testrepo --postinst-mutation || true
  TBX copy --gen g91 >/dev/null 2>&1 || true
  if TBX plan --gen g91 --source test && TBX install --gen g91 && TBX seal --gen g91 && ! TBX check --gen g91 \
     && R "sudo grep -q '\"name\": \"nothing-else\", \"result\": \"fail\".*etc/ma/egress.conf' /var/lib/ma-tb/mut-nothing/run/checks.jsonl"; then
    MREC mutation-nothing-else pass "a postinst that also writes /etc/ma/egress.conf: nothing-else failed on etc/ma/egress.conf, so nothing was packed"
  else MREC mutation-nothing-else fail "the postinst's write to /etc/ma/egress.conf wasn't caught by nothing-else"; fi
  R "sudo umount /srv/desk-host/templates/g91 2>/dev/null; sudo rm -rf /srv/desk-host/templates/g91 /srv/desk-host/templates/.build-g9*" || true
  # the carry: clean (forced, since Chromium didn't change) must pass; with the new generation's guard removed it must fail
  M carryok
  if TBX check --gen "$GEN" --force-carry; then MREC mutation-carry-clean pass "the carry check forced on the clean $GEN: passes (current and new Chromium the same version)"
  else MREC mutation-carry-clean fail "the forced carry check failed on the clean $GEN"; fi
  M carry
  if TBX check --gen "$GEN" --mutate-guard; then MREC mutation-carry-guard fail "a generation whose desk-browser-start lacks the guard PASSED the carry check"
  elif R "sudo grep -q '\"name\": \"profile-carry\", \"result\": \"fail\"' /var/lib/ma-tb/mut-carry/run/checks.jsonl"; then
    MREC mutation-carry-guard pass "a generation whose desk-browser-start lacks the guard: the carry check failed (its guard didn't refuse a profile from 999.0.0.0)"
  else MREC mutation-carry-guard fail "the check failed, but not on profile-carry"; fi
  TBENV=
  # the slot start: the seeded profile's Cookies removed before the re-root; the read-back must fail
  ok=1
  SLOT reroot g1 && SLOT start && SLOT browser || ok=0
  [ $ok = 1 ] && { SPEC SESSION_KEEP=1 || ok=0; }
  [ $ok = 1 ] && { SLOT stop && SLOT cookies-off && SLOT reroot "$GEN" && SLOT start && SLOT browser || ok=0; }
  if [ $ok = 1 ] && ! SPEC SESSION_KEEP=1 SESSION_CHECK=stop-wake; then
    MREC mutation-slot-readback pass "the TEST profile's Cookies database removed before the re-root: the read-back failed, as it must"
  else MREC mutation-slot-readback fail "$([ $ok = 1 ] && echo 'the read-back PASSED without the Cookies database' || echo 'the mutation cycle itself failed to run')"; fi
  SLOT stop || true
  SLOT template g1 || true
  # the upload: an edited header must be refused by template-sign (S3's checksums no longer match it)
  if [ "$UPLOAD" = 1 ] && [ -n "$DEV_KEY" ]; then
    python3 -I -c 'import json,sys; h=json.load(open(sys.argv[1])); h["files"]["template.tar.zst"]["sha256"]="0"*64; open(sys.argv[2],"w").write(json.dumps(h, sort_keys=True, indent=1)+"\n")' "$EVD/header.json" "$WORKDIR/edited.json"
    if "$REPO/tools/template/template-sign" "s3://$BUCKET/$KEYP/" --key "$DEV_KEY" --header "$WORKDIR/edited.json" 2>&1 | scrub | tee -a "$EV" >&2; then
      MREC mutation-upload fail "template-sign SIGNED a header whose archive SHA-256 was edited"
    else MREC mutation-upload pass "a header with the archive's SHA-256 edited: template-sign refused it (S3's stored checksum differs), nothing signed"; fi
  fi
  R "sudo cat /var/lib/ma-tb/run/checks.jsonl" | scrub > "$EVD/checks.jsonl"
  R "sudo cat /var/lib/ma-tb/run/checks.jsonl" | python3 -I -c '
import json, sys
rows = [r for r in map(json.loads, sys.stdin) if r["name"].startswith("mutation-")]
for r in rows:
    print("%-4s %s: %s" % (r["result"].upper(), r["name"], r["detail"][:200]))
print("mutations: %d of %d caught" % (sum(r["result"] == "pass" for r in rows), len(rows)))' | scrub | tee -a "$EV" >&2
fi

# ---- the dev key's signature and template-verify (a test; a release is signed with KMS by template-sign, the runbook's step)
if [ "$UPLOAD" = 1 ] && [ -n "$DEV_KEY" ]; then
  "$REPO/tools/template/template-sign" "s3://$BUCKET/$KEYP/" --key "$DEV_KEY" --out "$EVD" 2>&1 | scrub | tee -a "$EV" >&2 || die "template-sign refused"
  openssl pkey -in "$DEV_KEY" -pubout -out "$WORKDIR/dev.pub.pem" 2>/dev/null
  "$REPO/tools/template/template-verify" "s3://$BUCKET/$KEYP/" --pubkey "$WORKDIR/dev.pub.pem" --host-image "$HOSTV" --had g1 2>&1 | scrub | tee -a "$EV" >&2 || die "template-verify refused"
fi
say "BUILT: $HOSTV $GEN from the $SOURCE archive in $(( (T_BUILT - T_START) / 60 )) min (launch to upload); $(python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1])); print("tree %.2f GB, archive %.3f GB, manifest %.1f MB, entries %d; times %s" % (s["treeBytes"]/1e9, s["archiveBytes"]/1e9, s["manifestBytes"]/1e6, s["entries"], s["times"]))' "$EVD/state.json")"
[ "$UPLOAD" = 1 ] && say "artifact: s3://$BUCKET/$KEYP/ ; next: tools/template/template-sign s3://$BUCKET/$KEYP/ --kms-key-id alias/ma-host-template (a release)"
exit 0
