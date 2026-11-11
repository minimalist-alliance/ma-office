#!/bin/bash
# EXP-7, the part that needs root: desk-datadirs (as root at every boot) makes what goes inside a service's own folder as
# that service's user, so a link the service put there reaches nothing of root's.
#
# Run it as root in a throwaway container, never on a desk: it adds users desk (1100) and kiosk (1102) if they're missing,
# and fills /data, which must be a mount of its own and empty. From the repository's root:
#   docker run --rm --network none --tmpfs /data -v "$PWD:/src:ro" debian:trixie bash /src/selfhost/tests/root_links.sh
# With a path, it tests that desk-datadirs instead: main's from before the fix fails check 2, for example
#   git show <commit>:image/recipe/files/usr/local/lib/ma/desk-datadirs > /tmp/old-datadirs; ... root_links.sh /tmp/old-datadirs
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DD=${1:-$HERE/../../image/recipe/files/usr/local/lib/ma/desk-datadirs}
[ "$(id -u)" = 0 ] || { echo "root_links.sh: run it as root, in a throwaway container" >&2; exit 2; }
mountpoint -q /data || { echo "root_links.sh: /data must be a mount of its own (docker run --tmpfs /data)" >&2; exit 2; }
[ -z "$(ls -A /data)" ] || { echo "root_links.sh: /data must start empty" >&2; exit 2; }
for spec in desk:1100 rtc:1101 kiosk:1102 agent:1103 notebook:1105; do
  n=${spec%%:*} u=${spec##*:}
  getent group "$n" >/dev/null || groupadd -g "$u" "$n"
  id "$n" >/dev/null 2>&1 || useradd -u "$u" -g "$u" -M -d /nonexistent -s /usr/sbin/nologin "$n"
done
as() { local u=$1; shift; setpriv --reuid="$u" --regid="$u" --clear-groups "$@"; }
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
is() { # path owner:group mode name
  local got; got=$(stat -c '%U:%G %a %F' "$1" 2>/dev/null || echo missing)
  [ "$got" = "$2 $3" ] && ok "$4 ($got)" || bad "$4: $1 is '$got', want '$2 $3'"
}
run() { bash "$DD" >/tmp/root_links.out 2>&1 || bad "desk-datadirs exited $? ($(tr '\n' ' ' </tmp/root_links.out))"; }

# 1. A fresh volume gets the layout it always had.
run
is /data/browser kiosk:kiosk "750 directory" "1. /data/browser"
is /data/browser/profile kiosk:kiosk "700 directory" "1. the profile"
is /data/browser/downloads kiosk:kiosk "750 directory" "1. downloads"
is /data/browser/home kiosk:kiosk "700 directory" "1. the Browser's home"
is /data/desk/volume.json desk:desk "644 regular file" "1. deskd's copy of the volume record"
cmp -s /data/.ma-volume /data/desk/volume.json && ok "1. the copy is the record" || bad "1. volume.json isn't /data/.ma-volume"

# 2. The Browser's user swaps its own folders for links to a root directory; the next boot runs desk-datadirs again.
install -d -o root -g root -m 0755 /victim-dir /victim-dir2
as kiosk rmdir /data/browser/home /data/browser/downloads
as kiosk ln -s /victim-dir /data/browser/home
as kiosk ln -s /victim-dir2 /data/browser/downloads
run
is /victim-dir root:root "755 directory" "2. a link at /data/browser/home gives the Browser nothing"
is /victim-dir2 root:root "755 directory" "2. a link at /data/browser/downloads gives the Browser nothing"
is /data/browser/profile kiosk:kiosk "700 directory" "2. the profile still"

# 3. deskd's user puts a link where its copy of the volume record goes.
printf 'keep me\n' > /victim-file; chmod 0600 /victim-file
as desk rm -f /data/desk/volume.json
as desk ln -s /victim-file /data/desk/volume.json
run
is /victim-file root:root "600 regular file" "3. a link at volume.json leaves its target alone"
[ "$(cat /victim-file)" = "keep me" ] && ok "3. and its contents" || bad "3. /victim-file was written"
is /data/desk/volume.json desk:desk "644 regular file" "3. the copy is written again, as desk"

# 4. A Browser folder it can't fix (here root's) is said, and never fails the unit, which deskd and desk-rtc require.
as kiosk rmdir /data/browser/profile 2>/dev/null || true
rm -f /data/browser/home; install -d -o root -g root -m 0755 /data/browser/home
bash "$DD" >/tmp/root_links.out 2>&1 && ok "4. desk-datadirs still exits 0" || bad "4. desk-datadirs failed on a folder it can't fix"
grep -q 'could not make /data/browser/home as kiosk' /tmp/root_links.out && ok "4. and says which" || bad "4. no message: $(cat /tmp/root_links.out)"
is /data/browser/profile kiosk:kiosk "700 directory" "4. the others are still made"
exit $fail
