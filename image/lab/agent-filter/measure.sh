#!/bin/bash
# measure.sh [follow]: the driver for measure-box.sh. Needs lab box a (from the image under test, or with the release under
# test installed as a bake would) and a stand-in box $B (default b: stock Debian 13 arm64 running `load serve -addr :443` as
# root). It starts measure-box.sh on box a as a transient unit and copies its output to $S/numbers.txt every 20 s, so the
# results are on disk as they come and a cut-off here doesn't stop or repeat the run.
#
# PRIVATE=1: the stand-in is reached on its private address, in a's zone, so the transfer costs nothing and stays off the
# public path (put it there with SUBNET=<a's subnet> lab.sh up). The filter refuses private addresses, so for the run a
# gets the lab build ($S/filter-lab, lab-private-standin.patch on the release's source) with MA_FILTER_LAB_ALLOW naming the
# stand-in, and one nftables rule letting uid 1106 reach it on 443. Both are taken off again, and the release put back,
# when the run ends. Every number then comes from the release's code but for that one comparison.
S=${S:?a scratch directory outside the repo}; HERE=$(cd "$(dirname "$0")" && pwd); L=$HERE/lab.sh; OUT=$S/numbers.txt; B=${B:-b}
export S
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
if [ "${PRIVATE:-0}" = 1 ]; then B_IP=$(cut -f1 "$S/lab/$B/private"); A_FROM=$(cut -f1 "$S/lab/a/private")
else B_IP=$(cat "$S/lab/$B/ip"); A_FROM=$(cat "$S/lab/a/ip"); fi
UNDO='[ -f /var/tmp/filter-release ] || exit 0
systemctl stop desk-agent-filter; cp /var/tmp/filter-release /opt/ma/desk-agent-filter/current/desk-agent-filter; rm -f /var/tmp/filter-release
rm -rf /etc/systemd/system/desk-agent-filter.service.d; systemctl daemon-reload
for h in $(nft -a list chain inet ma output | sed -n "s/.*comment \"lab-standin\" # handle \([0-9]*\).*/\1/p"); do nft delete rule inet ma output handle $h; done
systemctl start desk-agent-filter; echo "lab build off: $(sha256sum /opt/ma/desk-agent-filter/current/desk-agent-filter | cut -c1-16), $(nft list chain inet ma output | grep -c lab-standin) lab rules"'
if [ "${1:-}" != follow ]; then
  $L open443 "$B" "$A_FROM"
  $L put a $S/load-arm64 /tmp/load </dev/null; $L put a $HERE/measure-box.sh /tmp/measure4.sh </dev/null
  [ "${PRIVATE:-0}" = 1 ] && { $L put a $S/filter-lab /tmp/filter-lab </dev/null || exit 1; }
  { printf 'B_IP=%q; PRIVATE=%q\n' "$B_IP" "${PRIVATE:-0}"; cat <<'X'
install -m 0755 /tmp/load /var/tmp/load; install -m 0755 /tmp/measure4.sh /var/tmp/measure4.sh; echo "$B_IP" > /var/tmp/b_ip
systemctl is-active --quiet measure4 && { echo "measure4 is already running"; exit 1; }
if [ "$PRIVATE" = 1 ]; then
  cp /opt/ma/desk-agent-filter/current/desk-agent-filter /var/tmp/filter-release
  systemctl stop desk-agent-filter; install -m 0755 /tmp/filter-lab /opt/ma/desk-agent-filter/current/desk-agent-filter
  mkdir -p /etc/systemd/system/desk-agent-filter.service.d
  printf '[Service]\nEnvironment=MA_FILTER_LAB_ALLOW=%s\n' "$B_IP" > /etc/systemd/system/desk-agent-filter.service.d/lab.conf; systemctl daemon-reload
  nft insert rule inet ma output meta skuid 1106 ip daddr "$B_IP" tcp dport 443 accept comment '"lab-standin"'
  systemctl start desk-agent-filter; echo "lab build on: $(sha256sum /opt/ma/desk-agent-filter/current/desk-agent-filter | cut -c1-16)"
fi
rm -f /var/tmp/measure4.out
systemd-run --unit=measure4 --collect -p StandardOutput=file:/var/tmp/measure4.out -p StandardError=file:/var/tmp/measure4.out /bin/bash /var/tmp/measure4.sh
X
  } | $L root a || exit 1
fi
while :; do
  sleep 20
  $L ssh a 'sudo cat /var/tmp/measure4.out' > $OUT.tmp </dev/null 2>/dev/null && mv $OUT.tmp $OUT
  grep -q '^measure: done' $OUT && break
  st=$($L ssh a 'systemctl is-active measure4' </dev/null 2>/dev/null)
  [ "$st" = active ] || { sleep 5; $L ssh a 'sudo cat /var/tmp/measure4.out' > $OUT </dev/null 2>/dev/null; echo "measure4 stopped without finishing ($st)" >> $OUT; break; }
done
echo "$UNDO" | $L root a
echo "driver: finished"
