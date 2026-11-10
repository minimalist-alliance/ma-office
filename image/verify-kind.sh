# verify-kind.sh: verify.sh's sections on the desk's kind (image/README.md, "Guild Desk"). Sourced by verify.sh after
# section 1a1, so it has R, RS, result, info, say, $IP, $INSTANCE_ID, $SG_ID, $WORKDIR, $WANT, $N_BAKED and $T_COMMONS.
#
#   kind_member  on the default run, booted with metadata tags off: the answer is member, nothing of a Guild Desk runs or
#                listens, the reader fails safe on every bad read and says guild only for an exact tag (both tried here,
#                by changing this box's own tags and blocking IMDS), and the ruleset is exactly nftables.conf's.
#   kind_guild   on VERIFY_KIND=guild, booted with DeskKind=guild and metadata tags on: no Xorg, Chromium or desk-stream,
#                desk-units refuses the Browser, deskd, desk-rtc, desk-notebook and desk-agent run, commons-server's
#                unit with a stand-in release, its walls and its socket, the voice ports open only as intended, the voice
#                class and the guild's budget, and all of it again after a reboot. Neither kind has per-network limits on
#                TCP 443 (removed by desk-net-031-sec, Security's NET031-3): the rulesets are checked line by line.
#
# Ports are tried from this workstation: the temporary group lets it reach UDP 8791 to 8799 and TCP 8790 and 8799, so whatever is
# closed is closed by the desk's own nftables. Each closed port has a listener behind it, and a control port is opened on
# purpose, so "closed" can't be a probe that reaches nothing. No address is printed.

KIND_PORTS="8791,8792,8793,8794,8795,8796,8797,8798,8799"
# Shell for the box: sourced at the top of every remote script here.
KLIB='
export LC_ALL=C
bad() { echo "BAD: $*"; echo FAILED; }
ask() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(\"/run/desk/units.sock\"); s.sendall(sys.argv[1].encode() + b\"\\n\"); print(s.recv(300).decode().strip())
except OSError as e:
    print(type(e).__name__)" "$2" 2>&1 | tail -1; }
imds_code() { setpriv --reuid=$1 --regid=$1 --clear-groups curl -s -o /dev/null -m 4 -w "%{http_code}" -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token; }
# What IMDS says of DeskKind, read as root: off (metadata tags off), none (on, no tag), value:<v>, or error:<code>
imds_state() {
  local t b c
  t=$(curl -s -m 3 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token) || { echo error:token; return; }
  c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/tags/instance)
  [ "$c" = 404 ] && { echo off; return; }
  b=$(curl -s -m 3 -w " %{http_code}" -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/tags/instance/DeskKind)
  case "$b" in *" 200") echo "value:${b% 200}" ;; *" 404") echo none ;; *) echo "error:${b##* }" ;; esac
}
show() { systemctl show -p ActiveState -p SubState -p ConditionResult -p NRestarts --value "$1" | paste -sd" "; }
never_ran() { [ "$(systemctl show -p ActiveEnterTimestampMonotonic --value "$1")" = 0 ] && [ "$(systemctl is-active "$1")" = inactive ]; }
skipped_at_boot() { [ "$(systemctl show -p ConditionResult --value "$1")" = no ] && [ "$(systemctl show -p ConditionTimestampMonotonic --value "$1")" -gt 0 ] && never_ran "$1"; }
# The live ruleset against what nftables.conf alone loads in a fresh namespace, verify.sh s own ssh rule aside: diff s output.
# Terse (-t): the elements of a set, which fill as traffic comes, are left out on both sides.
ruleset_diff() {
  local ns=vk$$ f l rc
  f=$(mktemp); l=$(mktemp)
  ip netns add $ns && ip netns exec $ns nft -f /etc/nftables.conf && ip netns exec $ns nft -t list ruleset > $f
  ip netns del $ns
  nft -t list ruleset | grep -v -x "[[:space:]]*tcp dport 22 accept" > $l
  diff $f $l; rc=$?; rm -f $f $l; return $rc
}
voice_rules() { nft -a list chain inet ma input | grep -c "comment \"ma-guild-commons-voice\""; }
local_rules() { nft -a list chain inet ma output | grep -c "comment \"ma-guild-commons-local\""; }
relay_rules() { nft -a list chain inet ma output | grep -c "comment \"ma-guild-commons-relay\""; }
# The members this instance type holds, by this table and not guild.conf, so a wrong conf fails: image/README.md, "Guild Desk".
tier_members() { case "$(cat /sys/devices/virtual/dmi/id/product_name)" in t4g.small) echo 25 ;; t4g.medium) echo 50 ;; *) echo 200 ;; esac; }
# What a Guild Desk adds to nftables.conf, judged from ruleset_diff: only added lines, each a ma-guild- rule, 9 in all: the
# voice rule for the cores (exact), 2 for loopback 8790, 4 for loopback 8799 and 2 voice labels in classify. Nothing on
# TCP 443 (desk-net-031-sec).
guild_diff_ok() { local d=$1 n=$(cores) p; p=8791; [ $n = 1 ] || p=8791-$((8790 + n))
  ! grep -q "^<" <<<"$d" && [ "$(grep -c "^>" <<<"$d")" = 9 ] && [ "$(grep "^>" <<<"$d" | grep -vc "comment \"ma-guild-")" = 0 ] \
    && [ "$(grep "^>" <<<"$d" | sed "s/^> *//; s/^[[:space:]]*//" | grep -cx "udp dport $p accept comment \"ma-guild-commons-voice\"")" = 1 ] \
    && [ "$(grep -c "tcp dport 8790 meta skuid != { 0, 1110 } .*reject.*ma-guild-commons-local" <<<"$d")" = 2 ] \
    && [ "$(grep -c "dport 8799 meta skuid != 1101 .*reject.*ma-guild-commons-relay" <<<"$d")" = 4 ] \
    && [ "$(grep -c "meta skuid 1110 udp sport $p meta priority set 1:30 comment \"ma-guild-voice-class\"" <<<"$d")" = 1 ] \
    && [ "$(grep -c "meta skuid 1101 udp sport 443 @th,64,8 & 0xc0 == 0x80 meta priority set 1:30 comment \"ma-guild-voice-class\"" <<<"$d")" = 1 ] \
    && ! grep -q "tcp dport 443" <<<"$d"; }
cores() { n=$(nproc); [ "$n" -le 8 ] || n=8; echo $n; }
BROWSER_UNITS="desk-xorg desk-audio desk-browser desk-stream desk-adblock desk-browser-thaw desk-preread"
# GDS-5: every unit that depends on the kind is ordered after desk-kind, deskd first of all.
after_kind() { local u; for u in deskd desk-rtc desk-preread desk-guild-net desk-guild-rtc commons-data commons-server-address commons-server; do
  systemctl show -p After --value $u | tr " " "\n" | grep -qx desk-kind.service || bad "$u is not ordered after desk-kind"; done; }
'

# kind_probe_access: lets this workstation reach UDP 8791-8799 and TCP 8790 and 8799 through the temporary group. Says nothing of the address.
kind_probe_access() {
  local ip; ip=$(my_ip)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
    "IpProtocol=udp,FromPort=8791,ToPort=8799,IpRanges=[{CidrIp=$ip/32}]" "IpProtocol=tcp,FromPort=8790,ToPort=8790,IpRanges=[{CidrIp=$ip/32}]" "IpProtocol=tcp,FromPort=8799,ToPort=8799,IpRanges=[{CidrIp=$ip/32}]" \
    >/dev/null 2>&1 || { log "can't add the probe rules to $SG_ID"; return 1; }
}

# kind_probe: from this workstation, which of UDP 8791-8799 echo, and whether TCP 8790 and 8799 connect. Lines "udp 8791 open".
kind_probe() {
  python3 -I - "$IP" "$KIND_PORTS" 8790,8799 <<'P'
import os, select, socket, sys, time
ip, udp, tcps = sys.argv[1], [int(p) for p in sys.argv[2].split(",")], [int(p) for p in sys.argv[3].split(",")]
nonce = os.urandom(4).hex()
socks, got = {}, set()
for p in udp:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setblocking(False); socks[s] = p
for _ in range(4):
    for s, p in socks.items():
        if p not in got:
            try: s.sendto(f"ma-probe {p} {nonce}".encode(), (ip, p))
            except OSError: pass
    end = time.monotonic() + 1.5
    while time.monotonic() < end:
        r, _, _ = select.select(list(socks), [], [], max(0, end - time.monotonic()))
        for s in r:
            try: d, _ = s.recvfrom(2048)
            except OSError: continue
            if d == f"ma-probe {socks[s]} {nonce}".encode(): got.add(socks[s])
for p in udp: print(f"udp {p} {'open' if p in got else 'closed'}")
for tcp in tcps:
    c = socket.socket(); c.settimeout(3)
    try: c.connect((ip, tcp)); print(f"tcp {tcp} open")
    except OSError: print(f"tcp {tcp} closed")
    c.close()
P
}

# kind_echo <udp ports,> : a root listener on the box behind every port given (and TCP 8790 and 8799), echoing UDP probes, for 10 min.
kind_echo() {
  { printf 'PORTS=%q\n' "$1"; cat <<'X'
cat > /var/tmp/verify-echo.py <<'P'
import select, socket, sys
udp = [int(p) for p in sys.argv[1].split(",") if p]
socks = {}
for p in udp:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", p)); socks[s] = p
tl = {}
for p in (8790, 8799):
    t = socket.socket(); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); t.bind(("0.0.0.0", p)); t.listen(4); tl[t] = p
print("listening: udp", udp, "tcp 8790 8799", flush=True)
while True:
    for s in select.select(list(socks) + list(tl), [], [])[0]:
        if s in tl:
            c, _ = s.accept(); print("tcp", tl[s], "connection", flush=True); c.close(); continue
        d, a = s.recvfrom(2048)
        print("udp", socks[s], "got a probe", flush=True)
        if d.startswith(b"ma-probe "): s.sendto(d, a)
P
systemctl stop verify-echo 2>/dev/null; systemctl reset-failed verify-echo 2>/dev/null
systemd-run --quiet --unit=verify-echo -p RuntimeMaxSec=600 /usr/bin/python3 -I /var/tmp/verify-echo.py "$PORTS"
for i in $(seq 1 50); do ss -lnt | grep -q ':8799 ' && break; sleep 0.1; done
echo "echo listener: $(systemctl is-active verify-echo), udp $PORTS and tcp 8790 and 8799"
X
  } | RS
}

