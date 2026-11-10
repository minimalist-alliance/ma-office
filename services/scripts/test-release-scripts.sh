#!/usr/bin/env bash
# Tests the release packaging without Docker, for a machine that has none. It proves the scripts' logic and the JVM
# flags, not that an image builds. Docker itself runs for the first time on the arm64 box.
#
#   services/scripts/test-release-scripts.sh
#
# - build-image.sh, package-release.sh and run, against a stub docker on PATH.
# - health, against a fake admin socket.
# - deskd.env, against the settings the Java code reads.
# - If deskd/target/deskd.jar exists: the Dockerfile's unpacking, AppCDS training and entrypoint, with this machine's
#   JDK and /app moved to a temporary directory, up to the real /health. Run ./mvnw -q verify first to include this.
#
# Needs curl, jq, python3, tar and, for the last part, JAVA_HOME or the toolchain's JDK.
set -euo pipefail

services_dir=$(cd "$(dirname "$0")/.." && pwd)
scripts=$services_dir/scripts
docker_dir=$services_dir/deskd/docker
# Short on purpose: Unix socket paths are limited to 107 bytes.
work=$(mktemp -d /tmp/deskd-rel.XXXXXX)
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

# --- the stub docker
mkdir "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
echo "$*" >>"$STUB_LOG"
case $1 in
  info) echo "${STUB_ARCH:-aarch64}" ;;
  build)
    # A context from stdin is read, as docker does, and its listing kept.
    for last; do :; done
    [ "$last" != - ] || tar -tf - >"$STUB_LOG.context"
    ;;
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

# --- build-image.sh
tag=2026.11.05-abc1234
: >"$STUB_LOG"
expect "build-image: builds" "$scripts/build-image.sh" deskd "$tag"
for arg in "--network host" "--file $services_dir/deskd/Dockerfile" "--build-arg VERSION=$tag" "--tag ma/deskd:$tag" "$services_dir"; do
  expect "build-image: passes $arg" logged "$arg"
done
refuses "build-image: an x86 daemon" env STUB_ARCH=x86_64 "$scripts/build-image.sh" deskd "$tag"
refuses "build-image: a bad tag" "$scripts/build-image.sh" deskd 'a b'
refuses "build-image: a tag starting with a dot" "$scripts/build-image.sh" deskd .x
refuses "build-image: an unknown service" "$scripts/build-image.sh" no-such-service "$tag"
refuses "build-image: missing arguments" "$scripts/build-image.sh" deskd

# --- package-release.sh
out=$work/out
expect "package-release: packages" "$scripts/package-release.sh" deskd "$tag" "$out"
tgz=$out/deskd-$tag.tgz
expect "package-release: tgz and sha256 only" test "$(ls -A "$out" | tr '\n' ' ')" = "deskd-$tag.tgz deskd-$tag.tgz.sha256 "
expect "package-release: exactly the section 6 contents" test \
  "$(tar -tzf "$tgz" | LC_ALL=C sort | tr '\n' ' ')" = "VERSION deskd.env health image.tar run "
expect "package-release: the checksum verifies" bash -c "cd '$out' && sha256sum --check --quiet deskd-$tag.tgz.sha256"
expect "package-release: Platform's rule for the hash" grep -qE "^[0-9a-f]{64}  deskd-$tag\.tgz$" "$tgz.sha256"
mkdir "$work/unpacked"
tar -xzf "$tgz" -C "$work/unpacked"
expect "package-release: VERSION holds the tag" test "$(cat "$work/unpacked/VERSION")" = "$tag"
expect "package-release: run is executable" test -x "$work/unpacked/run"
expect "package-release: health is executable" test -x "$work/unpacked/health"
expect "package-release: saved the right image" grep -q "^save -o .*/image.tar ma/deskd:$tag$" "$STUB_LOG"
expect "package-release: owned by root" test -z "$(tar --numeric-owner -tvzf "$tgz" | awk '$2 != "0/0"')"
refuses "package-release: no such image" env STUB_NO_IMAGE=1 "$scripts/package-release.sh" deskd "$tag" "$work/out2"
expect "package-release: leaves nothing without an image" test -z "$(ls -A "$work/out2" 2>/dev/null)"
refuses "package-release: docker save fails" env STUB_SAVE_FAILS=1 "$scripts/package-release.sh" deskd "$tag" "$work/out3"
expect "package-release: leaves nothing if save fails" test -z "$(ls -A "$work/out3")"
refuses "package-release: a bad tag" "$scripts/package-release.sh" deskd '../x' "$work/out4"

