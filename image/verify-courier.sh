#!/bin/bash
# verify-courier.sh <part> [<blocker.pin sha256>]: Courier's mail reader, desk-parse-courier (ADR 0097's sandbox, a second instance,
# for deskd; docs/sub-status/mm-courier-parse.md, "The image change"), the Courier directories and deskd's way out for linked
# mailboxes, on a booted desk. verify.sh pipes this to root on the box once per part (bash -s -- <part> <sha256>, section 3c), the
# sha256 being image/recipe/adblock/blocker.pin's, read on the workstation. It prints BAD <what> and FAILED for each failure, and
# "ran to the end" last. Each check reads configuration or uses the sandbox as deskd does; none tries to get out of it (the team's
# rule). Every part but static and follow has a mutation in part "mutations", which must fail the same check.
#   static     the unit (PartOf desk-agent, desk-agent's image-id, the back-off, +500), deskd's and desk-agent's Wants= (not Requires=),
#              the tmpfiles lines, desk-parse-courier-run's flags and its tracker list's conditional bind, the firewall's uid 1113 line
#   wall       the running container: its mounts exactly the socket's directory, desk-svc and the tracker list (both read-only), network
#              and IPC none, uid 1113:1113, CapEff 0, a read-only root, no-new-privileges, 160 MiB, 64 tasks, oom_score_adj 500; inside
#              it no /data, no /run/desk* but its socket's folder, only lo; process 1 non-dumpable (PARSE-L1); deskd's container has
#              /run/desk-parse-courier read-only
#   socket     /run/desk-parse-courier root:desk 0750, sock parse:desk 2750, parse.sock parse:desk 0660; uid 1103 is refused at the
#              folder and root gets desk-svc's "err denied": only uid 1100 (deskd) is served
#   parse      as uid 1100, 'courier1 message' with a small message answers OK with its word in the JSON; then uid 1113 runs only
#              desk-svc in it, and the journal's desk-parse-courier lines hold no word of it
#   list       the tracker list the reader sees (/app/courier/trackers.txt in its root) is the image's, thousands of entries, and its
#              first line names uBlock Origin Lite's version and the sha256 blocker.pin pins (Security's condition, question 2)
#   follow     the container runs desk-agent's current image id, and a restart of desk-agent restarts it on that id
#   dirs       /data/courier 1100:1100 0700 holding only uid 1100's; deskd's container mounts /data/courier and /data/keys read-write
#   egress     deskd's network (the host's: its container runs on it) as uid 1100: an MX lookup of gmail.com through the resolver
#              deskd's container reads, and TCP to imap.gmail.com:993, smtp.gmail.com:465 and smtp.gmail.com:587; TCP 25 to the
#              MX is said, never judged (ADR 0014 closes it outside the desk)
#   mutations  each check above against a copy (or a value) with one thing changed, which must fail it: -v /data/courier, --network
#              host, --user 1100:1100, a tracker list naming another sha256, parse.sock chmod 0666 (put back), desk-parse-courier
#              stopped (started again), /data/courier chmod 0755 (put back), DNS and 465, 587, 993 dropped for uid 1100 (put back)
set -u
part=${1:-}; PIN=${2:-}
FAILS=0
bad() { echo "BAD: $*"; echo FAILED; FAILS=$((FAILS+1)); }
NAME=desk-parse-courier
RUN=/usr/local/lib/ma/desk-parse-courier-run
D=/run/desk-parse-courier; SOCK=$D/sock/parse.sock
LIST=/usr/share/ma/adblock/courier-trackers.txt
W=$(mktemp -d /var/tmp/verify-courier.XXXXXX); chmod 0755 "$W"
TAG=verify-courier-egress
emut_fix() { for h in $(nft -a list chain inet ma output 2>/dev/null | sed -n "s/.*comment \"$TAG\" # handle \([0-9]*\)\$/\1/p"); do nft delete rule inet ma output handle "$h"; done; }
trap 'rm -rf "$W"; docker rm -f $NAME-mut >/dev/null 2>&1; rm -rf /run/$NAME-mut; emut_fix' EXIT
WORD=verify-courier-$RANDOM
printf 'courier1 message\nFrom: v@example.com\nSubject: v\n\nThe body names %s and nothing else.\n' "$WORD" > "$W/msg"
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
out, err = b"", None
try:
    while len(out) < 1 << 20:
        b = s.recv(65536)
        if not b:
            break
        out += b
