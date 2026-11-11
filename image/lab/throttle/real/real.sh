#!/usr/bin/env bash
# real.sh: TEST ONLY. ADR 0036 section 6 tests 1, 2 and 4 on a desk of its own, through the real stack: a c7g.large from the
# current desk image (0.3.3: its shaper on ens5, desk-egress, desk-rtc, desk-stream, deskd and Chromium as baked), deskd pointed at
# gateway-shim and a fake IMDS on the desk's loopback (as ../../../../spikes/browser-bench/real-stack/rs.sh), and a c7i.xlarge
# client in the same subnet with Playwright's Chrome (reaching desk-rtc on the desk's public address), 30 ms of netem on its own outbound (so the desk's ens5 keeps the shaper as
# its root qdisc), which is also the sink for the flood and the uploads (UDP 9100 dropped at its prerouting hook; net.py's sinks).
# Both boxes are tagged Purpose=browser-benchmark and Owner=ma-sub-48-guilds; no instance role, no member data, Env=dev.
#   TD_WORK=<dir outside the repo> real.sh up | fixtures | rows <label> <reps> <row...> | profile <label> <reps> <profile> [phases]
#        | pause <label> | lab <script> [VAR=value ...] | desk <cmd> | client <cmd> | netem on|off | networkout <t0> <t1>
#        | reboot | stop-start | hours | down
# Nothing here prints an address; the workstation's own goes only into the group's SSH rule.
set -euo pipefail
B="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; IMG="$(cd "$B/../../.." && pwd)"; RS="$IMG/../spikes/browser-bench/real-stack"
W="${TD_WORK:?set TD_WORK to a directory outside the repo}"; mkdir -p "$W"; chmod 700 "$W"; ST="$W/state.env"; KEY="$W/key.pem"
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
AMI=${TD_AMI:?set TD_AMI to the desk image to test}
SUBNET=${TD_SUBNET:?set TD_SUBNET to a subnet in us-east-1a}; VPC=${TD_VPC:?set TD_VPC to its VPC}
NAME=ma-sub-td223; OWNER=ma-sub-48-guilds
TAGS="{Key=Purpose,Value=browser-benchmark},{Key=Owner,Value=$OWNER},{Key=Project,Value=minimalist-alliance},{Key=ManagedBy,Value=claude-cli}"
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15)
log() { echo "[td $(date +%H:%M:%S)] $*" >&2; }
touch "$ST"; source "$ST"
setv() { grep -v "^$1=" "$ST" > "$ST.tmp" || true; echo "$1=$2" >> "$ST.tmp"; mv "$ST.tmp" "$ST"; eval "$1='$2'"; }
sc() { ssh "${SSHO[@]}" "ubuntu@$CLIENT_IP" "$@"; }
sd() { ssh "${SSHO[@]}" "admin@$DESK_IP" "$@"; }
spendlog() { echo "$1 $2 $3 $(date +%s)" >> "$W/spend.log"; }
rows_() { sd "sudo env PEER=$CLIENT_PRIV ROW=$1 bash /var/tmp/lab/lab/throttle/real/rows.sh"; }

cmd_up() {
  if ! aws ec2 describe-key-pairs --key-names $NAME >/dev/null 2>&1; then
    aws ec2 create-key-pair --key-name $NAME --key-type ed25519 --tag-specifications "ResourceType=key-pair,Tags=[$TAGS]" --query KeyMaterial --output text > "$KEY"; chmod 600 "$KEY"
  fi
  if [ -z "${SGID:-}" ]; then
    local sg ip; ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
    sg=$(aws ec2 create-security-group --group-name $NAME --description "ADR 0036 section 6 real-stack lab, temporary" --vpc-id $VPC --tag-specifications "ResourceType=security-group,Tags=[$TAGS,{Key=Name,Value=$NAME}]" --query GroupId --output text)
    setv SGID "$sg"
    aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$ip/32}]" "IpProtocol=-1,UserIdGroupPairs=[{GroupId=$sg}]" >/dev/null 2>&1 || { log "can't add the rules"; exit 1; }
    unset ip
  fi
  local pub ud cud ami; pub=$(ssh-keygen -y -f "$KEY"); ud=$(mktemp); cud=$(mktemp)
  # The desk: SSH for this lab after every boot (the group limits port 22 to this workstation and the group), anything from the
  # subnet into the desk's own firewall (as lab.sh's lab-allow), and a safety shutdown 6 h after each boot.
  cat > "$ud" <<EOF
