#!/bin/bash
# image/host/verify-courier.sh real|mutation <deskId> <volumeId> <public address> <blocker.pin sha256>: Courier's mail reader in a slot
# (desk-parse-courier, ADR 0097's sandbox for deskd; docs/sub-status/courier-slot.md) and a slot's deskd egress for linked mailboxes.
# verify.sh and verify-port.sh run it on the host as root (R "sudo bash -s -- <mode> <desk> <vol> <public> <sha256>" < verify-courier.sh),
# each mode once; the sha256 is image/recipe/adblock/blocker.pin's, read on the workstation. Slot 1 is started by hand for the desk (the
# link stopped, its own runs waited for, every running desk stopped first). Everything is read from the host's side or done as deskd does
# it: no escape is tried.
#   config: desk-host-check courier-parse (the share's owners and modes; the sandbox: uid 1113, no capabilities, non-dumpable, a network and
#           IPC namespace of its own, no /data, /tmp, /dev/shm or other /run/desk*, only lo, its flags and limits, the tracker list's bind;
#           deskd's /run/desk-parse-courier read-only), courier-dirs (deskd's /data/courier and /data/keys the volume's, 1100:1100 0700),
#           svc-spec (as svc-spec.py makes it now), oom (+500) and uids.
#   parse:  as the slot's uid 1100 (the host's uid for it, setpriv, through the share), the message
#           'courier1 message\nFrom: v@example.com\nSubject: v\n\nverify-courier\n' answers OK with verify-courier in its JSON; the slot's
#           uid 1103 is refused at the directory; uid 1101 with the desk group (as desk-rtc's sandbox runs) and the host's root reach the
#           socket and get desk-svc's "err denied"; afterwards only desk-svc runs in its cgroup, and its log on the host holds no word of it.
#   list:   the tracker list the reader sees (/app/courier/trackers.txt in its root) is the template's, thousands of entries, and its first
#           line names uBlock Origin Lite's version and the sha256 blocker.pin pins (Security's condition on mm-courier-parse's question 2).
#   follow: desk-host resandbox 1 desk-agent (the live switch's own steps) makes desk-parse-courier again on desk-agent's release, and it
#           serves. resandbox is a test host's command: the host is one for each such call only, as verify.sh section 5 makes it.
#   egress: from slot 1's network namespace (deskd's: its sandbox joins the desk's) as the slot's uid 1100, an MX lookup of gmail.com through
#           the resolver deskd's sandbox reads (its /etc/resolv.conf, the template's: 169.254.169.253 on 53), and TCP to imap.gmail.com:993,
#           smtp.gmail.com:465 and smtp.gmail.com:587, each name looked up there too. TCP 25 to the MX is said, never judged.
# real: "COURIER PASS" when config, parse, list and follow pass ("<part> PASS"); "EGRESS PASS" when egress does.
# mutation, each of which must fail its part: parse.sock chmod 0666 ("MUTATED SOCKET FAIL", config); the sandbox made by hand from its spec
#   with the slot's /run/desk share mounted ("MUTATED MOUNTS FAIL"), in the desk's network namespace ("MUTATED NETWORK FAIL") and as uid
#   1100:1100 ("MUTATED IDENTITY FAIL"), each config; the sandbox killed ("MUTATED PARSE FAIL", parse); a list whose first line names
#   another sha256 bound over the template's ("MUTATED LIST FAIL", list); DNS, 465, 587 and 993 dropped on slot 1's way out of the host
#   ("MUTATED EGRESS FAIL", egress). Each put back, then the real round again ("RESTORE PASS") and egress again ("EGRESS RESTORE PASS").
# parse and follow need a desk-agent release with /app/courier-parse.options (Courier's mode) in the host's store; list needs a template
# from desk recipe 0.3.9 on (the tracker list built at bake). Each run leaves slot 1 stopped. Exit 2 when the step itself couldn't run;
# else 0, and the lines say.
set -u
MODE=${1:?usage: verify-courier.sh real|mutation <deskId> <volumeId> <public> <blocker.pin sha256>}; D=${2:?}; V=${3:?}; P=${4:?}; PIN=${5:?}
[[ $PIN =~ ^[0-9a-f]{64}$ ]] || { echo "the blocker.pin sha256 isn't 64 hex"; exit 2; }
K=1; BASE=$((100000 + K * 65536)); LOG=/var/log/desk-host/desk-$K.log; SHARE=/run/desk-host/share/$K; L=/usr/local/lib/desk-host
NAME=desk-parse-courier; SOCK=$SHARE/$NAME/sock/parse.sock; CG=/sys/fs/cgroup/desk-host/desk-$K/svc-$NAME
BUNDLE=/srv/desk-host/slots/$K/svc/$NAME; SLOG=/var/log/desk-host/svc-$K-$NAME.log; NSB=/run/desk-host/ns/$K/mnt-$NAME
LIST=usr/share/ma/adblock/courier-trackers.txt; WORD=verify-courier; TAG=verify-courier-egress
N=$(python3 -I -c 'import json; h = json.load(open("/var/lib/desk-host/hosting.json")); print(h.get("slotsPerHost") or h["desksPerHost"])')
W=$(mktemp -d); chmod 755 "$W"; TF=
LINK=$(systemctl is-active desk-host-link)
cleanup() {
  emut fix >/dev/null 2>&1; [ -n "$TF" ] && mountpoint -q "$TF" && umount "$TF"
  rm -rf "$W"; desk-host stop $K >/dev/null 2>&1; [ "$LINK" = active ] && systemctl start desk-host-link
}
trap cleanup EXIT
systemctl stop desk-host-link
for _ in $(seq 1 600); do pgrep -f 'desk-host (up|stop|class|restart|prepare) [0-9]' >/dev/null || break; sleep 1; done
pgrep -af 'desk-host (up|stop|class|restart|prepare) [0-9]' && { echo "the link's own desk-host runs didn't end in 600 s"; exit 2; }
for k in $(seq 1 "$N"); do runc state dh-desk-$k >/dev/null 2>&1 && { desk-host stop $k >/dev/null 2>&1 || echo "slot $k: its stop failed"; }; done
printf 'courier1 message\nFrom: v@example.com\nSubject: v\n\n%s\n' "$WORD" > "$W/msg"
# deskd's side of the wire (CourierSandbox): connect, the request and the message, a half-close, then the whole answer (1 MiB at most)
ASK='import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
try:
    s.connect(sys.argv[1])
