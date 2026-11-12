#!/bin/bash
# verify-batch.sh <part>: desk batches and idle-only apt on a booted desk (S-96; image/README.md, "Desk batches and Debian's
# updates"; docs/interfaces/desk-runtime.md section 6.1). verify.sh pipes this to root on the box once per part
# (bash -s -- <part>), and lab/desk-batch/lab.sh runs it on a lab box. Each part puts back what it changed: a throwaway
# P-256 key made here and dropped in /etc/ma/batch-keys.d for the part, a dummy component, ma-verify-batch, installed from
# file:/// artifacts, and desk-batch's state. It prints BAD <what> and FAILED for each failure, and "ran to the end" last.
# Each part has been seen to fail with what it guards broken: evidence/desk-batch-2026-11-09/mutations.txt and mutations-2.txt.
#   install   the helper, its timer (enabled, waiting) and socket (enabled, /run/desk/batch.sock 0600 desk:desk), both key
#             directories root's 0755, /opt/ma/etc/batch-keys holding exactly Platform's public release key
#             (ma-desk-batch-2026-11.pem, sha256 96287954...3f0a, root 0644, a P-256 public key) and /etc/ma/batch-keys.d empty,
#             no state, no private key and no pending batch in the image
#   apt       Debian's apt-daily and apt-daily-upgrade timers masked and never run this boot; unattended-upgrades' origins
#             only Debian's security archive (apt-config and unattended-upgrade's own dry run); Chromium's installed
#             version comes from the security archive
#   closed    deskd's offer of a batch signed with a key the image doesn't trust is refused (untrusted), nothing pending
#   socket    as deskd (uid 1100): status, hold, an offer taken with a key in the drop-in; refused: another key's signature,
#             a byte changed, a sequence number below the pending one, a URL list missing a component; rtc (1101), kiosk
#             (1102) and the agent (1103) can't use it; root can
#   idle      a pending batch applies nothing with no idle.json, a stale one, one not deskd's, or a session open; then applies
#             at once on a fresh idle one, and isn't taken again; a byte-mismatched artifact switches nothing
#   prepare   ma-update --prepare loads an image and switches nothing, --activate switches and restarts, a failed smoke test
#             puts the old release back, --unprepare drops what's prepared
#   rollback  a two-component batch whose second component fails its smoke test: the first is rolled back, the batch is
#             rolled-back, and its seq is refused from then on
#   apt-idle  desk-batch tick runs apt only while idle: not with no idle.json, then once with a fresh one, at nice 19 and the
#             idle I/O class
#   apt-forced  after 72 h without a run apt runs with no idle.json, forced, at nice 19 in the idle class; not at 71 h
set -u
part=${1:-}
DB=/usr/local/lib/ma/desk-batch
MU=/opt/ma/bin/ma-update
STATE=/var/lib/ma/batch
DROP=/etc/ma/batch-keys.d
IDLE=/run/desk/idle.json
COMP=ma-verify-batch
W=$(mktemp -d /var/tmp/verify-batch.XXXXXX); chmod 0755 "$W"
bad() { echo "BAD: $*"; echo FAILED; }
cleanup() {
  rm -f "$DROP/verify-batch.pem" "$IDLE"
  rm -rf "/opt/ma/$COMP" "$STATE/pending/"* "$STATE/state.json"
  rm -rf "$W"
  systemctl start desk-batch.timer
}
trap cleanup EXIT
# The timer's own ticks would race the part's (a tick runs apt, and holds the apply lock): it waits until the part is done,
# and a tick already running is waited for. A oneshot reads "activating" while it runs, which is-active --quiet calls down.
case "$part" in install) ;; *)
  systemctl stop desk-batch.timer
  for _ in $(seq 1 900); do
    case "$(systemctl is-active desk-batch.service)" in activating | active | deactivating | reloading) sleep 1 ;; *) break ;; esac
  done ;;
