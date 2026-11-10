# ADR 0036 section 6 test 4: the real desk-egress, with lowered thresholds in egress.conf. PHASE picks one part:
#   bucket    empties under an upload, slows 1:20 and 1:15, and real pages load with it empty (normal first, for comparison)
#   reopen    with a fast refill it reopens by itself
#   clamp     rtc past clamp_day_gb clamps 1:10 to 1 Mbit, and a raised line lifts it
#   profile   a live desk-stream (stand-in viewer) steps to capped, then deep, each with one short pause
#   restart   desk-stream restarted under a viewer recovers: three plain try-restarts
#   state     what desk-egress holds now (before and after lab.sh reboot or stop-start)
#   rollover  a saved state from last month starts this month at 0
#   reset     the shipped egress.conf and no state
. /var/tmp/lab/lab/throttle/tests/common.sh
PHASE=${PHASE:?}
SITES=${SITES:-https://en.wikipedia.org/wiki/Special:Random https://www.gnu.org/philosophy/philosophy.html https://news.ycombinator.com/ https://www.debian.org/}
echo "=== $BOX ($TYPE), phase $PHASE, $(date -u +%FT%TZ)"
journal() { journalctl -u desk-egress --since "@$1" --no-pager -o short-unix | sed -E 's/^([0-9]+)\.[0-9]+ [^:]+: /\1 /' | awk -v t0="$1" '{ $1 = "+" ($1 - t0) "s"; print "  journal:", $0 }'; }
rates() { tc -j class show dev $DEV | jq -r '[.[]|select(.class=="htb")|"\(.handle) \(.rate*8/1e6) Mbit"]|join(", ")'; }
watch_() { # watch_ <secs>: every 5 s, each class's rate setting and what it carried
  local i a b; for i in $(seq 5 5 "$1"); do a=$(snap); sleep 5; b=$(snap)
    python3 -I - "$a" "$b" "$i" <<'P'
import json, sys
a, b, t = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
print(f"  +{t}s " + "  ".join(f"{h} set {b[h]['rate'] / 1e6:g} carried {(b[h]['bytes'] - a[h]['bytes']) * 8 / 5e6:7.2f} Mbps" for h in sorted(b)))
P
  done; }
fresh() { systemctl stop desk-egress; rm -f /data/desk-egress/state.json; systemctl start desk-egress; sleep 1; }
[ -s /var/tmp/motion.html ] || { echo '<!doctype html><title>motion</title><body style="margin:0"><div id="d" style="width:1920px;height:1080px"></div><script>let i=0;function f(){d.style.background='"'"'hsl('"'"'+(i++%360)+'"'"',80%,50%)'"'"';requestAnimationFrame(f)}f()</script>' > /var/tmp/motion.html; chmod 644 /var/tmp/motion.html; }
browser() { systemctl start desk-browser; for i in $(seq 1 90); do curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done; sleep 3; }
case $PHASE in
bucket)
  egress_conf tick_seconds=5 bucket_gb=0.3; fresh; T=$(date +%s)
  browser
  echo "--- pages with the bucket full ($(rates))"; python3 -I $L/tests/cdpload.py $SITES | sed 's/^/  /'
  echo "--- kiosk uploads, internet MSS, for 60 s"; as 1102 $NET tcp-up $PEER 5002 60 > /tmp/up & watch_ 60; wait; sed 's/^/  upload: /' /tmp/up
  echo "--- pages with the bucket empty ($(rates))"; python3 -I $L/tests/cdpload.py $SITES | sed 's/^/  /'
  echo "--- the same, with an upload running beside them"; as 1102 $NET tcp-up $PEER 5002 100 > /tmp/up & sleep 3
  python3 -I $L/tests/cdpload.py $SITES | sed 's/^/  /'; kill %1 2>/dev/null; wait; sed 's/^/  upload: /' /tmp/up
  jq -c '{level, slowed, month_bytes}' /data/desk-egress/state.json | sed 's/^/  state: /'
  journal $T ;;
reopen)
  T=$(date +%s); egress_conf tick_seconds=5 bucket_gb=0.3 refill_mbps=40 reopen_gb=0.05; systemctl restart desk-egress
  echo "  at restart: $(rates); state $(jq -c '{level, slowed}' /data/desk-egress/state.json)"; watch_ 30
  jq -c '{level, slowed}' /data/desk-egress/state.json | sed 's/^/  state: /'; journal $T ;;
clamp)
  egress_conf tick_seconds=5 clamp_day_gb=0.2 clamp_day_release_gb=0.1; fresh; T=$(date +%s)
  echo "--- rtc sends 50 Mbps from 443 for 60 s"; job=$(sink_start 9000 63); as_rtc $NET udp-send $PEER 9000 50 60 --sport 443 > /tmp/s & watch_ 60; wait
  sed 's/^/  sender: /' /tmp/s | cut -c1-100; sink_result $job | cut -c1-200 | sed 's/^/  sink: /'
  echo "--- the line raised to 10 GB, release 5: restart"; egress_conf tick_seconds=5 clamp_day_gb=10 clamp_day_release_gb=5; systemctl restart desk-egress; sleep 7
  echo "  $(rates); state $(jq -c '{clamped}' /data/desk-egress/state.json)"; journal $T ;;
