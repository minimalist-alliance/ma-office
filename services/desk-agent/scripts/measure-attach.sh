#!/usr/bin/env bash
# Measures what attaching files costs desk-agent in memory, in the worst cases the caps allow (ADR 0049), as the image
# runs it but with no container: the unpacked jar, jvm.options as shipped (paths moved) and the trained AppCDS archive.
# The parse child JVM is started by desk-agent itself, as on a desk; the numbers include it.
#
#   services/desk-agent/scripts/measure-attach.sh [heap]
#   services/desk-agent/scripts/measure-attach.sh --timing-only [rounds]
#   services/desk-agent/scripts/measure-attach.sh --sizes [MiB ...]
#
# Run it after ../mvnw -f desk-agent/pom.xml verify (it needs the jar and the test classes). [heap] is the -Xmx to try
# (default: the one in jvm.options). Prints one AttachFootprintProbe line per scenario (docs, images, mixed, and images2, docs2: two agents at once).
#
# Then the parse sidecar against the child (ADR 0097), [rounds] each (default 10): ParseTimingProbe reads a text file, a
# 100-page PDF, a docx and an xlsx through Parsers, once with no sidecar (desk-agent's own child) and once with
# parse-standin.pl serving java @parse.options per connection, as the sandbox's desk-svc does. One parse-timing line per
# file and way, p50 / p95 / max in ms from the call to the answer. No container: on a desk the sandbox adds none per parse
# either (it's long-lived), so this is the protocol's cost against the child's. Needs perl.
#
# --sizes: the worker alone at the per-file ceiling (docs/sub-status/desk-parse-sidecar.md item 7). ParseSizeProbe writes
# a file per kind and size (default 8 12 16 18 20 MiB; SizedFixtures has what each is), and each is read once by
# java @parse.options (the sidecar's worker, -Xmx72m) with files_read's ask (CHARS, default 2000000, and PAGES, default
# 500). One parse-size line per file: the answer's first line, the exit status (3 is out of memory), the text's bytes,
# peak RSS in KiB and seconds, from GNU time. Needs /usr/bin/time.
set -euo pipefail

timing_only=
sizes_only=
rounds=10
if [ "${1:-}" = --sizes ]; then
  sizes_only=1
  shift
  sizes=${*:-8 12 16 18 20}
  heap=
elif [ "${1:-}" = --timing-only ]; then
  timing_only=1
  rounds=${2:-10}
  heap=
else
  heap=${1:-}
fi
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
java_home=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
export PATH=$java_home/bin:$PATH
jar=$agent_dir/target/desk-agent.jar
[ -f "$jar" ] && [ -d "$agent_dir/target/test-classes" ] || { echo "measure-attach: run verify first" >&2; exit 1; }
work=$(mktemp -d /tmp/agent-measure-attach.XXXXXX)
standin=
sidecar=
trap 'kill $standin $sidecar 2>/dev/null || true; rm -rf "$work"' EXIT

app=$work/app
java -Djarmode=tools -jar "$jar" extract --destination "$app"
mkdir "$app/native" "$work/sqlite"
(cd "$work/sqlite" && jar xf "$app"/lib/sqlite-jdbc-*.jar "org/sqlite/native/Linux/$(uname -m)/libsqlitejdbc.so")
cp "$work/sqlite/org/sqlite/native/Linux/$(uname -m)/libsqlitejdbc.so" "$app/native/"
sed "s#/app/#$app/#g; s#/tmp/desk-agent-hs_err#$work/hs_err#" "$agent_dir/docker/jvm.options" >"$app/jvm.options"
if [ -n "$heap" ]; then
  sed -i "s#^-Xmx[0-9]*m#-Xmx$heap#" "$app/jvm.options"
fi
printf 'desk.agent.version=measure\n' >"$app/desk-agent.properties"
if [ -z "$timing_only" ] && [ -z "$sizes_only" ]; then
  grep -v '^-XX:SharedArchiveFile=' "$app/jvm.options" >"$work/train.options"
  java "@$work/train.options" "-XX:ArchiveClassesAtExit=$app/desk-agent.jsa" -Dma.cds.train=true \
    "-Djava.io.tmpdir=$work" -jar "$app/desk-agent.jar" >"$work/train.log" 2>&1 || { cat "$work/train.log"; exit 1; }
