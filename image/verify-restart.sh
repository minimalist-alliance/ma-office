#!/bin/bash
# verify-restart.sh <part>: restart back-off and the kill order under memory pressure on a booted desk (reliability audit S1 and S2;
# image/README.md, "Restarts and memory pressure"; docs/interfaces/desk-runtime.md). verify.sh pipes this to root on the box once per
# part (bash -s -- <part>), and it runs the same on any lab box. It prints BAD <what> and FAILED for each failure, and "ran to
# the end" last. Run with RESTART_FAST=1 for the short back-off run (three kills, no reset half), which is what the mutant uses.
#   static    every long-running unit's Restart=, RestartSteps=, RestartMaxDelaySec=, no start limit, and OOMScoreAdjust= as the table
#             says; the reset timer enabled; the helper's pieces there
#   oom       the running services' own /proc/<pid>/oom_score_adj, the Docker-run ones' container processes included, and the Browser's
#             renderers above everything else; ordered renderers > desk-agent > desk-stream > browser > notebook > rtc = deskd
#   backoff   deskd is killed (docker kill) five times in a row: the wait before each start grows, from about 3 s toward 30 s; then
#             after two minutes without a break the timer starts it over, and the next kill is back to about 3 s. Never a start limit:
#             deskd is running again at the end, and the box is left as it was
#   hog [protected|control|deep]   lab only, not in verify.sh: a 1.5 GB process (2.8 GB for the control) and the kernel's OOM killer run by hand; what went first,
#             and that deskd, desk-rtc and desk-notebook and the Browser stayed
set -u
part=${1:-}
bad() { echo "BAD: $*"; echo FAILED; }
now() { date +%s.%N; }
# table: unit adj cap
TABLE="deskd:-500:300 desk-rtc:-500:300 desk-notebook:-200:300 desk-agent:200:300 desk-stream:100:300 commons-server:-200:300 desk-agent-filter::300 desk-egress::300 desk-browser:0:30 desk-xorg:0:30 desk-audio:0:30"
cpid() { docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null; }
procs_of() { # every pid in the container's cgroup, or the unit's main pid
  local pid=$1 cg; cg=$(sed -n 's/^0:://p' /proc/$pid/cgroup 2>/dev/null); cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null
}

case "$part" in
static)
  for row in $TABLE; do
    IFS=: read -r u adj cap <<<"$row"
    f=/etc/systemd/system/$u.service
    [ -f "$f" ] || { bad "$u: no unit file"; continue; }
    v=$(systemctl show -p Restart -p RestartSteps -p RestartMaxDelayUSec -p StartLimitIntervalUSec -p StartLimitBurst -p OOMScoreAdjust $u.service | paste -sd' ')
    echo "$u: $v"
    r=$(systemctl show -p Restart --value $u.service)
    [ "$r" = always ] || [ "$r" = on-failure ] || bad "$u: Restart=$r"
    [ "$(systemctl show -p RestartSteps --value $u.service)" -ge 1 ] 2>/dev/null || bad "$u: no RestartSteps"
    got=$(systemctl show -p RestartMaxDelayUSec --value $u.service)
    [ "$got" = "${cap}s" ] || [ "$got" = "$([ "$cap" = 300 ] && echo 5min || echo 30s)" ] || bad "$u: RestartMaxDelaySec is $got, not ${cap}s"
    [ "$(systemctl show -p StartLimitIntervalUSec --value $u.service)" = 0 ] || bad "$u: has a start limit ($(systemctl show -p StartLimitIntervalUSec --value $u.service)): a loop would leave it down for good"
    if [ -n "$adj" ]; then
      [ "$(systemctl show -p OOMScoreAdjust --value $u.service)" = "$adj" ] || bad "$u: OOMScoreAdjust is $(systemctl show -p OOMScoreAdjust --value $u.service), not $adj"
    fi
  done
  [ "$(systemctl show -p OOMPolicy --value desk-browser.service)" = continue ] || bad "desk-browser: OOMPolicy is $(systemctl show -p OOMPolicy --value desk-browser.service), not continue: one OOM-killed renderer would stop the whole Browser"
  for u in deskd desk-agent desk-notebook; do
    grep -qx "ExecStartPost=-/usr/local/lib/ma/desk-oom-container $u $(grep "^$u:" <<<"$(tr ' ' '\n' <<<"$TABLE")" | cut -d: -f2)" /etc/systemd/system/$u.service || bad "$u: no desk-oom-container ExecStartPost with its adj"
  done
  [ "$(systemctl is-enabled desk-restart-reset.timer 2>&1)" = enabled ] || bad "desk-restart-reset.timer isn't enabled"
  [ -x /usr/local/lib/ma/desk-restart-reset ] && [ -x /usr/local/lib/ma/desk-oom-container ] || bad "a helper is missing or not executable"
  ;;
