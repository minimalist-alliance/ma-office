#!/usr/bin/python3 -I
"""Traffic for ADR 0036's lab boxes. No dependencies beyond Python 3. Every command prints one JSON line, and none prints an address.

  net.py udp-send HOST PORT MBPS SECS [--size 1200] [--sport N] [--echo-every N] [--prio N] [--tos N]
  net.py udp-sink PORT SECS                 counts by source port; echoes packets that ask for it
  net.py tcp-sink PORT [--mss N] [--pace-mbps N]   'U' uploads are discarded, 'D<secs>' downloads are sent as fast as allowed
  net.py tcp-up HOST PORT SECS [--mss N]    an upload, as fast as the shaper lets it
  net.py tcp-down HOST PORT SECS [--mss N]  a download; its ACKs are this box's outbound
  net.py burst HOST PORT N [--size 1200] [--sport N]   N packets at once, then a count from the sink
  net.py dns SERVER N                        N DNS queries one after another, round-trip times
  net.py refusals                            what this uid may set: SO_PRIORITY (setsockopt and cmsg), IP_TOS, SO_MARK, port 443
  net.py tc DEV                              the HTB classes' counters, by handle
  net.py cpu                                 /proc/stat's first line
"""
import json
import os
import select
import socket
import struct
import subprocess
import sys
import time

HDR = struct.Struct(">QdB")  # seq, send time (monotonic), 1 if the sink should echo it


def out(obj):
    print(json.dumps(obj, separators=(", ", ": ")), flush=True)


def opt(args, name, default, kind=lambda v: int(v, 0)):
    if name in args:
        i = args.index(name)
        v = kind(args[i + 1])
        del args[i:i + 2]
        return v
    return default


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p / 100 * len(xs)))] * 1000, 3)


def udp_send(args):
    size, sport, every = opt(args, "--size", 1200), opt(args, "--sport", 0), opt(args, "--echo-every", 0)
    prio, tos = opt(args, "--prio", None), opt(args, "--tos", None)
    host, port, mbps, secs = args[0], int(args[1]), float(args[2]), float(args[3])
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if prio is not None:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_PRIORITY, prio)
    if tos is not None:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, tos)
    if sport:
        s.bind(("0.0.0.0", sport))
    s.connect((host, port))
    s.setblocking(False)
    pps = mbps * 1e6 / 8 / size
    pad = b"\0" * (size - HDR.size)
    t0 = time.monotonic()
    sent = blocked = 0
    rtts = []
    while True:
        now = time.monotonic()
        if now - t0 >= secs:
            break
        want = int((now - t0) * pps) + 1
        while sent < want:
            echo = 1 if every and sent % every == 0 else 0
            try:
                s.send(HDR.pack(sent, time.monotonic(), echo) + pad)
                sent += 1
            except BlockingIOError:
                blocked += 1
                break
            except OSError:  # ENOBUFS: the qdisc dropped it
                blocked += 1
                sent += 1
        while True:
            try:
                d = s.recv(64)
            except (BlockingIOError, ConnectionRefusedError):
                break
            if len(d) >= HDR.size:
                rtts.append(time.monotonic() - HDR.unpack_from(d)[1])
        select.select([s], [], [], 0.0005)
    el = time.monotonic() - t0
    end = time.monotonic() + 0.5
    while time.monotonic() < end:
        r, _, _ = select.select([s], [], [], 0.05)
        if r:
            try:
                d = s.recv(64)
                rtts.append(time.monotonic() - HDR.unpack_from(d)[1])
            except OSError:
                pass
    out({"sent": sent, "sentMbps": round(sent * size * 8 / 1e6 / el, 2), "blocked": blocked, "sport": s.getsockname()[1],
         "echoSent": (sent + every - 1) // every if every else 0, "echoBack": len(rtts),
         "rttMs": {"p50": pct(rtts, 50), "p95": pct(rtts, 95), "p99": pct(rtts, 99), "max": pct(rtts, 100)}})


def udp_sink(args):
    port, secs = int(args[0]), float(args[1])
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    s.bind(("0.0.0.0", port))
    by = {}
    end = time.monotonic() + secs
    while time.monotonic() < end:
        r, _, _ = select.select([s], [], [], 0.2)
        if not r:
            continue
        d, a = s.recvfrom(65536)
        now = time.monotonic()
        k = by.setdefault(a[1], {"pkts": 0, "bytes": 0, "first": now, "last": now, "maxSeq": -1})
        k["pkts"] += 1
        k["bytes"] += len(d)
        k["last"] = now
        if len(d) >= HDR.size:
            seq, _, echo = HDR.unpack_from(d)
            k["maxSeq"] = max(k["maxSeq"], seq)
            if echo:
                s.sendto(d[:HDR.size], a)
    res = {}
    for p, k in by.items():
        spread = k["last"] - k["first"]
        res[f"from port {p}"] = {"pkts": k["pkts"], "of": k["maxSeq"] + 1, "spreadMs": round(spread * 1000, 1),
                                 "mbps": round(k["bytes"] * 8 / 1e6 / spread, 2) if spread > 0 else None}
    out(res)


