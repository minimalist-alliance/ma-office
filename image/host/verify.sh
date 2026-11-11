#!/bin/bash
# image/host/verify.sh <ami-id> [instance type]: prove a shared-host AMI (image/host/README.md). Run from the workstation.
# Boots the AMI as Platform would (two interfaces, the host's own and the slots', PF-03; tags DesksPerHost and HostingVersion,
# instance metadata tags on, IMDSv2 at one hop, the slot store grown at launch), with temporary SSH for this run only. The
# account's Elastic IP quota (5, most of it used by the door and free Maia's edge) leaves one for a test, so: the host's own
# interface keeps the launch's auto-assigned public address, the slots' interface is attached after boot, and the run's one
# Elastic IP is slot 1's first and then moved to slot 2's address. Then:
#   1. boot: time to SSH and systemd's own boot time, the kernel, ENA and NVMe, IMDS's options, the boot state before SSH;
#   2. a fake Platform on the host's loopback (tests/fake_platform.py, the contract's three routes, every signature checked)
#      and desk-host-link pointed at it (LINK_API, a test host only); then every desk-host-check check (29: the host's own,
#      the size classes' table and their application, the byte counters, the link, inbound, the stand-in, and SlotMode=port's
#      four, which under address say there's no demux and nothing on the host's 443);
#   2b. the template key's trust anchor (verify-template-anchor.sh): the host's pin is the committed recipe/template-keys.sha256 and
#      its keys exactly the anchor's; the key and pin swapped together for another P-256 key must fail it (a skip with no template path);
#   3. WR2-02 on the host: TIOCSETD N_HDLC on a pty refused, /proc/modules unchanged;
#   4. the link: two desks placed by DeskSlot tags and started by the fake's start_slot orders; a slot leaves from the
#      Elastic IP on its own address and from no other address once it's moved away (PF-01); from outside, the host's own
#      address answers nothing and a slot's answers its desk's 443 (PF-03); the host counts a slot's bytes out (IN-09); from
#      inside each slot (its network namespace, as its deskd's uid) the stand-in answers its own desk only and nothing
#      reaches the real IMDS or a neighbour's stand-in; the wall's settings on a desk; stop_slot stops one slot only; a slot
#      whose public address IMDS doesn't associate stays down (PF-01);
#   4b. size classes (ADR 0072, "Container sizes by tier"), by hand with the link stopped and the Elastic IP back on slot 1:
#      the desk started `free` has the free class's cgroup; changed to `standard` live, it has standard's with every process
#      kept; a raise past DesksPerHost units keeps its memory and disk and waits (75), then finishes once there's room; then
#      stopped with nothing left;
#   4c. the slot's byte counters (desk_est): a download's bytes in and its ACKs out match the slot's veth; then the link again;
#   4f. ADR 0036 per container (TD-223): slot 1's outbound shaper on its veth (1:10, 1:15, 1:20 at 60, 2, 100 Mbit), its counters
#      in the report, its desk-egress ticking; desk-host shaper 1 off (test 1's R5) fails the shaper check, on passes it;
#   4g. ADR 0078: a service batch's fetch, its refusals and their mutations (verify-batches.sh);
#   5. the mutation pass: each check broken on purpose must FAIL, then put back must PASS (every check can fail).
#   6. Platform's reclaim wave (verify-wave.sh): six prepares at once on a store filled until it holds one root more, and 0.1.11's
#      prepare (its mutation) failing the same wave.
#   7. slot-datadirs (verify-links.sh): a link the Browser's user puts at /data/browser/home before slot 1's start isn't followed
#      by its desk-init, and 0.1.11.1's desk-init (its mutation) following it fails the same step.
# This is SlotMode=address (choice A, no SlotMode tag); SLOT_MODE=port runs verify-port.sh, SlotMode=port's own run.
# Evidence: image/host/evidence/verify-<ami>.txt (addresses replaced). Creates only tagged temporary resources, removed on exit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# SlotMode=port (one public IPv4 for the host, choice B) has its own run: SLOT_MODE=port verify.sh <ami>. A bake runs both.
[ "${SLOT_MODE:-address}" = port ] && exec "$HERE/verify-port.sh" "$@"
. "$HERE/../lib.sh"
AMI=${1:?usage: [SLOT_MODE=port] verify.sh <ami-id> [type]}; TYPE=${2:-m7g.xlarge}
INSTANCE_ID=; SG_ID=; KEY_NAME=; WORKDIR=; VOLS=(); ALLOCS=(); ENI1=
PASS=0; FAILN=0
mkdir -p "$HERE/evidence"; EV=$HERE/evidence/verify-$AMI.txt; : > "$EV"
cleanup() {
  local rc=$?; trap - EXIT; set +e
  local a v
  for a in "${ALLOCS[@]}"; do
    aid=$(aws ec2 describe-addresses --allocation-ids "$a" --query 'Addresses[0].AssociationId' --output text 2>/dev/null)
    [ -n "$aid" ] && [ "$aid" != None ] && aws ec2 disassociate-address --association-id "$aid" >/dev/null 2>&1
  done
  for v in "${VOLS[@]}"; do aws ec2 detach-volume --volume-id "$v" --force >/dev/null 2>&1; done
  destroy_temp_access "$INSTANCE_ID"
  [ -n "$ENI1" ] && for _ in 1 2 3 4 5 6; do aws ec2 delete-network-interface --network-interface-id "$ENI1" >/dev/null 2>&1 && { log "deleted $ENI1"; break; }; sleep 5; done
  for a in "${ALLOCS[@]}"; do aws ec2 release-address --allocation-id "$a" >/dev/null 2>&1 && log "released $a"; done
  for v in "${VOLS[@]}"; do aws ec2 wait volume-available --volume-ids "$v" 2>/dev/null; aws ec2 delete-volume --volume-id "$v" >/dev/null 2>&1 && log "deleted $v"; done
  exit "$rc"
}
trap cleanup EXIT
scrub() { python3 -I -c '
import re, sys
keep = re.compile(r"^(127\.|10\.98\.|169\.254\.|0\.0\.0\.0|255\.)")
sys.stdout.write(re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", lambda m: m.group(0) if keep.match(m.group(0)) else "<addr>", sys.stdin.read()))'; }
say() { echo "$*" | tee -a "$EV" >&2; }
result() { local ev; ev=$(cat | scrub); if [ "$2" = 0 ]; then PASS=$((PASS+1)); say "PASS  $1"; else FAILN=$((FAILN+1)); say "FAIL  $1"; fi; echo "$ev" | sed 's/^/        /' >> "$EV"; }
R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "$@"; }
RS() { R "sudo bash -s"; }

make_temp_access "ma-host-verify-$$"
MYIP=$(my_ip)
# This workstation also reaches 443 and ICMP, so the host's own ruleset, not the group, is what PF-03's check from outside meets
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]" "IpProtocol=udp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]" \
  "IpProtocol=icmp,FromPort=-1,ToPort=-1,IpRanges=[{CidrIp=$MYIP/32}]" >/dev/null 2>&1 || die "can't add the 443 and ICMP rules to $SG_ID"
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
# TEST ONLY: the boot state first, then temporary SSH for this verify run (one key, admin; port 22 opened by the group to
# this workstation only). ssh is started, never enabled.
{ echo "== authorized_keys at boot"; find /root /home -name 'authorized_keys*' -size +0 2>/dev/null
  echo "== ssh enabled at boot: \$(systemctl is-enabled ssh.service 2>&1)"; echo "== ss -lntu at boot"; ss -lntu; } > /var/tmp/prestate.txt 2>&1
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$PUB' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
systemctl is-active --quiet nftables.service || systemctl start nftables.service
nft add rule inet host input tcp dport 22 accept
systemctl start ssh
EOF
T0=$(date +%s)
INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 \
  --network-interfaces "DeviceIndex=0,SubnetId=$SUBNET,Groups=$SG_ID,AssociatePublicIpAddress=true" \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled,InstanceMetadataTags=enabled \
  --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=48,VolumeType=gp3,DeleteOnTermination=true}" \
  --user-data "file://$UD" \
  --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=ma-host-verify},{Key=DesksPerHost,Value=6},{Key=HostingVersion,Value=verify}]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "instance $INSTANCE_ID ($TYPE)"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
# PF-03: device 0 is the host's own interface (the launch's public address: SSH for this run), device 1 the slots' (both
# slot addresses; one Elastic IP, slot 1's first). Slot 1 is device 1's primary address, slot 2 its secondary.
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ENI1=$(aws ec2 create-network-interface --subnet-id "$SUBNET" --groups "$SG_ID" --secondary-private-ip-address-count 1 \
  --tag-specifications "$(tagspec network-interface)" --query NetworkInterface.NetworkInterfaceId --output text)
ATT=$(aws ec2 attach-network-interface --network-interface-id "$ENI1" --instance-id "$INSTANCE_ID" --device-index 1 --query AttachmentId --output text)
for _ in $(seq 1 30); do [ "$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI1" --query 'NetworkInterfaces[0].Attachment.Status' --output text)" = attached ] && break; sleep 2; done
aws ec2 modify-network-interface-attribute --network-interface-id "$ENI1" --attachment "AttachmentId=$ATT,DeleteOnTermination=true"
PRIV1=$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI1" --query 'NetworkInterfaces[0].PrivateIpAddresses[?Primary==`true`].PrivateIpAddress' --output text)
PRIV2=$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI1" --query 'NetworkInterfaces[0].PrivateIpAddresses[?Primary==`false`].PrivateIpAddress' --output text)
A1=$(aws ec2 allocate-address --domain vpc --tag-specifications "$(tagspec elastic-ip)" --query AllocationId --output text); ALLOCS+=("$A1")
A2=$A1   # the one Elastic IP, moved from slot 1's address to slot 2's in section 4: both tags name it
aws ec2 associate-address --allocation-id "$A1" --network-interface-id "$ENI1" --private-ip-address "$PRIV1" --no-allow-reassociation >/dev/null
EIP1=$(aws ec2 describe-addresses --allocation-ids "$A1" --query 'Addresses[0].PublicIp' --output text)
log "slots' interface $ENI1 attached; Elastic IP $A1 on slot 1's address"
wait_ssh "$IP" "$KEY_FILE" 600 || die "ssh never came up"
T_SSH=$(( $(date +%s) - T0 ))
say "AMI $AMI ($(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text)) on $TYPE, instance $INSTANCE_ID, ssh $T_SSH s after run-instances"
R 'sudo cloud-init status --wait >/dev/null 2>&1; true'

