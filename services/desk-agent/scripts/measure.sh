#!/usr/bin/env bash
# Measures desk-agent's startup and memory on this machine, as the image runs it but with no container: the unpacked
# jar, jvm.options as shipped (paths moved) and the AppCDS archive the Dockerfile's training makes.
#
#   services/desk-agent/scripts/measure.sh [runs] [answers]
#
# Run it under the build lock, after ../mvnw -f desk-agent/pom.xml verify (it needs the jar and the test classes):
#   flock ~/work/.build.lock nice -n 10 services/desk-agent/scripts/measure.sh
#
# Prints, per run: ready (desk-agent's own line, from the process start), wall to the health socket answering, RSS
# and CPU ticks at ready and after 5 s idle, and SIGTERM to exit. Then the answer path, from FootprintProbe: the real
# application driven through its agent socket, with the Anthropic adapter against a fake HTTP server on loopback,
# its RSS and ticks at ready, after a first answer, and after more. The load average goes with the numbers, as this
# machine is shared.
#
# With "team" as the first argument it measures task 49's many agents instead (TeamFootprintProbe, README "Footprint,
# many agents"), in a fresh JVM each repetition, and prints each line, then medians and ranges:
#   flock ~/work/.build.lock nice -n 10 services/desk-agent/scripts/measure.sh team [repetitions]
set -euo pipefail

mode=startup
if [ "${1:-}" = team ]; then
  mode=team
  shift
  reps=${1:-3}
fi
runs=${1:-8}
answers=${2:-200}
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
dockerfile=$agent_dir/Dockerfile
java_home=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
export PATH=$java_home/bin:$PATH
jar=$agent_dir/target/desk-agent.jar
[ -f "$jar" ] && [ -d "$agent_dir/target/test-classes" ] || { echo "measure: run verify first" >&2; exit 1; }
work=$(mktemp -d /tmp/agent-measure.XXXXXX)
trap 'rm -rf "$work"' EXIT

# The image's /app, built the way the Dockerfile builds it.
app=$work/app
java -Djarmode=tools -jar "$jar" extract --destination "$app"
mkdir "$app/native"
# jar rather than unzip, which not every build box has.
mkdir "$work/sqlite"
(cd "$work/sqlite" && jar xf "$app"/lib/sqlite-jdbc-*.jar "org/sqlite/native/Linux/$(uname -m)/libsqlitejdbc.so")
cp "$work/sqlite/org/sqlite/native/Linux/$(uname -m)/libsqlitejdbc.so" "$app/native/"
sed "s#/app/#$app/#g; s#/tmp/desk-agent-hs_err#$work/hs_err#" "$agent_dir/docker/jvm.options" >"$app/jvm.options"
printf 'desk.agent.version=measure\n' >"$app/desk-agent.properties"
grep -v '^-XX:SharedArchiveFile=' "$app/jvm.options" >"$work/train.options"
java "@$work/train.options" "-XX:ArchiveClassesAtExit=$app/desk-agent.jsa" -Dma.cds.train=true \
  "-Djava.io.tmpdir=$work" -jar "$app/desk-agent.jar" >"$work/train.log" 2>&1 ||
  { cat "$work/train.log"; exit 1; }
java "@$app/jvm.options" -Xshare:on -Dspring.context.exit=onRefresh -jar "$app/desk-agent.jar" >/dev/null

