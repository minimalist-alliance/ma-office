#!/bin/bash
# rollback.sh: template_rollback with the Last Version rule (ADR 0077 1.6; LAB ONLY, test data). Both slots are on g2. Slot 1 is
# stopped and its profile's Last Version set to g2's Chromium (156.0.8078.80, which g2's dpkg database says; the binary is g1's), as
# ADR 0035's run faked a newer one: as if g2's Chromium had run there. Slot 2's Chromium ran on g2 and wrote 156.0.8078.79, g1's.
# Platform rolls g2 back: slot 1 must stay on g2 (its profile is newer than g1's Chromium), slot 2 must go back to g1 at its stop,
# and no Browser is refused. With NO_PEEK=1 (the mutation: the host's read of Last Version turned off) slot 1 goes back to g1 and
# its guard refuses (exit 78), the profile unchanged.
set -u
cd /var/tmp/lab; L=/usr/local/lib/desk-host
bash steps.sh stop 1
python3 -I fixtures.py lv 1 156.0.8078.80
c0=$(python3 -I fixtures.py dbg 1 /browser/profile/Default/Cookies)
python3 -I fake.py orders '[{"op": "template_rollback", "id": "template_rollback:g2", "gen": "g2"}]'
for i in $(seq 1 60); do [ "$(python3 -I $L/desk-host-template current)" = g1 ] && break; sleep 2; done
echo "current $(python3 -I $L/desk-host-template current); halted: $(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as T; print(T.load_state()["halted"])')"
# slot 1 is stopped: its stop's re-root, run now (in desk-host-upd)
env ${NO_PEEK:+DESK_HOST_NO_PEEK=1} python3 -I $L/desk-host-template upd -- /bin/bash $L/desk-host reroot 1 2>&1 | grep -E "nothing to do|re-rooted|dropped" | tail -1
bash steps.sh slot 1 | head -1
bash steps.sh stop 2
for i in $(seq 1 1200); do sleep 1; pgrep -f "^/bin/bash $L/desk-host reroot 2" >/dev/null || { [ "$i" -gt 4 ] && break; }; done
tail -1 /var/log/desk-host/reroot-2.log
bash steps.sh slot 2 | head -1
for k in 1 2; do bash steps.sh start $k; done
for k in 1 2; do echo "slot $k: $(bash steps.sh browser $k 2>&1 | tail -1)"; done
sleep 5
for k in 1 2; do echo "slot $k: $(bash steps.sh read $k 2>&1 | tail -1)"; done
python3 -I fixtures.py dbg 1 /logs/desk-browser.log 2>/dev/null | grep -a "REFUSING" | tail -1
echo "slot 1's Cookies before the rollback: $c0"
