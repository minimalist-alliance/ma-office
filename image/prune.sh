#!/bin/bash
# prune.sh delete <ami-id> [--release]   deregister one ma-desk AMI and delete its snapshots (a test bake, or a failed one)
#
# It refuses, and changes nothing, when the AMI:
#   - is staging's or prod's desk_image#current (ma-<env>-settings, read with get-item only), which new desks launch from;
#   - is in use by an instance that isn't terminated: launched from it, or with a volume from its snapshots attached, as a
#     root swap to it leaves;
#   - isn't a test bake (named ma-desk-test-*), unless --release says a release image is meant. A release is a rollback
#     target: RELEASES.md, the log's rows and desk-rollout.md name AMIs to swap back to, and a kept root swapped from it isn't
#     attached, so nothing here sees it. Check that none names it before --release.
# A read that fails is a refusal too. The first two have no override: change the setting (ma-platform
# scripts/desk-image-set.sh) or end the instance first. lib.sh's delete_ami still refuses anything not tagged
# Purpose=desk-image-build.
# "prune.sh keep N" is gone: it kept the newest N by date alone, so two test bakes were enough for it to delete prod's
# image (weekend review, 2026-11-07). Whoever bakes a test image deletes it by its ID.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
usage() { die "usage: prune.sh delete <ami-id> [--release]"; }
[ "${1:-}" != keep ] || die "prune.sh keep is gone, since it could delete the image new desks launch from: delete each test bake with prune.sh delete <ami-id>"
[ "${1:-}" = delete ] && [ $# -ge 2 ] && [ $# -le 3 ] || usage
AMI=$2; [[ $AMI =~ ^ami-[0-9a-f]{8,17}$ ]] || usage
RELEASE=0; case "${3:-}" in '') ;; --release) RELEASE=1 ;; *) usage ;; esac
refuse() { log "refusing to delete $AMI, nothing changed: $*"; exit 1; }

name=$(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text) || refuse "can't read it"
for env in staging prod; do
  cur=$(aws dynamodb get-item --table-name "ma-$env-settings" --consistent-read --key '{"key":{"S":"desk_image#current"}}' \
    --query 'Item.value.M.ami_id.S' --output text) || refuse "can't read $env's desk_image#current"
  [ "$cur" != "$AMI" ] || refuse "it's $env's desk_image#current, which new desks launch from"
done
users=$(aws ec2 describe-instances --filters "Name=image-id,Values=$AMI" \
  "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text) || refuse "can't list the instances launched from it"
snaps=$(aws ec2 describe-images --image-ids "$AMI" --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text) \
  || refuse "can't read its snapshots"
for s in $snaps; do
  [ "$s" != None ] || continue
  att=$(aws ec2 describe-volumes --filters "Name=snapshot-id,Values=$s" --query 'Volumes[].Attachments[].InstanceId' --output text) \
    || refuse "can't list the volumes made from $s"
  users="$users $att"
done
users=$(tr -s '[:space:]' '\n' <<<"$users" | grep -v -x -e '' -e None | sort -u | paste -sd' ' || true)
[ -z "$users" ] || refuse "instance(s) $users use it"
[[ $name == ma-desk-test-* ]] || [ "$RELEASE" = 1 ] || refuse "it's $name, not a test bake (ma-desk-test-*); add --release to delete a release image"
log "$AMI ($name): no env's desk_image#current, no instance uses it$([ "$RELEASE" = 1 ] && echo ", --release")"
delete_ami "$AMI"
