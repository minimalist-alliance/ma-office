#!/usr/bin/python3 -I
"""fixtures.py: TEST ONLY lab fixtures on the u77-host lab box, as root, with test data on test volumes only.

  fixtures.py idle <k> [<sessions>]        an idle.json in slot k's /run share as its deskd (uid 1100) would write it, idle for 2 h
                                           (a stand-in for a deskd that doesn't write one yet; kept fresh by `idle-loop`)
  fixtures.py idle-loop <k> <seconds>      the same every 20 s for that long
  fixtures.py lv <k> <version>             browser/profile/Last Version on slot k's STOPPED test volume set to <version>, as ADR 0035's
                                           run faked a newer one (the volume mounted on the host for that write only: a test volume)
  fixtures.py fmt <k>                      the SHA-256 of the volume's format record (/.ma-volume), read with debugfs (read-only)
  fixtures.py dbg <k> <path>               a file of slot k's test volume, read with debugfs (read-only): a log, the Cookies hash
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, "/usr/local/lib/desk-host")
import templates as T  # noqa: E402


def dev_of(k):
    vol = T.record(k).get("volumeId")
    want = vol.replace("-", "", 1)
    for c in os.listdir("/sys/class/nvme"):
        if open(f"/sys/class/nvme/{c}/serial").read().strip() == want:
            return f"/dev/{c}n1"
    raise SystemExit(f"slot {k}: its volume isn't attached")


def idle(k, sessions=0):
    base = 100000 + k * 65536
    d = f"/run/desk-host/share/{k}/desk"
    now = time.time()
    body = json.dumps({"at": T.utc(now), "sessions": sessions, "agentTasks": 0, "exports": 0, "downloads": 0, "idleSince": T.utc(now - 7200),
                       "lastInputAt": T.utc(now - 7200), "idleStopSeconds": 1200}).encode()
    pid = os.fork()
    if pid == 0:
        os.setgroups([])
        os.setgid(base + 1100)
        os.setuid(base + 1100)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".idle-")
        os.write(fd, body)
        os.close(fd)
        os.chmod(tmp, 0o644)
        os.rename(tmp, f"{d}/idle.json")
        os._exit(0)
    os.waitpid(pid, 0)


a = sys.argv[1:]
if a[0] == "idle":
    idle(int(a[1]), int(a[2]) if len(a) > 2 else 0)
elif a[0] == "idle-loop":
    end = time.time() + float(a[2])
    while time.time() < end:
        try:
            idle(int(a[1]))
        except OSError:
            pass
        time.sleep(20)
elif a[0] == "lv":
    k = int(a[1])
    assert subprocess.run(["runc", "state", f"dh-desk-{k}"], capture_output=True).returncode != 0, "the slot's desk is running"
    dev = dev_of(k)
    m = tempfile.mkdtemp(prefix="lab-lv-")
    subprocess.run(["mount", "-o", "nosuid,nodev,noexec", dev, m], check=True)
    try:
        p = f"{m}/browser/profile/Last Version"
        st = os.stat(p)
        old = open(p).read().strip()
        open(p, "w").write(a[2])
        os.chown(p, st.st_uid, st.st_gid)
        print(json.dumps({"slot": k, "was": old, "now": a[2]}))
    finally:
        subprocess.run(["umount", m], check=True)
        os.rmdir(m)
elif a[0] == "dbg":
    r = subprocess.run(["debugfs", "-R", f"cat {a[2]}", dev_of(int(a[1]))], capture_output=True)
    if a[2].endswith(("Cookies", "Login Data")):
        print(T.sha256_bytes(r.stdout)[:16], len(r.stdout), "bytes")
    else:
        sys.stdout.write(r.stdout.decode(errors="replace")[-3000:])
elif a[0] == "fmt":
    r = subprocess.run(["debugfs", "-R", "cat /.ma-volume", dev_of(int(a[1]))], capture_output=True)
    print(T.sha256_bytes(r.stdout), r.stdout.decode(errors="replace").strip()[:120])
