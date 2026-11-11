#!/usr/bin/python3 -I
"""set_class_lab.py: verify-port.sh's set_class step (S-119) on a lab host, slot 1. TEST ONLY, never on an image. Host root,
from /run/ma-verify-s119/ (world-readable, so its own unprivileged runs can read it).

  browser <marker>                  the cookie page in slot 1's network namespace (a host process, as nobody), the Browser started
                                    as deskd starts it (desk-init's units.sock, as deskd's uid), and a cookie s119=<marker> set
                                    by the page through Chromium's CDP (HTTP only: /json/new, /json/list), read back
  snap <file>                       what must survive a class change: every process in desk-1's cgroups (pid and start time;
                                    Chromium's own children may come and go), deskd's JVM, the desk's and deskd's containers,
                                    Chromium's browser process, and desk-1's OOM kill count
  check <class> <snap> <marker> <since> [<wait s>]
                                    the report says <class> (≤ wait), desk-1's cgroup holds exactly <class>'s values (a lower
                                    memory.max may wait: "+pending"), class-applied passes, every process of <snap> but
                                    Chromium's own children is still there (deskd's JVM and Chromium's browser process the same),
                                    no OOM kill in desk-1, the cookie comes back, the link logged the change
  same <class>                      the report and desk-1's cgroup say <class> (nothing else checked)
  refused <code> <class> <since> [<wait s>]
                                    the link logged "refused: <code>" since <since> and the slot is still <class>, whole
  fake <class|-> [<extraOrders json> | bad]   the fake Platform's record for slot 1 (its class) and extraOrders ("bad": an
                                    unknown class, and slot 1 ordered for slot 2's desk)
  down                              the cookie page's unit stopped (it holds the slot's network namespace)
  serve <port> | units <verb> <unit> | cdp <GET|PUT> <path>   its own parts, run as above
"""
import http.client
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
K = 1
DESKD = 100000 + 65536 * K + 1100        # deskd's uid (and the desk group's gid) in slot 1, as the host sees it
NS = f"/run/desk-host/ns/{K}/net"
CG = f"/sys/fs/cgroup/desk-host/desk-{K}"
L = "/usr/local/lib/desk-host"
ME = os.path.abspath(__file__)
PORT = 18119
REQS = "/root/fake/requests.jsonl"
STATE = "/root/fake/state.json"
PAGE = 4096


def run(*a, timeout=120):
    return subprocess.run(a, capture_output=True, text=True, timeout=timeout)


def as_deskd(*args, net=False):
    pre = ["nsenter", f"--net={NS}"] if net else []
    return run(*pre, "setpriv", f"--reuid={DESKD}", f"--regid={DESKD}", "--clear-groups", "python3", "-I", ME, *args)


# ---------- the parts that run as others ----------

def serve(port):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            hdrs = [("Content-Type", "text/html"), ("Cache-Control", "no-store")]
            if u.path == "/set":
                v = urllib.parse.parse_qs(u.query).get("v", [""])[0]
                if not re.fullmatch(r"[a-z0-9]{4,32}", v):
                    return self.send_error(400)
                body = f"<title>set {v}</title>"
                hdrs.append(("Set-Cookie", f"s119={v}; Max-Age=86400; Path=/"))
            elif u.path == "/check":
                body = f"<title>cookie {self.headers.get('Cookie') or 'none'} {u.query}</title>"
            else:
                return self.send_error(404)
            data = body.encode()
            self.send_response(200)
            for k, v in hdrs + [("Content-Length", str(len(data)))]:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


def units(verb, unit):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(150)
    s.connect(f"/run/desk-host/share/{K}/desk/units.sock")
    s.sendall(f"{verb} {unit}\n".encode())
    print(s.recv(300).decode().strip())


def cdp(method, path):
    for host in ("127.0.0.1", "::1"):
        try:
            c = http.client.HTTPConnection(host, 9222, timeout=10)
            c.request(method, path)
            r = c.getresponse()
            sys.stdout.write(r.read().decode())
            return 0 if r.status == 200 else 1
        except OSError:
            continue
    return 1


# ---------- root's ----------

def tabs():
    as_deskd("units", "thaw", "desk-browser")   # deskd may have frozen an unviewed Browser (ADR 0045): a thaw keeps every process
    r = as_deskd("cdp", "GET", "/json/list", net=True)
    try:
        return [t for t in json.loads(r.stdout) if t.get("type") == "page"]
    except ValueError:
        return None


