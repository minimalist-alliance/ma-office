#!/usr/bin/env python3
"""Task 32's rehearsal: deskd's data.*, the desk-data helper, ma-move and the Desk app's /export, run together
for real on one machine, as the current user, on loopback only. See README.md. Rehearsal only, never on a desk.

    rig.py [--only move|export] [--keep]

rehearse.sh builds what this runs and calls it under nice. Everything lives under one scratch directory
(MA_REHEARSE_DIR, default /tmp/claude-$UID/ma-rehearse), every port is a free one, and every process it starts is
stopped on the way out, however it ends.
"""
import argparse
import csv
import ctypes
import hashlib
import http.client
import http.server
import io
import json
import os
import select
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True   # nothing generated beside the scripts
import cdp  # noqa: E402

HOME = os.path.expanduser("~")
SCRATCH = os.environ.get("MA_REHEARSE_DIR", f"/tmp/claude-{os.getuid()}/ma-rehearse")
CHROME = os.environ.get("MA_REHEARSE_CHROMIUM", f"{HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome")
JAVA = os.environ.get("MA_REHEARSE_JAVA", f"{HOME}/.local/share/ma-desk-toolchain/jdk-21/bin/java")
NODE = os.environ.get("MA_REHEARSE_NODE", f"{HOME}/.local/node-v24/bin/node")
DESKD_JAR = os.path.join(REPO, "services/deskd/target/deskd.jar")
HELPER = os.path.join(REPO, "tools/desk-data/desk-data")
FAKE_IMDS = os.path.join(REPO, "services/scripts/fake-imds.py")
WEB = os.path.join(REPO, "web")

SOURCE_DESK = "d-dev0000000000"     # gateway-shim's one desk, and fake-imds.py's
TARGET_DESK = "d-rehearsetarget01"  # the self-hosted desk the move goes to
MOVE_ID = "mv-rehearsal-1"
MOVE_CODE = "K7Q2-M9XA-P4TB"
BIG = 300 << 20

# Decision 4 of the draft ADR, written out here again rather than taken from the helper, so it's checked, not assumed.
MACHINE = ["rtc", "selfhost", "desk-egress", ".ma-volume", "lost+found"]
CACHES = {"Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
          "GraphiteDawnCache", "ShaderCache", "component_crx_cache", "Crashpad"}
LOCKS = {"SingletonLock", "SingletonCookie", "SingletonSocket"}
PARTS = ["agent", "apps", "browser", "desk", "files"]


def path(*p):
    return os.path.join(SCRATCH, *p)


def say(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(what, check, seconds=60, every=0.2):
    deadline = time.monotonic() + seconds
    while True:
        try:
            v = check()
            if v:
                return v
        except (OSError, ValueError, KeyError):
            pass
        if time.monotonic() > deadline:
            raise TimeoutError(f"waited {seconds} s for {what}")
        time.sleep(every)


def sha256_file(name):
    h = hashlib.sha256()
    with open(name, "rb") as f:
        while b := f.read(1 << 20):
            h.update(b)
    return h.hexdigest()


def mb_s(nbytes, seconds):
    """Decimal MB a second."""
    return round(nbytes / 1e6 / seconds, 1) if seconds > 0 else None


# ---------------------------------------------------------------- processes

class Procs:
    """Every process the rig starts, each in its own process group, so a stop takes its children too."""

    def __init__(self):
        self.procs = {}
        self.lock = threading.Lock()

    def start(self, name, argv, env=None, cwd=None):
        log = open(path("logs", f"{name}.log"), "ab")
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env, cwd=cwd,
                             start_new_session=True)
        log.close()
        with self.lock:
            self.procs[name] = p
        return p

    def kill(self, name, sig=signal.SIGTERM, wait=20):
        with self.lock:
            p = self.procs.get(name)
        if p is None or p.poll() is not None:
            return
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(wait)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait(10)
        try:
            os.killpg(p.pid, signal.SIGKILL)   # whatever it left in its group
        except ProcessLookupError:
            pass

    def stop_all(self):
        for name in reversed(list(self.procs)):
            self.kill(name, signal.SIGTERM, wait=10)


PROCS = Procs()


# ---------------------------------------------------------------- inotify: what touched the machine's files

IN_ACCESS, IN_CLOSE_NOWRITE, IN_OPEN = 0x1, 0x10, 0x20


class Watch:
    """inotify on the machine's own paths. Opening, reading, writing, moving or removing any of them is an event."""
    MASK = 0xFFF   # IN_ALL_EVENTS

    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        self.wds = {}
        self.events = []
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)

    def add(self, name):
        wd = self.libc.inotify_add_watch(self.fd, name.encode(), self.MASK)
        if wd < 0:
            raise OSError(ctypes.get_errno(), f"inotify_add_watch {name}")
        self.wds[wd] = name

    def add_tree(self, root):
        # Listed first and watched after, or the rig's own listing would be the first event.
        dirs = [d for d, _, _ in os.walk(root)]
        for d in dirs:
            self.add(d)

    def start(self):
        self.thread.start()

    def _run(self):
        while self.running:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if not r:
                continue
            try:
                buf = os.read(self.fd, 65536)
            except BlockingIOError:
                continue
            i = 0
            while i < len(buf):
                wd, mask, _cookie, n = struct.unpack_from("iIII", buf, i)
                name = buf[i + 16:i + 16 + n].rstrip(b"\0").decode(errors="replace")
                i += 16 + n
                self.events.append({"t": time.time(), "path": os.path.join(self.wds.get(wd, "?"), name), "mask": mask})

    def stop(self):
        self.running = False
        self.thread.join(2)
        os.close(self.fd)


# ---------------------------------------------------------------- the web page that makes the sign-ins

class Pages(http.server.BaseHTTPRequestHandler):
    """Sets cookies, localStorage and IndexedDB, and says back what a browser brings, for the sign-in checks."""
    protocol_version = "HTTP/1.1"
    values = {}

    def log_message(self, *_):
        pass

    def _send(self, body, headers=()):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        v = self.values
        if self.path == "/set":
            cookies = [("Set-Cookie", f"keep={v['keep']}; Max-Age=86400; Path=/"),
                       ("Set-Cookie", f"sid={v['sid']}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax"),
                       ("Set-Cookie", f"pref={v['pref']}; Max-Age=86400; Path=/visit"),
                       ("Set-Cookie", f"sess={v['sess']}; Path=/")]
            script = (f"localStorage.setItem('ma-rehearsal', {json.dumps(v['ls'])});"
                      "const o = indexedDB.open('rehearsal', 1);"
                      "o.onupgradeneeded = () => o.result.createObjectStore('kv');"
                      "o.onsuccess = () => { const tx = o.result.transaction('kv', 'readwrite');"
                      f"tx.objectStore('kv').put({json.dumps(v['idb'])}, 'k'); tx.oncomplete = () => {{ document.title = 'set'; }}; }};")
            self._send(f"<!doctype html><title>setting</title><p>Signed in.</p><script>{script}</script>", cookies)
        elif self.path.startswith("/visit/"):
            n = self.path.rsplit("/", 1)[1]
            self._send(f"<!doctype html><title>Rehearsal visit {n}</title><p>Visit {n}.</p>")
        elif self.path == "/check":
            header = self.headers.get("Cookie") or ""
            script = ("window.check = new Promise((done) => { const o = indexedDB.open('rehearsal', 1);"
                      "o.onupgradeneeded = () => o.result.createObjectStore('kv');"
                      "o.onsuccess = () => { const g = o.result.transaction('kv').objectStore('kv').get('k');"
                      "g.onsuccess = () => done({ header: document.getElementById('h').textContent,"
                      " cookie: document.cookie, ls: localStorage.getItem('ma-rehearsal'), idb: g.result ?? null }); }; });")
            self._send(f"<!doctype html><title>check</title><pre id=h>{header}</pre><script>{script}</script>")
        else:
            self.send_error(404)


