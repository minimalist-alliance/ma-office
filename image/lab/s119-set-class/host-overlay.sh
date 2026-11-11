#!/bin/bash
# host-overlay.sh <outdir>: the host image's files sub/s119-set-class changed (the link's set_class, desk-host class --whole,
# the report's class), laid out for verify-port.sh's VERIFY_OVERLAY, to run this unbaked tree against host 0.1.10's AMI in the
# lab, as lab/restart-oom/host-overlay.sh does. Never a release proof: a release is verified on its own baked AMI.
set -euo pipefail
H=$(cd "$(dirname "$0")/../.." && pwd); OUT=${1:?outdir}
rm -rf "$OUT"; L=$OUT/usr/local/lib/desk-host; mkdir -p "$L"
F=$H/host/recipe/files/usr/local/lib/desk-host
install -m 755 "$F/desk-host" "$F/desk-host-link" "$F/report.py" "$L/"
find "$OUT" -type f | sed "s#^$OUT/##" | sort
