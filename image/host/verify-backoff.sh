#!/bin/bash
# image/host/verify-backoff.sh <desk-svc binary> [extra desk-svc flags]: desk-svc's restart back-off, on the real binary (reliability audit
# S1). desk-svc is process 1 of every sandbox on a shared host and restarts its service as the unit would; this runs it as a plain
# supervisor over a job that exits at once, with a base wait of 1 s, a cap of 16 s, 4 steps and a "healthy" run of 6 s, and
# reads the job's own start times. The waits must be about 1, 2, 4, 8, 16 s; the sixth run lives 7 s (healthy), after which the
# wait must be 1 s again, not 16; and the next is 2 s. It prints BAD <what> and FAILED, and "ran to the end" last. Extra flags
# are for the mutants: `-restart-steps 0` (flat) and `-healthy-sec 1000` (never starts over) must each fail it.
# Runs as any user, about 50 s.
set -u
BIN=${1:?desk-svc binary}; shift
T=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
bad() { echo "BAD: $*"; echo FAILED; }
cat > $T/job <<'J'
#!/bin/sh
echo "$(date +%s.%N)" >> "$LOG"
[ "$(wc -l < "$LOG")" = 6 ] && sleep 7
exit 1
J
chmod +x $T/job
LOG=$T/starts "$BIN" -restart always -restart-sec 1 -restart-max-sec 16 -restart-steps 4 -healthy-sec 6 "$@" -- $T/job > $T/svc.log 2>&1 &
sleep 52
kill %1 2>/dev/null; wait 2>/dev/null
n=$(wc -l < $T/starts); echo "starts: $n"
mapfile -t S < $T/starts
w=(); for i in $(seq 1 $((n-1))); do w+=("$(awk -v a="${S[$i]}" -v b="${S[$((i-1))]}" 'BEGIN{printf "%.2f", a - b}')"); done
echo "gaps between starts: ${w[*]}"
want=(1 2 4 8 16 8 2)   # the 6th gap is the 7 s run plus the reset wait of 1 s (so 8); the 7th is the second wait in a row
for i in 0 1 2 3 4 5 6; do
  [ -n "${w[$i]:-}" ] || { bad "gap $((i+1)) was never measured (only $n starts)"; continue; }
  awk -v g="${w[$i]}" -v want="${want[$i]}" 'BEGIN{exit !(g >= want - 0.2 && g <= want + 1.2)}' || bad "gap $((i+1)) is ${w[$i]} s, expected about ${want[$i]} s"
done
grep -c "restarting in" $T/svc.log | sed 's/^/log lines naming the wait: /'
grep "restarting in" $T/svc.log | head -3
echo "ran to the end"
