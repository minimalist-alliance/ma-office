#!/usr/bin/env bash
# Runs the Commons load test on a build server with Docker, in ma-sub-commons-* containers, each
# capped at 6 CPUs and 5 GB, on a Docker network of their own with no published ports.
#
#   BUILD_HOST=user@host loadtest/run-build-server.sh build      # binaries and images, built there
#   BUILD_HOST=user@host loadtest/run-build-server.sh scenario <label> <members> <talkers> <movers> <drawers> [chatters]
#   BUILD_HOST=user@host loadtest/run-build-server.sh all        # the table in README.md
#   BUILD_HOST=user@host loadtest/run-build-server.sh board      # only the rows with board activity
#   BUILD_HOST=user@host loadtest/run-build-server.sh clean      # containers, network and images
#
# Results land in loadtest/results/<label>.json. It touches nothing not named $PREFIX-* (ma-sub-commons-* unless
# PREFIX says), and prints the build server's load before each run, so a busy server can be left alone. BUILD_DIR is
# its folder on the build server. The server runs with -dev, so members connect over the WebSocket room link; on a
# guild desk the same records come through deskd's socket instead (README, "Load test").
set -euo pipefail
cd "$(dirname "$0")"
: "${BUILD_HOST:?set BUILD_HOST=user@host, the build server}"
export DOCKER_HOST=${DOCKER_HOST:-ssh://$BUILD_HOST}
DOCKER=${DOCKER:-docker}
PREFIX=${PREFIX:-ma-sub-commons}
BDIR=${BUILD_DIR:-ma-sub-builds/21-commons}
NET=$PREFIX-net
SRV=$PREFIX-server
IMG=ma-sub/${PREFIX#ma-sub-}
CAP=(--cpus=6 --memory=5g)
MEASURE=${MEASURE:-60s}
RESULTS=${RESULTS:-results} # task 48 wrote results/48-guild
mkdir -p "$RESULTS"

# build: the Go binaries are compiled on the build server, in golang:1.25 with the vendored modules
# (`go mod vendor` here first), so nothing heavy runs on the shared machine.
build() {
  [[ -f strokes.bin ]] || (cd ../web && node scripts/make-load-fixtures.mjs ../loadtest/strokes.bin)
  (cd ../server && go mod vendor)
  local R=$BUILD_HOST B=$BDIR/ma-desk/apps/commons
  ssh $R "mkdir -p ~/$B/server ~/$B/loadtest ~/$BDIR/gocache"
  rsync -a --delete --exclude bin --exclude data ../server/ $R:$B/server/
  rsync -a strokes.bin Dockerfile.server Dockerfile.load $R:$B/loadtest/
  ssh $R "cd ~/$B && docker run --rm --name $PREFIX-build --cpus=6 --memory=5g --user \$(id -u):\$(id -g) \
      -e HOME=/tmp -e GOCACHE=/cache -e GOFLAGS=-mod=vendor -e CGO_ENABLED=0 -e GOTOOLCHAIN=local \
      -v ~/$BDIR/gocache:/cache -v \$PWD/server:/src -w /src golang:1.25-bookworm \
      sh -c 'go build -trimpath -o bin/commons-server ./cmd/commons-server && go build -trimpath -o bin/commons-load ./cmd/commons-load' \
    && rm -rf ctx && mkdir ctx && cp server/bin/commons-server server/bin/commons-load loadtest/strokes.bin loadtest/Dockerfile.* ctx/ \
    && docker build -q -t $IMG-server:1 -f ctx/Dockerfile.server ctx && docker build -q -t $IMG-load:1 -f ctx/Dockerfile.load ctx && rm -rf ctx"
}

server_up() {
  $DOCKER rm -f $SRV >/dev/null 2>&1 || true
  $DOCKER network inspect $NET >/dev/null 2>&1 || $DOCKER network create --internal $NET >/dev/null
  $DOCKER run -d --name $SRV --network $NET "${CAP[@]}" --tmpfs /data $IMG-server:1 \
    ${DEV_FLAG--dev} -addr 0.0.0.0:8790 -udp 0.0.0.0:8791 -data /data ${SERVER_ARGS:-} >/dev/null
  sleep 1
}

# scenario <label> <members> <talkers> <movers> <drawers> [chatters]
scenario() {
  local label=$1 n=$2 talk=$3 mov=$4 draw=$5 chat=${6:-0}
  ssh "$BUILD_HOST" 'uptime; free -g | sed -n 2p' >&2
  server_up
  local per=100 procs=$(( (n + 99) / 100 )) i=0 pids=()
  rm -f "$RESULTS/$label".part*
  while (( i < procs )); do
    local first=$(( i * per )) cnt=$(( n - i * per < per ? n - i * per : per ))
    local stats=""
    local meas=$MEASURE
    if (( i == 0 )); then stats="-stats http://$SRV:8790/stats"; else meas=$(( ${MEASURE%s} + 20 ))s; fi
    local net=(--network $NET) host=$SRV
    if [[ "${NETMODE:-bridge}" == shared ]]; then net=(--network container:$SRV); host=127.0.0.1; stats=${stats//$SRV/127.0.0.1}; fi
    local chatters=""
    if (( i == 0 && chat > 0 )); then chatters="-chatters $chat"; fi
    $DOCKER run --rm --name $PREFIX-load-$i "${net[@]}" "${CAP[@]}" $IMG-load:1 \
      -url "ws://$host:8790/ws?room=load" $stats -members $cnt -first $first -talkers $talk -movers $mov -drawers $draw $chatters \
      -ramp 20 -warm 10s -measure $meas -label "$label" -quiet > "$RESULTS/$label.part$i" 2>"$RESULTS/$label.err$i" &
    pids+=($!)
    i=$(( i + 1 ))
  done
  # A cross-check from Docker itself, midway through the measurement.
  sleep $(( n / 20 + 10 + ${MEASURE%s} / 2 ))
  $DOCKER stats --no-stream --format '{{json .}}' $($DOCKER ps --format '{{.Names}}' | grep "^$PREFIX-") > "$RESULTS/$label.dockerstats" || true
  for p in "${pids[@]}"; do wait "$p" || true; done
  cp "$RESULTS/$label.part0" "$RESULTS/$label.json"
  $DOCKER logs $SRV > "$RESULTS/$label.server.log" 2>&1 || true
  if [[ "${SERVER_ARGS:-}" == *cpuprofile* ]]; then $DOCKER cp $SRV:/prof/cpu.pprof "$RESULTS/$label.cpu.pprof" || true; fi
  $DOCKER rm -f $SRV >/dev/null
  cat "$RESULTS/$label.json"
  cat "$RESULTS/$label.dockerstats"
}

clean() {
  for c in $($DOCKER ps -a --format '{{.Names}}' | grep "^$PREFIX-" || true); do $DOCKER rm -f "$c" >/dev/null; done
  $DOCKER network rm $NET >/dev/null 2>&1 || true
  $DOCKER rmi $IMG-server:1 $IMG-load:1 >/dev/null 2>&1 || true
}

case "${1:-}" in
  build) build ;;
  scenario) shift; scenario "$@" ;;
  board)
    # Only the runs with board activity, after a change to the room link.
    scenario m50-t10 50 10 10 2
    scenario m100-t10 100 10 10 2
    scenario m200-t10 200 10 10 2
    scenario m200-t3 200 3 10 2
    scenario m200-t20 200 20 10 2
    ;;
  guild)
    # Task 48: the busiest row of task 21's table, and the same with a busy chat (20 members posting every 5 to 15 s).
    scenario m200-t10 200 10 10 2
    scenario m200-t10-chat 200 10 10 2 20
    scenario m200-t0-idle 200 0 0 0
    ;;
  all)
    scenario m50-t10 50 10 10 2
    scenario m100-t10 100 10 10 2
    scenario m200-t10 200 10 10 2
    scenario m200-t10-voiceonly 200 10 0 0
    scenario m200-t3 200 3 10 2
    scenario m200-t0-idle 200 0 0 0
    scenario m200-t20 200 20 10 2
    ;;
  clean) clean ;;
  *) echo "usage: $0 build | scenario <label> <members> <talkers> <movers> <drawers> [chatters] | all | board | guild | clean" >&2; exit 2 ;;
esac
