#!/bin/bash
# Desk VM image recipe. Runs as root on a fresh official Debian 13 arm64 AMI; idempotent.
# Usage: build.sh [image-version]    (bake.sh passes the version; Platform's Image Builder may omit it)
# Required input: the releases named in releases.pin, as releases/<component>-<version>.tgz next to this script (or in
# $MA_RELEASES_DIR). bake.sh fetches them, and builds desk-agent-filter's with package-desk-agent-filter.sh; another builder
# must put the same files there.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HERE=$(cd "$(dirname "$0")" && pwd)
IMG_VERSION=${1:-dev}
SSM_AGENT_VERSION=3.3.5700.0
SSM_KEY_FPR=1C5B395CBE5E74E2F1CA21592784DBF388D19D46   # from AWS docs: verify-agent-signature
step() { echo; echo "==== $* ===="; }
die() { echo "build.sh: ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ "$(dpkg --print-architecture)" = arm64 ] || die "arm64 only"
. /etc/os-release
[ "${VERSION_ID:-}" = 13 ] || die "Debian 13 only (got ${PRETTY_NAME:-unknown})"

step "users (fixed uids, section 1)"
# commons (1110) runs commons-server on a Guild Desk. 1107 to 1109 are ADR 0072's (desk-x, desk-snd, desk-dns on a shared host).
for spec in desk:1100 rtc:1101 kiosk:1102 agent:1103 stream:1104 notebook:1105 agent-filter:1106 commons:1110; do
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
  nvme-cli jq curl ca-certificates gnupg e2fsprogs util-linux fonts-liberation fonts-noto-color-emoji fonts-noto-core fonts-noto-cjk \
  cloud-init openssh-server
command -v docker >/dev/null || die "docker CLI missing"
# bake.sh tags the AMI with this (ChromiumVersion). Platform's root-swap preflight compares it with a desk's "Last Version" (ADR 0035).
chromium_version=$(dpkg-query -W -f='${Version}' chromium); chromium_version=${chromium_version#*:}; chromium_version=${chromium_version%%-*}
[[ $chromium_version =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "can't read Chromium's version ($chromium_version)"
# plugin check: everything desk-stream's pipeline uses (runtime spec section 8.2)
for el in ximagesrc videoconvert x264enc rtph264pay rtpstreampay funnel fdsink pulsesrc audioconvert audioresample opusenc rtpopuspay; do
  gst-inspect-1.0 "$el" >/dev/null || die "GStreamer element $el is missing"
done
python3 -I -c 'import gi; gi.require_version("Gst", "1.0"); from gi.repository import Gst' || die "GStreamer Python bindings are missing"
# ADR 0036: libgstreamer1.0-0 gives gst-ptp-helper cap_net_admin as a file capability, so any process without NoNewPrivileges
# (Chromium, as kiosk) could exec it and hold CAP_NET_ADMIN until the helper drops it. Nothing on a desk uses PTP clocks. Root only;
# dpkg keeps a statoverride through upgrades, and the postinst's setuid fallback stays root-only too.
PTP_HELPER=/usr/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-ptp-helper
dpkg-statoverride --list "$PTP_HELPER" >/dev/null || dpkg-statoverride --update --add root root 0700 "$PTP_HELPER"

step "SSM agent $SSM_AGENT_VERSION (signature verified)"
if ! dpkg-query -W -f='${Version}' amazon-ssm-agent 2>/dev/null | grep -q "^$SSM_AGENT_VERSION"; then
  w=$(mktemp -d); trap 'rm -rf "$w"' EXIT
  B=https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/$SSM_AGENT_VERSION/debian_arm64
  curl -fsSL -o "$w/ssm.deb" "$B/amazon-ssm-agent.deb"
  curl -fsSL -o "$w/ssm.deb.sig" "$B/amazon-ssm-agent.deb.sig"
  export GNUPGHOME=$w/gnupg; install -d -m 700 "$GNUPGHOME"
  gpg --batch --import "$HERE/keys/amazon-ssm-agent.asc" 2>/dev/null
  fpr=$(gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}')
  [ "$fpr" = "$SSM_KEY_FPR" ] || die "SSM signing key fingerprint mismatch ($fpr)"
  gpg --batch --verify "$w/ssm.deb.sig" "$w/ssm.deb" || die "SSM agent signature check failed"
  dpkg -i "$w/ssm.deb"
  unset GNUPGHOME
fi
systemctl enable amazon-ssm-agent

step "install files"
(cd "$HERE/files" && find . \( -type f -o -type l \) -print0 \
  | tar --null --no-recursion --owner=0 --group=0 -T - -cf -) | tar -C / -xf -
chmod 0644 /etc/nftables.conf /etc/ma/agent-egress.conf; chmod 0755 /opt/ma/smoke-test /opt/ma/bin/ma-update \
  /usr/local/lib/ma/desk-firstboot /usr/local/lib/ma/desk-datadirs /usr/local/lib/ma/desk-units \
  /usr/local/lib/ma/desk-browser-start /usr/local/lib/ma/desk-xorg-ready /usr/local/lib/ma/desk-preread \
  /usr/local/lib/ma/desk-browser-close /usr/local/lib/ma/desk-browser-policy /usr/local/lib/ma/desk-xauth \
  /usr/local/lib/ma/desk-browser-quit /usr/local/lib/ma/desk-adblock /usr/local/lib/ma/desk-kind /usr/local/lib/ma/desk-guild-net /usr/local/lib/ma/desk-guild-rtc \
  /usr/local/lib/ma/desk-browser-prewarm
# A teen's Browser lock (image/README.md) and the ad blocker's template (ADR 0076): root's alone, and no key in two of the
# three managed files, since Chromium doesn't define which of two wins. Both helpers refuse a file anyone else can write.
chown root:root /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json; chmod 0644 /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json
python3 -I -c 'import itertools, json, sys; d = {f: set(json.load(open(f))) for f in sys.argv[1:]}; s = [(a, b, sorted(d[a] & d[b])) for a, b in itertools.combinations(d, 2) if d[a] & d[b]]; sys.exit("shared keys: %s" % s if s else 0)' \
  /etc/chromium/policies/managed/ma.json /etc/ma/chromium-teen.json /etc/ma/chromium-adblock.json || die "two managed policy files share a key"
# The ad blocker (ADR 0076): built here from uBlock Origin Lite's pinned release (adblock/blocker.pin, its sha256 checked),
# block and allow rules only, signed with a key made and destroyed in this step, so each build has its own id. Chromium
# installs it from file:///usr/share/ma/adblock/update.xml and updates only from there: a new version is a new image.
install -d -m 0755 /usr/share/ma/adblock
python3 -I "$HERE/adblock/build-blocker.py" build /usr/share/ma/adblock || die "the blocker didn't build"
chown -R root:root /usr/share/ma/adblock; chmod 0644 /usr/share/ma/adblock/*
BLOCKER_ID=$(cat /usr/share/ma/adblock/blocker-id); [[ $BLOCKER_ID =~ ^[a-p]{32}$ ]] || die "the blocker's id: $BLOCKER_ID"
sed -i "s/__BLOCKER_ID__/$BLOCKER_ID/g" /etc/ma/chromium-adblock.json
! grep -q __BLOCKER_ID__ /etc/ma/chromium-adblock.json || die "the template still has a placeholder"
# Its policy, with no site off (no /data here), root:kiosk 0640. desk-browser.service renders it again before every start.
/usr/local/lib/ma/desk-adblock render || die "desk-adblock couldn't write the policy"
# desk-data (tools/desk-data, task 32): the read-only root helper behind deskd's data.* methods. Its tmpfiles line is its
# own file, desk-data.conf, so the --create below doesn't make /data/.ma-export-tmp on the root: it's made on the volume
# at boot. bake.sh refuses to bake when these copies differ from tools/desk-data.
chmod 0755 /usr/local/lib/ma/desk-data
install -d -m 0755 /data
systemd-tmpfiles --create /etc/tmpfiles.d/ma.conf
systemd-tmpfiles --create /etc/tmpfiles.d/desk-commons.conf   # its own file, as desk-data.conf is: commons-server's socket directory
printf 'version=%s\nbuilt=%s\n' "$IMG_VERSION" "$(date -u +%FT%TZ)" > /etc/ma-release

step "service configuration"
# chrony replaces systemd-timesyncd (apt removes it); sources come from /etc/chrony/chrony.conf only
rm -f /etc/chrony/sources.d/*.sources 2>/dev/null || true
# zram swap (zram-tools reads /etc/default/zramswap)
# docker: daemon.json is installed above. No bridge networking is used (iptables off).
systemctl daemon-reload
systemctl enable nftables chrony zramswap docker unattended-upgrades \
  desk-firstboot.service data.mount desk-datadirs.service desk-rtc.service deskd.service desk-units.socket desk-preread.service
systemctl enable desk-egress.service
# desk-agent: its pinned release is baked in below (releases.pin, from 0.2.7), so it starts at boot like deskd; without a
# release its unit would be skipped by its condition (image/README.md, desk-agent). desk-agent-filter, likewise baked,
# is its only way out (ADR 0070).
systemctl enable desk-agent.service desk-agent-filter.service
# desk-notebook: baked like desk-agent once releases.pin names it; until then its unit is skipped by its condition.
systemctl enable desk-notebook.service
# The Guild Desk (image/README.md, "Guild Desk"): desk-kind reads the DeskKind tag at every boot and writes /run/ma/guild only
# for an exact "guild". desk-guild-net and commons-server run only with it; the Browser's units are skipped with it (their
# desk-kind.conf drop-ins). commons-server also needs a release: releases.pin's optional line, or a rollout.
systemctl enable desk-kind.service desk-guild-net.service desk-guild-rtc.service commons-data.service commons-server-address.service commons-server.service
# desk-data: socket-activated, one root process per connection, like desk-units (image/README.md, desk-data).
systemctl enable desk-data.socket
# desk-browser-thaw (ADR 0045): wanted by desk-browser and part of its every stop, so a frozen Chromium is thawed before
# systemd signals it, a shutdown's included (image/README.md, "Freezing an unseen desk").
systemctl enable desk-browser-thaw.service
# TD-227 (image/README.md, "Faster wakes"): the Browser's first units start once deskd answers, on a desk that has a session to bring back.
systemctl enable desk-browser-prewarm.service
# >>> desk-batch (S-96; image/README.md, "Desk batches and Debian's updates"). lab/desk-batch/apply.sh runs this block as is.
# The helper, socket-activated for deskd on /run/desk/batch.sock and ticked by its timer; the trusted keys' directories,
# /opt/ma/etc/batch-keys holds exactly Platform's public release key (KMS alias/ma-desk-batch, ECC_NIST_P256), copied from
# files/; /etc/ma/batch-keys.d, the admin's drop-in, is empty; its state. Debian's own apt timers never fire: desk-batch tick runs apt, only while idle or after 72 h with none.
chmod 0755 /usr/local/lib/ma/desk-batch
install -d -m 0755 -o root -g root /opt/ma/etc /opt/ma/etc/batch-keys /etc/ma /etc/ma/batch-keys.d /var/lib/ma /var/lib/ma/batch
install -d -m 0700 -o root -g root /var/lib/ma/batch/pending
chown root:root /opt/ma/etc/batch-keys/*.pem; chmod 0644 /opt/ma/etc/batch-keys/*.pem
# 20auto-upgrades stays as Debian's: selfhost/install.sh copies these files to a member's own machine without this block, so
# Debian's timers still run apt there daily. Here they're masked, and unattended-upgrade, run by desk-batch, doesn't read it.
chmod 0644 /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/51ma-unattended
systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer
systemctl enable desk-batch.timer desk-batch.socket
# <<< desk-batch
# TD-227 (image/README.md, "Faster wakes"): cloud-init off after a desk's first boot. These two are installed here and not from files/,
# because selfhost/install.sh copies all of files/ to a member's own machine, where a drop-in on cloud-final and a DHCP file for
# every wired card have no business. cloud-init stays enabled in the image; the drop-in writes the marker at the end of a first boot.
install -D -m 0644 "$HERE/wake/ma-off-after-first-boot.conf" /etc/systemd/system/cloud-final.service.d/ma-off-after-first-boot.conf
install -D -m 0644 "$HERE/wake/20-ma-dhcp.network" /etc/systemd/network/20-ma-dhcp.network
systemctl daemon-reload
# installed but not started at boot (design 10.3): desk-xorg desk-audio desk-browser desk-stream.
# deskd starts them through /run/desk/units.sock (runtime spec section 8.3).
systemctl disable desk-xorg desk-audio desk-browser desk-stream 2>/dev/null || true
# no sshd in the normal image
systemctl disable ssh.service ssh.socket 2>/dev/null || true

step "yuvconv: the benchmark's GStreamer converter, so stream.conf can name it"
apt-get install -y -q --no-install-recommends gcc libc6-dev pkg-config libgstreamer-plugins-base1.0-dev libyuv-dev
install -d -m 0755 /usr/local/lib/ma/gst-plugins
# shellcheck disable=SC2046
gcc -O2 -Wall -shared -fPIC -o /usr/local/lib/ma/gst-plugins/libgstyuvconv.so "$HERE/yuvconv/yuvconv.c" \
  $(pkg-config --cflags --libs gstreamer-video-1.0 gstreamer-base-1.0) -lyuv
chmod 0755 /usr/local/lib/ma/gst-plugins/libgstyuvconv.so
apt-get purge -y -q gcc libc6-dev pkg-config libgstreamer-plugins-base1.0-dev libyuv-dev
apt-get autoremove -y -q --purge
GST_PLUGIN_PATH=/usr/local/lib/ma/gst-plugins gst-inspect-1.0 yuvconv >/dev/null || die "yuvconv doesn't load"

step "baked releases (releases.pin): installed by ma-update as a rollout lays them out, and never started here"
# A desk boots ready to say hello with nothing rolled onto it (ma-platform ADR 0091: no SSM onto a member's desk). Nothing
# here starts desk-rtc or deskd: their first run makes per-desk state (the DTLS identity on /data/rtc, deskd's container),
# and that has to happen on the desk. Later releases arrive through ma-update; --rollback after one comes back to these.
PIN=$HERE/releases.pin
RELDIR=${MA_RELEASES_DIR:-$HERE/releases}
[ -f "$PIN" ] || die "no releases.pin next to build.sh"
# daemon.json (installed above) applies from here on, as on a desk. deskd's image is loaded now, so no boot ever pulls.
systemctl restart docker
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || die "docker isn't running"
baked=""
while read -r comp ver sha extra; do
  case "$comp" in ''|'#'*) continue ;; esac
  [[ $comp =~ ^[a-z][a-z0-9-]{1,31}$ && $ver =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && $sha =~ ^[0-9a-f]{64}$ && -z $extra ]] \
    || die "bad line in releases.pin: $comp $ver"
  [ "$comp $ver" != "desk-rtc 0.2.0" ] || die "desk-rtc 0.2.0 must never run on this image: characters go missing and a page reloads"
  baked="$baked $comp=$ver=$sha"
  rel=/opt/ma/$comp/releases/$ver
  if [ "$(readlink "/opt/ma/$comp/current" 2>/dev/null)" = "$rel" ] && [ -x "$rel/run" ] \
     && [ "$(cat "$rel/artifact.sha256" 2>/dev/null)" = "$sha" ] \
     && { [ ! -f "$rel/image-id" ] || docker image inspect "$(cat "$rel/image-id")" >/dev/null 2>&1; }; then
    echo "$comp $ver: already installed"; continue
  fi
  art=$RELDIR/$comp-$ver.tgz
  [ -f "$art" ] || die "missing $art: bake.sh fetches it from the release bucket"
  echo "$sha  $art" | sha256sum -c --status || die "$comp-$ver.tgz doesn't hash to the sha256 in releases.pin"
  if [ "$comp" = desk-stream ]; then
    # Its release is packed from recipe/desk-stream (package-desk-stream.sh), so the two must be the same files.
    t=$(mktemp -d); tar -xzf "$art" -C "$t" --no-same-owner; rm -f "$t/VERSION"
    if ! d=$(diff -r "$t" "$HERE/desk-stream" 2>&1); then
      rm -rf "$t"; echo "$d" | head -20
      die "recipe/desk-stream differs from desk-stream $ver: package it with package-desk-stream.sh, publish it, pass it on a test desk, and pin that version"
    fi
    rm -rf "$t"
  fi
  MA_INSTALL_ONLY=1 /opt/ma/bin/ma-update "$comp" "file://$art" "$sha" </dev/null || die "ma-update couldn't install $comp $ver"
  rm -f "$art"
done < "$PIN"
rmdir "$RELDIR" 2>/dev/null || true
for comp in desk-rtc desk-stream deskd desk-agent desk-agent-filter; do
  case " $baked " in *" $comp="*) ;; *) die "releases.pin has no $comp: the image has to boot with it, ready to say hello" ;; esac
done
# Builder state: no container may exist, and Docker's engine ID and network store are made on each desk's first boot
# instead of being shared by every desk from this image.
[ -z "$(docker ps -aq)" ] || die "a container exists on the builder"
docker images --no-trunc --format 'docker image: {{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'
[ "$(docker image inspect -f '{{.Id}}' "$(cat /opt/ma/deskd/current/image-id)")" = "$(cat /opt/ma/deskd/current/image-id)" ] \
  || die "deskd's image-id names no loaded image"
[ "$(docker image inspect -f '{{.Id}}' "$(cat /opt/ma/desk-agent/current/image-id)")" = "$(cat /opt/ma/desk-agent/current/image-id)" ] \
  || die "desk-agent's image-id names no loaded image"
# desk-notebook is optional (releases.pin). Pinned, it's held to the same check, and to an image-id that isn't empty.
notebook_baked=0
case " $baked " in *" desk-notebook="*) notebook_baked=1 ;; esac
# commons-server is optional too: a native binary, no image. With no line nothing is installed and its unit is skipped.
commons_baked=0
case " $baked " in *" commons-server="*) commons_baked=1 ;; esac
if [ "$notebook_baked" = 1 ]; then
  [ -s /opt/ma/desk-notebook/current/image-id ] \
    && [ "$(docker image inspect -f '{{.Id}}' "$(cat /opt/ma/desk-notebook/current/image-id)")" = "$(cat /opt/ma/desk-notebook/current/image-id)" ] \
    || die "desk-notebook's image-id names no loaded image"
fi
systemctl stop docker.socket docker.service containerd.service
rm -f /var/lib/docker/engine-id /etc/docker/key.json /var/lib/docker/network/files/local-kv.db
rm -rf /var/lib/docker/tmp/* /var/lib/docker/buildkit
bad=0
achk() { if ! "$@"; then echo "ASSERT FAILED: $*" >&2; bad=1; fi; }
for cv in $baked; do
  comp=${cv%%=*}; ver=${cv#*=}; sha=${ver#*=}; ver=${ver%%=*}; rel=/opt/ma/$comp/releases/$ver
  achk test "$(readlink "/opt/ma/$comp/current")" = "$rel"
  achk test ! -e "/opt/ma/$comp/previous"
  achk test "$(ls "/opt/ma/$comp/releases")" = "$ver"
  achk test "$(tr -d '[:space:]' < "$rel/VERSION")" = "$ver"
  achk test "$(cat "$rel/artifact.sha256")" = "$sha"   # ma-update reads it to tell a rollout of this same release
  achk test ! -e "$rel/image.tar"
  achk test -z "$(find "/opt/ma/$comp" \( ! -user root -o ! -group root -o -perm /022 \) ! -type l)"
  achk test "$(systemctl show -p ActiveEnterTimestampMonotonic --value "$comp.service")" = 0   # never started here
  echo "BAKED: $comp $ver $(du -sh "$rel" | cut -f1)$([ -f "$rel/image-id" ] && echo " image $(cut -c1-19 "$rel/image-id")")"
done
achk test -z "$(find /data -mindepth 1 2>/dev/null)"          # no DTLS identity, no deskd state
achk test -z "$(ls -A /var/lib/docker/containers 2>/dev/null)"
achk test ! -e /var/lib/docker/engine-id
achk test -z "$(ls -d /var/tmp/ma-update.* 2>/dev/null)"
achk test -z "$(find "$HERE" -name '*.tgz' 2>/dev/null)"
[ "$bad" = 0 ] || die "baked release assertions failed"
echo "docker state: $(du -sh /var/lib/docker | cut -f1) in /var/lib/docker; $(ls /var/lib/docker | paste -sd' ')"

step "GStreamer plugin registry, so a desk's first desk-stream doesn't scan every plugin (image/README.md, First open)"
# desk-stream.service copies this to /run. GStreamer checks each plugin's size and time and rescans only what changed, so
# an update to a plugin, or one a release brings, still works. Same plugin path as desk-stream's run, and the unit's HOME:
# a few plugins name HOME as a dependency, and a different value rescans them, slowly, on a fresh root.
env HOME=/run/desk-stream GST_REGISTRY_1_0=/usr/local/lib/ma/gst-registry.bin \
  GST_PLUGIN_PATH="/opt/ma/desk-stream/current/gst-plugins/$(uname -m):/opt/ma/desk-stream/current/gst-plugins:/usr/local/lib/ma/gst-plugins" gst-inspect-1.0 yuvconv >/dev/null \
  || die "no plugin registry"
chmod 0644 /usr/local/lib/ma/gst-registry.bin

step "first-open read list: a real start of the Browser stack, traced (image/README.md, First open)"
"$HERE/first-open/trace" /usr/local/share/ma/preread.list || die "the Browser stack didn't start for the trace"
chmod 0644 /usr/local/share/ma/preread.list

step "desk-egress (baked release; later ones arrive through ma-update, ADR 0036)"
sha8=$(cat "$HERE/desk-egress/desk-egress" "$HERE/desk-egress/run" "$HERE/desk-egress/health" | sha256sum | cut -c1-8)
rel=/opt/ma/desk-egress/releases/baked-$sha8
install -d -m 0755 "$rel"
install -m 0755 "$HERE/desk-egress/desk-egress" "$HERE/desk-egress/run" "$HERE/desk-egress/health" "$rel/"
echo "baked-$sha8" > "$rel/VERSION"
ln -sfn "$rel" /opt/ma/desk-egress/current
echo "baked desk-egress $sha8"

step "final: lock down and clean (must stay last)"
# 1. no SSH keys, no authorized_keys, sshd disabled
find /root /home /etc/ssh -name 'authorized_keys*' -delete 2>/dev/null || true
rm -f /etc/ssh/ssh_host_*
systemctl disable ssh.service ssh.socket 2>/dev/null || true
# 2. no secrets: root/admin password locked, histories gone
passwd -l root >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/*/.bash_history /root/.viminfo
# 3. cloud-init state, machine identity, logs, caches
cloud-init clean --logs --seed 2>/dev/null || cloud-init clean --logs
rm -rf /var/lib/cloud/* /run/cloud-init 2>/dev/null || true
# TD-227: cloud-init stays on in the image, so a desk's first boot configures it; the drop-in on cloud-final writes this marker at the
# end of that boot. A builder that rebooted after the install above would have written it, and every desk would then skip its first boot.
rm -f /etc/cloud/cloud-init.disabled
rm -rf /home/admin/ma-recipe   # bake.sh's copy of this recipe
# The journal holds every login to this builder with its source address, and this session's own end is still to come.
# So journald moves to /run until the builder stops, and only then do its files go: what's logged after this dies at stop,
# and the drop-in doesn't reach the image. The name sorts after ma.conf, so it wins. Zeroing first keeps the text out of the
# snapshot's free blocks. journald needs the machine ID to restart, so all of this comes before the line that empties it.
install -d -m 0755 /run/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\n' > /run/systemd/journald.conf.d/zz-bake-volatile.conf
systemctl restart systemd-journald
[ ! -d /var/log/journal ] || find /var/log/journal -type f -exec shred -n 0 -z -u {} +
rm -rf /var/log/journal/*
: > /etc/machine-id; rm -f /var/lib/dbus/machine-id
rm -f /var/lib/amazon/ssm/Vault/* 2>/dev/null || true
apt-get clean; rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
# 4. assertions
bad=0
chk() { if ! "$@"; then echo "ASSERT FAILED: $*" >&2; bad=1; fi; }
chk test -z "$(find /root /home /etc/ssh -name 'authorized_keys*' 2>/dev/null)"
chk test -z "$(ls /etc/ssh/ssh_host_* 2>/dev/null)"
chk test "$(systemctl is-enabled ssh.service 2>/dev/null || true)" != enabled
chk test "$(systemctl is-enabled ssh.socket 2>/dev/null || true)" != enabled
chk test -z "$(find /var/lib/cloud -mindepth 1 2>/dev/null)"
chk test ! -e /home/admin/ma-recipe
chk test ! -e /var/log/wtmp.db   # only a login with a pty creates it, and it's world-readable with the login's source address in it
chk test -z "$(find /var/log/journal -mindepth 1 2>/dev/null)"
chk test -n "$(find /run/log/journal -name system.journal 2>/dev/null)"   # journald is writing to /run, so nothing more lands in /var/log/journal
chk test -x /opt/ma/bin/ma-update
chk test -x /opt/ma/smoke-test
chk test -x /opt/ma/desk-stream/current/run
chk test "$(systemctl is-enabled desk-units.socket 2>/dev/null || true)" = enabled
chk test "$(systemctl is-enabled desk-batch.socket 2>/dev/null || true)" = enabled
chk test "$(systemctl is-enabled desk-batch.timer 2>/dev/null || true)" = enabled
chk test "$(systemctl is-enabled apt-daily.timer 2>/dev/null || true)" = masked
chk test "$(systemctl is-enabled apt-daily-upgrade.timer 2>/dev/null || true)" = masked
chk test -x /usr/local/lib/ma/desk-batch
chk test -d /opt/ma/etc/batch-keys -a -d /etc/ma/batch-keys.d -a -d /var/lib/ma/batch/pending
chk test -z "$(ls -A /etc/ma/batch-keys.d)" -a -z "$(ls -A /var/lib/ma/batch/pending)"   # no dev key, no batch, no state in the image (one ls per directory: ls with two prints their names)
chk test "$(ls -A /opt/ma/etc/batch-keys)" = ma-desk-batch-2026-11.pem   # exactly Platform's release key (verify-batch.sh install checks its hash)
chk test ! -e /var/lib/ma/batch/state.json
chk test -z "$(grep -l -r 'PRIVATE KEY' /opt/ma/etc/batch-keys /etc/ma/batch-keys.d 2>/dev/null)"   # only public halves, ever
chk test -L /etc/systemd/system/desk-browser.service.wants/desk-browser-thaw.service
chk test -x /usr/local/lib/ma/desk-browser-quit
chk test "$(systemctl is-enabled desk-preread.service 2>/dev/null || true)" = enabled
chk test -s /usr/local/share/ma/preread.list
chk test -z "$(grep -E '^/(data|home|root|run|tmp|proc|sys|dev)(/|$)' /usr/local/share/ma/preread.list || true)"
chk test ! -e /var/lib/desk-preread/done
chk test -s /usr/local/lib/ma/gst-registry.bin
chk test -x /opt/ma/desk-egress/current/run
chk test "$(stat -c '%U %a' "$PTP_HELPER")" = "root 700"
chk test "$(systemctl is-enabled desk-egress.service 2>/dev/null || true)" = enabled
chk test -x /usr/sbin/tc
chk test -f /etc/ma/egress.conf
chk test "$(stat -c '%U:%G %a' /etc/ma/guild.conf)" = "root:root 644"   # a Guild Desk's tiers (image/README.md, "Guild Desk")
chk test "$(systemctl is-enabled desk-agent.service 2>/dev/null || true)" = enabled
chk test "$(systemctl is-enabled desk-agent-filter.service 2>/dev/null || true)" = enabled
chk test "$(systemctl is-enabled desk-data.socket 2>/dev/null || true)" = enabled
chk test -x /usr/local/lib/ma/desk-data
chk test ! -e /data/.ma-export-tmp   # made on the data volume at boot, never on the root
chk test -x /opt/ma/desk-agent-filter/current/run   # baked (releases.pin), never started here
chk test -x /usr/local/lib/ma/desk-browser-policy
# Faster wakes (TD-227, image/README.md): cloud-init off after the first boot, a MAC-free network fallback, and the
# Browser's first units started once deskd answers. The image itself never has the marker.
chk test ! -e /etc/cloud/cloud-init.disabled
chk grep -q 'touch /etc/cloud/cloud-init.disabled' /etc/systemd/system/cloud-final.service.d/ma-off-after-first-boot.conf
chk test "$(systemctl show -p ExecStartPost --value cloud-final.service | grep -c 'cloud-init.disabled')" -ge 1
chk grep -qx 'DHCP=ipv4' /etc/systemd/network/20-ma-dhcp.network
chk test "$(systemctl is-enabled desk-browser-prewarm.service 2>/dev/null || true)" = enabled
chk test -x /usr/local/lib/ma/desk-browser-prewarm
chk test "$(stat -c '%U:%G %a' /etc/ma/chromium-teen.json)" = "root:root 644"
chk test ! -e /etc/chromium/policies/managed/ma-teen.json   # the helper decides at each start; the trace above leaves none
chk test -x /usr/local/lib/ma/desk-adblock
chk test "$(stat -c '%U:%G %a' /etc/ma/chromium-adblock.json /etc/chromium/policies/managed/ma-adblock.json | paste -sd,)" = "root:root 644,root:kiosk 640"
# The image ships blocking on everywhere, the kill switch off: the template with no site off (ADR 0076)
chk python3 -I -c 'import json, sys; t, p = (json.load(open(f)) for f in sys.argv[1:]); (i,) = t["ExtensionSettings"]; t["3rdparty"]["extensions"][i].update(noFiltering=[], off=False); sys.exit(t != p)' \
  /etc/ma/chromium-adblock.json /etc/chromium/policies/managed/ma-adblock.json
# The blocker: its id in the template, its CRX and update manifest in place, network rules only, no host permissions.
chk test "$(python3 -I -c 'import json; print(*json.load(open("/etc/ma/chromium-adblock.json"))["ExtensionSettings"])')" = "$(cat /usr/share/ma/adblock/blocker-id)"
chk test -s /usr/share/ma/adblock/ma-blocker.crx
chk grep -q "appid='$(cat /usr/share/ma/adblock/blocker-id)'" /usr/share/ma/adblock/update.xml
chk python3 -I -c 'import json, sys; b = json.load(open("/usr/share/ma/adblock/blocker.json")); sys.exit(not b["rules"] or not all(b["rules"].values()))'
chk test ! -e /etc/chromium/policies/managed/.ma-adblock.json.tmp
chk test -s /etc/ma/agent-egress.conf
chk test -x /opt/ma/desk-agent/current/run   # baked from 0.2.7 (releases.pin), never started here
chk test -s /opt/ma/desk-agent/current/desk-agent.env
chk test "$(systemctl is-enabled desk-notebook.service 2>/dev/null || true)" = enabled
chk test "$(stat -c '%U:%G %a' /run/desk-notebook)" = "notebook:desk 2750"
if [ "$notebook_baked" = 1 ]; then
  chk test -x /opt/ma/desk-notebook/current/run     # pinned, and never started here
  chk test -x /opt/ma/desk-notebook/current/health
else
  chk test ! -e /opt/ma/desk-notebook               # no pin: nothing installed, so its unit is skipped by its condition
fi
# The Guild Desk (image/README.md, "Guild Desk"). Nothing of a desk's kind is in the image: desk-kind decides at each boot.
chk test "$(id -u commons 2>/dev/null):$(id -g commons 2>/dev/null):$(id -nG commons 2>/dev/null)" = "1110:1110:commons"
for u in desk-kind desk-guild-net desk-guild-rtc commons-data commons-server-address commons-server; do chk test "$(systemctl is-enabled $u.service 2>/dev/null || true)" = enabled; done
chk test -x /usr/local/lib/ma/desk-kind
chk test -x /usr/local/lib/ma/desk-guild-net
chk test ! -e /run/ma/guild
for u in desk-xorg desk-audio desk-browser desk-stream desk-browser-thaw desk-adblock desk-preread; do
  chk grep -qx 'ConditionPathExists=!/run/ma/guild' /etc/systemd/system/$u.service.d/desk-kind.conf
  chk test "$(systemctl show -p DropInPaths --value $u.service | tr ' ' '\n' | grep -c '/desk-kind.conf$')" = 1
done
chk grep -qx 'ConditionPathExists=/run/ma/guild' /etc/systemd/system/commons-server.service
chk grep -qx 'ConditionPathExists=/run/ma/guild' /etc/systemd/system/desk-guild-net.service
chk grep -qx 'ConditionPathExists=/run/ma/guild' /etc/systemd/system/commons-data.service
chk grep -qx 'ConditionPathExists=/run/ma/guild' /etc/systemd/system/desk-guild-rtc.service
chk grep -qx 'ConditionPathExists=/run/ma/guild' /etc/systemd/system/commons-server-address.service
chk test -x /usr/local/lib/ma/desk-guild-rtc
chk test -z "$(systemctl show -p DropInPaths --value desk-rtc.service)"   # a member's desk-rtc has none; a Guild Desk's comes at boot, under /run
chk test "$(systemctl show -p DropInPaths --value nftables.service | tr ' ' '\n' | grep -c '/desk-guild-net.conf$')" = 1
chk test "$(stat -c '%U:%G %a' /run/desk-commons)" = "commons:desk 2750"
if [ "$commons_baked" = 1 ]; then
  chk test -x /opt/ma/commons-server/current/run      # pinned, and never started here
  chk test -x /opt/ma/commons-server/current/health
else
  chk test ! -e /opt/ma/commons-server                # no pin: nothing installed, so its unit is skipped by its condition
fi
chk test ! -e /data/guild                             # made by commons-data.service, on a Guild Desk only
chk modprobe -n sch_htb
chk modprobe -n sch_fq_codel
chk modprobe -n nft_redir       # nftables.conf's agent_redirect
chk modprobe -n nft_chain_nat
chk nft -c -f /etc/nftables.conf
chk test -x /usr/local/lib/ma/desk-xauth   # DA-1: Xorg's cookie
chk grep -q -- '-nolisten local -auth /run/desk-xorg/auth' /etc/systemd/system/desk-xorg.service
chk grep -q '^Requires=nftables.service' /etc/systemd/system/desk-agent.service   # DA-2
[ "$bad" = 0 ] || die "final assertions failed"
df -h / | sed "s/^/DISK: /"
echo "CHROMIUM_VERSION: $chromium_version"
echo "TEEN_LOCK: 1"   # bake.sh tags the AMI DeskTeenLock=1: what the Platform gates a teen's desk on (image/README.md, Teen Browser lock)
echo "build.sh: done (image version $IMG_VERSION)"
