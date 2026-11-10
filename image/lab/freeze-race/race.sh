#!/bin/bash
# race.sh <case> [runs]: the Security Analyst's T46L-1 on the lab box, as root from /var/tmp/lab (lab.sh push-recipe, then
# apply.sh old|new). A freeze that lands while desk-browser-thaw's stop is quitting Chromium holds it mid-quit, and systemd then
# kills it without its session (ADR 0035). Each run sets a cookie 8 s before the stop (inside Chromium's 30 s cookie commit,
# so only a clean quit writes it), makes the race, then starts Chromium again and reads the cookie. One RESULT line a run.
#   queued    a stop of desk-browser held queued 3 s behind a unit ordered to stop first; a freeze asked 0.5 s in
#   stop      a freeze asked, then systemctl stop while its 0.5 s network window runs, so the stop is queued after the freeze's
#             first look and Chromium is still quitting when the freeze writes (run n waits DELAYS[n] s; a quit here takes
#             about 0.3 s, and a Chromium gone before the window ends makes the freeze busy network, so the delays are late)
#   restart   the same with systemctl restart
#   midquit   systemctl stop, and 1 written into cgroup.freeze as soon as desk-browser-close --quit has sent Browser.close (a
#             freeze that got past everything else; desk-browser-close's per-pass thaw is what undoes it)
#   times     freeze and thaw as in verify.sh 3b2a item 3: 20 cycles, request times and thaw to the first page frame
#   reboot-inflight | reboot-hammer | reboot-midquit   set up the race and reboot from inside (the run ends with the box):
#             inflight: a freeze asked 0.25 s before systemctl reboot; hammer: uid 1100 asks for a freeze every 100 ms
#             through the whole shutdown, from a unit the shutdown doesn't stop; midquit: 1 into cgroup.freeze once
#             desk-browser-close --quit has sent Browser.close, from such a unit
#   after-reboot   judge the shutdown before anything starts Chromium (exit_type, the previous boot's journal), then the cookie
# The box's hostname (its private address) is cut from journal lines: they're read with -o cat or with the host replaced.
set -uo pipefail
L=/var/tmp/lab
CG=/sys/fs/cgroup/system.slice/desk-browser.service
fz() { python3 -I $L/fz.py "$@"; }
ask() { setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I $L/fz.py ask "$1" 2>>$L/ask-times.txt | tail -1; }
up() { for _ in $(seq 1 120); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; return 1; }
frozen() { sed -n 's/^frozen //p' $CG/cgroup.events 2>/dev/null; }
pages() { systemctl is-active --quiet lab-fz-pages || systemd-run --quiet --collect --unit=lab-fz-pages --uid=65534 --gid=65534 /usr/bin/python3 -I $L/fz.py serve; sleep 1; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
jr() { journalctl --no-pager -o short-monotonic "$@" | sed -E 's/^(\[[ 0-9.]+\]) [^ ]+ /\1 /'; }
killed() { journalctl --no-pager -o cat -u desk-browser "$@" | grep -E 'Killing|timed out|Failed with result|Cannot stop frozen' | tr '\n' ' '; }
quitline() { journalctl --no-pager -o cat -u desk-browser-thaw "$@" | grep -E '^desk-browser-(quit|close --quit):' | tail -1; }
exit_type() { jq -r .profile.exit_type /data/browser/profile/Default/Preferences 2>/dev/null; }
start_browser() { systemctl is-active --quiet desk-browser || systemctl start desk-browser; up || echo "CDP never came up"; sleep 3; }
cookie() { local out; out=$(fz cookie "$1" x 2>&1); [ "$(tail -1 <<<"$out")" = ok ] && echo kept || { echo "LOST ($(grep -o 'cookies on the page:.*' <<<"$out" | head -1))"; }; }
fresh() { V=v$RANDOM$RANDOM; fz setcookie $V >/dev/null; echo $V > $L/cookie; sleep 8; }
wait_state() { for _ in $(seq 1 1200); do [ "$(systemctl is-active desk-browser)" = "$1" ] && return 0; sleep 0.1; done; return 1; }
# A stand-in for a freeze that gets past everything: root writes 1 once, as soon as the quit's CDP close (a python3 child of
# desk-browser-close --quit) has come and gone, so Browser.close has been sent and Chromium is quitting.
midquit_writer() {
  local c= seen=0 pid
  echo "writer waiting $(cut -d' ' -f1 /proc/uptime)"
  for _ in $(seq 1 3000); do c=$(pgrep -f 'desk-browser-close --qui[t]' | head -1); [ -n "$c" ] && break; sleep 0.005; done
  pid=$(pgrep -o -u kiosk -x chromium)   # the browser process, the oldest; no systemctl, which is slow in a shutdown
  for _ in $(seq 1 2000); do if pgrep -P "$c" -x python3 >/dev/null; then seen=1; elif [ $seen = 1 ] || ! kill -0 "$c" 2>/dev/null; then break; fi; done
  echo 1 > $CG/cgroup.freeze 2>/dev/null && echo "at $(cut -d' ' -f1 /proc/uptime) wrote 1 $( [ $seen = 1 ] && echo "after Browser.close was sent" || echo "with the CDP close not seen"), Chromium $( [ "$pid" != 0 ] && kill -0 "$pid" 2>/dev/null && echo alive || echo gone)" || echo "no cgroup to write"
}

DELAYS=(0 0.35 0.40 0.45 0.48 0.50 0.42 0.38 0.46 0.44 0.52)
one() { # one <case> <n>
  local c=$1 n=$2 t r w=- k q e d=${DELAYS[$(( $2 % 11 ))]}
  start_browser; pages; fresh
  case $c in
    queued)
      systemctl stop lab-hold 2>/dev/null
      systemd-run --quiet --unit=lab-hold -p After=desk-browser-thaw.service -p PartOf=desk-browser.service -p "ExecStop=/bin/sleep 3" --remain-after-exit /bin/true
      t=$(date +%s%N); systemctl stop --no-block desk-browser; sleep 0.5
      r=$(ask 'freeze desk-browser'); w="frozen after the answer: $(frozen), jobs: $(systemctl list-jobs --no-legend | awk '{print $2"/"$3"/"$4}' | tr '\n' ' ')"
      wait_state inactive ;;
    stop | restart)
      t=$(date +%s%N); ask 'freeze desk-browser' > $L/r & sleep $d
      systemctl $c desk-browser; wait; r=$(cat $L/r); w="stop asked $d s after the freeze" ;;
    midquit)
      t=$(date +%s%N); midquit_writer > $L/w & systemctl stop desk-browser; wait; w=$(cat $L/w) ;;
  esac
  local took; took=$(ms $t); sleep 0.5   # journald takes the units' own lines a moment later
  k=$(killed --since "@$(( t / 1000000000 - 1 ))"); q=$(quitline --since "@$(( t / 1000000000 - 1 ))")
  [ $c = restart ] && e=- || e=$(exit_type)
  start_browser; local ck; ck=$(cookie $V)
  local verdict=ok; [ -z "$k" ] && [ "$ck" = kept ] && case "$e" in - | Normal | SessionEnded) true ;; *) false ;; esac || verdict=BAD
  echo "RESULT $c $n $verdict: freeze said '${r:--}'; $w; stop took $took ms; exit_type $e; kill/timeout: '${k:-none}'; $q; cookie $ck"
}

