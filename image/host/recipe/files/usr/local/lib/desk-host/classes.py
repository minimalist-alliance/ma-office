#!/usr/bin/python3 -I
"""classes.py: desk-host's container size classes (ADR 0072, "Container sizes by tier"; /etc/desk-host/classes.conf).

  classes.py check                         the table is valid (desk-host-check's `classes`); exit 1 and why if not
  classes.py names                         the table's class names, one line
  classes.py tag <DeskSlot<k> value>       "<deskId|-> <volumeId|-> <class>" from Platform's slot tag, exit 1 if it doesn't parse
  classes.py values <class> <type>         one desk's cgroup values on this host, in desk-host's order (below)
  classes.py admit <k> <class> <type> [<memory.max>]   exit 0 if slot k may hold <class> (its memory.max, or the one given: a
                                           lower cap that waits keeps the current) beside every other desk, 75 if the host is full
  classes.py applied <type>                every running desk's cgroup against its class (desk-host-check's `class-applied`)

The values for `standard` are exactly the ones desk-host set before classes (0.1.4): memory.max (MemTotal - 640 MiB) //
DesksPerHost, swap DESK_SWAP_MAX, zswap DESK_ZSWAP_MAX, cpu.weight 100, pids.max 8,192, io.max as io_shares computed it.
A class multiplies each. A class's cpu of 0 is the kernel's cpu.idle: its desk runs only on CPU no other desk wants, and any
other desk's thread that wakes takes the CPU from it at once (the kernel then shows cpu.weight 1 and refuses writes to it). The host's own record of what it applied is /run/desk-host/<k>/class.json, host-owned and read-only
in the desk; the admission check reads the cgroups themselves, so it counts what the kernel enforces.
"""
import glob
import json
import os
import re
import sys
from fractions import Fraction

TABLE = "/etc/desk-host/classes.conf"
CONF = "/etc/desk-host/desk-host.conf"
HOSTING = "/var/lib/desk-host/hosting.json"
CGR = "/sys/fs/cgroup/desk-host"
RUN = "/run/desk-host"
DH = "/srv/desk-host"
FIELDS = ("cpu", "memory", "swap", "zswap", "disk", "pids", "egress")
NAME = re.compile(r"\A[a-z][a-z0-9-]{0,31}\Z")
DESK = re.compile(r"\Ad-[a-z0-9]{6,40}\Z")
VOL = re.compile(r"\Avol-[0-9a-f]{8,17}\Z")
IPV4 = re.compile(r"\A(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\Z")
ALLOC = re.compile(r"\Aeipalloc-[0-9a-f]{8,17}\Z")
EPOCH = re.compile(r"\A[0-9]{1,12}\Z")
HOST_RESERVE = 640 * 1048576
PIDS = 8192
CPU_WEIGHT = 100
EX_TEMPFAIL = 75
# EC2's EBS baselines (describe-instance-types, read 2026-11-08) for ma-platform's allow-list; an unknown type gets the smallest
BASELINE = {"c7g.2xlarge": (312.5, 12000), "c8g.2xlarge": (312.5, 12000), "m7g.2xlarge": (312.5, 12000),
            "c7g.4xlarge": (625, 20000), "c8g.4xlarge": (625, 20000)}
BASELINE_DEFAULT = (156.25, 6000)   # c7g.xlarge, c8g.xlarge, m7g.xlarge
# ADR 0036's per-desk rates (Mbit/s), which `egress` multiplies
EGRESS = {"stream_mbps": 60.0, "root_mbps": 2.0, "other_mbps": 100.0}


def conf():
    out = {}
    try:
        with open(CONF) as fh:
            lines = fh.read().splitlines()
        for line in lines:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"')   # the last line wins, as desk-host's conf() reads it
    except OSError:
        pass
    return out


