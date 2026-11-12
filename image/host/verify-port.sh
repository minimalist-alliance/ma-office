#!/usr/bin/env bash
# image/host/verify-port.sh <ami-id> [instance type]: prove a shared-host AMI under SlotMode=port, one public IPv4 for the host
# (the owner's choice B, ADR 0072 section 6's 2026-11-10 note; image/host/README.md, "One address per host"). verify.sh runs it
# when SLOT_MODE=port; a bake runs both. Boots the AMI as Platform would under B: one interface with its own auto-assigned public
# IPv4 and no Elastic IP, tags DesksPerHost, SlotsPerHost, HostingVersion and SlotMode=port, instance metadata tags on, IMDSv2 at
# one hop, with temporary SSH for this run only. Then:
#   1. boot, as verify.sh's;
#   2. a fake Platform on the host's loopback answering hello and slot-session with each slot's udpPort and the host's publicIp,
#      desk-host-link pointed at it; every desk-host-check check (33 from the bake after 0.1.10: shaper, TD-223, and files, H5);
#   2b. the template key's trust anchor and its mutation (verify-template-anchor.sh), as verify.sh's;
#   3. the slot tag: "-" in the address fields parses only under SlotMode=port, an address tag only under address (on the host);
#   4. a desk placed by DeskSlot1 (its address fields "-") and started by start_slot: its desk-rtc's settings and ports; it leaves
#      from the host's own address with a source port in its own block; from outside (this workstation, as any client): UDP
#      4431 reaches slot 1 alone and 4432 nothing; TCP 4431, the stand-in's port and ping nothing; on TCP 443 the demux closes
#      HTTP, TLS, a ufrag with no slot and a stopped slot's at once and silence within its wait, and hands slot 1's binding
#      request to slot 1 with this workstation's own address as the source (conntrack), counted both ways; no address beyond
#      the host's own; a stop takes the slot out of the demux;
#   4b. set_class through the link (S-119, contract 0.3.46) on slot 1 while it runs, the Browser up with a cookie: down to free,
#       the refusals (an unknown class, another desk's order, no room for the raise, a stopping host: nothing changed), free to
#       standard and back to free, each in place (the cgroup's values, every process and both containers kept, the cookie
#       back); then its mutation, set_class out of the link's OPS: the order is ignored and the step's check fails, put back passes;
#   4f. ADR 0036 per container (TD-223): slot 1's outbound shaper on its veth, its counters in the report, its desk-egress;
#       desk-host shaper 1 off (test 1's R5) fails the shaper check, on passes it;
#   4c. the slot's byte counters against its veth over the SNAT path (a download, as verify.sh's);
#   4d. a host stop (desk-host-shutdown's stop, stop-all) while a start is in flight, as the link leaves one when it stops first:
#       no desk left running and nothing of the slot left, a start after it refused (host_stopping), the unit's start ending that;
#   4g. ADR 0078: a service batch's fetch, its refusals and their mutations (verify-batches.sh);
#   5. the mutation pass: every check broken must FAIL, then put back must PASS.
#   6. Platform's reclaim wave (verify-wave.sh), as verify.sh's.
#   7. slot-datadirs (verify-links.sh), as verify.sh's.
#   8. desk image 0.3.5 in a slot (verify-parity.sh), as verify.sh's.
#   9. a start on a slot with no record and the JVMs' archives (verify-wake.sh), as verify.sh's.
# Evidence: image/host/evidence/verify-port-<ami>.txt (addresses replaced). Creates only tagged temporary resources, removed on exit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../lib.sh"
AMI=${1:?usage: verify-port.sh <ami-id> [type]}; TYPE=${2:-m7g.xlarge}
INSTANCE_ID=; SG_ID=; KEY_NAME=; WORKDIR=; VOLS=()
PASS=0; FAILN=0
mkdir -p "$HERE/evidence"; EV=$HERE/evidence/verify-port-$AMI.txt; [ -n "${VERIFY_OVERLAY:-}" ] && EV=$HERE/evidence/verify-port-overlay${VERIFY_TAG:+-$VERIFY_TAG}-$AMI.txt; : > "$EV"   # VERIFY_TAG names one tree's overlay run
cleanup() {
  local rc=$?; trap - EXIT; set +e
  local v
  for v in "${VOLS[@]}"; do aws ec2 detach-volume --volume-id "$v" --force >/dev/null 2>&1; done
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
result() { local ev; ev=$(cat | scrub); if [ "$2" = 0 ]; then PASS=$((PASS+1)); say "PASS  $1"; else FAILN=$((FAILN+1)); say "FAIL  $1"; fi; echo "$ev" | sed 's/^/        /' >> "$EV"; }
R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$IP" "$@"; }
RS() { R "sudo bash -s"; }
RSE() { R "sudo env $* bash -s"; }

make_temp_access "ma-host-verify-port-$$"
MYIP=$(my_ip)
# ma-shared-host's inbound under B (Platform's), for this workstation only: UDP 4431 to 4436 and TCP 443; ICMP and TCP 4431
# and 9254 too, so that only the host's own ruleset is what answers them (or doesn't)
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$MYIP/32}]" "IpProtocol=udp,FromPort=4431,ToPort=4436,IpRanges=[{CidrIp=$MYIP/32}]" \
  "IpProtocol=tcp,FromPort=4431,ToPort=4431,IpRanges=[{CidrIp=$MYIP/32}]" "IpProtocol=tcp,FromPort=9254,ToPort=9254,IpRanges=[{CidrIp=$MYIP/32}]" \
  "IpProtocol=icmp,FromPort=-1,ToPort=-1,IpRanges=[{CidrIp=$MYIP/32}]" >/dev/null 2>&1 || die "can't add the inbound rules to $SG_ID"
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
  --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=ma-host-verify-port},{Key=DesksPerHost,Value=6},{Key=SlotsPerHost,Value=6},{Key=HostingVersion,Value=verify},{Key=SlotMode,Value=port}]/")" "$(tagspec volume)" \
  --query 'Instances[0].InstanceId' --output text)
log "instance $INSTANCE_ID ($TYPE)"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
wait_ssh "$IP" "$KEY_FILE" 600 || die "ssh never came up"
T_SSH=$(( $(date +%s) - T0 ))
say "AMI $AMI ($(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text)) on $TYPE under SlotMode=port, instance $INSTANCE_ID, ssh $T_SSH s after run-instances"
R 'sudo cloud-init status --wait >/dev/null 2>&1; true'
# LAB ONLY, never a release proof (a release is verified on its own baked AMI): VERIFY_OVERLAY=<dir> lays an unbaked tree's host files over
# an earlier AMI after it boots (lab/restart-oom/host-overlay.sh makes the directory), so this run exercises them. The evidence file is
# named for it. An overlay may carry desk-svc and its sha256 file: the host checks the binary against it.
if [ -n "${VERIFY_OVERLAY:-}" ]; then
  [ -d "$VERIFY_OVERLAY" ] || die "VERIFY_OVERLAY isn't a directory"
  tar -C "$VERIFY_OVERLAY" -cf - . | R 'sudo tar --no-same-owner --no-same-permissions -C / -xf - && sudo systemctl mask desk-restart-reset.service desk-restart-reset.timer && sudo systemctl daemon-reload && { [ ! -x /overlay-setup.sh ] || sudo /overlay-setup.sh; } && sudo systemctl restart desk-host-link.service && sudo systemctl try-restart desk-ice-demux.service'  # masked as the host build now masks them (DESK_UNITS); an overlay's own setup (lab/u77-host: the template becomes g1)
  say "OVERLAY: $(cd "$VERIFY_OVERLAY" && find . -type f | sort | tr '\n' ' ')"
