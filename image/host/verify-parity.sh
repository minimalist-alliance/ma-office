#!/bin/bash
# image/host/verify-parity.sh real|mutation <deskId> <volumeId> <public address>: desk image 0.3.5 in a slot (sub/host-parity-035;
# docs/sub-status/host-parity-035.md). A slot's root is the template, but desk-init and svc-spec start its services, not systemd, so
# what 0.3.5 does through units is done the slot's way. verify.sh and verify-port.sh run it on the host as root, after verify-links.sh,
# each mode once (R "sudo bash -s -- <mode> <desk> <vol> <public>" < verify-parity.sh). Slot 1 is started by hand for the desk (the
# link stopped, its own runs waited for, every running desk stopped first), and, as the desk's own uids through its host-owned mount
# namespace bind (a test step's, never a member's desk):
#   links-out: /run/desk-links is the slot's share, desk:kiosk 2750 (the template's tmpfiles line); deskd's links.sock is there, kiosk's
#           group, 0660; the xdg-open stand-in run as kiosk with a tel: link gets deskd's "dropped nobody" (exit 4: nobody's office is
#           subscribed, which deskd decides after its scheme and URL checks), and deskd's /health browser.links counts it.
#   policy: desk-browser-policy runs before each Chromium start, as the desk's root: deskd's band "teen" gives the lock (ma-teen.json,
#           the template's bytes, root's 0644) and no allowlist; "adult" the allowlist (ma-adult.json) and no lock; "Adult" (not a
#           band) the lock. Fails closed: with the template's lock file writable by a group the helper refuses it, the start answers
#           an error and no Chromium runs; put right, the start's own retry brings Chromium up with the lock (Restart='s rule).
#   jxl:    the running Chromium is the launcher's child and its last --disable-features names JXLImageFormat (desk-browser-start's).
# real: "PARITY PASS" when all three pass ("links-out PASS", "policy PASS", "jxl PASS").
# mutation: 0.1.14's desk-init.py, wallspec.py and svc-spec.py (/root/parity-old/, which verify copies there from git, OLD_PARITY_REF)
#   in the host's place for one start must fail links and policy ("MUTATED LINKS-OUT FAIL", "MUTATED POLICY FAIL"); the real ones back,
#   the slot's own desk-browser-start without the JPEG XL switch must fail jxl ("MUTATED JXL FAIL"); then the real round again
#   ("RESTORE PASS"). The host's files and the slot's script are put back on any exit.
# Each run leaves slot 1 stopped, no band file, the policy files as they were and the slot's script unchanged. Exit 2 when the step
# itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-parity.sh real|mutation <deskId> <volumeId> <public>}; D=${2:?}; V=${3:?}; P=${4:?}
K=1; BASE=$((100000 + K * 65536)); NS=/run/desk-host/ns/$K/mnt; L=/usr/local/lib/desk-host; LOG=/var/log/desk-host/desk-$K.log
SHARE=/run/desk-host/share/$K; ROOT=/srv/desk-host/slots/$K/rootfs; KEEP=/root/parity-keep; OLD=/root/parity-old
FILES="desk/desk-init.py wallspec.py svc-spec.py"; BS=usr/local/lib/ma/desk-browser-start; PM=etc/chromium/policies/managed
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
if [ "$MODE" = mutation ]; then for f in $FILES; do [ -s "$OLD/$f" ] || { echo "no $OLD/$f (verify copies 0.1.14's there)"; exit 2; }; done; fi
LINK=$(systemctl is-active desk-host-link)   # started again at the end only if it ran (a lab host keeps it stopped)
rm -rf "$KEEP"; mkdir -p "$KEEP/lib/desk"; for f in $FILES; do cp -a "$L/$f" "$KEEP/lib/$f"; done
put_back() {   # the host's own files, and the slot's script if a run left it changed
  local f; for f in $FILES; do cmp -s "$KEEP/lib/$f" "$L/$f" || { cp -a "$KEEP/lib/$f" "$L/$f"; echo "the real $f put back"; }; done
  [ -s "$KEEP/bs" ] && [ -e "$ROOT/$BS" ] && ! cmp -s "$KEEP/bs" "$ROOT/$BS" && { cat "$KEEP/bs" > "$ROOT/$BS"; echo "the slot's desk-browser-start put back"; }
  [ -e "$KEEP/teen-mode" ] && [ -e "$ROOT/etc/ma/chromium-teen.json" ] && chmod "$(cat "$KEEP/teen-mode")" "$ROOT/etc/ma/chromium-teen.json"
  return 0
}
trap 'put_back; rm -rf "$KEEP"; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done

