#!/bin/bash
# mkbatch.sh (on the workstation; LAB ONLY): a batch_target order for the lab's fake Platform, in <out>/order-<seq>.json.
#   mkbatch.sh --seq <n> --id <id> (--kms | --key <private.pem>) --out <dir> [--ttl <s>] <component>@<version>... [--local <component>@<version>=<file.tgz>]...
# Published releases go through tools/batch/batch-build (meta.json, .sha256 and a pass record in the release bucket), their URLs are
# presigned GETs (the box has no role). --local adds a lab-made artifact (never published; a TEST key only), served from the box's
# loopback (http://127.0.0.1:18080/, a test host's only). --kms signs with alias/ma-desk-batch (tools/batch/batch-sign), --key with a
# throwaway key (a TEST batch key on the box, or one the box doesn't trust at all). Nothing secret is written: the order holds the
# manifest, its DER signature and presigned URLs only.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); TOOLS=$HERE/../../../tools/batch
BUCKET=${RELEASE_BUCKET:-$(sed -n 's/^BUCKET=\${RELEASE_BUCKET:-\(.*\)}$/\1/p' "$TOOLS/batch-build")}   # batch-build's own default
seq= id= sign= key= out= ttl=3600 pub=() loc=()
while [ $# -gt 0 ]; do case "$1" in
  --seq) seq=$2; shift 2 ;; --id) id=$2; shift 2 ;; --kms) sign=kms; shift ;; --key) sign=key; key=$2; shift 2 ;;
  --out) out=$2; shift 2 ;; --ttl) ttl=$2; shift 2 ;; --local) loc+=("$2"); shift 2 ;; *) pub+=("$1"); shift ;;
esac; done
[ -n "$seq" ] && [ -n "$id" ] && [ -n "$sign" ] && [ -n "$out" ] || { sed -n 2,8p "$0"; exit 2; }
mkdir -p "$out"; m=$out/manifest-$seq.json
if [ ${#pub[@]} -gt 0 ]; then
  "$TOOLS/batch-build" --seq "$seq" --id "$id" --note "host-batches lab (ADR 0078): not a release" -o "$m" "${pub[@]}"
else
  echo '{"format":"ma-desk-batch/1","seq":'"$seq"',"id":"'"$id"'","created":"'"$(date -u +%FT%TZ)"'","urgent":false,"components":[],"note":"host-batches lab"}' > "$m"
fi
if [ ${#loc[@]} -gt 0 ]; then   # lab-made artifacts appended, in the order given
  python3 -I - "$m" "${loc[@]}" <<'P'
import hashlib, json, sys
p = sys.argv[1]; m = json.load(open(p))
for spec in sys.argv[2:]:
    cv, f = spec.split("=", 1); c, v = cv.split("@", 1)
    m["components"].append({"name": c, "version": v, "sha256": hashlib.sha256(open(f, "rb").read()).hexdigest()})
open(p, "w").write(json.dumps(m))
P
fi
case "$sign" in
  kms) "$TOOLS/batch-sign" "$m" --kms-key-id alias/ma-desk-batch ;;
  key) openssl dgst -sha256 -sign "$key" -out "$m.sig" "$m" ;;
esac
urls="{}"
for cv in "${pub[@]}"; do
  c=${cv%%@*} v=${cv#*@}
  u=$(aws s3 presign "s3://$BUCKET/desk/$c/$v/$c-$v.tgz" --expires-in "$ttl")
  urls=$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$urls" "$c" "$u")
done
for spec in "${loc[@]}"; do
  cv=${spec%%=*} f=${spec#*=}; c=${cv%%@*}
  urls=$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$urls" "$c" "http://127.0.0.1:18080/$(basename "$f")")
done
python3 -I - "$m" "$m.sig" "$seq" "$urls" "$ttl" "$out/order-$seq.json" <<'P'
import base64, hashlib, json, sys, time
m, s, seq, urls, ttl, outp = sys.argv[1:]
mb, sb = open(m, "rb").read(), open(s, "rb").read()
o = {"op": "batch_target", "id": f"batch_target:lab-{seq}", "targetId": f"lab-{seq}", "seq": int(seq), "sha256": hashlib.sha256(mb).hexdigest(),
     "manifest": base64.b64encode(mb).decode(), "signature": base64.b64encode(sb).decode(), "urls": json.loads(urls),
     "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + int(ttl) - 60)), "urgent": False}
open(outp, "w").write(json.dumps(o))
print(f"order {outp}: seq {seq}, {len(json.loads(urls))} URL(s), manifest {len(mb)} bytes, signature {len(sb)} bytes")
P