fi

# ---- 1. boot
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u
for i in $(seq 1 60); do systemctl is-active --quiet desk-host-boot.service && break; sleep 2; done
echo "kernel $(uname -r)"
journalctl -u desk-host-boot --no-pager -o cat | sed 's/^/  /'
echo "desk-ice-demux: $(systemctl is-active desk-ice-demux)"
echo "--- the boot state, before this run's SSH"; grep -v '^\(tcp\|udp\).*:22 ' /var/tmp/prestate.txt
u=$(uname -r)
[[ $u == *-arm64 && $u != *cloud* ]] && systemctl is-active --quiet desk-host-boot && systemctl is-active --quiet desk-ice-demux \
  && ! grep -q '^/.*authorized_keys' /var/tmp/prestate.txt && grep -q 'ssh enabled at boot: \(disabled\|masked\|not-found\)' /var/tmp/prestate.txt \
  && grep -q '"slotMode": "port"' /var/lib/desk-host/hosting.json
X
aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].[MetadataOptions.HttpTokens,MetadataOptions.HttpPutResponseHopLimit,MetadataOptions.InstanceMetadataTags,length(NetworkInterfaces)]' --output text >> $WORKDIR/o
grep -q $'^required\t1\tenabled\t1$' $WORKDIR/o || rc=1
result "boot: SlotMode=port read from the launch tags, desk-host-boot ok, desk-ice-demux running, no keys or SSH at boot, IMDSv2 one hop with tags, one interface" $rc < $WORKDIR/o

# ---- 2. a fake Platform on the host's loopback, desk-host-link pointed at it; then the host's own checks
D1=d-hostverifyaa; D2=d-hostverifybb
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$HERE/tests/fake_platform.py" "admin@$IP:/home/admin/" >/dev/null
fake_state() {   # fake_state <want slot 1> <want slot 2>: under B each slot names its udpPort and the host's public address
  python3 -I -c 'import json, sys
a = sys.argv
s = lambda k, d, v, want: {"deskId": d, "volumeId": v, "publicIp": a[6], "udpPort": 4430 + k, "epoch": 1, "want": want, "userId": f"verify-user-{k}", "deskKind": "test"}
print(json.dumps({"hostId": a[1], "env": "staging", "desksPerHost": 6, "reportSeconds": 10, "refreshAfterSeconds": 600,
                  "slots": {"1": s(1, a[2], a[4], a[7]), "2": s(2, a[3], a[5], a[8])}}))' \
    "$INSTANCE_ID" "$D1" "$D2" "${VOL1:-}" "${VOL2:-}" "$IP" "$1" "$2" \
    | R 'sudo tee /root/fake/state.json.tmp >/dev/null && sudo chmod 600 /root/fake/state.json.tmp && sudo mv /root/fake/state.json.tmp /root/fake/state.json'
}
R 'sudo install -d -m 700 /root/fake && sudo mv /home/admin/fake_platform.py /root/fake/ && sudo chown root:root /root/fake/fake_platform.py'
fake_state stopped stopped
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
systemd-run --quiet --unit=ma-verify-fake-platform --setenv=DESK_HOST_LIB=/usr/local/lib/desk-host \
  python3 -I /root/fake/fake_platform.py --port 18443 --state /root/fake/state.json --log /root/fake/requests.jsonl
echo 'LINK_API=http://127.0.0.1:18443' >> /etc/desk-host/desk-host.conf
echo 'DESKD_ENV=DESKD_API_URL=https://api.verify.invalid;DESKD_JWKS_URL=https://api.verify.invalid/v1/jwks' >> /etc/desk-host/desk-host.conf
systemctl restart desk-host-link
for i in $(seq 1 30); do grep -q '"route": "/v1/host/report", "status": 200' /root/fake/requests.jsonl 2>/dev/null && break; sleep 2; done
journalctl -u desk-host-link --no-pager -o cat | tail -5
python3 -I - <<'P'
import json
rows = [json.loads(l) for l in open("/root/fake/requests.jsonl")]
h = [r for r in rows if r["route"] == "/v1/host/hello"]
rep = [r for r in rows if r["route"] == "/v1/host/report" and r["status"] == 200]
print(f"hello: {[r['status'] for r in h]}; reports: {len(rep)}, slots in the last {len(rep[-1]['body']['slots']) if rep else 0}")
assert h and h[-1]["status"] == 200 and rep and len(rep[-1]["body"]["slots"]) == 6
P
python3 -I -c 'import json; h = json.load(open("/run/desk-host/link/hello.json")); print("hello slot 1:", h["slots"]["1"]); assert h["slots"]["1"]["udpPort"] == 4431 and h["slots"]["1"]["privateIp"] is None'
X
result "the link: hello names each slot's udpPort and the host's public address, reports to a fake Platform on the loopback, every request signed and checked" $rc < $WORKDIR/o

RS <<'X' > $WORKDIR/o 2>&1 || true
/usr/local/lib/desk-host/desk-host-check --allow-verify-access
X
while read -r st _ name rest; do
  [ "$st" = PASS ] || [ "$st" = FAIL ] || continue
  result "host ${name%:}" "$([ "$st" = PASS ] && echo 0 || echo 1)" <<<"$rest"
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

# ---- 3. the slot tag's address fields: "-" only under SlotMode=port (Platform's rule: a host never guesses)
AZ=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
mkvol() { aws ec2 create-volume --availability-zone "$AZ" --size 4 --volume-type gp3 --tag-specifications "$(tagspec volume)" --query VolumeId --output text; }
VOL1=$(mkvol); VOLS+=("$VOL1"); VOL2=$(mkvol); VOLS+=("$VOL2")
aws ec2 wait volume-available --volume-ids "$VOL1" "$VOL2"
aws ec2 attach-volume --volume-id "$VOL1" --instance-id "$INSTANCE_ID" --device /dev/sdg >/dev/null
aws ec2 attach-volume --volume-id "$VOL2" --instance-id "$INSTANCE_ID" --device /dev/sdh >/dev/null
aws ec2 wait volume-in-use --volume-ids "$VOL1" "$VOL2"
aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskSlot1,Value=$D1/$VOL1/-/-/1" "Key=DeskSlot2,Value=$D2/$VOL2/-/-/1/standard" \
  "Key=DeskSlot3,Value=-/-/10.0.0.5/eipalloc-0abc12345/1"
