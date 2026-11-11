#!/bin/bash
# host-overlay.sh <outdir>: this branch's host files (ADR 0077's member-host half), laid out for verify-port.sh's VERIFY_OVERLAY or
# the u77-host lab box, to run an unbaked tree against host 0.1.10's AMI. LAB ONLY, never a release proof. overlay-setup.sh, run on
# the box after the files are laid, does what the bake would: the template becomes g1 (desk-host-template boot's migration), the
# pinned key list (none yet), the host's apt holds, its timer, zstd.
set -euo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}
rm -rf "$OUT"; L=$OUT/usr/local/lib/desk-host; mkdir -p "$L/desk" "$OUT/etc/systemd/system" "$OUT/etc/apt/apt.conf.d" "$OUT/etc/desk-host"
F=$H/host/recipe/files
for f in desk-host desk-host-boot desk-host-check desk-host-link desk-host-template templates.py idlerule.py mounts.py preread.py report.py svc-spec.py egress.py; do
  install -m 755 "$F/usr/local/lib/desk-host/$f" "$L/"
done
# main's TD-223 files after 0.1.10 (lab/td223/overlay.sh's), so the overlay is the whole unbaked tree's host side
install -m 755 "$F/usr/local/lib/desk-host/desk/desk-init.py" "$L/desk/"
install -m 644 "$H/recipe/desk-egress/desk-egress" "$L/desk_egress.py"
install -m 644 "$F/etc/systemd/system/desk-host-egress@.service" "$OUT/etc/systemd/system/"
install -m 644 "$F/etc/desk-host/egress.conf" "$OUT/etc/desk-host/"
install -m 644 "$F"/etc/systemd/system/desk-host-apt.service "$F"/etc/systemd/system/desk-host-apt.timer "$OUT/etc/systemd/system/"
install -m 644 "$F/etc/apt/apt.conf.d/51desk-host-unattended" "$OUT/etc/apt/apt.conf.d/"
cat > "$OUT/overlay-setup.sh" <<'S'
#!/bin/bash
# on the box, as root, after the overlay's files: what host recipe/build.sh does for ADR 0077 at a bake (LAB ONLY)
set -euo pipefail
L=/usr/local/lib/desk-host
command -v zstd >/dev/null || { apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -q zstd >/dev/null; }
install -d -m 755 /etc/desk-host/template-keys
: > $L/template-keys.sha256; chmod 644 $L/template-keys.sha256
apt-mark hold nftables apparmor >/dev/null
systemctl daemon-reload
systemctl mask apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
systemctl enable --now desk-host-apt.timer >/dev/null 2>&1
rm -f /overlay-setup.sh
# the template becomes g1 (no slot runs yet); every sealed generation bound read-only; desk-host-upd
python3 -I $L/desk-host-template boot
S
chmod 755 "$OUT/overlay-setup.sh"
find "$OUT" -type f | sed "s#^$OUT/##" | sort
