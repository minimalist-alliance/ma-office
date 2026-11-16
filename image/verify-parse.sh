#!/bin/bash
# verify-parse.sh <part>: the Agent's attachment reader, desk-parse (ADR 0097), on a booted desk: a cloud desk, or a self-hosted
# one (selfhost/e2e runs it too). verify.sh pipes this to root on the box once per part (bash -s -- <part>, section 3p), and it
# runs the same on any lab box (image/lab/desk-parse/). It prints BAD <what> and FAILED for each failure, and "ran to the end"
# last. Each check reads configuration or uses the sandbox as desk-agent does; none tries to get out of it (the team's rule).
# Every part but static and follow has a mutation in part "mutations", which must fail the same check.
#   static     the unit, desk-parse-run, the tmpfiles lines, desk-svc's hash, desk-agent's Wants=, the firewall line, the user
#   wall       the running container: its mounts exactly the socket's directory and desk-svc, network and IPC none, uid 1113:1113,
#              CapEff 0, a read-only root, no-new-privileges, 160 MiB, 64 tasks, oom_score_adj 500; inside it (desk-svc check)
#              no /data or /run/desk* mounted and only lo; uid 1113 can't read /data or reach the network from the host either;
#              process 1 non-dumpable (/proc/<pid>/mem owned by root, not 1113; PARSE-L1);
#              uid 1113 owns no file outside its socket's directory, and group agent has no members; desk-agent's container, from
#              release N, has /run/desk-parse read-only
#   socket     /run/desk-parse root:agent 0750, required root:root 0444, sock parse:agent 2750, parse.sock parse:agent 0660; uid
#              1100 can't reach it (EACCES) and root gets desk-svc's "err denied": only uid 1103 is served
#   parse      as uid 1103: a text file and a small PDF answer OK with their words; then uid 1113 runs only desk-svc and the
#              journal's desk-parse lines hold no word of either
#   limits     a copy of desk-parse-run with the worker changed (desk-parse-lim): a worker past 35 s is killed and the stream
#              ends with no line, and one past 160 MiB is killed by the kernel (memory.events oom_kill), desk-svc staying up
#   clean      a copy whose worker leaves a process behind: after its answer only desk-svc is left in the container
#   follow     the container runs desk-agent's current image id, and a restart of desk-agent restarts it on that id
#   agent      desk-agent's health says parse "sidecar" and the image's smoke test passes its desk-parse check (release N on)
#   measure    a parse's time here (p50 of 10, a 1 KiB text and a 100-page PDF); a 20 MiB text file; if it reads (desk-agent's
#              05485c8b on), a dense 20 MiB text PDF at files_read's ask three times (memory.peak under 140 MiB of 160, no kill by
#              the kernel) and a 41 MiB file refused as unreadable; a desk-agent from before that ends its worker at 20 MiB
#              (noted, not a failure, unless PARSE_CEILING=1 or FIXED_AGENTS holds its version)
#   mutations  each check above against a copy (or a value) with one thing changed, which must fail it: -v /data/agent, --network
#              host, --user 1103:1103, --memory 128m, a desk-svc that stays dumpable (MUT_SVC: a build without the call), the firewall line deleted (put back), parse.sock chmod 0666 (put back), desk-parse
#              stopped (started again), and the clean copy without -clean
set -u
part=${1:-}
FAILS=0
bad() { echo "BAD: $*"; echo FAILED; FAILS=$((FAILS+1)); }
RUN=/usr/local/lib/ma/desk-parse-run
ASK=/usr/local/lib/ma/desk-parse-ask
AS_AGENT=(setpriv --reuid 1103 --regid 1103 --clear-groups --no-new-privs)
W=$(mktemp -d /var/tmp/verify-parse.XXXXXX); chmod 0755 "$W"
trap 'rm -rf "$W"; for c in desk-parse-lim desk-parse-mut; do docker rm -f $c >/dev/null 2>&1; done; rm -rf /run/desk-parse-lim /run/desk-parse-mut' EXIT

# fixtures: words that appear nowhere else, so the journal check means something
TEXT_WORD=quokka-$RANDOM-fixture; PDF_WORD=wombatpdf$RANDOM
printf 'A text fixture for desk-parse: %s\nsecond line\n' "$TEXT_WORD" > "$W/fixture.txt"
mkpdf() { # mkpdf <out> <word> <pages>: a plain PDF, each page a line of Helvetica naming the word and its page
python3 -I - "$1" "$2" "$3" <<'PY'
import sys
out, word, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
font = 3 + 2 * n
objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % (3 + 2 * i) for i in range(n)), n)]
for i in range(n):
    content = f"BT /F1 12 Tf 20 100 Td (PDF fixture {word} page {i + 1} of {n}, the quick brown fox jumps over the lazy dog) Tj ET".encode()
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 144] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>" % (4 + 2 * i, font))
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
pdf = b"%PDF-1.4\n"
offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(pdf))
    pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
x = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
open(out, "wb").write(pdf)
PY
}
mkpdf "$W/fixture.pdf" "$PDF_WORD" 1

# copy_run <name> <sockroot> <sed expressions...>: desk-parse-run with its name and socket directory moved, and the changes given,
# started in the background as a container of its own, its socket directory made as tmpfiles makes the real one. Waits for it.
copy_run() {
  local name=$1 root=$2; shift 2
  docker rm -f "$name" >/dev/null 2>&1
  rm -rf "$root"; install -d -m 0750 -o root -g agent "$root"; install -d -m 2750 -o "${SOCK_OWNER:-parse}" -g agent "$root/sock"
  sed -e "s#--name desk-parse #--name $name #" -e "s#-v /run/desk-parse/sock:#-v $root/sock:#" "$@" "$RUN" > "$W/$name-run"
  grep -q -- "--name $name " "$W/$name-run" && grep -q -- "-v $root/sock:" "$W/$name-run" || { bad "$name: the copy of desk-parse-run didn't take its name and socket"; return 1; }
  RELEASE_DIR=/opt/ma/desk-agent/current setsid sh "$W/$name-run" > "$W/$name.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do [ -S "$root/sock/parse.sock" ] && [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] && return 0; sleep 0.5; done
  bad "$name didn't start: $(tail -3 "$W/$name.log")"; return 1
}

# wall_check <container>: what the "wall" part checks of one container; BAD lines for what isn't so
wall_check() {
  local c=$1 j
  j=$(docker inspect "$c" 2>/dev/null) || { bad "$c: no container"; return; }
  python3 -I - "$j" "$c" <<'PY' || echo FAILED
import json, sys
c = json.loads(sys.argv[1])[0]; name = sys.argv[2]; h = c["HostConfig"]; probs = []
mounts = sorted((m["Source"], m["Destination"], m["RW"]) for m in c["Mounts"])
sock = [m for m in mounts if m[1] == "/run/desk-parse/sock"]
want = {("/run/desk-parse/sock", True), ("/desk-svc", False)}
if {(m[1], m[2]) for m in mounts} != want or len(mounts) != 2 or [m[0] for m in mounts if m[1] == "/desk-svc"] != ["/usr/local/lib/ma/desk-svc"]:
    probs.append(f"mounts {mounts}, not exactly the socket's directory and desk-svc (read-only)")
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
  local out; out=$(docker exec --user 1113:1113 "$c" /desk-svc check status mounts netdevs read:/data/agent/keys ls:/data 2>&1)
  echo "$out" | sed "s/^/  $c inside: /"
  grep -q '^Uid: 1113 1113 1113 1113$' <<<"$out" || bad "$c: the sandbox's process isn't uid 1113"
  grep -q '^CapEff: 0000000000000000$' <<<"$out" || bad "$c: CapEff isn't 0"
  grep -q '^NoNewPrivs: 1$' <<<"$out" || bad "$c: no_new_privs isn't set"
  grep -qE '^mounts: \[.*( /data[ /\]]| /run/desk[^-])' <<<"$out" && bad "$c: /data or a /run/desk directory is mounted inside"
  grep -qE '^mounts: \[.*/run/desk-parse/[^s]' <<<"$out" && bad "$c: more of /run/desk-parse than its socket's directory is mounted inside"
  grep -qx 'netdevs: \[lo\]' <<<"$out" || bad "$c: its network namespace has more than lo"
  grep -qx 'read /data/agent/keys: ENOENT' <<<"$out" || bad "$c: /data/agent/keys isn't absent inside"
  grep -qx 'ls /data: ENOENT' <<<"$out" || bad "$c: /data exists inside"
  local pid; pid=$(docker inspect -f '{{.State.Pid}}' "$c")
  [ "$(cat /proc/$pid/oom_score_adj 2>/dev/null)" = 500 ] || bad "$c: process 1's oom_score_adj is $(cat /proc/$pid/oom_score_adj 2>/dev/null), not 500"
  # PARSE-L1: desk-svc -clean makes itself non-dumpable first, so the kernel gives its /proc files to root; a dumpable process 1
  # would own them as uid 1113, the worker's own uid. Read from the host with stat: no attach, no read of its memory.
  local mo; mo=$(stat -c '%u' /proc/$pid/mem 2>&1); echo "  $c: /proc/$pid/mem is owned by uid $mo (0 when process 1 is non-dumpable)"
  [ "$mo" = 0 ] || bad "$c: process 1 is dumpable: /proc/$pid/mem is owned by uid $mo, not root (PARSE-L1)"
}

