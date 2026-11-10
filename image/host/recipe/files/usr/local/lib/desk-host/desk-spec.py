#!/usr/bin/python3 -I
"""desk-spec.py <k> <bundle dir>: the OCI runtime spec of slot k's desk container (ADR 0072 sections 2 and 3).

From the spec Docker itself generates for a default container (docker-oci.json, captured at bake): Docker's seccomp profile,
masked and read-only /proc and /sys paths, devices; the slot's own user ID range (100000 + k*65536, reserved on the host),
its own PID, mount, network, IPC, UTS and cgroup namespaces; Docker's capabilities minus NET_RAW, MKNOD and AUDIT_WRITE;
no_new_privs; RLIMIT_CORE 0 (IN-11). The wall's layers:
- WALL-01 (2): AppArmor profile desk-host-<k> (desk-host renders it per slot): net_admin, net_raw and eight more denied to
  every process in the desk, Chromium and any user namespace it makes included.
- WALL-01 (3), RC-02: socket() and socketpair() allow-lists (wallspec.py); clone and unshare with namespace flags allowed
  container-wide for Chromium's sandbox only, since desk-init puts the unit filter on itself and everything it starts but
  the browser launcher's tree (WALL-01 (1), desk-init.py).
- WALL-03: /run/desk-host is the host's own directory for this slot, read-only; /desk-host (desk-init and its files) is the
  host's, read-only, so a desk's root can't change its own init.
- WALL-08: neighbours' disk and swap activity hidden (wallspec.masked()). /proc/stat stays (ADR section 11).
- RC-01: /data isn't in the spec (mounts.py moves the desk's idmapped volume in after runc create); the /run directories it
  shares with its sandboxes are binds from the slot's host tmpfs, made fresh before any desk process.
The cgroup (weight, memory, swap, zswap, io.max, pids) and the network are set from outside by desk-host.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wallspec  # noqa: E402

k, bundle = int(sys.argv[1]), sys.argv[2]
base_id = wallspec.BASE_ID_OF(k)
spec = wallspec.docker_spec()

proc = spec["process"]
proc["terminal"] = False
proc["user"] = {"uid": 0, "gid": 0}
proc["args"] = ["/usr/bin/docker-init", "--", "/usr/bin/python3", "-I", "/desk-host/desk-init.py"]
proc["cwd"] = "/"
proc["env"] = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", f"DESK_HOST_SLOT={k}"]
drop = {"CAP_NET_RAW", "CAP_MKNOD", "CAP_AUDIT_WRITE"}
for kind in ("bounding", "effective", "permitted"):
    proc["capabilities"][kind] = [c for c in proc["capabilities"].get(kind, []) if c not in drop]
proc["capabilities"].pop("inheritable", None)
proc["capabilities"].pop("ambient", None)
proc["noNewPrivileges"] = True
proc["apparmorProfile"] = f"desk-host-{k}"
proc["oomScoreAdj"] = 0
proc["rlimits"] = [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}, {"type": "RLIMIT_CORE", "hard": 0, "soft": 0}]

spec["root"] = {"path": f"{bundle}/rootfs", "readonly": False}
spec["hostname"] = f"desk-{k}"
spec.pop("hooks", None)
spec.pop("annotations", None)

keep = {"/proc", "/dev", "/dev/pts", "/sys", "/dev/mqueue"}
mounts = [m for m in spec["mounts"] if m["destination"] in keep]
mounts += [
    {"destination": "/sys/fs/cgroup", "type": "cgroup", "source": "cgroup", "options": ["nosuid", "noexec", "nodev", "relatime", "rw"]},
    {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=2g"]},
    {"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755", "size=256m"]},
    wallspec.bind(f"{wallspec.LIB}/desk", "/desk-host", ro=True),
    wallspec.bind(f"/run/desk-host/{k}", "/run/desk-host", ro=True, extra=("noexec",)),
    {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=2g"]},
]
if wallspec.test_mode():   # a test host's tools (the CDP forward, the probes); never on a member's host (WR2-01)
    mounts.append(wallspec.bind("/var/lib/desk-host/test", "/desk-host-test", ro=True))
for name, (inside, *_rest) in wallspec.shares(k).items():   # RC-01: host-owned sources only, made fresh before any desk process
    mounts.append(wallspec.bind(f"/run/desk-host/share/{k}/{name}", inside, extra=("noexec",)))
for m in mounts:  # mqueue and devpts inside a user namespace: no gid= option that maps outside it
    if m["destination"] == "/dev/pts":
        m["options"] = [o for o in m["options"] if not o.startswith("gid=")]
spec["mounts"] = mounts

lx = spec["linux"]
lx["namespaces"] = [{"type": t} for t in ("pid", "ipc", "uts", "mount", "network", "user", "cgroup")]
lx["uidMappings"] = [{"containerID": 0, "hostID": base_id, "size": 65536}]
lx["gidMappings"] = [{"containerID": 0, "hostID": base_id, "size": 65536}]
lx["cgroupsPath"] = f"/{wallspec.CGROUP}/desk-{k}/desk"
lx["resources"] = {"devices": lx.get("resources", {}).get("devices", [])}   # limits are on desk-<k>, set by desk-host
lx.pop("sysctl", None)
lx["maskedPaths"] = wallspec.masked(lx.get("maskedPaths", []))
sc = wallspec.seccomp(lx["seccomp"], allow_namespaces=True)
os.makedirs(bundle, mode=0o711, exist_ok=True)
fd = os.open(f"{bundle}/config.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w") as fh:
    json.dump(spec, fh, indent=1)
print(f"desk-{k}: ids {base_id}-{base_id + 65535}, seccomp {sc['defaultAction']} + {len(sc['syscalls'])} rules, caps {len(proc['capabilities']['bounding'])}, "
      f"masked {len(lx['maskedPaths'])}, /data by mounts.py (idmapped), apparmor desk-host-{k}{', test tools' if wallspec.test_mode() else ''}")
