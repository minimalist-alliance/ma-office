#!/bin/bash
# Turns a fresh Debian 13 (amd64) machine into a self-hosted desk, then pairs it with a member's office.
# Guide: selfhost/README.md. Run as root, from a checkout of this repository, with a release bundle:
#
#   selfhost/install.sh --bundle <dir> [--env staging|prod] [--address auto|<ipv4>] [--port <n>] [--keep-ssh]
#                       [--allow-home-network] [--no-pair] [--yes] [--version <label>]
#   selfhost/install.sh --bundle <dir>       on a desk that's installed: updates it to this installer and bundle, and
#                                            keeps its settings (below)
#
#   --bundle DIR           the release bundle: desk-rtc, desk-stream, deskd, desk-agent-filter and desk-notebook for amd64,
#                          and bundle.pin with their sha256s (selfhost/build-bundle.sh makes one; an older bundle has no
#                          desk-notebook, and one with no desk-agent-filter is refused)
#   --env                  which platform to pair with (default staging; prod isn't open yet)
#   --address              the address the member's browser reaches this desk on. Default auto: this machine's address
#                          on its home network. Give a forwarded public address only if you've forwarded UDP and TCP
#                          --port to this machine, on the same port number.
#   --port                 the port the member's browser reaches the desk's stream on, UDP and TCP (default 4443). 1024
#                          or above: Chrome refuses a home-network address on a lower port. 443 only with a public --address.
#   --keep-ssh             let SSH in from the home network (the firewall otherwise allows only the desk's --port);
#                          --no-keep-ssh closes it again
#   --allow-home-network   let the desk's Browser reach your home network (by default it can't);
#                          --no-allow-home-network undoes it
#   --yes                  don't ask at the end of pairing whether the office shown (partly hidden) is yours
#   --no-pair              don't wait here for the code (ma-selfhost still asks for one); `ma-selfhost pair --wait` shows it
#
# It follows image/recipe/build.sh, the cloud desk's recipe, step for step, and reuses its files. The differences, each
# with its reason, are in selfhost/README.md, "How it differs from a cloud desk".
#
# Updating: run it again with a newer installer and bundle. It keeps /data, the pairing and the browser profile, and
# the settings the desk has (--env, --address, --port, --keep-ssh, --allow-home-network) unless given again. A desk
# installed before these were recorded (desk-rtc 0.3.0-sh1's bundles) has them read from its files: the port from
# /etc/ma/desk-rtc-port, SSH and the home network from its firewall rules.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HERE=$(cd "$(dirname "$0")" && pwd)
RECIPE=$(cd "$HERE/../image/recipe" && pwd)
step() { echo; echo "==== $* ===="; }
die() { echo "install.sh: ERROR: $*" >&2; exit 1; }
# Never stop without saying where (set -e alone exits silently).
trap 'echo "install.sh: ERROR: stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

# Empty: not given. An installed desk's own setting fills it, or else the default.
BUNDLE="" ENV="" ADDRESS="" PORT="" KEEP_SSH="" ALLOW_HOME="" PAIR=1 LABEL="" YES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLE=$2; shift 2 ;;
    --env) ENV=$2; shift 2 ;;
    --address) ADDRESS=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --keep-ssh) KEEP_SSH=1; shift ;;
    --no-keep-ssh) KEEP_SSH=0; shift ;;
    --allow-home-network) ALLOW_HOME=1; shift ;;
    --no-allow-home-network) ALLOW_HOME=0; shift ;;
    --no-pair) PAIR=0; shift ;;
    --yes) YES=--yes; shift ;;
    --version) LABEL=$2; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
PORT_TOOL=$HERE/files/usr/local/lib/ma/selfhost/ma-selfhost-port

