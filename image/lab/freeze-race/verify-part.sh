#!/bin/bash
# verify-part.sh [label]: verify.sh sections 3b2 and 3b2a on the lab box, as verify.sh runs them: their helpers and their root
# blocks are cut unchanged from ../../verify.sh, run as root, and judged by verify.sh's own rules. Output in ~/work/t46l1/.
# Lab only; it doesn't print the box's address.
set -uo pipefail
H=$(cd "$(dirname "$0")" && pwd); V=$H/../../verify.sh; L=$H/lab.sh; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
OUT=$HOME/work/t46l1/verify-${1:-run}.txt
awk '/^cat > \$WORKDIR\/sv.py <<.P.$/{f=1;next} f&&/^P$/{f=0} f' "$V" > "$T/sv.py"
awk '/^cat > \$WORKDIR\/fz.py <<.P.$/{f=1;next} f&&/^P$/{f=0} f' "$V" > "$T/fz.py"
block() { awk -v m="$1" 'index($0, m) == 1 {s=1} s && /^RS <<.X./ {f=1; next} f && /^X$/ {exit} f' "$V"; }
block '# ---- 3b2. ' > "$T/v3b2.sh"; block '# ---- 3b2a. ' > "$T/v3b2a.sh"
[ -s "$T/v3b2.sh" ] && [ -s "$T/v3b2a.sh" ] && [ -s "$T/sv.py" ] && [ -s "$T/fz.py" ] || { echo "couldn't cut the sections" >&2; exit 2; }
"$L" push "$T" || exit 2
"$L" sh 'cp /var/tmp/lab/sv.py /var/tmp/lab/fz.py /var/tmp/; systemctl stop verify-pages verify-fz-pages 2>/dev/null; systemctl is-active --quiet desk-browser || systemctl start desk-browser; sleep 5' >/dev/null 2>&1
"$L" sh 'bash /var/tmp/lab/v3b2.sh' > "$T/o2" 2>&1
rc2=0; grep -q -e '^FAILED$' -e '^BAD$' "$T/o2" && rc2=1; [ "$(grep -c '^ok$' "$T/o2")" = 4 ] || rc2=1
"$L" sh 'bash /var/tmp/lab/v3b2a.sh' > "$T/o3" 2>&1
rc3=0; grep -q '^FAILED$' "$T/o3" && rc3=1; grep -q '^ran to the end$' "$T/o3" || rc3=1
{ echo "== 3b2: $([ $rc2 = 0 ] && echo PASS || echo FAIL)"; sed 's/^/    /' "$T/o2"; echo "== 3b2a: $([ $rc3 = 0 ] && echo PASS || echo FAIL)"; sed 's/^/    /' "$T/o3"; } |
  sed -E 's/ip-[0-9]+-[0-9]+-[0-9]+-[0-9]+/ip-x/g; s/172\.31\.[0-9]+\.[0-9]+/172.31.x.x/g' > "$OUT"
echo "3b2 $([ $rc2 = 0 ] && echo PASS || echo FAIL), 3b2a $([ $rc3 = 0 ] && echo PASS || echo FAIL): $OUT"
[ $rc2 = 0 ] && [ $rc3 = 0 ]