#!/bin/bash
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /usr/local/sbin/lab-allow <<'S'
#!/bin/sh
net=\$(ip -j -4 route show dev ens5 proto kernel | jq -r '.[0].dst')
nft add rule inet ma input ip saddr "\$net" accept
nft add rule inet ma input tcp dport 22 accept
nft insert rule inet ma output ip daddr 127.0.0.1 tcp dport 9222 meta skuid \$(id -u admin) accept
S
chmod 700 /usr/local/sbin/lab-allow
cat > /etc/systemd/system/lab-ssh.service <<'U'
[Unit]
Description=TEST ONLY: SSH for the ADR 0036 real-stack lab
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/lab-allow
ExecStart=/bin/systemctl start ssh
ExecStart=/sbin/shutdown -h +360
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable --now lab-ssh.service
EOF
  printf '#!/bin/bash\nshutdown -h +480\n' > "$cud"
  ami=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  if [ -z "${CLIENT_ID:-}" ]; then
    setv CLIENT_ID "$(aws ec2 run-instances --image-id "$ami" --instance-type c7i.xlarge --key-name $NAME --security-group-ids "$SGID" --subnet-id $SUBNET --associate-public-ip-address --count 1 \
      --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}" --instance-initiated-shutdown-behavior terminate --metadata-options HttpTokens=required,HttpEndpoint=enabled \
      --user-data "file://$cud" --tag-specifications "ResourceType=instance,Tags=[$TAGS,{Key=Name,Value=$NAME-client}]" "ResourceType=volume,Tags=[$TAGS]" "ResourceType=network-interface,Tags=[$TAGS]" \
      --query 'Instances[0].InstanceId' --output text)"; spendlog LAUNCH "$CLIENT_ID" c7i.xlarge
  fi
  if [ -z "${DESK_ID:-}" ]; then
    setv DESK_ID "$(aws ec2 run-instances --image-id "$AMI" --instance-type c7g.large --count 1 --security-group-ids "$SGID" --subnet-id $SUBNET --associate-public-ip-address \
      --instance-initiated-shutdown-behavior terminate \
      --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled,InstanceMetadataTags=enabled \
      --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}" --user-data "file://$ud" \
      --tag-specifications "ResourceType=instance,Tags=[$TAGS,{Key=Name,Value=$NAME-desk},{Key=DeskId,Value=d-dev0000000000},{Key=UserId,Value=00000000-0000-4000-8000-000000000001},{Key=DeskKind,Value=personal},{Key=Env,Value=dev}]" \
        "ResourceType=volume,Tags=[$TAGS]" "ResourceType=network-interface,Tags=[$TAGS]" --query 'Instances[0].InstanceId' --output text)"; spendlog LAUNCH "$DESK_ID" c7g.large
  fi
  rm -f "$ud" "$cud"
  aws ec2 wait instance-running --instance-ids "$CLIENT_ID" "$DESK_ID"
  addrs
  for _ in $(seq 1 60); do sc true 2>/dev/null && break; sleep 5; done
  for _ in $(seq 1 90); do sd true 2>/dev/null && break; sleep 5; done
  log "client $CLIENT_ID and desk $DESK_ID up"
  # the client reaches desk-rtc on the desk's public address, as a member does (Chrome 156 won't try a private one here)
  aws ec2 authorize-security-group-ingress --group-id "$SGID" --ip-permissions "IpProtocol=udp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$CLIENT_IP/32}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$CLIENT_IP/32}]" >/dev/null 2>&1 || true
  client_setup
  fixtures
}
addrs() {
  local d; d=$(aws ec2 describe-instances --instance-ids "$CLIENT_ID" "$DESK_ID" --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress,PrivateIpAddress]' --output text)
  setv CLIENT_IP "$(awk -v i="$CLIENT_ID" '$1==i{print $2}' <<<"$d")"; setv CLIENT_PRIV "$(awk -v i="$CLIENT_ID" '$1==i{print $3}' <<<"$d")"
  setv DESK_IP "$(awk -v i="$DESK_ID" '$1==i{print $2}' <<<"$d")"; setv DESK_PRIV "$(awk -v i="$DESK_ID" '$1==i{print $3}' <<<"$d")"
}

