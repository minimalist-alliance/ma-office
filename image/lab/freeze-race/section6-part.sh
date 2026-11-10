#!/bin/bash
# section6-part.sh [label]: verify.sh section 6's shutdown with Chromium frozen, on the lab box: its own three root blocks, cut
# unchanged from ../../verify.sh (freeze with a fresh cookie; after a real EC2 stop and start, judge the shutdown before anything
# starts Chromium; then read the cookie), judged by verify.sh's rules. Output in ~/work/t46l1/. Lab only.
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
H=$(cd "$(dirname "$0")" && pwd); V=$H/../../verify.sh; L=$H/lab.sh; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
OUT=$HOME/work/t46l1/section6-${1:-run}.txt; IID=$(cat "${LAB_STATE:-$HOME/work/t46l1/lab}/instance")
awk 'BEGIN{n=0} /^RS <<.X./ {n++; f=1; next} f && /^X$/ {f=0; next} f {print > (dir "/b" n ".sh")}' dir="$T" "$V"
A=$(grep -l 'fz-shutdown-cookie; sleep 5' "$T"/b*.sh); B=$(grep -l 'exit_type, before anything starts Chromium' "$T"/b*.sh); C=$(grep -l 'after a shutdown with Chromium frozen:' "$T"/b*.sh)
[ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] || { echo "couldn't cut section 6" >&2; exit 2; }
"$L" sh 'cp /var/tmp/lab/fz.py /var/tmp/fz.py; chmod 644 /var/tmp/fz.py' >/dev/null
"$L" sh "$(cat "$A")" > "$T/oA" 2>&1; ra=$?
aws ec2 stop-instances --instance-ids "$IID" >/dev/null && aws ec2 wait instance-stopped --instance-ids "$IID"
aws ec2 start-instances --instance-ids "$IID" >/dev/null && aws ec2 wait instance-running --instance-ids "$IID"
for _ in $(seq 1 60); do "$L" sh true >/dev/null 2>&1 && break; sleep 5; done
"$L" sh "$(cat "$B")" > "$T/oB" 2>&1; rb=$?
"$L" sh 'systemctl start desk-browser; for i in $(seq 1 90); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 1; done; sleep 8' >/dev/null 2>&1
"$L" sh "$(cat "$C")" > "$T/oC" 2>&1; rc=$?
{ echo "== the freeze before the stop: exit $ra"; sed 's/^/    /' "$T/oA"
  echo "== result \"a guest shutdown with Chromium frozen ...\": $([ $(( ra | rb )) = 0 ] && echo PASS || echo FAIL)"; sed 's/^/    /' "$T/oB"
  echo "== result \"a cookie set 5 s before that freeze came through the shutdown\": $([ $rc = 0 ] && echo PASS || echo FAIL)"; sed 's/^/    /' "$T/oC"; } |
  sed -E 's/ip-[0-9]+-[0-9]+-[0-9]+-[0-9]+/ip-x/g; s/172\.31\.[0-9]+\.[0-9]+/172.31.x.x/g' > "$OUT"
echo "section 6: shutdown $([ $(( ra | rb )) = 0 ] && echo PASS || echo FAIL), cookie $([ $rc = 0 ] && echo PASS || echo FAIL): $OUT"
