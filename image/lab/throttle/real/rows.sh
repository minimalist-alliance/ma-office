# TEST ONLY. ADR 0036 section 6 on a desk of its own, the real stack: the desk's side of each row, as root. Sourced
# after ../tests/common.sh (PEER is the client box, which drops UDP 9100 and runs net.py's sinks).
#   ROW=noshaper|idle|kiosk-on|kiosk100-on|kiosk-off|empty-on|empty-off|profile-normal|profile-capped|profile-deep|stateprep|tc|state
. /var/tmp/lab/lab/throttle/tests/common.sh
ROW=${ROW:?}
rates() { tc -j class show dev $DEV 2>/dev/null | jq -r '[.[]|select(.class=="htb")|"\(.handle) \(.rate*8/1e6)"]|join(", ")'; }
fresh() { systemctl stop desk-egress; rm -f /data/desk-egress/state.json; systemctl start desk-egress; sleep 2; }
bg() { local name=$1; shift; nohup "$@" > /var/tmp/rows-$name.out 2>&1 & echo $! > /var/tmp/rows-$name.pid; }
bgkill() { [ -s /var/tmp/rows-$1.pid ] && { kill "$(cat /var/tmp/rows-$1.pid)" 2>/dev/null; rm -f /var/tmp/rows-$1.pid; }; true; }
waitfor() { local i; for i in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }
case $ROW in
noshaper) bgkill kiosk; bgkill up; shaper_off >/dev/null; echo "root qdisc: $(tc qdisc show dev $DEV root | cut -c1-40); desk-egress $(systemctl is-active desk-egress)" ;;
idle) bgkill kiosk; bgkill up; egress_conf >/dev/null; fresh; /opt/ma/desk-egress/current/desk-egress --check && echo "shaper on: $(rates)" ;;
kiosk-on) bg kiosk setpriv --reuid=1102 --regid=1102 --clear-groups $NET udp-send "$PEER" 9100 150 1500; sleep 3; echo "kiosk sending 150 Mbps offered; $(rates)" ;;
kiosk100-on) bg kiosk setpriv --reuid=1102 --regid=1102 --clear-groups $NET udp-send "$PEER" 9100 100 1500; sleep 3; echo "kiosk sending 100 Mbps (a control: what the shaper lets through, with no shaper)" ;;
kiosk-off) bgkill kiosk; sleep 1; tail -c 300 /var/tmp/rows-kiosk.out | tail -1 | cut -c1-200 ;;
empty-on)
  egress_conf tick_seconds=5 bucket_gb=0.3 | sed 's/^ *//'; fresh
  bg up setpriv --reuid=1102 --regid=1102 --clear-groups $NET tcp-up "$PEER" 5002 1500
  if waitfor '[ "$(jq -r .slowed /data/desk-egress/state.json 2>/dev/null)" = true ]' 120; then echo "slowed: $(rates); state $(jq -c '{level, slowed}' /data/desk-egress/state.json)"
  else echo "NOT SLOWED after 120 s: $(rates)"; fi ;;
empty-off) bgkill up; egress_conf >/dev/null; fresh; echo "back: $(rates)" ;;
profile-normal) egress_conf >/dev/null; fresh; echo "profile $(cat /run/desk-egress/profile 2>/dev/null || echo normal-none)" ;;
profile-capped|profile-deep)
  if [ $ROW = profile-capped ]; then egress_conf tick_seconds=5 capped_day_gb=0.0001 | sed 's/^ *//'
  else egress_conf tick_seconds=5 capped_day_gb=0.0001 deep_day_gb=0.0002 deep_day_release_gb=0.0001 | sed 's/^ *//'; fi
  fresh; want=${ROW#profile-}
  # an idle desk sends too little to cross even these lines; 2.5 MB from kiosk does, so the profile is set before the viewer comes
  setpriv --reuid=1102 --regid=1102 --clear-groups $NET udp-send "$PEER" 9100 10 2 >/dev/null
  waitfor '[ "$(cat /run/desk-egress/profile 2>/dev/null)" = '$want' ]' 60 && echo "profile $want" || echo "PROFILE NOT $want: $(cat /run/desk-egress/profile 2>&1)" ;;
stateprep)  # test 4's state checks: slowed and deep, with this month's bytes, before a reboot and a stop and wake
  egress_conf tick_seconds=5 bucket_gb=0.3 capped_day_gb=0.0001 deep_day_gb=0.0002 deep_day_release_gb=0.0001 | sed 's/^ *//'; fresh
  bg up setpriv --reuid=1102 --regid=1102 --clear-groups $NET tcp-up "$PEER" 5002 120
  waitfor '[ "$(jq -r .slowed /data/desk-egress/state.json 2>/dev/null)" = true ]' 120 || echo "NOT SLOWED after 120 s"
  bgkill up; sleep 6
  echo "before: $(rates); profile $(cat /run/desk-egress/profile); state $(jq -c '{level, slowed, profile, month, month_bytes, updated}' /data/desk-egress/state.json)" ;;
tc) $NET tc $DEV ;;
state) echo "rates: $(rates); profile $(cat /run/desk-egress/profile 2>&1); state $(jq -c '{level, slowed, clamped, profile, month_bytes}' /data/desk-egress/state.json 2>&1)" ;;
*) echo "unknown row $ROW"; exit 2 ;;
esac