# ---------------------------------------------------------------- Chromium, as desk-browser starts it

def chromium_argv(profile, port):
    """desk-browser-start's flags (image/recipe), headless instead of on X, and --no-sandbox for this machine."""
    sessions = os.path.join(profile, "Default", "Sessions")
    restore = os.path.isdir(sessions) and any(f.startswith(("Session_", "Tabs_")) for f in os.listdir(sessions))
    return [CHROME, "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--noerrdialogs",
            "--disable-session-crashed-bubble", "--disable-infobars", "--disable-breakpad", "--password-store=basic",
            "--disable-gpu", f"--user-data-dir={profile}", "--disk-cache-size=1073741824",
            "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={port}",
            "--restore-last-session" if restore else "about:blank"]


class Chromium:
    def __init__(self, name, profile, port):
        self.name, self.profile, self.port = name, profile, port
        self.lock = threading.Lock()

    def running(self):
        p = PROCS.procs.get(self.name)
        return p is not None and p.poll() is None

    def start(self):
        with self.lock:
            if self.running():
                return
            PROCS.start(self.name, chromium_argv(self.profile, self.port))
            cdp.wait_port(self.port, 60)

    def stop(self):
        """As systemd stops desk-browser: gracefully, so it writes everything down. Headless Chromium on SIGTERM
        exits without flushing its cookies, so the graceful way here is CDP's Browser.close."""
        with self.lock:
            if not self.running():
                return
            try:
                b = cdp.Browser(self.port, timeout=10)
                b.call("Browser.close", timeout=10)
                b.close()
            except (OSError, RuntimeError, TimeoutError, ConnectionError):
                pass
            p = PROCS.procs[self.name]
            try:
                p.wait(30)
            except subprocess.TimeoutExpired:
                pass
            PROCS.kill(self.name, signal.SIGTERM, wait=10)


# ---------------------------------------------------------------- units.sock: desk-units, stood in for

