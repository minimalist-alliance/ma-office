#!/usr/bin/python3 -I
"""preread.py <k> [--dry]: read what a desk will read first from the host's side, before `runc start`, so its pages are in the host's page
cache and charged to nobody's desk (ADR 0072 section 10, "a wake"). `desk-host up` runs it beside the rest of its start and waits for it.

What it reads, in order, all of it host-owned or the desk's own files read-only and only by path:
  the files named in /etc/desk-host/preread.list, relative to the slot's directory (`rootfs/...`, the desk's root, or `rel/...`, the host-owned
  release copies; one path or directory per line, `#` comments): the read trace of a cold wake. Paths are resolved inside the root or
  the release copies without following a link out of them, so a desk that has put a link there can't make the host read anything else.
  A line `---` splits the list: with --gate <file>, the file is created once what's above the line is read (the start waits for that),
  and the rest is read beside the running desk.

The read is capped: it runs in its own cgroup (/sys/fs/cgroup/desk-host-pre, not under desk-host, so no desk's cap or share) with
io.max rbps on the slot store at PREREAD_SHARE (desk-host.conf, default 0.2) of the instance's EBS baseline. Every desk's io.max sums to at
most 0.8 of the baseline, so the host's read fits in the part nobody holds (0.8 + 0.2). Nothing is written but that cgroup's limits.
Prints one line: bytes read, files, seconds, rate.

Template generations (ADR 0077): the list's byte ranges were traced on g1. On a slot whose root is another generation, a file whose
content isn't g1's (/var/lib/desk-host/templates/<gen>.changed, written at the seal) is read whole, since its ranges are stale.
While any pre-read runs, desk-host-upd (fetches, re-roots, the host's apt) is frozen, so the host's own I/O stays within the 0.2
of the baseline the desks leave (ADR 0077 section 4).
"""
import os
import sys
import time

DH = "/srv/desk-host"
CONF = "/etc/desk-host/desk-host.conf"
LIST = "/etc/desk-host/preread.list"
PRE = "/sys/fs/cgroup/desk-host-pre"
CHUNK = 1 << 20


def conf():
    out = {}
    try:
        with open(CONF) as fh:
            lines = fh.read().splitlines()
        for line in lines:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def walk(top, root):
    """Regular files under `top` (a path inside `root`), in directory order, no link followed and nothing outside `root`."""
    try:
        st = os.lstat(top)
    except OSError:
        return
    if os.path.islink(top):
        return
    if os.path.isfile(top):
        yield top
        return
    for dp, dns, fns in os.walk(top, followlinks=False):
        dns.sort()
        for f in sorted(fns):
            p = os.path.join(dp, f)
            if os.path.isfile(p) and not os.path.islink(p) and os.path.realpath(p).startswith(root + "/"):
                yield p


def listed(slot):
    """[(path, stage, ranges)] from the list: paths relative to the slot's directory, each optionally followed by the byte ranges to read,
    `offset+length,offset+length` (the whole file without them); a line `---` starts stage 2 (read after the gate opens)."""
    out, stage = [], 1
    try:
        with open(LIST) as fh:
            lines = fh.read().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if line == "---":
            stage = 2
        elif line:
            f = line.split()
            path = f[0]
            if ".." in path.split("/") or path.split("/")[0] not in ("rootfs", "rel") or len(f) > 2:
                continue
            ranges = None
            if len(f) == 2:
                try:
                    ranges = [(int(a), int(b)) for a, b in (r.split("+") for r in f[1].split(","))]
                except ValueError:
                    continue
            out.append((os.path.join(slot, path.lstrip("/")), stage, ranges))
    return out


def cap(store_dev, itype_bps):
    """Own cgroup with an io.max on the store's device; the reader moves into it. Returns False when cgroups can't be set (a read without a cap isn't made)."""
    try:
        os.makedirs(PRE, exist_ok=True)
        with open(f"{PRE}/io.max", "w") as fh:
            fh.write(f"{store_dev} rbps={int(itype_bps)}\n")
        with open(f"{PRE}/cgroup.procs", "w") as fh:
            fh.write(str(os.getpid()))
        return True
    except OSError as e:
        print(f"preread: no cgroup cap ({e.strerror}), not reading", file=sys.stderr)
        return False


