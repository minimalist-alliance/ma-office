#!/usr/bin/python3 -I
"""shift.py <tree> <base>: add <base> to the owner and group of every file under <tree>, without following links (desk-host prepare).

Gives a desk's own copy of the root filesystem the IDs its user namespace maps to: inside the desk, root is 0 and kiosk is
1102, on the host they are base and base+1102, which no other desk and no host user has. chown clears set-user-ID and
set-group-ID bits on files; inside a desk that only means no program can raise its privileges, which the desk's
no_new_privs already ensures.
"""
import os
import sys

tree, base = sys.argv[1], int(sys.argv[2])


seen = set()  # hard links: one inode, several names, shifted once


def shift(name):
    st = os.lstat(name)
    if st.st_nlink > 1 and not os.path.isdir(name):
        if st.st_ino in seen:
            return
        seen.add(st.st_ino)
    if st.st_uid >= 65536 or st.st_gid >= 65536:
        raise SystemExit(f"{name}: id outside 0-65535 ({st.st_uid}:{st.st_gid})")
    os.lchown(name, base + st.st_uid, base + st.st_gid)


n = 1
shift(tree)  # each entry once: the top, then every directory's children (os.walk lists a directory under its parent)
for dirpath, dirnames, filenames in os.walk(tree):
    for f in dirnames + filenames:
        shift(os.path.join(dirpath, f))
        n += 1
print(f"shifted {n} entries by {base}")
