#!/bin/bash
# verify-sysctl.sh <part>: the desk's kernel hardening on a booted box (image/recipe/files/etc/sysctl.d/91-ma-hardening.conf; the same
# lines as the shared host's, ADR 0072; ISS-20). verify.sh pipes this to root on the box once per part (bash -s -- <part>), and it
# runs the same on any lab box. It prints BAD <what> and FAILED for each failure, and "ran to the end" last.
#   values    each of the seven is what the file says, read from /proc/sys, and the file is what the image carries; the UDP buffers too
#   mutation  kernel.dmesg_restrict is set to 0 at runtime: values must FAIL; it is put back: values must pass again
#   works     the settings in use, read only (no attach or other probe): an ordinary uid is refused dmesg and sees no kernel address,
#             root still reads dmesg; the Browser, deskd and desk-agent are active
set -u
part=${1:-}
bad() { echo "BAD: $*"; echo FAILED; }
WANT="kernel.yama.ptrace_scope=2 fs.suid_dumpable=0 kernel.core_pattern=|/bin/false kernel.unprivileged_bpf_disabled=1 kernel.dmesg_restrict=1 kernel.kptr_restrict=2 dev.tty.ldisc_autoload=0 net.core.rmem_max=4194304 net.core.wmem_max=4194304"
values() { # prints BAD lines; returns 1 on any
  local rc=0 kv k v got f
  for kv in $WANT; do
    k=${kv%%=*}; v=${kv#*=}; got=$(sysctl -n "$k" 2>&1)
    echo "$k = $got"
    [ "$got" = "$v" ] || { echo "BAD: $k is '$got', not '$v'"; rc=1; }
    f=$(grep -hs "^$k *=" /etc/sysctl.d/*.conf | tail -1 | sed 's/^[^=]*= *//')
    [ "$f" = "$v" ] || { echo "BAD: /etc/sysctl.d says '$f' for $k, not '$v'"; rc=1; }
  done
  return $rc
}
case "$part" in
values) values >/tmp/sysctl-values.$$ ; rc=$?; cat /tmp/sysctl-values.$$; rm -f /tmp/sysctl-values.$$; [ $rc = 0 ] || echo FAILED ;;
mutation)
  was=$(sysctl -n kernel.dmesg_restrict); sysctl -qw kernel.dmesg_restrict=0
  if values >/dev/null 2>&1; then bad "values passed with kernel.dmesg_restrict changed to 0"; else echo "ok: values fails with dmesg_restrict=0"; fi
  sysctl -qw kernel.dmesg_restrict=$was
  values >/dev/null 2>&1 && echo "ok: values passes again once it is put back" || bad "values still fails after dmesg_restrict is put back"
  ;;
works)
  u=$(getent passwd 1100 | cut -d: -f1); [ -n "$u" ] || u=nobody
  # an ordinary uid: no dmesg, no kernel addresses
  out=$(setpriv --reuid=$u --regid=$u --clear-groups dmesg 2>&1); echo "dmesg as $u: $out" | head -1
  echo "$out" | grep -qi "not permitted\|permission denied\|Operation not permitted" || bad "dmesg as an ordinary uid was not refused"
  dmesg >/dev/null 2>&1 && echo "ok: dmesg as root" || bad "dmesg as root fails"
  ka=$(setpriv --reuid=$u --regid=$u --clear-groups sh -c 'head -1 /proc/kallsyms' 2>&1); echo "kallsyms head as $u: $ka"
  echo "$ka" | grep -q '^0000000000000000' || bad "kallsyms shows an address to an ordinary uid"
  # the units
  for s in deskd desk-agent desk-notebook desk-rtc; do systemctl is-active --quiet $s.service && echo "ok: $s active" || bad "$s not active"; done
  ;;
*) echo "usage: verify-sysctl.sh values|mutation|works"; exit 2 ;;
esac
echo "ran to the end"