# ---- 1. boot
{ echo "ssh reachable $T_SSH s after run-instances"; RS <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u
for i in $(seq 1 60); do systemctl is-active --quiet desk-host-boot.service && break; sleep 2; done
systemd-analyze 2>&1 | head -2
systemd-analyze blame 2>/dev/null | head -6
echo "kernel $(uname -r)"
echo "network driver: $(basename "$(readlink /sys/class/net/$(ip -o route show default | sort -k9n | awk '{print $5; exit}')/device/driver)")"
echo "disks:"; lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINTS | sed 's/^/  /'
for c in /sys/class/nvme/nvme*; do echo "  $(basename $c): $(cat $c/model | tr -s ' ') driver $(basename "$(readlink $c/device/driver)")"; done
echo "desk-host-boot: $(systemctl show -p ActiveState -p Result --value desk-host-boot | paste -sd' ') in $(( ($(systemctl show -p ExecMainExitTimestampMonotonic --value desk-host-boot) - $(systemctl show -p ExecMainStartTimestampMonotonic --value desk-host-boot)) / 1000 )) ms"
journalctl -u desk-host-boot --no-pager -o cat | sed 's/^/  /'
echo "--- the boot state, before this run's SSH"; cat /var/tmp/prestate.txt | grep -v '^\(tcp\|udp\).*:22 '
u=$(uname -r); d=$(basename "$(readlink /sys/class/net/$(ip -o route show default | sort -k9n | awk '{print $5; exit}')/device/driver)")
[[ $u == *-arm64 && $u != *cloud* ]] && [ "$d" = ena ] && [ -n "$(ls /sys/class/nvme)" ] && systemctl is-active --quiet desk-host-boot \
  && ! grep -q '^/.*authorized_keys' /var/tmp/prestate.txt && grep -q 'ssh enabled at boot: \(disabled\|masked\|not-found\)' /var/tmp/prestate.txt
X
aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].MetadataOptions.[HttpTokens,HttpPutResponseHopLimit,InstanceMetadataTags]' --output text >> $WORKDIR/o
grep -q $'^required\t1\tenabled$' $WORKDIR/o || rc=1
result "boot: generic arm64 kernel, ENA, NVMe, desk-host-boot ok, no keys or SSH at boot, IMDSv2 one hop with tags" $rc < $WORKDIR/o

# ---- 2. a fake Platform on the host's loopback, desk-host-link pointed at it; then the host's own checks
# The fake holds the two slots' records (both wanted stopped until section 4) and answers hello, report and slot-session as
# Platform's hostlink.ts does, checking every signature (the instance has no role, so the link signs with its loopback test
# key, which it sends nowhere else). Its requests are logged to /root/fake/requests.jsonl.
D1=d-hostverifyaa; D2=d-hostverifybb
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$HERE/tests/fake_platform.py" "admin@$IP:/home/admin/" >/dev/null
fake_state() {   # fake_state <want slot 1> <want slot 2>: both slots' public address is the run's one Elastic IP
  python3 -I -c 'import json, sys
a = sys.argv
s = lambda k, d, v, ip, alloc, pub, want: {"deskId": d, "volumeId": v, "privateIp": ip, "allocationId": alloc, "publicIp": pub, "epoch": 1, "want": want, "userId": f"verify-user-{k}", "deskKind": "test"}
print(json.dumps({"hostId": a[1], "env": "staging", "desksPerHost": 6, "reportSeconds": 10, "refreshAfterSeconds": 600,
                  "slots": {"1": s(1, a[2], a[4], a[6], a[8], a[10], a[12]), "2": s(2, a[3], a[5], a[7], a[9], a[11], a[13])}}))' \
    "$INSTANCE_ID" "$D1" "$D2" "${VOL1:-}" "${VOL2:-}" "$PRIV1" "$PRIV2" "$A1" "$A2" "$EIP1" "$EIP1" "$1" "$2" \
    | R 'sudo tee /root/fake/state.json.tmp >/dev/null && sudo chmod 600 /root/fake/state.json.tmp && sudo mv /root/fake/state.json.tmp /root/fake/state.json'
}
R 'sudo install -d -m 700 /root/fake && sudo mv /home/admin/fake_platform.py /root/fake/ && sudo chown root:root /root/fake/fake_platform.py'
fake_state stopped stopped
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
# The slots' interface was attached after boot (the one-Elastic-IP layout); a default route the OS may have given it is the
# test's, not the image's, and goes: the host's own traffic leaves by its own interface, as on a host launched with both
t=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
me=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/local-ipv4)
own=$(ip -o -4 addr show | awk -v ip="$me" '$4 ~ "^"ip"/" {print $2; exit}')
ip -4 route show default | grep -v " dev $own " | while read -r r; do echo "removing a default route the hot-plugged interface got: $(echo "$r" | sed 's/via [0-9.]*/via <gw>/')"; ip route del $r; done
echo "interfaces: $(ip -o link show | awk -F': ' '{print $2}' | tr '\n' ' ')"
systemd-run --quiet --unit=ma-verify-fake-platform --setenv=DESK_HOST_LIB=/usr/local/lib/desk-host \
  python3 -I /root/fake/fake_platform.py --port 18443 --state /root/fake/state.json --log /root/fake/requests.jsonl
echo 'LINK_API=http://127.0.0.1:18443' >> /etc/desk-host/desk-host.conf
# The fake's sessions are staging's in name only: deskd in these desks is pointed at a name that resolves nowhere, so its
# hellos with the fake's credentials never reach staging's API
echo 'DESKD_ENV=DESKD_API_URL=https://api.verify.invalid;DESKD_JWKS_URL=https://api.verify.invalid/v1/jwks' >> /etc/desk-host/desk-host.conf
systemctl restart desk-host-link
for i in $(seq 1 30); do grep -q '"route": "/v1/host/report", "status": 200' /root/fake/requests.jsonl 2>/dev/null && break; sleep 2; done
journalctl -u desk-host-link --no-pager -o cat | tail -5
python3 -I - <<'P'
import json
rows = [json.loads(l) for l in open("/root/fake/requests.jsonl")]
h = [r for r in rows if r["route"] == "/v1/host/hello"]
rep = [r for r in rows if r["route"] == "/v1/host/report" and r["status"] == 200]
print(f"hello: {[r['status'] for r in h]}, body keys {sorted(h[-1]['body'])}; reports: {len(rep)}, slots in the last {len(rep[-1]['body']['slots']) if rep else 0}")
assert h and h[-1]["status"] == 200 and rep and len(rep[-1]["body"]["slots"]) == 6
P
X
result "the link: hello and reports to a fake Platform on the loopback, every request signed and checked" $rc < $WORKDIR/o

RS <<'X' > $WORKDIR/o 2>&1 || true
/usr/local/lib/desk-host/desk-host-check --allow-verify-access
X
while read -r st _ name rest; do
  [ "$st" = PASS ] || [ "$st" = FAIL ] || continue
  result "host ${name%:}" "$([ "$st" = PASS ] && echo 0 || echo 1)" <<<"$rest"   # not through a pipe: its counts would stay in a subshell
done < $WORKDIR/o
NCHECKS=$(grep -c -E '^(PASS|FAIL) host ' $WORKDIR/o || true)
[ "$NCHECKS" -ge 37 ] || { echo "only $NCHECKS checks ran" | result "every host check ran" 1; }

# ---- 2b. the template key's trust anchor (ADR 0077 PU-9; verify-template-anchor.sh on the host): the host's pin is the committed
# recipe/template-keys.sha256 byte for byte and its keys exactly the anchor's; its mutation, the key and the pin swapped together for
# another P-256 key (which template-sig alone passes), must fail it. An image with no template path (0.1.11, 0.1.11.1, earlier) is a skip.
TKA=$(base64 -w0 < "$HERE/recipe/template-keys.sha256")
R "sudo bash -s -- check $TKA" < "$HERE/verify-template-anchor.sh" > $WORKDIR/o 2>&1 && rc=0 || rc=$?
if grep -qx 'ANCHOR NOT APPLICABLE' $WORKDIR/o; then
  say "SKIP  the template key's trust anchor: this image has no template path (ADR 0077's host half isn't on it)"
  scrub < $WORKDIR/o | sed 's/^/        /' >> "$EV"
else
  grep -qx 'ANCHOR PASS' $WORKDIR/o || rc=1
  result "the template key's trust anchor: the host's pin is the committed recipe/template-keys.sha256, its keys exactly the anchor's" $rc < $WORKDIR/o
  R "sudo bash -s -- mutation $TKA" < "$HERE/verify-template-anchor.sh" > $WORKDIR/o 2>&1 && rc=0 || rc=$?
  { grep -qx 'MUTATED ANCHOR FAIL' $WORKDIR/o && grep -qx 'RESTORE PASS' $WORKDIR/o; } || rc=1
  result "that check fails with the key and its pin swapped together for another P-256 key (template-sig alone passes it); put back, both pass" $rc < $WORKDIR/o
