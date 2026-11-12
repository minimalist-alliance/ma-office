#!/bin/bash
# image/host/verify-wake.sh real|mutation <deskId> <volumeId> <public address>: a start on a slot with no record prepares the slot and
# starts it, and the JVMs in a started slot map their AppCDS archives (sub/host-up-norecord; docs/sub-status/host-up-norecord.md).
# verify.sh and verify-port.sh run it on the host as root, last, each mode once (R "sudo bash -s -- <mode> <desk> <vol> <public>" < it):
# - the link stopped (started again at the end if it ran), its own desk-host runs waited for; every running desk stopped;
# - norecord: slot 1's record moved aside, as a prepare refused for room leaves a slot (it removes the record first), then
#   `desk-host up 1 ...`: it must exit 0, having said "preparing from <gen> first";
# - cds: deskd's and desk-agent's JVMs in slot 1 must map /app/deskd.jsa and /app/desk-agent.jsa (/proc/<pid>/maps, read from the
#   host). The release store keeps each file's time from its image (desk-host-release); with the unpack's time instead, each app jar
#   differs from what its archive recorded, and the JVM (-Xshare:auto, its cds log off) runs without it, saying nothing.
# real: "NORECORD PASS" and "CDS PASS".
# mutation: 0.1.15's desk-host (/root/desk-host.old, which verify copies there from git) in the host's place for the norecord start,
#   which must end non-zero with nothing on stderr ("MUTATED NORECORD FAIL"); the real desk-host back (also on any exit), and the
#   same start passes ("RESTORE NORECORD PASS"); then slot 1's app jars touched to now (as 0.1.12 to 0.1.15's unpack left every file)
#   for one start, which must run both JVMs without their archives ("MUTATED CDS FAIL"); then slot 1 prepared again from the store (its
#   jars' times back) and the same start passes ("RESTORE CDS PASS"). "RESTORE PASS" when both restores pass.
# Each run leaves slot 1 stopped, with a record. Exit 2 when the step itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-wake.sh real|mutation <deskId> <volumeId> <public>}; D=${2:?}; V=${3:?}; P=${4:?}
K=1; DH=$(readlink -f /usr/local/sbin/desk-host); REC=/var/lib/desk-host/slots; KEEP=/root/desk-host.wake-keep; OUT=/tmp/wake-verify
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
[ "$MODE" = mutation ] && [ ! -s /root/desk-host.old ] && { echo "no /root/desk-host.old (verify copies 0.1.15's there)"; exit 2; }
LINK=$(systemctl is-active desk-host-link)   # started again at the end only if it ran (a lab host keeps it stopped)
cp -a "$DH" "$KEEP"
trap 'cmp -s "$KEEP" "$DH" || { cp -a "$KEEP" "$DH"; echo "the real desk-host put back"; }; rm -f "$KEEP"; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
# the link stops alone (KillMode=process): its own runs are waited for before any desk is stopped (verify-wave.sh's rule)
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done
[ -s "$REC/$K.json" ] || desk-host prepare $K >/dev/null 2>&1 || { echo "slot $K: no record, and its prepare failed"; exit 2; }

up() {   # up: desk-host up for slot 1; its stdout and stderr in $OUT.out and $OUT.err; returns its status
  desk-host up $K "$D" "$V" --public "$P" > $OUT.out 2> $OUT.err
}
norecord() {   # norecord: the record aside, then a start: 0 when it prepared the slot and started it, 1 when the start ended silently
  local rc
  mv "$REC/$K.json" "$REC/.$K.json.wake-verify"
  up; rc=$?
  rm -f "$REC/.$K.json.wake-verify"
  echo "a start with no record: exit $rc; $(grep -c . $OUT.err) line(s) on stderr; $(grep -m1 -o 'preparing from g[0-9]* first' $OUT.out || echo 'no prepare')"
  [ $rc = 0 ] && grep -q 'preparing from g[0-9]* first' $OUT.out && return 0
  [ $rc != 0 ] && [ ! -s $OUT.err ] && echo "  it ended with nothing on stderr"
  sed 's/^/  /' $OUT.err | head -3
  [ -s "$REC/$K.json" ] || desk-host prepare $K >/dev/null 2>&1 || true   # never leave the slot without a record
  return 1
}
cds() {   # cds: 0 when deskd's and desk-agent's JVMs in slot 1 both map their app archive (60 s for both to be up)
  local svc p ok=0 i
  for svc in deskd desk-agent; do
    p=""
    for i in $(seq 1 60); do
      for c in $(pgrep -f '^/opt/java/openjdk/bin/java'); do grep -qE "^0::/desk-host/desk-$K/svc-$svc(/|\$)" /proc/$c/cgroup 2>/dev/null && p=$c; done
      [ -n "$p" ] && grep -q "/app/$svc.jsa" /proc/$p/maps 2>/dev/null && break; sleep 1
    done
    if [ -z "$p" ]; then echo "  $svc: no JVM in slot $K"; ok=1
    elif grep -q "/app/$svc.jsa" /proc/$p/maps; then echo "  $svc: pid $p maps /app/$svc.jsa"
    else echo "  $svc: pid $p runs WITHOUT /app/$svc.jsa ($(grep -o '[a-z-]*\.jsa' /proc/$p/maps | sort -u | tr '\n' ' ')mapped)"; ok=1; fi
  done
  return $ok
}
stop1() { desk-host stop $K >/dev/null 2>&1; }

if [ "$MODE" = real ]; then
  norecord && echo "NORECORD PASS" || echo "NORECORD FAIL"
  runc state dh-desk-$K >/dev/null 2>&1 || up || { echo "slot $K didn't start for the cds step"; cat $OUT.err; exit 2; }
  cds && echo "CDS PASS" || echo "CDS FAIL"
  stop1
else
  install -m 755 /root/desk-host.old "$DH"; echo "desk-host for this start: 0.1.15's ($(sha256sum < "$DH" | cut -c1-12))"
  norecord && echo "MUTATED NORECORD PASS (it should have failed)" || echo "MUTATED NORECORD FAIL (as it must)"
  cp -a "$KEEP" "$DH"; echo "the real desk-host is back ($(sha256sum < "$DH" | cut -c1-12))"
  stop1
  norecord && { r1=0; echo "RESTORE NORECORD PASS"; } || { r1=1; echo "RESTORE NORECORD FAIL"; }
  stop1
  for svc in deskd desk-agent; do touch /srv/desk-host/slots/$K/rel/$svc/rootfs/app/$svc.jar; done
  echo "slot $K's app jars touched to now for this start (as 0.1.15's unpack left them)"
  up || { echo "slot $K didn't start for the cds mutation"; cat $OUT.err; exit 2; }
  cds && echo "MUTATED CDS PASS (it should have failed)" || echo "MUTATED CDS FAIL (as it must)"
  stop1; desk-host prepare $K >/dev/null 2>&1 || { echo "slot $K: its prepare failed"; exit 2; }
  up || { echo "slot $K didn't start after its prepare"; cat $OUT.err; exit 2; }
  cds && { r2=0; echo "RESTORE CDS PASS"; } || { r2=1; echo "RESTORE CDS FAIL"; }
  stop1
  [ $r1 = 0 ] && [ $r2 = 0 ] && echo "RESTORE PASS" || echo "RESTORE FAIL"
fi
rm -f $OUT.out $OUT.err
runc state dh-desk-$K >/dev/null 2>&1 && echo "slot $K is still running" || echo "slot $K stopped"
exit 0
