#!/usr/bin/python3 -I
"""egress.py: ADR 0036's outbound shaper and its budgets for each desk on a shared host (ADR 0072 section 8; TD-223). Host root.

It is a desk of its own's desk-egress (image/recipe/desk-egress/desk-egress: the template's own code, which the host recipe installs
beside this file as desk_egress.py), run by the host for one slot:
- **The classes** (ADR 0036 section 2: 1:10 desk-rtc from its ports, 1:15 root and deskd, 1:20 everything else; rate equal to
  ceiling, so nothing borrows) are an HTB on the desk's end of its veth, eth0 in its network namespace, where the template's
  `classify` chain has already set each packet's skb->priority. The host's end can't take them: forwarding sets the priority again
  from the TOS byte. The desk's root has no CAP_NET_ADMIN (the wall: Docker's capabilities, none of them it), so nothing in the desk
  can change or remove them; desk-host enters only the namespace's network side to put them on (WALL-02), before anything runs.
- **The budgets** (section 5's layers 2 to 5: the bucket on 1:15 and 1:20, the stream's profile steps, desk-rtc's clamp) run in
  desk-host-egress@<k>.service, one per running slot, on the host. Their state is the host's, /var/lib/desk-host/egress/<deskId>.json
  (WALL-03: never the desk's /data). A desk moved to another host starts them over there; the guard's count goes on.
- **The stream's profile** is the host's file /run/desk-host/<k>/egress/profile, read-only in the desk: desk-stream's sandbox has it
  at /run/desk-egress (its run picks stream-<profile>.conf) and desk-init restarts a running desk-stream when it changes.
- **The rates** are the slot's class's: classes.conf's `egress`, a multiple of a desk's, read from /run/desk-host/<k>/class.json at
  every tick, so `desk-host class` changes them live. A Guild Desk never runs on a shared host, so there is no voice class here.
- **It fails open, as on a desk of its own:** a shaper that won't go on doesn't keep the desk from starting (desk-host-check's
  `shaper` says so), no clamp outlives the process (the unit's ExecStopPost) or 10 failed ticks, and the guard's count and stop
  (out_<k>, the host's forward path) stand behind it whatever happens here.

  egress.py on <k>         slot k's classes on its veth at its budget's rates, and its profile (desk-host up, before runc start)
  egress.py run <k>        the budgets, every tick_seconds (desk-host-egress@<k>.service)
  egress.py unclamp <k>    the normal rates, once (the unit's ExecStopPost)
  egress.py off <k>        the classes off slot k's veth (desk-host shaper <k> off: test 1's R5, the shaper lost as a bug would lose it)
  egress.py show <k>       slot k's classes, counters and budget, as report.py carries them (one JSON line)

Settings: /etc/desk-host/egress.conf's [egress] (the desk's /etc/ma/egress.conf keys, but interface), then its [slot<k>] for one slot
only (a test's lowered thresholds; a member's host has none), over desk_egress's defaults. A bad value is the one under it.
"""
import configparser
import importlib.util
import json
import math
import os
import re
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True   # nothing written beside the host's own code
LIB = os.path.dirname(os.path.abspath(__file__))
RUN = "/run/desk-host"
STATE_DIR = "/var/lib/desk-host/egress"
CONF = "/etc/desk-host/egress.conf"
OFF = f"{RUN}/shaper-off"
DEV = "eth0"                       # the desk's end of its veth, in its network namespace (desk-host up names it so)
TC = "/usr/sbin/tc"
NFT = "/usr/sbin/nft"
NSENTER = "/usr/bin/nsenter"
SYSTEMCTL = "/usr/bin/systemctl"
MINORS = ("10", "15", "20")
RATE_KEYS = ("stream_mbps", "root_mbps", "other_mbps", "slowed_root_mbps", "slowed_other_mbps", "clamped_stream_mbps")
DESK = re.compile(r"\Ad-[a-z0-9]{6,40}\Z")
STALE_S = 35 * 86400               # a state no desk has used for 35 days: past its month and every window
EX_NOT_MINE = 75                   # the slot holds another desk now: the unit doesn't restart (RestartPreventExitStatus)
GB = 10**9
DE = None                          # desk_egress, loaded on first use (a test sets it)