# --- notebook, whose component is desk-notebook and whose context includes web/notebook/src/model
: >"$STUB_LOG"
expect "notebook: builds" "$scripts/build-image.sh" notebook "$tag"
for arg in "--network host" "--file services/notebook/Dockerfile" "--build-arg VERSION=$tag" "--tag ma/desk-notebook:$tag" "-"; do
  expect "notebook: passes $arg" logged "$arg"
done
expect "notebook: builds on x86 too" env STUB_ARCH=x86_64 "$scripts/build-image.sh" notebook "$tag"
expect "notebook: its context has the service" grep -q '^services/notebook/Dockerfile$' "$STUB_LOG.context"
expect "notebook: its context has the model" grep -q '^web/notebook/src/model/derive.ts$' "$STUB_LOG.context"
expect "notebook: its context has no node_modules" test -z "$(grep -E 'node_modules|/dist/' "$STUB_LOG.context" || true)"
expect "notebook: its context has nothing else" test -z "$(grep -vE '^(services/notebook|web/|web/notebook|web/notebook/src|web/notebook/src/model|services)(/|$)' "$STUB_LOG.context" || true)"
out_nb=$work/out-nb
expect "notebook: packages" "$scripts/package-release.sh" notebook "$tag" "$out_nb"
expect "notebook: named by its component" test "$(ls -A "$out_nb" | tr '\n' ' ')" = "desk-notebook-$tag.tgz desk-notebook-$tag.tgz.sha256 "
expect "notebook: exactly the section 6 contents" test \
  "$(tar -tzf "$out_nb/desk-notebook-$tag.tgz" | LC_ALL=C sort | tr '\n' ' ')" = "VERSION desk-notebook.env health image.tar run "
expect "notebook: saved the right image" grep -q "^save -o .*/image.tar ma/desk-notebook:$tag$" "$STUB_LOG"
mkdir "$work/unpacked-nb"
tar -xzf "$out_nb/desk-notebook-$tag.tgz" -C "$work/unpacked-nb"
echo sha256:0123456789abcdef >"$work/unpacked-nb/image-id"
: >"$STUB_LOG"
expect "notebook: run starts docker" env RELEASE_DIR="$work/unpacked-nb" "$work/unpacked-nb/run"
for arg in "--network none" "--user 1105:1105" "--read-only" "--tmpfs /tmp" "--cap-drop=ALL" "--security-opt=no-new-privileges" \
  "--memory=320m" "--memory-swap=320m" "--cpu-shares=256" "--pids-limit=64" "--stop-timeout=30" "--ulimit core=0" \
  "--log-driver=journald" "--log-opt tag=desk-notebook" "-v /run/desk-notebook:/run/desk-notebook" "-v /data/notebook:/data/notebook" \
  "--env-file $work/unpacked-nb/desk-notebook.env" "--max-old-space-size=192"; do
  expect "notebook: run passes $arg" logged "$arg"
done
expect "notebook: desk-notebook.env is all commented out" test -z "$(grep -vE '^(#|$)' "$services_dir/notebook/docker/desk-notebook.env" || true)"