case "${1:-}" in
queued | stop | restart | midquit) for i in $(seq 1 "${2:-1}"); do one "$1" "$i"; done ;;
times)
  start_browser; pages
  read FRAME _ < <(fz open /frame fz-frame); sleep 2
  : > /var/tmp/px.log; setpriv --reuid=1102 --regid=1102 --clear-groups env DISPLAY=:99 python3 -I $L/fz.py pixels 960 540 100 >> /var/tmp/px.log 2>&1 & PX=$!
  sleep 2; setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I $L/fz.py thawtime 20 /var/tmp/px.log 1.0 300 2>&1
  kill $PX 2>/dev/null; wait $PX 2>/dev/null; fz close "$FRAME" ;;
reboot-inflight | reboot-hammer | reboot-midquit)
  start_browser; pages; fresh; rm -f /var/tmp/lab-hammer.log /var/tmp/lab-midquit.log
  echo "${1#reboot-}" > $L/reboot-case; echo "deskd before the reboot: $(systemctl is-active deskd)"
  case $1 in
    reboot-inflight) ask 'freeze desk-browser' > /var/tmp/lab-inflight.log & sleep 0.25 ;;
    reboot-hammer)
      systemd-run --quiet --unit=lab-hammer -p DefaultDependencies=no --uid=1100 --gid=1100 /usr/bin/python3 -I $L/hammer.py /var/tmp/lab-hammer.log
      sleep 0.2 ;;
    reboot-midquit)
      systemd-run --quiet --unit=lab-midquit -p DefaultDependencies=no /bin/bash -c "$(declare -f midquit_writer); CG=$CG; midquit_writer > /var/tmp/lab-midquit.log 2>&1; sync"
      sleep 0.2 ;;
  esac
  { busctl --system --no-pager list 2>/dev/null | grep -c ' chromium ' ; systemd-inhibit --list --no-pager 2>/dev/null | grep -c Chromium; } | paste -sd/ > /var/tmp/lab-bus.txt   # connections/inhibitors
  echo "rebooting $(date -u +%T)"; systemctl reboot ;;