esac
as() { local u=$1; shift; setpriv --reuid "$u" --regid "$u" --clear-groups "$@"; }
# ask <uid> <line>: one request on batch.sock as that uid; prints the answer line, or "connect: <errno name>"
ask() {
  as "$1" python3 -I -c '
import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect("/run/desk/batch.sock")
except OSError as e:
    print("connect:", type(e).__name__); sys.exit(0)
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
b = b""
while not b.endswith(b"\n"):
    c = s.recv(65536)
    if not c: break
    b += c
print(b.decode().strip())' <<<"$2"
}
key() { openssl ecparam -name prime256v1 -genkey -noout -out "$W/$1.key" 2>/dev/null && openssl pkey -in "$W/$1.key" -pubout -out "$W/$1.pem" 2>/dev/null; }
trust() { install -m 0644 -o root -g root "$W/$1.pem" "$DROP/verify-batch.pem"; }
# artifact <version> [health exit] [with image]: a dummy release's .tgz in $W; prints its file:// URL and sha256
artifact() {
  local v=$1 h=${2:-0} img=${3:-} d
  d=$W/src-$v
  rm -rf "$d"; mkdir -p "$d"; echo "$v" > "$d/VERSION"
  printf '#!/bin/sh\nexec sleep infinity\n' > "$d/run"; printf '#!/bin/sh\nexit %s\n' "$h" > "$d/health"; chmod 0755 "$d/run" "$d/health"
  if [ -n "$img" ]; then   # a one-file image of its own, made without a build
    mkdir -p "$W/root-$v"; echo "$v" > "$W/root-$v/v"
    tar -C "$W/root-$v" -c . | docker import - "ma/$COMP:$v" >/dev/null && docker save "ma/$COMP:$v" -o "$d/image.tar" \
      && docker rmi -f "ma/$COMP:$v" >/dev/null 2>&1
  fi
  tar -czf "$W/$COMP-$v.tgz" -C "$d" . && echo "file://$W/$COMP-$v.tgz $(sha256sum "$W/$COMP-$v.tgz" | cut -d' ' -f1)"
}
# manifest <seq> <name:version:sha>...: a manifest in $W/m<seq>.json, signed with key $KEY into $W/m<seq>.sig
manifest() {
  local seq=$1; shift
  python3 -I - "$seq" "$@" > "$W/m$seq.json" <<'P'
import json, sys
seq, comps = int(sys.argv[1]), [a.split(":") for a in sys.argv[2:]]
print(json.dumps({"format": "ma-desk-batch/1", "seq": seq, "id": "verify-%d" % seq, "created": "2026-11-09T18:00:00Z",
                  "urgent": False, "components": [{"name": n, "version": v, "sha256": s} for n, v, s in comps], "note": ""}))
P
  openssl dgst -sha256 -sign "$W/${KEY:-k}.key" -out "$W/m$seq.sig" "$W/m$seq.json"
}
# offer_line <seq> <name=url>...: the socket's offer line for $W/m<seq>.json
offer_line() {
  local seq=$1; shift
  python3 -I - "$W/m$seq.json" "$W/m$seq.sig" "$@" <<'P'
import base64, json, sys
m, s = open(sys.argv[1], "rb").read(), open(sys.argv[2], "rb").read()
urls = dict(a.split("=", 1) for a in sys.argv[3:])
print("offer " + json.dumps({"manifest": base64.b64encode(m).decode(), "signature": base64.b64encode(s).decode(), "urls": {"components": urls}}))
P
}
# idle_file <seconds idle> [age of at] [owner]: idle.json as deskd would write it
# plant_first <hours>: apt's firstSeen that many hours before this box's clock. A fixed date would drift past desk-batch's
# 72 h force line and make "not with no idle.json" fail by design (0.3.6's first run, 2026-11-12, planted 2026-11-09).
plant_first() {
  python3 -I -c 'import json, sys, time
t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - float(sys.argv[1]) * 3600))
json.dump({"format": 1, "apt": {"firstSeen": t}}, open("/var/lib/ma/batch/state.json", "w"))' "$1"
}
idle_file() {
  local since=$1 age=${2:-0} owner=${3:-1100}
  python3 -I -c 'import json, sys, time; n = time.time(); u = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
print(json.dumps({"at": u(n - int(sys.argv[2])), "sessions": int(sys.argv[3]), "agentTasks": 0, "exports": 0, "downloads": 0,
                  "idleSince": u(n - int(sys.argv[1])), "idleStopSeconds": 1200}))' "$since" "$age" "${SESSIONS:-0}" > "$IDLE.tmp"
  chown "$owner:$owner" "$IDLE.tmp"; mv "$IDLE.tmp" "$IDLE"
}
st() { python3 -I -c 'import json, sys; d = json.load(open("/var/lib/ma/batch/state.json")); print(eval(sys.argv[1], {"d": d}))' "$1" 2>&1 | tail -1; }
cur() { basename "$(readlink "/opt/ma/$1/current" 2>/dev/null)" 2>/dev/null; }

