#!/usr/bin/env bash
# Tests desk-agent's packaging without Docker, as services/scripts/test-release-scripts.sh does for deskd. It proves
# the scripts' logic, the Dockerfile's rules and the JVM steps, not that an image builds: that's a build on the
# build server (x86) and test-on-box.sh (arm64).
#
#   services/desk-agent/scripts/test-release-scripts.sh
#
# - The shared build-image.sh and package-release.sh, unchanged, for service desk-agent, against a stub docker.
# - run, against the flags ADR 0040 and design 9.8 require; health, against a fake admin socket.
# - desk-agent.env, against the settings the Java code reads.
# - The Dockerfile: pinned bases, no BuildKit-only syntax, the training property nowhere a desk runs.
# - If desk-agent/target/desk-agent.jar exists: the Dockerfile's unpacking, SQLite's library step, the AppCDS
#   training and the entrypoint, with this machine's JDK and /app moved to a temporary directory, up to the real
#   /health. Run ../mvnw -f desk-agent/pom.xml verify first to include this.
#
# Needs curl, jq, python3, tar, unzip and, for the last part, JAVA_HOME or the toolchain's JDK.
set -euo pipefail

agent_dir=$(cd "$(dirname "$0")/.." && pwd)
services_dir=$(cd "$agent_dir/.." && pwd)
scripts=$services_dir/scripts
docker_dir=$agent_dir/docker
dockerfile=$agent_dir/Dockerfile
# Short on purpose: Unix socket paths are limited to 107 bytes.
work=$(mktemp -d /tmp/agent-rel.XXXXXX)
java_home=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
background=()

cleanup() {
  for pid in "${background[@]:-}"; do
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

failures=0
pass() { echo "ok    $1"; }
fail() {
  echo "FAIL  $1"
  failures=$((failures + 1))
}
expect() { # expect <name> <command...>: the command must succeed
  local name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}
refuses() { # refuses <name> <command...>: the command must fail
  local name=$1
  shift
  if "$@" >"$work/refused.out" 2>&1; then fail "$name"; else pass "$name"; fi
}

# --- the stub docker, as deskd's test has it
mkdir "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
echo "$*" >>"$STUB_LOG"
case $1 in
  info) echo "${STUB_ARCH:-aarch64}" ;;
  build) ;;
  image) [ -z "${STUB_NO_IMAGE:-}" ] ;;
  save)
    [ -z "${STUB_SAVE_FAILS:-}" ] || exit 1
    echo fake-image >"$3"
    ;;
  run) exit "${STUB_RUN_EXIT:-0}" ;;
  *)
    echo "stub docker: unexpected command: $*" >&2
    exit 64
    ;;
esac
EOF
chmod +x "$work/bin/docker"
export PATH=$work/bin:$PATH
export STUB_LOG=$work/docker.log
logged() { grep -qF -- " $1 " <<<" $(tail -n 1 "$STUB_LOG") "; }

# --- the shared build-image.sh, for desk-agent
tag=2026.11.06-abc1234
: >"$STUB_LOG"
expect "build-image: builds desk-agent" "$scripts/build-image.sh" desk-agent "$tag"
for arg in "--network host" "--file $dockerfile" "--build-arg VERSION=$tag" "--tag ma/desk-agent:$tag" "$services_dir"; do
  expect "build-image: passes $arg" logged "$arg"
done
refuses "build-image: an x86 daemon" env STUB_ARCH=x86_64 "$scripts/build-image.sh" desk-agent "$tag"

# --- the shared package-release.sh, for desk-agent
out=$work/out
expect "package-release: packages desk-agent" "$scripts/package-release.sh" desk-agent "$tag" "$out"
tgz=$out/desk-agent-$tag.tgz
expect "package-release: exactly the section 6 contents" test \
  "$(tar -tzf "$tgz" | LC_ALL=C sort | tr '\n' ' ')" = "VERSION desk-agent.env health image.tar run "
expect "package-release: the checksum verifies" bash -c "cd '$out' && sha256sum --check --quiet desk-agent-$tag.tgz.sha256"
expect "package-release: saved the right image" grep -q "^save -o .*/image.tar ma/desk-agent:$tag$" "$STUB_LOG"
expect "package-release: owned by root" test -z "$(tar --numeric-owner -tvzf "$tgz" | awk '$2 != "0/0"')"
mkdir "$work/unpacked"
tar -xzf "$tgz" -C "$work/unpacked"
expect "package-release: run and health are executable" test -x "$work/unpacked/run" -a -x "$work/unpacked/health"

# --- run, against the flags desk-agent must have
release=$work/unpacked
image_id=sha256:0123456789abcdef
echo "$image_id" >"$release/image-id"
: >"$STUB_LOG"
expect "run: starts docker" env RELEASE_DIR="$release" "$release/run"
expect "run: the image comes last" test "$(tail -n 1 "$STUB_LOG" | awk '{print $NF}')" = "$image_id"
for flag in "--rm" "--network host" "--user 1103:1103" "--read-only" "--tmpfs /tmp" "--cap-drop=ALL" \
  "--security-opt=no-new-privileges" "--log-driver=journald" "--log-opt tag=desk-agent" "--ulimit core=0" \
  "--pids-limit=128" "--stop-timeout=30" "-v /run/desk-agent:/run/desk-agent" "-v /data/agent:/data/agent" \
  "--env-file $release/desk-agent.env"; do
  expect "run: $flag" logged "$flag"