def open_tab(path, title_re, wait=30):
    as_deskd("units", "thaw", "desk-browser")
    as_deskd("cdp", "PUT", f"/json/new?http://127.0.0.1:{PORT}{path}", net=True)
    end = time.time() + wait
    while time.time() < end:
        for t in tabs() or []:
            m = re.fullmatch(title_re, t.get("title", ""))
            if m:
                return m
        time.sleep(1)
    return None


def browser(marker):
    os.makedirs("/run/ma-verify-s119", exist_ok=True)
    run("systemctl", "stop", "ma-verify-s119-page")
    r = run("systemd-run", "--quiet", "--collect", "--unit=ma-verify-s119-page", "nsenter", f"--net={NS}", "setpriv", "--reuid=65534",
            "--regid=65534", "--clear-groups", "python3", "-I", ME, "serve", str(PORT))
    print(f"the cookie page in slot {K}'s network namespace (127.0.0.1:{PORT}, as nobody): {'started' if r.returncode == 0 else r.stderr.strip()}")
    t0 = time.time()
    r = as_deskd("units", "start", "desk-browser")
    print(f"desk-init's units.sock, as deskd: start desk-browser -> {r.stdout.strip() or r.stderr.strip()[:200]} in {time.time() - t0:.0f} s")
    ver = None
    while time.time() - t0 < 300 and ver is None:
        as_deskd("units", "thaw", "desk-browser")
        r = as_deskd("cdp", "GET", "/json/version", net=True)
        if r.returncode == 0:
            ver = json.loads(r.stdout).get("Browser")
        else:
            time.sleep(3)
    print(f"Chromium's CDP (as deskd, in the desk's namespace): {ver or 'NO ANSWER'} after {time.time() - t0:.0f} s")
    if not ver:
        return 1
    m = open_tab(f"/set?v={marker}", rf"set ({marker})")
    print(f"the page set the cookie s119={marker}: {'yes' if m else 'NO'}")
    m2 = open_tab(f"/check?n=0", r"cookie (.*) n=0")
    print(f"a new tab sends it: {m2.group(1) if m2 else 'NO ANSWER'}")
    return 0 if m and m2 and f"s119={marker}" in m2.group(1) else 1


def stat_start(p):
    try:
        return open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def procs():
    out = {}
    for root, _dirs, _files in os.walk(CG):
        try:
            pids = open(f"{root}/cgroup.procs").read().split()
        except OSError:
            continue
        for p in pids:
            st = stat_start(p)
            if st is None:
                continue
            try:
                comm = open(f"/proc/{p}/comm").read().strip()
                cmd = open(f"/proc/{p}/cmdline", "rb").read()
            except OSError:
                continue
            # Chromium's children rewrite their command line (one string, spaces): "--type=" anywhere marks a child, not the browser
            out[f"{p}:{st}"] = {"comm": comm, "cg": root[len(CG):] or "/", "type": b"--type=" in cmd}
    return out


def container(name):
    r = run("runc", "state", name)
    try:
        j = json.loads(r.stdout)
        return {"pid": j["pid"], "created": j["created"], "status": j["status"]}
    except (ValueError, KeyError):
        return None


def snapshot():
    p = procs()
    jvm = [k for k, v in p.items() if v["cg"].startswith("/svc-deskd") and v["comm"] == "java"]
    chrome = [k for k, v in p.items() if v["comm"] in ("chromium", "chrome") and not v["type"]]
    try:
        ooms = int(re.search(r"^oom_kill (\d+)$", open(f"{CG}/memory.events").read(), re.M).group(1))
    except (OSError, AttributeError):
        ooms = None
    return {"procs": p, "deskd": jvm, "browser": chrome, "desk": container(f"dh-desk-{K}"), "deskdContainer": container(f"dh-svc-{K}-deskd"),
            "oomKills": ooms}


def itype():
    tok = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                                                        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=3).read().decode()
    return urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/meta-data/instance-type",
                                                         headers={"X-aws-ec2-metadata-token": tok}), timeout=3).read().decode()


def rd(f):
    return open(f"{CG}/{f}").read().strip()


def reported():
    cls = None
    try:
        for line in open(REQS):
            r = json.loads(line)
            if r["route"] == "/v1/host/report" and r["status"] == 200:
                for s in r["body"]["slots"]:
                    if s["k"] == K:
                        cls = s.get("class")
    except OSError:
        pass
    return cls


