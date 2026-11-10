#!/bin/bash
# measure-box.sh, on lab box a (a t4g.medium from the image under test, or with the release under test installed as a bake
# would), as a transient unit so a cut-off on the workstation can't leave half of it running. One run, nothing else of mine on the box. Output: stdout.
# B_IP comes from /var/tmp/b_ip. No keys: the providers' 401s are the answers. About 5 GB from the stand-in, most of it in D
# and E, a few minutes apart: keep it so, under Platform's cost guard (30 GB in 15 minutes stops a box).
set -u
B_IP=$(cat /var/tmp/b_ip)
as() { setpriv --reuid=$1 --regid=$1 --clear-groups "${@:2}"; }
install -m 0755 /var/tmp/load /usr/local/bin/load
[ -f /var/tmp/conf.orig ] || cp /etc/ma/agent-egress.conf /var/tmp/conf.orig
[ -f /var/tmp/hosts.orig ] || cp /etc/hosts /var/tmp/hosts.orig
cp /var/tmp/hosts.orig /etc/hosts; cp /var/tmp/conf.orig /etc/ma/agent-egress.conf
echo "$B_IP sink.filter-lab.test" >> /etc/hosts; echo sink.filter-lab.test >> /etc/ma/agent-egress.conf
CG=/sys/fs/cgroup/system.slice/desk-agent-filter.service
pid() { systemctl show -p MainPID --value desk-agent-filter; }
usec() { systemctl show -p CPUUsageNSec --value desk-agent-filter | awk '{print int($1/1000)}'; }
rss() { awk '/^VmRSS/ {r=$2} /^VmHWM/ {h=$2} END {printf "RSS %.1f MiB, peak RSS %.1f MiB", r/1024, h/1024}' /proc/$(pid)/status; echo ", cgroup now $(( $(cat $CG/memory.current) / 1048576 )) MiB, cgroup peak $(( $(cat $CG/memory.peak) / 1048576 )) MiB, oom_kill $(awk '/^oom_kill/ {print $2}' $CG/memory.events), max $(awk '/^max/ {print $2}' $CG/memory.events), threads $(ls /proc/$(pid)/task | wc -l), fds $(ls /proc/$(pid)/fd | wc -l)"; }
SINK=https://sink.filter-lab.test
restart() { systemctl restart desk-agent-filter; sleep 1; }
pyc() { python3 -I -c "print(round($1, 3))"; }
echo "== box: $(cat /etc/os-release | sed -n 's/^PRETTY_NAME=//p'), $(nproc) CPUs, filter $(cat /opt/ma/desk-agent-filter/current/VERSION) sha256 $(sha256sum /opt/ma/desk-agent-filter/current/desk-agent-filter | cut -c1-16), GOMAXPROCS $(systemctl show -p Environment --value desk-agent-filter | tr ' ' '\n' | sed -n 's/^GOMAXPROCS=//p'), started $(date -u +%FT%TZ)"
echo "== other load on the box: $(uptime | sed 's/.*load average/load average/')"

echo "== A. memory, fresh and idle (30 s after a restart)"
restart; sleep 30; rss

echo "== B. 20 streams at once, 60 events a second of 150 bytes, 45 s; memory at 25 s and after, CPU over 30 s of it"
as 1103 load streams -url "$SINK/sse?hz=60&size=150" -c 20 -for 45s & P=$!
sleep 5; u0=$(usec); sleep 20; rss; echo "pipes: $(ls -l /proc/$(pid)/fd | grep -c 'pipe:'), sockets: $(ls -l /proc/$(pid)/fd | grep -c 'socket:')"; sleep 10; u1=$(usec)
echo "filter CPU, 20 streams: $(pyc "($u1-$u0)/30e6*100") % of a core over 30 s"
wait $P; sleep 2; echo "after:"; rss

echo "== C. the cap: 100 at once, one event a second, 20 s"
restart
as 1103 load streams -url "$SINK/sse?hz=1&size=150" -c 100 -for 20s & P=$!
sleep 15; rss; echo "established to the filter: $(ss -Htn state established '( sport = :14443 )' | wc -l), the filter's descriptor limit $(awk '/Max open files/ {print $4}' /proc/$(pid)/limits)"
wait $P; sleep 2
journalctl -u desk-agent-filter --since -40s -o cat --no-pager | grep -E 'connections are open|not logged' | sort | uniq -c | tail -3
echo "after:"; rss

echo "== D. bulk: 300 MB down, twice each way, alternating; 300 MB up each way (the shaper's class 1:20, 100 Mbit)"
restart
cls() { tc -s -j class show dev ens5 | jq -r --arg c "$1" '.[] | select(.handle==$c) | .stats.bytes'; }
for i in 1 2; do
  u0=$(usec); as 1103 load bulk -url "$SINK/bytes?n=300000000" | sed "s/^/down $i through the filter (uid 1103): /"; u1=$(usec); echo "  filter CPU for it: $(pyc "($u1-$u0)/1e6") s"
  as 1102 load bulk -url "$SINK/bytes?n=300000000" | sed "s/^/down $i direct (uid 1102, the same class): /"
