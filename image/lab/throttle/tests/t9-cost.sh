# ADR 0036 [A] section 6: desk-egress is about 15 MB and under 0.1% of a core. Read from systemd and /proc after it has run
# a while, then again over WINDOW seconds at the shipped 60 s tick.
. /var/tmp/lab/lab/throttle/tests/common.sh
WINDOW=${WINDOW:-600}
egress_conf; cmp -s /etc/ma/egress.conf /var/tmp/lab/recipe/files/etc/ma/egress.conf && [ -z "${RESTART:-}" ] || { systemctl restart desk-egress; sleep 5; }
p() { local pid; pid=$(systemctl show -p MainPID --value desk-egress)
  echo "  pid $pid: $(grep -E '^(VmRSS|VmHWM)' /proc/$pid/status | tr -s ' \t' ' ' | paste -sd' '); systemd MemoryCurrent $(( $(systemctl show -p MemoryCurrent --value desk-egress) / 1024 )) KiB, CPUUsageNSec $(systemctl show -p CPUUsageNSec --value desk-egress)"; }
echo "=== $BOX ($TYPE), $(date -u +%FT%TZ)"
up=$(awk '{print $1}' /proc/uptime); st=$(systemctl show -p ActiveEnterTimestampMonotonic --value desk-egress)
c0=$(systemctl show -p CPUUsageNSec --value desk-egress); echo "--- now (desk-egress active for $(awk -v u="$up" -v s="$st" 'BEGIN{printf "%.0f", u - s/1e6}') s)"; p
sleep "$WINDOW"
c1=$(systemctl show -p CPUUsageNSec --value desk-egress); echo "--- $WINDOW s later"; p
awk -v a="$c0" -v b="$c1" -v w="$WINDOW" 'BEGIN { printf "  CPU over the window: %.3f s, %.4f%% of one core\n", (b - a) / 1e9, 100 * (b - a) / 1e9 / w }'