client_setup() {
  scp -q "${SSHO[@]}" "$KEY" "ubuntu@$CLIENT_IP:key.pem"
  sc 'set -e; export DEBIAN_FRONTEND=noninteractive; cloud-init status --wait >/dev/null 2>&1 || true; sudo apt-get update -q >/dev/null; sudo apt-get install -y -q xz-utils curl chrony nftables jq >/dev/null
      mkdir -p ~/node && curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz | tar -xJ -C ~/node --strip-components=1; ~/node/bin/node --version' 2>&1 | tail -2
  push_client
  sc 'set -e; export PATH=$HOME/node/bin:$PATH; cd ~/proof && npm install --no-audit --no-fund --silent 2>&1 | tail -2; npx playwright-core install --with-deps chromium 2>&1 | tail -1' 2>&1 | tail -3
  # the flood's sink drops it before any socket; net.py's sinks for the uploads and the lab tests
  sc 'sudo nft add table inet td223; sudo nft add chain inet td223 pre "{ type filter hook prerouting priority -300; policy accept; }"; sudo nft add rule inet td223 pre udp dport 9100 counter drop
      for u in "serve 5000" "tcp-sink 5001" "tcp-sink 5002 --mss 1448"; do n=td-$(echo $u | cut -d" " -f2); sudo systemd-run --unit=$n python3 -I /home/ubuntu/proof/net.py $u >/dev/null 2>&1 || true; done; sleep 1; systemctl is-active td-5000 td-5001 td-5002 | paste -sd" "'
  cmd_netem on
}
push_client() {
  local t; t=$(mktemp -d); mkdir -p "$t/proof"
  cp "$RS/proof2.mjs" "$RS/page2.js" "$RS/package.json" "$B/pause.mjs" "$IMG/lab/throttle/net.py" "$t/proof/"
  # this run's one change to proof2.mjs: Chrome 156 blocks WebRTC to a private address (the desk's, here) unless told not to, as probe5.mjs does
  sed -i "s/'--disable-backgrounding-occluded-windows', '--no-sandbox'\]/'--disable-backgrounding-occluded-windows', '--no-sandbox', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC,BlockInsecurePrivateNetworkRequests']/" "$t/proof/proof2.mjs" "$t/proof/pause.mjs"
  grep -c LocalNetworkAccessChecksWebRTC "$t/proof/proof2.mjs" "$t/proof/pause.mjs" | paste -sd' ' >&2
  tar -C "$t" -czf - proof | sc 'tar -xzf -'; rm -rf "$t"
}
cmd_netem() {
  local NE='IF=$(ip -o route get 1.1.1.1 | sed -n "s/.* dev \([^ ]*\).*/\1/p"); sudo modprobe sch_netem 2>/dev/null || { sudo apt-get install -y -q linux-modules-extra-$(uname -r) >/dev/null 2>&1; sudo modprobe sch_netem; }'
  if [ "$1" = on ]; then sc "$NE; sudo tc qdisc replace dev \$IF root netem delay 30ms limit 20000; tc qdisc show dev \$IF root | cut -c1-60"
  else sc "$NE; sudo tc qdisc del dev \$IF root 2>/dev/null; tc qdisc show dev \$IF root | cut -c1-60"; fi
}

