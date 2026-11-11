#!/bin/bash
# image/host/verify-batches.sh: ADR 0078 section 7's fetch steps on a booted host, as root, with their mutations. verify.sh and verify-port.sh
# copy it to the host and run it (section 4g); the host-batches lab runs it too. The host is a TEST host for this script only (test.conf and
# /var/lib/desk-host/test for its run, removed after: desk-host-check no-test must pass again). Nothing leaves the host: the test release is
# made here from the store's own desk-rtc (a new VERSION), signed with a throwaway P-256 key made for this run and trusted only as a TEST
# key, and served on the loopback. Each step must PASS; then the same step with its mutation (DESK_HOST_BATCH_MUT, a TEST host's only) must
# FAIL, which proves the step can fail:
#   fetch       a test batch is verified, downloaded, hashed, unpacked and installed as the candidate; current and every slot untouched
#               (mutation into-current: installed straight into current)
#   refused     no signature, another key, a template header offered as a batch, a seq at the floor, another format: each refused at
#               its check, nothing downloaded or installed (mutations no-sig and no-floor)
#   bytes       one byte changed after signing: refused as it's downloaded, before it's opened; the same version from another
#               artifact refused (mutation no-hash: the download unchecked, the refusal comes only at the unpack's own check)
#   room        a store or root without room for the batch: refused before anything is written (mutation no-room)
# The live switch, the smoke test's rollback, the canary, the stop path and the unpack's memory need real desks and real releases: the
# host-batches lab's (image/lab/host-batches/, docs/sub-status/host-batches.md), not this script.
# Prints PASS/FAIL lines; exit 0 when every step passed and every mutation failed its step.
set -u
L=/usr/local/lib/desk-host; V=/var/lib/desk-host/batch; W=/root/vb.$$; PORT=18081
[ "$(id -u)" = 0 ] || { echo "root only" >&2; exit 2; }
bad=0
ok() { echo "PASS  $*"; }
no() { echo "FAIL  $*"; bad=1; }
fs() { python3 -I -c 'import json,sys; d=json.load(open("/var/lib/desk-host/batch/fetch.json")); print(d.get(sys.argv[1]) or "")' "$1" 2>/dev/null; }
link() { readlink /srv/desk-host/releases/desk-rtc/$1 2>/dev/null || echo -; }
recsum() { cat /var/lib/desk-host/slots/*.json 2>/dev/null | sha256sum | cut -c1-16; }
store() { ls /srv/desk-host/releases/desk-rtc | tr '\n' ' '; }
was_test=0; [ -e /etc/desk-host/test.conf ] && was_test=1
cleanup() {
  kill "${SRV:-0}" 2>/dev/null
  rm -rf "${W:?}"
  local s   # this run's kept test batches only (their key goes with this run): <seq>.json naming its own vb- id, never state.json
  for s in $(seq "$((B0 + 1))" "${S:-$B0}"); do grep -qs "\"id\": *\"vb-$s\"" "$V/$s.json" && rm -f "$V/$s.json" "$V/$s.sig"; done
  [ -s "$V/state.json" ] && python3 -I $L/desk-host-batch gc >/dev/null 2>&1
  rm -f /var/lib/desk-host/test/batch-keys/vb.pem
  if [ "$was_test" = 0 ]; then rm -f /etc/desk-host/test.conf; rm -rf /var/lib/desk-host/test; fi
}
trap cleanup EXIT
install -d -m 700 "$W" "$W/art"; touch /etc/desk-host/test.conf; install -d -m 755 /var/lib/desk-host/test /var/lib/desk-host/test/batch-keys
openssl ecparam -name prime256v1 -genkey -noout -out "$W/test.key" 2>/dev/null; openssl pkey -in "$W/test.key" -pubout -out /var/lib/desk-host/test/batch-keys/vb.pem
chmod 644 /var/lib/desk-host/test/batch-keys/vb.pem
openssl ecparam -name prime256v1 -genkey -noout -out "$W/other.key" 2>/dev/null
CUR=$(link current); B0=$(python3 -I $L/desk-host-batch floor); S=$B0
mkart() {   # mkart <version> [extra]: desk-rtc's current release as <version>, a .tgz in the art directory; prints its sha256
  local d=$W/rel-$1; rm -rf "$d"; mkdir -p "$d"
  for f in VERSION run health desk-rtc; do cp -a "/srv/desk-host/releases/desk-rtc/current/$f" "$d/$f"; done
  echo "$1" > "$d/VERSION"; [ -n "${2:-}" ] && printf '# %s\n' "$2" >> "$d/run"
  tar --owner=0 --group=0 -C "$d" -czf "$W/art/desk-rtc-$1.tgz" VERSION run health desk-rtc
  sha256sum "$W/art/desk-rtc-$1.tgz" | cut -c1-64
}
order() {   # order <seq> <version> <sha> <key|none> [format] [manifest file]: an order file, printed
  VB_W=$W VB_PORT=$PORT python3 -I - "$@" <<'P'
import base64, hashlib, json, os, subprocess, sys, time
seq, ver, sha, key, fmt, mfile = (sys.argv[1:] + [""] * 6)[:6]
w, port = os.environ["VB_W"], os.environ["VB_PORT"]
if mfile:
    mb = open(mfile, "rb").read()
else:
    mb = json.dumps({"format": fmt or "ma-desk-batch/1", "seq": int(seq), "id": f"vb-{seq}", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "urgent": False, "components": [{"name": "desk-rtc", "version": ver, "sha256": sha}], "note": "verify-batches.sh"}).encode()
sig = b"" if key == "none" else subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=mb, capture_output=True, check=True).stdout
o = {"op": "batch_target", "id": f"batch_target:vb-{seq}", "targetId": f"vb-{seq}", "seq": int(seq), "sha256": hashlib.sha256(mb).hexdigest(),
     "manifest": base64.b64encode(mb).decode(), "signature": base64.b64encode(sig).decode(),
     "urls": {"desk-rtc": f"http://127.0.0.1:{port}/desk-rtc-{ver}.tgz"}, "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600)), "urgent": False}
p = f"{w}/order-{seq}-{abs(hash(mb)) % 10000}.json"
json.dump(o, open(p, "w"))
print(p)
P
}
fetch() {   # fetch <order> [mutation]: as the link runs it, in desk-host-upd; prints the exit
  local rc
  DESK_HOST_BATCH_MUT=${2:-} python3 -I $L/desk-host-template upd -- $L/desk-host-batch fetch "$1" >> "$W/fetch.log" 2>&1; rc=$?
  echo $rc
}
dl_empty() { [ -z "$(ls -A /var/lib/desk-host/dl 2>/dev/null | grep '^batch-')" ]; }
(cd "$W/art" && exec python3 -m http.server $PORT --bind 127.0.0.1) >/dev/null 2>&1 & SRV=$!
sleep 1
S=$((B0 + 1))

# ---- fetch
sm=$(mkart "vbm-$S"); r0=$(recsum); rc=$(fetch "$(order $S "vbm-$S" "$sm" "$W/test.key")" into-current)
if [ "$rc" = 0 ] && [ "$(link current)" = "$CUR" ]; then no "fetch's mutation (into-current) didn't fail the step"; else ok "fetch's mutation (into-current): current moved to $(link current), the step fails"; fi
ln -sfn "$CUR" /srv/desk-host/releases/desk-rtc/current.vb && mv -T /srv/desk-host/releases/desk-rtc/current.vb /srv/desk-host/releases/desk-rtc/current
python3 -I $L/desk-host-batch halt $S verify-batches >/dev/null
S=$((S + 1)); s1=$(mkart "vb1-$S"); r0=$(recsum); rc=$(fetch "$(order $S "vb1-$S" "$s1" "$W/test.key")")
if [ "$rc" = 0 ] && [ "$(fs state)" = installed ] && [ "$(link candidate)" = "vb1-$S" ] && [ "$(link current)" = "$CUR" ] && [ "$(recsum)" = "$r0" ] && dl_empty; then
  ok "fetch: seq $S verified, downloaded, hashed, unpacked, the candidate (desk-rtc vb1-$S); current $CUR and every slot untouched; the download gone"
else no "fetch: rc $rc, $(fs state) at $(fs step): $(fs error); candidate $(link candidate), current $(link current)"; fi
CAND=$S; CS=$s1
S=$((S + 1)); so=$(mkart "vb1-$CAND" "another build")   # the candidate's version again, another artifact
rc=$(fetch "$(order $S "vb1-$CAND" "$so" "$W/test.key")"); if [ "$rc" = 3 ] && [ "$(fs step)" = choose ] && grep -q "never replaced" <<<"$(fs error)"; then
  ok "bytes: the same version from another artifact is refused, never replaced"; else no "conflict: rc $rc at $(fs step): $(fs error | cut -c1-80)"; fi
mkart "vb1-$CAND" >/dev/null   # its own bytes back

# ---- refused before any download
before=$(store)
refused() {   # refused <label> <order> <step it must stop at> [mutation]
  local rc; rc=$(fetch "$2" "${4:-}")
  if [ "$rc" = 3 ] && [ "$(fs step)" = "$3" ] && [ "$(store)" = "$before" ] && dl_empty && [ "$(link candidate)" = "vb1-$CAND" ]; then
    echo "refused"; else echo "taken (rc $rc at $(fs step): $(fs error | cut -c1-80))"; fi
}
S=$((S + 1)); sx=$(mkart "vbx-$S")
v=$(refused "no signature" "$(order $S "vbx-$S" "$sx" none)" verify); [ "$v" = refused ] && ok "refused: no signature, at verify, nothing written" || no "no signature: $v"
v=$(refused "another key" "$(order $S "vbx-$S" "$sx" "$W/other.key")" verify); [ "$v" = refused ] && ok "refused: another key's signature, at verify" || no "another key: $v"
printf '{"format":"ma-host-template/1","gen":"g2","hostImage":"0.1.10","created":"2026-11-11T00:00:00Z","urgent":false}' > "$W/hdr.json"
v=$(refused "a template header" "$(order $S "vbx-$S" "$sx" "$W/test.key" "" "$W/hdr.json")" verify); [ "$v" = refused ] && ok "refused: a template header offered as a batch" || no "a template header: $v"
v=$(refused "at the floor" "$(order $CAND "vb1-$CAND" "$CS" "$W/test.key")" verify); [ "$v" = refused ] && ok "refused: seq $CAND at the floor (a replay)" || no "at the floor: $v"
v=$(refused "another format" "$(order $S "vbx-$S" "$sx" "$W/test.key" ma-desk-batch/2)" verify); [ "$v" = refused ] && ok "refused: format ma-desk-batch/2" || no "another format: $v"
# ---- refused on its bytes
S=$((S + 1)); before=$(store); sb=$(mkart "vbb-$S"); f=$W/art/desk-rtc-vbb-$S.tgz
python3 -I -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[200]^=1; open(p,"wb").write(bytes(b))' "$f"   # one byte, after signing
o=$(order $S "vbb-$S" "$sb" "$W/test.key")
rc=$(fetch "$o"); if [ "$rc" = 3 ] && [ "$(fs step)" = download ] && [ "$(store)" = "$before" ] && dl_empty; then ok "bytes: one byte changed after signing is refused as it's downloaded, before it's opened; nothing installed"
else no "bytes: rc $rc at $(fs step): $(fs error | cut -c1-80)"; fi
S=$((S + 1)); o=$(order $S "vbb-$((S - 1))" "$sb" "$W/test.key")   # the same changed file, a new seq (the first refusal raised the floor)
rc=$(fetch "$o" no-hash); if [ "$rc" = 3 ] && [ "$(fs step)" = download ]; then no "bytes' mutation (no-hash) didn't fail the step"
else ok "bytes' mutation (no-hash): refused only at $(fs step) (rc $rc; the unpack's own hash check), so the step fails"; fi

# ---- refused's mutations (each takes a batch the step must refuse)
before=$(store); S=$((S + 1)); sx=$(mkart "vbx-$S")
v=$(refused "another key, unchecked" "$(order $S "vbx-$S" "$sx" "$W/other.key")" verify no-sig)
[ "$v" != refused ] && ok "refused's mutation (no-sig): another key's batch is $v, the step fails" || no "refused's mutation (no-sig) didn't fail the step"
python3 -I $L/desk-host-batch halt $S verify-batches >/dev/null; python3 -I $L/desk-host-batch gc >/dev/null; before=$(store)
S=$((S + 1))
v=$(refused "at the floor, unchecked" "$(order $CAND "vbx-$S" "$(mkart "vbx-$S")" "$W/test.key")" verify no-floor)
[ "$v" != refused ] && ok "refused's mutation (no-floor): seq $CAND at the floor is $v, the step fails" || no "refused's mutation (no-floor) didn't fail the step"
python3 -I $L/desk-host-batch halt $CAND verify-batches >/dev/null; python3 -I $L/desk-host-batch gc >/dev/null

# ---- room
S=$((S + 1)); before=$(store); sr=$(mkart "vbr-$S"); o=$(order $S "vbr-$S" "$sr" "$W/test.key")
rc=$(DESK_HOST_BATCH_ROOM_BYTES=1000 fetch "$o"); if [ "$rc" = 1 ] && grep -q "no room" <<<"$(fs error)" && [ "$(store)" = "$before" ] && dl_empty; then
  ok "room: no room on the root or the store: refused before writing ($(fs error | cut -c1-70))"; else no "room: rc $rc at $(fs step): $(fs error | cut -c1-80)"; fi
rc=$(DESK_HOST_BATCH_ROOM_BYTES=1000 fetch "$o" no-room); if [ "$rc" = 0 ]; then ok "room's mutation (no-room): installed with no room, the step fails"
else no "room's mutation (no-room) didn't fail the step (rc $rc: $(fs error | cut -c1-80))"; fi

# ---- the host's checks after, then this run's test batches halted and removed
for s in $(python3 -I -c 'import json; s=json.load(open("/var/lib/desk-host/batch/state.json")); print((s.get("candidate") or {}).get("seq") or "")'); do
  python3 -I $L/desk-host-batch halt "$s" verify-batches >/dev/null; done
python3 -I $L/desk-host-batch gc >/dev/null
$L/desk-host-check --allow-verify-access --only releases >/dev/null && ok "releases passes after the run" || no "releases fails after the run"
echo "verify-batches: $(grep -c . "$W/fetch.log") fetch log lines; test seqs $((B0 + 1)) to $S"
[ "$bad" = 0 ]