def size(s):
    """A size as desk-host.conf writes one (2G, 1000M, 512K, or bytes) in bytes."""
    m = re.fullmatch(r"([0-9]+)([KMG]?)", s.strip())
    if not m:
        raise ValueError(f"not a size: {s!r}")
    return int(m.group(1)) << {"": 0, "K": 10, "M": 20, "G": 30}[m.group(2)]


def load(path=None):
    """-> ({class: {field: Fraction}}, [problems]). A bad line is a problem, never a guess."""
    path = path or TABLE
    table, probs = {}, []
    try:
        with open(path) as fh:
            lines = fh.read().splitlines()
    except OSError as e:
        return {}, [f"{path}: {e.strerror}"]
    for n, line in enumerate(lines, 1):
        line = line.split("#", 1)[0].split()
        if not line:
            continue
        if len(line) not in (1 + len(FIELDS), 2 + len(FIELDS)):
            probs.append(f"line {n}: {len(line)} fields, not {1 + len(FIELDS)} (or {2 + len(FIELDS)} with a split)")
            continue
        name, vals, split = line[0], line[1:1 + len(FIELDS)], (line[1 + len(FIELDS)] if len(line) == 2 + len(FIELDS) else None)
        if not NAME.match(name):
            probs.append(f"line {n}: bad class name {name!r}")
            continue
        if name in table:
            probs.append(f"line {n}: {name} twice")
            continue
        row = {}
        for f, v in zip(FIELDS, vals):
            try:
                if not re.fullmatch(r"[0-9]+(\.[0-9]{1,3})?", v):
                    raise ValueError
                x = Fraction(v)
            except (ValueError, ZeroDivisionError):
                probs.append(f"line {n}: {name} {f} {v!r} isn't a decimal")
                continue
            hi = 10 if f == "cpu" else 4
            if not (Fraction(1, 100) <= x <= hi or (f == "cpu" and x == 0)):
                probs.append(f"line {n}: {name} {f} {v} is outside 0.01 to {hi}" + (" (or 0, cpu.idle)" if f == "cpu" else ""))
            row[f] = x
        if split is not None:   # the optional 8th column: this class's IO_SPLIT, four percents (root reads, root writes, volume reads, volume writes)
            try:
                sp = parse_split(split)
                row["split"] = sp
            except ValueError as e:
                probs.append(f"line {n}: {name} split {split!r}: {e}")
                continue
        if all(f in row for f in FIELDS):
            table[name] = row
    if "standard" not in table:
        probs.append("no standard class")
    elif any(table["standard"][f] != 1 for f in FIELDS):
        std = table["standard"]
        probs.append("standard isn't all 1s: " + ", ".join(f"{f} {float(std[f]):g}" for f in FIELDS))
    return table, probs


def parse_split(text):
    """'70,5,12.5,12.5' -> [0.7, 0.05, 0.125, 0.125]: four percents, each at least 1, summing to 100 exactly (desk-host.conf's IO_SPLIT form)."""
    parts = text.split(",")
    if len(parts) != 4 or not all(re.fullmatch(r"[0-9]+(\.[0-9]{1,2})?", x) for x in parts):
        raise ValueError("must be four percents, root reads, root writes, volume reads, volume writes")
    q = [Fraction(x) for x in parts]
    if sum(q) != 100 or min(q) < 1:
        raise ValueError("must sum to 100, each at least 1")
    return [float(x / 100) for x in q]


def hosting():
    with open(HOSTING) as fh:
        h = json.load(fh)
    n = int(h["desksPerHost"])
    if not 1 <= n <= 29:
        raise ValueError(f"desksPerHost {n}")
    return n


def mem_total():
    with open("/proc/meminfo") as fh:
        lines = fh.read().splitlines()
    for line in lines:
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    raise ValueError("no MemTotal")


