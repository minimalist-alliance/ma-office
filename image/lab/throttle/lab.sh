#!/bin/bash
# lab.sh: ADR 0036's lab boxes, for section 6's tests 2 to 4 and the ADR's [A] claims. Two boxes from ma-desk-0.2.3,
# tagged Purpose=ma-sub-throttle, with no instance role and no member data. A is a c7g.large, B a t4g.medium, in one subnet.
#
#   lab.sh up                      launch both (key pair and group made here, deleted by down)
#   lab.sh apply [A|B]             upload image/recipe and this folder, then apply.sh: build.sh's own steps (default both)
#   lab.sh run <A|B> <script> [VAR=value ...]   a script from tests/ as root; PEER is the other box's private address
#   lab.sh sh <A|B> <command>      one command as root
#   lab.sh verify <A|B> <out>      verify.sh's sections 2, 3, 3a1, 3b, 3c and 3d against the box, evidence to <out>
#   lab.sh reboot|stop-start <A|B> and wait for SSH again
#   lab.sh networkout <box> <t0> <t1>  CloudWatch's NetworkOut buckets around a test (t6-counters prints t0 and t1)
#   lab.sh stop-ignored <A|B>      time an EC2 stop of a guest that ignores the power button (leaves the box stopped)
#   lab.sh hours                   instance-hours so far
#   lab.sh down                    terminate both, delete the group and the key pair
#
# Nothing here prints an address. The workstation's own is held in a variable and written only to the boxes' user data
# and the group's one SSH rule. State (IDs and the key) is in $LAB_STATE, mode 0700, removed by down.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=$(cd "$HERE/../.." && pwd)
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
AMI=${LAB_AMI:?set LAB_AMI to the image to test}
AZ=${LAB_AZ:-us-east-1b}
ST=${LAB_STATE:-/tmp/ma-sub-throttle}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15)
log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
tags() { echo "ResourceType=$1,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=ma-sub-throttle},{Key=Owner,Value=ma-sub-16d-throttle},{Key=ManagedBy,Value=claude-cli}${2:+,{Key=Name,Value=$2\}}]"; }
id_of() { cat "$ST/$1" 2>/dev/null || die "no box $1"; }
other() { [ "$1" = A ] && echo B || echo A; }
q() { aws ec2 describe-instances --instance-ids "$(id_of "$1")" --query "Reservations[0].Instances[0].$2" --output text; }
R() { local box=$1; shift; ssh "${SSH_OPTS[@]}" -i "$ST/key.pem" "admin@$(q "$box" PublicIpAddress)" "$@"; }
wait_ssh() { local end=$((SECONDS + ${2:-600})); until R "$1" true 2>/dev/null; do [ $SECONDS -lt $end ] || return 1; sleep 5; done; }

up() {
  [ -e "$ST/A" ] && die "already up ($ST)"
  install -d -m 0700 "$ST"
  local name=ma-sub-throttle-$$ vpc subnet sg myip pub
  echo "$name" > "$ST/keyname"
  aws ec2 create-key-pair --key-name "$name" --key-type ed25519 --tag-specifications "$(tags key-pair)" --query KeyMaterial --output text > "$ST/key.pem" || die "key pair"
  chmod 600 "$ST/key.pem"
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  subnet=$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true Name=availability-zone,Values="$AZ" --query 'Subnets[0].SubnetId' --output text)
  sg=$(aws ec2 create-security-group --group-name "$name" --description "ADR 0036 lab boxes, temporary" --vpc-id "$vpc" \
    --tag-specifications "$(tags security-group)" --query GroupId --output text) || die "group"
  echo "$sg" > "$ST/sg"
  myip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
  [[ $myip =~ ^[0-9.]+$ ]] || die "can't read this workstation's address"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$myip/32" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions "IpProtocol=-1,UserIdGroupPairs=[{GroupId=$sg}]" >/dev/null
  pub=$(ssh-keygen -y -f "$ST/key.pem")
  cat > "$ST/userdata" <<EOF