except OSError as e:
    print(f"connect: {e.strerror or e}")
    sys.exit(4)
data = sys.stdin.buffer.read()
try:
    s.sendall(data)
    s.shutdown(socket.SHUT_WR)
except OSError:
    pass
out = b""
try:
    while len(out) < 1 << 20:
        b = s.recv(65536)
        if not b:
            break
        out += b
except OSError as e:
    print(f"read: {e}")
sys.stdout.write(out.decode("utf-8", "replace"))'
# the egress probe, run in the slot's network namespace as its uid 1100: a DNS client of its own (the host's resolver config isn't the
# desk's), MX then A over UDP to the nameserver deskd's sandbox has, then TCP to each port. Exit 0 when the MX and every TCP connect worked.
EG='import random, socket, struct, sys
ns = next((l.split()[1] for l in sys.argv[1].splitlines() if len(l.split()) > 1 and l.split()[0] == "nameserver"), None)
if not ns:
    print("no nameserver in the resolv.conf deskd reads")
    sys.exit(1)
def name_at(d, o):
    labels, nxt = [], None
    for _ in range(128):
        n = d[o]
        if n == 0:
            o += 1
            break
        if n & 0xC0 == 0xC0:
            nxt = o + 2 if nxt is None else nxt
            o = ((n & 0x3F) << 8) | d[o + 1]
            continue
        labels.append(d[o + 1:o + 1 + n].decode("ascii", "replace"))
        o += 1 + n
    return ".".join(labels), (o if nxt is None else nxt)
def ask(name, qtype):
    tid = random.randrange(65536)
    q = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\0" + struct.pack(">HH", qtype, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    d = None
    for _ in range(3):
        try:
            s.sendto(q, (ns, 53))
            d, _a = s.recvfrom(4096)
            if d[:2] == q[:2]:
                break
        except OSError:
            d = None
    s.close()
    if not d or d[:2] != q[:2]:
        return None, "no answer"
    qd, an = struct.unpack(">HH", d[4:8])
    if d[3] & 0xF:
        return None, f"rcode {d[3] & 0xF}"
    o, out = 12, []
    for _ in range(qd):
        o = name_at(d, o)[1] + 4
    for _ in range(an):
        o = name_at(d, o)[1]
        t, _c, _ttl, n = struct.unpack(">HHIH", d[o:o + 10])
        o += 10
        if t == qtype == 15:
            out.append(name_at(d, o + 2)[0])
        elif t == qtype == 1 and n == 4:
            out.append(socket.inet_ntoa(d[o:o + 4]))
        o += n
    return out, "ok"
