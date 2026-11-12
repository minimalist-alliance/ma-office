#!/bin/bash
# lab.sh: TD-223's lab (ADR 0036's shaper per container, ADR 0072 section 8) on one m7g.xlarge from a host AMI under SlotMode=port, two
# slots and a c7i.xlarge client with Playwright Chrome. TEST ONLY; lab evidence, never a release proof. It drives
# spikes/host-0.1.7/h17.sh (the launch, the fixtures, the probe) with this tree's host files laid over (overlay.sh), as
# lab/restart-oom/host-overlay.sh does for verify-port.sh. Owner tag syseng-td223. Nothing here prints an address.
#   TD_WORK=<dir outside the repo> HOST_AMI=... SHIM_BIN=... BBB_CLIP=... lab.sh
#     h17 <args>                 h17.sh itself (infra-up, client-up, host-up, desks up|down <k>, hours, left, down, sh ...)
#     overlay                    this tree's host files onto the host (no desk up), the unit reloaded; the lab tools to /var/tmp/td223
#     tools                      only the lab tools (up.py, shaperlog.py) to /var/tmp/td223: a host from a baked image that has the shaper
#                                (0.1.11 on), where overlay is skipped
#     sink                       net.py's tcp-sink on the client's TCP 443, and the group opened to it from the host's address only
#     row <label> <secs> <load>[,<load>...]   ADR 0036's test 1 on a shared host, one row: slot 1 plays the clip (probe5, role
#                                video) for <secs> while slots 2, 3, ... each send their <load>: none, or <uid>:<pace Mbit, 0 flat
#                                out> (uid kiosk, desk or root), an ordinary TCP upload to the sink from that slot's network namespace
#                                as the desk's own uid (the s35 kit's flooder step, for the host image); the host samples every
#                                slot's classes, its out_<k> and veth each second. LEAD (100) is the probe's lead; FLOOD_EARLY=1 starts
#                                the uploads before the probe's session, so its first frame after `live` (B13) is taken under them,
#                                and runs them for LEAD + secs + 30 s (default: from 40 s before the window to 40 s after it)
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../.." && pwd)
W=${TD_WORK:?set TD_WORK to a directory outside the repo}; mkdir -p "$W"
export SA_WORK=$W SA_OWNER=${SA_OWNER:-syseng-td223}   # the Guild Engineer's run on 0.1.11: SA_OWNER=guild-td223 SA_PURPOSE=td223-shared SA_SLOTS=6
H17="$R/spikes/host-0.1.7/h17.sh"
st() { set +u; source "$W/state.env"; set -u; }
log() { echo "[td223 $(date +%H:%M:%S)] $*" >&2; }
uid_of() { case "$1" in root) echo 0 ;; desk) echo 1100 ;; kiosk) echo 1102 ;; *) echo "no uid $1" >&2; exit 2 ;; esac; }
case "${1:-}" in
h17) shift; exec "$H17" "$@" ;;
overlay)
  st; t=$(mktemp -d); "$H/overlay.sh" "$t/ov" >/dev/null; cp "$H/up.py" "$H/shaperlog.py" "$t/"
  tar -C "$t" -czf - . | "$H17" sh 'rm -rf ~/td && mkdir -p ~/td && tar -C ~/td -xzf -'; rm -rf "$t"
  "$H17" sh 'set -e; [ -z "$(sudo runc list -q)" ] || { echo "desks are up: not laying the overlay"; exit 1; }
    sudo tar --no-same-owner --no-same-permissions -C ~/td/ov -cf - . | sudo tar --no-same-owner -C / -xf -
    sudo chown -R root:root /usr/local/lib/desk-host; sudo chmod 644 /usr/local/lib/desk-host/desk_egress.py
    sudo install -d -m 755 /var/tmp/td223; sudo install -m 755 ~/td/up.py ~/td/shaperlog.py /var/tmp/td223/
    sudo systemctl daemon-reload; echo "overlay: $(cd ~/td/ov && find . -type f | sort | tr "\n" " ")"
    sudo /usr/local/lib/desk-host/desk-host-check --only shaper --allow-verify-access' ;;
tools)
  tar -C "$H" -czf - up.py shaperlog.py | "$H17" sh 'set -e; rm -rf ~/td && mkdir -p ~/td && tar -C ~/td -xzf -
    sudo install -d -m 755 /var/tmp/td223; sudo install -m 755 ~/td/up.py ~/td/shaperlog.py /var/tmp/td223/; ls /var/tmp/td223' ;;
sink)
  st
  aws ec2 authorize-security-group-ingress --group-id "$SGID" --ip-permissions "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=$SERVER_IP/32}]" >/dev/null 2>&1 || true
  tar -C "$R/image/lab/throttle" -cf - net.py | "$H17" csh 'mkdir -p ~/td && tar -C ~/td -xf -'
  "$H17" csh 'sudo systemctl stop td-sink 2>/dev/null; sudo systemctl reset-failed td-sink 2>/dev/null; sudo systemd-run --unit=td-sink python3 -I /home/ubuntu/td/net.py tcp-sink 443 >/dev/null && sleep 1 && systemctl is-active td-sink' ;;
row)
  st; label=$2; secs=$3; loads=$4; dest="$W/results/$label"; mkdir -p "$dest"
  lead=${LEAD:-100}; IFS=, read -r -a L <<<"$loads"; n=$(( ${#L[@]} + 1 ))
  if [ "${FLOOD_EARLY:-0}" = 1 ]; then wait0=0; dur=$((lead + secs + 30)); else wait0=$((lead - 40)); dur=$((secs + 80)); fi
  "$H17" sh "sudo systemd-run --quiet --unit=td-log-$label --property=StandardOutput=file:/var/tmp/td223/$label.log python3 -I /var/tmp/td223/shaperlog.py $((secs + lead + 60)) $(seq -s ' ' 1 "$n")"
  for i in "${!L[@]}"; do
    k=$((i + 2)); load=${L[$i]}; [ "$load" = none ] && continue
    who=${load%%:*}; pace=${load#*:}; u=$(uid_of "$who"); hu=$((100000 + k * 65536 + u))
    "$H17" sh "sudo systemd-run --quiet --unit=td-up-$label-$k --property=StandardOutput=file:/var/tmp/td223/$label.up$k.json /bin/sh -c 'sleep $wait0; \
      exec nsenter --net=/run/desk-host/ns/$k/net setpriv --reuid=$hu --regid=$hu --clear-groups python3 -I /var/tmp/td223/up.py $CLIENT_IP 443 $dur $([ "$pace" != 0 ] && echo "--pace-mbps $pace")'"
    log "slot $k: $who (host uid $hu) uploads from $wait0 s for $dur s, pace ${pace} Mbit"
  done
  LEAD=$lead "$H17" run "$label" "$secs" video
  sleep 30
  "$H17" sh "sudo cat /var/tmp/td223/$label.log" > "$dest/shaperlog.jsonl"
  for i in "${!L[@]}"; do k=$((i + 2)); [ "${L[$i]}" = none ] || "$H17" sh "sudo cat /var/tmp/td223/$label.up$k.json" > "$dest/upload-$k.json" || true; done
  "$H17" sh "sudo desk-host report" > "$dest/report-after.json"
  log "row $label: $dest" ;;
*) sed -n 2,14p "$0"; exit 2 ;;
esac