# net_check: the host's own rule for uid 1113, and that uid 1113 on the host reaches nothing
net_check() {
  nft list chain inet ma output 2>/dev/null | grep -q 'meta skuid 1113 reject' || bad "the firewall's output chain has no 'meta skuid 1113 reject'"
  local r; r=$(setpriv --reuid 1113 --regid 1113 --clear-groups --no-new-privs python3 -I -c '
import socket
s = socket.socket(); s.settimeout(4)
try:
    s.connect(("1.1.1.1", 443)); print("connected")
except OSError as e:
    print("refused:", e.strerror or e)' 2>&1)
  echo "uid 1113 on the host, TCP to a public address: $r"
  [ "${r#refused}" != "$r" ] || bad "uid 1113 reached the network from the host"
}

# sock_check: the four places' owners and modes, and who the socket serves
sock_check() {
  local got; got=$(stat -c '%n %U:%G %a %F' /run/desk-parse /run/desk-parse/required /run/desk-parse/sock /run/desk-parse/sock/parse.sock 2>&1)
  echo "$got"
  [ "$got" = "/run/desk-parse root:agent 750 directory
/run/desk-parse/required root:root 444 regular file
/run/desk-parse/sock parse:agent 2750 directory
/run/desk-parse/sock/parse.sock parse:agent 660 socket" ] || bad "the owners and modes aren't ADR 0097's"
  [ "$(cat /run/desk-parse/required 2>/dev/null)" = 1 ] || bad "the marker isn't there"
  local r; r=$(printf 'x\n' | setpriv --reuid 1100 --regid 1100 --clear-groups --no-new-privs "$ASK" text 10 1 2>&1); echo "as uid 1100: rc $? $r"
  grep -q 'Permission denied' <<<"$r" || bad "uid 1100 wasn't refused at the directory"
  r=$(printf 'x\n' | "$ASK" text 10 1 2>/dev/null); echo "as root: $r"
  [ "$r" = "err denied" ] || bad "root wasn't answered err denied by desk-svc"
  r=$(stat -c '%U' /run/desk-parse/sock/* 2>/dev/null | sort -u | paste -sd,); [ "$r" = parse ] || bad "the socket's directory holds something not parse's: $r"
}

# parse_check: the two fixtures as uid 1103; rc 0 when both answer OK with their words
parse_check() {
  local r1 r2 ok=0
  r1=$("${AS_AGENT[@]}" "$ASK" text 1000 1 < "$W/fixture.txt" 2>&1); echo "text, as uid 1103: $(head -c 200 <<<"$r1" | tr '\n' '|')"
  r2=$("${AS_AGENT[@]}" "$ASK" pdf 1000 5 < "$W/fixture.pdf" 2>&1); echo "pdf, as uid 1103: $(head -c 200 <<<"$r2" | tr '\n' '|')"
  [ "$(head -1 <<<"$r1" | cut -c1-2)" = OK ] && grep -q "$TEXT_WORD" <<<"$r1" || ok=1
  [ "$(head -1 <<<"$r2" | cut -c1-2)" = OK ] && grep -q "$PDF_WORD" <<<"$r2" || ok=1
  return $ok
}

# only_svc <container>: true when the container's only process is desk-svc
only_svc() {
  local pid cg; pid=$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null); cg=$(sed -n 's/^0:://p' /proc/$pid/cgroup 2>/dev/null)
  local procs; procs=$(for p in $(cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null); do echo "$p:$(cat /proc/$p/comm 2>/dev/null)"; done | paste -sd' ')
  echo "$1's processes: $procs"
  [ "$procs" = "$pid:desk-svc" ]
}

case "$part" in
static)
  [ "$(id -u parse 2>/dev/null):$(id -g parse 2>/dev/null):$(getent passwd parse | cut -d: -f7)" = "1113:1113:/usr/sbin/nologin" ] || bad "user parse isn't 1113:1113 with nologin"
  [ -z "$(getent group agent | cut -d: -f4)" ] || bad "group agent has members: $(getent group agent | cut -d: -f4)"
  [ "$(sha256sum /usr/local/lib/ma/desk-svc | cut -d' ' -f1)" = "$(cat /usr/local/lib/ma/desk-svc.sha256 2>/dev/null)" ] || bad "desk-svc isn't the baked one"
  [ "$(stat -c '%U:%G %a' /usr/local/lib/ma/desk-svc "$RUN" "$ASK" | paste -sd,)" = "root:root 755,root:root 755,root:root 755" ] || bad "desk-svc, desk-parse-run or desk-parse-ask isn't root's 0755"
  for l in 'd /run/desk-parse 0750 root agent -' 'f /run/desk-parse/required 0444 root root - 1' 'd /run/desk-parse/sock 2750 parse agent -'; do
    grep -qx "$l" /etc/tmpfiles.d/desk-parse.conf || bad "tmpfiles.d/desk-parse.conf hasn't '$l'"
  done
  grep -qx 'ConditionPathExists=/opt/ma/desk-agent/current/image-id' /etc/systemd/system/desk-parse.service || bad "desk-parse.service doesn't wait for desk-agent's image-id"
  v=$(systemctl show -p PartOf -p Requires -p Restart -p RestartSteps -p StartLimitIntervalUSec -p OOMScoreAdjust desk-parse.service | paste -sd' ')
  echo "desk-parse.service: $v"
  for w in 'PartOf=desk-agent.service' 'Restart=always' 'StartLimitIntervalUSec=0' 'OOMScoreAdjust=500' 'RestartSteps=8'; do grep -q "$w" <<<"$v" || bad "desk-parse.service hasn't $w"; done
  systemctl show -p Wants --value desk-agent.service | tr ' ' '\n' | grep -qx desk-parse.service || bad "desk-agent doesn't want desk-parse"
  systemctl show -p Requires --value desk-agent.service | tr ' ' '\n' | grep -qx desk-parse.service && bad "desk-agent requires desk-parse (it must run without it)"
  for f in '--network none' '--ipc none' '--user 1113:1113' '--read-only' '--cap-drop ALL' '--security-opt no-new-privileges' '--memory 160m' '--memory-swap 160m' \
           '--pids-limit 64' '--oom-score-adj 500' '-deadline-sec 35' '-conn-stdio' '-clean' '-peer-uid 1103' '-max-conn 1' '-accept-mode 0660'; do
    grep -q -- " $f" "$RUN" || bad "desk-parse-run hasn't $f"
  done
  grep -q -- '--tmpfs' "$RUN" && bad "desk-parse-run gives the sandbox a writable tmpfs"
  grep -qx '    meta skuid 1113 reject' /etc/nftables.conf || bad "nftables.conf hasn't the uid 1113 line"
  ;;
wall)
  systemctl is-active --quiet desk-parse.service || bad "desk-parse.service isn't active"
  wall_check desk-parse
  net_check
  # desk-agent's run (from release N) mounts /run/desk-parse read-only wherever the directory exists; one from before mounts nothing
  m=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/desk-parse"}}{{.Source}} rw={{.RW}}{{end}}{{end}}' desk-agent 2>/dev/null)
  if [ -z "$m" ]; then echo "desk-agent mounts no /run/desk-parse: a release from before ADR 0097, which reads in its own child"
  else echo "desk-agent mounts /run/desk-parse: $m"; [ "$m" = "/run/desk-parse rw=false" ] || bad "desk-agent's /run/desk-parse isn't the directory, read-only"; fi
  r=$(setpriv --reuid 1113 --regid 1113 --clear-groups --no-new-privs ls /data/agent 2>&1); echo "uid 1113 on the host, ls /data/agent: $r"
  grep -q 'Permission denied' <<<"$r" || bad "uid 1113 can list /data/agent"
  # uid 1113 also owns desk-parse-courier's socket and its directory (the same sandbox for deskd, verify-courier.sh; its wall part
  # excludes both pairs too); nothing else
  own=$( { find / -xdev -user 1113 2>/dev/null; find /run /data /tmp /var/tmp /dev/shm -user 1113 2>/dev/null; } | sort -u \
    | grep -v '^/run/desk-parse/sock\(/parse.sock\)\?$' | grep -v '^/run/desk-parse-courier/sock\(/parse.sock\)\?$' || true)
  [ -z "$own" ] || bad "uid 1113 owns files outside its sockets' directories: $(head -5 <<<"$own" | paste -sd' ')"
  ;;
socket)
  sock_check ;;
parse)
  systemctl is-active --quiet desk-parse.service || bad "desk-parse.service isn't active"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  parse_check || bad "a fixture didn't come back OK with its words"
  sleep 1; only_svc desk-parse || bad "after the parses something but desk-svc runs as uid 1113 in desk-parse"
  ps -u 1113 -o pid=,comm= | sed 's/^/uid 1113 on the box: /'
  [ "$(ps -u 1113 -o comm= | sort -u | paste -sd,)" = desk-svc ] || bad "uid 1113 runs something but desk-svc"
  j=$(journalctl -t desk-parse --since "$since" --no-pager -o cat 2>/dev/null); echo "journal (desk-parse) since the parses: $(wc -l <<<"$j") line(s)"
  grep -qE "$TEXT_WORD|$PDF_WORD|fixture" <<<"$j" && bad "the journal holds a word of a fixture"
  r=$(printf 'nonsense here\nbytes' | "${AS_AGENT[@]}" python3 -I -c '
import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(40); s.connect("/run/desk-parse/sock/parse.sock")
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(200).decode(errors="replace").split("\n")[0])' 2>&1); echo "a request that isn't parse1: $r"
  [ "$r" = "ERR bad_request" ] || bad "a request that isn't parse1 wasn't refused with ERR bad_request"
  ;;
limits)
  # One copy whose worker is chosen by the request's maxChars: 1 sleeps past the deadline, 2 fills 256 MiB in a 160 MiB sandbox.
  copy_run desk-parse-lim /run/desk-parse-lim \
    -e 's#-- /opt/java/openjdk/bin/java @/app/parse.options#-- /bin/sh -c "read -r h k m p; case \\$m in 1) exec /bin/sleep 120 ;; 2) exec /opt/java/openjdk/bin/java -Xms256m -Xmx256m -XX:+AlwaysPreTouch -XX:-UsePerfData -version ;; esac"#' || exit 0
  t0=$(date +%s.%N)
  r=$(printf 'x' | "${AS_AGENT[@]}" "$ASK" text 1 1 /run/desk-parse-lim/sock/parse.sock 2>&1); rc=$?
  took=$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN {printf "%.1f", b - a}')
  echo "a worker that sleeps 120 s: rc $rc after $took s, answer '$(head -c 60 <<<"$r")'"
  [ $rc = 5 ] || bad "the sleeping worker's stream didn't end with no line (rc $rc)"
  awk -v t="$took" 'BEGIN {exit !(t >= 33 && t <= 42)}' || bad "it ended after $took s, not at the 35 s deadline"
  sleep 1; only_svc desk-parse-lim || bad "the sleeping worker outlived its deadline"
  pid=$(docker inspect -f '{{.State.Pid}}' desk-parse-lim); cg=$(sed -n 's/^0:://p' /proc/$pid/cgroup)
  before=$(awk '$1=="oom_kill"{print $2}' "/sys/fs/cgroup$cg/memory.events")
  r=$(printf 'x' | "${AS_AGENT[@]}" "$ASK" text 2 1 /run/desk-parse-lim/sock/parse.sock 2>&1); rc=$?
  after=$(awk '$1=="oom_kill"{print $2}' "/sys/fs/cgroup$cg/memory.events")
  echo "a worker that fills 256 MiB: rc $rc, memory.max $(cat /sys/fs/cgroup$cg/memory.max), oom_kill $before -> $after, answer '$(head -c 60 <<<"$r")'"
  [ $rc = 5 ] || bad "the memory-filling worker's stream didn't end with no line (rc $rc)"
  [ "${after:-0}" -gt "${before:-0}" ] || bad "the kernel didn't kill the worker for memory (oom_kill $before -> $after)"
  [ "$(docker inspect -f '{{.State.Running}}' desk-parse-lim)" = true ] && only_svc desk-parse-lim || bad "desk-svc didn't stay up alone after the worker's OOM kill"
  ;;
clean)
  copy_run desk-parse-mut /run/desk-parse-mut -e 's#-- /opt/java/openjdk/bin/java @/app/parse.options#-- /bin/sh -c "/bin/sleep 300 \& echo OK; echo left a process"#' || exit 0
  r=$(printf 'x' | "${AS_AGENT[@]}" "$ASK" text 10 1 /run/desk-parse-mut/sock/parse.sock 2>&1); echo "a worker that leaves a sleep behind: $(tr '\n' '|' <<<"$r")"
  sleep 1; only_svc desk-parse-mut || bad "something the worker started outlived its answer"
  ;;
follow)
  id=$(cat /opt/ma/desk-agent/current/image-id); img=$(docker inspect -f '{{.Image}}' desk-parse 2>/dev/null)
  echo "desk-agent's image-id $id, desk-parse runs $img"
  [ "$id" = "$img" ] || bad "desk-parse doesn't run desk-agent's current image"
  t1=$(docker inspect -f '{{.State.StartedAt}}' desk-parse)
  systemctl restart desk-agent.service
  for _ in $(seq 1 60); do t2=$(docker inspect -f '{{.State.StartedAt}}' desk-parse 2>/dev/null); [ -n "$t2" ] && [ "$t2" != "$t1" ] && [ -S /run/desk-parse/sock/parse.sock ] && break; sleep 1; done
  echo "desk-parse started $t1, after desk-agent's restart $t2, image $(docker inspect -f '{{.Image}}' desk-parse 2>/dev/null)"
  [ -n "$t2" ] && [ "$t2" != "$t1" ] || bad "a restart of desk-agent didn't restart desk-parse"
  [ "$(docker inspect -f '{{.Image}}' desk-parse 2>/dev/null)" = "$id" ] || bad "after the restart desk-parse doesn't run desk-agent's image"
  ;;
mutations)
  # Each must fail its check. A mutation that passes is a check that tests nothing: BAD.
  mut() { # mut <what> <command producing the check's output>
    local what=$1; shift; local o; o=$("$@" 2>&1)
    if grep -q '^FAILED$' <<<"$o" || [ "${MUT_RC:-0}" != 0 ]; then echo "mutation '$what': the check fails, as it must ($(grep -m1 '^BAD' <<<"$o" | cut -c1-140))"
    else bad "mutation '$what' passed its check"; fi
    MUT_RC=0
  }
  copy_run desk-parse-mut /run/desk-parse-mut -e 's#-v /usr/local/lib/ma/desk-svc:/desk-svc:ro#-v /data/agent:/data/agent:ro -v /usr/local/lib/ma/desk-svc:/desk-svc:ro#' && mut "-v /data/agent:/data/agent:ro" wall_check desk-parse-mut
  copy_run desk-parse-mut /run/desk-parse-mut -e 's#--network none#--network host#' && mut "--network host" wall_check desk-parse-mut
  copy_run desk-parse-mut /run/desk-parse-mut -e 's#--memory 160m --memory-swap 160m#--memory 128m --memory-swap 128m#' && mut "--memory 128m (the 20 MiB ceiling's worst case doesn't fit)" wall_check desk-parse-mut
  SOCK_OWNER=agent copy_run desk-parse-mut /run/desk-parse-mut -e 's#--user 1113:1113#--user 1103:1103#' && mut "--user 1103:1103" wall_check desk-parse-mut
  # desk-svc without the PR_SET_DUMPABLE call (PARSE-L1): a lab build of it in MUT_SVC; else the copy without -clean, which sets it
  # The mutant takes desk-svc's own path for the run (put back at once), so the only thing that differs is the call; the check
  # must fail on that, naming a dumpable process 1, not on some other line.
  if [ -n "${MUT_SVC:-}" ] && [ -x "$MUT_SVC" ]; then
    cp -p /usr/local/lib/ma/desk-svc "$W/desk-svc.real"
    cp "$MUT_SVC" /usr/local/lib/ma/.desk-svc.new && chmod 0755 /usr/local/lib/ma/.desk-svc.new && mv -f /usr/local/lib/ma/.desk-svc.new /usr/local/lib/ma/desk-svc   # a new file: the running one is busy
    copy_run desk-parse-mut /run/desk-parse-mut && {
      o=$(wall_check desk-parse-mut 2>&1)
      if grep -q 'process 1 is dumpable' <<<"$o" && [ "$(grep -c '^BAD' <<<"$o")" = 1 ]; then echo "mutation 'desk-svc built without the PR_SET_DUMPABLE call': the check fails, as it must ($(grep -m1 '^BAD' <<<"$o" | cut -c1-140))"
      else bad "mutation 'desk-svc built without the PR_SET_DUMPABLE call' wasn't caught by the dumpable check alone: $(grep '^BAD' <<<"$o" | head -2)"; fi; }
    docker rm -f desk-parse-mut >/dev/null 2>&1; cp -p "$W/desk-svc.real" /usr/local/lib/ma/.desk-svc.new && mv -f /usr/local/lib/ma/.desk-svc.new /usr/local/lib/ma/desk-svc
    [ "$(sha256sum /usr/local/lib/ma/desk-svc | cut -d' ' -f1)" = "$(cat /usr/local/lib/ma/desk-svc.sha256)" ] || bad "desk-svc wasn't put back"
  else
    copy_run desk-parse-mut /run/desk-parse-mut -e 's# -clean##' && mut "desk-svc not in -clean mode, so dumpable" wall_check desk-parse-mut
  fi
  docker rm -f desk-parse-mut >/dev/null 2>&1
  h=$(nft -a list chain inet ma output | sed -n 's/.*meta skuid 1113 reject.*# handle \([0-9]*\)$/\1/p')
  [ -n "$h" ] && nft delete rule inet ma output handle "$h"
  mut "the uid 1113 firewall line deleted" net_check
  nft insert rule inet ma output meta skuid 1113 reject
  o=$(net_check 2>&1); grep -q '^FAILED$' <<<"$o" && bad "the firewall line didn't come back: $o"
  chmod 0666 /run/desk-parse/sock/parse.sock; mut "chmod 0666 parse.sock" sock_check; chmod 0660 /run/desk-parse/sock/parse.sock
  systemctl stop desk-parse.service
  o=$(parse_check 2>&1); MUT_RC=$?; mut "desk-parse stopped" echo "$o"
  systemctl start desk-parse.service
  for _ in $(seq 1 60); do [ -S /run/desk-parse/sock/parse.sock ] && [ "$(docker inspect -f '{{.State.Running}}' desk-parse 2>/dev/null)" = true ] && break; sleep 0.5; done
  parse_check >/dev/null 2>&1 || bad "after desk-parse's start the parse check doesn't pass again"
  copy_run desk-parse-mut /run/desk-parse-mut -e 's# -clean##' -e 's#-- /opt/java/openjdk/bin/java @/app/parse.options#-- /bin/sh -c "/bin/sleep 300 \& echo OK; echo left a process"#' && {
    printf 'x' | "${AS_AGENT[@]}" "$ASK" text 10 1 /run/desk-parse-mut/sock/parse.sock >/dev/null 2>&1 &   # without -clean the sleep holds the answer open
    sleep 3; o=$(only_svc desk-parse-mut 2>&1); MUT_RC=$?; mut "without -clean" echo "$o"; kill %1 2>/dev/null; }
  ;;
agent)
  # desk-agent's side (release N on): health names the sidecar, and the image's smoke test, which parses through it as uid 1103, passes
  way=$(curl -s --max-time 5 --unix-socket /run/desk-agent/agent-admin.sock http://localhost/health | python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("parse") or "none")' 2>&1)
  echo "desk-agent's health: parse $way"
  [ "$way" = sidecar ] || bad "desk-agent's health doesn't say the sidecar (a release from before ADR 0097 says none)"
  o=$(/opt/ma/smoke-test 2>&1); rc=$?; echo "$o" | sed 's/^/  /'
  [ $rc = 0 ] && grep -q '^smoke-test: desk-parse ok' <<<"$o" || bad "the smoke test didn't pass its desk-parse check"
  ;;
measure)
  # Not a pass by speed: what a parse costs here, and whether the sandbox's 160 MiB holds the worst a file can make the worker
  # use. desk-parse is restarted for a fresh cgroup, so memory.peak is these parses' alone. The kernel must never have to kill.
  # The worst case is a 20 MiB text PDF at files_read's ask (2,000,000 characters, 500 pages): the worker JVM reaches about
  # 141 MiB resident, which a 128 MiB sandbox could not hold (the kernel killed it in 5 of 6 runs on a c7g.large).
  # The ceiling (desk-agent's 05485c8b, "sub/parse-memory"): a worker from then on reads every kind to 20 MiB within its
  # 72 MiB heap and refuses a file over 40 MiB as unreadable; release 6 and before ended out of memory from about 17 MiB. So:
  #   - a 20 MiB text file and PDF that answer OK are the fixed worker's; then a file just over 40 MiB must be refused
  #     "ERR unreadable" and the dense PDF's peak must stay under 140 MiB (12.5% of the 160 MiB left), with no kernel kill;
  #   - a 20 MiB file that ends with no line (the old worker's own out-of-memory exit) is a BAD if PARSE_CEILING=1 or the
  #     desk-agent's version is in FIXED_AGENTS (a bake that pins the fixed desk-agent adds it, and says so in RELEASES.md), and
  #     otherwise a note that this desk-agent is from before the fix; the 40 MiB case is then skipped. The kernel killing is a BAD in both.
  FIXED_AGENTS="2026.11.12-7805537 2026.11.15-67cba46"
  agent_ver=$(cat /opt/ma/desk-agent/current/VERSION 2>/dev/null | head -1)
  strict=0; [ "${PARSE_CEILING:-0}" = 1 ] && strict=1
  for v in $FIXED_AGENTS; do [ "$v" = "$agent_ver" ] && strict=1; done
  echo "desk-agent $agent_ver: the ceiling cases are $([ $strict = 1 ] && echo required || echo 'required once a 20 MiB file reads (a desk-agent from before the fix ends its worker out of memory)')"
  systemctl restart desk-parse.service
  for _ in $(seq 1 60); do [ -S /run/desk-parse/sock/parse.sock ] && [ "$(docker inspect -f '{{.State.Running}}' desk-parse 2>/dev/null)" = true ] && break; sleep 0.5; done
  pid=$(docker inspect -f '{{.State.Pid}}' desk-parse); cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$pid/cgroup)
  echo "idle: memory.current $(( $(cat $cg/memory.current) / 1024 )) KiB (desk-svc alone), desk-svc RSS $(awk '/VmRSS/{print $2}' /proc/$pid/status) KiB"
  mkpdf "$W/p100.pdf" measure 100
  head -c 1024 /dev/urandom | base64 -w 76 | head -c 1024 > "$W/t1k.txt"
  yes 'a line of plain text for the reader, the same again and again' | head -c $((20 << 20)) > "$W/t20m.txt"
  p50() { sort -n | awk '{a[NR]=$1} END {print a[int((NR + 1) / 2)]}'; }
  for f in t1k.txt:text p100.pdf:pdf; do
    ts=""; for _ in $(seq 1 10); do t0=$(date +%s%N); "${AS_AGENT[@]}" "$ASK" ${f#*:} 400000 400 < "$W/${f%:*}" > "$W/out" 2>&1; ts="$ts $(( ($(date +%s%N) - t0) / 1000000 ))"; done
    echo "${f%:*}: p50 $(tr ' ' '\n' <<<"$ts" | grep . | p50) ms of 10 ($ts ms), answer $(head -1 "$W/out" | cut -c1-40), $(wc -c < "$W/out") bytes"
  done
  # a 20 MiB text file, then the dense 20 MiB PDF, each with files_read's ask
  t0=$(date +%s%N); "${AS_AGENT[@]}" "$ASK" text 2000000 500 < "$W/t20m.txt" > "$W/out" 2>&1; rc=$?
  echo "20 MiB of text: rc $rc after $(( ($(date +%s%N) - t0) / 1000000 )) ms, answer '$(head -1 "$W/out" | cut -c1-40)', $(wc -c < "$W/out") bytes"
  fixed=0; [ "$(head -1 "$W/out" | cut -c1-2)" = OK ] && [ "$(wc -c < "$W/out")" -gt 1900000 ] && fixed=1
  if [ $fixed = 1 ]; then
    python3 -I - "$W/d20m.pdf" <<'PY'
import random, sys, zlib
rnd = random.Random(7)
words = ["".join(rnd.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(2 + rnd.randrange(9))) for _ in range(40000)]
body = "\n".join("T* (" + " ".join(rnd.choice(words) for _ in range(16)) + ") Tj" for _ in range(70))
def page(i): return zlib.compress(("BT /F1 8 Tf 10 TL 40 760 Td (Page %d) Tj\n%s\nET" % (i + 1, body)).encode("latin-1"), 6)
n = 0; total = 2000; sizes = []
one = len(page(0)) + 220
n = (20 * 1048576 - 2000) // one
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % (3 + 2 * i) for i in range(n)), n)).encode()]
for i in range(n):
    c = page(i)
    objs.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>" % (4 + 2 * i, 3 + 2 * n)).encode())
    objs.append(("<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(c)).encode() + c + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
pdf = b"%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(pdf)); pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
x = len(pdf)
pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
open(sys.argv[1], "wb").write(pdf)
print("a text PDF of", n, "pages,", len(pdf), "bytes")
PY
    for _ in 1 2 3; do
      systemctl restart desk-parse.service
      for _ in $(seq 1 60); do [ -S /run/desk-parse/sock/parse.sock ] && [ "$(docker inspect -f '{{.State.Running}}' desk-parse 2>/dev/null)" = true ] && break; sleep 0.5; done
      pid=$(docker inspect -f '{{.State.Pid}}' desk-parse); cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$pid/cgroup)
      t0=$(date +%s%N); "${AS_AGENT[@]}" "$ASK" pdf 2000000 500 < "$W/d20m.pdf" > "$W/out" 2>&1; rc=$?
      peak=$(cat $cg/memory.peak 2>/dev/null || echo 0); kills=$(awk '$1=="oom_kill"{print $2}' $cg/memory.events)
      echo "20 MiB dense text PDF (files_read's ask): rc $rc after $(( ($(date +%s%N) - t0) / 1000000 )) ms, answer '$(head -1 "$W/out" | cut -c1-40)', $(wc -c < "$W/out") bytes, memory.peak $((peak >> 20)) MiB of $(( $(cat $cg/memory.max) >> 20 )) MiB, oom_kill $kills"
      [ "${kills:-1}" = 0 ] || bad "the kernel killed the worker for memory on a 20 MiB text PDF: the sandbox is too small"
      [ "$(head -1 "$W/out" | cut -c1-2)" = OK ] && [ "$(wc -c < "$W/out")" -gt 1900000 ] || bad "the 20 MiB text PDF didn't read in full (rc $rc, $(wc -c < "$W/out") bytes)"
      [ "$peak" -gt 0 ] && [ "$peak" -lt $((140 << 20)) ] || bad "memory.peak $((peak >> 20)) MiB leaves under 20 MiB of the sandbox's $(( $(cat $cg/memory.max) >> 20 )) MiB"
    done
    # a file just over the 40 MiB guard: refused as unreadable, the worker's own answer (the client of desk-parse-ask stops at 20 MiB)
    yes 'a line of plain text for the reader, the same again and again' | head -c $(( (40 << 20) + 1024 )) > "$W/t41m.txt"
    r=$("${AS_AGENT[@]}" python3 -I -c '
import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(40); s.connect("/run/desk-parse/sock/parse.sock")
s.sendall(b"parse1 text 2000000 500\n"); 
try:
    with open(sys.argv[1], "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b: break
            s.sendall(b)
    s.shutdown(socket.SHUT_WR)
except OSError:
    pass
out = b""
while len(out) < 4096:
    b = s.recv(4096)
    if not b: break
    out += b
print(out.split(b"\n")[0].decode(errors="replace") or "no line")' "$W/t41m.txt" 2>&1)
    echo "41 MiB of text (past the 40 MiB guard): '$r'"
    [ "$r" = "ERR unreadable" ] || bad "a file past 40 MiB wasn't refused as unreadable ('$r')"
  else
    if [ $strict = 1 ]; then bad "a 20 MiB text file didn't read (rc $rc): desk-agent $agent_ver should hold the ceiling"
    else echo "NOTE: a 20 MiB file ended the worker (the desk-agent is from before the fix: its heap, not the sandbox, is the limit); the 20 MiB PDF and 41 MiB cases were skipped"; fi
  fi
  kills=$(awk '$1=="oom_kill"{print $2}' $cg/memory.events); [ "${kills:-0}" = 0 ] || bad "the kernel killed for memory: the worker's own heap limit didn't come first"
  ;;
*) echo "usage: verify-parse.sh static|wall|socket|parse|limits|clean|follow|agent|measure|mutations" >&2; exit 2 ;;
esac
echo "ran to the end"
