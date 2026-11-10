#!/usr/bin/env bash
# Measures what attaching files costs desk-agent in memory, in the worst cases the caps allow (ADR 0049), as the image
# runs it but with no container: the unpacked jar, jvm.options as shipped (paths moved) and the trained AppCDS archive.
# The parse child JVM is started by desk-agent itself, as on a desk; the numbers include it.
#
#   services/desk-agent/scripts/measure-attach.sh [heap]
#
# Run it after ../mvnw -f desk-agent/pom.xml verify (it needs the jar and the test classes). [heap] is the -Xmx to try
# (default: the one in jvm.options). Prints one AttachFootprintProbe line per scenario (docs, images, mixed, and images2, docs2: two agents at once).
set -euo pipefail

heap=${1:-}
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
java_home=${JAVA_HOME:-$HOME/.local/share/ma-desk-toolchain/jdk-21}
export PATH=$java_home/bin:$PATH
jar=$agent_dir/target/desk-agent.jar
[ -f "$jar" ] && [ -d "$agent_dir/target/test-classes" ] || { echo "measure-attach: run verify first" >&2; exit 1; }
work=$(mktemp -d /tmp/agent-measure-attach.XXXXXX)
trap 'kill $standin 2>/dev/null || true; rm -rf "$work"' EXIT

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
grep -v '^-XX:SharedArchiveFile=' "$app/jvm.options" >"$work/train.options"
java "@$work/train.options" "-XX:ArchiveClassesAtExit=$app/desk-agent.jsa" -Dma.cds.train=true \
  "-Djava.io.tmpdir=$work" -jar "$app/desk-agent.jar" >"$work/train.log" 2>&1 || { cat "$work/train.log"; exit 1; }

classpath="$app/desk-agent.jar:$agent_dir/target/test-classes"
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