sleep 15   # IMDS shows new tags within seconds
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; L=/usr/local/lib/desk-host; ok=1
t() { python3 -I $L/slotnet.py tag "$1"; }
echo "SlotMode=port: DeskSlot1 (-/-) -> $(t 1 | sed 's/vol-[0-9a-f]*/vol-…/') (exit $?)"; t 1 >/dev/null || ok=0
echo "SlotMode=port: DeskSlot3 (an address and an allocation) -> $(t 3) "; t 3 >/dev/null && ok=0
cp -a /var/lib/desk-host/hosting.json /root/h.port
python3 -I -c 'import json; p = "/var/lib/desk-host/hosting.json"; h = json.load(open(p)); h["slotMode"] = "address"; json.dump(h, open(p, "w"))'
echo "SlotMode=address: DeskSlot1 (-/-) -> $(t 1)"; t 1 >/dev/null && ok=0
echo "SlotMode=address: DeskSlot3 -> $(t 3)"; t 3 >/dev/null || ok=0
python3 -I -c 'import json; p = "/var/lib/desk-host/hosting.json"; h = json.load(open(p)); h["slotMode"] = "both"; json.dump(h, open(p, "w"))'
echo "SlotMode=both: DeskSlot1 -> $(t 1)"; t 1 >/dev/null && ok=0
cp -a /root/h.port /var/lib/desk-host/hosting.json
echo "SlotMode=port again: DeskSlot1 -> exit $(t 1 >/dev/null; echo $?)"; t 1 >/dev/null || ok=0
[ $ok = 1 ]
X
result "the slot tag: \"-\" in the address fields parses only under SlotMode=port, an address and an allocation only under address, and nothing under any other mode" $rc < $WORKDIR/o

# ---- 4. a desk started by the link under B; what reaches it, and how
fake_state running stopped
R 'sudo tee /root/fake/wait.py >/dev/null' <<'P'
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
    k, v = c.split("=", 1); return S.get(int(k), {}).get("state") in v.split(",")
while True:
    S = last()
    if S and all(ok(S, c) for c in sys.argv[2:]):
        break
    if time.time() > end:
        print("TIMEOUT waiting for", " ".join(sys.argv[2:]))
        break
    time.sleep(3)
print("report:", json.dumps({k: {x: S[k].get(x) for x in ("state", "epoch", "fault") if x in S[k]} for k in (1, 2) if k in S}))
sys.exit(0 if S and all(ok(S, c) for c in sys.argv[2:]) else 1)
P
{ R "sudo python3 -I /root/fake/wait.py 1500 1=running" && RSE PUBIP=$IP <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; ok=1; L=/usr/local/lib/desk-host
echo "slot 1's desk-rtc.conf:"; sed "s/$PUBIP/<the host's public address>/" /run/desk-host/1/desk-rtc.conf | sed 's/^/  /'
grep -qx "port=4431" /run/desk-host/1/desk-rtc.conf && grep -qx "tcp_port=443" /run/desk-host/1/desk-rtc.conf && grep -qx "slot=1" /run/desk-host/1/desk-rtc.conf \
  && grep -qx "public_ipv4=$PUBIP" /run/desk-host/1/desk-rtc.conf || ok=0
for i in $(seq 1 30); do nsenter --net=/run/desk-host/ns/1/net ss -Hlun | grep -q '10.98.1.2:4431' && break; sleep 2; done
u=$(nsenter --net=/run/desk-host/ns/1/net ss -Hlun | awk '{print $4}' | tr '\n' ' '); t=$(nsenter --net=/run/desk-host/ns/1/net ss -Hltn | awk '{print $4}' | grep ':443$' | tr '\n' ' ')
echo "in slot 1: UDP listeners $u; TCP 443 $t"
echo "$u" | grep -q '10.98.1.2:4431' && echo "$t" | grep -q '10.98.1.2:443' || ok=0
grep -q '"on a shared desk host"' <(journalctl -o cat --no-pager 2>/dev/null | grep desk-rtc) || true
ls -l /run/desk-dmx/slots/ | tail -n +2 | sed 's/^/  marked for the demux: /'
[ -f /run/desk-dmx/slots/1 ] && [ ! -e /run/desk-dmx/slots/2 ] || ok=0
for i in $(seq 1 60); do grep -q 'deskd ready' <(python3 -I -c 'import sys; t = open(sys.argv[1], errors="replace").read(); print(t[t.rfind("] started "):])' /var/log/desk-host/svc-1-deskd.log 2>/dev/null) && break; sleep 2; done   # deskd past its FilesModule
$L/desk-host-check --allow-verify-access --only slotmode,addresses,demux,ports,counters,inbound,standin,svc-dns,oom,files | tee /tmp/chk.out || ok=0
grep -qE '^PASS host oom: 1 running slot\(s\), [1-9][0-9]* desk process\(es\) as the order says, lowest -500, the host.s own under -900' /tmp/chk.out || ok=0   # S2
grep -qE '^PASS host svc-dns: 1 running slot\(s\), 6 sandbox\(es\) with the desk.s resolver, 3 lookups' /tmp/chk.out || ok=0   # Bug 8
grep -qE '^PASS host files: 1 running slot\(s\), 1 with deskd.s /data/files its volume.s, 1100:1100 0700' /tmp/chk.out || ok=0   # free walk H5
[ $ok = 1 ]
X
result "a desk on slot 1 under B: its desk-rtc takes UDP 4431 and TCP 443 inside the slot, ufrags tagged s01, the host's public address from IMDS; marked for the demux; slotmode, addresses, demux, ports, counters, inbound and standin pass; every sandbox has the desk's resolver and deskd, desk-rtc and desk-agent look a public name up from inside (svc-dns, Bug 8)" $rc < $WORKDIR/o

RSE PUBIP=$IP > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
set -u; ok=1; ns=/run/desk-host/ns/1/net
cip=$(getent ahostsv4 checkip.amazonaws.com | awk '{print $1; exit}')
out=$(nsenter --net=$ns setpriv --reuid=$((100000 + 65536 + 1100)) --regid=$((100000 + 65536 + 1100)) --clear-groups curl -fsS -m 12 --resolve "checkip.amazonaws.com:443:$cip" https://checkip.amazonaws.com | tr -d '[:space:]')
echo "slot 1 leaves from: $([ "$out" = "$PUBIP" ] && echo "the host's own public address" || echo "SOMETHING ELSE (${out:-none})")"; [ "$out" = "$PUBIP" ] || ok=0
blk=$(nft list chain ip host_nat post_1 | sed -n 's/.*snat to [0-9.]*:\([0-9]*-[0-9]*\).*/\1/p' | head -1); echo "slot 1's block: $blk"
own=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/local-ipv4)
# the flows SNATed to the host's address (their reply comes back to it): the reply's destination port is the slot's source port there
ports=$(conntrack -L -p tcp -s 10.98.1.2 2>/dev/null | grep " dst=$own sport=" | sed -n 's/.* dst='"$own"' sport=[0-9]* dport=\([0-9]*\).*/\1/p' | sort -u | tr '\n' ' ')
echo "slot 1's flows' ports on the host's address: $ports"
for p in $ports; do [ "$p" -ge "${blk%-*}" ] && [ "$p" -le "${blk#*-}" ] || { echo "  $p is outside the block"; ok=0; }; done
[ -n "$ports" ] || ok=0
[ $ok = 1 ]
X
result "out: slot 1 leaves from the host's own public address, from a source port in its own block" $rc < $WORKDIR/o

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

# From outside: this workstation as any client of the host's one address
pk() { RS <<'Y'; }
for k in 1 2; do for c in dmxo_$k dmxi_$k; do printf '%s=%s ' "$c" "$(nft list chain inet host $c 2>/dev/null | grep -o 'packets [0-9]*' | awk '{s+=$2} END {print s+0}')"; done; done; echo
Y
{ set +e
  python3 -I -c 'import socket, sys
for p in (4431, 4432):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 0))
    for _ in range(3):
        s.sendto(b"\0\1\0\0\x21\x12\xa4\x42verify-probe", (sys.argv[1], p))' "$IP"
  sleep 2
  # each flow's conntrack entry says where its DNAT sent it: to the slot's desk, or (no desk on 4432) nowhere
  RSE ME=$MYIP <<'Y' || echo FAIL