kind_member() {
  local rc o
  kind_probe_access || true
  # ---- 1k1. What the boot decided, and that nothing of a Guild Desk runs or listens.
  { echo "$KLIB"; printf 'RTC_SHA=%q\n' "$(sha256sum < "$HERE/recipe/files/etc/systemd/system/desk-rtc.service" | cut -c1-64)"; cat <<'X'
echo "--- the answer: /run/ma $(stat -c '%U:%G %a' /run/ma 2>&1), desk-kind $(stat -c '%U:%G %a' /run/ma/desk-kind 2>&1): $(cat /run/ma/desk-kind 2>&1)"
[ "$(cat /run/ma/desk-kind 2>&1)" = member ] || bad "/run/ma/desk-kind should say member"
[ ! -e /run/ma/guild ] || bad "/run/ma/guild exists on a member's desk"
[ ! -e /run/commons-server.address ] || bad "/run/commons-server.address exists on a member's desk"
[ "$(stat -c '%U:%G %a' /run/ma 2>&1)" = "root:root 755" ] && [ "$(stat -c '%U:%G %a' /run/ma/desk-kind 2>&1)" = "root:root 644" ] || bad "the answer should be root's, 0644 in a 0755 directory"
echo "IMDS (root): $(imds_state)"
l=$(journalctl -b -u desk-kind -o cat --no-pager | grep '^desk-kind: ' | tail -1); echo "journal: $l"
case "$l" in "desk-kind: member (instance metadata tags are off"*) ;; *) bad "the journal should say member, with metadata tags off, as this box was launched" ;; esac
at() { systemctl show -p "$2" --value "$1"; }
echo "desk-kind done at $(( $(at desk-kind ActiveEnterTimestampMonotonic) / 1000 )) ms; desk-rtc started at $(( $(at desk-rtc ExecMainStartTimestampMonotonic) / 1000 )) ms, deskd at $(( $(at deskd ExecMainStartTimestampMonotonic) / 1000 )) ms"
for u in desk-rtc deskd desk-egress; do [ "$(at desk-kind ActiveEnterTimestampMonotonic)" -le "$(at $u ExecMainStartTimestampMonotonic)" ] || bad "$u started before desk-kind answered"; done
after_kind
echo "--- a Guild Desk's units: skipped by their condition at boot, never run"
for u in desk-guild-net desk-guild-rtc commons-data commons-server-address commons-server; do echo "$u: $(show $u)"; skipped_at_boot $u || bad "$u should have been skipped at boot"; done
echo "--- desk-rtc, byte for byte the image's: unit file sha256 $(sha256sum < /etc/systemd/system/desk-rtc.service | cut -c1-16) (this tree's $(cut -c1-16 <<<"$RTC_SHA")), drop-ins '$(systemctl show -p DropInPaths --value desk-rtc)', $(systemctl show -p MemoryMax -p Environment -p EnvironmentFiles desk-rtc | paste -sd' ')"
[ "$(sha256sum < /etc/systemd/system/desk-rtc.service | cut -c1-64)" = "$RTC_SHA" ] || bad "desk-rtc.service isn't this tree's"
[ -z "$(systemctl show -p DropInPaths --value desk-rtc)" ] && [ ! -e /run/systemd/system/desk-rtc.service.d ] || bad "desk-rtc has a drop-in on a member's desk"
[ "$(systemctl show -p MemoryMax --value desk-rtc)" = 134217728 ] && [ "$(systemctl show -p Environment --value desk-rtc)" = "DISPLAY=:99 RELEASE_DIR=/opt/ma/desk-rtc/current" ] && [ -z "$(systemctl show -p EnvironmentFiles --value desk-rtc)" ] || bad "desk-rtc's memory or environment isn't the image's"
p=$(systemctl show -p MainPID --value desk-rtc); echo "desk-rtc's process environment: $(tr '\0' '\n' < /proc/$p/environ | cut -d= -f1 | sort | paste -sd' ')"
# desk-rtc's own run sets GOMEMLIMIT=96MiB unless the unit gives one (desk-rtc/README.md), so a member's desk-rtc has run's.
echo "desk-rtc's GOMEMLIMIT: $(tr '\0' '\n' < /proc/$p/environ | grep '^GOMEMLIMIT=')"
tr '\0' '\n' < /proc/$p/environ | grep -qx 'GOMEMLIMIT=384MiB' && bad "desk-rtc has the Guild Desk's GOMEMLIMIT on a member's desk"
for u in $BROWSER_UNITS; do echo "$u: $(show $u), drop-in $(systemctl show -p DropInPaths --value $u | tr ' ' '\n' | grep -c /desk-kind.conf)"; done
echo "--- nothing listens on Commons' ports"; ss -lnup | grep -E ':879[0-9] ' && bad "something listens on UDP 8790-8799"
ss -lntp | grep -E ':(8790|8799) ' && bad "something listens on TCP 8790 or 8799"
echo "--- commons: $(getent passwd commons | cut -d: -f1,3,4,7), groups $(id -nG commons), /run/desk-commons $(stat -c '%U:%G %a' /run/desk-commons 2>&1) with $(ls -A /run/desk-commons | wc -l) entries, /data/guild $(stat -c '%U:%G %a' /data/guild 2>&1)"
[ "$(id -u commons):$(id -nG commons)" = "1110:commons" ] || bad "commons should be uid 1110 in its own group only"
[ "$(stat -c '%U:%G %a' /run/desk-commons 2>&1)" = "commons:desk 2750" ] && [ -z "$(ls -A /run/desk-commons)" ] || bad "/run/desk-commons should be an empty commons:desk 2750"
[ ! -e /data/guild ] || bad "/data/guild is made only on a Guild Desk"
echo "IMDS for commons (1110): HTTP $(imds_code 1110)"; [ "$(imds_code 1110)" = 000 ] || bad "uid 1110 reaches IMDS"
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "desk kind, member: desk-kind answered member (metadata tags off) before deskd, desk-rtc and desk-egress, no flag or address file, desk-guild-net, desk-guild-rtc, commons-data and commons-server skipped and never run, desk-rtc's unit, memory and environment byte for byte the image's, no /data/commons, nothing on UDP or TCP 8790-8799, uid 1110 refused IMDS" $rc < $WORKDIR/o

  # ---- 1k2. Fails safe, and says guild for an exact tag only: this box's own IMDS blocked, then its tags changed.
  kstep() { # kstep <label> <imds state to wait for> <want kind> <reason part>
    { echo "$KLIB"; printf 'LABEL=%q; WANT_IMDS=%q; WANT_KIND=%q; REASON=%q\n' "$1" "$2" "$3" "$4"; cat <<'X'
for i in $(seq 1 60); do s=$(imds_state); [ -z "$WANT_IMDS" ] || [ "$s" = "$WANT_IMDS" ] && break; sleep 2; done
t0=$(date +%s%N); systemctl restart desk-kind; t1=$(date +%s%N)
k=$(cat /run/ma/desk-kind 2>&1); f=$([ -e /run/ma/guild ] && echo yes || echo no)
l=$(journalctl -u desk-kind -o cat --no-pager --since "@$((t0 / 1000000000 - 1))" | grep '^desk-kind: ' | tail -1)
echo "[$LABEL] IMDS $s (waited $i), answer $k, flag $f, restart $(( (t1 - t0) / 1000000 )) ms: $l"
[ -z "$WANT_IMDS" ] || [ "$s" = "$WANT_IMDS" ] || bad "[$LABEL] IMDS never said $WANT_IMDS"
[ "$k" = "$WANT_KIND" ] || bad "[$LABEL] the answer should be $WANT_KIND"
[ "$f" = "$([ "$WANT_KIND" = guild ] && echo yes || echo no)" ] || bad "[$LABEL] the flag doesn't match the answer"
case "$l" in *"$REASON"*) ;; *) bad "[$LABEL] the journal should say: $REASON" ;; esac
r=$(ask 1100 'stop desk-xorg'); echo "[$LABEL] units.sock stop desk-xorg: $r"
if [ "$WANT_KIND" = guild ]; then
  case "$r" in "err unsupported guild "*) ;; *) bad "[$LABEL] desk-units should refuse the Browser on a Guild Desk" ;; esac
  systemctl start desk-browser; echo "[$LABEL] root's start of desk-browser: $(show desk-browser)"
  [ "$(systemctl is-active desk-browser)" = inactive ] && [ "$(systemctl show -p ConditionResult --value desk-browser)" = no ] || bad "[$LABEL] desk-browser should be skipped by its condition"
