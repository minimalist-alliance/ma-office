#!/bin/bash
# host-overlay.sh <outdir>: this tree's host files for desk-parse (ADR 0097), laid out for verify-port.sh's VERIFY_OVERLAY or a lab host
# (h17.sh), to run an unbaked tree against an earlier host AMI (0.1.15): every file of the tree's desk-host lib, so the host runs main's
# host code with this change, not a mix. LAB ONLY, never a release proof. desk-svc is built here for arm64
# with bake.sh's flags, its sha256 in desk-svc.sha256 (desk-host-check desk-svc reads it). overlay-setup.sh, which the overlay runs on
# the host as root, does what a bake would have: desk-parse.service masked with the other desk units; the template generation in use
# given what this tree's desk recipe adds (user and group parse 1113, desk-parse-ask), through a read-write remount of its bind, which
# a sealed generation never gets on a real host (so desk-host-check templates' walk then fails: expected here); and, if the lab put
# /root/desk-agent-app.tar there (a desk-agent with /app/parse.options: release N, or the Desk Engineer's branch before it), that /app
# in the store's current desk-agent, which the next prepare copies into a slot.
set -euo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}; GO=${GO:-$HOME/.local/go/bin/go}
rm -rf "$OUT"; L=$OUT/usr/local/lib/desk-host; mkdir -p "$L/desk"; chmod 0755 "$OUT"
F=$H/host/recipe/files/usr/local/lib/desk-host
# the whole of this tree's lib (main's host files since the AMI's, with this change): scripts 0755, Python modules as the tree has them
for f in "$F"/*; do [ -f "$f" ] || continue; case "$f" in *.py|*.tmpl) install -m "$(stat -c %a "$f")" "$f" "$L/" ;; *) install -m 755 "$f" "$L/" ;; esac; done
install -m 755 "$F/desk/desk-init.py" "$F/desk/desk-dns.py" "$L/desk/"
(cd "$H/host/desk-svc" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath -ldflags='-s -w -buildid=' -o "$L/desk/desk-svc" .)
(cd "$L/desk" && sha256sum desk-svc | cut -d' ' -f1 > "$L/desk-svc.sha256"; chmod 755 desk-svc)
install -d "$OUT/root"; install -m 755 "$H/recipe/files/usr/local/lib/ma/desk-parse-ask" "$OUT/root/desk-parse-ask"
cat > "$OUT/overlay-setup.sh" <<'S'
#!/bin/bash
set -euo pipefail
systemctl mask desk-parse.service >/dev/null 2>&1 || true
gen=$(python3 -I -c 'import sys; sys.path.insert(0, "/usr/local/lib/desk-host"); import templates as t; print(t.gen_dir(t.current_gen()))')
mount -o remount,bind,rw "$gen"
grep -q '^parse:' "$gen/etc/passwd" || echo 'parse:x:1113:1113::/nonexistent:/usr/sbin/nologin' >> "$gen/etc/passwd"
grep -q '^parse:' "$gen/etc/group" || echo 'parse:x:1113:' >> "$gen/etc/group"
grep -q '^parse:' "$gen/etc/shadow" || echo 'parse:!:20000::::::' >> "$gen/etc/shadow"
install -o root -g root -m 0755 /root/desk-parse-ask "$gen/usr/local/lib/ma/desk-parse-ask"
mount -o remount,bind,ro "$gen"
echo "overlay-setup: $gen has user parse $(grep '^parse:' "$gen/etc/passwd" | cut -d: -f3) and desk-parse-ask (LAB ONLY: a sealed generation changed)"
if [ -f /root/desk-agent-app.tar ]; then
  r=$(readlink -f /srv/desk-host/releases/desk-agent/current)/rootfs
  [ -d "$r/app.orig" ] || mv "$r/app" "$r/app.orig"
  rm -rf "$r/app"; install -d -m 0755 "$r/app"; tar -C "$r" --numeric-owner -xf /root/desk-agent-app.tar
  echo "overlay-setup: the store's desk-agent has the lab's /app ($(ls "$r/app" | tr '\n' ' '))"
fi
S
chmod 755 "$OUT/overlay-setup.sh"
find "$OUT" -type f | sed "s#^$OUT/##" | sort
