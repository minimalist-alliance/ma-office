# ADR 0036 [A] section 2: a stream packet waits under 1 ms behind other classes, and the shaper costs microseconds a packet.
# The stream stand-in is rtc's UDP from 443, 1200-byte packets, every 20th echoed by the sink for a round trip. 8.3 Mbps is
# one viewer at the cap, 41 Mbps four. Rows as section 6 test 1, without the real stack: no shaper, idle, kiosk saturating,
# kiosk and deskd saturating, and slowed (1:20 at 0.75 Mbit, 1:15 at 0.25) with an upload running. REPEATS (default 3).
. /var/tmp/lab/lab/throttle/tests/common.sh
SECS=${SECS:-15}; REPEATS=${REPEATS:-3}
echo "=== $BOX ($TYPE) sends, the other box receives, one subnet. $SECS s a run, $REPEATS repeats, $(date -u +%FT%TZ)"
load() { # load <kind>: background senders for SECS+2 s
  case $1 in
    kiosk) as 1102 $NET tcp-up $PEER 5002 $((SECS + 2)) > /tmp/l1 & ;;
    both) as 1102 $NET tcp-up $PEER 5001 $((SECS + 2)) > /tmp/l1 & as 1100 $NET udp-send $PEER 9000 6 $((SECS + 2)) > /tmp/l2 & ;;
  esac
}
slowed() { systemctl stop desk-egress; tc class change dev $DEV parent 1: classid 1:20 htb rate 750kbit ceil 750kbit burst 256kb cburst 256kb prio 1 quantum 60000
  tc class change dev $DEV parent 1: classid 1:15 htb rate 250kbit ceil 250kbit prio 0 quantum 60000; }
row() { # row <name> <mbps> <load>
  local job a b c0 c1; job=$(sink_start 9000 $((SECS + 3))); load "$3"; sleep 1
  a=$(snap); c0=$(cpusnap)
  local r; r=$(as_rtc $NET udp-send $PEER 9000 "$2" "$SECS" --sport 443 --echo-every 20)
  c1=$(cpusnap); b=$(snap); wait
  echo "== $1, stream $2 Mbps: $(echo "$r" | jq -c '{sent, blocked, echoBack, rttMs}')"
  sink_result "$job" | jq -c 'to_entries[] | select(.key == "from port 443") | .value' | sed 's/^/   sink, stream: /'
  [ -s /tmp/l1 ] && sed 's/^/   load: /' /tmp/l1; rm -f /tmp/l1 /tmp/l2
  [ "$(tc qdisc show dev $DEV root | cut -d' ' -f2)" = htb ] && classes "$a" "$b" "$SECS" | sed 's/^ / /'
  cpudiff "$c0" "$c1"
}
for rep in $(seq 1 "$REPEATS"); do
  for mbps in 8.3 41; do
    echo "--- repeat $rep, $mbps Mbps"
    shaper_off >/dev/null; row "no shaper (mq and fq_codel, image 0.2.3)" $mbps none
    shaper_on >/dev/null; row "shaper idle" $mbps none
    row "shaper, kiosk saturating 1:20 (internet MSS)" $mbps kiosk
    row "shaper, kiosk (big segments) saturating 1:20 and deskd 1:15" $mbps both
    slowed; row "slowed, kiosk upload running" $mbps kiosk
    systemctl start desk-egress; sleep 2
  done
done
shaper_on
