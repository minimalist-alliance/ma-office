#!/usr/bin/env bash
# The parse sidecar for real (ADR 0097), on a Docker host: desk-agent's image built from this tree, ADR 0097's sandbox in
# its shape (one long-lived container, uid 1113, no network, no mounts but its socket directory, read-only, no
# capabilities, 128 MiB), and desk-agent's own Parsers in a container as run starts desk-agent (uid 1103, read-only, the
# directory mounted read-only). Run on the Docker host itself, from services/desk-agent:
#
#   scripts/test-parse-sidecar.sh <test-classes> [rounds]
#
# <test-classes> is target/test-classes from ../mvnw -f desk-agent/pom.xml verify (Java isn't needed here). The
# dispatcher is scripts/parse-standin.pl, a stand-in for desk-svc -accept -conn-stdio -clean, so this proves the wall and
# the protocol, not desk-svc. It checks:
# - the sandbox: uid and gid 1113, no capabilities, no new privileges, only lo, no /data, no /run/desk*, read-only, the
#   limits, from docker inspect and from /proc inside it, also while a worker runs;
# - the socket's layout as the image will make it (root:agent 0750, required root 0444, sock parse:agent 2750, the socket
#   parse:agent 0660), and that uid 1104 can't connect;
# - real files through it as uid 1103: text, PDF, docx, xlsx; a zip bomb and a PDF past the heap end only their worker,
#   and the next file reads; no child starts;
# - with the sandbox stopped: unavailable, and still no child;
# - p50 of [rounds] (default 10) through the sidecar against desk-agent's own child in its container.
# Everything it makes is named $PREFIX-* (default ma-sub) and removed at the end, with the image and its intermediates.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: test-parse-sidecar.sh <test-classes> [rounds]" >&2; exit 64; }
classes=$(cd "$1" && pwd)
rounds=${2:-10}
prefix=${PREFIX:-ma-sub}
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
services_dir=$(cd "$agent_dir/.." && pwd)
tag=desk-parse-it-$(date +%s)
image=$prefix/desk-agent:$tag
work=$(mktemp -d "${HOST_TMP:-/tmp}/$prefix-desk-parse.XXXXXX")
sandbox=$prefix-desk-parse-sandbox
host_cpus=$(docker info --format '{{.NCPU}}')
cpus=$(( host_cpus < 6 ? host_cpus : 6 ))
intermediates=()
failures=0

pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }
expect() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

cleanup() {
  set +e
  docker rm -f "$sandbox" "$prefix-desk-parse-hold" "$prefix-desk-parse-agent" >/dev/null 2>&1
  # uid 1113 and root own what's in $work: a root container removes it.
  [ -d "$work/run" ] && docker run --rm --network none --user 0:0 -v "$work:/w" --entrypoint /bin/rm "$image" -rf /w/run >/dev/null 2>&1
  docker rmi "$image" >/dev/null 2>&1
  for id in "${intermediates[@]:-}"; do [ -n "$id" ] && docker rmi "$id" >/dev/null 2>&1; done
  rm -rf "$work"
}
trap cleanup EXIT

# --- the image, as test-image.sh builds it: the legacy builder, no cache, so every intermediate printed is this build's
echo "building $image"
DOCKER_BUILDKIT=0 docker build --no-cache --network host --file "$agent_dir/Dockerfile" --build-arg VERSION="$tag" \
  --tag "$image" "$services_dir" >"$work/build.log" 2>&1 || { tail -40 "$work/build.log"; exit 1; }
mapfile -t intermediates < <(grep -oE '^ ---> [0-9a-f]{12}$' "$work/build.log" | awk '{print $2}' | sort -u)
image_id=$(docker image inspect -f '{{.Id}}' "$image")
echo "built $image_id (the build read a line through /app/parse.options)"

# Run as a container would be on a desk: a root helper on this image makes the layout ADR 0097 section 2 gives.
docker run --rm -i --network none --user 0:0 -v "$work:/w" --entrypoint /bin/sh "$image" -c '
  set -e
  install -d -o 0 -g 1103 -m 0750 /w/run/desk-parse
  printf 1 > /w/run/desk-parse/required && chown 0:0 /w/run/desk-parse/required && chmod 0444 /w/run/desk-parse/required
  install -d -o 1113 -g 1103 -m 2750 /w/run/desk-parse/sock
  install -o 0 -g 0 -m 0444 /dev/stdin /w/run/standin.pl' <"$agent_dir/scripts/parse-standin.pl"
parse=$work/run/desk-parse

# --- the sandbox: ADR 0097 section 1's flags but its dispatcher (the stand-in for desk-svc) and the log driver (json-file
# here, to read the stand-in's own lines; the worker's stderr is /dev/null either way). --cpus only for the shared host.
docker run -d --name "$sandbox" --network none --user 1113:1113 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 128m --memory-swap 128m --pids-limit 64 \
  --cpu-shares 256 --ulimit core=0 --oom-score-adj 500 --cpus "$cpus" \
  -v "$parse/sock:/run/desk-parse/sock" -v "$work/run/standin.pl:/standin.pl:ro" \
  --entrypoint /usr/bin/perl "$image" /standin.pl /run/desk-parse/sock/parse.sock 1103 \
  /opt/java/openjdk/bin/java @/app/parse.options >/dev/null