# fixtures: the benchmark's pages, clip, sampler and stand-ins on the desk, deskd pointed at them, the lab tree, rtctap
fixtures() {
  sd 'cloud-init status --wait >/dev/null 2>&1; for i in $(seq 1 60); do systemctl is-active --quiet deskd && break; sleep 2; done; uname -m; nproc; systemctl is-active desk-egress desk-rtc deskd | paste -sd" "; /opt/ma/desk-egress/current/desk-egress --check && echo shaper-on; cat /etc/ma-release | head -2'
  local t; t=$(mktemp -d); mkdir -p "$t/pages/media" "$t/bin"
  cp -r "$RS/pages/." "$t/pages/"; cp "$RS/sample2.py" "$RS/info.sh" "$RS/fake-imds.py" "$t/"; cp "${SHIM_BIN:?}" "$t/bin/gateway-shim"; cp "${BBB_CLIP:?}" "$t/pages/media/bbb.mp4"
  tar -C "$t" -czf - . | sd 'mkdir -p ~/rs && tar -C ~/rs -xzf -'; rm -rf "$t"
  tar -C "$IMG" -czf - recipe lab verify.sh | sd 'sudo rm -rf /var/tmp/lab && sudo mkdir -p /var/tmp/lab && sudo tar -C /var/tmp/lab -xzf -'
  sd 'set -e; sudo mkdir -p /opt/proof && sudo cp ~/rs/sample2.py ~/rs/info.sh /opt/proof/ && chmod 755 ~/rs/bin/gateway-shim ~/rs && chmod -R a+rX ~/rs
      cmp /var/tmp/lab/recipe/files/etc/ma/egress.conf /etc/ma/egress.conf && echo "egress.conf as baked"
      sudo systemd-run --unit=rs-imds --uid=admin python3 /home/admin/rs/fake-imds.py --public-ip '"$DESK_IP"' --env dev >/dev/null 2>&1
      sudo systemd-run --unit=rs-pages --uid=admin --working-directory=/home/admin/rs/pages /usr/bin/python3 -m http.server 8000 --bind 127.0.0.1 >/dev/null 2>&1
      sudo systemd-run --unit=rs-shim --uid=admin /home/admin/rs/bin/gateway-shim --addr 127.0.0.1:8787 >/dev/null 2>&1; sleep 1
      grep -q "^DESKD_API_URL=" /opt/ma/deskd/current/deskd.env || sudo tee -a /opt/ma/deskd/current/deskd.env >/dev/null <<E
DESKD_API_URL=http://127.0.0.1:8787
DESKD_JWKS_URL=http://127.0.0.1:8787/.well-known/jwks.json
DESKD_IMDS_URL=http://127.0.0.1:8788
E
      sudo systemd-run --unit=rs-rtctap python3 -I /var/tmp/lab/lab/throttle/real/rtctap.py start >/dev/null 2>&1; sleep 1
      sudo systemctl restart deskd; for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8787/dev/state | grep -q "\"ready\": *true\|phase.*ready" && break; sleep 2; done
      curl -s http://127.0.0.1:8787/dev/state | head -c 300; echo; for c in desk-rtc desk-stream deskd desk-egress; do echo "$c $(cat /opt/ma/$c/current/VERSION 2>/dev/null)"; done
      sudo journalctl -u rs-rtctap --no-pager -o cat | tail -3'
}