def de():
    global DE
    if DE is None:
        spec = importlib.util.spec_from_file_location("desk_egress", os.path.join(LIB, "desk_egress.py"))
        DE = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(DE)
    return DE


def log(msg, level=6):
    print(f"<{level}>desk-host-egress: {msg}", file=sys.stderr, flush=True)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_text(path):
    try:
        with open(path, encoding="ascii") as f:
            return f.read().strip()
    except (OSError, ValueError):
        return None


def ns_file(k):
    return f"{RUN}/ns/{k}/net"


def ns_run(k, run=None):
    """subprocess.run in slot k's network namespace only (its host-owned bind; WALL-02: no other namespace of the desk)."""
    def r(argv, **kw):
        return (run or subprocess.run)([NSENTER, f"--net={ns_file(k)}", *argv], **kw)
    return r


def egress_multiple(k):
    """The slot's class's `egress` (classes.conf; class.json's units), a multiple of a desk's rates. 1 when it can't be read."""
    try:
        v = float(((read_json(f"{RUN}/{k}/class.json") or {}).get("units") or {}).get("egress", "1"))
        return v if 0.01 <= v <= 4 else 1.0
    except (TypeError, ValueError):
        return 1.0


def conf_for(k, mult=1.0, path=None):
    """desk_egress's settings for slot k: its defaults, then [egress], then [slot<k>]; every rate times the class's multiple."""
    path = path or CONF
    cfg, p = dict(de().DEFAULTS), configparser.ConfigParser()
    try:
        p.read(path)
    except (configparser.Error, OSError) as e:
        log(f"{path}: {e}; using the defaults", 4)
        p = configparser.ConfigParser()
    for sec in ("egress", f"slot{k}"):
        if not p.has_section(sec):
            continue
        for key, value in p.items(sec):
            if key not in cfg or key == "interface":
                continue
            try:
                v = float(value)
                if not math.isfinite(v) or v < 0 or (key in RATE_KEYS and v <= 0) or (key == "tick_seconds" and v < 1):
                    raise ValueError(f"{value!r} is out of range")
                cfg[key] = v
            except ValueError as e:
                log(f"{path} [{sec}] {key}: {e}; keeping {cfg[key]}", 4)
    cfg["interface"] = DEV
    for key in RATE_KEYS:
        cfg[key] = round(cfg[key] * mult, 6)
    cfg["egress_multiple"], cfg["slot_override"] = mult, p.has_section(f"slot{k}")
    return cfg


def slot_desk(k):
    """(deskId, start) of the desk desk-host started on slot k: start is this host boot's and that start's own (net.json's boot,
    new at every desk-host up), so a desk's counters from an earlier start are never taken for this one's."""
    s = read_json(f"{RUN}/{k}/slot.json") or {}
    desk = s.get("deskId")
    if not isinstance(desk, str) or not DESK.match(desk):
        raise SystemExit(f"slot {k}: no desk in {RUN}/{k}/slot.json")
    boot = read_text("/proc/sys/kernel/random/boot_id") or "-"
    start = (read_json(f"{RUN}/{k}/net.json") or {}).get("boot") or "-"
    return desk, f"{boot}/{start}"


def state_path(desk):
    return f"{STATE_DIR}/{desk}.json"


def load_state(desk):
    try:
        with open(state_path(desk), encoding="ascii") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log(f"{desk}: bad state, starting over: {e}", 4)
        return None


def prune(keep, now=None):
    """States no desk has used for 35 days: a host that has held many desks keeps only what can still matter."""
    now = time.time() if now is None else now
    try:
        names = os.listdir(STATE_DIR)
    except OSError:
        return 0
    n = 0
    for name in names:
        p = f"{STATE_DIR}/{name}"
        if name.endswith(".json") and name != f"{keep}.json":
            try:
                if now - os.lstat(p).st_mtime > STALE_S:
                    os.unlink(p)
                    n += 1
            except OSError:
                pass
    return n


def profile_path(k):
    return f"{RUN}/{k}/egress/profile"


