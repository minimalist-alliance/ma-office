#!/usr/bin/env bash
# The local rig for the Agent tools harness (W7): a real deskd's relay, tickets and tools, the real desk-agent jar and
# the real desk-notebook, with the stand-in model, on loopback only. Prints `RIG http://127.0.0.1:<port>/<token>` when ready,
# then stays up until it gets `POST /stop` or a signal. Needs JDK 21 (JAVA_HOME or java on PATH) and Node 24.
#
#   tools/agent-harness/rig.sh [--dir DIR] [--model-url URL] [--no-build]
#
# --model-url points desk-agent at a real provider instead of the stand-in; its capped key is read from the file named by
# --key-file (never on a command line, where other processes could read it; never a member's key). Without it the
# stand-in is started from this folder's tasks, with a made-up key. --no-build reuses what the last run built.
# The rig's HTTP is loopback only, and answers only under the run's random token, which is in the URL it prints.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dir=""; model_url=""; build=1; key_file=""; model="claude-sonnet-5-5"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir=$2; shift 2 ;;
    --model-url) model_url=$2; shift 2 ;;
    --key-file) key_file=$2; shift 2 ;;
    --model) model=$2; shift 2 ;;
    --no-build) build=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
dir=${dir:-$(mktemp -d "${TMPDIR:-/tmp}/mm-harness-rig.XXXXXX")}
mkdir -p "$dir"
java=${JAVA_HOME:+$JAVA_HOME/bin/}java

if [ "$build" = 1 ]; then
  # -am: deskd and desk-agent depend on courier-parse and courier-testkit, modules of the same build.
  (cd "$repo/services" && ./mvnw -q -pl desk-agent -am package -DskipTests >&2)
  (cd "$repo/services" && ./mvnw -q -pl deskd -am test-compile dependency:build-classpath -Dmdep.includeScope=test \
      -Dmdep.outputFile=target/harness.cp >&2)
  if [ ! -f "$repo/services/notebook/dist/desk-notebook.mjs" ]; then
    (cd "$repo/services/notebook" && npm ci --silent >&2 && npm run --silent build >&2)
  fi
fi

pids=()
real=0; [ -n "$model_url" ] && real=1
# On exit: the stand-in's made-up key file, and after a real model's run desk-agent's sealed key with the key that opens it
# (agent-data), so a real key never outlives the run on disk (Security's MMH-I1).
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
  rm -f "$dir/standin.key"
  if [ "$real" = 1 ]; then rm -rf "$dir/agent-data"; fi
}
trap cleanup EXIT INT TERM

if [ -z "$model_url" ]; then
  key_file="$dir/standin.key"
  ( umask 077; printf 'sk-ant-api03-stand-in-key-0001' > "$key_file" )
  node "$here/standin/standin.mjs" --tasks "$here/capability/tasks" --port 0 --key "$(cat "$key_file")" --models "$model" \
    > "$dir/standin.out" 2>&1 &
  pids+=($!)
  for _ in $(seq 1 100); do
    model_url=$(sed -n 's/^STANDIN //p' "$dir/standin.out" | head -1)
    [ -n "$model_url" ] && break
    sleep 0.1
  done
  [ -n "$model_url" ] || { echo "the stand-in didn't start" >&2; cat "$dir/standin.out" >&2; exit 1; }
fi

cp="$repo/services/deskd/target/test-classes:$repo/services/deskd/target/classes:$(cat "$repo/services/deskd/target/harness.cp")"
"$java" -Xmx512m -cp "$cp" com.minimalistalliance.desk.deskd.agent.HarnessRig \
  --dir "$dir" --model-url "$model_url" --model "$model" --key-file "${key_file:?--key-file is needed with --model-url}" \
  --desk-agent-jar "$repo/services/desk-agent/target/desk-agent.jar" \
  --notebook-main "$repo/services/notebook/dist/desk-notebook.mjs" --node "$(command -v node)" &
pids+=($!)
wait "${pids[-1]}"
