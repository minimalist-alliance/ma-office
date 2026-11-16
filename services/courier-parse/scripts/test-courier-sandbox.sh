#!/usr/bin/env bash
# desk-parse's Courier mode in the real sandbox (ADR 0097's wall, as the Courier instance has it), on a Docker host:
# desk-agent's image built from this tree, then one worker per request, exactly as desk-svc starts one: uid 1113, no
# network, no IPC, a read-only root, no capabilities, no new privileges, 160 MiB with no swap, 64 tasks, one CPU, an empty
# environment, `java @/app/courier-parse.options`, the request on stdin and the answer on stdout. Run on the Docker host,
# from services/courier-parse:
#
#   scripts/test-courier-sandbox.sh <inputs>
#
# <inputs> holds <name>.req (the request line and its bytes) and <name>.expect (the first line the answer must have),
# from SandboxInputs (-Dcourier.sandbox.out=<inputs>; Java isn't needed here). For each it checks the answer's line, that
# the kernel didn't kill the worker (exit 137), the cgroup's memory.peak against the 160 MiB, and the time against the
# 10 s limit; and once, the wall from inside (uid, capabilities, only lo, nothing writable). Everything it makes is named
# $PREFIX-* (default ma-sub) and removed at the end, with the image and its intermediates.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: test-courier-sandbox.sh <inputs>" >&2; exit 64; }
inputs=$(cd "$1" && pwd)
prefix=${PREFIX:-ma-sub}
parse_dir=$(cd "$(dirname "$0")/.." && pwd)
services_dir=$(cd "$parse_dir/.." && pwd)
tag=courier-parse-it-$(date +%s)
image=$prefix/desk-agent:$tag
work=$(mktemp -d "${HOST_TMP:-/tmp}/$prefix-courier-parse.XXXXXX")
intermediates=()
failures=0

pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }

cleanup() {
  set +e
  docker ps -aq --filter "name=^$prefix-courier-" | xargs -r docker rm -f >/dev/null 2>&1
  docker rmi "$image" >/dev/null 2>&1
  for id in "${intermediates[@]:-}"; do [ -n "$id" ] && docker rmi "$id" >/dev/null 2>&1; done
  rm -rf "$work"
}
trap cleanup EXIT

echo "building $image"
DOCKER_BUILDKIT=0 docker build --no-cache --network host --file "$services_dir/desk-agent/Dockerfile" --build-arg VERSION="$tag" \
  --tag "$image" "$services_dir" >"$work/build.log" 2>&1 || { tail -40 "$work/build.log"; exit 1; }
mapfile -t intermediates < <(grep -oE '^ ---> [0-9a-f]{12}$' "$work/build.log" | awk '{print $2}' | sort -u)
echo "built $(docker image inspect -f '{{.Id}}' "$image") (the build parsed a message through /app/courier-parse.options)"

mkdir -p "$work/peak"
chmod 0777 "$work/peak"
wall=(--network none --ipc none --user 1113:1113 --read-only --cap-drop ALL --security-opt no-new-privileges
  --log-driver none --memory 160m --memory-swap 160m --pids-limit 64 --cpu-shares 256 --cpus 1 --ulimit core=0
  --oom-score-adj 500)

# The wall, read from inside, once.
inside=$(docker run --rm --name "$prefix-courier-wall" "${wall[@]}" --entrypoint /bin/sh "$image" -c \
  'id -u; id -g; grep CapEff /proc/self/status | awk "{print \$2}"; ls /sys/class/net | tr "\n" " "; echo;
   touch /app/x 2>/dev/null && echo writable || echo read-only; ls -d /data /run/desk* 2>/dev/null | wc -l')
[ "$(echo "$inside" | sed -n 1p)" = 1113 ] && [ "$(echo "$inside" | sed -n 2p)" = 1113 ] && pass "uid and gid 1113" || fail "uid and gid: $inside"
[ "$(echo "$inside" | sed -n 3p)" = 0000000000000000 ] && pass "no capabilities" || fail "capabilities"
[ "$(echo "$inside" | sed -n 4p | xargs)" = lo ] && pass "only lo" || fail "network: $(echo "$inside" | sed -n 4p)"
[ "$(echo "$inside" | sed -n 5p)" = read-only ] && pass "read-only root" || fail "root writable"
[ "$(echo "$inside" | sed -n 6p)" = 0 ] && pass "no /data, no /run/desk*" || fail "a mount it shouldn't have"

printf '%-26s %-22s %8s %10s\n' request answer ms peak_MiB
for req in "$inputs"/*.req; do
  name=$(basename "$req" .req)
  want=$(cat "$inputs/$name.expect")
  start=$(date +%s%N)
  set +e
  docker run --rm -i --name "$prefix-courier-$name" "${wall[@]}" -v "$work/peak:/peak" --entrypoint /bin/sh "$image" -c \
    "env -i /opt/java/openjdk/bin/java @/app/courier-parse.options; s=\$?; cat /sys/fs/cgroup/memory.peak > /peak/$name 2>/dev/null; exit \$s" \
    <"$req" >"$work/$name.ans"
  status=$?
  set -e
  ms=$(( ($(date +%s%N) - start) / 1000000 ))
  line=$(head -n 1 "$work/$name.ans" | tr -d '\r')
  peak=$(cat "$work/peak/$name" 2>/dev/null || echo 0)
  peak_mib=$(( peak / 1048576 ))
  printf '%-26s %-22s %8s %10s\n' "$name" "${line:0:22}" "$ms" "$peak_mib"
  [ "$line" = "$want" ] || fail "$name: answered '$line', wanted '$want' (exit $status)"
  [ "$status" != 137 ] || fail "$name: killed by the kernel"
  [ "$peak_mib" -lt 160 ] || fail "$name: memory.peak $peak_mib MiB"
  [ "$ms" -lt 12000 ] || fail "$name: $ms ms with the container's start"
done

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
