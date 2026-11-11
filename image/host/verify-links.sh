#!/bin/bash
# image/host/verify-links.sh real|mutation <deskId> <volumeId> <public address>: a link the Browser's user puts at /data/browser/home
# before a slot start isn't followed (slot-datadirs: EXP-7's class on a shared host; docs/sub-status/slot-datadirs.md). verify.sh and
# verify-port.sh run it on the host as root, last, each mode once (R "sudo bash -s -- <mode> <desk> <vol> <public>" < verify-links.sh):
# - the link stopped (started again at the end if it ran) and its own desk-host runs waited for; every running desk stopped;
# - slot 1 started by hand for the desk (desk-host up 1 ...), and its desk-init's start waited for (its "up:" line);
# - inside slot 1, through its host-owned mount namespace bind and as the desk's own uids (a test host's tools, never a member's
#   desk): the desk's root makes /data/.verify-links (0755); the Browser's user (kiosk) moves its home aside and puts a link to that
#   directory at /data/browser/home, as a compromised Chromium could;
# - the slot stopped and started again, so its desk-init's datadirs() meets the link.
# real: "LINKS PASS" when /data/.verify-links is still the desk's root's and 0755, home is still the link (not followed, not
#   replaced), desk-init said it couldn't make home as kiosk, and units.sock is desk:desk 0600 (bound as desk, never chowned by name).
# mutation: the same with 0.1.11.1's desk-init (/root/desk-init.old.py, which verify copies there from git: root's makedirs, chown and
#   chmod by name) in the host's place for that start, which must fail it ("MUTATED LINKS FAIL": the target kiosk's, 0700); then the
#   real desk-init back (also on any exit), and the real check again ("RESTORE PASS").
# Each run leaves slot 1 stopped, its home as it was and nothing of the step's on the volume. Exit 2 when the step itself couldn't
# run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-links.sh real|mutation <deskId> <volumeId> <public>}; D=${2:?}; V=${3:?}; P=${4:?}
K=1; BASE=$((100000 + K * 65536)); NS=/run/desk-host/ns/$K/mnt; L=/usr/local/lib/desk-host; LOG=/var/log/desk-host/desk-$K.log
INIT=$L/desk/desk-init.py; KEEP=/root/desk-init.links-keep
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
[ "$MODE" = mutation ] && [ ! -s /root/desk-init.old.py ] && { echo "no /root/desk-init.old.py (verify copies 0.1.11.1's there)"; exit 2; }
LINK=$(systemctl is-active desk-host-link)   # started again at the end only if it ran (a lab host keeps it stopped)
cp -a "$INIT" "$KEEP"
trap 'cmp -s "$KEEP" "$INIT" || { cp -a "$KEEP" "$INIT"; echo "the real desk-init put back"; }; rm -f "$KEEP"; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
# the link stops alone (KillMode=process): its own runs are waited for before any desk is stopped (verify-wave.sh's rule)
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done