case "$part" in
install)
  [ "$(stat -c '%U %a' $DB)" = "root 755" ] || bad "the helper: $(stat -c '%U %a' $DB)"
  for u in desk-batch.timer desk-batch.socket; do [ "$(systemctl is-enabled $u)" = enabled ] || bad "$u not enabled"; done
  systemctl is-active --quiet desk-batch.timer || bad "the timer isn't waiting"
  systemctl list-timers --all --no-legend desk-batch.timer | grep -q desk-batch.service || bad "the timer triggers nothing"
  [ "$(stat -c '%U:%G %a %F' /run/desk/batch.sock 2>&1)" = "desk:desk 600 socket" ] || bad "batch.sock: $(stat -c '%U:%G %a %F' /run/desk/batch.sock 2>&1)"
  for d in /opt/ma/etc/batch-keys $DROP; do
    [ "$(stat -c '%U %a %F' $d 2>&1)" = "root 755 directory" ] || bad "$d: $(stat -c '%U %a %F' $d 2>&1)"
  done
  [ -z "$(ls -A $DROP 2>/dev/null)" ] || bad "$DROP isn't empty: $(ls -A $DROP)"
  K=/opt/ma/etc/batch-keys/ma-desk-batch-2026-11.pem
  [ "$(ls -A /opt/ma/etc/batch-keys)" = "$(basename $K)" ] || bad "the image's keys aren't exactly Platform's: $(ls -A /opt/ma/etc/batch-keys)"
  [ "$(stat -c '%U:%G %a %F' $K 2>&1)" = "root:root 644 regular file" ] || bad "$K: $(stat -c '%U:%G %a %F' $K 2>&1)"
  kh=$(sha256sum $K 2>/dev/null | cut -d' ' -f1)
  case "$kh" in 96287954*3f0a) ;; *) bad "the release key's sha256 is $kh, not 96287954...3f0a" ;; esac
  openssl pkey -pubin -in $K -text -noout 2>/dev/null | grep -q 'ASN1 OID: prime256v1' || bad "$K isn't a P-256 public key"
  grep -q 'PRIVATE KEY' $K && bad "$K holds a private key"
  echo "release key: $kh"
  [ -z "$(ls -A $STATE/pending 2>/dev/null)" ] || bad "a pending batch in the image"
  echo "units: $(systemctl show -p NextElapseUSecMonotonic --value desk-batch.timer) next; socket $(stat -c '%U:%G %a' /run/desk/batch.sock)"
  ;;
