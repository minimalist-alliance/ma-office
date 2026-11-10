#!/bin/bash
# verify-wake.sh <part>: the wake trims on a booted desk (TD-227; image/README.md, "Faster wakes"; docs/interfaces/desk-runtime.md
# section 3). verify.sh pipes this to root on the box once per part (bash -s -- <part>), reboots between some of them, and
# the same file runs on any desk over SSM. It prints BAD <what> and FAILED for each failure, and "ran to the end" last.
# Each part has been seen to fail with what it guards broken: evidence/alliance-wake-2026-11-09/mutations.txt.
#   static    cloud-final's drop-in writes the marker after a good first boot, the network fallback is MAC-free and sorts
#             after netplan's file, and the prewarm unit is enabled with its gates and kill switch
#   first     (right after a reboot with the marker removed) cloud-init really ran this boot, and the marker is there again
#   later     (right after one more reboot) cloud-init ran nothing this boot, the marker is there, the desk has its address
#             from netplan's file, its hostname, and IMDS answers
#   fallback  with netplan's file matching another card, the fallback file takes the card and DHCP gives an address; a safety
#             timer puts netplan's file back whatever happens here
#   boot      (right after a reboot with /data/desk/age-band present) the Browser's units came up by themselves once deskd
#             answered, Chromium answers CDP, desk-stream was left to deskd
#   gates     no age band, a Guild Desk marker, and a refusing `desk-browser-start --check` each leave the Browser stopped
set -u
part=${1:-}
MARK=/etc/cloud/cloud-init.disabled
DROP=/etc/systemd/system/cloud-final.service.d/ma-off-after-first-boot.conf
FALL=/etc/systemd/network/20-ma-dhcp.network
RTNET=/run/systemd/network/10-netplan-ens5.network
STATE=/var/tmp/verify-wake
bad() { echo "BAD: $*"; echo FAILED; }
mkdir -p $STATE

case "$part" in
static)
  [ -f "$DROP" ] && grep -q 'touch /etc/cloud/cloud-init.disabled' "$DROP" || bad "no drop-in on cloud-final that writes the marker"
  systemctl show -p ExecStartPost --value cloud-final.service | grep -q 'cloud-init.disabled' || bad "systemd doesn't see the drop-in's ExecStartPost on cloud-final"
  [ -f "$FALL" ] && grep -Fqx 'Name=en* eth*' "$FALL" && grep -qx 'DHCP=ipv4' "$FALL" || bad "no MAC-free DHCP fallback file"
  grep -q -i 'MACAddress' "$FALL" && bad "the fallback names a MAC address"
  # networkd uses the first file, in name order, that matches: netplan's 10- must come before the fallback's 20-
  [ "$(printf '%s\n' 10-netplan-ens5.network "$(basename $FALL)" | sort | head -1)" = 10-netplan-ens5.network ] || bad "the fallback sorts before netplan's file"
  [ "$(systemctl is-enabled desk-browser-prewarm.service 2>&1)" = enabled ] || bad "desk-browser-prewarm isn't enabled ($(systemctl is-enabled desk-browser-prewarm.service 2>&1))"
  [ -x /usr/local/lib/ma/desk-browser-prewarm ] || bad "the prewarm script isn't executable"
  u=/etc/systemd/system/desk-browser-prewarm.service
  grep -qx 'ConditionPathExists=/data/desk/age-band' $u || bad "prewarm isn't gated on the age band"
  grep -qx 'ConditionPathExists=!/run/ma/guild' $u || bad "prewarm isn't gated off for a Guild Desk"
  grep -qx 'ConditionPathExists=!/data/desk/no-prewarm' $u || bad "prewarm has no kill switch"
  grep -q 'no-prewarm' /usr/local/lib/ma/desk-browser-prewarm || bad "the script doesn't check the kill switch"
  grep -qx 'Type=exec' $u || bad "prewarm holds the boot (not Type=exec)"
  grep -q 'deskd.service' <(systemctl show -p After --value desk-browser-prewarm.service | tr ' ' '\n') || bad "prewarm isn't ordered after deskd"
  for u in desk-xorg desk-audio desk-browser desk-stream; do
    [ "$(systemctl is-enabled $u.service 2>/dev/null)" = enabled ] && bad "$u is enabled: the Browser's units start from prewarm and deskd only"
  done
  ;;