else
  [ "$r" = ok ] || bad "[$LABEL] desk-units should take deskd's verbs on a member's desk"
fi
X
    } | RS 2>&1
  }
  {
    { echo "$KLIB"; cat <<'X'
nft insert rule inet ma output ip daddr 169.254.169.254 meta skuid 0 drop comment \"verify-imds-block\"
echo "IMDS blocked for root by a temporary rule"
X
    } | RS 2>&1
    kstep "IMDS silent" "" member "no usable answer in 30 s"
    { echo "$KLIB"; cat <<'X'
for h in $(nft -a list chain inet ma output | sed -n 's/.*comment "verify-imds-block" # handle \([0-9]*\)$/\1/p'); do nft delete rule inet ma output handle $h; done
echo "IMDS block removed: $(nft list chain inet ma output | grep -c verify-imds-block) left"
X
    } | RS 2>&1
    kstep "metadata tags off" off member "instance metadata tags are off"
    aws ec2 modify-instance-metadata-options --instance-id "$INSTANCE_ID" --instance-metadata-tags enabled >/dev/null 2>&1 || echo "BAD: couldn't turn metadata tags on"
    kstep "tags on, no DeskKind" none member "no DeskKind tag"
    for v in Guild personal; do
      aws ec2 create-tags --resources "$INSTANCE_ID" --tags "Key=DeskKind,Value=$v" 2>&1 || echo "BAD: couldn't tag DeskKind=$v"
      kstep "DeskKind=$v" "value:$v" member "not exactly 'guild'"
    done
    aws ec2 create-tags --resources "$INSTANCE_ID" --tags Key=DeskKind,Value=guild 2>&1 || echo "BAD: couldn't tag DeskKind=guild"
    kstep "DeskKind=guild" value:guild guild "guild (DeskKind=guild)"
    aws ec2 delete-tags --resources "$INSTANCE_ID" --tags Key=DeskKind 2>&1 || echo "BAD: couldn't remove DeskKind"
    kstep "DeskKind removed" none member "no DeskKind tag"
    aws ec2 modify-instance-metadata-options --instance-id "$INSTANCE_ID" --instance-metadata-tags disabled >/dev/null 2>&1 || echo "BAD: couldn't turn metadata tags off"
    kstep "metadata tags off again" off member "instance metadata tags are off"
    { echo "$KLIB"; cat <<'X'
echo "--- after all of that, nothing of a Guild Desk ran, and the Browser's units are as they were"
for u in desk-guild-net desk-guild-rtc commons-data commons-server-address commons-server; do echo "$u: $(show $u)"; never_ran $u || bad "$u ran"; done
for u in desk-xorg desk-browser; do echo "$u: $(systemctl is-active $u)"; [ "$(systemctl is-active $u)" = inactive ] || bad "$u was left running"; done
echo "ran to the end"
X
    } | RS 2>&1
  } > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' -e '^BAD' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "desk kind fails safe: IMDS silent, metadata tags off, no tag, DeskKind Guild and personal are all member with no flag and the Browser allowed; exactly guild is a Guild Desk whose desk-units and units refuse the Browser; and back" $rc < $WORKDIR/o

  # ---- 1k3. From outside: Commons' ports are closed on a member's desk, with a listener behind each; a control port opened
  # by a temporary rule answers, so the probe itself works.
  kind_echo "$KIND_PORTS" > $WORKDIR/o 2>&1
  RS > /dev/null 2>&1 <<'X'
nft add rule inet ma input udp dport 8799 accept comment \"verify-control\"
X
  { echo "--- probe from this workstation, UDP 8799 opened by a temporary rule"; kind_probe; } >> $WORKDIR/o 2>&1
  RS >> $WORKDIR/o 2>&1 <<'X'
