#!/bin/bash
# host-overlay.sh <outdir>: the host image's files this tree changed (reliability audit S1 and S2), laid out for verify-port.sh's
# VERIFY_OVERLAY, to run an unbaked tree against an earlier host AMI in the lab. desk-svc is built here for arm64 with bake.sh's flags,
# and its sha256 goes in desk-svc.sha256, which desk-host-check's desk-svc check reads. Never a release proof.
set -euo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}; GO=${GO:-$HOME/.local/go/bin/go}
rm -rf "$OUT"; L=$OUT/usr/local/lib/desk-host; mkdir -p "$L/desk" "$OUT/etc/systemd/system"
F=$H/host/recipe/files
install -m 755 "$F/usr/local/lib/desk-host/desk-host-check" "$F/usr/local/lib/desk-host/svc-spec.py" "$L/"
install -m 755 "$F/usr/local/lib/desk-host/desk/desk-init.py" "$L/desk/"
install -m 644 "$F"/etc/systemd/system/desk-host-link.service "$F"/etc/systemd/system/desk-ice-demux.service "$F"/etc/systemd/system/desk-host-shutdown.service "$OUT/etc/systemd/system/"
(cd "$H/host/desk-svc" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -trimpath -ldflags='-s -w -buildid=' -o "$L/desk/desk-svc" .)
(cd "$L/desk" && sha256sum desk-svc | cut -d' ' -f1 > "$L/desk-svc.sha256"; chmod 755 desk-svc)
find "$OUT" -type f | sed "s#^$OUT/##" | sort