first)
  [ -e "$MARK" ] || bad "no marker after this boot: cloud-final's drop-in didn't write it"
  journalctl -b -u cloud-init-main.service --no-pager -q | grep -q . || bad "cloud-init-main logged nothing this boot: cloud-init didn't run, so this isn't a first boot of the root"
  journalctl -b -u cloud-final.service --no-pager -q | grep -q 'Finished' || bad "cloud-final didn't finish this boot"
  journalctl -b -u cloud-config.service --no-pager -q | grep -q 'Finished' || bad "cloud-config didn't finish this boot"
  [ -f /etc/netplan/50-cloud-init.yaml ] || bad "no netplan file from cloud-init"
  hostname > $STATE/hostname
  ;;
later)
  [ -e "$MARK" ] || bad "no marker: it's gone since the first boot"
  for u in cloud-init-local cloud-init-main cloud-init-network cloud-config cloud-final; do
    [ "$(systemctl is-active $u.service)" = inactive ] || bad "$u.service ran this boot ($(systemctl is-active $u.service))"
    journalctl -b -u $u.service --no-pager -q | grep -q . && bad "$u.service logged this boot"
  done
  journalctl -b -t cloud-init --no-pager -q | grep -q . && bad "cloud-init logged this boot"
  ip -4 -o addr show dev ens5 | grep -q 'inet ' || bad "ens5 has no IPv4 address"
  ip -4 route show default | grep -q 'dev ens5' || bad "no default route on ens5"
  [ "$(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p')" = "$RTNET" ] || bad "ens5 isn't using netplan's file: $(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p')"
  [ "$(hostname)" = "$(cat $STATE/hostname 2>/dev/null)" ] || bad "the host name changed since the first boot"
  tok=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 30' http://169.254.169.254/latest/api/token) && curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id >/dev/null || bad "IMDS doesn't answer"
  echo "boot: $(systemd-analyze | head -1)"
  ;;
fallback)
  [ -f "$RTNET" ] || { bad "no $RTNET to put back"; echo "ran to the end"; exit 0; }
  cp -p "$RTNET" $STATE/netplan.network
  grep -q '^PermanentMACAddress=' "$RTNET" || { bad "netplan's file doesn't match on PermanentMACAddress, so this part can't change the card"; echo "ran to the end"; exit 0; }
  # A card that changed: netplan's file now names another MAC. Whatever happens below, a timer puts the file back and reloads.
  systemd-run --quiet --on-active=75 --unit=verify-wake-restore /bin/sh -c "cp -p $STATE/netplan.network $RTNET; networkctl reload; networkctl reconfigure ens5" || bad "no safety timer, not touching the network"
  systemctl is-active --quiet verify-wake-restore.timer || { bad "the safety timer isn't running"; echo "ran to the end"; exit 0; }
  sed -i 's/^PermanentMACAddress=.*/PermanentMACAddress=02:00:00:00:00:99/' "$RTNET"
  grep -q 'PermanentMACAddress=02:00:00:00:00:99' "$RTNET" || bad "couldn't change the match"
  networkctl reload; networkctl reconfigure ens5
  ok=""
  for _ in $(seq 1 40); do
    f=$(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p')
    if [ "$f" = "$FALL" ] && ip -4 -o addr show dev ens5 | grep -q 'inet '; then ok=1; break; fi
    sleep 0.5
  done
  [ -n "$ok" ] || bad "the card wasn't taken by the fallback ($(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p'))"
  cp -p $STATE/netplan.network "$RTNET"; networkctl reload; networkctl reconfigure ens5
  systemctl stop verify-wake-restore.timer 2>/dev/null
  for _ in $(seq 1 40); do
    [ "$(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p')" = "$RTNET" ] && break
    sleep 0.5
  done
  [ "$(networkctl status ens5 --no-pager 2>/dev/null | sed -n 's/.*Network File: //p')" = "$RTNET" ] || bad "netplan's file wasn't put back"
  ;;
boot)
  # deskd answered, so the script's wait is over; the units then start within a second or two
  for _ in $(seq 1 60); do [ "$(systemctl is-active desk-browser)" = active ] && curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version && break; sleep 1; done
  [ "$(systemctl is-active desk-browser)" = active ] || bad "the Browser wasn't started by the boot ($(systemctl is-active desk-browser))"
  curl -s -m 3 -o /dev/null http://127.0.0.1:9222/json/version || bad "Chromium doesn't answer CDP"
  [ "$(systemctl is-active desk-xorg)" = active ] && [ "$(systemctl is-active desk-audio)" = active ] || bad "desk-xorg or desk-audio isn't up"
  journalctl -b -u desk-browser-prewarm --no-pager -q -o cat | grep -q 'started the Browser' || bad "prewarm's journal line is missing: $(journalctl -b -u desk-browser-prewarm --no-pager -q -o cat | tail -2)"
  journalctl -b -u desk-browser-prewarm --no-pager -q -o cat | grep -q 'desk-stream' && bad "prewarm mentions desk-stream"
  [ "$(systemctl show -p NRestarts --value desk-browser)" = 0 ] || bad "the Browser restarted"
  # ordered after deskd: deskd's container was up first
  d=$(systemctl show -p ActiveEnterTimestampMonotonic --value deskd.service); b=$(systemctl show -p ActiveEnterTimestampMonotonic --value desk-browser.service)
  [ "${d:-0}" -gt 0 ] && [ "${b:-0}" -gt "${d:-0}" ] || bad "desk-browser started before deskd (deskd $d, desk-browser $b)"
  echo "deskd active at ${d} us, desk-browser at ${b} us"
  ;;
