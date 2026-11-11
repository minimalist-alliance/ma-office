#!/bin/bash
# EXP-8: the root wrapper (`sudo ma-selfhost`) tells ma-selfhost whether this desk's Browser has a profile, so `pair` and
# `forget` can warn, and it only looks: nothing under /data/browser is opened, listed, written or changed (ADR 0035).
# A temporary folder stands in for /data/browser/profile, and fake `id` and `setpriv` stand in for root and the drop to
# the selfhost user. Run: bash selfhost/tests/browser_profile.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WRAP="$HERE/../files/usr/local/sbin/ma-selfhost"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
P="$T/profile"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# The function alone, run against the stand-in.
sed -n '/^browser_profile()/,/^}/p' "$WRAP" > "$T/fn.sh"
[ -s "$T/fn.sh" ] || { echo "FAIL no browser_profile() in the wrapper"; exit 1; }
has() { BROWSER_PROFILE="$P" bash -c ". '$T/fn.sh'; browser_profile" && echo profile || echo none; }
check() { # name expected
  got=$(has)
  if [ "$got" = "$2" ]; then ok "$1"; else bad "$1: $got, wanted $2"; fi
}
check "no profile folder" none
mkdir -m 0700 "$P";                                            check "the empty folder desk-datadirs makes" none
mkdir "$P/Default";                                            check "Chromium's Default profile" profile
rmdir "$P/Default"; printf '{}' > "$P/Local State";            check "Chromium's Local State" profile
rm "$P/Local State"; : > "$P/Default";                         check "a file called Default is no profile" none
rm "$P/Default"

# Read-only: a profile's names, types, modes, sizes and times are the same after a look (atime aside: a stat never sets it).
mkdir -p "$P/Default/Sessions"; printf '{}' > "$P/Local State"; printf 'x' > "$P/Default/Cookies"
snap() { find "$P" -printf '%p %y %m %s %T@ %C@\n' | sort; }
before=$(snap); sleep 0.05; has > /dev/null; after=$(snap)
if [ "$before" = "$after" ]; then ok "looking changes nothing"; else bad "looking changed the profile"; fi
# And it can only look: tests of a name, nothing that opens, lists, writes or moves.
body=$(sed '1d;$d' "$T/fn.sh")
if grep -qE '(^|[^-])\b(rm|mv|cp|ln|touch|chmod|chown|mkdir|rmdir|install|truncate|tee|dd|cat|ls|find|stat|sed|grep|head|tail|python3?)\b|>|<' <<<"$body"; then
  bad "browser_profile does more than test names: $body"
else
  ok "browser_profile only tests names"
fi

# The whole wrapper: it always sets MA_SELFHOST_BROWSER itself, so what a caller passes in never counts.
grep -qx 'BROWSER_PROFILE=/data/browser/profile' "$WRAP" || { echo "FAIL the wrapper's BROWSER_PROFILE line moved"; exit 1; }
sed "s#^BROWSER_PROFILE=/data/browser/profile\$#BROWSER_PROFILE='$P'#" "$WRAP" > "$T/wrapper"
mkdir "$T/bin"
printf '#!/bin/sh\necho 0\n' > "$T/bin/id"
printf '#!/bin/sh\necho "MA_SELFHOST_BROWSER=$MA_SELFHOST_BROWSER $*"\n' > "$T/bin/setpriv"
chmod +x "$T/bin/id" "$T/bin/setpriv"
run() { env MA_SELFHOST_BROWSER="$1" PATH="$T/bin:$PATH" sh "$T/wrapper" "${@:2}"; }
wrap() { # name passed-in expected args...
  out=$(run "$2" "${@:4}")
  if grep -q "^MA_SELFHOST_BROWSER=$3 .*--reuid=selfhost.* ${*:4}\$" <<<"$out"; then ok "$1"; else bad "$1: $out"; fi
}
wrap "pair, with a profile, whatever the caller says" none profile pair --wait
wrap "forget, with a profile" "" profile forget
rm -rf "$P"
wrap "pair, with no profile, whatever the caller says" profile none pair --wait --yes
wrap "forget --yes, with no profile" profile none forget --yes
exit $fail
