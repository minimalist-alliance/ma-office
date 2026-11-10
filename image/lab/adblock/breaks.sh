#!/bin/bash
# breaks.sh [out]: each part of verify-adblock.sh, first as it is, then with what it guards broken, on a lab box with this
# branch's ad blocking (apply.sh, or a box from a test bake). A part passes when it prints "ran to the end" and no FAILED.
# Every break is proved in place before its part runs (a break that didn't take would pass as "caught"), and undone after.
# Output: the evidence file. verify.sh 6c's own break is break-swap.sh (it needs a root replacement).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
L=$HERE/lab.sh
OUT=${1:-$HERE/../../evidence/adblock-2026-11-07/breaks.txt}
mkdir -p "$(dirname "$OUT")"
H=/usr/local/lib/ma/desk-adblock P=/etc/chromium/policies/managed/ma-adblock.json T=/etc/ma/chromium-adblock.json
PARTS="install switch restart stopped kill cookies hostile keys"
run() { # run <label> <part> <want: pass|fail>
  local o; o=$("$L" verify "$2" 2>&1)
  local got=pass; { grep -q '^FAILED$' <<<"$o" || ! grep -q '^ran to the end$' <<<"$o"; } && got=fail
  local mark=OK; [ "$got" = "$3" ] || mark=UNEXPECTED
  printf '%s  %-10s %-55s wanted %s, got %s\n' "$mark" "$2" "$1" "$3" "$got" | tee -a "$OUT"
  grep -E '^BAD|took|in [0-9.]+ s|version|byte-identical' <<<"$o" | head -6 | sed 's/^/      /' >> "$OUT"
}
sh() { "$L" sh "$*" >/dev/null 2>&1; }
took() { # took <proof>: a command that succeeds only with the break in place
  if "$L" sh "$1" >/dev/null 2>&1; then echo "      break in place: $1" >> "$OUT"; else echo "UNEXPECTED  the break didn't take: $1" | tee -a "$OUT"; fi; }
pol() { # pol <python on d, the policy as JSON>: edit the policy file itself, behind the helper's back, as root
  sh "python3 -I -c 'import json, os; p=\"$P\"; d=json.load(open(p)); i=next(iter(d[\"ExtensionSettings\"])); $1; json.dump(d, open(p, \"w\")); os.chown(p, 0, 1102); os.chmod(p, 0o640)'"; }