done
rss
a20=$(cls 1:20); a15=$(cls 1:15); a10=$(cls 1:10)
u0=$(usec); as 1103 load bulk -url "$SINK/sink" -up 300000000 | sed 's/^/up through the filter: /'; u1=$(usec); echo "  filter CPU for it: $(pyc "($u1-$u0)/1e6") s"
echo "  class 1:20 moved $(( $(cls 1:20) - a20 )) bytes, class 1:15 $(( $(cls 1:15) - a15 )), class 1:10 $(( $(cls 1:10) - a10 ))"
as 1102 load bulk -url "$SINK/sink" -up 300000000 | sed 's/^/up direct (uid 1102): /'
rss

echo "== E. many bulk transfers at once against MemoryMax ($(systemctl show -p MemoryMax --value desk-agent-filter) bytes), memory read while they run"
avail() { awk '/^MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo; }
summ() { awk -v t="$1" '/bytes in/ {n++; if ($0 ~ /err=<nil>/) ok++} END {printf "%s: %d whole of %d reported\n", t, ok, n}'; }
many() { # many <label> <count> <args to load bulk>
  restart; local a0; a0=$(avail)
  for i in $(seq 1 $2); do as 1103 load bulk "${@:3}" & done > /var/tmp/many.out 2>/dev/null
  sleep 2; echo "$1, during: $(rss), the box's MemAvailable $(( a0 - $(avail) )) MiB lower"; wait
  summ "$1" < /var/tmp/many.out; grep -v 'err=<nil>' /var/tmp/many.out | head -3; echo "  after: $(rss), restarts $(systemctl show -p NRestarts --value desk-agent-filter)"; }
many "30 x 100 MB down" 30 -url "$SINK/bytes?n=100000000"
many "64 x 10 MB down, the cap" 64 -url "$SINK/bytes?n=10000000"
many "100 x 5 MB down, past the cap" 100 -url "$SINK/bytes?n=5000000"
many "64 x 2 MB up, the cap, behind the shaper" 64 -url "$SINK/sink" -up 2000000

echo "== F. time to first byte: a new connection each, name lookup to first response byte, direct (uid 1102) and through the filter (uid 1103) in alternating blocks"
restart
pct() { python3 -I -c "
import sys
xs=sorted(float(l) for l in open(sys.argv[1]))
n=len(xs); print(f'n={n} p50={xs[n//2]:.2f} ms p95={xs[int(n*.95)]:.2f} ms max={xs[-1]:.2f} ms')" "$1"; }
rm -f /var/tmp/r.*
ttfb() { for b in $(seq 1 $3); do
    as 1102 load ttfb ${6:-} -url "$2" -n $4 -gap $5 -raw /var/tmp/r.$1.direct >/dev/null
    as 1103 load ttfb ${6:-} -url "$2" -n $4 -gap $5 -raw /var/tmp/r.$1.filter >/dev/null
  done
  echo "$1 direct (uid 1102):          $(pct /var/tmp/r.$1.direct)"; echo "$1 through the filter (uid 1103): $(pct /var/tmp/r.$1.filter)"; }
chmod 1777 /var/tmp
ttfb stand-in $SINK/ttfb 6 50 50ms
ttfb anthropic https://api.anthropic.com/v1/models 10 20 300ms -verify
ttfb openai https://api.openai.com/v1/models 10 20 300ms -verify
ttfb xai https://api.x.ai/v1/models 10 20 300ms -verify
cp /var/tmp/r.* /var/tmp/m4-raw/ 2>/dev/null || { mkdir -p /var/tmp/m4-raw; cp /var/tmp/r.* /var/tmp/m4-raw/; }

echo "== G. a fresh filter's idle: the lab name taken out, no traffic, 600 s"
cp /var/tmp/hosts.orig /etc/hosts; cp /var/tmp/conf.orig /etc/ma/agent-egress.conf
restart; sleep 30; rss
sw() { cat /proc/$(pid)/task/*/status | awk '/ctxt_switches/ {s+=$2} END {print s}'; }
p0=$(pid); u0=$(usec); s0=$(sw); read -r _ _ _ _ _ _ _ _ _ _ _ _ _ ut st _ < /proc/$p0/stat
sleep 600
u1=$(usec); s1=$(sw); read -r _ _ _ _ _ _ _ _ _ _ _ _ _ ut2 st2 _ < /proc/$p0/stat
[ "$(pid)" = "$p0" ] && echo "the same process throughout ($(systemctl show -p NRestarts --value desk-agent-filter) restarts by systemd)" || echo "IT RESTARTED: this idle result is void"
echo "idle 600 s: unit CPU $(( u1 - u0 )) us ($(pyc "($u1-$u0)/600e6*100") % of a core); clock ticks $(( ut2 + st2 - ut - st )); context switches $(( s1 - s0 ))"; rss
echo "== other load on the box at the end: $(uptime | sed 's/.*load average/load average/')"
echo "measure: done $(date -u +%FT%TZ)"
