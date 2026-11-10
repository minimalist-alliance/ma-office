#!/bin/bash
# break-swap.sh: verify.sh section 6c ("swap") broken once, on the lab box after breaks.sh. One site is left off on /data, then
# the root is replaced with the box's own AMI (ma-desk-0.2.9), which has no desk-adblock to render the list before Chromium
# starts: the part has to fail. The lab box can't be used for the other parts afterwards (lab.sh down next). Output: appended
# to the evidence file.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); L=$HERE/lab.sh
OUT=${1:-$HERE/../../evidence/adblock-2026-11-07/breaks.txt}
ST=${LAB_STATE:-$HOME/work/47-adblock/lab}; IID=$(cat "$ST/instance")
o=$("$L" verify leave-off 2>&1); echo "$o" | grep -E '^list:|^BAD' | sed 's/^/      before: /' >> "$OUT"
T=$(aws ec2 create-replace-root-volume-task --instance-id "$IID" --delete-replaced-root-volume --tag-specifications "ResourceType=replace-root-volume-task,Tags=[{Key=Project,Value=minimalist-alliance},{Key=Purpose,Value=browser-benchmark},{Key=Owner,Value=ma-task47-d}]" --query ReplaceRootVolumeTask.ReplaceRootVolumeTaskId --output text)
for i in $(seq 1 90); do s=$(aws ec2 describe-replace-root-volume-tasks --replace-root-volume-task-ids "$T" --query 'ReplaceRootVolumeTasks[0].TaskState' --output text); [ "$s" = succeeded ] || [ "$s" = failed ] && break; sleep 10; done
echo "      replace-root $T: $s" >> "$OUT"
for i in $(seq 1 60); do "$L" sh true >/dev/null 2>&1 && break; sleep 10; done
"$L" sh 'for i in $(seq 1 60); do systemctl is-active --quiet desk-browser && break; sleep 2; done; test -e /usr/local/lib/ma/desk-adblock && echo "helper on the new root: yes" || echo "helper on the new root: no"' >> "$OUT" 2>&1
o=$("$L" verify swap 2>&1); got=pass; { grep -q '^FAILED$' <<<"$o" || ! grep -q '^ran to the end$' <<<"$o"; } && got=fail
mark=OK; [ "$got" = fail ] || mark=UNEXPECTED
printf '%s  %-10s %-55s wanted %s, got %s\n' "$mark" swap "a new root that doesn't render the list (0.2.9's)" fail "$got" | tee -a "$OUT"
grep -E '^BAD|this boot|list on' <<<"$o" | head -6 | sed 's/^/      /' >> "$OUT"