profile)
  egress_conf tick_seconds=5 capped_day_gb=0.15 deep_day_gb=0.4 deep_day_release_gb=0.3; fresh; T=$(date +%s)
  systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null
  browser; curl -s -X PUT 'http://127.0.0.1:9222/json/new?file:///var/tmp/motion.html' >/dev/null
  as 1101 python3 -I $L/tests/fakertc2.py 150 > /tmp/f2 & F=$!; sleep 1
  systemctl start desk-stream; sleep 5
  echo "  profile $(cat /run/desk-egress/profile), desk-stream $(systemctl is-active desk-stream)"
  echo "--- rtc sends 50 Mbps from 443: 0.15 GB is capped (about 24 s), 0.4 GB deep (about 64 s)"
  job=$(sink_start 9000 93); as_rtc $NET udp-send $PEER 9000 50 90 --sport 443 > /tmp/s & watch_ 90; wait $!
  sink_result $job >/dev/null; echo "  profile now $(cat /run/desk-egress/profile)"; sleep 10; wait $F
  python3 -I - <<'P'
import json
o = json.loads(open("/tmp/f2").read().splitlines()[-1])
for i, c in enumerate(o["connections"]):
    print(f"  desk-stream connection {i + 1}: at {c['connect'] / 1000:.1f} s, first keyframe +{(c['firstKey'] or 0) - c['connect']:.0f} ms, "
          f"video {c['v']} packets, {c['fps']} frames/s, {c['mbps']} Mbps, ended {c['eof'] and round(c['eof'] / 1000, 1)} s")
print("  pause the viewer saw at each change (last packet of the old process to the new one's first keyframe):", o["gapsMs"], "ms")
P
  journalctl -u desk-stream --since "@$T" --no-pager -o cat | grep 'pipeline:' | grep -o -E 'quantizer=[0-9]+|bitrate=[0-9]+|width=[0-9]+,height=[0-9]+' | paste -sd' ' | sed 's/^/  pipelines in order: /'
  journal $T ;;
restart)
  systemctl stop desk-stream; systemctl reset-failed desk-stream 2>/dev/null; browser
  curl -s -X PUT 'http://127.0.0.1:9222/json/new?file:///var/tmp/motion.html' >/dev/null
  as 1101 python3 -I $L/tests/fakertc2.py 40 > /tmp/f2 & F=$!; sleep 1; systemctl start desk-stream
  for i in 1 2 3; do sleep 8; systemctl --no-block try-restart desk-stream.service; done; wait $F
  tail -1 /tmp/f2 | jq -c '{gapsMs, connections: [.connections[] | {connect, firstKeyAfterMs: (.firstKey - .connect), fps}]}'
  systemctl stop desk-stream ;;
state)
  echo "  boot $(cut -c1-8 /proc/sys/kernel/random/boot_id), up $(cut -d' ' -f1 /proc/uptime) s; desk-egress $(systemctl is-active desk-egress) since $(( $(systemctl show -p ActiveEnterTimestampMonotonic --value desk-egress) / 1000 )) ms after boot"
  echo "  deskd and desk-rtc order after it: $(systemctl show -p After --value deskd | grep -o desk-egress.service), $(systemctl show -p After --value desk-rtc | grep -o desk-egress.service)"
  echo "  rates: $(rates); profile file: $(cat /run/desk-egress/profile 2>&1)"
  jq -c '{boot: .boot[0:8], level, slowed, clamped, day_deep, profile, month, month_bytes, windows: (.windows|length)}' /data/desk-egress/state.json | sed 's/^/  state: /'
  journalctl -u desk-egress -b --no-pager -o cat | head -5 | sed 's/^/  this boot: /' ;;
rollover)
  systemctl stop desk-egress
  jq -c '.month = "2026-10" | .month_bytes = 600000000000' /data/desk-egress/state.json > /tmp/s.json && cp /tmp/s.json /data/desk-egress/state.json
  echo "  saved, as if from October: $(jq -c '{month, month_bytes, profile}' /data/desk-egress/state.json)"
  T=$(date +%s); systemctl start desk-egress; sleep 8
  echo "  after a tick: $(jq -c '{month, month_bytes, profile}' /data/desk-egress/state.json)"; journal $T ;;
reset)
  egress_conf; fresh; echo "  $(rates); profile $(cat /run/desk-egress/profile)"; systemctl stop desk-stream desk-browser 2>/dev/null; true ;;
esac