# --- run, against the flags in the runtime spec
export DESKD_IMDS_URL=http://127.0.0.1:9
spec=$services_dir/../docs/interfaces/desk-runtime.md
release=$work/unpacked
image_id=sha256:0123456789abcdef
echo "$image_id" >"$release/image-id"
: >"$STUB_LOG"
expect "run: starts docker" env RELEASE_DIR="$release" "$release/run"
expect "run: the image comes last" test "$(tail -n 1 "$STUB_LOG" | awk '{print $NF}')" = "$image_id"
expect "run: the env file" logged "--env-file $release/deskd.env"
if [ -f "$spec" ]; then
  flags=$(sed -n '/^exec docker run/,/image-id/p' "$spec" | tr -s ' \\' '\n' | grep -vE '^(exec|docker|run|"\$.*|.*image-id.*\)")?$' | sed '/^$/d')
  [ -n "$flags" ] || fail "run: found the flags in the spec"
  for flag in $flags; do
    expect "run: spec flag $flag" logged "$flag"
  done
else
  echo "skip  run: no runtime spec at $spec"
fi
# Hello's imageVersion is the AMI's release, which only the host knows.
printf 'version=2026.11.05-1\nbuilt=2026-11-05T00:00:00Z\n' >"$work/ma-release"
: >"$STUB_LOG"
expect "run: with the AMI's release file" env MA_RELEASE_FILE="$work/ma-release" RELEASE_DIR="$release" "$release/run"
expect "run: passes its version" logged "-e DESKD_IMAGE_VERSION=2026.11.05-1"
expect "run: and the image still comes last" test "$(tail -n 1 "$STUB_LOG" | awk '{print $NF}')" = "$image_id"
expect "run: and only the version" test "$(grep -c built "$STUB_LOG")" = 0
: >"$STUB_LOG"
expect "run: with no release file" env MA_RELEASE_FILE="$work/none" RELEASE_DIR="$release" "$release/run"
expect "run: passes no version, so hello sends null" test "$(grep -c DESKD_IMAGE_VERSION "$STUB_LOG")" = 0
# A guild desk has its own memory: its kind comes from the IMDS tag (a stand-in here), or MA_DESK_KIND.
: >"$STUB_LOG"
expect "run: kind guild" env MA_DESK_KIND=guild RELEASE_DIR="$release" "$release/run"
for arg in "--memory=400m" "--memory-swap=400m" "--entrypoint java" "@/app/jvm.options @/app/heap-guild.options -jar /app/deskd.jar"; do
  expect "run: guild passes $arg" logged "$arg"
done
expect "run: guild's command follows the image" test "$(tail -n 1 "$STUB_LOG" | awk '{print $(NF-4)}')" = "$image_id"
expect "run: guild's heap file is in the image's context" grep -q '^-Xmx168m$' "$services_dir/deskd/docker/heap-guild.options"
for kind in personal work test; do
  : >"$STUB_LOG"
  expect "run: kind $kind keeps 512m" env MA_DESK_KIND=$kind RELEASE_DIR="$release" "$release/run"
  expect "run: $kind has the image's own entrypoint" test "$(grep -c -e '--entrypoint' "$STUB_LOG")" = 0
  expect "run: $kind's image comes last" test "$(tail -n 1 "$STUB_LOG" | awk '{print $NF}')" = "$image_id"
  expect "run: $kind memory" logged "--memory=512m --memory-swap=512m"
