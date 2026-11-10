#!/bin/bash
# reboot-run.sh <inflight|hammer|midquit>: one of race.sh's reboot cases on the lab box, end to end: set up and reboot, wait
# for the box to come back, then judge (race.sh after-reboot). Lab only.
set -uo pipefail
L=$(cd "$(dirname "$0")" && pwd)/lab.sh
"$L" sh "bash /var/tmp/lab/race.sh reboot-$1" 2>&1 | grep -v '^$' | tail -3
sleep 25
for _ in $(seq 1 60); do "$L" sh true >/dev/null 2>&1 && break; sleep 5; done
up=$("$L" sh 'cut -d. -f1 /proc/uptime'); [ "${up:-999}" -lt 300 ] || { echo "the box didn't reboot (up ${up:-?} s)"; exit 1; }
"$L" sh 'bash /var/tmp/lab/race.sh after-reboot'
