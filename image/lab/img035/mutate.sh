#!/bin/bash
# mutate.sh: break each thing the img035 checks guard, on the lab box (lab.sh, with this tree laid over by lab.sh overlay and
# a deskd with links out), and see its check fail: verify-chromium.sh's parts, and verify-agent-filter.sh's OpenRouter lines.
# Pristine runs come first and last and must fail nothing. Each line of $S/mutations.txt: the break, the part, what was
# expected to fail, yes if it all did, and what failed. Each break is put back before the next. LAB ONLY.
S=${S:?a scratch directory outside the repo}; HERE=$(cd "$(dirname "$0")" && pwd); L=$HERE/lab.sh; I=$(cd "$HERE/../.." && pwd)
OUT=$S/mutations.txt; : > "$OUT"; mkdir -p "$S/m"
VC=$I/verify-chromium.sh AF=$I/verify-agent-filter.sh
$L sh 'rm -rf /var/tmp/mut; mkdir -m 0700 /var/tmp/mut
  cp -a /usr/local/bin/xdg-open /etc/chromium/policies/managed/ma.json /usr/local/lib/ma/desk-browser-policy /usr/local/lib/ma/desk-browser-start \
    /etc/ma/chromium-adult.json /etc/ma/chromium-teen.json /etc/ma/agent-egress.conf /var/tmp/mut/
  echo "originals kept: $(ls /var/tmp/mut | paste -sd" ")"' | tee -a "$OUT"
