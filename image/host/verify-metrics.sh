#!/bin/bash
# image/host/verify-metrics.sh real|mutation <deskId> <volumeId> <public address>: Chromium's histogram directory on a tmpfs in slot 1
# (ISS-96: mounts.py vol's step 1b; docs/sub-status/browser-metrics-tmpfs.md). verify.sh and verify-port.sh run it on the host as root,
# last, each mode once (R "sudo bash -s -- <mode> <desk> <vol> <public>" < verify-metrics.sh):
# - the link stopped (started again at the end if it ran), its own desk-host runs waited for; every running desk stopped;
# - slot 1 started by hand (desk-host up 1 ...), and its desk-init's start waited for (its "up:" line: datadirs done);
# - read from the host only (slot 1's process 1's /proc/<pid>/mountinfo, its mounts.json and the start's output; nothing entered, run
#   or written in the desk): exactly one mount at /data/browser/profile/BrowserMetrics, a tmpfs from "desk-metrics", rw,nosuid,nodev,
#   noexec, size=32768k, mode=700, uid and gid the slot's kiosk (its base + 1102); mounts.json's "metrics" "tmpfs"; the start's
#   "browser-metrics: a 32 MiB tmpfs" line.
# real: "METRICS PASS".
# mutation: the step turned off (METRICS_TMPFS=off in desk-host.conf) for one start, which must fail it ("MUTATED METRICS FAIL": no
#   mount there); desk-host.conf put back (also on any exit) and the real check again ("RESTORE PASS").
# No link is planted on a host (no attack-style testing): the refusals are image/tests/test_host_metrics_tmpfs.py's.
# Each run leaves slot 1 stopped and desk-host.conf as it was. Exit 2 when the step itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-metrics.sh real|mutation <deskId> <volumeId> <public>}; D=${2:?}; V=${3:?}; P=${4:?}
K=1; BASE=$((100000 + K * 65536)); LOG=/var/log/desk-host/desk-$K.log; CONF=/etc/desk-host/desk-host.conf; KEEP=/root/desk-host.conf.metrics-keep
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
LINK=$(systemctl is-active desk-host-link)   # started again at the end only if it ran (a lab host keeps it stopped)
cp -a "$CONF" "$KEEP"
trap 'cmp -s "$KEEP" "$CONF" || { cp -a "$KEEP" "$CONF"; echo "desk-host.conf put back"; }; rm -f "$KEEP"; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
# the link stops alone (KillMode=process): its own runs are waited for before any desk is stopped (verify-wave.sh's rule)
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 < /dev/null || echo "slot $k: its stop failed"; }; done

start() {   # start: slot 1 up, then its desk-init's "up:"; 1 when it didn't come up
  local n; n=$(cat "$LOG" 2>/dev/null | wc -l)   # no log yet before a slot's first start
  desk-host up $K "$D" "$V" --public "$P" > /tmp/metrics-up.out 2>&1 < /dev/null || { echo "slot $K didn't start:"; tail -3 /tmp/metrics-up.out; return 1; }
  for _ in $(seq 1 120); do tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' && return 0; sleep 1; done
  echo "slot $K: desk-init said no \"up:\" in 120 s"; return 1
}
look() {   # look: 0 when the mount is there as specified (the step's check)
  local pid
  pid=$(runc state dh-desk-$K 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])') || { echo "  slot $K isn't running"; return 1; }
  grep -h 'browser-metrics' /tmp/metrics-up.out | sed 's/^/  start: /'
  python3 -I - "$pid" "$((BASE + 1102))" "/run/desk-host/$K.mounts.json" <<'PY'
import json, sys
pid, kiosk, rec = sys.argv[1], sys.argv[2], sys.argv[3]
at = "/data/browser/profile/BrowserMetrics"
rows = []
for line in open(f"/proc/{pid}/mountinfo"):
    a, b = line.rstrip("\n").split(" - ", 1)
    f, g = a.split(), b.split()
    if f[4] == at:
        rows.append({"vfs": f[5], "fstype": g[0], "source": g[1], "super": g[2]})
print(f"  mounts at {at} in slot 1 (its process 1's mountinfo): {rows}")
metrics = json.load(open(rec)).get("metrics")
print(f"  mounts.json metrics: {metrics!r}")
want_vfs = {"rw", "nosuid", "nodev", "noexec"}
want_super = {"size=32768k", "mode=700", f"uid={kiosk}", f"gid={kiosk}"}
bad = []
if len(rows) != 1:
    bad.append(f"{len(rows)} mounts there, not 1")
else:
    r = rows[0]
    if (r["fstype"], r["source"]) != ("tmpfs", "desk-metrics"):
        bad.append(f"{r['fstype']} from {r['source']}, not tmpfs from desk-metrics")
    if not want_vfs <= set(r["vfs"].split(",")):
        bad.append(f"mount options {r['vfs']} lack {sorted(want_vfs - set(r['vfs'].split(',')))}")
    if not want_super <= set(r["super"].split(",")):
        bad.append(f"tmpfs options {r['super']} lack {sorted(want_super - set(r['super'].split(',')))}")
if metrics != "tmpfs":
    bad.append(f"mounts.json says {metrics!r}")
for b in bad:
    print(f"  NOT AS SPECIFIED: {b}")
sys.exit(1 if bad else 0)
PY
  local r=$?
  grep -q '\[mounts\] browser-metrics: a 32 MiB tmpfs' /tmp/metrics-up.out || { echo "  the start didn't say it made the tmpfs"; r=1; }
  return $r
}
round() {   # round [off]: up (with the step turned off for "off"), look, stop; returns look's status (2: couldn't run)
  local r
  if [ "${1:-}" = off ]; then echo "METRICS_TMPFS=off" >> "$CONF"; echo "desk-host.conf for this start: METRICS_TMPFS=off"; fi
  start || { cp -a "$KEEP" "$CONF"; desk-host stop $K >/dev/null 2>&1 < /dev/null; return 2; }
  look; r=$?
  cp -a "$KEEP" "$CONF"
  desk-host stop $K >/dev/null 2>&1 < /dev/null
  return $r
}

if [ "$MODE" = real ]; then
  round; r=$?
  [ $r = 0 ] && echo "METRICS PASS" || { [ $r = 1 ] && echo "METRICS FAIL"; [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }; }
else
  round off; r=$?
  [ $r = 2 ] && { echo "the step couldn't run"; exit 2; }
  [ $r = 1 ] && echo "MUTATED METRICS FAIL (as it must)" || echo "MUTATED METRICS PASS (it should have failed)"
  cmp -s "$KEEP" "$CONF" && echo "desk-host.conf is as it was"
  round; r=$?
  [ $r = 0 ] && echo "RESTORE PASS" || { [ $r = 2 ] && { echo "the restore couldn't run"; exit 2; }; echo "RESTORE FAIL"; }
fi
runc state dh-desk-$K >/dev/null 2>&1 && echo "slot $K is still running" || echo "slot $K stopped"
exit 0