tunnel() { sc "sudo fuser -k -n tcp 19222 8787 >/dev/null 2>&1 || true; sleep 1; ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o StrictHostKeyChecking=no -o LogLevel=ERROR -i ~/key.pem -L 8787:127.0.0.1:8787 -L 19222:127.0.0.1:9222 admin@$DESK_PRIV </dev/null >/dev/null 2>&1; ss -ltn | grep -c -E ':(8787|19222) '"; }
proof() { # proof <label> <i> [proof2 args]
  local label=$1 i=$2; shift 2
  sc "export PATH=\$HOME/node/bin:\$PATH; mkdir -p ~/out/$label; cd ~/proof && node proof2.mjs --api http://127.0.0.1:8787 --cdp http://127.0.0.1:19222 --ssh 'ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR -i /home/ubuntu/key.pem admin@$DESK_PRIV' --type c7g.large --label $label --out ~/out/$label/run$i.json $* 2> ~/out/$label/run$i.log; echo exit=\$?" | tail -1
}
# one measured run: the desk's classes and rtctap's stats around it
measured() { # measured <label> <i> [proof2 args]
  local label=$1 i=$2; shift 2; local d="$W/results/$label"; mkdir -p "$d"
  local n0; n0=$(sd 'wc -l < /var/tmp/rtctap.jsonl 2>/dev/null || echo 0')
  rows_ tc > "$d/tc-before-$i.json"; sd 'sudo tc -s -j qdisc show dev ens5' > "$d/qdisc-before-$i.json"
  local e; e=$(proof "$label" "$i" "$@")
  rows_ tc > "$d/tc-after-$i.json"; sd 'sudo tc -s -j qdisc show dev ens5' > "$d/qdisc-after-$i.json"
  sd "tail -n +$((n0 + 1)) /var/tmp/rtctap.jsonl" > "$d/rtctap-$i.jsonl"
  rows_ state > "$d/state-$i.txt" 2>&1 || true
  log "$label run $i: $e"
}
fetch() { local label=$1; mkdir -p "$W/results/$label"; sc "tar -C ~/out/$label -czf - ." | tar -C "$W/results/$label" -xzf -; }

# rows <label> <reps> <row...>: section 6 test 1, rows interleaved within each repeat. Rows: noshaper idle kiosk empty, and the control
# noshaper-kiosk100 (kiosk sending the 100 Mbps the shaper lets through, with no shaper) and kiosk100 (the same, shaped), to tell the
# shaper's cost from the sender's
cmd_rows() {
  local label=$1 reps=$2; shift 2; local rep row
  tunnel
  for rep in $(seq 1 "$reps"); do
    for row in "$@"; do
      case $row in
        noshaper) rows_ noshaper ;;
        idle) rows_ idle ;;
        kiosk) rows_ idle; rows_ kiosk-on ;;
        noshaper-kiosk100) rows_ noshaper; rows_ kiosk100-on ;;
        kiosk100) rows_ idle; rows_ kiosk100-on ;;
        empty) rows_ empty-on ;;
      esac 2>&1 | sed "s/^/[desk $row] /" >&2
      measured "$label-$row" "$rep"
      case $row in kiosk | kiosk100 | noshaper-kiosk100) rows_ kiosk-off ;; empty) rows_ empty-off ;; esac 2>&1 | sed "s/^/[desk $row] /" >&2
      fetch "$label-$row"
    done
  done
  rows_ idle >&2
}
# profile <label> <reps> <normal|capped|deep> [phases]: section 6 test 2, the stream at each profile through the real stack
cmd_profile() {
  local label=$1 reps=$2 p=$3 ph=${4:-warm,latency,latency_load,scroll,video,idle} rep
  tunnel
  rows_ "profile-$p" 2>&1 | sed "s/^/[desk $p] /" >&2
  for rep in $(seq 1 "$reps"); do measured "$label-$p" "$rep" --phases "$ph"; done
  fetch "$label-$p"
}
# pause <label> [desk script]: a live viewer on the video while the desk changes profile or restarts desk-stream (pause.mjs)
cmd_pause() {
  local label=$1; tunnel; mkdir -p "$W/results/$label"
  sc "export PATH=\$HOME/node/bin:\$PATH; cd ~/proof && node pause.mjs --peer ${CLIENT_PRIV} --api http://127.0.0.1:8787 --cdp http://127.0.0.1:19222 --ssh 'ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR -i /home/ubuntu/key.pem admin@$DESK_PRIV' --out ~/out/$label.json 2> ~/out/$label.log; echo exit=\$?" | tail -1
  sc "cat ~/out/$label.json" > "$W/results/$label/pause.json"; sc "cat ~/out/$label.log" > "$W/results/$label/pause.log"
}
cmd_lab() { local s=$1; shift; tar -C "$IMG" -czf - recipe lab verify.sh | sd 'sudo rm -rf /var/tmp/lab && sudo mkdir -p /var/tmp/lab && sudo tar -C /var/tmp/lab -xzf -'
  sd "sudo env PEER=$CLIENT_PRIV BOX=desk TYPE=c7g.large $* bash /var/tmp/lab/lab/throttle/tests/$s"; }
