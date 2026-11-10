#!/bin/bash
# real.sh: S-96's proof runs on the lab box with real published releases, as root, from /var/tmp/lab (lab.sh push-recipe,
# then the batches and URL files pushed to /var/tmp/lab/b, 0600). Batches are signed on the workstation with a dev key kept
# out of git (tools/batch/batch-sign --key); its public half goes in /etc/ma/batch-keys.d. Prints what each step did and
# never a URL. Lab only.
#   m2   seq 2, a rollback batch: desk-rtc 0.4.1 -> 0.4.0 and deskd 2026.11.08-f435ef9 -> -8a14353 (the launch image's)
#   m3   seq 3, forward again to 0.3.1's pair
#   m1   seq 1, lower than applied;  m2-badsig, signed by another key
#   m4   seq 4, back again with deskd's URL on another artifact. Both releases were previous by then, so ma-update prepared
#        them from disk by hash and never fetched the URL: it applied (right, and not the test meant; m22 is)
#   m5   seq 5, desk-rtc, deskd and ma-lab-fail, whose health fails. desk-rtc and deskd were current already, so only
#        ma-lab-fail switched, failed and put itself back (m23 is the test meant)
#   m20  seq 20, all five services back to the launch image's (desk-rtc, desk-stream and deskd already were)
#   m22  seq 22, desk-rtc 0.4.1 (previous) and deskd -7bc37bb (a download) with deskd's URL on another artifact: nothing switched
#   m23  seq 23, desk-rtc 0.4.1, deskd -f435ef9, then ma-lab-fail: deskd and desk-rtc switched, then rolled back in reverse
#   m24  seq 24, a cold batch: four of five releases downloaded, three docker loads, timed
#   m25  seq 25, back on 0.3.1's releases, left to the timer
#   m26  seq 26, desk-rtc, deskd and desk-agent back; the tick killed with -9 once desk-rtc has switched, then a tick with no
#        idle.json finishes it (a cut-off activate finishes without waiting for idle)
set -u
B=/var/tmp/lab/b DB=/usr/local/lib/ma/desk-batch IDLE=/run/desk/idle.json
now() { date -u +%H:%M:%S; }
say() { echo "[$(now)] $*"; }
idle() { # idle <seconds idle> [age of at]
  python3 -I -c 'import json, sys, time; n = time.time(); u = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
print(json.dumps({"at": u(n - int(sys.argv[2])), "sessions": 0, "agentTasks": 0, "exports": 0, "downloads": 0,
                  "idleSince": u(n - int(sys.argv[1])), "idleStopSeconds": 1200}))' "$1" "${2:-0}" > "$IDLE.tmp"
  chown 1100:1100 "$IDLE.tmp"; mv "$IDLE.tmp" "$IDLE"
}
st() { python3 -I -c 'import json, sys; d = json.load(open("/var/lib/ma/batch/state.json")); print(eval(sys.argv[1], {"d": d}))' "$1" 2>&1 | tail -1; }
vers() { for c in desk-rtc desk-stream deskd desk-agent desk-notebook ma-lab-fail; do printf '%s=%s ' $c "$(basename "$(readlink /opt/ma/$c/current 2>/dev/null)" 2>/dev/null)"; done; echo; }
health() { /opt/ma/smoke-test >/dev/null 2>&1 && echo healthy || echo UNHEALTHY; }
containers() { docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sort | tr '\n' ';'; echo; }
offer() { $DB offer "$B/$1.json" "$B/${2:-$1}.json.sig" "$B/$3.json" 2>&1; }
tick() { local t0=$SECONDS; $DB tick 2>&1 | sed 's/^/    /'; say "tick took $((SECONDS - t0)) s: phase $(st 'd["phase"]'), applied $(st 'd["appliedSeq"]'), failed $(st 'd["failedSeq"]')"; }
step() { echo; say "==== $*"; }

case "${1:-}" in
setup)
  install -m 0644 -o root -g root "$B/dev.pem" /etc/ma/batch-keys.d/lab-dev.pem
  systemctl stop desk-batch.timer
  rm -f /var/lib/ma/batch/state.json "$IDLE"; rm -rf /var/lib/ma/batch/pending/*
  say "before: $(vers)$(health)"; say "containers: $(containers)"
  say "chromium $(dpkg-query -W -f='${Version}' chromium), kernel running $(uname -r), installed: $(ls /boot | grep vmlinuz | tr '\n' ' ')" ;;
1)
  step "a batch signed by another key";  offer m2-badsig m2-badsig u2
  step "the rollback batch, seq 2";      offer m2 m2 u2
  step "no idle.json";                   rm -f "$IDLE"; tick; say "$(vers)"
  step "idle.json 90 s old";             idle 1500 90; tick; say "$(vers)"
  step "idle 1500 s, fresh";             idle 1500
  ( while sleep 1; do h=$(st 'd["holdUntil"]'); [ "$h" != None ] && { echo "$(now) holdUntil $h phase $(st 'd["phase"]')" >> /var/tmp/lab/hold.log; }; done ) & w=$!
  tick; kill $w
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)"
  say "hold seen while it ran: $(sort -u -k2 /var/tmp/lab/hold.log | head -3 | tr '\n' ';')"
  step "a lower seq, 1";                 offer m1 m1 u2
  step "seq 2 again";                    offer m2 m2 u2 ;;
2)
  step "forward, seq 3";                 offer m3 m3 u3; idle 1500; tick
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)" ;;
3)
  step "seq 4 with deskd's URL on another artifact"; offer m4 m4 u4-mismatch; idle 1500; tick
  say "after: $(vers)$(health)"; say "phase $(st 'd["phase"]'), urlsWanted $(st 'd["pending"]["urlsWanted"]'), error: $(st 'd["lastError"]["text"]')"
  say "prepared links: $(ls -l /opt/ma/*/prepared 2>/dev/null | awk '{print $9, $11}' | tr '\n' ';')" ;;
