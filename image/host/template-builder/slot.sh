#!/bin/bash
# slot.sh <step> [args]: the template builder's real slot start (ADR 0077 1.3 items 8 and 9), on the builder, as root. TEST
# HOST ONLY: template-build.sh copies it with tb.py for one run, and the builder is terminated after it. Each step prints what
# it did and exits non-zero on a failure; template-build.sh records the results with tb.py record.
#   setup <deskId> <volumeId> <host public address>   a test host (desk-host's TEST mode, the CDP forward, the pages' port),
#                                                      a fake Platform on the loopback, desk-host-link pointed at it
#   start | stop                     the fake Platform wants slot 1 running or stopped; waits for the link's report
#   browser                          Chromium started in slot 1 through units.sock, as deskd would; waits for the CDP forward
#   reroot <gen>                     with slot 1 stopped: <gen> becomes the template (templates/<gen>, read-only) and the slot
#                                    is prepared again from it, which is what a re-root does (ADR 0077 1.5); host 0.1.x has no
#                                    `desk-host reroot` yet, so it's desk-host's own prepare after the swap
#   template <gen|g1>                which tree is the template, without touching a slot
#   checks <gen>                     1.3 item 8 with slot 1 running on <gen>: the host checks, the wall's settings, WR2-02 by
#                                    configuration review, desk-stream started and connected
#   cookies-off                      section 7's mutation, on the stopped slot's TEST volume only: the seeded profile's Cookies
#                                    database removed, in a private mount namespace (never a member's volume: there is none here)
set -euo pipefail
TB=/var/lib/ma-tb; TOOLS=$TB/tools; L=/usr/local/lib/desk-host; DH=/srv/desk-host; TT=/var/lib/desk-host/test; FAKE=/root/fake
K=1
rec() { python3 -I "$TOOLS/tb.py" record "$@"; }
die() { echo "slot.sh: $*" >&2; exit 1; }

fake_state() {   # fake_state <running|stopped>
  python3 -I - "$1" <<'P'
import json, sys
s = json.load(open("/root/fake/base.json")); s["slots"]["1"]["want"] = sys.argv[1]
json.dump(s, open("/root/fake/state.json.tmp", "w")); import os; os.chmod("/root/fake/state.json.tmp", 0o600); os.rename("/root/fake/state.json.tmp", "/root/fake/state.json")
P
}
wait_report() {   # wait_report <seconds> <states,...>: the link's last report says slot 1 is in one of them
  python3 -I - "$@" <<'P'
import json, sys, time
end = time.time() + float(sys.argv[1]); want = sys.argv[2].split(",")
while True:
    S = {}
    try:
        for l in open("/root/fake/requests.jsonl"):
            r = json.loads(l)
            if r["route"] == "/v1/host/report" and r["status"] == 200:
                S = {s["k"]: s for s in r["body"]["slots"]}
    except OSError:
        pass
    st = S.get(1, {}).get("state")
    if st in want:
        print(f"slot 1: {st} (fault {S[1].get('fault')})"); sys.exit(0)
    if time.time() > end:
        print(f"TIMEOUT: slot 1 is {st} (fault {S.get(1, {}).get('fault')}), wanted {want}"); sys.exit(1)
    time.sleep(3)
P
}
tmpl_now() { head -1 $DH/template/.complete; grep -E '^(gen|chromium)=' $DH/template/.complete | paste -sd' ' || true; }
top_gen() { sed -n 's/^gen=//p' $DH/template/.complete; }
set_template() {   # set_template <gen|g1>: which tree $DH/template shows, read-only, nosuid, nodev, as desk-host-boot leaves g1.
  # Another generation is bound on top of g1's own bind and popped again, never by unmounting g1's: the link's prepares at a
  # host's first boot copy g1 from there and keep it busy.
  local i
  while [ -n "$(top_gen)" ] && [ "$(top_gen)" != "$1" ]; do
    for i in $(seq 1 60); do umount $DH/template 2>/dev/null && break; sleep 2; done
    [ "$i" != 60 ] || die "the template bind of $(top_gen) stays busy"
  done
  if [ "$1" != g1 ] && [ "$(top_gen)" != "$1" ]; then
    [ -f "$DH/templates/$1/.complete" ] || die "no sealed $1"
    mount --bind "$DH/templates/$1" $DH/template
    mount -o remount,bind,ro,nosuid,nodev $DH/template
  fi
  [ "$(top_gen)" = "$([ "$1" = g1 ] && echo || echo "$1")" ] || die "the template is $(top_gen), not $1"
  echo "template now: $(tmpl_now)"
}