def stale_ranges(k):
    """Template paths (rootfs/...) whose traced ranges don't fit the slot's generation: files changed from g1."""
    try:
        import json
        gen = json.load(open(f"/var/lib/desk-host/slots/{k}.json")).get("template")
        if not isinstance(gen, str) or gen == "g1" or not gen[1:].isdigit():
            return set()
        with open(f"/var/lib/desk-host/templates/{gen}.changed") as fh:
            return {"rootfs/" + line.strip() for line in fh if line.strip()}
    except (OSError, ValueError):
        return set()


def freeze_upd(on):
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import templates
        templates.upd_freeze(on)
    except Exception as e:  # noqa: BLE001 - a freeze that can't be set never stops a wake
        print(f"preread: desk-host-upd's freeze not set ({type(e).__name__})", file=sys.stderr)


def main(a):
    if not a or not a[0].isdigit():
        print(__doc__, file=sys.stderr)
        return 2
    k = int(a[0])
    slot = f"{DH}/slots/{k}"
    root = os.path.realpath(f"{slot}/rootfs")
    rel = os.path.realpath(f"{slot}/rel")
    if not (rel.startswith(f"{DH}/slots/") and root.startswith(f"{DH}/slots/")):
        print("preread: the slot isn't under the store", file=sys.stderr)
        return 1
    cf = conf()
    if cf.get("PREREAD", "on") == "off":
        print("preread: off")
        return 0
    share = float(cf.get("PREREAD_SHARE", "0.2"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("classes", os.path.dirname(os.path.abspath(__file__)) + "/classes.py")
    cl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cl)
    itype = os.environ.get("PREREAD_ITYPE", "")
    mbps, _ = cl.BASELINE.get(itype, cl.BASELINE_DEFAULT)
    rate = mbps * 1e6 * share
    if "--dry" not in a and not cap(cl.store_dev(), rate):
        return 1
    gate = a[a.index("--gate") + 1] if "--gate" in a else None
    stale = stale_ranges(k)
    if "--dry" not in a:
        freeze_upd(True)
    try:
        return run(a, k, slot, root, rel, rate, gate, stale)
    finally:
        if "--dry" not in a:
            freeze_upd(False)


def run(a, k, slot, root, rel, rate, gate, stale):
    t0, total, n, seen, stage = time.monotonic(), 0, 0, set(), 1
    def open_gate():
        if gate:
            with open(gate, "w") as fh:
                fh.write("1\n")
    for top, st, ranges in listed(slot) + [(None, 2, None)]:
        if top is not None and ranges and os.path.relpath(top, slot) in stale:
            ranges = None   # changed from g1: its traced ranges are stale, so the whole file
        if st == 2 and stage == 1:
            stage = 2
            print(f"preread: stage 1 (before the start): {total / 1048576:.0f} MB in {n} files, {time.monotonic() - t0:.1f} s", flush=True)
            open_gate()
        if top is None:
            break
        base = root if top.startswith(root + "/") else rel
        for p in walk(top, base):
            if p in seen:
                continue
            seen.add(p)
            if "--dry" in a:
                total += os.path.getsize(p)
                n += 1
                continue
            try:
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOCTTY)
            except OSError:
                continue
            try:
                for off, ln in (ranges or [(0, 1 << 62)]):
                    while ln > 0:
                        b = os.pread(fd, min(CHUNK, ln), off)
                        if not b:
                            break
                        total += len(b)
                        off += len(b)
                        ln -= len(b)
            except OSError:
                pass
            finally:
                os.close(fd)
            n += 1
    dt = time.monotonic() - t0
    open_gate()
    print(f"preread: slot {k}: {total / 1048576:.0f} MB in {n} files, {dt:.1f} s, {total / 1048576 / max(dt, 1e-9):.1f} MB/s (cap {rate / 1e6:.1f} MB/s)")
    return 0


sys.exit(main(sys.argv[1:]))