for h in $(nft -a list chain inet ma input | sed -n 's/.*comment "verify-control" # handle \([0-9]*\)$/\1/p'); do nft delete rule inet ma input handle $h; done
echo "--- what reached the listener"; journalctl -u verify-echo -o cat --no-pager | grep -v '^Started\|^Stopped'
systemctl stop verify-echo
X
  o=$(cat $WORKDIR/o); rc=0
  grep -q '^udp 8799 open$' <<<"$o" || { echo "BAD: the control port didn't answer, so the probe proves nothing" >> $WORKDIR/o; rc=1; }
  for p in 8791 8792 8793 8794 8795 8796 8797 8798; do grep -q "^udp $p closed\$" <<<"$o" || { echo "BAD: UDP $p answered" >> $WORKDIR/o; rc=1; }; done
  for t in 8790 8799; do grep -q "^tcp $t closed\$" <<<"$o" || { echo "BAD: TCP $t connected" >> $WORKDIR/o; rc=1; }; done
  grep -q '^udp 879[1-8] got a probe' <<<"$o" && { echo "BAD: a probe reached a closed port's listener" >> $WORKDIR/o; rc=1; }
  result "desk kind, member, from outside: UDP 8791-8798 and TCP 8790 and 8799 closed by nftables with a listener behind each; a control port opened by a temporary rule answers" $rc < $WORKDIR/o

  # ---- 1k4. The ruleset is byte for byte what nftables.conf loads, and nftables.conf is this tree's, after a reload too.
  { echo "$KLIB"; printf 'WANT_SHA=%q\n' "$(sha256sum < "$HERE/recipe/files/etc/nftables.conf" | cut -c1-64)"; cat <<'X'
echo "nftables.conf sha256 $(sha256sum < /etc/nftables.conf | cut -c1-16), this tree's $(cut -c1-16 <<<"$WANT_SHA")"
[ "$(sha256sum < /etc/nftables.conf | cut -c1-64)" = "$WANT_SHA" ] || bad "/etc/nftables.conf isn't this tree's"
echo "--- live ruleset against nftables.conf alone (diff, empty when equal)"; ruleset_diff || bad "the live ruleset differs from nftables.conf's"
echo "lines: $(nft list ruleset | wc -l), voice rules: $(voice_rules)"
echo "--- nftables reload (verify's ssh rule put back at once)"
systemctl reload nftables; nft add rule inet ma input tcp dport 22 accept
ruleset_diff || bad "after a reload the live ruleset differs from nftables.conf's"
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "nftables, member: the loaded ruleset is byte for byte what this tree's nftables.conf loads in a fresh namespace, before and after a reload" $rc < $WORKDIR/o

  # ---- 1k6. A member's shaper and budgets are as they were (ADR 0036): three classes, this tree's egress.conf, a member's
  # state file and journal, and desk-egress after desk-kind. Section 3d checks the classes' numbers and who lands where.
  { echo "$KLIB"; printf 'EGRESS_SHA=%q\n' "$(sha256sum < "$HERE/recipe/files/etc/ma/egress.conf" | cut -c1-64)"; cat <<'X'
c=$(tc -j class show dev ens5 | jq -r '[.[]|select(.class=="htb")|.handle]|sort|join(" ")'); echo "classes: $c"
[ "$c" = "1:10 1:15 1:20" ] || bad "a member's desk has classes 1:10, 1:15 and 1:20, and nothing else"
l=$(tc -j qdisc show dev ens5 | jq -c '.[]|select(.parent=="1:10")|{kind,limit:.options.limit}'); echo "1:10's leaf: $l"
[ "$l" = '{"kind":"pfifo","limit":1000}' ] || bad "a member's 1:10 keeps its 1000-packet pfifo"
nft list chain inet ma classify | grep -q '1:30' && bad "a member's classify chain labels voice"
echo "egress.conf sha256 $(sha256sum < /etc/ma/egress.conf | cut -c1-16), this tree's $(cut -c1-16 <<<"$EGRESS_SHA")"
[ "$(sha256sum < /etc/ma/egress.conf | cut -c1-64)" = "$EGRESS_SHA" ] || bad "/etc/ma/egress.conf isn't this tree's"
for i in $(seq 1 70); do [ -s /data/desk-egress/state.json ] && break; sleep 1; done
k=$(jq -r 'keys|join(" ")' /data/desk-egress/state.json); echo "state keys: $k"
[ "$k" = "boot clamped day_deep last level month month_bytes profile profile_since slowed updated v windows" ] || bad "a member's state file should have exactly its own fields"
journalctl -b -u desk-egress -o cat --no-pager | grep -q 'Guild Desk' && bad "desk-egress took this desk for a Guild Desk"
journalctl -b -u desk-egress -o cat --no-pager | grep -m1 'shaper on'
at() { systemctl show -p "$2" --value "$1"; }
systemctl show -p After --value desk-egress | tr ' ' '\n' | grep -qx desk-kind.service || bad "desk-egress should be ordered after desk-kind"
# That it started after desk-kind's answer at boot is 1k1's: 1k2 has restarted desk-kind since.
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "desk-egress, member: classes 1:10, 1:15 and 1:20 only, 1:10 on its pfifo of 1000, nothing labelled 1:30, this tree's egress.conf, a member's state fields and no Guild Desk line, ordered after desk-kind" $rc < $WORKDIR/o
}

# kind_guild_standin: verify's own commons-server release, installed with ma-update as a rollout would: the socket deskd
# connects to, and one UDP echo port a core from 8791. Its health passes on a member's desk, as the real one's must.
kind_guild_standin() {
  local d=$WORKDIR/commons w v=0.0.0-verify
  w=$d/w; rm -rf $d; mkdir -p $w
  echo "$v" > $w/VERSION
  cat > $w/run <<'P'
#!/usr/bin/python3 -I
# verify.sh's stand-in for commons-server (image/verify-kind.sh). Not Commons.
import os, select, socket, struct, sys
SOCK = "/run/desk-commons/commons.sock"
n = min(len(os.sched_getaffinity(0)), 8)
udp = {}
for p in range(8791, 8791 + n):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", p)); udp[s] = p
try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass
u = socket.socket(socket.AF_UNIX); u.bind(SOCK); os.chmod(SOCK, 0o660); u.listen(16)
try:
    adv = "readable" if open("/run/commons-server.address").read().strip() else "empty"
except OSError as e:
    adv = type(e).__name__
print(f"stand-in: uid {os.getuid()} gid {os.getgid()}, UDP 8791-{8790 + n}, {SOCK}; /data holds {sorted(os.listdir('/data'))}, /data/guild holds {sorted(os.listdir('/data/guild'))}; address file {adv}", flush=True)
with open(os.path.join(os.environ["MA_APP_DATA"], "stand-in"), "w") as f:
    f.write("ok\n")
print("stand-in: wrote its data dir", flush=True)
try:
    os.listdir("/data/browser"); print("stand-in: /data/browser readable", flush=True)
except OSError as e:
    print(f"stand-in: /data/browser {type(e).__name__}", flush=True)
while True:
    for s in select.select([u] + list(udp), [], [])[0]:
        if s is u:
            c, _ = u.accept()
            uid = struct.unpack("3i", c.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            c.sendall(b"ok\n" if uid == 1100 else b"refused\n"); c.close()
            print(f"stand-in: socket peer uid {uid}", flush=True)
        else:
            d, a = s.recvfrom(2048)
            print(f"stand-in: udp {udp[s]} got a probe", flush=True)
            if d.startswith(b"ma-probe "):
                s.sendto(d, a)
P
  cat > $w/health <<'P'
#!/bin/sh
# On a member's desk commons-server never runs, and that's healthy. On a Guild Desk it has to be up with its socket.
[ -e /run/ma/guild ] || exit 0
systemctl is-active --quiet commons-server && [ -S /run/desk-commons/commons.sock ]
P
  # The release's env as deploy/commons-server.env has it, COMMONS_ADVERTISE left empty as there, and an `address` that
  # writes the file as deploy's does (IMDSv2), so commons-server-address.service runs as it will with the real one.
  printf 'MA_APP_DATA=/data/guild/commons\nCOMMONS_ADVERTISE=\n' > $w/commons-server.env
  cat > $w/address <<'P'
#!/bin/sh
tok=$(curl -fsS -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
ip=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/public-ipv4)
umask 022; printf '%s\n' "$ip" > /run/commons-server.address.tmp && mv -f /run/commons-server.address.tmp /run/commons-server.address
P
  chmod 755 $w/run $w/health $w/address; chmod 644 $w/commons-server.env
  tar -C $w -czf $d/commons-server-$v.tgz .
  KSHA=$(sha256sum $d/commons-server-$v.tgz | cut -d' ' -f1); KVER=$v
  scp "${SSH_OPTS[@]}" -i "$KEY_FILE" $d/commons-server-$v.tgz "admin@$IP:/var/tmp/" >/dev/null
}

kind_guild_core() { # the checks that hold at first boot and after a reboot. $1: label
  { echo "$KLIB"; printf 'LABEL=%q; N_BAKED=%q; WANT=%q\n' "$1" "$N_BAKED" "$WANT"; cat <<'X'
echo "--- [$LABEL] the answer: /run/ma $(stat -c '%U:%G %a' /run/ma 2>&1), desk-kind $(stat -c '%U:%G %a' /run/ma/desk-kind 2>&1): $(cat /run/ma/desk-kind 2>&1), guild $(stat -c '%U:%G %a' /run/ma/guild 2>&1): $(cat /run/ma/guild 2>&1)"
[ "$(cat /run/ma/desk-kind 2>&1)" = guild ] && [ "$(cat /run/ma/guild 2>&1)" = DeskKind=guild ] || bad "the answer should be guild, with the flag"
[ "$(stat -c '%U:%G %a' /run/ma/desk-kind /run/ma/guild 2>&1 | paste -sd,)" = "root:root 644,root:root 644" ] || bad "the answer should be root's, 0644"
echo "IMDS (root): $(imds_state)"
l=$(journalctl -b -u desk-kind -o cat --no-pager | grep '^desk-kind: ' | tail -1); echo "journal: $l"
case "$l" in "desk-kind: guild (DeskKind=guild) in "*) ;; *) bad "the journal should say guild (DeskKind=guild)" ;; esac
# commons-server's address: commons-server-address.service writes it from IMDS once a release is installed (1k3 on). Never printed.
t=$(curl -s -m 3 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
pub=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/public-ipv4)
if [ -x /opt/ma/commons-server/current/address ]; then
  echo "/run/commons-server.address: $(stat -c '%U:%G %a' /run/commons-server.address 2>&1), names IMDS's public IPv4: $([ "$(cat /run/commons-server.address 2>/dev/null)" = "$pub" ] && echo yes || echo no); commons-server-address $(show commons-server-address)"
  [ -n "$pub" ] && [ "$(cat /run/commons-server.address 2>/dev/null)" = "$pub" ] && [ "$(stat -c '%U:%G %a' /run/commons-server.address)" = "root:root 644" ] || bad "/run/commons-server.address should hold exactly the public IPv4, root 0644"
  [ "$(systemctl show -p ExecMainStartTimestampMonotonic --value commons-server)" -ge "$(systemctl show -p ActiveEnterTimestampMonotonic --value commons-server-address)" ] && [ "$(systemctl show -p ActiveEnterTimestampMonotonic --value commons-server-address)" -gt 0 ] || bad "commons-server should start after commons-server-address wrote the address"
else
  echo "no release yet: commons-server-address $(show commons-server-address)"; [ ! -e /run/commons-server.address ] || bad "an address file with no release"
fi
[ -z "$pub" ] || [ "$(journalctl -b -u desk-kind -u commons-server -u commons-server-address -o cat --no-pager | grep -cF "$pub")" = 0 ] || bad "the address is in a guild unit's journal"
pub=; t=
at() { systemctl show -p "$2" --value "$1"; }
for u in desk-rtc deskd desk-guild-net commons-server; do
  s=$(at $u ExecMainStartTimestampMonotonic); echo "$u started at $(( s / 1000 )) ms, desk-kind done at $(( $(at desk-kind ActiveEnterTimestampMonotonic) / 1000 )) ms"
  [ "$s" = 0 ] || [ "$(at desk-kind ActiveEnterTimestampMonotonic)" -le "$s" ] || bad "$u started before desk-kind answered"
done
after_kind
echo "--- [$LABEL] the Browser's side: off"
for u in $BROWSER_UNITS; do echo "$u: $(show $u)"; never_ran $u || bad "$u ran on a Guild Desk"; done
skipped_at_boot desk-preread || bad "desk-preread should have been skipped by its condition at boot"
# The Browser's stack runs as kiosk (Xorg, PulseAudio, Chromium) and stream (desk-stream): nothing may run as either. A
# PulseAudio of verify.sh's own login (admin's user session) isn't the desk's, so it's shown, not counted.
pgrep -x Xorg >/dev/null && bad "Xorg is running"
pgrep -x chromium >/dev/null && bad "chromium is running"
pgrep -u kiosk >/dev/null && bad "something runs as kiosk: $(pgrep -a -u kiosk | head -3 | paste -sd';')"
pgrep -u stream >/dev/null && bad "something runs as stream: $(pgrep -a -u stream | head -3 | paste -sd';')"
pgrep -f /opt/ma/desk-stream/ >/dev/null && bad "desk-stream is running"
echo "processes: Xorg $(pgrep -xc Xorg), chromium $(pgrep -xc chromium), as kiosk $(pgrep -c -u kiosk), as stream $(pgrep -c -u stream), desk-stream $(pgrep -fc /opt/ma/desk-stream/), pulseaudio by user: $(ps -o user= -C pulseaudio | sort | uniq -c | xargs)"
ls /tmp/.X11-unix/ 2>/dev/null | grep -q . && bad "an X socket exists"
echo "--- [$LABEL] what runs"
for u in deskd desk-rtc desk-agent desk-agent-filter desk-egress desk-notebook desk-guild-net desk-guild-rtc commons-data docker nftables; do echo "$u: $(systemctl is-active $u)"; done
for u in deskd desk-rtc desk-agent desk-agent-filter desk-egress desk-guild-net desk-guild-rtc commons-data; do systemctl is-active --quiet $u || bad "$u should be running"; done
p=$(systemctl show -p MainPID --value desk-rtc)
echo "desk-rtc: drop-ins $(systemctl show -p DropInPaths --value desk-rtc), MemoryMax $(systemctl show -p MemoryMax --value desk-rtc), cgroup memory.max $(cat /sys/fs/cgroup/system.slice/desk-rtc.service/memory.max), process $(tr '\0' '\n' < /proc/$p/environ | grep '^GOMEMLIMIT=')"
[ "$(systemctl show -p DropInPaths --value desk-rtc)" = /run/systemd/system/desk-rtc.service.d/50-guild.conf ] || bad "desk-rtc should have the Guild Desk's runtime drop-in only"
[ "$(systemctl show -p MemoryMax --value desk-rtc)" = 536870912 ] && [ "$(cat /sys/fs/cgroup/system.slice/desk-rtc.service/memory.max)" = 536870912 ] || bad "desk-rtc's MemoryMax should be 512M, live"
tr '\0' '\n' < /proc/$p/environ | grep -qx 'GOMEMLIMIT=384MiB' || bad "desk-rtc's process should have GOMEMLIMIT=384MiB"
[ "$(systemctl show -p ExecMainStartTimestampMonotonic --value desk-rtc)" -ge "$(systemctl show -p ActiveEnterTimestampMonotonic --value desk-guild-rtc)" ] || bad "desk-rtc started before its limits were set"
echo "/data/guild: $(stat -c '%U:%G %a' /data/guild 2>&1), /data/guild/commons: $(stat -c '%U:%G %a' /data/guild/commons 2>&1)"
[ "$(stat -c '%U:%G %a' /data/guild /data/guild/commons 2>&1 | paste -sd,)" = "root:root 755,commons:commons 700" ] || bad "commons-data should have made /data/guild (root 755) and /data/guild/commons (commons 700)"
case " $WANT " in *" desk-notebook="*) systemctl is-active --quiet desk-notebook || bad "desk-notebook should be running" ;; esac
for c in $WANT; do c=${c%%=*}; out=$(RELEASE_DIR=/opt/ma/$c/current timeout 30 /opt/ma/$c/current/health 2>&1 </dev/null) && echo "$c health: ok" || bad "$c health: $out"; done
s=$(/opt/ma/smoke-test 2>&1); echo "$s" | tail -2; grep -q '^smoke-test: ok (' <<<"$s" || bad "smoke test"
echo "IMDS for commons (1110): HTTP $(imds_code 1110), deskd (1100): HTTP $(imds_code 1100)"
[ "$(imds_code 1110)" = 000 ] || bad "uid 1110 reaches IMDS"
echo "--- [$LABEL] the Guild Desk's rules: the voice ports in, loopback 8790 and 8799 refused"
d=$(ruleset_diff); echo "diff against nftables.conf alone:"; echo "$d"
guild_diff_ok "$d" || bad "the ruleset should be nftables.conf's plus exactly the Guild Desk's 9 rules"
m=$(tier_members); v=$(tc -j class show dev ens5 | jq -c '.[]|select(.class=="htb" and .handle=="1:30")|{rate,ceil,prio,leaf}')
echo "voice class for $(cat /sys/devices/virtual/dmi/id/product_name), $m members: $v"
[ "$v" = "{\"rate\":$((m * 100000)),\"ceil\":$((m * 100000)),\"prio\":0,\"leaf\":\"0x30\"}" ] || bad "class 1:30 should be $((m * 8 / 10)) Mbit, prio 0"
k=$(tc -j qdisc show dev ens5 | jq -r '[.[]|select(.parent=="1:10" or .parent=="1:30")|.kind]|join(" ")'); echo "leaves of 1:10 and 1:30: $k"
[ "$k" = "fq_codel fq_codel" ] || bad "a Guild Desk's 1:10 and 1:30 should both be fq_codel"
[ "$(nft list chain inet ma output | sed -n 4,9p | grep -c 'comment "ma-guild-commons-')" = 6 ] || bad "the 6 loopback refusals should come first in output"
echo "ran to the end"
X
  } | RS 2>&1
}