as() { local u=$1; shift; nsenter --mount=$NS setpriv --reuid=$((BASE + u)) --regid=$((BASE + u)) --clear-groups "$@"; }   # a desk uid in slot 1
start() {   # slot 1 up, its desk-init's "up:" said, and deskd's links.sock (or, for the old host files, deskd's admin socket) there
  local n i; n=$(cat "$LOG" 2>/dev/null | wc -l)
  desk-host up $K "$D" "$V" --public "$P" > /tmp/parity-up.out 2>&1 || { echo "slot $K didn't start:"; tail -3 /tmp/parity-up.out; return 1; }
  for i in $(seq 1 120); do tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' && break; sleep 1; done
  tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' || { echo "slot $K: desk-init said no \"up:\" in 120 s"; return 1; }
  for i in $(seq 1 240); do [ -S "$SHARE/desk/deskd-admin.sock" ] && { [ -S "$SHARE/desk-links/links.sock" ] || [ ! -d "$SHARE/desk-links" ]; } && break; sleep 1; done
  [ -S "$SHARE/desk/deskd-admin.sock" ] || { echo "slot $K: deskd's admin socket never came in 240 s"; return 1; }
  sleep 2; return 0
}
stop() { desk-host stop $K >/dev/null 2>&1; }
uc() {   # uc <verb> <unit>: units.sock as deskd's uid, the reply's one line
  as 1100 python3 -I -c 'import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(90); s.connect("/run/desk/units.sock"); s.sendall((sys.argv[1] + "\n").encode())
print(s.recv(200).decode().strip())' "$*" 2>&1
}
nobody() {   # deskd's /health browser.links: the links dropped as "nobody"
  curl -s --max-time 5 --unix-socket "$SHARE/desk/deskd-admin.sock" http://localhost/health | python3 -I -c 'import json, sys
l = (json.load(sys.stdin).get("browser") or {}).get("links") or {}
print((l.get("dropped") or {}).get("nobody", 0))' 2>/dev/null || echo none
}
launcher() { local p; for p in $(pgrep -x desk-launcher); do grep -q "/desk-host/desk-$K/" /proc/$p/cgroup 2>/dev/null && { echo "$p"; return; }; done; }
chromium() {   # chromium [secs]: the launcher's child once it's Chromium's own binary (the wrappers exec'd), else nothing
  local i l c; for i in $(seq 1 "${1:-120}"); do
    l=$(launcher); [ -n "$l" ] && for c in $(pgrep -P "$l"); do case "$(readlink /proc/$c/exe 2>/dev/null)" in */usr/lib/chromium/chromium) echo "$c"; return;; esac; done
    sleep 1; done
}
browser_log() { nsenter --mount=$NS cat /data/logs/desk-browser.log 2>/dev/null; }

