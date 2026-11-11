#!/usr/bin/env bash
# Builds and runs desk-agent's image on the arm64 test box, from this machine, and prints what test-image.sh measured
# there: the real linux/arm64 build, health, RSS and startup in the container. Nothing is published or kept.
#
#   services/desk-agent/scripts/test-on-box.sh <git-sha> [runs]
#
# The approach of services/scripts/build-on-box.sh (S3, SSM SendCommand, presigned URLs), with these differences:
# - Its own S3 prefix, desk/sub-desk-agent/, and it deletes the one object it made.
# - The box is shared, so it holds ~/work/.box.lock for the whole run, and waits while any SSM command is in progress
#   on the box.
# - On the box it works in one temporary directory and removes it. test-image.sh removes its containers, its image
#   and the intermediate images its build printed, and leaves every other image alone, deskd's included.
# - It starts the box only if it's stopped, and then stops it again at the end, if no other command is in progress.
#
# Needs aws, jq, git, sha256sum, flock and python3 with boto3 (the aws CLI can only presign GET, and this presigns
# GET only, but keeps build-on-box.sh's helper). The presigned URL is a bearer secret, valid for URL_TTL, and is
# never printed here or on the box.
set -euo pipefail


# The build box and bucket come from the environment, or from a private env file outside the repo.
[ -z "${BUILD_INSTANCE:-}" ] && [ -f "${DESK_BUILD_ENV:-$HOME/work/desk-build.env}" ] && . "${DESK_BUILD_ENV:-$HOME/work/desk-build.env}"
INSTANCE=${BUILD_INSTANCE:?set BUILD_INSTANCE to the build box instance id}
BUCKET=${ARTIFACT_BUCKET:?set ARTIFACT_BUCKET to the artifacts bucket}
REGION=${AWS_REGION:-us-east-1}
URL_TTL=3600
RUN_TIMEOUT=2400       # A clean build with Maven's downloads, then the runs.
DELIVERY_TIMEOUT=600
SSM_ONLINE_ATTEMPTS=30
BUSY_WAIT=1800         # How long to wait for someone else's command to finish.
LOCK=$HOME/work/.box.lock

export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

log() { echo "test-on-box: $*"; }
die() { echo "test-on-box: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: test-on-box.sh <git-sha> [runs]"
runs=${2:-5}
[[ $runs =~ ^[1-9][0-9]?$ ]] || die "bad run count: $runs"
for tool in aws jq git python3 sha256sum flock; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

# Everything below holds the box lock, which task 02's agent also takes.
if [ -z "${TEST_ON_BOX_LOCKED:-}" ]; then
  exec env TEST_ON_BOX_LOCKED=1 flock "$LOCK" "$0" "$@"
fi

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify --quiet "$1^{commit}") || die "unknown commit: $1"
git -C "$repo" cat-file -e "$sha:services/desk-agent/Dockerfile" 2>/dev/null || die "$sha has no services/desk-agent/Dockerfile"
version=$(TZ=UTC git -C "$repo" show -s --format=%cd --date=format-local:%Y.%m.%d "$sha")-${sha:0:7}
src_key=desk/sub-desk-agent/$version/src.tgz

tmp=$(mktemp -d)
uploaded=0
started_box=0
cleanup() {
  rm -rf "$tmp"
  if [ "$uploaded" = 1 ]; then
    aws s3 rm "s3://$BUCKET/$src_key" --only-show-errors || true
  fi
  if [ "$started_box" = 1 ]; then
    if [ "$(busy_commands)" = 0 ]; then
      log "stopping $INSTANCE, which this started"
      aws ec2 stop-instances --instance-ids "$INSTANCE" >/dev/null || true
    else
      log "leaving $INSTANCE running: another command is in progress on it"
    fi
  fi
}
trap cleanup EXIT

busy_commands() {
  aws ssm list-commands --instance-id "$INSTANCE" --filters key=Status,value=InProgress \
    --query 'length(Commands)' --output text 2>/dev/null || echo unknown
}

presign_get() {
  python3 -I - "$BUCKET" "$1" "$URL_TTL" "$REGION" <<'PYTHON'
import sys

import boto3
from botocore.config import Config

bucket, key, ttl, region = sys.argv[1:5]
client = boto3.client("s3", region_name=region, config=Config(signature_version="s3v4"))
print(client.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=int(ttl)))
PYTHON
}