fi

# ---- 3. WR2-02 on the host itself: a pty's TIOCSETD to N_HDLC, as an unprivileged user
RS <<'X' > $WORKDIR/o 2>&1 && rc=0 || rc=$?
before=$(awk '{print $1}' /proc/modules | sort | md5sum)
setpriv --reuid=65534 --regid=65534 --clear-groups python3 -I -c '
import fcntl, os, pty, struct, errno
m, s = pty.openpty()
for n, name in ((13, "N_HDLC"), (3, "N_PPP"), (21, "N_GSM0710"), (1, "N_SLIP")):
    try:
        fcntl.ioctl(s, 0x5423, struct.pack("i", n)); print(f"TIOCSETD {name}: ok (FAIL)")
    except OSError as e:
        print(f"TIOCSETD {name}: {errno.errorcode[e.errno]}")
'
after=$(awk '{print $1}' /proc/modules | sort | md5sum)
echo "dev.tty.ldisc_autoload=$(sysctl -n dev.tty.ldisc_autoload); /proc/modules $([ "$before" = "$after" ] && echo unchanged || echo CHANGED)"
lsmod | grep -E '^(n_hdlc|ppp_async|n_gsm|slip) ' && exit 1
[ "$before" = "$after" ]
X
grep -q ': ok (FAIL)' $WORKDIR/o && rc=1
result "WR2-02: TIOCSETD to N_HDLC, N_PPP, N_GSM0710, N_SLIP refused for an unprivileged user; no module loaded" $rc < $WORKDIR/o

# ---- 4. the link: two desks placed by their tags and started by the fake's orders; what a slot can and can't reach
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
mkvol() { aws ec2 create-volume --availability-zone "$AZ" --size 4 --volume-type gp3 --tag-specifications "$(tagspec volume)" --query VolumeId --output text; }
VOL1=$(mkvol); VOLS+=("$VOL1"); VOL2=$(mkvol); VOLS+=("$VOL2")
aws ec2 wait volume-available --volume-ids "$VOL1" "$VOL2"
aws ec2 attach-volume --volume-id "$VOL1" --instance-id "$INSTANCE_ID" --device /dev/sdg >/dev/null
aws ec2 attach-volume --volume-id "$VOL2" --instance-id "$INSTANCE_ID" --device /dev/sdh >/dev/null
aws ec2 wait volume-in-use --volume-ids "$VOL1" "$VOL2"
# Platform's tags (contract section 2), as the placer writes them at an attach (slot 2's with the optional sixth field, its
# size class); then the fake wants slot 1 running
aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskSlot1,Value=$D1/$VOL1/$PRIV1/$A1/1" "Key=DeskSlot2,Value=$D2/$VOL2/$PRIV2/$A2/1/standard"
fake_state running stopped
RSE() { R "sudo env $* bash -s"; }
R 'sudo tee /root/fake/wait.py >/dev/null' <<'P'
# wait.py <seconds> <cond>...: until the fake's last 200 report meets every cond: k=state[,state] | k^fault | k>bytes | k<bytes
import json, sys, time
end = time.time() + float(sys.argv[1])
def last():
    S = {}
    try:
        for l in open("/root/fake/requests.jsonl"):
            r = json.loads(l)
            if r["route"] == "/v1/host/report" and r["status"] == 200:
                S = {s["k"]: s for s in r["body"]["slots"]}
    except OSError:
        pass
    return S
def ok(S, c):
    for op in "=^><":
        if op in c:
            k, v = c.split(op, 1); s = S.get(int(k), {})
            return {"=": lambda: s.get("state") in v.split(","), "^": lambda: s.get("fault") == v,
                    ">": lambda: s.get("net", {}).get("bytesOut", 0) > int(v), "<": lambda: s.get("net", {}).get("bytesOut", 0) < int(v)}[op]()
while True:
    S = last()
    if S and all(ok(S, c) for c in sys.argv[2:]):
        break
    if time.time() > end:
        print("TIMEOUT waiting for", " ".join(sys.argv[2:]))
        break
    time.sleep(3)
