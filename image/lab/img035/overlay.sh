#!/bin/bash
# overlay.sh <outdir>: the desk image files the img035 asks add or change (OpenRouter in the Agent's egress, links out, the
# password managers' policies, JPEG XL off), laid out from / with overlay-setup.sh, which does what recipe/build.sh does
# for them. For verify.sh's VERIFY_OVERLAY and lab.sh overlay, to run this unbaked tree on ma-desk-0.3.4 in the lab, as
# lab/restart-oom/host-overlay.sh does for a host. LAB ONLY, never a release proof: the bake is.
set -euo pipefail
I=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}; F=$I/recipe/files
rm -rf "$OUT"; install -d -m 0755 "$OUT"
for f in etc/ma/agent-egress.conf etc/chromium/policies/managed/ma.json etc/ma/chromium-teen.json etc/ma/chromium-adult.json \
         etc/tmpfiles.d/desk-links.conf; do
  install -D -m 0644 "$F/$f" "$OUT/$f"
done
for f in usr/local/lib/ma/desk-browser-policy usr/local/lib/ma/desk-browser-start usr/local/bin/xdg-open; do
  install -D -m 0755 "$F/$f" "$OUT/$f"
done
ln -s xdg-open "$OUT/usr/local/bin/xdg-email"
find "$OUT" -type d -exec chmod 0755 {} +
cat > "$OUT/overlay-setup.sh" <<'S'
#!/bin/bash
# What recipe/build.sh does for these files (its "install files" step), then the units that read them at start.
set -u
chown root:root /etc/ma/chromium-teen.json /etc/ma/chromium-adult.json /etc/ma/agent-egress.conf /usr/local/bin/xdg-open
chmod 0644 /etc/ma/chromium-teen.json /etc/ma/chromium-adult.json /etc/ma/agent-egress.conf; chmod 0755 /usr/local/bin/xdg-open
install -d -m 0755 /usr/share/ma/xdg-utils
for f in xdg-open xdg-email; do
  [ "$(dpkg-divert --truename /usr/bin/$f)" = /usr/share/ma/xdg-utils/$f ] || dpkg-divert --local --rename --divert /usr/share/ma/xdg-utils/$f --add /usr/bin/$f
done
systemd-tmpfiles --create /etc/tmpfiles.d/desk-links.conf
systemctl daemon-reload
systemctl restart desk-agent-filter.service
# deskd's run mounts /run/desk-links only when it's there at the container's start, as it is from boot on a baked image.
systemctl restart deskd.service
for i in $(seq 1 120); do RELEASE_DIR=/opt/ma/deskd/current /opt/ma/deskd/current/health >/dev/null 2>&1 && break; sleep 1; done
systemctl try-restart desk-browser.service
rm -f /overlay-setup.sh
echo "overlay-setup: done (deskd health after ${i} s)"
S
chmod 0755 "$OUT/overlay-setup.sh"
(cd "$OUT" && find . \( -type f -o -type l \) | sed 's#^\./##' | sort)