apt)
  for t in apt-daily.timer apt-daily-upgrade.timer; do
    [ "$(systemctl is-enabled $t 2>&1)" = masked ] || bad "$t is $(systemctl is-enabled $t 2>&1), not masked"
    s=${t%.timer}.service
    [ -z "$(systemctl show -p InvocationID --value $s)" ] || bad "$s ran this boot"
    journalctl -b -u "$s" -o cat --no-pager 2>/dev/null | grep -q . && bad "$s logged this boot"
  done
  for t in apt-daily.timer apt-daily-upgrade.timer; do systemctl is-active --quiet $t && bad "$t is active"; done
  # systemd still lists a masked timer with its last run (the builder's); one with a next run is waiting to fire.
  systemctl list-timers --all --no-legend | awk '$1 != "-"' | grep -q 'apt-daily' && bad "an apt timer will fire: $(systemctl list-timers --all --no-legend | grep apt-daily)"
  pat=$(apt-config dump | sed -n 's/^Unattended-Upgrade::Origins-Pattern:: "\(.*\)";$/\1/p' | sort | paste -sd'|')
  want='origin=Debian,codename=${distro_codename},label=Debian-Security|origin=Debian,codename=${distro_codename}-security,label=Debian-Security'
  [ "$pat" = "$want" ] || bad "origins: $pat"
  apt-config dump | grep -q '^Unattended-Upgrade::Allowed-Origins:: ' && bad "Allowed-Origins isn't empty"
  allowed=$(unattended-upgrade --dry-run -d 2>&1 | sed -n 's/.*Allowed origins are: //p' | head -1)
  echo "unattended-upgrade's allowed origins: $allowed"
  case "$allowed" in *"trixie-security,label=Debian-Security"*) ;; *) bad "unattended-upgrade allows: $allowed" ;; esac
  case "$allowed" in *"label=Debian,"* | *"label=Debian'"* | *"codename=trixie,label=Debian"[^-]* | *updates*) bad "unattended-upgrade allows more: $allowed" ;; esac
  # Chromium's own updates: the installed version, and where apt finds it. The bake empties the lists, so read them first.
  nice -n 19 ionice -c3 apt-get -q update >/dev/null 2>&1 || bad "apt-get update failed"
  pol=$(apt-cache policy chromium)
  echo "$pol" | sed 's/^/  /'
  inst=$(dpkg-query -W -f='${Version}' chromium)
  echo "$pol" | awk -v v="$inst" '$0 ~ "^ +(\\*\\*\\* )?"v" " {f=1; next} f && /^ +[0-9]+ / {print; next} f {exit}' | grep -q 'trixie-security' \
    || bad "the installed Chromium ($inst) isn't from trixie-security"
  ;;
closed)
  KEY=k; key k
  manifest 7001 "$COMP:1:$(printf 'a%.0s' $(seq 64))"
  a=$(ask 1100 "$(offer_line 7001 "$COMP=https://example.invalid/x.tgz")")
  echo "a key the image doesn't trust, deskd's offer: $a"
  case "$a" in "err untrusted"*) ;; *) bad "an offer signed by an untrusted key: $a" ;; esac
  [ "$(st 'd["pending"]')" = None ] || [ ! -e $STATE/state.json ] || bad "something is pending: $(st 'd["pending"]')"
  ;;
socket)
  KEY=k; key k; key other; trust k
  read -r u1 s1 < <(artifact 1)
  manifest 7001 "$COMP:1:$s1"
  a=$(ask 1100 status); case "$a" in "ok {"*) ;; *) bad "status as deskd: $a" ;; esac
  a=$(ask 1100 "hold 5"); case "$a" in 'ok {"holdUntil": "'*) ;; *) bad "hold as deskd: $a" ;; esac
  a=$(ask 1100 "hold 16"); case "$a" in "err bad_request"*) ;; *) bad "hold 16: $a" ;; esac
  a=$(ask 1100 "$(offer_line 7001 "$COMP=$u1")"); echo "offer as deskd: $a"
  [ "$a" = 'ok {"seq": 7001, "id": "verify-7001"}' ] || bad "a signed offer as deskd: $a"
  KEY=other manifest 7002 "$COMP:1:$s1"
  a=$(ask 1100 "$(offer_line 7002 "$COMP=$u1")"); case "$a" in "err untrusted"*) ;; *) bad "another key's signature: $a" ;; esac
  manifest 7003 "$COMP:1:$s1"; sed -i 's/verify-7003/verify-7004/' "$W/m7003.json"
  a=$(ask 1100 "$(offer_line 7003 "$COMP=$u1")"); case "$a" in "err untrusted"*) ;; *) bad "a byte changed: $a" ;; esac
  manifest 7000 "$COMP:1:$s1"
  a=$(ask 1100 "$(offer_line 7000 "$COMP=$u1")"); case "$a" in "err seq"*) ;; *) bad "a lower seq: $a" ;; esac
  manifest 7005 "$COMP:1:$s1"
  a=$(ask 1100 "$(offer_line 7005)"); case "$a" in "err bad_request"*) ;; *) bad "no URL for a component: $a" ;; esac
  # rtc (1101) owns /run/desk, so it's the one other uid that reaches the socket file: refused by its mode, and by the
  # helper's own uid check behind that. kiosk and the agent can't enter /run/desk at all.
  for u in 1101 1102 1103; do a=$(ask $u status); case "$a" in "connect: PermissionError" | "err denied"*) ;; *) bad "uid $u: $a" ;; esac; done
  a=$(ask 0 status); case "$a" in "ok {"*) ;; *) bad "root: $a" ;; esac
  [ "$(st 'd["pending"]["seq"]')" = 7001 ] || bad "pending: $(st 'd["pending"]')"
  journalctl -u 'desk-batch@*' --since '-2 min' -o cat --no-pager | grep -q 'file://' && bad "a URL reached the journal"
  ;;