def values_ok(cls):
    """(ok, lines): desk-1's cgroup against the class's values; a lower memory.max may wait ("pending" in class.json)."""
    w, m, sw, zw, p, rrb, rri, rwb, rwi, vrb, vri, vwb, vwi = map(int, run("python3", "-I", f"{L}/classes.py", "values", cls, itype()).stdout.split())
    rec = json.load(open(f"/run/desk-host/{K}/class.json"))
    pend = (rec.get("pending") or {}).get("memory.max")
    io = rd("io.max")
    have = {"cpu.idle": rd("cpu.idle"), "cpu.weight": rd("cpu.weight"), "memory.max": rd("memory.max"), "memory.swap.max": rd("memory.swap.max"),
            "memory.zswap.max": rd("memory.zswap.max"), "memory.zswap.writeback": rd("memory.zswap.writeback"), "pids.max": rd("pids.max"),
            "memory.current": rd("memory.current")}
    probs = []
    if (have["cpu.idle"], have["cpu.weight"] if w else "-") != (("1", "-") if w == 0 else ("0", str(w))):
        probs.append(f"cpu.idle {have['cpu.idle']} cpu.weight {have['cpu.weight']}, not {'cpu.idle 1' if w == 0 else f'cpu.weight {w}'}")
    if pend is None and have["memory.max"] != str(m // PAGE * PAGE):
        probs.append(f"memory.max {have['memory.max']}, not {m // PAGE * PAGE}")
    if pend is not None and not (int(pend) == m and have["memory.max"] != "max" and int(have["memory.max"]) > m):
        probs.append(f"pending memory.max {pend} with memory.max {have['memory.max']}: not a lower cap waiting for {m}")
    for f, want in (("memory.swap.max", sw), ("memory.zswap.max", zw), ("pids.max", p), ("memory.zswap.writeback", 0)):
        if have[f] != str(want // PAGE * PAGE if f in ("memory.swap.max", "memory.zswap.max") else want):
            probs.append(f"{f} {have[f]}, not {want}")
    for a, b, c, d, what in ((rrb, rwb, rri, rwi, "root"), (vrb, vwb, vri, vwi, "volume")):
        if f"rbps={a} wbps={b} riops={c} wiops={d}" not in io:
            probs.append(f"io.max for its {what}: not rbps={a} wbps={b} riops={c} wiops={d}")
    if rec.get("class") != cls:
        probs.append(f"class.json says {rec.get('class')}")
    mib = lambda x: int(x) // 1048576  # noqa: E731
    cpu = "cpu.idle 1" if have["cpu.idle"] == "1" else "cpu.weight " + have["cpu.weight"]
    waits = f" (a lower cap of {mib(pend)} MiB waits: memory.current {mib(have['memory.current'])} MiB is over 90% of it)" if pend else ""
    ios = " | ".join(io.splitlines())
    lines = [f"  desk-1's cgroup: {cpu}, memory.max {mib(have['memory.max'])} MiB{waits}, zswap {mib(have['memory.zswap.max'])} MiB, "
             f"pids {have['pids.max']}, io.max {ios}"]
    lines += [f"  NOT {cls}: {x}" for x in probs]
    return not probs, lines


def journal_since(since):
    return run("journalctl", "-u", "desk-host-link", "--no-pager", "-o", "cat", f"--since=@{since}").stdout


def wait_class(cls, wait):
    end = time.time() + wait
    while time.time() < end:
        c = reported()
        if c and c.split("+")[0] == cls:
            return c
        time.sleep(2)
    return reported()


def check(cls, snapfile, marker, since, wait=150):
    ok = True
    got = wait_class(cls, wait)
    print(f"the report says slot {K} is {got}")
    ok &= bool(got) and got.split("+")[0] == cls
    good, lines = values_ok(cls)
    print("\n".join(lines))
    ok &= good
    r = run(f"{L}/desk-host-check", "--allow-verify-access", "--only", "class-applied")
    print("  " + r.stdout.strip())
    ok &= r.returncode == 0
    before, now = json.load(open(snapfile)), snapshot()
    # Chromium's own children (renderers, utilities: "--type=") come and go as it likes; every other process must stay, and the
    # browser process be the same one, with no OOM kill in the desk's cgroup across the change
    gone = [f"{k} ({v['comm']} in {v['cg']})" for k, v in before["procs"].items() if k not in now["procs"] and not v["type"]]
    kids = [k for k, v in before["procs"].items() if k not in now["procs"] and v["type"]]
    new = [k for k in now["procs"] if k not in before["procs"]]
    print(f"  processes: {len(before['procs'])} before, {len(before['procs']) - len(gone) - len(kids)} of them still there, {len(new)} new; "
          f"Chromium's children gone on their own: {len(kids)}" + (f"; GONE: {gone[:8]}" if gone else ""))
    print(f"  deskd's JVM {before['deskd']} -> {now['deskd']}; Chromium's browser process {before['browser']} -> {now['browser']}; "
          f"OOM kills in desk-1 {before.get('oomKills')} -> {now.get('oomKills')}")
    print(f"  the desk's container created {before['desk']['created']} -> {now['desk']['created']}; deskd's container created "
          f"{before['deskdContainer']['created']} (pid {before['deskdContainer']['pid']}) -> {now['deskdContainer']['created']} (pid {now['deskdContainer']['pid']})")
    ok &= not gone and before["deskd"] == now["deskd"] and len(now["deskd"]) == 1 and before["browser"] == now["browser"] and len(now["browser"]) == 1
    ok &= before["desk"] == now["desk"] and before["deskdContainer"] == now["deskdContainer"]
    ok &= before.get("oomKills") is not None and before.get("oomKills") == now.get("oomKills")
    n = int(time.time())
    m = open_tab(f"/check?n={n}", rf"cookie (.*) n={n}")
    print(f"  a new tab after the change sends: {m.group(1) if m else 'NO ANSWER'}")
    ok &= bool(m) and f"s119={marker}" in m.group(1)
    j = [x for x in journal_since(since).splitlines() if "set_class" in x]
    print("  the link: " + (" | ".join(j[-3:]) if j else "nothing about set_class"))
    ok &= any(f"set_class epoch 1 to {cls}: in place" in x for x in j)
    return 0 if ok else 1


def same(cls):
    c = reported()
    good, lines = values_ok(cls)
    print(f"the report says slot {K} is {c}")
    print("\n".join(lines))
    return 0 if good and c and c.split("+")[0] == cls else 1


def refused(code, cls, since, wait=150):
    end = time.time() + wait
    j = []
    while time.time() < end:
        j = [x for x in journal_since(since).splitlines() if f"refused: {code}" in x]
        if j:
            break
        time.sleep(2)
    print(f"the link: {j[-1] if j else f'no refused: {code} in {wait} s'}")
    return 0 if j and same(cls) == 0 else 1


def fake(cls, extra=None):
    s = json.load(open(STATE))
    if cls != "-":
        s["slots"][str(K)]["class"] = cls
    if extra == "bad":   # two orders the link must refuse by themselves: a class this host hasn't, and slot 1 for slot 2's desk
        me, other = s["slots"][str(K)], s["slots"]["2"]
        extra = json.dumps([{"id": f"set_class:{K}:{me['epoch']}:huge", "op": "set_class", "k": K, "deskId": me["deskId"], "epoch": me["epoch"], "class": "huge"},
                            {"id": f"set_class:{K}:{me['epoch']}:standard", "op": "set_class", "k": K, "deskId": other["deskId"], "epoch": me["epoch"], "class": "standard"}])
    s["extraOrders"] = json.loads(extra) if extra else []
    json.dump(s, open(STATE + ".tmp", "w"))
    os.replace(STATE + ".tmp", STATE)
    print(f"the fake Platform: slot {K}'s record {s['slots'][str(K)].get('class', 'standard')}, {len(s['extraOrders'])} extra order(s)")


def main(a):
    if a[:1] == ["serve"]:
        return serve(int(a[1]))
    if a[:1] == ["units"]:
        return units(a[1], a[2])
    if a[:1] == ["cdp"]:
        return cdp(a[1], a[2])
    if a[:1] == ["browser"]:
        return browser(a[1])
    if a[:1] == ["snap"]:
        json.dump(snapshot(), open(a[1], "w"))
        return 0
    if a[:1] == ["check"]:
        return check(a[1], a[2], a[3], int(a[4]), int(a[5]) if len(a) > 5 else 150)
    if a[:1] == ["same"]:
        return same(a[1])
    if a[:1] == ["refused"]:
        return refused(a[1], a[2], int(a[3]), int(a[4]) if len(a) > 4 else 150)
    if a[:1] == ["fake"]:
        return fake(a[1], a[2] if len(a) > 2 else None)
    if a[:1] == ["down"]:
        return run("systemctl", "stop", "ma-verify-s119-page").returncode
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