def tcp_opts(s, mss):
    if mss:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG, mss)


def tcp_sink(args):
    mss, pace = opt(args, "--mss", 0), opt(args, "--pace-mbps", 0.0, float)
    port = int(args[0])
    ln = socket.socket()
    ln.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp_opts(ln, mss)
    ln.bind(("0.0.0.0", port))
    ln.listen(16)
    chunk = b"\0" * (1 << 16)
    while True:
        c, _ = ln.accept()
        if os.fork():
            c.close()
            continue
        ln.close()
        if pace:
            c.setsockopt(socket.SOL_SOCKET, 47, int(pace * 1e6 / 8))  # SO_MAX_PACING_RATE
        mode = c.recv(16)
        try:
            if mode[:1] == b"D":
                end = time.monotonic() + float(mode[1:].decode())
                while time.monotonic() < end:
                    c.sendall(chunk)
                c.shutdown(socket.SHUT_WR)
            while c.recv(1 << 20):
                pass
        except OSError:
            pass
        os._exit(0)


def tcp_up(args):
    mss = opt(args, "--mss", 0)
    host, port, secs = args[0], int(args[1]), float(args[2])
    s = socket.socket()
    tcp_opts(s, mss)
    s.connect((host, port))
    s.sendall(b"U".ljust(16))
    chunk, n, t0 = b"\0" * (1 << 16), 0, time.monotonic()
    while time.monotonic() - t0 < secs:
        n += s.send(chunk)
    el = time.monotonic() - t0
    s.close()
    out({"bytes": n, "secs": round(el, 1), "mbps": round(n * 8 / 1e6 / el, 2)})


def tcp_down(args):
    mss = opt(args, "--mss", 0)
    host, port, secs = args[0], int(args[1]), float(args[2])
    s = socket.socket()
    tcp_opts(s, mss)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    t0 = time.monotonic()
    s.connect((host, port))
    s.sendall(f"D{secs}".encode().ljust(16))
    n, first = 0, None
    while True:
        d = s.recv(1 << 20)
        if not d:
            break
        if first is None:
            first = time.monotonic()
        n += len(d)
    el = time.monotonic() - (first or t0)
    out({"bytes": n, "secs": round(el, 1), "mbps": round(n * 8 / 1e6 / el, 2) if el else None, "connectMs": round(((first or t0) - t0) * 1000, 1)})


def burst(args):
    size, sport = opt(args, "--size", 1200), opt(args, "--sport", 0)
    host, port, n = args[0], int(args[1]), int(args[2])
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
    if sport:
        s.bind(("0.0.0.0", sport))
    pad = b"\0" * (size - HDR.size)
    t0 = time.monotonic()
    for i in range(n):
        s.sendto(HDR.pack(i, t0, 0) + pad, (host, port))
    out({"packets": n, "sendMs": round((time.monotonic() - t0) * 1000, 2), "sport": s.getsockname()[1]})


def dns(args):
    server, n = args[0], int(args[1])
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    rtts, lost = [], 0
    for i in range(n):
        q = struct.pack(">HHHHHH", i, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(p)]) + p.encode() for p in f"lab{i}.example.com".split(".")) + b"\0" + struct.pack(">HH", 1, 1)
        t0 = time.monotonic()
        s.sendto(q, (server, 53))
        try:
            while struct.unpack(">H", s.recv(512)[:2])[0] != i:
                pass
            rtts.append(time.monotonic() - t0)
        except socket.timeout:
            lost += 1
        time.sleep(0.05)
    out({"n": n, "lost": lost, "p50": pct(rtts, 50), "p95": pct(rtts, 95), "max": pct(rtts, 100)})