kind_guild() {
  local rc o n
  kind_probe_access || true
  # ---- 1k1. First boot of a Guild Desk.
  kind_guild_core "first boot" > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "Guild Desk, first boot: desk-kind answered guild before deskd and desk-rtc, desk-rtc runs with MemoryMax 512M and GOMEMLIMIT 384MiB; nothing ran as kiosk or stream (no Xorg, Chromium, PulseAudio or desk-stream), desk-preread skipped; deskd, desk-rtc, desk-agent, desk-agent-filter, desk-egress, desk-notebook up and healthy, /data/commons made; uid 1110 refused IMDS; the ruleset is nftables.conf's plus the voice rule for the cores, the loopback refusals for 8790 and 8799, the voice labels and TCP 443's limits for the tier; class 1:30 at the tier's ceiling" $rc < $WORKDIR/o

  # ---- 1k2. Nothing can start the Browser: deskd's verbs are refused, and root's starts are skipped.
  { echo "$KLIB"; cat <<'X'
for v in start stop; do for u in desk-xorg desk-audio desk-browser desk-stream desk-adblock; do
  r=$(ask 1100 "$v $u"); echo "deskd: $v $u -> $r"; case "$r" in "err unsupported guild "*) ;; *) bad "$v $u should be refused as unsupported" ;; esac
done; done
for v in freeze thaw; do r=$(ask 1100 "$v desk-browser"); echo "deskd: $v desk-browser -> $r"; case "$r" in "err unsupported guild "*) ;; *) bad "$v should be refused" ;; esac; done
r=$(ask 1100 'restart desk-xorg'); echo "deskd: restart desk-xorg -> $r"; case "$r" in "err bad_request"*) ;; *) bad "a bad request should still be one" ;; esac
r=$(ask 1100 'start desk-rtc'); echo "deskd: start desk-rtc -> $r"; case "$r" in "err denied"*) ;; *) bad "another unit should still be denied" ;; esac
r=$(ask 1102 'start desk-browser'); echo "kiosk: start desk-browser -> $r"; [ "$r" = PermissionError ] || bad "kiosk should be refused by the socket's mode"
journalctl -u 'desk-units@*' -o cat --no-pager --since -2min | grep -c 'a Guild Desk has no Browser' | sed 's/^/desk-units journal lines for the refusals: /'
for u in desk-browser desk-stream desk-xorg desk-audio; do systemctl start $u; echo "root: start $u -> exit $?, $(show $u)"
  [ "$(systemctl is-active $u)" = inactive ] && [ "$(systemctl show -p ConditionResult --value $u)" = no ] || bad "root's start of $u should be skipped by its condition"; done