idle)
  KEY=k; key k; trust k
  read -r u1 s1 < <(artifact 1); read -r u2 s2 < <(artifact 2)
  MA_INSTALL_ONLY=1 $MU $COMP "$u1" "$s1" 2>/dev/null || bad "couldn't install $COMP 1"
  manifest 7001 "$COMP:2:$s2"
  printf '{"components": {"%s": "%s"}}\n' "$COMP" "$u2" > "$W/urls.json"
  $DB offer "$W/m7001.json" "$W/m7001.sig" "$W/urls.json" >/dev/null || bad "offer"
  t() { $DB tick 2>/dev/null; echo "$1: $(st 'd["phase"]') ($(st 'd["idle"]["reason"]')), $COMP $(cur $COMP)"; }
  rm -f $IDLE; t "no idle.json"; [ "$(cur $COMP)" = 1 ] || bad "applied with no idle.json"
  idle_file 1200 120; t "idle.json 120 s old"; [ "$(cur $COMP)" = 1 ] || bad "applied on a stale idle.json"
  idle_file 1200 0 0; t "idle.json root's"; [ "$(cur $COMP)" = 1 ] || bad "applied on an idle.json not deskd's"
  SESSIONS=1 idle_file 1200; t "a session open"; [ "$(cur $COMP)" = 1 ] || bad "applied with a session open"
  idle_file 300; t "idle 300 s of 600"; [ "$(cur $COMP)" = 1 ] || bad "applied after 300 s idle"
  idle_file 1200; t "idle 1200 s"; [ "$(cur $COMP)" = 2 ] || bad "not applied on a fresh idle.json"
  [ "$(st 'd["appliedSeq"]')" = 7001 ] || bad "appliedSeq: $(st 'd["appliedSeq"]')"
  a=$($DB offer "$W/m7001.json" "$W/m7001.sig" "$W/urls.json" 2>&1); case "$a" in "err seq"*) ;; *) bad "the applied batch offered again: $a" ;; esac
  # bytes that don't match the manifest: nothing switched
  read -r u3 _ < <(artifact 3); read -r _ s3 < <(artifact 3b)
  manifest 7002 "$COMP:3:$s3"; printf '{"components": {"%s": "%s"}}\n' "$COMP" "$u3" > "$W/urls.json"
  $DB offer "$W/m7002.json" "$W/m7002.sig" "$W/urls.json" >/dev/null || bad "offer 7002"
  t "a URL whose bytes don't match"
  [ "$(cur $COMP)" = 2 ] && [ ! -e /opt/ma/$COMP/prepared ] || bad "a mismatched artifact changed something"
  case "$(st 'd["lastError"]["text"]')" in *"sha256 mismatch"*) ;; *) bad "lastError: $(st 'd["lastError"]')" ;; esac
  ;;