class Units(threading.Thread):
    """Answers `ok` to every request, logs the verbs, and really stops and starts the source's Chromium. On each
    stop it copies the stopped profile, so the move's held pass can be compared with what Chromium left."""

    def __init__(self, sock_path, browser):
        super().__init__(daemon=True)
        self.sock_path, self.browser = sock_path, browser
        self.verbs = []
        self.snapshots = []
        self.srv = socket.socket(socket.AF_UNIX)
        self.srv.bind(sock_path)
        os.chmod(sock_path, 0o600)
        self.srv.listen(16)

    def run(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        with conn:
            line = b""
            while not line.endswith(b"\n") and len(line) < 64:
                b = conn.recv(64)
                if not b:
                    break
                line += b
            verb, _, unit = line.decode().strip().partition(" ")
            began = time.time()
            if unit == "desk-browser" and verb == "stop":
                self.browser.stop()
                n = len(self.snapshots) + 1
                snap = path("snap", f"src-browser-stopped-{n}")
                shutil.copytree(path("src/data/browser"), snap, symlinks=True)
                self.snapshots.append({"t": time.time(), "dir": snap})
            elif unit == "desk-browser" and verb == "start":
                self.browser.start()
            self.verbs.append({"t": began, "verb": verb, "unit": unit, "ms": round((time.time() - began) * 1000)})
            with open(path("logs", "units.log"), "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {verb} {unit} ok\n")
            conn.sendall(b"ok\n")

    def close(self):
        self.srv.close()


# ---------------------------------------------------------------- the platform's moves routes, stood in for

class Platform(http.server.BaseHTTPRequestHandler):
    """POST /v1/moves/claim, /v1/moves/{id}/connect (to gateway-shim's connect, which gives an owner token) and
    /v1/moves/{id}/report (kept as it came)."""
    protocol_version = "HTTP/1.1"
    shim = None
    token = None
    claimed = False
    connects = []
    reports = []

    def log_message(self, *_):
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        cls = Platform
        if self.path == "/v1/moves/claim":
            req = json.loads(raw)
            if req.get("code") != MOVE_CODE or req.get("targetDeskId") != TARGET_DESK:
                return self._json(404, {"error": {"code": "not_found", "message": "No such code."}})
            if cls.claimed:
                return self._json(409, {"error": {"code": "code_used", "message": "Used."}})
            cls.claimed = True
            return self._json(200, {"moveId": MOVE_ID, "moveToken": cls.token, "sourceDeskId": SOURCE_DESK,
                                    "targetDeskId": TARGET_DESK, "sourceName": "Personal", "targetName": "Home desk",
                                    "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))})
        if self.headers.get("Authorization") != f"Move {cls.token}" or not self.path.startswith(f"/v1/moves/{MOVE_ID}/"):
            return self._json(401, {"error": {"code": "unauthorized", "message": "No."}})
        if self.path.endswith("/connect"):
            req = json.loads(raw)
            cls.connects.append({"t": time.time(), "start": req.get("start")})
            body = json.dumps({"scope": "owner", "start": bool(req.get("start")),
                               "clientDtlsFingerprint": req.get("clientDtlsFingerprint")}).encode()
            r = urllib.request.Request(f"{cls.shim}/v1/desks/{SOURCE_DESK}/connect", data=body, method="POST",
                                       headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r, timeout=20) as resp:
                    return self._json(resp.status, json.loads(resp.read()))
            except urllib.error.HTTPError as e:
                return self._json(e.code, json.loads(e.read() or b"{}"))
        if self.path.endswith("/report"):
            cls.reports.append({"t": time.time(), "raw": raw.decode()})
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return self._json(404, {"error": {"code": "not_found", "message": "No."}})


def serve(handler, port):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------------------------------------------------------- the trees

def write(rel, data, root=None, mode=0o600):
    name = os.path.join(root or path("src/data"), rel)
    os.makedirs(os.path.dirname(name), exist_ok=True)
    with open(name, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(name, mode)
    return name


def random_file(name, size, seed):
    """Fast, varied, and not compressible: SHA-256 in counter mode."""
    os.makedirs(os.path.dirname(name), exist_ok=True)
    block = b"".join(hashlib.sha256(seed + i.to_bytes(4, "big")).digest() for i in range(32768))   # 1 MiB
    with open(name, "wb") as f:
        left = size
        i = 0
        while left > 0:
            chunk = hashlib.sha256(seed + b"x" + i.to_bytes(8, "big")).digest() + block[32:]
            f.write(chunk[:left])
            left -= len(chunk)
            i += 1


def bookmarks_json(entries):
    """A real-format Bookmarks file, with Chromium's checksum (bookmark_codec.cc)."""
    md5 = hashlib.md5()
    nid = [3]

    def node(title, url):
        nid[0] += 1
        n = {"date_added": "13400000000000000", "date_last_used": "0", "guid": f"00000000-0000-4000-8000-{nid[0]:012d}",
             "id": str(nid[0]), "name": title, "type": "url", "url": url}
        md5.update(n["id"].encode())
        md5.update(title.encode("utf-16-le"))
        md5.update(b"url")
        md5.update(url.encode())
        return n

    def folder(fid, title, guid, children):
        md5.update(fid.encode())
        md5.update(title.encode("utf-16-le"))
        md5.update(b"folder")
        return {"children": children, "date_added": "13400000000000000", "date_last_used": "0",
                "date_modified": "0", "guid": guid, "id": fid, "name": title, "type": "folder"}

    bar_children = [node(t, u) for t, u in entries]
    roots = {"bookmark_bar": folder("1", "Bookmarks bar", "0bc5d13f-2cba-5d74-951f-3f233fe6c908", bar_children),
             "other": folder("2", "Other bookmarks", "82b081ec-3dd3-529c-8475-ab6c344590dd", []),
             "synced": folder("3", "Mobile bookmarks", "4cf2e351-0e85-532b-bb37-df045d8f8d0f", [])}
    return json.dumps({"checksum": md5.hexdigest(), "roots": roots, "version": 1}, indent=3)


def make_trees(page_port):
    src = path("src/data")
    dst = path("dst/data")
    # The member's parts on the source.
    write("desk/settings.json", json.dumps({"theme": "dusk", "layout": {"apps": ["browser", "notebook"]}}))
    write("desk/notebook/Café notes.json", json.dumps({"title": "Café notes", "body": "Résumé, naïve, 東京 ✓"}))
    write("desk/chat/2026-11-06.jsonl", "".join(json.dumps({"n": i, "text": f"message {i}"}) + "\n" for i in range(500)))
    write("desk/volume.json", json.dumps({"volumeId": "vol-0123456789abcdef0", "formattedAt": None}))   # the machine's
    write("agent/memory.json", json.dumps({"notes": ["prefers short replies"] * 50}))
    db = sqlite3.connect(os.path.join(src, "agent/runs.db"))
    db.execute("pragma journal_mode=wal")
    db.execute("create table runs (id integer primary key, task text, tokens integer)")
    db.executemany("insert into runs (task, tokens) values (?, ?)", [(f"task {i}", i * 7) for i in range(2000)])
    db.commit()
    db.close()
    write("apps/registry.json", json.dumps({"apps": {"notes": {"uid": 2001}}}))                      # the machine's
    write("apps/notes/data/doc1.json", json.dumps({"doc": "one"}))
    write("apps/notes/releases/1.0.0/app.js", "console.log('installed package')")                    # the machine's
    os.symlink("releases/1.0.0", os.path.join(src, "apps/notes/current"))                             # the machine's
    write("apps/notes/cache/blob.bin", os.urandom(4096))                                              # rebuilt on use
    random_file(os.path.join(src, "files/Photos/harbor.jpg"), 3 << 20, b"harbor")
    write("files/Docs/report.txt", "The quarterly report.\n" * 2000)
    write("files/naïve résumé.txt", "unicode name\n")
    os.makedirs(os.path.join(src, "files/Empty folder"))
    os.symlink("Docs/report.txt", os.path.join(src, "files/latest report"))
    os.symlink("../rtc/dtls.pem", os.path.join(src, "files/escape"))      # leads out of its part: never followed
    random_file(os.path.join(src, "files/big.bin"), BIG, b"big")
    write("browser/downloads/statement.pdf", b"%PDF-1.4\n" + os.urandom(20000))
    profile = os.path.join(src, "browser/profile")
    # RestoreOnStartup 1 is the desk's managed policy (image/recipe); as a user pref it has the same effect, which
    # includes keeping session cookies on disk across a restart.
    write("browser/profile/Default/Preferences", json.dumps({"session": {"restore_on_startup": 1}}))
    write("browser/profile/Default/Bookmarks", bookmarks_json([
        ("Rehearsal home", f"http://127.0.0.1:{page_port}/visit/1"),
        ("Café menu — naïve", f"http://localhost:{page_port}/visit/2"),
    ]))
    # The machine's own, which nothing may read or move.
    for root, tag in ((src, b"source"), (dst, b"target")):
        write("rtc/dtls.pem", b"-----BEGIN NOT A KEY-----\n" + tag + b"\n", root)
        write("desk-egress/budget.json", json.dumps({"month": 1, "tag": tag.decode()}), root)
        write(".ma-volume", json.dumps({"id": tag.decode()}), root)
        os.makedirs(os.path.join(root, "lost+found"), exist_ok=True)
        write("selfhost/key.pem", b"-----BEGIN NOT A KEY-----\nselfhost " + tag + b"\n", root)
    write("selfhost/desk.json", json.dumps({"deskId": TARGET_DESK, "env": "staging"}), dst)
    # What the self-hosted desk had before the move: its own volume record and registry stay, the rest goes to before/.
    write("desk/volume.json", json.dumps({"volumeId": "unknown", "formattedAt": None, "target": True}), dst)
    write("desk/settings.json", json.dumps({"theme": "light", "fresh": True}), dst)
    write("apps/registry.json", json.dumps({"apps": {"notes": {"uid": 2001}}, "target": True}), dst)
    write("browser/profile/First Run", b"", dst)
    return profile


def tree_digest(root):
    out = {}
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            st = os.lstat(p)
            out[os.path.relpath(p, root)] = (sha256_file(p), st.st_ino, st.st_mode)
        out[os.path.relpath(d, root) + "/"] = (None, os.lstat(d).st_ino, os.lstat(d).st_mode)
    return out


def machine_digest(root):
    out = {}
    for m in MACHINE:
        p = os.path.join(root, m)
        if os.path.isdir(p):
            out.update({f"{m}/{k}": v for k, v in tree_digest(p).items()})
        elif os.path.exists(p):
            st = os.lstat(p)
            out[m] = (sha256_file(p), st.st_ino, st.st_mode)
    return out


def watch_machine(w, root):
    for m in MACHINE:
        p = os.path.join(root, m)
        if os.path.isdir(p):
            w.add_tree(p)
        elif os.path.exists(p):
            w.add(p)


# ---------------------------------------------------------------- comparing what moved

def excluded(part, rel):
    c = rel.split("/")
    if part == "browser" and c[0] == "profile":
        if len(c) >= 2 and (c[1] in CACHES or (len(c) == 2 and c[1] in LOCKS)):
            return True     # directly in the profile
        if len(c) >= 3 and c[2] in CACHES:
            return True     # in a profile directory, such as Default
    if part == "desk" and rel in ("volume.json", "browser-moved.json"):
        return True     # each desk's own: its volume, and deskd's record that a move kept its Browser held
    if part == "apps" and (rel == "registry.json" or (len(c) >= 2 and c[1] in ("releases", "current", "previous", "cache"))):
        return True
    return False


def is_sqlite(name):
    with open(name, "rb") as f:
        return f.read(16) == b"SQLite format 3\x00"


def sqlite_dump(name):
    """The database as SQLite opens it: a copy with its -wal or -journal, recovered, then dumped."""
    with tempfile.TemporaryDirectory(dir=path("tmp")) as t:
        base = os.path.join(t, "db")
        shutil.copyfile(name, base)
        for suffix in ("-wal", "-journal"):
            if os.path.exists(name + suffix):
                shutil.copyfile(name + suffix, base + suffix)
        c = sqlite3.connect(base)
        try:
            rows = sum(c.execute(f'select count(*) from "{t_}"').fetchone()[0]
                       for (t_,) in c.execute("select name from sqlite_master where type='table'").fetchall())
            return hashlib.sha256("\n".join(c.iterdump()).encode()).hexdigest(), rows
        finally:
            c.close()


def walk(root):
    out = {}
    for d, dirs, files in os.walk(root):
        for x in dirs + files:
            p = os.path.join(d, x)
            out[os.path.relpath(p, root).replace(os.sep, "/")] = p
    return out


def compare_part(part, src_root, dst_root):
    """Every file of the part, less decision 4's exclusions, equal at the target: bytes, or SQLite as a database."""
    res = {"part": part, "files": 0, "bytes": 0, "sqlite": 0, "sqliteRows": 0, "links": 0, "dirs": 0, "problems": []}
    src, dst = walk(src_root), walk(dst_root)
    for rel, sp in sorted(src.items()):
        if excluded(part, rel) or rel.endswith(("-wal", "-journal", "-shm")):
            continue
        dp = dst.get(rel)
        if os.path.islink(sp):
            target = os.readlink(sp)
            inside = not os.path.isabs(target) and os.path.normpath(os.path.join(os.path.dirname(rel), target)).split("/")[0] != ".."
            if inside:
                res["links"] += 1
                if dp is None or not os.path.islink(dp) or os.readlink(dp) != target:
                    res["problems"].append(f"link not carried: {rel}")
            elif dp is not None:
                res["problems"].append(f"a link out of its part was made: {rel}")
            continue
        if os.path.isdir(sp):
            res["dirs"] += 1
            if dp is None or not os.path.isdir(dp):
                res["problems"].append(f"directory missing: {rel}")
            continue
        if dp is None:
            res["problems"].append(f"missing: {rel}")
            continue
        res["files"] += 1
        res["bytes"] += os.path.getsize(sp)
        if is_sqlite(sp):
            res["sqlite"] += 1
            a, rows = sqlite_dump(sp)
            b, _ = sqlite_dump(dp)
            res["sqliteRows"] += rows
            if a != b:
                res["problems"].append(f"database differs: {rel}")
            if any(os.path.exists(dp + s) for s in ("-wal", "-journal")):
                res["problems"].append(f"database came with a -wal or -journal: {rel}")
        elif sha256_file(sp) != sha256_file(dp):
            res["problems"].append(f"bytes differ: {rel}")
    for rel in sorted(set(dst) - set(src)):
        if not excluded(part, rel):
            res["problems"].append(f"extra at the target: {rel}")
    for rel in sorted(src):
        if excluded(part, rel) and rel in dst and not (part == "desk" and rel == "volume.json") \
                and not (part == "apps" and rel == "registry.json"):
            res["problems"].append(f"left-out file came across: {rel}")
    return res


# ---------------------------------------------------------------- the rig

class Rig:
    def __init__(self, args):
        self.args = args
        self.ports = {k: free_port() for k in ("shim", "rtc", "imds", "cdp_src", "cdp_dst", "pages", "platform", "harness")}
        self.evidence = {"ports": self.ports, "chromium": None}
        self.helper_logs = path("logs", "helper")
        self.deskd_starts = 0

    # ---- setup

    def scratch(self):
        """A fresh scratch directory, keeping bin/, which rehearse.sh builds into."""
        if not os.path.exists(os.path.join(SCRATCH, ".ma-rehearse")):
            sys.exit(f"{SCRATCH} isn't a rehearsal's (no .ma-rehearse): run rehearse.sh, which makes it")
        for name in os.listdir(SCRATCH):
            if name not in ("bin", ".ma-rehearse"):
                p = os.path.join(SCRATCH, name)
                shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)
        for d in ("src/data", "dst/data", "run", "rtc-data", "logs/helper", "snap", "move/units", "web", "tmp"):
            os.makedirs(path(d), exist_ok=True)
        os.chmod(SCRATCH, 0o700)

    def env_deskd(self):
        e = dict(os.environ)
        e.update({
            "DESKD_RTC_SOCKET": path("run/rtc.sock"), "DESKD_ADMIN_SOCKET": path("run/deskd-admin.sock"),
            "DESKD_UNITS_SOCKET": path("run/units.sock"), "DESKD_DATA_SOCKET": path("run/data.sock"),
            "DESKD_AGENT_SOCKET": path("run/agent.sock"), "DESKD_DATA_DIR": path("src/data/desk"),
            "DESKD_IMDS_URL": f"http://127.0.0.1:{self.ports['imds']}", "DESKD_API_URL": self.shim,
            "DESKD_CDP_PORT": str(self.ports["cdp_src"]), "DESKD_CDP_UID": str(os.getuid()),
        })
        return e

    @property
    def shim(self):
        return f"http://127.0.0.1:{self.ports['shim']}"

    def shim_state(self):
        with urllib.request.urlopen(f"{self.shim}/dev/state", timeout=2) as r:
            return json.loads(r.read())

    def start_deskd(self):
        self.deskd_starts += 1
        PROCS.start("deskd", [JAVA, "-XX:+UseSerialGC", "-Xmx384m", "-XX:TieredStopAtLevel=1", "-jar", DESKD_JAR],
                    env=self.env_deskd())
        wait_for("deskd's hello and gateway link", lambda: self.shim_state().get("ready"), 90)

    def start_rtc(self):
        PROCS.start("desk-rtc", [path("bin/desk-rtc"), "--socket", path("run/rtc.sock"), "--data-dir", path("rtc-data"),
                                 "--bind", "127.0.0.1", "--port", str(self.ports["rtc"])])
        wait_for("rtc.sock", lambda: os.path.exists(path("run/rtc.sock")), 30)

    def health(self):
        conn = http.client.HTTPConnection("localhost")
        conn.sock = socket.socket(socket.AF_UNIX)
        conn.sock.connect(path("run/deskd-admin.sock"))
        conn.request("GET", "/health")
        return json.loads(conn.getresponse().read())

    def up(self):
        self.scratch()
        say(f"scratch {SCRATCH}, ports {self.ports}")
        self.values = {k: hashlib.sha256(os.urandom(16)).hexdigest()[:24] for k in ("keep", "sid", "pref", "sess", "ls", "idb")}
        Pages.values = self.values
        self.pages = serve(Pages, self.ports["pages"])
        Platform.shim, Platform.token = self.shim, hashlib.sha256(os.urandom(16)).hexdigest()
        self.platform = serve(Platform, self.ports["platform"])
        say("making the source and target trees (300 MiB in files/big.bin)")
        self.profile = make_trees(self.ports["pages"])
        self.big_sha = sha256_file(path("src/data/files/big.bin"))
        # The machine's files, as they are before anything runs; inotify from here on.
        self.machine_before = {"src": machine_digest(path("src/data")), "dst": machine_digest(path("dst/data"))}
        self.watch = Watch()
        watch_machine(self.watch, path("src/data"))
        watch_machine(self.watch, path("dst/data"))
        self.watch.start()

        PROCS.start("fake-imds", [sys.executable, "-I", FAKE_IMDS, "--port", str(self.ports["imds"])])
        PROCS.start("gateway-shim", [path("bin/gateway-shim"), "--addr", f"127.0.0.1:{self.ports['shim']}"])
        wait_for("gateway-shim", lambda: self.shim_state() is not None, 30)
        self.start_rtc()
        self.browser = Chromium("chromium-source", self.profile, self.ports["cdp_src"])
        self.units = Units(path("run/units.sock"), self.browser)
        self.units.start()
        PROCS.start("desk-data", ["systemd-socket-activate", "--accept", "--inetd", "-l", path("run/data.sock"),
                                  sys.executable, "-I", os.path.join(HERE, "helper-run.py"), HELPER, path("src/data"),
                                  self.helper_logs])
        wait_for("data.sock", lambda: os.path.exists(path("run/data.sock")), 30)
        self.make_profile()
        self.start_deskd()
        h = self.health()
        say(f"deskd {h.get('version')} up: {json.dumps({k: h.get(k) for k in ('rtc', 'platform')})}")

    def make_profile(self):
        say("making a real Chromium profile: cookies, localStorage, IndexedDB, history, bookmarks")
        self.browser.start()
        b = cdp.Browser(self.ports["cdp_src"])
        sid = b.page()
        for host in ("127.0.0.1", "localhost"):
            b.navigate(sid, f"http://{host}:{self.ports['pages']}/set")
            wait_for("the page's storage", lambda: b.evaluate(sid, "document.title") == "set", 20)
        for n in range(1, 6):
            b.navigate(sid, f"http://127.0.0.1:{self.ports['pages']}/visit/{n}")
        self.evidence["chromium"] = b.call("Browser.getVersion")["product"]
        b.close()
        # A clean stop writes History, Cookies and the rest down, as a desk's Chromium does over time.
        self.browser.stop()
        self.browser.start()
        b = cdp.Browser(self.ports["cdp_src"])
        self.src_cookies = sorted((c["domain"], c["name"], c["path"], c["value"], c["session"]) for c in b.cookies())
        b.close()
        say(f"{len(self.src_cookies)} cookies in the source's Chromium after a restart, which stays running")

    # ---- helper evidence

    def reads(self):
        out = []
        try:
            with open(os.path.join(self.helper_logs, "reads.jsonl")) as f:
                out = [json.loads(line) for line in f if line.strip()]
        except FileNotFoundError:
            pass
        return out

    def progress(self, pid):
        try:
            with open(os.path.join(self.helper_logs, "progress", f"{pid}.json")) as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def big_reads(self, since=0.0):
        out = []
        for r in self.reads():
            if r["op"] == "read" and r["part"] == "files" and r["path"] == "big.bin" and r["t"] >= since:
                p = self.progress(r["pid"]) or {}
                out.append({**r, "sent": p.get("sent", 0), "done": p.get("done", False), "tEnd": p.get("t", r["t"])})
        return out

    def wait_big(self, since, at_least, seconds=600):
        def check():
            for r in self.big_reads(since):
                if not r["done"] and r["sent"] >= at_least:
                    return r
            return None
        return wait_for(f"big.bin past {at_least >> 20} MiB", check, seconds, 0.05)

    # ---- test B: the download

    def test_export(self):
        say("TEST B: the Desk app's /export against this deskd")
        PROCS.start("harness", [NODE, "harness/serve.mjs", "--dist", "dist/release", "--port", str(self.ports["harness"])], cwd=WEB)
        wait_for("the web harness", lambda: urllib.request.urlopen(f"http://127.0.0.1:{self.ports['harness']}/__harness", timeout=2).status == 200, 30)
        out = path("web")
        since = time.time()
        env = dict(os.environ, NODE_PATH="")
        p = PROCS.start("export", [NODE, os.path.join(HERE, "export.mjs"), "--base", f"http://localhost:{self.ports['harness']}",
                                   "--shim", self.shim, "--out", out, "--web", WEB], env=env)
        # A dropped connection mid-file: desk-rtc killed outright once big.bin is a quarter through, then back.
        drop = None
        try:
            r = self.wait_big(since, BIG // 4, 600)
            drop = {"at": r["sent"], "t": time.time()}
            say(f"export: killing desk-rtc with big.bin {r['sent'] >> 20} MiB in")
            PROCS.kill("desk-rtc", signal.SIGKILL)
            time.sleep(2)
            self.start_rtc()
            say("export: desk-rtc back")
        except TimeoutError as e:
            say(f"export: no drop: {e}")
        p.wait(900)
        with open(os.path.join(out, "result.json")) as f:
            result = json.load(f)
        say(f"export: page says {result.get('done')!r}")
        self.evidence["export"] = self.check_export(result, since, drop)

    def check_export(self, result, since, drop):
        zpath = os.path.join(path("web"), "export.zip")
        ev = {"result": result, "problems": []}
        probs = ev["problems"]
        ev["unzip"] = subprocess.run(["unzip", "-tq", zpath], capture_output=True, text=True).stdout.strip()
        if "No errors" not in ev["unzip"]:
            probs.append("unzip -t: " + ev["unzip"])
        zt = subprocess.run([sys.executable, "-I", "-m", "zipfile", "-t", zpath], capture_output=True, text=True)
        ev["zipfile"] = (zt.stdout + zt.stderr).strip()[-200:]
        if zt.returncode != 0:
            probs.append("python -m zipfile -t failed")
        z = zipfile.ZipFile(zpath)
        names = z.namelist()
        manifest = json.loads(z.read("manifest.json"))
        ev["entries"] = len(names)
        ev["zipBytes"] = os.path.getsize(zpath)
        ev["order"] = names[:2]
        if names[:2] != ["README.txt", "manifest.json"]:
            probs.append(f"index starts {names[:2]}")
        checked = 0
        for f in manifest.get("files", []):
            name = f["path"]
            if name not in names:
                probs.append(f"manifest names a missing entry: {name}")
                continue
            h = hashlib.sha256()
            with z.open(name) as e:
                while b := e.read(1 << 20):
                    h.update(b)
            if h.hexdigest() != f["sha256"]:
                probs.append(f"hash differs: {name}")
            checked += 1
        ev["manifestChecked"] = checked
        ev["notCopied"] = manifest.get("notCopied") or [d.get("notCopied") for d in manifest.get("desks", []) if d.get("notCopied")]
        ev["desks"] = [{k: d.get(k) for k in ("name", "complete")} for d in manifest.get("desks", [])]
        prefix = "desks/Personal/"
        big = prefix + "files/big.bin"
        if big in names:
            h = hashlib.sha256()
            with z.open(big) as e:
                while b := e.read(1 << 20):
                    h.update(b)
            ev["bigMatches"] = h.hexdigest() == self.big_sha
            if not ev["bigMatches"]:
                probs.append("big.bin differs from the source")
        else:
            probs.append("big.bin isn't in the archive")
        for m in MACHINE + ["desk/volume.json", "apps/registry.json", "apps/notes/releases/1.0.0/app.js", "apps/notes/cache/blob.bin"]:
            if any(n.startswith(prefix + m) for n in names):
                probs.append(f"machine or left-out path in the archive: {m}")
        caches = [n for n in names if n.startswith(prefix + "browser/") and set(n.split("/")) & (CACHES | LOCKS)]
        if caches:
            probs.append(f"{len(caches)} cache or lock entries, such as {caches[0]}")
        # The readable files.
        bm = [n for n in names if n.endswith("/bookmarks.html")]
        hc = [n for n in names if n.endswith("/history.csv")]
        ev["readable"] = bm + hc
        if not bm or not hc:
            probs.append("browser-readable is missing bookmarks.html or history.csv")
        else:
            html = z.read(bm[0]).decode()
            ev["bookmarksOk"] = "Rehearsal home" in html and "Café menu — naïve" in html and html.startswith("<!DOCTYPE NETSCAPE-Bookmark-file-1>")
            if not ev["bookmarksOk"]:
                probs.append("bookmarks.html doesn't have the profile's bookmarks")
            text = z.read(hc[0]).decode("utf-8-sig")
            rows = list(csv.reader(io.StringIO(text)))
            ev["historyRows"] = len(rows) - 1
            ev["historyHeader"] = rows[0]
            visits = [r for r in rows[1:] if f":{self.ports['pages']}/visit/" in r[2]]
            ev["historyVisits"] = len(visits)
            times = [r[0] for r in rows[1:]]
            if len(visits) < 5 or times != sorted(times, reverse=True):
                probs.append("history.csv lacks the visits, or isn't newest first")
        # Every database in the archive is whole: SQLite opens it, checks it, and it came without a -wal or -journal.
        dbs = 0
        for n in names:
            if n.startswith(prefix) and not n.endswith("/") and z.getinfo(n).file_size >= 16 and z.open(n).read(16) == b"SQLite format 3\x00":
                dbs += 1
                with tempfile.TemporaryDirectory(dir=path("tmp")) as t:
                    db = os.path.join(t, "db")
                    with open(db, "wb") as f:
                        f.write(z.read(n))
                    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                    ok = c.execute("pragma integrity_check").fetchone()[0]
                    if n.endswith("/Default/Cookies"):
                        ev["cookieRowsInArchive"] = c.execute("select count(*) from cookies").fetchone()[0]
                    if n.endswith("/Default/History"):
                        ev["visitRowsInArchive"] = c.execute("select count(*) from visits").fetchone()[0]
                    c.close()
                    if ok != "ok":
                        probs.append(f"a database in the archive isn't whole: {n}")
        ev["databases"] = dbs
        siblings = [n for n in names if n.endswith(("-wal", "-journal", "-shm"))]
        if siblings:
            probs.append(f"SQLite siblings in the archive, such as {siblings[0]}")
        persistent = sum(1 for c in self.src_cookies if not c[4])
        if ev.get("cookieRowsInArchive", 0) < persistent:
            probs.append(f"the archive's Cookies has {ev.get('cookieRowsInArchive')} rows, fewer than the {persistent} persistent cookies")
        # The helper's reads of the databases Chromium keeps locked while it runs: the online backup can't get in for
        # its 1 s, then the quiet copy is what goes. Chromium kept running throughout the download.
        ev["liveSqliteReads"] = []
        for r in self.reads():
            if r["t"] >= since and r["op"] == "read" and r["part"] == "browser" and r["path"].split("/")[-1] in ("History", "Web Data", "Cookies", "Login Data"):
                pr = self.progress(r["pid"]) or {}
                ev["liveSqliteReads"].append({"path": r["path"].split("/")[-1], "s": round(pr.get("t", r["t"]) - r["t"], 2)})
        ev["chromiumRunningThroughout"] = self.browser.running() and not any(v["unit"] == "desk-browser" for v in self.units.verbs)
        if not ev["chromiumRunningThroughout"]:
            probs.append("the source's Chromium didn't stay running through the download")
        # How long the page took to come back after the drop.
        ph = result.get("phases", [])
        lost = next((p["t"] for p in ph if p["p"].startswith("reconnecting")), None)
        back = next((p["t"] for p in ph if lost and p["t"] > lost and p["p"].startswith("copying")), None)
        ev["reconnectS"] = round((back - lost) / 1000, 1) if lost and back else None
        if drop is not None and lost is None:
            probs.append("the page never said it was reconnecting")
        if result.get("console"):
            probs.append(f"console errors: {result['console'][:2]}")
        if result.get("error"):
            probs.append(f"export.mjs: {result['error'][:200]}")
        # What deskd counted as free (frame bytes handed to desk-rtc for data.read), against what the helper sent.
        sent = sum((self.progress(r["pid"]) or {}).get("sent", 0) for r in self.reads() if r["op"] == "read" and r["t"] >= since)
        try:
            free = wait_for("free-bytes to catch up", lambda: (lambda v: v if v >= sent else None)(self.free_bytes()), 15, 0.5)
        except TimeoutError:
            free = self.free_bytes()
        ev["freeBytes"] = free
        ev["helperBodyBytes"] = sent
        if free is None or not sent <= free <= sent * 1.01 + (2 << 20):
            probs.append(f"free-bytes says {free}, the helper sent {sent}")
        # The resume, from the helper's side.
        reads = self.big_reads(since)
        ev["bigReads"] = [{"offset": r["offset"], "sent": r["sent"], "s": round(r["tEnd"] - r["t"], 1)} for r in reads]
        ev["drop"] = drop
        if drop is not None:
            if not any(r["offset"] > 0 for r in reads):
                probs.append("no read of big.bin resumed from an offset after the drop")
            ev["bigSentInAll"] = sum(r["sent"] for r in reads)
        t = result.get("timings", {})
        if t.get("clickMs") and t.get("doneMs"):
            secs = (t["doneMs"] - t["clickMs"]) / 1000
            ev["seconds"] = round(secs, 1)
            ev["mbPerSecond"] = mb_s(ev["zipBytes"], secs)
        last = max(reads, key=lambda r: r["t"]) if reads else None
        if last and last["sent"]:
            ev["bigLastReadMbPerSecond"] = mb_s(last["sent"], last["tEnd"] - last["t"])
        say(f"export: {ev['entries']} entries, {ev['manifestChecked']} hashes checked, problems: {probs or 'none'}")
        return ev

    def free_bytes(self):
        try:
            with open(path("run/free-bytes")) as f:
                return int(f.read().split()[1])
        except (FileNotFoundError, IndexError, ValueError):
            return None

    # ---- test A: the move

    def move_env(self):
        units = path("move/units")
        launch = path("move/target-browser.sh")
        with open(launch, "w") as f:
            f.write("#!/bin/bash\n# The target's desk-browser: the same flags as the source's (rig.py chromium_argv).\nexec "
                    + " ".join(f"'{a}'" for a in chromium_argv(path("dst/data/browser/profile"), self.ports["cdp_dst"])[:-1])
                    + ' "$@"\n')
        os.chmod(launch, 0o700)
        with open(os.path.join(units, "desk-browser.service"), "w") as f:
            f.write(f"[Unit]\nDescription=the rehearsal's target Chromium\n[Service]\nExecStart={launch}\n")
        for u in ("deskd", "desk-stream"):
            with open(os.path.join(units, f"{u}.service"), "w") as f:
                f.write(f"[Service]\nExecStart=/bin/true # {u}, stood in for\n")
        # desk-browser's start: first a copy of what the swap left, before Chromium touches it, then Chromium.
        start = os.path.join(units, "desk-browser.start")
        with open(start, "w") as f:
            f.write(f"""#!/bin/bash
set -e
rm -rf '{path("snap/dst-browser-swapped")}'
cp -a '{path("dst/data/browser")}' '{path("snap/dst-browser-swapped")}'
restore=about:blank
ls '{path("dst/data/browser/profile/Default/Sessions")}' 2>/dev/null | grep -qE '^(Session_|Tabs_)' && restore=--restore-last-session
setsid '{launch}' "$restore" >> '{path("logs/chromium-target.log")}' 2>&1 < /dev/null &
echo $! > '{path("move/target-browser.pid")}'
for i in $(seq 1 300); do (exec 3<>/dev/tcp/127.0.0.1/{self.ports['cdp_dst']}) 2>/dev/null && exit 0; sleep 0.2; done
exit 1
""")
        stop = os.path.join(units, "desk-browser.stop")
        with open(stop, "w") as f:
            f.write(f"""#!/bin/bash
p=$(cat '{path("move/target-browser.pid")}' 2>/dev/null) || exit 0
kill -TERM -- -$p 2>/dev/null; sleep 2; kill -KILL -- -$p 2>/dev/null; exit 0
""")
        os.chmod(start, 0o700)
        os.chmod(stop, 0o700)
        with open(path("move/code.txt"), "w") as f:
            f.write(MOVE_CODE + "\n")
        e = dict(os.environ)
        e.update({"MA_DESK_MOVE_TEST": "1", "MA_DESK_MOVE_TEST_DIR": path("move"), "MA_DESK_MOVE_TEST_CHROMIUM": CHROME,
                  "MA_DESK_MOVE_TEST_CDP_PORT": str(self.ports["cdp_dst"])})
        return e

    def run_move(self, n, env):
        return PROCS.start(f"ma-move-{n}", [path("bin/ma-move"), "--data-root", path("dst/data"),
                                                 "--api", f"http://127.0.0.1:{self.ports['platform']}",
                                                 "--code-file", path("move/code.txt"), "-v"], env=env)

    def test_move(self):
        say("TEST A: ma-move from this deskd to the target tree")
        env = self.move_env()
        stage_big = path("dst/data/.ma-move", MOVE_ID, "stage/files/big.bin")
        journal = path("dst/data/.ma-move", MOVE_ID, "journal.jsonl")
        ev = {"problems": []}
        t0 = time.time()
        p1 = self.run_move(1, env)
        # 1. deskd killed outright mid-file: the same run reconnects and carries on from its offset.
        r = self.wait_big(t0, BIG // 4)
        ev["deskdKilledAt"] = r["sent"]
        say(f"move: killing deskd with big.bin {r['sent'] >> 20} MiB in")
        PROCS.kill("deskd", signal.SIGKILL)
        time.sleep(1)
        self.start_deskd()
        t1 = time.time()
        r2 = self.wait_big(t1, BIG // 8)
        if r2["offset"] == 0:
            ev["problems"].append("after deskd came back, big.bin was read again from 0")
        # 2. ma-move itself killed outright mid-file, then run again: it finds the move and its journal.
        say(f"move: killing ma-move with big.bin resumed at {r2['offset'] >> 20} MiB and {r2['sent'] >> 20} MiB further")
        PROCS.kill("ma-move-1", signal.SIGKILL)
        killed = time.time()
        dead_reads = [r["pid"] for r in self.reads() if r["op"] == "read" and t1 <= r["t"] <= killed]
        time.sleep(0.5)
        with open(journal) as f:
            journaled = [json.loads(line) for line in f if line.strip()]
        ev["journaledBeforeRerun"] = len(journaled)
        ev["stagedBigAtKill"] = os.path.getsize(stage_big)
        # A row written between the runs on a connection that stays open, as desk-agent keeps agent.db: it's only in the
        # -wal, so the main file's size and mtime don't show it, and the rerun's last pass has to bring it. compare_part
        # dumps the source with its -wal, so a target without the row is a problem there.
        runs = path("src/data/agent/runs.db")
        a = os.stat(runs)
        wal_writer = sqlite3.connect(runs)
        wal_writer.execute("insert into runs (task, tokens) values ('written between the runs', 1)")
        wal_writer.commit()
        b = os.stat(runs)
        if (a.st_size, a.st_mtime_ns) != (b.st_size, b.st_mtime_ns):
            ev["problems"].append("the write between the runs moved runs.db's main file, so it proves nothing")
        t2 = time.time()
        p2 = self.run_move(2, env)
        code = p2.wait(1800)
        t3 = time.time()
        ev["exit"] = code
        # The killed run's session ends when desk-rtc's consent check gives up on it (30 s), and its transfers with it,
        # holding their places among deskd's 12 till then: the rerun had to fit beside them.
        try:
            wait_for("the killed run's transfers to end", lambda: all((self.progress(pid) or {}).get("done") for pid in dead_reads), 90, 0.5)
        except TimeoutError:
            ev["problems"].append("the killed run's transfers still held the helper 90 s on")
        ends = [(self.progress(pid) or {}).get("t") for pid in dead_reads if (self.progress(pid) or {}).get("done")]
        ev["killedRunTransfers"] = len(dead_reads)
        ev["killedRunTransfersEndedAfterS"] = round(max(ends) - killed, 1) if ends and len(ends) == len(dead_reads) else None
        with open(path("logs", "ma-move-2.log"), errors="replace") as f:
            log2 = f.read()
        ev["summary"] = [line for line in log2.splitlines() if line.startswith(("Your desk is moved", "The move stopped", "Carrying on"))]
        if code != 0:
            ev["problems"].append(f"the rerun exited {code}")
        try:
            self.check_move(ev, journaled, t0, t1, t2, t3)
        finally:
            wal_writer.close()
        self.evidence["move"] = ev

    def check_move(self, ev, journaled, t0, t1, t2, t3):
        probs = ev["problems"]
        reads = self.reads()
        # Resume: what the rerun read again, of what the first run had journaled.
        again = {(r["part"], r["path"]) for r in reads if r["op"] == "read" and r["t"] >= t2}
        had = {(j["part"], j["path"]) for j in journaled}
        reread = sorted(again & had)
        ev["rerunReads"] = len(again)
        ev["rerunReadsOfJournaled"] = len(reread)
        # Every last pass reads every database again, in every part. Everything else the journal has stays skipped.
        database = lambda p, x: p != "browser" and is_sqlite(path("src/data", p, x))
        ev["rerunReadsOfJournaledDatabases"] = [f"{p}/{x}" for p, x in reread if database(p, x)]
        ev["rerunReadsOfJournaledNotBrowser"] = [f"{p}/{x}" for p, x in reread if p != "browser" and not database(p, x)]
        if ("agent", "runs.db") in had and ("agent", "runs.db") not in again:
            probs.append("the rerun's last pass didn't read agent/runs.db again")
        hold_t = next((v["t"] for v in self.units.verbs if v["verb"] == "stop" and v["t"] >= t2), None)
        if hold_t is not None:
            ev["rerunBrowserReadsOfJournaledBeforeHold"] = len({(r["part"], r["path"]) for r in reads if r["op"] == "read"
                                                                 and t2 <= r["t"] < hold_t and r["part"] == "browser"} & had)
            ev["browserReadsWhileHeld"] = len({r["path"] for r in reads if r["op"] == "read" and r["part"] == "browser" and r["t"] >= hold_t})
        if ev["rerunReadsOfJournaledNotBrowser"]:
            probs.append("the rerun read journaled files again outside the Browser's last pass")
        big = self.big_reads(t0)
        ev["bigReads"] = [{"offset": r["offset"], "sent": r["sent"], "s": round(r["tEnd"] - r["t"], 1)} for r in big]
        ev["bigSentInAll"] = sum(r["sent"] for r in big)
        offsets = [r["offset"] for r in big]
        if len(big) < 3 or offsets[0] != 0 or not all(o > 0 for o in offsets[1:]):
            probs.append(f"big.bin's reads weren't 0, then resumed offsets: {offsets}")
        last = big[-1] if big else None
        if last and last["sent"]:
            ev["bigLastReadMbPerSecond"] = mb_s(last["sent"], last["tEnd"] - last["t"])
        first = big[0] if big else None
        if first and first["sent"]:
            ev["bigFirstReadMbPerSecond"] = mb_s(first["sent"], first["tEnd"] - first["t"])
        # The files themselves.
        held = [s for s in self.units.snapshots if s["t"] <= t3]
        ev["browserStops"] = len(self.units.snapshots)
        ev["unitsVerbs"] = [f"{v['verb']} {v['unit']} ({v['ms']} ms)" for v in self.units.verbs]
        if not os.path.isdir(path("snap/dst-browser-swapped")):
            probs.append("the target's desk-browser was never started, so there's no copy of what the swap left")
        compared = []
        for part in PARTS:
            if part == "browser":
                if not held:
                    probs.append("the source's Chromium was never stopped for the held pass")
                    continue
                src_root, dst_root = held[-1]["dir"], path("snap/dst-browser-swapped")
            else:
                src_root, dst_root = path("src/data", part), path("dst/data", part)
            c = compare_part(part, src_root, dst_root)
            compared.append(c)
            probs.extend(f"{part}: {x}" for x in c["problems"][:20])
        ev["compared"] = [{k: c[k] for k in ("part", "files", "bytes", "sqlite", "sqliteRows", "links", "dirs")} for c in compared]
        ev["before"] = sorted(os.listdir(path("dst/data/.ma-move", MOVE_ID, "before"))) if os.path.isdir(path("dst/data/.ma-move", MOVE_ID, "before")) else []
        for rel, want in (("desk/volume.json", b'"target": true'), ("apps/registry.json", b'"target": true')):
            with open(path("dst/data", rel), "rb") as f:
                if want not in f.read():
                    probs.append(f"the target's own {rel} wasn't kept")
        # The machine's files, never read, moved or written.
        time.sleep(0.5)
        evs = []
        ev["selfhostDeskJsonOpens"] = 0
        for e in list(self.watch.events):
            rel = os.path.relpath(e["path"], SCRATCH)
            # ma-move's one file of /data/selfhost, which it may open and read, and nothing else.
            if rel == "dst/data/selfhost/desk.json" and not e["mask"] & ~(IN_ACCESS | IN_OPEN | IN_CLOSE_NOWRITE):
                ev["selfhostDeskJsonOpens"] += 1 if e["mask"] & IN_OPEN else 0
                continue
            evs.append({"path": rel, "mask": hex(e["mask"])})
        ev["machineEvents"] = evs[:20]
        if evs:
            probs.append(f"{len(evs)} inotify events on the machine's files, such as {evs[0]}")
        after = {"src": machine_digest(path("src/data")), "dst": machine_digest(path("dst/data"))}
        for side in ("src", "dst"):
            if after[side] != self.machine_before[side]:
                probs.append(f"the {side} machine files changed (content, inode or mode)")
        # The platform heard counts only.
        allowed = {"state", "parts", "files", "bytes", "checks", "error"}
        names = ["big.bin", "harbor", "Cookies", "notes", "report", "Café", "History", "profile", "settings"]
        ev["reports"] = [json.loads(r["raw"]) for r in Platform.reports]
        for r in Platform.reports:
            body = json.loads(r["raw"])
            if set(body) - allowed or not all(isinstance(body[k], int) for k in ("parts", "files", "bytes")) \
                    or set(body.get("checks", {})) - {"passed", "failed"} or any(n in r["raw"] for n in names):
                probs.append(f"a report carried more than counts: {r['raw'][:120]}")
        if not ev["reports"] or ev["reports"][-1].get("state") != "done":
            probs.append("no done report")
        ev["connects"] = len(Platform.connects)
        with open(path("dst/data/.ma-move", MOVE_ID, "report.json")) as f:
            ev["localReport"] = json.load(f)
        if ev["localReport"].get("cookies", {}).get("readable") != ev["localReport"].get("cookies", {}).get("total") \
                or not ev["localReport"].get("cookies", {}).get("checked"):
            probs.append(f"ma-move's own proof: {ev['localReport'].get('cookies')}")
        with open(path("move/chown.log")) as f:
            chowns = f.read().splitlines()
        ev["chownsLogged"] = len(chowns)
        ev["chownUids"] = sorted({c.split(" ", 1)[0] for c in chowns})
        with open(path("move/systemctl.log")) as f:
            ev["systemctl"] = f.read().splitlines()
        # The sign-ins, read by this rig from the target's own Chromium.
        self.check_signins(ev)
        # The cloud desk afterwards: its Browser kept held, never started again on the cookies the target now has
        # (Security's NE-2), with deskd's record of it on the source's volume.
        ev["sourceChromiumRunningAfter"] = self.browser.running()
        if ev["sourceChromiumRunningAfter"]:
            probs.append("the source's Chromium started again after the move")
        ev["sourceKept"] = os.path.exists(path("src/data/desk/browser-moved.json"))
        if not ev["sourceKept"] or ev["localReport"].get("browserKept") != "kept":
            probs.append(f"the source's Browser wasn't kept held: {ev['sourceKept']}, {ev['localReport'].get('browserKept')}")
        # Throughput over the whole move, first run to done.
        moved = sum(c["bytes"] for c in compared)
        ev["movedBytes"] = moved
        ev["seconds"] = round(t3 - t0, 1)
        ev["mbPerSecondWall"] = mb_s(moved, t3 - t0)
        say(f"move: exit {ev['exit']}, problems: {probs or 'none'}")

    def check_signins(self, ev):
        probs = ev["problems"]
        try:
            b = cdp.Browser(self.ports["cdp_dst"])
        except OSError as e:
            probs.append(f"the target's Chromium isn't there to ask: {e}")
            return
        dst = sorted((c["domain"], c["name"], c["path"], c["value"], c["session"]) for c in b.cookies())
        ev["cookiesSource"] = len(self.src_cookies)
        ev["cookiesTarget"] = len(dst)
        ev["cookiesSame"] = [c[:3] for c in self.src_cookies] == [c[:3] for c in dst] and \
            [c[3] for c in self.src_cookies] == [c[3] for c in dst]
        if not ev["cookiesSame"]:
            probs.append(f"cookies differ: source {len(self.src_cookies)}, target {len(dst)}")
        sid = b.page()
        b.navigate(sid, f"http://127.0.0.1:{self.ports['pages']}/check")
        got = b.evaluate(sid, "window.check")
        b.close()
        v = self.values
        ev["reload"] = {"persistentCookie": f"keep={v['keep']}" in got["header"], "httpOnlyCookie": f"sid={v['sid']}" in got["header"],
                        "sessionCookie": f"sess={v['sess']}" in got["header"], "localStorage": got["ls"] == v["ls"],
                        "indexedDB": got["idb"] == v["idb"]}
        for k, ok in ev["reload"].items():
            if not ok and k != "sessionCookie":
                probs.append(f"after the move the page didn't get its {k} back")

    # ---- down

    def down(self):
        say("stopping everything")
        for name in ("export", "harness"):
            PROCS.kill(name)
        try:
            with open(path("move/target-browser.pid")) as f:
                pid = int(f.read())
            os.killpg(pid, signal.SIGTERM)
            time.sleep(1)
            os.killpg(pid, signal.SIGKILL)
        except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
            pass
        PROCS.stop_all()
        for srv in ("pages", "platform"):
            if hasattr(self, srv):
                getattr(self, srv).shutdown()
        if hasattr(self, "units"):
            self.units.close()
        if hasattr(self, "watch"):
            self.watch.stop()

    def clean_big(self):
        for p in (path("src/data/files/big.bin"), path("web/export.zip")):
            if os.path.exists(p):
                os.remove(p)
        for d in (path("dst"), path("snap"), path("tmp")):
            shutil.rmtree(d, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", choices=["move", "export"])
    ap.add_argument("--keep", action="store_true", help="keep the trees and the archive for a look afterwards")
    args = ap.parse_args()
    rig = Rig(args)
    stopping = {"done": False}

    def bail(signum, _frame):
        if not stopping["done"]:
            stopping["done"] = True
            rig.down()
        sys.exit(128 + signum)

    signal.signal(signal.SIGINT, bail)
    signal.signal(signal.SIGTERM, bail)
    ok = False
    try:
        rig.up()
        if args.only in (None, "export"):
            rig.test_export()
        if args.only in (None, "move"):
            rig.test_move()
        ok = all(not rig.evidence[k]["problems"] for k in ("export", "move") if k in rig.evidence)
    finally:
        stopping["done"] = True
        rig.down()
        rig.evidence["ok"] = ok
        with open(path("evidence.json"), "w") as f:
            json.dump(rig.evidence, f, indent=2, default=str)
        if not args.keep:
            rig.clean_big()
        say(f"evidence: {path('evidence.json')}; logs: {path('logs')}")
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("problems", "mbPerSecond", "mbPerSecondWall", "bigLastReadMbPerSecond", "seconds", "exit")}
                      for k, v in rig.evidence.items() if isinstance(v, dict) and "problems" in v}, indent=2))
    say("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