case "${1:-}" in
setup)
  D=${2:?deskId}; V=${3:?volume}; PUB=${4:?public address}
  echo "# a TEST host: the template builder (image/host/template-builder). A member's host never has this file." > /etc/desk-host/test.conf
  install -d -m 755 $TT
  install -m 644 "$TOOLS/cdp_forward.py" $TT/cdp_forward.py
  : > $TT/test-cdp.on
  sed -i '/^# --- template builder/,$d' /etc/desk-host/desk-host.conf
  cat >> /etc/desk-host/desk-host.conf <<C
# --- template builder (image/host/template-builder/slot.sh): a test host only
HOST_PORTS=18766
LINK_API=http://127.0.0.1:18443
DESKD_ENV=DESKD_API_URL=https://api.verify.invalid;DESKD_JWKS_URL=https://api.verify.invalid/v1/jwks
C
  install -d -m 700 $FAKE
  install -m 600 "$TOOLS/fake_platform.py" $FAKE/fake_platform.py
  python3 -I - "$D" "$V" "$PUB" "$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-id)" <<'P'
import json, sys
d, v, pub, iid = sys.argv[1:5]
s = {"hostId": iid, "env": "staging", "desksPerHost": 6, "reportSeconds": 10, "refreshAfterSeconds": 600,
     "slots": {"1": {"deskId": d, "volumeId": v, "publicIp": pub, "udpPort": 4431, "epoch": 1, "want": "stopped", "userId": "builder-user-1", "deskKind": "test"}}}
json.dump(s, open("/root/fake/base.json", "w"))
P
  chmod 600 $FAKE/base.json
  fake_state stopped
  systemctl stop ma-tb-fake-platform 2>/dev/null || true; systemctl reset-failed ma-tb-fake-platform 2>/dev/null || true
  systemd-run --quiet --unit=ma-tb-fake-platform --setenv=DESK_HOST_LIB=$L python3 -I $FAKE/fake_platform.py --port 18443 --state $FAKE/state.json --log $FAKE/requests.jsonl
  systemctl restart desk-host-link
  for i in $(seq 1 40); do grep -q '"route": "/v1/host/report", "status": 200' $FAKE/requests.jsonl 2>/dev/null && break; sleep 2; done
  grep -q '"route": "/v1/host/report", "status": 200' $FAKE/requests.jsonl || die "the link never reported to the fake Platform"
  # a fresh host's link prepares its empty slots at its first start, each a copy of the template: let them finish first
  for i in $(seq 1 180); do pgrep -f 'desk-host prepare' >/dev/null || break; sleep 5; done
  echo "the link's own prepares done after $((i * 5)) s at most: $(journalctl -u desk-host-link --no-pager -o cat | grep -c 'prepared at boot: done') slot(s)"
  echo "test host: $(cat /var/lib/desk-host/hosting.json); the link reports to the fake Platform; template $(tmpl_now)" ;;
start)
  fake_state running
  wait_report 900 running
  echo "slot 1 runs on: $(python3 -I -c 'import json; r = json.load(open("/var/lib/desk-host/slots/1.json")); print(r.get("state"), r.get("template"))')" ;;
stop)
  fake_state stopped
  wait_report 300 stopped,unmounted
  [ -z "$(runc list -q 2>/dev/null | grep -E '^dh-(desk|svc)-1(-|$)' || true)" ] || die "slot 1 still has containers"
  grep -a 'desk-browser-close' /var/log/desk-host/desk-1.log 2>/dev/null | tail -1 || true ;;
browser)
  python3 -I "$TOOLS/units.py" $K start desk-browser
  for i in $(seq 1 120); do python3 -I "$TOOLS/units.py" $K thaw desk-browser >/dev/null 2>&1 || true
    curl -s -m 2 http://10.98.$K.2:19222/json/version >/dev/null && { echo "Chromium answers on the CDP forward after ${i} s"; exit 0; }; sleep 1; done
  die "Chromium never answered on slot 1's CDP forward" ;;
template) set_template "${2:?gen}" ;;
reroot)
  G=${2:?gen}
  [ -z "$(runc list -q 2>/dev/null | grep -E '^dh-(desk|svc)-1(-|$)' || true)" ] || die "slot 1 is running: a re-root is only for a stopped slot"
  before=$(python3 -I -c 'import json; print(json.load(open("/var/lib/desk-host/slots/1.json")).get("template"))' 2>/dev/null || echo none)
  set_template "$G"
  t0=$(date +%s)
  desk-host prepare $K
  after=$(python3 -I -c 'import json; r = json.load(open("/var/lib/desk-host/slots/1.json")); print(r["state"], r["template"])')
  echo "slot 1 re-rooted in $(( $(date +%s) - t0 )) s: template [$before] -> [$after]" ;;