except OSError as e:
    err = f"read: {e}"
# the answer first, then any read error after it: desk-svc answers a refused peer and closes without reading its request, so the
# kernel resets the stream after the answer (ECONNRESET), and that note must not stand before the answer line
sys.stdout.write(out.decode("utf-8", "replace"))
if err:
    print(("" if not out or out.endswith(b"\n") else "\n") + err)'
as() { local u=$1; shift; setpriv --reuid "$u" --regid "$u" --clear-groups --no-new-privs "$@"; }

# copy_run <name> <sockroot> <sed expressions...>: desk-parse-courier-run with its name and socket directory moved and the changes
# given, started in the background as a container of its own, its socket directory made as tmpfiles makes the real one. Waits for it.
copy_run() {
  local name=$1 root=$2; shift 2
  docker rm -f "$name" >/dev/null 2>&1
  rm -rf "$root"; install -d -m 0750 -o root -g desk "$root"; install -d -m 2750 -o "${SOCK_OWNER:-parse}" -g desk "$root/sock"
  sed -e "s#--name $NAME #--name $name #" -e "s#-v $D/sock:#-v $root/sock:#" "$@" "$RUN" > "$W/$name-run"
  grep -q -- "--name $name " "$W/$name-run" && grep -q -- "-v $root/sock:" "$W/$name-run" || { bad "$name: the copy of $RUN didn't take its name and socket"; return 1; }
  RELEASE_DIR=/opt/ma/desk-agent/current setsid sh "$W/$name-run" > "$W/$name.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do [ -S "$root/sock/parse.sock" ] && [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] && return 0; sleep 0.5; done
  bad "$name didn't start: $(tail -3 "$W/$name.log")"; return 1
}
wait_real() { for _ in $(seq 1 60); do [ -S $SOCK ] && [ "$(docker inspect -f '{{.State.Running}}' $NAME 2>/dev/null)" = true ] && return 0; sleep 0.5; done; return 1; }