RESTORE='systemctl stop desk-browser 2>/dev/null; systemctl reset-failed desk-browser 2>/dev/null
cp -a /var/tmp/mut/xdg-open /usr/local/bin/; ln -sfn xdg-open /usr/local/bin/xdg-email; cp -a /var/tmp/mut/ma.json /etc/chromium/policies/managed/
cp -a /var/tmp/mut/desk-browser-policy /var/tmp/mut/desk-browser-start /usr/local/lib/ma/
cp -a /var/tmp/mut/chromium-adult.json /var/tmp/mut/chromium-teen.json /var/tmp/mut/agent-egress.conf /etc/ma/
for f in xdg-open xdg-email; do [ "$(dpkg-divert --truename /usr/bin/$f)" = /usr/share/ma/xdg-utils/$f ] || dpkg-divert --local --rename --divert /usr/share/ma/xdg-utils/$f --add /usr/bin/$f >/dev/null; done
rm -rf /etc/systemd/system/desk-browser.service.d/mut.conf; systemctl daemon-reload
systemd-tmpfiles --create /etc/tmpfiles.d/desk-links.conf; chmod 2750 /run/desk-links
systemctl restart desk-agent-filter'
DESKD_BACK='systemctl restart deskd; for i in $(seq 1 120); do RELEASE_DIR=/opt/ma/deskd/current /opt/ma/deskd/current/health >/dev/null 2>&1 && [ -S /run/desk-links/links.sock ] && break; sleep 1; done'
# run <name> <vc part | af> <expected: FAILED for a verify-chromium part, or F-* ids> <setup> [extra restore]
# ONLY=<regex>: run only the runs whose "<name> <part>" matches (a second pass after a fix to one check).
run() { local name=$1 what=$2 want=$3 setup=$4 extra=${5:-} o=$S/m/$1.txt got ok=yes id
  [ -z "${ONLY:-}" ] || [[ "$name $what" =~ $ONLY ]] || return 0
  o=$S/m/$name-$what.txt
  printf 'systemctl stop desk-browser 2>/dev/null\n%s\n' "$setup" | $L sh 'bash -s' > "$S/m/$name-$what.setup.txt" 2>&1
  if [ "$what" = af ]; then { echo F_LOG_WAIT=0; cat "$AF"; } | $L sh 'bash -s' > "$o" 2>&1
  else $L sh "bash -s -- $what" < "$VC" > "$o" 2>&1; fi
  printf '%s\n%s\n' "$RESTORE" "$extra" | $L sh 'bash -s' > "$S/m/$name-$what.restore.txt" 2>&1
  if [ "$what" = af ]; then
    got=$(sed -n 's/^BAD \([A-Z-]*\):.*/\1/p' "$o" | sort -u | paste -sd,)
    for id in ${want//,/ }; do grep -qw -- "$id" <<<"${got//,/ }" || ok=NO; done
    [ -n "$want" ] || [ -z "$got" ] || ok=NO
  else
    got=$(grep -c '^FAILED$' "$o"); [ "$want" = FAILED ] && { [ "$got" -gt 0 ] || ok=NO; }; [ -z "$want" ] && { [ "$got" = 0 ] || ok=NO; }
    got="$got FAILED: $(grep '^BAD' "$o" | head -3 | cut -c1-110 | paste -sd'|')"
  fi
  grep -q '^ran to the end$' "$o" || got="$got (did not reach the end)"
  printf '%-30s %-6s expected %-22s %-4s got: %s\n' "$name" "$what" "${want:-nothing}" "$ok" "$got" | tee -a "$OUT"
}
POL='python3 -I -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); exec(sys.argv[2]); json.dump(d, open(p, \"w\"), indent=2)"'
for p in links click bands keys jxl; do run "pristine-first-$p" $p "" "true"; done
run pristine-first-filter af "" "true"
run stand-in-gone              links FAILED "rm -f /usr/local/bin/xdg-open /usr/local/bin/xdg-email"
run stand-in-gone              click FAILED "rm -f /usr/local/bin/xdg-open /usr/local/bin/xdg-email"
run xdg-utils-back-on-path     links FAILED "dpkg-divert --rename --remove /usr/bin/xdg-open"
run chromium-session-bus       links FAILED "mkdir -p /etc/systemd/system/desk-browser.service.d; printf '[Service]\nEnvironment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1102/bus\n' > /etc/systemd/system/desk-browser.service.d/mut.conf; systemctl daemon-reload"
run deskd-without-links-dir    links FAILED "rm -rf /run/desk-links; systemctl restart deskd; sleep 15" "$DESKD_BACK"
run links-dir-closed-to-kiosk  click FAILED "chmod 2700 /run/desk-links"
run no-autolaunch-policy       links FAILED "$POL /etc/chromium/policies/managed/ma.json 'del d[\"AutoLaunchProtocolsFromOrigins\"]'"
run no-autolaunch-policy       click FAILED "$POL /etc/chromium/policies/managed/ma.json 'del d[\"AutoLaunchProtocolsFromOrigins\"]'"
run autolaunch-a-seventh       click FAILED "$POL /etc/chromium/policies/managed/ma.json 'd[\"AutoLaunchProtocolsFromOrigins\"].append({\"protocol\": \"ssh\", \"allowed_origins\": [\"*\"]})'"
run helper-allows-every-band   bands FAILED "sed -i 's/^        remove(ADULT)\$/        install(ADULT_POLICY, ADULT)/' /usr/local/lib/ma/desk-browser-policy; grep -c '^        install(ADULT_POLICY, ADULT)' /usr/local/lib/ma/desk-browser-policy"
run empty-allowlist            bands FAILED "$POL /etc/ma/chromium-adult.json 'd[\"ExtensionInstallAllowlist\"] = []'"
run ma-json-no-blocklist       bands FAILED "$POL /etc/chromium/policies/managed/ma.json 'del d[\"ExtensionInstallBlocklist\"]'"
run teen-file-shares-a-key     keys  FAILED "$POL /etc/ma/chromium-teen.json 'd[\"ExtensionInstallAllowlist\"] = []'"
run jxl-switch-gone            jxl   FAILED "sed -i 's/ --disable-features=JXLImageFormat//' /usr/local/lib/ma/desk-browser-start; grep -c JXLImageFormat /usr/local/lib/ma/desk-browser-start"
run jxl-second-disable-features jxl  FAILED "sed -i 's/--remote-debugging-port=9222/--remote-debugging-port=9222 --disable-features=MaVerifyNothing/' /usr/local/lib/ma/desk-browser-start"
run openrouter-unlisted        af    F-UNIT,F-PROV,F-PLACE "sed -i '/^openrouter.ai\$/d' /etc/ma/agent-egress.conf; systemctl restart desk-agent-filter; sleep 1"
run a-fifth-name-listed        af    F-UNIT,F-CF "echo www.cloudflare.com >> /etc/ma/agent-egress.conf; systemctl restart desk-agent-filter; sleep 1"
for p in links click bands keys jxl; do run "pristine-last-$p" $p "" "true"; done
run pristine-last-filter af "" "true"
$L sh 'rm -rf /var/tmp/mut'
echo "mutations: $(grep -c ' yes ' "$OUT") of $(grep -c ' expected ' "$OUT") as expected" | tee -a "$OUT"