ok = True
mx, why = ask("gmail.com", 15)
print(f"MX gmail.com through {ns}: {sorted(mx) if mx else why}")
ok &= bool(mx)
for host, port in (("imap.gmail.com", 993), ("smtp.gmail.com", 465), ("smtp.gmail.com", 587)):
    a, why = ask(host, 1)
    if not a:
        print(f"TCP {host}:{port}: {host} did not resolve ({why})")
        ok = False
        continue
    try:
        socket.create_connection((a[0], port), timeout=10).close()
        print(f"TCP {host}:{port} ({a[0]}): connected")
    except OSError as e:
        print(f"TCP {host}:{port} ({a[0]}): {e.strerror or e}")
        ok = False
if mx:
    a, _w = ask(sorted(mx)[0], 1)
    try:
        socket.create_connection((a[0], 25), timeout=5).close()
        r = "connected"
    except (OSError, TypeError, IndexError) as e:
        r = getattr(e, "strerror", None) or type(e).__name__
    print(f"TCP {sorted(mx)[0]}:25 (said, not judged): {r}")
sys.exit(0 if ok else 1)'

start() {
  local n i; n=$(cat "$LOG" 2>/dev/null | wc -l)
  desk-host up $K "$D" "$V" --public "$P" > "$W/up.out" 2>&1 || { echo "slot $K didn't start:"; tail -3 "$W/up.out"; return 1; }
  for i in $(seq 1 120); do tail -n +$((n + 1)) "$LOG" | grep -q '\] up: ' && break; sleep 1; done
  for i in $(seq 1 120); do [ -S "$SOCK" ] && [ -e "$SHARE/desk/idle.json" ] && break; sleep 1; done
  [ -S "$SOCK" ] || { echo "slot $K: $NAME's socket never came"; return 1; }
  sleep 2
}
as() { local u=$1; shift; setpriv --reuid=$((BASE + u)) --regid=$((BASE + u)) --clear-groups --no-new-privs "$@"; }     # a slot uid, on the host
asg() { local u=$1 g=$2; shift 2; setpriv --reuid=$((BASE + u)) --regid=$((BASE + u)) --groups=$((BASE + g)) --no-new-privs "$@"; }   # and a group
pid_of() { runc state "$1" 2>/dev/null | python3 -I -c 'import json, sys; j = json.load(sys.stdin); print(j["pid"] if j.get("status") == "running" else "")' 2>/dev/null; }
svc_pid() { pid_of dh-svc-$K-$NAME; }
procs() { local p; for p in $(cat $CG/cgroup.procs 2>/dev/null); do printf '%s:%s ' "$p" "$(cat /proc/$p/comm 2>/dev/null)"; done; }
# resandbox <k> <svc>: desk-host resandbox, a test host's command, with the host a test host for that call only (as verify.sh section 5)
resandbox() {
  local c=0 d=0 rc
  [ -e /etc/desk-host/test.conf ] || { touch /etc/desk-host/test.conf; c=1; }
  [ -d /var/lib/desk-host/test ] || { mkdir -p /var/lib/desk-host/test; d=1; }
  desk-host resandbox "$@"; rc=$?
  [ $c = 1 ] && rm -f /etc/desk-host/test.conf; [ $d = 1 ] && rmdir /var/lib/desk-host/test
  for _ in $(seq 1 60); do [ -S "$SOCK" ] && [ -n "$(svc_pid)" ] && break; sleep 1; done
  return $rc
}

