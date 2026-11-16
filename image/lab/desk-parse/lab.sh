#!/bin/bash
# lab.sh: the desk-parse lab box (ADR 0097, the Agent's attachment reader). A desk box from LAB_AMI (default ma-desk-0.3.7) on
# t4g.medium, tagged Purpose=desk-image-build, Owner=syseng-parse, with a blank 32 GB data volume, no instance role and no
# member data. Nothing here prints an address: the workstation's own goes only to the box's user data and the group's one SSH
# rule. State (IDs and the key) is in $LAB_STATE, 0700, removed by down. LAB ONLY, never a release proof.
#
#   lab.sh up                    launch it (key pair and group made here, deleted by down)
#   lab.sh overlay <desk-svc>    this tree's desk-parse files on the box as the image will carry them (the user, desk-svc for arm64,
#                                desk-parse-run and -ask, the unit, its tmpfiles lines, desk-agent's Wants=, the smoke test, the
#                                firewall's line inserted live), then desk-agent restarted, which starts desk-parse
#   lab.sh deskagent <commit>    until desk-agent's release N is published (ADR 0097 section 4): desk-agent's image built on the
#                                box from that commit's services/ (the Desk Engineer's sub/desk-parse), named in desk-agent's
#                                current/image-id, its run that commit's (the originals kept as image-id.orig and run.orig), and
#                                desk-agent restarted on them
#   lab.sh verify <part>...      image/verify-parse.sh's parts on the box, as verify.sh runs them (FAILED or "ran to the end")
#   lab.sh put <local> <remote>  copy one file to the box (root's, 0644)
#   lab.sh sh <command>          one command as root
#   lab.sh get <remote> <local>  copy a file back
#   lab.sh hours                 minutes so far
#   lab.sh down                  terminate it, delete the group and the key pair, and check by tag
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
AMI=${LAB_AMI:?set LAB_AMI to the desk image}   # ma-desk-0.3.7
TYPE=${LAB_TYPE:-t4g.medium}
OWNER=${LAB_OWNER:-syseng-parse}
ST=${LAB_STATE:-$HOME/work/syseng-1109/parse/lab-cloud}
H=$(cd "$(dirname "$0")" && pwd); IMG=$(cd "$H/../.." && pwd); F=$IMG/recipe/files
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
  sg=$(aws ec2 create-security-group --group-name "$name" --description "desk-parse lab box, temporary" --vpc-id "$vpc" \
    --tag-specifications "$(tags security-group)" --query GroupId --output text) || die "group"
  echo "$sg" > "$ST/sg"
  myip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]'); [[ $myip =~ ^[0-9.]+$ ]] || die "can't read this workstation's address"
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$myip/32" >/dev/null 2>&1 || die "ssh rule"
  unset myip
  pub=$(ssh-keygen -y -f "$ST/key.pem")
  cat > "$ST/userdata" <<U
#!/bin/bash
# TEST ONLY (desk-parse lab box): SSH from one workstation, re-added after every boot. A real desk has none.
install -d -m 700 -o admin -g admin /home/admin/.ssh
echo '$pub' > /home/admin/.ssh/authorized_keys; chown admin:admin /home/admin/.ssh/authorized_keys; chmod 600 /home/admin/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/systemd/system/lab-ssh.service <<'S'
[Unit]
Description=TEST ONLY: SSH for the desk-parse lab box
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
overlay)   # this tree's desk-parse files, as build.sh installs them; the firewall line is inserted live (a reload would drop the lab's SSH rule)
  bin=${2:?usage: lab.sh overlay <arm64 desk-svc>}
  file "$bin" | grep -q 'ARM aarch64.*statically linked' || die "$bin isn't a static arm64 binary"
  t=$(mktemp -d); install -d "$t/etc/systemd/system" "$t/etc/tmpfiles.d" "$t/usr/local/lib/ma" "$t/opt/ma"
  cp "$F/etc/systemd/system/desk-parse.service" "$F/etc/systemd/system/desk-agent.service" "$t/etc/systemd/system/"
  cp "$F/etc/tmpfiles.d/desk-parse.conf" "$t/etc/tmpfiles.d/"; cp "$F/etc/nftables.conf" "$t/etc/"
  cp "$F/usr/local/lib/ma/desk-parse-run" "$F/usr/local/lib/ma/desk-parse-ask" "$F/usr/local/lib/ma/desk-restart-reset" "$t/usr/local/lib/ma/"
  cp "$bin" "$t/usr/local/lib/ma/desk-svc"; (cd "$t/usr/local/lib/ma" && sha256sum desk-svc | cut -d' ' -f1 > desk-svc.sha256)
  cp "$F/opt/ma/smoke-test" "$t/opt/ma/"
  chmod 0755 "$t"   # never a directory's mode onto the box's own: only these trees, and --no-overwrite-dir there (a "." of 0700 once made / 0700)
  tar -C "$t" --owner=0 --group=0 -cf - etc usr opt | R 'sudo bash -c "set -e