ensure_box_running() {
  local state ping
  state=$(aws ec2 describe-instances --instance-ids "$INSTANCE" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
  log "$INSTANCE is $state"
  case $state in
    running | pending) ;;
    stopped)
      log "starting $INSTANCE"
      aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
      started_box=1
      ;;
    *) die "can't use $INSTANCE: it is $state" ;;
  esac
  aws ec2 wait instance-running --instance-ids "$INSTANCE"
  for _ in $(seq 1 "$SSM_ONLINE_ATTEMPTS"); do
    ping=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
    [ "$ping" = Online ] && return 0
    sleep 10
  done
  die "$INSTANCE is running but SSM isn't Online (last status: ${ping:-none})"
}

ensure_box_running
log "$INSTANCE is a $(aws ec2 describe-instances --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].InstanceType' --output text)"

waited=0
while :; do
  busy=$(busy_commands)
  [ "$busy" = 0 ] && break
  [ "$waited" -lt "$BUSY_WAIT" ] || die "$INSTANCE has had a command in progress for $BUSY_WAIT s; try later"
  log "$INSTANCE has $busy command(s) in progress; waiting"
  sleep 30
  waited=$((waited + 30))
done

log "uploading $sha as $version"
git -C "$repo" archive --format=tar.gz -o "$tmp/src.tgz" "$sha" services
src_sha=$(sha256sum "$tmp/src.tgz" | cut -d' ' -f1)
uploaded=1
aws s3 cp "$tmp/src.tgz" "s3://$BUCKET/$src_key" --only-show-errors
src_url=$(presign_get "$src_key")
case $src_url in
  *"'"*) die "the presigned URL contains a quote" ;;
esac

# What the box runs, as root, with sh. SSM returns only the first 24,000 characters, so the log goes to a file and its
# end comes back.
{
  printf "SRC_URL='%s'\n" "$src_url"
  printf "SRC_SHA='%s'\n" "$src_sha"
  printf "VERSION='%s'\n" "$version"
  printf "RUNS='%s'\n" "$runs"
  cat <<'REMOTE'
work=$(mktemp -d /var/tmp/ma-sub-desk-agent.XXXXXX)
log=$work.log
(
  set -eu
  command -v docker >/dev/null || { echo "docker is not installed on this box"; exit 1; }
  echo "box: $(uname -m), $(nproc) vCPUs, $(awk '/MemTotal/ {printf "%.1f GiB", $2 / 1048576}' /proc/meminfo)," \
    "load $(cut -d' ' -f1-3 /proc/loadavg)"
  cd "$work"
  curl --fail --silent --show-error --retry 3 -o src.tgz "$SRC_URL"
  echo "$SRC_SHA  src.tgz" | sha256sum --check --quiet -
  tar -xzf src.tgz --no-same-owner
  PREFIX=ma-sub HOST_TMP="$work" services/desk-agent/scripts/test-image.sh "$VERSION" "$RUNS"
  echo "box: load after $(cut -d' ' -f1-3 /proc/loadavg)"
) >"$log" 2>&1
rc=$?
tail -n 60 "$log"
rm -rf "$work" "$log"
exit "$rc"
REMOTE
} >"$tmp/remote.sh"

jq -Rs --arg timeout "$RUN_TIMEOUT" '{commands: (rtrimstr("\n") | split("\n")), executionTimeout: [$timeout]}' \
  "$tmp/remote.sh" >"$tmp/params.json"

# --query keeps the parameters, which hold the URL, out of what aws prints.
command_id=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "test-on-box desk-agent $version" --timeout-seconds "$DELIVERY_TIMEOUT" \
  --parameters "file://$tmp/params.json" --query Command.CommandId --output text)
log "ssm command $command_id sent, waiting for the build and the runs"

deadline=$((SECONDS + DELIVERY_TIMEOUT + RUN_TIMEOUT + 60))
while :; do
  sleep 15
  if invocation=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE" \
    --output json 2>/dev/null); then
    status=$(jq -r .Status <<<"$invocation")
    case $status in
      Pending | InProgress | Delayed) ;;
      *) break ;;
    esac
  fi
  [ "$SECONDS" -lt "$deadline" ] || die "gave up waiting for $command_id"
done

jq -r .StandardOutputContent <<<"$invocation" | tail -n 60
jq -r .StandardErrorContent <<<"$invocation" | tail -n 20 >&2
[ "$status" = Success ] || die "the test failed on the box: status $status, exit $(jq -r .ResponseCode <<<"$invocation")"
log "done: $version"