cmd_networkout() {
  local m
  for m in NetworkOut NetworkPacketsOut; do
    aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name $m --dimensions Name=InstanceId,Value="$DESK_ID" --statistics Sum --period 300 \
      --start-time "$(date -u -d @$(( $1 - 600 )) +%FT%TZ)" --end-time "$(date -u -d @$(( $2 + 900 )) +%FT%TZ)" --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text | sed "s/^/$m /"
  done
}
cmd_cycle() {
  if [ "$1" = reboot ]; then sd 'sudo systemctl reboot' >/dev/null 2>&1 || true; sleep 25
  else aws ec2 stop-instances --instance-ids "$DESK_ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$DESK_ID"
       aws ec2 start-instances --instance-ids "$DESK_ID" >/dev/null; aws ec2 wait instance-running --instance-ids "$DESK_ID"; addrs; fi
  for _ in $(seq 1 90); do sd true 2>/dev/null && break; sleep 5; done; log "desk back after $1"
}
cmd_hours() { awk '{print}' "$W/spend.log"; aws ec2 describe-instances --instance-ids "$CLIENT_ID" "$DESK_ID" --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,LaunchTime]' --output text 2>/dev/null; }
cmd_down() {
  set +e
  local ids=() v; for v in DESK_ID CLIENT_ID; do [ -n "${!v:-}" ] && ids+=("${!v}"); done
  [ ${#ids[@]} -gt 0 ] && { aws ec2 terminate-instances --instance-ids "${ids[@]}" >/dev/null; for v in "${ids[@]}"; do spendlog TERMINATE "$v" -; done; aws ec2 wait instance-terminated --instance-ids "${ids[@]}"; log "terminated ${ids[*]}"; }
  [ -n "${SGID:-}" ] && for _ in 1 2 3 4 5 6 7 8; do aws ec2 delete-security-group --group-id "$SGID" 2>/dev/null && { log "deleted group $SGID"; setv SGID ""; break; }; sleep 10; done
  aws ec2 delete-key-pair --key-name $NAME >/dev/null 2>&1 && log "deleted key pair $NAME"; shred -u "$KEY" 2>/dev/null
  setv DESK_ID ""; setv CLIENT_ID ""
  log "left with Owner=$OWNER:"; aws ec2 describe-instances --filters Name=tag:Owner,Values=$OWNER Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text
  aws ec2 describe-volumes --filters Name=tag:Owner,Values=$OWNER --query 'Volumes[].VolumeId' --output text; aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME --query 'SecurityGroups[].GroupId' --output text
  aws ec2 describe-network-interfaces --filters Name=tag:Owner,Values=$OWNER --query 'NetworkInterfaces[].NetworkInterfaceId' --output text; aws ec2 describe-key-pairs --key-names $NAME 2>&1 | tail -1
}

case "${1:-}" in
  up) cmd_up ;; fixtures) fixtures ;; client-setup) client_setup ;; push-client) push_client ;; addrs) addrs ;;
  rows) shift; cmd_rows "$@" ;; profile) shift; cmd_profile "$@" ;; pause) shift; cmd_pause "$@" ;; lab) shift; cmd_lab "$@" ;;
  desk) shift; sd "$@" ;; client) shift; sc "$@" ;; row) rows_ "$2" ;; netem) cmd_netem "$2" ;; networkout) cmd_networkout "$2" "$3" ;;
  reboot | stop-start) cmd_cycle "$1" ;; hours) cmd_hours ;; down) cmd_down ;; tunnel) tunnel ;; fetch) fetch "$2" ;;
  *) sed -n 2,11p "$0"; exit 2 ;;
esac