getent group parse >/dev/null || groupadd -g 1113 parse
id parse >/dev/null 2>&1 || useradd -u 1113 -g 1113 -M -d /nonexistent -s /usr/sbin/nologin parse
tar -C / --no-same-owner --no-overwrite-dir -xf -
chmod 0755 /usr/local/lib/ma/desk-svc /usr/local/lib/ma/desk-parse-run /usr/local/lib/ma/desk-parse-ask /usr/local/lib/ma/desk-restart-reset /opt/ma/smoke-test
chmod 0644 /usr/local/lib/ma/desk-svc.sha256 /etc/systemd/system/desk-parse.service /etc/systemd/system/desk-agent.service /etc/tmpfiles.d/desk-parse.conf /etc/nftables.conf
nft -c -f /etc/nftables.conf
nft list chain inet ma output | grep -q \"meta skuid 1113 reject\" || nft insert rule inet ma output meta skuid 1113 reject
systemctl daemon-reload; systemd-tmpfiles --create /etc/tmpfiles.d/desk-parse.conf
systemctl restart desk-agent.service
for i in \$(seq 1 60); do [ -S /run/desk-parse/sock/parse.sock ] && break; sleep 1; done
systemctl is-active desk-agent.service desk-parse.service; ls -la /run/desk-parse /run/desk-parse/sock"'
  rm -rf "$t" ;;
deskagent)   # Desk's half before its release (ADR 0097 section 4, item 1): desk-agent's image built on the box from that commit's
  # services/ (services/scripts/build-image.sh, arm64), named in desk-agent's current/image-id (the original kept as image-id.orig),
  # and desk-agent restarted on it, which restarts desk-parse on it too (PartOf=)
  c=${2:?usage: lab.sh deskagent <commit>}; c=$(git -C "$IMG/.." rev-parse --short=8 "$c") || die "no commit $2"
  R 'sudo rm -rf /var/tmp/da-src && sudo install -d -m 0755 /var/tmp/da-src'
  git -C "$IMG/.." archive --format=tar "$c" services | R 'sudo tar -C /var/tmp/da-src --no-same-owner -xf -'
  R "sudo bash -c 'set -e; cd /var/tmp/da-src/services; bash scripts/build-image.sh desk-agent lab-$c > /var/tmp/da-build.log 2>&1 || { tail -30 /var/tmp/da-build.log; exit 1; }
cur=/opt/ma/desk-agent/current; [ -f \$cur/image-id.orig ] || cp \$cur/image-id \$cur/image-id.orig
docker image inspect -f {{.Id}} ma/desk-agent:lab-$c > \$cur/image-id
[ -f \$cur/run.orig ] || cp \$cur/run \$cur/run.orig; install -m 0755 /var/tmp/da-src/services/desk-agent/docker/run \$cur/run
echo \"desk-agent image \$(cut -c1-19 \$cur/image-id.orig) -> lab-$c \$(cut -c1-19 \$cur/image-id)\"
systemctl restart desk-agent.service
for i in \$(seq 1 90); do [ \"\$(docker inspect -f {{.Image}} desk-parse 2>/dev/null)\" = \"\$(cat \$cur/image-id)\" ] && [ -S /run/desk-parse/sock/parse.sock ] && break; sleep 1; done
docker inspect -f \"desk-parse runs {{.Image}}\" desk-parse'" ;;
verify)
  shift; rc=0
  for p in "$@"; do
    o=$(R "sudo bash -s -- $p" < "$IMG/verify-parse.sh" 2>&1)
    echo "== verify-parse.sh $p"; echo "$o"
    if grep -q '^FAILED$' <<<"$o" || ! grep -q '^ran to the end$' <<<"$o"; then echo "RESULT $p: FAIL"; rc=1; else echo "RESULT $p: PASS"; fi
  done
  exit $rc ;;
put) R "sudo tee $(printf '%q' "$3") >/dev/null && sudo chmod 0644 $(printf '%q' "$3")" < "$2" ;;
sh) shift; R "sudo bash -c $(printf '%q' "$*")" ;;
get) R "sudo cat $(printf '%q' "$2")" > "$3" ;;
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
*) sed -n 2,22p "$0"; exit 2 ;;
esac
