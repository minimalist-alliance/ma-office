#!/bin/bash
# wakerace.sh <k>: a wake during a re-root (LAB ONLY). Slot k, on an older generation than the current one, is stopped by the fake
# Platform; the host starts its re-root in the background; 15 s into the copy the fake wants the desk running again. The start must
# begin at once on the old root (desk-host up: "a wake"), the copy be dropped, the slot's quota be what it was and no tree be left.
set -u
k=$1; cd /var/tmp/lab
q0=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as T; q = T.project_quota(1000 + int(sys.argv[1])); print(q[0], q[2])' "$k")
bash steps.sh stop "$k"
for i in $(seq 1 120); do [ -s /run/desk-host/reroot/$k.pgid ] && break; sleep 0.5; done
echo "re-root running: $(ps -eo etime,args | grep -E '^ *[0-9:]+ /bin/bash /usr/local/lib/desk-host/desk-host reroot '$k | grep -v grep | head -1 | cut -c1-80)"
sleep 15
echo "the copy so far: $(du -s --apparent-size --block-size=1M /srv/desk-host/slots/.$k.rr.* 2>/dev/null | cut -f1) MB"
bash steps.sh start "$k"
h=$(grep -n -- "--- .* desk-host up $k" /var/log/desk-host/link-$k.log | tail -1)
echo "the up began: ${h#*--- }"
sed -n "${h%%:*},\$p" /var/log/desk-host/link-$k.log | grep -E "dropped|a wake|up at" | head -3
sleep 3
echo "re-root's log: $(tail -2 /var/log/desk-host/reroot-$k.log | tr '\n' ' ')"
echo "trees left: [$(ls -d /srv/desk-host/slots/.$k.* 2>/dev/null | tr '\n' ' ')]"
q1=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as T; q = T.project_quota(1000 + int(sys.argv[1])); print(q[0], q[2])' "$k")
echo "quota before $q0, after $q1"
bash steps.sh slot "$k" | head -1
