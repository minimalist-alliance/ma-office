#!/bin/bash
# idlerestart.sh: the link's idle restart of a running desk onto the candidate (its trial), measured (LAB ONLY, test data). The link
# is restarted so it looks at once; slot 1's deskd says idle (its own idle.json). Prints the prebuild, the gap (stop, swap) and the
# start, desk-host-upd's CPU and anonymous memory, how Chromium closed, then the session read back after Chromium starts again.
set -u
cd /var/tmp/lab; U=/sys/fs/cgroup/desk-host-upd
( m=0; while :; do a=$(sed -n 's/^anon //p' $U/memory.stat); [ "${a:-0}" -gt "$m" ] && m=$a && echo $m > /tmp/ir.anon; sleep 0.5; done ) & smp=$!
c0=$(sed -n 's/^usage_usec //p' $U/cpu.stat); n0=$(journalctl -u desk-host-link --no-pager -o cat | grep -c "idle restart")
t0=$(date +%s); systemctl restart desk-host-link
until [ "$(journalctl -u desk-host-link --no-pager -o cat | grep -c "idle restart")" -gt "$n0" ] || [ $(( $(date +%s) - t0 )) -gt 1500 ]; do sleep 2; done
t1=$(date +%s); c1=$(sed -n 's/^usage_usec //p' $U/cpu.stat); kill $smp
echo "link restart to idle restart done: $((t1 - t0)) s; desk-host-upd CPU $(( (c1 - c0) / 1000000 )) s; anon at most $(( $(cat /tmp/ir.anon 2>/dev/null || echo 0) >> 20 )) MiB; oom_kill $(sed -n 's/^oom_kill //p' $U/memory.events)"
journalctl -u desk-host-link --no-pager -o cat | grep "idle restart" | tail -1
grep -hE "built beside|idle restart onto|after the stop|a wake|re-rooted" /var/log/desk-host/link-host.log /var/log/desk-host/link-1.log /var/log/desk-host/link-2.log 2>/dev/null | tail -4
for k in 1 2; do bash steps.sh slot $k; done
python3 -I /usr/local/lib/desk-host/desk-host-template state | python3 -I -c 'import json,sys; s=json.load(sys.stdin); print("candidate", {k: s["candidate"].get(k) for k in ("gen","trialSlot","trialStartedAt","trialPassedAt")} if s["candidate"] else None)'
k=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as T; print((T.load_state().get("candidate") or {}).get("trialSlot") or 1)')
bash steps.sh browser $k | tail -1; sleep 10; bash steps.sh read $k