as() { local u=$1; shift; nsenter --mount=$NS setpriv --reuid=$((BASE + u)) --regid=$((BASE + u)) --clear-groups "$@"; }   # a desk uid in slot 1
start() {   # start: slot 1 up, then its desk-init's "up:" (datadirs done, units.sock bound); 1 when it didn't come up
  local n i; n=$(cat "$LOG" 2>/dev/null | wc -l)   # no log yet before a slot's first start
  desk-host up $K "$D" "$V" --public "$P" > /tmp/links-up.out 2>&1 || { echo "slot $K didn't start:"; tail -3 /tmp/links-up.out; return 1; }
  for i in $(seq 1 120); do tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' && { tail -n +$((n + 1)) "$LOG" > /tmp/links-start.log; return 0; }; sleep 1; done
  echo "slot $K: desk-init said no \"up:\" in 120 s"; return 1
}
plant() {   # the desk's root makes the target; kiosk moves its home aside and puts the link there
  as 0 install -d -m 0755 /data/.verify-links || return 1
  as 1102 sh -c 'mv /data/browser/home /data/browser/home.verify-kept && ln -s /data/.verify-links /data/browser/home' || return 1
  echo "planted: /data/browser/home -> $(as 1102 readlink /data/browser/home), its target $(nsenter --mount=$NS stat -c '%u:%g %a' /data/.verify-links)"
}
unplant() {   # home as it was, the target gone (as kiosk and the desk's root: whatever the start did to it, it's empty)
  as 1102 sh -c '[ -L /data/browser/home ] && rm /data/browser/home; [ -d /data/browser/home.verify-kept ] && mv /data/browser/home.verify-kept /data/browser/home' || true
  as 0 rmdir /data/.verify-links 2>/dev/null || nsenter --mount=$NS rmdir /data/.verify-links 2>/dev/null || true
  nsenter --mount=$NS test -e /data/.verify-links && { echo "the target is still there"; return 1; }
  [ "$(nsenter --mount=$NS stat -c '%u:%g %a %F' /data/browser/home)" = "$((BASE + 1102)):$((BASE + 1102)) 700 directory" ] || { echo "home isn't kiosk's 0700 again"; return 1; }
}
look() {   # look: 0 when the link wasn't followed (the step's check)
  local ok=0 t h s dg
  dg=$(nsenter --mount=$NS getent group desk | cut -d: -f3)
  t=$(nsenter --mount=$NS stat -c '%u:%g %a' /data/.verify-links); h=$(nsenter --mount=$NS stat -c '%F' /data/browser/home)
  s=$(nsenter --mount=$NS stat -c '%u:%g %a %F' /run/desk/units.sock)
  echo "after the start: the target $t (the desk's root's is $BASE:$BASE 755), home a $h, units.sock $s"
  [ "$t" = "$BASE:$BASE 755" ] || { echo "  the link at /data/browser/home was FOLLOWED: its target is now $t"; ok=1; }
  [ "$h" = "symbolic link" ] || { echo "  home isn't the link any more ($h)"; ok=1; }
  grep -q 'could not make /data/browser/home as kiosk' /tmp/links-start.log && echo "  desk-init: $(grep -m1 'could not make /data/browser/home' /tmp/links-start.log)" \
    || { echo "  desk-init didn't say it couldn't make home as kiosk"; ok=1; }
  [ "$s" = "$((BASE + 1100)):$((BASE + dg)) 600 socket" ] || { echo "  units.sock isn't desk:desk 0600 ($s)"; ok=1; }
  return $ok
}
round() {   # round: up, plant, a restart, look, unplant, stop; prints the verdict's line, returns look's status (2: couldn't run)
  local r
  start || return 2
  plant || { echo "couldn't plant"; desk-host stop $K >/dev/null 2>&1; return 2; }
  [ "${1:-}" = old ] && { install -m 644 /root/desk-init.old.py "$INIT"; echo "desk-init for this start: 0.1.11.1's ($(sha256sum < "$INIT" | cut -c1-12))"; }
  desk-host stop $K >/dev/null 2>&1
  start || { cp -a "$KEEP" "$INIT"; return 2; }
  look; r=$?
  cp -a "$KEEP" "$INIT"
  unplant || r=2
  desk-host stop $K >/dev/null 2>&1
  return $r
}

if [ "$MODE" = real ]; then
  round; r=$?
  [ $r = 0 ] && echo "LINKS PASS" || { [ $r = 1 ] && echo "LINKS FAIL"; [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }; }
else
  round old; r=$?
  [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }
  [ $r = 1 ] && echo "MUTATED LINKS FAIL (as it must)" || echo "MUTATED LINKS PASS (it should have failed)"
  cmp -s "$KEEP" "$INIT" && echo "the real desk-init is back ($(sha256sum < "$INIT" | cut -c1-12))"
  round; r=$?
  [ $r = 0 ] && echo "RESTORE PASS" || { [ $r = 2 ] && { echo "the restore couldn't run"; exit 2; }; echo "RESTORE FAIL"; }
fi
runc state dh-desk-$K >/dev/null 2>&1 && echo "slot $K is still running" || echo "slot $K stopped"
exit 0
