"""smoke.py: a switched component's smoke test from the host's side (ADR 0078 section 3.2). Host root; desk-host-batch smoke runs it.

A release's own `health` can't run here: the host never runs release code outside the wall and never enters a desk (WALL-02). So
the host watches, for up to 90 s per component (180 s on a `free` slot, whose CPU is cpu.idle), what it can read from its own side:
- every component: its sandbox `running` (runc state), and its service, desk-svc's child, keeping the same PID for 20 s, found
  from the host's own /proc (desk-svc restarts a service that exits, so a crashing release shows up as a new PID);
- deskd: also a fresh idle.json in the slot's /run share, owned by the slot's uid 1100 and written after the switch began;
- desk-rtc: its UDP port and its TCP listener in the slot's network namespace, read from the host's /proc/<pid>/net/ (the
  kernel's tables, owned by the slot's rtc uid; nothing is entered);
- desk-stream: its desk-svc running and waiting, its PID the same for 20 s. Stopped is healthy, as its own `health` says.
Every reader takes a proc root and a runc function, so the unit tests run it on fake /proc trees.
"""
import json
import os
import subprocess
import time

STABLE_S = 20


def rd(path):
    with open(path) as f:
        return f.read()


def runc_state(name):
    try:
        r = subprocess.run(["runc", "state", name], capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            return None, None
        j = json.loads(r.stdout)
        return j.get("status"), j.get("pid")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None, None


def ppid_of(pid, proc="/proc"):
    try:
        s = rd(f"{proc}/{pid}/stat")
        return int(s[s.rindex(")") + 2:].split()[1])
    except (OSError, ValueError, IndexError):
        return None


def children(pid, proc="/proc"):
    out = []
    for p in os.listdir(proc):
        if p.isdigit() and ppid_of(p, proc) == pid:
            out.append(int(p))
    return sorted(out)


def alive(pid, proc="/proc"):
    try:
        s = rd(f"{proc}/{pid}/stat")
        return s[s.rindex(")") + 2:].split()[0] not in ("Z", "X")
    except (OSError, ValueError, IndexError):
        return False


def sockets(pid, uid, proc="/proc"):
    """{("udp", port)} and {("tcp", port)} for listeners, owned by host uid, in the network namespace pid's /proc/<pid>/net shows."""
    out = set()
    for proto, f in (("tcp", "tcp"), ("tcp", "tcp6"), ("udp", "udp"), ("udp", "udp6")):
        try:
            lines = rd(f"{proc}/{pid}/net/{f}").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            x = line.split()
            if len(x) < 8:
                continue
            try:
                port = int(x[1].rsplit(":", 1)[1], 16)
                owner = int(x[7])
            except (ValueError, IndexError):
                continue
            if owner != uid:
                continue
            if proto == "tcp" and x[3] != "0A":   # LISTEN
                continue
            out.add((proto, port))
    return out


def idle_fresh(path, since, owner):
    """deskd's idle.json written by the slot's 1100 (its host uid) after `since` (the switch's start)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False, "no idle.json"
    if st.st_uid != owner:
        return False, f"idle.json is uid {st.st_uid}'s, not deskd's"
    if st.st_mtime < since:
        return False, "idle.json is from before the switch"
    return True, "a fresh idle.json"


def probe(k, svc, since, base, proc="/proc", runc=runc_state, share="/run/desk-host/share", rtc_ports=(443, 443)):
    """(ok, why, the PID that must stay the same) for one look."""
    status, pid = runc(f"dh-svc-{k}-{svc}")
    if status != "running" or not pid:
        return False, f"its sandbox is {status or 'gone'}", None
    if svc == "desk-stream":   # on demand: desk-svc waiting is healthy; its service, if one runs, isn't required
        return (True, "desk-svc running", pid) if alive(pid, proc) else (False, "desk-svc isn't running", None)
    kids = [c for c in children(pid, proc) if alive(c, proc)]
    if not kids:
        return False, "desk-svc has no service running", None
    child = kids[0]
    if svc == "deskd":
        ok, why = idle_fresh(f"{share}/{k}/desk/idle.json", since, base + 1100)
        if not ok:
            return False, why, None
    if svc == "desk-rtc":
        have = sockets(child, base + 1101, proc)
        udp, tcp = rtc_ports
        missing = [f"{p}/{n}" for p, n in (("udp", udp), ("tcp", tcp)) if (p, n) not in have]
        if missing:
            return False, f"no listener on {', '.join(missing)}", None
    return True, f"service pid {child}", child


def check(k, svc, since, timeout, base=None, proc="/proc", runc=runc_state, share="/run/desk-host/share", rtc_ports=(443, 443),
          now=time.monotonic, sleep=time.sleep, stable=STABLE_S):
    """(passed, why): the probe passes and its PID stays the same for `stable` s, within `timeout` s."""
    base = 100000 + k * 65536 if base is None else base
    end = now() + timeout
    held, since_pid, why = None, None, "not looked at"
    last = now()
    while True:
        ok, why, pid = probe(k, svc, since, base, proc, runc, share, rtc_ports)
        t = now()
        if t - last > 5:   # this process was frozen (desk-host-upd during a pre-read): that time isn't the release's
            end += t - last - 1
            if held is not None:
                since_pid += t - last - 1
        last = t
        if ok:
            if pid != held:
                held, since_pid = pid, t
            elif t - since_pid >= stable:
                return True, f"{why}, the same for {stable} s"
        else:
            if held is not None:
                why = f"{why} (it had been pid {held})"
            held = None
        if t >= end:
            return False, why
        sleep(1)


def rtc_ports(k, run="/run/desk-host"):
    """desk-rtc's (udp, tcp) ports: SlotMode=port's port= and tcp_port= from the host's desk-rtc.conf for the slot, else 443 each."""
    udp = tcp = 443
    try:
        for line in rd(f"{run}/{k}/desk-rtc.conf").splitlines():
            key, _, v = line.strip().partition("=")
            if key == "port" and v.isdigit():
                udp = int(v)
            elif key == "tcp_port" and v.isdigit():
                tcp = int(v)
    except OSError:
        pass
    return udp, tcp


def window(k, run="/run/desk-host"):
    """90 s, or 180 s on a free slot (cpu.idle)."""
    try:
        if json.loads(rd(f"{run}/{k}/class.json")).get("class") == "free":
            return 180
    except (OSError, ValueError):
        pass
    return 90
