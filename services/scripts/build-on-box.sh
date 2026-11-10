#!/usr/bin/env bash
# Builds a service's release on the arm64 test box, from this machine, and downloads it.
#
#   services/scripts/build-on-box.sh <git-sha> [service]     # service: deskd (the default), desk-agent or notebook,
#                                                            # whose component is desk-notebook
#
# Uploads a git archive of that commit to S3, starts the box if it's stopped, and has the box build the image and
# package the release over SSM. The box's role is SSM-only, so it fetches and uploads through presigned URLs. The
# version is <commit date, UTC>-<sha7>, such as 2026.11.05-a72fc48, so a commit always builds to the same version.
#
# Needs aws, jq, git, sha256sum and python3 with boto3, because the aws CLI can only presign GET. It needs write
# access to the S3 prefix, ssm:SendCommand and ec2:StartInstances. Nothing runs on any desk; publishing and rollout
# are separate steps (docs/runbooks/deskd-build-and-run.md).
#
# The presigned URLs are bearer secrets, valid for URL_TTL and for one object each. They stay in SSM's command
# history, expired after that, and are never printed here or on the box: curl's errors don't contain the URL's query.
set -euo pipefail

INSTANCE=${BUILD_BOX_INSTANCE:?set BUILD_BOX_INSTANCE to the arm64 build box}
BUCKET=${RELEASE_BUCKET:-ma-lambda-artifacts-$(aws sts get-caller-identity --query Account --output text)}
SERVICE=${2:-deskd}
REGION=${AWS_REGION:-us-east-1}
URL_TTL=7200           # Long enough for the delivery wait plus the build.
RUN_TIMEOUT=1800       # A clean build is minutes; this only stops a stuck one.
DELIVERY_TIMEOUT=600   # An instance that just started may take a while to pick up the command.
SSM_ONLINE_ATTEMPTS=30 # Ten seconds apart.
case $SERVICE in
  notebook) COMPONENT=desk-notebook ;;
  *) COMPONENT=$SERVICE ;;
esac
RELEASES=$HOME/.local/share/ma-desk-releases/$COMPONENT

export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

log() { echo "build-on-box: $*"; }
die() { echo "build-on-box: $*" >&2; exit 1; }

[ $# -eq 1 ] || [ $# -eq 2 ] || die "usage: build-on-box.sh <git-sha> [service]"
[[ $SERVICE =~ ^[a-z][a-z0-9-]{1,31}$ ]] || die "bad service name: $SERVICE"
for tool in aws jq git python3 sha256sum; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify --quiet "$1^{commit}") || die "unknown commit: $1"
git -C "$repo" cat-file -e "$sha:services/$SERVICE/Dockerfile" 2>/dev/null || die "$sha has no services/$SERVICE/Dockerfile"
version=$(TZ=UTC git -C "$repo" show -s --format=%cd --date=format-local:%Y.%m.%d "$sha")-${sha:0:7}

prefix=desk/$COMPONENT/build/$version
src_key=$prefix/src.tgz
tgz_key=$prefix/$COMPONENT-$version.tgz
sum_key=$tgz_key.sha256

tmp=$(mktemp -d)
remove_objects=0
cleanup() {
  rm -rf "$tmp"
  if [ "$remove_objects" = 1 ]; then
    # Only the three objects this run made. The release itself is on this machine by now, or the build failed.
    for key in "$src_key" "$tgz_key" "$sum_key"; do
      aws s3 rm "s3://$BUCKET/$key" --only-show-errors || true
    done
  fi
}
trap cleanup EXIT

# presign <get_object|put_object> <key>
presign() {
  python3 -I - "$1" "$BUCKET" "$2" "$URL_TTL" "$REGION" <<'PYTHON'
import sys

import boto3
from botocore.config import Config

method, bucket, key, ttl, region = sys.argv[1:6]
client = boto3.client("s3", region_name=region, config=Config(signature_version="s3v4"))
print(client.generate_presigned_url(method, Params={"Bucket": bucket, "Key": key}, ExpiresIn=int(ttl)))
PYTHON
}

start_instance() {
  log "starting $INSTANCE"
  aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
}

ensure_box_running() {
  local state ping
  state=$(aws ec2 describe-instances --instance-ids "$INSTANCE" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
  log "$INSTANCE is $state"
  case $state in
    running | pending) ;;
    stopped) start_instance ;;
    stopping)
      aws ec2 wait instance-stopped --instance-ids "$INSTANCE"
      start_instance
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