# wall_check <container>: what the "wall" part checks of one container; BAD lines for what isn't so
wall_check() {
  local c=$1 j
  j=$(docker inspect "$c" 2>/dev/null) || { bad "$c: no container"; return; }
  python3 -I - "$j" "$c" "$LIST" <<'PY' || echo FAILED
import json, sys
c = json.loads(sys.argv[1])[0]; name = sys.argv[2]; lst = sys.argv[3]; h = c["HostConfig"]; probs = []
mounts = sorted((m["Source"], m["Destination"], m["RW"]) for m in c["Mounts"])
want = {("/run/desk-parse-courier/sock", True), ("/desk-svc", False), ("/app/courier/trackers.txt", False)}
src = {m[1]: m[0] for m in mounts}
if {(m[1], m[2]) for m in mounts} != want or len(mounts) != 3 or src.get("/desk-svc") != "/usr/local/lib/ma/desk-svc" or src.get("/app/courier/trackers.txt") != lst:
    probs.append(f"mounts {mounts}, not exactly the socket's directory, desk-svc and the tracker list (both read-only)")
for k, v in (("NetworkMode", "none"), ("IpcMode", "none"), ("ReadonlyRootfs", True), ("Memory", 167772160), ("MemorySwap", 167772160),
             ("PidsLimit", 64), ("OomScoreAdj", 500), ("Privileged", False)):
    if h.get(k) != v:
        probs.append(f"{k} {h.get(k)!r}, not {v!r}")
if h.get("CapDrop") != ["ALL"] or h.get("CapAdd"):
    probs.append(f"CapDrop {h.get('CapDrop')} CapAdd {h.get('CapAdd')}")
if "no-new-privileges" not in (h.get("SecurityOpt") or []) and "no-new-privileges:true" not in (h.get("SecurityOpt") or []):
    probs.append(f"SecurityOpt {h.get('SecurityOpt')}")
if c["Config"].get("User") != "1113:1113":
    probs.append(f"User {c['Config'].get('User')!r}")
if h.get("LogConfig", {}).get("Type") != "journald":
    probs.append(f"log driver {h.get('LogConfig')}")
print(f"{name}: mounts {[(m[0], m[1], 'rw' if m[2] else 'ro') for m in mounts]}, network {h.get('NetworkMode')}, ipc {h.get('IpcMode')}, "
      f"user {c['Config'].get('User')}, read-only {h.get('ReadonlyRootfs')}, caps -{h.get('CapDrop')} +{h.get('CapAdd')}, {h.get('SecurityOpt')}, "
      f"memory {h.get('Memory')} swap {h.get('MemorySwap')}, pids {h.get('PidsLimit')}, oom {h.get('OomScoreAdj')}, log {h.get('LogConfig', {}).get('Type')}")
for p in probs:
    print(f"BAD: {name}: {p}")
sys.exit(1 if probs else 0)
PY
  local out; out=$(docker exec --user 1113:1113 "$c" /desk-svc check status mounts netdevs read:/data/courier/keys ls:/data 2>&1)
  echo "$out" | sed "s/^/  $c inside: /"
  grep -q '^Uid: 1113 1113 1113 1113$' <<<"$out" || bad "$c: the sandbox's process isn't uid 1113"
  grep -q '^CapEff: 0000000000000000$' <<<"$out" || bad "$c: CapEff isn't 0"
  grep -q '^NoNewPrivs: 1$' <<<"$out" || bad "$c: no_new_privs isn't set"
  grep -qE '^mounts: \[.*( /data[ /\]]| /run/desk[^-]| /run/desk-parse[ /\]])' <<<"$out" && bad "$c: /data, desk-parse's folder or a /run/desk directory is mounted inside"
  grep -qE '^mounts: \[.*/run/desk-parse-courier/[^s]' <<<"$out" && bad "$c: more of /run/desk-parse-courier than its socket's directory is mounted inside"
  grep -qx 'netdevs: \[lo\]' <<<"$out" || bad "$c: its network namespace has more than lo"
  grep -qx 'read /data/courier/keys: ENOENT' <<<"$out" || bad "$c: /data/courier/keys isn't absent inside"
  grep -qx 'ls /data: ENOENT' <<<"$out" || bad "$c: /data exists inside"
  local pid; pid=$(docker inspect -f '{{.State.Pid}}' "$c")
  [ "$(cat /proc/$pid/oom_score_adj 2>/dev/null)" = 500 ] || bad "$c: process 1's oom_score_adj is $(cat /proc/$pid/oom_score_adj 2>/dev/null), not 500"
  local mo; mo=$(stat -c '%u' /proc/$pid/mem 2>&1); echo "  $c: /proc/$pid/mem is owned by uid $mo (0 when process 1 is non-dumpable)"
  [ "$mo" = 0 ] || bad "$c: process 1 is dumpable: /proc/$pid/mem is owned by uid $mo, not root (PARSE-L1)"
}

