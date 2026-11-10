#!/bin/bash
# count-address.sh <ami-id>: count this workstation's public address on a booted copy of the AMI. Counts only: the address
# is never printed or logged, and no file holds it but one in the reader's /run. Evidence goes to image/evidence/count-<ami>.txt.
# Exit 0 only if the count ran to its end, its control is above 0 and every count is 0; 1 otherwise. The verdict, and why,
# is the evidence's last line. count-address.sh --judge <evidence file> judges a count already made, with no AWS call.
# The box made from the AMI gets no key, no user data, no role and a group with no inbound rule, so nobody logs in to it.
# It boots, runs for a while and is stopped; its root then goes to a temporary reader (stock Debian 13 arm64) reached by SSH,
# which mounts it read-only and counts. The reader's own journal records that login, and it counts that as a control.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"

# judge <evidence file>: prints the verdict. 0 only if the count reached its last step, the control (the reader's own journal,
# which logged the login) is above 0, and every count of the address is 0. A count that isn't a number, such as a grep that
# failed, is a fail too.
judge() {
  local f=$1 why=() c v line
  [ -r "$f" ] || { echo "VERDICT: FAIL, no evidence file $f"; return 1; }
  while IFS= read -r line; do why+=("$line"); done < <(grep '^BAD' "$f")
  c=$(sed -n 's/^control, .*: *//p' "$f" | head -1)
  [[ $c =~ ^[0-9]+$ ]] && [ "$c" -gt 0 ] || why+=("the control is '${c:-missing}', not above 0, so a count of 0 proves nothing")
  while IFS= read -r line; do   # each machine-ID directory: in the files, in journalctl's text, and among sshd's sources
    v=$(sed -n "s/.*address count \([^ ]*\) in the files and \([^ ]*\) in journalctl's text.*among them \([^ ]*\)\$/\1 \2 \3/p" <<<"$line")
    [ "$v" = "0 0 0" ] || why+=("${line#  }")
  done < <(grep ' directory: .*address count ' "$f")
  while IFS= read -r line; do   # by path, the root filesystem and the raw partition
    [ "${line##*: }" = 0 ] || why+=("${line#  }")
  done < <(sed -n '/^== address count by path/,/^== /{/^  /p}' "$f")
  grep -q '^  the raw partition, free blocks included: ' "$f" || why+=("the count didn't reach its last step, the raw partition")
  if [ ${#why[@]} = 0 ]; then echo "VERDICT: pass, control $c and every count 0"; return 0; fi
  echo "VERDICT: FAIL"; printf '  %s\n' "${why[@]}"; return 1
}
if [ "${1:-}" = --judge ]; then [ $# = 2 ] || die "usage: count-address.sh --judge <evidence file>"; judge "$2"; exit; fi

AMI=${1:-}; [[ $AMI =~ ^ami-[0-9a-f]+$ ]] || die "usage: count-address.sh <ami-id> | count-address.sh --judge <evidence file>"
TYPE=${COUNT_TYPE:-t4g.small}
INSTANCE_ID=; READER=; SG_ID=; KEY_NAME=; WORKDIR=; TSG=; VOL=
mkdir -p "$HERE/evidence"; EV=$HERE/evidence/count-$AMI.txt; : > "$EV"
say() { echo "$*" | tee -a "$EV" >&2; }
cleanup() {
  local rc=$?; trap - EXIT; log "cleanup"
  set +e
  [ -z "$INSTANCE_ID" ] || aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null 2>&1
  destroy_temp_access "$READER"; set +e   # the reader, its key and group
  if [ -n "$INSTANCE_ID" ]; then aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"; log "instance $INSTANCE_ID terminated"; fi
  if [ -n "$VOL" ]; then   # detached from the box, so termination doesn't delete it
    aws ec2 wait volume-available --volume-ids "$VOL" 2>/dev/null
    aws ec2 delete-volume --volume-id "$VOL" 2>/dev/null && log "deleted $VOL"
  fi
  if [ -n "$TSG" ]; then for _ in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$TSG" >/dev/null 2>&1 && { log "deleted sg $TSG"; break; }; sleep 5; done; fi
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 130' INT TERM

ADDR=$(my_ip); [[ $ADDR =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "can't read this workstation's address"
make_temp_access "ma-desk-count-$$"
vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
TSG=$(aws ec2 create-security-group --group-name "ma-desk-count-box-$$" --description "temporary, no inbound" --vpc-id "$vpc" \
  --tag-specifications "$(tagspec security-group)" --query GroupId --output text) || die "no group"
INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 --security-group-ids "$TSG" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --tag-specifications "$(tagspec instance)" "$(tagspec volume)" --query 'Instances[0].InstanceId' --output text) || die "run-instances failed"
BASE=$(aws ssm get-parameter --name /aws/service/debian/release/13/latest/arm64 --query Parameter.Value --output text)
# The reader mounts the box's root, so it has to be in the box's zone (2026-11-07: one count failed on InvalidVolume.ZoneMismatch).
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
READER=$(aws ec2 run-instances --image-id "$BASE" --instance-type "$TYPE" --count 1 --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
  --placement "AvailabilityZone=$AZ" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --tag-specifications "$(tagspec instance)" "$(tagspec volume)" --query 'Instances[0].InstanceId' --output text) || die "reader failed"
log "box $INSTANCE_ID from $AMI (no key, no inbound), reader $READER from $BASE"
aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID" || die "box never passed its status checks"
sleep "${COUNT_UPTIME:-120}"   # let first boot finish and the journal flush to /var/log/journal
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
VOL=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' --output text)
aws ec2 detach-volume --volume-id "$VOL" >/dev/null; aws ec2 wait volume-available --volume-ids "$VOL"
aws ec2 wait instance-running --instance-ids "$READER"
IP=$(aws ec2 describe-instances --instance-ids "$READER" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
wait_ssh "$IP" "$KEY_FILE" || die "reader never accepted ssh"
aws ec2 attach-volume --volume-id "$VOL" --instance-id "$READER" --device /dev/sdf >/dev/null; aws ec2 wait volume-in-use --volume-ids "$VOL"
say "AMI $AMI ($(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text)), booted once as $INSTANCE_ID, stopped, root $VOL read on $READER, $(date -u +%FT%TZ)"

# The address reaches the reader only in this script's text, over SSH; the reader keeps it in a file in /run and is terminated.
{ printf "ADDR='%s'; VOL='%s'\n" "$ADDR" "$VOL"; cat <<'X'
set -u
PAT=$(mktemp -p /run); printf '%s\n' "$ADDR" > "$PAT"; unset ADDR
# n <grep options and paths>: occurrences under the paths that exist. ERROR if grep itself failed, so an aborted grep can't
# read as 0; and with no path left, 0, since grep -r with no path would search the current directory.
n() {
  local a=() p k=0 c
  for p in "$@"; do case $p in -*) a+=("$p") ;; *) [ -e "$p" ] && { a+=("$p"); k=$((k+1)); } ;; esac; done
  [ "$k" -gt 0 ] || { echo 0; return; }
  c=$(grep -r -a -o -h -F -f "$PAT" --devices=skip "${a[@]}" 2>/dev/null | wc -l; exit "${PIPESTATUS[0]}")
  case $? in 0|1) echo "$c" ;; *) echo "ERROR" ;; esac
}
dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOL//-/}
for _ in $(seq 60); do [ -e "$dev" ] && break; sleep 2; done
part=$(lsblk -nrpo NAME,FSTYPE "$dev" | awk '$2=="ext4"{print $1}' | head -1)
T=/mnt/box; mkdir -p $T; mount -o ro,noload "$part" $T || { echo "BAD: can't mount the box's root"; exit 1; }
echo "image: $(paste -sd' ' $T/etc/ma-release 2>/dev/null)"
echo "control, the reader's own journal, which logged this login (must be above 0): $(n /var/log/journal /run/log/journal)"
mid=$(cat $T/etc/machine-id); dirs=$(ls -A $T/var/log/journal 2>/dev/null)
echo "== /var/log/journal: $(echo "$dirs" | grep -c .) machine-ID directories; this boot's ID among them: $([ -n "$mid" ] && [ -d "$T/var/log/journal/$mid" ] && echo yes || echo no)"
for d in $dirs; do
  J=(journalctl --directory="$T/var/log/journal/$d" --no-pager)
  srcs=$("${J[@]}" -o cat 2>/dev/null | grep -oE ' from [0-9]+(\.[0-9]+){3} port ' | awk '{print $2}' | sort -u)   # held, never printed
  echo "  $([ "$d" = "$mid" ] && echo "this boot's" || echo "another machine's") directory: $(ls "$T/var/log/journal/$d" | wc -l) files," \
    "$("${J[@]}" -F _BOOT_ID 2>/dev/null | wc -l) boots, $("${J[@]}" -o cat 2>/dev/null | wc -l) entries," \
    "address count $(n "$T/var/log/journal/$d") in the files and $("${J[@]}" -o cat 2>/dev/null | grep -o -F -f "$PAT" | wc -l) in journalctl's text;" \
    "sshd source addresses $(echo "$srcs" | grep -c .), this workstation's among them $(echo "$srcs" | grep -c -x -F -f "$PAT")"
  [ "$d" != "$mid" ] || echo "  journal works: flush to /var/log/journal logged $("${J[@]}" -o cat 2>/dev/null | grep -c 'flushing to /var/log/journal') times, system.journal $(stat -c %s "$T/var/log/journal/$d/system.journal" 2>/dev/null || echo 0) bytes"
done
echo "== address count by path (occurrences)"
echo "  /var/log/journal: $(n $T/var/log/journal)"
echo "  /var/log, without the journal: $(n --exclude-dir=journal $T/var/log)"
echo "  /var/lib, without cloud-init: $(n --exclude-dir=cloud $T/var/lib)"
echo "  cloud-init (/var/lib/cloud, /var/log/cloud-init*, /etc/cloud): $(n $T/var/lib/cloud $T/var/log/cloud-init.log $T/var/log/cloud-init-output.log $T/etc/cloud)"
for p in etc root home; do echo "  /$p: $(n $T/$p)"; done
echo "  the whole root filesystem: $(n $T)"
echo "  the raw partition, free blocks included: $(tr -c '[:print:]' '\n' < "$part" | grep -o -F -f "$PAT" | wc -l)"
echo "== login records"
for f in var/log/wtmp var/log/btmp var/log/lastlog var/log/wtmp.db var/lib/wtmpdb/wtmp.db var/lib/lastlog/lastlog2.db; do
  echo "  /$f: $([ -e "$T/$f" ] && stat -c '%s bytes' "$T/$f" || echo absent)"; done
echo "  journald drop-ins: $(ls $T/etc/systemd/journald.conf.d/ 2>/dev/null | paste -sd' ')"
umount $T; rm -f "$PAT"
X
} | ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "sudo bash -s" > "$WORKDIR/o" 2>&1; rc=$?
unset ADDR
tee -a "$EV" < "$WORKDIR/o" >&2
[ "$rc" = 0 ] || { say "VERDICT: FAIL, the count didn't finish"; die "the count didn't finish"; }
v=$(judge "$EV"); r=$?
say "$v"
exit "$r"
