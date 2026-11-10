#!/bin/bash
# `ma-selfhost boot-note` (the root wrapper) says plainly that another copy of the desk is online, only when deskd's
# latest hello was refused with boot_in_use. A fake journalctl stands in. Run: bash selfhost/tests/boot_note.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WRAP="$HERE/../files/usr/local/sbin/ma-selfhost"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
printf '#!/bin/sh\ncat "%s/journal"\n' "$T" > "$T/bin/journalctl"; chmod +x "$T/bin/journalctl"
# The wrapper insists on root; run its function only.
sed -n '/^boot_in_use_note()/,/^}/p' "$WRAP" > "$T/fn.sh"
run() { PATH="$T/bin:$PATH" bash -c ". $T/fn.sh; boot_in_use_note"; }
fail=0
check() { # name expected-substring-or-empty
  out=$(run)
  if [ -z "$2" ] && [ -n "$out" ]; then echo "FAIL $1: said '$out'"; fail=1
  elif [ -n "$2" ] && ! grep -q "$2" <<<"$out"; then echo "FAIL $1: '$out'"; fail=1
  else echo "ok   $1"; fi
}
printf 'hello refused: HTTP 409 boot_in_use\n' > "$T/journal";                          check refused "already running somewhere else"
printf 'hello refused: HTTP 409 boot_in_use\nhello accepted, reason boot\n' > "$T/journal"; check "then accepted" ""
printf 'hello accepted, reason boot\nhello refused: HTTP 409 boot_in_use\n' > "$T/journal"; check "accepted then refused" "wait about 3 minutes"
printf 'hello refused: HTTP 503 unavailable\n' > "$T/journal";                          check "another refusal" ""
: > "$T/journal";                                                                      check "empty" ""
grep -q '!' <<<"$(printf 'hello refused: HTTP 409 boot_in_use\n' > "$T/journal"; run)" && { echo "FAIL exclamation"; fail=1; }
exit $fail
