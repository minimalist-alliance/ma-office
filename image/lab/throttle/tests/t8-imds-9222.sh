# The 9222 and IMDS rules with the classify chain in place, and handoff 16 G's last bullet: do the IMDS rules
# (nftables.conf, "ip daddr 169.254.169.254 ... reject") refuse the kernel's own packets for a closing connection, as the
# 9222 rule did before 0f3b27c? Counters are added beside the rules (no verdicts), so the rules themselves are unchanged.
# CANDIDATE=1 first loads the 9222-style rule for IMDS (refuse only a new connection) and measures that instead.
. /var/tmp/lab/lab/throttle/tests/common.sh
N=${N:-40}
echo "=== $BOX ($TYPE), $(date -u +%FT%TZ)"
lab_images
nft -f /etc/nftables.conf && /usr/local/sbin/lab-allow
if [ "${CANDIDATE:-0}" = 1 ]; then
  sed -E -e 's|^(\s*)ip daddr 169.254.169.254 reject with icmp type admin-prohibited|\1ip daddr 169.254.169.254 tcp flags \& (syn \| ack) == syn reject with tcp reset\n\1ip daddr 169.254.169.254 meta l4proto != tcp reject with icmp type admin-prohibited|' \
         -e 's|^(\s*)ip6 daddr fd00:ec2::254 reject with icmpv6 type admin-prohibited|\1ip6 daddr fd00:ec2::254 tcp flags \& (syn \| ack) == syn reject with tcp reset\n\1ip6 daddr fd00:ec2::254 meta l4proto != tcp reject with icmpv6 type admin-prohibited|' \
         /etc/nftables.conf > /var/tmp/nft-candidate.conf
  nft -f /var/tmp/nft-candidate.conf && /usr/local/sbin/lab-allow && echo "--- CANDIDATE loaded:"; nft list chain inet ma output | grep 169.254 | sed 's/^/  /'
fi
h=$(nft -a list chain inet ma output | grep 'ip daddr 169.254.169.254' | grep -v 'skuid' | head -1 | grep -o 'handle [0-9]*' | cut -d' ' -f2)
for f in "syn" "ack" "fin" "rst"; do
  nft insert rule inet ma output position "$h" ip daddr 169.254.169.254 tcp flags \& $f == $f counter comment \"lab: $f reaching the refusal\"
done
nft insert rule inet ma output position "$h" ip daddr 169.254.169.254 counter comment \"lab: all reaching the refusal\"
nft insert rule inet ma input ip saddr 169.254.169.254 tcp flags \& fin == fin counter comment \"lab: FINs from IMDS\"
nft insert rule inet ma input ip saddr 169.254.169.254 tcp flags \& syn == 0 counter comment \"lab: packets from IMDS\"
counters() { nft list ruleset | grep 'comment "lab:' | sed -E 's/.*counter packets ([0-9]+) bytes [0-9]+ comment "lab: (.*)"/  \2: \1/'; }
imds_round() { # imds_round <uid>: a token and an instance ID, each on its own connection, as curl closes them
  local t; t=$(as "$1" curl -s -m 4 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
  as "$1" curl -s -m 4 -o /dev/null -w '%{http_code} %{time_total}\n' -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/instance-id
}
for u in 0 1100; do
  echo "--- uid $u: $N rounds, $((2 * N)) connections"
  t0=$(date +%s.%N); res=$(for i in $(seq 1 "$N"); do imds_round $u; done); t1=$(date +%s.%N)
  echo "  HTTP codes: $(echo "$res" | cut -d' ' -f1 | sort | uniq -c | paste -sd' '); slowest $(echo "$res" | cut -d' ' -f2 | sort -n | tail -1) s; all in $(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }') s"
  sleep 3; echo "  3 s after:"; counters
  echo "  client sockets to IMDS: $(ss -H -tan dst 169.254.169.254 | awk '{print $1}' | sort | uniq -c | paste -sd' ')"
done
echo "--- uid 0, the client closing first: 20 connections opened and closed with no request (an aborted or idle pooled connection)"
python3 -I -c "
import socket, time
for i in range(20):
    s = socket.create_connection(('169.254.169.254', 80), 2); time.sleep(0.05); s.close()
"
sleep 3; echo "  3 s after:"; counters; echo "  client sockets to IMDS: $(ss -H -tan dst 169.254.169.254 | awk '{print $1}' | sort | uniq -c | paste -sd' ')"
echo "--- 60 s later (does IMDS resend FINs that were never acknowledged?)"; sleep 60; counters
echo "  client sockets to IMDS: $(ss -H -tan dst 169.254.169.254 | awk '{print $1}' | sort | uniq -c | paste -sd' ')"
echo "--- the IMDS refusal for other users, with this ruleset loaded (verify.sh section 2's check)"
for u in 0 1100 1101 1102 1103; do echo "  uid $u -> HTTP $(as $u curl -s -o /dev/null -m 4 -w '%{http_code}' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"; done
for u in 1100 1101; do echo "  container --user $u -> $(docker run --rm --network host --user $u:$u ma-sub-lab-py sh -c 'wget -T 4 -O /dev/null --post-data="" http://169.254.169.254/latest/api/token 2>&1 | grep -q -i -E "unreachable|can.t connect|timed out|refused" && echo BLOCKED || echo "OPEN (IMDS answered)"')"; done
echo "  kiosk UDP to IMDS: $(as 1102 python3 -I -c "
import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('169.254.169.254', 80))
try: s.send(b'x'); print('sent')
except OSError as e: print('refused', e.errno)")"
nft -f /etc/nftables.conf && /usr/local/sbin/lab-allow
[ "${CANDIDATE:-0}" = 1 ] && exit 0
echo "=== port 9222, with the classify chain in place"
systemctl start desk-browser; for i in $(seq 1 90); do curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 1; done
for u in 1100 1102 1103; do echo "  127.0.0.1:9222 as uid $u -> HTTP $(as $u curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:9222/json/version)"; done
echo "--- 1000 CDP requests as desk, each on a new connection, then LAST-ACK sockets on 9222"
as 1100 python3 -I - <<'P'
import http.client, time
ts = []
for i in range(1000):
    t = time.monotonic(); c = http.client.HTTPConnection("127.0.0.1", 9222, timeout=10); c.request("GET", "/json/version"); c.getresponse().read(); c.close()
    ts.append(time.monotonic() - t)
ts.sort(); print(f"  1000 requests: p50 {ts[500] * 1000:.1f} ms, p99 {ts[990] * 1000:.1f} ms, max {ts[-1] * 1000:.1f} ms")
P
sleep 1; echo "  LAST-ACK sockets on 9222: $(ss -H -tan state last-ack 'sport = :9222' | wc -l)"