def write_profile(k, profile):
    """The stream's profile in the host's directory for the slot (read-only in the desk), 0644 so desk-stream can read it. True if
    it changed. Never a write into anything the desk controls (WALL-03): /run/desk-host/<k> is the host's."""
    path = profile_path(k)
    if read_text(path) == profile:
        return False
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "w", encoding="ascii") as f:
        f.write(profile + "\n")
        f.flush()
        os.fchmod(f.fileno(), 0o644)
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return True


def setup(k, now=None):
    """The slot's desk, its settings, its saved budget and a shaper that runs tc in the slot's network namespace."""
    desk, start = slot_desk(k)
    mult = egress_multiple(k)
    cfg = conf_for(k, mult)
    budget = de().Budget(cfg, time.time() if now is None else now, load_state(desk), start)
    return desk, start, mult, cfg, budget, de().Shaper(cfg, run=ns_run(k))


def cmd_on(k):
    desk, _, mult, cfg, budget, shaper = setup(k)
    shaper.apply(budget.rates())
    write_profile(k, budget.profile)
    r = budget.rates()
    log(f"slot {k} ({desk}): classes on {DEV} at 1:10 {r['10']:g}, 1:15 {r['15']:g}, 1:20 {r['20']:g} Mbit (x{mult:g} a desk's"
        f"{'; [slot%d] in %s' % (k, CONF) if cfg['slot_override'] else ''}), profile {budget.profile}")
    return 0


def cmd_unclamp(k):
    if not os.path.exists(ns_file(k)):
        return 0
    try:
        de().Shaper(conf_for(k, egress_multiple(k)), run=ns_run(k)).unclamp()
    except OSError:   # no shaper there (desk-host shaper <k> off, or never on): nothing to lift
        pass
    return 0


def cmd_off(k):
    r = ns_run(k)([TC, "qdisc", "del", "dev", DEV, "root"], capture_output=True, text=True, timeout=10, check=False)
    if r.returncode and "No such file" not in r.stderr and "Cannot find" not in r.stderr and "noqueue" not in r.stderr:
        log(f"slot {k}: tc qdisc del: {r.stderr.strip()[:200]}", 3)
        return 1
    log(f"slot {k}: classes taken off {DEV}", 4)
    return 0


def tick(budget, shaper, k, failures, now):
    """desk_egress's guarded_tick for a slot: the profile goes to the host's file, never to a systemctl of the host's."""
    try:
        de().step(budget, shaper, now)
        if write_profile(k, budget.profile):
            log(f"slot {k}: stream profile {budget.profile}", 5)
        return 0
    except Exception as e:  # pylint: disable=broad-except
        failures += 1
        log(f"slot {k}: tick failed ({failures}): {e!r}", 3)
        if failures == de().FAIL_OPEN_TICKS:
            log(f"slot {k}: lifting any clamp until a tick works again", 3)
            try:
                shaper.unclamp()
            except Exception as e2:  # pylint: disable=broad-except
                log(f"slot {k}: couldn't: {e2!r}", 3)
        return failures


def begin(k, now=None):
    """The daemon's start: the classes at the saved budget's rates, the counters taken as they are (a new start's are this qdisc's,
    from about 0), then one tick at once, so the time the desk was stopped refills the bucket now rather than a tick later and the
    saved state is this start's from the first second (desk-host-check shaper reads its age), then the save."""
    desk, start, mult, cfg, budget, shaper = setup(k, now)
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    gone = prune(desk)
    failures = 0
    try:
        shaper.apply(budget.rates())
        de().baseline(budget, shaper)
    except Exception as e:  # pylint: disable=broad-except
        log(f"slot {k}: no shaper yet, trying again every tick: {e!r}", 3)
    failures = tick(budget, shaper, k, failures, time.time() if now is None else now)
    if not failures:
        log(f"slot {k} ({desk}): shaper on, budgets every {cfg['tick_seconds']:g} s; bucket {budget.level / GB:.2f} GB, month "
            f"{budget.month_bytes / GB:.2f} GB, profile {budget.profile}, slowed {budget.slowed}, clamped {budget.clamped}; rates x{mult:g}"
            + (f"; [slot{k}] in {CONF}" if cfg["slot_override"] else "") + (f"; {gone} old state(s) pruned" if gone else ""))
    de().save(budget, start, state_path(desk))
    return desk, start, mult, cfg, budget, shaper, failures