# The host's user can't look in (root:agent 0750), so the sandbox is asked.
for _ in $(seq 1 100); do docker exec "$sandbox" test -S /run/desk-parse/sock/parse.sock 2>/dev/null && break; sleep 0.1; done
expect "sandbox: its socket is there" docker exec "$sandbox" test -S /run/desk-parse/sock/parse.sock

# desk-agent as run starts it, but Parsers driven by ParseTimingProbe (the test classes, read-only) for the entrypoint.
as_agent() { # as_agent <name> <user> <parse dir mount or ""> <args...>
  local name=$1 user=$2 mount=$3
  shift 3
  docker run --rm --name "$prefix-desk-parse-$name" --network none --user "$user" --read-only --tmpfs /tmp \
    --cap-drop=ALL --security-opt=no-new-privileges --memory=320m --memory-swap=320m --pids-limit=128 \
    --ulimit core=0 --cpus "$cpus" ${mount:+--mount "$mount"} -v "$classes:/it:ro" --entrypoint java "$image" \
    -Xmx256m -cp /app/desk-agent.jar:/it "$@"
}
run_mount="type=bind,src=$parse,dst=/run/desk-parse,readonly"

# --- the wall, from docker inspect
inspect() { docker inspect -f "$1" "$sandbox"; }
expect "sandbox: user 1113:1113" test "$(inspect '{{.Config.User}}')" = 1113:1113
expect "sandbox: network none" test "$(inspect '{{.HostConfig.NetworkMode}}')" = none
expect "sandbox: read-only root" test "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = true
expect "sandbox: every capability dropped" test "$(inspect '{{json .HostConfig.CapDrop}}')" = '["ALL"]'
expect "sandbox: no new privileges" test "$(inspect '{{json .HostConfig.SecurityOpt}}')" = '["no-new-privileges"]'
expect "sandbox: 128 MiB, no swap past it" test "$(inspect '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}')" = "134217728 134217728"
expect "sandbox: 64 tasks" test "$(inspect '{{.HostConfig.PidsLimit}}')" = 64
expect "sandbox: mounts only its socket directory (and, here, the stand-in)" test \
  "$(inspect '{{range .Mounts}}{{.Destination}} {{end}}' | tr ' ' '\n' | sed '/^$/d' | sort | paste -sd' ')" = "/run/desk-parse/sock /standin.pl"

# --- the wall, from inside, idle and while a worker runs
inside() { docker exec "$sandbox" /bin/sh -c "$1"; }
# The workers' pids: argv[0] is the JDK's java (the dispatcher's own argv names parse.options too).
java_pids='for p in /proc/[0-9]*; do [ "$(head -c 26 $p/cmdline 2>/dev/null)" = /opt/java/openjdk/bin/java ] && basename $p; done; true'
expect "inside: uid and gid 1113, no groups" test "$(inside 'id -u; id -g; id -G')" = "$(printf '1113\n1113\n1113')"
expect "inside: no effective capabilities" test "$(inside "grep ^CapEff /proc/1/status | awk '{print \$2}'")" = 0000000000000000
expect "inside: no new privileges" test "$(inside "grep ^NoNewPrivs /proc/1/status | awk '{print \$2}'")" = 1
expect "inside: only lo" test "$(inside 'ls /sys/class/net | paste -sd" "')" = lo
expect "inside: no /data" inside '! test -e /data'
expect "inside: no /run/desk*, but its socket directory" test "$(inside 'ls -d /run/desk* /run/desk-parse/* 2>/dev/null | paste -sd" "')" = "/run/desk-parse /run/desk-parse/sock"
expect "inside: nothing of /data or /run/desk-agent in its mounts" inside "! grep -qE ' /data| /run/desk-agent| /opt/ma' /proc/self/mountinfo"
expect "inside: the root can't be written" inside '! touch /app/x 2>/dev/null && ! touch /x 2>/dev/null'
# A worker held open (the line and part of a file, no end): it waits on its stdin while it's looked at.
docker run -d --name "$prefix-desk-parse-hold" --network none --user 1103:1103 --read-only --cap-drop ALL \
  --mount "$run_mount" --entrypoint /usr/bin/perl "$image" -MSocket -e '
    socket(my $s, AF_UNIX, SOCK_STREAM, 0) or die; connect($s, pack_sockaddr_un("/run/desk-parse/sock/parse.sock")) or die;
    syswrite($s, "parse1 text 1000 1\nheld "); sleep 6;' >/dev/null
