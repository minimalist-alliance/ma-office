#!/usr/bin/env bash
# Keeps Courier's 7-day staging soak (deskd's CourierStagingSoak, CR-4.1) running until it writes <run>/finished. From cron
# every 10 minutes; one at a time (the lock is held by the running JVM); a run that stopped (the machine restarted, the
# process was killed by the soak's own process-kill fault, a crash) resumes from its ledger on its original clock.
#
#   */10 * * * * <ma-desk>/services/deskd/e2e/courier-soak-watchdog.sh <run dir>
#
# <run dir> holds session.json (courier-soak.mjs setup), cp/ (deskd's classes, test classes and test dependencies, built
# with JDK 21 and copied here, so a later checkout never changes the running soak) and logback.xml.
set -u
RUN=${1:-$HOME/work/maia-mode/courier-soak/run}
export PATH=/usr/local/bin:/usr/bin:/bin AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
[ -f "$RUN/finished" ] && exit 0
[ -f "$RUN/session.json" ] || exit 0
[ -f "$RUN/paused" ] && exit 0
exec 9>"$RUN/soak.lock"
flock -n 9 || exit 0
echo "$(date -u +%FT%TZ) start" >> "$RUN/watchdog.log"
cd "$RUN" || exit 1
nice -n 10 java -Xmx512m -XX:+ExitOnOutOfMemoryError -Dsoak.run="$RUN" -Dlogback.configurationFile="$RUN/logback.xml" \
  -cp "$RUN/cp/test-classes:$RUN/cp/classes:$RUN/cp/deps/*" \
  com.minimalistalliance.desk.deskd.courier.relay.CourierStagingSoak "$RUN" >> "$RUN/soak.out" 2>&1
echo "$(date -u +%FT%TZ) exit $?" >> "$RUN/watchdog.log"
