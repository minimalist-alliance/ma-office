#!/bin/bash
# image/host/verify-parse.sh real|mutation <deskId> <volumeId> <public address>: the Agent's attachment reader in a slot (ADR 0097;
# docs/sub-status/desk-parse.md). verify.sh and verify-port.sh run it on the host as root (R "sudo bash -s -- <mode> <desk> <vol>
# <public>" < verify-parse.sh), each mode once. Slot 1 is started by hand for the desk (the link stopped, its own runs waited for,
# every running desk stopped first). Everything here is read from the host's side or done as desk-agent does it: no escape is tried.
#   config: desk-host-check parse (the share's owners and modes and the marker, desk-parse's sandbox: uid 1113, no capabilities, its
#           own network and IPC, no /data, /tmp or /dev/shm, only lo, ADR 0097's flags and limits; desk-agent's /run/desk-parse
#           read-only), svc-spec (as svc-spec.py makes it now), oom (+500) and uids.
#   parse:  as the slot's uid 1103 (the host's uid for it, setpriv, through the share): a text file and a small PDF answer OK with
#           their words; the slot's uid 1100 is refused at the directory and the host's root gets desk-svc's "err denied"; afterwards
#           only desk-svc runs in desk-parse's cgroup, and its log on the host holds no word of either file.
#   clean:  a process and a file left in the sandbox as uid 1113 (runc exec) are gone after the next parse (desk-svc -clean).
#   memory: a process in the sandbox that fills 256 MiB is killed by the kernel (memory.events oom_kill), desk-svc staying up.
#   follow: desk-host resandbox 1 desk-agent (the live switch's own steps) makes desk-parse again on desk-agent's release, and it serves.
#           resandbox is a test host's command: the host is one for each such call only (test.conf and /var/lib/desk-host/test made and
#           removed around it, as verify.sh section 5 does; without them a baked host refused it and follow failed).
# real: "PARSE PASS" when every part passes ("<part> PASS").
# mutation: parse.sock chmod 0666 must fail config ("MUTATED CONFIG FAIL"), put back passes; desk-parse's sandbox killed must fail
#   parse ("MUTATED PARSE FAIL"), and a resandbox of desk-agent brings it back; a switch that adds a capability (SWITCH_ADD_CAP=1)
#   must fail config ("MUTATED CAP FAIL"); then the real round again ("RESTORE PASS").
# Each run leaves slot 1 stopped. Exit 2 when the step itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-parse.sh real|mutation <deskId> <volumeId> <public>}; D=${2:?}; V=${3:?}; P=${4:?}
K=1; BASE=$((100000 + K * 65536)); LOG=/var/log/desk-host/desk-$K.log; SHARE=/run/desk-host/share/$K; L=/usr/local/lib/desk-host
SOCK=$SHARE/desk-parse/sock/parse.sock; CG=/sys/fs/cgroup/desk-host/desk-$K/svc-desk-parse
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
W=$(mktemp -d); chmod 755 "$W"
LINK=$(systemctl is-active desk-host-link)
trap 'rm -rf "$W"; desk-host stop $K >/dev/null 2>&1; [ "$LINK" = active ] && systemctl start desk-host-link' EXIT
systemctl stop desk-host-link
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done
T=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as t; print(t.gen_dir(t.current_gen()))')
ASK="python3 -I $T/usr/local/lib/ma/desk-parse-ask"
WORD=quokka$RANDOM; PWORD=wombat$RANDOM
printf 'A text file for the slot reader: %s\n' "$WORD" > "$W/t.txt"
python3 -I - "$W/p.pdf" "$PWORD" <<'PY'
import sys
out, word = sys.argv[1], sys.argv[2]
content = f"BT /F1 18 Tf 20 100 Td (PDF in a slot {word}) Tj ET".encode()
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
pdf, offs = b"%PDF-1.4\n", []
for i, o in enumerate(objs, 1):
    offs.append(len(pdf)); pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
x = len(pdf)
pdf += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(b"%010d 00000 n \n" % o for o in offs) + b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % x
open(out, "wb").write(pdf)
PY

