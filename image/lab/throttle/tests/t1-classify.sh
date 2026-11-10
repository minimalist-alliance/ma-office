# ADR 0036 [A] section 2: the output hook runs before the qdisc and HTB takes the class from skb->priority, so no tc filter
# is needed. Each user's packets, UDP and TCP, and where they land. Also SO_PRIORITY 6 and IP_TOS, which any user may set.
. /var/tmp/lab/lab/throttle/tests/common.sh
echo "=== $BOX ($TYPE), kernel $(uname -r), $(date -u +%FT%TZ)"
echo "--- tc filters on $DEV (want none): [$(tc filter show dev $DEV; tc filter show dev $DEV parent 1:)]"
tc qdisc show dev $DEV | grep -E 'htb|pfifo|fq_codel' | cut -c1-80 | sed 's/^/  /'
nft list chain inet ma classify | sed 's/^/  /'
lab_images
case_() { # case_ <name> <want> <command...>: the sender's own line, the sink's, and every class
  local name=$1 want=$2; shift 2
  local job a b; job=$(sink_start 9000 6); a=$(snap); "$@" | cut -c1-150; b=$(snap); sleep 1
  echo "== $name (want $want)"; classes "$a" "$b" 4 | sed 's/^/  /'
  python3 -I - "$a" "$b" "$want" <<'P'
import json, sys
a, b, want = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
d = {h: b[h]["packets"] - a.get(h, {}).get("packets", 0) for h in b}
best = max(d, key=d.get)
print(f"  -> {best} carried {d[best]} packets: {'ok' if best == want else 'WRONG'}")
P
  sink_result "$job" | sed 's/^/  sink: /'
}
U="udp-send $PEER 9000 4 4"
case_ "rtc, UDP from 443" 1:10 as_rtc $NET $U --sport 443
case_ "rtc, UDP from another port" 1:20 as 1101 $NET $U
case_ "root, UDP" 1:15 $NET $U
case_ "desk, UDP" 1:15 as 1100 $NET $U
case_ "desk in a container with deskd's flags (host network, --user 1100:1100, --cap-drop=ALL, no-new-privileges)" 1:15 \
  docker run --rm --network host --user 1100:1100 --read-only --cap-drop=ALL --security-opt=no-new-privileges -v $L:/lab:ro ma-sub-lab-py python3 -I /lab/net.py $U
case_ "kiosk, UDP" 1:20 as 1102 $NET $U
case_ "kiosk, UDP with SO_PRIORITY 6 (the most an unprivileged user may set)" 1:20 as 1102 $NET $U --prio 6
case_ "kiosk, UDP with IP_TOS 0x10 (sets SO_PRIORITY 6)" 1:20 as 1102 $NET $U --tos 16
case_ "agent, UDP" 1:20 as 1103 $NET $U
case_ "stream, UDP" 1:20 as 1104 $NET $U
case_ "kiosk, TCP upload with the kernel's big segments" 1:20 as 1102 $NET tcp-up $PEER 5001 4
case_ "desk, TCP upload" 1:15 as 1100 $NET tcp-up $PEER 5001 4
# desk-rtc's ICE-TCP is passive: it listens on 443 and its packets leave from 443. The sink box downloads from it.
as_rtc $NET tcp-sink 443 & TS=$!; sleep 1
echo "== rtc, TCP from 443 (want 1:10): the sink box downloads 4 s from this box's port 443"
ME=$(ip -j -4 addr show dev $DEV | jq -r '.[0].addr_info[0].local')
a=$(snap); job=$(ask "{\"start\": [\"tcp-down\", \"$ME\", 443, 4]}" | jq -r .job); sleep 6; b=$(snap)
sink_result "$job" | sed 's/^/  sink box: /'; kill $TS 2>/dev/null; wait $TS 2>/dev/null; pkill -u 1101 -f 'net.py tcp-sink' 2>/dev/null
classes "$a" "$b" 4 | sed 's/^/  /'
echo "=== control: the classify chain emptied, so nothing labels packets. rtc from 443 and root fall to the default, 1:20."
nft flush chain inet ma classify
case_ "CONTROL, no labels: rtc, UDP from 443" 1:20 as_rtc $NET $U --sport 443
case_ "CONTROL, no labels: root, UDP" 1:20 $NET $U
nft -f /etc/nftables.conf && /usr/local/sbin/lab-allow && echo "=== chain reloaded: $(nft list chain inet ma classify | grep -c 'priority set') rules"
case_ "back: rtc, UDP from 443" 1:10 as_rtc $NET $U --sport 443
