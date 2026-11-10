#!/bin/bash
# mutations.sh: shows each part of verify-batch.sh can fail. For each break: put it in, run the part, expect FAILED, take it
# out. Then every part once more, unbroken. As root on the lab box, from /var/tmp/lab, after apply.sh. Lab only.
set -u
V=/var/tmp/lab/verify-batch.sh DB=/usr/local/lib/ma/desk-batch MU=/opt/ma/bin/ma-update
SOCK_DROP=/etc/systemd/system/desk-batch.socket.d
caught=0 missed=0
# patch <file> <python old> <python new>: replaces exactly one occurrence, keeping a copy to put back
patch() {
  cp -p "$1" "$1.mut-orig"
  python3 -I - "$1" "$2" "$3" <<'P' || { echo "PATCH DIDN'T APPLY: $1"; exit 1; }
import sys
f, a, b = sys.argv[1:]
s = open(f).read()
if s.count(a) != 1:
    sys.exit(1)
open(f, "w").write(s.replace(a, b))
P
}
unpatch() { mv "$1.mut-orig" "$1"; }
mut() { # mut <name> <part> <break> <restore>; MUT=<regex> runs only the breaks whose name matches
  local out
  [ "${ONLY_UNBROKEN:-0}" = 1 ] && return 0
  [ -z "${MUT:-}" ] || echo "$1" | grep -qE "$MUT" || return 0
  eval "$3"
  out=$(bash "$V" "$2" 2>&1)
  eval "$4"
  if echo "$out" | grep -q '^FAILED$'; then caught=$((caught + 1)); echo "CAUGHT  $1 ($2): $(echo "$out" | grep '^BAD' | head -2 | tr '\n' ' ')"
  else missed=$((missed + 1)); echo "MISSED  $1 ($2)"; echo "$out" | sed 's/^/    /' | tail -5; fi
}
sock_mode() { mkdir -p $SOCK_DROP; printf '[Socket]\nSocketMode=%s\n' "$1" > $SOCK_DROP/mut.conf; systemctl daemon-reload; systemctl restart desk-batch.socket; }
sock_back() { rm -rf $SOCK_DROP; systemctl daemon-reload; systemctl restart desk-batch.socket; }

mut "timer not enabled" install "systemctl disable --quiet desk-batch.timer" "systemctl enable --quiet desk-batch.timer"
mut "socket 0666" install "sock_mode 0666" "sock_back"
mut "a key in the image's directory" install "cp /etc/ssl/certs/ssl-cert-snakeoil.pem /opt/ma/etc/batch-keys/x.pem 2>/dev/null || touch /opt/ma/etc/batch-keys/x.pem" "rm -f /opt/ma/etc/batch-keys/x.pem"
mut "apt-daily.timer unmasked and started" apt "systemctl unmask --quiet apt-daily.timer; systemctl start apt-daily.timer" "systemctl stop apt-daily.timer; systemctl mask --quiet apt-daily.timer"
mut "Debian's default origins kept" apt "patch /etc/apt/apt.conf.d/51ma-unattended '#clear Unattended-Upgrade::Origins-Pattern;' '// not cleared'" "unpatch /etc/apt/apt.conf.d/51ma-unattended"
mut "no key means any key" closed "patch $DB '        raise Refused(\"untrusted\", \"no trusted key: every batch is refused until one is installed\")' '        return \"none\"'" "unpatch $DB"
mut "any uid on a 0666 socket" socket "sock_mode 0666; patch $DB 'if uid not in (DESKD_UID, 0):' 'if False:'" "unpatch $DB; sock_back"
mut "a seq below the pending one taken" socket "patch $DB 'if p and m[\"seq\"] < p[\"seq\"]:' 'if False:'" "unpatch $DB"
mut "the applied seq taken again" idle "patch $DB 'if m[\"seq\"] <= floor:' 'if m[\"seq\"] < 0:'" "unpatch $DB"
mut "a stale idle.json counts" idle "patch $DB 'IDLE_FRESH_S = 60 ' 'IDLE_FRESH_S = 10 ** 9 '" "unpatch $DB"
mut "anyone's idle.json counts" idle "patch $DB 'read_limited(IDLE_FILE, MAX_IDLE, owner=IDLE_UID)' 'read_limited(IDLE_FILE, MAX_IDLE)'" "unpatch $DB"
mut "a session doesn't count" idle "patch $DB 'counts[\"sessions\"] == counts[\"agentTasks\"] == counts[\"exports\"] == 0 and now' 'counts[\"agentTasks\"] == counts[\"exports\"] == 0 and now'" "unpatch $DB"
mut "prepare switches current" prepare "patch $MU '  set_link prepared \"\$rel\"
  prune_images' '  set_link prepared \"\$rel\"; set_link current \"\$rel\"
  prune_images'" "unpatch $MU"
mut "prepare loads no image" prepare "patch $MU '  load_image
  place \"\$sha\"
  [ -z \"\$old_prep\" ]' '  rm -f \"\$tmp/x/image.tar\"
  place \"\$sha\"
  [ -z \"\$old_prep\" ]'" "unpatch $MU"
mut "no rollback of what was switched" rollback "patch $DB '    for name in reversed(switched):
        if release_info' '    for name in []:
        if release_info'" "unpatch $DB"
mut "apt whether idle or not" apt-idle "patch $DB '    if idle:
        return \"idle\"' '    if True:
        return \"idle\"'" "unpatch $DB"
mut "apt at normal priority" apt-idle "patch $DB 'LOW = [\"/usr/bin/nice\", \"-n\", \"19\", \"/usr/bin/ionice\", \"-c3\"]' 'LOW = []'" "unpatch $DB"

[ "${ONLY_UNBROKEN:-0}" = 1 ] && { caught=0; missed=0; echo "(the breaks above were skipped: ONLY_UNBROKEN=1)"; }
echo; echo "unbroken:"
for p in install apt closed socket idle prepare rollback apt-idle; do
  out=$(bash "$V" "$p" 2>&1)
  if echo "$out" | grep -q '^FAILED$' || ! echo "$out" | grep -q '^ran to the end$'; then echo "FAIL  $p"; echo "$out" | grep -v '^smoke-test' | sed 's/^/    /' | tail -6; missed=$((missed + 1)); else echo "PASS  $p"; fi
done
echo; echo "mutations caught: $caught, missed or unbroken failures: $missed"
[ "$missed" = 0 ]