worker=
for _ in $(seq 1 50); do
  worker=$(inside "$java_pids" | head -1)
  [ -n "$worker" ] && break
  sleep 0.1
done
expect "worker: started for the held connection" test -n "$worker"
if [ -n "$worker" ]; then
  expect "worker: uid 1113 (real, effective, saved, fs)" test "$(inside "grep ^Uid /proc/$worker/status | cut -f2-")" = "$(printf '1113\t1113\t1113\t1113')"
  expect "worker: no capabilities" test "$(inside "grep ^CapEff /proc/$worker/status | awk '{print \$2}'")" = 0000000000000000
  expect "worker: an empty environment" test "$(inside "tr '\\0' '\\n' </proc/$worker/environ | grep -c .")" = 0
  expect "worker: only lo in its network namespace" test "$(inside "awk 'NR>2{sub(\":\",\"\",\$1); print \$1}' /proc/$worker/net/dev | paste -sd' '")" = lo
  expect "worker: its stdin is the connection" inside "readlink /proc/$worker/fd/0 | grep -q '^socket:'"
fi
docker wait "$prefix-desk-parse-hold" >/dev/null 2>&1 || true
docker rm -f "$prefix-desk-parse-hold" >/dev/null 2>&1 || true

# --- the socket's layout, and who may connect
layout=$(docker run --rm --network none --user 0:0 -v "$work:/w:ro" --entrypoint /bin/sh "$image" -c \
  'cd /w/run/desk-parse && stat -c "%n %u:%g %a" . required sock sock/parse.sock | paste -sd";"')
expect "socket: layout (dir, marker, sock, socket)" test "$layout" = ". 0:1103 750;required 0:0 444;sock 1113:1103 2750;sock/parse.sock 1113:1103 660"
other=$(docker run --rm --network none --user 1104:1104 --read-only --cap-drop ALL --mount "$run_mount" \
  --entrypoint /usr/bin/perl "$image" -MSocket -e '
    socket(my $s, AF_UNIX, SOCK_STREAM, 0) or die; print connect($s, pack_sockaddr_un("/run/desk-parse/sock/parse.sock")) ? "connected" : "refused: $!"' 2>&1 || true)
expect "socket: uid 1104 can't reach it (got: $other)" grep -qE 'refused: Permission denied' <<<"$other"

# --- real files as desk-agent, through a read-only mount of the directory; then the hostile ones; no child
as_agent agent 1103:1103 "$run_mount" com.minimalistalliance.desk.agent.measure.ParseTimingProbe /run/desk-parse "$rounds" check \
  2>/dev/null | grep -E '^parse-' >"$work/sidecar.out" || true
cat "$work/sidecar.out"
for file in text pdf docx xlsx; do
  expect "sidecar: $file reads" grep -qE "^parse-timing way=sidecar file=$file .* said=OK:" "$work/sidecar.out"
done
expect "sidecar: a zip bomb is an error" grep -qE 'bomb=ERR:(too_complex|unreadable)' "$work/sidecar.out"
expect "sidecar: a PDF past the heap ends its worker: too_complex (or timeout)" grep -qE 'heavy-pdf=ERR:(too_complex|timeout)' "$work/sidecar.out"
expect "sidecar: the next file still reads" grep -q 'after=OK:Still_serving.' "$work/sidecar.out"
expect "sidecar: no child started" grep -qE 'way=sidecar counts=sidecar:[0-9]+/2,child:0/0' "$work/sidecar.out"
expect "sandbox: still running after them" test "$(inspect '{{.State.Running}}')" = true
expect "sandbox: its own process is still the first" test "$(inspect '{{.State.Pid}}')" -gt 0
expect "sandbox: no worker left behind" test -z "$(inside "$java_pids")"
docker logs "$sandbox" 2>&1 | grep -c 'a worker for a peer of uid 1103' | sed 's/^/sandbox: workers started: /'

# --- the child in desk-agent's container, for the timing (no marker, no socket: an image before the sidecar)
as_agent agent 1103:1103 "" com.minimalistalliance.desk.agent.measure.ParseTimingProbe /run/desk-parse "$rounds" \
  2>/dev/null | grep -E '^parse-' >"$work/child.out" || true
cat "$work/child.out"
expect "child: without the directory, the child reads" grep -qE '^parse-timing way=child file=pdf .* said=OK:' "$work/child.out"

# --- fails closed: the sandbox stopped, the marker still there
docker stop -t 2 "$sandbox" >/dev/null
as_agent agent 1103:1103 "$run_mount" com.minimalistalliance.desk.agent.measure.ParseTimingProbe /run/desk-parse 1 check \
  2>/dev/null | grep -E '^parse-' >"$work/closed.out" || true
cat "$work/closed.out"
expect "closed: every file is unavailable" test "$(grep -c 'said=ERR:unavailable' "$work/closed.out")" = 4
expect "closed: and no child started" grep -qE 'counts=sidecar:7/7,child:0/0' "$work/closed.out"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