def cmd_run(k):
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    desk, start, mult, cfg, budget, shaper, failures = begin(k)
    try:
        while True:
            time.sleep(cfg["tick_seconds"])
            now_desk = (read_json(f"{RUN}/{k}/slot.json") or {}).get("deskId")
            if now_desk != desk:   # desk-host stops this unit at every reset; this is the belt to that
                log(f"slot {k}: holds {now_desk or 'no desk'} now, not {desk}: stopping", 4)
                os._exit(EX_NOT_MINE)
            m = egress_multiple(k)
            if m != mult:   # desk-host class changed the slot's class in place
                mult, cfg = m, conf_for(k, m)
                budget.c = shaper.cfg = cfg
                log(f"slot {k}: the class's egress is x{m:g} a desk's now", 5)
            failures = tick(budget, shaper, k, failures, time.time())
            de().save(budget, start, state_path(desk))
    finally:
        try:   # a stop keeps the last minute's bytes too
            de().step(budget, shaper, time.time())
        except Exception as e:  # pylint: disable=broad-except
            log(f"slot {k}: last tick failed: {e!r}", 4)
        de().save(budget, start, state_path(desk))


def classes_of(k, run=None):
    """Our HTB classes on slot k's veth as tc reports them, by minor. Empty if the shaper's gone."""
    r = ns_run(k, run)([TC, "-j", "-s", "class", "show", "dev", DEV], capture_output=True, text=True, timeout=10, check=False)
    if r.returncode:
        raise OSError(f"tc class show: {r.stderr.strip()[:160]}")
    out = json.loads(r.stdout or "[]")
    return {c["handle"].split(":")[1]: c for c in out if c.get("class") == "htb" and str(c.get("handle", "")).startswith("1:")}


def budget_view(desk, now=None):
    """What the slot's state says, for the report: slowed, clamped, profile, the bucket, the last 24 h and this month."""
    st = read_json(state_path(desk)) if desk and DESK.match(desk) else None
    if not isinstance(st, dict):
        return {}
    now = time.time() if now is None else now
    try:
        day = sum(int(n) for t, n in st.get("windows", []) if now - 86400 < float(t) <= now)
        return {"slowed": bool(st.get("slowed")), "clamped": bool(st.get("clamped")), "profile": str(st.get("profile", "normal")),
                "bucketGb": round(float(st.get("level", 0)) / GB, 3), "dayGb": round(day / GB, 3),
                "monthGb": round(int(st.get("month_bytes", 0)) / GB, 3), "savedAgoS": round(now - float(st.get("updated", 0)))}
    except (TypeError, ValueError):
        return {"error": "bad state"}


def show(k, desk=None, run=None, now=None):
    """Slot k's shaper as the host's report carries it (report.py; test 1's judge reads classes_mbps from these counters between
    two reports): each class's rate and counters, whether it's on, and its budget."""
    out = {"on": False, "classes": {}}
    if os.path.exists(f"{OFF}/{k}"):
        out["off"] = True
    try:
        cl = classes_of(k, run)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        out["error"] = str(e)[:160]
        cl = {}
    for m in MINORS:
        c = cl.get(m)
        if c:
            s = c.get("stats") or {}
            out["classes"][m] = {"rateBits": int(c.get("rate", 0)) * 8, "bytes": int(s.get("bytes", 0)), "packets": int(s.get("packets", 0)),
                                 "drops": int(s.get("drops", 0)), "overlimits": int(s.get("overlimits", 0))}
    out["on"] = all(m in out["classes"] for m in MINORS)
    if desk is None:
        desk = (read_json(f"{RUN}/{k}/slot.json") or {}).get("deskId")
    out.update(budget_view(desk, now))
    return out