pgrep -x Xorg >/dev/null && bad "Xorg is running"; pgrep -x chromium >/dev/null && bad "chromium is running"
pgrep -u kiosk >/dev/null && bad "something runs as kiosk"; pgrep -u stream >/dev/null && bad "something runs as stream"
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "Guild Desk, the Browser can't start: every start, stop, freeze and thaw deskd asks for is answered err unsupported guild; bad requests, other units and other uids are refused as before; root's starts are skipped by the units' conditions" $rc < $WORKDIR/o

  # ---- 1k3. commons-server: skipped with no release; with verify's stand-in installed by ma-update, it runs as uid 1110
  # behind the walls, only deskd's uid is let through its socket, and it sees only /data/guild/commons.
  kind_guild_standin
  { echo "$KLIB"; printf 'KSHA=%q; KVER=%q; TC=%q\n' "$KSHA" "$KVER" "$T_COMMONS"; cat <<'X'
echo "commons-server before: $(show commons-server), AMI tag CommonsServerVersion ${TC:-none}"
if [ -z "$TC" ]; then
  [ ! -e /opt/ma/commons-server ] || bad "a commons-server release is on the image with no tag"
  [ "$(systemctl show -p ConditionResult --value commons-server)" = no ] && never_ran commons-server || bad "with no release commons-server should be skipped by its condition"
fi
/opt/ma/bin/ma-update commons-server "file:///var/tmp/commons-server-$KVER.tgz" "$KSHA"; e=$?
echo "ma-update commons-server $KVER: exit $e"; [ $e = 0 ] || bad "ma-update of the stand-in should succeed"
for i in $(seq 1 50); do [ -S /run/desk-commons/commons.sock ] && break; sleep 0.1; done
pid=$(systemctl show -p MainPID --value commons-server)
echo "commons-server: $(show commons-server), pid $pid, uid/gid $(ps -o uid=,gid= -p $pid | xargs)"
[ "$(ps -o uid=,gid= -p $pid | xargs)" = "1110 1110" ] || bad "commons-server should run as 1110:1110"
journalctl -u commons-server -o cat --no-pager | grep '^stand-in:' | head -4
journalctl -u commons-server -o cat --no-pager | grep -q "^stand-in: .*/data holds \['guild'\], /data/guild holds \['commons'\]" || bad "commons-server should see only /data/guild/commons"
journalctl -u commons-server -o cat --no-pager | grep -q '^stand-in: wrote its data dir' || bad "commons-server should write /data/guild/commons"
journalctl -u commons-server -o cat --no-pager | grep -q '^stand-in: /data/browser FileNotFoundError' || bad "commons-server should not see /data/browser"
journalctl -u commons-server -o cat --no-pager | grep -q '^stand-in: .*address file readable' || bad "commons-server should read /run/commons-server.address"
echo "/data/guild/commons: $(stat -c '%U:%G %a' /data/guild/commons 2>&1), $(ls -A /data/guild/commons | paste -sd' '); /run/desk-commons: $(stat -c '%U:%G %a' /run/desk-commons); commons.sock: $(stat -c '%U:%G %a' /run/desk-commons/commons.sock 2>&1)"
[ "$(stat -c '%U:%G %a' /data/guild/commons 2>&1)" = "commons:commons 700" ] || bad "/data/guild/commons should be commons:commons 700"
[ "$(stat -c '%U:%G %a' /run/desk-commons/commons.sock 2>&1)" = "commons:desk 660" ] || bad "commons.sock should be commons:desk 660"
c() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 -I -c "
import socket
s = socket.socket(socket.AF_UNIX)
try: s.connect('/run/desk-commons/commons.sock'); print(s.recv(20).decode().strip())
except OSError as e: print(type(e).__name__)" 2>&1 | tail -1; }
for u in 1100 1102 1103 1105; do r=$(c $u); echo "uid $u connects: $r"; done
[ "$(c 1100)" = ok ] || bad "deskd's uid should get through"
for u in 1102 1103 1105; do [ "$(c $u)" = PermissionError ] || bad "uid $u should be refused by the directory"; done
echo "--- its walls"
systemctl show commons-server -p User -p NoNewPrivileges -p CapabilityBoundingSet -p AmbientCapabilities -p ProtectSystem -p ProtectHome \
  -p PrivateTmp -p PrivateDevices -p ProtectProc -p RestrictNamespaces -p MemoryDenyWriteExecute -p MemoryMax -p RestrictAddressFamilies -p TemporaryFileSystem -p BindPaths
[ "$(systemctl show -p NoNewPrivileges --value commons-server)" = yes ] || bad "NoNewPrivileges"
[ -z "$(systemctl show -p CapabilityBoundingSet --value commons-server)" ] || bad "it should hold no capability"
[ "$(grep -E '^Cap(Eff|Prm|Bnd|Amb)' /proc/$pid/status | awk '{print $2}' | sort -u)" = 0000000000000000 ] || bad "the process holds a capability: $(grep ^Cap /proc/$pid/status | paste -sd' ')"
grep -E '^(NoNewPrivs|Seccomp):' /proc/$pid/status | paste -sd' '
[ "$(awk '/^NoNewPrivs:/{print $2}' /proc/$pid/status)" = 1 ] && [ "$(awk '/^Seccomp:/{print $2}' /proc/$pid/status)" = 2 ] || bad "no_new_privs and a seccomp filter should be on"
systemd-analyze security commons-server 2>/dev/null | tail -1 | sed 's/^/systemd-analyze security: /'
echo "--- its ports"; ss -lnup | grep -E ':879[0-9] '
n=$(cores); for p in $(seq 8791 $((8790 + n))); do ss -lnup | grep -E ":$p .*pid=$pid," >/dev/null || bad "commons-server isn't on UDP $p"; done
[ "$(ss -lnup | grep -cE ':879[0-9] ')" = "$n" ] || bad "something else listens on 8790-8799"
s=$(/opt/ma/smoke-test 2>&1); echo "$s" | tail -2; grep -q '^smoke-test: ok (' <<<"$s" || bad "smoke test with commons-server"
echo "--- loopback, with a root listener on both addresses: TCP 8790 only for root and commons; TCP and UDP 8799 only for rtc"
python3 -I -c 'import select, socket, time
ls = []
for fam, a in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
    for p in (8790, 8799):
        s = socket.socket(fam); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((a, p)); s.listen(16); ls.append(s)
    u = socket.socket(fam, socket.SOCK_DGRAM); u.bind((a, 8799)); ls.append(u)
end = time.time() + 60
while time.time() < end:
    for s in select.select(ls, [], [], 1)[0]:
        if s.type == socket.SOCK_DGRAM:
            d, a = s.recvfrom(100); s.sendto(d, a)
        else:
            s.accept()[0].close()' & L=$!
for i in $(seq 1 50); do ss -lnu | grep -q '\[::1\]:8799 ' && break; sleep 0.1; done
try() { setpriv --reuid=$1 --regid=$1 --clear-groups python3 -I -c "import socket, sys
a, p, k = sys.argv[1], int(sys.argv[2]), sys.argv[3]
fam = socket.AF_INET6 if ':' in a else socket.AF_INET
try:
    if k == 'tcp':
        socket.create_connection((a, p), timeout=3); print('connected')
    else:
        u = socket.socket(fam, socket.SOCK_DGRAM); u.settimeout(2); u.connect((a, p)); u.send(b'x'); print('echoed' if u.recv(10) == b'x' else 'other')
except OSError as e:
    print(type(e).__name__)" "$2" "$3" "$4" 2>&1 | tail -1; }
for u in 0 1100 1101 1102 1103 1105 1110; do for a in 127.0.0.1 ::1; do
  r=$(try $u $a 8790 tcp); echo "uid $u -> $a tcp 8790: $r"
  case $u in 0|1110) [ "$r" = connected ] || bad "uid $u should reach $a:8790 (the control)" ;; *) [ "$r" = ConnectionRefusedError ] || bad "uid $u should be refused $a:8790" ;; esac
  for k in tcp udp; do r=$(try $u $a 8799 $k); echo "uid $u -> $a $k 8799: $r"
    if [ $u = 1101 ]; then case $r in connected|echoed) ;; *) bad "rtc should reach $a $k 8799" ;; esac
    else case $r in connected|echoed) bad "uid $u reached $a $k 8799, which only rtc may" ;; esac; fi
  done
done; done
kill $L 2>/dev/null; wait $L 2>/dev/null
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "commons-server: skipped with no release; a stand-in installed by ma-update runs as 1110:1110 with no capability, no_new_privs and seccomp, sees only /data/guild/commons, binds UDP 8791 up for its cores; only deskd's uid gets through commons.sock; only root and commons reach loopback TCP 8790, and only rtc reaches loopback 8799, TCP and UDP" $rc < $WORKDIR/o

  # ---- 1k4. From outside: the stand-in's ports answer, the rest of 8791-8799 don't with a listener behind each, nor TCP 8790.
  n=$(R 'n=$(nproc); [ $n -le 8 ] || n=8; echo $n')
  rest=$(seq -s, $((8791 + n)) 8799)
  kind_echo "$rest" > $WORKDIR/o 2>&1
  { echo "--- probe from this workstation ($n cores: 8791 to $((8790 + n)) are commons-server's)"; kind_probe; } >> $WORKDIR/o 2>&1
  RS >> $WORKDIR/o 2>&1 <<'X'
echo "--- what reached the listeners"; journalctl -u verify-echo -o cat --no-pager | grep -v '^Started\|^Stopped'
journalctl -u commons-server -o cat --no-pager | grep 'got a probe' | sort | uniq -c
systemctl stop verify-echo
X
  o=$(cat $WORKDIR/o); rc=0
  for p in $(seq 8791 8799); do
    if [ "$p" -le $((8790 + n)) ]; then grep -q "^udp $p open\$" <<<"$o" || { echo "BAD: UDP $p, commons-server's, didn't answer" >> $WORKDIR/o; rc=1; }
    else grep -q "^udp $p closed\$" <<<"$o" || { echo "BAD: UDP $p answered" >> $WORKDIR/o; rc=1; }; fi
  done
  for t in 8790 8799; do grep -q "^tcp $t closed\$" <<<"$o" || { echo "BAD: TCP $t connected" >> $WORKDIR/o; rc=1; }; done
  grep -q '^udp 879[0-9] got a probe' <<<"$o" && { echo "BAD: a probe reached a closed port's listener" >> $WORKDIR/o; rc=1; }
  grep -q '^tcp 879[09] connection' <<<"$o" && { echo "BAD: a TCP probe reached a listener" >> $WORKDIR/o; rc=1; }
  result "Guild Desk, from outside: UDP 8791 to 8790+cores answer (commons-server's), the rest of 8791-8799 (Commons' loopback relay port included) and TCP 8790 and 8799 are closed by nftables with a listener behind each" $rc < $WORKDIR/o

  # ---- 1k5. The voice rule survives nftables' own restart and reload, exactly once, and the helper adds no copy.
  { echo "$KLIB"; cat <<'X'
for how in restart reload helper; do
  case $how in helper) /usr/local/lib/ma/desk-guild-net ;; *) systemctl $how nftables; nft add rule inet ma input tcp dport 22 accept ;; esac
  echo "after $how: voice rules $(voice_rules), loopback 8790 refusals $(local_rules), 8799 refusals $(relay_rules), diff lines $(ruleset_diff | grep -c '^[<>]')"
  guild_diff_ok "$(ruleset_diff)" || bad "after $how there should be exactly the Guild Desk's 9 rules and nothing else changed"