# sock_check: the three places' owners and modes, and who the socket serves
sock_check() {
  local got; got=$(stat -c '%n %U:%G %a %F' $D $D/sock $SOCK 2>&1)
  echo "$got"
  [ "$got" = "$D root:desk 750 directory
$D/sock parse:desk 2750 directory
$SOCK parse:desk 660 socket" ] || bad "the owners and modes aren't mm-courier-parse's"
  local r; r=$(as 1103 python3 -I -c "$ASK" $SOCK < "$W/msg" 2>&1); echo "as uid 1103: $r"
  grep -q 'Permission denied' <<<"$r" || bad "uid 1103 wasn't refused at the folder"
  r=$(python3 -I -c "$ASK" $SOCK < "$W/msg" 2>&1); echo "as root: $r"
  [ "$(head -1 <<<"$r")" = "err denied" ] || bad "root wasn't answered err denied by desk-svc"
  r=$(stat -c '%U' $D/sock/* 2>/dev/null | sort -u | paste -sd,); [ "$r" = parse ] || bad "the socket's directory holds something not parse's: $r"
}

# parse_check: the message as uid 1100; rc 0 when it answers OK with its word
parse_check() {
  local r; r=$(as 1100 python3 -I -c "$ASK" $SOCK < "$W/msg" 2>&1); echo "the message, as uid 1100: $(head -c 300 <<<"$r" | tr '\n' '|')"
  [ "$(head -1 <<<"$r" | cut -c1-2)" = OK ] && grep -q "$WORD" <<<"$r"
}

# only_svc <container>: true when the container's only process is desk-svc
only_svc() {
  local pid cg; pid=$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null); cg=$(sed -n 's/^0:://p' /proc/$pid/cgroup 2>/dev/null)
  local procs; procs=$(for p in $(cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null); do echo "$p:$(cat /proc/$p/comm 2>/dev/null)"; done | paste -sd' ')
  echo "$1's processes: $procs"
  [ "$procs" = "$pid:desk-svc" ]
}

# list_check <container>: the list the reader sees, held to blocker.pin's sha256
list_check() {
  local pid f first n; pid=$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null); f=/proc/$pid/root/app/courier/trackers.txt
  first=$(head -1 "$f" 2>&1); n=$(grep -vc '^#' "$f" 2>/dev/null)
  echo "$1's /app/courier/trackers.txt: $n entries; first line: $(cut -c1-200 <<<"$first")"
  [[ $PIN =~ ^[0-9a-f]{64}$ ]] || { bad "no blocker.pin sha256 given"; return; }
  [[ $first =~ ^\#\ ADR\ 0076:\ uBlock\ Origin\ Lite\ [0-9.]+,\ sha256\ $PIN\;\ easyprivacy: ]] || bad "$1's tracker list doesn't name blocker.pin's sha256 ($PIN)"
  [ "${n:-0}" -gt 10000 ] || bad "$1's tracker list has $n entries, not thousands"
}

# egress_check: deskd's way out as uid 1100, through the resolver deskd's container reads
egress_check() {
  local dpid rc; dpid=$(docker inspect -f '{{.State.Pid}}' deskd 2>/dev/null)
  echo "deskd's network: $(docker inspect -f '{{.HostConfig.NetworkMode}}' deskd 2>&1); its resolv.conf: $(grep -E '^(nameserver|search)' /proc/$dpid/root/etc/resolv.conf 2>&1 | paste -sd' ')"
  as 1100 python3 -I - "$(cat /proc/$dpid/root/etc/resolv.conf 2>/dev/null)" <<'PY'
import random, socket, struct, sys
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
sys.exit(0 if ok else 1)
PY
  rc=$?; [ $rc = 0 ] || bad "uid 1100 couldn't resolve an MX record or reach 993, 465 and 587"
}

# dirs_check: /data/courier, and deskd's mounts of it and /data/keys
dirs_check() {
  local got; got=$(stat -c '%u:%g %a %F' /data/courier 2>&1); echo "/data/courier: $got; inside: $(find /data/courier -mindepth 1 -maxdepth 2 -printf '%u:%g %m %P, ' 2>&1 | head -c 300)"
  [ "$got" = "1100:1100 700 directory" ] || bad "/data/courier isn't a 1100:1100 0700 directory"
  [ -z "$(find /data/courier -mindepth 1 ! -uid 1100 2>&1)" ] || bad "/data/courier holds something not uid 1100's"
  local m; m=$(docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}}:{{.RW}} {{end}}' deskd 2>&1); echo "deskd's mounts: $m"
  for w in /data/courier:/data/courier:true /data/keys:/data/keys:true $D:$D:false; do
    grep -q "\(^\| \)$w\( \|$\)" <<<"$m" || bad "deskd's container hasn't $w (a deskd release from before Courier's store?)"
  done
}

case "$part" in
static)
  [ "$(stat -c '%U:%G %a' "$RUN" /usr/local/lib/ma/desk-svc | paste -sd,)" = "root:root 755,root:root 755" ] || bad "desk-parse-courier-run or desk-svc isn't root's 0755"
  [ "$(sha256sum /usr/local/lib/ma/desk-svc | cut -d' ' -f1)" = "$(cat /usr/local/lib/ma/desk-svc.sha256 2>/dev/null)" ] || bad "desk-svc isn't the baked one"
  for l in "d $D 0750 root desk -" "d $D/sock 2750 parse desk -"; do grep -qx "$l" /etc/tmpfiles.d/$NAME.conf || bad "tmpfiles.d/$NAME.conf hasn't '$l'"; done
  [ "$(grep -vc '^#' /etc/tmpfiles.d/$NAME.conf)" = 2 ] || bad "tmpfiles.d/$NAME.conf has more than its two lines"
  grep -qx 'ConditionPathExists=/opt/ma/desk-agent/current/image-id' /etc/systemd/system/$NAME.service || bad "$NAME.service doesn't wait for desk-agent's image-id"
  v=$(systemctl show -p PartOf -p Requires -p Restart -p RestartSteps -p StartLimitIntervalUSec -p OOMScoreAdjust $NAME.service | paste -sd' ')
  echo "$NAME.service: $v"
  for w in 'PartOf=desk-agent.service' 'Restart=always' 'StartLimitIntervalUSec=0' 'OOMScoreAdjust=500' 'RestartSteps=8'; do grep -q "$w" <<<"$v" || bad "$NAME.service hasn't $w"; done
  for u in deskd desk-agent; do
    systemctl show -p Wants --value $u.service | tr ' ' '\n' | grep -qx $NAME.service || bad "$u doesn't want $NAME"
    systemctl show -p Requires --value $u.service | tr ' ' '\n' | grep -qx $NAME.service && bad "$u requires $NAME (it must run without it)"
  done
  for f in '--network none' '--ipc none' '--user 1113:1113' '--read-only' '--cap-drop ALL' '--security-opt no-new-privileges' '--memory 160m' '--memory-swap 160m' \
           '--pids-limit 64' '--oom-score-adj 500' '-deadline-sec 15' '-conn-stdio' '-clean' '-peer-uid 1100' '-max-conn 1' '-accept-mode 0660' \
           "-v $D/sock:$D/sock" '@/app/courier-parse.options' '--log-opt tag=desk-parse-courier'; do
    grep -q -- " $f" "$RUN" || bad "$RUN hasn't $f"
  done
  grep -q -- '--tmpfs' "$RUN" && bad "$RUN gives the sandbox a writable tmpfs"
  grep -q '^\[ -f "$LIST" \] && set -- -v "$LIST:/app/courier/trackers.txt:ro"$' "$RUN" || bad "$RUN doesn't bind the tracker list read-only only when it exists"
  grep -qx '    meta skuid 1113 reject' /etc/nftables.conf || bad "nftables.conf hasn't the uid 1113 line"
  [ "$(stat -c '%U:%G %a' $LIST 2>&1)" = "root:root 644" ] || bad "$LIST isn't root's 0644"
  ;;
wall)
  systemctl is-active --quiet $NAME.service || bad "$NAME.service isn't active"
  wall_check $NAME
  m=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$D\"}}{{.Source}} rw={{.RW}}{{end}}{{end}}" deskd 2>/dev/null)
  echo "deskd mounts $D: ${m:-nothing}"; [ "$m" = "$D rw=false" ] || bad "deskd's $D isn't the folder, read-only"
  own=$( { find / -xdev -user 1113 2>/dev/null; find /run /data /tmp /var/tmp /dev/shm -user 1113 2>/dev/null; } | sort -u \
    | grep -v '^/run/desk-parse/sock\(/parse.sock\)\?$' | grep -v "^$D/sock\(/parse.sock\)\?\$" || true)
  [ -z "$own" ] || bad "uid 1113 owns files outside its sockets' directories: $(head -5 <<<"$own" | paste -sd' ')"
  ;;
socket)
  sock_check ;;
parse)
  systemctl is-active --quiet $NAME.service || bad "$NAME.service isn't active"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  parse_check || bad "the message didn't come back OK with its word"
  sleep 1; only_svc $NAME || bad "after the parse something but desk-svc runs in $NAME"
  j=$(journalctl -t $NAME --since "$since" --no-pager -o cat 2>/dev/null); echo "journal ($NAME) since the parse: $(grep -c . <<<"$j") line(s)"
  grep -qE "$WORD|v@example.com" <<<"$j" && bad "the journal holds a word of the message"
  ;;
list)
  [ -f $LIST ] || bad "the image has no $LIST"
  list_check $NAME
  pid=$(docker inspect -f '{{.State.Pid}}' $NAME 2>/dev/null)
  cmp -s $LIST /proc/$pid/root/app/courier/trackers.txt || bad "the reader's list isn't the image's $LIST"
  ;;
follow)
  id=$(cat /opt/ma/desk-agent/current/image-id); img=$(docker inspect -f '{{.Image}}' $NAME 2>/dev/null)
  echo "desk-agent's image-id $id, $NAME runs $img"
  [ "$id" = "$img" ] || bad "$NAME doesn't run desk-agent's current image"
  t1=$(docker inspect -f '{{.State.StartedAt}}' $NAME)
  systemctl restart desk-agent.service
  for _ in $(seq 1 60); do t2=$(docker inspect -f '{{.State.StartedAt}}' $NAME 2>/dev/null); [ -n "$t2" ] && [ "$t2" != "$t1" ] && [ -S $SOCK ] && break; sleep 1; done
  echo "$NAME started $t1, after desk-agent's restart $t2, image $(docker inspect -f '{{.Image}}' $NAME 2>/dev/null)"
  [ -n "$t2" ] && [ "$t2" != "$t1" ] || bad "a restart of desk-agent didn't restart $NAME"
  [ "$(docker inspect -f '{{.Image}}' $NAME 2>/dev/null)" = "$id" ] || bad "after the restart $NAME doesn't run desk-agent's image"
  wait_real; parse_check >/dev/null 2>&1 || bad "after desk-agent's restart the parse check doesn't pass"
  ;;
dirs)
  dirs_check ;;
egress)
  egress_check ;;
mutations)
  # Each must fail its check. A mutation that passes is a check that tests nothing: BAD.
  mut() { # mut <what> <command producing the check's output>
    local what=$1; shift; local o; o=$("$@" 2>&1)
    if grep -q '^FAILED$' <<<"$o" || [ "${MUT_RC:-0}" != 0 ]; then echo "mutation '$what': the check fails, as it must ($(grep -m1 '^BAD' <<<"$o" | cut -c1-140))"
    else bad "mutation '$what' passed its check"; fi
    MUT_RC=0
  }
  copy_run $NAME-mut /run/$NAME-mut -e 's#-v /usr/local/lib/ma/desk-svc:/desk-svc:ro#-v /data/courier:/data/courier:ro -v /usr/local/lib/ma/desk-svc:/desk-svc:ro#' && mut "-v /data/courier:/data/courier:ro" wall_check $NAME-mut
  copy_run $NAME-mut /run/$NAME-mut -e 's#--network none#--network host#' && mut "--network host" wall_check $NAME-mut
  SOCK_OWNER=desk copy_run $NAME-mut /run/$NAME-mut -e 's#--user 1113:1113#--user 1100:1100#' && mut "--user 1100:1100" wall_check $NAME-mut
  head -1 $LIST | sed "s/sha256 [0-9a-f]\{64\}/sha256 $(printf '0%.0s' $(seq 1 64))/" > "$W/other.txt"; tail -n +2 $LIST >> "$W/other.txt"; chmod 0644 "$W/other.txt"
  copy_run $NAME-mut /run/$NAME-mut -e "s#^LIST=.*#LIST=$W/other.txt#" && mut "a tracker list whose first line names another sha256" list_check $NAME-mut
  docker rm -f $NAME-mut >/dev/null 2>&1; rm -rf /run/$NAME-mut
  chmod 0666 $SOCK; mut "chmod 0666 parse.sock" sock_check; chmod 0660 $SOCK
  o=$(sock_check 2>&1); grep -q '^FAILED$' <<<"$o" && bad "the socket's mode didn't come back: $(grep -m1 '^BAD' <<<"$o")"
  systemctl stop $NAME.service
  o=$(parse_check 2>&1); MUT_RC=$?; mut "$NAME stopped" echo "$o"
  systemctl start $NAME.service; wait_real
  parse_check >/dev/null 2>&1 || bad "after $NAME's start the parse check doesn't pass again"
  chmod 0755 /data/courier; mut "chmod 0755 /data/courier" dirs_check; chmod 0700 /data/courier
  nft insert rule inet ma output meta skuid 1100 meta l4proto '{ tcp, udp }' th dport '{ 53, 465, 587, 993 }' counter drop comment "\"$TAG\""
  mut "DNS, 465, 587 and 993 dropped for uid 1100" egress_check
  emut_fix
  o=$(egress_check 2>&1); grep -q '^FAILED$' <<<"$o" && bad "after the drop rule went, the egress check doesn't pass again: $(grep -m1 '^BAD' <<<"$o")"
  ;;
*) echo "usage: verify-courier.sh static|wall|socket|parse|list|follow|dirs|egress|mutations [<blocker.pin sha256>]" >&2; exit 2 ;;
esac
echo "ran to the end"