start() {
  local n i; n=$(cat "$LOG" 2>/dev/null | wc -l)
  desk-host up $K "$D" "$V" --public "$P" > "$W/up.out" 2>&1 || { echo "slot $K didn't start:"; tail -3 "$W/up.out"; return 1; }
  for i in $(seq 1 120); do tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' && break; sleep 1; done
  for i in $(seq 1 120); do [ -S "$SOCK" ] && [ -S "$SHARE/desk-agent/agent-admin.sock" ] && break; sleep 1; done
  [ -S "$SOCK" ] || { echo "slot $K: desk-parse's socket never came"; return 1; }
  sleep 2
}
as() { local u=$1; shift; setpriv --reuid=$((BASE + u)) --regid=$((BASE + u)) --clear-groups --no-new-privs "$@"; }   # a slot uid, on the host
# resandbox cap|- <k> <svc>: desk-host resandbox (the switch's own steps), a test host's command, so the host is a test host for that call
# only, as verify.sh section 5 makes it for its svc-spec breaks (TB/TU), and as it was before; cap adds SWITCH_ADD_CAP=1 (the mutation)
resandbox() {
  local cap=$1 c=0 d=0 rc; shift
  [ -e /etc/desk-host/test.conf ] || { touch /etc/desk-host/test.conf; c=1; }
  [ -d /var/lib/desk-host/test ] || { mkdir -p /var/lib/desk-host/test; d=1; }
  if [ "$cap" = cap ]; then SWITCH_ADD_CAP=1 desk-host resandbox "$@"; else desk-host resandbox "$@"; fi; rc=$?
  [ $c = 1 ] && rm -f /etc/desk-host/test.conf; [ $d = 1 ] && rmdir /var/lib/desk-host/test
  return $rc
}
svc_pid() { runc state dh-svc-$K-desk-parse 2>/dev/null | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["pid"])' 2>/dev/null; }
procs() { local p; for p in $(cat $CG/cgroup.procs 2>/dev/null); do printf '%s:%s ' "$p" "$(cat /proc/$p/comm 2>/dev/null)"; done; }