prepare)
  read -r u1 s1 < <(artifact 1 0 img); read -r u2 s2 < <(artifact 2 0 img); read -r u3 s3 < <(artifact 3 1 img)
  $MU $COMP "$u1" "$s1" >/dev/null 2>&1 || bad "install 1"
  before=$(systemctl show -p NRestarts --value desk-rtc)
  $MU $COMP --prepare "$u2" "$s2" 2>"$W/err" || bad "prepare 2: $(cat "$W/err")"
  echo "after prepare: current $(cur $COMP), prepared $(basename "$(readlink /opt/ma/$COMP/prepared)")"
  [ "$(cur $COMP)" = 1 ] && [ "$(basename "$(readlink /opt/ma/$COMP/prepared)")" = 2 ] || bad "prepare switched something"
  docker image inspect "$(cat /opt/ma/$COMP/releases/2/image-id 2>/dev/null)" >/dev/null 2>&1 || bad "prepare didn't load the image"
  [ ! -e /opt/ma/$COMP/releases/2/image.tar ] || bad "image.tar left"
  $MU $COMP --activate 2 >/dev/null 2>&1 || bad "activate 2"
  [ "$(cur $COMP)" = 2 ] && [ "$(basename "$(readlink /opt/ma/$COMP/previous)")" = 1 ] && [ ! -e /opt/ma/$COMP/prepared ] || bad "activate 2 didn't switch"
  $MU $COMP --prepare "$u3" "$s3" >/dev/null 2>&1 || bad "prepare 3"
  $MU $COMP --activate 3 >/dev/null 2>&1; rc=$?
  echo "activate of a release whose health fails: exit $rc, current $(cur $COMP)"
  [ "$rc" = 1 ] && [ "$(cur $COMP)" = 2 ] && [ ! -e /opt/ma/$COMP/releases/3 ] || bad "a failed activate wasn't put back"
  $MU $COMP --prepare "$u1" "$s1" 2>/dev/null && [ "$(basename "$(readlink /opt/ma/$COMP/prepared)")" = 1 ] || bad "previous wasn't prepared from what's there"
  $MU $COMP --unprepare 2>/dev/null && [ ! -e /opt/ma/$COMP/prepared ] && [ -d /opt/ma/$COMP/releases/1 ] || bad "unprepare"
  for r in 1 2; do id=$(cat /opt/ma/$COMP/releases/$r/image-id 2>/dev/null); [ -z "$id" ] || docker rmi -f "$id" >/dev/null 2>&1; done
  [ "$(systemctl show -p NRestarts --value desk-rtc)" = "$before" ] || bad "desk-rtc restarted"
  ;;
rollback)
  KEY=k; key k; trust k
  read -r a1 as1 < <(artifact 1); read -r a2 as2 < <(artifact 2)
  MA_INSTALL_ONLY=1 $MU $COMP "$a1" "$as1" 2>/dev/null || bad "install $COMP 1"
  B=ma-verify-batch-b
  d=$W/b; mkdir -p "$d"; echo 9 > "$d/VERSION"; printf '#!/bin/sh\nexit 0\n' > "$d/run"; printf '#!/bin/sh\nexit 1\n' > "$d/health"; chmod 0755 "$d/run" "$d/health"
  tar -czf "$W/b.tgz" -C "$d" .; bs=$(sha256sum "$W/b.tgz" | cut -d' ' -f1)
  manifest 7101 "$COMP:2:$as2" "$B:9:$bs"
  printf '{"components": {"%s": "%s", "%s": "file://%s"}}\n' "$COMP" "$a2" "$B" "$W/b.tgz" > "$W/urls.json"
  $DB offer "$W/m7101.json" "$W/m7101.sig" "$W/urls.json" >/dev/null || bad "offer"
  idle_file 1200; $DB tick 2>"$W/err"
  echo "phase $(st 'd["phase"]'), $COMP $(cur $COMP), $B $(cur $B), error: $(st 'd["lastError"]["text"]')"
  [ "$(st 'd["phase"]')" = rolled-back ] || bad "phase $(st 'd["phase"]')"
  [ "$(cur $COMP)" = 1 ] || bad "$COMP wasn't rolled back: $(cur $COMP)"
  [ -z "$(cur $B)" ] || bad "$B stayed: $(cur $B)"
  [ "$(st 'd["failedSeq"]')" = 7101 ] || bad "failedSeq $(st 'd["failedSeq"]')"
  $DB offer "$W/m7101.json" "$W/m7101.sig" "$W/urls.json" 2>&1 | grep -q '^err seq' || bad "the rolled-back batch was taken again"
  rm -rf "/opt/ma/$B"
  ;;
