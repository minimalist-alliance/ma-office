#!/usr/bin/env bash
# Straight before a root swap: closes the desk's Chromium cleanly over SSM, so its session, preferences and newest cookies are
# written and synced, and nothing starts it again before the reboot (image/README.md, "Before a root swap"; task 33 item 3;
# ADR 0035). It sends
# this tree's recipe/files/usr/local/lib/ma/desk-browser-close, so it works on images that don't carry the helper yet.
#
#   image/desk-browser-close.sh <instance-id>
#
#   exit 0  Chromium is stopped and its exit was clean, or it wasn't running: go ahead with the swap
#   exit 1  it's still running, or its exit wasn't clean: don't swap yet, read the line it printed
#   exit 2  nothing was run: bad arguments, or SSM didn't take the command
#
# Either way deskd is stopped on the desk until the reboot. If you don't swap after all: systemctl start deskd, over SSM.
# It never touches /data/browser/profile: it reads exit_type from the profile's Preferences and nothing else.
# Needs: aws, jq. The run order is in docs/runbooks/restore-rehearsal.md and ma-platform docs/runbooks/desk-rollout.md.
set -euo pipefail
export AWS_REGION=${AWS_REGION:-us-east-1} AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HELPER=$HERE/recipe/files/usr/local/lib/ma/desk-browser-close

die() { echo "error: $*" >&2; exit 2; }
[ $# -eq 1 ] || die "usage: image/desk-browser-close.sh <instance-id>"
[[ $1 =~ ^i-[0-9a-f]{8,17}$ ]] || die "not an instance id: $1"
command -v aws >/dev/null && command -v jq >/dev/null || die "needs aws and jq"
[ -r "$HELPER" ] || die "no $HELPER"
ID=$1

run="echo $(base64 -w0 "$HELPER") | base64 -d | bash -s"
cmd=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript --timeout-seconds 60 \
  --parameters "$(jq -cn --arg c "$run" '{commands: [$c], executionTimeout: ["300"]}')" \
  --comment "desk-browser-close before a root swap" --query Command.CommandId --output text) || die "SSM didn't take the command"
for _ in $(seq 1 160); do
  sleep 2
  inv=$(aws ssm get-command-invocation --command-id "$cmd" --instance-id "$ID" --output json 2>/dev/null) || continue
  case $(jq -r .Status <<<"$inv") in
    Pending | InProgress | Delayed) continue ;;
  esac
  jq -r .StandardOutputContent <<<"$inv"
  jq -r '.StandardErrorContent | select(. != "")' <<<"$inv" >&2
  case $(jq -r .ResponseCode <<<"$inv") in
    0) exit 0 ;;
    1) exit 1 ;;
    *) echo "SSM status $(jq -r .Status <<<"$inv")" >&2; exit 1 ;;
  esac
done
echo "no answer from the desk in 320 s: don't swap yet" >&2
exit 1
