#!/bin/bash
# verify.sh <ami-id>: boot the AMI on a t4g.medium with a blank 20 GB gp3 data volume on /dev/sdf and check it.
# SSH is enabled only by user data (test only). Evidence goes to image/evidence/verify-<ami>.txt.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
AMI=${1:-}; [[ $AMI =~ ^ami-[0-9a-f]+$ ]] || die "usage: verify.sh <ami-id>"
TYPE=${VERIFY_TYPE:-t4g.medium}
# VERIFY_KIND=guild boots the AMI as Platform boots a Guild Desk, tagged DeskKind=guild with metadata tags on, and runs
# sections 1 to 1a1, then verify-kind.sh's guild sections, and stops (image/README.md, "Guild Desk"). The default boots it
# as before, with metadata tags off, and adds verify-kind.sh's member sections after 1a1.
KIND=${VERIFY_KIND:-member}; case "$KIND" in member|guild) ;; *) die "VERIFY_KIND is member or guild" ;; esac
MDTAGS=; KINDTAG=; [ "$KIND" = guild ] && { MDTAGS=,InstanceMetadataTags=enabled; KINDTAG=,{Key=DeskKind,Value=guild}; }
INSTANCE_ID=; SG_ID=; KEY_NAME=; WORKDIR=; VOL2=
mkdir -p "$HERE/evidence"; EV=$HERE/evidence/verify-$AMI.txt; [ "$KIND" = guild ] && EV=$HERE/evidence/verify-guild-$AMI.txt; : > "$EV"
cleanup() { local rc=$?; trap - EXIT; log "cleanup"; destroy_temp_access "$INSTANCE_ID"; exit "$rc"; }
trap cleanup EXIT; trap 'exit 130' INT TERM

PASS=0; FAILN=0; INFON=0
say() { echo "$*" | tee -a "$EV" >&2; }
result() { # result <name> <0|1> ; evidence on stdin
  local ev; ev=$(cat)
  if [ "$2" = 0 ]; then PASS=$((PASS+1)); say "PASS  $1"; else FAILN=$((FAILN+1)); say "FAIL  $1"; fi
  echo "$ev" | sed 's/^/        /' >> "$EV"
}
# info <name> ; evidence on stdin. A measurement kept for the record: it can't fail, so it's neither a pass nor in the count.
info() {
  local ev; ev=$(cat)
  INFON=$((INFON+1)); say "INFO  $1"
  echo "$ev" | sed 's/^/        /' >> "$EV"
}
R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "$@"; }   # remote command (bash -c style string)
RS() { R "sudo bash -s"; }