apt-idle)
  plant_first 1   # first seen an hour ago, well inside desk-batch's 72 h (APT_FORCE_S) after which apt runs without idle
  rm -f $IDLE
  n0=$(grep -c 'Starting unattended upgrades script' /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null)
  $DB tick 2>/dev/null
  [ "$(st 'd["apt"].get("lastAttempt")')" = None ] || bad "apt ran with no idle.json: $(st 'd["apt"]')"
  idle_file 1200
  # Not pgrep -x: unattended-upgrade-shutdown, which waits from boot at nice 0, has the same 15-character name.
  ( while :; do p=$(pgrep -f '^/usr/bin/python3 /usr/bin/unattended-upgrade$' | head -1); [ -n "$p" ] && { echo "$(ps -o ni= -p $p) $(ionice -p $p)" > "$W/prio"; break; }; sleep 0.2; done ) &
  watcher=$!
  $DB tick 2>/dev/null
  kill $watcher 2>/dev/null
  n1=$(grep -c 'Starting unattended upgrades script' /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null)
  echo "apt: $(st 'd["apt"]'), unattended-upgrade runs logged $n0 -> $n1, its priority: $(cat "$W/prio" 2>/dev/null)"
  [ "$(st 'd["apt"]["lastResult"]')" = ok ] || bad "apt didn't run while idle: $(st 'd["apt"]')"
  [ "$n1" -gt "${n0:-0}" ] || bad "unattended-upgrade didn't log a run"
  grep -q '^ *19 idle$' "$W/prio" 2>/dev/null || bad "priority: $(cat "$W/prio" 2>/dev/null)"
  ;;
apt-forced)
  # desk-batch forces apt after 72 h without a run, idle or not (APT_FORCE_S): 71 h doesn't, 73 h does, at nice 19 in the idle class.
  plant_first 71; rm -f $IDLE
  $DB tick 2>/dev/null
  [ "$(st 'd["apt"].get("lastAttempt")')" = None ] || bad "apt ran at 71 h with no idle.json: $(st 'd["apt"]')"
  plant_first 73
  n0=$(grep -c 'Starting unattended upgrades script' /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null)
  ( while :; do p=$(pgrep -f '^/usr/bin/python3 /usr/bin/unattended-upgrade$' | head -1); [ -n "$p" ] && { echo "$(ps -o ni= -p $p) $(ionice -p $p)" > "$W/prio"; break; }; sleep 0.2; done ) &
  watcher=$!
  $DB tick 2>/dev/null
  kill $watcher 2>/dev/null
  n1=$(grep -c 'Starting unattended upgrades script' /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null)
  echo "apt: $(st 'd["apt"]'), unattended-upgrade runs logged $n0 -> $n1, its priority: $(cat "$W/prio" 2>/dev/null)"
  [ "$(st 'd["apt"]["lastResult"]')" = ok ] || bad "apt didn't run at 73 h: $(st 'd["apt"]')"
  [ "$(st 'd["apt"]["forced"]')" = True ] || bad "apt ran but not as forced: $(st 'd["apt"]')"
  [ "$n1" -gt "${n0:-0}" ] || bad "unattended-upgrade didn't log a run"
  grep -q '^ *19 idle$' "$W/prio" 2>/dev/null || bad "priority: $(cat "$W/prio" 2>/dev/null)"
  ;;
*) echo "usage: verify-batch.sh install|apt|closed|socket|idle|prepare|rollback|apt-idle|apt-forced" >&2; exit 2 ;;
esac
echo "ran to the end"
