#!/usr/bin/env bash
# Builds desk-agent's real image with whatever Docker this shell reaches (DOCKER_HOST is honoured), runs it with
# run's settings, checks health from inside the container, measures it, and removes everything it made.
#
#   services/desk-agent/scripts/test-image.sh <tag> [runs]
#
# test-on-box.sh runs this on the arm64 test box. With DOCKER_HOST pointing at an x86_64 build server it proves the
# Dockerfile and the container there, which is not a desk: those numbers aren't desk numbers.
#
# - Builds with the legacy builder (DOCKER_BUILDKIT=0), which is what a desk's Docker without buildx has, and which
#   names every intermediate image in its output. With --no-cache none of those can be another build's, so exactly
#   they are removed afterwards, with the image, and the bases only if this pulled them. Nothing else is touched.
# - Runs the container as run does: host network, uid 1103, read-only root, a tmpfs /tmp, no capabilities, the same
#   memory limit, and /run/desk-agent and /data/agent bound to fresh directories. Only the log driver differs
#   (json-file, so docker logs can read it).
# - Health comes from perl inside the container, as uid 1103, since the socket is 0600 and the JRE has no curl. So
#   does one agent.list over the agent socket, which this run opens to uid 1103 (DESK_AGENT_PEER_UID) for it.
# - Each run: wall time from docker run to the ready line, desk-agent's own ready time, RSS and CPU ticks at ready
#   and after 5 s idle, then docker stop, which must exit 143 within the stop timeout.
#
# Needs docker, and a shell on the Docker host for the bind mounts: local, or HOST_SHELL="ssh user@host" when
# DOCKER_HOST is remote. Those go in a new directory under HOST_TMP (default /tmp) on that host. Every name it makes
# starts with $PREFIX (default ma-sub).
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: test-image.sh <tag> [runs]" >&2; exit 64; }
tag=$1
runs=${2:-5}
[[ $tag =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad tag: $tag" >&2; exit 64; }
prefix=${PREFIX:-ma-sub}
docker=${DOCKER:-docker}
host_shell=${HOST_SHELL:-}
host_tmp=${HOST_TMP:-/tmp}
image=$prefix/desk-agent:$tag
services_dir=$(cd "$(dirname "$0")/../.." && pwd)
dockerfile=$services_dir/desk-agent/Dockerfile
memory=$(grep -oE -- '--memory=[0-9]+m' "$services_dir/desk-agent/docker/run" | cut -d= -f2)
# A shared build server asks for at most 6 CPUs a container; Docker refuses more than the host has (the box has 2).
host_cpus=$($docker info --format '{{.NCPU}}')
cpus=$(( host_cpus < 6 ? host_cpus : 6 ))
log=$(mktemp -d)

on_host() { # on_host <command>: a shell command on the Docker host
  if [ -n "$host_shell" ]; then $host_shell "$1"; else sh -c "$1"; fi
}

bases=$(grep -E '^FROM ' "$dockerfile" | awk '{print $2}')
new_bases=()
intermediates=()
containers=()
remote_dir=

cleanup() {
  set +e
  for c in "${containers[@]:-}"; do
    [ -n "$c" ] && $docker rm -f "$c" >/dev/null 2>&1
  done
  # The files uid 1103 wrote sit in directories this made writable, so the host user can remove them.
  [ -n "$remote_dir" ] && on_host "rm -rf '$remote_dir'"
  $docker rmi "$image" >/dev/null 2>&1
  # The build stage's images, newest first, by the ids the legacy builder printed. Shared parents stay.
  for ((i = ${#intermediates[@]} - 1; i >= 0; i--)); do
    $docker rmi "${intermediates[i]}" >/dev/null 2>&1
  done
  for base in "${new_bases[@]:-}"; do
    [ -n "$base" ] && $docker rmi "$base" >/dev/null 2>&1
  done
  # Says what's left of what this made, so a run's cleanup is on record.
  local left=0 made=0
  for ref in "$image" "${intermediates[@]:-}" "${new_bases[@]:-}" "${containers[@]:-}"; do
    [ -n "$ref" ] || continue
    made=$((made + 1))
    if $docker inspect --format '{{.Id}}' "$ref" >/dev/null 2>&1; then left=$((left + 1)); fi
  done
  echo "test-image: cleanup: $left of $made images and containers this made are left; ${#new_bases[@]} base(s) were pulled"
  rm -rf "$log"
}
trap cleanup EXIT

# The ids of the images each step made, leaving out the bases that FROM names.
step_images() {
  awk '/^Step [0-9]+\/[0-9]+ : FROM /{from=1; next} /^ ---> [0-9a-f]{12}$/{if (from) from=0; else print $2}' "$1"
}

echo "test-image: docker $($docker version --format '{{.Server.Version}} {{.Server.Arch}}')"
for base in $bases; do
  if ! $docker image inspect --format '{{.Id}}' "$base" >/dev/null 2>&1; then
    new_bases+=("$base")
  fi
done

started=$(date +%s)
# Capped as a shared build server asks (6 CPUs, 5 GiB); far above what the arm64 box has, so no limit there.
if ! DOCKER_BUILDKIT=0 $docker build --no-cache --network host --memory=5g --cpu-period=100000 --cpu-quota=600000 \
  --file "$dockerfile" --build-arg "VERSION=$tag" \
  --tag "$image" "$services_dir" >"$log/build.log" 2>&1; then
  mapfile -t intermediates < <(step_images "$log/build.log")
  tail -n 40 "$log/build.log"
  echo "test-image: the build failed" >&2
  exit 1
fi
mapfile -t intermediates < <(step_images "$log/build.log")
echo "test-image: built $image in $(($(date +%s) - started)) s"
grep -E 'desk-agent CDS training' "$log/build.log" | sed 's/^/test-image: build: /'
echo "test-image: image size $($docker image inspect --format '{{.Size}}' "$image" | awk '{printf "%.0f MB", $1 / 1e6}')"
echo "test-image: $($docker image inspect --format '{{.Os}}/{{.Architecture}}, user {{.Config.User}}' "$image")"

remote_dir=$(on_host "mkdir -p $host_tmp && mktemp -d $host_tmp/$prefix-desk-agent.XXXXXX")
on_host "mkdir '$remote_dir/run' '$remote_dir/data' && (chown 1103:1103 '$remote_dir/run' '$remote_dir/data' 2>/dev/null \
  || chmod 0777 '$remote_dir/run' '$remote_dir/data')"

health() { # health <container>: the status line and body of GET /health, as uid 1103 inside the container
  $docker exec "$1" perl -MIO::Socket::UNIX -e '
    my $s = IO::Socket::UNIX->new(Peer => "/run/desk-agent/agent-admin.sock") or exit 2;
    print $s "GET /health HTTP/1.1\r\n\r\n"; local $/; my $r = <$s>; $r =~ s/\r\n.*\r\n\r\n/ /s; print $r;'
}

agent_list() { # agent_list <container>: agent.list over the agent socket, as uid 1103, which this run lets in
  $docker exec "$1" perl -MIO::Socket::UNIX -e '
    my $s = IO::Socket::UNIX->new(Peer => "/run/desk-agent/agent.sock") or exit 2;
    my $j = q({"t":"req","id":1,"m":"agent.list","p":{}});
    print $s pack("NC", length($j) + 1, 1) . $j;
    read($s, my $h, 5) == 5 or exit 3; my ($n) = unpack("N", $h);
    read($s, my $b, $n - 1); print $b;'
}

status_kib() { # status_kib <container> <field>: a field of the JVM's /proc status, in KiB
  $docker exec "$1" sh -c "grep '^$2:' /proc/1/status" | awk '{print $2}'
}

ticks() { # ticks <container>: user + system CPU ticks of the JVM
  $docker exec "$1" sh -c 'cut -d")" -f2 /proc/1/stat' | awk '{print $12 + $13}'
}

echo "run  wall_ms  ready_ms  rss_ready_mib  anon  file  ticks_ready  rss_idle_mib  ticks_idle_5s  cgroup  stop_s"
for n in $(seq 1 "$runs"); do
  name=$prefix-04-desk-agent-$n
  containers+=("$name")
  t0=$(date +%s%N)
  $docker run -d --name "$name" --network host --user 1103:1103 --read-only --tmpfs /tmp --cpus="$cpus" \
    --cap-drop=ALL --security-opt=no-new-privileges -e DESK_AGENT_PEER_UID=1103 \
    --memory="$memory" --memory-swap="$memory" --cpu-shares=256 --pids-limit=128 --stop-timeout=30 --ulimit core=0 \
    -v "$remote_dir/run:/run/desk-agent" -v "$remote_dir/data:/data/agent" "$image" >/dev/null
  ready=
  for _ in $(seq 1 600); do
    ready=$($docker logs "$name" 2>&1 | sed -n 's/.*desk-agent ready in \([0-9]*\) ms.*/\1/p')
    [ -n "$ready" ] && break
    sleep 0.05
  done
  t1=$(date +%s%N)
  [ -n "$ready" ] || { $docker logs "$name" 2>&1 | tail -n 20; echo "test-image: run $n never got ready" >&2; exit 1; }
  body=$(health "$name")
  case $body in
    "HTTP/1.1 200 OK "*'"status":"ok"'*'"audit":"open","usage":"open"'*) ;;
    *) echo "test-image: run $n health: $body" >&2; exit 1 ;;
  esac
  if [ "$n" = 1 ]; then
    echo "test-image: health: $body"
    echo "test-image: /tmp is $($docker exec "$name" sh -c "awk '\$2 == \"/tmp\" {print \$3, \$4}' /proc/mounts")"
    echo "test-image: / is $($docker exec "$name" sh -c "awk '\$2 == \"/\" {print \$4}' /proc/mounts" | cut -d, -f1)"
    agents=$(agent_list "$name")
    case $agents in
      *'"t":"res"'*'"id":"manager"'*) echo "test-image: agent socket: agent.list answered with the manager" ;;
      *) echo "test-image: agent socket: $agents" >&2; exit 1 ;;
    esac
  fi
  rss=$(status_kib "$name" VmRSS) anon=$(status_kib "$name" RssAnon) file=$(status_kib "$name" RssFile)
  ticks_ready=$(ticks "$name")
  sleep 5
  rss_idle=$(status_kib "$name" VmRSS)
  ticks_idle=$(($(ticks "$name") - ticks_ready))
  cgroup=$($docker stats --no-stream --format '{{.MemUsage}}' "$name" | awk '{print $1}')
  s0=$(date +%s%N)
  $docker stop "$name" >/dev/null
  s1=$(date +%s%N)
  code=$($docker inspect --format '{{.State.ExitCode}}' "$name")
  [ "$code" = 143 ] || { $docker logs "$name" 2>&1 | tail -n 20; echo "test-image: run $n exited $code" >&2; exit 1; }
  if $docker logs "$name" 2>&1 | grep -E ' (ERROR|WARN) |\[(warning|error) *\]\[cds' >"$log/noise"; then
    cat "$log/noise"
    echo "test-image: run $n logged a warning or error" >&2
    exit 1
  fi
  printf '%-4s %-8s %-9s %-14s %-5s %-5s %-12s %-13s %-14s %-7s %s\n' "$n" $(((t1 - t0) / 1000000)) "$ready" \
    $((rss / 1024)) $((anon / 1024)) $((file / 1024)) "$ticks_ready" $((rss_idle / 1024)) "$ticks_idle" "$cgroup" \
    "$(awk -v a="$s0" -v b="$s1" 'BEGIN{printf "%.1f", (b - a) / 1e9}')"
  $docker rm "$name" >/dev/null
done
echo "test-image: all $runs runs healthy; removing what this made"
