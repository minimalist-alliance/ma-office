"""wallspec.py: what desk-spec.py and svc-spec.py share (ADR 0072 sections 2 and 3; the shared-host image, image/host/).

- seccomp(): Docker's own profile (docker-oci.json, captured at bake from the image's own Docker by build.sh) with socket(),
  socketpair() and socketcall() replaced by an allow-list (WALL-01 (3), RC-02), native arm64 calls only. For the desk's own
  container, clone and unshare with namespace flags are allowed (Chromium's sandbox; desk-init narrows that for everything
  but Chromium's tree, WALL-01 (1)); for a service's sandbox, Docker's rules stand, so no namespaces at all, no setns and
  clone3 ENOSYS: the unit filter.
- masked(): Docker's masked paths, test 2's, WALL-08's, and the run-2 re-read's: /sys/dev/block and each NVMe controller's
  own directory under /sys/devices, where the per-device counters were.
- shares(): the /run directories a desk shares with its sandboxes, made fresh at every start on a host tmpfs (RC-01).
"""
import glob
import json
import os

LIB = "/usr/local/lib/desk-host"
DH = "/srv/desk-host"
CGROUP = "desk-host"                           # /sys/fs/cgroup/desk-host/desk-<k>: the desk's share, host-owned
AF_UNIX, AF_INET, AF_INET6, AF_NETLINK = 1, 2, 10, 16
SOCK_STREAM, SOCK_DGRAM, SOCK_RAW = 1, 2, 3
TYPE_MASK = 0xFFFFFFFF & ~(0x800 | 0x80000)   # the type without SOCK_NONBLOCK and SOCK_CLOEXEC
BASE_ID_OF = lambda k: 100000 + k * 65536     # noqa: E731  a slot's uid range (reserved on the host, build.sh)
SOCKET_ALLOW = [  # (family, type, protocol); protocol 0 picks TCP or UDP for these types, never SCTP, DCCP or UDP-Lite
    (AF_INET, SOCK_STREAM, 0), (AF_INET, SOCK_STREAM, 6), (AF_INET, SOCK_DGRAM, 0), (AF_INET, SOCK_DGRAM, 17), (AF_INET, SOCK_DGRAM, 1),
    (AF_INET6, SOCK_STREAM, 0), (AF_INET6, SOCK_STREAM, 6), (AF_INET6, SOCK_DGRAM, 0), (AF_INET6, SOCK_DGRAM, 17), (AF_INET6, SOCK_DGRAM, 58),
    (AF_NETLINK, SOCK_RAW, 0), (AF_NETLINK, SOCK_DGRAM, 0),   # NETLINK_ROUTE only
]


def docker_spec():
    return json.load(open(f"{LIB}/docker-oci.json"))


def seccomp(sc, allow_namespaces):
    rules = []
    drop = {"socket", "socketpair", "socketcall"} | ({"clone", "unshare"} if allow_namespaces else set())
    for r in sc["syscalls"]:
        names = [n for n in r["names"] if n not in drop]
        if names:
            r["names"] = names
            rules.append(r)
    if allow_namespaces:
        rules.append({"names": ["clone", "unshare"], "action": "SCMP_ACT_ALLOW"})
    rules.append({"names": ["socket", "socketpair"], "action": "SCMP_ACT_ALLOW", "args": [{"index": 0, "value": AF_UNIX, "op": "SCMP_CMP_EQ"}]})
    for fam, typ, proto in SOCKET_ALLOW:
        rules.append({"names": ["socket"], "action": "SCMP_ACT_ALLOW", "args": [
            {"index": 0, "value": fam, "op": "SCMP_CMP_EQ"},
            {"index": 1, "value": TYPE_MASK, "valueTwo": typ, "op": "SCMP_CMP_MASKED_EQ"},
            {"index": 2, "value": proto, "op": "SCMP_CMP_EQ"}]})
    sc["syscalls"] = rules
    sc["architectures"] = ["SCMP_ARCH_AARCH64"]
    return sc


def masked(existing):
    extra = ["/proc/interrupts", "/proc/softirqs", "/proc/diskstats", "/proc/schedstat", "/proc/pressure", "/proc/slabinfo", "/proc/vmallocinfo",
             "/proc/partitions", "/proc/vmstat", "/sys/block", "/sys/class/block", "/sys/class/nvme", "/sys/class/nvme-subsystem", "/sys/fs/ext4",
             "/sys/dev/block", "/proc/swaps", "/sys/kernel/mm/swap", "/sys/module/zswap"]
    extra += glob.glob("/sys/devices/system/cpu/cpu[0-9]*/cpuidle")
    extra += sorted({os.path.realpath(p) for p in glob.glob("/sys/class/nvme/nvme*")})   # each controller, its namespaces' stat inside
    return sorted(set(existing + extra))


def shares(k):
    """The slot's host-owned tmpfs (desk-host makes it fresh at every start): name -> (path inside, owner, group, mode)."""
    return {
        "desk": ("/run/desk", "rtc", "desk", 0o770),
        "desk-media": ("/run/desk-media", "rtc", "stream", 0o750),
        "desk-agent": ("/run/desk-agent", "agent", "desk", 0o2750),
        "desk-notebook": ("/run/desk-notebook", "notebook", "desk", 0o2750),
        "desk-audio": ("/run/desk-audio", "desk-snd", "desk-audio", 0o750),
        "desk-ctl": ("/run/desk-ctl", "stream", "stream", 0o700),   # desk-stream's desk-svc listens; the desk's root asks
        # Links out (desk image 0.3.5, desk-runtime.md section 8.11): the template's tmpfiles line, d /run/desk-links 2750 desk kiosk,
        # which no systemd-tmpfiles runs in a slot. deskd binds links.sock here (its group kiosk by the setgid bit); Chromium's
        # xdg-open stand-in, as kiosk in the desk, connects
        "desk-links": ("/run/desk-links", "desk", "kiosk", 0o2750),
        "x11": ("/tmp/.X11-unix", 0, 0, 0o1777),
    }


def bind(src, dst, ro=False, extra=()):
    return {"destination": dst, "type": "bind", "source": src, "options": ["rbind", "ro" if ro else "rw", "nosuid", "nodev", *extra]}


def conf():
    """/etc/desk-host/desk-host.conf, KEY=VALUE lines (host root's)."""
    out = {}
    try:
        for line in open("/etc/desk-host/desk-host.conf"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def test_mode():
    """A test host only: /etc/desk-host/test.conf, which the image never has (image/host/verify.sh checks)."""
    return os.path.exists("/etc/desk-host/test.conf") and os.path.isdir("/var/lib/desk-host/test")