check_config() {
  local o; o=$(desk-host check --only courier-parse,courier-dirs,svc-spec,oom,uids 2>&1); echo "$o" | sed 's/^/  /' | cut -c1-400
  ! grep -q '^FAIL' <<<"$o"
}
check_parse() {
  local ok=0 r1 r2 r3 r4 since
  since=$(wc -l < "$SLOG" 2>/dev/null || echo 0)
  r1=$(as 1100 python3 -I -c "$ASK" "$SOCK" < "$W/msg" 2>&1); echo "  the message as the slot's uid 1100: $(head -c 200 <<<"$r1" | tr '\n' '|')"
  [ "$(head -1 <<<"$r1" | cut -c1-2)" = OK ] && grep -q "$WORD" <<<"$r1" || { echo "  it didn't come back OK with $WORD"; ok=1; }
  r2=$(as 1103 python3 -I -c "$ASK" "$SOCK" < "$W/msg" 2>&1); echo "  as the slot's uid 1103: $r2"
  grep -q 'Permission denied' <<<"$r2" || { echo "  uid 1103 wasn't refused at the directory"; ok=1; }
  r3=$(asg 1101 1100 python3 -I -c "$ASK" "$SOCK" < "$W/msg" 2>&1); echo "  as the slot's uid 1101 with the desk group: $r3"
  [ "$(head -1 <<<"$r3")" = "err denied" ] || { echo "  uid 1101 with the desk group wasn't answered err denied"; ok=1; }
  r4=$(python3 -I -c "$ASK" "$SOCK" < "$W/msg" 2>&1); echo "  as the host's root: $r4"
  [ "$(head -1 <<<"$r4")" = "err denied" ] || { echo "  the host's root wasn't answered err denied"; ok=1; }
  sleep 1; echo "  $NAME's cgroup: $(procs)"
  [ "$(cat $CG/cgroup.procs 2>/dev/null | wc -l)" = 1 ] || { echo "  something but desk-svc runs in $NAME after the parses"; ok=1; }
  tail -n +$((since + 1)) "$SLOG" 2>/dev/null | grep -q "$WORD" && { echo "  $NAME's log on the host holds the message's word"; ok=1; }
  return $ok
}
check_list() {
  local ok=0 p f first n
  p=$(svc_pid); f=/proc/$p/root/app/courier/trackers.txt
  [ -f "$TG/$LIST" ] || { echo "  the template ($TG) has no $LIST (a desk recipe before 0.3.9 builds none)"; return 1; }
  first=$(head -1 "$f" 2>/dev/null); n=$(wc -l < "$f" 2>/dev/null || echo 0)
  echo "  the reader's list: $n lines; its first: ${first:0:220}"
  cmp -s "$f" "$TG/$LIST" || { echo "  the reader's list isn't the template's"; ok=1; }
  [ "$n" -gt 1000 ] || { echo "  the reader's list has $n lines: the image's empty placeholder?"; ok=1; }
  grep -qE "^# ADR 0076: uBlock Origin Lite [0-9][0-9.]*, sha256 $PIN;" <<<"$first" || { echo "  its first line doesn't name blocker.pin's sha256 $PIN"; ok=1; }
  return $ok
}
check_follow() {
  local ok=0 p0 p1 r
  p0=$(svc_pid)
  resandbox $K desk-agent > "$W/rs.out" 2>&1 || { echo "  resandbox failed: $(tail -2 "$W/rs.out")"; ok=1; }
  p1=$(svc_pid); r=$(as 1100 python3 -I -c "$ASK" "$SOCK" < "$W/msg" 2>&1 | head -1)
  echo "  $NAME's process 1, host pid $p0 -> $p1 after desk-agent's resandbox; root $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["root"]["path"])' $BUNDLE/config.json); a parse: ${r:0:60}"
  [ -n "$p1" ] && [ "$p0" != "$p1" ] || { echo "  $NAME wasn't made again with desk-agent"; ok=1; }
  [ "$(cut -c1-2 <<<"$r")" = OK ] || { echo "  it doesn't serve after the switch's steps"; ok=1; }
  return $ok
}
check_egress() {
  local dp o rc
  dp=$(pid_of dh-svc-$K-deskd); [ -n "$dp" ] || { echo "  no deskd sandbox"; return 1; }
  echo "  deskd's resolv.conf: $(tr '\n' ' ' < /proc/$dp/root/etc/resolv.conf)"
  o=$(nsenter --net=/run/desk-host/ns/$K/net -- setpriv --reuid=$((BASE + 1100)) --regid=$((BASE + 1100)) --clear-groups --no-new-privs \
      python3 -I -c "$EG" "$(cat /proc/$dp/root/etc/resolv.conf)" 2>&1); rc=$?
  echo "$o" | sed 's/^/  /'
  return $rc
}
round() {   # config, parse, list and follow; prints <part> PASS|FAIL, rc 0 when all pass
  local rc=0 p
  for p in config parse list follow; do
    echo "$p:"; if check_$p; then echo "$p PASS"; else echo "$p FAIL"; rc=1; fi
  done
  return $rc
}
# remake <python on d>: the sandbox stopped and made again by hand from svc-spec.py's spec with one change, as desk-host would make it from
# a spec with that change (runc create, its mount namespace bound, runc start); put back by a resandbox of desk-agent
remake() {
  local spid
  runc kill dh-svc-$K-$NAME KILL 2>/dev/null; for _ in $(seq 1 20); do [ -n "$(svc_pid)" ] || break; sleep 0.5; done
  runc delete -f dh-svc-$K-$NAME >/dev/null 2>&1
  if [ -e "$NSB" ]; then umount "$NSB" 2>/dev/null || umount -l "$NSB" 2>/dev/null; rm -f "$NSB"; fi
  python3 -I $L/svc-spec.py $K $NAME >/dev/null || return 1
  python3 -I -c "import json, sys; p = sys.argv[1]; d = json.load(open(p)); $1; json.dump(d, open(p, 'w'), indent=1)" $BUNDLE/config.json || return 1
  runc create --bundle $BUNDLE dh-svc-$K-$NAME >> "$SLOG" 2>&1 < /dev/null || { echo "  runc create refused the changed spec: $(tail -1 "$SLOG")"; return 1; }
  spid=$(svc_pid); : > "$NSB"; mount --bind /proc/$spid/ns/mnt "$NSB"
  runc start dh-svc-$K-$NAME
  for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.5; done
}
lmut() {   # lmut break|fix: a copy of the template's list whose first line names another sha256, bound over it on the host, and back
  TF=$TG/$LIST
  if [ "$1" = break ]; then
    [ -f "$TF" ] || { echo "  the template has no list to change"; return 1; }
    sed "1s/sha256 [0-9a-f]\{64\}/sha256 $(printf '%064d' 0)/" "$TF" > "$W/list.bad"; mount --bind "$W/list.bad" "$TF"
  else
    mountpoint -q "$TF" && umount "$TF"
  fi
  resandbox $K desk-agent > "$W/rs.out" 2>&1
}
emut() {   # emut break|fix: DNS, 465, 587 and 993 dropped first on slot 1's way out of the host (its slot_<k> chain), and back
  local h
  if [ "$1" = break ]; then
    nft insert rule inet host slot_$K meta l4proto '{ tcp, udp }' th dport '{ 53, 465, 587, 993 }' counter drop comment "\"$TAG\""
  else
    for h in $(nft -a list chain inet host slot_$K 2>/dev/null | sed -n "s/.*comment \"$TAG\" # handle \([0-9]*\)\$/\1/p"); do nft delete rule inet host slot_$K handle $h; done
  fi
}