# An installed desk: what it was installed with. /etc/ma/selfhost.conf has env and address, and from this installer on,
# keep_ssh and allow_home_network; desk-rtc's port is in /etc/ma/desk-rtc.conf, or an older bundle's /etc/ma/desk-rtc-port.
UPGRADE=0
if [ -f /etc/ma/selfhost.conf ]; then
  UPGRADE=1
  setting() { sed -n "s/^$1=//p" /etc/ma/selfhost.conf | tail -1; }
  had_env=$(setting env) had_address=$(setting address) had_ssh=$(setting keep_ssh) had_home=$(setting allow_home_network)
  had_port=$( (sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*\([0-9]*\)[[:space:]]*$/\1/p' /etc/ma/desk-rtc.conf 2>/dev/null || true) | tail -1)
  [ -n "$had_port" ] || had_port=$(cat /etc/ma/desk-rtc-port 2>/dev/null || true)
  # Older installs: --keep-ssh kept the #SSH lines in the firewall, and --allow-home-network removed the #HOME ones.
  if [ -z "$had_ssh" ] && [ -f /etc/nftables.conf ]; then grep -q ' #SSH$' /etc/nftables.conf && had_ssh=1 || had_ssh=0; fi
  if [ -z "$had_home" ] && [ -f /etc/nftables.conf ]; then grep -q ' #HOME$' /etc/nftables.conf && had_home=0 || had_home=1; fi
  ENV=${ENV:-$had_env} ADDRESS=${ADDRESS:-$had_address} PORT=${PORT:-$had_port}
  KEEP_SSH=${KEEP_SSH:-$had_ssh} ALLOW_HOME=${ALLOW_HOME:-$had_home}
fi
ENV=${ENV:-staging} ADDRESS=${ADDRESS:-auto} PORT=${PORT:-4443} KEEP_SSH=${KEEP_SSH:-0} ALLOW_HOME=${ALLOW_HOME:-0}

step "checks"
[ "$(id -u)" = 0 ] || die "run as root"
[ "$(dpkg --print-architecture)" = amd64 ] || die "needs an x86-64 (amd64) computer; this one is $(dpkg --print-architecture)"
. /etc/os-release
[ "${VERSION_ID:-}" = 13 ] && [ "${ID:-}" = debian ] || die "needs Debian 13; this is ${PRETTY_NAME:-unknown}"
case "$ENV" in staging|prod) ;; *) die "--env is staging or prod" ;; esac
[ "$ADDRESS" = auto ] || [[ $ADDRESS =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "--address is auto or an IPv4 address"
# Chrome drops a home-network (private) ICE candidate on a port below 1024; a public address is fine on 443.
sh "$PORT_TOOL" check "$PORT" "$ADDRESS" || die "--port $PORT can't work here (above)"
[ -n "$BUNDLE" ] && [ -f "$BUNDLE/bundle.pin" ] || die "--bundle <dir> with a bundle.pin in it is required"
BUNDLE=$(cd "$BUNDLE" && pwd)
cores=$(nproc); mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$cores" -ge 2 ] || die "needs at least 2 cores (has $cores)"
[ "$mem_mb" -ge 3500 ] || die "needs at least 4 GB of memory (has $mem_mb MB)"
rootsrc=$(findmnt -n -o SOURCE /); rootpk=$(lsblk -no PKNAME "$rootsrc" | head -1); [ -n "$rootpk" ] || rootpk=$(basename "$rootsrc")
others=$(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}' | grep -E '/dev/(nvme[0-9]+n[0-9]+|xvd[a-z]+|sd[a-z]+|vd[a-z]+)$' | grep -v -x "/dev/$rootpk" || true)
[ "$(echo "$others" | grep -c .)" = 1 ] || die "needs exactly one disk besides the system disk, for the desk's data (found: ${others:-none}). See README.md, \"What it needs\""
case "$others" in /dev/vd*) die "the data disk is $others, which the desk's first boot doesn't look for. Use a SCSI or SATA virtual disk (README.md, \"What it needs\")" ;; esac
echo "data disk: $others (formatted only if blank; an existing desk's data is kept)"
# The bundle: one line per component, version and sha256, and each file must hash to it.
declare -A VER SHA FILE
while read -r comp ver sha extra; do
  case "$comp" in ''|'#'*) continue ;; esac
  [[ $comp =~ ^(desk-rtc|desk-stream|deskd|desk-agent-filter|desk-notebook)$ && $ver =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && $sha =~ ^[0-9a-f]{64}$ && -z $extra ]] || die "bad line in bundle.pin: $comp"
  # || true: with pipefail, ls finding nothing would stop the script here, before the message below.
  f=$(ls "$BUNDLE"/"$comp-$ver"*.tgz 2>/dev/null | head -1 || true)
  [ -n "$f" ] || die "bundle has no $comp-$ver*.tgz"
  echo "$sha  $f" | sha256sum -c --status || die "$(basename "$f") doesn't hash to its sha256 in bundle.pin"
  VER[$comp]=$ver SHA[$comp]=$sha FILE[$comp]=$f
