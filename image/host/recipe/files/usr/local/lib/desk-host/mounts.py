#!/usr/bin/python3 -I
"""mounts.py vol <k> <device> <volume id>: the desk's volume into slot k's desk and its services (ADR 0072 section 5; the
shared-host image, from the wall test's run 2).

WALL-05 and RC-01, as host root, after `runc create` of the desk and its services' sandboxes and before any of them starts:
1. In a mount namespace of its own (private, gone when this exits), never the host's: if the device is blank, mkfs and
   the format record /.ma-volume and the services' directories (desk, rtc, agent, notebook) with the desk's own on-disk
   owners, written through the fresh mount's descriptor (a volume no desk has run on, the one write ADR 0072 section 3
   allows). Then fsopen("ext4"), fsmount() with MOUNT_ATTR_NOSUID|NODEV|NOEXEC, and mount_setattr(MOUNT_ATTR_IDMAP) to the
   desk's user namespace (its host-owned bind, /run/desk-host/ns/<k>/user): on disk the volume keeps the desk's own uids
   (0, 1100 to 1110), so it works in any slot, on any host and back on an instance of its own, with no chown.
   The volume is attached only here, in this private namespace, because open_tree() can't clone from a detached mount on
   this kernel; no raw or idmapped mount of a member's volume is ever attached in the host's namespace.
2. Each service's directory is resolved from the volume's own root with openat2(RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS |
   RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV) and cloned with open_tree(OPEN_TREE_CLONE). A link, a file or a missing
   directory where the desk's root put one gets that service refused (printed with its errno; desks.sh doesn't start it),
   never followed. The whole volume is cloned for the desk itself, and for desk-data a read-only clone of the whole volume
   (MOUNT_ATTR_RDONLY on the clone) with its scratch directory, .ma-export-tmp, read-write on top (WALL-06).
3. setns() into the desk's mount namespace, then into each sandbox's (their host-owned binds), and move_mount() each clone
   onto its target, opened there with RESOLVE_IN_ROOT and no links (crossing that namespace's own mounts allowed).
Prints one line per mount, and "refused <service> ..." for each refusal. Exit 0 unless the desk's own /data failed.
"""
import ctypes
import errno
import json
import os
import subprocess
import sys

libc = ctypes.CDLL(None, use_errno=True)
NR = {"open_tree": 428, "move_mount": 429, "fsopen": 430, "fsconfig": 431, "fsmount": 432, "mount_setattr": 442, "openat2": 437}
FSCONFIG_SET_STRING, FSCONFIG_CMD_CREATE = 1, 6
MOUNT_ATTR_RDONLY, MOUNT_ATTR_NOSUID, MOUNT_ATTR_NODEV, MOUNT_ATTR_NOEXEC, MOUNT_ATTR_IDMAP = 0x1, 0x2, 0x4, 0x8, 0x100000
OPEN_TREE_CLONE, OPEN_TREE_CLOEXEC, AT_EMPTY_PATH, AT_RECURSIVE = 1, 0o2000000, 0x1000, 0x8000
MOVE_MOUNT_F_EMPTY_PATH, MOVE_MOUNT_T_EMPTY_PATH = 0x4, 0x40
RESOLVE_NO_XDEV, RESOLVE_NO_MAGICLINKS, RESOLVE_NO_SYMLINKS, RESOLVE_IN_ROOT = 0x01, 0x02, 0x04, 0x10
RESOLVE = RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_IN_ROOT
CLONE_NEWNS = 0x20000
MS_REC, MS_PRIVATE = 0x4000, 1 << 18
# The desk's own uids, as desk-init's datadirs() makes these directories (desk:desk 750, rtc 700, agent 700, notebook 700)
DIRS = {"desk": (1100, 1100, 0o750), "rtc": (1101, 1101, 0o700), "agent": (1103, 1103, 0o700), "notebook": (1105, 1105, 0o700),
        ".ma-export-tmp": (1112, 1112, 0o700)}   # desk-data's scratch, its own uid (WALL-06)
SERVICES = {"deskd": "desk", "desk-agent": "agent", "desk-notebook": "notebook", "desk-rtc": "rtc"}
SCRATCH = ".ma-export-tmp"


NSFD = {}   # namespace file -> descriptor, opened in the host's mount namespace


class OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]


class MountAttr(ctypes.Structure):
    _fields_ = [("attr_set", ctypes.c_uint64), ("attr_clr", ctypes.c_uint64), ("propagation", ctypes.c_uint64), ("userns_fd", ctypes.c_uint64)]


def sysc(name, *args):
    r = libc.syscall(NR[name], *args)
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"{name}: {errno.errorcode.get(e, e)}")
    return r


def openat2(dirfd, path, flags, resolve=RESOLVE):
    how = OpenHow(flags | os.O_CLOEXEC, 0, resolve)
    return sysc("openat2", dirfd, path.encode(), ctypes.byref(how), ctypes.sizeof(how))


def setns(fd, path):
    if libc.setns(fd, CLONE_NEWNS) != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"setns({path}): {errno.errorcode.get(e, e)}")


def move_into(tree, ns, target, what):
    """setns into ns (a descriptor opened before this process left the host's namespace: a copy of a mount namespace
    drops the binds of mount namespace files), open target there with the openat2 rule, attach tree on it."""
    setns(NSFD[ns], ns)
    root = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    # a target may sit on another mount of the namespace (a sandbox's /data tmpfs), so no RESOLVE_NO_XDEV here; no links still
    t = openat2(root, target, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)
    sysc("move_mount", tree, b"", t, b"", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH)
    os.close(t)
    os.close(root)
    print(f"{what}: attached at {target}")


