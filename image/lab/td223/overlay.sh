#!/bin/bash
# overlay.sh <outdir>: the host files TD-223 (ADR 0036's shaper per container) adds or changes, laid out from / for an earlier host AMI
# in the lab, as lab/restart-oom/host-overlay.sh does (verify-port.sh's VERIFY_OVERLAY takes the same directory). desk_egress.py is the
# desk recipe's desk-egress, which the host recipe installs from the template at bake. Never a release proof.
set -euo pipefail
I=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}
F=$I/host/recipe/files; L=$OUT/usr/local/lib/desk-host
rm -rf "$OUT"; mkdir -p "$L/desk" "$OUT/etc/systemd/system" "$OUT/etc/desk-host"
install -m 755 "$F/usr/local/lib/desk-host/desk-host" "$F/usr/local/lib/desk-host/desk-host-check" "$F/usr/local/lib/desk-host/egress.py" \
  "$F/usr/local/lib/desk-host/report.py" "$F/usr/local/lib/desk-host/svc-spec.py" "$L/"
install -m 755 "$F/usr/local/lib/desk-host/desk/desk-init.py" "$L/desk/"
install -m 644 "$I/recipe/desk-egress/desk-egress" "$L/desk_egress.py"
install -m 644 "$F/etc/systemd/system/desk-host-egress@.service" "$OUT/etc/systemd/system/"
install -m 644 "$F/etc/desk-host/egress.conf" "$OUT/etc/desk-host/"
find "$OUT" -type f | sed "s#^$OUT/##" | sort