done < "$BUNDLE/bundle.pin"
for c in desk-rtc desk-stream deskd desk-agent-filter; do [ -n "${VER[$c]:-}" ] || die "bundle.pin has no $c"; done
[ "${VER[desk-rtc]}" != 0.2.0 ] || die "desk-rtc 0.2.0 must never run on a desk"
# desk-notebook is optional here, as in the image's releases.pin: a bundle from before it installs as it did, and
# Notebook's unit is skipped by its condition. build-bundle.sh refuses to build a bundle without it. With it, deskd must
# be a release that reaches it, through /run/desk-notebook (build-bundle.sh checks the same before it builds).
if [ -n "${VER[desk-notebook]:-}" ]; then
  deskd_run=$(tar -xzOf "${FILE[deskd]}" run 2>/dev/null || true)
  grep -q -- '-v /run/desk-notebook:/run/desk-notebook' <<<"$deskd_run" \
    || die "this bundle's deskd ${VER[deskd]} can't reach desk-notebook (its run doesn't mount /run/desk-notebook). Use a bundle from build-bundle.sh"
fi
echo "bundle: desk-rtc ${VER[desk-rtc]}, desk-stream ${VER[desk-stream]}, deskd ${VER[deskd]}, desk-agent-filter ${VER[desk-agent-filter]}, desk-notebook ${VER[desk-notebook]:-none}"
if [ "$UPGRADE" = 1 ]; then
  installed() { cat "/opt/ma/$1/current/VERSION" 2>/dev/null || echo none; }
  echo "updating this desk from desk-rtc $(installed desk-rtc), desk-stream $(installed desk-stream), deskd $(installed deskd), desk-agent-filter $(installed desk-agent-filter), desk-notebook $(installed desk-notebook)"
  echo "settings: --env $ENV --address $ADDRESS --port $PORT, SSH from your home network $([ "$KEEP_SSH" = 1 ] && echo on || echo off), the Browser's access to your home network $([ "$ALLOW_HOME" = 1 ] && echo on || echo off)"
fi

