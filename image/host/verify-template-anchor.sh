#!/bin/bash
# image/host/verify-template-anchor.sh check|mutation <anchor, base64>: the template signing key's trust anchor on a booted host (ADR 0077
# PU-9; the Security Analyst's Medium, 2026-11-11). verify.sh and verify-port.sh run it on the host as root right after the host's own
# checks (R "sudo bash -s -- <mode> <b64>" < verify-template-anchor.sh), the anchor being the workstation's committed
# image/host/recipe/template-keys.sha256.
# check: "ANCHOR PASS" when /usr/local/lib/desk-host/template-keys.sha256 is the anchor byte for byte and /etc/desk-host/template-keys
#   holds exactly the anchor's keys with its SHA-256s (desk-host-check template-sig proves the rest: P-256, root's, no drop-in).
# mutation: the substitution the anchor exists for, which template-sig alone can't see: the key replaced by another P-256 key under the
#   same name and the pin rewritten to match it, as a bake that pinned whatever was staged would have made. template-sig's verdict on it
#   is printed (it passes: the pin agrees with the directory); this check must fail it ("MUTATED ANCHOR FAIL"). Then both are put back,
#   and this check and template-sig pass ("RESTORE PASS").
# An image with no template path (no desk-host-template: host 0.1.11, 0.1.11.1 and earlier, before ADR 0077's host half) has nothing that trusts a
#   template key: "ANCHOR NOT APPLICABLE", which the callers report as a skip, neither a pass nor a fail.
# Exit 2 when the step itself couldn't run; else 0, and the lines say.
set -u
MODE=${1:?usage: verify-template-anchor.sh check|mutation <anchor base64>}
# (the paths are the host's; image/tests/test_host_template_anchor.py points them at a temporary tree, never as root)
L=${DESK_HOST_LIB:-/usr/local/lib/desk-host}; PIN=$L/template-keys.sha256; D=${DESK_HOST_TEMPLATE_KEYS:-/etc/desk-host/template-keys}
W=${VTA_WORK:-/root/tk-anchor}; A=$W/anchor
rm -rf "$W"; install -d -m 700 "$W"
printf '%s' "${2:?the anchor, base64}" | base64 -d > "$A" 2>/dev/null && [ -s "$A" ] || { echo "the anchor didn't decode"; exit 2; }
if [ ! -e $L/desk-host-template ]; then
  echo "no $L/desk-host-template: this image has no template path (before ADR 0077's host half), and nothing on it trusts a template key"
  echo "pin: [$(cut -c1-12 "$PIN" 2>/dev/null | paste -sd' ')]; $D: [$(ls -A "$D" 2>/dev/null | paste -sd' ')]"
  echo "ANCHOR NOT APPLICABLE"; exit 0
fi

anchored() {   # 0 when the pin is the anchor and the directory holds exactly its keys with its SHA-256s; says which part differs
  local ok=0 have want
  if cmp -s "$PIN" "$A"; then echo "  the pin is the committed anchor ($(cut -c1-12 "$A" | paste -sd' '))"
  else echo "  the pin isn't the committed anchor: pin [$(cut -c1-12 "$PIN" 2>/dev/null | paste -sd' ')], anchor [$(cut -c1-12 "$A" | paste -sd' ')]"; ok=1; fi
  have=$(cd "$D" 2>/dev/null && LC_ALL=C ls -A | while IFS= read -r f; do
    if [ -L "$f" ] || [ ! -f "$f" ]; then echo "not-a-file  $f"; else echo "$(sha256sum < "$f" | cut -d' ' -f1)  $f"; fi; done)
  want=$(LC_ALL=C sort -k2 "$A")
  if [ "$have" = "$want" ]; then echo "  $D holds exactly the anchor's keys"
  else echo "  $D isn't the anchor's keys: [$(echo "$have" | awk 'NF {print substr($1, 1, 12) " " $2}' | paste -sd' ')]"; ok=1; fi
  return $ok
}
sig() { $L/desk-host-check --allow-verify-access --only template-sig 2>&1 | grep -m1 'template-sig' | cut -c1-200; }

if [ "$MODE" = check ]; then
  echo "template-sig: $(sig)"
  if anchored; then echo "ANCHOR PASS"; else echo "ANCHOR FAIL"; fi
  exit 0
fi
[ "$MODE" = mutation ] || { echo "no mode $MODE"; exit 2; }
anchored >/dev/null || { anchored; echo "the host isn't anchored before the mutation: nothing to break"; exit 2; }
k=$(awk 'NR == 1 {print $2}' "$A")
cp -a "$D/$k" "$W/key.keep" && cp -a "$PIN" "$W/pin.keep" || { echo "couldn't keep the key and pin"; exit 2; }
restore() { cp -a "$W/key.keep" "$D/$k"; cp -a "$W/pin.keep" "$PIN"; }
trap restore EXIT
openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl ec -pubout 2>/dev/null > "$W/other.pem" && [ -s "$W/other.pem" ] \
  || { echo "couldn't make another P-256 key"; exit 2; }
cat "$W/other.pem" > "$D/$k"   # written in place: the file keeps its owner and mode, so template-sig judges only the bytes
{ echo "$(sha256sum < "$D/$k" | cut -d' ' -f1)  $k"; awk 'NR > 1' "$W/pin.keep"; } > "$W/pin.new"; cat "$W/pin.new" > "$PIN"
echo "mutated: $k replaced by another P-256 key ($(sha256sum < "$D/$k" | cut -c1-12)), the pin rewritten to it"
echo "template-sig on it: $(sig)"
if anchored; then echo "MUTATED ANCHOR PASS (the substitution got through)"; else echo "MUTATED ANCHOR FAIL"; fi
restore; trap - EXIT
echo "restored: template-sig $(sig)"
if anchored && sig | grep -q '^PASS'; then echo "RESTORE PASS"; else echo "RESTORE FAIL"; fi
rm -rf "$W"
