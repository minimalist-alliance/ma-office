#!/usr/bin/python3 -I
"""hostfs.py: the only way host root touches a file in a tree a desk controls (its volume, its root copy). The shared-host
image's (ADR 0072 section 3, WALL-03), from the wall test.
  hostfs.py read <tree> <relative path>                      prints the file
  hostfs.py write <tree> <relative path> <uid> <gid> <mode>  stdin to the file: a new temp file, then a rename
Every path is opened with openat2() from a descriptor of <tree>, with RESOLVE_BENEATH (nothing above <tree>, `..` or an
absolute path included), RESOLVE_NO_SYMLINKS (no link anywhere on the path), RESOLVE_NO_MAGICLINKS and RESOLVE_NO_XDEV.
A write creates its temp file O_EXCL beside the target, sets owner and mode on the descriptor, and renames it over the
name, so it never writes through a link the desk planted, and a desk that swaps a directory for a link only gets a refusal.
On a refusal it prints the call and its errno and exits 1. <uid> and <gid> are host IDs (the desk's are shifted).
The design writes nothing in desk trees at all (README, WALL-03); this is for the reads, and for the format record on a
volume no desk has run on yet. Run 2 (RC-06): a read opens O_NONBLOCK, takes only a regular file of at most 64 KiB, and
callers run it under `timeout`, one slot at a time, so a FIFO or a huge file a desk planted costs nothing.
"""
import ctypes
import errno
import os
import stat
import sys

MAX_READ = 64 << 10   # RC-06: what the host reads from a desk (a pairing code, a record) is small

SYS_OPENAT2 = 437
RESOLVE = 0x01 | 0x02 | 0x04 | 0x08   # NO_XDEV | NO_MAGICLINKS | NO_SYMLINKS | BENEATH
libc = ctypes.CDLL(None, use_errno=True)


class OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]


def openat2(dirfd, path, flags, mode=0):
    how = OpenHow(flags | os.O_CLOEXEC, mode, RESOLVE)
    fd = libc.syscall(SYS_OPENAT2, dirfd, path.encode(), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"openat2({path!r}, RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV) failed with {errno.errorcode.get(e, e)}: {os.strerror(e)}")
    return fd


def main():
    op, tree, rel = sys.argv[1], sys.argv[2], sys.argv[3]
    root = os.open(tree, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if op == "read":   # RC-06: never blocks on a FIFO, reads a regular file only, and refuses one past the cap
            fd = openat2(root, rel, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                os.close(fd)
                raise OSError(errno.EINVAL, f"{rel!r} isn't a regular file (mode {oct(stat.S_IFMT(st.st_mode))}), not read")
            if st.st_size > MAX_READ:
                os.close(fd)
                raise OSError(errno.EFBIG, f"{rel!r} is {st.st_size} bytes, over the {MAX_READ}-byte cap, not read")
            with os.fdopen(fd, "rb") as fh:
                sys.stdout.buffer.write(fh.read(MAX_READ))
        elif op == "write":
            uid, gid, mode = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6], 8)
            parent, name = os.path.split(rel)
            pfd = openat2(root, parent or ".", os.O_RDONLY | os.O_DIRECTORY)
            tmp = f".{name}.host-{os.getpid()}"
            fd = openat2(pfd, tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, sys.stdin.buffer.read(1 << 20))
                os.fchown(fd, uid, gid)
                os.fchmod(fd, mode)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(tmp, name, src_dir_fd=pfd, dst_dir_fd=pfd)
            os.close(pfd)
        else:
            raise SystemExit(__doc__)
    except OSError as e:
        print(f"hostfs.py {op} {rel}: {e.strerror}", file=sys.stderr)
        sys.exit(1)


main()