check_links() {   # 0: links out reach deskd from kiosk in the slot
  local ok=0 d s rc out n0 n1
  d=$(stat -c '%u:%g %a %F' "$SHARE/desk-links" 2>/dev/null || echo missing); s=$(stat -c '%u:%g %a %F' "$SHARE/desk-links/links.sock" 2>/dev/null || echo missing)
  echo "  /run/desk-links $d; links.sock $s (desk is $((BASE + 1100)), kiosk $((BASE + 1102)))"
  [ "$d" = "$((BASE + 1100)):$((BASE + 1102)) 2750 directory" ] || { echo "  /run/desk-links isn't the slot's desk:kiosk 2750 share"; ok=1; }
  [ "$s" = "$((BASE + 1100)):$((BASE + 1102)) 660 socket" ] || { echo "  deskd's links.sock isn't there as kiosk's group 0660"; ok=1; }
  nsenter --mount=$NS test -d /run/desk-links || { echo "  the desk has no /run/desk-links"; ok=1; }
  n0=$(nobody)
  out=$(as 1102 /usr/local/bin/xdg-open 'tel:+15555550100' 2>&1); rc=$?
  sleep 1; n1=$(nobody)
  echo "  the stand-in as kiosk, tel: -> exit $rc ($out); deskd's browser.links nobody $n0 -> $n1"
  [ "$rc" = 4 ] && grep -q 'dropped nobody' <<<"$out" || { echo "  deskd didn't answer the stand-in (3: not listening, or not for kiosk)"; ok=1; }
  [ "$n0" != none ] && [ "$n1" = $((n0 + 1)) ] || { echo "  deskd didn't count the link"; ok=1; }
  return $ok
}
band() { as 1100 sh -c "printf '$1' > /data/desk/age-band"; }
pol() {   # pol <lock|allow>: the policy files in the slot's root are that band's, the template's bytes, root's 0644
  local want=$1 t a
  t=$(nsenter --mount=$NS stat -c '%u:%g %a' /$PM/ma-teen.json 2>/dev/null || echo absent); a=$(nsenter --mount=$NS stat -c '%u:%g %a' /$PM/ma-adult.json 2>/dev/null || echo absent)
  echo "    ma-teen.json $t, ma-adult.json $a"
  if [ "$want" = lock ]; then
    [ "$t" = "$BASE:$BASE 644" ] && [ "$a" = absent ] && nsenter --mount=$NS cmp -s /$PM/ma-teen.json /etc/ma/chromium-teen.json
  else
    [ "$a" = "$BASE:$BASE 644" ] && [ "$t" = absent ] && nsenter --mount=$NS cmp -s /$PM/ma-adult.json /etc/ma/chromium-adult.json
  fi
}
check_policy() {   # 0: the helper ran before each start, per band, and failing closed
  local ok=0 r b want line c n
  for b in 'teen\n:lock:locked: band teen' 'adult\n:allow:not locked: band adult; sign-in extensions allowed' 'Adult\n:lock:locked: the band isn'"'"'t teen or adult'; do
    want=$(cut -d: -f2 <<<"$b"); line=$(cut -d: -f3- <<<"$b"); b=${b%%:*}
    uc stop desk-browser >/dev/null; n=$(browser_log | wc -l)
    band "$b"; r=$(uc start desk-browser)
    echo "  band ${b%\\n}: start -> $r"
    [ "$r" = ok ] || { echo "    the start failed"; ok=1; }
    pol "$want" || { echo "    the policy files aren't band ${b%\\n}'s ($want)"; ok=1; }
    browser_log | tail -n +$((n + 1)) | grep -qF "desk-browser-policy: $line" && echo "    log: desk-browser-policy: $line" || { echo "    the helper's line isn't in the Browser's log"; ok=1; }
  done
  # fails closed: the template's lock can't be trusted (a group may write it), so the helper refuses it and Chromium doesn't start
  uc stop desk-browser >/dev/null; band 'teen\n'; n=$(browser_log | wc -l)
  stat -c '%a' "$ROOT/etc/ma/chromium-teen.json" > "$KEEP/teen-mode"; chmod 664 "$ROOT/etc/ma/chromium-teen.json"
  r=$(uc start desk-browser); sleep 2; c=$(chromium 3)
  echo "  the template's lock writable by its group: start -> $r; Chromium ${c:-not running}"
  [ "$r" != ok ] && [ -z "$c" ] || { echo "    Chromium started though the lock couldn't be trusted"; ok=1; }
  browser_log | tail -n +$((n + 1)) | grep -q 'LOCK NOT IN PLACE' && browser_log | tail -n +$((n + 1)) | grep -q 'desk-browser-policy exited 1: Chromium not started' \
    && echo "    log: LOCK NOT IN PLACE; desk-browser-policy exited 1: Chromium not started" || { echo "    the refusal isn't in the Browser's log"; ok=1; }
  chmod "$(cat "$KEEP/teen-mode")" "$ROOT/etc/ma/chromium-teen.json"; rm -f "$KEEP/teen-mode"
  c=$(chromium 60)
  if [ -n "$c" ]; then echo "  put right: Chromium running (pid $c), from the start's own retry"; else echo "  put right: Chromium still not running after 60 s"; fi
  [ -n "$c" ] && pol lock || { echo "    the retry didn't bring Chromium up with the lock"; ok=1; }
  return $ok
}
check_jxl() {   # 0: the running Chromium is the launcher's child with JPEG XL off (the last --disable-features)
  local c last
  [ "$(uc start desk-browser)" = ok ] || { echo "  the Browser didn't start"; return 1; }
  c=$(chromium 120); [ -n "$c" ] || { echo "  no Chromium under the launcher in 120 s"; return 1; }
  last=$(tr '\0' '\n' < /proc/$c/cmdline | sed -n 's/^--disable-features=//p' | tail -1)
  echo "  Chromium pid $c, parent $(cat /proc/$(awk '{print $4}' /proc/$c/stat)/comm), last --disable-features=${last:-none}"
  tr ',' '\n' <<<"$last" | grep -qx JXLImageFormat
}
verdict() { [ "$2" = 0 ] && echo "$1 PASS" || echo "$1 FAIL"; }
cleanup_slot() {   # no band, the policy files as they were at the step's start, slot 1 stopped
  uc stop desk-browser >/dev/null 2>&1; as 1100 rm -f /data/desk/age-band; stop
  for f in ma-teen.json ma-adult.json; do [ -e "$KEEP/had-$f" ] || rm -f "$ROOT/$PM/$f"; done
}
round() {   # round [old|jxl]: one start, the checks, a stop. Prints each check's verdict; returns 2 when the step couldn't run
  local rl=0 rp=0 rj=0
  case "${1:-}" in
    old) for f in $FILES; do install -m "$(stat -c '%a' "$KEEP/lib/$f")" "$OLD/$f" "$L/$f"; done; echo "host files for this start: 0.1.14's ($FILES)" ;;
  esac
  start || { put_back; return 2; }
  for f in ma-teen.json ma-adult.json; do [ -e "$ROOT/$PM/$f" ] && touch "$KEEP/had-$f"; done
  if [ "${1:-}" = jxl ]; then
    cp -a "$ROOT/$BS" "$KEEP/bs"
    python3 -I -c 'import sys; p = sys.argv[1]; s = open(p).read(); n = s.replace(" --disable-features=JXLImageFormat", ""); assert n != s; open(p, "w").write(n)' "$ROOT/$BS" \
      || { echo "couldn't take the switch out of the slot's desk-browser-start"; cleanup_slot; return 2; }
    echo "the slot's desk-browser-start for this start: without --disable-features=JXLImageFormat"
    band 'adult\n'; check_jxl; rj=$?; verdict jxl $rj
    cat "$KEEP/bs" > "$ROOT/$BS"; rm -f "$KEEP/bs"
    cleanup_slot; return 0
  fi
  echo "links-out:"; check_links; rl=$?; verdict links-out $rl
  echo "policy:"; check_policy; rp=$?; verdict policy $rp
  if [ "${1:-}" != old ]; then echo "jxl:"; check_jxl; rj=$?; verdict jxl $rj; fi
  cleanup_slot; put_back >/dev/null
  return 0
}