echo "# verify-adblock.sh on the lab box, $(date -u '+%F %H:%M UTC'): each part as it is, then broken" > "$OUT"
for p in $PARTS; do run "as built" "$p" pass; done
sh "cp $H /var/tmp/h.orig; cp $T /var/tmp/t.orig; cp /etc/chromium/policies/managed/ma.json /var/tmp/ma.orig"
undo() { sh "install -m 0755 /var/tmp/h.orig $H; install -m 0644 /var/tmp/t.orig $T; install -m 0644 /var/tmp/ma.orig /etc/chromium/policies/managed/ma.json; rm -rf /etc/systemd/system/desk-browser.service.d/break.conf /var/tmp/ab-jar-break /data/.ma-adblock-off; systemctl daemon-reload; $H render"; }
# install
pol 'd.pop("ExtensionSettings")'; sh "sleep 8"   # Chromium's own watcher takes about 5 s to see it
took "! grep -q ExtensionSettings $P"
run "no force-install in the policy" install fail; undo; sh "sleep 8"; run "(back)" install pass
pol 'd["ExtensionSettings"][i]["update_url"] = "https://clients2.google.com/service/update2/crx"; d["ExtensionSettings"][i].pop("override_update_url")'; sh "sleep 8"
took "grep -q clients2.google.com $P"
run "updates from the Web Store, not the image" install fail; undo; sh "systemctl restart desk-browser; sleep 5"
sh "python3 -I -c 'import json; p=\"$T\"; d=json.load(open(p)); d.pop(\"DeveloperToolsAvailability\"); json.dump(d, open(p, \"w\"))'; $H render"
took "! grep -q DeveloperToolsAvailability $P"
run "no DeveloperToolsAvailability" install fail; undo
# switch
sh "sed -i 's/^    return sites, dropped\$/    return [], dropped/' $H"
took "grep -q '^    return \[\], dropped\$' $H"
run "render ignores the list" switch fail; undo
sh "sed -i -e 's/^    if not isinstance(state, dict):\$/    return True\n    if not isinstance(state, dict):/' -e \"s/^    b.value(\\\"chrome.send('reloadPolicies'), 1\\\", pol)\$/    pass/\" $H"
took "grep -q '^    return True\$' $H && ! grep -q reloadPolicies.,\\ 1 $H"
run "apply neither asks Chromium nor checks the blocker" switch fail; undo
# Not a break here: "apply leaves its page open". Its page is a hidden target, which Chromium closes with the connection that
# made it (measured), so a helper that never closes it, or is killed, still leaves none. The check stays for a Chromium
# that falls back to a background tab.
# restart
sh "mkdir -p /etc/systemd/system/desk-browser.service.d; printf '[Service]\nExecStartPre=\nExecStartPre=+/usr/local/lib/ma/desk-browser-policy\nExecStartPre=+/bin/cp $T $P\n' > /etc/systemd/system/desk-browser.service.d/break.conf; systemctl daemon-reload"
took "systemctl cat desk-browser | grep -q '^ExecStartPre=+/bin/cp'"
run "a start puts back the template, forgetting the list" restart fail; undo
# stopped
sh "mkdir -p /etc/systemd/system/desk-browser.service.d; printf '[Service]\nExecStartPre=\nExecStartPre=+/usr/local/lib/ma/desk-browser-policy\n' > /etc/systemd/system/desk-browser.service.d/break.conf; systemctl daemon-reload"
took "! systemctl show -p ExecStartPre desk-browser | grep -q desk-adblock"
run "no render before a start" stopped fail; undo
# kill
sh "sed -i 's/^    return True   # set\$/    return False  # set/' $H"
took "grep -q '^    return False  # set\$' $H"
run "the kill switch is ignored" kill fail; undo
# cookies (its own sensitivity: the test page itself changes a cookie)
sh ": > /var/tmp/ab-jar-break"
took "test -e /var/tmp/ab-jar-break"
run "a page that changes a seeded cookie" cookies fail; undo
# hostile
sh "sed -i 's/os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd/os.O_RDONLY | os.O_NONBLOCK, dir_fd=dir_fd/' $H"
took "! grep -q 'O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd' $H"
run "the list is read through a symlink" hostile fail; undo
sh "sed -i 's/os.fchmod(fd, 0o640)/os.fchmod(fd, 0o644)/' $H"
took "grep -q 'os.fchmod(fd, 0o644)' $H"
run "the policy is readable by every user (T47S-3)" hostile fail; undo
sh "sed -i 's/os.fchmod(fd, 0o640)/os.fchmod(fd, 0o666)/' $H"
took "grep -q 'os.fchmod(fd, 0o666)' $H"
run "the policy is written world-writable" hostile fail; undo
# keys
sh "python3 -I -c 'import json; p=\"/etc/chromium/policies/managed/ma.json\"; d=json.load(open(p)); d[\"DeveloperToolsAvailability\"]=1; json.dump(d, open(p, \"w\"))'"
took "grep -q DeveloperToolsAvailability /etc/chromium/policies/managed/ma.json"
run "ma.json shares a key with the template" keys fail; undo
for p in $PARTS; do run "as built, after every break" "$p" pass; done
grep -c '^OK' "$OUT" | sed 's/^/as expected: /' | tee -a "$OUT"; grep -c '^UNEXPECTED' "$OUT" | sed 's/^/unexpected: /' | tee -a "$OUT"
