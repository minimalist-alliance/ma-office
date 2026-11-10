# Shared helpers for bake.sh, verify.sh, prune.sh. Sourced, not run.
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
TAG_PROJECT=minimalist-alliance
TAG_PURPOSE=desk-image-build
tagspec() { echo "ResourceType=$1,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=desk-image-build},{Key=ManagedBy,Value=claude-cli},{Key=CostCenter,Value=platform}${OWNER_TAG:+,{Key=Owner,Value=$OWNER_TAG\}}]"; }   # OWNER_TAG=x adds Owner=x to everything made
# The S3 key names that count as "this release passed" (bake.sh). Every component needs passed-test.json (a rollout to a
# DeskKind=test desk). A guild-only component, one no member's desk runs, has passed-guild.json instead (a rollout to a staging
# Guild Desk) and takes nothing else's: no other component may use it, whatever its S3 folder holds.
GUILD_ONLY_COMPONENTS="commons-server"
pass_records() { # pass_records <component> -> one key name a line
  echo passed-test.json
  case " $GUILD_ONLY_COMPONENTS " in *" $1 "*) echo passed-guild.json ;; esac
}
log() { echo "[$(date +%H:%M:%S)] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

my_ip() { curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]'; }

# make_temp_access <name>: creates key pair + SG (this workstation's IP only); sets KEY_NAME KEY_FILE SG_ID WORKDIR
make_temp_access() {
  local name=$1 vpc ip
  WORKDIR=$(mktemp -d)
  KEY_NAME=$name; KEY_FILE=$WORKDIR/$name.pem
  aws ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 \
    --tag-specifications "$(tagspec key-pair)" --query KeyMaterial --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  ip=$(my_ip)
  SG_ID=$(aws ec2 create-security-group --group-name "$name" --description "temporary $name" --vpc-id "$vpc" \
    --tag-specifications "$(tagspec security-group)" --query GroupId --output text)
  # AWS repeats the rule in its errors, and the address goes in no log, so this error names only the group.
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null 2>&1 || die "can't add the ssh rule to $SG_ID"
  log "temp access: key $KEY_NAME, sg $SG_ID (22 from this workstation only)"
}

# destroy_temp_access <instance-ids...>: terminate, wait, delete SG and key pair, shred pem. Safe to call twice.
destroy_temp_access() {
  local ids=("$@") i
  set +e
  for i in "${ids[@]}"; do
    [ -n "$i" ] || continue
    aws ec2 terminate-instances --instance-ids "$i" >/dev/null 2>&1
  done
  for i in "${ids[@]}"; do
    [ -n "$i" ] || continue
    aws ec2 wait instance-terminated --instance-ids "$i" 2>/dev/null
    log "instance $i: $(aws ec2 describe-instances --instance-ids "$i" --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1)"
  done
  if [ -n "${SG_ID:-}" ]; then
    for i in 1 2 3 4 5 6; do aws ec2 delete-security-group --group-id "$SG_ID" 2>/dev/null && { log "deleted sg $SG_ID"; break; }; sleep 5; done
    SG_ID=
  fi
  if [ -n "${KEY_NAME:-}" ]; then aws ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1; KEY_NAME=; fi
  if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then shred -u "$WORKDIR"/*.pem 2>/dev/null; rm -rf "$WORKDIR"; WORKDIR=; fi
  set -e
}

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o ServerAliveInterval=15)
# wait_ssh <ip> <keyfile> [timeout-seconds]
wait_ssh() {
  local ip=$1 key=$2 t=${3:-420} end=$((SECONDS + ${3:-420}))
  until ssh "${SSH_OPTS[@]}" -i "$key" "admin@$ip" true 2>/dev/null; do
    [ "$SECONDS" -lt "$end" ] || return 1; sleep 5
  done
}

# delete_ami <ami-id>: deregister and delete its snapshots (only if tagged Purpose=desk-image-build)
delete_ami() {
  local ami=$1 snaps s p
  p=$(aws ec2 describe-images --image-ids "$ami" --query "Images[0].Tags[?Key=='Purpose']|[0].Value" --output text 2>/dev/null || true)
  [ "$p" = "$TAG_PURPOSE" ] || { log "refusing to delete $ami (not tagged Purpose=$TAG_PURPOSE)"; return 1; }
  snaps=$(aws ec2 describe-images --image-ids "$ami" --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)
  aws ec2 deregister-image --image-id "$ami" >/dev/null
  for s in $snaps; do [ "$s" = None ] || aws ec2 delete-snapshot --snapshot-id "$s"; done
  log "deleted $ami and snapshots $snaps"
}
