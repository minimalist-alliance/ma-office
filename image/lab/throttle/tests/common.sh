# Sourced by the tests here. Runs as root on the box under test; PEER is the sink box, which runs `net.py serve 5000`,
# `net.py tcp-sink 5001` (the VPC's 9001 MTU, so big segments) and `net.py tcp-sink 5002 --mss 1448` (the internet's MSS).
set -uo pipefail
L=/var/tmp/lab/lab/throttle
NET="python3 -I $L/net.py"
DEV=ens5
: "${PEER:?PEER is not set}"
chmod 755 /var/tmp/lab /var/tmp/lab/lab /var/tmp/lab/lab/throttle; chmod 644 $L/net.py
as() { local u=$1; shift; setpriv --reuid="$u" --regid="$u" --clear-groups "$@"; }
# uid 1101 with what desk-rtc.service gives it, so it can bind 443.
as_rtc() { setpriv --reuid=1101 --regid=1101 --clear-groups --inh-caps=+net_bind_service --ambient-caps=+net_bind_service "$@"; }
ask() { $NET ask "$PEER" 5000 "$1"; }
sink_start() { ask "{\"start\": [\"udp-sink\", $1, $2]}" | jq -r .job; }   # sink_start <port> <secs> -> job
sink_result() { ask "{\"result\": $1}"; }
snap() { $NET tc $DEV; }
# classes <before json> <after json> <secs>: one line a class
classes() {
  python3 -I - "$1" "$2" "$3" <<'P'
import json, sys
a, b, secs = json.loads(sys.argv[1]), json.loads(sys.argv[2]), float(sys.argv[3])
for h in sorted(b):
    d = {k: b[h][k] - a.get(h, {}).get(k, 0) for k in ("bytes", "packets", "drops", "overlimits")}
    print(f"  {h}: {d['bytes'] / 1e6:9.2f} MB {d['bytes'] * 8 / 1e6 / secs:8.2f} Mbps  pkts {d['packets']:7d}  drops {d['drops']:6d}  overlimits {d['overlimits']:7d}  rate {b[h]['rate'] / 1e6:g} Mbit")
P
}
cpusnap() { $NET cpu; }
# cpudiff <before> <after>: ticks by kind, and busy as a share of all CPUs
cpudiff() {
  python3 -I - "$1" "$2" "$(nproc)" <<'P'
import json, sys
a, b, n = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
d = {k: b[k] - a[k] for k in b}
tot = sum(d.values())
busy = tot - d["idle"] - d["iowait"]
print(f"  cpu ticks: user {d['user']} sys {d['sys']} softirq {d['softirq']} irq {d['irq']} idle {d['idle']}; busy {100 * busy / tot:.2f}% of {n} vCPUs")
P
}
shaper_off() { systemctl stop desk-egress; tc qdisc del dev $DEV root 2>/dev/null; tc qdisc show dev $DEV root | cut -c1-60; }
shaper_on() { systemctl start desk-egress; sleep 2; /opt/ma/desk-egress/current/desk-egress --check && echo "shaper on"; }
# egress_conf key=value ...: lowered thresholds for a test, from the shipped file. egress_conf with nothing puts it back.
egress_conf() {
  cp /var/tmp/lab/recipe/files/etc/ma/egress.conf /etc/ma/egress.conf
  local kv
  for kv in "$@"; do
    sed -i "s/^${kv%%=*} = .*/${kv%%=*} = ${kv#*=}/" /etc/ma/egress.conf
    grep "^${kv%%=*} = " /etc/ma/egress.conf | sed 's/^/  egress.conf: /'
  done
}
# Two small images for the container checks: Python, and Python with tc and nft. Pulled from ECR Public, removed by lab.sh down.
lab_images() {
  docker image inspect ma-sub-lab-py >/dev/null 2>&1 || { docker pull -q public.ecr.aws/docker/library/python:3.13-alpine >/dev/null && docker tag public.ecr.aws/docker/library/python:3.13-alpine ma-sub-lab-py; }
  docker image inspect ma-sub-lab-tools >/dev/null 2>&1 || printf 'FROM ma-sub-lab-py\nRUN apk add --no-cache iproute2-tc nftables >/dev/null\n' | docker build -q --network host -t ma-sub-lab-tools - >/dev/null 2>&1
}