check_config() {
  local o; o=$(desk-host check --only parse,svc-spec,oom,uids 2>&1); echo "$o" | sed 's/^/  /' | cut -c1-400
  ! grep -q '^FAIL' <<<"$o"
}
check_parse() {
  local ok=0 r1 r2 r3 r4 since
  since=$(wc -l < /var/log/desk-host/svc-$K-desk-parse.log 2>/dev/null || echo 0)
  r1=$(as 1103 $ASK text 1000 1 "$SOCK" < "$W/t.txt" 2>&1); echo "  text as the slot's uid 1103: $(head -c 120 <<<"$r1" | tr '\n' '|')"
  r2=$(as 1103 $ASK pdf 1000 5 "$SOCK" < "$W/p.pdf" 2>&1); echo "  pdf as the slot's uid 1103: $(head -c 120 <<<"$r2" | tr '\n' '|')"
  [ "$(head -1 <<<"$r1" | cut -c1-2)" = OK ] && grep -q "$WORD" <<<"$r1" || { echo "  the text file didn't come back OK with its word"; ok=1; }
  [ "$(head -1 <<<"$r2" | cut -c1-2)" = OK ] && grep -q "$PWORD" <<<"$r2" || { echo "  the PDF didn't come back OK with its word"; ok=1; }
  r3=$(printf 'x\n' | as 1100 $ASK text 10 1 "$SOCK" 2>&1); echo "  as the slot's uid 1100: $r3"
  grep -q 'Permission denied' <<<"$r3" || { echo "  uid 1100 wasn't refused at the directory"; ok=1; }
  r4=$(printf 'x\n' | $ASK text 10 1 "$SOCK" 2>/dev/null); echo "  as the host's root: $r4"
  [ "$r4" = "err denied" ] || { echo "  the host's root wasn't answered err denied"; ok=1; }
  sleep 1; echo "  desk-parse's cgroup: $(procs)"
  [ "$(cat $CG/cgroup.procs 2>/dev/null | wc -l)" = 1 ] || { echo "  something but desk-svc runs in desk-parse after the parses"; ok=1; }
  tail -n +$((since + 1)) /var/log/desk-host/svc-$K-desk-parse.log 2>/dev/null | grep -qE "$WORD|$PWORD" && { echo "  desk-parse's log on the host holds a word of a file"; ok=1; }
  return $ok
}
check_clean() {
  local ok=0 r
  runc exec --user 1113:1113 dh-svc-$K-desk-parse /bin/sleep 300 > /dev/null 2>&1 &
  sleep 1; runc exec --user 1113:1113 dh-svc-$K-desk-parse /bin/sh -c ': > /run/desk-parse/sock/left' 2>&1
  echo "  before a parse: $(procs); sock holds $(ls -A "$SHARE/desk-parse/sock" | tr '\n' ' ')"
  r=$(as 1103 $ASK text 1000 1 "$SOCK" < "$W/t.txt" 2>&1 | head -1); sleep 1
  echo "  a parse: $r; after it: $(procs); sock holds $(ls -A "$SHARE/desk-parse/sock" | tr '\n' ' ')"
  [ "$(cat $CG/cgroup.procs | wc -l)" = 1 ] || { echo "  the left process outlived the parse"; ok=1; }
  [ "$(ls -A "$SHARE/desk-parse/sock")" = parse.sock ] || { echo "  the left file outlived the parse"; ok=1; }
  wait 2>/dev/null; return $ok
}
check_memory() {
  local ok=0 b a rc
  b=$(awk '$1=="oom_kill"{print $2}' $CG/memory.events)
  runc exec --user 1113:1113 dh-svc-$K-desk-parse /opt/java/openjdk/bin/java -Xms256m -Xmx256m -XX:+AlwaysPreTouch -XX:-UsePerfData -version > /dev/null 2>&1; rc=$?
  a=$(awk '$1=="oom_kill"{print $2}' $CG/memory.events)
  echo "  256 MiB in a $(( $(cat $CG/memory.max) >> 20 )) MiB sandbox: exit $rc, oom_kill $b -> $a; desk-svc $(svc_pid) $(kill -0 "$(svc_pid)" 2>/dev/null && echo alive)"
  [ "$a" -gt "$b" ] || { echo "  the kernel didn't kill it for memory"; ok=1; }
  kill -0 "$(svc_pid)" 2>/dev/null && [ -S "$SOCK" ] || { echo "  desk-svc didn't stay up"; ok=1; }
  return $ok
}
check_follow() {
  local ok=0 p0 p1 r
  p0=$(svc_pid)
  resandbox - $K desk-agent > "$W/rs.out" 2>&1 || { echo "  resandbox failed: $(tail -2 "$W/rs.out")"; ok=1; }
  for _ in $(seq 1 60); do [ -S "$SOCK" ] && [ -n "$(svc_pid)" ] && break; sleep 1; done
  p1=$(svc_pid); r=$(as 1103 $ASK text 1000 1 "$SOCK" < "$W/t.txt" 2>&1 | head -1)
  echo "  desk-parse's process 1, host pid $p0 -> $p1 after desk-agent's resandbox; root $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["root"]["path"])' /srv/desk-host/slots/$K/svc/desk-parse/config.json); a parse: $r"
  [ -n "$p1" ] && [ "$p0" != "$p1" ] || { echo "  desk-parse wasn't made again with desk-agent"; ok=1; }
  [ "$(cut -c1-2 <<<"$r")" = OK ] || { echo "  it doesn't serve after the switch's steps"; ok=1; }
  return $ok
}
round() {   # every part; prints <part> PASS|FAIL, rc 0 when all pass
  local rc=0 p
  for p in config parse clean memory follow; do
    echo "$p:"; if check_$p; then echo "$p PASS"; else echo "$p FAIL"; rc=1; fi
  done
  return $rc
}

start || exit 2
if [ "$MODE" = real ]; then
  round && echo "PARSE PASS"
  exit 0
fi
chmod 0666 "$SOCK"; echo "mutation: parse.sock 0666"; check_config && echo "MUTATED CONFIG PASS (it shouldn't)" || echo "MUTATED CONFIG FAIL"; chmod 0660 "$SOCK"
runc kill dh-svc-$K-desk-parse KILL; sleep 2; echo "mutation: desk-parse's sandbox killed"
check_parse && echo "MUTATED PARSE PASS (it shouldn't)" || echo "MUTATED PARSE FAIL"
resandbox cap $K desk-agent > "$W/rs.out" 2>&1; echo "mutation: a switch that adds CAP_CHOWN"
check_config && echo "MUTATED CAP PASS (it shouldn't)" || echo "MUTATED CAP FAIL"
resandbox - $K desk-agent > "$W/rs.out" 2>&1; for _ in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 1; done
round && echo "RESTORE PASS"
exit 0