def vol(k, dev, volid):
    nsd = f"/run/desk-host/ns/{k}"
    host_ns = os.open("/proc/self/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
    for name in ["mnt"] + [f"mnt-{svc}" for svc in SERVICES] + ["mnt-desk-data"]:
        if os.path.exists(f"{nsd}/{name}"):
            NSFD[f"{nsd}/{name}"] = os.open(f"{nsd}/{name}", os.O_RDONLY | os.O_CLOEXEC)
    # 1. a private mount namespace of its own
    if libc.unshare(CLONE_NEWNS) != 0:
        raise OSError(ctypes.get_errno(), "unshare")
    if libc.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "make-rprivate")
    formatted = subprocess.run(["blkid", "-p", dev], capture_output=True).returncode == 2
    if formatted:
        subprocess.run(["mkfs.ext4", "-q", "-L", "ma-data", dev], check=True)
    fs = sysc("fsopen", b"ext4", 1)
    sysc("fsconfig", fs, FSCONFIG_SET_STRING, b"source", dev.encode(), 0)
    sysc("fsconfig", fs, FSCONFIG_CMD_CREATE, None, None, 0)
    mnt = sysc("fsmount", fs, 1, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC)
    os.close(fs)
    if formatted:   # a volume no desk has run on: the record and the services' directories, on-disk owners the desk's own
        rec = openat2(mnt, ".ma-volume", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
        os.write(rec, (json.dumps({"volumeId": volid, "formattedAt": subprocess.run(["date", "-u", "+%FT%TZ"], capture_output=True, text=True).stdout.strip()}) + "\n").encode())
        os.fchmod(rec, 0o644)
        os.close(rec)
        for name, (u, g, mode) in DIRS.items():
            os.mkdir(name, mode, dir_fd=mnt)
            os.chown(name, u, g, dir_fd=mnt, follow_symlinks=False)
            os.chmod(name, mode, dir_fd=mnt, follow_symlinks=False)
        print(f"formatted {volid} (blank): record and {', '.join(DIRS)} written before any desk ran on it")
    userns = os.open(f"{nsd}/user", os.O_RDONLY | os.O_CLOEXEC)
    attr = MountAttr(MOUNT_ATTR_IDMAP, 0, 0, userns)
    sysc("mount_setattr", mnt, b"", AT_EMPTY_PATH, ctypes.byref(attr), ctypes.sizeof(attr))
    os.close(userns)
    priv = f"/run/desk-host/priv-{k}"
    os.makedirs(priv, mode=0o700, exist_ok=True)
    sysc("move_mount", mnt, b"", -100, priv.encode(), MOVE_MOUNT_F_EMPTY_PATH)   # this private namespace only
    root = os.open(priv, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    # 2. one clone for the desk, one per service directory, each resolved without links or crossings
    whole = sysc("open_tree", root, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH | AT_RECURSIVE)
    trees, refused = {}, []
    for svc, sub in SERVICES.items():
        if f"{nsd}/mnt-{svc}" not in NSFD:
            continue
        try:
            d = openat2(root, sub, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            trees[svc] = (sub, sysc("open_tree", d, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH))
            os.close(d)
        except OSError as e:
            refused.append(svc)
            print(f"refused {svc}: /data/{sub}: openat2(RESOLVE_IN_ROOT|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) {errno.errorcode.get(e.errno, e.errno)}")
    data_ro = data_scratch = None
    if f"{nsd}/mnt-desk-data" in NSFD:   # desk-data: the whole volume read-only, its scratch read-write (WALL-06)
        try:
            data_ro = sysc("open_tree", root, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)
            ro = MountAttr(MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC, 0, 0, 0)
            sysc("mount_setattr", data_ro, b"", AT_EMPTY_PATH, ctypes.byref(ro), ctypes.sizeof(ro))
            d = openat2(root, SCRATCH, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            data_scratch = sysc("open_tree", d, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)
            os.close(d)
        except OSError as e:
            refused.append("desk-data")
            data_ro = data_scratch = None
            print(f"refused desk-data: /data/{SCRATCH}: openat2(RESOLVE_IN_ROOT|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) {errno.errorcode.get(e.errno, e.errno)}")
    os.close(root)
    # 3. into the desk's namespace and each sandbox's
    move_into(whole, f"{nsd}/mnt", "data", f"desk {k}: the volume (idmapped, nosuid,nodev,noexec)")
    for svc, (sub, tree) in trees.items():
        try:
            move_into(tree, f"{nsd}/mnt-{svc}", f"data/{sub}", f"{svc}: /data/{sub}")
        except OSError as e:
            refused.append(svc)
            print(f"refused {svc}: its target: {e}")
    if data_ro is not None:
        try:
            move_into(data_ro, f"{nsd}/mnt-desk-data", "data", "desk-data: /data (read-only)")
            move_into(data_scratch, f"{nsd}/mnt-desk-data", f"data/{SCRATCH}", f"desk-data: /data/{SCRATCH} (read-write)")
        except OSError as e:
            refused.append("desk-data")
            print(f"refused desk-data: its target: {e}")
    setns(host_ns, "the host's own")
    json.dump({"refused": refused, "formatted": formatted, "device": dev, "volumeId": volid}, open(f"/run/desk-host/{k}.mounts.json", "w"))


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "vol":
        vol(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    else:
        raise SystemExit(__doc__)