4)
  step "seq 5: desk-rtc, deskd, then ma-lab-fail whose health fails"; offer m5 m5 u5; idle 1500; tick
  say "after: $(vers)$(health)"; say "phase $(st 'd["phase"]'), error: $(st 'd["lastError"]["text"]')"
  say "containers: $(containers)"
  step "seq 5 again";                    offer m5 m5 u5 ;;
5)
  step "seq 20: all five back to the launch image's"; offer m20 m20 u20; idle 1500; tick
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)"
  say "root free: $(df -m --output=avail / | tail -1) MiB; images: $(docker images -q | wc -l)" ;;
7)
  step "seq 22: deskd's URL on another artifact, and a download needed"; offer m22 m22 u22; idle 1500; tick
  say "after: $(vers)$(health)"; say "phase $(st 'd["phase"]'), urlsWanted $(st 'd["pending"]["urlsWanted"]'), error: $(st 'd["lastError"]["text"]')"
  say "prepared links: $(for f in /opt/ma/*/prepared; do [ -L "$f" ] && printf '%s -> %s; ' "$f" "$(basename "$(readlink "$f")")"; done)" ;;
8)
  step "seq 23: desk-rtc and deskd switch, then ma-lab-fail fails"; offer m23 m23 u23; idle 1500; tick
  say "after: $(vers)$(health)"; say "phase $(st 'd["phase"]'), failedSeq $(st 'd["failedSeq"]'), error: $(st 'd["lastError"]["text"]')"
  say "containers: $(containers)"
  step "seq 23 again";                   offer m23 m23 u23 ;;
9)
  step "seq 24: a cold batch, four downloads"; offer m24 m24 u24; idle 1500; tick
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)"
  say "root free: $(df -m --output=avail / | tail -1) MiB; images: $(docker images -q | wc -l)" ;;
10)
  step "seq 26: the tick killed once desk-rtc has switched, then a tick with no idle.json"; offer m26 m26 u26; idle 1500
  # its own process group, killed whole, as a power cut would: ma-update dies with it, mid-way through deskd's activate
  setsid $DB tick > /var/tmp/lab/cut.log 2>&1 & t=$!
  for _ in $(seq 1 600); do [ "$(st 'd["progress"]["switched"]' 2>/dev/null)" = "['desk-rtc']" ] && break; sleep 0.1; done
  kill -9 -- -$t; wait $t 2>/dev/null
  say "deskd's links when killed: current $(basename "$(readlink /opt/ma/deskd/current)"), previous $(basename "$(readlink /opt/ma/deskd/previous)"), prepared $(basename "$(readlink /opt/ma/deskd/prepared 2>/dev/null)" 2>/dev/null)"
  say "killed: phase $(st 'd["phase"]'), switched $(st 'd["progress"]["switched"]'), $(vers)"
  sed 's/^/    /' /var/tmp/lab/cut.log | grep -v smoke-test
  rm -f "$IDLE"; tick
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)" ;;
6)
  step "seq ${SEQ:-21}: left to the timer";  offer m${SEQ:-21} m${SEQ:-21} u${SEQ:-21}; idle 1500
  systemctl start desk-batch.timer
  for _ in $(seq 1 120); do [ "$(st 'd["appliedSeq"]')" = "${SEQ:-21}" ] && break; idle 1500; sleep 5; done
  say "after: $(vers)$(health)"; say "lastBatch: $(st 'd["lastBatch"]')"; say "containers: $(containers)"
  journalctl -u desk-batch.service -o cat --no-pager | grep -v '^smoke-test' | tail -12 | sed 's/^/    /'
  say "chromium: $(st 'd["chromium"]'); reboot: $(st 'd["reboot"]')"
  say "root free: $(df -m --output=avail / | tail -1) MiB; images: $(docker images -q | wc -l)" ;;
*) echo "usage: real.sh setup|1|2|3|4|5|7|8|9|6|10 (SEQ=25 for 6)" >&2; exit 2 ;;
esac
