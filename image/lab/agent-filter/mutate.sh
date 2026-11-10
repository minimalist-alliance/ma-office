#!/bin/bash
# mutate.sh: break each thing verify-agent-filter.sh guards, on lab box a (booted from the image under test), and see its check
# fail. $M holds one directory per program mutant (mutants.txt), each with its arm64 build as bin; image/dist must hold the
# pinned desk-agent-filter tgz (package-desk-agent-filter.sh $VERSION, default the one in releases.pin). Each line of $S/mutations.txt: the break, the checks
# expected to fail, yes if they all did, and every check that failed. Both pristine runs must fail nothing.
S=${S:?a scratch directory outside the repo}; M=${M:?the mutants}; HERE=$(cd "$(dirname "$0")" && pwd); L=$HERE/lab.sh; W=$(cd "$HERE/../../.." && pwd); export S; V=$W/image/verify-agent-filter.sh
VERSION=${VERSION:-$(awk '$1 == "desk-agent-filter" {print $2}' "$W/image/recipe/releases.pin")}
BOX=a; OUT=$S/mutations.txt; : > "$OUT"; mkdir -p $S/m
for m in $M/*/; do n=$(basename "$m"); $L put $BOX "$m/bin" "/tmp/mut-$n" </dev/null; done
mkdir -p $S/new; tar -xzf $W/image/dist/desk-agent-filter-$VERSION.tgz -C $S/new desk-agent-filter; echo "pristine: $(sha256sum $S/new/desk-agent-filter | cut -c1-16), from dist/desk-agent-filter-$VERSION.tgz $(sha256sum $W/image/dist/desk-agent-filter-$VERSION.tgz | cut -c1-16)" >> "$OUT"; $L put a $S/new/desk-agent-filter /tmp/filter.new </dev/null
$L put a "$W/image/recipe/files/etc/nftables.conf" /tmp/nftables.conf </dev/null; $L put a "$W/image/recipe/files/etc/systemd/system/desk-agent-filter.service" /tmp/desk-agent-filter.service </dev/null
$L root $BOX <<'R' | tee -a "$OUT"
chmod 0755 /tmp/mut-*; [ -f /var/tmp/conf.orig ] || cp /etc/ma/agent-egress.conf /var/tmp/conf.orig; [ -f /var/tmp/hosts.orig ] && cp /var/tmp/hosts.orig /etc/hosts
cmp /tmp/filter.new /opt/ma/desk-agent-filter/current/desk-agent-filter && echo 'the baked binary is the pristine one'; cmp /tmp/nftables.conf /etc/nftables.conf && echo 'the baked rules are the final ones'; cmp /tmp/desk-agent-filter.service /etc/systemd/system/desk-agent-filter.service && echo 'the baked unit is the final one'
systemctl stop desk-agent-filter; cp /tmp/filter.new /var/tmp/filter.orig; cp /tmp/filter.new /opt/ma/desk-agent-filter/current/desk-agent-filter; chmod 0755 /opt/ma/desk-agent-filter/current/desk-agent-filter
cp /tmp/desk-agent-filter.service /etc/systemd/system/; systemctl daemon-reload
sed -i '/filter-lab/d' /etc/hosts; sed -i '/filter-lab/d' /var/tmp/conf.orig; cp /var/tmp/conf.orig /etc/ma/agent-egress.conf
nft -c -f /tmp/nftables.conf && cp /tmp/nftables.conf /etc/nftables.conf && nft -f /etc/nftables.conf && nft add rule inet ma input tcp dport 22 accept; systemctl start desk-agent-filter; systemctl is-active desk-agent-filter
R
RESTORE='
rm -rf /etc/systemd/system/desk-agent-filter.service.d; systemctl daemon-reload
systemctl stop desk-agent-filter
cp /var/tmp/filter.orig /opt/ma/desk-agent-filter/current/desk-agent-filter
cp /var/tmp/conf.orig /etc/ma/agent-egress.conf
nft -f /etc/nftables.conf && nft add rule inet ma input tcp dport 22 accept
systemctl reset-failed desk-agent-filter 2>/dev/null; systemctl restart desk-agent-filter; sleep 1'
NFTR='nft -a list chain inet ma'
run() { local name=$1 want=$2 setup=$3 env=${4:-F_LOG_WAIT=0}
  { echo "$setup"; } | $L root $BOX >/dev/null 2>&1
  { echo "$env"; cat "$V"; } | $L root $BOX > "$S/m/$name.txt" 2>&1
  echo "$RESTORE" | $L root $BOX >/dev/null 2>&1
  local got ok=yes id; got=$(sed -n 's/^BAD \([A-Z-]*\):.*/\1/p' "$S/m/$name.txt" | sort -u | paste -sd,)
  for id in ${want//,/ }; do grep -qw -- "$id" <<<"${got//,/ }" || ok=NO; done
  grep -q '^ran to the end$' "$S/m/$name.txt" || got="$got,(did not reach the end)"
  printf '%-22s expected %-34s %-4s failed: %s\n' "$name" "$want" "$ok" "$got" | tee -a "$OUT"
}
bin() { echo "systemctl stop desk-agent-filter; cp /tmp/mut-$1 /opt/ma/desk-agent-filter/current/desk-agent-filter; systemctl start desk-agent-filter; sleep 1"; }
run pristine-first   "" "true" F_LOG_WAIT=61
run provider-unlisted F-PROV,F-PLACE,F-ADDR,F-ECH,F-CT "sed -i '/^api.anthropic.com/d' /etc/ma/agent-egress.conf; systemctl restart desk-agent-filter; sleep 1"
run provider-xai-off F-PROV,F-PLACE "sed -i '/^api.x.ai/d' /etc/ma/agent-egress.conf; systemctl restart desk-agent-filter; sleep 1"
run site-listed      F-CF "echo www.cloudflare.com >> /etc/ma/agent-egress.conf; systemctl restart desk-agent-filter; sleep 1"
run any-name         F-CF "$(bin any-name)"
run no-sni-ok        F-NOSNI "$(bin no-sni-ok)"
run ech-ok           F-ECH "$(bin ech-ok)"
run dials-elsewhere  F-ADDR "$(bin dials-elsewhere)"
run dns-any-name     F-DNS,F-CT "$(bin dns-any-name)"
run dns-any-type     F-DNS "$(bin dns-any-type)"
run private-ok       F-PRIV "$(bin private-ok)"
run no-buffers       F-BUF "$(bin no-buffers)"
run log-unlimited    F-LOG "$(bin log-unlimited)" F_LOG_WAIT=61
run log-contents     F-LOG "$(bin log-contents)" F_LOG_WAIT=61
run full-bypass      F-CF,F-NOSNI,F-IP,F-STOP,F-DNS,F-PORTS,F-UDP,F-CT "nft flush chain inet ma agent_redirect; nft insert rule inet ma output meta skuid 1103 accept"
run udp-443-open     F-UDP "nft insert rule inet ma output meta skuid 1103 udp dport 443 accept"
run other-ports-open F-PORTS "nft insert rule inet ma output meta skuid 1103 tcp dport { 80, 853, 8443, 22 } accept"
run dns-goes-out     F-DNS "for h in \$($NFTR agent_redirect | sed -n 's/.*th dport 53 redirect.*# handle \([0-9]*\).*/\1/p'); do nft delete rule inet ma agent_redirect handle \$h; done; nft insert rule inet ma output meta skuid 1103 meta l4proto { tcp, udp } th dport 53 accept"
run ct-hole-open     F-CTHOLE "for h in \$($NFTR output | sed -n 's/.*meta skuid 1103 udp dport 53 reject.*# handle \([0-9]*\).*/\1/p'); do nft delete rule inet ma output handle \$h; done"
run other-uids-reach F-UIDS "nft insert rule inet ma output ip daddr 127.0.0.1 meta l4proto { tcp, udp } th dport { 14443, 14053 } accept; nft insert rule inet ma output ip6 daddr ::1 meta l4proto { tcp, udp } th dport { 14443, 14053 } accept"
run filter-uid-open  F-FUID "nft insert rule inet ma output meta skuid 1106 accept"
run stand-in-can-answer F-SQUAT "for h in \$($NFTR output | sed -n 's/.*meta skuid != 1106 .*# handle \([0-9]*\).*/\1/p'); do nft delete rule inet ma output handle \$h; done"
run loopback-shut    F-LOOP "nft insert rule inet ma output meta skuid 1103 ip daddr 127.0.0.1 tcp dport 8131 reject"
run imds-open        F-LOOP "nft insert rule inet ma output meta skuid 1103 ip daddr 169.254.169.254 accept"
run wrong-class      F-CLASS "nft insert rule inet ma classify meta skuid 1106 meta priority set 1:15"
run old-set-back     F-RULES "nft add set inet ma agent_https4 '{ type ipv4_addr; }'"
run as-root          F-UNIT "mkdir -p /etc/systemd/system/desk-agent-filter.service.d; printf '[Service]\nUser=root\nGroup=root\nCapabilityBoundingSet=~\n' > /etc/systemd/system/desk-agent-filter.service.d/x.conf; systemctl daemon-reload; systemctl restart desk-agent-filter; sleep 1"
run no-restart       F-BACK,F-UNIT "mkdir -p /etc/systemd/system/desk-agent-filter.service.d; printf '[Service]\nRestart=no\n' > /etc/systemd/system/desk-agent-filter.service.d/x.conf; systemctl daemon-reload; systemctl restart desk-agent-filter; sleep 1"
run varlink-in-ct    F-CT "true" "F_LOG_WAIT=0; F_CT_ARGS='-v /run/systemd/resolve:/run/systemd/resolve'"
run pristine-last    "" "true" F_LOG_WAIT=61
echo done >> "$OUT"
