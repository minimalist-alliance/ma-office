#!/bin/bash
# lab.sh: the u77-host lab box (ADR 0077's member-host half, sub/u77-host). A shared host from host 0.1.10's AMI on m7g.xlarge under
# SlotMode=port, tagged Purpose=desk-image-build, Owner=syseng-u77host, with two blank 4 GB test volumes for two slots' desks, no
# instance role and no member data. LAB EVIDENCE ONLY, never a release proof: this branch's host files are laid over the AMI
# (host-overlay.sh). Nothing here prints an address: the workstation's own goes only to the group's one SSH rule.
#
#   lab.sh up | push <dir> | sh <command> | get <remote> <local> | reboot-wait | hours | down
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
AMI=${LAB_AMI:?set LAB_AMI to the shared-host image to test}
TYPE=${LAB_TYPE:-m7g.xlarge}
OWNER=syseng-u77host
ST=${LAB_STATE:-$HOME/work/syseng-1109/u77host/lab}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15)
log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
tags() { echo "ResourceType=$1,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=Owner,Value=$OWNER},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform},{Key=Name,Value=$OWNER-lab}${2:-}]"; }
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
  sg=$(aws ec2 create-security-group --group-name "$name" --description "u77-host lab box, temporary" --vpc-id "$vpc" \
    --tag-specifications "$(tags security-group)" --query GroupId --output text) || die "group"
  echo "$sg" > "$ST/sg"
  myip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]'); [[ $myip =~ ^[0-9.]+$ ]] || die "can't read this workstation's address"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$myip/32" >/dev/null 2>&1 || die "ssh rule"
  unset myip
  pub=$(ssh-keygen -y -f "$ST/key.pem")
  cat > "$ST/userdata" <<U
#!/bin/bash
# TEST ONLY (u77-host lab box): SSH from one workstation, again after every boot. A member's host has none.
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/lab-ssh.service <<'S'
[Unit]
Description=TEST ONLY: SSH for the u77-host lab box
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft add rule inet host input tcp dport 22 accept; systemctl start ssh'
[Install]
WantedBy=multi-user.target
S
systemctl daemon-reload; systemctl enable --now lab-ssh.service
U
  subnet=
  for az in $(aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=instance-type,Values=$TYPE" --query 'InstanceTypeOfferings[].Location' --output text | tr '\t' '\n' | sort); do
    subnet=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" Name=default-for-az,Values=true "Name=availability-zone,Values=$az" --query 'Subnets[0].SubnetId' --output text)
    [[ $subnet == subnet-* ]] && break
  done
  id=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --count 1 \
    --network-interfaces "DeviceIndex=0,SubnetId=$subnet,Groups=$sg,AssociatePublicIpAddress=true" \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled,InstanceMetadataTags=enabled \
    --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=48,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$ST/userdata" \
    --tag-specifications "$(tags instance ',{Key=DesksPerHost,Value=6},{Key=SlotsPerHost,Value=6},{Key=HostingVersion,Value=lab},{Key=SlotMode,Value=port}')" "$(tags volume)" \
    --query 'Instances[0].InstanceId' --output text) || die "run-instances"
  echo "$id" > "$ST/instance"; date +%s > "$ST/started"
  log "instance $id ($TYPE from $AMI)"
  aws ec2 wait instance-running --instance-ids "$id"
  az=$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
  for n in 1 2; do
    v=$(aws ec2 create-volume --availability-zone "$az" --size 4 --volume-type gp3 --tag-specifications "$(tags volume)" --query VolumeId --output text)
    echo "$v" > "$ST/vol$n"
  done
  aws ec2 wait volume-available --volume-ids "$(cat "$ST/vol1")" "$(cat "$ST/vol2")"
  aws ec2 attach-volume --volume-id "$(cat "$ST/vol1")" --instance-id "$id" --device /dev/sdg >/dev/null
  aws ec2 attach-volume --volume-id "$(cat "$ST/vol2")" --instance-id "$id" --device /dev/sdh >/dev/null
  aws ec2 create-tags --resources "$id" --tags "Key=DeskSlot1,Value=d-testuqdeskaa/$(cat "$ST/vol1")/-/-/1" "Key=DeskSlot2,Value=d-testuqdeskbb/$(cat "$ST/vol2")/-/-/1"
  wait_up 600
  R 'sudo cloud-init status --wait >/dev/null 2>&1; true'; log "ssh up" ;;
push) R "sudo install -d -m 0755 /var/tmp/lab" && tar -C "$2" -cf - . | R "sudo tar --no-same-owner -C /var/tmp/lab -xf - && sudo chmod -R a+rX,go-w /var/tmp/lab" ;;
sh) shift; R "sudo bash -c $(printf '%q' "$*")" ;;
get) R "sudo cat $(printf '%q' "$2")" > "$3" ;;
vols) cat "$ST/vol1" "$ST/vol2" ;;
reboot-wait) sleep 25; wait_up 900; log "back" ;;
hours) s=$(cat "$ST/started" 2>/dev/null || date +%s); echo "$TYPE: $(( ($(date +%s) - s) / 60 )) min so far" ;;
down)
  set +e
  [ -e "$ST/instance" ] && { aws ec2 terminate-instances --instance-ids "$(iid)" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$(iid)"; log "terminated $(iid) after $(( ($(date +%s) - $(cat "$ST/started")) / 60 )) min"; }
  for n in 1 2; do [ -e "$ST/vol$n" ] && { aws ec2 wait volume-available --volume-ids "$(cat "$ST/vol$n")" 2>/dev/null; aws ec2 delete-volume --volume-id "$(cat "$ST/vol$n")" 2>/dev/null && log "deleted vol$n"; }; done
  [ -e "$ST/sg" ] && for i in 1 2 3 4 5 6 7 8; do aws ec2 delete-security-group --group-id "$(cat "$ST/sg")" 2>/dev/null && { log "deleted group"; break; }; sleep 8; done
  [ -e "$ST/keyname" ] && aws ec2 delete-key-pair --key-name "$(cat "$ST/keyname")" >/dev/null && log "deleted key pair"
  shred -u "$ST/key.pem" 2>/dev/null; rm -rf "$ST"
  echo "left, by tag Owner=$OWNER:"
  echo "  instances not terminated: $(aws ec2 describe-instances --filters Name=tag:Owner,Values=$OWNER Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text | wc -w)"
  echo "  volumes: $(aws ec2 describe-volumes --filters Name=tag:Owner,Values=$OWNER --query 'Volumes[].VolumeId' --output text | wc -w)"
  echo "  security groups: $(aws ec2 describe-security-groups --filters Name=tag:Owner,Values=$OWNER --query 'SecurityGroups[].GroupId' --output text | wc -w)"
  echo "  key pairs: $(aws ec2 describe-key-pairs --filters Name=tag:Owner,Values=$OWNER --query 'KeyPairs[].KeyName' --output text | wc -w)" ;;
*) sed -n 2,8p "$0"; exit 2 ;;
esac