after-reboot)
  c=$(cat $L/reboot-case); e=$(exit_type)
  k=$(killed -b -1); q=$(quitline -b -1)
  j=$(jr -b -1 -u deskd -u desk-browser -u desk-browser-thaw | grep -E 'Stopping|Stopped|Deactivated|Killing|timed out|Failed')
  sd=$(grep -E 'Stopped deskd' <<<"$j" | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/'); st=$(grep 'Stopping desk-browser-thaw' <<<"$j" | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/')
  sb=$(grep -E 'desk-browser.service: Deactivated|Stopped desk-browser.service' <<<"$j" | tail -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/')
  inh=$(journalctl -b -1 --no-pager -o cat -u 'desk-units@*' | grep -E '^desk-units: freeze' | tail -3 | tr '\n' ' ')
  extra=; case $c in
    hammer) extra="hammer: $(sort /var/tmp/lab-hammer.log 2>/dev/null | cut -d' ' -f2- | sort | uniq -c | sort -rn | head -5 | awk '{$1=$1}1' | tr '\n' ';')" ;;
    midquit) extra="writer: $(tr '\n' ' ' < /var/tmp/lab-midquit.log 2>/dev/null)" ;;
    inflight) extra="freeze said: $(tail -1 /var/tmp/lab-inflight.log 2>/dev/null)" ;;
  esac
  echo "$j" | tail -12
  start_browser; pages; ck=$(cookie "$(cat $L/cookie)")
  verdict=ok; [ -z "$k" ] && [ "$ck" = kept ] && case "$e" in Normal | SessionEnded) true ;; *) false ;; esac || verdict=BAD
  echo "RESULT reboot-$c $verdict: exit_type $e; kill/timeout: '${k:-none}'; deskd stopped at ${sd:-none}, desk-browser-thaw began stopping at ${st:-none}, desk-browser down at ${sb:-none}; $q; $extra; last freezes: ${inh:-none}; Chromium on the system bus: $(cat /var/tmp/lab-bus.txt 2>/dev/null); cookie $ck" ;;
*) sed -n 2,20p "$0"; exit 2 ;;
esac
