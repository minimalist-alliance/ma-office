#!/bin/bash
# Installs desk-data, the read-only root helper behind deskd's data.* methods (README.md), on a desk that has
# the desk's users and /run/desk already: a self-hosted desk (task 31), or a box the System Engineer is trying it on.
# The image adopts these files through image/recipe instead. Idempotent: run it again after an update.
#   sudo ./install.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run it as root: sudo $0"
[ "$(id -u desk 2>/dev/null || true)" = 1100 ] || die "the user desk must exist with uid 1100 (desk-runtime.md section 1)"
[ -x /usr/bin/python3 ] || die "/usr/bin/python3 is missing"
/usr/bin/python3 -I -c 'import sqlite3, sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "/usr/bin/python3 must be 3.11 or newer, with sqlite3"
[ -d /data ] || die "/data doesn't exist: install the desk itself first"
[ -d /run/desk ] || die "/run/desk doesn't exist: install the desk itself first"
command -v systemctl >/dev/null || die "systemd is required"

changed_units=0
put() {   # put <source> <destination> <mode>
  if [ -f "$2" ] && cmp -s "$HERE/$1" "$2" && [ "$(stat -c '%a %u %g' "$2")" = "${3#0} 0 0" ]; then
    echo "unchanged  $2"
    return 1
  fi
  install -D -o root -g root -m "$3" "$HERE/$1" "$2" || die "couldn't install $2"
  echo "installed  $2"
}

put desk-data            /usr/local/lib/ma/desk-data            0755 || true
put desk-data.socket     /etc/systemd/system/desk-data.socket   0644 && changed_units=1 || true
put desk-data@.service   /etc/systemd/system/desk-data@.service 0644 && changed_units=1 || true
put desk-data.tmpfiles   /etc/tmpfiles.d/desk-data.conf         0644 || true

systemd-tmpfiles --create /etc/tmpfiles.d/desk-data.conf
echo "made       /data/.ma-export-tmp ($(stat -c '%a %U' /data/.ma-export-tmp))"

systemctl daemon-reload
echo "ran        systemctl daemon-reload"
if [ "$changed_units" = 1 ] && systemctl -q is-active desk-data.socket; then
  systemctl restart desk-data.socket   # connections in progress keep running; new ones get the new units
  echo "restarted  desk-data.socket"
fi
systemctl enable --now desk-data.socket >/dev/null 2>&1 || die "couldn't enable desk-data.socket"
echo "enabled    desk-data.socket ($(systemctl is-active desk-data.socket), listening on /run/desk/data.sock)"
