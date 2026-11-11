#!/bin/bash
# host-overlay.sh <outdir>: every host file changed since host 0.1.10's bake (730d555b): S-119's set_class (desk-host, desk-host-link,
# report.py) and free walk H5's Files tree (mounts.py, svc-spec.py, desk/desk-init.py, desk-host-check), laid out for verify-port.sh's
# VERIFY_OVERLAY, to run this unbaked tree against 0.1.10's AMI in the lab, as lab/restart-oom/host-overlay.sh does. Never a release proof.
set -euo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}
rm -rf "$OUT"; L=$OUT/usr/local/lib/desk-host; mkdir -p "$L/desk"
F=$H/host/recipe/files/usr/local/lib/desk-host
install -m 755 "$F/desk-host" "$F/desk-host-link" "$F/report.py" "$F/mounts.py" "$F/svc-spec.py" "$F/desk-host-check" "$L/"
install -m 644 "$F/desk/desk-init.py" "$L/desk/"
find "$OUT" -type f | sed "s#^$OUT/##" | sort
