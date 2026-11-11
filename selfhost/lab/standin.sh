#!/bin/bash
# standin.sh: a temporary amd64 EC2 machine standing in for a member's own computer, to prove a self-hosted desk end to end
# against staging (S-85, docs/sub-status/s85-selfhost-033.md). Fresh Debian 13 amd64 (the official AMI), 2 cores and 4 GB
# (c6a.large), a 16 GB system disk and a blank 16 GB data disk, tagged Purpose=desk-image-build and Owner=$STANDIN_OWNER, no
# instance role. Nothing here prints an address: the workstation's goes only into the group's rules, and the machine's into
# the private state folder and the e2e's wrapper scripts there.
#
# How it differs from a member's machine, each for the test only:
#   - Its "home network" is the internet: the group lets in SSH (22) and the desk's port (4443, UDP and TCP) from this
#     workstation's address alone, and install.sh gets --address <its public address>, as for a forwarded port.
#   - standin-ssh.service (user data) puts "tcp dport 22 accept" back in the desk's firewall after every load of it, since the
#     desk's own --keep-ssh rule takes only private addresses. The group still holds SSH to this workstation.
#   - cloud-init is turned off after its first boot (as a cloud desk's image does, TD-227): a member's own Debian has none,
#     and once ma-selfhost answers on 169.254.169.254 a later boot's cloud-init would read it as another instance.
#
#   standin.sh up                   launch it and wait for SSH (key pair and group made here, deleted by down)
#   standin.sh sh <command>         one command as admin (sudo for root)
#   standin.sh push <dir> <remote>  copy a folder's contents into <remote> on it (made, owned by admin)
#   standin.sh scripts              write ssh.sh and reboot.sh to the state folder, for selfhost/e2e's SELFHOST_SSH and SELFHOST_REBOOT
#   standin.sh reboot               restart it from outside, as a hypervisor would (EC2's reboot), and return
#   standin.sh minutes              minutes since launch
#   standin.sh down                 terminate it, delete the group and the key pair, and check by tag
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
OWNER=${STANDIN_OWNER:-syseng-s85}
TYPE=${STANDIN_TYPE:-c6a.large}
ST=${STANDIN_STATE:-$HOME/work/s85/private/standin}
PORT=${STANDIN_PORT:-4443}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15 -o BatchMode=yes)
log() { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }
tags() { echo "ResourceType=$1,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=Owner,Value=$OWNER},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform},{Key=Name,Value=$OWNER-standin}]"; }
iid() { cat "$ST/instance" 2>/dev/null || die "no machine"; }
ip() { aws ec2 describe-instances --instance-ids "$(iid)" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text; }
R() { ssh "${SSH_OPTS[@]}" -i "$ST/key.pem" "admin@$(cat "$ST/address")" "$@"; }
wait_up() { local end=$((SECONDS + ${1:-600})); until R true 2>/dev/null; do [ $SECONDS -lt $end ] || die "no ssh"; sleep 5; done; }

case "${1:-}" in
up)
  [ -e "$ST/instance" ] && die "already up ($ST)"
  install -d -m 0700 "$ST"
  # Debian's own public parameter for its newest official Debian 13 amd64 image.
  ami=$(aws ssm get-parameter --name /aws/service/debian/release/13/latest/amd64 --query Parameter.Value --output text) || die "no Debian 13 image"
  [[ $ami =~ ^ami-[0-9a-f]+$ ]] || die "no Debian 13 image: $ami"
  name=$OWNER-$$; echo "$name" > "$ST/keyname"
  aws ec2 create-key-pair --key-name "$name" --key-type ed25519 --tag-specifications "$(tags key-pair)" --query KeyMaterial --output text > "$ST/key.pem" || die "key pair"
  chmod 600 "$ST/key.pem"
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  sg=$(aws ec2 create-security-group --group-name "$name" --description "S-85 self-hosted desk stand-in, temporary" --vpc-id "$vpc" \
    --tag-specifications "$(tags security-group)" --query GroupId --output text) || die "group"
  echo "$sg" > "$ST/sg"
  myip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]'); [[ $myip =~ ^[0-9.]+$ ]] || die "can't read this workstation's address"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$myip/32}]" \
    "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$myip/32}]" \
    "IpProtocol=udp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$myip/32}]" >/dev/null 2>&1 || die "group rules"
  unset myip
  cat > "$ST/userdata" <<'U'