checks)
  G=${2:?gen}; ok=1
  echo "== the host's checks that read the template or a running slot"
  out=$($L/desk-host-check --only template,svc-dns,standin,counters,class-applied,apparmor 2>&1) || ok=0
  echo "$out"
  [ "$(echo "$out" | grep -c '^PASS')" = 6 ] || ok=0
  echo "$out" | grep -q "^PASS host template: template $(head -1 $DH/templates/$G/.complete)" || { echo "the template check didn't read $G"; ok=0; }
  rec slot-host-checks "$([ $ok = 1 ] && echo pass || echo fail)" "$(echo "$out" | sed 's/ (.*//' | paste -sd';' | cut -c1-900)"
  echo "== the wall's settings on the desk's processes (verify.sh's)"
  w=1; cg=/sys/fs/cgroup/desk-host/desk-$K
  n=$(runc list -q | grep -cE "^dh-(desk-$K|svc-$K-)" || true)
  pid=$(runc state dh-desk-$K | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  idm=$(grep -E 'idmapped' /proc/$pid/mountinfo | grep -c ' /data ' || true)
  filt=0; for p in $(cat $cg/desk/init/cgroup.procs 2>/dev/null); do case "$(tr '\0' ' ' < /proc/$p/cmdline)" in "/usr/bin/python3 -I /desk-host/desk-init.py"*) filt=$(awk '/^Seccomp_filters/{print $2}' /proc/$p/status) ;; esac; done
  rootdev=$(python3 -I -c 'import json; r = json.load(open("/var/lib/desk-host/slots/1.json")); print(r["template"])')
  echo "containers $n; memory.swap.max $(cat $cg/memory.swap.max); zswap.writeback $(cat $cg/memory.zswap.writeback); io.max lines $(grep -c riops $cg/io.max); /data idmapped $idm; desk-init filters $filt; record template [$rootdev]"
  [ "$n" = 7 ] && [ "$(cat $cg/memory.swap.max)" = 2147483648 ] && [ "$(cat $cg/memory.zswap.writeback)" = 0 ] && [ "$(grep -c riops $cg/io.max)" = 2 ] \
    && [ "$idm" -ge 1 ] && [ "$filt" -ge 2 ] && [ "$rootdev" = "$(head -1 $DH/templates/$G/.complete)" ] || w=0
  rec slot-wall "$([ $w = 1 ] && echo pass || echo fail)" "on $G: 7 containers (desk + 6 sandboxes) $n; swap.max 2 GiB, zswap writeback 0, io.max on both devices, /data idmapped, desk-init with $filt seccomp filters; the slot's record names $G"
  echo "== WR2-02 inside the desk, by configuration review (no ioctl is tried: no attack-style testing)"
  r=1; b=$((100000 + K * 65536))
  ld=$(sysctl -n dev.tty.ldisc_autoload)
  bl=$(for m in n_hdlc n_gsm ppp_async slip; do grep -qx "install $m /bin/false" /etc/modprobe.d/desk-host.conf && echo -n "$m "; done)
  loaded=$(awk '{print $1}' /proc/modules | grep -xE 'n_hdlc|n_gsm|ppp_async|slip|slcan' | paste -sd' ' || true)
  nnp=0; caps=0; nos=0; tot=0; nested=0
  dus=$(readlink /proc/$(runc state dh-desk-$K | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')/ns/user)
  for p in $(cat $(find $cg -name cgroup.procs) 2>/dev/null); do
    [ -r /proc/$p/status ] || continue; tot=$((tot + 1))
    [ "$(awk '/^NoNewPrivs/{print $2}' /proc/$p/status)" = 1 ] && nnp=$((nnp + 1))
    [ "$(awk '/^Seccomp:/{print $2}' /proc/$p/status)" = 2 ] && nos=$((nos + 1))
    # CAP_SYS_MODULE (16) or CAP_SYS_ADMIN (21) in any desk process's effective set (namespaced or not): none may have either
    # (a process in a user namespace of its own under the desk's, Chromium's sandbox, holds those only there: counted apart)
    ce=$(awk '/^CapEff/{print $2}' /proc/$p/status)
    if (( (16#$ce >> 16 & 1) || (16#$ce >> 21 & 1) )); then [ "$(readlink /proc/$p/ns/user)" = "$dus" ] && caps=$((caps + 1)) || nested=$((nested + 1)); fi
  done
  echo "ldisc_autoload $ld; blacklisted: $bl; loaded: [$loaded]; desk processes $tot: no_new_privs $nnp, seccomp $nos, with CAP_SYS_MODULE or CAP_SYS_ADMIN in the desk's user namespace $caps (in Chromium's own nested sandbox namespaces: $nested)"
  [ "$ld" = 0 ] && [ "$bl" = "n_hdlc n_gsm ppp_async slip " ] && [ -z "$loaded" ] && [ "$nnp" = "$tot" ] && [ "$nos" = "$tot" ] && [ "$caps" = 0 ] && [ "$tot" -gt 0 ] || r=0
  rec slot-wr2-02 "$([ $r = 1 ] && echo pass || echo fail)" "configuration review on $G: dev.tty.ldisc_autoload 0, n_hdlc n_gsm ppp_async slip install /bin/false, none loaded; $tot desk processes all no_new_privs and seccomp-filtered, none with CAP_SYS_MODULE or CAP_SYS_ADMIN in the desk's user namespace ($nested of Chromium's sandbox processes hold CAP_SYS_ADMIN in their own nested one)"
  echo "== desk-stream on the new generation"
  # deskd stops a desk-stream nobody is watching ("off", desk-runtime.md 8.4), once soon after its own start, so a start it
  # stops is tried again, at most three times
  s=0; lg=/var/log/desk-host/svc-$K-desk-stream.log
  for try in 1 2 3; do
    n0=$(wc -l < $lg)
    python3 -I "$TOOLS/units.py" $K start desk-stream >/dev/null || true
    st=; for i in $(seq 1 30); do st=$(tail -n +$((n0 + 1)) $lg | grep -oE '^desk-stream: (warm|live)$' | tail -1 | sed 's/^desk-stream: //' || true); [ -n "$st" ] && break
      tail -n +$((n0 + 1)) $lg | grep -q 'exited' && break; sleep 1; done
    pipe=$(tail -n +$((n0 + 1)) $lg | grep -c '^desk-stream: pipeline: .*deskcap.*x264enc.*rtph264pay.*pulsesrc.*opusenc' || true)
    [ -n "$st" ] && sleep 10
    ex=$(tail -n +$((n0 + 1)) $lg | grep -cE 'exited|restarting' || true)
    echo "try $try: pipeline built $pipe, state [${st:-none}], exits since the start $ex"; tail -n +$((n0 + 1)) $lg | grep -v pipeline | sed 's/^/  /' | tail -5
    if [ "$pipe" = 1 ] && [ -n "$st" ] && [ "$ex" = 0 ]; then s=1; break; fi
    sleep 5
  done
  python3 -I "$TOOLS/units.py" $K stop desk-stream >/dev/null 2>&1 || true
  rec slot-stream-up "$([ $s = 1 ] && echo pass || echo fail)" "on $G: desk-stream started through units.sock, built its whole pipeline (deskcap, x264enc, rtph264pay, pulsesrc, opusenc), connected to desk-rtc and said ${st:-nothing} (desk-rtc's state for a stream with no viewer), stayed up (try $try of 3: deskd stops an unwatched one); video to a WebRTC viewer is NOT proven on the builder (no client), the staging test host's e2e is (PU-3)"
  [ $ok = 1 ] && [ $w = 1 ] && [ $r = 1 ] && [ $s = 1 ] ;;
cookies-off)
  [ -z "$(runc list -q 2>/dev/null | grep -E '^dh-(desk|svc)-1(-|$)' || true)" ] || die "slot 1 is running"
  V=$(python3 -I -c 'import json; print(json.load(open("/root/fake/base.json"))["slots"]["1"]["volumeId"])')
  dev=; for c in /sys/class/nvme/nvme*; do [ "$(tr -d ' ' < "$c/serial")" = "${V/-/}" ] && dev=/dev/$(basename "$c")n1; done
  [ -n "$dev" ] || die "no device for the test volume $V"
  unshare --mount --propagation private bash -c "m=\$(mktemp -d); mount -o nosuid,nodev,noexec $dev \$m && ls -l \$m/browser/profile/Default/Cookies* && rm -f \$m/browser/profile/Default/Cookies \$m/browser/profile/Default/Cookies-journal && echo 'MUTATION: the TEST profile Cookies database removed'; umount \$m; rmdir \$m" ;;
*) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
