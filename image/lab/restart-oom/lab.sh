#!/bin/bash
# lab.sh: the restart-oom lab box (restart back-off and OOM order). A desk box (LAB_AMI, default ma-desk-0.3.2) on t4g.medium, tagged Purpose=desk-image-build,
# Owner=syseng-restartoom, with a blank 32 GB data volume, no instance role and no member data. Nothing here prints an address:
# the workstation's own goes only to the box's user data and the group's one SSH rule. State (IDs and the key) is in
# $LAB_STATE, 0700, removed by down.
#
#   lab.sh up                    launch it (key pair and group made here, deleted by down)
#   lab.sh push <dir>            copy a folder's contents to /var/tmp/lab/ on the box
#   lab.sh push-recipe           this tree's recipe files, the host's and verify-restart.sh to /var/tmp/lab
#   lab.sh sh <command>          one command as root
#   lab.sh get <remote> <local>  copy a file back
#   lab.sh reboot                reboot from inside (systemctl reboot) and wait for ssh
#   lab.sh hours                 minutes so far
#   lab.sh down                  terminate it, delete the group and the key pair, and check by tag
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
AMI=${LAB_AMI:?set LAB_AMI to the desk image to test}
TYPE=${LAB_TYPE:-t4g.medium}
OWNER=syseng-restartoom
ST=${LAB_STATE:-$HOME/work/restart-oom/lab}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15)
log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
tags() { echo "ResourceType=$1,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=Owner,Value=$OWNER},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform},{Key=Name,Value=$OWNER-lab}]"; }
iid() { cat "$ST/instance" 2>/dev/null || die "no box"; }
ip() { aws ec2 describe-instances --instance-ids "$(iid)" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text; }
R() { ssh "${SSH_OPTS[@]}" -i "$ST/key.pem" "admin@$(ip)" "$@"; }
wait_up() { local end=$((SECONDS + ${1:-600})); until R true 2>/dev/null; do [ $SECONDS -lt $end ] || die "no ssh"; sleep 5; done; }

case "${1:-}" in
up)
  [ -e "$ST/instance" ] && die "already up ($ST)"
  install -d -m 0700 "$ST"
  name=$OWNER-$$; echo "$name" > "$ST/keyname"
  aws ec2 create-key-pair --key-name "$name" --key-type ed25519 --tag-specifications "$(tags key-pair)" --query KeyMaterial --output text > "$ST/key.pem" || die "key pair"
  chmod 600 "$ST/key.pem"
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  sg=$(aws ec2 create-security-group --group-name "$name" --description "restart-oom lab box, temporary" --vpc-id "$vpc" \
    --tag-specifications "$(tags security-group)" --query GroupId --output text) || die "group"
  echo "$sg" > "$ST/sg"
  myip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]'); [[ $myip =~ ^[0-9.]+$ ]] || die "can't read this workstation's address"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$myip/32" >/dev/null 2>&1 || die "ssh rule"
  unset myip
  pub=$(ssh-keygen -y -f "$ST/key.pem")
  cat > "$ST/userdata" <<U
#!/bin/bash
# TEST ONLY (restart-oom lab box): SSH from one workstation, re-added after every boot. A real desk has none.
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/lab-ssh.service <<'S'
[Unit]
Description=TEST ONLY: SSH for the restart-oom lab box
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft add rule inet ma input tcp dport 22 accept; systemctl start ssh'
[Install]
WantedBy=multi-user.target
S
systemctl daemon-reload; systemctl enable --now lab-ssh.service
U
  id=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 --security-group-ids "$sg" \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
    --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=32,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$ST/userdata" --tag-specifications "$(tags instance)" "$(tags volume)" \
    --query 'Instances[0].InstanceId' --output text) || die "run-instances"
  echo "$id" > "$ST/instance"; date +%s > "$ST/started"
  log "instance $id ($TYPE from $AMI)"
  aws ec2 wait instance-running --instance-ids "$id"
  wait_up 600
  R 'cloud-init status --wait >/dev/null 2>&1; true'; log "ssh up" ;;
push) R "sudo install -d -m 0755 /var/tmp/lab" && tar -C "$2" -cf - . | R "sudo tar --no-same-owner -C /var/tmp/lab -xf - && sudo chmod -R a+rX,go-w /var/tmp/lab" ;;
push-recipe)
  H=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
  cp -r "$H/../../recipe/files" "$T/recipe-files"; cp -r "$H/../../host/recipe/files" "$T/host-files" 2>/dev/null
  cp "$H"/../../verify-restart.sh "$H"/*.sh "$T/"; "$0" push "$T"; rm -rf "$T" ;;
sh) shift; R "sudo bash -c $(printf '%q' "$*")" ;;
get) R "sudo cat $(printf '%q' "$2")" > "$3" ;;
reboot) R 'sudo systemctl reboot' 2>/dev/null; sleep 20; wait_up 600; log "back" ;;
hours) s=$(cat "$ST/started" 2>/dev/null || date +%s); echo "$TYPE: $(( ($(date +%s) - s) / 60 )) min so far" ;;
down)
  set +e
  [ -e "$ST/instance" ] && { aws ec2 terminate-instances --instance-ids "$(iid)" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$(iid)"; log "terminated $(iid) after $(( ($(date +%s) - $(cat "$ST/started")) / 60 )) min"; }
  [ -e "$ST/sg" ] && for i in 1 2 3 4 5 6 7 8; do aws ec2 delete-security-group --group-id "$(cat "$ST/sg")" 2>/dev/null && { log "deleted group"; break; }; sleep 8; done
  [ -e "$ST/keyname" ] && aws ec2 delete-key-pair --key-name "$(cat "$ST/keyname")" >/dev/null && log "deleted key pair"
  shred -u "$ST/key.pem" 2>/dev/null; rm -rf "$ST"
  echo "left, by tag Owner=$OWNER:"
  echo "  instances not terminated: $(aws ec2 describe-instances --filters Name=tag:Owner,Values=$OWNER Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text | wc -w)"
  echo "  volumes: $(aws ec2 describe-volumes --filters Name=tag:Owner,Values=$OWNER --query 'Volumes[].VolumeId' --output text | wc -w)"
  echo "  security groups: $(aws ec2 describe-security-groups --filters Name=tag:Owner,Values=$OWNER --query 'SecurityGroups[].GroupId' --output text | wc -w)"
  echo "  key pairs: $(aws ec2 describe-key-pairs --filters Name=tag:Owner,Values=$OWNER --query 'KeyPairs[].KeyName' --output text | wc -w)"
  echo "  images: $(aws ec2 describe-images --owners self --filters Name=tag:Owner,Values=$OWNER --query 'Images[].ImageId' --output text | wc -w)" ;;
*) sed -n 2,15p "$0"; exit 2 ;;
esac