if [ "$MODE" = real ]; then
  round > /tmp/parity-real.out 2>&1; r=$?; cat /tmp/parity-real.out
  [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }
  grep -qx 'links-out PASS' /tmp/parity-real.out && grep -qx 'policy PASS' /tmp/parity-real.out && grep -qx 'jxl PASS' /tmp/parity-real.out && echo "PARITY PASS" || echo "PARITY FAIL"
else
  round old > /tmp/parity-old.out 2>&1; r=$?; cat /tmp/parity-old.out
  [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }
  grep -qx 'links-out FAIL' /tmp/parity-old.out && echo "MUTATED LINKS-OUT FAIL (as it must)" || echo "MUTATED LINKS-OUT PASS (it should have failed)"
  grep -qx 'policy FAIL' /tmp/parity-old.out && echo "MUTATED POLICY FAIL (as it must)" || echo "MUTATED POLICY PASS (it should have failed)"
  ok=1; for f in $FILES; do cmp -s "$KEEP/lib/$f" "$L/$f" || ok=0; done; [ $ok = 1 ] && echo "the real host files are back"
  round jxl > /tmp/parity-jxl.out 2>&1; r=$?; cat /tmp/parity-jxl.out
  [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }
  grep -qx 'jxl FAIL' /tmp/parity-jxl.out && echo "MUTATED JXL FAIL (as it must)" || echo "MUTATED JXL PASS (it should have failed)"
  round > /tmp/parity-real.out 2>&1; r=$?; cat /tmp/parity-real.out
  [ $r = 2 ] && { echo "the restore couldn't run"; exit 2; }
  grep -qx 'links-out PASS' /tmp/parity-real.out && grep -qx 'policy PASS' /tmp/parity-real.out && grep -qx 'jxl PASS' /tmp/parity-real.out && echo "RESTORE PASS" || echo "RESTORE FAIL"
fi
runc state dh-desk-$K >/dev/null 2>&1 && echo "slot $K is still running" || echo "slot $K stopped"
exit 0
