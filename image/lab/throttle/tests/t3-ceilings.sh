# ADR 0036 section 6 test 2: each class holds its ceiling, alone and all at once (162 Mbps in all), and the stream's 1 MB
# burst lets four viewers' keyframes out at line rate. Also the read claim in section 2, "not run": an HTB bucket holds at
# most 275 s of its rate, so no kernel burst can hold `day`.
. /var/tmp/lab/lab/throttle/tests/common.sh
echo "=== $BOX ($TYPE), $(date -u +%FT%TZ)"
tc -d class show dev $DEV | sed 's/^/  /'
one() { # one <name> <secs> <command...>
  local n=$1 s=$2; shift 2; local job a b; job=$(sink_start 9000 $((s + 3))); a=$(snap); "$@" | cut -c1-120 | sed 's/^/  sender: /'; b=$(snap)
  echo "== $n"; classes "$a" "$b" "$s"; sink_result "$job" | cut -c1-200 | sed 's/^/  sink: /'
}
one "1:10 alone: rtc UDP from 443 at 90 Mbps for 10 s (ceiling 60)" 10 as_rtc $NET udp-send $PEER 9000 90 10 --sport 443
one "1:15 alone: desk UDP at 6 Mbps for 10 s (ceiling 2)" 10 as 1100 $NET udp-send $PEER 9000 6 10
one "1:20 alone: kiosk UDP at 150 Mbps for 10 s (ceiling 100)" 10 as 1102 $NET udp-send $PEER 9000 150 10
one "1:20 alone: kiosk TCP, big segments, 10 s" 10 as 1102 $NET tcp-up $PEER 5001 10
one "1:20 alone: kiosk TCP, the internet's MSS, 10 s" 10 as 1102 $NET tcp-up $PEER 5002 10
echo "== all three past their ceilings at once, 15 s"
job=$(sink_start 9000 18); a=$(snap)
as_rtc $NET udp-send $PEER 9000 90 15 --sport 443 > /tmp/o1 & as 1100 $NET udp-send $PEER 9000 6 15 > /tmp/o2 & as 1102 $NET tcp-up $PEER 5001 15 > /tmp/o3 & wait
b=$(snap); classes "$a" "$b" 15; sink_result "$job" | cut -c1-300 | sed 's/^/  sink: /'
python3 -I - "$a" "$b" <<'P'
import json, sys
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
tot = sum(b[h]["bytes"] - a[h]["bytes"] for h in b) * 8 / 1e6 / 15
print(f"  all classes together: {tot:.1f} Mbps (ADR: 162 at most)")
P
echo "== keyframe burst: 500 x 1200 B (600 KB, four viewers' keyframes) from rtc's 443 at once, then 800 (960 KB)"
for n in 500 500 800; do
  job=$(sink_start 9000 3); a=$(snap); as_rtc $NET burst $PEER 9000 $n --sport 443 | sed 's/^/  sender: /'; sleep 1; b=$(snap)
  sink_result "$job" | sed 's/^/  sink: /'; classes "$a" "$b" 1 | grep 1:10
done
echo "== the bucket's limit, on a dummy interface (nothing leaves the box): rate 1 Mbit with a growing burst"
ip link add lab0 type dummy 2>/dev/null; ip link set lab0 up; tc qdisc replace dev lab0 root handle 1: htb default 20
for b in 1mb 30mb 34mb 35mb 40mb 100mb; do
  if o=$(tc class replace dev lab0 parent 1: classid 1:20 htb rate 1mbit ceil 1mbit burst $b cburst $b 2>&1); then
    echo "  asked burst $b: tc took it, reads back as: $(tc -d class show dev lab0 | grep -o -E 'burst [^ ]+ b/[0-9]+ mpu [^ ]+ |burst [^ ]+|buffer [^ ]+' | head -2 | paste -sd' ')"
  else echo "  asked burst $b: refused: $(echo "$o" | head -1)"; fi
done
tc -j -d class show dev lab0 | jq -c '.[0] | {rate, burst, cburst}' | sed 's/^/  last, as JSON: /'
ip link del lab0