oom)
  started=0
  if ! systemctl is-active --quiet desk-browser.service && ! test -e /run/ma/guild; then   # a member's desk: bring the Browser up to read its renderers, and put it back
    started=1; for u in desk-xorg desk-audio desk-browser; do systemctl start $u.service; done
    for i in $(seq 1 90); do pgrep -f -- --type=renderer >/dev/null && break; sleep 1; done
  fi
  declare -A want=( [desk-rtc]=-500 [desk-agent]=200 [desk-stream]=100 [desk-browser]=0 )
  for u in desk-rtc desk-browser desk-stream; do
    systemctl is-active --quiet $u.service || { echo "$u isn't running here: static only"; continue; }
    p=$(systemctl show -p MainPID --value $u.service); a=$(cat /proc/$p/oom_score_adj 2>&1)
    echo "$u main pid $p: oom_score_adj $a (want ${want[$u]})"
    [ "$a" = "${want[$u]}" ] || bad "$u: main process $p has oom_score_adj $a, not ${want[$u]}"
  done
  for row in deskd:-500 desk-agent:200 desk-notebook:-200; do
    u=${row%%:*}; w=${row##*:}
    systemctl is-active --quiet $u.service || { bad "$u isn't running"; continue; }
    cp=$(cpid $u); [ "${cp:-0}" -gt 0 ] 2>/dev/null || { bad "$u: no container"; continue; }
    n=0; for p in $(procs_of $cp); do a=$(cat /proc/$p/oom_score_adj 2>/dev/null); n=$((n+1)); [ "$a" = "$w" ] || bad "$u: container process $p ($(cat /proc/$p/comm 2>/dev/null)) has oom_score_adj $a, not $w"; done
    echo "$u: container pid $cp, $n process(es) in its cgroup, want $w"
    [ $n -ge 1 ] || bad "$u: no processes in the container's cgroup"
    m=$(systemctl show -p MainPID --value $u.service); a=$(cat /proc/$m/oom_score_adj 2>&1)
    [ "$a" = "$w" ] || bad "$u: the docker client $m has oom_score_adj $a, not $w"
  done
  # Chromium: the browser at 0, every renderer at 300 (Chromium's own), its gpu and network helpers at 200
  if systemctl is-active --quiet desk-browser.service; then
    cg=$(systemctl show -p ControlGroup --value desk-browser.service)
    r=0; rmin=; for p in $(cat /sys/fs/cgroup$cg/cgroup.procs); do
      cmd=$(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null); a=$(cat /proc/$p/oom_score_adj 2>/dev/null)
      case "$cmd" in *--type=renderer*) r=$((r+1)); echo "renderer $p: $a"; { [ "$a" -ge 300 ] 2>/dev/null; } || bad "renderer $p has oom_score_adj $a, under 300" ;; esac
    done
    [ $r -ge 1 ] || bad "no renderer to read (the Browser has no tab)"
  else echo "desk-browser isn't running here: renderers not read"; fi
  [ $started = 1 ] && for u in desk-browser desk-audio desk-xorg; do systemctl stop $u.service; done
  ;;