gates)
  U=desk-browser-prewarm.service
  BAND=/data/desk/age-band
  stop_browser() { systemctl stop desk-browser desk-audio desk-xorg 2>/dev/null; for _ in $(seq 1 100); do [ "$(systemctl is-active desk-browser)" = inactive ] && break; sleep 0.5; done; }
  [ -f "$BAND" ] || { bad "this part needs $BAND"; echo "ran to the end"; exit 0; }
  cp -p "$BAND" $STATE/age-band
  cleanup() { cp -p $STATE/age-band "$BAND" 2>/dev/null; rm -f /run/ma/guild.verify-wake; [ -f $STATE/start.orig ] && mv -f $STATE/start.orig /usr/local/lib/ma/desk-browser-start; }
  trap cleanup EXIT
  skipped() { systemctl restart "$U" 2>/dev/null; sleep 1; [ "$(systemctl show -p ConditionResult --value $U)" = no ]; }
  # a. no age band
  stop_browser; rm -f "$BAND"
  skipped || bad "prewarm ran with no age band"
  [ "$(systemctl is-active desk-browser)" = inactive ] || bad "the Browser started with no age band"
  cp -p $STATE/age-band "$BAND"
  # b. a Guild Desk marker (a throwaway copy of the real one's name: the unit checks the path alone)
  stop_browser
  existed=0; [ -e /run/ma/guild ] && existed=1
  touch /run/ma/guild
  skipped || bad "prewarm ran on a Guild Desk"
  [ "$(systemctl is-active desk-browser)" = inactive ] || bad "the Browser started on a Guild Desk"
  [ "$existed" = 1 ] || rm -f /run/ma/guild
  # c. desk-browser-start --check refuses (a profile newer than Chromium): nothing starts, and the script still exits 0
  stop_browser
  cp -p /usr/local/lib/ma/desk-browser-start $STATE/start.orig
  printf '#!/bin/sh\nexit 78\n' > /usr/local/lib/ma/desk-browser-start; chmod 0755 /usr/local/lib/ma/desk-browser-start
  systemctl restart "$U"; sleep 3
  [ "$(systemctl is-active desk-browser)" = inactive ] || bad "the Browser started though the check refused"
  [ "$(systemctl show -p Result --value $U)" = success ] || bad "prewarm failed instead of leaving the Browser alone ($(systemctl show -p Result --value $U))"
  journalctl -b -u "$U" --no-pager -q -o cat | tail -3 | grep -q 'refused' || bad "prewarm didn't say it was refused"
  mv -f $STATE/start.orig /usr/local/lib/ma/desk-browser-start
  # d. and with everything right it starts
  systemctl restart "$U"
  for _ in $(seq 1 30); do [ "$(systemctl is-active desk-browser)" = active ] && break; sleep 1; done
  [ "$(systemctl is-active desk-browser)" = active ] || bad "with the gates open, prewarm didn't start the Browser"
  ;;
*)
  bad "unknown part '$part'"
  ;;
esac
echo "ran to the end"