def values(name, itype, table=None):
    """One desk's values: a dict, with `order` as desk-host reads them."""
    table = table if table is not None else load()[0]
    if name not in table:
        raise KeyError(name)
    c, cf, n = table[name], conf(), hosting()
    page = os.sysconf("SC_PAGE_SIZE")
    mem = (mem_total() - HOST_RESERVE) * c["memory"].numerator // (c["memory"].denominator * n)
    swap = size(cf.get("DESK_SWAP_MAX", "2G")) * c["swap"].numerator // c["swap"].denominator // page * page
    zswap = size(cf.get("DESK_ZSWAP_MAX", "1000M")) * c["zswap"].numerator // c["zswap"].denominator // page * page
    sp = c.get("split")   # this class's own split, else the host's IO_SPLIT
    if sp is None:
        sp = [int(x) / 100 for x in cf.get("IO_SPLIT", "40,10,25,25").split(",")]
    if len(sp) != 4 or abs(sum(sp) - 1) >= 1e-9:
        raise ValueError("IO_SPLIT must be four percents summing to 100")
    mbps, iops = BASELINE.get(itype, BASELINE_DEFAULT)
    d = float(c["disk"])
    bps, io = mbps * 1e6 * 0.8 / n * d, iops * 0.8 / n * d   # standard: d is 1.0, so exactly io_shares' numbers
    disk = [v for f in sp for v in (max(1, int(bps * f)), max(1, int(io * f)))]
    idle = int(c["cpu"] == 0)   # cpu.idle 1: the kernel shows cpu.weight 1 and refuses writes to it
    weight = 1 if idle else max(1, min(10000, round(CPU_WEIGHT * c["cpu"])))
    pids = max(1, PIDS * c["pids"].numerator // c["pids"].denominator)
    eg = float(c["egress"])
    return {"class": name, "cpu.idle": idle, "cpu.weight": weight, "memory.max": mem, "memory.swap.max": swap, "memory.zswap.max": zswap,
            "pids.max": pids, "io": disk, "egress": {k: round(v * eg, 3) for k, v in EGRESS.items()},
            "units": {f: str(c[f]) for f in FIELDS}, "desksPerHost": n, "instanceType": itype}


def caps(itype):
    """What the running desks may sum to: memory.max to MemTotal - 640 MiB, and every desk's four byte caps (root and volume, reads and
    writes) to 0.8 of the EBS baseline: a desk's disk share is split however its class says, so the sum over all four is what a class's
    `disk` buys, not the root reads alone."""
    mbps, _ = BASELINE.get(itype, BASELINE_DEFAULT)
    return mem_total() - HOST_RESERVE, mbps * 1e6 * 0.8


def disk_bps(v):
    """A desk's four byte caps summed (values()'s io: bps and iops for root reads, root writes, volume reads, volume writes)."""
    return v["io"][0] + v["io"][2] + v["io"][4] + v["io"][6]


def order(v):
    """desk-host's `read`: cpu.weight (0 for cpu.idle) memory.max swap zswap pids rrb rri rwb rwi vrb vri vwb vwi"""
    return " ".join(str(x) for x in [0 if v["cpu.idle"] else v["cpu.weight"], v["memory.max"], v["memory.swap.max"], v["memory.zswap.max"], v["pids.max"], *v["io"]])


def parse_tag(s):
    """Platform's DeskSlot<k>: <deskId>/<volumeId> (0.1.4's), <deskId|->/<volumeId|->/<privateIp>/<allocationId>/<epoch>
    (contract shared-host.md section 2), or that with /<class> (proposed). Anything else means nothing (None)."""
    p = s.strip().split("/")
    if len(p) == 2:
        desk, vol, cls = p[0], p[1], "standard"
        if not (DESK.match(desk) and VOL.match(vol)):
            return None
    elif len(p) in (5, 6):
        desk, vol, ip, alloc, epoch = p[:5]
        cls = p[5] if len(p) == 6 else "standard"
        if not ((desk == "-" or DESK.match(desk)) and (vol == "-" or VOL.match(vol)) and IPV4.match(ip) and ALLOC.match(alloc)
                and EPOCH.match(epoch) and NAME.match(cls)) or (desk == "-") != (vol == "-"):
            return None
    else:
        return None
    return desk, vol, cls


def rd(p):
    try:
        with open(p) as fh:
            return fh.read().strip()
    except OSError:
        return None


def dev_of(path):
    st = os.stat(path)
    return f"{os.major(st.st_dev)}:{os.minor(st.st_dev)}"


def store_dev():
    with open("/proc/self/mountinfo") as fh:
        lines = fh.read().splitlines()
    for line in lines:
        f = line.split()
        if f[4] == DH:
            return f[2]
    raise ValueError(f"{DH} isn't mounted")


def io_max(cg):
    """{"maj:min": {"rbps": n, ...}} from a cgroup's io.max ("max" is unbounded: None)."""
    out = {}
    for line in (rd(f"{cg}/io.max") or "").splitlines():
        f = line.split()
        if f:
            out[f[0]] = {k: (None if v == "max" else int(v)) for k, v in (x.split("=") for x in f[1:])}
    return out


def running_desks():
    """Every desk cgroup on the host, slot -> path. A cgroup exists from up's admission until stop's reset."""
    out = {}
    for p in glob.glob(f"{CGR}/desk-*"):
        m = re.fullmatch(r"desk-([0-9]{1,2})", os.path.basename(p))
        if m and os.path.isdir(p):
            out[int(m.group(1))] = p
    return out


def used(skip=None):
    """(memory.max summed in bytes, every byte cap of the desk's io.max summed) over every desk cgroup but slot `skip`. A desk with no
    cap on the store counts as full."""
    sd = store_dev()
    mem = bps = 0
    for k, cg in running_desks().items():
        if k == skip:
            continue
        m = rd(f"{cg}/memory.max")
        mem += (1 << 62) if m in (None, "max") else int(m)
        io = io_max(cg)
        if io.get(sd, {}).get("rbps") is None or io.get(sd, {}).get("wbps") is None:
            bps += 1 << 62
            continue
        for d, lim in io.items():
            bps += sum(lim.get(x) or 0 for x in ("rbps", "wbps")) if (lim.get("rbps") is not None and lim.get("wbps") is not None) else (1 << 62)
    return mem, bps


def admit(k, name, itype, memory=None):
    """Whether slot k may hold `name` beside every other desk cgroup on the host: memory and disk each within DesksPerHost units."""
    v = values(name, itype)
    std = values("standard", itype)
    mine = v["memory.max"] if memory is None else memory
    mem, rbps = used(skip=k)
    n = hosting()
    cap_mem, cap_rbps = caps(itype)
    ok = mem + mine <= cap_mem and rbps + disk_bps(v) <= cap_rbps
    sb = disk_bps(std)
    why = (f"memory {(mem + mine) / std['memory.max']:.2f} of {n} units, disk {(rbps + disk_bps(v)) / sb:.2f} of {n} "
           f"(the others {mem / std['memory.max']:.2f} and {rbps / sb:.2f}, this {name} desk {mine / std['memory.max']:.2f} and "
           f"{disk_bps(v) / sb:.2f})")
    return ok, why


def applied(itype):
    """Every desk cgroup's values against its class record: (ok, detail)."""
    page = os.sysconf("SC_PAGE_SIZE")
    probs, seen = [], []
    table, tprobs = load()
    if tprobs:
        return False, f"the table: {tprobs[:3]}"
    sd = store_dev()
    for k, cg in sorted(running_desks().items()):
        try:
            with open(f"{RUN}/{k}/class.json") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            probs.append(f"desk-{k}: no class record")
            continue
        name = rec.get("class")
        if name not in table:
            probs.append(f"desk-{k}: class {name!r} isn't in the table")
            continue
        v = values(name, itype, table)
        pend = (rec.get("pending") or {}).get("memory.max")
        want = {"cpu.idle": v["cpu.idle"], "cpu.weight": v["cpu.weight"], "memory.swap.max": v["memory.swap.max"] // page * page,
                "memory.zswap.max": v["memory.zswap.max"] // page * page, "memory.zswap.writeback": 0, "pids.max": v["pids.max"],
                "memory.max": v["memory.max"] // page * page}
        if pend is not None:   # memory.max (and on a raise io.max) waiting: a lower cap for the next start, a raise for room
            if int(pend) != v["memory.max"]:
                probs.append(f"desk-{k} ({name}) pending memory.max {pend}, not its class's {v['memory.max']}")
            del want["memory.max"]
        for f, w in want.items():
            got = rd(f"{cg}/{f}")
            if got is None or got == "max" or int(got) != w:
                probs.append(f"desk-{k} ({name}) {f} {got}, not {w}")
        io = io_max(cg)
        rrb, rri, rwb, rwi, vrb, vri, vwb, vwi = v["io"]
        if pend is not None and int(pend) > int(rd(f"{cg}/memory.max") or 0):   # a raise waiting: the disk share waits with it
            seen.append(f"{k}:{name}(waiting)")
            continue
        if io.get(sd) != {"rbps": rrb, "wbps": rwb, "riops": rri, "wiops": rwi}:
            probs.append(f"desk-{k} ({name}) io.max on the store {io.get(sd)}")
        vol = [d for d in io if d != sd]
        if len(vol) != 1 or io[vol[0]] != {"rbps": vrb, "wbps": vwb, "riops": vri, "wiops": vwi}:
            probs.append(f"desk-{k} ({name}) io.max on its volume {[io[d] for d in vol]}")
        seen.append(f"{k}:{name}")
    std = values("standard", itype, table)
    n = hosting()
    mem, rbps = used()
    cap_mem, cap_rbps = caps(itype)
    if mem > cap_mem:
        probs.append(f"memory.max sums to {mem / std['memory.max']:.2f} units, past {n}")
    if rbps > cap_rbps:
        probs.append(f"the disk caps sum to {rbps / disk_bps(std):.2f} units, past {n}")
    return not probs, (f"{len(seen)} desk(s) [{' '.join(seen)}] as their classes; memory {mem / std['memory.max']:.2f} and disk "
                       f"{rbps / disk_bps(std):.2f} of {n} units") + (f"; {probs[:6]}" if probs else "")


def main(a):
    if not a:
        print(__doc__, file=sys.stderr)
        return 2
    if a[0] == "check":
        table, probs = load()
        if probs:
            print("; ".join(probs))
            return 1
        print(f"{len(table)} classes: " + ", ".join(n + " (" + " ".join(f"{f} {float(table[n][f]):g}" for f in FIELDS) + ")" for n in table))
        return 0
    if a[0] == "names":
        table, probs = load()
        print(" ".join(table))
        return 1 if probs else 0
    if a[0] == "tag" and len(a) == 2:
        t = parse_tag(a[1])
        if t is None:
            return 1
        print(*t)
        return 0
    if a[0] == "values" and len(a) == 3:
        table, probs = load()
        if probs:
            print(f"classes.conf: {'; '.join(probs)}", file=sys.stderr)
            return 1
        if a[1] not in table:
            print(f"no class {a[1]!r} in {TABLE} (it has {' '.join(table)})", file=sys.stderr)
            return 1
        v = values(a[1], a[2], table)
        print(order(v))
        return 0
    if a[0] == "json" and len(a) == 3:
        print(json.dumps(values(a[1], a[2])))
        return 0
    if a[0] == "admit" and len(a) in (4, 5):
        ok, why = admit(int(a[1]), a[2], a[3], int(a[4]) if len(a) == 5 else None)
        print(why)
        return 0 if ok else EX_TEMPFAIL
    if a[0] == "applied" and len(a) == 2:
        ok, why = applied(a[1])
        print(why)
        return 0 if ok else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