backoff)
  fast=${RESTART_FAST:-0}; kills=5; [ "$fast" = 1 ] && kills=3
  U=deskd
  systemctl restart $U.service || bad "can't restart $U"
  for i in $(seq 1 60); do [ "$(systemctl show -p NRestarts --value $U)" = 0 ] && [ "$(cpid $U)" -gt 0 ] 2>/dev/null && break; sleep 1; done
  d=(); old=$(cpid $U)
  for k in $(seq 1 $kills); do
    t0=$(now); docker kill $U >/dev/null 2>&1 || bad "kill $k: no container to kill"
    new=; for i in $(seq 1 700); do new=$(cpid $U); [ "${new:-0}" -gt 0 ] 2>/dev/null && [ "$new" != "$old" ] && break; new=; sleep 0.1; done
    [ -n "$new" ] || { bad "kill $k: $U didn't come back in 70 s ($(systemctl show -p ActiveState -p SubState -p NRestarts $U | paste -sd' '))"; break; }
    t1=$(now); d+=("$(echo "$t1 - $t0" | bc -l | cut -c1-5)"); old=$new
    echo "kill $k: container back after ${d[-1]} s (NRestarts $(systemctl show -p NRestarts --value $U))"
  done
  [ ${#d[@]} -eq $kills ] || bad "only ${#d[@]} of $kills restarts measured"
  grow=1; for k in $(seq 1 $((${#d[@]}-1))); do
    awk -v a="${d[$((k-1))]}" -v b="${d[$k]}" 'BEGIN{exit !(b >= a + 1.5)}' || { bad "wait $((k+1)) (${d[$k]} s) isn't at least 1.5 s longer than wait $k (${d[$((k-1))]} s)"; grow=0; }
  done
  awk -v a="${d[0]:-99}" 'BEGIN{exit !(a <= 7)}' || bad "the first wait (${d[0]:-none} s) is over 7 s: RestartSec is 3 s plus the container's start"
  last=${d[-1]:-0}; awk -v a="${d[0]:-99}" -v b="$last" 'BEGIN{exit !(b >= 2*a + 3)}' || bad "after $kills kills the wait ($last s) is not twice the first plus 3 s: no back-off"
  echo "waits: ${d[*]}"
  if [ "$fast" != 1 ]; then
    # a healthy run starts it over: desk-restart-reset.timer, every 30 s, resets a unit active for 120 s. Nothing here calls the helper.
    t0=$(now); okr=0
    for i in $(seq 1 90); do [ "$(systemctl show -p NRestarts --value $U)" = 0 ] && { okr=1; break; }; sleep 2; done
    t1=$(now); echo "NRestarts back to 0 $(echo "$t1 - $t0" | bc -l | cut -c1-6) s after the last restart (the timer's pass, 120 s of health plus up to 35 s)"
    [ $okr = 1 ] || bad "the back-off wasn't reset in 180 s of health"
    old=$(cpid $U); t0=$(now); docker kill $U >/dev/null 2>&1
    new=; for i in $(seq 1 700); do new=$(cpid $U); [ "${new:-0}" -gt 0 ] 2>/dev/null && [ "$new" != "$old" ] && break; new=; sleep 0.1; done
    t1=$(now); after=$(echo "$t1 - $t0" | bc -l | cut -c1-5); echo "kill after the reset: back after $after s"
    [ -n "$new" ] && awk -v a="$after" 'BEGIN{exit !(a <= 7)}' || bad "after a healthy run the wait was $after s, not back to about 3 s"
  fi
  for i in $(seq 1 120); do RELEASE_DIR=/opt/ma/$U/current timeout 20 /opt/ma/$U/current/health >/dev/null 2>&1 </dev/null && break; sleep 1; done
  RELEASE_DIR=/opt/ma/$U/current timeout 20 /opt/ma/$U/current/health >/dev/null 2>&1 </dev/null || bad "$U isn't healthy at the end: never a start limit that leaves a desk down"
  systemctl is-active --quiet $U.service || bad "$U isn't active at the end"
  systemctl restart $U.service   # a manual start: its count is 0 again
  ;;
hog)
  # Lab only (it kills things); verify.sh doesn't run it. Memory pressure on this box's own processes, and the kernel's own choice of
  # victim: an ordinary process holds 1.5 GB resident (2.8 GB in the control), and the kernel's OOM killer is run by hand (sysrq f, which picks exactly as a real OOM
  # does: the highest oom_score) N times, two seconds apart. A real exhaustion was tried first (evidence/restart-oom-2026-11-10/): it
  # killed one renderer and then the hog, and with the box's zram swap off or on it often stopped answering for minutes before the kernel
  # chose anyone, which is why this drives the choice. Modes: `protected` (hog at -600, 4 kills), `deep` (hog at -900, 6 kills) and
  # `control` (hog at 0, 1 kill: the largest process goes first, as the kernel always did).
  mode=${2:-protected}; hadj=-600; kills=4; hogmb=1536
  [ "$mode" = deep ] && { hadj=-900; kills=6; }; [ "$mode" = control ] && { hadj=0; kills=1; hogmb=2800; }   # adj counts in thousandths of the box's memory: a renderer at +300 outranks an ordinary process up to about 1.1 GB larger on 3.8 GB, so the control needs 2.8 GB
  [ -w /proc/sysrq-trigger ] || { bad "no /proc/sysrq-trigger"; echo "ran to the end"; exit 0; }
  for u in desk-xorg desk-audio; do systemctl start $u.service; done
  systemctl restart desk-browser.service   # fresh renderers every time: an earlier mode's kills leave a tab with none
  for i in $(seq 1 60); do [ "$(pgrep -f -- --type=renderer | wc -l)" -ge 2 ] && break; sleep 1; done
  sleep 5
  snap() { for p in $(pgrep -f -- 'chromium|java|node|desk-rtc|desk-stream|Xorg|pulseaudio'); do printf '%s %s adj=%s score=%s rss_mb=%s\n' "$p" "$(cat /proc/$p/comm)" "$(cat /proc/$p/oom_score_adj)" "$(cat /proc/$p/oom_score)" "$(( $(awk '/VmRSS/{print $2}' /proc/$p/status) / 1024 ))"; done 2>/dev/null; }
  P_DESKD=$(cpid deskd); P_RTC=$(systemctl show -p MainPID --value desk-rtc.service); P_NB=$(cpid desk-notebook); P_AG=$(cpid desk-agent); P_BR=$(systemctl show -p MainPID --value desk-browser.service)
  cat > /var/tmp/hog.py <<'P'
import sys, time
b = bytearray(int(sys.argv[1]) * 1024 * 1024)
for i in range(0, len(b), 4096):
    b[i] = 1          # every page resident
time.sleep(120)
P
  systemctl reset-failed restart-oom-hog.service 2>/dev/null
  systemd-run --quiet --unit=restart-oom-hog --property=OOMScoreAdjust=$hadj --property=Restart=no python3 /var/tmp/hog.py $hogmb
  sleep 8
  echo "--- before: memory"; free -m | sed -n 1,2p
  echo "--- before: the processes the order is about (pid comm adj score rss), highest score first; the hog is $(pgrep -f /var/tmp/hog.py | head -1) at $hadj"
  { snap; p=$(pgrep -f /var/tmp/hog.py | head -1); printf '%s hog adj=%s score=%s rss_mb=%s\n' "$p" "$(cat /proc/$p/oom_score_adj)" "$(cat /proc/$p/oom_score)" "$(( $(awk '/VmRSS/{print $2}' /proc/$p/status) / 1024 ))"; } | grep -v 'crashpad\|zygote' | sort -t= -k3 -n -r | head -14
  kmark=$(date +%s)
  oldsysrq=$(cat /proc/sys/kernel/sysrq); echo 1 > /proc/sys/kernel/sysrq   # restored below: Debian's default doesn't allow the OOM key
  for k in $(seq 1 $kills); do echo f > /proc/sysrq-trigger; sleep 2; done
  echo "$oldsysrq" > /proc/sys/kernel/sysrq
  sleep 3
  echo "--- the kernel's kills, in order (hog at $hadj, mode $mode)"
  journalctl -k --since "@$kmark" --no-pager -o cat | grep -E 'Out of memory: Killed process' | sed -E 's/^.*(Killed process [0-9]+ \([^)]*\)).*anon-rss:([0-9]+)kB.*oom_score_adj:(-?[0-9]+).*$/\1 oom_score_adj:\3 anon-rss:\2 kB/' | tee /var/tmp/hog-kills.txt
  systemctl stop restart-oom-hog.service 2>/dev/null
  sleep 20
  echo "--- after"
  alive() { [ -n "$1" ] && [ -d "/proc/$1" ] && echo "survived (pid $1)" || echo "gone (pid $1)"; }
  echo "deskd:         $(alive $P_DESKD)"; echo "desk-rtc:      $(alive $P_RTC)"; echo "desk-notebook: $(alive $P_NB)"; echo "desk-agent:    $(alive $P_AG)"; echo "browser main:  $(alive $P_BR)"
  echo "back by themselves: $(for u in desk-agent desk-browser deskd desk-rtc desk-notebook; do printf '%s=%s ' $u $(systemctl is-active $u.service); done)"
  [ -d "/proc/$P_DESKD" ] || bad "deskd was killed"
  [ -d "/proc/$P_RTC" ] || bad "desk-rtc was killed"
  [ -d "/proc/$P_NB" ] || bad "desk-notebook was killed"
  [ -d "/proc/$P_BR" ] || bad "the Browser's main process went (it should outlive its renderers)"
  n=$(wc -l < /var/tmp/hog-kills.txt); [ "$n" -ge "$kills" ] || bad "the kernel made $n of $kills kills"
  if [ "$mode" = control ]; then
    head -1 /var/tmp/hog-kills.txt | grep -q 'python3' || bad "the control hog (adj 0, 1.5 GB) wasn't the first victim: $(head -1 /var/tmp/hog-kills.txt)"
  else
    head -1 /var/tmp/hog-kills.txt | grep -q 'adj:300' || bad "the first victim wasn't a Chromium renderer (300): $(head -1 /var/tmp/hog-kills.txt)"
    grep -q 'adj:-500\|adj:-200' /var/tmp/hog-kills.txt && bad "a protected process was killed (-500 or -200 in the list)"
  fi
  ;;
*) echo "usage: verify-restart.sh static|oom|backoff|hog"; exit 2 ;;
esac
echo "ran to the end"
