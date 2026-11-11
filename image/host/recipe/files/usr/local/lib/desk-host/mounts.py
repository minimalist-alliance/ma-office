#!/usr/bin/python3 -I
"""mounts.py vol <k> <device> <volume id>: the desk's volume into slot k's desk and its services (ADR 0072 section 5; the
shared-host image, from the wall test's run 2).

WALL-05 and RC-01, as host root, after `runc create` of the desk and its services' sandboxes and before any of them starts:
1. In a mount namespace of its own (private, gone when this exits), never the host's: if the device is blank, mkfs and
   the format record /.ma-volume and the services' directories (desk, files, rtc, agent, notebook) with the desk's own on-disk
   owners, written through the fresh mount's descriptor (a volume no desk has run on, the one write ADR 0072 section 3
   allows). Then fsopen("ext4"), fsmount() with MOUNT_ATTR_NOSUID|NODEV|NOEXEC, and mount_setattr(MOUNT_ATTR_IDMAP) to the
   desk's user namespace (its host-owned bind, /run/desk-host/ns/<k>/user): on disk the volume keeps the desk's own uids
   (0, 1100 to 1110), so it works in any slot, on any host and back on an instance of its own, with no chown.
   The volume is attached only here, in this private namespace, because open_tree() can't clone from a detached mount on
   this kernel; no raw or idmapped mount of a member's volume is ever attached in the host's namespace.
2. Each service's directory is resolved from the volume's own root with openat2(RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS |
   RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV) and cloned with open_tree(OPEN_TREE_CLONE). A link, a file or a missing
   directory where the desk's root put one gets that service refused (printed with its errno; desks.sh doesn't start it),
   never followed. deskd's second directory, files (its Files tree, free walk H5), is optional: missing, a link or a file
   there skips only that mount, never followed, and deskd starts with the placeholder its spec put there (Files answers
   unavailable for that run). A volume from before 0.1.11 has none: the desk's own init makes it, and the next start mounts
   it. The whole volume is cloned for the desk itself, and for desk-data a read-only clone of the whole volume
   (MOUNT_ATTR_RDONLY on the clone) with its scratch directory, .ma-export-tmp, read-write on top (WALL-06).
3. setns() into the desk's mount namespace, then into each sandbox's (their host-owned binds), and move_mount() each clone
   onto its target, opened there with RESOLVE_IN_ROOT and no links (crossing that namespace's own mounts allowed).
Prints one line per mount, "refused <service> ..." for each refusal and "skipped <service> /data/<dir> ..." for an optional
directory left out; /run/desk-host/<k>.mounts.json records both ("refused", "skipped": {service: {dir: errno}}). Exit 0
unless the desk's own /data failed.

mounts.py svc <k> <service>: one service's /data directory into its sandbox made again by a live switch (ADR 0078 section 2.2),
after its `runc create` and before its `runc start`, while the desk runs. As vol's step 2 and 3 for that service alone: in a mount
namespace of its own (private, gone when this exits), a FRESH fsopen("ext4") / fsmount() of the slot's volume (the device vol
recorded in /run/desk-host/<k>.mounts.json; never formatted here: a volume no desk ran on isn't a running desk's), idmapped to the
desk's user namespace (its host-owned bind), then the service's directories resolved from its root with openat2(RESOLVE_IN_ROOT |
RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV), cloned with open_tree(OPEN_TREE_CLONE) and moved into the
sandbox's mount namespace (its host-owned bind, /run/desk-host/ns/<k>/mnt-<service>). The kernel hands back the volume's own
superblock (the desk's mount of it is the same filesystem), so the service sees the desk's files, not a copy. Nothing is written to
the volume, and nothing is ever attached in the host's namespace. Prints one line per mount and "refused"/"skipped" as vol does;
the result goes into /run/desk-host/<k>.svc-<service>.json. Exit 0 unless the service's first directory failed (desk-host then
rolls the switch back: the service can't run without it).

mounts.py peek <k> <device>: the profile's Last Version from a stopped desk's volume (ADR 0072 section 3's read; ADR 0077
section 2), for the host's choice of the slot's template generation. In a mount namespace of its own: if the ext4 superblock
says the journal needs replaying, nothing is mounted and the read is "unreadable" (a replay would write the member's volume);
otherwise fsopen("ext4") with ro and norecovery, fsmount() with MOUNT_ATTR_RDONLY|NOSUID|NODEV|NOEXEC, never attached
anywhere, and browser/profile/Last Version opened from it with openat2(RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV), under RC-06's rules: O_NONBLOCK, a regular file of at most 64 KiB (the caller runs it
under a timeout). Prints one JSON line: {"state": "ok", "version": "156.0.8078.79"}, {"state": "absent"} (no profile, or no
Last Version: a new profile, no constraint) or {"state": "unreadable", "why": ...}. Nothing is written to the volume.
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
DIRS = {"desk": (1100, 1100, 0o750), "files": (1100, 1100, 0o700), "rtc": (1101, 1101, 0o700), "agent": (1103, 1103, 0o700),
        "notebook": (1105, 1105, 0o700), ".ma-export-tmp": (1112, 1112, 0o700)}   # desk-data's scratch, its own uid (WALL-06)
# Each service's directories, in order; the first is the one it can't run without (refused if it can't be had), the rest
# optional (skipped if they can't). files is deskd's Files tree, /data/files (deskd API.md section 16; free walk H5).
SERVICES = {"deskd": ("desk", "files"), "desk-agent": ("agent",), "desk-notebook": ("notebook",), "desk-rtc": ("rtc",)}
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


def clone_dirs(root, services, have_ns):
    """Step 2's per-service clones: {svc: [(sub, tree), ...]}, the services refused (a first directory that can't be had)
    and those skipped ({svc: {sub: errno name}}: an optional directory left out). Each resolved with the openat2 rule."""
    trees, refused, skipped = {}, [], {}
    for svc, subs in services.items():
        if not have_ns(svc):
            continue
        got = []
        for i, sub in enumerate(subs):
            try:
                d = openat2(root, sub, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
                got.append((sub, sysc("open_tree", d, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)))
                os.close(d)
            except OSError as e:
                why = errno.errorcode.get(e.errno, str(e.errno))
                if i == 0:
                    refused.append(svc)
                    print(f"refused {svc}: /data/{sub}: openat2(RESOLVE_IN_ROOT|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) {why}")
                    for _sub, tree in got:
                        os.close(tree)
                    got = None
                    break
                skipped.setdefault(svc, {})[sub] = why
                print(f"skipped {svc}: /data/{sub}: openat2(RESOLVE_IN_ROOT|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) {why}; its placeholder stays")
        if got is not None:
            trees[svc] = got
    return trees, refused, skipped


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
    trees, refused, skipped = clone_dirs(root, SERVICES, lambda svc: f"{nsd}/mnt-{svc}" in NSFD)
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
    for svc, got in trees.items():
        for i, (sub, tree) in enumerate(got):
            try:
                move_into(tree, f"{nsd}/mnt-{svc}", f"data/{sub}", f"{svc}: /data/{sub}")
            except OSError as e:
                if i == 0:
                    refused.append(svc)
                    print(f"refused {svc}: its target: {e}")
                    break
                skipped.setdefault(svc, {})[sub] = f"target: {errno.errorcode.get(e.errno, e.errno)}"
                print(f"skipped {svc}: /data/{sub}: its target: {e}; its placeholder stays")
    if data_ro is not None:
        try:
            move_into(data_ro, f"{nsd}/mnt-desk-data", "data", "desk-data: /data (read-only)")
            move_into(data_scratch, f"{nsd}/mnt-desk-data", f"data/{SCRATCH}", f"desk-data: /data/{SCRATCH} (read-write)")
        except OSError as e:
            refused.append("desk-data")
            print(f"refused desk-data: its target: {e}")
    setns(host_ns, "the host's own")
    json.dump({"refused": refused, "skipped": skipped, "formatted": formatted, "device": dev, "volumeId": volid}, open(f"/run/desk-host/{k}.mounts.json", "w"))


def svc(k, name):
    """vol's steps 2 and 3 for one service's new sandbox, from a fresh mount of the slot's volume (the docstring's svc)."""
    nsd = f"/run/desk-host/ns/{k}"
    rec = json.load(open(f"/run/desk-host/{k}.mounts.json"))
    dev = rec.get("device")
    if not isinstance(dev, str) or not dev.startswith("/dev/"):
        raise SystemExit(f"slot {k}: no volume device recorded")
    if name != "desk-data" and name not in SERVICES:
        print(f"{name}: no /data directory")
        json.dump({"refused": [], "skipped": {}}, open(f"/run/desk-host/{k}.svc-{name}.json", "w"))
        return 0
    target_ns = f"{nsd}/mnt-{name}"
    if not os.path.exists(target_ns):
        raise SystemExit(f"slot {k}: no mount namespace bound for {name}")
    host_ns = os.open("/proc/self/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
    NSFD[target_ns] = os.open(target_ns, os.O_RDONLY | os.O_CLOEXEC)
    if libc.unshare(CLONE_NEWNS) != 0:
        raise OSError(ctypes.get_errno(), "unshare")
    if libc.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "make-rprivate")
    fs = sysc("fsopen", b"ext4", 1)
    sysc("fsconfig", fs, FSCONFIG_SET_STRING, b"source", dev.encode(), 0)
    sysc("fsconfig", fs, FSCONFIG_CMD_CREATE, None, None, 0)
    mnt = sysc("fsmount", fs, 1, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC)
    os.close(fs)
    userns = os.open(f"{nsd}/user", os.O_RDONLY | os.O_CLOEXEC)
    attr = MountAttr(MOUNT_ATTR_IDMAP, 0, 0, userns)
    sysc("mount_setattr", mnt, b"", AT_EMPTY_PATH, ctypes.byref(attr), ctypes.sizeof(attr))
    os.close(userns)
    priv = f"/run/desk-host/priv-{k}-{name}"
    os.makedirs(priv, mode=0o700, exist_ok=True)
    sysc("move_mount", mnt, b"", -100, priv.encode(), MOVE_MOUNT_F_EMPTY_PATH)   # this private namespace only
    root = os.open(priv, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    refused, skipped = [], {}
    if name == "desk-data":   # the whole volume read-only, its scratch read-write (WALL-06), as vol does
        try:
            ro_tree = sysc("open_tree", root, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)
            ro = MountAttr(MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC, 0, 0, 0)
            sysc("mount_setattr", ro_tree, b"", AT_EMPTY_PATH, ctypes.byref(ro), ctypes.sizeof(ro))
            d = openat2(root, SCRATCH, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            scratch = sysc("open_tree", d, b"", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH)
            os.close(d)
            move_into(ro_tree, target_ns, "data", "desk-data: /data (read-only)")
            move_into(scratch, target_ns, f"data/{SCRATCH}", f"desk-data: /data/{SCRATCH} (read-write)")
        except OSError as e:
            refused.append("desk-data")
            print(f"refused desk-data: {e}")
    else:
        trees, refused, skipped = clone_dirs(root, {name: SERVICES[name]}, lambda s_: True)
        for svc_, got in trees.items():
            for i, (sub, tree) in enumerate(got):
                try:
                    move_into(tree, target_ns, f"data/{sub}", f"{svc_}: /data/{sub}")
                except OSError as e:
                    if i == 0:
                        refused.append(svc_)
                        print(f"refused {svc_}: its target: {e}")
                        break
                    skipped.setdefault(svc_, {})[sub] = f"target: {errno.errorcode.get(e.errno, e.errno)}"
                    print(f"skipped {svc_}: /data/{sub}: its target: {e}; its placeholder stays")
    os.close(root)
    setns(host_ns, "the host's own")
    try:
        os.rmdir(priv)   # a mount point only in the private namespace, which is gone with this process; empty here
    except OSError:
        pass
    json.dump({"refused": refused, "skipped": skipped, "device": dev}, open(f"/run/desk-host/{k}.svc-{name}.json", "w"))
    return 1 if refused else 0


FSCONFIG_SET_FLAG = 0
EXT4_INCOMPAT_RECOVER = 0x4
LAST_VERSION = "browser/profile/Last Version"
VERSION_RE = __import__("re").compile(r"\A[0-9]+(\.[0-9]+){1,3}\Z")


def peek(k, dev):
    """{"state": ...} as the docstring says; never raises for what a desk's volume holds."""
    import stat as st_
    try:
        with open(dev, "rb") as f:   # the ext4 superblock, at 1024: magic at 0x38, s_feature_incompat at 0x60
            f.seek(1024)
            sb = f.read(1024)
        if len(sb) < 0x64 or sb[0x38:0x3A] != b"\x53\xef":
            return {"state": "absent", "why": "no ext4 filesystem (a blank volume: a new profile)"}
        if int.from_bytes(sb[0x60:0x64], "little") & EXT4_INCOMPAT_RECOVER:
            return {"state": "unreadable", "why": "the journal needs replaying; not mounted (a replay would write the volume)"}
    except OSError as e:
        return {"state": "unreadable", "why": f"the device: {errno.errorcode.get(e.errno, e.errno)}"}
    if libc.unshare(CLONE_NEWNS) != 0:
        return {"state": "unreadable", "why": "unshare"}
    if libc.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        return {"state": "unreadable", "why": "make-rprivate"}
    try:
        fs = sysc("fsopen", b"ext4", 1)
        sysc("fsconfig", fs, FSCONFIG_SET_STRING, b"source", dev.encode(), 0)
        sysc("fsconfig", fs, FSCONFIG_SET_FLAG, b"ro", None, 0)
        sysc("fsconfig", fs, FSCONFIG_SET_FLAG, b"norecovery", None, 0)
        sysc("fsconfig", fs, FSCONFIG_CMD_CREATE, None, None, 0)
        mnt = sysc("fsmount", fs, 1, MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC)
        os.close(fs)
    except OSError as e:
        return {"state": "unreadable", "why": f"mount: {e.strerror}"}
    try:
        try:
            fd = openat2(mnt, LAST_VERSION, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_NOCTTY)
        except OSError as e:
            if e.errno == errno.ENOENT:
                return {"state": "absent", "why": "no profile, or no Last Version"}
            return {"state": "unreadable", "why": f"openat2: {errno.errorcode.get(e.errno, e.errno)}"}
        try:
            s = os.fstat(fd)
            if not st_.S_ISREG(s.st_mode) or s.st_size > 64 << 10:
                return {"state": "unreadable", "why": "not a regular file of at most 64 KiB"}
            v = os.read(fd, 65).decode("ascii", "replace").strip()
        finally:
            os.close(fd)
    finally:
        os.close(mnt)
    if not VERSION_RE.match(v):
        return {"state": "unreadable", "why": "Last Version isn't a version"}
    return {"state": "ok", "version": v}


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "vol":
        vol(int(sys.argv[2]), sys.argv[3], sys.argv[4])
    elif len(sys.argv) == 4 and sys.argv[1] == "svc":
        sys.exit(svc(int(sys.argv[2]), sys.argv[3]))
    elif len(sys.argv) == 4 and sys.argv[1] == "peek":
        print(json.dumps(peek(int(sys.argv[2]), sys.argv[3])))
    else:
        raise SystemExit(__doc__)
