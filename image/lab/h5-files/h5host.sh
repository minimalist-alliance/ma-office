#!/bin/bash
# h5host.sh: free walk H5's lab, on a lab host from an earlier AMI, as root. TEST ONLY: a member's host has none of this.
#   setup                  deskd's endpoints on each slot's veth (gateway-shim, fake IMDS: spikes/host-0.1.7/tools/sahost.sh), the
#                          host ports they need, and the host link stopped (slots are started by hand here)
#   overlay                this tree's host files laid over the AMI's (/home/admin/h5/overlay, lab/h5-files/lab.sh makes it)
#   up <k> <desk> <vol>    desk-host up, then the slot's fixtures, then waits for deskd's hello at its shim
#   down <k>               desk-host stop, fixtures off
#   show <k>               mounts.json; deskd's /data/files as its sandbox has it (owner, mode, filesystem, entries); the files
#                          check (once the overlay is on); deskd's Files line since its start; desk-init's line about /data/files
#   plant <vol>            on a volume no slot runs: files/ replaced by a link to agent/ and a marker in agent/, as the desk itself
#                          could leave its own volume (a private mount namespace, gone when this exits)
#   look <vol>             on a volume no slot runs: files/ and agent/ as they are on disk
set -euo pipefail
H=/home/admin/h5; L=/usr/local/lib/desk-host
md() { curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" "http://169.254.169.254/latest/meta-data/$1"; }
dev_for_vol() { local want=${1/-/} c; for c in /sys/class/nvme/nvme*; do [ "$(tr -d ' ' < "$c/serial")" = "$want" ] && { echo "/dev/$(basename "$c")n1"; return 0; }; done; return 1; }
fixtures() {
  local k=$1 d=$2
  systemctl stop h5-shim-$k h5-imds-$k 2>/dev/null || true; systemctl reset-failed h5-shim-$k h5-imds-$k 2>/dev/null || true
  systemd-run --unit=h5-imds-$k --uid=admin python3 $H/fake-imds.py --host 10.98.$k.1 --desk-id "$d" --public-ip "$(md public-ipv4)" --env dev >/dev/null 2>&1
  systemd-run --unit=h5-shim-$k --uid=admin $H/gateway-shim --addr 10.98.$k.1:8787 --allow-non-loopback --desk-id "$d" >/dev/null 2>&1
}
since_start() { python3 -I -c 'import sys; t = open(sys.argv[1], errors="replace").read(); print(t[t.rfind("] started "):])' "$1" 2>/dev/null; }
case "${1:-}" in
setup)
  sed -i '/^# --- h5 lab/,$d' /etc/desk-host/desk-host.conf
  cat >> /etc/desk-host/desk-host.conf <<'C'
# --- h5 lab (image/lab/h5-files): deskd's endpoints on its veth; none of this is on a member's host
DESKD_ENV=DESKD_API_URL=http://10.98.{k}.1:8787;DESKD_JWKS_URL=http://10.98.{k}.1:8787/.well-known/jwks.json;DESKD_IMDS_URL=http://10.98.{k}.1:8788
HOST_PORTS=8787 8788
C
  systemctl stop desk-host-link
  echo "lab host: $(cat /var/lib/desk-host/hosting.json); the link stopped; deskd's endpoints on each slot's veth" ;;
overlay)
  tar -C $H/overlay -cf - . | tar --no-same-owner --no-same-permissions -C / -xf -
  echo "overlay: $(cd $H/overlay && find . -type f | sort | tr '\n' ' ')" ;;
up)
  k=$2; d=$3; v=$4
  desk-host up "$k" "$d" "$v" --public "$(md public-ipv4)" 2>&1 | grep -E 'mounts|refused|skipped|up at|claimed|formatted' | sed 's/^/  /' || true
  fixtures "$k" "$d"
  for i in $(seq 1 90); do curl -s -m 2 http://10.98.$k.1:8787/dev/state | grep -q '"ready":true' && { echo "slot $k: deskd said hello and ready after the start ($((i * 2)) s of waiting)"; exit 0; }; sleep 2; done
  echo "slot $k: deskd NOT ready in 180 s"; exit 1 ;;