done
for i in $(seq 1 60); do systemctl is-active --quiet desk-agent && break; sleep 1; done
systemctl is-active --quiet desk-agent || bad "desk-agent (which Requires nftables) didn't come back"
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "Guild Desk, nftables restart and reload: the Guild Desk's 9 rules come back exactly once, and running desk-guild-net again adds no copy" $rc < $WORKDIR/o

  # ---- 1k5a. The Guild Engineer's real release, when VERIFY_COMMONS_TGZ names one (apps/commons/release.sh's artifact):
  # installed over the stand-in by ma-update, healthy by its own health, behind the walls, on its socket and ports.
  # When the AMI has the real release baked (its CommonsServerVersion tag), 1k3's stand-in went over it and the baked one is
  # `previous`: ma-update refuses the same version again, so this puts it back with --rollback and runs on the baked bytes.
  if [ -n "${VERIFY_COMMONS_TGZ:-}" ] || [ -n "$T_COMMONS" ]; then
    if [ -z "$T_COMMONS" ]; then scp "${SSH_OPTS[@]}" -i "$KEY_FILE" "$VERIFY_COMMONS_TGZ" "admin@$IP:/var/tmp/commons-real.tgz" >/dev/null; fi
    { echo "$KLIB"; printf 'RSHA=%q; TC=%q\n' "$([ -n "$T_COMMONS" ] || sha256sum < "$VERIFY_COMMONS_TGZ" | cut -c1-64)" "$T_COMMONS"; cat <<'X'
if [ -n "$TC" ]; then
  echo "baked release: $(ls /opt/ma/commons-server/releases | paste -sd' '), current $(cat /opt/ma/commons-server/current/VERSION), AMI tag $TC"
  /opt/ma/bin/ma-update commons-server --rollback; e=$?; echo "ma-update --rollback: exit $e"; [ $e = 0 ] || bad "putting the baked release back should succeed"
  [ "$(cat /opt/ma/commons-server/current/VERSION)" = "$TC" ] || bad "the baked release should be current again: $(cat /opt/ma/commons-server/current/VERSION) against $TC"
  for i in $(seq 1 100); do [ -S /run/desk-commons/commons.sock ] && break; sleep 0.1; done
else
echo "release: $(tar -tzf /var/tmp/commons-real.tgz | paste -sd' '), version $(tar -xzOf /var/tmp/commons-real.tgz ./VERSION 2>/dev/null || tar -xzOf /var/tmp/commons-real.tgz VERSION)"
/opt/ma/bin/ma-update commons-server file:///var/tmp/commons-real.tgz "$RSHA"; e=$?; echo "ma-update: exit $e"; [ $e = 0 ] || bad "ma-update of the real release should succeed"
fi
pid=$(systemctl show -p MainPID --value commons-server)
echo "commons-server: $(show commons-server), pid $pid, $(ps -o uid=,gid=,comm= -p $pid | xargs)"
[ "$(ps -o uid=,gid= -p $pid | xargs)" = "1110 1110" ] && [ "$(ps -o comm= -p $pid)" = commons-server ] || bad "the real commons-server should run as 1110:1110"
journalctl -u commons-server -o cat --no-pager -n 30 | grep -v '^$' | tail -8
out=$(RELEASE_DIR=/opt/ma/commons-server/current timeout 30 /opt/ma/commons-server/current/health 2>&1) && echo "its health: ok" || bad "its health: $out"
echo "/healthz as root: $(curl -s -m 3 http://127.0.0.1:8790/healthz)"
for u in 1100 1103; do r=$(setpriv --reuid=$u --regid=$u --clear-groups curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/healthz); echo "/healthz as $u: $r"; [ "$r" = 000 ] || bad "uid $u reached commons-server's loopback port"; done
n=$(cores); for p in $(seq 8791 $((8790 + n))); do ss -lnup | grep -E "0.0.0.0:$p .*pid=$pid," >/dev/null || bad "commons-server isn't on UDP $p"; done
ss -lnup | grep -E ':879[0-9] '; ss -lntp | grep -E ':879[0-9] '
# The relay port desk-rtc forwards 443's Commons ICE to (sub/guild-rtc-443): on loopback only, and only rtc gets in.
ss -lnup | grep -E "127.0.0.1:8799 .*pid=$pid," >/dev/null && ss -lntp | grep -E "127.0.0.1:8799 .*pid=$pid," >/dev/null || bad "commons-server should listen on 127.0.0.1:8799, UDP and TCP"
ss -lnup | grep -E '(0.0.0.0|\*|\[::\]):8799 ' && bad "something listens on 8799 beyond loopback"
for u in 1101 1103 1100; do r=$(setpriv --reuid=$u --regid=$u --clear-groups python3 -I -c "import socket
try: socket.create_connection(('127.0.0.1', 8799), timeout=3); print('connected')
except OSError as e: print(type(e).__name__)" 2>&1 | tail -1); echo "uid $u -> commons-server's 127.0.0.1:8799 tcp: $r"
  if [ $u = 1101 ]; then [ "$r" = connected ] || bad "rtc should reach commons-server's 8799"; else [ "$r" = ConnectionRefusedError ] || bad "uid $u should be refused 8799"; fi; done
[ "$(stat -c '%U:%G %a' /run/desk-commons/commons.sock 2>&1)" = "commons:desk 660" ] || bad "commons.sock should be commons:desk 660"
r=$(setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "import socket
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk-commons/commons.sock'); print('connected')" 2>&1 | tail -1); echo "deskd's uid connects: $r"; [ "$r" = connected ] || bad "deskd's uid should connect"
echo "data: $(ls -A /data/guild/commons | paste -sd' ')"
grep -E '^(Cap(Eff|Prm|Bnd|Amb)|NoNewPrivs|Seccomp):' /proc/$pid/status | paste -sd' '
[ "$(grep -E '^Cap(Eff|Prm|Bnd|Amb)' /proc/$pid/status | awk '{print $2}' | sort -u)" = 0000000000000000 ] || bad "it holds a capability"
t=$(curl -s -m 3 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
pub=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/public-ipv4)
tr '\0' '\n' < /proc/$pid/cmdline | grep -qxF -- "$pub" && echo "advertises the public IPv4 (from /run/commons-server.address): yes" || bad "commons-server should be given -advertise with the public IPv4"
[ "$(cat /run/commons-server.address 2>/dev/null)" = "$pub" ] || bad "the real release's address unit should have written the public IPv4"
echo "IMDS from commons-server's cgroup: $(systemctl show -p IPAddressDeny --value commons-server)"
[ "$(journalctl -u commons-server -o cat --no-pager | grep -cF "$pub")" = 0 ] || bad "the address is in commons-server's journal"
pub=; t=
s=$(/opt/ma/smoke-test 2>&1); echo "$s" | tail -2; grep -q '^smoke-test: ok (' <<<"$s" || bad "smoke test with the real commons-server"
echo "ran to the end"
X
    } | RS > $WORKDIR/o 2>&1; rc=0
    grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
    result "commons-server, the real release ($( [ -n "$T_COMMONS" ] && echo "baked, $T_COMMONS" || basename "$VERIFY_COMMONS_TGZ")): installed by ma-update, healthy by its own health, 1110:1110 with no capability, its UDP ports and socket, its loopback relay port 8799 for rtc alone, -advertise from commons-server-address's file with the address in no journal, loopback 8790 closed to uids 1100 and 1103" $rc < $WORKDIR/o
  fi

  # ---- 1k7. The voice class and the guild's budget (desk-egress on a Guild Desk, image/README.md "Guild Desk"): the
  # tier's ceiling, who lands in it, --check needs it and the daemon puts it back, and on a lowered day line voice and
  # desk-rtc's class slow down and come back. Tiers by this script's own table, not guild.conf.
  { echo "$KLIB"; cat <<'X'
m=$(tier_members); it=$(cat /sys/devices/virtual/dmi/id/product_name); rtc=$(( m * 3 / 4 > 60 ? m * 3 / 4 : 60 )); echo "instance type $it, $m members by the table, desk-rtc's class $rtc Mbit"
tc class show dev ens5 | grep htb; tc qdisc show dev ens5 | grep -E 'htb|pfifo|fq_codel' | cut -c1-70
tc -j -s class show dev ens5 > /var/tmp/cl.json
python3 -I - "$m" "$rtc" <<'P' || bad "the classes aren't a Guild Desk's"
import json, sys
m, rtc = int(sys.argv[1]), int(sys.argv[2])
want = {"1:10": (rtc * 125000, 1048576, 0, "0x10"), "1:15": (250000, None, 0, "0x15"), "1:20": (12500000, 262144, 1, "0x20"), "1:30": (m * 100000, 1048576, 0, "0x30")}
got = {c["handle"]: c for c in json.load(open("/var/tmp/cl.json")) if c.get("class") == "htb"}
ok = set(got) == set(want)
for h, (rate, burst, prio, leaf) in want.items():
    c = got.get(h, {})
    ok = ok and c.get("rate") == rate and c.get("ceil") == rate and c.get("prio") == prio and c.get("leaf") == leaf and (burst is None or (c.get("burst") == burst and c.get("cburst") == burst))
print("classes as specified" if ok else got); sys.exit(0 if ok else 1)
P
[ "$(tc -j qdisc show dev ens5 | jq -r '.[]|select(.parent=="1:30")|.kind')" = fq_codel ] || bad "1:30's leaf should be fq_codel"
[ "$(tc -j qdisc show dev ens5 | jq -r '.[]|select(.parent=="1:10")|.kind')" = fq_codel ] || bad "1:10's leaf should be fq_codel on a Guild Desk"
# The day line: 4 GB a member, capped at 120 GB until Platform's guard knows a Guild Desk (Security's NET031-1).
day=$(( m * 4 < 120 ? m * 4 : 120 ))
l="desk-egress: Guild Desk: $it, $m members: voice $((m * 8 / 10)) Mbit, desk-rtc $rtc Mbit, day line $day GB"
[ $day = $((m * 4)) ] || l="$l, capped from the members' $((m * 4)) until Platform's guard knows Guild Desks (under 105 again"
journalctl -b -u desk-egress -o cat --no-pager | grep -F "$l" | tail -1; journalctl -b -u desk-egress -o cat --no-pager | grep -qF "$l" || bad "desk-egress should say: $l"
/opt/ma/desk-egress/current/desk-egress --check || bad "--check"
RELEASE_DIR=/opt/ma/desk-egress/current /opt/ma/desk-egress/current/health || bad "health"
for i in $(seq 1 70); do [ -s /data/desk-egress/state.json ] && break; sleep 1; done
echo "state: $(jq -c '{guarded,profile,slowed,clamped}' /data/desk-egress/state.json), profile file $(cat /run/desk-egress/profile)"
[ "$(jq -c '{guarded,profile,clamped}' /data/desk-egress/state.json)" = '{"guarded":false,"profile":"normal","clamped":false}' ] || bad "a Guild Desk's state should be unguarded, normal and unclamped"
echo "--- who lands where (desk-rtc and commons-server stopped meanwhile)"
was=$(systemctl is-active commons-server); systemctl stop desk-rtc commons-server
GW=$(ip -j route show default | jq -r '.[0].gateway')
cat > /var/tmp/send2.py <<'P'
import socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
if sys.argv[2] != "0": s.bind(("0.0.0.0", int(sys.argv[2])))
first, n = bytes([int(sys.argv[3], 16)]), int(sys.argv[4]) if len(sys.argv) > 4 else 200
rate = float(sys.argv[5]) * 1e6 / 8 if len(sys.argv) > 5 else 0
t0, sent = time.monotonic(), 0
for _ in range(n):
    s.sendto(first + b"x" * 1199 if rate else first + b"x" * 99, (sys.argv[1], 9)); sent += 1200
    if rate and sent / rate > time.monotonic() - t0 + 0.002: time.sleep(sent / rate - (time.monotonic() - t0))
P
chmod 644 /var/tmp/send2.py
count() { tc -j -s class show dev ens5 | jq -r --arg h "$1" '.[]|select(.class=="htb" and .handle==$h)|.stats.packets'; }
as() { echo setpriv --reuid=$1 --regid=$1 --clear-groups; }
cap="--inh-caps=+net_bind_service --ambient-caps=+net_bind_service"
sends() { local name=$1 want=$2 port=$3 first=$4; shift 4; local a b; a=$(count "$want"); "$@" python3 -I /var/tmp/send2.py "$GW" "$port" "$first"; sleep 1; b=$(count "$want")
  if [ $((b - a)) -ge 200 ]; then echo "ok: $name -> $want ($((b - a)) packets)"; else bad "$name: $want saw $((b - a)) of 200 packets"; fi; }
sends "rtc from 443, RTP (0x80)" 1:30 443 80 $(as 1101) $cap
sends "rtc from 443, RTCP (0xbf)" 1:30 443 bf $(as 1101) $cap
sends "rtc from 443, DTLS (0x17)" 1:10 443 17 $(as 1101) $cap
sends "rtc from 443, STUN (0x00)" 1:10 443 00 $(as 1101) $cap
sends "rtc from 443, 0xc0" 1:10 443 c0 $(as 1101) $cap
sends "commons from 8791" 1:30 8791 80 $(as 1110)
sends "commons from 8791, any first byte" 1:30 8791 17 $(as 1110)
sends "commons from another port" 1:20 9000 80 $(as 1110)
sends "kiosk from 8791" 1:20 8791 80 $(as 1102)
sends "root" 1:15 0 80 env
echo "--- a pfifo under 1:10, as an older desk-egress left it: the daemon puts fq_codel back within a tick"
tc qdisc del dev ens5 parent 1:10 handle 10: && tc qdisc replace dev ens5 parent 1:10 handle 10: pfifo limit 1000
k=$(tc -j qdisc show dev ens5 | jq -r '.[]|select(.parent=="1:10")|.kind'); echo "1:10's leaf now: $k"; [ "$k" = pfifo ] || bad "couldn't put a pfifo under 1:10, so this proves nothing"
for i in $(seq 1 75); do [ "$(tc -j qdisc show dev ens5 | jq -r '.[]|select(.parent=="1:10")|.kind')" = fq_codel ] && break; sleep 1; done
[ "$(tc -j qdisc show dev ens5 | jq -r '.[]|select(.parent=="1:10")|.kind')" = fq_codel ] && echo "ok: fq_codel back after $i s" || bad "1:10's pfifo stayed"
echo "--- --check needs 1:30, and the daemon puts it back within a tick"
tc class del dev ens5 classid 1:30; /opt/ma/desk-egress/current/desk-egress --check 2>&1 && bad "--check passed with 1:30 gone"
for i in $(seq 1 75); do /opt/ma/desk-egress/current/desk-egress --check 2>/dev/null && break; sleep 1; done
/opt/ma/desk-egress/current/desk-egress --check && echo "ok: back after $i s" || bad "1:30 didn't come back"
echo "--- the guild's day line, lowered to 15 MB past what this boot has sent, with a 2 s tick"
cp -a /etc/ma/egress.conf /var/tmp/egress.conf.keep; cp -a /etc/ma/guild.conf /var/tmp/guild.conf.keep
sed -i 's/^tick_seconds = .*/tick_seconds = 2/' /etc/ma/egress.conf
day=$(jq '[.windows[][1]]|add // 0' /data/desk-egress/state.json)
python3 -I - "$day" "$m" <<'P'
import configparser, sys
day, m = float(sys.argv[1]), int(sys.argv[2])
p = configparser.ConfigParser(); p.read("/etc/ma/guild.conf")
p["egress"]["day_gb_per_member"] = f"{(day + 15e6) / m / 1e9:.12f}"
p["egress"]["day_release_gb_per_member"] = f"{(day + 10e6) / m / 1e9:.12f}"
with open("/etc/ma/guild.conf", "w") as f: p.write(f)
P
python3 -I -c 'import configparser; p = configparser.ConfigParser(); p.read("/etc/ma/guild.conf"); print(dict(p["egress"]))' 2>&1 | tail -1
systemctl restart desk-egress; sleep 5
rate() { tc -j class show dev ens5 | jq -r --arg h "$1" '.[]|select(.handle==$h)|.rate'; }
echo "before: 1:30 $(rate 1:30), 1:10 $(rate 1:10) bytes/s, guarded $(jq .guarded /data/desk-egress/state.json)"
[ "$(rate 1:30)" = $((m * 100000)) ] || bad "voice shouldn't be guarded before anything is sent"
$(as 1110) python3 -I /var/tmp/send2.py "$GW" 8791 80 $((m * 500)) $((m * 6 / 10))   # m x 0.6 MB at m x 0.6 Mbit: 8 s
for i in $(seq 1 30); do [ "$(rate 1:30)" = $((m * 25000)) ] && break; sleep 1; done
echo "after $i s: 1:30 $(rate 1:30), 1:10 $(rate 1:10) bytes/s, guarded $(jq .guarded /data/desk-egress/state.json)"
journalctl -u desk-egress -o cat --no-pager --since -1min | grep -m1 'guarded=True'
[ "$(rate 1:30)" = $((m * 25000)) ] && [ "$(rate 1:10)" = $((m * 12500)) ] || bad "past the line voice should be $((m / 5)) Mbit and desk-rtc's class $((m / 10)) Mbit"
# Restored, the saved guard holds until the first tick decides again with the real line: up to tick_seconds, 60 s.
mv -f /var/tmp/egress.conf.keep /etc/ma/egress.conf; mv -f /var/tmp/guild.conf.keep /etc/ma/guild.conf; systemctl restart desk-egress
for i in $(seq 1 75); do [ "$(rate 1:30)" = $((m * 100000)) ] && [ "$(rate 1:10)" = $((rtc * 125000)) ] && break; sleep 1; done
echo "back after $i s: 1:30 $(rate 1:30), 1:10 $(rate 1:10) bytes/s, guarded $(jq .guarded /data/desk-egress/state.json)"
[ "$(rate 1:30)" = $((m * 100000)) ] && [ "$(rate 1:10)" = $((rtc * 125000)) ] || bad "with the real line voice and desk-rtc's class should be back"
systemctl start desk-rtc; [ "$was" = active ] && systemctl start commons-server
for i in $(seq 1 30); do systemctl is-active --quiet desk-rtc && break; sleep 1; done
systemctl is-active --quiet desk-rtc || bad "desk-rtc didn't come back"
[ "$was" != active ] || systemctl is-active --quiet commons-server || bad "commons-server didn't come back"
echo "ran to the end"
X
  } | RS > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; grep -q '^ran to the end$' $WORKDIR/o || rc=1
  result "desk-egress, Guild Desk: class 1:30 at 0.8 Mbit a member of the tier, prio 0, fq_codel; 1:10 at 0.75 Mbit a member (60 at least) on fq_codel, put back from a pfifo within a tick; 1:15 and 1:20 as a member's; Commons from its ports and desk-rtc's RTP from 443 land in it, desk-rtc's STUN and DTLS in 1:10, the rest as before; --check needs it and the daemon puts it back; the day line 4 GB a member, capped at 120 GB; past a lowered day line voice and desk-rtc's class drop to 0.2 and 0.1 Mbit a member and come back" $rc < $WORKDIR/o

  # ---- 1k6. A reboot: read again, the same answer, the same ports, commons-server back, the Browser still off.
  R 'sudo systemctl reboot' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do R true >/dev/null 2>&1 || break; sleep 2; done
  wait_ssh "$IP" "$KEY_FILE" 420 || say "ssh didn't come back after the reboot"
  R 'cloud-init status --wait >/dev/null 2>&1; for i in $(seq 1 120); do systemctl is-active --quiet deskd && journalctl -b -t deskd -o cat --no-pager | grep -q "deskd ready in" && break; sleep 2; done' >/dev/null 2>&1
  { kind_guild_core "after a reboot"
    { echo "$KLIB"; cat <<'X'
pid=$(systemctl show -p MainPID --value commons-server); echo "commons-server: $(show commons-server), uid $(ps -o uid= -p $pid | xargs)"
systemctl is-active --quiet commons-server && [ -S /run/desk-commons/commons.sock ] || bad "commons-server should be back"
echo "ran to the end"
X
    } | RS 2>&1
  } > $WORKDIR/o 2>&1; rc=0
  grep -q -e '^FAILED$' $WORKDIR/o && rc=1; [ "$(grep -c '^ran to the end$' $WORKDIR/o)" = 2 ] || rc=1
  result "Guild Desk after a reboot: guild again, the Browser still off, the services and commons-server back, the Guild Desk's 9 rules once, the voice class at the tier's ceiling" $rc < $WORKDIR/o
}