step "users (the cloud desk's fixed uids, plus selfhost)"
for spec in desk:1100 rtc:1101 kiosk:1102 agent:1103 stream:1104 notebook:1105 agent-filter:1106 selfhost:1110; do
  n=${spec%%:*}; u=${spec##*:}
  getent group "$n" >/dev/null || groupadd -g "$u" "$n"
  id "$n" >/dev/null 2>&1 || useradd -u "$u" -g "$u" -M -d /nonexistent -s /usr/sbin/nologin "$n"
  [ "$(id -u "$n")" = "$u" ] || die "user $n has the wrong uid"
done

step "packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  docker.io docker-cli chromium \
  xserver-xorg-core xserver-xorg-video-dummy x11-xserver-utils x11-utils x11-xkb-utils xkb-data xdotool \
  pulseaudio pulseaudio-utils \
  gstreamer1.0-tools gstreamer1.0-x gstreamer1.0-pulseaudio python3-gi gir1.2-gstreamer-1.0 libyuv0 \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  nftables chrony zram-tools unattended-upgrades apt-listchanges \
  jq curl ca-certificates gnupg e2fsprogs util-linux iproute2 fonts-liberation fonts-noto-color-emoji fonts-noto-core fonts-noto-cjk \
  python3 python3-cryptography systemd-resolved
command -v docker >/dev/null || die "docker CLI missing"
chromium_version=$(dpkg-query -W -f='${Version}' chromium); chromium_version=${chromium_version#*:}; chromium_version=${chromium_version%%-*}
for el in ximagesrc videoconvert x264enc rtph264pay rtpstreampay funnel fdsink pulsesrc audioconvert audioresample opusenc rtpopuspay; do
  gst-inspect-1.0 "$el" >/dev/null || die "GStreamer element $el is missing"
done
python3 -I -c 'import gi; gi.require_version("Gst", "1.0"); from gi.repository import Gst' || die "GStreamer Python bindings are missing"
# ADR 0036, as build.sh: gst-ptp-helper ships with cap_net_admin, and nothing on a desk uses PTP clocks. Root only.
PTP_HELPER=/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo x86_64-linux-gnu)/gstreamer1.0/gstreamer-1.0/gst-ptp-helper
[ -e "$PTP_HELPER" ] || die "no gst-ptp-helper at $PTP_HELPER"
dpkg-statoverride --list "$PTP_HELPER" >/dev/null || dpkg-statoverride --update --add root root 0700 "$PTP_HELPER"

step "install files (the cloud desk's, then this desk's own)"
# The cloud recipe's files, less the three a self-hosted desk has its own of (selfhost/files) and the outbound shaper's
# budgets, which guard our cloud bill and have nothing to guard here (README.md).
(cd "$RECIPE/files" && find . \( -type f -o -type l \) ! -path ./etc/nftables.conf ! -path ./etc/chrony/chrony.conf ! -path ./etc/ma/egress.conf -print0 \
  | tar --null --no-recursion --owner=0 --group=0 -T - -cf -) | tar -C / -xf -
(cd "$HERE/files" && find . \( -type f -o -type l \) ! -path "*/__pycache__/*" -print0 | tar --null --no-recursion --owner=0 --group=0 -T - -cf -) | tar -C / -xf -
chmod 0644 /etc/ma/agent-egress.conf
chmod 0755 /opt/ma/smoke-test /opt/ma/bin/ma-update /usr/local/lib/ma/desk-firstboot /usr/local/lib/ma/desk-datadirs \
  /usr/local/lib/ma/desk-units /usr/local/lib/ma/desk-browser-start /usr/local/lib/ma/desk-xorg-ready /usr/local/lib/ma/desk-preread \
  /usr/local/lib/ma/desk-browser-policy /usr/local/lib/ma/desk-adblock \
  /usr/local/lib/ma/selfhost/ma-selfhost /usr/local/lib/ma/selfhost/ma-selfhost-prep /usr/local/lib/ma/selfhost/ma-selfhost-dtls \
  /usr/local/lib/ma/selfhost/ma-selfhost-port /usr/local/sbin/ma-selfhost
# An installed desk's old way for the agent out: address sets filled every 5 min, which these firewall rules no longer have.
systemctl disable --now desk-agent-egress.timer desk-agent-egress.service 2>/dev/null || true
rm -f /etc/systemd/system/desk-agent-egress.timer /etc/systemd/system/desk-agent-egress.service /usr/local/lib/ma/desk-agent-egress
# A teen's Browser lock and the ad blocker's template, as build.sh: both helpers refuse a file anyone but root can write.
chown root:root /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json; chmod 0644 /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json
# The ad blocker (ADR 0076), built from the pinned lists as build.sh builds it (a new id each install, which reinstalls it and
# loses nothing), then its policy, from the member's per-site list if this desk has one already. Rendered again before
# every start of the Browser.
install -d -m 0755 /usr/share/ma/adblock
python3 -I "$RECIPE/adblock/build-blocker.py" build /usr/share/ma/adblock || die "the blocker didn't build"
chown -R root:root /usr/share/ma/adblock; chmod 0644 /usr/share/ma/adblock/*
BLOCKER_ID=$(cat /usr/share/ma/adblock/blocker-id); [[ $BLOCKER_ID =~ ^[a-p]{32}$ ]] || die "the blocker's id: $BLOCKER_ID"
sed -i "s/__BLOCKER_ID__/$BLOCKER_ID/g" /etc/ma/chromium-adblock.json
/usr/local/lib/ma/desk-adblock render || die "desk-adblock couldn't write the policy"
install -d -m 0755 /usr/local/share/doc/ma-selfhost && install -m 0644 "$HERE/README.md" /usr/local/share/doc/ma-selfhost/README.md
# The firewall: the tagged lines go unless asked for. Its port is set below, with desk-rtc's.
nft_tmp=$(mktemp)
cp /etc/nftables.conf "$nft_tmp"
[ "$KEEP_SSH" = 1 ] || sed -i '/ #SSH$/d' "$nft_tmp"
[ "$ALLOW_HOME" = 0 ] || sed -i '/ #HOME$/d' "$nft_tmp"
nft -c -f "$nft_tmp" || die "the firewall rules don't load"
install -m 0644 "$nft_tmp" /etc/nftables.conf; rm -f "$nft_tmp"
install -d -m 0755 /data
systemd-tmpfiles --create /etc/tmpfiles.d/ma.conf
rev=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)
printf 'version=%s\nbuilt=%s\nhosting=self\n' "${LABEL:-selfhost-$rev}" "$(date -u +%FT%TZ)" > /etc/ma-release
{
  echo "# ma-selfhost (selfhost/README.md). Written by install.sh; run it again to change these."
  echo "env=$ENV"
  echo "address=$ADDRESS"
  echo "# install.sh's own, kept when it updates the desk"
  echo "keep_ssh=$KEEP_SSH"
  echo "allow_home_network=$ALLOW_HOME"
} > /etc/ma/selfhost.conf
chmod 0644 /etc/ma/selfhost.conf
# desk-rtc's port: port= in /etc/ma/desk-rtc.conf, which desk-rtc reads (with no file, 443, as on a cloud desk), and the
# firewall's rtc_port. ma-selfhost-port also keeps an older bundle's /etc/ma/desk-rtc-port in step while that desk-rtc
# is still the one installed, so an update that rolls back still listens where it should; after the releases, below,
# it removes that file.
old_port=$(/usr/local/lib/ma/selfhost/ma-selfhost-port 2>/dev/null || echo 443)
/usr/local/lib/ma/selfhost/ma-selfhost-port set "$PORT" --no-restart || die "couldn't set the port"

step "service configuration"
rm -f /etc/chrony/sources.d/*.sources 2>/dev/null || true
# Chromium resolves through systemd-resolved's stub on loopback, so the home-network rule above never blocks its DNS.
systemctl enable --now systemd-resolved
ln -sfn /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
systemctl daemon-reload
systemctl enable nftables chrony zramswap docker unattended-upgrades \
  desk-firstboot.service data.mount desk-datadirs.service desk-rtc.service deskd.service desk-units.socket ma-selfhost.service
# desk-agent, as build.sh: skipped by its condition until a release is installed (this bundle has none yet).
# desk-agent-filter, as build.sh, is its only way out (ADR 0070), and a local disk starts it like any other part.
systemctl enable desk-agent.service desk-agent-filter.service
# desk-notebook, as build.sh: its unit, /run/desk-notebook and /data/notebook come from the recipe's files above. Its
# release comes from the bundle, below; with a bundle from before it, it's skipped by its condition.
systemctl enable desk-notebook.service
# Not on a self-hosted desk: desk-preread (reads a cloud root's blocks once; a local disk has nothing to load) and
# desk-egress (our cloud bill's budgets). Installed but not started at boot, as on a cloud desk: deskd starts these.
systemctl disable desk-preread.service desk-egress.service 2>/dev/null || true
systemctl disable desk-xorg desk-audio desk-browser desk-stream 2>/dev/null || true
systemctl restart nftables chrony

step "yuvconv, as build.sh"
if ! GST_PLUGIN_PATH=/usr/local/lib/ma/gst-plugins gst-inspect-1.0 yuvconv >/dev/null 2>&1; then
  apt-get install -y -q --no-install-recommends gcc libc6-dev pkg-config libgstreamer-plugins-base1.0-dev libyuv-dev
  install -d -m 0755 /usr/local/lib/ma/gst-plugins
  # shellcheck disable=SC2046
  gcc -O2 -Wall -shared -fPIC -o /usr/local/lib/ma/gst-plugins/libgstyuvconv.so "$RECIPE/yuvconv/yuvconv.c" \
    $(pkg-config --cflags --libs gstreamer-video-1.0 gstreamer-base-1.0) -lyuv
  chmod 0755 /usr/local/lib/ma/gst-plugins/libgstyuvconv.so
  apt-get purge -y -q gcc libc6-dev pkg-config libgstreamer-plugins-base1.0-dev libyuv-dev
  apt-get autoremove -y -q --purge
fi
GST_PLUGIN_PATH=/usr/local/lib/ma/gst-plugins gst-inspect-1.0 yuvconv >/dev/null || die "yuvconv doesn't load"

step "the desk's releases, from the bundle"
systemctl restart docker
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || die "docker isn't running"
# desk-notebook goes last. ma-update's smoke test checks every installed component, so a desk-notebook installed but not
# yet running would fail the others' updates. Where it isn't running yet (a new desk, or one from a bundle before it),
# it's only installed here, and starts with the desk below, once /data/notebook is there.
comps="desk-stream desk-rtc deskd desk-agent-filter"
if [ -n "${VER[desk-notebook]:-}" ]; then comps="$comps desk-notebook"; fi
for comp in $comps; do
  rel=/opt/ma/$comp/releases/${VER[$comp]}
  if [ "$(readlink "/opt/ma/$comp/current" 2>/dev/null)" = "$rel" ]; then
    if [ "$(cat "$rel/artifact.sha256" 2>/dev/null)" = "${SHA[$comp]}" ]; then
      echo "$comp ${VER[$comp]}: already installed"
    else
      # ma-update installs a version once. Another build of the same version (a rebuilt bundle) keeps the one installed.
      echo "$comp ${VER[$comp]}: already installed from another build of it; keeping that one"
    fi
    continue
  fi
  if [ -e "/opt/ma/$comp/current" ] && systemctl is-active -q "$comp.service"; then
    # An update of a running desk: ma-update restarts it and rolls back if the smoke test fails.
    /opt/ma/bin/ma-update "$comp" "file://${FILE[$comp]}" "${SHA[$comp]}" </dev/null || die "ma-update couldn't update $comp (it rolled back)"
  else
    MA_INSTALL_ONLY=1 /opt/ma/bin/ma-update "$comp" "file://${FILE[$comp]}" "${SHA[$comp]}" </dev/null || die "ma-update couldn't install $comp"
  fi
done

# Now desk-rtc is this bundle's: the port is in its config alone (an older bundle's file goes).
/usr/local/lib/ma/selfhost/ma-selfhost-port set "$PORT" --no-restart || die "couldn't set the port"
[ "$(/usr/local/lib/ma/selfhost/ma-selfhost-port)" = "$PORT" ] || die "desk-rtc doesn't read port $PORT from /etc/ma/desk-rtc.conf"

step "GStreamer plugin registry, as build.sh"
env HOME=/run/desk-stream GST_REGISTRY_1_0=/usr/local/lib/ma/gst-registry.bin \
  GST_PLUGIN_PATH=/opt/ma/desk-stream/current/gst-plugins:/usr/local/lib/ma/gst-plugins gst-inspect-1.0 yuvconv >/dev/null || die "no plugin registry"
chmod 0644 /usr/local/lib/ma/gst-registry.bin

step "the data disk and the desk's identity"
systemctl start desk-firstboot.service data.mount || die "the data disk didn't come up: journalctl -u desk-firstboot"
# Restart, not start: on a reinstall it ran at boot already, and a newer recipe may want a directory more (/data/agent, /data/notebook).
systemctl restart desk-datadirs.service || die "the data disk's directories didn't come up: journalctl -u desk-datadirs"
mountpoint -q /data || die "/data isn't mounted"
systemctl restart ma-selfhost.service
for _ in $(seq 1 30); do [ -s /run/ma-selfhost/status.json ] && break; sleep 1; done

if [ "$PAIR" = 1 ]; then
  step "pairing"
  /usr/local/sbin/ma-selfhost pair --wait $YES || die "not paired. Run install.sh again, with the same options, for a new code"
fi

step "starting the desk"
# A new --port on a running desk: desk-rtc reads it only when it starts. Its DTLS identity on /data/rtc stays the same.
[ "$old_port" = "$PORT" ] || systemctl try-restart desk-rtc.service
# desk-units.socket too: a cloud desk gets it from its first boot, and without it deskd can't start the Browser.
# desk-notebook beside them, as at boot: /data/notebook is there now, and with no release its condition skips it. It and
# deskd don't wait for each other.
systemctl start desk-units.socket desk-agent-filter.service desk-rtc.service desk-notebook.service
# desk-rtc's start hands its DTLS fingerprint to ma-selfhost, which signs it with the desk's key. The platform takes
# deskd's hello only after that (otherwise deskd waits a minute and tries again), so give it a moment first.
if [ "$PAIR" = 1 ]; then
  for _ in $(seq 1 30); do
    grep -qE '"identity": "(signed|unsupported)"' /run/ma-selfhost/status.json 2>/dev/null && break
    sleep 1
  done
fi
systemctl start deskd.service
ok=0 noted=0
for _ in $(seq 1 60); do
  if /opt/ma/smoke-test >/dev/null 2>&1; then ok=1; break; fi
  # One live boot per desk: say once, in plain words, that another copy of this desk is online. It starts by itself later.
  if [ "$noted" = 0 ]; then
    note=$(/usr/local/sbin/ma-selfhost boot-note 2>/dev/null || true)
    if [ -n "$note" ]; then echo; echo "$note"; noted=1; fi
  fi
  sleep 3
done
/opt/ma/smoke-test || true
[ "$ok" = 1 ] || echo "install.sh: the desk's services aren't healthy yet. Check: journalctl -u deskd -u desk-rtc -u desk-notebook -u ma-selfhost" >&2
/usr/local/sbin/ma-selfhost status || true
echo
echo "CHROMIUM_VERSION: $chromium_version"
echo "install.sh: done. The desk is in your office while this computer is on."
