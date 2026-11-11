#!/bin/bash
# mkart.sh <gen>: a hand-made TEST generation on the lab box (LAB ONLY, as root): g1, plus one small package (sensible-utils)
# repacked from its own .deb at a higher version with one file added, and the chromium package's Version raised in the tree's
# dpkg status only (the binary stays g1's), so the Last Version rule has two Chromium versions to choose between. Packed by
# make_template_artifact.py into /srv/desk-host/lab-art/<gen>/, unsigned: the dev key stays on the workstation, which signs header.json.
set -euo pipefail
G=$1; T=/srv/desk-host/lab-tree-$G; A=/srv/desk-host/lab-art/$G; W=/srv/desk-host/lab-work
CH=${CH:-156.0.8078.80-1~deb13u1}
rm -rf "$T" "$A" "$W"; mkdir -p "$T" "$A" "$W"
t0=$(date +%s)
tar -C /srv/desk-host/templates/g1 --exclude=./.complete -cf - . | tar -C "$T" -xpf - --numeric-owner
apt-get update -q >/dev/null 2>&1 || true   # the lab host's own lists, to download the package
cd "$W"; apt-get download sensible-utils >/dev/null 2>&1
deb=$(ls sensible-utils_*.deb); dpkg-deb -R "$deb" pkg
old=$(sed -n 's/^Version: //p' pkg/DEBIAN/control); new="$old+ma1"
sed -i "s/^Version: .*/Version: $new/" pkg/DEBIAN/control
echo "u77 lab: sensible-utils repacked at $new" > pkg/usr/share/doc/sensible-utils/MA-U77-TEST
(cd pkg && find . -path ./DEBIAN -prune -o -type f -print | sed 's#^\./##' | sort | xargs md5sum > DEBIAN/md5sums)
dpkg-deb -b pkg "sensible-utils_${new}_all.deb" >/dev/null
dpkg-deb -x "sensible-utils_${new}_all.deb" "$T"
python3 -I - "$T/var/lib/dpkg/status" "$new" "$CH" <<'P'
import sys
p, new, ch = sys.argv[1:]
out = []
for st in open(p).read().split("\n\n"):
    lines = st.split("\n")
    name = next((l[9:] for l in lines if l.startswith("Package: ")), None)
    if name in ("sensible-utils", "chromium"):
        lines = [("Version: " + (new if name == "sensible-utils" else ch)) if l.startswith("Version: ") else l for l in lines]
    out.append("\n".join(lines))
open(p, "w").write("\n\n".join(out))
P
cp pkg/DEBIAN/md5sums "$T/var/lib/dpkg/info/sensible-utils.md5sums"
echo "/usr/share/doc/sensible-utils/MA-U77-TEST" >> "$T/var/lib/dpkg/info/sensible-utils.list"
printf 'sensible-utils=%s\nchromium=%s\n' "$new" "$CH" > "$W/plan.txt"
t1=$(date +%s)
DESK_HOST_LIB=/usr/local/lib/desk-host python3 -I /var/tmp/lab/make_template_artifact.py --tree "$T" --gen "$G" --host-image 0.1.10 \
  --base "$(sha256sum /var/lib/desk-host/templates/g1.json | cut -d' ' -f1)" --out "$A" --no-sign --plan "$W/plan.txt" --level "${LEVEL:-10}"
echo "the tree in $((t1 - t0)) s; packed in $(( $(date +%s) - t1 )) s"; ls -l "$A"