done
memory=$(tail -n 1 "$STUB_LOG" | grep -oE -- '--memory=[0-9]+m' | cut -d= -f2)
expect "run: a memory limit" test -n "$memory"
expect "run: and no swap beyond it" logged "--memory-swap=$memory"
refuses "run: never mounts deskd's data" grep -q '/data/desk' "$docker_dir/run"
refuses "run: never mounts docker.sock" grep -q 'docker.sock' "$docker_dir/run"
refuses "run: passes on docker's exit status" env STUB_RUN_EXIT=3 RELEASE_DIR="$release" "$release/run"
refuses "run: no RELEASE_DIR" env -u RELEASE_DIR "$release/run"
rm "$release/image-id"
: >"$STUB_LOG"
refuses "run: no image-id" env RELEASE_DIR="$release" "$release/run"
expect "run: without image-id, docker isn't called" test ! -s "$STUB_LOG"

# --- health, against a fake admin socket
fake_admin() { # fake_admin <socket> <status>
  python3 -I -c '
import socket, sys
path, code = sys.argv[1], sys.argv[2]
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(4)
while True:
    client, _ = server.accept()
    client.recv(4096)
    client.sendall(f"HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
    client.close()
' "$1" "$2" &
  background+=($!)
  for _ in $(seq 1 100); do
    [ -S "$1" ] && return 0
    sleep 0.05
  done
  fail "fake admin socket $1 didn't appear"
}
fake_admin "$work/ok.sock" 200
fake_admin "$work/bad.sock" 503
expect "health: 200 is healthy" env DESK_AGENT_ADMIN_SOCKET="$work/ok.sock" "$docker_dir/health"
refuses "health: 503 isn't" env DESK_AGENT_ADMIN_SOCKET="$work/bad.sock" "$docker_dir/health"
refuses "health: no socket isn't" env DESK_AGENT_ADMIN_SOCKET="$work/absent.sock" "$docker_dir/health"

# --- desk-agent.env
expect "desk-agent.env: everything is commented out" test -z "$(grep -vE '^(#|$)' "$docker_dir/desk-agent.env" || true)"
read_keys=$(grep -rhoE 'getProperty\("desk\.agent\.[a-z.]+"' "$agent_dir/src/main/java" |
  sed -E 's/getProperty\("//; s/"//; s/\./_/g' | tr 'a-z' 'A-Z' | sort -u)
[ -n "$read_keys" ] || fail "desk-agent.env: found the keys the code reads"
for key in $read_keys; do
  expect "desk-agent.env: lists $key" grep -q "^#$key=" "$docker_dir/desk-agent.env"
done

# --- the Dockerfile's rules
expect "Dockerfile: every base is pinned by digest" \
  test -z "$(grep -E '^FROM ' "$dockerfile" | grep -vE '^FROM [^ ]+@sha256:[0-9a-f]{64}( AS [a-z]+)?$' || true)"
expect "Dockerfile: the bases are deskd's, so a desk shares their layers" test \
  "$(grep -E '^FROM ' "$dockerfile" | awk '{print $2}')" = "$(grep -E '^FROM ' "$services_dir/deskd/Dockerfile" | awk '{print $2}')"
refuses "Dockerfile: no BuildKit-only syntax" grep -qE '^# *syntax=|--mount=|--chmod=|--link|<<|--chown=[^ ]*\$' "$dockerfile"
refuses "training: nothing a desk runs names its property" grep -q 'ma\.cds\.train' \
  "$docker_dir/jvm.options" "$docker_dir/desk-agent.env" "$docker_dir/run" "$docker_dir/health"
refuses "training: nor does the entrypoint" grep -q '^ENTRYPOINT.*ma\.cds\.train' "$dockerfile"
refuses "training: and no setting is read for it" grep -rq 'getProperty("ma\.cds\.train' "$agent_dir/src/main/java"
expect "Dockerfile: the image runs as agent, uid 1103" grep -qx 'USER 1103:1103' "$dockerfile"

# --- the Dockerfile's steps, with a real JVM
jar=$agent_dir/target/desk-agent.jar
if [ ! -f "$jar" ] || [ ! -x "$java_home/bin/java" ]; then
  echo "skip  image steps: needs $jar and $java_home/bin/java"
else
  export PATH=$java_home/bin:$PATH
  app=$work/app
  java -Djarmode=tools -jar "$jar" extract --destination "$app"

  # The build stage's step for SQLite's library, with /extracted moved.
  native_step=$(awk '/^FROM /{stage++} stage==1' "$dockerfile" |
    awk '/^RUN /{on=1} on{print} on && !/\\$/{on=0; print ""}' |
    awk 'BEGIN{RS=""} /libsqlitejdbc/' | sed -e 's/^RUN //' -e "s#/extracted#$app#g")
  expect "image steps: SQLite's library for $(uname -m)" sh -c "$native_step"
  expect "image steps: just the one library" test "$(ls "$app/native")" = libsqlitejdbc.so
  sed "s#/app/#$app/#g; s#/tmp/desk-agent-hs_err#$work/hs_err#" "$docker_dir/jvm.options" >"$app/jvm.options"
  expect "jvm.options: the JVM accepts it" java "@$app/jvm.options" -version >/dev/null 2>&1

  version=9.8.7-test
  # The final stage's RUN with its continuation lines, with the paths moved. The training's temporary files go
  # to a directory of its own, so it can be checked for leftovers.
  train_tmp=$work/train-tmp
  mkdir "$train_tmp"
  steps=$(awk '/^FROM /{stage++} stage==2' "$dockerfile" | awk '/^RUN /{on=1} on{print} on && !/\\$/{on=0}' |
    sed -e 's/^RUN //' -e "s#/app#$app#g" -e "s#/tmp/train.options#$work/train.options#g" \
      -e "s#-Dma.cds.train=true#-Dma.cds.train=true -Djava.io.tmpdir=$train_tmp#")
  expect "image steps: version, training and archive check" \
    env VERSION="$version" sh -c 'sh -c "$1" >"$2" 2>&1' _ "$steps" "$work/training.log"
  expect "image steps: the archive exists" test -s "$app/desk-agent.jsa"
  expect "training: went through to the end" grep -q 'desk-agent CDS training finished' "$work/training.log"
  expect "training: the socket, a key, an answer, a limit and the chain" grep -q 'socket, key, answer, limit and 6 audit rows' "$work/training.log"
  expect "training: a restart, and the key back from the vault" grep -q 'a restart, and the key back from the vault' "$work/training.log"
  expect "training: left nothing in its temporary directory (it checks SQLite's library itself)" test -z "$(ls -A "$train_tmp")"
  refuses "image steps: no VERSION" env -u VERSION sh -c "$steps"

  entrypoint=()
  while IFS= read -r word; do
    entrypoint+=("${word//\/app/$app}")
  done < <(sed -n 's/^ENTRYPOINT //p' "$dockerfile" | jq -r '.[]')

  mkdir "$work/data" "$work/run-tmp"
  # The image's command, with only java.io.tmpdir added before -jar, to see that SQLite writes nothing there.
  env DESK_AGENT_ADMIN_SOCKET="$work/admin.sock" DESK_AGENT_SOCKET="$work/agent.sock" DESK_AGENT_DATA_DIR="$work/data" \
    "${entrypoint[0]}" "${entrypoint[1]}" -Djava.io.tmpdir="$work/run-tmp" "${entrypoint[@]:2}" >"$work/agent.log" 2>&1 &
  agent=$!
  background+=("$agent")
  for _ in $(seq 1 200); do
    [ -S "$work/admin.sock" ] && grep -q 'ready in' "$work/agent.log" && break
    sleep 0.05
  done
  expect "entrypoint: health passes through the real socket" env DESK_AGENT_ADMIN_SOCKET="$work/admin.sock" "$docker_dir/health"
  body=$(curl -s --max-time 5 --unix-socket "$work/admin.sock" http://localhost/health)
  expect "entrypoint: it reports the image's version" test "$(jq -r .version <<<"$body")" = "$version"
  expect "entrypoint: its records are open" test "$(jq -r '.audit + " " + .usage' <<<"$body")" = "open open"
  expect "entrypoint: the manager waits for a key" test "$(jq -r .manager <<<"$body")" = no_key
  expect "entrypoint: the agent socket is open, waiting for deskd" test "$(jq -r .deskd <<<"$body")" = waiting
  expect "entrypoint: the agent socket is a socket" test -S "$work/agent.sock"
  expect "entrypoint: SQLite didn't extract itself" test -z "$(ls -A "$work/run-tmp")"
  kill -TERM "$agent"
  status=0
  wait "$agent" || status=$?
  expect "entrypoint: SIGTERM ends it as a JVM normally exits" test "$status" = 143
  expect "entrypoint: no CDS noise in the log" test -z "$(grep -E '\[(warning|error) *\]\[cds' "$work/agent.log" || true)"

  touch -d '2020-01-01' "$app/desk-agent.jar"
  expect "archive: a stale one is harmless" java "@$app/jvm.options" -Dspring.context.exit=onRefresh -jar "$app/desk-agent.jar"
  refuses "archive: a stale one fails -Xshare:on, so the build would" \
    java "@$app/jvm.options" -Xshare:on -Dspring.context.exit=onRefresh -jar "$app/desk-agent.jar"
  rm -f "$app/desk-agent.jsa"
  expect "archive: a missing one is harmless" java "@$app/jvm.options" -Dspring.context.exit=onRefresh -jar "$app/desk-agent.jar"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed, against a stub docker: no image was built"