def problems(k, slot_mode, run=None, now=None):
    """desk-host-check's `shaper` for running slot k: what's wrong, or nothing. Its classes on its veth (an HTB 1: with 1:10, 1:15
    and 1:20 and their leaves, each rate equal to its ceiling and never above its class's normal rate), the classify chain in its
    namespace (and the slot's UDP port's rule under SlotMode=port), desk-host-egress@<k> active and its state for this desk and
    this start saved within three ticks. A slot desk-host shaper <k> off took the shaper off fails."""
    now = time.time() if now is None else now
    p = []
    if os.path.exists(f"{OFF}/{k}"):
        p.append(f"slot {k}: shaper off (desk-host shaper {k} off, {read_text(f'{OFF}/{k}')})")
    nr = ns_run(k, run)
    q = nr([TC, "-j", "qdisc", "show", "dev", DEV], capture_output=True, text=True, timeout=10, check=False)
    if q.returncode:
        return p + [f"slot {k}: no {DEV} in its network namespace ({q.stderr.strip()[:80]})"]
    qd = json.loads(q.stdout or "[]")
    if not any(x.get("kind") == "htb" and x.get("handle") == "1:" and x.get("root") for x in qd):
        p.append(f"slot {k}: no HTB 1: on its veth (root {[x.get('kind') for x in qd if x.get('root')]})")
    leaves = {x.get("parent"): x.get("kind") for x in qd if not x.get("root")}
    for m, (_, leaf) in de().CLASSES.items():
        if leaves.get(f"1:{m}") != leaf.split()[0]:
            p.append(f"slot {k}: 1:{m}'s leaf is {leaves.get(f'1:{m}')}, not {leaf.split()[0]}")
    try:
        cl = classes_of(k, run)
    except (OSError, ValueError) as e:
        cl = {}
        p.append(f"slot {k}: {e}")
    cfg = conf_for(k, egress_multiple(k))
    top = de().normal_rates(cfg)
    for m in MINORS:
        c = cl.get(m)
        if not c:
            p.append(f"slot {k}: no class 1:{m}")
        elif c.get("rate") != c.get("ceil"):
            p.append(f"slot {k}: 1:{m} rate {c.get('rate')} isn't its ceiling {c.get('ceil')} (it would borrow)")
        elif int(c.get("rate", 0)) * 8 > top[m] * 1e6 * 1.001 + 8:
            p.append(f"slot {k}: 1:{m} at {int(c.get('rate', 0)) * 8 / 1e6:g} Mbit, above its class's {top[m]:g}")
    ch = nr([NFT, "list", "chain", "inet", "ma", "classify"], capture_output=True, text=True, timeout=10, check=False).stdout
    want = ["udp sport 443 meta priority set 1:10", "tcp sport 443 meta priority set 1:10", "meta priority set 1:15"]
    if slot_mode == "port":
        want.append(f"udp sport {4430 + k} meta priority set 1:10")
    for w in want:
        if w not in ch:
            p.append(f"slot {k}: its classify chain has no '{w}'")
    act = (run or subprocess.run)([SYSTEMCTL, "is-active", f"desk-host-egress@{k}.service"], capture_output=True, text=True, timeout=10, check=False).stdout.strip()
    if act != "active":
        p.append(f"slot {k}: desk-host-egress@{k} is {act or 'unknown'}")
    try:
        desk, start = slot_desk(k)
    except SystemExit as e:
        return p + [str(e)]
    st = read_json(state_path(desk))
    if not isinstance(st, dict):
        p.append(f"slot {k}: no desk-egress state for {desk}")
    else:
        age = now - float(st.get("updated", 0) or 0)
        if age > 3 * cfg["tick_seconds"] + 30:
            p.append(f"slot {k}: {desk}'s state last saved {age:.0f} s ago (tick {cfg['tick_seconds']:g} s)")
        if st.get("boot") != start:
            p.append(f"slot {k}: {desk}'s state is from another start")
    return p


def main(argv):
    if len(argv) != 3 or argv[1] not in ("on", "run", "unclamp", "off", "show") or not re.fullmatch(r"[1-9][0-9]?", argv[2]):
        print(__doc__.split("\n\n")[-2], file=sys.stderr)
        return 2
    k = int(argv[2])
    if argv[1] == "show":
        print(json.dumps(show(k), separators=(",", ":")))
        return 0
    return {"on": cmd_on, "run": cmd_run, "unclamp": cmd_unclamp, "off": cmd_off}[argv[1]](k) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
