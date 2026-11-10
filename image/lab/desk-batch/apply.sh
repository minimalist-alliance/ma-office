#!/bin/bash
# apply.sh: this branch's desk-batch files on a lab box from ma-desk-0.3.1, as root from /var/tmp/lab (lab.sh push-recipe).
# It copies the files the bake would (the helper, its units, ma-update, the apt files), then runs recipe/build.sh's
# desk-batch block exactly as written there. Lab only: a real desk gets these from a bake.
set -euo pipefail
F=/var/tmp/lab/recipe-files
for f in usr/local/lib/ma/desk-batch opt/ma/bin/ma-update etc/apt/apt.conf.d/20auto-upgrades etc/apt/apt.conf.d/51ma-unattended \
         etc/systemd/system/desk-batch.service etc/systemd/system/desk-batch.timer etc/systemd/system/desk-batch.socket \
         'etc/systemd/system/desk-batch@.service'; do
  install -D -o root -g root -m 0644 "$F/$f" "/$f"
done
chmod 0755 /opt/ma/bin/ma-update
systemctl daemon-reload
block=$(awk '/^# >>> desk-batch/{f=1} f; /^# <<< desk-batch/{exit}' /var/tmp/lab/build.sh)
[ -n "$block" ] || { echo "no desk-batch block in build.sh" >&2; exit 1; }
bash -euo pipefail -c "$block"
systemctl stop apt-daily.timer apt-daily-upgrade.timer   # a live box had them running; a baked one never starts them
systemctl start desk-batch.socket desk-batch.timer
echo "applied: desk-batch $(sha256sum /usr/local/lib/ma/desk-batch | cut -c1-12), ma-update $(sha256sum /opt/ma/bin/ma-update | cut -c1-12); timer $(systemctl is-active desk-batch.timer), socket $(systemctl is-active desk-batch.socket), apt-daily.timer $(systemctl is-enabled apt-daily.timer 2>&1)"