start || exit 2
TG=/srv/desk-host/templates/$(python3 -I -c 'import json; print(json.load(open("/var/lib/desk-host/slots/1.json"))["template"])')   # slot 1's own generation
if [ "$MODE" = real ]; then
  round && echo "COURIER PASS"
  echo "egress:"; if check_egress; then echo "egress PASS"; echo "EGRESS PASS"; else echo "egress FAIL"; fi
  exit 0
fi
chmod 0666 "$SOCK"; echo "mutation: parse.sock 0666"
check_config && echo "MUTATED SOCKET PASS (it shouldn't)" || echo "MUTATED SOCKET FAIL"; chmod 0660 "$SOCK"
remake "d['mounts'].append({'destination': '/run/desk', 'type': 'bind', 'source': '/run/desk-host/share/$K/desk', 'options': ['rbind', 'rw', 'nosuid', 'nodev', 'noexec']})"
echo "mutation: the sandbox with the slot's /run/desk share mounted"
check_config && echo "MUTATED MOUNTS PASS (it shouldn't)" || echo "MUTATED MOUNTS FAIL"; resandbox $K desk-agent > "$W/rs.out" 2>&1
remake "[n.__setitem__('path', '/run/desk-host/ns/$K/net') for n in d['linux']['namespaces'] if n['type'] == 'network']"
echo "mutation: the sandbox in the desk's network namespace"
check_config && echo "MUTATED NETWORK PASS (it shouldn't)" || echo "MUTATED NETWORK FAIL"; resandbox $K desk-agent > "$W/rs.out" 2>&1
remake "d['process']['user'] = {'uid': 1100, 'gid': 1100}"
echo "mutation: the sandbox as uid 1100:1100"
check_config && echo "MUTATED IDENTITY PASS (it shouldn't)" || echo "MUTATED IDENTITY FAIL"; resandbox $K desk-agent > "$W/rs.out" 2>&1
runc kill dh-svc-$K-$NAME KILL; sleep 2; echo "mutation: $NAME's sandbox killed"
check_parse && echo "MUTATED PARSE PASS (it shouldn't)" || echo "MUTATED PARSE FAIL"; resandbox $K desk-agent > "$W/rs.out" 2>&1
lmut break; echo "mutation: a list whose first line names sha256 $(printf '%064d' 0), over the template's"
check_list && echo "MUTATED LIST PASS (it shouldn't)" || echo "MUTATED LIST FAIL"; lmut fix
emut break; echo "mutation: DNS, 465, 587 and 993 dropped on slot $K's way out"
check_egress && echo "MUTATED EGRESS PASS (it shouldn't)" || echo "MUTATED EGRESS FAIL"; emut fix
round && echo "RESTORE PASS"
echo "egress:"; check_egress && echo "EGRESS RESTORE PASS"
exit 0