#!/bin/bash
# TEST ONLY (ADR 0036 lab box): SSH from one workstation, and anything from the lab's own subnet, after every boot and every
# reload of /etc/nftables.conf (lab-allow). A real desk has neither.
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
install -d -m 700 /etc/ma-lab; echo '$myip' > /etc/ma-lab/ssh-from; chmod 600 /etc/ma-lab/ssh-from
cat > /usr/local/sbin/lab-allow <<'S'
#!/bin/sh
net=\$(ip -j -4 route show dev ens5 proto kernel | jq -r '.[0].dst')
nft add rule inet ma input ip saddr "\$(cat /etc/ma-lab/ssh-from)" tcp dport 22 accept
nft add rule inet ma input ip saddr "\$net" accept
S
chmod 700 /usr/local/sbin/lab-allow
cat > /etc/systemd/system/lab-ssh.service <<'U'
[Unit]
Description=TEST ONLY: SSH for the ADR 0036 lab
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/lab-allow
ExecStart=/bin/systemctl start ssh
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable --now lab-ssh.service
EOF
  myip=
  local box type
  for box in A B; do
    type=c7g.large; [ $box = B ] && type=t4g.medium
    aws ec2 run-instances --image-id "$AMI" --instance-type "$type" --count 1 --subnet-id "$subnet" --security-group-ids "$sg" \
      --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
      --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}" \
      --user-data "file://$ST/userdata" --tag-specifications "$(tags instance "ma-sub-throttle-$box")" "$(tags volume)" \
      --query 'Instances[0].InstanceId' --output text > "$ST/$box" || die "run-instances $box"
    log "box $box: $(cat "$ST/$box") ($type)"
  done
  shred -u "$ST/userdata"
  aws ec2 wait instance-running --instance-ids "$(id_of A)" "$(id_of B)"
  date -u +%s > "$ST/t0"
  for box in A B; do wait_ssh $box 600 || die "no SSH on $box"; R $box 'cloud-init status --wait >/dev/null 2>&1; true'; log "box $box: SSH up"; done
}

upload() { tar -C "$IMAGE" -czf - recipe lab verify.sh | R "$1" 'sudo rm -rf /var/tmp/lab && sudo mkdir -p /var/tmp/lab && sudo tar -C /var/tmp/lab -xzf -'; }

apply() {
  local box
  for box in ${1:-A B}; do upload $box && R $box 'sudo bash /var/tmp/lab/lab/throttle/apply.sh' 2>&1 | sed "s/^/[$box] /"; done
}

run() {
  local box=$1 script=$2; shift 2
  local peer; peer=$(q "$(other "$box")" PrivateIpAddress)
  upload "$box" || return 1
  R "$box" "sudo env PEER=$peer BOX=$box TYPE=$(q "$box" InstanceType) $* bash /var/tmp/lab/lab/throttle/tests/$script"
}

sh_() { local box=$1; shift; R "$box" "sudo bash -c $(printf %q "$*")"; }

verify() {
  local box=$1 EV=$2 WORKDIR KEY_FILE=$ST/key.pem
  WORKDIR=$(mktemp -d); : > "$EV"
  PASS=0; FAILN=0
  say() { echo "$*" | tee -a "$EV" >&2; }
  result() { local ev; ev=$(cat); if [ "$2" = 0 ]; then PASS=$((PASS+1)); say "PASS  $1"; else FAILN=$((FAILN+1)); say "FAIL  $1"; fi; echo "$ev" | sed 's/^/        /' >> "$EV"; }
  R() { ssh "${SSH_OPTS[@]}" -i "$KEY_FILE" "admin@$(q "$box" PublicIpAddress)" "$@"; }
  RS() { R "sudo bash -s"; }
  local sections; sections=$(awk '/^# ---- 2\. /{p=1} /^# ---- 3a\. /{p=0} /^# ---- 3a1\. /{p=1} /^# ---- 3b1\. /{p=0} /^# ---- 3c\. /{p=1} /^# ---- 4\. /{p=0} p' "$IMAGE/verify.sh")
  # ONLY=3c skips to section 3c (3d needs 3c's stand-in for desk-rtc).
  [ "${ONLY:-}" = 3c ] && sections=$(awk '/^# ---- 3c\. /{p=1} /^# ---- 4\. /{p=0} p' "$IMAGE/verify.sh")
  say "verify.sh sections 2, 3, 3a1, 3b, 3c, 3d against lab box $box ($(q "$box" InstanceType), ma-desk-0.2.3 plus this branch's image files), $(date -u +%FT%TZ)"
  # Section 3 copies a screenshot to evidence/screenshot-$AMI.png; a lab box's isn't kept.
  HERE=$IMAGE; AMI=lab-$box; IP=$(q "$box" PublicIpAddress)
  eval "$sections"
  say "passed $PASS, failed $FAILN"
  rm -rf "$WORKDIR" "$IMAGE/evidence/screenshot-lab-$box.png"
}