#!/bin/bash
# TEST ONLY (S-85 stand-in for a member's machine): SSH from the test workstation through the desk's firewall, put back after
# every load of it. The security group lets in only that workstation. A member's desk has none of this.
cat > /etc/systemd/system/standin-ssh.service <<'S'
[Unit]
Description=TEST ONLY: SSH into the S-85 stand-in through the desk's firewall
After=nftables.service
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft list chain inet ma input >/dev/null 2>&1 && nft add rule inet ma input tcp dport 22 accept || true'
ExecReload=/bin/sh -c 'nft list chain inet ma input >/dev/null 2>&1 && nft add rule inet ma input tcp dport 22 accept || true'
[Install]
WantedBy=multi-user.target nftables.service
S
systemctl daemon-reload
systemctl enable --now standin-ssh.service
# From the next boot on: a member's Debian has no cloud-init (a cloud desk's image turns it off the same way, TD-227).
touch /etc/cloud/cloud-init.disabled
U
  id=$(aws ec2 run-instances --image-id "$ami" --instance-type "$TYPE" --count 1 --key-name "$name" --security-group-ids "$sg" \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
    --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=16,VolumeType=gp3,DeleteOnTermination=true}" \
                            "DeviceName=/dev/sdf,Ebs={VolumeSize=16,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$ST/userdata" --tag-specifications "$(tags instance)" "$(tags volume)" \
    --query 'Instances[0].InstanceId' --output text) || die "run-instances"
  echo "$id" > "$ST/instance"; date +%s > "$ST/started"
  log "instance $id ($TYPE from $ami)"
  aws ec2 wait instance-running --instance-ids "$id"
  ip > "$ST/address"; chmod 600 "$ST/address"
  wait_up 600
  R 'cloud-init status --wait >/dev/null 2>&1; true'; log "ssh up" ;;
sh) shift; R "$@" ;;
push) R "install -d -m 0755 '$3'" && tar -C "$2" -cf - . | R "tar --no-same-owner -C '$3' -xf -" ;;
scripts)
  printf '#!/bin/sh\nexec ssh %s -i %q admin@%s "$1"\n' "${SSH_OPTS[*]}" "$ST/key.pem" "$(cat "$ST/address")" > "$ST/ssh.sh"
  printf '#!/bin/sh\nexec %q reboot\n' "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" > "$ST/reboot.sh"
  chmod 700 "$ST/ssh.sh" "$ST/reboot.sh"; log "wrote $ST/ssh.sh and $ST/reboot.sh" ;;
reboot) aws ec2 reboot-instances --instance-ids "$(iid)" && log "restart asked" ;;
minutes) echo $(( ($(date +%s) - $(cat "$ST/started")) / 60 )) ;;
down)
  id=$(iid)
  aws ec2 terminate-instances --instance-ids "$id" >/dev/null && aws ec2 wait instance-terminated --instance-ids "$id" && log "terminated $id"
  aws ec2 delete-security-group --group-id "$(cat "$ST/sg")" && log "group deleted"
  aws ec2 delete-key-pair --key-name "$(cat "$ST/keyname")" && log "key pair deleted"
  log "by tag Owner=$OWNER:"
  aws ec2 describe-instances --filters "Name=tag:Owner,Values=$OWNER" "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down" --query 'length(Reservations[].Instances[])' --output text | sed 's/^/  instances not terminated: /'
  aws ec2 describe-volumes --filters "Name=tag:Owner,Values=$OWNER" --query 'length(Volumes)' --output text | sed 's/^/  volumes: /'
  aws ec2 describe-security-groups --filters "Name=tag:Owner,Values=$OWNER" --query 'length(SecurityGroups)' --output text | sed 's/^/  security groups: /'
  aws ec2 describe-key-pairs --filters "Name=tag:Owner,Values=$OWNER" --query 'length(KeyPairs)' --output text | sed 's/^/  key pairs: /'
  aws ec2 describe-images --owners self --filters "Name=tag:Owner,Values=$OWNER" --query 'length(Images)' --output text | sed 's/^/  images: /'
  mv "$ST" "$ST.down-$(date +%s)" ;;
*) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
