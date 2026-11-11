#!/usr/bin/env bash
# lab/h5-files/lab.sh <ami> [type]: free walk H5 in the lab. TEST ONLY, lab evidence, never a release proof. OWNER_TAG names
# everything it makes; all of it is removed on exit. Boots the AMI under SlotMode=port (as verify-port.sh does), stops its link,
# points each slot's deskd at gateway-shim and a fake IMDS on its veth (h5host.sh setup), and drives Files through deskd itself
# from this workstation with deskctl (desk-rtc's client, over UDP to the slot's port, signalling through an SSH tunnel to the shim):
#   0. the AMI as baked, slot 1 on a blank volume: deskd says the Files tree can't be used, and files.list answers unavailable;
#   1. this tree's host files laid over it (lab/s119-set-class's way: mounts.py, svc-spec.py, desk-init.py, desk-host-check), the
#      same volume, now an existing volume without /data/files: its first start skips the mount (deskd runs, Files unavailable)
#      and its desk makes the directory; its second has Files (mkdir, list, usage through deskd), and a third still has the folder;
#   2. a fresh volume (slot 2): Files at its first start;
#   3. a link planted at /data/files (slot 3, on a volume no slot runs, as its desk could leave it): never followed (deskd keeps
#      its placeholder, the agent's file stays out of its sandbox), the desk replaces the link, and the next start has Files.
# Needs: DESKCTL (amd64) and SHIM (arm64) built from desk-rtc (cmd/deskctl, cmd/gateway-shim). Evidence: evidence/h5-files-lab-<ami>.txt.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); IMG=$(cd "$HERE/../.." && pwd)
. "$IMG/lib.sh"
AMI=${1:?usage: lab.sh <ami-id> [type]}; TYPE=${2:-m7g.xlarge}
: "${DESKCTL:?DESKCTL=<deskctl, amd64>}" "${SHIM:?SHIM=<gateway-shim, arm64>}" "${OWNER_TAG:?OWNER_TAG=<your Owner tag>}"
INSTANCE_ID=; VOLS=(); TUN=
EV=$IMG/host/evidence/h5-files-lab-$AMI.txt; : > "$EV"
cleanup() {
  local rc=$?; trap - EXIT; set +e
  [ -n "$TUN" ] && kill "$TUN" 2>/dev/null
  local v; for v in "${VOLS[@]}"; do aws ec2 detach-volume --volume-id "$v" --force >/dev/null 2>&1; done
  destroy_temp_access "$INSTANCE_ID"
  for v in "${VOLS[@]}"; do aws ec2 wait volume-available --volume-ids "$v" 2>/dev/null; aws ec2 delete-volume --volume-id "$v" >/dev/null 2>&1 && log "deleted $v"; done
  exit "$rc"
}
trap cleanup EXIT
scrub() { python3 -I -c '
import re, sys
keep = re.compile(r"^(127\.|10\.98\.|169\.254\.|0\.0\.0\.0|255\.)")
sys.stdout.write(re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", lambda m: m.group(0) if keep.match(m.group(0)) else "<addr>", sys.stdin.read()))'; }
say() { echo "$*" | tee -a "$EV" >&2; }
R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "$@"; }
HH() { R "sudo bash /home/admin/h5/h5host.sh $*" 2>&1 | scrub | sed 's/^/    /' | tee -a "$EV" >&2; return "${PIPESTATUS[0]}"; }
# files <k> <desk> <call>...: deskctl through slot k's shim (the tunnel) and its UDP port, one session, the calls in order
files() {
  local k=$1 d=$2 a=() c; shift 2
  for c in "$@"; do a+=(--call "$c"); done
  "$DESKCTL" status --gateway "ws://127.0.0.1:$((18780 + k))/v1" --desk "$d" --transport any --timeout 60s "${a[@]}" 2>&1 \
    | grep -E '^(call |transport|deskctl)' | scrub | cut -c1-300 | sed 's/^/    /' | tee -a "$EV" >&2
  return "${PIPESTATUS[0]}"
}
step() { say ""; say "== $*"; }

make_temp_access "ma-h5-lab-$$"
MYIP=$(my_ip)
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
  "IpProtocol=udp,FromPort=4431,ToPort=4433,IpRanges=[{CidrIp=$MYIP/32}]" "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]" >/dev/null 2>&1 \
  || die "can't add the inbound rules to $SG_ID"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text); SUBNET=
for az in $(aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=instance-type,Values=$TYPE" --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' '\n' | sort); do
  SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true "Name=availability-zone,Values=$az" --query 'Subnets[0].SubnetId' --output text)
  [[ $SUBNET == subnet-* ]] && break
done
PUB=$(ssh-keygen -y -f "$KEY_FILE"); UD=$WORKDIR/userdata.sh
cat > "$UD" <<EOF
#!/bin/bash
# TEST ONLY: temporary SSH for this lab run (one key, admin; port 22 opened by the group to this workstation only); never enabled
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
  --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=48,VolumeType=gp3,DeleteOnTermination=true}" --user-data "file://$UD" \
  --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=ma-h5-files-lab},{Key=DesksPerHost,Value=6},{Key=SlotsPerHost,Value=6},{Key=HostingVersion,Value=lab},{Key=SlotMode,Value=port}]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "instance $INSTANCE_ID ($TYPE)"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