down) k=$2; desk-host stop "$k" 2>&1 | grep -E 'stopped in' | sed 's/^/  /' || true; systemctl stop h5-shim-$k h5-imds-$k 2>/dev/null || true ;;
show)
  k=$2; base=$((100000 + k * 65536))
  echo "mounts.json: $(python3 -I -c 'import json,sys; m = json.load(open(sys.argv[1])); print(json.dumps({x: m.get(x) for x in ("refused", "skipped", "formatted")}))' /run/desk-host/$k.mounts.json)"
  pid=$(runc state dh-svc-$k-deskd | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
  python3 -I - "$pid" "$base" <<'P'
import os, stat, sys
pid, base = sys.argv[1], int(sys.argv[2])
try:
    st = os.lstat(f"/proc/{pid}/root/data/files")
except FileNotFoundError:
    sys.exit(print("deskd's /data/files, as its sandbox has it: none (as up to 0.1.10: no placeholder, and deskd can't make it in its /data)"))
mi = [l.split() for l in open(f"/proc/{pid}/mountinfo") if l.split()[4] == "/data/files"]
top = mi[-1] if mi else None
fs = f"{top[top.index('-') + 1]} {top[top.index('-') + 2]}" if top else "none"
try:
    names = sorted(os.listdir(f"/proc/{pid}/root/data/files"))
except OSError as e:
    names = [type(e).__name__]
print(f"deskd's /data/files, as its sandbox has it: {st.st_uid - base}:{st.st_gid - base} {stat.S_IMODE(st.st_mode):04o}, "
      f"its top mount {fs}{' (the volume, idmapped)' if top and 'idmapped' in ' '.join(top) else ''}; entries {names}")
P
  [ -x $L/desk-host-check ] && grep -q '"files": c_files' $L/desk-host-check && $L/desk-host-check --only files | sed 's/^/  /' || true
  echo "deskd since its start: $(since_start /var/log/desk-host/svc-$k-deskd.log | grep -E "Files tree|deskd ready" | sed 's/^.*\(WARN\|INFO\)/\1/' | cut -c1-140 | tr '\n' '|')"
  echo "desk-init about /data/files at this start: $(python3 -I -c 'import sys; t = open(sys.argv[1], errors="replace").read(); print(t[t.rfind("desk-init: unit filter on"):])' /var/log/desk-host/desk-$k.log 2>/dev/null | grep '/data/files' | tail -1 | cut -c1-160)" ;;
plant)
  dev=$(dev_for_vol "$2")
  unshare -m --propagation private sh -c "mkdir -p /run/h5mnt && mount -o nosuid,nodev,noexec $dev /run/h5mnt && rm -rf /run/h5mnt/files && ln -s agent /run/h5mnt/files && echo agents-own > /run/h5mnt/agent/h5-marker && chown 1103:1103 /run/h5mnt/agent/h5-marker && chmod 600 /run/h5mnt/agent/h5-marker && ls -la /run/h5mnt | grep -E ' (files|agent)' | sed 's/^/  on disk: /'; umount /run/h5mnt" ;;
look)
  dev=$(dev_for_vol "$2")
  unshare -m --propagation private sh -c "mkdir -p /run/h5mnt && mount -o ro,nosuid,nodev,noexec $dev /run/h5mnt && ls -la /run/h5mnt | grep -E ' (files|agent)' | sed 's/^/  on disk: /' && ls -lan /run/h5mnt/agent /run/h5mnt/files | sed 's/^/  on disk: /'; umount /run/h5mnt" ;;
*) sed -n 2,14p "$0" >&2; exit 2 ;;
esac
