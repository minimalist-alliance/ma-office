#!/bin/bash
# EXP-9 with real connections: in a network namespace of its own, the self-hosted desk's firewall refuses the Browser's
# user (1102) every address on the desk's own networks, IPv6 and IPv4, whatever the addresses, while root and deskd (1100)
# still reach them, and an address reached through a router stays open to the Browser. The sets follow the network, and a
# reload of the firewall loads them with the rules. It fails closed (Nov 11): without ma-selfhost-net's mark in ipv6_ok,
# the Browser gets no IPv6 beyond loopback (a reset, at once) while its IPv4 goes on, and the mark lapses by itself.
#
# Root in a throwaway container with NET_ADMIN, never on a desk: it adds users and interfaces and loads a ruleset. It needs
# nft, ip, python3, curl and setpriv (Debian 13 with nftables, iproute2, python3 and curl). From the repository's root:
#   docker run --rm --cap-add NET_ADMIN -v "$PWD:/src:ro" <that image> bash /src/selfhost/tests/firewall.sh [<nftables.conf>]
# With a path it loads that ruleset instead: main's from before the fix fails the Browser's checks.
#
# Every address here is the box's own (dummy links), from the documentation ranges, so nothing leaves it. desk-agent-filter's
# rules (1106) need a route that isn't loopback, which a single namespace can't give: the stand-in proof covers them
# (docs/sub-status/selfhost-exp.md).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CONF=${1:-$HERE/../files/etc/nftables.conf}
NET=$HERE/../files/usr/local/lib/ma/selfhost/ma-selfhost-net
[ "$(id -u)" = 0 ] || { echo "firewall.sh: root, in a throwaway container" >&2; exit 2; }
for spec in desk:1100 kiosk:1102; do
  n=${spec%%:*} u=${spec##*:}
  getent group "$n" >/dev/null || groupadd -g "$u" "$n"
  id "$n" >/dev/null 2>&1 || useradd -u "$u" -g "$u" -M -d /nonexistent -s /usr/sbin/nologin "$n"
done
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
code() { # uid url -> the HTTP code, or 000 when the connection was refused
  setpriv --reuid="$1" --regid="$1" --clear-groups curl -sS -m 3 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || true
}
want() { # name uid url expected
  local got; got=$(code "$2" "$3")
  [ "$got" = "$4" ] && ok "$1 ($got)" || bad "$1: got $got, want $4"
}
inset() { nft list set inet ma "$1" 2>/dev/null | tr -d '\n' | grep -q -- "$2"; }
fresh() { inset ipv6_ok 'elements = {'; }
ms() { # uid url -> the HTTP code (000 when refused) and how many ms the answer took
  local t0 got; t0=$(date +%s%N); got=$(code "$1" "$2")
  echo "$got $(( ($(date +%s%N) - t0) / 1000000 ))"
}

# The desk's link to the home network: a global IPv6 prefix and a public IPv4 one, the desk's address on each and a second
# address standing for a device on that network. A second link holds one address of each family with no route of its own,
# standing for the internet (reached through a router, so on no link of the desk's).
ip link add ma-lan type dummy && ip link set ma-lan up
ip -6 addr add 2001:db8:5f::1/64 dev ma-lan nodad && ip -6 addr add 2001:db8:5f::2/64 dev ma-lan nodad
ip addr add 203.0.113.1/29 dev ma-lan && ip addr add 203.0.113.2/29 dev ma-lan
ip link add ma-far type dummy && ip link set ma-far up
ip -6 addr add 2001:db8:ff00::1/128 dev ma-far nodad noprefixroute && ip addr add 198.51.100.1/32 dev ma-far noprefixroute
python3 -m http.server --bind :: 8080 >/dev/null 2>&1 &
srv=$!
trap 'kill $srv 2>/dev/null' EXIT

# 1. The ruleset loads before ma-selfhost-net has ever run (a boot: nothing to include yet).
rm -rf /run/ma-selfhost-net
nft -c -f "$CONF" && ok "1. it loads with no list to include yet" || bad "1. nft -c failed with no list"
nft -f "$CONF" || { bad "1. nft -f failed"; exit 1; }
sleep 0.5
# 2. Filled once, as ma-selfhost-net.service does when it starts.
python3 -I "$NET" fill >/dev/null 2>&1 || true
inset home6 2001:db8:5f::/64 && ok "2. home6 holds the home network's /64" || echo "info 2. home6 doesn't hold it (this ruleset may have no set)"
inset home4 203.0.113.0/29 && ok "2. home4 holds its public /29" || echo "info 2. home4 doesn't hold it"
inset home6 2001:db8:ff00:: && bad "2. home6 holds the far address" || ok "2. home6 leaves out what's reached through a router"

# 3. Who reaches what.
want "3. the Browser to a home device's global IPv6: refused" 1102 "http://[2001:db8:5f::2]:8080/" 000
want "3. the Browser to the desk's own global IPv6: refused" 1102 "http://[2001:db8:5f::1]:8080/" 000
want "3. the Browser to a home device on public IPv4: refused" 1102 "http://203.0.113.2:8080/" 000
want "3. the Browser to an IPv6 address through a router: open" 1102 "http://[2001:db8:ff00::1]:8080/" 200
want "3. the Browser to an IPv4 address through a router: open" 1102 "http://198.51.100.1:8080/" 200
want "3. deskd to the home device's IPv6: open" 1100 "http://[2001:db8:5f::2]:8080/" 200
want "3. root to the home device's IPv6: open" 0 "http://[2001:db8:5f::2]:8080/" 200
want "3. root to the home device's IPv4: open" 0 "http://203.0.113.2:8080/" 200

# 4. The network changes while ma-selfhost-net watches: a new prefix is in within a second or so, and out again.
python3 -I "$NET" watch >/tmp/net-watch.log 2>&1 &
w=$!
sleep 1
t0=$(date +%s%N)
ip -6 addr add 2001:db8:5e::1/64 dev ma-lan nodad
n=0; until inset home6 2001:db8:5e::/64 || [ $n -ge 50 ]; do sleep 0.1; n=$((n + 1)); done
inset home6 2001:db8:5e::/64 && ok "4. a new prefix joins home6 in $(( ($(date +%s%N) - t0) / 1000000 )) ms" || bad "4. a new prefix never joined home6"
want "4. and the Browser is refused it" 1102 "http://[2001:db8:5e::1]:8080/" 000
ip -6 addr del 2001:db8:5e::1/64 dev ma-lan
n=0; while inset home6 2001:db8:5e::/64 && [ $n -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
inset home6 2001:db8:5e::/64 && bad "4. a removed prefix stayed in home6" || ok "4. a removed prefix leaves home6"

# 5. A reload of the firewall (flush ruleset, then the file) loads the list in the same transaction: no gap. It never loads
#    the mark, so until ma-selfhost-net has filled again (the reload's HUP) the Browser's IPv6 stays closed.
kill -STOP $w
nft -f "$CONF"
inset home6 2001:db8:5f::/64 && ok "5. after a reload, home6 is full at once (the include)" || bad "5. after a reload, home6 was empty"
want "5. and the Browser is still refused" 1102 "http://[2001:db8:5f::2]:8080/" 000
fresh && bad "5. the reload brought ipv6_ok back by itself" || ok "5. the reload leaves ipv6_ok empty"
want "5. so the Browser's IPv6 through a router is refused until ma-selfhost-net fills again" 1102 "http://[2001:db8:ff00::1]:8080/" 000
kill -CONT $w; kill -HUP $w
n=0; until fresh || [ $n -ge 50 ]; do sleep 0.1; n=$((n + 1)); done
fresh && ok "5. ma-selfhost-net's HUP fills ipv6_ok again" || bad "5. no ipv6_ok after the HUP"
want "5. and the Browser's IPv6 through a router is open again" 1102 "http://[2001:db8:ff00::1]:8080/" 200
kill $w 2>/dev/null; wait $w 2>/dev/null

# 6. Fails closed. Without the mark (as 3 minutes after ma-selfhost-net stopped), the Browser gets no IPv6 beyond loopback,
#    refused at once so Chromium goes straight to IPv4, while its IPv4 and everyone else's IPv6 go on. A fill brings it back.
python3 -I "$NET" fill >/dev/null 2>&1 || true
fresh && ok "6. a fill puts the Browser in ipv6_ok" || bad "6. a fill left ipv6_ok empty"
nft flush set inet ma ipv6_ok
read -r got t <<<"$(ms 1102 "http://[2001:db8:ff00::1]:8080/")"
[ "$got" = 000 ] && [ "$t" -lt 500 ] && ok "6. without it, the Browser's IPv6 through a router is refused in $t ms" \
  || bad "6. without it, the Browser's IPv6 through a router: got $got in $t ms, want 000 under 500 ms"
want "6. its IPv4 through a router still works" 1102 "http://198.51.100.1:8080/" 200
want "6. its IPv6 loopback still works" 1102 "http://[::1]:8080/" 200
want "6. home4 still holds: the home device's public IPv4 is refused" 1102 "http://203.0.113.2:8080/" 000
want "6. deskd's IPv6 still works" 1100 "http://[2001:db8:ff00::1]:8080/" 200
want "6. root's IPv6 still works" 0 "http://[2001:db8:ff00::1]:8080/" 200
python3 -I "$NET" fill >/dev/null 2>&1 || true
want "6. a fill opens the Browser's IPv6 again" 1102 "http://[2001:db8:ff00::1]:8080/" 200
# The kernel's own timeout, with the same ruleset but a 2-second one in place of 3 minutes.
sed 's/flags timeout; timeout 3m;/flags timeout; timeout 2s;/' "$CONF" > /tmp/nft-short.conf && nft -f /tmp/nft-short.conf
python3 -I "$NET" fill >/dev/null 2>&1 || true
want "6. (2 s timeout) marked: the Browser's IPv6 is open" 1102 "http://[2001:db8:ff00::1]:8080/" 200
sleep 3
fresh && bad "6. (2 s timeout) the mark didn't lapse" || ok "6. (2 s timeout) the mark lapsed by itself"
want "6. (2 s timeout) lapsed: the Browser's IPv6 is refused" 1102 "http://[2001:db8:ff00::1]:8080/" 000
want "6. (2 s timeout) lapsed: its IPv4 still works" 1102 "http://198.51.100.1:8080/" 200
nft -f "$CONF"

# 7. With --allow-home-network (the #HOME lines out) the Browser reaches its home network again, and IPv6 never depends on
#    the mark.
sed '/ #HOME$/d' "$CONF" > /tmp/nft-home.conf && nft -f /tmp/nft-home.conf
want "7. --allow-home-network lets the Browser in" 1102 "http://[2001:db8:5f::2]:8080/" 200
fresh && bad "7. ipv6_ok is set" || ok "7. with ipv6_ok empty"
want "7. and its IPv6 through a router works with no mark" 1102 "http://[2001:db8:ff00::1]:8080/" 200
exit $fail
