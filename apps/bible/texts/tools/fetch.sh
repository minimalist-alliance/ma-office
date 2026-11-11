#!/usr/bin/env bash
# Download the sources of the four Bible texts and check each against the
# SHA-256 pinned below. Usage:
#
#   fetch.sh DIR
#
# DIR gets one folder per translation (DIR/bsb, DIR/web, DIR/kjv, DIR/asv),
# each holding only what was downloaded for it. Keep DIR outside the repo:
# the downloads are untrusted data and are never committed. A file already
# there with the right hash is kept; any mismatch stops the run and leaves
# nothing behind under the final name.
#
# The publishers rebuild these files from time to time, so a pin can go
# stale. Then: download the new file by hand into a scratch folder, run
# normalize.py on it, review the diff of the .tsv files, and only then
# change the pin here and the size and hash in that translation's SOURCE.md.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 DIR" >&2
  exit 2
fi
dir=$1

# code  saved-as  sha256  url
SOURCES='
bsb bsb_usfm.zip f0c56438eb89c98e8f62c5c00461e25cc35b098ad5b179bc350cede759ee5f87 https://bereanbible.com/bsb_usfm.zip
bsb bsb.txt 2ac3af1de52d4e68261cba91d85c320b7eadc6560e830d99e591767b8ff5ca96 https://bereanbible.com/bsb.txt
web eng-web_usfm.zip c521fbee9abc01733eb0347baa1ebc863c5531070aa31099f044238feaaeb0f7 https://ebible.org/Scriptures/eng-web_usfm.zip
kjv eng-kjv2006_usfm.zip dce1ec3ea45a155ac05e975fc8d817da403a817713d554eb9cc3a2177a6cfd1c https://ebible.org/Scriptures/eng-kjv2006_usfm.zip
asv eng-asv_usfm.zip 00b7b6c76cb1eb67b22ca51bd5ac13c2df526c13e1c38e78b862a7a2367f7071 https://ebible.org/Scriptures/eng-asv_usfm.zip
'

sha() { sha256sum "$1" | cut -d' ' -f1; }

failed=0
while read -r code name want url; do
  [ -n "$code" ] || continue
  mkdir -p "$dir/$code"
  out=$dir/$code/$name
  if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then
    echo "ok (kept)  $code/$name"
    continue
  fi
  tmp=$out.part
  rm -f "$tmp"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
       --max-time 600 --max-filesize 67108864 -o "$tmp" "$url"
  got=$(sha "$tmp")
  if [ "$got" != "$want" ]; then
    echo "MISMATCH  $code/$name from $url" >&2
    echo "  pinned  $want" >&2
    echo "  got     $got" >&2
    rm -f "$tmp"
    failed=1
    continue
  fi
  mv -f "$tmp" "$out"
  echo "ok        $code/$name  $(stat -c %s "$out") bytes"
done <<<"$SOURCES"

if [ "$failed" -ne 0 ]; then
  echo "fetch: a file did not match its pin; see the comment at the top of $0" >&2
  exit 1
fi