if [ "$mode" = team ]; then
  echo "measure team: $(java -version 2>&1 | head -1), $(uname -m), $(nproc) CPUs, uptime$(uptime | sed 's/.*up/ up/')"
  : >"$work/team.out"
  for n in $(seq 1 "$reps"); do
    for m in full small; do
      java "@$app/jvm.options" -cp "$app/desk-agent.jar:$agent_dir/target/test-classes" \
        com.minimalistalliance.desk.agent.measure.TeamFootprintProbe "$work/team-$m-$n" "$m" >"$work/probe.log" 2>&1 ||
        { grep -v '^team' "$work/probe.log" | tail -15 >&2; exit 1; }
      grep '^team' "$work/probe.log" | tee -a "$work/team.out" | sed "s/^/rep $n $m: /"
    done
    rm -rf "$work/team-full-$n" "$work/team-small-$n"
  done
  echo "measure team: median (min to max) per stage and number, $reps repetitions"
  awk '{ st = $2; sub("stage=", "", st)
         for (i = 3; i <= NF; i++) { split($i, kv, "="); k = st " " kv[1]; if (!(k in seen)) { seen[k] = 1; order[++o] = k }
           n[k]++; v[k, n[k]] = kv[2] + 0 } }
       END { for (j = 1; j <= o; j++) { k = order[j]; c = n[k]
         for (a = 1; a <= c; a++) for (b = a + 1; b <= c; b++) if (v[k, b] < v[k, a]) { t = v[k, a]; v[k, a] = v[k, b]; v[k, b] = t }
         printf "%-28s %s (%s to %s)\n", k, v[k, int((c + 1) / 2)], v[k, 1], v[k, c] } }' "$work/team.out"
  echo "measure team: uptime after$(uptime | sed 's/.*up/ up/')"
  exit 0
fi

kib() { awk -v f="$2:" '$1 == f {print int($2 / 1024)}' "/proc/$1/status"; }
ticks() { cut -d')' -f2 "/proc/$1/stat" | awk '{print $12 + $13}'; }

echo "measure: $(uname -m), $(nproc) CPUs, jsa $(du -k "$app/desk-agent.jsa" | cut -f1) KiB," \
  "load $(cut -d' ' -f1-3 /proc/loadavg)"
echo "run  ready_ms  health_ms  rss_mib  anon  file  ticks  idle_rss  idle_ticks_5s  sigterm_ms"
for n in $(seq 1 "$runs"); do
  dir=$work/run-$n
  mkdir -p "$dir/data"
  t0=$(date +%s%N)
  DESK_AGENT_DATA_DIR=$dir/data DESK_AGENT_ADMIN_SOCKET=$dir/admin.sock DESK_AGENT_SOCKET=$dir/agent.sock \
    java "@$app/jvm.options" -jar "$app/desk-agent.jar" >"$dir/log" 2>&1 &
  pid=$!
  until curl -s -o /dev/null --max-time 1 --unix-socket "$dir/admin.sock" http://localhost/health; do
    kill -0 $pid 2>/dev/null || { echo "measure: run $n exited before health answered" >&2; tail -5 "$dir/log" >&2; exit 1; }
    sleep 0.01
  done
  t1=$(date +%s%N)
  until grep -q 'ready in' "$dir/log"; do
    kill -0 $pid 2>/dev/null || { echo "measure: run $n exited before its ready line" >&2; exit 1; }
    sleep 0.01
  done
  ready=$(sed -n 's/.*desk-agent ready in \([0-9]*\) ms.*/\1/p' "$dir/log")
  rss=$(kib $pid VmRSS) anon=$(kib $pid RssAnon) file=$(kib $pid RssFile) t=$(ticks $pid)
  sleep 5
  idle_rss=$(kib $pid VmRSS) idle_ticks=$(($(ticks $pid) - t))
  s0=$(date +%s%N)
  kill -TERM $pid
  wait $pid || true
  s1=$(date +%s%N)
  printf '%-4s %-9s %-10s %-8s %-5s %-5s %-6s %-9s %-14s %s\n' "$n" "$ready" $(((t1 - t0) / 1000000)) "$rss" \
    "$anon" "$file" "$t" "$idle_rss" "$idle_ticks" $(((s1 - s0) / 1000000))
done

echo "measure: the answer path, $answers answers after the first (FootprintProbe: the agent socket, the Anthropic adapter, a fake HTTP server)"
for n in 1 2 3; do
  java "@$app/jvm.options" -cp "$app/desk-agent.jar:$agent_dir/target/test-classes" \
    com.minimalistalliance.desk.agent.measure.FootprintProbe "$work/probe-$n" "$answers" 2>&1 | grep '^probe'
done
echo "measure: load after $(cut -d' ' -f1-3 /proc/loadavg)"