def refusals(_args):
    r = {}
    for p in (6, 7, 0x10000, 0x10010, 0x10015, 0x10020):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_PRIORITY, p)
            r[f"SO_PRIORITY {p:#x}"] = "ALLOWED"
        except PermissionError:
            r[f"SO_PRIORITY {p:#x}"] = "refused"
    # The same value as ancillary data on one send (Linux 6.12 added SO_PRIORITY as a cmsg).
    for p in (6, 0x10010):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SO_PRIORITY, struct.pack("i", p))], 0, ("127.0.0.1", 9))
            r[f"cmsg SO_PRIORITY {p:#x}"] = "ALLOWED"
        except PermissionError:
            r[f"cmsg SO_PRIORITY {p:#x}"] = "refused"
        except OSError as e:
            r[f"cmsg SO_PRIORITY {p:#x}"] = f"error {e.errno}"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_TOS, 0x10)
    r["IP_TOS 0x10 gives SO_PRIORITY"] = s.getsockopt(socket.SOL_SOCKET, socket.SO_PRIORITY)
    try:
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM).setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 1)
        r["SO_MARK"] = "ALLOWED"
    except PermissionError:
        r["SO_MARK"] = "refused"
    for name, kind in (("udp", socket.SOCK_DGRAM), ("tcp", socket.SOCK_STREAM)):
        try:
            socket.socket(socket.AF_INET, kind).bind(("0.0.0.0", 443))
            r[f"bind {name} 443"] = "ALLOWED"
        except PermissionError:
            r[f"bind {name} 443"] = "refused"
        except OSError as e:
            r[f"bind {name} 443"] = f"error {e.errno} (in use)"
    out(r)


def tc(args):
    j = json.loads(subprocess.run(["tc", "-j", "-s", "class", "show", "dev", args[0]], capture_output=True, text=True, check=True).stdout or "[]")
    out({c["handle"]: {"bytes": c["stats"]["bytes"], "packets": c["stats"]["packets"], "drops": c["stats"]["drops"],
                       "overlimits": c["stats"]["overlimits"], "rate": c["rate"] * 8} for c in j if c.get("class") == "htb"})


def cpu(_args):
    with open("/proc/stat", encoding="ascii") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    out(dict(zip(("user", "nice", "sys", "idle", "iowait", "irq", "softirq", "steal"), v)))


def serve(args):
    """The sink box's side, as root, reachable only from the lab's subnet. One request a connection, one JSON line each way:
    {"start": [net.py args]} -> {"job": n}; {"result": n} -> that job's output; {"netem": [delay_ms, rate_mbit]} or {"netem": null}.
    It runs only net.py's own commands and tc's netem on its own interface, with no shell."""
    ln = socket.socket()
    ln.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ln.bind(("0.0.0.0", int(args[0])))
    ln.listen(8)
    jobs = {}
    me = os.path.abspath(__file__)
    while True:
        c, _ = ln.accept()
        try:
            req = json.loads(c.makefile().readline())
            if "start" in req:
                a = [str(x) for x in req["start"]]
                if a[0] not in ("udp-sink", "tcp-sink", "udp-send", "tcp-up", "tcp-down", "burst", "tc", "cpu"):
                    raise ValueError("not allowed")
                n = len(jobs) + 1
                jobs[n] = subprocess.Popen([sys.executable, "-I", me, *a], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                rep = {"job": n}
            elif "result" in req:
                rep = {"out": jobs.pop(int(req["result"])).communicate(timeout=600)[0]}
            elif "netem" in req:
                subprocess.run(["tc", "qdisc", "del", "dev", "ens5", "root"], capture_output=True, check=False)
                if req["netem"]:
                    d, r = float(req["netem"][0]), float(req["netem"][1])
                    cmd = ["tc", "qdisc", "add", "dev", "ens5", "root", "netem", "delay", f"{d}ms", "limit", "100000"]
                    subprocess.run(cmd + (["rate", f"{r}mbit"] if r else []), capture_output=True, check=True)
                rep = {"qdisc": subprocess.run(["tc", "qdisc", "show", "dev", "ens5", "root"], capture_output=True, text=True).stdout.strip()[:120]}
            else:
                raise ValueError("unknown")
        except Exception as e:  # pylint: disable=broad-except
            rep = {"error": repr(e)}
        try:
            c.sendall((json.dumps(rep) + "\n").encode())
        except OSError:
            pass
        c.close()


def ask(args):
    """net.py ask HOST PORT JSON: one request to the other box's serve."""
    s = socket.create_connection((args[0], int(args[1])), 10)
    s.settimeout(700)
    s.sendall((args[2] + "\n").encode())
    rep = json.loads(s.makefile().readline())
    print(rep["out"].rstrip() if "out" in rep else json.dumps(rep), flush=True)


def main(argv):
    cmds = {"udp-send": udp_send, "udp-sink": udp_sink, "tcp-sink": tcp_sink, "tcp-up": tcp_up, "tcp-down": tcp_down, "burst": burst,
            "dns": dns, "refusals": refusals, "tc": tc, "cpu": cpu, "serve": serve, "ask": ask}
    if len(argv) < 2 or argv[1] not in cmds:
        print(__doc__, file=sys.stderr)
        return 2
    cmds[argv[1]](argv[2:])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