set -u; ok=1
to() { conntrack -L -p udp -s "$ME" --dport "$1" 2>/dev/null | grep -c " src=10.98.$2.2 dst=$ME sport=$1 "; }
echo "UDP 4431 from this workstation, DNATed to slot 1's desk: $(to 4431 1) flow(s)"; [ "$(to 4431 1)" -ge 1 ] || ok=0
echo "UDP 4432 (slot 2 has no desk), DNATed to slot 2: $(to 4432 2) flow(s), to slot 1: $(to 4432 1)"; [ "$(to 4432 2)" = 0 ] && [ "$(to 4432 1)" = 0 ] || ok=0
[ $ok = 1 ]
Y
  if ping -c 3 -W 2 -q "$IP" >/dev/null 2>&1; then echo "ping the host: ANSWERED"; echo FAIL; else echo "ping the host: no answer"; fi
  for p in 4431 9254; do r=0; timeout 6 bash -c "exec 3<>/dev/tcp/$IP/$p" 2>/dev/null || r=$?; echo "TCP $p: $([ $r = 124 ] && echo 'no answer (dropped)' || echo "ANSWERED ($r)")"; [ $r = 124 ] || echo FAIL; done
  set -e
} > $WORKDIR/o 2>&1
grep -q '^FAIL' $WORKDIR/o && rc=1 || rc=0
result "from outside: UDP 4431 on the host's address reaches slot 1 alone, 4432 (no desk) nothing; ping, TCP 4431 and the stand-in's port get no answer" $rc < $WORKDIR/o

{ set +e
  P="python3 -I $HERE/tests/demuxprobe.py $IP 443"
  for c in http tls noslot; do r=$($P $c); echo "$c: $r"; case "$r" in "closed "*) [ "${r#closed }" -lt 1000 ] || echo FAIL ;; *) echo FAIL ;; esac; done
  r=$($P slot 2); echo "slot 2 (no desk): $r"; case "$r" in "closed "*) [ "${r#closed }" -lt 1000 ] || echo FAIL ;; *) echo FAIL ;; esac
  r=$($P silent 1 12); echo "silent: $r"; case "$r" in "closed "*) [ "${r#closed }" -ge 2500 ] && [ "${r#closed }" -le 6500 ] || echo FAIL ;; *) echo FAIL ;; esac
  r=$($P half 1 12); echo "half a header: $r"; case "$r" in "closed "*) [ "${r#closed }" -ge 2500 ] && [ "${r#closed }" -le 6500 ] || echo FAIL ;; *) echo FAIL ;; esac
  before=$(pk)
  r=$($P slot 1); echo "slot 1, signed with no session's password: $r (its desk-rtc's gate closes it)"
  sleep 1; after=$(pk); echo "counters before: $before"; echo "counters after:  $after"
  python3 -I - "$before" "$after" <<'P' || echo FAIL
import sys
b = dict(x.split("=") for x in sys.argv[1].split()); a = dict(x.split("=") for x in sys.argv[2].split())
d = {k: int(a[k]) - int(b[k]) for k in a}
print("slot 1: dmxo", d["dmxo_1"], "dmxi", d["dmxi_1"], "; slot 2: dmxo", d["dmxo_2"], "dmxi", d["dmxi_2"])
sys.exit(0 if d["dmxo_1"] >= 2 and d["dmxi_1"] >= 1 and d["dmxo_2"] == 0 and d["dmxi_2"] == 0 else 1)
P
  RSE ME=$MYIP <<'Y' || echo FAIL
n=$(conntrack -L -p tcp -d 10.98.1.2 --dport 443 2>/dev/null | grep -c "src=$ME ")
echo "the demux's connections to slot 1 from this workstation's own address (conntrack): $n"
[ "$n" -ge 1 ]
Y
  set -e
} > $WORKDIR/o 2>&1
grep -q '^FAIL' $WORKDIR/o && rc=1 || rc=0
result "the demux on the host's 443: HTTP, TLS, a ufrag with no slot and a stopped slot's request closed at once; silence and half a header closed within the wait; slot 1's request handed to slot 1 alone, from the client's own address, counted both ways" $rc < $WORKDIR/o