done
# GDS-5: the image's /run/ma/desk-kind file (guild or member) is mounted read-only into the container only when it exists.
printf 'guild\n' >"$work/desk-kind"
: >"$STUB_LOG"
expect "run: kind from the file" env MA_DESK_KIND_FILE="$work/desk-kind" DESKD_IMDS_URL=http://127.0.0.1:1 RELEASE_DIR="$release" "$release/run"
expect "run: the file says guild" logged "--memory=400m"
expect "run: the file is mounted read-only" logged "--mount type=bind,src=$work/desk-kind,dst=/run/ma/desk-kind,readonly"
: >"$STUB_LOG"
printf 'member\n' >"$work/desk-kind"
: >"$STUB_LOG"
expect "run: member file keeps 512m" env MA_DESK_KIND_FILE="$work/desk-kind" DESKD_IMDS_URL=http://127.0.0.1:1 RELEASE_DIR="$release" "$release/run"
expect "run: member memory" logged "--memory=512m --memory-swap=512m"
expect "run: member has the image's entrypoint" test "$(grep -c -e '--entrypoint' "$STUB_LOG")" = 0
expect "run: member file is mounted too" logged "--mount type=bind,src=$work/desk-kind,dst=/run/ma/desk-kind,readonly"
: >"$STUB_LOG"
expect "run: no file, no mount" env MA_DESK_KIND_FILE="$work/none" MA_DESK_KIND=personal RELEASE_DIR="$release" "$release/run"
expect "run: and no mount flag" test "$(grep -c -e '--mount' "$STUB_LOG")" = 0
# From the IMDS tag, with IMDSv2's token.
cat >"$work/imds.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_PUT(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"tok")
    def do_GET(self):
        if self.headers.get("X-aws-ec2-metadata-token") != "tok" or not self.path.endswith("/tags/instance/DeskKind"):
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.end_headers(); self.wfile.write(sys.argv[2].encode())
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 "$work/imds.py" 18769 guild & imds_pid=$!
sleep 1
: >"$STUB_LOG"
expect "run: guild from the IMDS tag" env DESKD_IMDS_URL=http://127.0.0.1:18769 RELEASE_DIR="$release" "$release/run"
expect "run: the tag gave 400m" logged "--memory=400m --memory-swap=400m"
kill "$imds_pid"
: >"$STUB_LOG"
expect "run: an unreachable IMDS keeps 512m" env DESKD_IMDS_URL=http://127.0.0.1:18769 RELEASE_DIR="$release" "$release/run"
expect "run: and then 512m" logged "--memory=512m --memory-swap=512m"
refuses "run: passes on docker's exit status" env STUB_RUN_EXIT=3 RELEASE_DIR="$release" "$release/run"
refuses "run: no RELEASE_DIR" env -u RELEASE_DIR "$release/run"
: >"$STUB_LOG"
rm "$release/image-id"
refuses "run: no image-id" env RELEASE_DIR="$release" "$release/run"
expect "run: without image-id, docker isn't called" test ! -s "$STUB_LOG"

