# ADR 0036 [A] section 4: "the ACKs for 40 Mbps of inbound video fit inside the refill" (1 Mbps), and with the bucket empty
# "pages still load, with downloads limited to about 30 Mbps by their ACKs". Downloads as kiosk from the sink box, with
# the internet's MSS (1448). The sink box adds the round trip with netem, and for "video" a 40 Mbit bottleneck, so packets
# arrive spaced as from the internet, not in line-rate bursts that GRO folds into one ACK.
. /var/tmp/lab/lab/throttle/tests/common.sh
RTT=${RTT:-30}; SECS=${SECS:-20}
netem() { ask "{\"netem\": $1}" | jq -r '.qdisc // .error' | sed 's/^/  sink box qdisc: /'; }
down() { # down <name>: one download, its rate and this box's 1:20 (its ACKs)
  local a b r; a=$(snap); r=$(as 1102 $NET tcp-down $PEER 5002 "$SECS"); b=$(snap)
  echo "== $1: $(echo "$r" | jq -c '{mbps, connectMs}')"; classes "$a" "$b" "$SECS" | grep -E '1:20|1:15'
  python3 -I - "$a" "$b" "$r" <<'P'
import json, sys
a, b, r = json.loads(sys.argv[1]), json.loads(sys.argv[2]), json.loads(sys.argv[3])
acks = b["1:20"]["bytes"] - a["1:20"]["bytes"]
print(f"  ACK bytes per download byte: {acks / r['bytes']:.4f}; ACKs at {acks * 8 / 1e6 / r['secs']:.3f} Mbps against the 1 Mbps refill")
P
}
slow() { systemctl stop desk-egress
  tc class change dev $DEV parent 1: classid 1:20 htb rate ${1}bit ceil ${1}bit burst 256kb cburst 256kb prio 1 quantum 60000
  tc class change dev $DEV parent 1: classid 1:15 htb rate 250kbit ceil 250kbit prio 0 quantum 60000
  tc class show dev $DEV | grep -E '1:20|1:15' | cut -c1-80 | sed 's/^/  /'; }
echo "=== $BOX ($TYPE) downloads from the other box, RTT $RTT ms by netem there, $SECS s each, $(date -u +%FT%TZ)"
echo "--- 1. video-like: a 40 Mbit bottleneck, normal rates"
netem "[$RTT, 40]"
for i in 1 2 3; do down "40 Mbit bottleneck, run $i"; done
echo "--- 1b. the same rate in line-rate bursts (no bottleneck, paced by the sender at 40 Mbps)"
netem "[$RTT, 0]"
ask '{"start": ["tcp-sink", 5003, "--mss", 1448, "--pace-mbps", 40]}' >/dev/null
a=$(snap); r=$(as 1102 $NET tcp-down $PEER 5003 "$SECS"); b=$(snap); echo "== paced at 40 Mbps by the sender: $(echo "$r" | jq -c '{mbps}')"; classes "$a" "$b" "$SECS" | grep 1:20
echo "--- 2. unlimited, normal rates: what the link gives at this RTT"
for i in 1 2; do down "unlimited, run $i"; done
echo "--- 3. bucket empty: 1:20 at 0.75 Mbit, as desk-egress sets it"
slow 750k
for i in 1 2 3; do down "slowed, unlimited, run $i"; done
netem "[$RTT, 40]"
for i in 1 2; do down "slowed, 40 Mbit bottleneck (video), run $i"; done
netem "[$RTT, 0]"
echo "--- 4. bucket empty and an upload saturating the slowed 1:20 beside the download"
as 1102 $NET tcp-up $PEER 5002 $((SECS + 4)) > /tmp/up & sleep 2
down "slowed, with an upload running"; wait; sed 's/^/  upload: /' /tmp/up
echo "--- 5. DNS from kiosk to the VPC resolver while slowed with an upload running, and idle"
as 1102 $NET tcp-up $PEER 5002 14 > /tmp/up & sleep 2; as 1102 $NET dns 169.254.169.253 50 | sed 's/^/  slowed, upload running: /'; wait; sed 's/^/  upload: /' /tmp/up
systemctl start desk-egress; sleep 2; as 1102 $NET dns 169.254.169.253 50 | sed 's/^/  normal, idle: /'
netem null
