#!/bin/bash
# The shared-host image recipe (ADR 0072 section 13; image/host/README.md). Root, on a builder that has just run the desk
# recipe (image/recipe/build.sh, unchanged): its root is then exactly a desk image, which becomes the template on the slot
# store, and the builder is turned into the host. image/host/bake.sh runs both.
# Usage: build.sh <version> <slot store volume ID>
# Input next to this script, all staged by bake.sh: releases/<component>-<version>.tgz for deskd, desk-agent, desk-notebook,
# desk-rtc and desk-stream as the desk recipe's releases.pin names them (the desk recipe deletes its own copies);
# releases.pin (the desk recipe's); desk-files.txt (the desk recipe's files/ list, which leaves the host); desk-svc (built
# from image/host/desk-svc, its sha256 in desk-svc.sha256); desk-ice-demux (from image/host/desk-ice-demux, its sha256 in
# desk-ice-demux.sha256); files/ (the host's own files); template-keys.sha256 and template-key-check (committed beside this script:
# the template key's trust anchor and its check, ADR 0077 PU-9).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HERE=$(cd "$(dirname "$0")" && pwd)
VERSION=${1:?version}; STORE_VOL=${2:?slot store volume}
LIB=/usr/local/lib/desk-host; DH=/srv/desk-host; T=$DH/templates/g1   # the first template generation (ADR 0077 1.1)
RUNC_VERSION=1.5.2
RUNC_SHA256=d10ecae898361832a059be2089bab92d158aec54661b18ed7346ed79628b46b0
RUNC_SIGNER=C2428CD75720FACDCF76B6EA17DE5ECB75A1100E
SLOTS_MAX=29
step() { echo; echo "==== host: $* ===="; }
die() { echo "host build.sh: ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "root only"
[ -f /etc/ma-release ] && [ -x /opt/ma/bin/ma-update ] || die "the desk recipe hasn't run here"
DESK_VERSION=$(sed -n 's/^version=//p' /etc/ma-release)
# ADR 0077 PU-9: the template signing key's trust anchor, committed (template-keys.sha256, alias/ma-host-template's public half by name
# and SHA-256). The staged key must be exactly it before anything is made, and the installed one again before it's pinned (below).
TK_ANCHOR=$HERE/template-keys.sha256
python3 -I "$HERE/template-key-check" "$HERE/files/etc/desk-host/template-keys" "$TK_ANCHOR" \
  || die "the staged template keys aren't exactly the committed anchor (template-keys.sha256): no bake"
# Every desk unit and timer the desk image has, masked on the host (WALL-05); desk-host-check's list
DESK_UNITS="desk-firstboot.service data.mount desk-units@.service desk-data@.service desk-datadirs.service desk-rtc.service deskd.service
  desk-agent.service desk-agent-filter.service desk-notebook.service desk-egress.service desk-units.socket desk-data.socket
  desk-preread.service desk-xorg.service desk-audio.service desk-browser.service desk-stream.service desk-browser-thaw.service
  desk-adblock.service desk-kind.service desk-guild-net.service desk-guild-rtc.service commons-data.service
  commons-server-address.service commons-server.service desk-restart-reset.service desk-restart-reset.timer docker.service docker.socket containerd.service zramswap.service"
DESK_USERS="desk rtc kiosk agent stream notebook agent-filter commons"

step "the slot store: the second volume ($STORE_VOL), by its NVMe serial"
dev=""
for c in /sys/class/nvme/nvme*; do [ "$(tr -d ' ' < "$c/serial")" = "${STORE_VOL/-/}" ] && dev=/dev/$(basename "$c")n1; done
[ -n "$dev" ] || die "no NVMe device with serial ${STORE_VOL/-/}"
blkid -p "$dev" >/dev/null 2>&1 && die "$dev isn't blank"
STORE_UUID=$(cat /proc/sys/kernel/random/uuid)
mkfs.ext4 -q -O quota,project -L desk-slots -U "$STORE_UUID" "$dev"
install -d -m 711 $DH; mount -o prjquota,nosuid,nodev,noatime "$dev" $DH; chmod 711 $DH
install -d -m 711 $DH/slots $DH/releases $DH/templates

step "the template's first generation, g1: this root, the desk image as its recipe left it, never booted again (WALL-04, WALL-05)"
t0=$(date +%s)
install -d -m 755 $T
tar -C / --one-file-system --numeric-owner -cf - \
  --exclude=./var/lib/docker --exclude=./var/lib/containerd --exclude='./var/log/*' --exclude=./var/lib/cloud \
  --exclude=./var/lib/amazon --exclude=./var/lib/desk-host --exclude=./etc/desk-host --exclude=./home/admin --exclude=./root \
  --exclude='./etc/ssh/ssh_host_*' --exclude=./var/cache/apt/archives --exclude=./srv --exclude=./boot --exclude=./usr/lib/modules \
  --exclude=./var/lib/systemd/random-seed --exclude=./var/lib/dhcp --exclude=./var/lib/private --exclude=./tmp --exclude=./var/tmp . \
  | tar -C $T -xpf - --numeric-owner
install -d -m 755 $T/data $T/root $T/desk-host $T/desk-host-test $T/opt/ma-host/release $T/var/log
install -d -m 1777 $T/tmp $T/var/tmp; chmod 700 $T/root
rm -f $T/etc/resolv.conf; echo "nameserver 169.254.169.253" > $T/etc/resolv.conf
: > $T/etc/machine-id
# Chromium's uid is Chromium's only (WALL-01 (4)): Xorg, PulseAudio and the filter's resolver get users of their own;
# desk-data its own (WALL-06); PulseAudio's clients a group (1111: 1110 is commons in the desk image).
for u in desk-x:1107 desk-snd:1108 desk-dns:1109 desk-data:1112; do
  n=${u%:*}; i=${u#*:}
  ! grep -q "^[^:]*:x:$i:" $T/etc/passwd || grep -q "^$n:x:$i:" $T/etc/passwd || die "uid $i is taken in the desk image"
  grep -q "^$n:" $T/etc/passwd || echo "$n:x:$i:$i:shared host:/nonexistent:/usr/sbin/nologin" >> $T/etc/passwd
  grep -q "^$n:" $T/etc/group || echo "$n:x:$i:" >> $T/etc/group
  grep -q "^$n:" $T/etc/shadow || echo "$n:!:20000::::::" >> $T/etc/shadow
done
! grep -q "^[^:]*:x:1111:" $T/etc/group || grep -q "^desk-audio:x:1111:" $T/etc/group || die "gid 1111 is taken in the desk image"
grep -q '^desk-audio:' $T/etc/group || echo "desk-audio:x:1111:kiosk,stream" >> $T/etc/group
python3 -I - $T/etc/chromium/policies/managed/ma.json <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["NativeMessagingUserLevelHosts"] = False; json.dump(d, open(p, "w"), indent=2)
PY
ln -sfn /run/desk-host/desk-rtc.conf $T/etc/ma/desk-rtc.conf   # the port is the host's to say (ADR 0072 section 6, WALL-03)
chown 0:0 $T; chmod 755 $T   # its .complete is written last, with its manifest, once desk-host-template is installed (below)
echo "template: $(du -sh $T | cut -f1) in $(( $(date +%s) - t0 )) s"

step "Docker's own spec for a default container (desk-spec.py and svc-spec.py start from it), then Docker leaves the host"
install -d -m 755 $LIB
systemctl start docker
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
id=$(docker run -d --network none --entrypoint sleep "$(cat /opt/ma/deskd/current/image-id)" 120)
cp "/run/containerd/io.containerd.runtime.v2.task/moby/$id/config.json" $LIB/docker-oci.json
docker rm -f "$id" >/dev/null
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["linux"]["seccomp"]["syscalls"] and d["process"]["capabilities"]["bounding"]' $LIB/docker-oci.json
systemctl stop docker.socket docker.service containerd.service

step "the release store, from the verified artifacts only (desk-host-release, RC-01)"
install -d -m 755 /etc/desk-host
install -m 644 "$HERE/releases.pin" /etc/desk-host/releases.pin
install -m 755 "$HERE/files/usr/local/lib/desk-host/desk-host-release" $LIB/desk-host-release
for m in batchsig.py batches.py templates.py; do install -m 755 "$HERE/files/usr/local/lib/desk-host/$m" $LIB/$m; done   # desk-host-release's (ADR 0078)
for comp in deskd desk-agent desk-notebook desk-rtc desk-stream; do
  ver=$(awk -v c=$comp '$1==c {print $2}' /etc/desk-host/releases.pin)
  [ -f "$HERE/releases/$comp-$ver.tgz" ] || die "no releases/$comp-$ver.tgz"
  $LIB/desk-host-release install "$HERE/releases/$comp-$ver.tgz"
  rm -f "$HERE/releases/$comp-$ver.tgz"
done
$LIB/desk-host-release verify

# The ruleset is syntax-checked here, while the running (cloud) kernel's modules are still installed: its `socket` and other
# expressions load nft modules, and the step below removes the running kernel (0.1.7's first bake failed on `socket transparent`).
nft -c -f "$HERE/files/etc/nftables.conf"

step "the host's kernel: Debian's linux-image-arm64 (zswap built in; the cloud kernel has none)"
apt-get update -q
apt-get install -y -q --no-install-recommends linux-image-arm64 quota conntrack e2fsprogs apparmor gnupg curl jq nvme-cli zstd openssl unattended-upgrades
echo 'linux-base linux-base/removing-running-kernel boolean false' | debconf-set-selections
cloud=$(dpkg-query -W -f='${Package}\n' 'linux-image-*cloud*' 2>/dev/null | grep . || true)
[ -z "$cloud" ] || apt-get purge -y -q $cloud
KVER=$(ls /lib/modules | grep -- '-arm64$' | grep -v cloud | sort -V | tail -1)
[ -n "$KVER" ] || die "no arm64 kernel installed"
update-initramfs -u -k "$KVER" >/dev/null
update-grub 2>&1 | tail -3
[ -z "$(ls /boot | grep cloud || true)" ] || die "a cloud kernel is still in /boot"
grep -q "vmlinuz-$KVER" /boot/grub/grub.cfg || die "grub.cfg doesn't boot $KVER"
initrd=$(lsinitramfs "/boot/initrd.img-$KVER")   # captured first: grep -q on a pipe under pipefail fails on lsinitramfs's SIGPIPE
grep -qw nvme "/lib/modules/$KVER/modules.builtin" || grep -q '/nvme\.ko' <<<"$initrd" || die "no NVMe driver for $KVER's boot"
grep -qw ena "/lib/modules/$KVER/modules.builtin" || [ -n "$(find /lib/modules/$KVER -name 'ena.ko*' | head -1)" ] || die "no ENA driver in $KVER"
[ "$(grep -c '^CONFIG_ZSWAP=y' "/boot/config-$KVER")" = 1 ] || die "$KVER has no zswap"
[ -n "$(find /lib/modules/$KVER -name 'lz4.ko*' | head -1)" ] || grep -q '^CONFIG_CRYPTO_LZ4=y' "/boot/config-$KVER" || die "$KVER has no lz4"
echo "HOST_KERNEL: $KVER"

step "runc $RUNC_VERSION, upstream's signed static build, pinned by SHA-256 and signer (WALL-02); Debian's runc out"
w=$(mktemp -d); B=https://github.com/opencontainers/runc/releases/download/v$RUNC_VERSION
curl -fsSL -o $w/runc.arm64 $B/runc.arm64; curl -fsSL -o $w/runc.arm64.asc $B/runc.arm64.asc
curl -fsSL -o $w/runc.keyring https://raw.githubusercontent.com/opencontainers/runc/v$RUNC_VERSION/runc.keyring
echo "$RUNC_SHA256  $w/runc.arm64" | sha256sum -c --quiet || die "runc: SHA-256 differs from the pin"
export GNUPGHOME=$w/g; install -d -m 700 $GNUPGHOME; gpg --batch -q --import $w/runc.keyring 2>/dev/null
sig=$(gpg --batch --status-fd 1 --verify $w/runc.arm64.asc $w/runc.arm64 2>/dev/null || true)
grep -q "VALIDSIG $RUNC_SIGNER" <<<"$sig" || die "runc: signature"
unset GNUPGHOME; install -m 755 $w/runc.arm64 /usr/local/sbin/runc; rm -rf "$w"
echo "$RUNC_SHA256  /usr/local/sbin/runc" > $LIB/runc.sha256

step "the desk's stack leaves the host (Docker, Chromium, X, sound, zram): the template keeps them"
purge=$({ dpkg-query -W -f='${db:Status-Status} ${Package}\n' docker.io docker-cli containerd runc 'chromium*' 'xserver-xorg*' 'pulseaudio*' zram-tools \
  xdotool x11-utils x11-xserver-utils 'gstreamer1.0-*' 'fonts-noto*' 2>/dev/null || true; } | awk '$1=="installed" {print $2}')
[ -n "$purge" ] || die "nothing of the desk's stack found to purge"
apt-get purge -y -q $purge 2>&1 | tail -2
apt-get autoremove -y -q --purge 2>&1 | tail -1
rm -rf /var/lib/docker /var/lib/containerd /etc/docker
while read -r f; do rm -f "/${f#./}"; done < "$HERE/desk-files.txt"   # the desk recipe's own files
rm -rf /etc/ma /opt/ma /usr/local/lib/ma /usr/local/share/ma /usr/share/ma /etc/chromium /var/lib/desk-preread /run/desk* /run/ma
rm -f /etc/systemd/system/*.service.d/desk-kind.conf /etc/systemd/system/nftables.service.d/desk-guild-net.conf
rmdir /etc/systemd/system/*.service.d 2>/dev/null || true
for u in $DESK_USERS; do id "$u" >/dev/null 2>&1 && userdel "$u"; getent group "$u" >/dev/null && groupdel "$u" 2>/dev/null || true; done
systemctl daemon-reload
for u in $DESK_UNITS; do systemctl mask "$u" >/dev/null 2>&1; done
for c in python3 nft ip tc nsenter flock setquota conntrack chattr lsattr apparmor_parser curl blkid resize2fs mkfs.ext4 fallocate; do command -v $c >/dev/null || die "the host needs $c"; done

step "the host's own files: desk-host, desk-host-link, their units, ruleset, sysctls"
install -d -m 755 /etc/desk-host/template-keys   # ADR 0077 1.2: the template key's public half (PU-9), and nothing else
install -d -m 755 /etc/desk-host/batch-keys      # ADR 0078 1.1: the batch key's public half (alias/ma-desk-batch, desks' own), and nothing else
(cd "$HERE/files" && find . \( -type f -o -type l \) -print0 | tar --null --no-recursion --owner=0 --group=0 -T - -cf -) | tar -C / -xf -
chmod 755 $LIB/desk-host $LIB/desk-host-check $LIB/desk-host-release $LIB/desk-host-boot $LIB/desk-host-link $LIB/desk-host-template $LIB/desk-host-batch $LIB/*.py $LIB/desk/*.py
install -m 755 "$HERE/desk-svc" $LIB/desk/desk-svc
[ "$(sha256sum $LIB/desk/desk-svc | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$HERE/desk-svc.sha256")" ] || die "desk-svc isn't the binary bake.sh built"
cut -d' ' -f1 "$HERE/desk-svc.sha256" > $LIB/desk-svc.sha256
# desk-ice-demux (SlotMode=port's TCP 443, image/host/desk-ice-demux), built by bake.sh as desk-svc is, and its own user
install -m 755 "$HERE/desk-ice-demux" $LIB/desk-ice-demux
[ "$(sha256sum $LIB/desk-ice-demux | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$HERE/desk-ice-demux.sha256")" ] || die "desk-ice-demux isn't the binary bake.sh built"
cut -d' ' -f1 "$HERE/desk-ice-demux.sha256" > $LIB/desk-ice-demux.sha256
getent passwd desk-dmx >/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group desk-dmx
install -m 644 $T/usr/local/lib/ma/desk-units $LIB/desk/desk-units.py   # the freeze desk-init uses (the template's own code)
# ADR 0036's shaper and budgets, the template's own desk-egress (its baked release; the link is absolute, so it's resolved inside the
# template): egress.py runs it for each slot (ADR 0072 section 8, TD-223). The host's copy, so a template's change never reaches it.
eg=$(readlink "$T/opt/ma/desk-egress/current") || die "the template has no desk-egress"
case "$eg" in /*) eg=$T$eg ;; *) eg=$T/opt/ma/desk-egress/$eg ;; esac
install -m 644 "$eg/desk-egress" $LIB/desk_egress.py
ln -sfn $LIB/desk-host /usr/local/sbin/desk-host
echo "$STORE_UUID" > /etc/desk-host/store.uuid
chmod 644 /etc/nftables.conf /etc/sysctl.d/90-desk-host.conf /etc/apt/apt.conf.d/51desk-host-unattended; find /etc/desk-host -maxdepth 1 -type f -exec chmod 644 {} +
chmod 600 /etc/desk-host/desk-host.conf; chmod 755 /etc/desk-host/template-keys; chmod 644 /etc/desk-host/template-keys/*
chmod 755 /etc/desk-host/batch-keys; chmod 644 /etc/desk-host/batch-keys/*
chown -R 0:0 $LIB; chmod -R go-w $LIB; chmod 755 $LIB/desk
cmp -s "$HERE/files/etc/nftables.conf" /etc/nftables.conf || die "the installed ruleset differs from the one checked"   # checked above, before the kernel swap

step "the template's first generation sealed (ADR 0077 1.1): its manifest on the host's root, .complete written last, state.json; the keys pinned"
python3 -I $LIB/desk-host-template bake-g1 "$VERSION"
grep -qx "gen=g1" $T/.complete || die "g1 isn't sealed"
# the template keys this image trusts, pinned by name and SHA-256 (desk-host-check template-sig): exactly the committed anchor. The
# installed directory must hold exactly its keys (no other file, no link, the anchor's SHA-256, P-256), and the anchor is the pin. No
# key, no bake: alias/ma-host-template exists (PU-9), and bake.sh compared the committed key with KMS's public half before launching.
python3 -I "$HERE/template-key-check" /etc/desk-host/template-keys "$TK_ANCHOR" \
  || die "/etc/desk-host/template-keys isn't exactly the committed anchor (template-keys.sha256)"
install -m 644 "$TK_ANCHOR" $LIB/template-keys.sha256
echo "template keys pinned: $(wc -l < $LIB/template-keys.sha256), the committed anchor's ($(cut -c1-12 $LIB/template-keys.sha256 | paste -sd' '))"
# ADR 0078 1.1: the batch key this image trusts, pinned by name and SHA-256 (desk-host-check batch-sig): exactly the desk image's own,
# alias/ma-desk-batch's public half; no drop-in. batch-baseline (1.3 step 2): the newest batch whose releases this image's pin holds,
# from bake.sh's BATCH_BASELINE (none: no file, 0), so no older signed batch can be replayed onto a host born on this image.
[ "$(ls -A /etc/desk-host/batch-keys)" = ma-desk-batch-2026-11.pem ] || die "/etc/desk-host/batch-keys isn't exactly the batch key"
# Compared with the desk image's own copy as the template holds it: the desk recipe removes bake.sh's staged copy of itself
# (/home/admin/ma-recipe) as it ends, so a check against that copy was always skipped. No escape: a missing copy stops the bake
# (Security's ADR 0077 Low 3, Nov 11).
cmp -s /etc/desk-host/batch-keys/ma-desk-batch-2026-11.pem "$T/opt/ma/etc/batch-keys/ma-desk-batch-2026-11.pem" \
  || die "the host's batch key isn't the desk image's (the template's /opt/ma/etc/batch-keys), or the template has none: no bake"
(cd /etc/desk-host/batch-keys && for f in *.pem; do [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d' ' -f1)  $f"; done; true) > $LIB/batch-keys.sha256
chmod 644 $LIB/batch-keys.sha256
if [ -n "${BATCH_BASELINE:-}" ]; then
  [[ $BATCH_BASELINE =~ ^[0-9]{1,15}$ ]] || die "BATCH_BASELINE isn't a sequence number"
  printf '{"seq": %s}\n' "$BATCH_BASELINE" > /etc/desk-host/batch-baseline; chmod 644 /etc/desk-host/batch-baseline
fi
install -d -m 755 /var/lib/desk-host/batch
echo "batch key pinned: $(cut -c1-12 $LIB/batch-keys.sha256); baseline $(cat /etc/desk-host/batch-baseline 2>/dev/null || echo 'none (0)')"
# the host's own apt (ADR 0077 section 3): nftables and apparmor come only with a host image
apt-mark hold nftables apparmor

step "protocol modules no desk needs, and every tty line discipline (RC-02, WR2-02): install /bin/false"
BLACKLIST="sctp sctp_diag dccp dccp_diag dccp_ipv4 dccp_ipv6 tipc tipc_diag rds rds_tcp rds_rdma kcm smc smc_diag af_key l2tp_core l2tp_eth l2tp_ip l2tp_ip6 l2tp_netlink l2tp_debugfs l2tp_ppp pppoe pptp atm can can_raw can_bcm can_gw can_isotp can_j1939 x25 ax25 netrom rose appletalk psnap p8022 ipx llc2 ieee802154 ieee802154_socket af_802154 nfc phonet caif caif_socket bluetooth vsock vsock_diag vsock_loopback vmw_vsock_virtio_transport vmw_vsock_virtio_transport_common hv_sock af_alg algif_hash algif_skcipher algif_aead algif_rng mpls_router mpls_iptunnel mpls_gso openvswitch nsh"
LDISC=$(awk '$1=="alias" && $2 ~ /^tty-ldisc-/ {print $3}' "/lib/modules/$KVER/modules.alias" | sort -u)
LDISC="$LDISC n_hdlc n_gsm slip slcan ppp_async ppp_synctty hci_uart n_null caif_serial 6pack mkiss can327 ppp_generic"
{ echo "# desk-host (ADR 0072, RC-02, WR2-02): protocol modules and tty line disciplines no desk needs. image/host/recipe/build.sh."
  for m in $(printf '%s\n' $BLACKLIST $LDISC | sort -u); do echo "blacklist $m"; echo "install $m /bin/false"; done; } > /etc/modprobe.d/desk-host.conf
chmod 644 /etc/modprobe.d/desk-host.conf
echo "blacklisted: $(grep -c '^install' /etc/modprobe.d/desk-host.conf) modules ($(echo $LDISC | wc -w) line disciplines named)"

step "every slot's uid range reserved (WALL-10): desk-slot-1 to -$SLOTS_MAX in /etc/subuid and /etc/subgid, nothing else in them"
python3 -I - "$SLOTS_MAX" <<'PY'
import os, subprocess, sys
n = int(sys.argv[1]); ranges = [(k, 100000 + k * 65536) for k in range(1, n + 1)]
lo, hi = ranges[0][1], ranges[-1][1] + 65536
for k, _ in ranges:
    if subprocess.run(["getent", "passwd", f"desk-slot-{k}"], capture_output=True).returncode != 0:
        subprocess.run(["useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", f"desk-slot-{k}"], check=True)
for f in ("/etc/subuid", "/etc/subgid"):
    keep, dropped = [], []
    for line in open(f).read().splitlines():
        name, start, count = line.split(":")
        s, e = int(start), int(start) + int(count)
        if name.startswith("desk-slot-"):
            continue
        (dropped if s < hi and e > lo else keep).append(line)
    keep += [f"desk-slot-{k}:{b}:65536" for k, b in ranges]
    tmp = f + ".desk-host"; open(tmp, "w").write("\n".join(keep) + "\n"); os.chmod(tmp, 0o644); os.rename(tmp, f)
    print(f"{f}: slots 1-{n} reserved ({lo}-{hi - 1}); removed {', '.join(d.split(':')[0] for d in dropped) or 'nothing'}")
PY

step "units"
systemctl daemon-reload
systemctl enable nftables.service desk-host-boot.service desk-host-shutdown.service desk-host-link.service desk-ice-demux.service desk-host-apt.timer
systemctl mask apt-daily.timer apt-daily-upgrade.timer   # the desk recipe masks them already; the host's apt is desk-host-apt.timer
systemctl disable ssh.service ssh.socket 2>/dev/null || true

step "final: lock down and clean (as the desk recipe's last step)"
find /root /home /etc/ssh -name 'authorized_keys*' -delete 2>/dev/null || true
rm -f /etc/ssh/ssh_host_*
passwd -l root >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/*/.bash_history /root/.viminfo
cloud-init clean --logs --seed 2>/dev/null || cloud-init clean --logs
rm -rf /var/lib/cloud/* /run/cloud-init 2>/dev/null || true
[ ! -d /var/log/journal ] || find /var/log/journal -type f -exec shred -n 0 -z -u {} +
rm -rf /var/log/journal/*
: > /etc/machine-id; rm -f /var/lib/dbus/machine-id
rm -f /var/lib/amazon/ssm/Vault/* 2>/dev/null || true
apt-get clean; rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -delete
find /var/log -type f -exec truncate -s 0 {} +

step "assertions (desk-host-check's checks that need no boot)"
bad=0
chk() { if ! "$@"; then echo "ASSERT FAILED: $*" >&2; bad=1; fi; }
mount --bind $T $T; mount -o remount,bind,ro,nosuid,nodev $T   # as desk-host-boot binds it, for the template check
$LIB/desk-host-check --only runc,template,templates,template-sig,releases,desk-svc,no-test,units,apparmor,classes || bad=1
umount $T
chk test -z "$(find /root /home /etc/ssh -name 'authorized_keys*' 2>/dev/null)"
chk test "$(systemctl is-enabled ssh.service 2>/dev/null || true)" != enabled
chk test "$(systemctl is-enabled desk-host-boot.service)" = enabled
chk test "$(systemctl is-enabled desk-host-shutdown.service)" = enabled
chk test "$(systemctl is-enabled desk-host-link.service)" = enabled
chk python3 -I -B -c "import sys; sys.path.insert(0, \"$LIB\"); import hostmeta, sigv4, standin"
chk python3 -I -B -c "import sys; sys.path.insert(0, \"$LIB\"); import egress; d = egress.de(); assert d.CLASSES and d.Budget and d.Shaper"   # TD-223
chk test -f /etc/systemd/system/desk-host-egress@.service
chk test "$(systemctl is-enabled desk-host-egress@1.service 2>/dev/null || true)" != enabled   # started by desk-host up only
chk test "$(systemctl is-enabled nftables.service)" = enabled
left=$(find / -xdev \( -uid 1100 -o -uid 1101 -o -uid 1102 -o -uid 1103 -o -uid 1104 -o -uid 1105 -o -uid 1106 -o -uid 1110 -o -gid 1100 -o -gid 1110 \) 2>/dev/null | head -20 || true)
[ -z "$left" ] || { echo "files of the desk's users left on the host, now root's:"; echo "$left" | sed 's/^/  /'; find / -xdev \( -uid 1100 -o -uid 1101 -o -uid 1102 -o -uid 1103 -o -uid 1104 -o -uid 1105 -o -uid 1106 -o -uid 1110 -o -gid 1100 -o -gid 1110 \) -exec chown -h root:root {} + 2>/dev/null; }
chk test -z "$(find / -xdev \( -uid 1100 -o -uid 1101 -o -uid 1102 -o -uid 1103 -o -uid 1104 -o -uid 1105 -o -uid 1106 -o -uid 1110 \) 2>/dev/null | head -3)"
chk test ! -e /usr/bin/docker
chk test ! -e /usr/bin/chromium
chk test -z "$(ls -d /var/tmp/* /tmp/* 2>/dev/null || true)"
chk grep -q "^install n_hdlc /bin/false" /etc/modprobe.d/desk-host.conf
chk grep -q "^install sctp /bin/false" /etc/modprobe.d/desk-host.conf
chk test "$(grep -c '^desk-slot-' /etc/subuid)" = "$SLOTS_MAX"
[ "$bad" = 0 ] || die "final assertions failed"
umount $DH
df -h / | sed "s/^/DISK: /"
echo "STORE_UUID: $STORE_UUID"
echo "DESK_VERSION: $DESK_VERSION"
echo "host build.sh: done (shared-host image $VERSION on desk image $DESK_VERSION)"