print("report:", json.dumps({k: {x: S[k].get(x) for x in ("state", "epoch", "fault", "net") if x in S[k]} for k in (1, 2) if k in S}))
sys.exit(0 if S and all(ok(S, c) for c in sys.argv[2:]) else 1)
P
R 'sudo tee /root/fake/inslot.sh >/dev/null' <<'P'
# inslot <k> <the desk's uid> <command...>: in slot k's network namespace only (the host's own binaries), as that desk uid's
# host uid, so the desk's own firewall judges it as it judges the desk's own process
inslot() { local k=$1 u=$2; shift 2; local ku=$((100000 + k * 65536 + u)); nsenter --net=/run/desk-host/ns/$k/net setpriv --reuid=$ku --regid=$ku --clear-groups "$@"; }
# get <k> <path>: "<body> <HTTP code>" from the metadata address, as the slot's deskd (1100) asks it, IMDSv2
get() { local t; t=$(inslot "$1" 1100 curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) || { echo "- 000"; return; }
  inslot "$1" 1100 curl -sS -m 3 -w ' %{http_code}' -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/$2"; }
code() { echo "${1##* }"; }; body() { echo "${1% *}"; }
# egress <k>: the address slot k's packets leave from, as checkip sees it ("none" when they leave from nowhere)
egress() { local cip; cip=$(getent ahostsv4 checkip.amazonaws.com | awk '{print $1; exit}')
  inslot "$1" 1100 curl -fsS -m 12 --resolve "checkip.amazonaws.com:443:$cip" https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true; }
P

{ R "sudo python3 -I /root/fake/wait.py 1500 1=running" && RSE EIP=$EIP1 <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh; ok=1
out=$(egress 1); echo "slot 1 leaves from: $([ "$out" = "$EIP" ] && echo "the Elastic IP on its own address" || echo "SOMETHING ELSE (${out:-none})")"; [ "$out" = "$EIP" ] || ok=0
ip rule show | grep -E 'iif dhv1' | sed 's/^/  rule: /'
[ $ok = 1 ]
X
result "PF-01: slot 1 leaves from the Elastic IP on its own address, through the slots' interface (its own routing table)" $rc < $WORKDIR/o

# PF-03 from outside: this workstation may reach 443 and ICMP on every address (the group), so only the host's ruleset answers.
# Not under set -e: a probe that gets no answer is what's wanted here.
{ set +e; echo "from this workstation:"
  for a in "$IP:the host's own" "$EIP1:slot 1's"; do
    if ping -c 3 -W 2 -q "${a%%:*}" >/dev/null 2>&1; then echo "  ping ${a#*:} address: ANSWERED"; echo FAIL; else echo "  ping ${a#*:} address: no answer"; fi
  done
  r=0; timeout 6 bash -c "exec 3<>/dev/tcp/$IP/443" 2>/dev/null || r=$?; echo "  TCP 443 on the host's own address: $([ $r = 124 ] && echo 'no answer (dropped)' || echo "ANSWERED ($r)")"; [ $r = 124 ] || echo FAIL
  r=0; timeout 6 bash -c "exec 3<>/dev/tcp/$IP/9254" 2>/dev/null || r=$?; echo "  TCP 9254 on the host's own address: $([ $r = 124 ] && echo 'no answer (dropped)' || echo "ANSWERED ($r)")"; [ $r = 124 ] || echo FAIL
  r=0; timeout 6 bash -c "exec 3<>/dev/tcp/$EIP1/443" 2>/dev/null || r=$?; echo "  TCP 443 on slot 1's address: $([ $r = 0 ] && echo 'its desk answered' || ([ $r = 1 ] && echo 'its desk refused (reached)' || echo "NO ANSWER ($r)"))"; [ $r = 0 ] || [ $r = 1 ] || echo FAIL
  set -e
} > $WORKDIR/o 2>&1
grep -q '^FAIL' $WORKDIR/o && rc=1 || rc=0
result "PF-03 from outside: the host's own address answers nothing (ping, 443, the stand-in's port); a slot's address answers only its desk's 443" $rc < $WORKDIR/o

# IN-09: 4 MiB over one TCP flow from slot 1 to a sink on the host's own address (hairpinned through the internet gateway, so
# it leaves by the slots' interface), opened on the host for this test only; then the host's count in the next report
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 18444 --cidr "$EIP1/32" >/dev/null 2>&1 || true
RSE OWN=$IP > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh
nft insert rule inet host input tcp dport 18444 accept comment '"verify-sink"'
systemd-run --quiet --unit=ma-verify-sink python3 -I -c 'import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 18444)); s.listen(1); c, _ = s.accept(); n = 0
while True:
    b = c.recv(65536)
    if not b:
        break
    n += len(b)
open("/root/fake/sink.txt", "w").write(str(n))'
sleep 1
inslot 1 1100 python3 -I -c 'import socket, sys
s = socket.create_connection((sys.argv[1], 18444), timeout=30); d = b"\0" * 65536
for _ in range(64):
    s.sendall(d)
s.close()' "$OWN" && echo "slot 1 sent 4194304 bytes in one flow"
for i in $(seq 1 20); do [ -s /root/fake/sink.txt ] && break; sleep 1; done
echo "the sink read $(cat /root/fake/sink.txt 2>/dev/null || echo nothing)"
for h in $(nft -a list chain inet host input | sed -n 's/.*verify-sink.*# handle \([0-9]*\)$/\1/p'); do nft delete rule inet host input handle "$h"; done
nft list chain inet host input | grep -q verify-sink && exit 1
python3 -I /root/fake/wait.py 60 '1>4194304' '2<1000000'
X
aws ec2 revoke-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 18444 --cidr "$EIP1/32" >/dev/null 2>&1 || true
result "IN-09: the host counts a slot's bytes out by its veth after the spoof drop, every packet of an established flow included (4 MiB from slot 1 in its report)" $rc < $WORKDIR/o

# The one Elastic IP moves to slot 2's address; then the fake wants both desks running
aws ec2 associate-address --allocation-id "$A1" --network-interface-id "$ENI1" --private-ip-address "$PRIV2" --allow-reassociation >/dev/null
sleep 20
fake_state running running
{ R "sudo python3 -I /root/fake/wait.py 900 1=running 2=running" && RSE D1=$D1 D2=$D2 <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; ok=1
python3 -I - <<'P' || ok=0
import json
rows = [json.loads(l) for l in open("/root/fake/requests.jsonl")]
for k in (1, 2):
    s = [r for r in rows if r["route"] == "/v1/host/slot-session" and r["body"].get("slot") == k]
    print(f"slot {k}: slot-session {[r['status'] for r in s][:4]}")
    assert s and s[0]["status"] == 200
bad = [r["status"] for r in rows if r["status"] != 200 and r["route"] != "/v1/host/slot-session"]
print(f"{len(rows)} requests, every signature checked by the fake; other than 200: {bad or 'none'}")
assert not bad
P
for k in 1 2; do n=$(grep -c "desk-host up $k\$" /var/log/desk-host/link-$k.log); echo "slot $k: desk-host up ran $n time(s)"; [ "$n" = 1 ] || ok=0; done
journalctl -u desk-host-link --no-pager -o cat | grep -E 'slot [12]:' | sed 's/^/  link: /'
/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only link,inbound,standin || ok=0
for k in 1 2; do echo "slot $k: $(sed 's/"address":"[^"]*"/"address":"<addr>"/' /run/desk-host/slotstate/$k.json)"; grep -q '"class":"standard"' /run/desk-host/slotstate/$k.json || ok=0; done
[ $ok = 1 ]
X
result "the link: two desks placed by DeskSlot tags (one with the class field) and started by start_slot orders, each order once, a slot-session at each start; the link, inbound and stand-in checks pass with two running" $rc < $WORKDIR/o

RSE EIP=$EIP1 > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh; ok=1
out=$(egress 2); echo "slot 2 leaves from: $([ "$out" = "$EIP" ] && echo "the Elastic IP, now on its own address" || echo "SOMETHING ELSE (${out:-none})")"; [ "$out" = "$EIP" ] || ok=0
out=$(egress 1); echo "slot 1, its address without an Elastic IP now, leaves from: ${out:-nowhere}"; [ -z "$out" ] || ok=0
[ $ok = 1 ]
X
result "PF-01: slot 2 leaves from the Elastic IP once it's on slot 2's address, and slot 1 from nowhere then (never a neighbour's address or the host's)" $rc < $WORKDIR/o

RSE D1=$D1 D2=$D2 HOSTID=$INSTANCE_ID > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh; ok=1
for k in 1 2; do
  want=$([ $k = 1 ] && echo $D1 || echo $D2)
  r=$(get $k meta-data/instance-id); echo "slot $k: instance-id HTTP $(code "$r"), $([ "$(body "$r")" = "$want" ] && echo "its own desk ID" || echo "NOT its desk ID")"
  [ "$(code "$r")" = 200 ] && [ "$(body "$r")" = "$want" ] && [ "$(body "$r")" != "$HOSTID" ] || ok=0
  r=$(get $k meta-data/placement/region); echo "slot $k: region HTTP $(code "$r") $(body "$r")"; [ "$(code "$r")" = 200 ] || ok=0
  r=$(get $k meta-data/tags/instance/DeskKind); echo "slot $k: DeskKind HTTP $(code "$r") $(body "$r")"; [ "$(body "$r")" = test ] || ok=0
  r=$(get $k meta-data/iam/security-credentials/ma-shared-desk)
  ak=$(body "$r" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("AccessKeyId"))' 2>/dev/null)
  echo "slot $k: credentials HTTP $(code "$r"), the slot's own: $([ "$ak" = "ASIAFAKESLOT${k}E1" ] && echo yes || echo "NO ($ak)")"; [ "$ak" = "ASIAFAKESLOT${k}E1" ] || ok=0
  n=0; for p in meta-data/local-ipv4 meta-data/mac meta-data/ami-id meta-data/iam/info dynamic/instance-identity/document user-data \
      meta-data/tags/instance/DeskSlot1 meta-data/tags/instance/HostKind meta-data/network/interfaces/macs/ meta-data/placement/availability-zone; do
    r=$(get $k $p); [ "$(code "$r")" = 404 ] && n=$((n + 1)) || { echo "slot $k: $p HTTP $(code "$r")"; ok=0; }
  done; echo "slot $k: $n of 10 other metadata paths 404"
  c=$(inslot $k 1100 curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/instance-id); echo "slot $k: no token: HTTP $c"; [ "$c" = 401 ] || ok=0
done
[ $ok = 1 ]
X
result "the stand-in, from inside each slot as its deskd: its own desk ID as instance-id, region, its tags and its own credentials; nothing else of IMDS (404), never the host's ID; IMDSv2 only" $rc < $WORKDIR/o

RSE > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh; ok=1
no() { if inslot 1 "$1" "${@:2}" >/dev/null 2>&1; then echo "REACHED: ${*:2}"; ok=0; else echo "refused or dropped (uid $1): ${*:2}"; fi; }
no 1100 curl -s -m 3 -f http://10.98.2.1:9254/latest/api/token -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'   # slot 2's stand-in
no 1100 curl -s -m 3 -f http://10.98.1.1:9254/latest/api/token -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'   # its own, not by the metadata address
no 1100 curl -s -m 3 http://169.254.169.254:8080/
no 1100 curl -s -m 3 -k https://169.254.169.254/
no 1100 curl -s -m 3 -g 'http://[fd00:ec2::254]/latest/api/token' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'
no 1102 curl -s -m 3 -f http://169.254.169.254/latest/api/token -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'    # the kiosk: the desk's own firewall
no 1103 curl -s -m 3 -f http://169.254.169.254/latest/api/token -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'    # the agent
l=$(ss -Hltn | awk '{print $4}' | grep ':9254$' | sort | tr '\n' ' '); echo "stand-in listeners: $l"
[ "$l" = "10.98.1.1:9254 10.98.2.1:9254 " ] || ok=0
[ $ok = 1 ]
X
result "no slot reaches a neighbour's stand-in, its own listener directly, the metadata address on another port or over IPv6; its kiosk and agent are refused by the desk's own firewall; listeners on the slots' own addresses only" $rc < $WORKDIR/o

RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; ok=1
n=$(runc list -q | grep -cE '^dh-(desk-1|svc-1-)'); echo "slot 1's containers: $n"
cg=/sys/fs/cgroup/desk-host/desk-1
echo "cgroup: memory.max $(cat $cg/memory.max) swap.max $(cat $cg/memory.swap.max) zswap.max $(cat $cg/memory.zswap.max) zswap.writeback $(cat $cg/memory.zswap.writeback)"
echo "io.max:"; sed 's/^/  /' $cg/io.max
pid=$(runc state dh-desk-1 | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
grep -E 'idmapped' /proc/$pid/mountinfo | grep -q ' /data ' && echo "/data idmapped in the desk" || { echo "/data NOT idmapped"; ok=0; }
[ "$n" = 7 ] || ok=0
[ "$(cat $cg/memory.swap.max)" = 2147483648 ] && [ "$(cat $cg/memory.zswap.writeback)" = 0 ] || ok=0
[ "$(grep -c riops $cg/io.max)" = 2 ] || ok=0
for p in $(cat $cg/desk/init/cgroup.procs); do f=$(awk '/^Seccomp_filters/{print $2}' /proc/$p/status)
  case "$(tr '\0' ' ' < /proc/$p/cmdline)" in "/usr/bin/python3 -I /desk-host/desk-init.py"*) echo "desk-init pid $p: $f filters"; [ "$f" -ge 2 ] || ok=0 ;; esac; done
for i in $(seq 1 60); do grep -q 'deskd ready' <(python3 -I -c 'import sys; t = open(sys.argv[1], errors="replace").read(); print(t[t.rfind("] started "):])' /var/log/desk-host/svc-1-deskd.log 2>/dev/null) && break; sleep 2; done   # deskd past its FilesModule
out=$(/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only svc-dns,oom,files); echo "$out"   # Bug 8: every sandbox has the desk's resolver, and deskd, desk-rtc and desk-agent look a public name up
echo "$out" | grep -qE '^PASS host oom: [12] running slot\(s\), [1-9][0-9]* desk process\(es\) as the order says, lowest -500, the host.s own under -900' || ok=0   # S2
echo "$out" | grep -qE '^PASS host svc-dns: [12] running slot\(s\), (6|12) sandbox\(es\) with the desk.s resolver, (3|6) lookups' || ok=0
echo "$out" | grep -qE '^PASS host files: ([12]) running slot\(s\), \1 with deskd.s /data/files its volume.s, 1100:1100 0700' || ok=0   # free walk H5
cat /run/desk-host/1/slot.json
[ $ok = 1 ]
X
result "a desk on the image, started by the link: 7 containers (desk + 6 sandboxes), each sandbox with the desk's resolver and deskd, desk-rtc and desk-agent looking up a public name from inside (Bug 8), the memory rule, io.max on both devices, desk-init filtered, /data idmapped" $rc < $WORKDIR/o

# ---- 4f. ADR 0036 per container (TD-223, ADR 0072 section 8): slot 1's shaper on its veth and its budgets; test 1's R5 (the shaper
# dropped by the host, as a bug would drop it) fails the check, and putting it back passes
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; ok=1; L=/usr/local/lib/desk-host
s=$(desk-host shaper 1 show); echo "desk-host shaper 1 show: $s"
python3 -I -c 'import json,sys; s=json.loads(sys.argv[1]); c=s["classes"]; r={m: c[m]["rateBits"] for m in c}; print("rates", r, "1:15 bytes", c["15"]["bytes"])
sys.exit(0 if s["on"] and r == {"10": 60000000, "15": 2000000, "20": 100000000} and c["15"]["bytes"] > 0 and s.get("profile") == "normal" and s.get("slowed") is False else 1)' "$s" || ok=0
desk-host report | python3 -I -c 'import json,sys; s=[x for x in json.load(sys.stdin)["slots"] if x["k"] == 1][0].get("shaper") or {}; print("report, slot 1:", json.dumps(s)); sys.exit(0 if s.get("on") else 1)' || ok=0
echo "desk-host-egress@1: $(systemctl is-active desk-host-egress@1.service)"; systemctl is-active --quiet desk-host-egress@1.service || ok=0
ls -l /var/lib/desk-host/egress/ | tail -n +2 | sed 's/^/  state: /'
$L/desk-host-check --allow-verify-access --only shaper || ok=0
desk-host shaper 1 off
$L/desk-host-check --allow-verify-access --only shaper > /tmp/s.out 2>&1 && { echo "the check passed with the shaper off"; ok=0; }; cat /tmp/s.out
grep -q "shaper off" /tmp/s.out || ok=0
echo "eth0 in slot 1 with the shaper off: $(nsenter --net=/run/desk-host/ns/1/net tc qdisc show dev eth0 root | head -1)"
nsenter --net=/run/desk-host/ns/1/net tc qdisc show dev eth0 root | grep -q htb && ok=0
desk-host shaper 1 on
$L/desk-host-check --allow-verify-access --only shaper || ok=0
[ $ok = 1 ]
X
result "slot 1's outbound shaper (ADR 0036 per container): HTB 1:10, 1:15 and 1:20 at 60, 2 and 100 Mbit on its veth, the desk's own traffic counted in 1:15, the report carries it, its desk-egress ticks; desk-host shaper 1 off (test 1's R5) fails the shaper check, on passes it" $rc < $WORKDIR/o

fake_state running stopped
{ R "sudo python3 -I /root/fake/wait.py 300 1=running 2=unmounted,stopped" && RSE D1=$D1 <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; . /root/fake/inslot.sh; ok=1
sleep 6   # the link drops a stopped slot's stand-in at its next look
echo "slot 2 left: [$(desk-host leftovers 2 | cut -d: -f2-)]"; [ -z "$(desk-host leftovers 2 | cut -d: -f2- | tr -d ' ')" ] || ok=0
l=$(ss -Hltn | awk '{print $4}' | grep ':9254$' | sort | tr '\n' ' '); echo "stand-in listeners: $l"; [ "$l" = "10.98.1.1:9254 " ] || ok=0
r=$(get 1 meta-data/instance-id); echo "slot 1 still: HTTP $(code "$r")"; [ "$(body "$r")" = "$D1" ] || ok=0
grep -E 'stop_slot' <(journalctl -u desk-host-link --no-pager -o cat) | sed 's/^/  link: /'
[ $ok = 1 ]
X
result "stop_slot stops its slot only: slot 2 unmounted with nothing left and its stand-in gone; slot 1 runs on and its stand-in answers" $rc < $WORKDIR/o

# PF-01: the Elastic IP taken off slot 2's address; the next start_slot must keep the slot down
aws ec2 disassociate-address --association-id "$(aws ec2 describe-addresses --allocation-ids "$A1" --query 'Addresses[0].AssociationId' --output text)" >/dev/null
sleep 20
fake_state running running
{ R "sudo python3 -I /root/fake/wait.py 300 2=unmounted,stopped 2^address_mismatch 1=running" && RS <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
grep -E 'refused|address' /var/log/desk-host/link-2.log | tail -2 | sed 's/^/  desk-host: /'
journalctl -u desk-host-link --no-pager -o cat | grep 'slot 2: start_slot' | tail -1 | sed 's/^/  link: /'
runc state dh-desk-2 >/dev/null 2>&1 && exit 1
true
X
result "PF-01: a slot whose public address IMDS no longer associates with its private address stays down, reported address_mismatch" $rc < $WORKDIR/o

fake_state stopped stopped
{ R "sudo python3 -I /root/fake/wait.py 300 1=unmounted,stopped" && RS <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; ok=1
sleep 6
for k in 1 2; do echo "slot $k left: [$(desk-host leftovers $k | cut -d: -f2-)]"; [ -z "$(desk-host leftovers $k | cut -d: -f2- | tr -d ' ')" ] || ok=0; done
/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only link,inbound,standin || ok=0
ls /var/log/desk-host/ | sed 's/^/  log: /'
[ $ok = 1 ]
X
result "stop_slot for the last desk: nothing left of either slot but its root and record; the checks pass with nothing running" $rc < $WORKDIR/o

# ---- 4b. size classes: free at start, standard live (nothing restarts), a raise past the host's units waits for room, a stop.
# By hand: the link stops (a stop leaves desks as they are; the fake wants both slots stopped, so a running link would stop the
# desk under test), and the Elastic IP goes back on slot 1's address, which up's association check needs. DeskSlot1 is still
# section 4's five-field tag, so `desk-host class 1` with no class reads standard from it.
aws ec2 associate-address --allocation-id "$A1" --network-interface-id "$ENI1" --private-ip-address "$PRIV1" --allow-reassociation >/dev/null
sleep 20
R 'sudo systemctl stop desk-host-link'
RS > $WORKDIR/o 2>&1 <<X && rc=0 || rc=$?
set -u
L=/usr/local/lib/desk-host; cg=/sys/fs/cgroup/desk-host/desk-1; ty=\$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: \$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)
ok=1
same() {   # same <class>: desk-1's cgroup holds exactly the class's values
  local w m sw zw p rrb rri rwb rwi vrb vri vwb vwi
  read -r w m sw zw p rrb rri rwb rwi vrb vri vwb vwi <<<"\$(python3 -I \$L/classes.py values \$1 \$ty)"
  echo "  \$1 wants: cpu.weight \$w (0: cpu.idle 1) memory.max \$m swap \$sw zswap \$zw pids \$p root rbps \$rrb volume rbps \$vrb"
  echo "  desk-1 has: cpu.idle \$(cat \$cg/cpu.idle) cpu.weight \$(cat \$cg/cpu.weight) memory.max \$(cat \$cg/memory.max) swap \$(cat \$cg/memory.swap.max) zswap \$(cat \$cg/memory.zswap.max) pids \$(cat \$cg/pids.max); io.max: \$(paste -sd' ' \$cg/io.max)"
  if [ "\$w" = 0 ]; then [ "\$(cat \$cg/cpu.idle)" = 1 ] || return 1; else [ "\$(cat \$cg/cpu.idle)" = 0 ] && [ "\$(cat \$cg/cpu.weight)" = "\$w" ] || return 1; fi
  [ "\$(cat \$cg/memory.max)" = "\$((m / 4096 * 4096))" ] && [ "\$(cat \$cg/memory.swap.max)" = "\$sw" ] \
    && [ "\$(cat \$cg/memory.zswap.max)" = "\$zw" ] && [ "\$(cat \$cg/pids.max)" = "\$p" ] && grep -q "rbps=\$rrb wbps=\$rwb riops=\$rri wiops=\$rwi" \$cg/io.max \
    && grep -q "rbps=\$vrb wbps=\$vwb riops=\$vri wiops=\$vwi" \$cg/io.max && [ "\$(cat \$cg/memory.zswap.writeback)" = 0 ]
}
procs() { find \$cg -name cgroup.procs -exec cat {} + | sort -n | paste -sd' '; }
desk-host up 1 $D1 $VOL1 free --public $EIP1 || exit 1
sleep 8
echo "free at start:"; same free || { echo "  NOT the free class"; ok=0; }
grep -q '"class": "free"' /run/desk-host/1/class.json || { echo "  class.json: \$(cat /run/desk-host/1/class.json)"; ok=0; }
\$L/desk-host-check --only class-applied || ok=0
before=\$(procs); echo "processes before: \$(echo \$before | wc -w)"
desk-host class 1 standard || ok=0
echo "standard, live:"; same standard || { echo "  NOT the standard class"; ok=0; }
after=\$(procs); echo "processes after: \$(echo \$after | wc -w), the same: \$([ "\$before" = "\$after" ] && echo yes || echo NO)"
[ "\$before" = "\$after" ] || ok=0
\$L/desk-host-check --only class-applied || ok=0
grep -q '"class": "standard"' /run/desk-host/1/class.json || { echo "  class.json: \$(cat /run/desk-host/1/class.json)"; ok=0; }   # (the report carries it too from the bake after 0.1.10)
desk-host class 1 free || ok=0; same free >/dev/null || ok=0
# six more standard desks' worth of memory on the host (cgroups only): the raise to standard waits (75), memory and disk kept
for j in 2 3 4 5 6 7; do mkdir /sys/fs/cgroup/desk-host/desk-\$j; python3 -I \$L/classes.py values standard \$ty | cut -d' ' -f2 > /sys/fs/cgroup/desk-host/desk-\$j/memory.max; done
fm=\$(cat \$cg/memory.max); fio=\$(paste -sd' ' \$cg/io.max)
desk-host class 1 standard; r=\$?; echo "a raise past 6 units: exit \$r"
[ "\$r" = 75 ] || ok=0
[ "\$(cat \$cg/memory.max)" = "\$fm" ] && [ "\$(paste -sd' ' \$cg/io.max)" = "\$fio" ] && echo "  memory.max and io.max unchanged (free's)" || { echo "  memory or disk CHANGED"; ok=0; }
[ "\$(cat \$cg/cpu.idle)" = 0 ] && [ "\$(cat \$cg/cpu.weight)" = 100 ] && [ "\$(cat \$cg/pids.max)" = 8192 ] && echo "  cpu.idle 0, cpu.weight and pids.max standard's at once" || { echo "  cpu.weight \$(cat \$cg/cpu.weight) pids \$(cat \$cg/pids.max)"; ok=0; }
grep -q '"pending": {"memory.max"' /run/desk-host/1/class.json || { echo "  no pending raise in class.json"; ok=0; }
\$L/desk-host-check --only class-applied && { echo "  class-applied passed with 6 units more: wrong"; ok=0; } || echo "  class-applied fails with the host past its units, as it should"
for j in 2 3 4 5 6 7; do rmdir /sys/fs/cgroup/desk-host/desk-\$j; done
desk-host class 1 || desk-host class 1 standard || ok=0   # room again: the waiting raise finishes (the tag, else the class by hand)
same standard >/dev/null && echo "  room again: standard whole" || { echo "  NOT standard after the retry"; ok=0; }
\$L/desk-host-check --only class-applied || ok=0
desk-host stop 1
echo "leftovers: [\$(desk-host leftovers 1 | cut -d: -f2-)]"
[ -z "\$(desk-host leftovers 1 | cut -d: -f2- | tr -d ' ')" ] || ok=0
[ "\$ok" = 1 ]
X
result "size classes: free at start, standard in place with every process kept, back to free, a raise past DesksPerHost units waits (75: CPU and pids at once, memory and disk kept) and finishes once there's room, a stop leaves nothing" $rc < $WORKDIR/o

# ---- 4c. the slot's byte counters count every byte, not each flow's first packet (a download's replies and its ACKs are established traffic)
RS > $WORKDIR/o 2>&1 <<X && rc=0 || rc=$?
set -u
ok=1; ns=/run/desk-host/ns/1/net
desk-host up 1 $D1 $VOL1 --public $EIP1 || exit 1
sleep 8
ip=\$(getent ahostsv4 deb.debian.org | awk 'NR==1{print \$1}')
cnt() { nft -j list counters table inet host | python3 -I -c 'import json,sys; c={o["counter"]["name"]: o["counter"]["bytes"] for o in json.load(sys.stdin)["nftables"] if "counter" in o}; print(c["out_1"], c["rx_1"])'; }
o0=\$(cat /sys/class/net/dhv1/statistics/rx_bytes); i0=\$(cat /sys/class/net/dhv1/statistics/tx_bytes); read -r a0 b0 <<<"\$(cnt)"
nsenter --net=\$ns curl -fsS -m 90 --resolve deb.debian.org:443:\$ip -o /dev/null -w 'downloaded %{size_download} bytes\\n' https://deb.debian.org/debian/dists/trixie/main/binary-arm64/Packages.xz || ok=0
o1=\$(cat /sys/class/net/dhv1/statistics/rx_bytes); i1=\$(cat /sys/class/net/dhv1/statistics/tx_bytes); read -r a1 b1 <<<"\$(cnt)"
python3 -I - \$((o1 - o0)) \$((a1 - a0)) \$((i1 - i0)) \$((b1 - b0)) <<'P' || ok=0
import sys
o, a, i, b = map(int, sys.argv[1:])
print(f"desk sent: veth {o} B, out_1 {a} B ({a / max(o, 1):.3f}); desk received: veth {i} B, rx_1 {b} B ({b / max(i, 1):.3f})")
sys.exit(0 if o > 5000 and 0.7 < a / o <= 1.0 and i > 1000000 and abs(b / i - 1) < 0.05 else 1)   # out is mostly small ACKs, 14 B of 66 are the veth's header
P
desk-host report | python3 -I -c 'import json, sys; s = [x for x in json.load(sys.stdin)["slots"] if x["k"] == 1][0]; print("report:", s["net"]); sys.exit(0 if s["net"]["bytesIn"] > 0 and s["net"]["bytesOut"] > 0 else 1)' || { echo "report carries no bytesIn"; ok=0; }
grep -q '"bytesIn": [1-9]' /run/desk-host/1/net.json || { echo "net.json: \$(cat /run/desk-host/1/net.json)"; ok=0; }
desk-host stop 1
[ "\$ok" = 1 ]
X
result "the slot's byte counters match its interface's (a download's replies, established traffic, counted: rx within 5%, out with its ACKs within the veth's 14-byte headers)" $rc < $WORKDIR/o
R 'sudo systemctl start desk-host-link; sleep 10; systemctl is-active desk-host-link' >/dev/null || say "the link didn't start again (the mutation pass will say so)"

# ---- 4d. desk-svc's restart back-off, on the baked binary (reliability audit S1; verify-backoff.sh runs the real desk-svc as a plain
# supervisor over a job that exits at once). The three runs go side by side: as built (waits 1, 2, 4, 8, 16 s, then back to 1 after a
# healthy run), with the steps taken off (flat: must fail) and with no run ever healthy (never starts over: must fail).
BIN=/usr/local/lib/desk-host/desk/desk-svc
R "sudo bash -s -- $BIN" < "$HERE/verify-backoff.sh" > $WORKDIR/b1 2>&1 &
R "sudo bash -s -- $BIN -restart-steps 0" < "$HERE/verify-backoff.sh" > $WORKDIR/b2 2>&1 &
R "sudo bash -s -- $BIN -healthy-sec 1000" < "$HERE/verify-backoff.sh" > $WORKDIR/b3 2>&1 &
wait
rc=0; grep -q -e '^FAILED$' $WORKDIR/b1 && rc=1; grep -q '^ran to the end$' $WORKDIR/b1 || rc=1
result "desk-svc, the supervisor of every sandbox, backs off its restarts: waits of 1, 2, 4, 8 and 16 s in a row, back to 1 s after a run of 6 s, and then 2 s again" $rc < $WORKDIR/b1
rc=1; grep -q -e '^FAILED$' $WORKDIR/b2 && rc=0
result "that check fails with the steps off (-restart-steps 0, a flat 1 s wait)" $rc < $WORKDIR/b2
rc=1; grep -q -e '^FAILED$' $WORKDIR/b3 && rc=0
result "that check fails when no run counts as healthy (-healthy-sec 1000, the wait never starts over)" $rc < $WORKDIR/b3

# ---- 4g. ADR 0078: a service batch's fetch on the host (verify-batches.sh: a test release made from the store's own desk-rtc, a throwaway
# key trusted as a TEST key for this step only, served on the loopback): the candidate, the refusals before any download, on its bytes
# and for room, each with its mutation (DESK_HOST_BATCH_MUT) failing its step. The live switch, rollback, canary and stop path: the lab's.
RS < "$HERE/verify-batches.sh" > $WORKDIR/o 2>&1 && rc=0 || rc=$?
result "4g. a service batch's fetch: candidate, refusals (signature, floor, format, bytes, room), each mutation failing its step" $rc < $WORKDIR/o

# ---- 5. the mutation pass: each check broken must FAIL, put back must PASS (svc-dns needs a sandbox: slot 1 is started by hand, the link stopped, for its one mutation)
RSE D1=$D1 VOL1=$VOL1 EIP1=$EIP1 > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
C="/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only"
T=/srv/desk-host/templates/$(/usr/local/lib/desk-host/desk-host-template current); L=/usr/local/lib/desk-host   # the current template generation (ADR 0077)
bad=0; n=0
rmut() {   # rmut break|fix: slot 1's deskd sandbox without the desk's resolver, as 0.1.8 had it (the bind unmounted: the release's empty file), and back
  python3 -I - "$1" "$(runc state dh-svc-1-deskd | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')" "$T/etc/resolv.conf" /etc/resolv.conf <<'P'
import ctypes, os, sys
what, pid, src_path, dst = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
if what == "fix":   # the template's file as a detached clone, taken before the move into the sandbox's mount namespace
    tree = libc.syscall(428, -100, src_path.encode(), 0x1 | 0o2000000)   # open_tree(AT_FDCWD, path, OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC)
    if tree < 0:
        sys.exit(ctypes.get_errno() or 1)
os.setns(os.open(f"/proc/{pid}/ns/mnt", os.O_RDONLY), os.CLONE_NEWNS)
if what == "break":
    r = libc.umount2(dst.encode(), 2)
else:
    r = libc.syscall(429, tree, b"", -100, dst.encode(), 4)   # move_mount(tree, "", AT_FDCWD, dst, MOVE_MOUNT_F_EMPTY_PATH)
sys.exit(0 if r == 0 else ctypes.get_errno() or 1)
P
}
fmut() {   # fmut break|fix: slot 1's deskd with 0.1.10's /data/files (a root-owned mode 000 tmpfs over the volume's: its placeholder), and back
  python3 -I - "$1" "$(runc state dh-svc-1-deskd | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')" <<'P'
import ctypes, os, sys
what, pid = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
# the sandbox's mounts, read from the host's /proc before setns: inside, /proc is the sandbox's own and has no /proc/self for this process
top = [l.split() for l in open(f"/proc/{pid}/mountinfo") if l.split()[4] == "/data/files"]
os.setns(os.open(f"/proc/{pid}/ns/mnt", os.O_RDONLY), os.CLONE_NEWNS)
if what == "break":
    r = libc.mount(b"h5-mutation", b"/data/files", b"tmpfs", 0x2 | 0x4 | 0x8, b"mode=000,size=4k")   # nosuid, nodev, noexec
else:   # only the mutation's own tmpfs, if it's the top mount there: never the volume's
    r = libc.umount2(b"/data/files", 0) if top and top[-1][top[-1].index("-") + 2] == "h5-mutation" else -1
sys.exit(0 if r == 0 else ctypes.get_errno() or 1)
P
}
m() {   # m <check> <break> <restore>
  local c=$1 b=$2 r=$3 f p
  eval "$b" >/dev/null 2>&1; $C "$c" >/tmp/m.out 2>&1 && f=PASS || f=FAIL
  eval "$r" >/dev/null 2>&1; $C "$c" >/tmp/m2.out 2>&1 && p=PASS || p=FAIL
  n=$((n+1)); echo "$c: broken -> $f, restored -> $p   ($(cut -c1-150 /tmp/m.out))"
  [ "$f" = FAIL ] && [ "$p" = PASS ] || bad=1
}
omut() {   # omut <adj>: every process of slot 1's deskd sandbox set to <adj> (the kill order broken, and put back)
  local pid p; pid=$(runc state dh-svc-1-deskd | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  for p in $(cat /sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$pid/cgroup)/cgroup.procs); do echo "$1" > /proc/$p/oom_score_adj; done
}
cp -a /usr/local/sbin/runc /root/runc.keep; cp -a $L/desk/desk-svc /root/svc.keep; cp -a /etc/modprobe.d/desk-host.conf /root/mp.keep
cp -a $L/apparmor.tmpl /root/aa.keep; cp -a /var/lib/desk-host/hosting.json /root/h.keep; cp -a /home/admin/.ssh/authorized_keys /root/ak.keep
cp -a /srv/desk-host/releases/deskd/current/run /root/run.keep; cp -a /etc/desk-host/classes.conf /root/cl.keep
systemctl stop desk-host-link
desk-host up 1 $D1 $VOL1 --public $EIP1 >/tmp/up1.out 2>&1 || { bad=1; cat /tmp/up1.out; }
sleep 8
m svc-dns "rmut break" "rmut fix"
m oom "omut 0" "omut -500"
m files "fmut break" "fmut fix"
m shaper "systemctl kill -s SIGSTOP desk-host-egress@1.service; nsenter --net=/run/desk-host/ns/1/net tc qdisc del dev eth0 root" "desk-host shaper 1 on; sleep 1"
desk-host stop 1 >/dev/null 2>&1
systemctl start desk-host-link; sleep 5
m runc "printf x >> /usr/local/sbin/runc" "cp -a /root/runc.keep /usr/local/sbin/runc"
m kernel "touch /boot/vmlinuz-0.0-cloud-arm64" "rm -f /boot/vmlinuz-0.0-cloud-arm64"
m zswap "echo N > /sys/module/zswap/parameters/enabled" "echo Y > /sys/module/zswap/parameters/enabled"
m swap "swapoff /var/lib/desk-host/swap" "swapon -p 10 /var/lib/desk-host/swap"
m sysctl "sysctl -w dev.tty.ldisc_autoload=1" "sysctl -w dev.tty.ldisc_autoload=0"
m modules "sed -i '/^install n_hdlc /d' /etc/modprobe.d/desk-host.conf" "cp -a /root/mp.keep /etc/modprobe.d/desk-host.conf"
m units "systemctl unmask deskd.service" "systemctl mask deskd.service"
m uids "setpriv --reuid=1105 --regid=1105 --clear-groups sleep 60 &" "pkill -u 1105 sleep; sleep 0.5"
m nft "nft add table inet extra" "nft delete table inet extra"
m store "mount -o remount,bind,rw $T" "mount -o remount,bind,ro,nosuid,nodev $T"
m template "mount -o remount,bind,rw $T; touch $T/etc/ssh/ssh_host_test_key" "rm -f $T/etc/ssh/ssh_host_test_key; mount -o remount,bind,ro,nosuid,nodev $T"
m releases "printf x >> /srv/desk-host/releases/deskd/current/run" "cp -a /root/run.keep /srv/desk-host/releases/deskd/current/run"
m desk-svc "printf x >> $L/desk/desk-svc" "cp -a /root/svc.keep $L/desk/desk-svc"
m no-test "touch /etc/desk-host/test.conf; mkdir -p /var/lib/desk-host/test" "rm -f /etc/desk-host/test.conf; rmdir /var/lib/desk-host/test"
m apparmor "echo 'profile bad {' >> $L/apparmor.tmpl" "cp -a /root/aa.keep $L/apparmor.tmpl"
m cgroup "echo -io > /sys/fs/cgroup/desk-host/cgroup.subtree_control" "echo +io > /sys/fs/cgroup/desk-host/cgroup.subtree_control"
m boot "systemctl stop desk-host-shutdown.service" "systemctl start desk-host-shutdown.service"
m dirs "chmod 700 /srv/desk-host" "chmod 711 /srv/desk-host"
m hosting "mv /var/lib/desk-host/hosting.json /root/h.moved" "cp -a /root/h.keep /var/lib/desk-host/hosting.json"
m ssh "echo 'ssh-ed25519 AAAAtest second' >> /home/admin/.ssh/authorized_keys" "cp -a /root/ak.keep /home/admin/.ssh/authorized_keys"
m link "systemctl stop desk-host-link" "systemctl start desk-host-link; sleep 3"
m inbound "nft insert rule inet host input icmp type echo-request accept" \
  "for h in \$(nft -a list chain inet host input | sed -n 's/.*icmp type echo-request accept # handle \\([0-9]*\\)\$/\\1/p'); do nft delete rule inet host input handle \$h; done"
m standin "nft add rule ip host_nat pre ip daddr 169.254.169.254 tcp dport 80 dnat to 10.98.9.1:9254" \
  "for h in \$(nft -a list chain ip host_nat pre | sed -n 's/.*dnat to 10.98.9.1:9254 # handle \\([0-9]*\\)\$/\\1/p'); do nft delete rule ip host_nat pre handle \$h; done"
m classes "sed -i 's/^standard .*/standard 1 0.9 1 1 1 1 1/' /etc/desk-host/classes.conf" "cp -a /root/cl.keep /etc/desk-host/classes.conf"
m class-applied "mkdir /sys/fs/cgroup/desk-host/desk-29" "rmdir /sys/fs/cgroup/desk-host/desk-29"
m counters 'h=$(nft -a list chain inet host forward | sed -n "s/.*jump desk_est # handle \\([0-9]*\\)/\\1/p"); nft delete rule inet host forward handle $h' \
  'a=$(nft -a list chain inet host forward | sed -n "s/.*ct state .*established.*accept # handle \\([0-9]*\\)/\\1/p"); nft insert rule inet host forward position $a ct state established,related jump desk_est'
# ADR 0077's four (template generations and the host's own updates): one counted break each, and each one's second break (m2)
m2() {   # m2 <check> <break> <restore>: a further break of a check already counted, which must FAIL and then PASS too
  local c=$1 b=$2 r=$3 f p
  eval "$b" >/dev/null 2>&1; $C "$c" >/tmp/m.out 2>&1 && f=PASS || f=FAIL
  eval "$r" >/dev/null 2>&1; $C "$c" >/tmp/m2.out 2>&1 && p=PASS || p=FAIL
  echo "$c (its second break): broken -> $f, restored -> $p   ($(cut -c1-150 /tmp/m.out))"
  [ "$f" = FAIL ] && [ "$p" = PASS ] || bad=1
}
tmut() {   # tmut break|fix: one byte of a current-generation file written through the store's writable path (the store itself, under the read-only bind)
  # the directory made only while nothing is bound there: install -d on the bind would chmod the store's own root to 700, and no desk's
  # root could then reach a sandbox's root under it (sub/host-batches finding 6: every runc create after this pass refused)
  mountpoint -q /root/st || { install -d -m 700 /root/st; mount --bind /srv/desk-host /root/st; }
  local f=/root/st/templates/$(basename "$T")/etc/debian_version
  if [ "$1" = break ]; then cp -a "$f" /root/dv.keep; printf X | dd of="$f" bs=1 count=1 conv=notrunc status=none; else cat /root/dv.keep > "$f"; umount /root/st; fi
}
sdev=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as T; print(T.disk_of(T.DH))')
m templates "tmut break" "tmut fix"
m2 templates "cp -a /var/lib/desk-host/slots/1.json /root/rec.keep; python3 -I -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r[\"template\"]=\"g99\"; json.dump(r, open(p, \"w\"))' /var/lib/desk-host/slots/1.json" \
  "cp -a /root/rec.keep /var/lib/desk-host/slots/1.json"
m template-sig "openssl ecparam -name prime256v1 -genkey -noout | openssl ec -pubout -out /etc/desk-host/template-keys/unpinned.pem" "rm -f /etc/desk-host/template-keys/unpinned.pem"
m2 template-sig "mkdir /etc/desk-host/template-keys.d" "rmdir /etc/desk-host/template-keys.d"
# the link's signing region: the API's us-east-1 for both envs, never the instance's (S-120); the conf's prod region changed must fail
m2 link "cp -a /etc/desk-host/desk-host.conf /root/dhc.keep; sed -i 's/^LINK_API_REGION_prod=.*/LINK_API_REGION_prod=us-west-2/' /etc/desk-host/desk-host.conf" \
  "cp -a /root/dhc.keep /etc/desk-host/desk-host.conf"
m update-cgroup "echo '$sdev rbps=max wbps=max riops=max wiops=max' > /sys/fs/cgroup/desk-host-upd/io.max" "python3 -I /usr/local/lib/desk-host/desk-host-template upd-ensure"
m2 update-cgroup "python3 -I -c 'import time; time.sleep(120)' /usr/local/lib/desk-host/desk-host reroot 9 >/dev/null 2>&1 < /dev/null & echo \$! > /root/rr.pid; sleep 0.5" \
  "kill \$(cat /root/rr.pid); sleep 0.5"
# ADR 0078's (service batches): batch-sig, svc-spec, the rewritten releases and the widened update-cgroup, each broken (and a second break)
TB="touch /etc/desk-host/test.conf; mkdir -p /var/lib/desk-host/test"; TU="rm -f /etc/desk-host/test.conf; rmdir /var/lib/desk-host/test"
m batch-sig "cp -a /etc/desk-host/batch-keys/ma-desk-batch-2026-11.pem /root/bk.keep; openssl ecparam -name prime256v1 -genkey -noout | openssl ec -pubout -out /etc/desk-host/batch-keys/ma-desk-batch-2026-11.pem" \
  "cp -a /root/bk.keep /etc/desk-host/batch-keys/ma-desk-batch-2026-11.pem"
m2 batch-sig "mkdir /etc/desk-host/batch-keys.d" "rmdir /etc/desk-host/batch-keys.d"
# svc-spec's two breaks need a running slot 1 (resandbox, and its svc/desk-rtc/config.json): started by hand with the link stopped, as svc-dns's is
systemctl stop desk-host-link; desk-host up 1 $D1 $VOL1 --public $EIP1 >/tmp/up1b.out 2>&1 || { bad=1; cat /tmp/up1b.out; }; sleep 8
# a sandbox made again by the switch's own steps with a capability added (a test host's flag), then made again without it
m svc-spec "$TB; SWITCH_ADD_CAP=1 desk-host resandbox 1 desk-agent >> /root/resandbox.log 2>&1; $TU" "$TB; desk-host resandbox 1 desk-agent >> /root/resandbox.log 2>&1; $TU"
echo "  resandbox: $(tail -4 /root/resandbox.log 2>/dev/null | cut -c1-160 | tr '\n' ' '); runc's: $(grep -v '^\[desk-svc' /var/log/desk-host/svc-1-desk-agent.log | tail -3 | cut -c1-200 | tr '\n' ' ')"
echo "  slot 1's cgroup: memory $(cat /sys/fs/cgroup/desk-host/desk-1/memory.current)/$(cat /sys/fs/cgroup/desk-host/desk-1/memory.max), pids $(cat /sys/fs/cgroup/desk-host/desk-1/pids.current)/$(cat /sys/fs/cgroup/desk-host/desk-1/pids.max), class $(cat /run/desk-host/1/class.json 2>/dev/null)"
m2 svc-spec "cp -a /srv/desk-host/slots/1/svc/desk-rtc/config.json /root/rtc.keep; python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[\"mounts\"]=[m for m in d[\"mounts\"] if m[\"destination\"]!=\"/run/desk-egress\"]; json.dump(d, open(p, \"w\"))' /srv/desk-host/slots/1/svc/desk-rtc/config.json" \
  "cp -a /root/rtc.keep /srv/desk-host/slots/1/svc/desk-rtc/config.json"
desk-host stop 1 >/dev/null 2>&1; systemctl start desk-host-link; sleep 5   # svc-spec's slot is stopped again, as the later mutations expect
cp -a /srv/desk-host/slots/1/rel/deskd/run /root/srun.keep 2>/dev/null; cp -a /var/lib/desk-host/slots/1.json /root/rec1.keep
m2 releases "printf x >> /srv/desk-host/slots/1/rel/deskd/run" "cp -a /root/srun.keep /srv/desk-host/slots/1/rel/deskd/run"
m2 releases "python3 -I -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r[\"releases\"]=dict(r.get(\"releases\") or {}, deskd=\"0.0-none\"); json.dump(r, open(p, \"w\"))' /var/lib/desk-host/slots/1.json" \
  "cp -a /root/rec1.keep /var/lib/desk-host/slots/1.json"
m2 update-cgroup "python3 -I -c 'import time; time.sleep(120)' /usr/local/lib/desk-host/desk-host-batch copy 9 >/dev/null 2>&1 < /dev/null & echo \$! > /root/cp.pid; sleep 0.5" \
  "kill \$(cat /root/cp.pid); sleep 0.5"
m host-apt "apt-mark unhold nftables" "apt-mark hold nftables"
m2 host-apt "sed -i 's/Automatic-Reboot \"false\"/Automatic-Reboot \"true\"/' /etc/apt/apt.conf.d/51desk-host-unattended" \
  "sed -i 's/Automatic-Reboot \"true\"/Automatic-Reboot \"false\"/' /etc/apt/apt.conf.d/51desk-host-unattended"
# SlotMode=port's four, under address: no demux ground, nothing on the host's 443, a SlotMode that must be address or port
own=$(ip -4 -j addr show dev "$(ip -4 -j route show default | python3 -I -c 'import json,sys; print(min(json.load(sys.stdin), key=lambda r: r.get("metric", 0))["dev"])')" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["addr_info"][0]["local"])')
guess='python3 -I -c "import json; p = \"/var/lib/desk-host/hosting.json\"; h = json.load(open(p)); h[\"slotMode\"] = \"guess\"; json.dump(h, open(p, \"w\"))"'
m slotmode "nft add rule inet host host_in tcp dport 443 accept" \
  "for h in \$(nft -a list chain inet host host_in | sed -n 's/.*tcp dport 443 accept # handle \\([0-9]*\\)\$/\\1/p'); do nft delete rule inet host host_in handle \$h; done"
m addresses "$guess" "cp -a /root/h.keep /var/lib/desk-host/hosting.json"
m demux "systemd-run --quiet --unit=ma-verify-443 python3 -m http.server 443 --bind $own; sleep 1" "systemctl stop ma-verify-443"
m ports "$guess" "cp -a /root/h.keep /var/lib/desk-host/hosting.json"
echo "mutations: $n"
all=$(/usr/local/lib/desk-host/desk-host-check --list | wc -w); echo "checks: $all"
[ "$n" = "$all" ] || bad=1
/usr/local/lib/desk-host/desk-host-check --allow-verify-access >/tmp/final.out 2>&1 && echo "every check passes again" || { echo "NOT ALL PASS after the mutations"; grep FAIL /tmp/final.out; bad=1; }
[ "$bad" = 0 ]
X
result "the mutation pass: every host check, broken, fails; put back, passes" $rc < $WORKDIR/o

# ---- 6. Platform's reclaim wave (2026-11-11, verify-wave.sh): every slot prepared again at once on a store filled until it holds one root
# more; then the same wave with 0.1.11's prepare (the mutation) must fail, and the real desk-host prepares every slot again, one at a time
R "sudo bash -s -- real" < "$HERE/verify-wave.sh" > $WORKDIR/w1 2>&1 && rc=0 || rc=$?
grep -qx 'WAVE PASS' $WORKDIR/w1 || rc=1
result "Platform's reclaim wave: every slot prepared again at once on a store with room for one root more; each succeeds, or refuses for room (75) and then succeeds alone; no ENOSPC, no partial tree left, the store never full, the copies in the host's turn" $rc < $WORKDIR/w1
R "sudo bash -s -- mutation" < "$HERE/verify-wave.sh" > $WORKDIR/w2 2>&1 && rc=0 || rc=$?
{ grep -q '^MUTATED WAVE FAIL' $WORKDIR/w2 && grep -qx 'RESTORE PASS' $WORKDIR/w2; } || rc=1
result "that check fails with 0.1.11's prepare (the mutation: ENOSPC and partial trees); the real prepare, one slot at a time, then removes what it left" $rc < $WORKDIR/w2

# ---- 7. slot-datadirs (EXP-7's class on a shared host, verify-links.sh): a link the Browser's user puts at /data/browser/home before a
# slot start isn't followed by the slot's init; then the same with 0.1.11.1's desk-init (the mutation: root's makedirs, chown and chmod by
# name hand kiosk the link's target) must fail, and the real one, put back, passes again. The old init comes from git (OLD_INIT_REF: the
# last commit with it; update it if desk-init.py changes so much that the old one no longer starts on this host).
OLD_INIT_REF=b7cb1421
git -C "$HERE" show "$OLD_INIT_REF:image/host/recipe/files/usr/local/lib/desk-host/desk/desk-init.py" | R 'sudo tee /root/desk-init.old.py >/dev/null'
R "sudo bash -s -- real $D1 $VOL1 $EIP1" < "$HERE/verify-links.sh" > $WORKDIR/l1 2>&1 && rc=0 || rc=$?
grep -qx 'LINKS PASS' $WORKDIR/l1 || rc=1
result "slot-datadirs: a link the Browser's user put at /data/browser/home before a slot start isn't followed (its target, the desk's root's directory, still root's 0755; desk-init says it couldn't make home as kiosk); units.sock bound desk:desk 0600" $rc < $WORKDIR/l1
R "sudo bash -s -- mutation $D1 $VOL1 $EIP1" < "$HERE/verify-links.sh" > $WORKDIR/l2 2>&1 && rc=0 || rc=$?
{ grep -q '^MUTATED LINKS FAIL' $WORKDIR/l2 && grep -qx 'RESTORE PASS' $WORKDIR/l2; } || rc=1
result "that check fails with 0.1.11.1's desk-init (the mutation: the link's target handed to kiosk); the real desk-init, put back, passes it again" $rc < $WORKDIR/l2

say "RESULT: $PASS passed, $FAILN failed ($AMI on $TYPE)"
[ "$FAILN" = 0 ]
