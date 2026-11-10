#!/bin/bash
# box.sh up <ami> <type> [deadline-minutes] | ssh ... | scp-to <src> <dst> | down : one temporary test box tagged Purpose=desk-image-build.
# State and key live in KEYPROOF_DIR (default: a folder under $TMPDIR); the key is shredded on down.
set -uo pipefail
W=${KEYPROOF_DIR:-${TMPDIR:-/tmp}/keyproof}/box; mkdir -p "$W"; chmod 700 "$W"
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
ST=$W/state.env; KEY=$W/key.pem; touch "$ST"; . "$ST"
tags='{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform}'
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15)
setv() { grep -v "^$1=" "$ST" > "$ST.t" || true; echo "$1=$2" >> "$ST.t"; mv "$ST.t" "$ST"; eval "$1='$2'"; }
case "$1" in
up)
  ami=$2; type=$3; mins=${4:-300}; deadline=$(( $(date +%s) + mins*60 ))
  if [ -z "${SG:-}" ]; then
    name=ma-desk-keyfix-$$
    aws ec2 create-key-pair --key-name "$name" --key-type ed25519 --tag-specifications "ResourceType=key-pair,Tags=[$tags]" --query KeyMaterial --output text > "$KEY"; chmod 600 "$KEY"
    setv KEYNAME "$name"
    vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
    ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
    sg=$(aws ec2 create-security-group --group-name "$name" --description "temporary $name" --vpc-id "$vpc" --tag-specifications "ResourceType=security-group,Tags=[$tags]" --query GroupId --output text)
    aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null 2>&1 || { echo "can't add the ssh rule to $sg"; exit 1; }
    setv SG "$sg"
  fi
  pub=$(ssh-keygen -y -f "$KEY"); ud=$(mktemp)
  cat > "$ud" <<U
#!/bin/bash
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/box-ssh.service <<'S'
[Unit]
Description=TEST ONLY: temporary SSH (the security group limits who can reach it), and the safety deadline, re-armed on every boot
After=nftables.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft add rule inet ma input tcp dport 22 accept; systemctl start ssh; left=\$(( ($deadline - \$(date +%%s)) / 60 )); [ \$left -gt 0 ] || left=1; shutdown -h +\$left'
[Install]
WantedBy=multi-user.target
S
systemctl daemon-reload; systemctl enable --now box-ssh.service
U
  iid=$(aws ec2 run-instances --image-id "$ami" --instance-type "$type" --count 1 --key-name "$KEYNAME" --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
    --block-device-mappings "DeviceName=/dev/sdf,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}" \
    --user-data "file://$ud" --tag-specifications "ResourceType=instance,Tags=[$tags,{Key=Name,Value=ma-keyfix-$type}]" "ResourceType=volume,Tags=[$tags]" \
    --query 'Instances[0].InstanceId' --output text) || exit 1
  rm -f "$ud"; setv IID "$iid"; echo "LAUNCH $iid $type $ami $(date -u +%FT%TZ)" >> "$W/spend.log"
  aws ec2 wait instance-running --instance-ids "$iid"
  ip=$(aws ec2 describe-instances --instance-ids "$iid" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text); setv IP "$ip"
  for _ in $(seq 1 90); do ssh "${SSHO[@]}" "admin@$ip" true 2>/dev/null && break; sleep 5; done
  ssh "${SSHO[@]}" "admin@$ip" 'cat /etc/ma-release; uname -m; nproc'; echo "$iid $ip"
  ;;
ssh) shift; exec ssh "${SSHO[@]}" "admin@$IP" "$@" ;;
put) shift; exec scp -q "${SSHO[@]}" "$1" "admin@$IP:$2" ;;
get) shift; exec scp -q "${SSHO[@]}" "admin@$IP:$1" "$2" ;;
kill) [ -n "${IID:-}" ] && aws ec2 terminate-instances --instance-ids "$IID" >/dev/null && aws ec2 wait instance-terminated --instance-ids "$IID"; echo "TERMINATE $IID $(date -u +%FT%TZ)" >> "$W/spend.log"; setv IID ""; setv IP "" ;;
down)
  [ -n "${IID:-}" ] && { aws ec2 terminate-instances --instance-ids "$IID" >/dev/null; aws ec2 wait instance-terminated --instance-ids "$IID"; echo "TERMINATE $IID $(date -u +%FT%TZ)" >> "$W/spend.log"; }
  [ -n "${SG:-}" ] && for _ in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$SG" 2>/dev/null && break; sleep 6; done
  [ -n "${KEYNAME:-}" ] && aws ec2 delete-key-pair --key-name "$KEYNAME" >/dev/null
  shred -u "$KEY" 2>/dev/null; : > "$ST"
  aws ec2 describe-instances --filters Name=tag:Purpose,Values=desk-image-build --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name]' --output text
  ;;
esac
