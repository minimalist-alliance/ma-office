#!/bin/bash
# apply.sh old|new: the freeze recipe on a lab box from ma-desk-0.2.9, as root from /var/tmp/lab (lab.sh push-recipe).
# old: main's files before T46L-1's fix (freeze.md's lab box had these). new: this branch's. Lab only.
set -euo pipefail
case "${1:-}" in old) F=/var/tmp/lab/old ;; new) F=/var/tmp/lab/recipe-files ;; *) echo "usage: apply.sh old|new" >&2; exit 2 ;; esac
for f in etc/systemd/system/desk-browser-thaw.service etc/systemd/system/desk-units@.service usr/local/lib/ma/desk-units \
         usr/local/lib/ma/desk-browser-quit usr/local/lib/ma/desk-browser-close; do
  install -D -o root -g root -m 0644 "$F/$f" "/$f"
done
chmod 0755 /usr/local/lib/ma/desk-units /usr/local/lib/ma/desk-browser-quit /usr/local/lib/ma/desk-browser-close
systemctl daemon-reload
systemctl enable --quiet desk-browser-thaw.service
! systemctl is-active --quiet desk-browser || systemctl start desk-browser-thaw
echo "applied $1: desk-units $(sha256sum /usr/local/lib/ma/desk-units | cut -c1-12), thaw unit $(sha256sum /etc/systemd/system/desk-browser-thaw.service | cut -c1-12), close $(sha256sum /usr/local/lib/ma/desk-browser-close | cut -c1-12); Before: $(systemctl show -p Before --value desk-browser-thaw)"
