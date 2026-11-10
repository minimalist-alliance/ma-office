#!/bin/bash
# apply.sh: put this branch's ad blocking on a lab box from an older image, by build.sh's own steps for it. Runs as root on
# the box from /var/tmp/lab, where lab.sh push-recipe put recipe-files/ (a copy of image/recipe/files) and adblock/ (of
# image/recipe/adblock). The release zip is fetched from the pin's URL, or read from /var/tmp/ubol/ if it's there. Lab only.
set -euo pipefail
F=/var/tmp/lab/recipe-files
for f in etc/ma/chromium-adblock.json etc/systemd/system/desk-adblock.service etc/systemd/system/desk-browser.service \
         usr/local/lib/ma/desk-adblock usr/local/lib/ma/desk-units; do
  install -D -o root -g root -m 0644 "$F/$f" "/$f"
done
rm -f /etc/systemd/system/desk-adblock-settle.service
chmod 0755 /usr/local/lib/ma/desk-adblock /usr/local/lib/ma/desk-units
ver=$(sed -n 's/^version=//p' /var/tmp/lab/adblock/blocker.pin); zip=/var/tmp/ubol/ubol-$ver.chromium.zip
install -d -m 0755 /usr/share/ma/adblock
if [ -f "$zip" ]; then python3 -I /var/tmp/lab/adblock/build-blocker.py build /usr/share/ma/adblock --zip "$zip" >/dev/null
else python3 -I /var/tmp/lab/adblock/build-blocker.py build /usr/share/ma/adblock >/dev/null; fi
chown -R root:root /usr/share/ma/adblock; chmod 0644 /usr/share/ma/adblock/*
sed -i "s/__BLOCKER_ID__/$(cat /usr/share/ma/adblock/blocker-id)/g" /etc/ma/chromium-adblock.json
python3 -I -c 'import itertools, json, sys; d = {f: set(json.load(open(f))) for f in sys.argv[1:]}; s = [(a, b, sorted(d[a] & d[b])) for a, b in itertools.combinations(d, 2) if d[a] & d[b]]; sys.exit("shared keys: %s" % s if s else 0)' \
  /etc/chromium/policies/managed/ma.json /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json
/usr/local/lib/ma/desk-adblock render
systemctl daemon-reload
echo "applied: $(sha256sum /usr/local/lib/ma/desk-adblock | cut -c1-12), blocker $(cat /usr/share/ma/adblock/blocker-id), policy $(stat -c '%U:%G %a' /etc/chromium/policies/managed/ma-adblock.json)"
