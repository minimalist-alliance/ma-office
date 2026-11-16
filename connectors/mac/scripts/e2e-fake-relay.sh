#!/bin/sh
# The Swift connector and deskd's connector path, checked against each other through the test kit's fake relay:
#   - deskd's MacHarnessE2ETest on a Java build box (the fake relay on 127.0.0.1:$PORT there, the real connector path, Courier's
#     store), run with -Dma.mac.e2e.port;
#   - connector-harness on the build Mac (the real bridge, a synthetic Messages database, a fake Messages);
#   - two SSH tunnels through this machine, so the Mac's 127.0.0.1:$PORT is the Java box's.
# Run from a ma-desk checkout: MAC_HOST=user@mac JAVA_HOST=user@box connectors/mac/scripts/e2e-fake-relay.sh. Nothing here reads
# or sends a real message.
set -eu
PORT="${PORT:-18555}"
MAC="${MAC_HOST:?set MAC_HOST to the build Mac (user@host)}"
MAC_DIR="${MAC_DIR:-ma-build/mac-connector}"
JBOX="${JAVA_HOST:?set JAVA_HOST to the Java build box (user@host)}"
JDIR="${JAVA_DIR:-ma-work/mac-connector/ma-desk}"
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$(mktemp -d)/e2e"
mkdir -p "$LOG"

echo "== copying to the Java box and the Mac"
ssh -o BatchMode=yes "$JBOX" "mkdir -p ~/$JDIR"
rsync -a --delete --exclude node_modules --exclude target --exclude .git --exclude 'connectors/mac/.build' --exclude 'web/dist' --exclude 'web/test-results' \
  "$HERE/" "$JBOX:$JDIR/"
ssh -o BatchMode=yes "$MAC" "mkdir -p ~/$MAC_DIR"
rsync -a --delete --exclude .build --exclude dist "$HERE/connectors/mac/" "$MAC:$MAC_DIR/"
ssh -o BatchMode=yes "$MAC" "cd ~/$MAC_DIR && swift build --product connector-harness 2>&1 | tail -1"

echo "== the desk (MacHarnessE2ETest) on the Java box"
ssh -o BatchMode=yes "$JBOX" "source ~/ma-tools.env && cd ~/$JDIR/services && nice -n 10 ./mvnw -o -pl deskd -am test \
  -Dtest=MacHarnessE2ETest -Dsurefire.failIfNoSpecifiedTests=false -Dma.mac.e2e.port=$PORT -Dma.mac.e2e.out=/tmp/mac-e2e-$PORT.json" \
  >"$LOG/desk.log" 2>&1 &
DESK=$!
i=0
until grep -q "MAC-E2E ready" "$LOG/desk.log" 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 600 ] && { echo "the desk didn't start"; tail -30 "$LOG/desk.log"; exit 1; }
  sleep 1
done

echo "== tunnels"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "$PORT:127.0.0.1:$PORT" "$JBOX" &
T1=$!
sleep 2
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -R "$PORT:127.0.0.1:$PORT" "$MAC" &
T2=$!
cleanup() { kill $T1 $T2 2>/dev/null || true; }
trap cleanup EXIT
sleep 2

H="~/$MAC_DIR/.build/debug/connector-harness ~/ma-build/e2e-home"
echo "== the Mac: a synthetic Messages database, then pairing"
ssh -o BatchMode=yes "$MAC" "rm -rf ~/ma-build/e2e-home && $H fixture"
ssh -o BatchMode=yes "$MAC" "$H pair http://127.0.0.1:$PORT"
echo "== the Mac: the bridge runs (backfill, the reply, then the removal)"
ssh -o BatchMode=yes "$MAC" "$H run http://127.0.0.1:$PORT 150"
ssh -o BatchMode=yes "$MAC" "$H state; $H sent"
wait $DESK || true
echo "== the desk's results"
ssh -o BatchMode=yes "$JBOX" "cat /tmp/mac-e2e-$PORT.json; echo; rm -f /tmp/mac-e2e-$PORT.json"
grep -E "Tests run:|FAIL|MAC-E2E" "$LOG/desk.log" | tail -8
ssh -o BatchMode=yes "$MAC" "rm -rf ~/ma-build/e2e-home"
