#!/bin/bash
# realsite.sh: the per-site switch on real sites, as deskd drives it (units.sock as uid 1100), on a lab box after apply.sh.
# allrecipes.com off: its page loads everything while foodnetwork.com stays blocked; then through a Chromium restart, 10 s
# later, and on again. Lab only (ADR 0076). Output: one JSON line per page.
set -u
A=https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/
F=https://www.foodnetwork.com/recipes/ina-garten/perfect-roast-chicken-recipe-1940592
LIST=/data/desk/adblock-off
ask() { timeout 60 setpriv --reuid=1100 --regid=1100 --clear-groups python3 -I -c "
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect('/run/desk/units.sock'); s.sendall(sys.argv[1].encode() + b'\n'); print(s.recv(300).decode().strip())" "$1"; }
setlist() { printf "$1" > /data/desk/.adblock-off.v; chown desk:desk /data/desk/.adblock-off.v; chmod 0644 /data/desk/.adblock-off.v; mv -f /data/desk/.adblock-off.v "$LIST"; }
up() { for i in $(seq 1 120); do curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && return 0; sleep 1; done; echo "Chromium never came up"; }
both() { echo "== $1"; python3 -I /var/tmp/lab/realcount.py "$A"; python3 -I /var/tmp/lab/realcount.py "$F"; }
[ "$(systemctl is-active desk-browser)" = active ] || { ask 'start desk-browser'; up; sleep 5; }
setlist ''; echo "apply, no site off: $(ask 'start desk-adblock')"; both "no site off"
setlist 'allrecipes.com\n'; t0=$(date +%s.%N); r=$(ask 'start desk-adblock'); echo "apply, allrecipes.com off: $r in $(echo "$(date +%s.%N) - $t0" | bc) s"; both "allrecipes.com off"
echo "restart: $(ask 'stop desk-browser') $(ask 'start desk-browser')"; up
both "right after a Chromium restart"; sleep 10; both "10 s later"
setlist ''; echo "apply, on again: $(ask 'start desk-adblock')"; both "on again"
# Changed while Chromium was down, and nothing but page loads to wake the blocker: when does foodnetwork.com go off?
setlist 'allrecipes.com\n'; ask 'start desk-adblock' >/dev/null; echo "stop: $(ask 'stop desk-browser')"
setlist 'foodnetwork.com\n'; echo "start, foodnetwork.com off instead, no apply: $(ask 'start desk-browser')"; up; t0=$SECONDS
for i in 1 2 3; do both "changed while down, $((SECONDS - t0)) s after the port came up"; done
echo "apply: $(ask 'start desk-adblock')"; both "changed while down, after an apply"
rm -f "$LIST"; ask 'start desk-adblock' >/dev/null
journalctl -u desk-adblock -u desk-browser --since '-15 min' --no-pager -o cat | grep -c 'allrecipes' | sed 's/^/journal lines naming the site: /'
