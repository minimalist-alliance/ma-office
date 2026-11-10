#!/bin/bash
# apply.sh: runs as root on a lab box booted from ma-desk-0.2.3, from /var/tmp/lab (lab.sh uploads image/recipe there).
# It runs build.sh's own steps, cut out of build.sh, so what's tested is what a bake would do: "install files", the
# gst-ptp-helper statoverride, the desk-egress release, and build.sh's own assertions for them. desk-stream is installed
# from recipe/desk-stream with ma-update, packed as package-desk-stream.sh packs it, since a bake takes it from
# releases.pin and the lab can't fetch or publish one. It skips packages, the SSM agent, yuvconv, the pinned releases,
# the first-open trace and the final lockdown (that would end SSH).
set -euo pipefail
HERE=/var/tmp/lab/recipe
B=$HERE/build.sh
IMG_VERSION=lab-throttle
step() { echo "==== $* ===="; }
die() { echo "apply.sh: ERROR: $*" >&2; exit 1; }
cut_step() { awk -v a="$1" -v b="$2" 'index($0, "step \"" a) == 1 {p = 1} index($0, "step \"" b) == 1 {p = 0} p' "$B"; }

eval "$(grep -E '^PTP_HELPER=|^dpkg-statoverride ' "$B")"
eval "$(cut_step 'users' 'packages')"   # 0.2.3 has no user notebook, and tmpfiles and desk-datadirs now name it
eval "$(cut_step 'install files' 'service configuration')"
systemctl daemon-reload
eval "$(grep -E '^systemctl enable desk-egress' "$B")"
eval "$(cut_step 'desk-egress (baked' 'final:')"
step "desk-stream from recipe/desk-stream, as a release"
t=$(mktemp -d); cp -a "$HERE/desk-stream/." "$t/"; v=lab-$(cat "$t"/* | sha256sum | cut -c1-8); echo "$v" > "$t/VERSION"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' -C "$t" -cf - . | gzip -n > /var/tmp/ds-lab.tgz; rm -rf "$t"
if [ "$(cat /opt/ma/desk-stream/current/VERSION 2>/dev/null)" != "$v" ]; then
  MA_INSTALL_ONLY=1 /opt/ma/bin/ma-update desk-stream file:///var/tmp/ds-lab.tgz "$(sha256sum /var/tmp/ds-lab.tgz | cut -d' ' -f1)"
fi
echo "desk-stream current: $(cat /opt/ma/desk-stream/current/VERSION)"
/usr/local/lib/ma/desk-datadirs
step "assertions (build.sh's, for what this adds)"
bad=0
chk() { if ! "$@"; then echo "ASSERT FAILED: $*" >&2; bad=1; fi; }
eval "$(grep -E '^chk ' "$B" | grep -E 'egress|PTP|/usr/sbin/tc|modprobe|nft -c|desk-stream')"
[ "$bad" = 0 ] || die "assertions failed"
step "load"
nft -f /etc/nftables.conf
/usr/local/sbin/lab-allow
systemctl restart desk-egress
systemctl is-active desk-egress
tc class show dev ens5
nft list chain inet ma classify | grep -c 'priority set' | sed 's/^/classify rules: /'
echo "apply.sh: done"
