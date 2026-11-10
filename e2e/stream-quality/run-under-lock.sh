#!/bin/bash
# run-under-lock.sh <label> <rtc-version> <stream-version>: one whole desk session for task 29, meant to run as
#   flock ~/work/.test-desk.lock timeout 44m e2e/stream-quality/run-under-lock.sh sq-1 0.3.3 0.2.4
# It records what the test desk runs, rolls the two releases out (desk-service-release.sh, already published), checks health,
# runs the kit, removes what the kit put on the desk, rolls both back to what it found, and confirms the versions. Every step
# goes to results/<label>.desk-log.txt with its UTC time. Only the staging test desk is ever addressed.
set -uo pipefail
label=${1:?usage: run-under-lock.sh <label> <desk-rtc version> <desk-stream version>}
rtc_new=${2:?desk-rtc version}
stream_new=${3:?desk-stream version}
INSTANCE=${E2E_TEST_INSTANCE:?set E2E_TEST_INSTANCE to the staging test desk}
REL=$HOME/minimalist-alliance/scripts/desk-service-release.sh
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/results"
LOG=$here/results/$label.desk-log.txt
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 PATH=$HOME/.local/node-v24/bin:$PATH
T0=$SECONDS

step() { echo "$(date -u +%FT%TZ) [+$(((SECONDS - T0) / 60))m$(((SECONDS - T0) % 60))s] $*" | tee -a "$LOG"; }
# One shell command on the test desk over SSM, as e2e/tests/streamlib.ts' deskRun sends it.
desk() {
  local id out st i
  id=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --parameters "$(jq -cn --arg c "$1" '{commands:[$c]}')" --query Command.CommandId --output text) || return 1
  for i in $(seq 1 80); do
    sleep 1.5
    out=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --output json 2>/dev/null) || continue
    st=$(jq -r .Status <<<"$out")
    case $st in Success) jq -r .StandardOutputContent <<<"$out"; return 0 ;; Failed | Cancelled | TimedOut) jq -r .StandardErrorContent <<<"$out" | head -c 600; return 1 ;; esac
  done
  return 1
}
# The releases each component runs (current and previous), the image, the units, and deskd's own health, without addresses.
versions() {
  desk 'for c in desk-rtc desk-stream deskd; do echo "$c current=$(basename "$(readlink -f /opt/ma/$c/current)") previous=$(p=$(readlink -f /opt/ma/$c/previous 2>/dev/null) && basename "$p")"; done
echo "image=$(grep "^version=" /etc/ma-release | cut -d= -f2) booted=$(uptime -s)"
for u in desk-rtc desk-stream deskd desk-browser; do echo "unit $u $(systemctl is-active $u) restarts=$(systemctl show -p NRestarts --value $u)"; done
curl -s -m 3 --unix-socket /run/desk/deskd-admin.sock http://desk/health | python3 -I -c "import json,sys; h=json.load(sys.stdin); print(\"health\", json.dumps({k: h.get(k) for k in (\"status\", \"version\", \"stream\")}))" 2>/dev/null || echo "health unreadable"'
}
current() { sed -n "s/^$1 current=\([^ ]*\).*/\1/p" <<<"$2"; }
release() { step "release.sh $*"; "$REL" "$@" 2>&1 | grep -vE '^arn:' | tee -a "$LOG.release" | grep -E '^(result|ma-update|recorded|error|target|instance|--- ssm)' | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

step "lock held: $label, rolling out desk-rtc $rtc_new and desk-stream $stream_new to $INSTANCE"
found=$(versions); echo "$found" | sed 's/^/  found: /' | tee -a "$LOG"
rtc_found=$(current desk-rtc "$found"); stream_found=$(current desk-stream "$found")
[ -n "$rtc_found" ] && [ -n "$stream_found" ] || { step "could not read the versions; stopping before any change"; exit 3; }
step "found desk-rtc $rtc_found, desk-stream $stream_found"

rolled_rtc=0 rolled_stream=0
if release rollout desk-rtc "$rtc_new" test --instance "$INSTANCE"; then rolled_rtc=1; else step "desk-rtc rollout FAILED (ma-update restores the previous release itself)"; fi
if [ $rolled_rtc = 1 ]; then
  if release rollout desk-stream "$stream_new" test --instance "$INSTANCE"; then rolled_stream=1; else step "desk-stream rollout FAILED"; fi
fi
after=$(versions); echo "$after" | sed 's/^/  after rollout: /' | tee -a "$LOG"

if [ $rolled_rtc = 1 ] && [ $rolled_stream = 1 ] && [ "$(current desk-rtc "$after")" = "$rtc_new" ] && [ "$(current desk-stream "$after")" = "$stream_new" ]; then
  step "running the kit (log: results/$label.log)"
  (cd "$here/.." && SQ_LABEL=$label SQ_LOADED=${SQ_LOADED:-1} SQ_BUDGET_S=${SQ_BUDGET_S:-1380} timeout 27m npx playwright test -c stream-quality stream-quality.spec.ts) >"$here/results/$label.log" 2>&1
  rc=$?
  step "kit exit $rc: $(grep -E '^\s+[0-9]+ (passed|failed|skipped)' "$here/results/$label.log" | tr -s ' ' | tr '\n' ' ')"
  grep -E '\[sq\] (aborted|removed from the desk|finish)' "$here/results/$label.log" | cut -c1-300 | sed 's/^/  /' | tee -a "$LOG"
else
  step "not measuring: the rollouts didn't both take"
fi

# Whatever the kit managed, nothing of it stays: its page server and files (idempotent).
step "cleanup: $(desk 'systemctl stop ma-sq-pages 2>/dev/null; systemctl reset-failed ma-sq-pages 2>/dev/null; rm -rf /var/tmp/ma-sq; echo "pages unit $(systemctl is-active ma-sq-pages 2>/dev/null), dir $( [ -e /var/tmp/ma-sq ] && echo present || echo gone)"' | tr '\n' ' ')"

# Back to what was found, newest first. A rollback swaps current and previous (ma-update), which is the found release after a rollout.
if [ $rolled_stream = 1 ]; then release rollback desk-stream test --instance "$INSTANCE" || step "desk-stream rollback FAILED"; fi
if [ $rolled_rtc = 1 ]; then release rollback desk-rtc test --instance "$INSTANCE" || step "desk-rtc rollback FAILED"; fi
end=$(versions); echo "$end" | sed 's/^/  after rollback: /' | tee -a "$LOG"
for i in 1 2; do
  ok=1
  [ "$(current desk-rtc "$end")" = "$rtc_found" ] || ok=0
  [ "$(current desk-stream "$end")" = "$stream_found" ] || ok=0
  [ $ok = 1 ] && break
  step "versions differ from what was found; rolling back once more"
  [ "$(current desk-stream "$end")" = "$stream_found" ] || release rollback desk-stream test --instance "$INSTANCE"
  [ "$(current desk-rtc "$end")" = "$rtc_found" ] || release rollback desk-rtc test --instance "$INSTANCE"
  end=$(versions); echo "$end" | sed 's/^/  after rollback again: /' | tee -a "$LOG"
done
if [ $ok = 1 ]; then step "CONFIRMED: desk-rtc $rtc_found and desk-stream $stream_found, as found"; else step "NOT AS FOUND: desk-rtc $(current desk-rtc "$end"), desk-stream $(current desk-stream "$end")"; fi
step "releasing the lock"
