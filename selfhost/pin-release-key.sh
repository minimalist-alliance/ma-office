#!/usr/bin/env bash
# pin-release-key.sh: pins the self-hosted release key's public half in the installer, in one step (README.md, "A signed
# bundle").
#
#   selfhost/pin-release-key.sh [alias/<name>] [--replace]       default alias/ma-selfhost-release
#
# Reads the key's public half with KMS GetPublicKey (a read; it never signs), refuses anything but an ECC_NIST_P256
# SIGN_VERIFY key whose only signing algorithm is ECDSA_SHA_256, and writes:
#   files/opt/ma/etc/selfhost-release-keys/<alias's name>-<YYYY-MM>.pem
#       the PEM exactly as `openssl pkey -pubin -inform DER -outform PEM` writes it from KMS's DER: the same bytes Platform's
#       scripts/selfhost-publish.sh (kms_key) writes and publishes, so the two compare byte for byte. Alone in its folder,
#       which install.sh installs as /opt/ma/etc/selfhost-release-keys/ (root's, 0755, the file 0644).
#   release-keys.sha256
#       the anchor, "<sha256>  <name>.pem" (sha256sum's format), which ma-selfhost-bundle checks that folder against before
#       it trusts it, on a first install and an update alike.
# then runs the installer's own check of the two (ma-selfhost-bundle keys). The same key already pinned: nothing changes
# (the anchor is written again if it differs). Another key pinned: refused unless --replace, since a desk holding the old
# key refuses every bundle signed with the new one (an update never changes the key; moving desks to a new key needs a
# statement signed by the old one, which isn't built). It takes an alias only, so no key id or account is ever written.
# Commit both files together. Needs aws (kms:GetPublicKey on the alias), jq, openssl, python3, sha256sum.
# Tests: tests/test_bundle.py (Pin), with a stand-in for aws.
set -euo pipefail
umask 022
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=$HERE/files/opt/ma/etc/selfhost-release-keys
ANCHOR=$HERE/release-keys.sha256
CHECK=$HERE/files/usr/local/lib/ma/selfhost/ma-selfhost-bundle
die() { echo "pin-release-key: $*" >&2; exit 1; }

ALIAS=alias/ma-selfhost-release REPLACE=0
for a in "$@"; do
  case "$a" in
    --replace) REPLACE=1 ;;
    alias/*) ALIAS=$a ;;
    *) die "usage: $0 [alias/<name>] [--replace] (an alias only: a key id or ARN would name the account)" ;;
  esac
done
[[ $ALIAS =~ ^alias/[A-Za-z0-9/_-]{1,200}$ ]] || die "not an alias: $ALIAS"

t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
aws kms get-public-key --key-id "$ALIAS" --output json >"$t/kms.json" 2>"$t/err" \
  || die "can't read $ALIAS's public key from KMS ($(grep -o '[A-Za-z]*Exception' "$t/err" | head -1 || true))"
spec=$(jq -r .KeySpec "$t/kms.json") usage=$(jq -r .KeyUsage "$t/kms.json") algs=$(jq -c .SigningAlgorithms "$t/kms.json")
[ "$spec" = ECC_NIST_P256 ] || die "$ALIAS is $spec, not ECC_NIST_P256"
[ "$usage" = SIGN_VERIFY ] || die "$ALIAS is for $usage, not SIGN_VERIFY"
[ "$algs" = '["ECDSA_SHA_256"]' ] || die "$ALIAS signs with $algs, not ECDSA_SHA_256 alone"
# Platform's kms_key, command for command, so the bytes are the ones it publishes.
jq -r .PublicKey "$t/kms.json" | base64 -d >"$t/kms.der" 2>/dev/null || die "KMS's public key isn't base64"
openssl pkey -pubin -inform DER -in "$t/kms.der" -outform PEM -out "$t/key.pem" 2>/dev/null || die "KMS's public key isn't one openssl reads"
openssl pkey -pubin -in "$t/key.pem" -noout -text 2>/dev/null | grep -q -E 'prime256v1|P-256' || die "KMS's public key isn't P-256"
sha=$(sha256sum <"$t/key.pem" | cut -c1-64)

name=${ALIAS#alias/}; name=${name//\//-}-$(date -u +%Y-%m).pem
if [ -d "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
  have=$(ls -A "$DIR")
  if [ "$(printf '%s\n' "$have" | wc -l)" = 1 ] && [ -f "$DIR/$have" ] && [ ! -L "$DIR/$have" ] && cmp -s "$DIR/$have" "$t/key.pem"; then
    name=$have   # the same key: keep its name, so a desk holding it still matches by name and bytes
  elif [ "$REPLACE" = 1 ]; then
    echo "pin-release-key: replacing $(printf '%s' "$have" | tr '\n' ' ')with $ALIAS's key: a desk holding the old key refuses every bundle signed with this one" >&2
  else
    die "the installer pins another key ($(printf '%s' "$have" | tr '\n' ' ')): --replace pins $ALIAS's in its place, and a desk holding the old key then refuses every bundle signed with the new one"
  fi
fi
if [ "$(ls -A "$DIR" 2>/dev/null)" != "$name" ] || ! cmp -s "$DIR/$name" "$t/key.pem"; then
  rm -rf "$DIR"
  install -d -m 0755 "$DIR"
  install -m 0644 "$t/key.pem" "$DIR/$name"
fi
printf '%s  %s\n' "$sha" "$name" >"$t/anchor"
cmp -s "$t/anchor" "$ANCHOR" || install -m 0644 "$t/anchor" "$ANCHOR"
python3 -I "$CHECK" keys "$HERE/.." || die "the pinned key doesn't pass the installer's own check (above)"
echo "pin-release-key: $ALIAS is pinned: selfhost/files/opt/ma/etc/selfhost-release-keys/$name, sha256 $sha, and selfhost/release-keys.sha256. Commit both"