# --- health, against a fake admin socket
fake_admin() { # fake_admin <socket> <status>
  python3 -I -c '
import os, socket, sys
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
expect "health: 200 is healthy" env DESKD_ADMIN_SOCKET="$work/ok.sock" "$docker_dir/health"
refuses "health: 503 isn't" env DESKD_ADMIN_SOCKET="$work/bad.sock" "$docker_dir/health"
refuses "health: no socket isn't" env DESKD_ADMIN_SOCKET="$work/absent.sock" "$docker_dir/health"

# --- deskd.env
expect "deskd.env: everything is commented out" test -z "$(grep -vE '^(#|$)' "$docker_dir/deskd.env" || true)"
read_keys=$(grep -rhoE 'getProperty\("deskd\.[a-z.]+"' "$services_dir/deskd/src/main/java" |
  sed -E 's/getProperty\("//; s/"//; s/\./_/g' | tr 'a-z' 'A-Z' | sort -u)
[ -n "$read_keys" ] || fail "deskd.env: found the keys the code reads"
for key in $read_keys; do
  expect "deskd.env: lists $key" grep -q "^#$key=" "$docker_dir/deskd.env"
done

# --- the Dockerfile's steps, with a real JVM
jar=$services_dir/deskd/target/deskd.jar
if [ ! -f "$jar" ] || [ ! -x "$java_home/bin/java" ]; then
  echo "skip  image steps: needs $jar and $java_home/bin/java"
else
  export PATH=$java_home/bin:$PATH
  app=$work/app
  java -Djarmode=tools -jar "$jar" extract --destination "$app"
  sed "s#/app/#$app/#g" "$docker_dir/jvm.options" >"$app/jvm.options"
  # The Dockerfile COPYs it beside jvm.options and its RUN chmods it.
  cp "$docker_dir/heap-guild.options" "$app/heap-guild.options"
  expect "jvm.options: the JVM accepts it" java "@$app/jvm.options" -version >/dev/null 2>&1

  dockerfile=$services_dir/deskd/Dockerfile
  version=9.8.7-test
  # The final stage's RUN with its continuation lines, with the paths moved.
  steps=$(awk '/^FROM /{stage++} stage==2' "$dockerfile" | awk '/^RUN /{on=1} on{print} on && !/\\$/{on=0}' |
    sed -e 's/^RUN //' -e "s#/app#$app#g" -e "s#/tmp/train.options#$work/train.options#g")
  training_tmp=$work/before-training
  : >"$training_tmp"
  expect "image steps: version, training and archive check" \
    env VERSION="$version" sh -c 'sh -c "$1" >"$2" 2>&1' _ "$steps" "$work/training.log"
  expect "image steps: the archive exists" test -s "$app/deskd.jsa"
  expect "training: went through to the end" grep -q 'deskd CDS training finished' "$work/training.log"
  expect "training: ran a whole session" grep -q 'session timing first=true result=ok' "$work/training.log"
  expect "training: and the Browser" grep -q 'chromium connected' "$work/training.log"
  expect "training: left nothing in /tmp" test -z "$(find /tmp -maxdepth 1 -name 'deskd-train*' -newer "$training_tmp")"
  # What turns it on is a JVM system property on the training's command line, so nothing a desk runs can set it.
  refuses "training: nothing a desk runs names its property" grep -q 'ma\.cds\.train' \
    "$docker_dir/jvm.options" "$docker_dir/deskd.env" "$docker_dir/run" "$docker_dir/health"
  refuses "training: nor does the entrypoint" grep -q '^ENTRYPOINT.*ma\.cds\.train' "$dockerfile"
  refuses "training: and no setting is read for it" grep -rq 'getProperty("ma\.cds\.train' "$services_dir/deskd/src/main/java"
  refuses "image steps: no VERSION" env -u VERSION sh -c "$steps"

  entrypoint=()
  while IFS= read -r word; do
    entrypoint+=("${word//\/app/$app}")
  done < <(sed -n 's/^ENTRYPOINT //p' "$dockerfile" | jq -r '.[]')

  # No desk-rtc, no IMDS and no Platform, so deskd comes up with its links down, as the spec wants.
  mkdir "$work/data"
  env DESKD_ADMIN_SOCKET="$work/admin.sock" DESKD_RTC_SOCKET="$work/no-rtc.sock" DESKD_DATA_DIR="$work/data" \
    DESKD_IMDS_URL=http://127.0.0.1:9 "${entrypoint[@]}" >"$work/deskd.log" 2>&1 &
  deskd=$!
  background+=("$deskd")
  for _ in $(seq 1 200); do
    [ -S "$work/admin.sock" ] && break
    sleep 0.05
  done
  expect "entrypoint: health passes through the real socket" env DESKD_ADMIN_SOCKET="$work/admin.sock" "$docker_dir/health"
  body=$(curl -s --max-time 5 --unix-socket "$work/admin.sock" http://localhost/health)
  expect "entrypoint: deskd reports the image's version" test "$(jq -r .version <<<"$body")" = "$version"
  expect "entrypoint: its links are reported down" test "$(jq -r .rtc <<<"$body")" = disconnected
  kill -TERM "$deskd"
  status=0
  wait "$deskd" || status=$?
  expect "entrypoint: SIGTERM ends it as a JVM normally exits" test "$status" = 143
  expect "entrypoint: no CDS noise in the log" test -z "$(grep -E '\[(warning|error) *\]\[cds' "$work/deskd.log" || true)"

  touch -d '2020-01-01' "$app/deskd.jar"
  expect "archive: a stale one is harmless" java "@$app/jvm.options" -Dspring.context.exit=onRefresh -jar "$app/deskd.jar"
  refuses "archive: a stale one fails -Xshare:on, so the build would" \
    java "@$app/jvm.options" -Xshare:on -Dspring.context.exit=onRefresh -jar "$app/deskd.jar"
  rm -f "$app/deskd.jsa"
  expect "archive: a missing one is harmless" java "@$app/jvm.options" -Dspring.context.exit=onRefresh -jar "$app/deskd.jar"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed, against a stub docker: no image was built"
