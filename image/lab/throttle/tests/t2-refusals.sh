# ADR 0036 section 6 test 3 and [A] section 2: as kiosk, desk and rtc (and agent and stream), tc, nft, SO_PRIORITY 0x10010
# and binding 443 are each refused. After each user, root checks that the shaper and the chain are as they were.
. /var/tmp/lab/lab/throttle/tests/common.sh
echo "=== $BOX ($TYPE), kernel $(uname -r), $(date -u +%FT%TZ)"
cat > /var/tmp/probe.sh <<'S'
#!/bin/sh
# POSIX sh, so it also runs in the Alpine container. Each line: what was tried, ALLOWED or refused, and the first error line.
t() { n=$1; shift; if o=$("$@" 2>&1); then echo "  $n: ALLOWED"; else echo "  $n: refused ($(echo "$o" | grep -v '^\s*\^' | head -1 | cut -c1-60))"; fi; }
t "tc qdisc del dev ens5 root" tc qdisc del dev ens5 root
t "tc class change 1:20 to 1 Gbit" tc class change dev ens5 parent 1: classid 1:20 htb rate 1gbit ceil 1gbit
t "tc filter add: everything to 1:10" tc filter add dev ens5 parent 1: matchall classid 1:10
t "nft flush chain inet ma classify" nft flush chain inet ma classify
t "nft add rule: priority 1:10 for all" nft add rule inet ma classify meta priority set 1:10
t "nft list ruleset" nft list ruleset
python3 -I "$1/net.py" refusals | tr -d '{}"' | tr ',' '\n' | sed 's/^ */  /'
S
chmod 755 /var/tmp/probe.sh
lab_images
intact() {
  local ok=1 r
  /opt/ma/desk-egress/current/desk-egress --check 2>/dev/null || ok=0
  r=$(tc -j class show dev $DEV | jq -r '.[]|select(.handle=="1:20")|.rate'); [ "$r" = 12500000 ] || ok=0
  [ "$(nft list chain inet ma classify | grep -c 'priority set')" = 3 ] || ok=0
  [ -z "$(tc filter show dev $DEV parent 1:)" ] || ok=0
  [ $ok = 1 ] && echo "  root after: shaper on, 1:20 at 100 Mbit, classify has its 3 rules, no filter" || { echo "  root after: CHANGED"; tc class show dev $DEV; nft list chain inet ma classify; nft -f /etc/nftables.conf; /usr/local/sbin/lab-allow; systemctl restart desk-egress; }
}
for u in 1100:desk 1101:rtc 1102:kiosk 1103:agent 1104:stream; do
  echo "=== uid ${u%%:*} (${u#*:}), setpriv, no capabilities"; as "${u%%:*}" /var/tmp/probe.sh $L; intact
done
echo "=== rtc as desk-rtc.service runs it: User=rtc, AmbientCapabilities and CapabilityBoundingSet CAP_NET_BIND_SERVICE, NoNewPrivileges"
systemd-run --quiet --wait --pipe --collect -p User=rtc -p Group=rtc -p SupplementaryGroups=desk -p AmbientCapabilities=CAP_NET_BIND_SERVICE \
  -p CapabilityBoundingSet=CAP_NET_BIND_SERVICE -p NoNewPrivileges=yes /var/tmp/probe.sh $L; intact
echo "=== kiosk in a new user namespace, as a sandbox escape might try (unshare -Ur: root in it, the host's network)"
as 1102 unshare -Ur /var/tmp/probe.sh $L; intact
echo "=== kiosk in a new user and network namespace (unshare -Urn): it may change its own empty namespace, never ens5"
as 1102 unshare -Urn sh -c 'ip link show ens5 >/dev/null 2>&1 && echo "  ens5 visible" || echo "  no ens5 in its namespace"; tc qdisc add dev lo root htb && echo "  htb on its own lo: allowed"'; intact
echo "=== desk in a container with deskd's flags (runtime spec section 5): host network, --user 1100:1100, --cap-drop=ALL, no-new-privileges, with tc and nft inside"
docker run --rm --network host --user 1100:1100 --read-only --tmpfs /tmp --cap-drop=ALL --security-opt=no-new-privileges -v $L:/lab:ro -v /var/tmp/probe.sh:/probe.sh:ro \
  ma-sub-lab-tools sh /probe.sh /lab; intact
echo "=== control: root may set any SO_PRIORITY, but the chain relabels root to 1:15, so even 1:10 asked for lands in 1:15"
job=$(sink_start 9000 6); a=$(snap); $NET udp-send $PEER 9000 4 4 --prio 0x10010 | cut -c1-80; b=$(snap); sink_result $job >/dev/null
classes "$a" "$b" 5
echo "=== the port 443 floor and file capabilities"
echo "  net.ipv4.ip_unprivileged_port_start = $(sysctl -n net.ipv4.ip_unprivileged_port_start)"
caps=$(getcap -r /usr /opt /bin /sbin /etc 2>/dev/null); echo "  files with a capability: ${caps:-none}"
PTP=/usr/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-ptp-helper
echo "  statoverride: $(dpkg-statoverride --list $PTP)"
# From a shell that is already kiosk, as Chromium would: setpriv itself execs with root's capabilities, so it can run a 0700 file.
as 1102 sh -c "exec $PTP" </dev/null >/dev/null 2>&1; r=$?
[ $r = 126 ] && echo "  kiosk can't run gst-ptp-helper: exec refused (exit 126)" || echo "  kiosk ran gst-ptp-helper: BAD (exit $r)"
find / -xdev -perm -4000 -type f 2>/dev/null | sort | sed 's/^/  setuid: /'
