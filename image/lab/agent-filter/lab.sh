#!/bin/bash
# A lab box for ADR 0070's proofs: one box from a given AMI with a blank data volume and SSH from this workstation only,
# tagged Purpose=desk-image-build like a verify box. Its key and state live in $S/lab/<name>, outside the repo.
#   [SUBNET=<id>] lab.sh up <name> <ami> [type]   lab.sh ssh <name> <cmd...>   lab.sh root <name> < script   lab.sh put <name> <file> <dest>
#   lab.sh open443 <name> <ip>      (the stand-in's port, to one lab box)    lab.sh down <name>   (box, key and group)
set -euo pipefail
S=${S:?a scratch directory outside the repo}/lab
IMG=$(cd "$(dirname "$0")/../.." && pwd)
. "$IMG/lib.sh"
cmd=$1; name=$2; shift 2
D=$S/$name
case $cmd in
up)
  ami=$1; type=${2:-t4g.medium}; mkdir -p "$D"; chmod 700 "$D"
  KEY_NAME=ma-filter-lab-$name; KEY_FILE=$D/key.pem
  aws ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 --tag-specifications "$(tagspec key-pair)" --query KeyMaterial --output text > "$KEY_FILE"; chmod 600 "$KEY_FILE"
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  ip=$(my_ip)
  SG_ID=$(aws ec2 create-security-group --group-name "$KEY_NAME" --description "temporary $KEY_NAME" --vpc-id "$vpc" --tag-specifications "$(tagspec security-group)" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null 2>&1 || die "no ssh rule"
  ip=
  PUB=$(ssh-keygen -y -f "$KEY_FILE")
  cat > "$D/ud.sh" <<U
#!/bin/bash
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$PUB' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/verify-ssh.service <<'V'
[Unit]
Description=TEST ONLY: temporary SSH for a lab box
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft add rule inet ma input tcp dport 22 accept || true; systemctl start ssh'
[Install]
WantedBy=multi-user.target
V
systemctl daemon-reload
systemctl enable --now verify-ssh.service
U
  bd="DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}"
  iid=$(aws ec2 run-instances --image-id "$ami" --instance-type "$type" --count 1 --security-group-ids "$SG_ID" --key-name "$KEY_NAME" ${SUBNET:+--subnet-id "$SUBNET"} \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled --block-device-mappings "$bd" \
    --instance-initiated-shutdown-behavior terminate \
    --user-data "file://$D/ud.sh" --tag-specifications "$(tagspec instance | sed "s/}]\$/},{Key=Name,Value=$KEY_NAME}]/")" "$(tagspec volume)" --query 'Instances[0].InstanceId' --output text)
  echo "$iid" > "$D/iid"; echo "$SG_ID" > "$D/sg"; echo "$KEY_NAME" > "$D/kn"
  aws ec2 wait instance-running --instance-ids "$iid"
  aws ec2 describe-instances --instance-ids "$iid" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text > "$D/ip"
  aws ec2 describe-instances --instance-ids "$iid" --query 'Reservations[0].Instances[0].[PrivateIpAddress,SubnetId]' --output text > "$D/private"
  wait_ssh "$(cat "$D/ip")" "$KEY_FILE" 600 || die "no ssh"
  echo "up: $iid"
  ;;
ssh)  exec ssh "${SSH_OPTS[@]}" -i "$D/key.pem" "admin@$(cat "$D/ip")" "$@" ;;
root) exec ssh "${SSH_OPTS[@]}" -i "$D/key.pem" "admin@$(cat "$D/ip")" "sudo bash -s" ;;
open443) aws ec2 authorize-security-group-ingress --group-id "$(cat "$D/sg")" --protocol tcp --port 443 --cidr "$1/32" >/dev/null && echo "443 open on $name to a lab box" ;;
put)  exec scp "${SSH_OPTS[@]}" -i "$D/key.pem" "$1" "admin@$(cat "$D/ip"):$2" ;;
down)
  iid=$(cat "$D/iid"); aws ec2 terminate-instances --instance-ids "$iid" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$iid"
  for i in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$(cat "$D/sg")" 2>/dev/null && break; sleep 5; done
  aws ec2 delete-key-pair --key-name "$(cat "$D/kn")" >/dev/null
  shred -u "$D/key.pem"; rm -rf "$D"; echo "down: $iid"
  ;;
esac