# ---- 4b. set_class through the link (S-119): slot 1's class changed in place while it runs, as Platform orders an upgrade: the
# tag first (only its sixth field), then the record's class, which makes the fake order set_class (fake_platform.py, as
# hostlink.ts classOrder) until the report says it. The Browser is started as deskd starts it and a page sets a cookie in it
# (tests/set_class_lab.py: CDP over HTTP as deskd's uid, inside the slot's network namespace only). Lab evidence, never a
# member's desk. Each change: the cgroup holds the class's values, class-applied passes, every process from before is still
# there but Chromium's own children, which come and go as it likes (deskd's JVM and Chromium's browser process the same), no OOM
# kill in the desk, both containers have the same start, the cookie comes back.
scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$HERE/tests/set_class_lab.py" "admin@$IP:/home/admin/" >/dev/null
R 'sudo install -d -m 755 /run/ma-verify-s119 && sudo install -m 644 -o root -g root /home/admin/set_class_lab.py /run/ma-verify-s119/ && rm -f /home/admin/set_class_lab.py'
SC="sudo python3 -I /run/ma-verify-s119/set_class_lab.py"; MARK=s119$(date +%s); SNAP=/root/fake/snap.json
tag1() { aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskSlot1,Value=$D1/$VOL1/-/-/1${1:+/$1}"; sleep 15; }   # IMDS shows it within seconds
hnow() { R 'date +%s'; }
R "$SC browser $MARK" > $WORKDIR/o 2>&1 && rc=0 || rc=$?
result "set_class, first: the Browser in slot 1 started as deskd starts it (units.sock), a page's cookie set in it and sent back by a new tab" $rc < $WORKDIR/o

T=$(hnow)
{ R "$SC fake - bad" && R "$SC refused class_unknown standard $T 90" && R "$SC refused not_this_desk standard $T 90"; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
R "$SC fake -" >> $WORKDIR/o 2>&1 || rc=1
result "set_class refused by the link alone, nothing changed: a class this host's classes.conf hasn't (class_unknown), slot 1 ordered for slot 2's desk (not_this_desk)" $rc < $WORKDIR/o

R "$SC snap $SNAP" || true; T=$(hnow); tag1 free
{ R "$SC fake free" && R "$SC check free $SNAP $MARK $T"; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
result "set_class to free on the running desk (a lower memory cap waits while the desk doesn't fit it, '+pending'): in place, every process kept, the cookie back" $rc < $WORKDIR/o

# the raise past the host's units (six standard desks' memory in cgroups of their own, as verify.sh's 4b) and a stopping host:
# the link's order and desk-host class --whole by hand are both refused with nothing changed (free's cpu.idle kept, no half class)
RS > /dev/null <<'X' || true
L=/usr/local/lib/desk-host; ty=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)
for j in 2 3 4 5 6 7; do mkdir /sys/fs/cgroup/desk-host/desk-$j; python3 -I $L/classes.py values standard $ty | cut -d' ' -f2 > /sys/fs/cgroup/desk-host/desk-$j/memory.max; done
X
T=$(hnow); tag1
{ R "$SC fake standard" && R "$SC refused host_full free $T 120" && RS <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
desk-host class 1 --whole; r=$?; echo "desk-host class 1 --whole by hand, no room: exit $r"
[ "$r" = 75 ] && python3 -I /run/ma-verify-s119/set_class_lab.py same free
X
result "set_class past the host's units (classes.conf): refused whole (host_full; desk-host class --whole exits 75), the desk still exactly free" $rc < $WORKDIR/o
R "$SC snap $SNAP" || true; T=$(hnow)
{ RS <<'X' && R "$SC refused host_stopping free $T 120" && RS <<'Y'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
: > /run/desk-host/halt   # stop-all's mark, as a host stop makes it (no stop-all runs here); first, so no retry finds room before it
for j in 2 3 4 5 6 7; do rmdir /sys/fs/cgroup/desk-host/desk-$j; done
echo "the host marked stopping, then room again"
X
desk-host class 1 --whole; r=$?; echo "desk-host class 1 --whole by hand, the host stopping: exit $r"
[ "$r" = 1 ] && python3 -I /run/ma-verify-s119/set_class_lab.py same free
Y
result "set_class on a stopping host (stop-all's mark): refused (host_stopping; desk-host class --whole exits 1), nothing changed" $rc < $WORKDIR/o
T=$(hnow); R 'sudo rm -f /run/desk-host/halt'
R "$SC check standard $SNAP $MARK $T 150" > $WORKDIR/o 2>&1 && rc=0 || rc=$?
result "set_class free to standard (the upgrade, once the host resumes and the link tries again): standard's values in place, every process kept, deskd's JVM and Chromium the same, both containers' start the same, the cookie back" $rc < $WORKDIR/o

R "$SC snap $SNAP" || true; T=$(hnow); tag1 free
{ R "$SC fake free" && R "$SC check free $SNAP $MARK $T"; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
result "set_class back to free: free's values in place, every process kept, the cookie back" $rc < $WORKDIR/o

# the mutation: set_class out of the link's OPS. The same upgrade must then be ignored ("an order that isn't one of the
# contract's") and the check fail; put back, the link runs it and the check passes.
R "$SC snap $SNAP" || true
RS > $WORKDIR/o 2>&1 <<'X' || true
cp -a /usr/local/lib/desk-host/desk-host-link /root/link.keep
sed -i '/^OPS = /s/, "set_class"//' /usr/local/lib/desk-host/desk-host-link
echo "broken: $(grep '^OPS = ' /usr/local/lib/desk-host/desk-host-link)"; systemctl restart desk-host-link
X
T=$(hnow); tag1; R "$SC fake standard" >> $WORKDIR/o 2>&1 || true
R "$SC check standard $SNAP $MARK $T 60" > $WORKDIR/m 2>&1 && f=PASS || f=FAIL
RSE T=$T >> $WORKDIR/m 2>&1 <<'X' || true
echo "the link: $(journalctl -u desk-host-link --no-pager -o cat --since=@$T | grep -c "isn't one of the contract's") order(s) ignored as not the contract's (logged once each)"
X
RS >> $WORKDIR/o 2>&1 <<'X' || true
cp -a /root/link.keep /usr/local/lib/desk-host/desk-host-link
echo "put back: $(grep '^OPS = ' /usr/local/lib/desk-host/desk-host-link)"; systemctl restart desk-host-link
X
T=$(hnow)
R "$SC check standard $SNAP $MARK $T 150" > $WORKDIR/p 2>&1 && p=PASS || p=FAIL
{ cat $WORKDIR/o; echo "broken (no set_class in OPS) -> $f:"; sed 's/^/  /' $WORKDIR/m; echo "restored -> $p:"; sed 's/^/  /' $WORKDIR/p; } > $WORKDIR/q
[ "$f" = FAIL ] && [ "$p" = PASS ] && rc=0 || rc=1
R "$SC down" >> $WORKDIR/q 2>&1 || rc=1
result "set_class's mutation: with set_class out of the link's OPS the upgrade is ignored and the step's check fails; put back, it runs and passes" $rc < $WORKDIR/q

fake_state stopped stopped
{ R "sudo python3 -I /root/fake/wait.py 300 1=unmounted,stopped" && RS <<'X'; } > $WORKDIR/o 2>&1 && rc=0 || rc=$?
set -u; ok=1
echo "slot 1 left: [$(desk-host leftovers 1 | cut -d: -f2-)]"; [ -z "$(desk-host leftovers 1 | cut -d: -f2- | tr -d ' ')" ] || ok=0
echo "marked for the demux: [$(ls /run/desk-dmx/slots/)]"; [ -z "$(ls /run/desk-dmx/slots/)" ] || ok=0
nft list chain inet host dmxo_1 >/dev/null 2>&1 && { echo "dmxo_1 left"; ok=0; }
/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only slotmode,addresses,demux,ports,counters,inbound || ok=0
[ $ok = 1 ]
X
r=$(python3 -I "$HERE/tests/demuxprobe.py" "$IP" 443 slot 1); echo "slot 1's request after its stop: $r" >> $WORKDIR/o
case "$r" in "closed "*) [ "${r#closed }" -lt 1000 ] || rc=1 ;; *) rc=1 ;; esac
result "stop_slot: nothing of slot 1 left, its demux mark and counting chains included; its requests refused at once after" $rc < $WORKDIR/o

# ---- 4c. the slot's byte counters over the SNAT path, as verify.sh's (the link stopped: by hand)
R 'sudo systemctl stop desk-host-link'
RS > $WORKDIR/o 2>&1 <<X && rc=0 || rc=$?
set -u
ok=1; ns=/run/desk-host/ns/1/net
desk-host up 1 $D1 $VOL1 --public $IP || exit 1
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
sys.exit(0 if o > 5000 and 0.7 < a / o <= 1.0 and i > 1000000 and abs(b / i - 1) < 0.05 else 1)
P
X
result "the slot's byte counters match its interface's over the SNAT path (a download: rx within 5%, out with its ACKs within the veth's headers)" $rc < $WORKDIR/o

# ---- 4d. a host stop during a start (the link stopped, as at a host stop, where it stops first and leaves its up running): 0.1.7's
# stop-all looked only for running containers, so it skipped this slot and the up started the desk after it (run 5's survivor)
RS > $WORKDIR/o 2>&1 <<X && rc=0 || rc=$?
set -u; ok=1
desk-host stop 1 >/dev/null 2>&1   # 4c's desk
desk-host up 1 $D1 $VOL1 --public $IP > /tmp/race-up.log 2>&1 < /dev/null & upid=\$!
for i in \$(seq 1 200); do [ "\$(cat /run/desk-host/op/1 2>/dev/null)" = starting ] && break; sleep 0.05; done
echo "at the host stop: slot 1 \$(cat /run/desk-host/op/1 2>/dev/null || echo 'not starting'), its container \$(runc state dh-desk-1 >/dev/null 2>&1 && echo made || echo 'not made yet')"
systemctl stop desk-host-shutdown.service   # the host's stop: ExecStop=desk-host stop-all
wait \$upid; urc=\$?
echo "the stop: \$(journalctl -u desk-host-shutdown --no-pager -o cat | grep -E 'every desk stopped' | tail -1)"
echo "the start in flight: exit \$urc, fault \$(cat /run/desk-host/fault/1 2>/dev/null || echo none); \$(grep -E 'refused|up at' /tmp/race-up.log | tail -1 | cut -c1-160)"
echo "containers after both: [\$(runc list -q | tr '\n' ' ')]"; [ -z "\$(runc list -q)" ] || ok=0
left=\$(desk-host leftovers 1 | cut -d: -f2- | tr -d ' '); echo "slot 1 left: [\$left]"; [ -z "\$left" ] || ok=0
[ -e /run/desk-host/halt ] || { echo "no halt mark after the stop"; ok=0; }
desk-host up 1 $D1 $VOL1 --public $IP > /tmp/race-up2.log 2>&1 && { echo "a start after the host stop was NOT refused"; ok=0; }
echo "a start after the stop: \$(grep -o 'refused, the host is stopping every desk' /tmp/race-up2.log | head -1), fault \$(cat /run/desk-host/fault/1 2>/dev/null)"
[ "\$(cat /run/desk-host/fault/1 2>/dev/null)" = host_stopping ] && [ -z "\$(runc list -q)" ] || ok=0
systemctl start desk-host-shutdown.service   # desk-host resume
[ ! -e /run/desk-host/halt ] || { echo "the halt mark outlived the unit's start"; ok=0; }
desk-host up 1 $D1 $VOL1 --public $IP >/dev/null 2>&1 && echo "slot 1 started again after the unit's start" || { echo "slot 1 did NOT start again"; ok=0; }
[ \$ok = 1 ]
X
result "a host stop while a start is in flight: no desk left running, nothing of the slot left; a start after it refused (host_stopping) until the unit starts again" $rc < $WORKDIR/o

# ---- 4e. desk-svc's restart back-off, on the baked binary (reliability audit S1; verify-backoff.sh runs the real desk-svc as a plain
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

# ---- 5. the mutation pass: each check broken must FAIL, put back must PASS (slot 1 running, so ports and counters have a slot)
# Slot 1 was started by hand in 4c, but the fake Platform still wants it stopped (the stop_slot step) and would order its stop as soon as the
# link's mutation starts the link again, tearing slot 1 down in the middle of the pass (runs 1 to 3). The fake is told the desk is wanted running.
RS >/dev/null <<'X'
python3 -I - <<'P'
import json
f = "/root/fake/state.json"; s = json.load(open(f))
for r in s["slots"].values():
    if r.get("deskId"): r["want"] = "running"
json.dump(s, open(f + ".tmp", "w")); import os; os.replace(f + ".tmp", f)
P
X
RS > $WORKDIR/o 2>&1 <<'X' && rc=0 || rc=$?
C="/usr/local/lib/desk-host/desk-host-check --allow-verify-access --only"
T=/srv/desk-host/templates/$(/usr/local/lib/desk-host/desk-host-template current); L=/usr/local/lib/desk-host   # the current template generation (ADR 0077)
dev=$(ip -4 -j route show default | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["dev"])')
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
  n=$((n+1)); echo "$c: broken -> $f, restored -> $p   ($(cut -c1-150 /tmp/m.out))   [runc: $(runc list -q | tr '\n' ' ')]"
  [ "$f" = FAIL ] && [ "$p" = PASS ] || bad=1
}
omut() {   # omut <adj>: every process of slot 1's deskd sandbox set to <adj> (the kill order broken, and put back)
  local pid p; pid=$(runc state dh-svc-1-deskd | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  for p in $(cat /sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$pid/cgroup)/cgroup.procs); do echo "$1" > /proc/$p/oom_score_adj; done
}
cp -a /usr/local/sbin/runc /root/runc.keep; cp -a $L/desk/desk-svc /root/svc.keep; cp -a /etc/modprobe.d/desk-host.conf /root/mp.keep
cp -a $L/apparmor.tmpl /root/aa.keep; cp -a /var/lib/desk-host/hosting.json /root/h.keep; cp -a /home/admin/.ssh/authorized_keys /root/ak.keep
cp -a /srv/desk-host/releases/deskd/current/run /root/run.keep; cp -a /etc/desk-host/classes.conf /root/cl.keep
m svc-dns "rmut break" "rmut fix"
m oom "omut 0" "omut -500"
m files "fmut break" "fmut fix"
m shaper "systemctl kill -s SIGSTOP desk-host-egress@1.service; nsenter --net=/run/desk-host/ns/1/net tc qdisc del dev eth0 root" "desk-host shaper 1 on; sleep 1"
m runc "printf x >> /usr/local/sbin/runc" "cp -a /root/runc.keep /usr/local/sbin/runc"
m kernel "touch /boot/vmlinuz-0.0-cloud-arm64" "rm -f /boot/vmlinuz-0.0-cloud-arm64"
m zswap "echo N > /sys/module/zswap/parameters/enabled" "echo Y > /sys/module/zswap/parameters/enabled"
m swap "swapoff /var/lib/desk-host/swap" "swapon -p 10 /var/lib/desk-host/swap"
m sysctl "sysctl -w net.ipv4.ip_local_port_range='32768 60999'" "sysctl -w net.ipv4.ip_local_port_range='60000 64999'"
m modules "sed -i '/^install n_hdlc /d' /etc/modprobe.d/desk-host.conf" "cp -a /root/mp.keep /etc/modprobe.d/desk-host.conf"
m units "systemctl unmask deskd.service" "systemctl mask deskd.service"
m uids "setpriv --reuid=1105 --regid=1105 --clear-groups sleep 60 &" "pkill -u 1105 sleep; sleep 0.5"
m nft "nft add table inet extra" "nft delete table inet extra"
m store "mount -o remount,bind,rw $T" "mount -o remount,bind,ro,nosuid,nodev $T"
m template "mount -o remount,bind,rw $T; touch $T/etc/ssh/ssh_host_test_key" "rm -f $T/etc/ssh/ssh_host_test_key; mount -o remount,bind,ro,nosuid,nodev $T"
m releases "printf x >> /srv/desk-host/releases/deskd/current/run" "cp -a /root/run.keep /srv/desk-host/releases/deskd/current/run"
# slot 1 is running and executes desk-svc (text busy): the break and the restore replace the file by rename, not by writing into it
m desk-svc "cp -a $L/desk/desk-svc /root/svc.bad; printf x >> /root/svc.bad; mv -f /root/svc.bad $L/desk/desk-svc" "cp -a /root/svc.keep /root/svc.back; mv -f /root/svc.back $L/desk/desk-svc"
m no-test "touch /etc/desk-host/test.conf; mkdir -p /var/lib/desk-host/test" "rm -f /etc/desk-host/test.conf; rmdir /var/lib/desk-host/test"
m apparmor "echo 'profile bad {' >> $L/apparmor.tmpl" "cp -a /root/aa.keep $L/apparmor.tmpl"
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
m counters 'h=$(nft -a list chain inet host input | sed -n "s/.*jump desk_dmx # handle \\([0-9]*\\)/\\1/p"); nft delete rule inet host input handle $h' \
  'a=$(nft -a list chain inet host input | sed -n "s/.*ct state .*established.*accept # handle \\([0-9]*\\)/\\1/p"); nft insert rule inet host input position $a meta mark 0x00004430 jump desk_dmx'
m slotmode "nft add rule inet host host_in tcp dport 22 accept" \
  "for h in \$(nft -a list chain inet host host_in | sed -n 's/.*tcp dport 22 accept # handle \\([0-9]*\\)\$/\\1/p'); do nft delete rule inet host host_in handle \$h; done"
m addresses "ip addr add 10.255.255.254/32 dev $dev" "ip addr del 10.255.255.254/32 dev $dev"
m demux "systemctl stop desk-ice-demux" "systemctl start desk-ice-demux; sleep 1"
m ports "nft add rule ip host_nat pre_1 iifname $dev tcp dport 4431 dnat to 10.98.1.2" \
  "for h in \$(nft -a list chain ip host_nat pre_1 | sed -n 's/.*tcp dport 4431 dnat to 10.98.1.2 # handle \\([0-9]*\\)\$/\\1/p'); do nft delete rule ip host_nat pre_1 handle \$h; done"
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
# a sandbox made again by the switch's own steps with a capability added (a test host's flag), then made again without it
m svc-spec "$TB; SWITCH_ADD_CAP=1 desk-host resandbox 1 desk-agent >> /root/resandbox.log 2>&1; $TU" "$TB; desk-host resandbox 1 desk-agent >> /root/resandbox.log 2>&1; $TU"
if ! runc state dh-svc-1-desk-agent >/dev/null 2>&1; then   # why the sandbox wasn't made again: runc's refusal, the root's path, slot 1's room
  echo "  resandbox: $(tail -2 /root/resandbox.log 2>/dev/null | cut -c1-160 | tr '\n' ' '); runc says: $(grep -o 'error preparing rootfs[^\"]*' /var/log/desk-host/svc-1-desk-agent.log | tail -1 | cut -c1-300)"
  echo "  its root's path: $(namei -l /srv/desk-host/slots/1/rel/desk-agent/rootfs | tail -n +2 | awk '{print $1, $2, $3, $NF}' | tr '\n' ';')"
  echo "  slot 1's cgroup: memory $(cat /sys/fs/cgroup/desk-host/desk-1/memory.current)/$(cat /sys/fs/cgroup/desk-host/desk-1/memory.max), pids $(cat /sys/fs/cgroup/desk-host/desk-1/pids.current)/$(cat /sys/fs/cgroup/desk-host/desk-1/pids.max)"
fi
m2 svc-spec "cp -a /srv/desk-host/slots/1/svc/desk-rtc/config.json /root/rtc.keep; python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[\"mounts\"]=[m for m in d[\"mounts\"] if m[\"destination\"]!=\"/run/desk-egress\"]; json.dump(d, open(p, \"w\"))' /srv/desk-host/slots/1/svc/desk-rtc/config.json" \
  "cp -a /root/rtc.keep /srv/desk-host/slots/1/svc/desk-rtc/config.json"
cp -a /srv/desk-host/slots/1/rel/deskd/run /root/srun.keep 2>/dev/null; cp -a /var/lib/desk-host/slots/1.json /root/rec1.keep
m2 releases "printf x >> /srv/desk-host/slots/1/rel/deskd/run" "cp -a /root/srun.keep /srv/desk-host/slots/1/rel/deskd/run"
m2 releases "python3 -I -c 'import json,sys; p=sys.argv[1]; r=json.load(open(p)); r[\"releases\"]=dict(r.get(\"releases\") or {}, deskd=\"0.0-none\"); json.dump(r, open(p, \"w\"))' /var/lib/desk-host/slots/1.json" \
  "cp -a /root/rec1.keep /var/lib/desk-host/slots/1.json"
m2 update-cgroup "python3 -I -c 'import time; time.sleep(120)' /usr/local/lib/desk-host/desk-host-batch copy 9 >/dev/null 2>&1 < /dev/null & echo \$! > /root/cp.pid; sleep 0.5" \
  "kill \$(cat /root/cp.pid); sleep 0.5"
m host-apt "apt-mark unhold nftables" "apt-mark hold nftables"
m2 host-apt "sed -i 's/Automatic-Reboot \"false\"/Automatic-Reboot \"true\"/' /etc/apt/apt.conf.d/51desk-host-unattended" \
  "sed -i 's/Automatic-Reboot \"true\"/Automatic-Reboot \"false\"/' /etc/apt/apt.conf.d/51desk-host-unattended"
# last: the boot break stops every desk (desk-host-shutdown), and the cgroup break needs no desk using io (the controller is busy under one)
m boot "systemctl stop desk-host-shutdown.service" "systemctl start desk-host-shutdown.service"
# The io controller can't be switched off while a desk uses it, so the host stops its desks as a host stop does, the link first in the same
# transaction (its After=), which leaves any start it had begun running: stop-all must stop that one too (run 5's survivor, with 0.1.7's)
systemctl stop desk-host-link.service desk-host-shutdown.service; echo "after the host stop: [$(runc list -q | tr '\n' ' ')]"
m cgroup "echo -io > /sys/fs/cgroup/desk-host/cgroup.subtree_control" "echo +io > /sys/fs/cgroup/desk-host/cgroup.subtree_control"
systemctl start desk-host-shutdown.service desk-host-link.service; sleep 3
echo "mutations: $n"
all=$(/usr/local/lib/desk-host/desk-host-check --list | wc -w); echo "checks: $all"
[ "$n" = "$all" ] || bad=1
desk-host stop 1 >/dev/null 2>&1
sleep 12   # the link drops a stopped slot's stand-in at its next look (10 s); the final run of every check came first once (restart-oom lab run) and failed standin
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
R "sudo bash -s -- real $D1 $VOL1 $IP" < "$HERE/verify-links.sh" > $WORKDIR/l1 2>&1 && rc=0 || rc=$?
grep -qx 'LINKS PASS' $WORKDIR/l1 || rc=1
result "slot-datadirs: a link the Browser's user put at /data/browser/home before a slot start isn't followed (its target, the desk's root's directory, still root's 0755; desk-init says it couldn't make home as kiosk); units.sock bound desk:desk 0600" $rc < $WORKDIR/l1
R "sudo bash -s -- mutation $D1 $VOL1 $IP" < "$HERE/verify-links.sh" > $WORKDIR/l2 2>&1 && rc=0 || rc=$?
{ grep -q '^MUTATED LINKS FAIL' $WORKDIR/l2 && grep -qx 'RESTORE PASS' $WORKDIR/l2; } || rc=1
result "that check fails with 0.1.11.1's desk-init (the mutation: the link's target handed to kiosk); the real desk-init, put back, passes it again" $rc < $WORKDIR/l2

# ---- 8. desk image 0.3.5 in a slot (verify-parity.sh, sub/host-parity-035): slot 1 started by hand; links out (the slot's /run/desk-links
# share, deskd's links.sock, the xdg-open stand-in as kiosk counted by deskd), the Browser's policy before each start (teen, adult, a band
# that isn't one, and failing closed) and JPEG XL off in the running Chromium; then the mutations: 0.1.14's desk-init.py, wallspec.py and
# svc-spec.py (from git, OLD_PARITY_REF: the last commit with them) must fail links out and the policy, the slot's desk-browser-start
# without the switch must fail jxl, and the real ones, put back, pass again.
OLD_PARITY_REF=950995e2
R 'sudo rm -rf /root/parity-old && sudo install -d -m 700 /root/parity-old/desk'
for f in desk/desk-init.py wallspec.py svc-spec.py; do
  git -C "$HERE" show "$OLD_PARITY_REF:image/host/recipe/files/usr/local/lib/desk-host/$f" | R "sudo tee /root/parity-old/$f >/dev/null"
done
R "sudo bash -s -- real $D1 $VOL1 $IP" < "$HERE/verify-parity.sh" > $WORKDIR/p1 2>&1 && rc=0 || rc=$?
grep -qx 'PARITY PASS' $WORKDIR/p1 || rc=1
result "desk image 0.3.5 in a slot: links out (the slot's desk:kiosk 2750 /run/desk-links in the desk and deskd's sandbox, a tel: link from kiosk's stand-in counted by deskd), desk-browser-policy before each Chromium start (teen lock, adult allowlist, a band that isn't one locked, a lock it can't trust: no Chromium, then up by the retry), JPEG XL off in the running Chromium" $rc < $WORKDIR/p1
R "sudo bash -s -- mutation $D1 $VOL1 $IP" < "$HERE/verify-parity.sh" > $WORKDIR/p2 2>&1 && rc=0 || rc=$?
{ grep -q '^MUTATED LINKS-OUT FAIL' $WORKDIR/p2 && grep -q '^MUTATED POLICY FAIL' $WORKDIR/p2 && grep -q '^MUTATED JXL FAIL' $WORKDIR/p2 && grep -qx 'RESTORE PASS' $WORKDIR/p2; } || rc=1
result "those checks fail with 0.1.14's desk-init, wallspec and svc-spec (links out and the policy) and with the slot's desk-browser-start without the switch (jxl); put back, they pass again" $rc < $WORKDIR/p2

# ---- 9. a start on a slot with no record, and the JVMs' archives (verify-wake.sh, sub/host-up-norecord): slot 1's record moved aside (as a
# prepare refused for room leaves it), then a start must prepare the slot and start it; deskd's and desk-agent's JVMs must map their AppCDS
# archives (the store keeps the jars' times). Then the mutations: 0.1.15's desk-host (from git, OLD_UP_REF: the last commit with it) must end
# that start with nothing on stderr, and the slot's app jars touched to now must run both JVMs without their archives; put back (the real
# desk-host, a prepare from the store), both pass again.
OLD_UP_REF=5fd4f891
git -C "$HERE" show "$OLD_UP_REF:image/host/recipe/files/usr/local/lib/desk-host/desk-host" | R 'sudo tee /root/desk-host.old >/dev/null'
R "sudo bash -s -- real $D1 $VOL1 $IP" < "$HERE/verify-wake.sh" > $WORKDIR/k1 2>&1 && rc=0 || rc=$?
{ grep -qx 'NORECORD PASS' $WORKDIR/k1 && grep -qx 'CDS PASS' $WORKDIR/k1; } || rc=1
result "a start on a slot with no record (its record moved aside, as a prepare refused for room leaves it) prepares the slot and starts it; deskd's and desk-agent's JVMs map their AppCDS archives (the release store keeps each jar's time)" $rc < $WORKDIR/k1
R "sudo bash -s -- mutation $D1 $VOL1 $IP" < "$HERE/verify-wake.sh" > $WORKDIR/k2 2>&1 && rc=0 || rc=$?
{ grep -q '^MUTATED NORECORD FAIL' $WORKDIR/k2 && grep -q '^MUTATED CDS FAIL' $WORKDIR/k2 && grep -qx 'RESTORE PASS' $WORKDIR/k2; } || rc=1
result "those checks fail with 0.1.15's desk-host (the start ends with nothing on stderr) and with the slot's app jars at a new time (both JVMs without their archives); put back, they pass again" $rc < $WORKDIR/k2

say "RESULT: $PASS passed, $FAILN failed ($AMI on $TYPE, SlotMode=port)"
[ "$FAILN" = 0 ]