make_temp_access "ma-desk-verify-$$"
PUB=$(ssh-keygen -y -f "$KEY_FILE")
UD=$WORKDIR/userdata.sh
cat > "$UD" <<EOF
#!/bin/bash
# Record the normal-boot state first, then re-enable temporary SSH for this test only. The security group limits who can reach port 22.
{
  echo "== authorized_keys files at boot"; find /root /home -name 'authorized_keys*' -exec ls -l --time-style=full-iso {} \; -exec cut -c1-120 {} \; 2>/dev/null
  echo "== cloud-init"; cloud-init status --long 2>&1 | head -5; ls -ld /var/lib/cloud/instances/* 2>&1; grep -h -i -E 'authorized|public-keys|ssh' /var/log/cloud-init.log 2>/dev/null | head -12; date -u
  echo "== ssh enabled?"; systemctl is-enabled ssh.service ssh.socket 2>&1
  echo "== ssh active?"; systemctl is-active ssh.service ssh.socket 2>&1
  echo "== host keys"; ls /etc/ssh/ssh_host_* 2>&1
  echo "== ss -lntu at boot"; ss -lntu
} > /var/tmp/prestate.txt 2>&1
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$PUB' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/verify-ssh.service <<'U'
[Unit]
Description=TEST ONLY: temporary SSH for verify.sh
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft add rule inet ma input tcp dport 22 accept; systemctl start ssh'
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable --now verify-ssh.service
EOF

T0=$(date +%s)
INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 --security-group-ids "$SG_ID" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled$MDTAGS \
  --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}" \
  --user-data "file://$UD" --tag-specifications "$(tagspec instance | sed "s/}]\$/}$KINDTAG]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text) || die "run-instances failed"
log "instance $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
getip() { aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text; }
IP=$(getip)
wait_ssh "$IP" "$KEY_FILE" 600 || die "ssh never came up"
T_SSH=$(( $(date +%s) - T0 ))
say "AMI $AMI on $TYPE, instance $INSTANCE_ID, ssh reachable $T_SSH s after run-instances, booted as a $KIND desk"
R 'cloud-init status --wait >/dev/null 2>&1; true'
# TD-227: the prewarm (desk-browser-prewarm) would start the Browser on any boot that has an age band, which no section below expects,
# so its kill switch is on for the whole run and section 8 turns it off to test it. The file is on /data, so a root replacement keeps it.
R 'sudo touch /data/desk/no-prewarm'

# ---- 1. data volume
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
bad=0
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT
echo "--- desk-firstboot log"; journalctl -u desk-firstboot --no-pager -o cat
findmnt /data -o TARGET,SOURCE,FSTYPE,OPTIONS
blkid -s LABEL -s UUID -s TYPE $(findmnt -n -o SOURCE /data)
echo "UUID1=$(blkid -s UUID -o value $(findmnt -n -o SOURCE /data))" 
echo "--- dirs (uid:gid mode)"; stat -c '%u:%g %a %n' /data/desk /data/rtc /data/browser /data/browser/profile
[ "$(stat -c %u:%g /data/desk)" = 1100:1100 ] && [ "$(stat -c %u:%g /data/rtc)" = 1101:1101 ] && [ "$(stat -c %u:%g /data/browser)" = 1102:1102 ] && echo "owners ok" || { echo "OWNER MISMATCH"; bad=1; }
echo "--- /run/desk"; stat -c '%U:%G %a %n' /run/desk
# The Files app's tree (ADR 0048): deskd (uid 1100) alone, 0700. deskd answers files.* unavailable unless it is exactly this.
echo "--- /data/files: $(stat -c '%u:%g %a %F' /data/files 2>&1)"
# What is inside is deskd's to make (it adds its own folders once it runs, and had by this point on the guild run), so: the directory
# itself 1100:1100 0700, and nothing in it owned by anyone but 1100.
[ "$(stat -c '%u:%g %a %F' /data/files 2>&1)" = "1100:1100 700 directory" ] && [ -z "$(find /data/files -mindepth 1 ! -uid 1100 2>&1)" ] || { echo "BAD: /data/files should be a 1100:1100 0700 directory holding nothing but uid 1100's: $(find /data/files -mindepth 1 -printf '%u:%g %m %P\n' 2>&1 | head -5)"; bad=1; }
echo "    inside: $(find /data/files -mindepth 1 -printf '%P ' 2>&1 | head -c 200)"
echo "--- ordering: deskd and desk-rtc start after the mount and directory setup"
for u in deskd desk-rtc; do echo "$u After: $(systemctl show -p After --value $u | tr ' ' '\n' | grep -E '^(data.mount|desk-datadirs.service)$' | paste -sd' ')  Requires: $(systemctl show -p Requires --value $u | tr ' ' '\n' | grep -E '^(data.mount|desk-datadirs.service)$' | paste -sd' ')"
  systemctl show -p After --value $u | grep -q desk-datadirs.service && systemctl show -p Requires --value $u | grep -q desk-datadirs.service || { echo "$u ORDER BAD"; bad=1; }; done
echo "datadirs active at $(( $(systemctl show -p ActiveEnterTimestampMonotonic --value desk-datadirs) / 1000000 )) s, firstboot at $(( $(systemctl show -p ActiveEnterTimestampMonotonic --value desk-firstboot) / 1000000 )) s"
echo "--- tools"; command -v docker && docker --version; systemctl is-active docker
dd if=/dev/urandom bs=1k count=64 2>/dev/null | sha256sum > /data/marker; cat /data/marker
journalctl -u desk-firstboot --no-pager -o cat | grep -q "formatted /dev" || bad=1
echo "--- format record (ADR 0035)"; cat /data/.ma-volume /data/desk/volume.json
echo "volume serial: $(cat /sys/block/$(basename $(findmnt -n -o SOURCE /data))/device/serial)"
jq -e '.formattedAt and (.volumeId|startswith("vol-"))' /data/.ma-volume >/dev/null || { echo "BAD: no format record"; bad=1; }
cmp /data/.ma-volume /data/desk/volume.json || bad=1
[ "$(stat -c '%U %a' /data/.ma-volume)" = "root 644" ] || bad=1
mountpoint -q /data || bad=1
exit ${bad:-0}
X
UUID1=$(grep '^UUID1=' $WORKDIR/o | cut -d= -f2); MARK=$(R 'cat /data/marker')
result "data volume formatted once on blank volume, label ma-data, dirs created (/data/files 1100:1100 0700)" $rc < $WORKDIR/o

# ---- 1a. The baked releases on this first boot, with a blank /data and nothing rolled on (runtime spec section 6).
# The versions come from the AMI's tags, which bake.sh set from what build.sh installed. An image without them fails here.
RELEASE_BUCKET=${RELEASE_BUCKET:-ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text)}
read -r T_RTC T_STREAM T_DESKD T_AGENT T_FILTER T_NOTEBOOK T_COMMONS SRC_ID < <(aws ec2 describe-images --image-ids "$AMI" --output text --query \
  "Images[0].[Tags[?Key=='DeskRtcVersion']|[0].Value,Tags[?Key=='DeskStreamVersion']|[0].Value,Tags[?Key=='DeskdVersion']|[0].Value,Tags[?Key=='DeskAgentVersion']|[0].Value,Tags[?Key=='DeskAgentFilterVersion']|[0].Value,Tags[?Key=='DeskNotebookVersion']|[0].Value,Tags[?Key=='CommonsServerVersion']|[0].Value,SourceInstanceId]")
WANT="desk-rtc=$T_RTC desk-stream=$T_STREAM deskd=$T_DESKD desk-agent=$T_AGENT desk-agent-filter=$T_FILTER"
# desk-notebook is the one optional pin: with no tag it's not baked and section 3n expects its unit skipped. With a tag it
# joins WANT, so everything that goes through WANT holds it to what the other five are held to.
N_BAKED=5; [ "$T_NOTEBOOK" = None ] && T_NOTEBOOK=
[ -z "$T_NOTEBOOK" ] || { WANT="$WANT desk-notebook=$T_NOTEBOOK"; N_BAKED=6; }
# commons-server is optional the same way (a Guild Desk's; verify-kind.sh). On a member's desk its health must pass too.
[ "$T_COMMONS" = None ] && T_COMMONS=
[ -z "$T_COMMONS" ] || { WANT="$WANT commons-server=$T_COMMONS"; N_BAKED=$((N_BAKED + 1)); }
# boottimes: when each part was up, in ms after kernel start, waiting up to 3 minutes for deskd's "ready" line.
AGENTWAIT='agentwait() { local i; for i in $(seq 1 120); do RELEASE_DIR=/opt/ma/desk-agent/current /opt/ma/desk-agent/current/health >/dev/null 2>&1 && break; sleep 1; done; echo "desk-agent health answered after ${i} s of waiting"; }
notebookwait() { local i; [ -x /opt/ma/desk-notebook/current/health ] || return 0; for i in $(seq 1 120); do RELEASE_DIR=/opt/ma/desk-notebook/current /opt/ma/desk-notebook/current/health >/dev/null 2>&1 </dev/null && break; sleep 1; done; echo "desk-notebook health answered after ${i} s of waiting"; }'
BOOTTIMES='boottimes() {
  local t="" i; for i in $(seq 1 180); do t=$(journalctl -b -o short-monotonic --no-pager | grep -m1 "deskd ready in"); [ -n "$t" ] && break; sleep 1; done
  at() { echo $(( $(systemctl show -p ActiveEnterTimestampMonotonic --value "$1") / 1000 )); }
  echo "boot, ms after kernel start: desk-firstboot $(at desk-firstboot), desk-datadirs $(at desk-datadirs), desk-rtc $(at desk-rtc), docker $(at docker), deskd unit $(at deskd), deskd ready $(awk -F"[][]" "{split(\$2,a,\".\"); printf \"%d\", a[1]*1000+substr(a[2],1,3)}" <<<"$t")$([ -n "$t" ] || echo never) ($(grep -o "ready in [0-9]* ms" <<<"$t") from its own start)"
}'
{ printf 'WANT=%q; SRC=%q; N_BAKED=%q\n' "$WANT" "$SRC_ID" "$N_BAKED"; echo "$BOOTTIMES"; echo "$AGENTWAIT"; cat <<'X'
rc=0; bad() { echo "BAD: $*"; rc=1; }
echo "--- first boot, blank /data"; boottimes; agentwait; notebookwait
journalctl -b -u desk-firstboot -o cat --no-pager | grep -m1 'formatted /dev' || bad "/data wasn't formatted at this boot"
echo "--- the baked releases (AMI tags: $WANT)"
[ "$(wc -w <<<"$WANT")" = "$N_BAKED" ] && ! grep -q None <<<"$WANT" || bad "the AMI's tags don't name desk-rtc, desk-stream, deskd, desk-agent and desk-agent-filter"
for cv in $WANT; do comp=${cv%%=*}; ver=${cv#*=}; d=/opt/ma/$comp
  echo "$comp: current $(readlink $d/current), previous $(readlink $d/previous || echo none), releases $(ls $d/releases | paste -sd' '), VERSION $(cat $d/current/VERSION)"
  [ "$(readlink $d/current)" = "$d/releases/$ver" ] && [ ! -e $d/previous ] && [ "$(ls $d/releases)" = "$ver" ] \
    && [ "$(tr -d '[:space:]' < $d/current/VERSION)" = "$ver" ] && [ -s $d/current/artifact.sha256 ] || bad "$comp isn't exactly the baked $ver"
  out=$(RELEASE_DIR=$d/current timeout 30 $d/current/health 2>&1) && echo "$comp health: ok" || bad "$comp health: $out"
done
for u in desk-rtc deskd desk-agent desk-agent-filter desk-stream docker; do echo "$u: $(systemctl is-enabled $u) $(systemctl is-active $u)"; done
systemctl is-active --quiet desk-rtc && systemctl is-active --quiet deskd && systemctl is-active --quiet desk-agent && systemctl is-active --quiet desk-agent-filter || bad "desk-rtc, deskd, desk-agent and desk-agent-filter should all be running"
[ "$(systemctl is-active desk-stream)" != active ] || bad "desk-stream started at boot"
echo "--- the Docker components' containers run the baked images, and nothing was pulled"
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'
CONTAINERS="deskd desk-agent"; case " $WANT " in *" desk-notebook="*) CONTAINERS="$CONTAINERS desk-notebook" ;; esac
for c in $CONTAINERS; do
  want=$(cat /opt/ma/$c/current/image-id); got=$(docker inspect -f '{{.Image}}' $c 2>&1)
  echo "container $c: image $got, running $(docker inspect -f '{{.State.Running}}' $c 2>&1)"
  [ "$got" = "$want" ] || bad "the $c container doesn't run the baked image"
done
[ "$(docker images -q --no-trunc | sort -u | paste -sd' ')" = "$(for c in $CONTAINERS; do cat /opt/ma/$c/current/image-id; done | sort -u | paste -sd' ')" ] \
  || bad "docker holds an image that isn't one of the baked ones ($CONTAINERS)"
systemctl is-active --quiet desk-egress && /opt/ma/desk-egress/current/desk-egress --check || bad "desk-egress isn't running with its shaper on (ADR 0036)"
# The releases above and desk-egress, which build.sh bakes from the recipe (ADR 0036): six, or seven with desk-notebook.
echo "--- smoke test"; s=$(/opt/ma/smoke-test 2>&1); echo "$s"; grep -q "^smoke-test: ok ($((N_BAKED + 1)) component(s))\$" <<<"$s" || bad "smoke test"
echo "--- deskd: /health, and its first lines. A verify box has no DeskId or Env tag, so it says no hello: Platform's provisioning test does that"
curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://localhost/health | head -c 800; echo
journalctl -b -o cat --no-pager -t deskd | grep -v '^$' | head -8 | cut -c1-220
echo "--- per-desk state, made here on first boot"
ls -l /data/rtc /data/desk | cut -c1-120
[ "$(stat -c '%U %a' /data/rtc/dtls-identity.pem 2>&1)" = "rtc 600" ] || bad "no DTLS identity of this desk's own (owner rtc, mode 600)"
echo "RTCID=$(sha256sum /data/rtc/dtls-identity.pem | cut -c1-16)"
echo "docker engine ID made on this box: $(cat /var/lib/docker/engine-id 2>&1 | cut -c1-8)..."
echo "--- the image itself holds none: its own /data, under the mount"
m=$(mktemp -d); mount --bind / $m; n=$(ls -A $m/data | wc -l); echo "root's /data: $n entries"; [ "$n" = 0 ] || bad "the image has files in /data"; umount $m; rmdir $m
echo "--- the builder's instance ID ($SRC) anywhere on the root but its journal and image layers"
if [[ $SRC =~ ^i-[0-9a-f]+$ ]]; then
  hits=$(grep -rlsF "$SRC" /etc /var /opt /root /home /usr/local /boot --exclude-dir=journal --exclude-dir=overlay2 2>/dev/null)
  echo "files: $(grep -c . <<<"$hits")"; [ -z "$hits" ] || { echo "$hits" | head -10; bad "the builder's instance ID is on the image"; }
  echo "in /var/log/journal (informational; handoff 16 section B): $(grep -rlsF "$SRC" /var/log/journal 2>/dev/null | wc -l) files"
else bad "the AMI names no source instance"; fi
echo "--- root"; df -B1M --output=size,used,avail / | tail -1 | awk '{print "root: "$1" MiB, used "$2" MiB, free "$3" MiB"}'
du -sxm /var/lib/docker /opt/ma | sed 's/^/MiB: /'   # -x: not the running container's overlay mount again
exit $rc
X
} | RS > $WORKDIR/o 2>&1; rc=$?
RTCID=$(grep '^RTCID=' $WORKDIR/o | cut -d= -f2)
result "baked releases on first boot, blank /data, nothing rolled on: desk-rtc, desk-stream, deskd, desk-agent, desk-agent-filter and any pinned desk-notebook from the image, healthy, their Docker images not pulled, per-desk state made here, none in the image" $rc < $WORKDIR/o
# ---- 1a1. Each baked release is the artifact releases.pin names. bake.sh and build.sh check the hashes at the bake; this checks
# the image, through the artifact.sha256 that ma-update wrote once the download matched. The pins are read at the commit the
# AMI's description names (bake.sh writes "ma-desk@<sha>"), so an older AMI is held to its own; a +dirty or unknown commit
# falls back to this tree's releases.pin, and the evidence says which.
rc=0; EXPECT=
{ src=$(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Description' --output text 2>&1 | grep -o 'ma-desk@[0-9a-f+dirty]*' | cut -d@ -f2)
  if [[ $src =~ ^[0-9a-f]{7,40}$ ]] && pin=$(git -C "$HERE/.." show "$src:image/recipe/releases.pin" 2>/dev/null); then
    echo "releases.pin at ma-desk@$src, the AMI's own commit"
  else
    pin=$(cat "$HERE/recipe/releases.pin"); echo "releases.pin from this tree: the AMI names ma-desk@${src:-nothing}, dirty, or not a commit here"
  fi
  for cv in $WANT; do comp=${cv%%=*}; ver=${cv#*=}
    read -r pv psha < <(awk -v c="$comp" '$1==c {print $2, $3; exit}' <<<"$pin")
    if [ "${pv:-}" = "$ver" ] && [[ ${psha:-} =~ ^[0-9a-f]{64}$ ]]; then EXPECT+=" $comp=$ver=$psha"
    else echo "BAD: the AMI has $comp $ver, and releases.pin says ${pv:-nothing} ${psha:-}"; rc=1; fi
  done
  [ "$(wc -w <<<"$EXPECT")" = "$N_BAKED" ] || { echo "BAD: $(wc -w <<<"$EXPECT") of $N_BAKED baked releases have a pin to compare"; rc=1; }
  { printf 'EXPECT=%q\n' "$EXPECT"; cat <<'X'
rc=0
for e in $EXPECT; do comp=${e%%=*}; r=${e#*=}; ver=${r%%=*}; want=${r#*=}
  got=$(tr -d '[:space:]' 2>/dev/null < /opt/ma/$comp/current/artifact.sha256)
  echo "$comp $ver: sha256 ${got:-none}, current $(readlink /opt/ma/$comp/current)"
  [ "$got" = "$want" ] || { echo "BAD: $comp $ver, releases.pin says $want"; rc=1; }
done
exit $rc
X
  } | RS 2>&1 || rc=1
} > $WORKDIR/o 2>&1
result "baked releases are the pinned artifacts: each one's sha256 is the one releases.pin names for its version" $rc < $WORKDIR/o

# ---- 1k. The desk's kind (image/README.md, "Guild Desk"): verify-kind.sh. A guild run stops after its own sections.
. "$HERE/verify-kind.sh"
if [ "$KIND" = guild ]; then
  kind_guild
  say ""; say "SUMMARY ($KIND): $PASS passed, $FAILN failed, and $INFON informational (recorded, not judged, not counted). Evidence: image/evidence/$(basename "$EV")"
  [ "$FAILN" = 0 ]; exit
fi
kind_member
boot_timing() { say "boot timing $1: $({ echo "$BOOTTIMES"; echo boottimes; } | RS 2>&1 | tail -1)"; }
# ---- 1b. first-open read: runs by itself on a fresh root, reads only its list, and nothing waits for it (image/README.md, First open)
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
bad=0
L=/usr/local/share/ma/preread.list
for i in $(seq 1 300); do [ -e /var/lib/desk-preread/done ] && break; sleep 2; done
echo "stamp: $(cat /var/lib/desk-preread/done 2>&1)"; [ -e /var/lib/desk-preread/done ] || { echo "BAD: no stamp"; bad=1; }
journalctl -u desk-preread --no-pager -o cat | tail -3
echo "list: $(wc -l < $L) files, $(xargs -a $L -d '\n' stat -c %s 2>/dev/null | awk '{s+=$1} END {printf "%.0f MB", s/1e6}')"
if grep -E '^/(data|home|root|run|tmp|proc|sys|dev)(/|$)' $L; then echo "BAD: the list reaches past the image"; bad=1; fi
grep -q '^/usr/lib/chromium/chromium$' $L || { echo "BAD: no Chromium in the list"; bad=1; }
echo "unit: $(systemctl show desk-preread -p Type -p Result -p UID --value | paste -sd' ')"
[ "$(systemctl show desk-preread -p Type --value)" = exec ] || { echo "BAD: a unit that blocks the boot"; bad=1; }
echo "--- what needs it (only multi-user.target, by Wants)"
systemctl show desk-preread -p RequiredBy -p WantedBy -p RequisiteOf -p BoundBy --value
systemctl list-dependencies --plain --reverse desk-preread | tail -n +2 | grep -qvE 'multi-user.target|graphical.target|default.target' && { echo "BAD: something depends on it"; bad=1; }
# Nothing in it may run with access to /data, and the profile's atime can't say so on noatime: the mount namespace does.
grep -q '^InaccessiblePaths=-/data$' /etc/systemd/system/desk-preread.service || { echo "BAD: /data isn't inaccessible"; bad=1; }
for u in deskd desk-rtc desk-browser desk-stream desk-xorg; do systemctl show -p After -p Requires --value $u | grep -q desk-preread && { echo "BAD: $u waits on it"; bad=1; }; done
exit $bad
X
result "desk-preread: read its list once on the fresh root, only image files, and nothing waits for it" $rc < $WORKDIR/o

chk_persist() { # chk_persist <label>
  RS <<'X' > $WORKDIR/o 2>&1; rc=$?
echo "UUID=$(blkid -s UUID -o value $(findmnt -n -o SOURCE /data))"; cat /data/marker
echo "--- desk-firstboot log this boot"; journalctl -b -u desk-firstboot --no-pager -o cat
jq -e .formattedAt /data/.ma-volume >/dev/null && journalctl -b -u desk-firstboot --no-pager -o cat | grep -q "NOT formatting"
X
  local u m; u=$(grep '^UUID=' $WORKDIR/o | cut -d= -f2); m=$(grep -v -e '^UUID=' -e '^---' -e 'desk-firstboot:' $WORKDIR/o | head -1)
  [ "$u" = "$UUID1" ] && [ "$m" = "$MARK" ] || rc=1
  echo "expected UUID $UUID1 marker $MARK" >> $WORKDIR/o
  result "$1" $rc < $WORKDIR/o
}
R 'sudo reboot' >/dev/null 2>&1; sleep 20; wait_ssh "$IP" "$KEY_FILE" 300 || die "no ssh after reboot"
# user data does not rerun on reboot, so SSH is gone unless re-enabled: handled below
chk_persist "data survives reboot, not reformatted"
boot_timing "after a reboot"
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
echo "after a reboot: $(systemctl show desk-preread -p ConditionResult -p ExecMainStartTimestampMonotonic | paste -sd' ')"
[ "$(systemctl show desk-preread -p ConditionResult --value)" = no ] && [ "$(systemctl show desk-preread -p ExecMainStartTimestampMonotonic --value)" = 0 ]
X
result "desk-preread doesn't run again on a root that has its stamp" $rc < $WORKDIR/o
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null; aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(getip); wait_ssh "$IP" "$KEY_FILE" 300 || die "no ssh after stop/start"
chk_persist "data survives stop and start, not reformatted"
boot_timing "after a stop and start"

# root replacement: the root volume is replaced from the AMI; device names may swap. /data must be found and kept.
RS <<'X' > $WORKDIR/o0 2>&1
echo "before: root=$(findmnt -n -o SOURCE / ) data=$(findmnt -n -o SOURCE /data)"; echo "mapping: $(nvme id-ctrl -b $(findmnt -n -o SOURCE /data) 2>/dev/null | dd bs=1 skip=3072 count=32 2>/dev/null | tr -d '\0')"
X
TASK=$(aws ec2 create-replace-root-volume-task --instance-id "$INSTANCE_ID" --delete-replaced-root-volume --tag-specifications "ResourceType=replace-root-volume-task,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform}]" --query ReplaceRootVolumeTask.ReplaceRootVolumeTaskId --output text)
for i in $(seq 1 90); do st=$(aws ec2 describe-replace-root-volume-tasks --replace-root-volume-task-ids "$TASK" --query 'ReplaceRootVolumeTasks[0].TaskState' --output text); [ "$st" = succeeded ] || [ "$st" = failed ] && break; sleep 10; done
say "replace-root task $TASK: $st"
sleep 20; wait_ssh "$IP" "$KEY_FILE" 420 || die "no ssh after root replacement"
R 'cloud-init status --wait >/dev/null 2>&1; true'
RS <<'X' > $WORKDIR/o1 2>&1
echo "after: root=$(findmnt -n -o SOURCE / ) data=$(findmnt -n -o SOURCE /data)"; lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT
journalctl -b -u desk-firstboot --no-pager -o cat
X
cat $WORKDIR/o0 $WORKDIR/o1 > $WORKDIR/o2
chk_persist "data found and kept after root replacement (names printed below)"
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
for i in $(seq 1 300); do [ -e /var/lib/desk-preread/done ] && break; sleep 2; done
echo "after a root replacement: $(cat /var/lib/desk-preread/done 2>&1)"; journalctl -b -u desk-preread --no-pager -o cat | tail -1
[ -e /var/lib/desk-preread/done ] && [ "$(systemctl show desk-preread -p ConditionResult --value)" = yes ]
X
result "desk-preread runs again on a new root" $rc < $WORKDIR/o
cat $WORKDIR/o2 >> "$EV"
boot_timing "after a root replacement (a cold root, /data kept)"

# desk-firstboot decision tests on loop / device-mapper devices (the real volume is never touched)
# rc=$? has to be on the RS line. These three checks had rc=0 there and rc=$? after the heredoc, which read rc=0's own status, so they could never fail.
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq dmsetup >/dev/null 2>&1 || echo "NOTE: dmsetup not installed, device-mapper tests will fail"
cd /var/tmp; fail=0
FB=/usr/local/lib/ma/desk-firstboot
mk() { truncate -s ${2:-64M} $1.img; losetup -f --show $1.img; }
run() { MA_DATA_DEVICE=$1 MA_DATA_LABEL=ma-test MA_READY_WAIT=${RW:-8} MA_PROBE_GAP=1 MA_PROBE_RETRIES=2 $FB 2>&1; }
refused() { # refused <name> <dev>: must exit 1, say REFUSING, and not format
  out=$(run $2); r=$?
  if [ $r = 1 ] && grep -q "REFUSING TO FORMAT" <<<"$out" && ! grep -q "creating ext4" <<<"$out"; then echo "$1) refused as required (exit 1): $(grep -m1 REFUSING <<<"$out" | cut -c1-170)"; else echo "$1) BAD: exit $r: $out"; fail=1; fi; }
# a) ext4 with another label + marker
d=$(mk a); mkfs.ext4 -q -L foo $d; u=$(blkid -s UUID -o value $d)
mkdir -p /mnt/a; mount $d /mnt/a; echo keep > /mnt/a/m; umount /mnt/a
refused a $d
[ "$(blkid -s UUID -o value $d)" = "$u" ] && mount $d /mnt/a && [ "$(cat /mnt/a/m)" = keep ] && umount /mnt/a && echo "a) filesystem and marker intact" || { echo "a) BAD: changed"; fail=1; }
# a2) ext4 with the right label is reused without formatting
mkfs.ext4 -q -L ma-test $d; u=$(blkid -s UUID -o value $d)
out=$(run $d); [ $? = 0 ] && [ "$(blkid -s UUID -o value $d)" = "$u" ] && echo "a2) existing ma-test fs reused, UUID unchanged" || { echo "a2) BAD: $out"; fail=1; }
# b) partition table, no fs
d=$(mk b); printf 'label: gpt\n,\n' | sfdisk -q $d; partprobe $d 2>/dev/null; sig=$(wipefs -n $d | wc -l)
refused b $d; [ "$(wipefs -n $d | wc -l)" = "$sig" ] && echo "b) signatures unchanged" || { echo "b) BAD"; fail=1; }
# c) no signature but random bytes from offset 4096 (what a fresh EBS volume looks like): formatted
d=$(mk c); head -c 1048576 /dev/urandom | dd of=$d bs=4096 seek=1 conv=notrunc 2>/dev/null
out=$(run $d); [ $? = 0 ] && [ "$(blkid -p -s LABEL -o value $d)" = ma-test ] && echo "c) signature-less noisy device formatted once" || { echo "c) BAD: $out"; fail=1; }
# d) truly blank: formatted once, a second run reuses it
d=$(mk d); out=$(run $d); [ $? = 0 ] && grep -q "creating ext4" <<<"$out" && u=$(blkid -s UUID -o value $d) && out=$(run $d) && grep -q "NOT formatting" <<<"$out" && [ "$(blkid -s UUID -o value $d)" = "$u" ] && echo "d) blank formatted once; second run: NOT formatting, UUID unchanged" || { echo "d) BAD"; fail=1; }
# e) zeroed primary superblock, intact backups (4K blocks): blkid says nothing found, we must still refuse
d=$(mk e 512M); mkfs.ext4 -q -b 4096 -L precious $d; mkdir -p /mnt/e; mount $d /mnt/e; echo precious > /mnt/e/m; umount /mnt/e
bk=$(dd if=$d bs=4096 skip=32768 count=1 2>/dev/null | sha256sum)
dd if=/dev/zero of=$d bs=1M count=1 conv=notrunc 2>/dev/null; partprobe $d 2>/dev/null
blkid -p $d >/dev/null; echo "e) after zeroing the primary superblock: blkid -p exit $? (2 = looks blank to blkid), wipefs lines: $(wipefs -n $d | wc -l)"
refused e $d
[ "$(dd if=$d bs=4096 skip=32768 count=1 2>/dev/null | sha256sum)" = "$bk" ] && [ -z "$(head -c 1048576 $d | tr -d '\0')" ] && echo "e) backup superblock unchanged, first MiB still zero (not formatted)" || { echo "e) BAD: device modified"; fail=1; }
echo "e) the backup superblock still names the filesystem: $(dumpe2fs -h -o superblock=32768 -o blocksize=4096 $d 2>/dev/null | grep -i 'volume name') (journal and metadata in the zeroed MiB are damaged: a human runs e2fsck)"
# e2) same with 1K blocks
d=$(mk e2 128M); mkfs.ext4 -q -b 1024 -L precious $d; dd if=/dev/zero of=$d bs=1M count=1 conv=notrunc 2>/dev/null; partprobe $d 2>/dev/null
refused e2 $d
# f) read errors: whole device errors; and the first part reads fine but the backup-superblock area errors
dmsetup remove ma-err1 2>/dev/null; dmsetup remove ma-err2 2>/dev/null
dmsetup create ma-err1 --table "0 262144 error" && { RW=4 refused f1 /dev/mapper/ma-err1; }
d=$(mk g 256M); n=$(blockdev --getsz $d)
printf '0 204800 linear %s 0\n204800 %s error\n' $d $((n-204800)) | dmsetup create ma-err2 && { RW=4 refused f2 /dev/mapper/ma-err2; } || { echo "f2) BAD: dmsetup failed"; fail=1; }
# c2) noise with a stray 0xEF53 at a backup location but implausible superblock fields: still blank
d=$(mk c2 256M); head -c 4194304 /dev/urandom | dd of=$d bs=4096 seek=1 conv=notrunc 2>/dev/null
printf '\x53\xef' | dd of=$d bs=1 seek=$((134217728 + 56)) conv=notrunc 2>/dev/null; dd if=/dev/urandom bs=512 count=1 2>/dev/null | dd of=$d bs=512 seek=$((134217728/512)) skip=0 conv=notrunc 2>/dev/null; printf '\x53\xef' | dd of=$d bs=1 seek=$((134217728 + 56)) conv=notrunc 2>/dev/null
printf '\xff\xff\xff\xff' | dd of=$d bs=1 seek=$((134217728 + 24)) conv=notrunc 2>/dev/null
out=$(run $d); [ $? = 0 ] && grep -q "treating it as noise" <<<"$out" && echo "c2) stray 0xEF53 with implausible fields treated as noise, device formatted" || { echo "c2) BAD: $out"; fail=1; }
# h) simulated swap: claim the root is the DATA disk. The script must then pick the real root disk as "data" by
#    exclusion (never by nvme number), see that it is not an sdf volume / has content, and refuse. Nothing may be formatted.
realroot=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) | head -1); realdata=$(basename $(findmnt -n -o SOURCE /data))
echo "h) real layout: root disk $realroot, data disk $realdata (the simulation swaps them)"
mkdir -p /var/tmp/shim
printf '#!/bin/sh\n[ "$1" = -n ] && [ "$2" = -o ] && [ "$3" = SOURCE ] && [ "$4" = / ] && { echo /dev/%s; exit 0; }\nexec /usr/bin/findmnt "$@"\n' $realdata > /var/tmp/shim/findmnt
chmod +x /var/tmp/shim/*
before=$(blkid -s UUID -o value $(findmnt -n -o SOURCE /))
out=$(PATH=/var/tmp/shim:$PATH MA_READY_WAIT=8 MA_PROBE_GAP=1 MA_PROBE_RETRIES=2 $FB 2>&1); r=$?
echo "h) simulated swap: exit $r, full output:"; echo "$out" | sed 's/^/     | /' | cut -c1-300
[ $r = 1 ] && grep -q "data device: /dev/$realroot (root disk: /dev/$realdata)" <<<"$out" && grep -q "REFUSING" <<<"$out" && ! grep -q "creating ext4" <<<"$out" && [ "$(blkid -s UUID -o value $(findmnt -n -o SOURCE /))" = "$before" ] && echo "h) chose the other disk by root exclusion and refused, nothing formatted" || { echo "h) BAD"; fail=1; }
rm -rf /var/tmp/shim
# g) device not ready / missing
RW=4 refused g /dev/nvme9n1
dmsetup remove ma-err1 ma-err2 2>/dev/null; losetup -D; rm -f /var/tmp/*.img
echo "--- real volume untouched: UUID $(blkid -s UUID -o value $(findmnt -n -o SOURCE /data)) marker $(cat /data/marker)"
exit $fail
X
result "desk-firstboot: refuses ext4 other label, GPT, damaged-primary ext4 (4K and 1K), read errors, missing device; reuses ma-data fs; formats blank and noisy-blank once" $rc < $WORKDIR/o

# fresh EBS volume content (explains the noise that blocked 0.1.0): attach a second blank volume, read it, remove it
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
VOL2=$(aws ec2 create-volume --size 20 --volume-type gp3 --availability-zone "$AZ" --tag-specifications "$(tagspec volume)" --query VolumeId --output text)
aws ec2 wait volume-available --volume-ids "$VOL2"
aws ec2 attach-volume --volume-id "$VOL2" --instance-id "$INSTANCE_ID" --device /dev/sdg >/dev/null
aws ec2 wait volume-in-use --volume-ids "$VOL2"; sleep 8
{ echo "volume $VOL2: $(aws ec2 describe-volumes --volume-ids $VOL2 --query 'Volumes[0].[Size,VolumeType,Encrypted,KmsKeyId,SnapshotId,CreateTime]' --output text)"
  echo "account EBS encryption by default: $(aws ec2 get-ebs-encryption-by-default --query EbsEncryptionByDefault --output text)"
  RS <<'X'
dev=$(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}' | grep nvme | grep -v -e nvme0n1 -e nvme1n1 | head -1); echo "device $dev"
python3 - "$dev" <<'P'
import sys,hashlib
f=open(sys.argv[1],'rb',buffering=0)
def page(i): f.seek(i*4096); return f.read(4096)
nz=[i for i in range(16384) if page(i).strip(b'\0')]      # first 64 MiB
print("non-zero 4K pages in first 64 MiB:",len(nz),"first",nz[:5],"last",nz[-3:] if nz else [])
runs=[];
for i in nz:
    if runs and i==runs[-1][1]+1: runs[-1][1]=i
    else: runs.append([i,i])
print("runs of non-zero pages:",runs[:8])
a=hashlib.sha256(page(1)).hexdigest(); b=hashlib.sha256(page(1)).hexdigest(); print("page 1 read twice, identical:",a==b,a[:16])
import os
def nzm(m):
    f.seek(m*1048576); return bool(f.read(4096).strip(b'\0'))
samp=[(m,nzm(m)) for m in range(64,20480,256)]
print("sampled 1 page every 256 MiB beyond 64 MiB, non-zero at MiB:",[m for m,z in samp if z][:10],"of",len(samp),"samples")
f.seek(4096); print("hexdump of bytes 4096..4143:",f.read(48).hex())
P
X
} > $WORKDIR/o 2>&1
info "fresh blank EBS volume content probe" < $WORKDIR/o
aws ec2 detach-volume --volume-id "$VOL2" >/dev/null; aws ec2 wait volume-available --volume-ids "$VOL2"; aws ec2 delete-volume --volume-id "$VOL2"; VOL2=

# ---- 2. IMDS
RS <<'X' > $WORKDIR/o 2>&1; rc=0
imds() { # imds <uid> -> http code of the IMDSv2 token request
  setpriv --reuid=$1 --regid=$1 --clear-groups curl -s -o /dev/null -m 4 -w '%{http_code}' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token; }
for u in 0 1100 1101 1102 1103; do echo "uid $u -> HTTP $(imds $u) (exit $?)"; done
echo "--- host-network container"
docker pull public.ecr.aws/docker/library/alpine:3 2>&1 | tail -2 || docker pull alpine:3 2>&1 | tail -2
IMG=$(docker images -q public.ecr.aws/docker/library/alpine:3 | head -1); [ -n "$IMG" ] || IMG=$(docker images -q alpine:3 | head -1); echo "image: $IMG"   # not deskd's baked one
for u in 1100 1101; do
  echo -n "container --user $u:$u -> "
  docker run --rm --network host --user $u:$u $IMG sh -c 'wget -T 4 -O /dev/null --post-data="" http://169.254.169.254/latest/api/token 2>&1 | grep -q -i -E "unreachable|can.t connect|timed out" && echo BLOCKED || echo "OPEN (IMDS answered)"'
done
X
o=$(cat $WORKDIR/o)
for u in 0 1100; do echo "$o" | grep -q "^uid $u -> HTTP 200" || rc=1; done
for u in 1101 1102 1103; do echo "$o" | grep -q "^uid $u -> HTTP 000" || rc=1; done
echo "$o" | grep -q 'container --user 1100:1100 -> OPEN' && echo "$o" | grep -q 'container --user 1101:1101 -> BLOCKED' || rc=1
result "IMDS open for uid 0 and 1100 (also from host-network container), blocked for 1101-1103" $rc < $WORKDIR/o

# ---- 3. Chromium kiosk
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
systemctl is-enabled desk-xorg desk-audio desk-browser desk-stream 2>&1 | paste -sd' ' | sed 's/^/boot-enabled: /'
systemctl is-active desk-xorg desk-audio desk-browser | paste -sd' ' | sed 's/^/active before manual start: /'
systemctl start desk-browser || { echo "START FAILED"; journalctl -u desk-xorg -u desk-audio -u desk-browser --no-pager | tail -40; exit 1; }
# This runs on a fresh root, right after a root replacement, where Chromium can take a minute to get a renderer up.
for i in $(seq 1 180); do pgrep -u kiosk -f -- '--type=renderer' >/dev/null && break; sleep 1; done; echo "renderer up after $i s"
sleep 12
systemctl is-active desk-xorg desk-audio desk-browser | paste -sd' ' | sed 's/^/active: /'
echo "--- xrandr"; sudo -u kiosk env DISPLAY=:99 xrandr --current | head -3
echo "--- sandbox"
pgrep -a -u kiosk chromium | head -1 | cut -c1-200
if pgrep -u kiosk -af chromium | grep -q -e '--no-sandbox'; then echo "FOUND --no-sandbox"; exit 1; else echo "no --no-sandbox flag"; fi
r=$(pgrep -u kiosk -f -- '--type=renderer' | head -1)
echo "renderer pid $r: $(grep -E '^(Seccomp|NoNewPrivs):' /proc/$r/status | paste -sd' ')"
grep -q '^Seccomp:.2' /proc/$r/status || { echo "renderer has no seccomp filter"; exit 1; }
echo "renderer userns: $(readlink /proc/$r/ns/user) vs init $(readlink /proc/1/ns/user)"
echo "--- listeners"; ss -lntp | grep -E '9222|:99' 
cdpcode() { setpriv --reuid=$1 --regid=$1 --clear-groups curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:9222/json/version 2>&1; }
for i in $(seq 1 90); do [ "$(cdpcode 1100)" = 200 ] && break; sleep 1; done   # a fresh root can be slow to start Chromium
c1100=$(cdpcode 1100); c1102=$(cdpcode 1102); c1103=$(cdpcode 1103)
echo "--- CDP on 127.0.0.1:9222, desk(1100): $c1100, kiosk(1102): $c1102, agent(1103): $c1103 (000 is blocked)"
[ "$c1100" = 200 ] && [ "$c1102" = 000 ] && [ "$c1103" = 000 ] || { echo "BAD: 127.0.0.1 rule"; exit 1; }
echo "--- CDP from desk(1100): $(setpriv --reuid=1100 --regid=1100 --clear-groups curl -s -m 3 http://127.0.0.1:9222/json/list | jq -r '.[0].title')"
echo "--- the same rule on ::1, against a stand-in listener (Chromium itself is on 127.0.0.1)"
setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "
import socket,time
l=socket.socket(socket.AF_INET6); l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); l.bind(('::1',9222)); l.listen(4); time.sleep(6)" & LP6=$!
sleep 1
try6() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 -I -c "
import socket
try: socket.create_connection(('::1',9222),3); print('connected')
except OSError as e: print(type(e).__name__)"; }
r1100=$(try6 1100); r1102=$(try6 1102); r1103=$(try6 1103); wait $LP6
echo "::1:9222 from desk(1100): $r1100, kiosk(1102): $r1102, agent(1103): $r1103"
[ "$r1100" = connected ] && [ "$r1102" != connected ] && [ "$r1103" != connected ] || { echo "BAD: ::1 rule"; exit 1; }
echo "--- fonts for other languages"
for l in ja ko zh-cn ar hi th he ru; do n=$(fc-list ":lang=$l" family | wc -l); echo "$l: $n"; [ "$n" -gt 0 ] || { echo "BAD: no font for $l"; exit 1; }; done
echo "--- screenshot"
sudo -u kiosk env DISPLAY=:99 gst-launch-1.0 -q ximagesrc num-buffers=1 ! videoconvert ! video/x-raw,format=GRAY8 ! filesink location=/var/tmp/shot.gray
sudo -u kiosk env DISPLAY=:99 gst-launch-1.0 -q ximagesrc num-buffers=1 ! videoconvert ! pngenc ! filesink location=/var/tmp/shot.png
sz=$(stat -c %s /var/tmp/shot.gray); distinct=$(python3 -c "d=open('/var/tmp/shot.gray','rb').read(); print(len(set(d)))")
echo "gray bytes $sz (1920*1080=2073600), distinct gray levels $distinct, png $(stat -c %s /var/tmp/shot.png) bytes"
[ "$sz" = 2073600 ] && [ "$distinct" -gt 8 ] || { echo "screenshot wrong size or blank"; exit 1; }
chmod 644 /var/tmp/shot.png
X
result "Chromium kiosk on Xorg 1920x1080, sandbox on, screenshot not blank, CDP restricted to deskd" $rc < $WORKDIR/o
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP:/var/tmp/shot.png" "$HERE/evidence/screenshot-$AMI.png" 2>/dev/null && say "screenshot saved: image/evidence/screenshot-$AMI.png"

# ---- 3a0. The desk's sound is 48 kHz and stays there (task 46, sink-48k). The null sink and its monitor both report 48000 Hz,
# the server's default is 48000, and a suspend and resume of the sink changes none of it (an unpinned PulseAudio goes back
# to 44.1 kHz on resume, leaving the monitor at 48 kHz, which cost 0.3.1 8% of its sound). The check can fail: a control sink
# loaded at 44100 has to read back as 44100, or the parser proves nothing.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $*"; echo FAILED; }
pa() { setpriv --reuid=1102 --regid=1102 --clear-groups env PULSE_SERVER=unix:/run/desk-audio/native HOME=/run/desk-audio/pulse pactl "$@"; }
rate() { # rate <sinks|sources> <name>: the rate in the sample spec, or "none"
  pa -f json list "$1" 2>/dev/null | python3 -I -c '
import json, re, sys
n = sys.argv[1]
for d in json.load(sys.stdin):
    if d["name"] == n:
        m = re.search(r"(\d+)Hz", d["sample_specification"]); print(m.group(1) if m else "none"); break
else: print("none")' "$2"; }
state() { echo "sink $(rate sinks desk) Hz, monitor $(rate sources desk.monitor) Hz, server $(pa info | sed -n 's/^Default Sample Specification:.*[ ]\([0-9]*\)Hz.*/\1/p') Hz"; }
judge() { [ "$(rate sinks desk)" = 48000 ] && [ "$(rate sources desk.monitor)" = 48000 ] || bad "$1: the sink or its monitor isn't 48000 Hz"; }
echo "now: $(state)"; judge "on a fresh boot"
echo "daemon.conf.d: $(grep -h -E '^(default|alternate)-sample-rate' /etc/pulse/daemon.conf.d/*.conf | paste -sd' ')"
pa suspend-sink desk 1; sleep 1; pa suspend-sink desk 0; sleep 1
echo "after a suspend and resume: $(state)"; judge "after a suspend and resume"
# the control: a sink pinned at 44100 must read 44100 through the same parser, so a 48000 above means something
id=$(pa load-module module-null-sink sink_name=ctl44 rate=44100) || bad "couldn't load the control sink"
echo "control: sink $(rate sinks ctl44) Hz, monitor $(rate sources ctl44.monitor) Hz"
[ "$(rate sinks ctl44)" = 44100 ] && [ "$(rate sources ctl44.monitor)" = 44100 ] || bad "the check read the 44100 control as something else, so it can't fail"
[ -n "$id" ] && pa unload-module "$id"
[ "$(rate sinks ctl44)" = none ] || bad "control sink left loaded"
echo "default sink: $(pa get-default-sink)"; [ "$(pa get-default-sink)" = desk ] || bad "default sink isn't desk"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "sound is 48 kHz: the null sink and its monitor read 48000 Hz, also after a suspend and resume, the server's default is 48000, and a 44100 control sink reads back as 44100" $rc < $WORKDIR/o

# ---- 3a. Chromium tabs across restarts and a crash (design section 6.1). CDP is read as uid 1100, as deskd does.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
HOME_URL=file:///usr/local/share/ma/home.html; SECOND=file:///etc/hostname; BOTH="$SECOND $HOME_URL"   # urls() sorts, so /etc/ precedes /usr/
cdp() { setpriv --reuid=1100 --regid=1100 --clear-groups curl -s -m 3 "$@"; }
urls() { cdp http://127.0.0.1:9222/json/list | jq -r '[.[]|select(.type=="page")|.url]|sort|join(" ")'; }
count() { cdp http://127.0.0.1:9222/json/list | jq '[.[]|select(.type=="page")]|length'; }
upwait() { for i in $(seq 1 60); do [ "$(systemctl is-active desk-browser)" = active ] && [ "$(count 2>/dev/null)" -ge 1 ] 2>/dev/null && break; sleep 1; done; sleep 10; }  # 10 s: restored tabs register
want() { # want <name> <expected url list> ; checks the live tab list
  local got; got=$(urls); if [ "$got" = "$2" ] && ! grep -q 'chrome://' <<<"$got"; then echo "ok: $1 -> $(count) tab(s): $got"; else echo "BAD: $1 -> got '$got', wanted '$2'"; echo FAILED; fi; }
echo "--- 1. empty profile: first start shows the home page once"
systemctl stop desk-browser; find /data/browser/profile -mindepth 1 -delete; ls -A /data/browser/profile | wc -l | sed 's/^/profile entries after wipe: /'
systemctl start desk-browser; upwait; want "first start, empty profile" "$HOME_URL"
echo "command line: $(pgrep -u kiosk -af -- '--kiosk' | grep -v -e type= | head -1 | grep -o 'file://[^ ]*' | paste -sd' ' | sed 's/^$/(no URL)/')"
echo "--- 2. two plain restarts add nothing"
for n in 1 2; do systemctl restart desk-browser; upwait; want "after restart $n" "$HOME_URL"
  echo "   command line URL on this start: $(pgrep -u kiosk -af -- '--kiosk' | grep -v -e type= | head -1 | grep -o 'file://[^ ]*' | paste -sd' ' | sed 's/^$/(none)/')"; done
echo "--- 3. open a second tab, restart: exactly two, and again"
cdp -X PUT "http://127.0.0.1:9222/json/new?$SECOND" >/dev/null; sleep 6; want "second tab open" "$BOTH"
for n in 1 2; do systemctl restart desk-browser; upwait; want "two tabs, after restart $n" "$BOTH"; done
echo "--- 4. kill -9 of the main Chromium process: no prompt, same tabs"
sleep 6   # session saves are delayed a few seconds
echo "profile exit_type while running (a kill -9 leaves this): $(jq -r .profile.exit_type /data/browser/profile/Default/Preferences)"
P0=$(systemctl show -p MainPID --value desk-browser); systemctl kill -s KILL --kill-whom=main desk-browser; echo "killed pid $P0 with SIGKILL"
sleep 2; echo "unit right after the kill: $(systemctl is-active desk-browser) (Restart=on-failure, RestartSec=3)"
upwait; P1=$(systemctl show -p MainPID --value desk-browser); echo "new main pid $P1 (was $P0), restarts: $(systemctl show -p NRestarts --value desk-browser)"
[ "$P1" != "$P0" ] && [ "$P1" != 0 ] || { echo "BAD: not restarted"; echo FAILED; }
want "after kill -9" "$BOTH"
echo "top-level X windows: $(sudo -u kiosk env DISPLAY=:99 xwininfo -root -children 2>/dev/null | grep -c '^ *0x')  (a restore or profile-lock dialog would be an extra window)"
sudo -u kiosk env DISPLAY=:99 xwininfo -root -children 2>/dev/null | grep '^ *0x' | cut -c1-150
echo "Singleton* after crash start: $(ls /data/browser/profile | grep -c '^Singleton') files (made by the new process)"
journalctl -u desk-browser -b --no-pager -o cat | grep -i -E 'profile.*in use|restore|crash' | head -5
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
result "Chromium tabs: first start 1 tab; 2 restarts still 1; 2 tabs stay 2 over 2 restarts; kill -9 restores the same tabs, no prompt" $rc < $WORKDIR/o

# Background tabs (informational): does a hidden tab drop to 1 fps, is the visible one unaffected, what would turning throttling off cost?
RS <<'X' > $WORKDIR/o 2>&1
cat > /var/tmp/thr.py <<'P'
import http.server, sys, time
LOG = open('/var/tmp/thr.log', 'w', buffering=1)
PAGE = """<!doctype html><title>%(n)s</title><script>
let raf=0,tim=0,n="%(n)s",heavy=%(h)s;
function f(){raf++;requestAnimationFrame(f)} f();
setInterval(()=>{tim++; if(heavy){let t=performance.now(); while(performance.now()-t<4);}},16);
setInterval(()=>{new Image().src='/b?n='+n+'&raf='+raf+'&tim='+tim+'&vis='+document.visibilityState; raf=0; tim=0},1000);
</script>"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p, _, q = self.path.partition('?'); a = dict(x.split('=') for x in q.split('&') if x)
        if p == '/p':
            b = (PAGE % {'n': a['n'], 'h': 'true' if a['n'].startswith('A') else 'false'}).encode()
            self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        elif p != '/b':
            self.send_response(404); self.end_headers()
        else:
            LOG.write('%.1f %s raf=%s timers=%s %s\n' % (time.time(), a['n'], a['raf'], a['tim'], a['vis'])); self.send_response(204); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
P
python3 /var/tmp/thr.py & SRV=$!; sleep 1
cdp() { setpriv --reuid=1100 --regid=1100 --clear-groups curl -s -m 3 "$@"; }
upwait() { for i in $(seq 1 60); do [ "$(systemctl is-active desk-browser)" = active ] && cdp http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done; sleep 8; }
cpu() { local t=0 p; for p in $(pgrep -u kiosk); do t=$((t + $(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null || echo 0))); done; echo $t; }
phase() { # phase <label>: tab A heavy (hidden after B opens), tab B light and visible
  echo "=== $1"; : > /var/tmp/thr.log
  cdp -X PUT "http://127.0.0.1:9222/json/new?http://127.0.0.1:8765/p?n=A_heavy" >/dev/null; sleep 2
  cdp -X PUT "http://127.0.0.1:9222/json/new?http://127.0.0.1:8765/p?n=B_light" >/dev/null; sleep 14
  c0=$(cpu); sleep 20; c1=$(cpu); echo "Chromium CPU over 20 s with A hidden: $(awk -v t=$((c1-c0)) 'BEGIN{printf "%.1f", t/20}') % of one core ($((c1-c0)) ticks at 100 Hz)"
  echo "last 6 beacons per tab (raf = animation frames in the last second, timers = 16 ms timer ticks):"
  for t in A_heavy B_light; do grep -a " $t " /var/tmp/thr.log | tail -6 | sed 's/^/   /'; done
  echo "--- now activate A (it becomes visible, B hidden)"; : > /var/tmp/thr.log
  ida=$(cdp http://127.0.0.1:9222/json/list | jq -r '.[]|select(.title=="A_heavy")|.id'); cdp http://127.0.0.1:9222/json/activate/$ida >/dev/null; sleep 6
  for t in A_heavy B_light; do grep -a " $t " /var/tmp/thr.log | tail -3 | sed 's/^/   /'; done
  for id in $(cdp http://127.0.0.1:9222/json/list | jq -r '.[]|select(.url|test("127.0.0.1:8765"))|.id'); do cdp http://127.0.0.1:9222/json/close/$id >/dev/null; done; sleep 6
}
systemctl restart desk-browser; upwait
phase "default Chromium behaviour (the image)"
mkdir -p /etc/systemd/system/desk-browser.service.d
sed 's#exec /usr/bin/chromium#exec /usr/bin/chromium --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows#' /usr/local/lib/ma/desk-browser-start > /var/tmp/ws; chmod 755 /var/tmp/ws
printf '[Service]\nExecStart=\nExecStart=/var/tmp/ws\n' > /etc/systemd/system/desk-browser.service.d/test.conf; systemctl daemon-reload
systemctl restart desk-browser; upwait
phase "EXPERIMENT: timer throttling and renderer backgrounding switched off"
rm -rf /etc/systemd/system/desk-browser.service.d /var/tmp/ws; systemctl daemon-reload
kill $SRV; systemctl restart desk-browser; upwait
for id in $(cdp http://127.0.0.1:9222/json/list | jq -r '.[]|select(.url|test("127.0.0.1:8765"))|.id'); do cdp http://127.0.0.1:9222/json/close/$id >/dev/null; done; sleep 6
echo "restored to image defaults; tabs now: $(cdp http://127.0.0.1:9222/json/list | jq -r '[.[]|select(.type=="page")|.url]|join(" ")')"
X
info "background tabs: frame rate of hidden vs visible tab, and the CPU cost of switching throttling off" < $WORKDIR/o
cat $WORKDIR/o >&2

# ---- 3a1. keymap and viewport (runtime spec section 8.6). The spare list comes from desk-rtc's own source, so a Chromium that gives one a meaning fails here.
sed -n '/^var chromiumFreeCodes/,/^}/p' "$HERE/../desk-rtc/internal/xinput/spares.go" | grep -oE '[0-9]+' | R 'cat > /var/tmp/spares.txt'
RS <<'X' > $WORKDIR/o 2>&1; rc=0
cat > /var/tmp/kv.html <<'H'
<!doctype html><meta charset="utf-8"><title>K</title><style>html,body{margin:0;background:#fff}#t{position:fixed;left:760px;top:40px;width:400px;height:48px}</style><input id="t" autocomplete="off" spellcheck="false">
<script>
const t=document.getElementById('t'),q=location.search.includes('quiet'),s={id:Math.round(performance.timeOrigin)%100000,kd:0,c:'',k:'',kc:0,sh:0,v:'',ae:0,f:0,iw:0,ih:0,hl:0};
const p=()=>{s.v=t.value.slice(-20);s.ae=document.activeElement===t?1:0;s.f=document.hasFocus()?1:0;s.iw=innerWidth;s.ih=innerHeight;s.hl=history.length;document.title='K'+JSON.stringify(s)};
addEventListener('keydown',e=>{s.kd++;s.c=e.code;s.k=e.key;s.kc=e.keyCode;s.sh=e.shiftKey?1:0;if(q)e.preventDefault();p()},true);addEventListener('input',p,true);setInterval(p,50);p();
</script>
H
chmod 644 /var/tmp/kv.html
cat > /var/tmp/kv.py <<'P'
import html, json, re, subprocess, time, urllib.request
CDP = 'http://127.0.0.1:9222'
def x(*a): return subprocess.run(['sudo', '-u', 'kiosk', 'env', 'DISPLAY=:99', *a], capture_output=True, text=True, cwd='/tmp').stdout
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
def tabs(): return json.loads(get('/json/list'))
def state(q):
    for t in tabs():
        if t['type'] == 'page' and 'kv.html' + q in t['url']:
            s = html.unescape(t['title'])
            if s.startswith('K{'): return json.loads(s[1:])
    return None
def wait(q, ok, secs):
    end = time.time() + secs; s = None
    while time.time() < end:
        s = state(q) or s
        if s and ok(s): return s
        time.sleep(0.02)
    return s
def close():
    for t in tabs():
        if 'kv.html' in t['url']: get('/json/close/' + t['id'])
    time.sleep(0.3)
def fresh(q):
    close(); get('/json/new?file:///var/tmp/kv.html' + q, 'PUT')
    s = wait(q, lambda v: True, 15)
    for _ in range(30):
        x('xdotool', 'mousemove', '960', '64', 'click', '1')
        s = wait(q, lambda v: v['ae'] == 1 and v['f'] == 1, 0.4)
        if s and s['ae'] == 1 and s['f'] == 1: return s
    bad('the test page never got focus')
    return s
fails = 0
def bad(m):
    global fails; fails += 1; print('BAD:', m); print('FAILED')
def want(ok, m):
    print('ok:', m) if ok else bad(m)

# 1. the keymap
c = x('xkbcomp', ':99', '-')
kc = re.search(r'xkb_keycodes "([^"]*)"', c); sy = re.search(r'xkb_symbols "([^"]*)"', c)
want(kc and kc.group(1).startswith('evdev'), 'keycodes %s' % (kc and kc.group(1)))
want(sy and sy.group(1) == 'pc+us', 'symbols %s' % (sy and sy.group(1)))
want(re.search(r'"evdev"', x('xprop', '-root', '_XKB_RULES_NAMES')), '_XKB_RULES_NAMES says evdev')
hosts = x('xhost'); want('SI:localuser:rtc' in hosts and 'SI:localuser:stream' in hosts, 'rtc and stream have X access')

# 2. the viewport, on this start and after a restart
def viewport(label):
    s = fresh('')
    geo = x('xdotool', 'search', '--onlyvisible', '--classname', '/data/browser/profile').split()
    g = x('xdotool', 'getwindowgeometry', '--shell', geo[0]) if geo else ''
    want(s and s['iw'] == 1920 and s['ih'] == 1080, '%s: page %sx%s' % (label, s and s['iw'], s and s['ih']))
    want('WIDTH=1920' in g and 'HEIGHT=1080' in g, '%s: X window %s' % (label, ' '.join(g.split())))
    x('gst-launch-1.0', '-q', 'ximagesrc', 'num-buffers=1', '!', 'videoconvert', '!', 'video/x-raw,format=GRAY8', '!', 'filesink', 'location=/var/tmp/edge.gray')
    d = open('/var/tmp/edge.gray', 'rb').read(); w, h = 1920, 1080
    right = sum(d[y * w + w - 1] for y in range(h)) // h; bottom = sum(d[(h - 1) * w:h * w]) // w
    want(right > 250 and bottom > 250, '%s: the last column and row show the white page, not a black strip (averages %d, %d)' % (label, right, bottom))
viewport('this start')
subprocess.run(['systemctl', 'restart', 'desk-browser'])
for _ in range(60):
    try: get('/json/version'); break
    except OSError: time.sleep(1)
time.sleep(4)
viewport('after a restart')

# 3. named keys, printable ASCII and shifted characters report the right e.code and e.key
Q = '?quiet'
fresh(Q)
def press(*keys, code=None, key=None, shift=None):
    s0 = state(Q); x('xdotool', 'key', *keys)
    s = wait(Q, lambda v: v['kd'] > s0['kd'] and (key is None or v['k'] == key), 1.5)
    label = '+'.join(keys)
    if s['c'] != code or s['k'] != key or (shift is not None and s['sh'] != shift):
        bad('%s: e.code %r e.key %r shift %r, wanted %r %r %r' % (label, s['c'], s['k'], s['sh'], code, key, shift))
named = {'Escape': ('Escape', 'Escape'), 'BackSpace': ('Backspace', 'Backspace'), 'Tab': ('Tab', 'Tab'), 'Return': ('Enter', 'Enter'),
  'Home': ('Home', 'Home'), 'Up': ('ArrowUp', 'ArrowUp'), 'Prior': ('PageUp', 'PageUp'), 'Left': ('ArrowLeft', 'ArrowLeft'), 'Right': ('ArrowRight', 'ArrowRight'),
  'End': ('End', 'End'), 'Down': ('ArrowDown', 'ArrowDown'), 'Next': ('PageDown', 'PageDown'), 'Insert': ('Insert', 'Insert'), 'Delete': ('Delete', 'Delete'),
  'Pause': ('Pause', 'Pause'), 'Menu': ('ContextMenu', 'ContextMenu'), 'Print': ('PrintScreen', 'PrintScreen'), 'Scroll_Lock': ('ScrollLock', 'ScrollLock'),
  'Shift_L': ('ShiftLeft', 'Shift'), 'Shift_R': ('ShiftRight', 'Shift'), 'Control_L': ('ControlLeft', 'Control'), 'Control_R': ('ControlRight', 'Control'),
  'Alt_L': ('AltLeft', 'Alt'), 'Alt_R': ('AltRight', 'Alt'), 'Super_L': ('MetaLeft', 'Meta')}
for i in range(1, 11): named['F%d' % i] = ('F%d' % i, 'F%d' % i)
n0 = fails
for k, (code, key) in named.items():
    press(k, code=code, key=key)
    x('xdotool', 'mousemove', '960', '64', 'click', '1'); wait(Q, lambda v: v['ae'] == 1 and v['f'] == 1, 1)
want(fails == n0, '%d named keys: right e.code and e.key' % len(named))
n0 = fails; keys = 0
row = [('grave', '`', '~', 'Backquote'), ('minus', '-', '_', 'Minus'), ('equal', '=', '+', 'Equal'), ('bracketleft', '[', '{', 'BracketLeft'), ('bracketright', ']', '}', 'BracketRight'),
  ('backslash', '\\', '|', 'Backslash'), ('semicolon', ';', ':', 'Semicolon'), ('apostrophe', "'", '"', 'Quote'), ('comma', ',', '<', 'Comma'), ('period', '.', '>', 'Period'), ('slash', '/', '?', 'Slash')]
for i, shifted in enumerate(')!@#$%^&*('): row.append((str(i), str(i), shifted, 'Digit%d' % i))
for l in 'abcdefghijklmnopqrstuvwxyz': row.append((l, l, l.upper(), 'Key' + l.upper()))
for name, base, shifted, code in row:
    press(name, code=code, key=base, shift=0); press('shift+' + name, code=code, key=shifted, shift=1); keys += 2
press('space', code='Space', key=' ', shift=0); keys += 1
want(fails == n0, '%d printable ASCII and shifted characters: right e.code, e.key and shift' % keys)

# 4. every spare code: empty in the keymap, no meaning to Chromium, types what's put on it, does nothing else. Keydown isn't cancelled here.
spares = [int(v) for v in open('/var/tmp/spares.txt').read().split()]
pke = dict(re.findall(r'^keycode\s+(\d+) =(.*)$', x('xmodmap', '-pke'), re.M))
n0 = fails
for c in spares:
    if pke.get(str(c), '').strip(): bad('spare code %d is not empty in the keymap: %s' % (c, pke[str(c)]))
s = fresh('')
for c in spares:
    print('spare code', c, flush=True)
    s0 = state('')
    x('xmodmap', '-e', 'keycode %d = eacute eacute eacute eacute' % c); time.sleep(0.1)
    x('xdotool', 'key', str(c))
    s = wait('', lambda v: v['kd'] > s0['kd'] and v['v'].endswith('é'), 1)
    time.sleep(0.1); s = state('') or s
    x('xmodmap', '-e', 'keycode %d =' % c)
    if s is None or s['id'] != s0['id'] or s['hl'] != s0['hl'] or s['f'] != 1 or s['ae'] != 1 or s['c'] != '' or s['kc'] != 0 or s['v'] != (s0['v'] + 'é')[-20:] or s['kd'] != s0['kd'] + 1:
        bad('spare code %d: %r after %r' % (c, s, s0)); s = fresh('')
    elif len(s['v']) >= 20:
        x('xdotool', 'key', 'ctrl+a', 'BackSpace'); wait('', lambda v: v['v'] == '', 1)
want(fails == n0, '%d spare codes: e.code empty, keyCode 0, typed the keysym, no reload, navigation or lost focus' % len(spares))
# The control: a code left out because it has a meaning still shows it, so the check above can see one.
s0 = fresh(''); x('xmodmap', '-e', 'keycode 181 = eacute eacute eacute eacute'); time.sleep(0.1); x('xdotool', 'key', '181')
s = wait('', lambda v: v['id'] != s0['id'], 3); x('xmodmap', '-e', 'keycode 181 =')
want(s and s['id'] != s0['id'], 'control: a keysym on 181 (BrowserRefresh) reloads the page')
close()
print('failures:', fails)
P
python3 -I /var/tmp/kv.py
# Thousands of requests just ran. Chromium's side of each should have closed. One left in LAST-ACK hangs a new connection from its port.
sleep 1; n=$(ss -H -tan state last-ack 'sport = :9222' | wc -l); echo "LAST-ACK sockets on 9222 after all of that: $n"; [ "$n" = 0 ] || echo FAILED
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^failures: 0$' $WORKDIR/o || rc=1
result "keymap and viewport: evdev keycodes, named keys, ASCII and shifted right; every spare code means nothing to Chromium; page exactly 1920x1080, no black strip" $rc < $WORKDIR/o

# ---- 3a2. Japanese, Korean and Chinese pages render with real glyphs, not boxes (W3 found boxes on 0.2.2, which had no CJK
# font). fc-list in the kiosk check only says a font is installed; this asks Chromium which fonts drew each line
# (CSS.getPlatformFontsForNode over CDP, as root, which the 9222 rule allows) and keeps a screenshot of the page.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
cat > /var/tmp/cjk.html <<'H'
<!doctype html><html lang="ja"><meta charset="utf-8"><title>CJK</title>
<body style="margin:40px;background:#fff;color:#000;font:64px sans-serif">
<p id="ja" lang="ja">日本語の文字化けテストひらがなカタカナ漢字</p>
<p id="ko" lang="ko">한국어글자깨짐시험</p>
<p id="zh" lang="zh-CN">简体中文显示测试</p>
</body></html>
H
chmod 644 /var/tmp/cjk.html
systemctl start desk-browser
for i in $(seq 1 60); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 1; done
for l in ja ko zh-cn; do f=$(fc-match -f '%{file}' "sans-serif:lang=$l"); echo "fc-match sans-serif:lang=$l: $(fc-match "sans-serif:lang=$l" family), $f, $(($(stat -c %s "$f") / 1048576)) MiB, in desk-preread's list: $(grep -qxF "$f" /usr/local/share/ma/preread.list && echo yes || echo no)"; done
echo "fonts-noto-cjk installed: $(dpkg-query -W -f='${Installed-Size}' fonts-noto-cjk) KiB"
cat > /var/tmp/cjk.py <<'P'
import base64, json, os, socket, struct, sys, time, urllib.request
CDP = 'http://127.0.0.1:9222'
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
class WS:  # just enough of RFC 6455 for CDP: no Origin header, so Chromium doesn't ask for --remote-allow-origins
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(30); self.n = 0
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key)).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf: self.buf += self.s.recv(4096)
        head, self.buf = self.buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]: raise RuntimeError(head[:80])
    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]; return out
    def recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2); ln = b1 & 0x7f
            if ln == 126: ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127: ln = struct.unpack('>Q', self._read(8))[0]
            if b1 & 0x80: self._read(4)
            data = self._read(ln); op = b0 & 0x0f
            if op == 8: raise EOFError
            if op in (9, 10): continue
            msg += data
            if b0 & 0x80: return msg
    def call(self, method, **params):
        self.n += 1; i = self.n; data = json.dumps({'id': i, 'method': method, 'params': params}).encode(); mask = os.urandom(4)
        n = len(data); hdr = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        while True:
            m = json.loads(self.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError('%s: %s' % (method, m['error']))
                return m['result']
fails = 0
t0 = time.time(); t = json.loads(get('/json/new?file:///var/tmp/cjk.html', 'PUT'))
try:
    ws = WS(t['webSocketDebuggerUrl'])
    for _ in range(150):
        r = ws.call('Runtime.evaluate', expression='document.readyState=="complete"&&document.fonts.status=="loaded"', returnByValue=True)
        if r['result'].get('value'): break
        time.sleep(0.1)
    print('new tab to page and fonts loaded: %.2f s (the first CJK page since boot reads its font off the root)' % (time.time() - t0))
    time.sleep(1)
    ws.call('DOM.enable'); ws.call('CSS.enable')
    root = ws.call('DOM.getDocument')['root']['nodeId']
    for sel in ('#ja', '#ko', '#zh'):
        nid = ws.call('DOM.querySelector', nodeId=root, selector=sel)['nodeId']
        text = ws.call('Runtime.evaluate', expression='document.querySelector("%s").textContent' % sel, returnByValue=True)['result']['value']
        fonts = ws.call('CSS.getPlatformFontsForNode', nodeId=nid)['fonts']
        cjk = sum(f['glyphCount'] for f in fonts if 'CJK' in f['familyName']); other = [f for f in fonts if 'CJK' not in f['familyName']]
        ok = cjk == len(text) and not other
        print('%s %s: %d characters; drawn by %s' % ('ok:' if ok else 'BAD:', sel, len(text), ', '.join('%s (%d glyphs)' % (f['familyName'], f['glyphCount']) for f in fonts)))
        if not ok: fails += 1
    shot = ws.call('Page.captureScreenshot', format='png')['data']
    open('/var/tmp/cjk.png', 'wb').write(base64.b64decode(shot)); os.chmod('/var/tmp/cjk.png', 0o644)
    print('screenshot: /var/tmp/cjk.png, %d bytes' % os.path.getsize('/var/tmp/cjk.png'))
except Exception as e:
    print('BAD:', type(e).__name__, e); fails += 1
finally:
    get('/json/close/' + t['id'])
print('failures:', fails)
P
python3 -I /var/tmp/cjk.py
X
grep -q '^failures: 0$' $WORKDIR/o || rc=1
result "CJK pages: Japanese, Korean and Chinese lines drawn only by a Noto CJK font, every character a real glyph, screenshot kept" $rc < $WORKDIR/o
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP:/var/tmp/cjk.png" "$HERE/evidence/cjk-$AMI.png" 2>/dev/null && say "CJK screenshot saved: image/evidence/cjk-$AMI.png"

# ---- 3a3. X access (DA-1): Xorg starts with -auth and a cookie only kiosk holds, and -nolisten local. Only kiosk, rtc and
# stream are admitted (by uid, SI:localuser); deskd (1100), desk-agent (1103) and desk-notebook (1105) are refused on the
# socket file, and the abstract socket, which host networking would let them reach, isn't there.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $1"; echo FAILED; }
pgrep -a -u kiosk Xorg | cut -c1-220
pgrep -a -u kiosk Xorg | grep -q -- '-nolisten local' && pgrep -a -u kiosk Xorg | grep -q -- '-auth /run/desk-xorg/auth' || bad "Xorg runs without -auth or -nolisten local"
echo "cookie: $(stat -c '%U:%G %a %s bytes' /run/desk-xorg/auth 2>&1)"
[ "$(stat -c '%U:%G %a' /run/desk-xorg/auth 2>&1)" = "kiosk:kiosk 600" ] || bad "the cookie isn't kiosk's alone"
echo "xhost: $(sudo -u kiosk env DISPLAY=:99 xhost 2>&1 | paste -sd' ')"
cat > /var/tmp/xprobe.py <<'P'
import socket, struct
def setup(where):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(5)
    try:
        s.connect(where)
    except OSError as e:
        return type(e).__name__
    s.sendall(b'l\x00' + struct.pack('<HHHH', 11, 0, 0, 0) + b'\x00\x00')   # connection setup, no authorisation
    r = s.recv(8)
    return {0: 'refused', 1: 'connected', 2: 'authenticate'}.get(r[0], 'odd') if r else 'closed'
print('file', setup('/tmp/.X11-unix/X99'), 'abstract', setup('\0/tmp/.X11-unix/X99'))
P
for u in 1100 1103 1105 1101 1104 1102 0; do
  r=$(setpriv --reuid=$u --regid=$u --clear-groups python3 -I /var/tmp/xprobe.py 2>&1); echo "uid $u: $r"
  case $u in
    1100|1103|1105) [ "$r" = "file refused abstract ConnectionRefusedError" ] || bad "uid $u reaches X" ;;
    1101|1104|1102) [ "$r" = "file connected abstract ConnectionRefusedError" ] || bad "uid $u should connect on the socket file only" ;;
  esac
done
echo "cookie read as 1103: $(setpriv --reuid=1103 --regid=1103 --clear-groups cat /run/desk-xorg/auth 2>&1 >/dev/null | sed 's/.*: //')"
setpriv --reuid=1103 --regid=1103 --clear-groups cat /run/desk-xorg/auth >/dev/null 2>&1 && bad "uid 1103 reads the cookie"
rm -f /var/tmp/xprobe.py
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "X access (DA-1): Xorg with -auth (a cookie 0600 kiosk) and -nolisten local; uids 1100, 1103 and 1105 refused on the socket file and no abstract socket; kiosk, rtc and stream connect" $rc < $WORKDIR/o

# ---- 3b. unit control (runtime spec section 8.3)
RS <<'X' > $WORKDIR/o 2>&1; rc=0
cat > /var/tmp/ask.py <<'P'
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode()+b'\n'); print(s.recv(300).decode().strip())
P
chmod 644 /var/tmp/ask.py
as() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 /var/tmp/ask.py "$2" 2>&1 | tail -1; }
want() { case "$2" in "$1"*) echo "ok: $3 -> $2" ;; *) echo "BAD: $3 -> $2 (wanted $1)"; echo FAILED ;; esac; }
stat -c '%U:%G %a %n' /run/desk/units.sock
[ "$(stat -c '%U:%G %a' /run/desk/units.sock)" = "desk:desk 600" ] || { echo "BAD: socket owner or mode"; echo FAILED; }
systemctl is-enabled desk-units.socket; systemctl is-active desk-units.socket
want "PermissionError" "$(as 1103 'start desk-xorg')" "agent (socket mode)"
want "PermissionError" "$(as 1102 'start desk-xorg')" "kiosk (socket mode)"
want "err denied" "$(python3 /var/tmp/ask.py 'stop desk-xorg')" "root, wrong uid in SO_PEERCRED"
want "err denied" "$(as 1100 'stop ssh')" "another unit"
want "err denied" "$(as 1100 'start desk-rtc')" "desk-rtc is not on the list"
want "err bad_request" "$(as 1100 'restart desk-xorg')" "another verb"
want "err bad_request" "$(as 1100 'start desk-xorg;reboot')" "shell metacharacters"
want "err bad_request" "$(as 1100 "start $(head -c 80 /dev/zero | tr '\0' a)")" "over 64 bytes"
want "ok" "$(as 1100 'stop desk-browser')" "stop desk-browser"
[ "$(systemctl is-active desk-browser)" = inactive ] || { echo "BAD: desk-browser still running"; echo FAILED; }
want "ok" "$(as 1100 'start desk-browser')" "start desk-browser"
[ "$(systemctl is-active desk-browser)" = active ] || { echo "BAD: desk-browser not running"; echo FAILED; }
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
result "units.sock: only uid 1100, only start, stop, freeze and thaw, only the four units (freeze and thaw: 3b2a)" $rc < $WORKDIR/o

# ---- 3b1. Chromium downgrade guard (ADR 0035). Refuses, doesn't loop, leaves the profile alone, and recovers.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
P=/data/browser/profile
as() { setpriv --reuid=1100 --regid=1100 --clear-groups python3 /var/tmp/ask.py "$1" 2>&1 | tail -1; }
hash() { (cd "$P" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
bad() { echo "BAD: $1"; echo FAILED; }
systemctl stop desk-browser; sleep 1
real=$(cat "$P/Last Version"); echo "Last Version: $real, installed: $(dpkg-query -W -f='${Version}' chromium)"
printf 999.0.0.0 > "$P/Last Version"; chown kiosk:kiosk "$P/Last Version"
h0=$(hash); r=$(as 'start desk-browser'); echo "units.sock: $r"
case "$r" in "err failed start desk-browser: "*"newer than the installed"*) ;; *) bad "units.sock didn't refuse" ;; esac
systemctl start desk-browser; sleep 10
show=$(systemctl show -p ActiveState,Result,ExecMainStatus,NRestarts desk-browser | sort | paste -sd' '); echo "direct start, 10 s later: $show"
[ "$show" = "ActiveState=failed ExecMainStatus=78 NRestarts=0 Result=exit-code" ] || bad "the unit should fail with 78 and not restart"
pgrep -u kiosk -f /usr/lib/chromium >/dev/null && bad "Chromium ran"
journalctl -u desk-browser -b --no-pager -o cat | grep -m1 'REFUSING TO START' || bad "no journal line"
[ "$(hash)" = "$h0" ] && echo "profile hash unchanged: $h0" || bad "the profile changed"
systemctl reset-failed desk-browser
printf '%s' "$real" > "$P/Last Version"; chown kiosk:kiosk "$P/Last Version"
r=$(as 'start desk-browser'); echo "after putting it back: $r"; [ "$r" = ok ] || bad "didn't start again"
for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done
[ "$(systemctl is-active desk-browser)" = active ] || bad "not running"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "Chromium downgrade guard: refused over units.sock and directly, exit 78, no restart loop, journal line, profile unchanged, starts once it's right" $rc < $WORKDIR/o

# ---- 3b2. A real cookie through a crash and a clean restart (ADR 0035). e2e/tests/browser-session.spec.ts covers more, on the test desk.
cat > $WORKDIR/sv.py <<'P'
import http.server, json, shutil, sqlite3, sys, time, urllib.request
CDP = 'http://127.0.0.1:9222'; B = 'http://127.0.0.1:18766'
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()   # a fresh root is slow, not broken
def visit(path):
    t = json.loads(get('/json/new?' + B + path, 'PUT')); title = ''
    for _ in range(40):   # every page here is titled C[...], so wait for that, up to 20 s, instead of a fixed time
        time.sleep(0.5); title = next((x['title'] for x in json.loads(get('/json/list')) if x['id'] == t['id']), '')
        if title.startswith('C['): break
    get('/json/close/' + t['id']); return title
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html')
        if self.path == '/p': self.send_header('Set-Cookie', 'v_persist=1; Max-Age=86400; Path=/; HttpOnly')
        if self.path == '/s': self.send_header('Set-Cookie', 'v_session=1; Path=/; HttpOnly')
        b = ('<title>C[%s]</title>' % self.headers.get('Cookie', '')).encode(); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
if sys.argv[1] == 'serve': http.server.ThreadingHTTPServer(('127.0.0.1', 18766), H).serve_forever()
if sys.argv[1] == 'seed': visit('/p'); visit('/s'); visit('/verify-hist')
c = visit('/echo'); shutil.copy('/data/browser/profile/Default/History', '/var/tmp/h.db'); d = sqlite3.connect('/var/tmp/h.db'); n = d.execute("select count(*) from urls where url like '%verify-hist%'").fetchone()[0]; d.close()
# History commits on a timer, so right after seeding its count is printed and not judged. Every later read judges it.
print(sys.argv[2] if len(sys.argv) > 2 else sys.argv[1], c, 'history', n); ok = 'v_persist=1' in c and 'v_session=1' in c and (n > 0 or sys.argv[1] == 'seed')
print('ok' if ok else 'BAD'); print('' if ok else 'FAILED')
P
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $WORKDIR/sv.py "admin@$IP:/var/tmp/sv.py" >/dev/null
RS <<'X' > $WORKDIR/o 2>&1; rc=0
up() { for i in $(seq 1 90); do [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done; sleep 10; }
chmod 644 /var/tmp/sv.py; systemd-run --quiet --collect --unit=verify-pages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/sv.py serve; sleep 1
python3 -I /var/tmp/sv.py seed; sleep 35   # Chromium commits cookies every 30 s
python3 -I /var/tmp/sv.py read "before anything"
systemctl kill -s KILL --kill-whom=main desk-browser; sleep 5; up; python3 -I /var/tmp/sv.py read "after kill -9"
systemctl restart desk-browser; up; python3 -I /var/tmp/sv.py read "after a clean restart"
X
grep -q -e '^FAILED$' -e '^BAD$' $WORKDIR/o && rc=1
[ "$(grep -c '^ok$' $WORKDIR/o)" = 4 ] || rc=1   # a read that crashed prints neither ok nor BAD
result "browser session: persistent and session cookies and history survive kill -9 and a clean restart" $rc < $WORKDIR/o

# ---- 3b2a. Freezing an unseen desk's Chromium (ADR 0045; image/README.md, "Freezing an unseen desk"). deskd asks
# desk-units for freeze and thaw desk-browser; here uid 1100 asks units.sock directly, as deskd does. desk-units writes the
# cgroup's own cgroup.freeze (systemd's FreezerState stays "running"), and desk-browser-thaw.service thaws it before any stop.
# Runs after 3b2, so Chromium is up with 3b2's cookies and history, and puts back the tabs it found. Every freeze and thaw
# is timed, and the times are printed at the end. Each check here has been seen to fail with what it guards broken
# (docs/sub-status/desk-units-freeze.md; item 13's, T46L-1's: docs/sub-status/freeze-race.md).
cat > $WORKDIR/fz.py <<'P'
# verify.sh section 3b2a's helper (ADR 0045). One file, run as the uid each mode needs:
#   root:   serve (as nobody, through systemd-run), open, close, urls, setcookie, cookie  (CDP on 127.0.0.1:9222)
#   kiosk:  pixels                                                                  (X on :99)
#   desk:   ask, thawtime                                                           (units.sock)
#   any:    blast (UDP to the default gateway's discard port, so the desk's outside interface moves bytes with no one
#           outside involved; the address isn't printed)
import base64, ctypes, http.server, io, json, math, os, socket, struct, sys, time, urllib.request, wave

CDP = 'http://127.0.0.1:9222'
PAGES = 'http://127.0.0.1:18767'
FRAME = b"""<!doctype html><title>fz-frame</title><style>html,body{margin:0;height:100%}</style><body><script>
let n = 0; (function f() { n++; document.body.style.background = n & 1 ? '#000' : '#fff'; requestAnimationFrame(f); })();
</script>"""
AUDIO = b"""<!doctype html><title>fz-audio</title><audio id=a src=/tone.wav loop></audio>"""


def tone():
    b = io.BytesIO()
    with wave.open(b, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(2 * math.pi * 440 * i / 48000))) for i in range(96000)))
    return b.getvalue()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        ctype, body, extra = 'text/html', b'', []
        if self.path.startswith('/set/'):
            v = self.path[5:]
            if not v.isalnum(): self.send_error(400); return
            extra = [('Set-Cookie', 'fz_persist=%s; Max-Age=86400; Path=/; HttpOnly' % v), ('Set-Cookie', 'fz_session=%s; Path=/; HttpOnly' % v)]
            body = b'<title>C[set]</title>'
        elif self.path == '/echo': body = ('<title>C[%s]</title>' % self.headers.get('Cookie', '')).encode()
        elif self.path == '/frame': body = FRAME
        elif self.path == '/audio': body = AUDIO
        elif self.path == '/tone.wav': ctype, body = 'audio/wav', TONE
        else: self.send_error(404); return
        self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        for k, v in extra: self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)


def get(p, m='GET', timeout=60): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=timeout).read()   # a Chromium just restored can be slow
def pages(): return [x for x in json.loads(get('/json/list')) if x['type'] == 'page']


def open_tab(path, want_title):
    t = json.loads(get('/json/new?' + PAGES + path, 'PUT')); title = ''
    for _ in range(60):
        time.sleep(0.25); title = next((x['title'] for x in pages() if x['id'] == t['id']), '')
        if title.startswith(want_title): break
    return t, title


class WS:  # just enough of RFC 6455 for CDP, as in this script's other sections
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(30); self.n = 0
        self.s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n'
                        'Sec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, base64.b64encode(os.urandom(16)).decode())).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf: self.buf += self.s.recv(4096)
        head, self.buf = self.buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]: raise RuntimeError(head[:80])
    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]; return out
    def recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2); ln = b1 & 0x7f
            if ln == 126: ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127: ln = struct.unpack('>Q', self._read(8))[0]
            if b1 & 0x80: self._read(4)
            data = self._read(ln); op = b0 & 0x0f
            if op == 8: raise EOFError
            if op in (9, 10): continue
            msg += data
            if b0 & 0x80: return msg
    def call(self, method, **params):
        self.n += 1; i = self.n; data = json.dumps({'id': i, 'method': method, 'params': params}).encode(); mask = os.urandom(4)
        n = len(data); hdr = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        while True:
            m = json.loads(self.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError('%s: %s' % (method, m['error']))
                return m['result']


def evaluate(tab_id, expr):
    """In the page, as if the member had clicked (userGesture), so a sound may start."""
    ws = WS(next(x['webSocketDebuggerUrl'] for x in pages() if x['id'] == tab_id))
    r = ws.call('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True, userGesture=True)
    ws.s.close(); return r['result'].get('value')


def ask(line):
    t0 = time.monotonic_ns(); s = socket.socket(socket.AF_UNIX); s.settimeout(60); s.connect('/run/desk/units.sock')
    s.sendall(line.encode() + b'\n'); r = s.recv(300).decode().strip(); t1 = time.monotonic_ns(); s.close()
    return r, t0, t1


def pixels(x, y, seconds):
    X = ctypes.CDLL('libX11.so.6')
    X.XOpenDisplay.restype = ctypes.c_void_p; X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XDefaultRootWindow.restype = ctypes.c_ulong; X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    X.XGetImage.restype = ctypes.c_void_p
    X.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
    X.XGetPixel.restype = ctypes.c_ulong; X.XGetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    X.XDestroyImage.argtypes = [ctypes.c_void_p]
    d = X.XOpenDisplay(b':99')
    if not d: print('no display'); sys.exit(1)
    root = X.XDefaultRootWindow(d); last = None; end = time.monotonic() + seconds; n = 0
    while time.monotonic() < end:
        img = X.XGetImage(d, root, x, y, 1, 1, 0xffffffff, 2); p = X.XGetPixel(img, 0, 0); X.XDestroyImage(img); n += 1
        if p != last: print(time.monotonic_ns(), p, flush=True); last = p
        time.sleep(0.0005)
    print('samples', n, flush=True)


def blast(seconds, rate):
    gw = next(socket.inet_ntoa(bytes.fromhex(c[2])[::-1]) for c in (l.split() for l in open('/proc/net/route'))
              if len(c) > 7 and c[1] == '00000000' and c[7] == '00000000')
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); end = time.monotonic() + seconds; n = 0; chunk = bytes(1000)
    while time.monotonic() < end: s.sendto(chunk, (gw, 9)); n += len(chunk); time.sleep(len(chunk) / rate)
    print('sent %d bytes in %.0f s' % (n, seconds))


def changes(log, after, before):
    out = []
    for line in open(log):
        f = line.split()
        if len(f) == 2 and f[0].isdigit() and after < int(f[0]) < before: out.append(int(f[0]))
    return out


def pct(v, p): v = sorted(v); return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def thawtime(n, log, hold):
    """n cycles of freeze, hold, thaw. The picture must stand still while frozen and move again after the thaw."""
    fr, th, frame, still, bad, retried = [], [], [], 0, 0, 0
    for i in range(n):
        for _ in range(6):   # the desk's own traffic can make a freeze busy network: deskd asks again later, and so does this
            r, a0, a1 = ask('freeze desk-browser')
            if r != 'err busy network': break
            retried += 1; time.sleep(3)
        if r != 'ok': print('freeze said', r); bad += 1; continue
        time.sleep(hold)
        r, b0, b1 = ask('thaw desk-browser')
        if r != 'ok': print('thaw said', r); bad += 1; continue
        time.sleep(0.6)
        moved = changes(log, a1 + 200_000_000, b0)   # 200 ms after the freeze's ok, until the thaw is asked
        first = changes(log, b0, b0 + 600_000_000)
        if moved: still += 1; print('cycle %d: the picture moved %d times while frozen' % (i, len(moved)))
        if not first: print('cycle %d: no frame within 600 ms of the thaw' % i); bad += 1; continue
        fr.append((a1 - a0) / 1e6); th.append((b1 - b0) / 1e6); frame.append((first[0] - b0) / 1e6)
    for name, v in (('freeze request', fr), ('thaw request', th), ('thaw request to first page frame', frame)):
        if v: print('%s: n=%d p50 %.0f ms, p95 %.0f ms, max %.0f ms' % (name, len(v), pct(v, 50), pct(v, 95), max(v)))
    print('cycles %d, failed %d, moved while frozen %d, freezes asked again after busy network %d' % (n, bad, still, retried))
    return frame, bad, still


if __name__ == '__main__':
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == 'serve': TONE = tone(); http.server.ThreadingHTTPServer(('127.0.0.1', 18767), H).serve_forever()
    elif mode == 'open': t, title = open_tab(args[0], args[1]); print(t['id'], title)
    elif mode == 'close': get('/json/close/' + args[0])
    elif mode == 'closeurl':
        for x in pages():
            if x['url'] == PAGES + args[0]: get('/json/close/' + x['id'])
    elif mode == 'eval': print(json.dumps(evaluate(args[0], args[1])))
    elif mode == 'urls': print(' '.join(sorted(x['url'] for x in pages())))
    elif mode == 'setcookie':
        t, title = open_tab('/set/' + args[0], 'C['); get('/json/close/' + t['id']); print('set', args[0], title)
    elif mode == 'cookie':
        t, title = open_tab('/echo', 'C['); get('/json/close/' + t['id'])
        ok = ('fz_persist=%s' % args[0]) in title and ('fz_session=%s' % args[0]) in title
        print(args[1] if len(args) > 1 else '', 'cookies on the page:', title); print('ok' if ok else 'BAD')
    elif mode == 'blast': blast(float(args[0]), float(args[1]))
    elif mode == 'pixels': pixels(int(args[0]), int(args[1]), float(args[2]))
    elif mode == 'ask':
        r, t0, t1 = ask(args[0]); print(r); print('%s: %.0f ms' % (args[0], (t1 - t0) / 1e6), file=sys.stderr)
    elif mode == 'thawtime':
        frame, bad, still = thawtime(int(args[0]), args[1], float(args[2]))
        limit = float(args[3]) if len(args) > 3 else 300
        print('ok' if frame and not bad and not still and pct(frame, 95) <= limit else 'BAD')
P
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $WORKDIR/fz.py "admin@$IP:/var/tmp/fz.py" >/dev/null
RS <<'X' > $WORKDIR/o 2>&1; rc=0
CG=/sys/fs/cgroup/system.slice/desk-browser.service
bad() { echo "BAD: $*"; echo FAILED; }
fz() { python3 -I /var/tmp/fz.py "$@"; }
as() { setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I /var/tmp/fz.py ask "$1" 2>>/var/tmp/fz-times.txt | tail -1; }
want() { if [ "$2" = "$1" ]; then echo "ok: $3 -> $2"; else bad "$3 -> '$2', wanted '$1'"; fi; }
last_ok() { echo "$2"; [ "$(tail -1 <<<"$2")" = ok ] || bad "$1"; }   # a python check that crashed prints no ok
frozen() { sed -n 's/^frozen //p' $CG/cgroup.events 2>/dev/null; }
# A freeze that should work: the desk's own traffic (Chromium's component updates on a fresh profile, say) can make one
# busy network, which deskd takes as a clear no and asks again later. So retry those, and say so, and judge the rest.
freeze_ok() { local r i; for i in 1 2 3 4 5 6; do r=$(as 'freeze desk-browser'); [ "$r" = "err busy network" ] || break; echo "(busy network: the desk's own traffic, try $i, again in 3 s)" >&2; sleep 3; done; echo "$r"; }
usage() { sed -n 's/^usage_usec //p' $CG/cpu.stat; }
up() { for i in $(seq 1 90); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; bad "CDP never came up"; }
unit() { echo "$(systemctl show -p ActiveState --value desk-browser) $(systemctl show -p Result --value desk-browser)"; }
sink() { setpriv --reuid=1102 --regid=1102 --clear-groups env PULSE_SERVER=unix:/run/desk-audio/native HOME=/run/desk-audio/pulse pactl -f json list sink-inputs 2>/dev/null |
  python3 -I -c 'import json, sys; print(" ".join("corked" if i["corked"] else "playing" for i in json.load(sys.stdin)) or "none")'; }
# A fresh cookie, 5 s old: Chromium commits cookies only about every 30 s, so it's still in memory, and only a real quit
# (Browser.close: desk-browser-close's, and desk-browser-thaw's on every stop) writes it. SIGTERM alone lost it (TD-110,
# the Security Analyst's IMG-1).
fresh() { V=v$RANDOM$RANDOM; fz setcookie $V; sleep 5; }
# cookie_ok <what> <label>: the cookie V is on the page after a start. A Chromium just restored was once too slow for CDP
# for a minute on a lab box, so a timed-out read is tried once more, and said.
cookie_ok() { local out; out=$(fz cookie $V "$2" 2>&1); if [ "$(tail -1 <<<"$out")" != ok ] && grep -q TimeoutError <<<"$out"; then
  echo "(CDP didn't answer in 60 s: reading again)"; fz closeurl /echo 2>/dev/null; out=$(fz cookie $V "$2" 2>&1); fi; last_ok "$1" "$out"; }
ended() { case "$1" in *exit_type=SessionEnded* | *exit_type=Normal*) ;; *) bad "Chromium didn't end its session cleanly" ;; esac; }
chmod 644 /var/tmp/fz.py; : > /var/tmp/fz-times.txt
systemctl is-active --quiet desk-browser || bad "3b2 should have left Chromium running"
echo "desk-browser-thaw: $(systemctl is-enabled desk-browser-thaw) $(systemctl is-active desk-browser-thaw); $(systemctl show -p PartOf,After desk-browser-thaw | paste -sd' ' | grep -o 'PartOf=[^ ]*') after desk-browser: $(systemctl show -p After --value desk-browser-thaw | grep -c desk-browser.service)"
[ "$(systemctl is-active desk-browser-thaw)" = active ] || bad "desk-browser-thaw isn't active beside desk-browser"
systemctl stop verify-fz-pages 2>/dev/null; systemd-run --quiet --collect --unit=verify-fz-pages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/fz.py serve; sleep 1
V1=v$RANDOM$RANDOM; fz setcookie $V1
read FRAME _ < <(fz open /frame fz-frame); sleep 2
TABS=$(fz urls); echo "tabs: $TABS"
: > /var/tmp/px.log; setpriv --reuid=1102 --regid=1102 --clear-groups env DISPLAY=:99 python3 -I /var/tmp/fz.py pixels 960 540 150 >> /var/tmp/px.log 2>&1 & PX=$!
sleep 2

echo "--- 1. freeze: held, no CPU, the picture still, the port connects and nothing answers"
want ok "$(freeze_ok)" "freeze desk-browser, an idle page (an animation on 127.0.0.1 only)"
want 1 "$(frozen)" "cgroup.events frozen"
echo "systemd's FreezerState: $(systemctl show -p FreezerState --value desk-browser) (running by design: systemd didn't make this freeze)"
sleep 0.5; u1=$(usage); n1=$(wc -l < /var/tmp/px.log); sleep 5; u2=$(usage); n2=$(wc -l < /var/tmp/px.log)
[ -n "$u1" ] && [ "$u1" = "$u2" ] && echo "ok: cpu.stat usage_usec unchanged over 5 s frozen ($u1)" || bad "the cgroup used $((u2 - u1)) us of CPU in 5 s frozen"
[ "$n1" = "$n2" ] && echo "ok: the picture didn't change in 5 s frozen" || bad "the picture changed $((n2 - n1)) times while frozen"
r=$(python3 -I -c "
import socket
s = socket.create_connection(('127.0.0.1', 9222), 2); s.settimeout(1); s.sendall(b'GET /json/version HTTP/1.0\r\n\r\n')
try: print('answered' if s.recv(100) else 'closed')
except socket.timeout: print('connected, no answer in 1 s')" 2>&1 | tail -1)
want "connected, no answer in 1 s" "$r" "CDP while frozen"

echo "--- 2. thaw: everything as it was"
want ok "$(as 'thaw desk-browser')" "thaw desk-browser"
want 0 "$(frozen)" "cgroup.events frozen"
want 200 "$(curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version)" "/json/version within 1 s of the thaw"
want "$TABS" "$(fz urls)" "the same tabs and URLs"
last_ok "the cookie set before the freeze" "$(fz cookie $V1 'after a freeze and a thaw:')"
last_ok "3b2's cookies and history" "$(python3 -I /var/tmp/sv.py read 'after a freeze and a thaw')"
sleep 1; [ "$(wc -l < /var/tmp/px.log)" -gt $((n2 + 10)) ] && echo "ok: the picture moves again" || bad "the picture didn't move after the thaw"

echo "--- 3. thaw to the first page frame: 20 cycles, p95 within 300 ms (B13)"
last_ok "thaw to the first frame" "$(setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I /var/tmp/fz.py thawtime 20 /var/tmp/px.log 1.0 300 2>&1)"
kill $PX 2>/dev/null; wait $PX 2>/dev/null; tail -1 /var/tmp/px.log

echo "--- 4. not for another unit, nor anyone else"
want "err denied unit not allowed" "$(as 'freeze desk-stream')" "freeze desk-stream"
want "err denied unit not allowed" "$(as 'freeze desk-xorg')" "freeze desk-xorg"
want "err denied unit not allowed" "$(as 'thaw desk-xorg')" "thaw desk-xorg"
r=$(setpriv --reuid=1102 --regid=1102 --clear-groups python3 -I /var/tmp/fz.py ask 'freeze desk-browser' 2>&1 | tail -1); case "$r" in *PermissionError*) echo "ok: kiosk -> $r" ;; *) bad "kiosk -> $r" ;; esac
want "err denied only deskd may use this socket" "$(fz ask 'freeze desk-browser' 2>/dev/null)" "root, refused by SO_PEERCRED"
want 0 "$(frozen)" "nothing of that froze it"

echo "--- 5. a download being written is busy; one 60 s old isn't"
D=/data/browser/downloads; made=0; [ -d $D ] || { setpriv --reuid=1102 --regid=1102 --clear-groups mkdir $D; made=1; }
setpriv --reuid=1102 --regid=1102 --clear-groups sh -c "echo partial > $D/verify-fz.crdownload"
want "err busy download" "$(as 'freeze desk-browser')" "a .crdownload written a moment ago"
want 0 "$(frozen)" "not frozen"
touch -h -d '-60 seconds' $D/verify-fz.crdownload
want ok "$(freeze_ok)" "the same .crdownload, 60 s old"
want ok "$(as 'thaw desk-browser')" "thaw"
rm -f $D/verify-fz.crdownload; [ $made = 0 ] || rmdir $D

echo "--- 6. the desk moving more than 16 KiB in half a second is busy network; quiet again isn't"
fz blast 3 200000 & B=$!; sleep 0.5
want "err busy network" "$(as 'freeze desk-browser')" "about 200 KB/s leaving the desk"
want 0 "$(frozen)" "not frozen"
wait $B
want ok "$(freeze_ok)" "quiet again"
want ok "$(as 'thaw desk-browser')" "thaw"

echo "--- 7. ADR 0035: freeze, thaw, then desk-browser-close: the session comes through"
fresh
want ok "$(freeze_ok)" "freeze"; sleep 2; want ok "$(as 'thaw desk-browser')" "thaw"
out=$(/usr/local/lib/ma/desk-browser-close); c=$?; echo "$out"; [ $c = 0 ] || bad "desk-browser-close exited $c"
ended "$out"
systemctl start deskd   # desk-browser-close leaves it stopped
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
want "$TABS" "$(fz urls)" "the same tabs after the close and a start"
cookie_ok "a cookie set 7 s before, after the close" 'after a freeze, a thaw and desk-browser-close:'

echo "--- 8. ADR 0035: freeze, then desk-browser-close with no thaw (a root swap of a frozen desk)"
fresh
want ok "$(freeze_ok)" "freeze"; sleep 2
t=$(date +%s); out=$(/usr/local/lib/ma/desk-browser-close); c=$?; echo "$out (in $(( $(date +%s) - t )) s)"; [ $c = 0 ] || bad "desk-browser-close exited $c"
ended "$out"
journalctl -u desk-browser --since "@$t" --no-pager -o cat | grep -E 'timed out|Killing|SIGKILL|frozen' && bad "systemd had to kill it"
systemctl start deskd
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
want "$TABS" "$(fz urls)" "the same tabs"
cookie_ok "a cookie set 7 s before, after a frozen close" 'after a freeze and desk-browser-close:'

echo "--- 9. a plain systemctl stop, and a restart and a stop of a frozen desk-browser: desk-browser-thaw thaws it, then quits it over CDP"
fresh
t=$(date +%s%N); systemctl stop desk-browser; echo "stop: exit $?, $(( ($(date +%s%N) - t) / 1000000 )) ms"
want "inactive success" "$(unit)" "desk-browser after a plain stop"
journalctl -u desk-browser-thaw -n 5 --no-pager -o cat | grep -E '^desk-browser-(quit|close --quit):' | tail -1
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
cookie_ok "a cookie set 5 s before a plain systemctl stop" 'after a plain stop:'
fresh; want ok "$(freeze_ok)" "freeze"
t=$(date +%s%N); systemctl restart desk-browser; echo "restart: exit $?, $(( ($(date +%s%N) - t) / 1000000 )) ms"
want "active success" "$(unit)" "desk-browser after the restart"; want 0 "$(frozen)" "the new Chromium isn't frozen"
up; sleep 8; want "$TABS" "$(fz urls)" "the same tabs after the restart"
cookie_ok "a cookie set 5 s before a frozen restart" 'after a frozen restart:'
fresh; want ok "$(freeze_ok)" "freeze"
t=$(date +%s%N); systemctl stop desk-browser; echo "stop: exit $?, $(( ($(date +%s%N) - t) / 1000000 )) ms"
want "inactive success" "$(unit)" "desk-browser after the stop"
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
cookie_ok "a cookie set 5 s before a frozen stop" 'after a frozen stop:'

echo "--- 10. ADR 0035: freeze, then stop desk-browser through units.sock, as deskd does for a hold (a move's or an export's copy) and a policy restart; and the verbs on a stopped Browser"
fresh
want ok "$(freeze_ok)" "freeze"
t=$(date +%s%N); want ok "$(as 'stop desk-browser')" "stop desk-browser"; echo "stop through units.sock: $(( ($(date +%s%N) - t) / 1000000 )) ms"
want "inactive success" "$(unit)" "desk-browser after the stop"
want "err inactive desk-browser isn't running" "$(as 'freeze desk-browser')" "freeze of a stopped Browser"
want ok "$(as 'thaw desk-browser')" "thaw of a stopped Browser"
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
want "$TABS" "$(fz urls)" "the same tabs after the stop and a start"
cookie_ok "a cookie set 5 s before the freeze, after a frozen stop through units.sock" 'after a freeze and a stop through units.sock:'
last_ok "3b2's cookies and history at the end" "$(python3 -I /var/tmp/sv.py read 'at the end of 3b2a')"

echo "--- 11. sound: a page playing into the desk's sink freezes like any other (no sound check), and plays on after the thaw"
read AUDIO _ < <(fz open /audio fz-audio)
fz eval $AUDIO "a.play().then(() => 'playing')"
for i in $(seq 1 50); do [ "$(sink)" = playing ] && break; sleep 0.1; done; want playing "$(sink)" "the desk's sink, Chromium's stream"
want ok "$(freeze_ok)" "freeze with the sound playing"; want 1 "$(frozen)" "cgroup.events frozen"
sleep 3
want ok "$(as 'thaw desk-browser')" "thaw"
c1=$(fz eval $AUDIO a.currentTime); sleep 1; c2=$(fz eval $AUDIO a.currentTime); p=$(fz eval $AUDIO a.paused)
echo "after the thaw: paused $p, currentTime $c1 then $c2 a second later, sink $(sink)"
[ "$p" = false ] && python3 -I -c "import sys; sys.exit(0 if 0.5 < float('$c2') - float('$c1') < 1.5 else 1)" && echo "ok: the sound plays on" || bad "the sound didn't carry on after the thaw"
fz close $AUDIO; sleep 1

echo "--- 12. why the image thaws, not systemd: on systemd 257 a unit systemd froze can't be stopped, and a frozen Chromium can't take SIGTERM"
systemctl stop desk-browser-thaw   # out of the way, so only systemd acts below; with nothing stopping desk-browser it closes nothing
want "active success" "$(unit)" "desk-browser after desk-browser-thaw's stop alone"
journalctl -u desk-browser-thaw -n 5 --no-pager -o cat | grep -E '^desk-browser-(quit|close --quit):' | tail -1
systemctl freeze desk-browser; echo "systemctl freeze: FreezerState $(systemctl show -p FreezerState --value desk-browser), cgroup frozen $(frozen)"
r=$(timeout 10 systemctl stop desk-browser 2>&1); c=$?; echo "systemctl stop of it: exit $c: $r"
[ $c != 0 ] && case "$r" in *frozen*) true ;; *) false ;; esac && echo "ok: refused (JOB_FROZEN)" || bad "systemd stopped a unit it froze"
echo 0 > $CG/cgroup.freeze; sleep 0.5; echo "0 into cgroup.freeze: FreezerState $(systemctl show -p FreezerState --value desk-browser), cgroup frozen $(frozen)"
r=$(timeout 10 systemctl stop desk-browser 2>&1); c=$?; echo "systemctl stop again: exit $c: $r"
[ $c != 0 ] && echo "ok: still refused: systemd keeps its own state, so a shutdown couldn't thaw it in the cgroup either" || bad "systemd took the cgroup's thaw"
systemctl thaw desk-browser; want running "$(systemctl show -p FreezerState --value desk-browser)" "after systemctl thaw"
want "active success" "$(unit)" "desk-browser after all that"
echo "--- desk-browser has no ExecStop, ExecStopPost or ExecReload: systemd starts those in its cgroup with vfork, and PID 1 would wait on a frozen one"
want "" "$(systemctl show -p ExecStop,ExecStopPost,ExecReload --value desk-browser | tr -d '[:space:]')" "desk-browser's stop and reload commands"
echo "--- and with desk-browser-thaw stopped, a plain stop of a frozen Chromium only signals it, which it can't take; the thaw is what ends it"
want ok "$(freeze_ok)" "freeze"
timeout 5 systemctl stop desk-browser; echo "systemctl stop, 5 s later: exit $?, $(systemctl show -p ActiveState --value desk-browser)"
want deactivating "$(systemctl show -p ActiveState --value desk-browser)" "frozen, it can't take SIGTERM"
echo 0 > $CG/cgroup.freeze
for i in $(seq 1 100); do [ "$(systemctl show -p ActiveState --value desk-browser)" = inactive ] && break; sleep 0.1; done
want "inactive success" "$(unit)" "thawed, it took the SIGTERM it had waiting"
ended "exit_type=$(jq -r .profile.exit_type /data/browser/profile/Default/Preferences)"; echo "its exit: $(jq -r .profile.exit_type /data/browser/profile/Default/Preferences)"
want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8
want active "$(systemctl is-active desk-browser-thaw)" "desk-browser-thaw, back with desk-browser"
# SIGTERM alone can bring back a tab closed seconds before (item 11's), which the CDP quit doesn't: none may be missing.
now=$(fz urls); echo "tabs: $now"
python3 -I -c "import collections, sys; sys.exit(1 if collections.Counter(sys.argv[1].split()) - collections.Counter(sys.argv[2].split()) else 0)" "$TABS" "$now" && echo "ok: every tab from before is there" || bad "a tab is missing after a SIGTERM stop"

echo "--- 13. T46L-1: no freeze lands in a stop's quit. desk-browser reads active while desk-browser-thaw's stop thaws Chromium and"
echo "    quits it over CDP, and a freeze then held it mid-quit until systemd killed it (measured: SIGKILL, Crashed, the 8 s cookie lost)"
# The order and the lock, as installed: deskd stops before the thaw at a shutdown, and the thaw waits for a freeze under way.
tr ' ' '\n' <<<"$(systemctl show -p Before --value desk-browser-thaw)" | grep -qx deskd.service && echo "ok: desk-browser-thaw is Before=deskd.service (at a shutdown deskd stops first)" || bad "desk-browser-thaw isn't ordered Before=deskd.service"
x=$(systemctl show -p ExecStop --value desk-browser-thaw | tr '\n' ' ')
case "$x" in *"$CG"*"flock -w "*"cgroup.freeze"*"ignore_errors=yes"*"desk-browser-quit"*) echo "ok: its first ExecStop waits on the flock desk-units holds on $CG, then writes 0, then the quit" ;;
  *) bad "desk-browser-thaw's ExecStop doesn't wait on the cgroup's flock before the quit: $x" ;; esac
# At a shutdown Chromium must hear of it only through its units: on the system bus it holds a logind shutdown inhibitor and ends
# its own session at logind's PrepareForShutdown, before the quit (a reboot lost an 8 s cookie that way on a lab box).
want "0 0" "$(busctl --system --no-pager list 2>/dev/null | grep -c ' chromium ') $(systemd-inhibit --list --no-pager 2>/dev/null | grep -c Chromium)" "Chromium's system bus connections and logind inhibitors"
as13() { setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I /var/tmp/fz.py ask "$1" 2>/dev/null | tail -1; }   # not in the times below
fresh8() { V=v$RANDOM$RANDOM; fz setcookie $V; sleep 8; }   # 8 s: inside Chromium's 30 s commit, so only a clean quit writes it
nokill() { journalctl -u desk-browser --since "@$1" --no-pager -o cat | grep -E 'timed out|Killing|SIGKILL|Failed with result|Cannot stop frozen' && bad "$2: systemd had to kill Chromium"; }
prefs_exit() { echo "exit_type=$(jq -r .profile.exit_type /data/browser/profile/Default/Preferences)"; }
again() { want ok "$(as 'start desk-browser')" "start desk-browser"; up; sleep 8; }
echo "- a freeze while a stop of desk-browser is queued (held 3 s behind a unit that stops first, as a shutdown's waits for deskd)"
fresh8
systemd-run --quiet --collect --unit=verify-fz-hold -p After=desk-browser-thaw.service -p PartOf=desk-browser.service -p "ExecStop=/bin/sleep 3" --remain-after-exit /bin/true
t=$(date +%s); systemctl stop --no-block desk-browser; sleep 0.5
echo "jobs: $(systemctl list-jobs --no-legend | awk '{print $2 "/" $3 "/" $4}' | paste -sd' ')"
want "err busy stopping" "$(as13 'freeze desk-browser')" "freeze, a stop of desk-browser queued"
want 0 "$(frozen)" "not frozen"
for i in $(seq 1 150); do [ "$(systemctl is-active desk-browser)" = inactive ] && break; sleep 0.1; done
want "inactive success" "$(unit)" "desk-browser after the held stop"; nokill $t "the held stop"; ended "$(prefs_exit)"
again; cookie_ok "a cookie set 8 s before a stop that a freeze was asked during" 'after a freeze asked while a stop was queued:'
echo "- a freeze already under way when the stop comes: asked, then the stop while its 0.5 s network window runs, so the freeze"
echo "  writes during the quit unless it sees the stop (a Chromium quit before the window ends makes it busy network instead)"
for d in 0.40 0.45 0.50; do
  fresh8; t=$(date +%s)
  as13 'freeze desk-browser' > /var/tmp/fz-r & A=$!; sleep $d; s0=$(date +%s%N); systemctl stop desk-browser; s1=$(date +%s%N); wait $A
  echo "a freeze asked $d s before a stop answered '$(cat /var/tmp/fz-r)'; the stop took $(( (s1 - s0) / 1000000 )) ms"
  want "inactive success" "$(unit)" "desk-browser after the stop"; nokill $t "a stop during a freeze"; ended "$(prefs_exit)"
  again; cookie_ok "a cookie set 8 s before a stop $d s after a freeze was asked" "after a stop during a freeze ($d s):"
done
fresh8; t=$(date +%s)
as13 'freeze desk-browser' > /var/tmp/fz-r & A=$!; sleep 0.45; systemctl restart desk-browser; wait $A
echo "a freeze asked 0.45 s before a restart answered '$(cat /var/tmp/fz-r)'"
want "active success" "$(unit)" "desk-browser after the restart"; want 0 "$(frozen)" "the new Chromium isn't frozen"; nokill $t "a restart during a freeze"
up; sleep 8; cookie_ok "a cookie set 8 s before a restart 0.45 s after a freeze was asked" 'after a restart during a freeze:'
echo "- 1 written into cgroup.freeze during the quit, as a freeze that got past all that would: the quit's wait thaws it every second"
# mid: waits for desk-browser-close --quit, then for its CDP close (a python3 child) to come and go, so Browser.close has been
# sent, then writes 1 if Chromium is still quitting. Says landed or missed. ([t]: so pgrep can't find this script's own text.)
mid() { local c= seen=0 p
  for i in $(seq 1 3000); do c=$(pgrep -f 'desk-browser-close --qui[t]' | head -1); [ -n "$c" ] && break; sleep 0.005; done
  p=$(pgrep -o -u kiosk -x chromium)
  for i in $(seq 1 2000); do if pgrep -P "$c" -x python3 >/dev/null; then seen=1; elif [ $seen = 1 ] || ! kill -0 "$c" 2>/dev/null; then break; fi; done
  if [ $seen = 1 ] && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo 1 > $CG/cgroup.freeze 2>/dev/null; then echo landed; else echo missed; fi; }
for try in 1 2 3; do
  fresh8; t=$(date +%s)
  mid > /var/tmp/fz-w & W=$!; s0=$(date +%s%N); systemctl stop desk-browser; s1=$(date +%s%N); wait $W; w=$(cat /var/tmp/fz-w)
  echo "try $try: 1 written after Browser.close was sent, with Chromium still quitting: $w; the stop took $(( (s1 - s0) / 1000000 )) ms"
  want "inactive success" "$(unit)" "desk-browser after the stop"; nokill $t "a freeze written during the quit"; ended "$(prefs_exit)"
  journalctl -u desk-browser-thaw --since "@$t" --no-pager -o cat | grep -E '^desk-browser-(quit|close --quit):' | tail -1
  again; cookie_ok "a cookie set 8 s before a stop with a freeze written during its quit" 'after a freeze written during the quit:'
  [ "$w" = landed ] && break
done
[ "$w" = landed ] || bad "no write landed during the quit in 3 tries, so the quit's thaw on every pass wasn't tried"

echo "--- putting back the tabs 3b2 left"
fz closeurl /frame; sleep 2; systemctl stop verify-fz-pages
want 0 "$(frozen)" "Chromium left running, not frozen"
journalctl -b -q -u 'desk-units@*' --no-pager -o cat | grep -E '^desk-units: (freeze|thaw) desk-browser: ' | grep -v -E ': (ok|busy|inactive) in [0-9]+ ms$' && bad "desk-units logged more than ok, busy or inactive for a freeze or thaw"
echo "--- times, end to end through units.sock, as uid 1100 (python's connect included)"
for v in freeze thaw; do sed -n "s/^$v desk-browser: \([0-9]*\) ms$/\1/p" /var/tmp/fz-times.txt | sort -n | awk -v v=$v '{a[NR]=$1} END {if (NR) printf "%s: n=%d p50 %d ms, p95 %d ms, max %d ms\n", v, NR, a[int((NR+1)/2)], a[int(NR*0.95+0.5)], a[NR]}'; done
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "freezing an unseen desk's Chromium (ADR 0045): held with no CPU and a still picture, thawed to its first frame within B13; the same tabs, history and a cookie set 5 to 7 s before through desk-browser-close, a plain stop, a frozen restart and stop, and a stop through units.sock; busy download and busy network; denied for anything else; and no freeze lands in a stop's quit (T46L-1): busy stopping while a stop is queued, an 8 s cookie through stops and a restart during a freeze and a freeze written mid-quit, the thaw ordered after deskd and waiting on desk-units' lock" $rc < $WORKDIR/o

# ---- 3b3. desk-data, the read-only root helper behind deskd's data.* methods (task 32; tools/desk-data/README.md; the
# protocol is the appendix of docs/decisions/draft-data-export-and-transfer.md). Runs after 3b2, so Chromium is up with
# a profile whose History has rows, held in Chromium's exclusive locking mode: a read has to copy it when it's quiet.
cat > $WORKDIR/dd.py <<'P'
import hashlib, json, socket, sqlite3, struct, sys
def ask(req):
    s = socket.socket(socket.AF_UNIX); s.settimeout(60); s.connect('/run/desk/data.sock')
    s.sendall((json.dumps(req) + '\n').encode()); f = s.makefile('rb'); return f, json.loads(f.readline())
if sys.argv[1] == 'parts':
    _, h = ask({'v': 1, 'op': 'parts'})
    print(json.dumps({'ok': h.get('ok'), 'code': h.get('code'), 'helperVersion': h.get('helperVersion'), 'parts': sorted(p['part'] for p in h.get('parts', []))}))
if sys.argv[1] == 'read':   # the browser's History, live, whole: size, trailer, hash, and a database SQLite opens with its rows
    f, h = ask({'v': 1, 'op': 'read', 'part': 'browser', 'path': 'profile/Default/History', 'offset': 0})
    if not h.get('ok'): print('read refused:', h); sys.exit(0)
    body = bytearray()
    while True:
        n = struct.unpack('>I', f.read(4))[0]
        if n == 0: break
        body += f.read(n)
    digest = f.read(32); count = struct.unpack('>Q', f.read(8))[0]
    open('/var/tmp/dd-history.db', 'wb').write(body)
    d = sqlite3.connect('file:/var/tmp/dd-history.db?mode=ro', uri=True)
    check = d.execute('pragma integrity_check').fetchone()[0]; rows = d.execute("select count(*) from urls where url like '%verify-hist%'").fetchone()[0]; d.close()
    ok = h['size'] == len(body) == count and hashlib.sha256(body).digest() == digest and body[:16] == b'SQLite format 3\x00' and check == 'ok' and rows > 0
    print('read: size', h['size'], 'sent', len(body), 'trailer', count, 'hash', 'matches' if hashlib.sha256(body).digest() == digest else 'DIFFERS', 'integrity', check, 'verify-hist rows', rows)
    print('ok' if ok else 'BAD')
P
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $WORKDIR/dd.py "admin@$IP:/var/tmp/dd.py" >/dev/null
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $*"; echo FAILED; }
chmod 644 /var/tmp/dd.py
echo "desk-data.socket: $(systemctl is-enabled desk-data.socket) $(systemctl is-active desk-data.socket)"
[ "$(systemctl is-enabled desk-data.socket)" = enabled ] && [ "$(systemctl is-active desk-data.socket)" = active ] || bad "desk-data.socket isn't enabled and listening"
stat -c '%U:%G %a %n' /run/desk/data.sock /data/.ma-export-tmp
[ "$(stat -c '%U:%G %a' /run/desk/data.sock)" = "desk:desk 600" ] || bad "data.sock owner or mode"
[ "$(stat -c '%U:%G %a' /data/.ma-export-tmp)" = "root:root 700" ] || bad "/data/.ma-export-tmp owner or mode"
[ "$(findmnt -n -o TARGET --target /data/.ma-export-tmp)" = /data ] || bad "/data/.ma-export-tmp isn't on the data volume"
as() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 -I /var/tmp/dd.py "$2" 2>&1 | tail -2; }
r=$(as 1102 parts); echo "kiosk: $r"; case "$r" in *PermissionError*) ;; *) bad "kiosk reached data.sock" ;; esac
r=$(python3 -I /var/tmp/dd.py parts 2>&1); echo "root: $r"; case "$r" in *'"code": "denied"'*) ;; *) bad "root wasn't refused by SO_PEERCRED" ;; esac
r=$(as 1100 parts); echo "desk: $r"; case "$r" in *'"ok": true'*'"browser"'*) ;; *) bad "parts as desk" ;; esac
systemctl is-active --quiet desk-browser || bad "Chromium should be running for the read"
r=$(as 1100 read); echo "desk: $r"; case "$r" in *$'\n'ok) ;; *) bad "the History read" ;; esac
rm -f /var/tmp/dd-history.db
n=$(find /data/.ma-export-tmp -type f | wc -l); echo "scratch files left: $n"; [ "$n" = 0 ] || bad "scratch copies left in /data/.ma-export-tmp"
echo "journal lines naming a profile file: $(journalctl -b -q -u 'desk-data@*' | grep -c -e History -e Cookies || true)"
systemd-analyze security desk-data@0.service 2>/dev/null | tail -1 | sed 's/^/systemd-analyze security (informational): /'
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^desk: read:' $WORKDIR/o || rc=1   # a read that crashed prints no line
result "desk-data: data.sock is desk's alone, root and kiosk refused, parts answers, and a live History reads whole and consistent" $rc < $WORKDIR/o

# ---- 3b4. A teen's Browser lock (image/README.md, "Teen Browser lock"). deskd writes the band; here root writes it, on this
# box only. Chromium itself says what's applied (chrome://policy, over CDP as root), so a file on disk that Chromium ignores
# fails. Every check starts from the opposite state, and the band goes back at the end, so later sections are unaffected.
cat > $WORKDIR/tl.py <<'P'
import base64, json, os, socket, struct, sys, time, urllib.request
CDP = 'http://127.0.0.1:9222'
LOCK = {'DnsOverHttpsMode': 'secure', 'DnsOverHttpsTemplates': 'https://family.cloudflare-dns.com/dns-query', 'ForceGoogleSafeSearch': True,
        'ForceYouTubeRestrict': 1, 'ProxyMode': 'direct', 'ExtensionInstallBlocklist': ['*'], 'ExtensionInstallAllowlist': []}
MA_JSON = '/etc/chromium/policies/managed/ma.json'
def get(p, m='GET'): return urllib.request.urlopen(urllib.request.Request(CDP + p, method=m), timeout=30).read()
class WS:  # just enough of RFC 6455 for CDP, as in the CJK check
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1); host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), 10); self.s.settimeout(30); self.n = 0
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key)).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf: self.buf += self.s.recv(4096)
        head, self.buf = self.buf.split(b'\r\n\r\n', 1)
        if b' 101 ' not in head.split(b'\r\n')[0]: raise RuntimeError(head[:80])
    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]; return out
    def recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2); ln = b1 & 0x7f
            if ln == 126: ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127: ln = struct.unpack('>Q', self._read(8))[0]
            if b1 & 0x80: self._read(4)
            data = self._read(ln); op = b0 & 0x0f
            if op == 8: raise EOFError
            if op in (9, 10): continue
            msg += data
            if b0 & 0x80: return msg
    def call(self, method, **params):
        self.n += 1; i = self.n; data = json.dumps({'id': i, 'method': method, 'params': params}).encode(); mask = os.urandom(4)
        n = len(data); hdr = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack('>H', n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[k % 4] for k, b in enumerate(data)))
        while True:
            m = json.loads(self.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError('%s: %s' % (method, m['error']))
                return m['result']
    def value(self, expr): return self.call('Runtime.evaluate', expression=expr, returnByValue=True)['result'].get('value')
def applied():
    """Chromium's own table: chrome://policy's rows, set ones only. Waits for ma.json's keys, so an empty page isn't 'nothing applied'."""
    t = json.loads(get('/json/new?chrome://policy', 'PUT')); ws = WS(t['webSocketDebuggerUrl']); rows = {}
    js = """JSON.stringify([...document.querySelector('policy-app').shadowRoot.querySelectorAll('policy-table')].flatMap(t => [...t.shadowRoot.querySelectorAll('policy-row')]).map(r => r.policy).filter(p => p && 'value' in p))"""
    try:
        for _ in range(60):
            time.sleep(0.5)
            r = ws.value(js)
            rows = {p['name']: p for p in json.loads(r)} if r else {}
            if 'RestoreOnStartup' in rows: break
    finally:
        get('/json/close/' + t['id'])
    return rows
def visit(url):
    t = json.loads(get('/json/new?' + url, 'PUT')); ws = WS(t['webSocketDebuggerUrl']); o = {}
    try:
        for _ in range(40):
            time.sleep(0.5)
            o = json.loads(ws.value("JSON.stringify({href: location.href, title: document.title, ready: document.readyState, code: (document.querySelector('.error-code') || {}).textContent || ''})") or '{}')
            if o.get('ready') == 'complete' and not o.get('href', 'about:').startswith('about:'): break
    finally:
        get('/json/close/' + t['id'])
    return o
fails = []
def want(ok, what):
    print(('ok: ' if ok else 'BAD: ') + what)
    if not ok: fails.append(what)
mode = sys.argv[1]
if mode in ('teen', 'adult'):
    rows = applied(); print('Chromium reports %d set policies' % len(rows))
    ma = json.load(open(MA_JSON))
    for k in ma:   # the control: without these, the page wasn't read
        want(k in rows and rows[k].get('status') == 'OK', 'ma.json %s applied: %s' % (k, json.dumps(rows.get(k, {}).get('value'))))
    for k, v in LOCK.items():
        p = rows.get(k)
        if mode == 'teen':
            # Chromium 156 marks ProxyMode "Deprecated" and still applies it (image/README.md, "Teen Browser lock"). Anything else is a refusal.
            want(p is not None and p.get('value') == v and p.get('status') == ('Deprecated' if k == 'ProxyMode' else 'OK') and (p.get('level'), p.get('scope'), p.get('source')) == ('mandatory', 'machine', 'platform'),
                 '%s applied as %s: %s' % (k, json.dumps(v), json.dumps({x: p.get(x) for x in ('value', 'status', 'level', 'scope', 'source')}) if p else 'not set'))
        else:
            want(p is None, '%s unset%s' % (k, '' if p is None else ': ' + json.dumps(p.get('value'))))
    # Through the resolver or not, in Chromium itself: a name the family resolver answers with 0.0.0.0, Cloudflare's own test
    # name, and one it doesn't. The query string keeps Chromium's HTTP cache out of it, since a cached page needs no lookup.
    bust = '?tl=' + os.urandom(6).hex()
    fam = visit('https://nudity.testcategory.com/' + bust); print('nudity.testcategory.com:', json.dumps(fam))
    if mode == 'teen':
        want(fam.get('href', '').startswith('chrome-error:'), 'a name the family resolver filters does not load')
        name = visit('https://example.net/' + bust); print('example.net:', json.dumps(name))
        want(name.get('href', '').startswith('https://example.net/') and name.get('title'), 'a name it does not filter loads, so names resolve at all')
    else:
        want(fam.get('href', '').startswith('https://nudity.testcategory.com/'), 'the same name loads with no lock (the control)')
elif mode == 'keys':
    a, b = json.load(open(MA_JSON)), json.load(open('/etc/ma/chromium-teen.json'))
    shared = sorted(set(a) & set(b)); print('ma.json: %d keys, chromium-teen.json: %d keys, shared: %s' % (len(a), len(b), shared))
    want(not shared, 'no key in both files')
    want(b == LOCK, 'chromium-teen.json holds what this check expects')
    want('RestoreOnStartup' in a and a['RestoreOnStartup'] == 1, 'ma.json still restores the session')
elif mode == 'cookie':
    t = json.loads(get('/json/new?http://127.0.0.1:18766/echo', 'PUT')); title = ''
    for _ in range(40):
        time.sleep(0.5); title = next((x['title'] for x in json.loads(get('/json/list')) if x['id'] == t['id']), '')
        if title.startswith('C['): break
    get('/json/close/' + t['id']); print('cookies on the page:', title)
    want('v_persist=1' in title and 'v_session=1' in title, "3b2's persistent and session cookies are still there")
print('failures:', len(fails)); sys.exit(1 if fails else 0)
P
cat > $WORKDIR/tl.sh <<'P'
BAND=/data/desk/age-band LOCK=/etc/chromium/policies/managed/ma-teen.json POLICY=/etc/ma/chromium-teen.json HELPER=/usr/local/lib/ma/desk-browser-policy
bad() { echo "BAD: $*"; echo FAILED; }
ask() { timeout 60 setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I /var/tmp/tl-ask.py "$1" 2>&1 | tail -1; }
setband() { rm -rf "$BAND"; printf "$1" > "$BAND"; chown desk:desk "$BAND"; chmod 0644 "$BAND"; }
up() { for i in $(seq 1 90); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; bad "Chromium's port never came up"; return 1; }
down() { systemctl stop desk-browser; systemctl reset-failed desk-browser 2>/dev/null; }
# start_via_deskd <what>: the way deskd starts it. The helper's own journal line from this start has to be there.
start_via_deskd() { local since r l; since=$(date '+%F %T'); sleep 1; r=$(ask 'start desk-browser'); [ "$r" = ok ] || bad "$1: units.sock said: $r"
  l=$(journalctl -u desk-browser --since "$since" --no-pager -o cat | grep '^desk-browser-policy:'); [ -n "$l" ] || bad "$1: the helper didn't run on this start"; echo "$l" | sed "s/^/$1: /"; }
same_as_policy() { [ -f "$LOCK" ] && [ ! -L "$LOCK" ] && cmp -s "$LOCK" "$POLICY" && [ "$(stat -c '%U:%G %a' "$LOCK")" = "root:root 644" ]; }
P
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $WORKDIR/tl.py $WORKDIR/tl.sh "admin@$IP:/var/tmp/" >/dev/null
RS <<'X' > $WORKDIR/o 2>&1; rc=0
chmod 644 /var/tmp/tl.py /var/tmp/tl.sh; . /var/tmp/tl.sh
cat > /var/tmp/tl-ask.py <<'P'
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode() + b'\n'); print(s.recv(300).decode().strip())
P
chmod 644 /var/tmp/tl-ask.py
echo "--- the state to go back to"
rm -rf /var/tmp/tl-start; mkdir -m 0700 /var/tmp/tl-start
if [ -e "$BAND" ] || [ -L "$BAND" ]; then cp -a "$BAND" /var/tmp/tl-start/band; echo "band: $(stat -c '%F %U:%G %a' "$BAND"), $(sha256sum < "$BAND" | cut -c1-16)"; else echo "band: none"; fi
systemctl is-active --quiet desk-browser && touch /var/tmp/tl-start/running; echo "desk-browser: $(systemctl is-active desk-browser)"
echo "--- band adult"
down; setband 'teen\n'; $HELPER; same_as_policy || bad "the opposite state wasn't reached"   # a lock to remove
setband 'adult\n'; start_via_deskd adult; [ -e "$LOCK" ] && bad "the lock is still there"; echo "lock file: $(ls "$LOCK" 2>&1)"
up && python3 -I /var/tmp/tl.py adult || bad "Chromium's policies with band adult"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1   # a script that died partway printed no FAILED
result "teen lock: band adult, through units.sock: no lock file, and Chromium reports all 7 keys unset, ma.json's applied, and a name the family resolver filters loads" $rc < $WORKDIR/o
RS <<'X' > $WORKDIR/o 2>&1; rc=0
. /var/tmp/tl.sh
echo "--- band teen"
down; setband 'adult\n'; $HELPER; [ ! -e "$LOCK" ] || bad "the opposite state wasn't reached"   # no lock to find already there
setband 'teen\n'; start_via_deskd teen; same_as_policy || bad "the lock isn't the policy file's bytes, root's, 0644"; stat -c '%U:%G %a %s %n' "$LOCK"
up && python3 -I /var/tmp/tl.py teen || bad "Chromium's policies with band teen"
echo "--- uid 1102 reaches the resolver under nftables.conf"
r=$(setpriv --reuid=1102 --regid=1102 --clear-groups curl -s -m 10 -H 'accept: application/dns-json' -w ' http=%{http_code}' 'https://family.cloudflare-dns.com/dns-query?name=example.net&type=A'); echo "$r" | cut -c1-160
case "$r" in *'"Status":0'*' http=200') ;; *) bad "uid 1102 can't reach family.cloudflare-dns.com:443" ;; esac
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "teen lock: band teen, through units.sock: the lock in place, Chromium reports all 7 keys applied as mandatory, names go through the family resolver, and uid 1102 reaches it" $rc < $WORKDIR/o
RS <<'X' > $WORKDIR/o 2>&1; rc=0
. /var/tmp/tl.sh
# Each starts from no lock. The symlink points at a file saying adult, and the FIFO has no writer, so following one unlocks and reading the other hangs.
clear_lock() { setband 'adult\n'; $HELPER >/dev/null 2>&1; [ ! -e "$LOCK" ] || bad "$1: couldn't start from no lock"; }
printf 'adult\n' > /var/tmp/tl-adult; chmod 644 /var/tmp/tl-adult
check() { # check <what>: through the unit, with a time limit
  local t0=$SECONDS; start_via_deskd "$1"; echo "$1: $((SECONDS-t0)) s"; [ $((SECONDS-t0)) -lt 25 ] || bad "$1: slow enough to have hung"
  same_as_policy && echo "$1: locked" || bad "$1: not locked"; [ "$(systemctl is-active desk-browser)" = active ] || bad "$1: the Browser didn't start"
  up; down; }
down
clear_lock missing; rm -f "$BAND"; check "missing band"
clear_lock symlink; rm -f "$BAND"; ln -s /var/tmp/tl-adult "$BAND"; check "symlink to a file saying adult"
clear_lock fifo; rm -f "$BAND"; mkfifo "$BAND"; check "FIFO with no writer"
clear_lock garbage; setband 'ADULT\n'; check "garbage (ADULT)"
echo "--- more of them, the helper alone"
try() { local r; clear_lock "$1"; "${@:2}"; r=$(timeout 10 $HELPER 2>&1); local c=$?; echo "$1: exit $c, $r"; [ $c = 0 ] && same_as_policy || bad "$1: not locked"; rm -rf "$BAND"; }
try "no newline" setband 'adult'
try "two newlines" setband 'adult\n\n'
try "trailing space" setband 'adult \n'
try "a directory" sh -c "rm -f $BAND; mkdir $BAND"
try "1 MiB starting right" sh -c "rm -f $BAND; { printf 'adult\n'; head -c 1048576 /dev/zero; } > $BAND"
echo "--- the helper's lines never hold the band"
setband 'SECRETBAND\n'; $HELPER 2>&1 | grep -c SECRETBAND | sed 's/^/lines with its contents: /'; [ "$($HELPER 2>&1 | grep -c SECRETBAND)" = 0 ] || bad "a band's contents reached the log"
echo "--- /data gone: the helper on no band directory"
rm -f "$BAND"; mv /data/desk /data/desk.tl; rm -f "$LOCK"; r=$(timeout 10 $HELPER 2>&1); echo "no directory: exit $?, $r"; same_as_policy || bad "no band directory: not locked"; mv /data/desk.tl /data/desk
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "teen lock: a missing band, a symlink, a FIFO, garbage and no directory each end locked with the Browser up and no hang; nothing from the band in the log" $rc < $WORKDIR/o
RS <<'X' > $WORKDIR/o 2>&1; rc=0
. /var/tmp/tl.sh
down; setband 'teen\n'; $HELPER; same_as_policy || bad "no lock to attack"
h0=$(sha256sum "$LOCK" "$POLICY" | sha256sum | cut -c1-16); s0=$(stat -c '%U:%G %a' "$LOCK" "$POLICY" | paste -sd,)
for u in desk kiosk; do
  as() { setpriv --reuid="$(id -u $u)" --regid="$(id -g $u)" --init-groups sh -c "$1" 2>/dev/null; }
  [ "$(as 'id -u; echo probe')" = "$(id -u $u)
probe" ] || bad "$u: the probe itself doesn't run"
  as ': > /tmp/tl-own' && echo "$u: writes its own file in /tmp (the control)" || bad "$u: can't write even its own file, so a refusal below proves nothing"
  rm -f /tmp/tl-own
  for f in "$LOCK" "$POLICY"; do
    for try in "echo x >> $f" ": > $f" "rm -f $f" "mv $f $f.x" "chmod 666 $f" "chown $u $f" "ln -f /etc/hostname $f" "touch $f"; do
      if as "$try"; then bad "$u ($(id -u $u)) could: $try"; fi
    done
    [ -e "$f" ] || bad "$f is gone after $u"
    d=$(dirname "$f"); if as "echo x > $d/tl-new.json"; then bad "$u could add a file in $d"; rm -f "$d/tl-new.json"; fi
  done
  echo "$u ($(id -u $u), groups $(id -G $u | paste -sd,)): refused on both files and both directories"
done
[ "$(sha256sum "$LOCK" "$POLICY" | sha256sum | cut -c1-16)" = "$h0" ] && echo "both files unchanged" || bad "a file changed"
[ "$(stat -c '%U:%G %a' "$LOCK" "$POLICY" | paste -sd,)" = "$s0" ] && [ "$s0" = "root:root 644,root:root 644" ] && echo "owners and modes: $s0" || bad "owners or modes: $(stat -c '%U:%G %a' "$LOCK" "$POLICY" | paste -sd,)"
for d in /etc /etc/chromium /etc/chromium/policies /etc/chromium/policies/managed /etc/ma; do
  [ "$(stat -c '%U:%G' $d)" = root:root ] && [ $(( $(stat -c '%#a' $d) & 022 )) = 0 ] || bad "$d: $(stat -c '%U:%G %a' $d)"; done; echo "parent directories: root's, not group- or world-writable"
m=$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' deskd 2>/dev/null); echo "deskd's container mounts: ${m:-none running}"
case " $m " in *" /etc "*|*" /etc/chromium"*|*" /etc/ma "*) bad "deskd's container mounts those directories" ;; esac
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "teen lock: uids 1100 and 1102 can't change or remove the lock or the policy file, or add a file beside them" $rc < $WORKDIR/o
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
python3 -I /var/tmp/tl.py keys; rc=$?
exit $rc
X
result "teen lock: chromium-teen.json shares no key with ma.json" $rc < $WORKDIR/o
RS <<'X' > $WORKDIR/o 2>&1; rc=0
. /var/tmp/tl.sh
echo "--- back to the starting band"
down; rm -rf "$BAND"; [ -e /var/tmp/tl-start/band ] || [ -L /var/tmp/tl-start/band ] && cp -a /var/tmp/tl-start/band "$BAND"
want_state=none; [ -e "$BAND" ] || [ -L "$BAND" ] && want_state="$(stat -c '%F %U:%G %a' "$BAND"), $(sha256sum < "$BAND" | cut -c1-16)"
echo "band: $want_state"
[ -e /var/tmp/tl-start/band ] || [ -L /var/tmp/tl-start/band ] && { cmp -s "$BAND" /var/tmp/tl-start/band || bad "the band isn't what it was"; }
[ -e /var/tmp/tl-start/band ] || [ -L /var/tmp/tl-start/band ] || { [ ! -e "$BAND" ] && [ ! -L "$BAND" ] || bad "there was no band, and there is one now"; }
[ -z "$(find /data/desk -maxdepth 1 -name 'age-band?*')" ] && [ ! -e /data/desk.tl ] || bad "something of this section's is left under /data"
rm -f /var/tmp/tl-adult
if [ -e /var/tmp/tl-start/running ]; then start_via_deskd restore; up; [ "$(systemctl is-active desk-browser)" = active ] || bad "the Browser was running and isn't"; else $HELPER; fi
if [ "$(cat "$BAND" 2>/dev/null)" = adult ]; then [ ! -e "$LOCK" ] || bad "band adult, and a lock"; else same_as_policy || bad "no adult band, and no lock"; fi
echo "desk-browser: $(systemctl is-active desk-browser)"
echo "--- the session through all of that (ADR 0035; section 6 reads it again, with history)"
if systemctl is-active --quiet verify-pages; then python3 -I /var/tmp/tl.py cookie || bad "the session didn't survive the band changes"; else bad "3b2's page server isn't running, so the cookies can't be read"; fi
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "teen lock: the box is back on its starting band and Browser state, and 3b2's cookies came through every band change" $rc < $WORKDIR/o

# ---- 3b5. The ad blocker and its per-site switch (ADR 0076, image/README.md "Ad blocking"). Its own file, so it can run alone
# on a lab box (lab/adblock/lab.sh). The box is on the band 3b4 left (none here, so the teen lock's "no extensions" is in
# place). Each part puts back what it changed; leave-off then leaves one site off for section 6c. Each part has been seen to
# fail with what it guards broken (evidence/adblock-2026-11-07/breaks.txt).
for p in install switch restart stopped kill cookies hostile keys; do
  case $p in
    install) what="the image's blocker, from its own manifest at the pinned version, two permissions, no host permissions, content scripts or script but its worker, only block and allow rules, every list on, under the teen lock and with band adult; Chromium reports the policy as mandatory; an ad request is blocked while the page's own script runs; no tab of its own" ;;
    switch) what="through units.sock as deskd, one site off and another still blocked, confirmed by the blocker's own rules and chrome://policy, then on again, and no page of the helper's left open" ;;
    restart) what="the per-site list survives a Chromium restart: the policy and the blocker hold it, and 10 s later the site is off and another is blocked" ;;
    stopped) what="a list written while Chromium is down applies at its next start by itself, and through an apply after the start" ;;
    kill) what="the kill switch: nothing blocked, the blocker still installed and the list kept, uid 1100 can't set or clear it; then on again" ;;
    cookies) what="a profile's cookies and local storage byte-identical after pages with the blocker on, a site off and on again; no script of the blocker in a page" ;;
    hostile) what="a symlink, a FIFO, a directory, an oversized list and bad lines leave blocking on, never hang and never stop the Browser; no site in the log; uids 1100 and 1102 can't change the template or the policy; the policy root:kiosk 0640, unreadable to uids 1100 and 1103; 3b2's cookies came through" ;;
    keys) what="no key in two of ma.json, chromium-teen.json and chromium-adblock.json, and the policy is the template with the list and the kill switch" ;;
  esac
  R "sudo bash -s -- $p" < "$HERE/verify-adblock.sh" > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1
  grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "ad blocking, $p: $what" $rc < $WORKDIR/o
done
R "sudo bash -s -- leave-off" < "$HERE/verify-adblock.sh" >> "$EV" 2>&1

# ---- 3c. desk-stream against a stand-in for desk-rtc (runtime spec section 8.2)
RS <<'X' > $WORKDIR/o 2>&1; rc=0
stat -c '%U:%G %a %n' /run/desk-media
[ "$(stat -c '%U:%G %a' /run/desk-media)" = "rtc:stream 750" ] || { echo "BAD: /run/desk-media"; echo FAILED; }
id stream
sudo -u kiosk env DISPLAY=:99 xhost | grep -q SI:localuser:stream || { echo "BAD: stream has no X access"; echo FAILED; }
systemctl stop desk-rtc 2>/dev/null
cat > /var/tmp/fakertc.py <<'P'
import json, os, select, socket, struct, sys, time
path = '/run/desk-media/stream.sock'
if os.path.exists(path): os.unlink(path)
ln = socket.socket(socket.AF_UNIX); ln.bind(path); os.chmod(path, 0o666); ln.listen(1); ln.settimeout(30)
print('listening', flush=True)
c, _ = ln.accept()
uid = struct.unpack('3i', c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
out = {'peer_uid': uid}
buf = b''
def pump(seconds):
    """Reads RFC 4571 frames for a while; returns counts by payload type, and when the first keyframe came."""
    global buf
    end = time.monotonic() + seconds; t0 = time.monotonic()
    r = {'v': 0, 'a': 0, 'bytes': 0, 'sps': 0, 'first_ms': None, 'first_key_ms': None, 'bad': 0}
    while time.monotonic() < end:
        rd, _, _ = select.select([c], [], [], max(0, end - time.monotonic()))
        if not rd: continue
        d = c.recv(1 << 20)
        if not d: r['eof'] = True; break
        buf += d
        while len(buf) >= 2:
            n = struct.unpack('>H', buf[:2])[0]
            if len(buf) < 2 + n: break
            p = buf[2:2 + n]; buf = buf[2 + n:]
            if r['first_ms'] is None: r['first_ms'] = round((time.monotonic() - t0) * 1000, 1)
            r['bytes'] += n
            pt = p[1] & 0x7f
            if p[0] >> 6 != 2: r['bad'] += 1
            elif pt == 96:
                r['v'] += 1
                nal = p[12] & 0x1f
                inner = p[15] & 0x1f if nal == 24 and len(p) > 15 else nal
                if inner == 7:
                    r['sps'] += 1
                    if r['first_key_ms'] is None: r['first_key_ms'] = round((time.monotonic() - t0) * 1000, 1)
            elif pt == 111: r['a'] += 1
            else: r['bad'] += 1
    return r
out['warm_idle'] = pump(2)
c.sendall(b'resume\n')
out['live'] = pump(4)
c.sendall(b'keyframe\n')
out['after_keyframe'] = pump(1)
c.sendall(b'pause\n')
pump(0.5)
out['paused'] = pump(2)
c.sendall(b'resume\n')
out['resumed'] = pump(1)
print(json.dumps(out), flush=True)
c.close()
P
chmod 644 /var/tmp/fakertc.py
setpriv --reuid=1101 --regid=1101 --clear-groups python3 /var/tmp/fakertc.py > /var/tmp/fakertc.out 2>&1 &
FP=$!
sleep 1
echo "--- other users can't reach the socket"
# The stand-in's socket is 0666, so only /run/desk-media keeps them out, and the refusal has to be EACCES: a missing socket
# (FileNotFoundError) or any other error would say nothing about who may connect.
for u in 1100 1102 1103; do r=$(setpriv --reuid=$u --regid=$u --clear-groups python3 -c "
import socket
s=socket.socket(socket.AF_UNIX)
try: s.connect('/run/desk-media/stream.sock'); print('CONNECTED')
except OSError as e: print(type(e).__name__)" 2>&1 | tail -1)
  echo "uid $u: $r"; [ "$r" = PermissionError ] || { echo "BAD: uid $u got $r on /run/desk-media/stream.sock, not PermissionError"; echo FAILED; }
done
# Motion on screen, since stream.conf's drop-duplicates sends only a 100 ms heartbeat for a static one, and this checks a live picture.
cat > /var/tmp/motion.html <<'H'
<!doctype html><title>motion</title><body style="margin:0"><div id="d" style="width:1920px;height:1080px"></div><script>let i=0;function f(){d.style.background='hsl('+(i++%360)+',80%,50%)';requestAnimationFrame(f)}f()</script>
H
chmod 644 /var/tmp/motion.html
curl -s -X PUT 'http://127.0.0.1:9222/json/new?file:///var/tmp/motion.html' >/dev/null; sleep 2
# A tone, since a silent null sink sends no audio at all.
sudo -u kiosk env PULSE_SERVER=unix:/run/desk-audio/native timeout 25 gst-launch-1.0 -q audiotestsrc ! audioconvert ! pulsesink device=desk >/dev/null 2>&1 &
setpriv --reuid=1100 --regid=1100 --clear-groups python3 /var/tmp/ask.py 'start desk-stream'
wait $FP
cat /var/tmp/fakertc.out | cut -c1-1200
journalctl -u desk-stream -b --no-pager -o cat | tail -6 | cut -c1-200
ps -o pid,user,rss,cmd -u stream | cut -c1-100
python3 - <<'P'
import json,sys
o=json.loads(open('/var/tmp/fakertc.out').read().splitlines()[-1])
bad=[]
if o['peer_uid']!=1104: bad.append('peer uid')
if o['warm_idle']['v'] or o['warm_idle']['a']: bad.append('RTP while warm')
if o['live']['v']<100 or o['live']['a']<50 or o['live']['bad']: bad.append('no video or audio when live')
if o['live']['first_key_ms'] is None or o['live']['first_key_ms']>1000: bad.append('resume brought no prompt keyframe')
if o['after_keyframe']['sps']<1: bad.append('keyframe command brought no keyframe')
if o['paused']['v'] or o['paused']['a']: bad.append('RTP while paused')
if o['resumed']['sps']<1: bad.append('no keyframe on resume')
print('checks failed:',bad) if bad else print('all stream checks ok')
sys.exit(1 if bad else 0)
P
[ $? = 0 ] || echo FAILED
for id in $(curl -s http://127.0.0.1:9222/json/list | jq -r '.[]|select(.url|test("motion.html"))|.id'); do curl -s "http://127.0.0.1:9222/json/close/$id" >/dev/null; done
as() { setpriv --reuid=1100 --regid=1100 --clear-groups python3 /var/tmp/ask.py "$1"; }
as 'stop desk-stream'; systemctl reset-failed desk-stream 2>/dev/null
rm -f /run/desk-media/stream.sock
systemctl start desk-rtc 2>/dev/null
echo "--- ma-update of an on-demand release leaves it stopped"
w=/var/tmp/w-ds; rm -rf $w; cp -a /opt/ma/desk-stream/current/. $w/; echo verify-1 > $w/VERSION; tar -C $w -czf /var/tmp/ds.tgz .
/opt/ma/bin/ma-update desk-stream file:///var/tmp/ds.tgz $(sha256sum /var/tmp/ds.tgz | cut -d' ' -f1); echo "ma-update exit $?"
echo "current: $(cat /opt/ma/desk-stream/current/VERSION), unit: $(systemctl is-active desk-stream)"
[ "$(cat /opt/ma/desk-stream/current/VERSION)" = verify-1 ] && [ "$(systemctl is-active desk-stream)" = inactive ] || { echo "BAD: on-demand update"; echo FAILED; }
/opt/ma/bin/ma-update desk-stream --rollback; echo "rollback exit $?, current: $(cat /opt/ma/desk-stream/current/VERSION), unit: $(systemctl is-active desk-stream)"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
result "desk-stream: warm until resume, H.264 and Opus RTP from uid 1104, keyframe on command, nothing while paused, socket closed to other users, update leaves it stopped" $rc < $WORKDIR/o

# ---- 3d. the outbound shaper (ADR 0036). One box here: packets go to the subnet's gateway, and the class counters see them leave.
# The real-stack video test and the budgets on lowered thresholds are ADR 0036 section 6's, not this. Runs after 3c, so its fakertc.py is there.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $1"; echo FAILED; }
modprobe sch_htb && modprobe sch_fq_codel && echo "sch_htb and sch_fq_codel load, kernel $(uname -r)" || bad "the qdiscs don't load"
echo "--- units"
[ "$(systemctl is-active desk-egress)" = active ] || bad "desk-egress isn't running"
for u in desk-rtc deskd; do
  systemctl show -p Wants --value $u | grep -q desk-egress.service && systemctl show -p After --value $u | grep -q desk-egress.service || bad "$u should want and follow desk-egress"
  systemctl show -p Requires,Requisite,BindsTo --value $u | grep -q desk-egress && bad "$u must not require desk-egress"
done
echo "--- shaper"; tc class show dev ens5 | grep htb; tc qdisc show dev ens5 | grep -E 'htb|pfifo|fq_codel' | cut -c1-70
/opt/ma/desk-egress/current/desk-egress --check || bad "--check says no shaper"
RELEASE_DIR=/opt/ma/desk-egress/current /opt/ma/desk-egress/current/health || bad "health fails"
tc -j -s class show dev ens5 > /var/tmp/cl.json
python3 -I - <<'P' || bad "classes aren't as specified"
import json, sys
want = {"1:10": (7500000, 1048576, 0, "0x10"), "1:15": (250000, None, 0, "0x15"), "1:20": (12500000, 262144, 1, "0x20")}
got = {c["handle"]: c for c in json.load(open("/var/tmp/cl.json")) if c.get("class") == "htb"}
ok = set(got) == set(want)
for h, (rate, burst, prio, leaf) in want.items():
    c = got.get(h, {})
    ok = ok and c.get("rate") == rate and c.get("ceil") == rate and c.get("prio") == prio and c.get("leaf") == leaf and (burst is None or (c.get("burst") == burst and c.get("cburst") == burst))
print("classes as specified" if ok else got); sys.exit(0 if ok else 1)
P
[ -z "$(tc filter show dev ens5; tc filter show dev ens5 parent 1:)" ] && echo "no tc filter" || bad "a tc filter exists"
nft list chain inet ma classify | grep -q 'type filter hook output priority mangle' || bad "no classify chain"
echo "--- who lands in which class"
systemctl stop desk-rtc 2>/dev/null
GW=$(ip -j route show default | jq -r '.[0].gateway')
cat > /var/tmp/send.py <<'P'
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
if sys.argv[2] != "0": s.bind(("0.0.0.0", int(sys.argv[2])))
for _ in range(200): s.sendto(b"x" * 100, (sys.argv[1], 9))
P
chmod 644 /var/tmp/send.py
count() { tc -j -s class show dev ens5 | jq -r --arg h "$1" '.[]|select(.class=="htb" and .handle==$h)|.stats.packets'; }
sends() { # sends <name> <want class> <port> <setpriv args...>
  # HTB counts a packet when it leaves, and 1:15 at 2 Mbit takes about 0.1 s to send 200, so the count waits a second.
  local name=$1 want=$2 port=$3; shift 3; local a b; a=$(count "$want"); "$@" python3 -I /var/tmp/send.py "$GW" "$port"; sleep 1; b=$(count "$want")
  if [ $((b - a)) -ge 200 ]; then echo "ok: $name -> $want ($((b - a)) packets)"; else bad "$name: $want saw $((b - a)) of 200 packets"; fi; }
as() { echo setpriv --reuid=$1 --regid=$1 --clear-groups; }
sends "rtc from 443" 1:10 443 $(as 1101) --inh-caps=+net_bind_service --ambient-caps=+net_bind_service
sends "rtc from another port" 1:20 0 $(as 1101)
sends "root" 1:15 0 env
sends "desk" 1:15 0 $(as 1100)
sends "kiosk" 1:20 0 $(as 1102)
# agent (1103) isn't sent from here: nftables refuses it anything but loopback and desk-agent-filter (section 3e1).
sends "stream" 1:20 0 $(as 1104)
echo "--- what each user is refused"
cat > /var/tmp/prio.py <<'P'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for p in (0x10010, 0x10015, 0x10000):
    try: s.setsockopt(socket.SOL_SOCKET, socket.SO_PRIORITY, p); print("ALLOWED", hex(p))
    except PermissionError: print("refused", hex(p))
for port, kind in ((443, socket.SOCK_DGRAM), (443, socket.SOCK_STREAM)):
    try: socket.socket(socket.AF_INET, kind).bind(("0.0.0.0", port)); print("ALLOWED bind", port)
    except PermissionError: print("refused bind", port)
P
chmod 644 /var/tmp/prio.py
for u in 1100 1101 1102 1103 1104; do
  s="setpriv --reuid=$u --regid=$u --clear-groups"
  $s tc qdisc del dev ens5 root 2>/dev/null && bad "uid $u removed the shaper"
  $s tc class change dev ens5 parent 1: classid 1:20 htb rate 1gbit 2>/dev/null && bad "uid $u changed a class"
  $s nft flush chain inet ma classify 2>/dev/null && bad "uid $u flushed the chain"
  o=$($s python3 -I /var/tmp/prio.py 2>&1); [ "$(grep -c refused <<<"$o")" = 5 ] && echo "ok: uid $u refused tc, nft, SO_PRIORITY and port 443" || bad "uid $u: $o"
done
echo "--- no file capability another user can run (gst-ptp-helper came with cap_net_admin, image/README.md)"
getcap -r /usr /opt 2>/dev/null | while read -r f c; do
  if [ "$(stat -c %a "$f" | cut -c3)" != 0 ] || [ "$(stat -c %u "$f")" != 0 ]; then bad "$f has $c and others can run it"; else echo "ok: $f has $c, mode $(stat -c %a "$f")"; fi
done
# From a shell that is already kiosk: setpriv itself still holds root's capabilities when it execs, so it can run a 0700 file.
setpriv --reuid=1102 --regid=1102 --clear-groups sh -c 'exec /usr/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-ptp-helper' </dev/null >/dev/null 2>&1
[ $? = 126 ] && echo "ok: kiosk can't run gst-ptp-helper" || bad "kiosk ran gst-ptp-helper"
systemctl start desk-rtc 2>/dev/null
echo "--- files"
stat -c '%U %a %n' /data/desk-egress /run/desk-egress /run/desk-egress/profile
[ "$(stat -c '%U %a' /data/desk-egress)" = "root 700" ] && [ "$(stat -c '%U %a' /run/desk-egress/profile)" = "root 644" ] || bad "modes"
[ "$(cat /run/desk-egress/profile)" = normal ] || bad "profile isn't normal"
M=$(systemctl show -p MainPID --value desk-egress); h=$(nsenter -t "$M" -m ls -A /data/browser 2>&1 | wc -l); echo "/data/browser as desk-egress sees it: $h entries"; [ "$h" -le 1 ] || bad "desk-egress can see /data/browser"
echo "--- a clamp doesn't outlive the process, and a restart keeps the counters"
# The unit's ExecStopPost=--unclamp is what lifts it. A plain stop or restart can't show that: the process's last tick, or the
# new one's first, puts the rates back by itself. A SIGKILL skips the last tick, and in auto-restart, with RestartSec=10,
# ExecStopPost has run and no new process has started: whatever 1:20 says then is what the unit left behind.
rate() { tc -j class show dev ens5 | jq -r --arg h "$1" '.[]|select(.handle==$h)|.rate'; }
lower() { tc class change dev ens5 parent 1: classid 1:20 htb rate 1mbit ceil 1mbit burst 256kb cburst 256kb prio 1 quantum 60000; }
echo "ExecStopPost as systemd has it: $(systemctl show -p ExecStopPost --value desk-egress | grep -o 'argv\[\]=[^;]*' | paste -sd' ')"
lower; echo "1:20 lowered to $(rate 1:20) bytes/s"; systemctl kill -s KILL desk-egress
for i in $(seq 1 50); do case "$(systemctl show -p SubState --value desk-egress)" in auto-restart*) break ;; esac; sleep 0.2; done
st=$(systemctl show -p SubState --value desk-egress); r=$(rate 1:20)
case "$st" in auto-restart*) w=1 ;; *) w=0 ;; esac
[ "$w" = 1 ] && [ "$r" = 12500000 ] && echo "ok: killed, and with no process running 1:20 is back at 100 Mbit" || bad "killed: unit $st, 1:20 at $r bytes/s with no process to lift it"
for i in $(seq 1 30); do systemctl is-active --quiet desk-egress && break; sleep 1; done
systemctl is-active --quiet desk-egress && echo "ok: running again after ${i} s" || bad "desk-egress didn't come back after the kill"
lower; b0=$(count 1:20); systemctl restart desk-egress; b1=$(count 1:20); r=$(rate 1:20)
[ "$r" = 12500000 ] && [ "$b1" -ge "$b0" ] && echo "ok: a restart, 1:20 back at 100 Mbit, counter $b0 to $b1" || bad "restart: rate $r, counter $b0 to $b1"
echo "--- the shaper comes back within a tick"
tc qdisc del dev ens5 root
for i in $(seq 1 70); do /opt/ma/desk-egress/current/desk-egress --check 2>/dev/null && break; sleep 1; done
/opt/ma/desk-egress/current/desk-egress --check && echo "ok: back after $i s" || bad "no shaper after 70 s"
[ -s /data/desk-egress/state.json ] && [ "$(stat -c '%U %a' /data/desk-egress/state.json)" = "root 600" ] && jq -c '{level,month,month_bytes,profile}' /data/desk-egress/state.json || bad "no state file"
echo "--- each profile's conf builds and sends video"
systemctl stop desk-rtc 2>/dev/null
# desk-egress would write its own profile back at its next tick and restart desk-stream mid-check, so it's stopped here.
systemctl stop desk-egress
# From desk-stream 0.3.0 a still screen sends only a repeat about once a second (ADR 0073), so the check needs motion: a small
# window of kiosk's, mapped on top, changes colour 30 times a second while each profile is measured.
cat > /var/tmp/flicker.py <<'P'
import ctypes, sys, time
x = ctypes.CDLL("libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p; x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong; x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XCreateSimpleWindow.restype = ctypes.c_ulong
x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
for f in ("XMapRaised", "XClearWindow", "XRaiseWindow"): getattr(x, f).argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XSetWindowBackground.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
end = time.monotonic() + 20  # desk-stream's start brings desk-xorg up: wait for it
while not (d := x.XOpenDisplay(b":99")):
    if time.monotonic() > end: sys.exit("flicker: no display :99")
    time.sleep(0.1)
w = x.XCreateSimpleWindow(d, x.XDefaultRootWindow(d), 0, 0, 320, 240, 0, 0, 0)
x.XMapRaised(d, w)
end, i = time.monotonic() + float(sys.argv[1]), 0
while time.monotonic() < end:
    i += 1
    x.XSetWindowBackground(d, w, 0xff0000 if i % 2 else 0x0000ff); x.XClearWindow(d, w); x.XRaiseWindow(d, w); x.XSync(d, 0)
    time.sleep(1 / 30)
print("flicker: frames", i)
P
chmod 644 /var/tmp/flicker.py
for p in capped deep; do
  systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null; printf '%s\n' "$p" > /run/desk-egress/profile
  setpriv --reuid=1101 --regid=1101 --clear-groups python3 /var/tmp/fakertc.py > /var/tmp/fakertc.out 2>&1 &
  FP=$!; sleep 1
  setpriv --reuid=1102 --regid=1102 --clear-groups env DISPLAY=:99 python3 -I /var/tmp/flicker.py 30 > /var/tmp/flicker.out 2>&1 &
  FL=$!
  systemctl start desk-stream; wait $FP; kill $FL 2>/dev/null; wait $FL 2>/dev/null; cat /var/tmp/flicker.out
  python3 -I - "$p" <<'P' || bad "$p sent no video"
import json, sys
o = json.loads(open("/var/tmp/fakertc.out").read().splitlines()[-1])
print(sys.argv[1], "live video packets", o["live"]["v"], "audio", o["live"]["a"], "first keyframe", o["live"]["first_key_ms"], "ms")
sys.exit(0 if o["live"]["v"] > 50 and not o["live"]["bad"] and o["live"]["first_key_ms"] is not None else 1)
P
  got=$(journalctl -u desk-stream -n 40 --no-pager -o cat | grep 'pipeline:' | tail -1 | grep -o -E 'quantizer=[0-9]+|width=960,height=540' | paste -sd' ')
  echo "$p: $got"
  case "$p:$got" in "capped:quantizer=28" | "deep:quantizer=30 width=960,height=540" | "deep:width=960,height=540 quantizer=30") ;; *) bad "$p ran another conf" ;; esac
done
systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null
printf 'normal\n' > /run/desk-egress/profile
systemctl start desk-egress
rm -f /run/desk-media/stream.sock
systemctl start desk-rtc 2>/dev/null
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "outbound shaper: qdiscs load, classes and rates, no filter, each uid in its class, no user can change it, a clamp lifts when the process is killed, comes back within a tick, profile confs send video" $rc < $WORKDIR/o

# ---- 3n. desk-notebook on the image (image/README.md, desk-notebook): user, directories, socket directory and unit, both
# ways. With no DeskNotebookVersion tag nothing is installed and the unit is skipped by its condition. With one, the
# pinned release runs, with no network. Every failure prints FAILED, and the last line has to print too.
{ printf 'NB=%q\n' "$T_NOTEBOOK"; cat <<'X'
export LC_ALL=C
bad() { echo "BAD: $1"; echo FAILED; }
as() { setpriv --reuid=$1 --regid=$1 --clear-groups "${@:2}"; }
# A refusal only counts as that refusal: "no such file" or a setpriv error would mean the test is broken, and fails too.
denied() { [ "$2" != 0 ] && case "$3" in "$1: "*": Permission denied") ;; *) false ;; esac; }  # denied <tool> <exit> <output>
echo "--- the user: $(getent passwd notebook)"
[ "$(id -u notebook 2>&1)" = 1105 ] && [ "$(id -g notebook 2>&1)" = 1105 ] || bad "user notebook should be uid and gid 1105"
# Its own group only: in group desk, uid 1105 could reach rtc.sock.
[ "$(id -nG notebook 2>&1)" = notebook ] || bad "notebook should be in its own group only: $(id -nG notebook 2>&1)"
echo "--- the unit"
[ "$(systemctl is-enabled desk-notebook.service 2>&1)" = enabled ] || bad "desk-notebook.service isn't enabled"
for d in docker.service desk-datadirs.service; do systemctl show -p Requires --value desk-notebook.service | grep -qw $d || bad "it should require $d"; done
systemctl show -p ExecStop --value desk-notebook.service | grep -q 'docker stop -t 30 desk-notebook' || bad "it should stop with 30 s of grace"
# deskd relays with backoff and its health never needs this unit, so nothing of deskd's may name it.
for p in Requires Requisite BindsTo PartOf Wants After; do
  systemctl show -p $p --value deskd.service | grep -qw desk-notebook.service && bad "deskd.service names desk-notebook in $p"
done
systemctl is-active --quiet deskd || bad "deskd should be running, whatever desk-notebook does"
d=/opt/ma/desk-notebook
cond=$(systemctl show -p ConditionResult --value desk-notebook.service); at=$(systemctl show -p ConditionTimestampMonotonic --value desk-notebook.service)
echo "desk-notebook.service: $(systemctl is-active desk-notebook.service), condition $cond at $at, restarts $(systemctl show -p NRestarts --value desk-notebook.service), AMI tag ${NB:-none}"
if [ -z "$NB" ]; then
  [ ! -e $d ] || bad "a desk-notebook release is on the image, but the AMI has no DeskNotebookVersion tag"
  # ConditionResult also says no on a unit that never tried to start, so the timestamp is what shows the condition ran.
  [ "$cond" = no ] && [ "$at" -gt 0 ] || bad "desk-notebook.service should have been skipped by its condition at boot"
  [ "$(systemctl is-active desk-notebook.service)" = inactive ] && [ "$(systemctl show -p NRestarts --value desk-notebook.service)" = 0 ] \
    || bad "desk-notebook.service should be inactive with no restarts"
  [ -z "$(ls -A /data/notebook 2>&1)" ] || bad "/data/notebook should be empty with no release: $(ls -A /data/notebook 2>&1)"
else
  [ "$(readlink $d/current)" = "$d/releases/$NB" ] && [ -x $d/current/run ] && [ -x $d/current/health ] && [ -s $d/current/image-id ] && [ -s $d/current/artifact.sha256 ] \
    || bad "the pinned desk-notebook $NB isn't installed as a rollout lays it out"
  [ "$cond" = yes ] && [ "$at" -gt 0 ] && systemctl is-active --quiet desk-notebook.service || bad "desk-notebook.service should pass its condition and run"
  out=$(RELEASE_DIR=$d/current timeout 30 $d/current/health 2>&1 </dev/null) && echo "desk-notebook health: ok" || bad "desk-notebook health: $out"
  c() { docker inspect -f "$1" desk-notebook 2>&1; }
  echo "container: image $(c '{{.Image}}'), network $(c '{{.HostConfig.NetworkMode}}'), user $(c '{{.Config.User}}'), read-only $(c '{{.HostConfig.ReadonlyRootfs}}'), memory $(c '{{.HostConfig.Memory}}')"
  [ "$(c '{{.Image}}')" = "$(cat $d/current/image-id 2>&1)" ] || bad "the container isn't on the baked image"
  # The reason nftables has no rule for uid 1105 (image/README.md, desk-notebook).
  [ "$(c '{{.HostConfig.NetworkMode}}')" = none ] || bad "the container must have no network"
  case "$(c '{{.Config.User}}')" in 1105|1105:*) ;; *) bad "the container should run as uid 1105" ;; esac
  [ "$(c '{{.HostConfig.ReadonlyRootfs}}')" = true ] || bad "the container's root should be read-only"
  [ "$(c '{{.HostConfig.Memory}}')" -gt 0 ] 2>/dev/null || bad "the container should have a memory cap"
  [ "$(stat -c '%u:%g %a' /run/desk-notebook/notebook.sock 2>&1)" = "1105:1100 660" ] || bad "notebook.sock should be 1105:1100 660"
  [ -z "$(find /data/notebook ! -uid 1105 2>&1)" ] || bad "/data/notebook holds something uid 1105 doesn't own"
fi
echo "--- /data/notebook: $(stat -c '%U:%G %a' /data/notebook 2>&1), on a volume this image found blank: $(jq -c .formattedAt /data/.ma-volume 2>&1)"
# formattedAt is null on a volume from before this image's format record, where the directory could be anyone's.
jq -e .formattedAt /data/.ma-volume >/dev/null 2>&1 || bad "/data isn't a volume this image formatted, so this says nothing about a blank one"
[ "$(stat -c '%u:%g %a' /data/notebook 2>&1)" = "1105:1105 700" ] || bad "/data/notebook should be 1105:1105 700"
# A file anyone could read once inside, so only the directory stops them. Its owner has to read it, or the refusals prove
# nothing. cat and ls do the opening after exec, when setpriv's capabilities have gone (section 3d's note is about exec).
f=/data/notebook/.verify-read; m=verify-$$
printf '%s\n' "$m" > $f; chown 1105:1105 $f; chmod 0644 $f
[ "$(as 1105 cat $f 2>&1)" = "$m" ] || bad "uid 1105 can't read its own file"
for u in 1100 1102 1103; do
  out=$(as $u cat $f 2>&1); e=$?; echo "uid $u reads a file there: exit $e, $out"
  denied cat $e "$out" || bad "uid $u should be refused a file in /data/notebook"
  out=$(as $u ls -A /data/notebook 2>&1); e=$?; echo "uid $u lists it: exit $e, $out"
  denied ls $e "$out" || bad "uid $u should be refused /data/notebook's listing"
done
rm -f $f
echo "--- /run/desk-notebook: $(stat -c '%U:%G %a' /run/desk-notebook 2>&1)"
[ "$(stat -c '%u:%g %a' /run/desk-notebook 2>&1)" = "1105:1100 2750" ] || bad "/run/desk-notebook should be 1105:1100 2750"
out=$(as 1100 ls -A /run/desk-notebook 2>&1) && echo "group desk (1100) enters" || bad "group desk can't enter /run/desk-notebook: $out"
for u in 1102 1103; do
  out=$(as $u ls -A /run/desk-notebook 2>&1); e=$?; echo "uid $u lists it: exit $e, $out"
  denied ls $e "$out" || bad "uid $u should be refused /run/desk-notebook"
done
# A socket uid 1105 makes there is group desk by the setgid bit, as notebook.sock will be: deskd connects, the others don't.
# Not through as(): in the background that's a subshell, and kill has to reach python itself.
s=/run/desk-notebook/verify.sock
setpriv --reuid=1105 --regid=1105 --clear-groups python3 -I -c '
import os, socket, sys, time
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1], 0o660); s.listen(4); time.sleep(30)' $s &
L=$!; for i in $(seq 1 100); do [ -S $s ] && break; sleep 0.1; done
echo "verify.sock: $(stat -c '%U:%G %a' $s 2>&1)"
[ "$(stat -c '%u:%g %a' $s 2>&1)" = "1105:1100 660" ] || bad "a socket uid 1105 makes there should be 1105:1100 660"
conn() { as $1 python3 -I -c '
import socket, sys
s = socket.socket(socket.AF_UNIX)
try: s.connect(sys.argv[1]); print("connected")
except OSError as e: print(type(e).__name__)' $s 2>&1 | tail -1; }
c1100=$(conn 1100); c1102=$(conn 1102); c1103=$(conn 1103); echo "connect: desk (1100) $c1100, kiosk (1102) $c1102, agent (1103) $c1103"
[ "$c1100" = connected ] || bad "deskd's uid can't connect to a socket there"
[ "$c1102" = PermissionError ] && [ "$c1103" = PermissionError ] || bad "only group desk should connect"
kill $L 2>/dev/null; wait $L 2>/dev/null; rm -f $s
[ -z "$NB" ] && [ -n "$(ls -A /run/desk-notebook 2>&1)" ] && bad "/run/desk-notebook should be empty with no release: $(ls -A /run/desk-notebook 2>&1)"
echo "deskd /health notebook: $(curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://localhost/health | jq -r '.notebook // "-"' 2>&1) (informational)"
echo "ran to the end"
X
} | RS > $WORKDIR/o 2>&1; rc=0
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "desk-notebook: uid 1105, /data/notebook 0700 and closed to uids 1100, 1102 and 1103, /run/desk-notebook 2750 with group desk let in, deskd independent; unit skipped with no pin, or the baked release running with no network and healthy" $rc < $WORKDIR/o

# ---- 3e. desk-agent on the image (image/README.md, desk-agent): the pinned release baked in and running from first boot
# (from 0.2.7), its unit, its directories and sockets. uid 1103's way out is section 3e1.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $1"; echo FAILED; }
as() { setpriv --reuid=$1 --regid=$1 --clear-groups "${@:2}"; }
echo "--- the unit and the baked release"
[ "$(systemctl is-enabled desk-agent.service)" = enabled ] || bad "desk-agent.service isn't enabled"
d=/opt/ma/desk-agent; echo "release: current $(readlink $d/current), previous $(readlink $d/previous || echo none), releases $(ls $d/releases 2>&1 | paste -sd' ')"
[ -x $d/current/run ] && [ -x $d/current/health ] && [ -s $d/current/image-id ] && [ -s $d/current/desk-agent.env ] && [ -s $d/current/artifact.sha256 ] \
  || bad "the pinned desk-agent release isn't installed as a rollout lays it out"
echo "desk-agent.service: $(systemctl is-active desk-agent.service), condition $(systemctl show -p ConditionResult --value desk-agent.service), restarts $(systemctl show -p NRestarts --value desk-agent.service)"
[ "$(systemctl show -p ConditionResult --value desk-agent.service)" = yes ] && systemctl is-active --quiet desk-agent.service \
  || bad "desk-agent.service should pass its condition and run"
out=$(RELEASE_DIR=$d/current timeout 30 $d/current/health 2>&1) && echo "desk-agent health: ok" || bad "desk-agent health: $out"
for d in docker.service desk-datadirs.service; do systemctl show -p Requires --value desk-agent.service | grep -q $d || bad "it should require $d"; done
for d in desk-agent-filter.service desk-egress.service; do
  systemctl show -p Wants --value desk-agent.service | grep -q $d && systemctl show -p After --value desk-agent.service | grep -q $d || bad "it should want and follow $d"
done
echo "--- its directories"
stat -c '%U:%G %a %n' /run/desk-agent /data/agent
[ "$(stat -c '%U:%G %a' /run/desk-agent)" = "agent:desk 2750" ] || bad "/run/desk-agent should be agent:desk 2750"
[ "$(stat -c '%U:%G %a' /data/agent)" = "agent:agent 700" ] || bad "/data/agent should be agent:agent 700"
id -nG agent | grep -qw desk && bad "agent is in group desk, which would open rtc.sock to it"
# A socket uid 1103 makes there is group desk by the setgid bit, as agent.sock will be: deskd (1100) connects, kiosk doesn't.
as 1103 python3 -I -c '
import os, socket, time
s = socket.socket(socket.AF_UNIX); s.bind("/run/desk-agent/verify.sock"); os.chmod("/run/desk-agent/verify.sock", 0o660); s.listen(4); time.sleep(6)' &
L=$!; sleep 1
echo "verify.sock: $(stat -c '%U:%G %a' /run/desk-agent/verify.sock)"
[ "$(stat -c '%U:%G' /run/desk-agent/verify.sock)" = agent:desk ] || bad "a socket made there isn't group desk"
conn() { as $1 python3 -I -c '
import socket
s = socket.socket(socket.AF_UNIX)
try: s.connect("/run/desk-agent/verify.sock"); print("connected")
except OSError as e: print(type(e).__name__)' 2>&1 | tail -1; }
c1100=$(conn 1100); c1102=$(conn 1102); echo "desk(1100): $c1100, kiosk(1102): $c1102"
[ "$c1100" = connected ] && [ "$c1102" = PermissionError ] || bad "the socket's group"
wait $L; rm -f /run/desk-agent/verify.sock
stat -c '%U:%G %a %n' /run/desk-agent/agent.sock /run/desk-agent/agent-admin.sock
[ "$(stat -c '%G' /run/desk-agent/agent.sock 2>&1)" = desk ] || bad "desk-agent's agent.sock isn't group desk"
[ "$(stat -c '%a' /run/desk-agent/agent-admin.sock 2>&1)" = 600 ] || bad "desk-agent's agent-admin.sock isn't 0600"
echo "deskd /health agent: $(curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://localhost/health | jq -r '.agent // "-"' 2>&1) (informational)"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "desk-agent: the pinned release baked in, running and healthy, /run/desk-agent 2750 agent:desk and its sockets' group, /data/agent 0700; a socket uid 1103 makes there is group desk" $rc < $WORKDIR/o

# ---- 3e0. desk-agent never starts without the ruleset (DA-2): it requires nftables.service, its ExecStartPre lists the
# agent chain, and /opt/ma/smoke-test fails without it. The table is removed and loaded again here (test only).
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $1"; echo FAILED; }
systemctl show -p Requires --value desk-agent.service | grep -qw nftables.service && systemctl show -p After --value desk-agent.service | grep -qw nftables.service \
  || bad "desk-agent should require and follow nftables.service"
systemctl cat desk-agent.service | grep -q '^ExecStartPre=/usr/sbin/nft list chain inet ma agent_redirect' || bad "no ExecStartPre listing the agent chain"
s=$(/opt/ma/smoke-test 2>&1); echo "$s" | grep nftables; grep -q 'nftables agent_redirect ok' <<<"$s" || bad "smoke-test doesn't check the chain"
echo "--- table inet ma removed (saved first as loaded, with the rules this test box added at boot, such as its SSH)"
nft list table inet ma > /var/tmp/ma-table.nft || bad "couldn't save the table"
nft delete table inet ma
s=$(/opt/ma/smoke-test 2>&1); echo "$s" | grep nftables; grep -q 'nftables FAIL' <<<"$s" || bad "smoke-test passed without table inet ma"
systemctl restart desk-agent.service 2>/dev/null; sleep 2
echo "desk-agent: $(systemctl is-active desk-agent.service)"; systemctl is-active --quiet desk-agent.service && bad "desk-agent started without table inet ma"
journalctl -u desk-agent --since -1min --no-pager | grep -m1 -E 'nft\[[0-9]+\]: Error' | cut -c1-200
echo "--- table inet ma back, exactly as saved"
nft -f /var/tmp/ma-table.nft || bad "couldn't load the table again"; rm -f /var/tmp/ma-table.nft
for i in $(seq 1 60); do systemctl is-active --quiet desk-agent.service && break; sleep 1; done
echo "desk-agent after $i s: $(systemctl is-active desk-agent.service)"; systemctl is-active --quiet desk-agent.service || bad "desk-agent didn't come back with the ruleset"
for i in $(seq 1 30); do s=$(/opt/ma/smoke-test 2>&1) && break; sleep 3; done   # desk-agent's health waits for its JVM
grep -q '^smoke-test: ok' <<<"$s" || { echo "$s"; bad "smoke test after"; }
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "desk-agent needs the ruleset (DA-2): Requires and After nftables.service, ExecStartPre lists agent_redirect; without table inet ma it doesn't start and smoke-test fails; with it back it starts by itself" $rc < $WORKDIR/o

# ---- 3e1. desk-agent-filter (ADR 0070): uid 1103 reaches only the providers' names, and everything else is refused. Its own
# file, so it can run alone on a lab box. It has been seen to fail with each thing it guards broken
# (evidence/agent-filter-2026-11-07/mutations.txt).
RS < "$HERE/verify-agent-filter.sh" > $WORKDIR/o 2>&1; rc=0
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "desk-agent-filter: uid 1103 reaches the three providers with their certificates, by name, by placeholder and aimed anywhere; a Cloudflare site that isn't listed is refused on the listed names' own addresses (with a control); no SNI, ECH, by IP, UDP 443, other ports, unlisted names and TXT are refused, on the host and in a container; only uid 1103 reaches its ports; uid 1106 reaches only TCP 443 and the stub; with it stopped uid 1103 has no way out and nothing can stand in; it comes back by itself; its traffic is in class 1:20" $rc < $WORKDIR/o
# ---- 3f. A stop, then a start, of deskd, desk-agent and desk-notebook leaves none of them failed. On docker stop the JVMs
# exit 143, which the docker client passes on, so before 0.2.9's SuccessExitStatus=143 each stop of deskd or desk-agent
# ended its unit as failed (0.2.8's note in RELEASES.md). desk-notebook's Node exits 0. Seen to fail on 0.2.8 (RELEASES.md,
# 0.2.9). Each unit comes back healthy before the next one stops.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $1"; echo FAILED; }
show() { systemctl show -p ActiveState -p Result -p ExecMainCode -p ExecMainStatus -p NRestarts $1.service | paste -sd' '; }
healthy() { RELEASE_DIR=/opt/ma/$1/current timeout 30 /opt/ma/$1/current/health >/dev/null 2>&1 </dev/null; }
for u in deskd desk-agent desk-notebook; do
  if ! systemctl is-active --quiet $u.service; then bad "$u isn't running to start with: $(show $u)"; continue; fi
  systemctl stop $u.service; e=$?
  echo "$u: stop exit $e, then $(show $u)"
  [ $e = 0 ] || bad "systemctl stop $u exited $e"
  [ "$(systemctl is-active $u.service)" = inactive ] || bad "$u should be inactive after a stop, not $(systemctl is-active $u.service)"
  [ "$(systemctl show -p Result --value $u.service)" = success ] || bad "$u's stop should end with result success"
  systemctl start $u.service; e=$?
  for i in $(seq 1 120); do healthy $u && break; sleep 1; done
  echo "$u: start exit $e, health answered after $i s, then $(show $u)"
  [ $e = 0 ] && systemctl is-active --quiet $u.service || bad "$u should be running after a start"
  healthy $u || bad "$u's health doesn't answer after a start"
  systemctl is-failed --quiet $u.service && bad "$u is failed after a start"
done
f=$(systemctl list-units --failed --plain --no-legend 2>&1); echo "failed units: ${f:-none}"
for u in deskd desk-agent desk-notebook; do grep -q "^$u\.service" <<<"$f" && bad "$u is listed as failed"; done
s=$(/opt/ma/smoke-test 2>&1); echo "$s"; grep -q '^smoke-test: ok' <<<"$s" || bad "smoke test"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "unit stop and start: deskd, desk-agent and desk-notebook each end a stop inactive, not failed, and come back healthy" $rc < $WORKDIR/o
# ---- 4. ma-update with a dummy component (run, health, small image.tar)
D=$WORKDIR/dummy; mkdir -p $D
mkart() { # mkart <version> <healthy:yes|no> -> $D/dummy-<version>.tgz
  local v=$1 w=$D/w-$1; rm -rf $w; mkdir -p $w
  echo "$v" > $w/VERSION
  printf '#!/bin/sh\necho "dummy %s running"\nexec sleep infinity\n' "$v" > $w/run
  if [ "$2" = yes ]; then printf '#!/bin/sh\nsystemctl is-active --quiet dummy\n' > $w/health
  else printf '#!/bin/sh\necho "dummy %s is unhealthy" >&2\nexit 1\n' "$v" > $w/health; fi
  chmod 755 $w/run $w/health
  tar -C $w -czf $D/dummy-$v.tgz .; sha256sum $D/dummy-$v.tgz | cut -d' ' -f1 > $D/dummy-$v.sha
}
mkart 1.0.0 yes; mkart 2.0.0 yes; mkart 3.0.0 no
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $D/*.tgz "admin@$IP:/var/tmp/" >/dev/null
cat > $D/dummy.service <<'U'
[Unit]
Description=dummy component for verify
[Service]
Environment=RELEASE_DIR=/opt/ma/dummy/current
ExecStart=/opt/ma/dummy/current/run
Restart=always
U
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $D/dummy.service "admin@$IP:/var/tmp/" >/dev/null
SHA1=$(cat $D/dummy-1.0.0.sha); SHA2=$(cat $D/dummy-2.0.0.sha); SHA3=$(cat $D/dummy-3.0.0.sha); 
RS <<X > $WORKDIR/o 2>&1; rc=0
cd /var/tmp; cp dummy.service /etc/systemd/system/dummy.service; systemctl daemon-reload
st() { echo "   state: current=\$(readlink /opt/ma/dummy/current | xargs -r basename) previous=\$(readlink /opt/ma/dummy/previous | xargs -r basename) unit=\$(systemctl is-active dummy)"; }
# desk-egress (ADR 0036) rewrites /data/desk-egress/state.json every tick, as Chromium, deskd, desk-agent and a baked desk-notebook write theirs.
datafiles() { find /data -xdev \( -path /data/browser -o -path /data/desk -o -path /data/desk-egress -o -path /data/agent -o -path /data/notebook \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
datahash() { datafiles | sha256sum | cut -c1-16; }
F0=\$(datafiles); H0=\$(datahash); echo "/data hash before (everything except /data/browser, /data/desk, /data/desk-egress, /data/agent and /data/notebook, which a running Chromium, deskd, desk-egress, desk-agent and desk-notebook keep writing): \$H0"
exp() { if [ "\$1" = "\$2" ]; then echo "ok: \$3 (exit \$2)"; else echo "BAD: \$3 expected exit \$1 got \$2"; echo FAILED; fi; }
echo "== real smoke test before dummy is installed: the baked releases only"; /opt/ma/smoke-test; exp 0 \$? "smoke-test with the baked releases"
echo "== wrong sha256 is rejected, nothing changes"; /opt/ma/bin/ma-update dummy file:///var/tmp/dummy-1.0.0.tgz 0000000000000000000000000000000000000000000000000000000000000000; exp 2 \$? "bad sha"; st
echo "== install 1.0.0"; /opt/ma/bin/ma-update dummy file:///var/tmp/dummy-1.0.0.tgz $SHA1; exp 0 \$? "install 1.0.0"; st
echo "== update to 2.0.0"; /opt/ma/bin/ma-update dummy file:///var/tmp/dummy-2.0.0.tgz $SHA2; exp 0 \$? "update 2.0.0"; st
echo "== rollback"; /opt/ma/bin/ma-update dummy --rollback; exp 0 \$? "rollback"; st
cat /opt/ma/dummy/current/VERSION
echo "== update to 3.0.0 whose health fails: automatic rollback"; /opt/ma/bin/ma-update dummy file:///var/tmp/dummy-3.0.0.tgz $SHA3; exp 1 \$? "failing update rolled back"; st
ls /opt/ma/dummy/releases
echo "== real smoke test with dummy installed"; /opt/ma/smoke-test; exp 0 \$? "smoke-test with healthy dummy"
H1=\$(datahash); echo "/data hash after: \$H1"; [ "\$H0" = "\$H1" ] && echo "ok: /data untouched" || { echo "BAD: /data changed:"; diff <(echo "\$F0") <(datafiles) | awk '/^[<>]/{print "   " \$1, \$3}'; echo FAILED; }
X
if grep -q -e '^ *FAILED$' -e '^ *BAD' $WORKDIR/o || ! grep -q 'rollback' $WORKDIR/o; then rc=1; fi
# check expected end states
grep -q 'ok: failing update rolled back' $WORKDIR/o || rc=1
result "ma-update: install, update, one-step rollback, automatic rollback on failing health, /data untouched" $rc < $WORKDIR/o

# docker image path: build a tiny image from alpine, ship as image.tar
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
cd /var/tmp
# Pulled here because ma-update's cleanup removes any image no release names, so the IMDS check's copy is gone by now.
A=public.ecr.aws/docker/library/alpine:3; docker pull $A 2>&1 | tail -1
IMG=$(docker images -q $A | head -1); echo "test image: $IMG"; [ -n "$IMG" ] || { echo "BAD: no test image"; exit 1; }
docker tag $IMG ma/dummy:img
w=/var/tmp/w-img; rm -rf $w; mkdir $w; echo img-1 > $w/VERSION
printf '#!/bin/sh\nexec docker run --rm --name dummy-img --network host --user 1100:1100 "$(cat "$RELEASE_DIR/image-id")" sleep infinity\n' > $w/run
printf '#!/bin/sh\ndocker inspect -f "{{.State.Running}}" dummy-img | grep -q true\n' > $w/health
chmod 755 $w/run $w/health
docker save ma/dummy:img -o $w/image.tar; tar -C $w -czf /var/tmp/dummyimg.tgz .
docker rmi ma/dummy:img >/dev/null; docker rmi -f $IMG >/dev/null 2>&1 || true
cat > /etc/systemd/system/dummyimg.service <<'U'
[Service]
Environment=RELEASE_DIR=/opt/ma/dummyimg/current
ExecStartPre=-/usr/bin/docker rm -f dummy-img
ExecStart=/opt/ma/dummyimg/current/run
Restart=always
U
systemctl daemon-reload
/opt/ma/bin/ma-update dummyimg file:///var/tmp/dummyimg.tgz $(sha256sum /var/tmp/dummyimg.tgz | cut -d' ' -f1); rc=$?
echo "exit $rc"; cat /opt/ma/dummyimg/current/image-id; ls /opt/ma/dummyimg/current/
docker ps --format '{{.Names}} {{.Image}}'
[ $rc = 0 ] && [ ! -e /opt/ma/dummyimg/current/image.tar ] && [ -s /opt/ma/dummyimg/current/image-id ] && docker ps --format '{{.Names}}' | grep -q '^dummy-img$'
X
result "ma-update with image.tar: docker load, image-id written, image.tar deleted, container runs" $rc < $WORKDIR/o

# ---- 4a. ma-update on top of the baked releases: each one forward and back, the baked artifact again, and one left
# forward for the root replacement at the end. A copy of the current release under another VERSION stands in for a new
# one; deskd's copy keeps its image-id, so it needs no image.tar. desk-stream's real artifact comes from the release bucket.
DS_SHA=$(aws s3 cp --only-show-errors "s3://$RELEASE_BUCKET/desk/desk-stream/$T_STREAM/meta.json" - | jq -r .sha256)
DS_URL=$(aws s3 presign "s3://$RELEASE_BUCKET/desk/desk-stream/$T_STREAM/desk-stream-$T_STREAM.tgz" --expires-in 900)
{ printf 'WANT=%q; DS_SHA=%q; DS_URL=%q\n' "$WANT" "$DS_SHA" "$DS_URL"; cat <<'X'
rc=0; bad() { echo "BAD: $*"; rc=1; }
st() { local d=/opt/ma/$1; echo "   $1: current $(readlink $d/current | xargs -r basename), previous $(readlink $d/previous | xargs -r basename), unit $(systemctl is-active $1)"; }
link() { readlink /opt/ma/$1/$2 | xargs -r basename; }
# deskd keeps its own files in /data/desk while it runs, Chromium in /data/browser, desk-egress in /data/desk-egress, desk-agent in /data/agent and desk-notebook in /data/notebook
datahash() { find /data -xdev \( -path /data/browser -o -path /data/desk -o -path /data/desk-egress -o -path /data/agent -o -path /data/notebook \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16; }
pack() { # pack <component> <version> [extra line for stream.conf]: a copy of the current release as /var/tmp/<component>-<version>.tgz
  local w=/var/tmp/w-$1; rm -rf $w; cp -a /opt/ma/$1/current/. $w/; rm -f $w/artifact.sha256; echo "$2" > $w/VERSION
  [ -z "${3:-}" ] || echo "$3" >> $w/stream.conf
  tar -C $w -czf /var/tmp/$1-$2.tgz .; sha256sum /var/tmp/$1-$2.tgz | cut -d' ' -f1; }
H0=$(datahash); R0=$(sha256sum /data/rtc/dtls-identity.pem | cut -c1-16); echo "/data hash (without browser, desk, desk-egress, agent and notebook) $H0, DTLS identity $R0"
for cv in $WANT; do comp=${cv%%=*}; base=${cv#*=}
  [ "$(link $comp current)" = "$base" ] || bad "$comp isn't on the baked $base to start with"
  s=$(pack $comp verify-fwd)
  echo "== $comp: forward from the baked $base"; /opt/ma/bin/ma-update $comp file:///var/tmp/$comp-verify-fwd.tgz $s; e=$?; st $comp
  [ $e = 0 ] && [ "$(link $comp current)" = verify-fwd ] && [ "$(link $comp previous)" = "$base" ] || bad "$comp forward (exit $e)"
  echo "== $comp: --rollback"; /opt/ma/bin/ma-update $comp --rollback; e=$?; st $comp
  [ $e = 0 ] && [ "$(link $comp current)" = "$base" ] && [ "$(link $comp previous)" = verify-fwd ] || bad "$comp back to the baked release (exit $e)"
done
[ "$(docker inspect -f '{{.Image}}' deskd)" = "$(cat /opt/ma/deskd/current/image-id)" ] && echo "deskd runs the baked image again" || bad "deskd's container"
echo "== desk-stream: the baked release's own artifact again, as a rollout of the baked version sends it"
b=$(link desk-stream current)/$(link desk-stream previous)
/opt/ma/bin/ma-update desk-stream "$DS_URL" "$DS_SHA"; e=$?; st desk-stream
[ $e = 0 ] && [ "$(link desk-stream current)/$(link desk-stream previous)" = "$b" ] || bad "the same artifact again (exit $e)"
echo "== desk-stream: the baked version from another artifact is refused"
s=$(pack desk-stream "$(link desk-stream current)" "# another artifact"); /opt/ma/bin/ma-update desk-stream file:///var/tmp/desk-stream-$(link desk-stream current).tgz $s; e=$?; st desk-stream
[ $e = 2 ] && [ "$(link desk-stream current)/$(link desk-stream previous)" = "$b" ] || bad "another artifact under the same version (exit $e)"
echo "== desk-rtc: forward to verify-swap, left there for the root replacement at the end"
s=$(pack desk-rtc verify-swap); /opt/ma/bin/ma-update desk-rtc file:///var/tmp/desk-rtc-verify-swap.tgz $s; e=$?; st desk-rtc
[ $e = 0 ] && [ "$(link desk-rtc current)" = verify-swap ] || bad "desk-rtc forward to verify-swap (exit $e)"
s=$(/opt/ma/smoke-test 2>&1); echo "$s"; grep -q '^smoke-test: ok' <<<"$s" || bad "smoke test"
H1=$(datahash); R1=$(sha256sum /data/rtc/dtls-identity.pem | cut -c1-16); echo "/data hash after $H1, DTLS identity $R1"
[ "$H0" = "$H1" ] && [ "$R0" = "$R1" ] || bad "/data or the DTLS identity changed"
rm -rf /var/tmp/w-* /var/tmp/*-verify-fwd.tgz /var/tmp/*-verify-swap.tgz /var/tmp/desk-stream-*.tgz
exit $rc
X
} | RS > $WORKDIR/o 2>&1; rc=$?; DS_URL=
result "ma-update on the baked releases: each one forward and back to the baked one; the baked artifact again changes nothing; another artifact under its version is refused; /data and the DTLS identity untouched" $rc < $WORKDIR/o

# ---- 5. listeners, chrony, ssh, resources
RS <<'X' > $WORKDIR/o 2>&1; rc=0
echo "=== boot-time state (before user data re-enabled SSH for this test)"; cat /var/tmp/prestate.txt
echo "=== ss -lntup now"; ss -lntup
echo "=== chrony"; chronyc tracking; chronyc sources
echo "=== nft ruleset loaded"; nft list chain inet ma input | head -3
X
# cloud-init creates EMPTY authorized_keys files at first boot when no key is given: only non-empty files count
sed -n '/authorized_keys files at boot/,/== cloud-init/p' $WORKDIR/o | grep -E '^-rw' | awk '$5 > 0' | grep -q . && rc=1
sed -n '/ssh enabled/,/ssh active/p' $WORKDIR/o | grep -q '^enabled' && rc=1
chronyc_ok=0; grep -q 'Leap status *: Normal' $WORKDIR/o && grep -q '\^\* 169.254.169.123' $WORKDIR/o && chronyc_ok=1
[ $chronyc_ok = 1 ] || rc=1
result "boot state: no authorized_keys, ssh disabled; listeners below; chrony synced to 169.254.169.123" $rc < $WORKDIR/o

# The bake's journal doesn't reach the image. This box's own journal does hold this script's logins, so it's the directories that are checked, not the text.
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
rc=0
id=$(cat /etc/machine-id); echo "machine ID: $id"; echo "/var/log/journal: $(ls -A /var/log/journal | paste -sd' ')"
[ -n "$id" ] && [ "$(ls -A /var/log/journal)" = "$id" ] || { echo "BAD: a directory other than this boot's machine ID"; rc=1; }
[ ! -e /run/systemd/journald.conf.d/zz-bake-volatile.conf ] || { echo "BAD: the bake's drop-in reached the image"; rc=1; }
logger -t verify-journal "marker $id"; sleep 2
n=$(journalctl -b -t verify-journal --no-pager -o cat | grep -c "marker $id"); echo "marker lines read back: $n"; [ "$n" -ge 1 ] || { echo "BAD: the journal doesn't work"; rc=1; }
[ -s "/var/log/journal/$id/system.journal" ] || { echo "BAD: the journal isn't persistent"; rc=1; }
exit $rc
X
result "journal: only this boot's machine ID under /var/log/journal, persistent, and working" $rc < $WORKDIR/o

RS <<'X' > $WORKDIR/o 2>&1; rc=0
systemctl stop desk-stream desk-browser desk-xorg desk-audio dummy dummyimg 2>/dev/null
echo "=== idle with desk-xorg/audio/browser stopped (the image as it boots)"
sleep 20
read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 _ < /proc/stat; sleep 30; read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
t1=$((u1+n1+s1+i1+w1+q1+sq1+st1)); t2=$((u2+n2+s2+i2+w2+q2+sq2+st2))
echo "idle CPU busy: $(( 100*( (t2-t1) - (i2-i1) - (w2-w1) ) / (t2-t1) )) % over 30 s"
free -m | sed -n 1,3p
echo "=== boot timing"; systemd-analyze time; systemd-analyze blame | head -6
for u in desk-firstboot desk-datadirs docker chrony nftables amazon-ssm-agent; do
  echo "$u active at $(( $(systemctl show -p ActiveEnterTimestampMonotonic --value $u) / 1000000 )) s after kernel start"; done
echo "=== idle with Chromium kiosk running"
systemctl start desk-browser || { journalctl -u desk-xorg -u desk-audio -u desk-browser --no-pager -n 40; systemctl status desk-xorg desk-audio --no-pager | head -30; }; sleep 40
read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 _ < /proc/stat; sleep 30; read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ < /proc/stat
t1=$((u1+n1+s1+i1+w1+q1+sq1+st1)); t2=$((u2+n2+s2+i2+w2+q2+sq2+st2))
echo "busy: $(( 100*( (t2-t1) - (i2-i1) - (w2-w1) ) / (t2-t1) )) % over 30 s"
free -m | sed -n 1,3p
df -h / /data | sed 's/^/df: /'
X
info "idle CPU, RAM, boot time" < $WORKDIR/o
cat $WORKDIR/o >&2

# ---- 6. The same session through a real EC2 stop and start, then a real root replacement. Last, because the swap removes /opt/ma and /var/tmp.
readback() { # readback <label>: start the browser and read the session back
  scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $WORKDIR/sv.py "admin@$IP:/var/tmp/sv.py" >/dev/null
  RS <<X > $WORKDIR/o 2>&1; local rc=0
chmod 644 /var/tmp/sv.py; systemctl stop verify-pages 2>/dev/null; systemd-run --quiet --collect --unit=verify-pages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/sv.py serve; sleep 1
systemctl start desk-browser
for i in \$(seq 1 180); do curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done; sleep 10
python3 -I /var/tmp/sv.py read "$1"
X
  grep -q -e '^FAILED$' -e '^BAD$' $WORKDIR/o && rc=1
  [ "$(grep -c '^ok$' $WORKDIR/o)" = 1 ] || rc=1   # a read that crashed prints neither ok nor BAD
  result "browser session: cookies and history survive $1" $rc < $WORKDIR/o
}
# ADR 0045: the stop below shuts the guest down with Chromium frozen and a cookie set before the freeze. A shutdown can't
# thaw it through systemd (a thaw is refused while a job is pending), so desk-browser-thaw.service writes the cgroup itself,
# before desk-browser's stop. Judged after the start, before anything starts Chromium again.
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
rc=0
chmod 644 /var/tmp/fz.py; systemctl stop verify-fz-pages 2>/dev/null
systemd-run --quiet --collect --unit=verify-fz-pages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/fz.py serve; sleep 1
systemctl start desk-browser; for i in $(seq 1 90); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 1; done; sleep 5
V=v$RANDOM$RANDOM; python3 -I /var/tmp/fz.py setcookie $V; echo $V > /var/tmp/fz-shutdown-cookie; sleep 5   # inside Chromium's 30 s commit
for i in 1 2 3 4 5 6; do   # the desk's own traffic can make it busy network, as in 3b2a
  r=$(setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I /var/tmp/fz.py ask 'freeze desk-browser' 2>/dev/null)
  [ "$r" = "err busy network" ] || break; echo "(busy network, try $i)"; sleep 3
done
echo "freeze before the stop: $r, cgroup $(grep frozen /sys/fs/cgroup/system.slice/desk-browser.service/cgroup.events), deskd $(systemctl is-active deskd)"
[ "$r" = ok ] || rc=1
exit $rc
X
cat $WORKDIR/o >> "$EV"; FROZE=$rc
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null; aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(getip); wait_ssh "$IP" "$KEY_FILE" 300 || die "no ssh after stop/start"
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
rc=0
bad() { echo "BAD: $*"; rc=1; }
e=$(jq -r .profile.exit_type /data/browser/profile/Default/Preferences); echo "exit_type, before anything starts Chromium: $e"
# Normal: quit over CDP by desk-browser-thaw. SessionEnded would be Chromium's own session end (logind's PrepareForShutdown,
# or SIGTERM), which leaves cookies younger than about 30 s unwritten.
[ "$e" = Normal ] || bad "Chromium wasn't quit over CDP on the way down (exit_type $e)"
q=$(journalctl -b -1 --no-pager -o cat -u desk-browser-thaw | grep -E '^desk-browser-(quit|close --quit):' | tail -1); echo "$q"
case "$q" in *quit=cdp*) ;; *) bad "desk-browser-thaw's quit didn't quit Chromium over CDP" ;; esac
# The shutdown's part of the journal: from desk-browser-thaw's last stop on. Chromium once quit by itself here, as soon as it
# was thawed: it was on the system bus and took logind's PrepareForShutdown (SessionEnded, recent cookies unwritten). Kept off
# the bus (desk-browser.service), it waits for desk-browser-thaw's quit over CDP.
j=$(journalctl -b -1 --no-pager -o short-monotonic -u desk-browser -u desk-browser-thaw | grep -v 'desk-browser-start\[')
t=$(grep 'Stopping desk-browser-thaw' <<<"$j" | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/')
[ -n "$t" ] || bad "desk-browser-thaw didn't stop on the way down"
w=$(awk -v t="${t:-0}" '{ s = substr($0, 2, index($0, "]") - 2) + 0 } s >= t' <<<"$j"); echo "$w" | grep -E 'Stopping|Stopped|Deactivated|Killing|timed out|frozen|Failed|desk-browser-(quit|close)' | tail -8
grep -E 'desk-browser.service: (Killing|State .* timed out|Failed with)|Cannot stop frozen' <<<"$w" && bad "systemd had to kill Chromium, or couldn't stop it"
grep -q 'Stopped desk-browser.service' <<<"$w" || bad "desk-browser didn't stop after desk-browser-thaw began"
# T46L-1: deskd, the only thing that asks for a freeze, stopped before desk-browser-thaw's thaw and quit began (Before=deskd.service).
d=$(journalctl -b -1 --no-pager -o short-monotonic -u deskd | grep -E 'Stopped deskd.service' | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/')
echo "deskd stopped at ${d:-never}, desk-browser-thaw began stopping at ${t:-never} (monotonic s)"
[ -n "$d" ] && [ -n "$t" ] && awk -v d="$d" -v t="$t" 'BEGIN { exit !(d <= t) }' || bad "deskd hadn't stopped when desk-browser-thaw began its thaw and quit"
exit $rc
X
result "ADR 0045: a guest shutdown with Chromium frozen thawed it first, after deskd had stopped (T46L-1), then quit it over CDP, and it ended its session cleanly, no kill" $(( FROZE | rc )) < $WORKDIR/o
readback "a real EC2 stop and start"
RS <<'X' > $WORKDIR/o 2>&1; rc=$?
rc=0
chmod 644 /var/tmp/fz.py; systemctl stop verify-fz-pages 2>/dev/null
systemd-run --quiet --collect --unit=verify-fz-pages --uid=65534 --gid=65534 /usr/bin/python3 -I /var/tmp/fz.py serve; sleep 1
out=$(python3 -I /var/tmp/fz.py cookie "$(cat /var/tmp/fz-shutdown-cookie)" 'after a shutdown with Chromium frozen:' 2>&1); echo "$out"
[ "$(tail -1 <<<"$out")" = ok ] || rc=1
echo "cgroup after the start: $(grep frozen /sys/fs/cgroup/system.slice/desk-browser.service/cgroup.events)"
systemctl stop verify-fz-pages
exit $rc
X
result "ADR 0045: a cookie set 5 s before that freeze came through the shutdown" $rc < $WORKDIR/o
TASK=$(aws ec2 create-replace-root-volume-task --instance-id "$INSTANCE_ID" --delete-replaced-root-volume --tag-specifications "ResourceType=replace-root-volume-task,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform}]" --query ReplaceRootVolumeTask.ReplaceRootVolumeTaskId --output text)
for i in $(seq 1 90); do st=$(aws ec2 describe-replace-root-volume-tasks --replace-root-volume-task-ids "$TASK" --query 'ReplaceRootVolumeTasks[0].TaskState' --output text); [ "$st" = succeeded ] || [ "$st" = failed ] && break; sleep 10; done
say "second replace-root task $TASK: $st"
sleep 20; wait_ssh "$IP" "$KEY_FILE" 420 || die "no ssh after the second root replacement"
R 'cloud-init status --wait >/dev/null 2>&1; true'
readback "a real root replacement"

# ---- 6a. What a root swap does now: it brings back the releases baked into the image, which can be older than what ran.
{ printf 'WANT=%q; RTCID=%q; N_BAKED=%q\n' "$WANT" "$RTCID" "$N_BAKED"; echo "$BOOTTIMES"; echo "$AGENTWAIT"; cat <<'X'
rc=0; bad() { echo "BAD: $*"; rc=1; }
echo "--- after the root replacement; desk-rtc was at verify-swap before it"; boottimes; agentwait; notebookwait
for cv in $WANT; do comp=${cv%%=*}; ver=${cv#*=}; d=/opt/ma/$comp
  echo "$comp: current $(readlink $d/current), previous $(readlink $d/previous || echo none), releases $(ls $d/releases | paste -sd' ')"
  [ "$(readlink $d/current)" = "$d/releases/$ver" ] && [ ! -e $d/previous ] && [ "$(ls $d/releases)" = "$ver" ] || bad "$comp isn't the baked $ver"
done
systemctl is-active --quiet desk-rtc && systemctl is-active --quiet deskd && systemctl is-active --quiet desk-agent && systemctl is-active --quiet desk-agent-filter || bad "desk-rtc, deskd, desk-agent and desk-agent-filter should be running"
[ "$(docker inspect -f '{{.Image}}' deskd 2>&1)" = "$(cat /opt/ma/deskd/current/image-id)" ] || bad "deskd's container isn't on the baked image"
[ "$(docker inspect -f '{{.Image}}' desk-agent 2>&1)" = "$(cat /opt/ma/desk-agent/current/image-id)" ] || bad "desk-agent's container isn't on the baked image"
# /data/notebook is on the volume, so it stays whichever way the bake went. Its unit comes back as the bake left it.
[ "$(stat -c '%u:%g %a' /data/notebook 2>&1)" = "1105:1105 700" ] || bad "/data/notebook should still be 1105:1105 700"
case " $WANT " in
  *" desk-notebook="*)
    systemctl is-active --quiet desk-notebook || bad "desk-notebook should be running"
    [ "$(docker inspect -f '{{.Image}}' desk-notebook 2>&1)" = "$(cat /opt/ma/desk-notebook/current/image-id)" ] || bad "desk-notebook's container isn't on the baked image" ;;
  *)
    [ ! -e /opt/ma/desk-notebook ] && [ "$(systemctl is-active desk-notebook)" = inactive ] || bad "with no pin, desk-notebook should have no release and stay skipped" ;;
esac
s=$(/opt/ma/smoke-test 2>&1); echo "$s"; grep -q "^smoke-test: ok ($((N_BAKED + 1)) component(s))\$" <<<"$s" || bad "smoke test"
r=$(sha256sum /data/rtc/dtls-identity.pem | cut -c1-16); echo "DTLS identity $r, first boot $RTCID"; [ "$r" = "$RTCID" ] || bad "the DTLS identity changed"
echo "/data/desk: $(find /data/desk -mindepth 1 | wc -l) entries (a verify box's deskd has no identity, so it writes nothing there)"
exit $rc
X
} | RS > $WORKDIR/o 2>&1; rc=$?
result "a root replacement brings back the baked releases (desk-rtc had been rolled forward), healthy, with this desk's DTLS identity kept on /data" $rc < $WORKDIR/o

# ---- 6b. A teen's lock on a new root. The lock is on the root, so the swap took it away; the band is on /data. This box has no band, so the helper has to put it back before Chromium starts.
RS <<'X' > $WORKDIR/o 2>&1; rc=0
bad() { echo "BAD: $*"; echo FAILED; }
L=/etc/chromium/policies/managed/ma-teen.json
band=$(cat /data/desk/age-band 2>/dev/null); echo "band: ${band:-none}"
journalctl -b -u desk-browser --no-pager -o cat | grep '^desk-browser-policy:' | sed 's/^/this boot: /'
if [ "$band" = adult ]; then echo "an adult band has no lock to put back, so this proves nothing here"; bad "this check needs no band, or teen"
else
  journalctl -b -u desk-browser --no-pager -o cat | grep -q '^desk-browser-policy: locked:' || bad "the helper didn't lock on this root"
  cmp -s "$L" /etc/ma/chromium-teen.json && echo "lock: $(stat -c '%U:%G %a' "$L")" || bad "no lock on the new root"
fi
curl -s -m 5 -o /dev/null http://127.0.0.1:9222/json/version && echo "Chromium is up" || bad "Chromium isn't up"
echo "ran to the end"
X
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "teen lock: a root replacement took the lock with the old root, and the helper put it back before Chromium started" $rc < $WORKDIR/o
# ---- 6c. The ad blocker on a new root: the per-site list is on /data and the policy on the root, so the helper has to render
# the list again before Chromium starts. The blocker itself is in the profile, on /data.
R "sudo bash -s -- swap" < "$HERE/verify-adblock.sh" > $WORKDIR/o 2>&1; rc=0
grep -q -e '^FAILED$' $WORKDIR/o && rc=1
grep -q '^ran to the end$' $WORKDIR/o || rc=1
result "ad blocking: a real root replacement kept the per-site list on /data, the helper put it in the policy before Chromium started, and the blocker is running with that site off and another blocked" $rc < $WORKDIR/o
# What the Platform gates a teen's desk on.
tag=$(aws ec2 describe-images --image-ids "$AMI" --query "Images[0].Tags[?Key=='DeskTeenLock']|[0].Value" --output text 2>&1)
[ "$tag" = 1 ]; rc=$?
result "teen lock: the AMI carries DeskTeenLock=1" $rc <<<"AMI $AMI tag DeskTeenLock: $tag"   # not a pipe: result in a subshell wouldn't count

# ---- 7. Desk batches and Debian's updates (S-96; image/README.md, "Desk batches and Debian's updates"; runtime spec section
# 6.1). Its own file, so it can run alone on a lab box (lab/desk-batch/lab.sh). Last, on the root the swap above brought
# from the AMI, so "never ran this boot" is checked on a fresh root's boot. Each part puts back what it changed, and each
# has been seen to fail with what it guards broken (evidence/desk-batch-2026-11-09/mutations.txt, mutations-2.txt).
for p in install apt closed socket idle prepare rollback apt-idle; do
  case $p in
    install) what="desk-batch's timer enabled and waiting, its socket /run/desk/batch.sock 0600 desk:desk, both key directories root's 0755, exactly Platform's release key (sha256 96287954...3f0a) in the image's and nothing in the drop-in, no batch pending" ;;
    apt) what="apt-daily and apt-daily-upgrade masked and not run this boot; unattended-upgrades allows Debian's security archive only, by apt-config and its own dry run; the installed Chromium comes from trixie-security" ;;
    closed) what="deskd's offer of a batch signed with a key the image doesn't trust is refused and nothing is pending" ;;
    socket) what="as deskd: status, hold up to 15 minutes, a signed offer taken; refused: another key, a byte changed, a seq below the pending one, a missing URL; uids 1101, 1102 and 1103 can't use it, root can; no URL in the journal" ;;
    idle) what="a pending batch waits with no idle.json, a stale one, one not deskd's, a session open or too short an idle, then applies on a fresh idle one and isn't taken again; an artifact whose bytes don't match switches nothing" ;;
    prepare) what="ma-update --prepare loads the image and switches nothing, --activate switches, a failing smoke test puts the old release back, previous is prepared from disk, --unprepare drops it, desk-rtc never restarted" ;;
    rollback) what="a two-component batch whose second fails its smoke test: the first rolled back, the batch rolled-back and its seq refused after" ;;
    apt-idle) what="desk-batch tick runs apt only while idle, not with no idle.json, and at nice 19 in the idle I/O class" ;;
  esac
  R "sudo bash -s -- $p" < "$HERE/verify-batch.sh" > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1
  grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "desk batches, $p: $what" $rc < $WORKDIR/o
done

# ---- 8. Faster wakes (TD-227; image/README.md "Faster wakes"; runtime spec section 3). Its own file, verify-wake.sh, so it can run
# alone on any desk over SSM. Last: it reboots the box several times. The kill switch the run set at its start comes off first.
R 'sudo rm -f /data/desk/no-prewarm'
wake_part() { # wake_part <part> <what>
  R "sudo bash -s -- $1" < "$HERE/verify-wake.sh" > $WORKDIR/o 2>&1; local rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1
  grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "faster wakes, $1: $2" $rc < $WORKDIR/o
}
reboot_box() { R "$1" >/dev/null 2>&1; sleep 20; wait_ssh "$IP" "$KEY_FILE" 300 || die "no ssh after a reboot in section 8"; }
wake_part static "cloud-final's drop-in writes the marker, the network fallback names no MAC and sorts after netplan's file, the prewarm unit is enabled and gated on the age band, the Guild Desk marker and the kill switch, and no Browser unit is enabled"
reboot_box 'sudo rm -f /etc/cloud/cloud-init.disabled; sudo reboot'
wake_part first "with the marker taken away, cloud-init runs the boot and cloud-final's drop-in writes it again"
reboot_box 'sudo reboot'
wake_part later "with the marker there, no cloud-init unit runs or logs, the desk has its address from netplan's file, its host name and IMDS"
wake_part fallback "with netplan's file naming another card, the MAC-free fallback takes the card and DHCP answers; the file is put back"
reboot_box 'echo adult | sudo tee /data/desk/age-band >/dev/null; sudo chown desk:desk /data/desk/age-band; sudo chmod 600 /data/desk/age-band; sudo reboot'
wake_part boot "with an age band on /data, the boot starts desk-xorg, desk-audio and desk-browser once deskd answers, after deskd, and leaves desk-stream to deskd"
wake_part gates "no age band, a Guild Desk marker and a refusing start check each leave the Browser stopped without failing the unit, and with them open it starts"
R 'sudo rm -f /data/desk/age-band; sudo systemctl stop desk-browser desk-audio desk-xorg 2>/dev/null; true'

say ""; say "SUMMARY: $PASS passed, $FAILN failed, and $INFON informational (recorded, not judged, not counted). Evidence: image/evidence/verify-$AMI.txt"
[ "$FAILN" = 0 ]