fi

classpath="$app/desk-agent.jar:$agent_dir/target/test-classes"

if [ -n "$sizes_only" ]; then
  sed "s#/app/#$app/#g" "$agent_dir/docker/parse.options" >"$work/parse.options"
  chars=${CHARS:-2000000}
  pages=${PAGES:-500}
  # shellcheck disable=SC2086
  java -Xmx3g -cp "$classpath" com.minimalistalliance.desk.agent.measure.ParseSizeProbe "$work/files" $sizes
  echo "measure-attach: sizes, $(uname -m), $(nproc) CPUs, $(grep -h '^-Xmx' "$work/parse.options"), ask $chars chars $pages pages, load $(cut -d' ' -f1-3 /proc/loadavg)"
  for mib in $sizes; do
    for kind in text pdf-text pdf-image docx xlsx pptx; do
      file=$work/files/$kind-$mib.bin
      case $kind in pdf-*) worker=pdf ;; *) worker=$kind ;; esac
      set +e
      { printf 'parse1 %s %s %s\n' "$worker" "$chars" "$pages"; cat "$file"; } |
        /usr/bin/time -f '%M %e' -o "$work/time" java "@$work/parse.options" >"$work/out" 2>/dev/null
      status=${PIPESTATUS[1]}
      set -e
      answer=$(head -1 "$work/out" | tr ' ' :)
      answered=$(tail -n +2 "$work/out" | wc -c)
      # GNU time writes "Command exited with non-zero status N" first when it isn't 0; the numbers are the last line.
      read -r rss secs < <(tail -1 "$work/time")
      echo "parse-size kind=$kind mib=$mib bytes=$(stat -c %s "$file") exit=$status answer=${answer:-none} text_bytes=$answered rss_kib=$rss secs=$secs"
    done
  done
  echo "measure-attach: load after $(cut -d' ' -f1-3 /proc/loadavg)"
  exit 0
fi

if [ -z "$timing_only" ]; then
  java -cp "$classpath" com.minimalistalliance.desk.agent.measure.StandIn >"$work/standin.out" &
  standin=$!
  until [ -s "$work/standin.out" ]; do sleep 0.1; done
  url=$(head -1 "$work/standin.out")

  echo "measure-attach: $(uname -m), $(nproc) CPUs, $(grep -h '^-Xmx' "$app/jvm.options"), load $(cut -d' ' -f1-3 /proc/loadavg)"
  for scenario in docs images mixed images2 docs2; do
    java "@$app/jvm.options" -Djava.io.tmpdir="$work" -cp "$classpath" \
      com.minimalistalliance.desk.agent.measure.AttachFootprintProbe "$work/probe-$scenario" "$url" "$scenario" 2>&1 |
      grep -E 'probe|Exception|Terminating|OutOfMemory|Caused' | head -10
  done
  echo "measure-attach: load after $(cut -d' ' -f1-3 /proc/loadavg)"
fi

# --- the parse sidecar against the child (ADR 0097)
# The sidecar's worker: the image's parse.options with /app moved, run by the stand-in per connection.
sed "s#/app/#$app/#g" "$agent_dir/docker/parse.options" >"$work/parse.options"
mkdir -p "$work/desk-parse/sock"
perl "$agent_dir/scripts/parse-standin.pl" "$work/desk-parse/sock/parse.sock" "$(id -u)" \
  "$(command -v java)" "@$work/parse.options" 2>"$work/sidecar.log" &
sidecar=$!
until [ -S "$work/desk-parse/sock/parse.sock" ]; do sleep 0.05; done
echo "measure-attach: parse timing, $(uname -m), $(nproc) CPUs, $rounds rounds, load $(cut -d' ' -f1-3 /proc/loadavg)"
for way in child sidecar; do
  dir=$work/desk-parse
  [ "$way" = child ] && dir=$work/no-sidecar
  java -Xmx256m -cp "$classpath" com.minimalistalliance.desk.agent.measure.ParseTimingProbe "$dir" "$rounds" 2>/dev/null |
    grep '^parse-timing'
done
echo "measure-attach: load after $(cut -d' ' -f1-3 /proc/loadavg)"