log "uploading $sha as $version"
# notebook bundles web/notebook/src/model as source. Other services' commits may be older than that path.
paths=(services)
[ "$SERVICE" = notebook ] && paths+=(web/notebook/src/model)
git -C "$repo" archive --format=tar.gz -o "$tmp/src.tgz" "$sha" "${paths[@]}"
src_sha=$(sha256sum "$tmp/src.tgz" | cut -d' ' -f1)
remove_objects=1
aws s3 cp "$tmp/src.tgz" "s3://$BUCKET/$src_key" --only-show-errors

src_url=$(presign get_object "$src_key")
tgz_url=$(presign put_object "$tgz_key")
sum_url=$(presign put_object "$sum_key")

# What the box runs. SSM runs this with sh and returns only the first 24,000 characters of output, so the build's
# log goes to a file and only its end comes back. The values above the body are checked: the version and hash by
# their construction, and a presigned URL contains no single quote.
{
  printf "SRC_URL='%s'\n" "$src_url"
  printf "TGZ_URL='%s'\n" "$tgz_url"
  printf "SUM_URL='%s'\n" "$sum_url"
  printf "SRC_SHA='%s'\n" "$src_sha"
  printf "SERVICE='%s'\n" "$SERVICE"
  printf "COMPONENT='%s'\n" "$COMPONENT"
  printf "VERSION='%s'\n" "$version"
  cat <<'REMOTE'
log=/var/tmp/ma-build-$COMPONENT.log
work=$(mktemp -d /var/tmp/ma-build.XXXXXX)
(
  set -eu
  command -v docker >/dev/null || { echo "docker is not installed on this box"; exit 1; }
  cd "$work"
  curl --fail --silent --show-error --retry 3 -o src.tgz "$SRC_URL"
  echo "$SRC_SHA  src.tgz" | sha256sum --check --quiet -
  tar -xzf src.tgz --no-same-owner
  services/scripts/build-image.sh "$SERVICE" "$VERSION"
  services/scripts/package-release.sh "$SERVICE" "$VERSION" "$work/out"
  curl --fail --silent --show-error --retry 3 -o /dev/null -T "$work/out/$COMPONENT-$VERSION.tgz" "$TGZ_URL"
  curl --fail --silent --show-error --retry 3 -o /dev/null -T "$work/out/$COMPONENT-$VERSION.tgz.sha256" "$SUM_URL"
) >"$log" 2>&1
rc=$?
tail -n 60 "$log"
rm -rf "$work"
exit "$rc"
REMOTE
} >"$tmp/remote.sh"
case $src_url$tgz_url$sum_url in
  *"'"*) die "a presigned URL contains a quote" ;;
esac

jq -Rs --arg timeout "$RUN_TIMEOUT" '{commands: (rtrimstr("\n") | split("\n")), executionTimeout: [$timeout]}' \
  "$tmp/remote.sh" >"$tmp/params.json"

# --query keeps the parameters, which hold the URLs, out of what aws prints.
command_id=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "build-on-box $COMPONENT $version" --timeout-seconds "$DELIVERY_TIMEOUT" \
  --parameters "file://$tmp/params.json" --query Command.CommandId --output text)
log "ssm command $command_id sent, waiting for the build"

deadline=$((SECONDS + DELIVERY_TIMEOUT + RUN_TIMEOUT + 60))
while :; do
  sleep 10
  # Right after sending, this fails with InvocationDoesNotExist.
  if invocation=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$INSTANCE" \
    --output json 2>/dev/null); then
    status=$(jq -r .Status <<<"$invocation")
    case $status in
      Pending | InProgress | Delayed) ;;
      *) break ;;
    esac
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    # The box may still upload, so its objects stay.
    remove_objects=0
    die "gave up waiting for $command_id; objects are left under s3://$BUCKET/$prefix/"
  fi
done

jq -r .StandardOutputContent <<<"$invocation" | tail -n 60
jq -r .StandardErrorContent <<<"$invocation" | tail -n 20 >&2
[ "$status" = Success ] || die "the build failed on the box: status $status, exit $(jq -r .ResponseCode <<<"$invocation")"

dest=$RELEASES/$version
mkdir -p "$dest"
aws s3 cp "s3://$BUCKET/$tgz_key" "$dest/" --only-show-errors
aws s3 cp "s3://$BUCKET/$sum_key" "$dest/" --only-show-errors
(cd "$dest" && sha256sum --check --quiet "$COMPONENT-$version.tgz.sha256") || die "the downloaded artifact fails its checksum"

log "version $version"
log "artifact $dest/$COMPONENT-$version.tgz"
