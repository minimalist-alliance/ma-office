# ADR 0036 section 6 test 2 and [A] section 3: tc's bytes against NetworkOut within 5% over 10 GB, and NetworkOut counted
# outside the guest. About 10.5 GB in 9 minutes, all three classes at or near their ceilings, between two quiet 5-minute
# buckets. lab.sh networkout then reads CloudWatch for the same buckets. Same-AZ private traffic: no transfer charge.
. /var/tmp/lab/lab/throttle/tests/common.sh
SECS=${SECS:-540}
ipb() { ip -j -s link show dev $DEV | jq '.[0].stats64.tx.bytes'; }
echo "=== $BOX ($TYPE), $(date -u +%FT%TZ)"
echo "  CloudWatch or SSM agents on the box: $(systemctl list-units --all --no-legend 'amazon-cloudwatch*' | wc -l) CloudWatch units; $(pgrep -c amazon-ssm || true) SSM processes (they don't report NetworkOut)"
# Start 20 s into a fresh 5-minute bucket, so the bucket before is quiet.
now=$(date +%s); next=$(( (now / 300 + 1) * 300 + 20 )); echo "  waiting $((next - now)) s for a fresh bucket"; sleep $((next - now))
a=$(snap); ia=$(ipb); t0=$(date +%s)
as_rtc $NET udp-send $PEER 9000 55 "$SECS" --sport 443 > /tmp/c1 &
as 1100 $NET udp-send $PEER 9000 1.9 "$SECS" > /tmp/c2 &
as 1102 $NET tcp-up $PEER 5001 "$SECS" > /tmp/c3 &
job=$(sink_start 9000 $((SECS + 5)))
wait
t1=$(date +%s); b=$(snap); ib=$(ipb)
sink_result "$job" | jq -c 'to_entries[] | {(.key): .value.pkts}' | paste -sd' ' | sed 's/^/  sink packets: /'
for f in /tmp/c1 /tmp/c2 /tmp/c3; do cut -c1-110 $f | sed 's/^/  sender: /'; done
classes "$a" "$b" $((t1 - t0))
python3 -I - "$a" "$b" "$ia" "$ib" "$t0" "$t1" <<'P'
import json, sys
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
tc = sum(b[h]["bytes"] - a[h]["bytes"] for h in b)
ip = int(sys.argv[4]) - int(sys.argv[3])
pk = sum(b[h]["packets"] - a[h]["packets"] for h in b)
print(json.dumps({"t0": int(sys.argv[5]), "t1": int(sys.argv[6]), "tcBytes": tc, "tcPackets": pk, "ipLinkTxBytes": ip,
                  "tcGB": round(tc / 1e9, 3), "ipLinkGB": round(ip / 1e9, 3)}))
P
echo "  now wait at least 10 minutes, then: lab.sh networkout $BOX $t0 $t1"