wait_ssh "$IP" "$KEY_FILE" 600 || die "ssh never came up"
R 'sudo cloud-init status --wait >/dev/null 2>&1; for i in $(seq 1 60); do systemctl is-active --quiet desk-host-boot.service && break; sleep 2; done'
say "free walk H5 lab: $AMI ($(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text)) on $TYPE, SlotMode=port, instance $INSTANCE_ID"

AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
mkvol() { aws ec2 create-volume --availability-zone "$AZ" --size 4 --volume-type gp3 --tag-specifications "$(tagspec volume)" --query VolumeId --output text; }
VA=$(mkvol); VB=$(mkvol); VC=$(mkvol); VOLS=("$VA" "$VB" "$VC")
aws ec2 wait volume-available --volume-ids "$VA" "$VB" "$VC"
aws ec2 attach-volume --volume-id "$VA" --instance-id "$INSTANCE_ID" --device /dev/sdg >/dev/null
aws ec2 attach-volume --volume-id "$VB" --instance-id "$INSTANCE_ID" --device /dev/sdh >/dev/null
aws ec2 attach-volume --volume-id "$VC" --instance-id "$INSTANCE_ID" --device /dev/sdi >/dev/null
aws ec2 wait volume-in-use --volume-ids "$VA" "$VB" "$VC"
DA=d-testfilesaaa; DB=d-testfilesbbb; DC=d-testfilesccc
aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskSlot1,Value=$DA/$VA/-/-/1" "Key=DeskSlot2,Value=$DB/$VB/-/-/1" "Key=DeskSlot3,Value=$DC/$VC/-/-/1"
R 'mkdir -p /home/admin/h5/overlay/usr/local/lib/desk-host/desk'
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$HERE/h5host.sh" "$IMG/../spikes/shared-hosts-test5/fake-imds.py" "admin@$IP:/home/admin/h5/" >/dev/null
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$SHIM" "admin@$IP:/home/admin/h5/gateway-shim" >/dev/null
F=$IMG/host/recipe/files/usr/local/lib/desk-host
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$F/mounts.py" "$F/svc-spec.py" "$F/desk-host-check" "admin@$IP:/home/admin/h5/overlay/usr/local/lib/desk-host/" >/dev/null
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$F/desk/desk-init.py" "admin@$IP:/home/admin/h5/overlay/usr/local/lib/desk-host/desk/" >/dev/null
R 'chmod 755 /home/admin/h5/gateway-shim /home/admin/h5/overlay/usr/local/lib/desk-host/* 2>/dev/null; chmod 644 /home/admin/h5/overlay/usr/local/lib/desk-host/desk/desk-init.py; chmod 755 /home/admin/h5/overlay/usr/local/lib/desk-host/desk'
sleep 10   # IMDS shows the tags within seconds
HH setup
ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" -N -o ExitOnForwardFailure=yes -L 18781:10.98.1.1:8787 -L 18782:10.98.2.1:8787 -L 18783:10.98.3.1:8787 "admin@$IP" & TUN=$!
sleep 3
LIST='files.list {"path":""}'
ok=1

step "0. the AMI as baked (no overlay): slot 1 on a blank volume"
HH up 1 $DA $VA || ok=0
HH show 1 || true
files 1 $DA "$LIST" && { say "  Files answered on the AMI as baked: NOT the bug"; ok=0; } || say "  as the bug: files.list refused (unavailable) on the AMI as baked"
HH down 1

step "1. this tree's host files over it; slot 1's volume, now one from before the fix (no /data/files): first start"
HH overlay
HH up 1 $DA $VA || ok=0
HH show 1 || ok=0
files 1 $DA "$LIST" && { say "  Files answered with no files directory mounted?"; ok=0; } || say "  as expected this run: files.list unavailable (the volume had no files directory; its desk makes it now)"
HH down 1
step "1b. slot 1, its second start: the desk's own /data/files mounted"
HH up 1 $DA $VA || ok=0
HH show 1 || ok=0
files 1 $DA 'files.mkdir {"path":"h5-proof"}' "$LIST" 'files.usage {}' || ok=0
HH down 1
step "1c. slot 1, a third start: the folder is still there (on the volume)"
HH up 1 $DA $VA || ok=0
n=$(wc -l < "$EV")
files 1 $DA "$LIST" || ok=0
tail -n +$((n + 1)) "$EV" | grep -q '"h5-proof"' && say "  h5-proof is still there" || { say "  h5-proof NOT there"; ok=0; }
HH down 1

step "2. a fresh volume (slot 2): Files at its first start"
HH up 2 $DB $VB || ok=0
HH show 2 || ok=0
files 2 $DB 'files.mkdir {"path":"fresh"}' "$LIST" || ok=0
HH down 2

step "3. a link planted at /data/files (slot 3): first a start on the fresh volume, then the link, as its desk could leave it"
HH up 3 $DC $VC || ok=0
HH down 3
HH plant $VC
HH up 3 $DC $VC || ok=0
HH show 3 || ok=0
files 3 $DC "$LIST" && { say "  Files answered through a link?"; ok=0; } || say "  as expected: files.list unavailable, the link not followed"
HH down 3
HH look $VC
step "3b. slot 3, its next start: the desk replaced the link with its own directory"
HH up 3 $DC $VC || ok=0
HH show 3 || ok=0
files 3 $DC "$LIST" || ok=0
HH down 3
HH look $VC

say ""; say "RESULT: $([ $ok = 1 ] && echo 'every step as expected' || echo 'NOT every step as expected') ($AMI on $TYPE)"
[ $ok = 1 ]