networkout() { # networkout <box> <t0> <t1>: NetworkOut and NetworkPacketsOut in 5-minute buckets around the test
  local id; id=$(id_of "$1")
  local m
  for m in NetworkOut NetworkPacketsOut; do
    aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name $m --dimensions Name=InstanceId,Value="$id" --statistics Sum --period 300 \
      --start-time "$(date -u -d @$(( $2 - 600 )) +%FT%TZ)" --end-time "$(date -u -d @$(( $3 + 900 )) +%FT%TZ)" \
      --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text | sed "s/^/$m /"
  done
}

hours() {
  local t0 now; t0=$(cat "$ST/t0"); now=$(date -u +%s)
  echo "2 boxes, $(( (now - t0) / 60 )) min each: $(awk -v s=$((now - t0)) 'BEGIN{printf "%.2f", 2*s/3600}') instance-hours (c7g.large and t4g.medium)"
}

cycle() {
  local how=$1 box=$2 id; id=$(id_of "$box")
  if [ "$how" = reboot ]; then R "$box" 'sudo systemctl reboot' >/dev/null 2>&1; sleep 25
  else
    aws ec2 stop-instances --instance-ids "$id" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$id"
    aws ec2 start-instances --instance-ids "$id" >/dev/null; aws ec2 wait instance-running --instance-ids "$id"
  fi
  wait_ssh "$box" 420 || die "no SSH on $box after $how"; log "box $box: back after $how"
}

stop_ignored() { # stop_ignored <box>: ADR 0036 section 6 test 3's last item. The guest ignores the power button, and EC2 has to force the stop.
  local box=$1 id t0 st; id=$(id_of "$box")
  R "$box" 'sudo bash -c "install -d /etc/systemd/logind.conf.d && printf \"[Login]\nHandlePowerKey=ignore\nHandlePowerKeyLongPress=ignore\n\" > /etc/systemd/logind.conf.d/zz-lab-ignore.conf && systemctl restart systemd-logind && systemctl show -p HandlePowerKey systemd-logind 2>/dev/null; loginctl show-seat seat0 2>/dev/null | head -0; echo logind: \$(systemctl is-active systemd-logind)"'
  t0=$(date +%s); aws ec2 stop-instances --instance-ids "$id" >/dev/null
  while :; do st=$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' --output text)
    [ "$st" = stopped ] && break; [ $(( $(date +%s) - t0 )) -gt 1500 ] && { echo "still $st after 1500 s"; return 1; }; sleep 5; done
  echo "stop-instances to stopped: $(( $(date +%s) - t0 )) s, with the guest ignoring the power button"
}

down() {
  local ids=() box
  for box in A B; do [ -s "$ST/$box" ] && ids+=("$(cat "$ST/$box")"); done
  [ ${#ids[@]} -gt 0 ] && { aws ec2 terminate-instances --instance-ids "${ids[@]}" >/dev/null; aws ec2 wait instance-terminated --instance-ids "${ids[@]}"; log "terminated ${ids[*]}"; }
  if [ -s "$ST/sg" ]; then
    for _ in 1 2 3 4 5 6 7 8; do aws ec2 delete-security-group --group-id "$(cat "$ST/sg")" 2>/dev/null && { log "deleted group $(cat "$ST/sg")"; break; }; sleep 10; done
  fi
  [ -s "$ST/keyname" ] && aws ec2 delete-key-pair --key-name "$(cat "$ST/keyname")" >/dev/null && log "deleted key pair $(cat "$ST/keyname")"
  [ -e "$ST/t0" ] && hours
  shred -u "$ST/key.pem" 2>/dev/null; rm -rf "$ST"
}

cmd=${1:-}; shift || true
case "$cmd" in
  up) up ;;
  apply) apply "$@" ;;
  run) run "$@" ;;
  sh) sh_ "$@" ;;
  verify) verify "$@" ;;
  networkout) networkout "$@" ;;
  reboot | stop-start) cycle "$cmd" "$@" ;;
  stop-ignored) stop_ignored "$@" ;;
  hours) hours ;;
  down) down ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
